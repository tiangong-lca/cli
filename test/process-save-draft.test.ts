import { processTransportFixture } from './helpers/process-allocation-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import { syncStateAwareProcessRecord, __testInternals } from '../src/lib/process-save-draft.js';
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

test('state-aware process write routes visible drafts through cmd_dataset_save_draft', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  const result = await syncStateAwareProcessRecord({
    id: 'proc-draft',
    version: '01.00.001',
    payload: processTransportFixture(),
    modelId: 'model-source',
    modelVersion: '01.01.021',
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        method: String(init?.method ?? 'GET'),
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (observed.length === 1) {
        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"proc-draft","version":"01.00.001","user_id":"user-1","state_code":0}]',
        });
      }

      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"proc-draft"}}',
      });
    }),
  });

  assert.deepEqual(
    observed.map((entry) => entry.method),
    ['GET', 'POST'],
  );
  assert.match(observed[1]?.url ?? '', /\/rest\/v1\/rpc\/cmd_dataset_save_draft$/u);
  assert.deepEqual(JSON.parse(observed[1]?.body ?? '{}'), {
    p_table: 'processes',
    p_id: 'proc-draft',
    p_version: '01.00.001',
    p_json_ordered: processTransportFixture(),
    p_model_id: 'model-source',
    p_model_version: '01.01.021',
    p_audit: null,
  });
  assert.deepEqual(result, {
    status: 'success',
    operation: 'save_draft',
    write_path: 'cmd_dataset_save_draft',
    rpc_result: { ok: true, data: { id: 'proc-draft' } },
    visible_row: {
      id: 'proc-draft',
      version: '01.00.001',
      user_id: 'user-1',
      state_code: 0,
    },
  });
});

test('state-aware process write enforces target user guard before remote writes', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  const result = await syncStateAwareProcessRecord({
    id: 'proc-target',
    version: '01.00.001',
    payload: processTransportFixture(),
    targetUserId: 'user-1',
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        method: String(init?.method ?? 'GET'),
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (String(url).includes('/rest/v1/processes')) {
        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"proc-target","version":"01.00.001","user_id":"user-1","state_code":0}]',
        });
      }

      if (String(url).includes('/auth/v1/user')) {
        return makeResponse({
          ok: true,
          status: 200,
          body: '{"id":"user-1"}',
        });
      }

      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"proc-target"}}',
      });
    }),
  });

  assert.deepEqual(
    observed.map((entry) => entry.method),
    ['GET', 'POST'],
  );
  assert.match(observed[1]?.url ?? '', /\/rest\/v1\/rpc\/cmd_dataset_save_draft$/u);
  assert.deepEqual(result, {
    status: 'success',
    operation: 'save_draft',
    write_path: 'cmd_dataset_save_draft',
    rpc_result: { ok: true, data: { id: 'proc-target' } },
    visible_row: {
      id: 'proc-target',
      version: '01.00.001',
      user_id: 'user-1',
      state_code: 0,
    },
  });
});

test('state-aware process write rejects target user mismatches', async () => {
  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-target-mismatch',
        version: '01.00.001',
        payload: processTransportFixture(),
        targetUserId: 'target-user',
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: async (url) => {
          if (String(url).includes('/rest/v1/processes')) {
            return makeResponse({
              ok: true,
              status: 200,
              body: '[]',
            });
          }
          return makeResponse({
            ok: true,
            status: 200,
            body: '{"id":"current-user"}',
          });
        },
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'PROCESS_SAVE_DRAFT_TARGET_USER_MISMATCH');
      assert.match(error.message, /target-user/u);
      return true;
    },
  );
});

test('state-aware process write rejects target user guards without current auth ids', async () => {
  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-target-missing-user',
        version: '01.00.001',
        payload: processTransportFixture(),
        targetUserId: 'target-user',
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: async (url) => {
          if (String(url).includes('/rest/v1/processes')) {
            return makeResponse({
              ok: true,
              status: 200,
              body: '[]',
            });
          }
          return makeResponse({
            ok: true,
            status: 200,
            body: '{}',
          });
        },
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'PROCESS_SAVE_DRAFT_CURRENT_USER_ID_MISSING');
      assert.match(error.message, /without a user id/u);
      return true;
    },
  );

  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-target-malformed-user',
        version: '01.00.001',
        payload: processTransportFixture(),
        targetUserId: 'target-user',
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: async (url) => {
          if (String(url).includes('/rest/v1/processes')) {
            return makeResponse({
              ok: true,
              status: 200,
              body: '[]',
            });
          }
          return makeResponse({
            ok: true,
            status: 200,
            body: '[]',
          });
        },
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'PROCESS_SAVE_DRAFT_CURRENT_USER_ID_MISSING');
      return true;
    },
  );
});

