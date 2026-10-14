import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { processTransportFixture } from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;
const VERSION = '01.00.000';
const FLOW = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const CONSUMER = '66666666-6666-4666-8666-666666666666';

function component(id: string, amounts: Array<[string, string, string]>) {
  const payload = processTransportFixture();
  const root = obj(payload.processDataSet);
  obj(obj(root.processInformation).dataSetInformation)['common:UUID'] = id;
  const base = (obj(root.exchanges).exchange as Json[])[0];
  obj(root.exchanges).exchange = amounts.map(([flow, direction, amount], index) => ({
    ...structuredClone(base),
    '@dataSetInternalID': String(index + 1),
    referenceToFlowDataSet: { ...obj(base.referenceToFlowDataSet), '@refObjectId': flow },
    exchangeDirection: direction,
    meanAmount: amount,
    resultingAmount: amount,
  }));
  obj(obj(root.processInformation).quantitativeReference).referenceToReferenceFlow = String(
    amounts.findIndex(([, direction]) => direction === 'Output') + 1,
  );
  return payload;
}

function setup() {
  const sources = [
    { id: SUPPLIER, version: VERSION, payload: component(SUPPLIER, [[FLOW, 'Output', '2']]) },
    {
      id: CONSUMER,
      version: VERSION,
      payload: component(CONSUMER, [
        [FLOW, 'Input', '5'],
        [PRODUCT, 'Output', '1'],
      ]),
    },
  ];
  const instances: Json[] = sources.map(({ id, version }, index) => ({
    '@dataSetInternalID': String(index),
    '@multiplicationFactor': '1',
    referenceToProcess: {
      '@type': 'process data set',
      '@refObjectId': id,
      '@version': version,
      '@uri': `../processes/${id}.xml`,
      'common:shortDescription': { '@xml:lang': 'en', '#text': 'Synthetic component' },
    },
  }));
  instances[0].connections = {
    outputExchange: {
      '@id': 'transfer',
      '@flowUUID': FLOW,
      '@version': VERSION,
      downstreamProcess: { '@id': '1', '@flowUUID': FLOW, '@version': VERSION },
    },
  };
  return { sources, instances };
}

const sourceRoot = (fixture: ReturnType<typeof setup>, index = 0) =>
  obj(fixture.sources[index].payload.processDataSet);
const exchange = (fixture: ReturnType<typeof setup>, index = 0) =>
  (obj(sourceRoot(fixture, index).exchanges).exchange as Json[])[0];
const connection = (fixture: ReturnType<typeof setup>) =>
  obj(obj(fixture.instances[0].connections).outputExchange);

