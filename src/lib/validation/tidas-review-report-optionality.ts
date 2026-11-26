import type { SafeParseIssue, SafeParseResult, SafeParseSchema } from './tidas-sdk-validation.js';

type JsonObject = Record<string, unknown>;

export type ReviewReportOptionalityKind = 'processes' | 'lciamethods';

const REVIEW_REPORT_KEY = 'common:referenceToCompleteReviewReport';
const OPTIONAL_REVIEW_REPORT_REFERENCE: JsonObject = {
  '@type': 'source data set',
  '@refObjectId': '00000000-0000-0000-0000-000000000001',
  '@version': '00.00.001',
  '@uri': 'urn:tidas:cli:optional-review-report-compatibility',
  'common:shortDescription': {
    '@xml:lang': 'en',
    '#text': 'Optional review report compatibility validation',
  },
};

const ROOT_KEYS: Record<ReviewReportOptionalityKind, string> = {
  processes: 'processDataSet',
  lciamethods: 'LCIAMethodDataSet',
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationFor(value: unknown, kind: ReviewReportOptionalityKind): JsonObject | null {
  if (!isRecord(value)) return null;
  const dataset = value[ROOT_KEYS[kind]];
  if (!isRecord(dataset)) return null;
  const modelling = dataset.modellingAndValidation;
  if (!isRecord(modelling)) return null;
  const validation = modelling.validation;
  return isRecord(validation) ? validation : null;
}

function reviewFor(value: unknown, kind: ReviewReportOptionalityKind): JsonObject | null {
  const review = validationFor(value, kind)?.review;
  return isRecord(review) ? review : null;
}

function reviewValueFor(value: unknown, kind: ReviewReportOptionalityKind): unknown {
  return validationFor(value, kind)?.review;
}

function withReviewValue(
  value: unknown,
  kind: ReviewReportOptionalityKind,
  review: JsonObject,
): unknown {
  const copy = structuredClone(value);
  const validation = validationFor(copy, kind);
  if (!validation) return value;
  validation.review = review;
  return copy;
}

function needsOptionalReviewReportRetry(
  value: unknown,
  kind: ReviewReportOptionalityKind,
): boolean {
  const review = reviewFor(value, kind);
  if (!review || Object.prototype.hasOwnProperty.call(review, REVIEW_REPORT_KEY)) {
    return false;
  }
  return review['@type'] !== 'Not reviewed';
}

function withCompatibilityReference(value: unknown, kind: ReviewReportOptionalityKind): unknown {
  if (!needsOptionalReviewReportRetry(value, kind)) return value;
  const copy = structuredClone(value);
  const review = reviewFor(copy, kind);
  if (!review) return value;
  review[REVIEW_REPORT_KEY] = structuredClone(OPTIONAL_REVIEW_REPORT_REFERENCE);
  return copy;
}

function safeParseSingletonReview(
  schema: SafeParseSchema,
  value: unknown,
  kind: ReviewReportOptionalityKind,
): SafeParseResult {
  const initial = schema.safeParse(value);
  if (initial.success || !needsOptionalReviewReportRetry(value, kind)) {
    return initial;
  }
  const retry = schema.safeParse(withCompatibilityReference(value, kind));
  return retry.success ? retry : initial;
}

function indexedReviewIssues(
  result: Extract<SafeParseResult, { success: false }>,
  index: number,
): SafeParseIssue[] | null {
  const issues = result.error?.issues;
  if (!issues || issues.length === 0) return null;

  return issues.map((issue) => {
    const path = issue.path;
    const reviewIndex = path?.findIndex((part) => part === 'review') ?? -1;
    if (!path || reviewIndex < 0) {
      return issue;
    }
    const indexedPath = path.toSpliced(reviewIndex + 1, 0, index);
    return { ...issue, path: indexedPath };
  });
}

/**
 * Bridges the short candidate window before the published SDK carries the
 * same optional review-report condition and Process review cardinality. Only
 * an omitted report reference is retried. Process arrays are validated one
 * member at a time and returned unchanged; supplied references, malformed
 * references, and every other schema rule remain owned by the SDK schema.
 */
export function withOptionalReviewReportReference(
  schema: SafeParseSchema,
  kind: ReviewReportOptionalityKind,
): SafeParseSchema {
  return {
    safeParse(value: unknown) {
      const initial = safeParseSingletonReview(schema, value, kind);
      if (initial.success || kind !== 'processes') {
        return initial;
      }

      const reviews = reviewValueFor(value, kind);
      if (!Array.isArray(reviews)) {
        return initial;
      }

      const reviewPath = [ROOT_KEYS[kind], 'modellingAndValidation', 'validation', 'review'];
      if (reviews.length === 0) {
        return {
          success: false,
          error: {
            issues: [
              {
                code: 'too_small',
                path: reviewPath,
                message: 'Process validation.review array must contain at least one review.',
              },
            ],
          },
        };
      }

      const issues = new Map<string, SafeParseIssue>();
      for (const [index, review] of reviews.entries()) {
        if (!isRecord(review)) {
          const issue = {
            code: 'invalid_type',
            path: [...reviewPath, index],
            message: 'Process validation.review array members must be review objects.',
          };
          issues.set(JSON.stringify(issue), issue);
          continue;
        }
        const singleton = withReviewValue(value, kind, review);
        const result = safeParseSingletonReview(schema, singleton, kind);
        if (result.success) continue;
        const indexed = indexedReviewIssues(result, index);
        if (!indexed) {
          return initial;
        }
        for (const issue of indexed) {
          issues.set(JSON.stringify(issue), issue);
        }
      }

      return issues.size === 0
        ? { success: true, data: value }
        : { success: false, error: { issues: [...issues.values()] } };
    },
  };
}

export const __testInternals = {
  REVIEW_REPORT_KEY,
  OPTIONAL_REVIEW_REPORT_REFERENCE,
  validationFor,
  reviewFor,
  reviewValueFor,
  needsOptionalReviewReportRetry,
  withCompatibilityReference,
  withReviewValue,
  indexedReviewIssues,
};
