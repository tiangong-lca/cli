import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildAliasPlanRequest } from './dataset-maintenance-alias-request.js';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import {
  assertDerivativeBaselines as assertSharedDerivativeBaselines,
  assertStrictBeforeState as assertSharedStrictBeforeState,
  assertSupportSnapshots as assertSharedSupportSnapshots,
  projectedRows as sharedProjectedRows,
} from './dataset-maintenance-protected-before.js';
import { isJsonObject } from './maintenance/contract/values.js';
import { parseMaintenancePlan } from './dataset-maintenance-contract.js';
import { sha256Json, sha256Text, stableJsonText } from './canonical-json-hash.js';
import { readJsonFile } from './maintenance/contract/files.js';
import {
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from './maintenance/contract/types.js';
import {
  PROTECTED_EXECUTION_CONTRACT,
  assertProtectedApprovalBindings,
  assertProtectedFreezeMatchesPlan,
  buildProtectedAdmitRequest,
  buildProtectedExecutionIdentity,
  buildProtectedPreflightRequest,
  parseProtectedAdmissionProof,
  parseProtectedApproval,
  parseProtectedFreeze,
  parseProtectedGateProof,
  parseProtectedPreflightProof,
  parseProtectedStatusProof,
  type DatasetMaintenanceProtectedApproval,
  type DatasetMaintenanceProtectedFreeze,
  type ProtectedAdmissionProof,
  type ProtectedExecutionIdentity,
  type ProtectedExecutionStatusProof,
  type ProtectedGateProof,
  type ProtectedPreflightProof,
  type ProtectedReportStatus,
} from './dataset-maintenance-protected-contract.js';
import {
  assertProtectedPreparationPlanSha256,
  assertProtectedProductionProjectRef,
} from './dataset-maintenance-protected-preparation.js';
import {
  verifyProtectedExecution,
  type ProtectedVerificationResult,
} from './dataset-maintenance-protected-verify.js';
import { maintenanceProjectedReferenceFingerprint } from './dataset-maintenance-plan.js';
import {
  admitMaintenanceAliasExecution,
  captureMaintenanceAliasExecutionGate,
  fetchMaintenanceAccountRows,
  normalizeMaintenancePageSize,
  preflightMaintenanceAliasExecution,
  readMaintenanceAliasExecution,
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';
import { withStateFileLock } from './state-lock.js';

export type RunDatasetMaintenanceProtectedOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  approveExecution?: string;
  confirm?: string;
  waitSeconds?: number;
  pollMs?: number;
  pageSize?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

export type DatasetMaintenanceProtectedReport = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.report_schema;
  generated_at_utc: string;
  mode: 'commit' | 'status_only';
  status: ProtectedReportStatus;
  request_id: string;
  identity_sha256: string;
  plan_sha256: string;
  operation_id: string;
  actor: { user_id: string; email: string };
  project_ref: string;
  admission: ProtectedAdmissionProof | null;
  database_status: ProtectedExecutionStatusProof | null;
  issues: Array<{ code: string; message: string; details?: unknown }>;
  artifacts: {
    execution_seal: string;
    preflight_evidence: string;
    gate_receipts: string;
    submission_attempt: string;
    admission_response: string;
    admission_transport_error: string;
    status_progress: string;
    primary_readback: string;
    reference_readback: string;
    audit_readback: string;
    derivative_readback: string;
    terminal_report: string;
    attempt_report: string;
  };
};

type PreparedProtectedExecution = {
  planPath: string;
  planDir: string;
  freezePath: string;
  approvalPath: string;
  outDir: string;
  plan: DatasetMaintenancePlan;
  freeze: DatasetMaintenanceProtectedFreeze;
  approval: DatasetMaintenanceProtectedApproval;
  identity: ProtectedExecutionIdentity;
  aliasPlanRequest: JsonObject;
  artifacts: DatasetMaintenanceProtectedReport['artifacts'];
};

const DEFAULT_POLL_MS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/u;

function normalizeWaitSeconds(value?: number): number {
  const normalized = value ?? 0;
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 86_400) {
    throw new CliError('waitSeconds must be an integer between 0 and 86400.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_WAIT_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

function normalizePollMs(value?: number): number {
  const normalized = value ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(normalized) || normalized < 100 || normalized > 60_000) {
    throw new CliError('pollMs must be an integer between 100 and 60000.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_POLL_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

function clock(options: RunDatasetMaintenanceProtectedOptions): Date {
  return options.now ?? new Date();
}

function errorDetails(error: unknown): { name: string; message: string; code: string | null } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    code:
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null,
  };
}

function readArtifact(options: { filePath: string; label: string }): {
  resolved: string;
  value: unknown;
  text: string;
  file_sha256: string;
} {
  const artifact = readProtectedJsonArtifact(options);
  return {
    resolved: artifact.resolved,
    value: artifact.value,
    text: artifact.text,
    file_sha256: artifact.file_sha256,
  };
}

function assertCanonicalParsedArtifact(options: {
  label: string;
  text: string;
  value: unknown;
}): void {
  if (options.text !== `${stableJsonText(options.value)}\n`) {
    throw new CliError(`${options.label} must be canonical JSON with exactly one final newline.`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_ARTIFACT_NONCANONICAL',
      exitCode: 2,
    });
  }
}

function ensurePrivateDirectory(directory: string): void {
  ensurePrivateArtifactDirectory(directory);
}

function appendPrivateJsonLine(filePath: string, value: unknown): string {
  const resolved = path.resolve(filePath);
  ensurePrivateDirectory(path.dirname(resolved));
  appendFileSync(resolved, `${stableJsonText(value)}\n`, {
    encoding: 'utf8',
    flag: 'a',
    mode: 0o600,
  });
  chmodSync(resolved, 0o600);
  return resolved;
}

function nextAttemptReportPath(outDir: string): string {
  let attempt = 1;
  while (attemptArtifactPaths(outDir, attempt).some((filePath) => existsSync(filePath))) {
    attempt += 1;
  }
  return attemptArtifactPaths(outDir, attempt)[0]!;
}

function attemptArtifactPaths(outDir: string, attempt: number): string[] {
  const suffix = `attempt-${String(attempt).padStart(4, '0')}`;
  return [
    path.join(outDir, `protected-run-report.${suffix}.json`),
    path.join(outDir, `protected-audit-readback.${suffix}.json`),
    path.join(outDir, `protected-primary-readback.${suffix}.json`),
    path.join(outDir, `protected-reference-readback.${suffix}.json`),
    path.join(outDir, `protected-derivative-readback.${suffix}.json`),
  ];
}

function allocateAttemptArtifacts(
  prepared: PreparedProtectedExecution,
): PreparedProtectedExecution {
  const attemptReport = nextAttemptReportPath(prepared.outDir);
  const suffix = path.basename(attemptReport, '.json').replace('protected-run-report.', '');
  return {
    ...prepared,
    artifacts: {
      ...prepared.artifacts,
      audit_readback: path.join(prepared.outDir, `protected-audit-readback.${suffix}.json`),
      primary_readback: path.join(prepared.outDir, `protected-primary-readback.${suffix}.json`),
      reference_readback: path.join(prepared.outDir, `protected-reference-readback.${suffix}.json`),
      derivative_readback: path.join(
        prepared.outDir,
        `protected-derivative-readback.${suffix}.json`,
      ),
      attempt_report: attemptReport,
    },
  };
}

type ProtectedPreparationDependencies = {
  readArtifact: typeof readArtifact;
  parsePlan: typeof parseMaintenancePlan;
  buildAliasPlan: typeof buildAliasPlanRequest;
  parseFreeze: typeof parseProtectedFreeze;
  parseApproval: typeof parseProtectedApproval;
  assertFreezeMatchesPlan: typeof assertProtectedFreezeMatchesPlan;
  assertApprovalBindings: typeof assertProtectedApprovalBindings;
  buildIdentity: typeof buildProtectedExecutionIdentity;
};

function prepareProtectedExecutionWithDependencies(
  options: RunDatasetMaintenanceProtectedOptions,
  dependencies: ProtectedPreparationDependencies,
): PreparedProtectedExecution {
  if (options.commit === options.statusOnly) {
    throw new CliError('Choose exactly one of commit or statusOnly.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_MODE_INVALID',
      exitCode: 2,
    });
  }
  if (
    options.commit &&
    (!options.approveExecution ||
      !SHA256.test(options.approveExecution) ||
      typeof options.confirm !== 'string' ||
      !options.confirm.trim())
  ) {
    throw new CliError('Protected commit requires the exact approval hash and account email.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_REQUIRED',
      exitCode: 2,
    });
  }
  normalizeWaitSeconds(options.waitSeconds);
  normalizePollMs(options.pollMs);
  normalizeMaintenancePageSize(options.pageSize);

  const planArtifact = dependencies.readArtifact({
    filePath: options.planPath,
    label: 'Maintenance plan',
  });
  const freezeArtifact = dependencies.readArtifact({
    filePath: options.freezePath,
    label: 'Protected execution freeze',
  });
  const approvalArtifact = dependencies.readArtifact({
    filePath: options.approvalPath,
    label: 'Protected execution approval',
  });
  const plan = dependencies.parsePlan(planArtifact.value);
  if (options.commit) {
    assertProtectedPreparationPlanSha256(plan.plan_sha256, 'plan.plan_sha256');
  }
  const planPath = planArtifact.resolved;
  const planDir = path.dirname(planPath);
  const aliasPlanRequest = dependencies.buildAliasPlan({ plan, planDir });
  const freeze = dependencies.parseFreeze(freezeArtifact.value);
  const approval = dependencies.parseApproval(approvalArtifact.value);
  assertCanonicalParsedArtifact({
    label: 'Protected execution freeze',
    text: freezeArtifact.text,
    value: freeze,
  });
  assertCanonicalParsedArtifact({
    label: 'Protected execution approval',
    text: approvalArtifact.text,
    value: approval,
  });
  dependencies.assertFreezeMatchesPlan({
    plan,
    planFileSha256: planArtifact.file_sha256,
    aliasPlanRequestSha256: sha256Json(aliasPlanRequest),
    freeze,
  });
  dependencies.assertApprovalBindings({
    approval,
    freeze,
    freezeFileSha256: freezeArtifact.file_sha256,
    approvalFileSha256: approvalArtifact.file_sha256,
    approveExecution: options.statusOnly
      ? approval.approval_identity_sha256
      : options.approveExecution,
  });
  const identity = dependencies.buildIdentity({
    freeze,
    approval,
    freezeFileSha256: freezeArtifact.file_sha256,
    approvalFileSha256: approvalArtifact.file_sha256,
  });
  if (options.commit) {
    assertProtectedProductionProjectRef(identity.project_ref);
  }
  const outDir = path.resolve(options.outDir);
  const artifacts = {
    execution_seal: path.join(outDir, 'protected-execution-seal.json'),
    preflight_evidence: path.join(outDir, 'protected-preflight-evidence.json'),
    gate_receipts: path.join(outDir, 'protected-gate-receipts.jsonl'),
    submission_attempt: path.join(outDir, 'protected-submission-attempt.json'),
    admission_response: path.join(outDir, 'protected-admission-response.json'),
    admission_transport_error: path.join(outDir, 'protected-admission-transport-error.json'),
    status_progress: path.join(outDir, 'protected-status-progress.jsonl'),
    primary_readback: path.join(outDir, 'protected-primary-readback.json'),
    reference_readback: path.join(outDir, 'protected-reference-readback.json'),
    audit_readback: path.join(outDir, 'protected-audit-readback.json'),
    derivative_readback: path.join(outDir, 'protected-derivative-readback.json'),
    terminal_report: path.join(outDir, 'protected-terminal-report.json'),
    attempt_report: path.join(outDir, 'protected-run-report.unallocated.json'),
  };
  return {
    planPath,
    planDir,
    freezePath: freezeArtifact.resolved,
    approvalPath: approvalArtifact.resolved,
    outDir,
    plan,
    freeze,
    approval,
    identity,
    aliasPlanRequest,
    artifacts,
  };
}

