import type { DatasetKind, JsonObject } from './local.js';

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const token = trimToken(value);
    if (token) {
      return token;
    }
  }
  return null;
}

export function datasetRoot(payload: JsonObject, kind: DatasetKind): JsonObject {
  if (kind === 'contact') {
    return isRecord(payload.contactDataSet) ? payload.contactDataSet : payload;
  }
  if (kind === 'flow') {
    return isRecord(payload.flowDataSet) ? payload.flowDataSet : payload;
  }
  if (kind === 'flowproperty') {
    return isRecord(payload.flowPropertyDataSet) ? payload.flowPropertyDataSet : payload;
  }
  if (kind === 'process') {
    return isRecord(payload.processDataSet) ? payload.processDataSet : payload;
  }
  if (kind === 'lifecyclemodel') {
    return isRecord(payload.lifeCycleModelDataSet) ? payload.lifeCycleModelDataSet : payload;
  }
  if (kind === 'source') {
    return isRecord(payload.sourceDataSet) ? payload.sourceDataSet : payload;
  }
  return isRecord(payload.unitGroupDataSet) ? payload.unitGroupDataSet : payload;
}
