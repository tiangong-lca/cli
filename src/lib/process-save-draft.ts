import { assertLocalizedTextLanguageUniqueness } from './dataset-localized-text.js';
import { assertProcessAllocationWriteAdmission } from './process-allocation-write-admission.js';
import { type ProcessSemanticContext } from './process-semantic-validation.js';
// data-api-relations: processes
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { getJson, postJson, requireRemoteOkPayload } from './http.js';
import {
  buildSupabaseAuthHeaders,
  createSupabaseDataClient,
  deriveSupabaseProjectBaseUrl,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapability,
} from './supabase-data-api-contract.js';
import { createSupabaseDataRuntime } from './supabase-session.js';
import {
  syncSupabaseJsonOrderedRecord,
  type SupabaseJsonOrderedWriteResult,
} from './supabase-json-ordered-write.js';

type JsonObject = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export type VisibleProcessRow = {
  id: string;
  version: string;
  user_id: string | null;
  state_code: number | null;
};

export type ProcessSaveDraftRpcResult = {
  ok: true;
  [key: string]: unknown;
};

export type ProcessStateAwareWriteResult =
  | SupabaseJsonOrderedWriteResult
  | {
      status: 'success';
      operation: 'save_draft';
      write_path: 'cmd_dataset_save_draft';
      rpc_result: ProcessSaveDraftRpcResult;
      visible_row: VisibleProcessRow;
    };

export type SyncStateAwareProcessRecordOptions = {
  id: string;
  version: string;
  payload: JsonObject;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  audit?: JsonObject;
  modelId?: string | null;
  modelVersion?: string | null;
  targetUserId?: string | null;
  semanticContext?: ProcessSemanticContext;
};

