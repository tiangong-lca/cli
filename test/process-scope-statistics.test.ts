import test from 'node:test';
import assert from 'node:assert/strict';
import * as __testInternals from '../src/lib/process-statistics/summary.js';

type JsonRecord = Record<string, unknown>;

function langEntries(en: string, zh: string): JsonRecord[] {
  return [
    { '@xml:lang': 'en', '#text': en },
    { '@xml:lang': 'zh', '#text': zh },
  ];
}

function createProcessPayload(options: {
  primaryDomain: string;
  leafDomain: string;
  route?: string;
  routeZh?: string;
  technology: string;
  technologyZh: string;
  typeOfDataSet: string;
  referenceFlowId: string;
  referenceFlowVersion?: string;
  referenceFlowLabelEn: string;
  referenceFlowLabelZh: string;
  baseNameEn: string;
  baseNameZh: string;
}): JsonRecord {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          name: {
            baseName: langEntries(options.baseNameEn, options.baseNameZh),
            treatmentStandardsRoutes: options.route
              ? langEntries(options.route, options.routeZh ?? options.route)
              : '',
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                {
                  '@level': '1',
                  '#text': options.primaryDomain,
                },
                {
                  '@level': '2',
                  '#text': options.leafDomain,
                },
              ],
            },
          },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: langEntries(
            options.technology,
            options.technologyZh,
          ),
        },
        quantitativeReference: {
          referenceToReferenceFlow: '1',
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: options.typeOfDataSet,
        },
      },
      exchanges: {
        exchange: [
          {
            '@dataSetInternalID': '1',
            exchangeDirection: 'Output',
            meanAmount: '1',
            resultingAmount: '1',
            referenceToFlowDataSet: {
              '@refObjectId': options.referenceFlowId,
              '@version': options.referenceFlowVersion ?? '01.00.000',
              'common:shortDescription': langEntries(
                options.referenceFlowLabelEn,
                options.referenceFlowLabelZh,
              ),
            },
          },
        ],
      },
    },
  };
}

test('process scope helper internals cover sparse classification entries', () => {
  assert.deepEqual(
    __testInternals.extractClassificationEntries({
      classificationInformation: {
        'common:classification': {
          'common:class': [
            null,
            {
              '@level': '1',
              '#text': '',
            },
            {
              '@level': '2',
              '#text': 'Paper sorting',
            },
          ],
        },
      },
    }),
    [
      {
        level: 2,
        text: 'Paper sorting',
      },
    ],
  );
});

test('statistics normalizes supplied snapshot payloads and localized labels', () => {
  assert.equal(__testInternals.normalizeSnapshotRow(null), null);
  assert.equal(
    __testInternals.normalizeSnapshotRow({
      id: 'proc-1',
      version: '01.00.000',
      json: null,
    }),
    null,
  );
  assert.deepEqual(__testInternals.normalizePayload({ ok: true }), { ok: true });
  assert.deepEqual(__testInternals.normalizePayload('{"ok":true}'), { ok: true });
  assert.equal(__testInternals.normalizePayload('['), null);
  assert.equal(__testInternals.normalizePayload(''), null);

  assert.deepEqual(
    __testInternals.getLangList({
      'common:langString': {
        '@xml:lang': 'zh',
        '#text': '中文',
      },
    }),
    [{ '@xml:lang': 'zh', '#text': '中文' }],
  );
  assert.deepEqual(
    __testInternals.getLangList({
      'common:langString': [{ '@xml:lang': 'en', '#text': 'English' }, null],
    }),
    [{ '@xml:lang': 'en', '#text': 'English' }],
  );
  assert.deepEqual(__testInternals.getLangList({ '@xml:lang': 'en', '#text': 'English' }), [
    { '@xml:lang': 'en', '#text': 'English' },
  ]);
  assert.deepEqual(__testInternals.getLangList('Fallback'), [
    { '@xml:lang': 'en', '#text': 'Fallback' },
  ]);
  assert.deepEqual(__testInternals.getLangList(123), []);
});

