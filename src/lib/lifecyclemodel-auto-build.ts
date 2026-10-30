import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeTextArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import { collectDatasetNameIssues } from './dataset-name-validation.js';
import { TIDAS_LANGUAGE_CODE_SET } from './tidas-languages.js';
import { readJsonInput } from './io.js';
import {
  buildRunId,
  buildRunManifest,
  ensureRunLayout,
  writeLatestRunId,
  type RunLayout,
} from './run.js';

type JsonRecord = Record<string, unknown>;

const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const EPSILON = 1e-10;

const DEFAULT_MANIFEST = {
  run_label: 'lifecyclemodel-automated-builder',
  allow_remote_write: false,
  discovery: {
    sources: [
      { kind: 'account_processes', selector: 'all-accessible' },
      {
        kind: 'public_open_data',
        table: 'processes',
        filters: { state_code: 100 },
      },
    ],
    supporting_open_tables: ['flows', 'sources', 'lifecyclemodels'],
    batch_limit: 200,
    reference_model_queries: [],
    reference_model_select_limit: 3,
  },
  selection: {
    mode: 'graph_first_local_build',
    max_models: 25,
    max_processes_per_model: 12,
    decision_factors: [
      'shared product system or classification lineage',
      'explicit exchange connectivity',
      'quantitative reference completeness',
      'geography and time coherence',
    ],
  },
  reuse: {
    reusable_process_dirs: [],
    include_reference_model_resulting_processes: true,
  },
  output: {
    write_local_models: true,
    emit_validation_report: false,
  },
  local_runs: [],
  publish: {
    enabled: false,
    mode: 'deferred_to_publish_build',
    target_runs: [],
    select_after_insert: true,
    max_attempts: 5,
    retry_delay_seconds: 2,
  },
} as const;

type LifecyclemodelAutoBuildStatus = 'completed_local_lifecyclemodel_auto_build_run';

export type LifecyclemodelAutoBuildLayout = RunLayout & {
  requestDir: string;
  selectionDir: string;
  discoveryDir: string;
  modelsDir: string;
  requestSnapshotPath: string;
  normalizedRequestPath: string;
  runPlanPath: string;
  resolvedManifestPath: string;
  selectionBriefPath: string;
  referenceModelSummaryPath: string;
  invocationIndexPath: string;
  runManifestPath: string;
  reportPath: string;
};

export type NormalizedLifecyclemodelAutoBuildRequest = {
  schema_version: 1;
  request_path: string;
  run_id: string;
  run_root: string;
  manifest: JsonRecord;
  local_runs: string[];
};

type ProcessRecord = {
  processUuid: string;
  version: string;
  raw: JsonRecord;
  referenceExchangeInternalId: string;
  referenceFlowUuid: string;
  referenceDirection: 'Input' | 'Output';
  referenceAmount: number;
  inputAmounts: Record<string, number>;
  outputAmounts: Record<string, number>;
  nameEn: string;
  nameZh: string;
  routeEn: string;
  mixEn: string;
  geographyCode: string;
  classificationPath: string[];
  tokenSet: Set<string>;
  sourceKind: 'local_run_export';
  sourceLabel: string;
  includedProcessRefCount: number;
};

type Edge = {
  src: string;
  dst: string;
  flowUuid: string;
  downstreamInputAmount: number;
  confidence: number;
  reasons: string[];
};

export type LifecyclemodelAutoBuildLocalReport = {
  run_dir: string;
  run_name: string;
  model_file: string;
  summary_file: string;
  connections_file: string;
  process_catalog_file: string;
  summary: JsonRecord;
};

export type LifecyclemodelAutoBuildReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: LifecyclemodelAutoBuildStatus;
  request_path: string;
  run_id: string;
  run_root: string;
  local_run_count: number;
  built_model_count: number;
  files: {
    request_snapshot: string;
    normalized_request: string;
    run_plan: string;
    resolved_manifest: string;
    selection_brief: string;
    reference_model_summary: string;
    invocation_index: string;
    run_manifest: string;
    report: string;
  };
  local_build_reports: LifecyclemodelAutoBuildLocalReport[];
  next_actions: string[];
};

export type RunLifecyclemodelAutoBuildOptions = {
  inputPath: string;
  outDir?: string | null;
  now?: Date;
  cwd?: string;
  inputValue?: unknown;
  runIdOverride?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ensureList<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? (value as T[]) : ([value] as T[]);
}

function copyJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function firstText(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const text = nonEmptyString(item['#text']);
        if (text) {
          return text;
        }
      }
    }

    return '';
  }

  if (isRecord(value)) {
    return nonEmptyString(value['#text']) ?? '';
  }

  return nonEmptyString(value) ?? '';
}

function langTextMap(value: unknown): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const item of ensureList(value)) {
    if (!isRecord(item)) {
      continue;
    }

    const candidateLang = nonEmptyString(item['@xml:lang'])?.toLowerCase() ?? 'en';
    const lang = TIDAS_LANGUAGE_CODE_SET.has(candidateLang) ? candidateLang : 'en';
    const text = nonEmptyString(item['#text']);
    if (text && !mapping[lang]) {
      mapping[lang] = text;
    }
  }

  if (Object.keys(mapping).length > 0) {
    return mapping;
  }

  const text = firstText(value).trim();
  return text ? { en: text } : {};
}

function localizedText(value: unknown, preferred = 'zh'): string {
  const mapping = langTextMap(value);
  if (mapping[preferred]) {
    return mapping[preferred];
  }

  if (mapping.en) {
    return mapping.en;
  }

  return Object.values(mapping)[0] ?? '';
}

function multilangText(value: unknown): [string, string] {
  const mapping = langTextMap(value);
  return [mapping.en ?? Object.values(mapping)[0] ?? '', mapping.zh ?? ''];
}

function multilangFromText(enText: string, zhText?: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  if (enText) {
    items.push({ '@xml:lang': 'en', '#text': enText });
  }
  if (zhText) {
    items.push({ '@xml:lang': 'zh', '#text': zhText });
  }
  return items;
}

function tokenizeText(value: string): Set<string> {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();

  return new Set(cleaned.split(/\s+/u).filter((token) => token.length >= 3));
}

function buildNameSummary(nameInfo: JsonRecord): Array<Record<string, string>> {
  const base = langTextMap(nameInfo.baseName);
  const route = langTextMap(nameInfo.treatmentStandardsRoutes);
  const mix = langTextMap(nameInfo.mixAndLocationTypes);
  const functional = langTextMap(nameInfo.functionalUnitFlowProperties);
  const langOrder: string[] = [];

  [base, route, mix, functional].forEach((mapping) => {
    Object.keys(mapping).forEach((lang) => {
      if (!langOrder.includes(lang)) {
        langOrder.push(lang);
      }
    });
  });

  if (langOrder.length === 0) {
    return [];
  }

  const fallback = (mapping: Record<string, string>, lang: string): string =>
    mapping[lang] ?? mapping.zh ?? mapping.en ?? Object.values(mapping)[0] ?? '';

  const summary: Array<Record<string, string>> = [];

  langOrder.forEach((lang) => {
    const text = [
      fallback(base, lang),
      fallback(route, lang),
      fallback(mix, lang),
      fallback(functional, lang),
    ]
      .filter(Boolean)
      .join('; ')
      .trim();

    if (text) {
      summary.push({ '@xml:lang': lang, '#text': text });
    }
  });

  return summary;
}

