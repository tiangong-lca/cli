import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { parseProcessRecord } from '../src/lib/model/result/sources.js';
import {
  allocationFixture,
  processTransportFixture,
} from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;
const VERSION = '01.00.000';
const FLOW = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const CONSUMER = '66666666-6666-4666-8666-666666666666';

const offlineDependencies = {
  env: {},
  dotEnvStatus: { loaded: false, path: path.join(os.tmpdir(), '.env'), count: 0 },
  fetchImpl: async () => {
    throw new Error('offline fixture cannot fetch');
  },
};

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
    const sourceFlow = allocationFixture().context.flow_documents[0];
    const refs = fixture.sources.flatMap(({ payload }) =>
      (obj(obj(payload.processDataSet).exchanges).exchange as Json[]).map((row) =>
        obj(row.referenceToFlowDataSet),
      ),
    );
    const versions = new Map(
      refs.map((ref) => [JSON.stringify([ref['@refObjectId'], ref['@version']]), ref]),
    );
    const flowDocuments = [...versions.values()].map((ref) => {
      const copy = structuredClone(sourceFlow);
      obj(obj(obj(copy.flowDataSet).flowInformation).dataSetInformation)['common:UUID'] =
        ref['@refObjectId'];
      obj(obj(obj(copy.flowDataSet).administrativeInformation).publicationAndOwnership)[
        'common:dataSetVersion'
      ] = ref['@version'];
      return copy;
    });
    const references = path.join(dir, 'references.json');
    writeFileSync(references, JSON.stringify({ documents: flowDocuments }));
    const request = {
      semantic_context: { flow_documents: flowDocuments },
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
      ['dataset', 'model', 'build-resulting-process', '--input', input, '--output', out, '--json'],
      offlineDependencies,
    );
    if (result.exitCode !== 0) return { result, outputWritten: existsSync(out) };
    const output = JSON.parse(readFileSync(out, 'utf8'));
    const payload = obj(output.bundle.projected_processes[0].json_ordered);
    const projection = obj(output.projection);
    const outputFile = path.join(dir, 'projected.json');
    writeFileSync(outputFile, JSON.stringify(payload));
    const validation = await executeCli(
      [
        'dataset',
        'process',
        'validate',
        '--input',
        outputFile,
        '--reference-documents',
        references,
        '--json',
      ],
      offlineDependencies,
    );
    return { result, outputWritten: true, payload, projection, validation };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rejected(built: Awaited<ReturnType<typeof run>>, reason: RegExp) {
  assert.notEqual(built.result.exitCode, 0, 'unsafe source must not produce qualified artifacts');
  const { error } = JSON.parse(built.result.stdout);
  assert.match(`${error.code} ${error.message}`, reason);
  assert.equal(
    built.outputWritten,
    false,
    'input guard must run before output artifacts are written',
  );
}

function qualified(built: Awaited<ReturnType<typeof run>>) {
  assert.equal(built.result.exitCode, 0, built.result.stdout + built.result.stderr);
  assert.equal(built.validation!.exitCode, 0, built.validation!.stdout + built.validation!.stderr);
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

test('rejects a reference amount mismatch hidden by floating point rounding', async () => {
  const fixture = setup();
  const row = (obj(sourceRoot(fixture).exchanges).exchange as Json[])[0];
  row.meanAmount = '9007199254740992';
  row.resultingAmount = '9007199254740993';
  rejected(await run(fixture), /LIFECYCLEMODEL_QUANTITY_BASIS_CONFLICT/);
});

test('typed Process validation reports the exact conflicting exchange and both original amounts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-process-amount-conflict-'));
  try {
    const process = component(SUPPLIER, [[FLOW, 'Output', '0.306']]);
    const first = (obj(obj(process.processDataSet).exchanges).exchange as Json[])[0];
    first.resultingAmount = '306.0';
    const input = path.join(dir, 'process.json');
    writeFileSync(input, JSON.stringify(process));
    const response = await executeCli(
      ['dataset', 'process', 'validate', '--input', input, '--json'],
      offlineDependencies,
    );
    const envelope = JSON.parse(response.stdout);
    assert.equal(envelope.outcome, 'validation_failed');
    const issue = envelope.data.validation.issues.find(
      (item: Json) => item.code === 'process_exchange_amount_conflict',
    );
    assert.equal(issue.path, 'processDataSet.exchanges.exchange.0.resultingAmount');
    assert.match(issue.message, /306\.0/);
    assert.match(issue.message, /0\.306/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct local builder checks the referenced identity before accepting a Process', () => {
  const payload = component(SUPPLIER, [[FLOW, 'Output', '2']]);
  const expectedIdentity = { processId: CONSUMER, version: VERSION };
  const options = { sourceLabel: 'fixture', sourcePath: 'input.json', expectedIdentity };
  assert.throws(
    () => parseProcessRecord(payload, options),
    /identity mismatch.+observed.+01.00.000/,
  );
  const publication = obj(
    obj(obj(payload.processDataSet).administrativeInformation).publicationAndOwnership,
  );
  delete publication['common:dataSetVersion'];
  assert.throws(
    () =>
      parseProcessRecord(payload, {
        ...options,
        expectedIdentity: { processId: SUPPLIER, version: VERSION },
      }),
    /identity mismatch.+missing/,
  );
});
