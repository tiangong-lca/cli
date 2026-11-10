import { parseCompensationTarget } from './base.js';
import type {
  FlowIdentityPlan,
  FlowIdentityProcessManifest,
} from '../../dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from '../contract/values.js';
import type { JsonObject } from '../contract/types.js';
import {
  HASH_PATTERN,
  UUID_PATTERN,
  type FlowIdentityScopeProcessStatus,
  type FlowIdentityCompensationTarget,
  type FlowIdentityScopeStatus,
  type FlowIdentityFinalizeProof,
  fail,
  token,
  integer,
} from './base.js';
import {
  parseFlowIdentityDerivativeSetProof,
  parseFlowIdentityWholeScopeProof,
} from './derivative-proofs.js';
import { assertExactKeys } from './base.js';

export function parseScopeProcess(
  value: unknown,
  expected: FlowIdentityProcessManifest,
): FlowIdentityScopeProcessStatus {
  if (!isJsonObject(value)) fail('Flow identity scope process ledger entry is invalid.');
  assertExactKeys(
    value,
    [
      'ordinal',
      'id',
      'version',
      'status',
      'process_request_sha256',
      'process_intent_proof_sha256',
      'desired_payload_sha256',
      'desired_exchange_set_sha256',
      'rewrite_count',
      'audit_id',
      'before_payload_sha256',
      'before_exchange_set_sha256',
      'after_payload_sha256',
      'after_exchange_set_sha256',
      'derivative_batch_id',
      'derivative_request_id',
      'derivative_status',
      'causal_terminal_proof',
      'completed_at',
      'last_error',
    ],
    'scope process ledger entry',
  );
  if (
    value.ordinal !== expected.ordinal ||
    value.id !== expected.id ||
    value.version !== expected.version ||
    value.rewrite_count !== expected.rewrite_count ||
    value.desired_payload_sha256 !== expected.desired_payload_sha256 ||
    value.desired_exchange_set_sha256 !== expected.desired_exchange_set_sha256 ||
    !HASH_PATTERN.test(String(value.before_payload_sha256)) ||
    !HASH_PATTERN.test(String(value.before_exchange_set_sha256)) ||
    !HASH_PATTERN.test(String(value.process_intent_proof_sha256)) ||
    !['pending', 'completed', 'failed'].includes(String(value.status))
  ) {
    fail('Flow identity scope process ledger does not match the sealed manifest.');
  }
  const completed = value.status === 'completed';
  const pending = value.status === 'pending';
  const missingOriginalDerivative =
    value.derivative_request_id === null && value.derivative_status === 'missing';
  const presentOriginalDerivative =
    UUID_PATTERN.test(String(value.derivative_request_id)) &&
    typeof value.derivative_status === 'string' &&
    Boolean(value.derivative_status.trim()) &&
    value.derivative_status !== 'missing';
  if (
    completed &&
    (!HASH_PATTERN.test(String(value.process_request_sha256)) ||
      !token(value.audit_id, 'audit_id') ||
      !HASH_PATTERN.test(String(value.after_payload_sha256)) ||
      !HASH_PATTERN.test(String(value.after_exchange_set_sha256)) ||
      value.after_payload_sha256 !== expected.desired_payload_sha256 ||
      value.after_exchange_set_sha256 !== expected.desired_exchange_set_sha256 ||
      !UUID_PATTERN.test(String(value.derivative_batch_id)) ||
      (!missingOriginalDerivative && !presentOriginalDerivative) ||
      !value.completed_at ||
      !Number.isFinite(Date.parse(String(value.completed_at))))
  ) {
    fail('Completed flow identity process ledger proof is incomplete.');
  }
  if (
    pending &&
    (value.process_request_sha256 !== null ||
      value.audit_id !== null ||
      value.after_payload_sha256 !== null ||
      value.after_exchange_set_sha256 !== null ||
      value.derivative_batch_id !== null ||
      value.derivative_request_id !== null ||
      value.derivative_status !== null ||
      value.completed_at !== null)
  ) {
    fail('Pending flow identity process ledger unexpectedly contains completion proof.');
  }
  if (value.causal_terminal_proof !== false) {
    fail('Scope status must not substitute a child status bit for terminal causal proof.');
  }
  return value as FlowIdentityScopeProcessStatus;
}

