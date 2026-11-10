import path from 'node:path';
import {
  materializePrivateArtifactDirectoryAtomically,
  readProtectedJsonArtifact,
  readProtectedTextArtifact,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import {
  buildFlowIdentityExecutionIdentity,
  buildFlowIdentityScopeLookupRequest,
} from './maintenance/flow-identity/requests.js';
import {
  parseFlowIdentityScopeLookupProof,
  parseFlowIdentityScopePreflightProof,
} from './maintenance/flow-identity/proofs.js';
import { parseFlowIdentityScopeStatus } from './maintenance/flow-identity/status.js';
import { prepareFlowIdentityExecution } from './dataset-maintenance-flow-identity-execution-contract.js';
import {
  type FlowIdentityApproval,
  type FlowIdentityExecutionIdentity,
  type FlowIdentityFreeze,
  type FlowIdentityScopeProof,
  type FlowIdentityScopeStatus,
} from './maintenance/flow-identity/base.js';
import type { FlowIdentityPlan } from './dataset-maintenance-flow-identity-contract.js';
import { isJsonObject } from './maintenance/contract/values.js';
import { sha256Json, sha256Text, stableJsonText } from './canonical-json-hash.js';
import { type JsonObject } from './maintenance/contract/types.js';
import { flowIdentityRestrictedSha256 } from './dataset-maintenance-flow-identity-wire.js';
import {
  isMaintenanceRpcDomainFailure,
  lookupMaintenanceFlowIdentityScope,
  readMaintenanceFlowIdentityScope,
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { parseProtectedToolchainEvidence } from './dataset-maintenance-protected-toolchain.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const USER_STATE_CLAIM = 'authenticated_actor_state_100_plus_own_state_0' as const;

export type FlowIdentityRecoveryReason =
  | 'wrapper_exited_without_permit'
  | 'process_response_ambiguous'
  | 'process_domain_rejected'
  | 'finalize_response_ambiguous'
  | 'derivatives_became_ready_after_wrapper_exit';

const FLOW_IDENTITY_RECOVERY_REASONS: readonly FlowIdentityRecoveryReason[] = [
  'wrapper_exited_without_permit',
  'process_response_ambiguous',
  'process_domain_rejected',
  'finalize_response_ambiguous',
  'derivatives_became_ready_after_wrapper_exit',
];

export type FlowIdentityRecoveryMode = 'resume_and_finalize' | 'finalize_only';

export type FlowIdentityRecoveryBaseline = {
  status: FlowIdentityScopeStatus['status'];
  completed_process_count: number;
  next_ordinal: number;
  primary_complete: boolean;
  primary_current: boolean;
  live_guard_current: boolean;
  protected_closure_current: boolean;
  derivatives_current: boolean;
  whole_scope_proof_sha256: string;
};

export type FlowIdentityRecoveryFreeze = {
  schema_version: 'dataset-flow-identity-recovery-freeze.v1';
  generated_at_utc: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  user_state_claim: typeof USER_STATE_CLAIM;
  scope_id: string;
  scope_proof_sha256: string;
  operation_id: string;
  plan_sha256: string;
  original_freeze_sha256: string;
  original_execution_request_id: string;
  original_execution_identity_sha256: string;
  original_execution_approval_request_sha256: string;
  original_execution_approval_text_sha256: string;
  original_execution_approval_identity_sha256: string;
  recovery_reason: FlowIdentityRecoveryReason;
  recovery_mode: FlowIdentityRecoveryMode;
  baseline: FlowIdentityRecoveryBaseline;
  toolchain_evidence_sha256: string;
  approval_reusable: false;
  maximum_wrapper_invocations: 1;
  maximum_cli_apply_spawns: 1;
  maximum_process_posts: number;
  maximum_finalize_posts: 1;
  automatic_retry: false;
  recovery_freeze_sha256: string;
};

export type FlowIdentityRecoveryApprovalRequestCore = {
  schema_version: 'dataset-flow-identity-recovery-approval-request.v1';
  approved_at_utc: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  user_state_claim: typeof USER_STATE_CLAIM;
  scope_id: string;
  scope_proof_sha256: string;
  operation_id: string;
  plan_sha256: string;
  original_freeze_sha256: string;
  original_execution_request_id: string;
  original_execution_identity_sha256: string;
  original_execution_approval_request_sha256: string;
  original_execution_approval_text_sha256: string;
  original_execution_approval_identity_sha256: string;
  recovery_reason: FlowIdentityRecoveryReason;
  recovery_mode: FlowIdentityRecoveryMode;
  baseline: FlowIdentityRecoveryBaseline;
  recovery_freeze_file_sha256: string;
  recovery_freeze_sha256: string;
  toolchain_evidence_sha256: string;
  approval_reusable: false;
  maximum_wrapper_invocations: 1;
  maximum_cli_apply_spawns: 1;
  maximum_process_posts: number;
  maximum_finalize_posts: 1;
  automatic_retry: false;
};

export type FlowIdentityRecoveryApprovalRequest = FlowIdentityRecoveryApprovalRequestCore & {
  request_sha256: string;
};

export type FlowIdentityRecoveryApproval = {
  schema_version: 'dataset-flow-identity-recovery-approval.v1';
  approved_at_utc: string;
  actor: { user_id: string; email: string };
  plan_sha256: string;
  scope_id: string;
  scope_proof_sha256: string;
  recovery_freeze_sha256: string;
  toolchain_evidence_sha256: string;
  recovery_approval_request_sha256: string;
  recovery_approval_text_sha256: string;
  recovery_approval_identity_sha256: string;
};

export type FreezeFlowIdentityRecoveryOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  runDir: string;
  toolchainEvidencePath: string;
  expectedProjectRef: string;
  confirm: string;
  approvedAtUtc: string;
  recoveryReason: FlowIdentityRecoveryReason;
  cliVersion: string;
  outDir: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
  dependencies?: {
    resolveContext: typeof resolveMaintenanceRemoteContext;
    lookup: typeof lookupMaintenanceFlowIdentityScope;
    read: typeof readMaintenanceFlowIdentityScope;
  };
};

export type FlowIdentityRecoveryFreezeReport = {
  schema_version: 'dataset-flow-identity-recovery-freeze-report.v1';
  generated_at_utc: string;
  status: 'frozen';
  execution_submitted: false;
  network_calls: 2 | 3;
  database_calls: 1 | 2;
  scope_id: string;
  plan_sha256: string;
  recovery_freeze_sha256: string;
  recovery_freeze_file_sha256: string;
  recovery_approval_request_sha256: string;
  recovery_approval_text_sha256: string;
  artifacts: {
    freeze: string;
    scope_proof: string;
    approval_request: string;
    approval_text: string;
    report: string;
  };
};

export type SealFlowIdentityRecoveryApprovalOptions = {
  recoveryFreezePath: string;
  approvalRequestPath: string;
  humanApprovalPath: string;
  approveFreezeFile: string;
  approveRequest: string;
  approveText: string;
  confirm: string;
  approvedAtUtc: string;
  outDir: string;
  now?: Date;
};

export type FlowIdentityRecoveryApprovalSealReport = {
  schema_version: 'dataset-flow-identity-recovery-approval-seal-report.v1';
  generated_at_utc: string;
  status: 'sealed';
  execution_submitted: false;
  network_calls: 0;
  database_calls: 0;
  scope_id: string;
  plan_sha256: string;
  recovery_freeze_sha256: string;
  recovery_approval_request_sha256: string;
  recovery_approval_text_sha256: string;
  recovery_approval_identity_sha256: string;
  artifacts: { human_approval: string; approval: string; report: string };
};

export type PreparedFlowIdentityRecoveryExecution = {
  plan: FlowIdentityPlan;
  originalFreeze: FlowIdentityFreeze;
  originalApproval: FlowIdentityApproval;
  originalIdentity: FlowIdentityExecutionIdentity;
  scope: FlowIdentityScopeProof;
  recoveryFreeze: FlowIdentityRecoveryFreeze;
  recoveryApproval: FlowIdentityRecoveryApproval;
  recoveryRequest: JsonObject;
};

/** Sanitized proof returned by the recovery admission RPC after the permit is removed. */
export type FlowIdentityRecoveryProof = {
  ok: true;
  command: 'cmd_dataset_flow_identity_scope_recover_guarded';
  schema_version: 'dataset-flow-identity-scope-recovery-result.v1';
  scope_id: string;
  scope_proof_sha256: string;
  status: FlowIdentityRecoveryBaseline['status'];
  completed_process_count: number;
  next_ordinal: number;
  whole_scope_proof_sha256: string;
  recovery_wire_request_sha256: string;
  recovery_approval_identity_sha256: string;
  invocation_id: string;
  audit_id: string;
  replay: boolean;
};

export const FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS = {
  freeze: 'flow-identity-recovery-freeze.json',
  scope_proof: 'flow-identity-recovery-scope-proof.json',
  approval_request: 'flow-identity-recovery-approval-request.json',
  approval_text: 'flow-identity-recovery-approval-request.txt',
  report: 'flow-identity-recovery-freeze-report.json',
} as const;

export const FLOW_IDENTITY_RECOVERY_APPROVAL_ARTIFACTS = {
  human_approval: 'flow-identity-recovery-human-approval.txt',
  approval: 'flow-identity-recovery-approval.json',
  report: 'flow-identity-recovery-approval-seal-report.json',
} as const;

function fail(message: string, code = 'DATASET_FLOW_IDENTITY_RECOVERY_INVALID'): never {
  throw new CliError(message, { code, exitCode: 1 });
}

function canonicalTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical RFC3339 UTC timestamp.`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail(`${label} must be a SHA-256.`);
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID.`);
  return value;
}

