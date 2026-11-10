import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotFixture } from './helpers/pcr-snapshot.js';
import {
  ensurePcrSnapshot,
  inspectPcrSnapshot,
  defaultPcrCache,
} from '../src/lib/pcr-snapshot-cache.js';
import {
  selectPublishedSnapshot,
  publishedVersions,
  metadataBytes,
} from '../src/lib/pcr-snapshot-release.js';
import { runPcrCommand } from '../src/commands/pcr.js';
import {
  inspectPcrTool,
  selectedPcrTool,
  bindPcrTool,
  executePinnedPcr,
  pcrIntegrityVerified,
  verifyPinnedPcrIntegrity,
} from '../src/lib/pcr-snapshot-tool.js';
import {
  parsePin,
  parseJson,
  snapshotIdentity,
  stableVersion,
  prefixedSha,
  proof,
  object,
  parseCompatibility,
  compatibleReader,
  BASELINE_READER,
  compareVersions,
  digest,
  cacheKey,
  PCR_METADATA_LIMIT,
  AUDITED_HISTORICAL_CONTENT,
  HISTORICAL_CONTENT_COMPATIBILITY,
  isAuditedHistoricalContent,
} from '../src/lib/pcr-snapshot-contract.js';
import { executeCli } from '../src/cli.js';
import { main } from '../src/main.js';
import Module, { syncBuiltinESMExports } from 'node:module';
import type { FetchLike } from '../src/lib/http.js';

