import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ResponseLike } from '../src/lib/transport/http.js';
import { loadDistModule } from './helpers/load-dist-module.js';
import { __testInternals } from '../src/lib/auth/supabase-session.js';
import type { SupabaseRestRuntime } from '../src/lib/transport/supabase-client.js';
import { fingerprintSecret } from '../src/lib/auth/credential-safety.js';

const require = createRequire(import.meta.url);
const mutableFs = require('node:fs') as typeof import('node:fs');
const mutableOs = require('node:os') as typeof import('node:os');

function clearSessionState(): void {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  __testInternals.SESSION_OPERATION_CHAINS.clear();
}

function makeRuntime(overrides: Partial<SupabaseRestRuntime> = {}): SupabaseRestRuntime {
  const runtime: SupabaseRestRuntime = {
    apiBaseUrl: 'https://example.supabase.co/functions/v1',
    authMode: 'oauth',
    oauthClientId: '123e4567-e89b-42d3-a456-426614174000',
    oauthRedirectUri: 'http://127.0.0.1:49191/oauth/callback',
    accessToken: null,
    publishableKey: 'sb-publishable-key',
    sessionFile: null,
    disableSessionCache: false,
    forceReauth: false,
  };
  return { ...runtime, ...overrides } as SupabaseRestRuntime;
}

function makeJsonResponse(
  body: unknown,
  options: {
    ok?: boolean;
    status?: number;
  } = {},
): ResponseLike {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function makeSession(
  overrides: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    expiresAt?: number;
    userId?: string;
    email?: string;
  } = {},
): Record<string, unknown> {
  return {
    access_token: overrides.accessToken ?? 'access-token',
    refresh_token: overrides.refreshToken ?? 'refresh-token',
    token_type: 'bearer',
    expires_in: overrides.expiresIn ?? 3_600,
    expires_at: overrides.expiresAt ?? 4_102_444_800,
    user: {
      id: overrides.userId ?? 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: overrides.email ?? 'user@example.com',
    },
  };
}

test('path resolution helpers cover xdg, home, platform fallbacks, and explicit overrides', () => {
  clearSessionState();

  assert.equal(
    __testInternals.resolveDefaultSessionFilePath({
      platform: 'linux',
      homeDir: '/Users/demo',
      xdgStateHome: '/tmp/xdg',
      localAppData: null,
    }),
    path.join('/tmp/xdg', 'tiangong-lca-cli', 'session.json'),
  );
  assert.equal(
    __testInternals.resolveDefaultSessionFilePath({
      platform: 'linux',
      homeDir: '/Users/demo',
      xdgStateHome: null,
      localAppData: null,
    }),
    path.join('/Users/demo', '.local', 'state', 'tiangong-lca-cli', 'session.json'),
  );
  assert.equal(
    __testInternals.resolveDefaultSessionFilePath({
      platform: 'darwin',
      homeDir: '',
      xdgStateHome: null,
      localAppData: null,
    }),
    path.join(os.homedir(), 'Library', 'Application Support', 'tiangong-lca-cli', 'session.json'),
  );
  assert.equal(
    __testInternals.resolveDefaultSessionFilePath({
      platform: 'win32',
      homeDir: '',
      xdgStateHome: null,
      localAppData: 'C:\\Users\\demo\\AppData\\Local',
    }),
    path.join('C:\\Users\\demo\\AppData\\Local', 'tiangong-lca-cli', 'session.json'),
  );
  assert.equal(
    __testInternals.resolveDefaultSessionFilePath({
      platform: 'linux',
      homeDir: '',
      xdgStateHome: null,
      localAppData: null,
    }),
    path.resolve('.tiangong-lca-session.json'),
  );

  const runtimeWithOverride = makeRuntime({
    sessionFile: './tmp/custom-session.json',
  });
  assert.equal(
    __testInternals.resolveSessionFilePath(runtimeWithOverride),
    path.resolve('./tmp/custom-session.json'),
  );
  assert.equal(
    __testInternals.resolveSessionFilePath(
      makeRuntime({
        disableSessionCache: true,
      }),
    ),
    null,
  );
  assert.equal(typeof __testInternals.resolveSessionFilePath(makeRuntime()), 'string');
});

