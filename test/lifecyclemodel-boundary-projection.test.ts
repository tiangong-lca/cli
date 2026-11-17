import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runLifecyclemodelBuildResultingProcess } from '../src/lib/model/resulting-process.js';
import { buildSolvedResultGroup } from '../src/lib/model/result/solved-group.js';
import { extractProcessInstances, parseProcessRecord } from '../src/lib/model/result/sources.js';
import { runDatasetValidate } from '../src/lib/dataset/validate.js';
import { CliError, toErrorPayload } from '../src/shared/errors.js';
import {
  allocationFixture,
  processTransportFixture,
} from './helpers/process-allocation-fixture.js';

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
  return {
    processes,
    instances,
    reference: 1 as unknown,
    overrides: {} as Json,
    modelDeclarations: {} as Json,
    modelComment: undefined as unknown,
    projectionMode: 'primary-only',
    targetAmount: undefined as number | undefined,
  };
}
async function run(
  fixture: ReturnType<typeof setup>,
  withFlowEvidence = true,
  existing?: { members: Json[]; processes: Json[] },
) {
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
        'common:generalComment': fixture.modelComment,
      },
      quantitativeReference:
        fixture.reference === undefined ? {} : { referenceToReferenceProcess: fixture.reference },
      technology: { processes: { processInstance: fixture.instances } },
    };
    const { context } = allocationFixture();
    const firstFlow = context.flow_documents[0];
    const productFlow = structuredClone(firstFlow);
    obj(obj(obj(productFlow.flowDataSet).flowInformation).dataSetInformation)['common:UUID'] =
      PRODUCT;
    const request = {
      ...(withFlowEvidence
        ? { semantic_context: { flow_documents: [firstFlow, productFlow] } }
        : {}),
      source_model: {
        json_ordered: {
          lifeCycleModelDataSet: {
            '@id': '77777777-7777-4777-8777-777777777777',
            '@version': VERSION,
            lifeCycleModelInformation: info,
            ...fixture.modelDeclarations,
          },
        },
      },
      projection: {
        mode: fixture.projectionMode,
        target_amount: fixture.targetAmount,
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
        existing,
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
    return { result, payload, projection, validation, report, bundle };
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
test('Model generation composes all output references from exact evidence and reports missing documents', async () => {
  const fixture = setup();
  const built = await run(fixture);
  assert.equal(built.result.exitCode, 0, built.result.stderr);
  const exchanges = obj(obj(built.payload!.processDataSet).exchanges).exchange as Json[];
  for (const exchange of exchanges) {
    assert.deepEqual(obj(exchange.referenceToFlowDataSet)['common:shortDescription'], [
      {
        '@xml:lang': 'en',
        '#text': 'Fixture reference product; Synthetic fixture; Global synthetic flow',
      },
    ]);
  }
  const unresolved = await run(fixture, false);
  assert.deepEqual(unresolved.projection!.qualification, {
    status: 'unresolved',
    publish_ready: false,
  });
  assert.equal(
    obj(obj(unresolved.projection!.validation).flow_reference_names).status,
    'unresolved',
  );
  assert.deepEqual(quantities(unresolved.payload!), quantities(built.payload!));
});

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
test('authored Model declarations reach the qualified candidate without changing inventory or source references', async () => {
  const fixture = setup('5');
  const input = processTransportFixture();
  const sourceInformation = obj(input.processDataSet);
  const sourceAdmin = obj(sourceInformation.administrativeInformation);
  const owner = structuredClone(
    obj(sourceAdmin.publicationAndOwnership)['common:referenceToOwnershipOfDataSet'],
  ) as Json;
  owner['@refObjectId'] = '99999999-9999-4999-8999-999999999999';
  const localized = [
    { '@xml:lang': 'en', '#text': 'Whole-system declaration' },
    { '@xml:lang': 'zh', '#text': '全系统声明' },
  ];
  const source = obj(fixture.processes[1].processDataSet);
  const treatment = (payload: Json) =>
    obj(obj(payload.modellingAndValidation).dataSourcesTreatmentAndRepresentativeness);
  treatment(source).useAdviceForDataSet = [{ '@xml:lang': 'en', '#text': 'Component use only' }];
  obj(obj(source.administrativeInformation).publicationAndOwnership)['common:accessRestrictions'] =
    [{ '@xml:lang': 'en', '#text': 'Component access only' }];
  const baseline = await run(fixture);
  fixture.modelComment = localized;
  const sourceGoal = obj(sourceAdmin['common:commissionerAndGoal']);
  const modelGoal = {
    'common:referenceToCommissioner': sourceGoal['common:referenceToCommissioner'],
    'common:intendedApplications': localized,
  };
  const modelRights = {
    'common:referenceToOwnershipOfDataSet': owner,
    'common:copyright': 'true',
    'common:licenseType': 'Other',
    'common:accessRestrictions': localized,
  };
  fixture.modelDeclarations = {
    modellingAndValidation: {
      dataSourcesTreatmentEtc: { useAdviceForDataSet: localized },
    },
    administrativeInformation: {
      'common:commissionerAndGoal': modelGoal,
      publicationAndOwnership: modelRights,
    },
  };
  const result = await run(fixture);
  assert.equal(result.validation!.exitCode, 0);
  assert.deepEqual(result.projection!.qualification, { status: 'qualified', publish_ready: true });
  const projected = obj(result.payload!.processDataSet);
  const original = obj(baseline.payload!.processDataSet);
  assert.deepEqual(projected.exchanges, original.exchanges);
  const { 'common:generalComment': comment, ...resultIdentity } = obj(
    obj(projected.processInformation).dataSetInformation,
  );
  const { 'common:generalComment': sourceComment, ...baselineIdentity } = obj(
    obj(original.processInformation).dataSetInformation,
  );
  assert.deepEqual(resultIdentity, baselineIdentity);
  assert.notDeepEqual(comment, sourceComment);
  assert.deepEqual(
    (comment as Json[]).map((entry) => [
      entry['@xml:lang'],
      String(entry['#text']).split('\n\n')[0],
    ]),
    [
      ['en', 'Whole-system declaration'],
      ['zh', '全系统声明'],
    ],
  );
  assert.match(String((comment as Json[])[0]['#text']), /generated from lifecycle model/);
  const projectedAdmin = obj(projected.administrativeInformation);
  assert.deepEqual(projectedAdmin['common:commissionerAndGoal'], modelGoal);
  const publication = obj(projectedAdmin.publicationAndOwnership);
  for (const [field, value] of Object.entries(modelRights)) {
    assert.deepEqual(publication[field], value);
  }
  assert.equal(publication['common:dataSetVersion'], VERSION);
  assert.deepEqual(treatment(projected), {
    ...treatment(original),
    useAdviceForDataSet: localized,
  });

  modelRights['common:accessRestrictions'] = [];
  obj(
    obj(fixture.modelDeclarations.modellingAndValidation).dataSourcesTreatmentEtc,
  ).useAdviceForDataSet = [];
  const cleared = await run(fixture);
  assert.equal(cleared.validation!.exitCode, 0);
  const clearedRoot = obj(cleared.payload!.processDataSet);
  assert.equal(treatment(clearedRoot).useAdviceForDataSet, undefined);
  assert.equal(
    obj(obj(clearedRoot.administrativeInformation).publicationAndOwnership)[
      'common:accessRestrictions'
    ],
    undefined,
  );

  obj(obj(fixture.modelDeclarations.administrativeInformation).publicationAndOwnership)[
    'common:licenseType'
  ] = undefined;
  const incomplete = await run(fixture);
  assert.equal(obj(incomplete.projection!.qualification).publish_ready, false);
  assert.equal(
    obj(
      obj(obj(incomplete.payload!.processDataSet).administrativeInformation)
        .publicationAndOwnership,
    )['common:licenseType'],
    undefined,
  );
});

test('all-subproducts solves independent source-unit results and preserves the main target', async () => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  fixture.targetAmount = 10;
  const upstream = obj(fixture.processes[0].processDataSet);
  const exchange = (obj(upstream.exchanges).exchange as Json[])[0];
  delete obj(exchange.referenceToFlowDataSet)['common:shortDescription'];
  const built = await run(fixture);
  assert.equal(built.result.exitCode, 0, built.result.stderr);
  assert.equal(built.projection!.expected_member_count, 2);
  assert.equal(built.projection!.emitted_member_count, 2);
  assert.deepEqual(built.projection!.missing_members, []);
  assert.deepEqual(quantities(built.payload!), [[PRODUCT, 'Output', '10']]);
});

test('all-subproducts accepts legacy downstream references and rejects invalid exact Process exchanges', async () => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  obj(obj(fixture.instances[0].connections).outputExchange).downstreamProcess = {
    '@refObjectId': '1',
  };
  const legacy = await run(fixture);
  assert.equal(legacy.result.exitCode, 0, legacy.result.stderr);
  assert.deepEqual(quantities(legacy.payload!), [[PRODUCT, 'Output', '1']]);

  const upstream = obj(fixture.processes[0].processDataSet);
  const exchange = (obj(upstream.exchanges).exchange as Json[])[0];
  exchange.exchangeDirection = 'invalid';
  const direction = await run(fixture);
  assert.match(direction.result.stderr, /Invalid direction in exact Process/);

  exchange.exchangeDirection = 'Output';
  exchange.resultingAmount = 'invalid';
  const amount = await run(fixture);
  assert.equal(amount.result.exitCode, 2);
  assert.match(amount.result.stderr, /Model calculation failed/);
});

