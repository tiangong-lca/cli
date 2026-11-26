import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isDirectEntry, main, maybeRunFromProcess } from '../src/main.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const integrationTest = process.env.TIANGONG_LCA_COVERAGE === '1' ? test.skip : test;

function makeRuntimeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    ...overrides,
  });
}

test('main writes stdout and stderr from CLI results', async () => {
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
    const exitCode = await main(['process', 'auto-build'], makeRuntimeEnv());

    assert.equal(exitCode, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /"code":"UNKNOWN_COMMAND"/u);
    assert.match(stderr, /Unknown command 'process auto-build'/u);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('main writes stdout for successful command results', async () => {
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
    const exitCode = await main(['doctor', '--json'], makeRuntimeEnv());

    assert.equal(exitCode, 0);
    assert.match(stdout, /"ok":true/u);
    assert.equal(stderr, '');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('isDirectEntry reports direct and non-direct execution states', () => {
  const mainPath = path.resolve(path.join(path.sep, 'tmp', 'main.ts'));
  const otherPath = path.resolve(path.join(path.sep, 'tmp', 'other.ts'));
  const mainUrl = pathToFileURL(mainPath).href;
  const direct = isDirectEntry(mainUrl, mainPath);
  const notDirect = isDirectEntry(mainUrl, otherPath);
  const missing = isDirectEntry(mainUrl, undefined);

  assert.equal(direct, true);
  assert.equal(notDirect, false);
  assert.equal(missing, false);
});

test('maybeRunFromProcess returns null when not running as the entry module', async () => {
  const mainPath = path.resolve(path.join(path.sep, 'tmp', 'main.ts'));
  const otherPath = path.resolve(path.join(path.sep, 'tmp', 'other.ts'));
  const exitCode = await maybeRunFromProcess(
    ['/usr/local/bin/node', otherPath, 'doctor', '--json'],
    makeRuntimeEnv(),
    pathToFileURL(mainPath).href,
  );

  assert.equal(exitCode, null);
});

test('maybeRunFromProcess executes the CLI when running as the entry module', async () => {
  const mainPath = path.resolve(path.join(path.sep, 'tmp', 'main.ts'));
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExitCode = process.exitCode;
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
    const exitCode = await maybeRunFromProcess(
      ['/usr/local/bin/node', mainPath, 'doctor', '--json'],
      makeRuntimeEnv(),
      pathToFileURL(mainPath).href,
    );

    assert.equal(exitCode, 0);
    assert.equal(process.exitCode, 0);
    assert.match(stdout, /"ok":true/u);
    assert.equal(stderr, '');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
});

integrationTest('bin entrypoint executes successfully in a child process', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-main-'));
  const repoRoot = path.resolve(process.cwd());
  const binPath = path.join(repoRoot, 'bin', 'tiangong-lca.js');
  const env = makeRuntimeEnv();

  writeFileSync(
    path.join(dir, '.env'),
    [
      `TIANGONG_LCA_API_BASE_URL=${env.TIANGONG_LCA_API_BASE_URL ?? ''}`,
      `TIANGONG_LCA_AUTH_MODE=${env.TIANGONG_LCA_AUTH_MODE ?? ''}`,
      `TIANGONG_LCA_OAUTH_CLIENT_ID=${env.TIANGONG_LCA_OAUTH_CLIENT_ID ?? ''}`,
      `TIANGONG_LCA_SESSION_FILE=${env.TIANGONG_LCA_SESSION_FILE ?? ''}`,
      `TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY=${env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY ?? ''}`,
    ].join('\n'),
    'utf8',
  );

  try {
    const result = spawnSync(process.execPath, [binPath, 'doctor', '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.operation, 'doctor');
    assert.equal(value.status, 'completed');
    assert.equal(value.data.configuration.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

integrationTest('dist/main.js executes successfully when run directly in a child process', () => {
  const repoRoot = path.resolve(process.cwd());
  const entryPath = path.join(repoRoot, 'dist', 'src', 'main.js');

  const result = spawnSync(process.execPath, [entryPath, 'doctor', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...makeRuntimeEnv(),
    },
  });

  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.operation, 'doctor');
  assert.equal(value.status, 'completed');
  assert.equal(value.data.configuration.ok, true);
});
