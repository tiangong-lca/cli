import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from './dataset-local.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const TYPES = [
  'contact',
  'source',
  'flow',
  'flowproperty',
  'unitgroup',
  'process',
  'lifecyclemodel',
];
const MAX_BYTES = 1024 * 1024;
export type ExclusionsFact = { path: string; sha256: string; bytes: number; entries: number };

export function loadDatasetReadExclusions(
  inputPath: string | undefined,
  fail: (code: string, message: string) => never,
): { fact: ExclusionsFact | null; keys: Set<string> } {
  if (inputPath === undefined) return { fact: null, keys: new Set() };
  try {
    const file = path.resolve(inputPath);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    try {
      if (!fstatSync(fd).isFile()) throw new Error();
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (count === 0) break;
        bytes += count;
      }
    } finally {
      closeSync(fd);
    }
    if (bytes > MAX_BYTES) throw new Error();
    const content = buffer.subarray(0, bytes);
    const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (!Array.isArray(rows) || rows.length > 10_000) throw new Error();
    const keys = new Set<string>();
    for (const row of rows) {
      if (
        !isRecord(row) ||
        Object.keys(row).sort().join(',') !== 'id,type,version' ||
        typeof row.type !== 'string' ||
        !TYPES.includes(row.type) ||
        typeof row.id !== 'string' ||
        !UUID.test(row.id) ||
        typeof row.version !== 'string' ||
        !VERSION.test(row.version)
      )
        throw new Error();
      const key = `${row.type}:${row.id}@${row.version}`;
      if (keys.has(key)) throw new Error();
      keys.add(key);
    }
    return {
      fact: {
        path: file,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes,
        entries: rows.length,
      },
      keys,
    };
  } catch {
    fail(
      'EXCLUSIONS_INVALID',
      'Typed exclusions must be a bounded regular UTF-8 JSON file of unique exact type/id/version objects.',
    );
  }
}
