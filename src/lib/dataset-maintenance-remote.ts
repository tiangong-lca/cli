// data-api-relations: contacts, flowproperties, flows, lciamethods, lifecyclemodels, processes, sources, unitgroups
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import {
  buildSnapshotCompleteness,
  fetchCompletePostgrestPages,
  type DatasetMaintenanceTableCompleteness,
  type DatasetMaintenanceSnapshotCompleteness,
} from './dataset-maintenance-pagination.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  isDataApiUrl,
  resolveDataApiCapabilityFromUrl,
  type DataApiRpc,
} from './supabase-data-api-contract.js';
import { resolveSupabaseUserSession } from './supabase-session.js';
import {
  isJsonObject,
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenanceMutableTable,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceScanTable,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import { assertFlowIdentityWireJson } from './dataset-maintenance-flow-identity-wire.js';

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export type DatasetMaintenanceRemoteContext = {
  project_ref: string;
  rest_base_url: string;
  publishable_key: string;
  access_token: string;
  account: {
    user_id: string;
    email: string;
    session_source: string;
  };
  fetch_impl: FetchLike;
  timeout_ms: number;
};

export type DatasetMaintenanceDerivativeRemoteRow = {
  table: 'flows' | 'processes';
  id: string;
  version: string;
  user_id: string;
  state_code: number;
  raw: JsonObject;
};

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeStateCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  return typeof value === 'string' && /^-?\d+$/u.test(value.trim())
    ? Number.parseInt(value.trim(), 10)
    : null;
}

export function normalizeMaintenancePageSize(value?: number): number {
  const normalized = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 5_000) {
    throw new CliError('Maintenance page size must be an integer between 1 and 5000.', {
      code: 'DATASET_MAINTENANCE_PAGE_SIZE_INVALID',
      exitCode: 2,
      details: value,
    });
  }
  return normalized;
}

export function normalizeMaintenanceTimeout(value?: number): number {
  const normalized = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new CliError('Maintenance timeout must be a positive integer.', {
      code: 'DATASET_MAINTENANCE_TIMEOUT_INVALID',
      exitCode: 2,
      details: value,
    });
  }
  return normalized;
}

