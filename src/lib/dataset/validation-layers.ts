import { sha256Json } from '../platform/canonical-json-hash.js';
import {
  isDuplicateLanguageIssue,
  normalizeIssuePath,
  type SafeParseIssue,
  type SchemaValidationOutcome,
} from '../validation/tidas-sdk-validation.js';

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
  const customCode = issue.params?.validationCode;
  return {
    path: normalizeIssuePath(path),
    message: issue.message ?? 'Validation failed',
    code:
      issue.code === 'custom' && typeof customCode === 'string'
        ? customCode
        : (issue.code ?? 'custom'),
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
    const code = issue.params?.validationCode ?? issue.code;
    if (
      isDuplicateLanguageIssue(issue) ||
      path.at(-1) === '@xml:lang' ||
      (typeof code === 'string' && code.startsWith('localized_text_'))
    ) {
      result.push(projected);
    }
    // SDK union branches report paths relative to the enclosing union issue.
    if (issue.errors) result.push(...sdkLanguageIssues(issue.errors.flat(), path));
  }
  return result;
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
} {
  const schemaIssues = outcome.issues.map((issue) => normalizedIssue(issue));
  const languageIssues = [
    ...new Map(
      sdkLanguageIssues(outcome.issues).map((issue) => [
        JSON.stringify([issue.path, issue.code, issue.message]),
        issue,
      ]),
    ).values(),
  ];
  return {
    payload_sha256: sha256Json(payload),
    validation_layers: {
      schema: layer(outcome.success, schemaIssues),
      authoring_evidence: layer(authoringIssues.length === 0, authoringIssues),
      content: layer(contentIssues.length === 0, contentIssues),
      multilingual: layer(languageIssues.length === 0, languageIssues),
    },
  };
}
