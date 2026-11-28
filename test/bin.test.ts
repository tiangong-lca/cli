import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

maybeTest(
  'native Dataset CLI reads identical file, descriptor and split multibyte pipe input',
  async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-stdin-'));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const file = path.join(dir, 'request.json');
    const entry = path.resolve('bin/tiangong-lca.js');
    const command = (input: string) => [
      entry,
      'dataset',
      'process',
      'save',
      '--dry-run',
      '--input',
      input,
      '--json',
    ];
    const runtime = { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir } };
    const bytes = Buffer.from(JSON.stringify({ offlineProbe: '天工'.repeat(35_000) }));
    writeFileSync(file, bytes);
    const assertResult = (stdout: string, status: number | null, code: string) => {
      assert.equal(status, 2);
      assert.equal(JSON.parse(stdout).error.code, code);
    };
    const named = spawnSync(process.execPath, command(file), { ...runtime, encoding: 'utf8' });
    assertResult(named.stdout, named.status, 'REQUEST_FIELD_UNSUPPORTED');

    for (const [mode, code] of [
      ['r', 'REQUEST_FIELD_UNSUPPORTED'],
      ['a', 'INPUT_READ_FAILED'],
    ]) {
      const fd = openSync(file, mode);
      try {
        const child = spawnSync(process.execPath, command('-'), {
          ...runtime,
          encoding: 'utf8',
          stdio: [fd, 'pipe', 'pipe'],
        });
        assertResult(child.stdout, child.status, code);
      } finally {
        closeSync(fd);
      }
    }

    const child = spawn(process.execPath, command('-'), runtime);
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    t.after(() => child.kill());
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', resolve);
    });
    // End a write inside the first UTF-8 character, leaving the same bytes to be decoded at EOF.
    const split = bytes.indexOf(Buffer.from('天')) + 1;
    child.stdin.write(bytes.subarray(0, split), () => child.stdin.end(bytes.subarray(split)));
    const status = await closed;
    assertResult(Buffer.concat(stdout).toString('utf8'), status, 'REQUEST_FIELD_UNSUPPORTED');

    const malformed = spawnSync(process.execPath, command('-'), {
      ...runtime,
      input: '{"broken":}',
      encoding: 'utf8',
    });
    assertResult(malformed.stdout, malformed.status, 'INPUT_INVALID_JSON');
  },
);