function prepareProtectedExecution(
  options: RunDatasetMaintenanceProtectedOptions,
): PreparedProtectedExecution {
  return prepareProtectedExecutionWithDependencies(options, {
    readArtifact,
    parsePlan: parseMaintenancePlan,
    buildAliasPlan: buildAliasPlanRequest,
    parseFreeze: parseProtectedFreeze,
    parseApproval: parseProtectedApproval,
    assertFreezeMatchesPlan: assertProtectedFreezeMatchesPlan,
    assertApprovalBindings: assertProtectedApprovalBindings,
    buildIdentity: buildProtectedExecutionIdentity,
  });
}

function assertContextBindings(options: {
  prepared: PreparedProtectedExecution;
  context: DatasetMaintenanceRemoteContext;
  confirm?: string;
  commit: boolean;
}): void {
  if (
    options.context.project_ref !== options.prepared.identity.project_ref ||
    options.context.account.user_id !== options.prepared.identity.actor.user_id ||
    options.context.account.email !== options.prepared.identity.actor.email ||
    (options.commit && options.confirm !== options.context.account.email)
  ) {
    throw new CliError(
      'Authenticated RLS context does not match the sealed production project, actor, and confirmation.',
      {
        code: 'DATASET_MAINTENANCE_PROTECTED_CONTEXT_MISMATCH',
        exitCode: 1,
        details: {
          expected_project_ref: options.prepared.identity.project_ref,
          observed_project_ref: options.context.project_ref,
          expected_user_id: options.prepared.identity.actor.user_id,
          observed_user_id: options.context.account.user_id,
        },
      },
    );
  }
}

