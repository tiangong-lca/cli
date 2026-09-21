import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import {
  cloneJson,
  datasetRoot,
  firstNonEmpty,
  isRecord,
  materializeDatasetRows,
  type DatasetRowInput,
  type JsonObject,
} from './dataset-local.js';

export const ANNUAL_SUPPLY_FIELD =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume';
const ANNUAL_SUPPLY_ROOT_FIELD =
  'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume';
const DATA_SOURCES_TREATMENT_FIELD =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness';
const ANNUAL_SUPPLY_MISSING_DATA_SENTINEL_TEXT = '9999 missing-data-sentinel/year';
const NUMERIC_TEXT_WITH_SUFFIX_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([Ee][+-]?\d+)?\s+\S.*$/u;
const ANNUAL_PERIOD_PATTERN =
  /(?:\/\s*(?:year|yr|a)\b|\bper\s+(?:year|annum)\b|\/\s*年|每年|年度|年供应|年产)/iu;
const ANNUAL_UNAVAILABLE_PATTERN =
  /\b(?:source\s+)?(?:production\s+)?volume\s+(?:unavailable|unknown|not\s+available)\b/iu;
const CJK_TEXT_PATTERN = /[\p{Script=Han}]/u;
const NET_CALORIFIC_VALUE_ID = '93a60a56-a3c8-11da-a746-0800200c9a66';
const DEFAULT_COMPLIANCE_SYSTEM = {
  '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
  '@type': 'source data set',
  '@uri': 'https://tiangong.earth/datasets/c84c4185-d1b0-44fc-823e-d2ec630c7906',
  '@version': '00.00.001',
  'common:shortDescription': {
    '@xml:lang': 'en',
    '#text': 'Environmental Footprint (EF) 3.1',
  },
} as const;
const DEFAULT_COMPLIANCE_DECLARATION = {
  'common:referenceToComplianceSystem': DEFAULT_COMPLIANCE_SYSTEM,
  'common:approvalOfOverallCompliance': 'Not defined',
  'common:nomenclatureCompliance': 'Not defined',
  'common:methodologicalCompliance': 'Not defined',
  'common:reviewCompliance': 'Not defined',
  'common:documentationCompliance': 'Not defined',
  'common:qualityCompliance': 'Not defined',
} as const;
const REQUIRED_COMPLIANCE_FIELDS = [
  'common:approvalOfOverallCompliance',
  'common:nomenclatureCompliance',
  'common:methodologicalCompliance',
  'common:reviewCompliance',
  'common:documentationCompliance',
  'common:qualityCompliance',
] as const;

type AnnualSupplyStatus = 'existing' | 'completed' | 'blocked' | 'skipped';

export type ProcessRequiredFieldIssue = {
  code: string;
  message: string;
  path: string;
};

export type ProcessRequiredFieldCompletion = {
  field_path: string;
  source:
    | 'existing'
    | 'evidence'
    | 'unknown_preserved'
    | 'placeholder_repair'
    | 'required_structure_repair';
  value: Array<{ '#text': string; '@xml:lang': string }>;
  amount: string | null;
  unit: string | null;
  reference_exchange_internal_id: string | null;
  basis: string;
};

export type ProcessRequiredFieldsRowReport = {
  index: number;
  id: string | null;
  version: string | null;
  type: string | null;
  status: AnnualSupplyStatus;
  issues: ProcessRequiredFieldIssue[];
  completions: ProcessRequiredFieldCompletion[];
};

export type ProcessRequiredFieldsReport = {
  generated_at_utc: string;
  input_path: string;
  out_path: string;
  out_dir: string | null;
  status: 'completed' | 'completed_with_blockers';
  default_unit: string;
  counts: {
    total: number;
    processes: number;
    completed: number;
    existing: number;
    blocked: number;
    skipped: number;
  };
  files: {
    output_rows: string;
    report: string | null;
    evidence: string | null;
  };
  rows: ProcessRequiredFieldsRowReport[];
};

export type RunProcessRequiredFieldsCompleteOptions = {
  inputPath: string;
  outPath: string;
  outDir?: string | null;
  defaultUnit?: string | null;
  flowInputPath?: string | null;
  rawInput?: unknown;
  rawFlowInput?: unknown;
  now?: Date;
};

type CompletionContext = {
  defaultUnit: string;
  flowUnitById?: Map<string, string>;
};

type AnnualSupplyEvidenceValue = {
  value: Array<{ '#text': string; '@xml:lang': string }>;
  amount: string;
  unit: string;
  basis: string;
};

function normalizeUnit(value: string | null | undefined): string {
  const token = value?.trim();
  return token || 'unit';
}

