import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
} from '../../dataset-maintenance-protected-artifacts.js';
import { prepareFlowIdentityExecution } from '../../dataset-maintenance-flow-identity-execution-contract.js';
import type { FlowIdentityExecutionIdentity } from './base.js';
import { prepareFlowIdentityRecoveryExecution } from '../../dataset-maintenance-flow-identity-recovery.js';
import { isJsonObject } from '../contract/values.js';
import { sha256Json, stableJsonText } from '../../canonical-json-hash.js';
import type { FlowIdentityPlan } from '../../dataset-maintenance-flow-identity-contract.js';
import type { DatasetMaintenanceRemoteContext } from '../../dataset-maintenance-remote.js';
import {
  readFlowIdentityApprovalClaim,
  type FlowIdentityApprovalClaim,
} from '../../dataset-maintenance-flow-identity-approval-claim.js';
import {
  type RunFlowIdentityOptions,
  type ProcessTemplate,
  type PreparedRun,
  fail,
} from './run-types.js';

export function readCanonicalJson(filePath: string, label: string): unknown {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(
      `${label} must be canonical JSON with exactly one trailing newline.`,
      'DATASET_FLOW_IDENTITY_ARTIFACT_NONCANONICAL',
    );
  }
  return artifact.value;
}

export function processStem(ordinal: number, id: string, version: string): string {
  return `${String(ordinal).padStart(6, '0')}-${id}-${version}`;
}

export function loadProcessTemplates(planPath: string, plan: FlowIdentityPlan): ProcessTemplate[] {
  const planDir = path.dirname(planPath);
  return plan.processes.map((process) => {
    const filePath = path.join(
      planDir,
      plan.artifacts.process_request_dir,
      `${processStem(process.ordinal, process.id, process.version)}.json`,
    );
    const value = readCanonicalJson(filePath, `Flow identity process template ${process.ordinal}`);
    if (
      !isJsonObject(value) ||
      !isJsonObject(value.process) ||
      !Array.isArray(value.rewrites) ||
      !isJsonObject(value.collision_ledger) ||
      sha256Json(value.process) !== sha256Json(process) ||
      sha256Json(value.rewrites) !== process.rewrite_set_sha256 ||
      sha256Json(value.collision_ledger) !== process.collision_ledger_sha256 ||
      value.rewrites.length !== process.rewrite_count
    ) {
      fail(
        `Process template ${process.ordinal} does not bind the sealed manifest.`,
        'DATASET_FLOW_IDENTITY_PROCESS_TEMPLATE_INVALID',
      );
    }
    return value as unknown as ProcessTemplate;
  });
}

export function readRecoveryInputScope(options: {
  runDir: string;
  recoveryFreezePath: string;
  plan: FlowIdentityPlan;
  identity: FlowIdentityExecutionIdentity;
}): unknown {
  const candidates = [
    path.join(path.resolve(options.runDir), 'scope-preflight-proof.json'),
    path.join(path.resolve(options.runDir), 'scope-lookup-proof.json'),
    path.join(
      path.dirname(path.resolve(options.recoveryFreezePath)),
      'flow-identity-recovery-scope-proof.json',
    ),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(
      'Recovery run requires an exact preflight or read-only lookup scope proof.',
      'DATASET_FLOW_IDENTITY_SCOPE_PROOF_REQUIRED',
    );
  }
  return readCanonicalJson(found, 'Flow identity recovery scope proof');
}

