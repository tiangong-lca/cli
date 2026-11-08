import { commandFailure } from '../shared/command-errors.js';
import { parseArgs } from 'node:util';
import {
  result,
  CommandInputError,
  type CommandIO,
  type CommandResult,
} from '../shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { readCommandInput, writeCommandOutput } from '../shared/command-files.js';
import { text, type JsonObject } from '../application/dataset-types.js';
import { queryCursor, nextCursor, shellArgument } from '../application/dataset-discovery.js';
import type { ReviewRead } from '../application/dataset-types.js';

const actions = ['submit', 'resubmit', 'get', 'list', 'materials', 'comment', 'decide', 'withdraw'];
export async function runReviewCommand(
  args: string[],
  read: ReviewRead,
  operations?: {
    mutate(action: string, request: JsonObject, dryRun: boolean): Promise<CommandResult>;
    materials(id: string): Promise<JsonObject>;
  },
): Promise<CommandIO> {
  const action = args[0];
  const json = args.includes('--json');
  let value = result(`review ${actions.includes(action!) ? action : ''}`.trim());
  try {
    if (action && !action.startsWith('--') && !actions.includes(action))
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Select a supported Review action.');
    let flags: Record<string, string | boolean | undefined>;
    try {
      const allowed = [
        'help',
        'json',
        ...(!action || action.startsWith('--')
          ? []
          : action === 'get'
            ? ['id', 'output', 'force']
            : action === 'list'
              ? ['role', 'state', 'limit', 'cursor', 'output', 'force']
              : action === 'materials'
                ? ['id', 'round', 'output', 'force']
                : ['input', 'dry-run', 'output', 'force']),
      ];
      const parsed = parseArgs({
        args: action && !action.startsWith('--') ? args.slice(1) : args,
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: Object.fromEntries(
          allowed.map((name) => [
            name,
            { type: ['help', 'json', 'force', 'dry-run'].includes(name) ? 'boolean' : 'string' },
          ]),
        ),
      });
      const names = parsed.tokens
        .filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('duplicate');
      flags = parsed.values;
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, duplicated or malformed Review option. Inspect --help.',
      );
    }

    if (!action || action.startsWith('--') || flags.help)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ schemaVersion: 1, command: `review${actions.includes(action!) ? ` ${action}` : ''}`, actions, implementedActions: actions.filter((name) => name !== 'withdraw'), limitations: { submit: 'One starting object; related business data is always included. Explicit multi-root packages and includeRelated:false are deferred.', resubmit: 'Rejected review and same exact dataset; the server determines the actual new or reused review. No server round link is claimed.', comment: 'Saves the current reviewer draft, possibly replacing it; no append-only history or decision.', materials: 'Current readable target only, not a historical package snapshot.', withdraw: 'No existing review-withdraw service mapping; dataset unpublication is a different operation.' }, input: { submit: { requestId: 'stable identity', expectedActor: 'online user UUID', expectedEnvironment: 'exact project origin', targets: [{ type: 'flow|process|model|source|contact', id: 'UUID', version: '00.00.000' }], includeRelated: 'true, default true' }, resubmit: 'submit fields plus reviewId, expectedState:-1, changeSummary', comment: 'requestId, expectedActor, expectedEnvironment, reviewId, expectedState, json (reviewer draft)', decide: 'requestId, expectedActor, expectedEnvironment, reviewId, expectedState, decision:approve|reject, reason (reject only; max 1000 characters). Process/Model approve requires an existing review draft.', list: '--role submitter|reviewer [--state <integer>] [--limit 1..100] [--cursor <opaque>]', get: '--id <review UUID>', materials: '--id <review UUID> [--output <file>]' }, effects: 'Submit/resubmit create or reuse the actual review; comment saves a reviewer draft; decide records the current assigned reviewer decision. --dry-run checks readable preconditions without effects, not server final admission.', recovery: 'Requests are bound locally before dispatch; unknown results are never automatically replayed.' })}\n`,
        stderr: '',
      };
    if (flags.force && !flags.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    if (!['get', 'list'].includes(action)) {
      if (action === 'withdraw')
        throw new CommandInputError(
          'CAPABILITY_UNSUPPORTED',
          'Existing Review withdrawal is not exposed. Dataset unpublication cannot substitute for it.',
        );
      if (action === 'materials' && flags.round !== undefined)
        throw new CommandInputError(
          'CAPABILITY_UNSUPPORTED',
          'Historical round materials are deferred. Omit --round for current readable target content.',
        );
      if (!operations)
        throw new CommandInputError(
          'REVIEW_ADAPTER_REQUIRED',
          'Review operation adapter is unavailable.',
        );
      let artifact: unknown;
      if (action === 'materials') {
        const materials = await operations.materials(text(flags.id, '--id'));
        artifact = materials;
        value.data = {
          subject: materials.subject,
          contentDigest: materials.contentDigest,
          scope: materials.scope,
          historicalSnapshot: false,
        };
        value.context = {
          environment: materials.environment,
          actor: { id: materials.actor, source: 'online' },
          observation: { source: 'current_service', time: new Date().toISOString() },
        };
        value.completeness = {
          snapshot: false,
          notChecked: ['historical_package', 'consistent_multi_object_snapshot'],
        };
        value.outcome = 'current_materials_read';
        value.summary =
          'Current readable review target material obtained. This is not a historical review package.';
        if (!flags.output)
          value.nextActions.push({
            description: 'Use --output to save complete current material.',
          });
      } else {
        const request = readCommandInput(text(flags.input, '--input'));
        value = await operations.mutate(action, request, flags['dry-run'] === true);
        artifact = value.data;
      }
      if (flags.output) {
        try {
          value.artifacts.push(
            writeCommandOutput(text(flags.output, '--output'), artifact, flags.force === true),
          );
        } catch {
          if (value.status === 'completed' || value.status === 'accepted') value.status = 'partial';
          value.warnings.push({
            code: 'OUTPUT_UNAVAILABLE',
            message:
              'Operation facts preserved; artifact could not be written. Do not replay the operation.',
          });
        }
      }
      attachReplyTemplate(
        value,
        value.status === 'unknown'
          ? 'outcome-unknown'
          : value.status === 'failed'
            ? 'command-failed'
            : value.status === 'partial'
              ? 'partial-result'
              : flags['dry-run']
                ? 'preview-result'
                : value.status === 'accepted'
                  ? 'operation-accepted'
                  : action === 'materials'
                    ? 'query-result'
                    : 'operation-completed',
      );
      return renderResult(
        value,
        json,
        ['failed', 'unknown', 'partial'].includes(value.status) ? 1 : 0,
      );
    }
    const id = action === 'get' ? text(flags.id, '--id') : undefined;
    const role = action === 'list' ? text(flags.role, '--role') : undefined;
    if (role && !['submitter', 'reviewer'].includes(role))
      throw new CommandInputError('ROLE_INVALID', '--role must be submitter or reviewer.');
    const limit = action === 'get' ? 1 : flags.limit === undefined ? 20 : Number(flags.limit);
    const state = flags.state === undefined ? undefined : Number(flags.state);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (state !== undefined && !Number.isSafeInteger(state))
    )
      throw new CommandInputError(
        'QUERY_INVALID',
        'limit must be 1..100; state must be an integer.',
      );
    const binding = {
      action,
      ...(role ? { role } : {}),
      ...(state === undefined ? {} : { state }),
      limit,
    };
    const offset = queryCursor(flags.cursor as string | undefined, binding);
    const page = await read({ id, role: role as 'submitter', state, limit, offset });
    value.context = {
      environment: page.environment,
      actor: { id: page.actor, source: 'online' },
      effectiveInput: binding,
      observation: { source: 'review_query_service', time: new Date().toISOString() },
    };
    if (id && !page.records.length) {
      value.status = 'failed';
      value.outcome = 'not_found_or_not_visible';
      value.summary = 'Review not found or not visible.';
      value.error = {
        category: 'not_found_or_not_visible',
        code: 'REVIEW_NOT_FOUND',
        message: value.summary,
      };
    } else {
      value.outcome = 'review_records_read';
      value.summary = `${page.records.length} visible current review record(s) read.`;
    }
    value.data = id ? { review: page.records[0] ?? null } : { items: page.records };
    const more = page.total === null ? null : offset + page.records.length < page.total;
    value.completeness = {
      returned: page.records.length,
      total: page.total,
      hasMore: more,
      nextCursor:
        more && page.records.length ? nextCursor(offset + page.records.length, binding) : null,
      notChecked: ['historical_package', 'server_aggregated_package_progress'],
      snapshot: false,
    };
    if (value.completeness.nextCursor)
      value.nextActions.push({
        description: 'Read the next visible review page.',
        command: `tiangong-lca review list --role ${role} --limit ${limit}${state === undefined ? '' : ` --state ${state}`} --cursor ${shellArgument(String(value.completeness.nextCursor))} --json`,
      });
    if (flags.output) {
      try {
        value.artifacts.push(
          writeCommandOutput(text(flags.output, '--output'), value.data, flags.force === true),
        );
      } catch {
        if (value.status === 'completed') value.status = 'partial';
        value.warnings.push({
          code: 'OUTPUT_UNAVAILABLE',
          message: 'Review facts preserved; output file could not be written.',
        });
      }
    }
    attachReplyTemplate(
      value,
      value.status === 'failed'
        ? 'command-failed'
        : value.status === 'partial'
          ? 'partial-result'
          : 'query-result',
    );
    return renderResult(value, json, value.status === 'completed' ? 0 : 1);
  } catch (error) {
    value.status = 'failed';
    value.outcome = 'operation_failed';
    const failure = commandFailure(error, 'REVIEW_OPERATION_FAILED');
    value.summary = failure.message;
    value.error = { category: failure.category, code: failure.code, message: failure.message };
    value.nextActions.push({
      description: 'Inspect supported Review capabilities.',
      command: 'tiangong-lca review --help --json',
    });
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}
