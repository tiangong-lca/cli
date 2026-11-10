import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTECTED_EXECUTION_CONTRACT,
  PROTECTED_EXECUTION_COUNTS,
  __testInternals,
  assertProtectedApprovalBindings,
  assertProtectedFreezeMatchesPlan,
  buildProtectedAdmitRequest,
  buildProtectedExecutionIdentity,
  buildProtectedPreflightRequest,
  computeProtectedApprovalIdentitySha256,
  computeProtectedFreezeSha256,
  isUuid,
  parseProtectedAdmissionProof,
  parseProtectedApproval,
  parseProtectedDerivativeSnapshot,
  parseProtectedFreeze,
  parseProtectedGateProof,
  parseProtectedPreflightProof,
  parseProtectedStatusProof,
  protectedDerivativeBaselineSetSha256,
  protectedPlanSetHashes,
  type DatasetMaintenanceProtectedApproval,
  type DatasetMaintenanceProtectedFreeze,
  type ProtectedExecutionIdentity,
  type ProtectedGateProof,
  type ProtectedPreflightProof,
} from '../src/lib/dataset-maintenance-protected-contract.js';
import { type DatasetMaintenancePlan } from '../src/lib/maintenance/contract/types.js';
import { CliError } from '../src/shared/errors.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FREEZE_FILE_SHA256 = HASH_B;
const APPROVAL_FILE_SHA256 = HASH_C;
const VERSION = '00.00.001';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function rejects(action: () => unknown, message?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'DATASET_MAINTENANCE_PROTECTED_CONTRACT_INVALID');
    assert.equal(error.exitCode, 2);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function targets() {
  return [
    ...Array.from({ length: 23 }, (_, index) => ({
      table: 'flows' as const,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: index === 0 ? HASH_B : HASH_A,
    })),
    ...Array.from({ length: 27 }, (_, index) => ({
      table: 'processes' as const,
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: HASH_A,
    })),
  ];
}

function planFixture(): DatasetMaintenancePlan {
  const actionTargets = targets();
  const actionTables = [
    { table: 'flowproperties' as const, id: 'flowproperty-01' },
    { table: 'flowproperties' as const, id: 'flowproperty-02' },
    ...actionTargets.map(({ table, id }) => ({ table, id })),
  ];
  const actions = actionTables.map((target, index) => ({
    action_id: `${target.table}-${String(index + 1).padStart(2, '0')}`,
    action: 'update_json_ordered',
    table: target.table,
    id: target.id,
    version: VERSION,
    expected_user_id: USER_ID,
    expected_state_code: 0,
    reason_code: 'BAFU_STEP_2',
    reason: 'coverage fixture',
    evidence: [],
    ordinal: index + 1,
    status: 'ready',
    before:
      index === 0
        ? {
            table: 'flowproperties',
            id: target.id,
            version: VERSION,
            user_id: USER_ID,
            state_code: 0,
            modified_at: '2026-07-15T00:00:00.000Z',
            json_ordered: {},
            model_id: null,
            rule_verification: null,
            row_sha256: HASH_A,
            payload_sha256: HASH_A,
          }
        : null,
    desired_payload: index === 0 ? { path: 'payload.json', sha256: HASH_B } : null,
    blockers: [],
    rollback: {
      strategy: 'restore_atomic_alias_before_snapshot',
      before_payload_sha256: null,
      before_payload: null,
      model_id: null,
      rule_verification: null,
    },
  }));
  return {
    schema_version: 1,
    generated_at_utc: '2026-07-15T00:00:00.000Z',
    task_id: 'bafu-private-step-2',
    operation: 'merge-support-aliases',
    operation_id: 'bafu-private-step-2-owner-draft',
    account: { user_id: USER_ID, email: 'bafudata@126.com' },
    source_import_run_id: null,
    source_lineage: null,
    target_mode: 'owner_draft',
    status: 'ready',
    scope_sha256: HASH_A,
    visible_snapshot_sha256: HASH_A,
    projected_reference_sha256: HASH_A,
    plan_sha256: HASH_D,
    summary: {
      actions: 52,
      save_draft: 0,
      delete: 0,
      update_json_ordered: 52,
      rebuild_derivatives: 0,
      atomic_batches: 2,
      scaled_exchanges: 59,
      scaled_amount_fields: 118,
      unrelated_exchanges_preserved: 309,
      protected_rows: 0,
      blockers: 0,
      current_reference_impacts: 0,
      projected_reference_impacts: 0,
    },
    artifacts: {
      maintenance_scope: 'scope.json',
      rls_visible_snapshot: 'snapshot.json',
      protected_rows: 'protected.json',
      reference_impact_report: 'references.json',
      maintenance_plan: 'plan.json',
      dry_run_report: 'dry-run.json',
      payload_dir: 'payloads',
    },
    actions,
    alias_batches: [
      {
        batch_id: 'time',
        exchange_rewrites: [{ rewrite: 'time' }],
        target_snapshots: { flowproperty: { snapshot: 'time' } },
      },
      {
        batch_id: 'length_time',
        exchange_rewrites: [{ rewrite: 'length-time' }],
        target_snapshots: { flowproperty: { snapshot: 'length-time' } },
      },
    ],
    protected_rows: [],
    blockers: [],
  } as unknown as DatasetMaintenancePlan;
}

