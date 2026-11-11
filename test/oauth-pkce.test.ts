import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/transport/http.js';
import {
  __testInternals,
  buildOAuthAuthorizationUrl,
  createOAuthPkceValues,
  exchangeOAuthAuthorizationCode,
  fetchOAuthUserInfo,
  refreshOAuthTokens,
  requireOAuthClientId,
} from '../src/lib/auth/oauth-pkce.js';
import { loadDistModule } from './helpers/load-dist-module.js';

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '223e4567-e89b-42d3-a456-426614174000';
const REDIRECT_URI = 'http://127.0.0.1:49191/oauth/callback';
const PROJECT_URL = 'https://example.supabase.co';

function response(
  body: unknown,
  options: { ok?: boolean; status?: number; contentLength?: string | null } = {},
): ResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-length') {
          return options.contentLength === undefined
            ? String(Buffer.byteLength(text, 'utf8'))
            : options.contentLength;
        }
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return text;
    },
  };
}

function expectCliCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CliError && error.code === code;
}

test('PKCE values and authorization URL are deterministic with injected entropy', () => {
  const liveValues = createOAuthPkceValues();
  assert.notEqual(liveValues.codeVerifier, liveValues.state);
  const values = createOAuthPkceValues((size) => new Uint8Array(size).fill(size));
  assert.match(values.codeVerifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.match(values.codeChallenge, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(values.state, /^[A-Za-z0-9_-]{32,128}$/u);

  const authorizationUrl = new URL(
    buildOAuthAuthorizationUrl({
      projectBaseUrl: `${PROJECT_URL}/`,
      clientId: CLIENT_ID.toUpperCase(),
      redirectUri: REDIRECT_URI,
      codeChallenge: values.codeChallenge,
      state: values.state,
    }),
  );
  assert.equal(authorizationUrl.origin, PROJECT_URL);
  assert.equal(authorizationUrl.pathname, '/auth/v1/oauth/authorize');
  assert.deepEqual(Object.fromEntries(authorizationUrl.searchParams), {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile',
    code_challenge: values.codeChallenge,
    code_challenge_method: 'S256',
    state: values.state,
  });
  assert.equal(requireOAuthClientId(` ${CLIENT_ID.toUpperCase()} `), CLIENT_ID);
});

test('PKCE and authorization inputs fail closed', () => {
  assert.throws(
    () => createOAuthPkceValues(() => new Uint8Array(63)),
    expectCliCode('OAUTH_RANDOMNESS_INVALID'),
  );
  let call = 0;
  assert.throws(
    () =>
      createOAuthPkceValues((size) => {
        call += 1;
        return new Uint8Array(call === 1 ? size : 31);
      }),
    expectCliCode('OAUTH_RANDOMNESS_INVALID'),
  );
  assert.throws(
    () => requireOAuthClientId('not-a-client'),
    expectCliCode('OAUTH_CLIENT_ID_INVALID'),
  );
  assert.throws(
    () =>
      buildOAuthAuthorizationUrl({
        projectBaseUrl: PROJECT_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeChallenge: 'short',
        state: 'a'.repeat(43),
      }),
    expectCliCode('OAUTH_PKCE_CHALLENGE_INVALID'),
  );
  assert.throws(
    () =>
      buildOAuthAuthorizationUrl({
        projectBaseUrl: PROJECT_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        codeChallenge: 'a'.repeat(43),
        state: 'short',
      }),
    expectCliCode('OAUTH_STATE_INVALID'),
  );
});

test('project URL validation accepts secure and loopback origins only', () => {
  assert.equal(
    __testInternals.requireProjectBaseUrl('http://127.0.0.1:54321'),
    'http://127.0.0.1:54321',
  );
  assert.equal(
    __testInternals.requireProjectBaseUrl('http://localhost:54321/'),
    'http://localhost:54321',
  );
  assert.equal(__testInternals.requireProjectBaseUrl('http://[::1]:54321'), 'http://[::1]:54321');
  for (const value of [
    'not-a-url',
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'ftp://localhost',
  ]) {
    assert.throws(
      () => __testInternals.requireProjectBaseUrl(value),
      expectCliCode('OAUTH_PROJECT_URL_INVALID'),
    );
  }
});

test('authorization-code exchange sends the exact public-client form and parses tokens', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const tokenSet = await exchangeOAuthAuthorizationCode({
    projectBaseUrl: PROJECT_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    authorizationCode: 'authorization-code',
    codeVerifier: 'v'.repeat(64),
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return response({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'profile email email openid',
        id_token: 'must-not-be-returned',
      });
    },
  });

  assert.equal(seenUrl, `${PROJECT_URL}/auth/v1/oauth/token`);
  assert.equal(seenInit?.method, 'POST');
  assert.deepEqual(seenInit?.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(seenInit?.body))), {
    grant_type: 'authorization_code',
    code: 'authorization-code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: 'v'.repeat(64),
  });
  assert.equal(seenInit?.signal instanceof AbortSignal, true);
  assert.deepEqual(tokenSet, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 3600,
    scope: ['email', 'openid', 'profile'],
  });
});

