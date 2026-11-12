import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  truncateSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { spawnSync } from 'node:child_process';
import {
  modelRuntimeFile,
  readModelRuntime,
  resolveModelRuntime,
  setupModelRuntime,
} from '../src/adapters/model-runtime.js';
import { readLocalCalculation } from '../src/adapters/calculation.js';
import { runSetupCommand } from '../src/commands/setup.js';
import { runCalculationCommand } from '../src/commands/calculation.js';
import { executeCli } from '../src/cli.js';
import { CommandInputError } from '../src/shared/command-result.js';
import type { JsonObject } from '../src/application/dataset-types.js';
const capability = {
  schemaVersion: 1,
  status: 'ready',
  profile: 'lca.model-local.v1',
  inputSchema: 'lca.model-input.v1',
  characterization: 'method-defined-sparse',
  methodCount: 25,
};
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fakeEngine = ((...args: unknown[]) => {
  assert.equal((args[2] as { env: NodeJS.ProcessEnv }).env.TIANGONG_LCA_ACCESS_TOKEN, undefined);
  assert.equal((args[1] as string[])[0], '--check');
  return { status: 0, stdout: JSON.stringify(capability) };
}) as typeof spawnSync;

test('setup verifies before persistence and selects explicit, environment, saved configuration in order', (t) => {
  const dir = fixture(t);
  const env = { XDG_STATE_HOME: dir, TIANGONG_LCA_ACCESS_TOKEN: 'secret' };
  assert.deepEqual(readModelRuntime(env), {});
  assert.throws(() => resolveModelRuntime({}, env), /Run setup/u);
  const request = { engine: './engine', staticCache: dir };
  assert.equal(setupModelRuntime({ ...request, check: true }, env, fakeEngine).configured, false);
  assert.equal(existsSync(modelRuntimeFile(env)), false);
  assert.equal(setupModelRuntime(request, env, fakeEngine).configured, true);
  assert.equal(resolveModelRuntime({}, env).engine, path.resolve('./engine'));
  assert.equal(
    resolveModelRuntime({ engine: 'explicit' }, { ...env, TIANGONG_LCA_MODEL_ENGINE: 'env' })
      .engine,
    'explicit',
  );
  assert.equal(resolveModelRuntime({}, { ...env, TIANGONG_LCA_MODEL_ENGINE: 'env' }).engine, 'env');
  assert.equal(
    resolveModelRuntime({}, { ...env, TIANGONG_LCA_MODEL_STATIC_CACHE: 'cache' }).staticCache,
    path.resolve('cache'),
  );
  const file = modelRuntimeFile(env);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const previous = readFileSync(file, 'utf8');
  for (const report of [
    { status: null, error: new Error('timeout') },
    { status: 1 },
    { status: 0, stdout: 'bad' },
    { status: 0, stdout: '[]' },
    ...[
      { status: 'failed' },
      { profile: 'other' },
      { inputSchema: 'other' },
      { characterization: 'old' },
      { methodCount: 0 },
      { methodCount: 0.5 },
    ].map((v) => ({ status: 0, stdout: JSON.stringify({ ...capability, ...v }) })),
  ]) {
    assert.throws(() =>
      setupModelRuntime(request, env, (() => report) as unknown as typeof spawnSync),
    );
    assert.equal(readFileSync(file, 'utf8'), previous);
  }
  for (const content of [
    'bad',
    '[]',
    '{}',
    '{"schemaVersion":1,"engine":1,"staticCache":"x"}',
    '{"schemaVersion":1,"engine":"x","staticCache":1}',
  ]) {
    writeFileSync(file, content);
    assert.throws(() => readModelRuntime(env), /configuration is invalid/u);
  }
  // Explicit valid replacement can repair a corrupt saved file without first consuming it.
  setupModelRuntime({ engine: 'engine', staticCache: dir }, env, fakeEngine);
  assert.equal(readModelRuntime(env).engine, 'engine');
  setupModelRuntime({ engine: path.resolve('engine'), staticCache: dir }, env, fakeEngine);
  assert.equal(readModelRuntime(env).engine, path.resolve('engine'));
  assert.throws(
    () => setupModelRuntime({ engine: 'nonexistent-engine-for-test', staticCache: dir }, env),
    /check failed/u,
  );
});