test('new online task pins exact release while resume ignores newer publication; status does not create state', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  assert.equal(inspectPcrSnapshot(f.options).status, 'missing');
  assert.equal(fs.existsSync(f.task), false);
  assert.ok(defaultPcrCache().includes('pcr-snapshots'));
  const first = await ensurePcrSnapshot(f.options);
  assert.equal(first.network, 'checked-published');
  assert.equal(first.pin?.release?.source_fingerprint, f.release.identity.sourceFingerprint);
  assert.notEqual(first.pin?.source_sha256, f.release.identity.sourceFingerprint);
  const calls = f.calls.length;
  assert.deepEqual(
    await ensurePcrSnapshot({
      ...f.options,
      fetchImpl: async () => {
        throw Error('must not discover');
      },
    }),
    { ...first, network: 'none' },
  );
  assert.equal(f.calls.length, calls);
  await assert.rejects(
    ensurePcrSnapshot({ ...f.options, version: '0.4.2' }),
    /another PCR version/u,
  );
  await assert.rejects(
    ensurePcrSnapshot({ ...f.options, librarySha256: 'sha256:' + '0'.repeat(64) }),
    /both path/u,
  );
  assert.equal(inspectPcrSnapshot(f.options).library, first.library);
});
test('explicit local pair is copied immutably and offline cached selection uses no network', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const ready = await ensurePcrSnapshot(f.localOptions);
  assert.equal(ready.network, 'none');
  assert.equal(ready.pin?.selection, 'explicit-library');
  assert.deepEqual(fs.readFileSync(ready.library!), f.database);
  const reused = await ensurePcrSnapshot({ ...f.localOptions, offline: true });
  assert.equal(reused.pin?.version, '0.4.1');
  const offline = await ensurePcrSnapshot({
    ...f.options,
    taskDir: path.join(f.base, 'offline'),
    offline: true,
  });
  assert.equal(offline.pin?.selection, 'offline-cache');
  assert.equal(offline.network, 'none');
  await assert.rejects(
    ensurePcrSnapshot({
      ...f.options,
      taskDir: path.join(f.base, 'other'),
      offline: true,
      version: '0.4.2',
    }),
    /offline/u,
  );
  fs.writeFileSync(ready.library!, 'corrupt');
  assert.throws(() => inspectPcrSnapshot(f.options), /bytes changed/u);
});
test('preparation concurrency shares one immutable cache and task pin', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const [a, b] = await Promise.all([ensurePcrSnapshot(f.options), ensurePcrSnapshot(f.options)]);
  assert.deepEqual(a.pin, b.pin);
  assert.equal(b.network, 'none');
});
test('explicit version lookup excludes latest discovery', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  assert.equal(
    (await ensurePcrSnapshot({ ...f.options, version: '0.4.1' })).pin?.selection,
    'explicit-version',
  );
  assert.ok(f.calls[0]!.endsWith('/tags/v0.4.1'));
  for (const deceptive of [
    'https://api.github.com.evil.invalid/releases',
    'https://evil.invalid/api.github.com',
    'https://api.github.com:8443/releases',
    'http://api.github.com/releases',
  ]) {
    assert.equal(await (await f.fetchImpl(deceptive)).text(), f.database.toString());
  }
});
test('latest compatible content supports independent reader versions', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const releases = [
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v0.5.0' },
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v0.4.1' },
  ];
  const fetchImpl: FetchLike = async (url) =>
    new URL(url).origin === 'https://api.github.com'
      ? new Response(JSON.stringify(releases))
      : url.includes('v0.5.0/release.json')
        ? new Response(
            JSON.stringify({
              ...f.release,
              identity: { ...f.release.identity, version: '0.5.0', tag: 'v0.5.0' },
              compatibility: { ...f.compatibility, minimumReaderVersion: '0.5.0' },
            }),
          )
        : f.fetchImpl(url);
  const selected = await selectPublishedSnapshot(fetchImpl);
  assert.equal(selected.pin.version, '0.4.1');
  const newerSidecar = Buffer.from(
    JSON.stringify({ ...f.sidecar, snapshot: { ...f.sidecar.snapshot, content_version: '0.5.0' } }),
  );
  const supported: FetchLike = async (url) =>
    new URL(url).origin === 'https://api.github.com'
      ? new Response(JSON.stringify(releases))
      : url.includes('v0.5.0/release.json')
        ? new Response(
            JSON.stringify({
              ...f.release,
              identity: { ...f.release.identity, version: '0.5.0', tag: 'v0.5.0' },
              compatibility: f.compatibility,
              artifacts: [
                f.release.artifacts[0],
                {
                  filename: 'library.sqlite.json',
                  bytes: newerSidecar.length,
                  sha256: digest(newerSidecar),
                },
              ],
            }),
          )
        : url.includes('v0.5.0/library.sqlite.json')
          ? new Response(newerSidecar)
          : f.fetchImpl(url);
  assert.equal((await selectPublishedSnapshot(supported)).pin.version, '0.5.0');
});
test('tool selection binds full closure once, exec injects immutable selectors and clears source environment', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  await ensurePcrSnapshot(f.localOptions);
  const tool = inspectPcrTool(f.tool);
  bindPcrTool(f.localOptions, tool);
  await verifyPinnedPcrIntegrity(f.localOptions, tool);
  assert.deepEqual(selectedPcrTool(f.task), tool);
  const run = await executePinnedPcr(
    f.options,
    ['guidance', '--pcr', 'example'],
    { ...process.env, PCR_LIBRARY: '/other', NODE_OPTIONS: '--require malicious' },
    {
      spawnImpl: async (_executable, argv, options) => {
        assert.equal(options.shell, false);
        assert.equal(options.env?.PCR_LIBRARY, undefined);
        assert.equal(options.env?.NODE_OPTIONS, undefined);
        assert.deepEqual(argv.slice(-4), [
          '--library',
          inspectPcrSnapshot(f.options).library,
          '--library-sha256',
          f.localOptions.librarySha256,
        ]);
        return { stdout: 'bound', stderr: '', status: 0, signal: null };
      },
    },
  );
  assert.equal(run.stdout, 'bound');
  const native = await executePinnedPcr(f.options, ['inspect', '--input', 'example.json']);
  assert.deepEqual(JSON.parse(native.stdout), ['inspect', '--input', 'example.json']);
  await assert.rejects(executePinnedPcr(f.options, ['guidance', '--library=/other']), /overrides/u);
  await assert.rejects(executePinnedPcr(f.options, []), /bounded/u);
  fs.writeFileSync(path.join(f.tool, 'entry.js'), 'changed');
  assert.throws(() => selectedPcrTool(f.task), /selection changed/u);
});
test('command dispatch exposes preparation, status and pinned execution', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  assert.match((await runPcrCommand(null, [])).stdout, /Usage/u);
  assert.match((await runPcrCommand('snapshot', ['--help'])).stdout, /Usage/u);
  const missing = await runPcrCommand('snapshot', [
    'status',
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
    '--json',
  ]);
  assert.equal(missing.exitCode, 2);
  const ready = await runPcrCommand('snapshot', [
    'ensure',
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
    '--library',
    f.localOptions.library,
    '--library-sha256',
    f.localOptions.librarySha256,
    '--tool-root',
    f.tool,
    '--json',
  ]);
  assert.equal(JSON.parse(ready.stdout).task_usable, true);
  const status = await runPcrCommand('snapshot', [
    'status',
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
  ]);
  assert.match(status.stdout, /task-ready/u);
  const exec = await runPcrCommand('exec', [
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
    '--',
    'calculate',
    '--input',
    'a.json',
  ]);
  assert.deepEqual(JSON.parse(exec.stdout), ['calculate', '--input', 'a.json']);
  for (const [sub, args] of [
    ['bogus', []],
    ['snapshot', ['unknown']],
    ['exec', []],
    ['snapshot', ['status', '--unknown']],
    ['snapshot', ['status']],
    ['snapshot', ['status', '--task-dir', f.task, '--']],
    ['exec', ['--task-dir', f.task, '--version', '0.4.1', '--', 'guidance']],
  ] as const)
    await assert.rejects(runPcrCommand(sub, [...args]));
});
test('strict contracts reject malformed pins and unsupported compatibility', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const ready = await ensurePcrSnapshot(f.options),
    pin = ready.pin!;
  assert.deepEqual(parsePin(pin), pin);
  assert.equal(cacheKey(pin), cacheKey({ ...pin, selection: 'offline-cache' }));
  for (const value of [null, [], 1, 'a']) assert.throws(() => object(value));
  for (const v of ['01.2.3', '1.2.3-next', '1.2', '999999999999999999999.1.1'])
    assert.throws(() => stableVersion(v));
  assert.throws(() => prefixedSha('a'));
  assert.throws(() => prefixedSha('sha256:foo'));
  assert.throws(() => parseJson(Buffer.from([0xff])));
  assert.throws(() => parseJson(Buffer.from('{')));
  assert.throws(() => proof({ bytes: 0, sha256: '1'.repeat(64) }, 1));
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const patch of [
    { schema: 'wrong' },
    { format_version: 2 },
    { extra: true },
    { source_commit: 'bad' },
    { release: { url: 'https://evil', sha256: 'a', source_fingerprint: 'bad' } },
  ])
    assert.throws(() => parsePin({ ...pin, ...patch }));
  assert.equal(parsePin({ ...pin, release: null }).release, null);
  for (const patch of [
    { kind: 'bad' },
    { format_version: 2 },
    { snapshot: { ...f.sidecar.snapshot, available_languages: ['en-US', 'zh-CN'] } },
    { snapshot: { ...f.sidecar.snapshot, source_commit: 'bad' } },
    { snapshot: { ...f.sidecar.snapshot, source_sha256: 'bad' } },
    { index_sha256: {} },
  ])
    assert.throws(() => snapshotIdentity({ ...f.sidecar, ...patch }));
  for (const patch of [
    { schema: 2 },
    { projectionContracts: [] },
    { projectionContracts: ['1', '1'] },
    { projectionContracts: ['unknown'] },
    { libraryFormat: 0 },
    { commandProtocol: 0 },
    { extra: true },
  ])
    assert.throws(() => parseCompatibility({ ...f.compatibility, ...patch }));
  assert.equal(compatibleReader({ ...f.compatibility, libraryFormat: 2 }, BASELINE_READER), false);
  assert.equal(
    compatibleReader({ ...f.compatibility, projectionContracts: ['3'] }, BASELINE_READER),
    false,
  );
  assert.equal(
    compatibleReader({ ...f.compatibility, commandProtocol: 2 }, BASELINE_READER),
    false,
  );
});
test('release discovery excludes draft prerelease unversioned and incomplete publications', async () => {
  const records = [
    { draft: true },
    { draft: false, prerelease: true },
    { draft: false, prerelease: false, published_at: null },
    { draft: false, prerelease: false, published_at: 'bad', tag_name: 'v1.0.0' },
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v1.0.0-next' },
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v2.0.0' },
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v1.0.0' },
  ];
  assert.deepEqual(await publishedVersions(async () => new Response(JSON.stringify(records))), [
    '2.0.0',
    '1.0.0',
  ]);
  await assert.rejects(
    publishedVersions(async () => new Response(JSON.stringify(records[0])), '1.0.0'),
    /not a stable/u,
  );
  await assert.rejects(
    publishedVersions(async () => new Response('{}')),
    /listing/u,
  );
  await assert.rejects(
    publishedVersions(async () => new Response(JSON.stringify(Array(101).fill({})))),
    /listing/u,
  );
  await assert.rejects(
    publishedVersions(async () => new Response(JSON.stringify(Array(100).fill({ draft: true })))),
    /1000/u,
  );
});
test('metadata bounds, HTTP failure and redirect allowlist fail closed', async () => {
  await assert.rejects(
    metadataBytes(
      'https://api.github.com/repos/tiangong-lca/pcr/releases',
      async () => new Response(null, { status: 302, headers: { location: 'https://evil' } }),
    ),
    /redirect/u,
  );
  await assert.rejects(
    metadataBytes(
      'https://github.com/tiangong-lca/pcr/releases/download/v0.4.1/release.json',
      async () => new Response(null, { status: 302, headers: { location: 'https://evil' } }),
    ),
  );
  await assert.rejects(
    metadataBytes(
      'https://github.com/tiangong-lca/pcr/releases/download/v0.4.1/release.json',
      async () => new Response(null, { status: 302 }),
    ),
    /redirect/u,
  );
  await assert.rejects(
    metadataBytes(
      'https://github.com/tiangong-lca/pcr/releases/download/v0.4.1/release.json',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/file' },
        }),
    ),
    /redirect/u,
  );
  await assert.rejects(
    metadataBytes(
      'https://api.github.com/repos/tiangong-lca/pcr/releases',
      async () => new Response('body', { status: 503 }),
    ),
    /metadata/u,
  );
  await assert.rejects(
    metadataBytes(
      'https://api.github.com/repos/tiangong-lca/pcr/releases',
      async () => new Response(null),
    ),
    /metadata/u,
  );
  await assert.rejects(
    metadataBytes(
      'https://api.github.com/repos/tiangong-lca/pcr/releases',
      async () => new Response(Buffer.alloc(PCR_METADATA_LIMIT + 1)),
    ),
    /1 MiB/u,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    metadataBytes(
      'https://api.github.com/repos/tiangong-lca/pcr/releases',
      async () => new Response('{}'),
      controller.signal,
    ),
  );
});

