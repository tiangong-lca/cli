import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseAuthHeaders,
  createSupabaseDataClient,
  createSupabaseFetch,
  deriveSupabaseFunctionsBaseUrl,
  deriveSupabaseProjectBaseUrl,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
  runSupabaseMutation,
  runSupabaseQuery,
} from '../src/lib/supabase-client.js';

type PostgrestErrorLike = {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
};

function makePostgrestError(overrides: Partial<PostgrestErrorLike> = {}): PostgrestErrorLike {
  return {
    code: 'PGRST116',
    message: 'Postgrest failure',
    details: 'details',
    hint: 'hint',
    ...overrides,
  };
}

test('requireSupabaseRestRuntime, URL derivation, and auth headers follow the shared env contract', () => {
  assert.deepEqual(
    requireSupabaseRestRuntime({
      TIANGONG_LCA_API_BASE_URL: ' https://example.supabase.co/functions/v1 ',
      TIANGONG_LCA_ACCESS_TOKEN: ' secret-token ',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: ' sb-publishable-key ',
    } as NodeJS.ProcessEnv),
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      authMode: 'access_token',
      oauthClientId: null,
      oauthRedirectUri: null,
      accessToken: 'secret-token',
      publishableKey: 'sb-publishable-key',
      sessionFile: null,
      disableSessionCache: false,
      forceReauth: false,
    },
  );

  assert.throws(
    () => requireSupabaseRestRuntime({}, { allowProductionDefaults: false }),
    (error) =>
      error instanceof CliError &&
      error.code === 'SUPABASE_REST_ENV_REQUIRED' &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          missing: [
            'TIANGONG_LCA_API_BASE_URL',
            'TIANGONG_LCA_OAUTH_CLIENT_ID or TIANGONG_LCA_ACCESS_TOKEN',
            'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
          ],
        }),
  );

  assert.equal(
    deriveSupabaseProjectBaseUrl('https://example.supabase.co/functions/v1'),
    'https://example.supabase.co',
  );
  assert.equal(
    deriveSupabaseProjectBaseUrl('https://example.supabase.co/rest/v1'),
    'https://example.supabase.co',
  );
  assert.equal(
    deriveSupabaseProjectBaseUrl('https://example.supabase.co'),
    'https://example.supabase.co',
  );
  assert.equal(
    deriveSupabaseRestBaseUrl('https://example.supabase.co/functions/v1'),
    'https://example.supabase.co/rest/v1',
  );
  assert.equal(
    deriveSupabaseFunctionsBaseUrl('https://example.supabase.co/rest/v1'),
    'https://example.supabase.co/functions/v1',
  );
  assert.throws(
    () => deriveSupabaseProjectBaseUrl('https://example.supabase.co/unsupported/path'),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_BASE_URL_INVALID',
  );

  assert.deepEqual(buildSupabaseAuthHeaders('sb-publishable-key', 'access-token'), {
    Accept: 'application/json',
    Authorization: 'Bearer access-token',
    apikey: 'sb-publishable-key',
  });

  assert.deepEqual(
    requireSupabaseRestRuntime({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      TIANGONG_LCA_FORCE_REAUTH: 'yes',
    } as NodeJS.ProcessEnv),
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      authMode: 'access_token',
      oauthClientId: null,
      oauthRedirectUri: null,
      accessToken: 'secret-token',
      publishableKey: 'sb-publishable-key',
      sessionFile: null,
      disableSessionCache: true,
      forceReauth: true,
    },
  );

  assert.deepEqual(
    requireSupabaseRestRuntime({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
      TIANGONG_LCA_FORCE_REAUTH: 'on',
    } as NodeJS.ProcessEnv),
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      authMode: 'access_token',
      oauthClientId: null,
      oauthRedirectUri: null,
      accessToken: 'secret-token',
      publishableKey: 'sb-publishable-key',
      sessionFile: null,
      disableSessionCache: true,
      forceReauth: true,
    },
  );

  assert.deepEqual(
    requireSupabaseRestRuntime({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: 'off',
      TIANGONG_LCA_FORCE_REAUTH: 'off',
    } as NodeJS.ProcessEnv),
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      authMode: 'access_token',
      oauthClientId: null,
      oauthRedirectUri: null,
      accessToken: 'secret-token',
      publishableKey: 'sb-publishable-key',
      sessionFile: null,
      disableSessionCache: false,
      forceReauth: false,
    },
  );
});

