import type { FlowIdentityPlan } from '../../dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from '../contract/values.js';
import type { JsonObject } from '../contract/types.js';
import { CliError } from '../../../shared/errors.js';

export const HASH_PATTERN = /^[a-f0-9]{64}$/u;
export const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export type FlowIdentityFreeze = {
  schema_version: 'dataset-flow-identity-freeze.v2';
  generated_at_utc: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  plan_sha256: string;
  operation_id: string;
  capture_artifact_sha256: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  capture_request_sha256: string;
  source_guard_set_sha256: string;
  support_guard_set_sha256: string;
  target_guard_set_sha256: string;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  receipt_protected_closure_sha256: string;
  capture_whole_scope_proof_sha256: string;
  source_universe_artifact_sha256: string;
  support_snapshot_artifact_sha256: string;
  mapping_artifact_sha256: string;
  process_manifest_artifact_sha256: string;
  protected_closure_artifact_sha256: string;
  policy_approval_text_sha256: string;
  toolchain_evidence_sha256: string;
  freeze_sha256: string;
};

export type FlowIdentityApproval = {
  schema_version: 'dataset-flow-identity-execution-approval.v2';
  approved_at_utc: string;
  actor: { user_id: string; email: string };
  plan_sha256: string;
  freeze_sha256: string;
  toolchain_evidence_sha256: string;
  policy_approval_text_sha256: string;
  execution_approval_request_sha256: string;
  execution_approval_text_sha256: string;
  execution_approval_identity_sha256: string;
};

export type FlowIdentityExecutionIdentity = {
  request_id: string;
  identity_sha256: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  operation_id: string;
  plan_sha256: string;
  freeze_sha256: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  policy_approval_text_sha256: string;
  execution_approval_request_sha256: string;
  execution_approval_text_sha256: string;
  execution_approval_identity_sha256: string;
  toolchain_evidence_sha256: string;
};

/**
 * A database-minted bearer capability for exactly one live CLI wrapper.
 *
 * The token is deliberately absent from every durable artifact type in this
 * module.  Callers must keep this value in memory, rotate it after each
 * successful write response, and discard it when the wrapper exits.
 */
export type FlowIdentityExecutionPermit = {
  schema_version: 'dataset-flow-identity-execution-permit.v1';
  invocation_id: string;
  generation: number;
  token: string;
};

export type FlowIdentityPermitResponse<T> = {
  proof: T;
  executionPermit: FlowIdentityExecutionPermit | null;
};

export type FlowIdentityScopePreflightProof = {
  ok: true;
  command: 'cmd_dataset_flow_identity_scope_preflight_guarded';
  schema_version: 'dataset-flow-identity-scope-preflight-result.v2';
  receipt_id: string;
  receipt_proof_sha256: string;
  scope_id: string;
  operation_id: string;
  plan_sha256: string;
  scope_proof_sha256: string;
  status: 'sealed' | 'running' | 'primary_complete' | 'derivatives_pending' | 'completed';
  process_count: number;
  mapping_count: number;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  support_snapshot_count: number;
  source_universe_count: 305;
  rewrite_count: number;
  next_ordinal: number;
  audit_id: string;
  replay: boolean;
};

export type FlowIdentityScopeLookupProof = {
  ok: true;
  command: 'cmd_dataset_flow_identity_scope_lookup';
  schema_version: 'dataset-flow-identity-scope-lookup-result.v1';
  read_only: true;
  scope_id: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  operation_id: string;
  plan_sha256: string;
  scope_proof_sha256: string;
  status: 'sealed' | 'running' | 'primary_complete' | 'derivatives_pending' | 'completed';
  process_count: number;
  mapping_count: number;
  support_snapshot_count: number;
  source_universe_count: 305;
  rewrite_count: number;
  next_ordinal: number;
  audit_id: string;
  whole_scope_proof_sha256: string;
  execution_permit: null;
};

export type FlowIdentityScopeProof = FlowIdentityScopePreflightProof | FlowIdentityScopeLookupProof;

export type FlowIdentityProcessProof = {
  ok: true;
  command: 'cmd_dataset_flow_identity_process_rewrite_guarded';
  schema_version: 'dataset-flow-identity-process-rewrite-result.v2';
  scope_id: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  invocation_id: string;
  permit_generation_before: number;
  ordinal: number;
  process_id: string;
  process_version: string;
  process_request_sha256: string;
  process_intent_proof_sha256: string;
  desired_payload_sha256: string;
  desired_exchange_set_sha256: string;
  completed_process_count: number;
  next_ordinal: number | null;
  primary_complete: boolean;
  before_payload_sha256: string;
  before_exchange_set_sha256: string;
  after_payload_sha256: string;
  after_exchange_set_sha256: string;
  rewrite_count: number;
  audit_id: string;
  derivative_batch_id: string;
  status: 'completed';
  replay: boolean;
};

