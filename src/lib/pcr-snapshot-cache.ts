import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withBatchRunLock } from './batch/run-lock.js';
import {
  canonicalCacheRoot,
  cachePath,
  defaultRuntimeCache,
  writeOnce,
} from './runtime/storage.js';
import { hashRuntimeFile } from './runtime/files.js';
import { downloadRuntimeArchive } from './runtime/download.js';
import type { FetchLike } from './http.js';
import {
  PCR_PIN_SCHEMA,
  PCR_METADATA_LIMIT,
  LEGACY_COMPATIBILITY,
  LEGACY_SOURCE,
  HISTORICAL_CONTENT_COMPATIBILITY,
  isAuditedHistoricalContent,
  BASELINE_READER,
  compatibleReader,
  pcrError,
  digest,
  parseJson,
  parsePin,
  cacheKey,
  snapshotIdentity,
  releaseUrl,
  compareVersions,
  type SnapshotPin,
  type FileProof,
  type ReaderProfile,
} from './pcr-snapshot-contract.js';
import { selectPublishedSnapshot } from './pcr-snapshot-release.js';

const MARKER = Buffer.from('{"schema":"tiangong-lca.pcr-snapshot-cache.v1"}\n');
const LOCK_FILE = 'pcr-snapshot-lock.json';
export type SnapshotOptions = {
  taskDir: string;
  cacheDir?: string;
  version?: string;
  library?: string;
  librarySha256?: string;
  offline?: boolean;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  reader?: ReaderProfile;
};
export type SnapshotResolution = {
  schema: 'tiangong-lca.pcr-snapshot-status.v1';
  status: 'snapshot-ready' | 'missing';
  pin: SnapshotPin | null;
  library: string | null;
  lock_file: string;
  network: 'checked-published' | 'none';
};
export function defaultPcrCache(): string {
  return path.join(path.dirname(path.dirname(defaultRuntimeCache())), 'pcr-snapshots', 'v1');
}
function readBytes(root: string, relative: string, maximum = PCR_METADATA_LIMIT): Buffer {
  const filename = cachePath(root, relative),
    stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > maximum)
    pcrError('FILE', 'PCR metadata must be a bounded regular file.');
  const bytes = fs.readFileSync(filename);
  if (bytes.length > maximum) pcrError('LIMIT', 'PCR metadata grew beyond its budget.');
  return bytes;
}
function matchFile(root: string, relative: string, expected: FileProof): void {
  const observed = hashRuntimeFile(cachePath(root, relative), relative);
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256)
    pcrError('INTEGRITY', 'Pinned PCR artifact bytes changed.');
}
function openCache(root: string, create: boolean): void {
  const marker = cachePath(root, '.pcr-cache.json');
  if (!fs.existsSync(marker)) {
    if (
      fs.existsSync(root) &&
      (!fs.lstatSync(root).isDirectory() || fs.readdirSync(root).length > 0)
    )
      pcrError('CACHE_UNOWNED', 'Existing data is not a PCR snapshot cache.');
    if (!create) return;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeOnce(root, '.pcr-cache.json', MARKER);
  }
  if (!readBytes(root, '.pcr-cache.json').equals(MARKER))
    pcrError('CACHE_UNOWNED', 'PCR cache ownership marker is invalid.');
}
function roots(options: SnapshotOptions): { task: string; cache: string } {
  const task = canonicalCacheRoot(options.taskDir),
    cache = canonicalCacheRoot(options.cacheDir ?? defaultPcrCache());
  if (
    task === cache ||
    task.startsWith(`${cache}${path.sep}`) ||
    cache.startsWith(`${task}${path.sep}`)
  )
    pcrError('PATH', 'Task and PCR cache must be separate directory trees.');
  cachePath(task, LOCK_FILE);
  return { task, cache };
}
export function verifyCachedSnapshot(cache: string, pin: SnapshotPin): string {
  openCache(cache, false);
  const relative = `snapshots/${cacheKey(pin)}`;
  if (
    fs.readdirSync(cachePath(cache, relative)).sort().join(',') !==
    'library.sqlite,library.sqlite.json,pin.json,release.json'
  )
    pcrError('CACHE_UNOWNED', 'PCR snapshot cache contains unknown or missing artifacts.');
  const stored = parsePin(parseJson(readBytes(cache, `${relative}/pin.json`)));
  if (JSON.stringify({ ...stored, selection: pin.selection }) !== JSON.stringify(pin))
    pcrError('PIN_CONFLICT', 'Cached PCR snapshot identity differs from the task pin.');
  matchFile(cache, `${relative}/library.sqlite`, pin.database);
  matchFile(cache, `${relative}/library.sqlite.json`, pin.sidecar);
  const identity = snapshotIdentity(parseJson(readBytes(cache, `${relative}/library.sqlite.json`)));
  if (
    identity.version !== pin.version ||
    identity.source_commit !== pin.source_commit ||
    identity.source_sha256 !== pin.source_sha256 ||
    JSON.stringify(identity.database) !== JSON.stringify(pin.database)
  )
    pcrError('PIN_CONFLICT', 'PCR sidecar identity differs from the task pin.');
  const release = readBytes(cache, `${relative}/release.json`);
  if (pin.release !== null && digest(release) !== pin.release.sha256)
    pcrError('INTEGRITY', 'PCR release metadata changed.');
  return cachePath(cache, `${relative}/library.sqlite`);
}
function resolution(
  task: string,
  cache: string,
  pin: SnapshotPin | null,
  network: SnapshotResolution['network'],
): SnapshotResolution {
  return {
    schema: 'tiangong-lca.pcr-snapshot-status.v1',
    status: pin === null ? 'missing' : 'snapshot-ready',
    pin,
    library: pin === null ? null : verifyCachedSnapshot(cache, pin),
    lock_file: cachePath(task, LOCK_FILE),
    network,
  };
}
function retainedPin(task: string): SnapshotPin | null {
  return fs.existsSync(cachePath(task, LOCK_FILE))
    ? parsePin(parseJson(readBytes(task, LOCK_FILE)))
    : null;
}
function assertSelection(options: SnapshotOptions, pin: SnapshotPin): void {
  if (options.version !== undefined && options.version !== pin.version)
    pcrError('PIN_CONFLICT', 'The task already pins another PCR version.');
  if (
    options.librarySha256 !== undefined &&
    options.librarySha256 !== `sha256:${pin.database.sha256}`
  )
    pcrError('PIN_CONFLICT', 'The task already pins another PCR checksum.');
  if (options.library !== undefined) {
    const root = canonicalCacheRoot(path.dirname(path.resolve(options.library)));
    matchFile(root, path.basename(options.library), pin.database);
    matchFile(root, `${path.basename(options.library)}.json`, pin.sidecar);
  }
}
export function inspectPcrSnapshot(options: SnapshotOptions): SnapshotResolution {
  const { task, cache } = roots(options),
    pin = retainedPin(task);
  if (pin !== null) assertSelection(options, pin);
  return resolution(task, cache, pin, 'none');
}
function localSelection(options: SnapshotOptions): {
  pin: SnapshotPin;
  sidecar: Buffer;
  release: Buffer;
} {
  if (!options.library || !options.librarySha256)
    pcrError(
      'PIN_REQUIRED',
      'Explicit local PCR libraries require --library and --library-sha256 together.',
    );
  if (!path.isAbsolute(options.library))
    pcrError('PATH', 'Explicit PCR library paths must be absolute.');
  const root = canonicalCacheRoot(path.dirname(options.library)),
    filename = path.basename(options.library);
  const sidecar = readBytes(root, `${filename}.json`),
    identity = snapshotIdentity(parseJson(sidecar));
  const sidecarProof = { bytes: sidecar.length, sha256: digest(sidecar) };
  const historical = isAuditedHistoricalContent(identity, sidecarProof);
  const compatibility = historical ? HISTORICAL_CONTENT_COMPATIBILITY : LEGACY_COMPATIBILITY;
  if (!historical && (identity.version !== '0.4.1' || identity.source_commit !== LEGACY_SOURCE))
    pcrError(
      'INCOMPATIBLE',
      'Local library selection requires an audited content compatibility profile.',
    );
  if (
    options.librarySha256 !== `sha256:${identity.database.sha256}` ||
    (options.version !== undefined && identity.version !== options.version)
  )
    pcrError('PIN_CONFLICT', 'Explicit PCR selectors disagree.');
  matchFile(root, filename, identity.database);
  return {
    pin: {
      schema: PCR_PIN_SCHEMA,
      ...identity,
      sidecar: sidecarProof,
      release: null,
      selection: 'explicit-library',
      compatibility,
    },
    sidecar,
    release: Buffer.from('null\n'),
  };
}
function offlineSelection(
  cache: string,
  version: string | undefined,
  reader: ReaderProfile,
): { pin: SnapshotPin; sidecar: Buffer; release: Buffer } {
  openCache(cache, false);
  const directory = cachePath(cache, 'snapshots');
  const candidates = fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .map((key) => {
          if (!/^[a-f0-9]{64}$/u.test(key))
            pcrError('CACHE_UNOWNED', 'PCR cache contains an unknown snapshot directory.');
          const pin = parsePin(parseJson(readBytes(cache, `snapshots/${key}/pin.json`)));
          if (cacheKey(pin) !== key)
            pcrError('CACHE_UNOWNED', 'PCR cache key differs from its snapshot identity.');
          verifyCachedSnapshot(cache, pin);
          return pin;
        })
        .filter(
          (pin) =>
            (version === undefined || pin.version === version) &&
            compatibleReader(pin.compatibility, reader),
        )
        .sort((a, b) => compareVersions(b.version, a.version))
    : [];
  const chosen = candidates[0];
  if (!chosen)
    pcrError('OFFLINE_MISSING', 'No verified selected PCR snapshot is available offline.');
  const relative = `snapshots/${cacheKey(chosen)}`;
  return {
    pin: { ...chosen, selection: 'offline-cache' },
    sidecar: readBytes(cache, `${relative}/library.sqlite.json`),
    release: readBytes(cache, `${relative}/release.json`),
  };
}
export async function ensurePcrSnapshot(options: SnapshotOptions): Promise<SnapshotResolution> {
  const { task, cache } = roots(options);
  if ((options.library === undefined) !== (options.librarySha256 === undefined))
    pcrError('PIN_REQUIRED', 'Local PCR selection requires both path and trusted checksum.');
  return withBatchRunLock(
    {
      runPath: cachePath(task, '.pcr-snapshot'),
      identity: { schema: PCR_PIN_SCHEMA, task },
      reason: 'Immutable task PCR snapshot preparation',
    },
    async () => {
      const retained = retainedPin(task);
      if (retained !== null) {
        assertSelection(options, retained);
        return resolution(task, cache, retained, 'none');
      }
      const selected =
        options.library !== undefined
          ? localSelection(options)
          : options.offline
            ? offlineSelection(cache, options.version, options.reader ?? BASELINE_READER)
            : await selectPublishedSnapshot(
                options.fetchImpl ?? fetch,
                options.version,
                options.signal,
                options.reader,
              );
      if (!compatibleReader(selected.pin.compatibility, options.reader ?? BASELINE_READER))
        pcrError('INCOMPATIBLE', 'PCR snapshot is incompatible with the selected reader.');
      await withBatchRunLock(
        {
          runPath: `${cache}.initialize`,
          identity: { schema: 'pcr-cache-initialize.v1', cache },
          reason: 'PCR cache ownership initialization',
        },
        () => openCache(cache, true),
      );
      const relative = `snapshots/${cacheKey(selected.pin)}`;
      await withBatchRunLock(
        {
          runPath: cachePath(cache, `locks/${cacheKey(selected.pin)}`),
          identity: { schema: 'pcr-cache-install.v1', key: cacheKey(selected.pin) },
          reason: 'PCR snapshot cache installation',
        },
        async () => {
          if (fs.existsSync(cachePath(cache, relative))) {
            verifyCachedSnapshot(cache, selected.pin);
            return;
          }
          const stage = `staging/${randomUUID()}`;
          fs.mkdirSync(cachePath(cache, stage), { recursive: true, mode: 0o700 });
          try {
            if (options.library !== undefined) {
              fs.copyFileSync(
                options.library,
                cachePath(cache, `${stage}/library.sqlite`),
                fs.constants.COPYFILE_EXCL,
              );
              matchFile(cache, `${stage}/library.sqlite`, selected.pin.database);
            } else
              await downloadRuntimeArchive(
                {
                  ...selected.pin.database,
                  url: releaseUrl(selected.pin.version, 'library.sqlite'),
                },
                cachePath(cache, `${stage}/library.sqlite`),
                { fetchImpl: options.fetchImpl, signal: options.signal },
              );
            writeOnce(cache, `${stage}/library.sqlite.json`, selected.sidecar);
            writeOnce(cache, `${stage}/release.json`, selected.release);
            writeOnce(cache, `${stage}/pin.json`, Buffer.from(`${JSON.stringify(selected.pin)}\n`));
            fs.mkdirSync(cachePath(cache, 'snapshots'), { recursive: true, mode: 0o700 });
            fs.renameSync(cachePath(cache, stage), cachePath(cache, relative));
          } finally {
            fs.rmSync(cachePath(cache, stage), { recursive: true, force: true });
          }
        },
      );
      verifyCachedSnapshot(cache, selected.pin);
      writeOnce(task, LOCK_FILE, Buffer.from(`${JSON.stringify(selected.pin)}\n`));
      return resolution(
        task,
        cache,
        selected.pin,
        selected.pin.selection === 'latest-compatible' ||
          selected.pin.selection === 'explicit-version'
          ? 'checked-published'
          : 'none',
      );
    },
  );
}
