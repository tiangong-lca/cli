import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  __testInternals,
  runDatasetValidate,
  type RunDatasetValidateOptions,
} from '../src/lib/dataset-validate.js';
import {
  datasetIdentity,
  datasetRoot,
  detectDatasetKind,
  firstNonEmpty,
  materializeDatasetRows,
  readDatasetRowsInput,
  trimToken,
  unwrapDatasetPayload,
} from '../src/lib/dataset-local.js';

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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

const schemas = {
  flow: {
    safeParse: (value: unknown) => ({ success: !(value as { invalid?: boolean }).invalid }),
  },
  process: {
    safeParse: (value: unknown) => ({
      success: !(value as { invalid?: boolean }).invalid,
      error: { issues: [{ path: ['invalid'], message: 'marked invalid', code: 'custom' }] },
    }),
  },
  lifecyclemodel: {
    safeParse: (value: unknown) => ({ success: !(value as { invalid?: boolean }).invalid }),
  },
} satisfies RunDatasetValidateOptions['schemas'];

test('runDatasetValidate validates local rows and writes split artifacts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-validate-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'proc-ok',
      version: '01.01.000',
      json_ordered: validProcessPayload(),
    },
    {
      id: 'proc-bad',
      version: '01.01.000',
      json_ordered: validProcessPayload({ invalid: true }),
    },
    {
      id: 'flow-ok',
      version: '01.01.000',
      json_ordered: { flowDataSet: {} },
    },
  ]);

  try {
    const report = await runDatasetValidate({
      inputPath,
      outDir,
      type: 'auto',
      schemas,
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.deepEqual(report.counts, {
      total: 3,
      valid: 2,
      invalid: 1,
      by_type: {
        contact: 0,
        flow: 1,
        flowproperty: 0,
        process: 2,
        lifecyclemodel: 0,
        source: 0,
        unitgroup: 0,
      },
    });
    assert.equal(existsSync(report.files.report ?? ''), true);
    assert.deepEqual(readJson(report.files.report ?? ''), report);
    assert.equal(readJsonl(report.files.valid_rows ?? '').length, 2);
    assert.equal(readJsonl(report.files.invalid_rows ?? '').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetValidate supports mixed support rows with --type auto', async () => {
  const report = await runDatasetValidate({
    inputPath: 'memory',
    type: 'auto',
    rawInput: [
      {
        contactDataSet: {
          contactInformation: {
            dataSetInformation: { 'common:UUID': 'contact-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '00.00.001' },
          },
        },
      },
      {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: { 'common:UUID': 'source-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '00.00.001' },
          },
        },
      },
      {
        unitGroupDataSet: {
          unitGroupInformation: {
            dataSetInformation: { 'common:UUID': 'unitgroup-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '00.00.001' },
          },
        },
      },
      {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: { 'common:UUID': 'flowproperty-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '00.00.001' },
          },
        },
      },
    ],
    schemas: {
      contact: { safeParse: () => ({ success: true }) },
      source: { safeParse: () => ({ success: true }) },
      unitgroup: { safeParse: () => ({ success: true }) },
      flowproperty: { safeParse: () => ({ success: true }) },
    },
  });

  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.rows.map((row) => row.type),
    ['contact', 'source', 'unitgroup', 'flowproperty'],
  );
  assert.deepEqual(report.counts.by_type, {
    contact: 1,
    flow: 0,
    flowproperty: 1,
    process: 0,
    lifecyclemodel: 0,
    source: 1,
    unitgroup: 1,
  });
});

test('runDatasetValidate treats process placeholders as invalid authoring content', async () => {
  const report = await runDatasetValidate({
    inputPath: 'memory',
    type: 'process',
    rawInput: [
      {
        id: 'proc-placeholder',
        json_ordered: validProcessPayload({
          processDataSet: {
            modellingAndValidation: {
              dataSourcesTreatmentAndRepresentativeness: {
                annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
              },
              validation: {
                review: {
                  '@type': 'Not reviewed',
                },
                reviewDetails: {
                  '#text': 'Review summary pending confirmation.',
                  '@xml:lang': 'en',
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
      },
    ],
    schemas,
  });

  assert.equal(report.status, 'completed_with_failures');
  assert.equal(report.counts.invalid, 1);
  assert.deepEqual(report.rows[0]?.issues, [
    {
      path: 'processDataSet.modellingAndValidation.validation.reviewDetails.#text',
      message:
        'Process payload contains placeholder or pending-confirmation content that must be replaced before save or publish.',
      code: 'process_placeholder_content',
    },
  ]);
});

test('runDatasetValidate blocks import traces and source-gap sentinels for non-process rows', async () => {
  const report = await runDatasetValidate({
    inputPath: 'memory',
    type: 'flow',
    rawInput: [
      {
        id: 'flow-import-gap',
        json_ordered: {
          flowDataSet: {
            flowInformation: {
              dataSetInformation: {
                name: {
                  baseName: { '@xml:lang': 'en', '#text': 'carbon dioxide' },
                  treatmentStandardsRoutes: {
                    '@xml:lang': 'en',
                    '#text': 'Not declared in source package',
                  },
                },
                time: { 'common:referenceYear': 9999 },
                'common:other': {
                  'tidasimport:sourceTrace': {
                    '@marker': 'TIDAS_IMPORT_TRACE_V1',
                    payload: { sourceObject: '/Users/example/source.json' },
                  },
                },
              },
            },
          },
        },
      },
    ],
    schemas,
  });

  assert.equal(report.status, 'completed_with_failures');
  assert.deepEqual(
    report.rows[0]?.issues.map((issue) => issue.path),
    [
      'flowDataSet.flowInformation.dataSetInformation.name.treatmentStandardsRoutes.#text',
      'flowDataSet.flowInformation.dataSetInformation.time.common:referenceYear',
      'flowDataSet.flowInformation.dataSetInformation.common:other.tidasimport:sourceTrace.@marker',
      'flowDataSet.flowInformation.dataSetInformation.common:other.tidasimport:sourceTrace.payload.sourceObject',
    ],
  );
  assert.deepEqual(
    __testInternals.collectImportContentIssues({
      'common:referenceYear': '9999',
      clean: 'source text',
    }),
    [
      {
        path: 'common:referenceYear',
        message:
          'Dataset payload contains import placeholder, trace, local path, or sentinel content that must be repaired before import.',
        code: 'dataset_import_placeholder_content',
      },
    ],
  );
  assert.deepEqual(__testInternals.collectImportContentIssues('TIDAS_IMPORT_PLACEHOLDER:X'), [
    {
      path: '<root>',
      message:
        'Dataset payload contains import placeholder, trace, local path, or sentinel content that must be repaired before import.',
      code: 'dataset_import_placeholder_content',
    },
  ]);
});

test('dataset local helpers cover input parsing, wrappers, identities, and errors', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-local-'));
  const jsonPath = path.join(dir, 'rows.json');
  const jsonlPath = path.join(dir, 'rows.jsonl');
  const badJsonlPath = path.join(dir, 'bad.jsonl');
  const primitiveJsonlPath = path.join(dir, 'primitive.jsonl');
  writeFileSync(
    jsonPath,
    JSON.stringify({
      rows: [
        {
          jsonOrdered: {
            flowDataSet: {
              flowInformation: {
                dataSetInformation: { 'common:UUID': 'flow-from-payload' },
              },
              administrativeInformation: {
                publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
              },
            },
          },
        },
      ],
    }),
    'utf8',
  );
  writeJsonl(jsonlPath, [
    {
      process: {
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-from-wrapper' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.02.000' },
          },
        },
      },
    },
    {
      lifecyclemodel: {
        lifeCycleModelDataSet: {
          lifeCycleModelInformation: {
            dataSetInformation: { 'common:UUID': 'lm-from-wrapper' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.03.000' },
          },
        },
      },
    },
  ]);
  writeFileSync(badJsonlPath, '{bad-json}\n', 'utf8');
  writeFileSync(primitiveJsonlPath, '1\n', 'utf8');

  try {
    assert.equal(trimToken(123), null);
    assert.equal(trimToken(' value '), 'value');
    assert.equal(firstNonEmpty(null, ' ', 'winner'), 'winner');
    assert.equal(firstNonEmpty(null, undefined, ''), null);

    assert.equal(readDatasetRowsInput(jsonPath).length, 1);
    assert.equal(
      readDatasetRowsInput('memory', { rows: [{ payload: { processDataSet: {} } }] }).length,
      1,
    );
    assert.deepEqual(readDatasetRowsInput('memory', { id: 'single-row' }), [{ id: 'single-row' }]);
    assert.throws(() => readDatasetRowsInput('', []), /Missing required --input value/u);
    assert.throws(
      () => readDatasetRowsInput(path.join(dir, 'missing.jsonl')),
      /Input file not found/u,
    );
    assert.throws(() => readDatasetRowsInput(badJsonlPath), /invalid JSONL/u);
    assert.throws(() => readDatasetRowsInput(primitiveJsonlPath), /Expected JSON object rows/u);
    assert.throws(
      () => readDatasetRowsInput('memory', { rows: [1] }),
      /Expected JSON object rows/u,
    );

    const materialized = materializeDatasetRows(jsonlPath);
    const materializedFlow = materializeDatasetRows(jsonPath);
    assert.equal(materializedFlow[0]?.id, 'flow-from-payload');
    assert.equal(materializedFlow[0]?.version, '01.00.000');
    assert.equal(materialized[0]?.kind, 'process');
    assert.equal(materialized[0]?.id, 'proc-from-wrapper');
    assert.equal(materialized[1]?.kind, 'lifecyclemodel');
    assert.equal(materialized[1]?.version, '01.03.000');
    assert.equal(detectDatasetKind({ flow: {} }), 'flow');
    assert.equal(detectDatasetKind({ process: {} }), 'process');
    assert.equal(detectDatasetKind({ lifecyclemodel: {} }), 'lifecyclemodel');
    assert.equal(detectDatasetKind({ unknown: true }), null);
    assert.deepEqual(datasetIdentity({ id: 'row-id', version: 'row-version' }, {}, null), {
      id: 'row-id',
      version: 'row-version',
    });
    assert.deepEqual(datasetIdentity({}, { flowDataSet: {} }, 'flow'), {
      id: null,
      version: null,
    });
    assert.deepEqual(datasetRoot({ processDataSet: { id: 'wrapped-process' } }, 'process'), {
      id: 'wrapped-process',
    });
    assert.deepEqual(
      datasetRoot({ lifeCycleModelDataSet: { id: 'wrapped-model' } }, 'lifecyclemodel'),
      { id: 'wrapped-model' },
    );
    assert.deepEqual(datasetRoot({ id: 'unwrapped-flow' }, 'flow'), { id: 'unwrapped-flow' });
    assert.deepEqual(datasetRoot({ id: 'unwrapped-process' }, 'process'), {
      id: 'unwrapped-process',
    });
    assert.deepEqual(datasetRoot({ id: 'unwrapped-model' }, 'lifecyclemodel'), {
      id: 'unwrapped-model',
    });
    assert.deepEqual(unwrapDatasetPayload({ json: { flowDataSet: {} } }), { flowDataSet: {} });
    assert.deepEqual(unwrapDatasetPayload({ payload: { processDataSet: {} } }), {
      processDataSet: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetValidate covers aliases, unsupported rows, default schemas, and no-output mode', async () => {
  const noOutput = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ id: 'unknown-row' }],
    now: new Date('2026-05-05T00:00:00.000Z'),
  });
  assert.equal(noOutput.status, 'completed_with_failures');
  assert.deepEqual(noOutput.files, { report: null, valid_rows: null, invalid_rows: null });
  assert.equal(noOutput.rows[0]?.issues[0]?.code, 'dataset_type_unknown');

  const aliases = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ json_ordered: validProcessPayload() }],
    type: 'processes',
    schemas,
  });
  assert.equal(aliases.requested_type, 'process');
  assert.equal(aliases.rows[0]?.status, 'valid');

  const modelAlias = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ json_ordered: { lifeCycleModelDataSet: {} } }],
    type: 'models',
    schemas,
  });
  assert.equal(modelAlias.requested_type, 'lifecyclemodel');

  const defaultSchema = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ json_ordered: { flowDataSet: {} } }],
    type: 'flow',
  });
  assert.equal(defaultSchema.requested_type, 'flow');
  assert.equal(defaultSchema.rows[0]?.validator?.includes('FlowSchema'), true);

  const fallbackIssue = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ json_ordered: validProcessPayload({ invalid: true }) }],
    type: 'process',
    schemas: {
      process: {
        safeParse: () => ({ success: false, error: { issues: [{}] } }),
      },
    },
  });
  assert.deepEqual(fallbackIssue.rows[0]?.issues, [
    { path: '<root>', message: 'Validation failed', code: 'custom' },
  ]);

  const issueLessFailure = await runDatasetValidate({
    inputPath: 'memory',
    rawInput: [{ json_ordered: validProcessPayload({ invalid: true }) }],
    type: 'process',
    schemas: {
      process: {
        safeParse: () => ({ success: false }),
      },
    },
  });
  assert.equal(issueLessFailure.rows[0]?.issue_count, 0);

  await assert.rejects(
    () => runDatasetValidate({ inputPath: 'memory', rawInput: [], type: 'bad-type' }),
    /Expected --type/u,
  );

  const originalLifecyclemodelExport = __testInternals.SCHEMA_EXPORTS.lifecyclemodel;
  const originalProcessFactoryExport = __testInternals.ENTITY_FACTORY_EXPORTS.process;
  try {
    __testInternals.SCHEMA_EXPORTS.lifecyclemodel = 'MissingSchemaForTest' as never;
    assert.throws(
      () => __testInternals.schemaForKind('lifecyclemodel', undefined),
      /MissingSchemaForTest is unavailable/u,
    );
    __testInternals.ENTITY_FACTORY_EXPORTS.process = 'MissingFactoryForTest' as never;
    assert.equal(__testInternals.schemaForKind('process', undefined).createEntity, null);
  } finally {
    __testInternals.SCHEMA_EXPORTS.lifecyclemodel = originalLifecyclemodelExport;
    __testInternals.ENTITY_FACTORY_EXPORTS.process = originalProcessFactoryExport;
  }
});

