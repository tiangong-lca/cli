import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals,
  normalizeLifecyclemodelAutoBuildRequest,
  runLifecyclemodelAutoBuild,
} from '../src/lib/lifecyclemodel-auto-build.js';

type JsonRecord = Record<string, unknown>;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function textItem(text: string, lang = 'en'): JsonRecord {
  return {
    '@xml:lang': lang,
    '#text': text,
  };
}

function flowRef(flowId: string, shortDescription = flowId): JsonRecord {
  return {
    '@refObjectId': flowId,
    '@type': 'flow data set',
    '@version': '00.00.001',
    'common:shortDescription': [textItem(shortDescription, 'en')],
  };
}

function createExchange(options: {
  internalId: string;
  flowId: string;
  direction: 'Input' | 'Output';
  meanAmount: number;
  shortDescription?: string;
}): JsonRecord {
  return {
    '@dataSetInternalID': options.internalId,
    exchangeDirection: options.direction,
    meanAmount: options.meanAmount,
    referenceToFlowDataSet: flowRef(options.flowId, options.shortDescription ?? options.flowId),
  };
}

function createProcessPayload(options: {
  id: string;
  version?: string;
  referenceInternalId: string;
  exchanges: JsonRecord[];
  baseName: string;
  baseNameZh?: string;
  route?: string;
  mix?: string;
  classificationPath?: string[];
  location?: string;
  includeEnteringRef?: boolean;
}): JsonRecord {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': options.id,
          name: {
            baseName: [
              textItem(options.baseName, 'en'),
              textItem(options.baseNameZh ?? options.baseName, 'zh'),
            ],
            treatmentStandardsRoutes: [textItem(options.route ?? 'default route', 'en')],
            mixAndLocationTypes: [textItem(options.mix ?? 'default mix', 'en')],
          },
          classificationInformation: {
            'common:classification': {
              'common:class': (options.classificationPath ?? ['A', 'B']).map((item) => ({
                '#text': item,
              })),
            },
          },
          'common:generalComment': [textItem('existing comment', 'en')],
        },
        quantitativeReference: {
          referenceToReferenceFlow: options.referenceInternalId,
        },
        geography: {
          locationOfOperationSupplyOrProduction: {
            '@location': options.location ?? 'CN',
          },
        },
        technology: {},
      },
      exchanges: {
        exchange: options.exchanges,
      },
      administrativeInformation: {
        'common:commissionerAndGoal': {},
        dataEntryBy:
          options.includeEnteringRef === false
            ? {}
            : {
                'common:referenceToPersonOrEntityEnteringTheData': {
                  '@refObjectId': 'person-1',
                },
              },
        publicationAndOwnership: {
          'common:dataSetVersion': options.version ?? '00.00.001',
          'common:referenceToOwnershipOfDataSet': {
            '@refObjectId': 'org-1',
          },
        },
      },
      modellingAndValidation: {
        complianceDeclarations: {
          compliance: {},
        },
      },
    },
  };
}

function createProcessRunFixture(
  rootDir: string,
  runName: string,
  options?: {
    wrapFlowDataset?: boolean;
    singleProcess?: boolean;
    badProcess?: 'missing_uuid' | 'missing_reference_exchange';
  },
): string {
  const runDir = path.join(rootDir, runName);
  const statePath = path.join(runDir, 'cache', 'process_from_flow_state.json');
  const processDir = path.join(runDir, 'exports', 'processes');
  mkdirSync(processDir, { recursive: true });

  const flowDataSet = {
    flowInformation: {
      dataSetInformation: {
        name: {
          baseName: [textItem('Target flow', 'en'), textItem('目标流', 'zh')],
          treatmentStandardsRoutes: [textItem('target route', 'en')],
          mixAndLocationTypes: [textItem('target mix', 'en')],
        },
      },
    },
  };

  writeJson(statePath, {
    flow_summary: {
      uuid: 'flow-target',
      base_name: 'Target flow',
      base_name_en: 'Target flow',
      base_name_zh: '目标流',
    },
    flow_dataset: options?.wrapFlowDataset === false ? flowDataSet : { flowDataSet },
    technical_description: 'demo lifecycle chain',
    scope: 'demo scope',
  });

  const upstream = createProcessPayload({
    id: 'process-upstream',
    referenceInternalId: '10',
    exchanges: [
      createExchange({
        internalId: '10',
        flowId: 'flow-intermediate',
        direction: 'Output',
        meanAmount: 2,
      }),
    ],
    baseName: 'Upstream process',
    classificationPath: ['chemicals', 'intermediate'],
  });

  const downstream = createProcessPayload({
    id: 'process-downstream',
    referenceInternalId: '21',
    exchanges: [
      createExchange({
        internalId: '20',
        flowId: 'flow-intermediate',
        direction: 'Input',
        meanAmount: 4,
      }),
      createExchange({
        internalId: '21',
        flowId: 'flow-target',
        direction: 'Output',
        meanAmount: 1,
      }),
    ],
    baseName: 'Downstream process',
    classificationPath: ['chemicals', 'target'],
  });

  const single = createProcessPayload({
    id: 'process-single',
    referenceInternalId: '30',
    exchanges: [
      createExchange({
        internalId: '30',
        flowId: 'flow-target',
        direction: 'Output',
        meanAmount: 1,
      }),
    ],
    baseName: 'Single process',
    classificationPath: ['single'],
    includeEnteringRef: false,
  });

  if (options?.singleProcess) {
    writeJson(path.join(processDir, 'single.json'), single);
    return runDir;
  }

  if (options?.badProcess === 'missing_uuid') {
    const bad = createProcessPayload({
      id: 'temp-id',
      referenceInternalId: '30',
      exchanges: [
        createExchange({
          internalId: '30',
          flowId: 'flow-target',
          direction: 'Output',
          meanAmount: 1,
        }),
      ],
      baseName: 'Bad process',
    }) as { processDataSet: { processInformation: { dataSetInformation: JsonRecord } } };
    delete bad.processDataSet.processInformation.dataSetInformation['common:UUID'];
    writeJson(path.join(processDir, 'bad.json'), bad);
    return runDir;
  }

  if (options?.badProcess === 'missing_reference_exchange') {
    const bad = createProcessPayload({
      id: 'process-bad',
      referenceInternalId: '999',
      exchanges: [
        createExchange({
          internalId: '30',
          flowId: 'flow-target',
          direction: 'Output',
          meanAmount: 1,
        }),
      ],
      baseName: 'Bad process',
    });
    writeJson(path.join(processDir, 'bad.json'), bad);
    return runDir;
  }

  writeJson(path.join(processDir, '01-upstream.json'), upstream);
  writeJson(path.join(processDir, '02-downstream.json'), downstream);
  return runDir;
}

