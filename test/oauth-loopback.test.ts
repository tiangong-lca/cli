import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { CliError } from '../src/shared/errors.js';
import {
  __testInternals,
  OAUTH_LOGIN_TIMEOUT_MAX_MS,
  openSystemBrowser,
  receiveOAuthLoopbackCallback,
  requireOAuthLoopbackRedirectUri,
  type BrowserSpawn,
} from '../src/lib/auth/oauth-loopback.js';
import { loadDistModule } from './helpers/load-dist-module.js';

const STATE = 's'.repeat(43);

function expectCliCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CliError && error.code === code;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

function browserSpawnPlan(plan: { error?: Error; throw?: unknown; emitBoth?: boolean }) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  let unrefCalls = 0;
  const spawnImpl: BrowserSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (plan.throw !== undefined) throw plan.throw;
    const listeners: Partial<Record<'error' | 'spawn', (...args: never[]) => void>> = {};
    const child = {
      once(event: 'error' | 'spawn', listener: (...args: never[]) => void) {
        listeners[event] = listener;
        if (event === 'spawn') {
          queueMicrotask(() => {
            if (plan.error) listeners.error?.(plan.error as never);
            else listeners.spawn?.();
            if (plan.emitBoth) {
              if (plan.error) listeners.spawn?.();
              else listeners.error?.(new Error('late error') as never);
            }
          });
        }
        return child;
      },
      unref() {
        unrefCalls += 1;
      },
    };
    return child;
  };
  return {
    calls,
    get unrefCalls() {
      return unrefCalls;
    },
    spawnImpl,
  };
}

test('loopback redirect contract accepts one exact fixed-port URI', () => {
  assert.deepEqual(requireOAuthLoopbackRedirectUri('http://127.0.0.1:49191/oauth/callback'), {
    redirectUri: 'http://127.0.0.1:49191/oauth/callback',
    hostname: '127.0.0.1',
    port: 49191,
    pathname: '/oauth/callback',
  });
  for (const value of [
    'not-a-url',
    'https://127.0.0.1:49191/oauth/callback',
    'http://localhost:49191/oauth/callback',
    'http://user:pass@127.0.0.1:49191/oauth/callback',
    'http://127.0.0.1:49191/other',
    'http://127.0.0.1:49191/oauth/callback?x=1',
    'http://127.0.0.1:49191/oauth/callback#x',
    'http://127.0.0.1/oauth/callback',
    'http://127.0.0.1:80/oauth/callback',
  ]) {
    assert.throws(
      () => requireOAuthLoopbackRedirectUri(value),
      expectCliCode('OAUTH_REDIRECT_URI_INVALID'),
    );
  }
});

test('browser opener uses shell-free platform commands', async () => {
  const cases: Array<{ platform: NodeJS.Platform; command: string; args: string[] }> = [
    { platform: 'darwin', command: 'open', args: ['https://example.com/authorize'] },
    {
      platform: 'win32',
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'https://example.com/authorize'],
    },
    { platform: 'linux', command: 'xdg-open', args: ['https://example.com/authorize'] },
  ];
  for (const expected of cases) {
    const plan = browserSpawnPlan({ emitBoth: true });
    await openSystemBrowser('https://example.com/authorize', {
      platform: expected.platform,
      spawnImpl: plan.spawnImpl,
    });
    assert.deepEqual(plan.calls, [
      {
        command: expected.command,
        args: expected.args,
        options: { detached: true, shell: false, stdio: 'ignore' },
      },
    ]);
    assert.equal(plan.unrefCalls, 1);
  }
});

test('browser opener reports unsupported, thrown, and emitted failures', async () => {
  await assert.rejects(
    () =>
      openSystemBrowser('https://example.com', {
        platform: 'aix',
        spawnImpl: browserSpawnPlan({}).spawnImpl,
      }),
    expectCliCode('OAUTH_BROWSER_UNSUPPORTED'),
  );
  await assert.rejects(
    () =>
      openSystemBrowser('https://example.com', {
        platform: 'linux',
        spawnImpl: browserSpawnPlan({ throw: 'spawn failed' }).spawnImpl,
      }),
    expectCliCode('OAUTH_BROWSER_OPEN_FAILED'),
  );
  await assert.rejects(
    () =>
      openSystemBrowser('https://example.com', {
        platform: 'linux',
        spawnImpl: browserSpawnPlan({ throw: new Error('spawn failed') }).spawnImpl,
      }),
    expectCliCode('OAUTH_BROWSER_OPEN_FAILED'),
  );
  await assert.rejects(
    () =>
      openSystemBrowser('https://example.com', {
        platform: 'linux',
        spawnImpl: browserSpawnPlan({ error: new Error('not installed'), emitBoth: true })
          .spawnImpl,
      }),
    expectCliCode('OAUTH_BROWSER_OPEN_FAILED'),
  );
});

test('loopback callback ignores unrelated paths and accepts one state-bound code', async () => {
  const port = await freePort();
  const uri = redirectUri(port);
  const authorizationCode = await receiveOAuthLoopbackCallback({
    redirectUri: uri,
    expectedState: STATE,
    timeoutMs: 1000,
    onListening: async () => {
      const unrelated = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
      assert.equal(unrelated.status, 404);
      assert.equal(unrelated.headers.get('cache-control'), 'no-store');
      const accepted = await fetch(`${uri}?state=${STATE}&code=authorization-code`);
      assert.equal(accepted.status, 200);
      assert.match(await accepted.text(), /Authorization complete/u);
      assert.equal(
        accepted.headers.get('content-security-policy')?.includes("default-src 'none'"),
        true,
      );
      throw new Error('late authorization callback error must be ignored after success');
    },
  });
  assert.equal(authorizationCode, 'authorization-code');
});

