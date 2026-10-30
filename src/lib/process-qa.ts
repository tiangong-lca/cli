import { collectDatasetNameIssues } from './dataset-name-validation.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact, writeTextArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  assessProcessMassBalance,
  readProcessMassReferences,
  type ProcessMassBalance,
} from './process-mass-balance.js';
import { readJsonInput } from './io.js';
import { getRuntimeRuleset, resolveRuntimeRuleId } from './runtime-rulesets.js';

type JsonRecord = Record<string, unknown>;

const KIND_RE = /\[tg_io_kind_tag=([^\]]+)\]/gu;
const UOM_RE = /\[tg_io_uom_tag=([^\]]+)\]/giu;

const ENERGY_WORDS = [
  'electric',
  'electricity',
  'kwh',
  'mj',
  'heat',
  'steam',
  'fuel',
  'diesel',
  'gas',
  'power',
  '电',
  '能',
] as const;

const RAW_WORDS = [
  'raw material',
  'feedstock',
  'fertilizer',
  'water',
  'seed',
  'pesticide',
  '原材料',
  '投入',
  '肥料',
  '种子',
  '农药',
  '用水',
] as const;

const BYP_WORDS = ['by-product', 'co-product', '副产品', '联产'] as const;
const WASTE_WORDS = ['waste', '废', 'residue', 'sludge'] as const;

type BaseInfoCheck = {
  source_name_ok: boolean;
  functional_unit_ok: boolean;
  system_boundary_ok: boolean;
  time_ok: boolean;
  geo_ok: boolean;
  tech_ok: boolean;
  admin_ok: boolean;
  completeness_score: number;
  base_names: string[];
};

type ClassifiedExchange = {
  classification:
    | 'raw_material_input'
    | 'energy_input'
    | 'other_input'
    | 'product_output'
    | 'byproduct_output'
    | 'waste_output'
    | 'other_output'
    | 'other';
  kinds: string[];
  uoms: string[];
  blob: string;
  source_input_group: string | null;
  source_output_group: string | null;
  reference_flow: boolean;
};

type UnitIssue = {
  flow_uuid: string;
  current_unit: string;
  suggested_unit: string;
  basis: string;
  confidence: string;
};

type ProcessQaRow = {
  process_file: string;
  other_output?: number | null;
  raw_input: number | null;
  product: number | null;
  byproduct: number | null;
  waste: number | null;
  energy_excluded: number | null;
  delta: number | null;
  relative_deviation: number | null;
};

type ProcessQaTotals = {
  other_output?: number | null;
  raw_input: number | null;
  product_plus_byproduct_plus_waste: number | null;
  delta: number | null;
  relative_deviation: number | null;
  energy_excluded: number | null;
};

type ProcessQaFinding = {
  process_file: string;
  severity: 'info' | 'warning' | 'blocker';
  code: string;
  methodology_rule_id: string | null;
  message: string;
  source: 'rule';
  evidence?: JsonRecord;
};

type ProcessRulesetGate = {
  status: 'passed' | 'needs_review' | 'blocked';
  ruleset_id: 'process-authoring/strict';
  ruleset_version: '1';
  ruleset_source_version: string;
  ruleset_rule_ids: string[];
  counts: {
    findings: number;
    blockers: number;
  };
  blockers: ProcessQaFinding[];
  next_action: 'continue' | 'review_findings_in_foundry' | 'fix_blockers';
};

type ProcessSummaryForLlm = {
  process_file: string;
  base_names: string[];
  base_checks: {
    source_name_ok: boolean;
    functional_unit_ok: boolean;
    system_boundary_ok: boolean;
    time_ok: boolean;
    geo_ok: boolean;
    tech_ok: boolean;
    admin_ok: boolean;
  };
  balance: {
    raw_in: number | null;
    product: number | null;
    byproduct: number | null;
    waste: number | null;
    energy_excluded: number | null;
    relative_deviation: number | null;
  };
};

export type ProcessQaLlmResult =
  | {
      enabled: false;
      reason: string;
    }
  | {
      enabled: true;
      ok: true;
      result: JsonRecord;
    }
  | {
      enabled: true;
      ok: false;
      reason: string;
      raw?: string;
    };

export type ProcessQaSummary = {
  mass_balance?: ProcessMassBalance[];
  run_id: string;
  logic_version: string;
  process_count: number;
  totals: ProcessQaTotals;
  ruleset_gate?: ProcessRulesetGate;
  llm: ProcessQaLlmResult;
  policy_decision_owner: 'foundry';
  qa_mode: 'deterministic_qa_report';
};

export type ProcessQaReport = {
  mass_balance?: ProcessMassBalance[];
  reference_evidence?: { path: string; bytes: number; sha256: string }[];
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed_local_process_qa';
  run_id: string;
  run_root: string;
  rows_file: string;
  out_dir: string;
  input_mode: 'rows_file' | 'run_root';
  effective_processes_dir: string;
  logic_version: string;
  ruleset_id?: 'process-authoring/strict';
  ruleset_version?: '1';
  ruleset_source_version?: string;
  ruleset_rule_ids?: string[];
  process_count: number;
  totals: ProcessQaTotals;
  rule_finding_count?: number;
  blocker_count?: number;
  ruleset_gate?: ProcessRulesetGate;
  policy_decision_owner: 'foundry';
  qa_mode: 'deterministic_qa_report';
  files: {
    qa_input_summary: string;
    materialization_summary: string | null;
    rule_findings?: string;
    ruleset_gate?: string;
    qa_zh: string;
    qa_en: string;
    timing: string;
    unit_issue_log: string;
    summary: string;
    report: string;
  };
  llm: ProcessQaLlmResult;
};

