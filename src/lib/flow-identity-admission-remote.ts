// data-api-relations: flows
import { sha256Json, stableJsonText } from './canonical-json-hash.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  fetchCompletePostgrestPages,
  parseExactContentRange,
} from './dataset-maintenance-pagination.js';
import {
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { buildSupabaseAuthHeaders, deriveSupabaseFunctionsBaseUrl } from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapabilityFromUrl,
} from './supabase-data-api-contract.js';

type JsonObject = Record<string, unknown>;
export type FlowIdentityFlowType = 'Product flow' | 'Waste flow';
export type FlowIdentitySnapshot = {
  id: string;
  version: string;
  user_id: string | null;
  state_code: number;
  payload: JsonObject;
};
export type FlowIdentityFamilyQuery = {
  kind: 'flow_family';
  visibility: 'public' | 'owner_draft';
  ids: string[];
  type_of_dataset: FlowIdentityFlowType;
  snapshots: FlowIdentitySnapshot[];
};
export type FlowIdentityHybridQuery = {
  kind: 'flow_hybrid_search';
  query: string;
  filter: { flowType: FlowIdentityFlowType; asInput: false };
  data_source: 'tg';
  match_count: number;
  page_size: number;
  match_threshold: number;
  lexical_weight: number;
  semantic_weight: number;
  rrf_k: number;
  total_count: number | null;
  snapshots: FlowIdentitySnapshot[];
};
export type FlowIdentityCoverage = {
  schema_version: 'flow-identity-coverage.v1';
  scope: 'bounded_visible_search';
  project_ref: string;
  observed_at_utc: string;
  limitations: string[];
  queries: Array<FlowIdentityFamilyQuery | FlowIdentityHybridQuery>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const TYPE_PATH = 'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet';
const MAX_ROWS = 1_000;
const PAGE_SIZE = 100;

function fail(message: string, code = 'FLOW_IDENTITY_COVERAGE_INVALID'): never {
  throw new CliError(message, { code, exitCode: 2 });
}

function object(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exact(value: unknown, keys: string[], label: string): JsonObject {
  if (!object(value) || Object.keys(value).sort().join('\u0000') !== keys.sort().join('\u0000')) {
    fail(`Identity coverage ${label} must have exactly the supported fields.`);
  }
  return value;
}

function text(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    value.split('').some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })
  ) {
    fail(`Identity coverage ${label} must be bounded nonempty text.`);
  }
  return value;
}

function number(value: unknown, minimum: number, maximum: number, integer: boolean): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    fail('Identity coverage numeric query bound is invalid.');
  }
  return value;
}

function jsonCopy(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !object(value)) || active.has(value as object)) {
    fail('Identity coverage payload must contain only finite JSON values.');
  }
  active.add(value as object);
  let result: unknown;
  if (Array.isArray(value)) {
    result = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) fail('Identity coverage payload must not contain sparse arrays.');
      return jsonCopy(value[index], active);
    });
  } else {
    result = Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, child]) => [key, jsonCopy(child, active)]),
    );
  }
  active.delete(value as object);
  return result;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function key(row: Pick<FlowIdentitySnapshot, 'id' | 'version'>): string {
  return `${row.id}@${row.version}`;
}

/** Reads only the supported exact nested Flow type; never changes the supplied body. */
export function flowIdentityPayloadType(payload: unknown): FlowIdentityFlowType | null {
  const dataset = object(payload) ? payload.flowDataSet : null;
  const modelling = object(dataset) ? dataset.modellingAndValidation : null;
  const method = object(modelling) ? modelling.LCIMethod : null;
  const type = object(method) ? method.typeOfDataSet : null;
  return type === 'Product flow' || type === 'Waste flow' ? type : null;
}

