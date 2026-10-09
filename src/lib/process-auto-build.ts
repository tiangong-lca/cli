import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import { readJsonInput } from './io.js';
import {
  buildRunManifest,
  buildUtcTimestamp,
  ensureRunLayout,
  type RunLayout,
  sanitizeRunToken,
  writeLatestRunId,
} from './run.js';
import { withStateFileLock } from './state-lock.js';

type JsonRecord = Record<string, unknown>;

export type ProcessAutoBuildOperation = 'produce' | 'treat';
export type ProcessAutoBuildSourceInputType = 'local_file' | 'local_text';

export type ProcessAutoBuildSourcePolicy = {
  step1_route: {
    preferred: string[];
    fallback: string;
  };
  step2_process_split: {
    preferred: string[];
    fallback: string;
  };
  step3b_exchange_values: {
    preferred: string[];
    require_numeric_evidence: boolean;
    allow_estimation: boolean;
  };
};

export type ProcessAutoBuildFlowSummary = {
  wrapper: 'flowDataSet' | 'direct';
  uuid: string | null;
  version: string | null;
  base_name: string | null;
  permanent_uri: string | null;
};

export type NormalizedProcessAutoBuildSourceInput = {
  source_id: string;
  type: ProcessAutoBuildSourceInputType;
  source_path: string;
  artifact_path: string;
  artifact_file_name: string;
  intended_roles: string[];
};

export type NormalizedProcessAutoBuildRequest = {
  schema_version: 1;
  request_path: string;
  request_id: string;
  flow_file: string;
  flow_summary: ProcessAutoBuildFlowSummary;
  flow_dataset: JsonRecord;
  operation: ProcessAutoBuildOperation;
  run_id: string;
  run_root: string;
  source_inputs: NormalizedProcessAutoBuildSourceInput[];
  source_policy: ProcessAutoBuildSourcePolicy;
};

export type ProcessAutoBuildLayout = RunLayout & {
  requestDir: string;
  evidenceDir: string;
  evidenceIncomingDir: string;
  evidenceNormalizedDir: string;
  evidenceTextDir: string;
  evidenceStructuredDir: string;
  stageOutputsDir: string;
  reviewsDir: string;
  requestSnapshotPath: string;
  normalizedRequestPath: string;
  sourcePolicyPath: string;
  flowSummaryPath: string;
  inputManifestPath: string;
  buildPlanPath: string;
  assemblyPlanPath: string;
  lineageManifestPath: string;
  invocationIndexPath: string;
  runManifestPath: string;
  reportPath: string;
  statePath: string;
  handoffSummaryPath: string;
  processExportsDir: string;
  sourceExportsDir: string;
};

export type ProcessAutoBuildReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'prepared_local_process_auto_build_run';
  request_path: string;
  request_id: string;
  run_id: string;
  run_root: string;
  operation: ProcessAutoBuildOperation;
  flow: {
    source_path: string;
    artifact_path: string;
    wrapper: 'flowDataSet' | 'direct';
    uuid: string | null;
    version: string | null;
    base_name: string | null;
  };
  source_input_count: number;
  stage_count: number;
  files: {
    request_snapshot: string;
    normalized_request: string;
    source_policy: string;
    flow_summary: string;
    input_manifest: string;
    build_plan: string;
    assembly_plan: string;
    lineage_manifest: string;
    invocation_index: string;
    run_manifest: string;
    state: string;
    handoff_summary: string;
    report: string;
  };
  next_actions: string[];
};

export type RunProcessAutoBuildOptions = {
  inputPath: string;
  outDir?: string | null;
  now?: Date;
  cwd?: string;
  inputValue?: unknown;
  requestIdOverride?: string;
  runIdOverride?: string;
};

type ProcessAutoBuildStage = {
  id: string;
  title: string;
  output: string;
  createsCandidatesDir: boolean;
  modules: string[];
};

const DEFAULT_SOURCE_POLICY: ProcessAutoBuildSourcePolicy = {
  step1_route: {
    preferred: ['user_bundle', 'kb_bundle'],
    fallback: 'expert_judgement',
  },
  step2_process_split: {
    preferred: ['user_bundle.process_split', 'si_bundle', 'kb_bundle.process_split'],
    fallback: 'expert_judgement',
  },
  step3b_exchange_values: {
    preferred: ['user_bundle.exchange_values', 'si_bundle', 'kb_bundle.exchange_values'],
    require_numeric_evidence: true,
    allow_estimation: true,
  },
};