test('solved groups refuse a missing selection or an inexact Process source', async () => {
  const fixture = setup();
  const model = {
    lifeCycleModelInformation: {
      technology: { processes: { processInstance: fixture.instances } },
    },
  };
  const sources = fixture.processes.map((raw) =>
    parseProcessRecord(raw, { sourceLabel: 'test Process', sourcePath: null }),
  );
  const records = Object.fromEntries(
    sources.map((source) => [source.processUuid + '@' + source.version, source]),
  );
  const options = {
    model,
    identity: { id: '77777777-7777-4777-8777-777777777777', version: VERSION, name: 'Test Model' },
    modelName: {},
    referenceInstance: '1',
    primary: { id: '88888888-8888-4888-8888-888888888888', version: VERSION },
    instances: extractProcessInstances(model),
    edges: [],
    records,
    signature: 'test',
    metadataOverrides: {},
  };
  await assert.rejects(
    buildSolvedResultGroup({ ...options, referenceInstance: null }),
    /Select an exact reference instance/,
  );
  await assert.rejects(
    buildSolvedResultGroup({ ...options, records: {} }),
    /exact Process source is unavailable/,
  );
  const reference = sources[1];
  records[reference.processUuid + '@' + reference.version] = {
    ...reference,
    version: '02.00.000',
  };
  await assert.rejects(buildSolvedResultGroup(options), /exact Process source is unavailable/);
});

