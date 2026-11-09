import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

const makeDeps = (overrides?: Partial<NodeJS.ProcessEnv>) => ({
  env: buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    TIANGONG_LCA_REGION: 'us-east-1',
    ...overrides,
  }),
  dotEnvStatus,
  fetchImpl: (async (input) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    };
  }) as FetchLike,
});

test('executeCli dispatches dataset maintenance plan, apply, and verify', async () => {
  const deps = makeDeps();
  let observedPlanOptions: unknown = null;
  const planResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      './maintenance-scope.json',
      '--operation',
      'merge-support-aliases',
      '--out-dir',
      './maintenance-run',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenancePlanImpl: async (options) => {
        observedPlanOptions = options;
        return { status: 'ready', marker: 'plan' } as never;
      },
    },
  );
  assert.equal(planResult.exitCode, 0);
  assert.deepEqual(JSON.parse(planResult.stdout), { status: 'ready', marker: 'plan' });
  assert.deepEqual(observedPlanOptions, {
    scopePath: './maintenance-scope.json',
    operation: 'merge-support-aliases',
    outDir: './maintenance-run',
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const derivativePlanResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      './derivative-scope.json',
      '--operation',
      'rebuild-derivatives',
      '--out-dir',
      './derivative-run',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenancePlanImpl: async (options) =>
        ({
          status: 'ready',
          operation: options.operation,
        }) as never,
    },
  );
  assert.equal(derivativePlanResult.exitCode, 0);
  assert.deepEqual(JSON.parse(derivativePlanResult.stdout), {
    status: 'ready',
    operation: 'rebuild-derivatives',
  });

  const approvePlan = 'a'.repeat(64);
  const approveGlobalInboundProof = 'b'.repeat(64);
  let observedApplyOptions: unknown = null;
  const applyResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
      '--timeout-ms',
      '15000',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      approveGlobalInboundProof,
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceApplyImpl: async (options) => {
        observedApplyOptions = options;
        return { status: 'completed', marker: 'apply' } as never;
      },
    },
  );
  assert.equal(applyResult.exitCode, 0);
  assert.deepEqual(JSON.parse(applyResult.stdout), { status: 'completed', marker: 'apply' });
  assert.deepEqual(observedApplyOptions, {
    planPath: './maintenance-run/maintenance-plan.json',
    commit: true,
    approvePlan,
    confirm: 'user@example.com',
    timeoutMs: 15000,
    maxParallel: 8,
    globalInboundProofPath: '/tmp/global-inbound-proof.json',
    approveGlobalInboundProof,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const unknownApply = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
    ],
    {
      ...deps,
      runDatasetMaintenanceApplyImpl: async () => ({ status: 'completed_with_unknowns' }) as never,
    },
  );
  assert.equal(unknownApply.exitCode, 1);

  const incompleteGlobalProof = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
    ],
    deps,
  );
  assert.equal(incompleteGlobalProof.exitCode, 2);
  assert.match(incompleteGlobalProof.stderr, /must be provided together/u);

  const globalProofWithoutParallel = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      approveGlobalInboundProof,
    ],
    deps,
  );
  assert.equal(globalProofWithoutParallel.exitCode, 2);
  assert.match(globalProofWithoutParallel.stderr, /require --max-parallel/u);

  const malformedGlobalProofApproval = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      'BAD',
    ],
    deps,
  );
  assert.equal(malformedGlobalProofApproval.exitCode, 2);
  assert.match(malformedGlobalProofApproval.stderr, /lowercase SHA-256/u);

  let observedVerifyOptions: unknown = null;
  const verifyResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'verify',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--out-dir',
      './maintenance-run/verify',
      '--page-size',
      '100',
      '--timeout-ms',
      '9000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceVerifyImpl: async (options) => {
        observedVerifyOptions = options;
        return { status: 'passed', marker: 'verify' } as never;
      },
    },
  );
  assert.equal(verifyResult.exitCode, 0);
  assert.deepEqual(JSON.parse(verifyResult.stdout), { status: 'passed', marker: 'verify' });
  assert.deepEqual(observedVerifyOptions, {
    planPath: './maintenance-run/maintenance-plan.json',
    outDir: './maintenance-run/verify',
    pageSize: 100,
    timeoutMs: 9000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  const pendingVerify = await executeCli(
    ['dataset', 'maintenance', 'verify', '--plan', './derivative-run/maintenance-plan.json'],
    {
      ...deps,
      runDatasetMaintenanceVerifyImpl: async () => ({ status: 'pending' }) as never,
    },
  );
  assert.equal(pendingVerify.exitCode, 1);
});

