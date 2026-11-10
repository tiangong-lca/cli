import { resolveLocalPath } from './base.js';
import { semanticContextFromInput } from '../process-semantic-validation.js';
import path from 'node:path';

import { CliError } from '../../shared/errors.js';
import {
  type JsonObject,
  type ProjectionMode,
  type PublishIntent,
  type LifecyclemodelResultingProcessRequest,
  isRecord,
  ensureList,
  copyJson,
  firstNonEmpty,
} from './base.js';
import { autoDetectProcessCatalogPath, autoDetectProcessJsonDirs } from './sources.js';

export function resolveInputPath(baseDir: string, value: string): string;
export function resolveInputPath(baseDir: string, value: unknown): string | null;
export function resolveInputPath(baseDir: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('file:')) {
    return trimmed;
  }

  if (trimmed.includes('://')) {
    return trimmed;
  }

  return path.resolve(baseDir, trimmed);
}

export function toBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
  }

  return Boolean(value);
}

export function normalizeStringArray(value: unknown, fieldName: string): string[] {
  const items = ensureList(value);

  return items.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new CliError(`Expected ${fieldName}[${index}] to be a non-empty string.`, {
        code: 'LIFECYCLEMODEL_INVALID_STRING_ARRAY',
        exitCode: 2,
        details: { fieldName, value: item },
      });
    }

    return item.trim();
  });
}

export function normalizeProjectionMode(value: unknown): ProjectionMode {
  const mode = firstNonEmpty(value) ?? 'primary-only';
  if (mode === 'all-subproducts') {
    throw new CliError(
      'all-subproducts is not supported yet. Use primary-only only when a single primary result meets your request.',
      {
        code: 'LIFECYCLEMODEL_PROJECTION_MODE_UNSUPPORTED',
        exitCode: 2,
      },
    );
  }
  if (mode === 'primary-only') {
    return mode;
  }

  throw new CliError('projection.mode must be primary-only or all-subproducts.', {
    code: 'LIFECYCLEMODEL_INVALID_PROJECTION_MODE',
    exitCode: 2,
    details: value,
  });
}

export function normalizePublishIntent(value: unknown): PublishIntent {
  const intent = firstNonEmpty(value) ?? 'dry_run';
  if (intent === 'dry_run' || intent === 'prepare_only' || intent === 'publish') {
    return intent;
  }

  throw new CliError('publish.intent must be dry_run, prepare_only, or publish.', {
    code: 'LIFECYCLEMODEL_INVALID_PUBLISH_INTENT',
    exitCode: 2,
    details: value,
  });
}

export function normalizeMetadataOverrides(value: unknown): JsonObject {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new CliError('projection.metadata_overrides must be a JSON object when provided.', {
      code: 'LIFECYCLEMODEL_INVALID_METADATA_OVERRIDES',
      exitCode: 2,
    });
  }

  return copyJson(value);
}

export function normalizeLifecyclemodelResultingProcessRequest(
  input: unknown,
  options: {
    requestPath: string;
  },
): LifecyclemodelResultingProcessRequest {
  if (!isRecord(input)) {
    throw new CliError('Lifecyclemodel resulting-process request must be a JSON object.', {
      code: 'LIFECYCLEMODEL_REQUEST_NOT_OBJECT',
      exitCode: 2,
    });
  }

  const baseDir = path.dirname(path.resolve(options.requestPath));
  const sourceModelRaw = isRecord(input.source_model) ? input.source_model : {};
  const projectionRaw = isRecord(input.projection) ? input.projection : {};
  const processSourcesRaw = isRecord(input.process_sources) ? input.process_sources : {};
  const publishRaw = isRecord(input.publish) ? input.publish : {};

  const normalized: LifecyclemodelResultingProcessRequest = {
    semantic_context: semanticContextFromInput(input),
    source_model: {
      id: firstNonEmpty(sourceModelRaw.id),
      version: firstNonEmpty(sourceModelRaw.version),
      name: firstNonEmpty(sourceModelRaw.name),
      json_ordered_path: resolveInputPath(baseDir, sourceModelRaw.json_ordered_path),
      json_ordered: isRecord(sourceModelRaw.json_ordered)
        ? copyJson(sourceModelRaw.json_ordered)
        : null,
    },
    projection: {
      mode: normalizeProjectionMode(projectionRaw.mode),
      process_id: firstNonEmpty(projectionRaw.process_id),
      process_version: firstNonEmpty(projectionRaw.process_version),
      metadata_overrides: normalizeMetadataOverrides(projectionRaw.metadata_overrides),
      attach_graph_snapshot: toBoolean(projectionRaw.attach_graph_snapshot, false),
      attach_graph_snapshot_uri: resolveInputPath(baseDir, projectionRaw.attach_graph_snapshot_uri),
    },
    process_sources: {
      process_catalog_path: (() => {
        const resolved = resolveInputPath(baseDir, processSourcesRaw.process_catalog_path);
        return resolved ? resolveLocalPath(resolved, 'process_sources.process_catalog_path') : null;
      })(),
      run_dirs: normalizeStringArray(processSourcesRaw.run_dirs, 'process_sources.run_dirs').map(
        (item) => resolveLocalPath(resolveInputPath(baseDir, item), 'process_sources.run_dirs'),
      ),
      process_json_dirs: normalizeStringArray(
        processSourcesRaw.process_json_dirs,
        'process_sources.process_json_dirs',
      ).map((item) =>
        resolveLocalPath(resolveInputPath(baseDir, item), 'process_sources.process_json_dirs'),
      ),
      process_json_files: normalizeStringArray(
        processSourcesRaw.process_json_files,
        'process_sources.process_json_files',
      ).map((item) =>
        resolveLocalPath(resolveInputPath(baseDir, item), 'process_sources.process_json_files'),
      ),
      allow_remote_lookup: toBoolean(
        processSourcesRaw.allow_remote_lookup ?? processSourcesRaw.allow_mcp_lookup,
        false,
      ),
    },
    publish: {
      intent: normalizePublishIntent(publishRaw.intent),
      prepare_process_payloads: toBoolean(publishRaw.prepare_process_payloads, true),
      prepare_relation_payloads: toBoolean(publishRaw.prepare_relation_payloads, true),
    },
  };

  if (
    !normalized.source_model.id &&
    !normalized.source_model.json_ordered &&
    !normalized.source_model.json_ordered_path
  ) {
    throw new CliError(
      'source_model must include at least one of id, json_ordered, or json_ordered_path.',
      {
        code: 'LIFECYCLEMODEL_SOURCE_MODEL_REQUIRED',
        exitCode: 2,
      },
    );
  }

  if (!normalized.process_sources.process_catalog_path) {
    normalized.process_sources.process_catalog_path = autoDetectProcessCatalogPath(
      normalized.source_model.json_ordered_path,
    );
  }

  if (normalized.process_sources.process_json_dirs.length === 0) {
    normalized.process_sources.process_json_dirs = autoDetectProcessJsonDirs(
      normalized.source_model.json_ordered_path,
    );
  }

  return normalized;
}