function freezeFixture(plan = planFixture()): DatasetMaintenanceProtectedFreeze {
  const derivativeTargets = targets();
  const sets = protectedPlanSetHashes(plan);
  const freeze = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: 'production-ref',
    account: { user_id: USER_ID, email: 'bafudata@126.com' },
    target_visibility: 'owner_draft',
    plan: {
      plan_file_sha256: HASH_E,
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
    },
    sets: {
      ...sets,
      alias_plan_request_sha256: HASH_C,
      derivative_baseline_set_sha256: protectedDerivativeBaselineSetSha256(derivativeTargets),
      toolchain_evidence_sha256: HASH_F,
    },
    expected: PROTECTED_EXECUTION_COUNTS,
    derivative_targets: derivativeTargets,
    policy: {
      state_code_changes: 0,
      save_draft: 0,
      deletes: 0,
      rebuild_derivatives: 0,
      unitgroup_actions: 0,
      person_distance_actions: 0,
      max_admit_posts: 1,
      automatic_retry: false,
    },
    freeze_sha256: '',
  } as DatasetMaintenanceProtectedFreeze;
  freeze.freeze_sha256 = computeProtectedFreezeSha256(freeze);
  return freeze;
}

function approvalFixture(freeze = freezeFixture()): DatasetMaintenanceProtectedApproval {
  const approval = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.approval_schema,
    approved_at_utc: '2026-07-15T00:00:00.000Z',
    environment: 'production',
    project_ref: freeze.project_ref,
    account: freeze.account,
    target_visibility: 'owner_draft',
    plan_sha256: freeze.plan.plan_sha256,
    operation_id: freeze.plan.operation_id,
    plan_file_sha256: freeze.plan.plan_file_sha256,
    freeze_file_sha256: FREEZE_FILE_SHA256,
    freeze_sha256: freeze.freeze_sha256,
    approval_text_sha256: HASH_A,
    max_admit_posts: 1,
    automatic_retry: false,
    approval_identity_sha256: '',
  } as DatasetMaintenanceProtectedApproval;
  approval.approval_identity_sha256 = computeProtectedApprovalIdentitySha256(approval);
  return approval;
}

function identityFixture(): ProtectedExecutionIdentity {
  const freeze = freezeFixture();
  return buildProtectedExecutionIdentity({
    freeze,
    approval: approvalFixture(freeze),
    freezeFileSha256: FREEZE_FILE_SHA256,
    approvalFileSha256: APPROVAL_FILE_SHA256,
  });
}

function preflightResponse(identity = identityFixture()) {
  return {
    ok: true,
    command: PROTECTED_EXECUTION_CONTRACT.preflight_command,
    schema_version: PROTECTED_EXECUTION_CONTRACT.preflight_response_schema,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    environment: identity.environment,
    project_ref: identity.project_ref,
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    server_context_sha256: HASH_F,
    alias_plan_request_sha256: identity.bindings.alias_plan_request_sha256,
    freeze_sha256: identity.bindings.freeze_sha256,
    approval_identity_sha256: identity.bindings.approval_identity_sha256,
    plan_request_sha256: HASH_A,
    bindings_sha256: HASH_B,
    expected_sha256: HASH_C,
    derivative_targets_sha256: HASH_D,
    gate_expectations: {
      primary_support_plan_sha256: HASH_A,
      execution_unused_sha256: HASH_B,
      derivative_quiescence_sha256: HASH_C,
    },
    gate_expectations_sha256: HASH_E,
    failure_baseline_sha256: HASH_F,
    preflight_request_sha256: HASH_A,
    preflight_token: 'one-shot-token',
    preflight_proof_sha256: HASH_B,
    completed_at: '2026-07-15T00:00:00.000Z',
    expires_at: '2026-07-15T00:03:00.000Z',
    simulation: {
      plan_rows: 52,
      plan_exchanges: 59,
      alias_audits: 55,
      derivative_targets: 50,
      rolled_back: true,
    },
  };
}

function preflightFixture(identity = identityFixture()): ProtectedPreflightProof {
  return parseProtectedPreflightProof(
    preflightResponse(identity),
    identity,
    new Date('2026-07-15T00:01:00.000Z'),
  );
}

function gateResponse(
  identity: ProtectedExecutionIdentity,
  preflight: ProtectedPreflightProof,
  gate: ProtectedGateProof['gate'],
) {
  const expected = preflight.gate_expectations[`${gate}_sha256`];
  return {
    ok: true,
    command: PROTECTED_EXECUTION_CONTRACT.gate_command,
    schema_version: PROTECTED_EXECUTION_CONTRACT.gate_response_schema,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    preflight_proof_sha256: preflight.preflight_proof_sha256,
    gate,
    expected_sha256: expected,
    observed_sha256: expected,
    status: 'passed',
    captured_at: '2026-07-15T00:00:30.000Z',
    receipt_sha256: HASH_D,
  };
}

function readGates() {
  const expected = {
    primary_support_plan_sha256: HASH_A,
    execution_unused_sha256: HASH_B,
    derivative_quiescence_sha256: HASH_C,
  };
  return (
    [
      'primary_support_plan',
      'execution_unused',
      'derivative_quiescence',
    ] as ProtectedGateProof['gate'][]
  ).map((gate, index) => ({
    gate,
    expected_sha256: expected[`${gate}_sha256`],
    observed_sha256: expected[`${gate}_sha256`],
    status: 'passed',
    captured_at: '2026-07-15T00:00:30.000Z',
    receipt_sha256: [HASH_D, HASH_E, HASH_F][index],
  }));
}