export type RunProcessQaOptions = {
  rowsFile?: string;
  referenceRowsFiles?: readonly string[];
  runRoot?: string;
  runId?: string;
  outDir: string;
  startTs?: string;
  endTs?: string;
  logicVersion?: string;
  enableLlm?: boolean;
  llmModel?: string;
  llmMaxProcesses?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredNonEmpty(value: string | undefined, label: string, code: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw new CliError(`Missing required ${label}.`, {
    code,
    exitCode: 2,
  });
}

function textFromValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((item) => String(item['#text'] ?? ''))
      .join(' ');
  }

  if (isRecord(value)) {
    return String(value['#text'] ?? '');
  }

  return String(value ?? '');
}

function deepGet(value: unknown, pathParts: string[]): unknown {
  let current: unknown = value;

  for (const key of pathParts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
    if (current === undefined || current === null) {
      return undefined;
    }
  }

  return current;
}

function hasNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasNonEmpty(item));
  }

  if (isRecord(value)) {
    if ('#text' in value) {
      return hasNonEmpty(value['#text']);
    }
    return Object.values(value).some((item) => hasNonEmpty(item));
  }

  return true;
}

function extractBaseNames(processPayload: JsonRecord): [boolean, string[]] {
  const base = deepGet(processPayload, [
    'processDataSet',
    'processInformation',
    'dataSetInformation',
    'name',
    'baseName',
  ]);
  const items = Array.isArray(base) ? base : base ? [base] : [];
  const values: string[] = [];

  items.forEach((item) => {
    if (!isRecord(item)) {
      return;
    }
    const text = String(item['#text'] ?? '').trim();
    if (!text) {
      return;
    }
    values.push(text);
  });

  return [values.length > 0, values];
}

function sourceTracePayload(exchange: JsonRecord): JsonRecord | null {
  const payload = deepGet(exchange, ['common:other', 'tidasimport:sourceTrace', 'payload']);
  if (!isRecord(payload)) {
    return null;
  }
  return isRecord(payload.sourceTrace) ? payload.sourceTrace : payload;
}

function sourceClassification(exchange: JsonRecord): JsonRecord {
  const payload = sourceTracePayload(exchange);
  return payload && isRecord(payload.sourceClassification) ? payload.sourceClassification : {};
}

function sourceGroup(exchange: JsonRecord, groupName: 'inputGroup' | 'outputGroup'): string | null {
  const value = sourceClassification(exchange)[groupName];
  const text = String(value ?? '').trim();
  return text || null;
}

function classifyExchange(
  exchange: JsonRecord,
  referenceFlowId: string | null = null,
): ClassifiedExchange {
  const comments = `${textFromValue(exchange.commonComment)} ${textFromValue(exchange.generalComment)}`;
  const flowDescription = textFromValue(
    isRecord(exchange.referenceToFlowDataSet)
      ? exchange.referenceToFlowDataSet['common:shortDescription']
      : undefined,
  );
  const rawBlob = `${comments} ${flowDescription}`.trim();
  const blob = rawBlob.toLowerCase();
  const kinds = Array.from(blob.matchAll(KIND_RE), (match) => match[1].toLowerCase());
  const kindSet = new Set(kinds);
  const uoms = Array.from(rawBlob.matchAll(UOM_RE), (match) => match[1]);
  const direction = String(exchange.exchangeDirection ?? '').toLowerCase();
  const inputGroup = sourceGroup(exchange, 'inputGroup');
  const outputGroup = sourceGroup(exchange, 'outputGroup');
  const internalId = String(exchange['@dataSetInternalID'] ?? '').trim();
  const isReferenceFlow = Boolean(referenceFlowId && internalId === referenceFlowId);
  const meta = {
    kinds,
    uoms,
    blob,
    source_input_group: inputGroup,
    source_output_group: outputGroup,
    reference_flow: isReferenceFlow,
  };
  const isEnergy =
    ENERGY_WORDS.some((word) => blob.includes(word)) ||
    uoms.some((uom) => uom === 'kwh' || uom === 'mj' || uom === 'gj');

  if (direction === 'input') {
    if (kindSet.has('energy') || isEnergy) {
      return { classification: 'energy_input', ...meta };
    }
    if (kindSet.has('waste')) {
      return { classification: 'other_input', ...meta };
    }
    if (inputGroup === '4' || kindSet.has('raw_material') || kindSet.has('resource')) {
      return { classification: 'raw_material_input', ...meta };
    }
    if (kindSet.has('product') || RAW_WORDS.some((word) => blob.includes(word))) {
      return { classification: 'raw_material_input', ...meta };
    }
    return { classification: 'other_input', ...meta };
  }

  if (direction === 'output') {
    if (isReferenceFlow || outputGroup === '0') {
      return { classification: 'product_output', ...meta };
    }
    if (
      kindSet.has('waste') ||
      outputGroup === '4' ||
      outputGroup === '5' ||
      WASTE_WORDS.some((word) => blob.includes(word))
    ) {
      return { classification: 'waste_output', ...meta };
    }
    if (BYP_WORDS.some((word) => blob.includes(word))) {
      return { classification: 'byproduct_output', ...meta };
    }
    if (kindSet.has('product')) {
      return { classification: 'product_output', ...meta };
    }
    return { classification: 'other_output', ...meta };
  }

  return { classification: 'other', ...meta };
}

function unitIssueCheck(exchange: JsonRecord, uoms: string[], blob: string): UnitIssue[] {
  const flowUuid = isRecord(exchange.referenceToFlowDataSet)
    ? String(exchange.referenceToFlowDataSet['@refObjectId'] ?? '')
    : '';

  if (!flowUuid) {
    return [];
  }

  const currentUnit = (uoms[0] ?? '').toLowerCase();
  if (
    ['electric', 'electricity', '交流电', '电力'].some((word) => blob.includes(word)) &&
    currentUnit &&
    !['kwh', 'mj', 'gj'].includes(currentUnit)
  ) {
    return [
      {
        flow_uuid: flowUuid,
        current_unit: currentUnit,
        suggested_unit: 'kWh',
        basis: 'flow 描述为电力/电能，但 uom 标签非能量单位',
        confidence: '高',
      },
    ];
  }

  if (
    ['water', '用水', '工艺用水'].some((word) => blob.includes(word)) &&
    currentUnit &&
    ['kwh', 'mj', 'gj'].includes(currentUnit)
  ) {
    return [
      {
        flow_uuid: flowUuid,
        current_unit: currentUnit,
        suggested_unit: 'm3 或 kg',
        basis: 'flow 描述为水，但 uom 标签为能量单位',
        confidence: '高',
      },
    ];
  }

  if (
    ['co2', 'carbon dioxide', '二氧化碳'].some((word) => blob.includes(word)) &&
    currentUnit &&
    ['kwh', 'mj', 'gj'].includes(currentUnit)
  ) {
    return [
      {
        flow_uuid: flowUuid,
        current_unit: currentUnit,
        suggested_unit: 'kg',
        basis: '排放流通常质量单位计，当前为能量单位',
        confidence: '中',
      },
    ];
  }

  return [];
}

