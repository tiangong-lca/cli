import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import {
  selectLoopbackAuthDiagnostic,
  runLoopbackAuthDiagnostic,
} from '../src/lib/study/transport.js';
import { AUTH_IDENTITY_MAX_TIMEOUT_MS } from '../src/lib/auth/auth-identity-receipt.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const ACTOR = '11111111-1111-4111-8111-111111111111',
  OTHER = '22222222-2222-4222-8222-222222222222',
  CLIENT = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'http://127.0.0.1:56431',
  CALLBACK = 'http://127.0.0.1:49192/oauth/callback';
function token(actor = ACTOR, client: string | null = CLIENT) {
  return `header.${Buffer.from(JSON.stringify({ sub: actor, ...(client ? { client_id: client } : {}) })).toString('base64url')}.synthetic-signature`;
}
function oauth(access = token()) {
  return buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: ORIGIN,
    TIANGONG_LCA_OAUTH_CLIENT_ID: CLIENT,
    TIANGONG_LCA_OAUTH_REDIRECT_URI: CALLBACK,
    TIANGONG_LCA_ACCESS_TOKEN: access,
  });
}
function actorReader(actor = ACTOR) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    assert.equal(url, `${ORIGIN}/auth/v1/user`);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    return new Response(
      JSON.stringify({ id: actor, email: 'private-person@example.test', role: 'authenticated' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { calls, fetchImpl };
}
function invoke(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  args = ['auth', 'doctor-auth', '--json'],
) {
  return executeCli(args, {
    env,
    fetchImpl,
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
  });
}

test('Explicit OAuth loopback doctor verifies the exact live actor/client and current callback without a production receipt', async () => {
  const env = oauth(),
    reader = actorReader();
  const result = await invoke(env, reader.fetchImpl);
  assert.equal(result.exitCode, 0, result.stderr);
  const value = JSON.parse(result.stdout).data.receipt;
  assert.equal(value.schemaVersion, 'tiangong.cli-loopback-auth-doctor.v1');
  assert.equal(value.scope, 'explicit-loopback');
  assert.equal(value.status, 'passed');
  assert.deepEqual(value.live, {
    schemaVersion: 'tiangong.cli-loopback-identity.v1',
    origin: ORIGIN,
    actorId: ACTOR,
    clientId: CLIENT,
    callbackUri: CALLBACK,
    authMethod: 'oauth',
    onlineVerified: true,
  });
  assert(reader.calls.length >= 1);
  for (const secret of [
    token(),
    'private-person@example.test',
    env.TIANGONG_LCA_SESSION_FILE!,
    'refresh-token',
    'project_ref',
    'receipt_scope_sha256',
    'intent-bound',
  ])
    assert(!result.stdout.includes(secret), secret);
  for (const action of ['identity-receipt', 'whoami']) {
    const count = reader.calls.length;
    const refused = await invoke(env, reader.fetchImpl, ['auth', action, '--json']);
    assert.equal(refused.exitCode, 2);
    assert.equal(JSON.parse(refused.stdout).error.code, 'AUTH_IDENTITY_PROJECT_INVALID');
    assert.equal(reader.calls.length, count);
  }
});

test('Loopback tuple selection refuses incomplete configuration and never becomes a production failure fallback', async () => {
  for (const base of [
    undefined,
    '',
    'not-a-url',
    'ftp://127.0.0.1:56431',
    'https://example.supabase.co',
    'http://192.0.2.1:56431',
  ])
    assert.equal(selectLoopbackAuthDiagnostic({ TIANGONG_LCA_API_BASE_URL: base }), null);
  const env = oauth();
  const noFetch: FetchLike = async () => {
    throw new Error('must not fetch');
  };
  for (const [configured, code] of [
    [{ ...env, TIANGONG_LCA_OAUTH_REDIRECT_URI: '' }, 'AUTH_LOOPBACK_CALLBACK_REQUIRED'],
    [
      { ...env, TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://localhost:49192/oauth/callback' },
      'OAUTH_REDIRECT_URI_INVALID',
    ],
    [{ ...env, TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: '' }, 'SUPABASE_REST_ENV_REQUIRED'],
    [{ ...env, TIANGONG_LCA_API_BASE_URL: `${ORIGIN}/foreign` }, 'STUDY_DESTINATION_INVALID'],
  ] as const) {
    const result = await invoke(configured, noFetch);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
  const otherOrigin = await invoke(
    { ...env, TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56432' },
    noFetch,
  );
  const otherClient = await invoke({ ...env, TIANGONG_LCA_OAUTH_CLIENT_ID: OTHER }, noFetch);
  for (const result of [otherOrigin, otherClient]) {
    assert.equal(result.exitCode, 1);
    const value = JSON.parse(result.stdout).data.receipt;
    assert.equal(value.schemaVersion, 'tiangong.cli-loopback-auth-doctor.v1');
    assert.equal(value.status, 'login-required');
    assert.equal(value.live, null);
  }
});

test('Live actor/client disagreement, revoked user, redirect and oversized responses never pass local doctor', async () => {
  for (const [env, fetchImpl] of [
    [oauth(token(OTHER)), actorReader().fetchImpl],
    [oauth(token(ACTOR, OTHER)), actorReader().fetchImpl],
    [oauth(), async () => new Response('private provider text', { status: 401 })],
    [
      oauth(),
      async () =>
        new Response(null, { status: 302, headers: { Location: 'https://foreign.example.test' } }),
    ],
    [
      oauth(),
      async () =>
        new Response('x'.repeat(65 * 1024), { headers: { 'Content-Type': 'application/json' } }),
    ],
  ] as Array<[NodeJS.ProcessEnv, FetchLike]>) {
    const result = await invoke(env, fetchImpl);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_LOOPBACK_DIAGNOSTIC_FAILED');
    assert(!result.stderr.includes('private provider text'));
  }
});

test('Headless loopback diagnosis stays read-only and reports actual public client metadata without OAuth history', async () => {
  const env = {
    TIANGONG_LCA_API_BASE_URL: ORIGIN,
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
    TIANGONG_LCA_ACCESS_TOKEN: token(ACTOR, null),
  };
  const reader = actorReader(),
    result = await invoke(env, reader.fetchImpl);
  assert.equal(result.exitCode, 0, result.stderr);
  const value = JSON.parse(result.stdout).data.receipt;
  assert.equal(value.live.clientId, null);
  assert.equal(value.live.callbackUri, null);
  assert.equal(value.live.authMethod, 'access_token');
  const selection = selectLoopbackAuthDiagnostic(env)!;
  for (const timeoutMs of [0, NaN, AUTH_IDENTITY_MAX_TIMEOUT_MS + 1])
    await assert.rejects(
      runLoopbackAuthDiagnostic(selection, { fetchImpl: reader.fetchImpl, timeoutMs }),
      (error: unknown) => error instanceof CliError && error.code === 'INVALID_ARGS',
    );
  const direct = await runLoopbackAuthDiagnostic(selection, { fetchImpl: reader.fetchImpl });
  assert.equal(direct.actorId, ACTOR);
  const stalled = await invoke(env, () => new Promise(() => {}), [
    'auth',
    'doctor-auth',
    '--timeout-ms',
    '15',
    '--json',
  ]);
  assert.equal(stalled.exitCode, 1);
  assert.equal(JSON.parse(stalled.stdout).error.code, 'AUTH_LOOPBACK_DIAGNOSTIC_FAILED');
});
