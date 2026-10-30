import { parseArgs } from 'node:util';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { stringifyJson } from './io.js';
import { runObjectGet, type ObjectGetScope, type ObjectDatasetType } from './object-get.js';

export function isObjectGetType(command: string): command is ObjectDatasetType {
  return ['contact', 'source', 'lifecyclemodel', 'flowproperty', 'unitgroup'].includes(command);
}

export function renderObjectGetHelp(command: ObjectDatasetType): string {
  return `Usage:
  tiangong-lca ${command} get --id <UUID> [options]

Options:
  --id <UUID>                       Required dataset identifier
  --version <NN.NN.NNN>              Optional version; a missing visible version falls back to latest
  --scope <scope>                   public | owner-draft | public-or-owner-draft (default)
  --expected-project-ref <ref>       Optional assertion about the selected project
  --expected-user-id <UUID>          Optional assertion about the authenticated account
  --timeout-ms <1..30000>            Per-request timeout (default: 10000); total deadline: 30000
  --json                            Print compact JSON
  -h, --help

Public means state_code=100; owner-draft means this account's state_code=0.
Exact and latest reads use the same scope and account. No attachments or related datasets are fetched.
Use returned id + resolved_version for the returned object, never requested_version.
version_fallback and warnings report any fallback, which does not satisfy an exact-version dependency.
The payload is the complete native dataset JSON; no data is written.
Official Production: run "tiangong-lca auth login" with no env setup.
`.trim();
}

export async function runObjectGetCommand(
  command: ObjectDatasetType,
  args: string[],
  deps: {
    env: NodeJS.ProcessEnv;
    fetchImpl: FetchLike;
    runObjectGetImpl?: typeof runObjectGet;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        id: { type: 'string' },
        version: { type: 'string' },
        scope: { type: 'string' },
        'expected-project-ref': { type: 'string' },
        'expected-user-id': { type: 'string' },
        'timeout-ms': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch {
    throw new CliError('Invalid object get options. Use --help for supported arguments.', {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === 'option') {
      if (seen.has(token.name))
        throw new CliError('Each object get option may be supplied only once.', {
          code: 'INVALID_ARGS',
          exitCode: 2,
        });
      seen.add(token.name);
    }
  }
  const { values } = parsed;
  if (values.help) return { exitCode: 0, stdout: renderObjectGetHelp(command) + '\n', stderr: '' };
  const report = await (deps.runObjectGetImpl ?? runObjectGet)({
    datasetType: command,
    id: values.id ?? '',
    version: values.version,
    scope: values.scope as ObjectGetScope | undefined,
    expectedProjectRef: values['expected-project-ref'],
    expectedUserId: values['expected-user-id'],
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  return { exitCode: 0, stdout: stringifyJson(report, values.json ?? false), stderr: '' };
}