test('local selectors and task/cache boundaries reject inconsistent or unavailable inputs', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  for (const options of [
    { ...f.options, cacheDir: f.task },
    { ...f.options, cacheDir: path.join(f.task, 'cache') },
    { ...f.options, taskDir: path.join(f.cache, 'task') },
    { ...f.localOptions, library: '' },
    { ...f.localOptions, library: 'relative.sqlite' },
    { ...f.localOptions, version: '0.4.2' },
    { ...f.localOptions, librarySha256: 'sha256:' + '0'.repeat(64) },
    { ...f.localOptions, reader: { ...BASELINE_READER, commandProtocol: 2 } },
    { ...f.options, offline: true },
  ])
    await assert.rejects(ensurePcrSnapshot(options));
  fs.writeFileSync(
    path.join(f.local, 'library.sqlite.json'),
    JSON.stringify({ ...f.sidecar, snapshot: { ...f.sidecar.snapshot, content_version: '0.4.2' } }),
  );
  await assert.rejects(ensurePcrSnapshot(f.localOptions), /audited/u);
});
test('unowned cache content and marker corruption are preserved', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  fs.mkdirSync(f.cache);
  fs.writeFileSync(path.join(f.cache, 'foreign'), 'retained');
  await assert.rejects(ensurePcrSnapshot(f.localOptions), /not a PCR/u);
  assert.equal(fs.readFileSync(path.join(f.cache, 'foreign'), 'utf8'), 'retained');
  fs.rmSync(f.cache, { recursive: true });
  await ensurePcrSnapshot(f.localOptions);
  fs.writeFileSync(path.join(f.cache, '.pcr-cache.json'), 'bad');
  assert.throws(() => inspectPcrSnapshot(f.options), /marker/u);
});
test('metadata files cannot be directories oversized or change during read', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  fs.mkdirSync(f.task);
  const lock = path.join(f.task, 'pcr-snapshot-lock.json');
  fs.mkdirSync(lock);
  assert.throws(() => inspectPcrSnapshot(f.options), /bounded regular/u);
  fs.rmSync(lock, { recursive: true });
  fs.writeFileSync(lock, Buffer.alloc(PCR_METADATA_LIMIT + 1));
  assert.throws(() => inspectPcrSnapshot(f.options), /bounded regular/u);
  fs.writeFileSync(lock, '{}');
  const read = fs.readFileSync.bind(fs);
  const mocking = t.mock.method(
    fs,
    'readFileSync',
    (filename: fs.PathOrFileDescriptor, ...args: unknown[]) =>
      String(filename).endsWith('pcr-snapshot-lock.json')
        ? Buffer.alloc(PCR_METADATA_LIMIT + 1)
        : Reflect.apply(read, fs, [filename, ...args]),
  );
  assert.throws(() => inspectPcrSnapshot(f.options), /grew/u);
  mocking.mock.restore();
});
test('cache rejects unknown files divergent receipts sidecar identity and release corruption', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const ready = await ensurePcrSnapshot(f.options),
    pin = ready.pin!;
  const root = path.dirname(ready.library!);
  fs.writeFileSync(path.join(root, 'foreign'), 'retain');
  assert.throws(() => inspectPcrSnapshot(f.options), /unknown/u);
  fs.unlinkSync(path.join(root, 'foreign'));
  fs.writeFileSync(
    path.join(root, 'pin.json'),
    JSON.stringify({ ...pin, source_sha256: 'sha256:' + '3'.repeat(64) }),
  );
  assert.throws(() => inspectPcrSnapshot(f.options), /Cached PCR/u);
  fs.writeFileSync(path.join(root, 'pin.json'), JSON.stringify(pin));
  fs.writeFileSync(path.join(root, 'release.json'), 'changed');
  assert.throws(() => inspectPcrSnapshot(f.options), /release metadata/u);
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(f.release));
  const altered = { ...pin, source_sha256: 'sha256:' + '3'.repeat(64) };
  const changedRoot = path.join(f.cache, 'snapshots', cacheKey(altered));
  fs.renameSync(root, changedRoot);
  fs.writeFileSync(path.join(changedRoot, 'pin.json'), JSON.stringify(altered));
  fs.writeFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), JSON.stringify(altered));
  assert.throws(() => inspectPcrSnapshot(f.options), /sidecar identity/u);
});
test('offline cache enumeration rejects unknown keys and changed key identities', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  await ensurePcrSnapshot(f.options);
  const directory = path.join(f.cache, 'snapshots');
  fs.mkdirSync(path.join(directory, 'unknown'));
  await assert.rejects(
    ensurePcrSnapshot({ ...f.options, taskDir: path.join(f.base, 'offline'), offline: true }),
    /unknown snapshot/u,
  );
  fs.rmdirSync(path.join(directory, 'unknown'));
  const key = fs.readdirSync(directory)[0]!;
  fs.renameSync(path.join(directory, key), path.join(directory, '0'.repeat(64)));
  await assert.rejects(
    ensurePcrSnapshot({ ...f.options, taskDir: path.join(f.base, 'offline'), offline: true }),
    /cache key/u,
  );
});
test('snapshot release mismatches fail before any database download or task pin', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const patches = [
    { schema: 2 },
    { identity: { ...f.release.identity, version: '0.4.2' } },
    { identity: { ...f.release.identity, sourceFingerprint: 'bad' } },
    { identity: { ...f.release.identity, sourceFingerprint: 'sha256:' + '0'.repeat(64) } },
    { artifacts: null },
    { artifacts: [] },
    { artifacts: [...f.release.artifacts, f.release.artifacts[0]] },
    { artifacts: [f.release.artifacts[0], { ...f.release.artifacts[1], sha256: '0'.repeat(64) }] },
    { compatibility: { ...f.compatibility, commandProtocol: 2 } },
  ];
  for (const patch of patches) {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('release.json')
        ? new Response(JSON.stringify({ ...f.release, ...patch }))
        : f.fetchImpl(url);
    await assert.rejects(selectPublishedSnapshot(fetchImpl, '0.4.1'));
  }
  for (const patch of [
    { format_version: 2 },
    { snapshot: { ...f.sidecar.snapshot, source_commit: '0'.repeat(40) } },
    { snapshot: { ...f.sidecar.snapshot, content_version: '0.4.0' } },
    { bytes: f.database.length + 1 },
  ]) {
    const bytes = Buffer.from(JSON.stringify({ ...f.sidecar, ...patch }));
    const release = {
      ...f.release,
      artifacts: [
        f.release.artifacts[0],
        { filename: 'library.sqlite.json', bytes: bytes.length, sha256: digest(bytes) },
      ],
    };
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('/release.json')
        ? new Response(JSON.stringify(release))
        : url.endsWith('/library.sqlite.json')
          ? new Response(bytes)
          : f.fetchImpl(url);
    await assert.rejects(selectPublishedSnapshot(fetchImpl, '0.4.1'));
  }
  const historical: FetchLike = async (url) =>
    url.endsWith('/release.json')
      ? new Response(JSON.stringify({ ...f.release, schema: 2 }))
      : f.fetchImpl(url);
  await assert.rejects(selectPublishedSnapshot(historical), /No supported/u);
  const undeclared: FetchLike = async (url) =>
    url.endsWith('/release.json')
      ? new Response(
          JSON.stringify({
            ...f.release,
            identity: { ...f.release.identity, sourceFingerprint: 'sha256:' + '0'.repeat(64) },
          }),
        )
      : f.fetchImpl(url);
  await assert.rejects(selectPublishedSnapshot(undeclared), /No supported/u);
  assert.equal(fs.existsSync(path.join(f.task, 'pcr-snapshot-lock.json')), false);
});
test('metadata successful canonical redirect and no caller fetch selection', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  let count = 0;
  assert.equal(
    (
      await metadataBytes(
        'https://github.com/tiangong-lca/pcr/releases/download/v0.4.1/release.json',
        async () =>
          count++ === 0
            ? new Response(null, {
                status: 302,
                headers: {
                  location: 'https://release-assets.githubusercontent.com/file?token=redacted',
                },
              })
            : new Response('{}'),
      )
    ).toString(),
    '{}',
  );
  t.mock.method(globalThis, 'fetch', f.fetchImpl);
  await ensurePcrSnapshot({ ...f.options, fetchImpl: undefined });
});
test('tool capabilities are explicit and full bundled dependencies are bound', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const capabilities = {
    schema: 1,
    kind: 'pcr-reader-capabilities',
    libraryFormats: [1],
    projectionContracts: ['1', '2'],
    commandProtocol: 1,
  };
  fs.writeFileSync(path.join(f.tool, 'reader-capabilities.json'), JSON.stringify(capabilities));
  fs.mkdirSync(path.join(f.tool, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(
    path.join(f.tool, 'node_modules', 'dep', 'package.json'),
    JSON.stringify({ name: 'dep', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { dep: '1.0.0' } }),
  );
  fs.writeFileSync(path.join(f.tool, 'node_modules', 'dep', 'index.js'), 'module.exports = {};');
  assert.equal(inspectPcrTool(f.tool).reader.commandProtocol, 1);
  for (const patch of [
    { schema: 2 },
    { libraryFormats: [] },
    { libraryFormats: [0] },
    { libraryFormats: [1, 1] },
    { projectionContracts: [] },
    { projectionContracts: ['x'] },
    { projectionContracts: ['1', '1'] },
    { commandProtocol: 2 },
    { extra: true },
  ]) {
    fs.writeFileSync(
      path.join(f.tool, 'reader-capabilities.json'),
      JSON.stringify({ ...capabilities, ...patch }),
    );
    assert.throws(() => inspectPcrTool(f.tool), /capability/u);
  }
  fs.writeFileSync(path.join(f.tool, 'reader-capabilities.json'), JSON.stringify(capabilities));
  fs.writeFileSync(
    path.join(f.tool, 'node_modules', 'dep', 'package.json'),
    JSON.stringify({ version: '2.0.0' }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /dependency differs/u);
  for (const dependencies of [{ bad: 1 }, { '../bad': '1.0.0' }]) {
    fs.writeFileSync(
      path.join(f.tool, 'package.json'),
      JSON.stringify({ ...f.manifest, dependencies }),
    );
    assert.throws(() => inspectPcrTool(f.tool), /bundled/u);
  }
});
test('tool identity entry and retained selections fail closed', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  for (const patch of [
    { name: 'other' },
    { private: true },
    { type: 'commonjs' },
    { gitHead: 'bad' },
    { bin: { 'tiangong-pcr': 'entry.ts' } },
  ]) {
    fs.writeFileSync(
      path.join(f.tool, 'package.json'),
      JSON.stringify({ ...f.manifest, ...patch }),
    );
    assert.throws(() => inspectPcrTool(f.tool));
  }
  fs.writeFileSync(path.join(f.tool, 'package.json'), JSON.stringify(f.manifest));
  fs.writeFileSync(
    path.join(f.tool, 'product-release.json'),
    JSON.stringify({ ...f.release.identity, sourceFingerprint: 'sha256:' + '0'.repeat(64) }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /audited legacy/u);
  fs.writeFileSync(path.join(f.tool, 'product-release.json'), JSON.stringify(f.release.identity));
  const tool = inspectPcrTool(f.tool);
  assert.equal(selectedPcrTool(f.task), null);
  assert.throws(() => bindPcrTool(f.options, tool), /cannot consume/u);
  await assert.rejects(executePinnedPcr(f.options, ['guidance']), /explicit --tool-root/u);
  await ensurePcrSnapshot(f.options);
  bindPcrTool(f.options, tool);
  assert.throws(() => selectedPcrTool(f.task, f.local), /selection changed/u);
  assert.deepEqual(selectedPcrTool(f.task, f.tool), tool);
  await verifyPinnedPcrIntegrity(f.options, tool);
  fs.writeFileSync(path.join(f.task, 'pcr-tool-lock.json'), '{}');
  assert.throws(() => selectedPcrTool(f.task), /retained/u);
  fs.writeFileSync(path.join(f.task, 'pcr-tool-lock.json'), JSON.stringify(tool));
  await assert.rejects(
    executePinnedPcr(f.options, ['guidance'], process.env, {
      spawnImpl: async () => ({ stdout: '', stderr: '', status: null, signal: 'SIGTERM' }),
    }),
    /complete normally/u,
  );
  fs.writeFileSync(path.join(f.tool, 'entry.js'), 'changed');
  assert.throws(() => bindPcrTool(f.options, tool), /during preparation/u);
});

test('default platform cache resolves within selected platform home', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const original = Object.fromEntries(
    ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME'].map((key) => [key, process.env[key]]),
  );
  for (const key of Object.keys(original)) process.env[key] = f.base;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const ready = await ensurePcrSnapshot({ ...f.localOptions, cacheDir: undefined });
  assert.equal(ready.pin?.version, '0.4.1');
  assert.throws(
    () =>
      inspectPcrSnapshot({
        ...f.localOptions,
        cacheDir: undefined,
        librarySha256: 'sha256:' + '0'.repeat(64),
      }),
    /another PCR checksum/u,
  );
});
test('tool metadata limits missing entry and nested inventory bounds are explicit', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  fs.writeFileSync(path.join(f.tool, 'package.json'), Buffer.alloc(PCR_METADATA_LIMIT + 1));
  assert.throws(() => inspectPcrTool(f.tool), /bounded regular/u);
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, bin: { 'tiangong-pcr': 'missing.js' } }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /entry is missing/u);
  fs.writeFileSync(path.join(f.tool, 'package.json'), JSON.stringify(f.manifest));
  const deep = path.join(f.tool, ...Array(33).fill('d'));
  fs.mkdirSync(deep, { recursive: true });
  assert.throws(() => inspectPcrTool(f.tool), /nesting/u);
  fs.rmSync(path.join(f.tool, 'd'), { recursive: true });
  const stat = fs.lstatSync.bind(fs);
  let count = 0;
  const mocking = t.mock.method(fs, 'lstatSync', (filename: fs.PathLike, ...args: unknown[]) =>
    String(filename) === fs.realpathSync(f.tool) && ++count === 5
      ? { isSymbolicLink: () => false, isDirectory: () => false }
      : Reflect.apply(stat, fs, [filename, ...args]),
  );
  assert.throws(() => inspectPcrTool(f.tool));
  mocking.mock.restore();
});
test('pinned consumption refuses incompatible reader and invalid library verification evidence', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  await ensurePcrSnapshot(f.options);
  const tool = inspectPcrTool(f.tool);
  bindPcrTool(f.options, tool);
  const original = fs.readFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), 'utf8');
  const pin = JSON.parse(original);
  pin.compatibility.commandProtocol = 2;
  const beforeKey = cacheKey(JSON.parse(original)),
    afterKey = cacheKey(pin);
  fs.renameSync(
    path.join(f.cache, 'snapshots', beforeKey),
    path.join(f.cache, 'snapshots', afterKey),
  );
  fs.writeFileSync(path.join(f.cache, 'snapshots', afterKey, 'pin.json'), JSON.stringify(pin));
  fs.writeFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), JSON.stringify(pin));
  await assert.rejects(executePinnedPcr(f.options, ['guidance']), /compatible pinned/u);
  fs.renameSync(
    path.join(f.cache, 'snapshots', afterKey),
    path.join(f.cache, 'snapshots', beforeKey),
  );
  fs.writeFileSync(path.join(f.cache, 'snapshots', beforeKey, 'pin.json'), original);
  fs.writeFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), original);
  assert.equal(pcrIntegrityVerified(f.options, tool), false);
  await verifyPinnedPcrIntegrity(f.options, tool);
  assert.equal(pcrIntegrityVerified(f.options, tool), true);
  fs.writeFileSync(path.join(f.task, 'pcr-library-verification.json'), '{}');
  assert.throws(() => pcrIntegrityVerified(f.options, tool), /receipt differs/u);
  fs.unlinkSync(path.join(f.task, 'pcr-library-verification.json'));
  fs.unlinkSync(path.join(f.task, 'pcr-tool-lock.json'));
  fs.writeFileSync(path.join(f.tool, 'entry.js'), 'process.exitCode=1;');
  const rejecting = inspectPcrTool(f.tool);
  bindPcrTool(f.options, rejecting);
  await assert.rejects(verifyPinnedPcrIntegrity(f.options, rejecting), /rejected snapshot/u);
  fs.unlinkSync(path.join(f.task, 'pcr-tool-lock.json'));
  fs.writeFileSync(
    path.join(f.tool, 'entry.js'),
    'console.log(JSON.stringify({verified:false,snapshot:{}}));',
  );
  const lying = inspectPcrTool(f.tool);
  bindPcrTool(f.options, lying);
  await assert.rejects(verifyPinnedPcrIntegrity(f.options, lying), /did not bind/u);
});
test('command help missing snapshots snapshot-only readiness and idempotent integrity receipt', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  assert.match((await runPcrCommand('snapshot', ['-h'])).stdout, /Usage/u);
  await assert.rejects(runPcrCommand('snapshot', []));
  assert.match(
    (await runPcrCommand('snapshot', ['status', '--task-dir', f.task, '--cache-dir', f.cache]))
      .stdout,
    /not selected/u,
  );
  assert.match(
    (
      await runPcrCommand(
        'snapshot',
        ['ensure', '--task-dir', f.task, '--cache-dir', f.cache],
        f.fetchImpl,
      )
    ).stdout,
    /snapshot-ready/u,
  );
  const args = ['ensure', '--task-dir', f.task, '--cache-dir', f.cache, '--tool-root', f.tool];
  await runPcrCommand('snapshot', args, f.fetchImpl);
  assert.match((await runPcrCommand('snapshot', args, f.fetchImpl)).stdout, /task-ready/u);
});

