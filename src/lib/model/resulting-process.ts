import path from 'node:path';
import { writeJsonArtifact } from '../platform/artifacts.js';
import { type FetchLike } from '../transport/http.js';
import { readJsonInput } from '../platform/io.js';
import { buildRunId, resolveRunLayout } from '../platform/run.js';
import {
  type LifecyclemodelResultingProcessReport,
  type RunLifecyclemodelResultingProcessOptions,
  uniqueStrings,
  nowIso,
  resolveNameField,
  normalizedNameInfo,
  modelIdentifier,
} from './result/base.js';
import { toBoolean, normalizeLifecyclemodelResultingProcessRequest } from './result/request.js';
import { toFiniteNumber, normalizeNumericOutput } from './result/base.js';
import {
  extractProcessInstances,
  extractEdges,
  processReferencePairs,
  parseProcessRecord,
  autoDetectProcessCatalogPath,
  autoDetectProcessJsonDirs,
  processSourceDirs,
  locateLocalProcessFile,
  loadSourceModel,
} from './result/sources.js';
import {
  referenceToResultingProcess,
  referenceProcessInstanceId,
  chooseReferenceInstance,
  cloneExchangeWithAmount,
  buildResultingProcessPayload,
} from './result/payload.js';
import { buildProjectionBundle } from './result/projection.js';
export {
  type ProjectionMode,
  type PublishIntent,
  type LifecyclemodelResultingProcessRequest,
  type LifecyclemodelResultingProcessReport,
  type RunLifecyclemodelResultingProcessOptions,
} from './result/base.js';
export { normalizeLifecyclemodelResultingProcessRequest } from './result/request.js';

export function defaultOutDir(
  requestPath: string,
  subject: string,
  now: Date = new Date(),
): string {
  const requestDir = path.dirname(path.resolve(requestPath));
  const runId = buildRunId({
    namespace: 'lifecyclemodel_resulting_process',
    subject,
    operation: 'build',
    now,
  });

  return resolveRunLayout(
    path.join(requestDir, 'artifacts'),
    'lifecyclemodel_resulting_process',
    runId,
  ).runRoot;
}

export async function runLifecyclemodelBuildResultingProcess(
  options: RunLifecyclemodelResultingProcessOptions,
): Promise<LifecyclemodelResultingProcessReport> {
  const requestPath = path.resolve(options.inputPath);
  const input = readJsonInput(requestPath);
  const normalizedRequest = normalizeLifecyclemodelResultingProcessRequest(input, {
    requestPath,
  });
  const sourceModel = loadSourceModel(normalizedRequest);
  const modelIdentity = modelIdentifier(
    sourceModel.sourceModelJson,
    normalizedRequest.source_model,
  );
  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : defaultOutDir(requestPath, modelIdentity.id, options.now);
  const projection = await buildProjectionBundle({
    request: normalizedRequest,
    sourceModelJson: sourceModel.sourceModelJson,
    modelPath: sourceModel.modelPath,
    remoteLookup: {
      env: options.env ?? process.env,
      fetchImpl: options.fetchImpl ?? (fetch as FetchLike),
    },
  });

  const files = {
    normalized_request: writeJsonArtifact(
      path.join(outDir, 'request.normalized.json'),
      normalizedRequest,
    ),
    source_model_normalized: writeJsonArtifact(
      path.join(outDir, 'source-model.normalized.json'),
      sourceModel.sourceModelJson,
    ),
    source_model_summary: writeJsonArtifact(
      path.join(outDir, 'source-model.summary.json'),
      projection.sourceModelSummary,
    ),
    projection_report: writeJsonArtifact(
      path.join(outDir, 'projection-report.json'),
      projection.report,
    ),
    process_projection_bundle: writeJsonArtifact(
      path.join(outDir, 'process-projection-bundle.json'),
      projection.bundle,
    ),
  };

  return {
    generated_at_utc: nowIso(options.now),
    request_path: requestPath,
    out_dir: outDir,
    status: String(projection.report.status),
    qualification: projection.report.qualification as { status: string; publish_ready: boolean },
    projected_process_count: 1,
    relation_count: 1,
    source_model: {
      id: projection.sourceModelSummary.id,
      version: projection.sourceModelSummary.version,
      name: projection.sourceModelSummary.name,
      json_ordered_path: projection.sourceModelSummary.json_ordered_path,
      reference_to_resulting_process_id:
        projection.sourceModelSummary.reference_to_resulting_process_id,
      reference_to_resulting_process_version:
        projection.sourceModelSummary.reference_to_resulting_process_version,
      reference_process_instance_id: projection.sourceModelSummary.reference_process_instance_id,
    },
    files,
  };
}

// Exposed for deterministic unit coverage of internal lifecyclemodel fallback logic.
export const __testInternals = {
  uniqueStrings,
  toFiniteNumber,
  normalizeNumericOutput,
  toBoolean,
  resolveNameField,
  normalizedNameInfo,
  modelIdentifier,
  extractProcessInstances,
  extractEdges,
  processReferencePairs,
  parseProcessRecord,
  autoDetectProcessCatalogPath,
  autoDetectProcessJsonDirs,
  processSourceDirs,
  locateLocalProcessFile,
  loadSourceModel,
  referenceToResultingProcess,
  referenceProcessInstanceId,
  chooseReferenceInstance,
  cloneExchangeWithAmount,
  buildResultingProcessPayload,
  buildProjectionBundle,
  defaultOutDir,
};