test('Supabase runtime supports OAuth and explicit access-token modes', () => {
  const base = {
    TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
  };
  assert.deepEqual(
    requireSupabaseRestRuntime({
      ...base,
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123E4567-E89B-42D3-A456-426614174000',
    }),
    {
      apiBaseUrl: base.TIANGONG_LCA_API_BASE_URL,
      authMode: 'oauth',
      oauthClientId: '123e4567-e89b-42d3-a456-426614174000',
      oauthRedirectUri: 'http://127.0.0.1:49191/oauth/callback',
      accessToken: null,
      publishableKey: base.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
      sessionFile: null,
      disableSessionCache: false,
      forceReauth: false,
    },
  );
  assert.deepEqual(
    requireSupabaseRestRuntime({
      ...base,
      TIANGONG_LCA_ACCESS_TOKEN: ' access-token ',
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
    }),
    {
      apiBaseUrl: base.TIANGONG_LCA_API_BASE_URL,
      authMode: 'access_token',
      oauthClientId: null,
      oauthRedirectUri: null,
      accessToken: 'access-token',
      publishableKey: base.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
      sessionFile: null,
      disableSessionCache: false,
      forceReauth: false,
    },
  );
  const customRedirect = requireSupabaseRestRuntime({
    ...base,
    TIANGONG_LCA_AUTH_MODE: 'oauth',
    TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
    TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:55000/oauth/callback',
  });
  assert.equal(customRedirect.oauthRedirectUri, 'http://127.0.0.1:55000/oauth/callback');
});

test('explicit Supabase auth modes fail closed when configuration is incomplete', () => {
  const base = {
    TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
  };
  for (const [mode, code] of [
    ['oauth', 'SUPABASE_OAUTH_CLIENT_ID_REQUIRED'],
    ['access-token', 'SUPABASE_ACCESS_TOKEN_REQUIRED'],
  ] as const) {
    assert.throws(
      () => requireSupabaseRestRuntime({ ...base, TIANGONG_LCA_AUTH_MODE: mode }),
      (error) => error instanceof CliError && error.code === code,
    );
  }
  assert.throws(
    () => requireSupabaseRestRuntime({ ...base, TIANGONG_LCA_AUTH_MODE: 'legacy-user-api-key' }),
    (error) => error instanceof CliError && error.code === 'SUPABASE_AUTH_MODE_INVALID',
  );
  assert.throws(
    () => requireSupabaseRestRuntime({ ...base, TIANGONG_LCA_AUTH_MODE: 'unknown' }),
    (error) => error instanceof CliError && error.code === 'SUPABASE_AUTH_MODE_INVALID',
  );
  assert.throws(
    () =>
      requireSupabaseRestRuntime({
        ...base,
        TIANGONG_LCA_AUTH_MODE: 'oauth',
        TIANGONG_LCA_OAUTH_CLIENT_ID: 'not-a-client',
      }),
    (error) => error instanceof CliError && error.code === 'OAUTH_CLIENT_ID_INVALID',
  );
});

test('createSupabaseFetch supports URL and Request input shapes and preserves native Responses', async () => {
  const nativeResponse = new Response('native-body', {
    status: 200,
    headers: {
      'content-type': 'text/plain',
    },
  });
  const observedUrls: string[] = [];
  const observedSignals: Array<AbortSignal | undefined> = [];
  const controller = new AbortController();
  const urlFetch = createSupabaseFetch(
    (async (url, init) => {
      observedUrls.push(url);
      observedSignals.push(init?.signal as AbortSignal | undefined);
      return nativeResponse;
    }) as FetchLike,
    25,
  );

  const passthrough = await urlFetch(new URL('https://example.supabase.co/rest/v1/flows'), {
    signal: controller.signal,
  });
  assert.equal(passthrough, nativeResponse);
  assert.deepEqual(observedUrls, ['https://example.supabase.co/rest/v1/flows']);
  assert.equal(typeof observedSignals[0]?.aborted, 'boolean');

  let requestUrl = '';
  let requestMethod = '';
  const requestFetch = createSupabaseFetch(
    (async (url, init) => {
      requestUrl = url;
      requestMethod = String(init?.method ?? '');
      return {
        ok: true,
        status: 201,
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'content-type' ? 'text/plain' : null;
          },
        },
        text: async () => 'created',
      };
    }) as FetchLike,
    25,
  );

  const normalized = await requestFetch(
    new Request('https://example.supabase.co/rest/v1/processes'),
    {
      method: 'POST',
    },
  );
  assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/processes');
  assert.equal(requestMethod, 'POST');
  assert.equal(normalized.status, 201);
  assert.equal(await normalized.text(), '');
});

