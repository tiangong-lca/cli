// data-api-relations: contacts, flows, processes, sources
// data-api-dynamic-relation-expression: table
import { fetchCompletePostgrestPages } from './dataset-maintenance-pagination.js';
import {
  fetchMaintenanceExactRows,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { buildSupabaseAuthHeaders } from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  resolveDataApiCapabilityFromUrl,
} from './supabase-data-api-contract.js';
import { deriveSupabaseFunctionsBaseUrl } from './dataset-command.js';
import {
  assertPrepareMutablePayload,
  parsePrepareReviewPoint,
  prepareFail,
  prepareObject,
  prepareUuid,
  prepareVersion,
  type PrepareEnvelope,
  type PrepareRow,
  type PrepareTable,
} from './dataset-prepare-draft-contract.js';

async function responseBody(
  context: DatasetMaintenanceRemoteContext,
  url: string,
  body?: unknown,
): Promise<{ body: unknown; contentRange: string | null }> {
  const method = body === undefined ? 'GET' : 'POST';
  const headers = {
    ...buildSupabaseAuthHeaders(context.publishable_key, context.access_token),
    'Content-Type': 'application/json',
    ...(body === undefined ? { Prefer: 'count=exact' } : {}),
  };
  const response = await context.fetch_impl(url, {
    method,
    headers:
      body === undefined
        ? applyDataApiProfileHeaders(
            headers,
            resolveDataApiCapabilityFromUrl({ url, method }),
            method,
          )
        : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(context.timeout_ms),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    prepareFail(
      'Preparation backend returned an unavailable or invalid response.',
      response.status === 404
        ? 'DATASET_PREPARE_DRAFT_CAPABILITY_UNAVAILABLE'
        : 'DATASET_PREPARE_DRAFT_RESPONSE_INVALID',
    );
  }
  if (!response.ok || (prepareObject(parsed) && parsed.ok === false)) {
    const code =
      prepareObject(parsed) && typeof parsed.code === 'string'
        ? parsed.code
        : response.status === 404
          ? 'DATASET_PREPARE_DRAFT_CAPABILITY_UNAVAILABLE'
          : 'DATASET_PREPARE_DRAFT_REMOTE_FAILED';
    prepareFail(
      'Preparation request failed; no mutation retry is permitted.',
      ['PGRST202', '42883'].includes(code) ? 'DATASET_PREPARE_DRAFT_CAPABILITY_UNAVAILABLE' : code,
      prepareObject(parsed) ? parsed.details : undefined,
    );
  }
  return { body: parsed, contentRange: response.headers.get('content-range') };
}

function row(value: unknown, id: string, actorId?: string): PrepareRow {
  if (
    !prepareObject(value) ||
    value.id !== id ||
    !prepareObject(value.json_ordered) ||
    typeof value.state_code !== 'number' ||
    (value.model_id !== undefined && value.model_id !== null && typeof value.model_id !== 'string')
  )
    prepareFail(
      'Preparation read returned an invalid exact row.',
      'DATASET_PREPARE_DRAFT_ROW_INVALID',
    );
  const result = {
    version: prepareVersion(value.version),
    userId: prepareUuid(value.user_id),
    stateCode: value.state_code,
    jsonOrdered: value.json_ordered,
    modelId: typeof value.model_id === 'string' ? value.model_id : null,
  };
  if (actorId !== undefined && (result.userId !== actorId || result.stateCode !== 0))
    prepareFail(
      'Preparation census violated its actor/state fence.',
      'DATASET_PREPARE_DRAFT_ROW_INVALID',
    );
  if (result.modelId !== null || result.stateCode === 120)
    prepareFail(
      'Model-bound and resulting Processes require their native bundle contract.',
      'LIFECYCLEMODEL_BUNDLE_REQUIRED',
    );
  return result;
}
async function readScopedPrepareRows<T extends { version: string }>(
  context: DatasetMaintenanceRemoteContext,
  table: PrepareTable,
  id: string,
  scope: 'draft' | 'review',
  parse: (value: unknown) => T,
) {
  return fetchCompletePostgrestPages({
    table,
    requestedPageSize: 1000,
    rowIdentity: (item: T) => item.version,
    fetchPage: async (offset) => {
      const url = new URL(`${context.rest_base_url}/${table}`);
      url.searchParams.set(
        'select',
        scope === 'review'
          ? 'id,version,user_id,state_code,review_id'
          : `id,version,user_id,state_code,json_ordered${table === 'processes' ? ',model_id' : ''}`,
      );
      url.searchParams.set('id', `eq.${id}`);
      url.searchParams.set('user_id', `eq.${context.account.user_id}`);
      url.searchParams.set('state_code', scope === 'review' ? 'gte.20' : 'eq.0');
      if (scope === 'review') url.searchParams.append('state_code', 'lt.100');
      url.searchParams.set('order', 'version.asc');
      url.searchParams.set('limit', '1000');
      url.searchParams.set('offset', String(offset));
      const response = await responseBody(context, url.toString());
      if (!Array.isArray(response.body))
        prepareFail(
          'Preparation census must return a JSON array.',
          'DATASET_PREPARE_DRAFT_RESPONSE_INVALID',
        );
      return {
        rows: response.body.map(parse),
        source_url: url.toString(),
        content_range: response.contentRange,
      };
    },
  });
}
export async function readPrepareCensus(
  context: DatasetMaintenanceRemoteContext,
  table: PrepareTable,
  id: string,
) {
  return readScopedPrepareRows(context, table, id, 'draft', (value) =>
    row(value, id, context.account.user_id),
  );
}
export async function readPrepareReviews(
  context: DatasetMaintenanceRemoteContext,
  table: PrepareTable,
  id: string,
) {
  return readScopedPrepareRows(context, table, id, 'review', (value) => {
    if (!prepareObject(value))
      prepareFail('Review row is invalid.', 'DATASET_PREPARE_DRAFT_ROW_INVALID');
    return parsePrepareReviewPoint(
      {
        table,
        id: value.id,
        version: value.version,
        userId: value.user_id,
        stateCode: value.state_code,
        reviewId: value.review_id,
      },
      table,
      id,
      context.account.user_id,
    );
  });
}
export async function readPrepareExact(
  context: DatasetMaintenanceRemoteContext,
  table: PrepareTable,
  id: string,
  version: string,
): Promise<PrepareRow | null> {
  const response = await fetchMaintenanceExactRows({ context, table, id, version });
  if (response.rows.length === 0) return null;
  if (response.rows.length !== 1)
    prepareFail(
      'Preparation exact read returned multiple rows.',
      'DATASET_PREPARE_DRAFT_ROW_INVALID',
    );
  const selected = response.rows[0]!;
  if (selected.version !== version)
    prepareFail('Preparation exact row version differs.', 'DATASET_PREPARE_DRAFT_ROW_INVALID');
  const result = row(selected, id);
  assertPrepareMutablePayload(table, result.jsonOrdered);
  return result;
}
export async function requestPrepareBackend(
  context: DatasetMaintenanceRemoteContext,
  envelope: PrepareEnvelope,
  statusOnly: boolean,
): Promise<unknown> {
  const endpoint = statusOnly
    ? 'app_dataset_stable_draft_request'
    : 'app_dataset_prepare_stable_draft';
  const url = `${deriveSupabaseFunctionsBaseUrl(context.rest_base_url)}/${endpoint}`;
  const response = await responseBody(context, url, {
    requestId: envelope.requestId,
    request: envelope.request,
  });
  if (
    !prepareObject(response.body) ||
    response.body.ok !== true ||
    response.body.command !==
      (statusOnly ? 'dataset_stable_draft_request' : 'dataset_prepare_stable_draft') ||
    !prepareObject(response.body.data)
  )
    prepareFail(
      'Preparation endpoint returned an invalid command envelope.',
      'DATASET_PREPARE_DRAFT_RESPONSE_INVALID',
    );
  return response.body.data;
}