const PROCESS_AUTO_BUILD_STAGES: ProcessAutoBuildStage[] = [
  {
    id: '01_route',
    title: 'Route planning',
    output: 'stage_outputs/01_route/route_plan.json',
    createsCandidatesDir: true,
    modules: ['kb-search', 'llm'],
  },
  {
    id: '02_process_split',
    title: 'Process chain split',
    output: 'stage_outputs/02_process_split/process_chain.json',
    createsCandidatesDir: true,
    modules: ['llm'],
  },
  {
    id: '03_exchange_plan',
    title: 'Exchange planning',
    output: 'stage_outputs/03_exchange_plan/exchange_plan.json',
    createsCandidatesDir: false,
    modules: ['llm'],
  },
  {
    id: '04_exchange_values',
    title: 'Exchange value extraction',
    output: 'stage_outputs/04_exchange_values/exchange_values.json',
    createsCandidatesDir: true,
    modules: ['unstructured', 'kb-search', 'llm'],
  },
  {
    id: '05_chain_review',
    title: 'Chain review',
    output: 'stage_outputs/05_chain_review/chain_review.json',
    createsCandidatesDir: false,
    modules: ['llm'],
  },
  {
    id: '06_flow_match',
    title: 'Flow matching',
    output: 'stage_outputs/06_flow_match/flow_match_bundle.json',
    createsCandidatesDir: false,
    modules: ['search:flow', 'llm'],
  },
  {
    id: '07_source_build',
    title: 'Source dataset build',
    output: 'stage_outputs/07_source_build/source_bundle.json',
    createsCandidatesDir: false,
    modules: ['validation'],
  },
  {
    id: '08_process_build',
    title: 'Process dataset build',
    output: 'stage_outputs/08_process_build/process_bundle.json',
    createsCandidatesDir: false,
    modules: ['validation', 'llm'],
  },
  {
    id: '09_qa',
    title: 'QA and balance review',
    output: 'stage_outputs/09_qa/qa_bundle.json',
    createsCandidatesDir: false,
    modules: ['validation', 'llm'],
  },
  {
    id: '10_publish',
    title: 'Publish handoff',
    output: 'stage_outputs/10_publish/publish_bundle.json',
    createsCandidatesDir: false,
    modules: ['publish'],
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function extractText(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractText(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if ('#text' in value) {
    return nonEmptyString(value['#text']);
  }

  return null;
}

function requiredRequestObject(input: unknown): JsonRecord {
  if (!isRecord(input)) {
    throw new CliError('process auto-build request must be a JSON object.', {
      code: 'PROCESS_AUTO_BUILD_REQUEST_INVALID',
      exitCode: 2,
    });
  }

  return input;
}

function requiredRequestString(input: JsonRecord, key: string): string {
  const value = nonEmptyString(input[key]);
  if (!value) {
    throw new CliError(`process auto-build request is missing '${key}'.`, {
      code: 'PROCESS_AUTO_BUILD_REQUEST_INVALID',
      exitCode: 2,
      details: { key },
    });
  }

  return value;
}

function normalizeOperation(value: unknown): ProcessAutoBuildOperation {
  const normalized = nonEmptyString(value);
  if (!normalized) {
    return 'produce';
  }
  if (normalized === 'produce' || normalized === 'treat') {
    return normalized;
  }

  throw new CliError("process auto-build operation must be 'produce' or 'treat'.", {
    code: 'PROCESS_AUTO_BUILD_OPERATION_INVALID',
    exitCode: 2,
    details: normalized,
  });
}

function normalizePreferredList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));

  return normalized.length ? normalized : [...fallback];
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function buildDefaultSourcePolicy(): ProcessAutoBuildSourcePolicy {
  return {
    step1_route: {
      preferred: [...DEFAULT_SOURCE_POLICY.step1_route.preferred],
      fallback: DEFAULT_SOURCE_POLICY.step1_route.fallback,
    },
    step2_process_split: {
      preferred: [...DEFAULT_SOURCE_POLICY.step2_process_split.preferred],
      fallback: DEFAULT_SOURCE_POLICY.step2_process_split.fallback,
    },
    step3b_exchange_values: {
      preferred: [...DEFAULT_SOURCE_POLICY.step3b_exchange_values.preferred],
      require_numeric_evidence:
        DEFAULT_SOURCE_POLICY.step3b_exchange_values.require_numeric_evidence,
      allow_estimation: DEFAULT_SOURCE_POLICY.step3b_exchange_values.allow_estimation,
    },
  };
}

function normalizeSourcePolicy(value: unknown): ProcessAutoBuildSourcePolicy {
  if (!isRecord(value)) {
    return buildDefaultSourcePolicy();
  }

  const defaults = buildDefaultSourcePolicy();
  const step1Route = isRecord(value.step1_route) ? value.step1_route : {};
  const step2ProcessSplit = isRecord(value.step2_process_split) ? value.step2_process_split : {};
  const step3ExchangeValues = isRecord(value.step3b_exchange_values)
    ? value.step3b_exchange_values
    : {};

  return {
    step1_route: {
      preferred: normalizePreferredList(step1Route.preferred, defaults.step1_route.preferred),
      fallback: nonEmptyString(step1Route.fallback) ?? DEFAULT_SOURCE_POLICY.step1_route.fallback,
    },
    step2_process_split: {
      preferred: normalizePreferredList(
        step2ProcessSplit.preferred,
        defaults.step2_process_split.preferred,
      ),
      fallback:
        nonEmptyString(step2ProcessSplit.fallback) ??
        DEFAULT_SOURCE_POLICY.step2_process_split.fallback,
    },
    step3b_exchange_values: {
      preferred: normalizePreferredList(
        step3ExchangeValues.preferred,
        defaults.step3b_exchange_values.preferred,
      ),
      require_numeric_evidence: normalizeBoolean(
        step3ExchangeValues.require_numeric_evidence,
        DEFAULT_SOURCE_POLICY.step3b_exchange_values.require_numeric_evidence,
      ),
      allow_estimation: normalizeBoolean(
        step3ExchangeValues.allow_estimation,
        DEFAULT_SOURCE_POLICY.step3b_exchange_values.allow_estimation,
      ),
    },
  };
}

function extractFlowDatasetRoot(payload: unknown): {
  flowPayload: JsonRecord;
  flowDataset: JsonRecord;
  wrapper: 'flowDataSet' | 'direct';
} {
  if (!isRecord(payload)) {
    throw new CliError('process auto-build flow file must contain a JSON object.', {
      code: 'PROCESS_AUTO_BUILD_FLOW_INVALID',
      exitCode: 2,
    });
  }

  if (isRecord(payload.flowDataSet)) {
    return {
      flowPayload: payload,
      flowDataset: payload.flowDataSet,
      wrapper: 'flowDataSet',
    };
  }

  return {
    flowPayload: payload,
    flowDataset: payload,
    wrapper: 'direct',
  };
}

function extractFlowSummary(
  flowDataset: JsonRecord,
  wrapper: 'flowDataSet' | 'direct',
): ProcessAutoBuildFlowSummary {
  const flowInformation = isRecord(flowDataset.flowInformation) ? flowDataset.flowInformation : {};
  const dataSetInformation = isRecord(flowInformation.dataSetInformation)
    ? flowInformation.dataSetInformation
    : {};
  const administrativeInformation = isRecord(flowDataset.administrativeInformation)
    ? flowDataset.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  const name = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};

  return {
    wrapper,
    uuid:
      nonEmptyString(dataSetInformation['common:UUID']) ??
      nonEmptyString(flowDataset['@id']) ??
      null,
    version:
      nonEmptyString(publicationAndOwnership['common:dataSetVersion']) ??
      nonEmptyString(flowDataset['@version']) ??
      null,
    base_name: extractText(name.baseName),
    permanent_uri: nonEmptyString(publicationAndOwnership['common:permanentDataSetURI']) ?? null,
  };
}