export function parseCompensationEnvelope(
  value: JsonObject,
  plan: FlowIdentityPlan,
  scopeId: string,
  source: 'scope_read' | 'finalize',
): FlowIdentityCompensationTarget[] {
  if (value.compensation_required === undefined) return [];
  if (typeof value.compensation_required !== 'boolean') {
    fail('Flow identity compensation_required must be boolean.');
  }
  if (value.compensation_required === false) {
    if (
      value.automatic_retry !== false ||
      (value.compensation_targets !== undefined &&
        (!Array.isArray(value.compensation_targets) || value.compensation_targets.length !== 0))
    ) {
      fail('Non-required compensation envelope is malformed.');
    }
    return [];
  }
  if (
    (source === 'scope_read'
      ? !['derivatives_pending', 'completed'].includes(String(value.status))
      : value.status !== 'derivatives_pending') ||
    value.code !== 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED' ||
    value.automatic_retry !== false ||
    !Array.isArray(value.compensation_targets) ||
    value.compensation_targets.length === 0
  ) {
    fail('Required derivative compensation envelope is malformed.');
  }
  return value.compensation_targets.map((entry) =>
    parseCompensationTarget(entry, plan, scopeId, source),
  );
}

export function parseFlowIdentityScopeStatus(
  value: unknown,
  plan: FlowIdentityPlan,
  scopeId: string,
  scopeProofSha256: string,
): FlowIdentityScopeStatus {
  if (!isJsonObject(value) || !Array.isArray(value.processes)) {
    fail('Flow identity scope status is invalid.');
  }
  const scopeStatusKeys = [
    'ok',
    'command',
    'schema_version',
    'scope_id',
    'receipt_id',
    'receipt_proof_sha256',
    'mapping_guard_set_sha256',
    'process_intent_set_sha256',
    'operation_id',
    'plan_sha256',
    'scope_proof_sha256',
    'status',
    'process_count',
    'completed_process_count',
    'pending_process_count',
    'failed_process_count',
    'next_ordinal',
    'rewrite_count',
    'completed_rewrite_count',
    'primary_complete',
    'cancellable',
    'strict_continuation_required',
    'primary_current',
    'live_guard_current',
    'derivatives_current',
    'derivative_pending_count',
    'derivative_failed_count',
    'derivative_set_proof',
    'derivative_proof_set_sha256',
    'compensation_required',
    'automatic_retry',
    'compensation_targets',
    'protected_closure_current',
    'protected_closure_proof',
    'processes',
    'terminal_proof_sha256',
    'completed_at',
    'whole_scope_proof',
    'whole_scope_proof_sha256',
    ...(value.code === undefined ? [] : ['code']),
  ];
  assertExactKeys(value, scopeStatusKeys, 'scope status result');
  const processes = value.processes.map((entry, index) => {
    const expected = plan.processes[index];
    if (!expected) fail('Scope status contains a foreign process ledger entry.');
    return parseScopeProcess(entry, expected);
  });
  const derivativeSetProof = parseFlowIdentityDerivativeSetProof({
    value: value.derivative_set_proof,
    plan,
    scopeId,
    processes,
  });
  const wholeScopeProof = parseFlowIdentityWholeScopeProof({
    value: value.whole_scope_proof,
    scopeId,
    receiptId: plan.receipt_id,
  });
  const status = String(value.status);
  const liveDrift = status === 'live_drift';
  if (
    integer(value.process_count, 'process_count') !== plan.processes.length ||
    integer(value.rewrite_count, 'rewrite_count') !== plan.summary.rewrites ||
    integer(value.pending_process_count, 'pending_process_count') !==
      processes.filter((entry) => entry.status === 'pending').length ||
    integer(value.failed_process_count, 'failed_process_count') !==
      processes.filter((entry) => entry.status === 'failed').length ||
    integer(value.completed_rewrite_count, 'completed_rewrite_count') !==
      processes
        .filter((entry) => entry.status === 'completed')
        .reduce((sum, entry) => sum + entry.rewrite_count, 0)
  ) {
    fail('Flow identity scope status counts do not match the plan.');
  }
  if (
    value.ok !==
      (!['failed', 'live_drift'].includes(status) && value.compensation_required !== true) ||
    value.command !== 'cmd_dataset_flow_identity_scope_read' ||
    value.schema_version !== 'dataset-flow-identity-scope-status.v2' ||
    value.scope_id !== scopeId ||
    value.receipt_id !== plan.receipt_id ||
    value.receipt_proof_sha256 !== plan.receipt_proof_sha256 ||
    value.mapping_guard_set_sha256 !== plan.mapping_guard_set_sha256 ||
    value.process_intent_set_sha256 !== plan.process_intent_set_sha256 ||
    value.operation_id !== plan.operation_id ||
    value.plan_sha256 !== plan.plan_sha256 ||
    value.scope_proof_sha256 !== scopeProofSha256 ||
    ![
      'sealed',
      'running',
      'primary_complete',
      'derivatives_pending',
      'completed',
      'live_drift',
      'failed',
    ].includes(String(value.status)) ||
    processes.length !== plan.processes.length ||
    integer(value.completed_process_count, 'completed_process_count') !==
      processes.filter((entry) => entry.status === 'completed').length ||
    integer(value.next_ordinal, 'next_ordinal', 1) !==
      Math.min(
        processes.find((entry) => entry.status === 'pending')?.ordinal ?? processes.length + 1,
        processes.length + 1,
      ) ||
    typeof value.primary_complete !== 'boolean' ||
    value.primary_complete !== processes.every((entry) => entry.status === 'completed') ||
    typeof value.cancellable !== 'boolean' ||
    value.cancellable !==
      (processes.every((entry) => entry.status === 'pending') &&
        !['completed', 'failed', 'live_drift'].includes(status)) ||
    typeof value.strict_continuation_required !== 'boolean' ||
    value.strict_continuation_required !==
      (processes.some((entry) => entry.status === 'completed') &&
        processes.some((entry) => entry.status === 'pending')) ||
    typeof value.primary_current !== 'boolean' ||
    value.primary_current !== wholeScopeProof.primary_current ||
    typeof value.live_guard_current !== 'boolean' ||
    value.live_guard_current !==
      (wholeScopeProof.audit_current &&
        wholeScopeProof.source_guards_current &&
        wholeScopeProof.support_guards_current &&
        wholeScopeProof.target_guards_current &&
        wholeScopeProof.protected_closure_current &&
        wholeScopeProof.occurrence_closure_current) ||
    typeof value.derivatives_current !== 'boolean' ||
    (!liveDrift && value.derivatives_current !== derivativeSetProof.causal_terminal_proof) ||
    value.derivatives_current !== wholeScopeProof.derivatives_current ||
    integer(value.derivative_pending_count, 'derivative_pending_count') !==
      derivativeSetProof.pending_count ||
    integer(value.derivative_failed_count, 'derivative_failed_count') !==
      derivativeSetProof.failed_count ||
    value.derivative_proof_set_sha256 !== derivativeSetProof.proof_sha256 ||
    wholeScopeProof.derivative_proof_set_sha256 !== derivativeSetProof.proof_sha256 ||
    typeof value.protected_closure_current !== 'boolean' ||
    value.protected_closure_current !== wholeScopeProof.protected_closure_current ||
    !isJsonObject(value.protected_closure_proof) ||
    value.whole_scope_proof_sha256 !== wholeScopeProof.proof_sha256 ||
    value.automatic_retry !== false ||
    typeof value.compensation_required !== 'boolean' ||
    (!liveDrift && value.compensation_required !== derivativeSetProof.failed_count > 0) ||
    !Array.isArray(value.compensation_targets)
  ) {
    fail('Flow identity scope status does not match the sealed plan/progress ledger.');
  }
  if (
    (status === 'completed' &&
      (!wholeScopeProof.primary_current ||
        !wholeScopeProof.audit_current ||
        !wholeScopeProof.source_guards_current ||
        !wholeScopeProof.support_guards_current ||
        !wholeScopeProof.target_guards_current ||
        wholeScopeProof.approved_reference_residue_count !== 0 ||
        !wholeScopeProof.protected_closure_current ||
        !wholeScopeProof.occurrence_closure_current ||
        !wholeScopeProof.derivatives_current ||
        !wholeScopeProof.causal_terminal_proof)) ||
    (liveDrift &&
      (value.ok !== false ||
        !['FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT', 'FLOW_IDENTITY_SCOPE_TERMINAL_CONFLICT'].includes(
          String(value.code),
        ) ||
        (value.primary_current === true && value.live_guard_current === true) ||
        value.derivatives_current !== false ||
        value.compensation_required !== false ||
        !Array.isArray(value.compensation_targets) ||
        value.compensation_targets.length !== 0))
  ) {
    fail('Flow identity completed/live-drift status contradicts the dynamic whole-scope proof.');
  }
  if (
    value.status === 'completed'
      ? !HASH_PATTERN.test(String(value.terminal_proof_sha256))
      : value.terminal_proof_sha256 !== null
  ) {
    fail('Flow identity scope terminal proof does not match its status.');
  }
  if (
    status === 'completed'
      ? !Number.isFinite(Date.parse(String(value.completed_at)))
      : value.completed_at !== null
  ) {
    fail('Flow identity scope completion timestamp does not match its status.');
  }
  const compensationTargets = liveDrift
    ? []
    : parseCompensationEnvelope(value, plan, scopeId, 'scope_read');
  if (
    !liveDrift &&
    (compensationTargets.length !== derivativeSetProof.compensation_targets.length ||
      compensationTargets.some((entry, index) => {
        const derivativeEntry = derivativeSetProof.compensation_targets[index];
        return (
          !derivativeEntry ||
          entry.ordinal !== derivativeEntry.ordinal ||
          entry.id !== derivativeEntry.id ||
          entry.version !== derivativeEntry.version ||
          entry.original_batch_id !== derivativeEntry.original_batch_id ||
          entry.original_status !== derivativeEntry.original_status ||
          entry.original_code !== derivativeEntry.original_code ||
          entry.desired_payload_sha256 !== derivativeEntry.desired_payload_sha256 ||
          entry.current_json_ordered_sha256 !== derivativeEntry.current_json_ordered_sha256 ||
          entry.current_snapshot_sha256 !== derivativeEntry.current_snapshot_sha256 ||
          entry.latest_compensation_request_id !== derivativeEntry.latest_compensation_request_id ||
          entry.latest_compensation_status !== derivativeEntry.latest_compensation_status ||
          entry.latest_compensation_plan_sha256 !== derivativeEntry.latest_compensation_plan_sha256
        );
      }))
  ) {
    fail('Scope compensation convenience fields do not match the dynamic derivative proof.');
  }
  return {
    ...(value as FlowIdentityScopeStatus),
    processes,
    derivative_set_proof: derivativeSetProof,
    whole_scope_proof: wholeScopeProof,
    compensation_targets: compensationTargets,
  };
}

