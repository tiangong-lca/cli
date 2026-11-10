import path from 'node:path';
import {
  materializePrivateArtifactDirectoryAtomically,
  readProtectedJsonArtifact,
  readProtectedTextArtifact,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import {
  computeFlowIdentityApprovalIdentitySha256,
  parseFlowIdentityFreeze,
} from './maintenance/flow-identity/requests.js';
import { type FlowIdentityApproval } from './maintenance/flow-identity/base.js';
import { parseFlowIdentityPlan } from './dataset-maintenance-flow-identity-contract.js';
import { sha256Text, stableJsonText } from './canonical-json-hash.js';
import {
  parseFlowIdentityApprovalRequest,
  renderFlowIdentityExecutionApprovalText,
  type FlowIdentityExecutionApprovalRequestCore,
} from './dataset-maintenance-flow-identity-freeze.js';
import { CliError } from '../shared/errors.js';

export type SealFlowIdentityApprovalOptions = {
  planPath: string;
  freezePath: string;
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

export type FlowIdentityApprovalSealReport = {
  schema_version: 'dataset-flow-identity-execution-approval-seal-report.v2';
  generated_at_utc: string;
  approval_authority_at_utc: string;
  status: 'sealed';
  execution_submitted: false;
  network_calls: 0;
  database_calls: 0;
  plan_sha256: string;
  operation_id: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  policy_approval_text_sha256: string;
  execution_approval_request_sha256: string;
  execution_approval_text_sha256: string;
  execution_approval_identity_sha256: string;
  artifacts: { human_approval: string; approval: string; report: string };
};

export const FLOW_IDENTITY_APPROVAL_ARTIFACTS = {
  human_approval: 'flow-identity-execution-human-approval.txt',
  approval: 'flow-identity-execution-approval.json',
  report: 'flow-identity-execution-approval-seal-report.json',
} as const;

const HASH = /^[a-f0-9]{64}$/u;

function fail(message: string, code = 'DATASET_FLOW_IDENTITY_APPROVAL_SEAL_INVALID'): never {
  throw new CliError(message, { code, exitCode: 1 });
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) fail(`${label} must be a lowercase SHA-256.`);
}

function requireDistinctApprovalHashDomains(hashes: readonly string[]): void {
  if (new Set(hashes).size !== hashes.length) {
    fail('Policy and execution approval hash domains must remain distinct.');
  }
}

function requireCanonicalJson(filePath: string, label: string) {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(`${label} must be canonical JSON with one trailing newline.`);
  }
  return artifact;
}