function extractClassificationPath(classificationInfo: unknown): string[] {
  const carrier = isRecord(classificationInfo)
    ? isRecord(classificationInfo['common:classification'])
      ? classificationInfo['common:classification']
      : {}
    : {};

  return ensureList(carrier['common:class'])
    .map((item) => (isRecord(item) ? nonEmptyString(item['#text']) : null))
    .filter((item): item is string => Boolean(item));
}

function classificationOverlap(left: string[], right: string[]): number {
  let overlap = 0;
  const maxLength = Math.min(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (left[index] !== right[index]) {
      break;
    }
    overlap += 1;
  }

  return overlap;
}

function parseUuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/gu, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hex)) {
    throw new CliError(`Invalid UUID value: ${uuid}`, {
      code: 'LIFECYCLEMODEL_AUTO_BUILD_UUID_INVALID',
      exitCode: 2,
    });
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuid5FromText(namespaceUuid: string, value: string): string {
  const namespaceBytes = Buffer.from(parseUuidBytes(namespaceUuid));
  const hash = createHash('sha1').update(namespaceBytes).update(value, 'utf8').digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < EPSILON) {
    return '0';
  }

  const normalized = Number.parseFloat(value.toPrecision(15));
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }

  if (Math.abs(normalized) >= 1e6 || Math.abs(normalized) < 1e-6) {
    return normalized.toFixed(12).replace(/0+$/u, '').replace(/\.$/u, '');
  }

  return String(normalized);
}

function toJsonNumber(value: number): number {
  return Number.parseFloat(formatNumber(value));
}

function requiredRequestObject(input: unknown): JsonRecord {
  if (!isRecord(input)) {
    throw new CliError('lifecyclemodel auto-build request must be a JSON object.', {
      code: 'LIFECYCLEMODEL_AUTO_BUILD_REQUEST_INVALID',
      exitCode: 2,
    });
  }

  return input;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isRecord(base) && isRecord(override)) {
    const merged: JsonRecord = copyJson(base);
    Object.entries(override).forEach(([key, value]) => {
      merged[key] = deepMerge(merged[key], value);
    });
    return merged;
  }

  return copyJson(override);
}

function normalizeLocalRuns(value: unknown, requestDir: string): string[] {
  const seen = new Set<string>();
  const normalized = ensureList(value)
    .map((item) => nonEmptyString(item))
    .filter((item): item is string => Boolean(item))
    .map((item) => path.resolve(requestDir, item));

  if (normalized.length === 0) {
    throw new CliError(
      'lifecyclemodel auto-build local_runs must contain at least one run directory.',
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_LOCAL_RUNS_REQUIRED',
        exitCode: 2,
      },
    );
  }

  normalized.forEach((item) => {
    if (seen.has(item)) {
      throw new CliError(`Duplicate lifecyclemodel auto-build local_run: ${item}`, {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_LOCAL_RUN_DUPLICATE',
        exitCode: 2,
      });
    }
    seen.add(item);
  });

  return normalized;
}

function resolveRunRoot(
  requestDir: string,
  outDirOverride: string | null | undefined,
  requestOutDir: unknown,
): string {
  const override = nonEmptyString(outDirOverride);
  if (override) {
    return path.resolve(requestDir, override);
  }

  const requestValue = nonEmptyString(requestOutDir);
  if (requestValue) {
    return path.resolve(requestDir, requestValue);
  }

  throw new CliError(
    'Missing required lifecyclemodel auto-build run root. Provide --out-dir or request.out_dir.',
    {
      code: 'LIFECYCLEMODEL_AUTO_BUILD_RUN_ROOT_REQUIRED',
      exitCode: 2,
    },
  );
}

function buildLayout(runRoot: string, runId: string): LifecyclemodelAutoBuildLayout {
  const collectionDir = path.dirname(runRoot);
  const layout: RunLayout = {
    namespace: 'lifecyclemodel_auto_build',
    runId,
    artifactsRoot: path.dirname(collectionDir),
    collectionDir,
    runRoot,
    cacheDir: path.join(runRoot, 'cache'),
    inputsDir: path.join(runRoot, 'request'),
    outputsDir: path.join(runRoot, 'models'),
    reportsDir: path.join(runRoot, 'reports'),
    logsDir: path.join(runRoot, 'logs'),
    manifestsDir: path.join(runRoot, 'manifests'),
    latestRunIdPath: path.join(collectionDir, '.latest_run_id'),
  };

  return {
    ...layout,
    requestDir: path.join(runRoot, 'request'),
    selectionDir: path.join(runRoot, 'selection'),
    discoveryDir: path.join(runRoot, 'discovery'),
    modelsDir: path.join(runRoot, 'models'),
    requestSnapshotPath: path.join(runRoot, 'request', 'lifecyclemodel-auto-build.request.json'),
    normalizedRequestPath: path.join(runRoot, 'request', 'request.normalized.json'),
    runPlanPath: path.join(runRoot, 'run-plan.json'),
    resolvedManifestPath: path.join(runRoot, 'resolved-manifest.json'),
    selectionBriefPath: path.join(runRoot, 'selection', 'selection-brief.md'),
    referenceModelSummaryPath: path.join(runRoot, 'discovery', 'reference-model-summary.json'),
    invocationIndexPath: path.join(runRoot, 'manifests', 'invocation-index.json'),
    runManifestPath: path.join(runRoot, 'manifests', 'run-manifest.json'),
    reportPath: path.join(runRoot, 'reports', 'lifecyclemodel-auto-build-report.json'),
  };
}

function ensureEmptyRunRoot(runRoot: string): void {
  if (!existsSync(runRoot)) {
    return;
  }

  if (readdirSync(runRoot).length > 0) {
    throw new CliError(
      `lifecyclemodel auto-build run root already exists and is not empty: ${runRoot}`,
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_RUN_EXISTS',
        exitCode: 2,
      },
    );
  }
}

function ensureLayout(layout: LifecyclemodelAutoBuildLayout): void {
  ensureRunLayout(layout);
  [layout.requestDir, layout.selectionDir, layout.discoveryDir, layout.modelsDir].forEach(
    (dirPath) => {
      mkdirSync(dirPath, { recursive: true });
    },
  );
}

export function normalizeLifecyclemodelAutoBuildRequest(
  input: unknown,
  options: {
    inputPath: string;
    outDir?: string | null;
    now?: Date;
    runIdOverride?: string;
  },
): NormalizedLifecyclemodelAutoBuildRequest {
  const request = requiredRequestObject(input);
  const requestPath = path.resolve(options.inputPath);
  const requestDir = path.dirname(requestPath);
  const mergedManifest = deepMerge(DEFAULT_MANIFEST, request) as JsonRecord;

  if (mergedManifest.allow_remote_write === true) {
    throw new CliError(
      'allow_remote_write=true is not supported by tiangong-lca lifecyclemodel auto-build. Keep the run read-only.',
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_REMOTE_WRITE_UNSUPPORTED',
        exitCode: 2,
      },
    );
  }

  const now = options.now ?? new Date();
  const runId =
    nonEmptyString(options.runIdOverride) ??
    buildRunId({
      namespace: 'lifecyclemodel_auto_build',
      subject:
        nonEmptyString(mergedManifest.run_label) ??
        path.basename(requestPath, path.extname(requestPath)),
      operation: 'build',
      now,
    });

  return {
    schema_version: 1,
    request_path: requestPath,
    run_id: runId,
    run_root: resolveRunRoot(requestDir, options.outDir, request.out_dir),
    manifest: mergedManifest,
    local_runs: normalizeLocalRuns(mergedManifest.local_runs, requestDir),
  };
}

