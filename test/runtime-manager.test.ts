import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { runtimeComponentFixture, hash } from './helpers/runtime-component.js';
import { trustRuntimeManifest, componentKey } from '../src/lib/runtime/manifest.js';
import {
  ensureRuntimeComponents,
  inspectRuntimeComponents,
  pruneRuntimeComponents,
  verifyRuntimeComponent,
} from '../src/lib/runtime/manager.js';
import { releaseRuntimeLease } from '../src/lib/runtime/leases.js';

test('runtime ensure/status expose pinned installation without auth, followed by verified offline reuse', async () => {
  const f = runtimeComponentFixture();
  let fetches = 0;
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    fetchImpl: async () => {
      fetches++;
      return new Response(f.archive, { status: 200 });
    },
  };
  const common = [
    '--manifest',
    f.manifestPath,
    '--manifest-sha256',
    f.sha256,
    '--cache-dir',
    f.cacheDir,
    '--json',
  ];
  try {
    const absent = await executeCli(['runtime', 'status', ...common], deps);
    assert.equal(absent.exitCode, 69, absent.stderr);
    assert.equal(JSON.parse(absent.stdout).status, 'missing');
    assert.equal(fs.existsSync(f.cacheDir), false);
    const first = await executeCli(
      ['runtime', 'ensure', ...common, '--lease', 'task-one', '--lease-owner', 'urn:test:task-one'],
      deps,
    );
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).status, 'ready');
    assert.equal(fetches, 1);
    const second = await executeCli(['runtime', 'ensure', ...common], {
      ...deps,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(fetches, 1);
  } finally {
    f.close();
  }
});

test('component locks coalesce concurrent downloads; persistent leases fence explicit cache pruning', async () => {
  const f = runtimeComponentFixture();
  let fetches = 0;
  const trusted = trustRuntimeManifest(f.manifestBytes, f.sha256);
  const options = {
    cacheDir: f.cacheDir,
    fetchImpl: async () => {
      fetches++;
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(f.archive);
    },
    lease: { id: 'test-task', owner: 'urn:test:task' },
  };
  try {
    const results = await Promise.all([
      ensureRuntimeComponents(trusted, options),
      ensureRuntimeComponents(trusted, options),
    ]);
    assert.ok(results.every((result) => result.status === 'ready'));
    assert.equal(fetches, 1);
    assert.equal(inspectRuntimeComponents(trusted, options).status, 'ready');
    const key = componentKey(trusted.manifest.components[0]!);
    assert.deepEqual(await pruneRuntimeComponents(trusted, options), {
      removed: [],
      retained: [key],
    });
    await assert.rejects(
      releaseRuntimeLease(f.cacheDir, 'test-task', 'urn:another'),
      /same explicit lease owner/u,
    );
    assert.equal(await releaseRuntimeLease(f.cacheDir, 'test-task', 'urn:test:task'), true);
    assert.deepEqual(await pruneRuntimeComponents(trusted, options), {
      removed: [key],
      retained: [],
    });
    assert.equal(fs.existsSync(f.manifestPath), true);
  } finally {
    f.close();
  }
});

test('corrupt or partial caches never execute or silently overwrite retained state', async () => {
  const f = runtimeComponentFixture(),
    trusted = trustRuntimeManifest(f.manifestBytes, f.sha256);
  const options = { cacheDir: f.cacheDir, fetchImpl: async () => new Response(f.archive) };
  try {
    const installed = await ensureRuntimeComponents(trusted, options);
    const state = installed.components[0]!;
    const file = path.join(state.root, 'bin/tool');
    fs.appendFileSync(file, 'changed');
    const before = hash(fs.readFileSync(file));
    assert.equal(inspectRuntimeComponents(trusted, options).status, 'blocked');
    await assert.rejects(ensureRuntimeComponents(trusted, options), /corrupt/u);
    assert.equal(hash(fs.readFileSync(file)), before);
    await pruneRuntimeComponents(trusted, options);
    fs.mkdirSync(state.root, { recursive: true });
    fs.writeFileSync(path.join(state.root, 'partial'), 'preserve');
    await assert.rejects(ensureRuntimeComponents(trusted, options), /unregistered/u);
    assert.equal(fs.readFileSync(path.join(state.root, 'partial'), 'utf8'), 'preserve');
  } finally {
    f.close();
  }
});