test('createSupabaseFetch normalizes non-Error transport failures', async () => {
  const fetchWithFailure = createSupabaseFetch(
    (async () => {
      throw 'boom-string';
    }) as FetchLike,
    25,
  );

  await assert.rejects(
    async () => fetchWithFailure('https://example.supabase.co/rest/v1/flows'),
    (error) => error instanceof Error && error.message === 'boom-string',
  );

  const transportError = new Error('boom-error');
  const fetchWithError = createSupabaseFetch(
    (async () => {
      throw transportError;
    }) as FetchLike,
    25,
  );

  await assert.rejects(
    async () => fetchWithError('https://example.supabase.co/rest/v1/flows'),
    (error) => error === transportError,
  );
});

test('createSupabaseFetch refreshes and retries once after an auth failure', async () => {
  const observedAuthHeaders: string[] = [];
  let fetchCount = 0;
  const runtime = {
    apiBaseUrl: 'https://example.supabase.co/functions/v1',
    publishableKey: 'sb-publishable-key',
    getAccessToken: async () => 'stale-access-token',
    refreshAccessToken: async () => 'fresh-access-token',
  };
  const supabaseFetch = createSupabaseFetch(
    (async (_url, init) => {
      const headers = new Headers(init?.headers);
      observedAuthHeaders.push(headers.get('authorization') ?? '');
      fetchCount += 1;

      if (fetchCount === 1) {
        return {
          ok: false,
          status: 401,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '',
        };
      }

      return {
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '{"ok":true}',
      };
    }) as FetchLike,
    25,
    runtime,
  );

  const response = await supabaseFetch(new URL('https://example.supabase.co/rest/v1/flows'), {
    headers: {
      'x-test': '1',
    },
  });
  assert.equal(fetchCount, 2);
  assert.deepEqual(observedAuthHeaders, ['Bearer stale-access-token', 'Bearer fresh-access-token']);
  assert.equal(await response.text(), '{"ok":true}');
});

test('createSupabaseFetch never refreshes or replays mutations after an auth failure', async () => {
  let fetchCount = 0;
  let refreshCount = 0;
  const supabaseFetch = createSupabaseFetch(
    (async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        text: async () => '{"message":"expired"}',
      };
    }) as FetchLike,
    25,
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'stale-access-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'fresh-access-token';
      },
    },
  );

  const response = await supabaseFetch(
    new Request('https://example.supabase.co/rest/v1/processes', { method: 'POST' }),
  );
  assert.equal(response.status, 401);
  assert.equal(fetchCount, 1);
  assert.equal(refreshCount, 0);
});

test('createSupabaseFetch refreshes and replays an explicitly classified read RPC once', async () => {
  let fetchCount = 0;
  let refreshCount = 0;
  const supabaseFetch = createSupabaseFetch(
    (async () => {
      fetchCount += 1;
      return {
        ok: fetchCount === 2,
        status: fetchCount === 1 ? 401 : 200,
        headers: { get: () => 'application/json' },
        text: async () => (fetchCount === 1 ? '{"message":"expired"}' : '{"ok":true}'),
      };
    }) as FetchLike,
    25,
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'stale-access-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'fresh-access-token';
      },
    },
  );

  const response = await supabaseFetch(
    'https://example.supabase.co/rest/v1/rpc/cmd_dataset_derivative_rebuild_read',
    { method: 'POST' },
  );
  assert.equal(response.status, 200);
  assert.equal(fetchCount, 2);
  assert.equal(refreshCount, 1);
});

test('createSupabaseFetch never refreshes or replays a mutation RPC', async () => {
  let fetchCount = 0;
  let refreshCount = 0;
  const supabaseFetch = createSupabaseFetch(
    (async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        text: async () => '{"message":"expired"}',
      };
    }) as FetchLike,
    25,
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'stale-access-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'fresh-access-token';
      },
    },
  );

  const response = await supabaseFetch(
    'https://example.supabase.co/rest/v1/rpc/cmd_dataset_save_draft',
    { method: 'POST' },
  );
  assert.equal(response.status, 403);
  assert.equal(fetchCount, 1);
  assert.equal(refreshCount, 0);
});

test('strict array queries reject HTTP-success null without changing default null compatibility', async () => {
  await assert.rejects(
    () =>
      runSupabaseArrayQuery(
        Promise.resolve({ data: null, error: null, status: 200 }),
        'https://example.supabase.co/rest/v1/flows',
        { requireArray: true },
      ),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID',
  );
  assert.deepEqual(
    await runSupabaseArrayQuery(
      Promise.resolve({ data: [], error: null, status: 200 }),
      'https://example.supabase.co/rest/v1/flows',
      { requireArray: true },
    ),
    [],
  );
});