test('state-aware process write rejects visible non-draft rows before raw table updates', async () => {
  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-public',
        version: '01.00.001',
        payload: processTransportFixture(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: withSupabaseAuthBootstrap(async () =>
          makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-public","version":"01.00.001","user_id":"other-user","state_code":100}]',
          }),
        ),
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'PUBLISH_PROCESS_SAVE_DRAFT_UNSUPPORTED_VISIBLE_ROW');
      assert.match(error.message, /state_code=100/u);
      return true;
    },
  );
});

test('state-aware process write treats HTTP 200 ok:false RPC payloads as failures', async () => {
  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-owner-blocked',
        version: '01.00.001',
        payload: processTransportFixture(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: withSupabaseAuthBootstrap(async (_url, init) => {
          if (String(init?.method ?? 'GET') === 'GET') {
            return makeResponse({
              ok: true,
              status: 200,
              body: '[{"id":"proc-owner-blocked","version":"01.00.001","user_id":"other-user","state_code":0}]',
            });
          }

          return makeResponse({
            ok: true,
            status: 200,
            body: '{"ok":false,"code":"DATASET_OWNER_REQUIRED","status":403,"message":"Only the dataset owner can save draft changes"}',
          });
        }),
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'DATASET_OWNER_REQUIRED');
      assert.match(error.message, /Only the dataset owner can save draft changes/u);
      return true;
    },
  );
});

test('state-aware process write falls back to dataset create when no exact visible row exists', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  const result = await syncStateAwareProcessRecord({
    id: 'proc-new',
    version: '01.00.001',
    payload: processTransportFixture(),
    modelId: 'model-source',
    modelVersion: '01.01.021',
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (_url, init) => {
      observed.push({
        method: String(init?.method ?? 'GET'),
        url: String(_url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (observed.length <= 2) {
        return makeResponse({
          ok: true,
          status: 200,
          body: '[]',
        });
      }

      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"proc-new"}}',
      });
    }),
  });

  assert.deepEqual(
    observed.map((entry) => entry.method),
    ['GET', 'GET', 'POST'],
  );
  assert.match(observed[2]?.url ?? '', /\/functions\/v1\/app_dataset_create$/u);
  assert.deepEqual(JSON.parse(observed[2]?.body ?? '{}'), {
    table: 'processes',
    id: 'proc-new',
    jsonOrdered: processTransportFixture(),
    modelId: 'model-source',
    modelVersion: '01.01.021',
  });
  assert.deepEqual(result, {
    status: 'success',
    operation: 'insert',
  });
});

test('state-aware process create omits model metadata when the caller supplies none', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  await syncStateAwareProcessRecord({
    id: 'proc-independent',
    version: '01.00.001',
    payload: processTransportFixture(),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_API_KEY: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        method: String(init?.method ?? 'GET'),
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (observed.length <= 2) {
        return makeResponse({ ok: true, status: 200, body: '[]' });
      }
      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"proc-independent"}}',
      });
    }),
  });

  assert.deepEqual(JSON.parse(observed[2]?.body ?? '{}'), {
    table: 'processes',
    id: 'proc-independent',
    jsonOrdered: processTransportFixture(),
  });
});

test('state-aware process create accepts an explicit independent model reference', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  await syncStateAwareProcessRecord({
    id: 'proc-explicit-independent',
    version: '01.00.001',
    payload: processTransportFixture(),
    modelId: null,
    modelVersion: null,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_API_KEY: 'key',
    }),
    fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
      observed.push({
        method: String(init?.method ?? 'GET'),
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (observed.length <= 2) {
        return makeResponse({ ok: true, status: 200, body: '[]' });
      }
      return makeResponse({
        ok: true,
        status: 200,
        body: '{"ok":true,"data":{"id":"proc-explicit-independent"}}',
      });
    }),
  });

  assert.deepEqual(JSON.parse(observed[2]?.body ?? '{}'), {
    table: 'processes',
    id: 'proc-explicit-independent',
    jsonOrdered: processTransportFixture(),
  });
});

