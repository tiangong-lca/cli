import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { postJson, requireRemoteOkPayload } from './http.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  requireSupabaseRestRuntime,
  type SupabaseDataRuntime,
} from './supabase-client.js';
import { createSupabaseDataRuntime } from './supabase-session.js';

type JsonObject = Record<string, unknown>;

export type DatasetCommandTable =
  | 'contacts'
  | 'sources'
  | 'unitgroups'
  | 'flowproperties'
  | 'flows'
  | 'processes'
  | 'lifecyclemodels';

export type DatasetCommandTransport = {
  functionsBaseUrl: string;
  publishableKey: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
};

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

function readOptionalRuleVerification(extraData?: JsonObject): boolean | null | undefined {
  if (!extraData) {
    return undefined;
  }

  if ('ruleVerification' in extraData) {
    const value = extraData.ruleVerification;
    if (typeof value === 'boolean' || value === null) {
      return value;
    }
    return undefined;
  }

  if ('rule_verification' in extraData) {
    const value = extraData.rule_verification;
    if (typeof value === 'boolean' || value === null) {
      return value;
    }
  }

  return undefined;
}

function readOptionalModelId(
  extraData: JsonObject | undefined,
  allowNull: boolean,
): string | null | undefined {
  if (!extraData) {
    return undefined;
  }

  const value = extraData.modelId ?? extraData.model_id;
  const trimmed = trimToken(value);
  if (trimmed) {
    return trimmed;
  }

  if (allowNull && value === null) {
    return null;
  }

  return undefined;
}

function readOptionalModelVersion(extraData: JsonObject | undefined): string | null | undefined {
  if (!extraData) {
    return undefined;
  }

  const value = extraData.modelVersion ?? extraData.model_version;
  const trimmed = trimToken(value);
  if (trimmed) {
    return trimmed;
  }

  return value === null ? null : undefined;
}

function requireCommandSuccessPayload(payload: unknown, url: string): JsonObject {
  const normalized = requireRemoteOkPayload(payload, url);
  if (!isRecord(normalized) || normalized.ok !== true) {
    throw new CliError(`Dataset command returned an unexpected payload for ${url}`, {
      code: 'REMOTE_RESPONSE_INVALID',
      exitCode: 1,
      details: normalized,
    });
  }

  return normalized;
}

async function invokeDatasetCommand(options: {
  transport: DatasetCommandTransport;
  commandName: 'app_dataset_create' | 'app_dataset_save_draft' | 'app_dataset_delete';
  body: JsonObject;
  beforeDispatch?: () => void;
}): Promise<JsonObject> {
  const url = `${options.transport.functionsBaseUrl}/${options.commandName}`;
  try {
    options.beforeDispatch?.();
  } catch {
    throw new CliError('Dataset command was blocked before request dispatch.', {
      code: 'DATASET_COMMAND_BEFORE_DISPATCH_FAILED',
      exitCode: 1,
    });
  }
  return requireCommandSuccessPayload(
    await postJson({
      url,
      headers: {
        ...buildSupabaseAuthHeaders(
          options.transport.publishableKey,
          options.transport.accessToken,
        ),
        'Content-Type': 'application/json',
      },
      body: options.body,
      timeoutMs: options.transport.timeoutMs,
      fetchImpl: options.transport.fetchImpl,
    }),
    url,
  );
}

export function deriveSupabaseFunctionsBaseUrl(apiBaseUrl: string): string {
  return `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/functions/v1`;
}

export async function buildDatasetCommandTransport(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<DatasetCommandTransport> {
  return {
    functionsBaseUrl: deriveSupabaseFunctionsBaseUrl(options.runtime.apiBaseUrl),
    publishableKey: options.runtime.publishableKey,
    accessToken: await options.runtime.getAccessToken(),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  };
}

export async function resolveDatasetCommandTransport(options: {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<DatasetCommandTransport> {
  return buildDatasetCommandTransport({
    runtime: createSupabaseDataRuntime({
      runtime: requireSupabaseRestRuntime(options.env),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    }),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

export async function createDatasetRecord(options: {
  transport: DatasetCommandTransport;
  table: DatasetCommandTable;
  id: string;
  payload: JsonObject;
  extraData?: JsonObject;
  beforeDispatch?: () => void;
}): Promise<JsonObject> {
  const body: JsonObject = {
    table: options.table,
    id: options.id,
    jsonOrdered: options.payload,
  };
  const modelId = readOptionalModelId(options.extraData, true);
  if (modelId !== undefined) {
    body.modelId = modelId;
  }
  const modelVersion = readOptionalModelVersion(options.extraData);
  if (modelVersion !== undefined) {
    body.modelVersion = modelVersion;
  }
  const ruleVerification = readOptionalRuleVerification(options.extraData);
  if (ruleVerification !== undefined) {
    body.ruleVerification = ruleVerification;
  }

  return invokeDatasetCommand({
    transport: options.transport,
    commandName: 'app_dataset_create',
    body,
    beforeDispatch: options.beforeDispatch,
  });
}

export async function saveDraftDatasetRecord(options: {
  transport: DatasetCommandTransport;
  table: DatasetCommandTable;
  id: string;
  version: string;
  payload: JsonObject;
  /**
   * Complete before image read fresh in this run. When present, the platform routes the save
   * through its guarded draft-save path and rejects a stale or changed before content; when it is
   * absent the legacy save behaviour is unchanged. Never a hash: the stored JSON value itself.
   */
  expectedJsonOrdered?: JsonObject;
  extraData?: JsonObject;
  beforeDispatch?: () => void;
}): Promise<JsonObject> {
  const body: JsonObject = {
    table: options.table,
    id: options.id,
    version: options.version,
    jsonOrdered: options.payload,
  };
  if (options.expectedJsonOrdered !== undefined) {
    body.expectedJsonOrdered = options.expectedJsonOrdered;
  }
  const modelId = readOptionalModelId(options.extraData, false);
  if (modelId !== undefined) {
    body.modelId = modelId;
  }
  const modelVersion = readOptionalModelVersion(options.extraData);
  if (modelVersion !== undefined) {
    body.modelVersion = modelVersion;
  }
  const ruleVerification = readOptionalRuleVerification(options.extraData);
  if (ruleVerification !== undefined) {
    body.ruleVerification = ruleVerification;
  }

  return invokeDatasetCommand({
    transport: options.transport,
    commandName: 'app_dataset_save_draft',
    body,
    beforeDispatch: options.beforeDispatch,
  });
}

export async function deleteDatasetRecord(options: {
  transport: DatasetCommandTransport;
  table: DatasetCommandTable;
  id: string;
  version: string;
}): Promise<JsonObject> {
  return invokeDatasetCommand({
    transport: options.transport,
    commandName: 'app_dataset_delete',
    body: {
      table: options.table,
      id: options.id,
      version: options.version,
    },
  });
}

export const __testInternals = {
  deriveSupabaseFunctionsBaseUrl,
  readOptionalModelId,
  readOptionalModelVersion,
  readOptionalRuleVerification,
};