test('runSupabaseQuery and runSupabaseArrayQuery cover success, null arrays, and wrapped failures', async () => {
  assert.deepEqual(
    await runSupabaseQuery(
      Promise.resolve({
        data: { ok: true },
        error: null,
        status: 200,
      }),
      'https://example.supabase.co/rest/v1/flows',
    ),
    { ok: true },
  );

  assert.deepEqual(
    await runSupabaseArrayQuery(
      Promise.resolve({
        data: null,
        error: null,
        status: 200,
      }),
      'https://example.supabase.co/rest/v1/flows',
    ),
    [],
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) => error instanceof CliError && error.code === 'REMOTE_INVALID_JSON',
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.reject(new Error('network down')),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      error.details === 'network down',
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.reject('query string failure'),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      error.details === 'query string failure',
  );

  const existingCliError = new CliError('already-normalized', {
    code: 'REMOTE_REQUEST_FAILED',
    exitCode: 1,
    details: 'normalized',
  });
  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.reject(existingCliError),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) => error === existingCliError,
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.resolve({
          data: null,
          error: makePostgrestError({
            code: '',
            message: 'SyntaxError: Unexpected token < in JSON at position 0',
            details: 'builder invalid json',
          }) as never,
          status: 0,
        }),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === 'builder invalid json',
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.resolve({
          data: null,
          error: makePostgrestError({
            code: '',
            message: 'SyntaxError: Unexpected token < in JSON at position 0',
            details: '',
          }) as never,
          status: 0,
        }),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === 'SyntaxError: Unexpected token < in JSON at position 0',
  );

  await assert.rejects(
    async () =>
      runSupabaseQuery(
        Promise.resolve({
          data: null,
          error: makePostgrestError({
            code: '',
            message: '{"broken"',
            details: null,
          }) as never,
          status: 200,
        }),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === '{"broken"',
  );
});

test('runSupabaseMutation covers success, CliError passthrough, and wrapped failures', async () => {
  await runSupabaseMutation(
    Promise.resolve({
      error: null,
      status: 204,
    }),
    'https://example.supabase.co/rest/v1/processes',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) => error instanceof CliError && error.code === 'REMOTE_INVALID_JSON',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.reject(new Error('mutation transport failed')),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      error.details === 'mutation transport failed',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.reject('mutation string failure'),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      error.details === 'mutation string failure',
  );

  const existingCliError = new CliError('already-normalized-mutation', {
    code: 'REMOTE_REQUEST_FAILED',
    exitCode: 1,
    details: 'normalized',
  });
  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.reject(existingCliError),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) => error === existingCliError,
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.resolve({
          error: makePostgrestError({
            code: '',
            message: 'SyntaxError: Unexpected token < in JSON at position 0',
            details: 'mutation invalid json',
          }) as never,
          status: 0,
        }),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === 'mutation invalid json',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.resolve({
          error: makePostgrestError({
            code: '',
            message: 'SyntaxError: Unexpected token < in JSON at position 0',
            details: '',
          }) as never,
          status: 0,
        }),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === 'SyntaxError: Unexpected token < in JSON at position 0',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.resolve({
          error: makePostgrestError({
            code: '',
            message: '{"broken"',
            details: null,
          }) as never,
          status: 200,
        }),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_INVALID_JSON' &&
      error.details === '{"broken"',
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.resolve({
          error: makePostgrestError({
            code: '23505',
            message: 'duplicate row',
            details: 'duplicate process',
            hint: null,
          }) as never,
          status: 409,
        }),
        'https://example.supabase.co/rest/v1/processes',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          code: '23505',
          message: 'duplicate row',
          details: 'duplicate process',
          hint: null,
        }),
  );

  await assert.rejects(
    async () =>
      runSupabaseMutation(
        Promise.resolve({
          error: makePostgrestError({
            code: '23505',
            message: 'duplicate key value violates unique constraint',
            details: 'duplicate row',
            hint: 'retry',
          }) as never,
          status: 409,
        }),
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) =>
      error instanceof CliError &&
      error.code === 'REMOTE_REQUEST_FAILED' &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          code: '23505',
          message: 'duplicate key value violates unique constraint',
          details: 'duplicate row',
          hint: 'retry',
        }),
  );
});

test('createSupabaseDataClient returns configured rest and functions base URLs', () => {
  const { client, restBaseUrl, functionsBaseUrl } = createSupabaseDataClient(
    {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'access-token',
      refreshAccessToken: async () => 'refreshed-access-token',
    },
    (async () =>
      new Response('[]', {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })) as FetchLike,
    25,
  );

  assert.ok(client);
  assert.equal(restBaseUrl, 'https://example.supabase.co/rest/v1');
  assert.equal(functionsBaseUrl, 'https://example.supabase.co/functions/v1');
});