test('state-aware process write helpers normalize edge-case visible rows', () => {
  assert.equal(
    __testInternals.buildVisibleRowsUrl(
      'https://example.supabase.co/rest/v1',
      'proc-1',
      '01.00.001',
    ),
    'https://example.supabase.co/rest/v1/processes?select=id%2Cversion%2Cuser_id%2Cstate_code&id=eq.proc-1&version=eq.01.00.001',
  );
  assert.equal(
    __testInternals.buildCurrentUserUrl('https://example.supabase.co/rest/v1'),
    'https://example.supabase.co/auth/v1/user',
  );
  assert.deepEqual(
    __testInternals.parseVisibleRows(
      [{ id: 'proc-1', version: '01.00.001', user_id: 'user-1', state_code: 0 }],
      'https://example.com',
    ),
    [{ id: 'proc-1', version: '01.00.001', user_id: 'user-1', state_code: 0 }],
  );
  assert.deepEqual(
    __testInternals.parseVisibleRows(
      [{ id: 7, version: null, user_id: { bad: true }, state_code: 'oops' }],
      'https://example.com',
    ),
    [{ id: '', version: '', user_id: null, state_code: null }],
  );
  assert.deepEqual(
    __testInternals.parseVisibleRows(
      [{ id: '   ', version: '   ', user_id: '   ', state_code: 0 }],
      'https://example.com',
    ),
    [{ id: '', version: '', user_id: null, state_code: 0 }],
  );
  assert.deepEqual(
    __testInternals.visibleDraftRow([
      { id: 'proc-1', version: '01.00.001', user_id: 'user-1', state_code: 100 },
      { id: 'proc-1', version: '01.00.001', user_id: 'user-2', state_code: 0 },
    ]),
    { id: 'proc-1', version: '01.00.001', user_id: 'user-2', state_code: 0 },
  );
  assert.deepEqual(
    __testInternals.visibleDraftRowForTarget(
      [
        { id: 'proc-1', version: '01.00.001', user_id: 'user-2', state_code: 0 },
        { id: 'proc-1', version: '01.00.001', user_id: 'user-1', state_code: 0 },
      ],
      'user-1',
    ),
    { id: 'proc-1', version: '01.00.001', user_id: 'user-1', state_code: 0 },
  );
  assert.equal(
    __testInternals.visibleDraftRowForTarget(
      [{ id: 'proc-1', version: '01.00.001', user_id: 'user-2', state_code: 0 }],
      'user-1',
    ),
    null,
  );
  assert.doesNotThrow(() =>
    __testInternals.assertTargetUserMatchesCurrent({
      targetUserId: null,
      currentUserId: 'user-1',
    }),
  );
  assert.throws(
    () => __testInternals.parseVisibleRows([0], 'https://example.com'),
    /row 0 was not a JSON object/u,
  );
  assert.throws(
    () => __testInternals.parseVisibleRows('bad', 'https://example.com'),
    /was not a JSON array/u,
  );
  assert.match(
    __testInternals.buildUnsupportedVisibleRowError('proc-1', '01.00.001', [
      { id: 'proc-1', version: '01.00.001', user_id: 'user-9', state_code: 100 },
    ]).message,
    /visible_owner=user-9/u,
  );
  assert.match(
    __testInternals.buildUnsupportedVisibleRowError('proc-1', '01.00.001', [
      { id: 'proc-1', version: '01.00.001', user_id: null, state_code: null },
    ]).message,
    /state_code=unknown/u,
  );
  assert.match(
    __testInternals.buildUnsupportedVisibleRowError('proc-1', '01.00.001', []).message,
    /visible_owner=unknown/u,
  );
});

test('state-aware process write rejects unexpected RPC payloads even on HTTP 200', async () => {
  await assert.rejects(
    () =>
      syncStateAwareProcessRecord({
        id: 'proc-draft-invalid',
        version: '01.00.001',
        payload: processTransportFixture(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: withSupabaseAuthBootstrap(async (_url, init) => {
          if (String(init?.method ?? 'GET') === 'GET') {
            return makeResponse({
              ok: true,
              status: 200,
              body: '[{"id":"proc-draft-invalid","version":"01.00.001","user_id":"user-1","state_code":0}]',
            });
          }

          return makeResponse({
            ok: true,
            status: 200,
            body: '[]',
          });
        }),
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_RESPONSE_INVALID');
      assert.match(error.message, /unexpected payload/u);
      return true;
    },
  );
});

test('state-aware Process draft rechecks candidate languages after awaited row observation', async () => {
  const payload = processTransportFixture();
  const root = payload.processDataSet as Record<string, unknown>;
  const info = (root.processInformation as Record<string, unknown>).dataSetInformation as Record<
    string,
    unknown
  >;
  info['common:generalComment'] = [{ '@xml:lang': 'en', '#text': 'Original' }];
  const methods: string[] = [];
  await assert.rejects(
    syncStateAwareProcessRecord({
      id: 'proc-draft',
      version: '01.00.001',
      payload,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuthBootstrap(async (_url, init) => {
        methods.push(String(init?.method ?? 'GET'));
        (info['common:generalComment'] as Record<string, unknown>[]).push({
          '@xml:lang': 'en',
          '#text': 'Additional',
        });
        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"proc-draft","version":"01.00.001","user_id":"user-1","state_code":0}]',
        });
      }),
    }),
    (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.deepEqual(methods, ['GET']);
});