test('statistics preserves sparse fallbacks and zero-row facts', () => {
  assert.deepEqual(
    __testInternals.normalizeSnapshotRow({
      id: 'proc-1',
      version: '01.00.000',
      state_code: 'draft',
      user_id: '',
      modified_at: '',
      model_id: '',
      json: {},
    }),
    {
      id: 'proc-1',
      version: '01.00.000',
      state_code: null,
      user_id: null,
      modified_at: null,
      model_id: null,
      json: {},
    },
  );
  assert.equal(__testInternals.normalizePayload('[1]'), null);
  assert.deepEqual(__testInternals.getLangList({ '@xml:lang': 'en' }), [{ '@xml:lang': 'en' }]);
  assert.equal(__testInternals.getLangText([{ '@xml:lang': 'zh', '#text': '' }], 'en'), '');
  assert.deepEqual(
    __testInternals.extractClassificationEntries({
      classificationInformation: {
        'common:classification': {
          'common:class': {
            '#text': 'Fallback domain',
          },
        },
      },
    }),
    [
      {
        level: 0,
        text: 'Fallback domain',
      },
    ],
  );
  assert.deepEqual(
    __testInternals.extractCraftCandidate(
      {
        name: {
          baseName: langEntries('Base fallback', '基础回退'),
        },
      },
      {},
    ),
    {
      source_kind: 'baseName',
      label: 'Base fallback',
      signature: 'base fallback',
    },
  );
  assert.deepEqual(
    __testInternals.extractReferenceProduct(
      {
        processInformation: {
          quantitativeReference: {
            referenceToReferenceFlow: '9',
          },
        },
        exchanges: {
          exchange: [
            {
              '@dataSetInternalID': '9',
              referenceToFlowDataSet: {
                '@refObjectId': 'flow-9',
              },
            },
          ],
        },
      },
      {
        name: {},
      },
    ),
    {
      key: 'flow:flow-9',
      stable_flow_id: 'flow-9',
      stable_flow_version: '',
      label: 'flow-9',
      source_kind: 'reference_flow_id',
      missing_reference_exchange: false,
    },
  );
  assert.deepEqual(
    __testInternals.extractReferenceProduct(
      {
        processInformation: {},
        exchanges: {},
      },
      {
        name: {},
      },
    ),
    {
      key: '',
      stable_flow_id: '',
      stable_flow_version: '',
      label: '',
      source_kind: 'missing',
      missing_reference_exchange: true,
    },
  );

  const sparseStatistics = __testInternals.calculateStatistics(
    [
      {
        id: 'proc-null',
        version: '01.00.000',
        state_code: null,
        user_id: null,
        modified_at: null,
        model_id: null,
        json: {},
      },
      {
        id: 'proc-fallback',
        version: '01.00.001',
        state_code: 0,
        user_id: null,
        modified_at: null,
        model_id: null,
        json: {
          processDataSet: {
            processInformation: {
              dataSetInformation: {
                name: {
                  baseName: langEntries('Fallback base', '基础回退'),
                },
                classificationInformation: {
                  'common:classification': {
                    'common:class': {
                      '@level': '2',
                      '#text': 'Fallback leaf',
                    },
                  },
                },
              },
              technology: {},
            },
            modellingAndValidation: {
              LCIMethodAndAllocation: {
                typeOfDataSet: 'Aggregated process',
              },
            },
            exchanges: {},
          },
        },
      },
    ],
    {
      scope: 'visible',
      stateCodes: [0],
    },
    {
      userId: null,
      maskedUserEmail: null,
      totalRowsReportedByRemote: null,
    },
    '2026-04-18T06:45:00.000Z',
  );
  assert.deepEqual(sparseStatistics.summary.rows_by_state_code, {
    '0': 1,
    null: 1,
  });
  assert.equal(sparseStatistics.summary.distinct_visible_owner_user_ids, 1);
  assert.equal(sparseStatistics.summary.domain_count_primary, 1);
  assert.equal(sparseStatistics.domainPrimarySummary[0]?.domain, 'Fallback leaf');
  assert.equal(sparseStatistics.summary.rows_missing_classification, 1);
  assert.equal(sparseStatistics.summary.rows_missing_craft, 1);
  assert.equal(sparseStatistics.summary.rows_missing_product, 1);
  assert.equal(sparseStatistics.summary.rows_missing_reference_exchange, 2);

  const emptyStatistics = __testInternals.calculateStatistics(
    [],
    {
      scope: 'visible',
      stateCodes: [0],
    },
    {
      userId: null,
      maskedUserEmail: null,
      totalRowsReportedByRemote: 0,
    },
    '2026-04-18T06:50:00.000Z',
  );
  assert.equal(emptyStatistics.summary.unit_process_share, 0);
});

