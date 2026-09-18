import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  __testInternals,
  getRuntimeRule,
  getRuntimeRuleset,
  isRuntimeRuleBlocker,
  listRuntimeRulesets,
  resolveRuntimeRuleId,
  runtimeRuleIds,
} from '../src/lib/runtime-rulesets.js';

test('runtime ruleset registry exposes stable metadata and local rule mappings', () => {
  const rulesets = listRuntimeRulesets();
  assert.equal(rulesets.length >= 8, true);

  const processPublish = getRuntimeRuleset('process-publish/default');
  assert.equal(processPublish.version, '1');
  assert.equal(processPublish.source_version, '2026.05.23');
  assert.equal(processPublish.rule_ids.includes('tidas.process.version.format'), true);
  assert.deepEqual(runtimeRuleIds('process-dedup/default'), [
    'tidas.process.identity.duplicate-fingerprint.block',
  ]);

  const flowTypeRule = getRuntimeRule('tidas.flow.type.required');
  assert.equal(flowTypeRule?.default_blocker, true);
  assert.equal(flowTypeRule?.phases.includes('publish-run'), true);
  assert.equal(getRuntimeRule('unknown.rule'), null);

  const flowAuthoring = runtimeRuleIds('flow-authoring/strict');
  assert.equal(flowAuthoring.includes('tidas.flow.classification.elementary.valid'), true);
  assert.equal(flowAuthoring.includes('tidas.flow.identity.alias-equivalence.review'), true);

  assert.equal(
    resolveRuntimeRuleId('flow-authoring/strict', 'missing_type_of_dataset'),
    'tidas.flow.type.required',
  );
  assert.equal(
    resolveRuntimeRuleId('process-authoring/strict', 'process_missing_exchange_amount'),
    'tidas.process.exchange.amount.required',
  );
  assert.equal(resolveRuntimeRuleId('flow-authoring/strict', 'unknown_local_rule'), null);
  assert.equal(resolveRuntimeRuleId('flow-authoring/strict', null), null);

  assert.equal(isRuntimeRuleBlocker('tidas.process.version.format'), true);
  assert.equal(isRuntimeRuleBlocker('tidas.flow.identity.alias-equivalence.review'), false);
  assert.equal(isRuntimeRuleBlocker('unknown.rule'), false);
  assert.equal(isRuntimeRuleBlocker(undefined), false);
});

test('runtime rules compose exact public definitions with CLI-owned policy', () => {
  const process = __testInternals.fallbackSelection('process');
  const flow = __testInternals.fallbackSelection('flow');
  const composed = __testInternals.composeRuntimeRules((kind) =>
    kind === 'process' ? process : flow,
  );

  assert.equal(process.source.commit, __testInternals.expectedPublicSource.commit);
  assert.equal(process.rules.length, 4);
  assert.equal(flow.rules.length, 5);
  assert.equal(composed.length, 15);
  assert.equal(
    Object.hasOwn(composed.find((rule) => rule.id === process.rules[0]?.id) ?? {}, 'statement'),
    false,
  );
});

test('runtime rule composition fails closed on unavailable or incompatible public definitions', () => {
  assert.throws(() => __testInternals.composeRuntimeRules(() => null), /selection is malformed/u);

  const notCovered = {
    ...__testInternals.fallbackSelection('process'),
    status: 'not-covered',
    rules: [],
  };
  assert.throws(
    () => __testInternals.composeRuntimeRules(() => notCovered),
    /selection is not-covered/u,
  );

  const tampered = __testInternals.fallbackSelection('process');
  tampered.rules[0] = { ...tampered.rules[0]!, statement: 'tampered' };
  assert.throws(
    () =>
      __testInternals.composeRuntimeRules((kind) =>
        kind === 'process' ? tampered : __testInternals.fallbackSelection('flow'),
      ),
    /API\/fallback contract mismatch/u,
  );

  const stale = __testInternals.fallbackSelection('flow');
  stale.source = { ...stale.source, commit: 'stale' };
  assert.throws(
    () =>
      __testInternals.composeRuntimeRules((kind) =>
        kind === 'flow' ? stale : __testInternals.fallbackSelection('process'),
      ),
    /API\/fallback contract mismatch/u,
  );
});

test('runtime rule policy composition rejects ownership and reference drift', () => {
  const provider = __testInternals.fallbackSelection;
  type Policy = NonNullable<Parameters<typeof __testInternals.composeRuntimeRules>[1]>[number];
  const policies = structuredClone(__testInternals.runtimeRulePolicies) as Policy[];
  assert.throws(
    () => __testInternals.composeRuntimeRules(provider, [...policies, policies[0]!]),
    /Duplicate CLI runtime rule policy/u,
  );

  const unknownPublic = structuredClone(policies);
  unknownPublic[0] = { ...unknownPublic[0]!, id: 'tidas.process.unknown' };
  assert.throws(
    () => __testInternals.composeRuntimeRules(provider, unknownPublic),
    /references unknown public rule/u,
  );

  const localCollision = policies
    .filter((policy) => policy.id !== 'tidas.process.version.format')
    .map((policy) =>
      policy.id === 'tidas.publish.verification.required'
        ? { ...policy, id: 'tidas.process.version.format' }
        : policy,
    );
  assert.throws(
    () => __testInternals.composeRuntimeRules(provider, localCollision),
    /CLI-local runtime rule duplicates public rule/u,
  );

  assert.throws(
    () =>
      __testInternals.composeRuntimeRules(
        provider,
        policies.filter((policy) => policy.id !== 'tidas.flow.type.required'),
      ),
    /has no CLI runtime policy/u,
  );
  assert.throws(
    () =>
      __testInternals.validateRulesetReferences(
        [{ id: 'broken', rule_ids: ['unknown.rule'] }],
        policies,
      ),
    /references unknown runtime rule/u,
  );
});

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