function buildSelectionBrief(manifest: JsonRecord): string {
  const selection = isRecord(manifest.selection) ? manifest.selection : {};
  const decisionFactors = ensureList(selection.decision_factors)
    .map((item) => nonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  const referenceQueries = isRecord(manifest.discovery)
    ? ensureList(manifest.discovery.reference_model_queries)
        .map((item) => nonEmptyString(item))
        .filter((item): item is string => Boolean(item))
    : [];

  const lines = [
    '# Selection Brief',
    '',
    'This CLI slice is local-first and read-only.',
    '',
    'Candidate processes are grouped by the provided process run directories.',
    'The CLI then infers graph structure from shared flow UUIDs, chooses one reference process, and assembles native `json_ordered` lifecyclemodel artifacts.',
    '',
    'Decision factors:',
    ...decisionFactors.map((item) => `- ${item}`),
  ];

  if (referenceQueries.length > 0) {
    lines.push(
      '',
      'Reference lifecyclemodel discovery was requested in the manifest, but this first CLI slice defers remote read-only discovery to future commands.',
      ...referenceQueries.map((item) => `- deferred reference query: ${item}`),
    );
  }

  lines.push(
    '',
    'Explicitly deferred in this slice:',
    '- remote discovery',
    '- MCP writes',
    '- LLM-driven selection',
    '- validate-build',
    '- publish-build',
    '',
  );

  return lines.join('\n');
}

function buildReferenceModelSummary(manifest: JsonRecord): JsonRecord {
  const discovery = isRecord(manifest.discovery) ? manifest.discovery : {};
  const queries = ensureList(discovery.reference_model_queries)
    .map((item) => nonEmptyString(item))
    .filter((item): item is string => Boolean(item));

  return {
    executed: false,
    queries,
    reason:
      queries.length > 0
        ? 'reference model discovery is deferred in the first native CLI auto-build slice'
        : 'reference model discovery not requested',
  };
}

function buildInvocationIndex(
  normalized: NormalizedLifecyclemodelAutoBuildRequest,
  options: RunLifecyclemodelAutoBuildOptions,
  layout: LifecyclemodelAutoBuildLayout,
  now: Date,
): JsonRecord {
  const command = ['lifecyclemodel', 'auto-build', '--input', options.inputPath];
  if (options.outDir) {
    command.push('--out-dir', options.outDir);
  }

  return {
    schema_version: 1,
    invocations: [
      {
        command,
        cwd: options.cwd ?? process.cwd(),
        created_at: now.toISOString(),
        request_path: normalized.request_path,
        report_path: layout.reportPath,
      },
    ],
  };
}

function buildPlan(
  normalized: NormalizedLifecyclemodelAutoBuildRequest,
  layout: LifecyclemodelAutoBuildLayout,
  now: Date,
): JsonRecord {
  return {
    skill: 'lifecyclemodel-automated-builder',
    mode: 'read_only_local_build',
    created_at: now.toISOString(),
    manifest: normalized.manifest,
    runtime: {
      cli: {
        command: 'lifecyclemodel auto-build',
        entry: 'native_ts',
        node_version: process.version,
        remote_write: false,
        mcp_used: false,
      },
    },
    guardrails: [
      'do not write remote lifecyclemodel rows in auto-build',
      'do not require MCP or LLM to assemble the initial local lifecyclemodel graph',
      'emit native json_ordered only',
      'defer validate-build and publish-build to dedicated follow-up commands',
    ],
    artifacts: {
      root: layout.runRoot,
      run_plan: layout.runPlanPath,
      resolved_manifest: layout.resolvedManifestPath,
      selection_brief: layout.selectionBriefPath,
      discovery_dir: layout.discoveryDir,
      reference_model_summary: layout.referenceModelSummaryPath,
      models_dir: layout.modelsDir,
      reports_dir: layout.reportsDir,
    },
    stages: [
      {
        name: 'load-local-runs',
        mode: 'local',
        description: 'Load one or more process-automated-builder run directories.',
      },
      {
        name: 'infer-graph',
        mode: 'local',
        description: 'Infer process-to-process links from shared flow UUIDs.',
      },
      {
        name: 'select-reference-process',
        mode: 'local',
        description:
          'Pick the lifecyclemodel reference process from the target flow and graph shape.',
      },
      {
        name: 'assemble-lifecyclemodel',
        mode: 'local',
        description: 'Write native json_ordered lifecyclemodel artifacts.',
      },
      {
        name: 'validate',
        mode: 'deferred',
        description: 'Deferred to tiangong-lca lifecyclemodel validate-build.',
      },
      {
        name: 'publish',
        mode: 'deferred',
        description: 'Deferred to tiangong-lca lifecyclemodel publish-build.',
      },
    ],
    local_runs: normalized.local_runs,
  };
}

function extractFlowDatasetFromState(state: JsonRecord): JsonRecord {
  const flowDataset = isRecord(state.flow_dataset) ? state.flow_dataset : {};
  if (isRecord(flowDataset.flowDataSet)) {
    return flowDataset.flowDataSet;
  }

  return flowDataset;
}

function buildGlobalReference(
  refObjectId: string,
  version: string,
  shortDescription: unknown,
  datasetType: string,
  uri: string,
): JsonRecord {
  return {
    '@refObjectId': refObjectId,
    '@type': datasetType,
    '@uri': uri,
    '@version': version,
    'common:shortDescription': copyJson(shortDescription),
  };
}

function resolvePublicationBlock(dataset: JsonRecord): JsonRecord {
  const administrativeInformation = isRecord(dataset.administrativeInformation)
    ? dataset.administrativeInformation
    : {};

  if (isRecord(administrativeInformation.publicationAndOwnership)) {
    return administrativeInformation.publicationAndOwnership;
  }

  if (isRecord(administrativeInformation['common:publicationAndOwnership'])) {
    return administrativeInformation['common:publicationAndOwnership'];
  }

  return {};
}

function loadProcessRecord(
  filePath: string,
  sourceKind: 'local_run_export',
  sourceLabel: string,
): ProcessRecord {
  const raw = readJsonInput(filePath);
  if (!isRecord(raw) || !isRecord(raw.processDataSet)) {
    throw new CliError(
      `lifecyclemodel auto-build process file must contain processDataSet: ${filePath}`,
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_PROCESS_INVALID',
        exitCode: 2,
      },
    );
  }

  const dataset = raw.processDataSet;
  const processInformation = isRecord(dataset.processInformation) ? dataset.processInformation : {};
  const dataSetInformation = isRecord(processInformation.dataSetInformation)
    ? processInformation.dataSetInformation
    : {};
  const nameInfo = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
  const geography = isRecord(processInformation.geography) ? processInformation.geography : {};
  const location = isRecord(geography.locationOfOperationSupplyOrProduction)
    ? geography.locationOfOperationSupplyOrProduction
    : {};
  const technology = isRecord(processInformation.technology) ? processInformation.technology : {};
  const quantitativeReference = isRecord(processInformation.quantitativeReference)
    ? processInformation.quantitativeReference
    : {};
  const referenceExchangeInternalId = nonEmptyString(
    quantitativeReference.referenceToReferenceFlow,
  );
  if (!referenceExchangeInternalId) {
    throw new CliError(
      `lifecyclemodel auto-build process is missing referenceToReferenceFlow: ${filePath}`,
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_REFERENCE_FLOW_MISSING',
        exitCode: 2,
      },
    );
  }

  const exchangesCarrier = isRecord(dataset.exchanges) ? dataset.exchanges : {};
  const exchanges = ensureList<JsonRecord>(exchangesCarrier.exchange).filter(isRecord);
  const referenceExchange = exchanges.find(
    (item) => nonEmptyString(item['@dataSetInternalID']) === referenceExchangeInternalId,
  );
  if (!referenceExchange) {
    throw new CliError(
      `lifecyclemodel auto-build reference exchange ${referenceExchangeInternalId} not found: ${filePath}`,
      {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_REFERENCE_EXCHANGE_NOT_FOUND',
        exitCode: 2,
      },
    );
  }

  const inputAmounts: Record<string, number> = {};
  const outputAmounts: Record<string, number> = {};

  exchanges.forEach((exchange) => {
    const flowRef = isRecord(exchange.referenceToFlowDataSet)
      ? exchange.referenceToFlowDataSet
      : {};
    const flowUuid = nonEmptyString(flowRef['@refObjectId']);
    if (!flowUuid) {
      return;
    }

    const amount = numberOrZero(exchange.meanAmount ?? exchange.resultingAmount);
    const direction = nonEmptyString(exchange.exchangeDirection);
    if (direction === 'Input') {
      inputAmounts[flowUuid] = amount;
    } else if (direction === 'Output') {
      outputAmounts[flowUuid] = amount;
    }
  });

  const processUuid = nonEmptyString(dataSetInformation['common:UUID']);
  if (!processUuid) {
    throw new CliError(`lifecyclemodel auto-build process is missing common:UUID: ${filePath}`, {
      code: 'LIFECYCLEMODEL_AUTO_BUILD_PROCESS_UUID_MISSING',
      exitCode: 2,
    });
  }

  const publication = resolvePublicationBlock(dataset);
  const version = nonEmptyString(publication['common:dataSetVersion']) ?? '00.00.001';
  const referenceFlowRef = isRecord(referenceExchange.referenceToFlowDataSet)
    ? referenceExchange.referenceToFlowDataSet
    : {};
  const referenceFlowUuid = nonEmptyString(referenceFlowRef['@refObjectId']);
  const referenceDirection = nonEmptyString(referenceExchange.exchangeDirection);
  if (!referenceFlowUuid || (referenceDirection !== 'Input' && referenceDirection !== 'Output')) {
    throw new CliError(`lifecyclemodel auto-build reference exchange is incomplete: ${filePath}`, {
      code: 'LIFECYCLEMODEL_AUTO_BUILD_REFERENCE_EXCHANGE_INVALID',
      exitCode: 2,
    });
  }

  const includedProcessRefs = ensureList(technology.referenceToIncludedProcesses).filter(isRecord);
  const [nameEn, nameZh] = multilangText(nameInfo.baseName);
  const [routeEn] = multilangText(nameInfo.treatmentStandardsRoutes);
  const [mixEn] = multilangText(nameInfo.mixAndLocationTypes);
  const classificationPath = extractClassificationPath(
    dataSetInformation.classificationInformation,
  );

  return {
    processUuid,
    version,
    raw,
    referenceExchangeInternalId,
    referenceFlowUuid,
    referenceDirection,
    referenceAmount: numberOrZero(
      referenceExchange.meanAmount ?? referenceExchange.resultingAmount,
    ),
    inputAmounts,
    outputAmounts,
    nameEn,
    nameZh,
    routeEn,
    mixEn,
    geographyCode: nonEmptyString(location['@location']) ?? '',
    classificationPath,
    tokenSet: tokenizeText(
      [nameEn, routeEn, mixEn, classificationPath.join(' ')].filter(Boolean).join(' '),
    ),
    sourceKind,
    sourceLabel,
    includedProcessRefCount: includedProcessRefs.length,
  };
}