test('runDatasetValidate uses deep SDK fallback for default schema failures', async () => {
  const originalSafeParse = tidasSdk.ProcessSchema.safeParse;
  try {
    tidasSdk.ProcessSchema.safeParse = (() => ({
      success: false,
      error: { issues: [{ path: ['fast'], message: 'fast issue', code: 'fast' }] },
    })) as unknown as typeof originalSafeParse;

    const report = await runDatasetValidate({
      inputPath: 'memory',
      rawInput: [{ json_ordered: validProcessPayload({ invalid: true }) }],
      type: 'process',
    });

    assert.equal(report.rows[0]?.status, 'invalid');
    assert.equal(__testInternals.schemaForKind('process', undefined).createEntity !== null, true);
    assert.equal((report.rows[0]?.issue_count ?? 0) > 0, true);
  } finally {
    tidasSdk.ProcessSchema.safeParse = originalSafeParse;
  }
});

test('runDatasetValidate preserves a non-flow Process accounting basis under the published SDK', async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/tidas-sdk/test-data/process-annual-volume.json', import.meta.url),
      'utf8',
    ),
  ) as {
    processDataSet: {
      processInformation: {
        quantitativeReference: {
          '@type': string;
          referenceToReferenceFlow?: string;
          functionalUnitOrOther?: { '@xml:lang': string; '#text': string }[];
        };
      };
      modellingAndValidation: { LCIMethodAndAllocation: { typeOfDataSet?: string } };
    };
  };
  const reference = fixture.processDataSet.processInformation.quantitativeReference;
  reference['@type'] = 'Other parameter';
  delete reference.referenceToReferenceFlow;
  reference.functionalUnitOrOther = [
    { '@xml:lang': 'en', '#text': '1 t unwashed raw coal' },
    { '@xml:lang': 'zh', '#text': '1 吨未洗选原煤' },
  ];
  delete fixture.processDataSet.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet;
  const unchanged = structuredClone(fixture);

  const accepted = await runDatasetValidate({
    inputPath: 'synthetic-non-flow-process',
    type: 'process',
    rawInput: fixture,
  });
  assert.equal(accepted.rows[0]?.status, 'valid');
  assert.deepEqual(accepted.rows[0]?.issues, []);
  assert.deepEqual(fixture, unchanged);
  assert.equal(reference.referenceToReferenceFlow, undefined);
  assert.equal(
    fixture.processDataSet.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet,
    undefined,
  );

  const missingBasis = structuredClone(fixture);
  delete missingBasis.processDataSet.processInformation.quantitativeReference.functionalUnitOrOther;
  const rejectedBasis = await runDatasetValidate({
    inputPath: 'synthetic-missing-basis',
    type: 'process',
    rawInput: missingBasis,
  });
  assert.equal(rejectedBasis.rows[0]?.status, 'invalid');
  assert.equal(
    rejectedBasis.rows[0]?.issues.some((issue) =>
      issue.path.endsWith('quantitativeReference.functionalUnitOrOther'),
    ),
    true,
  );

  const missingFlow = structuredClone(fixture);
  const flowReference = missingFlow.processDataSet.processInformation.quantitativeReference;
  flowReference['@type'] = 'Reference flow(s)';
  delete flowReference.functionalUnitOrOther;
  const rejectedFlow = await runDatasetValidate({
    inputPath: 'synthetic-missing-flow',
    type: 'process',
    rawInput: missingFlow,
  });
  assert.equal(rejectedFlow.rows[0]?.status, 'invalid');
  assert.equal(
    rejectedFlow.rows[0]?.issues.some((issue) =>
      issue.path.endsWith('quantitativeReference.referenceToReferenceFlow'),
    ),
    true,
  );
});