export type FlowIdentityScopeProcessStatus = {
  ordinal: number;
  id: string;
  version: string;
  status: 'pending' | 'completed' | 'failed';
  process_request_sha256: string | null;
  process_intent_proof_sha256: string;
  desired_payload_sha256: string;
  desired_exchange_set_sha256: string;
  rewrite_count: number;
  audit_id: string | null;
  before_payload_sha256: string;
  before_exchange_set_sha256: string;
  after_payload_sha256: string | null;
  after_exchange_set_sha256: string | null;
  derivative_batch_id: string | null;
  derivative_request_id: string | null;
  derivative_status: string | null;
  causal_terminal_proof: unknown;
  completed_at: string | null;
  last_error: unknown;
};

export type FlowIdentityDerivativeResidue = {
  http_requests: number;
  embedding_jobs: number;
  pending_jobs: number;
  failure_rows: number;
  other_active_fences: number;
};

export type FlowIdentityDerivativeTargetProof = {
  ordinal: number;
  id: string;
  version: string;
  original_batch_id: string;
  effective_reference_id: string | null;
  effective_reference_kind: 'protected_batch' | 'separate_compensation';
  status: 'completed' | 'pending' | 'failed';
  request_status:
    | 'queued'
    | 'dispatching'
    | 'markdown_pending'
    | 'embedding_pending'
    | 'completed'
    | 'stale'
    | 'failed'
    | 'missing';
  phase: string;
  lineage_ok: boolean;
  proposals_committed: boolean;
  terminal_audit_present: boolean;
  residue: FlowIdentityDerivativeResidue;
  current_snapshot_sha256: string;
  current_json_ordered_sha256: string;
  causal_terminal_proof: boolean;
};

export type FlowIdentityDerivativeSetProof = {
  ok: boolean;
  schema_version: 'dataset-flow-identity-derivative-set-proof.v1';
  scope_id: string;
  status: 'failed' | 'compensation_required' | 'pending' | 'completed';
  target_count: number;
  completed_count: number;
  pending_count: number;
  failed_count: number;
  causal_terminal_proof: boolean;
  targets: FlowIdentityDerivativeTargetProof[];
  compensation_targets: FlowIdentityCompensationTarget[];
  proof_sha256: string;
};

export type FlowIdentityCompensationTarget = {
  ordinal: number;
  table: 'processes';
  id: string;
  version: string;
  original_batch_id: string;
  original_request_id?: string | null;
  original_status: 'failed' | 'stale' | 'missing';
  original_error?: unknown;
  original_code?: string;
  desired_payload_sha256: string;
  current_json_ordered_sha256: string;
  current_snapshot_sha256: string;
  current_modified_at: string;
  components: ['extracted_md', 'embedding_ft'];
  reason_code: string;
  operation_id_prefix: string;
  latest_compensation_request_id: string | null;
  latest_compensation_status: string | null;
  latest_compensation_plan_sha256: string | null;
  requires_new_plan_freeze_approval: true;
  automatic_retry: false;
};

export type FlowIdentityWholeScopeProof = {
  schema_version: 'dataset-flow-identity-whole-scope-proof.v2';
  scope_id: string;
  receipt_id: string;
  primary_current: boolean;
  audit_current: boolean;
  source_guards_current: boolean;
  support_guards_current: boolean;
  target_guards_current: boolean;
  approved_reference_residue_count: number;
  protected_closure_current: boolean;
  occurrence_closure_current: boolean;
  derivatives_current: boolean;
  primary_closure_sha256: string;
  source_guard_set_sha256: string;
  support_guard_set_sha256: string;
  target_guard_set_sha256: string;
  protected_closure_sha256: string;
  derivative_proof_set_sha256: string;
  causal_terminal_proof: boolean;
  proof_sha256: string;
};

export type FlowIdentityScopeStatus = {
  ok: boolean;
  command: 'cmd_dataset_flow_identity_scope_read';
  schema_version: 'dataset-flow-identity-scope-status.v2';
  scope_id: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  operation_id: string;
  plan_sha256: string;
  scope_proof_sha256: string;
  status:
    | 'sealed'
    | 'running'
    | 'primary_complete'
    | 'derivatives_pending'
    | 'completed'
    | 'live_drift'
    | 'failed';
  process_count: number;
  rewrite_count: number;
  completed_process_count: number;
  pending_process_count: number;
  failed_process_count: number;
  completed_rewrite_count: number;
  next_ordinal: number;
  primary_complete: boolean;
  primary_current: boolean;
  live_guard_current: boolean;
  derivatives_current: boolean;
  derivative_pending_count: number;
  derivative_failed_count: number;
  derivative_set_proof: FlowIdentityDerivativeSetProof;
  derivative_proof_set_sha256: string;
  protected_closure_current: boolean;
  protected_closure_proof: JsonObject;
  processes: FlowIdentityScopeProcessStatus[];
  terminal_proof_sha256: string | null;
  completed_at: string | null;
  cancellable: boolean;
  strict_continuation_required: boolean;
  whole_scope_proof: FlowIdentityWholeScopeProof;
  whole_scope_proof_sha256: string;
  code?: string;
  compensation_required?: boolean;
  automatic_retry?: false;
  compensation_targets?: FlowIdentityCompensationTarget[];
};

