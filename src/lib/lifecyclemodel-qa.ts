import { collectDatasetNameIssues, type DatasetNameIssue } from './dataset-name-validation.js';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  readJsonArtifact,
  writeJsonArtifact,
  writeJsonLinesArtifact,
  writeTextArtifact,
} from './artifacts.js';
import { materializeDatasetRows } from './dataset-local.js';
import { CliError } from './errors.js';
import type { ValidationIssue } from './validation.js';

type JsonObject = Record<string, unknown>;

type ModelEntry = {
  runName: string;
  modelFiles: string[];
  summaryPath: string;
  connectionsPath: string;
  processCatalogPath: string;
  inputMode: 'run_dir' | 'rows_file';
};

type ModelFileReviewInfo = {
  nameIssues: DatasetNameIssue[];
  modelFile: string;
  modelUuid: string;
  modelVersion: string;
  referenceProcessInternalId: string | null;
  resultingProcessUuid: string | null;
  processInstanceCount: number;
  zeroMultiplicationFactorCount: number;
};

type LifecyclemodelValidationAggregate = {
  ok: boolean | null;
  reportPath: string | null;
  modelReports: Map<string, LifecyclemodelModelValidationSummary>;
};

type LifecyclemodelModelValidationSummary = {
  ok: boolean | null;
  reportFile: string | null;
  engineCount: number;
  issues: ValidationIssue[];
};

type SeverityCounts = {
  error: number;
  warning: number;
  info: number;
};

export type LifecyclemodelQaFinding = {
  run_name: string;
  model_file: string | null;
  severity: 'error' | 'warning' | 'info';
  rule_id: string;
  source: 'validation' | 'qa';
  message: string;
  evidence: JsonObject;
};

export type LifecyclemodelQaModelSummary = {
  run_name: string;
  model_files: string[];
  model_uuids: string[];
  model_versions: string[];
  reference_process_uuids: string[];
  reference_process_internal_ids: string[];
  resulting_process_uuids: string[];
  summary_process_count: number | null;
  process_instance_count: number;
  summary_edge_count: number | null;
  connection_count: number | null;
  process_catalog_count: number | null;
  multiplication_factor_count: number;
  zero_multiplication_factor_count: number;
  validation: {
    available: boolean;
    ok: boolean | null;
    report_file: string | null;
    engine_count: number;
    issue_count: number;
  };
  artifacts: {
    summary: string | null;
    connections: string | null;
    process_catalog: string | null;
  };
  finding_count: number;
  severity_counts: SeverityCounts;
};

export type LifecyclemodelQaReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed_local_lifecyclemodel_qa';
  run_id: string;
  run_root: string;
  rows_file: string;
  input_mode: 'run_dir' | 'rows_file';
  out_dir: string;
  logic_version: string;
  model_count: number;
  finding_count: number;
  severity_counts: SeverityCounts;
  validation: {
    available: boolean;
    ok: boolean | null;
    report: string | null;
  };
  files: {
    run_manifest: string;
    invocation_index: string;
    qa_input_summary: string | null;
    validation_report: string | null;
    model_summaries: string;
    findings: string;
    summary: string;
    qa_zh: string;
    qa_en: string;
    timing: string;
    report: string;
  };
  model_summaries: LifecyclemodelQaModelSummary[];
  next_actions: string[];
};

export type RunLifecyclemodelQaOptions = {
  runDir?: string;
  rowsFile?: string;
  outDir: string;
  startTs?: string;
  endTs?: string;
  logicVersion?: string;
  now?: () => Date;
  cwd?: string;
};

