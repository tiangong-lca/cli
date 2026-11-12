import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { spawnSync } from 'node:child_process';
import {
  calculationIdentity,
  numericalReferences,
  prepareModel,
} from '../src/application/model-calculation.js';
import { prepareModelInput, calculateLocalModel } from '../src/adapters/model-calculation.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { help } from '../src/commands/dataset/help.js';
import {
  type JsonObject,
  datasetWrappers,
  type DatasetType,
} from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
const ref = (id: string) => ({ '@refObjectId': id, '@version': '1' });
function doc(type: DatasetType, id: string, info: string, extra = {}): JsonObject {
  return {
    [datasetWrappers[type]]: {
      [info]: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': '1' } },
      ...extra,
    },
  };
}
const model = () =>
  doc('model', 'm', 'lifeCycleModelInformation', {
    lifeCycleModelInformation: {
      dataSetInformation: { 'common:UUID': 'm' },
      technology: {
        processes: {
          processInstance: [{ referenceToProcess: ref('p') }, { referenceToProcess: ref('b') }],
        },
      },
    },
  });
const process = (id = 'p') =>
  doc('process', id, 'processInformation', {
    exchanges: {
      exchange: [{ referenceToFlowDataSet: ref('f') }, { referenceToFlowDataSet: ref('f') }],
    },
  });
const flow = () =>
  doc('flow', 'f', 'flowInformation', {
    flowInformation: {
      dataSetInformation: { 'common:UUID': 'f' },
      quantitativeReference: { referenceToReferenceFlowProperty: '0' },
    },
    flowProperties: {
      flowProperty: { '@dataSetInternalID': '0', referenceToFlowPropertyDataSet: ref('fp') },
    },
  });
const property = () =>
  doc('flowproperty', 'fp', 'flowPropertiesInformation', {
    flowPropertiesInformation: {
      dataSetInformation: { 'common:UUID': 'fp' },
      quantitativeReference: { referenceToReferenceUnitGroup: ref('u') },
    },
  });
const group = () => doc('unitgroup', 'u', 'unitGroupInformation');
const bg = () => ({
  schemaVersion: 1,
  kind: 'lci',
  complete: true,
  source: { id: 'b', version: '1' },
});
const request = (): JsonObject => ({
  model: { content: model() },
  datasets: [process(), process('b'), flow(), property(), group()].map((content) => ({ content })),
  backgrounds: [{ content: bg() }],
  methods: [{ id: 'method', version: '1' }],
});
const noNetwork = async () => {
  throw new Error('Unexpected network');
};
const preparationPorts = {
  load: async (r: JsonObject) => r.content as JsonObject,
  read: noNetwork,
};

test('preparation closes explicit numerical references and keeps local inputs editable', async () => {
  const r = request();
  const prepared = await prepareModel(r, preparationPorts);
  assert.equal((prepared.datasets as unknown[]).length, 5);
  assert.equal(prepared.amount, 1);
  assert.equal(prepared.schemaVersion, 'lca.model-input.v1');
  assert.equal('hash' in prepared, false);
  assert.deepEqual(numericalReferences('contact', {}), []);
  assert.deepEqual(
    numericalReferences('model', doc('model', 'empty', 'lifeCycleModelInformation')),
    [],
  );
  assert.deepEqual(numericalReferences('process', process()), [
    { type: 'flow', id: 'f', version: '1' },
    { type: 'flow', id: 'f', version: '1' },
  ]);
  const available = new Map(
    [process(), process('b'), flow(), property(), group()].map((v) => [
      calculationIdentity(v).id,
      v,
    ]),
  );
  const reads: string[] = [];
  const remote = await prepareModel(
    {
      ...r,
      datasets: undefined,
      allowRemoteLookup: true,
      amount: 2,
      cutoffs: [],
      limits: { maxDocuments: 6 },
    },
    {
      ...preparationPorts,
      read: async (ref) => {
        reads.push(ref.id);
        return available.get(ref.id)!;
      },
    },
  );
  assert.equal(remote.amount, 2);
  assert.deepEqual(reads, ['p', 'b', 'f', 'fp', 'u']);
  // The background's original unresolvable exchange is irrelevant; only its explicit aggregated LCI is used.
  const b = process('b');
  (b.processDataSet as JsonObject).exchanges = {
    exchange: { referenceToFlowDataSet: ref('do-not-expand') },
  };
  const changed = request();
  (changed.datasets as JsonObject[])[1] = { content: b };
  assert.equal((await prepareModel(changed, preparationPorts)).schemaVersion, 'lca.model-input.v1');
  const withoutBackground = request();
  withoutBackground.backgrounds = undefined;
  assert.equal(
    (await prepareModel(withoutBackground, preparationPorts)).schemaVersion,
    'lca.model-input.v1',
  );
});

