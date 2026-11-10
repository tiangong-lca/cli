import type {
  FlowIdentityPlan,
  FlowIdentityProcessManifest,
} from '../../dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from '../contract/values.js';
import type { JsonObject } from '../contract/types.js';
import {
  HASH_PATTERN,
  UUID_PATTERN,
  type FlowIdentityExecutionIdentity,
  type FlowIdentityScopePreflightProof,
  type FlowIdentityScopeLookupProof,
  type FlowIdentityProcessProof,
  fail,
  token,
  hash,
  uuid,
  integer,
} from './base.js';
import { assertExactKeys } from './base.js';

export function requireScopeCounts(value: JsonObject, plan: FlowIdentityPlan): void {
  if (
    integer(value.process_count, 'process_count') !== plan.processes.length ||
    integer(value.mapping_count, 'mapping_count') !== plan.mappings.length ||
    integer(value.rewrite_count, 'rewrite_count') !== plan.summary.rewrites
  ) {
    fail('Flow identity scope proof counts do not match the plan.');
  }
}

export function parseFlowIdentityScopePreflightProof(
  value: unknown,
  plan: FlowIdentityPlan,
): FlowIdentityScopePreflightProof {
  if (!isJsonObject(value)) fail('Flow identity scope preflight proof is invalid.');
  assertExactKeys(
    value,
    [
      'ok',
      'command',
      'schema_version',
      'receipt_id',
      'receipt_proof_sha256',
      'scope_id',
      'operation_id',
      'plan_sha256',
      'scope_proof_sha256',
      'status',
      'process_count',
      'mapping_count',
      'mapping_guard_set_sha256',
      'process_intent_set_sha256',
      'support_snapshot_count',
      'source_universe_count',
      'rewrite_count',
      'next_ordinal',
      'audit_id',
      'replay',
    ],
    'scope preflight result',
  );
  requireScopeCounts(value, plan);
  if (
    value.ok !== true ||
    value.command !== 'cmd_dataset_flow_identity_scope_preflight_guarded' ||
    value.schema_version !== 'dataset-flow-identity-scope-preflight-result.v2' ||
    value.receipt_id !== plan.receipt_id ||
    value.receipt_proof_sha256 !== plan.receipt_proof_sha256 ||
    value.operation_id !== plan.operation_id ||
    value.plan_sha256 !== plan.plan_sha256 ||
    value.mapping_guard_set_sha256 !== plan.mapping_guard_set_sha256 ||
    value.process_intent_set_sha256 !== plan.process_intent_set_sha256 ||
    !['sealed', 'running', 'primary_complete', 'derivatives_pending', 'completed'].includes(
      String(value.status),
    ) ||
    typeof value.replay !== 'boolean'
  ) {
    fail('Flow identity scope preflight proof does not bind the plan.');
  }
  uuid(value.scope_id, 'scope_id');
  hash(value.scope_proof_sha256, 'scope_proof_sha256');
  integer(value.support_snapshot_count, 'support_snapshot_count');
  if (
    value.support_snapshot_count !== plan.support_snapshots.length ||
    value.source_universe_count !== 305
  ) {
    fail('Flow identity scope support/source counts do not match the plan receipt.');
  }
  integer(value.next_ordinal, 'next_ordinal', 1);
  token(value.audit_id, 'audit_id');
  return value as FlowIdentityScopePreflightProof;
}

export function parseFlowIdentityScopeLookupProof(
  value: unknown,
  plan: FlowIdentityPlan,
  identity: FlowIdentityExecutionIdentity,
): FlowIdentityScopeLookupProof {
  if (!isJsonObject(value)) fail('Flow identity scope lookup proof is invalid.');
  assertExactKeys(
    value,
    [
      'ok',
      'command',
      'schema_version',
      'read_only',
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
      'mapping_count',
      'support_snapshot_count',
      'source_universe_count',
      'rewrite_count',
      'next_ordinal',
      'audit_id',
      'whole_scope_proof_sha256',
      'execution_permit',
    ],
    'scope lookup result',
  );
  requireScopeCounts(value, plan);
  if (
    value.ok !== true ||
    value.command !== 'cmd_dataset_flow_identity_scope_lookup' ||
    value.schema_version !== 'dataset-flow-identity-scope-lookup-result.v1' ||
    value.read_only !== true ||
    value.execution_permit !== null ||
    value.receipt_id !== identity.receipt_id ||
    value.receipt_proof_sha256 !== identity.receipt_proof_sha256 ||
    value.mapping_guard_set_sha256 !== plan.mapping_guard_set_sha256 ||
    value.process_intent_set_sha256 !== plan.process_intent_set_sha256 ||
    value.operation_id !== identity.operation_id ||
    value.plan_sha256 !== identity.plan_sha256 ||
    !['sealed', 'running', 'primary_complete', 'derivatives_pending', 'completed'].includes(
      String(value.status),
    ) ||
    value.support_snapshot_count !== plan.support_snapshots.length ||
    value.source_universe_count !== 305
  ) {
    fail('Flow identity scope lookup proof does not bind the immutable execution.');
  }
  uuid(value.scope_id, 'lookup scope_id');
  hash(value.scope_proof_sha256, 'lookup scope_proof_sha256');
  integer(value.next_ordinal, 'lookup next_ordinal', 1);
  token(value.audit_id, 'lookup audit_id');
  hash(value.whole_scope_proof_sha256, 'lookup whole_scope_proof_sha256');
  return value as FlowIdentityScopeLookupProof;
}