function savedRun(dir: string) {
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(value));
  const summary = { schemaVersion: 1, status: 'completed', profile: 'lca.model-local.v1' };
  const prepared = {
    profileId: summary.profile,
    modelHash: 'internal',
    numeric: {
      inventoryAxes: [{ flowId: 'f' }],
      methodAxes: [{ methodId: 'm' }],
      views: [{ instanceId: 'p' }],
    },
  };
  const result = { profileId: summary.profile, modelHash: 'internal', g: [7], h: [0], x: [1] };
  write('summary', summary);
  write('prepared', prepared);
  write('result', result);
  return { write, summary, prepared, result };
}

test('saved calculation joins immutable axes and values without engine, network, or recalculation', (t) => {
  const dir = fixture(t);
  const f = savedRun(dir);
  assert.equal(readLocalCalculation(dir, 'summary').status, 'completed');
  assert.deepEqual(readLocalCalculation(dir, 'lci').items, [{ flowId: 'f', amount: 7 }]);
  assert.deepEqual(readLocalCalculation(dir, 'lcia').items, [{ methodId: 'm', amount: 0 }]);
  assert.deepEqual(readLocalCalculation(dir, 'activities').items, [{ instanceId: 'p', amount: 1 }]);
  for (const change of [{ schemaVersion: 2 }, { status: 'running' }, { profile: 'other' }]) {
    f.write('summary', { ...f.summary, ...change });
    assert.throws(() => readLocalCalculation(dir, 'summary'), /not a completed/u);
  }
  f.write('summary', f.summary);
  for (const change of [
    { profileId: 'other' },
    { modelHash: undefined },
    { modelHash: 'different' },
  ]) {
    f.write('prepared', { ...f.prepared, ...change });
    assert.throws(() => readLocalCalculation(dir, 'lci'), /same calculation/u);
  }
  f.write('prepared', f.prepared);
  f.write('result', { ...f.result, profileId: 'other' });
  assert.throws(() => readLocalCalculation(dir, 'lci'), /same calculation/u);
  for (const g of [undefined, [], [null], ['7']]) {
    f.write('result', { ...f.result, g });
    assert.throws(() => readLocalCalculation(dir, 'lci'), /inconsistent/u);
  }
  f.write('result', f.result);
  f.write('prepared', { ...f.prepared, numeric: { inventoryAxes: undefined } });
  assert.throws(() => readLocalCalculation(dir, 'lci'), /inconsistent/u);
  for (const raw of ['invalid', '[]']) {
    writeFileSync(path.join(dir, 'summary.json'), raw);
    assert.throws(() => readLocalCalculation(dir, 'summary'), /Cannot read/u);
  }
  truncateSync(path.join(dir, 'summary.json'), 256 * 1024 * 1024 + 1);
  assert.throws(() => readLocalCalculation(dir, 'summary'), /Cannot read/u);
  rmSync(path.join(dir, 'summary.json'));
  assert.throws(() => readLocalCalculation(dir, 'summary'), /Cannot read/u);
  mkdirSync(path.join(dir, 'summary.json'));
  assert.throws(() => readLocalCalculation(dir, 'summary'), /Cannot read/u);
});