test('preparation reports actual incomplete or ambiguous inputs without network fallback', async () => {
  const mutations: Array<(r: JsonObject) => void> = [
    (r) => {
      r.hash = 'unneeded';
    },
    (r) => {
      r.allowRemoteLookup = 'yes';
    },
    (r) => {
      r.methods = {};
    },
    (r) => {
      r.methods = undefined;
    },
    (r) => {
      r.methods = [{ id: 'a', version: 'latest' }];
    },
    (r) => {
      r.methods = [
        { id: 'a', version: '1' },
        { id: 'a', version: '2' },
      ];
    },
    (r) => {
      r.amount = 0;
    },
    (r) => {
      r.amount = Infinity;
    },
    (r) => {
      r.amount = '1';
    },
    (r) => {
      r.limits = { maxDocuments: 0 };
    },
    (r) => {
      r.limits = { maxDocuments: 2 };
    },
    (r) => {
      r.model = { content: process() };
    },
    (r) => {
      r.datasets = [{ content: model() }];
    },
    (r) => {
      r.datasets = [{ content: process() }, { content: process() }];
    },
    (r) => {
      r.datasets = [];
    },
    (r) => {
      r.backgrounds = [{ content: { ...bg(), complete: false } }];
    },
    (r) => {
      r.backgrounds = [{ content: { ...bg(), kind: 'lcia' } }];
    },
    (r) => {
      r.backgrounds = [{ content: { ...bg(), schemaVersion: 2 } }];
    },
    (r) => {
      r.backgrounds = [{ content: bg() }, { content: bg() }];
    },
    (r) => {
      r.backgrounds = [{ content: { ...bg(), source: { id: 'unused', version: '1' } } }];
    },
  ];
  for (const change of mutations) {
    const r = request();
    change(r);
    await assert.rejects(prepareModel(r, preparationPorts));
  }
  await assert.rejects(
    prepareModel(
      { ...request(), datasets: [], allowRemoteLookup: true },
      { ...preparationPorts, read: async () => process('wrong') },
    ),
    /exact requested identity/u,
  );
  await assert.rejects(
    prepareModel(
      { ...request(), datasets: [], limits: { maxDocuments: 1 }, allowRemoteLookup: true },
      preparationPorts,
    ),
    /exceed/u,
  );
  assert.throws(() => calculationIdentity({}), /canonical/u);
  const badFlow = flow();
  const data = badFlow.flowDataSet as JsonObject;
  data.flowProperties = { flowProperty: [] };
  assert.throws(() => numericalReferences('flow', badFlow), /reference FlowProperty/u);
  data.flowProperties = { flowProperty: {} };
  delete (data.flowInformation as JsonObject).quantitativeReference;
  assert.throws(() => numericalReferences('flow', badFlow), /reference FlowProperty/u);
  const bad = process();
  (bad.processDataSet as JsonObject).exchanges = {
    exchange: { referenceToFlowDataSet: { ...ref('f'), '@version': 'latest' } },
  };
  assert.throws(() => numericalReferences('process', bad), /exact versions/u);
});

