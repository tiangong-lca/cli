import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runtimeComponentFixture, hash } from './helpers/runtime-component.js';
import { trustRuntimeManifest } from '../src/lib/runtime/manifest.js';
import { executeRuntimeLaunch, runtimeChildEnvironment } from '../src/lib/runtime/execute.js';
import { leasedRuntimeKeys, runtimeLeaseKey } from '../src/lib/runtime/leases.js';
import { spawnRuntimeProcess } from '../src/lib/runtime/process.js';
import { executeCli } from '../src/cli.js';
import { inspectRuntimeHost } from '../src/lib/runtime/host.js';

test('managed launch snapshots caller host and application arguments before asynchronous installation', async () => {
  const f = runtimeComponentFixture();
  const bytes = Buffer.from(
    JSON.stringify({
      ...f.manifest,
      launches: [{ ...f.manifest.launches[0], context_protocol: 'tiangong-lca.runtime-host.v1' }],
    }),
  );
  const trusted = trustRuntimeManifest(bytes, hash(bytes));
  const originalHost = inspectRuntimeHost();
  const host = { ...originalHost, secret: 'not-context' };
  const argv = ['--json'];
  try {
    await assert.rejects(
      executeRuntimeLaunch(trusted, {
        cacheDir: f.cacheDir,
        cwd: f.dir,
        entry: 'tool',
        argv: Array<string>(513).fill('x'),
      }),
      /bounded/u,
    );
    assert.equal(fs.existsSync(f.cacheDir), false);
    await executeRuntimeLaunch(
      trusted,
      {
        cacheDir: f.cacheDir,
        cwd: f.dir,
        entry: 'tool',
        argv,
        host,
        fetchImpl: async () => {
          host.platform = host.platform === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';
          argv[0] = '--password=late-input';
          return new Response(f.archive);
        },
      },
      async (_executable, actualArgv, _options, context) => {
        assert.deepEqual(actualArgv, ['--json']);
        assert.deepEqual(context?.host, originalHost);
        assert.ok(Object.isFrozen(context?.host));
        assert.equal(context?.manifest, trusted);
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    );
  } finally {
    f.close();
  }
});

test('runtime launch binds argv and keeps leases until aborted in-flight work drains', async () => {
  const f = runtimeComponentFixture();
  const manifest = JSON.parse(f.manifestBytes.toString());
  manifest.launches[0].argv = [
    { literal: '--fixed' },
    { component: 'base', path: 'metadata/license.txt' },
  ];
  manifest.launches[0].environment = 'cli-auth';
  const bytes = Buffer.from(JSON.stringify(manifest)),
    trusted = trustRuntimeManifest(bytes, hash(bytes));
  const options = {
    cacheDir: f.cacheDir,
    cwd: f.dir,
    entry: 'tool',
    argv: ['--json'],
    fetchImpl: async () => new Response(f.archive),
    env: {
      HOME: f.dir,
      TIANGONG_LCA_SESSION_FILE: 'private-session-reference',
      TIANGONG_LCA_PASSWORD: 'must-not-forward',
      NODE_OPTIONS: 'must-not-forward',
    },
  };
  try {
    const result = await executeRuntimeLaunch(
      trusted,
      {
        ...options,
        lease: { id: 'task', owner: 'urn:test' },
      },
      async (...received) => {
        assert.equal(received.length, 3);
        const [executable, argv, child] = received;
        assert.ok(executable.startsWith(fs.realpathSync(f.cacheDir)));
        assert.equal(argv[0], '--fixed');
        assert.ok(argv[1]?.split(path.sep).join('/').endsWith('metadata/license.txt'));
        assert.equal(argv[2], '--json');
        assert.equal(child.shell, false);
        assert.equal(child.env?.TIANGONG_LCA_PASSWORD, undefined);
        assert.equal(child.env?.NODE_OPTIONS, undefined);
        assert.equal(child.env?.TIANGONG_LCA_SESSION_FILE, 'private-session-reference');
        assert.ok(leasedRuntimeKeys(f.cacheDir).size > 0);
        return { status: 0, signal: null, stdout: 'ok', stderr: '' };
      },
    );
    assert.equal(result.stdout, 'ok');
    for (const entry of ['unknown'])
      await assert.rejects(executeRuntimeLaunch(trusted, { ...options, entry }), /not declared/u);
    await assert.rejects(
      executeRuntimeLaunch(trusted, { ...options, argv: ['--password=bad'] }),
      /credential/u,
    );
    await assert.rejects(
      executeRuntimeLaunch(trusted, { ...options, cwd: '.' }),
      /explicit existing/u,
    );
    await assert.rejects(
      executeRuntimeLaunch(trusted, { ...options, cwd: f.cacheDir }),
      /cache or installed skill/u,
    );
    const stop = new AbortController();
    let finish: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = executeRuntimeLaunch(
      trusted,
      {
        ...options,
        signal: stop.signal,
      },
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      },
    );
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await started;
    stop.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(leasedRuntimeKeys(f.cacheDir).size > 0);
    assert.equal(settled, false);
    assert.ok(fs.readdirSync(path.join(f.cacheDir, 'leases')).length >= 2);
    finish();
    await assert.rejects(pending);
    assert.deepEqual(
      runtimeChildEnvironment(
        { HOME: 'home', TIANGONG_LCA_ACCESS_TOKEN: 'token', PASSWORD: 'drop' },
        'isolated',
      ),
      { HOME: 'home' },
    );
  } finally {
    f.close();
  }
});

