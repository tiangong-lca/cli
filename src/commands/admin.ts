import { parseArgs } from 'node:util';
import { readRuntimeEnv } from '../lib/config/env.js';
import { CliError } from '../shared/errors.js';
import { executeRemoteCommand, getRemoteCommandHelp } from '../lib/transport/remote.js';

import type { ResolvedCliDeps, CliResult } from './ports.js';
function renderAdminHelp(): string {
  return `Usage:
  tiangong-lca admin embedding-run --input <file> [options]

Options:
  --input <file>   JSON request file
  --json           Print compact JSON
  --dry-run        Print the planned HTTP request without sending it
  --base-url <url> Override TIANGONG_LCA_API_BASE_URL
  --timeout-ms <n> Request timeout in milliseconds
  -h, --help

Official Production: run "tiangong-lca auth login" with no env setup.
Custom environment (complete matching tuple required):
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_OAUTH_CLIENT_ID and a prior "tiangong-lca auth login"

Runtime note:
  The CLI resolves the OAuth session and sends only its access token to Edge Functions.
`.trim();
}

function parseRemoteFlags(args: string[]): {
  help: boolean;
  json: boolean;
  dryRun: boolean;
  inputPath: string;
  apiBaseUrl: string | null;
  region: string | null;
  timeoutMs: number;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        input: { type: 'string' },
        'base-url': { type: 'string' },
        region: { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  const timeoutText = typeof values['timeout-ms'] === 'string' ? values['timeout-ms'] : undefined;
  const timeoutMs = timeoutText ? Number.parseInt(timeoutText, 10) : 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError('Expected --timeout-ms to be a positive integer.', {
      code: 'INVALID_TIMEOUT',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    dryRun: Boolean(values['dry-run']),
    inputPath: typeof values.input === 'string' ? values.input : '',
    apiBaseUrl: typeof values['base-url'] === 'string' ? values['base-url'] : null,
    region: typeof values.region === 'string' ? values.region : null,
    timeoutMs,
  };
}

function applyRemoteOverrides(
  env: NodeJS.ProcessEnv,
  overrides: Pick<ReturnType<typeof parseRemoteFlags>, 'apiBaseUrl' | 'region'>,
) {
  const runtimeEnv = readRuntimeEnv(env);

  return {
    ...env,
    TIANGONG_LCA_API_BASE_URL: overrides.apiBaseUrl ?? runtimeEnv.apiBaseUrl ?? undefined,
    TIANGONG_LCA_REGION: overrides.region ?? runtimeEnv.region,
  } satisfies NodeJS.ProcessEnv;
}

export async function executeAdminCommand(
  subcommand: string | null,
  commandArgs: string[],
  deps: ResolvedCliDeps,
): Promise<CliResult> {
  if (!subcommand && commandArgs.includes('--help')) {
    return { exitCode: 0, stdout: `${renderAdminHelp()}\n`, stderr: '' };
  }

  if (subcommand === 'embedding-run') {
    const remoteFlags = parseRemoteFlags(commandArgs);
    if (remoteFlags.help) {
      return {
        exitCode: 0,
        stdout: `${getRemoteCommandHelp('admin:embedding-run')}\n`,
        stderr: '',
      };
    }
    const env = applyRemoteOverrides(deps.env, remoteFlags);

    return {
      exitCode: 0,
      stdout: await executeRemoteCommand({
        commandKey: 'admin:embedding-run',
        inputPath: remoteFlags.inputPath,
        env,
        timeoutMs: remoteFlags.timeoutMs,
        dryRun: remoteFlags.dryRun,
        compactJson: remoteFlags.json,
        fetchImpl: deps.fetchImpl,
      }),
      stderr: '',
    };
  }

  throw new CliError('Unknown admin action.', { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}