test('observed statistics fetches visible process rows and writes summary artifacts', () => {
  const rows = [
    {
      id: 'proc-1',
      version: '01.00.000',
      state_code: 100,
      user_id: 'user-1',
      modified_at: '2026-04-17T00:00:00.000Z',
      model_id: 'model-1',
      json: createProcessPayload({
        primaryDomain: 'Waste management',
        leafDomain: 'Paper sorting',
        route: 'Sorting',
        routeZh: '分选',
        technology: 'Sorting line. downstream note',
        technologyZh: '分选线。附加说明',
        typeOfDataSet: 'Unit process, single operation',
        referenceFlowId: 'flow-product-1',
        referenceFlowLabelEn: 'sorted waste paper',
        referenceFlowLabelZh: '分选废纸',
        baseNameEn: 'Waste paper sorting',
        baseNameZh: '废纸分选',
      }),
    },
    {
      id: 'proc-2',
      version: '01.00.000',
      state_code: 100,
      user_id: 'user-2',
      modified_at: '2026-04-17T01:00:00.000Z',
      model_id: 'model-2',
      json: createProcessPayload({
        primaryDomain: 'Waste management',
        leafDomain: 'Transport',
        technology: 'Transport service. additional note',
        technologyZh: '运输服务。附加说明',
        typeOfDataSet: 'Aggregated process',
        referenceFlowId: '',
        referenceFlowLabelEn: 'transport service',
        referenceFlowLabelZh: '运输服务',
        baseNameEn: 'Waste transfer',
        baseNameZh: '废弃物转运',
      }),
    },
  ].map((row) => __testInternals.normalizeSnapshotRow(row)!);
  const { summary } = __testInternals.calculateStatistics(
    rows,
    { scope: 'visible', stateCodes: [100] },
    { userId: null, maskedUserEmail: null, totalRowsReportedByRemote: rows.length },
    '2026-04-18T00:00:00.000Z',
  );
  assert.equal(summary.total_process_rows, 2);
  assert.equal(summary.domain_count_primary, 1);
  assert.equal(summary.domain_count_leaf, 2);
  assert.equal(summary.craft_count, 2);
  assert.equal(summary.unit_process_rows, 1);
  assert.equal(summary.product_count, 2);
  assert.equal(summary.total_process_rows, 2);
  assert.deepEqual(summary.rows_by_state_code, { '100': 2 });
  assert.equal(summary.distinct_visible_owner_user_ids, 2);
  assert.equal(summary.products_with_flow_id, 1);
  assert.equal(summary.products_without_flow_id, 1);
  assert.equal(summary.rows_missing_reference_exchange, 0);
});

test('observed statistics counts rows that are missing products and reference exchanges', () => {
  const rows = [
    {
      id: 'proc-missing',
      version: '01.00.000',
      state_code: 100,
      user_id: 'user-1',
      modified_at: '2026-04-17T00:00:00.000Z',
      model_id: 'model-1',
      json: {
        processDataSet: {
          processInformation: 'bad-data',
          modellingAndValidation: 'bad-data',
          exchanges: {
            exchange: [],
          },
        },
      },
    },
  ].map((row) => __testInternals.normalizeSnapshotRow(row)!);
  const { summary } = __testInternals.calculateStatistics(
    rows,
    { scope: 'visible', stateCodes: [100] },
    { userId: null, maskedUserEmail: null, totalRowsReportedByRemote: rows.length },
    '2026-04-18T00:00:00.000Z',
  );
  assert.equal(summary.product_count, 0);
  assert.equal(summary.products_without_flow_id, 0);
  assert.equal(summary.rows_missing_product, 1);
  assert.equal(summary.rows_missing_reference_exchange, 1);
});

test('observed statistics falls back to process base names when reference-flow labels are missing', () => {
  const rows = [
    {
      id: 'proc-base-name',
      version: '01.00.000',
      state_code: 100,
      user_id: 'user-1',
      modified_at: '2026-04-17T00:00:00.000Z',
      model_id: 'model-1',
      json: {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              name: {
                baseName: langEntries('Fallback product', '回退产品'),
              },
            },
            quantitativeReference: {
              referenceToReferenceFlow: '1',
            },
          },
          modellingAndValidation: {
            LCIMethodAndAllocation: {
              typeOfDataSet: 'Aggregated process',
            },
          },
          exchanges: {
            exchange: [],
          },
        },
      },
    },
  ].map((row) => __testInternals.normalizeSnapshotRow(row)!);
  const { summary } = __testInternals.calculateStatistics(
    rows,
    { scope: 'visible', stateCodes: [100] },
    { userId: null, maskedUserEmail: null, totalRowsReportedByRemote: rows.length },
    '2026-04-18T00:00:00.000Z',
  );
  assert.equal(summary.product_count, 1);
  assert.equal(summary.products_without_flow_id, 1);
  assert.equal(summary.rows_missing_reference_exchange, 1);
});
