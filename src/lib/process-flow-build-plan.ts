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
import { readJsonInput } from './io.js';
import {
  validateProcessPayload,
  type ProcessValidationLayers,
} from './process-payload-validation.js';
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
type BuildPlanAction = 'validate' | 'materialize';
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
  schema_validation: SchemaValidationSummary;
  validation_layers?: ProcessValidationLayers;
  findings: GateFinding[];
  blockers: GateFinding[];
  next_action: 'materialize_payload' | 'use_materialized_artifact' | 'fix_build_plan';
  files: BuildPlanFiles;
};

export type RunBuildPlanOptions = {
  inputPath: string;
  outDir?: string | null;
  reportOnly?: boolean;
  rawInput?: unknown;
  now?: Date;
  schemas?: Partial<Record<BuildPlanKind, SafeParseSchema>>;
};

export type RunProcessBuildPlanValidateOptions = RunBuildPlanOptions;
export type RunProcessBuildPlanMaterializeOptions = RunBuildPlanOptions;
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

function evidenceSourceReference(plan: JsonObject): JsonObject {
  const evidence = valueAsObject(plan, ['evidence_manifest', 'evidenceManifest']) ?? {};
  const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
  const firstSource = sources.find(isRecord);
  const sourceId =
    textToken(firstSource?.id ?? firstSource?.source_id ?? firstSource?.ref_object_id) ??
    deterministicUuid(`${JSON.stringify(plan)}:source`);
  const sourceVersion = textToken(firstSource?.version) ?? '00.00.000';
  const shortDescription =
    textToken(firstSource?.title ?? firstSource?.name ?? firstSource?.short_description) ??
    'Build plan evidence source';
  return globalReference({
    type: 'source data set',
    refObjectId: sourceId,
    version: sourceVersion,
    uri: textToken(firstSource?.uri),
    shortDescription,
  });
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

  return rawPath.map((entry, index) => {
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
      canonicalClassificationEntries(plan, '@catId'),
      'elementary-flow',
    );
    return {
      'common:elementaryFlowCategorization': {
        'common:category': entries,
      },
    };
  }
  const entries = requireClassificationHierarchy(
    canonicalClassificationEntries(plan, '@classId'),
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
    canonicalClassificationEntries(plan, '@classId'),
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

function buildAnnualSupply(plan: JsonObject): JsonObject[] {
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

  return [];
}

function normalizeExchangeDirection(value: string | null): 'Input' | 'Output' {
  return value === 'Input' ? 'Input' : 'Output';
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
    dataDerivationTypeStatus:
      textToken(entry.data_derivation_type_status ?? entry.dataDerivationTypeStatus) ?? 'Estimated',
    quantitativeReference: Boolean(entry.quantitative_reference ?? entry.quantitativeReference),
    referencesToDataSource: {
      referenceToDataSource: evidenceSourceReference(plan),
    },
  };
}

function exchangePlanEntries(plan: JsonObject): JsonObject[] {
  return valueAsArray(plan, ['exchange_plan.exchanges', 'exchangePlan.exchanges'])
    .map((entry, index) => exchangeFromPlan(plan, entry, index))
    .filter((entry): entry is JsonObject => Boolean(entry));
}

function referenceExchange(plan: JsonObject): JsonObject {
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
  return {
    '@dataSetInternalID': internalId,
    referenceToFlowDataSet: referenceFlowRef(plan),
    exchangeDirection: 'Output',
    meanAmount: normalizeAmount(meanAmount),
    resultingAmount: normalizeAmount(resultingAmount, normalizeAmount(meanAmount)),
    dataDerivationTypeStatus:
      firstToken(plan, [
        'quantitative_reference_plan.data_derivation_type_status',
        'quantitativeReferencePlan.dataDerivationTypeStatus',
      ]) ?? 'Estimated',
    quantitativeReference: true,
    referencesToDataSource: {
      referenceToDataSource: evidenceSourceReference(plan),
    },
  };
}

function buildCanonicalFlowPayload(plan: JsonObject, inputPath: string): JsonObject {
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
  const propertyMean =
    firstToken(plan, ['flow_property_plan.mean_value', 'flowPropertyPlan.meanValue']) ?? '1.0';
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
          referenceToReferenceFlowProperty: '0',
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
        flowProperty: {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: flowPropertyReference(plan),
          meanValue: normalizeAmount(propertyMean),
        },
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
  const annualSupply = buildAnnualSupply(plan);
  const sourceRef = evidenceSourceReference(plan);

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
          'common:copyright': 'false',
          'common:licenseType': 'Free of charge for all users and uses',
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

function evaluateBuildPlan(plan: JsonObject, kind: BuildPlanKind): Evaluation {
  const findings: GateFinding[] = [];
  const blockers: GateFinding[] = [];
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

  const unitOfAnalysis = evaluateUnitOfAnalysis(plan);
  findings.push(...unitOfAnalysis.findings);
  blockers.push(...unitOfAnalysis.blockers);

  const bindingPaths = evidenceBindingPaths(plan);
  const required = requiredFieldSpecs(kind);
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

function reportPaths(outDir: string | null, kind: BuildPlanKind): BuildPlanFiles {
  if (!outDir) {
    return {
      gate_report: null,
      materialized_artifact: null,
    };
  }
  return {
    gate_report: path.join(outDir, 'outputs', 'build-plan-gate-report.json'),
    materialized_artifact: path.join(outDir, 'outputs', `materialized-${kind}.json`),
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
  const blockers = [...options.evaluation.blockers, ...schemaBlockers];
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
    schema_validation: options.schemaValidation,
    findings: options.evaluation.findings,
    blockers,
    next_action:
      status === 'blocked'
        ? 'fix_build_plan'
        : options.action === 'validate'
          ? 'materialize_payload'
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
  const files = reportPaths(outDir, kind);
  const evaluation = evaluateBuildPlan(readBuildPlanInput(inputPath, options.rawInput), kind);
  const materialized =
    action === 'materialize' && evaluation.blockers.length === 0
      ? materializePlan(evaluation.plan, kind, inputPath)
      : null;
  const schemaValidation = materialized
    ? validateMaterializedSchema(materialized, kind, options.schemas)
    : emptySchemaValidation();
  let validationLayers: ProcessValidationLayers | undefined;
  if (kind === 'process' && materialized && detectDatasetKind(materialized) === 'process') {
    const { schema, createEntity } = schemaForKind(kind, options.schemas);
    validationLayers = validateProcessPayload(
      unwrapDatasetPayload(materialized),
      schema,
      createEntity,
    ).validation_layers;
    for (const issue of [
      ...validationLayers.authoring.issues,
      ...validationLayers.content.issues,
    ]) {
      evaluation.blockers.push(makeFinding(issue.code, 'blocker', issue.message, issue.path));
    }
  }
  const report = makeReport({
    kind,
    action,
    inputPath,
    outDir,
    reportOnly: Boolean(options.reportOnly),
    evaluation,
    schemaValidation,
    generatedAt: nowIso(options.now),
    files,
  });
  if (validationLayers) report.validation_layers = validationLayers;

  if (files.gate_report) {
    writeJsonArtifact(files.gate_report, report);
  }
  if (files.materialized_artifact && materialized) {
    writeJsonArtifact(files.materialized_artifact, materialized);
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
};