function snapshot(
  value: unknown,
  actorUserId: string,
  visibility: 'public' | 'owner_draft',
  flowType: FlowIdentityFlowType,
): FlowIdentitySnapshot {
  const row = exact(value, ['id', 'version', 'user_id', 'state_code', 'payload'], 'snapshot');
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    typeof row.version !== 'string' ||
    !VERSION.test(row.version) ||
    (row.user_id !== null && (typeof row.user_id !== 'string' || !UUID.test(row.user_id))) ||
    !Number.isInteger(row.state_code) ||
    (visibility === 'public'
      ? Number(row.state_code) < 100 || Number(row.state_code) >= 200
      : row.state_code !== 0 || row.user_id !== actorUserId) ||
    !object(row.payload) ||
    flowIdentityPayloadType(row.payload) !== flowType
  ) {
    fail(
      'Identity coverage snapshot violated the exact identity, query Flow type, or visibility fence.',
    );
  }
  return {
    id: row.id,
    version: row.version,
    user_id: row.user_id as string | null,
    state_code: row.state_code as number,
    payload: jsonCopy(row.payload) as JsonObject,
  };
}

function snapshots(
  value: unknown,
  actorUserId: string,
  visibility: 'public' | 'owner_draft',
  flowType: FlowIdentityFlowType,
): FlowIdentitySnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS)
    fail('Identity coverage snapshot count exceeds the supported bound.');
  const result = value
    .map((entry) => snapshot(entry, actorUserId, visibility, flowType))
    .sort((left, right) => key(left).localeCompare(key(right), 'en'));
  if (new Set(result.map(key)).size !== result.length)
    fail('Identity coverage contains duplicate candidate identities.');
  return result;
}

