import { CliError } from './errors.js';
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type DatasetMaintenancePlan,
  type JsonObject,
} from './dataset-maintenance-contract.js';

export const PROTECTED_EXECUTION_CONTRACT = {
  freeze_schema: 'dataset-alias-execution-freeze.v1',
  approval_schema: 'dataset-alias-execution-approval.v1',
  preflight_request_schema: 'dataset-alias-execution-preflight.v1',
  preflight_response_schema: 'dataset-alias-execution-preflight-proof.v1',
  gate_response_schema: 'dataset-alias-execution-gate-receipt.v1',
  admit_request_schema: 'dataset-alias-execution-admit.v1',
  admit_response_schema: 'dataset-alias-execution-admit.v1',
  status_response_schema: 'dataset-alias-execution-status.v1',
  terminal_proof_schema: 'dataset-alias-execution-terminal-proof.v1',
  marker_schema: 'dataset-alias-execution-attempt.v1',
  report_schema: 'dataset-alias-execution-report.v1',
  preflight_command: 'cmd_dataset_alias_execution_preflight_guarded',
  gate_command: 'cmd_dataset_alias_execution_gate_guarded',
  admit_command: 'cmd_dataset_alias_execution_admit_guarded',
  read_command: 'cmd_dataset_alias_execution_read',
} as const;

export const PROTECTED_EXECUTION_COUNTS = {
  action_count: 52,
  batch_count: 2,
  exchange_count: 59,
  amount_field_count: 118,
  unrelated_exchange_count: 309,
  audit_count: 55,
  flowproperty_count: 2,
  flow_count: 23,
  process_count: 27,
  derivative_target_count: 50,
} as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const PROTECTED_PREFLIGHT_MAX_WINDOW_MS = 180_000;
const PROTECTED_SERVER_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export type ProtectedExecutionStatus =
  | 'not_admitted'
  | 'dispatching'
  | 'dispatched'
  | 'running'
  | 'derivatives_pending'
  | 'completed'
  | 'failed'
  | 'indeterminate';

export type ProtectedReportStatus = 'pending' | 'passed' | 'failed' | 'indeterminate';

export type ProtectedDerivativeTargetTable = 'flows' | 'processes';

export type ProtectedDerivativeTarget = {
  table: ProtectedDerivativeTargetTable;
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  baseline_snapshot_sha256: string;
};

export type ProtectedDerivativeSnapshot = {
  schema_version: 'dataset-derivative-snapshot.v1';
  table: ProtectedDerivativeTargetTable;
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  modified_at: string;
  json_sha256: string;
  json_ordered_sha256: string;
  extracted_md_sha256: string | null;
  embedding_ft_sha256: string | null;
  embedding_ft_at: string | null;
  snapshot_sha256: string;
};

export type ProtectedExecutionBindings = {
  plan_file_sha256: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  approval_file_sha256: string;
  approval_identity_sha256: string;
  approval_text_sha256: string;
  alias_plan_request_sha256: string;
  before_hash_set_sha256: string;
  desired_hash_set_sha256: string;
  exchange_rewrite_set_sha256: string;
  support_snapshot_set_sha256: string;
  derivative_baseline_set_sha256: string;
  derivative_target_set_sha256: string;
  toolchain_evidence_sha256: string;
};

export type ProtectedGateExpectations = {
  primary_support_plan_sha256: string;
  execution_unused_sha256: string;
  derivative_quiescence_sha256: string;
};

export type DatasetMaintenanceProtectedFreeze = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.freeze_schema;
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  plan: {
    plan_file_sha256: string;
    plan_sha256: string;
    operation_id: string;
  };
  sets: Omit<
    ProtectedExecutionBindings,
    | 'plan_file_sha256'
    | 'freeze_file_sha256'
    | 'freeze_sha256'
    | 'approval_file_sha256'
    | 'approval_identity_sha256'
    | 'approval_text_sha256'
  >;
  expected: typeof PROTECTED_EXECUTION_COUNTS;
  derivative_targets: ProtectedDerivativeTarget[];
  policy: {
    state_code_changes: 0;
    save_draft: 0;
    deletes: 0;
    rebuild_derivatives: 0;
    unitgroup_actions: 0;
    person_distance_actions: 0;
    max_admit_posts: 1;
    automatic_retry: false;
  };
  freeze_sha256: string;
};

export type DatasetMaintenanceProtectedApproval = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.approval_schema;
  approved_at_utc: string;
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  plan_sha256: string;
  operation_id: string;
  plan_file_sha256: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  approval_text_sha256: string;
  max_admit_posts: 1;
  automatic_retry: false;
  approval_identity_sha256: string;
};

export type ProtectedExecutionIdentity = {
  request_id: string;
  identity_sha256: string;
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  plan_sha256: string;
  operation_id: string;
  bindings: ProtectedExecutionBindings;
  expected: typeof PROTECTED_EXECUTION_COUNTS;
  derivative_targets: ProtectedDerivativeTarget[];
};

export type ProtectedPreflightProof = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.preflight_response_schema;
  command: typeof PROTECTED_EXECUTION_CONTRACT.preflight_command;
  request_id: string;
  actor_user_id: string;
  environment: 'production';
  project_ref: string;
  server_context_sha256: string;
  plan_sha256: string;
  operation_id: string;
  alias_plan_request_sha256: string;
  freeze_sha256: string;
  approval_identity_sha256: string;
  plan_request_sha256: string;
  bindings_sha256: string;
  expected_sha256: string;
  derivative_targets_sha256: string;
  gate_expectations: ProtectedGateExpectations;
  gate_expectations_sha256: string;
  failure_baseline_sha256: string;
  preflight_request_sha256: string;
  preflight_token: string;
  preflight_proof_sha256: string;
  completed_at: string;
  expires_at: string;
  simulation: {
    plan_rows: 52;
    plan_exchanges: 59;
    alias_audits: 55;
    derivative_targets: 50;
    rolled_back: true;
  };
};

export type ProtectedGateResult = {
  expected_sha256: string;
  observed_sha256: string;
  status: 'passed';
  captured_at: string;
};

export type ProtectedGateProof = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.gate_response_schema;
  command: typeof PROTECTED_EXECUTION_CONTRACT.gate_command;
  request_id: string;
  actor_user_id: string;
  preflight_proof_sha256: string;
  gate: 'primary_support_plan' | 'execution_unused' | 'derivative_quiescence';
  result: ProtectedGateResult;
  receipt_sha256: string;
};

export type ProtectedAdmissionProof = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.admit_response_schema;
  command: typeof PROTECTED_EXECUTION_CONTRACT.admit_command;
  request_id: string;
  plan_sha256: string;
  operation_id: string;
  plan_request_sha256: string;
  preflight_proof_sha256: string;
  admission_request_sha256: string;
  gate_results_sha256: string;
  status: 'dispatched';
  attempt_count: 1;
  dispatch_count: 1;
  net_request_id: string;
  attempt_consumed: true;
  retry_allowed: false;
};

