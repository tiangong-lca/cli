import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculationBasis,
  compareLocalCalculations,
  processContributions,
} from '../src/application/local-calculation-analysis.js';

const method = { id: 'climate', version: '1', unit: 'kg CO2e' };
const numeric = {
  views: [
    { port: { instanceId: 'a', exchangeId: '1' } },
    { port: { instanceId: 'b', exchangeId: '2' } },
  ],
  methodAxes: [method],
  b: [
    [4, -2],
    [1, 2],
  ],
  c: [[3, 2]],
};
const result = { completeLciaScores: true, x: [2, 3], h: [22] };

test('saved process contributions are signed, reconcile with LCIA, and preserve instance ports', () => {
  assert.deepEqual(processContributions(numeric, result), [
    { method, port: numeric.views[0].port, total: 22, amount: 28 },
    { method, port: numeric.views[1].port, total: 22, amount: -6 },
  ]);
  assert.deepEqual(
    processContributions({ ...numeric, b: [], c: [[]] }, { ...result, h: [0] }).map(
      (row) => row.amount,
    ),
    [0, 0],
  );
  assert.deepEqual(
    processContributions({ ...numeric, b: [[1, 0]], c: [[0]] }, { ...result, h: [0] }).map(
      (row) => row.amount,
    ),
    [0, 0],
  );
  const cases = [
    [{}, { completeLciaScores: false }, /complete saved LCIA/u],
    [{ views: [] }, {}, /process calculation views/u],
    [{ views: undefined }, {}, /process calculation views/u],
    [{}, { x: 'invalid' }, /process quantities/u],
    [{}, { x: [1] }, /process quantities/u],
    [{}, { x: [1, Infinity] }, /process quantities/u],
    [{ b: undefined }, {}, /inventory coefficient matrix/u],
    [{ c: [...numeric.c, ...numeric.c] }, {}, /do not match/u],
    [{}, { h: [23] }, /do not reconcile/u],
    [{ b: [[1e308, -1e308]], c: [[1]] }, {}, /numerical precision/u],
    [{ b: [[1e-250, 0]], c: [[1e-100]] }, {}, /numerical precision/u],
    [{ b: [[1e308, 1e308]], c: [[1]] }, { x: [1, 1], h: [1e308] }, /do not reconcile/u],
    [{ b: [[1e308, -1e308]], c: [[1]] }, { x: [1, 1], h: [0] }, /do not reconcile/u],
  ] as const;
  for (const [input, output, message] of cases)
    assert.throws(
      () => processContributions({ ...numeric, ...input }, { ...result, ...output }),
      message,
    );
});

test('Run comparison matches method identities in any order and rejects incommensurate scores', () => {
  const reference = { flow: { id: 'garment', version: '1' }, unit: 'kg', pivot: -1 };
  const basis = calculationBasis(reference, 2);
  assert.deepEqual(basis, {
    flowId: 'garment',
    flowVersion: '1',
    unit: 'kg',
    directionSign: -1,
    amount: 2,
  });
  for (const [pivot, amount] of [
    [-1, undefined],
    ['-1', 2],
    [0, 2],
  ]) {
    assert.throws(() => calculationBasis({ ...reference, pivot }, amount), /reference quantity/u);
  }
  const water = { id: 'water', version: '1', unit: 'm³' };
  const baseline = {
    reference: basis,
    items: [
      { ...method, amount: 22 },
      { ...water, amount: 0 },
    ],
  };
  const scenario = {
    reference: basis,
    items: [
      { ...water, amount: 2 },
      { ...method, amount: 17 },
    ],
  };
  assert.deepEqual(compareLocalCalculations(baseline, scenario).items, [
    { method, baseline: 22, scenario: 17, change: -5 },
    { method: water, baseline: 0, scenario: 2, change: 2 },
  ]);
  assert.throws(
    () => compareLocalCalculations(baseline, { ...scenario, reference: { ...basis, amount: 3 } }),
    /same reference/u,
  );
  for (const [items, message] of [
    [[scenario.items[0]], /same impact methods/u],
    [[scenario.items[0], scenario.items[0]], /must be unique/u],
    [[scenario.items[0], { ...method, unit: 'g CO2e', amount: 21 }], /same impact methods/u],
    [[scenario.items[0], { ...method, amount: '17' }], /Invalid LCIA amount/u],
  ] as const)
    assert.throws(() => compareLocalCalculations(baseline, { reference: basis, items }), message);
  const one = (amount: number) => ({ reference: basis, items: [{ ...method, amount }] });
  assert.throws(() => compareLocalCalculations(one(-1e308), one(1e308)), /numerical precision/u);
});