/** Strict, immutable descriptions of the reads supported by this opt-in profile. */
export function parseFlowIdentityCoverage(
  value: unknown,
  actorUserId: string,
): FlowIdentityCoverage {
  if (!UUID.test(actorUserId)) fail('Identity coverage requires an exact actor UUID.');
  const root = exact(
    value,
    ['schema_version', 'scope', 'project_ref', 'observed_at_utc', 'limitations', 'queries'],
    'root',
  );
  if (
    root.schema_version !== 'flow-identity-coverage.v1' ||
    root.scope !== 'bounded_visible_search'
  )
    fail('Unsupported identity coverage schema or scope.');
  const projectRef = text(root.project_ref, 253, 'project_ref');
  if (!/^[a-z0-9.-]+$/u.test(projectRef)) fail('Identity coverage project reference is invalid.');
  const observed = text(root.observed_at_utc, 30, 'observed_at_utc');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observed) ||
    !Number.isFinite(Date.parse(observed)) ||
    new Date(observed).toISOString() !== observed
  )
    fail('Identity coverage observation time is invalid.');
  if (
    !Array.isArray(root.limitations) ||
    root.limitations.length < 1 ||
    root.limitations.length > 20
  )
    fail('Identity coverage must disclose its bounded search limitations.');
  const limitations = root.limitations.map((entry) => text(entry, 2_000, 'limitation'));
  if (!Array.isArray(root.queries) || root.queries.length < 1 || root.queries.length > 20)
    fail('Identity coverage needs between one and twenty supported queries.');
  const queries = root.queries.map((entry): FlowIdentityFamilyQuery | FlowIdentityHybridQuery => {
    if (object(entry) && entry.kind === 'flow_family') {
      const query = exact(
        entry,
        ['kind', 'visibility', 'ids', 'type_of_dataset', 'snapshots'],
        'family query',
      );
      if (
        (query.visibility !== 'public' && query.visibility !== 'owner_draft') ||
        (query.type_of_dataset !== 'Product flow' && query.type_of_dataset !== 'Waste flow') ||
        !Array.isArray(query.ids) ||
        query.ids.length < 1 ||
        query.ids.length > 50 ||
        query.ids.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
        new Set(query.ids).size !== query.ids.length
      )
        fail('Identity coverage family query has unsupported filters.');
      const ids = (query.ids as string[]).toSorted();
      const rows = snapshots(query.snapshots, actorUserId, query.visibility, query.type_of_dataset);
      if (rows.some((row) => !ids.includes(row.id)))
        fail('Identity coverage snapshot is outside its requested families.');
      return {
        kind: 'flow_family',
        visibility: query.visibility,
        ids,
        type_of_dataset: query.type_of_dataset,
        snapshots: rows,
      };
    }
    const query = exact(
      entry,
      [
        'kind',
        'query',
        'filter',
        'data_source',
        'match_count',
        'page_size',
        'match_threshold',
        'lexical_weight',
        'semantic_weight',
        'rrf_k',
        'total_count',
        'snapshots',
      ],
      'hybrid query',
    );
    const filter = exact(query.filter, ['flowType', 'asInput'], 'hybrid filter');
    if (
      query.kind !== 'flow_hybrid_search' ||
      query.data_source !== 'tg' ||
      (filter.flowType !== 'Product flow' && filter.flowType !== 'Waste flow') ||
      filter.asInput !== false
    )
      fail(
        'Identity coverage hybrid query supports only the public Product/Waste Flow filter profile.',
      );
    const rows = snapshots(query.snapshots, actorUserId, 'public', filter.flowType);
    if (rows.some((row) => row.state_code !== 100))
      fail('The public hybrid source is restricted to state 100.');
    const pageSize = number(query.page_size, 1, 100, true);
    const total = query.total_count === null ? null : number(query.total_count, 0, MAX_ROWS, true);
    if (rows.length > pageSize || (total !== null && total !== rows.length))
      fail('Identity coverage hybrid query has unhandled pagination truncation.');
    const lexical = number(query.lexical_weight, 0, 1, false);
    const semantic = number(query.semantic_weight, 0, 1, false);
    if (lexical + semantic <= 0) fail('Identity coverage hybrid weights must have a positive sum.');
    return {
      kind: 'flow_hybrid_search',
      query: text(query.query, 1_800, 'query'),
      filter: { flowType: filter.flowType, asInput: false },
      data_source: 'tg',
      // This profile uses the raw latest route, whose Edge contract caps this budget at 100.
      match_count: number(query.match_count, 1, 100, true),
      page_size: pageSize,
      match_threshold: number(query.match_threshold, 0, 1, false),
      lexical_weight: lexical,
      semantic_weight: semantic,
      rrf_k: number(query.rrf_k, 1, 1_000, true),
      total_count: total,
      snapshots: rows,
    };
  });
  const coverage: FlowIdentityCoverage = {
    schema_version: 'flow-identity-coverage.v1',
    scope: 'bounded_visible_search',
    project_ref: projectRef,
    observed_at_utc: observed,
    limitations,
    queries,
  };
  flowIdentityCoverageSnapshots(coverage);
  return freeze(coverage);
}

export function flowIdentityCoverageSnapshots(
  coverage: FlowIdentityCoverage,
): FlowIdentitySnapshot[] {
  const rows = new Map<string, FlowIdentitySnapshot>();
  for (const query of coverage.queries) {
    for (const row of query.snapshots) {
      const previous = rows.get(key(row));
      if (previous && stableJsonText(previous) !== stableJsonText(row))
        fail('Repeated identity coverage snapshots disagree.');
      rows.set(key(row), row);
    }
  }
  if (rows.size > MAX_ROWS) fail('Identity coverage exceeds the total candidate bound.');
  return [...rows.values()].sort((left, right) => key(left).localeCompare(key(right), 'en'));
}

async function responseJson(
  context: DatasetMaintenanceRemoteContext,
  url: string,
  init: RequestInit,
): Promise<{ value: unknown; range: string | null }> {
  const response = await context.fetch_impl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(context.timeout_ms),
  });
  if (!response.ok)
    fail('Identity coverage remote observation failed.', 'FLOW_IDENTITY_COVERAGE_READ_FAILED');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 20_000_000)
    fail('Identity coverage response exceeds the supported byte bound.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('Identity coverage remote response is not JSON.', 'FLOW_IDENTITY_COVERAGE_READ_FAILED');
  }
  return { value, range: response.headers.get('content-range') };
}