test('all-subproducts applies a complete allocation vector and rejects an invalid declared split', async () => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  fixture.reference = 0;
  fixture.targetAmount = 100;
  const source = component('55555555-5555-4555-8555-555555555555', [
    [FLOW, 'Output', '100'],
    [PRODUCT, 'Output', '20'],
    [FLOW, 'Input', '100'],
  ]);
  fixture.processes = [source];
  fixture.instances = [fixture.instances[0]];
  delete fixture.instances[0].connections;
  const exchanges = obj(obj(source.processDataSet).exchanges).exchange as Json[];
  exchanges[1].quantitativeReference = false;
  exchanges[2].quantitativeReference = false;
  exchanges[2].allocations = {
    allocation: [
      { '@internalReferenceToCoProduct': '1', '@allocatedFraction': '80' },
      { '@internalReferenceToCoProduct': '2', '@allocatedFraction': '20' },
    ],
  };
  const built = await run(fixture);
  assert.equal(built.result.exitCode, 0, built.result.stderr);
  assert.equal(built.projection!.expected_member_count, 4);
  assert.ok(
    quantities(built.payload!).some(
      ([flow, direction, amount]) => flow === FLOW && direction === 'Input' && amount === '80',
    ),
  );

  (obj(exchanges[2].allocations).allocation as Json[]).pop();
  const missing = await run(fixture);
  assert.equal(missing.result.exitCode, 2, missing.result.stderr);
  assert.match(missing.result.stderr, /allocation/i);
});

