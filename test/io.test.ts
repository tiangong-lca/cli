import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDistModule } from './helpers/load-dist-module.js';
import { readJsonInput, stringifyJson } from '../src/lib/platform/io.js';

async function loadDistIoModule(): Promise<typeof import('../src/lib/platform/io.js')> {
  return loadDistModule('src/lib/platform/io.js');
}

test('readJsonInput reads valid json files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-io-valid-'));
  const filePath = path.join(dir, 'input.json');
  writeFileSync(filePath, '{"hello":"world"}', 'utf8');

  try {
    assert.deepEqual(readJsonInput(filePath), { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonInput throws for missing and invalid files', () => {
  assert.throws(() => readJsonInput(''), /Missing required --input/u);
  assert.throws(() => readJsonInput('/tmp/does-not-exist.json'), /Input file not found/u);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-io-invalid-'));
  const filePath = path.join(dir, 'input.json');
  writeFileSync(filePath, '{broken', 'utf8');

  try {
    assert.throws(() => readJsonInput(filePath), /not valid JSON/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stringifyJson supports pretty and compact output', () => {
  assert.equal(stringifyJson({ hello: 'world' }, false), '{\n  "hello": "world"\n}\n');
  assert.equal(stringifyJson({ hello: 'world' }, true), '{"hello":"world"}\n');
});

test('io helpers behave the same from the built dist module', async () => {
  const io = await loadDistIoModule();

  assert.equal(io.stringifyJson({ hello: 'world' }, true), '{"hello":"world"}\n');
});