test('redirect response bodies are cancelled before following immutable metadata URLs', async () => {
  let calls = 0;
  assert.equal(
    (
      await metadataBytes(
        'https://github.com/tiangong-lca/pcr/releases/download/v0.4.1/release.json',
        async () =>
          calls++ === 0
            ? new Response('redirect body', {
                status: 302,
                headers: { location: 'https://release-assets.githubusercontent.com/file' },
              })
            : new Response('{}'),
      )
    ).toString(),
    '{}',
  );
});

test('native CLI routing bypasses project env for PCR task inspection', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const result = await executeCli(
    ['pcr', 'snapshot', 'status', '--task-dir', f.task, '--cache-dir', f.cache, '--json'],
    { env: {}, dotEnvStatus: { loaded: false, path: '', count: 0 }, fetchImpl: f.fetchImpl },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).status, 'missing');
  let stdout = '';
  const write = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  assert.equal(
    await main(
      ['pcr', 'snapshot', 'status', '--task-dir', f.task, '--cache-dir', f.cache, '--json'],
      {},
    ),
    2,
  );
  write.mock.restore();
  assert.equal(JSON.parse(stdout).status, 'missing');
});
test('npm generated dependency bin links are bound narrowly and never selected for dispatch', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const dep = path.join(f.tool, 'node_modules', 'dep'),
    bins = path.join(f.tool, 'node_modules', '.bin');
  fs.mkdirSync(dep, { recursive: true });
  fs.mkdirSync(bins);
  const target = path.join(dep, 'bin.js'),
    link = path.join(bins, 'dep');
  fs.writeFileSync(target, 'declared binary');
  fs.writeFileSync(link, 'synthetic native link placeholder');
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { dep: '1.0.0' } }),
  );
  const stat = fs.lstatSync.bind(fs),
    realpath = fs.realpathSync.bind(fs),
    readlink = fs.readlinkSync.bind(fs);
  const canonicalLink = path.join(fs.realpathSync(bins), 'dep'),
    canonicalTarget = fs.realpathSync(target);
  let destination = canonicalTarget,
    relative = '../dep/bin.js';
  t.mock.method(fs, 'lstatSync', (filename: fs.PathLike, ...args: unknown[]) =>
    String(filename) === canonicalLink
      ? Object.assign(Reflect.apply(stat, fs, [filename, ...args]) as fs.Stats, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
        })
      : Reflect.apply(stat, fs, [filename, ...args]),
  );
  t.mock.method(fs, 'realpathSync', (filename: fs.PathLike, ...args: unknown[]) =>
    String(filename) === canonicalLink
      ? destination
      : Reflect.apply(realpath, fs, [filename, ...args]),
  );
  t.mock.method(fs, 'readlinkSync', (filename: fs.PathLike, ...args: unknown[]) =>
    String(filename) === canonicalLink
      ? relative
      : Reflect.apply(readlink, fs, [filename, ...args]),
  );
  const metadata = (bin: unknown) =>
    fs.writeFileSync(
      path.join(dep, 'package.json'),
      JSON.stringify({ name: 'dep', version: '1.0.0', main: 'bin.js', bin }),
    );
  metadata({ dep: 'bin.js' });
  const capture: ReturnType<typeof import('../src/lib/runtime/files.js').hashRuntimeFile>[] = [];
  const first = inspectPcrTool(f.tool, capture);
  assert.equal(
    capture.some((file) => file.path === 'node_modules/.bin/dep'),
    false,
  );
  metadata('bin.js');
  assert.notEqual(inspectPcrTool(f.tool).content_sha256, first.content_sha256);
  for (const bin of [null, [], {}, 'missing.js']) {
    metadata(bin);
    assert.throws(() => inspectPcrTool(f.tool), /does not match/u);
  }
  metadata({ dep: 'bin.js' });
  destination = path.join(f.base, 'outside');
  assert.throws(() => inspectPcrTool(f.tool), /inside the selected/u);
  destination = canonicalTarget;
  relative = canonicalTarget;
  assert.throws(() => inspectPcrTool(f.tool), /inside the selected/u);
  relative = '../dep/bin.js';
  metadata({ dep: 'bin.js' });
  const observed = inspectPcrTool(f.tool);
  relative = '../dep/./bin.js';
  assert.notEqual(inspectPcrTool(f.tool).content_sha256, observed.content_sha256);
  fs.writeFileSync(path.join(f.tool, 'unknown-link'), 'placeholder');
  const unknown = path.join(fs.realpathSync(f.tool), 'unknown-link');
  const earlier = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (filename: fs.PathLike, ...args: unknown[]) =>
    String(filename) === unknown
      ? Object.assign(Reflect.apply(stat, fs, [filename, ...args]) as fs.Stats, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
        })
      : Reflect.apply(earlier, fs, [filename, ...args]),
  );
  assert.throws(() => inspectPcrTool(f.tool), /Only declared/u);
});
test('dependency modification between closure observation and CommandSpec rehash cannot execute', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  await ensurePcrSnapshot(f.options);
  const tool = inspectPcrTool(f.tool);
  bindPcrTool(f.options, tool);
  await verifyPinnedPcrIntegrity(f.options, tool);
  const root = fs.realpathSync(f.tool),
    entry = path.join(root, 'entry.js');
  const original = fs.readFileSync.bind(fs);
  let reads = 0,
    spawned = false;
  const reading = t.mock.method(
    fs,
    'readFileSync',
    (filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const result = Reflect.apply(original, fs, [filename, ...args]);
      if (String(filename) === path.join(root, 'package.json') && ++reads === 2)
        fs.writeFileSync(entry, 'changed while collecting closure');
      return result;
    },
  );
  await assert.rejects(
    executePinnedPcr(f.options, ['guidance'], process.env, {
      spawnImpl: async () => {
        spawned = true;
        return { stdout: '', stderr: '', status: 0, signal: null };
      },
    }),
    /closure changed/u,
  );
  reading.mock.restore();
  assert.equal(spawned, false);
});

