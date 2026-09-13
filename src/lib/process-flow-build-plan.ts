import { createHash } from 'node:crypto';
import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { writeJsonArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import {
  cloneJson,
  detectDatasetKind,
  isRecord,
  unwrapDatasetPayload,
  type JsonObject,
} from './dataset-local.js';
import {
  resolveTidasClassificationPath,
  type DatasetClassificationType,
} from './dataset-classification.js';
import { readJsonInput } from './io.js';
import { inspectFlowProperties, isExactOne } from './flow-property-contract.js';
import {
  canonicalPropertyJson,
  propertyJsonHash,
  runFlowPropertyConversion,
  type FlowPropertyConversionOptions,
} from './flow-property-conversion.js';
import {
  normalizeIssuePath,
  validateSchemaWithDeepFallback,
  type SafeParseSchema,
  type SdkValidationFactory,
} from './tidas-sdk-validation.js';

import {
  collectClassificationIssues,
  validateElementaryFlowsClassificationHierarchy,
  validateProcessesClassificationHierarchy,
  validateProductFlowsClassificationHierarchy,
} from './tidas-sdk-package-validator.js';

type BuildPlanKind = 'process' | 'flow';
type BuildPlanAction = 'validate' | 'materialize' | 'verify';
type BuildPlanStatus = 'passed' | 'blocked';
type ProcessTypeOfDataSet =
  | 'Unit process, single operation'
  | 'Unit process, black box'
  | 'LCI result'
  | 'Partly terminated system'
  | 'Avoided product system';
type BuildPlanDecision =
  'reuse' | 'update_same_row' | 'version_bump' | 'create_new' | 'block_duplicate' | 'manual_review';
type UnitOfAnalysisDecision =
  | 'ready_for_materialization'
  | 'declared_unit_dataset'
  | 'blocked_until_scaling_evidence'
  | 'manual_review';

type GateFinding = {
  code: string;
  severity: 'info' | 'warning' | 'blocker';
  message: string;
  path?: string;
};

type SchemaValidationSummary = {
  status: 'passed' | 'failed' | 'not_applicable';
  validator: string | null;
  issue_count: number;
  issues: Array<{
    path: string;
    message: string;
    code: string;
  }>;
};

type BuildPlanRequiredFields = {
  required: string[];
  satisfied: string[];
  missing: string[];
};

type BuildPlanFiles = {
  gate_report: string | null;
  materialized_artifact: string | null;
  calculation_provenance_artifact?: string | null;
  invariant_report?: string | null;
};

type CalculationProvenanceSummary = {
  status: 'not_applicable' | 'passed' | 'failed';
  required: boolean;
  calculated_exchange_count: number;
  validated_exchange_count: number;
};

type InvariantCheck = {
  path: string;
  status: 'passed' | 'failed';
  expected: unknown;
  actual: unknown;
};

export type ProcessBuildPlanInvariantReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'not_applicable' | 'passed' | 'failed';
  authoring_mode: string | null;
  plan_sha256: string;
  candidate_sha256: string | null;
  calculated_exchange_count: number;
  checked_count: number;
  mismatch_count: number;
  checks: InvariantCheck[];
};

export type BuildPlanGateReport = {
  schema_version: 1;
  generated_at_utc: string;
  kind: BuildPlanKind;
  action: BuildPlanAction;
  status: BuildPlanStatus;
  ruleset_id: string;
  ruleset_version: string;
  input_path: string;
  out_dir: string | null;
  report_only: boolean;
  inputs: {
    plan_schema_version: number | string | null;
    identity_decision: BuildPlanDecision | null;
    unit_of_analysis_decision: UnitOfAnalysisDecision | null;
  };
  required_fields: BuildPlanRequiredFields;
  calculation_provenance?: CalculationProvenanceSummary;
  invariant_verification?: ProcessBuildPlanInvariantReport;
  property_validation?: FlowPropertyGate;
  schema_validation: SchemaValidationSummary;
  findings: GateFinding[];
  blockers: GateFinding[];
  next_action:
    | 'materialize_payload'
    | 'use_materialized_artifact'
    | 'use_verified_artifact'
    | 'fix_build_plan';
  files: BuildPlanFiles;
};

export type RunBuildPlanOptions = FlowPropertyConversionOptions & {
  inputPath: string;
  outDir?: string | null;
  reportOnly?: boolean;
  rawInput?: unknown;
  candidatePath?: string | null;
  rawCandidate?: unknown;
  now?: Date;
  schemas?: Partial<Record<BuildPlanKind, SafeParseSchema>>;
};

export type RunProcessBuildPlanValidateOptions = RunBuildPlanOptions;
export type RunProcessBuildPlanMaterializeOptions = RunBuildPlanOptions;
export type RunProcessBuildPlanVerifyOptions = RunBuildPlanOptions;
export type RunFlowBuildPlanValidateOptions = RunBuildPlanOptions;
export type RunFlowBuildPlanMaterializeOptions = RunBuildPlanOptions;

export type ProcessBuildPlanGateReport = BuildPlanGateReport & { kind: 'process' };
export type FlowBuildPlanGateReport = BuildPlanGateReport & { kind: 'flow' };

type Evaluation = {
  plan: JsonObject;
  findings: GateFinding[];
  blockers: GateFinding[];
  requiredFields: BuildPlanRequiredFields;
  decision: BuildPlanDecision | null;
  unitOfAnalysisDecision: UnitOfAnalysisDecision | null;
  calculationProvenance: CalculationProvenanceSummary;
  propertyValidation: FlowPropertyGate;
};

export type FlowPropertyGate = {
  schema_version: 'tiangong-lca.flow-property-gate.v1';
  status: 'not_applicable' | 'passed' | 'failed';
  plan_sha256: string;
  candidate_sha256: string | null;
  property_count: number;
  reference_internal_id: string | null;
  reference_preserved: boolean | null;
  preserved_property_count: number;
  required_conversion_count: number;
  conversion_count: number;
  conversions: Array<{ exchange_internal_id: string; request_sha256: string; report: JsonObject }>;
};

type SchemaSpec = {
  validator: string;
  schema: SafeParseSchema;
  createEntity: SdkValidationFactory | null;
};

const AUTO_DECISIONS = new Set<BuildPlanDecision>([
  'reuse',
  'update_same_row',
  'version_bump',
  'create_new',
]);

const ALL_DECISIONS = new Set<BuildPlanDecision>([
  'reuse',
  'update_same_row',
  'version_bump',
  'create_new',
  'block_duplicate',
  'manual_review',
]);

const AUTOMATIC_UNIT_OF_ANALYSIS_DECISIONS = new Set<UnitOfAnalysisDecision>([
  'ready_for_materialization',
  'declared_unit_dataset',
]);

const ALL_UNIT_OF_ANALYSIS_DECISIONS = new Set<UnitOfAnalysisDecision>([
  'ready_for_materialization',
  'declared_unit_dataset',
  'blocked_until_scaling_evidence',
  'manual_review',
]);

const STRICT_SOURCE_EVIDENCE_MODE = 'source-evidence/strict';
const DATA_SOURCE_TYPES = new Set([
  'Primary',
  '> 90% primary',
  'Mixed primary / secondary',
  'Secondary',
]);
const ROUNDING_MODES = new Set(['none', 'decimal_places', 'significant_figures']);
const MAX_ARITHMETIC_EXPRESSION_LENGTH = 4096;
const MAX_ARITHMETIC_EXPRESSION_DEPTH = 128;
const MAX_TIDAS_COMMENT_LENGTH = 500;
const LICENSE_TYPES = new Set([
  'Free of charge for all users and uses',
  'Free of charge for some user types or use types',
  'Free of charge for members only',
  'License fee',
  'Other',
]);

const SCHEMA_EXPORTS: Record<BuildPlanKind, keyof typeof tidasSdk> = {
  flow: 'FlowSchema' as keyof typeof tidasSdk,
  process: 'ProcessSchema' as keyof typeof tidasSdk,
};

