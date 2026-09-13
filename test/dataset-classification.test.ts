import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FlowElementaryCategorySchema } from '@tiangong-lca/tidas-sdk/schemas';
import { resolveRuntimeAssetDir } from '@tiangong-lca/tidas-sdk/tools';
import { executeCli } from '../src/cli.js';
import {
  __testInternals,
  resolveTidasClassificationPath,
  runDatasetClassificationApply,
  runDatasetClassificationAudit,
  runDatasetClassificationChildren,
  runDatasetClassificationPath,
} from '../src/lib/dataset-classification.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

function makeDeps(overrides = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    dotEnvStatus,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    }),
    ...overrides,
  };
}

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

function sampleProcessRow() {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': 'process-1',
          name: {
            baseName: {
              '@xml:lang': 'en',
              '#text': 'Fava beans IP, at feed mill',
            },
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                {
                  '@level': '0',
                  '@classId': 'S',
                  '#text': 'Other service activities',
                },
              ],
            },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
        },
      },
    },
  };
}

function sampleProcessRowWithLocations() {
  const row = sampleProcessRow();
  return {
    processDataSet: {
      ...row.processDataSet,
      processInformation: {
        ...row.processDataSet.processInformation,
        geography: {
          locationOfOperationSupplyOrProduction: {
            '@location': 'RER',
          },
        },
      },
      exchanges: {
        exchange: [
          {
            '@dataSetInternalID': 1,
            location: 'Not a TIDAS code',
          },
        ],
      },
    },
  };
}

function sampleFlowRowWithoutLocation() {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': 'flow-1',
          name: {
            baseName: {
              '@xml:lang': 'en',
              '#text': 'Fixture product flow',
            },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
        },
      },
    },
  };
}

function sampleLifecyclemodelRowWithLocation() {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': 'lifecyclemodel-1',
          name: {
            baseName: {
              '@xml:lang': 'en',
              '#text': 'Lifecycle model fixture',
            },
          },
        },
        technology: {
          processes: {
            processInstance: {
              connections: {
                outputExchange: {
                  downstreamProcess: {
                    '@location': 'Invalid lifecycle region',
                  },
                },
              },
            },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '01.00.000',
        },
      },
    },
  };
}

test('dataset classification children and path navigate bundled TIDAS category schemas', async () => {
  const topLevel = await runDatasetClassificationChildren({
    type: 'process',
    limit: 3,
    now: new Date('2026-06-02T00:00:00.000Z'),
  });
  assert.equal(topLevel.status, 'completed');
  assert.equal(topLevel.children[0]?.code, 'A');
  assert.equal(topLevel.children[0]?.text, 'Agriculture, forestry and fishing');

  const processChildren = await runDatasetClassificationChildren({
    type: 'process',
    parent: 'A',
    limit: 2,
    now: new Date('2026-06-02T00:00:00.000Z'),
  });
  assert.equal(processChildren.children[0]?.code, '01');
  assert.equal(processChildren.children[0]?.path.length, 2);

  const pathReport = await runDatasetClassificationPath({
    type: 'process',
    code: '1080',
    now: new Date('2026-06-02T00:00:00.000Z'),
  });
  assert.equal(pathReport.status, 'completed');
  assert.deepEqual(
    pathReport.path.map((entry) => entry['#text']),
    [
      'Manufacturing',
      'Manufacture of food products',
      'Manufacture of prepared animal feeds',
      'Manufacture of prepared animal feeds',
    ],
  );

  const sourceCategories = await runDatasetClassificationChildren({
    type: 'source',
    limit: 3,
    now: new Date('2026-06-02T00:00:00.000Z'),
  });
  assert.deepEqual(
    sourceCategories.children.map((entry) => entry.text),
    ['Images', 'Data set formats', 'Databases'],
  );
});