function runIdToken(value: string | null | undefined, fallback: string): string {
  return sanitizeRunToken(value ?? '', fallback);
}

function buildProcessAutoBuildRunId(
  flowFilePath: string,
  operation: ProcessAutoBuildOperation,
  summary: ProcessAutoBuildFlowSummary,
  now: Date = new Date(),
): string {
  const stem = path.basename(flowFilePath, path.extname(flowFilePath));
  const parts = stem.split('_');
  const flowCode = runIdToken(parts[0] || summary.base_name || summary.uuid, 'flow');
  const flowUuidShort = runIdToken(parts[1] || summary.uuid, 'unknown').slice(0, 8);
  const operationToken = operation === 'treat' ? 'treat' : 'produce';

  return `pfw_${flowCode}_${flowUuidShort}_${operationToken}_${buildUtcTimestamp(now)}`;
}

function resolveRunRoot(
  requestDir: string,
  outDirOverride: string | null | undefined,
  requestRunRoot: unknown,
): string {
  const override = nonEmptyString(outDirOverride);
  if (override) {
    return path.resolve(requestDir, override);
  }

  const requestValue = nonEmptyString(requestRunRoot);
  if (requestValue) {
    return path.resolve(requestDir, requestValue);
  }

  throw new CliError(
    'Missing required process auto-build run root. Provide --out-dir or request.workspace_run_root.',
    {
      code: 'PROCESS_AUTO_BUILD_RUN_ROOT_REQUIRED',
      exitCode: 2,
    },
  );
}

function normalizeSourceInputType(value: unknown): ProcessAutoBuildSourceInputType {
  const normalized = nonEmptyString(value);
  if (normalized === 'local_file' || normalized === 'local_text') {
    return normalized;
  }

  throw new CliError(
    "process auto-build source_inputs[].type must be 'local_file' or 'local_text'.",
    {
      code: 'PROCESS_AUTO_BUILD_SOURCE_INVALID',
      exitCode: 2,
      details: { value },
    },
  );
}

