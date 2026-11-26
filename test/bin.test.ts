import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const maybeTest = process.env.TIANGONG_LCA_COVERAGE === '1' ? test.skip : test;

maybeTest('runFromBin executes when imported without direct auto-run', async () => {
  const { runFromBin } = await import('../bin/tiangong-lca.js');
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await runFromBin(['doctor', '--json'], buildSupabaseTestEnv());

    assert.equal(exitCode, 0);
    const value = JSON.parse(stdout);
    assert.equal(value.operation, 'doctor');
    assert.equal(value.status, 'completed');
    assert.equal(value.data.configuration.ok, true);
    assert.ok(value.completeness.notChecked.includes('service_connections'));
    assert.equal(stderr, '');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});
