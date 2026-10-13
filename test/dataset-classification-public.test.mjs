import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('public Source, Flow Property and Unit Group classifications preserve valid shapes', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tg-source-classification-public-'));
  const outDir = path.join(tempDir, 'proof');
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/ci/prove-source-classification.mjs'), '--out-dir', outDir],
      {
        cwd: tempDir,
        // The public proof executes compiled CLI children; source tests own coverage counting.
        env: { PATH: path.dirname(process.execPath), LANG: 'C', TZ: 'UTC', NODE_V8_COVERAGE: '' },
        encoding: 'utf8',
        shell: false,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const proof = JSON.parse(readFileSync(path.join(outDir, 'proof.json'), 'utf8'));
    const failures = proof.checks.filter(({ status }) => status !== 'passed');
    assert.equal(result.status, 0, JSON.stringify(failures, null, 2));
    assert.equal(proof.status, 'passed');
    assert.equal(proof.expectation, 'repaired');
    assert.equal(proof.commands.length, 49);
    assert.equal(proof.checks.length, 55);
    assert.deepEqual(JSON.parse(result.stdout), proof);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