test('loopback callback rejects state mismatches and sanitized authorization errors', async () => {
  for (const scenario of [
    {
      query: `state=${'x'.repeat(43)}&code=code`,
      code: 'OAUTH_STATE_MISMATCH',
    },
    {
      query: `state=${STATE}&state=${STATE}&code=code`,
      code: 'OAUTH_STATE_MISMATCH',
    },
    {
      query: `state=${STATE}&error=access_denied&error_description=do-not-log`,
      code: 'OAUTH_AUTHORIZATION_DENIED',
      details: { error: 'access_denied' },
    },
    {
      query: `state=${STATE}&error=BAD%20ERROR`,
      code: 'OAUTH_AUTHORIZATION_DENIED',
      details: { error: 'authorization_failed' },
    },
  ]) {
    const port = await freePort();
    const uri = redirectUri(port);
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: uri,
          expectedState: STATE,
          timeoutMs: 1000,
          onListening: async () => {
            const rejected = await fetch(`${uri}?${scenario.query}`);
            assert.equal(rejected.status, 400);
          },
        }),
      (error) =>
        error instanceof CliError &&
        error.code === scenario.code &&
        (scenario.details === undefined ||
          JSON.stringify(error.details) === JSON.stringify(scenario.details)),
    );
  }
});

test('loopback callback requires one bounded authorization code', async () => {
  for (const query of [
    `state=${STATE}`,
    `state=${STATE}&code=`,
    `state=${STATE}&code=one&code=two`,
    `state=${STATE}&code=${'x'.repeat(4097)}`,
  ]) {
    const port = await freePort();
    const uri = redirectUri(port);
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: uri,
          expectedState: STATE,
          timeoutMs: 1000,
          onListening: async () => {
            const rejected = await fetch(`${uri}?${query}`);
            assert.equal(rejected.status, 400);
          },
        }),
      expectCliCode('OAUTH_AUTHORIZATION_CODE_INVALID'),
    );
  }
});

test('loopback callback validates state and timeout before binding', async () => {
  for (const expectedState of ['', 'short', 'x'.repeat(129)]) {
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: 'http://127.0.0.1:49191/oauth/callback',
          expectedState,
          timeoutMs: 100,
          onListening: () => undefined,
        }),
      expectCliCode('OAUTH_STATE_INVALID'),
    );
  }
  for (const timeoutMs of [0, 1.5, OAUTH_LOGIN_TIMEOUT_MAX_MS + 1]) {
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: 'http://127.0.0.1:49191/oauth/callback',
          expectedState: STATE,
          timeoutMs,
          onListening: () => undefined,
        }),
      expectCliCode('OAUTH_LOGIN_TIMEOUT_INVALID'),
    );
  }
});

test('loopback callback handles timeout and authorization-start errors', async () => {
  const timeoutPort = await freePort();
  await assert.rejects(
    () =>
      receiveOAuthLoopbackCallback({
        redirectUri: redirectUri(timeoutPort),
        expectedState: STATE,
        timeoutMs: 5,
        onListening: () => undefined,
      }),
    expectCliCode('OAUTH_LOGIN_TIMEOUT'),
  );

  for (const error of [
    new CliError('browser failed', { code: 'CUSTOM_BROWSER_ERROR', exitCode: 1 }),
    new Error('ordinary failure'),
    'non-error failure',
  ]) {
    const port = await freePort();
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: redirectUri(port),
          expectedState: STATE,
          timeoutMs: 100,
          onListening: () => {
            throw error;
          },
        }),
      expectCliCode(
        error instanceof CliError ? 'CUSTOM_BROWSER_ERROR' : 'OAUTH_AUTHORIZATION_START_FAILED',
      ),
    );
  }
});

test('loopback callback reports an occupied fixed port', async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  let listeningCalls = 0;
  try {
    await assert.rejects(
      () =>
        receiveOAuthLoopbackCallback({
          redirectUri: redirectUri(port),
          expectedState: STATE,
          timeoutMs: 100,
          onListening: () => {
            listeningCalls += 1;
          },
        }),
      expectCliCode('OAUTH_LOOPBACK_BIND_FAILED'),
    );
    assert.equal(listeningCalls, 0);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('constant-time state helper covers equal, unequal, and length-mismatch inputs', () => {
  assert.equal(__testInternals.safeStateEqual(STATE, STATE), true);
  assert.equal(__testInternals.safeStateEqual('x'.repeat(43), STATE), false);
  assert.equal(__testInternals.safeStateEqual('short', STATE), false);
  assert.equal(__testInternals.trimString(null), '');
  assert.equal(__testInternals.trimString(' value '), 'value');
  const error = __testInternals.callbackError('message', 'CODE');
  assert.equal(error.code, 'CODE');
});

test('OAuth loopback redirect validation behaves identically from the built runtime', async () => {
  const built = await loadDistModule<typeof import('../src/lib/auth/oauth-loopback.js')>(
    'src/lib/auth/oauth-loopback.js',
  );
  assert.equal(
    built.requireOAuthLoopbackRedirectUri('http://127.0.0.1:49191/oauth/callback').port,
    49191,
  );
});