function hasNumericAmount(exchange: JsonRecord): boolean {
  for (const key of ['meanAmount', 'resultingAmount']) {
    const value = exchange[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return true;
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return true;
    }
  }
  return false;
}

function createProcessQaFinding(options: {
  processFile: string;
  severity: ProcessQaFinding['severity'];
  code: string;
  message: string;
  evidence?: JsonRecord;
}): ProcessQaFinding {
  const methodologyRuleId = resolveRuntimeRuleId('process-authoring/strict', options.code);
  return {
    process_file: options.processFile,
    severity: options.severity,
    code: options.code,
    methodology_rule_id: methodologyRuleId,
    message: options.message,
    source: 'rule',
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

function reviewFindingsForBase(processFile: string, base: BaseInfoCheck): ProcessQaFinding[] {
  const findings: ProcessQaFinding[] = [];
  if (!base.source_name_ok) {
    findings.push(
      createProcessQaFinding({
        processFile,
        severity: 'warning',
        code: 'process_missing_source_base_name',
        message:
          'Process baseName should include a usable source-language entry before Foundry authoring is complete.',
        evidence: { base_names: base.base_names },
      }),
    );
  }
  if (!base.functional_unit_ok) {
    findings.push(
      createProcessQaFinding({
        processFile,
        severity: 'warning',
        code: 'process_missing_functional_unit',
        message:
          'Process quantitative reference functionalUnitOrOther is missing and should be curated by Foundry.',
      }),
    );
  }
  for (const [ok, code, message] of [
    [
      base.system_boundary_ok,
      'process_missing_system_boundary',
      'Process system boundary or typeOfDataSet context is missing.',
    ],
    [base.time_ok, 'process_missing_time', 'Process time coverage is missing.'],
    [base.geo_ok, 'process_missing_geography', 'Process geography is missing.'],
    [base.tech_ok, 'process_missing_technology', 'Process technology description is missing.'],
    [
      base.admin_ok,
      'process_missing_admin_metadata',
      'Process administrative metadata is missing.',
    ],
  ] as const) {
    if (!ok) {
      findings.push(
        createProcessQaFinding({
          processFile,
          severity: 'warning',
          code,
          message,
        }),
      );
    }
  }
  return findings;
}

function processRulesetGate(findings: ProcessQaFinding[]): ProcessRulesetGate {
  const ruleset = getRuntimeRuleset('process-authoring/strict');
  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  const status = blockers.length > 0 ? 'blocked' : findings.length > 0 ? 'needs_review' : 'passed';
  return {
    status,
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    ruleset_source_version: ruleset.source_version,
    ruleset_rule_ids: ruleset.rule_ids,
    counts: {
      findings: findings.length,
      blockers: blockers.length,
    },
    blockers,
    next_action:
      status === 'blocked'
        ? 'fix_blockers'
        : status === 'needs_review'
          ? 'review_findings_in_foundry'
          : 'continue',
  };
}

function baseInfoCheck(processPayload: JsonRecord): BaseInfoCheck {
  const [sourceNameOk, values] = extractBaseNames(processPayload);
  const functionalUnit = deepGet(processPayload, [
    'processDataSet',
    'processInformation',
    'quantitativeReference',
    'functionalUnitOrOther',
  ]);
  const mixAndLocation = deepGet(processPayload, [
    'processDataSet',
    'processInformation',
    'geography',
    'mixAndLocationTypes',
  ]);
  const route = deepGet(processPayload, [
    'processDataSet',
    'modellingAndValidation',
    'LCIMethodAndAllocation',
    'typeOfDataSet',
  ]);
  const time = deepGet(processPayload, ['processDataSet', 'processInformation', 'time']);
  const geography = deepGet(processPayload, ['processDataSet', 'processInformation', 'geography']);
  const technology = deepGet(processPayload, ['processDataSet', 'modellingAndValidation']);
  const administrativeInformation = deepGet(processPayload, [
    'processDataSet',
    'administrativeInformation',
  ]);

  const functionalUnitOk = hasNonEmpty(functionalUnit);
  const systemBoundaryOk = hasNonEmpty(mixAndLocation) || hasNonEmpty(route);
  const timeOk = hasNonEmpty(time);
  const geographyOk = hasNonEmpty(geography);
  const technologyOk = hasNonEmpty(technology);
  const administrativeOk = hasNonEmpty(administrativeInformation);
  const completenessScore = [
    sourceNameOk,
    functionalUnitOk,
    systemBoundaryOk,
    timeOk,
    geographyOk,
    technologyOk,
    administrativeOk,
  ].filter(Boolean).length;

  return {
    source_name_ok: sourceNameOk,
    functional_unit_ok: functionalUnitOk,
    system_boundary_ok: systemBoundaryOk,
    time_ok: timeOk,
    geo_ok: geographyOk,
    tech_ok: technologyOk,
    admin_ok: administrativeOk,
    completeness_score: completenessScore,
    base_names: values,
  };
}

function unwrapProcessPayload(value: unknown, filePath: string): JsonRecord {
  if (!isRecord(value)) {
    throw new CliError(`Expected process QA file to contain a JSON object: ${filePath}`, {
      code: 'PROCESS_QA_INPUT_INVALID',
      exitCode: 2,
    });
  }

  const candidate =
    (isRecord(value.process) && value.process) ||
    (isRecord(value.json_ordered) && value.json_ordered) ||
    (isRecord(value.jsonOrdered) && value.jsonOrdered) ||
    (isRecord(value.json) && value.json) ||
    value;

  if (!isRecord(candidate.processDataSet)) {
    throw new CliError(`Process QA file is missing processDataSet: ${filePath}`, {
      code: 'PROCESS_QA_INPUT_INVALID',
      exitCode: 2,
    });
  }

  return candidate;
}

function extractProcessIdentity(value: JsonRecord, index: number): { id: string; version: string } {
  const payload = unwrapProcessPayload(value, `row-${index + 1}`);
  const root = payload.processDataSet as JsonRecord;
  const processInformation = isRecord(root.processInformation) ? root.processInformation : {};
  const dataSetInformation = isRecord(processInformation.dataSetInformation)
    ? processInformation.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  const id =
    String(dataSetInformation['common:UUID'] ?? value.id ?? '').trim() || `row-${index + 1}`;
  const version =
    String(publicationAndOwnership['common:dataSetVersion'] ?? value.version ?? '').trim() ||
    '01.00.000';
  return {
    id,
    version,
  };
}

function loadReviewRows(rowsFile: string): JsonRecord[] {
  const resolved = path.resolve(rowsFile);
  const text = readFileSync(resolved, 'utf8');

  if (resolved.endsWith('.jsonl')) {
    return text
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!isRecord(parsed)) {
            throw new CliError(`Expected JSON object rows in JSONL file: ${resolved}`, {
              code: 'PROCESS_QA_ROWS_INVALID_JSONL_ROW',
              exitCode: 2,
            });
          }
          return parsed;
        } catch (error) {
          if (error instanceof CliError) {
            throw error;
          }
          throw new CliError(`Process QA rows file contains invalid JSONL at line ${index + 1}.`, {
            code: 'PROCESS_QA_ROWS_INVALID_JSONL',
            exitCode: 2,
            details: String(error),
          });
        }
      });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(`Process QA rows file is not valid JSON: ${resolved}`, {
      code: 'PROCESS_QA_ROWS_INVALID_JSON',
      exitCode: 2,
      details: String(error),
    });
  }
  if (Array.isArray(parsed) && parsed.every(isRecord)) {
    return parsed;
  }

  if (isRecord(parsed) && Array.isArray(parsed.rows) && parsed.rows.every(isRecord)) {
    return parsed.rows;
  }

  throw new CliError(`Expected JSON array of objects or a report object with rows[]: ${resolved}`, {
    code: 'PROCESS_QA_ROWS_INVALID_JSON',
    exitCode: 2,
  });
}

