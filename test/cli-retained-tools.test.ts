import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

function fixture() {
  let calls = 0;
  return {
    deps: {
      env: buildSupabaseTestEnv({ TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1' }),
      dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => '{"accepted":true}',
        };
      },
    },
    calls: () => calls,
  };
}
test('retained namespaces discover help and reject unsupported actions without IO', async () => {
  for (const args of [
    ['admin', '--help'],
    ['validation', '--help'],
    ['validation', 'run', '--help'],
  ]) {
    const f = fixture();
    const result = await executeCli(args, f.deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /tiangong-lca/);
    assert.equal(f.calls(), 0);
  }
  for (const args of [
    ['admin'],
    ['admin', 'unknown'],
    ['validation'],
    ['validation', 'unknown'],
    ['dataset', 'import-lca', 'unknown'],
  ]) {
    const f = fixture();
    const result = await executeCli(args, f.deps);
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(result.stderr).error.code,
      args[1] === 'import-lca' ? 'DATASET_IMPORT_LCA_ACTION_INVALID' : 'UNKNOWN_COMMAND',
    );
    assert.equal(f.calls(), 0);
  }
  for (const args of [
    ['admin', 'embedding-run', '--bad-flag'],
    ['admin', 'embedding-run', '--timeout-ms', '0'],
    ['validation', 'run', '--bad-flag'],
  ]) {
    const f = fixture();
    const result = await executeCli(args, f.deps);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /INVALID/);
    assert.equal(f.calls(), 0);
  }
});
test('admin transport keeps explicit target controls, compact output and dry-run effect boundary', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-retained-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json');
  writeFileSync(input, '{"job":"fixture"}');
  const f = fixture();
  const dry = await executeCli(
    [
      'admin',
      'embedding-run',
      '--input',
      input,
      '--dry-run',
      '--base-url',
      'https://override.example/functions/v1',
      '--region',
      'eu-west-1',
      '--timeout-ms',
      '1000',
      '--json',
    ],
    f.deps,
  );
  assert.equal(dry.exitCode, 0, dry.stderr);
  assert.match(dry.stdout, /override.example\/functions\/v1\/embedding_ft/);
  assert.equal(f.calls(), 0);
  const executed = await executeCli(['admin', 'embedding-run', '--input', input, '--json'], f.deps);
  assert.equal(executed.exitCode, 0, executed.stderr);
  assert.equal(executed.stdout, '{"accepted":true}\n');
  assert.equal(f.calls(), 1);
});
test('typed Dataset discovery and missing files fail before transport', async () => {
  const f = fixture();
  const help = await executeCli(['dataset'], f.deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Shared discovery/);
  const invalid = await executeCli(['dataset', '--bad-flag', '--json'], f.deps);
  assert.equal(invalid.exitCode, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'ARGUMENTS_INVALID');
  const missing = await executeCli(
    ['dataset', 'process', 'validate', '--input', '/missing/private-input.json', '--json'],
    f.deps,
  );
  assert.equal(missing.exitCode, 2);
  assert.equal(JSON.parse(missing.stdout).status, 'failed');
  assert.equal(f.calls(), 0);
});
