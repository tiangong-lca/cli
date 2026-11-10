import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResponseLike } from '../src/lib/transport/http.js';
import {
  AUTH_IDENTITY_RECEIPT_SCHEMA,
  __testInternals as receiptInternals,
  parseAuthIdentityReceipt,
  runAuthIdentityReceipt,
  type AuthIdentityReceipt,
} from '../src/lib/auth/auth-identity-receipt.js';
import {
  __testInternals as sessionInternals,
  type ResolvedSupabaseUserSession,
} from '../src/lib/auth/supabase-session.js';

const NOW = new Date('2026-08-25T12:34:56.000Z');
const SENSITIVE_SENTINEL = 'identity-sensitive-sentinel';
const ACCESS_TOKEN_SECRET = 'identity-access-token';
const PUBLISHABLE_KEY_SECRET = 'identity-publishable-key';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function response(status: number, body: unknown, contentType = 'application/json'): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async text(): Promise<string> {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function runtimeEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    TIANGONG_LCA_API_BASE_URL: 'https://project-ref.supabase.co/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY_SECRET,
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: ACCESS_TOKEN_SECRET,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
    ...overrides,
  };
}

function resolvedSession(
  overrides: Partial<ResolvedSupabaseUserSession> = {},
): ResolvedSupabaseUserSession {
  return {
    accessToken: ACCESS_TOKEN_SECRET,
    refreshToken: 'identity-refresh-token',
    expiresAt: 4_102_444_800,
    userEmail: 'user@example.com',
    projectBaseUrl: 'https://project-ref.supabase.co',
    sessionFile: null,
    authMethod: 'access_token',
    source: 'access_token',
    ...overrides,
  };
}

async function successfulReceipt(
  overrides: Partial<Parameters<typeof runAuthIdentityReceipt>[0]> = {},
): Promise<AuthIdentityReceipt> {
  return runAuthIdentityReceipt({
    env: runtimeEnv(),
    fetchImpl: async () =>
      response(200, {
        email: 'user@example.com',
        id: '11111111-1111-4111-8111-111111111111',
        ignored_unbounded_profile: { role: 'never-copied-to-receipt' },
      }),
    cliVersion: '0.1.1-test',
    expectedProjectRef: 'project-ref',
    expectedUserId: '11111111-1111-4111-8111-111111111111',
    timeoutMs: 5_000,
    now: NOW,
    resolveSessionImpl: async () => resolvedSession(),
    ...overrides,
  });
}

function rehashReceipt(value: AuthIdentityReceipt): AuthIdentityReceipt {
  const { receipt_scope_sha256: _receiptScopeSha256, ...scope } = value;
  return {
    ...value,
    receipt_scope_sha256: receiptInternals.sha256Json(scope),
  };
}

