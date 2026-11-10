import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli, type CliDeps } from '../src/cli.js';
import { buildDoctorReport, readRuntimeEnv } from '../src/lib/env.js';
import { CliError } from '../src/shared/errors.js';
import { requireSupabaseRestRuntime } from '../src/lib/supabase-client.js';
import { loginWithSupabaseOAuth } from '../src/lib/supabase-session.js';

const PROJECT = 'https://qgzvkongdjqiiamzbbts.supabase.co';
const CLIENT = '1837c6d3-3c9d-48e0-bbf7-b532b78f9f76';
const KEY = 'sb_publishable_EFWH4E61tpAtf82WQ37xTA_Fxa5OPyg';
const CALLBACK = 'http://127.0.0.1:49191/oauth/callback';
const USER = '223e4567-e89b-42d3-a456-426614174000';
const dotEnvStatus = { loaded: false, path: '/not-loaded/.env', count: 0 };

test('an empty installation resolves one complete official Production OAuth profile', () => {
  const env = Object.freeze({});
  assert.deepEqual(requireSupabaseRestRuntime(env), {
    apiBaseUrl: `${PROJECT}/functions/v1`,
    authMode: 'oauth',
    oauthClientId: CLIENT,
    oauthRedirectUri: CALLBACK,
    accessToken: null,
    publishableKey: KEY,
    sessionFile: null,
    disableSessionCache: false,
    forceReauth: false,
  });
  assert.deepEqual(env, {});
  const doctor = buildDoctorReport(env, dotEnvStatus);
  assert.equal(doctor.ok, true);
  for (const key of [
    'TIANGONG_LCA_API_BASE_URL',
    'TIANGONG_LCA_OAUTH_CLIENT_ID',
    'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
  ]) {
    assert.equal(doctor.checks.find((check) => check.key === key)?.source, 'default');
  }
});

test('official endpoint aliases and blank example values share the bundled profile', () => {
  for (const base of [PROJECT, `${PROJECT}/`, `${PROJECT}/rest/v1`, `${PROJECT}/functions/v1/`]) {
    const runtime = requireSupabaseRestRuntime({
      TIANGONG_LCA_API_BASE_URL: ` ${base} `,
      TIANGONG_LCA_AUTH_MODE: 'oauth',
      TIANGONG_LCA_OAUTH_CLIENT_ID: ' ',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: '',
    });
    assert.equal(runtime.oauthClientId, CLIENT);
    assert.equal(runtime.publishableKey, KEY);
    assert.equal(runtime.oauthRedirectUri, CALLBACK);
  }
  assert.equal(
    requireSupabaseRestRuntime({ TIANGONG_LCA_OAUTH_CLIENT_ID: CLIENT.toUpperCase() })
      .oauthClientId,
    CLIENT,
  );
});

test('explicit Production identifiers cannot be paired with a different project', () => {
  for (const extra of [
    { TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: KEY, TIANGONG_LCA_OAUTH_CLIENT_ID: USER },
    { TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'custom-key', TIANGONG_LCA_OAUTH_CLIENT_ID: CLIENT },
  ]) {
    const env = { TIANGONG_LCA_API_BASE_URL: 'https://dev.supabase.co', ...extra };
    assert.throws(
      () => requireSupabaseRestRuntime(env),
      (error) => error instanceof CliError && error.code === 'SUPABASE_RUNTIME_PROFILE_MISMATCH',
    );
    assert.equal(buildDoctorReport(env, dotEnvStatus).ok, false);
  }
});

