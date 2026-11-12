import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installModelRuntime, setupLocalModel } from '../src/adapters/model-install.js';
import { writeRuntimeComponentArchive } from '../src/lib/runtime/archive-writer.js';
import { hashRuntimeFile } from '../src/lib/runtime/files.js';
import { modelRuntimeFile } from '../src/adapters/model-runtime.js';
import { runSetupCommand } from '../src/commands/setup.js';

async function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = path.join(dir, 'payload');
  const files = [];
  for (const name of [
    'bin/model_calculate',
    'cache/lciamethods/cache_manifest.json',
    'cache/lciamethods/flow_factors.json.gz',
    'cache/lciamethods/list.json',
  ]) {
    const file = path.join(payload, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name);
    const fact = hashRuntimeFile(file, name);
    files.push({
      path: name,
      bytes: fact.bytes,
      sha256: fact.sha256,
      mode: (name.startsWith('bin/') ? 493 : 420) as 493 | 420,
    });
  }
  const archive = await writeRuntimeComponentArchive(
    payload,
    files,
    path.join(dir, 'runtime.tar.gz'),
  );
  const manifest = {
    schema: 'lca.model-runtime-package.v1',
    platform: 'darwin-arm64',
    files,
    archive,
  };
  const save = (value: unknown = manifest) =>
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
  save();
  const env = { XDG_STATE_HOME: path.join(dir, 'state') };
  return { dir, env, manifest, save };
}

test('installs a relocated verified package and cleans failed owned installations without touching old config', async (t) => {
  const f = await fixture(t);
  const calls: unknown[] = [];
  const result = await installModelRuntime(
    f.dir,
    f.env,
    (request) => {
      calls.push(request);
      assert.equal(fs.readFileSync(String(request.engine), 'utf8'), 'bin/model_calculate');
      assert.equal(
        fs.readFileSync(path.join(String(request.staticCache), 'lciamethods/list.json'), 'utf8'),
        'cache/lciamethods/list.json',
      );
      return { configured: true };
    },
    'darwin-arm64',
  );
  assert.equal(result.installed, true);
  assert.equal(calls.length, 1);
  const parent = path.dirname(String(result.installationDirectory));
  assert.deepEqual(fs.readdirSync(parent), ['runtime']);
  fs.writeFileSync(modelRuntimeFile(f.env), 'old config');
  await assert.rejects(
    installModelRuntime(
      f.dir,
      f.env,
      () => {
        throw new Error('bad engine');
      },
      'darwin-arm64',
    ),
    /bad engine/u,
  );
  assert.equal(fs.readFileSync(modelRuntimeFile(f.env), 'utf8'), 'old config');
  assert.equal(fs.readdirSync(path.dirname(parent)).length, 1);
  await assert.rejects(
    installModelRuntime(f.dir, f.env, undefined, 'darwin-arm64'),
    /check failed/u,
  );
  assert.equal(fs.readdirSync(path.dirname(parent)).length, 1);
});