function normalizeIntendedRoles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeSourceInputs(
  value: unknown,
  requestDir: string,
  evidenceIncomingDir: string,
): NormalizedProcessAutoBuildSourceInput[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CliError('process auto-build source_inputs must be an array when provided.', {
      code: 'PROCESS_AUTO_BUILD_SOURCE_INVALID',
      exitCode: 2,
    });
  }

  const seenIds = new Set<string>();

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliError('process auto-build source_inputs entries must be objects.', {
        code: 'PROCESS_AUTO_BUILD_SOURCE_INVALID',
        exitCode: 2,
        details: { index },
      });
    }

    const sourceId = requiredRequestString(entry, 'source_id');
    if (seenIds.has(sourceId)) {
      throw new CliError(`Duplicate process auto-build source_id: ${sourceId}`, {
        code: 'PROCESS_AUTO_BUILD_SOURCE_DUPLICATE',
        exitCode: 2,
      });
    }
    seenIds.add(sourceId);

    const sourcePath = path.resolve(requestDir, requiredRequestString(entry, 'path'));
    if (!existsSync(sourcePath)) {
      throw new CliError(`process auto-build source input not found: ${sourcePath}`, {
        code: 'PROCESS_AUTO_BUILD_SOURCE_NOT_FOUND',
        exitCode: 2,
      });
    }

    const extension = path.extname(sourcePath);
    const artifactFileName = `${String(index + 1).padStart(2, '0')}_${runIdToken(sourceId, 'source')}${extension}`;

    return {
      source_id: sourceId,
      type: normalizeSourceInputType(entry.type),
      source_path: sourcePath,
      artifact_file_name: artifactFileName,
      artifact_path: path.join(evidenceIncomingDir, artifactFileName),
      intended_roles: normalizeIntendedRoles(entry.intended_roles),
    };
  });
}

function buildLayout(runRoot: string, runId: string): ProcessAutoBuildLayout {
  const collectionDir = path.dirname(runRoot);
  const layout: RunLayout = {
    namespace: 'process_from_flow',
    runId,
    artifactsRoot: path.dirname(collectionDir),
    collectionDir,
    runRoot,
    cacheDir: path.join(runRoot, 'cache'),
    inputsDir: path.join(runRoot, 'input'),
    outputsDir: path.join(runRoot, 'exports'),
    reportsDir: path.join(runRoot, 'reports'),
    logsDir: path.join(runRoot, 'logs'),
    manifestsDir: path.join(runRoot, 'manifests'),
    latestRunIdPath: path.join(collectionDir, '.latest_run_id'),
  };

  return {
    ...layout,
    requestDir: path.join(runRoot, 'request'),
    evidenceDir: path.join(runRoot, 'evidence'),
    evidenceIncomingDir: path.join(runRoot, 'evidence', 'incoming'),
    evidenceNormalizedDir: path.join(runRoot, 'evidence', 'normalized'),
    evidenceTextDir: path.join(runRoot, 'evidence', 'text'),
    evidenceStructuredDir: path.join(runRoot, 'evidence', 'structured'),
    stageOutputsDir: path.join(runRoot, 'stage_outputs'),
    reviewsDir: path.join(runRoot, 'reviews'),
    requestSnapshotPath: path.join(runRoot, 'request', 'pff-request.json'),
    normalizedRequestPath: path.join(runRoot, 'request', 'request.normalized.json'),
    sourcePolicyPath: path.join(runRoot, 'request', 'source-policy.json'),
    flowSummaryPath: path.join(runRoot, 'manifests', 'flow-summary.json'),
    inputManifestPath: path.join(runRoot, 'input', 'input_manifest.json'),
    buildPlanPath: path.join(runRoot, 'manifests', 'process-build-plan.json'),
    assemblyPlanPath: path.join(runRoot, 'manifests', 'assembly-plan.json'),
    lineageManifestPath: path.join(runRoot, 'manifests', 'lineage-manifest.json'),
    invocationIndexPath: path.join(runRoot, 'manifests', 'invocation-index.json'),
    runManifestPath: path.join(runRoot, 'manifests', 'run-manifest.json'),
    reportPath: path.join(runRoot, 'reports', 'process-auto-build-report.json'),
    statePath: path.join(runRoot, 'cache', 'process_from_flow_state.json'),
    handoffSummaryPath: path.join(runRoot, 'cache', 'agent_handoff_summary.json'),
    processExportsDir: path.join(runRoot, 'exports', 'processes'),
    sourceExportsDir: path.join(runRoot, 'exports', 'sources'),
  };
}

function ensureEmptyRunRoot(runRoot: string): void {
  if (!existsSync(runRoot)) {
    return;
  }

  const entries = readdirSync(runRoot);
  if (entries.length > 0) {
    throw new CliError(`process auto-build run root already exists and is not empty: ${runRoot}`, {
      code: 'PROCESS_AUTO_BUILD_RUN_EXISTS',
      exitCode: 2,
    });
  }
}