test('setup discovery and errors are truthful and root-routed without authentication', async (t) => {
  const dir = fixture(t);
  const env = { XDG_STATE_HOME: dir };
  const setup = (r: JsonObject) => setupModelRuntime(r, env, fakeEngine);
  for (const args of [
    [],
    ['--json'],
    ['model-calculation', '--help'],
    ['model-calculation', '--help', '--json'],
  ])
    assert.equal((await runSetupCommand(args, setup)).exitCode, 0);
  for (const args of [
    ['unknown'],
    ['model-calculation', '--check', '--check'],
    ['model-calculation', '--bogus'],
  ])
    assert.equal((await runSetupCommand([...args, '--json'], setup)).exitCode, 2);
  assert.equal((await runSetupCommand(['model-calculation', '--json'], setup)).exitCode, 1);
  for (const extra of [[], ['--check']]) {
    const r = await runSetupCommand(
      ['model-calculation', '--engine', 'engine', '--static-cache', dir, '--json', ...extra],
      setup,
    );
    assert.equal(r.exitCode, 0, r.stdout);
    assert.equal(JSON.parse(r.stdout).data.configured, !extra.length);
  }
  const deps = {
    env,
    fetchImpl: async () => {
      throw new Error('Unexpected network');
    },
    dotEnvStatus: { loaded: false, path: '', count: 0 },
  } as Parameters<typeof executeCli>[1];
  assert.equal((await executeCli(['setup', '--help', '--json'], deps)).exitCode, 0);
  assert.equal(
    (
      await executeCli(
        [
          'setup',
          'model-calculation',
          '--engine',
          'nonexistent-test-engine',
          '--static-cache',
          dir,
          '--json',
        ],
        deps,
      )
    ).exitCode,
    1,
  );
});

test('calculation discovery, compact results and complete files preserve saved Run truth', async (t) => {
  const dir = fixture(t);
  savedRun(dir);
  for (const args of [[], ['--json'], ['get', '--help'], ['result', '--help', '--json']])
    assert.equal((await runCalculationCommand(args, readLocalCalculation)).exitCode, 0);
  for (const args of [
    ['unknown'],
    ['get'],
    ['get', '--bogus'],
    ['get', '--dir', dir, '--dir', dir],
    ['result', '--dir', dir, '--kind', 'summary'],
    ['result', '--dir', dir, '--kind', 'bad'],
  ])
    assert.equal(
      (await runCalculationCommand([...args, '--json'], readLocalCalculation)).exitCode,
      2,
    );
  assert.equal(
    (await runCalculationCommand(['get', '--dir', dir, '--json'], readLocalCalculation)).exitCode,
    0,
  );
  assert.equal(
    (await runCalculationCommand(['result', '--dir', dir, '--json'], readLocalCalculation))
      .exitCode,
    0,
  );
  const rows = Array.from({ length: 25 }, (_, i) => ({ amount: i }));
  const read = () => ({ items: rows, outputDirectory: dir });
  const compact = await runCalculationCommand(['result', '--dir', dir, '--json'], read);
  assert.equal(JSON.parse(compact.stdout).data.items.length, 20);
  assert.equal(JSON.parse(compact.stdout).completeness.truncated, true);
  const output = path.join(dir, 'lci.json');
  const complete = await runCalculationCommand(
    ['result', '--dir', dir, '--output', output, '--json'],
    read,
  );
  assert.equal(JSON.parse(complete.stdout).completeness.completeArtifact, true);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).items.length, 25);
  assert.equal(
    (await runCalculationCommand(['result', '--dir', dir, '--output', output, '--json'], read))
      .exitCode,
    2,
  );
  assert.notEqual(
    (
      await runCalculationCommand(['get', '--dir', dir], () => {
        throw new CommandInputError('FAIL', 'failed', 'precondition');
      })
    ).exitCode,
    0,
  );
  const deps = {
    env: { XDG_STATE_HOME: dir },
    fetchImpl: async () => {
      throw new Error('Unexpected network');
    },
    dotEnvStatus: { loaded: false, path: '', count: 0 },
  } as Parameters<typeof executeCli>[1];
  assert.equal(
    (await executeCli(['calculation', 'get', '--dir', dir, '--json'], deps)).exitCode,
    0,
  );
});