function projectedRows(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  currentRows: DatasetMaintenanceRemoteRow[];
}): DatasetMaintenanceRemoteRow[] {
  return sharedProjectedRows(options);
}

function assertStrictBeforeState(options: {
  prepared: PreparedProtectedExecution;
  currentRows: DatasetMaintenanceRemoteRow[];
  completeness: unknown;
}): void {
  assertSharedStrictBeforeState({
    plan: options.prepared.plan,
    planDir: options.prepared.planDir,
    actorUserId: options.prepared.identity.actor.user_id,
    currentRows: options.currentRows,
    completeness: options.completeness,
  });
}

async function assertSupportSnapshots(options: {
  prepared: PreparedProtectedExecution;
  context: DatasetMaintenanceRemoteContext;
}): Promise<void> {
  await assertSharedSupportSnapshots({
    plan: options.prepared.plan,
    actorUserId: options.prepared.identity.actor.user_id,
    context: options.context,
  });
}

async function assertDerivativeBaselines(options: {
  prepared: PreparedProtectedExecution;
  context: DatasetMaintenanceRemoteContext;
}): Promise<void> {
  await assertSharedDerivativeBaselines({
    actorUserId: options.prepared.identity.actor.user_id,
    context: options.context,
    derivativeTargets: options.prepared.identity.derivative_targets,
  });
}

