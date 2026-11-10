import path from 'node:path';
import { buildAliasPlanRequest } from './dataset-maintenance-alias-request.js';
import {
  readProtectedJsonArtifact,
  materializePrivateArtifactDirectoryAtomically,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import {
  validateProtectedBeforeState,
  type ProtectedBeforeValidationResult,
} from './dataset-maintenance-protected-before.js';
import { parseMaintenancePlan } from './dataset-maintenance-contract.js';
import { sha256Json, sha256Text, stableJsonText } from './canonical-json-hash.js';
import { type DatasetMaintenancePlan } from './maintenance/contract/types.js';
import {
  PROTECTED_EXECUTION_COUNTS,
  type ProtectedDerivativeSnapshot,
} from './dataset-maintenance-protected-contract.js';
import {
  assertProtectedPreparationPlanSha256,
  assertProtectedProductionProjectRef,
  buildProtectedApprovalRequest,
  buildProtectedFreeze,
  deriveProtectedDerivativeSnapshotTargets,
} from './dataset-maintenance-protected-preparation.js';
import {
  fetchMaintenanceAccountRows,
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import {
  parseProtectedToolchainEvidence,
  type DatasetMaintenanceProtectedToolchainEvidence,
} from './dataset-maintenance-protected-toolchain.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';

export const PROTECTED_FREEZE_ARTIFACTS = {
  alias_plan_request: 'protected-alias-plan-request.json',
  derivative_baselines: 'protected-derivative-baselines.json',
  freeze: 'protected-execution-freeze.json',
  approval_request: 'protected-approval-request.json',
  approval_text: 'protected-approval-request.txt',
  report: 'protected-freeze-report.json',
} as const;

export type FreezeDatasetMaintenanceProtectedOptions = {
  planPath: string;
  toolchainEvidencePath: string;
  outDir: string;
  expectedProjectRef: string;
  confirm: string;
  cliVersion: string;
  pageSize?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
};

export type DatasetMaintenanceProtectedBaselineManifest = {
  schema_version: 'dataset-alias-derivative-baselines.v1';
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  plan: { plan_sha256: string; operation_id: string };
  target_count: 50;
  flow_count: 23;
  process_count: 27;
  derivative_baseline_set_sha256: string;
  derivative_snapshot_set_sha256: string;
  snapshots: ProtectedDerivativeSnapshot[];
};

export type DatasetMaintenanceProtectedFreezeReport = {
  schema_version: 'dataset-alias-protected-freeze-report.v1';
  generated_at_utc: string;
  status: 'ready_for_human_approval';
  remote_write_mode: 'read_only';
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  plan_sha256: string;
  operation_id: string;
  freeze_sha256: string;
  approval_request_sha256: string;
  approval_text_sha256: string;
  toolchain_evidence_sha256: string;
  derivative_baseline_set_sha256: string;
  derivative_snapshot_set_sha256: string;
  counts: typeof PROTECTED_EXECUTION_COUNTS;
  assertions: {
    account_census_complete: true;
    strict_before_state: true;
    projected_reference_closure: true;
    support_snapshots: 6;
    derivative_snapshots: 50;
    preflight_calls: 0;
    gate_calls: 0;
    admission_calls: 0;
    mutation_calls: 0;
    approval_artifacts: 0;
  };
  artifacts: {
    alias_plan_request: string;
    derivative_baselines: string;
    freeze: string;
    approval_request: string;
    approval_text: string;
    report: string;
  };
  artifact_sha256: {
    alias_plan_request: string;
    derivative_baselines: string;
    freeze: string;
    approval_request: string;
    approval_text: string;
    report: null;
  };
};

type FreezeProtectedDependencies = {
  readArtifact: typeof readProtectedJsonArtifact;
  parsePlan: typeof parseMaintenancePlan;
  buildAliasPlan: typeof buildAliasPlanRequest;
  resolveContext: typeof resolveMaintenanceRemoteContext;
  fetchAccountRows: typeof fetchMaintenanceAccountRows;
  parseToolchain: typeof parseProtectedToolchainEvidence;
  deriveTargets: typeof deriveProtectedDerivativeSnapshotTargets;
  validateBefore: typeof validateProtectedBeforeState;
  buildFreeze: typeof buildProtectedFreeze;
  buildApprovalRequest: typeof buildProtectedApprovalRequest;
  writeJson: typeof writePrivateImmutableJson;
  writeText: typeof writePrivateImmutableText;
  materializeArtifacts: typeof materializePrivateArtifactDirectoryAtomically;
};

const DEFAULT_FREEZE_DEPENDENCIES: FreezeProtectedDependencies = {
  readArtifact: readProtectedJsonArtifact,
  parsePlan: parseMaintenancePlan,
  buildAliasPlan: buildAliasPlanRequest,
  resolveContext: resolveMaintenanceRemoteContext,
  fetchAccountRows: fetchMaintenanceAccountRows,
  parseToolchain: parseProtectedToolchainEvidence,
  deriveTargets: deriveProtectedDerivativeSnapshotTargets,
  validateBefore: validateProtectedBeforeState,
  buildFreeze: buildProtectedFreeze,
  buildApprovalRequest: buildProtectedApprovalRequest,
  writeJson: writePrivateImmutableJson,
  writeText: writePrivateImmutableText,
  materializeArtifacts: materializePrivateArtifactDirectoryAtomically,
};

function requiredToken(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw new CliError(`${label} must be a non-empty canonical string.`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_INPUT_INVALID',
      exitCode: 2,
    });
  }
  return value;
}

