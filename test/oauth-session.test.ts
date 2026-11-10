import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError, toErrorPayload } from '../src/shared/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/transport/http.js';
import {
  createSupabaseFetch,
  type SupabaseRestRuntime,
} from '../src/lib/transport/supabase-client.js';
import {
  __testInternals,
  createSupabaseDataRuntime,
  inspectSupabaseAuthStatus,
  loginWithSupabaseOAuth,
  logoutSupabaseUserSession,
  resolveSupabaseUserSession,
} from '../src/lib/auth/supabase-session.js';
import { loadDistModule } from './helpers/load-dist-module.js';

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '223e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-08-31T00:00:00.000Z');

function runtime(overrides: Partial<SupabaseRestRuntime> = {}): SupabaseRestRuntime {
  return {
    apiBaseUrl: 'https://example.supabase.co/functions/v1',
    authMode: 'oauth',
    oauthClientId: CLIENT_ID,
    oauthRedirectUri: 'http://127.0.0.1:49191/oauth/callback',
    accessToken: null,
    publishableKey: 'sb-publishable-key',
    sessionFile: null,
    disableSessionCache: false,
    forceReauth: false,
    ...overrides,
  } as SupabaseRestRuntime;
}

function jsonResponse(body: unknown, status = 200): ResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        if (name.toLowerCase() === 'content-length') return String(Buffer.byteLength(text));
        return null;
      },
    },
    async text() {
      return text;
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function expectCliCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CliError && error.code === code;
}