function terminalTargets(identity: ProtectedExecutionIdentity) {
  return identity.derivative_targets.map((target, index) => ({
    ordinal: index + 1,
    request_id: identity.request_id,
    table: target.table,
    id: target.id,
    version: target.version,
    status: 'completed',
    phase: 'terminal',
    source_baseline_snapshot_sha256: target.baseline_snapshot_sha256,
    expected_snapshot_sha256: HASH_E,
    completed_snapshot_sha256: index === 0 ? null : HASH_E,
    primary_matches: true,
    terminal_snapshot_matches: true,
    proposals_committed: true,
    derivative_fresh: true,
    lifecycle_complete: true,
    terminal_audit_present: true,
    residue: {
      http_requests: 0,
      embedding_jobs: 0,
      pending_jobs: 0,
      failure_rows: 0,
      other_active_fences: 0,
    },
    causal_terminal_proof: true,
  }));
}

function statusTargets(identity: ProtectedExecutionIdentity) {
  return identity.derivative_targets.map((target, index) => ({
    ordinal: index + 1,
    request_id: identity.request_id,
    table: target.table,
    id: target.id,
    version: target.version,
    status: 'pending',
    phase: 'queued',
    error: index === 0 ? null : { code: 'WAITING' },
    causal_terminal_proof: false,
  }));
}

function derivativeReadback(
  identity: ProtectedExecutionIdentity,
  status: 'not_started' | 'pending' | 'completed' | 'failed',
  code: string | null | undefined = null,
) {
  if (status === 'not_started') {
    return {
      schema_version: 'dataset-derivative-rebuild-batch-status.v1',
      batch_id: identity.request_id,
      status,
      code: code ?? 'DERIVATIVE_BATCH_NOT_STARTED',
      proof_level: 'none',
      proof_deferred: false,
      causal_terminal_proof: false,
      target_count: 0,
      flow_count: 0,
      process_count: 0,
      completed_count: 0,
      nonterminal_count: 0,
      failed_count: 0,
      invalid_proof_count: null,
      targets: [],
    };
  }
  if (status === 'pending') {
    return {
      schema_version: 'dataset-derivative-rebuild-batch-status.v1',
      batch_id: identity.request_id,
      status,
      ...(code === undefined ? {} : { code }),
      proof_level: 'status_only',
      proof_deferred: true,
      causal_terminal_proof: false,
      target_count: 50,
      flow_count: 23,
      process_count: 27,
      completed_count: 0,
      nonterminal_count: 50,
      failed_count: 0,
      invalid_proof_count: null,
      targets: statusTargets(identity),
    };
  }
  return {
    schema_version: 'dataset-derivative-rebuild-batch-status.v1',
    batch_id: identity.request_id,
    status,
    ...(code === undefined ? {} : { code }),
    proof_level: 'causal_terminal',
    proof_deferred: false,
    causal_terminal_proof: true,
    target_count: 50,
    flow_count: 23,
    process_count: 27,
    completed_count: status === 'completed' ? 50 : 0,
    nonterminal_count: 0,
    failed_count: status === 'failed' ? 1 : 0,
    invalid_proof_count: 0,
    targets: terminalTargets(identity),
  };
}

function admittedStatus(
  identity: ProtectedExecutionIdentity,
  status: 'pending' | 'passed' | 'failed' | 'indeterminate',
  executionStatus:
    | 'dispatching'
    | 'dispatched'
    | 'running'
    | 'derivatives_pending'
    | 'completed'
    | 'failed'
    | 'indeterminate',
  derivativeStatus: 'not_started' | 'pending' | 'completed' | 'failed',
  options: {
    code?: string | null;
    error?: Record<string, unknown> | null | string;
    nullableCounts?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    ok: true,
    command: PROTECTED_EXECUTION_CONTRACT.read_command,
    schema_version: PROTECTED_EXECUTION_CONTRACT.status_response_schema,
    request_id: identity.request_id,
    status,
    execution_status: executionStatus,
    retry_allowed: false,
    actor_user_id: identity.actor.user_id,
    environment: identity.environment,
    project_ref: identity.project_ref,
    target_visibility: 'owner_draft',
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    plan_request_sha256: HASH_A,
    freeze_sha256: identity.bindings.freeze_sha256,
    approval_identity_sha256: identity.bindings.approval_identity_sha256,
    approval_text_sha256: identity.bindings.approval_text_sha256,
    derivative_target_set_sha256: identity.bindings.derivative_target_set_sha256,
    preflight_proof_sha256: HASH_B,
    admission_request_sha256: HASH_C,
    gate_results_sha256: HASH_D,
    attempt_count: 1,
    dispatch_count: 1,
    gate_count: 3,
    gates: readGates(),
    primary_readback: {
      row_count: options.nullableCounts ? null : 52,
      exchange_count: options.nullableCounts ? null : 59,
      alias_audit_count: 55,
      live_closure_proof: true,
      closure: { exact: true },
    },
    derivative_readback: derivativeReadback(identity, derivativeStatus, options.code),
    error: options.error ?? null,
  };
}

function notAdmittedStatus(identity: ProtectedExecutionIdentity): Record<string, unknown> {
  return {
    ok: true,
    command: PROTECTED_EXECUTION_CONTRACT.read_command,
    schema_version: PROTECTED_EXECUTION_CONTRACT.status_response_schema,
    request_id: identity.request_id,
    status: 'indeterminate',
    execution_status: 'not_admitted',
    retry_allowed: false,
    actor_user_id: identity.actor.user_id,
    environment: identity.environment,
    project_ref: identity.project_ref,
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    plan_request_sha256: HASH_A,
    preflight_proof_sha256: HASH_B,
    gate_count: 0,
    gates: [],
  };
}

