import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import {
  deriveSupabaseRestBaseUrl,
  fetchExactOrLatestProcessRow,
  normalizeSupabaseProcessPayload,
  requireSupabaseRestRuntime,
  type SupabaseDataRuntime,
} from '../src/lib/transport/supabase-rest.js';

function jsonFetch(
  responses: unknown[],
  observed: Array<{ url: string; method: string; headers: HeadersInit | undefined }>,
): FetchLike {
  let index = 0;
  return (async (input, init) => {
    const normalizedHeaders =
      init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers;
    observed.push({
      url: String(input),
      method: String(init?.method ?? ''),
      headers: normalizedHeaders,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify(next),
    };
  }) as FetchLike;
}

function makeRuntime(apiBaseUrl: string): SupabaseDataRuntime {
  return {
    apiBaseUrl,
    publishableKey: 'sb-publishable-key',
    getAccessToken: async () => 'access-token',
    refreshAccessToken: async () => 'refreshed-access-token',
  };
}

test('requireSupabaseRestRuntime reads the shared CLI env contract', () => {
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
});

test('configured-only Supabase runtime rejects missing env keys', () => {
  assert.throws(
    () => requireSupabaseRestRuntime({}, { allowProductionDefaults: false }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'SUPABASE_REST_ENV_REQUIRED');
      assert.deepEqual(error.details, {
        missing: [
          'TIANGONG_LCA_API_BASE_URL',
          'TIANGONG_LCA_OAUTH_CLIENT_ID or TIANGONG_LCA_ACCESS_TOKEN',
          'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
        ],
      });
      return true;
    },
  );
});

test('deriveSupabaseRestBaseUrl supports project, functions, and rest base URLs', () => {
  assert.equal(
    deriveSupabaseRestBaseUrl('https://example.supabase.co/functions/v1'),
    'https://example.supabase.co/rest/v1',
  );
  assert.equal(
    deriveSupabaseRestBaseUrl('https://example.supabase.co/rest/v1'),
    'https://example.supabase.co/rest/v1',
  );
  assert.equal(
    deriveSupabaseRestBaseUrl('https://example.supabase.co'),
    'https://example.supabase.co/rest/v1',
  );
});

test('deriveSupabaseRestBaseUrl rejects empty and unsupported base URLs', () => {
  assert.throws(() => deriveSupabaseRestBaseUrl('   '), {
    constructor: CliError,
  });
  assert.throws(() => deriveSupabaseRestBaseUrl('https://example.supabase.co/custom/path'), {
    constructor: CliError,
  });
});

test('normalizeSupabaseProcessPayload accepts object payloads and JSON strings', () => {
  const objectPayload = { processDataSet: {} };
  assert.equal(normalizeSupabaseProcessPayload(objectPayload, 'proc-1@00.00.001'), objectPayload);
  assert.deepEqual(normalizeSupabaseProcessPayload('{"processDataSet":{}}', 'proc-1@00.00.001'), {
    processDataSet: {},
  });
});

test('normalizeSupabaseProcessPayload rejects invalid JSON and invalid shapes', () => {
  assert.throws(
    () => normalizeSupabaseProcessPayload('{invalid', 'proc-1@00.00.001'),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_PAYLOAD_INVALID_JSON',
  );
  assert.throws(
    () => normalizeSupabaseProcessPayload('[]', 'proc-1@00.00.001'),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_PAYLOAD_INVALID',
  );
  assert.throws(
    () => normalizeSupabaseProcessPayload(null, 'proc-1@00.00.001'),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_PAYLOAD_MISSING',
  );
});

test('fetchExactOrLatestProcessRow returns the exact version row when present', async () => {
  const observed: Array<{ url: string; method: string; headers: HeadersInit | undefined }> = [];
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co/functions/v1'),
    id: 'proc-1',
    version: '00.00.001',
    timeoutMs: 10,
    fetchImpl: jsonFetch(
      [
        [
          {
            id: 'proc-1',
            version: '00.00.001',
            json: { processDataSet: {} },
            modified_at: '2026-03-30T00:00:00.000Z',
            state_code: 100,
          },
        ],
      ],
      observed,
    ),
  });

  assert.deepEqual(lookup, {
    row: {
      id: 'proc-1',
      version: '00.00.001',
      json: { processDataSet: {} },
      modified_at: '2026-03-30T00:00:00.000Z',
      state_code: 100,
    },
    sourceUrl:
      'https://example.supabase.co/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-1&version=eq.00.00.001',
    resolution: 'remote_supabase_exact',
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.method, 'GET');
  assert.match(observed[0]?.url ?? '', /\/rest\/v1\/processes/u);
  assert.match(observed[0]?.url ?? '', /version=eq\.00\.00\.001/u);
  const headers = observed[0]?.headers as Record<string, string>;
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers.authorization, 'Bearer access-token');
  assert.equal(headers.apikey, 'sb-publishable-key');
});

