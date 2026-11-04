import { assertLocalizedTextLanguageUniqueness } from './dataset-localized-text.js';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import {
  buildFlowIdentityFinalizeRequest,
  buildFlowIdentityProcessRequest,
  buildFlowIdentityScopeLookupRequest,
  flowIdentityScopeHasCurrentDerivativeClosure,
  flowIdentityScopeIsReadyToFinalize,
  parseFlowIdentityFinalizeProof,
  parseFlowIdentityProcessProof,
  parseFlowIdentityScopePreflightProof,
  parseFlowIdentityScopeLookupProof,
  parseFlowIdentityScopeStatus,
  prepareFlowIdentityExecution,
  splitFlowIdentityPermitResponse,
  type FlowIdentityExecutionPermit,
  type FlowIdentityExecutionIdentity,
  type FlowIdentityFinalizeProof,
  type FlowIdentityScopeProof,
  type FlowIdentityScopeStatus,
} from './dataset-maintenance-flow-identity-execution-contract.js';
import {
  assertFreshRecoveryBaseline,
  parseFlowIdentityRecoveryProof,
  prepareFlowIdentityRecoveryExecution,
  type PreparedFlowIdentityRecoveryExecution,
} from './dataset-maintenance-flow-identity-recovery.js';
import {
  isJsonObject,
  sha256Json,
  stableJsonText,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import { flowIdentityRestrictedSha256 } from './dataset-maintenance-flow-identity-wire.js';
import type {
  FlowIdentityPlan,
  FlowIdentityProcessTemplate,
} from './dataset-maintenance-flow-identity-contract.js';
import {
  finalizeMaintenanceFlowIdentityScope,
  isMaintenanceRpcDomainFailure,
  lookupMaintenanceFlowIdentityScope,
  preflightMaintenanceFlowIdentityScope,
  recoverMaintenanceFlowIdentityScope,
  readMaintenanceFlowIdentityScope,
  resolveMaintenanceRemoteContext,
  rewriteMaintenanceFlowIdentityProcess,
  type MaintenanceRpcDomainFailure,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { withStateFileLock } from './state-lock.js';
import {
  claimFlowIdentityApproval,
  readFlowIdentityApprovalClaim,
  type FlowIdentityApprovalClaim,
} from './dataset-maintenance-flow-identity-approval-claim.js';

export type FlowIdentityRunStatus = 'passed' | 'pending' | 'blocked' | 'failed' | 'indeterminate';

export type RunFlowIdentityOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  recoveryFreezePath?: string;
  recoveryApprovalPath?: string;
  recoveryRunDir?: string;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  approveExecution?: string;
  confirm?: string;
  waitSeconds?: number;
  pollMs?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

export type FlowIdentityRunReport = {
  schema_version: 'dataset-flow-identity-run-report.v2';
  generated_at_utc: string;
  mode: 'commit' | 'status_only';
  status: FlowIdentityRunStatus;
  operation_id: string;
  plan_sha256: string;
  request_id: string;
  identity_sha256: string;
  scope_id: string | null;
  database_status: FlowIdentityScopeStatus['status'] | null;
  process_count: number;
  completed_process_count: number;
  next_ordinal: number | null;
  automatic_retry: false;
  issues: Array<{ code: string; message: string; details?: unknown }>;
};

type ProcessTemplate = Pick<
  FlowIdentityProcessTemplate,
  'process' | 'rewrites' | 'collision_ledger'
>;

type PreparedRun = ReturnType<typeof prepareFlowIdentityExecution> & {
  planPath: string;
  outDir: string;
  templates: ProcessTemplate[];
  recovery: PreparedFlowIdentityRecoveryExecution | null;
  approvalClaim: FlowIdentityApprovalClaim | null;
};

type RunDependencies = {
  resolveContext: typeof resolveMaintenanceRemoteContext;
  preflight: typeof preflightMaintenanceFlowIdentityScope;
  lookup?: typeof lookupMaintenanceFlowIdentityScope;
  recover?: typeof recoverMaintenanceFlowIdentityScope;
  rewrite: typeof rewriteMaintenanceFlowIdentityProcess;
  read: typeof readMaintenanceFlowIdentityScope;
  finalize: typeof finalizeMaintenanceFlowIdentityScope;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  claimApproval?: (options: { claim: FlowIdentityApprovalClaim; env: NodeJS.ProcessEnv }) => string;
};

type ObtainedScope = {
  scope: FlowIdentityScopeProof | MaintenanceRpcDomainFailure;
  executionPermit: FlowIdentityExecutionPermit | null;
  recoveryAmbiguity?: {
    observed: FlowIdentityScopeStatus | null;
    error: { name: string; message: string; code: string | null };
  };
};

const DEFAULT_POLL_MS = 10_000;
const PARTIAL_EXECUTION_RECOVERY =
  'partial_execution_requires_status_read_and_operator_approved_scope_recovery';
const OPERATOR_REVIEW_REQUIRED = 'operator_review_required';

function fail(message: string, code: string, details?: unknown): never {
  throw new CliError(message, {
    code,
    exitCode: 1,
    ...(details === undefined ? {} : { details }),
  });
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

function assertDomainFailureHasNoPermit(value: MaintenanceRpcDomainFailure, label: string): void {
  if (Object.hasOwn(value, 'execution_permit')) {
    fail(
      `${label} domain rejection unexpectedly contained a bearer permit.`,
      'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_PERMIT_INVALID',
    );
  }
}

function readCanonicalJson(filePath: string, label: string): unknown {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(
      `${label} must be canonical JSON with exactly one trailing newline.`,
      'DATASET_FLOW_IDENTITY_ARTIFACT_NONCANONICAL',
    );
  }
  return artifact.value;
}

function processStem(ordinal: number, id: string, version: string): string {
  return `${String(ordinal).padStart(6, '0')}-${id}-${version}`;
}

function loadProcessTemplates(planPath: string, plan: FlowIdentityPlan): ProcessTemplate[] {
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

/** Read only the sealed prospective payload; snapshots and completed rows are not admission input. */
function assertDesiredProcessLanguages(prepared: PreparedRun, ordinal: number): void {
  const process = prepared.plan.processes[ordinal - 1]!;
  const filePath = path.join(
    path.dirname(prepared.planPath),
    prepared.plan.artifacts.desired_payload_dir,
    `${processStem(process.ordinal, process.id, process.version)}.json`,
  );
  const desired = readCanonicalJson(filePath, `Flow identity desired process ${ordinal}`);
  if (!isJsonObject(desired) || sha256Json(desired) !== process.desired_payload_sha256) {
    fail(
      `Desired process ${ordinal} does not bind the sealed manifest.`,
      'DATASET_FLOW_IDENTITY_DESIRED_PAYLOAD_INVALID',
    );
  }
  assertLocalizedTextLanguageUniqueness(desired);
}

function assertFreshDesiredProcessLanguages(
  command: RunFlowIdentityOptions,
  prepared: PreparedRun,
): void {
  if (!command.commit) return;
  if (prepared.recovery) {
    if (existsSync(path.join(prepared.outDir, 'scope-recovery-attempt.json'))) return;
    const baseline = prepared.recovery.recoveryFreeze.baseline;
    if (!baseline.primary_complete) {
      for (const process of prepared.plan.processes) {
        if (process.ordinal >= baseline.next_ordinal) {
          assertDesiredProcessLanguages(prepared, process.ordinal);
        }
      }
    }
    return;
  }
  if (
    [
      'scope-preflight-attempt.json',
      'scope-preflight-proof.json',
      'scope-lookup-proof.json',
      'scope-preflight-domain-rejection.json',
    ].some((name) => existsSync(path.join(prepared.outDir, name)))
  )
    return;
  for (const process of prepared.plan.processes) {
    assertDesiredProcessLanguages(prepared, process.ordinal);
  }
}

function readRecoveryInputScope(options: {
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

function prepareRun(options: RunFlowIdentityOptions): PreparedRun {
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

function assertContext(prepared: PreparedRun, context: DatasetMaintenanceRemoteContext): void {
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

function numberedArtifact(directory: string, prefix: string): string {
  let ordinal = 1;
  while (existsSync(path.join(directory, `${prefix}.${String(ordinal).padStart(6, '0')}.json`))) {
    ordinal += 1;
  }
  return path.join(directory, `${prefix}.${String(ordinal).padStart(6, '0')}.json`);
}

function writeStatusSnapshot(prepared: PreparedRun, value: unknown): void {
  writePrivateImmutableJson(numberedArtifact(prepared.outDir, 'scope-status'), value);
}

function readStoredScopeProof(prepared: PreparedRun): FlowIdentityScopeProof | null {
  const filePath = path.join(prepared.outDir, 'scope-preflight-proof.json');
  if (existsSync(filePath)) {
    return parseFlowIdentityScopePreflightProof(
      readCanonicalJson(filePath, 'Flow identity scope preflight proof'),
      prepared.plan,
    );
  }
  const lookupPath = path.join(prepared.outDir, 'scope-lookup-proof.json');
  if (!existsSync(lookupPath)) return null;
  return parseFlowIdentityScopeLookupProof(
    readCanonicalJson(lookupPath, 'Flow identity scope lookup proof'),
    prepared.plan,
    prepared.identity,
  );
}

function readStoredDomainRejection(options: {
  filePath: string;
  label: string;
  requestHashField: 'request_sha256' | 'process_request_sha256';
  expectedRequestSha256: string;
}): MaintenanceRpcDomainFailure | null {
  if (!existsSync(options.filePath)) return null;
  const value = readCanonicalJson(options.filePath, options.label);
  if (
    !isJsonObject(value) ||
    value.status !== 'rejected' ||
    value.automatic_retry !== false ||
    value.approval_reusable !== false ||
    value[options.requestHashField] !== options.expectedRequestSha256 ||
    !isMaintenanceRpcDomainFailure(value.response)
  ) {
    fail(
      `${options.label} does not contain an exact database domain rejection.`,
      'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_INVALID',
    );
  }
  return value.response;
}

function finalizeArtifactPath(
  prepared: PreparedRun,
  kind: 'attempt' | 'domain-rejection' | 'proof' | 'transport-error',
  requestSha256: string,
): string {
  return path.join(prepared.outDir, `finalize-${kind}-${requestSha256}.json`);
}

function readStoredFinalizeAttempt(options: {
  prepared: PreparedRun;
  scope: FlowIdentityScopeProof;
  requestSha256: string;
}): JsonObject | null {
  const filePath = finalizeArtifactPath(options.prepared, 'attempt', options.requestSha256);
  if (!existsSync(filePath)) return null;
  const value = readCanonicalJson(filePath, 'Flow identity finalize attempt');
  if (
    !isJsonObject(value) ||
    value.schema_version !== 'dataset-flow-identity-finalize-attempt.v3' ||
    value.scope_id !== options.scope.scope_id ||
    value.request_sha256 !== options.requestSha256 ||
    value.max_posts !== 1 ||
    value.automatic_retry !== false ||
    !isJsonObject(value.request) ||
    flowIdentityRestrictedSha256(value.request) !== options.requestSha256
  ) {
    fail(
      'Flow identity finalize attempt does not bind the exact request.',
      'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_INVALID',
    );
  }
  return value.request;
}

function storedFinalizeAttemptHashes(prepared: PreparedRun): string[] {
  return readdirSync(prepared.outDir)
    .map((name) => /^finalize-attempt-([a-f0-9]{64})\.json$/u.exec(name)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .sort();
}

function readStoredFinalizeProof(options: {
  prepared: PreparedRun;
  scope: FlowIdentityScopeProof;
  request: JsonObject;
  requestSha256: string;
}): FlowIdentityFinalizeProof | null {
  const filePath = finalizeArtifactPath(options.prepared, 'proof', options.requestSha256);
  if (!existsSync(filePath)) return null;
  return parseFlowIdentityFinalizeProof({
    value: readCanonicalJson(filePath, 'Flow identity finalize proof'),
    plan: options.prepared.plan,
    scopeId: options.scope.scope_id,
    scopeProofSha256: options.scope.scope_proof_sha256,
    request: options.request,
  });
}

async function obtainScope(options: {
  command: RunFlowIdentityOptions;
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  dependencies: RunDependencies;
}): Promise<ObtainedScope> {
  if (options.prepared.recovery) {
    if (options.command.statusOnly) {
      fail(
        'Recovery admission is write-capable and requires an explicit commit invocation.',
        'DATASET_FLOW_IDENTITY_RECOVERY_COMMIT_REQUIRED',
      );
    }
    const recovery = options.prepared.recovery;
    const baselineRaw = await options.dependencies.read({
      context: options.context,
      scopeId: recovery.scope.scope_id,
    });
    if (isMaintenanceRpcDomainFailure(baselineRaw)) {
      assertDomainFailureHasNoPermit(baselineRaw, 'Recovery baseline read');
      return { scope: baselineRaw, executionPermit: null };
    }
    const baseline = parseFlowIdentityScopeStatus(
      baselineRaw,
      options.prepared.plan,
      recovery.scope.scope_id,
      recovery.scope.scope_proof_sha256,
    );
    assertFreshRecoveryBaseline(baseline, recovery.recoveryFreeze);
    writeStatusSnapshot(options.prepared, baseline);
    const requestSha256 = flowIdentityRestrictedSha256(recovery.recoveryRequest);
    if (!options.dependencies.recover) {
      fail(
        'Recovery RPC dependency is unavailable.',
        'DATASET_FLOW_IDENTITY_RECOVERY_RPC_UNAVAILABLE',
      );
    }
    writePrivateImmutableJson(path.join(options.prepared.outDir, 'scope-recovery-attempt.json'), {
      schema_version: 'dataset-flow-identity-recovery-attempt.v1',
      generated_at_utc: options.dependencies.now().toISOString(),
      scope_id: recovery.scope.scope_id,
      request_sha256: requestSha256,
      recovery_approval_identity_sha256:
        recovery.recoveryApproval.recovery_approval_identity_sha256,
      maximum_wrapper_invocations: 1,
      maximum_cli_apply_spawns: 1,
      approval_reusable: false,
      automatic_retry: false,
    });
    let raw: JsonObject;
    try {
      raw = await options.dependencies.recover({
        context: options.context,
        scopeId: recovery.scope.scope_id,
        request: recovery.recoveryRequest,
      });
    } catch (error) {
      const details = errorDetails(error);
      writePrivateImmutableJson(
        path.join(options.prepared.outDir, 'scope-recovery-transport-error.json'),
        {
          schema_version: 'dataset-flow-identity-recovery-transport-error.v1',
          observed_at_utc: options.dependencies.now().toISOString(),
          scope_id: recovery.scope.scope_id,
          request_sha256: requestSha256,
          approval_reusable: false,
          automatic_retry: false,
          recovery: 'read_scope_only',
          error: details,
        },
      );
      let observed: FlowIdentityScopeStatus | null = null;
      try {
        const observedRaw = await options.dependencies.read({
          context: options.context,
          scopeId: recovery.scope.scope_id,
        });
        if (!isMaintenanceRpcDomainFailure(observedRaw)) {
          observed = parseFlowIdentityScopeStatus(
            observedRaw,
            options.prepared.plan,
            recovery.scope.scope_id,
            recovery.scope.scope_proof_sha256,
          );
          writeStatusSnapshot(options.prepared, observed);
        } else {
          assertDomainFailureHasNoPermit(observedRaw, 'Recovery ambiguity status read');
        }
      } catch {
        // The immutable transport error is sufficient; never retry recovery admission.
      }
      return {
        scope: recovery.scope,
        executionPermit: null,
        recoveryAmbiguity: { observed, error: details },
      };
    }
    if (isMaintenanceRpcDomainFailure(raw)) {
      assertDomainFailureHasNoPermit(raw, 'Scope recovery');
      writePrivateImmutableJson(
        path.join(options.prepared.outDir, 'scope-recovery-domain-rejection.json'),
        {
          schema_version: 'dataset-flow-identity-recovery-domain-rejection.v1',
          status: 'rejected',
          scope_id: recovery.scope.scope_id,
          request_sha256: requestSha256,
          approval_reusable: false,
          automatic_retry: false,
          response: raw,
        },
      );
      return { scope: raw, executionPermit: null };
    }
    const envelope = splitFlowIdentityPermitResponse({
      value: raw,
      expectedGeneration: 0,
      permitRequired: raw.replay !== true,
      permitForbidden: raw.replay === true,
      label: 'Flow identity scope recovery',
    });
    const recoveryProof = parseFlowIdentityRecoveryProof({
      value: envelope.proof,
      freeze: recovery.recoveryFreeze,
      approval: recovery.recoveryApproval,
      request: recovery.recoveryRequest,
      expectedInvocationId: envelope.executionPermit?.invocation_id,
    });
    writePrivateImmutableJson(
      path.join(
        options.prepared.outDir,
        recovery.scope.schema_version === 'dataset-flow-identity-scope-lookup-result.v1'
          ? 'scope-lookup-proof.json'
          : 'scope-preflight-proof.json',
      ),
      recovery.scope,
    );
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-recovery-proof.json'),
      recoveryProof,
    );
    return { scope: recovery.scope, executionPermit: envelope.executionPermit };
  }
  const stored = readStoredScopeProof(options.prepared);
  if (stored) return { scope: stored, executionPermit: null };
  const storedRejection = readStoredDomainRejection({
    filePath: path.join(options.prepared.outDir, 'scope-preflight-domain-rejection.json'),
    label: 'Flow identity scope preflight domain rejection',
    requestHashField: 'request_sha256',
    expectedRequestSha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
  });
  if (storedRejection) return { scope: storedRejection, executionPermit: null };
  if (options.command.statusOnly) {
    if (!options.prepared.approvalClaim || !options.dependencies.lookup) {
      fail(
        'Status-only recovery requires an immutable local scope proof or a consumed local approval claim with the read-only lookup capability.',
        'DATASET_FLOW_IDENTITY_SCOPE_PROOF_REQUIRED',
      );
    }
    const rawLookup = await options.dependencies.lookup({
      context: options.context,
      request: buildFlowIdentityScopeLookupRequest({ identity: options.prepared.identity }),
    });
    if (isMaintenanceRpcDomainFailure(rawLookup)) {
      assertDomainFailureHasNoPermit(rawLookup, 'Scope lookup');
      return { scope: rawLookup, executionPermit: null };
    }
    const lookupProof = parseFlowIdentityScopeLookupProof(
      rawLookup,
      options.prepared.plan,
      options.prepared.identity,
    );
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-lookup-proof.json'),
      lookupProof,
    );
    return { scope: lookupProof, executionPermit: null };
  }
  writePrivateImmutableJson(path.join(options.prepared.outDir, 'scope-preflight-attempt.json'), {
    schema_version: 'dataset-flow-identity-preflight-attempt.v2',
    generated_at_utc: options.dependencies.now().toISOString(),
    request_id: options.prepared.identity.request_id,
    plan_sha256: options.prepared.plan.plan_sha256,
    request_sha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
    exact_replay_allowed: false,
    automatic_retry: false,
  });
  const raw = await options.dependencies.preflight({
    context: options.context,
    request: options.prepared.preflightRequest,
  });
  if (isMaintenanceRpcDomainFailure(raw)) {
    assertDomainFailureHasNoPermit(raw, 'Scope preflight');
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-preflight-domain-rejection.json'),
      {
        schema_version: 'dataset-flow-identity-preflight-domain-rejection.v1',
        status: 'rejected',
        request_sha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
        automatic_retry: false,
        approval_reusable: false,
        recovery: 'new_capture_freeze_and_exact_approval_required',
        response: raw,
      },
    );
    return { scope: raw, executionPermit: null };
  }
  const envelope = splitFlowIdentityPermitResponse({
    value: raw,
    expectedGeneration: 0,
    permitRequired: raw.replay !== true,
    permitForbidden: raw.replay === true,
    label: 'Flow identity scope preflight',
  });
  const proof = parseFlowIdentityScopePreflightProof(envelope.proof, options.prepared.plan);
  writePrivateImmutableJson(
    path.join(options.prepared.outDir, 'scope-preflight-proof.json'),
    proof,
  );
  return { scope: proof, executionPermit: envelope.executionPermit };
}

async function readScope(options: {
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  dependencies: RunDependencies;
}): Promise<FlowIdentityScopeStatus> {
  const raw = await options.dependencies.read({
    context: options.context,
    scopeId: options.scope.scope_id,
  });
  const status = parseFlowIdentityScopeStatus(
    raw,
    options.prepared.plan,
    options.scope.scope_id,
    options.scope.scope_proof_sha256,
  );
  writeStatusSnapshot(options.prepared, status);
  return status;
}

function validateCompletedRequests(prepared: PreparedRun, status: FlowIdentityScopeStatus): void {
  for (const ledger of status.processes.filter((entry) => entry.status === 'completed')) {
    const template = prepared.templates[ledger.ordinal - 1];
    if (!template) {
      fail(
        'Database progress contains a foreign completed ordinal.',
        'DATASET_FLOW_IDENTITY_PROGRESS_INVALID',
      );
    }
    const request = buildFlowIdentityProcessRequest({
      scopeProofSha256: status.scope_proof_sha256,
      ordinal: ledger.ordinal,
      processIntentProofSha256: ledger.process_intent_proof_sha256,
    });
    if (ledger.process_request_sha256 !== request.process_request_sha256) {
      fail(
        `Completed process ${ledger.ordinal} used a foreign request hash.`,
        'DATASET_FLOW_IDENTITY_PROGRESS_INVALID',
      );
    }
  }
}

function requirePendingProcess(
  prepared: PreparedRun,
  status: FlowIdentityScopeStatus,
  ordinal: number,
): { ledger: FlowIdentityScopeStatus['processes'][number]; template: ProcessTemplate } {
  const ledger = status.processes[ordinal - 1];
  const template = prepared.templates[ordinal - 1];
  if (!ledger || !template || ledger.status !== 'pending') {
    fail(
      'Durable scope did not expose exactly one pending next ordinal.',
      'DATASET_FLOW_IDENTITY_NEXT_ORDINAL_INVALID',
    );
  }
  return { ledger, template };
}

function report(options: {
  prepared: PreparedRun;
  mode: 'commit' | 'status_only';
  status: FlowIdentityRunStatus;
  scope: FlowIdentityScopeProof | null;
  database: FlowIdentityScopeStatus | null;
  issues?: FlowIdentityRunReport['issues'];
  now: Date;
}): FlowIdentityRunReport {
  const value: FlowIdentityRunReport = {
    schema_version: 'dataset-flow-identity-run-report.v2',
    generated_at_utc: options.now.toISOString(),
    mode: options.mode,
    status: options.status,
    operation_id: options.prepared.plan.operation_id,
    plan_sha256: options.prepared.plan.plan_sha256,
    request_id: options.prepared.identity.request_id,
    identity_sha256: options.prepared.identity.identity_sha256,
    scope_id: options.scope?.scope_id ?? null,
    database_status: options.database?.status ?? null,
    process_count: options.prepared.plan.processes.length,
    completed_process_count: options.database?.completed_process_count ?? 0,
    next_ordinal: options.database?.next_ordinal ?? null,
    automatic_retry: false,
    issues: options.issues ?? [],
  };
  writePrivateImmutableJson(numberedArtifact(options.prepared.outDir, 'run-report'), value);
  return value;
}

async function reportProcessDomainRejection(options: {
  prepared: PreparedRun;
  mode: 'commit' | 'status_only';
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  dependencies: RunDependencies;
  ordinal: number;
  requestSha256: string;
  response: MaintenanceRpcDomainFailure;
  rejectionPath: string;
}): Promise<FlowIdentityRunReport> {
  let recovered: FlowIdentityScopeStatus | null = null;
  let readError: unknown = null;
  try {
    recovered = await readScope({
      prepared: options.prepared,
      context: options.context,
      scope: options.scope,
      dependencies: options.dependencies,
    });
    validateCompletedRequests(options.prepared, recovered);
  } catch (error) {
    readError = error;
  }
  const recovery =
    recovered && recovered.completed_process_count > 0
      ? PARTIAL_EXECUTION_RECOVERY
      : OPERATOR_REVIEW_REQUIRED;
  if (!existsSync(options.rejectionPath)) {
    writePrivateImmutableJson(options.rejectionPath, {
      schema_version: 'dataset-flow-identity-process-domain-rejection.v2',
      status: 'rejected',
      ordinal: options.ordinal,
      process_request_sha256: options.requestSha256,
      automatic_retry: false,
      approval_reusable: false,
      recovery,
      response: options.response,
    });
  }
  writePrivateImmutableJson(
    numberedArtifact(
      options.prepared.outDir,
      `process-domain-rejection-recovery-${String(options.ordinal).padStart(6, '0')}`,
    ),
    {
      schema_version: 'dataset-flow-identity-process-domain-rejection-recovery.v1',
      observed_at_utc: options.dependencies.now().toISOString(),
      scope_id: options.scope.scope_id,
      ordinal: options.ordinal,
      process_request_sha256: options.requestSha256,
      status_read_succeeded: recovered !== null,
      completed_process_count: recovered?.completed_process_count ?? null,
      next_ordinal: recovered?.next_ordinal ?? null,
      strict_continuation_required: recovered?.strict_continuation_required ?? null,
      recovery,
      automatic_retry: false,
      ...(readError === null ? {} : { error: errorDetails(readError) }),
    },
  );
  const recoveryIssue =
    recovery === PARTIAL_EXECUTION_RECOVERY
      ? {
          code: 'DATASET_FLOW_IDENTITY_PARTIAL_EXECUTION_REQUIRES_STATUS_READ_AND_OPERATOR_APPROVED_SCOPE_RECOVERY',
          message:
            'Primary writes already exist. Recovery requires fresh status reads and an operator-approved scope recovery; do not start a fresh capture.',
          details: { recovery },
        }
      : {
          code: 'DATASET_FLOW_IDENTITY_OPERATOR_REVIEW_REQUIRED',
          message:
            'No completed primary write is proven by the bounded status read; operator review is required before any next action.',
          details: { recovery },
        };
  return report({
    prepared: options.prepared,
    mode: options.mode,
    status: readError === null ? 'blocked' : 'indeterminate',
    scope: options.scope,
    database: recovered,
    issues: [
      {
        code: options.response.code,
        message:
          typeof options.response.message === 'string'
            ? options.response.message
            : `The database deterministically rejected process ${options.ordinal}.`,
        details: { response: options.response, recovery },
      },
      ...(readError === null
        ? [recoveryIssue]
        : [
            {
              code: 'DATASET_FLOW_IDENTITY_PROCESS_DOMAIN_REJECTION_STATUS_READ_FAILED',
              message:
                'The bounded recovery status read failed; execution is indeterminate and requires operator review.',
              details: { recovery, error: errorDetails(readError) },
            },
          ]),
    ],
    now: options.dependencies.now(),
  });
}

function hasFlowIdentityFinalizeDecision(status: FlowIdentityScopeStatus): boolean {
  return (
    status.status === 'completed' ||
    status.status === 'live_drift' ||
    status.status === 'failed' ||
    status.compensation_required === true ||
    flowIdentityScopeIsReadyToFinalize(status)
  );
}

function completedRunStatus(status: FlowIdentityScopeStatus): 'passed' | 'blocked' {
  return flowIdentityScopeHasCurrentDerivativeClosure(status) ? 'passed' : 'blocked';
}

async function waitForFinalizeDecision(options: {
  command: RunFlowIdentityOptions;
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  initial: FlowIdentityScopeStatus;
  dependencies: RunDependencies;
}): Promise<FlowIdentityScopeStatus> {
  const waitSeconds = options.command.waitSeconds ?? 0;
  const pollMs = options.command.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86_400) {
    fail('waitSeconds must be an integer from 0 to 86400.', 'DATASET_FLOW_IDENTITY_WAIT_INVALID');
  }
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
    fail('pollMs must be an integer from 100 to 60000.', 'DATASET_FLOW_IDENTITY_POLL_INVALID');
  }
  const deadline = Date.now() + waitSeconds * 1_000;
  let current = options.initial;
  while (!hasFlowIdentityFinalizeDecision(current) && Date.now() < deadline) {
    await options.dependencies.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
    current = await readScope(options);
    validateCompletedRequests(options.prepared, current);
  }
  return current;
}

async function executeRun(
  command: RunFlowIdentityOptions,
  dependencies: RunDependencies,
  preparedInput?: PreparedRun,
): Promise<FlowIdentityRunReport> {
  const prepared = preparedInput ?? prepareRun(command);
  const mode = command.commit ? 'commit' : 'status_only';
  assertFreshDesiredProcessLanguages(command, prepared);
  const context = await dependencies.resolveContext({
    env: command.env,
    fetchImpl: command.fetchImpl,
    timeoutMs: command.timeoutMs,
    now: command.now,
  });
  assertContext(prepared, context);
  if (command.commit && dependencies.claimApproval) {
    const recovery = prepared.recovery;
    dependencies.claimApproval({
      env: command.env,
      claim: {
        schema_version: 'dataset-flow-identity-local-approval-claim.v1',
        claimed_at_utc: dependencies.now().toISOString(),
        approval_kind: recovery ? 'recovery' : 'initial',
        approval_identity_sha256: recovery
          ? recovery.recoveryApproval.recovery_approval_identity_sha256
          : prepared.approval.execution_approval_identity_sha256,
        execution_identity_sha256: prepared.identity.identity_sha256,
        request_id: recovery
          ? String(recovery.recoveryRequest.request_id)
          : prepared.identity.request_id,
        environment: 'production',
        project_ref: prepared.plan.project_ref,
        actor_user_id: prepared.plan.account.user_id,
        actor_email: prepared.plan.account.email,
        target_visibility: 'owner_draft',
        user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
        plan_sha256: prepared.plan.plan_sha256,
        freeze_sha256: recovery
          ? recovery.recoveryFreeze.recovery_freeze_sha256
          : prepared.freeze.freeze_sha256,
        canonical_out_dir: prepared.outDir,
        maximum_cli_apply_spawns: 1,
        approval_reusable: false,
      },
    });
  }
  const obtained = await obtainScope({ command, prepared, context, dependencies });
  const scope = obtained.scope;
  const executionPermit = obtained.executionPermit;
  if (isMaintenanceRpcDomainFailure(scope)) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope: null,
      database: null,
      issues: [
        {
          code: scope.code,
          message:
            typeof scope.message === 'string'
              ? scope.message
              : 'The database deterministically rejected scope preflight.',
          details: scope,
        },
      ],
      now: dependencies.now(),
    });
  }
  if (obtained.recoveryAmbiguity) {
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: obtained.recoveryAmbiguity.observed,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_RECOVERY_RESPONSE_AMBIGUOUS',
          message:
            'Recovery admission response was ambiguous; scope was read once and recovery was not retried. A fresh exact recovery freeze and approval are required.',
          details: obtained.recoveryAmbiguity.error,
        },
      ],
      now: dependencies.now(),
    });
  }
  let status = await readScope({ prepared, context, scope, dependencies });
  validateCompletedRequests(prepared, status);
  if (status.status === 'failed' || status.status === 'live_drift') {
    return report({
      prepared,
      mode,
      status: status.status === 'live_drift' ? 'blocked' : 'failed',
      scope,
      database: status,
      issues:
        status.status === 'live_drift'
          ? [
              {
                code: status.code ?? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
                message:
                  'The database dynamically reproved primary or guard drift; no process submission or compensation is allowed.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }
  if (!status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed pending/blocker/orphan closure changed; no process submission is allowed.',
        },
      ],
      now: dependencies.now(),
    });
  }
  if (status.status === 'completed') {
    return report({
      prepared,
      mode,
      status: completedRunStatus(status),
      scope,
      database: status,
      now: dependencies.now(),
    });
  }
  if (command.statusOnly) {
    status = await waitForFinalizeDecision({
      command,
      prepared,
      context,
      scope,
      initial: status,
      dependencies,
    });
    return report({
      prepared,
      mode,
      status:
        status.status === 'completed'
          ? completedRunStatus(status)
          : status.status === 'live_drift'
            ? 'blocked'
            : status.status === 'failed'
              ? 'failed'
              : 'pending',
      scope,
      database: status,
      issues: status.compensation_required
        ? [
            {
              code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
              message:
                'A derivative-only compensation needs a separate plan, freeze, and exact approval; the process mutation will not be replayed.',
              details: { compensation_targets: status.compensation_targets },
            },
          ]
        : status.status !== 'completed' && flowIdentityScopeIsReadyToFinalize(status)
          ? [
              {
                code: 'FLOW_IDENTITY_FINALIZE_READY',
                message:
                  'The derivative closure is ready. Status-only mode remains read-only; an explicit approved commit invocation is required to finalize.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }

  if (executionPermit === null) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FRESH_RECOVERY_APPROVAL_REQUIRED',
          message:
            'This wrapper has no live database permit. Scope read remains available, but any further process or finalize write requires a fresh exact recovery freeze and human approval.',
          details: {
            approval_reusable: false,
            maximum_wrapper_invocations: 1,
            completed_process_count: status.completed_process_count,
            next_ordinal: status.next_ordinal,
            whole_scope_proof_sha256: status.whole_scope_proof_sha256,
          },
        },
      ],
      now: dependencies.now(),
    });
  }
  let livePermit: FlowIdentityExecutionPermit = executionPermit;

  let nextOrdinal: number | null = status.next_ordinal;
  let submittedProcesses = 0;
  while (
    !status.primary_complete &&
    nextOrdinal !== null &&
    nextOrdinal <= prepared.plan.processes.length
  ) {
    if (
      !status.primary_current ||
      !status.live_guard_current ||
      !status.protected_closure_current
    ) {
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
            message:
              'The exactly sealed pending/blocker/orphan closure changed; no next process will be submitted.',
          },
        ],
        now: dependencies.now(),
      });
    }
    const ordinal = nextOrdinal;
    const { ledger, template } = requirePendingProcess(prepared, status, ordinal);
    const request = buildFlowIdentityProcessRequest({
      scopeProofSha256: scope.scope_proof_sha256,
      ordinal,
      processIntentProofSha256: ledger.process_intent_proof_sha256,
    });
    const markerPath = path.join(
      prepared.outDir,
      `process-attempt-${String(ordinal).padStart(6, '0')}.json`,
    );
    const domainRejectionPath = path.join(
      prepared.outDir,
      `process-domain-rejection-${String(ordinal).padStart(6, '0')}.json`,
    );
    if (existsSync(markerPath)) {
      const storedRejection = readStoredDomainRejection({
        filePath: domainRejectionPath,
        label: `Flow identity process ${ordinal} domain rejection`,
        requestHashField: 'process_request_sha256',
        expectedRequestSha256: String(request.process_request_sha256),
      });
      if (storedRejection) {
        return reportProcessDomainRejection({
          prepared,
          mode,
          context,
          scope,
          dependencies,
          ordinal,
          requestSha256: String(request.process_request_sha256),
          response: storedRejection,
          rejectionPath: domainRejectionPath,
        });
      }
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROCESS_ATTEMPT_AMBIGUOUS',
            message: `Process ${ordinal} has a local attempt marker but no durable completed proof; no automatic retry is allowed.`,
          },
        ],
        now: dependencies.now(),
      });
    }
    assertDesiredProcessLanguages(prepared, ordinal);
    writePrivateImmutableJson(markerPath, {
      schema_version: 'dataset-flow-identity-process-attempt.v2',
      generated_at_utc: dependencies.now().toISOString(),
      scope_id: scope.scope_id,
      scope_proof_sha256: scope.scope_proof_sha256,
      ordinal,
      process_request_sha256: request.process_request_sha256,
      max_posts: 1,
      automatic_retry: false,
    });
    try {
      const raw = await dependencies.rewrite({
        context,
        scopeId: scope.scope_id,
        request,
        authorization: livePermit,
      });
      if (isMaintenanceRpcDomainFailure(raw)) {
        assertDomainFailureHasNoPermit(raw, `Process ${ordinal}`);
        return reportProcessDomainRejection({
          prepared,
          mode,
          context,
          scope,
          dependencies,
          ordinal,
          requestSha256: String(request.process_request_sha256),
          response: raw,
          rejectionPath: domainRejectionPath,
        });
      }
      const envelope = splitFlowIdentityPermitResponse({
        value: raw,
        expectedGeneration: livePermit.generation + 1,
        expectedInvocationId: livePermit.invocation_id,
        permitRequired: true,
        label: `Flow identity process ${ordinal}`,
      });
      const proof = parseFlowIdentityProcessProof({
        value: envelope.proof,
        scopeId: scope.scope_id,
        process: template.process,
        requestSha256: String(request.process_request_sha256),
        receiptId: prepared.plan.receipt_id,
        receiptProofSha256: prepared.plan.receipt_proof_sha256,
        mappingGuardSetSha256: prepared.plan.mapping_guard_set_sha256,
        processIntentSetSha256: prepared.plan.process_intent_set_sha256,
        processIntentProofSha256: ledger.process_intent_proof_sha256,
        processCount: prepared.plan.processes.length,
        expectedInvocationId: livePermit.invocation_id,
        expectedPermitGenerationBefore: livePermit.generation,
      });
      writePrivateImmutableJson(
        path.join(prepared.outDir, `process-proof-${String(ordinal).padStart(6, '0')}.json`),
        proof,
      );
      // permitRequired=true above already rejects null before the proof parser.
      livePermit = envelope.executionPermit!;
      submittedProcesses += 1;
      nextOrdinal = proof.next_ordinal;
    } catch (error) {
      writePrivateImmutableJson(
        path.join(
          prepared.outDir,
          `process-transport-error-${String(ordinal).padStart(6, '0')}.json`,
        ),
        {
          schema_version: 'dataset-flow-identity-process-transport-error.v1',
          observed_at_utc: dependencies.now().toISOString(),
          ordinal,
          process_request_sha256: request.process_request_sha256,
          automatic_retry: false,
          recovery: 'read_scope_only',
          error: errorDetails(error),
        },
      );
      let recovered: FlowIdentityScopeStatus | null = null;
      try {
        recovered = await readScope({ prepared, context, scope, dependencies });
        validateCompletedRequests(prepared, recovered);
      } catch (readError) {
        writePrivateImmutableJson(
          path.join(
            prepared.outDir,
            `process-recovery-read-error-${String(ordinal).padStart(6, '0')}.json`,
          ),
          { observed_at_utc: dependencies.now().toISOString(), error: errorDetails(readError) },
        );
      }
      return report({
        prepared,
        mode,
        status: 'indeterminate',
        scope,
        database: recovered,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROCESS_RESPONSE_AMBIGUOUS',
            message:
              'Process response was ambiguous; durable scope was read once and no process submission was retried.',
            details: errorDetails(error),
          },
        ],
        now: dependencies.now(),
      });
    }
  }

  if (submittedProcesses > 0) {
    status = await readScope({ prepared, context, scope, dependencies });
    validateCompletedRequests(prepared, status);
  }

  if (!status.primary_current || !status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed pending/blocker/orphan closure changed after the last process; finalize is forbidden.',
        },
      ],
      now: dependencies.now(),
    });
  }

  status = await waitForFinalizeDecision({
    command,
    prepared,
    context,
    scope,
    initial: status,
    dependencies,
  });
  if (status.status === 'completed') {
    return report({
      prepared,
      mode,
      status: completedRunStatus(status),
      scope,
      database: status,
      now: dependencies.now(),
    });
  }
  if (status.status === 'live_drift' || status.status === 'failed') {
    return report({
      prepared,
      mode,
      status: status.status === 'live_drift' ? 'blocked' : 'failed',
      scope,
      database: status,
      issues:
        status.status === 'live_drift'
          ? [
              {
                code: status.code ?? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
                message:
                  'The database dynamically reproved primary or guard drift while derivatives were settling; finalize was not submitted.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }
  if (!status.primary_current || !status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed closure changed while derivatives were settling; finalize was not submitted.',
        },
      ],
      now: dependencies.now(),
    });
  }
  if (status.compensation_required) {
    return report({
      prepared,
      mode,
      status: 'pending',
      scope,
      database: status,
      issues: [
        {
          code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
          message:
            'A derivative-only compensation needs a separate plan, freeze, and exact approval; finalize was not submitted and the process mutation will not be replayed.',
          details: { compensation_targets: status.compensation_targets },
        },
      ],
      now: dependencies.now(),
    });
  }
  if (!flowIdentityScopeIsReadyToFinalize(status)) {
    return report({
      prepared,
      mode,
      status: 'pending',
      scope,
      database: status,
      issues: [
        {
          code: 'FLOW_IDENTITY_DERIVATIVES_PENDING',
          message:
            'Derivative closure is still pending at the wait deadline; finalize was not submitted. This in-memory permit is discarded when the wrapper exits, so continuation requires a fresh exact recovery freeze and human approval.',
        },
      ],
      now: dependencies.now(),
    });
  }

  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: scope.scope_proof_sha256,
    plan: prepared.plan,
    status,
  });
  const finalizeRequestSha256 = flowIdentityRestrictedSha256(finalizeRequest);
  const finalizeAttemptPath = finalizeArtifactPath(prepared, 'attempt', finalizeRequestSha256);
  const finalizeRejectionPath = finalizeArtifactPath(
    prepared,
    'domain-rejection',
    finalizeRequestSha256,
  );
  const finalizeProofPath = finalizeArtifactPath(prepared, 'proof', finalizeRequestSha256);
  const finalizeTransportPath = finalizeArtifactPath(
    prepared,
    'transport-error',
    finalizeRequestSha256,
  );
  const priorAttemptHashes = storedFinalizeAttemptHashes(prepared);
  const exactStoredRequest = readStoredFinalizeAttempt({
    prepared,
    scope,
    requestSha256: finalizeRequestSha256,
  });
  if (exactStoredRequest) {
    const storedRejection = readStoredDomainRejection({
      filePath: finalizeRejectionPath,
      label: 'Flow identity finalize domain rejection',
      requestHashField: 'request_sha256',
      expectedRequestSha256: finalizeRequestSha256,
    });
    const storedProof = readStoredFinalizeProof({
      prepared,
      scope,
      request: exactStoredRequest,
      requestSha256: finalizeRequestSha256,
    });
    if (storedRejection && storedProof) {
      fail(
        'Finalize request has contradictory rejection and proof artifacts.',
        'DATASET_FLOW_IDENTITY_FINALIZE_ARTIFACT_CONFLICT',
      );
    }
    if (storedRejection) {
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: storedRejection.code,
            message:
              typeof storedRejection.message === 'string'
                ? storedRejection.message
                : 'The database deterministically rejected finalize.',
            details: {
              response: storedRejection,
              request_sha256: finalizeRequestSha256,
              recovery: OPERATOR_REVIEW_REQUIRED,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    if (storedProof) {
      return report({
        prepared,
        mode,
        status:
          storedProof.status === 'failed'
            ? 'failed'
            : storedProof.status === 'live_drift'
              ? 'blocked'
              : 'pending',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_FINALIZE_REQUEST_ALREADY_PROVEN',
            message:
              'This exact finalize request already has a durable proof and will not be posted again. A new explicit finalize requires a prior derivatives_pending proof and a later status that creates a new request hash.',
            details: {
              request_sha256: finalizeRequestSha256,
              proof_status: storedProof.status,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
          message:
            'This exact finalize request has an attempt but no durable proof or domain rejection; the scope was read first and finalize will not be posted again.',
          details: { request_sha256: finalizeRequestSha256 },
        },
      ],
      now: dependencies.now(),
    });
  }
  if (existsSync(finalizeRejectionPath) || existsSync(finalizeProofPath)) {
    fail(
      'Finalize terminal artifact exists without its exact attempt.',
      'DATASET_FLOW_IDENTITY_FINALIZE_ARTIFACT_INVALID',
    );
  }
  for (const priorRequestSha256 of priorAttemptHashes) {
    const priorRequest = readStoredFinalizeAttempt({
      prepared,
      scope,
      requestSha256: priorRequestSha256,
    });
    if (!priorRequest) continue;
    const priorRejection = readStoredDomainRejection({
      filePath: finalizeArtifactPath(prepared, 'domain-rejection', priorRequestSha256),
      label: 'Prior flow identity finalize domain rejection',
      requestHashField: 'request_sha256',
      expectedRequestSha256: priorRequestSha256,
    });
    const priorProof = readStoredFinalizeProof({
      prepared,
      scope,
      request: priorRequest,
      requestSha256: priorRequestSha256,
    });
    if (priorRejection || !priorProof) {
      return report({
        prepared,
        mode,
        status: priorRejection ? 'blocked' : 'indeterminate',
        scope,
        database: status,
        issues: [
          {
            code: priorRejection?.code ?? 'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
            message:
              'A prior finalize attempt is not backed by a valid derivatives_pending proof; no new finalize request is allowed in this output directory.',
            details: {
              prior_request_sha256: priorRequestSha256,
              current_request_sha256: finalizeRequestSha256,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    if (priorProof.status !== 'derivatives_pending') {
      return report({
        prepared,
        mode,
        status: priorProof.status === 'failed' ? 'failed' : 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_FINALIZE_NEW_REQUEST_NOT_AUTHORIZED',
            message:
              'Only a valid derivatives_pending proof can authorize a later explicit finalize with a new status-derived request hash.',
            details: {
              prior_request_sha256: priorRequestSha256,
              prior_status: priorProof.status,
              current_request_sha256: finalizeRequestSha256,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
  }
  writePrivateImmutableJson(finalizeAttemptPath, {
    schema_version: 'dataset-flow-identity-finalize-attempt.v3',
    generated_at_utc: dependencies.now().toISOString(),
    scope_id: scope.scope_id,
    request_sha256: finalizeRequestSha256,
    request: finalizeRequest,
    max_posts: 1,
    automatic_retry: false,
  });
  let finalizeProof: FlowIdentityFinalizeProof;
  try {
    const raw = await dependencies.finalize({
      context,
      scopeId: scope.scope_id,
      request: finalizeRequest,
      authorization: livePermit,
    });
    if (
      isJsonObject(raw) &&
      raw.schema_version === 'dataset-flow-identity-scope-finalize-result.v2'
    ) {
      const permitUsed = livePermit;
      const envelope =
        raw.ok === true
          ? splitFlowIdentityPermitResponse({
              value: raw,
              expectedGeneration: permitUsed.generation + 1,
              expectedInvocationId: permitUsed.invocation_id,
              permitRequired: raw.status === 'derivatives_pending',
              permitForbidden: raw.status !== 'derivatives_pending',
              label: 'Flow identity finalize',
            })
          : (() => {
              if (Object.hasOwn(raw, 'execution_permit')) {
                fail(
                  'Rejected flow identity finalize response contained a bearer permit.',
                  'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_PERMIT_INVALID',
                );
              }
              return { proof: raw, executionPermit: null };
            })();
      finalizeProof = parseFlowIdentityFinalizeProof({
        value: envelope.proof,
        plan: prepared.plan,
        scopeId: scope.scope_id,
        scopeProofSha256: scope.scope_proof_sha256,
        request: finalizeRequest,
        expectedInvocationId: permitUsed.invocation_id,
        expectedPermitGenerationBefore: permitUsed.generation,
      });
      if (envelope.executionPermit !== null) livePermit = envelope.executionPermit;
      writePrivateImmutableJson(finalizeProofPath, finalizeProof);
    } else if (isMaintenanceRpcDomainFailure(raw)) {
      assertDomainFailureHasNoPermit(raw, 'Finalize');
      writePrivateImmutableJson(finalizeRejectionPath, {
        schema_version: 'dataset-flow-identity-finalize-domain-rejection.v1',
        status: 'rejected',
        scope_id: scope.scope_id,
        request_sha256: finalizeRequestSha256,
        automatic_retry: false,
        approval_reusable: false,
        recovery: OPERATOR_REVIEW_REQUIRED,
        response: raw,
      });
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: raw.code,
            message:
              typeof raw.message === 'string'
                ? raw.message
                : 'The database deterministically rejected finalize.',
            details: {
              response: raw,
              request_sha256: finalizeRequestSha256,
              recovery: OPERATOR_REVIEW_REQUIRED,
            },
          },
        ],
        now: dependencies.now(),
      });
    } else {
      fail(
        'Finalize returned neither a guarded proof nor a deterministic domain rejection.',
        'DATASET_FLOW_IDENTITY_FINALIZE_RESPONSE_INVALID',
      );
    }
  } catch (error) {
    writePrivateImmutableJson(finalizeTransportPath, {
      schema_version: 'dataset-flow-identity-finalize-transport-error.v1',
      observed_at_utc: dependencies.now().toISOString(),
      scope_id: scope.scope_id,
      request_sha256: finalizeRequestSha256,
      automatic_retry: false,
      recovery: 'read_scope_only',
      error: errorDetails(error),
    });
    let recovered: FlowIdentityScopeStatus | null = null;
    try {
      recovered = await readScope({ prepared, context, scope, dependencies });
      validateCompletedRequests(prepared, recovered);
    } catch {
      // The immutable transport error is sufficient; never replace it with a blind finalize retry.
    }
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: recovered,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FINALIZE_RESPONSE_AMBIGUOUS',
          message:
            'Finalize response was ambiguous; scope was read once and finalize was not retried in this invocation.',
          details: errorDetails(error),
        },
      ],
      now: dependencies.now(),
    });
  }
  status = await readScope({ prepared, context, scope, dependencies });
  validateCompletedRequests(prepared, status);
  return report({
    prepared,
    mode,
    status:
      finalizeProof.status === 'completed' &&
      status.status === 'completed' &&
      flowIdentityScopeHasCurrentDerivativeClosure(status)
        ? 'passed'
        : status.status === 'live_drift' || finalizeProof.status === 'live_drift'
          ? 'blocked'
          : status.status === 'failed' || finalizeProof.status === 'failed'
            ? 'failed'
            : 'pending',
    scope,
    database: status,
    issues: finalizeProof.compensation_required
      ? [
          {
            code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
            message:
              'A derivative-only compensation needs a separate plan, freeze, and exact approval; the process mutation will not be replayed.',
            details: { compensation_targets: finalizeProof.compensation_targets },
          },
        ]
      : [],
    now: dependencies.now(),
  });
}

export async function runFlowIdentity(
  options: RunFlowIdentityOptions,
): Promise<FlowIdentityRunReport> {
  // Status-only may be invoked with a different caller path. Resolve the
  // immutable approval claim before locking so every reader/writer serializes
  // on the one canonical run directory.
  const prepared = prepareRun(options);
  const outDir = prepared.outDir;
  return withStateFileLock(
    path.join(outDir, 'flow-identity-run-state'),
    { reason: 'dataset flow identity serial runner', timeoutMs: 0 },
    () =>
      executeRun(
        options,
        {
          resolveContext: resolveMaintenanceRemoteContext,
          preflight: preflightMaintenanceFlowIdentityScope,
          lookup: lookupMaintenanceFlowIdentityScope,
          recover: recoverMaintenanceFlowIdentityScope,
          rewrite: rewriteMaintenanceFlowIdentityProcess,
          read: readMaintenanceFlowIdentityScope,
          finalize: finalizeMaintenanceFlowIdentityScope,
          sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          now: () => options.now ?? new Date(),
          claimApproval: claimFlowIdentityApproval,
        },
        prepared,
      ),
  );
}

export const __testInternals = {
  assertContext,
  assertDesiredProcessLanguages,
  assertFreshDesiredProcessLanguages,
  completedRunStatus,
  errorDetails,
  executeRun,
  loadProcessTemplates,
  numberedArtifact,
  prepareRun,
  processStem,
  readCanonicalJson,
  requirePendingProcess,
  report,
  validateCompletedRequests,
  waitForFinalizeDecision,
};
