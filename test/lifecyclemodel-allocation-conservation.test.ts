import { loadDistModule } from './helpers/load-dist-module.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLifecyclemodelBuildResultingProcess } from '../src/lib/lifecyclemodel-resulting-process.js';
import { validateProcessPayload } from '../src/lib/process-payload-validation.js';
import { allocationFixture } from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;
const VERSION = '01.00.000';
function setup(first = '60', second = '30') {
  const fixture = allocationFixture('Output');
  const original = obj(fixture.payload.processDataSet);
  const exchanges = obj(original.exchanges).exchange as Json[];
  const inventory = exchanges[0];
  inventory.exchangeDirection = 'Input';
  const a = exchanges[1];
  const b = structuredClone(a);
  b['@dataSetInternalID'] = '2';
  obj(b.referenceToFlowDataSet)['@refObjectId'] = '44444444-4444-4444-8444-444444444444';
  obj(original.exchanges).exchange = [inventory, a, b];
  obj(obj(original.processInformation).quantitativeReference).referenceToReferenceFlow = '0';
  const flowB = structuredClone(fixture.context.flow_documents[0]);
  obj(obj(obj(flowB.flowDataSet).flowInformation).dataSetInformation)['common:UUID'] = obj(
    b.referenceToFlowDataSet,
  )['@refObjectId'];
  const context = { flow_documents: [fixture.context.flow_documents[0], flowB] };
  const processes = [first, second].map((share, index) => {
    const payload = structuredClone(fixture.payload);
    const root = obj(payload.processDataSet);
    const id =
      index === 0 ? '55555555-5555-4555-8555-555555555555' : '66666666-6666-4666-8666-666666666666';
    obj(obj(root.processInformation).dataSetInformation)['common:UUID'] = id;
    const items = obj(root.exchanges).exchange as Json[];
    items[0].meanAmount = String(index === 0 ? 10 : 20);
    items[0].resultingAmount = items[0].meanAmount;
    items[0].allocations = {
      allocation: [
        { '@internalReferenceToCoProduct': '0', '@allocatedFraction': share },
        { '@internalReferenceToCoProduct': '2', '@allocatedFraction': String(100 - Number(share)) },
      ],
    };
    return { id, payload };
  });
  return { processes, context };
}
async function build(options: ReturnType<typeof setup>, reverse = false, edge = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-allocation-conservation-'));
  try {
    const files = options.processes.map(({ id, payload }) => {
      const filename = path.join(dir, `${id}_${VERSION}.json`);
      writeFileSync(filename, JSON.stringify(payload));
      return filename;
    });
    const instances = options.processes.map(({ id }, index) => ({
      '@dataSetInternalID': String(index),
      '@multiplicationFactor': '1',
      referenceToProcess: {
        '@type': 'process data set',
        '@refObjectId': id,
        '@version': VERSION,
        '@uri': `../processes/${id}.xml`,
        'common:shortDescription': { '@xml:lang': 'en', '#text': 'Synthetic source' },
      },
    }));
    if (edge) {
      obj(instances[0]).connections = {
        outputExchange: {
          '@id': 'edge',
          '@flowUUID': '22222222-2222-4222-8222-222222222222',
          downstreamProcess: { '@id': '1', '@flowUUID': '22222222-2222-4222-8222-222222222222' },
        },
      };
    }
    const request = {
      source_model: {
        json_ordered: {
          lifeCycleModelDataSet: {
            '@id': '77777777-7777-4777-8777-777777777777',
            '@version': VERSION,
            lifeCycleModelInformation: {
              dataSetInformation: {
                'common:UUID': '77777777-7777-4777-8777-777777777777',
                name: obj(
                  obj(obj(options.processes[0].payload.processDataSet).processInformation)
                    .dataSetInformation,
                ).name,
              },
              quantitativeReference: { referenceToReferenceProcess: '0' },
              technology: {
                processes: { processInstance: reverse ? instances.reverse() : instances },
              },
            },
          },
        },
      },
      projection: { process_id: '88888888-8888-4888-8888-888888888888' },
      process_sources: { process_json_files: files },
      semantic_context: options.context,
    };
    writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
    const result = await runLifecyclemodelBuildResultingProcess({
      inputPath: path.join(dir, 'request.json'),
      outDir: path.join(dir, 'out'),
    });
    const bundle = JSON.parse(readFileSync(result.files.process_projection_bundle, 'utf8')) as Json;
    const projected = (bundle.projected_processes as Json[])[0];
    const report = JSON.parse(readFileSync(result.files.projection_report, 'utf8')) as Json;
    return { projected, report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('result generator conserves 10@60/40 + 20@30/70, provenance and real unchanged SDK validation', async () => {
  const fixture = setup();
  const { projected, report } = await build(fixture);
  const payload = obj(projected.json_ordered);
  const exchanges = obj(obj(payload.processDataSet).exchanges).exchange as Json[];
  const inventory = exchanges.find((item) => item.exchangeDirection === 'Input')!;
  assert.equal(inventory.meanAmount, '30');
  assert.deepEqual(
    (obj(inventory.allocations).allocation as Json[]).map((item) => item['@allocatedFraction']),
    ['40', '60'],
  );
  assert.equal(
    validateProcessPayload(payload, undefined, undefined, fixture.context).ok,
    true,
    JSON.stringify(report.validation),
  );
  assert.equal(obj(report.validation).ok, true);
  const builtJson =
    await loadDistModule<typeof import('../src/lib/dataset-json.js')>('src/lib/dataset-json.js');
  const cloned = builtJson.cloneJson(payload);
  assert.deepEqual(cloned, payload);
  obj(cloned.processDataSet)['synthetic:mutated'] = true;
  assert.equal(obj(payload.processDataSet)['synthetic:mutated'], undefined);
  const builtValidator = await loadDistModule<
    typeof import('../src/lib/process-payload-validation.js')
  >('src/lib/process-payload-validation.js');
  assert.equal(
    builtValidator.summarizeProcessPayloadValidation(
      builtValidator.validateProcessPayload(payload, undefined, undefined, fixture.context),
    ),
    'local process validation passed',
  );
  assert.deepEqual(report.qualification, { status: 'qualified', publish_ready: true });
  assert.ok(projected.allocation_transformation);
  const reordered = await build(fixture, true);
  const reverseItems = obj(
    obj(obj(reordered.projected.json_ordered).processDataSet).exchanges,
  ).exchange;
  assert.deepEqual(reverseItems, exchanges);
});

test('result generator rejects conflicting amount fields and already allocated inventory', async () => {
  for (const mode of ['amount', 'allocated', 'zero', 'signed', 'malformed']) {
    const fixture = setup();
    const root = obj(fixture.processes[0].payload.processDataSet);
    const inventory = (obj(root.exchanges).exchange as Json[])[0];
    if (mode === 'amount') inventory.resultingAmount = '12';
    if (mode === 'allocated')
      obj(root.modellingAndValidation).LCIMethodAndAllocation = { typeOfDataSet: 'LCI result' };
    if (mode === 'zero' || mode === 'signed') {
      inventory.meanAmount = mode === 'zero' ? '0' : '-1';
      inventory.resultingAmount = inventory.meanAmount;
    }
    if (mode === 'malformed') inventory.allocations = null;
    await assert.rejects(
      build(fixture),
      /Conflicting quantity basis|Already allocated|Zero or signed|Source allocation semantics failed/,
    );
  }
});

test('result generator consumes whole-inventory SDK legacy shares and rejects default-one sparse drift', async () => {
  const fixture = setup();
  for (const [index, source] of fixture.processes.entries()) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    delete items[0].allocations;
    items[1].allocations = { allocation: { '@allocatedFraction': index === 0 ? '60%' : '30%' } };
    items[2].allocations = { allocation: { '@allocatedFraction': index === 0 ? '40%' : '70%' } };
  }
  const { projected } = await build(fixture);
  const items = obj(obj(obj(projected.json_ordered).processDataSet).exchanges).exchange as Json[];
  assert.deepEqual(
    (
      obj(items.find((item) => item.exchangeDirection === 'Input')!.allocations)
        .allocation as Json[]
    ).map((item) => item['@allocatedFraction']),
    ['40', '60'],
  );
  assert.equal(
    validateProcessPayload(obj(projected.json_ordered), undefined, undefined, fixture.context).ok,
    true,
    JSON.stringify(
      validateProcessPayload(obj(projected.json_ordered), undefined, undefined, fixture.context)
        .issues,
    ),
  );
  for (const source of fixture.processes)
    obj(
      obj(obj(source.payload.processDataSet).processInformation).quantitativeReference,
    ).referenceToReferenceFlow = '1';
  await assert.rejects(build(fixture), /default-one reference/);
});

test('allocated deterministic cancellation conserves remaining source contributions; ambiguous lineage blocks', async () => {
  const fixture = setup();
  for (const source of fixture.processes) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    items[1].meanAmount = '30';
    items[1].resultingAmount = '30';
  }
  const { projected } = await build(fixture, false, true);
  const items = obj(obj(obj(projected.json_ordered).processDataSet).exchanges).exchange as Json[];
  const inventory = items.find((item) => item.exchangeDirection === 'Input')!;
  assert.equal(inventory.meanAmount, '10');
  assert.deepEqual(
    (obj(inventory.allocations).allocation as Json[]).map((item) => item['@allocatedFraction']),
    ['60', '40'],
  );
  const duplicate = structuredClone(
    (obj(obj(fixture.processes[1].payload.processDataSet).exchanges).exchange as Json[])[0],
  );
  duplicate['@dataSetInternalID'] = '3';
  (obj(obj(fixture.processes[1].payload.processDataSet).exchanges).exchange as Json[]).push(
    duplicate,
  );
  await assert.rejects(build(fixture, false, true), /no unique source lineage/);
  const insufficient = setup();
  const partial = await build(insufficient, false, true);
  const residual = (
    obj(obj(obj(partial.projected.json_ordered).processDataSet).exchanges).exchange as Json[]
  ).find((item) => item.exchangeDirection === 'Input')!;
  assert.equal(residual.meanAmount, '29');
  assert.deepEqual(partial.report.qualification, { status: 'qualified', publish_ready: true });
});

test('legacy undeclared inventory with divergent amounts fails before conversion', async () => {
  const fixture = setup();
  for (const source of fixture.processes) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    delete items[0].allocations;
    items[1].allocations = { allocation: { '@allocatedFraction': '70' } };
    items[2].allocations = { allocation: { '@allocatedFraction': '30' } };
  }
  (
    obj(obj(fixture.processes[0].payload.processDataSet).exchanges).exchange as Json[]
  )[0].resultingAmount = '12';
  await assert.rejects(build(fixture), /Conflicting quantity basis/);
});

