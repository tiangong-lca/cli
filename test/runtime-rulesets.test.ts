import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  __testInternals,
  getVerifiedPublicRuleSelection,
} from '../src/lib/validation/runtime-rulesets.js';

test('runtime rule source loader verifies paths, hashes, and index identity', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-public-rules-'));
  const sourceRoot = path.resolve('assets/tidas-public-rules');
  const paths = {
    index: path.join(root, 'public-rules.v1.json'),
    schema: path.join(root, 'public-rules.v1.schema.json'),
    source: path.join(root, 'public-rules.source.v1.json'),
  };
  try {
    for (const [key, name] of Object.entries({
      index: 'public-rules.v1.json',
      schema: 'public-rules.v1.schema.json',
      source: 'public-rules.source.v1.json',
    })) {
      writeFileSync(paths[key as keyof typeof paths], readFileSync(path.join(sourceRoot, name)));
    }
    assert.equal(__testInternals.readVerifiedFallback(paths).rules.length, 9);
    assert.equal(
      __testInternals.publicAssetPath('ignored', [pathToFileURL(paths.index)]),
      paths.index,
    );
    assert.throws(
      () =>
        __testInternals.publicAssetPath('missing', [
          pathToFileURL(path.join(root, 'missing.json')),
        ]),
      /Unable to resolve bundled/u,
    );
    assert.throws(
      () => __testInternals.publicAssetPath('directory', [pathToFileURL(root)]),
      /EISDIR|illegal operation/u,
    );

    writeFileSync(paths.schema, 'tampered');
    assert.throws(
      () => __testInternals.readVerifiedFallback(paths),
      /identity or digest is stale/u,
    );
    writeFileSync(paths.schema, readFileSync(path.join(sourceRoot, 'public-rules.v1.schema.json')));

    const source = JSON.parse(readFileSync(paths.source, 'utf8')) as { commit: string };
    writeFileSync(paths.source, `${JSON.stringify({ ...source, commit: 'stale' }, null, 2)}\n`);
    assert.throws(
      () => __testInternals.readVerifiedFallback(paths),
      /identity or digest is stale/u,
    );
    writeFileSync(paths.source, readFileSync(path.join(sourceRoot, 'public-rules.source.v1.json')));

    writeFileSync(paths.index, 'tampered');
    assert.throws(
      () => __testInternals.readVerifiedFallback(paths),
      /identity or digest is stale/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime rule provider prefers the SDK API and otherwise selects fallback', () => {
  const provider = __testInternals.resolvePublicRuleProvider({
    getTidasPublicRules: __testInternals.fallbackSelection,
  });
  assert.equal(provider, __testInternals.fallbackSelection);
  assert.equal(
    (__testInternals.resolvePublicRuleProvider({})('flow') as { status: string }).status,
    'covered',
  );
});

test('public selections retain exact provenance and immutable scientific definitions', () => {
  for (const kind of ['flow', 'process'] as const) {
    const selection = getVerifiedPublicRuleSelection(kind);
    assert.deepEqual(selection, __testInternals.fallbackSelection(kind));
    assert.equal(selection.rules.length, kind === 'flow' ? 5 : 4);
    selection.rules[0]!.statement = 'changed caller copy';
    assert.notEqual(
      getVerifiedPublicRuleSelection(kind).rules[0]!.statement,
      'changed caller copy',
    );
  }
  assert.throws(() => __testInternals.assertSelection(null, 'flow'), /malformed/u);
  assert.throws(
    () => __testInternals.assertSelection({ status: 'not-covered' }, 'flow'),
    /not-covered/u,
  );
  const broken = __testInternals.fallbackSelection('process');
  broken.rules[0]!.statement = 'tampered';
  assert.throws(() => __testInternals.assertSelection(broken, 'process'), /mismatch/u);
});