test('freeze, approval, identity, and plan bindings accept the exact profile', () => {
  const plan = planFixture();
  const freeze = parseProtectedFreeze(freezeFixture(plan));
  const approval = parseProtectedApproval(approvalFixture(freeze));

  assertProtectedFreezeMatchesPlan({
    plan,
    planFileSha256: HASH_E,
    aliasPlanRequestSha256: HASH_C,
    freeze,
  });
  assertProtectedApprovalBindings({
    approval,
    freeze,
    freezeFileSha256: FREEZE_FILE_SHA256,
    approvalFileSha256: APPROVAL_FILE_SHA256,
    approveExecution: approval.approval_identity_sha256,
  });

  const identity = buildProtectedExecutionIdentity({
    freeze,
    approval,
    freezeFileSha256: FREEZE_FILE_SHA256,
    approvalFileSha256: APPROVAL_FILE_SHA256,
  });
  assert.equal(isUuid(identity.request_id), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.deepEqual(
    buildProtectedExecutionIdentity({
      freeze,
      approval,
      freezeFileSha256: FREEZE_FILE_SHA256,
      approvalFileSha256: APPROVAL_FILE_SHA256,
    }),
    identity,
  );
  assert.equal(computeProtectedFreezeSha256(freeze), freeze.freeze_sha256);
  assert.equal(computeProtectedApprovalIdentitySha256(approval), approval.approval_identity_sha256);

  const preflightRequest = buildProtectedPreflightRequest({
    identity,
    plan: { exact: true },
    freeze,
    approval,
  });
  assert.equal(preflightRequest.request_id, identity.request_id);
  assert.deepEqual(__testInternals.parseBindings(identity.bindings), identity.bindings);
  assert.deepEqual(
    __testInternals.parseExpected(PROTECTED_EXECUTION_COUNTS),
    PROTECTED_EXECUTION_COUNTS,
  );
  assert.equal(
    __testInternals.parseDerivativeTarget(freeze.derivative_targets[0], 0).table,
    'flows',
  );

  const withoutOptionalValues = copy(plan);
  withoutOptionalValues.alias_batches = undefined;
  withoutOptionalValues.actions = withoutOptionalValues.actions.map((action) => ({
    ...action,
    before: null,
    desired_payload: null,
  }));
  const optionalHashes = protectedPlanSetHashes(withoutOptionalValues);
  assert.match(optionalHashes.exchange_rewrite_set_sha256, /^[a-f0-9]{64}$/u);

  const versionTie = copy(plan);
  const tiedActions = versionTie.actions.filter((action) => action.table === 'flows').slice(0, 2);
  tiedActions[1]!.id = tiedActions[0]!.id;
  tiedActions[1]!.version = '00.00.002';
  assert.match(protectedPlanSetHashes(versionTie).derivative_target_set_sha256, /^[a-f0-9]{64}$/u);
});

test('freeze parsing rejects malformed scope, ownership, counts, policy, and hashes', () => {
  rejects(() => parseProtectedFreeze(null), /Freeze must use/u);

  const nonArray = copy(freezeFixture()) as unknown as Record<string, unknown>;
  nonArray.derivative_targets = null;
  rejects(() => parseProtectedFreeze(nonArray), /must be an array/u);

  rejects(() => __testInternals.parseDerivativeTarget(null, 0), /must be an object/u);
  rejects(
    () => __testInternals.parseDerivativeTarget({ ...targets()[0], table: 'sources' }, 0),
    /flows or processes/u,
  );
  rejects(
    () => __testInternals.parseDerivativeTarget({ ...targets()[0], state_code: 100 }, 0),
    /state_code/u,
  );
  rejects(
    () => __testInternals.parseDerivativeTarget({ ...targets()[0], id: ' ' }, 0),
    /non-empty string/u,
  );
  rejects(
    () => __testInternals.parseDerivativeTarget({ ...targets()[0], id: 'not-a-uuid' }, 0),
    /UUID id and canonical version/u,
  );
  rejects(
    () => __testInternals.parseDerivativeTarget({ ...targets()[0], version: '1' }, 0),
    /UUID id and canonical version/u,
  );
  rejects(
    () =>
      __testInternals.parseDerivativeTarget(
        { ...targets()[0], baseline_snapshot_sha256: HASH_A.toUpperCase() },
        0,
      ),
    /lowercase SHA-256/u,
  );

  const shortTargets = copy(freezeFixture()) as unknown as Record<string, unknown>;
  shortTargets.derivative_targets = targets().slice(0, 49);
  rejects(() => parseProtectedFreeze(shortTargets), /exactly 23 flows and 27 processes/u);

  const duplicateTargets = targets();
  duplicateTargets[49] = { ...duplicateTargets[48]! };
  const duplicate = copy(freezeFixture()) as unknown as Record<string, unknown>;
  duplicate.derivative_targets = duplicateTargets;
  rejects(() => parseProtectedFreeze(duplicate), /no duplicates/u);

  const unstableOrder = copy(freezeFixture()) as unknown as Record<string, unknown>;
  unstableOrder.derivative_targets = [...targets()].reverse();
  rejects(() => parseProtectedFreeze(unstableOrder), /stable table\/id\/version order/u);

  const foreignOwner = copy(freezeFixture());
  foreignOwner.derivative_targets[0]!.user_id = 'foreign-user';
  rejects(() => parseProtectedFreeze(foreignOwner), /frozen account/u);

  const badAccount = copy(freezeFixture()) as unknown as Record<string, unknown>;
  badAccount.account = null;
  rejects(() => parseProtectedFreeze(badAccount), /account must be an object/u);

  const badSets = copy(freezeFixture()) as unknown as Record<string, unknown>;
  badSets.sets = null;
  rejects(() => parseProtectedFreeze(badSets), /sets must be an object/u);

  const badExpected = copy(freezeFixture()) as unknown as Record<string, unknown>;
  badExpected.expected = null;
  rejects(() => parseProtectedFreeze(badExpected), /expected must be an object/u);
  rejects(
    () => __testInternals.parseExpected({ ...PROTECTED_EXECUTION_COUNTS, action_count: 51 }),
    /expected.action_count/u,
  );

  const badPolicy = copy(freezeFixture());
  (badPolicy.policy.state_code_changes as number) = 1;
  rejects(() => parseProtectedFreeze(badPolicy), /Freeze policy permits/u);

  const staleHash = copy(freezeFixture());
  staleHash.freeze_sha256 = HASH_A;
  rejects(() => parseProtectedFreeze(staleHash), /canonical freeze contents/u);
});

test('approval parsing and exact bindings reject broader or stale authority', () => {
  rejects(() => parseProtectedApproval(null), /Approval must use/u);

  const badTimestamp = copy(approvalFixture());
  badTimestamp.approved_at_utc = 'not-a-time';
  rejects(() => parseProtectedApproval(badTimestamp), /ISO timestamp/u);

  const broad = copy(approvalFixture());
  (broad.max_admit_posts as number) = 2;
  rejects(() => parseProtectedApproval(broad), /exactly one admit POST/u);

  const stale = copy(approvalFixture());
  stale.approval_identity_sha256 = HASH_A;
  rejects(() => parseProtectedApproval(stale), /canonical approval contents/u);

  const freeze = freezeFixture();
  const approval = approvalFixture(freeze);
  rejects(
    () =>
      assertProtectedApprovalBindings({
        approval: { ...approval, project_ref: 'other-ref' },
        freeze,
        freezeFileSha256: FREEZE_FILE_SHA256,
        approvalFileSha256: APPROVAL_FILE_SHA256,
        approveExecution: approval.approval_identity_sha256,
      }),
    /does not bind/u,
  );
  rejects(
    () =>
      assertProtectedApprovalBindings({
        approval,
        freeze,
        freezeFileSha256: FREEZE_FILE_SHA256,
        approvalFileSha256: 'bad',
        approveExecution: approval.approval_identity_sha256,
      }),
    /lowercase SHA-256/u,
  );
  rejects(() => __testInternals.parseBindings(null), /bindings must be an object/u);
  rejects(
    () => __testInternals.parseBindings({ ...identityFixture().bindings, plan_file_sha256: 'bad' }),
    /bindings.plan_file_sha256/u,
  );
});

test('protected plan matching rejects wrong envelope, counts, sets, baselines, and targets', () => {
  const plan = planFixture();
  const freeze = freezeFixture(plan);

  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan: { ...plan, status: 'blocked' },
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze,
      }),
    /does not bind/u,
  );

  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan: { ...plan, summary: { ...plan.summary, scaled_exchanges: 58 } },
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze,
      }),
    /counts do not match/u,
  );

  for (const missing of ['scaled_exchanges', 'scaled_amount_fields'] as const) {
    rejects(
      () =>
        assertProtectedFreezeMatchesPlan({
          plan: { ...plan, summary: { ...plan.summary, [missing]: undefined } },
          planFileSha256: HASH_E,
          aliasPlanRequestSha256: HASH_C,
          freeze,
        }),
      /counts do not match/u,
    );
  }

  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan: {
          ...plan,
          summary: { ...plan.summary, unrelated_exchanges_preserved: undefined },
        },
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze,
      }),
    /counts do not match/u,
  );

  const wrongSet = copy(freeze);
  wrongSet.sets.before_hash_set_sha256 = HASH_A;
  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan,
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze: wrongSet,
      }),
    /Freeze set hash mismatch/u,
  );

  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan,
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_D,
        freeze,
      }),
    /exact serialized database plan/u,
  );

  const wrongBaseline = copy(freeze);
  wrongBaseline.sets.derivative_baseline_set_sha256 = HASH_A;
  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan,
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze: wrongBaseline,
      }),
    /baseline set hash/u,
  );

  const wrongTarget = copy(freeze);
  wrongTarget.derivative_targets[0]!.id = 'missing-flow';
  wrongTarget.sets.derivative_baseline_set_sha256 = protectedDerivativeBaselineSetSha256(
    wrongTarget.derivative_targets,
  );
  rejects(
    () =>
      assertProtectedFreezeMatchesPlan({
        plan,
        planFileSha256: HASH_E,
        aliasPlanRequestSha256: HASH_C,
        freeze: wrongTarget,
      }),
    /Derivative baseline does not bind action/u,
  );
});