test('auth status inspects only bound local metadata and never exposes credential state', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-status-'));
  const sessionFile = path.join(dir, 'session.json');
  const oauthRuntime = runtime({ sessionFile });
  try {
    assert.deepEqual(inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }), {
      schemaVersion: 'tiangong.cli-auth-status.v1',
      status: 'login-required',
      authMethod: 'oauth',
      sessionState: 'missing',
      sessionCache: 'private-file',
      expiresAt: null,
      grantedScopes: [],
      onlineVerified: false,
    });

    const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
    const fresh = __testInternals.buildCachedSessionRecord({
      runtime: identity,
      session: {
        access_token: 'status-access-secret',
        refresh_token: 'status-refresh-secret',
        expires_at: Math.floor(NOW.getTime() / 1_000) + 3_600,
        expires_in: 3_600,
      },
      userEmail: 'status-user@example.com',
      grantedScopes: ['profile', 'email'],
      now: NOW,
    });
    __testInternals.writeCachedSessionRecord(sessionFile, fresh);
    const ready = inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW });
    assert.deepEqual(ready, {
      schemaVersion: 'tiangong.cli-auth-status.v1',
      status: 'ready',
      authMethod: 'oauth',
      sessionState: 'fresh',
      sessionCache: 'private-file',
      expiresAt: Math.floor(NOW.getTime() / 1_000) + 3_600,
      grantedScopes: ['email', 'profile'],
      onlineVerified: false,
    });
    assert.doesNotMatch(
      JSON.stringify(ready),
      /status-access|status-refresh|status-user|session\.json/u,
    );

    __testInternals.memoizeRecord(identity, fresh);
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).sessionState,
      'fresh',
    );
    __testInternals.dropMemoizedRecord(identity);

    __testInternals.memoizeRecord(identity, { ...fresh, refresh_token: '' });
    assert.equal(inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).status, 'ready');
    __testInternals.dropMemoizedRecord(identity);

    const stale = { ...fresh, expires_at: 1 };
    __testInternals.writeCachedSessionRecord(sessionFile, stale);
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).sessionState,
      'refresh-required',
    );

    const foreignRuntime = runtime({
      sessionFile,
      oauthClientId: '323e4567-e89b-42d3-a456-426614174000',
    });
    const foreignIdentity = __testInternals.buildRuntimeIdentity(foreignRuntime);
    const foreign = __testInternals.buildCachedSessionRecord({
      runtime: foreignIdentity,
      session: {
        access_token: 'foreign-access',
        refresh_token: 'foreign-refresh',
        expires_at: Math.floor(NOW.getTime() / 1_000) + 3_600,
        expires_in: 3_600,
      },
      userEmail: 'foreign@example.com',
      now: NOW,
    });
    __testInternals.writeCachedSessionRecord(sessionFile, foreign);
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).status,
      'login-required',
    );

    const disabledStatus = inspectSupabaseAuthStatus({
      runtime: runtime({ disableSessionCache: true }),
      now: NOW,
    });
    assert.equal(disabledStatus.status, 'login-required');
    assert.equal(disabledStatus.sessionCache, 'disabled');

    assert.equal(
      inspectSupabaseAuthStatus({
        runtime: runtime({
          authMode: 'access_token',
          oauthClientId: null,
          oauthRedirectUri: null,
          accessToken: 'headless-secret',
        }),
      }).sessionState,
      'memory-only',
    );
    const dist = await loadDistModule<typeof import('../src/lib/auth/supabase-session.js')>(
      'src/lib/auth/supabase-session.js',
    );
    assert.equal(
      dist.inspectSupabaseAuthStatus({
        runtime: oauthRuntime,
        now: NOW,
      }).status,
      'login-required',
    );
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth login runs real PKCE/loopback/token flow and persists a private rotating session', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-session-'));
  const sessionFile = path.join(dir, 'state', 'session.json');
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const oauthRuntime = runtime({ sessionFile, oauthRedirectUri: redirectUri });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/auth/v1/oauth/token')) {
      return jsonResponse({
        access_token:
          requests.filter((request) => request.url.endsWith('/oauth/token')).length === 1
            ? 'oauth-access-one'
            : 'oauth-access-two',
        refresh_token:
          requests.filter((request) => request.url.endsWith('/oauth/token')).length === 1
            ? 'oauth-refresh-one'
            : 'oauth-refresh-two',
        token_type: 'bearer',
        expires_in: 3600,
        scope: '',
      });
    }
    if (url.endsWith('/auth/v1/oauth/userinfo')) {
      return jsonResponse({ sub: USER_ID, email: 'oauth@example.com' });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };

  try {
    const receipt = await loginWithSupabaseOAuth({
      runtime: oauthRuntime,
      fetchImpl,
      requestTimeoutMs: 1000,
      loginTimeoutMs: 1000,
      now: NOW,
      openBrowserImpl: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl);
        assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
        assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        const state = authorize.searchParams.get('state');
        assert.ok(state);
        const response = await fetch(`${redirectUri}?state=${state}&code=authorization-code`);
        assert.equal(response.status, 200);
      },
    });

    assert.deepEqual(receipt, {
      schemaVersion: 'tiangong.cli-oauth-login.v1',
      status: 'authenticated',
      authMethod: 'oauth',
      expiresAt: 1_788_138_000,
      grantedScopes: ['email', 'openid', 'profile'],
      sessionCache: 'private-file',
    });
    assert.equal(JSON.stringify(receipt).includes('oauth-access'), false);
    assert.equal(JSON.stringify(receipt).includes('oauth@example.com'), false);
    const stored = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(stored.schema_version, 2);
    assert.equal(stored.auth_method, 'oauth');
    assert.equal(stored.access_token, 'oauth-access-one');
    assert.equal(stored.refresh_token, 'oauth-refresh-one');
    assert.equal('user_api_key_fingerprint' in stored, false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(sessionFile)).mode & 0o777, 0o700);
    }

    const memory = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      fetchImpl,
      now: new Date('2026-08-31T00:00:01.000Z'),
    });
    assert.equal(memory.source, 'memory');
    assert.equal(memory.authMethod, 'oauth');
    assert.equal(memory.accessToken, 'oauth-access-one');

    const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
    __testInternals.dropMemoizedRecord(identity);
    const cache = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      fetchImpl,
      now: new Date('2026-08-31T00:00:02.000Z'),
    });
    assert.equal(cache.source, 'cache');

    const refreshed = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      fetchImpl,
      now: new Date('2026-08-31T00:00:03.000Z'),
      forceRefresh: true,
    });
    assert.equal(refreshed.source, 'refresh');
    assert.equal(refreshed.accessToken, 'oauth-access-two');
    assert.equal(refreshed.refreshToken, 'oauth-refresh-two');
    assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).refresh_token, 'oauth-refresh-two');

    const logout = await logoutSupabaseUserSession({ runtime: oauthRuntime });
    assert.deepEqual(logout, {
      schemaVersion: 'tiangong.cli-oauth-logout.v1',
      status: 'logged-out',
      removed: true,
    });
    assert.equal(existsSync(sessionFile), false);
    assert.equal((await logoutSupabaseUserSession({ runtime: oauthRuntime })).removed, false);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth login supports injected protocol adapters and records returned scopes', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-injected-'));
  const sessionFile = path.join(dir, 'session.json');
  const oauthRuntime = runtime({ sessionFile });
  const calls: string[] = [];
  try {
    const receipt = await loginWithSupabaseOAuth({
      runtime: oauthRuntime,
      fetchImpl: async () => jsonResponse({}),
      createPkceValuesImpl: () => ({
        codeVerifier: 'v'.repeat(64),
        codeChallenge: 'c'.repeat(43),
        state: 's'.repeat(43),
      }),
      receiveCallbackImpl: async (options) => {
        calls.push('callback');
        await options.onListening();
        return 'code';
      },
      browserOptions: {
        platform: 'linux',
        spawnImpl: (_command, _args, _options) => {
          const listeners: Record<string, (...args: never[]) => void> = {};
          const child = {
            once(event: string, listener: (...args: never[]) => void) {
              listeners[event] = listener;
              if (event === 'spawn') queueMicrotask(() => listeners.spawn?.());
              return child;
            },
            unref() {
              calls.push('browser');
            },
          };
          return child as never;
        },
      },
      exchangeCodeImpl: async (options) => {
        calls.push(`exchange:${options.authorizationCode}:${options.codeVerifier.length}`);
        return {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresIn: 900,
          scope: ['email'],
        };
      },
      fetchUserInfoImpl: async () => {
        calls.push('userinfo');
        return { userId: USER_ID, email: 'user@example.com' };
      },
    });
    assert.deepEqual(calls, ['callback', 'browser', 'exchange:code:64', 'userinfo']);
    assert.deepEqual(receipt.grantedScopes, ['email']);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth mode never falls back to password sign-in when login or refresh is unavailable', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-required-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    const oauthRuntime = runtime({ sessionFile });
    await assert.rejects(
      () =>
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          fetchImpl: async () => {
            throw new Error('must not call password auth');
          },
        }),
      expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
    );

    const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
    const stale = __testInternals.buildCachedSessionRecord({
      runtime: identity,
      session: {
        access_token: 'stale-access',
        refresh_token: 'stale-refresh',
        expires_at: 1,
        expires_in: 1,
      },
      userEmail: 'user@example.com',
      grantedScopes: ['email'],
      now: NOW,
    });
    __testInternals.writeCachedSessionRecord(sessionFile, stale);
    await assert.rejects(
      () =>
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          fetchImpl: async (url) =>
            url.endsWith('/oauth/token')
              ? jsonResponse({ error: 'invalid_grant' }, 400)
              : jsonResponse({}),
          forceRefresh: true,
        }),
      expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
    );

    await assert.rejects(
      () =>
        loginWithSupabaseOAuth({
          runtime: runtime({
            authMode: 'access_token',
            oauthClientId: null,
            oauthRedirectUri: null,
            accessToken: 'headless-secret',
          }),
          fetchImpl: async () => jsonResponse({}),
        }),
      expectCliCode('SUPABASE_OAUTH_RUNTIME_REQUIRED'),
    );
    await assert.rejects(
      () =>
        loginWithSupabaseOAuth({
          runtime: runtime({ disableSessionCache: true }),
          fetchImpl: async () => jsonResponse({}),
        }),
      expectCliCode('SUPABASE_OAUTH_SESSION_CACHE_REQUIRED'),
    );
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth refresh can recover memory-only state and missing cache-disabled state fails closed', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-memory-refresh-'));
  const sessionFile = path.join(dir, 'session.json');
  const oauthRuntime = runtime({ sessionFile, disableSessionCache: true });
  const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
  const stale = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: {
      access_token: 'stale-memory-access',
      refresh_token: 'stale-memory-refresh',
      expires_at: 1,
      expires_in: 1,
    },
    userEmail: 'memory@example.com',
    grantedScopes: ['email'],
    now: NOW,
  });
  __testInternals.memoizeRecord(identity, stale);

  try {
    const refreshed = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      forceRefresh: true,
      now: NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/auth/v1/oauth/token')) {
          return jsonResponse({
            access_token: 'fresh-memory-access',
            refresh_token: 'fresh-memory-refresh',
            token_type: 'bearer',
            expires_in: 3_600,
            scope: 'openid email profile',
          });
        }
        if (url.endsWith('/auth/v1/oauth/userinfo')) {
          return jsonResponse({ sub: USER_ID, email: 'memory@example.com' });
        }
        throw new Error(`Unexpected OAuth request: ${url}`);
      },
    });
    assert.equal(refreshed.source, 'refresh');
    assert.equal(refreshed.accessToken, 'fresh-memory-access');

    __testInternals.SESSION_MEMORY_CACHE.clear();
    await assert.rejects(
      () =>
        resolveSupabaseUserSession({
          runtime: runtime({ disableSessionCache: true }),
          fetchImpl: async () => {
            throw new Error('OAuth without a private session cache must not bootstrap remotely.');
          },
          now: NOW,
        }),
      expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
    );
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit headless access tokens are verified online and never cached or refreshed', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const accessRuntime = runtime({
    authMode: 'access_token',
    oauthClientId: null,
    oauthRedirectUri: null,
    accessToken: 'explicit-access-token',
    sessionFile: '/tmp/must-not-be-used.json',
  });
  let userCalls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer explicit-access-token');
    userCalls += 1;
    return jsonResponse({
      id: USER_ID,
      email: 'headless@example.com',
      role: 'authenticated',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    });
  };
  const session = await resolveSupabaseUserSession({ runtime: accessRuntime, fetchImpl });
  assert.deepEqual(session, {
    accessToken: 'explicit-access-token',
    refreshToken: '',
    expiresAt: null,
    userEmail: 'headless@example.com',
    projectBaseUrl: 'https://example.supabase.co',
    sessionFile: null,
    authMethod: 'access_token',
    source: 'access_token',
  });
  const dataRuntime = createSupabaseDataRuntime({ runtime: accessRuntime, fetchImpl });
  assert.equal(await dataRuntime.getAccessToken(), 'explicit-access-token');
  assert.equal(dataRuntime.refreshAccessToken, undefined);
  assert.equal(userCalls, 1);
  assert.equal((await logoutSupabaseUserSession({ runtime: accessRuntime })).removed, false);
  const identity = __testInternals.buildRuntimeIdentity(accessRuntime);
  assert.equal(
    await __testInternals.refreshWithRefreshToken({
      runtime: accessRuntime,
      runtimeIdentity: identity,
      refreshToken: 'unused',
      fetchImpl,
      timeoutMs: 100,
      now: NOW,
    }),
    null,
  );
  assert.equal(
    (
      await __testInternals.resolveAndPersistSession({
        runtime: accessRuntime,
        runtimeIdentity: identity,
        fetchImpl,
        timeoutMs: 100,
        now: NOW,
        forceRefresh: false,
      })
    ).source,
    'access_token',
  );

  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  await assert.rejects(
    () =>
      resolveSupabaseUserSession({
        runtime: accessRuntime,
        fetchImpl: async () => jsonResponse({ id: USER_ID, email: '', role: 'anon' }),
      }),
    expectCliCode('SUPABASE_ACCESS_TOKEN_INVALID'),
  );
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  await assert.rejects(
    () =>
      resolveSupabaseUserSession({
        runtime: accessRuntime,
        fetchImpl: async () => jsonResponse({ message: 'invalid token' }, 401),
      }),
    expectCliCode('SUPABASE_ACCESS_TOKEN_INVALID'),
  );
});

