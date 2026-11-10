import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withBatchRunLock } from '../locks/run-lock.js';
import { contentHash, hashRuntimeFile, runtimeError } from './files.js';
import { assertTrustedManifest, componentKey } from './manifest.js';
import { assertRuntimeHost, inspectRuntimeHost } from './host.js';
import {
  cachePath,
  defaultRuntimeCache,
  ensureRuntimeCache,
  openRuntimeCache,
  readCacheJson,
  writeOnce,
} from './storage.js';
import { downloadRuntimeArchive, type DownloadOptions } from './download.js';
import { extractRuntimeArchive } from './archive.js';
import { acquireRuntimeLease, leasedRuntimeKeys, withRuntimeLeaseLock } from './leases.js';
import type { RuntimeComponent, RuntimeHost, TrustedRuntimeManifest } from './manifest-types.js';

export type RuntimeManagerOptions = DownloadOptions & {
  cacheDir?: string;
  host?: RuntimeHost;
  lease?: { id: string; owner: string };
  archiveSeeds?: Readonly<Record<string, string>>;
};
export type RuntimeComponentStatus = {
  id: string;
  version: string;
  key: string;
  status: 'ready' | 'missing' | 'unverified' | 'corrupt';
  root: string;
  reason: string | null;
};
export type RuntimeManagerReport = {
  schema: 'tiangong-lca.runtime-status.v1';
  manifest_sha256: string;
  platform: string;
  status: 'ready' | 'missing' | 'blocked';
  components: RuntimeComponentStatus[];
};
function receipt(component: RuntimeComponent) {
  return {
    schema: 'tiangong-lca.runtime-component.v1',
    key: componentKey(component),
    archive_sha256: component.archive.sha256,
    content_sha256: component.content_sha256,
  };
}
export function verifyRuntimeComponent(
  root: string,
  component: RuntimeComponent,
  platform: string,
): void {
  const expected = new Map(component.files.map((file) => [file.path, file]));
  let count = 0;
  const walk = (relative: string): void => {
    const directory = relative ? cachePath(root, relative) : root;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      runtimeError('RUNTIME_COMPONENT_PATH', 'Component directories cannot be links.');
    for (const name of fs.readdirSync(directory)) {
      const file = relative ? `${relative}/${name}` : name;
      const target = cachePath(root, file);
      const item = fs.lstatSync(target);
      if (item.isDirectory()) walk(file);
      else {
        const expectedFile = expected.get(file);
        if (!expectedFile)
          runtimeError('RUNTIME_COMPONENT_EXTRA', 'Component contains an unregistered file.');
        const actual = hashRuntimeFile(target, file);
        if (
          actual.bytes !== expectedFile.bytes ||
          actual.sha256 !== expectedFile.sha256 ||
          (platform !== 'win32-x64' && (item.mode & 0o777) !== expectedFile.mode)
        )
          runtimeError(
            'RUNTIME_COMPONENT_CHANGED',
            'Component file bytes, digest or executable mode changed.',
          );
        count++;
      }
    }
  };
  walk('');
  if (count !== component.files.length)
    runtimeError('RUNTIME_COMPONENT_MISSING', 'Component inventory is incomplete.');
}
function inspectComponent(
  cache: string,
  component: RuntimeComponent,
  platform: string,
): RuntimeComponentStatus {
  const key = componentKey(component),
    relative = `components/${key}`,
    root = cachePath(cache, `${relative}/root`);
  const base = { id: component.id, version: component.version, key, root };
  if (!fs.existsSync(cachePath(cache, relative)))
    return { ...base, status: 'missing', reason: null };
  try {
    if (
      fs
        .readdirSync(cachePath(cache, relative))
        .some((name) => !['root', 'receipt.json'].includes(name))
    )
      runtimeError(
        'RUNTIME_COMPONENT_EXTRA',
        'Component installation directory contains unknown data.',
      );
    if (!fs.existsSync(cachePath(cache, `${relative}/receipt.json`)))
      return { ...base, status: 'unverified', reason: 'runtime_install_incomplete' };
    if (
      contentHash(readCacheJson(cache, `${relative}/receipt.json`)) !==
      contentHash(receipt(component))
    )
      runtimeError(
        'RUNTIME_RECEIPT_CHANGED',
        'Component installation receipt does not match the selected manifest.',
      );
    verifyRuntimeComponent(root, component, platform);
    return { ...base, status: 'ready', reason: null };
  } catch (error) {
    return {
      ...base,
      status: 'corrupt',
      reason:
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'runtime_component_invalid',
    };
  }
}
function selected(value: TrustedRuntimeManifest, options: RuntimeManagerOptions) {
  assertTrustedManifest(value);
  const host = options.host ?? inspectRuntimeHost();
  assertRuntimeHost(value, host);
  return {
    host,
    components: value.manifest.components.filter(
      (component) => component.platform === host.platform,
    ),
  };
}
export function inspectRuntimeComponents(
  value: TrustedRuntimeManifest,
  options: RuntimeManagerOptions = {},
): RuntimeManagerReport {
  const { host, components } = selected(value, options),
    cache = openRuntimeCache(options.cacheDir ?? defaultRuntimeCache(), false);
  const states = components.map((component) => inspectComponent(cache, component, host.platform));
  return {
    schema: 'tiangong-lca.runtime-status.v1',
    manifest_sha256: value.sha256,
    platform: host.platform,
    status: states.every((item) => item.status === 'ready')
      ? 'ready'
      : states.some((item) => item.status === 'corrupt' || item.status === 'unverified')
        ? 'blocked'
        : 'missing',
    components: states,
  };
}
async function installComponent(
  cache: string,
  component: RuntimeComponent,
  options: RuntimeManagerOptions,
  platform: string,
): Promise<void> {
  const key = componentKey(component);
  await withBatchRunLock(
    {
      runPath: cachePath(cache, `locks/${key}.json`),
      identity: { schema: 'runtime-component-lock.v1', key },
      reason: 'Runtime component installation',
    },
    async () => {
      const state = inspectComponent(cache, component, platform);
      if (state.status === 'ready') return;
      const target = cachePath(cache, `components/${key}`);
      if (state.status === 'unverified') {
        // Bootstrap may publish a complete tree before Node can produce the CLI receipt.
        // It is cache data only: adopt after every declared byte/mode and absence of extra files is proved.
        verifyRuntimeComponent(state.root, component, platform);
        writeOnce(
          cache,
          `components/${key}/receipt.json`,
          Buffer.from(JSON.stringify(receipt(component)) + '\n'),
        );
        return;
      }
      if (state.status === 'corrupt')
        runtimeError(
          'RUNTIME_CACHE_CORRUPT',
          'A selected cached component is corrupt; preserve active leases and prune it explicitly.',
        );
      const staging = cachePath(cache, `tmp/${key}-${randomUUID()}`);
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      try {
        const archive = path.join(staging, 'component.tar.gz'),
          seed = options.archiveSeeds?.[key];
        if (seed) {
          const fact = hashRuntimeFile(seed, 'archive');
          if (fact.bytes !== component.archive.bytes || fact.sha256 !== component.archive.sha256)
            runtimeError(
              'RUNTIME_ARCHIVE_SEED',
              'Supplied archive seed differs from the trusted component.',
            );
          fs.copyFileSync(seed, archive, fs.constants.COPYFILE_EXCL);
        } else await downloadRuntimeArchive(component.archive, archive, options);
        await extractRuntimeArchive(archive, path.join(staging, 'root'), component, options.signal);
        verifyRuntimeComponent(path.join(staging, 'root'), component, platform);
        fs.unlinkSync(archive);
        writeOnce(staging, 'receipt.json', Buffer.from(JSON.stringify(receipt(component)) + '\n'));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        cachePath(cache, `components/${key}`);
        if (fs.existsSync(target))
          runtimeError(
            'RUNTIME_INSTALL_CONFLICT',
            'Another component tree appeared outside the installation lock.',
          );
        fs.renameSync(staging, target);
      } finally {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      }
    },
  );
}
export async function ensureRuntimeComponents(
  value: TrustedRuntimeManifest,
  options: RuntimeManagerOptions = {},
): Promise<RuntimeManagerReport> {
  const { host, components } = selected(value, options);
  options.signal?.throwIfAborted();
  const cache = await ensureRuntimeCache(options.cacheDir ?? defaultRuntimeCache());
  if (options.lease)
    await acquireRuntimeLease(
      cache,
      options.lease.id,
      options.lease.owner,
      components.map(componentKey),
    );
  for (const component of components) {
    options.signal?.throwIfAborted();
    await installComponent(cache, component, options, host.platform);
  }
  return inspectRuntimeComponents(value, { ...options, cacheDir: cache, host });
}
export async function pruneRuntimeComponents(
  value: TrustedRuntimeManifest,
  options: RuntimeManagerOptions = {},
): Promise<{ removed: string[]; retained: string[] }> {
  const { components } = selected(value, options);
  const cache = openRuntimeCache(options.cacheDir ?? defaultRuntimeCache(), false);
  if (!fs.existsSync(cachePath(cache, '.runtime-cache.json'))) return { removed: [], retained: [] };
  return withRuntimeLeaseLock(cache, async () => {
    const pinned = leasedRuntimeKeys(cache),
      removed: string[] = [],
      retained: string[] = [];
    for (const component of components) {
      const key = componentKey(component);
      if (pinned.has(key)) {
        retained.push(key);
        continue;
      }
      await withBatchRunLock(
        {
          runPath: cachePath(cache, `locks/${key}.json`),
          identity: { schema: 'runtime-component-lock.v1', key },
          reason: 'Explicit unused runtime pruning',
        },
        () => {
          const target = cachePath(cache, `components/${key}`);
          if (!fs.existsSync(target)) return;
          if (fs.readdirSync(target).some((name) => !['root', 'receipt.json'].includes(name)))
            runtimeError(
              'RUNTIME_PRUNE_UNOWNED',
              'Unknown files must be preserved instead of pruned.',
            );
          if (
            contentHash(readCacheJson(cache, `components/${key}/receipt.json`)) !==
            contentHash(receipt(component))
          )
            runtimeError(
              'RUNTIME_PRUNE_UNOWNED',
              'Only an installation with its exact ownership receipt can be pruned.',
            );
          fs.rmSync(target, { recursive: true, force: false });
          removed.push(key);
        },
      );
    }
    return { removed, retained };
  });
}
