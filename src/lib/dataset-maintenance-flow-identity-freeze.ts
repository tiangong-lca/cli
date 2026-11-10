import path from 'node:path';
import {
  materializePrivateArtifactDirectoryAtomically,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import { computeFlowIdentityFreezeSha256 } from './maintenance/flow-identity/requests.js';
import { type FlowIdentityFreeze } from './maintenance/flow-identity/base.js';
import { parseFlowIdentityPlan } from './dataset-maintenance-flow-identity-contract.js';
import { parseProtectedToolchainEvidence } from './dataset-maintenance-protected-toolchain.js';
import { isJsonObject } from './maintenance/contract/values.js';
import { sha256Json, sha256Text, stableJsonText } from './canonical-json-hash.js';
import { CliError } from '../shared/errors.js';

export type FlowIdentityExecutionApprovalRequestCore = {
  schema_version: 'dataset-flow-identity-execution-approval-request.v3';
  approved_at_utc: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  plan_sha256: string;
  operation_id: string;
  plan_file_sha256: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
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
  capture_artifact_sha256: string;
  toolchain_evidence_sha256: string;
  policy_approval_text_sha256: string;
  semantic_source_count: 305;
  mapping_count: number;
  pending_count: number;
  blocker_count: number;
  orphan_count: number;
  process_count: number;
  rewrite_count: number;
  state_code_changes: 0;
  deletes: 0;
  source_mutations: 0;
  public_target_mutations: 0;
  user_state_claim: 'authenticated_actor_state_100_plus_own_state_0';
  approval_reusable: false;
  maximum_wrapper_invocations: 1;
  maximum_cli_apply_spawns: 1;
  maximum_process_posts: number;
  maximum_finalize_posts: 1;
  max_process_concurrency: 1;
  automatic_retry: false;
};

export type FlowIdentityApprovalRequest = FlowIdentityExecutionApprovalRequestCore & {
  request_sha256: string;
};

export type FreezeFlowIdentityOptions = {
  planPath: string;
  toolchainEvidencePath: string;
  expectedProjectRef: string;
  confirm: string;
  approvedAtUtc: string;
  cliVersion: string;
  outDir: string;
  now?: Date;
};

export type FlowIdentityFreezeReport = {
  schema_version: 'dataset-flow-identity-freeze-report.v2';
  generated_at_utc: string;
  status: 'frozen';
  execution_submitted: false;
  network_calls: 0;
  database_calls: 0;
  plan_sha256: string;
  operation_id: string;
  freeze_sha256: string;
  freeze_file_sha256: string;
  execution_approval_request_sha256: string;
  execution_approval_text_sha256: string;
  policy_approval_text_sha256: string;
  artifacts: {
    freeze: string;
    approval_request: string;
    approval_text: string;
    report: string;
  };
};

export const FLOW_IDENTITY_FREEZE_ARTIFACTS = {
  freeze: 'flow-identity-freeze.json',
  approval_request: 'flow-identity-execution-approval-request.json',
  approval_text: 'flow-identity-execution-approval-request.txt',
  report: 'flow-identity-freeze-report.json',
} as const;

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function fail(message: string, code = 'DATASET_FLOW_IDENTITY_FREEZE_INVALID'): never {
  throw new CliError(message, { code, exitCode: 1 });
}

function canonicalTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical RFC3339 UTC timestamp.`);
  }
  return value;
}

function requestCore(value: FlowIdentityApprovalRequest): FlowIdentityExecutionApprovalRequestCore {
  const core = { ...value } as Partial<FlowIdentityApprovalRequest>;
  delete core.request_sha256;
  return core as FlowIdentityExecutionApprovalRequestCore;
}

export function computeFlowIdentityApprovalRequestSha256(
  request: FlowIdentityApprovalRequest,
): string {
  return sha256Json(requestCore(request));
}

export function renderFlowIdentityExecutionApprovalText(
  core: FlowIdentityExecutionApprovalRequestCore,
  requestSha256: string,
): string {
  if (!HASH.test(requestSha256)) fail('execution approval request SHA-256 is invalid.');
  return [
    'BAFU Step 3 protected owner-draft execution approval request',
    `schema_version=${core.schema_version}`,
    `approved_at_utc=${core.approved_at_utc}`,
    `request_sha256=${requestSha256}`,
    `environment=${core.environment}`,
    `project_ref=${core.project_ref}`,
    `account_email=${core.actor.email}`,
    `account_user_id=${core.actor.user_id}`,
    `target_visibility=${core.target_visibility}`,
    `plan_sha256=${core.plan_sha256}`,
    `operation_id=${core.operation_id}`,
    `plan_file_sha256=${core.plan_file_sha256}`,
    `freeze_file_sha256=${core.freeze_file_sha256}`,
    `freeze_sha256=${core.freeze_sha256}`,
    `receipt_id=${core.receipt_id}`,
    `receipt_proof_sha256=${core.receipt_proof_sha256}`,
    `capture_request_sha256=${core.capture_request_sha256}`,
    `source_guard_set_sha256=${core.source_guard_set_sha256}`,
    `support_guard_set_sha256=${core.support_guard_set_sha256}`,
    `target_guard_set_sha256=${core.target_guard_set_sha256}`,
    `mapping_guard_set_sha256=${core.mapping_guard_set_sha256}`,
    `process_intent_set_sha256=${core.process_intent_set_sha256}`,
    `receipt_protected_closure_sha256=${core.receipt_protected_closure_sha256}`,
    `capture_whole_scope_proof_sha256=${core.capture_whole_scope_proof_sha256}`,
    `capture_artifact_sha256=${core.capture_artifact_sha256}`,
    `toolchain_evidence_sha256=${core.toolchain_evidence_sha256}`,
    `policy_approval_text_sha256=${core.policy_approval_text_sha256}`,
    `semantic_source_count=${core.semantic_source_count}`,
    `mapping_count=${core.mapping_count}`,
    `pending_count=${core.pending_count}`,
    `blocker_count=${core.blocker_count}`,
    `orphan_count=${core.orphan_count}`,
    `process_count=${core.process_count}`,
    `rewrite_count=${core.rewrite_count}`,
    `state_code_changes=${core.state_code_changes}`,
    `deletes=${core.deletes}`,
    `source_mutations=${core.source_mutations}`,
    `public_target_mutations=${core.public_target_mutations}`,
    `user_state_claim=${core.user_state_claim}`,
    `approval_reusable=${String(core.approval_reusable)}`,
    `maximum_wrapper_invocations=${core.maximum_wrapper_invocations}`,
    `maximum_cli_apply_spawns=${core.maximum_cli_apply_spawns}`,
    `maximum_process_posts=${core.maximum_process_posts}`,
    `maximum_finalize_posts=${core.maximum_finalize_posts}`,
    `max_process_concurrency=${core.max_process_concurrency}`,
    `automatic_retry=${String(core.automatic_retry)}`,
    'Approve only by returning this text byte-for-byte without edits.',
    '',
  ].join('\n');
}

export function parseFlowIdentityApprovalRequest(value: unknown): FlowIdentityApprovalRequest {
  if (!isJsonObject(value) || !isJsonObject(value.actor)) {
    fail('Flow identity execution approval request is invalid.');
  }
  const expectedKeys = [
    'schema_version',
    'approved_at_utc',
    'environment',
    'project_ref',
    'actor',
    'target_visibility',
    'plan_sha256',
    'operation_id',
    'plan_file_sha256',
    'freeze_file_sha256',
    'freeze_sha256',
    'receipt_id',
    'receipt_proof_sha256',
    'capture_request_sha256',
    'source_guard_set_sha256',
    'support_guard_set_sha256',
    'target_guard_set_sha256',
    'mapping_guard_set_sha256',
    'process_intent_set_sha256',
    'receipt_protected_closure_sha256',
    'capture_whole_scope_proof_sha256',
    'capture_artifact_sha256',
    'toolchain_evidence_sha256',
    'policy_approval_text_sha256',
    'semantic_source_count',
    'mapping_count',
    'pending_count',
    'blocker_count',
    'orphan_count',
    'process_count',
    'rewrite_count',
    'state_code_changes',
    'deletes',
    'source_mutations',
    'public_target_mutations',
    'user_state_claim',
    'approval_reusable',
    'maximum_wrapper_invocations',
    'maximum_cli_apply_spawns',
    'maximum_process_posts',
    'maximum_finalize_posts',
    'max_process_concurrency',
    'automatic_retry',
    'request_sha256',
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value))
  ) {
    fail('Flow identity execution approval request keys are not exact.');
  }
  const request = value as FlowIdentityApprovalRequest;
  const counts = [
    request.mapping_count,
    request.pending_count,
    request.blocker_count,
    request.orphan_count,
    request.process_count,
    request.rewrite_count,
  ];
  if (
    request.schema_version !== 'dataset-flow-identity-execution-approval-request.v3' ||
    request.environment !== 'production' ||
    request.target_visibility !== 'owner_draft' ||
    request.semantic_source_count !== 305 ||
    request.state_code_changes !== 0 ||
    request.deletes !== 0 ||
    request.source_mutations !== 0 ||
    request.public_target_mutations !== 0 ||
    request.user_state_claim !== 'authenticated_actor_state_100_plus_own_state_0' ||
    request.approval_reusable !== false ||
    request.maximum_wrapper_invocations !== 1 ||
    request.maximum_cli_apply_spawns !== 1 ||
    request.maximum_process_posts !== request.process_count ||
    request.maximum_finalize_posts !== 1 ||
    request.max_process_concurrency !== 1 ||
    request.automatic_retry !== false ||
    !counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    request.mapping_count <= 0 ||
    request.process_count <= 0 ||
    request.rewrite_count <= 0 ||
    request.mapping_count + request.pending_count + request.blocker_count + request.orphan_count !==
      305 ||
    !canonicalTimestamp(request.approved_at_utc, 'approved_at_utc') ||
    !UUID.test(request.actor.user_id) ||
    !UUID.test(request.receipt_id) ||
    request.actor.email !== request.actor.email.trim().toLowerCase() ||
    ![
      request.plan_sha256,
      request.plan_file_sha256,
      request.freeze_file_sha256,
      request.freeze_sha256,
      request.receipt_proof_sha256,
      request.capture_request_sha256,
      request.source_guard_set_sha256,
      request.support_guard_set_sha256,
      request.target_guard_set_sha256,
      request.mapping_guard_set_sha256,
      request.process_intent_set_sha256,
      request.receipt_protected_closure_sha256,
      request.capture_whole_scope_proof_sha256,
      request.capture_artifact_sha256,
      request.toolchain_evidence_sha256,
      request.policy_approval_text_sha256,
      request.request_sha256,
    ].every((digest) => HASH.test(digest)) ||
    request.request_sha256 !== computeFlowIdentityApprovalRequestSha256(request)
  ) {
    fail('Flow identity execution approval request is inconsistent or tampered.');
  }
  return request;
}

export function freezeFlowIdentity(options: FreezeFlowIdentityOptions): FlowIdentityFreezeReport {
  const planArtifact = readProtectedJsonArtifact({
    filePath: options.planPath,
    label: 'Flow identity plan',
  });
  if (planArtifact.text !== `${stableJsonText(planArtifact.value)}\n`) {
    fail('Flow identity plan must be canonical JSON.');
  }
  const plan = parseFlowIdentityPlan(planArtifact.value);
  if (
    plan.environment !== 'production' ||
    plan.project_ref !== options.expectedProjectRef ||
    plan.account.email !== options.confirm
  ) {
    fail('Freeze requires the exact production project and account confirmation.');
  }
  const toolchain = readProtectedJsonArtifact({
    filePath: options.toolchainEvidencePath,
    label: 'Protected toolchain evidence',
  });
  const toolchainEvidence = parseProtectedToolchainEvidence(toolchain.value, {
    projectRef: options.expectedProjectRef,
    cliVersion: options.cliVersion,
  });
  if (toolchain.text !== `${stableJsonText(toolchainEvidence)}\n`) {
    fail('Protected toolchain evidence must be canonical JSON.');
  }
  const generatedAt = (options.now ?? new Date()).toISOString();
  const approvedAt = canonicalTimestamp(options.approvedAtUtc, 'approvedAtUtc');
  if (Date.parse(approvedAt) < Date.parse(generatedAt)) {
    fail('approvedAtUtc must be frozen before the human review and cannot precede the freeze.');
  }
  const freeze: FlowIdentityFreeze = {
    schema_version: 'dataset-flow-identity-freeze.v2',
    generated_at_utc: generatedAt,
    environment: 'production',
    project_ref: plan.project_ref,
    actor: plan.account,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    capture_artifact_sha256: plan.capture_artifact_sha256,
    receipt_id: plan.receipt_id,
    receipt_proof_sha256: plan.receipt_proof_sha256,
    capture_request_sha256: plan.capture_request_sha256,
    source_guard_set_sha256: plan.source_guard_set_sha256,
    support_guard_set_sha256: plan.support_guard_set_sha256,
    target_guard_set_sha256: plan.target_guard_set_sha256,
    mapping_guard_set_sha256: plan.mapping_guard_set_sha256,
    process_intent_set_sha256: plan.process_intent_set_sha256,
    receipt_protected_closure_sha256: plan.receipt_protected_closure_sha256,
    capture_whole_scope_proof_sha256: plan.capture_whole_scope_proof_sha256,
    source_universe_artifact_sha256: plan.source_universe_artifact_sha256,
    support_snapshot_artifact_sha256: plan.support_snapshot_artifact_sha256,
    mapping_artifact_sha256: plan.mapping_artifact_sha256,
    process_manifest_artifact_sha256: plan.process_manifest_artifact_sha256,
    protected_closure_artifact_sha256: plan.protected_closure_artifact_sha256,
    policy_approval_text_sha256: plan.compatibility_policy.approval_text_sha256,
    toolchain_evidence_sha256: toolchain.file_sha256,
    freeze_sha256: '',
  };
  freeze.freeze_sha256 = computeFlowIdentityFreezeSha256(freeze);
  const freezeText = `${stableJsonText(freeze)}\n`;
  const freezeFileSha256 = sha256Text(freezeText);
  const core: FlowIdentityExecutionApprovalRequestCore = {
    schema_version: 'dataset-flow-identity-execution-approval-request.v3',
    approved_at_utc: approvedAt,
    environment: 'production',
    project_ref: plan.project_ref,
    actor: plan.account,
    target_visibility: 'owner_draft',
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    plan_file_sha256: planArtifact.file_sha256,
    freeze_file_sha256: freezeFileSha256,
    freeze_sha256: freeze.freeze_sha256,
    receipt_id: plan.receipt_id,
    receipt_proof_sha256: plan.receipt_proof_sha256,
    capture_request_sha256: plan.capture_request_sha256,
    source_guard_set_sha256: plan.source_guard_set_sha256,
    support_guard_set_sha256: plan.support_guard_set_sha256,
    target_guard_set_sha256: plan.target_guard_set_sha256,
    mapping_guard_set_sha256: plan.mapping_guard_set_sha256,
    process_intent_set_sha256: plan.process_intent_set_sha256,
    receipt_protected_closure_sha256: plan.receipt_protected_closure_sha256,
    capture_whole_scope_proof_sha256: plan.capture_whole_scope_proof_sha256,
    capture_artifact_sha256: plan.capture_artifact_sha256,
    toolchain_evidence_sha256: freeze.toolchain_evidence_sha256,
    policy_approval_text_sha256: plan.compatibility_policy.approval_text_sha256,
    semantic_source_count: 305,
    mapping_count: plan.mappings.length,
    pending_count: plan.protected_closure.pending.length,
    blocker_count: plan.protected_closure.blockers.length,
    orphan_count: plan.protected_closure.orphans.length,
    process_count: plan.processes.length,
    rewrite_count: plan.summary.rewrites,
    state_code_changes: 0,
    deletes: 0,
    source_mutations: 0,
    public_target_mutations: 0,
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: plan.processes.length,
    maximum_finalize_posts: 1,
    max_process_concurrency: 1,
    automatic_retry: false,
  };
  const request = parseFlowIdentityApprovalRequest({
    ...core,
    request_sha256: sha256Json(core),
  });
  const approvalText = renderFlowIdentityExecutionApprovalText(core, request.request_sha256);
  const approvalTextSha256 = sha256Text(approvalText);
  const outDir = path.resolve(options.outDir);
  const artifacts = Object.fromEntries(
    Object.entries(FLOW_IDENTITY_FREEZE_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(outDir, name),
    ]),
  ) as FlowIdentityFreezeReport['artifacts'];
  const report: FlowIdentityFreezeReport = {
    schema_version: 'dataset-flow-identity-freeze-report.v2',
    generated_at_utc: generatedAt,
    status: 'frozen',
    execution_submitted: false,
    network_calls: 0,
    database_calls: 0,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    freeze_sha256: freeze.freeze_sha256,
    freeze_file_sha256: freezeFileSha256,
    execution_approval_request_sha256: request.request_sha256,
    execution_approval_text_sha256: approvalTextSha256,
    policy_approval_text_sha256: plan.compatibility_policy.approval_text_sha256,
    artifacts,
  };
  materializePrivateArtifactDirectoryAtomically(outDir, (staging) => {
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_FREEZE_ARTIFACTS.freeze),
      freezeText,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_FREEZE_ARTIFACTS.approval_request),
      request,
    );
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_FREEZE_ARTIFACTS.approval_text),
      approvalText,
    );
    writePrivateImmutableJson(path.join(staging, FLOW_IDENTITY_FREEZE_ARTIFACTS.report), report);
  });
  return report;
}

export const __testInternals = { canonicalTimestamp, requestCore };