test('refresh flow rotates tokens and retains the prior refresh token when omitted', async () => {
  const seenBodies: string[] = [];
  const replies = [
    response({
      access_token: 'access-one',
      refresh_token: 'refresh-two',
      token_type: 'bearer',
      expires_in: 900,
    }),
    response({
      access_token: 'access-two',
      token_type: 'bearer',
      expires_in: 800,
      scope: '',
    }),
  ];
  let index = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    seenBodies.push(String(init?.body));
    return replies[index++] as ResponseLike;
  };

  const rotated = await refreshOAuthTokens({
    projectBaseUrl: PROJECT_URL,
    clientId: CLIENT_ID,
    refreshToken: 'refresh-one',
    fetchImpl,
    timeoutMs: 100,
  });
  const retained = await refreshOAuthTokens({
    projectBaseUrl: PROJECT_URL,
    clientId: CLIENT_ID,
    refreshToken: rotated.refreshToken,
    fetchImpl,
    timeoutMs: 100,
  });
  assert.equal(rotated.refreshToken, 'refresh-two');
  assert.equal(retained.refreshToken, 'refresh-two');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seenBodies[0])), {
    grant_type: 'refresh_token',
    refresh_token: 'refresh-one',
    client_id: CLIENT_ID,
  });
});

test('token response parsing rejects every incomplete bearer-session shape', () => {
  const valid = {
    access_token: 'access',
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
  };
  for (const value of [
    null,
    { ...valid, access_token: '' },
    { ...valid, refresh_token: '' },
    { ...valid, token_type: 'mac' },
    { ...valid, expires_in: '3600' },
    { ...valid, expires_in: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, expires_in: 0 },
  ]) {
    assert.throws(
      () => __testInternals.parseOAuthTokenSet(value),
      expectCliCode('OAUTH_TOKEN_RESPONSE_INVALID'),
    );
  }
});

test('OAuth token request validation rejects bad code, verifier, and refresh inputs', async () => {
  const base = {
    projectBaseUrl: PROJECT_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetchImpl: async () => response({}),
    timeoutMs: 100,
  };
  await assert.rejects(
    () =>
      exchangeOAuthAuthorizationCode({
        ...base,
        authorizationCode: '',
        codeVerifier: 'v'.repeat(64),
      }),
    expectCliCode('OAUTH_AUTHORIZATION_CODE_INVALID'),
  );
  await assert.rejects(
    () =>
      exchangeOAuthAuthorizationCode({
        ...base,
        authorizationCode: 'x'.repeat(4097),
        codeVerifier: 'v'.repeat(64),
      }),
    expectCliCode('OAUTH_AUTHORIZATION_CODE_INVALID'),
  );
  await assert.rejects(
    () =>
      exchangeOAuthAuthorizationCode({ ...base, authorizationCode: 'code', codeVerifier: 'short' }),
    expectCliCode('OAUTH_PKCE_VERIFIER_INVALID'),
  );
  await assert.rejects(
    () =>
      refreshOAuthTokens({
        projectBaseUrl: PROJECT_URL,
        clientId: CLIENT_ID,
        refreshToken: ' ',
        fetchImpl: base.fetchImpl,
        timeoutMs: 100,
      }),
    expectCliCode('OAUTH_REFRESH_TOKEN_REQUIRED'),
  );
});

