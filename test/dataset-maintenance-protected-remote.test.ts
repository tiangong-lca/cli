import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitMaintenanceAliasExecution,
  captureMaintenanceAliasExecutionGate,
  fetchMaintenanceDerivativeTargetRows,
  preflightMaintenanceAliasExecution,
  preflightMaintenanceAliasExecutionV2,
  readMaintenanceAliasExecution,
  type DatasetMaintenanceRemoteContext,
} from '../src/lib/dataset-maintenance-remote.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function context(fetchImpl: FetchLike): DatasetMaintenanceRemoteContext {
  return {
    project_ref: 'production-ref',
    rest_base_url: 'https://production-ref.supabase.co/rest/v1',
    publishable_key: 'publishable',
    access_token: 'access',
    account: {
      user_id: 'user-1',
      email: 'bafudata@126.com',
      session_source: 'credentials',
    },
    fetch_impl: fetchImpl,
    timeout_ms: 1_000,
  };
}

test('protected alias preflight checks only desired localized fields before either version dispatches', async () => {
  const duplicate = {
    'common:generalComment': [
      { '@xml:lang': 'en', '#text': 'Original explanation.' },
      { '@xml:lang': 'en', '#text': 'Additional limitation.', '@index': '2' },
    ],
  };
  for (const preflight of [
    preflightMaintenanceAliasExecution,
    preflightMaintenanceAliasExecutionV2,
  ]) {
    const calls: unknown[] = [];
    const remote = context(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return response({ ok: true });
    });
    const actions = [{ desired_json_ordered: duplicate }];
    const request = {
      plan:
        preflight === preflightMaintenanceAliasExecution ? { batches: [{ actions }] } : { actions },
    };
    const original = JSON.stringify(request);
    await assert.rejects(
      preflight({ context: remote, request }),
      (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
    );
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(request), original);
    const repairedRequest = {
      plan: {
        batches: [
          { actions: [null, { expected_json_ordered: duplicate, desired_json_ordered: {} }] },
        ],
      },
    };
    await preflight({ context: remote, request: repairedRequest });
    assert.deepEqual(calls, [{ p_request: repairedRequest }]);
  }
});

test('protected maintenance remote adapters call only the public guarded RPC surface', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const timeouts: number[] = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds);
    return originalTimeout(1_000);
  }) as typeof AbortSignal.timeout;
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return response({ ok: true });
  };
  const remote = context(fetchImpl);
  try {
    await preflightMaintenanceAliasExecution({ context: remote, request: { sealed: true } });
    await captureMaintenanceAliasExecutionGate({
      context: remote,
      requestId: 'request-1',
      preflightToken: 'token-1',
      gateName: 'primary_support_plan',
    });
    await admitMaintenanceAliasExecution({ context: remote, request: { admitted: true } });
    await readMaintenanceAliasExecution({ context: remote, requestId: 'request-1' });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(
    calls.map(({ url }) => url.split('/rpc/')[1]),
    [
      'cmd_dataset_alias_execution_preflight_guarded',
      'cmd_dataset_alias_execution_gate_guarded',
      'cmd_dataset_alias_execution_admit_guarded',
      'cmd_dataset_alias_execution_read',
    ],
  );
  assert.deepEqual(
    calls.map(({ body }) => body),
    [
      { p_request: { sealed: true } },
      {
        p_request_id: 'request-1',
        p_preflight_token: 'token-1',
        p_gate_name: 'primary_support_plan',
      },
      { p_request: { admitted: true } },
      { p_request_id: 'request-1' },
    ],
  );
  assert.equal(
    calls.some(({ url }) => url.includes('execution_execute')),
    false,
  );
  assert.equal(
    calls.some(({ url }) => url.includes('alias_plan_guarded')),
    false,
  );
  assert.deepEqual(timeouts, [90_000, 90_000, 90_000, 90_000]);
});

test('protected derivative raw read is bounded, exact, and identity checked', async () => {
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    const table = url.pathname.endsWith('/flows') ? 'flows' : 'processes';
    const id = String(url.searchParams.get('id')).replace(/^eq\./u, '');
    const version = String(url.searchParams.get('version')).replace(/^eq\./u, '');
    return response([
      {
        id,
        version,
        user_id: 'user-1',
        state_code: 0,
        json_ordered: {},
        extracted_md: 'markdown',
        embedding_ft: [1],
        embedding_ft_at: '2026-07-15T00:00:00.000Z',
        table,
      },
    ]);
  };
  const result = await fetchMaintenanceDerivativeTargetRows({
    context: context(fetchImpl),
    concurrency: 1,
    targets: [
      { table: 'flows', id: 'flow-1', version: '00.00.001' },
      { table: 'processes', id: 'process-1', version: '00.00.001' },
    ],
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.source_urls.length, 2);
  assert.deepEqual(
    result.rows.map(({ table, id }) => ({ table, id })),
    [
      { table: 'flows', id: 'flow-1' },
      { table: 'processes', id: 'process-1' },
    ],
  );

  for (const concurrency of [0, 1.5, 11]) {
    await assert.rejects(
      fetchMaintenanceDerivativeTargetRows({
        context: context(fetchImpl),
        concurrency,
        targets: [],
      }),
      /concurrency/u,
    );
  }
  await assert.rejects(
    fetchMaintenanceDerivativeTargetRows({
      context: context(fetchImpl),
      targets: Array.from({ length: 51 }, (_, index) => ({
        table: 'flows' as const,
        id: `flow-${index}`,
        version: '00.00.001',
      })),
    }),
    /bounded to 50/u,
  );

  for (const payload of [null, [], [null]]) {
    await assert.rejects(
      fetchMaintenanceDerivativeTargetRows({
        context: context((async () => response(payload)) as FetchLike),
        targets: [{ table: 'flows', id: 'flow-1', version: '00.00.001' }],
      }),
      /missing, duplicated, or malformed/u,
    );
  }
  await assert.rejects(
    fetchMaintenanceDerivativeTargetRows({
      context: context((async () =>
        response([
          { id: 'foreign', version: '00.00.001', user_id: '', state_code: 'bad' },
        ])) as FetchLike),
      targets: [{ table: 'flows', id: 'flow-1', version: '00.00.001' }],
    }),
    /identity was malformed/u,
  );
});