export type LifecyclemodelQaLayout = {
  runId: string;
  runRoot: string;
  rowsFile: string;
  inputMode: 'run_dir' | 'rows_file';
  outDir: string;
  modelsDir: string;
  reportsDir: string;
  manifestsDir: string;
  runManifestPath: string;
  invocationIndexPath: string;
  validationReportPath: string;
  qaInputSummaryPath: string | null;
  modelSummariesPath: string;
  findingsPath: string;
  summaryPath: string;
  reviewZhPath: string;
  reviewEnPath: string;
  timingPath: string;
  reportPath: string;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function deepGet(value: unknown, pathParts: string[]): unknown {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function listify(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toNonNegativeInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  ];
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeFileName(value: unknown): string {
  return (
    String(value ?? 'missing')
      .replace(/[^A-Za-z0-9._-]+/gu, '_')
      .replace(/^_+|_+$/gu, '') || 'missing'
  );
}

function emptySeverityCounts(): SeverityCounts {
  return {
    error: 0,
    warning: 0,
    info: 0,
  };
}

function severityCounts(findings: LifecyclemodelQaFinding[]): SeverityCounts {
  return findings.reduce<SeverityCounts>((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, emptySeverityCounts());
}

function readRequiredJsonObject(
  filePath: string,
  missingCode: string,
  invalidCode: string,
  label: string,
): JsonObject {
  if (!existsSync(filePath)) {
    throw new CliError(`Required lifecyclemodel ${label} artifact not found: ${filePath}`, {
      code: missingCode,
      exitCode: 2,
      details: { filePath, label },
    });
  }

  const value = readJsonArtifact(filePath);
  if (!isRecord(value)) {
    throw new CliError(`Expected lifecyclemodel ${label} artifact JSON object: ${filePath}`, {
      code: invalidCode,
      exitCode: 2,
      details: { filePath, label },
    });
  }

  return value;
}

function readOptionalJsonObject(
  filePath: string,
  invalidCode: string,
  label: string,
): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const value = readJsonArtifact(filePath);
  if (!isRecord(value)) {
    throw new CliError(`Expected lifecyclemodel ${label} artifact JSON object: ${filePath}`, {
      code: invalidCode,
      exitCode: 2,
      details: { filePath, label },
    });
  }

  return value;
}

function readOptionalJsonArray(
  filePath: string,
  invalidCode: string,
  label: string,
): unknown[] | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const value = readJsonArtifact(filePath);
  if (!Array.isArray(value)) {
    throw new CliError(`Expected lifecyclemodel ${label} artifact JSON array: ${filePath}`, {
      code: invalidCode,
      exitCode: 2,
      details: { filePath, label },
    });
  }

  return value;
}

function buildLayout(options: {
  runRoot: string;
  outDir: string;
  rowsFile?: string;
  inputMode?: 'run_dir' | 'rows_file';
}): LifecyclemodelQaLayout {
  const runRoot = options.runRoot;
  const outDir = options.outDir;
  const runId = path.basename(runRoot);
  return {
    runId,
    runRoot,
    rowsFile: options.rowsFile ?? '',
    inputMode: options.inputMode ?? 'run_dir',
    outDir,
    modelsDir: path.join(runRoot, 'models'),
    reportsDir: path.join(runRoot, 'reports'),
    manifestsDir: path.join(runRoot, 'manifests'),
    runManifestPath: path.join(runRoot, 'manifests', 'run-manifest.json'),
    invocationIndexPath: path.join(runRoot, 'manifests', 'invocation-index.json'),
    validationReportPath: path.join(
      runRoot,
      'reports',
      'lifecyclemodel-validate-build-report.json',
    ),
    qaInputSummaryPath:
      options.inputMode === 'rows_file' ? path.join(outDir, 'qa_input_summary.json') : null,
    modelSummariesPath: path.join(outDir, 'model_summaries.jsonl'),
    findingsPath: path.join(outDir, 'findings.jsonl'),
    summaryPath: path.join(outDir, 'lifecyclemodel_qa_summary.json'),
    reviewZhPath: path.join(outDir, 'lifecyclemodel_qa_zh.md'),
    reviewEnPath: path.join(outDir, 'lifecyclemodel_qa_en.md'),
    timingPath: path.join(outDir, 'lifecyclemodel_qa_timing.md'),
    reportPath: path.join(outDir, 'lifecyclemodel_qa_report.json'),
  };
}

function resolveLayout(options: RunLifecyclemodelQaOptions): LifecyclemodelQaLayout {
  const outDir = nonEmptyString(options.outDir);
  if (!outDir) {
    throw new CliError('Missing required --out-dir for qa lifecyclemodel.', {
      code: 'LIFECYCLEMODEL_QA_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  const rowsFile = nonEmptyString(options.rowsFile);
  const runDir = nonEmptyString(options.runDir);
  if (rowsFile && runDir) {
    throw new CliError('Use either --rows-file or --run-dir for qa lifecyclemodel, not both.', {
      code: 'LIFECYCLEMODEL_QA_INPUT_MODE_CONFLICT',
      exitCode: 2,
    });
  }

  if (rowsFile) {
    const resolvedRowsFile = path.resolve(rowsFile);
    return buildLayout({
      runRoot: path.join(
        path.resolve(outDir),
        'qa-input',
        sanitizeFileName(path.basename(rowsFile)),
      ),
      rowsFile: resolvedRowsFile,
      inputMode: 'rows_file',
      outDir: path.resolve(outDir),
    });
  }
  if (!runDir) {
    throw new CliError('Missing required --rows-file or --run-dir for qa lifecyclemodel.', {
      code: 'LIFECYCLEMODEL_QA_RUN_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  return buildLayout({
    runRoot: path.resolve(runDir),
    outDir: path.resolve(outDir),
    inputMode: 'run_dir',
  });
}

function ensureRunRootExists(layout: LifecyclemodelQaLayout): void {
  if (!existsSync(layout.runRoot)) {
    throw new CliError(`lifecyclemodel QA run root not found: ${layout.runRoot}`, {
      code: 'LIFECYCLEMODEL_QA_RUN_NOT_FOUND',
      exitCode: 2,
    });
  }
}

function readRequiredRunManifest(layout: LifecyclemodelQaLayout): JsonObject {
  const manifest = readRequiredJsonObject(
    layout.runManifestPath,
    'LIFECYCLEMODEL_QA_RUN_MANIFEST_MISSING',
    'LIFECYCLEMODEL_QA_RUN_MANIFEST_INVALID',
    'run-manifest',
  );

  const manifestRunId = nonEmptyString(manifest.runId);
  if (manifestRunId && manifestRunId !== layout.runId) {
    throw new CliError(`lifecyclemodel QA run manifest runId mismatch: ${layout.runManifestPath}`, {
      code: 'LIFECYCLEMODEL_QA_RUN_MANIFEST_MISMATCH',
      exitCode: 2,
      details: {
        expected: layout.runId,
        actual: manifestRunId,
      },
    });
  }

  return manifest;
}

function readInvocationIndex(layout: LifecyclemodelQaLayout): JsonObject {
  if (!existsSync(layout.invocationIndexPath)) {
    return {
      schema_version: 1,
      invocations: [],
    };
  }

  const value = readJsonArtifact(layout.invocationIndexPath);
  if (!isRecord(value)) {
    throw new CliError(
      `Expected lifecyclemodel QA invocation index JSON object: ${layout.invocationIndexPath}`,
      {
        code: 'LIFECYCLEMODEL_QA_INVOCATION_INDEX_INVALID',
        exitCode: 2,
      },
    );
  }

  if (value.invocations === undefined) {
    return {
      schema_version: 1,
      invocations: [],
    };
  }

  if (!Array.isArray(value.invocations)) {
    throw new CliError(
      `Expected lifecyclemodel QA invocation index to contain an invocations array: ${layout.invocationIndexPath}`,
      {
        code: 'LIFECYCLEMODEL_QA_INVOCATION_INDEX_INVALID',
        exitCode: 2,
      },
    );
  }

  return value;
}

function discoverModelEntries(layout: LifecyclemodelQaLayout): ModelEntry[] {
  const runNames = existsSync(layout.modelsDir) ? readdirSync(layout.modelsDir).sort() : [];
  const entries = runNames.flatMap((runName) => {
    const lifecyclemodelsDir = path.join(
      layout.modelsDir,
      runName,
      'tidas_bundle',
      'lifecyclemodels',
    );
    if (!existsSync(lifecyclemodelsDir)) {
      return [];
    }

    const modelFiles = readdirSync(lifecyclemodelsDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => path.join(lifecyclemodelsDir, entry));

    if (modelFiles.length === 0) {
      throw new CliError(
        `lifecyclemodel QA found a bundle without lifecyclemodel JSON files: ${lifecyclemodelsDir}`,
        {
          code: 'LIFECYCLEMODEL_QA_MODELS_EMPTY',
          exitCode: 2,
        },
      );
    }

    return [
      {
        runName,
        modelFiles,
        summaryPath: path.join(layout.modelsDir, runName, 'summary.json'),
        connectionsPath: path.join(layout.modelsDir, runName, 'connections.json'),
        processCatalogPath: path.join(layout.modelsDir, runName, 'process-catalog.json'),
        inputMode: layout.inputMode,
      },
    ];
  });

  if (entries.length === 0) {
    throw new CliError(
      `lifecyclemodel QA run does not contain any model bundles: ${layout.modelsDir}`,
      {
        code: 'LIFECYCLEMODEL_QA_MODELS_NOT_FOUND',
        exitCode: 2,
      },
    );
  }

  return entries;
}

function materializeRowsFile(layout: LifecyclemodelQaLayout): {
  invocationIndex: JsonObject;
  validationAggregate: LifecyclemodelValidationAggregate;
  modelEntries: ModelEntry[];
} {
  if (!layout.rowsFile || !existsSync(layout.rowsFile)) {
    throw new CliError(`Lifecyclemodel QA rows file not found: ${layout.rowsFile}`, {
      code: 'LIFECYCLEMODEL_QA_ROWS_FILE_NOT_FOUND',
      exitCode: 2,
      details: { rowsFile: layout.rowsFile },
    });
  }

  const rows = materializeDatasetRows(layout.rowsFile);
  const entries: ModelEntry[] = [];
  writeJsonArtifact(layout.runManifestPath, {
    schemaVersion: 1,
    runId: layout.runId,
    input_mode: 'rows_file',
    rows_file: layout.rowsFile,
    row_count: rows.length,
  });
  writeJsonArtifact(layout.invocationIndexPath, {
    schema_version: 1,
    invocations: [],
  });

  rows.forEach((row) => {
    if (row.kind && row.kind !== 'lifecyclemodel') {
      throw new CliError(
        `Expected lifecyclemodel row at index ${row.index}; detected ${row.kind}.`,
        {
          code: 'LIFECYCLEMODEL_QA_ROWS_FILE_KIND_MISMATCH',
          exitCode: 2,
          details: { index: row.index, detectedKind: row.kind },
        },
      );
    }

    const runName = sanitizeFileName(row.id ?? `row-${row.index + 1}`);
    const modelFile = path.join(
      layout.modelsDir,
      runName,
      'tidas_bundle',
      'lifecyclemodels',
      `${runName}.json`,
    );
    writeJsonArtifact(modelFile, row.payload);
    entries.push({
      runName,
      modelFiles: [modelFile],
      summaryPath: path.join(layout.modelsDir, runName, 'summary.json'),
      connectionsPath: path.join(layout.modelsDir, runName, 'connections.json'),
      processCatalogPath: path.join(layout.modelsDir, runName, 'process-catalog.json'),
      inputMode: 'rows_file',
    });
  });

  if (layout.qaInputSummaryPath) {
    writeJsonArtifact(layout.qaInputSummaryPath, {
      input_mode: 'rows_file',
      rows_file: layout.rowsFile,
      run_root: layout.runRoot,
      materialized_lifecyclemodel_count: entries.length,
      materialized_models_dir: layout.modelsDir,
    });
  }

  return {
    invocationIndex: {
      schema_version: 1,
      invocations: [],
    },
    validationAggregate: {
      ok: null,
      reportPath: null,
      modelReports: new Map(),
    },
    modelEntries: entries,
  };
}

function normalizeValidationIssue(raw: unknown): ValidationIssue {
  if (!isRecord(raw)) {
    return {
      issue_code: 'validation_issue',
      severity: 'error',
      category: 'unknown',
      file_path: '<unknown>',
      message: String(raw),
      location: '<root>',
      context: {},
    };
  }

  const severity =
    raw.severity === 'warning' || raw.severity === 'info' || raw.severity === 'error'
      ? raw.severity
      : 'error';

  return {
    issue_code: nonEmptyString(raw.issue_code) ?? 'validation_issue',
    severity,
    category: nonEmptyString(raw.category) ?? 'unknown',
    file_path: nonEmptyString(raw.file_path) ?? '<unknown>',
    message: nonEmptyString(raw.message) ?? JSON.stringify(raw),
    location: nonEmptyString(raw.location) ?? '<root>',
    context: isRecord(raw.context) ? raw.context : {},
  };
}

function collectValidationIssues(validation: JsonObject): ValidationIssue[] {
  const executionReports = Array.isArray(validation.reports) ? validation.reports : [];
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];

  executionReports.forEach((report) => {
    if (!isRecord(report) || !isRecord(report.report)) {
      return;
    }

    const rawIssues = Array.isArray(report.report.issues) ? report.report.issues : [];
    rawIssues.forEach((rawIssue) => {
      const issue = normalizeValidationIssue(rawIssue);
      const key = JSON.stringify([
        issue.issue_code,
        issue.severity,
        issue.category,
        issue.file_path,
        issue.message,
        issue.location,
      ]);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      issues.push(issue);
    });
  });

  return issues;
}

function readValidationAggregate(
  layout: LifecyclemodelQaLayout,
): LifecyclemodelValidationAggregate {
  const aggregate = readOptionalJsonObject(
    layout.validationReportPath,
    'LIFECYCLEMODEL_QA_VALIDATION_REPORT_INVALID',
    'validate-build report',
  );

  if (!aggregate) {
    return {
      ok: null,
      reportPath: null,
      modelReports: new Map(),
    };
  }

  if (aggregate.model_reports !== undefined && !Array.isArray(aggregate.model_reports)) {
    throw new CliError(
      `Expected lifecyclemodel validate-build report to contain a model_reports array: ${layout.validationReportPath}`,
      {
        code: 'LIFECYCLEMODEL_QA_VALIDATION_REPORT_INVALID',
        exitCode: 2,
      },
    );
  }

  const modelReports = new Map<string, LifecyclemodelModelValidationSummary>();
  for (const rawEntry of Array.isArray(aggregate.model_reports) ? aggregate.model_reports : []) {
    if (!isRecord(rawEntry)) {
      throw new CliError(
        `Expected lifecyclemodel validate-build model report entry JSON object: ${layout.validationReportPath}`,
        {
          code: 'LIFECYCLEMODEL_QA_VALIDATION_REPORT_INVALID',
          exitCode: 2,
        },
      );
    }

    const runName = nonEmptyString(rawEntry.run_name);
    if (!runName || !isRecord(rawEntry.validation)) {
      throw new CliError(
        `Expected lifecyclemodel validate-build model report entry to contain run_name and validation: ${layout.validationReportPath}`,
        {
          code: 'LIFECYCLEMODEL_QA_VALIDATION_REPORT_INVALID',
          exitCode: 2,
        },
      );
    }

    const validation = rawEntry.validation;
    const executionReports = Array.isArray(validation.reports) ? validation.reports : [];
    modelReports.set(runName, {
      ok: typeof validation.ok === 'boolean' ? validation.ok : null,
      reportFile: nonEmptyString(rawEntry.report_file),
      engineCount: executionReports.length,
      issues: collectValidationIssues(validation),
    });
  }

  return {
    ok: typeof aggregate.ok === 'boolean' ? aggregate.ok : null,
    reportPath: layout.validationReportPath,
    modelReports,
  };
}

function modelRoot(value: JsonObject): JsonObject {
  return isRecord(value.lifeCycleModelDataSet)
    ? (value.lifeCycleModelDataSet as JsonObject)
    : value;
}

function readModelFileReviewInfo(filePath: string): ModelFileReviewInfo {
  const payload = readJsonArtifact(filePath);
  if (!isRecord(payload)) {
    throw new CliError(`Expected lifecyclemodel QA payload JSON object: ${filePath}`, {
      code: 'LIFECYCLEMODEL_QA_MODEL_INVALID',
      exitCode: 2,
    });
  }

  const root = modelRoot(payload);
  const processInstances = listify(
    deepGet(root, ['lifeCycleModelInformation', 'technology', 'processes', 'processInstance']),
  ).filter(isRecord);
  const zeroMultiplicationFactorCount = processInstances.filter(
    (instance) => toNumber(instance['@multiplicationFactor']) === 0,
  ).length;

  return {
    nameIssues: collectDatasetNameIssues(payload, 'lifecyclemodel'),
    modelFile: filePath,
    modelUuid:
      nonEmptyString(
        deepGet(root, ['lifeCycleModelInformation', 'dataSetInformation', 'common:UUID']),
      ) ?? path.basename(filePath),
    modelVersion:
      nonEmptyString(
        deepGet(root, [
          'administrativeInformation',
          'publicationAndOwnership',
          'common:dataSetVersion',
        ]),
      ) ?? 'unknown',
    referenceProcessInternalId: nonEmptyString(
      deepGet(root, [
        'lifeCycleModelInformation',
        'quantitativeReference',
        'referenceToReferenceProcess',
      ]),
    ),
    resultingProcessUuid: nonEmptyString(
      deepGet(root, [
        'lifeCycleModelInformation',
        'dataSetInformation',
        'referenceToResultingProcess',
        '@refObjectId',
      ]),
    ),
    processInstanceCount: processInstances.length,
    zeroMultiplicationFactorCount,
  };
}

function makeFinding(
  runName: string,
  modelFile: string | null,
  severity: LifecyclemodelQaFinding['severity'],
  ruleId: string,
  source: LifecyclemodelQaFinding['source'],
  message: string,
  evidence: JsonObject,
): LifecyclemodelQaFinding {
  return {
    run_name: runName,
    model_file: modelFile,
    severity,
    rule_id: ruleId,
    source,
    message,
    evidence,
  };
}

function buildModelReview(
  entry: ModelEntry,
  validationAggregate: LifecyclemodelValidationAggregate,
): {
  summary: LifecyclemodelQaModelSummary;
  findings: LifecyclemodelQaFinding[];
} {
  const summaryArtifact = readOptionalJsonObject(
    entry.summaryPath,
    'LIFECYCLEMODEL_QA_SUMMARY_INVALID',
    'summary',
  );
  const connections = readOptionalJsonArray(
    entry.connectionsPath,
    'LIFECYCLEMODEL_QA_CONNECTIONS_INVALID',
    'connections',
  );
  const processCatalog = readOptionalJsonArray(
    entry.processCatalogPath,
    'LIFECYCLEMODEL_QA_PROCESS_CATALOG_INVALID',
    'process-catalog',
  );
  const modelFileInfos = entry.modelFiles.map((modelFile) => readModelFileReviewInfo(modelFile));
  const validation = validationAggregate.modelReports.get(entry.runName) ?? {
    ok: null,
    reportFile: null,
    engineCount: 0,
    issues: [],
  };

  const findings: LifecyclemodelQaFinding[] = [];
  for (const info of modelFileInfos) {
    for (const issue of info.nameIssues) {
      findings.push(
        makeFinding(entry.runName, info.modelFile, 'error', issue.code, 'qa', issue.message, {
          path: issue.path,
        }),
      );
    }
  }
  validation.issues.forEach((issue) => {
    findings.push(
      makeFinding(
        entry.runName,
        issue.file_path,
        issue.severity,
        `validation:${issue.issue_code}`,
        'validation',
        issue.message,
        {
          category: issue.category,
          location: issue.location,
          context: issue.context,
        },
      ),
    );
  });

  const modelUuids = uniqueStrings(modelFileInfos.map((info) => info.modelUuid));
  const modelVersions = uniqueStrings(modelFileInfos.map((info) => info.modelVersion));
  const resultingProcessUuids = uniqueStrings(
    modelFileInfos.map((info) => info.resultingProcessUuid),
  );
  const referenceProcessInternalIds = uniqueStrings(
    modelFileInfos.map((info) => info.referenceProcessInternalId),
  );
  const referenceProcessUuids = uniqueStrings([
    nonEmptyString(summaryArtifact?.reference_process_uuid),
  ]);
  const processInstanceCount = modelFileInfos.reduce(
    (sum, info) => sum + info.processInstanceCount,
    0,
  );
  const zeroMultiplicationFactorCount = modelFileInfos.reduce(
    (sum, info) => sum + info.zeroMultiplicationFactorCount,
    0,
  );
  const summaryProcessCount = toNonNegativeInteger(summaryArtifact?.process_count);
  const summaryEdgeCount = toNonNegativeInteger(summaryArtifact?.edge_count);
  const multiplicationFactors = isRecord(summaryArtifact?.multiplication_factors)
    ? (summaryArtifact?.multiplication_factors as JsonObject)
    : null;
  const multiplicationFactorCount = multiplicationFactors
    ? Object.keys(multiplicationFactors).length
    : 0;

  if (entry.inputMode === 'run_dir' && !summaryArtifact) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'missing_model_summary',
        'qa',
        'Model bundle is missing summary.json generated by lifecyclemodel auto-build.',
        {
          summary_path: entry.summaryPath,
        },
      ),
    );
  }

  if (entry.inputMode === 'run_dir' && !connections) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'missing_connections_artifact',
        'qa',
        'Model bundle is missing connections.json generated by lifecyclemodel auto-build.',
        {
          connections_path: entry.connectionsPath,
        },
      ),
    );
  }

  if (entry.inputMode === 'run_dir' && !processCatalog) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'missing_process_catalog',
        'qa',
        'Model bundle is missing process-catalog.json generated by lifecyclemodel auto-build.',
        {
          process_catalog_path: entry.processCatalogPath,
        },
      ),
    );
  }

  if (entry.inputMode === 'run_dir' && referenceProcessUuids.length === 0) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'missing_reference_process_uuid',
        'qa',
        'QA could not resolve reference_process_uuid from summary.json.',
        {
          summary_path: summaryArtifact ? entry.summaryPath : null,
        },
      ),
    );
  }

  if (resultingProcessUuids.length === 0) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'missing_resulting_process_ref',
        'qa',
        'QA could not resolve referenceToResultingProcess from the lifecyclemodel payload.',
        {
          model_files: entry.modelFiles,
        },
      ),
    );
  }

  if (processInstanceCount === 0) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'error',
        'empty_process_instances',
        'qa',
        'Lifecyclemodel payload does not contain any processInstance entries.',
        {
          model_files: entry.modelFiles,
        },
      ),
    );
  }

  if (summaryProcessCount !== null && summaryProcessCount !== processInstanceCount) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'process_count_mismatch',
        'qa',
        'summary.json process_count does not match the number of processInstance entries in the payload.',
        {
          summary_process_count: summaryProcessCount,
          process_instance_count: processInstanceCount,
        },
      ),
    );
  }

  if (connections && summaryEdgeCount !== null && connections.length !== summaryEdgeCount) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'edge_count_mismatch',
        'qa',
        'summary.json edge_count does not match the connections.json row count.',
        {
          summary_edge_count: summaryEdgeCount,
          connection_count: connections.length,
        },
      ),
    );
  }

  if (processCatalog && processCatalog.length !== processInstanceCount) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'process_catalog_count_mismatch',
        'qa',
        'process-catalog.json row count does not match the number of processInstance entries in the payload.',
        {
          process_catalog_count: processCatalog.length,
          process_instance_count: processInstanceCount,
        },
      ),
    );
  }

  if (
    summaryArtifact &&
    multiplicationFactors &&
    multiplicationFactorCount !== processInstanceCount
  ) {
    findings.push(
      makeFinding(
        entry.runName,
        entry.modelFiles[0] ?? null,
        'warning',
        'multiplication_factor_count_mismatch',
        'qa',
        'summary.json multiplication_factors count does not match the number of processInstance entries in the payload.',
        {
          multiplication_factor_count: multiplicationFactorCount,
          process_instance_count: processInstanceCount,
        },
      ),
    );
  }

  const counts = severityCounts(findings);
  return {
    summary: {
      run_name: entry.runName,
      model_files: entry.modelFiles,
      model_uuids: modelUuids,
      model_versions: modelVersions,
      reference_process_uuids: referenceProcessUuids,
      reference_process_internal_ids: referenceProcessInternalIds,
      resulting_process_uuids: resultingProcessUuids,
      summary_process_count: summaryProcessCount,
      process_instance_count: processInstanceCount,
      summary_edge_count: summaryEdgeCount,
      connection_count: connections ? connections.length : null,
      process_catalog_count: processCatalog ? processCatalog.length : null,
      multiplication_factor_count: multiplicationFactorCount,
      zero_multiplication_factor_count: zeroMultiplicationFactorCount,
      validation: {
        available: validationAggregate.reportPath !== null,
        ok: validation.ok,
        report_file: validation.reportFile,
        engine_count: validation.engineCount,
        issue_count: validation.issues.length,
      },
      artifacts: {
        summary: summaryArtifact ? entry.summaryPath : null,
        connections: connections ? entry.connectionsPath : null,
        process_catalog: processCatalog ? entry.processCatalogPath : null,
      },
      finding_count: findings.length,
      severity_counts: counts,
    },
    findings,
  };
}