test('unsupported library formats cannot be admitted through newer reader capability claims', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const fetchImpl: FetchLike = async (url) =>
    url.endsWith('/release.json')
      ? new Response(
          JSON.stringify({ ...f.release, compatibility: { ...f.compatibility, libraryFormat: 2 } }),
        )
      : f.fetchImpl(url);
  await assert.rejects(
    selectPublishedSnapshot(fetchImpl, '0.4.1', undefined, {
      ...BASELINE_READER,
      libraryFormats: [1, 2],
    }),
    /incompatible/u,
  );
});
test('interrupted database downloads clean owned staging without publishing a task pin', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const fetchImpl: FetchLike = async (url) =>
    url.endsWith('/library.sqlite')
      ? new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(f.database.subarray(0, 2));
              controller.error(Error('interrupted synthetic stream'));
            },
          }),
        )
      : f.fetchImpl(url);
  await assert.rejects(ensurePcrSnapshot({ ...f.options, fetchImpl }));
  assert.equal(fs.existsSync(path.join(f.task, 'pcr-snapshot-lock.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.cache, 'staging')), []);
  const controller = new AbortController();
  const cancelling: FetchLike = async (url) => {
    if (url.endsWith('/library.sqlite')) controller.abort();
    return f.fetchImpl(url);
  };
  await assert.rejects(
    ensurePcrSnapshot({ ...f.options, fetchImpl: cancelling, signal: controller.signal }),
  );
  assert.equal(fs.existsSync(path.join(f.task, 'pcr-snapshot-lock.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(f.cache, 'staging')), []);
});

test('failed native verification leaves immutable partial state that cannot consume until same-pin ensure recovery', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const marker = path.join(f.base, 'allow-verification'),
    dispatch = path.join(f.base, 'application-dispatched');
  const entry = `import fs from 'node:fs'; const args=process.argv.slice(2); if(args[0]==='library'&&args[1]==='verify'){if(!fs.existsSync(${JSON.stringify(marker)}))process.exitCode=2;else console.log(JSON.stringify({tool_version:'0.4.1',...JSON.parse(fs.readFileSync(args[args.indexOf('--library')+1]+'.json','utf8')),verified:true}));}else{fs.writeFileSync(${JSON.stringify(dispatch)},'dispatched');console.log('{}');}`;
  fs.writeFileSync(path.join(f.tool, 'entry.js'), entry);
  const args = [
    'ensure',
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
    '--tool-root',
    f.tool,
    '--json',
  ];
  await assert.rejects(runPcrCommand('snapshot', args, f.fetchImpl), /rejected snapshot/u);
  const pin = fs.readFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), 'utf8'),
    tool = fs.readFileSync(path.join(f.task, 'pcr-tool-lock.json'), 'utf8');
  const calls = f.calls.length;
  await assert.rejects(
    runPcrCommand('exec', ['--task-dir', f.task, '--cache-dir', f.cache, '--', 'guidance']),
    /before consuming/u,
  );
  await assert.rejects(
    runPcrCommand('exec', [
      '--task-dir',
      f.task,
      '--cache-dir',
      f.cache,
      '--',
      'calculate',
      '--input',
      'input.json',
    ]),
    /before consuming/u,
  );
  assert.equal(fs.existsSync(dispatch), false);
  const status = JSON.parse(
    (
      await runPcrCommand('snapshot', [
        'status',
        '--task-dir',
        f.task,
        '--cache-dir',
        f.cache,
        '--json',
      ])
    ).stdout,
  );
  assert.equal(status.task_usable, false);
  assert.equal(status.status, 'snapshot-ready');
  fs.writeFileSync(marker, 'allowed');
  const recovered = JSON.parse(
    (
      await runPcrCommand('snapshot', args, async () => {
        throw Error('recovery must not discover');
      })
    ).stdout,
  );
  assert.equal(recovered.task_usable, true);
  assert.equal(recovered.network, 'none');
  assert.equal(f.calls.length, calls);
  assert.equal(fs.readFileSync(path.join(f.task, 'pcr-snapshot-lock.json'), 'utf8'), pin);
  assert.equal(fs.readFileSync(path.join(f.task, 'pcr-tool-lock.json'), 'utf8'), tool);
  assert.equal(
    (await runPcrCommand('exec', ['--task-dir', f.task, '--cache-dir', f.cache, '--', 'guidance']))
      .exitCode,
    0,
  );
  assert.equal(fs.existsSync(dispatch), true);
});

test('unsupported compatibility schema skips automatic latest but exact selection fails', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const releases = [
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v0.5.0' },
    { draft: false, prerelease: false, published_at: '2026-10-01', tag_name: 'v0.4.1' },
  ];
  const fetchImpl: FetchLike = async (url) =>
    new URL(url).origin === 'https://api.github.com'
      ? new Response(JSON.stringify(url.includes('/tags/v0.5.0') ? releases[0] : releases))
      : url.includes('v0.5.0/release.json')
        ? new Response(
            JSON.stringify({
              ...f.release,
              identity: { ...f.release.identity, version: '0.5.0', tag: 'v0.5.0' },
              compatibility: { ...f.compatibility, schema: 2 },
            }),
          )
        : f.fetchImpl(url);
  assert.equal((await selectPublishedSnapshot(fetchImpl)).pin.version, '0.4.1');
  await assert.rejects(selectPublishedSnapshot(fetchImpl, '0.5.0'), /compatibility schema/u);
});
test('native PCR help after separator is dispatched through verified task pins', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  await runPcrCommand(
    'snapshot',
    ['ensure', '--task-dir', f.task, '--cache-dir', f.cache, '--tool-root', f.tool, '--json'],
    f.fetchImpl,
  );
  const help = await runPcrCommand('exec', [
    '--task-dir',
    f.task,
    '--cache-dir',
    f.cache,
    '--',
    'guidance',
    '--help',
  ]);
  assert.deepEqual(JSON.parse(help.stdout).slice(0, 2), ['guidance', '--help']);
});
test('declared transitive dependency resolution cannot fall back to parent packages', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const dep = path.join(f.tool, 'node_modules', 'dep'),
    outside = path.join(f.base, 'node_modules', 'unbundled');
  fs.mkdirSync(dep, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    JSON.stringify({
      name: 'dep',
      version: '1.0.0',
      main: 'index.cjs',
      dependencies: { unbundled: '1.0.0' },
    }),
  );
  fs.writeFileSync(path.join(dep, 'index.cjs'), 'module.exports=require("unbundled");');
  fs.writeFileSync(
    path.join(outside, 'package.json'),
    JSON.stringify({ name: 'unbundled', version: '1.0.0', main: 'index.cjs' }),
  );
  fs.writeFileSync(path.join(outside, 'index.cjs'), 'module.exports="A";');
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { dep: '1.0.0' } }),
  );
  const args = ['ensure', '--task-dir', f.task, '--cache-dir', f.cache, '--tool-root', f.tool];
  await assert.rejects(runPcrCommand('snapshot', args, f.fetchImpl), /outside the selected/u);
  fs.writeFileSync(path.join(outside, 'index.cjs'), 'module.exports="B";');
  await assert.rejects(runPcrCommand('snapshot', args, f.fetchImpl), /outside the selected/u);
  assert.equal(fs.existsSync(path.join(f.task, 'pcr-tool-lock.json')), false);
});