test('derivative snapshots require exact identity and internally consistent hashes', () => {
  const expected = { table: 'flows' as const, id: 'flow-01', version: VERSION, userId: USER_ID };
  const base = {
    ok: true,
    command: 'cmd_dataset_derivative_rebuild_snapshot',
    schema_version: 'dataset-derivative-snapshot.v1',
    table: expected.table,
    id: expected.id,
    version: expected.version,
    user_id: expected.userId,
    state_code: 0,
    modified_at: '2026-07-15T00:00:00.000Z',
    json_sha256: HASH_A,
    json_ordered_sha256: HASH_A,
    extracted_md_sha256: null,
    embedding_ft_sha256: null,
    embedding_ft_at: null,
    snapshot_sha256: HASH_C,
  };
  const emptyDerivative = parseProtectedDerivativeSnapshot(base, expected);
  assert.equal(emptyDerivative.extracted_md_sha256, null);

  const populated = parseProtectedDerivativeSnapshot(
    {
      ...base,
      extracted_md_sha256: HASH_D,
      embedding_ft_sha256: HASH_E,
      embedding_ft_at: '2026-07-15T00:00:01.000Z',
    },
    expected,
  );
  assert.equal(populated.embedding_ft_sha256, HASH_E);

  rejects(() => parseProtectedDerivativeSnapshot(null, expected), /foreign or unsupported/u);
  rejects(
    () => parseProtectedDerivativeSnapshot({ ...base, json_ordered_sha256: HASH_B }, expected),
    /inconsistent/u,
  );
  rejects(
    () => parseProtectedDerivativeSnapshot({ ...base, snapshot_sha256: 'bad' }, expected),
    /lowercase SHA-256/u,
  );
});