function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((entry, index) => entry !== required[index])
  ) {
    fail(`${label} has an unexpected wire shape.`);
  }
}

function requireCanonicalJson(filePath: string, label: string) {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(`${label} must be canonical JSON with one trailing newline.`);
  }
  return artifact;
}

function parseRecoveryScopeProof(
  value: unknown,
  plan: FlowIdentityPlan,
  identity: FlowIdentityExecutionIdentity,
): FlowIdentityScopeProof {
  if (
    isJsonObject(value) &&
    value.schema_version === 'dataset-flow-identity-scope-lookup-result.v1'
  ) {
    return parseFlowIdentityScopeLookupProof(value, plan, identity);
  }
  return parseFlowIdentityScopePreflightProof(value, plan);
}

function readRecoveryScopeProof(options: {
  runDir: string;
  plan: FlowIdentityPlan;
  identity: FlowIdentityExecutionIdentity;
}): FlowIdentityScopeProof | null {
  for (const [name, label] of [
    ['scope-preflight-proof.json', 'Flow identity scope preflight proof'],
    ['scope-lookup-proof.json', 'Flow identity scope lookup proof'],
  ] as const) {
    const filePath = path.join(path.resolve(options.runDir), name);
    try {
      const artifact = requireCanonicalJson(filePath, label);
      return parseRecoveryScopeProof(artifact.value, options.plan, options.identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function recoveryBaseline(status: FlowIdentityScopeStatus): FlowIdentityRecoveryBaseline {
  return {
    status: status.status,
    completed_process_count: status.completed_process_count,
    next_ordinal: status.next_ordinal,
    primary_complete: status.primary_complete,
    primary_current: status.primary_current,
    live_guard_current: status.live_guard_current,
    protected_closure_current: status.protected_closure_current,
    derivatives_current: status.derivatives_current,
    whole_scope_proof_sha256: status.whole_scope_proof_sha256,
  };
}

function assertRecoveryBaseline(value: unknown): asserts value is FlowIdentityRecoveryBaseline {
  if (!isJsonObject(value)) fail('Recovery baseline is invalid.');
  const keys = [
    'status',
    'completed_process_count',
    'next_ordinal',
    'primary_complete',
    'primary_current',
    'live_guard_current',
    'protected_closure_current',
    'derivatives_current',
    'whole_scope_proof_sha256',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    !['sealed', 'running', 'primary_complete', 'derivatives_pending'].includes(
      String(value.status),
    ) ||
    !Number.isSafeInteger(value.completed_process_count) ||
    Number(value.completed_process_count) < 0 ||
    !Number.isSafeInteger(value.next_ordinal) ||
    Number(value.next_ordinal) < 1 ||
    ![
      value.primary_complete,
      value.primary_current,
      value.live_guard_current,
      value.protected_closure_current,
      value.derivatives_current,
    ].every((entry) => typeof entry === 'boolean') ||
    !HASH.test(String(value.whole_scope_proof_sha256))
  ) {
    fail('Recovery baseline is inconsistent.');
  }
}

export function computeFlowIdentityRecoveryFreezeSha256(
  freeze: FlowIdentityRecoveryFreeze,
): string {
  return sha256Json({ ...freeze, recovery_freeze_sha256: '' });
}

function recoveryRequestCore(
  value: FlowIdentityRecoveryApprovalRequest,
): FlowIdentityRecoveryApprovalRequestCore {
  const core = { ...value } as Partial<FlowIdentityRecoveryApprovalRequest>;
  delete core.request_sha256;
  return core as FlowIdentityRecoveryApprovalRequestCore;
}

export function computeFlowIdentityRecoveryApprovalRequestSha256(
  request: FlowIdentityRecoveryApprovalRequest,
): string {
  return sha256Json(recoveryRequestCore(request));
}

export function computeFlowIdentityRecoveryApprovalIdentitySha256(
  approval: FlowIdentityRecoveryApproval,
): string {
  return sha256Json({ ...approval, recovery_approval_identity_sha256: '' });
}

export function renderFlowIdentityRecoveryApprovalText(
  core: FlowIdentityRecoveryApprovalRequestCore,
  requestSha256: string,
): string {
  requireHash(requestSha256, 'request_sha256');
  return [
    'BAFU Step 3 protected owner-draft recovery approval request',
    `schema_version=${core.schema_version}`,
    `approved_at_utc=${core.approved_at_utc}`,
    `request_sha256=${requestSha256}`,
    `environment=${core.environment}`,
    `project_ref=${core.project_ref}`,
    `account_email=${core.actor.email}`,
    `account_user_id=${core.actor.user_id}`,
    `target_visibility=${core.target_visibility}`,
    `user_state_claim=${core.user_state_claim}`,
    `scope_id=${core.scope_id}`,
    `scope_proof_sha256=${core.scope_proof_sha256}`,
    `operation_id=${core.operation_id}`,
    `plan_sha256=${core.plan_sha256}`,
    `original_freeze_sha256=${core.original_freeze_sha256}`,
    `original_execution_request_id=${core.original_execution_request_id}`,
    `original_execution_identity_sha256=${core.original_execution_identity_sha256}`,
    `original_execution_approval_request_sha256=${core.original_execution_approval_request_sha256}`,
    `original_execution_approval_text_sha256=${core.original_execution_approval_text_sha256}`,
    `original_execution_approval_identity_sha256=${core.original_execution_approval_identity_sha256}`,
    `recovery_reason=${core.recovery_reason}`,
    `recovery_mode=${core.recovery_mode}`,
    `baseline_status=${core.baseline.status}`,
    `baseline_completed_process_count=${core.baseline.completed_process_count}`,
    `baseline_next_ordinal=${core.baseline.next_ordinal}`,
    `baseline_primary_complete=${String(core.baseline.primary_complete)}`,
    `baseline_derivatives_current=${String(core.baseline.derivatives_current)}`,
    `baseline_whole_scope_proof_sha256=${core.baseline.whole_scope_proof_sha256}`,
    `recovery_freeze_file_sha256=${core.recovery_freeze_file_sha256}`,
    `recovery_freeze_sha256=${core.recovery_freeze_sha256}`,
    `toolchain_evidence_sha256=${core.toolchain_evidence_sha256}`,
    `approval_reusable=${String(core.approval_reusable)}`,
    `maximum_wrapper_invocations=${core.maximum_wrapper_invocations}`,
    `maximum_cli_apply_spawns=${core.maximum_cli_apply_spawns}`,
    `maximum_process_posts=${core.maximum_process_posts}`,
    `maximum_finalize_posts=${core.maximum_finalize_posts}`,
    `automatic_retry=${String(core.automatic_retry)}`,
    'Approve only by returning this text byte-for-byte without edits.',
    '',
  ].join('\n');
}

export function parseFlowIdentityRecoveryFreeze(value: unknown): FlowIdentityRecoveryFreeze {
  if (!isJsonObject(value) || !isJsonObject(value.actor)) fail('Recovery freeze is invalid.');
  const freeze = value as FlowIdentityRecoveryFreeze;
  assertRecoveryBaseline(freeze.baseline);
  if (
    freeze.schema_version !== 'dataset-flow-identity-recovery-freeze.v1' ||
    freeze.environment !== 'production' ||
    freeze.target_visibility !== 'owner_draft' ||
    freeze.user_state_claim !== USER_STATE_CLAIM ||
    !UUID.test(freeze.actor.user_id) ||
    freeze.actor.email !== freeze.actor.email.trim().toLowerCase() ||
    !UUID.test(freeze.scope_id) ||
    ![
      freeze.scope_proof_sha256,
      freeze.plan_sha256,
      freeze.original_freeze_sha256,
      freeze.original_execution_identity_sha256,
      freeze.original_execution_approval_request_sha256,
      freeze.original_execution_approval_text_sha256,
      freeze.original_execution_approval_identity_sha256,
      freeze.toolchain_evidence_sha256,
      freeze.recovery_freeze_sha256,
    ].every((entry) => HASH.test(entry)) ||
    !Number.isFinite(Date.parse(freeze.generated_at_utc)) ||
    freeze.approval_reusable !== false ||
    freeze.maximum_wrapper_invocations !== 1 ||
    freeze.maximum_cli_apply_spawns !== 1 ||
    !Number.isSafeInteger(freeze.maximum_process_posts) ||
    freeze.maximum_process_posts < 0 ||
    freeze.maximum_finalize_posts !== 1 ||
    freeze.automatic_retry !== false ||
    !FLOW_IDENTITY_RECOVERY_REASONS.includes(freeze.recovery_reason) ||
    freeze.recovery_mode !==
      (freeze.maximum_process_posts === 0 ? 'finalize_only' : 'resume_and_finalize') ||
    freeze.recovery_freeze_sha256 !== computeFlowIdentityRecoveryFreezeSha256(freeze)
  ) {
    fail('Recovery freeze is inconsistent or tampered.');
  }
  return freeze;
}

export function parseFlowIdentityRecoveryApprovalRequest(
  value: unknown,
): FlowIdentityRecoveryApprovalRequest {
  if (!isJsonObject(value) || !isJsonObject(value.actor)) {
    fail('Recovery approval request is invalid.');
  }
  const request = value as FlowIdentityRecoveryApprovalRequest;
  assertRecoveryBaseline(request.baseline);
  if (
    request.schema_version !== 'dataset-flow-identity-recovery-approval-request.v1' ||
    request.environment !== 'production' ||
    request.target_visibility !== 'owner_draft' ||
    request.user_state_claim !== USER_STATE_CLAIM ||
    !UUID.test(request.actor.user_id) ||
    !UUID.test(request.scope_id) ||
    ![
      request.scope_proof_sha256,
      request.plan_sha256,
      request.original_freeze_sha256,
      request.original_execution_identity_sha256,
      request.original_execution_approval_request_sha256,
      request.original_execution_approval_text_sha256,
      request.original_execution_approval_identity_sha256,
      request.recovery_freeze_file_sha256,
      request.recovery_freeze_sha256,
      request.toolchain_evidence_sha256,
      request.request_sha256,
    ].every((entry) => HASH.test(entry)) ||
    !canonicalTimestamp(request.approved_at_utc, 'approved_at_utc') ||
    request.approval_reusable !== false ||
    request.maximum_wrapper_invocations !== 1 ||
    request.maximum_cli_apply_spawns !== 1 ||
    !Number.isSafeInteger(request.maximum_process_posts) ||
    request.maximum_process_posts < 0 ||
    request.maximum_finalize_posts !== 1 ||
    request.automatic_retry !== false ||
    !FLOW_IDENTITY_RECOVERY_REASONS.includes(request.recovery_reason) ||
    request.recovery_mode !==
      (request.maximum_process_posts === 0 ? 'finalize_only' : 'resume_and_finalize') ||
    request.request_sha256 !== computeFlowIdentityRecoveryApprovalRequestSha256(request)
  ) {
    fail('Recovery approval request is inconsistent or tampered.');
  }
  return request;
}

export function parseFlowIdentityRecoveryApproval(
  value: unknown,
  freeze: FlowIdentityRecoveryFreeze,
): FlowIdentityRecoveryApproval {
  if (!isJsonObject(value) || !isJsonObject(value.actor)) fail('Recovery approval is invalid.');
  const approval = value as FlowIdentityRecoveryApproval;
  if (
    approval.schema_version !== 'dataset-flow-identity-recovery-approval.v1' ||
    approval.actor.user_id !== freeze.actor.user_id ||
    approval.actor.email !== freeze.actor.email ||
    approval.plan_sha256 !== freeze.plan_sha256 ||
    approval.scope_id !== freeze.scope_id ||
    approval.scope_proof_sha256 !== freeze.scope_proof_sha256 ||
    approval.recovery_freeze_sha256 !== freeze.recovery_freeze_sha256 ||
    approval.toolchain_evidence_sha256 !== freeze.toolchain_evidence_sha256 ||
    ![
      approval.recovery_approval_request_sha256,
      approval.recovery_approval_text_sha256,
      approval.recovery_approval_identity_sha256,
    ].every((entry) => HASH.test(entry)) ||
    !Number.isFinite(Date.parse(approval.approved_at_utc)) ||
    Date.parse(approval.approved_at_utc) < Date.parse(freeze.generated_at_utc) ||
    approval.recovery_approval_identity_sha256 !==
      computeFlowIdentityRecoveryApprovalIdentitySha256(approval)
  ) {
    fail('Recovery approval does not bind the exact recovery freeze.');
  }
  return approval;
}

function assertContext(plan: FlowIdentityPlan, context: DatasetMaintenanceRemoteContext): void {
  if (
    context.project_ref !== plan.project_ref ||
    context.account.user_id !== plan.account.user_id ||
    context.account.email.trim().toLowerCase() !== plan.account.email
  ) {
    fail('Authenticated production context does not match the recovery plan.');
  }
}

function assertRecoverableStatus(status: FlowIdentityScopeStatus, plan: FlowIdentityPlan): void {
  if (
    !['sealed', 'running', 'primary_complete', 'derivatives_pending'].includes(status.status) ||
    !status.primary_current ||
    !status.live_guard_current ||
    !status.protected_closure_current ||
    status.compensation_required === true ||
    status.completed_process_count < 0 ||
    status.completed_process_count > plan.processes.length ||
    status.next_ordinal !== Math.min(status.completed_process_count + 1, plan.processes.length + 1)
  ) {
    fail('Live scope is not eligible for an exact continuation recovery approval.');
  }
}

export async function freezeFlowIdentityRecovery(
  options: FreezeFlowIdentityRecoveryOptions,
): Promise<FlowIdentityRecoveryFreezeReport> {
  const planArtifact = requireCanonicalJson(options.planPath, 'Flow identity plan');
  const originalFreezeArtifact = requireCanonicalJson(
    options.freezePath,
    'Flow identity original freeze',
  );
  const originalApprovalArtifact = requireCanonicalJson(
    options.approvalPath,
    'Flow identity original approval',
  );
  const prepared = prepareFlowIdentityExecution({
    plan: planArtifact.value,
    freeze: originalFreezeArtifact.value,
    approval: originalApprovalArtifact.value,
  });
  if (
    prepared.plan.project_ref !== options.expectedProjectRef ||
    prepared.plan.account.email !== options.confirm
  ) {
    fail('Recovery freeze requires the exact production project and account confirmation.');
  }
  let scope = readRecoveryScopeProof({
    runDir: options.runDir,
    plan: prepared.plan,
    identity: prepared.identity,
  });
  let lookupPerformed = false;
  const toolchainArtifact = requireCanonicalJson(
    options.toolchainEvidencePath,
    'Protected toolchain evidence',
  );
  parseProtectedToolchainEvidence(toolchainArtifact.value, {
    projectRef: options.expectedProjectRef,
    cliVersion: options.cliVersion,
  });
  const generatedAt = (options.now ?? new Date()).toISOString();
  const approvedAt = canonicalTimestamp(options.approvedAtUtc, 'approvedAtUtc');
  if (Date.parse(approvedAt) < Date.parse(generatedAt)) {
    fail('approvedAtUtc cannot precede the recovery freeze.');
  }
  const context = await (options.dependencies?.resolveContext ?? resolveMaintenanceRemoteContext)({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  assertContext(prepared.plan, context);
  if (scope === null) {
    lookupPerformed = true;
    const lookupRaw = await (options.dependencies?.lookup ?? lookupMaintenanceFlowIdentityScope)({
      context,
      request: buildFlowIdentityScopeLookupRequest({ identity: prepared.identity }),
    });
    if (isMaintenanceRpcDomainFailure(lookupRaw)) {
      fail('Read-only scope lookup could not recover the lost preflight response.');
    }
    scope = parseFlowIdentityScopeLookupProof(lookupRaw, prepared.plan, prepared.identity);
  }
  const raw = await (options.dependencies?.read ?? readMaintenanceFlowIdentityScope)({
    context,
    scopeId: scope.scope_id,
  });
  if (isMaintenanceRpcDomainFailure(raw)) {
    fail('Database rejected the read-only recovery scope snapshot.');
  }
  const status = parseFlowIdentityScopeStatus(
    raw,
    prepared.plan,
    scope.scope_id,
    scope.scope_proof_sha256,
  );
  assertRecoverableStatus(status, prepared.plan);
  const remainingProcessPosts = prepared.plan.processes.length - status.completed_process_count;
  const freeze: FlowIdentityRecoveryFreeze = {
    schema_version: 'dataset-flow-identity-recovery-freeze.v1',
    generated_at_utc: generatedAt,
    environment: 'production',
    project_ref: prepared.plan.project_ref,
    actor: prepared.plan.account,
    target_visibility: 'owner_draft',
    user_state_claim: USER_STATE_CLAIM,
    scope_id: scope.scope_id,
    scope_proof_sha256: scope.scope_proof_sha256,
    operation_id: prepared.plan.operation_id,
    plan_sha256: prepared.plan.plan_sha256,
    original_freeze_sha256: prepared.freeze.freeze_sha256,
    original_execution_request_id: prepared.identity.request_id,
    original_execution_identity_sha256: prepared.identity.identity_sha256,
    original_execution_approval_request_sha256: prepared.approval.execution_approval_request_sha256,
    original_execution_approval_text_sha256: prepared.approval.execution_approval_text_sha256,
    original_execution_approval_identity_sha256:
      prepared.approval.execution_approval_identity_sha256,
    recovery_reason: options.recoveryReason,
    recovery_mode: remainingProcessPosts === 0 ? 'finalize_only' : 'resume_and_finalize',
    baseline: recoveryBaseline(status),
    toolchain_evidence_sha256: toolchainArtifact.file_sha256,
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: remainingProcessPosts,
    maximum_finalize_posts: 1,
    automatic_retry: false,
    recovery_freeze_sha256: '',
  };
  freeze.recovery_freeze_sha256 = computeFlowIdentityRecoveryFreezeSha256(freeze);
  const freezeText = `${stableJsonText(freeze)}\n`;
  const freezeFileSha256 = sha256Text(freezeText);
  const core: FlowIdentityRecoveryApprovalRequestCore = {
    schema_version: 'dataset-flow-identity-recovery-approval-request.v1',
    approved_at_utc: approvedAt,
    environment: 'production',
    project_ref: freeze.project_ref,
    actor: freeze.actor,
    target_visibility: 'owner_draft',
    user_state_claim: USER_STATE_CLAIM,
    scope_id: freeze.scope_id,
    scope_proof_sha256: freeze.scope_proof_sha256,
    operation_id: freeze.operation_id,
    plan_sha256: freeze.plan_sha256,
    original_freeze_sha256: freeze.original_freeze_sha256,
    original_execution_request_id: freeze.original_execution_request_id,
    original_execution_identity_sha256: freeze.original_execution_identity_sha256,
    original_execution_approval_request_sha256: freeze.original_execution_approval_request_sha256,
    original_execution_approval_text_sha256: freeze.original_execution_approval_text_sha256,
    original_execution_approval_identity_sha256: freeze.original_execution_approval_identity_sha256,
    recovery_reason: freeze.recovery_reason,
    recovery_mode: freeze.recovery_mode,
    baseline: freeze.baseline,
    recovery_freeze_file_sha256: freezeFileSha256,
    recovery_freeze_sha256: freeze.recovery_freeze_sha256,
    toolchain_evidence_sha256: freeze.toolchain_evidence_sha256,
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: remainingProcessPosts,
    maximum_finalize_posts: 1,
    automatic_retry: false,
  };
  const request = parseFlowIdentityRecoveryApprovalRequest({
    ...core,
    request_sha256: sha256Json(core),
  });
  const approvalText = renderFlowIdentityRecoveryApprovalText(core, request.request_sha256);
  const approvalTextSha256 = sha256Text(approvalText);
  const outDir = path.resolve(options.outDir);
  const artifacts = Object.fromEntries(
    Object.entries(FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(outDir, name),
    ]),
  ) as FlowIdentityRecoveryFreezeReport['artifacts'];
  const report: FlowIdentityRecoveryFreezeReport = {
    schema_version: 'dataset-flow-identity-recovery-freeze-report.v1',
    generated_at_utc: generatedAt,
    status: 'frozen',
    execution_submitted: false,
    network_calls: lookupPerformed ? 3 : 2,
    database_calls: lookupPerformed ? 2 : 1,
    scope_id: freeze.scope_id,
    plan_sha256: freeze.plan_sha256,
    recovery_freeze_sha256: freeze.recovery_freeze_sha256,
    recovery_freeze_file_sha256: freezeFileSha256,
    recovery_approval_request_sha256: request.request_sha256,
    recovery_approval_text_sha256: approvalTextSha256,
    artifacts,
  };
  materializePrivateArtifactDirectoryAtomically(outDir, (staging) => {
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS.freeze),
      freezeText,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS.approval_request),
      request,
    );
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS.approval_text),
      approvalText,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS.scope_proof),
      scope,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_RECOVERY_FREEZE_ARTIFACTS.report),
      report,
    );
  });
  return report;
}

