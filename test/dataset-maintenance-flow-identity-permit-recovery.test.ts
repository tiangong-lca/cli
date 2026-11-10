import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals as claimInternals,
  claimFlowIdentityApproval,
  flowIdentityApprovalClaimPath,
  readFlowIdentityApprovalClaim,
  resolveFlowIdentityApprovalClaimRoot,
  type FlowIdentityApprovalClaim,
} from '../src/lib/dataset-maintenance-flow-identity-approval-claim.js';
import {
  buildFlowIdentityScopeLookupRequest,
  buildFlowIdentityScopePreflightRequest,
  splitFlowIdentityPermitResponse,
} from '../src/lib/maintenance/flow-identity/requests.js';
import { parseFlowIdentityScopeLookupProof } from '../src/lib/maintenance/flow-identity/proofs.js';
import { type FlowIdentityExecutionIdentity } from '../src/lib/maintenance/flow-identity/base.js';
import {
  buildFlowIdentityRecoveryRequest,
  parseFlowIdentityRecoveryProof,
  type FlowIdentityRecoveryApproval,
  type FlowIdentityRecoveryFreeze,
} from '../src/lib/dataset-maintenance-flow-identity-recovery.js';
import { flowIdentityRestrictedSha256 } from '../src/lib/dataset-maintenance-flow-identity-wire.js';
import type { FlowIdentityPlan } from '../src/lib/dataset-maintenance-flow-identity-contract.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const SCOPE_ID = '22222222-2222-4222-8222-222222222222';
const INVOCATION_ID = '33333333-3333-4333-8333-333333333333';
const hash = (label: string) =>
  Buffer.from(label.padEnd(64, label[0] ?? 'a'))
    .toString('hex')
    .slice(0, 64);

function claim(
  identity = hash('a'),
  outDir = '/tmp/tiangong-flow-identity-run',
): FlowIdentityApprovalClaim {
  return {
    schema_version: 'dataset-flow-identity-local-approval-claim.v1',
    claimed_at_utc: '2026-07-17T00:00:00.000Z',
    approval_kind: 'initial',
    approval_identity_sha256: identity,
    execution_identity_sha256: hash('b'),
    request_id: UUID,
    environment: 'production',
    project_ref: 'production-ref',
    actor_user_id: UUID,
    actor_email: 'owner@example.com',
    target_visibility: 'owner_draft',
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    plan_sha256: hash('c'),
    freeze_sha256: hash('d'),
    canonical_out_dir: path.resolve(outDir),
    maximum_cli_apply_spawns: 1,
    approval_reusable: false,
  };
}