function ensureProcessAutoBuildLayout(layout: ProcessAutoBuildLayout): void {
  ensureRunLayout(layout);
  [
    layout.requestDir,
    layout.evidenceDir,
    layout.evidenceIncomingDir,
    layout.evidenceNormalizedDir,
    layout.evidenceTextDir,
    layout.evidenceStructuredDir,
    layout.stageOutputsDir,
    layout.reviewsDir,
    layout.processExportsDir,
    layout.sourceExportsDir,
  ].forEach((dirPath) => {
    mkdirSync(dirPath, { recursive: true });
  });

  for (const stage of PROCESS_AUTO_BUILD_STAGES) {
    const stageDir = path.join(layout.stageOutputsDir, stage.id);
    mkdirSync(stageDir, { recursive: true });
    if (stage.createsCandidatesDir) {
      mkdirSync(path.join(stageDir, 'candidates'), { recursive: true });
    }
  }
}

function copyArtifactFile(sourcePath: string, targetPath: string, code: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    copyFileSync(sourcePath, targetPath);
  } catch (error) {
    throw new CliError(`Failed to copy artifact file: ${sourcePath}`, {
      code,
      exitCode: 1,
      details: String(error),
    });
  }
}

function buildAssemblyPlan(runRoot: string): JsonRecord {
  return {
    schema_version: 1,
    stages: PROCESS_AUTO_BUILD_STAGES.map((stage) => ({
      id: stage.id,
      title: stage.title,
      status: 'pending',
      modules: stage.modules,
      output: stage.output,
      candidates_dir: stage.createsCandidatesDir
        ? path.posix.join(path.posix.dirname(stage.output), 'candidates')
        : null,
      output_abs: path.join(runRoot, stage.output),
    })),
  };
}

function flowReferencePropertySummary(flowDataset: JsonRecord): {
  reference_property: string;
  reference_property_id: string | null;
  reference_unit: string | null;
} {
  const flowInformation = isRecord(flowDataset.flowInformation) ? flowDataset.flowInformation : {};
  const quantitativeReference = isRecord(flowInformation.quantitativeReference)
    ? flowInformation.quantitativeReference
    : {};
  const referenceId = nonEmptyString(quantitativeReference.referenceToReferenceFlowProperty);
  const flowProperties = isRecord(flowDataset.flowProperties) ? flowDataset.flowProperties : {};
  const propertyRows = Array.isArray(flowProperties.flowProperty)
    ? flowProperties.flowProperty
    : flowProperties.flowProperty
      ? [flowProperties.flowProperty]
      : [];
  const referenceProperty = propertyRows.find(
    (entry) =>
      isRecord(entry) && nonEmptyString(entry['@dataSetInternalID']) === (referenceId ?? '0'),
  );
  const propertyRef =
    isRecord(referenceProperty) && isRecord(referenceProperty.referenceToFlowPropertyDataSet)
      ? referenceProperty.referenceToFlowPropertyDataSet
      : {};
  const shortDescription = isRecord(propertyRef['common:shortDescription'])
    ? propertyRef['common:shortDescription']
    : {};
  const propertyText =
    extractText(shortDescription) ?? extractText(propertyRef['common:shortDescription']);

  return {
    reference_property: propertyText ?? 'Reference flow property',
    reference_property_id: nonEmptyString(propertyRef['@refObjectId']),
    reference_unit: null,
  };
}