test('bootstrap adoption, verified local seeds and incomplete publication retain exact ownership', async (t) => {
  const f = runtimeComponentFixture(),
    trusted = trustRuntimeManifest(f.manifestBytes, f.sha256),
    key = componentKey(trusted.manifest.components[0]!);
  const seed = path.join(f.dir, 'seed.gz');
  fs.writeFileSync(seed, f.archive);
  const options = {
    cacheDir: f.cacheDir,
    archiveSeeds: { [key]: seed },
    fetchImpl: async () => {
      throw new Error('no network');
    },
  };
  try {
    const installed = await ensureRuntimeComponents(trusted, options);
    const base = path.dirname(installed.components[0]!.root),
      receipt = path.join(base, 'receipt.json');
    const bytes = fs.readFileSync(receipt);
    fs.unlinkSync(receipt);
    assert.equal((await ensureRuntimeComponents(trusted, options)).status, 'ready');
    fs.writeFileSync(receipt, '{}');
    assert.equal(
      inspectRuntimeComponents(trusted, options).components[0]!.reason,
      'RUNTIME_RECEIPT_CHANGED',
    );
    await assert.rejects(pruneRuntimeComponents(trusted, options), /exact ownership receipt/u);
    fs.writeFileSync(receipt, bytes);
    fs.writeFileSync(path.join(base, 'unknown'), 'preserve');
    assert.equal(inspectRuntimeComponents(trusted, options).status, 'blocked');
    await assert.rejects(pruneRuntimeComponents(trusted, options), /Unknown files/u);
    fs.unlinkSync(path.join(base, 'unknown'));
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (file: fs.PathLike) => {
      if (String(file).endsWith(path.sep + 'root')) throw new Error('unclassified failure');
      return readdir(file);
    });
    assert.equal(
      inspectRuntimeComponents(trusted, options).components[0]!.reason,
      'runtime_component_invalid',
    );
    t.mock.restoreAll();
    await pruneRuntimeComponents(trusted, options);
    for (const bytes of [Buffer.from('short'), Buffer.alloc(f.archive.length)]) {
      fs.writeFileSync(seed, bytes);
      await assert.rejects(ensureRuntimeComponents(trusted, options), /archive seed/u);
    }
    fs.writeFileSync(seed, f.archive);
    const mkdir = fs.mkdirSync;
    let injected = false;
    t.mock.method(
      fs,
      'mkdirSync',
      (file: fs.PathLike, options?: Parameters<typeof fs.mkdirSync>[1]) => {
        const result = mkdir(file, options);
        if (!injected && String(file) === path.join(fs.realpathSync(f.cacheDir), 'components')) {
          injected = true;
          mkdir(path.join(f.cacheDir, 'components', key));
        }
        return result;
      },
    );
    await assert.rejects(ensureRuntimeComponents(trusted, options), /appeared outside/u);
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});