export function parseFlowIdentityProcessProof(options: {
  value: unknown;
  scopeId: string;
  process: FlowIdentityProcessManifest;
  requestSha256: string;
  receiptId: string;
  receiptProofSha256: string;
  mappingGuardSetSha256: string;
  processIntentSetSha256: string;
  processIntentProofSha256: string;
  processCount: number;
  expectedInvocationId?: string;
  expectedPermitGenerationBefore?: number;
}): FlowIdentityProcessProof {
  if (!isJsonObject(options.value)) fail('Flow identity process proof is invalid.');
  if (
    !Number.isSafeInteger(options.processCount) ||
    options.processCount < options.process.ordinal
  ) {
    fail('Flow identity process count cannot bind the sealed ordinal.');
  }
  const value = options.value;
  const completedProcessCount = value.completed_process_count;
  assertExactKeys(
    value,
    [
      'ok',
      'command',
      'schema_version',
      'scope_id',
      'receipt_id',
      'receipt_proof_sha256',
      'mapping_guard_set_sha256',
      'process_intent_set_sha256',
      'invocation_id',
      'permit_generation_before',
      'ordinal',
      'process_id',
      'process_version',
      'process_request_sha256',
      'process_intent_proof_sha256',
      'desired_payload_sha256',
      'desired_exchange_set_sha256',
      'completed_process_count',
      'next_ordinal',
      'primary_complete',
      'before_payload_sha256',
      'before_exchange_set_sha256',
      'after_payload_sha256',
      'after_exchange_set_sha256',
      'rewrite_count',
      'audit_id',
      'derivative_batch_id',
      'status',
      'replay',
    ],
    'process rewrite result',
  );
  if (
    value.ok !== true ||
    value.command !== 'cmd_dataset_flow_identity_process_rewrite_guarded' ||
    value.schema_version !== 'dataset-flow-identity-process-rewrite-result.v2' ||
    value.scope_id !== options.scopeId ||
    value.receipt_id !== options.receiptId ||
    value.receipt_proof_sha256 !== options.receiptProofSha256 ||
    value.mapping_guard_set_sha256 !== options.mappingGuardSetSha256 ||
    value.process_intent_set_sha256 !== options.processIntentSetSha256 ||
    !UUID_PATTERN.test(String(value.invocation_id)) ||
    !Number.isSafeInteger(value.permit_generation_before) ||
    Number(value.permit_generation_before) < 0 ||
    (options.expectedInvocationId !== undefined &&
      value.invocation_id !== options.expectedInvocationId) ||
    (options.expectedPermitGenerationBefore !== undefined &&
      value.permit_generation_before !== options.expectedPermitGenerationBefore) ||
    value.ordinal !== options.process.ordinal ||
    value.process_id !== options.process.id ||
    value.process_version !== options.process.version ||
    value.process_request_sha256 !== options.requestSha256 ||
    value.process_intent_proof_sha256 !== options.processIntentProofSha256 ||
    value.desired_payload_sha256 !== options.process.desired_payload_sha256 ||
    value.desired_exchange_set_sha256 !== options.process.desired_exchange_set_sha256 ||
    !Number.isSafeInteger(completedProcessCount) ||
    Number(completedProcessCount) < options.process.ordinal ||
    Number(completedProcessCount) > options.processCount ||
    (value.replay === false && completedProcessCount !== options.process.ordinal) ||
    typeof value.primary_complete !== 'boolean' ||
    (value.primary_complete
      ? completedProcessCount !== options.processCount || value.next_ordinal !== null
      : value.next_ordinal !== Number(completedProcessCount) + 1 ||
        Number(value.next_ordinal) > options.processCount) ||
    !HASH_PATTERN.test(String(value.before_payload_sha256)) ||
    !HASH_PATTERN.test(String(value.before_exchange_set_sha256)) ||
    !HASH_PATTERN.test(String(value.after_payload_sha256)) ||
    !HASH_PATTERN.test(String(value.after_exchange_set_sha256)) ||
    value.after_payload_sha256 !== value.desired_payload_sha256 ||
    value.after_exchange_set_sha256 !== value.desired_exchange_set_sha256 ||
    value.rewrite_count !== options.process.rewrite_count ||
    value.status !== 'completed' ||
    !UUID_PATTERN.test(String(value.derivative_batch_id)) ||
    typeof value.replay !== 'boolean'
  ) {
    fail('Flow identity process proof does not bind the sealed process template.');
  }
  token(value.audit_id, 'audit_id');
  return value as FlowIdentityProcessProof;
}
