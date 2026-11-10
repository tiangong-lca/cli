import { createHash } from 'node:crypto';

export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function stableJsonText(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Json(value: unknown): string {
  return sha256Text(stableJsonText(value));
}