function assertContext(options: {
  context: DatasetMaintenanceRemoteContext;
  plan: DatasetMaintenancePlan;
  expectedProjectRef: string;
  confirm: string;
}): { user_id: string; email: string } {
  const account = options.context.account;
  if (
    options.context.project_ref !== options.expectedProjectRef ||
    account.user_id !== options.plan.account.user_id ||
    account.email !== options.plan.account.email ||
    account.email !== options.confirm
  ) {
    throw new CliError(
      'Authenticated context does not match the explicitly confirmed production project and plan account.',
      {
        code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_CONTEXT_MISMATCH',
        exitCode: 1,
        details: {
          expected_project_ref: options.expectedProjectRef,
          observed_project_ref: options.context.project_ref,
          expected_user_id: options.plan.account.user_id,
          observed_user_id: account.user_id,
        },
      },
    );
  }
  return { user_id: account.user_id, email: account.email };
}

function assertCanonicalToolchainArtifact(options: {
  artifactText: string;
  evidence: DatasetMaintenanceProtectedToolchainEvidence;
}): void {
  if (options.artifactText !== `${stableJsonText(options.evidence)}\n`) {
    throw new CliError(
      'Toolchain evidence must be canonical JSON with exactly one final newline.',
      {
        code: 'DATASET_MAINTENANCE_PROTECTED_TOOLCHAIN_NONCANONICAL',
        exitCode: 2,
      },
    );
  }
}

function artifactPaths(outDir: string): DatasetMaintenanceProtectedFreezeReport['artifacts'] {
  const resolved = path.resolve(outDir);
  return Object.fromEntries(
    Object.entries(PROTECTED_FREEZE_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(resolved, name),
    ]),
  ) as DatasetMaintenanceProtectedFreezeReport['artifacts'];
}

function buildBaselineManifest(options: {
  context: DatasetMaintenanceRemoteContext;
  plan: DatasetMaintenancePlan;
  account: { user_id: string; email: string };
  validation: ProtectedBeforeValidationResult;
  derivativeBaselineSetSha256: string;
}): DatasetMaintenanceProtectedBaselineManifest {
  const snapshots = options.validation.derivative_snapshots;
  return {
    schema_version: 'dataset-alias-derivative-baselines.v1',
    environment: 'production',
    project_ref: options.context.project_ref,
    account: options.account,
    plan: {
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
    },
    target_count: 50,
    flow_count: 23,
    process_count: 27,
    derivative_baseline_set_sha256: options.derivativeBaselineSetSha256,
    derivative_snapshot_set_sha256: sha256Json(snapshots),
    snapshots,
  };
}