function materializeRowsFile(
  rowsFile: string,
  outDir: string,
): { processesDir: string; summaryPath: string } {
  const rows = loadReviewRows(rowsFile);
  const targetDir = path.join(outDir, 'qa-input', 'processes');
  mkdirSync(targetDir, { recursive: true });

  const byKey: Record<string, JsonRecord> = {};
  let duplicateCount = 0;
  rows.forEach((row, index) => {
    const payload = unwrapProcessPayload(row, `${rowsFile}#${index + 1}`);
    const identity = extractProcessIdentity(row, index);
    const key = `${identity.id}@${identity.version}`;
    if (key in byKey) {
      duplicateCount += 1;
    }
    byKey[key] = payload;
  });

  const items: Array<{ process_key: string; file: string }> = [];
  Object.entries(byKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, payload]) => {
      const { id, version } = extractProcessIdentity(payload, 0);
      const fileName = `${id}__${version}.json`;
      const filePath = path.join(targetDir, fileName);
      writeJsonArtifact(filePath, payload);
      items.push({
        process_key: key,
        file: filePath,
      });
    });

  const summaryPath = path.join(outDir, 'qa-input', 'materialization-summary.json');
  writeJsonArtifact(summaryPath, {
    source_rows_file: path.resolve(rowsFile),
    input_row_count: rows.length,
    materialized_process_count: Object.keys(byKey).length,
    duplicate_input_rows_collapsed: duplicateCount,
    processes_dir: targetDir,
    items,
  });

  return {
    processesDir: targetDir,
    summaryPath,
  };
}

function resolveReviewInput(options: {
  rowsFile?: string;
  runRoot?: string;
  runId?: string;
  outDir: string;
}): {
  inputMode: 'rows_file' | 'run_root';
  effectiveProcessesDir: string;
  materializationSummaryPath: string | null;
  runId: string;
  runRoot: string;
  rowsFile: string;
  reviewInputSummary: JsonRecord;
} {
  const declaredModes = [Boolean(options.rowsFile), Boolean(options.runRoot)].filter(Boolean);
  if (declaredModes.length !== 1) {
    throw new CliError('Process QA requires exactly one of --rows-file or --run-root.', {
      code: 'PROCESS_QA_INPUT_MODE_REQUIRED',
      exitCode: 2,
    });
  }

  if (options.rowsFile) {
    const materialized = materializeRowsFile(options.rowsFile, options.outDir);
    return {
      inputMode: 'rows_file',
      effectiveProcessesDir: materialized.processesDir,
      materializationSummaryPath: materialized.summaryPath,
      runId: options.runId?.trim() || path.parse(options.rowsFile).name,
      runRoot: '',
      rowsFile: path.resolve(options.rowsFile),
      reviewInputSummary: {
        input_mode: 'rows_file',
        rows_file: path.resolve(options.rowsFile),
        run_root: '',
        materialized_processes_dir: materialized.processesDir,
        effective_processes_dir: materialized.processesDir,
      },
    };
  }

  const runRoot = path.resolve(options.runRoot!);
  const effective = path.join(runRoot, 'exports', 'processes');
  return {
    inputMode: 'run_root',
    effectiveProcessesDir: effective,
    materializationSummaryPath: null,
    runId: options.runId?.trim() || path.basename(runRoot),
    runRoot,
    rowsFile: '',
    reviewInputSummary: {
      input_mode: 'run_root',
      rows_file: '',
      run_root: runRoot,
      materialized_processes_dir: '',
      effective_processes_dir: effective,
    },
  };
}