test('identity receipt binds a server-verified account/project without exposing credentials', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const receipt = await successfulReceipt({
    fetchImpl: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return response(200, {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'USER@example.com',
        app_metadata: { provider: 'email' },
      });
    },
  });

  assert.equal(capturedUrl, 'https://project-ref.supabase.co/auth/v1/user');
  assert.equal(capturedInit?.method, 'GET');
  assert.equal(capturedInit?.redirect, 'error');
  assert.equal(receipt.schema, AUTH_IDENTITY_RECEIPT_SCHEMA);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.operation, 'current-user-read');
  assert.equal(receipt.remote_write_mode, 'read-only');
  assert.equal(receipt.captured_at_utc, NOW.toISOString());
  assert.deepEqual(receipt.cli, {
    package_name: '@tiangong-lca/cli',
    package_version: '0.1.1-test',
  });
  assert.deepEqual(receipt.project, {
    project_ref: 'project-ref',
    project_base_url: 'https://project-ref.supabase.co',
  });
  assert.equal(receipt.identity.user_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(receipt.identity.display_email, 'us****@example.com');
  assert.deepEqual(receipt.session, {
    source: 'access_token',
    cache_mode: 'disabled',
    force_reauth: false,
    expires_at_utc: '2100-01-01T00:00:00.000Z',
  });
  assert.match(receipt.bindings.request_sha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.bindings.response_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(receipt.assertions, {
    mode: 'intent-bound',
    requested_count: 2,
    expected_project_ref: 'project-ref',
    expected_user_id: '11111111-1111-4111-8111-111111111111',
    project_ref_passed: true,
    user_id_passed: true,
    passed: true,
  });
  assert.match(receipt.receipt_scope_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(parseAuthIdentityReceipt(receipt), receipt);

  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(
    serialized,
    /user_api_key_fingerprint|publishable_key_fingerprint|email_fingerprint|session_file/u,
  );
  for (const secret of [
    SENSITIVE_SENTINEL,
    ACCESS_TOKEN_SECRET,
    PUBLISHABLE_KEY_SECRET,
    'identity-refresh-token',
    'never-copied-to-receipt',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  }
});

test('identity receipt binds OAuth and explicit headless sessions', async () => {
  for (const authMode of ['oauth', 'access-token'] as const) {
    const oauth = authMode === 'oauth';
    const receipt = await runAuthIdentityReceipt({
      env: runtimeEnv({
        TIANGONG_LCA_AUTH_MODE: authMode,
        TIANGONG_LCA_OAUTH_CLIENT_ID: oauth ? '123e4567-e89b-42d3-a456-426614174000' : undefined,
        TIANGONG_LCA_ACCESS_TOKEN: oauth ? undefined : ACCESS_TOKEN_SECRET,
      }),
      fetchImpl: async () => response(200, { id: USER_ID, email: 'user@example.com' }),
      cliVersion: '0.1.3-test',
      now: NOW,
      resolveSessionImpl: async () =>
        resolvedSession({
          authMethod: oauth ? 'oauth' : 'access_token',
          source: oauth ? 'refresh' : 'access_token',
        }),
    });
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.session.source, oauth ? 'refresh' : 'access_token');
    assert.equal(receipt.session.cache_mode, 'disabled');
  }
});

test('identity receipt canonicalization is deterministic and binds bounded request/response facts', async () => {
  assert.deepEqual(
    Object.keys(
      receiptInternals.stableJsonValue({ a_: 1, 'a-': 2, a: 3, A: 4 }) as Record<string, unknown>,
    ),
    ['A', 'a', 'a-', 'a_'],
  );
  const first = await successfulReceipt();
  const second = await successfulReceipt({
    fetchImpl: async () =>
      response(200, {
        ignored: ['different', 'unbounded', 'profile'],
        email: 'USER@EXAMPLE.COM',
        id: '11111111-1111-4111-8111-111111111111',
      }),
  });

  assert.deepEqual(second, first);

  const changedToken = await successfulReceipt({
    resolveSessionImpl: async () => resolvedSession({ accessToken: 'different-access-token' }),
  });
  assert.deepEqual(changedToken, first);
});

test('identity receipt default wiring verifies the headless token and performs the live read', async () => {
  let currentUserCalls = 0;
  try {
    const receipt = await runAuthIdentityReceipt({
      env: runtimeEnv({ TIANGONG_LCA_FORCE_REAUTH: 'true' }),
      fetchImpl: async (url) => {
        assert.equal(url, 'https://project-ref.supabase.co/auth/v1/user');
        currentUserCalls += 1;
        return currentUserCalls === 1
          ? response(200, {
              user: {
                id: '11111111-1111-4111-8111-111111111111',
                email: 'user@example.com',
                role: 'authenticated',
              },
            })
          : response(200, {
              id: '11111111-1111-4111-8111-111111111111',
              email: 'user@example.com',
            });
      },
      cliVersion: '0.1.1-test',
      expectedProjectRef: 'project-ref',
      expectedUserId: '11111111-1111-4111-8111-111111111111',
      now: NOW,
    });

    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.session.source, 'access_token');
    assert.equal(currentUserCalls, 2);
  } finally {
    sessionInternals.SESSION_MEMORY_CACHE.clear();
    sessionInternals.SESSION_OPERATION_CHAINS.clear();
  }
});