export function prepareRun(options: RunFlowIdentityOptions): PreparedRun {
  if (options.commit === options.statusOnly) {
    fail('Choose exactly one of commit or statusOnly.', 'DATASET_FLOW_IDENTITY_RUN_MODE_INVALID');
  }
  const planPath = path.resolve(options.planPath);
  const prepared = prepareFlowIdentityExecution({
    plan: readCanonicalJson(planPath, 'Flow identity plan'),
    freeze: readCanonicalJson(options.freezePath, 'Flow identity freeze'),
    approval: readCanonicalJson(options.approvalPath, 'Flow identity approval'),
  });
  const recoveryPathCount = [
    options.recoveryFreezePath,
    options.recoveryApprovalPath,
    options.recoveryRunDir,
  ].filter(Boolean).length;
  if (recoveryPathCount !== 0 && recoveryPathCount !== 3) {
    fail(
      'Recovery run requires recoveryFreezePath, recoveryApprovalPath, and recoveryRunDir together.',
      'DATASET_FLOW_IDENTITY_RECOVERY_ARGUMENTS_INVALID',
    );
  }
  const recovery =
    recoveryPathCount === 3
      ? prepareFlowIdentityRecoveryExecution({
          plan: readCanonicalJson(planPath, 'Flow identity recovery plan'),
          originalFreeze: readCanonicalJson(
            options.freezePath,
            'Flow identity recovery original freeze',
          ),
          originalApproval: readCanonicalJson(
            options.approvalPath,
            'Flow identity recovery original approval',
          ),
          scope: readRecoveryInputScope({
            runDir: options.recoveryRunDir!,
            recoveryFreezePath: options.recoveryFreezePath!,
            plan: prepared.plan,
            identity: prepared.identity,
          }),
          recoveryFreeze: readCanonicalJson(
            options.recoveryFreezePath!,
            'Flow identity recovery freeze',
          ),
          recoveryApproval: readCanonicalJson(
            options.recoveryApprovalPath!,
            'Flow identity recovery approval',
          ),
        })
      : null;
  if (options.commit) {
    const expectedApprovalIdentity =
      recovery?.recoveryApproval.recovery_approval_identity_sha256 ??
      prepared.identity.identity_sha256;
    if (
      options.approveExecution !== expectedApprovalIdentity ||
      options.confirm !== prepared.plan.account.email
    ) {
      fail(
        'Commit requires the exact execution identity hash and frozen account email.',
        'DATASET_FLOW_IDENTITY_EXECUTION_APPROVAL_REQUIRED',
      );
    }
  }
  let outDir = path.resolve(options.outDir);
  let approvalClaim: FlowIdentityApprovalClaim | null = null;
  if (options.statusOnly && recovery === null) {
    const claim = readFlowIdentityApprovalClaim({
      approvalIdentitySha256: prepared.approval.execution_approval_identity_sha256,
      env: options.env,
    });
    if (claim) {
      approvalClaim = claim;
      if (
        claim.approval_kind !== 'initial' ||
        claim.execution_identity_sha256 !== prepared.identity.identity_sha256 ||
        claim.request_id !== prepared.identity.request_id ||
        claim.project_ref !== prepared.plan.project_ref ||
        claim.actor_user_id !== prepared.plan.account.user_id ||
        claim.actor_email !== prepared.plan.account.email ||
        claim.plan_sha256 !== prepared.plan.plan_sha256 ||
        claim.freeze_sha256 !== prepared.freeze.freeze_sha256
      ) {
        fail(
          'Local approval claim does not bind this immutable execution.',
          'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
        );
      }
      outDir = path.resolve(claim.canonical_out_dir);
      if (!existsSync(outDir)) {
        fail(
          'Local approval claim points to a missing canonical run directory.',
          'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
        );
      }
    }
  }
  outDir = ensurePrivateArtifactDirectory(outDir);
  return {
    ...prepared,
    planPath,
    outDir,
    templates: loadProcessTemplates(planPath, prepared.plan),
    recovery,
    approvalClaim,
  };
}

export function assertContext(
  prepared: PreparedRun,
  context: DatasetMaintenanceRemoteContext,
): void {
  if (
    context.project_ref !== prepared.plan.project_ref ||
    context.account.user_id !== prepared.plan.account.user_id ||
    context.account.email.trim().toLowerCase() !== prepared.plan.account.email
  ) {
    fail(
      'Authenticated production RLS context does not match the sealed plan.',
      'DATASET_FLOW_IDENTITY_CONTEXT_MISMATCH',
      {
        expected_project_ref: prepared.plan.project_ref,
        observed_project_ref: context.project_ref,
        expected_user_id: prepared.plan.account.user_id,
        observed_user_id: context.account.user_id,
      },
    );
  }
}