type ProtectedGateDependencies = {
  captureGate: typeof captureMaintenanceAliasExecutionGate;
  parseGate: typeof parseProtectedGateProof;
  appendReceipt: typeof appendPrivateJsonLine;
  nowIso: () => string;
};

async function captureProtectedGatesWithDependencies(
  options: {
    prepared: PreparedProtectedExecution;
    context: DatasetMaintenanceRemoteContext;
    preflight: ProtectedPreflightProof;
    receiptPath: string;
  },
  dependencies: ProtectedGateDependencies,
): Promise<{
  proofs: ProtectedGateProof[];
  results: {
    primary_support_plan: ProtectedGateProof['result'];
    execution_unused: ProtectedGateProof['result'];
    derivative_quiescence: ProtectedGateProof['result'];
  };
}> {
  const gateNames = ['primary_support_plan', 'execution_unused', 'derivative_quiescence'] as const;
  const proofs: ProtectedGateProof[] = [];
  for (const gate of gateNames) {
    const raw = await dependencies.captureGate({
      context: options.context,
      requestId: options.prepared.identity.request_id,
      preflightToken: options.preflight.preflight_token,
      gateName: gate,
    });
    const proof = dependencies.parseGate(raw, {
      identity: options.prepared.identity,
      preflight: options.preflight,
      gate,
    });
    dependencies.appendReceipt(options.receiptPath, {
      observed_at_utc: dependencies.nowIso(),
      proof,
      raw_response_sha256: sha256Json(raw),
    });
    proofs.push(proof);
  }
  return {
    proofs,
    results: {
      primary_support_plan: proofs[0]!.result,
      execution_unused: proofs[1]!.result,
      derivative_quiescence: proofs[2]!.result,
    },
  };
}