export type FlowIdentityFinalizeProof = {
  ok: boolean;
  command: 'cmd_dataset_flow_identity_scope_finalize_guarded';
  schema_version: 'dataset-flow-identity-scope-finalize-result.v2';
  scope_id: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  mapping_guard_set_sha256: string;
  process_intent_set_sha256: string;
  operation_id: string;
  plan_sha256: string;
  scope_proof_sha256: string;
  invocation_id: string;
  permit_generation_before: number;
  status: 'derivatives_pending' | 'completed' | 'live_drift' | 'failed';
  process_count: number;
  rewrite_count: number;
  completed_process_count: number;
  primary_closure_sha256: string;
  protected_closure_sha256: string;
  derivative_target_set_sha256: string;
  derivative_proof_set_sha256: string;
  primary_current: boolean;
  live_guard_current: boolean;
  derivatives_current: boolean;
  terminal_proof_sha256: string | null;
  whole_scope_proof: FlowIdentityWholeScopeProof;
  whole_scope_proof_sha256: string;
  audit_id: string | null;
  replay: boolean;
  code?: string;
  compensation_required?: boolean;
  automatic_retry?: false;
  compensation_targets?: FlowIdentityCompensationTarget[];
};

export function fail(
  message: string,
  code = 'DATASET_FLOW_IDENTITY_EXECUTION_CONTRACT_INVALID',
): never {
  throw new CliError(message, { code, exitCode: 2 });
}

export function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

export function hash(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!HASH_PATTERN.test(normalized)) fail(`${label} must be a lowercase SHA-256.`);
  return normalized;
}

export function uuid(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!UUID_PATTERN.test(normalized)) fail(`${label} must be a canonical lowercase UUID.`);
  return normalized;
}

export function instant(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!Number.isFinite(Date.parse(normalized))) fail(`${label} must be an RFC3339 timestamp.`);
  return normalized;
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}.`);
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}

export function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys do not match the database contract.`);
  }
}

export function parseCompensationTarget(
  entry: unknown,
  plan: FlowIdentityPlan,
  scopeId: string,
  source: 'scope_read' | 'finalize' | 'derivative_set',
): FlowIdentityCompensationTarget {
  if (!isJsonObject(entry)) fail('Derivative compensation target is invalid.');
  const ordinal = integer(entry.ordinal, 'compensation ordinal', 1);
  const process = plan.processes[ordinal - 1];
  const reason = `FLOW_IDENTITY_SCOPE_COMPENSATION:${scopeId}:${ordinal}`;
  if (
    !process ||
    entry.table !== 'processes' ||
    entry.id !== process.id ||
    entry.version !== process.version ||
    !UUID_PATTERN.test(String(entry.original_batch_id)) ||
    !['failed', 'stale', 'missing'].includes(String(entry.original_status)) ||
    typeof entry.original_code !== 'string' ||
    !entry.original_code.trim() ||
    !HASH_PATTERN.test(String(entry.desired_payload_sha256)) ||
    !HASH_PATTERN.test(String(entry.current_json_ordered_sha256)) ||
    !HASH_PATTERN.test(String(entry.current_snapshot_sha256)) ||
    !Number.isFinite(Date.parse(String(entry.current_modified_at))) ||
    !Array.isArray(entry.components) ||
    entry.components.length !== 2 ||
    entry.components[0] !== 'extracted_md' ||
    entry.components[1] !== 'embedding_ft' ||
    entry.reason_code !== reason ||
    entry.operation_id_prefix !== `${reason}:` ||
    entry.requires_new_plan_freeze_approval !== true ||
    entry.automatic_retry !== false ||
    (entry.latest_compensation_request_id !== null &&
      !UUID_PATTERN.test(String(entry.latest_compensation_request_id))) ||
    (entry.latest_compensation_status !== null &&
      (typeof entry.latest_compensation_status !== 'string' ||
        !entry.latest_compensation_status.trim())) ||
    (entry.latest_compensation_plan_sha256 !== null &&
      !HASH_PATTERN.test(String(entry.latest_compensation_plan_sha256)))
  ) {
    fail('Derivative compensation target does not bind the sealed process/current snapshot.');
  }
  const missingOriginalRequest =
    entry.original_status === 'missing' &&
    entry.original_code === 'DERIVATIVE_BATCH_CHILD_MISSING' &&
    entry.original_request_id === null;
  const hasOriginalRequestId = Object.prototype.hasOwnProperty.call(entry, 'original_request_id');
  const hasOriginalError = Object.prototype.hasOwnProperty.call(entry, 'original_error');
  if (
    (source === 'scope_read' &&
      (!hasOriginalRequestId ||
        !hasOriginalError ||
        (!missingOriginalRequest &&
          (!['failed', 'stale'].includes(String(entry.original_status)) ||
            !UUID_PATTERN.test(String(entry.original_request_id)))))) ||
    (source !== 'scope_read' && (hasOriginalRequestId || hasOriginalError)) ||
    (entry.original_status === 'missing' &&
      entry.original_code !== 'DERIVATIVE_BATCH_CHILD_MISSING') ||
    (entry.original_status !== 'missing' && entry.original_request_id === null)
  ) {
    fail('Derivative compensation target provenance does not match its RPC response.');
  }
  return entry as FlowIdentityCompensationTarget;
}