export function flowIdentityScopeHasCurrentDerivativeClosure(
  status: FlowIdentityScopeStatus,
): boolean {
  return Boolean(
    status.status === 'completed' &&
    typeof status.terminal_proof_sha256 === 'string' &&
    HASH_PATTERN.test(status.terminal_proof_sha256) &&
    flowIdentityScopeIsReadyToFinalize(status),
  );
}

export function flowIdentityScopeIsReadyToFinalize(status: FlowIdentityScopeStatus): boolean {
  const proof = status.derivative_set_proof;
  const whole = status.whole_scope_proof;
  return Boolean(
    ['primary_complete', 'completed'].includes(status.status) &&
    status.primary_complete &&
    status.primary_current &&
    status.live_guard_current &&
    status.derivatives_current &&
    status.protected_closure_current &&
    status.derivative_pending_count === 0 &&
    status.derivative_failed_count === 0 &&
    status.compensation_required === false &&
    status.compensation_targets?.length === 0 &&
    proof.ok &&
    proof.status === 'completed' &&
    proof.target_count === status.process_count &&
    proof.completed_count === status.process_count &&
    proof.pending_count === 0 &&
    proof.failed_count === 0 &&
    proof.causal_terminal_proof &&
    proof.targets.length === status.process_count &&
    proof.compensation_targets.length === 0 &&
    HASH_PATTERN.test(proof.proof_sha256) &&
    whole.primary_current &&
    whole.audit_current &&
    whole.source_guards_current &&
    whole.support_guards_current &&
    whole.target_guards_current &&
    whole.approved_reference_residue_count === 0 &&
    whole.protected_closure_current &&
    whole.occurrence_closure_current &&
    whole.derivatives_current &&
    whole.causal_terminal_proof &&
    whole.proof_sha256 === status.whole_scope_proof_sha256 &&
    proof.targets.every((target, index) => {
      const process = status.processes[index];
      return (
        process?.status === 'completed' &&
        target.ordinal === index + 1 &&
        target.current_json_ordered_sha256 === process.desired_payload_sha256 &&
        target.status === 'completed' &&
        target.request_status === 'completed' &&
        target.phase === 'completed' &&
        target.lineage_ok &&
        target.proposals_committed &&
        target.terminal_audit_present &&
        HASH_PATTERN.test(target.current_snapshot_sha256) &&
        Object.values(target.residue).every((count) => count === 0) &&
        target.causal_terminal_proof
      );
    }),
  );
}