function fencedUrl(
  context: DatasetMaintenanceRemoteContext,
  visibility: 'public' | 'owner_draft',
  flowType: FlowIdentityFlowType,
): URL {
  const url = new URL(buildDataApiUrl(context.rest_base_url, { kind: 'relation', name: 'flows' }));
  url.searchParams.set('select', 'id,version,user_id,state_code,json');
  if (visibility === 'public') {
    url.searchParams.set('and', '(state_code.gte.100,state_code.lt.200)');
  } else {
    url.searchParams.set('user_id', `eq.${context.account.user_id}`);
    url.searchParams.set('state_code', 'eq.0');
  }
  url.searchParams.set(TYPE_PATH, `eq.${flowType}`);
  return url;
}

async function readRows(
  context: DatasetMaintenanceRemoteContext,
  url: URL,
  visibility: 'public' | 'owner_draft',
  flowType: FlowIdentityFlowType,
): Promise<{ rows: FlowIdentitySnapshot[]; range: string | null }> {
  const headers = applyDataApiProfileHeaders(
    {
      ...buildSupabaseAuthHeaders(context.publishable_key, context.access_token),
      Prefer: 'count=exact',
    },
    resolveDataApiCapabilityFromUrl({ url: url.toString(), method: 'GET' }),
    'GET',
  );
  const response = await responseJson(context, url.toString(), { method: 'GET', headers });
  if (!Array.isArray(response.value))
    fail('Identity coverage remote rows are malformed.', 'FLOW_IDENTITY_COVERAGE_READ_FAILED');
  const rows = response.value.map((value) => {
    if (!object(value))
      fail('Identity coverage remote row is malformed.', 'FLOW_IDENTITY_COVERAGE_READ_FAILED');
    return snapshot(
      {
        id: value.id,
        version: value.version,
        user_id: value.user_id,
        state_code: value.state_code,
        payload: value.json,
      },
      context.account.user_id,
      visibility,
      flowType,
    );
  });
  return { rows, range: response.range };
}

async function familyRows(
  context: DatasetMaintenanceRemoteContext,
  query: FlowIdentityFamilyQuery,
): Promise<FlowIdentitySnapshot[]> {
  const result = await fetchCompletePostgrestPages({
    table: 'flows',
    requestedPageSize: PAGE_SIZE,
    rowIdentity: key,
    fetchPage: async (offset) => {
      const url = fencedUrl(context, query.visibility, query.type_of_dataset);
      url.searchParams.set('id', `in.(${query.ids.join(',')})`);
      url.searchParams.set('order', 'id.asc,version.asc');
      url.searchParams.set('limit', String(PAGE_SIZE));
      url.searchParams.set('offset', String(offset));
      const page = await readRows(context, url, query.visibility, query.type_of_dataset);
      if (
        parseExactContentRange(page.range).total > MAX_ROWS ||
        page.rows.some((row) => !query.ids.includes(row.id))
      )
        fail('Identity coverage family response exceeded its query bound.');
      return { rows: page.rows, source_url: url.toString(), content_range: page.range };
    },
  });
  return result.rows;
}

