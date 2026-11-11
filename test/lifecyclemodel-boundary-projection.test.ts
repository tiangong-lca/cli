import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecyclemodelBuildResultingProcess } from '../src/lib/model/resulting-process.js';
import { runDatasetValidate } from '../src/lib/dataset/validate.js';
import { CliError, toErrorPayload } from '../src/shared/errors.js';
import { processTransportFixture } from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const obj = (x: unknown) => x as Json;
const FLOW = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VERSION = '01.00.000';
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
function setup(supply = '2', demand = '5') {
  const processes = [
    component('55555555-5555-4555-8555-555555555555', [[FLOW, 'Output', supply]]),
    component('66666666-6666-4666-8666-666666666666', [
      [FLOW, 'Input', demand],
      [PRODUCT, 'Output', '1'],
    ]),
  ];
  const instances: Json[] = processes.map((payload, index) => ({
    '@dataSetInternalID': String(index),
    '@multiplicationFactor': '1',
    referenceToProcess: {
      '@type': 'process data set',
      '@refObjectId': obj(obj(obj(payload.processDataSet).processInformation).dataSetInformation)[
        'common:UUID'
      ],
      '@version': VERSION,
      '@uri': '../processes/fixture.xml',
      'common:shortDescription': { '@xml:lang': 'en', '#text': 'Synthetic component' },
    },
  }));
  instances[0].connections = {
    outputExchange: {
      '@id': 'transfer',
      '@flowUUID': FLOW,
      downstreamProcess: { '@id': '1', '@flowUUID': FLOW, '@version': VERSION },
    },
  };
  return { processes, instances, reference: 1 as unknown, overrides: {} as Json };
}
async function run(fixture: ReturnType<typeof setup>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-boundary-projection-'));
  try {
    const files = fixture.processes.map((payload) => {
      const id = obj(obj(obj(payload.processDataSet).processInformation).dataSetInformation)[
        'common:UUID'
      ];
      const file = path.join(dir, `${id}_${VERSION}.json`);
      writeFileSync(file, JSON.stringify(payload));
      return file;
    });
    const info: Json = {
      dataSetInformation: {
        'common:UUID': '77777777-7777-4777-8777-777777777777',
        name: obj(
          obj(obj(fixture.processes[0].processDataSet).processInformation).dataSetInformation,
        ).name,
      },
      quantitativeReference:
        fixture.reference === undefined ? {} : { referenceToReferenceProcess: fixture.reference },
      technology: { processes: { processInstance: fixture.instances } },
    };
    const request = {
      source_model: {
        json_ordered: {
          lifeCycleModelDataSet: {
            '@id': '77777777-7777-4777-8777-777777777777',
            '@version': VERSION,
            lifeCycleModelInformation: info,
          },
        },
      },
      projection: {
        process_id: '88888888-8888-4888-8888-888888888888',
        metadata_overrides: fixture.overrides,
      },
      process_sources: { process_json_files: files, allow_remote_lookup: false },
    };
    const input = path.join(dir, 'request.json');
    writeFileSync(input, JSON.stringify(request));
    let result;
    try {
      const report = await runLifecyclemodelBuildResultingProcess({
        inputPath: input,
        outDir: path.join(dir, 'out'),
        env: {},
        fetchImpl: async () => {
          throw new Error('offline fixture cannot fetch');
        },
      });
      result = { exitCode: 0, stdout: JSON.stringify(report), stderr: '' };
    } catch (error) {
      result = {
        exitCode: error instanceof CliError ? error.exitCode : 1,
        stdout: '',
        stderr: JSON.stringify(toErrorPayload(error)),
      };
    }
    if (result.exitCode !== 0) return { result };
    const report = JSON.parse(result.stdout) as Json;
    const filesOut = obj(report.files);
    const bundle = JSON.parse(
      readFileSync(String(filesOut.process_projection_bundle), 'utf8'),
    ) as Json;
    const payload = obj((bundle.projected_processes as Json[])[0].json_ordered);
    const projection = JSON.parse(readFileSync(String(filesOut.projection_report), 'utf8')) as Json;
    const output = path.join(dir, 'output.json');
    writeFileSync(output, JSON.stringify(payload));
    const validationReport = await runDatasetValidate({
      type: 'process',
      inputPath: output,
      outDir: path.join(dir, 'validated'),
    });
    const validation = { exitCode: validationReport.counts.invalid > 0 ? 1 : 0 };
    return { result, payload, projection, validation, report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function quantities(payload: Json) {
  const exchanges = obj(obj(payload.processDataSet).exchanges).exchange;
  return (Array.isArray(exchanges) ? exchanges : [exchanges]).map((item) => [
    obj(item.referenceToFlowDataSet)['@refObjectId'],
    item.exchangeDirection,
    item.meanAmount,
  ]);
}
test('result builder retains single-provider partial/excess residuals and cancels equal supply exactly once', async () => {
  for (const [supply, demand, direction, remaining] of [
    ['2', '5', 'Input', '3'],
    ['5', '2', 'Output', '3'],
    ['2', '2', '', ''],
  ]) {
    const built = await run(setup(supply, demand));
    assert.equal(built.result.exitCode, 0, built.result.stderr);
    const values = quantities(built.payload!);
    assert.ok(
      values.some(
        ([flow, side, amount]) => flow === PRODUCT && side === 'Output' && amount === '1',
      ),
    );
    assert.deepEqual(
      values.filter(([flow]) => flow === FLOW),
      direction ? [[FLOW, direction, remaining]] : [],
    );
    assert.equal(built.validation!.exitCode, 0, JSON.stringify(built.projection!.validation));
    assert.deepEqual(built.projection!.qualification, { status: 'qualified', publish_ready: true });
  }
});
test('result builder rejects repeated/competing connections instead of repeatedly cancelling inventory', async () => {
  const fixture = setup();
  const connection = obj(fixture.instances[0].connections);
  connection.outputExchange = [
    connection.outputExchange,
    structuredClone(connection.outputExchange),
  ];
  const built = await run(fixture);
  assert.notEqual(built.result.exitCode, 0);
  assert.match(built.result.stderr, /competing connection/);
});
test('competing active providers are rejected but a disabled provider does not compete; exact versions and signed transfers are not guessed', async () => {
  for (const factor of ['1', '0']) {
    const fixture = setup();
    fixture.processes.push(
      component('99999999-9999-4999-8999-999999999999', [[FLOW, 'Output', '4']]),
    );
    const third = structuredClone(fixture.instances[0]);
    third['@dataSetInternalID'] = '2';
    third['@multiplicationFactor'] = factor;
    obj(third.referenceToProcess)['@refObjectId'] = '99999999-9999-4999-8999-999999999999';
    fixture.instances.push(third);
    const built = await run(fixture);
    if (factor === '1') assert.match(built.result.stderr, /competing connection/);
    else {
      assert.equal(built.result.exitCode, 0);
      assert.deepEqual(quantities(built.payload!), [
        [FLOW, 'Input', '3'],
        [PRODUCT, 'Output', '1'],
      ]);
    }
  }
  const mixed = setup();
  obj(
    (obj(obj(mixed.processes[1].processDataSet).exchanges).exchange as Json[])[0]
      .referenceToFlowDataSet,
  )['@version'] = '02.00.000';
  assert.match((await run(mixed)).result.stderr, /Mixed exact Flow\/basis/);
  assert.match((await run(setup('2', '-5'))).result.stderr, /Mixed exact Flow\/basis/);
});
test('result builder resolves non-first integer, zero and legacy references without changing the source type', async () => {
  for (const reference of [1, 0, '1', { '@refObjectId': '1' }]) {
    const fixture = setup();
    delete fixture.instances[0].connections;
    fixture.reference = reference;
    const built = await run(fixture);
    assert.equal(built.result.exitCode, 0, built.result.stderr);
    const root = obj(built.payload!.processDataSet);
    const id = obj(obj(root.processInformation).quantitativeReference).referenceToReferenceFlow;
    const target = (obj(root.exchanges).exchange as Json[]).find(
      (item) => item['@dataSetInternalID'] === id,
    )!;
    assert.equal(
      obj(target.referenceToFlowDataSet)['@refObjectId'],
      reference === 0 ? FLOW : PRODUCT,
    );
    assert.equal(target.meanAmount, reference === 0 ? '2' : '1');
    assert.equal(
      obj(built.report!.source_model).reference_process_instance_id,
      reference === 0 ? '0' : '1',
    );
  }
});
test('result builder rejects explicit invalid/unresolved/duplicate instance references; absent reference retains deliberate fallback', async () => {
  for (const reference of [null, '', 1.5, {}, 'missing']) {
    const fixture = setup();
    fixture.reference = reference;
    const built = await run(fixture);
    assert.notEqual(built.result.exitCode, 0);
    assert.match(built.result.stderr, /reference process instance|Reference process instance/);
  }
  const duplicate = setup();
  duplicate.instances[1]['@dataSetInternalID'] = '0';
  assert.match((await run(duplicate)).result.stderr, /Duplicate process instance ID/);
  const absent = setup();
  absent.reference = undefined;
  delete absent.instances[0].connections;
  assert.equal((await run(absent)).result.exitCode, 0);
});
test('small scientific multipliers scale before final formatting and preserve equivalent source bases', async () => {
  for (const [factor, supply, demand, output, input] of [
    ['5e-11', '20000000000', '40000000000', '1', '2'],
    ['1.23456e-10', '10000000000', '20000000000', '1.23456', '2.46912'],
    ['1', '1', '2', '1', '2'],
  ]) {
    const fixture = setup();
    fixture.processes = [
      component('55555555-5555-4555-8555-555555555555', [
        [FLOW, 'Output', supply],
        [PRODUCT, 'Input', demand],
      ]),
    ];
    fixture.instances = [fixture.instances[0]];
    delete fixture.instances[0].connections;
    fixture.instances[0]['@multiplicationFactor'] = factor;
    fixture.reference = 0;
    const built = await run(fixture);
    assert.equal(built.result.exitCode, 0, built.result.stderr);
    assert.deepEqual(quantities(built.payload!), [
      [FLOW, 'Output', output],
      [PRODUCT, 'Input', input],
    ]);
    assert.equal(built.validation!.exitCode, 0, JSON.stringify(built.projection!.validation));
  }
});
test('multipliers require explicit finite nonnegative values; genuine zero remains disabled', async () => {
  for (const factor of [undefined, null, '', ' ', 'Infinity', 'NaN', '-1', true, ['1']]) {
    const fixture = setup();
    fixture.instances[0]['@multiplicationFactor'] = factor;
    const built = await run(fixture);
    assert.notEqual(built.result.exitCode, 0);
    assert.match(built.result.stderr, /multiplication factor|numeric value/);
  }
  const fixture = setup();
  fixture.instances[0]['@multiplicationFactor'] = '0';
  const disabled = await run(fixture);
  assert.equal(disabled.result.exitCode, 0);
  assert.deepEqual(quantities(disabled.payload!), [
    [FLOW, 'Input', '5'],
    [PRODUCT, 'Output', '1'],
  ]);
  const overflow = setup();
  overflow.instances[0]['@multiplicationFactor'] = '1e308';
  assert.match((await run(overflow)).result.stderr, /Scaled exchange amount is not finite/);
});
test('default and supported override serialize untouched schema-valid output; unsupported enum and annual gaps remain separately unqualified', async () => {
  for (const override of [undefined, 'Unit process, single operation', 'unsupported']) {
    const fixture = setup();
    if (override) fixture.overrides.type_of_data_set = override;
    const built = await run(fixture);
    assert.equal(built.result.exitCode, 0, built.result.stderr);
    const root = obj(built.payload!.processDataSet);
    assert.equal(
      obj(obj(root.modellingAndValidation).LCIMethodAndAllocation).typeOfDataSet,
      override ?? 'Partly terminated system',
    );
    for (const item of obj(root.exchanges).exchange as Json[]) {
      assert.equal(typeof item.meanAmount, 'string');
      assert.equal(typeof item.resultingAmount, 'string');
    }
    assert.equal(built.validation!.exitCode, override === 'unsupported' ? 1 : 0);
    assert.equal(obj(built.projection!.qualification).publish_ready, override !== 'unsupported');
  }
  const fixture = setup();
  const root = obj(fixture.processes[1].processDataSet);
  obj(
    obj(root.modellingAndValidation).dataSourcesTreatmentAndRepresentativeness,
  ).annualSupplyOrProductionVolume = [];
  const built = await run(fixture);
  assert.equal(built.result.exitCode, 0);
  assert.equal(obj(built.projection!.qualification).publish_ready, false);
  assert.equal(built.validation!.exitCode, 1);
  const layers = obj(obj(built.projection!.validation).validation_layers);
  assert.equal(obj(layers.schema).status, 'passed');
  assert.equal(obj(layers.authoring_evidence).status, 'failed');
});