function sourceLanguageForText(value: string, fallback = 'en'): string {
  return CJK_TEXT_PATTERN.test(value) ? 'zh' : fallback;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}

function valueAtPath(root: unknown, pathExpression: string): unknown {
  let current = root;
  for (const segment of pathExpression.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function annualSupplyItems(value: unknown): Array<{ '#text': string; '@xml:lang': string }> {
  return asList(value).filter((item): item is { '#text': string; '@xml:lang': string } => {
    return (
      isRecord(item) && typeof item['#text'] === 'string' && typeof item['@xml:lang'] === 'string'
    );
  });
}

function isValidAnnualSupplyVolume(value: unknown): boolean {
  const items = annualSupplyItems(value);
  return (
    items.length > 0 &&
    items.length === asList(value).length &&
    new Set(items.map((item) => item['@xml:lang'].toLowerCase())).size === items.length &&
    items.every((item) => {
      const text = item['#text'].trim();
      return (
        !isUnknownAnnualSupplyValue(item) &&
        !ANNUAL_UNAVAILABLE_PATTERN.test(text) &&
        NUMERIC_TEXT_WITH_SUFFIX_PATTERN.test(text) &&
        ANNUAL_PERIOD_PATTERN.test(text)
      );
    })
  );
}

function isUnknownAnnualSupplyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) {
    return value.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry['@xml:lang'] === 'string' &&
        entry['@xml:lang'].trim() !== '' &&
        typeof entry['#text'] === 'string' &&
        isUnknownAnnualSupplyValue(entry),
    );
  }
  const text = typeof value === 'string' ? value : isRecord(value) ? value['#text'] : null;
  if (typeof text !== 'string') return false;
  return (
    text.trim() === '' ||
    text.trim() === ANNUAL_SUPPLY_MISSING_DATA_SENTINEL_TEXT ||
    /^(?:not specified\.?|not declared in source package\.?|(?:source )?(?:production )?volume (?:unavailable|unknown|not available)\.?)$/iu.test(
      text.trim(),
    )
  );
}

function isValidReview(value: unknown): boolean {
  return asList(value).some((item) => isRecord(item) && Boolean(firstNonEmpty(item['@type'])));
}

function isValidComplianceDeclaration(value: unknown): boolean {
  return asList(value).some((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const complianceSystem = isRecord(item['common:referenceToComplianceSystem'])
      ? item['common:referenceToComplianceSystem']
      : {};
    return (
      Boolean(firstNonEmpty(complianceSystem['@refObjectId'])) &&
      REQUIRED_COMPLIANCE_FIELDS.every((field) => Boolean(firstNonEmpty(item[field])))
    );
  });
}

export function collectProcessRequiredFieldIssues(
  payload: JsonObject,
): ProcessRequiredFieldIssue[] {
  const root = datasetRoot(payload, 'process');
  const modelling = isRecord(root.modellingAndValidation) ? root.modellingAndValidation : {};
  const dataSources = isRecord(modelling.dataSourcesTreatmentAndRepresentativeness)
    ? modelling.dataSourcesTreatmentAndRepresentativeness
    : null;
  if (!dataSources) {
    return [
      {
        code: 'process_data_sources_treatment_missing',
        message: 'Process payload must include dataSourcesTreatmentAndRepresentativeness.',
        path: DATA_SOURCES_TREATMENT_FIELD,
      },
    ];
  }

  const issues: ProcessRequiredFieldIssue[] = [];
  const validation = isRecord(modelling.validation) ? modelling.validation : {};
  if (!isValidReview(validation.review)) {
    issues.push({
      code: 'process_validation_review_missing',
      message: 'Process payload must include modellingAndValidation.validation.review.',
      path: 'processDataSet.modellingAndValidation.validation.review',
    });
  }

  const complianceDeclarations = isRecord(modelling.complianceDeclarations)
    ? modelling.complianceDeclarations
    : {};
  if (!isValidComplianceDeclaration(complianceDeclarations.compliance)) {
    issues.push({
      code: 'process_compliance_declaration_missing',
      message:
        'Process payload must include modellingAndValidation.complianceDeclarations.compliance.',
      path: 'processDataSet.modellingAndValidation.complianceDeclarations.compliance',
    });
  }

  const annualSupply = dataSources.annualSupplyOrProductionVolume;
  if (isValidAnnualSupplyVolume(annualSupply)) {
    return issues;
  }

  const items = annualSupplyItems(annualSupply);
  if (items.length === 0 || asList(annualSupply).some(isUnknownAnnualSupplyValue)) {
    return [
      ...issues,
      {
        code: 'annual_supply_or_production_volume_missing',
        message:
          'Process payload must include annualSupplyOrProductionVolume as numeric text with a unit or context suffix.',
        path: ANNUAL_SUPPLY_FIELD,
      },
    ];
  }

  if (items.some((item) => ANNUAL_UNAVAILABLE_PATTERN.test(item['#text'].trim()))) {
    return [
      ...issues,
      {
        code: 'annual_supply_or_production_volume_missing',
        message:
          'Process payload must include annualSupplyOrProductionVolume as numeric text with a unit or context suffix.',
        path: ANNUAL_SUPPLY_FIELD,
      },
    ];
  }

  if (
    items.every((item) => NUMERIC_TEXT_WITH_SUFFIX_PATTERN.test(item['#text'].trim())) &&
    items.some((item) => !ANNUAL_PERIOD_PATTERN.test(item['#text'].trim()))
  ) {
    return [
      ...issues,
      {
        code: 'annual_supply_or_production_volume_not_annualized',
        message:
          'annualSupplyOrProductionVolume must express an annualized amount such as "3.6 MJ/year" or "3.6 MJ/年", not a reference-flow description.',
        path: ANNUAL_SUPPLY_FIELD,
      },
    ];
  }

  return [
    ...issues,
    {
      code: 'annual_supply_or_production_volume_invalid',
      message:
        'annualSupplyOrProductionVolume must start with a real number followed by a unit or context suffix.',
      path: ANNUAL_SUPPLY_FIELD,
    },
  ];
}