function buildInvocationIndex(
  layout: LifecyclemodelQaLayout,
  invocationIndex: JsonObject,
  options: RunLifecyclemodelQaOptions,
  now: Date,
): JsonObject {
  const priorInvocations = Array.isArray(invocationIndex.invocations)
    ? [...invocationIndex.invocations]
    : [];
  const command = ['qa', 'lifecyclemodel'];
  if (layout.inputMode === 'rows_file') {
    command.push('--rows-file', options.rowsFile as string);
  } else {
    command.push('--run-dir', options.runDir as string);
  }
  command.push('--out-dir', options.outDir);

  if (nonEmptyString(options.logicVersion)) {
    command.push('--logic-version', options.logicVersion as string);
  }
  if (nonEmptyString(options.startTs)) {
    command.push('--start-ts', options.startTs as string);
  }
  if (nonEmptyString(options.endTs)) {
    command.push('--end-ts', options.endTs as string);
  }

  return {
    ...invocationIndex,
    schema_version:
      typeof invocationIndex.schema_version === 'number' ? invocationIndex.schema_version : 1,
    invocations: [
      ...priorInvocations,
      {
        command,
        cwd: options.cwd ?? process.cwd(),
        created_at: now.toISOString(),
        run_id: layout.runId,
        run_root: layout.runRoot,
        report_path: layout.reportPath,
      },
    ],
  };
}