async function hybridRows(
  context: DatasetMaintenanceRemoteContext,
  query: FlowIdentityHybridQuery,
): Promise<FlowIdentitySnapshot[]> {
  // The existing Edge/SQL latest `tg` adapter restricts search to state 100.
  // `my` is deliberately unsupported: its latest route includes non-draft states.
  const url = `${deriveSupabaseFunctionsBaseUrl(context.rest_base_url)}/flow_hybrid_search`;
  const body = {
    query: query.query,
    filter: query.filter,
    data_source: query.data_source,
    match_count: query.match_count,
    page_size: query.page_size,
    page_current: 1,
    match_threshold: query.match_threshold,
    lexical_weight: query.lexical_weight,
    semantic_weight: query.semantic_weight,
    rrf_k: query.rrf_k,
  };
  const response = await responseJson(context, url, {
    method: 'POST',
    headers: {
      ...buildSupabaseAuthHeaders(context.publishable_key, context.access_token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const value = response.value;
  const rows =
    Array.isArray(value) && value.length === 0
      ? value
      : object(value) && Object.keys(value).length === 1 && Array.isArray(value.data)
        ? value.data
        : null;
  if (rows === null || rows.length > query.page_size)
    fail(
      'Identity coverage search response is malformed or truncated.',
      'FLOW_IDENTITY_COVERAGE_READ_FAILED',
    );
  const identities = rows.map((row) => {
    if (
      !object(row) ||
      typeof row.id !== 'string' ||
      !UUID.test(row.id) ||
      typeof row.version !== 'string' ||
      !VERSION.test(row.version)
    )
      fail('Identity coverage search returned a malformed exact identity.');
    if (
      row.total_count !== undefined &&
      row.total_count !== null &&
      number(row.total_count, 0, MAX_ROWS, true) !== rows.length
    )
      fail('Identity coverage search has unhandled pagination truncation.');
    if (query.total_count !== null && row.total_count !== query.total_count)
      fail('Identity coverage search total changed.');
    return { id: row.id, version: row.version };
  });
  const expectedKeys = query.snapshots.map(key).sort();
  const actualKeys = identities.map(key).sort();
  if (
    new Set(actualKeys).size !== actualKeys.length ||
    stableJsonText(actualKeys) !== stableJsonText(expectedKeys)
  )
    fail('Identity coverage search membership changed.', 'FLOW_IDENTITY_COVERAGE_DRIFT');
  const snapshots: FlowIdentitySnapshot[] = [];
  for (const identity of identities) {
    const exactUrl = fencedUrl(context, 'public', query.filter.flowType);
    exactUrl.searchParams.set('id', `eq.${identity.id}`);
    exactUrl.searchParams.set('version', `eq.${identity.version}`);
    exactUrl.searchParams.set('limit', '2');
    const current = await readRows(context, exactUrl, 'public', query.filter.flowType);
    const range = parseExactContentRange(current.range);
    if (
      current.rows.length !== 1 ||
      range.start !== 0 ||
      range.end !== 0 ||
      range.total !== 1 ||
      key(current.rows[0]!) !== key(identity) ||
      current.rows[0]!.state_code !== 100
    )
      fail(
        'Identity coverage search candidate disappeared or changed visibility.',
        'FLOW_IDENTITY_COVERAGE_DRIFT',
      );
    snapshots.push(current.rows[0]!);
  }
  return snapshots;
}

/** Reobserves the same bounded membership and every full body; never a global uniqueness proof. */
export async function verifyFlowIdentityCoverage(options: {
  coverage: FlowIdentityCoverage;
  actorUserId: string;
  projectRef: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<{
  observed_at_utc: string;
  coverage_sha256: string;
  query_count: number;
  candidate_count: number;
  scope: 'bounded_visible_search';
}> {
  // Reparse before any auth or data I/O, even when a caller bypasses the typed parser.
  const coverage = parseFlowIdentityCoverage(options.coverage, options.actorUserId);
  if (coverage.project_ref !== options.projectRef)
    fail('Identity coverage project binding changed.');
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  if (context.account.user_id !== options.actorUserId || context.project_ref !== options.projectRef)
    fail('Identity coverage live actor or project binding changed.');
  for (const query of coverage.queries) {
    const rows =
      query.kind === 'flow_family'
        ? await familyRows(context, query)
        : await hybridRows(context, query);
    const actual = rows.toSorted((left, right) => key(left).localeCompare(key(right), 'en'));
    if (stableJsonText(actual) !== stableJsonText(query.snapshots))
      fail(
        'Identity coverage candidate body, owner, state, version, or membership changed.',
        'FLOW_IDENTITY_COVERAGE_DRIFT',
      );
  }
  return {
    observed_at_utc: new Date().toISOString(),
    coverage_sha256: sha256Json(coverage),
    query_count: coverage.queries.length,
    candidate_count: flowIdentityCoverageSnapshots(coverage).length,
    scope: coverage.scope,
  };
}