test('identity receipt default wiring retries one unauthorized live read', async () => {
  sessionInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
  sessionInternals.SESSION_OPERATION_CHAINS.clear();
  let currentUserCalls = 0;
  try {
    const receipt = await runAuthIdentityReceipt({
      env: runtimeEnv(),
      fetchImpl: async (url) => {
        assert.equal(url, 'https://project-ref.supabase.co/auth/v1/user');
        currentUserCalls += 1;
        if (currentUserCalls === 1) {
          return response(200, {
            user: {
              id: USER_ID,
              email: 'user@example.com',
              role: 'authenticated',
            },
          });
        }
        return currentUserCalls === 2
          ? response(401, { message: 'expired' })
          : response(200, { id: USER_ID, email: 'user@example.com' });
      },
      cliVersion: '0.1.1-test',
      expectedProjectRef: 'project-ref',
      expectedUserId: USER_ID,
      now: NOW,
    });

    assert.equal(receipt.status, 'passed');
    assert.equal(currentUserCalls, 3);
  } finally {
    sessionInternals.ACCESS_TOKEN_MEMORY_CACHE.clear();
    sessionInternals.SESSION_OPERATION_CHAINS.clear();
  }
});

test('identity receipt refreshes once after an unauthorized live lookup and never loops', async () => {
  const forceRefreshValues: Array<boolean | undefined> = [];
  let fetchCalls = 0;
  const receipt = await successfulReceipt({
    resolveSessionImpl: async (options) => {
      forceRefreshValues.push(options.forceRefresh);
      return options.forceRefresh
        ? resolvedSession({ source: 'refresh', accessToken: 'fresh-access-token' })
        : resolvedSession({
            source: 'cache',
            accessToken: 'stale-access-token',
            expiresAt: 4_102_444_800,
          });
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? response(401, { message: 'expired' })
        : response(200, {
            id: '11111111-1111-4111-8111-111111111111',
            email: 'user@example.com',
          });
    },
  });
  assert.deepEqual(forceRefreshValues, [undefined, true]);
  assert.equal(fetchCalls, 2);
  assert.equal(receipt.session.source, 'refresh');

  fetchCalls = 0;
  forceRefreshValues.length = 0;
  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async (options) => {
        forceRefreshValues.push(options.forceRefresh);
        return options.forceRefresh
          ? resolvedSession({ source: 'refresh', accessToken: 'fresh-access-token' })
          : resolvedSession({ source: 'cache', expiresAt: 4_102_444_800 });
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return response(403, { message: 'still forbidden' });
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
  );
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => ({
        ...response(200, {}),
        async text(): Promise<string> {
          throw 'non-error read failure';
        },
      }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
  );
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => ({
        ...response(200, {}),
        headers: { get: () => null },
      }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_REMOTE_INVALID_JSON',
  );
  assert.deepEqual(forceRefreshValues, [undefined, true]);
  assert.equal(fetchCalls, 2);
});

test('identity receipt records cache modes without exposing a session path', async () => {
  const custom = await successfulReceipt({
    env: runtimeEnv({
      TIANGONG_LCA_AUTH_MODE: 'oauth',
      TIANGONG_LCA_ACCESS_TOKEN: undefined,
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: 'false',
      TIANGONG_LCA_SESSION_FILE: '/private/account/session.json',
    }),
    resolveSessionImpl: async () =>
      resolvedSession({
        authMethod: 'oauth',
        source: 'cache',
        sessionFile: '/private/account/session.json',
      }),
  });
  assert.equal(custom.session.cache_mode, 'custom-file');
  assert.doesNotMatch(JSON.stringify(custom), /private\/account/u);

  const platformDefault = await successfulReceipt({
    env: runtimeEnv({
      TIANGONG_LCA_AUTH_MODE: 'oauth',
      TIANGONG_LCA_ACCESS_TOKEN: undefined,
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: 'false',
      TIANGONG_LCA_SESSION_FILE: '',
      TIANGONG_LCA_FORCE_REAUTH: 'true',
    }),
    resolveSessionImpl: async () =>
      resolvedSession({
        authMethod: 'oauth',
        source: 'refresh',
        sessionFile: '/platform/default/session.json',
        expiresAt: null,
      }),
  });
  assert.equal(platformDefault.session.cache_mode, 'platform-default');
  assert.equal(platformDefault.session.force_reauth, true);
  assert.equal(platformDefault.session.expires_at_utc, null);
});