test('default cache selection and component structure failures remain conservative', async (t) => {
  const { verifyRuntimeComponent } = await import('../src/lib/runtime/manager.js');
  const { defaultRuntimeCache } = await import('../src/lib/runtime/storage.js');
  const f = runtimeComponentFixture(),
    trusted = trustRuntimeManifest(f.manifestBytes, f.sha256);
  const keys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME'] as const;
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = f.dir;
    assert.equal(inspectRuntimeComponents(trusted).status, 'missing');
    assert.deepEqual(await pruneRuntimeComponents(trusted), { removed: [], retained: [] });
    const result = await ensureRuntimeComponents(trusted, {
      fetchImpl: async () => new Response(f.archive),
    });
    const state = result.components[0]!;
    const file = path.join(state.root, 'bin', 'tool');
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args: unknown[]) => {
      const stat = Reflect.apply(lstat, fs, args) as fs.Stats | fs.BigIntStats;
      if (String(args[0]) === file)
        Reflect.set(
          stat,
          'mode',
          typeof stat.mode === 'bigint'
            ? (stat.mode & ~BigInt(0o777)) | BigInt(0o644)
            : (stat.mode & ~0o777) | 0o644,
        );
      return stat;
    });
    assert.throws(
      () => verifyRuntimeComponent(state.root, trusted.manifest.components[0]!, 'linux-x64'),
      /executable mode changed/u,
    );
    assert.doesNotThrow(() =>
      verifyRuntimeComponent(state.root, trusted.manifest.components[0]!, 'win32-x64'),
    );
    t.mock.restoreAll();
    fs.unlinkSync(file);
    assert.throws(
      () => verifyRuntimeComponent(state.root, trusted.manifest.components[0]!, result.platform),
      /inventory is incomplete/u,
    );
    const directory = path.join(f.dir, 'bad-directory');
    fs.writeFileSync(directory, 'file');
    assert.throws(
      () => verifyRuntimeComponent(directory, trusted.manifest.components[0]!, result.platform),
      /directories cannot/u,
    );
    const link = path.join(f.dir, 'linked-root');
    fs.symlinkSync(state.root, link, 'junction');
    assert.throws(
      () => verifyRuntimeComponent(link, trusted.manifest.components[0]!, result.platform),
      /directories cannot/u,
    );
    await pruneRuntimeComponents(trusted);
    assert.deepEqual(await pruneRuntimeComponents(trusted), { removed: [], retained: [] });
    assert.ok(fs.existsSync(defaultRuntimeCache()));
  } finally {
    t.mock.restoreAll();
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    f.close();
  }
});

test('component verification reuses private storage and rereads changed files on each walk', (t) => {
  const f = runtimeComponentFixture();
  const root = path.join(f.dir, 'component');
  const chunkBytes = 1024 * 1024;
  const sizes = [chunkBytes + 17, 31, 0, chunkBytes, chunkBytes - 1];
  const component = {
    ...f.manifest.components[0]!,
    files: f.files.map((file, index) => {
      const bytes = Buffer.alloc(sizes[index]!, index + 1);
      const target = path.join(root, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode: file.mode });
      fs.chmodSync(target, file.mode);
      return { ...file, bytes: bytes.length, sha256: hash(bytes) };
    }),
  };
  const read = fs.readSync;
  let buffers: Buffer[] = [],
    counts: number[] = [];
  t.mock.method(fs, 'readSync', (...args: unknown[]) => {
    assert.ok(Buffer.isBuffer(args[1]));
    buffers.push(args[1]);
    const count = Reflect.apply(read, fs, args) as number;
    counts.push(count);
    return count;
  });
  const verifyWalk = () => {
    buffers = [];
    counts = [];
    verifyRuntimeComponent(root, component, component.platform);
    assert.equal(new Set(buffers).size, 1);
    assert.equal(buffers[0]!.length, chunkBytes);
    assert.equal(counts.filter((count) => count === 0).length, component.files.length);
    assert.equal(
      counts.reduce((total, count) => total + count, 0),
      sizes.reduce((total, size) => total + size, 0),
    );
    return buffers[0]!;
  };
  try {
    const first = verifyWalk();
    assert.notEqual(verifyWalk(), first);
    const changed = component.files.find((file) => file.path === 'metadata/license.txt')!;
    const replacement = Buffer.alloc(changed.bytes, 99);
    fs.writeFileSync(path.join(root, changed.path), replacement);
    assert.throws(
      () => verifyRuntimeComponent(root, component, component.platform),
      /file bytes, digest/u,
    );
    changed.sha256 = hash(replacement);
    assert.notEqual(verifyWalk(), first);
  } finally {
    t.mock.restoreAll();
    f.close();
  }
});
