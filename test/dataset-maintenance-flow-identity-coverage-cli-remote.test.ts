import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli, type CliDeps } from '../src/cli.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  applyMaintenanceAliasPlan,
  attestMaintenanceFlowIdentityCapture,
  fetchMaintenanceAccountTableRows,
  finalizeMaintenanceFlowIdentityScope,
  isMaintenanceRpcDomainFailure,
  lookupMaintenanceFlowIdentityScope,
  preflightMaintenanceFlowIdentityScope,
  readMaintenanceFlowIdentityScope,
  recoverMaintenanceFlowIdentityScope,
  rewriteMaintenanceFlowIdentityProcess,
  type DatasetMaintenanceRemoteContext,
  __testInternals as remoteTestInternals,
} from '../src/lib/dataset-maintenance-remote.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

function response(value: unknown, contentRange?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(contentRange ? { 'content-range': contentRange } : {}),
    },
  });
}

function remoteContext(fetchImpl: FetchLike): DatasetMaintenanceRemoteContext {
  return {
    project_ref: 'production-ref',
    rest_base_url: 'https://production-ref.supabase.co/rest/v1',
    publishable_key: 'publishable',
    access_token: 'access',
    account: {
      user_id: 'owner-id',
      email: 'owner@example.com',
      session_source: 'test',
    },
    fetch_impl: fetchImpl,
    timeout_ms: 1_000,
  };
}

function cliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: {},
    dotEnvStatus,
    fetchImpl: (async () => response({ ok: true })) as FetchLike,
    ...overrides,
  };
}

test('maintenance requests preserve every HeadersInit shape while adding auth and profile headers', async () => {
  const observed: Headers[] = [];
  const context = remoteContext(async (_input, init) => {
    observed.push(new Headers(init?.headers));
    return response({ ok: true });
  });

  for (const headers of [
    new Headers([
      ['Prefer', 'count=exact'],
      ['X-Request-Shape', 'headers'],
    ]),
    [
      ['Prefer', 'return=representation'],
      ['X-Request-Shape', 'tuples'],
    ] satisfies Array<[string, string]>,
  ]) {
    await remoteTestInternals.fetchJsonResponse({
      context,
      url: `${context.rest_base_url}/flows`,
      init: { headers },
      label: 'header normalization regression',
    });
  }

  assert.equal(observed.length, 2);
  assert.deepEqual(
    observed.map((headers) => ({
      accept: headers.get('accept'),
      authorization: headers.get('authorization'),
      apikey: headers.get('apikey'),
      profile: headers.get('accept-profile'),
      prefer: headers.get('prefer'),
      shape: headers.get('x-request-shape'),
    })),
    [
      {
        accept: 'application/json',
        authorization: 'Bearer access',
        apikey: 'publishable',
        profile: 'public',
        prefer: 'count=exact',
        shape: 'headers',
      },
      {
        accept: 'application/json',
        authorization: 'Bearer access',
        apikey: 'publishable',
        profile: 'public',
        prefer: 'return=representation',
        shape: 'tuples',
      },
    ],
  );
});