export type ProtectedTerminalTargetProof = {
  ordinal: number;
  request_id: string;
  table: ProtectedDerivativeTargetTable;
  id: string;
  version: string;
  status: string;
  phase: string;
  source_baseline_snapshot_sha256: string;
  expected_snapshot_sha256: string;
  completed_snapshot_sha256: string | null;
  primary_matches: boolean;
  terminal_snapshot_matches: boolean;
  proposals_committed: boolean;
  derivative_fresh: boolean;
  lifecycle_complete: boolean;
  terminal_audit_present: boolean;
  residue: {
    http_requests: number;
    embedding_jobs: number;
    pending_jobs: number;
    failure_rows: number;
    other_active_fences: number;
  };
  causal_terminal_proof: boolean;
};

export type ProtectedStatusTargetProof = {
  ordinal: number;
  request_id: string;
  table: ProtectedDerivativeTargetTable;
  id: string;
  version: string;
  status: string;
  phase: string;
  error: JsonObject | null;
  causal_terminal_proof: false;
};

type ProtectedDerivativeReadbackCommon = {
  schema_version: 'dataset-derivative-rebuild-batch-status.v1';
  batch_id: string;
  code: string | null;
  causal_terminal_proof: boolean;
  target_count: number;
  flow_count: number;
  process_count: number;
  completed_count: number;
  nonterminal_count: number;
  failed_count: number;
};

export type ProtectedDerivativeReadback = ProtectedDerivativeReadbackCommon &
  (
    | {
        status: 'not_started';
        proof_level: 'none';
        proof_deferred: false;
        invalid_proof_count: null;
        targets: [];
      }
    | {
        status: 'pending' | 'failed';
        proof_level: 'status_only';
        proof_deferred: boolean;
        invalid_proof_count: null;
        targets: ProtectedStatusTargetProof[];
      }
    | {
        status: 'completed' | 'failed';
        proof_level: 'causal_terminal';
        proof_deferred: false;
        invalid_proof_count: number;
        targets: ProtectedTerminalTargetProof[];
      }
  );

export type ProtectedExecutionStatusProof = {
  schema_version: typeof PROTECTED_EXECUTION_CONTRACT.status_response_schema;
  command: typeof PROTECTED_EXECUTION_CONTRACT.read_command;
  request_id: string;
  status: ProtectedReportStatus;
  execution_status: ProtectedExecutionStatus;
  retry_allowed: false;
  actor_user_id: string;
  environment: 'production';
  project_ref: string;
  target_visibility: 'owner_draft' | null;
  plan_sha256: string;
  operation_id: string;
  plan_request_sha256: string;
  freeze_sha256: string | null;
  approval_identity_sha256: string | null;
  approval_text_sha256: string | null;
  derivative_target_set_sha256: string | null;
  preflight_proof_sha256: string;
  admission_request_sha256: string | null;
  gate_results_sha256: string | null;
  attempt_count: number;
  dispatch_count: number;
  gate_count: number;
  gates: Array<ProtectedGateResult & { gate: ProtectedGateProof['gate']; receipt_sha256: string }>;
  primary_readback: {
    row_count: number | null;
    exchange_count: number | null;
    alias_audit_count: number;
    live_closure_proof: boolean;
    closure: JsonObject;
  } | null;
  derivative_readback: ProtectedDerivativeReadback;
  failure: JsonObject | null;
};

