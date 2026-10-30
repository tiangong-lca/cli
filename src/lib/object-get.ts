// data-api-relations: contacts, flowproperties, lifecyclemodels, sources, unitgroups
import { isRecord } from './dataset-json.js';
import type { FetchLike } from './http.js';
import {
  isObjectReadUuid,
  isObjectReadVersion,
  validateObjectReadResult,
  type ObjectReadResolution,
  type ObjectReadWarning,
} from './object-read-result.js';
import {
  objectReadError,
  withObjectReadTransport,
  OBJECT_READ_LIMITS,
} from './object-read-transport.js';
import { deriveSupabaseRestBaseUrl } from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapabilityFromUrl,
} from './supabase-data-api-contract.js';

export type ObjectDatasetType =
  'contact' | 'source' | 'lifecyclemodel' | 'flowproperty' | 'unitgroup';
export type ObjectGetScope = 'public' | 'owner-draft' | 'public-or-owner-draft';
export type RunObjectGetOptions = {
  datasetType: ObjectDatasetType;
  id: string;
  version?: string | null;
  scope?: ObjectGetScope;
  expectedProjectRef?: string;
  expectedUserId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
};
export type ObjectGetReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'resolved_remote_dataset';
  dataset_type: ObjectDatasetType;
  id: string;
  requested_version: string | null;
  resolved_version: string;
  resolution: ObjectReadResolution;
  version_fallback: boolean;
  warnings: ObjectReadWarning[];
  payload_source: 'json_ordered' | 'json';
  payload: Record<string, unknown>;
  user_id: string | null;
  state_code: number;
  modified_at: string | null;
  source_url: string;
};
const TABLES = {
  contact: 'contacts',
  source: 'sources',
  lifecyclemodel: 'lifecyclemodels',
  flowproperty: 'flowproperties',
  unitgroup: 'unitgroups',
} as const;

function decodePayload(row: Record<string, unknown>): {
  payload: Record<string, unknown>;
  source: 'json_ordered' | 'json';
} {
  if (isRecord(row.json_ordered)) return { payload: row.json_ordered, source: 'json_ordered' };
  let payload: unknown = row.json;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      objectReadError('PAYLOAD_INVALID', 'Object body is not valid JSON.');
    }
  }
  if (!isRecord(payload))
    objectReadError('PAYLOAD_INVALID', 'Object body must be a complete JSON object.');
  return { payload, source: 'json' };
}

