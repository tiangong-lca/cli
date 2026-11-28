import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { withMutationJournal } from '../src/adapters/private-mutation-journal.js';
import { contentDigest } from '../src/shared/json-content-digest.js';
import { sha256Json, stableJsonText } from '../src/lib/platform/canonical-json-hash.js';

test('private storage preserves existing insertion-order journal names and caller-owned receipt shape', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-journal-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    directory,
    requestId: 'original-request',
    target: {
      type: 'contact',
      id: 'id',
      version: '00.00.001',
      environment: 'https://example.test',
    },
    scope: 'dataset' as const,
  };
  const original = {
    schemaVersion: 1,
    binding: 'original-binding',
    state: 'completed',
    response: { exact: 'receipt' },
  };
  const file = await withMutationJournal(options, async (store) => {
    assert.equal(store.read(), null);
    store.write(original);
    assert.deepEqual(store.read(), original);
    assert.throws(() => store.write(original, false), /writable new path/);
    return store.path;
  });
  const oldKey = createHash('sha256').update(JSON.stringify(options.requestId)).digest('hex');
  assert.equal(file, path.join(directory, `${oldKey}.json`));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
  for (const invalid of ['null', '[]', '"value"']) {
    writeFileSync(file, invalid, { mode: 0o600 });
    await assert.rejects(
      withMutationJournal(options, async (store) => store.read()),
      /JSON object/,
    );
  }
});

test('canonical object hashes and newline-bound artifact hashes remain byte-distinct', () => {
  const value = { z: '中文', a: { second: -0, first: ['é', null] } };
  const canonical = '{"a":{"first":["é",null],"second":0},"z":"中文"}';
  assert.equal(stableJsonText(value), canonical);
  assert.equal(sha256Json(value), createHash('sha256').update(canonical).digest('hex'));
  assert.notEqual(sha256Json(value), createHash('sha256').update(`${canonical}\n`).digest('hex'));
  assert.equal(
    contentDigest(value),
    createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  );
  assert.notEqual(contentDigest(value), sha256Json(value));
});

test('findTargetRecord skips unreadable or corrupt unrelated journals in sorted order', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-journal-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = {
    type: 'contact',
    id: 'id-target',
    version: '00.00.001',
    environment: 'https://example.test',
    actor: 'actor-1',
  };
  writeFileSync(path.join(directory, `${'0'.repeat(64)}.json`), '{corrupt-json', { mode: 0o600 });
  writeFileSync(path.join(directory, 'ignored-non-journal.json'), '{}', { mode: 0o600 });
  const matchPath = path.join(directory, `${'a'.repeat(64)}.json`);
  const matched = {
    schemaVersion: 1,
    binding: 'b1',
    state: 'unknown',
    ...target,
  };
  writeFileSync(matchPath, JSON.stringify(matched), { mode: 0o600 });
  const found = await withMutationJournal(
    { directory, requestId: 'new-request', target, scope: 'dataset' },
    async (store) => store.findTargetRecord?.(['unknown']),
  );
  assert.deepEqual(found, { path: matchPath, record: matched });
});