function fail(message: string, details?: unknown): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_PROTECTED_CONTRACT_INVALID',
    exitCode: 2,
    details,
  });
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function hash(value: unknown, label: string): string {
  const result = token(value, label);
  if (!SHA256.test(result)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = token(value, label);
  if (!Number.isFinite(Date.parse(result))) fail(`${label} must be an ISO timestamp.`);
  return result;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function parseAccount(value: unknown, label: string): { user_id: string; email: string } {
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  return {
    user_id: token(value.user_id, `${label}.user_id`),
    email: token(value.email, `${label}.email`),
  };
}

function parseExpected(value: unknown): typeof PROTECTED_EXECUTION_COUNTS {
  if (!isJsonObject(value)) fail('expected must be an object.');
  for (const [key, expected] of Object.entries(PROTECTED_EXECUTION_COUNTS)) {
    if (value[key] !== expected) fail(`expected.${key} must equal ${expected}.`);
  }
  return PROTECTED_EXECUTION_COUNTS;
}

function parseGateExpectations(value: unknown): ProtectedGateExpectations {
  if (!isJsonObject(value)) fail('gate_expectations must be an object.');
  return {
    primary_support_plan_sha256: hash(
      value.primary_support_plan_sha256,
      'gate_expectations.primary_support_plan_sha256',
    ),
    execution_unused_sha256: hash(
      value.execution_unused_sha256,
      'gate_expectations.execution_unused_sha256',
    ),
    derivative_quiescence_sha256: hash(
      value.derivative_quiescence_sha256,
      'gate_expectations.derivative_quiescence_sha256',
    ),
  };
}

function parseDerivativeTarget(value: unknown, index: number): ProtectedDerivativeTarget {
  const label = `derivative_targets[${index}]`;
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  if (value.table !== 'flows' && value.table !== 'processes') {
    fail(`${label}.table must be flows or processes.`);
  }
  if (value.state_code !== 0) fail(`${label}.state_code must equal 0.`);
  const id = token(value.id, `${label}.id`);
  const version = token(value.version, `${label}.version`);
  if (!UUID.test(id) || !VERSION.test(version)) {
    fail(`${label} must contain a UUID id and canonical version.`);
  }
  return {
    table: value.table,
    id,
    version,
    user_id: token(value.user_id, `${label}.user_id`),
    state_code: 0 as const,
    baseline_snapshot_sha256: hash(
      value.baseline_snapshot_sha256,
      `${label}.baseline_snapshot_sha256`,
    ),
  };
}

function parseDerivativeTargets(value: unknown): ProtectedDerivativeTarget[] {
  if (!Array.isArray(value)) fail('derivative_targets must be an array.');
  const targets = value.map(parseDerivativeTarget);
  const keys = targets.map((target) => `${target.table}\u0000${target.id}\u0000${target.version}`);
  if (
    targets.length !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    new Set(keys).size !== targets.length ||
    targets.filter((target) => target.table === 'flows').length !==
      PROTECTED_EXECUTION_COUNTS.flow_count ||
    targets.filter((target) => target.table === 'processes').length !==
      PROTECTED_EXECUTION_COUNTS.process_count
  ) {
    fail('derivative_targets must contain exactly 23 flows and 27 processes with no duplicates.');
  }
  const sorted = [...targets].sort((left, right) =>
    `${left.table}\u0000${left.id}\u0000${left.version}`.localeCompare(
      `${right.table}\u0000${right.id}\u0000${right.version}`,
    ),
  );
  if (sorted.some((target, index) => target !== targets[index])) {
    fail('derivative_targets must use stable table/id/version order.');
  }
  return targets;
}

export function parseProtectedDerivativeSnapshot(
  value: unknown,
  expected: {
    table: ProtectedDerivativeTargetTable;
    id: string;
    version: string;
    userId: string;
  },
): ProtectedDerivativeSnapshot {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.command !== 'cmd_dataset_derivative_rebuild_snapshot' ||
    value.schema_version !== 'dataset-derivative-snapshot.v1' ||
    value.table !== expected.table ||
    value.id !== expected.id ||
    value.version !== expected.version ||
    value.user_id !== expected.userId ||
    value.state_code !== 0
  ) {
    fail('Derivative snapshot RPC returned a foreign or unsupported snapshot.');
  }
  const snapshot: ProtectedDerivativeSnapshot = {
    schema_version: 'dataset-derivative-snapshot.v1',
    table: expected.table,
    id: expected.id,
    version: expected.version,
    user_id: expected.userId,
    state_code: 0,
    modified_at: timestamp(value.modified_at, 'derivative_snapshot.modified_at'),
    json_sha256: hash(value.json_sha256, 'derivative_snapshot.json_sha256'),
    json_ordered_sha256: hash(value.json_ordered_sha256, 'derivative_snapshot.json_ordered_sha256'),
    extracted_md_sha256: nullableHash(
      value.extracted_md_sha256,
      'derivative_snapshot.extracted_md_sha256',
    ),
    embedding_ft_sha256: nullableHash(
      value.embedding_ft_sha256,
      'derivative_snapshot.embedding_ft_sha256',
    ),
    embedding_ft_at: nullableTimestamp(
      value.embedding_ft_at,
      'derivative_snapshot.embedding_ft_at',
    ),
    snapshot_sha256: hash(value.snapshot_sha256, 'derivative_snapshot.snapshot_sha256'),
  };
  if (snapshot.json_sha256 !== snapshot.json_ordered_sha256) {
    fail('Derivative snapshot json and json_ordered hashes are inconsistent.');
  }
  return snapshot;
}

function parseFreezeSets(value: unknown): DatasetMaintenanceProtectedFreeze['sets'] {
  if (!isJsonObject(value)) fail('sets must be an object.');
  return {
    alias_plan_request_sha256: hash(
      value.alias_plan_request_sha256,
      'sets.alias_plan_request_sha256',
    ),
    before_hash_set_sha256: hash(value.before_hash_set_sha256, 'sets.before_hash_set_sha256'),
    desired_hash_set_sha256: hash(value.desired_hash_set_sha256, 'sets.desired_hash_set_sha256'),
    exchange_rewrite_set_sha256: hash(
      value.exchange_rewrite_set_sha256,
      'sets.exchange_rewrite_set_sha256',
    ),
    support_snapshot_set_sha256: hash(
      value.support_snapshot_set_sha256,
      'sets.support_snapshot_set_sha256',
    ),
    derivative_baseline_set_sha256: hash(
      value.derivative_baseline_set_sha256,
      'sets.derivative_baseline_set_sha256',
    ),
    derivative_target_set_sha256: hash(
      value.derivative_target_set_sha256,
      'sets.derivative_target_set_sha256',
    ),
    toolchain_evidence_sha256: hash(
      value.toolchain_evidence_sha256,
      'sets.toolchain_evidence_sha256',
    ),
  };
}

export function computeProtectedFreezeSha256(freeze: DatasetMaintenanceProtectedFreeze): string {
  return sha256Json({ ...freeze, freeze_sha256: '' });
}

export function parseProtectedFreeze(value: unknown): DatasetMaintenanceProtectedFreeze {
  if (
    !isJsonObject(value) ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.freeze_schema ||
    value.environment !== 'production' ||
    value.target_visibility !== 'owner_draft' ||
    !isJsonObject(value.plan) ||
    !isJsonObject(value.policy)
  ) {
    fail(
      `Freeze must use ${PROTECTED_EXECUTION_CONTRACT.freeze_schema} for production owner_draft.`,
    );
  }
  const targets = parseDerivativeTargets(value.derivative_targets);
  const account = parseAccount(value.account, 'account');
  if (targets.some((target) => target.user_id !== account.user_id)) {
    fail('Every derivative target must belong to the frozen account.');
  }
  const freeze: DatasetMaintenanceProtectedFreeze = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: token(value.project_ref, 'project_ref'),
    account,
    target_visibility: 'owner_draft',
    plan: {
      plan_file_sha256: hash(value.plan.plan_file_sha256, 'plan.plan_file_sha256'),
      plan_sha256: hash(value.plan.plan_sha256, 'plan.plan_sha256'),
      operation_id: token(value.plan.operation_id, 'plan.operation_id'),
    },
    sets: parseFreezeSets(value.sets),
    expected: parseExpected(value.expected),
    derivative_targets: targets,
    policy: {
      state_code_changes: value.policy.state_code_changes as 0,
      save_draft: value.policy.save_draft as 0,
      deletes: value.policy.deletes as 0,
      rebuild_derivatives: value.policy.rebuild_derivatives as 0,
      unitgroup_actions: value.policy.unitgroup_actions as 0,
      person_distance_actions: value.policy.person_distance_actions as 0,
      max_admit_posts: value.policy.max_admit_posts as 1,
      automatic_retry: value.policy.automatic_retry as false,
    },
    freeze_sha256: hash(value.freeze_sha256, 'freeze_sha256'),
  };
  if (
    freeze.policy.state_code_changes !== 0 ||
    freeze.policy.save_draft !== 0 ||
    freeze.policy.deletes !== 0 ||
    freeze.policy.rebuild_derivatives !== 0 ||
    freeze.policy.unitgroup_actions !== 0 ||
    freeze.policy.person_distance_actions !== 0 ||
    freeze.policy.max_admit_posts !== 1 ||
    freeze.policy.automatic_retry !== false
  ) {
    fail('Freeze policy permits an operation outside the one-shot owner-draft alias execution.');
  }
  if (computeProtectedFreezeSha256(freeze) !== freeze.freeze_sha256) {
    fail('freeze_sha256 does not match the canonical freeze contents.');
  }
  return freeze;
}

export function computeProtectedApprovalIdentitySha256(
  approval: DatasetMaintenanceProtectedApproval,
): string {
  return sha256Json({ ...approval, approval_identity_sha256: '' });
}

