import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectProcessPlaceholderIssues,
  collectProcessRequiredFieldIssues,
} from '../src/lib/validation/process-required-fields.js';
test('process required field issue collector detects missing and invalid annual volumes', () => {
  const validRequiredStructures = {
    validation: {
      review: {
        '@type': 'Not reviewed',
      },
    },
    complianceDeclarations: {
      compliance: {
        'common:referenceToComplianceSystem': {
          '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
        },
        'common:approvalOfOverallCompliance': 'Not defined',
        'common:nomenclatureCompliance': 'Not defined',
        'common:methodologicalCompliance': 'Not defined',
        'common:reviewCompliance': 'Not defined',
        'common:documentationCompliance': 'Not defined',
        'common:qualityCompliance': 'Not defined',
      },
    },
  };
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: 'not-an-object',
      },
    }).map((issue) => issue.code),
    ['process_data_sources_treatment_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:other': {
              'tiangongfoundry:unresolvedTrace': [
                {
                  status: 'unresolved_deferred',
                  action_item_code: 'annual_supply_or_production_volume_invalid',
                  blocked_path:
                    'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
                  reason: 'No annualized source quantity is available.',
                  evidence: {
                    source: 'source_row',
                    quote_or_trace: 'annualSupplyOrProductionVolume.#text = Not specified',
                  },
                  next_action: 'Curate an annualized quantity from explicit source evidence.',
                },
              ],
            },
          },
        },
        modellingAndValidation: {
          ...validRequiredStructures,
        },
      },
    }).map((issue) => issue.code),
    ['process_data_sources_treatment_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {},
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:other': {
              'tiangongfoundry:unresolvedTrace': [
                {
                  status: 'unresolved_deferred',
                  action_item_code: 'annual_supply_or_production_volume_invalid',
                  blocked_path:
                    'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
                  reason: 'No annualized source quantity is available.',
                  evidence: {
                    source: 'source_row',
                    quote_or_trace: 'annualSupplyOrProductionVolume.#text = Not specified',
                  },
                  next_action: 'Curate an annualized quantity from explicit source evidence.',
                },
              ],
            },
          },
        },
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            dataCutOffAndCompletenessPrinciples: {
              '@xml:lang': 'en',
              '#text': 'Not specified',
            },
            referenceToDataSource: {
              '@type': 'source data set',
              '@refObjectId': 'source-1',
            },
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [
              {
                '@xml:lang': 'en',
                '#text': '0 kg/year; source production volume unavailable',
              },
            ],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': 'not quantified' }],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_invalid'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [
              { '@xml:lang': 'en', '#text': '3.6 MJ electricity mix' },
            ],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_not_annualized'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
          },
        },
      },
    }).map((issue) => issue.code),
    ['process_validation_review_missing', 'process_compliance_declaration_missing'],
  );
});

test('process placeholder issue collector blocks unfinished authoring placeholders', () => {
  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        modellingAndValidation: {
          validation: {
            'common:reviewDetails': {
              '#text': 'Review summary pending confirmation.',
              '@xml:lang': 'en',
            },
            'common:referenceToCompleteReviewReport': {
              '@uri': 'https://placeholder.example/review-report',
              '@refObjectId': '00000000-0000-0000-0000-000000000003',
            },
          },
        },
      },
    }).map((issue) => issue.path),
    [
      'processDataSet.modellingAndValidation.validation.common:reviewDetails.#text',
      'processDataSet.modellingAndValidation.validation.common:referenceToCompleteReviewReport.@uri',
      'processDataSet.modellingAndValidation.validation.common:referenceToCompleteReviewReport.@refObjectId',
    ],
  );

  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        modellingAndValidation: {
          validation: {
            review: {
              '@type': 'Not reviewed',
            },
          },
        },
      },
    }),
    [],
  );

  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        processInformation: {
          time: { 'common:referenceYear': 9999 },
          importedTime: { 'common:referenceYear': '9999' },
          dataSetInformation: {
            name: {
              treatmentStandardsRoutes: {
                '@xml:lang': 'en',
                '#text': 'Not declared in source package',
              },
            },
            'common:other': {
              'tidasimport:sourceTrace': {
                '@marker': 'TIDAS_IMPORT_TRACE_V1',
                payload: { sourceObject: '/Users/example/source.spold' },
              },
            },
          },
        },
      },
    }).map((issue) => issue.path),
    [
      'processDataSet.processInformation.time.common:referenceYear',
      'processDataSet.processInformation.importedTime.common:referenceYear',
      'processDataSet.processInformation.dataSetInformation.name.treatmentStandardsRoutes.#text',
      'processDataSet.processInformation.dataSetInformation.common:other.tidasimport:sourceTrace.@marker',
      'processDataSet.processInformation.dataSetInformation.common:other.tidasimport:sourceTrace.payload.sourceObject',
    ],
  );
});

test('malformed annual evidence and compliance never become invented valid values', () => {
  const annual = { '@xml:lang': 'en', '#text': '1 kg/year' };
  const other = [
    42,
    'not specified',
    null,
    {},
    { '#text': 42 },
    [null],
    [{ '@xml:lang': '', '#text': 'unknown' }],
    [{ '@xml:lang': 'en' }],
    [{ '@xml:lang': 'en', '#text': 0 }],
    [{ '@xml:lang': 'en', '#text': '' }],
  ];
  for (const value of other) {
    const payload = {
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [annual, value],
          },
          validation: { review: { '@type': 'Not reviewed' } },
          complianceDeclarations: {
            compliance: [false, { 'common:referenceToComplianceSystem': 42 }],
          },
        },
      },
    };
    const before = structuredClone(payload);
    const issues = collectProcessRequiredFieldIssues(payload);
    assert.ok(issues.some((issue) => issue.code.startsWith('annual_supply')));
    assert.ok(issues.some((issue) => issue.code === 'process_compliance_declaration_missing'));
    assert.deepEqual(payload, before);
  }
});