function buildInitialProcessBuildPlan(
  normalized: NormalizedProcessAutoBuildRequest,
  flowArtifactPath: string,
): JsonRecord {
  const flowProperty = flowReferencePropertySummary(normalized.flow_dataset);
  const referenceFlowId =
    normalized.flow_summary.uuid ??
    nonEmptyString(normalized.flow_dataset['@id']) ??
    sanitizeRunToken(normalized.flow_summary.base_name ?? normalized.run_id, 'reference-flow');
  const referenceFlowVersion = normalized.flow_summary.version ?? '00.00.000';
  const baseName = normalized.flow_summary.base_name
    ? `${normalized.operation === 'treat' ? 'Treatment of' : 'Production of'} ${normalized.flow_summary.base_name}`
    : `${normalized.operation === 'treat' ? 'Treatment' : 'Production'} process from reference flow`;

  return {
    schema_version: 1,
    kind: 'process',
    ruleset: {
      id: 'process-authoring/strict',
      version: '1',
    },
    target: {
      geography: 'GLO',
      technology_route:
        normalized.operation === 'treat'
          ? 'Treatment route to be evidenced during process auto-build'
          : 'Production route to be evidenced during process auto-build',
      classification_path: [
        'Technosphere',
        normalized.operation === 'treat' ? 'Treatment' : 'Production',
        flowProperty.reference_property,
        normalized.flow_summary.base_name ?? 'Reference flow',
      ],
    },
    identity_decision: {
      decision: 'create_new',
      rationale:
        'Initial process auto-build scaffold; identity preflight must be rerun with remote/local candidates before write.',
    },
    evidence_manifest: {
      sources: [
        {
          id: `flow:${referenceFlowId}`,
          type: 'input_flow_dataset',
          path: flowArtifactPath,
          title: normalized.flow_summary.base_name ?? referenceFlowId,
          version: referenceFlowVersion,
        },
        ...normalized.source_inputs.map((source) => ({
          id: source.source_id,
          type: source.type,
          path: source.artifact_path,
          title: source.artifact_file_name,
          intended_roles: source.intended_roles,
        })),
      ],
      field_bindings: [
        { field_path: 'target', source_id: `flow:${referenceFlowId}` },
        { field_path: 'identity_decision.decision', source_id: `flow:${referenceFlowId}` },
        { field_path: 'unit_of_analysis', source_id: `flow:${referenceFlowId}` },
        { field_path: 'name_plan.base_name', source_id: `flow:${referenceFlowId}` },
        { field_path: 'target.geography', source_id: `flow:${referenceFlowId}` },
        { field_path: 'target.technology_route', source_id: `flow:${referenceFlowId}` },
        {
          field_path: 'quantitative_reference_plan.reference_flow_id',
          source_id: `flow:${referenceFlowId}`,
        },
      ],
    },
    unit_of_analysis: {
      target_kind: normalized.operation === 'treat' ? 'treatment' : 'process_from_flow_scaffold',
      decision: 'manual_review',
      functional_unit: {
        what:
          normalized.operation === 'treat'
            ? `treat ${normalized.flow_summary.base_name ?? 'the reference flow'}`
            : `produce ${normalized.flow_summary.base_name ?? 'the reference flow'}`,
        how_much: `1 ${flowProperty.reference_unit ?? flowProperty.reference_property}`,
        how_well: 'to be determined from source evidence before materialization',
        how_long: 'not determined in the initial scaffold',
      },
      reference_flow: {
        flow_identity: normalized.flow_summary.base_name ?? referenceFlowId,
        reference_unit: flowProperty.reference_unit ?? flowProperty.reference_property,
        reference_amount: 1,
        flow_property: flowProperty.reference_property,
      },
      declared_unit_allowed: false,
      scaling_evidence_status: 'source_required',
      notes: [
        'Initial scaffold only. A skill/Codex workflow must revise unit_of_analysis before build-plan materialize.',
      ],
    },
    name_plan: {
      base_name: baseName,
      treatment_standards_routes:
        normalized.operation === 'treat' ? 'treatment route' : 'production route',
      mix_and_location_types: 'global average',
      functional_unit_flow_properties:
        flowProperty.reference_unit ?? flowProperty.reference_property,
    },
    quantitative_reference_plan: {
      reference_flow_id: referenceFlowId,
      reference_flow_version: referenceFlowVersion,
      reference_flow_name: normalized.flow_summary.base_name ?? referenceFlowId,
      reference_flow_internal_id: '1',
      mean_amount: '1.0',
      resulting_amount: '1.0',
      reference_unit: flowProperty.reference_unit ?? flowProperty.reference_property,
    },
    flow_property_plan: flowProperty,
    exchange_plan: {
      exchanges: [],
    },
    materialization_readiness: {
      status: 'scaffold_only',
      next_required_steps: [
        'replace scaffold unit_of_analysis with a skill-authored decision artifact',
        'run process identity-preflight with local and remote candidates',
        'replace scaffold geography, technology, classification, exchange values, and annual volume with evidence-backed values',
        'document intended applications from the study goal or task brief and bind their evidence before materialization',
        'run process build-plan validate/materialize before save-draft or publish-build',
      ],
    },
  };
}

function buildLineageManifest(normalized: NormalizedProcessAutoBuildRequest): JsonRecord {
  return {
    schema_version: 1,
    request_id: normalized.request_id,
    run_id: normalized.run_id,
    flow: {
      source_path: normalized.flow_file,
      uuid: normalized.flow_summary.uuid,
      version: normalized.flow_summary.version,
      base_name: normalized.flow_summary.base_name,
    },
    source_inputs: normalized.source_inputs.map((source) => ({
      source_id: source.source_id,
      type: source.type,
      source_path: source.source_path,
      artifact_path: source.artifact_path,
      intended_roles: source.intended_roles,
    })),
  };
}

function buildInvocationIndex(
  normalized: NormalizedProcessAutoBuildRequest,
  options: RunProcessAutoBuildOptions,
  reportPath: string,
  now: Date,
): JsonRecord {
  const command = ['process', 'auto-build', '--input', options.inputPath];
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
        report_path: reportPath,
      },
    ],
  };
}

function buildStepMarkers(now: Date): JsonRecord {
  const completedAt = now.toISOString();
  const markers: JsonRecord = {
    intake_prepared: {
      status: 'completed',
      completed_at: completedAt,
    },
  };

  PROCESS_AUTO_BUILD_STAGES.forEach((stage) => {
    markers[stage.id] = {
      status: 'pending',
    };
  });

  return markers;
}