function scoreEdgeCandidate(
  src: ProcessRecord,
  dst: ProcessRecord,
  flowUuid: string,
  downstreamAmount: number,
): { confidence: number; reasons: string[] } {
  let score = 10;
  const reasons = ['shared flow UUID'];

  if (src.referenceFlowUuid === flowUuid && src.referenceDirection === 'Output') {
    score += 3;
    reasons.push('upstream reference flow matches shared flow');
  }

  if (dst.referenceFlowUuid === flowUuid && dst.referenceDirection === 'Input') {
    score += 3;
    reasons.push('downstream reference flow matches shared flow');
  }

  const classOverlap = classificationOverlap(src.classificationPath, dst.classificationPath);
  if (classOverlap > 0) {
    score += Math.min(classOverlap, 3);
    reasons.push(`classification prefix overlap=${classOverlap}`);
  }

  if (src.geographyCode && dst.geographyCode && src.geographyCode === dst.geographyCode) {
    score += 1;
    reasons.push(`same geography=${src.geographyCode}`);
  }

  const tokenOverlap = [...src.tokenSet].filter((token) => dst.tokenSet.has(token)).length;
  if (tokenOverlap > 0) {
    score += Math.min(tokenOverlap, 4) / 4;
    reasons.push(`token overlap=${tokenOverlap}`);
  }

  const upstreamAmount = src.outputAmounts[flowUuid] ?? 0;
  if (upstreamAmount > 0 && downstreamAmount > 0) {
    const ratio = downstreamAmount / upstreamAmount;
    if (ratio >= 0.5 && ratio <= 2) {
      score += 1;
      reasons.push(`amount ratio plausible=${formatNumber(ratio)}`);
    }
  }

  return { confidence: score, reasons };
}