test('bounded OAuth JSON reader rejects unsafe provider responses', async () => {
  await assert.rejects(
    () => __testInternals.readBoundedJson(response({}, { contentLength: 'bad' }), PROJECT_URL),
    expectCliCode('OAUTH_RESPONSE_INVALID'),
  );
  await assert.rejects(
    () => __testInternals.readBoundedJson(response({}, { contentLength: '-1' }), PROJECT_URL),
    expectCliCode('OAUTH_RESPONSE_INVALID'),
  );
  await assert.rejects(
    () => __testInternals.readBoundedJson(response({}, { contentLength: '65537' }), PROJECT_URL),
    expectCliCode('OAUTH_RESPONSE_TOO_LARGE'),
  );
  await assert.rejects(
    () =>
      __testInternals.readBoundedJson(
        response('x'.repeat(65537), { contentLength: null }),
        PROJECT_URL,
      ),
    expectCliCode('OAUTH_RESPONSE_TOO_LARGE'),
  );
  await assert.rejects(
    () => __testInternals.readBoundedJson(response('not-json'), PROJECT_URL),
    expectCliCode('OAUTH_RESPONSE_INVALID'),
  );
  await assert.rejects(
    () =>
      __testInternals.readBoundedJson(
        response(
          { error: 'invalid_grant', error_description: 'secret detail' },
          { ok: false, status: 400 },
        ),
        PROJECT_URL,
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'OAUTH_REQUEST_FAILED' &&
      JSON.stringify(error.details) === JSON.stringify({ status: 400, error: 'invalid_grant' }),
  );
  await assert.rejects(
    () =>
      __testInternals.readBoundedJson(
        response({ error: 'BAD ERROR' }, { ok: false, status: 500, contentLength: null }),
        PROJECT_URL,
      ),
    (error) =>
      error instanceof CliError &&
      JSON.stringify(error.details) ===
        JSON.stringify({ status: 500, error: 'oauth_request_failed' }),
  );
});

test('OAuth UserInfo verifies server identity and never accepts a missing token', async () => {
  let seenAuthorization = '';
  const userInfo = await fetchOAuthUserInfo({
    projectBaseUrl: PROJECT_URL,
    accessToken: ' access-token ',
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${PROJECT_URL}/auth/v1/oauth/userinfo`);
      seenAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
      return response({ sub: USER_ID.toUpperCase(), email: 'user@example.com' });
    },
  });
  assert.equal(seenAuthorization, 'Bearer access-token');
  assert.deepEqual(userInfo, { userId: USER_ID, email: 'user@example.com' });

  await assert.rejects(
    () =>
      fetchOAuthUserInfo({
        projectBaseUrl: PROJECT_URL,
        accessToken: '',
        timeoutMs: 100,
        fetchImpl: async () => response({}),
      }),
    expectCliCode('OAUTH_ACCESS_TOKEN_REQUIRED'),
  );
  for (const body of [
    null,
    { sub: 'bad', email: 'user@example.com' },
    { sub: USER_ID, email: '' },
    { sub: USER_ID, email: 'x'.repeat(321) },
  ]) {
    await assert.rejects(
      () =>
        fetchOAuthUserInfo({
          projectBaseUrl: PROJECT_URL,
          accessToken: 'access',
          timeoutMs: 100,
          fetchImpl: async () => response(body),
        }),
      expectCliCode('OAUTH_USERINFO_INVALID'),
    );
  }
});

test('OAuth PKCE protocol behaves identically from the built runtime', async () => {
  const built = await loadDistModule<typeof import('../src/lib/auth/oauth-pkce.js')>(
    'src/lib/auth/oauth-pkce.js',
  );
  assert.equal(built.requireOAuthClientId(CLIENT_ID), CLIENT_ID);
  const values = built.createOAuthPkceValues((size) => new Uint8Array(size).fill(9));
  assert.match(
    built.buildOAuthAuthorizationUrl({
      projectBaseUrl: PROJECT_URL,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: values.codeChallenge,
      state: values.state,
    }),
    /\/auth\/v1\/oauth\/authorize/u,
  );
});

test('Supabase native token error envelopes project only the verified terminal code', async () => {
  const cases: Array<{ body: unknown; expected: string }> = [
    {
      body: { code: 400, error_code: 'refresh_token_not_found', msg: 'private-token-secret' },
      expected: 'refresh_token_not_found',
    },
    {
      body: { code: 'refresh_token_not_found', message: 'private-token-secret' },
      expected: 'refresh_token_not_found',
    },
    {
      body: { code: 400, error_code: 'private_token_secret', msg: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    {
      body: { code: 'private_token_secret', message: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    { body: { error_code: 'refresh_token_not_found' }, expected: 'oauth_request_failed' },
    {
      body: { code: 401, error_code: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    {
      body: { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    {
      body: { code: 'refresh_token_not_found', error_code: null },
      expected: 'oauth_request_failed',
    },
    {
      body: { error: 'invalid_grant', error_code: 'refresh_token_not_found', code: 400 },
      expected: 'oauth_request_failed',
    },
    {
      body: { error: 'invalid_grant', code: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    {
      body: { error: 'invalid_client', error_code: 'refresh_token_not_found' },
      expected: 'oauth_request_failed',
    },
    { body: { error: null, code: 'refresh_token_not_found' }, expected: 'oauth_request_failed' },
    {
      body: { code: 400, error_code: null, msg: 'private-token-secret' },
      expected: 'oauth_request_failed',
    },
    { body: {}, expected: 'oauth_request_failed' },
    { body: null, expected: 'oauth_request_failed' },
    { body: [], expected: 'oauth_request_failed' },
  ];
  for (const { body, expected } of cases) {
    await assert.rejects(
      __testInternals.readBoundedJson(response(body, { ok: false, status: 400 }), PROJECT_URL),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.deepEqual(error.details, { status: 400, error: expected });
        assert.doesNotMatch(JSON.stringify(error), /private.token.secret/);
        return true;
      },
    );
  }
});
