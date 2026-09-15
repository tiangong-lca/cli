import assert from 'node:assert/strict';
import test from 'node:test';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  __testInternals,
  summarizeProcessPayloadValidation,
  validateProcessPayload,
} from '../src/lib/process-payload-validation.js';

function validProcessPayload(overrides: Record<string, unknown> = {}) {
  return {
    processDataSet: {
      modellingAndValidation: {
        dataSourcesTreatmentAndRepresentativeness: {
          annualSupplyOrProductionVolume: [
            { '@xml:lang': 'en', '#text': '3.6 MJ/year' },
            { '@xml:lang': 'zh', '#text': '3.6 MJ/年' },
          ],
        },
        validation: {
          review: {
            '@type': 'Not reviewed',
          },
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': {
              '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
              '@type': 'source data set',
              '@version': '00.00.001',
            },
            'common:approvalOfOverallCompliance': 'Not defined',
            'common:nomenclatureCompliance': 'Not defined',
            'common:methodologicalCompliance': 'Not defined',
            'common:reviewCompliance': 'Not defined',
            'common:documentationCompliance': 'Not defined',
            'common:qualityCompliance': 'Not defined',
          },
        },
      },
    },
    ...overrides,
  };
}

test('process payload validation summarizes ok and failure results with normalized issue paths', () => {
  const originalSafeParse = tidasSdk.ProcessSchema.safeParse;

  try {
    tidasSdk.ProcessSchema.safeParse = (() =>
      ({
        success: true,
        data: {},
      }) as unknown as ReturnType<typeof originalSafeParse>) as typeof originalSafeParse;

    const okResult = validateProcessPayload(validProcessPayload());
    assert.deepEqual(okResult, {
      ok: true,
      validator: '@tiangong-lca/tidas-sdk/ProcessSchema+tiangong/process-authoring-required-fields',
      issue_count: 0,
      issues: [],
      validation_layers: {
        payload_sha256: '69255fd3bf887e22a1622189a7a5ff92633b2dc7cd6121dd78ba6825f2bf3163',
        schema: { ok: true, issues: [] },
        authoring: { ok: true, issues: [] },
        content: { ok: true, issues: [] },
      },
    });
    assert.equal(summarizeProcessPayloadValidation(okResult), 'local process validation passed');

    tidasSdk.ProcessSchema.safeParse = (() =>
      ({
        success: false,
        error: {
          issues: [
            {
              path: [],
              message: 'Top-level failure',
              code: 'custom',
            },
            {
              path: ['processDataSet', 'exchanges', 0],
            },
          ],
        },
      }) as unknown as ReturnType<typeof originalSafeParse>) as typeof originalSafeParse;

    const invalidResult = validateProcessPayload(validProcessPayload(), undefined, null);
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.issue_count, 2);
    assert.deepEqual(invalidResult.issues, [
      {
        path: '<root>',
        message: 'Top-level failure',
        code: 'custom',
      },
      {
        path: 'processDataSet.exchanges.0',
        message: 'Validation failed',
        code: 'custom',
      },
    ]);
    assert.match(
      summarizeProcessPayloadValidation(invalidResult),
      /local process validation failed with 2 issue\(s\) \(<root>: Top-level failure; processDataSet\.exchanges\.0: Validation failed\)/u,
    );

    tidasSdk.ProcessSchema.safeParse = (() =>
      ({
        success: false,
        error: undefined,
      }) as unknown as ReturnType<typeof originalSafeParse>) as typeof originalSafeParse;
    const emptyIssueResult = validateProcessPayload(validProcessPayload(), undefined, null);
    assert.equal(emptyIssueResult.ok, false);
    assert.equal(emptyIssueResult.issue_count, 0);
    assert.equal(
      summarizeProcessPayloadValidation(emptyIssueResult),
      'local process validation failed with 0 issue(s)',
    );

    tidasSdk.ProcessSchema.safeParse = undefined as unknown as typeof originalSafeParse;
    assert.throws(
      () => validateProcessPayload(validProcessPayload()),
      /@tiangong-lca\/tidas-sdk\/ProcessSchema\+tiangong\/process-authoring-required-fields is unavailable/u,
    );
  } finally {
    tidasSdk.ProcessSchema.safeParse = originalSafeParse;
  }
});

