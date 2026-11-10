import assert from 'node:assert/strict';
import test from 'node:test';
import type { AllocationGroup } from '../src/lib/model/resulting-process-allocation.js';
import {
  allocationAggregationKey,
  hasAllocationDeclaration,
  reconcileResultingAllocations,
} from '../src/lib/model/resulting-process-allocation.js';

type Json = Record<string, unknown>;
function exchange(id: string, allocations?: unknown, version = '00.00.001'): Json {
  return {
    '@dataSetInternalID': id,
    exchangeDirection: 'Input',
    referenceToFlowDataSet: { '@refObjectId': 'flow', '@version': version },
    ...(allocations === undefined ? {} : { allocations: { allocation: allocations } }),
  };
}
function group(
  items: Array<{
    instance: string;
    id: string;
    amount: number;
    allocation?: unknown;
    mode?: string;
  }>,
): AllocationGroup {
  return {
    key: 'group',
    amount: items.reduce((sum, item) => sum + item.amount, 0),
    exchange: structuredClone(exchange(items[0].id, items[0].allocation)),
    contributions: items.map((item) => ({
      source: `${item.instance}/${item.id}`,
      instance: item.instance,
      amount: item.amount,
      exchange: exchange(item.id, item.allocation),
      mode: item.mode,
    })),
  };
}
function vector(a: string, b: string, first = '60', second = '40') {
  return [
    { '@internalReferenceToCoProduct': a, '@allocatedFraction': first },
    { '@internalReferenceToCoProduct': b, '@allocatedFraction': second },
  ];
}
function output(g: AllocationGroup) {
  return (g.exchange.allocations as Json).allocation;
}
function qualify(
  g: AllocationGroup,
  entries: Array<[string, string, AllocationGroup, string]> = [],
) {
  const targets = new Map(
    entries.map(([instance, id, target]) => [JSON.stringify([instance, id]), target]),
  );
  const ids = new Map(entries.map(([, , target, final]) => [target, final]));
  reconcileResultingAllocations([g], targets, ids);
}

test('conserves allocated quantities across 10@60/40 + 20@30/70 and colliding instance IDs', () => {
  const a = group([{ instance: 'target', id: '1', amount: 1 }]);
  const b = group([{ instance: 'target', id: '2', amount: 1 }]);
  const g = group([
    { instance: 'one', id: '3', amount: 10, allocation: vector('0', '1') },
    { instance: 'two', id: '3', amount: 20, allocation: vector('0', '1', '30', '70') },
  ]);
  qualify(g, [
    ['one', '0', a, '9'],
    ['one', '1', b, '10'],
    ['two', '0', a, '9'],
    ['two', '1', b, '10'],
  ]);
  assert.deepEqual(output(g), vector('9', '10', '40', '60'));
  assert.equal(g.amount, 30);
});

test('renumbering retains target identity even when old IDs still resolve to another valid target', () => {
  const a = group([{ instance: 'targets', id: '0', amount: 1 }]);
  const b = group([{ instance: 'targets', id: '1', amount: 1 }]);
  const g = group([{ instance: 'source', id: '2', amount: 7, allocation: vector('0', '1') }]);
  qualify(g, [
    ['source', '1', a, '2'],
    ['source', '0', b, '1'],
  ]);
  assert.deepEqual(output(g), vector('1', '2'));
  assert.equal((output(g) as Json[])[1]['@internalReferenceToCoProduct'], '2');
  assert.equal(g.amount, 7);
});

test('compatible target merges sum fractions and scaled quantities, equivalent order is invariant', () => {
  const target = group([{ instance: 't', id: '1', amount: 1 }]);
  for (const items of [
    [
      { instance: 'a', id: '2', amount: 20, allocation: vector('0', '1') },
      { instance: 'b', id: '2', amount: 40, allocation: vector('0', '1', '30', '70') },
    ],
    [
      { instance: 'b', id: '2', amount: 40, allocation: vector('0', '1', '30', '70') },
      { instance: 'a', id: '2', amount: 20, allocation: vector('0', '1') },
    ],
  ]) {
    const g = group(items);
    qualify(g, [
      ['a', '0', target, '5'],
      ['a', '1', target, '5'],
      ['b', '0', target, '5'],
      ['b', '1', target, '5'],
    ]);
    assert.deepEqual(output(g), {
      '@internalReferenceToCoProduct': '5',
      '@allocatedFraction': '100',
    });
  }
});

test('absent and scalar-empty remain undeclared; targetless modes require SDK projection', () => {
  assert.equal(hasAllocationDeclaration(exchange('1')), false);
  assert.equal(hasAllocationDeclaration(exchange('1', {})), false);
  assert.equal(hasAllocationDeclaration(exchange('1', [])), true);
  const plain = group([{ instance: 'a', id: '1', amount: 3 }]);
  qualify(plain);
  assert.equal(plain.exchange.allocations, undefined);
});

test('undeclared inventory uses its verified unique reference projection during a mixed merge', () => {
  const target = group([{ instance: 't', id: '0', amount: 1 }]);
  const g = group([
    { instance: 'a', id: '2', amount: 10, allocation: vector('0', '1') },
    { instance: 'b', id: '2', amount: 20 },
  ]);
  g.contributions[1].fallbackAllocations = [{ targetId: '0', fraction: 100 }];
  qualify(g, [
    ['a', '0', target, '5'],
    ['a', '1', target, '5'],
    ['b', '0', target, '5'],
  ]);
  assert.deepEqual(output(g), {
    '@internalReferenceToCoProduct': '5',
    '@allocatedFraction': '100',
  });
});

