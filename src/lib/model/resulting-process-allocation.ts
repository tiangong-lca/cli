import { ALLOCATION_SUM_TOLERANCE } from '@tiangong-lca/tidas-sdk';
import { CliError } from '../../shared/errors.js';

type JsonObject = Record<string, unknown>;
export type AllocationContribution = {
  source: string;
  instance: string;
  mode?: string;
  alreadyAllocated?: boolean;
  fallbackAllocations?: Array<{ targetId: string; fraction: number }>;
  exchange: JsonObject;
  amount: number;
};
export type AllocationGroup = {
  key: string;
  amount: number;
  exchange: JsonObject;
  contributions: AllocationContribution[];
  quantization?: Array<{ targetId: string; percentage_error: number; amount_error: number }>;
};
const TOLERANCE = ALLOCATION_SUM_TOLERANCE;
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}
function fail(source: string, reason: string): never {
  throw new CliError(
    `Allocation transformation unsupported at ${source}: ${reason}. Supply an unallocated inventory with explicit compatible declarations.`,
    {
      code: 'LIFECYCLEMODEL_ALLOCATION_TRANSFORMATION_UNSUPPORTED',
      exitCode: 2,
    },
  );
}
/** Exact reference and quantity basis qualify aggregation independently of numbering. */
export function allocationAggregationKey(exchange: JsonObject): string {
  const ref = object(exchange.referenceToFlowDataSet);
  return JSON.stringify([
    ref['@refObjectId'],
    exchange.exchangeDirection,
    ref['@version'] ?? null,
    exchange.referenceToFlowPropertyDataSet ?? null,
    exchange.referenceToUnitGroupDataSet ?? null,
    exchange.referenceToUnit ?? null,
    exchange.unit ?? null,
    exchange.functionType ?? null,
    exchange.location ?? null,
  ]);
}
function declaration(exchange: JsonObject): unknown {
  return object(exchange.allocations).allocation;
}
export function hasAllocationDeclaration(exchange: JsonObject): boolean {
  const value = declaration(exchange);
  return (
    value !== undefined &&
    !(value && !Array.isArray(value) && Object.keys(object(value)).length === 0)
  );
}
/** Preserve explicit source identity before numbering; conserve allocated quantities through merges. */
export function reconcileResultingAllocations(
  groups: AllocationGroup[],
  sourceTargets: Map<string, AllocationGroup>,
  finalIds: Map<AllocationGroup, string>,
): void {
  for (const group of groups) {
    let declared = group.contributions.filter((item) => hasAllocationDeclaration(item.exchange));
    if (declared.length === 0) continue;
    if (declared.length !== group.contributions.length) {
      declared = group.contributions.map((item) => {
        if (hasAllocationDeclaration(item.exchange)) return item;
        if (!item.fallbackAllocations) fail(group.key, 'mixed declared and undeclared inventory');
        return {
          ...item,
          exchange: {
            ...item.exchange,
            allocations: {
              allocation: item.fallbackAllocations.map(({ targetId, fraction }) => ({
                '@internalReferenceToCoProduct': targetId,
                '@allocatedFraction': String(fraction),
              })),
            },
          },
        };
      });
    }
    if (group.amount <= 0 || !Number.isFinite(group.amount))
      fail(group.key, 'zero or signed denominator');
    const quantities = new Map<string, number>();
    for (const contributor of declared) {
      if (contributor.amount < 0 || !Number.isFinite(contributor.amount))
        fail(contributor.source, 'signed or nonfinite contribution');
      const raw = declaration(contributor.exchange);
      const vector = Array.isArray(raw) ? raw : [raw];
      if (vector.length === 0) fail(contributor.source, 'empty allocation vector');
      const seen = new Set<string>();
      let total = 0;
      for (const entry of vector) {
        const item = object(entry);
        const target = item['@internalReferenceToCoProduct'];
        const percentage = item['@allocatedFraction'];
        if (typeof target !== 'string' || !target.trim())
          fail(
            contributor.source,
            'targetless legacy shares require an explicit source allocation mode',
          );
        if (seen.has(target)) fail(contributor.source, `duplicate target ${target}`);
        seen.add(target);
        if (
          typeof percentage !== 'string' ||
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(percentage)
        )
          fail(contributor.source, 'invalid percentage');
        const fraction = Number(percentage);
        if (!Number.isFinite(fraction) || fraction < 0 || fraction > 100)
          fail(contributor.source, 'fraction outside 0–100');
        total += fraction;
        const identity = JSON.stringify([contributor.instance, target]);
        const targetGroup = sourceTargets.get(identity);
        const finalId = targetGroup && finalIds.get(targetGroup);
        if (!finalId) fail(contributor.source, `missing or eliminated target ${target}`);
        quantities.set(
          finalId,
          (quantities.get(finalId) ?? 0) + (contributor.amount * fraction) / 100,
        );
      }
      if (Math.abs(total - 100) > TOLERANCE) fail(contributor.source, 'fractions do not total 100');
    }
    // Perc's public schema allows three decimals. Largest remainder conserves the
    // rounded vector total and bounds each recipient's percentage error below 0.001.
    const shares = [...quantities.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([target, quantity]) => {
        const exactUnits = (100_000 * quantity) / group.amount;
        const units = Math.floor(exactUnits);
        return { target, units, remainder: exactUnits - units, exactUnits };
      });
    const residual =
      Math.round(shares.reduce((sum, item) => sum + item.exactUnits, 0)) -
      shares.reduce((sum, item) => sum + item.units, 0);
    const ranked = [...shares].sort(
      (a, b) => b.remainder - a.remainder || Number(a.target) - Number(b.target),
    );
    for (let index = 0; index < residual; index += 1) ranked[index].units += 1;
    const allocation = shares.map(({ target, units }) => ({
      '@internalReferenceToCoProduct': target,
      '@allocatedFraction': String(units / 1000),
    }));
    group.quantization = shares.map(({ target, units, exactUnits }) => ({
      targetId: target,
      percentage_error: Math.abs(units - exactUnits) / 1000,
      amount_error: (Math.abs(units - exactUnits) * group.amount) / 100_000,
    }));
    group.exchange.allocations = {
      ...object(group.exchange.allocations),
      allocation: allocation.length === 1 ? allocation[0] : allocation,
    };
  }
}