test('preflight, three server gates, and admission accept only the sealed one-shot chain', () => {
  const identity = identityFixture();
  const preflight = preflightFixture(identity);
  assert.equal(preflight.failure_baseline_sha256, HASH_F);

  const results = {} as Record<
    ProtectedGateProof['gate'],
    ReturnType<typeof parseProtectedGateProof>
  >;
  for (const gate of [
    'primary_support_plan',
    'execution_unused',
    'derivative_quiescence',
  ] as const) {
    results[gate] = parseProtectedGateProof(gateResponse(identity, preflight, gate), {
      identity,
      preflight,
      gate,
    });
  }
  const request = buildProtectedAdmitRequest({
    preflight,
    gateResults: {
      primary_support_plan: results.primary_support_plan.result,
      execution_unused: results.execution_unused.result,
      derivative_quiescence: results.derivative_quiescence.result,
    },
  });
  assert.deepEqual(Object.keys(request).sort(), [
    'gate_results',
    'preflight_proof_sha256',
    'preflight_token',
    'request_id',
    'schema_version',
  ]);

  const admission = parseProtectedAdmissionProof(
    {
      ok: true,
      command: PROTECTED_EXECUTION_CONTRACT.admit_command,
      schema_version: PROTECTED_EXECUTION_CONTRACT.admit_response_schema,
      request_id: identity.request_id,
      plan_sha256: identity.plan_sha256,
      operation_id: identity.operation_id,
      plan_request_sha256: preflight.plan_request_sha256,
      preflight_proof_sha256: preflight.preflight_proof_sha256,
      admission_request_sha256: HASH_D,
      gate_results_sha256: HASH_E,
      status: 'dispatched',
      attempt_count: 1,
      dispatch_count: 1,
      net_request_id: 'net-request-1',
      attempt_consumed: true,
      retry_allowed: false,
    },
    identity,
    preflight,
  );
  assert.equal(admission.status, 'dispatched');
});

test('preflight, gate, and admission reject foreign, stale, or mismatched proofs', () => {
  const identity = identityFixture();
  rejects(
    () => parseProtectedPreflightProof(null, identity, new Date('2026-07-15T00:00:30.000Z')),
    /foreign or unsupported/u,
  );

  const badSimulation = preflightResponse(identity);
  badSimulation.simulation.plan_rows = 51;
  rejects(
    () =>
      parseProtectedPreflightProof(badSimulation, identity, new Date('2026-07-15T00:00:30.000Z')),
    /exact protected profile/u,
  );

  const missingServerGates = preflightResponse(identity);
  (missingServerGates as Record<string, unknown>).gate_expectations = null;
  rejects(
    () =>
      parseProtectedPreflightProof(
        missingServerGates,
        identity,
        new Date('2026-07-15T00:01:00.000Z'),
      ),
    /gate_expectations must be an object/u,
  );

  const expired = preflightResponse(identity);
  rejects(
    () => parseProtectedPreflightProof(expired, identity, new Date('2026-07-15T00:03:01.000Z')),
    /token is stale/u,
  );

  const atExpiry = preflightResponse(identity);
  rejects(
    () => parseProtectedPreflightProof(atExpiry, identity, new Date(atExpiry.expires_at)),
    /token is stale/u,
  );

  const exactWindow = preflightResponse(identity);
  assert.equal(
    parseProtectedPreflightProof(exactWindow, identity, new Date('2026-07-15T00:00:00.000Z'))
      .request_id,
    identity.request_id,
  );

  const withinClockSkew = preflightResponse(identity);
  withinClockSkew.completed_at = '2026-07-15T00:00:05.000Z';
  withinClockSkew.expires_at = '2026-07-15T00:03:05.000Z';
  assert.equal(
    parseProtectedPreflightProof(withinClockSkew, identity, new Date('2026-07-15T00:00:00.000Z'))
      .completed_at,
    withinClockSkew.completed_at,
  );

  const beyondClockSkew = preflightResponse(identity);
  beyondClockSkew.completed_at = '2026-07-15T00:00:05.001Z';
  beyondClockSkew.expires_at = '2026-07-15T00:03:05.001Z';
  assert.throws(
    () =>
      parseProtectedPreflightProof(beyondClockSkew, identity, new Date('2026-07-15T00:00:00.000Z')),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /future-issued beyond the 5-second/u);
      assert.deepEqual(error.details, {
        completed_at: beyondClockSkew.completed_at,
        expires_at: beyondClockSkew.expires_at,
        observed_at: '2026-07-15T00:00:00.000Z',
        window_ms: 180_000,
        future_skew_ms: 5_001,
        allowed_future_skew_ms: 5_000,
      });
      return true;
    },
  );

  const overlong = preflightResponse(identity);
  overlong.expires_at = '2026-07-15T00:03:00.001Z';
  rejects(
    () => parseProtectedPreflightProof(overlong, identity, new Date('2026-07-15T00:00:30.000Z')),
    /exceeds the 180-second/u,
  );

  const zeroWindow = preflightResponse(identity);
  zeroWindow.expires_at = zeroWindow.completed_at;
  rejects(
    () => parseProtectedPreflightProof(zeroWindow, identity, new Date('2026-07-14T23:59:59.000Z')),
    /expiry must be later/u,
  );

  const reversed = preflightResponse(identity);
  reversed.expires_at = '2026-07-14T23:59:59.999Z';
  rejects(
    () => parseProtectedPreflightProof(reversed, identity, new Date('2026-07-14T23:59:59.000Z')),
    /expiry must be later/u,
  );

  const preflight = preflightFixture(identity);
  rejects(
    () => parseProtectedGateProof(null, { identity, preflight, gate: 'primary_support_plan' }),
    /foreign, failed/u,
  );

  for (const mutation of [
    { expected_sha256: HASH_B },
    { observed_sha256: HASH_B },
    { captured_at: '2026-07-14T23:59:59.000Z' },
    { captured_at: '2026-07-15T00:03:01.000Z' },
  ]) {
    rejects(
      () =>
        parseProtectedGateProof(
          { ...gateResponse(identity, preflight, 'primary_support_plan'), ...mutation },
          { identity, preflight, gate: 'primary_support_plan' },
        ),
      /frozen digest or server preflight window/u,
    );
  }

  rejects(() => parseProtectedAdmissionProof(null, identity, preflight), /foreign, duplicate/u);
});