test('preparation adapter uses relative files and explicit authenticated exact reads only', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'model.json'), JSON.stringify(model()));
  const inputPath = path.join(dir, 'request.json');
  const r = request();
  r.model = { file: 'model.json' };
  assert.equal(
    (await prepareModelInput(r, inputPath, {}, noNetwork)).schemaVersion,
    'lca.model-input.v1',
  );
  await assert.rejects(
    prepareModelInput(
      { ...r, model: { file: 'model.json', content: model() } },
      inputPath,
      {},
      noNetwork,
    ),
    /exactly one/u,
  );
  await assert.rejects(
    prepareModelInput(
      { ...r, model: { remote: { id: 'm', version: 'latest' } } },
      inputPath,
      {},
      noNetwork,
    ),
    /exact remote/u,
  );
  let absent = false;
  const queries: string[] = [];
  const remoteDocs = [model(), process(), process('b'), flow(), property(), group()];
  const fetch = async (url: string) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    const u = new URL(String(url));
    queries.push(u.pathname);
    const id = u.searchParams.get('id')?.replace('eq.', '');
    const content = remoteDocs.find((v) => calculationIdentity(v).id === id)!;
    return new Response(JSON.stringify(absent ? [] : [{ id, version: '1', json: content }]), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const remoteRequest = {
    ...request(),
    model: { remote: { id: 'm', version: '1' } },
    datasets: [],
    allowRemoteLookup: true,
  };
  const result = await prepareModelInput(remoteRequest, inputPath, buildSupabaseTestEnv(), fetch);
  assert.equal((result.datasets as unknown[]).length, 5);
  assert.equal(queries.length, 6);
  absent = true;
  await assert.rejects(
    prepareModelInput(remoteRequest, inputPath, buildSupabaseTestEnv(), fetch),
    /not found or not visible/u,
  );
});

function engineFixture(dir: string, mode = 'ok'): typeof spawnSync {
  return ((
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; shell: boolean; timeout: number },
  ) => {
    assert.equal(command, 'configured-engine');
    assert.equal(options.shell, false);
    assert.equal(options.env.TIANGONG_LCA_ACCESS_TOKEN, undefined);
    assert.equal(args[0], '--input');
    assert.equal(JSON.parse(readFileSync(args[1]!, 'utf8')).schemaVersion, 'lca.model-input.v1');
    if (mode === 'error') return { status: null, error: new Error('timeout'), stderr: '' };
    if (mode === 'fail')
      return { status: 1, stderr: 'Error: study_unlinked_exchange\nprivate details' };
    if (mode === 'plain') return { status: 1, stderr: 'opaque failure' };
    mkdirSync(dir);
    for (const name of ['input', 'prepared', 'result'])
      writeFileSync(path.join(dir, `${name}.json`), '{}');
    const summary = {
      status: mode === 'status' ? 'failed' : 'completed',
      profile: mode === 'profile' ? 'other' : 'lca.model-local.v1',
      engine: 'tiangong-native',
      engineVersion: '0.1.0',
    };
    if (mode === 'missing') rmSync(path.join(dir, 'result.json'));
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
    return { status: 0, stderr: '', stdout: JSON.stringify(summary) };
  }) as typeof spawnSync;
}