async function captureProtectedGates(options: {
  prepared: PreparedProtectedExecution;
  context: DatasetMaintenanceRemoteContext;
  preflight: ProtectedPreflightProof;
  receiptPath: string;
}): Promise<{
  proofs: ProtectedGateProof[];
  results: {
    primary_support_plan: ProtectedGateProof['result'];
    execution_unused: ProtectedGateProof['result'];
    derivative_quiescence: ProtectedGateProof['result'];
  };
}> {
  return captureProtectedGatesWithDependencies(options, {
    captureGate: captureMaintenanceAliasExecutionGate,
    parseGate: parseProtectedGateProof,
    appendReceipt: appendPrivateJsonLine,
    nowIso: () => new Date().toISOString(),
  });
}

function validateExistingMarker(
  markerPath: string,
  identity: ProtectedExecutionIdentity,
): JsonObject | null {
  if (!existsSync(markerPath)) return null;
  const marker = readJsonFile(markerPath, 'Protected submission attempt');
  if (
    !isJsonObject(marker) ||
    marker.schema_version !== PROTECTED_EXECUTION_CONTRACT.marker_schema ||
    marker.request_id !== identity.request_id ||
    marker.identity_sha256 !== identity.identity_sha256 ||
    marker.plan_sha256 !== identity.plan_sha256 ||
    marker.operation_id !== identity.operation_id ||
    marker.max_admit_posts !== 1 ||
    marker.automatic_retry !== false
  ) {
    throw new CliError('Existing protected submission marker is foreign or malformed.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_MARKER_INVALID',
      exitCode: 1,
    });
  }
  return marker;
}

type ProtectedReadDependencies = {
  readExecution: typeof readMaintenanceAliasExecution;
  parseStatus: typeof parseProtectedStatusProof;
  verifyExecution: typeof verifyProtectedExecution;
  nowMs: () => number;
};

async function readAndVerifyWithDependencies(
  options: {
    command: RunDatasetMaintenanceProtectedOptions;
    prepared: PreparedProtectedExecution;
    context: DatasetMaintenanceRemoteContext;
  },
  dependencies: ProtectedReadDependencies,
): Promise<{
  proof: ProtectedExecutionStatusProof | null;
  verification: ProtectedVerificationResult;
}> {
  const waitSeconds = normalizeWaitSeconds(options.command.waitSeconds);
  const pollMs = normalizePollMs(options.command.pollMs);
  const deadline = dependencies.nowMs() + waitSeconds * 1_000;
  const sleep =
    options.command.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (true) {
    let raw: JsonObject;
    try {
      raw = await dependencies.readExecution({
        context: options.context,
        requestId: options.prepared.identity.request_id,
      });
    } catch (error) {
      appendPrivateJsonLine(options.prepared.artifacts.status_progress, {
        observed_at_utc: new Date().toISOString(),
        result: 'read_error',
        retry_scope: 'status_read_only',
        error: errorDetails(error),
      });
      if (dependencies.nowMs() < deadline) {
        await sleep(Math.min(pollMs, Math.max(deadline - dependencies.nowMs(), 0)));
        continue;
      }
      return {
        proof: null,
        verification: {
          status: 'indeterminate',
          issues: [
            {
              code: 'PROTECTED_STATUS_READ_UNAVAILABLE',
              message:
                'Protected execution status could not be read; admission must not be retried.',
              details: errorDetails(error),
            },
          ],
          account_readback: null,
          derivative_readback: null,
        },
      };
    }
    const proof = dependencies.parseStatus(raw, options.prepared.identity);
    appendPrivateJsonLine(options.prepared.artifacts.status_progress, {
      observed_at_utc: new Date().toISOString(),
      proof,
      raw_response_sha256: sha256Json(raw),
    });
    const waitForAdmissionVisibility =
      proof.execution_status === 'not_admitted' && dependencies.nowMs() < deadline;
    if (
      (proof.status !== 'pending' && !waitForAdmissionVisibility) ||
      dependencies.nowMs() >= deadline
    ) {
      try {
        return {
          proof,
          verification: await dependencies.verifyExecution({
            plan: options.prepared.plan,
            planDir: options.prepared.planDir,
            identity: options.prepared.identity,
            proof,
            context: options.context,
            pageSize: options.command.pageSize,
          }),
        };
      } catch (error) {
        appendPrivateJsonLine(options.prepared.artifacts.status_progress, {
          observed_at_utc: new Date().toISOString(),
          result: 'verification_error',
          retry_scope: 'independent_readback_only',
          request_id: proof.request_id,
          error: errorDetails(error),
        });
        if (dependencies.nowMs() < deadline) {
          await sleep(Math.min(pollMs, Math.max(deadline - dependencies.nowMs(), 0)));
          continue;
        }
        return {
          proof,
          verification: {
            status: 'indeterminate',
            issues: [
              {
                code: 'PROTECTED_TERMINAL_READBACK_UNAVAILABLE',
                message:
                  'Terminal proof was returned but independent RLS readback was unavailable.',
                details: errorDetails(error),
              },
            ],
            account_readback: null,
            derivative_readback: null,
          },
        };
      }
    }
    await sleep(Math.min(pollMs, Math.max(deadline - dependencies.nowMs(), 0)));
  }
}