test('logout preserves foreign client sessions and broad-permission cache files are ignored', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-foreign-'));
  const sessionFile = path.join(dir, 'session.json');
  const current = runtime({ sessionFile });
  const foreign = runtime({
    sessionFile,
    oauthClientId: '323e4567-e89b-42d3-a456-426614174000',
  });
  try {
    const foreignIdentity = __testInternals.buildRuntimeIdentity(foreign);
    const record = __testInternals.buildCachedSessionRecord({
      runtime: foreignIdentity,
      session: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: 4_102_444_800,
        expires_in: 3600,
      },
      userEmail: 'user@example.com',
      now: NOW,
    });
    __testInternals.writeCachedSessionRecord(sessionFile, record);
    assert.equal((await logoutSupabaseUserSession({ runtime: current })).removed, false);
    assert.equal(existsSync(sessionFile), true);
    if (process.platform !== 'win32') {
      chmodSync(sessionFile, 0o644);
      assert.equal(__testInternals.readCachedSessionRecord(sessionFile), null);
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    __testInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

function staleRefreshFixture(sessionFile: string) {
  const oauthRuntime = runtime({ sessionFile });
  const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
  const stale = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: {
      access_token: 'expired-synthetic-access',
      refresh_token: 'rejected-synthetic-refresh',
      expires_at: 1,
      expires_in: 1,
    },
    userEmail: 'fixture@example.com',
    grantedScopes: ['email'],
    now: NOW,
  });
  __testInternals.writeCachedSessionRecord(sessionFile, stale);
  return { oauthRuntime, identity, stale };
}