function issuePath(pathSegments: Array<string | number>): string {
  return pathSegments.length > 0 ? pathSegments.map(String).join('.') : '<root>';
}

function collectPlaceholderIssuesFromValue(
  value: unknown,
  pathSegments: Array<string | number>,
  issues: ProcessRequiredFieldIssue[],
): void {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      (pathSegments.at(-1) === 'common:referenceYear' && normalized === '9999') ||
      normalized.includes('tidas_import_placeholder') ||
      normalized.includes('tidas_import_trace_v1') ||
      normalized.includes('not declared in source package') ||
      normalized.includes('source package metadata not declared') ||
      normalized === '<null>' ||
      /(^|[\s"'`])(?:\/users\/|\/home\/|[a-z]:\\)/iu.test(value) ||
      normalized.includes('placeholder.example') ||
      normalized.includes('pending confirmation') ||
      /00000000-0000-0000-0000-0000000000[0-9a-f]{2}/u.test(normalized)
    ) {
      issues.push({
        code: 'process_placeholder_content',
        message:
          'Process payload contains placeholder or pending-confirmation content that must be replaced before save or publish.',
        path: issuePath(pathSegments),
      });
    }
    return;
  }

  if (typeof value === 'number') {
    if (pathSegments.at(-1) === 'common:referenceYear' && value === 9999) {
      issues.push({
        code: 'process_placeholder_content',
        message:
          'Process payload contains placeholder or pending-confirmation content that must be replaced before save or publish.',
        path: issuePath(pathSegments),
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPlaceholderIssuesFromValue(item, [...pathSegments, index], issues),
    );
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectPlaceholderIssuesFromValue(child, [...pathSegments, key], issues);
    }
  }
}

export function collectProcessPlaceholderIssues(payload: JsonObject): ProcessRequiredFieldIssue[] {
  const root = datasetRoot(payload, 'process');
  const issues: ProcessRequiredFieldIssue[] = [];
  collectPlaceholderIssuesFromValue(root, ['processDataSet'], issues);
  return issues;
}

function hasPlaceholderContent(value: unknown): boolean {
  const issues: ProcessRequiredFieldIssue[] = [];
  collectPlaceholderIssuesFromValue(value, [], issues);
  return issues.length > 0;
}

function removePlaceholderField(
  parent: JsonObject,
  key: string,
  fieldPath: string,
  completions: ProcessRequiredFieldCompletion[],
): void {
  if (!hasPlaceholderContent(parent[key])) {
    return;
  }
  delete parent[key];
  completions.push({
    field_path: fieldPath,
    source: 'placeholder_repair',
    value: [],
    amount: null,
    unit: null,
    reference_exchange_internal_id: null,
    basis:
      'Removed placeholder review metadata because the dataset is marked Not reviewed and no completed review evidence is present.',
  });
}

function repairPlaceholderReviewMetadata(root: JsonObject): ProcessRequiredFieldCompletion[] {
  const modelling = isRecord(root.modellingAndValidation) ? root.modellingAndValidation : {};
  const validation = isRecord(modelling.validation) ? modelling.validation : null;
  if (!validation) {
    return [];
  }

  const completions: ProcessRequiredFieldCompletion[] = [];
  const validationPath = 'processDataSet.modellingAndValidation.validation';
  for (const key of [
    'reviewDetails',
    'common:reviewDetails',
    'common:referenceToCompleteReviewReport',
    'common:referenceToNameOfReviewerAndInstitution',
  ]) {
    removePlaceholderField(validation, key, `${validationPath}.${key}`, completions);
  }

  if (isRecord(validation.review)) {
    const reviewPath = `${validationPath}.review`;
    for (const key of [
      'reviewDetails',
      'common:reviewDetails',
      'common:referenceToCompleteReviewReport',
      'common:referenceToNameOfReviewerAndInstitution',
    ]) {
      removePlaceholderField(validation.review, key, `${reviewPath}.${key}`, completions);
    }
  }

  return completions;
}

function addRequiredStructureCompletion(
  completions: ProcessRequiredFieldCompletion[],
  fieldPath: string,
  basis: string,
): void {
  completions.push({
    field_path: fieldPath,
    source: 'required_structure_repair',
    value: [],
    amount: null,
    unit: null,
    reference_exchange_internal_id: null,
    basis,
  });
}

function repairRequiredProcessStructures(root: JsonObject): ProcessRequiredFieldCompletion[] {
  const completions: ProcessRequiredFieldCompletion[] = [];
  if (!isRecord(root.modellingAndValidation)) {
    root.modellingAndValidation = {};
  }
  const modelling = root.modellingAndValidation as JsonObject;

  if (!isRecord(modelling.validation)) {
    modelling.validation = {};
  }
  const validation = modelling.validation as JsonObject;
  if (!isValidReview(validation.review)) {
    validation.review = {
      '@type': 'Not reviewed',
    };
    addRequiredStructureCompletion(
      completions,
      'processDataSet.modellingAndValidation.validation.review',
      'Inserted a conservative Not reviewed marker because UI roundtrip or source data omitted the required validation.review structure.',
    );
  }

  if (!isRecord(modelling.complianceDeclarations)) {
    modelling.complianceDeclarations = {};
  }
  const complianceDeclarations = modelling.complianceDeclarations as JsonObject;
  if (!isValidComplianceDeclaration(complianceDeclarations.compliance)) {
    complianceDeclarations.compliance = cloneJson(DEFAULT_COMPLIANCE_DECLARATION);
    addRequiredStructureCompletion(
      completions,
      'processDataSet.modellingAndValidation.complianceDeclarations.compliance',
      'Inserted a conservative Not defined compliance declaration against EF 3.1 because UI roundtrip or source data omitted the required compliance structure.',
    );
  }

  return completions;
}

function processRootForMutation(payload: JsonObject): JsonObject {
  if (isRecord(payload.processDataSet)) {
    return payload.processDataSet;
  }
  return payload;
}

function selectReferenceExchange(root: JsonObject): JsonObject | null {
  const exchangesRoot = isRecord(root.exchanges) ? root.exchanges : {};
  const exchanges = asList(exchangesRoot.exchange).filter(isRecord);
  const processInfo = isRecord(root.processInformation) ? root.processInformation : {};
  const quantitativeReference = isRecord(processInfo.quantitativeReference)
    ? processInfo.quantitativeReference
    : {};
  const referenceId = firstNonEmpty(quantitativeReference.referenceToReferenceFlow);

  const byReferenceId = referenceId
    ? exchanges.find((exchange) => firstNonEmpty(exchange['@dataSetInternalID']) === referenceId)
    : null;
  if (byReferenceId) {
    return byReferenceId;
  }

  return (
    exchanges.find((exchange) => exchange.quantitativeReference === true) ??
    exchanges.find(
      (exchange) => String(exchange.exchangeDirection ?? '').toLowerCase() === 'output',
    ) ??
    null
  );
}

function localizedTextIncludes(value: unknown, pattern: RegExp): boolean {
  return annualSupplyItems(value).some((item) => pattern.test(item['#text']));
}

function inferSpecificUnitFromFlowPayload(payload: JsonObject): string | null {
  const root = datasetRoot(payload, 'flow');
  const flowPropertiesRoot = isRecord(root.flowProperties) ? root.flowProperties : {};
  const flowProperties = asList(flowPropertiesRoot.flowProperty).filter(isRecord);
  for (const flowProperty of flowProperties) {
    const direct = firstNonEmpty(
      flowProperty.unit,
      flowProperty.referenceUnit,
      flowProperty.flowUnit,
    );
    if (direct) {
      return direct;
    }

    const flowPropertyRef = isRecord(flowProperty.referenceToFlowPropertyDataSet)
      ? flowProperty.referenceToFlowPropertyDataSet
      : {};
    const flowPropertyId = firstNonEmpty(flowPropertyRef['@refObjectId']);
    const flowPropertyText = flowPropertyRef['common:shortDescription'];
    if (
      flowPropertyId === NET_CALORIFIC_VALUE_ID ||
      localizedTextIncludes(flowPropertyText, /Net calorific|净热值/u)
    ) {
      return 'MJ';
    }
  }

  const flowInformation = isRecord(root.flowInformation) ? root.flowInformation : {};
  const dataSetInformation = isRecord(flowInformation.dataSetInformation)
    ? flowInformation.dataSetInformation
    : {};
  const classificationInformation = isRecord(dataSetInformation.classificationInformation)
    ? dataSetInformation.classificationInformation
    : {};
  const classification = isRecord(classificationInformation['common:classification'])
    ? classificationInformation['common:classification']
    : {};
  const classificationClasses = classification['common:class'];
  if (
    localizedTextIncludes(classificationClasses, /Electrical energy|electricity|交流电|电力|电能/iu)
  ) {
    return 'MJ';
  }

  return null;
}

function buildFlowUnitIndex(
  flowRows: DatasetRowInput[],
  fallbackUnit: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of flowRows) {
    if (row.kind !== 'flow' || !row.id) {
      continue;
    }
    const inferred = inferSpecificUnitFromFlowPayload(row.payload);
    if (inferred && inferred !== fallbackUnit) {
      index.set(row.id, inferred);
    }
  }
  return index;
}

