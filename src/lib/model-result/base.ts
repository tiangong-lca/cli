import { fileURLToPath } from 'node:url';
import type { ProcessSemanticContext } from '../process-semantic-validation.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CliError } from '../../shared/errors.js';
import type { FetchLike } from '../http.js';
import { readJsonInput } from '../io.js';

export type JsonObject = Record<string, unknown>;

export const DEFAULT_DATASET_VERSION = '00.00.001';
export const EPSILON = 1e-10;
export const REMOTE_PROCESS_LOOKUP_TIMEOUT_MS = 10_000;

export type ProjectionMode = 'primary-only' | 'all-subproducts';
export type PublishIntent = 'dry_run' | 'prepare_only' | 'publish';

export type LifecyclemodelResultingProcessRequest = {
  semantic_context?: ProcessSemanticContext;
  source_model: {
    id: string | null;
    version: string | null;
    name: string | null;
    json_ordered_path: string | null;
    json_ordered: JsonObject | null;
  };
  projection: {
    mode: ProjectionMode;
    process_id: string | null;
    process_version: string | null;
    metadata_overrides: JsonObject;
    attach_graph_snapshot: boolean;
    attach_graph_snapshot_uri: string | null;
  };
  process_sources: {
    process_catalog_path: string | null;
    run_dirs: string[];
    process_json_dirs: string[];
    process_json_files: string[];
    allow_remote_lookup: boolean;
  };
  publish: {
    intent: PublishIntent;
    prepare_process_payloads: boolean;
    prepare_relation_payloads: boolean;
  };
};

export type LifecyclemodelResultingProcessReport = {
  generated_at_utc: string;
  request_path: string;
  out_dir: string;
  status: string;
  qualification?: { status: string; publish_ready: boolean };
  projected_process_count: number;
  relation_count: number;
  source_model: {
    id: string;
    version: string;
    name: string;
    json_ordered_path: string | null;
    reference_to_resulting_process_id: string | null;
    reference_to_resulting_process_version: string | null;
    reference_process_instance_id: string | null;
  };
  files: {
    normalized_request: string;
    source_model_normalized: string;
    source_model_summary: string;
    projection_report: string;
    process_projection_bundle: string;
  };
};

export type RunLifecyclemodelResultingProcessOptions = {
  inputPath: string;
  outDir?: string | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
};

export type RemoteProcessLookupContext = {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
};

export type ProcessRecord = {
  processUuid: string;
  version: string;
  raw: JsonObject;
  sourceLabel: string;
  sourcePath: string | null;
  referenceExchangeInternalId: string;
  referenceFlowUuid: string;
  referenceDirection: string;
  referenceAmount: number;
  inputAmounts: Record<string, number>;
  outputAmounts: Record<string, number>;
};

export type ProcessInstance = {
  instance_id: string;
  process_id: string;
  process_version: string;
  label: string;
  multiplication_factor: number;
  reference_to_process: JsonObject;
  raw: JsonObject;
};

export type Edge = {
  edge_id: string;
  from: string;
  to: string;
  exchange_id: string | null;
  flow_uuid: string | null;
};

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ensureList<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? (value as T[]) : ([value] as T[]);
}