function inferEdges(processMap: Record<string, ProcessRecord>): Edge[] {
  const byFlow = new Map<string, { producers: Set<string>; consumers: Set<string> }>();

  Object.entries(processMap).forEach(([processId, record]) => {
    Object.keys(record.outputAmounts).forEach((flowUuid) => {
      const group = byFlow.get(flowUuid) ?? {
        producers: new Set<string>(),
        consumers: new Set<string>(),
      };
      group.producers.add(processId);
      byFlow.set(flowUuid, group);
    });

    Object.keys(record.inputAmounts).forEach((flowUuid) => {
      const group = byFlow.get(flowUuid) ?? {
        producers: new Set<string>(),
        consumers: new Set<string>(),
      };
      group.consumers.add(processId);
      byFlow.set(flowUuid, group);
    });
  });

  const edgeMap = new Map<string, Edge>();

  byFlow.forEach((participants, flowUuid) => {
    if (participants.producers.size === 0 || participants.consumers.size === 0) {
      return;
    }

    const passThrough = [...participants.producers].filter((item) =>
      participants.consumers.has(item),
    );
    const candidatePairs: Array<[string, string]> = [];

    if (passThrough.length > 0) {
      [...participants.producers]
        .filter((item) => !passThrough.includes(item))
        .forEach((producer) => {
          passThrough.forEach((bridge) => {
            candidatePairs.push([producer, bridge]);
          });
        });

      passThrough.forEach((bridge) => {
        [...participants.consumers]
          .filter((item) => !passThrough.includes(item))
          .forEach((consumer) => {
            candidatePairs.push([bridge, consumer]);
          });
      });
    } else {
      participants.producers.forEach((producer) => {
        participants.consumers.forEach((consumer) => {
          candidatePairs.push([producer, consumer]);
        });
      });
    }

    candidatePairs.forEach(([src, dst]) => {
      const downstreamAmount = processMap[dst]?.inputAmounts[flowUuid];
      const scored = scoreEdgeCandidate(
        processMap[src] as ProcessRecord,
        processMap[dst] as ProcessRecord,
        flowUuid,
        downstreamAmount as number,
      );
      edgeMap.set(`${src}::${dst}::${flowUuid}`, {
        src,
        dst,
        flowUuid,
        downstreamInputAmount: downstreamAmount,
        confidence: scored.confidence,
        reasons: scored.reasons,
      });
    });
  });

  const grouped = new Map<string, Edge[]>();
  [...edgeMap.values()].forEach((edge) => {
    const key = `${edge.dst}::${edge.flowUuid}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(edge);
    grouped.set(key, bucket);
  });

  const filtered: Edge[] = [];
  grouped.forEach((group) => {
    const ordered = [...group].sort(
      (left, right) => right.confidence - left.confidence || left.src.localeCompare(right.src),
    );

    if (
      ordered.length >= 2 &&
      ordered[0] &&
      ordered[1] &&
      ordered[0].confidence - ordered[1].confidence >= 2
    ) {
      filtered.push(ordered[0]);
      return;
    }

    filtered.push(...ordered);
  });

  return filtered.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.flowUuid.localeCompare(right.flowUuid) ||
      left.src.localeCompare(right.src) ||
      left.dst.localeCompare(right.dst),
  );
}

function chooseReferenceProcess(
  processMap: Record<string, ProcessRecord>,
  edges: Edge[],
  state: JsonRecord,
  preferredProcessIds: Set<string>,
): string {
  const flowSummary = isRecord(state.flow_summary) ? state.flow_summary : {};
  const targetFlowUuid = nonEmptyString(flowSummary.uuid) ?? '';
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  edges.forEach((edge) => {
    indegree.set(edge.dst, (indegree.get(edge.dst) ?? 0) + 1);
    outdegree.set(edge.src, (outdegree.get(edge.src) ?? 0) + 1);
  });

  let candidates = Object.entries(processMap)
    .filter(
      ([processId, record]) =>
        preferredProcessIds.has(processId) &&
        record.referenceFlowUuid === targetFlowUuid &&
        record.referenceDirection === 'Output',
    )
    .map(([processId]) => processId);

  if (candidates.length === 0 && targetFlowUuid) {
    candidates = Object.entries(processMap)
      .filter(
        ([processId, record]) =>
          preferredProcessIds.has(processId) && targetFlowUuid in record.outputAmounts,
      )
      .map(([processId]) => processId);
  }

  if (candidates.length === 0) {
    candidates = [...preferredProcessIds].sort();
  }

  const buildRankKey = (processId: string): string => {
    const record = processMap[processId] as ProcessRecord;
    const targetRank = Number(
      Object.prototype.hasOwnProperty.call(record.outputAmounts, targetFlowUuid),
    );
    const terminalRank = Number((outdegree.get(processId) ?? 0) === 0);
    const indegreeRank = String(indegree.get(processId) ?? 0).padStart(8, '0');
    return `${targetRank}|${terminalRank}|${indegreeRank}|${processId}`;
  };

  return [...candidates]
    .sort((left, right) => buildRankKey(left).localeCompare(buildRankKey(right)))
    .pop() as string;
}

function collectReachable(finalProcessId: string, edges: Edge[]): Set<string> {
  const reverseAdj = new Map<string, string[]>();

  edges.forEach((edge) => {
    const bucket = reverseAdj.get(edge.dst) ?? [];
    bucket.push(edge.src);
    reverseAdj.set(edge.dst, bucket);
  });

  const reachable = new Set<string>([finalProcessId]);
  const queue = [finalProcessId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    (reverseAdj.get(current) ?? []).forEach((upstream) => {
      if (reachable.has(upstream)) {
        return;
      }
      reachable.add(upstream);
      queue.push(upstream);
    });
  }

  return reachable;
}

function topologicalOrder(processIds: Set<string>, edges: Edge[]): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  [...processIds].forEach((processId) => {
    indegree.set(processId, 0);
  });

  edges.forEach((edge) => {
    if (!processIds.has(edge.src) || !processIds.has(edge.dst)) {
      return;
    }

    indegree.set(edge.dst, (indegree.get(edge.dst) as number) + 1);
    const bucket = adj.get(edge.src) ?? [];
    bucket.push(edge.dst);
    adj.set(edge.src, bucket);
  });

  const queue = [...processIds]
    .filter((processId) => (indegree.get(processId) as number) === 0)
    .sort();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    ordered.push(current);
    (adj.get(current) ?? []).sort().forEach((downstream) => {
      indegree.set(downstream, (indegree.get(downstream) as number) - 1);
      if ((indegree.get(downstream) as number) === 0) {
        queue.push(downstream);
        queue.sort();
      }
    });
  }

  if (ordered.length !== processIds.size) {
    [...processIds]
      .filter((processId) => !ordered.includes(processId))
      .sort()
      .forEach((processId) => ordered.push(processId));
  }

  return ordered;
}

function computeMultiplicationFactors(
  processMap: Record<string, ProcessRecord>,
  reachable: Set<string>,
  edges: Edge[],
  order: string[],
  finalProcessId: string,
): Record<string, number> {
  const factors: Record<string, number> = {};
  [...reachable].forEach((processId) => {
    factors[processId] = 0;
  });
  factors[finalProcessId] = 1;

  const incoming = new Map<string, Edge[]>();
  edges.forEach((edge) => {
    if (!reachable.has(edge.src) || !reachable.has(edge.dst)) {
      return;
    }
    const bucket = incoming.get(edge.dst) ?? [];
    bucket.push(edge);
    incoming.set(edge.dst, bucket);
  });

  [...order].reverse().forEach((current) => {
    const currentFactor = factors[current] as number;
    if (Math.abs(currentFactor) < EPSILON) {
      return;
    }

    (incoming.get(current) ?? []).forEach((edge) => {
      const upstreamOutput = processMap[edge.src]?.outputAmounts[edge.flowUuid] ?? 1;
      const safeUpstreamOutput = Math.abs(upstreamOutput) < EPSILON ? 1 : upstreamOutput;
      const delta = (currentFactor * edge.downstreamInputAmount) / safeUpstreamOutput;
      factors[edge.src] += delta;
    });
  });

  return factors;
}

function exchangeAmount(exchange: JsonRecord): number {
  return numberOrZero(exchange.meanAmount ?? exchange.resultingAmount);
}

function cloneExchangeWithAmount(
  exchange: JsonRecord,
  amount: number,
  internalId: string,
  quantitativeReference = false,
): JsonRecord {
  const cloned = copyJson(exchange);
  cloned['@dataSetInternalID'] = internalId;
  const amountValue = toJsonNumber(amount);
  cloned.meanAmount = amountValue;
  if ('resultingAmount' in cloned) {
    cloned.resultingAmount = amountValue;
  }
  cloned.quantitativeReference = quantitativeReference;
  return cloned;
}

function buildProcessInstances(
  processMap: Record<string, ProcessRecord>,
  order: string[],
  edges: Edge[],
  factors: Record<string, number>,
): { processInstances: JsonRecord[]; internalIds: Record<string, string> } {
  const internalIds = Object.fromEntries(
    order.map((processId, index) => [processId, String(index + 1)]),
  );
  const outgoing = new Map<string, Edge[]>();
  edges.forEach((edge) => {
    if (!(edge.src in internalIds) || !(edge.dst in internalIds)) {
      return;
    }
    const bucket = outgoing.get(edge.src) ?? [];
    bucket.push(edge);
    outgoing.set(edge.src, bucket);
  });

  const processInstances = order.map((processId) => {
    const record = processMap[processId] as ProcessRecord;
    const dataset = record.raw.processDataSet as JsonRecord;
    const processInformation = isRecord(dataset.processInformation)
      ? dataset.processInformation
      : {};
    const dataSetInformation = isRecord(processInformation.dataSetInformation)
      ? processInformation.dataSetInformation
      : {};
    const nameInfo = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
    const shortDescription = copyJson(nameInfo.baseName ?? []);
    const outputGroups: JsonRecord[] = [];
    const byFlow = new Map<string, Edge[]>();

    (outgoing.get(processId) ?? []).forEach((edge) => {
      const bucket = byFlow.get(edge.flowUuid) ?? [];
      bucket.push(edge);
      byFlow.set(edge.flowUuid, bucket);
    });

    byFlow.forEach((groupedEdges, flowUuid) => {
      const downstreamPayload = groupedEdges.map((edge) => ({
        '@id': internalIds[edge.dst],
        '@flowUUID': flowUuid,
        '@dominant': 'true',
      }));
      outputGroups.push({
        '@dominant': 'true',
        '@flowUUID': flowUuid,
        downstreamProcess:
          downstreamPayload.length === 1 ? downstreamPayload[0] : downstreamPayload,
      });
    });

    return {
      '@dataSetInternalID': internalIds[processId],
      '@multiplicationFactor': formatNumber(factors[processId] ?? 0),
      referenceToProcess: buildGlobalReference(
        record.processUuid,
        record.version,
        shortDescription,
        'process data set',
        `../processes/${record.processUuid}_${record.version}.xml`,
      ),
      ...(outputGroups.length > 0
        ? {
            connections: {
              outputExchange: outputGroups.length === 1 ? outputGroups[0] : outputGroups,
            },
          }
        : {}),
    };
  });

  return { processInstances, internalIds };
}

function buildLifecycleModelDataset(
  runName: string,
  state: JsonRecord,
  processMap: Record<string, ProcessRecord>,
  order: string[],
  edges: Edge[],
  factors: Record<string, number>,
  finalProcessId: string,
): { model: JsonRecord; summary: JsonRecord } {
  const finalRecord = processMap[finalProcessId] as ProcessRecord;
  const finalDataset = isRecord(finalRecord.raw.processDataSet)
    ? finalRecord.raw.processDataSet
    : {};
  const finalProcessInformation = isRecord(finalDataset.processInformation)
    ? finalDataset.processInformation
    : {};
  const finalInfo = isRecord(finalProcessInformation.dataSetInformation)
    ? finalProcessInformation.dataSetInformation
    : {};
  const finalName = isRecord(finalInfo.name) ? finalInfo.name : {};

  const flowDataset = extractFlowDatasetFromState(state);
  const flowInformation = isRecord(flowDataset.flowInformation) ? flowDataset.flowInformation : {};
  const flowInfo = isRecord(flowInformation.dataSetInformation)
    ? flowInformation.dataSetInformation
    : {};
  const flowName = isRecord(flowInfo.name) ? flowInfo.name : {};
  const flowSummary = isRecord(state.flow_summary) ? state.flow_summary : {};
  const modelUuid = uuid5FromText(UUID_NAMESPACE_URL, runName);
  const modelVersion = '01.01.000';
  const { processInstances, internalIds } = buildProcessInstances(
    processMap,
    order,
    edges,
    factors,
  );

  const administrativeInformation = isRecord(finalDataset.administrativeInformation)
    ? finalDataset.administrativeInformation
    : {};
  const commissionerAndGoal = copyJson(
    administrativeInformation['common:commissionerAndGoal'] ??
      administrativeInformation.commissionerAndGoal ??
      {},
  );
  const dataEntryBy = copyJson(
    administrativeInformation.dataEntryBy ?? administrativeInformation['common:dataEntryBy'] ?? {},
  );
  if (isRecord(dataEntryBy)) {
    const enteringRef = dataEntryBy['common:referenceToPersonOrEntityEnteringTheData'];
    if (enteringRef !== undefined) {
      dataEntryBy['common:referenceToPersonOrEntityEnteringTheDataSet'] = copyJson(enteringRef);
    }
  }

  const publication = copyJson(resolvePublicationBlock(finalDataset));
  publication['common:dataSetVersion'] = modelVersion;
  publication['common:permanentDataSetURI'] =
    `https://local.tiangong.invalid/lifecyclemodels/${modelUuid}?version=${modelVersion}`;
  if (!Array.isArray(publication['common:accessRestrictions'])) {
    publication['common:accessRestrictions'] = [];
  }

  const modellingAndValidation = isRecord(finalDataset.modellingAndValidation)
    ? finalDataset.modellingAndValidation
    : {};
  const complianceDeclarations = isRecord(modellingAndValidation.complianceDeclarations)
    ? modellingAndValidation.complianceDeclarations
    : {};
  const compliance = copyJson(
    isRecord(complianceDeclarations.compliance) ? complianceDeclarations.compliance : {},
  );
  compliance['common:approvalOfOverallCompliance'] ??= 'Fully compliant';
  compliance['common:nomenclatureCompliance'] ??= 'Not defined';
  compliance['common:methodologicalCompliance'] ??= 'Not defined';
  compliance['common:reviewCompliance'] ??= 'Not defined';
  compliance['common:documentationCompliance'] ??= 'Not defined';
  compliance['common:qualityCompliance'] ??= 'Not defined';

  const reviewRef =
    (isRecord(commissionerAndGoal)
      ? commissionerAndGoal['common:referenceToCommissioner']
      : undefined) ??
    (isRecord(dataEntryBy)
      ? dataEntryBy['common:referenceToPersonOrEntityEnteringTheDataSet']
      : undefined) ??
    publication['common:referenceToOwnershipOfDataSet'] ??
    {};

  const review = {
    'common:referenceToNameOfReviewerAndInstitution': copyJson(reviewRef),
    'common:otherReviewDetails': multilangFromText(
      'Local native CLI lifecyclemodel auto-build artifact; not independently reviewed.',
      '本地原生 CLI lifecyclemodel auto-build 产物，未经过独立评审。',
    ),
  };

  const generalComment = ensureList(finalInfo['common:generalComment']).filter(
    (item) => item !== undefined,
  );
  generalComment.push(
    ...multilangFromText(
      `Built locally from process-automated-builder run ${runName}. ${nonEmptyString(state.technical_description) ?? ''}`.trim(),
      `本地基于 process-automated-builder 运行 ${runName} 生成。`,
    ),
  );
  generalComment.push(
    ...multilangFromText(
      'This CLI slice emits native json_ordered only. Platform-specific derivations stay in later publish flows.',
      '该 CLI 切片只产出原生 json_ordered。平台特有衍生字段保留在后续发布流程。',
    ),
  );

  const resultingProcess = buildGlobalReference(
    modelUuid,
    modelVersion,
    copyJson(flowName.baseName ?? finalName.baseName ?? []),
    'process data set',
    `../processes/${modelUuid}_${modelVersion}.xml`,
  );

  const model = {
    lifeCycleModelDataSet: {
      '@xmlns': 'http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@xsi:schemaLocation':
        'http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017 ../../schemas/ILCD_LifeCycleModelDataSet.xsd',
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': modelUuid,
          name: {
            baseName: copyJson(flowName.baseName ?? finalName.baseName ?? []),
            treatmentStandardsRoutes: copyJson(
              flowName.treatmentStandardsRoutes ?? finalName.treatmentStandardsRoutes ?? [],
            ),
            mixAndLocationTypes: copyJson(
              flowName.mixAndLocationTypes ?? finalName.mixAndLocationTypes ?? [],
            ),
            functionalUnitFlowProperties: multilangFromText(
              `Reference process output scaled to 1 unit of ${nonEmptyString(flowSummary.base_name_en) ?? nonEmptyString(flowSummary.base_name) ?? firstText(flowName.baseName)}`,
              `参考过程输出缩放到 1 单位 ${nonEmptyString(flowSummary.base_name_zh) ?? nonEmptyString(flowSummary.base_name) ?? ''}`,
            ),
          },
          classificationInformation: copyJson(finalInfo.classificationInformation ?? {}),
          referenceToResultingProcess: resultingProcess,
          'common:generalComment': generalComment,
        },
        quantitativeReference: {
          referenceToReferenceProcess: internalIds[finalProcessId],
        },
        technology: {
          processes: {
            processInstance: processInstances.length === 1 ? processInstances[0] : processInstances,
          },
        },
      },
      modellingAndValidation: {
        dataSourcesTreatmentEtc: {
          useAdviceForDataSet: multilangFromText(
            nonEmptyString(state.scope) ??
              'Built from local process exports and shared-flow graph inference.',
            '基于本地 process 导出结果和共享 flow 图推断生成。',
          ),
        },
        validation: {
          review,
        },
        complianceDeclarations: {
          compliance,
        },
      },
      administrativeInformation: {
        'common:commissionerAndGoal': commissionerAndGoal,
        dataEntryBy,
        publicationAndOwnership: publication,
      },
    },
  };

  return {
    model,
    summary: {
      run_name: runName,
      model_uuid: modelUuid,
      model_version: modelVersion,
      reference_process_uuid: finalProcessId,
      reference_process_internal_id: internalIds[finalProcessId],
      reference_flow_uuid: nonEmptyString(flowSummary.uuid),
      reference_to_resulting_process_uuid: modelUuid,
      process_count: order.length,
      edge_count: edges.length,
      multiplication_factors: Object.fromEntries(
        order.map((processId) => [processId, formatNumber(factors[processId] ?? 0)]),
      ),
      ordered_processes: order.map((processId) => {
        const record = processMap[processId] as ProcessRecord;
        return {
          process_uuid: processId,
          name_en: record.nameEn,
          name_zh: record.nameZh,
          route_en: record.routeEn,
          geography_code: record.geographyCode,
          classification_path: record.classificationPath,
        };
      }),
      source_counts: {
        local_run_export: Object.keys(processMap).length,
        used_local_run_processes: order.length,
      },
    },
  };
}

