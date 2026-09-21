// Versioned (v2) protected artefacts and the protected run for the current Time alias cohort.
//
// The transport is the real one, versioned rather than replaced: the CLI freezes, seals the
// approval, then runs preflight -> the three gates -> one admission, after which the
// server-side queue reaches the private v2 executor through its service-only callback and the
// CLI only polls the read stage. There is no CLI-side execution call and no second admission.
//
// Durable evidence uses the same private-artifact owners as v1 (immutable writes, append-only
// progress ledger), with versioned file names, so a v1 run directory and a v2 run directory can
// never be confused for one another.

import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  stableJsonText,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import {
  admitMaintenanceAliasExecutionV2,
  captureMaintenanceAliasExecutionGateV2,
  preflightMaintenanceAliasExecutionV2,
  readMaintenanceAliasExecutionV2,
  resolveMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import {
  ALIAS_V2_ENDPOINTS,
  ALIAS_V2_GATE_NAMES,
  ALIAS_V2_POLL_EXHAUSTED,
  ALIAS_V2_RESPONSE_INVALID,
  advanceAliasV2Lifecycle,
  classifyAliasV2Response,
  isAliasV2Terminal,
  startAliasV2Lifecycle,
  type AliasV2Lifecycle,
  type AliasV2StepResult,
} from './dataset-alias-v2-lifecycle.js';
import { buildAliasV2PreflightRequest } from './dataset-alias-v2-execution-request.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';

type JsonValue = JsonObject;

export const ALIAS_V2_PROTECTED_CONTRACT = {
  freeze_schema: 'dataset-alias-execution-freeze.v2',
  approval_schema: 'dataset-alias-execution-approval.v2',
  approval_request_schema: 'dataset-alias-execution-approval-request.v2',
  attempt_schema: 'dataset-alias-execution-attempt.v2',
  report_schema: 'dataset-alias-execution-report.v2',
} as const;

export const ALIAS_V2_PROTECTED_ARTIFACTS = {
  plan_file: 'alias-v2-plan.json',
  freeze: 'protected-v2-execution-freeze.json',
  approval_request: 'protected-v2-approval-request.json',
  approval_text: 'protected-v2-approval-request.txt',
  approval: 'protected-v2-approval.json',
  attempt: 'protected-v2-attempt.json',
  status_progress: 'protected-v2-status-progress.jsonl',
  report: 'protected-v2-report.json',
  freeze_report: 'protected-v2-freeze-report.json',
} as const;

export const ALIAS_V2_FREEZE_POLICY = {
  state_code_changes: 0,
  save_draft: 0,
  deletes: 0,
  rebuild_derivatives: 0,
  unitgroup_actions: 0,
  person_distance_actions: 0,
  max_admit_posts: 1,
  automatic_retry: false,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type AliasV2Artifact<T> = {
  value: T;
  canonical_file_text: string;
  file_sha256: string;
};

export type AliasV2Account = { user_id: string; email: string };

export type AliasV2Freeze = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.freeze_schema;
  environment: 'production';
  project_ref: string;
  account: AliasV2Account;
  target_visibility: 'owner_draft';
  plan: { plan_file_sha256: string; plan_sha256: string };
  counts: JsonObject;
  target_snapshots: JsonObject;
  source_evidence: JsonObject;
  derivative_targets: JsonValue[];
  expected_closure: JsonObject;
  bindings: JsonObject;
  toolchain_evidence_sha256: string;
  policy: typeof ALIAS_V2_FREEZE_POLICY;
  freeze_sha256: string;
};

export type AliasV2ApprovalRequest = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.approval_request_schema;
  environment: 'production';
  project_ref: string;
  account: AliasV2Account;
  plan_sha256: string;
  plan_file_sha256: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  counts: JsonObject;
  request_sha256: string;
  approval_text: string;
  approval_text_sha256: string;
};

export type AliasV2Approval = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.approval_schema;
  approved_at_utc: string;
  environment: 'production';
  project_ref: string;
  account: AliasV2Account;
  target_visibility: 'owner_draft';
  plan_sha256: string;
  plan_file_sha256: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  approval_text_sha256: string;
  max_admit_posts: 1;
  automatic_retry: false;
  approval_identity_sha256: string;
};

export type AliasV2AttemptMarker = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.attempt_schema;
  request_id: string;
  plan_sha256: string;
  freeze_sha256: string;
  approval_identity_sha256: string;
  posted_at_utc: string;
  /** The marker's only meaning: one admission POST was issued for this execution. */
  admission_posts: 1;
};