export function parseProtectedApproval(value: unknown): DatasetMaintenanceProtectedApproval {
  if (
    !isJsonObject(value) ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.approval_schema ||
    value.environment !== 'production' ||
    value.target_visibility !== 'owner_draft'
  ) {
    fail(
      `Approval must use ${PROTECTED_EXECUTION_CONTRACT.approval_schema} for production owner_draft.`,
    );
  }
  const approval: DatasetMaintenanceProtectedApproval = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.approval_schema,
    approved_at_utc: timestamp(value.approved_at_utc, 'approved_at_utc'),
    environment: 'production',
    project_ref: token(value.project_ref, 'project_ref'),
    account: parseAccount(value.account, 'account'),
    target_visibility: 'owner_draft',
    plan_sha256: hash(value.plan_sha256, 'plan_sha256'),
    operation_id: token(value.operation_id, 'operation_id'),
    plan_file_sha256: hash(value.plan_file_sha256, 'plan_file_sha256'),
    freeze_file_sha256: hash(value.freeze_file_sha256, 'freeze_file_sha256'),
    freeze_sha256: hash(value.freeze_sha256, 'freeze_sha256'),
    approval_text_sha256: hash(value.approval_text_sha256, 'approval_text_sha256'),
    max_admit_posts: value.max_admit_posts as 1,
    automatic_retry: value.automatic_retry as false,
    approval_identity_sha256: hash(value.approval_identity_sha256, 'approval_identity_sha256'),
  };
  if (approval.max_admit_posts !== 1 || approval.automatic_retry !== false) {
    fail('Approval must authorize exactly one admit POST with no automatic retry.');
  }
  if (computeProtectedApprovalIdentitySha256(approval) !== approval.approval_identity_sha256) {
    fail('approval_identity_sha256 does not match the canonical approval contents.');
  }
  return approval;
}

export function protectedPlanSetHashes(plan: DatasetMaintenancePlan): {
  before_hash_set_sha256: string;
  desired_hash_set_sha256: string;
  exchange_rewrite_set_sha256: string;
  support_snapshot_set_sha256: string;
  derivative_target_set_sha256: string;
} {
  const orderedActions = [...plan.actions].sort((left, right) =>
    left.action_id.localeCompare(right.action_id),
  );
  const derivativeTargets = plan.actions
    .filter((action) => action.table === 'flows' || action.table === 'processes')
    .sort(
      (left, right) =>
        left.table.localeCompare(right.table) ||
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version),
    )
    .map((action) => ({
      table: action.table,
      id: action.id,
      version: action.version,
      user_id: action.expected_user_id,
      state_code: action.expected_state_code,
    }));
  return {
    before_hash_set_sha256: sha256Json(
      orderedActions.map((action) => ({
        action_id: action.action_id,
        table: action.table,
        id: action.id,
        version: action.version,
        row_sha256: action.before?.row_sha256 ?? null,
      })),
    ),
    desired_hash_set_sha256: sha256Json(
      orderedActions.map((action) => ({
        action_id: action.action_id,
        table: action.table,
        id: action.id,
        version: action.version,
        payload_sha256: action.desired_payload?.sha256 ?? null,
      })),
    ),
    exchange_rewrite_set_sha256: sha256Json(
      (plan.alias_batches ?? []).flatMap((batch) => batch.exchange_rewrites),
    ),
    support_snapshot_set_sha256: sha256Json(
      (plan.alias_batches ?? []).map((batch) => ({
        batch_id: batch.batch_id,
        target_snapshots: batch.target_snapshots,
      })),
    ),
    derivative_target_set_sha256: sha256Json(derivativeTargets),
  };
}

export function protectedDerivativeBaselineSetSha256(targets: ProtectedDerivativeTarget[]): string {
  return sha256Json(
    targets.map((target) => ({
      table: target.table,
      id: target.id,
      version: target.version,
      baseline_snapshot_sha256: target.baseline_snapshot_sha256,
    })),
  );
}

export function assertProtectedFreezeMatchesPlan(options: {
  plan: DatasetMaintenancePlan;
  planFileSha256: string;
  aliasPlanRequestSha256: string;
  freeze: DatasetMaintenanceProtectedFreeze;
}): void {
  const { plan, planFileSha256, freeze } = options;
  if (
    plan.operation !== 'merge-support-aliases' ||
    plan.status !== 'ready' ||
    plan.target_mode !== 'owner_draft' ||
    plan.blockers.length !== 0 ||
    plan.account.user_id !== freeze.account.user_id ||
    plan.account.email !== freeze.account.email ||
    plan.plan_sha256 !== freeze.plan.plan_sha256 ||
    plan.operation_id !== freeze.plan.operation_id ||
    planFileSha256 !== freeze.plan.plan_file_sha256
  ) {
    fail('Protected freeze does not bind the ready owner-draft alias plan and account exactly.');
  }
  const actionCounts = {
    flowproperties: plan.actions.filter((action) => action.table === 'flowproperties').length,
    flows: plan.actions.filter((action) => action.table === 'flows').length,
    processes: plan.actions.filter((action) => action.table === 'processes').length,
  };
  if (
    plan.actions.length !== PROTECTED_EXECUTION_COUNTS.action_count ||
    plan.alias_batches?.length !== PROTECTED_EXECUTION_COUNTS.batch_count ||
    actionCounts.flowproperties !== PROTECTED_EXECUTION_COUNTS.flowproperty_count ||
    actionCounts.flows !== PROTECTED_EXECUTION_COUNTS.flow_count ||
    actionCounts.processes !== PROTECTED_EXECUTION_COUNTS.process_count ||
    (plan.summary.scaled_exchanges ?? 0) !== PROTECTED_EXECUTION_COUNTS.exchange_count ||
    (plan.summary.scaled_amount_fields ?? 0) !== PROTECTED_EXECUTION_COUNTS.amount_field_count ||
    (plan.summary.unrelated_exchanges_preserved ?? 0) !==
      PROTECTED_EXECUTION_COUNTS.unrelated_exchange_count
  ) {
    fail('Protected plan counts do not match the Step 2 execution contract.');
  }
  const sets = protectedPlanSetHashes(plan);
  for (const [key, actual] of Object.entries(sets)) {
    if (freeze.sets[key as keyof typeof sets] !== actual) fail(`Freeze set hash mismatch: ${key}.`);
  }
  if (freeze.sets.alias_plan_request_sha256 !== options.aliasPlanRequestSha256) {
    fail('Freeze alias request hash does not match the exact serialized database plan.');
  }
  if (
    freeze.sets.derivative_baseline_set_sha256 !==
    protectedDerivativeBaselineSetSha256(freeze.derivative_targets)
  ) {
    fail('Freeze derivative baseline set hash does not match the 50 targets.');
  }
  const targetByKey = new Map(
    freeze.derivative_targets.map((target) => [
      `${target.table}\u0000${target.id}\u0000${target.version}`,
      target,
    ]),
  );
  for (const action of plan.actions.filter(
    (entry) => entry.table === 'flows' || entry.table === 'processes',
  )) {
    const target = targetByKey.get(`${action.table}\u0000${action.id}\u0000${action.version}`);
    if (!target || target.user_id !== action.expected_user_id) {
      fail(`Derivative baseline does not bind action ${action.action_id}.`);
    }
  }
}