test('local approval claim is one-shot across output directories and tamper fails closed', () => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-claim-'));
  try {
    const first = claim();
    const claimPath = claimFlowIdentityApproval({ claim: first, env: {}, stateRoot });
    assert.equal(
      readFlowIdentityApprovalClaim({
        approvalIdentitySha256: first.approval_identity_sha256,
        env: {},
        stateRoot,
      })?.canonical_out_dir,
      first.canonical_out_dir,
    );
    assert.throws(
      () =>
        claimFlowIdentityApproval({
          claim: { ...first, canonical_out_dir: path.resolve('/tmp/a-different-run') },
          env: {},
          stateRoot,
        }),
      /already claimed/u,
    );

    const parsed = JSON.parse(readFileSync(claimPath, 'utf8')) as Record<string, unknown>;
    parsed.extra = true;
    writeFileSync(claimPath, `${JSON.stringify(parsed)}\n`, 'utf8');
    chmodSync(claimPath, 0o600);
    assert.throws(
      () =>
        readFlowIdentityApprovalClaim({
          approvalIdentitySha256: first.approval_identity_sha256,
          env: {},
          stateRoot,
        }),
      /canonical JSON|malformed or foreign/u,
    );

    const next = claim(hash('e'), '/tmp/another-run');
    assert.doesNotThrow(() => claimFlowIdentityApproval({ claim: next, env: {}, stateRoot }));
    assert.equal(
      flowIdentityApprovalClaimPath({
        stateRoot,
        approvalIdentitySha256: next.approval_identity_sha256,
      }).endsWith(`${next.approval_identity_sha256}.claim.json`),
      true,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('approval claim root, validation, and private-file guards fail closed', () => {
  assert.equal(
    resolveFlowIdentityApprovalClaimRoot({
      env: { XDG_STATE_HOME: '/tmp/xdg-state' },
      platform: 'linux',
      homeDir: '/home/owner',
    }),
    path.resolve('/tmp/xdg-state', 'tiangong-lca-cli'),
  );
  assert.equal(
    resolveFlowIdentityApprovalClaimRoot({
      env: { LOCALAPPDATA: 'C:/Local' },
      platform: 'win32',
      homeDir: '',
    }),
    path.resolve('C:/Local', 'tiangong-lca-cli'),
  );
  assert.equal(
    resolveFlowIdentityApprovalClaimRoot({
      env: {},
      platform: 'linux',
      homeDir: '/home/owner',
    }),
    path.resolve('/home/owner', '.local', 'state', 'tiangong-lca-cli'),
  );
  assert.equal(
    resolveFlowIdentityApprovalClaimRoot({ env: {}, platform: 'linux', homeDir: '' }),
    path.resolve('.tiangong-lca-cli-state'),
  );
  assert.equal(
    resolveFlowIdentityApprovalClaimRoot({ env: {}, platform: 'darwin', homeDir: '' }),
    path.resolve(os.homedir(), 'Library', 'Application Support', 'tiangong-lca-cli'),
  );
  assert.throws(
    () =>
      flowIdentityApprovalClaimPath({
        stateRoot: '/tmp/state',
        approvalIdentitySha256: 'not-a-hash',
      }),
    /lowercase approval identity/u,
  );
  assert.throws(() => claimInternals.validateClaim(null, hash('a')), /malformed or foreign/u);
  assert.throws(() => claimInternals.validateClaim([], hash('a')), /malformed or foreign/u);
  assert.equal(claimInternals.hasPrivateClaimPermissions(0o600, 'linux'), true);
  assert.equal(claimInternals.hasPrivateClaimPermissions(0o644, 'linux'), false);
  assert.equal(claimInternals.hasPrivateClaimPermissions(0o666, 'win32'), true);
  const genericCreateError = Object.assign(new Error('claim write failed'), { code: 'EACCES' });
  assert.throws(
    () => claimInternals.rethrowClaimCreateError(genericCreateError, '/claim/path'),
    (error) => error === genericCreateError,
  );
  for (const invalid of [
    { ...claim(), claimed_at_utc: 'not-a-timestamp' },
    { ...claim(), approval_kind: 'foreign' },
    { ...claim(), approval_identity_sha256: hash('z') },
    { ...claim(), request_id: 'not-a-uuid' },
    { ...claim(), project_ref: '' },
    { ...claim(), actor_email: 'OWNER@EXAMPLE.COM' },
    { ...claim(), canonical_out_dir: 'relative/run' },
    { ...claim(), maximum_cli_apply_spawns: 2 },
    { ...claim(), approval_reusable: true },
  ]) {
    assert.throws(() => claimInternals.validateClaim(invalid, hash('a')), /malformed or foreign/u);
  }

  const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-claim-files-'));
  try {
    assert.equal(
      readFlowIdentityApprovalClaim({
        approvalIdentitySha256: hash('0'),
        env: {},
        stateRoot,
      }),
      null,
    );
    const publicClaim = claim(hash('e'), '/tmp/public-claim-run');
    const publicPath = claimFlowIdentityApproval({ claim: publicClaim, env: {}, stateRoot });
    if (process.platform !== 'win32') {
      chmodSync(publicPath, 0o644);
      assert.throws(
        () =>
          readFlowIdentityApprovalClaim({
            approvalIdentitySha256: publicClaim.approval_identity_sha256,
            env: {},
            stateRoot,
          }),
        /not a private regular file/u,
      );
    }

    const invalidJsonClaim = claim(hash('f'), '/tmp/invalid-json-claim-run');
    const invalidJsonPath = claimFlowIdentityApproval({
      claim: invalidJsonClaim,
      env: {},
      stateRoot,
    });
    writeFileSync(invalidJsonPath, '{\n', 'utf8');
    chmodSync(invalidJsonPath, 0o600);
    assert.throws(
      () =>
        readFlowIdentityApprovalClaim({
          approvalIdentitySha256: invalidJsonClaim.approval_identity_sha256,
          env: {},
          stateRoot,
        }),
      /unreadable/u,
    );

    const symlinkClaim = claim(hash('1'), '/tmp/symlink-claim-run');
    const symlinkPath = flowIdentityApprovalClaimPath({
      stateRoot,
      approvalIdentitySha256: symlinkClaim.approval_identity_sha256,
    });
    mkdirSync(path.dirname(symlinkPath), { recursive: true });
    symlinkSync(invalidJsonPath, symlinkPath);
    assert.throws(
      () =>
        readFlowIdentityApprovalClaim({
          approvalIdentitySha256: symlinkClaim.approval_identity_sha256,
          env: {},
          stateRoot,
        }),
      /not a private regular file/u,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }

  if (process.platform !== 'win32') {
    const blockedRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-claim-blocked-'));
    const blockedClaim = claim(hash('2'), '/tmp/blocked-claim-run');
    const blockedPath = flowIdentityApprovalClaimPath({
      stateRoot: blockedRoot,
      approvalIdentitySha256: blockedClaim.approval_identity_sha256,
    });
    const blockedDirectory = path.dirname(blockedPath);
    try {
      mkdirSync(blockedDirectory, { recursive: true });
      chmodSync(blockedDirectory, 0o500);
      assert.throws(
        () => claimFlowIdentityApproval({ claim: blockedClaim, env: {}, stateRoot: blockedRoot }),
        /EACCES|permission denied/u,
      );
    } finally {
      chmodSync(blockedDirectory, 0o700);
      rmSync(blockedRoot, { recursive: true, force: true });
    }
  }
});

function recoveryArtifacts() {
  const freeze: FlowIdentityRecoveryFreeze = {
    schema_version: 'dataset-flow-identity-recovery-freeze.v1',
    generated_at_utc: '2026-07-17T00:00:00.000Z',
    environment: 'production',
    project_ref: 'production-ref',
    actor: { user_id: UUID, email: 'owner@example.com' },
    target_visibility: 'owner_draft',
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    scope_id: SCOPE_ID,
    scope_proof_sha256: hash('f'),
    operation_id: 'operation-1',
    plan_sha256: hash('1'),
    original_freeze_sha256: hash('2'),
    original_execution_request_id: UUID,
    original_execution_identity_sha256: hash('3'),
    original_execution_approval_request_sha256: hash('4'),
    original_execution_approval_text_sha256: hash('5'),
    original_execution_approval_identity_sha256: hash('6'),
    recovery_reason: 'process_response_ambiguous',
    recovery_mode: 'resume_and_finalize',
    baseline: {
      status: 'running',
      completed_process_count: 1,
      next_ordinal: 2,
      primary_complete: false,
      primary_current: true,
      live_guard_current: true,
      protected_closure_current: true,
      derivatives_current: false,
      whole_scope_proof_sha256: hash('7'),
    },
    toolchain_evidence_sha256: hash('8'),
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: 3,
    maximum_finalize_posts: 1,
    automatic_retry: false,
    recovery_freeze_sha256: hash('9'),
  };
  const approval: FlowIdentityRecoveryApproval = {
    schema_version: 'dataset-flow-identity-recovery-approval.v1',
    approved_at_utc: '2026-07-17T00:01:00.000Z',
    actor: freeze.actor,
    plan_sha256: freeze.plan_sha256,
    scope_id: freeze.scope_id,
    scope_proof_sha256: freeze.scope_proof_sha256,
    recovery_freeze_sha256: freeze.recovery_freeze_sha256,
    toolchain_evidence_sha256: freeze.toolchain_evidence_sha256,
    recovery_approval_request_sha256: hash('a'),
    recovery_approval_text_sha256: hash('b'),
    recovery_approval_identity_sha256: hash('c'),
  };
  return { freeze, approval };
}

test('recovery request and result use the exact DB wire domain and never persist the permit', () => {
  const { freeze, approval } = recoveryArtifacts();
  const request = buildFlowIdentityRecoveryRequest({ freeze, approval });
  assert.deepEqual(
    Object.keys(request).sort(),
    [
      'actor',
      'approval_reusable',
      'approved_at_utc',
      'automatic_retry',
      'environment',
      'freeze_sha256',
      'maximum_cli_apply_spawns',
      'maximum_finalize_posts',
      'maximum_process_posts',
      'maximum_wrapper_invocations',
      'observed_completed_process_count',
      'observed_next_ordinal',
      'observed_scope_status',
      'observed_whole_scope_proof_sha256',
      'operation_id',
      'original_execution_approval_identity_sha256',
      'plan_sha256',
      'project_ref',
      'recovery_approval_identity_sha256',
      'recovery_approval_request_sha256',
      'recovery_approval_text_sha256',
      'recovery_mode',
      'recovery_reason',
      'request_id',
      'schema_version',
      'scope_proof_sha256',
      'target_visibility',
      'toolchain_evidence_sha256',
      'user_state_claim',
    ].sort(),
  );
  assert.equal(request.schema_version, 'dataset-flow-identity-scope-recovery.v1');
  assert.equal(request.recovery_reason, 'process_response_ambiguous');

  const permit = {
    schema_version: 'dataset-flow-identity-execution-permit.v1',
    invocation_id: INVOCATION_ID,
    generation: 0,
    token: hash('d'),
  };
  const raw = {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_recover_guarded',
    schema_version: 'dataset-flow-identity-scope-recovery-result.v1',
    scope_id: freeze.scope_id,
    scope_proof_sha256: freeze.scope_proof_sha256,
    status: freeze.baseline.status,
    completed_process_count: freeze.baseline.completed_process_count,
    next_ordinal: freeze.baseline.next_ordinal,
    whole_scope_proof_sha256: freeze.baseline.whole_scope_proof_sha256,
    recovery_wire_request_sha256: flowIdentityRestrictedSha256(request),
    recovery_approval_identity_sha256: approval.recovery_approval_identity_sha256,
    invocation_id: INVOCATION_ID,
    audit_id: '101',
    replay: false,
    execution_permit: permit,
  };
  const envelope = splitFlowIdentityPermitResponse({
    value: raw,
    expectedGeneration: 0,
    permitRequired: true,
    label: 'recovery test',
  });
  const proof = parseFlowIdentityRecoveryProof({
    value: envelope.proof,
    freeze,
    approval,
    request,
    expectedInvocationId: INVOCATION_ID,
  });
  assert.equal(Object.hasOwn(proof, 'execution_permit'), false);
  assert.equal(JSON.stringify(proof).includes(String(permit.token)), false);
  assert.throws(
    () =>
      parseFlowIdentityRecoveryProof({
        value: { ...proof, foreign: true },
        freeze,
        approval,
        request,
      }),
    /unexpected wire shape/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityRecoveryProof({
        value: null,
        freeze,
        approval,
        request,
      }),
    /proof is invalid/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityRecoveryProof({
        value: { ...proof, invocation_id: 'not-a-uuid' },
        freeze,
        approval,
        request,
      }),
    /must be a UUID/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityRecoveryProof({
        value: { ...proof, audit_id: '' },
        freeze,
        approval,
        request,
      }),
    /does not bind/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: raw,
        expectedGeneration: 1,
        permitRequired: true,
        label: 'recovery test',
      }),
    /expected live wrapper generation/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: { ...raw, replay: true },
        expectedGeneration: 0,
        permitRequired: false,
        permitForbidden: true,
        label: 'replayed recovery test',
      }),
    /replay unexpectedly contained/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: null,
        expectedGeneration: 0,
        permitRequired: true,
        label: 'invalid recovery test',
      }),
    /response is invalid/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: { ok: true },
        expectedGeneration: 0,
        permitRequired: true,
        label: 'missing envelope recovery test',
      }),
    /omitted the execution permit envelope/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: { ok: true, execution_permit: null },
        expectedGeneration: 0,
        permitRequired: true,
        label: 'null envelope recovery test',
      }),
    /did not provide a fresh/u,
  );
  assert.throws(
    () =>
      splitFlowIdentityPermitResponse({
        value: { ok: true, execution_permit: [] },
        expectedGeneration: 0,
        permitRequired: true,
        label: 'invalid permit recovery test',
      }),
    /execution permit is invalid/u,
  );
});

