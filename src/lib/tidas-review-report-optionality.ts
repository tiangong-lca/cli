import type { SafeParseSchema } from './tidas-sdk-validation.js';

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

function reviewFor(value: unknown, kind: ReviewReportOptionalityKind): JsonObject | null {
  if (!isRecord(value)) return null;
  const dataset = value[ROOT_KEYS[kind]];
  if (!isRecord(dataset)) return null;
  const modelling = dataset.modellingAndValidation;
  if (!isRecord(modelling)) return null;
  const validation = modelling.validation;
  if (!isRecord(validation)) return null;
  const review = validation.review;
  return isRecord(review) ? review : null;
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

/**
 * Bridges the short candidate window before the published SDK carries the
 * same optional review-report condition. Only an omitted report reference is
 * retried; supplied references, malformed references, and every other schema
 * rule remain owned by the SDK schema.
 */
export function withOptionalReviewReportReference(
  schema: SafeParseSchema,
  kind: ReviewReportOptionalityKind,
): SafeParseSchema {
  return {
    safeParse(value: unknown) {
      const initial = schema.safeParse(value);
      if (initial.success || !needsOptionalReviewReportRetry(value, kind)) {
        return initial;
      }
      const retry = schema.safeParse(withCompatibilityReference(value, kind));
      return retry.success ? retry : initial;
    },
  };
}

export const __testInternals = {
  REVIEW_REPORT_KEY,
  OPTIONAL_REVIEW_REPORT_REFERENCE,
  reviewFor,
  needsOptionalReviewReportRetry,
  withCompatibilityReference,
};