function readProcessFiles(processDir: string): string[] {
  if (!existsSync(processDir) || !statSync(processDir).isDirectory()) {
    throw new CliError(`Process QA directory not found: ${processDir}`, {
      code: 'PROCESS_QA_EXPORTS_NOT_FOUND',
      exitCode: 2,
    });
  }

  return readdirSync(processDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => path.join(processDir, entry));
}

function buildPrompt(processSummaries: ProcessSummaryForLlm[]): string {
  return [
    '请基于以下 process 摘要做语义一致性审核（源语言名称、边界表达、修订建议）。',
    '要求：',
    '1) 只根据给定摘要；',
    '2) 证据不足必须明确标注；',
    '3) 输出 JSON，格式：{"findings":[{"process_file","severity","fixability","evidence","action"}]}。',
    '',
    `输入摘要:\n${JSON.stringify(processSummaries, null, 2)}`,
  ].join('\n');
}

function parseLlmJsonOutput(output: string): JsonRecord | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? output.slice(start, end + 1) : output;

  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runOptionalLlmReview(
  processSummaries: ProcessSummaryForLlm[],
  options: {
    enableLlm: boolean;
    llmModel: string | undefined;
    env: NodeJS.ProcessEnv;
    fetchImpl: FetchLike;
    outDir: string;
  },
): Promise<ProcessQaLlmResult> {
  void processSummaries;
  void options.env;
  void options.fetchImpl;
  void options.outDir;

  if (!options.enableLlm) {
    return {
      enabled: false,
      reason: 'disabled',
    };
  }

  return {
    enabled: false,
    reason: 'moved_to_foundry_process_curation',
  };
}

function formatMass(value: number | null | undefined): string {
  return value == null ? 'n/a' : value.toPrecision(6);
}

function formatPercent(value: number | null): string {
  return value === null ? '' : `${(value * 100).toFixed(2)}%`;
}

function renderZhReview(options: {
  runId: string;
  logicVersion: string;
  baseRows: Array<[string, BaseInfoCheck]>;
  rows: ProcessQaRow[];
  totals: ProcessQaTotals;
  llmResult: ProcessQaLlmResult;
  evidenceStrong: string[];
  evidenceWeak: string[];
}): string {
  const lines = [
    '# one_flow_rerun_qa_v2_1_zh\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    '\n## 2.1 基础信息核查\n',
    '|process file|源语言名称|功能单位|系统边界|时间|地理|技术|管理元数据|完整性得分(0-7)|\n',
    '|---|---|---|---|---|---|---|---|---:|\n',
  ];

  options.baseRows.forEach(([fileName, base]) => {
    lines.push(
      `|${fileName}|${base.source_name_ok ? '✅' : '❌'}|${base.functional_unit_ok ? '✅' : '❌'}|${base.system_boundary_ok ? '✅' : '❌'}|${base.time_ok ? '✅' : '❌'}|${base.geo_ok ? '✅' : '❌'}|${base.tech_ok ? '✅' : '❌'}|${base.admin_ok ? '✅' : '❌'}|${base.completeness_score}|\n`,
    );
  });

  lines.push(
    '\n## 物料平衡口径\n- 质量平衡：以显式精确单位证据解析可比质量，按 kg 核算所有质量型输入和输出\n- 质量型燃料计入输入；非质量型参考产品不适用质量平衡，缺失证据仍需处理\n',
  );
  lines.push(
    '\n## 分过程结果\n|process file|原材料投入|产品|副产品|废物|其他质量输出|差值(输出-投入)|相对偏差|\n|---|---:|---:|---:|---:|---:|---:|---:|\n',
  );

  options.rows.forEach((row) => {
    lines.push(
      `|${row.process_file}|${formatMass(row.raw_input)}|${formatMass(row.product)}|${formatMass(row.byproduct)}|${formatMass(row.waste)}|${formatMass(row.other_output)}|${formatMass(row.delta)}|${formatPercent(row.relative_deviation)}|\n`,
    );
  });

  lines.push(
    `\n## 汇总\n- 原材料投入合计: **${formatMass(options.totals.raw_input)}**\n- 产品+副产品+废物合计: **${formatMass(options.totals.product_plus_byproduct_plus_waste)}**\n- 差值(输出-投入): **${formatMass(options.totals.delta)}**\n- 相对偏差: **${formatPercent(options.totals.relative_deviation)}**\n- 其他质量输出合计: **${formatMass(options.totals.other_output)}**\n`,
  );
  lines.push('\n## LLM 语义审核层（可选）\n');

  if (options.llmResult.enabled && options.llmResult.ok) {
    const findings = Array.isArray(options.llmResult.result.findings)
      ? options.llmResult.result.findings
      : [];
    if (findings.length > 0) {
      lines.push('\n|process file|severity|fixability|evidence|action|\n|---|---|---|---|---|\n');
      findings.slice(0, 50).forEach((finding) => {
        const evidenceValue = isRecord(finding) ? finding.evidence : '';
        const evidence =
          typeof evidenceValue === 'string'
            ? evidenceValue
            : JSON.stringify(evidenceValue ?? '', null, 0);
        const action = isRecord(finding) ? String(finding.action ?? finding.suggestion ?? '') : '';
        lines.push(
          `|${String(isRecord(finding) ? (finding.process_file ?? '') : '').replaceAll('|', '/')}|${String(isRecord(finding) ? (finding.severity ?? '') : '').replaceAll('|', '/')}|${String(isRecord(finding) ? (finding.fixability ?? 'review-needed') : 'review-needed').replaceAll('|', '/')}|${evidence.replaceAll('|', '/')}|${action.replaceAll('|', '/')}|\n`,
        );
      });
    }
  } else {
    lines.push(`- 未启用或调用失败：\`${options.llmResult.reason}\`\n`);
  }

  lines.push(
    `\n## 证据充足的结论\n${options.evidenceStrong.map((item) => `- ${item}`).join('\n')}\n`,
  );
  lines.push(
    `\n## 证据不足的结论/限制\n${options.evidenceWeak.map((item) => `- ${item}`).join('\n')}\n`,
  );

  return lines.join('');
}