function buildLocalModels(
  normalized: NormalizedLifecyclemodelAutoBuildRequest,
  layout: LifecyclemodelAutoBuildLayout,
): LifecyclemodelAutoBuildLocalReport[] {
  return normalized.local_runs.map((runDir) => {
    const statePath = path.join(runDir, 'cache', 'process_from_flow_state.json');
    const processDir = path.join(runDir, 'exports', 'processes');

    if (!existsSync(statePath)) {
      throw new CliError(`lifecyclemodel auto-build run is missing state file: ${runDir}`, {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_STATE_NOT_FOUND',
        exitCode: 2,
      });
    }

    if (!existsSync(processDir)) {
      throw new CliError(`lifecyclemodel auto-build run is missing exported processes: ${runDir}`, {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_PROCESS_EXPORTS_NOT_FOUND',
        exitCode: 2,
      });
    }

    const state = readJsonInput(statePath);
    if (!isRecord(state)) {
      throw new CliError(`lifecyclemodel auto-build state must be a JSON object: ${statePath}`, {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_STATE_INVALID',
        exitCode: 2,
      });
    }

    const processFiles = readdirSync(processDir)
      .filter((item) => item.endsWith('.json'))
      .sort()
      .map((item) => path.join(processDir, item));

    if (processFiles.length === 0) {
      throw new CliError(
        `lifecyclemodel auto-build run has no exported process JSON files: ${runDir}`,
        {
          code: 'LIFECYCLEMODEL_AUTO_BUILD_PROCESS_EXPORTS_EMPTY',
          exitCode: 2,
        },
      );
    }

    const processMap = Object.fromEntries(
      processFiles.map((filePath) => {
        const record = loadProcessRecord(filePath, 'local_run_export', runDir);
        return [record.processUuid, record];
      }),
    );

    const edges = inferEdges(processMap);
    const preferredProcessIds = new Set(Object.keys(processMap));
    const finalProcessId = chooseReferenceProcess(processMap, edges, state, preferredProcessIds);
    const reachable = collectReachable(finalProcessId, edges);
    const order = topologicalOrder(reachable, edges);
    const filteredEdges = edges.filter(
      (edge) => reachable.has(edge.src) && reachable.has(edge.dst),
    );
    const factors = computeMultiplicationFactors(
      processMap,
      reachable,
      filteredEdges,
      order,
      finalProcessId,
    );
    const runName = path.basename(runDir);
    const { model, summary } = buildLifecycleModelDataset(
      runName,
      state,
      processMap,
      order,
      filteredEdges,
      factors,
      finalProcessId,
    );
    const nameIssues = collectDatasetNameIssues(model, 'lifecyclemodel');
    if (nameIssues.length > 0) {
      throw new CliError('Lifecyclemodel name fields must use commas instead of semicolons.', {
        code: 'LIFECYCLEMODEL_AUTO_BUILD_NAME_INVALID',
        exitCode: 2,
        details: { runName, issues: nameIssues },
      });
    }
    const runOut = path.join(layout.modelsDir, runName);
    const bundleOut = path.join(runOut, 'tidas_bundle', 'lifecyclemodels');
    mkdirSync(bundleOut, { recursive: true });

    const modelUuid = summary.model_uuid as string;
    const modelVersion = summary.model_version as string;
    const modelFile = path.join(bundleOut, `${modelUuid}_${modelVersion}.json`);
    const summaryFile = path.join(runOut, 'summary.json');
    const connectionsFile = path.join(runOut, 'connections.json');
    const processCatalogFile = path.join(runOut, 'process-catalog.json');

    writeJsonArtifact(modelFile, model);
    writeJsonArtifact(summaryFile, summary);
    writeJsonArtifact(
      connectionsFile,
      filteredEdges.map((edge) => ({
        src: edge.src,
        dst: edge.dst,
        flow_uuid: edge.flowUuid,
        downstream_input_amount: formatNumber(edge.downstreamInputAmount),
        confidence: formatNumber(edge.confidence),
        reasons: edge.reasons,
        src_name_en: processMap[edge.src].nameEn,
        dst_name_en: processMap[edge.dst].nameEn,
        src_source_kind: processMap[edge.src].sourceKind,
        dst_source_kind: processMap[edge.dst].sourceKind,
      })),
    );
    writeJsonArtifact(
      processCatalogFile,
      Object.entries(processMap)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([processId, record]) => ({
          process_uuid: processId,
          name_en: record.nameEn,
          name_zh: record.nameZh,
          route_en: record.routeEn,
          mix_en: record.mixEn,
          geography_code: record.geographyCode,
          classification_path: record.classificationPath,
          reference_flow_uuid: record.referenceFlowUuid,
          reference_direction: record.referenceDirection,
          reference_amount: formatNumber(record.referenceAmount),
          input_flow_count: Object.keys(record.inputAmounts).length,
          output_flow_count: Object.keys(record.outputAmounts).length,
          source_kind: record.sourceKind,
          source_label: record.sourceLabel,
          included_process_ref_count: record.includedProcessRefCount,
        })),
    );

    return {
      run_dir: runDir,
      run_name: runName,
      model_file: modelFile,
      summary_file: summaryFile,
      connections_file: connectionsFile,
      process_catalog_file: processCatalogFile,
      summary,
    };
  });
}