async function readAndVerify(options: {
  command: RunDatasetMaintenanceProtectedOptions;
  prepared: PreparedProtectedExecution;
  context: DatasetMaintenanceRemoteContext;
}): Promise<{
  proof: ProtectedExecutionStatusProof | null;
  verification: ProtectedVerificationResult;
}> {
  return readAndVerifyWithDependencies(options, {
    readExecution: readMaintenanceAliasExecution,
    parseStatus: parseProtectedStatusProof,
    verifyExecution: verifyProtectedExecution,
    nowMs: Date.now,
  });
}

function buildReport(options: {
  command: RunDatasetMaintenanceProtectedOptions;
  prepared: PreparedProtectedExecution;
  admission: ProtectedAdmissionProof | null;
  proof: ProtectedExecutionStatusProof | null;
  verification: ProtectedVerificationResult;
}): DatasetMaintenanceProtectedReport {
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.report_schema,
    generated_at_utc: new Date().toISOString(),
    mode: options.command.statusOnly ? 'status_only' : 'commit',
    status: options.verification.status,
    request_id: options.prepared.identity.request_id,
    identity_sha256: options.prepared.identity.identity_sha256,
    plan_sha256: options.prepared.plan.plan_sha256,
    operation_id: options.prepared.plan.operation_id,
    actor: options.prepared.identity.actor,
    project_ref: options.prepared.identity.project_ref,
    admission: options.admission,
    database_status: options.proof,
    issues: options.verification.issues,
    artifacts: options.prepared.artifacts,
  };
}

function canonicalTerminalReport(report: DatasetMaintenanceProtectedReport): JsonObject {
  return {
    schema_version: report.schema_version,
    artifact_kind: 'protected_terminal_canonical',
    status: report.status,
    request_id: report.request_id,
    identity_sha256: report.identity_sha256,
    plan_sha256: report.plan_sha256,
    operation_id: report.operation_id,
    actor: report.actor,
    project_ref: report.project_ref,
    database_status: report.database_status,
    issues: report.issues,
  };
}

function persistVerificationArtifacts(options: {
  prepared: PreparedProtectedExecution;
  proof: ProtectedExecutionStatusProof | null;
  verification: ProtectedVerificationResult;
  report: DatasetMaintenanceProtectedReport;
}): void {
  if (options.proof?.primary_readback) {
    writePrivateImmutableJson(
      options.prepared.artifacts.audit_readback,
      options.proof.primary_readback,
    );
  }
  if (options.verification.account_readback) {
    writePrivateImmutableJson(
      options.prepared.artifacts.primary_readback,
      options.verification.account_readback,
    );
    writePrivateImmutableJson(options.prepared.artifacts.reference_readback, {
      projected_reference_sha256: sha256Json(
        maintenanceProjectedReferenceFingerprint(options.verification.account_readback.rows),
      ),
      expected_projected_reference_sha256: options.prepared.plan.projected_reference_sha256,
    });
  }
  if (options.verification.derivative_readback) {
    writePrivateImmutableJson(
      options.prepared.artifacts.derivative_readback,
      options.verification.derivative_readback,
    );
  }
  const terminalReadbackRetryable = options.verification.issues.some(
    (entry) => entry.code === 'PROTECTED_TERMINAL_READBACK_UNAVAILABLE',
  );
  writePrivateImmutableJson(options.prepared.artifacts.attempt_report, options.report);
  if (
    options.proof &&
    options.proof.status !== 'pending' &&
    options.proof.execution_status !== 'not_admitted' &&
    !terminalReadbackRetryable &&
    !existsSync(options.prepared.artifacts.terminal_report)
  ) {
    writePrivateImmutableJson(
      options.prepared.artifacts.terminal_report,
      canonicalTerminalReport(options.report),
    );
  }
}