test('all-subproducts keeps independent saved result versions and fails on ambiguous prior membership', async () => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  const initial = await run(fixture);
  assert.equal(initial.result.exitCode, 0, initial.result.stderr);
  const candidates = initial.bundle!.projected_processes as Json[];
  const members = candidates.map(({ id, role, finalId }) => ({
    id,
    version: '02.00.000',
    type: role,
    finalId,
  }));
  const processes = candidates.map(({ id, json_ordered }) => ({
    id,
    version: '02.00.000',
    json_ordered,
  }));
  const retained = await run(fixture, true, { members, processes });
  assert.equal(retained.result.exitCode, 0, retained.result.stderr);
  assert.deepEqual(
    (retained.bundle!.projected_processes as Json[]).map(({ id, version }) => [id, version]),
    members.map(({ id, version }) => [id, version]),
  );
  const authored = structuredClone(processes);
  const processRoot = obj(obj(authored[0].json_ordered).processDataSet);
  delete obj(obj(processRoot.processInformation).dataSetInformation).classificationInformation;
  const modelling = obj(processRoot.modellingAndValidation);
  obj(modelling.dataSourcesTreatmentAndRepresentativeness).annualSupplyOrProductionVolume = {
    '@xml:lang': 'en',
    '#text': '10 Fixture reference product',
  };
  const edited = await run(fixture, true, { members, processes: authored });
  assert.equal(edited.result.exitCode, 0, edited.result.stderr);
  assert.equal(obj(edited.projection!.qualification).draft_ready, true);
  assert.equal(obj(edited.projection!.qualification).publish_ready, false);

  const missing = await run(fixture, true, { members, processes: [] });
  assert.match(missing.result.stderr, /no verified stored payload/);
  const duplicate = await run(fixture, true, { members: [...members, members[0]], processes });
  assert.match(duplicate.result.stderr, /More than one stored result/);
  const collision = await run(fixture, true, {
    members: [members[0], { ...members[1], id: members[0].id }],
    processes,
  });
  assert.match(collision.result.stderr, /conflicting identities/);
  fixture.targetAmount = 0;
  const invalid = await run(fixture);
  assert.match(invalid.result.stderr, /TARGET_AMOUNT_INVALID/);
});

test('all-subproducts refuses an unloadable solver or a reply that omits its primary or pivot', async () => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  let moduleSource = 'throw new Error("fixture kernel import failed");';
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/assets/model-result-kernel/index.mjs')) {
        return nextResolve('data:text/javascript,' + encodeURIComponent(moduleSource), context);
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const unloaded = await run(fixture);
    assert.match(unloaded.result.stderr, /fixture kernel import failed/);
    const result = {
      groups: [] as Json[],
      productSystem: { refInstanceIndex: '1', instances: [] },
    };
    const useResult = () => {
      moduleSource =
        'export function runMatrixCalculation() { return ' +
        JSON.stringify({ ok: true, result }) +
        '; } export default { __esModule: true, runMatrixCalculation };';
    };
    useResult();
    const missingPrimary = await run(fixture);
    assert.match(missingPrimary.result.stderr, /missing a primary result/);
    result.groups.push({
      type: 'primary',
      root: { instanceIndex: '1' },
      pivotFlowId: PRODUCT,
      pivotDirection: 'OUTPUT',
      exchanges: [],
      refProcesses: [],
    });
    useResult();
    const missingPivot = await run(fixture);
    assert.match(missingPivot.result.stderr, /no quantitative reference/);
  } finally {
    hooks.deregister();
  }
});

test('all-subproducts fails before generation if its pinned calculation artifact is corrupt or missing', async (t) => {
  const fixture = setup();
  fixture.projectionMode = 'all-subproducts';
  const original = fs.readFileSync;
  let corrupt = true;
  const mock = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    const [file] = args;
    if (!String(file).includes('/assets/model-result-kernel/index.mjs')) {
      return original(...args);
    }
    if (corrupt) return Buffer.from('invalid kernel artifact');
    throw new Error('calculation artifact unavailable');
  });
  syncBuiltinESMExports();
  try {
    const tampered = await run(fixture);
    assert.equal(tampered.result.exitCode, 2);
    assert.match(tampered.result.stderr, /failed integrity verification/);
    corrupt = false;
    const absent = await run(fixture);
    assert.equal(absent.result.exitCode, 1);
    assert.match(absent.result.stderr, /artifact unavailable/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
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