test('terminal OAuth refresh retires its persisted token across independent session loads', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-terminal-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, identity, stale } = staleRefreshFixture(sessionFile);
  __testInternals.memoizeRecord(identity, stale);
  let tokenPosts = 0;
  const fetchImpl: FetchLike = async (url) => {
    assert.ok(url.endsWith('/oauth/token'));
    tokenPosts += 1;
    return jsonResponse(
      { error: 'invalid_grant', error_description: 'private-provider-detail' },
      400,
    );
  };
  try {
    await assert.rejects(
      resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
      expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
    );
    assert.equal(existsSync(sessionFile), false);
    const independent = await loadDistModule<typeof import('../src/lib/auth/supabase-session.js')>(
      'src/lib/auth/supabase-session.js',
    );
    independent.__testInternals.SESSION_MEMORY_CACHE.clear();
    await assert.rejects(
      independent.resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
      (error: unknown) => (error as CliError).code === 'SUPABASE_OAUTH_LOGIN_REQUIRED',
    );
    assert.equal(tokenPosts, 1);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth token transport, rate-limit, upstream and protocol failures retain recoverable state', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-transient-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  const failures: Array<{ fetchImpl: FetchLike; category: string; status: number | null }> = [
    {
      fetchImpl: async () => {
        throw new Error('private-network-secret');
      },
      category: 'network',
      status: null,
    },
    {
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 429),
      category: 'rate_limit',
      status: 429,
    },
    {
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 503),
      category: 'upstream',
      status: 503,
    },
    {
      fetchImpl: async () => jsonResponse({ error: 'invalid_client' }, 400),
      category: 'rejected',
      status: 400,
    },
    { fetchImpl: async () => jsonResponse({}), category: 'protocol', status: null },
  ];
  try {
    for (const { fetchImpl, category, status } of failures) {
      await assert.rejects(
        resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, 'SUPABASE_OAUTH_REFRESH_UNAVAILABLE');
          assert.deepEqual(error.details, { stage: 'token', category, status });
          assert.doesNotMatch(JSON.stringify(toErrorPayload(error)), /private-|synthetic/);
          return true;
        },
      );
      assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), stale);
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotated refresh survives failed UserInfo without bypassing identity verification', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-rotation-recovery-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  let tokenPosts = 0;
  let profiles = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      tokenPosts += 1;
      assert.equal(
        new URLSearchParams(String(init?.body)).get('refresh_token'),
        tokenPosts === 1 ? stale.refresh_token : 'rotated-recovery-refresh',
      );
      return jsonResponse({
        access_token: 'rotated-recovery-access',
        refresh_token: 'rotated-recovery-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'openid email profile',
      });
    }
    assert.ok(url.endsWith('/oauth/userinfo'));
    profiles += 1;
    const checkpoint = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(checkpoint.refresh_token, 'rotated-recovery-refresh');
    assert.equal(checkpoint.expires_at, 0);
    assert.equal(checkpoint.access_token, stale.access_token);
    return profiles === 1
      ? jsonResponse({ error: 'server_error' }, 503)
      : jsonResponse({ sub: USER_ID, email: 'verified@example.com' });
  };
  try {
    await assert.rejects(
      resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
      (error) =>
        error instanceof CliError &&
        error.code === 'SUPABASE_OAUTH_REFRESH_UNAVAILABLE' &&
        JSON.stringify(error.details) ===
          JSON.stringify({ stage: 'userinfo', category: 'upstream', status: 503 }),
    );
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).sessionState,
      'refresh-required',
    );
    __testInternals.SESSION_MEMORY_CACHE.clear();
    const independent = await loadDistModule<typeof import('../src/lib/auth/supabase-session.js')>(
      'src/lib/auth/supabase-session.js',
    );
    independent.__testInternals.SESSION_MEMORY_CACHE.clear();
    const recovered = await independent.resolveSupabaseUserSession({
      runtime: oauthRuntime,
      fetchImpl,
      now: NOW,
    });
    assert.equal(tokenPosts, 2);
    assert.equal(profiles, 2);
    assert.equal(recovered.userEmail, 'verified@example.com');
    assert.equal(recovered.accessToken, 'rotated-recovery-access');
    assert.ok((recovered.expiresAt ?? 0) > Math.floor(NOW.getTime() / 1000));
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale refresh failure preserves a newer or unrelated session and its memory record', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-stale-rejection-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const unrelated of [false, true]) {
      const { oauthRuntime, identity, stale } = staleRefreshFixture(sessionFile);
      const newer = {
        ...stale,
        refresh_token: 'newer-refresh',
        access_token: 'newer-access',
        updated_at_utc: '2026-08-31T00:00:01Z',
        ...(unrelated ? { auth_binding_fingerprint: 'unrelated-client' } : {}),
      };
      await assert.rejects(
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          now: NOW,
          fetchImpl: async () => {
            __testInternals.writeCachedSessionRecord(sessionFile, newer);
            __testInternals.memoizeRecord(identity, newer);
            return jsonResponse({ error: 'invalid_grant' }, 400);
          },
        }),
        expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
      );
      assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), newer);
      assert.deepEqual(__testInternals.SESSION_MEMORY_CACHE.get(identity.memoKey), newer);
      __testInternals.SESSION_MEMORY_CACHE.clear();
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale refresh success cannot overwrite a newer login or resurrect a logged-out session', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-stale-success-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const replace of [false, true]) {
      const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
      const newer = { ...stale, refresh_token: 'newer-refresh' };
      let profiles = 0;
      await assert.rejects(
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          now: NOW,
          fetchImpl: async (url) => {
            if (url.endsWith('/oauth/userinfo')) {
              profiles += 1;
              return jsonResponse({ sub: USER_ID, email: 'new@example.com' });
            }
            if (replace) __testInternals.writeCachedSessionRecord(sessionFile, newer);
            else rmSync(sessionFile);
            return jsonResponse({
              access_token: 'obsolete-access',
              refresh_token: 'obsolete-refresh',
              token_type: 'bearer',
              expires_in: 3600,
            });
          },
        }),
        expectCliCode('SUPABASE_OAUTH_SESSION_CHANGED'),
      );
      assert.equal(profiles, 0);
      if (replace) assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), newer);
      else assert.equal(existsSync(sessionFile), false);
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth data runtime refreshes a fresh rejected read once and never replays a mutation', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-read-recovery-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  __testInternals.writeCachedSessionRecord(sessionFile, {
    ...stale,
    access_token: 'fresh-rejected-access',
    expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
  });
  const readUrl = 'https://example.supabase.co/rest/v1/flows';
  const requests: Array<{ url: string; method: string; token: string | null }> = [];
  let reads = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method, token: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/auth/v1/oauth/token')) {
      assert.equal(
        new URLSearchParams(String(init?.body)).get('refresh_token'),
        stale.refresh_token,
      );
      return jsonResponse({
        access_token: 'read-recovery-access',
        refresh_token: 'read-recovery-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'email openid profile',
      });
    }
    if (url.endsWith('/auth/v1/oauth/userinfo')) {
      return jsonResponse({ sub: USER_ID, email: 'fixture@example.com' });
    }
    assert.equal(url, readUrl);
    if (method === 'GET') {
      reads += 1;
      return reads === 1 ? jsonResponse({}, 401) : jsonResponse([{ id: 'fixture-flow' }]);
    }
    assert.equal(method, 'POST');
    return jsonResponse({}, 401);
  };
  try {
    const dataRuntime = createSupabaseDataRuntime({ runtime: oauthRuntime, fetchImpl, now: NOW });
    const supabaseFetch = createSupabaseFetch(fetchImpl, 1000, dataRuntime);
    const read = await supabaseFetch(readUrl);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), [{ id: 'fixture-flow' }]);
    assert.deepEqual(requests, [
      { url: readUrl, method: 'GET', token: 'Bearer fresh-rejected-access' },
      { url: 'https://example.supabase.co/auth/v1/oauth/token', method: 'POST', token: null },
      {
        url: 'https://example.supabase.co/auth/v1/oauth/userinfo',
        method: 'GET',
        token: 'Bearer read-recovery-access',
      },
      { url: readUrl, method: 'GET', token: 'Bearer read-recovery-access' },
    ]);
    const persisted = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(persisted.access_token, 'read-recovery-access');
    assert.equal(persisted.refresh_token, 'read-recovery-refresh');
    assert.equal(persisted.expires_at, Math.floor(NOW.getTime() / 1000) + 3600);
    const mutation = await supabaseFetch(readUrl, { method: 'POST', body: '{}' });
    assert.equal(mutation.status, 401);
    assert.equal(requests.length, 5);
    assert.deepEqual(requests[4], {
      url: readUrl,
      method: 'POST',
      token: 'Bearer read-recovery-access',
    });
    assert.equal(existsSync(`${sessionFile}.lock`), false);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent independent getters share one successful expired-session refresh', async () => {
  const independent = await loadDistModule<typeof import('../src/lib/auth/supabase-session.js')>(
    'src/lib/auth/supabase-session.js',
  );
  __testInternals.SESSION_MEMORY_CACHE.clear();
  independent.__testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-concurrent-success-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  const requests: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push(url);
    if (url.endsWith('/auth/v1/oauth/token')) {
      assert.equal(init?.method, 'POST');
      assert.equal(
        new URLSearchParams(String(init?.body)).get('refresh_token'),
        stale.refresh_token,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      return jsonResponse({
        access_token: 'shared-rotated-access',
        refresh_token: 'shared-rotated-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'email openid profile',
      });
    }
    assert.ok(url.endsWith('/auth/v1/oauth/userinfo'));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer shared-rotated-access');
    return jsonResponse({ sub: USER_ID, email: 'fixture@example.com' });
  };
  try {
    const clients = [createSupabaseDataRuntime, independent.createSupabaseDataRuntime].map(
      (createRuntime) => createRuntime({ runtime: oauthRuntime, fetchImpl, now: NOW }),
    );
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_entry, index) =>
        clients[index % clients.length]!.getAccessToken(),
      ),
    );
    assert.deepEqual(tokens, Array<string>(8).fill('shared-rotated-access'));
    assert.deepEqual(requests, [
      'https://example.supabase.co/auth/v1/oauth/token',
      'https://example.supabase.co/auth/v1/oauth/userinfo',
    ]);
    const persisted = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(persisted.access_token, 'shared-rotated-access');
    assert.equal(persisted.refresh_token, 'shared-rotated-refresh');
    assert.equal(persisted.expires_at, Math.floor(NOW.getTime() / 1000) + 3600);
    assert.deepEqual(await Promise.all(clients.map((client) => client.getAccessToken())), [
      'shared-rotated-access',
      'shared-rotated-access',
    ]);
    assert.equal(requests.length, 2);
    assert.equal(existsSync(`${sessionFile}.lock`), false);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    independent.__testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent callers retire one rejected token without resubmitting it', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-concurrent-terminal-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime } = staleRefreshFixture(sessionFile);
  let tokenPosts = 0;
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          now: NOW,
          fetchImpl: async () => {
            tokenPosts += 1;
            await new Promise<void>((resolve) => setImmediate(resolve));
            return jsonResponse({ error: 'invalid_grant' }, 400);
          },
        }),
      ),
    );
    assert.equal(tokenPosts, 1);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected')
        assert.equal((result.reason as CliError).code, 'SUPABASE_OAUTH_LOGIN_REQUIRED');
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory-only refresh recovery still requires UserInfo and retires terminal tokens', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const oauthRuntime = runtime({ disableSessionCache: true });
  const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
  const stale = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: {
      access_token: 'expired-memory',
      refresh_token: 'rotating-memory',
      expires_at: 1,
      expires_in: 1,
    },
    userEmail: 'memory@example.com',
    now: NOW,
  });
  __testInternals.memoizeRecord(identity, stale);
  try {
    const recovered = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      now: NOW,
      fetchImpl: async (url) =>
        url.endsWith('/oauth/token')
          ? jsonResponse({
              access_token: 'new-memory',
              refresh_token: 'new-memory-refresh',
              token_type: 'bearer',
              expires_in: 3600,
            })
          : jsonResponse({ sub: USER_ID, email: 'verified-memory@example.com' }),
    });
    assert.equal(recovered.userEmail, 'verified-memory@example.com');
    assert.equal(recovered.sessionFile, null);
    const reused = await resolveSupabaseUserSession({
      runtime: oauthRuntime,
      now: NOW,
      fetchImpl: async () => {
        throw new Error('fresh memory-only reuse performs no request');
      },
    });
    assert.equal(reused.source, 'memory');
    assert.equal(inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).status, 'ready');
    await assert.rejects(
      resolveSupabaseUserSession({
        runtime: oauthRuntime,
        now: NOW,
        forceRefresh: true,
        fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
      }),
      expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
    );
    assert.equal(__testInternals.SESSION_MEMORY_CACHE.size, 0);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
  }
});

