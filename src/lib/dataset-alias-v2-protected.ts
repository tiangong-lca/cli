// Versioned (v2) protected artefacts and the protected run for the current Time alias cohort.
//
// The transport is the real one, versioned rather than replaced: the CLI freezes, seals the
// approval, then runs preflight -> the three gates -> one admission, after which the
// server-side queue reaches the private v2 executor through its service-only callback and the
// CLI only polls the read stage. There is no CLI-side execution call and no second admission.
//
// The protocol is v1's, versioned: the preflight request carries the complete plan, freeze,
// approval, bindings, expected counts and derivative targets; the admission carries exactly the
// five reviewed keys with the verified preflight proof digest and the three gate results; and
// every proof is parsed strictly against the frozen identity. Durable evidence reuses the same
// private-artifact owners as v1 (immutable writes, append-only ledgers) under versioned file
// names, and nonce material is never persisted — only its digest.

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
  ALIAS_V2_EXECUTION_NOT_APPLIED,
  ALIAS_V2_STATUS_PENDING,
  ALIAS_V2_STAGE_UNKNOWN,
  MAX_READBACK_ATTEMPTS,
  advanceAliasV2Lifecycle,
  classifyAliasV2Response,
  isAliasV2Terminal,
  startAliasV2Lifecycle,
  type AliasV2Lifecycle,
  type AliasV2StepResult,
} from './dataset-alias-v2-lifecycle.js';
import {
  ALIAS_V2_CLOCK_SKEW_MS,
  ALIAS_V2_GATES,
  buildAliasV2AdmitRequest,
  buildAliasV2ExecutionIdentity,
  buildAliasV2PreflightRequest,
  parseAliasV2AdmissionProof,
  parseAliasV2GateProof,
  parseAliasV2PreflightProof,
  type AliasV2ExecutionIdentity,
  type AliasV2Gate,
  type AliasV2GateResult,
} from './dataset-alias-v2-protected-contract.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';

type JsonValue = JsonObject;

export const ALIAS_V2_PROTECTED_CONTRACT = {
  freeze_schema: 'dataset-alias-execution-freeze.v2',
  approval_schema: 'dataset-alias-execution-approval.v2',
  approval_request_schema: 'dataset-alias-execution-approval-request.v2',
  submission_marker_schema: 'dataset-alias-execution-submission.v2',
  preflight_evidence_schema: 'dataset-alias-execution-preflight-evidence.v2',
  gate_receipt_schema: 'dataset-alias-execution-gate-receipt-record.v2',
  report_schema: 'dataset-alias-execution-report.v2',
} as const;

export const ALIAS_V2_PROTECTED_ARTIFACTS = {
  plan_file: 'alias-v2-plan.json',
  batch_file: 'alias-v2-batch.json',
  toolchain_evidence: 'protected-v2-toolchain-evidence.json',
  derivative_baselines: 'protected-v2-derivative-baselines.json',
  freeze: 'protected-v2-execution-freeze.json',
  approval_request: 'protected-v2-approval-request.json',
  approval_text: 'protected-v2-approval-request.txt',
  human_approval: 'protected-v2-human-approval.txt',
  approval: 'protected-v2-approval.json',
  preflight_evidence: 'protected-v2-preflight-evidence.json',
  gate_receipts: 'protected-v2-gate-receipts.jsonl',
  submission_marker: 'protected-v2-submission-marker.json',
  status_progress: 'protected-v2-status-progress.jsonl',
  report: 'protected-v2-report.json',
} as const;

/**
 * The eight bindings the freeze carries itself, mirroring v1's `sets`: the six derived ones
 * (plan/freeze/approval file and content digests) come from the artefacts at identity build time
 * and are never taken from the freeze's own text.
 */
export const ALIAS_V2_FREEZE_SETS = [
  'alias_plan_request_sha256',
  'before_hash_set_sha256',
  'desired_hash_set_sha256',
  'exchange_rewrite_set_sha256',
  'support_snapshot_set_sha256',
  'derivative_baseline_set_sha256',
  'derivative_target_set_sha256',
  'toolchain_evidence_sha256',
] as const;

export const ALIAS_V2_BINDING_KEYS = [
  'plan_file_sha256',
  'freeze_file_sha256',
  'freeze_sha256',
  'approval_file_sha256',
  'approval_identity_sha256',
  'approval_text_sha256',
  ...ALIAS_V2_FREEZE_SETS,
] as const;

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

export const ALIAS_V2_COUNT_KEYS = [
  'action_count',
  'flowproperty_count',
  'flow_count',
  'process_count',
  'exchange_count',
  'amount_field_count',
  'unrelated_exchange_count',
] as const;

const SHA256 = /^[a-f0-9]{64}$/u;

export type AliasV2Artifact<T> = {
  value: T;
  canonical_file_text: string;
  file_sha256: string;
};

export type AliasV2Account = { user_id: string; email: string };

export type AliasV2DerivativeTarget = {
  table: 'flows' | 'processes';
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  baseline_snapshot_sha256: string;
};

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
  derivative_targets: AliasV2DerivativeTarget[];
  expected_closure: JsonObject;
  sets: JsonObject;
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

