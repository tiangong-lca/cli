import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __testInternals as internals, readDatasetContract } from '../src/lib/dataset/contract.js';

test('current SDK contracts keep rule ownership and real canonical schema content', async () => {
  const require = createRequire(import.meta.url);
  const sdk = require('@tiangong-lca/tidas-sdk/contracts') as Record<string, unknown>;
  assert.equal('getTidasRuntimeRuleset' in sdk, false);
  const loaded = await readDatasetContract('process', 'schema,methodology,ruleset');
  assert.match(loaded.pack.schemaText!, /processDataSet/);
  assert.match(loaded.pack.methodologyText!, /Process Dataset Content Rules/);
  assert.deepEqual((loaded.pack.manifest as { includes: string[] }).includes, [
    'schema',
    'methodology',
    'ruleset',
  ]);
  assert.ok(loaded.pack.runtimeRuleset);
  assert.equal((loaded.pack as Record<string, unknown>).aiContext, undefined);
});
test('contract selection normalizes types and refuses missing or unsupported components', () => {
  assert.equal(internals.normalizeType('life-cycle_model'), 'lifecyclemodel');
  assert.throws(() => internals.normalizeType(undefined), /Missing required --type/);
  assert.throws(() => internals.normalizeType('bad-kind'), /Unsupported dataset contract type/);
  assert.deepEqual(internals.normalizeIncludes(undefined), ['schema', 'methodology', 'ruleset']);
  assert.deepEqual(internals.normalizeIncludes('schema'), ['schema']);
  assert.deepEqual(internals.normalizeIncludes(['schema', 'ruleset']), ['schema', 'ruleset']);
  assert.throws(() => internals.normalizeIncludes(['']), /At least one --include/);
  assert.throws(() => internals.normalizeIncludes('unknown'), /--include values/);
});
test('SDK contract adapter fixes the current profile and binds CLI-owned rules', async () => {
  let selected: unknown;
  const loaded = await internals.loadContractPack({
    type: 'flow',
    includes: ['schema', 'ruleset'],
    sdkModule: {
      getTidasContractPack: (type: unknown, options: unknown) => {
        selected = { type, options };
        return { manifest: {}, schemaText: '{"type":"object"}' };
      },
    },
  });
  assert.deepEqual(selected, {
    type: 'flow',
    options: { include: ['schema'], profile: 'default', includeAiContext: false },
  });
  assert.equal(loaded.source, 'sdk-contract-api');
  assert.ok((loaded.pack.manifest as { ruleset: unknown }).ruleset);
  const sparse = await internals.loadContractPack({
    type: 'source',
    includes: ['schema'],
    sdkModule: { getTidasContractPack: () => ({ manifest: null }) },
  });
  assert.equal(sparse.pack.runtimeRuleset, undefined);
  assert.equal(sparse.pack.manifest, null);
  const noRules = await internals.loadContractPack({
    type: 'source',
    includes: ['schema'],
    sdkModule: { getTidasContractPack: () => ({ manifest: {} }) },
  });
  assert.equal((noRules.pack.manifest as { ruleset: unknown }).ruleset, null);
});
test('fallback contracts hash selected assets and preserve absent components', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-contract-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'tidas/schemas'), { recursive: true });
  mkdirSync(path.join(dir, 'tidas/methodologies'), { recursive: true });
  writeFileSync(path.join(dir, 'tidas/schemas/tidas_flows.json'), '{"title":"Flow"}');
  writeFileSync(path.join(dir, 'tidas/methodologies/tidas_flows.yaml'), 'Flow Methodology');
  const loaded = await internals.loadContractPack({
    type: 'flow',
    includes: ['schema', 'methodology', 'ruleset'],
    sdkModule: {},
    runtimeAssetsRoot: dir,
  });
  assert.equal(loaded.source, 'sdk-runtime-assets');
  assert.equal(loaded.pack.schemaText, '{"title":"Flow"}');
  assert.equal(loaded.pack.methodologyText, 'Flow Methodology');
  assert.ok(loaded.pack.runtimeRuleset);
  assert.match(JSON.stringify(loaded.pack.manifest), /public_rules/);
  const sparse = internals.loadFallbackContractPack({
    type: 'contact',
    includes: ['schema', 'methodology'],
    runtimeAssetsRoot: dir,
  });
  assert.equal(sparse.schemaText, undefined);
  assert.equal(sparse.methodologyText, undefined);
  assert.equal(sparse.runtimeRuleset, undefined);
  const omitted = internals.loadFallbackContractPack({
    type: 'contact',
    includes: ['methodology'],
    runtimeAssetsRoot: dir,
  });
  assert.equal(omitted.schemaText, undefined);
  assert.equal((omitted.manifest as { schema: unknown }).schema, null);
  assert.deepEqual(internals.artifactManifest('x.json', '{}'), {
    name: 'x.json',
    sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    bytes: 2,
  });
  assert.throws(
    () =>
      internals.resolveSdkRuntimeAssetsRoot(
        [path.join(dir, 'missing')],
        path.join(dir, 'missing.js'),
      ),
    /runtime assets/,
  );
});
test('dataset contract prefers the canonical SDK sibling and keeps the legacy sibling', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-sdk-siblings-'));
  const cliRoot = path.join(dir, 'cli');
  const canonicalSibling = path.join(dir, 'tidas-sdks/sdks/typescript/src/runtime-assets');
  const legacySibling = path.join(dir, 'tidas-sdk/sdks/typescript/src/runtime-assets');
  const sdkEntry = path.join(dir, 'installed/dist/index.js');
  const packagedRoot = path.join(dir, 'installed/dist/runtime-assets');
  mkdirSync(path.join(cliRoot, 'src'), { recursive: true });
  writeFileSync(path.join(cliRoot, 'package.json'), '{}', 'utf8');
  writeFileSync(path.join(cliRoot, 'src/cli.ts'), '', 'utf8');
  try {
    assert.equal(internals.isCliSourceRoot(cliRoot), true);
    assert.equal(
      internals.resolveCliRepoRoot([cliRoot]),
      cliRoot,
      'a verified source checkout is the development mode signal',
    );

    mkdirSync(canonicalSibling, { recursive: true });
    mkdirSync(legacySibling, { recursive: true });
    assert.deepEqual(internals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot), [
      canonicalSibling,
      legacySibling,
      packagedRoot,
    ]);
    assert.equal(
      internals.resolveSdkRuntimeAssetsRoot(
        internals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot),
        sdkEntry,
      ),
      canonicalSibling,
    );

    rmSync(canonicalSibling, { recursive: true, force: true });
    assert.equal(
      internals.resolveSdkRuntimeAssetsRoot(
        internals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot),
        sdkEntry,
      ),
      legacySibling,
      'checkouts that predate the rename still resolve their sibling checkout',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset contract keeps packaged SDK assets standalone outside a source checkout', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-sdk-packaged-'));
  const installedRoot = path.join(dir, 'installed');
  const sdkEntry = path.join(installedRoot, 'dist/index.js');
  const packagedRoot = path.join(installedRoot, 'dist/runtime-assets');
  const absentSourceSibling = path.join(dir, 'tidas-sdks/sdks/typescript/src/runtime-assets');
  mkdirSync(path.dirname(sdkEntry), { recursive: true });
  mkdirSync(packagedRoot, { recursive: true });
  writeFileSync(sdkEntry, '', 'utf8');
  try {
    // Present on disk, but an installed CLI must never adopt it: the sibling only
    // counts when the CLI itself is a verified source checkout.
    mkdirSync(absentSourceSibling, { recursive: true });
    assert.equal(internals.isCliSourceRoot(installedRoot), false);
    const candidates = internals.sdkRuntimeAssetsCandidates(sdkEntry, installedRoot);
    assert.deepEqual(candidates, [packagedRoot]);
    assert.equal(internals.resolveSdkRuntimeAssetsRoot(candidates, sdkEntry), packagedRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contract fallback uses installed SDK assets and resolves an installed package root', () => {
  const loaded = internals.loadFallbackContractPack({ type: 'flow', includes: ['schema'] });
  assert.match(loaded.schemaText!, /flowDataSet/);
  assert.deepEqual(internals.normalizeIncludes([]), ['schema', 'methodology', 'ruleset']);
  assert.equal(
    internals.resolveCliRepoRoot(['/nonexistent/package-root']),
    '/nonexistent/package-root',
  );
});