export function assertProtectedApprovalBindings(options: {
  approval: DatasetMaintenanceProtectedApproval;
  freeze: DatasetMaintenanceProtectedFreeze;
  freezeFileSha256: string;
  approvalFileSha256: string;
  approveExecution?: string;
}): void {
  const { approval, freeze } = options;
  if (
    approval.environment !== freeze.environment ||
    approval.project_ref !== freeze.project_ref ||
    approval.account.user_id !== freeze.account.user_id ||
    approval.account.email !== freeze.account.email ||
    approval.plan_sha256 !== freeze.plan.plan_sha256 ||
    approval.operation_id !== freeze.plan.operation_id ||
    approval.plan_file_sha256 !== freeze.plan.plan_file_sha256 ||
    approval.freeze_file_sha256 !== options.freezeFileSha256 ||
    approval.freeze_sha256 !== freeze.freeze_sha256 ||
    approval.approval_identity_sha256 !== options.approveExecution
  ) {
    fail('Approval does not bind this exact production freeze, plan, actor, and CLI confirmation.');
  }
  hash(options.approvalFileSha256, 'approval_file_sha256');
}

/**
 * The reviewed deterministic request identity: the same digest always yields the same uuid, so a
 * rerun of the same frozen execution reuses one server-side request row. Exported so the
 * versioned (v2) capability derives its identity the same way instead of inventing another.
 */
export function deterministicUuidFromSha256(digest: string): string {
  const chars = digest.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildProtectedExecutionIdentity(options: {
  freeze: DatasetMaintenanceProtectedFreeze;
  approval: DatasetMaintenanceProtectedApproval;
  freezeFileSha256: string;
  approvalFileSha256: string;
}): ProtectedExecutionIdentity {
  const bindings: ProtectedExecutionBindings = {
    plan_file_sha256: options.freeze.plan.plan_file_sha256,
    freeze_file_sha256: options.freezeFileSha256,
    freeze_sha256: options.freeze.freeze_sha256,
    approval_file_sha256: options.approvalFileSha256,
    approval_identity_sha256: options.approval.approval_identity_sha256,
    approval_text_sha256: options.approval.approval_text_sha256,
    ...options.freeze.sets,
  };
  const body = {
    environment: 'production' as const,
    project_ref: options.freeze.project_ref,
    actor: options.freeze.account,
    target_visibility: 'owner_draft' as const,
    plan_sha256: options.freeze.plan.plan_sha256,
    operation_id: options.freeze.plan.operation_id,
    bindings,
    expected: PROTECTED_EXECUTION_COUNTS,
    derivative_targets: options.freeze.derivative_targets,
  };
  const identitySha256 = sha256Json(body);
  const requestId = deterministicUuidFromSha256(
    sha256Text(`dataset-alias-protected-request.v1\u0000${identitySha256}`),
  );
  return { request_id: requestId, identity_sha256: identitySha256, ...body };
}

export function buildProtectedPreflightRequest(options: {
  identity: ProtectedExecutionIdentity;
  plan: JsonObject;
  freeze: DatasetMaintenanceProtectedFreeze;
  approval: DatasetMaintenanceProtectedApproval;
}): JsonObject {
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.preflight_request_schema,
    request_id: options.identity.request_id,
    environment: options.identity.environment,
    project_ref: options.identity.project_ref,
    actor: options.identity.actor,
    target_visibility: options.identity.target_visibility,
    plan: options.plan,
    freeze: options.freeze,
    approval: options.approval,
    bindings: options.identity.bindings,
    expected: options.identity.expected,
    derivative_targets: options.identity.derivative_targets,
  };
}

export function parseProtectedPreflightProof(
  value: unknown,
  identity: ProtectedExecutionIdentity,
  now = new Date(),
): ProtectedPreflightProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.preflight_response_schema ||
    value.command !== PROTECTED_EXECUTION_CONTRACT.preflight_command ||
    value.request_id !== identity.request_id ||
    value.actor_user_id !== identity.actor.user_id ||
    value.environment !== identity.environment ||
    value.project_ref !== identity.project_ref ||
    value.plan_sha256 !== identity.plan_sha256 ||
    value.operation_id !== identity.operation_id ||
    !isJsonObject(value.simulation)
  ) {
    fail('Preflight RPC returned a foreign or unsupported proof envelope.');
  }
  const proof: ProtectedPreflightProof = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.preflight_response_schema,
    command: PROTECTED_EXECUTION_CONTRACT.preflight_command,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    environment: 'production',
    project_ref: identity.project_ref,
    server_context_sha256: hash(value.server_context_sha256, 'server_context_sha256'),
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    alias_plan_request_sha256: hash(value.alias_plan_request_sha256, 'alias_plan_request_sha256'),
    freeze_sha256: hash(value.freeze_sha256, 'freeze_sha256'),
    approval_identity_sha256: hash(value.approval_identity_sha256, 'approval_identity_sha256'),
    plan_request_sha256: hash(value.plan_request_sha256, 'plan_request_sha256'),
    bindings_sha256: hash(value.bindings_sha256, 'bindings_sha256'),
    expected_sha256: hash(value.expected_sha256, 'expected_sha256'),
    derivative_targets_sha256: hash(value.derivative_targets_sha256, 'derivative_targets_sha256'),
    gate_expectations: parseGateExpectations(value.gate_expectations),
    gate_expectations_sha256: hash(value.gate_expectations_sha256, 'gate_expectations_sha256'),
    failure_baseline_sha256: hash(value.failure_baseline_sha256, 'failure_baseline_sha256'),
    preflight_request_sha256: hash(value.preflight_request_sha256, 'preflight_request_sha256'),
    preflight_token: token(value.preflight_token, 'preflight_token'),
    preflight_proof_sha256: hash(value.preflight_proof_sha256, 'preflight_proof_sha256'),
    completed_at: timestamp(value.completed_at, 'completed_at'),
    expires_at: timestamp(value.expires_at, 'expires_at'),
    simulation: {
      plan_rows: value.simulation.plan_rows as 52,
      plan_exchanges: value.simulation.plan_exchanges as 59,
      alias_audits: value.simulation.alias_audits as 55,
      derivative_targets: value.simulation.derivative_targets as 50,
      rolled_back: value.simulation.rolled_back as true,
    },
  };
  if (
    proof.alias_plan_request_sha256 !== identity.bindings.alias_plan_request_sha256 ||
    proof.freeze_sha256 !== identity.bindings.freeze_sha256 ||
    proof.approval_identity_sha256 !== identity.bindings.approval_identity_sha256 ||
    proof.simulation.plan_rows !== PROTECTED_EXECUTION_COUNTS.action_count ||
    proof.simulation.plan_exchanges !== PROTECTED_EXECUTION_COUNTS.exchange_count ||
    proof.simulation.alias_audits !== PROTECTED_EXECUTION_COUNTS.audit_count ||
    proof.simulation.derivative_targets !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    proof.simulation.rolled_back !== true
  ) {
    fail('Preflight simulation did not prove the exact protected profile and rollback.');
  }
  const issued = Date.parse(proof.completed_at);
  const expires = Date.parse(proof.expires_at);
  const nowMs = now.getTime();
  const windowMs = expires - issued;
  const timingDetails = {
    completed_at: proof.completed_at,
    expires_at: proof.expires_at,
    observed_at: now.toISOString(),
    window_ms: windowMs,
    future_skew_ms: issued - nowMs,
    allowed_future_skew_ms: PROTECTED_SERVER_CLOCK_SKEW_TOLERANCE_MS,
  };
  if (windowMs <= 0) {
    fail('Preflight token expiry must be later than its completion time.', timingDetails);
  }
  if (windowMs > PROTECTED_PREFLIGHT_MAX_WINDOW_MS) {
    fail('Preflight token exceeds the 180-second admission window.', timingDetails);
  }
  if (issued - nowMs > PROTECTED_SERVER_CLOCK_SKEW_TOLERANCE_MS) {
    fail(
      'Preflight token is future-issued beyond the 5-second clock-skew allowance.',
      timingDetails,
    );
  }
  if (expires <= nowMs) {
    fail('Preflight token is stale.', timingDetails);
  }
  return proof;
}