export async function freezeDatasetMaintenanceProtected(
  options: FreezeDatasetMaintenanceProtectedOptions,
  dependencies: FreezeProtectedDependencies = DEFAULT_FREEZE_DEPENDENCIES,
): Promise<DatasetMaintenanceProtectedFreezeReport> {
  const planPath = requiredToken(options.planPath, 'planPath');
  const toolchainEvidencePath = requiredToken(
    options.toolchainEvidencePath,
    'toolchainEvidencePath',
  );
  const outDir = requiredToken(options.outDir, 'outDir');
  const expectedProjectRef = requiredToken(options.expectedProjectRef, 'expectedProjectRef');
  assertProtectedProductionProjectRef(expectedProjectRef);
  const confirm = requiredToken(options.confirm, 'confirm');
  const cliVersion = requiredToken(options.cliVersion, 'cliVersion');
  const generatedAtUtc = (options.now ?? new Date()).toISOString();

  const planArtifact = dependencies.readArtifact({
    filePath: planPath,
    label: 'Protected maintenance plan',
  });
  const plan = dependencies.parsePlan(planArtifact.value);
  assertProtectedPreparationPlanSha256(plan.plan_sha256, 'plan.plan_sha256');
  const planDir = path.dirname(planArtifact.resolved);
  const aliasPlanRequest = dependencies.buildAliasPlan({ plan, planDir });

  const toolchainArtifact = dependencies.readArtifact({
    filePath: toolchainEvidencePath,
    label: 'Protected toolchain evidence',
  });
  const toolchainEvidence = dependencies.parseToolchain(toolchainArtifact.value, {
    projectRef: expectedProjectRef,
    cliVersion,
  });
  assertCanonicalToolchainArtifact({
    artifactText: toolchainArtifact.text,
    evidence: toolchainEvidence,
  });

  const context = await dependencies.resolveContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  const account = assertContext({ context, plan, expectedProjectRef, confirm });

  const current = await dependencies.fetchAccountRows({
    context,
    userId: account.user_id,
    pageSize: options.pageSize,
  });
  const derivativeTargets = dependencies.deriveTargets(plan, account);
  const validation = await dependencies.validateBefore({
    plan,
    planDir,
    actorUserId: account.user_id,
    currentRows: current.rows,
    completeness: current.completeness,
    context,
    derivativeMode: 'capture',
    derivativeTargets,
  });
  const builtFreeze = dependencies.buildFreeze({
    plan,
    planFileSha256: planArtifact.file_sha256,
    aliasPlanRequest,
    projectRef: context.project_ref,
    account,
    toolchainEvidenceSha256: toolchainArtifact.file_sha256,
    derivativeSnapshots: validation.derivative_snapshots,
  });
  const approvalRequest = dependencies.buildApprovalRequest({
    freeze: builtFreeze.value,
    freezeFileSha256: builtFreeze.file_sha256,
    approvedAtUtc: generatedAtUtc,
  });
  const baselineManifest = buildBaselineManifest({
    context,
    plan,
    account,
    validation,
    derivativeBaselineSetSha256: builtFreeze.value.sets.derivative_baseline_set_sha256,
  });
  const paths = artifactPaths(outDir);
  const aliasPlanText = `${stableJsonText(aliasPlanRequest)}\n`;
  const baselineText = `${stableJsonText(baselineManifest)}\n`;
  const report: DatasetMaintenanceProtectedFreezeReport = {
    schema_version: 'dataset-alias-protected-freeze-report.v1',
    generated_at_utc: generatedAtUtc,
    status: 'ready_for_human_approval',
    remote_write_mode: 'read_only',
    environment: 'production',
    project_ref: context.project_ref,
    account,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    freeze_sha256: builtFreeze.value.freeze_sha256,
    approval_request_sha256: approvalRequest.value.request_sha256,
    approval_text_sha256: approvalRequest.value.approval_text_sha256,
    toolchain_evidence_sha256: toolchainArtifact.file_sha256,
    derivative_baseline_set_sha256: builtFreeze.value.sets.derivative_baseline_set_sha256,
    derivative_snapshot_set_sha256: baselineManifest.derivative_snapshot_set_sha256,
    counts: PROTECTED_EXECUTION_COUNTS,
    assertions: {
      account_census_complete: true,
      strict_before_state: true,
      projected_reference_closure: true,
      support_snapshots: 6,
      derivative_snapshots: 50,
      preflight_calls: 0,
      gate_calls: 0,
      admission_calls: 0,
      mutation_calls: 0,
      approval_artifacts: 0,
    },
    artifacts: paths,
    artifact_sha256: {
      alias_plan_request: sha256Text(aliasPlanText),
      derivative_baselines: sha256Text(baselineText),
      freeze: builtFreeze.file_sha256,
      approval_request: approvalRequest.file_sha256,
      approval_text: approvalRequest.value.approval_text_sha256,
      report: null,
    },
  };

  dependencies.materializeArtifacts(outDir, (stagingDirectory) => {
    const staging = artifactPaths(stagingDirectory);
    dependencies.writeText(staging.alias_plan_request, aliasPlanText);
    dependencies.writeText(staging.derivative_baselines, baselineText);
    dependencies.writeText(staging.freeze, builtFreeze.canonical_file_text);
    dependencies.writeText(staging.approval_request, approvalRequest.canonical_file_text);
    dependencies.writeText(staging.approval_text, approvalRequest.value.approval_text);
    dependencies.writeJson(staging.report, report);
  });
  return report;
}

export const __testInternals = {
  artifactPaths,
  assertCanonicalToolchainArtifact,
  assertContext,
  buildBaselineManifest,
  DEFAULT_FREEZE_DEPENDENCIES,
  requiredToken,
};