function inferUnitFromReferenceExchange(
  exchange: JsonObject,
  fallbackOrContext: string | CompletionContext,
): string {
  const context =
    typeof fallbackOrContext === 'string' ? { defaultUnit: fallbackOrContext } : fallbackOrContext;
  const fallbackUnit = context.defaultUnit;
  const flowRef = isRecord(exchange.referenceToFlowDataSet) ? exchange.referenceToFlowDataSet : {};
  const refObjectId = firstNonEmpty(flowRef['@refObjectId']);
  if (refObjectId) {
    const indexedUnit = context.flowUnitById?.get(refObjectId);
    if (indexedUnit) {
      return indexedUnit;
    }
  }

  const direct = firstNonEmpty(exchange.unit, exchange.referenceUnit, exchange.flowUnit);
  if (direct) {
    return direct;
  }

  const shortDescriptions = flowRef['common:shortDescription'];
  if (
    localizedTextIncludes(
      shortDescriptions,
      /MJ|net calorific|lower calorific|Electrical energy|electricity|净热值|低位发热|交流电|电力|电能/iu,
    )
  ) {
    return 'MJ';
  }

  const flowProperty = isRecord(exchange.flowProperty) ? exchange.flowProperty : {};
  const flowPropertyRef = isRecord(flowProperty.referenceToFlowPropertyDataSet)
    ? flowProperty.referenceToFlowPropertyDataSet
    : {};
  const flowPropertyId = firstNonEmpty(flowPropertyRef['@refObjectId']);
  const flowPropertyText = flowPropertyRef['common:shortDescription'];
  if (
    refObjectId === NET_CALORIFIC_VALUE_ID ||
    flowPropertyId === NET_CALORIFIC_VALUE_ID ||
    localizedTextIncludes(flowPropertyText, /Net calorific|净热值/u)
  ) {
    return 'MJ';
  }

  return fallbackUnit;
}

