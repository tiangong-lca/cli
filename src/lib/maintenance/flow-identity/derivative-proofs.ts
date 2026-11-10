import { assertExactKeys } from './base.js';
import type { FlowIdentityPlan } from '../../dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from '../contract/values.js';

import {
  HASH_PATTERN,
  UUID_PATTERN,
  type FlowIdentityScopeProcessStatus,
  type FlowIdentityDerivativeResidue,
  type FlowIdentityDerivativeTargetProof,
  type FlowIdentityDerivativeSetProof,
  type FlowIdentityWholeScopeProof,
  fail,
  token,
  hash,
  uuid,
  integer,
  boolean,
} from './base.js';
import { parseCompensationTarget } from './base.js';

export function parseDerivativeResidue(
  value: unknown,
  label: string,
): FlowIdentityDerivativeResidue {
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  assertExactKeys(
    value,
    ['http_requests', 'embedding_jobs', 'pending_jobs', 'failure_rows', 'other_active_fences'],
    label,
  );
  return {
    http_requests: integer(value.http_requests, `${label}.http_requests`),
    embedding_jobs: integer(value.embedding_jobs, `${label}.embedding_jobs`),
    pending_jobs: integer(value.pending_jobs, `${label}.pending_jobs`),
    failure_rows: integer(value.failure_rows, `${label}.failure_rows`),
    other_active_fences: integer(value.other_active_fences, `${label}.other_active_fences`),
  };
}

export function parseDerivativeTarget(options: {
  value: unknown;
  index: number;
  plan: FlowIdentityPlan;
  process: FlowIdentityScopeProcessStatus;
}): FlowIdentityDerivativeTargetProof {
  const label = `derivative_set_proof.targets[${options.index}]`;
  if (!isJsonObject(options.value)) fail(`${label} must be an object.`);
  const value = options.value;
  assertExactKeys(
    value,
    [
      'ordinal',
      'id',
      'version',
      'original_batch_id',
      'effective_reference_id',
      'effective_reference_kind',
      'status',
      'request_status',
      'phase',
      'lineage_ok',
      'proposals_committed',
      'terminal_audit_present',
      'residue',
      'current_snapshot_sha256',
      'current_json_ordered_sha256',
      'causal_terminal_proof',
    ],
    label,
  );
  const ordinal = integer(value.ordinal, `${label}.ordinal`, 1);
  const expected = options.plan.processes[ordinal - 1];
  const requestStatus = token(value.request_status, `${label}.request_status`);
  const requestIsTerminal = ['completed', 'stale', 'failed', 'missing'].includes(requestStatus);
  const causalTerminalProof = boolean(
    value.causal_terminal_proof,
    `${label}.causal_terminal_proof`,
  );
  const expectedStatus = causalTerminalProof
    ? 'completed'
    : requestIsTerminal
      ? 'failed'
      : 'pending';
  const effectiveReferenceKind = token(
    value.effective_reference_kind,
    `${label}.effective_reference_kind`,
  );
  const phase = token(value.phase, `${label}.phase`);
  const missingOriginalDerivative =
    options.process.derivative_request_id === null &&
    options.process.derivative_status === 'missing' &&
    value.effective_reference_id === null &&
    effectiveReferenceKind === 'protected_batch' &&
    requestStatus === 'missing' &&
    phase === 'missing' &&
    value.status === 'failed' &&
    value.lineage_ok === false &&
    value.proposals_committed === false &&
    value.terminal_audit_present === false &&
    causalTerminalProof === false;
  if (
    ordinal !== options.index + 1 ||
    !expected ||
    options.process.ordinal !== ordinal ||
    options.process.status !== 'completed' ||
    value.id !== expected.id ||
    value.version !== expected.version ||
    value.original_batch_id !== options.process.derivative_batch_id ||
    !UUID_PATTERN.test(String(value.original_batch_id)) ||
    (!missingOriginalDerivative && !UUID_PATTERN.test(String(value.effective_reference_id))) ||
    !['protected_batch', 'separate_compensation'].includes(effectiveReferenceKind) ||
    ![
      'queued',
      'dispatching',
      'markdown_pending',
      'embedding_pending',
      'completed',
      'stale',
      'failed',
      'missing',
    ].includes(requestStatus) ||
    ((requestStatus === 'missing' ||
      phase === 'missing' ||
      value.effective_reference_id === null) &&
      !missingOriginalDerivative) ||
    value.status !== expectedStatus ||
    (causalTerminalProof && requestStatus !== 'completed') ||
    (effectiveReferenceKind === 'protected_batch' &&
      value.effective_reference_id !== options.process.derivative_request_id) ||
    (effectiveReferenceKind === 'separate_compensation' &&
      value.effective_reference_id === options.process.derivative_request_id) ||
    !HASH_PATTERN.test(String(value.current_json_ordered_sha256)) ||
    !HASH_PATTERN.test(String(value.current_snapshot_sha256))
  ) {
    fail(`${label} does not bind the ordered process/derivative ledger.`);
  }
  return {
    ordinal,
    id: expected.id,
    version: expected.version,
    original_batch_id: String(value.original_batch_id),
    effective_reference_id:
      value.effective_reference_id === null ? null : String(value.effective_reference_id),
    effective_reference_kind: effectiveReferenceKind as 'protected_batch' | 'separate_compensation',
    status: expectedStatus,
    request_status: requestStatus as FlowIdentityDerivativeTargetProof['request_status'],
    phase,
    lineage_ok: boolean(value.lineage_ok, `${label}.lineage_ok`),
    proposals_committed: boolean(value.proposals_committed, `${label}.proposals_committed`),
    terminal_audit_present: boolean(
      value.terminal_audit_present,
      `${label}.terminal_audit_present`,
    ),
    residue: parseDerivativeResidue(value.residue, `${label}.residue`),
    current_snapshot_sha256: String(value.current_snapshot_sha256),
    current_json_ordered_sha256: String(value.current_json_ordered_sha256),
    causal_terminal_proof: causalTerminalProof,
  };
}

