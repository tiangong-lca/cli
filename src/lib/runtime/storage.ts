import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { withBatchRunLock } from '../locks/run-lock.js';
import { runtimeError } from './files.js';
const marker = Buffer.from('{"schema":"tiangong-lca.runtime-cache.v1"}\n');

export function defaultRuntimeCache(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
        : env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(base, 'tiangong-lca', 'runtimes', 'v1');
}
export function canonicalCacheRoot(value: string): string {
  if (!path.isAbsolute(value))
    runtimeError('RUNTIME_CACHE_PATH', 'Runtime cache must be an absolute directory.');
  const missing: string[] = [];
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current)
      runtimeError('RUNTIME_CACHE_PATH', 'Runtime cache has no existing parent.');
    current = parent;
  }
  if (missing.length && !fs.statSync(current).isDirectory())
    runtimeError('RUNTIME_CACHE_PATH', 'Runtime cache parent must be a directory.');
  const root = path.join(fs.realpathSync(current), ...missing);
  if (root === path.parse(root).root || root === os.homedir())
    runtimeError('RUNTIME_CACHE_PATH', 'A filesystem or home root cannot be a runtime cache.');
  return root;
}
export function cachePath(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes('\\') ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')
  )
    runtimeError('RUNTIME_CACHE_PATH', 'Cache paths must remain within the owned root.');
  let current = root;
  for (const segment of ['', ...relative.split('/')]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current !== path.join(root, relative) && !stat.isDirectory()))
        runtimeError('RUNTIME_CACHE_PATH', 'Cache paths cannot traverse links or non-directories.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}
export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const wrote = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (wrote <= 0)
      runtimeError('RUNTIME_WRITE_FAILED', 'Runtime artifact could not be written completely.');
    offset += wrote;
  }
}
export function writeOnce(root: string, relative: string, bytes: Uint8Array): void {
  const target = cachePath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  cachePath(root, relative);
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isFile() || !fs.readFileSync(target).equals(Buffer.from(bytes)))
      runtimeError('RUNTIME_CACHE_CONFLICT', 'An immutable cache record cannot be replaced.');
    return;
  }
  const temp = cachePath(root, `${relative}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    writeAll(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!fs.readFileSync(target).equals(Buffer.from(bytes)))
        runtimeError('RUNTIME_CACHE_CONFLICT', 'Concurrent cache records disagree.');
    }
  } finally {
    fs.unlinkSync(temp);
  }
}
export function openRuntimeCache(value: string, create: boolean): string {
  const root = canonicalCacheRoot(value);
  const file = cachePath(root, '.runtime-cache.json');
  if (!fs.existsSync(file)) {
    if (
      fs.existsSync(root) &&
      (!fs.lstatSync(root).isDirectory() || fs.readdirSync(root).length > 0)
    )
      runtimeError('RUNTIME_CACHE_UNOWNED', 'Existing data is not a runtime-manager cache.');
    if (!create) return root;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeOnce(root, '.runtime-cache.json', marker);
  }
  if (
    !fs.lstatSync(file).isFile() ||
    fs.lstatSync(file).size !== marker.length ||
    !fs.readFileSync(file).equals(marker)
  )
    runtimeError('RUNTIME_CACHE_UNOWNED', 'Runtime cache ownership marker is invalid.');
  return root;
}
export function readCacheJson(root: string, relative: string, limit = 1024 * 1024): unknown {
  const file = cachePath(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit)
    runtimeError('RUNTIME_CACHE_RECORD', 'Runtime cache record must be a bounded regular file.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit)
    runtimeError('RUNTIME_CACHE_RECORD', 'Runtime cache record grew while reading.');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    runtimeError('RUNTIME_CACHE_RECORD', 'Runtime cache record is not complete JSON.');
  }
}

export async function ensureRuntimeCache(value: string): Promise<string> {
  const root = canonicalCacheRoot(value);
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  return withBatchRunLock(
    {
      runPath: `${root}.initialize.json`,
      identity: { schema: 'runtime-cache-initialize.v1', root },
      reason: 'Runtime cache initialization',
    },
    () => openRuntimeCache(root, true),
  );
}
