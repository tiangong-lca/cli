import { parseArgs } from 'node:util';
import { result, CommandInputError, type CommandIO } from '../shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { commandFailure } from '../shared/command-errors.js';
import { isObject } from '../application/dataset-types.js';

const actions = ['login', 'status', 'whoami', 'identity-receipt', 'doctor-auth', 'logout'];
export async function runAuthCommand(
  args: string[],
  execute: (args: string[]) => Promise<CommandIO>,
  selectedTarget: string | null = null,
): Promise<CommandIO> {
  const action = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const json = args.includes('--json');
  const value = result(`auth${action ? ` ${action}` : ''}`);
  try {
    if (action && !actions.includes(action))
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Select a supported auth action.');
    const allowed = [
      'help',
      'json',
      ...(action ? ['output', 'force'] : []),
      ...(['login', 'whoami', 'doctor-auth', 'identity-receipt'].includes(action ?? '')
        ? ['timeout-ms']
        : []),
      ...(action === 'identity-receipt' ? ['expected-project-ref', 'expected-user-id'] : []),
    ];
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: action ? args.slice(1) : args,
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: Object.fromEntries(
          allowed.map((name) => [
            name,
            {
              type: ['help', 'json', 'force'].includes(name) ? 'boolean' : 'string',
              ...(name === 'help' ? { short: 'h' } : {}),
            },
          ]),
        ),
      });
      const names = parsed
        .tokens!.filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('duplicate');
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, duplicated or malformed auth option. Inspect --help.',
      );
    }
    const flags = parsed.values;
    if (!action || flags.help) {
      const legacy = await execute(action ? [action, '--help'] : ['--help']);
      const helpManifest = {
        schemaVersion: 1,
        command: `auth${action ? ` ${action}` : ''}`,
        actions,
        options: allowed,
        usage: legacy.stdout.trim(),
        result:
          'Shared command result; original identity/session receipt is data.receipt. --output writes the original receipt without an envelope.',
        effects:
          'login establishes the selected local session; logout removes it locally. Read actions do not grant business permissions.',
        context:
          'status is a local observation; whoami and identity-receipt verify online. Credentials never enter results, templates or next actions.',
        recovery:
          'Inspect current status after an interrupted login/logout; never replay a failed business write automatically.',
      };
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(helpManifest)}\n`
          : `${legacy.stdout.trimEnd()}\n\nResults include context, nextActions and a Markdown reply template. --output <file> writes the original receipt; --force replaces only a separate local artifact.\n`,
        stderr: '',
      };
    }
    if (flags.force && !flags.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    const forwarded = Object.entries(flags)
      .filter(([name]) => !['output', 'force'].includes(name))
      .flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, String(value)]));
    // Existing OAuth, PKCE, exact identity receipts and private session helpers remain authoritative.
    const response = await execute([action, ...forwarded]);
    let payload: unknown;
    try {
      payload = JSON.parse(response.stdout || response.stderr);
    } catch {
      throw new Error('Identity command returned an invalid result.');
    }
    if (!isObject(payload)) throw new Error('Identity result is not an object.');
    value.data = { receipt: payload };
    const live = isObject(payload.live) ? payload.live : payload;
    const project = isObject(live.project) ? live.project : {};
    const identity = isObject(live.identity) ? live.identity : {};
    let configuredOrigin: string | null = null;
    if (selectedTarget) {
      try {
        configuredOrigin = new URL(selectedTarget).origin;
      } catch {
        /* Invalid configuration must not echo raw URL text. */
      }
    }
    const localOnly = action === 'status' || (action === 'doctor-auth' && payload.live === null);
    const actorId = localOnly
      ? null
      : typeof identity.user_id === 'string'
        ? identity.user_id
        : live.onlineVerified === true && typeof live.actorId === 'string'
          ? live.actorId
          : null;
    value.context = {
      environment:
        project.project_base_url ?? payload.projectBaseUrl ?? live.origin ?? configuredOrigin,
      actor: actorId ? { id: actorId, source: 'online' } : { status: 'not_independently_verified' },
      effectiveInput: {
        action,
        ...(flags['expected-project-ref']
          ? { expectedProjectRef: flags['expected-project-ref'] }
          : {}),
        ...(flags['expected-user-id'] ? { expectedUserId: flags['expected-user-id'] } : {}),
      },
      observation: {
        source: localOnly
          ? 'local_session'
          : action === 'logout'
            ? 'local_session_change'
            : action === 'login'
              ? 'oauth'
              : 'online_auth',
        time: live.captured_at_utc ?? new Date().toISOString(),
      },
    };
    value.completeness = {
      scope: localOnly ? 'local_session' : 'selected_identity_operation',
      notChecked: ['business_authorization', ...(localOnly ? ['online_identity'] : [])],
    };
    value.outcome = response.exitCode
      ? 'identity_check_failed'
      : action === 'logout'
        ? payload.removed === false
          ? 'local_session_absent'
          : 'local_session_removed'
        : action === 'login'
          ? 'session_established'
          : action === 'status'
            ? 'local_session_inspected'
            : 'identity_verified';
    value.summary = response.exitCode
      ? 'Identity operation did not succeed. Inspect the selected environment and authentication state.'
      : action === 'status'
        ? 'Local session inspected; this is not online identity verification.'
        : action === 'logout'
          ? payload.removed === false
            ? 'Selected local session was already absent; remote authorization was not revoked.'
            : 'Selected local session removed; remote authorization was not revoked.'
          : action === 'login'
            ? 'Selected session established through the existing OAuth flow.'
            : 'Selected identity operation completed; business authorization remains service-owned.';
    if (response.exitCode) {
      value.status = 'failed';
      const error = isObject(payload.error) ? payload.error : {};
      const code =
        typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.code)
          ? error.code
          : 'AUTH_CHECK_FAILED';
      // Unstructured failure text is not an identity receipt or a safe public diagnostic.
      if (payload.error) value.data = { receipt: { error: { code } } };
      value.error = {
        category: response.exitCode === 2 ? 'input' : 'authentication',
        code,
        message: value.summary,
      };
      value.summary = `${value.summary} (${code})`;
    }
    value.nextActions = [
      response.exitCode
        ? {
            description: 'Inspect authentication in the selected environment.',
            command: 'tiangong-lca auth doctor-auth --json',
          }
        : action === 'logout'
          ? {
              description: 'Inspect the selected local session state.',
              command: 'tiangong-lca auth status --json',
            }
          : action === 'login' || action === 'status'
            ? {
                description: 'Verify the current identity online before a business operation.',
                command: 'tiangong-lca auth whoami --json',
              }
            : {
                description:
                  'Use the observed identity with an explicitly selected business operation.',
              },
    ];
    if (flags.output) {
      try {
        value.artifacts.push(
          writeCommandOutput(String(flags.output), value.data.receipt, flags.force === true),
        );
      } catch {
        if (value.status === 'completed') value.status = 'partial';
        value.warnings.push({
          code: 'OUTPUT_UNAVAILABLE',
          message:
            'Identity result preserved; artifact could not be written. Do not repeat login/logout to repair a file.',
        });
      }
    }
    attachReplyTemplate(
      value,
      value.status === 'failed'
        ? 'command-failed'
        : value.status === 'partial'
          ? 'partial-result'
          : ['login', 'logout'].includes(action)
            ? 'operation-completed'
            : 'query-result',
    );
    return renderResult(value, json, value.status === 'completed' ? 0 : response.exitCode || 1);
  } catch (error) {
    const failure = commandFailure(error, 'AUTH_OPERATION_FAILED');
    value.status = 'failed';
    value.outcome = 'operation_failed';
    value.summary = failure.message;
    value.error = { category: failure.category, code: failure.code, message: failure.message };
    value.nextActions = [
      {
        description: 'Inspect the authentication contract.',
        command: 'tiangong-lca auth --help --json',
      },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}
