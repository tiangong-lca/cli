import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import { collectDatasetNameIssues } from './dataset-name-validation.js';
import type { FetchLike } from './http.js';
import {
  firstNonEmpty,
  isRecord,
  materializeDatasetRows,
  type JsonObject,
} from './dataset-local.js';
import {
  syncLifecyclemodelBundleRecord,
  type LifecyclemodelBundleWriteResult,
  type LifecyclemodelPublishMetadata,
} from './lifecyclemodel-bundle-save.js';
import { buildRunId, resolveRunLayout } from './run.js';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';

export type LifecyclemodelPayloadValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type LifecyclemodelPayloadValidationResult =
  | {
      ok: true;
      validator: string;
      issue_count: 0;
      issues: [];
    }
  | {
      ok: false;
      validator: string;
      issue_count: number;
      issues: LifecyclemodelPayloadValidationIssue[];
    };

type LifecyclemodelSaveDraftError = {
  message: string;
  code?: string;
  details?: unknown;
};

type LifecyclemodelSaveDraftCandidate = {
  id: string | null;
  version: string | null;
  payload: JsonObject;
  metadata: LifecyclemodelPublishMetadata | null;
  validation?: LifecyclemodelPayloadValidationResult;
  error?: LifecyclemodelSaveDraftError;
};

export type LifecyclemodelSaveDraftModelReport = {
  id: string | null;
  version: string | null;
  status: 'prepared' | 'executed' | 'failed';
  validation?: LifecyclemodelPayloadValidationResult;
  execution?: LifecyclemodelBundleWriteResult;
  error?: LifecyclemodelSaveDraftError;
};

export type LifecyclemodelSaveDraftReport = {
  generated_at_utc: string;
  input_path: string;
  out_dir: string;
  commit: boolean;
  mode: 'dry_run' | 'commit';
  status: 'completed' | 'completed_with_failures';
  counts: {
    selected: number;
    prepared: number;
    executed: number;
    failed: number;
  };
  files: {
    normalized_input: string;
    selected_lifecyclemodels: string;
    progress_jsonl: string;
    failures_jsonl: string;
    summary_json: string;
  };
  lifecyclemodels: LifecyclemodelSaveDraftModelReport[];
};

export type RunLifecyclemodelSaveDraftOptions = {
  inputPath: string;
  outDir?: string | null;
  commit?: boolean | null;
  rawInput?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  validateLifecyclemodelPayloadImpl?: (
    payload: JsonObject,
  ) => LifecyclemodelPayloadValidationResult;
};

const VALIDATOR_NAME = '@tiangong-lca/tidas-sdk/LifeCycleModelSchema';

function getLifecyclemodelSchema(
  sdk: { LifeCycleModelSchema?: unknown } = tidasSdk,
): SafeParseSchema {
  const schema = sdk.LifeCycleModelSchema as SafeParseSchema | undefined;
  if (!schema?.safeParse) {
    throw new Error(`${VALIDATOR_NAME} is unavailable in the published CLI runtime.`);
  }
  return schema;
}

function getLifecyclemodelFactory(
  sdk: { createLifeCycleModel?: unknown } = tidasSdk,
): SdkValidationFactory | null {
  const createLifeCycleModel = sdk.createLifeCycleModel;
  return typeof createLifeCycleModel === 'function'
    ? (createLifeCycleModel as SdkValidationFactory)
    : null;
}

export function validateLifecyclemodelPayload(
  payload: JsonObject,
  schema?: SafeParseSchema,
  createEntity?: SdkValidationFactory | null,
): LifecyclemodelPayloadValidationResult {
  const activeSchema = schema ?? getLifecyclemodelSchema();
  const activeCreateEntity =
    createEntity === undefined && schema === undefined ? getLifecyclemodelFactory() : createEntity;
  const nameIssues = collectDatasetNameIssues(payload, 'lifecyclemodel');
  const outcome = validateSchemaWithDeepFallback(activeSchema, payload, activeCreateEntity);
  if (outcome.success && nameIssues.length === 0) {
    return {
      ok: true,
      validator: VALIDATOR_NAME,
      issue_count: 0,
      issues: [],
    };
  }

  const issues = [
    ...outcome.issues.map((issue) => ({
      path: normalizeIssuePath(issue.path),
      message: issue.message ?? 'Validation failed',
      code: issue.code ?? 'custom',
    })),
    ...nameIssues,
  ];

  return {
    ok: false,
    validator: VALIDATOR_NAME,
    issue_count: issues.length,
    issues,
  };
}