test('cancellation between undeclared endpoints conserves a group merged with a third allocated instance', async () => {
  const fixture = setup();
  const third = structuredClone(fixture.processes[1]);
  third.id = '99999999-9999-4999-8999-999999999999';
  obj(obj(obj(third.payload.processDataSet).processInformation).dataSetInformation)['common:UUID'] =
    third.id;
  const thirdInventory = (obj(obj(third.payload.processDataSet).exchanges).exchange as Json[])[0];
  thirdInventory.meanAmount = '30';
  thirdInventory.resultingAmount = '30';
  for (const source of fixture.processes) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    delete items[0].allocations;
    items[1].meanAmount = '30';
    items[1].resultingAmount = '30';
  }
  fixture.processes.push(third);
  const { projected, report } = await build(fixture, false, true);
  const items = obj(obj(obj(projected.json_ordered).processDataSet).exchanges).exchange as Json[];
  const inventory = items.find((item) => item.exchangeDirection === 'Input')!;
  assert.equal(inventory.meanAmount, '40');
  assert.deepEqual(
    (obj(inventory.allocations).allocation as Json[]).map((item) => item['@allocatedFraction']),
    ['47.5', '52.5'],
  );
  assert.deepEqual(report.qualification, { status: 'qualified', publish_ready: true });
  const remaining = obj(projected.allocation_transformation).contributions as Json[];
  assert.equal(
    remaining.find((item) => item.instance === '1' && Number(item.remaining_amount) === 0)
      ?.remaining_amount,
    0,
  );
});