test('resolveSessionFilePath falls back to cwd session file on Windows when env paths are unavailable', () => {
  clearSessionState();

  if (process.platform !== 'win32') {
    return;
  }

  const originalHomedir = mutableOs.homedir;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalXdgStateHome = process.env.XDG_STATE_HOME;

  try {
    mutableOs.homedir = (() => '') as typeof mutableOs.homedir;
    syncBuiltinESMExports();
    delete process.env.LOCALAPPDATA;
    delete process.env.XDG_STATE_HOME;

    assert.equal(
      __testInternals.resolveSessionFilePath(makeRuntime()),
      path.resolve('.tiangong-lca-session.json'),
    );
  } finally {
    mutableOs.homedir = originalHomedir;
    syncBuiltinESMExports();

    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }

    if (originalXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    }
  }
});

test('session record helpers parse, persist, fingerprint, and clean up memoized state', async () => {
  clearSessionState();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-session-record-'));
  const sessionFile = path.join(dir, 'session.json');
  const runtime = makeRuntime({
    sessionFile,
  });
  const identity = __testInternals.buildRuntimeIdentity(runtime);
  const now = new Date('2026-04-06T00:00:00.000Z');
  const session = makeSession({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 4_102_444_800,
  }) as never;

  try {
    assert.equal(
      __testInternals.computeExpiresAt(
        {
          access_token: 'token',
          refresh_token: 'refresh',
          expires_at: 1_700_000_000,
          expires_in: 600,
          token_type: 'bearer',
          user: { id: 'user-1', aud: 'authenticated' },
        } as never,
        now,
      ),
      1_700_000_000,
    );
    assert.equal(
      __testInternals.computeExpiresAt(
        {
          access_token: 'token',
          refresh_token: 'refresh',
          expires_in: 600,
          token_type: 'bearer',
          user: { id: 'user-1', aud: 'authenticated' },
        } as never,
        now,
      ),
      1_775_434_200,
    );
    assert.equal(
      __testInternals.computeExpiresAt(
        {
          access_token: 'token',
          refresh_token: 'refresh',
          token_type: 'bearer',
          user: { id: 'user-1', aud: 'authenticated' },
        } as never,
        now,
      ),
      null,
    );
    assert.equal(typeof __testInternals.resolveSessionFilePath(makeRuntime()), 'string');

    const record = __testInternals.buildCachedSessionRecord({
      runtime: identity,
      session,
      userEmail: 'user@example.com',
      now,
    });
    assert.equal(record.supabase_url, 'https://example.supabase.co');
    assert.equal(record.publishable_key_fingerprint, fingerprintSecret(runtime.publishableKey));
    assert.equal(
      record.auth_binding_fingerprint,
      fingerprintSecret(`oauth-client:${runtime.oauthClientId as string}`),
    );
    assert.equal(__testInternals.isSessionFresh(record, now), true);
    assert.equal(
      __testInternals.isSessionFresh(
        {
          ...record,
          expires_at: 1_775_433_700,
        },
        now,
      ),
      false,
    );
    assert.equal(__testInternals.recordMatchesRuntime(record, identity), true);
    assert.equal(
      __testInternals.recordMatchesRuntime(
        {
          ...record,
          auth_binding_fingerprint: 'sha256:other',
        },
        identity,
      ),
      false,
    );

    __testInternals.writeCachedSessionRecord(sessionFile, record);
    chmodSync(sessionFile, 0o600);
    assert.deepEqual(__testInternals.readCachedSessionRecord(sessionFile), record);
    assert.deepEqual(
      __testInternals.parseCachedSessionRecord(JSON.parse(readFileSync(sessionFile, 'utf8'))),
      record,
    );
    assert.deepEqual(
      __testInternals.parseCachedSessionRecord({
        ...record,
        expires_at: null,
      }),
      {
        ...record,
        expires_at: null,
      },
    );
    writeFileSync(sessionFile, '\n', 'utf8');
    assert.equal(__testInternals.readCachedSessionRecord(sessionFile), null);
    writeFileSync(sessionFile, '{"broken"', 'utf8');
    assert.equal(__testInternals.readCachedSessionRecord(sessionFile), null);
    assert.equal(__testInternals.parseCachedSessionRecord(null), null);
    assert.equal(__testInternals.parseCachedSessionRecord({ schema_version: 3 }), null);
    assert.equal(__testInternals.parseCachedSessionRecord({ schema_version: 2 }), null);
    assert.equal(
      __testInternals.parseCachedSessionRecord({
        schema_version: 1,
        supabase_url: 'https://example.supabase.co',
        publishable_key_fingerprint: 'sha256:publishable',
        user_api_key_fingerprint: 'sha256:user',
        user_email: 'user@example.com',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: 'bad-expiry',
        updated_at_utc: '2026-04-06T00:00:00.000Z',
      }),
      null,
    );
    assert.throws(
      () =>
        __testInternals.buildCachedSessionRecord({
          runtime: identity,
          session: {
            access_token: '',
            refresh_token: '',
          } as never,
          userEmail: 'user@example.com',
          now,
        }),
      /Supabase auth did not return a usable session/u,
    );

    __testInternals.memoizeRecord(identity, record);
    assert.deepEqual(__testInternals.getMemoizedRecord(identity), record);
    __testInternals.dropMemoizedRecord(identity);
    assert.equal(__testInternals.getMemoizedRecord(identity), null);
  } finally {
    clearSessionState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session cache permission behavior is platform-injected on every host', () => {
  clearSessionState();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-session-platform-permissions-'));
  const linuxSessionFile = path.join(dir, 'linux', 'session.json');
  const windowsSessionFile = path.join(dir, 'windows', 'session.json');
  const runtime = makeRuntime({ sessionFile: linuxSessionFile });
  const identity = __testInternals.buildRuntimeIdentity(runtime);
  const record = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: makeSession() as never,
    userEmail: 'user@example.com',
    now: new Date('2026-08-31T00:00:00.000Z'),
  });
  const originalStatSync = mutableFs.statSync;
  const originalChmodSync = mutableFs.chmodSync;
  const chmodModes: number[] = [];

  try {
    assert.equal(
      Reflect.set(
        mutableFs,
        'statSync',
        (() =>
          ({
            isFile: () => true,
            mode: 0o100644,
          }) as ReturnType<typeof mutableFs.statSync>) as typeof mutableFs.statSync,
      ),
      true,
    );
    mutableFs.chmodSync = ((_filePath, mode) => {
      chmodModes.push(Number(mode));
    }) as typeof mutableFs.chmodSync;
    syncBuiltinESMExports();

    assert.equal(
      __testInternals.readCachedSessionRecord('/synthetic/public-session.json', 'linux'),
      null,
    );
    __testInternals.writeCachedSessionRecord(linuxSessionFile, record, 'linux');
    assert.deepEqual(chmodModes, [0o700, 0o600]);

    chmodModes.length = 0;
    __testInternals.writeCachedSessionRecord(windowsSessionFile, record, 'win32');
    assert.deepEqual(chmodModes, [0o600]);
  } finally {
    assert.equal(Reflect.set(mutableFs, 'statSync', originalStatSync), true);
    mutableFs.chmodSync = originalChmodSync;
    syncBuiltinESMExports();
    clearSessionState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCachedSessionRecord removes temp files when the final rename fails', () => {
  clearSessionState();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-session-write-fail-'));
  const sessionFile = path.join(dir, 'session.json');
  const runtime = makeRuntime({ sessionFile });
  const identity = __testInternals.buildRuntimeIdentity(runtime);
  const record = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: makeSession() as never,
    userEmail: 'user@example.com',
    now: new Date('2026-04-06T00:00:00.000Z'),
  });
  const originalRenameSync = mutableFs.renameSync;

  try {
    mutableFs.renameSync = (() => {
      throw new Error('rename failed');
    }) as typeof mutableFs.renameSync;
    syncBuiltinESMExports();

    assert.throws(
      () => __testInternals.writeCachedSessionRecord(sessionFile, record),
      /rename failed/u,
    );
    assert.equal(existsSync(sessionFile), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    mutableFs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    clearSessionState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withSessionOperationLock serializes same-key tasks and releases the queue', async () => {
  clearSessionState();
  const steps: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });

  const first = __testInternals.withSessionOperationLock('demo-key', async () => {
    steps.push('first:start');
    await firstGate;
    steps.push('first:end');
  });
  const second = __testInternals.withSessionOperationLock('demo-key', async () => {
    steps.push('second:start');
    steps.push('second:end');
  });

  await Promise.resolve();
  steps.push('between');
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(steps, ['between', 'first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(__testInternals.SESSION_OPERATION_CHAINS.size, 0);
});