function buildVisibleRowsUrl(restBaseUrl: string, id: string, version: string): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/processes`);
  url.searchParams.set('select', 'id,version,user_id,state_code');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

function parseVisibleRows(payload: unknown, url: string): VisibleProcessRow[] {
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
      id: trimToken(item.id) ?? '',
      version: trimToken(item.version) ?? '',
      user_id: trimToken(item.user_id),
      state_code: typeof item.state_code === 'number' ? item.state_code : null,
    };
  });
}

async function exactVisibleRows(options: {
  id: string;
  version: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{
  rows: VisibleProcessRow[];
  restBaseUrl: string;
  accessToken: string;
  publishableKey: string;
}> {
  const runtime = createSupabaseDataRuntime({
    runtime: requireSupabaseRestRuntime(options.env),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const { client, restBaseUrl } = createSupabaseDataClient(
    runtime,
    options.fetchImpl,
    options.timeoutMs,
  );
  const url = buildVisibleRowsUrl(restBaseUrl, options.id, options.version);
  const payload = await runSupabaseArrayQuery(
    client
      .from('processes')
      .select('id,version,user_id,state_code')
      .eq('id', options.id)
      .eq('version', options.version),
    url,
  );

  return {
    rows: parseVisibleRows(payload, url),
    restBaseUrl,
    accessToken: await runtime.getAccessToken(),
    publishableKey: runtime.publishableKey,
  };
}

function visibleDraftRow(rows: VisibleProcessRow[]): VisibleProcessRow | null {
  return rows.find((row) => row.state_code === 0) ?? null;
}

function visibleDraftRowForTarget(
  rows: VisibleProcessRow[],
  targetUserId: string | null,
): VisibleProcessRow | null {
  if (!targetUserId) {
    return visibleDraftRow(rows);
  }
  return rows.find((row) => row.state_code === 0 && row.user_id === targetUserId) ?? null;
}

function buildCurrentUserUrl(restBaseUrl: string): string {
  return `${deriveSupabaseProjectBaseUrl(restBaseUrl)}/auth/v1/user`;
}

async function currentUserId(options: {
  restBaseUrl: string;
  publishableKey: string;
  accessToken: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<string> {
  const url = buildCurrentUserUrl(options.restBaseUrl);
  const payload = await getJson({
    url,
    headers: buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const userId = isRecord(payload) ? trimToken(payload.id) : null;
  if (!userId) {
    throw new CliError('Supabase current-user lookup succeeded without a user id.', {
      code: 'PROCESS_SAVE_DRAFT_CURRENT_USER_ID_MISSING',
      exitCode: 1,
      details: payload,
    });
  }
  return userId;
}

function assertTargetUserMatchesCurrent(options: {
  targetUserId: string | null;
  currentUserId: string;
}): void {
  if (!options.targetUserId) {
    return;
  }
  if (options.currentUserId !== options.targetUserId) {
    throw new CliError(
      `Process save-draft target user ${options.targetUserId} does not match current CLI auth user ${options.currentUserId}.`,
      {
        code: 'PROCESS_SAVE_DRAFT_TARGET_USER_MISMATCH',
        exitCode: 1,
        details: {
          target_user_id: options.targetUserId,
          current_user_id: options.currentUserId,
        },
      },
    );
  }
}

function buildUnsupportedVisibleRowError(
  id: string,
  version: string,
  rows: VisibleProcessRow[],
): CliError {
  const primaryRow = rows[0] ?? null;
  const stateCode =
    primaryRow?.state_code === null || primaryRow?.state_code === undefined
      ? 'unknown'
      : String(primaryRow.state_code);
  const visibleOwner = primaryRow?.user_id ?? 'unknown';

  return new CliError(
    `Process ${id}@${version} is already visible but cannot use save-draft because the visible row is not a current-user draft (state_code=${stateCode}, visible_owner=${visibleOwner}).`,
    {
      code: 'PUBLISH_PROCESS_SAVE_DRAFT_UNSUPPORTED_VISIBLE_ROW',
      exitCode: 1,
      details: {
        id,
        version,
        visible_rows: rows,
      },
    },
  );
}

async function saveDraft(options: {
  restBaseUrl: string;
  publishableKey: string;
  accessToken: string;
  id: string;
  version: string;
  payload: JsonObject;
  semanticContext?: ProcessSemanticContext;
  timeoutMs: number;
  fetchImpl: FetchLike;
  audit?: JsonObject;
  modelId?: string | null;
  modelVersion?: string | null;
}): Promise<ProcessSaveDraftRpcResult> {
  await assertProcessAllocationWriteAdmission(options.payload, options.semanticContext ?? {}, {
    apiBaseUrl: options.restBaseUrl,
    ...options,
  });
  assertLocalizedTextLanguageUniqueness(options.payload);
  const capability = resolveDataApiCapability({
    kind: 'rpc',
    name: 'cmd_dataset_save_draft',
  });
  const url = buildDataApiUrl(options.restBaseUrl, capability);
  const payload = requireRemoteOkPayload(
    await postJson({
      url,
      headers: applyDataApiProfileHeaders(
        {
          ...buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
          'Content-Type': 'application/json',
        },
        capability,
        'POST',
      ),
      body: {
        p_table: 'processes',
        p_id: options.id,
        p_version: options.version,
        p_json_ordered: options.payload,
        p_model_id: options.modelId ?? null,
        p_model_version: options.modelVersion ?? null,
        p_audit: options.audit ?? null,
      },
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    }),
    url,
  );

  if (!isRecord(payload) || payload.ok !== true) {
    throw new CliError(`Process save-draft RPC returned an unexpected payload for ${url}`, {
      code: 'REMOTE_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  return payload as ProcessSaveDraftRpcResult;
}

export async function syncStateAwareProcessRecord(
  options: SyncStateAwareProcessRecordOptions,
): Promise<ProcessStateAwareWriteResult> {
  assertLocalizedTextLanguageUniqueness(options.payload);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targetUserId = trimToken(options.targetUserId);
  const visible = await exactVisibleRows({
    id: options.id,
    version: options.version,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  if (targetUserId) {
    const userId = await currentUserId({
      restBaseUrl: visible.restBaseUrl,
      publishableKey: visible.publishableKey,
      accessToken: visible.accessToken,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    assertTargetUserMatchesCurrent({ targetUserId, currentUserId: userId });
  }

  const draftRow = visibleDraftRowForTarget(visible.rows, targetUserId);

  if (!draftRow) {
    if (visible.rows.length > 0) {
      throw buildUnsupportedVisibleRowError(options.id, options.version, visible.rows);
    }

    return syncSupabaseJsonOrderedRecord({
      table: 'processes',
      id: options.id,
      version: options.version,
      payload: options.payload,
      writeMode: 'upsert_current_version',
      env: options.env,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      extraData:
        options.modelId !== undefined || options.modelVersion !== undefined
          ? {
              semantic_context: options.semanticContext,
              modelId: options.modelId ?? null,
              modelVersion: options.modelVersion ?? null,
            }
          : { semantic_context: options.semanticContext },
    });
  }

  return {
    status: 'success',
    operation: 'save_draft',
    write_path: 'cmd_dataset_save_draft',
    rpc_result: await saveDraft({
      restBaseUrl: visible.restBaseUrl,
      publishableKey: visible.publishableKey,
      accessToken: visible.accessToken,
      id: options.id,
      version: options.version,
      payload: options.payload,
      semanticContext: options.semanticContext,
      timeoutMs,
      fetchImpl: options.fetchImpl,
      audit: options.audit,
      modelId: options.modelId,
      modelVersion: options.modelVersion,
    }),
    visible_row: draftRow,
  };
}

export const __testInternals = {
  buildVisibleRowsUrl,
  buildCurrentUserUrl,
  parseVisibleRows,
  visibleDraftRow,
  visibleDraftRowForTarget,
  assertTargetUserMatchesCurrent,
  buildUnsupportedVisibleRowError,
};