function renderEnReview(options: {
  runId: string;
  logicVersion: string;
  baseRows: Array<[string, BaseInfoCheck]>;
  rows: ProcessQaRow[];
  totals: ProcessQaTotals;
  evidenceStrong: string[];
  evidenceWeak: string[];
}): string {
  const lines = [
    '# one_flow_rerun_qa_v2_1_en\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    '\n## 2.1 Basic info checks\n',
    '|process file|source-language name|functional unit|system boundary|time|geo|tech|admin metadata|completeness(0-7)|\n',
    '|---|---|---|---|---|---|---|---|---:|\n',
  ];

  options.baseRows.forEach(([fileName, base]) => {
    lines.push(
      `|${fileName}|${base.source_name_ok ? '✅' : '❌'}|${base.functional_unit_ok ? '✅' : '❌'}|${base.system_boundary_ok ? '✅' : '❌'}|${base.time_ok ? '✅' : '❌'}|${base.geo_ok ? '✅' : '❌'}|${base.tech_ok ? '✅' : '❌'}|${base.admin_ok ? '✅' : '❌'}|${base.completeness_score}|\n`,
    );
  });

  lines.push(
    '\n## Material balance scope\n- Check comparable mass inputs and outputs in kg; output categories remain separately visible\n- Only comparable exact-unit masses are summed in kg, including mass-valued fuels. Nonmass or unresolved reference products have no mass deviation; see the bound per-process assessments.\n',
  );
  lines.push(
    '\n## Per-process kg results (all mass inputs; categorized outputs)\n|process file|raw material in|product|by-product|waste|other mass outputs|delta(out-in)|relative deviation|\n|---|---:|---:|---:|---:|---:|---:|---:|\n',
  );

  options.rows.forEach((row) => {
    lines.push(
      `|${row.process_file}|${formatMass(row.raw_input)}|${formatMass(row.product)}|${formatMass(row.byproduct)}|${formatMass(row.waste)}|${formatMass(row.other_output)}|${formatMass(row.delta)}|${formatPercent(row.relative_deviation)}|\n`,
    );
  });

  lines.push(
    `\n## Summary\n- Raw material input total: **${formatMass(options.totals.raw_input)}**\n- Product+by-product+waste total: **${formatMass(options.totals.product_plus_byproduct_plus_waste)}**\n- Delta (out-in): **${formatMass(options.totals.delta)}**\n- Relative deviation: **${formatPercent(options.totals.relative_deviation)}**\n- Other mass output total: **${formatMass(options.totals.other_output)}**\n`,
  );
  lines.push(
    `\n## Evidence-sufficient conclusions\n${options.evidenceStrong.map((item) => `- ${item}`).join('\n')}\n`,
  );
  lines.push(
    `\n## Evidence-insufficient conclusions / limitations\n${options.evidenceWeak.map((item) => `- ${item}`).join('\n')}\n`,
  );

  return lines.join('');
}

function renderTiming(options: {
  runId: string;
  startTs: string | undefined;
  endTs: string | undefined;
  processCount: number;
}): string {
  const lines = ['# one_flow_rerun_timing\n', `- run_id: \`${options.runId}\`\n`];

  if (options.startTs && options.endTs) {
    const start = new Date(options.startTs);
    const end = new Date(options.endTs);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new CliError('Expected --start-ts and --end-ts to be valid ISO timestamps.', {
        code: 'PROCESS_QA_INVALID_TIMESTAMP',
        exitCode: 2,
      });
    }
    lines.push(`- start: \`${options.startTs}\`\n`);
    lines.push(`- end: \`${options.endTs}\`\n`);
    lines.push(
      `- total elapsed: **${((end.getTime() - start.getTime()) / 60_000).toFixed(2)} min**\n`,
    );
  }

  lines.push(`- process files reviewed: \`${options.processCount}\`\n`);
  lines.push(
    '- major time consumers: references retrieval, flow matching/search, flow metadata lookups.\n',
  );
  return lines.join('');
}

function renderUnitIssues(runId: string, unitIssues: UnitIssue[]): string {
  const lines = [
    '# flow_unit_issue_log\n',
    `- run_id: \`${runId}\`\n`,
    '\n|flow UUID|current unit|suggested unit|basis|confidence|\n|---|---|---|---|---|\n',
  ];

  if (unitIssues.length === 0) {
    lines.push('|无|无|无|未发现基于直接证据的单位矛盾|—|\n');
    return lines.join('');
  }

  const seen = new Set<string>();
  unitIssues.forEach((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    lines.push(
      `|${issue.flow_uuid}|${issue.current_unit}|${issue.suggested_unit}|${issue.basis}|${issue.confidence}|\n`,
    );
  });

  return lines.join('');
}