export function parseProtectedGateProof(
  value: unknown,
  options: {
    identity: ProtectedExecutionIdentity;
    preflight: ProtectedPreflightProof;
    gate: ProtectedGateProof['gate'];
  },
): ProtectedGateProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.gate_response_schema ||
    value.command !== PROTECTED_EXECUTION_CONTRACT.gate_command ||
    value.request_id !== options.identity.request_id ||
    value.actor_user_id !== options.identity.actor.user_id ||
    value.preflight_proof_sha256 !== options.preflight.preflight_proof_sha256 ||
    value.gate !== options.gate ||
    value.status !== 'passed'
  ) {
    fail('Gate RPC returned a foreign, failed, or unsupported receipt.');
  }
  const expectedName = `${options.gate}_sha256` as keyof ProtectedGateExpectations;
  const expectedSha256 = hash(value.expected_sha256, 'gate.expected_sha256');
  const observedSha256 = hash(value.observed_sha256, 'gate.observed_sha256');
  const capturedAt = timestamp(value.captured_at, 'gate.captured_at');
  if (
    expectedSha256 !== options.preflight.gate_expectations[expectedName] ||
    observedSha256 !== expectedSha256 ||
    Date.parse(capturedAt) < Date.parse(options.preflight.completed_at) ||
    Date.parse(capturedAt) > Date.parse(options.preflight.expires_at)
  ) {
    fail('Gate receipt does not match the frozen digest or server preflight window.');
  }
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.gate_response_schema,
    command: PROTECTED_EXECUTION_CONTRACT.gate_command,
    request_id: options.identity.request_id,
    actor_user_id: options.identity.actor.user_id,
    preflight_proof_sha256: options.preflight.preflight_proof_sha256,
    gate: options.gate,
    result: {
      expected_sha256: expectedSha256,
      observed_sha256: observedSha256,
      status: 'passed',
      captured_at: capturedAt,
    },
    receipt_sha256: hash(value.receipt_sha256, 'gate.receipt_sha256'),
  };
}

export function buildProtectedAdmitRequest(options: {
  preflight: ProtectedPreflightProof;
  gateResults: {
    primary_support_plan: ProtectedGateResult;
    execution_unused: ProtectedGateResult;
    derivative_quiescence: ProtectedGateResult;
  };
}): JsonObject {
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.admit_request_schema,
    request_id: options.preflight.request_id,
    preflight_token: options.preflight.preflight_token,
    preflight_proof_sha256: options.preflight.preflight_proof_sha256,
    gate_results: options.gateResults,
  };
}

export function parseProtectedAdmissionProof(
  value: unknown,
  identity: ProtectedExecutionIdentity,
  preflight: ProtectedPreflightProof,
): ProtectedAdmissionProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.admit_response_schema ||
    value.command !== PROTECTED_EXECUTION_CONTRACT.admit_command ||
    value.request_id !== identity.request_id ||
    value.plan_sha256 !== identity.plan_sha256 ||
    value.operation_id !== identity.operation_id ||
    value.plan_request_sha256 !== preflight.plan_request_sha256 ||
    value.preflight_proof_sha256 !== preflight.preflight_proof_sha256 ||
    value.status !== 'dispatched' ||
    value.attempt_count !== 1 ||
    value.dispatch_count !== 1 ||
    value.attempt_consumed !== true ||
    value.retry_allowed !== false
  ) {
    fail('Admission RPC returned a foreign, duplicate, or unsupported proof envelope.');
  }
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.admit_response_schema,
    command: PROTECTED_EXECUTION_CONTRACT.admit_command,
    request_id: identity.request_id,
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    plan_request_sha256: preflight.plan_request_sha256,
    preflight_proof_sha256: preflight.preflight_proof_sha256,
    admission_request_sha256: hash(value.admission_request_sha256, 'admission_request_sha256'),
    gate_results_sha256: hash(value.gate_results_sha256, 'gate_results_sha256'),
    status: 'dispatched',
    attempt_count: 1,
    dispatch_count: 1,
    net_request_id: token(value.net_request_id, 'net_request_id'),
    attempt_consumed: true,
    retry_allowed: false,
  };
}

function parseBindings(value: unknown): ProtectedExecutionBindings {
  if (!isJsonObject(value)) fail('bindings must be an object.');
  return Object.fromEntries(
    [
      'plan_file_sha256',
      'freeze_file_sha256',
      'freeze_sha256',
      'approval_file_sha256',
      'approval_identity_sha256',
      'approval_text_sha256',
      'alias_plan_request_sha256',
      'before_hash_set_sha256',
      'desired_hash_set_sha256',
      'exchange_rewrite_set_sha256',
      'support_snapshot_set_sha256',
      'derivative_baseline_set_sha256',
      'derivative_target_set_sha256',
      'toolchain_evidence_sha256',
    ].map((key) => [key, hash(value[key], `bindings.${key}`)]),
  ) as ProtectedExecutionBindings;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0)
    fail(`${label} must be a non-negative integer.`);
  return Number(value);
}

function requiredBoolean(value: unknown, label: string): boolean {
  return typeof value === 'boolean' ? value : fail(`${label} must be boolean.`);
}