test('runtime child processes report output, failures and force-stop cancellation without shell execution', async (t) => {
  const options = {
    encoding: 'utf8' as const,
    shell: false as const,
    windowsHide: true as const,
    signal: new AbortController().signal,
    maxBuffer: 1024,
  };
  const result = await spawnRuntimeProcess(
    process.execPath,
    ['-e', 'process.stdout.write("out");process.stderr.write("err")'],
    options,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  const missing = await spawnRuntimeProcess(
    path.join(process.cwd(), 'missing-executable'),
    [],
    options,
  );
  assert.ok(missing.error);
  const overflow = await spawnRuntimeProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(4096))'],
    { ...options, maxBuffer: 8 },
  );
  assert.ok(overflow.error);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const stop = new AbortController();
    const pending = spawnRuntimeProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...options,
      signal: stop.signal,
    });
    stop.abort();
    t.mock.timers.tick(3000);
    const result = await pending;
    assert.ok(result.error);
  } finally {
    t.mock.timers.reset();
  }
});

test('runtime command management validates intent and never creates a cache for status or absent release', async () => {
  const f = runtimeComponentFixture(),
    deps = {
      env: {},
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
      fetchImpl: async () => new Response(f.archive),
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
    for (const args of [
      ['exec', '--help'],
      ['ensure', '--help'],
      ['prune', '--help'],
    ])
      assert.equal((await executeCli(['runtime', ...args], deps)).exitCode, 0);
    for (const args of [
      ['exec'],
      ['exec', '--bad'],
      ['ensure'],
      ['ensure', '--bad'],
      ['prune', ...common],
      ['status', ...common, '--lease', 'x'],
      ['ensure', ...common, '--apply'],
      ['lease-release'],
      ['lease-release', ...common, '--lease', 'x', '--lease-owner', 'owner'],
    ])
      assert.equal((await executeCli(['runtime', ...args], deps)).exitCode, 2, args.join(' '));
    const released = await executeCli(
      [
        'runtime',
        'lease-release',
        '--cache-dir',
        f.cacheDir,
        '--lease',
        'missing',
        '--lease-owner',
        'owner',
      ],
      deps,
    );
    assert.equal(released.exitCode, 0);
    assert.equal(JSON.parse(released.stdout).released, false);
    assert.equal(fs.existsSync(f.cacheDir), false);
    const ready = await executeCli(['runtime', 'ensure', ...common], deps);
    assert.equal(ready.exitCode, 0, ready.stderr);
    assert.equal(
      (
        await executeCli(
          ['runtime', 'status', ...common.filter((value) => value !== '--json')],
          deps,
        )
      ).exitCode,
      0,
    );
    await executeCli(
      ['runtime', 'ensure', ...common, '--lease', 'explicit', '--lease-owner', 'owner'],
      deps,
    );
    const releaseExisting = await executeCli(
      [
        'runtime',
        'lease-release',
        '--cache-dir',
        f.cacheDir,
        '--lease',
        'explicit',
        '--lease-owner',
        'owner',
      ],
      deps,
    );
    assert.equal(JSON.parse(releaseExisting.stdout).released, true);
    const pruned = await executeCli(['runtime', 'prune', ...common, '--apply'], deps);
    assert.equal(pruned.exitCode, 0, pruned.stderr);
    assert.equal(JSON.parse(pruned.stdout).removed.length, 1);
  } finally {
    f.close();
  }
});