export type AliasV2SubmissionMarker = {
  schema_version: typeof ALIAS_V2_PROTECTED_CONTRACT.submission_marker_schema;
  prepared_at_utc: string;
  request_id: string;
  identity_sha256: string;
  plan_sha256: string;
  actor: AliasV2Account;
  project_ref: string;
  preflight_proof_sha256: string;
  preflight_token_sha256: string;
  preflight_completed_at: string;
  preflight_expires_at: string;
  gate_results: Record<string, AliasV2GateResult>;
  gate_receipt_sha256: Record<string, string>;
  max_admit_posts: 1;
  automatic_retry: false;
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

function fail(message: string, code: string, exitCode = 1, details?: JsonObject): never {
  throw new CliError(message, { code, exitCode, ...(details ? { details } : {}) });
}
function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a lowercase sha256.`, 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  return value;
}
function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string.`, 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  return value;
}
function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    fail(
      `${label} must carry exactly ${keys.join(', ')}.`,
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
}
function canonical(value: unknown): string {
  return `${stableJsonText(value)}\n`;
}
function artifactOf<T>(value: T): AliasV2Artifact<T> {
  const text = canonical(value);
  return { value, canonical_file_text: text, file_sha256: sha256Text(text) };
}
function accountOf(value: unknown, label: string): AliasV2Account {
  if (!isJsonObject(value)) {
    fail(`${label} must be an object.`, 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(value, ['user_id', 'email'], label);
  return {
    user_id: token(value['user_id'], `${label}.user_id`),
    email: token(value['email'], `${label}.email`),
  };
}
function countsOf(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    fail(`${label} must be an object.`, 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(value, ALIAS_V2_COUNT_KEYS, label);
  for (const key of ALIAS_V2_COUNT_KEYS) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      fail(
        `${label}.${key} must be a non-negative safe integer.`,
        'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        2,
      );
    }
  }
  return value;
}
function setsOf(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    fail('Alias v2 freeze sets must be an object.', 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(value, ALIAS_V2_FREEZE_SETS, 'freeze.sets');
  return Object.fromEntries(
    ALIAS_V2_FREEZE_SETS.map((key) => {
      const digest = value[key];
      if (typeof digest !== 'string' || !SHA256.test(digest)) {
        fail(
          `freeze.sets.${key} must be a lowercase sha256.`,
          'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
          2,
        );
      }
      return [key, digest];
    }),
  );
}
function derivativeTargetsOf(value: unknown): AliasV2DerivativeTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      'Alias v2 freeze requires its derivative targets.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  return value.map((entry, index) => {
    if (!isJsonObject(entry)) {
      fail(
        `freeze.derivative_targets[${index}] must be an object.`,
        'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        2,
      );
    }
    exactKeys(
      entry,
      ['table', 'id', 'version', 'user_id', 'state_code', 'baseline_snapshot_sha256'],
      `freeze.derivative_targets[${index}]`,
    );
    if (entry['table'] !== 'flows' && entry['table'] !== 'processes') {
      fail(
        `freeze.derivative_targets[${index}].table must be flows or processes.`,
        'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        2,
      );
    }
    if (entry['state_code'] !== 0) {
      fail(
        `freeze.derivative_targets[${index}].state_code must be 0.`,
        'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        2,
      );
    }
    return {
      table: entry['table'],
      id: token(entry['id'], `freeze.derivative_targets[${index}].id`),
      version: token(entry['version'], `freeze.derivative_targets[${index}].version`),
      user_id: token(entry['user_id'], `freeze.derivative_targets[${index}].user_id`),
      state_code: 0,
      baseline_snapshot_sha256: hash(
        entry['baseline_snapshot_sha256'],
        `freeze.derivative_targets[${index}].baseline_snapshot_sha256`,
      ),
    };
  });
}

