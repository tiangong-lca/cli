import fs from 'node:fs';
import { withBatchRunLock } from '../locks/run-lock.js';
import { contentHash, runtimeError } from './files.js';
import { array, exact, record, sha, text, unique } from './manifest-values.js';
import { cachePath, readCacheJson, writeOnce } from './storage.js';

export type RuntimeLease = Readonly<{
  schema: 'tiangong-lca.runtime-lease.v1';
  id: string;
  owner: string;
  components: readonly string[];
}>;
export function runtimeLeaseKey(id: string): string {
  return contentHash(text(id, 'lease id', 256));
}
export async function withRuntimeLeaseLock<T>(
  root: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withBatchRunLock(
    {
      runPath: cachePath(root, 'locks/leases.json'),
      identity: { schema: 'runtime-lease-lock.v1' },
      reason: 'Runtime component lease mutation',
    },
    operation,
  );
}
export function readRuntimeLease(root: string, key: string): RuntimeLease {
  sha(key);
  const value = record(readCacheJson(root, `leases/${key}.json`), 'lease');
  exact(value, ['schema', 'id', 'owner', 'components'], 'lease');
  if (value.schema !== 'tiangong-lca.runtime-lease.v1')
    runtimeError('RUNTIME_LEASE_INVALID', 'Unknown runtime lease schema.');
  const id = text(value.id, 'lease id', 256),
    owner = text(value.owner, 'lease owner', 4096),
    components = array(value.components, 128, 1).map(sha);
  unique(components, 'lease component');
  if (runtimeLeaseKey(id) !== key)
    runtimeError('RUNTIME_LEASE_INVALID', 'Runtime lease identity changed.');
  return { schema: 'tiangong-lca.runtime-lease.v1', id, owner, components };
}
export async function acquireRuntimeLease(
  root: string,
  id: string,
  owner: string,
  components: readonly string[],
): Promise<RuntimeLease> {
  const lease: RuntimeLease = {
    schema: 'tiangong-lca.runtime-lease.v1',
    id: text(id, 'lease id', 256),
    owner: text(owner, 'lease owner', 4096),
    components: [...components].sort(),
  };
  array(components, 128, 1).forEach(sha);
  unique(components, 'lease component');
  return withRuntimeLeaseLock(root, () => {
    const key = runtimeLeaseKey(id),
      file = cachePath(root, `leases/${key}.json`);
    if (fs.existsSync(file) && contentHash(readRuntimeLease(root, key)) !== contentHash(lease))
      runtimeError(
        'RUNTIME_LEASE_CONFLICT',
        'Existing lease pins another owner or component set; release it explicitly before replacement.',
      );
    writeOnce(root, `leases/${key}.json`, Buffer.from(JSON.stringify(lease) + '\n'));
    return Object.freeze(lease);
  });
}
export async function releaseRuntimeLease(
  root: string,
  id: string,
  owner: string,
): Promise<boolean> {
  return withRuntimeLeaseLock(root, () => {
    const key = runtimeLeaseKey(id),
      file = cachePath(root, `leases/${key}.json`);
    if (!fs.existsSync(file)) return false;
    if (readRuntimeLease(root, key).owner !== owner)
      runtimeError(
        'RUNTIME_LEASE_OWNER',
        'Only the same explicit lease owner can release a runtime pin.',
      );
    fs.unlinkSync(file);
    return true;
  });
}
export function leasedRuntimeKeys(root: string): Set<string> {
  const directory = cachePath(root, 'leases');
  if (!fs.existsSync(directory)) return new Set();
  const names = fs.readdirSync(directory);
  if (names.length > 10_000)
    runtimeError('RUNTIME_LEASE_LIMIT', 'Lease inventory exceeds its bound.');
  const keys = new Set<string>();
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/u.test(name))
      runtimeError('RUNTIME_LEASE_INVALID', 'Unknown lease record prevents cache pruning.');
    for (const key of readRuntimeLease(root, name.slice(0, -5)).components) keys.add(key);
  }
  return keys;
}