test('preflight and read-only lookup bind maximum CLI spawns and exact null-permit proof', () => {
  const identity: FlowIdentityExecutionIdentity = {
    request_id: UUID,
    identity_sha256: hash('1'),
    environment: 'production',
    project_ref: 'production-ref',
    actor: { user_id: UUID, email: 'owner@example.com' },
    target_visibility: 'owner_draft',
    operation_id: 'operation-1',
    plan_sha256: hash('2'),
    freeze_sha256: hash('3'),
    receipt_id: SCOPE_ID,
    receipt_proof_sha256: hash('4'),
    policy_approval_text_sha256: hash('5'),
    execution_approval_request_sha256: hash('6'),
    execution_approval_text_sha256: hash('7'),
    execution_approval_identity_sha256: hash('8'),
    toolchain_evidence_sha256: hash('9'),
  };
  const plan = {
    receipt_id: identity.receipt_id,
    receipt_proof_sha256: identity.receipt_proof_sha256,
    mapping_guard_set_sha256: hash('a'),
    process_intent_set_sha256: hash('b'),
    mappings: [],
    processes: [{}],
    support_snapshots: [],
    summary: { rewrites: 0 },
  } as unknown as FlowIdentityPlan;
  assert.equal(
    buildFlowIdentityScopePreflightRequest({ plan, identity }).maximum_cli_apply_spawns,
    1,
  );
  const lookupRequest = buildFlowIdentityScopeLookupRequest({ identity });
  assert.equal(lookupRequest.schema_version, 'dataset-flow-identity-scope-lookup.v1');
  const proof = parseFlowIdentityScopeLookupProof(
    {
      ok: true,
      command: 'cmd_dataset_flow_identity_scope_lookup',
      schema_version: 'dataset-flow-identity-scope-lookup-result.v1',
      read_only: true,
      scope_id: SCOPE_ID,
      receipt_id: identity.receipt_id,
      receipt_proof_sha256: identity.receipt_proof_sha256,
      mapping_guard_set_sha256: plan.mapping_guard_set_sha256,
      process_intent_set_sha256: plan.process_intent_set_sha256,
      operation_id: identity.operation_id,
      plan_sha256: identity.plan_sha256,
      scope_proof_sha256: hash('c'),
      status: 'sealed',
      process_count: 1,
      mapping_count: 0,
      support_snapshot_count: 0,
      source_universe_count: 305,
      rewrite_count: 0,
      next_ordinal: 1,
      audit_id: '102',
      whole_scope_proof_sha256: hash('d'),
      execution_permit: null,
    },
    plan,
    identity,
  );
  assert.equal(proof.read_only, true);
  assert.throws(
    () => parseFlowIdentityScopeLookupProof({ ...proof, execution_permit: {} }, plan, identity),
    /does not bind/u,
  );
  assert.throws(() => parseFlowIdentityScopeLookupProof(null, plan, identity), /proof is invalid/u);
});