test('executeCli dispatches protected maintenance without a retry or dev fallback', async () => {
  const deps = makeDeps();
  const help = await executeCli(['dataset', 'maintenance', 'run-protected', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /at most one admission POST/u);
  assert.match(help.stdout, /never retries admission or falls back to dev/u);

  let observed: unknown = null;
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      './maintenance-plan.json',
      '--freeze',
      './freeze.json',
      '--approval',
      './approval.json',
      '--out-dir',
      './protected-run',
      '--status-only',
      '--wait-seconds',
      '30',
      '--poll-ms',
      '500',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceProtectedImpl: async (options) => {
        observed = options;
        return { status: 'passed', marker: 'protected' } as never;
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'passed', marker: 'protected' });
  assert.deepEqual(observed, {
    planPath: './maintenance-plan.json',
    freezePath: './freeze.json',
    approvalPath: './approval.json',
    outDir: './protected-run',
    commit: false,
    statusOnly: true,
    approveExecution: undefined,
    confirm: undefined,
    waitSeconds: 30,
    pollMs: 500,
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  for (const status of ['pending', 'failed', 'indeterminate'] as const) {
    const nonTerminal = await executeCli(
      [
        'dataset',
        'maintenance',
        'run-protected',
        '--plan',
        'plan.json',
        '--freeze',
        'freeze.json',
        '--approval',
        'approval.json',
        '--out-dir',
        'protected-run',
        '--status-only',
      ],
      {
        ...deps,
        runDatasetMaintenanceProtectedImpl: async () => ({ status }) as never,
      },
    );
    assert.equal(nonTerminal.exitCode, 1, status);
  }

  const conflict = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'protected-run',
      '--commit',
      '--status-only',
    ],
    deps,
  );
  assert.equal(conflict.exitCode, 2);

  const requiredCases = [
    [],
    ['--plan', 'plan.json'],
    ['--plan', 'plan.json', '--freeze', 'freeze.json'],
    ['--plan', 'plan.json', '--freeze', 'freeze.json', '--approval', 'approval.json'],
    [
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'protected-run',
    ],
  ];
  for (const args of requiredCases) {
    const missing = await executeCli(['dataset', 'maintenance', 'run-protected', ...args], deps);
    assert.equal(missing.exitCode, 2, args.join(' '));
  }

  const commitBase = [
    'dataset',
    'maintenance',
    'run-protected',
    '--plan',
    'plan.json',
    '--freeze',
    'freeze.json',
    '--approval',
    'approval.json',
    '--out-dir',
    'protected-run',
    '--commit',
  ];
  assert.equal((await executeCli(commitBase, deps)).exitCode, 2);
  assert.equal(
    (await executeCli([...commitBase, '--approve-execution', 'a'.repeat(64)], deps)).exitCode,
    2,
  );
  const committed = await executeCli(
    [...commitBase, '--approve-execution', 'a'.repeat(64), '--confirm', 'bafudata@126.com'],
    {
      ...deps,
      runDatasetMaintenanceProtectedImpl: async () => ({ status: 'passed' }) as never,
    },
  );
  assert.equal(committed.exitCode, 0);

  for (const args of [
    ['--unknown'],
    ['--wait-seconds', '-1'],
    ['--wait-seconds', 'not-a-number'],
  ]) {
    const invalid = await executeCli(
      [
        'dataset',
        'maintenance',
        'run-protected',
        '--plan',
        'plan.json',
        '--freeze',
        'freeze.json',
        '--approval',
        'approval.json',
        '--out-dir',
        'protected-run',
        '--status-only',
        ...args,
      ],
      deps,
    );
    assert.equal(invalid.exitCode, 2, args.join(' '));
  }
});