function summarizeValidation(result: LifecyclemodelPayloadValidationResult): string {
  if (result.ok) {
    return 'local LifeCycleModelSchema validation passed';
  }
  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return `local LifeCycleModelSchema validation failed with ${result.issue_count} issue(s)${
    preview ? ` (${preview})` : ''
  }`;
}

function extractMetadata(row: JsonObject): LifecyclemodelPublishMetadata | null {
  const metadata: LifecyclemodelPublishMetadata = {};
  const jsonTg = isRecord(row.json_tg) ? row.json_tg : isRecord(row.jsonTg) ? row.jsonTg : null;
  if (jsonTg) {
    metadata.json_tg = jsonTg;
  }
  if (Array.isArray(row.processMutations)) {
    metadata.processMutations = row.processMutations.filter(isRecord);
  } else if (Array.isArray(row.process_mutations)) {
    metadata.processMutations = row.process_mutations.filter(isRecord);
  }
  if (typeof row.ruleVerification === 'boolean') {
    metadata.ruleVerification = row.ruleVerification;
  } else if (typeof row.rule_verification === 'boolean') {
    metadata.ruleVerification = row.rule_verification;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function candidateError(message: string): { message: string } {
  return { message };
}

function buildCandidate(
  row: JsonObject,
  payload: JsonObject,
  validate: (payload: JsonObject) => LifecyclemodelPayloadValidationResult,
): LifecyclemodelSaveDraftCandidate {
  const root = isRecord(payload.lifeCycleModelDataSet) ? payload.lifeCycleModelDataSet : payload;
  const information = isRecord(root.lifeCycleModelInformation)
    ? root.lifeCycleModelInformation
    : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  const id = firstNonEmpty(row.id, dataSetInformation['common:UUID']);
  const version = firstNonEmpty(
    row.version,
    publicationAndOwnership['common:dataSetVersion'],
    '01.01.000',
  );

  if (!id) {
    return {
      id: null,
      version,
      payload,
      metadata: extractMetadata(row),
      error: candidateError(
        'Lifecyclemodel payload missing lifeCycleModelInformation.dataSetInformation.common:UUID.',
      ),
    };
  }

  const validation = validate(payload);
  if (!validation.ok) {
    return {
      id,
      version,
      payload,
      metadata: extractMetadata(row),
      validation,
      error: candidateError(summarizeValidation(validation)),
    };
  }

  return {
    id,
    version,
    payload,
    metadata: extractMetadata(row),
    validation,
  };
}

function defaultOutDir(inputPath: string, commit: boolean, now: Date): string {
  const runId = buildRunId({
    namespace: 'lifecyclemodel_save_draft',
    operation: commit ? 'commit' : 'dry_run',
    now,
  });
  return resolveRunLayout(
    path.join(path.dirname(inputPath), 'artifacts'),
    'lifecyclemodel_save_draft',
    runId,
  ).runRoot;
}

function buildFiles(outDir: string): LifecyclemodelSaveDraftReport['files'] {
  const outputDir = path.join(outDir, 'outputs', 'save-draft-bundle');
  return {
    normalized_input: path.join(outDir, 'inputs', 'normalized-input.json'),
    selected_lifecyclemodels: path.join(outputDir, 'selected-lifecyclemodels.jsonl'),
    progress_jsonl: path.join(outputDir, 'progress.jsonl'),
    failures_jsonl: path.join(outputDir, 'failures.jsonl'),
    summary_json: path.join(outputDir, 'summary.json'),
  };
}

function compactCandidate(candidate: LifecyclemodelSaveDraftCandidate): JsonObject {
  return {
    id: candidate.id,
    version: candidate.version,
    payload: candidate.payload,
    metadata: candidate.metadata,
    ...(candidate.validation ? { validation: candidate.validation } : {}),
    ...(candidate.error ? { error: candidate.error } : {}),
  };
}

function serializeError(error: unknown): LifecyclemodelSaveDraftError {
  if (error instanceof CliError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.details === undefined || error.code === 'REMOTE_REQUEST_FAILED'
        ? {}
        : { details: error.details }),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export async function runLifecyclemodelSaveDraft(
  options: RunLifecyclemodelSaveDraftOptions,
): Promise<LifecyclemodelSaveDraftReport> {
  const now = options.now ?? new Date();
  const inputPath = path.resolve(options.inputPath);
  const commit = options.commit === true;
  const outDir = path.resolve(options.outDir ?? defaultOutDir(inputPath, commit, now));
  const validate = options.validateLifecyclemodelPayloadImpl ?? validateLifecyclemodelPayload;
  const datasetRows = materializeDatasetRows(inputPath, options.rawInput);
  const candidates = datasetRows.map((row) => buildCandidate(row.row, row.payload, validate));
  const files = buildFiles(outDir);

  if (commit && (!options.env || !options.fetchImpl)) {
    throw new CliError(
      'Lifecyclemodel save-draft commit requires env and fetch runtime bindings.',
      {
        code: 'LIFECYCLEMODEL_SAVE_DRAFT_RUNTIME_REQUIRED',
        exitCode: 2,
      },
    );
  }

  writeJsonArtifact(files.normalized_input, {
    input_kind: 'rows_file',
    input_path: inputPath,
    row_count: candidates.length,
  });
  writeJsonLinesArtifact(files.selected_lifecyclemodels, candidates.map(compactCandidate));

  const reports: LifecyclemodelSaveDraftModelReport[] = [];
  for (const candidate of candidates) {
    const report: LifecyclemodelSaveDraftModelReport = {
      id: candidate.id,
      version: candidate.version,
      status: 'prepared',
      ...(candidate.validation ? { validation: candidate.validation } : {}),
    };

    if (candidate.error) {
      report.status = 'failed';
      report.error = candidate.error;
      reports.push(report);
      continue;
    }

    if (!commit) {
      reports.push(report);
      continue;
    }

    try {
      report.execution = await syncLifecyclemodelBundleRecord({
        id: candidate.id!,
        version: candidate.version!,
        payload: candidate.payload,
        metadata: candidate.metadata,
        env: options.env!,
        fetchImpl: options.fetchImpl!,
        timeoutMs: options.timeoutMs,
      });
      report.status = 'executed';
    } catch (error) {
      report.status = 'failed';
      report.error = serializeError(error);
    }
    reports.push(report);
  }

  const failures = reports.filter((report) => report.status === 'failed');
  writeJsonLinesArtifact(files.progress_jsonl, reports);
  writeJsonLinesArtifact(files.failures_jsonl, failures);

  const report: LifecyclemodelSaveDraftReport = {
    generated_at_utc: now.toISOString(),
    input_path: inputPath,
    out_dir: outDir,
    commit,
    mode: commit ? 'commit' : 'dry_run',
    status: failures.length > 0 ? 'completed_with_failures' : 'completed',
    counts: {
      selected: candidates.length,
      prepared: reports.filter((entry) => entry.status === 'prepared').length,
      executed: reports.filter((entry) => entry.status === 'executed').length,
      failed: failures.length,
    },
    files,
    lifecyclemodels: reports,
  };
  writeJsonArtifact(files.summary_json, report);
  return report;
}

export const __testInternals = {
  buildCandidate,
  getLifecyclemodelFactory,
  getLifecyclemodelSchema,
  normalizeIssuePath,
  serializeError,
  summarizeValidation,
  validateLifecyclemodelPayload,
};