export type AliasV2ProtectedReport = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.report_schema;
  mode: 'commit' | 'status_only';
  status: 'passed' | 'failed' | 'indeterminate' | 'not_admitted';
  phase: string;
  request_id: string;
  plan_sha256: string;
  counts: JsonObject;
  code: string | null;
  admission_attempts: number;
  polls: number;
  read_attempts: number;
  gates: string[];
  report_path: string;
};

export type BuildAliasV2FreezeOptions = {
  plan: JsonObject;
  planFileSha256: string;
  projectRef: string;
  account: AliasV2Account;
  bindings: JsonObject;
  derivativeTargets: JsonValue[];
  expectedClosure: JsonObject;
  toolchainEvidenceSha256: string;
  approvedAtUtc: string;
};

function fail(message: string, code: string, status = 2): never {
  throw new CliError(message, { code, exitCode: status });
}
function requires(condition: unknown, message: string, code: string): void {
  if (!condition) fail(message, code);
}
function canonical(value: unknown): string {
  return `${stableJsonText(value)}\n`;
}
function artifactOf<T>(value: T): AliasV2Artifact<T> {
  const text = canonical(value);
  return { value, canonical_file_text: text, file_sha256: sha256Text(text) };
}
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/** The plan document a v2 freeze can bind: the reviewed plan schema with a plan digest. */
export function assertAliasV2PlanDocument(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    fail('Alias v2 plan artifact must be a JSON object.', ALIAS_V2_RESPONSE_INVALID);
  }
  requires(
    value['schema_version'] === 'dataset-alias-plan.v2',
    'Alias v2 plan artifact must be dataset-alias-plan.v2.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isSha256(value['plan_sha256']),
    'Alias v2 plan artifact must carry its digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    Array.isArray(value['actions']),
    'Alias v2 plan artifact must carry its actions.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isJsonObject(value['counts']),
    'Alias v2 plan artifact must carry its derived counts.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  return value;
}

/**
 * Builds the v2 freeze from the reviewed plan document and the frozen bindings. The plan digest,
 * the counts and the target/source snapshots come from the plan itself, so a freeze can never
 * bind a different cohort than the plan it names.
 */
export function buildAliasV2Freeze(
  options: BuildAliasV2FreezeOptions,
): AliasV2Artifact<AliasV2Freeze> {
  const plan = assertAliasV2PlanDocument(options.plan);
  requires(
    isSha256(options.planFileSha256),
    'Alias v2 freeze needs the plan file digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    options.projectRef.trim() !== '',
    'Alias v2 freeze needs the project reference.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isJsonObject(options.bindings) &&
      Object.values(options.bindings).every(isSha256) &&
      Object.keys(options.bindings).length === 14,
    'Alias v2 freeze needs the fourteen reviewed bindings.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isSha256(options.toolchainEvidenceSha256),
    'Alias v2 freeze needs the toolchain evidence digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    Array.isArray(options.derivativeTargets) && options.derivativeTargets.length > 0,
    'Alias v2 freeze needs its derivative targets.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    options.account.email.trim() !== '' && options.account.user_id.trim() !== '',
    'Alias v2 freeze needs its owner account.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  const candidate: AliasV2Freeze = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: options.projectRef,
    account: options.account,
    target_visibility: 'owner_draft',
    plan: {
      plan_file_sha256: options.planFileSha256,
      plan_sha256: plan['plan_sha256'] as string,
    },
    counts: plan['counts'] as JsonObject,
    target_snapshots: plan['target_snapshots'] as JsonObject,
    source_evidence: plan['source_evidence'] as JsonObject,
    derivative_targets: options.derivativeTargets,
    expected_closure: options.expectedClosure,
    bindings: options.bindings,
    toolchain_evidence_sha256: options.toolchainEvidenceSha256,
    policy: ALIAS_V2_FREEZE_POLICY,
    freeze_sha256: '',
  };
  candidate.freeze_sha256 = sha256Json({ ...candidate, freeze_sha256: undefined });
  return artifactOf(candidate);
}