export function sealFlowIdentityRecoveryApproval(
  options: SealFlowIdentityRecoveryApprovalOptions,
): FlowIdentityRecoveryApprovalSealReport {
  requireHash(options.approveFreezeFile, 'approveFreezeFile');
  requireHash(options.approveRequest, 'approveRequest');
  requireHash(options.approveText, 'approveText');
  const freezeArtifact = requireCanonicalJson(options.recoveryFreezePath, 'Recovery freeze');
  const freeze = parseFlowIdentityRecoveryFreeze(freezeArtifact.value);
  const requestArtifact = requireCanonicalJson(
    options.approvalRequestPath,
    'Recovery approval request',
  );
  const request = parseFlowIdentityRecoveryApprovalRequest(requestArtifact.value);
  const humanApproval = readProtectedTextArtifact(options.humanApprovalPath);
  const expectedText = renderFlowIdentityRecoveryApprovalText(
    recoveryRequestCore(request),
    request.request_sha256,
  );
  if (
    freezeArtifact.file_sha256 !== options.approveFreezeFile ||
    request.request_sha256 !== options.approveRequest ||
    sha256Text(expectedText) !== options.approveText ||
    humanApproval.text !== expectedText ||
    freeze.actor.email !== options.confirm ||
    options.approvedAtUtc !== request.approved_at_utc ||
    request.actor.user_id !== freeze.actor.user_id ||
    request.actor.email !== freeze.actor.email ||
    request.plan_sha256 !== freeze.plan_sha256 ||
    request.scope_id !== freeze.scope_id ||
    request.scope_proof_sha256 !== freeze.scope_proof_sha256 ||
    request.recovery_freeze_file_sha256 !== freezeArtifact.file_sha256 ||
    request.recovery_freeze_sha256 !== freeze.recovery_freeze_sha256 ||
    request.toolchain_evidence_sha256 !== freeze.toolchain_evidence_sha256 ||
    sha256Json(request.baseline) !== sha256Json(freeze.baseline)
  ) {
    fail('Recovery human approval does not exactly bind the freeze/request/status baseline.');
  }
  const approval: FlowIdentityRecoveryApproval = {
    schema_version: 'dataset-flow-identity-recovery-approval.v1',
    approved_at_utc: request.approved_at_utc,
    actor: request.actor,
    plan_sha256: request.plan_sha256,
    scope_id: request.scope_id,
    scope_proof_sha256: request.scope_proof_sha256,
    recovery_freeze_sha256: request.recovery_freeze_sha256,
    toolchain_evidence_sha256: request.toolchain_evidence_sha256,
    recovery_approval_request_sha256: request.request_sha256,
    recovery_approval_text_sha256: sha256Text(expectedText),
    recovery_approval_identity_sha256: '',
  };
  approval.recovery_approval_identity_sha256 =
    computeFlowIdentityRecoveryApprovalIdentitySha256(approval);
  const outDir = path.resolve(options.outDir);
  const artifacts = Object.fromEntries(
    Object.entries(FLOW_IDENTITY_RECOVERY_APPROVAL_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(outDir, name),
    ]),
  ) as FlowIdentityRecoveryApprovalSealReport['artifacts'];
  const report: FlowIdentityRecoveryApprovalSealReport = {
    schema_version: 'dataset-flow-identity-recovery-approval-seal-report.v1',
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: 'sealed',
    execution_submitted: false,
    network_calls: 0,
    database_calls: 0,
    scope_id: freeze.scope_id,
    plan_sha256: freeze.plan_sha256,
    recovery_freeze_sha256: freeze.recovery_freeze_sha256,
    recovery_approval_request_sha256: approval.recovery_approval_request_sha256,
    recovery_approval_text_sha256: approval.recovery_approval_text_sha256,
    recovery_approval_identity_sha256: approval.recovery_approval_identity_sha256,
    artifacts,
  };
  materializePrivateArtifactDirectoryAtomically(outDir, (staging) => {
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_RECOVERY_APPROVAL_ARTIFACTS.human_approval),
      humanApproval.text,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_RECOVERY_APPROVAL_ARTIFACTS.approval),
      approval,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_RECOVERY_APPROVAL_ARTIFACTS.report),
      report,
    );
  });
  return report;
}