export function sealFlowIdentityApproval(
  options: SealFlowIdentityApprovalOptions,
): FlowIdentityApprovalSealReport {
  requireHash(options.approveFreezeFile, 'approveFreezeFile');
  requireHash(options.approveRequest, 'approveRequest');
  requireHash(options.approveText, 'approveText');
  if (!Number.isFinite(Date.parse(options.approvedAtUtc))) {
    fail('approvedAtUtc must be an RFC3339 timestamp.');
  }
  const planArtifact = requireCanonicalJson(options.planPath, 'Flow identity plan');
  const plan = parseFlowIdentityPlan(planArtifact.value);
  const freezeArtifact = requireCanonicalJson(options.freezePath, 'Flow identity freeze');
  const freeze = parseFlowIdentityFreeze(freezeArtifact.value, plan);
  const requestArtifact = requireCanonicalJson(
    options.approvalRequestPath,
    'Flow identity execution approval request',
  );
  const request = parseFlowIdentityApprovalRequest(requestArtifact.value);
  const core = { ...request } as Record<string, unknown>;
  delete core.request_sha256;
  const expectedText = renderFlowIdentityExecutionApprovalText(
    core as FlowIdentityExecutionApprovalRequestCore,
    request.request_sha256,
  );
  const humanApproval = readProtectedTextArtifact(options.humanApprovalPath);
  const humanApprovalSha256 = sha256Text(humanApproval.text);
  if (
    plan.environment !== 'production' ||
    options.confirm !== plan.account.email ||
    options.approveFreezeFile !== freezeArtifact.file_sha256 ||
    options.approveRequest !== request.request_sha256 ||
    options.approveText !== humanApprovalSha256 ||
    humanApproval.text !== expectedText ||
    options.approvedAtUtc !== request.approved_at_utc ||
    request.project_ref !== plan.project_ref ||
    request.actor.user_id !== plan.account.user_id ||
    request.actor.email !== plan.account.email ||
    request.plan_sha256 !== plan.plan_sha256 ||
    request.plan_file_sha256 !== planArtifact.file_sha256 ||
    request.operation_id !== plan.operation_id ||
    request.freeze_file_sha256 !== freezeArtifact.file_sha256 ||
    request.freeze_sha256 !== freeze.freeze_sha256 ||
    request.receipt_id !== plan.receipt_id ||
    request.receipt_proof_sha256 !== plan.receipt_proof_sha256 ||
    request.capture_request_sha256 !== plan.capture_request_sha256 ||
    request.source_guard_set_sha256 !== plan.source_guard_set_sha256 ||
    request.support_guard_set_sha256 !== plan.support_guard_set_sha256 ||
    request.target_guard_set_sha256 !== plan.target_guard_set_sha256 ||
    request.mapping_guard_set_sha256 !== plan.mapping_guard_set_sha256 ||
    request.process_intent_set_sha256 !== plan.process_intent_set_sha256 ||
    request.receipt_protected_closure_sha256 !== plan.receipt_protected_closure_sha256 ||
    request.capture_whole_scope_proof_sha256 !== plan.capture_whole_scope_proof_sha256 ||
    request.capture_artifact_sha256 !== plan.capture_artifact_sha256 ||
    request.toolchain_evidence_sha256 !== freeze.toolchain_evidence_sha256 ||
    request.policy_approval_text_sha256 !== plan.compatibility_policy.approval_text_sha256 ||
    request.semantic_source_count !== plan.summary.semantic_sources ||
    request.mapping_count !== plan.mappings.length ||
    request.pending_count !== plan.protected_closure.pending.length ||
    request.blocker_count !== plan.protected_closure.blockers.length ||
    request.orphan_count !== plan.protected_closure.orphans.length ||
    request.process_count !== plan.processes.length ||
    request.rewrite_count !== plan.summary.rewrites ||
    new Set([request.policy_approval_text_sha256, request.request_sha256, humanApprovalSha256])
      .size !== 3
  ) {
    fail('Human approval does not exactly bind this production execution request.');
  }
  const approval: FlowIdentityApproval = {
    schema_version: 'dataset-flow-identity-execution-approval.v2',
    approved_at_utc: request.approved_at_utc,
    actor: plan.account,
    plan_sha256: plan.plan_sha256,
    freeze_sha256: freeze.freeze_sha256,
    toolchain_evidence_sha256: freeze.toolchain_evidence_sha256,
    policy_approval_text_sha256: request.policy_approval_text_sha256,
    execution_approval_request_sha256: request.request_sha256,
    execution_approval_text_sha256: humanApprovalSha256,
    execution_approval_identity_sha256: '',
  };
  approval.execution_approval_identity_sha256 = computeFlowIdentityApprovalIdentitySha256(approval);
  requireDistinctApprovalHashDomains([
    approval.policy_approval_text_sha256,
    approval.execution_approval_request_sha256,
    approval.execution_approval_text_sha256,
    approval.execution_approval_identity_sha256,
  ]);
  const outDir = path.resolve(options.outDir);
  const artifacts = Object.fromEntries(
    Object.entries(FLOW_IDENTITY_APPROVAL_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(outDir, name),
    ]),
  ) as FlowIdentityApprovalSealReport['artifacts'];
  const report: FlowIdentityApprovalSealReport = {
    schema_version: 'dataset-flow-identity-execution-approval-seal-report.v2',
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    approval_authority_at_utc: request.approved_at_utc,
    status: 'sealed',
    execution_submitted: false,
    network_calls: 0,
    database_calls: 0,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    freeze_file_sha256: freezeArtifact.file_sha256,
    freeze_sha256: freeze.freeze_sha256,
    policy_approval_text_sha256: approval.policy_approval_text_sha256,
    execution_approval_request_sha256: approval.execution_approval_request_sha256,
    execution_approval_text_sha256: approval.execution_approval_text_sha256,
    execution_approval_identity_sha256: approval.execution_approval_identity_sha256,
    artifacts,
  };
  materializePrivateArtifactDirectoryAtomically(outDir, (staging) => {
    writePrivateImmutableText(
      path.join(staging, FLOW_IDENTITY_APPROVAL_ARTIFACTS.human_approval),
      humanApproval.text,
    );
    writePrivateImmutableJson(
      path.join(staging, FLOW_IDENTITY_APPROVAL_ARTIFACTS.approval),
      approval,
    );
    writePrivateImmutableJson(path.join(staging, FLOW_IDENTITY_APPROVAL_ARTIFACTS.report), report);
  });
  return report;
}

export const __testInternals = {
  requireCanonicalJson,
  requireDistinctApprovalHashDomains,
  requireHash,
};