/** The approval request: the exact text a human approves, bound to the freeze and the plan. */
export function buildAliasV2ApprovalRequest(options: {
  freeze: AliasV2Freeze;
  freezeFileSha256: string;
  approvedAtUtc: string;
  approvals: { plan: string; freeze: string; request: string; text: string };
}): AliasV2Artifact<AliasV2ApprovalRequest> {
  const { freeze } = options;
  requires(
    freeze.schema_version === ALIAS_V2_PROTECTED_CONTRACT.freeze_schema,
    'Alias v2 approval request needs a v2 freeze.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isSha256(options.freezeFileSha256),
    'Alias v2 approval request needs the freeze file digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  const core = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.approval_request_schema,
    environment: 'production' as const,
    project_ref: freeze.project_ref,
    account: freeze.account,
    plan_sha256: freeze.plan.plan_sha256,
    plan_file_sha256: freeze.plan.plan_file_sha256,
    freeze_file_sha256: options.freezeFileSha256,
    freeze_sha256: freeze.freeze_sha256,
    counts: freeze.counts,
  };
  const approvalText = [
    `Approved Time alias v2 plan ${freeze.plan.plan_sha256}`,
    `data set under freeze ${freeze.freeze_sha256}`,
    `for project ${freeze.project_ref} at ${options.approvedAtUtc}.`,
    `Counts: ${stableJsonText(freeze.counts)}.`,
    'One admission, no automatic retry, owner-draft visibility only.',
  ].join(' ');
  const request: AliasV2ApprovalRequest = {
    ...core,
    request_sha256: sha256Json(core),
    approval_text: approvalText,
    approval_text_sha256: sha256Text(approvalText),
  };
  return artifactOf(request);
}

/** The sealed approval: the content-bound artefact the preflight binds. */
export function sealAliasV2Approval(options: {
  request: AliasV2ApprovalRequest;
  requestFileSha256: string;
  approvals: { plan: string; freeze: string; request: string; text: string };
  confirm: string;
  approvedAtUtc: string;
}): AliasV2Artifact<AliasV2Approval> {
  const { request } = options;
  requires(
    request.schema_version === ALIAS_V2_PROTECTED_CONTRACT.approval_request_schema,
    'Alias v2 approval needs a v2 approval request.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    isSha256(options.requestFileSha256),
    'Alias v2 approval needs the approval request file digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    options.confirm === request.account.email,
    'Alias v2 approval must be confirmed by the owner account email.',
    'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
  );
  requires(
    options.approvals.plan === request.plan_sha256 &&
      options.approvals.freeze === request.freeze_sha256 &&
      options.approvals.request === options.requestFileSha256 &&
      options.approvals.text === request.approval_text_sha256,
    'Alias v2 approval confirmations must match the request exactly.',
    'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
  );
  const core = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.approval_schema,
    approved_at_utc: options.approvedAtUtc,
    environment: 'production' as const,
    project_ref: request.project_ref,
    account: request.account,
    target_visibility: 'owner_draft' as const,
    plan_sha256: request.plan_sha256,
    plan_file_sha256: request.plan_file_sha256,
    freeze_file_sha256: request.freeze_file_sha256,
    freeze_sha256: request.freeze_sha256,
    approval_text_sha256: request.approval_text_sha256,
    max_admit_posts: 1 as const,
    automatic_retry: false as const,
  };
  return artifactOf({ ...core, approval_identity_sha256: sha256Json(core) });
}

function readJson(filePath: string, label: string): { value: JsonObject; file_sha256: string } {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (!isJsonObject(artifact.value)) {
    fail(`${label} must be a JSON object.`, 'DATASET_MAINTENANCE_ARTIFACT_INVALID');
  }
  return { value: artifact.value, file_sha256: artifact.file_sha256 };
}
function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HTTP_STATUS = /^HTTP (\d{3}) returned from/u;

type DispatchOutcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'refusal'; status: number; code: string }
  | { kind: 'unknown'; reason: string };

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  if (value.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Unwraps the data-api envelope every protected response carries: `ok: true` plus the payload,
 * or `ok: false` plus the domain refusal the reviewed status policy maps. A success envelope
 * with nothing but `ok` is the read stage's explicit "no durable evidence".
 */
function normalizeEnvelope(
  body: unknown,
): { kind: 'refusal'; status: number; code: string } | { kind: 'payload'; body: unknown } {
  if (!isJsonObject(body)) {
    return { kind: 'payload', body };
  }
  if (body['ok'] === false && typeof body['code'] === 'string' && body['code'] !== '') {
    return {
      kind: 'refusal',
      status: typeof body['status'] === 'number' ? (body['status'] as number) : 0,
      code: body['code'],
    };
  }
  if (body['ok'] === true) {
    const payload = { ...body };
    delete payload['ok'];
    return { kind: 'payload', body: Object.keys(payload).length === 0 ? null : payload };
  }
  return { kind: 'payload', body };
}

/**
 * Turns one transport attempt into a dispatch outcome. The transport throws for a non-2xx
 * response, so the reviewed status policy is applied to that status and to the error body the
 * transport carried; anything without a status at all is an unknown outcome, which only the
 * readback path may resolve.
 */
async function dispatchOutcome(call: () => Promise<unknown>): Promise<DispatchOutcome> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    const message = errorDetails(error);
    const status = HTTP_STATUS.exec(message);
    if (status === null) {
      return { kind: 'unknown', reason: message };
    }
    const details = (error as { details?: unknown }).details;
    const carried = isJsonObject(details) ? details['response'] : details;
    const normalized = normalizeEnvelope(parseMaybeJson(carried));
    if (normalized.kind === 'refusal') {
      return { ...normalized, status: Number(status[1]) };
    }
    return { kind: 'response', status: Number(status[1]), body: normalized.body };
  }
  const normalized = normalizeEnvelope(raw);
  return normalized.kind === 'payload'
    ? { kind: 'response', status: 200, body: normalized.body }
    : normalized;
}
function normalizeWaitSeconds(value: number | undefined): number {
  const seconds = value ?? 900;
  requires(
    Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400,
    'Alias v2 run waitSeconds must be an integer between 0 and 86400.',
    'DATASET_MAINTENANCE_PROTECTED_WAIT_INVALID',
  );
  return seconds;
}
function normalizePollMs(value: number | undefined): number {
  const poll = value ?? 1_000;
  requires(
    Number.isInteger(poll) && poll >= 100 && poll <= 60_000,
    'Alias v2 run pollMs must be an integer between 100 and 60000.',
    'DATASET_MAINTENANCE_PROTECTED_POLL_INVALID',
  );
  return poll;
}