function buildAnnualSupplyValue(
  amount: string,
  unit: string,
): Array<{
  '#text': string;
  '@xml:lang': string;
}> {
  return [{ '@xml:lang': 'en', '#text': `${amount} ${unit}/year` }];
}

function annualSupplyTextParts(value: string): { amount: string; unit: string } | null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)\s+(\S.*)$/u.exec(value);
  return match ? { amount: match[1] as string, unit: (match[2] as string).trim() } : null;
}

function annualSupplyValueFromText(value: string): AnnualSupplyEvidenceValue | null {
  const text = value.trim();
  if (
    isUnknownAnnualSupplyValue(text) ||
    !NUMERIC_TEXT_WITH_SUFFIX_PATTERN.test(text) ||
    !ANNUAL_PERIOD_PATTERN.test(text)
  ) {
    return null;
  }
  const parts = annualSupplyTextParts(text) as { amount: string; unit: string };
  return {
    value: [{ '@xml:lang': sourceLanguageForText(text), '#text': text }],
    amount: parts.amount,
    unit: parts.unit,
    basis: 'Evidence provided a complete annual supply / production volume text value.',
  };
}

function normalizeAnnualSupplyEvidenceValue(
  candidate: unknown,
  context: CompletionContext,
): AnnualSupplyEvidenceValue | null {
  if (typeof candidate === 'string') {
    return annualSupplyValueFromText(candidate);
  }

  if (isValidAnnualSupplyVolume(candidate)) {
    const value = structuredClone(annualSupplyItems(candidate));
    const parts = annualSupplyTextParts(value[0]!['#text']) as { amount: string; unit: string };
    return {
      value,
      amount: parts.amount,
      unit: parts.unit,
      basis:
        'Evidence provided a validated source-language annual supply / production volume value.',
    };
  }

  if (!isRecord(candidate)) {
    return null;
  }

  for (const key of [
    'value',
    'text',
    'value_text',
    'valueText',
    'annualSupplyOrProductionVolume',
    'annual_supply_or_production_volume',
  ]) {
    const nested = normalizeAnnualSupplyEvidenceValue(candidate[key], context);
    if (nested) {
      return nested;
    }
  }

  const preferredLanguage = textValue(
    candidate.source_language ??
      candidate.sourceLanguage ??
      candidate.lang ??
      candidate['@xml:lang'],
  )?.toLowerCase();
  const english = textValue(candidate.en ?? candidate.english);
  const chinese = textValue(candidate.zh ?? candidate.chinese ?? candidate['zh-CN']);
  const localized = [
    english ? { '@xml:lang': 'en', '#text': english } : null,
    chinese ? { '@xml:lang': 'zh', '#text': chinese } : null,
  ].filter((item): item is { '#text': string; '@xml:lang': string } => Boolean(item));
  if (localized.length > 0 && isValidAnnualSupplyVolume(localized)) {
    const selected =
      localized.find((item) => item['@xml:lang'].toLowerCase() === preferredLanguage) ??
      localized[0]!;
    const value = [selected];
    const parts = annualSupplyTextParts(selected['#text']) as {
      amount: string;
      unit: string;
    };
    return {
      value,
      amount: parts.amount,
      unit: parts.unit,
      basis: 'Evidence provided a language-specific annual supply / production volume text value.',
    };
  }

  const amount = textValue(candidate.amount ?? candidate.value_amount ?? candidate.valueAmount);
  const unit = textValue(candidate.unit ?? candidate.uom);
  if (amount && unit) {
    const value = ANNUAL_PERIOD_PATTERN.test(unit)
      ? [{ '@xml:lang': 'en', '#text': `${amount} ${unit}` }]
      : buildAnnualSupplyValue(amount, unit);
    if (!isValidAnnualSupplyVolume(value)) return null;
    return {
      value,
      amount,
      unit,
      basis:
        'Evidence provided annual supply / production volume amount and unit as structured fields.',
    };
  }

  return null;
}