test('partial custom endpoints, identities, callbacks, and headless tokens never inherit Production', () => {
  for (const env of [
    { TIANGONG_LCA_API_BASE_URL: 'https://dev.supabase.co/functions/v1' },
    { TIANGONG_LCA_API_BASE_URL: `${PROJECT}.evil.example` },
    { TIANGONG_LCA_API_BASE_URL: `${PROJECT}/functions/v1?other=true` },
    { TIANGONG_LCA_API_BASE_URL: 'not-a-url' },
    { TIANGONG_LCA_OAUTH_CLIENT_ID: USER },
    { TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'custom-publishable-key' },
    { TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:55000/oauth/callback' },
    { TIANGONG_LCA_ACCESS_TOKEN: 'private-headless-token' },
    { TIANGONG_LCA_AUTH_MODE: 'access-token' },
  ]) {
    assert.throws(() => requireSupabaseRestRuntime(env), CliError);
    const resolved = readRuntimeEnv(env);
    assert.notEqual(resolved.apiBaseUrl, `${PROJECT}/functions/v1`);
    assert.notEqual(resolved.oauthClientId, CLIENT);
    assert.notEqual(resolved.supabasePublishableKey, KEY);
    assert.equal(buildDoctorReport(env, dotEnvStatus).ok, false);
  }
  const custom = requireSupabaseRestRuntime({
    TIANGONG_LCA_API_BASE_URL: 'https://dev.supabase.co',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'custom-publishable-key',
    TIANGONG_LCA_OAUTH_CLIENT_ID: USER,
    TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:55000/oauth/callback',
  });
  assert.equal(custom.apiBaseUrl, 'https://dev.supabase.co');
  assert.equal(custom.oauthClientId, USER);
  assert.equal(custom.oauthRedirectUri, 'http://127.0.0.1:55000/oauth/callback');
});

test('clean CLI auth uses Production without repo env or a preexisting session', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-production-bootstrap-'));
  const sessionFile = path.join(directory, 'private', 'session.json');
  const env = { TIANGONG_LCA_SESSION_FILE: sessionFile };
  let networkCalls = 0;
  let browserCalls = 0;
  const deps: CliDeps = {
    env,
    dotEnvStatus,
    fetchImpl: async (url, init) => {
      networkCalls += 1;
      assert.equal(new URL(url).origin, PROJECT);
      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('client_id'), CLIENT);
        assert.equal(form.get('redirect_uri'), CALLBACK);
        assert.equal(form.get('client_secret'), null);
        assert.ok(form.get('code_verifier'));
        return Response.json({
          access_token: 'private-access-token',
          refresh_token: 'private-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }
      assert.ok(url.endsWith('/oauth/userinfo') || url.endsWith('/auth/v1/user'));
      return Response.json({ id: USER, sub: USER, email: 'private-user@example.com' });
    },
    loginWithSupabaseOAuthImpl: (options) =>
      loginWithSupabaseOAuth({
        ...options,
        receiveCallbackImpl: async (callback) => {
          assert.equal(callback.redirectUri, CALLBACK);
          await callback.onListening();
          return 'private-authorization-code';
        },
        openBrowserImpl: async (target) => {
          browserCalls += 1;
          const url = new URL(target);
          assert.equal(url.origin, PROJECT);
          assert.equal(url.searchParams.get('client_id'), CLIENT);
          assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        },
      }),
  };
  try {
    for (const command of ['status', 'doctor-auth']) {
      const result = await executeCli(['auth', command, '--json'], deps);
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).data.receipt.status, 'login-required');
    }
    assert.equal(networkCalls, 0);
    assert.equal(existsSync(sessionFile), false);
    const login = await executeCli(['auth', 'login', '--json'], deps);
    assert.equal(login.exitCode, 0, login.stderr);
    assert.equal(browserCalls, 1);
    const stored = JSON.parse(readFileSync(sessionFile, 'utf8'));
    assert.equal(stored.refresh_token, 'private-refresh-token');
    assert.equal(stored.auth_method, 'oauth');
    if (process.platform !== 'win32') assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    const status = await executeCli(['auth', 'status', '--json'], deps);
    assert.equal(JSON.parse(status.stdout).data.receipt.status, 'ready');
    const doctor = await executeCli(['auth', 'doctor-auth', '--json'], deps);
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).data.receipt.status, 'passed');
    assert.doesNotMatch(
      login.stdout + status.stdout + doctor.stdout,
      /private-(?:access-token|refresh-token|authorization-code|user@)/u,
    );
    const logout = await executeCli(['auth', 'logout', '--json'], deps);
    assert.equal(logout.exitCode, 0, logout.stderr);
    assert.equal(existsSync(sessionFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