test('Flow and Process classification use the complete locked SDK 0.2.0 catalogs', () => {
  const expected = [
    {
      type: 'flow-product' as const,
      count: 4_586,
      sha256: 'd043a6028e1f27b0c74da332ed6db9971fd06662d1b1746ee2f2d5ecb31ff585',
    },
    {
      type: 'process' as const,
      count: 830,
      sha256: '975f22599cbe050ee271fb48b4615d32c1b2ce78772a9c550d5f4771635c1842',
    },
    {
      type: 'flow-elementary' as const,
      count: 65,
      sha256: 'ef864c18fa7cead938e5c99184c3f7356f14dee1e42810750ef6e62f2bed47e7',
    },
  ];

  for (const snapshot of expected) {
    const { config, schema, entries } = __testInternals.loadEntries(snapshot.type);
    const sdkSchema = path.join(resolveRuntimeAssetDir('tidas'), 'schemas', config.schemaFile);
    assert.equal(schema, sdkSchema);
    const sdkEntries: typeof entries = [];
    __testInternals.collectEntriesFromNode(
      JSON.parse(readFileSync(sdkSchema, 'utf8')),
      config.defaultValueKey,
      sdkEntries,
    );
    const membership = (items: typeof entries) =>
      items.map((entry) => JSON.stringify(entry)).sort();
    assert.deepEqual(membership(entries), membership(sdkEntries));
    const navigator = __testInternals.buildNavigator(entries);
    const canonicalRows = entries
      .map((entry) => {
        const parent = navigator.parentMap.get(entry.code);
        return [String(entry.level), entry.code, entry.text, parent?.code ?? ''].join('\t');
      })
      .sort();
    const fingerprint = createHash('sha256').update(canonicalRows.join('\n')).digest('hex');
    assert.equal(entries.length, snapshot.count, `${snapshot.type} entry count drifted`);
    assert.equal(fingerprint, snapshot.sha256, `${snapshot.type} catalog fingerprint drifted`);
  }
});