test('profile success after an out-of-band session change cannot publish obsolete actor state', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-profile-race-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  const newer = {
    ...stale,
    refresh_token: 'newer-login-refresh',
    access_token: 'newer-login-access',
  };
  try {
    await assert.rejects(
      resolveSupabaseUserSession({
        runtime: oauthRuntime,
        now: NOW,
        fetchImpl: async (url) => {
          if (url.endsWith('/oauth/token'))
            return jsonResponse({
              access_token: 'rotated-access',
              refresh_token: 'rotated-refresh',
              token_type: 'bearer',
              expires_in: 3600,
            });
          __testInternals.writeCachedSessionRecord(sessionFile, newer);
          return jsonResponse({ sub: USER_ID, email: 'obsolete-actor@example.com' });
        },
      }),
      expectCliCode('SUPABASE_OAUTH_SESSION_CHANGED'),
    );
    assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), newer);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prewarmed independent clients honor disk retirement before reuse or forced refresh', async () => {
  const independent = await loadDistModule<typeof import('../src/lib/auth/supabase-session.js')>(
    'src/lib/auth/supabase-session.js',
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-prewarmed-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const forceRefresh of [true, false]) {
      __testInternals.SESSION_MEMORY_CACHE.clear();
      independent.__testInternals.SESSION_MEMORY_CACHE.clear();
      const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
      __testInternals.writeCachedSessionRecord(sessionFile, {
        ...stale,
        expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
      });
      let tokenPosts = 0;
      const fetchImpl: FetchLike = async () => {
        tokenPosts += 1;
        return jsonResponse({ error: 'invalid_grant' }, 400);
      };
      await resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW });
      await independent.resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW });
      await assert.rejects(
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          fetchImpl,
          now: NOW,
          forceRefresh: true,
        }),
        expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
      );
      assert.equal(existsSync(sessionFile), false);
      await assert.rejects(
        independent.resolveSupabaseUserSession({
          runtime: oauthRuntime,
          fetchImpl,
          now: NOW,
          forceRefresh,
        }),
        (error: unknown) => (error as CliError).code === 'SUPABASE_OAUTH_LOGIN_REQUIRED',
      );
      assert.equal(tokenPosts, 1);
      assert.equal(
        independent.inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).status,
        'login-required',
      );
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    independent.__testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late memory-only rotation cannot recreate a retired expected record', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const oauthRuntime = runtime({ disableSessionCache: true });
  const identity = __testInternals.buildRuntimeIdentity(oauthRuntime);
  const stale = __testInternals.buildCachedSessionRecord({
    runtime: identity,
    session: {
      access_token: 'expired-memory',
      refresh_token: 'retired-memory',
      expires_at: 1,
      expires_in: 1,
    },
    userEmail: 'fixture@example.com',
    now: NOW,
  });
  __testInternals.memoizeRecord(identity, stale);
  let profiles = 0;
  try {
    await assert.rejects(
      resolveSupabaseUserSession({
        runtime: oauthRuntime,
        now: NOW,
        fetchImpl: async (url) => {
          if (url.endsWith('/oauth/userinfo')) {
            profiles += 1;
            return jsonResponse({ sub: USER_ID, email: 'fixture@example.com' });
          }
          __testInternals.dropMemoizedRecord(identity);
          return jsonResponse({
            access_token: 'late-access',
            refresh_token: 'late-refresh',
            token_type: 'bearer',
            expires_in: 3600,
          });
        },
      }),
      expectCliCode('SUPABASE_OAUTH_SESSION_CHANGED'),
    );
    assert.equal(profiles, 0);
    assert.equal(__testInternals.SESSION_MEMORY_CACHE.size, 0);
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
  }
});