function deterministicUuidFromSha256(digest: string): string {
  const chars = digest.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildFlowIdentityRecoveryRequest(options: {
  freeze: FlowIdentityRecoveryFreeze;
  approval: FlowIdentityRecoveryApproval;
}): JsonObject {
  return {
    schema_version: 'dataset-flow-identity-scope-recovery.v1',
    request_id: deterministicUuidFromSha256(
      sha256Text(
        `dataset-flow-identity-recovery.v1\u0000${options.approval.recovery_approval_identity_sha256}`,
      ),
    ),
    approved_at_utc: options.approval.approved_at_utc,
    environment: options.freeze.environment,
    project_ref: options.freeze.project_ref,
    actor: options.freeze.actor,
    target_visibility: options.freeze.target_visibility,
    user_state_claim: options.freeze.user_state_claim,
    operation_id: options.freeze.operation_id,
    plan_sha256: options.freeze.plan_sha256,
    freeze_sha256: options.freeze.original_freeze_sha256,
    original_execution_approval_identity_sha256:
      options.freeze.original_execution_approval_identity_sha256,
    scope_proof_sha256: options.freeze.scope_proof_sha256,
    observed_scope_status: options.freeze.baseline.status,
    observed_completed_process_count: options.freeze.baseline.completed_process_count,
    observed_next_ordinal: options.freeze.baseline.next_ordinal,
    observed_whole_scope_proof_sha256: options.freeze.baseline.whole_scope_proof_sha256,
    recovery_mode: options.freeze.recovery_mode,
    recovery_reason: options.freeze.recovery_reason,
    toolchain_evidence_sha256: options.freeze.toolchain_evidence_sha256,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: options.freeze.maximum_process_posts,
    maximum_finalize_posts: 1,
    approval_reusable: false,
    automatic_retry: false,
    recovery_approval_request_sha256: options.approval.recovery_approval_request_sha256,
    recovery_approval_text_sha256: options.approval.recovery_approval_text_sha256,
    recovery_approval_identity_sha256: options.approval.recovery_approval_identity_sha256,
  };
}

export function parseFlowIdentityRecoveryProof(options: {
  value: unknown;
  freeze: FlowIdentityRecoveryFreeze;
  approval: FlowIdentityRecoveryApproval;
  request: JsonObject;
  expectedInvocationId?: string;
}): FlowIdentityRecoveryProof {
  if (!isJsonObject(options.value)) fail('Recovery admission proof is invalid.');
  const value = options.value;
  assertExactKeys(
    value,
    [
      'ok',
      'command',
      'schema_version',
      'scope_id',
      'scope_proof_sha256',
      'status',
      'completed_process_count',
      'next_ordinal',
      'whole_scope_proof_sha256',
      'recovery_wire_request_sha256',
      'recovery_approval_identity_sha256',
      'invocation_id',
      'audit_id',
      'replay',
    ],
    'Recovery admission proof',
  );
  const invocationId = requireUuid(value.invocation_id, 'Recovery invocation_id');
  if (
    value.ok !== true ||
    value.command !== 'cmd_dataset_flow_identity_scope_recover_guarded' ||
    value.schema_version !== 'dataset-flow-identity-scope-recovery-result.v1' ||
    value.scope_id !== options.freeze.scope_id ||
    value.scope_proof_sha256 !== options.freeze.scope_proof_sha256 ||
    value.status !== options.freeze.baseline.status ||
    value.completed_process_count !== options.freeze.baseline.completed_process_count ||
    value.next_ordinal !== options.freeze.baseline.next_ordinal ||
    value.whole_scope_proof_sha256 !== options.freeze.baseline.whole_scope_proof_sha256 ||
    value.recovery_wire_request_sha256 !== flowIdentityRestrictedSha256(options.request) ||
    value.recovery_approval_identity_sha256 !==
      options.approval.recovery_approval_identity_sha256 ||
    (options.expectedInvocationId !== undefined && invocationId !== options.expectedInvocationId) ||
    typeof value.audit_id !== 'string' ||
    !value.audit_id.trim() ||
    typeof value.replay !== 'boolean'
  ) {
    fail('Recovery admission proof does not bind the approved live baseline and wire request.');
  }
  requireUuid(value.scope_id, 'Recovery scope_id');
  requireHash(value.scope_proof_sha256, 'Recovery scope_proof_sha256');
  requireHash(value.whole_scope_proof_sha256, 'Recovery whole_scope_proof_sha256');
  requireHash(value.recovery_wire_request_sha256, 'Recovery wire request SHA-256');
  requireHash(value.recovery_approval_identity_sha256, 'Recovery approval identity SHA-256');
  return value as FlowIdentityRecoveryProof;
}

export function prepareFlowIdentityRecoveryExecution(options: {
  plan: unknown;
  originalFreeze: unknown;
  originalApproval: unknown;
  scope: unknown;
  recoveryFreeze: unknown;
  recoveryApproval: unknown;
}): PreparedFlowIdentityRecoveryExecution {
  const original = prepareFlowIdentityExecution({
    plan: options.plan,
    freeze: options.originalFreeze,
    approval: options.originalApproval,
  });
  const scope = parseRecoveryScopeProof(options.scope, original.plan, original.identity);
  const recoveryFreeze = parseFlowIdentityRecoveryFreeze(options.recoveryFreeze);
  const recoveryApproval = parseFlowIdentityRecoveryApproval(
    options.recoveryApproval,
    recoveryFreeze,
  );
  if (
    recoveryFreeze.project_ref !== original.plan.project_ref ||
    recoveryFreeze.actor.user_id !== original.plan.account.user_id ||
    recoveryFreeze.actor.email !== original.plan.account.email ||
    recoveryFreeze.scope_id !== scope.scope_id ||
    recoveryFreeze.scope_proof_sha256 !== scope.scope_proof_sha256 ||
    recoveryFreeze.operation_id !== original.plan.operation_id ||
    recoveryFreeze.plan_sha256 !== original.plan.plan_sha256 ||
    recoveryFreeze.original_freeze_sha256 !== original.freeze.freeze_sha256 ||
    recoveryFreeze.original_execution_request_id !== original.identity.request_id ||
    recoveryFreeze.original_execution_identity_sha256 !== original.identity.identity_sha256 ||
    recoveryFreeze.original_execution_approval_request_sha256 !==
      original.approval.execution_approval_request_sha256 ||
    recoveryFreeze.original_execution_approval_text_sha256 !==
      original.approval.execution_approval_text_sha256 ||
    recoveryFreeze.original_execution_approval_identity_sha256 !==
      original.approval.execution_approval_identity_sha256 ||
    recoveryFreeze.maximum_process_posts !==
      original.plan.processes.length - recoveryFreeze.baseline.completed_process_count
  ) {
    fail('Recovery artifacts do not bind the original immutable execution and durable scope.');
  }
  return {
    plan: original.plan,
    originalFreeze: original.freeze,
    originalApproval: original.approval,
    originalIdentity: buildFlowIdentityExecutionIdentity({
      plan: original.plan,
      freeze: original.freeze,
      approval: original.approval,
    }),
    scope,
    recoveryFreeze,
    recoveryApproval,
    recoveryRequest: buildFlowIdentityRecoveryRequest({
      freeze: recoveryFreeze,
      approval: recoveryApproval,
    }),
  };
}

export function assertFreshRecoveryBaseline(
  status: FlowIdentityScopeStatus,
  freeze: FlowIdentityRecoveryFreeze,
): void {
  if (sha256Json(recoveryBaseline(status)) !== sha256Json(freeze.baseline)) {
    fail(
      'Live scope changed after recovery freeze; generate a fresh exact recovery approval.',
      'DATASET_FLOW_IDENTITY_RECOVERY_BASELINE_DRIFT',
    );
  }
}

export const __testInternals = {
  assertContext,
  assertRecoverableStatus,
  canonicalTimestamp,
  deterministicUuidFromSha256,
  readRecoveryScopeProof,
  recoveryBaseline,
  recoveryRequestCore,
};