test('flow-identity single-table remote census preserves exact pagination fences', async () => {
  const urls: URL[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const withStateFence = url.searchParams.get('state_code') === 'eq.0';
    const rows = withStateFence
      ? [
          {
            id: '00000000-0000-4000-8000-000000000001',
            version: '00.00.001',
            user_id: 'owner-id',
            state_code: 0,
            modified_at: '2026-07-16T00:00:00.000Z',
            json: { flowDataSet: {} },
            json_ordered: { flowDataSet: {} },
            rule_verification: true,
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            version: '00.00.001',
            user_id: 'owner-id',
            state_code: 0,
            modified_at: '2026-07-16T00:00:01.000Z',
            json: { flowDataSet: { second: true } },
            json_ordered: { flowDataSet: { second: true } },
            rule_verification: false,
          },
        ]
      : [
          {
            id: '00000000-0000-4000-8000-000000000003',
            version: '00.00.001',
            user_id: 'owner-id',
            state_code: 100,
            modified_at: '2026-07-16T00:00:02.000Z',
            json_ordered: { flowDataSet: { third: true } },
            rule_verification: null,
          },
        ];
    return response(rows, `0-${rows.length - 1}/${rows.length}`);
  };
  const context = remoteContext(fetchImpl);

  const ownerDraft = await fetchMaintenanceAccountTableRows({
    context,
    userId: 'owner-id',
    table: 'flows',
    stateCode: 0,
    includeJson: true,
    pageSize: 2,
  });
  const allStates = await fetchMaintenanceAccountTableRows({
    context,
    userId: 'owner-id',
    table: 'flows',
    pageSize: 2,
  });

  assert.equal(ownerDraft.rows.length, 2);
  assert.deepEqual(
    ownerDraft.rows.map((row) => row.json),
    [{ flowDataSet: {} }, { flowDataSet: { second: true } }],
  );
  assert.equal(ownerDraft.completeness.rows_fetched, 2);
  assert.equal(allStates.rows.length, 1);
  assert.equal(allStates.completeness.rows_fetched, 1);
  assert.equal(urls.length, 2);
  assert.equal(urls[0]?.searchParams.get('state_code'), 'eq.0');
  assert.equal(urls[0]?.searchParams.get('select')?.includes('json,'), true);
  assert.equal(urls[1]?.searchParams.has('state_code'), false);
  assert.equal(urls[1]?.searchParams.get('select')?.includes('json,'), false);
  assert.deepEqual(
    urls.map((url) => [url.searchParams.get('limit'), url.searchParams.get('offset')]),
    [
      ['2', '0'],
      ['2', '0'],
    ],
  );

  await assert.rejects(
    fetchMaintenanceAccountTableRows({
      context: remoteContext((async () =>
        response(
          [
            {
              id: '00000000-0000-4000-8000-000000000004',
              version: '00.00.001',
              user_id: 'foreign-owner',
              state_code: 100,
              modified_at: '2026-07-16T00:00:03.000Z',
              json_ordered: { flowDataSet: {} },
              rule_verification: null,
            },
          ],
          '0-0/1',
        )) as FetchLike),
      userId: 'owner-id',
      table: 'flows',
      stateCode: 0,
      pageSize: 2,
    }),
    /account\/state fence/u,
  );
});

