import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CHILD_ENV = 'TIANGONG_LCA_DEFAULT_WIRING_TEST_CHILD';

if (process.env[CHILD_ENV] !== '1') {
  const executionContractParentCoverageSeedUrl = new URL(
    '../src/lib/dataset-maintenance-flow-identity-execution-contract.js?default-wiring-parent-coverage-seed',
    import.meta.url,
  ).href;
  await import(executionContractParentCoverageSeedUrl);
  test('default flow-identity wiring is exercised in an isolated child', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url)],
      {
        cwd: process.cwd(),
        env: { ...process.env, [CHILD_ENV]: '1', NO_COLOR: '1' },
        encoding: 'utf8',
      },
    );
    assert.equal(
      result.status,
      0,
      `isolated default-wiring child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /tests 3/u);
  });
} else {
  const HASH = (character: string): string => character.repeat(64);
  const ACTOR = '11111111-1111-4111-8111-111111111111';
  const SCOPE_ID = '22222222-2222-4222-8222-222222222222';
  const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
  const PROJECT_REF = 'production-project';
  const EMAIL = 'bafudata@example.com';

  const plan = {
    project_ref: PROJECT_REF,
    account: { user_id: ACTOR, email: EMAIL },
    operation_id: 'default-wiring-test',
    plan_sha256: HASH('1'),
    processes: [],
  };
  const freeze = { freeze_sha256: HASH('2') };
  const approval = {
    execution_approval_request_sha256: HASH('3'),
    execution_approval_text_sha256: HASH('4'),
    execution_approval_identity_sha256: HASH('5'),
  };
  const identity = {
    request_id: REQUEST_ID,
    identity_sha256: HASH('6'),
  };
  const scope = {
    ok: true,
    schema_version: 'dataset-flow-identity-scope-preflight-result.v2',
    scope_id: SCOPE_ID,
    scope_proof_sha256: HASH('7'),
  };

  const executionContractMockSource = `
const plan = ${JSON.stringify(plan)};
const freeze = ${JSON.stringify(freeze)};
const approval = ${JSON.stringify(approval)};
const identity = ${JSON.stringify(identity)};
const scope = ${JSON.stringify(scope)};
function status(kind) {
  const completed = kind === 'run-completed';
  return {
    ok: true,
    status: completed ? 'completed' : 'sealed',
    completed_process_count: 0,
    next_ordinal: 1,
    primary_complete: completed,
    primary_current: true,
    live_guard_current: true,
    protected_closure_current: true,
    derivatives_current: completed,
    whole_scope_proof_sha256: '${HASH('8')}',
    compensation_required: false,
    processes: [],
  };
}
export const buildFlowIdentityExecutionIdentity = () => identity;
export const buildFlowIdentityFinalizeRequest = () => ({});
export const buildFlowIdentityProcessRequest = () => ({ process_request_sha256: '${HASH('9')}' });
export const buildFlowIdentityScopeLookupRequest = () => ({ kind: 'scope-lookup' });
export const flowIdentityScopeHasCurrentDerivativeClosure = (value) => value.status === 'completed';
export const flowIdentityScopeIsReadyToFinalize = () => false;
export const parseFlowIdentityFinalizeProof = () => ({});
export const parseFlowIdentityProcessProof = () => ({});
export const parseFlowIdentityScopeLookupProof = () => ({
  ...scope,
  schema_version: 'dataset-flow-identity-scope-lookup-result.v1',
});
export const parseFlowIdentityScopePreflightProof = () => scope;
export const parseFlowIdentityScopeStatus = (value) => status(value.kind);
export const prepareFlowIdentityExecution = () => ({
  plan,
  freeze,
  approval,
  identity,
  preflightRequest: { kind: 'scope-preflight' },
});
export const splitFlowIdentityPermitResponse = () => ({ proof: {}, executionPermit: null });
`;
  const executionContractMockUrl = `data:text/javascript;base64,${Buffer.from(
    executionContractMockSource,
    'utf8',
  ).toString('base64')}`;
  const executionContractMock = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier.endsWith('/dataset-maintenance-flow-identity-execution-contract.js') ||
        (/\/(?:requests|proofs|status)\.js$/u.test(specifier) &&
          (specifier.includes('maintenance/flow-identity/') ||
            context.parentURL?.includes('/maintenance/flow-identity/')))
      ) {
        return { url: executionContractMockUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });

  const [{ __testInternals: approvalClaimInternals }, protectedArtifacts, authHelpers] =
    await Promise.all([
      import('../src/lib/dataset-maintenance-flow-identity-approval-claim.js'),
      import('../src/lib/dataset-maintenance-protected-artifacts.js'),
      import('./helpers/supabase-auth.js'),
    ]);
  const { freezeFlowIdentityRecovery } =
    await import('../src/lib/dataset-maintenance-flow-identity-recovery.js');
  const { runFlowIdentity } = await import('../src/lib/dataset-maintenance-flow-identity-run.js');
  executionContractMock.deregister();
  const executionContractCoverageSeedUrl = new URL(
    '../src/lib/dataset-maintenance-flow-identity-execution-contract.js?default-wiring-coverage-seed',
    import.meta.url,
  ).href;
  await import(executionContractCoverageSeedUrl);

  function response(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function env(stateRoot: string): NodeJS.ProcessEnv {
    return authHelpers.buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${PROJECT_REF}.supabase.co/functions/v1`,
      XDG_STATE_HOME: stateRoot,
    });
  }

  function toolchainEvidence() {
    return {
      schema_version: 'dataset-alias-protected-toolchain-evidence.v1',
      environment: 'production',
      project_ref: PROJECT_REF,
      verified_at_utc: '2026-07-17T00:00:00.000Z',
      database_engine: {
        repository: 'tiangong-lca/database-engine',
        production_main_commit_sha: '1'.repeat(40),
        production_readback_evidence_sha256: HASH('a'),
        status: 'released_and_read_back',
      },
      cli: {
        repository: 'tiangong-lca/tiangong-cli',
        package_name: '@tiangong-lca/cli',
        package_version: '0.0.28',
        release_commit_sha: '2'.repeat(40),
        release_evidence_sha256: HASH('b'),
        status: 'published_and_verified',
      },
      workspace: {
        repository: 'tiangong-lca/workspace',
        integration_commit_sha: '3'.repeat(40),
        integration_issue_url: 'https://github.com/tiangong-lca/workspace/issues/1',
        status: 'integrated',
      },
    };
  }

  test('approval claim rejects missing timestamp and output-directory fields', () => {
    assert.throws(
      () => approvalClaimInternals.validateClaim({}, HASH('5')),
      /malformed or foreign/u,
    );
  });

  test('recovery freeze uses the default context, lookup, and read adapters without network', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-default-recovery-'));
    try {
      const planPath = path.join(root, 'flow-identity-plan.json');
      const freezePath = path.join(root, 'flow-identity-freeze.json');
      const approvalPath = path.join(root, 'flow-identity-approval.json');
      const toolchainPath = path.join(root, 'toolchain.json');
      protectedArtifacts.writePrivateImmutableJson(planPath, { artifact: 'plan' });
      protectedArtifacts.writePrivateImmutableJson(freezePath, { artifact: 'freeze' });
      protectedArtifacts.writePrivateImmutableJson(approvalPath, { artifact: 'approval' });
      protectedArtifacts.writePrivateImmutableJson(toolchainPath, toolchainEvidence());

      const rpcCalls: Array<{ pathname: string; body: unknown }> = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (authHelpers.isSupabaseAuthTokenUrl(url)) {
          return authHelpers.makeSupabaseAuthResponse({ userId: ACTOR, email: EMAIL });
        }
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/auth/v1/user')) {
          return response({ id: ACTOR, email: EMAIL });
        }
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        rpcCalls.push({ pathname: parsed.pathname, body });
        if (parsed.pathname.endsWith('/rpc/cmd_dataset_flow_identity_scope_lookup')) {
          return response({ ok: true, kind: 'scope-lookup-result' });
        }
        if (parsed.pathname.endsWith('/rpc/cmd_dataset_flow_identity_scope_read')) {
          return response({ ok: true, kind: 'recovery-sealed' });
        }
        throw new Error(`unexpected simulated request: ${url}`);
      };

      const report = await freezeFlowIdentityRecovery({
        planPath,
        freezePath,
        approvalPath,
        runDir: path.join(root, 'missing-run-dir'),
        toolchainEvidencePath: toolchainPath,
        expectedProjectRef: PROJECT_REF,
        confirm: EMAIL,
        approvedAtUtc: '2026-07-17T00:01:00.000Z',
        recoveryReason: 'wrapper_exited_without_permit',
        cliVersion: '0.0.28',
        outDir: path.join(root, 'recovery-freeze'),
        env: env(path.join(root, 'state')),
        fetchImpl,
        now: new Date('2026-07-17T00:00:30.000Z'),
      });

      assert.equal(report.status, 'frozen');
      assert.equal(report.network_calls, 3);
      assert.equal(report.database_calls, 2);
      assert.deepEqual(rpcCalls, [
        {
          pathname: '/rest/v1/rpc/cmd_dataset_flow_identity_scope_lookup',
          body: { p_request: { kind: 'scope-lookup' } },
        },
        {
          pathname: '/rest/v1/rpc/cmd_dataset_flow_identity_scope_read',
          body: { p_scope_id: SCOPE_ID },
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('public status-only runner wires the default remote dependencies without network', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-default-run-'));
    try {
      const planPath = path.join(root, 'flow-identity-plan.json');
      const freezePath = path.join(root, 'flow-identity-freeze.json');
      const approvalPath = path.join(root, 'flow-identity-approval.json');
      const outDir = path.join(root, 'run');
      protectedArtifacts.writePrivateImmutableJson(planPath, { artifact: 'plan' });
      protectedArtifacts.writePrivateImmutableJson(freezePath, { artifact: 'freeze' });
      protectedArtifacts.writePrivateImmutableJson(approvalPath, { artifact: 'approval' });
      protectedArtifacts.writePrivateImmutableJson(
        path.join(outDir, 'scope-preflight-proof.json'),
        scope,
      );

      const rpcCalls: Array<{ pathname: string; body: unknown }> = [];
      let scopeReads = 0;
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (authHelpers.isSupabaseAuthTokenUrl(url)) {
          return authHelpers.makeSupabaseAuthResponse({ userId: ACTOR, email: EMAIL });
        }
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/auth/v1/user')) {
          return response({ id: ACTOR, email: EMAIL });
        }
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        rpcCalls.push({ pathname: parsed.pathname, body });
        if (parsed.pathname.endsWith('/rpc/cmd_dataset_flow_identity_scope_read')) {
          scopeReads += 1;
          return response({
            ok: true,
            kind: scopeReads === 1 ? 'run-pending' : 'run-completed',
          });
        }
        throw new Error(`unexpected simulated request: ${url}`);
      };

      const report = await runFlowIdentity({
        planPath,
        freezePath,
        approvalPath,
        outDir,
        commit: false,
        statusOnly: true,
        waitSeconds: 1,
        pollMs: 100,
        env: env(path.join(root, 'state')),
        fetchImpl,
      });

      assert.equal(report.mode, 'status_only');
      assert.equal(report.status, 'passed');
      assert.equal(report.scope_id, SCOPE_ID);
      assert.deepEqual(rpcCalls, [
        {
          pathname: '/rest/v1/rpc/cmd_dataset_flow_identity_scope_read',
          body: { p_scope_id: SCOPE_ID },
        },
        {
          pathname: '/rest/v1/rpc/cmd_dataset_flow_identity_scope_read',
          body: { p_scope_id: SCOPE_ID },
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
