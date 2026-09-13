import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/lib/errors.js';
import { __testInternals, runFlowRemediate } from '../src/lib/flow-remediate.js';

type JsonRecord = Record<string, unknown>;

function writeJsonl(filePath: string, rows: unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`,
    'utf8',
  );
}

function makeFlowEnvelope(options: {
  id: string;
  stateCode?: number;
  version?: string;
  baseName?: unknown;
  flowPropertyRef?: unknown;
  propertyInternalId?: string;
  meanValue?: string;
  permanentUri?: string;
  precedingRef?: unknown;
  technicalSpecification?: unknown;
}): JsonRecord {
  const flowProperty =
    options.flowPropertyRef === null
      ? undefined
      : {
          '@dataSetInternalID': options.propertyInternalId ?? '7',
          meanValue: options.meanValue ?? '1',
          referenceToFlowPropertyDataSet: options.flowPropertyRef ?? {
            '@refObjectId': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '@uri': '../flowproperties/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa_01.00.000.xml',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
          },
        };

  return {
    id: options.id,
    user_id: 'user-1',
    state_code: options.stateCode ?? 0,
    version: options.version ?? '01.01.000',
    reason: [{ code: 'original_issue' }],
    json_ordered: {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': options.id,
            name: {
              baseName: options.baseName ?? [
                { '@xml:lang': 'en', '#text': 'Flow name' },
                { '@xml:lang': 'zh', '#text': '流名称' },
              ],
              flowProperties: '',
            },
            'common:generalComment': '',
            'common:shortDescription': 'Short description',
            'common:other': {},
            CASNumber: '',
          },
          quantitativeReference: {
            referenceToReferenceFlowProperty:
              options.flowPropertyRef === null ? '0' : (options.propertyInternalId ?? '7'),
          },
          technology: {
            technologicalApplicability: 'general',
            referenceToTechnicalSpecification: options.technicalSpecification ?? {
              '@refObjectId': COMPLIANCE_UUID,
            },
          },
        },
        flowProperties: flowProperty ? { flowProperty } : {},
        modellingAndValidation: {
          complianceDeclarations: {},
        },
        administrativeInformation: {
          dataEntryBy: {},
          publicationAndOwnership: {
            'common:dataSetVersion': options.version ?? '01.01.000',
            'common:permanentDataSetURI':
              options.permanentUri ??
              `https://example.com/showFlow.xhtml?uuid=${options.id}&version=${options.version ?? '01.01.000'}`,
            'common:referenceToPrecedingDataSetVersion': options.precedingRef,
          },
        },
      },
    },
  };
}

const COMPLIANCE_UUID = 'd92a1a12-2545-49e2-a585-55c259997756';
const ILCD_FORMAT_UUID = 'a97a0155-0234-4b87-b4ce-a45da52f2a40';
const DEFAULT_MASS_FLOW_PROPERTY_UUID = '93a60a56-a3c8-11da-a746-0800200b9a66';

function makeSdkLoader(validationFailures: Record<string, unknown> = {}) {
  return () => ({
    location: 'mock-sdk',
    createFlow: (data?: unknown) => ({
      validate: () => {
        const flowDataSet = ((data as JsonRecord)?.flowDataSet ?? {}) as JsonRecord;
        const flowInformation = (flowDataSet.flowInformation ?? {}) as JsonRecord;
        const dataSetInformation = (flowInformation.dataSetInformation ?? {}) as JsonRecord;
        const uuid = String(dataSetInformation['common:UUID'] ?? '');
        const failure = validationFailures[uuid];
        return failure ? { success: false, error: failure } : { success: true };
      },
    }),
  });
}

