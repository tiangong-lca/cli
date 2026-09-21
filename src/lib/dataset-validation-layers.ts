import { sha256Json } from './dataset-maintenance-contract.js';
import { datasetRoot, isRecord } from './dataset-local.js';
import { ANNUAL_SUPPLY_FIELD } from './process-required-fields.js';
import {
  normalizeIssuePath,
  type SafeParseIssue,
  type SchemaValidationOutcome,
} from './tidas-sdk-validation.js';

export type DatasetValidationIssue = { path: string; message: string; code: string };
export type DatasetValidationLayer = {
  status: 'passed' | 'failed';
  issue_count: number;
  issues: DatasetValidationIssue[];
};
export type DatasetValidationLayers = {
  schema: DatasetValidationLayer;
  authoring_evidence: DatasetValidationLayer;
  content: DatasetValidationLayer;
  multilingual: DatasetValidationLayer;
};

function layer(passed: boolean, issues: DatasetValidationIssue[]): DatasetValidationLayer {
  return { status: passed ? 'passed' : 'failed', issue_count: issues.length, issues };
}

function normalizedIssue(issue: SafeParseIssue, path = issue.path): DatasetValidationIssue {
  return {
    path: normalizeIssuePath(path),
    message: issue.message ?? 'Validation failed',
    code: issue.code ?? 'custom',
  };
}

function sdkLanguageIssues(
  issues: SafeParseIssue[],
  parent: Array<string | number> = [],
): DatasetValidationIssue[] {
  const result: DatasetValidationIssue[] = [];
  for (const issue of issues) {
    const path = [...parent, ...(issue.path ?? [])];
    const projected = normalizedIssue(issue, path);
    if (projected.path.includes('@xml:lang') || projected.message.includes('@xml:lang')) {
      result.push(projected);
    }
    // SDK union branches report paths relative to the enclosing union issue.
    if (issue.errors) result.push(...sdkLanguageIssues(issue.errors.flat(), path));
  }
  return result;
}

function duplicateAnnualVolumeLanguages(
  payload: Record<string, unknown>,
): DatasetValidationIssue[] {
  const root = datasetRoot(payload, 'process');
  const modelling = isRecord(root.modellingAndValidation) ? root.modellingAndValidation : {};
  const sources = isRecord(modelling.dataSourcesTreatmentAndRepresentativeness)
    ? modelling.dataSourcesTreatmentAndRepresentativeness
    : {};
  const value = sources.annualSupplyOrProductionVolume;
  const issues: DatasetValidationIssue[] = [];
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    value.forEach((entry: unknown, index) => {
      if (
        isRecord(entry) &&
        typeof entry['@xml:lang'] === 'string' &&
        typeof entry['#text'] === 'string'
      ) {
        const language = entry['@xml:lang'].trim().toLowerCase();
        if (seen.has(language)) {
          issues.push({
            path: `${ANNUAL_SUPPLY_FIELD}.${index}.@xml:lang`,
            code: 'duplicate_language_entry',
            message: 'A localized field must contain at most one value for each language.',
          });
        }
        seen.add(language);
      }
    });
  }
  return issues;
}

/** Preserve the SDK verdict; project its language diagnostics without redefining its schema. */
export function buildDatasetValidationLayers(
  payload: Record<string, unknown>,
  outcome: SchemaValidationOutcome,
  authoringIssues: DatasetValidationIssue[],
  contentIssues: DatasetValidationIssue[],
): {
  payload_sha256: string;
  validation_layers: DatasetValidationLayers;
  additional_multilingual_issues: DatasetValidationIssue[];
} {
  const schemaIssues = outcome.issues.map((issue) => normalizedIssue(issue));
  const duplicates = duplicateAnnualVolumeLanguages(payload);
  const languageIssues = [...sdkLanguageIssues(outcome.issues), ...duplicates];
  return {
    payload_sha256: sha256Json(payload),
    validation_layers: {
      schema: layer(outcome.success, schemaIssues),
      authoring_evidence: layer(authoringIssues.length === 0, authoringIssues),
      content: layer(contentIssues.length === 0, contentIssues),
      multilingual: layer(languageIssues.length === 0, languageIssues),
    },
    additional_multilingual_issues: duplicates,
  };
}