test('status parsing covers not-admitted, pending, passed, failed, and indeterminate states', () => {
  const identity = identityFixture();

  const notAdmitted = parseProtectedStatusProof(notAdmittedStatus(identity), identity);
  assert.equal(notAdmitted.execution_status, 'not_admitted');
  assert.equal(notAdmitted.derivative_readback.status, 'not_started');

  const pending = parseProtectedStatusProof(
    admittedStatus(identity, 'pending', 'dispatched', 'not_started', {
      code: undefined,
      nullableCounts: true,
    }),
    identity,
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.primary_readback?.row_count, null);

  const passed = parseProtectedStatusProof(
    admittedStatus(identity, 'passed', 'completed', 'completed', { code: null }),
    identity,
  );
  assert.equal(passed.derivative_readback.targets.length, 50);
  if (passed.derivative_readback.proof_level !== 'causal_terminal') {
    assert.fail('completed readback must expose the causal terminal proof shape');
  }
  assert.equal(passed.derivative_readback.targets[0]?.completed_snapshot_sha256, null);

  const failed = parseProtectedStatusProof(
    admittedStatus(identity, 'failed', 'failed', 'failed', {
      code: 'DERIVATIVE_FAILED',
      error: { code: 'DERIVATIVE_FAILED' },
    }),
    identity,
  );
  assert.deepEqual(failed.failure, { code: 'DERIVATIVE_FAILED' });

  const failedBeforeDerivativeAdmission = parseProtectedStatusProof(
    admittedStatus(identity, 'failed', 'failed', 'not_started', {
      error: { code: 'ALIAS_EXECUTION_FAILED' },
    }),
    identity,
  );
  assert.equal(failedBeforeDerivativeAdmission.derivative_readback.status, 'not_started');

  const indeterminateBeforeDerivativeAdmission = parseProtectedStatusProof(
    admittedStatus(identity, 'indeterminate', 'indeterminate', 'not_started', {
      error: { code: 'ALIAS_EXECUTION_INDETERMINATE' },
    }),
    identity,
  );
  assert.equal(indeterminateBeforeDerivativeAdmission.derivative_readback.status, 'not_started');

  const deferredFailureValue = admittedStatus(identity, 'failed', 'failed', 'pending', {
    error: { code: 'DEFERRED_FAILURE_PROOF' },
  });
  (deferredFailureValue.derivative_readback as Record<string, unknown>).status = 'failed';
  (deferredFailureValue.derivative_readback as Record<string, unknown>).proof_deferred = false;
  const deferredFailure = parseProtectedStatusProof(deferredFailureValue, identity);
  assert.equal(deferredFailure.derivative_readback.proof_level, 'status_only');

  const indeterminate = parseProtectedStatusProof(
    admittedStatus(identity, 'indeterminate', 'indeterminate', 'pending'),
    identity,
  );
  assert.equal(indeterminate.status, 'indeterminate');
});