test('classification catalog resolution fails closed when SDK assets are unavailable', () => {
  const { config } = __testInternals.loadEntries('flow-elementary');
  const assertUnavailable = (resolveAssets: () => string) =>
    assert.throws(() => __testInternals.schemaPath(config, resolveAssets), {
      code: 'TIDAS_CLASSIFICATION_SDK_SCHEMA_UNAVAILABLE',
      exitCode: 2,
      details: {
        category_type: 'flow-elementary',
        schema_file: 'tidas_flows_elementary_category.json',
      },
    });
  assertUnavailable(() => {
    throw new Error('SDK runtime assets unavailable');
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-missing-sdk-catalog-'));
  try {
    assertUnavailable(() => dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('elementary navigation is independent of SDK oneOf order', () => {
  const { entries } = __testInternals.loadEntries('flow-elementary');
  const reordered = __testInternals.orderCatalogEntries('flow-elementary', [...entries].reverse());
  assert.deepEqual(reordered, entries);
  const navigator = __testInternals.buildNavigator(reordered);
  assert.deepEqual(
    __testInternals.pathForCode(navigator, '1.3.10').map((entry) => entry.code),
    ['1', '1.3', '1.3.10'],
  );
  assert.ok(
    reordered.findIndex((entry) => entry.code === '1.3.2') <
      reordered.findIndex((entry) => entry.code === '1.3.10'),
  );
});

test('elementary catalog preserves SDK membership and dotted parent paths for every category', () => {
  const { entries } = __testInternals.loadEntries('flow-elementary');
  const navigator = __testInternals.buildNavigator(entries);
  for (const entry of entries) {
    const expectedParent = entry.code.includes('.')
      ? entry.code.slice(0, entry.code.lastIndexOf('.'))
      : null;
    assert.equal(navigator.parentMap.get(entry.code)?.code ?? null, expectedParent, entry.code);
    assert.equal(
      FlowElementaryCategorySchema.safeParse(__testInternals.toPathEntry(entry)).success,
      true,
      entry.code,
    );
    const canonicalPath = __testInternals
      .pathForCode(navigator, entry.code)
      .map(__testInternals.toPathEntry);
    assert.deepEqual(
      resolveTidasClassificationPath('flow-elementary', canonicalPath),
      canonicalPath,
    );
  }
});

test('classification authoring resolves complete legacy labels without inventing catalog IDs', () => {
  const labels = [
    'Manufacturing',
    'Manufacture of food products',
    'Manufacture of prepared animal feeds',
    'Manufacture of prepared animal feeds',
  ];
  const expected = [
    { '@level': '0', '@classId': 'C', '#text': labels[0] },
    { '@level': '1', '@classId': '10', '#text': labels[1] },
    { '@level': '2', '@classId': '108', '#text': labels[2] },
    { '@level': '3', '@classId': '1080', '#text': labels[3] },
  ];
  assert.deepEqual(resolveTidasClassificationPath('process', labels), expected);
  assert.deepEqual(
    resolveTidasClassificationPath('process', [
      '  ＭＡＮＵＦＡＣＴＵＲＩＮＧ ',
      'manufacture  of\tfood products',
      ...labels.slice(2),
    ]),
    expected,
  );
  assert.deepEqual(
    resolveTidasClassificationPath(
      'process',
      expected.map((entry) => ({ '@classId': entry['@classId'] })),
    ),
    expected,
  );
});

test('classification authoring rejects incomplete, mixed and unknown legacy label paths', () => {
  const cases: Array<{ input: unknown; code: string }> = [
    { input: null, code: 'TIDAS_CLASSIFICATION_PATH_REQUIRED' },
    { input: [], code: 'TIDAS_CLASSIFICATION_PATH_REQUIRED' },
    {
      input: ['Manufacturing', { '@classId': '10' }],
      code: 'TIDAS_CLASSIFICATION_PATH_MIXED',
    },
    { input: [' \t '], code: 'TIDAS_CLASSIFICATION_PATH_LABEL_INVALID' },
    {
      input: ['Manufacture of food products'],
      code: 'TIDAS_CLASSIFICATION_PATH_UNKNOWN',
    },
    {
      input: ['Manufacturing', 'An invented process category'],
      code: 'TIDAS_CLASSIFICATION_PATH_UNKNOWN',
    },
    { input: [{ '#text': 'Manufacturing' }], code: 'TIDAS_CLASSIFICATION_ID_REQUIRED' },
  ];
  for (const { input, code } of cases) {
    assert.throws(() => resolveTidasClassificationPath('process', input), {
      code,
      exitCode: 2,
    });
  }
});

test('explicit classification IDs cannot bypass parent edges, levels or catalog labels', () => {
  const canonical = [
    { '@level': '0', '@classId': 'C', '#text': 'Manufacturing' },
    { '@level': '1', '@classId': '10', '#text': 'Manufacture of food products' },
    { '@level': '2', '@classId': '108', '#text': 'Manufacture of prepared animal feeds' },
    { '@level': '3', '@classId': '1080', '#text': 'Manufacture of prepared animal feeds' },
  ];
  for (const invalid of [
    canonical.slice(1),
    [canonical[0], canonical[2], canonical[3]],
    [{ '@classId': 'A' }, ...canonical.slice(1)],
    [...canonical.slice(0, 3), { '@classId': 'unknown-id' }],
  ]) {
    assert.throws(() => resolveTidasClassificationPath('process', invalid), {
      code: 'TIDAS_CLASSIFICATION_PATH_INVALID',
      exitCode: 2,
    });
  }
  assert.throws(
    () =>
      resolveTidasClassificationPath('process', [
        { ...canonical[0], '@level': '1' },
        ...canonical.slice(1),
      ]),
    { code: 'TIDAS_CLASSIFICATION_LEVEL_MISMATCH', exitCode: 2 },
  );
  assert.throws(
    () =>
      resolveTidasClassificationPath('process', [
        canonical[0],
        { ...canonical[1], '#text': 'Manufacture of fabricated metal products' },
        ...canonical.slice(2),
      ]),
    { code: 'TIDAS_CLASSIFICATION_LABEL_MISMATCH', exitCode: 2 },
  );
});

test('colliding complete catalog labels require exact IDs instead of choosing the first match', () => {
  const { config } = __testInternals.loadEntries('process');
  const entries = [
    { level: 0, code: 'A', text: 'Transport', value_key: '@classId' as const },
    { level: 1, code: 'A1', text: 'Freight', value_key: '@classId' as const },
    { level: 0, code: 'B', text: 'Transport', value_key: '@classId' as const },
    { level: 1, code: 'B1', text: 'Freight', value_key: '@classId' as const },
  ];
  const catalog = { config, navigator: __testInternals.buildNavigator(entries) };
  assert.throws(
    () =>
      __testInternals.resolveClassificationPathAgainstCatalog(
        'process',
        ['Transport', 'Freight'],
        catalog,
      ),
    {
      code: 'TIDAS_CLASSIFICATION_PATH_AMBIGUOUS',
      exitCode: 2,
      details: {
        category_type: 'process',
        schema_file: config.schemaFile,
        labels: ['Transport', 'Freight'],
        matching_leaf_codes: ['A1', 'B1'],
      },
    },
  );
  assert.deepEqual(
    __testInternals.resolveClassificationPathAgainstCatalog(
      'process',
      [{ '@classId': 'B' }, { '@classId': 'B1' }],
      catalog,
    ),
    [
      { '@level': '0', '@classId': 'B', '#text': 'Transport' },
      { '@level': '1', '@classId': 'B1', '#text': 'Freight' },
    ],
  );
});

test('dataset classification apply normalizes decisions against schema and writes evidence', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-classification-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const decisionsPath = path.join(dir, 'decisions.jsonl');
  const outPath = path.join(dir, 'processes.classified.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJsonl(decisionsPath, [
    {
      row_index: 0,
      code: '1080',
      basis: 'The process name says at feed mill.',
      evidence: {
        source: 'classification-authoring-queue',
      },
    },
  ]);

  try {
    const report = await runDatasetClassificationApply({
      inputPath,
      decisionsPath,
      outPath,
      outDir,
      type: 'process',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.counts.applied, 1);
    assert.equal(existsSync(report.files.evidence), true);
    assert.deepEqual(readJson(report.files.report), report);
    const rows = readJsonl(outPath) as Array<ReturnType<typeof sampleProcessRow>>;
    const classes =
      rows[0]?.processDataSet.processInformation.dataSetInformation.classificationInformation[
        'common:classification'
      ]['common:class'];
    assert.equal(classes.at(-1)?.['@classId'], '1080');
    assert.equal(classes.at(-1)?.['#text'], 'Manufacture of prepared animal feeds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset classification audit and apply enforce TIDAS location codes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-location-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const decisionsPath = path.join(dir, 'location-decisions.jsonl');
  const outPath = path.join(dir, 'processes.location.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [sampleProcessRowWithLocations()]);
  writeJsonl(decisionsPath, [
    {
      row_index: 0,
      category_type: 'location',
      code: 'GR',
      target_path:
        'processDataSet.processInformation.geography.locationOfOperationSupplyOrProduction.@location',
      basis: 'The source trace says the represented geography is GR.',
    },
  ]);

  try {
    const audit = await runDatasetClassificationAudit({
      inputPath,
      type: 'location',
      outDir,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(audit.status, 'blocked');
    assert.equal(audit.counts.location_targets, 2);
    assert.equal(audit.counts.valid, 1);
    assert.equal(audit.counts.invalid, 1);
    assert.equal(audit.findings.find((finding) => finding.value === 'RER')?.description, 'Europe');
    assert.equal(existsSync(audit.files?.findings ?? ''), true);

    const report = await runDatasetClassificationApply({
      inputPath,
      decisionsPath,
      outPath,
      outDir,
      type: 'location',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.applied, 1);
    const rows = readJsonl(outPath) as Array<ReturnType<typeof sampleProcessRowWithLocations>>;
    assert.equal(
      rows[0]?.processDataSet.processInformation.geography.locationOfOperationSupplyOrProduction[
        '@location'
      ],
      'GR',
    );
    assert.equal(rows[0]?.processDataSet.exchanges.exchange[0]?.location, 'Not a TIDAS code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset classification location apply creates missing location target when target_path is explicit', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-location-create-'));
  const inputPath = path.join(dir, 'flows.jsonl');
  const decisionsPath = path.join(dir, 'location-decisions.jsonl');
  const outPath = path.join(dir, 'flows.location.jsonl');
  writeJsonl(inputPath, [sampleFlowRowWithoutLocation()]);
  writeJsonl(decisionsPath, [
    {
      dataset_id: 'flow-1',
      dataset_version: '00.00.001',
      category_type: 'location',
      code: 'CH',
      target_path: 'flowDataSet.flowInformation.geography.locationOfSupply',
      basis: 'The source name mix/location field identifies Switzerland.',
    },
  ]);

  try {
    const report = await runDatasetClassificationApply({
      inputPath,
      decisionsPath,
      outPath,
      type: 'location',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.applied, 1);
    const rows = readJsonl(outPath);
    const flow = rows[0] as {
      flowDataSet?: { flowInformation?: { geography?: { locationOfSupply?: string } } };
    };
    assert.equal(flow.flowDataSet?.flowInformation?.geography?.locationOfSupply, 'CH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset classification location apply targets lifecyclemodel rows by UUID and version', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-location-lifecyclemodel-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  const decisionsPath = path.join(dir, 'location-decisions.jsonl');
  const outPath = path.join(dir, 'lifecyclemodels.location.jsonl');
  const outDir = path.join(dir, 'out');
  const targetPath =
    'lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance.connections.outputExchange.downstreamProcess.@location';
  writeJsonl(inputPath, [sampleLifecyclemodelRowWithLocation()]);
  writeJsonl(decisionsPath, [
    {
      dataset_id: 'lifecyclemodel-1',
      dataset_version: '01.00.000',
      category_type: 'location',
      code: 'CH',
      target_path: targetPath,
      basis: 'The lifecycle model connection is represented in Switzerland.',
    },
  ]);

  try {
    const audit = await runDatasetClassificationAudit({
      inputPath,
      type: 'location',
      outDir,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(audit.status, 'blocked');
    assert.equal(audit.counts.location_targets, 1);
    assert.equal(audit.counts.invalid, 1);
    assert.equal(audit.findings[0]?.dataset_id, 'lifecyclemodel-1');
    assert.equal(audit.findings[0]?.dataset_version, '01.00.000');
    assert.equal(audit.findings[0]?.path, targetPath);

    const report = await runDatasetClassificationApply({
      inputPath,
      decisionsPath,
      outPath,
      outDir,
      type: 'location',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.applied, 1);
    const rows = readJsonl(outPath) as Array<
      ReturnType<typeof sampleLifecyclemodelRowWithLocation>
    >;
    assert.equal(
      rows[0]?.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance
        .connections.outputExchange.downstreamProcess['@location'],
      'CH',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset classification internals cover schema navigation and decision normalization', () => {
  assert.equal(__testInternals.normalizeType('Flow Elementary'), 'flow-elementary');
  assert.equal(__testInternals.normalizeType('product_flows'), 'flow-product');
  assert.throws(
    () => __testInternals.normalizeType('bad-kind'),
    /Unsupported classification type/u,
  );
  assert.throws(
    () => __testInternals.schemasDir([path.join(os.tmpdir(), 'missing-tidas-schemas')]),
    /Bundled TIDAS schemas/u,
  );

  const entries: Array<{ level: number; code: string; text: string; value_key: '@classId' }> = [];
  __testInternals.collectEntriesFromNode(
    [
      {
        properties: {
          '@level': { const: '0' },
          '@classId': { const: 'A' },
          '#text': { const: 'Root' },
        },
      },
      {
        properties: {
          '@level': { const: '1' },
          '@classId': { const: 'A1' },
          '#text': { const: 'Child' },
        },
      },
      { const: 'LOC', description: 'Location' },
    ],
    '@classId',
    entries,
  );
  const navigator = __testInternals.buildNavigator(entries);
  assert.deepEqual(
    __testInternals.pathForCode(navigator, 'A1').map((entry) => entry.code),
    ['A', 'A1'],
  );
  assert.deepEqual(__testInternals.pathForCode(navigator, 'missing'), []);
  assert.deepEqual(__testInternals.toPathEntry(entries[0]!), {
    '@level': '0',
    '@classId': 'A',
    '#text': 'Root',
  });
  assert.equal(__testInternals.classCode({ classId: 'class-id' }), 'class-id');
  assert.equal(__testInternals.classCode(null), null);
  assert.equal(__testInternals.constText({ const: '42' }), '42');
  assert.equal(__testInternals.constText({ const: 42 }), null);
  assert.equal(
    __testInternals.lastSchemaPropertyName(['properties', 'location', '$ref']),
    'location',
  );
  const locationKeys = new Set<string>();
  __testInternals.collectLocationRefKeysFromSchema(
    { properties: { customLocation: { $ref: 'tidas_locations_category.json' } } },
    [],
    locationKeys,
  );
  assert.equal(locationKeys.has('customLocation'), true);

  assert.equal(__testInternals.normalizeTargetPath('/a~1b/c~0d'), 'a/b.c~d');
  assert.equal(__testInternals.decisionTargetPath({ jsonPointer: '/x/y' }), 'x.y');
  assert.deepEqual(__testInternals.normalizeStructuredDecisions({ rows: [{ a: 1 }, 2] }), [
    { a: 1 },
  ]);
  assert.deepEqual(__testInternals.normalizeStructuredDecisions('bad'), []);
  const blockers: Array<{ code: string }> = [];
  assert.equal(__testInternals.normalizeDecision({}, 0, null, blockers as never), null);
  assert.equal(blockers[0]?.code, 'classification_decision_target_missing');
  const typeBlockers: Array<{ code: string }> = [];
  assert.equal(
    __testInternals.normalizeDecision(
      { row_index: 0, code: '1080' },
      0,
      null,
      typeBlockers as never,
    ),
    null,
  );
  assert.equal(typeBlockers[0]?.code, 'classification_decision_type_missing');
  const pathBlockers: Array<{ code: string }> = [];
  assert.equal(
    __testInternals.normalizeDecision(
      { row_index: 0, category_type: 'process', code: 'missing-code' },
      0,
      null,
      pathBlockers as never,
    ),
    null,
  );
  assert.equal(pathBlockers[0]?.code, 'classification_decision_path_invalid');
});

test('dataset classification internals cover rows, containers, and location targets', () => {
  const rows = __testInternals.prepareRows('memory', { rows: [sampleProcessRowWithLocations()] });
  const processRow = rows[0]!;
  assert.equal(processRow.id, 'process-1');
  assert.equal(__testInternals.currentClassification(processRow, 'process') !== null, true);
  const processPath = __testInternals.normalizePathFromDecision('process', { code: '1080' });
  assert.equal(__testInternals.setClassification(processRow, 'process', processPath), true);
  assert.deepEqual(__testInternals.currentClassification(processRow, 'process'), processPath);
  const elementaryContainer = __testInternals.classificationContainer(
    __testInternals.prepareRows('memory', {
      rows: [
        {
          flowDataSet: {
            flowInformation: { dataSetInformation: {} },
          },
        },
      ],
    })[0]!,
    'flow-elementary',
  );
  assert.equal(Boolean(elementaryContainer), true);
  assert.equal(
    __testInternals.setClassification(
      { ...processRow, rootKey: null, informationKey: null },
      'process',
      processPath,
    ),
    false,
  );
  assert.deepEqual(__testInternals.locationTargetStringValue(' RER '), {
    parent: null,
    key: null,
    pathSuffix: [],
    value: 'RER',
  });
  assert.deepEqual(__testInternals.locationTargetStringValue({ '#text': ' US ' }), {
    parent: { '#text': ' US ' },
    key: '#text',
    pathSuffix: ['#text'],
    value: 'US',
  });
  assert.equal(__testInternals.locationTargetStringValue({ value: 'US' }), null);
  const targets = __testInternals.collectLocationTargets(sampleProcessRowWithLocations());
  assert.equal(
    targets.some((target) => target.path.endsWith('@location')),
    true,
  );
  assert.equal(
    __testInternals.resolveLocationTarget(processRow, {
      targetPath:
        'processDataSet.processInformation.geography.locationOfOperationSupplyOrProduction.@location',
    } as never).length,
    1,
  );
  assert.deepEqual(__testInternals.targetPathSegments(' flowDataSet..location '), [
    'flowDataSet',
    'location',
  ]);
  const missingFlowRow = __testInternals.prepareRows('memory', {
    rows: [sampleFlowRowWithoutLocation()],
  })[0]!;
  const createdTarget = __testInternals.createMissingLocationTarget(
    missingFlowRow,
    'flowDataSet.flowInformation.geography.locationOfSupply',
  );
  assert.equal(createdTarget?.parentPath, 'flowDataSet.flowInformation.geography');
  assert.equal(createdTarget?.key, 'locationOfSupply');
  createdTarget!.parent[createdTarget!.key] = 'CH';
  assert.equal(
    (
      missingFlowRow.payload.flowDataSet as {
        flowInformation: { geography: { locationOfSupply: string } };
      }
    ).flowInformation.geography.locationOfSupply,
    'CH',
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: {} },
      'notALocationField',
    ),
    null,
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: null } as never,
      'parent.location',
    ),
    null,
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: { parent: 'bad' } },
      'parent.location',
    ),
    null,
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: null } as never,
      'location',
    ),
    null,
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: { location: 'CH' } },
      'location',
    ),
    null,
  );
  assert.equal(
    __testInternals.createMissingLocationTarget(
      { ...missingFlowRow, payload: { location: '' } },
      'location',
    )?.value,
    '',
  );
  assert.equal(
    __testInternals.resolveLocationTarget(missingFlowRow, {
      targetPath: 'flowDataSet.flowInformation.notALocationField',
    } as never).length,
    0,
  );
  assert.equal(
    __testInternals.decisionMatchesRow(
      { rowIndex: 0, datasetId: null, datasetVersion: null } as never,
      processRow,
    ),
    true,
  );
  assert.equal(
    __testInternals.decisionMatchesRow(
      { rowIndex: null, datasetId: 'process-1', datasetVersion: 'bad' } as never,
      processRow,
    ),
    false,
  );
  assert.equal(__testInternals.locationCodeFromPath(processPath), '1080');
});

test('dataset classification commands cover blocked branches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-classification-blocks-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const decisionsPath = path.join(dir, 'decisions.jsonl');
  const outPath = path.join(dir, 'classified.jsonl');
  writeJsonl(inputPath, [sampleProcessRow(), sampleProcessRow()]);
  writeJsonl(decisionsPath, [
    { dataset_id: 'process-1', category_type: 'process', code: '1080' },
    { row_index: 0, category_type: 'location', code: 'RER' },
    {
      row_index: 0,
      category_type: 'location',
      code: 'RER',
      target_path: 'missing.location',
    },
  ]);
  try {
    const queried = await runDatasetClassificationChildren({
      type: 'process',
      parent: 'A',
      query: 'crop',
      limit: 1,
    });
    assert.equal(queried.counts.returned <= 1, true);
    const unknownParent = await runDatasetClassificationChildren({
      type: 'process',
      parent: 'missing',
    });
    assert.equal(unknownParent.status, 'blocked');
    const unknownPath = await runDatasetClassificationPath({ type: 'process', code: 'missing' });
    assert.equal(unknownPath.status, 'blocked');
    await assert.rejects(
      () => runDatasetClassificationPath({ type: 'process', code: '' }),
      /Missing required --code/u,
    );
    await assert.rejects(
      () => runDatasetClassificationAudit({ type: 'process', inputPath, rawInput: [] }),
      /supports only --type location/u,
    );
    await assert.rejects(
      () => runDatasetClassificationAudit({ type: 'location', inputPath: '', rawInput: [] }),
      /Missing required --input/u,
    );
    await assert.rejects(
      () => runDatasetClassificationApply({ inputPath: '', decisionsPath, outPath }),
      /Missing required --input/u,
    );
    await assert.rejects(
      () => runDatasetClassificationApply({ inputPath, decisionsPath, outPath: '' }),
      /Missing required --out/u,
    );
    await assert.rejects(
      () => runDatasetClassificationApply({ inputPath, decisionsPath: '', outPath }),
      /Missing required --decisions/u,
    );
    await assert.rejects(
      () =>
        runDatasetClassificationApply({
          inputPath,
          decisionsPath: path.join(dir, 'missing.json'),
          outPath,
        }),
      /decisions file not found/u,
    );

    const blocked = await runDatasetClassificationApply({
      inputPath,
      decisionsPath,
      outPath,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(
      blocked.blockers.some((blocker) => blocker.code === 'classification_target_ambiguous'),
      true,
    );
    assert.equal(
      blocked.blockers.some((blocker) => blocker.code === 'location_target_not_found'),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset classification audit covers TIDAS location fields across row types', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-location-all-'));
  const inputPath = path.join(dir, 'mixed.jsonl');
  writeJsonl(inputPath, [
    {
      flowDataSet: {
        '@xsi:schemaLocation': 'not-a-location-code',
        flowInformation: {
          geography: {
            locationOfSupply: 'RER',
          },
        },
      },
    },
    {
      LCIAMethodDataSet: {
        LCIAMethodInformation: {
          geography: {
            interventionLocation: {
              '#text': 'Not a TIDAS code',
              '@latitudeAndLongitude': '+46.94797+007.44745',
            },
            impactLocation: 'GLO',
          },
        },
        characterisationFactors: {
          factor: {
            location: 'CH',
          },
        },
      },
    },
  ]);

  try {
    const audit = await runDatasetClassificationAudit({
      inputPath,
      type: 'location',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });
    assert.equal(audit.status, 'blocked');
    assert.equal(audit.counts.location_targets, 4);
    assert.equal(audit.counts.valid, 3);
    assert.equal(audit.counts.invalid, 1);
    assert.equal(
      audit.findings.some((finding) => finding.path.endsWith('@xsi:schemaLocation')),
      false,
    );
    assert.ok(
      audit.findings.some(
        (finding) =>
          finding.path ===
            'LCIAMethodDataSet.LCIAMethodInformation.geography.interventionLocation.#text' &&
          finding.status === 'invalid',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli exposes dataset classification children, path, and apply actions', async () => {
  const help = await executeCli(['dataset', 'classification', '--help'], makeDeps());
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /classification children --type <type>/u);

  const pathResult = await executeCli(
    ['dataset', 'classification', 'path', '--type', 'process', '--code', '1080', '--json'],
    makeDeps({
      runDatasetClassificationPathImpl: async (options: unknown) => ({
        schema_version: 1,
        generated_at_utc: '2026-06-02T00:00:00.000Z',
        status: 'completed',
        command: 'dataset classification path',
        category_type: 'process',
        schema_file: 'tidas_processes_category.json',
        code: (options as { code: string }).code,
        path: [],
        blockers: [],
      }),
    }),
  );
  assert.equal(pathResult.exitCode, 0);
  assert.equal(JSON.parse(pathResult.stdout).code, '1080');

  const blocked = await executeCli(
    ['dataset', 'classification', 'children', '--type', 'process', '--parent', 'missing'],
    makeDeps({
      runDatasetClassificationChildrenImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-06-02T00:00:00.000Z',
        status: 'blocked',
        command: 'dataset classification children',
        category_type: 'process',
        schema_file: 'tidas_processes_category.json',
        parent_code: 'missing',
        query: null,
        counts: {
          children: 0,
          returned: 0,
        },
        children: [],
        blockers: [{ code: 'classification_parent_unknown', message: 'Unknown parent code.' }],
      }),
    }),
  );
  assert.equal(blocked.exitCode, 1);

  const auditResult = await executeCli(
    ['dataset', 'classification', 'audit', '--type', 'location', '--input', 'rows.jsonl', '--json'],
    makeDeps({
      runDatasetClassificationAuditImpl: async (options: unknown) => ({
        schema_version: 1,
        generated_at_utc: '2026-06-02T00:00:00.000Z',
        status: 'completed',
        command: 'dataset classification audit',
        category_type: 'location',
        schema_file: 'tidas_locations_category.json',
        input_path: (options as { inputPath: string }).inputPath,
        counts: {
          rows: 1,
          location_targets: 1,
          valid: 1,
          invalid: 0,
        },
        findings: [],
        blockers: [],
      }),
    }),
  );
  assert.equal(auditResult.exitCode, 0);
  assert.equal(JSON.parse(auditResult.stdout).input_path, 'rows.jsonl');

  const applyResult = await executeCli(
    [
      'dataset',
      'classification',
      'apply',
      '--input',
      'rows.jsonl',
      '--decisions',
      'decisions.jsonl',
      '--out',
      'classified.jsonl',
      '--type',
      'process',
      '--json',
    ],
    makeDeps({
      runDatasetClassificationApplyImpl: async (options: unknown) => ({
        schema_version: 1,
        generated_at_utc: '2026-06-02T00:00:00.000Z',
        status: 'completed',
        command: 'dataset classification apply',
        input_path: (options as { inputPath: string }).inputPath,
        decisions_path: (options as { decisionsPath: string }).decisionsPath,
        out_path: (options as { outPath: string }).outPath,
        default_category_type: 'process',
        counts: {
          rows: 1,
          decisions: 1,
          applied: 1,
          blockers: 0,
        },
        blockers: [],
        files: {
          classified_rows: 'classified.jsonl',
          evidence: 'classification-apply-evidence.jsonl',
          report: 'classification-apply-report.json',
        },
      }),
    }),
  );
  assert.equal(applyResult.exitCode, 0);
  assert.equal(JSON.parse(applyResult.stdout).out_path, 'classified.jsonl');
});