test('stable source ordering preserves fractions with extreme quantity magnitudes', async () => {
  const fixture = setup();
  for (const [index, source] of fixture.processes.entries()) {
    const inventory = (obj(obj(source.payload.processDataSet).exchanges).exchange as Json[])[0];
    inventory.meanAmount = index === 0 ? '1000000000000' : '0.000001';
    inventory.resultingAmount = inventory.meanAmount;
  }
  const forward = await build(fixture),
    reverse = await build(fixture, true);
  assert.deepEqual(
    obj(obj(obj(forward.projected.json_ordered).processDataSet).exchanges).exchange,
    obj(obj(obj(reverse.projected.json_ordered).processDataSet).exchanges).exchange,
  );
  const proof = obj(forward.projected.allocation_transformation);
  for (const error of proof.allocation_quantization as Json[])
    assert.ok(Number(error.percentage_error) <= 0.001);
});

test('an exported legacy candidate with ineligible inferred target is explicitly not qualified', async () => {
  const fixture = setup();
  for (const source of fixture.processes) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    delete items[0].allocations;
    items[1].allocations = { allocation: { '@allocatedFraction': '70' } };
    items[2].allocations = { allocation: { '@allocatedFraction': '30' } };
  }
  for (const document of fixture.context.flow_documents)
    obj(obj(obj(document.flowDataSet).modellingAndValidation).LCIMethod).typeOfDataSet =
      'Elementary flow';
  const { report } = await build(fixture);
  assert.equal(obj(report.validation).ok, false);
  assert.deepEqual(report.qualification, { status: 'failed', publish_ready: false });
});