test('rejects ambiguous transformations with recovery context', () => {
  const a = group([{ instance: 't', id: '0', amount: 1 }]);
  const targets: Array<[string, string, AllocationGroup, string]> = [['a', '0', a, '1']];
  const rejected: Array<{ items: Parameters<typeof group>[0]; total?: number; pattern: RegExp }> = [
    {
      items: [{ instance: 'a', id: '2', amount: 1, allocation: vector('0', '0') }],
      pattern: /duplicate target/,
    },
    {
      items: [{ instance: 'a', id: '2', amount: 1, allocation: vector('0', '1') }],
      pattern: /missing or eliminated/,
    },
    { items: [{ instance: 'a', id: '2', amount: 1, allocation: [] }], pattern: /empty allocation/ },
    {
      items: [{ instance: 'a', id: '2', amount: 1, allocation: ['invalid'] }],
      pattern: /targetless/,
    },
    { items: [{ instance: 'a', id: '2', amount: 1, allocation: [null] }], pattern: /targetless/ },
    { items: [{ instance: 'a', id: '2', amount: 1, allocation: [[]] }], pattern: /targetless/ },
    {
      items: [{ instance: 'a', id: '2', amount: 1, allocation: { '@allocatedFraction': '100' } }],
      pattern: /targetless/,
    },
    {
      items: [
        {
          instance: 'a',
          id: '2',
          amount: 1,
          allocation: { '@internalReferenceToCoProduct': '0', '@allocatedFraction': '101' },
        },
      ],
      pattern: /outside/,
    },
    {
      items: [
        {
          instance: 'a',
          id: '2',
          amount: 1,
          allocation: { '@internalReferenceToCoProduct': '0', '@allocatedFraction': '10%' },
        },
      ],
      pattern: /invalid percentage/,
    },
    {
      items: [
        {
          instance: 'a',
          id: '2',
          amount: 1,
          allocation: { '@internalReferenceToCoProduct': '0', '@allocatedFraction': '99' },
        },
      ],
      pattern: /total 100/,
    },
    {
      items: [{ instance: 'a', id: '2', amount: -1, allocation: vector('0', '1') }],
      total: 1,
      pattern: /signed or nonfinite/,
    },
    {
      items: [{ instance: 'a', id: '2', amount: 1, allocation: vector('0', '1') }],
      total: 0,
      pattern: /zero or signed/,
    },
    {
      items: [
        { instance: 'a', id: '2', amount: 1, allocation: vector('0', '1') },
        { instance: 'b', id: '2', amount: 1 },
      ],
      pattern: /mixed declared/,
    },
    {
      items: [
        {
          instance: 'a',
          id: '2',
          amount: 1,
          allocation: { '@allocatedFraction': '100' },
          mode: 'legacy-targetless-full',
        },
        {
          instance: 'b',
          id: '2',
          amount: 1,
          allocation: { '@allocatedFraction': '70' },
          mode: 'legacy-output-share',
        },
      ],
      pattern: /targetless/,
    },
  ];
  for (const entry of rejected) {
    const g = group(entry.items);
    if (entry.total !== undefined) g.amount = entry.total;
    assert.throws(() => qualify(g, targets), entry.pattern);
  }
});

test('exact Flow version and quantity basis prevent UUID-only aggregation', () => {
  for (const malformed of [null, 0, 'malformed', []])
    assert.equal(
      allocationAggregationKey({ referenceToFlowDataSet: malformed }),
      allocationAggregationKey({}),
    );
  const base = exchange('1');
  assert.notEqual(
    allocationAggregationKey(base),
    allocationAggregationKey(exchange('1', undefined, '00.00.002')),
  );
  assert.notEqual(
    allocationAggregationKey(base),
    allocationAggregationKey({ ...base, unit: 'kg' }),
  );
  assert.equal(
    allocationAggregationKey(base),
    allocationAggregationKey({ ...base, '@dataSetInternalID': '9' }),
  );
});

test('three-decimal largest remainder conserves totals with stable recipient ties and bounded amount error', () => {
  const targets = ['0', '1', '2'].map((id) => group([{ instance: 'target', id, amount: 1 }]));
  const shares = ['0', '1', '2'].map((id) => ({
    '@internalReferenceToCoProduct': id,
    '@allocatedFraction': '33.3333333333333',
  }));
  const g = group([{ instance: 'source', id: '3', amount: 300, allocation: shares }]);
  qualify(
    g,
    targets.map((target, index) => ['source', String(index), target, String(index + 5)]),
  );
  assert.deepEqual(
    (output(g) as Json[]).map((item) => item['@allocatedFraction']),
    ['33.334', '33.333', '33.333'],
  );
  assert.equal(
    (output(g) as Json[]).reduce((sum, item) => sum + Number(item['@allocatedFraction']), 0),
    100,
  );
  for (const error of g.quantization!) assert.ok(error.amount_error <= g.amount * 0.00001);
});