function buildNextActions(layout: LifecyclemodelAutoBuildLayout): string[] {
  return [
    `inspect: ${layout.runPlanPath}`,
    `inspect: ${layout.modelsDir}`,
    `run: tiangong-lca lifecyclemodel validate-build --run-dir ${layout.runRoot}`,
    `run: tiangong-lca lifecyclemodel publish-build --run-dir ${layout.runRoot}`,
  ];
}

function buildReport(
  normalized: NormalizedLifecyclemodelAutoBuildRequest,
  layout: LifecyclemodelAutoBuildLayout,
  localBuildReports: LifecyclemodelAutoBuildLocalReport[],
  now: Date,
): LifecyclemodelAutoBuildReport {
  return {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    status: 'completed_local_lifecyclemodel_auto_build_run',
    request_path: normalized.request_path,
    run_id: normalized.run_id,
    run_root: normalized.run_root,
    local_run_count: normalized.local_runs.length,
    built_model_count: localBuildReports.length,
    files: {
      request_snapshot: layout.requestSnapshotPath,
      normalized_request: layout.normalizedRequestPath,
      run_plan: layout.runPlanPath,
      resolved_manifest: layout.resolvedManifestPath,
      selection_brief: layout.selectionBriefPath,
      reference_model_summary: layout.referenceModelSummaryPath,
      invocation_index: layout.invocationIndexPath,
      run_manifest: layout.runManifestPath,
      report: layout.reportPath,
    },
    local_build_reports: localBuildReports,
    next_actions: buildNextActions(layout),
  };
}