function isAnnualSupplyEvidencePath(pathExpression: string | null): boolean {
  if (!pathExpression) {
    return false;
  }
  return (
    pathExpression === ANNUAL_SUPPLY_FIELD ||
    pathExpression === ANNUAL_SUPPLY_ROOT_FIELD ||
    pathExpression.endsWith(`.${ANNUAL_SUPPLY_ROOT_FIELD}`) ||
    pathExpression.endsWith('.annualSupplyOrProductionVolume')
  );
}

function fieldPathFromEvidenceEntry(entry: JsonObject): string | null {
  return firstNonEmpty(
    entry.field_path,
    entry.fieldPath,
    entry.path,
    entry.field,
    entry.target_path,
    entry.targetPath,
  );
}

function findAnnualSupplyEvidenceEntry(
  container: unknown,
  context: CompletionContext,
): AnnualSupplyEvidenceValue | null {
  if (!isRecord(container)) {
    return null;
  }

  const directPath = fieldPathFromEvidenceEntry(container);
  if (isAnnualSupplyEvidencePath(directPath)) {
    const directValue = normalizeAnnualSupplyEvidenceValue(container, context);
    if (directValue) {
      return directValue;
    }
  }

  for (const key of [
    'field_values',
    'fieldValues',
    'field_bindings',
    'fieldBindings',
    'bindings',
  ]) {
    const entries = asList(container[key]).filter(isRecord);
    for (const entry of entries) {
      if (!isAnnualSupplyEvidencePath(fieldPathFromEvidenceEntry(entry))) {
        continue;
      }
      const value = normalizeAnnualSupplyEvidenceValue(entry, context);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function findAnnualSupplyEvidenceValue(
  row: JsonObject,
  payload: JsonObject,
  context: CompletionContext,
): AnnualSupplyEvidenceValue | null {
  const explicitPaths = [
    'annualSupplyOrProductionVolume',
    'annual_supply_or_production_volume',
    'required_fields.annualSupplyOrProductionVolume',
    'requiredFields.annualSupplyOrProductionVolume',
    'authoring.required_fields.annualSupplyOrProductionVolume',
    'authoring.requiredFields.annualSupplyOrProductionVolume',
    'process_authoring.required_fields.annualSupplyOrProductionVolume',
    'processAuthoring.requiredFields.annualSupplyOrProductionVolume',
  ];
  for (const source of [row, payload]) {
    for (const explicitPath of explicitPaths) {
      const value = normalizeAnnualSupplyEvidenceValue(valueAtPath(source, explicitPath), context);
      if (value) {
        return value;
      }
    }
  }

  const evidencePaths = [
    'evidence_manifest',
    'evidenceManifest',
    'authoring_evidence',
    'authoringEvidence',
    'process_authoring.evidence_manifest',
    'processAuthoring.evidenceManifest',
  ];
  for (const source of [row, payload]) {
    for (const evidencePath of evidencePaths) {
      const value = findAnnualSupplyEvidenceEntry(valueAtPath(source, evidencePath), context);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function ensureDataSources(root: JsonObject): JsonObject {
  if (!isRecord(root.modellingAndValidation)) {
    root.modellingAndValidation = {};
  }
  const modelling = root.modellingAndValidation as JsonObject;
  if (!isRecord(modelling.dataSourcesTreatmentAndRepresentativeness)) {
    modelling.dataSourcesTreatmentAndRepresentativeness = {};
  }
  return modelling.dataSourcesTreatmentAndRepresentativeness as JsonObject;
}

function annualSupplyUnknownCompletion(): ProcessRequiredFieldCompletion {
  return {
    field_path: ANNUAL_SUPPLY_FIELD,
    source: 'unknown_preserved',
    value: [],
    amount: null,
    unit: null,
    reference_exchange_internal_id: null,
    basis:
      'Annual supply or production volume remains unknown. The empty representation grants no authoring completeness, publication readiness or production-weight eligibility.',
  };
}

function cloneRowWithPayload(row: DatasetRowInput): { row: JsonObject; payload: JsonObject } {
  const clonedRow = cloneJson(row.row);
  if (isRecord(clonedRow.json_ordered)) {
    return { row: clonedRow, payload: clonedRow.json_ordered };
  }
  if (isRecord(clonedRow.jsonOrdered)) {
    return { row: clonedRow, payload: clonedRow.jsonOrdered };
  }
  if (isRecord(clonedRow.json)) {
    return { row: clonedRow, payload: clonedRow.json };
  }
  if (isRecord(clonedRow.payload)) {
    return { row: clonedRow, payload: clonedRow.payload };
  }
  if (isRecord(clonedRow.process)) {
    return { row: clonedRow, payload: clonedRow.process };
  }
  return { row: clonedRow, payload: clonedRow };
}

function completeProcessRow(
  row: DatasetRowInput,
  context: CompletionContext,
): { row: JsonObject; report: ProcessRequiredFieldsRowReport } {
  const { row: clonedRow, payload } = cloneRowWithPayload(row);
  if (row.kind !== 'process') {
    return {
      row: clonedRow,
      report: {
        index: row.index,
        id: row.id,
        version: row.version,
        type: row.kind,
        status: 'skipped',
        issues: [],
        completions: [],
      },
    };
  }

  const root = processRootForMutation(payload);
  const placeholderCompletions = repairPlaceholderReviewMetadata(root);
  const requiredStructureCompletions = repairRequiredProcessStructures(root);
  const repairCompletions = [...placeholderCompletions, ...requiredStructureCompletions];
  const existingIssues = collectProcessRequiredFieldIssues(payload);
  const placeholderIssues = collectProcessPlaceholderIssues(payload);

  if (existingIssues.length === 0 && placeholderIssues.length === 0) {
    return {
      row: clonedRow,
      report: {
        index: row.index,
        id: row.id,
        version: row.version,
        type: row.kind,
        status: repairCompletions.length > 0 ? 'completed' : 'existing',
        issues: [],
        completions: repairCompletions,
      },
    };
  }

  if (placeholderIssues.length > 0) {
    return {
      row: clonedRow,
      report: {
        index: row.index,
        id: row.id,
        version: row.version,
        type: row.kind,
        status: 'blocked',
        issues: [...existingIssues, ...placeholderIssues],
        completions: repairCompletions,
      },
    };
  }

  const evidenceValue = findAnnualSupplyEvidenceValue(clonedRow, payload, context);
  if (evidenceValue) {
    const dataSources = ensureDataSources(root);
    dataSources.annualSupplyOrProductionVolume = evidenceValue.value;
    const completion: ProcessRequiredFieldCompletion = {
      field_path: ANNUAL_SUPPLY_FIELD,
      source: 'evidence',
      value: evidenceValue.value,
      amount: evidenceValue.amount,
      unit: evidenceValue.unit,
      reference_exchange_internal_id: null,
      basis: evidenceValue.basis,
    };
    return {
      row: clonedRow,
      report: {
        index: row.index,
        id: row.id,
        version: row.version,
        type: row.kind,
        status: 'completed',
        issues: [],
        completions: [...repairCompletions, completion],
      },
    };
  }

  const dataSources = ensureDataSources(root);
  const unknownCompletions: ProcessRequiredFieldCompletion[] = [];
  if (isUnknownAnnualSupplyValue(dataSources.annualSupplyOrProductionVolume)) {
    const completion = annualSupplyUnknownCompletion();
    dataSources.annualSupplyOrProductionVolume = completion.value;
    unknownCompletions.push(completion);
  }
  return {
    row: clonedRow,
    report: {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.kind,
      status: 'blocked',
      issues: collectProcessRequiredFieldIssues(payload),
      completions: [...repairCompletions, ...unknownCompletions],
    },
  };
}

function buildFiles(outPath: string, outDir: string | null): ProcessRequiredFieldsReport['files'] {
  if (!outDir) {
    return {
      output_rows: path.resolve(outPath),
      report: null,
      evidence: null,
    };
  }
  const resolved = path.resolve(outDir);
  return {
    output_rows: path.resolve(outPath),
    report: path.join(resolved, 'outputs', 'process-required-fields-report.json'),
    evidence: path.join(resolved, 'outputs', 'process-required-fields-evidence.jsonl'),
  };
}

function requireOutputPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CliError('Missing required --out value.', {
      code: 'PROCESS_REQUIRED_FIELDS_OUT_REQUIRED',
      exitCode: 2,
    });
  }
  return trimmed;
}

export async function runProcessRequiredFieldsComplete(
  options: RunProcessRequiredFieldsCompleteOptions,
): Promise<ProcessRequiredFieldsReport> {
  const outPath = requireOutputPath(options.outPath);
  const outDir = options.outDir?.trim() ? options.outDir.trim() : null;
  const defaultUnit = normalizeUnit(options.defaultUnit);
  const rows = materializeDatasetRows(options.inputPath, options.rawInput);
  const flowRows = options.flowInputPath?.trim()
    ? materializeDatasetRows(options.flowInputPath, options.rawFlowInput)
    : [];
  const flowUnitById = buildFlowUnitIndex(flowRows, defaultUnit);
  const completed = rows.map((row) => completeProcessRow(row, { defaultUnit, flowUnitById }));
  const rowReports = completed.map((item) => item.report);
  const files = buildFiles(outPath, outDir);
  const blockers = rowReports.filter((row) => row.status === 'blocked');

  const report: ProcessRequiredFieldsReport = {
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    input_path: path.resolve(options.inputPath),
    out_path: path.resolve(outPath),
    out_dir: outDir ? path.resolve(outDir) : null,
    status: blockers.length > 0 ? 'completed_with_blockers' : 'completed',
    default_unit: defaultUnit,
    counts: {
      total: rowReports.length,
      processes: rowReports.filter((row) => row.type === 'process').length,
      completed: rowReports.filter((row) => row.status === 'completed').length,
      existing: rowReports.filter((row) => row.status === 'existing').length,
      blocked: blockers.length,
      skipped: rowReports.filter((row) => row.status === 'skipped').length,
    },
    files,
    rows: rowReports,
  };

  writeJsonLinesArtifact(
    files.output_rows,
    completed.map((item) => item.row),
  );
  if (files.report) {
    writeJsonArtifact(files.report, report);
  }
  if (files.evidence) {
    writeJsonLinesArtifact(
      files.evidence,
      rowReports.flatMap((row) =>
        row.completions.map((completion) => ({
          row_index: row.index,
          dataset_id: row.id,
          dataset_version: row.version,
          ...completion,
        })),
      ),
    );
  }

  return report;
}

export const __testInternals = {
  ANNUAL_SUPPLY_MISSING_DATA_SENTINEL_TEXT,
  ANNUAL_SUPPLY_ROOT_FIELD,
  isUnknownAnnualSupplyValue,
  annualSupplyTextParts,
  annualSupplyValueFromText,
  cloneRowWithPayload,
  collectProcessRequiredFieldIssues,
  completeProcessRow,
  ensureDataSources,
  fieldPathFromEvidenceEntry,
  findAnnualSupplyEvidenceValue,
  findAnnualSupplyEvidenceEntry,
  buildFlowUnitIndex,
  inferUnitFromReferenceExchange,
  inferSpecificUnitFromFlowPayload,
  issuePath,
  isAnnualSupplyEvidencePath,
  isValidComplianceDeclaration,
  isValidAnnualSupplyVolume,
  isValidReview,
  normalizeAnnualSupplyEvidenceValue,
  repairRequiredProcessStructures,
  requireOutputPath,
  selectReferenceExchange,
  textValue,
  valueAtPath,
};