const ENTITY_FACTORY_EXPORTS: Record<BuildPlanKind, keyof typeof tidasSdk> = {
  flow: 'createFlow' as keyof typeof tidasSdk,
  process: 'createProcess' as keyof typeof tidasSdk,
};

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function requiredInputPath(inputPath: string): string {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new CliError('Missing required --input value.', {
      code: 'BUILD_PLAN_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  return normalized;
}

function requiredCandidatePath(candidatePath: string | null | undefined): string {
  const normalized = candidatePath?.trim() ?? '';
  if (!normalized) {
    throw new CliError('Missing required --candidate value for build-plan verify.', {
      code: 'BUILD_PLAN_CANDIDATE_REQUIRED',
      exitCode: 2,
    });
  }
  return normalized;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new CliError(`${label} must be a JSON object.`, {
      code: 'BUILD_PLAN_INVALID_INPUT',
      exitCode: 2,
    });
  }
  return value;
}

function loadBuildPlan(inputPath: string, rawInput: unknown): JsonObject {
  const input = asObject(rawInput, 'build-plan input');
  const nested =
    input.build_plan ??
    input.buildPlan ??
    input.process_build_plan ??
    input.processBuildPlan ??
    input.flow_build_plan ??
    input.flowBuildPlan;
  return nested === undefined ? input : asObject(nested, 'nested build plan');
}

function readBuildPlanInput(inputPath: string, rawInput: unknown): JsonObject {
  return loadBuildPlan(inputPath, rawInput === undefined ? readJsonInput(inputPath) : rawInput);
}

function textToken(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function valueAtPath(root: JsonObject, pathExpression: string): unknown {
  let current: unknown = root;
  for (const segment of pathExpression.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function firstValue(root: JsonObject, paths: string[]): unknown {
  for (const candidate of paths) {
    const value = valueAtPath(root, candidate);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function firstToken(root: JsonObject, paths: string[]): string | null {
  for (const candidate of paths) {
    const token = textToken(valueAtPath(root, candidate));
    if (token) {
      return token;
    }
  }
  return null;
}

function valueAsObject(root: JsonObject, paths: string[]): JsonObject | null {
  for (const candidate of paths) {
    const value = valueAtPath(root, candidate);
    if (isRecord(value)) {
      return value;
    }
  }
  return null;
}

function valueAsArray(root: JsonObject, paths: string[]): unknown[] {
  for (const candidate of paths) {
    const value = valueAtPath(root, candidate);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function normalizeAmount(value: unknown, fallback = '1.0'): string {
  const token = textToken(value);
  if (!token) {
    return fallback;
  }
  const numeric = Number(token);
  return Number.isFinite(numeric) ? String(numeric) : token;
}

function normalizeVersion(value: unknown, fallback = '00.00.001'): string {
  return textToken(value) ?? fallback;
}

function normalizeYear(value: unknown, fallback = 1970): number {
  const token = textToken(value);
  if (!token) {
    return fallback;
  }
  const year = Number.parseInt(token, 10);
  return Number.isFinite(year) ? year : fallback;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const chars = hex.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars
    .slice(12, 16)
    .join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20, 32).join('')}`;
}

function uuidFromPlan(plan: JsonObject, paths: string[], seed: string): string {
  const token = firstToken(plan, paths);
  return token ?? deterministicUuid(seed);
}

function localizedText(text: string, lang = 'en'): JsonObject {
  return { '#text': text, '@xml:lang': lang };
}

function multiLangFromValue(value: unknown, fallback: string, fallbackLang = 'en'): JsonObject[] {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => {
        if (isRecord(entry)) {
          const text = textToken(entry['#text'] ?? entry.text ?? entry.value);
          if (!text) {
            return null;
          }
          return localizedText(text, textToken(entry['@xml:lang'] ?? entry.lang) ?? fallbackLang);
        }
        const text = textToken(entry);
        return text ? localizedText(text, fallbackLang) : null;
      })
      .filter((entry): entry is JsonObject => Boolean(entry));
    if (normalized.length) {
      return normalized;
    }
  }
  if (isRecord(value)) {
    const text = textToken(value['#text'] ?? value.text ?? value.value);
    if (text) {
      return [localizedText(text, textToken(value['@xml:lang'] ?? value.lang) ?? fallbackLang)];
    }
    const en = textToken(value.en);
    const zh = textToken(value.zh);
    const rows = [en ? localizedText(en, 'en') : null, zh ? localizedText(zh, 'zh') : null].filter(
      (entry): entry is JsonObject => Boolean(entry),
    );
    if (rows.length) {
      return rows;
    }
  }
  const token = textToken(value);
  return [localizedText(token ?? fallback, fallbackLang)];
}

function firstMultiLang(plan: JsonObject, paths: string[], fallback: string): JsonObject[] {
  for (const candidate of paths) {
    const value = valueAtPath(plan, candidate);
    if (value !== undefined && value !== null) {
      return multiLangFromValue(value, fallback);
    }
  }
  return multiLangFromValue(undefined, fallback);
}

function globalReference(options: {
  type: string;
  refObjectId: string;
  version?: string | null;
  uri?: string | null;
  shortDescription: string;
}): JsonObject {
  const version = normalizeVersion(options.version, '00.00.000');
  return {
    '@type': options.type,
    '@refObjectId': options.refObjectId,
    '@version': version,
    '@uri': options.uri ?? `../${options.type.replaceAll(' ', '-')}/${options.refObjectId}.xml`,
    'common:shortDescription': localizedText(options.shortDescription),
  };
}

function evidenceSources(plan: JsonObject): JsonObject[] {
  const evidence = valueAsObject(plan, ['evidence_manifest', 'evidenceManifest']) ?? {};
  return (Array.isArray(evidence.sources) ? evidence.sources : []).filter(isRecord);
}

function evidenceSourceId(source: JsonObject): string | null {
  return textToken(source.id ?? source.source_id ?? source.ref_object_id);
}

function evidenceSourceReferenceFromRecord(
  plan: JsonObject,
  source: JsonObject | null,
): JsonObject {
  const sourceId =
    (source ? evidenceSourceId(source) : null) ??
    deterministicUuid(`${JSON.stringify(plan)}:source`);
  const sourceVersion = textToken(source?.version) ?? '00.00.000';
  const shortDescription =
    textToken(
      source?.title ?? source?.name ?? source?.short_description ?? source?.shortDescription,
    ) ?? 'Build plan evidence source';
  return globalReference({
    type: 'source data set',
    refObjectId: sourceId,
    version: sourceVersion,
    uri: textToken(source?.uri),
    shortDescription,
  });
}

function evidenceSourceReferences(
  plan: JsonObject,
  requestedIds: string[] = [],
): JsonObject | JsonObject[] {
  const sources = evidenceSources(plan);
  const selected = requestedIds.length
    ? requestedIds.map((sourceId) =>
        sources.find((source) => evidenceSourceId(source) === sourceId),
      )
    : [sources[0]];
  const references = selected.map((source) =>
    evidenceSourceReferenceFromRecord(plan, source ?? null),
  );
  return references.length === 1 ? (references[0] as JsonObject) : references;
}

function evidenceSourceReference(plan: JsonObject): JsonObject {
  return evidenceSourceReferenceFromRecord(plan, evidenceSources(plan)[0] ?? null);
}

function contactReference(plan: JsonObject, role: string): JsonObject {
  const explicit = valueAsObject(plan, [
    `administrative_information.${role}`,
    `administrativeInformation.${role}`,
  ]);
  const id =
    textToken(explicit?.id ?? explicit?.ref_object_id ?? explicit?.refObjectId) ??
    deterministicUuid(`${JSON.stringify(plan)}:${role}`);
  return globalReference({
    type: 'contact data set',
    refObjectId: id,
    version: textToken(explicit?.version) ?? '00.00.000',
    uri: textToken(explicit?.uri),
    shortDescription:
      textToken(explicit?.short_description ?? explicit?.shortDescription ?? explicit?.name) ??
      `Build plan ${role}`,
  });
}

function complianceReference(plan: JsonObject): JsonObject {
  const explicit = valueAsObject(plan, [
    'compliance_reference',
    'complianceReference',
    'administrative_information.compliance_reference',
    'administrativeInformation.complianceReference',
  ]);
  return globalReference({
    type: 'source data set',
    refObjectId:
      textToken(explicit?.id ?? explicit?.ref_object_id ?? explicit?.refObjectId) ??
      deterministicUuid(`${JSON.stringify(plan)}:compliance`),
    version: textToken(explicit?.version) ?? '00.00.000',
    uri: textToken(explicit?.uri),
    shortDescription:
      textToken(explicit?.short_description ?? explicit?.shortDescription ?? explicit?.name) ??
      'Build plan compliance system',
  });
}

function dataSetFormatReference(plan: JsonObject): JsonObject {
  const explicit = valueAsObject(plan, [
    'format_reference',
    'formatReference',
    'administrative_information.format_reference',
    'administrativeInformation.formatReference',
  ]);
  return globalReference({
    type: 'source data set',
    refObjectId:
      textToken(explicit?.id ?? explicit?.ref_object_id ?? explicit?.refObjectId) ??
      deterministicUuid('tiangong-lca-tidas-format-reference'),
    version: textToken(explicit?.version) ?? '00.00.000',
    uri: textToken(explicit?.uri),
    shortDescription:
      textToken(explicit?.short_description ?? explicit?.shortDescription ?? explicit?.name) ??
      'TIDAS / ILCD data set format',
  });
}

function classificationPath(plan: JsonObject): unknown {
  return firstValue(plan, [
    'target.classification_path',
    'target.classificationPath',
    'classification_path',
    'classificationPath',
  ]);
}

function canonicalClassificationToken(
  entry: JsonObject,
  key: '@level' | '@classId' | '@catId' | '#text',
  index: number,
): string {
  const value = entry[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError(
      `Build plan classification_path[${index}] must contain a non-empty ${key} string.`,
      {
        code: 'BUILD_PLAN_CLASSIFICATION_INVALID',
        exitCode: 2,
      },
    );
  }
  return value.trim();
}

function canonicalClassificationEntries(
  plan: JsonObject,
  idKey: '@classId' | '@catId',
  classificationType: DatasetClassificationType,
): JsonObject[] {
  const rawPath = classificationPath(plan);
  if (rawPath === undefined) {
    throw new CliError('Build plan materialization requires classification_path.', {
      code: 'BUILD_PLAN_CLASSIFICATION_REQUIRED',
      exitCode: 2,
    });
  }
  if (!Array.isArray(rawPath)) {
    throw new CliError('Build plan classification_path must be an array.', {
      code: 'BUILD_PLAN_CLASSIFICATION_INVALID',
      exitCode: 2,
    });
  }
  if (rawPath.length === 0) {
    throw new CliError('Build plan classification_path must not be empty when provided.', {
      code: 'BUILD_PLAN_CLASSIFICATION_INVALID',
      exitCode: 2,
    });
  }

  // Legacy label paths must resolve to a real catalog path before the same
  // canonical-object and hierarchy gates used by upstream materialization.
  const canonicalPath = rawPath.every((entry) => typeof entry === 'string')
    ? resolveTidasClassificationPath(classificationType, rawPath)
    : rawPath;
  return canonicalPath.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliError(`Build plan classification_path[${index}] must be a canonical object.`, {
        code: 'BUILD_PLAN_CLASSIFICATION_INVALID',
        exitCode: 2,
      });
    }
    const level = canonicalClassificationToken(entry, '@level', index);
    if (level !== String(index)) {
      throw new CliError(
        `Build plan classification_path[${index}] expected @level ${index}, received ${level}.`,
        {
          code: 'BUILD_PLAN_CLASSIFICATION_INVALID',
          exitCode: 2,
        },
      );
    }
    return {
      '@level': level,
      [idKey]: canonicalClassificationToken(entry, idKey, index),
      '#text': canonicalClassificationToken(entry, '#text', index),
    };
  });
}

function requireClassificationHierarchy(
  entries: JsonObject[],
  kind: 'elementary-flow' | 'product-flow' | 'process',
): JsonObject[] {
  const errors =
    kind === 'elementary-flow'
      ? validateElementaryFlowsClassificationHierarchy(entries)
      : kind === 'process'
        ? validateProcessesClassificationHierarchy(entries)
        : validateProductFlowsClassificationHierarchy(entries);
  if (errors.length > 0) {
    throw new CliError(`Build plan classification_path is not a valid ${kind} hierarchy.`, {
      code: 'BUILD_PLAN_CLASSIFICATION_HIERARCHY_INVALID',
      exitCode: 2,
      details: { kind, errors },
    });
  }
  return entries;
}

function flowClassificationInformation(
  plan: JsonObject,
  flowType: 'Elementary flow' | 'Product flow' | 'Waste flow',
): JsonObject {
  if (flowType === 'Elementary flow') {
    const entries = requireClassificationHierarchy(
      canonicalClassificationEntries(plan, '@catId', 'flow-elementary'),
      'elementary-flow',
    );
    return {
      'common:elementaryFlowCategorization': {
        'common:category': entries,
      },
    };
  }
  const entries = requireClassificationHierarchy(
    canonicalClassificationEntries(plan, '@classId', 'flow-product'),
    'product-flow',
  );
  return {
    'common:classification': {
      'common:class': entries,
    },
  };
}

function processClassificationInformation(plan: JsonObject): JsonObject {
  const entries = requireClassificationHierarchy(
    canonicalClassificationEntries(plan, '@classId', 'process'),
    'process',
  );
  return {
    'common:classification': {
      'common:class': entries,
    },
  };
}

function normalizeFlowType(
  value: string | null,
): 'Elementary flow' | 'Product flow' | 'Waste flow' {
  const lower = (value ?? '').toLowerCase();
  if (lower.includes('elementary')) {
    return 'Elementary flow';
  }
  if (lower.includes('waste')) {
    return 'Waste flow';
  }
  return 'Product flow';
}

function normalizeProcessType(value: string | null): ProcessTypeOfDataSet {
  const allowed = new Set([
    'Unit process, single operation',
    'Unit process, black box',
    'LCI result',
    'Partly terminated system',
    'Avoided product system',
  ]);
  return value && allowed.has(value)
    ? (value as ProcessTypeOfDataSet)
    : 'Unit process, single operation';
}

function flowPropertyReference(plan: JsonObject): JsonObject {
  const propertyName =
    firstToken(plan, [
      'flow_property_plan.reference_property',
      'flowPropertyPlan.referenceProperty',
    ]) ?? 'Reference flow property';
  const propertyId =
    firstToken(plan, [
      'flow_property_plan.reference_property_id',
      'flowPropertyPlan.referencePropertyId',
    ]) ??
    (propertyName.toLowerCase() === 'mass'
      ? '93a60a56-a3c8-11da-a746-0800200b9a66'
      : deterministicUuid(`flow-property:${propertyName}`));
  return globalReference({
    type: 'flow property data set',
    refObjectId: propertyId,
    version:
      firstToken(plan, [
        'flow_property_plan.reference_property_version',
        'flowPropertyPlan.referencePropertyVersion',
      ]) ?? '00.00.000',
    uri: firstToken(plan, [
      'flow_property_plan.reference_property_uri',
      'flowPropertyPlan.referencePropertyUri',
    ]),
    shortDescription: propertyName,
  });
}

function referenceFlowRef(plan: JsonObject): JsonObject {
  const referenceFlowId =
    firstToken(plan, [
      'quantitative_reference_plan.reference_flow_id',
      'quantitativeReferencePlan.referenceFlowId',
      'target.intended_reference_flow',
    ]) ?? deterministicUuid(`${JSON.stringify(plan)}:reference-flow`);
  return globalReference({
    type: 'flow data set',
    refObjectId: referenceFlowId,
    version:
      firstToken(plan, [
        'quantitative_reference_plan.reference_flow_version',
        'quantitativeReferencePlan.referenceFlowVersion',
      ]) ?? '00.00.000',
    uri: firstToken(plan, [
      'quantitative_reference_plan.reference_flow_uri',
      'quantitativeReferencePlan.referenceFlowUri',
    ]),
    shortDescription:
      firstToken(plan, [
        'quantitative_reference_plan.reference_flow_name',
        'quantitativeReferencePlan.referenceFlowName',
        'name_plan.functional_unit_flow_properties',
        'namePlan.functionalUnitFlowProperties',
      ]) ?? 'Quantitative reference flow',
  });
}

function authoringMode(plan: JsonObject): string | null {
  return firstToken(plan, ['authoring_mode', 'authoringMode', 'authoring.mode', 'ruleset.id']);
}

function isStrictSourceEvidence(plan: JsonObject): boolean {
  return authoringMode(plan) === STRICT_SOURCE_EVIDENCE_MODE;
}

function rightsDecision(plan: JsonObject): JsonObject | null {
  return valueAsObject(plan, ['publication.rights_decision']);
}

function copyrightValue(decision: JsonObject | null): string | null {
  if (!decision) {
    return null;
  }
  if (typeof decision.copyright === 'boolean') {
    return String(decision.copyright);
  }
  const token = textToken(decision.copyright);
  return token === 'true' || token === 'false' ? token : null;
}

function evaluatePublicationRights(plan: JsonObject): {
  findings: GateFinding[];
  blockers: GateFinding[];
} {
  const findings: GateFinding[] = [];
  const blockers: GateFinding[] = [];
  if (!isStrictSourceEvidence(plan)) {
    return { findings, blockers };
  }
  const decision = rightsDecision(plan);
  if (!decision) {
    blockers.push(
      makeFinding(
        'publication_rights_decision_missing',
        'blocker',
        'source-evidence/strict plans require an explicit publication.rights_decision.',
        'publication.rights_decision',
      ),
    );
    return { findings, blockers };
  }
  const status = textToken(decision.status);
  if (status === 'unknown' || status === 'blocked') {
    blockers.push(
      makeFinding(
        'publication_rights_unresolved',
        'blocker',
        `Publication rights are explicitly ${status}; materialization is blocked until resolved.`,
        'publication.rights_decision.status',
      ),
    );
    return { findings, blockers };
  }
  const licenseType = textToken(decision.license_type);
  const accessRestrictions = decision.access_restrictions;
  if (!copyrightValue(decision)) {
    blockers.push(
      makeFinding(
        'publication_copyright_invalid',
        'blocker',
        'rights_decision.copyright must explicitly be true or false.',
        'publication.rights_decision.copyright',
      ),
    );
  }
  if (!licenseType || !LICENSE_TYPES.has(licenseType)) {
    blockers.push(
      makeFinding(
        'publication_license_type_invalid',
        'blocker',
        'rights_decision.license_type must be an explicit TIDAS license type.',
        'publication.rights_decision.license_type',
      ),
    );
  }
  if (
    accessRestrictions === undefined ||
    accessRestrictions === null ||
    !multiLangFromValue(accessRestrictions, '').some((entry) => Boolean(textToken(entry['#text'])))
  ) {
    blockers.push(
      makeFinding(
        'publication_access_restrictions_missing',
        'blocker',
        'rights_decision.access_restrictions must explicitly document access and use restrictions.',
        'publication.rights_decision.access_restrictions',
      ),
    );
  }
  if (blockers.length === 0) {
    findings.push(
      makeFinding(
        'publication_rights_contract_satisfied',
        'info',
        'Publication rights are explicit; no permissive license or copyright default was inferred.',
      ),
    );
  }
  return { findings, blockers };
}

function explicitAnnualSupply(plan: JsonObject): unknown {
  return firstValue(plan, [
    'required_fields.annualSupplyOrProductionVolume',
    'requiredFields.annualSupplyOrProductionVolume',
    'authoring.required_fields.annualSupplyOrProductionVolume',
    'authoring.requiredFields.annualSupplyOrProductionVolume',
    'modelling_and_validation.annualSupplyOrProductionVolume',
    'modellingAndValidation.annualSupplyOrProductionVolume',
  ]);
}

function annualSupplyPresent(plan: JsonObject): boolean {
  const value = explicitAnnualSupply(plan);
  if (value === undefined || value === null) {
    return false;
  }
  return multiLangFromValue(value, '').some((entry) => Boolean(textToken(entry['#text'])));
}

function calculationProvenance(entry: JsonObject): JsonObject | null {
  const value = entry.calculation_provenance;
  return isRecord(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(textToken).filter((entry): entry is string => Boolean(entry))
    : [];
}

function finiteNumber(value: unknown): number | null {
  const token = textToken(value);
  if (!token) {
    return null;
  }
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

function calculatedExchangeEntries(plan: JsonObject): Array<{ entry: JsonObject; path: string }> {
  const rows = valueAsArray(plan, ['exchange_plan.exchanges', 'exchangePlan.exchanges'])
    .map((entry, index) =>
      isRecord(entry) ? { entry, path: `exchange_plan.exchanges[${index}]` } : null,
    )
    .filter((entry): entry is { entry: JsonObject; path: string } => Boolean(entry));
  const reference = valueAsObject(plan, [
    'quantitative_reference_plan',
    'quantitativeReferencePlan',
  ]);
  if (reference) {
    rows.unshift({ entry: reference, path: 'quantitative_reference_plan' });
  }
  return rows.filter(
    ({ entry }) =>
      textToken(entry.data_derivation_type_status ?? entry.dataDerivationTypeStatus) ===
      'Calculated',
  );
}

function evidenceRecords(plan: JsonObject): JsonObject[] {
  const evidence = valueAsObject(plan, ['evidence_manifest', 'evidenceManifest']) ?? {};
  const rows = evidence.evidence;
  return (Array.isArray(rows) ? rows : []).filter(isRecord);
}

function evidenceRecordId(evidence: JsonObject): string | null {
  return textToken(evidence.id ?? evidence.evidence_id);
}

function evidenceRecordSourceId(evidence: JsonObject): string | null {
  return textToken(evidence.source_id ?? evidence.primary_source_id);
}

function roundedResult(provenance: JsonObject): number | null {
  const value = finiteNumber(provenance.unrounded_result);
  const rounding = isRecord(provenance.rounding) ? provenance.rounding : null;
  const mode = textToken(rounding?.mode);
  if (value === null || !mode || !ROUNDING_MODES.has(mode)) {
    return null;
  }
  if (mode === 'none') {
    return value;
  }
  const digits = finiteNumber(rounding?.digits);
  if (digits === null || !Number.isInteger(digits)) {
    return null;
  }
  return mode === 'decimal_places'
    ? Number(value.toFixed(digits))
    : Number(value.toPrecision(digits));
}

function numbersMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * 1e-12 + 1e-15;
}

type ArithmeticToken = {
  type:
    | 'number'
    | 'identifier'
    | 'operator'
    | 'left_parenthesis'
    | 'right_parenthesis'
    | 'equals'
    | 'end';
  value: string;
  position: number;
};

type ArithmeticEvaluation =
  | {
      ok: true;
      value: number;
      assigned_identifier: string | null;
      referenced_identifiers: string[];
    }
  | { ok: false; error: string };

class ArithmeticExpressionError extends Error {}

function arithmeticToken(
  type: ArithmeticToken['type'],
  value: string,
  position: number,
): ArithmeticToken {
  return { type, value, position };
}

function tokenizeArithmeticExpression(expression: string): ArithmeticToken[] {
  if (expression.length > MAX_ARITHMETIC_EXPRESSION_LENGTH) {
    throw new ArithmeticExpressionError(
      `Expression exceeds ${MAX_ARITHMETIC_EXPRESSION_LENGTH} characters.`,
    );
  }
  const tokens: ArithmeticToken[] = [];
  let position = 0;
  while (position < expression.length) {
    const character = expression[position] as string;
    if (/\s/u.test(character)) {
      position += 1;
      continue;
    }
    if (/[0-9.]/u.test(character)) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(expression.slice(position));
      if (!match) {
        throw new ArithmeticExpressionError(`Invalid numeric literal at position ${position}.`);
      }
      const value = Number(match[0]);
      if (!Number.isFinite(value)) {
        throw new ArithmeticExpressionError(
          `Numeric literal at position ${position} is not finite.`,
        );
      }
      tokens.push(arithmeticToken('number', match[0], position));
      position += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(expression.slice(position)) as RegExpExecArray;
      tokens.push(arithmeticToken('identifier', match[0], position));
      position += match[0].length;
      continue;
    }
    if (character === '+' || character === '-' || character === '*' || character === '/') {
      tokens.push(arithmeticToken('operator', character, position));
      position += 1;
      continue;
    }
    if (character === '(') {
      tokens.push(arithmeticToken('left_parenthesis', character, position));
      position += 1;
      continue;
    }
    if (character === ')') {
      tokens.push(arithmeticToken('right_parenthesis', character, position));
      position += 1;
      continue;
    }
    if (character === '=') {
      tokens.push(arithmeticToken('equals', character, position));
      position += 1;
      continue;
    }
    throw new ArithmeticExpressionError(
      `Unexpected token ${JSON.stringify(character)} at position ${position}.`,
    );
  }
  tokens.push(arithmeticToken('end', '', expression.length));
  return tokens;
}

class ArithmeticExpressionParser {
  private position = 0;
  private readonly referencedIdentifiers = new Set<string>();

  constructor(
    private readonly tokens: ArithmeticToken[],
    private readonly variables: ReadonlyMap<string, number>,
  ) {}

  parse(): {
    value: number;
    assignedIdentifier: string | null;
    referencedIdentifiers: string[];
  } {
    let assignedIdentifier: string | null = null;
    if (this.current().type === 'identifier' && this.peek().type === 'equals') {
      assignedIdentifier = this.current().value;
      this.position += 2;
    }
    const value = this.parseAdditive(0);
    const trailing = this.current();
    if (trailing.type !== 'end') {
      throw new ArithmeticExpressionError(
        `Unexpected trailing token ${JSON.stringify(trailing.value)} at position ${trailing.position}.`,
      );
    }
    return {
      value: this.requireFinite(value, trailing.position),
      assignedIdentifier,
      referencedIdentifiers: [...this.referencedIdentifiers],
    };
  }

  private current(): ArithmeticToken {
    return this.tokens[this.position] as ArithmeticToken;
  }

  private peek(): ArithmeticToken {
    return this.tokens[this.position + 1] as ArithmeticToken;
  }

  private parseAdditive(depth: number): number {
    let value = this.parseMultiplicative(depth);
    while (this.current().type === 'operator' && ['+', '-'].includes(this.current().value)) {
      const operator = this.current();
      this.position += 1;
      const right = this.parseMultiplicative(depth);
      value = this.requireFinite(
        operator.value === '+' ? value + right : value - right,
        operator.position,
      );
    }
    return value;
  }

  private parseMultiplicative(depth: number): number {
    let value = this.parseUnary(depth);
    while (this.current().type === 'operator' && ['*', '/'].includes(this.current().value)) {
      const operator = this.current();
      this.position += 1;
      const right = this.parseUnary(depth);
      value = this.requireFinite(
        operator.value === '*' ? value * right : value / right,
        operator.position,
      );
    }
    return value;
  }

  private parseUnary(depth: number): number {
    this.requireSupportedDepth(depth);
    const token = this.current();
    if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
      this.position += 1;
      const value = this.parseUnary(depth + 1);
      return this.requireFinite(token.value === '-' ? -value : value, token.position);
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): number {
    const token = this.current();
    if (token.type === 'number') {
      this.position += 1;
      return Number(token.value);
    }
    if (token.type === 'identifier') {
      this.position += 1;
      const value = this.variables.get(token.value);
      if (value === undefined) {
        throw new ArithmeticExpressionError(
          `Unknown identifier ${JSON.stringify(token.value)} at position ${token.position}.`,
        );
      }
      this.referencedIdentifiers.add(token.value);
      return this.requireFinite(value, token.position);
    }
    if (token.type === 'left_parenthesis') {
      this.requireSupportedDepth(depth);
      this.position += 1;
      const value = this.parseAdditive(depth + 1);
      const closing = this.current();
      if (closing.type !== 'right_parenthesis') {
        throw new ArithmeticExpressionError(
          `Expected closing parenthesis at position ${closing.position}.`,
        );
      }
      this.position += 1;
      return value;
    }
    throw new ArithmeticExpressionError(
      `Expected a number, identifier, unary operator, or parenthesis at position ${token.position}.`,
    );
  }

  private requireSupportedDepth(depth: number): void {
    if (depth > MAX_ARITHMETIC_EXPRESSION_DEPTH) {
      throw new ArithmeticExpressionError(
        `Expression nesting exceeds ${MAX_ARITHMETIC_EXPRESSION_DEPTH}.`,
      );
    }
  }

  private requireFinite(value: number, position: number): number {
    if (!Number.isFinite(value)) {
      throw new ArithmeticExpressionError(
        `Expression produced a non-finite result near position ${position}.`,
      );
    }
    return value;
  }
}

function evaluateArithmeticExpression(
  expression: string,
  variables: ReadonlyMap<string, number>,
): ArithmeticEvaluation {
  try {
    const result = new ArithmeticExpressionParser(
      tokenizeArithmeticExpression(expression),
      variables,
    ).parse();
    return {
      ok: true,
      value: result.value,
      assigned_identifier: result.assignedIdentifier,
      referenced_identifiers: result.referencedIdentifiers,
    };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  }
}

function isArithmeticIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function splitProvenanceComment(text: string, continuationPrefix: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  let first = true;
  while (remaining.length > 0) {
    const prefix = first ? '' : continuationPrefix;
    const capacity = MAX_TIDAS_COMMENT_LENGTH - prefix.length;
    if (remaining.length <= capacity) {
      chunks.push(`${prefix}${remaining}`);
      break;
    }
    let splitAt = capacity;
    for (const delimiter of [' | ', '; ', '；', ' ']) {
      const candidate = remaining.lastIndexOf(delimiter, capacity - delimiter.length);
      if (candidate >= Math.floor(capacity / 2)) {
        splitAt = candidate + delimiter.length;
        break;
      }
    }
    const finalCodeUnit = remaining.charCodeAt(splitAt - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      splitAt -= 1;
    }
    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(`${prefix}${chunk}`);
    remaining = remaining.slice(splitAt).trimStart();
    first = false;
  }
  return chunks;
}

function provenanceComment(entry: JsonObject): JsonObject[] | null {
  const provenance = calculationProvenance(entry);
  if (!provenance) {
    return null;
  }
  const sourceValues = (Array.isArray(provenance.source_values) ? provenance.source_values : [])
    .filter(isRecord)
    .map((value) => `${String(value.id)}=${String(value.value)} ${String(value.unit)}`);
  const conversionSteps = (
    Array.isArray(provenance.conversion_steps) ? provenance.conversion_steps : []
  )
    .filter(isRecord)
    .map((step) => String(step.formula));
  const denominator = isRecord(provenance.normalization_denominator)
    ? provenance.normalization_denominator
    : null;
  const denominatorText = isRecord(denominator)
    ? `${String(denominator.value)} ${String(denominator.unit)} (${String(denominator.formula)})`
    : `N/A: ${String(provenance.normalization_not_applicable_reason)}`;
  const rounding = isRecord(provenance.rounding) ? provenance.rounding : {};
  const roundingText = `${String(rounding.mode)}${rounding.digits === undefined ? '' : `(${String(rounding.digits)})`}`;
  const formula = String(provenance.formula);
  const result = String(provenance.unrounded_result);
  const unit = String(provenance.result_unit);
  const primarySources = stringArray(provenance.primary_source_ids).join(', ');
  const evidenceIds = stringArray(provenance.evidence_ids).join(', ');
  const assumptions = stringArray(provenance.assumptions);
  const conversions =
    conversionSteps.length > 0
      ? conversionSteps.join('; ')
      : `N/A: ${String(provenance.conversion_not_applicable_reason)}`;
  const english = `Calc | values: ${sourceValues.join('; ')} | convert: ${conversions} | denominator: ${denominatorText} | formula: ${formula} | raw: ${result} ${unit} | rounding: ${roundingText} | sources: ${primarySources} | evidence: ${evidenceIds} | assumptions: ${assumptions.join('; ') || 'none'}`;
  const chinese = `计算 | 数据：${sourceValues.join('；')} | 换算：${conversions} | 分母：${denominatorText} | 公式：${formula} | 原值：${result} ${unit} | 舍入：${roundingText} | 来源：${primarySources} | 证据：${evidenceIds} | 假设：${assumptions.join('；') || '无'}`;
  return [
    ...splitProvenanceComment(english, 'Calc (cont.) | ').map((comment) =>
      localizedText(comment, 'en'),
    ),
    ...splitProvenanceComment(chinese, '计算（续）| ').map((comment) =>
      localizedText(comment, 'zh'),
    ),
  ];
}

function evaluateCalculationProvenance(plan: JsonObject): {
  findings: GateFinding[];
  blockers: GateFinding[];
  summary: CalculationProvenanceSummary;
} {
  const findings: GateFinding[] = [];
  const blockers: GateFinding[] = [];
  const strict = isStrictSourceEvidence(plan);
  const entries = calculatedExchangeEntries(plan);
  if (!strict) {
    return {
      findings,
      blockers,
      summary: {
        status: 'not_applicable',
        required: false,
        calculated_exchange_count: entries.length,
        validated_exchange_count: 0,
      },
    };
  }

  if (!annualSupplyPresent(plan)) {
    blockers.push(
      makeFinding(
        'strict_annual_supply_missing',
        'blocker',
        'source-evidence/strict process plans require an explicit annual supply or production volume.',
        'modelling_and_validation.annualSupplyOrProductionVolume',
      ),
    );
  }

  const sourceIds = new Set(
    evidenceSources(plan)
      .map(evidenceSourceId)
      .filter((id): id is string => Boolean(id)),
  );
  const evidenceById = new Map(
    evidenceRecords(plan)
      .map((record) => {
        const id = evidenceRecordId(record);
        return id ? ([id, record] as const) : null;
      })
      .filter((entry): entry is readonly [string, JsonObject] => Boolean(entry)),
  );
  let validated = 0;
  for (const { entry, path: entryPath } of entries) {
    const before = blockers.length;
    const dataSourceType = textToken(entry.data_source_type);
    if (!dataSourceType || !DATA_SOURCE_TYPES.has(dataSourceType)) {
      blockers.push(
        makeFinding(
          'calculated_exchange_data_source_type_invalid',
          'blocker',
          'Calculated exchanges require a valid TIDAS data_source_type.',
          `${entryPath}.data_source_type`,
        ),
      );
    }

    const provenance = calculationProvenance(entry);
    if (!provenance) {
      blockers.push(
        makeFinding(
          'calculation_provenance_missing',
          'blocker',
          'Calculated exchanges require calculation_provenance in source-evidence/strict mode.',
          `${entryPath}.calculation_provenance`,
        ),
      );
      continue;
    }

    const sourceValues = (
      Array.isArray(provenance.source_values) ? provenance.source_values : []
    ).filter(isRecord);
    const primarySourceIds = stringArray(provenance.primary_source_ids);
    const evidenceIds = stringArray(provenance.evidence_ids);
    const assumptions = provenance.assumptions;
    const formula = textToken(provenance.formula);
    const resultUnit = textToken(provenance.result_unit);
    const unrounded = finiteNumber(provenance.unrounded_result);
    const rounding = isRecord(provenance.rounding) ? provenance.rounding : null;
    const roundingMode = textToken(rounding?.mode);
    const roundingDigits = finiteNumber(rounding?.digits);

    for (const [suffix, valid, message] of [
      ['source_values', sourceValues.length > 0, 'source_values must contain at least one value.'],
      [
        'primary_source_ids',
        primarySourceIds.length > 0,
        'primary_source_ids must contain at least one source id.',
      ],
      [
        'evidence_ids',
        evidenceIds.length > 0,
        'evidence_ids must contain at least one evidence id.',
      ],
      ['formula', Boolean(formula), 'formula must contain an audit expression.'],
      ['unrounded_result', unrounded !== null, 'unrounded_result must be a finite number.'],
      ['result_unit', Boolean(resultUnit), 'result_unit is required.'],
      ['rounding', Boolean(rounding), 'rounding is required.'],
      [
        'assumptions',
        Array.isArray(assumptions) && assumptions.every((item) => Boolean(textToken(item))),
        'assumptions must be an array of non-empty strings (an empty array explicitly means none).',
      ],
    ] as Array<[string, boolean, string]>) {
      if (!valid) {
        blockers.push(
          makeFinding(
            'calculation_provenance_required_field_invalid',
            'blocker',
            message,
            `${entryPath}.calculation_provenance.${suffix}`,
          ),
        );
      }
    }

    if (!roundingMode || !ROUNDING_MODES.has(roundingMode)) {
      blockers.push(
        makeFinding(
          'calculation_rounding_invalid',
          'blocker',
          'rounding.mode must be none, decimal_places, or significant_figures.',
          `${entryPath}.calculation_provenance.rounding.mode`,
        ),
      );
    } else if (
      roundingMode !== 'none' &&
      (roundingDigits === null ||
        !Number.isInteger(roundingDigits) ||
        roundingDigits < (roundingMode === 'significant_figures' ? 1 : 0) ||
        roundingDigits > 15)
    ) {
      blockers.push(
        makeFinding(
          'calculation_rounding_digits_invalid',
          'blocker',
          'rounding.digits must be an integer in the supported range.',
          `${entryPath}.calculation_provenance.rounding.digits`,
        ),
      );
    }

    for (const sourceId of primarySourceIds) {
      if (!sourceIds.has(sourceId)) {
        blockers.push(
          makeFinding(
            'calculation_source_reference_missing',
            'blocker',
            `Primary source ${sourceId} is not declared in evidence_manifest.sources.`,
            `${entryPath}.calculation_provenance.primary_source_ids`,
          ),
        );
      }
    }
    for (const evidenceId of evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        blockers.push(
          makeFinding(
            'calculation_evidence_reference_missing',
            'blocker',
            `Evidence ${evidenceId} is not declared in evidence_manifest.evidence.`,
            `${entryPath}.calculation_provenance.evidence_ids`,
          ),
        );
      } else {
        const evidenceSourceId = evidenceRecordSourceId(evidence);
        if (!evidenceSourceId || !sourceIds.has(evidenceSourceId)) {
          blockers.push(
            makeFinding(
              'calculation_evidence_source_reference_missing',
              'blocker',
              `Evidence ${evidenceId} must reference a declared source.`,
              'evidence_manifest.evidence',
            ),
          );
        }
      }
    }

    const sourceValueIds = new Set<string>();
    const sourceVariables = new Map<string, number>();
    sourceValues.forEach((sourceValue, sourceIndex) => {
      const sourceValuePath = `${entryPath}.calculation_provenance.source_values[${sourceIndex}]`;
      const id = textToken(sourceValue.id);
      const sourceId = textToken(sourceValue.primary_source_id);
      const evidenceId = textToken(sourceValue.evidence_id);
      const numericValue = finiteNumber(sourceValue.value);
      if (!id || sourceValueIds.has(id)) {
        if (id) {
          sourceVariables.delete(id);
        }
        blockers.push(
          makeFinding(
            'calculation_source_value_id_invalid',
            'blocker',
            'Each source value requires a unique id.',
            `${sourceValuePath}.id`,
          ),
        );
      } else {
        sourceValueIds.add(id);
        if (numericValue !== null) {
          sourceVariables.set(id, numericValue);
        }
      }
      if (numericValue === null || !textToken(sourceValue.unit)) {
        blockers.push(
          makeFinding(
            'calculation_source_value_invalid',
            'blocker',
            'Each source value requires a finite value and unit.',
            sourceValuePath,
          ),
        );
      }
      if (!sourceId || !sourceIds.has(sourceId) || !primarySourceIds.includes(sourceId)) {
        blockers.push(
          makeFinding(
            'calculation_source_value_source_reference_invalid',
            'blocker',
            'Each source value must reference one of the declared primary_source_ids.',
            `${sourceValuePath}.primary_source_id`,
          ),
        );
      }
      const sourceValueEvidence = evidenceId ? evidenceById.get(evidenceId) : undefined;
      if (!evidenceId || !sourceValueEvidence || !evidenceIds.includes(evidenceId)) {
        blockers.push(
          makeFinding(
            'calculation_source_value_evidence_reference_invalid',
            'blocker',
            'Each source value must reference one of the declared evidence_ids.',
            `${sourceValuePath}.evidence_id`,
          ),
        );
      } else if (sourceId && evidenceRecordSourceId(sourceValueEvidence) !== sourceId) {
        blockers.push(
          makeFinding(
            'calculation_source_value_evidence_source_mismatch',
            'blocker',
            'Each source value evidence record must belong to the same primary source.',
            `${sourceValuePath}.evidence_id`,
          ),
        );
      }
    });
    const calculationVariables = new Map(sourceVariables);

    const registerCalculatedVariable = (
      name: string | null,
      value: number,
      variablePath: string,
    ): void => {
      if (!name) {
        return;
      }
      if (!isArithmeticIdentifier(name)) {
        return;
      }
      const existing = calculationVariables.get(name);
      if (existing !== undefined && !numbersMatch(existing, value)) {
        blockers.push(
          makeFinding(
            'calculation_variable_collision',
            'blocker',
            `Calculated variable ${name} would overwrite a different declared value.`,
            variablePath,
          ),
        );
        return;
      }
      calculationVariables.set(name, value);
    };

    const conversionSteps = (
      Array.isArray(provenance.conversion_steps) ? provenance.conversion_steps : []
    ).filter(isRecord);
    const conversionNotApplicable = textToken(provenance.conversion_not_applicable_reason);
    if (conversionSteps.length === 0 && !conversionNotApplicable) {
      blockers.push(
        makeFinding(
          'calculation_conversion_steps_missing',
          'blocker',
          'Provide conversion_steps or an explicit conversion_not_applicable_reason.',
          `${entryPath}.calculation_provenance.conversion_steps`,
        ),
      );
    }
    conversionSteps.forEach((step, stepIndex) => {
      const stepPath = `${entryPath}.calculation_provenance.conversion_steps[${stepIndex}]`;
      const stepId = textToken(step.id);
      const stepFormula = textToken(step.formula);
      const stepResult = finiteNumber(step.result);
      if (
        !stepId ||
        !textToken(step.description) ||
        !stepFormula ||
        stepResult === null ||
        !textToken(step.result_unit)
      ) {
        blockers.push(
          makeFinding(
            'calculation_conversion_step_invalid',
            'blocker',
            'Each conversion step requires id, description, formula, finite result, and result_unit.',
            stepPath,
          ),
        );
      }
      if (stepFormula && stepResult !== null) {
        const evaluated = evaluateArithmeticExpression(stepFormula, calculationVariables);
        if (!evaluated.ok) {
          blockers.push(
            makeFinding(
              'calculation_conversion_formula_invalid',
              'blocker',
              `Conversion formula cannot be evaluated safely: ${evaluated.error}`,
              `${stepPath}.formula`,
            ),
          );
        } else if (evaluated.referenced_identifiers.length === 0) {
          blockers.push(
            makeFinding(
              'calculation_conversion_formula_unbound',
              'blocker',
              'Conversion formulas must reference at least one declared source or prior calculated variable.',
              `${stepPath}.formula`,
            ),
          );
        } else if (!numbersMatch(evaluated.value, stepResult)) {
          blockers.push(
            makeFinding(
              'calculation_conversion_result_mismatch',
              'blocker',
              `Conversion formula evaluates to ${evaluated.value}, not the declared result ${stepResult}.`,
              `${stepPath}.result`,
            ),
          );
        } else {
          registerCalculatedVariable(
            evaluated.assigned_identifier,
            evaluated.value,
            `${stepPath}.formula`,
          );
          registerCalculatedVariable(stepId, evaluated.value, `${stepPath}.id`);
        }
      }
    });

    const denominator = provenance.normalization_denominator;
    const normalizationNotApplicable = textToken(provenance.normalization_not_applicable_reason);
    if (!isRecord(denominator) && !normalizationNotApplicable) {
      blockers.push(
        makeFinding(
          'calculation_normalization_missing',
          'blocker',
          'Provide normalization_denominator or normalization_not_applicable_reason.',
          `${entryPath}.calculation_provenance.normalization_denominator`,
        ),
      );
    } else if (isRecord(denominator)) {
      const denominatorValue = finiteNumber(denominator.value);
      const denominatorSourceIds = stringArray(denominator.source_value_ids);
      const denominatorFormula = textToken(denominator.formula);
      if (
        denominatorValue === null ||
        denominatorValue === 0 ||
        !textToken(denominator.unit) ||
        !denominatorFormula ||
        denominatorSourceIds.length === 0
      ) {
        blockers.push(
          makeFinding(
            'calculation_normalization_invalid',
            'blocker',
            'normalization_denominator requires non-zero value, unit, formula, and source_value_ids.',
            `${entryPath}.calculation_provenance.normalization_denominator`,
          ),
        );
      }
      for (const sourceValueId of denominatorSourceIds) {
        if (!sourceValueIds.has(sourceValueId)) {
          blockers.push(
            makeFinding(
              'calculation_normalization_source_reference_missing',
              'blocker',
              `Normalization source value ${sourceValueId} is not declared.`,
              `${entryPath}.calculation_provenance.normalization_denominator.source_value_ids`,
            ),
          );
        }
      }
      if (denominatorFormula && denominatorValue !== null) {
        const denominatorVariables = new Map<string, number>();
        for (const sourceValueId of denominatorSourceIds) {
          const sourceValue = sourceVariables.get(sourceValueId);
          if (sourceValue !== undefined) {
            denominatorVariables.set(sourceValueId, sourceValue);
          }
        }
        const evaluated = evaluateArithmeticExpression(denominatorFormula, denominatorVariables);
        if (!evaluated.ok) {
          blockers.push(
            makeFinding(
              'calculation_normalization_formula_invalid',
              'blocker',
              `Normalization formula cannot be evaluated safely: ${evaluated.error}`,
              `${entryPath}.calculation_provenance.normalization_denominator.formula`,
            ),
          );
        } else if (
          denominatorSourceIds.some(
            (sourceValueId) => !evaluated.referenced_identifiers.includes(sourceValueId),
          )
        ) {
          blockers.push(
            makeFinding(
              'calculation_normalization_formula_unbound',
              'blocker',
              'Normalization formulas must reference every declared denominator source_value_id.',
              `${entryPath}.calculation_provenance.normalization_denominator.formula`,
            ),
          );
        } else if (!numbersMatch(evaluated.value, denominatorValue)) {
          blockers.push(
            makeFinding(
              'calculation_normalization_value_mismatch',
              'blocker',
              `Normalization formula evaluates to ${evaluated.value}, not the declared value ${denominatorValue}.`,
              `${entryPath}.calculation_provenance.normalization_denominator.value`,
            ),
          );
        } else {
          registerCalculatedVariable(
            evaluated.assigned_identifier,
            evaluated.value,
            `${entryPath}.calculation_provenance.normalization_denominator.formula`,
          );
          registerCalculatedVariable(
            'normalization_denominator',
            evaluated.value,
            `${entryPath}.calculation_provenance.normalization_denominator`,
          );
          registerCalculatedVariable(
            'denominator',
            evaluated.value,
            `${entryPath}.calculation_provenance.normalization_denominator`,
          );
        }
      }
    }

    if (formula && unrounded !== null) {
      const evaluated = evaluateArithmeticExpression(formula, calculationVariables);
      if (!evaluated.ok) {
        blockers.push(
          makeFinding(
            'calculation_formula_invalid',
            'blocker',
            `Final calculation formula cannot be evaluated safely: ${evaluated.error}`,
            `${entryPath}.calculation_provenance.formula`,
          ),
        );
      } else if (evaluated.referenced_identifiers.length === 0) {
        blockers.push(
          makeFinding(
            'calculation_formula_unbound',
            'blocker',
            'Final calculation formulas must reference at least one declared source or calculated variable.',
            `${entryPath}.calculation_provenance.formula`,
          ),
        );
      } else if (!numbersMatch(evaluated.value, unrounded)) {
        blockers.push(
          makeFinding(
            'calculation_unrounded_result_mismatch',
            'blocker',
            `Final calculation formula evaluates to ${evaluated.value}, not the declared unrounded_result ${unrounded}.`,
            `${entryPath}.calculation_provenance.unrounded_result`,
          ),
        );
      }
    }

    const conversion = isRecord(provenance.flow_property_conversion)
      ? provenance.flow_property_conversion
      : null;
    const nativeReport = conversion && isRecord(conversion.report) ? conversion.report : null;
    const nativeResult = nativeReport && isRecord(nativeReport.result) ? nativeReport.result : null;
    const expected = roundedResult(
      nativeResult ? { ...provenance, unrounded_result: nativeResult.amount } : provenance,
    );
    if (
      nativeResult &&
      roundingMode === 'none' &&
      (textToken(entry.mean_amount) !== textToken(nativeResult.amount) ||
        textToken(entry.resulting_amount ?? entry.mean_amount) !== textToken(nativeResult.amount))
    ) {
      blockers.push(
        makeFinding(
          'flow_property_reference_quantity_precision',
          'blocker',
          'With rounding none, both reference quantities must retain the native result decimal exactly.',
          entryPath,
        ),
      );
    }
    const mean = finiteNumber(entry.mean_amount);
    const resulting = finiteNumber(entry.resulting_amount ?? entry.mean_amount);
    if (
      expected === null ||
      mean === null ||
      resulting === null ||
      !numbersMatch(expected, mean) ||
      !numbersMatch(expected, resulting)
    ) {
      blockers.push(
        makeFinding(
          'calculation_result_amount_mismatch',
          'blocker',
          'Rounded calculation_provenance result must equal both exchange mean_amount and resulting_amount.',
          entryPath,
        ),
      );
    }

    if (blockers.length === before) {
      validated += 1;
    }
  }

  if (blockers.length === 0) {
    findings.push(
      makeFinding(
        'calculation_provenance_contract_satisfied',
        'info',
        `Validated ${validated} calculated exchange provenance record(s).`,
      ),
    );
  }
  return {
    findings,
    blockers,
    summary: {
      status: blockers.length === 0 ? 'passed' : 'failed',
      required: true,
      calculated_exchange_count: entries.length,
      validated_exchange_count: validated,
    },
  };
}

function buildAnnualSupply(plan: JsonObject, referenceExchange: JsonObject): JsonObject[] {
  const explicit = firstValue(plan, [
    'required_fields.annualSupplyOrProductionVolume',
    'requiredFields.annualSupplyOrProductionVolume',
    'authoring.required_fields.annualSupplyOrProductionVolume',
    'authoring.requiredFields.annualSupplyOrProductionVolume',
    'modelling_and_validation.annualSupplyOrProductionVolume',
    'modellingAndValidation.annualSupplyOrProductionVolume',
  ]);
  if (explicit !== undefined && explicit !== null) {
    return multiLangFromValue(explicit, String(explicit));
  }

  const amount =
    textToken(referenceExchange.meanAmount) ??
    textToken(referenceExchange.resultingAmount) ??
    '1.0';
  const unit =
    firstToken(plan, [
      'quantitative_reference_plan.reference_unit',
      'quantitativeReferencePlan.referenceUnit',
      'flow_property_plan.reference_unit',
      'flowPropertyPlan.referenceUnit',
    ]) ?? 'unit';
  return [localizedText(`${amount} ${unit}/year`, 'en')];
}

function normalizeExchangeDirection(value: string | null): 'Input' | 'Output' {
  return value === 'Input' ? 'Input' : 'Output';
}

function exchangeSourceIds(entry: JsonObject): string[] {
  const provenance = calculationProvenance(entry);
  return stringArray(provenance?.primary_source_ids ?? entry.source_ids ?? entry.sourceIds);
}

function convertedExchangeQuantities(entry: JsonObject): JsonObject {
  const provenance = calculationProvenance(entry);
  const binding =
    provenance && isRecord(provenance.flow_property_conversion)
      ? provenance.flow_property_conversion
      : null;
  const report = binding && isRecord(binding.report) ? binding.report : null;
  const result = report && isRecord(report.result) ? report.result : null;
  if (!result) return {};
  return {
    meanAmount: textToken(entry.mean_amount),
    resultingAmount: textToken(entry.resulting_amount ?? entry.mean_amount),
    ...(result.minimum_amount == null ? {} : { minimumAmount: result.minimum_amount }),
    ...(result.maximum_amount == null ? {} : { maximumAmount: result.maximum_amount }),
  };
}

function exchangeFromPlan(plan: JsonObject, entry: unknown, index: number): JsonObject | null {
  if (!isRecord(entry)) {
    return null;
  }
  const flowId =
    textToken(entry.flow_id ?? entry.flowId ?? entry.reference_flow_id ?? entry.referenceFlowId) ??
    deterministicUuid(`${JSON.stringify(plan)}:exchange:${index}`);
  const internalId =
    textToken(entry.internal_id ?? entry.internalId ?? entry['@dataSetInternalID']) ??
    String(index + 1);
  const meanAmount = normalizeAmount(entry.mean_amount ?? entry.meanAmount);
  const dataSourceType = textToken(entry.data_source_type ?? entry.dataSourceType);
  const generatedComment = provenanceComment(entry);
  const explicitComment = entry.general_comment ?? entry.generalComment;
  return {
    '@dataSetInternalID': internalId,
    referenceToFlowDataSet: globalReference({
      type: 'flow data set',
      refObjectId: flowId,
      version: normalizeVersion(entry.version, '00.00.000'),
      uri: textToken(entry.uri),
      shortDescription:
        textToken(entry.short_description ?? entry.shortDescription ?? entry.name) ??
        `Exchange flow ${internalId}`,
    }),
    exchangeDirection: normalizeExchangeDirection(
      textToken(entry.direction ?? entry.exchangeDirection),
    ),
    meanAmount,
    resultingAmount: normalizeAmount(entry.resulting_amount ?? entry.resultingAmount, meanAmount),
    ...convertedExchangeQuantities(entry),
    dataDerivationTypeStatus:
      textToken(entry.data_derivation_type_status ?? entry.dataDerivationTypeStatus) ?? 'Estimated',
    ...(dataSourceType ? { dataSourceType } : {}),
    quantitativeReference: Boolean(entry.quantitative_reference ?? entry.quantitativeReference),
    referencesToDataSource: {
      referenceToDataSource: evidenceSourceReferences(plan, exchangeSourceIds(entry)),
    },
    ...(generatedComment
      ? { generalComment: generatedComment }
      : explicitComment !== undefined && explicitComment !== null
        ? { generalComment: multiLangFromValue(explicitComment, String(explicitComment)) }
        : {}),
  };
}

function exchangePlanEntries(plan: JsonObject): JsonObject[] {
  return valueAsArray(plan, ['exchange_plan.exchanges', 'exchangePlan.exchanges'])
    .map((entry, index) => exchangeFromPlan(plan, entry, index))
    .filter((entry): entry is JsonObject => Boolean(entry));
}

function referenceExchange(plan: JsonObject): JsonObject {
  const referencePlan =
    valueAsObject(plan, ['quantitative_reference_plan', 'quantitativeReferencePlan']) ?? {};
  const internalId =
    firstToken(plan, [
      'quantitative_reference_plan.reference_flow_internal_id',
      'quantitativeReferencePlan.referenceFlowInternalId',
    ]) ?? '1';
  const meanAmount =
    firstToken(plan, [
      'quantitative_reference_plan.mean_amount',
      'quantitativeReferencePlan.meanAmount',
      'quantitative_reference_plan.resulting_amount',
      'quantitativeReferencePlan.resultingAmount',
    ]) ?? '1.0';
  const resultingAmount =
    firstToken(plan, [
      'quantitative_reference_plan.resulting_amount',
      'quantitativeReferencePlan.resultingAmount',
    ]) ?? meanAmount;
  const dataSourceType = textToken(referencePlan.data_source_type ?? referencePlan.dataSourceType);
  const generatedComment = provenanceComment(referencePlan);
  return {
    '@dataSetInternalID': internalId,
    referenceToFlowDataSet: referenceFlowRef(plan),
    exchangeDirection: 'Output',
    meanAmount: normalizeAmount(meanAmount),
    resultingAmount: normalizeAmount(resultingAmount, normalizeAmount(meanAmount)),
    ...convertedExchangeQuantities(referencePlan),
    dataDerivationTypeStatus:
      firstToken(plan, [
        'quantitative_reference_plan.data_derivation_type_status',
        'quantitativeReferencePlan.dataDerivationTypeStatus',
      ]) ?? 'Estimated',
    ...(dataSourceType ? { dataSourceType } : {}),
    quantitativeReference: true,
    referencesToDataSource: {
      referenceToDataSource: evidenceSourceReferences(plan, exchangeSourceIds(referencePlan)),
    },
    ...(generatedComment ? { generalComment: generatedComment } : {}),
  };
}

function flowPropertyPlan(plan: JsonObject): JsonObject {
  return valueAsObject(plan, ['flow_property_plan', 'flowPropertyPlan']) ?? {};
}

function plannedFlowProperties(plan: JsonObject): {
  reference: string;
  properties: JsonObject[];
  before: JsonObject | null;
} {
  const propertyPlan = flowPropertyPlan(plan);
  if (!Array.isArray(propertyPlan.properties)) {
    return {
      reference: '0',
      properties: [
        {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: flowPropertyReference(plan),
          meanValue:
            firstToken(plan, ['flow_property_plan.mean_value', 'flowPropertyPlan.meanValue']) ??
            '1.0',
        },
      ],
      before: null,
    };
  }
  const beforePayload = isRecord(propertyPlan.before_flow) ? propertyPlan.before_flow : null;
  const before =
    beforePayload && isRecord(beforePayload.flowDataSet)
      ? beforePayload.flowDataSet
      : beforePayload;
  const existing = before ? inspectFlowProperties(before).properties : [];
  const properties = cloneJson(propertyPlan.properties) as JsonObject[];
  for (const old of existing) {
    const supplied = properties.find(
      (item) => isRecord(item) && item['@dataSetInternalID'] === old['@dataSetInternalID'],
    );
    if (!supplied) properties.push(cloneJson(old));
    else if (canonicalPropertyJson(supplied) !== canonicalPropertyJson(old)) {
      throw new CliError(
        'Adding secondary properties must preserve every existing property, including meanValue, comments and uncertainty.',
        { code: 'FLOW_PROPERTY_EXISTING_VALUE_CHANGED', exitCode: 2 },
      );
    }
  }
  return { reference: textToken(propertyPlan.reference_internal_id) ?? '', properties, before };
}

function buildCanonicalFlowPayload(plan: JsonObject, inputPath: string): JsonObject {
  const propertyPlan = plannedFlowProperties(plan);
  if (propertyPlan.before) {
    const flow = cloneJson(propertyPlan.before);
    const info = valueAsObject(flow, ['flowInformation']) ?? {};
    flow.flowInformation = info;
    info.quantitativeReference = {
      ...(valueAsObject(info, ['quantitativeReference']) ?? {}),
      referenceToReferenceFlowProperty: propertyPlan.reference,
    };
    flow.flowProperties = {
      ...(valueAsObject(flow, ['flowProperties']) ?? {}),
      flowProperty: propertyPlan.properties,
    };
    return { flowDataSet: flow };
  }
  const baseName = firstToken(plan, ['name_plan.base_name', 'namePlan.baseName']) ?? 'Unnamed flow';
  const flowId = uuidFromPlan(
    plan,
    ['target.uuid', 'target.id', 'identity_decision.target_id', 'identityDecision.targetId'],
    `flow:${baseName}:${inputPath}`,
  );
  const version = normalizeVersion(
    firstToken(plan, [
      'target.version',
      'publication.version',
      'administrative_information.version',
    ]),
  );
  const flowType = normalizeFlowType(
    firstToken(plan, [
      'target.flow_type',
      'target.flowType',
      'modelling_and_validation.typeOfDataSet',
    ]),
  );
  const location = firstToken(plan, ['target.geography', 'target.location']);

  return {
    flowDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Flow',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:ecn': 'http://eplca.jrc.ec.europa.eu/ILCD/Extensions/2018/ECNumber',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Flow ../../schemas/ILCD_FlowDataSet.xsd',
      flowInformation: {
        dataSetInformation: {
          'common:UUID': flowId,
          name: {
            baseName: firstMultiLang(plan, ['name_plan.base_name', 'namePlan.baseName'], baseName),
            treatmentStandardsRoutes: firstMultiLang(
              plan,
              ['name_plan.treatment_standards_routes', 'namePlan.treatmentStandardsRoutes'],
              'Reference flow',
            ),
            mixAndLocationTypes: firstMultiLang(
              plan,
              ['name_plan.mix_and_location_types', 'namePlan.mixAndLocationTypes'],
              location ?? 'Global',
            ),
          },
          classificationInformation: flowClassificationInformation(plan, flowType),
          ...(firstToken(plan, ['target.cas_number', 'target.CASNumber'])
            ? { CASNumber: firstToken(plan, ['target.cas_number', 'target.CASNumber']) }
            : {}),
          'common:generalComment': firstMultiLang(
            plan,
            ['target.general_comment', 'target.generalComment', 'evidence_manifest.summary'],
            `Flow materialized from build plan ${inputPath}.`,
          ),
        },
        quantitativeReference: {
          referenceToReferenceFlowProperty: propertyPlan.reference,
        },
        ...(location ? { geography: { locationOfSupply: location } } : {}),
      },
      modellingAndValidation: {
        LCIMethod: {
          typeOfDataSet: flowType,
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': complianceReference(plan),
            'common:approvalOfOverallCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp':
            firstToken(plan, [
              'administrative_information.time_stamp',
              'administrativeInformation.timeStamp',
            ]) ?? '1970-01-01T00:00:00.000Z',
          'common:referenceToDataSetFormat': dataSetFormatReference(plan),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': version,
          'common:permanentDataSetURI':
            firstToken(plan, ['target.permanent_uri', 'target.permanentDataSetURI']) ??
            `https://data.tiangong.earth/flows/${flowId}.xml`,
          'common:referenceToOwnershipOfDataSet': contactReference(plan, 'owner'),
        },
      },
      flowProperties: {
        flowProperty:
          propertyPlan.properties.length === 1
            ? propertyPlan.properties[0]
            : propertyPlan.properties,
      },
    },
  };
}

function buildCanonicalProcessPayload(plan: JsonObject, inputPath: string): JsonObject {
  const baseName =
    firstToken(plan, ['name_plan.base_name', 'namePlan.baseName']) ?? 'Unnamed process';
  const processId = uuidFromPlan(
    plan,
    ['target.uuid', 'target.id', 'identity_decision.target_id', 'identityDecision.targetId'],
    `process:${baseName}:${inputPath}`,
  );
  const location = firstToken(plan, ['target.geography', 'target.location']) ?? 'GLO';
  const reference = referenceExchange(plan);
  const exchangeEntries = exchangePlanEntries(plan);
  const exchanges = [reference, ...exchangeEntries.filter((entry) => !entry.quantitativeReference)];
  const annualSupply = buildAnnualSupply(plan, reference);
  const sourceRef = evidenceSourceReference(plan);
  const publicationRights = rightsDecision(plan);
  const accessRestrictions = publicationRights?.access_restrictions;

  return {
    processDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Process',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Process ../../schemas/ILCD_ProcessDataSet.xsd',
      processInformation: {
        dataSetInformation: {
          'common:UUID': processId,
          name: {
            baseName: firstMultiLang(plan, ['name_plan.base_name', 'namePlan.baseName'], baseName),
            treatmentStandardsRoutes: firstMultiLang(
              plan,
              ['name_plan.treatment_standards_routes', 'namePlan.treatmentStandardsRoutes'],
              firstToken(plan, ['target.technology_route', 'target.technologyRoute']) ??
                'Technology route documented in build plan',
            ),
            mixAndLocationTypes: firstMultiLang(
              plan,
              ['name_plan.mix_and_location_types', 'namePlan.mixAndLocationTypes'],
              location,
            ),
            functionalUnitFlowProperties: firstMultiLang(
              plan,
              [
                'name_plan.functional_unit_flow_properties',
                'namePlan.functionalUnitFlowProperties',
              ],
              firstToken(plan, [
                'quantitative_reference_plan.reference_unit',
                'quantitativeReferencePlan.referenceUnit',
              ]) ?? 'reference unit',
            ),
          },
          classificationInformation: processClassificationInformation(plan),
          'common:generalComment': firstMultiLang(
            plan,
            ['target.general_comment', 'target.generalComment', 'evidence_manifest.summary'],
            `Process materialized from build plan ${inputPath}.`,
          ),
        },
        quantitativeReference: {
          '@type': 'Reference flow(s)',
          referenceToReferenceFlow: String(reference['@dataSetInternalID']),
          functionalUnitOrOther: firstMultiLang(
            plan,
            [
              'quantitative_reference_plan.functional_unit',
              'quantitativeReferencePlan.functionalUnit',
              'name_plan.functional_unit_flow_properties',
              'namePlan.functionalUnitFlowProperties',
            ],
            `${String(reference.meanAmount)} ${
              firstToken(plan, [
                'quantitative_reference_plan.reference_unit',
                'quantitativeReferencePlan.referenceUnit',
              ]) ?? 'reference unit'
            }`,
          ),
        },
        time: {
          'common:referenceYear': normalizeYear(
            firstToken(plan, [
              'target.reference_year',
              'target.referenceYear',
              'time.reference_year',
            ]),
          ),
          'common:timeRepresentativenessDescription': firstMultiLang(
            plan,
            ['time.description', 'time.timeRepresentativenessDescription'],
            'Reference year documented in build plan evidence.',
          ),
        },
        geography: {
          locationOfOperationSupplyOrProduction: {
            '@location': location,
            descriptionOfRestrictions: firstMultiLang(
              plan,
              ['target.geography_description', 'target.geographyDescription'],
              `Operation location: ${location}.`,
            ),
          },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: firstMultiLang(
            plan,
            ['technology.description', 'technology.technologyDescriptionAndIncludedProcesses'],
            firstToken(plan, ['target.technology_route', 'target.technologyRoute']) ??
              'Technology route documented in build plan evidence.',
          ),
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: normalizeProcessType(
            firstToken(plan, [
              'modelling_and_validation.type_of_dataset',
              'modellingAndValidation.typeOfDataSet',
            ]),
          ),
          LCIMethodPrinciple:
            firstToken(plan, [
              'modelling_and_validation.lci_method_principle',
              'modellingAndValidation.lciMethodPrinciple',
            ]) ?? 'Attributional',
        },
        dataSourcesTreatmentAndRepresentativeness: {
          dataCutOffAndCompletenessPrinciples: firstMultiLang(
            plan,
            ['modelling_and_validation.data_cutoff', 'modellingAndValidation.dataCutoff'],
            'Cut-off and completeness principles are documented in the build plan evidence.',
          ),
          referenceToDataSource: sourceRef,
          annualSupplyOrProductionVolume: annualSupply,
        },
        validation: {
          review: {
            '@type': 'Not reviewed',
          },
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': complianceReference(plan),
            'common:approvalOfOverallCompliance': 'Not defined',
            'common:nomenclatureCompliance': 'Not defined',
            'common:methodologicalCompliance': 'Not defined',
            'common:reviewCompliance': 'Not defined',
            'common:documentationCompliance': 'Not defined',
            'common:qualityCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        'common:commissionerAndGoal': {
          'common:referenceToCommissioner': contactReference(plan, 'commissioner'),
          'common:intendedApplications': firstMultiLang(
            plan,
            [
              'administrative_information.intended_applications',
              'administrativeInformation.intendedApplications',
            ],
            'Automated LCA data production draft for expert review.',
          ),
        },
        dataEntryBy: {
          'common:timeStamp':
            firstToken(plan, [
              'administrative_information.time_stamp',
              'administrativeInformation.timeStamp',
            ]) ?? '1970-01-01T00:00:00.000Z',
          'common:referenceToDataSetFormat': dataSetFormatReference(plan),
          'common:referenceToPersonOrEntityEnteringTheData': contactReference(plan, 'data_entry'),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': normalizeVersion(
            firstToken(plan, [
              'target.version',
              'publication.version',
              'administrative_information.version',
            ]),
          ),
          'common:permanentDataSetURI':
            firstToken(plan, ['target.permanent_uri', 'target.permanentDataSetURI']) ??
            `https://data.tiangong.earth/processes/${processId}.xml`,
          'common:referenceToOwnershipOfDataSet': contactReference(plan, 'owner'),
          'common:copyright': copyrightValue(publicationRights) ?? 'false',
          'common:licenseType':
            textToken(publicationRights?.license_type) ?? 'Free of charge for all users and uses',
          ...(accessRestrictions !== undefined && accessRestrictions !== null
            ? {
                'common:accessRestrictions': multiLangFromValue(
                  accessRestrictions,
                  String(accessRestrictions),
                ),
              }
            : {}),
        },
      },
      exchanges: {
        exchange: exchanges,
      },
    },
  };
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function pathIsSatisfied(root: JsonObject, paths: string[]): boolean {
  const value = firstValue(root, paths);
  if (isNonEmptyArray(value)) {
    return true;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(textToken(value));
}

function evidenceBindingPaths(plan: JsonObject): Set<string> {
  const evidence = firstValue(plan, ['evidence_manifest', 'evidenceManifest']);
  const bindings = isRecord(evidence)
    ? firstValue(evidence, ['field_bindings', 'fieldBindings'])
    : undefined;
  const rows = Array.isArray(bindings) ? bindings : [];
  return new Set(
    rows
      .map((row) =>
        isRecord(row) ? textToken(row.field_path ?? row.path ?? row.field ?? row.fieldPath) : null,
      )
      .filter((rowPath): rowPath is string => Boolean(rowPath)),
  );
}

function evidenceSourcesPresent(plan: JsonObject): boolean {
  const evidence = firstValue(plan, ['evidence_manifest', 'evidenceManifest']);
  const sources = isRecord(evidence) ? firstValue(evidence, ['sources']) : undefined;
  return isNonEmptyArray(sources);
}

function decisionFromPlan(plan: JsonObject): BuildPlanDecision | null {
  const raw =
    firstToken(plan, ['identity_decision.decision', 'identityDecision.decision', 'decision']) ??
    null;
  return raw && ALL_DECISIONS.has(raw as BuildPlanDecision) ? (raw as BuildPlanDecision) : null;
}

function unitOfAnalysisFromPlan(plan: JsonObject): JsonObject | null {
  return valueAsObject(plan, ['unit_of_analysis', 'unitOfAnalysis']);
}

function unitOfAnalysisDecisionFromArtifact(artifact: JsonObject): UnitOfAnalysisDecision | null {
  const raw = textToken(artifact.decision);
  return raw && ALL_UNIT_OF_ANALYSIS_DECISIONS.has(raw as UnitOfAnalysisDecision)
    ? (raw as UnitOfAnalysisDecision)
    : null;
}

function buildPlanRuleset(plan: JsonObject, kind: BuildPlanKind): { id: string; version: string } {
  const ruleset = firstValue(plan, ['ruleset']);
  const id =
    firstToken(plan, ['ruleset_id', 'rulesetId']) ??
    (isRecord(ruleset) ? textToken(ruleset.id) : null) ??
    `${kind}-authoring/strict`;
  const version =
    firstToken(plan, ['ruleset_version', 'rulesetVersion']) ??
    (isRecord(ruleset) ? textToken(ruleset.version) : null) ??
    '1';
  return { id, version };
}

function requiredFieldSpecs(kind: BuildPlanKind): Array<{ path: string; aliases: string[] }> {
  const common = [
    { path: 'target', aliases: ['target'] },
    {
      path: 'identity_decision.decision',
      aliases: ['identity_decision.decision', 'identityDecision.decision', 'decision'],
    },
    { path: 'unit_of_analysis', aliases: ['unit_of_analysis', 'unitOfAnalysis'] },
    { path: 'name_plan.base_name', aliases: ['name_plan.base_name', 'namePlan.baseName'] },
  ];
  const process = [
    { path: 'target.geography', aliases: ['target.geography', 'target.location'] },
    {
      path: 'target.technology_route',
      aliases: ['target.technology_route', 'target.technologyRoute'],
    },
    {
      path: 'quantitative_reference_plan.reference_flow_id',
      aliases: [
        'quantitative_reference_plan.reference_flow_id',
        'quantitativeReferencePlan.referenceFlowId',
        'target.intended_reference_flow',
      ],
    },
  ];
  const flow = [
    { path: 'target.flow_type', aliases: ['target.flow_type', 'target.flowType'] },
    {
      path: 'flow_property_plan.reference_property',
      aliases: ['flow_property_plan.reference_property', 'flowPropertyPlan.referenceProperty'],
    },
    {
      path: 'flow_property_plan.reference_unit',
      aliases: ['flow_property_plan.reference_unit', 'flowPropertyPlan.referenceUnit'],
    },
  ];
  return kind === 'process' ? [...common, ...process] : [...common, ...flow];
}

function makeFinding(
  code: string,
  severity: GateFinding['severity'],
  message: string,
  pathExpression?: string,
): GateFinding {
  return pathExpression
    ? { code, severity, message, path: pathExpression }
    : { code, severity, message };
}

function evaluateUnitOfAnalysis(plan: JsonObject): {
  findings: GateFinding[];
  blockers: GateFinding[];
  decision: UnitOfAnalysisDecision | null;
} {
  const findings: GateFinding[] = [];
  const blockers: GateFinding[] = [];
  const artifact = unitOfAnalysisFromPlan(plan);
  if (!artifact) {
    blockers.push(
      makeFinding(
        'unit_of_analysis_missing',
        'blocker',
        'Build plan must include the skill-authored unit_of_analysis artifact.',
        'unit_of_analysis',
      ),
    );
    return { findings, blockers, decision: null };
  }

  const decision = unitOfAnalysisDecisionFromArtifact(artifact);
  if (!decision) {
    blockers.push(
      makeFinding(
        'unit_of_analysis_decision_missing',
        'blocker',
        'unit_of_analysis must include a supported decision.',
        'unit_of_analysis.decision',
      ),
    );
  } else if (!AUTOMATIC_UNIT_OF_ANALYSIS_DECISIONS.has(decision)) {
    blockers.push(
      makeFinding(
        'unit_of_analysis_not_automatic',
        'blocker',
        `unit_of_analysis decision ${decision} cannot proceed to materialization.`,
        'unit_of_analysis.decision',
      ),
    );
  }

  for (const spec of [
    { path: 'unit_of_analysis.target_kind', aliases: ['target_kind', 'targetKind'] },
    { path: 'unit_of_analysis.reference_flow', aliases: ['reference_flow', 'referenceFlow'] },
    {
      path: 'unit_of_analysis.reference_flow.reference_unit',
      aliases: ['reference_flow.reference_unit', 'referenceFlow.referenceUnit'],
    },
    {
      path: 'unit_of_analysis.reference_flow.reference_amount',
      aliases: ['reference_flow.reference_amount', 'referenceFlow.referenceAmount'],
    },
    {
      path: 'unit_of_analysis.reference_flow.flow_property',
      aliases: ['reference_flow.flow_property', 'referenceFlow.flowProperty'],
    },
  ]) {
    if (!pathIsSatisfied(artifact, spec.aliases)) {
      blockers.push(
        makeFinding(
          'unit_of_analysis_required_field_missing',
          'blocker',
          `unit_of_analysis is missing ${spec.path}.`,
          spec.path,
        ),
      );
    }
  }

  const hasBasis =
    pathIsSatisfied(artifact, ['functional_unit', 'functionalUnit']) ||
    pathIsSatisfied(artifact, ['declared_unit', 'declaredUnit']);
  if (!hasBasis) {
    blockers.push(
      makeFinding(
        'unit_of_analysis_basis_missing',
        'blocker',
        'unit_of_analysis must describe either functional_unit or declared_unit.',
        'unit_of_analysis.functional_unit',
      ),
    );
  }

  if (
    decision === 'ready_for_materialization' &&
    !pathIsSatisfied(artifact, [
      'scaling_evidence',
      'scalingEvidence',
      'scaling_evidence_status',
      'scalingEvidenceStatus',
    ])
  ) {
    blockers.push(
      makeFinding(
        'scaling_evidence_missing',
        'blocker',
        'ready_for_materialization requires scaling evidence or an explicit scaling evidence status.',
        'unit_of_analysis.scaling_evidence',
      ),
    );
  }

  if (blockers.length === 0) {
    findings.push(
      makeFinding(
        'unit_of_analysis_contract_satisfied',
        'info',
        'unit_of_analysis artifact is present and complete enough for deterministic validation.',
      ),
    );
  }

  return { findings, blockers, decision };
}

function conversionSourceUnitName(request: JsonObject): string | null {
  const payload = isRecord(request.flow) ? request.flow : {};
  const flow = isRecord(payload.flowDataSet) ? payload.flowDataSet : payload;
  const source = isRecord(request.source) ? request.source : {};
  const property = inspectFlowProperties(flow).properties.find(
    (item) => textToken(item['@dataSetInternalID']) === textToken(source.flow_property_internal_id),
  );
  const ref =
    property && isRecord(property.referenceToFlowPropertyDataSet)
      ? property.referenceToFlowPropertyDataSet
      : {};
  const exactDocument = (
    documents: unknown,
    wrapper: string,
    information: string,
    id: unknown,
    version: unknown,
  ): JsonObject => {
    for (const item of Array.isArray(documents) ? documents : []) {
      if (!isRecord(item)) continue;
      const document = isRecord(item[wrapper]) ? item[wrapper] : item;
      if (
        firstToken(document, [`${information}.dataSetInformation.common:UUID`]) === textToken(id) &&
        firstToken(document, [
          'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
        ]) === textToken(version)
      )
        return document;
    }
    return {};
  };
  const fp = exactDocument(
    request.flow_properties,
    'flowPropertyDataSet',
    'flowPropertiesInformation',
    ref['@refObjectId'],
    ref['@version'],
  );
  const groupRef =
    valueAsObject(fp, [
      'flowPropertiesInformation.quantitativeReference.referenceToReferenceUnitGroup',
    ]) ?? {};
  const group = exactDocument(
    request.unit_groups,
    'unitGroupDataSet',
    'unitGroupInformation',
    groupRef['@refObjectId'],
    groupRef['@version'],
  );
  const rawUnits = firstValue(group, ['units.unit']);
  const unit = (Array.isArray(rawUnits) ? rawUnits : [rawUnits])
    .filter(isRecord)
    .find((item) => textToken(item['@dataSetInternalID']) === textToken(source.unit_internal_id));
  return textToken(unit?.name);
}

function gateException(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { code: string; message: string } {
  return {
    code: error instanceof CliError ? error.code.toLowerCase() : fallbackCode,
    message: error instanceof Error ? error.message : fallbackMessage,
  };
}

function evaluatePropertyPlan(
  plan: JsonObject,
  kind: BuildPlanKind,
  options: FlowPropertyConversionOptions,
): { gate: FlowPropertyGate; blockers: GateFinding[] } {
  const gate: FlowPropertyGate = {
    schema_version: 'tiangong-lca.flow-property-gate.v1',
    status: 'not_applicable',
    plan_sha256: propertyJsonHash(plan),
    candidate_sha256: null,
    property_count: 0,
    reference_internal_id: null,
    reference_preserved: null,
    preserved_property_count: 0,
    required_conversion_count: 0,
    conversion_count: 0,
    conversions: [],
  };
  const blockers: GateFinding[] = [];
  const block = (code: string, message: string, at: string): void => {
    blockers.push(makeFinding(code, 'blocker', message, at));
  };
  if (kind === 'flow') {
    gate.status = 'passed';
    try {
      const embedded = firstValue(plan, ['payload', 'materialized_payload', 'materializedPayload']);
      const payload = isRecord(embedded)
        ? unwrapDatasetPayload(embedded)
        : buildCanonicalFlowPayload(plan, '<property-gate>');
      const flow = isRecord(payload.flowDataSet) ? payload.flowDataSet : payload;
      const inspected = inspectFlowProperties(flow);
      gate.property_count = inspected.properties.length;
      gate.reference_internal_id = inspected.referenceInternalId;
      for (const issue of inspected.issues) block(issue.code, issue.message, issue.path);
      const propertyPlan = flowPropertyPlan(plan);
      const isMultiPlan = Array.isArray(propertyPlan.properties);
      const beforePayload = isRecord(propertyPlan.before_flow) ? propertyPlan.before_flow : null;
      const before =
        beforePayload && isRecord(beforePayload.flowDataSet)
          ? beforePayload.flowDataSet
          : beforePayload;
      if (
        isMultiPlan &&
        firstToken(plan, ['identity_decision.decision', 'identityDecision.decision']) ===
          'update_same_row' &&
        !before
      ) {
        block(
          'flow_property_before_required',
          'Adding properties to an existing Flow requires the complete before_flow document.',
          'flow_property_plan.before_flow',
        );
      }
      if (before) {
        const previous = inspectFlowProperties(before);
        for (const issue of previous.issues)
          block(
            `before_${issue.code}`,
            issue.message,
            `flow_property_plan.before_flow.${issue.path}`,
          );
        gate.reference_preserved = previous.referenceInternalId === inspected.referenceInternalId;
        if (!gate.reference_preserved)
          block(
            'flow_property_reference_changed',
            'The existing reference property must remain unchanged.',
            'flow_property_plan.reference_internal_id',
          );
        for (const property of previous.properties) {
          const match = inspected.properties.find(
            (item) => item['@dataSetInternalID'] === property['@dataSetInternalID'],
          );
          if (match && canonicalPropertyJson(match) === canonicalPropertyJson(property))
            gate.preserved_property_count += 1;
          else
            block(
              'flow_property_existing_value_changed',
              'An existing property was removed or changed, including its comments/uncertainty.',
              'flow_property_plan.properties',
            );
        }
        for (const [name, pathExpression] of [
          ['uuid', 'flowInformation.dataSetInformation.common:UUID'],
          ['version', 'administrativeInformation.publicationAndOwnership.common:dataSetVersion'],
        ]) {
          const wanted = firstToken(plan, [`target.${name}`]);
          if (wanted && wanted !== firstToken(before, [pathExpression!]))
            block(
              'flow_property_identity_changed',
              'Secondary-property additions preserve the existing Flow UUID and version.',
              `target.${name}`,
            );
        }
      }
      if (
        isMultiPlan &&
        firstToken(flow, ['modellingAndValidation.LCIMethod.typeOfDataSet']) === 'Elementary flow'
      ) {
        block(
          'flow_property_elementary_not_allowed',
          'This secondary-property authoring path is limited to Product and Waste flows.',
          'target.flow_type',
        );
      }
    } catch (error) {
      const failure = gateException(
        error,
        'flow_property_plan_invalid',
        'Invalid Flow property plan.',
      );
      block(failure.code, failure.message, 'flow_property_plan');
    }
  } else {
    const rows = [
      {
        entry:
          valueAsObject(plan, ['quantitative_reference_plan', 'quantitativeReferencePlan']) ?? {},
        reference: true,
      },
      ...valueAsArray(plan, ['exchange_plan.exchanges', 'exchangePlan.exchanges'])
        .filter(isRecord)
        .map((entry) => ({ entry, reference: false })),
    ];
    for (const { entry, reference } of rows) {
      const provenance = calculationProvenance(entry);
      const binding = provenance?.flow_property_conversion;
      if (binding === undefined) continue;
      gate.status = 'passed';
      gate.required_conversion_count += 1;
      const at = 'calculation_provenance.flow_property_conversion';
      try {
        if (
          !isStrictSourceEvidence(plan) ||
          !calculatedExchangeEntries(plan).some((item) => item.entry === entry)
        )
          throw new Error(
            'Flow-property conversion requires a calculated exchange in source-evidence/strict authoring mode.',
          );
        if (!isRecord(binding) || !isRecord(binding.request) || !isRecord(binding.report))
          throw new Error('A complete native conversion request and report are required.');
        const request = binding.request;
        const suppliedReport = binding.report;
        if (request.direction !== undefined && request.direction !== 'to-reference')
          throw new Error('Process authoring accepts only to-reference conversion.');
        const flowPayload = isRecord(request.flow) ? request.flow : {};
        const flow = isRecord(flowPayload.flowDataSet) ? flowPayload.flowDataSet : flowPayload;
        const expectedId = textToken(reference ? entry.reference_flow_id : entry.flow_id);
        const expectedVersion = textToken(
          reference ? (entry.reference_flow_version ?? entry.version) : entry.version,
        );
        if (
          !expectedId ||
          !expectedVersion ||
          expectedId !== firstToken(flow, ['flowInformation.dataSetInformation.common:UUID']) ||
          expectedVersion !==
            firstToken(flow, [
              'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
            ])
        )
          throw new Error('Conversion request must bind the exact exchange Flow UUID and version.');
        const source = isRecord(request.source) ? request.source : {};
        if (
          finiteNumber(source.amount) === null ||
          textToken(source.amount) !== textToken(provenance?.unrounded_result)
        )
          throw new Error(
            'Conversion source.amount must equal the safely evaluated unrounded source quantity.',
          );
        const report = runFlowPropertyConversion(request, options);
        if (canonicalPropertyJson(report) !== canonicalPropertyJson(suppliedReport))
          throw new Error(
            'Native conversion report is stale or differs from a fresh exact-input calculation.',
          );
        const sourceUnit = conversionSourceUnitName(request);
        const declaredReferenceUnit = firstToken(plan, [
          'quantitative_reference_plan.reference_unit',
          'quantitativeReferencePlan.referenceUnit',
        ]);
        const resultUnit = textToken(provenance?.result_unit);
        if (
          !sourceUnit ||
          (resultUnit !== sourceUnit &&
            (!declaredReferenceUnit || resultUnit !== `${sourceUnit}/${declaredReferenceUnit}`))
        ) {
          throw new Error(
            'Source result_unit must match the exact selected UnitGroup unit, optionally divided by the declared Process reference unit; unsupported composite units require an explicit authoring correction.',
          );
        }
        if (resultUnit !== sourceUnit) {
          const referencePlan = valueAsObject(plan, [
            'quantitative_reference_plan',
            'quantitativeReferencePlan',
          ])!;
          const mean =
            firstToken(referencePlan, [
              'mean_amount',
              'meanAmount',
              'resulting_amount',
              'resultingAmount',
            ]) ?? '1.0';
          const resulting =
            firstToken(referencePlan, ['resulting_amount', 'resultingAmount']) ?? mean;
          if (!isExactOne(mean) || !isExactOne(resulting))
            throw new Error(
              'A source/reference-unit ratio is admissible only for a Process reference quantity of exactly 1. For another reference quantity, explicitly normalize the source amount to that quantity and declare the source unit without a ratio.',
            );
        }
        const internalId = textToken(
          reference ? entry.reference_flow_internal_id : entry.internal_id,
        );
        if (!internalId) throw new Error('A conversion exchange needs an explicit internal ID.');
        if (gate.conversions.some((item) => item.exchange_internal_id === internalId))
          throw new Error('Conversion exchange internal IDs must be unique.');
        gate.conversions.push({
          exchange_internal_id: internalId,
          request_sha256: String(report.request_sha256),
          report,
        });
        gate.conversion_count += 1;
      } catch (error) {
        const failure = gateException(
          error,
          'flow_property_conversion_invalid',
          'Native conversion failed.',
        );
        block('flow_property_conversion_invalid', failure.message, at);
      }
    }
  }
  if (blockers.length) gate.status = 'failed';
  return { gate, blockers };
}

function evaluateBuildPlan(
  plan: JsonObject,
  kind: BuildPlanKind,
  options: FlowPropertyConversionOptions = {},
): Evaluation {
  const findings: GateFinding[] = [];
  const blockers: GateFinding[] = [];
  const propertyValidation = evaluatePropertyPlan(plan, kind, options);
  blockers.push(...propertyValidation.blockers);
  const expectedKind = firstToken(plan, ['kind', 'dataset_kind', 'datasetKind']);
  if (expectedKind && expectedKind !== kind) {
    blockers.push(
      makeFinding(
        'build_plan_kind_mismatch',
        'blocker',
        `Expected ${kind} build plan but received ${expectedKind}.`,
        'kind',
      ),
    );
  }

  const decision = decisionFromPlan(plan);
  if (!decision) {
    blockers.push(
      makeFinding(
        'identity_decision_missing',
        'blocker',
        'Build plan must include a supported identity decision.',
        'identity_decision.decision',
      ),
    );
  } else if (!AUTO_DECISIONS.has(decision)) {
    blockers.push(
      makeFinding(
        'identity_decision_not_automatic',
        'blocker',
        `Build plan identity decision ${decision} cannot proceed without review.`,
        'identity_decision.decision',
      ),
    );
  }

  if (!evidenceSourcesPresent(plan)) {
    blockers.push(
      makeFinding(
        'evidence_sources_missing',
        'blocker',
        'EvidenceManifest must include at least one source.',
        'evidence_manifest.sources',
      ),
    );
  }

  const embeddedPayload = firstValue(plan, [
    'payload',
    'materialized_payload',
    'materializedPayload',
  ]);
  if (isRecord(embeddedPayload)) {
    const classificationIssues = collectClassificationIssues(
      unwrapDatasetPayload(embeddedPayload),
      kind === 'process' ? 'processes' : 'flows',
      '<materialized-payload>',
    );
    blockers.push(
      ...classificationIssues.map((issue) =>
        makeFinding(issue.issue_code, 'blocker', issue.message, issue.location),
      ),
    );
  } else {
    try {
      if (kind === 'process') {
        processClassificationInformation(plan);
      } else {
        flowClassificationInformation(
          plan,
          normalizeFlowType(
            firstToken(plan, [
              'target.flow_type',
              'target.flowType',
              'modelling_and_validation.typeOfDataSet',
            ]),
          ),
        );
      }
    } catch (error) {
      const failure = gateException(
        error,
        'tidas_classification_resolution_failed',
        'Classification path could not be resolved against the bundled TIDAS catalog.',
      );
      blockers.push(
        makeFinding(failure.code, 'blocker', failure.message, 'target.classification_path'),
      );
    }
  }

  const unitOfAnalysis = evaluateUnitOfAnalysis(plan);
  findings.push(...unitOfAnalysis.findings);
  blockers.push(...unitOfAnalysis.blockers);

  const calculationProvenance =
    kind === 'process'
      ? evaluateCalculationProvenance(plan)
      : {
          findings: [] as GateFinding[],
          blockers: [] as GateFinding[],
          summary: {
            status: 'not_applicable' as const,
            required: false,
            calculated_exchange_count: 0,
            validated_exchange_count: 0,
          },
        };
  findings.push(...calculationProvenance.findings);
  blockers.push(...calculationProvenance.blockers);
  if (kind === 'process') {
    const publicationRights = evaluatePublicationRights(plan);
    findings.push(...publicationRights.findings);
    blockers.push(...publicationRights.blockers);
  }

  const bindingPaths = evidenceBindingPaths(plan);
  const required = requiredFieldSpecs(kind).filter(
    (spec) =>
      !(
        kind === 'flow' &&
        Array.isArray(flowPropertyPlan(plan).properties) &&
        spec.path.startsWith('flow_property_plan.')
      ),
  );
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const spec of required) {
    if (pathIsSatisfied(plan, spec.aliases)) {
      satisfied.push(spec.path);
      if (!bindingPaths.has(spec.path)) {
        blockers.push(
          makeFinding(
            'evidence_binding_missing',
            'blocker',
            `EvidenceManifest must bind source evidence to ${spec.path}.`,
            spec.path,
          ),
        );
      }
    } else {
      missing.push(spec.path);
      blockers.push(
        makeFinding(
          'build_plan_required_field_missing',
          'blocker',
          `Build plan is missing ${spec.path}.`,
          spec.path,
        ),
      );
    }
  }

  if (blockers.length === 0) {
    findings.push(
      makeFinding(
        'build_plan_contract_satisfied',
        'info',
        `${kind} build plan satisfies the minimum authoring gate contract.`,
      ),
    );
  }

  return {
    plan,
    findings,
    blockers,
    requiredFields: {
      required: required.map((spec) => spec.path),
      satisfied,
      missing,
    },
    decision,
    unitOfAnalysisDecision: unitOfAnalysis.decision,
    calculationProvenance: calculationProvenance.summary,
    propertyValidation: propertyValidation.gate,
  };
}

function schemaForKind(
  kind: BuildPlanKind,
  schemas: Partial<Record<BuildPlanKind, SafeParseSchema>> | undefined,
): SchemaSpec {
  const injected = schemas?.[kind] ?? null;
  if (injected) {
    return {
      validator: 'injected',
      schema: injected,
      createEntity: null,
    };
  }

  const schema = (tidasSdk as unknown as Record<string, SafeParseSchema>)[
    String(SCHEMA_EXPORTS[kind])
  ];
  const createEntity = (tidasSdk as unknown as Record<string, SdkValidationFactory>)[
    String(ENTITY_FACTORY_EXPORTS[kind])
  ];
  return {
    validator: `@tiangong-lca/tidas-sdk/${String(SCHEMA_EXPORTS[kind])}`,
    schema,
    createEntity,
  };
}

function normalizeSchemaIssue(issue: {
  path?: Array<string | number>;
  message?: string;
  code?: string;
}): { path: string; message: string; code: string } {
  return {
    path: normalizeIssuePath(issue.path),
    message: issue.message ?? 'Validation failed',
    code: issue.code ?? 'custom',
  };
}

function validateMaterializedSchema(
  artifact: JsonObject,
  kind: BuildPlanKind,
  schemas: Partial<Record<BuildPlanKind, SafeParseSchema>> | undefined,
): SchemaValidationSummary {
  const detectedKind = detectDatasetKind(artifact);
  if (!detectedKind) {
    return {
      status: 'not_applicable',
      validator: null,
      issue_count: 0,
      issues: [],
    };
  }
  if (detectedKind !== kind) {
    return {
      status: 'failed',
      validator: null,
      issue_count: 1,
      issues: [
        {
          path: '<root>',
          message: `Expected ${kind} payload but detected ${detectedKind}.`,
          code: 'dataset_kind_mismatch',
        },
      ],
    };
  }

  const { validator, schema, createEntity } = schemaForKind(kind, schemas);
  const payload = unwrapDatasetPayload(artifact);
  const outcome = validateSchemaWithDeepFallback(schema, payload, createEntity);
  const issues = [
    ...outcome.issues.map(normalizeSchemaIssue),
    ...collectClassificationIssues(
      payload,
      kind === 'process' ? 'processes' : 'flows',
      '<materialized-payload>',
    ).map((issue) => ({
      path: issue.location,
      message: issue.message,
      code: issue.issue_code,
    })),
  ];
  if (issues.length === 0) {
    return {
      status: 'passed',
      validator,
      issue_count: 0,
      issues: [],
    };
  }

  return {
    status: 'failed',
    validator,
    issue_count: issues.length,
    issues,
  };
}

function materializePlan(plan: JsonObject, kind: BuildPlanKind, inputPath: string): JsonObject {
  const payload = firstValue(plan, ['payload', 'materialized_payload', 'materializedPayload']);
  if (isRecord(payload)) {
    return cloneJson(payload);
  }
  return kind === 'process'
    ? buildCanonicalProcessPayload(plan, inputPath)
    : buildCanonicalFlowPayload(plan, inputPath);
}

function emptySchemaValidation(): SchemaValidationSummary {
  return {
    status: 'not_applicable',
    validator: null,
    issue_count: 0,
    issues: [],
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

function sha256Json(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest('hex');
}

function sourceReferenceIds(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .filter(isRecord)
    .map((row) => textToken(row['@refObjectId']))
    .filter((id): id is string => Boolean(id));
}

function sourceReferenceProjection(value: unknown): JsonObject[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(isRecord).map((row) => ({
    uuid: textToken(row['@refObjectId']),
    version: textToken(row['@version']),
  }));
}

function localizedTextProjection(value: unknown): Array<{ lang: string | null; text: string }> {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(isRecord).map((row) => ({
    lang: textToken(row['@xml:lang']),
    text: textToken(row['#text']) ?? '',
  }));
}

function processCriticalProjection(artifact: JsonObject): JsonObject {
  const dataSet = valueAsObject(artifact, ['processDataSet']) ?? artifact;
  const exchangeRows = valueAsArray(dataSet, ['exchanges.exchange']).filter(isRecord);
  const exchanges = exchangeRows
    .map((exchange) => {
      const flowReference = isRecord(exchange.referenceToFlowDataSet)
        ? exchange.referenceToFlowDataSet
        : {};
      const sourceContainer = isRecord(exchange.referencesToDataSource)
        ? exchange.referencesToDataSource
        : {};
      return {
        internal_id: textToken(exchange['@dataSetInternalID']),
        flow_id: textToken(flowReference['@refObjectId']),
        flow_version: textToken(flowReference['@version']),
        direction: textToken(exchange.exchangeDirection),
        mean_amount: textToken(exchange.meanAmount),
        resulting_amount: textToken(exchange.resultingAmount),
        minimum_amount: textToken(exchange.minimumAmount),
        maximum_amount: textToken(exchange.maximumAmount),
        data_source_type: textToken(exchange.dataSourceType),
        data_derivation_type_status: textToken(exchange.dataDerivationTypeStatus),
        source_ids: sourceReferenceIds(sourceContainer.referenceToDataSource),
        source_references: sourceReferenceProjection(sourceContainer.referenceToDataSource),
        general_comment: localizedTextProjection(exchange.generalComment),
      };
    })
    .sort((left, right) => (left.internal_id ?? '').localeCompare(right.internal_id ?? ''));
  return {
    dataset_uuid: firstToken(dataSet, ['processInformation.dataSetInformation.common:UUID']),
    dataset_version: firstToken(dataSet, [
      'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
    ]),
    reference_exchange_internal_id: firstToken(dataSet, [
      'processInformation.quantitativeReference.referenceToReferenceFlow',
    ]),
    type_of_dataset: firstToken(dataSet, [
      'modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet',
    ]),
    reference_year: firstToken(dataSet, ['processInformation.time.common:referenceYear']),
    geography: firstToken(dataSet, [
      'processInformation.geography.locationOfOperationSupplyOrProduction.@location',
    ]),
    source_references: sourceReferenceProjection(
      firstValue(dataSet, [
        'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource',
      ]),
    ),
    annual_supply_or_production_volume: localizedTextProjection(
      firstValue(dataSet, [
        'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      ]),
    ),
    publication_rights: {
      copyright: firstToken(dataSet, [
        'administrativeInformation.publicationAndOwnership.common:copyright',
      ]),
      license_type: firstToken(dataSet, [
        'administrativeInformation.publicationAndOwnership.common:licenseType',
      ]),
      access_restrictions: localizedTextProjection(
        firstValue(dataSet, [
          'administrativeInformation.publicationAndOwnership.common:accessRestrictions',
        ]),
      ),
    },
    exchanges,
  };
}

export function verifyProcessBuildPlanInvariants(
  plan: JsonObject,
  candidate: JsonObject,
  now: Date = new Date(),
  inputPath = '<invariant-verification>',
): ProcessBuildPlanInvariantReport {
  const expectedArtifact = isStrictSourceEvidence(plan)
    ? buildCanonicalProcessPayload(plan, inputPath)
    : materializePlan(plan, 'process', inputPath);
  const expected = processCriticalProjection(expectedArtifact);
  const actual = processCriticalProjection(candidate);
  const checks: InvariantCheck[] = [];
  const compare = (pathExpression: string, expectedValue: unknown, actualValue: unknown): void => {
    const normalizedExpected = canonicalJsonValue(expectedValue);
    const normalizedActual = canonicalJsonValue(actualValue);
    checks.push({
      path: pathExpression,
      status:
        JSON.stringify(normalizedExpected) === JSON.stringify(normalizedActual)
          ? 'passed'
          : 'failed',
      expected: normalizedExpected,
      actual: normalizedActual,
    });
  };
  for (const field of [
    'dataset_uuid',
    'dataset_version',
    'reference_exchange_internal_id',
    'type_of_dataset',
    'reference_year',
    'geography',
    'source_references',
    'annual_supply_or_production_volume',
    'publication_rights',
  ]) {
    compare(field, expected[field], actual[field]);
  }
  const expectedExchanges = valueAsArray(expected, ['exchanges']).filter(isRecord);
  const actualExchanges = valueAsArray(actual, ['exchanges']).filter(isRecord);
  compare(
    'exchanges.internal_ids',
    expectedExchanges.map((entry) => entry.internal_id),
    actualExchanges.map((entry) => entry.internal_id),
  );
  for (const expectedExchange of expectedExchanges) {
    const internalId = String(expectedExchange.internal_id);
    const actualExchange = actualExchanges.find((entry) => entry.internal_id === internalId) ?? {};
    for (const field of [
      'flow_id',
      'flow_version',
      'direction',
      'mean_amount',
      'resulting_amount',
      'minimum_amount',
      'maximum_amount',
      'data_source_type',
      'data_derivation_type_status',
      'source_ids',
      'source_references',
      'general_comment',
    ]) {
      compare(`exchanges[${internalId}].${field}`, expectedExchange[field], actualExchange[field]);
    }
  }
  const mismatchCount = checks.filter((check) => check.status === 'failed').length;
  return {
    schema_version: 1,
    generated_at_utc: nowIso(now),
    status: mismatchCount === 0 ? 'passed' : 'failed',
    authoring_mode: authoringMode(plan),
    plan_sha256: sha256Json(plan),
    candidate_sha256: sha256Json(candidate),
    calculated_exchange_count: calculatedExchangeEntries(plan).length,
    checked_count: checks.length,
    mismatch_count: mismatchCount,
    checks,
  };
}

function emptyInvariantReport(
  plan: JsonObject,
  generatedAt: string,
): ProcessBuildPlanInvariantReport {
  return {
    schema_version: 1,
    generated_at_utc: generatedAt,
    status: 'not_applicable',
    authoring_mode: authoringMode(plan),
    plan_sha256: sha256Json(plan),
    candidate_sha256: null,
    calculated_exchange_count: calculatedExchangeEntries(plan).length,
    checked_count: 0,
    mismatch_count: 0,
    checks: [],
  };
}

function calculationProvenanceArtifact(plan: JsonObject): JsonObject {
  return {
    schema_version: 1,
    plan_sha256: sha256Json(plan),
    authoring_mode: authoringMode(plan),
    calculated_exchange_count: calculatedExchangeEntries(plan).length,
    exchanges: calculatedExchangeEntries(plan).map(({ entry, path: entryPath }) => ({
      path: entryPath,
      internal_id: textToken(
        entryPath === 'quantitative_reference_plan'
          ? entry.reference_flow_internal_id
          : entry.internal_id,
      ),
      flow_id: textToken(
        entryPath === 'quantitative_reference_plan' ? entry.reference_flow_id : entry.flow_id,
      ),
      mean_amount: textToken(entry.mean_amount),
      resulting_amount: textToken(entry.resulting_amount ?? entry.mean_amount),
      data_source_type: textToken(entry.data_source_type),
      calculation_provenance: cloneJson(calculationProvenance(entry) as JsonObject),
      generated_general_comment: provenanceComment(entry),
    })),
  };
}

function reportPaths(
  outDir: string | null,
  kind: BuildPlanKind,
  action: BuildPlanAction,
): BuildPlanFiles {
  if (!outDir) {
    return {
      gate_report: null,
      materialized_artifact: null,
      calculation_provenance_artifact: null,
      invariant_report: null,
    };
  }
  return {
    gate_report: path.join(outDir, 'outputs', 'build-plan-gate-report.json'),
    materialized_artifact:
      action === 'verify' ? null : path.join(outDir, 'outputs', `materialized-${kind}.json`),
    calculation_provenance_artifact:
      kind === 'process' ? path.join(outDir, 'outputs', 'calculation-provenance.json') : null,
    invariant_report:
      action === 'verify' ? path.join(outDir, 'outputs', 'build-plan-invariant-report.json') : null,
  };
}

function makeReport(options: {
  kind: BuildPlanKind;
  action: BuildPlanAction;
  inputPath: string;
  outDir: string | null;
  reportOnly: boolean;
  evaluation: Evaluation;
  schemaValidation: SchemaValidationSummary;
  invariantVerification: ProcessBuildPlanInvariantReport;
  generatedAt: string;
  files: BuildPlanFiles;
}): BuildPlanGateReport {
  const ruleset = buildPlanRuleset(options.evaluation.plan, options.kind);
  const schemaBlockers =
    options.schemaValidation.status === 'failed'
      ? [
          makeFinding(
            'materialized_schema_failed',
            'blocker',
            'Materialized payload failed schema validation.',
            'materialized_artifact',
          ),
        ]
      : [];
  const invariantBlockers =
    options.invariantVerification.status === 'failed'
      ? [
          makeFinding(
            'critical_invariant_mismatch',
            'blocker',
            `Candidate payload differs from ${options.invariantVerification.mismatch_count} critical build-plan invariant(s).`,
            'invariant_verification',
          ),
        ]
      : [];
  const blockers = [...options.evaluation.blockers, ...schemaBlockers, ...invariantBlockers];
  const status: BuildPlanStatus = blockers.length > 0 ? 'blocked' : 'passed';
  return {
    schema_version: 1,
    generated_at_utc: options.generatedAt,
    kind: options.kind,
    action: options.action,
    status,
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    input_path: options.inputPath,
    out_dir: options.outDir,
    report_only: options.reportOnly,
    inputs: {
      plan_schema_version:
        textToken(options.evaluation.plan.schema_version) ??
        textToken(options.evaluation.plan.schemaVersion),
      identity_decision: options.evaluation.decision,
      unit_of_analysis_decision: options.evaluation.unitOfAnalysisDecision,
    },
    required_fields: options.evaluation.requiredFields,
    calculation_provenance: options.evaluation.calculationProvenance,
    invariant_verification: options.invariantVerification,
    property_validation: options.evaluation.propertyValidation,
    schema_validation: options.schemaValidation,
    findings: options.evaluation.findings,
    blockers,
    next_action:
      status === 'blocked'
        ? 'fix_build_plan'
        : options.action === 'validate'
          ? 'materialize_payload'
          : options.action === 'verify'
            ? 'use_verified_artifact'
            : 'use_materialized_artifact',
    files: options.files,
  };
}

async function runBuildPlan(
  kind: BuildPlanKind,
  action: BuildPlanAction,
  options: RunBuildPlanOptions,
): Promise<BuildPlanGateReport> {
  const inputPath = requiredInputPath(options.inputPath);
  const outDir = options.outDir?.trim() ? options.outDir.trim() : null;
  const files = reportPaths(outDir, kind, action);
  const evaluation = evaluateBuildPlan(
    readBuildPlanInput(inputPath, options.rawInput),
    kind,
    options,
  );
  const generatedAt = nowIso(options.now);
  const candidatePath = action === 'verify' ? requiredCandidatePath(options.candidatePath) : null;
  const candidate =
    candidatePath === null
      ? null
      : asObject(
          options.rawCandidate === undefined ? readJsonInput(candidatePath) : options.rawCandidate,
          'build-plan candidate',
        );
  const materialized =
    action === 'materialize' && evaluation.blockers.length === 0
      ? materializePlan(evaluation.plan, kind, inputPath)
      : null;
  const suppliedPayload = firstValue(evaluation.plan, [
    'payload',
    'materialized_payload',
    'materializedPayload',
  ]);
  const schemaCandidate =
    action === 'verify'
      ? candidate
      : (materialized ?? (isRecord(suppliedPayload) ? cloneJson(suppliedPayload) : null));
  const schemaValidation = schemaCandidate
    ? validateMaterializedSchema(schemaCandidate, kind, options.schemas)
    : emptySchemaValidation();
  evaluation.propertyValidation.candidate_sha256 = schemaCandidate
    ? propertyJsonHash(schemaCandidate)
    : null;
  const invariantCandidate =
    candidate ??
    (evaluation.propertyValidation.required_conversion_count > 0 ? schemaCandidate : null);
  const invariantVerification =
    invariantCandidate && evaluation.blockers.length === 0
      ? kind === 'process'
        ? verifyProcessBuildPlanInvariants(
            evaluation.plan,
            invariantCandidate,
            options.now,
            inputPath,
          )
        : verifyFlowBuildPlanInvariants(evaluation.plan, invariantCandidate, options.now, inputPath)
      : emptyInvariantReport(evaluation.plan, generatedAt);
  const report = makeReport({
    kind,
    action,
    inputPath,
    outDir,
    reportOnly: Boolean(options.reportOnly),
    evaluation,
    schemaValidation,
    invariantVerification,
    generatedAt,
    files,
  });

  if (files.gate_report) {
    writeJsonArtifact(files.gate_report, report);
  }
  if (files.materialized_artifact && materialized) {
    writeJsonArtifact(files.materialized_artifact, materialized);
  }
  if (
    files.calculation_provenance_artifact &&
    action === 'materialize' &&
    materialized &&
    evaluation.calculationProvenance.required
  ) {
    writeJsonArtifact(
      files.calculation_provenance_artifact,
      calculationProvenanceArtifact(evaluation.plan),
    );
  }
  if (files.invariant_report && action === 'verify') {
    writeJsonArtifact(files.invariant_report, invariantVerification);
  }
  return report;
}

export async function runProcessBuildPlanValidate(
  options: RunProcessBuildPlanValidateOptions,
): Promise<ProcessBuildPlanGateReport> {
  return (await runBuildPlan('process', 'validate', options)) as ProcessBuildPlanGateReport;
}

export async function runProcessBuildPlanMaterialize(
  options: RunProcessBuildPlanMaterializeOptions,
): Promise<ProcessBuildPlanGateReport> {
  return (await runBuildPlan('process', 'materialize', options)) as ProcessBuildPlanGateReport;
}

export async function runProcessBuildPlanVerify(
  options: RunProcessBuildPlanVerifyOptions,
): Promise<ProcessBuildPlanGateReport> {
  return (await runBuildPlan('process', 'verify', options)) as ProcessBuildPlanGateReport;
}

export async function runFlowBuildPlanValidate(
  options: RunFlowBuildPlanValidateOptions,
): Promise<FlowBuildPlanGateReport> {
  return (await runBuildPlan('flow', 'validate', options)) as FlowBuildPlanGateReport;
}

export async function runFlowBuildPlanMaterialize(
  options: RunFlowBuildPlanMaterializeOptions,
): Promise<FlowBuildPlanGateReport> {
  return (await runBuildPlan('flow', 'materialize', options)) as FlowBuildPlanGateReport;
}

export async function runFlowBuildPlanVerify(
  options: RunBuildPlanOptions,
): Promise<FlowBuildPlanGateReport> {
  return (await runBuildPlan('flow', 'verify', options)) as FlowBuildPlanGateReport;
}

export function verifyFlowBuildPlanInvariants(
  plan: JsonObject,
  candidate: JsonObject,
  now = new Date(),
  inputPath = '<flow-invariant-verification>',
): ProcessBuildPlanInvariantReport {
  const expectedPayload = materializePlan(plan, 'flow', inputPath);
  const expected = isRecord(expectedPayload.flowDataSet)
    ? expectedPayload.flowDataSet
    : expectedPayload;
  const actual = isRecord(candidate.flowDataSet) ? candidate.flowDataSet : candidate;
  const paths = [
    'flowInformation.dataSetInformation.common:UUID',
    'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
    'flowInformation.quantitativeReference.referenceToReferenceFlowProperty',
    'flowProperties',
    'modellingAndValidation.LCIMethod.typeOfDataSet',
  ];
  const checks: InvariantCheck[] = paths.map((at) => ({
    path: at,
    status:
      canonicalPropertyJson(valueAtPath(expected, at)) ===
      canonicalPropertyJson(valueAtPath(actual, at))
        ? 'passed'
        : 'failed',
    expected: valueAtPath(expected, at),
    actual: valueAtPath(actual, at),
  }));
  const mismatchCount = checks.filter((check) => check.status === 'failed').length;
  return {
    schema_version: 1,
    generated_at_utc: nowIso(now),
    status: mismatchCount ? 'failed' : 'passed',
    authoring_mode: authoringMode(plan),
    plan_sha256: propertyJsonHash(plan),
    candidate_sha256: propertyJsonHash(candidate),
    calculated_exchange_count: 0,
    checked_count: checks.length,
    mismatch_count: mismatchCount,
    checks,
  };
}

export const __testInternals = {
  decisionFromPlan,
  evidenceBindingPaths,
  evaluateBuildPlan,
  loadBuildPlan,
  materializePlan,
  validateMaterializedSchema,
  buildCanonicalFlowPayload,
  buildCanonicalProcessPayload,
  buildAnnualSupply,
  multiLangFromValue,
  calculatedExchangeEntries,
  evidenceRecords,
  evidenceRecordId,
  evidenceRecordSourceId,
  roundedResult,
  evaluateArithmeticExpression,
  provenanceComment,
  splitProvenanceComment,
  calculationProvenanceArtifact,
  canonicalJsonValue,
  processCriticalProjection,
  sourceReferenceIds,
  localizedTextProjection,
  referenceExchange,
  conversionSourceUnitName,
  convertedExchangeQuantities,
  gateException,
};
