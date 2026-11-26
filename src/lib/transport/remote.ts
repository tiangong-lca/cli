import { CliError } from '../../shared/errors.js';
import type { FetchLike } from './http.js';
import { postJson } from './http.js';
import { readJsonInput, stringifyJson } from '../platform/io.js';
import { deriveSupabaseFunctionsBaseUrl, requireSupabaseRestRuntime } from './supabase-client.js';
import { resolveSupabaseUserSession } from '../auth/supabase-session.js';

type RemoteCommandSpec = {
  endpoint: string;
  help: string;
};

const REMOTE_COMMANDS: Record<string, RemoteCommandSpec> = {
  'admin:embedding-run': {
    endpoint: 'embedding_ft',
    help: 'tiangong-lca admin embedding-run --input ./jobs.json [--dry-run] [--json]',
  },
};

export type RemoteCommandOptions = {
  commandKey: keyof typeof REMOTE_COMMANDS;
  inputPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  dryRun: boolean;
  compactJson: boolean;
  fetchImpl: FetchLike;
};

function buildUrl(baseUrl: string, endpoint: string): string {
  return `${deriveSupabaseFunctionsBaseUrl(baseUrl)}/${endpoint}`;
}

function buildHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

export async function executeRemoteCommand(options: RemoteCommandOptions): Promise<string> {
  const spec = REMOTE_COMMANDS[options.commandKey];
  if (!spec) {
    throw new CliError(`Unsupported remote command: ${options.commandKey}`, {
      code: 'UNSUPPORTED_REMOTE_COMMAND',
      exitCode: 2,
    });
  }

  const runtime = requireSupabaseRestRuntime(options.env);
  const body = readJsonInput(options.inputPath);
  const url = buildUrl(runtime.apiBaseUrl, spec.endpoint);

  if (options.dryRun) {
    const dryRunHeaders = buildHeaders('****');
    return stringifyJson(
      {
        dryRun: true,
        request: {
          method: 'POST',
          url,
          headers: {
            ...dryRunHeaders,
          },
          inputPath: options.inputPath,
          body,
          timeoutMs: options.timeoutMs,
        },
      },
      options.compactJson,
    );
  }

  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const headers = buildHeaders(session.accessToken);
  const response = await postJson({
    url,
    headers,
    body,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return stringifyJson(response, options.compactJson);
}

export function getRemoteCommandHelp(commandKey: keyof typeof REMOTE_COMMANDS): string {
  return REMOTE_COMMANDS[commandKey].help;
}