test('rejects incompatible, unsafe, oversized and corrupted packages before execution', async (t) => {
  const f = await fixture(t);
  const never = () => {
    throw new Error('must not execute');
  };
  for (const host of ['darwin-x64', 'linux-x64', 'win32-x64'])
    await assert.rejects(installModelRuntime(f.dir, f.env, never, host), /requires macOS/u);
  const original = structuredClone(f.manifest);
  const mutations: ((v: typeof original) => void)[] = [
    (v) => {
      v.schema = 'bad';
    },
    (v) => {
      v.platform = 'linux-x64';
    },
    (v) => {
      v.files[0]!.mode = 0 as 493;
    },
    (v) => {
      v.files[0]!.path = '../escape';
    },
    (v) => {
      v.files[1]!.path = v.files[0]!.path;
    },
    (v) => {
      v.files[0]!.path = 'bin/missing';
    },
    (v) => {
      v.files[0]!.mode = 420;
    },
    (v) => {
      v.files = Array.from({ length: 5 }, (_, i) => ({
        ...v.files[0]!,
        path: `big-${i}`,
        bytes: 512 * 1024 * 1024,
      }));
    },
    (v) => {
      v.archive.sha256 = '0'.repeat(64);
    },
    (v) => {
      v.archive.bytes++;
    },
    (v) => {
      v.archive.bytes = 512 * 1024 * 1024 + 1;
    },
    (v) => {
      v.files[1]!.path = 'cache/lciamethods/missing.json';
    },
    (v) => {
      v.files[0]!.sha256 = '0'.repeat(64);
    },
  ];
  for (const change of mutations) {
    const value = structuredClone(original);
    change(value);
    f.save(value);
    await assert.rejects(
      installModelRuntime(f.dir, f.env, never, 'darwin-arm64'),
      (error) => !String(error).includes('must not execute'),
    );
  }
  const manifestPath = path.join(f.dir, 'manifest.json');
  fs.truncateSync(manifestPath, 1024 * 1024 + 1);
  await assert.rejects(installModelRuntime(f.dir, f.env, never, 'darwin-arm64'), /1 MiB/u);
  fs.rmSync(manifestPath);
  fs.mkdirSync(manifestPath);
  await assert.rejects(installModelRuntime(f.dir, f.env, never, 'darwin-arm64'), /regular/u);
});

test('snapshot races fail and never change saved configuration', async (t) => {
  const f = await fixture(t);
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike, flags?: number) => {
    copy(source, target, flags);
    fs.appendFileSync(target, 'changed');
  });
  await assert.rejects(
    installModelRuntime(f.dir, f.env, undefined, 'darwin-arm64'),
    /changed while installing/u,
  );
  assert.equal(fs.existsSync(modelRuntimeFile(f.env)), false);
  assert.deepEqual(
    fs.readdirSync(path.join(f.env.XDG_STATE_HOME, 'tiangong-lca-cli/model-runtimes')),
    [],
  );
});

test('setup rejects conflicting installation options and routes missing runtime checks', async (t) => {
  const f = await fixture(t);
  for (const option of [{ check: true }, { engine: 'engine' }, { staticCache: 'cache' }])
    await assert.rejects(
      setupLocalModel({ install: f.dir, ...option }, f.env),
      /cannot be combined/u,
    );
  await assert.rejects(setupLocalModel({ check: true }, f.env), /Run setup/u);
  await assert.rejects(setupLocalModel({ install: f.dir }, f.env));
});

test('local installation failures give local recovery guidance, never service/authentication errors', async (t) => {
  const f = await fixture(t);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.defineProperty(process, 'arch', { value: 'arm64' });
  t.after(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'arch', originalArch);
  });
  const invoke = (bundle: string) =>
    runSetupCommand(['model-calculation', '--install', bundle, '--json'], (r) =>
      setupLocalModel(r, f.env),
    );
  for (const empty of ['', '   ']) {
    const reply = await invoke(empty);
    assert.equal(reply.exitCode, 2);
    assert.equal(JSON.parse(reply.stdout).error.code, 'VALUE_REQUIRED');
  }
  for (const invalid of [null, 123, {}])
    await assert.rejects(setupLocalModel({ install: invalid }, f.env), /non-empty string/u);
  const missing = await invoke(path.join(f.dir, 'missing'));
  assert.equal(missing.exitCode, 1);
  assert.equal(JSON.parse(missing.stdout).error.category, 'environment');
  assert.equal(JSON.parse(missing.stdout).error.code, 'MODEL_INSTALL_UNAVAILABLE');
  fs.writeFileSync(path.join(f.dir, 'manifest.json'), 'not json');
  assert.equal(JSON.parse((await invoke(f.dir)).stdout).error.code, 'MODEL_INSTALL_UNAVAILABLE');
  f.manifest.files[0]!.path = '../escape';
  f.save();
  const unsafe = JSON.parse((await invoke(f.dir)).stdout);
  assert.equal(unsafe.error.code, 'MODEL_INSTALL_INVALID');
  assert.equal(unsafe.error.category, 'environment');
  assert.match(unsafe.summary, /portable file path/u);
  assert.equal(fs.existsSync(modelRuntimeFile(f.env)), false);
});