function buildNextActions(
  layout: LifecyclemodelQaLayout,
  validationAggregate: LifecyclemodelValidationAggregate,
): string[] {
  if (layout.inputMode === 'rows_file') {
    return [
      `inspect: ${layout.findingsPath}`,
      `run: tiangong-lca dataset validate --type lifecyclemodel --input ${layout.rowsFile}`,
      `run: tiangong-lca lifecyclemodel save-draft --input ${layout.rowsFile} --dry-run`,
    ];
  }

  return [
    `inspect: ${layout.findingsPath}`,
    validationAggregate.reportPath
      ? `inspect: ${validationAggregate.reportPath}`
      : `run: tiangong-lca lifecyclemodel validate-build --run-dir ${layout.runRoot}`,
    `run: tiangong-lca lifecyclemodel publish-build --run-dir ${layout.runRoot}`,
  ];
}

function renderZhReview(options: {
  runId: string;
  logicVersion: string;
  runRoot: string;
  rowsFile: string;
  inputMode: 'run_dir' | 'rows_file';
  modelSummaries: LifecyclemodelQaModelSummary[];
  findings: LifecyclemodelQaFinding[];
  validation: LifecyclemodelQaReport['validation'];
}): string {
  const lines = [
    '# lifecyclemodel_qa_zh\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    `- run_root: \`${options.runRoot}\`\n`,
    `- input_mode: \`${options.inputMode}\`\n`,
    ...(options.rowsFile ? [`- rows_file: \`${options.rowsFile}\`\n`] : []),
    '\n## 总览\n',
    `- model bundle 数量: **${options.modelSummaries.length}**\n`,
    `- findings 数量: **${options.findings.length}**\n`,
    `- validation report: \`${options.validation.available ? 'available' : 'missing'}\`\n`,
  ];

  lines.push(
    '\n## 模型摘要\n|run name|model uuid 数|processInstance|connections|validation issues|findings|\n|---|---:|---:|---:|---:|---:|\n',
  );
  options.modelSummaries.forEach((summary) => {
    lines.push(
      `|${summary.run_name}|${summary.model_uuids.length}|${summary.process_instance_count}|${summary.connection_count ?? 0}|${summary.validation.issue_count}|${summary.finding_count}|\n`,
    );
  });

  lines.push('\n## Findings\n');
  if (options.findings.length === 0) {
    lines.push('- 未发现新的 lifecyclemodel QA findings。\n');
  } else {
    lines.push('\n|run name|severity|source|rule id|message|\n|---|---|---|---|---|\n');
    options.findings.slice(0, 200).forEach((finding) => {
      lines.push(
        `|${finding.run_name}|${finding.severity}|${finding.source}|${finding.rule_id}|${finding.message.replace(/\|/gu, '/')}|\n`,
      );
    });
  }

  lines.push(
    '\n## 说明\n',
    options.inputMode === 'rows_file'
      ? '- 当前 qa lifecyclemodel rows-file 模式只做 payload-level deterministic QA，不要求 lifecyclemodel build-run 产物。\n'
      : '- 当前 qa lifecyclemodel run-dir 模式保持 local-first / artifact-first，只读取现有 build run 与 validate-build 产物。\n',
    '- 当前命令不引入 Python、LangGraph 或 skill 私有 QA runtime。\n',
  );

  return lines.join('');
}