test('flow-identity remote RPC adapters bind wire bodies, timeouts, and domain failures', async () => {
  const calls: Array<{ rpc: string; body: unknown }> = [];
  const timeouts: number[] = [];
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((milliseconds: number) => {
    timeouts.push(milliseconds);
    return originalTimeout(1_000);
  }) as typeof AbortSignal.timeout;
  const fetchImpl: FetchLike = async (input, init) => {
    const rpc = String(input).split('/rpc/')[1] ?? '';
    calls.push({ rpc, body: JSON.parse(String(init?.body)) });
    return response(
      rpc === 'cmd_dataset_flow_identity_scope_finalize_guarded'
        ? { ok: true }
        : {
            ok: false,
            command: rpc,
            schema_version: 'dataset-flow-identity-domain-rejection.v1',
            code: `FLOW_IDENTITY_${rpc.toUpperCase()}_REJECTED`,
            status: 409,
            message: 'deterministic domain rejection',
          },
    );
  };
  const context = remoteContext(fetchImpl);
  const scopeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  try {
    const preflight = await preflightMaintenanceFlowIdentityScope({
      context,
      request: { operation_id: 'operation-1' },
    });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.status, 409);
    const lookup = await lookupMaintenanceFlowIdentityScope({
      context,
      request: { request_id: 'lookup-request-1' },
    });
    assert.equal(lookup.ok, false);
    assert.equal(lookup.status, 409);
    const rewrite = await rewriteMaintenanceFlowIdentityProcess({
      context,
      scopeId,
      request: { ordinal: 1 },
      authorization: {
        schema_version: 'dataset-flow-identity-execution-permit.v1',
        invocation_id: '11111111-1111-4111-8111-111111111111',
        generation: 0,
        token: 'a'.repeat(64),
      },
    });
    assert.equal(rewrite.ok, false);
    assert.equal(rewrite.status, 409);
    const read = await readMaintenanceFlowIdentityScope({ context, scopeId });
    assert.equal(read.ok, false);
    assert.equal(read.status, 409);
    const recovery = await recoverMaintenanceFlowIdentityScope({
      context,
      scopeId,
      request: { schema_version: 'dataset-flow-identity-scope-recovery.v1' },
    });
    assert.equal(recovery.ok, false);
    assert.equal(recovery.status, 409);
    await finalizeMaintenanceFlowIdentityScope({
      context,
      scopeId,
      request: { finalize: true },
      authorization: {
        schema_version: 'dataset-flow-identity-execution-permit.v1',
        invocation_id: '11111111-1111-4111-8111-111111111111',
        generation: 1,
        token: 'b'.repeat(64),
      },
    });
    const capture = await attestMaintenanceFlowIdentityCapture({
      context,
      request: { request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    });
    assert.equal(capture.ok, false);
    assert.equal(capture.status, 409);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.deepEqual(
    calls.map(({ rpc }) => rpc),
    [
      'cmd_dataset_flow_identity_scope_preflight_guarded',
      'cmd_dataset_flow_identity_scope_lookup',
      'cmd_dataset_flow_identity_process_rewrite_guarded',
      'cmd_dataset_flow_identity_scope_read',
      'cmd_dataset_flow_identity_scope_recover_guarded',
      'cmd_dataset_flow_identity_scope_finalize_guarded',
      'cmd_dataset_flow_identity_capture_attest_guarded',
    ],
  );
  assert.deepEqual(
    calls.map(({ body }) => body),
    [
      { p_request: { operation_id: 'operation-1' } },
      { p_request: { request_id: 'lookup-request-1' } },
      {
        p_scope_id: scopeId,
        p_request: { ordinal: 1 },
        p_authorization: {
          schema_version: 'dataset-flow-identity-execution-permit.v1',
          invocation_id: '11111111-1111-4111-8111-111111111111',
          generation: 0,
          token: 'a'.repeat(64),
        },
      },
      { p_scope_id: scopeId },
      {
        p_scope_id: scopeId,
        p_request: { schema_version: 'dataset-flow-identity-scope-recovery.v1' },
      },
      {
        p_scope_id: scopeId,
        p_request: { finalize: true },
        p_authorization: {
          schema_version: 'dataset-flow-identity-execution-permit.v1',
          invocation_id: '11111111-1111-4111-8111-111111111111',
          generation: 1,
          token: 'b'.repeat(64),
        },
      },
      { p_request: { request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
    ],
  );
  assert.deepEqual(timeouts, [130_000, 90_000, 90_000, 90_000, 130_000, 190_000, 190_000]);
  assert.equal(
    isMaintenanceRpcDomainFailure({ ok: false, code: 'STRING_STATUS', status: 'rejected' }),
    true,
  );
  assert.equal(isMaintenanceRpcDomainFailure({ ok: false, code: '', status: 409 }), false);
});

test('flow-identity RPC errors never expose bearer permits in structured details', async () => {
  const token = 'permit-token-must-never-escape';
  await assert.rejects(
    preflightMaintenanceFlowIdentityScope({
      context: remoteContext(async () =>
        response({
          ok: 'unexpected',
          execution_permit: { token },
        }),
      ),
      request: { operation_id: 'redacted-unexpected-response' },
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const cliError = error as CliError;
      assert.equal(cliError.code, 'DATASET_MAINTENANCE_RPC_FAILED');
      assert.deepEqual(cliError.details, {
        rpc: 'cmd_dataset_flow_identity_scope_preflight_guarded',
        response_redacted: true,
      });
      assert.equal(JSON.stringify(cliError.details).includes(token), false);
      return true;
    },
  );

  await assert.rejects(
    preflightMaintenanceFlowIdentityScope({
      context: remoteContext(async () => response({ ok: 'unexpected-without-permit' })),
      request: { operation_id: 'redacted-generic-unexpected-response' },
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const cliError = error as CliError;
      assert.equal(cliError.code, 'DATASET_MAINTENANCE_RPC_FAILED');
      assert.deepEqual(cliError.details, {
        rpc: 'cmd_dataset_flow_identity_scope_preflight_guarded',
        response_redacted: true,
      });
      return true;
    },
  );

  await assert.rejects(
    attestMaintenanceFlowIdentityCapture({
      context: remoteContext(async () =>
        response({
          ok: false,
          code: 'FLOW_IDENTITY_CAPTURE_REJECTED',
          status: 409,
          execution_permit: { token },
        }),
      ),
      request: { request_id: 'malformed-domain-rejection' },
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const cliError = error as CliError;
      assert.equal(cliError.code, 'DATASET_MAINTENANCE_RPC_FAILED');
      assert.deepEqual(cliError.details, {
        rpc: 'cmd_dataset_flow_identity_capture_attest_guarded',
        response_redacted: true,
      });
      assert.equal(JSON.stringify(cliError.details).includes(token), false);
      return true;
    },
  );

  await assert.rejects(
    preflightMaintenanceFlowIdentityScope({
      context: remoteContext(
        async () =>
          new Response(JSON.stringify({ execution_permit: { token } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      request: { operation_id: 'redacted-http-response' },
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      const cliError = error as CliError;
      assert.equal(cliError.code, 'DATASET_MAINTENANCE_REMOTE_REQUEST_FAILED');
      assert.deepEqual(cliError.details, {
        url: 'https://production-ref.supabase.co/rest/v1/rpc/cmd_dataset_flow_identity_scope_preflight_guarded',
        response_redacted: true,
      });
      assert.equal(JSON.stringify(cliError.details).includes(token), false);
      return true;
    },
  );
});

test('non-flow maintenance errors retain diagnostics and retire the private alias executor', async () => {
  await assert.rejects(
    fetchMaintenanceAccountTableRows({
      context: remoteContext(
        async () =>
          new Response('legacy row diagnostic', {
            status: 500,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      userId: 'owner-id',
      table: 'flows',
      stateCode: 0,
      pageSize: 2,
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      assert.deepEqual((error as CliError).details, {
        url: 'https://production-ref.supabase.co/rest/v1/flows?select=id%2Cversion%2Cuser_id%2Cstate_code%2Cmodified_at%2Cjson_ordered%2Crule_verification&user_id=eq.owner-id&state_code=eq.0&order=id.asc%2Cversion.asc&limit=2&offset=0',
        response: 'legacy row diagnostic',
      });
      return true;
    },
  );

  await assert.rejects(
    applyMaintenanceAliasPlan({
      context: remoteContext(async () => response({ ok: true })),
      plan: { plan_sha256: 'legacy-plan' },
    }),
    (error) => {
      assert.equal(error instanceof CliError, true);
      assert.equal((error as CliError).code, 'DATASET_MAINTENANCE_PROTECTED_RUN_REQUIRED');
      assert.deepEqual((error as CliError).details, {
        replacement_capabilities: [
          'cmd_dataset_alias_execution_preflight_guarded',
          'cmd_dataset_alias_execution_gate_guarded',
          'cmd_dataset_alias_execution_admit_guarded',
          'cmd_dataset_alias_execution_read',
        ],
      });
      return true;
    },
  );
});

test('flow-identity CLI exposes parser and fail-closed command guards', async () => {
  const deps = cliDeps();
  const noAction = await executeCli(['dataset', 'maintenance', 'flow-identity'], deps);
  assert.equal(noAction.exitCode, 0);
  assert.match(noAction.stdout, /freeze-recovery\|seal-recovery-approval\|run-recovery/u);

  const actionHelp = await executeCli(
    ['dataset', 'maintenance', 'flow-identity', 'capture', '--help'],
    deps,
  );
  assert.equal(actionHelp.exitCode, 0);

  const parseFailure = await executeCli(
    ['dataset', 'maintenance', 'flow-identity', 'capture', '--unknown'],
    deps,
  );
  assert.equal(parseFailure.exitCode, 2);
  assert.match(parseFailure.stderr, /INVALID_ARGS/u);

  const missingRequired = await executeCli(
    ['dataset', 'maintenance', 'flow-identity', 'capture'],
    deps,
  );
  assert.equal(missingRequired.exitCode, 2);
  assert.match(missingRequired.stderr, /DATASET_FLOW_IDENTITY_ARGUMENT_REQUIRED/u);

  const invalidRunMode = await executeCli(['dataset', 'maintenance', 'flow-identity', 'run'], deps);
  assert.equal(invalidRunMode.exitCode, 2);
  assert.match(invalidRunMode.stderr, /DATASET_FLOW_IDENTITY_RUN_MODE_INVALID/u);

  const invalidAction = await executeCli(
    ['dataset', 'maintenance', 'flow-identity', 'not-an-action'],
    deps,
  );
  assert.equal(invalidAction.exitCode, 2);
  assert.match(invalidAction.stderr, /DATASET_FLOW_IDENTITY_ACTION_INVALID/u);
});

test('flow-identity CLI commit and failed verify branches use injected implementations', async () => {
  let runOptions: unknown;
  const runDeps = cliDeps({
    runFlowIdentityImpl: async (options) => {
      runOptions = options;
      return { status: 'passed' } as never;
    },
  });
  const run = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'run',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'run-out',
      '--commit',
      '--approve-execution',
      'approval-hash',
      '--confirm',
      'owner@example.com',
      '--poll-ms',
      '25',
      '--timeout-ms',
      '5000',
      '--json',
    ],
    runDeps,
  );
  assert.equal(run.exitCode, 0);
  assert.deepEqual(runOptions, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    outDir: 'run-out',
    commit: true,
    statusOnly: false,
    approveExecution: 'approval-hash',
    confirm: 'owner@example.com',
    waitSeconds: undefined,
    pollMs: 25,
    timeoutMs: 5000,
    env: {},
    fetchImpl: runDeps.fetchImpl,
  });

  let verifyOptions: unknown;
  const deps = cliDeps({
    verifyFlowIdentityImpl: async (options) => {
      verifyOptions = options;
      return { status: 'failed' } as never;
    },
  });
  const verify = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'verify',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--run-dir',
      'run-out',
      '--out-dir',
      'verify-out',
    ],
    deps,
  );
  assert.equal(verify.exitCode, 1);
  assert.deepEqual(verifyOptions, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    runDir: 'run-out',
    outDir: 'verify-out',
    pageSize: undefined,
    timeoutMs: undefined,
    env: {},
    fetchImpl: deps.fetchImpl,
  });
});

test('flow-identity CLI dispatches all recovery actions with exact options', async () => {
  const invalidReason = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'freeze-recovery',
      '--recovery-reason',
      'not-allowed',
    ],
    cliDeps(),
  );
  assert.equal(invalidReason.exitCode, 2);
  assert.match(invalidReason.stderr, /DATASET_FLOW_IDENTITY_RECOVERY_REASON_INVALID/u);

  let freezeOptions: unknown;
  const freezeDeps = cliDeps({
    freezeFlowIdentityRecoveryImpl: async (options) => {
      freezeOptions = options;
      return { status: 'frozen' } as never;
    },
  });
  const freeze = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'freeze-recovery',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--run-dir',
      'prior-run',
      '--toolchain-evidence',
      'toolchain.json',
      '--expected-project-ref',
      'production-ref',
      '--confirm',
      'owner@example.com',
      '--approved-at',
      '2026-07-16T05:20:00.000Z',
      '--recovery-reason',
      'process_response_ambiguous',
      '--out-dir',
      'recovery-freeze-out',
      '--timeout-ms',
      '5000',
    ],
    freezeDeps,
  );
  assert.equal(freeze.exitCode, 0);
  assert.deepEqual(freezeOptions, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    runDir: 'prior-run',
    toolchainEvidencePath: 'toolchain.json',
    expectedProjectRef: 'production-ref',
    confirm: 'owner@example.com',
    approvedAtUtc: '2026-07-16T05:20:00.000Z',
    recoveryReason: 'process_response_ambiguous',
    cliVersion: '0.1.19',
    outDir: 'recovery-freeze-out',
    timeoutMs: 5000,
    env: {},
    fetchImpl: freezeDeps.fetchImpl,
  });

  let sealOptions: unknown;
  const sealDeps = cliDeps({
    sealFlowIdentityRecoveryApprovalImpl: (options) => {
      sealOptions = options;
      return { status: 'sealed' } as never;
    },
  });
  const seal = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'seal-recovery-approval',
      '--recovery-freeze',
      'recovery-freeze.json',
      '--approval-request',
      'recovery-request.json',
      '--human-approval',
      'human.txt',
      '--approve-freeze-file',
      'freeze-file-hash',
      '--approve-request',
      'request-hash',
      '--approve-text',
      'text-hash',
      '--confirm',
      'owner@example.com',
      '--approved-at',
      '2026-07-16T05:20:00.000Z',
      '--out-dir',
      'recovery-approval-out',
    ],
    sealDeps,
  );
  assert.equal(seal.exitCode, 0);
  assert.deepEqual(sealOptions, {
    recoveryFreezePath: 'recovery-freeze.json',
    approvalRequestPath: 'recovery-request.json',
    humanApprovalPath: 'human.txt',
    approveFreezeFile: 'freeze-file-hash',
    approveRequest: 'request-hash',
    approveText: 'text-hash',
    confirm: 'owner@example.com',
    approvedAtUtc: '2026-07-16T05:20:00.000Z',
    outDir: 'recovery-approval-out',
  });

  const invalidRunMode = await executeCli(
    ['dataset', 'maintenance', 'flow-identity', 'run-recovery', '--status-only'],
    cliDeps(),
  );
  assert.equal(invalidRunMode.exitCode, 2);
  assert.match(invalidRunMode.stderr, /DATASET_FLOW_IDENTITY_RECOVERY_RUN_MODE_INVALID/u);

  let runOptions: unknown;
  const runDeps = cliDeps({
    runFlowIdentityImpl: async (options) => {
      runOptions = options;
      return { status: 'passed' } as never;
    },
  });
  const runArgs = [
    'dataset',
    'maintenance',
    'flow-identity',
    'run-recovery',
    '--plan',
    'plan.json',
    '--freeze',
    'freeze.json',
    '--approval',
    'approval.json',
    '--run-dir',
    'prior-run',
    '--recovery-freeze',
    'recovery-freeze.json',
    '--recovery-approval',
    'recovery-approval.json',
    '--out-dir',
    'recovery-run-out',
    '--commit',
    '--approve-execution',
    'recovery-approval-hash',
    '--confirm',
    'owner@example.com',
    '--wait-seconds',
    '15',
    '--poll-ms',
    '250',
    '--timeout-ms',
    '5000',
  ];
  const run = await executeCli(runArgs, runDeps);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(runOptions, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    recoveryRunDir: 'prior-run',
    recoveryFreezePath: 'recovery-freeze.json',
    recoveryApprovalPath: 'recovery-approval.json',
    outDir: 'recovery-run-out',
    commit: true,
    statusOnly: false,
    approveExecution: 'recovery-approval-hash',
    confirm: 'owner@example.com',
    waitSeconds: 15,
    pollMs: 250,
    timeoutMs: 5000,
    env: {},
    fetchImpl: runDeps.fetchImpl,
  });

  const pendingRun = await executeCli(
    runArgs,
    cliDeps({
      runFlowIdentityImpl: async () => ({ status: 'pending' }) as never,
    }),
  );
  assert.equal(pendingRun.exitCode, 1);
});
