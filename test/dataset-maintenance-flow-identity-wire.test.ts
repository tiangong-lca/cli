import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testInternals,
  assertFlowIdentityWireJson,
  assertFlowIdentityWireValue,
  flowIdentityRestrictedJsonText,
  flowIdentityRestrictedSha256,
  isStandardFlowIdentityShortDescription,
} from '../src/lib/dataset-maintenance-flow-identity-wire.js';
import { sha256Text } from '../src/lib/canonical-json-hash.js';

test('flow identity wire accepts only recursively safe JSON integers and narrow indexes', () => {
  const request = {
    schema_version: 'dataset-flow-identity-test.v2',
    ordinal: 1,
    process_count: 11_740,
    exchange_index: 0,
    state_code: 0,
    lower_safe_integer: Number.MIN_SAFE_INTEGER,
    upper_safe_integer: Number.MAX_SAFE_INTEGER,
    nested: [null, true, false, '1.0', { count: 305 }],
    non_bmp: '🌍',
  };
  assert.equal(assertFlowIdentityWireJson(request), request);

  const rejected: unknown[] = [
    { value: 1.5 },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: Number.MAX_SAFE_INTEGER + 1 },
    { value: BigInt(1) },
    { value: undefined },
    { value: () => undefined },
    { ordinal: 0 },
    { ordinal: __testInternals.MAX_ORDINAL + 1 },
    { process_count: -1 },
    { process_count: __testInternals.MAX_COUNT + 1 },
    { exchange_index: -1 },
    { exchange_index: __testInternals.MAX_INDEX + 1 },
    { state_code: -1 },
    { state_code: 1_001 },
    { value: 'nul\u0000byte' },
    { value: 'lone-high-\ud800' },
    { value: 'lone-low-\udc00' },
  ];
  for (const value of rejected) {
    assert.throws(() => assertFlowIdentityWireJson(value), /Flow identity wire value/u);
  }

  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[0] = 'present';
  assert.throws(() => assertFlowIdentityWireJson({ sparse }), /sparse array entry/u);
  assert.throws(() => assertFlowIdentityWireJson([]), /must be a JSON object/u);
  assert.throws(
    () => assertFlowIdentityWireJson({ ['bad\u0000key']: 'value' }),
    /must not contain U\+0000/u,
  );
  assert.throws(() => assertFlowIdentityWireJson({ value: new Date() }), /only JSON/u);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertFlowIdentityWireJson(cyclic), /must not contain a cycle/u);
});

test('flow identity wire preserves string and exact standard STMultiLang descriptions', () => {
  const accepted = [
    'electricity',
    { '@xml:lang': 'en', '#text': 'electricity' },
    [
      { '@xml:lang': 'en', '#text': 'electricity' },
      { '@xml:lang': 'zh', '#text': '电力' },
    ],
  ];
  for (const description of accepted) {
    assert.equal(isStandardFlowIdentityShortDescription(description), true);
    assert.doesNotThrow(() =>
      assertFlowIdentityWireJson({
        reference: { 'common:shortDescription': description },
      }),
    );
  }

  const rejected = [
    1,
    null,
    {},
    [],
    { '#text': 'electricity' },
    { '@xml:lang': 'en', '#text': 'electricity', extra: 'forged' },
    [{ '@xml:lang': 'en', '#text': 1 }],
  ];
  for (const description of rejected) {
    assert.equal(isStandardFlowIdentityShortDescription(description), false);
    assert.throws(
      () =>
        assertFlowIdentityWireJson({
          reference: { 'common:shortDescription': description },
        }),
      /standard STMultiLang/u,
    );
  }
});

test('flow identity restricted request hash uses the shared safe-json-v2 byte contract', () => {
  const request = {
    z: -0,
    10: 'ten',
    2: 'two',
    '01': 'not-an-array-index',
    nested: { b: true, a: [1, null, '🌍'] },
  };
  const canonical =
    '{"2":"two","10":"ten","01":"not-an-array-index","nested":{"a":[1,null,"🌍"],"b":true},"z":0}';
  assert.equal(flowIdentityRestrictedJsonText(request), canonical);
  assert.equal(flowIdentityRestrictedSha256(request), sha256Text(canonical));
  const arrayCanonical = '[{"2":"two","10":"ten","a":0},1,"🌍"]';
  const arrayValue = [{ 10: 'ten', 2: 'two', a: -0 }, 1, '🌍'];
  assert.equal(assertFlowIdentityWireValue(arrayValue), arrayValue);
  assert.equal(flowIdentityRestrictedJsonText(arrayValue), arrayCanonical);
  assert.equal(flowIdentityRestrictedSha256(arrayValue), sha256Text(arrayCanonical));
});