test('normalizeLifecyclemodelAutoBuildRequest resolves defaults, run roots, and local runs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-normalize-'));
  const runDir = createProcessRunFixture(dir, 'run-1');
  const requestPath = path.join(dir, 'request.json');
  writeJson(requestPath, {
    run_label: 'demo-local-build',
    out_dir: './normalized-run-root',
    local_runs: ['./run-1'],
  });

  try {
    const normalized = normalizeLifecyclemodelAutoBuildRequest(readJson(requestPath), {
      inputPath: requestPath,
      now: new Date('2026-03-30T00:00:00Z'),
      runIdOverride: 'lm-run-1',
    });

    assert.equal(normalized.run_id, 'lm-run-1');
    assert.equal(normalized.run_root, path.join(dir, 'normalized-run-root'));
    assert.deepEqual(normalized.local_runs, [runDir]);
    assert.equal(normalized.manifest.run_label, 'demo-local-build');
    assert.equal((normalized.manifest.selection as JsonRecord).mode, 'graph_first_local_build');

    const fallbackRequestPath = path.join(dir, 'fallback-request.json');
    writeJson(fallbackRequestPath, {
      run_label: '',
      out_dir: './fallback-run-root',
      local_runs: ['./run-1'],
    });
    const fallbackNormalized = normalizeLifecyclemodelAutoBuildRequest(
      readJson(fallbackRequestPath),
      {
        inputPath: fallbackRequestPath,
      },
    );
    assert.match(
      fallbackNormalized.run_id,
      /^lifecyclemodel_auto_build_fallback_request_build_\d{8}T\d{6}Z_[a-z0-9_]+$/u,
    );
    assert.equal(fallbackNormalized.run_root, path.join(dir, 'fallback-run-root'));

    assert.throws(
      () =>
        normalizeLifecyclemodelAutoBuildRequest(
          {
            local_runs: ['./run-1'],
          },
          {
            inputPath: requestPath,
          },
        ),
      /Provide --out-dir or request\.out_dir/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel auto-build internals cover manifest helpers and graph helpers', () => {
  const merged = __testInternals.deepMerge(__testInternals.DEFAULT_MANIFEST, {
    selection: {
      decision_factors: ['custom factor'],
    },
  }) as JsonRecord;
  assert.deepEqual((merged.selection as JsonRecord).decision_factors, ['custom factor']);

  assert.match(
    __testInternals.buildSelectionBrief({
      selection: { decision_factors: ['factor-a'] },
      discovery: { reference_model_queries: ['cement chain'] },
    }),
    /deferred reference query: cement chain/u,
  );
  assert.equal(
    (__testInternals.buildReferenceModelSummary({ discovery: {} }) as JsonRecord).reason,
    'reference model discovery not requested',
  );
  assert.throws(
    () => __testInternals.normalizeLocalRuns(['./dup', './dup'], '/tmp'),
    /Duplicate lifecyclemodel auto-build local_run/u,
  );
  assert.equal(
    __testInternals.uuid5FromText('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'demo-run'),
    'd39a4235-99d7-5cb9-af5c-849a602563b0',
  );
  assert.deepEqual(
    __testInternals.extractClassificationPath({
      'common:classification': {
        'common:class': [{ '#text': 'A' }, { '#text': 'B' }],
      },
    }),
    ['A', 'B'],
  );
  assert.equal(__testInternals.classificationOverlap(['A', 'B'], ['A', 'C']), 1);
  assert.deepEqual(
    __testInternals.extractFlowDatasetFromState({
      flow_dataset: { flowDataSet: { id: 'wrapped' } },
    }),
    { id: 'wrapped' },
  );
  assert.deepEqual(
    __testInternals.extractFlowDatasetFromState({
      flow_dataset: { id: 'direct' },
    }),
    { id: 'direct' },
  );
  assert.equal(__testInternals.formatNumber(0), '0');
  assert.equal(__testInternals.formatNumber(1 / 3), '0.333333333333333');

  const passThroughMap = {
    upstream: {
      processUuid: 'upstream',
      version: '00.00.001',
      raw: {},
      referenceExchangeInternalId: '1',
      referenceFlowUuid: 'flow-a',
      referenceDirection: 'Output' as const,
      referenceAmount: 1,
      inputAmounts: {},
      outputAmounts: { 'flow-a': 1 },
      nameEn: 'Upstream',
      nameZh: '',
      routeEn: '',
      mixEn: '',
      geographyCode: 'CN',
      classificationPath: ['a'],
      tokenSet: new Set(['upstream']),
      sourceKind: 'local_run_export' as const,
      sourceLabel: 'run',
      includedProcessRefCount: 0,
    },
    bridge: {
      processUuid: 'bridge',
      version: '00.00.001',
      raw: {},
      referenceExchangeInternalId: '2',
      referenceFlowUuid: 'flow-a',
      referenceDirection: 'Input' as const,
      referenceAmount: 1,
      inputAmounts: { 'flow-a': 1 },
      outputAmounts: { 'flow-a': 1 },
      nameEn: 'Bridge',
      nameZh: '',
      routeEn: '',
      mixEn: '',
      geographyCode: 'CN',
      classificationPath: ['a'],
      tokenSet: new Set(['bridge']),
      sourceKind: 'local_run_export' as const,
      sourceLabel: 'run',
      includedProcessRefCount: 0,
    },
    downstream: {
      processUuid: 'downstream',
      version: '00.00.001',
      raw: {},
      referenceExchangeInternalId: '3',
      referenceFlowUuid: 'flow-a',
      referenceDirection: 'Input' as const,
      referenceAmount: 1,
      inputAmounts: { 'flow-a': 1 },
      outputAmounts: {},
      nameEn: 'Downstream',
      nameZh: '',
      routeEn: '',
      mixEn: '',
      geographyCode: 'CN',
      classificationPath: ['a'],
      tokenSet: new Set(['downstream']),
      sourceKind: 'local_run_export' as const,
      sourceLabel: 'run',
      includedProcessRefCount: 0,
    },
  };
  const passThroughEdges = __testInternals.inferEdges(passThroughMap);
  assert.deepEqual(
    passThroughEdges.map((item) => `${item.src}->${item.dst}`),
    ['upstream->bridge', 'bridge->downstream'],
  );
});

test('lifecyclemodel auto-build utility helpers cover fallback parsing branches', () => {
  assert.equal(__testInternals.copyJson(undefined), undefined);
  assert.deepEqual(__testInternals.ensureList('item'), ['item']);
  assert.deepEqual(__testInternals.ensureList(null), []);
  assert.equal(__testInternals.numberOrZero(''), 0);
  assert.equal(__testInternals.numberOrZero('3.5'), 3.5);
  assert.equal(__testInternals.numberOrZero('bad'), 0);
  assert.equal(__testInternals.numberOrZero(Infinity), 0);

  assert.equal(__testInternals.firstText([{ '#text': 'from-array' }]), 'from-array');
  assert.equal(__testInternals.firstText({ '#text': 'from-object' }), 'from-object');
  assert.equal(__testInternals.firstText({}), '');
  assert.equal(__testInternals.firstText('plain-text'), 'plain-text');
  assert.equal(__testInternals.firstText('   '), '');
  assert.equal(__testInternals.firstText([]), '');

  assert.deepEqual(__testInternals.langTextMap('direct text'), { en: 'direct text' });
  assert.deepEqual(__testInternals.langTextMap([{ '#text': 'implicit-en' }]), {
    en: 'implicit-en',
  });
  assert.deepEqual(__testInternals.langTextMap([textItem('中文', 'zh')]), { zh: '中文' });
  assert.deepEqual(__testInternals.langTextMap([textItem('Fallback English', 'zh-Hans')]), {
    en: 'Fallback English',
  });
  assert.equal(__testInternals.localizedText([textItem('Francais', 'fr')], 'fr'), 'Francais');
  assert.equal(__testInternals.localizedText([textItem('中文', 'zh')], 'zh'), '中文');
  assert.equal(__testInternals.localizedText([textItem('Deutsch', 'de')], 'zh'), 'Deutsch');
  assert.equal(__testInternals.localizedText([textItem('English', 'en')], 'fr'), 'English');
  assert.equal(__testInternals.localizedText([], 'fr'), '');
  assert.deepEqual(__testInternals.multilangText([textItem('英文', 'zh')]), ['英文', '英文']);
  assert.deepEqual(__testInternals.multilangFromText('', '中文'), [
    { '@xml:lang': 'zh', '#text': '中文' },
  ]);

  assert.deepEqual(__testInternals.buildNameSummary({}), []);
  assert.deepEqual(
    __testInternals.buildNameSummary({
      baseName: [textItem('Base', 'en')],
      treatmentStandardsRoutes: [textItem('Route', 'en')],
      mixAndLocationTypes: [textItem('Mix', 'en')],
      functionalUnitFlowProperties: [textItem('FU', 'en')],
    }),
    [{ '@xml:lang': 'en', '#text': 'Base; Route; Mix; FU' }],
  );
  assert.deepEqual(
    __testInternals.buildNameSummary({
      baseName: [textItem('基础', 'zh')],
      treatmentStandardsRoutes: [textItem('Voie', 'fr')],
    }),
    [
      { '@xml:lang': 'zh', '#text': '基础; Voie' },
      { '@xml:lang': 'fr', '#text': '基础; Voie' },
    ],
  );
  assert.deepEqual(
    __testInternals.buildNameSummary({
      baseName: [{ '@xml:lang': 'de', '#text': 'First only' }],
      treatmentStandardsRoutes: [textItem('Route', 'en')],
    }),
    [
      { '@xml:lang': 'de', '#text': 'First only; Route' },
      { '@xml:lang': 'en', '#text': 'First only; Route' },
    ],
  );
  assert.deepEqual(__testInternals.extractClassificationPath({}), []);
  assert.deepEqual(
    __testInternals.extractClassificationPath({
      'common:classification': {
        'common:class': ['bad', { '#text': 'Valid' }],
      },
    }),
    ['Valid'],
  );

  assert.throws(() => __testInternals.uuid5FromText('not-a-uuid', 'demo'), /Invalid UUID value/u);
  assert.equal(__testInternals.formatNumber(0.0000001), '0.0000001');
  assert.equal(__testInternals.formatNumber(10_000_000), '10000000');
  assert.equal(__testInternals.toJsonNumber(1.5), 1.5);
  assert.equal(__testInternals.exchangeAmount({ resultingAmount: '4.2' }), 4.2);
  assert.deepEqual(
    __testInternals.cloneExchangeWithAmount(
      {
        '@dataSetInternalID': 'old',
        meanAmount: 1,
        resultingAmount: 1,
      },
      2.5,
      'new',
      true,
    ),
    {
      '@dataSetInternalID': 'new',
      meanAmount: 2.5,
      resultingAmount: 2.5,
      quantitativeReference: true,
    },
  );

  assert.throws(
    () => __testInternals.normalizeLocalRuns([], '/tmp'),
    /must contain at least one run directory/u,
  );
  assert.equal(
    (
      __testInternals.buildReferenceModelSummary({
        discovery: { reference_model_queries: ['steel chain'] },
      }) as JsonRecord
    ).reason,
    'reference model discovery is deferred in the first native CLI auto-build slice',
  );
  assert.equal(
    (
      __testInternals.buildReferenceModelSummary({
        discovery: 'bad',
      }) as JsonRecord
    ).reason,
    'reference model discovery not requested',
  );
  assert.deepEqual(__testInternals.extractFlowDatasetFromState({ flow_dataset: 'bad' }), {});
  assert.match(__testInternals.buildSelectionBrief({}), /Decision factors:/u);
});

test('lifecyclemodel auto-build helpers cover publication, record loading, ranking, and topology edge cases', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-helpers-'));

  try {
    assert.deepEqual(
      __testInternals.resolvePublicationBlock({
        administrativeInformation: {
          'common:publicationAndOwnership': { id: 'common' },
        },
      }),
      { id: 'common' },
    );
    assert.deepEqual(__testInternals.resolvePublicationBlock({}), {});

    const invalidRootPath = path.join(dir, 'invalid-root.json');
    writeJson(invalidRootPath, []);
    assert.throws(
      () => __testInternals.loadProcessRecord(invalidRootPath, 'local_run_export', dir),
      /must contain processDataSet/u,
    );

    const missingRefFlowPath = path.join(dir, 'missing-ref-flow.json');
    const missingRefFlow = createProcessPayload({
      id: 'process-missing-ref',
      referenceInternalId: '10',
      exchanges: [
        createExchange({
          internalId: '10',
          flowId: 'flow-target',
          direction: 'Output',
          meanAmount: 1,
        }),
      ],
      baseName: 'Missing ref flow',
    }) as {
      processDataSet: { processInformation: { quantitativeReference?: JsonRecord } };
    };
    delete missingRefFlow.processDataSet.processInformation.quantitativeReference;
    writeJson(missingRefFlowPath, missingRefFlow);
    assert.throws(
      () => __testInternals.loadProcessRecord(missingRefFlowPath, 'local_run_export', dir),
      /missing referenceToReferenceFlow/u,
    );

    const invalidReferenceExchangePath = path.join(dir, 'invalid-reference-exchange.json');
    const invalidReferenceExchange = createProcessPayload({
      id: 'process-invalid-ref',
      referenceInternalId: '10',
      exchanges: [{ '@dataSetInternalID': '10', exchangeDirection: 'Output', meanAmount: 1 }],
      baseName: 'Invalid ref exchange',
    });
    writeJson(invalidReferenceExchangePath, invalidReferenceExchange);
    assert.throws(
      () =>
        __testInternals.loadProcessRecord(invalidReferenceExchangePath, 'local_run_export', dir),
      /reference exchange is incomplete/u,
    );

    const missingProcessInfoPath = path.join(dir, 'missing-process-info.json');
    writeJson(missingProcessInfoPath, {
      processDataSet: {
        processInformation: 'bad',
        exchanges: {
          exchange: [
            createExchange({
              internalId: '1',
              flowId: 'flow-target',
              direction: 'Output',
              meanAmount: 1,
            }),
          ],
        },
      },
    });
    assert.throws(
      () => __testInternals.loadProcessRecord(missingProcessInfoPath, 'local_run_export', dir),
      /missing referenceToReferenceFlow/u,
    );

    const invalidDataSetInformationPath = path.join(dir, 'invalid-dataset-info.json');
    writeJson(invalidDataSetInformationPath, {
      processDataSet: {
        processInformation: {
          dataSetInformation: 'bad',
          quantitativeReference: {
            referenceToReferenceFlow: '1',
          },
        },
        exchanges: {
          exchange: [
            createExchange({
              internalId: '1',
              flowId: 'flow-target',
              direction: 'Output',
              meanAmount: 1,
            }),
          ],
        },
      },
    });
    assert.throws(
      () =>
        __testInternals.loadProcessRecord(invalidDataSetInformationPath, 'local_run_export', dir),
      /missing common:UUID/u,
    );

    const invalidExchangesPath = path.join(dir, 'invalid-exchanges.json');
    writeJson(invalidExchangesPath, {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'invalid-exchanges',
          },
          quantitativeReference: {
            referenceToReferenceFlow: '1',
          },
        },
        exchanges: 'bad',
      },
    });
    assert.throws(
      () => __testInternals.loadProcessRecord(invalidExchangesPath, 'local_run_export', dir),
      /reference exchange 1 not found/u,
    );

    const sparsePath = path.join(dir, 'sparse-valid.json');
    writeJson(sparsePath, {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'sparse-process',
          },
          quantitativeReference: {
            referenceToReferenceFlow: '1',
          },
        },
        exchanges: {
          exchange: [
            {
              '@dataSetInternalID': '1',
              exchangeDirection: 'Output',
              resultingAmount: '5',
              referenceToFlowDataSet: flowRef('flow-target', 'Target'),
            },
            {
              '@dataSetInternalID': '2',
              exchangeDirection: 'Input',
            },
          ],
        },
        administrativeInformation: {
          'common:publicationAndOwnership': {},
        },
      },
    });
    const sparseRecord = __testInternals.loadProcessRecord(sparsePath, 'local_run_export', dir);
    assert.equal(sparseRecord.version, '00.00.001');
    assert.equal(sparseRecord.referenceAmount, 5);
    assert.equal(sparseRecord.geographyCode, '');
    assert.equal(Object.keys(sparseRecord.inputAmounts).length, 0);

    const scored = __testInternals.scoreEdgeCandidate(
      {
        ...sparseRecord,
        outputAmounts: {},
        tokenSet: new Set<string>(),
        classificationPath: [],
        geographyCode: '',
      },
      {
        ...sparseRecord,
        inputAmounts: { 'flow-target': 2 },
        referenceDirection: 'Input',
      },
      'flow-target',
      2,
    );
    assert.equal(scored.confidence, 16);

    const filteredMap = {
      strong: {
        ...sparseRecord,
        processUuid: 'strong',
        referenceFlowUuid: 'flow-target',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-target': 1 },
        tokenSet: new Set(['shared', 'extra']),
        classificationPath: ['chem'],
        geographyCode: 'CN',
      },
      weak: {
        ...sparseRecord,
        processUuid: 'weak',
        referenceFlowUuid: 'flow-other',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-target': 1 },
        tokenSet: new Set<string>(),
        classificationPath: [],
        geographyCode: '',
      },
      dst: {
        ...sparseRecord,
        processUuid: 'dst',
        referenceFlowUuid: 'flow-target',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-target': 1 },
        outputAmounts: {},
        tokenSet: new Set(['shared']),
        classificationPath: ['chem'],
        geographyCode: 'CN',
      },
    };
    assert.deepEqual(
      __testInternals.inferEdges(filteredMap).map((edge) => `${edge.src}->${edge.dst}`),
      ['strong->dst'],
    );
    assert.deepEqual(
      __testInternals.inferEdges({
        lonelyConsumer: {
          ...sparseRecord,
          processUuid: 'lonelyConsumer',
          referenceFlowUuid: 'flow-orphan',
          referenceDirection: 'Input' as const,
          inputAmounts: { 'flow-orphan': 1 },
          outputAmounts: {},
        },
      }),
      [],
    );

    const orderedEdgeMap = {
      source: {
        ...sparseRecord,
        processUuid: 'source',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-a': 1, 'flow-b': 1 },
      },
      ta: {
        ...sparseRecord,
        processUuid: 'ta',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-a': 1 },
        outputAmounts: {},
      },
      tb: {
        ...sparseRecord,
        processUuid: 'tb',
        referenceFlowUuid: 'flow-b',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-b': 1 },
        outputAmounts: {},
      },
      tc: {
        ...sparseRecord,
        processUuid: 'tc',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-a': 1 },
        outputAmounts: {},
      },
    };
    assert.deepEqual(
      __testInternals
        .inferEdges(orderedEdgeMap)
        .map((edge) => `${edge.flowUuid}:${edge.src}->${edge.dst}`),
      ['flow-a:source->ta', 'flow-a:source->tc', 'flow-b:source->tb'],
    );
    const comparatorEdgeMap = {
      source: {
        ...sparseRecord,
        processUuid: 'source',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-a': 1 },
        classificationPath: ['same'],
        baseNameEn: 'same',
        baseNameZh: 'same',
      },
      dstB: {
        ...sparseRecord,
        processUuid: 'dstB',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-a': 1 },
        outputAmounts: {},
        classificationPath: ['same'],
        baseNameEn: 'same',
        baseNameZh: 'same',
      },
      dstA: {
        ...sparseRecord,
        processUuid: 'dstA',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-a': 1 },
        outputAmounts: {},
        classificationPath: ['same'],
        baseNameEn: 'same',
        baseNameZh: 'same',
      },
    };
    assert.deepEqual(
      __testInternals.inferEdges(comparatorEdgeMap).map((edge) => `${edge.src}->${edge.dst}`),
      ['source->dstA', 'source->dstB'],
    );
    const competingProducerMap = {
      srcB: {
        ...sparseRecord,
        processUuid: 'srcB',
        referenceFlowUuid: 'flow-shared',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-shared': 1 },
        classificationPath: ['same'],
        tokenSet: new Set(['same']),
      },
      srcA: {
        ...sparseRecord,
        processUuid: 'srcA',
        referenceFlowUuid: 'flow-shared',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-shared': 1 },
        classificationPath: ['same'],
        tokenSet: new Set(['same']),
      },
      dstShared: {
        ...sparseRecord,
        processUuid: 'dstShared',
        referenceFlowUuid: 'flow-shared',
        referenceDirection: 'Input' as const,
        inputAmounts: { 'flow-shared': 1 },
        outputAmounts: {},
        classificationPath: ['same'],
        tokenSet: new Set(['same']),
      },
    };
    assert.deepEqual(
      __testInternals.inferEdges(competingProducerMap).map((edge) => `${edge.src}->${edge.dst}`),
      ['srcA->dstShared', 'srcB->dstShared'],
    );

    const chooseMap = {
      alpha: {
        ...sparseRecord,
        processUuid: 'alpha',
        referenceFlowUuid: 'flow-a',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-b': 1 },
      },
      beta: {
        ...sparseRecord,
        processUuid: 'beta',
        referenceFlowUuid: 'flow-b',
        referenceDirection: 'Output' as const,
        outputAmounts: { 'flow-target': 1 },
      },
    };
    assert.equal(
      __testInternals.chooseReferenceProcess(
        chooseMap,
        [],
        { flow_summary: { uuid: 'flow-target' } },
        new Set(['alpha', 'beta']),
      ),
      'beta',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          low: {
            ...chooseMap.alpha,
            processUuid: 'low',
            outputAmounts: {},
            referenceFlowUuid: 'flow-a',
          },
          high: {
            ...chooseMap.alpha,
            processUuid: 'high',
            outputAmounts: { 'flow-z': 1 },
            referenceFlowUuid: 'flow-z',
          },
        },
        [],
        { flow_summary: { uuid: 'flow-z' } },
        new Set(['low', 'high']),
      ),
      'high',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          high: {
            ...chooseMap.alpha,
            processUuid: 'high',
            outputAmounts: { 'flow-z': 1 },
            referenceFlowUuid: 'flow-z',
          },
          low: {
            ...chooseMap.alpha,
            processUuid: 'low',
            outputAmounts: {},
            referenceFlowUuid: 'flow-a',
          },
        },
        [],
        { flow_summary: { uuid: 'flow-z' } },
        new Set(['high', 'low']),
      ),
      'high',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          targetCarrier: {
            ...chooseMap.alpha,
            processUuid: 'targetCarrier',
            referenceFlowUuid: 'flow-target',
            referenceDirection: 'Output' as const,
            outputAmounts: { 'flow-target': 1 },
          },
          targetProxy: {
            ...chooseMap.alpha,
            processUuid: 'targetProxy',
            referenceFlowUuid: 'flow-target',
            referenceDirection: 'Output' as const,
            outputAmounts: { 'flow-other': 1 },
          },
        },
        [],
        { flow_summary: { uuid: 'flow-target' } },
        new Set(['targetCarrier', 'targetProxy']),
      ),
      'targetCarrier',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(chooseMap, [], {}, new Set(['alpha', 'beta'])),
      'beta',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          indegreeWinner: {
            ...chooseMap.alpha,
            processUuid: 'indegreeWinner',
            outputAmounts: {},
          },
          indegreeLoser: {
            ...chooseMap.alpha,
            processUuid: 'indegreeLoser',
            outputAmounts: {},
          },
        },
        [
          {
            src: 'x',
            dst: 'indegreeWinner',
            flowUuid: 'f',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'y',
            dst: 'indegreeWinner',
            flowUuid: 'g',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'z',
            dst: 'indegreeLoser',
            flowUuid: 'h',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
        ],
        {},
        new Set(['indegreeWinner', 'indegreeLoser']),
      ),
      'indegreeWinner',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          nonTerminal: {
            ...chooseMap.alpha,
            processUuid: 'nonTerminal',
            outputAmounts: {},
          },
          terminal: {
            ...chooseMap.alpha,
            processUuid: 'terminal',
            outputAmounts: {},
          },
          sink: {
            ...chooseMap.alpha,
            processUuid: 'sink',
            outputAmounts: {},
          },
        },
        [
          {
            src: 'nonTerminal',
            dst: 'sink',
            flowUuid: 'f-out',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
        ],
        {},
        new Set(['nonTerminal', 'terminal']),
      ),
      'terminal',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          alphaTerminal: {
            ...chooseMap.alpha,
            processUuid: 'alphaTerminal',
            outputAmounts: {},
          },
          betaNonTerminal: {
            ...chooseMap.alpha,
            processUuid: 'betaNonTerminal',
            outputAmounts: {},
          },
          sink: {
            ...chooseMap.alpha,
            processUuid: 'sink',
            outputAmounts: {},
          },
        },
        [
          {
            src: 'betaNonTerminal',
            dst: 'sink',
            flowUuid: 'f-out',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
        ],
        {},
        new Set(['alphaTerminal', 'betaNonTerminal']),
      ),
      'alphaTerminal',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          tieA: {
            ...chooseMap.alpha,
            processUuid: 'tieA',
            outputAmounts: {},
          },
          tieB: {
            ...chooseMap.alpha,
            processUuid: 'tieB',
            outputAmounts: {},
          },
        },
        [],
        {},
        new Set(['tieA', 'tieB']),
      ),
      'tieB',
    );
    assert.equal(
      __testInternals.chooseReferenceProcess(
        {
          tieB: {
            ...chooseMap.alpha,
            processUuid: 'tieB',
            outputAmounts: {},
          },
          tieA: {
            ...chooseMap.alpha,
            processUuid: 'tieA',
            outputAmounts: {},
          },
        },
        [],
        {},
        new Set(['tieB', 'tieA']),
      ),
      'tieB',
    );

    assert.deepEqual(
      [
        ...__testInternals.collectReachable('c', [
          {
            src: 'a',
            dst: 'c',
            flowUuid: 'f',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'a',
            dst: 'c',
            flowUuid: 'f2',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'b',
            dst: 'c',
            flowUuid: 'f3',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
        ]),
      ].sort(),
      ['a', 'b', 'c'],
    );

    assert.deepEqual(
      __testInternals.topologicalOrder(new Set(['a', 'b']), [
        { src: 'a', dst: 'b', flowUuid: 'f', downstreamInputAmount: 1, confidence: 1, reasons: [] },
        { src: 'b', dst: 'a', flowUuid: 'f', downstreamInputAmount: 1, confidence: 1, reasons: [] },
        { src: 'c', dst: 'a', flowUuid: 'f', downstreamInputAmount: 1, confidence: 1, reasons: [] },
      ]),
      ['a', 'b'],
    );
    assert.deepEqual(
      __testInternals.topologicalOrder(new Set(['a', 'b', 'c']), [
        { src: 'a', dst: 'b', flowUuid: 'f', downstreamInputAmount: 1, confidence: 1, reasons: [] },
      ]),
      ['a', 'b', 'c'],
    );

    const factorMap = {
      a: {
        ...sparseRecord,
        processUuid: 'a',
        outputAmounts: { fa: 2 },
      },
      b: {
        ...sparseRecord,
        processUuid: 'b',
        outputAmounts: { fb: 0 },
      },
      c: {
        ...sparseRecord,
        processUuid: 'c',
        outputAmounts: {},
      },
      d: {
        ...sparseRecord,
        processUuid: 'd',
        outputAmounts: {},
      },
      e: {
        ...sparseRecord,
        processUuid: 'e',
        outputAmounts: { fe: 1 },
      },
    };
    assert.deepEqual(
      __testInternals.computeMultiplicationFactors(
        factorMap,
        new Set(['a', 'b', 'c', 'd']),
        [
          {
            src: 'a',
            dst: 'c',
            flowUuid: 'fa',
            downstreamInputAmount: 4,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'b',
            dst: 'c',
            flowUuid: 'fb',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'e',
            dst: 'c',
            flowUuid: 'fe',
            downstreamInputAmount: 1,
            confidence: 1,
            reasons: [],
          },
        ],
        ['a', 'b', 'd', 'c'],
        'c',
      ),
      {
        a: 2,
        b: 1,
        c: 1,
        d: 0,
      },
    );
    assert.deepEqual(
      __testInternals.computeMultiplicationFactors(
        {
          upstream: {
            ...sparseRecord,
            processUuid: 'upstream',
            outputAmounts: {},
          },
          final: {
            ...sparseRecord,
            processUuid: 'final',
            outputAmounts: {},
          },
        },
        new Set(['upstream', 'final']),
        [
          {
            src: 'upstream',
            dst: 'final',
            flowUuid: 'f1',
            downstreamInputAmount: 2,
            confidence: 1,
            reasons: [],
          },
          {
            src: 'upstream',
            dst: 'final',
            flowUuid: 'f2',
            downstreamInputAmount: 3,
            confidence: 1,
            reasons: [],
          },
        ],
        ['upstream', 'final'],
        'final',
      ),
      {
        upstream: 5,
        final: 1,
      },
    );

    const processInstanceMap = {
      p1: {
        ...sparseRecord,
        processUuid: 'p1',
        raw: createProcessPayload({
          id: 'p1',
          referenceInternalId: '1',
          exchanges: [
            createExchange({
              internalId: '1',
              flowId: 'flow-a',
              direction: 'Output',
              meanAmount: 1,
            }),
          ],
          baseName: 'Process 1',
        }),
      },
      p2: {
        ...sparseRecord,
        processUuid: 'p2',
        raw: createProcessPayload({
          id: 'p2',
          referenceInternalId: '2',
          exchanges: [
            createExchange({
              internalId: '2',
              flowId: 'flow-a',
              direction: 'Input',
              meanAmount: 1,
            }),
          ],
          baseName: 'Process 2',
        }),
      },
      p3: {
        ...sparseRecord,
        processUuid: 'p3',
        raw: createProcessPayload({
          id: 'p3',
          referenceInternalId: '3',
          exchanges: [
            createExchange({
              internalId: '3',
              flowId: 'flow-a',
              direction: 'Input',
              meanAmount: 1,
            }),
          ],
          baseName: 'Process 3',
        }),
      },
      p4: {
        ...sparseRecord,
        processUuid: 'p4',
        raw: {
          processDataSet: {
            processInformation: {},
          },
        },
      },
      p5: {
        ...sparseRecord,
        processUuid: 'p5',
        raw: {
          processDataSet: {},
        },
      },
    };
    processInstanceMap.p1.outputAmounts = { 'flow-a': 1, 'flow-b': 1 };
    const builtInstances = __testInternals.buildProcessInstances(
      processInstanceMap,
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      [
        {
          src: 'skip',
          dst: 'outside',
          flowUuid: 'flow-x',
          downstreamInputAmount: 1,
          confidence: 1,
          reasons: [],
        },
        {
          src: 'p1',
          dst: 'p2',
          flowUuid: 'flow-a',
          downstreamInputAmount: 1,
          confidence: 1,
          reasons: [],
        },
        {
          src: 'p1',
          dst: 'p3',
          flowUuid: 'flow-a',
          downstreamInputAmount: 1,
          confidence: 1,
          reasons: [],
        },
        {
          src: 'p1',
          dst: 'p4',
          flowUuid: 'flow-b',
          downstreamInputAmount: 1,
          confidence: 1,
          reasons: [],
        },
      ],
      { p1: 1, p2: 1, p3: 1, p4: 1 },
    ) as { processInstances: Array<JsonRecord> };
    const firstInstanceConnections = (builtInstances.processInstances[0]?.connections as JsonRecord)
      .outputExchange as Array<JsonRecord>;
    assert.equal(firstInstanceConnections.length, 2);
    assert.equal(Array.isArray(firstInstanceConnections[0]?.downstreamProcess), true);
    assert.equal(builtInstances.processInstances[4]?.['@multiplicationFactor'], '0');

    const sparseLifecyclemodel = __testInternals.buildLifecycleModelDataset(
      'sparse-model',
      {
        flow_dataset: {},
        flow_summary: {},
      },
      {
        sparse: {
          ...sparseRecord,
          processUuid: 'sparse',
          raw: {
            processDataSet: {
              processInformation: {
                quantitativeReference: {
                  referenceToReferenceFlow: '1',
                },
              },
              exchanges: {
                exchange: [
                  {
                    '@dataSetInternalID': '1',
                    exchangeDirection: 'Output',
                    meanAmount: 1,
                    referenceToFlowDataSet: flowRef('flow-target', 'Target'),
                  },
                ],
              },
            },
          },
        },
      },
      ['sparse'],
      [],
      { sparse: 1 },
      'sparse',
    ) as { model: JsonRecord };
    const sparseUseAdvice = (
      (
        (
          (sparseLifecyclemodel.model.lifeCycleModelDataSet as JsonRecord)
            .modellingAndValidation as JsonRecord
        ).dataSourcesTreatmentEtc as JsonRecord
      ).useAdviceForDataSet as Array<JsonRecord>
    )[0]?.['#text'];
    assert.match(String(sparseUseAdvice), /Built from local process exports/u);

    const malformedLifecyclemodel = __testInternals.buildLifecycleModelDataset(
      'malformed-model',
      {
        flow_dataset: {
          flowInformation: {
            dataSetInformation: {
              name: 'bad',
            },
          },
        },
        flow_summary: 'bad',
      },
      {
        malformed: {
          ...sparseRecord,
          processUuid: 'malformed',
          raw: {
            processDataSet: 'bad',
          },
        },
      },
      ['malformed'],
      [],
      {},
      'malformed',
    ) as { model: JsonRecord; summary: JsonRecord };
    assert.equal(
      (malformedLifecyclemodel.summary.multiplication_factors as JsonRecord).malformed as string,
      '0',
    );

    const commissionerLifecyclemodel = __testInternals.buildLifecycleModelDataset(
      'commissioner-model',
      {
        flow_dataset: {},
        flow_summary: {},
      },
      {
        commissioner: {
          ...sparseRecord,
          processUuid: 'commissioner',
          raw: {
            processDataSet: {
              administrativeInformation: {
                'common:commissionerAndGoal': {
                  'common:referenceToCommissioner': {
                    '@refObjectId': 'commissioner-ref',
                  },
                },
                dataEntryBy: {
                  'common:referenceToPersonOrEntityEnteringTheData': {
                    '@refObjectId': 'entry-ref',
                  },
                },
                'common:publicationAndOwnership': {
                  'common:referenceToOwnershipOfDataSet': {
                    '@refObjectId': 'owner-ref',
                  },
                },
              },
            },
          },
        },
      },
      ['commissioner'],
      [],
      { commissioner: 1 },
      'commissioner',
    ) as { model: JsonRecord };
    const commissionerReview = (
      (
        (
          (commissionerLifecyclemodel.model.lifeCycleModelDataSet as JsonRecord)
            .modellingAndValidation as JsonRecord
        ).validation as JsonRecord
      ).review as JsonRecord
    )['common:referenceToNameOfReviewerAndInstitution'] as JsonRecord;
    assert.equal(commissionerReview['@refObjectId'], 'commissioner-ref');

    const dataEntryLifecyclemodel = __testInternals.buildLifecycleModelDataset(
      'data-entry-model',
      {
        flow_dataset: {},
        flow_summary: {},
      },
      {
        dataEntry: {
          ...sparseRecord,
          processUuid: 'dataEntry',
          raw: {
            processDataSet: {
              administrativeInformation: {
                dataEntryBy: {
                  'common:referenceToPersonOrEntityEnteringTheData': {
                    '@refObjectId': 'entry-only-ref',
                  },
                },
              },
            },
          },
        },
      },
      ['dataEntry'],
      [],
      { dataEntry: 1 },
      'dataEntry',
    ) as { model: JsonRecord };
    const dataEntryReview = (
      (
        (
          (dataEntryLifecyclemodel.model.lifeCycleModelDataSet as JsonRecord)
            .modellingAndValidation as JsonRecord
        ).validation as JsonRecord
      ).review as JsonRecord
    )['common:referenceToNameOfReviewerAndInstitution'] as JsonRecord;
    assert.equal(dataEntryReview['@refObjectId'], 'entry-only-ref');

    const ownershipFallbackLifecyclemodel = __testInternals.buildLifecycleModelDataset(
      'ownership-fallback-model',
      {
        flow_dataset: {},
        flow_summary: {},
      },
      {
        ownershipFallback: {
          ...sparseRecord,
          processUuid: 'ownershipFallback',
          raw: {
            processDataSet: {
              administrativeInformation: {
                'common:commissionerAndGoal': 'bad',
                dataEntryBy: 'bad',
                'common:publicationAndOwnership': {
                  'common:referenceToOwnershipOfDataSet': {
                    '@refObjectId': 'owner-fallback-ref',
                  },
                },
              },
            },
          },
        },
      },
      ['ownershipFallback'],
      [],
      { ownershipFallback: 1 },
      'ownershipFallback',
    ) as { model: JsonRecord };
    const ownershipFallbackReview = (
      (
        (
          (ownershipFallbackLifecyclemodel.model.lifeCycleModelDataSet as JsonRecord)
            .modellingAndValidation as JsonRecord
        ).validation as JsonRecord
      ).review as JsonRecord
    )['common:referenceToNameOfReviewerAndInstitution'] as JsonRecord;
    assert.equal(ownershipFallbackReview['@refObjectId'], 'owner-fallback-ref');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelAutoBuild writes local lifecyclemodel artifacts and reports', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-run-'));
  const runDir = createProcessRunFixture(dir, 'process-run');
  const requestPath = path.join(dir, 'request.json');
  writeJson(requestPath, {
    local_runs: ['./process-run'],
  });

  try {
    const report = await runLifecyclemodelAutoBuild({
      inputPath: requestPath,
      outDir: './build-root',
      now: new Date('2026-03-30T01:02:03Z'),
      cwd: '/tmp/workspace',
    });

    assert.equal(report.status, 'completed_local_lifecyclemodel_auto_build_run');
    assert.equal(report.run_root, path.join(dir, 'build-root'));
    assert.equal(report.local_run_count, 1);
    assert.equal(report.built_model_count, 1);
    assert.equal(existsSync(report.files.run_plan), true);
    assert.equal(existsSync(report.files.selection_brief), true);
    assert.equal(existsSync(report.files.run_manifest), true);
    assert.equal(
      readFileSync(path.join(path.dirname(report.run_root), '.latest_run_id'), 'utf8'),
      `${report.run_id}\n`,
    );

    const runManifest = readJson<JsonRecord>(report.files.run_manifest);
    assert.deepEqual(runManifest.command, [
      'lifecyclemodel',
      'auto-build',
      '--input',
      requestPath,
      '--out-dir',
      './build-root',
    ]);
    assert.equal(runManifest.cwd, '/tmp/workspace');

    const runPlan = readJson<JsonRecord>(report.files.run_plan);
    assert.deepEqual(runPlan.local_runs, [runDir]);
    const localBuildReports = runPlan.local_build_reports as Array<JsonRecord>;
    assert.equal(localBuildReports.length, 1);

    const localBuild = report.local_build_reports[0];
    assert.ok(localBuild);
    assert.equal(localBuild?.run_name, 'process-run');
    assert.equal(existsSync(localBuild?.model_file ?? ''), true);

    const model = readJson<JsonRecord>(localBuild?.model_file ?? '');
    const dataset = model.lifeCycleModelDataSet as JsonRecord;
    const info = dataset.lifeCycleModelInformation as JsonRecord;
    const dataSetInformation = info.dataSetInformation as JsonRecord;
    const quantitativeReference = info.quantitativeReference as JsonRecord;
    const technology = info.technology as JsonRecord;
    const processes = technology.processes as JsonRecord;
    const processInstances = processes.processInstance as Array<JsonRecord>;

    assert.equal(quantitativeReference.referenceToReferenceProcess, '2');
    assert.equal(
      (dataSetInformation.referenceToResultingProcess as JsonRecord)['@refObjectId'],
      (localBuild?.summary.model_uuid as string | undefined) ?? '',
    );
    assert.equal(processInstances.length, 2);
    assert.equal(processInstances[0]?.['@multiplicationFactor'], '2');
    assert.equal(processInstances[1]?.['@multiplicationFactor'], '1');

    const connections = readJson<Array<JsonRecord>>(localBuild?.connections_file ?? '');
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.flow_uuid, 'flow-intermediate');
    assert.equal(connections[0]?.src, 'process-upstream');
    assert.equal(connections[0]?.dst, 'process-downstream');

    const summary = readJson<JsonRecord>(localBuild?.summary_file ?? '');
    assert.equal(summary.reference_process_uuid, 'process-downstream');
    assert.equal((summary.multiplication_factors as JsonRecord)['process-upstream'], '2');
    assert.equal((summary.multiplication_factors as JsonRecord)['process-downstream'], '1');

    const processCatalog = readJson<Array<JsonRecord>>(localBuild?.process_catalog_file ?? '');
    assert.equal(processCatalog.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel auto-build rejects inherited non-English name semicolons before model output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-name-'));
  const runDir = createProcessRunFixture(dir, 'process-run');
  const statePath = path.join(runDir, 'cache', 'process_from_flow_state.json');
  const state = readJson<JsonRecord>(statePath);
  const wrapped = state.flow_dataset as JsonRecord;
  const flow = wrapped.flowDataSet as JsonRecord;
  const info = flow.flowInformation as JsonRecord;
  const datasetInfo = info.dataSetInformation as JsonRecord;
  const name = datasetInfo.name as JsonRecord;
  name.treatmentStandardsRoutes = [textItem('Storage route'), textItem('储能；固定式', 'zh')];
  writeJson(statePath, state);
  const requestPath = path.join(dir, 'request.json');
  writeJson(requestPath, { local_runs: ['./process-run'] });

  try {
    await assert.rejects(
      runLifecyclemodelAutoBuild({ inputPath: requestPath, outDir: './build-root' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code: string }).code,
          'LIFECYCLEMODEL_AUTO_BUILD_NAME_INVALID',
        );
        assert.match(error.message, /commas instead of semicolons/u);
        return true;
      },
    );
    assert.equal(existsSync(path.join(dir, 'build-root', 'models', 'process-run')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel auto-build internals can assemble a single-process lifecyclemodel', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-single-'));
  const runDir = createProcessRunFixture(dir, 'single-run', {
    wrapFlowDataset: false,
    singleProcess: true,
  });

  try {
    const record = __testInternals.loadProcessRecord(
      path.join(runDir, 'exports', 'processes', 'single.json'),
      'local_run_export',
      runDir,
    );
    const { model, summary } = __testInternals.buildLifecycleModelDataset(
      'demo-run',
      readJson<JsonRecord>(path.join(runDir, 'cache', 'process_from_flow_state.json')),
      { [record.processUuid]: record },
      [record.processUuid],
      [],
      { [record.processUuid]: 1 },
      record.processUuid,
    ) as {
      model: JsonRecord;
      summary: JsonRecord;
    };

    assert.equal(summary.model_uuid, 'd39a4235-99d7-5cb9-af5c-849a602563b0');
    const processInstance = (
      (
        ((model.lifeCycleModelDataSet as JsonRecord).lifeCycleModelInformation as JsonRecord)
          .technology as JsonRecord
      ).processes as JsonRecord
    ).processInstance as JsonRecord;
    assert.equal(processInstance['@dataSetInternalID'], '1');
    assert.equal('connections' in processInstance, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelAutoBuild rejects invalid manifests and broken local runs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-errors-'));
  const requestPath = path.join(dir, 'request.json');

  try {
    assert.throws(
      () =>
        normalizeLifecyclemodelAutoBuildRequest('bad', {
          inputPath: requestPath,
        }),
      /must be a JSON object/u,
    );

    assert.throws(
      () =>
        normalizeLifecyclemodelAutoBuildRequest(
          {
            local_runs: ['./run-1'],
            allow_remote_write: true,
          },
          {
            inputPath: requestPath,
          },
        ),
      /allow_remote_write=true/u,
    );

    writeJson(requestPath, {
      out_dir: './missing-state-root',
      local_runs: ['./missing-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /missing state file/u,
    );

    const noExportsRun = path.join(dir, 'no-exports-run');
    mkdirSync(path.join(noExportsRun, 'cache'), { recursive: true });
    writeJson(path.join(noExportsRun, 'cache', 'process_from_flow_state.json'), {
      flow_summary: { uuid: 'flow-target' },
      flow_dataset: {},
    });
    writeJson(requestPath, {
      out_dir: './no-exports-root',
      local_runs: ['./no-exports-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /missing exported processes/u,
    );

    const emptyRun = path.join(dir, 'empty-run');
    mkdirSync(path.join(emptyRun, 'cache'), { recursive: true });
    mkdirSync(path.join(emptyRun, 'exports', 'processes'), { recursive: true });
    writeJson(path.join(emptyRun, 'cache', 'process_from_flow_state.json'), {
      flow_summary: { uuid: 'flow-target' },
      flow_dataset: {},
    });
    writeJson(requestPath, {
      out_dir: './empty-run-root',
      local_runs: ['./empty-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /has no exported process JSON files/u,
    );

    createProcessRunFixture(dir, 'bad-reference-run', {
      badProcess: 'missing_reference_exchange',
    });
    writeJson(requestPath, {
      out_dir: './bad-reference-root',
      local_runs: ['./bad-reference-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /reference exchange 999 not found/u,
    );

    createProcessRunFixture(dir, 'bad-uuid-run', {
      badProcess: 'missing_uuid',
    });
    writeJson(requestPath, {
      out_dir: './bad-uuid-root',
      local_runs: ['./bad-uuid-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /missing common:UUID/u,
    );

    const invalidStateRun = path.join(dir, 'invalid-state-run');
    mkdirSync(path.join(invalidStateRun, 'cache'), { recursive: true });
    mkdirSync(path.join(invalidStateRun, 'exports', 'processes'), { recursive: true });
    writeJson(path.join(invalidStateRun, 'cache', 'process_from_flow_state.json'), []);
    writeJson(
      path.join(invalidStateRun, 'exports', 'processes', 'single.json'),
      createProcessPayload({
        id: 'single',
        referenceInternalId: '1',
        exchanges: [
          createExchange({
            internalId: '1',
            flowId: 'flow-target',
            direction: 'Output',
            meanAmount: 1,
          }),
        ],
        baseName: 'Single',
      }),
    );
    writeJson(requestPath, {
      out_dir: './invalid-state-root',
      local_runs: ['./invalid-state-run'],
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /state must be a JSON object/u,
    );

    const existingRoot = path.join(dir, 'busy-root');
    mkdirSync(existingRoot, { recursive: true });
    writeFileSync(path.join(existingRoot, 'keep.txt'), 'busy', 'utf8');
    createProcessRunFixture(dir, 'good-run');
    writeJson(requestPath, {
      local_runs: ['./good-run'],
      out_dir: './busy-root',
    });
    await assert.rejects(
      () =>
        runLifecyclemodelAutoBuild({
          inputPath: requestPath,
        }),
      /run root already exists and is not empty/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