test('fetchExactOrLatestProcessRow returns the latest row when no version is requested', async () => {
  const observed: Array<{ url: string; method: string; headers: HeadersInit | undefined }> = [];
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co'),
    id: 'proc-1',
    timeoutMs: 10,
    fetchImpl: jsonFetch(
      [
        [
          {
            id: 'proc-1',
            version: '00.00.003',
            json: { processDataSet: { latest: true } },
            modified_at: null,
            state_code: 50,
          },
        ],
      ],
      observed,
    ),
  });

  assert.equal(lookup?.resolution, 'remote_supabase_latest');
  assert.equal(lookup?.row.version, '00.00.003');
  assert.equal(observed.length, 1);
  assert.match(observed[0]?.url ?? '', /order=version.desc/u);
  assert.match(observed[0]?.url ?? '', /limit=1/u);
});

test('fetchExactOrLatestProcessRow normalizes missing id and version fields to empty strings', async () => {
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co'),
    id: 'proc-1',
    timeoutMs: 10,
    fetchImpl: jsonFetch(
      [
        [
          {
            json: { processDataSet: { latest: true } },
            modified_at: null,
            state_code: null,
          },
        ],
      ],
      [],
    ),
  });

  assert.deepEqual(lookup?.row, {
    id: '',
    version: '',
    json: { processDataSet: { latest: true } },
    modified_at: null,
    state_code: null,
  });
});

test('fetchExactOrLatestProcessRow falls back to the latest version row when exact lookup misses', async () => {
  const observed: Array<{ url: string; method: string; headers: HeadersInit | undefined }> = [];
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co/rest/v1'),
    id: 'proc-1',
    version: '00.00.001',
    timeoutMs: 10,
    fetchImpl: jsonFetch(
      [
        [],
        [
          {
            id: 'proc-1',
            version: '00.00.003',
            json: { processDataSet: {} },
            modified_at: null,
            state_code: 50,
          },
        ],
      ],
      observed,
    ),
    fallbackToLatest: true,
  });

  assert.equal(lookup?.resolution, 'remote_supabase_latest_fallback');
  assert.equal(lookup?.row.version, '00.00.003');
  assert.equal(observed.length, 2);
  assert.match(observed[0]?.url ?? '', /version=eq\.00\.00\.001/u);
  assert.match(observed[1]?.url ?? '', /order=version.desc/u);
  assert.match(observed[1]?.url ?? '', /limit=1/u);
});

test('fetchExactOrLatestProcessRow returns null when exact lookup misses without fallback', async () => {
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co'),
    id: 'missing',
    version: '00.00.001',
    timeoutMs: 10,
    fetchImpl: jsonFetch([[]], []),
    fallbackToLatest: false,
  });

  assert.equal(lookup, null);
});

test('fetchExactOrLatestProcessRow returns null when neither exact nor latest rows exist', async () => {
  const lookup = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co'),
    id: 'missing',
    version: '00.00.001',
    timeoutMs: 10,
    fetchImpl: jsonFetch([[], []], []),
    fallbackToLatest: true,
  });

  assert.equal(lookup, null);
});

test('fetchExactOrLatestProcessRow rejects malformed Supabase REST payloads', async () => {
  await assert.rejects(
    () =>
      fetchExactOrLatestProcessRow({
        runtime: makeRuntime('https://example.supabase.co'),
        id: 'proc-1',
        version: '00.00.001',
        timeoutMs: 10,
        fetchImpl: jsonFetch([{ bad: 'shape' }], []),
      }),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID',
  );

  await assert.rejects(
    () =>
      fetchExactOrLatestProcessRow({
        runtime: makeRuntime('https://example.supabase.co'),
        id: 'proc-1',
        version: '00.00.001',
        timeoutMs: 10,
        fetchImpl: jsonFetch([[42]], []),
      }),
    (error) => error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID',
  );
});

test('a missing explicitly requested latest Process is reported as absent', async () => {
  const observed: Parameters<typeof jsonFetch>[1] = [];
  const result = await fetchExactOrLatestProcessRow({
    runtime: makeRuntime('https://example.supabase.co/functions/v1'),
    id: 'missing',
    timeoutMs: 1000,
    fetchImpl: jsonFetch([[]], observed),
  });
  assert.equal(result, null);
  assert.equal(observed.length, 1);
  assert.match(observed[0]!.url, /limit=1/);
});
