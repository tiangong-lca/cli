import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDistModule } from './helpers/load-dist-module.js';
import {
  readJsonArtifact,
  readJsonLinesArtifact,
  writeJsonArtifact,
  writeJsonLinesArtifact,
  writeTextArtifact,
} from '../src/lib/platform/artifacts.js';

async function loadDistArtifactsModule(): Promise<
  typeof import('../src/lib/platform/artifacts.js')
> {
  return loadDistModule('src/lib/platform/artifacts.js');
}

test('writeTextArtifact writes plain text and creates parent directories', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-text-'));
  const filePath = path.join(dir, 'nested', 'artifact.txt');

  try {
    assert.equal(writeTextArtifact(filePath, 'hello\n'), filePath);
    assert.equal(readFileSync(filePath, 'utf8'), 'hello\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonArtifact and readJsonArtifact support pretty and compact JSON', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-json-'));
  const prettyPath = path.join(dir, 'pretty.json');
  const compactPath = path.join(dir, 'compact.json');

  try {
    writeJsonArtifact(prettyPath, { hello: 'world' });
    writeJsonArtifact(compactPath, { hello: 'world' }, true);

    assert.deepEqual(readJsonArtifact(prettyPath), { hello: 'world' });
    assert.deepEqual(readJsonArtifact(compactPath), { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonArtifact throws for missing and invalid JSON files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-json-errors-'));
  const invalidPath = path.join(dir, 'broken.json');

  writeFileSync(invalidPath, '{broken', 'utf8');

  try {
    assert.throws(
      () => readJsonArtifact(path.join(dir, 'missing.json')),
      /Artifact file not found/u,
    );
    assert.throws(() => readJsonArtifact(invalidPath), /Artifact file is not valid JSON/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonLinesArtifact and readJsonLinesArtifact support overwrite and append modes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-jsonl-'));
  const filePath = path.join(dir, 'events.jsonl');

  try {
    writeJsonLinesArtifact(filePath, { id: 1 });
    writeJsonLinesArtifact(filePath, [{ id: 2 }, { id: 3 }], { append: true });

    assert.deepEqual(readJsonLinesArtifact(filePath), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonLinesArtifact supports empty batches and preserves an empty JSONL artifact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-jsonl-empty-'));
  const filePath = path.join(dir, 'events.jsonl');

  try {
    writeJsonLinesArtifact(filePath, []);

    assert.equal(readFileSync(filePath, 'utf8'), '');
    assert.deepEqual(readJsonLinesArtifact(filePath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextArtifact cleans up temporary files when the atomic rename fails', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-atomic-fail-'));
  const targetPath = path.join(dir, 'blocked');

  try {
    mkdirSync(targetPath);

    assert.throws(() => writeTextArtifact(targetPath, 'hello\n'));
    assert.deepEqual(readdirSync(dir), ['blocked']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonLinesArtifact skips blank lines and throws on invalid JSONL', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-jsonl-errors-'));
  const validPath = path.join(dir, 'valid.jsonl');
  const invalidPath = path.join(dir, 'invalid.jsonl');

  writeFileSync(validPath, '{"id":1}\n\n {"id":2}\n', 'utf8');
  writeFileSync(invalidPath, '{"id":1}\n{broken}\n', 'utf8');

  try {
    assert.deepEqual(readJsonLinesArtifact(validPath), [{ id: 1 }, { id: 2 }]);
    assert.throws(
      () => readJsonLinesArtifact(invalidPath),
      /Artifact file contains invalid JSONL at line 2/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact helpers behave the same from the built dist module', async () => {
  const artifacts = await loadDistArtifactsModule();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-artifacts-dist-'));
  const textPath = path.join(dir, 'nested', 'artifact.txt');
  const jsonPath = path.join(dir, 'artifact.json');
  const jsonlPath = path.join(dir, 'artifact.jsonl');

  try {
    assert.equal(artifacts.writeTextArtifact(textPath, 'hello\n'), textPath);
    assert.equal(readFileSync(textPath, 'utf8'), 'hello\n');

    artifacts.writeJsonArtifact(jsonPath, { hello: 'world' }, true);
    assert.deepEqual(artifacts.readJsonArtifact(jsonPath), { hello: 'world' });

    artifacts.writeJsonLinesArtifact(jsonlPath, { id: 1 });
    artifacts.writeJsonLinesArtifact(jsonlPath, [{ id: 2 }], { append: true });
    assert.deepEqual(artifacts.readJsonLinesArtifact(jsonlPath), [{ id: 1 }, { id: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