export async function runLifecyclemodelAutoBuild(
  options: RunLifecyclemodelAutoBuildOptions,
): Promise<LifecyclemodelAutoBuildReport> {
  const input = options.inputValue ?? readJsonInput(options.inputPath);
  const now = options.now ?? new Date();
  const normalized = normalizeLifecyclemodelAutoBuildRequest(input, {
    inputPath: options.inputPath,
    outDir: options.outDir,
    now,
    runIdOverride: options.runIdOverride,
  });
  const layout = buildLayout(normalized.run_root, normalized.run_id);

  ensureEmptyRunRoot(layout.runRoot);
  ensureLayout(layout);

  writeJsonArtifact(layout.requestSnapshotPath, input);
  writeJsonArtifact(layout.normalizedRequestPath, normalized);
  writeTextArtifact(layout.selectionBriefPath, buildSelectionBrief(normalized.manifest));
  writeJsonArtifact(
    layout.referenceModelSummaryPath,
    buildReferenceModelSummary(normalized.manifest),
  );
  writeJsonArtifact(layout.resolvedManifestPath, normalized.manifest);
  writeJsonArtifact(
    layout.invocationIndexPath,
    buildInvocationIndex(normalized, options, layout, now),
  );
  writeJsonArtifact(
    layout.runManifestPath,
    buildRunManifest({
      layout,
      command: options.outDir
        ? [
            'lifecyclemodel',
            'auto-build',
            '--input',
            options.inputPath,
            '--out-dir',
            options.outDir,
          ]
        : ['lifecyclemodel', 'auto-build', '--input', options.inputPath],
      cwd: options.cwd,
      createdAt: now,
    }),
  );

  const plan = buildPlan(normalized, layout, now);
  writeJsonArtifact(layout.runPlanPath, plan);

  const localBuildReports = buildLocalModels(normalized, layout);
  const completedPlan = {
    ...plan,
    local_build_reports: localBuildReports,
  };
  writeJsonArtifact(layout.runPlanPath, completedPlan);

  const report = buildReport(normalized, layout, localBuildReports, now);
  writeJsonArtifact(layout.reportPath, report);
  writeLatestRunId(layout, normalized.run_id);
  return report;
}

export const __testInternals = {
  DEFAULT_MANIFEST,
  copyJson,
  ensureList,
  numberOrZero,
  firstText,
  langTextMap,
  localizedText,
  multilangText,
  multilangFromText,
  deepMerge,
  buildLayout,
  buildSelectionBrief,
  buildReferenceModelSummary,
  normalizeLocalRuns,
  uuid5FromText,
  extractClassificationPath,
  classificationOverlap,
  extractFlowDatasetFromState,
  resolvePublicationBlock,
  loadProcessRecord,
  scoreEdgeCandidate,
  inferEdges,
  chooseReferenceProcess,
  collectReachable,
  topologicalOrder,
  computeMultiplicationFactors,
  exchangeAmount,
  cloneExchangeWithAmount,
  buildProcessInstances,
  buildLifecycleModelDataset,
  buildPlan,
  formatNumber,
  buildNameSummary,
  toJsonNumber,
};
