import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CommandInputError } from '../shared/command-result.js';
import { object, text, isObject, type JsonObject } from './dataset-types.js';

export const contentDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escaped = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
export function diffContent(before: unknown, after: unknown, path = ''): JsonObject[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (isObject(before) && isObject(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) => diffContent(before[key], after[key], `${path}/${escaped(key)}`));
  return [
    {
      path,
      before: before ?? null,
      after: after ?? null,
      beforePresent: before !== undefined,
      afterPresent: after !== undefined,
    },
  ];
}
function pointer(path: unknown): string[] {
  const value = text(path, 'operation.path');
  if (!value.startsWith('/') || /~(?![01])/u.test(value))
    throw new CommandInputError('POINTER_INVALID', 'Patch path must be a non-root JSON pointer.');
  const parts = value
    .slice(1)
    .split('/')
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key)))
    throw new CommandInputError('POINTER_INVALID', 'Unsafe pointer segment.');
  return parts;
}
export function patchContent(request: JsonObject): { content: JsonObject; changes: JsonObject[] } {
  const original = object(request.content, 'content');
  if (request.expectedDigest !== contentDigest(original))
    throw new CommandInputError(
      'CONTENT_CONFLICT',
      'expectedDigest must match the source content.',
    );
  if (!Array.isArray(request.operations) || !request.operations.length)
    throw new CommandInputError('PATCH_REQUIRED', 'operations must be a non-empty array.');
  const content = structuredClone(original);
  for (const entry of request.operations) {
    const operation = object(entry, 'operation');
    const parts = pointer(operation.path);
    const key = parts.pop()!;
    let parent: unknown = content;
    for (const part of parts) {
      if ((!isObject(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, part))
        throw new CommandInputError('PATCH_PATH_MISSING', 'Patch parent does not exist.');
      parent = (parent as JsonObject)[part];
    }
    if (!isObject(parent) && !Array.isArray(parent))
      throw new CommandInputError('PATCH_PATH_MISSING', 'Patch parent is not a container.');
    const exists = Object.hasOwn(parent, key);
    const current = (parent as JsonObject)[key];
    if (!['add', 'replace', 'remove', 'test'].includes(String(operation.op)))
      throw new CommandInputError(
        'PATCH_OP_INVALID',
        'Supported patch operations: test, add, replace, remove.',
      );
    if (operation.op !== 'add' && !exists)
      throw new CommandInputError('PATCH_PATH_MISSING', 'Patch target does not exist.');
    if (operation.op === 'test') {
      if (!Object.hasOwn(operation, 'value') || !isDeepStrictEqual(current, operation.value))
        throw new CommandInputError('PATCH_TEST_FAILED', 'Patch test failed.');
      continue;
    }
    text(operation.basis, 'operation.basis');
    if (operation.op !== 'remove' && !Object.hasOwn(operation, 'value'))
      throw new CommandInputError('PATCH_VALUE_REQUIRED', 'Patch value is required.');
    if (Array.isArray(parent)) {
      const index = key === '-' && operation.op === 'add' ? parent.length : Number(key);
      if (
        !/^(0|[1-9]\d*|-)$/u.test(key) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > parent.length ||
        (operation.op !== 'add' && index === parent.length)
      )
        throw new CommandInputError('PATCH_INDEX_INVALID', 'Invalid array index.');
      if (operation.op === 'add') parent.splice(index, 0, operation.value);
      else if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = operation.value;
    } else if (operation.op === 'remove') delete parent[key];
    else parent[key] = operation.value;
  }
  return { content, changes: diffContent(original, content) };
}

const referenceTypes: Record<string, string> = {
  'flow data set': 'flow',
  'process data set': 'process',
  'life cycle model data set': 'model',
  'source data set': 'source',
  'contact data set': 'contact',
  'flow property data set': 'flowproperty',
  'unit group data set': 'unitgroup',
  'lcia method data set': 'lciamethod',
  flow: 'flow',
  process: 'process',
  model: 'model',
  source: 'source',
  contact: 'contact',
  flowproperty: 'flowproperty',
  unitgroup: 'unitgroup',
  lciamethod: 'lciamethod',
};
export function listContentReferences(content: JsonObject): JsonObject[] {
  const references: JsonObject[] = [];
  function visit(value: unknown, path: string) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`));
      return;
    }
    if (!isObject(value)) return;
    if (
      Object.hasOwn(value, '@refObjectId') ||
      Object.hasOwn(value, '@flowUUID') ||
      /\/referenceTo[^/]+$/u.test(path)
    ) {
      const declaredType = typeof value['@type'] === 'string' ? value['@type'] : null;
      const key = declaredType?.trim().toLowerCase();
      const type =
        key !== undefined && Object.hasOwn(referenceTypes, key) ? referenceTypes[key]! : null;
      const id = value['@refObjectId'] ?? value['@flowUUID'] ?? null;
      const version = value['@version'] ?? null;
      references.push({
        type,
        declaredType,
        unresolvedType: declaredType !== null && type === null,
        id,
        version,
        path,
        missing: [
          ...(declaredType ? [] : ['type']),
          ...(id ? [] : ['id']),
          ...(version ? [] : ['version']),
        ],
      });
    }
    for (const [key, entry] of Object.entries(value)) visit(entry, `${path}/${escaped(key)}`);
  }
  visit(content, '');
  return references;
}