test('exec command forwards exact context, reports failures and preserves interrupted exit semantics', async () => {
  const { runRuntimeExecCommand } = await import('../src/commands/runtime/exec-command.js');
  const f = runtimeComponentFixture();
  const common = [
    '--manifest',
    f.manifestPath,
    '--manifest-sha256',
    f.sha256,
    '--entry',
    'tool',
    '--cwd',
    f.dir,
    '--cache-dir',
    f.cacheDir,
  ];
  try {
    for (const args of [
      ['--manifest', f.manifestPath],
      ['--manifest', f.manifestPath, '--manifest-sha256', f.sha256],
      [...common.filter((_, i) => ![6, 7].includes(i))],
      [...common, '--lease', 'only'],
    ])
      await assert.rejects(runRuntimeExecCommand(args), /requires/u);
    const success = await runRuntimeExecCommand(
      [...common, '--lease', 'task', '--lease-owner', 'owner', '--', '--json'],
      undefined,
      {},
      async (_manifest, options) => {
        assert.deepEqual(options.argv, ['--json']);
        assert.deepEqual(options.lease, { id: 'task', owner: 'owner' });
        return { status: 7, signal: null, stdout: 'app', stderr: 'detail' };
      },
    );
    assert.equal(success.exitCode, 7);
    assert.equal(success.stdout, 'app');
    for (const result of [
      { status: 0, signal: null, stdout: '', stderr: '', error: new Error('output limit') },
      { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
      { status: null, signal: null, stdout: '', stderr: '' },
    ])
      assert.ok(
        (await runRuntimeExecCommand(common, undefined, {}, async () => result)).exitCode !== 0,
      );
    assert.equal(
      (
        await runRuntimeExecCommand(common, undefined, {}, async () => {
          process.emit('SIGINT');
          return { status: 0, signal: null, stdout: 'partial', stderr: '' };
        })
      ).exitCode,
      130,
    );
    assert.equal(
      (
        await runRuntimeExecCommand(common, undefined, {}, async () => {
          process.emit('SIGTERM');
          throw new Error('aborted');
        })
      ).exitCode,
      130,
    );
    await assert.rejects(
      runRuntimeExecCommand(common, undefined, {}, async () => {
        throw new Error('ordinary failure');
      }),
      /ordinary failure/u,
    );
  } finally {
    f.close();
  }
});

test('launch defaults remain isolated and post-install drift is rejected before spawn', async (t) => {
  const f = runtimeComponentFixture(),
    trusted = trustRuntimeManifest(f.manifestBytes, f.sha256);
  const { defaultRuntimeCache } = await import('../src/lib/runtime/storage.js');
  const keys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME'] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = f.dir;
    const result = await executeRuntimeLaunch(trusted, {
      entry: 'tool',
      cwd: f.dir,
      argv: [],
      fetchImpl: async () => new Response(f.archive),
    }).catch((error) => ({ error }));
    assert.ok('error' in result ? result.error : result.status !== 0);
    const cache = defaultRuntimeCache();
    fs.mkdirSync(path.join(cache, 'work'), { recursive: true });
    await assert.rejects(
      executeRuntimeLaunch(trusted, { entry: 'tool', cwd: path.join(cache, 'work'), argv: [] }),
      /cache or installed/u,
    );
    const skill = path.join(f.dir, '.agents', 'skills', 'test');
    fs.mkdirSync(skill, { recursive: true });
    await assert.rejects(
      executeRuntimeLaunch(trusted, { entry: 'tool', cwd: skill, argv: [] }),
      /cache or installed/u,
    );
    const file = path.join(f.dir, 'not-dir');
    fs.writeFileSync(file, 'x');
    await assert.rejects(
      executeRuntimeLaunch(trusted, { entry: 'tool', cwd: file, argv: [] }),
      /work directory/u,
    );
    const link = fs.linkSync;
    t.mock.method(fs, 'linkSync', (source: fs.PathLike, target: fs.PathLike) => {
      link(source, target);
      if (String(target).endsWith(runtimeLeaseKey('drift-pin') + '.json')) {
        const components = fs.readdirSync(path.join(cache, 'components'));
        fs.appendFileSync(
          path.join(cache, 'components', components[0]!, 'root', 'bin', 'tool'),
          'drift',
        );
      }
    });
    await assert.rejects(
      executeRuntimeLaunch(trusted, {
        entry: 'tool',
        cwd: f.dir,
        argv: [],
        cacheDir: cache,
        lease: { id: 'drift-pin', owner: 'owner' },
        fetchImpl: async () => new Response(f.archive),
      }),
      /corrupt|changed/u,
    );
  } finally {
    t.mock.restoreAll();
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    f.close();
  }
});

test('native runner accepts pre-cancelled intent and default output bounds', async () => {
  const stop = new AbortController();
  stop.abort();
  const base = { encoding: 'utf8' as const, shell: false as const, windowsHide: true as const };
  const cancelled = await spawnRuntimeProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { ...base, signal: stop.signal },
  );
  assert.ok(cancelled.error);
  const result = await spawnRuntimeProcess(
    process.execPath,
    ['-e', 'process.stdout.write("default")'],
    { ...base, signal: new AbortController().signal },
  );
  assert.equal(result.stdout, 'default');
});