export function parseFlowIdentityDerivativeSetProof(options: {
  value: unknown;
  plan: FlowIdentityPlan;
  scopeId: string;
  processes: FlowIdentityScopeProcessStatus[];
}): FlowIdentityDerivativeSetProof {
  if (!isJsonObject(options.value)) fail('Flow identity derivative set proof is invalid.');
  const value = options.value;
  assertExactKeys(
    value,
    [
      'ok',
      'schema_version',
      'scope_id',
      'status',
      'target_count',
      'completed_count',
      'pending_count',
      'failed_count',
      'causal_terminal_proof',
      'targets',
      'compensation_targets',
      'proof_sha256',
    ],
    'derivative_set_proof',
  );
  if (!Array.isArray(value.targets) || !Array.isArray(value.compensation_targets)) {
    fail('Flow identity derivative set proof arrays are invalid.');
  }
  const completedProcesses = options.processes.filter((entry) => entry.status === 'completed');
  const targets = value.targets.map((entry, index) => {
    const process = completedProcesses[index];
    if (!process) fail('Derivative set proof contains a foreign target.');
    return parseDerivativeTarget({ value: entry, index, plan: options.plan, process });
  });
  const targetCount = integer(value.target_count, 'derivative_set_proof.target_count');
  const completedCount = integer(value.completed_count, 'derivative_set_proof.completed_count');
  const pendingCount = integer(value.pending_count, 'derivative_set_proof.pending_count');
  const failedCount = integer(value.failed_count, 'derivative_set_proof.failed_count');
  const causalTerminalProof = boolean(
    value.causal_terminal_proof,
    'derivative_set_proof.causal_terminal_proof',
  );
  const expectedStatus =
    targetCount === 0
      ? 'failed'
      : failedCount > 0
        ? 'compensation_required'
        : pendingCount > 0
          ? 'pending'
          : 'completed';
  const compensationTargets = value.compensation_targets.map((entry) =>
    parseCompensationTarget(entry, options.plan, options.scopeId, 'derivative_set'),
  );
  const failedOrdinals = targets
    .filter((entry) => entry.status === 'failed')
    .map((entry) => entry.ordinal);
  if (
    value.schema_version !== 'dataset-flow-identity-derivative-set-proof.v1' ||
    value.scope_id !== options.scopeId ||
    targetCount !== targets.length ||
    targetCount !== completedProcesses.length ||
    completedCount !== targets.filter((entry) => entry.status === 'completed').length ||
    pendingCount !== targets.filter((entry) => entry.status === 'pending').length ||
    failedCount !== failedOrdinals.length ||
    completedCount + pendingCount + failedCount !== targetCount ||
    compensationTargets.length !== failedCount ||
    compensationTargets.some((entry, index) => entry.ordinal !== failedOrdinals[index]) ||
    compensationTargets.some((entry) => {
      const process = options.processes[entry.ordinal - 1];
      const target = targets[entry.ordinal - 1];
      const processMissingOriginal =
        process?.derivative_request_id === null && process.derivative_status === 'missing';
      return (
        (entry.original_status === 'missing') !== processMissingOriginal ||
        (target?.request_status === 'missing' && entry.original_status !== 'missing')
      );
    }) ||
    value.status !== expectedStatus ||
    value.ok !== (targetCount > 0 && failedCount === 0) ||
    causalTerminalProof !== (targetCount > 0 && completedCount === targetCount) ||
    !HASH_PATTERN.test(String(value.proof_sha256))
  ) {
    fail('Flow identity derivative set proof counts/status do not bind its ordered targets.');
  }
  return {
    ok: Boolean(value.ok),
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: options.scopeId,
    status: expectedStatus,
    target_count: targetCount,
    completed_count: completedCount,
    pending_count: pendingCount,
    failed_count: failedCount,
    causal_terminal_proof: causalTerminalProof,
    targets,
    compensation_targets: compensationTargets,
    proof_sha256: String(value.proof_sha256),
  };
}