test('runFlowRemediate writes legacy round1 artifacts and splits valid versus manual rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-remediate-'));
  const inputFile = path.join(dir, 'invalid-flows.jsonl');
  const outDir = path.join(dir, 'remediation');

  writeJsonl(inputFile, [
    makeFlowEnvelope({
      id: '11111111-1111-1111-1111-111111111111',
      stateCode: 100,
      version: '01.01.000',
      flowPropertyRef: null,
      precedingRef: {},
    }),
    makeFlowEnvelope({
      id: '22222222-2222-2222-2222-222222222222',
      flowPropertyRef: {
        'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'volume basis' }],
      },
    }),
    makeFlowEnvelope({
      id: '33333333-3333-3333-3333-333333333333',
      flowPropertyRef: {
        '@refObjectId': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        '@uri': '../flowproperties/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb_01.01.000.xml',
        'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
      },
    }),
    {
      id: '44444444-4444-4444-4444-444444444444',
      state_code: 0,
      json_ordered: {},
    },
  ]);

  try {
    const report = await runFlowRemediate(
      {
        inputFile,
        outDir,
      },
      {
        loadSdkModule: makeSdkLoader({
          '33333333-3333-3333-3333-333333333333': {
            issues: [
              {
                path: ['flowDataSet', 'flowProperties'],
                message: 'Mock validation failure',
                code: 'custom',
              },
            ],
          },
        }),
        now: () => new Date('2026-03-30T08:00:00.000Z'),
      },
    );

    assert.equal(report.status, 'completed_local_flow_remediation');
    assert.equal(report.generated_at_utc, '2026-03-30T08:00:00.000Z');
    assert.equal(report.counts.input_rows, 4);
    assert.equal(report.counts.state_code_100_rows, 1);
    assert.equal(report.counts.ready_for_mcp_rows, 1);
    assert.equal(report.counts.residual_manual_rows, 3);
    assert.equal(report.validation_backend, 'tidas_sdk');
    assert.ok(existsSync(report.files.all_remediated));
    assert.ok(existsSync(report.files.ready_for_mcp));
    assert.ok(existsSync(report.files.residual_manual_queue));
    assert.ok(existsSync(report.files.audit));
    assert.ok(existsSync(report.files.prompt));
    assert.ok(existsSync(report.files.report));

    const readyRows = readFileSync(report.files.ready_for_mcp, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(readyRows.length, 1);
    const readyPayload = (
      ((readyRows[0].json_ordered as JsonRecord).flowDataSet as JsonRecord)
        .administrativeInformation as JsonRecord
    ).publicationAndOwnership as JsonRecord;
    assert.equal(readyPayload['common:dataSetVersion'], '01.01.001');
    assert.equal((readyRows[0] as JsonRecord).version, '01.01.001');
    assert.equal(typeof readyPayload['common:referenceToPrecedingDataSetVersion'], 'object');
    assert.notEqual(readyPayload['common:referenceToPrecedingDataSetVersion'], null);
    assert.match(String(readyPayload['common:permanentDataSetURI']), /version=01\.01\.001/u);

    const readyFlowProperty = deepFlowProperty(readyRows[0]);
    assert.equal(readyFlowProperty['@refObjectId'], '93a60a56-a3c8-11da-a746-0800200b9a66');

    const manualRows = readFileSync(report.files.residual_manual_queue, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(manualRows.length, 3);
    assert.deepEqual(report.residual_manual_ids, [
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);

    const prompt = readFileSync(report.files.prompt, 'utf8');
    assert.match(prompt, /residual manual queue/u);
    assert.match(prompt, /22222222-2222-2222-2222-222222222222/u);
    assert.match(prompt, /33333333-3333-3333-3333-333333333333/u);

    const auditRows = readFileSync(report.files.audit, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(auditRows.length, 4);
    assert.equal(auditRows[0].valid_after_remediation as boolean, true);
    assert.equal(auditRows[2].valid_after_remediation as boolean, false);
    assert.ok(Array.isArray(auditRows[2].final_reason));

    const reportFilePayload = JSON.parse(readFileSync(report.files.report, 'utf8')) as JsonRecord;
    assert.equal(reportFilePayload.status, 'completed_local_flow_remediation');
    assert.equal((reportFilePayload.counts as JsonRecord).ready_for_mcp_rows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deepFlowProperty(row: JsonRecord): JsonRecord {
  const flowDataSet = ((row.json_ordered as JsonRecord).flowDataSet ?? {}) as JsonRecord;
  const flowProperties = (flowDataSet.flowProperties ?? {}) as JsonRecord;
  return (((flowProperties.flowProperty as JsonRecord) ?? {}).referenceToFlowPropertyDataSet ??
    {}) as JsonRecord;
}

test('flow remediation helper utilities cover normalization and fallback branches', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-remediate-helpers-'));
  const existingInput = path.join(tempDir, 'rows.jsonl');
  writeJsonl(existingInput, []);

  try {
    assert.equal(__testInternals.assert_input_file(existingInput), existingInput);
    assert.throws(
      () => __testInternals.assert_input_file(''),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_REMEDIATE_INPUT_REQUIRED',
    );
    assert.throws(
      () => __testInternals.assert_input_file(path.join(tempDir, 'missing.jsonl')),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_REMEDIATE_INPUT_NOT_FOUND',
    );
    assert.equal(__testInternals.assert_out_dir(tempDir), tempDir);
    assert.throws(
      () => __testInternals.assert_out_dir(''),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_REMEDIATE_OUT_DIR_REQUIRED',
    );

    assert.equal(
      __testInternals.build_local_dataset_uri('flow data set', 'uuid-1', '01.02.003'),
      '../flows/uuid-1_01.02.003.xml',
    );
    assert.equal(
      __testInternals.build_local_dataset_uri('unknown kind', 'uuid-2', ''),
      '../datasets/uuid-2_01.01.000.xml',
    );
    assert.equal(__testInternals.build_local_dataset_uri('flow', '', '01.00.001'), '');
    assert.equal(__testInternals.bump_ilcd_version('03.02.009'), '03.02.010');
    assert.equal(__testInternals.bump_ilcd_version('bad-value'), '00.00.001');
    assert.equal(__testInternals.version_from_uri('../flows/uuid_01.00.003.xml'), '01.00.003');
    assert.equal(
      __testInternals.version_from_uri('https://example.com/?version=02.00.001'),
      '02.00.001',
    );
    assert.equal(__testInternals.version_from_uri('https://example.com/no-version'), '');
    assert.equal(__testInternals.version_from_uri(''), '');
    assert.equal(
      __testInternals.update_permanent_dataset_uri(
        'https://example.com/?version=01.00.000',
        '01.00.001',
      ),
      'https://example.com/?version=01.00.001',
    );
    assert.equal(
      __testInternals.update_permanent_dataset_uri('no-version', '01.00.001'),
      'no-version',
    );
    assert.equal(__testInternals.update_permanent_dataset_uri(null, '01.00.001'), null);

    assert.deepEqual(__testInternals.normalize_multilang_entries('Water'), [
      { '@xml:lang': 'en', '#text': 'Water' },
    ]);
    assert.deepEqual(
      __testInternals.normalize_multilang_entries([{ '@xml:lang': 'zh', '#text': '水' }, 'Water']),
      [
        { '@xml:lang': 'zh', '#text': '水' },
        { '@xml:lang': 'en', '#text': 'Water' },
      ],
    );
    assert.equal(__testInternals.normalize_multilang_entries([{}, '   ']), null);
    assert.equal(__testInternals.normalize_multilang_entries({ '#text': '' }), null);

    const container: JsonRecord = { 'common:name': 'Water', 'common:shortDescription': '' };
    const containerFixes: string[] = [];
    __testInternals.normalize_multilang_field(container, 'common:name', containerFixes);
    __testInternals.normalize_multilang_field(container, 'common:shortDescription', containerFixes);
    assert.deepEqual(container['common:name'], [{ '@xml:lang': 'en', '#text': 'Water' }]);
    assert.equal('common:shortDescription' in container, false);
    assert.deepEqual(containerFixes, [
      'normalize_multilang:common:name',
      'remove_empty_multilang:common:shortDescription',
    ]);

    const nameInfo: JsonRecord = {
      name: {
        baseName: 'Water',
        flowProperties: '',
        mixAndLocationTypes: { '#text': 'Global' },
      },
    };
    const nameFixes: string[] = [];
    __testInternals.normalize_name_block(nameInfo, nameFixes);
    assert.deepEqual((nameInfo.name as JsonRecord).baseName, [
      { '@xml:lang': 'en', '#text': 'Water' },
    ]);
    assert.equal('flowProperties' in ((nameInfo.name as JsonRecord) ?? {}), false);
    assert.deepEqual((nameInfo.name as JsonRecord).mixAndLocationTypes, [
      { '@xml:lang': 'en', '#text': 'Global' },
    ]);
    assert.ok(nameFixes.includes('normalize_name_field:baseName'));
    assert.ok(nameFixes.includes('remove_empty_name_field:flowProperties'));

    const noNameFixes: string[] = [];
    __testInternals.normalize_name_block({}, noNameFixes);
    assert.deepEqual(noNameFixes, []);

    const reference = __testInternals.normalize_reference_block(
      {
        '@refObjectId': COMPLIANCE_UUID,
        '@type': 'source data set',
      },
      'source data set',
      'Fallback name',
    );
    assert.equal(reference?.['@version'], '20.20.002');
    assert.equal(
      reference?.['@uri'],
      '../sources/d92a1a12-2545-49e2-a585-55c259997756_20.20.002.xml',
    );
    const ilcdReference = __testInternals.normalize_reference_block(
      {
        '@refObjectId': ILCD_FORMAT_UUID,
      },
      'source data set',
      '',
    );
    assert.equal(ilcdReference?.['@version'], '03.00.003');
    const rawUriReference = __testInternals.normalize_reference_block(
      {
        '@refObjectId': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '@uri': 'https://example.com/custom-source',
      },
      'source data set',
      'Fallback source',
    );
    assert.equal(rawUriReference?.['@uri'], 'https://example.com/custom-source');
    assert.equal('@version' in (rawUriReference ?? {}), false);
    assert.deepEqual(rawUriReference?.['common:shortDescription'], [
      { '@xml:lang': 'en', '#text': 'Fallback source' },
    ]);
    assert.equal(__testInternals.normalize_reference_block({}, 'source data set', ''), null);

    assert.deepEqual(__testInternals.infer_flow_property_descriptor_from_hint('kg'), {
      uuid: DEFAULT_MASS_FLOW_PROPERTY_UUID,
      name: 'Mass',
      version: '03.00.003',
    });
    assert.deepEqual(
      __testInternals.infer_flow_property_descriptor_from_hint('flow property for 2 kilograms'),
      {
        uuid: DEFAULT_MASS_FLOW_PROPERTY_UUID,
        name: 'Mass',
        version: '03.00.003',
      },
    );
    assert.equal(__testInternals.infer_flow_property_descriptor_from_hint(null), null);
    assert.equal(__testInternals.infer_flow_property_descriptor_from_hint('volume'), null);
    assert.deepEqual(
      __testInternals.build_flow_property_item(
        {
          uuid: DEFAULT_MASS_FLOW_PROPERTY_UUID,
          name: 'Mass',
          version: '03.00.003',
        },
        '3',
        '1.0',
      ),
      {
        '@dataSetInternalID': '3',
        meanValue: '1.0',
        referenceToFlowPropertyDataSet: {
          '@type': 'flow property data set',
          '@refObjectId': DEFAULT_MASS_FLOW_PROPERTY_UUID,
          '@uri': `../flowproperties/${DEFAULT_MASS_FLOW_PROPERTY_UUID}_03.00.003.xml`,
          '@version': '03.00.003',
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
        },
      },
    );

    const emptyDataset: JsonRecord = { flowProperties: {} };
    const emptyFixes: string[] = [];
    const emptyProperties = __testInternals.normalize_flow_properties(emptyDataset, emptyFixes);
    assert.equal(emptyProperties.items.length, 1);
    assert.equal(emptyProperties.unresolved.length, 0);
    assert.ok(emptyFixes.includes('set_default_mass_flow_property'));

    const invalidDataset: JsonRecord = {
      flowProperties: {
        flowProperty: [42],
      },
    };
    const invalidProperties = __testInternals.normalize_flow_properties(invalidDataset, []);
    assert.equal(invalidProperties.items.length, 0);
    assert.equal(invalidProperties.unresolved[0]?.code, 'unsupported_item_type');

    const inferredDataset: JsonRecord = {
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '5',
          meanValue: '9.0',
          referenceToFlowPropertyDataSet: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'kg' }],
          },
        },
      },
    };
    const inferredFixes: string[] = [];
    const inferredProperties = __testInternals.normalize_flow_properties(
      inferredDataset,
      inferredFixes,
    );
    assert.equal(inferredProperties.items.length, 1);
    assert.ok(inferredFixes.includes('fill_missing_flow_property_uuid_from_short_description'));

    const unresolvedDataset: JsonRecord = {
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'volume' }],
          },
        },
      },
    };
    const unresolvedProperties = __testInternals.normalize_flow_properties(unresolvedDataset, []);
    assert.equal(unresolvedProperties.items.length, 1);
    assert.equal(unresolvedProperties.unresolved[0]?.code, 'unknown_flow_property_uuid');

    const quantDataset: JsonRecord = {
      flowInformation: {
        quantitativeReference: {
          referenceToReferenceFlowProperty: 'missing',
        },
      },
    };
    const quantFixes: string[] = [];
    const quantUnresolved: Array<{ code: string }> = [];
    __testInternals.normalize_quantitative_reference(
      quantDataset,
      [{ '@dataSetInternalID': '8' }],
      quantFixes,
      quantUnresolved as never,
    );
    assert.equal(
      ((quantDataset.flowInformation as JsonRecord).quantitativeReference as JsonRecord)
        .referenceToReferenceFlowProperty as string,
      'missing',
    );
    assert.deepEqual(quantFixes, []);
    assert.equal(quantUnresolved[0]?.code, 'flow_property_reference_unresolved');

    const quantDatasetWithoutProperties: JsonRecord = {
      flowInformation: {
        quantitativeReference: {},
      },
    };
    const missingQuantUnresolved: Array<{ code: string }> = [];
    __testInternals.normalize_quantitative_reference(
      quantDatasetWithoutProperties,
      [],
      [],
      missingQuantUnresolved as never,
    );
    assert.equal(missingQuantUnresolved[0]?.code, 'missing_flow_properties');

    assert.deepEqual(
      __testInternals.parse_validation_error({
        issues: [{ path: ['a', 'b'], message: 'bad', code: 'custom' }],
      }),
      [
        {
          validator: 'tidas_sdk',
          path: 'a.b',
          message: 'bad',
          code: 'custom',
        },
      ],
    );
    assert.deepEqual(
      __testInternals.parse_validation_error({
        issues: [{ path: [], message: 'empty path', code: 'custom' }],
      }),
      [
        {
          validator: 'tidas_sdk',
          path: '<exception>',
          message: 'empty path',
          code: 'custom',
        },
      ],
    );
    assert.deepEqual(
      __testInternals.parse_validation_error({
        issues: [{ path: 'not-an-array', message: '', code: '' }],
      }),
      [
        {
          validator: 'tidas_sdk',
          path: '<exception>',
          message: '[object Object]',
          code: 'validation_error',
        },
      ],
    );
    assert.equal(__testInternals.parse_validation_error({ issues: [] })[0]?.code, 'exception');

    const noManualPrompt = __testInternals.build_prompt([], 'manual.jsonl', 'prompt.md');
    assert.match(noManualPrompt, /residual manual queue 为 0/u);
    const manualPrompt = __testInternals.build_prompt(
      [{ id: 'flow-a' }, { id: 'flow-b' }],
      'manual.jsonl',
      path.join(tempDir, 'prompt.md'),
    );
    assert.match(manualPrompt, /flow-a/u);
    assert.match(manualPrompt, /residual manual queue/u);
    const anonymousManualPrompt = __testInternals.build_prompt(
      [{}],
      'manual.jsonl',
      path.join(tempDir, 'prompt-anonymous.md'),
    );
    assert.match(anonymousManualPrompt, /- None/u);

    const files = __testInternals.build_output_files(tempDir);
    assert.match(files.readyForMcp, /ready_for_mcp/u);
    assert.match(files.prompt, /prompt\.md$/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('flow remediation helpers cover repaired UUIDs, missing nested blocks, and zero-manual runs', async () => {
  const massVersionDataset: JsonRecord = {
    flowProperties: {
      flowProperty: {
        '@dataSetInternalID': '9',
        meanValue: '4.2',
        referenceToFlowPropertyDataSet: {
          '@refObjectId': DEFAULT_MASS_FLOW_PROPERTY_UUID,
        },
      },
    },
  };
  const massVersionFixes: string[] = [];
  const massVersionProperties = __testInternals.normalize_flow_properties(
    massVersionDataset,
    massVersionFixes,
  );
  assert.equal(
    (massVersionProperties.items[0]?.referenceToFlowPropertyDataSet as JsonRecord)?.[
      '@version'
    ] as string,
    '03.00.003',
  );

  const multiItemDataset: JsonRecord = {
    flowProperties: {
      flowProperty: [
        {
          '@dataSetInternalID': '1',
          meanValue: '1.0',
          referenceToFlowPropertyDataSet: {
            '@refObjectId': DEFAULT_MASS_FLOW_PROPERTY_UUID,
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
          },
        },
        {
          '@dataSetInternalID': '2',
          meanValue: '2.0',
          referenceToFlowPropertyDataSet: {
            '@refObjectId': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '@version': '01.00.000',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Custom property' }],
          },
        },
      ],
    },
  };
  const multiItemProperties = __testInternals.normalize_flow_properties(multiItemDataset, []);
  assert.equal(Array.isArray((multiItemDataset.flowProperties as JsonRecord).flowProperty), true);
  assert.equal(multiItemProperties.items.length, 2);

  const nonDefaultUuidDataset: JsonRecord = {
    flowProperties: {
      flowProperty: {
        '@dataSetInternalID': '3',
        meanValue: '3.0',
        referenceToFlowPropertyDataSet: {
          '@refObjectId': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        },
      },
    },
  };
  const nonDefaultUuidProperties = __testInternals.normalize_flow_properties(
    nonDefaultUuidDataset,
    [],
  );
  assert.equal(
    (nonDefaultUuidProperties.items[0]?.referenceToFlowPropertyDataSet as JsonRecord)?.[
      '@version'
    ] as string,
    '01.01.000',
  );

  const repairedDataset: JsonRecord = {
    flowProperties: {
      flowProperty: {
        '@dataSetInternalID': '4',
        meanValue: '1.0',
        referenceToFlowPropertyDataSet: {
          '@refObjectId': 'not-a-uuid',
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'kg' }],
        },
      },
    },
  };
  const repairedFixes: string[] = [];
  const repairedProperties = __testInternals.normalize_flow_properties(
    repairedDataset,
    repairedFixes,
  );
  assert.equal(repairedProperties.items.length, 1);
  assert.ok(repairedFixes.includes('repair_unknown_flow_property_uuid_from_short_description'));

  const stringReferenceDataset: JsonRecord = {
    flowProperties: {
      flowProperty: {
        '@dataSetInternalID': '5',
        referenceToFlowPropertyDataSet: 'kg',
      },
    },
  };
  const stringReferenceProperties = __testInternals.normalize_flow_properties(
    stringReferenceDataset,
    [],
  );
  assert.equal(stringReferenceProperties.unresolved[0]?.code, 'unknown_flow_property_uuid');

  const truthyUnknownDataset: JsonRecord = {
    flowProperties: {
      flowProperty: {
        '@dataSetInternalID': '6',
        referenceToFlowPropertyDataSet: {
          '@refObjectId': 'not-a-uuid',
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'volume' }],
        },
      },
    },
  };
  const truthyUnknownProperties = __testInternals.normalize_flow_properties(
    truthyUnknownDataset,
    [],
  );
  assert.match(
    String(truthyUnknownProperties.unresolved[0]?.message),
    /Unknown flow property UUID/u,
  );

  const quantDatasetWithScalar: JsonRecord = {
    flowInformation: {
      quantitativeReference: '',
    },
  };
  const quantScalarFixes: string[] = [];
  const quantScalarUnresolved: Array<{ code: string }> = [];
  __testInternals.normalize_quantitative_reference(
    quantDatasetWithScalar,
    [{ '@dataSetInternalID': '11' }],
    quantScalarFixes,
    quantScalarUnresolved as never,
  );
  assert.equal(
    ((quantDatasetWithScalar.flowInformation as JsonRecord).quantitativeReference as JsonRecord)
      .referenceToReferenceFlowProperty as string,
    undefined,
  );
  assert.equal(quantScalarUnresolved[0]?.code, 'flow_property_reference_unresolved');

  const quantDatasetWithoutFlowInformation: JsonRecord = {};
  __testInternals.normalize_quantitative_reference(
    quantDatasetWithoutFlowInformation,
    [{ '@dataSetInternalID': '12' }],
    [],
    [] as never,
  );
  assert.equal(
    (
      (quantDatasetWithoutFlowInformation.flowInformation as JsonRecord)
        .quantitativeReference as JsonRecord
    ).referenceToReferenceFlowProperty as string,
    undefined,
  );

  const minimalRow = __testInternals.remediate_row(
    {
      id: '66666666-6666-6666-6666-666666666666',
      json_ordered: {
        flowDataSet: {},
      },
    },
    { loadSdkModule: makeSdkLoader() },
  );
  assert.equal(minimalRow.valid, false);
  const minimalFlowDataSet = ((minimalRow.row.json_ordered as JsonRecord).flowDataSet ??
    {}) as JsonRecord;
  const minimalAdministrative = (minimalFlowDataSet.administrativeInformation ?? {}) as JsonRecord;
  const minimalPublication = (minimalAdministrative.publicationAndOwnership ?? {}) as JsonRecord;
  assert.equal(minimalPublication['common:dataSetVersion'], '01.01.000');
  assert.equal(
    typeof ((minimalAdministrative.dataEntryBy as JsonRecord)?.[
      'common:referenceToDataSetFormat'
    ] as JsonRecord),
    'object',
  );
  assert.equal(
    typeof (
      ((minimalFlowDataSet.modellingAndValidation as JsonRecord).complianceDeclarations ??
        {}) as JsonRecord
    ).compliance,
    'object',
  );

  const anonymousMinimalRow = __testInternals.remediate_row(
    {
      json_ordered: {
        flowDataSet: {},
      },
    },
    { loadSdkModule: makeSdkLoader() },
  );
  assert.equal(anonymousMinimalRow.valid, false);

  const actualValidation = __testInternals.validate_flow_payload({ flowDataSet: {} }, {});
  assert.equal(actualValidation.success, false);
  if (!actualValidation.success) {
    assert.ok(actualValidation.issues.length > 0);
  }

  assert.throws(
    () =>
      __testInternals.validate_flow_payload(
        { flowDataSet: {} },
        {
          loadSdkModule: () => ({}),
        },
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === 'FLOW_REMEDIATE_SDK_INVALID' &&
      error.details === null,
  );

  assert.throws(
    () =>
      __testInternals.validate_flow_payload(
        { flowDataSet: {} },
        {
          loadSdkModule: () => ({
            createFlow: () => ({}),
          }),
        },
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === 'FLOW_REMEDIATE_SDK_INVALID' &&
      error.details === null,
  );

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-remediate-zero-manual-'));
  const inputFile = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputFile, [
    {
      id: '77777777-7777-7777-7777-777777777777',
      json_ordered: {
        flowDataSet: {},
      },
    },
  ]);

  try {
    const report = await runFlowRemediate(
      {
        inputFile,
        outDir,
      },
      {
        loadSdkModule: makeSdkLoader(),
      },
    );

    assert.equal(report.counts.ready_for_mcp_rows, 0);
    assert.equal(report.counts.residual_manual_rows, 1);
    assert.equal(report.counts.state_code_0_rows, 1);
    assert.equal(report.counts.state_code_100_rows, 0);
    assert.match(report.generated_at_utc, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(report.residual_manual_ids, ['77777777-7777-7777-7777-777777777777']);
    assert.match(
      readFileSync(report.files.prompt, 'utf8'),
      /77777777-7777-7777-7777-777777777777/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow remediation sdk helpers cover resolution and validation error branches', () => {
  const loaded = __testInternals.resolve_sdk_module_from_candidates(
    ((candidate: string) => {
      if (candidate === 'good') {
        return {
          createFlow: () => ({
            validate: () => ({ success: true }),
          }),
        };
      }
      throw new Error(`Cannot load ${candidate}`);
    }) as never,
    ['bad', 'good'],
  );
  assert.equal(loaded.location, 'good');

  assert.throws(
    () =>
      __testInternals.resolve_sdk_module_from_candidates(
        ((candidate: string) => {
          if (candidate === 'missing-export') {
            return {};
          }
          throw new Error('boom');
        }) as never,
        ['missing-export', 'broken'],
      ),
    (error: unknown) => error instanceof CliError && error.code === 'FLOW_REMEDIATE_SDK_NOT_FOUND',
  );

  const successConfigs: boolean[] = [];
  const successValidation = __testInternals.validate_flow_payload(
    { flowDataSet: {} },
    {
      loadSdkModule: () => ({
        location: 'mock',
        createFlow: (_data, config) => ({
          validateEnhanced: () => {
            successConfigs.push(config?.deepValidation ?? false);
            return { success: true };
          },
          validate: () => ({ success: true }),
        }),
      }),
    },
  );
  assert.deepEqual(successValidation, { success: true });
  assert.deepEqual(successConfigs, [false]);

  assert.throws(
    () =>
      __testInternals.validate_flow_payload(
        { flowDataSet: {} },
        {
          loadSdkModule: () => ({
            location: 'mock',
          }),
        },
      ),
    (error: unknown) => error instanceof CliError && error.code === 'FLOW_REMEDIATE_SDK_INVALID',
  );

  assert.throws(
    () =>
      __testInternals.validate_flow_payload(
        { flowDataSet: {} },
        {
          loadSdkModule: () => ({
            location: 'mock',
            createFlow: () => ({}),
          }),
        },
      ),
    (error: unknown) => error instanceof CliError && error.code === 'FLOW_REMEDIATE_SDK_INVALID',
  );

  const failedConfigs: boolean[] = [];
  const failedValidation = __testInternals.validate_flow_payload(
    { flowDataSet: {} },
    {
      loadSdkModule: () => ({
        location: 'mock',
        createFlow: (_data, config) => ({
          validateEnhanced: () => {
            failedConfigs.push(config?.deepValidation ?? false);
            return {
              success: false,
              error: {
                issues: [
                  {
                    path: [config?.deepValidation ? 'deepFlowDataSet' : 'flowDataSet'],
                    message: 'broken',
                    code: 'custom',
                  },
                ],
              },
            };
          },
        }),
      }),
    },
  );
  assert.equal(failedValidation.success, false);
  assert.deepEqual(failedConfigs, [false, true]);
  assert.equal(failedValidation.issues[0]?.path, 'deepFlowDataSet');

  const thrownValidation = __testInternals.validate_flow_payload(
    { flowDataSet: {} },
    {
      loadSdkModule: () => ({
        location: 'mock',
        createFlow: () => {
          throw new Error('validation exploded');
        },
      }),
    },
  );
  assert.equal(thrownValidation.success, false);
  assert.equal(thrownValidation.issues[0]?.code, 'exception');

  const scalarValidation = __testInternals.validate_flow_payload(
    { flowDataSet: {} },
    {
      loadSdkModule: () => ({
        location: 'mock',
        createFlow: () => ({
          validate: () => 'plain failure',
        }),
      }),
    },
  );
  assert.equal(scalarValidation.success, false);
  assert.equal(scalarValidation.issues[0]?.code, 'exception');
});

test('remediate_row covers missing payload and empty preceding-reference fallback branches', () => {
  const missingPayload = __testInternals.remediate_row(
    { id: 'x' },
    { loadSdkModule: makeSdkLoader() },
  );
  assert.equal(missingPayload.valid, false);
  assert.equal(missingPayload.finalReasons[0]?.code, 'missing_flow_dataset');

  const row = makeFlowEnvelope({
    id: '55555555-5555-5555-5555-555555555555',
    precedingRef: {},
    technicalSpecification: 'spec text',
    baseName: { '#text': 'One name' },
  });
  const result = __testInternals.remediate_row(row, { loadSdkModule: makeSdkLoader() });
  const publicationAndOwnership = (
    ((result.row.json_ordered as JsonRecord).flowDataSet as JsonRecord)
      .administrativeInformation as JsonRecord
  ).publicationAndOwnership as JsonRecord;
  assert.equal('common:referenceToPrecedingDataSetVersion' in publicationAndOwnership, false);
  assert.ok(result.appliedFixes.includes('remove_empty_reference_to_preceding_dataset_version'));
  const technology = (
    ((result.row.json_ordered as JsonRecord).flowDataSet as JsonRecord)
      .flowInformation as JsonRecord
  ).technology as JsonRecord;
  assert.equal('referenceToTechnicalSpecification' in technology, false);
  assert.ok(result.appliedFixes.includes('remove_invalid_reference_to_technical_specification'));
});
