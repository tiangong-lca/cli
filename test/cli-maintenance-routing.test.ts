import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import type { DotEnvLoadResult } from '../src/lib/config/dotenv.js';
import type { FetchLike } from '../src/lib/transport/http.js';
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
      'repair-references',
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
    operation: 'repair-references',
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