function parseTerminalTarget(value: unknown, index: number): ProtectedTerminalTargetProof {
  const label = `derivative_readback.targets[${index}]`;
  if (!isJsonObject(value) || !isJsonObject(value.residue)) {
    fail(`${label} must be an object with residue counts.`);
  }
  if (value.table !== 'flows' && value.table !== 'processes') {
    fail(`${label}.table must be flows or processes.`);
  }
  const ordinal = nonNegativeInteger(value.ordinal, `${label}.ordinal`);
  if (ordinal < 1 || ordinal > PROTECTED_EXECUTION_COUNTS.derivative_target_count) {
    fail(`${label}.ordinal is outside the exact 50-target range.`);
  }
  return {
    ordinal,
    request_id: token(value.request_id, `${label}.request_id`),
    table: value.table,
    id: token(value.id, `${label}.id`),
    version: token(value.version, `${label}.version`),
    status: token(value.status, `${label}.status`),
    phase: token(value.phase, `${label}.phase`),
    source_baseline_snapshot_sha256: hash(
      value.source_baseline_snapshot_sha256,
      `${label}.source_baseline_snapshot_sha256`,
    ),
    expected_snapshot_sha256: hash(
      value.expected_snapshot_sha256,
      `${label}.expected_snapshot_sha256`,
    ),
    completed_snapshot_sha256: nullableHash(
      value.completed_snapshot_sha256,
      `${label}.completed_snapshot_sha256`,
    ),
    primary_matches: requiredBoolean(value.primary_matches, `${label}.primary_matches`),
    terminal_snapshot_matches: requiredBoolean(
      value.terminal_snapshot_matches,
      `${label}.terminal_snapshot_matches`,
    ),
    proposals_committed: requiredBoolean(value.proposals_committed, `${label}.proposals_committed`),
    derivative_fresh: requiredBoolean(value.derivative_fresh, `${label}.derivative_fresh`),
    lifecycle_complete: requiredBoolean(value.lifecycle_complete, `${label}.lifecycle_complete`),
    terminal_audit_present: requiredBoolean(
      value.terminal_audit_present,
      `${label}.terminal_audit_present`,
    ),
    residue: {
      http_requests: nonNegativeInteger(
        value.residue.http_requests,
        `${label}.residue.http_requests`,
      ),
      embedding_jobs: nonNegativeInteger(
        value.residue.embedding_jobs,
        `${label}.residue.embedding_jobs`,
      ),
      pending_jobs: nonNegativeInteger(value.residue.pending_jobs, `${label}.residue.pending_jobs`),
      failure_rows: nonNegativeInteger(value.residue.failure_rows, `${label}.residue.failure_rows`),
      other_active_fences: nonNegativeInteger(
        value.residue.other_active_fences,
        `${label}.residue.other_active_fences`,
      ),
    },
    causal_terminal_proof: requiredBoolean(
      value.causal_terminal_proof,
      `${label}.causal_terminal_proof`,
    ),
  };
}

function parseStatusTarget(value: unknown, index: number): ProtectedStatusTargetProof {
  const label = `derivative_readback.targets[${index}]`;
  if (!isJsonObject(value) || (value.table !== 'flows' && value.table !== 'processes')) {
    fail(`${label} must be a lightweight flow/process status proof.`);
  }
  const ordinal = nonNegativeInteger(value.ordinal, `${label}.ordinal`);
  if (ordinal < 1 || ordinal > PROTECTED_EXECUTION_COUNTS.derivative_target_count) {
    fail(`${label}.ordinal is outside the exact 50-target range.`);
  }
  if (value.causal_terminal_proof !== false) {
    fail(`${label}.causal_terminal_proof must be false while proof is deferred.`);
  }
  return {
    ordinal,
    request_id: token(value.request_id, `${label}.request_id`),
    table: value.table,
    id: token(value.id, `${label}.id`),
    version: token(value.version, `${label}.version`),
    status: token(value.status, `${label}.status`),
    phase: token(value.phase, `${label}.phase`),
    error:
      value.error === null
        ? null
        : isJsonObject(value.error)
          ? value.error
          : fail(`${label}.error must be an object or null.`),
    causal_terminal_proof: false,
  };
}

function parseReadGates(value: unknown): ProtectedExecutionStatusProof['gates'] {
  if (!Array.isArray(value)) fail('gates must be an array.');
  return value.map((entry, index) => {
    if (
      !isJsonObject(entry) ||
      !['primary_support_plan', 'execution_unused', 'derivative_quiescence'].includes(
        String(entry.gate),
      ) ||
      entry.status !== 'passed'
    ) {
      fail(`gates[${index}] is invalid.`);
    }
    return {
      gate: entry.gate as ProtectedGateProof['gate'],
      expected_sha256: hash(entry.expected_sha256, `gates[${index}].expected_sha256`),
      observed_sha256: hash(entry.observed_sha256, `gates[${index}].observed_sha256`),
      status: 'passed' as const,
      captured_at: timestamp(entry.captured_at, `gates[${index}].captured_at`),
      receipt_sha256: hash(entry.receipt_sha256, `gates[${index}].receipt_sha256`),
    };
  });
}

function parseDerivativeReadback(
  value: unknown,
  requestId: string,
): ProtectedExecutionStatusProof['derivative_readback'] {
  if (
    !isJsonObject(value) ||
    value.schema_version !== 'dataset-derivative-rebuild-batch-status.v1' ||
    value.batch_id !== requestId ||
    !['not_started', 'pending', 'completed', 'failed'].includes(String(value.status))
  ) {
    fail('derivative_readback is invalid.');
  }
  const notStarted = value.status === 'not_started';
  const common = {
    schema_version: 'dataset-derivative-rebuild-batch-status.v1',
    batch_id: requestId,
    code:
      value.code === undefined || value.code === null
        ? null
        : token(value.code, 'derivative_readback.code'),
    causal_terminal_proof: requiredBoolean(
      value.causal_terminal_proof,
      'derivative_readback.causal_terminal_proof',
    ),
    target_count: nonNegativeInteger(value.target_count, 'derivative_readback.target_count'),
    flow_count: nonNegativeInteger(value.flow_count, 'derivative_readback.flow_count'),
    process_count: nonNegativeInteger(value.process_count, 'derivative_readback.process_count'),
    completed_count: nonNegativeInteger(
      value.completed_count,
      'derivative_readback.completed_count',
    ),
    nonterminal_count: nonNegativeInteger(
      value.nonterminal_count,
      'derivative_readback.nonterminal_count',
    ),
    failed_count: nonNegativeInteger(value.failed_count, 'derivative_readback.failed_count'),
  } as const;
  if (notStarted) {
    if (
      value.code !== 'DERIVATIVE_BATCH_NOT_STARTED' ||
      value.proof_level !== 'none' ||
      value.proof_deferred !== false ||
      value.invalid_proof_count !== null ||
      !Array.isArray(value.targets) ||
      value.targets.length !== 0 ||
      common.causal_terminal_proof !== false ||
      common.target_count !== 0 ||
      common.flow_count !== 0 ||
      common.process_count !== 0 ||
      common.completed_count !== 0 ||
      common.nonterminal_count !== 0 ||
      common.failed_count !== 0
    ) {
      fail('Not-started derivative readback must carry the exact zero-count proof envelope.');
    }
    return {
      ...common,
      status: 'not_started',
      proof_level: 'none',
      proof_deferred: false,
      invalid_proof_count: null,
      targets: [],
    };
  }
  if (!Array.isArray(value.targets)) {
    fail('derivative_readback.targets must be an array.');
  }
  if (value.proof_level === 'status_only') {
    if (
      (value.status !== 'pending' && value.status !== 'failed') ||
      typeof value.proof_deferred !== 'boolean' ||
      value.invalid_proof_count !== null ||
      common.causal_terminal_proof !== false
    ) {
      fail('Status-only derivative readback has inconsistent proof metadata.');
    }
    return {
      ...common,
      status: value.status,
      proof_level: 'status_only',
      proof_deferred: value.proof_deferred,
      invalid_proof_count: null,
      targets: value.targets.map(parseStatusTarget),
    };
  }
  if (
    value.proof_level !== 'causal_terminal' ||
    value.proof_deferred !== false ||
    (value.status !== 'completed' && value.status !== 'failed')
  ) {
    fail('Terminal derivative readback must carry a causal proof envelope.');
  }
  return {
    ...common,
    status: value.status,
    proof_level: 'causal_terminal',
    proof_deferred: false,
    invalid_proof_count: nonNegativeInteger(
      value.invalid_proof_count,
      'derivative_readback.invalid_proof_count',
    ),
    targets: value.targets.map(parseTerminalTarget),
  };
}