function buildInitialState(
  normalized: NormalizedProcessAutoBuildRequest,
  flowArtifactPath: string,
  now: Date,
): JsonRecord {
  return {
    schema_version: 1,
    build_status: 'intake_prepared',
    next_stage: PROCESS_AUTO_BUILD_STAGES[0]?.id ?? null,
    run_id: normalized.run_id,
    request_id: normalized.request_id,
    flow_path: normalized.flow_file,
    flow_artifact_path: flowArtifactPath,
    flow_dataset: normalized.flow_dataset,
    flow_summary: normalized.flow_summary,
    operation: normalized.operation,
    source_inputs: normalized.source_inputs,
    source_policy: normalized.source_policy,
    scientific_references: {
      source_inputs: normalized.source_inputs.map((source) => ({
        source_id: source.source_id,
        type: source.type,
        intended_roles: source.intended_roles,
        source_path: source.source_path,
      })),
    },
    processes: [],
    process_exchanges: [],
    matched_process_exchanges: [],
    process_datasets: [],
    source_datasets: [],
    coverage_metrics: {},
    coverage_history: [],
    step_markers: buildStepMarkers(now),
  };
}

function buildNextActions(layout: ProcessAutoBuildLayout): string[] {
  return [
    `inspect: ${layout.normalizedRequestPath}`,
    `inspect: ${layout.statePath}`,
    `inspect: ${layout.assemblyPlanPath}`,
    `future: tiangong-lca process resume-build --run-dir ${layout.runRoot}`,
    `future: tiangong-lca process publish-build --run-dir ${layout.runRoot}`,
  ];
}

function buildAgentHandoffSummary(
  normalized: NormalizedProcessAutoBuildRequest,
  layout: ProcessAutoBuildLayout,
  flowArtifactPath: string,
  now: Date,
): JsonRecord {
  return {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    run_id: normalized.run_id,
    command: 'process auto-build',
    flow_path: normalized.flow_file,
    operation: normalized.operation,
    stop_after: null,
    process_count: 0,
    matched_exchange_count: 0,
    process_dataset_count: 0,
    source_dataset_count: 0,
    remaining_placeholder_refs: 0,
    placeholder_examples: [],
    publish_summary: {},
    artifacts: {
      state_path: layout.statePath,
      timing_report: null,
      publish_summary: null,
      llm_cost_report: null,
      process_update_report: null,
      flow_auto_build_manifest: null,
      request_snapshot: layout.requestSnapshotPath,
      normalized_request: layout.normalizedRequestPath,
      assembly_plan: layout.assemblyPlanPath,
      build_plan: layout.buildPlanPath,
      flow_copy: flowArtifactPath,
    },
    next_actions: buildNextActions(layout),
    extra: {
      status: 'prepared_local_process_auto_build_run',
      request_id: normalized.request_id,
      source_input_count: normalized.source_inputs.length,
    },
  };
}

function buildReport(
  normalized: NormalizedProcessAutoBuildRequest,
  layout: ProcessAutoBuildLayout,
  flowArtifactPath: string,
  now: Date,
): ProcessAutoBuildReport {
  return {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    status: 'prepared_local_process_auto_build_run',
    request_path: normalized.request_path,
    request_id: normalized.request_id,
    run_id: normalized.run_id,
    run_root: normalized.run_root,
    operation: normalized.operation,
    flow: {
      source_path: normalized.flow_file,
      artifact_path: flowArtifactPath,
      wrapper: normalized.flow_summary.wrapper,
      uuid: normalized.flow_summary.uuid,
      version: normalized.flow_summary.version,
      base_name: normalized.flow_summary.base_name,
    },
    source_input_count: normalized.source_inputs.length,
    stage_count: PROCESS_AUTO_BUILD_STAGES.length,
    files: {
      request_snapshot: layout.requestSnapshotPath,
      normalized_request: layout.normalizedRequestPath,
      source_policy: layout.sourcePolicyPath,
      flow_summary: layout.flowSummaryPath,
      input_manifest: layout.inputManifestPath,
      build_plan: layout.buildPlanPath,
      assembly_plan: layout.assemblyPlanPath,
      lineage_manifest: layout.lineageManifestPath,
      invocation_index: layout.invocationIndexPath,
      run_manifest: layout.runManifestPath,
      state: layout.statePath,
      handoff_summary: layout.handoffSummaryPath,
      report: layout.reportPath,
    },
    next_actions: buildNextActions(layout),
  };
}