test('disk binding replacement suppresses a prewarmed session without touching the foreign record', async () => {
  __testInternals.SESSION_MEMORY_CACHE.clear();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-oauth-disk-binding-'));
  const sessionFile = path.join(dir, 'session.json');
  const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
  const fresh = { ...stale, expires_at: Math.floor(NOW.getTime() / 1000) + 3600 };
  const foreign = { ...fresh, auth_binding_fingerprint: 'different-client-binding' };
  let tokenPosts = 0;
  const fetchImpl: FetchLike = async () => {
    tokenPosts += 1;
    return jsonResponse({ error: 'invalid_grant' }, 400);
  };
  try {
    __testInternals.writeCachedSessionRecord(sessionFile, fresh);
    await resolveSupabaseUserSession({ runtime: oauthRuntime, now: NOW, fetchImpl });
    __testInternals.writeCachedSessionRecord(sessionFile, foreign);
    for (const forceRefresh of [false, true]) {
      await assert.rejects(
        resolveSupabaseUserSession({ runtime: oauthRuntime, now: NOW, fetchImpl, forceRefresh }),
        expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
      );
    }
    assert.equal(tokenPosts, 0);
    assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), foreign);
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: oauthRuntime, now: NOW }).status,
      'login-required',
    );
    const memoryRuntime = runtime({ disableSessionCache: true });
    const memoryIdentity = __testInternals.buildRuntimeIdentity(memoryRuntime);
    __testInternals.memoizeRecord(memoryIdentity, { ...fresh, refresh_token: '' });
    assert.equal(
      inspectSupabaseAuthStatus({ runtime: memoryRuntime, now: NOW }).status,
      'login-required',
    );
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