export function parseProtectedStatusProof(
  value: unknown,
  identity: ProtectedExecutionIdentity,
): ProtectedExecutionStatusProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== PROTECTED_EXECUTION_CONTRACT.status_response_schema ||
    value.command !== PROTECTED_EXECUTION_CONTRACT.read_command ||
    value.request_id !== identity.request_id ||
    !['pending', 'passed', 'failed', 'indeterminate'].includes(String(value.status)) ||
    ![
      'not_admitted',
      'dispatching',
      'dispatched',
      'running',
      'derivatives_pending',
      'completed',
      'failed',
      'indeterminate',
    ].includes(String(value.execution_status)) ||
    value.retry_allowed !== false ||
    value.actor_user_id !== identity.actor.user_id ||
    value.environment !== identity.environment ||
    value.project_ref !== identity.project_ref ||
    value.plan_sha256 !== identity.plan_sha256 ||
    value.operation_id !== identity.operation_id
  ) {
    fail('Read RPC returned a foreign or unsupported status envelope.');
  }
  const executionStatus = value.execution_status as ProtectedExecutionStatus;
  const gates = parseReadGates(value.gates);
  if (executionStatus === 'not_admitted') {
    if (value.status !== 'indeterminate' || gates.length > 3) {
      fail('A not-admitted read must be indeterminate and contain at most three gate receipts.');
    }
    return {
      schema_version: PROTECTED_EXECUTION_CONTRACT.status_response_schema,
      command: PROTECTED_EXECUTION_CONTRACT.read_command,
      request_id: identity.request_id,
      status: 'indeterminate',
      execution_status: 'not_admitted',
      retry_allowed: false,
      actor_user_id: identity.actor.user_id,
      environment: 'production',
      project_ref: identity.project_ref,
      target_visibility: null,
      plan_sha256: identity.plan_sha256,
      operation_id: identity.operation_id,
      plan_request_sha256: hash(value.plan_request_sha256, 'plan_request_sha256'),
      freeze_sha256: null,
      approval_identity_sha256: null,
      approval_text_sha256: null,
      derivative_target_set_sha256: null,
      preflight_proof_sha256: hash(value.preflight_proof_sha256, 'preflight_proof_sha256'),
      admission_request_sha256: null,
      gate_results_sha256: null,
      attempt_count: 0,
      dispatch_count: 0,
      gate_count: nonNegativeInteger(value.gate_count, 'gate_count'),
      gates,
      primary_readback: null,
      derivative_readback: {
        schema_version: 'dataset-derivative-rebuild-batch-status.v1',
        batch_id: identity.request_id,
        status: 'not_started',
        proof_level: 'none',
        proof_deferred: false,
        code: 'ALIAS_EXECUTION_NOT_ADMITTED',
        causal_terminal_proof: false,
        target_count: 0,
        flow_count: 0,
        process_count: 0,
        completed_count: 0,
        nonterminal_count: 0,
        failed_count: 0,
        invalid_proof_count: null,
        targets: [],
      },
      failure: null,
    };
  }
  if (
    value.target_visibility !== 'owner_draft' ||
    value.freeze_sha256 !== identity.bindings.freeze_sha256 ||
    value.approval_identity_sha256 !== identity.bindings.approval_identity_sha256 ||
    value.approval_text_sha256 !== identity.bindings.approval_text_sha256 ||
    value.derivative_target_set_sha256 !== identity.bindings.derivative_target_set_sha256 ||
    !isJsonObject(value.primary_readback)
  ) {
    fail('Read RPC did not round-trip the sealed owner-draft execution bindings.');
  }
  const derivativeReadback = parseDerivativeReadback(
    value.derivative_readback,
    identity.request_id,
  );
  if (
    derivativeReadback.status === 'not_started' &&
    !['dispatching', 'dispatched', 'running', 'failed', 'indeterminate'].includes(executionStatus)
  ) {
    fail(
      'A not-started derivative readback is only valid before derivative dispatch or after a zero-child terminal failure.',
    );
  }
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.status_response_schema,
    command: PROTECTED_EXECUTION_CONTRACT.read_command,
    request_id: identity.request_id,
    status: value.status as ProtectedReportStatus,
    execution_status: executionStatus,
    retry_allowed: false,
    actor_user_id: identity.actor.user_id,
    environment: 'production',
    project_ref: identity.project_ref,
    target_visibility: 'owner_draft',
    plan_sha256: identity.plan_sha256,
    operation_id: identity.operation_id,
    plan_request_sha256: hash(value.plan_request_sha256, 'plan_request_sha256'),
    freeze_sha256: identity.bindings.freeze_sha256,
    approval_identity_sha256: identity.bindings.approval_identity_sha256,
    approval_text_sha256: identity.bindings.approval_text_sha256,
    derivative_target_set_sha256: identity.bindings.derivative_target_set_sha256,
    preflight_proof_sha256: hash(value.preflight_proof_sha256, 'preflight_proof_sha256'),
    admission_request_sha256: hash(value.admission_request_sha256, 'admission_request_sha256'),
    gate_results_sha256: hash(value.gate_results_sha256, 'gate_results_sha256'),
    attempt_count: nonNegativeInteger(value.attempt_count, 'attempt_count'),
    dispatch_count: nonNegativeInteger(value.dispatch_count, 'dispatch_count'),
    gate_count: nonNegativeInteger(value.gate_count, 'gate_count'),
    gates,
    primary_readback: {
      row_count:
        value.primary_readback.row_count === null
          ? null
          : nonNegativeInteger(value.primary_readback.row_count, 'primary_readback.row_count'),
      exchange_count:
        value.primary_readback.exchange_count === null
          ? null
          : nonNegativeInteger(
              value.primary_readback.exchange_count,
              'primary_readback.exchange_count',
            ),
      alias_audit_count: nonNegativeInteger(
        value.primary_readback.alias_audit_count,
        'primary_readback.alias_audit_count',
      ),
      live_closure_proof: requiredBoolean(
        value.primary_readback.live_closure_proof,
        'primary_readback.live_closure_proof',
      ),
      closure: isJsonObject(value.primary_readback.closure)
        ? value.primary_readback.closure
        : fail('primary_readback.closure must be an object.'),
    },
    derivative_readback: derivativeReadback,
    failure:
      value.error === null
        ? null
        : isJsonObject(value.error)
          ? value.error
          : fail('error must be an object or null.'),
  };
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export const __testInternals = {
  deterministicUuidFromSha256,
  parseBindings,
  parseDerivativeTarget,
  parseExpected,
};
