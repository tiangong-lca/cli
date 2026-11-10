import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv } from '../src/lib/config/dotenv.js';

test('loadDotEnv returns missing result when no file exists', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dotenv-missing-'));
  const env: NodeJS.ProcessEnv = {};

  try {
    const result = loadDotEnv(dir, env);
    assert.equal(result.loaded, false);
    assert.equal(result.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv loads missing keys and preserves existing keys', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dotenv-load-'));
  const env: NodeJS.ProcessEnv = {
    KEEP_ME: 'present',
  };

  writeFileSync(
    path.join(dir, '.env'),
    [
      'FOO=bar',
      'QUOTED="value"',
      "SINGLE='other'",
      'KEEP_ME=overwritten',
      '# COMMENT',
      'INVALID',
    ].join('\n'),
    'utf8',
  );

  try {
    const result = loadDotEnv(dir, env);
    assert.equal(result.loaded, true);
    assert.equal(result.count, 3);
    assert.equal(env.FOO, 'bar');
    assert.equal(env.QUOTED, 'value');
    assert.equal(env.SINGLE, 'other');
    assert.equal(env.KEEP_ME, 'present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