/** The plan document a v2 freeze can bind: the reviewed plan schema with a plan digest. */
export function assertAliasV2PlanDocument(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    fail('Alias v2 plan artefact must be a JSON object.', 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  if (value['schema_version'] !== 'dataset-alias-plan.v2') {
    fail(
      'Alias v2 plan artefact must be dataset-alias-plan.v2.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  hash(value['plan_sha256'], 'plan.plan_sha256');
  if (!Array.isArray(value['actions']) || value['actions'].length === 0) {
    fail(
      'Alias v2 plan artefact must carry its actions.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  countsOf(value['counts'], 'plan.counts');
  if (!isJsonObject(value['target_snapshots']) || !isJsonObject(value['source_evidence'])) {
    fail(
      'Alias v2 plan artefact must carry its target snapshots and source evidence.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  return value;
}

/** Parses a v2 freeze and proves its content identity is its own digest. */
export function parseAliasV2Freeze(value: unknown): AliasV2Freeze {
  if (!isJsonObject(value)) {
    fail('Alias v2 freeze must be a JSON object.', 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(
    value,
    [
      'schema_version',
      'environment',
      'project_ref',
      'account',
      'target_visibility',
      'plan',
      'counts',
      'target_snapshots',
      'source_evidence',
      'derivative_targets',
      'expected_closure',
      'sets',
      'policy',
      'freeze_sha256',
    ],
    'freeze',
  );
  if (
    value['schema_version'] !== ALIAS_V2_PROTECTED_CONTRACT.freeze_schema ||
    value['environment'] !== 'production' ||
    value['target_visibility'] !== 'owner_draft'
  ) {
    fail(
      'Alias v2 freeze must be a production owner-draft freeze.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  if (!isJsonObject(value['plan'])) {
    fail(
      'Alias v2 freeze plan binding must be an object.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  exactKeys(value['plan'], ['plan_file_sha256', 'plan_sha256'], 'freeze.plan');
  const policy = value['policy'];
  if (!isJsonObject(policy)) {
    fail('Alias v2 freeze policy must be an object.', 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(policy, Object.keys(ALIAS_V2_FREEZE_POLICY), 'freeze.policy');
  for (const [key, expected] of Object.entries(ALIAS_V2_FREEZE_POLICY)) {
    if (policy[key] !== expected) {
      fail(
        `freeze.policy.${key} must be ${String(expected)}.`,
        'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        2,
      );
    }
  }
  const freeze: AliasV2Freeze = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: token(value['project_ref'], 'freeze.project_ref'),
    account: accountOf(value['account'], 'freeze.account'),
    target_visibility: 'owner_draft',
    plan: {
      plan_file_sha256: hash(
        (value['plan'] as JsonObject)['plan_file_sha256'],
        'freeze.plan.plan_file_sha256',
      ),
      plan_sha256: hash((value['plan'] as JsonObject)['plan_sha256'], 'freeze.plan.plan_sha256'),
    },
    counts: countsOf(value['counts'], 'freeze.counts'),
    target_snapshots: value['target_snapshots'] as JsonObject,
    source_evidence: value['source_evidence'] as JsonObject,
    derivative_targets: derivativeTargetsOf(value['derivative_targets']),
    expected_closure: value['expected_closure'] as JsonObject,
    sets: setsOf(value['sets']),
    policy: ALIAS_V2_FREEZE_POLICY,
    freeze_sha256: hash(value['freeze_sha256'], 'freeze.freeze_sha256'),
  };
  if (freeze.freeze_sha256 !== sha256Json({ ...freeze, freeze_sha256: undefined })) {
    fail(
      'Alias v2 freeze content does not match its own digest.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  return freeze;
}

/** Parses a v2 approval and proves its content identity is its own digest. */
export function parseAliasV2Approval(value: unknown): AliasV2Approval {
  if (!isJsonObject(value)) {
    fail('Alias v2 approval must be a JSON object.', 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID', 2);
  }
  exactKeys(
    value,
    [
      'schema_version',
      'approved_at_utc',
      'environment',
      'project_ref',
      'account',
      'target_visibility',
      'plan_sha256',
      'plan_file_sha256',
      'freeze_file_sha256',
      'freeze_sha256',
      'approval_text_sha256',
      'max_admit_posts',
      'automatic_retry',
      'approval_identity_sha256',
    ],
    'approval',
  );
  if (
    value['schema_version'] !== ALIAS_V2_PROTECTED_CONTRACT.approval_schema ||
    value['environment'] !== 'production' ||
    value['target_visibility'] !== 'owner_draft' ||
    value['max_admit_posts'] !== 1 ||
    value['automatic_retry'] !== false
  ) {
    fail(
      'Alias v2 approval must be a one-shot production owner-draft approval.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  const approval: AliasV2Approval = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.approval_schema,
    approved_at_utc: token(value['approved_at_utc'], 'approval.approved_at_utc'),
    environment: 'production',
    project_ref: token(value['project_ref'], 'approval.project_ref'),
    account: accountOf(value['account'], 'approval.account'),
    target_visibility: 'owner_draft',
    plan_sha256: hash(value['plan_sha256'], 'approval.plan_sha256'),
    plan_file_sha256: hash(value['plan_file_sha256'], 'approval.plan_file_sha256'),
    freeze_file_sha256: hash(value['freeze_file_sha256'], 'approval.freeze_file_sha256'),
    freeze_sha256: hash(value['freeze_sha256'], 'approval.freeze_sha256'),
    approval_text_sha256: hash(value['approval_text_sha256'], 'approval.approval_text_sha256'),
    max_admit_posts: 1,
    automatic_retry: false,
    approval_identity_sha256: hash(
      value['approval_identity_sha256'],
      'approval.approval_identity_sha256',
    ),
  };
  if (
    approval.approval_identity_sha256 !==
    sha256Json({ ...approval, approval_identity_sha256: undefined })
  ) {
    fail(
      'Alias v2 approval content does not match its own identity.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  return approval;
}

/** Parses a v2 approval request and proves its own digest. */
export function parseAliasV2ApprovalRequest(value: unknown): AliasV2ApprovalRequest {
  if (!isJsonObject(value)) {
    fail(
      'Alias v2 approval request must be a JSON object.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  exactKeys(
    value,
    [
      'schema_version',
      'environment',
      'project_ref',
      'account',
      'plan_sha256',
      'plan_file_sha256',
      'freeze_file_sha256',
      'freeze_sha256',
      'counts',
      'request_sha256',
      'approval_text',
      'approval_text_sha256',
    ],
    'approval request',
  );
  if (
    value['schema_version'] !== ALIAS_V2_PROTECTED_CONTRACT.approval_request_schema ||
    value['environment'] !== 'production'
  ) {
    fail(
      'Alias v2 approval request must be a production request.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  const request: AliasV2ApprovalRequest = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.approval_request_schema,
    environment: 'production',
    project_ref: token(value['project_ref'], 'approval_request.project_ref'),
    account: accountOf(value['account'], 'approval_request.account'),
    plan_sha256: hash(value['plan_sha256'], 'approval_request.plan_sha256'),
    plan_file_sha256: hash(value['plan_file_sha256'], 'approval_request.plan_file_sha256'),
    freeze_file_sha256: hash(value['freeze_file_sha256'], 'approval_request.freeze_file_sha256'),
    freeze_sha256: hash(value['freeze_sha256'], 'approval_request.freeze_sha256'),
    counts: countsOf(value['counts'], 'approval_request.counts'),
    request_sha256: hash(value['request_sha256'], 'approval_request.request_sha256'),
    approval_text: token(value['approval_text'], 'approval_request.approval_text'),
    approval_text_sha256: hash(
      value['approval_text_sha256'],
      'approval_request.approval_text_sha256',
    ),
  };
  const core = {
    schema_version: request.schema_version,
    environment: request.environment,
    project_ref: request.project_ref,
    account: request.account,
    plan_sha256: request.plan_sha256,
    plan_file_sha256: request.plan_file_sha256,
    freeze_file_sha256: request.freeze_file_sha256,
    freeze_sha256: request.freeze_sha256,
    counts: request.counts,
  };
  if (
    request.request_sha256 !== sha256Json(core) ||
    request.approval_text_sha256 !== sha256Text(request.approval_text)
  ) {
    fail(
      'Alias v2 approval request content does not match its own digests.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  return request;
}

/** A parsed artefact must be exactly the text the file holds: no reformatting, no drift. */
export function assertAliasV2CanonicalArtifact(options: {
  label: string;
  text: string;
  value: unknown;
}): void {
  if (canonical(options.value) !== options.text) {
    fail(
      `${options.label} bytes are not the canonical serialisation of its content.`,
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
}

/**
 * The reviewed target binding: the freeze must describe exactly this plan file and content, and
 * the approval must bind exactly this freeze file and content with the operator's explicit hash.
 */
export function assertAliasV2Bindings(options: {
  plan: JsonObject;
  planFileSha256: string;
  freeze: AliasV2Freeze;
  freezeFileSha256: string;
  approval: AliasV2Approval;
  approvalFileSha256: string;
  approveExecution?: string;
}): AliasV2ExecutionIdentity {
  const { freeze, approval } = options;
  if (
    freeze.plan.plan_file_sha256 !== options.planFileSha256 ||
    freeze.plan.plan_sha256 !== options.plan['plan_sha256'] ||
    sha256Json(freeze.counts) !== sha256Json(options.plan['counts']) ||
    sha256Json(freeze.target_snapshots) !== sha256Json(options.plan['target_snapshots']) ||
    sha256Json(freeze.source_evidence) !== sha256Json(options.plan['source_evidence'])
  ) {
    fail(
      'Alias v2 freeze does not bind this exact plan file, content, counts and snapshots.',
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      2,
    );
  }
  if (
    approval.environment !== freeze.environment ||
    approval.project_ref !== freeze.project_ref ||
    approval.account.user_id !== freeze.account.user_id ||
    approval.account.email !== freeze.account.email ||
    approval.plan_sha256 !== freeze.plan.plan_sha256 ||
    approval.plan_file_sha256 !== freeze.plan.plan_file_sha256 ||
    approval.freeze_file_sha256 !== options.freezeFileSha256 ||
    approval.freeze_sha256 !== freeze.freeze_sha256 ||
    approval.approval_identity_sha256 !== options.approveExecution
  ) {
    fail(
      'Alias v2 approval does not bind this exact production freeze, plan, actor and CLI confirmation.',
      'ALIAS_V2_PROTECTED_APPROVAL_MISMATCH',
      2,
    );
  }
  hash(options.approvalFileSha256, 'approval_file_sha256');
  return buildAliasV2ExecutionIdentity({
    freeze,
    approval,
    freezeFileSha256: options.freezeFileSha256,
    approvalFileSha256: options.approvalFileSha256,
  });
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export function buildAliasV2Freeze(options: {
  plan: JsonObject;
  planFileSha256: string;
  projectRef: string;
  account: AliasV2Account;
  sets: JsonObject;
  derivativeTargets: JsonValue[];
  expectedClosure: JsonObject;
}): AliasV2Artifact<AliasV2Freeze> {
  const plan = assertAliasV2PlanDocument(options.plan);
  hash(options.planFileSha256, 'planFileSha256');
  token(options.projectRef, 'projectRef');
  const candidate: AliasV2Freeze = {
    schema_version: ALIAS_V2_PROTECTED_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: options.projectRef,
    account: accountOf(options.account, 'account'),
    target_visibility: 'owner_draft',
    plan: { plan_file_sha256: options.planFileSha256, plan_sha256: plan['plan_sha256'] as string },
    counts: plan['counts'] as JsonObject,
    target_snapshots: plan['target_snapshots'] as JsonObject,
    source_evidence: plan['source_evidence'] as JsonObject,
    derivative_targets: derivativeTargetsOf(options.derivativeTargets),
    expected_closure: options.expectedClosure,
    sets: setsOf(options.sets),
    policy: ALIAS_V2_FREEZE_POLICY,
    freeze_sha256: '',
  };
  candidate.freeze_sha256 = sha256Json({ ...candidate, freeze_sha256: undefined });
  return artifactOf(candidate);
}

export function buildAliasV2ApprovalRequest(options: {
  freeze: AliasV2Freeze;
  freezeFileSha256: string;
  approvedAtUtc: string;
}): AliasV2Artifact<AliasV2ApprovalRequest> {
  const { freeze } = options;
  hash(options.freezeFileSha256, 'freezeFileSha256');
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
  return artifactOf({
    ...core,
    request_sha256: sha256Json(core),
    approval_text: approvalText,
    approval_text_sha256: sha256Text(approvalText),
  });
}

export function sealAliasV2Approval(options: {
  request: AliasV2ApprovalRequest;
  requestFileSha256: string;
  humanApprovalText: string;
  approvals: { plan: string; freeze: string; request: string; text: string };
  confirm: string;
  approvedAtUtc: string;
}): AliasV2Artifact<AliasV2Approval> {
  const { request } = options;
  hash(options.requestFileSha256, 'requestFileSha256');
  if (options.confirm !== request.account.email) {
    fail(
      'Alias v2 approval must be confirmed by the owner account email.',
      'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
      2,
    );
  }
  if (
    options.approvals.plan !== request.plan_sha256 ||
    options.approvals.freeze !== request.freeze_sha256 ||
    options.approvals.request !== options.requestFileSha256 ||
    options.approvals.text !== request.approval_text_sha256
  ) {
    fail(
      'Alias v2 approval confirmations must match the request exactly.',
      'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
      2,
    );
  }
  // The human approval text must be exactly the request's text: the operator approves the words
  // the request carries, not a paraphrase.
  if (sha256Text(options.humanApprovalText) !== request.approval_text_sha256) {
    fail(
      'Alias v2 human approval text must equal the approval request text exactly.',
      'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
      2,
    );
  }
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

// ---------------------------------------------------------------------------------------------
// The protected run
// ---------------------------------------------------------------------------------------------

export type RunAliasV2ProtectedOptions = {
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
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWaitSeconds(value: number | undefined): number {
  const seconds = value ?? 900;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
    fail(
      'Alias v2 run waitSeconds must be an integer between 0 and 86400.',
      'DATASET_MAINTENANCE_PROTECTED_WAIT_INVALID',
      2,
    );
  }
  return seconds;
}
function normalizePollMs(value: number | undefined): number {
  const poll = value ?? 1_000;
  if (!Number.isInteger(poll) || poll < 100 || poll > 60_000) {
    fail(
      'Alias v2 run pollMs must be an integer between 100 and 60000.',
      'DATASET_MAINTENANCE_PROTECTED_POLL_INVALID',
      2,
    );
  }
  return poll;
}

const HTTP_STATUS = /^HTTP (\d{3}) returned from/u;

type DispatchOutcome =
  /** `raw` is the response exactly as the server sent it (the strict proof parsers read it);
   * `body` is the unwrapped payload the plan-bound read classification works on. */
  | { kind: 'response'; status: number; body: unknown; raw: unknown }
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
    const carriedValue = parseMaybeJson(carried);
    const normalized = normalizeEnvelope(carriedValue);
    if (normalized.kind === 'refusal') {
      return { ...normalized, status: Number(status[1]) };
    }
    return {
      kind: 'response',
      status: Number(status[1]),
      body: normalized.body,
      raw: carriedValue,
    };
  }
  const normalized = normalizeEnvelope(raw);
  return normalized.kind === 'payload'
    ? { kind: 'response', status: 200, body: normalized.body, raw }
    : normalized;
}

type MarkerState =
  | { state: 'absent' }
  | { state: 'present'; marker: AliasV2SubmissionMarker }
  | { state: 'unreadable'; reason: string };

/**
 * Reads the submission marker. Only a proved absent path means "no admission was posted":
 * a corrupt, foreign or unreadable marker is never silently treated as absent, because that
 * would authorise a second admission or claim a false no-admission.
 */
function readMarkerState(markerPath: string): MarkerState {
  if (!existsSync(markerPath)) {
    return { state: 'absent' };
  }
  try {
    const artifact = readProtectedJsonArtifact({
      filePath: markerPath,
      label: 'Alias v2 submission marker',
    });
    const value = artifact.value;
    if (
      !isJsonObject(value) ||
      value['schema_version'] !== ALIAS_V2_PROTECTED_CONTRACT.submission_marker_schema
    ) {
      return { state: 'unreadable', reason: 'schema' };
    }
    return {
      state: 'present',
      marker: {
        schema_version: ALIAS_V2_PROTECTED_CONTRACT.submission_marker_schema,
        prepared_at_utc: token(value['prepared_at_utc'], 'marker.prepared_at_utc'),
        request_id: token(value['request_id'], 'marker.request_id'),
        identity_sha256: hash(value['identity_sha256'], 'marker.identity_sha256'),
        plan_sha256: hash(value['plan_sha256'], 'marker.plan_sha256'),
        actor: accountOf(value['actor'], 'marker.actor'),
        project_ref: token(value['project_ref'], 'marker.project_ref'),
        preflight_proof_sha256: hash(
          value['preflight_proof_sha256'],
          'marker.preflight_proof_sha256',
        ),
        preflight_token_sha256: hash(
          value['preflight_token_sha256'],
          'marker.preflight_token_sha256',
        ),
        preflight_completed_at: token(
          value['preflight_completed_at'],
          'marker.preflight_completed_at',
        ),
        preflight_expires_at: token(value['preflight_expires_at'], 'marker.preflight_expires_at'),
        gate_results: value['gate_results'] as Record<string, AliasV2GateResult>,
        gate_receipt_sha256: value['gate_receipt_sha256'] as Record<string, string>,
        max_admit_posts: 1,
        automatic_retry: false,
      },
    };
  } catch (error) {
    return { state: 'unreadable', reason: errorDetails(error) };
  }
}

function nextReportIndex(outDir: string): number {
  let index = 1;
  while (existsSync(path.join(outDir, `protected-v2-report-${index}.json`))) {
    index += 1;
  }
  return index;
}

/**
 * Runs one sealed v2 execution. Nothing reaches the network until the local artefacts prove the
 * exact plan/freeze/approval binding and the operator's explicit confirmation; the admission is
 * posted at most once across every run of the same execution; and an unknown admission outcome
 * is only ever reconciled by the authoritative read path.
 */
export async function runAliasV2Protected(
  options: RunAliasV2ProtectedOptions,
): Promise<AliasV2ProtectedReport> {
  if (options.commit === options.statusOnly) {
    fail(
      'Alias v2 run needs exactly one of commit or statusOnly.',
      'DATASET_MAINTENANCE_PROTECTED_MODE_REQUIRED',
      2,
    );
  }
  const waitSeconds = normalizeWaitSeconds(options.waitSeconds);
  const pollMs = normalizePollMs(options.pollMs);
  // Local preconditions: the exact approval hash and account email before any remote work.
  if (
    options.commit &&
    (typeof options.approveExecution !== 'string' ||
      !SHA256_PATTERN.test(options.approveExecution) ||
      typeof options.confirm !== 'string' ||
      options.confirm.trim() === '')
  ) {
    fail(
      'Alias v2 commit requires the exact approval hash and account email.',
      'DATASET_MAINTENANCE_PROTECTED_APPROVAL_REQUIRED',
      2,
    );
  }

  // ---- local artefacts: read, parse strictly, and prove the binding before any fetch ----
  const planArtifact = readProtectedJsonArtifact({
    filePath: options.planPath,
    label: 'Alias v2 plan',
  });
  const plan = assertAliasV2PlanDocument(planArtifact.value);
  const freezeArtifact = readProtectedJsonArtifact({
    filePath: options.freezePath,
    label: 'Alias v2 freeze',
  });
  const freeze = parseAliasV2Freeze(freezeArtifact.value);
  assertAliasV2CanonicalArtifact({
    label: 'Alias v2 freeze',
    text: freezeArtifact.text,
    value: freeze,
  });
  const approvalArtifact = readProtectedJsonArtifact({
    filePath: options.approvalPath,
    label: 'Alias v2 approval',
  });
  const approval = parseAliasV2Approval(approvalArtifact.value);
  assertAliasV2CanonicalArtifact({
    label: 'Alias v2 approval',
    text: approvalArtifact.text,
    value: approval,
  });
  if (options.commit) {
    token(options.confirm, 'confirm');
  }
  const identity = assertAliasV2Bindings({
    plan,
    planFileSha256: planArtifact.file_sha256,
    freeze,
    freezeFileSha256: freezeArtifact.file_sha256,
    approval,
    approvalFileSha256: approvalArtifact.file_sha256,
    ...(options.statusOnly
      ? { approveExecution: approval.approval_identity_sha256 }
      : { approveExecution: options.approveExecution }),
  });

  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const statusProgress = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.status_progress);
  const markerPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.submission_marker);
  const markerState = readMarkerState(markerPath);
  if (markerState.state === 'present') {
    const marker = markerState.marker;
    if (
      marker.request_id !== identity.request_id ||
      marker.plan_sha256 !== identity.plan_sha256 ||
      marker.identity_sha256 !== identity.identity_sha256
    ) {
      fail(
        'Alias v2 submission marker belongs to a different execution.',
        'DATASET_MAINTENANCE_PROTECTED_MARKER_INVALID',
        1,
      );
    }
  }

  let state: AliasV2Lifecycle = startAliasV2Lifecycle({
    requestId: identity.request_id,
    planSha256: identity.plan_sha256,
  });
  // A present marker proves one admission was posted; an unreadable one cannot prove the
  // opposite, so it is treated conservatively as posted and the run only observes.
  const admissionPosted = markerState.state !== 'absent';
  if (admissionPosted) {
    state =
      markerState.state === 'unreadable'
        ? { ...state, phase: 'readback_required', admit_attempts: 1, code: ALIAS_V2_STAGE_UNKNOWN }
        : { ...state, phase: 'admitted', admit_attempts: 1 };
  }

  // ---- remote context, then the fresh actor/project match, before any stage call ----
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (
    context.project_ref !== identity.project_ref ||
    context.account.user_id !== identity.actor.user_id ||
    context.account.email !== identity.actor.email ||
    (options.commit && options.confirm !== context.account.email)
  ) {
    fail(
      'Authenticated RLS context does not match the sealed production project, actor, and confirmation.',
      'DATASET_MAINTENANCE_PROTECTED_CONTEXT_MISMATCH',
      1,
      {
        expected_project_ref: identity.project_ref,
        observed_project_ref: context.project_ref,
        expected_user_id: identity.actor.user_id,
        observed_user_id: context.account.user_id,
      },
    );
  }

  const startedAtMs = (options.now ?? new Date()).getTime();
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Deterministic progress: with an injected fixed clock the wall clock never advances, so the
  // deadline is measured in observed polls instead — polling can never become unbounded.
  const elapsedMs = (): number =>
    options.now === undefined
      ? Date.now() - startedAtMs
      : state.polls * pollMs + state.read_attempts * pollMs;

  const observe = (stage: string, result: AliasV2StepResult): void => {
    appendFileSync(
      statusProgress,
      `${stableJsonText({ observed_at_utc: new Date(startedAtMs + elapsedMs()).toISOString(), stage, result })}\n`,
      { mode: 0o600 },
    );
    state = advanceAliasV2Lifecycle(state, {
      stage: stage as 'preflight' | 'gate' | 'admit' | 'read',
      result,
    });
  };
  const finish = (
    code: string | null,
    status: AliasV2ProtectedReport['status'],
  ): AliasV2ProtectedReport => {
    const reportPath = path.join(outDir, `protected-v2-report-${nextReportIndex(outDir)}.json`);
    const report: AliasV2ProtectedReport = {
      schema_version: ALIAS_V2_PROTECTED_CONTRACT.report_schema,
      mode: options.commit ? 'commit' : 'status_only',
      status,
      phase: state.phase,
      request_id: identity.request_id,
      plan_sha256: identity.plan_sha256,
      counts: identity.counts,
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
  const appendReceipt = (value: unknown): void => {
    appendFileSync(
      path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.gate_receipts),
      `${stableJsonText(value)}\n`,
      {
        mode: 0o600,
      },
    );
  };
  const clock = (): Date => new Date(startedAtMs + elapsedMs());

  if (options.commit && !admissionPosted) {
    const preflightRequest = buildAliasV2PreflightRequest({ identity, plan, freeze, approval });
    const raw = await dispatchOutcome(() =>
      preflightMaintenanceAliasExecutionV2({ context, request: preflightRequest }),
    );
    if (raw.kind === 'unknown') {
      return finish(ALIAS_V2_STAGE_UNKNOWN, 'indeterminate');
    }
    if (raw.kind === 'refusal') {
      return finish(raw.code, 'failed');
    }
    if (raw.status !== 200) {
      return finish(`ALIAS_V2_PREFLIGHT_HTTP_${raw.status}`, 'failed');
    }
    let preflight;
    try {
      preflight = parseAliasV2PreflightProof(raw.raw, identity, clock());
    } catch (error) {
      return finish(errorDetails(error), 'failed');
    }
    // The strict parse above is the real validation; observing it advances the reviewed state
    // machine, which is what forbids a second admission and any stage out of order.
    observe('preflight', { kind: 'ok', stage: 'preflight', body: {} });
    const { preflight_token: preflightToken, ...preflightEvidence } = preflight;
    writePrivateImmutableJson(path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.preflight_evidence), {
      schema_version: ALIAS_V2_PROTECTED_CONTRACT.preflight_evidence_schema,
      proof: preflightEvidence,
      preflight_token_sha256: sha256Text(preflightToken),
      raw_response_sha256: sha256Json(raw.raw),
    });

    const gateResults = {} as Record<AliasV2Gate, AliasV2GateResult>;
    const receiptShas: Record<string, string> = {};
    for (const gate of ALIAS_V2_GATES) {
      const gateRaw = await dispatchOutcome(() =>
        captureMaintenanceAliasExecutionGateV2({
          context,
          requestId: identity.request_id,
          preflightToken,
          gateName: gate,
        }),
      );
      if (gateRaw.kind !== 'response' || gateRaw.status !== 200) {
        return finish(
          gateRaw.kind === 'refusal'
            ? gateRaw.code
            : `ALIAS_V2_GATE_HTTP_${gateRaw.kind === 'response' ? gateRaw.status : 0}_${gate}`,
          'failed',
        );
      }
      let gateProof;
      try {
        gateProof = parseAliasV2GateProof(gateRaw.raw, { identity, preflight, gate });
      } catch (error) {
        return finish(errorDetails(error), 'failed');
      }
      appendReceipt({
        schema_version: ALIAS_V2_PROTECTED_CONTRACT.gate_receipt_schema,
        observed_at_utc: clock().toISOString(),
        proof: gateProof,
        raw_response_sha256: sha256Json(gateRaw.raw),
      });
      observe('gate', { kind: 'ok', stage: 'gate', body: { gate_name: gate } });
      gateResults[gate] = gateProof.result;
      receiptShas[gate] = gateProof.receipt_sha256;
    }

    // The submission marker is written before the admission: it is the durable proof that the
    // single POST was issued, and it never stores the raw token.
    writePrivateImmutableJson(markerPath, {
      schema_version: ALIAS_V2_PROTECTED_CONTRACT.submission_marker_schema,
      prepared_at_utc: clock().toISOString(),
      request_id: identity.request_id,
      identity_sha256: identity.identity_sha256,
      plan_sha256: identity.plan_sha256,
      actor: identity.actor,
      project_ref: identity.project_ref,
      preflight_proof_sha256: preflight.preflight_proof_sha256,
      preflight_token_sha256: sha256Text(preflightToken),
      preflight_completed_at: preflight.completed_at,
      preflight_expires_at: preflight.expires_at,
      gate_results: gateResults,
      gate_receipt_sha256: receiptShas,
      max_admit_posts: 1,
      automatic_retry: false,
    } satisfies AliasV2SubmissionMarker);

    const admissionRaw = await dispatchOutcome(() =>
      admitMaintenanceAliasExecutionV2({
        context,
        request: buildAliasV2AdmitRequest({ preflight, gateResults }),
      }),
    );
    if (admissionRaw.kind === 'unknown') {
      observe('admit', {
        kind: 'readback_required',
        code: ALIAS_V2_STAGE_UNKNOWN,
        reason: admissionRaw.reason,
      });
    } else if (admissionRaw.kind === 'refusal') {
      observe('admit', { kind: 'refused', status: admissionRaw.status, code: admissionRaw.code });
      return finish(admissionRaw.code, 'failed');
    } else if (admissionRaw.status !== 200) {
      observe('admit', {
        kind: 'refused',
        status: admissionRaw.status,
        code: `ALIAS_V2_ADMIT_HTTP_${admissionRaw.status}`,
      });
      return finish(`ALIAS_V2_ADMIT_HTTP_${admissionRaw.status}`, 'failed');
    } else {
      try {
        parseAliasV2AdmissionProof(admissionRaw.raw, identity, preflight);
        observe('admit', { kind: 'ok', stage: 'admit', body: {} });
      } catch (error) {
        observe('admit', {
          kind: 'readback_required',
          code: ALIAS_V2_STAGE_UNKNOWN,
          reason: errorDetails(error),
        });
      }
    }
  }

  // ---- the read stage: the only stage that may follow, in every mode ----
  if (!admissionPosted && options.statusOnly) {
    // Status-only without a marker still consults the authoritative read path: a fresh outDir
    // must never be able to claim "not admitted" on its own.
    const readOutcome = await dispatchOutcome(() =>
      readMaintenanceAliasExecutionV2({ context, requestId: identity.request_id }),
    );
    if (readOutcome.kind === 'unknown') {
      return finish(readOutcome.reason, 'indeterminate');
    }
    if (readOutcome.kind === 'refusal') {
      return finish(readOutcome.code, 'failed');
    }
    const classified = classifyAliasV2Response({
      stage: 'read',
      outcome: { kind: 'response', status: readOutcome.status, body: readOutcome.body },
      plan,
      request_id: identity.request_id,
    });
    if (classified.kind === 'not_applied') {
      return finish(null, 'not_admitted');
    }
    if (classified.kind === 'applied' || classified.kind === 'idempotent_replay') {
      state = { ...state, phase: classified.kind === 'applied' ? 'applied' : 'idempotent_replay' };
      return finish(null, 'passed');
    }
    if (classified.kind === 'refused') {
      return finish(classified.code, 'failed');
    }
    return finish(ALIAS_V2_STAGE_UNKNOWN, 'indeterminate');
  }

  // The read stage runs for an admitted execution and equally after an unknown admission: a
  // readback-required state still has to ask the server what actually happened. The loop is
  // bounded by the readback attempt budget, and every path inside it returns, so the run never
  // leaves the read stage through anything but a published outcome.
  while (
    !isAliasV2Terminal(state.phase) ||
    (state.phase === 'readback_required' && state.read_attempts < MAX_READBACK_ATTEMPTS)
  ) {
    const readOutcome = await dispatchOutcome(() =>
      readMaintenanceAliasExecutionV2({ context, requestId: identity.request_id }),
    );
    let classified: AliasV2StepResult;
    if (readOutcome.kind === 'unknown') {
      classified = {
        kind: 'readback_required',
        code: ALIAS_V2_STAGE_UNKNOWN,
        reason: readOutcome.reason,
      };
    } else if (readOutcome.kind === 'refusal') {
      classified = { kind: 'refused', status: readOutcome.status, code: readOutcome.code };
    } else {
      classified = classifyAliasV2Response({
        stage: 'read',
        outcome: { kind: 'response', status: readOutcome.status, body: readOutcome.body },
        plan,
        request_id: identity.request_id,
      });
    }
    observe('read', classified);
    if (classified.kind === 'applied' || classified.kind === 'idempotent_replay') {
      return finish(null, 'passed');
    }
    if (classified.kind === 'not_applied') {
      // The read lifecycle records this exact refusal as it observes the result, so the run ends
      // in the reviewed not-applied code for the request it just read.
      return finish(ALIAS_V2_EXECUTION_NOT_APPLIED, 'failed');
    }
    if (classified.kind === 'refused') {
      // A refusal inside the reviewed policy ends the run unless it is a server failure, which
      // is inconclusive and stays on the readback path.
      if (classified.status >= 500) {
        return finish(state.code, 'indeterminate');
      }
      return finish(classified.code, 'failed');
    }
    if (nowMsExceeded(startedAtMs, waitSeconds, elapsedMs(), options.now !== undefined)) {
      return finish('ALIAS_V2_POLL_EXHAUSTED', 'indeterminate');
    }
    await sleep(Math.min(pollMs, Math.max(waitSeconds * 1_000 - elapsedMs(), 0)));
  }
  return finish(state.code, 'indeterminate');
}

/** The deadline, measured on the same progress clock the loop advances. */
function nowMsExceeded(
  startedAtMs: number,
  waitSeconds: number,
  elapsed: number,
  injected: boolean,
): boolean {
  const limit = waitSeconds * 1_000;
  if (injected) {
    return elapsed >= limit;
  }
  return Date.now() - startedAtMs >= limit;
}

export const __testInternals = {
  dispatchOutcome,
  normalizeEnvelope,
  parseMaybeJson,
  readMarkerState,
  nowMsExceeded,
  ALIAS_V2_CLOCK_SKEW_MS,
  ALIAS_V2_STATUS_PENDING,
};