export function parseFlowIdentityFinalizeProof(options: {
  value: unknown;
  plan: FlowIdentityPlan;
  scopeId: string;
  scopeProofSha256: string;
  request: JsonObject;
  expectedInvocationId?: string;
  expectedPermitGenerationBefore?: number;
}): FlowIdentityFinalizeProof {
  if (!isJsonObject(options.value) || !isJsonObject(options.request.expected)) {
    fail('Flow identity finalize proof is invalid.');
  }
  const value = options.value;
  const expected = options.request.expected;
  const completed = value.status === 'completed';
  const failed = value.status === 'failed';
  const liveDrift = value.status === 'live_drift';
  const compensationRequired = value.compensation_required === true;
  const derivativesPending = value.status === 'derivatives_pending';
  const wholeScopeProof = parseFlowIdentityWholeScopeProof({
    value: value.whole_scope_proof,
    scopeId: options.scopeId,
    receiptId: options.plan.receipt_id,
  });
  const finalizeKeys = [
    'ok',
    'command',
    'schema_version',
    'scope_id',
    'receipt_id',
    'receipt_proof_sha256',
    'mapping_guard_set_sha256',
    'process_intent_set_sha256',
    'operation_id',
    'plan_sha256',
    'scope_proof_sha256',
    'invocation_id',
    'permit_generation_before',
    'status',
    'process_count',
    'completed_process_count',
    'rewrite_count',
    'primary_closure_sha256',
    'protected_closure_sha256',
    'derivative_target_set_sha256',
    'derivative_proof_set_sha256',
    'primary_current',
    'live_guard_current',
    'derivatives_current',
    'terminal_proof_sha256',
    'whole_scope_proof',
    'whole_scope_proof_sha256',
    'audit_id',
    'replay',
    ...(completed
      ? []
      : ['code', 'compensation_required', 'automatic_retry', 'compensation_targets']),
  ];
  assertExactKeys(value, finalizeKeys, `${String(value.status)} finalize result`);
  if (
    value.ok !== (!failed && !liveDrift && !compensationRequired) ||
    value.command !== 'cmd_dataset_flow_identity_scope_finalize_guarded' ||
    value.schema_version !== 'dataset-flow-identity-scope-finalize-result.v2' ||
    value.scope_id !== options.scopeId ||
    value.receipt_id !== options.plan.receipt_id ||
    value.receipt_proof_sha256 !== options.plan.receipt_proof_sha256 ||
    value.mapping_guard_set_sha256 !== options.plan.mapping_guard_set_sha256 ||
    value.process_intent_set_sha256 !== options.plan.process_intent_set_sha256 ||
    value.operation_id !== options.plan.operation_id ||
    value.plan_sha256 !== options.plan.plan_sha256 ||
    value.scope_proof_sha256 !== options.scopeProofSha256 ||
    !UUID_PATTERN.test(String(value.invocation_id)) ||
    !Number.isSafeInteger(value.permit_generation_before) ||
    Number(value.permit_generation_before) < 0 ||
    (options.expectedInvocationId !== undefined &&
      value.invocation_id !== options.expectedInvocationId) ||
    (options.expectedPermitGenerationBefore !== undefined &&
      value.permit_generation_before !== options.expectedPermitGenerationBefore) ||
    !['derivatives_pending', 'completed', 'live_drift', 'failed'].includes(String(value.status)) ||
    value.process_count !== expected.process_count ||
    value.rewrite_count !== expected.rewrite_count ||
    value.completed_process_count !== expected.completed_process_count ||
    !HASH_PATTERN.test(String(value.primary_closure_sha256)) ||
    !HASH_PATTERN.test(String(value.protected_closure_sha256)) ||
    !HASH_PATTERN.test(String(value.derivative_target_set_sha256)) ||
    !HASH_PATTERN.test(String(value.derivative_proof_set_sha256)) ||
    value.primary_closure_sha256 !== wholeScopeProof.primary_closure_sha256 ||
    value.protected_closure_sha256 !== wholeScopeProof.protected_closure_sha256 ||
    value.derivative_proof_set_sha256 !== wholeScopeProof.derivative_proof_set_sha256 ||
    typeof value.primary_current !== 'boolean' ||
    value.primary_current !== wholeScopeProof.primary_current ||
    typeof value.live_guard_current !== 'boolean' ||
    value.live_guard_current !==
      (wholeScopeProof.audit_current &&
        wholeScopeProof.source_guards_current &&
        wholeScopeProof.support_guards_current &&
        wholeScopeProof.target_guards_current &&
        wholeScopeProof.protected_closure_current &&
        wholeScopeProof.occurrence_closure_current) ||
    typeof value.derivatives_current !== 'boolean' ||
    value.derivatives_current !== wholeScopeProof.derivatives_current ||
    value.whole_scope_proof_sha256 !== wholeScopeProof.proof_sha256 ||
    (derivativesPending &&
      (typeof value.compensation_required !== 'boolean' ||
        !Array.isArray(value.compensation_targets) ||
        value.automatic_retry !== false ||
        ![
          'FLOW_IDENTITY_DERIVATIVES_PENDING',
          'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
        ].includes(String(value.code)))) ||
    (completed
      ? !HASH_PATTERN.test(String(value.terminal_proof_sha256))
      : value.terminal_proof_sha256 !== null) ||
    (completed
      ? typeof value.audit_id !== 'string' || !value.audit_id.trim()
      : value.audit_id !== null &&
        (typeof value.audit_id !== 'string' || !value.audit_id.trim())) ||
    typeof value.replay !== 'boolean'
  ) {
    fail('Flow identity finalize proof does not match the exact expected closure.');
  }
  if (
    completed &&
    (!value.primary_current ||
      !value.live_guard_current ||
      !value.derivatives_current ||
      !wholeScopeProof.audit_current ||
      wholeScopeProof.approved_reference_residue_count !== 0 ||
      !wholeScopeProof.causal_terminal_proof)
  ) {
    fail('Completed finalize replay is not dynamically current across the whole scope.');
  }
  if (
    liveDrift &&
    (value.ok !== false ||
      value.code !== 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT' ||
      (value.primary_current === true && value.live_guard_current === true) ||
      value.derivatives_current !== false ||
      value.compensation_required !== false ||
      !Array.isArray(value.compensation_targets) ||
      value.compensation_targets.length !== 0)
  ) {
    fail('Live-drift finalize response must be a non-compensable dynamic downgrade.');
  }
  if (
    failed &&
    (value.code !== 'FLOW_IDENTITY_FINALIZE_FAILED' ||
      value.compensation_required !== false ||
      value.automatic_retry !== false ||
      !Array.isArray(value.compensation_targets) ||
      value.compensation_targets.length !== 0)
  ) {
    fail('Failed finalize response must be the exact non-compensable v2 envelope.');
  }
  parseCompensationEnvelope(value, options.plan, options.scopeId, 'finalize');
  return {
    ...(value as FlowIdentityFinalizeProof),
    whole_scope_proof: wholeScopeProof,
  };
}
