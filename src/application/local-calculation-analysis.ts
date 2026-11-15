import { object, text, type JsonObject } from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

function invalid(message: string): never {
  throw new CommandInputError('CALCULATION_ANALYSIS_INVALID', message, 'precondition');
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function vector(value: unknown, context: string, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every(finite))
    invalid(`Invalid ${context} in the saved Run.`);
  return value;
}
function rows(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) invalid(`Missing ${context} in the saved Run.`);
  return value;
}
function axis(entry: JsonObject) {
  return {
    id: text(entry.id, 'method id'),
    version: text(entry.version, 'method version'),
    unit: text(entry.unit, 'method unit'),
  };
}
function product(left: number, right: number): number {
  const value = left * right;
  if (!Number.isFinite(value) || (value === 0 && left !== 0 && right !== 0))
    invalid('Process contribution arithmetic exceeded numerical precision.');
  return value;
}

export function requireCompleteImpact(result: JsonObject): void {
  if (result.completeLciaScores !== true) invalid('Analysis requires complete saved LCIA scores.');
}

export function processContributions(numeric: JsonObject, result: JsonObject): JsonObject[] {
  requireCompleteImpact(result);
  const views = rows(numeric.views, 'process calculation views').map((value) =>
    object(object(value, 'process view').port, 'process view port'),
  );
  const methods = rows(numeric.methodAxes, 'impact methods').map((value) =>
    axis(object(value, 'impact method')),
  );
  const activity = vector(result.x, 'process quantities', views.length);
  const scores = vector(result.h, 'LCIA scores', methods.length);
  if (!Array.isArray(numeric.b)) invalid('Missing inventory coefficient matrix in the saved Run.');
  const inventory = numeric.b.map((row) => vector(row, 'inventory coefficient row', views.length));
  const factors = rows(numeric.c, 'characterization matrix').map((row) =>
    vector(row, 'characterization row', inventory.length),
  );
  if (factors.length !== methods.length)
    invalid('Characterization rows do not match saved impact methods.');
  return methods.flatMap((method, index) => {
    const amounts = views.map((_, view) =>
      inventory.reduce(
        (sum, row, flow) =>
          // Keep inventory scaling before characterization, matching the solver operation order.
          sum + product(product(row[view], activity[view]), factors[index][flow]),
        0,
      ),
    );
    const total = scores[index];
    const sum = amounts.reduce((a, b) => a + b, 0);
    const magnitude = amounts.reduce((a, b) => a + Math.abs(b), 0);
    if (
      !Number.isFinite(sum) ||
      !Number.isFinite(magnitude) ||
      Math.abs(sum - total) > 1e-12 * Math.max(magnitude, Math.abs(total))
    )
      invalid('Process contributions do not reconcile with the saved LCIA result.');
    return views.map((port, view) => ({ method, port, total, amount: amounts[view] }));
  });
}

export function calculationBasis(value: unknown, amount: unknown) {
  const reference = object(value, 'calculation reference');
  const flow = object(reference.flow, 'reference flow');
  if (!finite(amount) || !finite(reference.pivot) || reference.pivot === 0)
    invalid('Missing or invalid reference quantity in the saved Run.');
  return {
    flowId: text(flow.id, 'reference flow id'),
    flowVersion: text(flow.version, 'reference flow version'),
    unit: text(reference.unit, 'reference unit'),
    directionSign: Math.sign(reference.pivot),
    amount,
  };
}

export function compareLocalCalculations(baseline: JsonObject, scenario: JsonObject): JsonObject {
  const basis = object(baseline.reference, 'baseline reference');
  const other = object(scenario.reference, 'scenario reference');
  if (Object.entries(basis).some(([key, value]) => other[key] !== value))
    invalid('Use Runs with the same reference flow, unit, direction and quantity.');
  const readMethods = (value: unknown) => {
    const entries = rows(value, 'LCIA results').map((item) => {
      const entry = object(item, 'LCIA result');
      const method = axis(entry);
      if (!finite(entry.amount)) invalid('Invalid LCIA amount in the saved Run.');
      return [JSON.stringify(method), { method, amount: entry.amount }] as const;
    });
    const byMethod = new Map(entries);
    if (byMethod.size !== entries.length) invalid('Impact methods must be unique in each Run.');
    return byMethod;
  };
  const before = readMethods(baseline.items);
  const after = readMethods(scenario.items);
  if (before.size !== after.size) invalid('Use Runs with the same impact methods and units.');
  const items = [...before].map(([key, { method, amount }]) => {
    const next = after.get(key);
    if (!next) invalid('Use Runs with the same impact methods and units.');
    const change = next.amount - amount;
    if (!finite(change)) invalid('Scenario change exceeds numerical precision.');
    return { method, baseline: amount, scenario: next.amount, change };
  });
  return { execution: 'local', kind: 'comparison', reference: basis, count: items.length, items };
}