export async function runObjectGet(options: RunObjectGetOptions): Promise<ObjectGetReport> {
  const datasetType = options.datasetType;
  const id = options.id.trim().toLowerCase();
  const version =
    options.version === undefined || options.version === null ? null : options.version.trim();
  const scope = options.scope ?? 'public-or-owner-draft';
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (
    !Object.hasOwn(TABLES, datasetType) ||
    !isObjectReadUuid(id) ||
    (version !== null && !isObjectReadVersion(version))
  )
    objectReadError(
      'OPTION_INVALID',
      'An allowed object type, UUID and valid optional dataset version are required.',
      2,
    );
  if (
    !['public', 'owner-draft', 'public-or-owner-draft'].includes(scope) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > OBJECT_READ_LIMITS.durationMs ||
    (options.expectedUserId !== undefined && !isObjectReadUuid(options.expectedUserId)) ||
    (options.expectedProjectRef !== undefined && !/^[a-z0-9-]+$/u.test(options.expectedProjectRef))
  )
    objectReadError(
      'OPTION_INVALID',
      'Object read scope, timeout or identity assertion is invalid.',
      2,
    );
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    objectReadError('OPTION_INVALID', 'Object read time is invalid.', 2);
  return withObjectReadTransport(
    {
      ...options,
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? (fetch as FetchLike),
      timeoutMs,
    },
    async ({ runtime, fetchImpl, actorUserId }) => {
      const read = async (
        requestedVersion: string | null,
      ): Promise<{ rows: unknown[]; url: string }> => {
        const url = new URL(
          buildDataApiUrl(deriveSupabaseRestBaseUrl(runtime.apiBaseUrl), {
            kind: 'relation',
            name: TABLES[datasetType],
          }),
        );
        url.searchParams.set(
          'select',
          'id,version,user_id,state_code,modified_at,json,json_ordered',
        );
        url.searchParams.set('id', `eq.${id}`);
        if (scope === 'public') url.searchParams.set('state_code', 'eq.100');
        else if (scope === 'owner-draft') {
          url.searchParams.set('state_code', 'eq.0');
          url.searchParams.set('user_id', `eq.${actorUserId}`);
        } else
          url.searchParams.set(
            'or',
            `(state_code.eq.100,and(state_code.eq.0,user_id.eq.${actorUserId}))`,
          );
        if (requestedVersion !== null) url.searchParams.set('version', `eq.${requestedVersion}`);
        else url.searchParams.set('order', 'version.desc');
        url.searchParams.set('limit', '2');
        const headers = applyDataApiProfileHeaders(
          { Accept: 'application/json' },
          resolveDataApiCapabilityFromUrl({ url: url.toString(), method: 'GET' }),
          'GET',
        );
        const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error' });
        if (!response.ok) objectReadError('READ_FAILED', 'Object request was rejected.');
        let rows: unknown;
        try {
          rows = JSON.parse(await response.text());
        } catch {
          objectReadError('RESPONSE_INVALID', 'Object response must contain valid JSON.');
        }
        if (!Array.isArray(rows) || rows.length > 2)
          objectReadError('RESPONSE_INVALID', 'Object response has an invalid row set.');
        for (const row of rows) {
          if (
            !isRecord(row) ||
            row.id !== id ||
            !isObjectReadVersion(row.version) ||
            !(row.user_id === null || isObjectReadUuid(row.user_id)) ||
            !Number.isSafeInteger(row.state_code) ||
            !(
              row.modified_at === null ||
              (typeof row.modified_at === 'string' && Number.isFinite(Date.parse(row.modified_at)))
            )
          )
            objectReadError(
              'ROW_INVALID',
              'Object response contains inconsistent identity or metadata.',
            );
          if (!(
            (scope !== 'owner-draft' && row.state_code === 100) ||
            (scope !== 'public' && row.state_code === 0 && row.user_id === actorUserId)
          ))
            objectReadError('SCOPE_VIOLATION', 'Object response escaped its requested scope.');
          if (requestedVersion !== null && row.version !== requestedVersion)
            objectReadError('ROW_INVALID', 'Object response does not match the selected version.');
          validateObjectReadResult({
            datasetType,
            requestedId: id,
            requestedVersion,
            rowId: row.id,
            rowVersion: row.version,
            payload: decodePayload(row).payload,
            resolution:
              requestedVersion === null ? 'remote_supabase_latest' : 'remote_supabase_exact',
          });
        }
        if (rows.length === 2) {
          const first = rows[0] as Record<string, unknown>;
          const second = rows[1] as Record<string, unknown>;
          if (requestedVersion !== null || (first.version as string) <= (second.version as string))
            objectReadError('AMBIGUOUS', 'Object response is ambiguous or incorrectly ordered.');
        }
        return { rows, url: url.toString() };
      };
      let result = await read(version);
      let resolution: ObjectReadResolution =
        version === null ? 'remote_supabase_latest' : 'remote_supabase_exact';
      if (version !== null && result.rows.length === 0) {
        result = await read(null);
        resolution = 'remote_supabase_latest_fallback';
      }
      if (!result.rows.length)
        objectReadError('NOT_FOUND', 'Object was not found in the selected visible scope.', 2);
      const row = result.rows[0] as Record<string, unknown>;
      const decoded = decodePayload(row);
      const validated = validateObjectReadResult({
        datasetType,
        requestedId: id,
        requestedVersion: version,
        rowId: row.id,
        rowVersion: row.version,
        payload: decoded.payload,
        resolution,
      });
      return {
        schema_version: 1,
        generated_at_utc: now.toISOString(),
        status: 'resolved_remote_dataset',
        dataset_type: datasetType,
        ...validated,
        payload_source: decoded.source,
        user_id: row.user_id as string | null,
        state_code: row.state_code as number,
        modified_at: row.modified_at as string | null,
        source_url: result.url,
      };
    },
  );
}
