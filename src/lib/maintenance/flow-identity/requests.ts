import {
  assertCurrentFlowIdentityAuthority,
  type FlowIdentityPlan,
} from '../../dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from '../contract/values.js';
import { sha256Json, sha256Text } from '../../canonical-json-hash.js';
import type { JsonObject } from '../contract/types.js';
import { flowIdentityRestrictedSha256 } from '../../dataset-maintenance-flow-identity-wire.js';
import {
  HASH_PATTERN,
  UUID_PATTERN,
  type FlowIdentityFreeze,
  type FlowIdentityApproval,
  type FlowIdentityExecutionIdentity,
  type FlowIdentityExecutionPermit,
  type FlowIdentityPermitResponse,
  type FlowIdentityScopeStatus,
  fail,
  hash,
  uuid,
  integer,
} from './base.js';
import { assertExactKeys } from './base.js';

export function deterministicUuidFromSha256(digest: string): string {
  const chars = digest.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function computeFlowIdentityFreezeSha256(freeze: FlowIdentityFreeze): string {
  return sha256Json({ ...freeze, freeze_sha256: '' });
}

export function computeFlowIdentityApprovalIdentitySha256(approval: FlowIdentityApproval): string {
  return sha256Json({ ...approval, execution_approval_identity_sha256: '' });
}

export function parseFlowIdentityFreeze(
  value: unknown,
  plan: FlowIdentityPlan,
): FlowIdentityFreeze {
  if (!isJsonObject(value) || !isJsonObject(value.actor)) fail('Flow identity freeze is invalid.');
  const freeze = value as FlowIdentityFreeze;
  if (
    freeze.schema_version !== 'dataset-flow-identity-freeze.v2' ||
    freeze.environment !== 'production' ||
    plan.environment !== 'production' ||
    freeze.project_ref !== plan.project_ref ||
    freeze.actor.user_id !== plan.account.user_id ||
    freeze.actor.email !== plan.account.email ||
    freeze.plan_sha256 !== plan.plan_sha256 ||
    freeze.operation_id !== plan.operation_id ||
    freeze.capture_artifact_sha256 !== plan.capture_artifact_sha256 ||
    freeze.receipt_id !== plan.receipt_id ||
    freeze.receipt_proof_sha256 !== plan.receipt_proof_sha256 ||
    freeze.capture_request_sha256 !== plan.capture_request_sha256 ||
    freeze.source_guard_set_sha256 !== plan.source_guard_set_sha256 ||
    freeze.support_guard_set_sha256 !== plan.support_guard_set_sha256 ||
    freeze.target_guard_set_sha256 !== plan.target_guard_set_sha256 ||
    freeze.mapping_guard_set_sha256 !== plan.mapping_guard_set_sha256 ||
    freeze.process_intent_set_sha256 !== plan.process_intent_set_sha256 ||
    freeze.receipt_protected_closure_sha256 !== plan.receipt_protected_closure_sha256 ||
    freeze.capture_whole_scope_proof_sha256 !== plan.capture_whole_scope_proof_sha256 ||
    freeze.source_universe_artifact_sha256 !== plan.source_universe_artifact_sha256 ||
    freeze.support_snapshot_artifact_sha256 !== plan.support_snapshot_artifact_sha256 ||
    freeze.mapping_artifact_sha256 !== plan.mapping_artifact_sha256 ||
    freeze.process_manifest_artifact_sha256 !== plan.process_manifest_artifact_sha256 ||
    freeze.protected_closure_artifact_sha256 !== plan.protected_closure_artifact_sha256 ||
    freeze.policy_approval_text_sha256 !== plan.compatibility_policy.approval_text_sha256 ||
    !UUID_PATTERN.test(freeze.receipt_id) ||
    ![
      freeze.receipt_proof_sha256,
      freeze.capture_request_sha256,
      freeze.source_guard_set_sha256,
      freeze.support_guard_set_sha256,
      freeze.target_guard_set_sha256,
      freeze.mapping_guard_set_sha256,
      freeze.process_intent_set_sha256,
      freeze.receipt_protected_closure_sha256,
      freeze.capture_whole_scope_proof_sha256,
    ].every((digest) => HASH_PATTERN.test(digest)) ||
    !HASH_PATTERN.test(freeze.toolchain_evidence_sha256) ||
    !Number.isFinite(Date.parse(freeze.generated_at_utc)) ||
    freeze.freeze_sha256 !== computeFlowIdentityFreezeSha256(freeze)
  ) {
    fail('Flow identity freeze does not exactly bind the immutable production plan.');
  }
  return freeze;
}

export function parseFlowIdentityApproval(
  value: unknown,
  plan: FlowIdentityPlan,
  freeze: FlowIdentityFreeze,
): FlowIdentityApproval {
  if (!isJsonObject(value) || !isJsonObject(value.actor))
    fail('Flow identity approval is invalid.');
  const approval = value as FlowIdentityApproval;
  assertCurrentFlowIdentityAuthority({ oracleSha256: approval.policy_approval_text_sha256 });
  if (
    approval.schema_version !== 'dataset-flow-identity-execution-approval.v2' ||
    approval.actor.user_id !== plan.account.user_id ||
    approval.actor.email !== plan.account.email ||
    approval.plan_sha256 !== plan.plan_sha256 ||
    approval.freeze_sha256 !== freeze.freeze_sha256 ||
    approval.toolchain_evidence_sha256 !== freeze.toolchain_evidence_sha256 ||
    approval.policy_approval_text_sha256 !== plan.compatibility_policy.approval_text_sha256 ||
    !HASH_PATTERN.test(approval.policy_approval_text_sha256) ||
    !HASH_PATTERN.test(approval.execution_approval_request_sha256) ||
    !HASH_PATTERN.test(approval.execution_approval_text_sha256) ||
    new Set([
      approval.policy_approval_text_sha256,
      approval.execution_approval_request_sha256,
      approval.execution_approval_text_sha256,
      approval.execution_approval_identity_sha256,
    ]).size !== 4 ||
    !Number.isFinite(Date.parse(approval.approved_at_utc)) ||
    Date.parse(approval.approved_at_utc) < Date.parse(freeze.generated_at_utc) ||
    approval.execution_approval_identity_sha256 !==
      computeFlowIdentityApprovalIdentitySha256(approval)
  ) {
    fail('Flow identity approval does not exactly bind the plan/freeze/account/toolchain.');
  }
  return approval;
}

export function buildFlowIdentityExecutionIdentity(options: {
  plan: FlowIdentityPlan;
  freeze: FlowIdentityFreeze;
  approval: FlowIdentityApproval;
}): FlowIdentityExecutionIdentity {
  const body = {
    environment: 'production' as const,
    project_ref: options.plan.project_ref,
    actor: options.plan.account,
    target_visibility: 'owner_draft' as const,
    operation_id: options.plan.operation_id,
    plan_sha256: options.plan.plan_sha256,
    freeze_sha256: options.freeze.freeze_sha256,
    receipt_id: options.plan.receipt_id,
    receipt_proof_sha256: options.plan.receipt_proof_sha256,
    policy_approval_text_sha256: options.approval.policy_approval_text_sha256,
    execution_approval_request_sha256: options.approval.execution_approval_request_sha256,
    execution_approval_text_sha256: options.approval.execution_approval_text_sha256,
    execution_approval_identity_sha256: options.approval.execution_approval_identity_sha256,
    toolchain_evidence_sha256: options.freeze.toolchain_evidence_sha256,
  };
  const identitySha256 = flowIdentityRestrictedSha256(body);
  return {
    request_id: deterministicUuidFromSha256(
      sha256Text(`dataset-flow-identity-scope.v2\u0000${identitySha256}`),
    ),
    identity_sha256: identitySha256,
    ...body,
  };
}

export function buildFlowIdentityScopePreflightRequest(options: {
  plan: FlowIdentityPlan;
  identity: FlowIdentityExecutionIdentity;
}): JsonObject {
  const request = {
    schema_version: 'dataset-flow-identity-scope-preflight.v2',
    request_id: options.identity.request_id,
    receipt_id: options.identity.receipt_id,
    receipt_proof_sha256: options.identity.receipt_proof_sha256,
    environment: options.identity.environment,
    project_ref: options.identity.project_ref,
    actor: options.identity.actor,
    target_visibility: options.identity.target_visibility,
    operation_id: options.identity.operation_id,
    plan_sha256: options.identity.plan_sha256,
    freeze_sha256: options.identity.freeze_sha256,
    policy_approval_text_sha256: options.identity.policy_approval_text_sha256,
    execution_approval_request_sha256: options.identity.execution_approval_request_sha256,
    execution_approval_text_sha256: options.identity.execution_approval_text_sha256,
    execution_approval_identity_sha256: options.identity.execution_approval_identity_sha256,
    toolchain_evidence_sha256: options.identity.toolchain_evidence_sha256,
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: options.plan.processes.length,
    maximum_finalize_posts: 1,
    automatic_retry: false,
  };
  return request;
}

export function buildFlowIdentityScopeLookupRequest(options: {
  identity: FlowIdentityExecutionIdentity;
}): JsonObject {
  return {
    schema_version: 'dataset-flow-identity-scope-lookup.v1',
    request_id: options.identity.request_id,
    receipt_id: options.identity.receipt_id,
    receipt_proof_sha256: options.identity.receipt_proof_sha256,
    environment: options.identity.environment,
    project_ref: options.identity.project_ref,
    actor: options.identity.actor,
    target_visibility: options.identity.target_visibility,
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    operation_id: options.identity.operation_id,
    plan_sha256: options.identity.plan_sha256,
    freeze_sha256: options.identity.freeze_sha256,
    policy_approval_text_sha256: options.identity.policy_approval_text_sha256,
    execution_approval_request_sha256: options.identity.execution_approval_request_sha256,
    execution_approval_text_sha256: options.identity.execution_approval_text_sha256,
    execution_approval_identity_sha256: options.identity.execution_approval_identity_sha256,
    toolchain_evidence_sha256: options.identity.toolchain_evidence_sha256,
  };
}

export function parseFlowIdentityExecutionPermit(
  value: unknown,
  options: {
    expectedGeneration: number;
    expectedInvocationId?: string;
    label: string;
  },
): FlowIdentityExecutionPermit {
  if (!isJsonObject(value)) fail(`${options.label} execution permit is invalid.`);
  assertExactKeys(
    value,
    ['schema_version', 'invocation_id', 'generation', 'token'],
    `${options.label} execution permit`,
  );
  if (
    value.schema_version !== 'dataset-flow-identity-execution-permit.v1' ||
    integer(value.generation, 'execution permit generation') !== options.expectedGeneration ||
    (options.expectedInvocationId !== undefined &&
      value.invocation_id !== options.expectedInvocationId)
  ) {
    fail(`${options.label} execution permit does not bind the expected live wrapper generation.`);
  }
  uuid(value.invocation_id, 'execution permit invocation_id');
  hash(value.token, 'execution permit token');
  return value as FlowIdentityExecutionPermit;
}

/**
 * Removes the memory-only permit before a response enters a proof parser or
 * durable artifact writer.  Exact proof parsers therefore cannot accidentally
 * accept or persist the bearer token.
 */
export function splitFlowIdentityPermitResponse(options: {
  value: unknown;
  expectedGeneration: number;
  expectedInvocationId?: string;
  permitRequired: boolean;
  permitForbidden?: boolean;
  label: string;
}): FlowIdentityPermitResponse<JsonObject> {
  if (!isJsonObject(options.value)) fail(`${options.label} response is invalid.`);
  if (!Object.hasOwn(options.value, 'execution_permit')) {
    fail(`${options.label} response omitted the execution permit envelope.`);
  }
  const proof = { ...options.value };
  const rawPermit = proof.execution_permit;
  delete proof.execution_permit;
  if (rawPermit === null) {
    if (options.permitRequired) {
      fail(`${options.label} response did not provide a fresh write-capable permit.`);
    }
    return { proof, executionPermit: null };
  }
  if (options.permitForbidden === true) {
    fail(`${options.label} replay unexpectedly contained a write-capable execution permit.`);
  }
  return {
    proof,
    executionPermit: parseFlowIdentityExecutionPermit(rawPermit, {
      expectedGeneration: options.expectedGeneration,
      expectedInvocationId: options.expectedInvocationId,
      label: options.label,
    }),
  };
}

export function computeFlowIdentityProcessRequestSha256(request: JsonObject): string {
  const body = { ...request };
  delete body.process_request_sha256;
  return flowIdentityRestrictedSha256(body);
}

export function buildFlowIdentityProcessRequest(options: {
  scopeProofSha256: string;
  ordinal: number;
  processIntentProofSha256: string;
}): JsonObject {
  const body: JsonObject = {
    schema_version: 'dataset-flow-identity-process-rewrite.v2',
    request_id: deterministicUuidFromSha256(
      sha256Text(
        `dataset-flow-identity-process.v2\u0000${options.scopeProofSha256}\u0000${options.ordinal}\u0000${options.processIntentProofSha256}`,
      ),
    ),
    scope_proof_sha256: hash(options.scopeProofSha256, 'scope_proof_sha256'),
    ordinal: integer(options.ordinal, 'ordinal', 1),
    process_intent_proof_sha256: hash(
      options.processIntentProofSha256,
      'process_intent_proof_sha256',
    ),
    process_request_sha256: '',
  };
  body.process_request_sha256 = computeFlowIdentityProcessRequestSha256(body);
  return body;
}

export function buildFlowIdentityFinalizeRequest(options: {
  scopeProofSha256: string;
  plan: FlowIdentityPlan;
  status: FlowIdentityScopeStatus;
}): JsonObject {
  const completed = options.status.processes.filter((process) => process.status === 'completed');
  if (
    completed.length !== options.plan.processes.length ||
    completed.some((process) => !process.audit_id)
  ) {
    fail('Cannot finalize without an exact completed database process ledger.');
  }
  const expected = {
    process_count: options.plan.processes.length,
    rewrite_count: options.plan.summary.rewrites,
    completed_process_count: completed.length,
  };
  return {
    schema_version: 'dataset-flow-identity-scope-finalize.v2',
    request_id: deterministicUuidFromSha256(
      sha256Text(
        `dataset-flow-identity-finalize.v2\u0000${options.scopeProofSha256}\u0000${options.status.whole_scope_proof_sha256}`,
      ),
    ),
    scope_proof_sha256: hash(options.scopeProofSha256, 'scope_proof_sha256'),
    expected,
  };
}