export function parseFlowIdentityWholeScopeProof(options: {
  value: unknown;
  scopeId: string;
  receiptId: string;
}): FlowIdentityWholeScopeProof {
  if (!isJsonObject(options.value)) fail('Flow identity whole-scope proof is invalid.');
  const value = options.value;
  assertExactKeys(
    value,
    [
      'schema_version',
      'scope_id',
      'receipt_id',
      'primary_current',
      'audit_current',
      'source_guards_current',
      'support_guards_current',
      'target_guards_current',
      'approved_reference_residue_count',
      'protected_closure_current',
      'occurrence_closure_current',
      'derivatives_current',
      'primary_closure_sha256',
      'source_guard_set_sha256',
      'support_guard_set_sha256',
      'target_guard_set_sha256',
      'protected_closure_sha256',
      'derivative_proof_set_sha256',
      'causal_terminal_proof',
      'proof_sha256',
    ],
    'whole_scope_proof',
  );
  const proof: FlowIdentityWholeScopeProof = {
    schema_version: 'dataset-flow-identity-whole-scope-proof.v2',
    scope_id: uuid(value.scope_id, 'whole_scope_proof.scope_id'),
    receipt_id: uuid(value.receipt_id, 'whole_scope_proof.receipt_id'),
    primary_current: boolean(value.primary_current, 'whole_scope_proof.primary_current'),
    audit_current: boolean(value.audit_current, 'whole_scope_proof.audit_current'),
    source_guards_current: boolean(
      value.source_guards_current,
      'whole_scope_proof.source_guards_current',
    ),
    support_guards_current: boolean(
      value.support_guards_current,
      'whole_scope_proof.support_guards_current',
    ),
    target_guards_current: boolean(
      value.target_guards_current,
      'whole_scope_proof.target_guards_current',
    ),
    approved_reference_residue_count: integer(
      value.approved_reference_residue_count,
      'whole_scope_proof.approved_reference_residue_count',
    ),
    protected_closure_current: boolean(
      value.protected_closure_current,
      'whole_scope_proof.protected_closure_current',
    ),
    occurrence_closure_current: boolean(
      value.occurrence_closure_current,
      'whole_scope_proof.occurrence_closure_current',
    ),
    derivatives_current: boolean(
      value.derivatives_current,
      'whole_scope_proof.derivatives_current',
    ),
    primary_closure_sha256: hash(
      value.primary_closure_sha256,
      'whole_scope_proof.primary_closure_sha256',
    ),
    source_guard_set_sha256: hash(
      value.source_guard_set_sha256,
      'whole_scope_proof.source_guard_set_sha256',
    ),
    support_guard_set_sha256: hash(
      value.support_guard_set_sha256,
      'whole_scope_proof.support_guard_set_sha256',
    ),
    target_guard_set_sha256: hash(
      value.target_guard_set_sha256,
      'whole_scope_proof.target_guard_set_sha256',
    ),
    protected_closure_sha256: hash(
      value.protected_closure_sha256,
      'whole_scope_proof.protected_closure_sha256',
    ),
    derivative_proof_set_sha256: hash(
      value.derivative_proof_set_sha256,
      'whole_scope_proof.derivative_proof_set_sha256',
    ),
    causal_terminal_proof: boolean(
      value.causal_terminal_proof,
      'whole_scope_proof.causal_terminal_proof',
    ),
    proof_sha256: hash(value.proof_sha256, 'whole_scope_proof.proof_sha256'),
  };
  if (
    value.schema_version !== proof.schema_version ||
    proof.scope_id !== options.scopeId ||
    proof.receipt_id !== options.receiptId
  ) {
    fail('Flow identity whole-scope proof does not bind the actor scope receipt.');
  }
  return proof;
}
