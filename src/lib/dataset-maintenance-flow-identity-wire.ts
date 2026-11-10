import { isJsonObject } from './maintenance/contract/values.js';
import { sha256Text } from './canonical-json-hash.js';
import { type JsonObject } from './maintenance/contract/types.js';
import { CliError } from '../shared/errors.js';

const MAX_ORDINAL = 100_000;
const MAX_COUNT = 1_000_000;
const MAX_INDEX = 1_000_000;

export type StandardStMultiLang =
  | string
  | { '@xml:lang': string; '#text': string }
  | Array<{ '@xml:lang': string; '#text': string }>;

function fail(path: string, message: string): never {
  throw new CliError(`Flow identity wire value ${path} ${message}.`, {
    code: 'DATASET_FLOW_IDENTITY_WIRE_INVALID',
    exitCode: 2,
    details: { path },
  });
}

function assertTransportString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) fail(path, 'must not contain U+0000');
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail(path, 'must not contain an unpaired UTF-16 surrogate');
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      fail(path, 'must not contain an unpaired UTF-16 surrogate');
    }
  }
}

function isExactStMultiLangEntry(value: unknown): value is {
  '@xml:lang': string;
  '#text': string;
} {
  if (!isPlainWireObject(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === '#text' &&
    keys[1] === '@xml:lang' &&
    typeof value['@xml:lang'] === 'string' &&
    typeof value['#text'] === 'string'
  );
}

function isPlainWireObject(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isStandardFlowIdentityShortDescription(
  value: unknown,
): value is StandardStMultiLang {
  return (
    typeof value === 'string' ||
    isExactStMultiLangEntry(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isExactStMultiLangEntry))
  );
}

function assertNarrowInteger(key: string | null, value: number, path: string): void {
  if (!Number.isSafeInteger(value)) fail(path, 'must be a safe integer');
  if (key === 'ordinal' || key?.endsWith('_ordinal')) {
    if (value < 1 || value > MAX_ORDINAL) {
      fail(path, `must be between 1 and ${MAX_ORDINAL}`);
    }
    return;
  }
  if (key === 'exchange_index' || key?.endsWith('_index')) {
    if (value < 0 || value > MAX_INDEX) {
      fail(path, `must be between 0 and ${MAX_INDEX}`);
    }
    return;
  }
  if (key === 'state_code') {
    if (value < 0 || value > 1_000) fail(path, 'must be between 0 and 1000');
    return;
  }
  if (key === 'count' || key?.endsWith('_count')) {
    if (value < 0 || value > MAX_COUNT) {
      fail(path, `must be between 0 and ${MAX_COUNT}`);
    }
  }
}

function visit(value: unknown, path: string, key: string | null, active: Set<object>): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertTransportString(value, path);
    return;
  }
  if (typeof value === 'number') {
    assertNarrowInteger(key, value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) fail(path, 'must not contain a cycle');
    active.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail(`${path}[${index}]`, 'must not be a sparse array entry');
      visit(value[index], `${path}[${index}]`, null, active);
    }
    active.delete(value);
    return;
  }
  if (!isPlainWireObject(value)) {
    fail(
      path,
      'must contain only JSON strings, booleans, nulls, safe integers, arrays, or objects',
    );
  }
  if (active.has(value)) fail(path, 'must not contain a cycle');
  active.add(value);
  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = `${path}.${childKey}`;
    assertTransportString(childKey, `${childPath} (key)`);
    if (
      childKey === 'common:shortDescription' &&
      !isStandardFlowIdentityShortDescription(childValue)
    ) {
      fail(
        childPath,
        'must be a string or an exact standard STMultiLang object/array with @xml:lang and #text strings',
      );
    }
    visit(childValue, childPath, childKey, active);
  }
  active.delete(value);
}

export function assertFlowIdentityWireJson(value: unknown, label = 'request'): JsonObject {
  if (!isPlainWireObject(value)) fail(label, 'must be a JSON object');
  assertFlowIdentityWireValue(value, label);
  return value;
}

export function assertFlowIdentityWireValue(value: unknown, label = 'value'): unknown {
  visit(value, label, null, new Set<object>());
  return value;
}

function arrayIndex(key: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return null;
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_294 ? value : null;
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftIndex = arrayIndex(left);
  const rightIndex = arrayIndex(right);
  if (leftIndex !== null && rightIndex !== null) return leftIndex - rightIndex;
  if (leftIndex !== null) return -1;
  if (rightIndex !== null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRestrictedJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return String(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRestrictedJson).join(',')}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort(compareCanonicalKeys)
    .map((key) => `${JSON.stringify(key)}:${canonicalRestrictedJson(object[key])}`)
    .join(',')}}`;
}

export function flowIdentityRestrictedJsonText(value: unknown): string {
  assertFlowIdentityWireValue(value);
  return canonicalRestrictedJson(value);
}

export function flowIdentityRestrictedSha256(value: unknown): string {
  return sha256Text(flowIdentityRestrictedJsonText(value));
}

export const __testInternals = {
  MAX_COUNT,
  MAX_INDEX,
  MAX_ORDINAL,
  isExactStMultiLangEntry,
  arrayIndex,
  compareCanonicalKeys,
  canonicalRestrictedJson,
  assertTransportString,
};