/** Deterministic client request identity: the same plan and freeze always bind one request. */
export function aliasV2RequestId(planSha256: string, freezeSha256: string): string {
  const digest = sha256Text(`${planSha256}:${freezeSha256}:alias-execution-v2`);
  // A UUID derived from the digest: version 4 layout, all hex, stable for the same inputs.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export type RunAliasV2ProtectedOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  confirm?: string;
  waitSeconds?: number;
  pollMs?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

function buildRunRequest(options: {
  freeze: AliasV2Freeze;
  approval: AliasV2Approval;
  plan: JsonObject;
  requestId: string;
}): JsonObject {
  return buildAliasV2PreflightRequest({
    requestId: options.requestId,
    environment: 'production',
    projectRef: options.freeze.project_ref,
    actor: { user_id: options.freeze.account.user_id, email: options.freeze.account.email },
    plan: options.plan,
    freeze: {
      schema_version: options.freeze.schema_version,
      freeze_sha256: options.freeze.freeze_sha256,
    },
    approval: {
      schema_version: options.approval.schema_version,
      approval_identity_sha256: options.approval.approval_identity_sha256,
      approved_at_utc: options.approval.approved_at_utc,
    },
    bindings: options.freeze.bindings,
    expected: {
      counts: options.freeze.counts,
      closure: options.freeze.expected_closure,
    },
    derivativeTargets: options.freeze.derivative_targets as JsonObject[],
  });
}

function assertFreezeBindings(options: {
  plan: JsonObject;
  planFileSha256: string;
  freeze: AliasV2Freeze;
  approvalFileSha256: string;
  approval: AliasV2Approval;
}): void {
  const { freeze, approval } = options;
  requires(
    freeze.schema_version === ALIAS_V2_PROTECTED_CONTRACT.freeze_schema,
    'Alias v2 run needs a dataset-alias-execution-freeze.v2 seal.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    approval.schema_version === ALIAS_V2_PROTECTED_CONTRACT.approval_schema,
    'Alias v2 run needs a dataset-alias-execution-approval.v2 artefact.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    freeze.plan.plan_sha256 === options.plan['plan_sha256'] &&
      freeze.plan.plan_file_sha256 === options.planFileSha256,
    'Alias v2 freeze must bind this exact plan file and digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    sha256Json(freeze.counts) === sha256Json(options.plan['counts']),
    'Alias v2 freeze counts must equal the plan counts.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    approval.plan_sha256 === freeze.plan.plan_sha256 &&
      approval.freeze_sha256 === freeze.freeze_sha256 &&
      approval.freeze_file_sha256 !== '' &&
      approval.plan_file_sha256 === freeze.plan.plan_file_sha256,
    'Alias v2 approval must bind the freeze and the plan.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    approval.account.user_id === freeze.account.user_id &&
      approval.account.email === freeze.account.email &&
      approval.project_ref === freeze.project_ref,
    'Alias v2 approval and freeze must describe the same owner and project.',
    ALIAS_V2_RESPONSE_INVALID,
  );
  requires(
    approval.approval_identity_sha256 ===
      sha256Json({ ...approval, approval_identity_sha256: undefined }),
    'Alias v2 approval identity must be its own content digest.',
    ALIAS_V2_RESPONSE_INVALID,
  );
}

/**
 * Runs one sealed v2 execution. The admission is posted at most once across every run of the
 * same plan and freeze: the attempt marker records it durably, and an unknown admission outcome
 * is only ever reconciled by the read stage.
 */
export async function runAliasV2Protected(
  options: RunAliasV2ProtectedOptions,
): Promise<AliasV2ProtectedReport> {
  requires(
    options.commit !== options.statusOnly,
    'Alias v2 run needs exactly one of commit or statusOnly.',
    'DATASET_MAINTENANCE_PROTECTED_MODE_REQUIRED',
  );
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const planArtifact = readJson(options.planPath, 'Alias v2 plan');
  const plan = assertAliasV2PlanDocument(planArtifact.value);
  const freezeArtifact = readJson(options.freezePath, 'Alias v2 freeze');
  const freeze = freezeArtifact.value as unknown as AliasV2Freeze;
  const approvalArtifact = readJson(options.approvalPath, 'Alias v2 approval');
  const approval = approvalArtifact.value as unknown as AliasV2Approval;
  assertFreezeBindings({
    plan,
    planFileSha256: planArtifact.file_sha256,
    freeze,
    approvalFileSha256: approvalArtifact.file_sha256,
    approval,
  });
  if (options.commit) {
    requires(
      options.confirm === freeze.account.email,
      'Alias v2 run --commit must be confirmed by the owner account email.',
      'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
    );
  }
  const requestId = aliasV2RequestId(
    freeze.plan.plan_sha256 as string,
    freeze.freeze_sha256 as string,
  );
  const request = buildRunRequest({ freeze, approval, plan, requestId });

  const waitSeconds = normalizeWaitSeconds(options.waitSeconds);
  const pollMs = normalizePollMs(options.pollMs);
  const nowMs = () => (options.now ?? new Date()).getTime();
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = nowMs() + waitSeconds * 1_000;
  const statusProgress = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.status_progress);
  const attemptPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.attempt);

  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // The attempt marker is the durable record of the one admission. It is written before the
  // admission is posted and rewritten afterwards, so an interrupted run can never post twice.
  let marker: AliasV2AttemptMarker | null = null;
  try {
    const existing = readProtectedJsonArtifact({
      filePath: attemptPath,
      label: 'Alias v2 attempt marker',
    });
    if (isJsonObject(existing.value)) {
      marker = existing.value as unknown as AliasV2AttemptMarker;
    }
  } catch {
    marker = null;
  }
  if (marker !== null) {
    requires(
      marker.plan_sha256 === freeze.plan.plan_sha256 &&
        marker.freeze_sha256 === freeze.freeze_sha256 &&
        marker.request_id === requestId &&
        marker.admission_posts === 1,
      'Alias v2 attempt marker belongs to a different execution.',
      'DATASET_MAINTENANCE_PROTECTED_MARKER_INVALID',
    );
  }

  let state: AliasV2Lifecycle = startAliasV2Lifecycle({
    requestId,
    planSha256: freeze.plan.plan_sha256 as string,
  });
  // An existing marker means the one admission was already posted: this run can only observe.
  const admissionPosted = marker !== null;
  if (admissionPosted) {
    state = { ...state, phase: 'admitted', admit_attempts: 1 };
  }

  const observe = (
    stage: 'preflight' | 'gate' | 'admit' | 'read',
    result: AliasV2StepResult,
  ): void => {
    appendFileSync(
      statusProgress,
      `${stableJsonText({ observed_at_utc: new Date(nowMs()).toISOString(), stage, result })}\n`,
      { mode: 0o600 },
    );
    state = advanceAliasV2Lifecycle(state, { stage, result });
  };
  const dispatch = async (
    stage: 'preflight' | 'gate' | 'admit' | 'read',
    call: () => Promise<unknown>,
  ): Promise<AliasV2StepResult> => {
    const outcome = await dispatchOutcome(call);
    const result =
      outcome.kind === 'refusal'
        ? {
            kind: 'refused' as const,
            status: outcome.status,
            code: outcome.code,
          }
        : classifyAliasV2Response({ stage, outcome, plan, request_id: requestId });
    observe(stage, result);
    return result;
  };

  const finish = (
    code: string | null,
    status: AliasV2ProtectedReport['status'],
  ): AliasV2ProtectedReport => {
    // Each run writes its own immutable report: evidence is append-only, never overwritten.
    const reportPath = path.join(outDir, `protected-v2-report-${nextReportIndex(outDir)}.json`);
    const report: AliasV2ProtectedReport = {
      schema_version: ALIAS_V2_PROTECTED_CONTRACT.report_schema,
      mode: options.commit ? 'commit' : 'status_only',
      status,
      phase: state.phase,
      request_id: requestId,
      plan_sha256: freeze.plan.plan_sha256 as string,
      counts: freeze.counts,
      code,
      admission_attempts: state.admit_attempts,
      polls: state.polls,
      read_attempts: state.read_attempts,
      gates: state.gates,
      report_path: reportPath,
    };
    writePrivateImmutableJson(reportPath, report);
    return report;
  };

  if (options.commit && !admissionPosted) {
    const preflight = await dispatch('preflight', () =>
      preflightMaintenanceAliasExecutionV2({ context, request }),
    );
    if (preflight.kind === 'refused') {
      return finish(preflight.code, 'failed');
    }
    // For this stage the classifier is total over {ok, refused}: the cast is the whole space.
    const token = (preflight as Extract<AliasV2StepResult, { kind: 'ok' }>).body['preflight_token'];
    if (typeof token !== 'string' || token === '') {
      fail('Alias v2 preflight must return its token.', ALIAS_V2_RESPONSE_INVALID);
    }
    for (const gateName of ALIAS_V2_GATE_NAMES) {
      const gate = await dispatch('gate', () =>
        captureMaintenanceAliasExecutionGateV2({
          context,
          requestId,
          preflightToken: token,
          gateName,
        }),
      );
      if (gate.kind === 'refused') {
        return finish(gate.code, 'failed');
      }
    }
    // The one admission. The marker is written first, so an interrupted run can only observe.
    writePrivateImmutableJson(attemptPath, {
      schema_version: ALIAS_V2_PROTECTED_CONTRACT.attempt_schema,
      request_id: requestId,
      plan_sha256: freeze.plan.plan_sha256,
      freeze_sha256: freeze.freeze_sha256,
      approval_identity_sha256: approval.approval_identity_sha256,
      posted_at_utc: new Date(nowMs()).toISOString(),
      admission_posts: 1,
    } satisfies AliasV2AttemptMarker);
    const admission = await dispatch('admit', () =>
      admitMaintenanceAliasExecutionV2({ context, request }),
    );
    if (admission.kind === 'refused') {
      return finish(admission.code, 'failed');
    }
  } else if (!admissionPosted) {
    // Status-only before any admission: there is nothing durable to read, and the run must not
    // create one.
    return finish(null, 'not_admitted');
  }

  // Only the read stage may follow: poll until the terminal proof, or until the deadline.
  while (!isAliasV2Terminal(state.phase)) {
    const read = await dispatch('read', () =>
      readMaintenanceAliasExecutionV2({ context, requestId }),
    );
    if (read.kind === 'applied' || read.kind === 'idempotent_replay') {
      return finish(null, 'passed');
    }
    if (read.kind === 'refused' || read.kind === 'not_applied') {
      return finish(state.code, 'failed');
    }
    if (nowMs() >= deadline) {
      return finish(ALIAS_V2_POLL_EXHAUSTED, 'indeterminate');
    }
    await sleep(Math.min(pollMs, Math.max(deadline - nowMs(), 0)));
  }
  return finish(state.code, 'indeterminate');
}

/** One immutable report file per run, numbered in the order the runs wrote them. */
function nextReportIndex(outDir: string): number {
  let index = 1;
  while (existsSync(path.join(outDir, `protected-v2-report-${index}.json`))) {
    index += 1;
  }
  return index;
}

export const __testInternals = {
  dispatchOutcome,
  normalizeEnvelope,
  parseMaybeJson,
  buildRunRequest,
  assertFreezeBindings,
  endpoints: ALIAS_V2_ENDPOINTS,
  UUID,
};