test('legacy missing exact context is an unresolved candidate, never publish ready', async () => {
  const fixture = setup();
  for (const source of fixture.processes) {
    const items = obj(obj(source.payload.processDataSet).exchanges).exchange as Json[];
    delete items[0].allocations;
    items[1].allocations = { allocation: { '@allocatedFraction': '70' } };
    items[2].allocations = { allocation: { '@allocatedFraction': '30' } };
  }
  fixture.context.flow_documents = [];
  const { report } = await build(fixture);
  assert.deepEqual(report.qualification, { status: 'unresolved', publish_ready: false });
});

test('source identity collisions, nonrepresentable positive quantities and allocated fallback inventory block', async () => {
  const duplicate = setup();
  const dupItems = obj(obj(duplicate.processes[0].payload.processDataSet).exchanges)
    .exchange as Json[];
  delete dupItems[0].allocations;
  dupItems[1]['@dataSetInternalID'] = '1';
  obj(
    obj(obj(duplicate.processes[0].payload.processDataSet).processInformation)
      .quantitativeReference,
  ).referenceToReferenceFlow = '1';
  await assert.rejects(build(duplicate), /Duplicate exchange identity/);
  const tiny = setup();
  for (const source of tiny.processes) {
    const item = (obj(obj(source.payload.processDataSet).exchanges).exchange as Json[])[0];
    item.meanAmount = '0.000000000000001';
    item.resultingAmount = item.meanAmount;
  }
  await assert.rejects(build(tiny), /Zero or signed allocated quantity basis/);
  const applied = setup();
  const appliedRoot = obj(applied.processes[1].payload.processDataSet);
  delete (obj(appliedRoot.exchanges).exchange as Json[])[0].allocations;
  obj(appliedRoot.modellingAndValidation).LCIMethodAndAllocation = { typeOfDataSet: 'LCI result' };
  await assert.rejects(build(applied), /Already allocated inventory cannot participate/);
});

test('unallocated cancellation across mixed exact Flow versions also requires unambiguous basis', async () => {
  const fixture = setup();
  for (const source of fixture.processes)
    delete (obj(obj(source.payload.processDataSet).exchanges).exchange as Json[])[0].allocations;
  const items = obj(obj(fixture.processes[1].payload.processDataSet).exchanges).exchange as Json[];
  const duplicate = structuredClone(items[0]);
  duplicate['@dataSetInternalID'] = '3';
  obj(duplicate.referenceToFlowDataSet)['@version'] = '02.00.000';
  items.push(duplicate);
  await assert.rejects(build(fixture, false, true), /Mixed exact Flow\/basis cancellation/);
});