function renderEnReview(options: {
  runId: string;
  logicVersion: string;
  runRoot: string;
  rowsFile: string;
  inputMode: 'run_dir' | 'rows_file';
  modelSummaries: LifecyclemodelQaModelSummary[];
  findings: LifecyclemodelQaFinding[];
  validation: LifecyclemodelQaReport['validation'];
}): string {
  const lines = [
    '# lifecyclemodel_qa_en\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    `- run_root: \`${options.runRoot}\`\n`,
    `- input_mode: \`${options.inputMode}\`\n`,
    ...(options.rowsFile ? [`- rows_file: \`${options.rowsFile}\`\n`] : []),
    '\n## Summary\n',
    `- model bundles: **${options.modelSummaries.length}**\n`,
    `- findings: **${options.findings.length}**\n`,
    `- validation report: \`${options.validation.available ? 'available' : 'missing'}\`\n`,
  ];

  lines.push(
    '\n## Model overview\n|run name|model uuids|process instances|connections|validation issues|findings|\n|---|---:|---:|---:|---:|---:|\n',
  );
  options.modelSummaries.forEach((summary) => {
    lines.push(
      `|${summary.run_name}|${summary.model_uuids.length}|${summary.process_instance_count}|${summary.connection_count ?? 0}|${summary.validation.issue_count}|${summary.finding_count}|\n`,
    );
  });

  if (options.findings.length > 0) {
    lines.push('\n## Findings\n');
    options.findings.slice(0, 100).forEach((finding) => {
      lines.push(`- [${finding.severity}] ${finding.run_name}: ${finding.message}\n`);
    });
  }

  return lines.join('');
}

