import type { JsonObject } from './dataset-local.js';
import { datasetRoot, firstNonEmpty, isRecord } from './dataset-json.js';

export const ANNUAL_SUPPLY_FIELD =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume';
const DATA_SOURCES_TREATMENT_FIELD =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness';
const ANNUAL_SUPPLY_MISSING_DATA_SENTINEL_TEXT = '9999 missing-data-sentinel/year';
const NUMERIC_TEXT_WITH_SUFFIX_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([Ee][+-]?\d+)?\s+\S.*$/u;
const ANNUAL_PERIOD_PATTERN =
  /(?:\/\s*(?:year|yr|a)\b|\bper\s+(?:year|annum)\b|\/\s*年|每年|年度|年供应|年产)/iu;
const ANNUAL_UNAVAILABLE_PATTERN =
  /\b(?:source\s+)?(?:production\s+)?volume\s+(?:unavailable|unknown|not\s+available)\b/iu;
const REQUIRED_COMPLIANCE_FIELDS = [
  'common:approvalOfOverallCompliance',
  'common:nomenclatureCompliance',
  'common:methodologicalCompliance',
  'common:reviewCompliance',
  'common:documentationCompliance',
  'common:qualityCompliance',
] as const;

export type ProcessRequiredFieldIssue = { code: string; message: string; path: string };

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
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
  return pathSegments.map(String).join('.');
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

export const __testInternals = {
  annualSupplyItems,
  asList,
  collectPlaceholderIssuesFromValue,
  collectProcessPlaceholderIssues,
  collectProcessRequiredFieldIssues,
  isUnknownAnnualSupplyValue,
  isValidAnnualSupplyVolume,
  isValidComplianceDeclaration,
  isValidReview,
  issuePath,
};