test('status parsing rejects malformed envelopes, gates, bindings, readbacks, and terminal targets', () => {
  const identity = identityFixture();
  rejects(() => parseProtectedStatusProof(null, identity), /foreign or unsupported/u);

  const tooManyGates = notAdmittedStatus(identity);
  tooManyGates.gates = [...readGates(), readGates()[0]!];
  tooManyGates.gate_count = 4;
  rejects(() => parseProtectedStatusProof(tooManyGates, identity), /at most three gate receipts/u);

  const wrongBinding = admittedStatus(identity, 'pending', 'running', 'pending');
  wrongBinding.freeze_sha256 = HASH_A;
  rejects(() => parseProtectedStatusProof(wrongBinding, identity), /sealed owner-draft/u);

  const noGates = admittedStatus(identity, 'pending', 'running', 'pending');
  noGates.gates = null;
  rejects(() => parseProtectedStatusProof(noGates, identity), /gates must be an array/u);

  const badGate = admittedStatus(identity, 'pending', 'running', 'pending');
  badGate.gates = [{ ...readGates()[0], status: 'failed' }];
  rejects(() => parseProtectedStatusProof(badGate, identity), /gates\[0\] is invalid/u);

  const badReadback = admittedStatus(identity, 'pending', 'running', 'pending');
  badReadback.derivative_readback = null;
  rejects(
    () => parseProtectedStatusProof(badReadback, identity),
    /derivative_readback is invalid/u,
  );

  const malformedNotStarted = admittedStatus(identity, 'pending', 'running', 'not_started');
  (malformedNotStarted.derivative_readback as Record<string, unknown>).target_count = 1;
  rejects(
    () => parseProtectedStatusProof(malformedNotStarted, identity),
    /exact zero-count proof envelope/u,
  );

  const lateNotStarted = admittedStatus(identity, 'pending', 'derivatives_pending', 'not_started');
  rejects(
    () => parseProtectedStatusProof(lateNotStarted, identity),
    /only valid before derivative dispatch or after a zero-child terminal failure/u,
  );

  const completedWithoutDerivatives = admittedStatus(
    identity,
    'passed',
    'completed',
    'not_started',
  );
  rejects(
    () => parseProtectedStatusProof(completedWithoutDerivatives, identity),
    /only valid before derivative dispatch or after a zero-child terminal failure/u,
  );

  const noTargets = admittedStatus(identity, 'pending', 'running', 'pending');
  (noTargets.derivative_readback as Record<string, unknown>).targets = null;
  rejects(() => parseProtectedStatusProof(noTargets, identity), /targets must be an array/u);

  const badTargetObject = admittedStatus(identity, 'pending', 'running', 'pending');
  ((badTargetObject.derivative_readback as Record<string, unknown>).targets as unknown[])[0] = null;
  rejects(() => parseProtectedStatusProof(badTargetObject, identity), /lightweight flow\/process/u);

  const badTerminalObject = admittedStatus(identity, 'passed', 'completed', 'completed');
  ((badTerminalObject.derivative_readback as Record<string, unknown>).targets as unknown[])[0] =
    null;
  rejects(
    () => parseProtectedStatusProof(badTerminalObject, identity),
    /object with residue counts/u,
  );

  const badStatusOrdinal = admittedStatus(identity, 'pending', 'running', 'pending');
  (
    (badStatusOrdinal.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.ordinal = 0;
  rejects(() => parseProtectedStatusProof(badStatusOrdinal, identity), /exact 50-target range/u);

  const prematureCausal = admittedStatus(identity, 'pending', 'running', 'pending');
  (
    (prematureCausal.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.causal_terminal_proof = true;
  rejects(() => parseProtectedStatusProof(prematureCausal, identity), /must be false/u);

  const badStatusError = admittedStatus(identity, 'pending', 'running', 'pending');
  (
    (badStatusError.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.error = 'bad';
  rejects(() => parseProtectedStatusProof(badStatusError, identity), /error must be an object/u);

  const badTargetTable = admittedStatus(identity, 'passed', 'completed', 'completed');
  (
    (badTargetTable.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.table = 'sources';
  rejects(() => parseProtectedStatusProof(badTargetTable, identity), /flows or processes/u);

  const badOrdinal = admittedStatus(identity, 'passed', 'completed', 'completed');
  (
    (badOrdinal.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.ordinal = 0;
  rejects(() => parseProtectedStatusProof(badOrdinal, identity), /exact 50-target range/u);

  const negativeCount = admittedStatus(identity, 'pending', 'running', 'pending');
  (negativeCount.derivative_readback as Record<string, unknown>).failed_count = -1;
  rejects(() => parseProtectedStatusProof(negativeCount, identity), /non-negative integer/u);

  const inconsistentStatusOnly = admittedStatus(identity, 'pending', 'running', 'pending');
  (inconsistentStatusOnly.derivative_readback as Record<string, unknown>).proof_deferred = 'yes';
  rejects(
    () => parseProtectedStatusProof(inconsistentStatusOnly, identity),
    /inconsistent proof metadata/u,
  );

  const badTerminalEnvelope = admittedStatus(identity, 'passed', 'completed', 'completed');
  (badTerminalEnvelope.derivative_readback as Record<string, unknown>).proof_level = 'none';
  rejects(() => parseProtectedStatusProof(badTerminalEnvelope, identity), /causal proof envelope/u);

  const badBoolean = admittedStatus(identity, 'passed', 'completed', 'completed');
  (
    (badBoolean.derivative_readback as Record<string, unknown>).targets as Array<
      Record<string, unknown>
    >
  )[0]!.primary_matches = 'yes';
  rejects(() => parseProtectedStatusProof(badBoolean, identity), /must be boolean/u);

  const badError = admittedStatus(identity, 'failed', 'failed', 'failed', { error: 'bad' });
  rejects(() => parseProtectedStatusProof(badError, identity), /object or null/u);

  const badClosure = admittedStatus(identity, 'pending', 'running', 'pending');
  (badClosure.primary_readback as Record<string, unknown>).closure = null;
  rejects(() => parseProtectedStatusProof(badClosure, identity), /closure must be an object/u);
});