function renderTiming(options: {
  runId: string;
  startTs?: string;
  endTs?: string;
  modelCount: number;
}): string {
  const lines = ['# lifecyclemodel_qa_timing\n', `- run_id: \`${options.runId}\`\n`];
  if (options.startTs && options.endTs) {
    const started = Date.parse(options.startTs);
    const ended = Date.parse(options.endTs);
    if (!Number.isFinite(started) || !Number.isFinite(ended)) {
      throw new CliError('Expected --start-ts and --end-ts to be valid ISO timestamps.', {
        code: 'LIFECYCLEMODEL_QA_INVALID_TIMESTAMP',
        exitCode: 2,
      });
    }

    lines.push(`- start: \`${options.startTs}\`\n`);
    lines.push(`- end: \`${options.endTs}\`\n`);
    lines.push(`- total elapsed: **${((ended - started) / 60_000).toFixed(2)} min**\n`);
  }

  lines.push(`- model bundles reviewed: \`${options.modelCount}\`\n`);
  lines.push(
    '- major time consumers: model JSON parsing, validation issue aggregation, artifact checks.\n',
  );
  return lines.join('');
}

export async function runLifecyclemodelQa(
  options: RunLifecyclemodelQaOptions,
): Promise<LifecyclemodelQaReport> {
  const layout = resolveLayout(options);
  const input =
    layout.inputMode === 'rows_file'
      ? materializeRowsFile(layout)
      : (() => {
          ensureRunRootExists(layout);
          readRequiredRunManifest(layout);
          return {
            invocationIndex: readInvocationIndex(layout),
            validationAggregate: readValidationAggregate(layout),
            modelEntries: discoverModelEntries(layout),
          };
        })();
  const logicVersion = options.logicVersion?.trim() || 'lifecyclemodel-qa-v1.0';
  const now = options.now ?? (() => new Date());
  const generatedAt = now();

  const reviewedModels = input.modelEntries.map((entry) =>
    buildModelReview(entry, input.validationAggregate),
  );
  const modelSummaries = reviewedModels.map((model) => model.summary);
  const findings = reviewedModels.flatMap((model) => model.findings);
  const report: LifecyclemodelQaReport = {
    schema_version: 1,
    generated_at_utc: generatedAt.toISOString(),
    status: 'completed_local_lifecyclemodel_qa',
    run_id: layout.runId,
    run_root: layout.runRoot,
    rows_file: layout.rowsFile,
    input_mode: layout.inputMode,
    out_dir: layout.outDir,
    logic_version: logicVersion,
    model_count: modelSummaries.length,
    finding_count: findings.length,
    severity_counts: severityCounts(findings),
    validation: {
      available: input.validationAggregate.reportPath !== null,
      ok: input.validationAggregate.ok,
      report: input.validationAggregate.reportPath,
    },
    files: {
      run_manifest: layout.runManifestPath,
      invocation_index: layout.invocationIndexPath,
      qa_input_summary: layout.qaInputSummaryPath,
      validation_report: input.validationAggregate.reportPath,
      model_summaries: layout.modelSummariesPath,
      findings: layout.findingsPath,
      summary: layout.summaryPath,
      qa_zh: layout.reviewZhPath,
      qa_en: layout.reviewEnPath,
      timing: layout.timingPath,
      report: layout.reportPath,
    },
    model_summaries: modelSummaries,
    next_actions: buildNextActions(layout, input.validationAggregate),
  };

  writeJsonArtifact(
    layout.invocationIndexPath,
    buildInvocationIndex(layout, input.invocationIndex, options, generatedAt),
  );
  writeJsonLinesArtifact(layout.modelSummariesPath, modelSummaries);
  writeJsonLinesArtifact(layout.findingsPath, findings);
  writeJsonArtifact(layout.summaryPath, {
    run_id: report.run_id,
    rows_file: report.rows_file,
    input_mode: report.input_mode,
    logic_version: report.logic_version,
    model_count: report.model_count,
    finding_count: report.finding_count,
    severity_counts: copyJson(report.severity_counts),
    validation: copyJson(report.validation),
  });
  writeTextArtifact(
    layout.reviewZhPath,
    renderZhReview({
      runId: report.run_id,
      logicVersion: report.logic_version,
      runRoot: report.run_root,
      rowsFile: report.rows_file,
      inputMode: report.input_mode,
      modelSummaries,
      findings,
      validation: report.validation,
    }),
  );
  writeTextArtifact(
    layout.reviewEnPath,
    renderEnReview({
      runId: report.run_id,
      logicVersion: report.logic_version,
      runRoot: report.run_root,
      rowsFile: report.rows_file,
      inputMode: report.input_mode,
      modelSummaries,
      findings,
      validation: report.validation,
    }),
  );
  writeTextArtifact(
    layout.timingPath,
    renderTiming({
      runId: report.run_id,
      startTs: options.startTs,
      endTs: options.endTs,
      modelCount: report.model_count,
    }),
  );
  writeJsonArtifact(layout.reportPath, report);

  return report;
}

export const __testInternals = {
  buildLayout,
  resolveLayout,
  readInvocationIndex,
  discoverModelEntries,
  readValidationAggregate,
  materializeRowsFile,
  sanitizeFileName,
  readModelFileReviewInfo,
  buildModelReview,
  buildInvocationIndex,
  buildNextActions,
  renderZhReview,
  renderEnReview,
  renderTiming,
};