const nativeTerminalRefreshEnvelopes = [
  { code: 400, error_code: 'refresh_token_not_found', msg: 'private-provider-secret' },
  { code: 'refresh_token_not_found', message: 'private-provider-secret' },
];

test('native terminal refresh envelopes retire across independent and concurrent session callers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-native-terminal-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const envelope of nativeTerminalRefreshEnvelopes) {
      __testInternals.SESSION_MEMORY_CACHE.clear();
      const { oauthRuntime } = staleRefreshFixture(sessionFile);
      let tokenPosts = 0;
      const fetchImpl: FetchLike = async () => {
        tokenPosts += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return jsonResponse(envelope, 400);
      };
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') {
          assert.equal((result.reason as CliError).code, 'SUPABASE_OAUTH_LOGIN_REQUIRED');
          assert.doesNotMatch(JSON.stringify(toErrorPayload(result.reason)), /private-|synthetic/);
        }
      }
      assert.equal(existsSync(sessionFile), false);
      const independent = await loadDistModule<
        typeof import('../src/lib/auth/supabase-session.js')
      >('src/lib/auth/supabase-session.js');
      await assert.rejects(
        independent.resolveSupabaseUserSession({ runtime: oauthRuntime, fetchImpl, now: NOW }),
        (error: unknown) => (error as CliError).code === 'SUPABASE_OAUTH_LOGIN_REQUIRED',
      );
      assert.equal(tokenPosts, 1);
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native terminal responses cannot retire a newer or foreign-client record', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-native-stale-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const envelope of nativeTerminalRefreshEnvelopes) {
      for (const unrelated of [false, true]) {
        __testInternals.SESSION_MEMORY_CACHE.clear();
        const { oauthRuntime, identity, stale } = staleRefreshFixture(sessionFile);
        const newer = {
          ...stale,
          refresh_token: 'newer-refresh',
          ...(unrelated ? { auth_binding_fingerprint: 'foreign-client' } : {}),
        };
        await assert.rejects(
          resolveSupabaseUserSession({
            runtime: oauthRuntime,
            now: NOW,
            fetchImpl: async () => {
              __testInternals.writeCachedSessionRecord(sessionFile, newer);
              __testInternals.memoizeRecord(identity, newer);
              return jsonResponse(envelope, 400);
            },
          }),
          expectCliCode('SUPABASE_OAUTH_LOGIN_REQUIRED'),
        );
        assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), newer);
        assert.deepEqual(__testInternals.SESSION_MEMORY_CACHE.get(identity.memoKey), newer);
      }
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native code requires token stage and HTTP 400 while ambiguous native responses preserve recovery', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-native-recoverable-'));
  const sessionFile = path.join(dir, 'session.json');
  try {
    for (const status of [401, 429, 503]) {
      for (const envelope of nativeTerminalRefreshEnvelopes) {
        __testInternals.SESSION_MEMORY_CACHE.clear();
        const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
        await assert.rejects(
          resolveSupabaseUserSession({
            runtime: oauthRuntime,
            now: NOW,
            fetchImpl: async () => jsonResponse(envelope, status),
          }),
          expectCliCode('SUPABASE_OAUTH_REFRESH_UNAVAILABLE'),
        );
        assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), stale);
      }
    }
    for (const envelope of [
      { error: 'invalid_grant', code: 'refresh_token_not_found' },
      { code: 400, msg: 'refresh_token_not_found' },
      { code: 400, error_code: 'private_token_secret' },
    ]) {
      __testInternals.SESSION_MEMORY_CACHE.clear();
      const { oauthRuntime, stale } = staleRefreshFixture(sessionFile);
      await assert.rejects(
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          now: NOW,
          fetchImpl: async () => jsonResponse(envelope, 400),
        }),
        expectCliCode('SUPABASE_OAUTH_REFRESH_UNAVAILABLE'),
      );
      assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), stale);
    }
    for (const envelope of nativeTerminalRefreshEnvelopes) {
      __testInternals.SESSION_MEMORY_CACHE.clear();
      const { oauthRuntime } = staleRefreshFixture(sessionFile);
      await assert.rejects(
        resolveSupabaseUserSession({
          runtime: oauthRuntime,
          now: NOW,
          fetchImpl: async (url) =>
            url.endsWith('/oauth/token')
              ? jsonResponse({
                  access_token: 'rotated-access',
                  refresh_token: 'rotated-refresh',
                  token_type: 'bearer',
                  expires_in: 3600,
                })
              : jsonResponse(envelope, 400),
        }),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.deepEqual(error.details, { stage: 'userinfo', category: 'rejected', status: 400 });
          assert.doesNotMatch(JSON.stringify(toErrorPayload(error)), /private-|rotated-/);
          return true;
        },
      );
      const retained = JSON.parse(readFileSync(sessionFile, 'utf8'));
      assert.equal(retained.refresh_token, 'rotated-refresh');
      assert.equal(retained.expires_at, 0);
    }
  } finally {
    __testInternals.SESSION_MEMORY_CACHE.clear();
    rmSync(dir, { recursive: true, force: true });
  }
});