export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  values.forEach((value) => {
    if (!value) {
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    unique.push(value);
  });

  return unique;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function readJsonObject(filePath: string, code: string): JsonObject {
  const value = readJsonInput(filePath);
  if (!isRecord(value)) {
    throw new CliError(`Expected a JSON object file: ${filePath}`, {
      code,
      exitCode: 2,
    });
  }

  return value;
}

export function lifecyclemodelRoot(model: JsonObject): JsonObject {
  return isRecord(model.lifeCycleModelDataSet)
    ? (model.lifeCycleModelDataSet as JsonObject)
    : model;
}

export function processDatasetRoot(payload: JsonObject): JsonObject {
  if (isRecord(payload.processDataSet)) {
    return payload.processDataSet;
  }

  for (const key of ['json_ordered', 'json'] as const) {
    const nested = payload[key];
    if (isRecord(nested) && isRecord(nested.processDataSet)) {
      return nested.processDataSet;
    }
  }

  throw new CliError('Process payload does not contain processDataSet.', {
    code: 'LIFECYCLEMODEL_PROCESS_DATASET_REQUIRED',
    exitCode: 2,
  });
}

export function resolveNameField(namePayload: unknown): string | null {
  if (typeof namePayload === 'string') {
    return namePayload.trim() || null;
  }

  if (Array.isArray(namePayload)) {
    for (const item of namePayload) {
      const resolved = resolveNameField(item);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (!isRecord(namePayload)) {
    return null;
  }

  const direct = firstNonEmpty(namePayload['@index'], namePayload['#text'], namePayload.text);
  if (direct) {
    return direct;
  }

  for (const key of ['baseName', 'shortName', 'name'] as const) {
    const nested = namePayload[key];
    if (isRecord(nested)) {
      const nestedText = firstNonEmpty(nested['@index'], nested['#text'], nested.text);
      if (nestedText) {
        return nestedText;
      }
    }

    const resolved = firstNonEmpty(nested);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

export function normalizedNameInfo(namePayload: unknown, fallbackText: string): JsonObject {
  if (isRecord(namePayload) && Object.keys(namePayload).length > 0) {
    return copyJson(namePayload);
  }

  return {
    baseName: [
      {
        '@xml:lang': 'en',
        '#text': resolveNameField(namePayload) ?? fallbackText,
      },
    ],
  };
}

export function multilangFromText(enText: string, zhText: string): JsonObject[] {
  return [
    {
      '@xml:lang': 'en',
      '#text': enText,
    },
    {
      '@xml:lang': 'zh',
      '#text': zhText,
    },
  ];
}

export function modelDatasetVersion(model: JsonObject): string | null {
  const root = lifecyclemodelRoot(model);
  const administrative = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publication = isRecord(administrative.publicationAndOwnership)
    ? administrative.publicationAndOwnership
    : isRecord(administrative['common:publicationAndOwnership'])
      ? (administrative['common:publicationAndOwnership'] as JsonObject)
      : {};

  return firstNonEmpty(publication['common:dataSetVersion']);
}

export function modelIdentifier(
  model: JsonObject,
  sourceModel: LifecyclemodelResultingProcessRequest['source_model'],
): {
  id: string;
  version: string;
  name: string;
} {
  const root = lifecyclemodelRoot(model);
  const info = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  const dataInfo = isRecord(info.dataSetInformation) ? info.dataSetInformation : {};
  const modelId =
    firstNonEmpty(
      sourceModel.id,
      dataInfo['common:UUID'],
      root['@id'],
      root.id,
      dataInfo.identifierOfSubDataSet,
    ) ?? `lm-${sha256Text(JSON.stringify(model)).slice(0, 12)}`;
  const version =
    firstNonEmpty(
      sourceModel.version,
      modelDatasetVersion(model),
      root['@version'],
      root.version,
      dataInfo['@version'],
    ) ?? DEFAULT_DATASET_VERSION;
  const name =
    firstNonEmpty(sourceModel.name, resolveNameField(dataInfo.name), root.name) ?? modelId;

  return {
    id: modelId,
    version,
    name,
  };
}

export const PathSafe = {
  resolve(value: string): string | null {
    try {
      return resolveLocalPath(value, 'path');
    } catch {
      return null;
    }
  },
};

export function resolveLocalPath(value: string, fieldName: string): string {
  if (value.startsWith('file:')) {
    return fileURLToPath(value);
  }

  if (value.includes('://')) {
    throw new CliError(`${fieldName} must resolve to a local filesystem path.`, {
      code: 'LIFECYCLEMODEL_LOCAL_PATH_REQUIRED',
      exitCode: 2,
      details: value,
    });
  }

  return path.resolve(value);
}

export function toFiniteNumber(value: unknown, fieldName: string): number {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed)) {
    throw new CliError(`Expected a numeric value for ${fieldName}.`, {
      code: 'LIFECYCLEMODEL_INVALID_NUMBER',
      exitCode: 2,
      details: { fieldName, value },
    });
  }

  return parsed;
}

export function normalizeNumericOutput(value: number): number {
  const rounded = Math.abs(value) < EPSILON ? 0 : Number.parseFloat(value.toFixed(12));
  return rounded === 0 ? 0 : rounded;
}