export async function runProcessQa(options: RunProcessQaOptions): Promise<ProcessQaReport> {
  const outDir = path.resolve(
    requiredNonEmpty(options.outDir, '--out-dir', 'PROCESS_QA_OUT_DIR_REQUIRED'),
  );
  const referenceEvidence = readProcessMassReferences(options.referenceRowsFiles);
  const resolvedInput = resolveReviewInput({
    rowsFile: options.rowsFile,
    runRoot: options.runRoot,
    runId: options.runId,
    outDir,
  });
  const runId = requiredNonEmpty(resolvedInput.runId, '--run-id', 'PROCESS_QA_RUN_ID_REQUIRED');
  const logicVersion = options.logicVersion?.trim() || 'v2.2-unit-aware';
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const env = options.env ?? process.env;
  const llmMaxProcesses =
    typeof options.llmMaxProcesses === 'number' &&
    Number.isInteger(options.llmMaxProcesses) &&
    options.llmMaxProcesses > 0
      ? options.llmMaxProcesses
      : 8;
  const processFiles = readProcessFiles(resolvedInput.effectiveProcessesDir);
  const baseRows: Array<[string, BaseInfoCheck]> = [];
  const rows: ProcessQaRow[] = [];
  const unitIssues: UnitIssue[] = [];
  const ruleFindings: ProcessQaFinding[] = [];
  const processSummariesForLlm: ProcessSummaryForLlm[] = [];

  const massBalances: ProcessMassBalance[] = [];

  processFiles.forEach((filePath) => {
    const processPayload = unwrapProcessPayload(readJsonInput(filePath), filePath);
    const exchangesValue = deepGet(processPayload, ['processDataSet', 'exchanges', 'exchange']);
    const exchanges = Array.isArray(exchangesValue)
      ? exchangesValue.filter(isRecord)
      : isRecord(exchangesValue)
        ? [exchangesValue]
        : [];
    const referenceFlowId =
      String(
        deepGet(processPayload, [
          'processDataSet',
          'processInformation',
          'quantitativeReference',
          'referenceToReferenceFlow',
        ]) ?? '',
      ).trim() || null;
    const base = baseInfoCheck(processPayload);
    const fileName = path.basename(filePath);
    baseRows.push([fileName, base]);
    ruleFindings.push(...reviewFindingsForBase(fileName, base));
    for (const issue of collectDatasetNameIssues(processPayload, 'process')) {
      ruleFindings.push(
        createProcessQaFinding({
          processFile: fileName,
          severity: 'blocker',
          code: issue.code,
          message: issue.message,
          evidence: { path: issue.path },
        }),
      );
    }

    exchanges.forEach((exchange) => {
      const classified = classifyExchange(exchange, referenceFlowId);
      if (!hasNumericAmount(exchange)) {
        ruleFindings.push(
          createProcessQaFinding({
            processFile: fileName,
            severity: 'warning',
            code: 'process_missing_exchange_amount',
            message:
              'Process exchange is missing both numeric meanAmount and resultingAmount and should be curated by Foundry.',
            evidence: {
              exchange_internal_id: String(exchange['@dataSetInternalID'] ?? ''),
              direction: String(exchange.exchangeDirection ?? ''),
            },
          }),
        );
      }
      const currentUnitIssues = unitIssueCheck(exchange, classified.uoms, classified.blob);
      unitIssues.push(...currentUnitIssues);
      currentUnitIssues.forEach((issue) => {
        ruleFindings.push(
          createProcessQaFinding({
            processFile: fileName,
            severity: 'warning',
            code: 'process_exchange_unit_semantic_mismatch',
            message: 'Exchange unit tag conflicts with flow description semantics.',
            evidence: { ...issue },
          }),
        );
      });
    });

    const mass = assessProcessMassBalance({
      processFile: fileName,
      processPayload,
      exchanges,
      referenceFlowId,
      references: referenceEvidence,
      classify: (exchange) => classifyExchange(exchange, referenceFlowId),
    });
    massBalances.push(mass);
    ruleFindings.push(
      ...mass.findings.map((finding) =>
        createProcessQaFinding({
          processFile: fileName,
          severity: 'warning',
          code: finding.code,
          message: finding.message,
          evidence: { ...finding, unit: 'kg' },
        }),
      ),
    );
    const rawInput = mass.raw_input,
      product = mass.product,
      byproduct = mass.byproduct,
      waste = mass.waste,
      energyExcluded = mass.energy_excluded,
      relativeDeviation = mass.relative_deviation;
    rows.push({
      process_file: fileName,
      raw_input: rawInput,
      product,
      byproduct,
      waste,
      other_output: mass.other_output,
      energy_excluded: energyExcluded,
      delta: mass.delta,
      relative_deviation: relativeDeviation,
    });

    if (
      (relativeDeviation !== null && relativeDeviation > 0.05) ||
      (mass.input_mass_kg === 0 && mass.output_mass_kg! > 0)
    ) {
      ruleFindings.push(
        createProcessQaFinding({
          processFile: fileName,
          severity: 'warning',
          code: 'process_material_balance_deviation',
          message:
            'Comparable mass inputs and outputs require review: positive output has zero input, or the relative kg deviation exceeds the QA threshold.',
          evidence: {
            raw_input: rawInput,
            product,
            byproduct,
            waste,
            relative_deviation: relativeDeviation,
            policy_decision_owner: 'foundry',
          },
        }),
      );
    }

    if (processSummariesForLlm.length < Math.max(1, llmMaxProcesses)) {
      processSummariesForLlm.push({
        process_file: fileName,
        base_names: base.base_names.slice(0, 4),
        base_checks: {
          source_name_ok: base.source_name_ok,
          functional_unit_ok: base.functional_unit_ok,
          system_boundary_ok: base.system_boundary_ok,
          time_ok: base.time_ok,
          geo_ok: base.geo_ok,
          tech_ok: base.tech_ok,
          admin_ok: base.admin_ok,
        },
        balance: {
          raw_in: rawInput,
          product,
          byproduct,
          waste,
          energy_excluded: energyExcluded,
          relative_deviation: relativeDeviation,
        },
      });
    }
  });

  const comparable =
    massBalances.length > 0 && massBalances.every((mass) => mass.status === 'applicable');
  const sum = (field: 'raw_input' | 'product' | 'byproduct' | 'waste' | 'other_output') =>
    comparable ? massBalances.reduce((total, mass) => total + mass[field]!, 0) : null;
  const totalRaw = sum('raw_input'),
    productAndWaste = comparable ? sum('product')! + sum('byproduct')! + sum('waste')! : null,
    other = sum('other_output');
  const totalOutput = comparable ? productAndWaste! + other! : null;
  const totals: ProcessQaTotals = {
    raw_input: totalRaw,
    product_plus_byproduct_plus_waste: productAndWaste,
    other_output: other,
    delta: comparable ? totalOutput! - totalRaw! : null,
    relative_deviation:
      comparable && totalRaw! > 0 ? Math.abs(totalOutput! - totalRaw!) / totalRaw! : null,
    energy_excluded: null,
  };
  if (Object.values(totals).some((value) => typeof value === 'number' && !Number.isFinite(value))) {
    for (const key of Object.keys(totals) as (keyof ProcessQaTotals)[]) totals[key] = null;
    ruleFindings.push(
      createProcessQaFinding({
        processFile: '[aggregate]',
        severity: 'warning',
        code: 'process_mass_sum_overflow',
        message: 'Diagnostic mass totals across processes must remain finite.',
      }),
    );
  }
  const evidenceStrong = [
    'Mass applicability and kilograms are resolved from the explicitly selected exact Flow, reference Flow Property and reference Unit Group chain. Mass-valued fuels remain inputs. Nonmass quantities are never added to kilograms.',
  ];
  const evidenceWeak = [
    'A nonmass reference product is not applicable to this mass balance. Missing or conflicting evidence remains actionable. A separate source-model physical balance is still required.',
    'Cross-process totals are diagnostic sums across distinct functional units; each process retains its own assessment and findings.',
  ];

  const llmResult = await runOptionalLlmReview(processSummariesForLlm, {
    enableLlm: Boolean(options.enableLlm),
    llmModel: options.llmModel,
    env,
    fetchImpl,
    outDir,
  });
  const rulesetGate = processRulesetGate(ruleFindings);

  const summary: ProcessQaSummary = {
    run_id: runId,
    logic_version: logicVersion,
    process_count: processFiles.length,
    totals,
    mass_balance: massBalances,
    ruleset_gate: rulesetGate,
    llm: llmResult,
    policy_decision_owner: 'foundry',
    qa_mode: 'deterministic_qa_report',
  };
  const reviewInputSummaryPath = writeJsonArtifact(
    path.join(outDir, 'qa-input-summary.json'),
    resolvedInput.reviewInputSummary,
  );
  const ruleFindingsPath = writeJsonLinesArtifact(
    path.join(outDir, 'process-qa-rule-findings.jsonl'),
    ruleFindings,
  );
  const rulesetGatePath = writeJsonArtifact(
    path.join(outDir, 'process-qa-ruleset-gate.json'),
    rulesetGate,
  );

  const reviewZhPath = writeTextArtifact(
    path.join(outDir, 'one_flow_rerun_qa_v2_1_zh.md'),
    renderZhReview({
      runId,
      logicVersion,
      baseRows,
      rows,
      totals,
      llmResult,
      evidenceStrong,
      evidenceWeak,
    }),
  );
  const reviewEnPath = writeTextArtifact(
    path.join(outDir, 'one_flow_rerun_qa_v2_1_en.md'),
    renderEnReview({
      runId,
      logicVersion,
      baseRows,
      rows,
      totals,
      evidenceStrong,
      evidenceWeak,
    }),
  );
  const timingPath = writeTextArtifact(
    path.join(outDir, 'one_flow_rerun_timing.md'),
    renderTiming({
      runId,
      startTs: options.startTs,
      endTs: options.endTs,
      processCount: processFiles.length,
    }),
  );
  const unitIssuePath = writeTextArtifact(
    path.join(outDir, 'flow_unit_issue_log.md'),
    renderUnitIssues(runId, unitIssues),
  );
  const summaryPath = writeJsonArtifact(path.join(outDir, 'qa_summary_v2_1.json'), summary);

  const report: ProcessQaReport = {
    schema_version: 1,
    mass_balance: massBalances,
    reference_evidence: referenceEvidence.artifacts,
    generated_at_utc: (options.now ?? (() => new Date()))().toISOString(),
    status: 'completed_local_process_qa',
    run_id: runId,
    run_root: resolvedInput.runRoot,
    rows_file: resolvedInput.rowsFile,
    out_dir: outDir,
    input_mode: resolvedInput.inputMode,
    effective_processes_dir: resolvedInput.effectiveProcessesDir,
    logic_version: logicVersion,
    ruleset_id: rulesetGate.ruleset_id,
    ruleset_version: rulesetGate.ruleset_version,
    ruleset_source_version: rulesetGate.ruleset_source_version,
    ruleset_rule_ids: rulesetGate.ruleset_rule_ids,
    process_count: processFiles.length,
    totals,
    rule_finding_count: ruleFindings.length,
    blocker_count: rulesetGate.counts.blockers,
    ruleset_gate: rulesetGate,
    policy_decision_owner: 'foundry',
    qa_mode: 'deterministic_qa_report',
    files: {
      qa_input_summary: reviewInputSummaryPath,
      materialization_summary: resolvedInput.materializationSummaryPath,
      rule_findings: ruleFindingsPath,
      ruleset_gate: rulesetGatePath,
      qa_zh: reviewZhPath,
      qa_en: reviewEnPath,
      timing: timingPath,
      unit_issue_log: unitIssuePath,
      summary: summaryPath,
      report: '',
    },
    llm: llmResult,
  };

  const reportPath = writeJsonArtifact(path.join(outDir, 'process-qa-report.json'), report);
  report.files.report = reportPath;
  writeJsonArtifact(reportPath, report);
  return report;
}

export const __testInternals = {
  requiredNonEmpty,
  textFromValue,
  deepGet,
  hasNonEmpty,
  extractBaseNames,
  classifyExchange,
  unitIssueCheck,
  hasNumericAmount,
  createProcessQaFinding,
  reviewFindingsForBase,
  processRulesetGate,
  baseInfoCheck,
  unwrapProcessPayload,
  buildPrompt,
  parseLlmJsonOutput,
  runOptionalLlmReview,
  renderZhReview,
  renderEnReview,
  renderTiming,
  renderUnitIssues,
};
