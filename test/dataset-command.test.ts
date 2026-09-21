import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testInternals,
  createDatasetRecord,
  resolveDatasetCommandTransport,
  saveDraftDatasetRecord,
} from '../src/lib/dataset-command.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function makeResponse(options: {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: string;
}) {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type'
          ? (options.contentType ?? 'application/json')
          : null;
      },
    },
    async text(): Promise<string> {
      return options.body ?? '';
    },
  };
}

function withSupabaseAuthBootstrap(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (isSupabaseAuthTokenUrl(String(url))) {
      return makeSupabaseAuthResponse();
    }

    return fetchImpl(String(url), init);
  };
}

test('dataset command helper derives functions base URLs from supported API base shapes', () => {
  assert.equal(
    __testInternals.deriveSupabaseFunctionsBaseUrl('https://example.supabase.co'),
    'https://example.supabase.co/functions/v1',
  );
  assert.equal(
    __testInternals.deriveSupabaseFunctionsBaseUrl('https://example.supabase.co/rest/v1'),
    'https://example.supabase.co/functions/v1',
  );
  assert.equal(
    __testInternals.deriveSupabaseFunctionsBaseUrl('https://example.supabase.co/functions/v1'),
    'https://example.supabase.co/functions/v1',
  );
});

test('dataset command helper posts create and save-draft payloads with normalized field names', async () => {
  const observed: Array<{ url: string; method: string; body?: string }> = [];
  const transport = await resolveDatasetCommandTransport({
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        url: String(url),
        method: String(init?.method ?? 'GET'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"ok"}}',
      });
    }),
    timeoutMs: 10,
  });

  await createDatasetRecord({
    transport,
    table: 'flows',
    id: '11111111-1111-1111-1111-111111111111',
    payload: { flowDataSet: {} },
    extraData: {
      model_id: null,
      rule_verification: false,
    },
  });
  await saveDraftDatasetRecord({
    transport,
    table: 'processes',
    id: '22222222-2222-2222-2222-222222222222',
    version: '01.00.001',
    payload: { processDataSet: {} },
    extraData: {
      modelId: '33333333-3333-3333-3333-333333333333',
      modelVersion: '01.01.021',
      ruleVerification: null,
    },
  });

  assert.deepEqual(
    observed.map((entry) => entry.method),
    ['POST', 'POST'],
  );
  assert.match(observed[0]?.url ?? '', /\/functions\/v1\/app_dataset_create$/u);
  assert.match(observed[1]?.url ?? '', /\/functions\/v1\/app_dataset_save_draft$/u);
  assert.deepEqual(JSON.parse(observed[0]?.body ?? '{}'), {
    table: 'flows',
    id: '11111111-1111-1111-1111-111111111111',
    jsonOrdered: {
      flowDataSet: {},
    },
    modelId: null,
    ruleVerification: false,
  });
  assert.deepEqual(JSON.parse(observed[1]?.body ?? '{}'), {
    table: 'processes',
    id: '22222222-2222-2222-2222-222222222222',
    version: '01.00.001',
    jsonOrdered: {
      processDataSet: {},
    },
    modelId: '33333333-3333-3333-3333-333333333333',
    modelVersion: '01.01.021',
    ruleVerification: null,
  });
});

test('dataset command helper rejects ok:false application payloads', async () => {
  const transport = await resolveDatasetCommandTransport({
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async () =>
      makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":false,"code":"OWNERSHIP_REQUIRED","message":"blocked"}',
      }),
    ),
    timeoutMs: 10,
  });

  await assert.rejects(
    () =>
      createDatasetRecord({
        transport,
        table: 'flows',
        id: '44444444-4444-4444-4444-444444444444',
        payload: { flowDataSet: {} },
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'OWNERSHIP_REQUIRED');
      return true;
    },
  );
});

test('dataset command helper normalizes optional metadata helpers and rejects malformed success payloads', async () => {
  assert.equal(__testInternals.readOptionalRuleVerification(undefined), undefined);
  assert.equal(
    __testInternals.readOptionalRuleVerification({ ruleVerification: 'bad' }),
    undefined,
  );
  assert.equal(
    __testInternals.readOptionalRuleVerification({ rule_verification: 'bad' }),
    undefined,
  );
  assert.equal(__testInternals.readOptionalRuleVerification({ rule_verification: null }), null);
  assert.equal(__testInternals.readOptionalModelId({ modelId: '  model-1  ' }, false), 'model-1');
  assert.equal(__testInternals.readOptionalModelId({ modelId: '   ' }, false), undefined);
  assert.equal(__testInternals.readOptionalModelId({ model_id: null }, true), null);
  assert.equal(__testInternals.readOptionalModelId({ model_id: null }, false), undefined);
  assert.equal(
    __testInternals.readOptionalModelVersion({ modelVersion: '  01.01.021  ' }),
    '01.01.021',
  );
  assert.equal(__testInternals.readOptionalModelVersion({ model_version: null }), null);
  assert.equal(__testInternals.readOptionalModelVersion({ modelVersion: '   ' }), undefined);

  const transport = await resolveDatasetCommandTransport({
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async () =>
      makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      }),
    ),
    timeoutMs: 10,
  });

  await assert.rejects(
    () =>
      createDatasetRecord({
        transport,
        table: 'flows',
        id: '55555555-5555-5555-5555-555555555555',
        payload: { flowDataSet: {} },
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_RESPONSE_INVALID');
      return true;
    },
  );
});

test('dataset command helper carries an optional complete before image and omits it for legacy saves', async () => {
  const observed: Array<{ url: string; body?: string }> = [];
  const transport = await resolveDatasetCommandTransport({
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return makeResponse({ ok: true, status: 200, body: '{"ok":true,"data":{"id":"ok"}}' });
    }),
    timeoutMs: 10,
  });
  const id = '77777777-7777-4777-8777-777777777777';
  const payload = { processDataSet: { processInformation: {} } };
  const before = { processDataSet: { processInformation: { 'common:generalComment': 'before' } } };

  await saveDraftDatasetRecord({
    transport,
    table: 'processes',
    id,
    version: '00.00.001',
    payload,
  });
  await saveDraftDatasetRecord({
    transport,
    table: 'processes',
    id,
    version: '00.00.001',
    payload,
    expectedJsonOrdered: before,
  });

  const legacy = JSON.parse(observed[0]?.body ?? '{}') as Record<string, unknown>;
  const guarded = JSON.parse(observed[1]?.body ?? '{}') as Record<string, unknown>;
  assert.equal(Object.hasOwn(legacy, 'expectedJsonOrdered'), false);
  assert.deepEqual(legacy.jsonOrdered, payload);
  assert.deepEqual(guarded.expectedJsonOrdered, before);
  assert.deepEqual(guarded.jsonOrdered, payload);
});