test('executeCli exposes the dedicated flow-identity capture/plan/freeze/seal/run/verify workflow', async () => {
  const deps = makeDeps();
  const help = await executeCli(['dataset', 'maintenance', 'flow-identity', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(
    help.stdout,
    /capture\|plan\|freeze\|seal-approval\|run\|freeze-recovery\|seal-recovery-approval\|run-recovery\|verify/u,
  );
  assert.match(help.stdout, /never retry a process/u);
  assert.match(help.stdout, /separate plan, new freeze, and new exact human approval/u);

  let observed: unknown = null;
  const capture = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'capture',
      '--policy',
      'policy.json',
      '--review-ledger',
      'review.json',
      '--prerequisites',
      'prerequisites.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--request-id',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '--operation-id',
      'flow-identity-v2-capture',
      '--expected-project-ref',
      'prod',
      '--confirm',
      'owner@example.com',
      '--sdk-version',
      '0.1.45',
      '--out-dir',
      'capture-out',
      '--page-size',
      '1000',
      '--read-concurrency',
      '5',
      '--json',
    ],
    {
      ...deps,
      captureFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'captured' } as never;
      },
    },
  );
  assert.equal(capture.exitCode, 0);
  assert.deepEqual(observed, {
    policyPath: 'policy.json',
    reviewLedgerPath: 'review.json',
    prerequisitesPath: 'prerequisites.json',
    toolchainEvidencePath: 'toolchain.json',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: 'flow-identity-v2-capture',
    expectedProjectRef: 'prod',
    confirm: 'owner@example.com',
    cliVersion: '0.1.29',
    sdkVersion: '0.1.45',
    outDir: 'capture-out',
    pageSize: 1000,
    readConcurrency: 5,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const plan = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'plan',
      '--policy',
      'policy.json',
      '--review-ledger',
      'review.json',
      '--live-capture',
      'capture.json',
      '--out-dir',
      'plan-out',
      '--json',
    ],
    {
      ...deps,
      runFlowIdentityPlanFromFilesImpl: (options) => {
        observed = options;
        return { status: 'ready', plan_sha256: 'a'.repeat(64) } as never;
      },
    },
  );
  assert.equal(plan.exitCode, 0);
  assert.deepEqual(observed, {
    policyPath: 'policy.json',
    reviewLedgerPath: 'review.json',
    liveCapturePath: 'capture.json',
    outDir: 'plan-out',
  });

  const freeze = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'freeze',
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--approved-at',
      '2026-07-16T05:00:00Z',
      '--expected-project-ref',
      'prod',
      '--confirm',
      'owner@example.com',
      '--out-dir',
      'freeze-out',
      '--json',
    ],
    {
      ...deps,
      freezeFlowIdentityImpl: (options) => {
        observed = options;
        return { status: 'frozen' } as never;
      },
    },
  );
  assert.equal(freeze.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    toolchainEvidencePath: 'toolchain.json',
    approvedAtUtc: '2026-07-16T05:00:00Z',
    expectedProjectRef: 'prod',
    confirm: 'owner@example.com',
    cliVersion: '0.1.29',
    outDir: 'freeze-out',
  });

  const hash = 'a'.repeat(64);
  const seal = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'seal-approval',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval-request',
      'request.json',
      '--human-approval',
      'human.txt',
      '--approve-freeze-file',
      hash,
      '--approve-request',
      hash,
      '--approve-text',
      hash,
      '--confirm',
      'owner@example.com',
      '--approved-at',
      '2026-07-16T05:00:00Z',
      '--out-dir',
      'approval-out',
      '--json',
    ],
    {
      ...deps,
      sealFlowIdentityApprovalImpl: (options) => {
        observed = options;
        return { status: 'sealed' } as never;
      },
    },
  );
  assert.equal(seal.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalRequestPath: 'request.json',
    humanApprovalPath: 'human.txt',
    approveFreezeFile: hash,
    approveRequest: hash,
    approveText: hash,
    confirm: 'owner@example.com',
    approvedAtUtc: '2026-07-16T05:00:00Z',
    outDir: 'approval-out',
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
      '--status-only',
      '--wait-seconds',
      '0',
      '--json',
    ],
    {
      ...deps,
      runFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'pending' } as never;
      },
    },
  );
  assert.equal(run.exitCode, 1);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    outDir: 'run-out',
    commit: false,
    statusOnly: true,
    approveExecution: undefined,
    confirm: undefined,
    waitSeconds: 0,
    pollMs: undefined,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
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
      '--page-size',
      '250',
      '--json',
    ],
    {
      ...deps,
      verifyFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'passed' } as never;
      },
    },
  );
  assert.equal(verify.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    runDir: 'run-out',
    outDir: 'verify-out',
    pageSize: 250,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
});