test('identity receipt labels observation-only and partial assertions without implying intent binding', async () => {
  const observed = await successfulReceipt({
    expectedProjectRef: undefined,
    expectedUserId: undefined,
  });
  assert.deepEqual(observed.assertions, {
    mode: 'observed',
    requested_count: 0,
    expected_project_ref: null,
    expected_user_id: null,
    project_ref_passed: null,
    user_id_passed: null,
    passed: true,
  });

  const partial = await successfulReceipt({ expectedUserId: undefined });
  assert.equal(partial.assertions.mode, 'partial');
  assert.equal(partial.assertions.requested_count, 1);
  assert.equal(partial.assertions.project_ref_passed, true);
  assert.equal(partial.assertions.user_id_passed, null);
});

test('identity receipt fails closed on expected project or user mismatch before returning a receipt', async () => {
  await assert.rejects(
    successfulReceipt({ expectedProjectRef: 'foreign-project' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_PROJECT_MISMATCH',
  );
  await assert.rejects(
    successfulReceipt({ expectedUserId: '22222222-2222-4222-8222-222222222222' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_USER_MISMATCH',
  );
});

test('identity receipt rejects stale or foreign cached identity bindings', async () => {
  const invalidSessions: ResolvedSupabaseUserSession[] = [
    resolvedSession({ userEmail: 'foreign@example.com' }),
    resolvedSession({ userEmail: 'not-an-email' }),
    resolvedSession({ accessToken: '   ' }),
    resolvedSession({ projectBaseUrl: 'https://foreign.supabase.co' }),
    resolvedSession({ source: 'cache', expiresAt: Math.floor(NOW.getTime() / 1000) + 299 }),
    resolvedSession({ source: 'memory', expiresAt: null }),
    resolvedSession({ source: 'unknown' as never }),
  ];

  for (const session of invalidSessions) {
    await assert.rejects(
      successfulReceipt({ resolveSessionImpl: async () => session }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
    );
  }

  await assert.rejects(
    successfulReceipt({
      env: runtimeEnv({
        TIANGONG_LCA_DISABLE_SESSION_CACHE: 'false',
        TIANGONG_LCA_SESSION_FILE: '/expected/session.json',
      }),
      resolveSessionImpl: async () => resolvedSession({ sessionFile: '/foreign/session.json' }),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
  );

  await assert.rejects(
    successfulReceipt({
      env: runtimeEnv({
        TIANGONG_LCA_DISABLE_SESSION_CACHE: 'false',
        TIANGONG_LCA_FORCE_REAUTH: 'true',
      }),
      resolveSessionImpl: async () =>
        resolvedSession({
          source: 'cache',
          sessionFile: '/platform/session.json',
        }),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
  );
});

test('identity receipt rejects nonzero, malformed, ok:false, oversized, and incomplete responses', async () => {
  const cases: Array<[string, ResponseLike, string]> = [
    [
      'nonzero',
      response(503, { secret: SENSITIVE_SENTINEL }),
      'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
    ],
    ['invalid-json', response(200, '{broken'), 'AUTH_IDENTITY_REMOTE_INVALID_JSON'],
    [
      'wrong-content-type',
      response(200, { id: 'user-id', email: 'user@example.com' }, 'text/plain'),
      'AUTH_IDENTITY_REMOTE_INVALID_JSON',
    ],
    [
      'ok-false',
      response(200, { ok: false, token: ACCESS_TOKEN_SECRET }),
      'AUTH_IDENTITY_REMOTE_REJECTED',
    ],
    ['array', response(200, []), 'AUTH_IDENTITY_RESPONSE_INVALID'],
    ['missing-id', response(200, { email: 'user@example.com' }), 'AUTH_IDENTITY_RESPONSE_INVALID'],
    ['missing-email', response(200, { id: 'user-id' }), 'AUTH_IDENTITY_RESPONSE_INVALID'],
    [
      'invalid-user-id',
      response(200, { id: 'not-a-uuid', email: 'user@example.com' }),
      'AUTH_IDENTITY_RESPONSE_INVALID',
    ],
    [
      'oversized',
      response(
        200,
        JSON.stringify({ id: 'user-id', email: 'user@example.com', pad: 'x'.repeat(70_000) }),
      ),
      'AUTH_IDENTITY_RESPONSE_TOO_LARGE',
    ],
  ];

  for (const [name, currentUserResponse, code] of cases) {
    await assert.rejects(
      successfulReceipt({ fetchImpl: async () => currentUserResponse }),
      (error: unknown) => {
        assert.ok(error instanceof Error, name);
        assert.equal('code' in error ? error.code : null, code, name);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(SENSITIVE_SENTINEL, 'u'), name);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(ACCESS_TOKEN_SECRET, 'u'), name);
        return true;
      },
    );
  }

  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => ({
        ...response(200, {}),
        async text(): Promise<string> {
          throw new Error(`body read included ${SENSITIVE_SENTINEL}`);
        },
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SENSITIVE_SENTINEL, 'u'));
      return true;
    },
  );
});

test('identity receipt enforces the response byte limit before unbounded buffering', async () => {
  let contentLengthReads = 0;
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === 'content-length' ? '70000' : 'application/json';
          },
        },
        async text(): Promise<string> {
          contentLengthReads += 1;
          return JSON.stringify({ id: USER_ID, email: 'user@example.com' });
        },
      }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_RESPONSE_TOO_LARGE',
  );
  assert.equal(contentLengthReads, 0);

  let streamingPulls = 0;
  let streamingCancelled = false;
  const streamingBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      streamingPulls += 1;
      if (streamingPulls <= 10) {
        controller.enqueue(new Uint8Array(16 * 1024));
      } else {
        controller.close();
      }
    },
    cancel() {
      streamingCancelled = true;
      throw new Error('simulated cancellation failure');
    },
  });
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () =>
        new Response(streamingBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_RESPONSE_TOO_LARGE',
  );
  assert.ok(streamingPulls <= 6, `stream pulls must stop at the byte limit, got ${streamingPulls}`);
  assert.equal(streamingCancelled, true);

  const streamedSuccess = await successfulReceipt({
    fetchImpl: async () =>
      new Response(JSON.stringify({ id: USER_ID, email: 'user@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  assert.equal(streamedSuccess.identity.user_id, USER_ID);
});

test('identity receipt sanitizes transport and session-resolution failures', async () => {
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => {
        throw new Error(`transport included ${SENSITIVE_SENTINEL} and ${ACCESS_TOKEN_SECRET}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SENSITIVE_SENTINEL, 'u'));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(ACCESS_TOKEN_SECRET, 'u'));
      return true;
    },
  );

  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => Promise.reject('non-error transport secret'),
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
  );

  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async () => {
        const error = new Error(`session included ${SENSITIVE_SENTINEL}`) as Error & {
          code: string;
        };
        error.code = 'SIMULATED_SESSION_FAILURE';
        throw error;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_SESSION_FAILED');
      assert.match(JSON.stringify(error), /SIMULATED_SESSION_FAILURE/u);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(SENSITIVE_SENTINEL, 'u'));
      return true;
    },
  );

  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async () => {
        throw new Error('unexpected session failure');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_SESSION_FAILED');
      assert.match(JSON.stringify(error), /UNEXPECTED_SESSION_FAILURE/u);
      return true;
    },
  );

  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async () => {
        throw new (await import('../src/shared/errors.js')).CliError('safe', {
          code: 'KNOWN_SESSION_FAILURE',
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_SESSION_FAILED');
      assert.match(JSON.stringify(error), /KNOWN_SESSION_FAILURE/u);
      return true;
    },
  );
});

test('identity receipt validates runtime options and current-user email consistency', async () => {
  await assert.rejects(
    successfulReceipt({ timeoutMs: 0 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_TIMEOUT_INVALID',
  );
  await assert.rejects(
    successfulReceipt({ timeoutMs: 2_147_483_648 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_TIMEOUT_INVALID',
  );
  await assert.rejects(
    successfulReceipt({ cliVersion: '   ' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_VERSION_INVALID',
  );
  await assert.rejects(
    successfulReceipt({ now: new Date(Number.NaN) }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_CAPTURE_TIME_INVALID',
  );
  await assert.rejects(
    successfulReceipt({
      env: runtimeEnv({ TIANGONG_LCA_API_BASE_URL: 'https://custom.example.com/functions/v1' }),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_PROJECT_INVALID',
  );
  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async () => resolvedSession({ expiresAt: Number.POSITIVE_INFINITY }),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
  );
  await assert.rejects(
    successfulReceipt({
      resolveSessionImpl: async () => resolvedSession({ expiresAt: 1e20 }),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
  );
  const defaultTimeout = await successfulReceipt({ timeoutMs: undefined });
  assert.equal(defaultTimeout.status, 'passed');
  const defaultNow = await successfulReceipt({ now: undefined });
  assert.equal(defaultNow.status, 'passed');
  await assert.rejects(
    successfulReceipt({ expectedProjectRef: '   ' }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_EXPECTATION_INVALID',
  );
  await assert.rejects(
    successfulReceipt({ expectedUserId: '   ' }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_EXPECTATION_INVALID',
  );
  await assert.rejects(
    successfulReceipt({ expectedUserId: 'not-a-uuid' }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'AUTH_IDENTITY_EXPECTATION_INVALID',
  );
  let unsafeUrlSessionCalls = 0;
  await assert.rejects(
    successfulReceipt({
      env: runtimeEnv({
        TIANGONG_LCA_API_BASE_URL:
          'https://project-ref.supabase.co/functions/v1/unsafe?token=URL_SECRET_SENTINEL',
      }),
      resolveSessionImpl: async () => {
        unsafeUrlSessionCalls += 1;
        return resolvedSession();
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal('code' in error ? error.code : null, 'AUTH_IDENTITY_PROJECT_INVALID');
      assert.doesNotMatch(JSON.stringify(error), /URL_SECRET_SENTINEL/u);
      return true;
    },
  );
  assert.equal(unsafeUrlSessionCalls, 0);
  await assert.rejects(
    successfulReceipt({
      fetchImpl: async () => response(200, { id: USER_ID, email: 'other@example.com' }),
      expectedUserId: undefined,
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_SESSION_MISMATCH',
  );
});

test('identity receipt parser rejects schema drift and canonical hash tampering', async () => {
  const receipt = await successfulReceipt();
  const invalidValues: unknown[] = [
    null,
    { ...receipt, schema: 'old' },
    { ...receipt, status: 'failed' },
    { ...receipt, operation: 'write' },
    { ...receipt, remote_write_mode: 'read-write' },
    { ...receipt, captured_at_utc: 'not-a-timestamp' },
    { ...receipt, captured_at_utc: null },
    { ...receipt, cli: { ...receipt.cli, package_name: '' } },
    { ...receipt, project: { ...receipt.project, project_ref: '' } },
    { ...receipt, project: { ...receipt.project, project_base_url: null } },
    { ...receipt, project: { ...receipt.project, project_base_url: ' ' } },
    { ...receipt, project: { ...receipt.project, project_base_url: 'not-a-url' } },
    { ...receipt, identity: { ...receipt.identity, user_id: '' } },
    rehashReceipt({
      ...receipt,
      identity: { ...receipt.identity, user_id: 'not-a-uuid' },
    }),
    { ...receipt, session: { ...receipt.session, source: 'unknown' } },
    { ...receipt, bindings: { ...receipt.bindings, request_sha256: 'bad' } },
    { ...receipt, assertions: { ...receipt.assertions, passed: false } },
    { ...receipt, receipt_scope_sha256: '0'.repeat(64) },
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => parseAuthIdentityReceipt(value),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'AUTH_IDENTITY_RECEIPT_INVALID',
    );
  }
});
