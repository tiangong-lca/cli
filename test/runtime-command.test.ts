import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCli } from '../src/cli.js';

const deps = {
  env: {},
  dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
  fetchImpl: async () => {
    throw new Error('Runtime inspection must not authenticate or fetch.');
  },
};

test('runtime describe is a local machine command with package and executable content identity', async () => {
  const result = await executeCli(['runtime', 'describe', '--json'], deps);
  assert.equal(result.exitCode, 0, result.stderr);
  const descriptor = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(descriptor.schema, 'tiangong-lca.cli-runtime-descriptor.v1');
  assert.match(String(descriptor.content_sha256), /^[0-9a-f]{64}$/u);
});

test('runtime parsing stays local, strict and independent of user dotenv configuration', async (t) => {
  const { isRuntimeCommand, runRuntimeCommand } =
    await import('../src/commands/runtime/command.js');
  const { describeCliRuntime, RUNTIME_PLATFORMS } = await import('../src/runtime.js');
  const descriptor = describeCliRuntime();
  assert.equal(Reflect.set(RUNTIME_PLATFORMS, 0, 'darwin-x64'), false);
  for (const args of [[], ['doctor'], ['--bad', 'runtime']])
    assert.equal(isRuntimeCommand(args), false);
  for (const args of [['runtime'], ['--', 'runtime'], ['--help', '-v', 'runtime']])
    assert.equal(isRuntimeCommand(args), true);
  assert.match((await runRuntimeCommand(null, [])).stdout, /Usage/u);
  assert.match((await runRuntimeCommand('describe', ['--help'])).stdout, /No authentication/u);
  assert.match((await runRuntimeCommand('describe', [], () => descriptor)).stdout, /Content/u);
  await assert.rejects(runRuntimeCommand('future', []), /Unknown runtime/u);
  await assert.rejects(runRuntimeCommand('describe', ['--token', 'forbidden']), /declared flags/u);
  await assert.rejects(runRuntimeCommand('describe', ['unexpected']), /declared flags/u);
  const invalid = await executeCli(['runtime', 'future', '--json'], deps);
  assert.equal(invalid.exitCode, 2);

  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { main } = await import('../src/main.js');
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runtime-env-'));
  fs.writeFileSync(path.join(directory, '.env'), 'RUNTIME_TEST_SENTINEL=must-not-load\n');
  let output = '';
  let error = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    error += String(chunk);
    return true;
  });
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  try {
    process.chdir(directory);
    const env = {};
    assert.equal(await main(['runtime', 'describe', '--json'], env), 0);
    assert.deepEqual(env, {});
    assert.equal(error, '');
    assert.equal(JSON.parse(output).scope, 'cli-package');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    assert.equal(await main(['auth', 'status'], env), 69);
    assert.match(error, /RUNTIME_PLATFORM_UNSUPPORTED/u);
    assert.deepEqual(env, {});
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'arch', originalArch);
    process.chdir(previous);
    t.mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