type ProtectedRuntimeDependencies = {
  withStateLock: typeof withStateFileLock;
  resolveContext: typeof resolveMaintenanceRemoteContext;
  fetchAccountRows: typeof fetchMaintenanceAccountRows;
  assertSupport: typeof assertSupportSnapshots;
  assertBaselines: typeof assertDerivativeBaselines;
  buildPreflightRequest: typeof buildProtectedPreflightRequest;
  preflightExecution: typeof preflightMaintenanceAliasExecution;
  parsePreflight: typeof parseProtectedPreflightProof;
  captureGates: typeof captureProtectedGates;
  buildAdmitRequest: typeof buildProtectedAdmitRequest;
  admitExecution: typeof admitMaintenanceAliasExecution;
  parseAdmission: typeof parseProtectedAdmissionProof;
  readAndVerify: typeof readAndVerify;
};

async function runPreparedProtectedExecution(
  options: RunDatasetMaintenanceProtectedOptions,
  basePrepared: PreparedProtectedExecution,
  dependencies: ProtectedRuntimeDependencies,
): Promise<DatasetMaintenanceProtectedReport> {
  ensurePrivateDirectory(basePrepared.outDir);
  return dependencies.withStateLock(
    basePrepared.artifacts.submission_attempt,
    { reason: `dataset_maintenance_protected_${basePrepared.identity.request_id}` },
    async () => {
      writePrivateImmutableJson(basePrepared.artifacts.execution_seal, {
        schema_version: PROTECTED_EXECUTION_CONTRACT.freeze_schema,
        request_id: basePrepared.identity.request_id,
        identity_sha256: basePrepared.identity.identity_sha256,
        plan_path: basePrepared.planPath,
        freeze_path: basePrepared.freezePath,
        approval_path: basePrepared.approvalPath,
        plan_sha256: basePrepared.plan.plan_sha256,
        operation_id: basePrepared.plan.operation_id,
        project_ref: basePrepared.identity.project_ref,
        actor: basePrepared.identity.actor,
        bindings: basePrepared.identity.bindings,
      });
      const prepared = allocateAttemptArtifacts(basePrepared);
      const existingMarker = validateExistingMarker(
        prepared.artifacts.submission_attempt,
        prepared.identity,
      );
      if (options.commit && existingMarker) {
        throw new CliError(
          'A protected submission marker already exists. Use status-only; admission cannot be retried.',
          {
            code: 'DATASET_MAINTENANCE_PROTECTED_ATTEMPT_EXISTS',
            exitCode: 1,
          },
        );
      }
      const context = await dependencies.resolveContext({
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      assertContextBindings({
        prepared,
        context,
        confirm: options.confirm,
        commit: options.commit,
      });

      let admission: ProtectedAdmissionProof | null = null;
      if (options.commit) {
        const current = await dependencies.fetchAccountRows({
          context,
          userId: prepared.identity.actor.user_id,
          pageSize: options.pageSize,
        });
        assertStrictBeforeState({
          prepared,
          currentRows: current.rows,
          completeness: current.completeness,
        });
        await dependencies.assertSupport({ prepared, context });
        await dependencies.assertBaselines({ prepared, context });

        const preflightRequest = dependencies.buildPreflightRequest({
          identity: prepared.identity,
          plan: prepared.aliasPlanRequest,
          freeze: prepared.freeze,
          approval: prepared.approval,
        });
        const preflightRaw = await dependencies.preflightExecution({
          context,
          request: preflightRequest,
        });
        const preflight = dependencies.parsePreflight(
          preflightRaw,
          prepared.identity,
          clock(options),
        );
        const { preflight_token: preflightToken, ...preflightEvidence } = preflight;
        writePrivateImmutableJson(prepared.artifacts.preflight_evidence, {
          proof: preflightEvidence,
          preflight_token_sha256: sha256Text(preflightToken),
          raw_response_sha256: sha256Json(preflightRaw),
        });
        const gates = await dependencies.captureGates({
          prepared,
          context,
          preflight,
          receiptPath: prepared.artifacts.gate_receipts,
        });
        writePrivateImmutableJson(prepared.artifacts.submission_attempt, {
          schema_version: PROTECTED_EXECUTION_CONTRACT.marker_schema,
          prepared_at_utc: clock(options).toISOString(),
          request_id: prepared.identity.request_id,
          identity_sha256: prepared.identity.identity_sha256,
          plan_sha256: prepared.identity.plan_sha256,
          operation_id: prepared.identity.operation_id,
          actor: prepared.identity.actor,
          project_ref: prepared.identity.project_ref,
          preflight_proof_sha256: preflight.preflight_proof_sha256,
          preflight_token_sha256: sha256Text(preflight.preflight_token),
          preflight_completed_at: preflight.completed_at,
          preflight_expires_at: preflight.expires_at,
          gate_results: gates.results,
          gate_receipt_sha256: Object.fromEntries(
            gates.proofs.map((proof) => [proof.gate, proof.receipt_sha256]),
          ),
          max_admit_posts: 1,
          automatic_retry: false,
        });

        const admitRequest = dependencies.buildAdmitRequest({
          preflight,
          gateResults: gates.results,
        });
        try {
          const admissionRaw = await dependencies.admitExecution({
            context,
            request: admitRequest,
          });
          admission = dependencies.parseAdmission(admissionRaw, prepared.identity, preflight);
          writePrivateImmutableJson(prepared.artifacts.admission_response, {
            proof: admission,
            raw_response_sha256: sha256Json(admissionRaw),
          });
        } catch (error) {
          writePrivateImmutableJson(prepared.artifacts.admission_transport_error, {
            schema_version: 1,
            request_id: prepared.identity.request_id,
            observed_at_utc: new Date().toISOString(),
            classification: 'ambiguous_consumed_attempt',
            error: errorDetails(error),
          });
        }
      }

      const readback = await dependencies.readAndVerify({ command: options, prepared, context });
      const report = buildReport({
        command: options,
        prepared,
        admission,
        proof: readback.proof,
        verification: readback.verification,
      });
      persistVerificationArtifacts({
        prepared,
        proof: readback.proof,
        verification: readback.verification,
        report,
      });
      return report;
    },
  );
}

export async function runDatasetMaintenanceProtected(
  options: RunDatasetMaintenanceProtectedOptions,
): Promise<DatasetMaintenanceProtectedReport> {
  const prepared = prepareProtectedExecution(options);
  return runPreparedProtectedExecution(options, prepared, {
    withStateLock: withStateFileLock,
    resolveContext: resolveMaintenanceRemoteContext,
    fetchAccountRows: fetchMaintenanceAccountRows,
    assertSupport: assertSupportSnapshots,
    assertBaselines: assertDerivativeBaselines,
    buildPreflightRequest: buildProtectedPreflightRequest,
    preflightExecution: preflightMaintenanceAliasExecution,
    parsePreflight: parseProtectedPreflightProof,
    captureGates: captureProtectedGates,
    buildAdmitRequest: buildProtectedAdmitRequest,
    admitExecution: admitMaintenanceAliasExecution,
    parseAdmission: parseProtectedAdmissionProof,
    readAndVerify,
  });
}

export const __testInternals = {
  allocateAttemptArtifacts,
  appendPrivateJsonLine,
  assertCanonicalParsedArtifact,
  assertContextBindings,
  assertDerivativeBaselines,
  assertStrictBeforeState,
  assertSupportSnapshots,
  buildReport,
  canonicalTerminalReport,
  clock,
  errorDetails,
  nextAttemptReportPath,
  normalizePollMs,
  normalizeWaitSeconds,
  prepareProtectedExecution,
  prepareProtectedExecutionWithDependencies,
  projectedRows,
  readArtifact,
  readAndVerify,
  readAndVerifyWithDependencies,
  runPreparedProtectedExecution,
  captureProtectedGates,
  captureProtectedGatesWithDependencies,
  persistVerificationArtifacts,
  validateExistingMarker,
  writePrivateImmutableJson,
};