export function normalizeProcessAutoBuildRequest(
  input: unknown,
  options: {
    inputPath: string;
    outDir?: string | null;
    now?: Date;
    requestIdOverride?: string;
    runIdOverride?: string;
  },
): NormalizedProcessAutoBuildRequest {
  const request = requiredRequestObject(input);
  const requestDir = path.dirname(path.resolve(options.inputPath));
  const operation = normalizeOperation(request.operation);
  const flowFile = path.resolve(requestDir, requiredRequestString(request, 'flow_file'));
  const flowPayload = readJsonInput(flowFile);
  const { flowDataset, wrapper } = extractFlowDatasetRoot(flowPayload);
  const flowSummary = extractFlowSummary(flowDataset, wrapper);
  const runId =
    nonEmptyString(options.runIdOverride) ??
    nonEmptyString(request.run_id) ??
    buildProcessAutoBuildRunId(flowFile, operation, flowSummary, options.now);
  const runRoot = resolveRunRoot(requestDir, options.outDir, request.workspace_run_root);
  const layout = buildLayout(runRoot, runId);

  return {
    schema_version: 1,
    request_path: path.resolve(options.inputPath),
    request_id:
      nonEmptyString(options.requestIdOverride) ??
      nonEmptyString(request.request_id) ??
      `pff-${runId}`,
    flow_file: flowFile,
    flow_summary: flowSummary,
    flow_dataset: flowDataset,
    operation,
    run_id: runId,
    run_root: runRoot,
    source_inputs: normalizeSourceInputs(
      request.source_inputs,
      requestDir,
      layout.evidenceIncomingDir,
    ),
    source_policy: normalizeSourcePolicy(request.source_policy),
  };
}

export async function runProcessAutoBuild(
  options: RunProcessAutoBuildOptions,
): Promise<ProcessAutoBuildReport> {
  const input = options.inputValue ?? readJsonInput(options.inputPath);
  const now = options.now ?? new Date();
  const normalized = normalizeProcessAutoBuildRequest(input, {
    inputPath: options.inputPath,
    outDir: options.outDir,
    now,
    requestIdOverride: options.requestIdOverride,
    runIdOverride: options.runIdOverride,
  });
  const layout = buildLayout(normalized.run_root, normalized.run_id);
  const flowArtifactPath = path.join(layout.inputsDir, path.basename(normalized.flow_file));

  ensureEmptyRunRoot(layout.runRoot);
  ensureProcessAutoBuildLayout(layout);

  copyArtifactFile(normalized.flow_file, flowArtifactPath, 'PROCESS_AUTO_BUILD_FLOW_COPY_FAILED');
  normalized.source_inputs.forEach((source) => {
    copyArtifactFile(
      source.source_path,
      source.artifact_path,
      'PROCESS_AUTO_BUILD_SOURCE_COPY_FAILED',
    );
  });

  const request = requiredRequestObject(input);
  writeJsonArtifact(layout.requestSnapshotPath, request);
  writeJsonArtifact(layout.normalizedRequestPath, normalized);
  writeJsonArtifact(layout.sourcePolicyPath, normalized.source_policy);
  writeJsonArtifact(layout.flowSummaryPath, normalized.flow_summary);
  writeJsonArtifact(layout.inputManifestPath, {
    run_id: normalized.run_id,
    flow_path: normalized.flow_file,
    flow_artifact_path: flowArtifactPath,
    operation: normalized.operation,
    build_plan_path: layout.buildPlanPath,
  });
  writeJsonArtifact(
    layout.buildPlanPath,
    buildInitialProcessBuildPlan(normalized, flowArtifactPath),
  );
  writeJsonArtifact(layout.assemblyPlanPath, buildAssemblyPlan(layout.runRoot));
  writeJsonArtifact(layout.lineageManifestPath, buildLineageManifest(normalized));
  writeJsonArtifact(
    layout.invocationIndexPath,
    buildInvocationIndex(normalized, options, layout.reportPath, now),
  );
  writeJsonArtifact(
    layout.runManifestPath,
    buildRunManifest({
      layout,
      command: options.outDir
        ? ['process', 'auto-build', '--input', options.inputPath, '--out-dir', options.outDir]
        : ['process', 'auto-build', '--input', options.inputPath],
      cwd: options.cwd,
      createdAt: now,
    }),
  );

  const state = buildInitialState(normalized, flowArtifactPath, now);
  await withStateFileLock(
    layout.statePath,
    { reason: 'process-auto-build.initial_state', now },
    () => writeJsonArtifact(layout.statePath, state),
  );

  const handoff = buildAgentHandoffSummary(normalized, layout, flowArtifactPath, now);
  writeJsonArtifact(layout.handoffSummaryPath, handoff);
  writeLatestRunId(layout, normalized.run_id);

  const report = buildReport(normalized, layout, flowArtifactPath, now);
  writeJsonArtifact(layout.reportPath, report);
  return report;
}

// Exposed for deterministic unit coverage of process auto-build normalization and scaffold helpers.
export const __testInternals = {
  PROCESS_AUTO_BUILD_STAGES,
  extractText,
  normalizeOperation,
  normalizeSourcePolicy,
  extractFlowDatasetRoot,
  extractFlowSummary,
  buildProcessAutoBuildRunId,
  buildLayout,
  buildAssemblyPlan,
  buildInitialProcessBuildPlan,
  buildLineageManifest,
  buildInvocationIndex,
  buildInitialState,
  buildAgentHandoffSummary,
  buildReport,
};