test('internal session helpers cover refresh null paths, direct resolve branches, and runtime wrappers', async () => {
  clearSessionState();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-session-internals-'));
  const sessionFile = path.join(dir, 'session.json');
  const runtime = makeRuntime({ sessionFile });
  const identity = __testInternals.buildRuntimeIdentity(runtime);
  const freshRecord = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: makeSession({ accessToken: 'fresh-token' }) as never,
    userEmail: 'user@example.com',
    now: new Date('2026-04-06T00:00:00.000Z'),
  });
  __testInternals.memoizeRecord(identity, freshRecord);
  __testInternals.writeCachedSessionRecord(sessionFile, freshRecord);

  try {
    const fromMemory = await __testInternals.resolveAndPersistSession({
      runtime,
      runtimeIdentity: identity,
      fetchImpl: async () => {
        throw new Error('should not sign in');
      },
      timeoutMs: 25,
      now: new Date('2026-04-06T00:00:00.000Z'),
      forceRefresh: false,
    });
    assert.equal(fromMemory.source, 'memory');

    __testInternals.dropMemoizedRecord(identity);
    __testInternals.writeCachedSessionRecord(sessionFile, freshRecord);
    const fromCache = await __testInternals.resolveAndPersistSession({
      runtime,
      runtimeIdentity: identity,
      fetchImpl: async () => {
        throw new Error('should not sign in');
      },
      timeoutMs: 25,
      now: new Date('2026-04-06T00:00:01.000Z'),
      forceRefresh: false,
    });
    assert.equal(fromCache.source, 'cache');

    assert.equal(
      await __testInternals.refreshWithRefreshToken({
        runtime,
        runtimeIdentity: identity,
        refreshToken: '',
        fetchImpl: async () => {
          throw new Error('unreachable');
        },
        timeoutMs: 25,
        now: new Date('2026-04-06T00:00:00.000Z'),
      }),
      null,
    );
    assert.equal(
      await __testInternals.refreshWithRefreshToken({
        runtime,
        runtimeIdentity: identity,
        refreshToken: 'refresh-token',
        fetchImpl: async () =>
          makeJsonResponse(
            { error: 'invalid_grant', error_description: 'network failure' },
            { ok: false, status: 400 },
          ),
        timeoutMs: 25,
        now: new Date('2026-04-06T00:00:00.000Z'),
      }),
      null,
    );
    await assert.rejects(
      __testInternals.refreshWithRefreshToken({
        runtime,
        runtimeIdentity: {
          ...identity,
          projectBaseUrl: 'not a valid supabase url',
        },
        refreshToken: 'refresh-token',
        fetchImpl: async () => {
          throw new Error('should not call fetch');
        },
        timeoutMs: 25,
        now: new Date('2026-04-06T00:00:00.000Z'),
      }),
      { code: 'SUPABASE_OAUTH_REFRESH_UNAVAILABLE' },
    );
    const authClient = __testInternals.createSupabaseAuthClient(
      identity,
      runtime.publishableKey,
      async () => {
        throw new Error('unused');
      },
      25,
    );
    assert.ok(authClient);
  } finally {
    clearSessionState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state-lock helpers behave the same from the built dist module', async () => {
  const module = await loadDistModule<typeof import('../src/lib/locks/state-lock.js')>(
    'src/lib/locks/state-lock.js',
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-dist-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = module.lockPathForState(statePath);

  try {
    assert.equal(lockPath, `${statePath}.lock`);
    assert.equal(module.readStateLockMetadata(lockPath), null);
    writeFileSync(lockPath, '{"ownerPid":123}\n', 'utf8');
    assert.deepEqual(module.readStateLockMetadata(lockPath), {
      ownerPid: 123,
    });
    assert.equal(module.isProcessAlive(process.pid), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
