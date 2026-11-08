import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { parseArgs } from 'node:util';
import { getProcess, validateProcess, type ProcessPorts } from '../application/process.js';
import { readCommandInput, writeCommandOutput } from '../shared/command-files.js';
import { CommandInputError, result, type CommandIO } from '../shared/command-result.js';

const operations = ['get', 'validate'] as const;
function help(action?: string) {
  return {
    schemaVersion: 1,
    command: 'dataset process',
    implementedActions: operations,
    action: action ?? null,
    options:
      action === 'get'
        ? {
            id: 'required string',
            version: 'required exact version or latest',
            output: 'optional content path',
            force: 'replace separate output',
            json: 'machine result',
            help: 'usage contract',
          }
        : {
            input: 'required single Process JSON file or - for stdin',
            checks: 'only schema,business in this milestone',
            output: 'optional complete report path',
            force: 'replace separate output',
            json: 'machine result',
            help: 'usage contract',
          },
    effects: 'Read-only; local output only when --output is supplied.',
    limitations:
      'Other actions and flags are not implemented. Validation does not fetch references. Exact get never falls back to latest.',
    result: {
      schemaVersion: 1,
      fields: [
        'operation',
        'status',
        'outcome',
        'summary',
        'data',
        'context',
        'completeness',
        'artifacts',
        'warnings',
        'error',
        'nextActions',
        'replyTemplate',
      ],
    },
    errors: {
      0: 'read completed or local validation passed',
      1: 'read failed or validation failed/incomplete',
      2: 'invalid arguments, unsupported capability or file error',
    },
    examples: [
      'tiangong-lca dataset process get --id <id> --version <version> --output process.json --json',
      'tiangong-lca dataset process validate --input process.json --output validation.json --json',
    ],
  };
}

export async function runDatasetProcessCommand(
  args: string[],
  ports: ProcessPorts,
): Promise<CommandIO> {
  const action = args[0];
  const json = args.includes('--json');
  const operation = operations.includes(action as (typeof operations)[number])
    ? `dataset process ${action}`
    : 'dataset process';
  try {
    if (!action || action === '--help' || action === '--json') {
      if (args.some((arg) => !['--help', '--json'].includes(arg)))
        throw new CommandInputError(
          'ARGUMENTS_INVALID',
          'Use dataset process --help for supported actions.',
        );
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(help(), null, json ? undefined : 2)}\n`,
        stderr: '',
      };
    }
    if (!operations.includes(action as (typeof operations)[number]))
      throw new CommandInputError(
        'CAPABILITY_UNSUPPORTED',
        'This milestone supports dataset process get and validate only.',
      );
    let values: {
      help?: boolean;
      json?: boolean;
      force?: boolean;
      output?: string;
      id?: string;
      version?: string;
      input?: string;
      checks?: string;
    };
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: {
          help: { type: 'boolean' },
          json: { type: 'boolean' },
          output: { type: 'string' },
          force: { type: 'boolean' },
          ...(action === 'get'
            ? { id: { type: 'string' as const }, version: { type: 'string' as const } }
            : { input: { type: 'string' as const }, checks: { type: 'string' as const } }),
        },
      });
      const names = parsed.tokens
        .filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('Duplicate option');
      values = parsed.values as typeof values;
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, duplicated or malformed option. Use this command with --help.',
      );
    }
    if (values.help)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(help(action), null, json ? undefined : 2)}\n`,
        stderr: '',
      };
    if (values.output !== undefined && !values.output.trim())
      throw new CommandInputError('OUTPUT_REQUIRED', '--output must be a non-empty path.');
    if (values.force && !values.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    const required = (name: 'id' | 'version' | 'input') => {
      const value = values[name];
      if (typeof value !== 'string' || !value.trim())
        throw new CommandInputError('ARGUMENT_REQUIRED', `--${name} is required.`);
      return value.trim();
    };
    let value;
    if (action === 'get') value = await getProcess(required('id'), required('version'), ports);
    else {
      if (values.checks !== undefined && values.checks !== 'schema,business')
        throw new CommandInputError(
          'CHECKS_UNSUPPORTED',
          'Only local schema,business checks are supported in this milestone.',
        );
      value = validateProcess(readCommandInput(required('input')), ports);
      if (!values.checks) value.context.defaultedInputs = { checks: ['schema', 'business'] };
    }
    if (values.output && value.status === 'completed') {
      const artifact = writeCommandOutput(
        values.output,
        action === 'get' ? value.data.content : value.data.validation,
        values.force ?? false,
        values.input,
      );
      value.artifacts.push({
        ...artifact,
        purpose: action === 'get' ? 'process_content' : 'validation_report',
      });
      if (action === 'get') delete value.data.content;
    }
    if (action === 'validate' && value.status === 'completed') {
      const validation = value.data.validation as {
        issues: unknown[];
        issue_count: number;
        [key: string]: unknown;
      };
      // Full evidence stays in the explicit report; default context contains only representative findings.
      value.data.validation = {
        status: validation.status,
        validator: validation.validator,
        payload_sha256: validation.payload_sha256,
        issue_count: validation.issue_count,
        issues: validation.issues.slice(0, 5),
        validation_layers: Object.fromEntries(
          Object.entries(
            (validation.validation_layers ?? {}) as Record<
              string,
              { status: string; issue_count: number }
            >,
          ).map(([name, layer]) => [
            name,
            { status: layer.status, issue_count: layer.issue_count },
          ]),
        ),
      };
      value.completeness.truncated = validation.issues.length > 5;
      if (validation.issues.length > 5 && !values.output)
        value.nextActions.push({
          description:
            'Use --output with this validation input to write the complete findings report.',
        });
    }
    attachReplyTemplate(
      value,
      value.status === 'failed'
        ? 'command-failed'
        : action === 'get'
          ? 'query-result'
          : 'validation-result',
    );
    return renderResult(
      value,
      json,
      value.status === 'failed' || (action === 'validate' && value.outcome !== 'validation_passed')
        ? 1
        : 0,
    );
  } catch (error) {
    const value = result(operation);
    const inputError = error instanceof CommandInputError;
    value.status = 'failed';
    value.outcome = inputError ? 'invalid_input' : 'operation_failed';
    value.summary = inputError
      ? error.message
      : 'Process operation failed. Check the selected environment, authentication and service availability.';
    value.error = {
      category: inputError ? 'input' : 'operation',
      code: inputError ? error.code : 'PROCESS_OPERATION_FAILED',
      message: value.summary,
    };
    value.nextActions = [
      { description: 'Inspect supported arguments.', command: `tiangong-lca ${operation} --help` },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, inputError ? 2 : 1);
  }
}
