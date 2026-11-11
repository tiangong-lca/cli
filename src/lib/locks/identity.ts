import { createHash } from 'node:crypto';
import path from 'node:path';
import { BatchContractError } from './errors.js';
import type { BatchJsonValue } from './types.js';
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function canonicalBatchJson(value: BatchJsonValue): string {
  return JSON.stringify(canonicalizeBatchValue(value, new Set<object>()));
}

export function sha256BatchBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256BatchJson(value: BatchJsonValue): string {
  return sha256BatchBytes(canonicalBatchJson(value));
}

export function canonicalizeBatchValue(value: unknown, ancestors: Set<object>): BatchJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BatchContractError('Canonical batch JSON rejects non-finite numbers.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new BatchContractError('Canonical batch JSON accepts JSON data only.');
  }
  if (ancestors.has(value)) {
    throw new BatchContractError('Canonical batch JSON rejects cyclic data.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeBatchValue(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BatchContractError('Canonical batch JSON accepts plain objects only.');
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalizeBatchValue((value as Record<string, unknown>)[key], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function freezeBatchJson<T extends BatchJsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeBatchJson(child);
    Object.freeze(value);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBatchRunPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new BatchContractError('Batch runPath must be a non-empty single-line path.');
  }
  return path.resolve(value);
}

export function parseBatchRunLockToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new BatchContractError(`Batch run-lock ${label} must be a non-empty single-line string.`);
  }
  return value;
}

export function assertBatchTimerDelaySupported(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BatchContractError(`Batch ${label} must be a non-negative safe integer.`);
  }
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new BatchContractError(
      `Batch ${label} exceeds the maximum supported timer delay (${MAX_NODE_TIMER_DELAY_MS} ms).`,
    );
  }
}