test('local execution snapshots inputs, isolates credentials, respects budgets and retains failures', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-execution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { schemaVersion: 'lca.model-input.v1' };
  const base = {
    content: input,
    engine: 'configured-engine',
    staticCache: dir,
    outputDir: path.join(dir, 'run'),
  };
  const env = { PATH: processEnvPath(), TIANGONG_LCA_ACCESS_TOKEN: 'test-secret' };
  const r = calculateLocalModel(base, env, engineFixture(String(base.outputDir)));
  assert.equal(r.execution, 'local');
  assert.equal(r.timeoutMs, 120000);
  assert.equal((r.artifacts as unknown[]).length, 4);
  assert.throws(() => calculateLocalModel(base, env), /new output directory/u);
  for (const mode of ['error', 'fail', 'plain', 'status', 'profile', 'missing']) {
    const outputDir = path.join(dir, mode);
    assert.throws(
      () => calculateLocalModel({ ...base, outputDir }, env, engineFixture(outputDir, mode)),
      /did not/u,
    );
  }
  for (const extra of [
    { content: {} },
    { content: { ...input, limits: { maxInputBytes: 1 } } },
    { timeoutMs: 0 },
    { timeoutMs: 2147483648 },
    { content: { ...input, limits: { maxInputBytes: 0 } } },
  ])
    assert.throws(() =>
      calculateLocalModel({ ...base, outputDir: path.join(dir, 'invalid'), ...extra }, env),
    );
  const outputDir = path.join(dir, 'configured');
  assert.equal(
    calculateLocalModel(
      { content: { ...input, limits: { maxInputBytes: 1000 } }, outputDir, timeoutMs: 1000 },
      {
        ...env,
        TIANGONG_LCA_MODEL_ENGINE: 'configured-engine',
        TIANGONG_LCA_MODEL_STATIC_CACHE: dir,
      },
      engineFixture(outputDir),
    ).timeoutMs,
    1000,
  );
  assert.throws(
    () =>
      calculateLocalModel(
        { ...base, outputDir: path.join(dir, 'spawn'), engine: 'definitely-absent-local-engine' },
        env,
      ),
    /did not complete/u,
  );
});
function processEnvPath() {
  return globalThis.process.env.PATH;
}

test('command help, preparation artifacts and calculation completion remain separate', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ports = createDatasetPorts({}, noNetwork);
  const input = path.join(dir, 'request.json');
  writeFileSync(input, JSON.stringify(request()));
  assert.equal(
    (await runDatasetCommand(['model', 'prepare', '--input', input, '--json'], ports)).exitCode,
    2,
  );
  const prepared = path.join(dir, 'input.json');
  const value = await runDatasetCommand(
    ['model', 'prepare', '--input', input, '--output', prepared, '--json'],
    ports,
  );
  assert.equal(value.exitCode, 0, value.stdout);
  assert.equal(JSON.parse(value.stdout).data.datasetCount, 5);
  assert.equal(JSON.parse(readFileSync(prepared, 'utf8')).schemaVersion, 'lca.model-input.v1');
  const noEngine = await runDatasetCommand(
    [
      'model',
      'calculate',
      '--file',
      prepared,
      '--output-dir',
      path.join(dir, 'missing-engine'),
      '--json',
    ],
    ports,
  );
  assert.equal(noEngine.exitCode, 2);
  ports.operations = async () => ({
    engine: 'native',
    engineVersion: '1',
    outputDirectory: dir,
    artifacts: [],
    files: {},
    status: 'completed',
    completeLciaScores: false,
  });
  assert.equal(
    (
      await runDatasetCommand(
        ['model', 'calculate', '--file', prepared, '--output', prepared, '--force', '--json'],
        ports,
      )
    ).exitCode,
    2,
  );
  const calc = await runDatasetCommand(
    [
      'model',
      'calculate',
      '--file',
      prepared,
      '--output-dir',
      path.join(dir, 'run'),
      '--timeout-ms',
      '2000',
      '--engine',
      'native',
      '--static-cache',
      dir,
      '--json',
    ],
    ports,
  );
  assert.equal(calc.exitCode, 0);
  assert.equal(JSON.parse(calc.stdout).outcome, 'calculation_completed');
  assert.equal(help('model', 'prepare').request != null, true);
  assert.match(help('model', 'calculate').examples[0]!, /--file/u);
  assert.match(help('model', 'prepare').examples[0]!, /--output/u);
});