test('optional and peer dependency absence is checked again before every use', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const metadata = {
    ...f.manifest,
    peerDependencies: { optionalPeer: '*' },
    peerDependenciesMeta: { optionalPeer: { optional: true } },
  };
  fs.writeFileSync(path.join(f.tool, 'package.json'), JSON.stringify(metadata));
  await runPcrCommand(
    'snapshot',
    ['ensure', '--task-dir', f.task, '--cache-dir', f.cache, '--tool-root', f.tool],
    f.fetchImpl,
  );
  const outside = path.join(f.base, 'node_modules', 'optionalPeer');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, 'package.json'),
    JSON.stringify({ name: 'optionalPeer', version: '1.0.0', main: 'index.cjs' }),
  );
  fs.writeFileSync(path.join(outside, 'index.cjs'), 'module.exports="external";');
  await assert.rejects(executePinnedPcr(f.options, ['guidance']), /outside the selected/u);
});
test('closed transitive graph is independent of changed parent packages', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const dep = path.join(f.tool, 'node_modules', 'dep'),
    inner = path.join(f.tool, 'node_modules', 'inside'),
    outside = path.join(f.base, 'node_modules', 'inside');
  for (const directory of [dep, inner, outside]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { dep: '1.0.0' } }),
  );
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    JSON.stringify({
      name: 'dep',
      version: '1.0.0',
      main: 'index.cjs',
      dependencies: { inside: '*' },
      optionalDependencies: { absent: '*' },
      peerDependencies: { inside: '*', absent: '*' },
    }),
  );
  fs.writeFileSync(path.join(dep, 'index.cjs'), 'module.exports=require("inside");');
  for (const directory of [inner, outside])
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'inside', version: '1.0.0', main: 'index.cjs' }),
    );
  fs.writeFileSync(path.join(inner, 'index.cjs'), 'module.exports="pinned";');
  fs.writeFileSync(path.join(outside, 'index.cjs'), 'module.exports="A";');
  fs.writeFileSync(
    path.join(f.tool, 'entry.js'),
    `import fs from 'node:fs'; import{createRequire}from'node:module';const args=process.argv.slice(2);if(args[0]==='library')console.log(JSON.stringify({tool_version:'0.4.1',...JSON.parse(fs.readFileSync(args[args.indexOf('--library')+1]+'.json','utf8')),verified:true}));else console.log(createRequire(import.meta.url)('dep'));`,
  );
  const args = ['ensure', '--task-dir', f.task, '--cache-dir', f.cache, '--tool-root', f.tool];
  await runPcrCommand('snapshot', args, f.fetchImpl);
  const fingerprint = inspectPcrTool(f.tool).content_sha256;
  assert.equal((await executePinnedPcr(f.options, ['guidance'])).stdout.trim(), 'pinned');
  fs.writeFileSync(path.join(outside, 'index.cjs'), 'module.exports="B";');
  assert.equal(inspectPcrTool(f.tool).content_sha256, fingerprint);
  assert.equal((await executePinnedPcr(f.options, ['guidance'])).stdout.trim(), 'pinned');
});
test('required peers invalid declarations unresolved optional packages and builtins fail closed', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  for (const peerDependencies of [
    { missing: '*' },
    { '../escape': '*' },
    { invalid: 1 },
    { empty: '' },
    { fs: '*' },
  ]) {
    fs.writeFileSync(
      path.join(f.tool, 'package.json'),
      JSON.stringify({ ...f.manifest, peerDependencies }),
    );
    assert.throws(() => inspectPcrTool(f.tool));
  }
  const optional = path.join(f.tool, 'node_modules', 'maybe');
  fs.mkdirSync(optional, { recursive: true });
  fs.writeFileSync(
    path.join(optional, 'package.json'),
    JSON.stringify({ name: 'maybe', version: '1.0.0' }),
  );
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, optionalDependencies: { maybe: '*' } }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /optional PCR package is present/u);
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, peerDependencies: { maybe: '*' } }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /missing or cannot/u);
});
test('declaration-only bundled dependencies are pinned without treating them as executable entries', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const directory = path.join(f.tool, 'node_modules', 'decl');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { decl: '1.0.0' } }),
  );
  const metadata = { name: 'decl', version: '1.0.0', types: 'index.d.ts' };
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, 'index.d.ts'), 'export declare const value: string;');
  const first = inspectPcrTool(f.tool);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'decl', version: '1.0.0', typings: 'index.d.ts' }),
  );
  assert.notEqual(inspectPcrTool(f.tool).content_sha256, first.content_sha256);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ ...metadata, types: '../outside.d.ts' }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /declaration entries/u);
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ ...metadata, types: 'missing.d.ts' }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /missing or cannot/u);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, 'other.js'), 'module.exports={};');
  assert.throws(() => inspectPcrTool(f.tool), /missing or cannot/u);
});
test('declaration metadata from external packages and new unobserved dependency entries are rejected', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const outside = path.join(f.base, 'node_modules', 'externalTypes');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, 'package.json'),
    JSON.stringify({ name: 'externalTypes', version: '1.0.0', types: 'index.d.ts' }),
  );
  fs.writeFileSync(path.join(outside, 'index.d.ts'), 'declare const value:string;');
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, peerDependencies: { externalTypes: '*' } }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /metadata cannot/u);
  const dep = path.join(f.tool, 'node_modules', 'dep');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(
    path.join(dep, 'package.json'),
    JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports={};');
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, dependencies: { dep: '1.0.0' } }),
  );
  const readdir = fs.readdirSync.bind(fs);
  const canonical = fs.realpathSync(dep);
  t.mock.method(fs, 'readdirSync', (directory: fs.PathLike, ...args: unknown[]) => {
    const names = Reflect.apply(readdir, fs, [directory, ...args]) as string[];
    return String(directory) === canonical ? names.filter((name) => name !== 'index.js') : names;
  });
  assert.throws(() => inspectPcrTool(f.tool), /absent from the pinned/u);
});

