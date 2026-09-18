import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testInternals,
  withOptionalReviewReportReference,
  type ReviewReportOptionalityKind,
} from '../src/lib/tidas-review-report-optionality.js';
import type { SafeParseSchema } from '../src/lib/tidas-sdk-validation.js';

const REPORT_KEY = 'common:referenceToCompleteReviewReport';

function reviewAt(value: unknown, kind: ReviewReportOptionalityKind): Record<string, unknown> {
  const root = kind === 'processes' ? 'processDataSet' : 'LCIAMethodDataSet';
  return ((value as Record<string, any>)[root].modellingAndValidation.validation.review ??
    {}) as Record<string, unknown>;
}

function reviewSchema(kind: ReviewReportOptionalityKind): SafeParseSchema {
  let calls = 0;
  return {
    safeParse(value: unknown) {
      calls += 1;
      const review = reviewAt(value, kind);
      if (review['@type'] === 'Not reviewed' || review[REPORT_KEY]) {
        const reference = review[REPORT_KEY] as Record<string, unknown> | undefined;
        if (
          review['@type'] === 'Not reviewed' ||
          (reference?.['@type'] === 'source data set' &&
            reference?.['@refObjectId'] === '00000000-0000-0000-0000-000000000001' &&
            reference?.['@version'] === '00.00.001' &&
            reference?.['@uri'] === 'urn:tidas:cli:optional-review-report-compatibility')
        ) {
          return { success: true as const, data: value };
        }
      }
      return {
        success: false as const,
        error: { issues: [{ path: ['review', REPORT_KEY], message: 'report is required' }] },
      };
    },
    get calls() {
      return calls;
    },
  } as SafeParseSchema & { readonly calls: number };
}

function payload(kind: ReviewReportOptionalityKind, review: Record<string, unknown>) {
  return {
    [kind === 'processes' ? 'processDataSet' : 'LCIAMethodDataSet']: {
      modellingAndValidation: { validation: { review } },
    },
  };
}

for (const kind of ['processes', 'lciamethods'] as const) {
  test(`${kind} accepts an omitted report reference through the SDK compatibility surface`, () => {
    const base = reviewSchema(kind);
    const schema = withOptionalReviewReportReference(base, kind);
    const input = payload(kind, {
      '@type': 'Independent external review',
    });

    const result = schema.safeParse(input);

    assert.equal(result.success, true);
    assert.equal((base as SafeParseSchema & { calls: number }).calls, 2);
    assert.deepEqual(reviewAt(input, kind), { '@type': 'Independent external review' });
  });

  test(`${kind} keeps supplied reference validation strict`, () => {
    const schema = withOptionalReviewReportReference(reviewSchema(kind), kind);
    const valid = payload(kind, {
      '@type': 'Independent external review',
      [REPORT_KEY]: structuredClone(__testInternals.OPTIONAL_REVIEW_REPORT_REFERENCE),
    });
    const malformed = payload(kind, {
      '@type': 'Independent external review',
      [REPORT_KEY]: { '@uri': 'https://example.invalid/report' },
    });

    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse(malformed).success, false);
  });
}

test('Not reviewed remains unchanged and does not invoke the compatibility retry', () => {
  const base = reviewSchema('processes');
  const schema = withOptionalReviewReportReference(base, 'processes');
  const result = schema.safeParse(payload('processes', { '@type': 'Not reviewed' }));

  assert.equal(result.success, true);
  assert.equal((base as SafeParseSchema & { calls: number }).calls, 1);
  assert.equal(
    __testInternals.needsOptionalReviewReportRetry(payload('processes', {}), 'processes'),
    true,
  );
});

test('compatibility helpers fail closed for incomplete review paths and retry failures', () => {
  assert.equal(__testInternals.reviewFor(null, 'processes'), null);
  assert.equal(__testInternals.reviewFor([], 'processes'), null);
  assert.equal(__testInternals.reviewFor({}, 'processes'), null);
  assert.equal(__testInternals.reviewFor({ processDataSet: {} }, 'processes'), null);
  assert.equal(
    __testInternals.reviewFor({ processDataSet: { modellingAndValidation: {} } }, 'processes'),
    null,
  );
  assert.equal(
    __testInternals.reviewFor(
      { processDataSet: { modellingAndValidation: { validation: null } } },
      'processes',
    ),
    null,
  );
  assert.equal(
    __testInternals.reviewFor(
      { processDataSet: { modellingAndValidation: { validation: { review: [] } } } },
      'processes',
    ),
    null,
  );

  const noReview = payload('processes', {});
  assert.equal(__testInternals.needsOptionalReviewReportRetry(noReview, 'processes'), true);
  const supplied = payload('processes', {
    '@type': 'Independent external review',
    [REPORT_KEY]: structuredClone(__testInternals.OPTIONAL_REVIEW_REPORT_REFERENCE),
  });
  assert.equal(__testInternals.needsOptionalReviewReportRetry(supplied, 'processes'), false);
  assert.equal(__testInternals.withCompatibilityReference(supplied, 'processes'), supplied);

  const nonEnumerableReview = {
    processDataSet: { modellingAndValidation: { validation: {} as Record<string, unknown> } },
  };
  const hiddenReview = { '@type': 'Independent external review' };
  Object.defineProperty(
    nonEnumerableReview.processDataSet.modellingAndValidation.validation,
    'review',
    {
      value: hiddenReview,
      enumerable: false,
    },
  );
  assert.equal(
    __testInternals.withCompatibilityReference(nonEnumerableReview, 'processes'),
    nonEnumerableReview,
  );

  const alwaysFailing: SafeParseSchema = {
    safeParse: () => ({
      success: false as const,
      error: { issues: [{ path: [], message: 'still invalid' }] },
    }),
  };
  const original = payload('processes', { '@type': 'Independent external review' });
  const result = withOptionalReviewReportReference(alwaysFailing, 'processes').safeParse(original);
  assert.equal(result.success, false);
  assert.deepEqual(reviewAt(original, 'processes'), { '@type': 'Independent external review' });
});