async function run(fixture: ReturnType<typeof setup>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-model-input-guards-'));
  try {
    const files = fixture.sources.map(({ id, version, payload }) => {
      const file = path.join(dir, `${id}_${version}.json`);
      writeFileSync(file, JSON.stringify(payload));
      return file;
    });
    const request = {
      source_model: {
        json_ordered: {
          lifeCycleModelDataSet: {
            '@id': '77777777-7777-4777-8777-777777777777',
            '@version': VERSION,
            lifeCycleModelInformation: {
              dataSetInformation: {
                'common:UUID': '77777777-7777-4777-8777-777777777777',
                name: obj(obj(sourceRoot(fixture).processInformation).dataSetInformation).name,
              },
              quantitativeReference: { referenceToReferenceProcess: '1' },
              technology: { processes: { processInstance: fixture.instances } },
            },
          },
        },
      },
      projection: { process_id: '88888888-8888-4888-8888-888888888888' },
      process_sources: { process_json_files: files, allow_remote_lookup: false },
    };
    const input = path.join(dir, 'request.json');
    const out = path.join(dir, 'out');
    writeFileSync(input, JSON.stringify(request));
    const result = await executeCli(
      ['lifecyclemodel', 'build-resulting-process', '--input', input, '--out-dir', out, '--json'],
      {
        env: {},
        dotEnvStatus: { loaded: false, path: '/private/tmp/.env', count: 0 },
        fetchImpl: async () => {
          throw new Error('offline fixture cannot fetch');
        },
      },
    );
    if (result.exitCode !== 0) return { result, outputWritten: existsSync(out) };
    const report = JSON.parse(result.stdout) as Json;
    const outputFiles = obj(report.files);
    const bundle = JSON.parse(
      readFileSync(String(outputFiles.process_projection_bundle), 'utf8'),
    ) as Json;
    const payload = obj((bundle.projected_processes as Json[])[0].json_ordered);
    const projection = JSON.parse(
      readFileSync(String(outputFiles.projection_report), 'utf8'),
    ) as Json;
    const outputFile = path.join(dir, 'projected.json');
    writeFileSync(outputFile, JSON.stringify(payload));
    const validation = await executeCli(
      [
        'dataset',
        'validate',
        '--type',
        'process',
        '--input',
        outputFile,
        '--out-dir',
        path.join(dir, 'validated'),
        '--json',
      ],
      {
        env: {},
        dotEnvStatus: { loaded: false, path: '/private/tmp/.env', count: 0 },
        fetchImpl: async () => {
          throw new Error('offline fixture cannot fetch');
        },
      },
    );
    return { result, outputWritten: true, payload, projection, validation };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rejected(built: Awaited<ReturnType<typeof run>>, reason: RegExp) {
  assert.notEqual(built.result.exitCode, 0, 'unsafe source must not produce qualified artifacts');
  assert.match(built.result.stderr, reason);
  assert.equal(
    built.outputWritten,
    false,
    'input guard must run before output artifacts are written',
  );
}

function qualified(built: Awaited<ReturnType<typeof run>>) {
  assert.equal(built.result.exitCode, 0, built.result.stderr);
  assert.equal(built.validation!.exitCode, 0, built.validation!.stderr);
  assert.deepEqual(built.projection!.qualification, { status: 'qualified', publish_ready: true });
  return (obj(obj(built.payload!.processDataSet).exchanges).exchange as Json[]).map((item) => [
    obj(item.referenceToFlowDataSet)['@refObjectId'],
    item.exchangeDirection,
    item.meanAmount,
  ]);
}

for (const mismatch of ['UUID', 'version', 'missing version', 'missing default version']) {
  test(`filename-selected Process must reject a body with ${mismatch} mismatch`, async () => {
    const fixture = setup();
    if (mismatch === 'UUID')
      obj(obj(sourceRoot(fixture).processInformation).dataSetInformation)['common:UUID'] =
        '99999999-9999-4999-8999-999999999999';
    else {
      const publication = obj(
        obj(sourceRoot(fixture).administrativeInformation).publicationAndOwnership,
      );
      if (mismatch === 'version') publication['common:dataSetVersion'] = '02.00.000';
      else delete publication['common:dataSetVersion'];
      if (mismatch === 'missing default version') {
        fixture.sources[0].version = '00.00.001';
        obj(fixture.instances[0].referenceToProcess)['@version'] = '00.00.001';
      }
    }
    rejected(await run(fixture), /identity|UUID|version|requested/i);
  });
}

for (const dominant of [undefined, 'true', 'false']) {
  test(`distinct declared Flow UUIDs reject unsupported mapping with dominant=${dominant}`, async () => {
    const fixture = setup();
    const edge = connection(fixture);
    obj(edge.downstreamProcess)['@flowUUID'] = PRODUCT;
    if (dominant !== undefined) {
      edge['@dominant'] = dominant;
      obj(edge.downstreamProcess)['@dominant'] = dominant === 'true' ? 'false' : 'true';
    }
    // FLOW input remains available: choosing the outer UUID alone would silently cancel it.
    rejected(await run(fixture), /distinct|different|mapping|Flow UUID|flow.*mismatch/i);
  });
}

for (const endpoint of ['outer', 'downstream']) {
  test(`same-Flow connection rejects an exact ${endpoint} version inconsistent with its exchange`, async () => {
    const fixture = setup();
    const edge = connection(fixture);
    const target = endpoint === 'outer' ? edge : obj(edge.downstreamProcess);
    target['@version'] = '02.00.000';
    rejected(await run(fixture), /version|exact Flow|basis/i);
  });
}

test('explicit malformed connection qualifiers cannot become omitted legacy fields', async () => {
  for (const value of [null, '', 2]) {
    for (const endpoint of ['outer', 'downstream']) {
      const fixture = setup();
      const edge = connection(fixture);
      const target = endpoint === 'outer' ? edge : obj(edge.downstreamProcess);
      target['@version'] = value;
      rejected(await run(fixture), /Connection version mismatch/);
    }
    const fixture = setup();
    const edge = connection(fixture);
    edge['@flowUUID'] = value;
    obj(edge.downstreamProcess)['@flowUUID'] = value;
    rejected(await run(fixture), /Unsupported connection Flow mapping/);
  }
});

test('matching, optional and legacy connection declarations retain partial residuals and generated dominance', async () => {
  for (const mode of ['exact', 'optional', 'legacy', 'generated']) {
    const fixture = setup();
    const edge = connection(fixture);
    if (mode !== 'exact') {
      delete edge['@version'];
      delete obj(edge.downstreamProcess)['@version'];
    }
    if (mode === 'legacy') {
      edge.flowUUID = edge['@flowUUID'];
      delete edge['@flowUUID'];
      delete obj(edge.downstreamProcess)['@flowUUID'];
      obj(edge.downstreamProcess).id = '1';
      delete obj(edge.downstreamProcess)['@id'];
    }
    if (mode === 'generated') {
      edge['@dominant'] = 'true';
      obj(edge.downstreamProcess)['@dominant'] = 'true';
      delete edge['@id'];
    }
    assert.deepEqual(qualified(await run(fixture)), [
      [FLOW, 'Input', '3'],
      [PRODUCT, 'Output', '1'],
    ]);
  }
});

test('factor-zero disables malformed mapping connections without cancelling downstream inventory', async () => {
  const fixture = setup();
  fixture.instances[0]['@multiplicationFactor'] = '0';
  obj(connection(fixture).downstreamProcess)['@flowUUID'] = PRODUCT;
  connection(fixture)['@version'] = '02.00.000';
  assert.deepEqual(qualified(await run(fixture)), [
    [FLOW, 'Input', '5'],
    [PRODUCT, 'Output', '1'],
  ]);
});

test('connection versions bind Flow references independently of component Process versions', async () => {
  const fixture = setup();
  for (const index of [0, 1])
    obj(exchange(fixture, index).referenceToFlowDataSet)['@version'] = '02.00.000';
  connection(fixture)['@version'] = '02.00.000';
  obj(connection(fixture).downstreamProcess)['@version'] = '02.00.000';
  assert.deepEqual(qualified(await run(fixture)), [
    [FLOW, 'Input', '3'],
    [PRODUCT, 'Output', '1'],
  ]);
});

test('unallocated exchange with meanAmount=1 and resultingAmount=4 rejects conflicting inventory', async () => {
  const fixture = setup();
  exchange(fixture).meanAmount = '1';
  exchange(fixture).resultingAmount = '4';
  rejected(await run(fixture), /Conflicting quantity basis|amount.*conflict|inconsistent/i);
});

for (const mode of ['referenced variable', 'formula model']) {
  test(`unallocated ${mode} is rejected before silently selecting meanAmount`, async () => {
    const fixture = setup();
    exchange(fixture).referenceToVariable = 'factor';
    if (mode === 'formula model')
      obj(sourceRoot(fixture).processInformation).mathematicalRelations = {
        variableParameter: { '@name': 'factor', formula: '2*2', meanValue: '4' },
      };
    rejected(await run(fixture), /variable|mathematical|formula|unsupported.*quantity/i);
  });
}

test('numerically equal string amount variants retain supported fixed inventory', async () => {
  for (const amount of ['2.0', '2e0', '2.00000']) {
    const fixture = setup();
    exchange(fixture).resultingAmount = amount;
    assert.deepEqual(qualified(await run(fixture)), [
      [FLOW, 'Input', '3'],
      [PRODUCT, 'Output', '1'],
    ]);
  }
});

test('unused mathematical model metadata does not change fixed exchange amounts', async () => {
  const fixture = setup();
  obj(sourceRoot(fixture).processInformation).mathematicalRelations = {
    variableParameter: { '@name': 'factor', formula: '2*2', meanValue: '4' },
  };
  assert.deepEqual(qualified(await run(fixture)), [
    [FLOW, 'Input', '3'],
    [PRODUCT, 'Output', '1'],
  ]);
});
