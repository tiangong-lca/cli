// data-api-relations: processes
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { validateObjectReadRows } from './object-read-result.js';
import {
  createSupabaseDataClient,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
  type SupabaseDataRuntime,
} from './supabase-client.js';

type JsonObject = Record<string, unknown>;

export type SupabaseProcessRow = {
  id: string;
  version: string;
  json: unknown;
  modified_at: string | null;
  state_code: number | null;
};

export type SupabaseProcessLookup = {
  row: SupabaseProcessRow;
  sourceUrl: string;
  resolution:
    'remote_supabase_exact' | 'remote_supabase_latest' | 'remote_supabase_latest_fallback';
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildProcessUrl(
  restBaseUrl: string,
  options: {
    id: string;
    version?: string | null;
    latestOnly?: boolean;
    requireUnique?: boolean;
  },
): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/processes`);
  url.searchParams.set('select', 'id,version,json,modified_at,state_code');
  url.searchParams.set('id', `eq.${options.id}`);

  if (options.version) {
    url.searchParams.set('version', `eq.${options.version}`);
    if (options.requireUnique) url.searchParams.set('limit', '2');
  } else if (options.latestOnly) {
    url.searchParams.set('order', 'version.desc');
    url.searchParams.set('limit', options.requireUnique ? '2' : '1');
  }

  return url.toString();
}

function parseRows(payload: unknown, url: string): SupabaseProcessRow[] {
  if (!Array.isArray(payload)) {
    throw new CliError(`Supabase REST response was not a JSON array for ${url}`, {
      code: 'SUPABASE_REST_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  return payload.map((item, index) => {
    if (!isRecord(item)) {
      throw new CliError(`Supabase REST row ${index} was not a JSON object for ${url}`, {
        code: 'SUPABASE_REST_RESPONSE_INVALID',
        exitCode: 1,
        details: item,
      });
    }

    return {
      id: typeof item.id === 'string' ? item.id : '',
      version: typeof item.version === 'string' ? item.version : '',
      json: item.json,
      modified_at: typeof item.modified_at === 'string' ? item.modified_at : null,
      state_code: typeof item.state_code === 'number' ? item.state_code : null,
    };
  });
}

function normalizeSupabaseProcessPayload(payload: unknown, lookupKey: string): JsonObject {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (!isRecord(parsed)) {
        throw new CliError(`Supabase REST payload was not a JSON object for ${lookupKey}.`, {
          code: 'SUPABASE_REST_PAYLOAD_INVALID',
          exitCode: 1,
          details: parsed,
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }

      throw new CliError(`Supabase REST payload was not valid JSON for ${lookupKey}.`, {
        code: 'SUPABASE_REST_PAYLOAD_INVALID_JSON',
        exitCode: 1,
        details: String(error),
      });
    }
  }

  if (!isRecord(payload)) {
    throw new CliError(`Supabase REST payload was missing json for ${lookupKey}.`, {
      code: 'SUPABASE_REST_PAYLOAD_MISSING',
      exitCode: 1,
      details: payload,
    });
  }

  return payload;
}

async function fetchExactOrLatestProcessRow(options: {
  runtime: SupabaseDataRuntime;
  id: string;
  version?: string | null;
  timeoutMs: number;
  fetchImpl: FetchLike;
  fallbackToLatest?: boolean;
  requireUnique?: boolean;
}): Promise<SupabaseProcessLookup | null> {
  const { client, restBaseUrl } = createSupabaseDataClient(
    options.runtime,
    options.fetchImpl,
    options.timeoutMs,
  );

  if (!options.version) {
    const latestUrl = buildProcessUrl(restBaseUrl, {
      id: options.id,
      latestOnly: true,
      requireUnique: options.requireUnique,
    });
    const latestRows = parseRows(
      await runSupabaseArrayQuery(
        client
          .from('processes')
          .select('id,version,json,modified_at,state_code')
          .eq('id', options.id)
          .order('version', { ascending: false })
          .limit(options.requireUnique ? 2 : 1),
        latestUrl,
        { requireArray: options.requireUnique },
      ),
      latestUrl,
    );
    if (options.requireUnique) validateGetRows(latestRows, options.id, null);

    if (latestRows.length === 0) {
      return null;
    }
    if (
      options.requireUnique &&
      latestRows.length > 1 &&
      latestRows[0].version === latestRows[1].version
    )
      throw new CliError('Multiple visible process rows matched the latest version.', {
        code: 'PROCESS_GET_AMBIGUOUS',
        exitCode: 2,
      });

    return {
      row: latestRows[0] as SupabaseProcessRow,
      sourceUrl: latestUrl,
      resolution: 'remote_supabase_latest',
    };
  }

  const exactUrl = buildProcessUrl(restBaseUrl, {
    id: options.id,
    version: options.version,
    requireUnique: options.requireUnique,
  });
  const exactQuery = client
    .from('processes')
    .select('id,version,json,modified_at,state_code')
    .eq('id', options.id)
    .eq('version', options.version);
  if (options.requireUnique) {
    exactQuery.limit(2);
  }
  const exactRows = parseRows(
    await runSupabaseArrayQuery(exactQuery, exactUrl, { requireArray: options.requireUnique }),
    exactUrl,
  );
  if (options.requireUnique) validateGetRows(exactRows, options.id, options.version);

  if (exactRows.length > 0) {
    if (options.requireUnique && exactRows.length > 1)
      throw new CliError('Multiple visible process rows matched the requested version.', {
        code: 'PROCESS_GET_AMBIGUOUS',
        exitCode: 2,
      });
    return {
      row: exactRows[0] as SupabaseProcessRow,
      sourceUrl: exactUrl,
      resolution: 'remote_supabase_exact',
    };
  }

  if (!options.fallbackToLatest) {
    return null;
  }

  const latestUrl = buildProcessUrl(restBaseUrl, {
    id: options.id,
    latestOnly: true,
    requireUnique: options.requireUnique,
  });
  const latestRows = parseRows(
    await runSupabaseArrayQuery(
      client
        .from('processes')
        .select('id,version,json,modified_at,state_code')
        .eq('id', options.id)
        .order('version', { ascending: false })
        .limit(options.requireUnique ? 2 : 1),
      latestUrl,
      { requireArray: options.requireUnique },
    ),
    latestUrl,
  );
  if (options.requireUnique) validateGetRows(latestRows, options.id, null);

  if (latestRows.length === 0) {
    return null;
  }
  if (
    options.requireUnique &&
    latestRows.length > 1 &&
    latestRows[0].version === latestRows[1].version
  )
    throw new CliError('Multiple visible process rows matched the latest version.', {
      code: 'PROCESS_GET_AMBIGUOUS',
      exitCode: 2,
    });

  return {
    row: latestRows[0] as SupabaseProcessRow,
    sourceUrl: latestUrl,
    resolution: 'remote_supabase_latest_fallback',
  };
}

function validateGetRows(rows: SupabaseProcessRow[], id: string, version: string | null): void {
  validateObjectReadRows({
    datasetType: 'process',
    requestedId: id,
    requestedVersion: version,
    rows: rows.map((row) => ({
      id: row.id,
      version: row.version,
      payload: normalizeSupabaseProcessPayload(row.json, id),
    })),
  });
}

export {
  requireSupabaseRestRuntime,
  deriveSupabaseRestBaseUrl,
  normalizeSupabaseProcessPayload,
  fetchExactOrLatestProcessRow,
};

export type { SupabaseDataRuntime };