async function fetchJsonResponse(options: {
  context: Pick<
    DatasetMaintenanceRemoteContext,
    'publishable_key' | 'access_token' | 'fetch_impl' | 'timeout_ms'
  >;
  url: string;
  init?: RequestInit;
  label: string;
  redactResponseDetails?: boolean;
}): Promise<{ body: unknown; headers: ResponseLike['headers'] }> {
  const method = options.init?.method ?? 'GET';
  const authHeaders = new Headers(
    buildSupabaseAuthHeaders(options.context.publishable_key, options.context.access_token),
  );
  new Headers(options.init?.headers).forEach((value, name) => {
    authHeaders.set(name, value);
  });
  const requestHeaders = Object.fromEntries(authHeaders.entries());
  const isDataApiRequest = isDataApiUrl(options.url);
  const response = await options.context.fetch_impl(options.url, {
    ...options.init,
    headers: isDataApiRequest
      ? applyDataApiProfileHeaders(
          requestHeaders,
          resolveDataApiCapabilityFromUrl({ url: options.url, method }),
          method,
        )
      : requestHeaders,
    signal: AbortSignal.timeout(options.context.timeout_ms),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned from ${options.label}`, {
      code: 'DATASET_MAINTENANCE_REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: options.redactResponseDetails
        ? { url: options.url, response_redacted: true }
        : { url: options.url, response: text },
    });
  }
  if (!text.trim()) {
    return { body: null, headers: response.headers };
  }
  try {
    return { body: JSON.parse(text), headers: response.headers };
  } catch (error) {
    throw new CliError(`Remote response was not valid JSON for ${options.label}`, {
      code: 'DATASET_MAINTENANCE_REMOTE_INVALID_JSON',
      exitCode: 1,
      details: {
        url: options.url,
        error: String(error),
      },
    });
  }
}

async function fetchJson(options: {
  context: Pick<
    DatasetMaintenanceRemoteContext,
    'publishable_key' | 'access_token' | 'fetch_impl' | 'timeout_ms'
  >;
  url: string;
  init?: RequestInit;
  label: string;
  redactResponseDetails?: boolean;
}): Promise<unknown> {
  return (await fetchJsonResponse(options)).body;
}

function selectForTable(table: DatasetMaintenanceScanTable, includeJson = false): string {
  const common = `id,version,user_id,state_code,modified_at,${includeJson ? 'json,' : ''}json_ordered,rule_verification`;
  return table === 'processes' ? `${common},model_id` : common;
}

function normalizeRemoteRow(
  table: DatasetMaintenanceScanTable,
  value: unknown,
  includeJson = false,
): DatasetMaintenanceRemoteRow | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = trimToken(value.id);
  const version = trimToken(value.version);
  if (!id || !version) {
    return null;
  }
  return {
    table,
    id,
    version,
    user_id: trimToken(value.user_id),
    state_code: normalizeStateCode(value.state_code),
    modified_at: trimToken(value.modified_at),
    ...(includeJson ? { json: isJsonObject(value.json) ? value.json : null } : {}),
    json_ordered: isJsonObject(value.json_ordered) ? value.json_ordered : null,
    model_id: trimToken(value.model_id),
    rule_verification:
      typeof value.rule_verification === 'boolean' ? value.rule_verification : null,
  };
}

function normalizeRemoteRows(
  table: DatasetMaintenanceScanTable,
  value: unknown,
  label: string,
  includeJson = false,
): DatasetMaintenanceRemoteRow[] {
  if (!Array.isArray(value)) {
    throw new CliError(`Remote response was not an array for ${label}.`, {
      code: 'DATASET_MAINTENANCE_REMOTE_ROWS_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  const rows = value.map((entry) => normalizeRemoteRow(table, entry, includeJson));
  if (rows.some((row) => row === null)) {
    throw new CliError(`Remote response contained an invalid row for ${label}.`, {
      code: 'DATASET_MAINTENANCE_REMOTE_ROW_INVALID',
      exitCode: 1,
    });
  }
  return rows as DatasetMaintenanceRemoteRow[];
}

export async function resolveMaintenanceRemoteContext(options: {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): Promise<DatasetMaintenanceRemoteContext> {
  const timeoutMs = normalizeMaintenanceTimeout(options.timeoutMs);
  const runtime = requireSupabaseRestRuntime(options.env);
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs,
    now: options.now,
  });
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
  const projectHost = new URL(projectBaseUrl).hostname;
  const projectRef = projectHost.endsWith('.supabase.co')
    ? projectHost.slice(0, -'.supabase.co'.length)
    : projectHost;
  const partialContext = {
    publishable_key: runtime.publishableKey,
    access_token: session.accessToken,
    fetch_impl: options.fetchImpl,
    timeout_ms: timeoutMs,
  };
  const currentUser = await fetchJson({
    context: partialContext,
    url: `${projectBaseUrl}/auth/v1/user`,
    label: 'supabase current-user lookup',
  });
  const userId = isJsonObject(currentUser) ? trimToken(currentUser.id) : null;
  const email = isJsonObject(currentUser)
    ? (trimToken(currentUser.email) ?? trimToken(session.userEmail))
    : trimToken(session.userEmail);
  if (!userId || !email) {
    throw new CliError('Supabase current-user lookup did not return id and email.', {
      code: 'DATASET_MAINTENANCE_CURRENT_USER_INVALID',
      exitCode: 1,
    });
  }
  return {
    project_ref: projectRef,
    rest_base_url: deriveSupabaseRestBaseUrl(projectBaseUrl),
    publishable_key: runtime.publishableKey,
    access_token: session.accessToken,
    account: {
      user_id: userId,
      email,
      session_source: session.source,
    },
    fetch_impl: options.fetchImpl,
    timeout_ms: timeoutMs,
  };
}

export async function fetchMaintenanceExactRows(options: {
  context: DatasetMaintenanceRemoteContext;
  table: DatasetMaintenanceScanTable;
  id: string;
  version: string;
  includeJson?: boolean;
}): Promise<{ rows: DatasetMaintenanceRemoteRow[]; source_url: string }> {
  const url = new URL(`${options.context.rest_base_url}/${options.table}`);
  url.searchParams.set('select', selectForTable(options.table, options.includeJson));
  url.searchParams.set('id', `eq.${options.id}`);
  url.searchParams.set('version', `eq.${options.version}`);
  url.searchParams.set('limit', '2');
  const sourceUrl = url.toString();
  const body = await fetchJson({
    context: options.context,
    url: sourceUrl,
    label: `${options.table} exact maintenance lookup`,
  });
  return {
    rows: normalizeRemoteRows(options.table, body, sourceUrl, options.includeJson),
    source_url: sourceUrl,
  };
}

export async function fetchMaintenanceAccountRows(options: {
  context: DatasetMaintenanceRemoteContext;
  userId: string;
  pageSize?: number;
}): Promise<{
  rows: DatasetMaintenanceRemoteRow[];
  source_urls: string[];
  completeness: DatasetMaintenanceSnapshotCompleteness<DatasetMaintenanceScanTable>;
}> {
  const pageSize = normalizeMaintenancePageSize(options.pageSize);
  const tableResults: Array<{
    table: DatasetMaintenanceScanTable;
    rows: DatasetMaintenanceRemoteRow[];
    source_urls: string[];
    completeness: Awaited<ReturnType<typeof fetchCompletePostgrestPages>>['completeness'];
  }> = [];
  for (const table of MAINTENANCE_SCAN_TABLES) {
    const result = await fetchCompletePostgrestPages({
      table,
      requestedPageSize: pageSize,
      rowIdentity: (row: DatasetMaintenanceRemoteRow) => `${row.id}\u0000${row.version}`,
      fetchPage: async (offset) => {
        const url = new URL(`${options.context.rest_base_url}/${table}`);
        url.searchParams.set('select', selectForTable(table));
        url.searchParams.set('user_id', `eq.${options.userId}`);
        url.searchParams.set('order', 'id.asc,version.asc');
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const sourceUrl = url.toString();
        const response = await fetchJsonResponse({
          context: options.context,
          url: sourceUrl,
          init: { headers: { Prefer: 'count=exact' } },
          label: `${table} account maintenance snapshot`,
        });
        const rows = normalizeRemoteRows(table, response.body, sourceUrl);
        if (rows.some((row) => row.user_id !== options.userId)) {
          throw new CliError(`Remote ${table} snapshot contained a foreign account row.`, {
            code: 'DATASET_MAINTENANCE_REMOTE_ROW_INVALID',
            exitCode: 1,
          });
        }
        return {
          rows,
          source_url: sourceUrl,
          content_range: response.headers.get('content-range'),
        };
      },
    });
    tableResults.push({ table, ...result });
  }
  return {
    rows: tableResults.flatMap((result) => result.rows),
    source_urls: tableResults.flatMap((result) => result.source_urls),
    completeness: buildSnapshotCompleteness({
      tables: MAINTENANCE_SCAN_TABLES,
      requestedPageSize: pageSize,
      results: tableResults,
    }),
  };
}

export async function fetchMaintenanceAccountTableRows(options: {
  context: DatasetMaintenanceRemoteContext;
  userId: string;
  table: DatasetMaintenanceScanTable;
  stateCode?: number;
  includeJson?: boolean;
  pageSize?: number;
}): Promise<{
  rows: DatasetMaintenanceRemoteRow[];
  source_urls: string[];
  completeness: DatasetMaintenanceTableCompleteness;
}> {
  const pageSize = normalizeMaintenancePageSize(options.pageSize);
  return fetchCompletePostgrestPages({
    table: options.table,
    requestedPageSize: pageSize,
    rowIdentity: (row: DatasetMaintenanceRemoteRow) => `${row.id}\u0000${row.version}`,
    fetchPage: async (offset) => {
      const url = new URL(`${options.context.rest_base_url}/${options.table}`);
      url.searchParams.set('select', selectForTable(options.table, options.includeJson));
      url.searchParams.set('user_id', `eq.${options.userId}`);
      if (options.stateCode !== undefined) {
        url.searchParams.set('state_code', `eq.${options.stateCode}`);
      }
      url.searchParams.set('order', 'id.asc,version.asc');
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(offset));
      const sourceUrl = url.toString();
      const response = await fetchJsonResponse({
        context: options.context,
        url: sourceUrl,
        init: { headers: { Prefer: 'count=exact' } },
        label: `${options.table} account maintenance snapshot`,
      });
      const rows = normalizeRemoteRows(
        options.table,
        response.body,
        sourceUrl,
        options.includeJson,
      );
      if (
        rows.some(
          (row) =>
            row.user_id !== options.userId ||
            (options.stateCode !== undefined && row.state_code !== options.stateCode),
        )
      ) {
        throw new CliError(`Remote ${options.table} snapshot violated the account/state fence.`, {
          code: 'DATASET_MAINTENANCE_REMOTE_ROW_INVALID',
          exitCode: 1,
        });
      }
      return {
        rows,
        source_url: sourceUrl,
        content_range: response.headers.get('content-range'),
      };
    },
  });
}

/**
 * Read every row visible to the authenticated owner for one maintenance table.
 *
 * This deliberately omits a user_id predicate. It is a SELECT-only RLS view used
 * by destructive maintenance admission to prove that a draft flow has no inbound
 * reference from either an owner row or another row visible to the owner session.
 */
export async function fetchMaintenanceVisibleTableRows(options: {
  context: DatasetMaintenanceRemoteContext;
  table: DatasetMaintenanceScanTable;
  includeJson?: boolean;
  pageSize?: number;
}): Promise<{
  rows: DatasetMaintenanceRemoteRow[];
  source_urls: string[];
  completeness: DatasetMaintenanceTableCompleteness;
}> {
  const pageSize = normalizeMaintenancePageSize(options.pageSize);
  return fetchCompletePostgrestPages({
    table: options.table,
    requestedPageSize: pageSize,
    // Every maintenance table is keyed by the globally unique (id, version)
    // pair. Keep the visible scan on that strict primary-key order so Postgres
    // can paginate through the index without a redundant full-result sort.
    rowIdentity: (row: DatasetMaintenanceRemoteRow) => `${row.id}\u0000${row.version}`,
    fetchPage: async (offset) => {
      const url = new URL(`${options.context.rest_base_url}/${options.table}`);
      url.searchParams.set('select', selectForTable(options.table, options.includeJson));
      url.searchParams.set('order', 'id.asc,version.asc');
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(offset));
      const sourceUrl = url.toString();
      const response = await fetchJsonResponse({
        context: options.context,
        url: sourceUrl,
        init: { headers: { Prefer: 'count=exact' } },
        label: `${options.table} visible maintenance snapshot`,
      });
      return {
        rows: normalizeRemoteRows(options.table, response.body, sourceUrl, options.includeJson),
        source_url: sourceUrl,
        content_range: response.headers.get('content-range'),
      };
    },
  });
}

async function invokeMaintenanceRpc(options: {
  context: DatasetMaintenanceRemoteContext;
  rpc: DataApiRpc;
  body: JsonObject;
  minimumTimeoutMs?: number;
  allowDomainFailure?: boolean;
}): Promise<JsonObject> {
  const url = buildDataApiUrl(options.context.rest_base_url, {
    kind: 'rpc',
    name: options.rpc,
  });
  const redactResponseDetails = options.rpc.startsWith('cmd_dataset_flow_identity_');
  const body = await fetchJson({
    context: {
      ...options.context,
      timeout_ms: Math.max(options.context.timeout_ms, options.minimumTimeoutMs ?? 0),
    },
    url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options.body),
    },
    label: options.rpc,
    redactResponseDetails,
  });
  if (
    redactResponseDetails &&
    isJsonObject(body) &&
    body.ok !== true &&
    Object.hasOwn(body, 'execution_permit')
  ) {
    throw new CliError(`${options.rpc} returned an invalid rejection envelope.`, {
      code: 'DATASET_MAINTENANCE_RPC_FAILED',
      exitCode: 1,
      details: { rpc: options.rpc, response_redacted: true },
    });
  }
  if (
    !isJsonObject(body) ||
    (body.ok !== true &&
      !(options.allowDomainFailure === true && isMaintenanceRpcDomainFailure(body)))
  ) {
    throw new CliError(`${options.rpc} returned an unexpected response.`, {
      code: 'DATASET_MAINTENANCE_RPC_FAILED',
      exitCode: 1,
      details: redactResponseDetails ? { rpc: options.rpc, response_redacted: true } : body,
    });
  }
  return body;
}

export type MaintenanceRpcDomainFailure = JsonObject & {
  ok: false;
  code: string;
  status: string | number;
};

export function isMaintenanceRpcDomainFailure(
  value: unknown,
): value is MaintenanceRpcDomainFailure {
  return Boolean(
    isJsonObject(value) &&
    value.ok === false &&
    typeof value.code === 'string' &&
    value.code.trim() &&
    ((typeof value.status === 'number' && Number.isSafeInteger(value.status)) ||
      (typeof value.status === 'string' && value.status.trim())),
  );
}

export async function preflightMaintenanceAliasExecution(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_preflight_guarded',
    body: { p_request: options.request },
    minimumTimeoutMs: 90_000,
  });
}

export async function admitMaintenanceAliasExecution(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_admit_guarded',
    body: { p_request: options.request },
    minimumTimeoutMs: 90_000,
  });
}

export async function captureMaintenanceAliasExecutionGate(options: {
  context: DatasetMaintenanceRemoteContext;
  requestId: string;
  preflightToken: string;
  gateName: 'primary_support_plan' | 'execution_unused' | 'derivative_quiescence';
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_gate_guarded',
    body: {
      p_request_id: options.requestId,
      p_preflight_token: options.preflightToken,
      p_gate_name: options.gateName,
    },
    minimumTimeoutMs: 90_000,
  });
}

export async function readMaintenanceAliasExecution(options: {
  context: DatasetMaintenanceRemoteContext;
  requestId: string;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_read',
    body: { p_request_id: options.requestId },
    minimumTimeoutMs: 90_000,
  });
}

// Versioned (v2) protected lifecycle calls: the same transport, the same request bodies, the
// versioned function names the wire agreement fixes. The private v2 executors are absent by
// design — the server-side admission callback reaches them, never this client.

export async function preflightMaintenanceAliasExecutionV2(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_preflight_v2_guarded',
    body: { p_request: options.request },
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function admitMaintenanceAliasExecutionV2(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_admit_v2_guarded',
    body: { p_request: options.request },
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function captureMaintenanceAliasExecutionGateV2(options: {
  context: DatasetMaintenanceRemoteContext;
  requestId: string;
  preflightToken: string;
  gateName: 'primary_support_plan' | 'execution_unused' | 'derivative_quiescence';
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_gate_v2_guarded',
    body: {
      p_request_id: options.requestId,
      p_preflight_token: options.preflightToken,
      p_gate_name: options.gateName,
    },
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function readMaintenanceAliasExecutionV2(options: {
  context: DatasetMaintenanceRemoteContext;
  requestId: string;
}): Promise<JsonObject> {
  // The read stage answers with the stored evidence, or with the bare success envelope when it
  // holds no durable evidence for this client request id; the caller reads that envelope.
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_alias_execution_read_v2',
    body: { p_request_id: options.requestId },
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

function derivativeSelectForTable(table: 'flows' | 'processes'): string {
  void table;
  return 'id,version,user_id,state_code,modified_at,json,json_ordered,extracted_md,embedding_ft,embedding_ft_at';
}

export async function fetchMaintenanceDerivativeTargetRows(options: {
  context: DatasetMaintenanceRemoteContext;
  targets: Array<{ table: 'flows' | 'processes'; id: string; version: string }>;
  concurrency?: number;
}): Promise<{ rows: DatasetMaintenanceDerivativeRemoteRow[]; source_urls: string[] }> {
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new CliError('Derivative target read concurrency must be an integer between 1 and 10.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_READ_CONCURRENCY_INVALID',
      exitCode: 2,
    });
  }
  if (options.targets.length > 50) {
    throw new CliError('Protected derivative target read is bounded to 50 rows.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_TARGET_COUNT_INVALID',
      exitCode: 2,
    });
  }
  const rows: DatasetMaintenanceDerivativeRemoteRow[] = [];
  const sourceUrls: string[] = [];
  for (let offset = 0; offset < options.targets.length; offset += concurrency) {
    const chunk = options.targets.slice(offset, offset + concurrency);
    const results = await Promise.all(
      chunk.map(async (target) => {
        const url = new URL(`${options.context.rest_base_url}/${target.table}`);
        url.searchParams.set('select', derivativeSelectForTable(target.table));
        url.searchParams.set('id', `eq.${target.id}`);
        url.searchParams.set('version', `eq.${target.version}`);
        url.searchParams.set('limit', '2');
        const sourceUrl = url.toString();
        const body = await fetchJson({
          context: options.context,
          url: sourceUrl,
          label: `${target.table} protected derivative lookup`,
        });
        if (!Array.isArray(body) || body.length !== 1 || !isJsonObject(body[0])) {
          throw new CliError('Protected derivative target was missing, duplicated, or malformed.', {
            code: 'DATASET_MAINTENANCE_DERIVATIVE_TARGET_READ_INVALID',
            exitCode: 1,
            details: target,
          });
        }
        const row = body[0];
        const id = trimToken(row.id);
        const version = trimToken(row.version);
        const userId = trimToken(row.user_id);
        const stateCode = normalizeStateCode(row.state_code);
        if (id !== target.id || version !== target.version || !userId || stateCode === null) {
          throw new CliError('Protected derivative target identity was malformed.', {
            code: 'DATASET_MAINTENANCE_DERIVATIVE_TARGET_READ_INVALID',
            exitCode: 1,
            details: target,
          });
        }
        return {
          row: {
            table: target.table,
            id,
            version,
            user_id: userId,
            state_code: stateCode,
            raw: row,
          } satisfies DatasetMaintenanceDerivativeRemoteRow,
          sourceUrl,
        };
      }),
    );
    rows.push(...results.map((result) => result.row));
    sourceUrls.push(...results.map((result) => result.sourceUrl));
  }
  return { rows, source_urls: sourceUrls };
}

export async function fetchMaintenanceDerivativeSnapshot(options: {
  context: DatasetMaintenanceRemoteContext;
  table?: 'flows' | 'processes';
  id: string;
  version: string;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_derivative_rebuild_snapshot',
    body: {
      p_table: options.table ?? 'processes',
      p_id: options.id,
      p_version: options.version,
    },
  });
}

export async function applyMaintenanceDerivativeRebuild(options: {
  context: DatasetMaintenanceRemoteContext;
  plan: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_derivative_rebuild_plan_guarded',
    body: { p_plan: options.plan },
  });
}

export async function readMaintenanceDerivativeRebuild(options: {
  context: DatasetMaintenanceRemoteContext;
  requestId: string;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_derivative_rebuild_read',
    body: { p_request_id: options.requestId },
  });
}

export async function applyMaintenanceAliasPlan(options: {
  context: DatasetMaintenanceRemoteContext;
  plan: JsonObject;
}): Promise<JsonObject> {
  void options;
  throw new CliError(
    'The legacy whole-plan alias RPC is private; use dataset maintenance run-protected.',
    {
      code: 'DATASET_MAINTENANCE_PROTECTED_RUN_REQUIRED',
      exitCode: 1,
      details: {
        replacement_capabilities: [
          'cmd_dataset_alias_execution_preflight_guarded',
          'cmd_dataset_alias_execution_gate_guarded',
          'cmd_dataset_alias_execution_admit_guarded',
          'cmd_dataset_alias_execution_read',
        ],
      },
    },
  );
}

export async function preflightMaintenanceFlowIdentityScope(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({ p_request: options.request });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_scope_preflight_guarded',
    body,
    minimumTimeoutMs: 130_000,
    allowDomainFailure: true,
  });
}

export async function lookupMaintenanceFlowIdentityScope(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({ p_request: options.request });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_scope_lookup',
    body,
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function rewriteMaintenanceFlowIdentityProcess(options: {
  context: DatasetMaintenanceRemoteContext;
  scopeId: string;
  request: JsonObject;
  authorization: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({
    p_scope_id: options.scopeId,
    p_request: options.request,
    p_authorization: options.authorization,
  });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_process_rewrite_guarded',
    body,
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function readMaintenanceFlowIdentityScope(options: {
  context: DatasetMaintenanceRemoteContext;
  scopeId: string;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({ p_scope_id: options.scopeId });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_scope_read',
    body,
    minimumTimeoutMs: 90_000,
    allowDomainFailure: true,
  });
}

export async function finalizeMaintenanceFlowIdentityScope(options: {
  context: DatasetMaintenanceRemoteContext;
  scopeId: string;
  request: JsonObject;
  authorization: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({
    p_scope_id: options.scopeId,
    p_request: options.request,
    p_authorization: options.authorization,
  });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_scope_finalize_guarded',
    body,
    minimumTimeoutMs: 190_000,
    allowDomainFailure: true,
  });
}

export async function recoverMaintenanceFlowIdentityScope(options: {
  context: DatasetMaintenanceRemoteContext;
  scopeId: string;
  request: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({
    p_scope_id: options.scopeId,
    p_request: options.request,
  });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_scope_recover_guarded',
    body,
    minimumTimeoutMs: 130_000,
    allowDomainFailure: true,
  });
}

export async function attestMaintenanceFlowIdentityCapture(options: {
  context: DatasetMaintenanceRemoteContext;
  request: JsonObject;
}): Promise<JsonObject> {
  const body = assertFlowIdentityWireJson({ p_request: options.request });
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_flow_identity_capture_attest_guarded',
    body,
    minimumTimeoutMs: 190_000,
    allowDomainFailure: true,
  });
}

export async function saveDraftMaintenanceRow(options: {
  context: DatasetMaintenanceRemoteContext;
  table: DatasetMaintenanceMutableTable;
  id: string;
  version: string;
  payload: JsonObject;
  modelId: string | null;
  ruleVerification: boolean | null;
  audit: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_save_draft',
    body: {
      p_table: options.table,
      p_id: options.id,
      p_version: options.version,
      p_json_ordered: options.payload,
      p_model_id: options.modelId,
      p_rule_verification: options.ruleVerification,
      p_audit: options.audit,
    },
  });
}

export async function deleteMaintenanceRow(options: {
  context: DatasetMaintenanceRemoteContext;
  table: DatasetMaintenanceMutableTable;
  id: string;
  version: string;
  audit: JsonObject;
}): Promise<JsonObject> {
  return invokeMaintenanceRpc({
    context: options.context,
    rpc: 'cmd_dataset_delete',
    body: {
      p_table: options.table,
      p_id: options.id,
      p_version: options.version,
      p_audit: options.audit,
    },
  });
}

export const __testInternals = {
  fetchJson,
  fetchJsonResponse,
  normalizeRemoteRow,
  normalizeRemoteRows,
  selectForTable,
};