test('unexpected empty native package lookup paths cannot establish dependency closure', (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({ ...f.manifest, peerDependencies: { missing: '*' } }),
  );
  const create = Module.createRequire.bind(Module);
  const mocked = t.mock.method(Module, 'createRequire', (filename: string | URL) => {
    const resolver = create(filename);
    return Object.assign(resolver, {
      resolve: Object.assign(
        (_name: string) => {
          throw Object.assign(Error('missing native package lookup'), { code: 'MODULE_NOT_FOUND' });
        },
        { paths: () => null },
      ),
    });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => inspectPcrTool(f.tool), /missing or cannot/u);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('present malformed compatibility schemas fail rather than hiding publisher defects', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  for (const compatibility of [
    {},
    { schema: '2' },
    { schema: true },
    { schema: null },
    { schema: 0 },
    { schema: -1 },
    { schema: 1.5 },
    { schema: Infinity },
    { schema: Number.MAX_SAFE_INTEGER + 1 },
    null,
  ]) {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('/release.json')
        ? new Response(JSON.stringify({ ...f.release, compatibility }))
        : f.fetchImpl(url);
    for (const explicit of [undefined, '0.4.1'])
      await assert.rejects(selectPublishedSnapshot(fetchImpl, explicit), (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'PCR_SNAPSHOT_INVALID',
        ),
      );
  }
});
test('audited historical 0.3.1 content retains exact public proofs with current reader requirements', async (t) => {
  const f = snapshotFixture();
  t.after(f.cleanup);
  const release = fs.readFileSync(
      path.join(process.cwd(), 'test/fixtures/pcr-v0.3.1/release.fixture'),
    ),
    sidecar = fs.readFileSync(
      path.join(process.cwd(), 'test/fixtures/pcr-v0.3.1/library.sqlite.fixture'),
    );
  assert.equal(digest(release), AUDITED_HISTORICAL_CONTENT.release_sha256);
  assert.equal(digest(sidecar), AUDITED_HISTORICAL_CONTENT.sidecar.sha256);
  const identity = snapshotIdentity(parseJson(sidecar));
  assert.equal(isAuditedHistoricalContent(identity, AUDITED_HISTORICAL_CONTENT.sidecar), true);
  assert.equal(compatibleReader(HISTORICAL_CONTENT_COMPATIBILITY, BASELINE_READER), true);
  assert.equal(
    compatibleReader(HISTORICAL_CONTENT_COMPATIBILITY, { ...BASELINE_READER, version: '0.3.1' }),
    false,
  );
  for (const patch of [
    { version: '0.3.0' },
    { source_commit: '0'.repeat(40) },
    { source_sha256: 'sha256:' + '0'.repeat(64) },
    { database: { ...AUDITED_HISTORICAL_CONTENT.database, sha256: '0'.repeat(64) } },
  ])
    assert.equal(
      isAuditedHistoricalContent({ ...identity, ...patch }, AUDITED_HISTORICAL_CONTENT.sidecar),
      false,
    );
  assert.equal(
    isAuditedHistoricalContent(identity, {
      ...AUDITED_HISTORICAL_CONTENT.sidecar,
      sha256: '0'.repeat(64),
    }),
    false,
  );
  const status = {
    draft: false,
    prerelease: false,
    published_at: '2026-10-03T07:28:03Z',
    tag_name: 'v0.3.1',
  };
  const fetchImpl: FetchLike = async (url) =>
    new URL(url).origin === 'https://api.github.com'
      ? new Response(JSON.stringify(url.includes('/tags/') ? status : [status]))
      : url.endsWith('/release.json')
        ? new Response(release)
        : new Response(sidecar);
  const selected = await selectPublishedSnapshot(fetchImpl, '0.3.1');
  assert.equal(selected.pin.version, '0.3.1');
  assert.deepEqual(selected.pin.compatibility, HISTORICAL_CONTENT_COMPATIBILITY);
  assert.equal((await selectPublishedSnapshot(fetchImpl)).pin.version, '0.3.1');
  await assert.rejects(
    selectPublishedSnapshot(fetchImpl, '0.3.1', undefined, {
      ...BASELINE_READER,
      version: '0.3.1',
    }),
    /incompatible/u,
  );
  const modified: FetchLike = async (url) =>
    url.endsWith('/release.json')
      ? new Response(Buffer.concat([release, Buffer.from(' ')]))
      : fetchImpl(url);
  await assert.rejects(selectPublishedSnapshot(modified, '0.3.1'), /incompatible/u);
  fs.writeFileSync(path.join(f.local, 'library.sqlite.json'), sidecar);
  await assert.rejects(
    ensurePcrSnapshot({
      ...f.localOptions,
      librarySha256: 'sha256:' + AUDITED_HISTORICAL_CONTENT.database.sha256,
    }),
    /bytes changed/u,
  );
  assert.equal(fs.existsSync(path.join(f.task, 'pcr-snapshot-lock.json')), false);
  fs.writeFileSync(
    path.join(f.tool, 'package.json'),
    JSON.stringify({
      ...f.manifest,
      version: '0.3.1',
      gitHead: AUDITED_HISTORICAL_CONTENT.source_commit,
    }),
  );
  fs.writeFileSync(
    path.join(f.tool, 'product-release.json'),
    JSON.stringify({
      schema: 1,
      version: '0.3.1',
      tag: 'v0.3.1',
      sourceCommit: AUDITED_HISTORICAL_CONTENT.source_commit,
      sourceFingerprint: AUDITED_HISTORICAL_CONTENT.source_fingerprint,
    }),
  );
  assert.throws(() => inspectPcrTool(f.tool), /0.4.1 or newer/u);
});