test('process payload validation falls back to deep SDK validation only after fast failure', () => {
  const calls: boolean[] = [];
  const schema = {
    safeParse: () => ({
      success: false as const,
      error: {
        issues: [{ path: ['fast'], message: 'fast issue', code: 'fast' }],
      },
    }),
  };

  const result = validateProcessPayload(validProcessPayload(), schema, (_, config) => {
    calls.push(config?.deepValidation ?? false);
    return {
      validateEnhanced: () =>
        config?.deepValidation
          ? {
              success: false,
              error: {
                issues: [{ path: ['deep'], message: 'deep issue', code: 'deep' }],
              },
            }
          : {
              success: false,
              error: {
                issues: [{ path: ['shallow'], message: 'shallow issue', code: 'shallow' }],
              },
            },
    };
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(result.issues, [
    {
      path: 'deep',
      message: 'deep issue',
      code: 'deep',
    },
  ]);
  assert.equal(__testInternals.getProcessFactory({}), null);
  assert.equal(typeof __testInternals.getProcessFactory({ createProcess: () => ({}) }), 'function');
});

test('process payload validation enforces annual supply authoring fields beyond the packaged SDK schema', () => {
  const result = validateProcessPayload(
    {
      processDataSet: {
        modellingAndValidation: {
          validation: {
            review: {
              '@type': 'Not reviewed',
            },
          },
          complianceDeclarations: {
            compliance: {
              'common:referenceToComplianceSystem': {
                '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
                '@type': 'source data set',
                '@version': '00.00.001',
              },
              'common:approvalOfOverallCompliance': 'Not defined',
              'common:nomenclatureCompliance': 'Not defined',
              'common:methodologicalCompliance': 'Not defined',
              'common:reviewCompliance': 'Not defined',
              'common:documentationCompliance': 'Not defined',
              'common:qualityCompliance': 'Not defined',
            },
          },
          dataSourcesTreatmentAndRepresentativeness: {},
        },
      },
    },
    {
      safeParse: () => ({
        success: true as const,
        data: {},
      }),
    },
    null,
  );

  assert.equal(result.ok, false);
  assert.equal(result.issue_count, 1);
  assert.deepEqual(result.issues, [
    {
      path: 'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      message:
        'Process payload must include annualSupplyOrProductionVolume as numeric text with a unit or context suffix.',
      code: 'annual_supply_or_production_volume_missing',
    },
  ]);
});

test('process payload validation rejects placeholder authoring content', () => {
  const result = validateProcessPayload(
    validProcessPayload({
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
          },
          validation: {
            review: {
              '@type': 'Not reviewed',
            },
            'common:referenceToCompleteReviewReport': {
              '@uri': 'https://placeholder.example/review-report',
            },
          },
          complianceDeclarations: {
            compliance: {
              'common:referenceToComplianceSystem': {
                '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
                '@type': 'source data set',
                '@version': '00.00.001',
              },
              'common:approvalOfOverallCompliance': 'Not defined',
              'common:nomenclatureCompliance': 'Not defined',
              'common:methodologicalCompliance': 'Not defined',
              'common:reviewCompliance': 'Not defined',
              'common:documentationCompliance': 'Not defined',
              'common:qualityCompliance': 'Not defined',
            },
          },
        },
      },
    }),
    {
      safeParse: () => ({
        success: true as const,
        data: {},
      }),
    },
    null,
  );

  assert.equal(result.ok, false);
  assert.equal(result.issue_count, 1);
  assert.deepEqual(result.issues, [
    {
      path: 'processDataSet.modellingAndValidation.validation.common:referenceToCompleteReviewReport.@uri',
      message:
        'Process payload contains placeholder or pending-confirmation content that must be replaced before save or publish.',
      code: 'process_placeholder_content',
    },
  ]);
});
