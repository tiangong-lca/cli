// data-api-relations: processes
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  fetchExactOrLatestProcessRow,
  normalizeSupabaseProcessPayload,
  requireSupabaseRestRuntime,
  type SupabaseProcessLookup,
} from './supabase-rest.js';
import { createSupabaseDataRuntime } from './supabase-session.js';
import {
  isObjectReadVersion,
  validateObjectReadResult,
  type ObjectReadWarning,
} from './object-read-result.js';

type JsonObject = Record<string, unknown>;

const PROCESS_GET_TIMEOUT_MS = 10_000;

export type RunProcessGetOptions = {
  processId: string;
  version?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
};

export type ProcessGetReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'resolved_remote_process';
  process_id: string;
  requested_version: string | null;
  resolved_version: string;
  resolution: SupabaseProcessLookup['resolution'];
  version_fallback: boolean;
  warnings: ObjectReadWarning[];
  source_url: string;
  modified_at: string | null;
  state_code: number | null;
  process: JsonObject;
};

function normalizeToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export async function runProcessGet(options: RunProcessGetOptions): Promise<ProcessGetReport> {
  const processId = normalizeToken(options.processId);
  if (!processId) {
    throw new CliError('Missing required --id value.', {
      code: 'PROCESS_ID_REQUIRED',
      exitCode: 2,
    });
  }

  const requestedVersion =
    options.version === undefined || options.version === null ? null : options.version.trim();
  if (requestedVersion !== null && !isObjectReadVersion(requestedVersion))
    throw new CliError('The optional --version must use NN.NN.NNN format.', {
      code: 'PROCESS_GET_VERSION_INVALID',
      exitCode: 2,
    });
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? PROCESS_GET_TIMEOUT_MS;
  const runtime = createSupabaseDataRuntime({
    runtime: requireSupabaseRestRuntime(options.env ?? process.env),
    fetchImpl,
    timeoutMs,
    now: options.now,
  });
  const lookup = await fetchExactOrLatestProcessRow({
    runtime,
    id: processId,
    version: requestedVersion,
    timeoutMs,
    fetchImpl,
    fallbackToLatest: requestedVersion !== null,
    requireUnique: true,
  });

  if (!lookup) {
    throw new CliError(
      requestedVersion
        ? `Could not resolve process dataset for ${processId}@${requestedVersion}.`
        : `Could not resolve process dataset for ${processId}.`,
      {
        code: 'PROCESS_GET_NOT_FOUND',
        exitCode: 2,
        details: {
          process_id: processId,
          version: requestedVersion,
        },
      },
    );
  }

  const result = validateObjectReadResult({
    datasetType: 'process',
    requestedId: processId,
    requestedVersion,
    rowId: lookup.row.id,
    rowVersion: lookup.row.version,
    payload: normalizeSupabaseProcessPayload(lookup.row.json, processId),
    resolution: lookup.resolution,
  });
  return {
    schema_version: 1,
    generated_at_utc: nowIso(options.now),
    status: 'resolved_remote_process',
    process_id: result.id,
    requested_version: result.requested_version,
    resolved_version: result.resolved_version,
    resolution: result.resolution,
    version_fallback: result.version_fallback,
    warnings: result.warnings,
    source_url: lookup.sourceUrl,
    modified_at: lookup.row.modified_at,
    state_code: lookup.row.state_code,
    process: result.payload,
  };
}
