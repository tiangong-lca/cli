import { CliError } from '../shared/errors.js';
import {
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceDerivativeSnapshot,
  type DatasetMaintenancePlan,
  type DatasetMaintenancePlanAction,
  type JsonObject,
} from './maintenance/contract/types.js';
import { isJsonObject } from './maintenance/contract/values.js';

export type DatasetMaintenanceDerivativeRequestStatus =
  | 'queued'
  | 'dispatching'
  | 'markdown_pending'
  | 'embedding_pending'
  | 'completed'
  | 'stale'
  | 'failed';

export type DatasetMaintenanceDerivativeSubmitProof = {
  schema_version: 'dataset-derivative-rebuild-plan.v1';
  plan_sha256: string;
  operation_id: string;
  target_visibility: 'owner_draft';
  plan_request_sha256: string;
  idempotent_replay: boolean;
  action_count: 1;
  accepted_count: 1;
  summary_audit_id: string;
  request_id: string;
  status: DatasetMaintenanceDerivativeRequestStatus;
  action_request_sha256: string;
  database_audit_id: string;
};

export type DatasetMaintenanceDerivativeStatusProof = {
  schema_version: 'dataset-derivative-rebuild-status.v1';
  request_id: string;
  plan_sha256: string;
  operation_id: string;
  action_id: string;
  table: 'processes';
  id: string;
  version: string;
  status: DatasetMaintenanceDerivativeRequestStatus;
  phase: string;
  fence_active: boolean;
  plan_request_sha256: string;
  action_request_sha256: string;
  database_audit_id: string;
  summary_audit_id: string;
  completed_snapshot_sha256: string | null;
  completed_at: string | null;
  error: JsonObject | null;
};

const SHA256 = /^[a-f0-9]{64}$/u;
const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;

function requiredToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError(`${label} must be a non-empty string.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
    });
  }
  return value.trim();
}

function requiredSha256(value: unknown, label: string): string {
  const normalized = requiredToken(value, label);
  if (!SHA256.test(normalized)) {
    throw new CliError(`${label} must be a lowercase SHA-256 digest.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
    });
  }
  return normalized;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : requiredSha256(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  const normalized = requiredToken(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new CliError(`${label} must be an ISO timestamp or null.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
    });
  }
  return normalized;
}

function requestStatus(value: unknown, label: string): DatasetMaintenanceDerivativeRequestStatus {
  const normalized = requiredToken(value, label);
  const statuses: DatasetMaintenanceDerivativeRequestStatus[] = [
    'queued',
    'dispatching',
    'markdown_pending',
    'embedding_pending',
    'completed',
    'stale',
    'failed',
  ];
  if (!statuses.includes(normalized as DatasetMaintenanceDerivativeRequestStatus)) {
    throw new CliError(`${label} is not a supported derivative rebuild status.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
    });
  }
  return normalized as DatasetMaintenanceDerivativeRequestStatus;
}

function responseBody(value: unknown, command: string): JsonObject {
  if (!isJsonObject(value) || value.ok !== true || value.command !== command) {
    throw new CliError(`${command} returned an invalid response envelope.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return value;
}

export function parseDerivativeSnapshotResponse(
  value: unknown,
  expected: { id: string; version: string; userId: string },
): DatasetMaintenanceDerivativeSnapshot {
  const body = responseBody(value, 'cmd_dataset_derivative_rebuild_snapshot');
  if (
    body.schema_version !== 'dataset-derivative-snapshot.v1' ||
    body.table !== 'processes' ||
    body.id !== expected.id ||
    body.version !== expected.version ||
    body.user_id !== expected.userId ||
    body.state_code !== 0
  ) {
    throw new CliError('Derivative snapshot identity, owner, state, or schema is invalid.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
      details: body,
    });
  }
  const modifiedAt = nullableTimestamp(body.modified_at, 'Derivative snapshot modified_at');
  if (!modifiedAt) {
    throw new CliError('Derivative snapshot modified_at must be non-null.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
    });
  }
  const jsonSha256 = requiredSha256(body.json_sha256, 'Derivative snapshot json_sha256');
  const jsonOrderedSha256 = requiredSha256(
    body.json_ordered_sha256,
    'Derivative snapshot json_ordered_sha256',
  );
  if (jsonSha256 !== jsonOrderedSha256) {
    throw new CliError('Derivative snapshot json and json_ordered hashes must match.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PRIMARY_MISMATCH',
      exitCode: 1,
      details: { json_sha256: jsonSha256, json_ordered_sha256: jsonOrderedSha256 },
    });
  }
  return {
    schema_version: 'dataset-derivative-snapshot.v1',
    table: 'processes',
    id: expected.id,
    version: expected.version,
    user_id: expected.userId,
    state_code: 0,
    modified_at: modifiedAt,
    json_sha256: jsonSha256,
    json_ordered_sha256: jsonOrderedSha256,
    extracted_md_sha256: nullableSha256(
      body.extracted_md_sha256,
      'Derivative snapshot extracted_md_sha256',
    ),
    embedding_ft_sha256: nullableSha256(
      body.embedding_ft_sha256,
      'Derivative snapshot embedding_ft_sha256',
    ),
    embedding_ft_at: nullableTimestamp(body.embedding_ft_at, 'Derivative snapshot embedding_ft_at'),
    snapshot_sha256: requiredSha256(body.snapshot_sha256, 'Derivative snapshot snapshot_sha256'),
  };
}

export function isDerivativeRebuildPlan(plan: DatasetMaintenancePlan): boolean {
  return plan.operation === 'rebuild-derivatives';
}

export function derivativePlanAction(plan: DatasetMaintenancePlan): DatasetMaintenancePlanAction {
  const action = plan.actions[0];
  if (
    !isDerivativeRebuildPlan(plan) ||
    plan.target_mode !== 'owner_draft' ||
    plan.actions.length !== 1 ||
    !action ||
    action.action !== 'rebuild_derivatives' ||
    action.table !== 'processes' ||
    !action.derivative_before
  ) {
    throw new CliError('Derivative rebuild plan does not match the fixed V1 contract.', {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  return action;
}

export function buildDerivativePlanRequest(plan: DatasetMaintenancePlan): JsonObject {
  const action = derivativePlanAction(plan);
  const derivativeBefore = action.derivative_before!;
  return {
    schema_version: 'dataset-derivative-rebuild-plan.v1',
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    target_visibility: 'owner_draft',
    actions: [
      {
        action_id: action.action_id,
        action: 'rebuild_derivatives',
        table: 'processes',
        id: action.id,
        version: action.version,
        expected_state_code: 0,
        expected_snapshot_sha256: derivativeBefore.snapshot_sha256,
        components: [...DERIVATIVE_REBUILD_COMPONENTS],
        reason_code: action.reason_code,
      },
    ],
  };
}

export function parseDerivativeSubmitResponse(
  value: unknown,
  plan: DatasetMaintenancePlan,
): DatasetMaintenanceDerivativeSubmitProof {
  const body = responseBody(value, 'cmd_dataset_derivative_rebuild_plan_guarded');
  const status = requestStatus(body.status, 'Derivative submit status');
  if (
    body.schema_version !== 'dataset-derivative-rebuild-plan.v1' ||
    body.plan_sha256 !== plan.plan_sha256 ||
    body.operation_id !== plan.operation_id ||
    body.target_visibility !== 'owner_draft' ||
    body.action_count !== 1 ||
    body.accepted_count !== 1 ||
    typeof body.idempotent_replay !== 'boolean' ||
    status !== 'queued'
  ) {
    throw new CliError('Derivative submit response does not match the approved plan.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
      details: body,
    });
  }
  const summaryAuditId = requiredToken(body.summary_audit_id, 'Derivative summary_audit_id');
  const databaseAuditId = requiredToken(body.database_audit_id, 'Derivative database_audit_id');
  if (!POSITIVE_INTEGER_TEXT.test(summaryAuditId) || !POSITIVE_INTEGER_TEXT.test(databaseAuditId)) {
    throw new CliError(
      'Derivative audit ids must be numeric strings safe from JSON precision loss.',
      {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
        exitCode: 1,
      },
    );
  }
  return {
    schema_version: 'dataset-derivative-rebuild-plan.v1',
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    target_visibility: 'owner_draft',
    plan_request_sha256: requiredSha256(body.plan_request_sha256, 'Derivative plan_request_sha256'),
    idempotent_replay: body.idempotent_replay as boolean,
    action_count: 1,
    accepted_count: 1,
    summary_audit_id: summaryAuditId,
    request_id: requiredToken(body.request_id, 'Derivative request_id'),
    status,
    action_request_sha256: requiredSha256(
      body.action_request_sha256,
      'Derivative action_request_sha256',
    ),
    database_audit_id: databaseAuditId,
  };
}

export function parseDerivativeStatusResponse(
  value: unknown,
  plan: DatasetMaintenancePlan,
  submit: DatasetMaintenanceDerivativeSubmitProof,
): DatasetMaintenanceDerivativeStatusProof {
  const action = derivativePlanAction(plan);
  const body = responseBody(value, 'cmd_dataset_derivative_rebuild_read');
  const status = requestStatus(body.status, 'Derivative read status');
  const phase = requiredToken(body.phase, 'Derivative read phase');
  if (
    body.schema_version !== 'dataset-derivative-rebuild-status.v1' ||
    body.request_id !== submit.request_id ||
    body.plan_sha256 !== plan.plan_sha256 ||
    body.operation_id !== plan.operation_id ||
    body.action_id !== action.action_id ||
    body.table !== 'processes' ||
    body.id !== action.id ||
    body.version !== action.version ||
    body.plan_request_sha256 !== submit.plan_request_sha256 ||
    body.action_request_sha256 !== submit.action_request_sha256 ||
    body.database_audit_id !== submit.database_audit_id ||
    body.summary_audit_id !== submit.summary_audit_id
  ) {
    throw new CliError('Derivative status response does not match the accepted request proof.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
      details: body,
    });
  }
  const completedSnapshotSha256 =
    body.completed_snapshot_sha256 === null
      ? null
      : requiredSha256(body.completed_snapshot_sha256, 'Derivative completed_snapshot_sha256');
  const completedAt = nullableTimestamp(body.completed_at, 'Derivative completed_at');
  const error = body.error === null ? null : isJsonObject(body.error) ? body.error : undefined;
  if (
    typeof body.fence_active !== 'boolean' ||
    error === undefined ||
    (status === 'completed' &&
      (!completedSnapshotSha256 || !completedAt || error !== null || body.fence_active)) ||
    (status !== 'completed' && (completedSnapshotSha256 !== null || completedAt !== null))
  ) {
    throw new CliError('Derivative status terminal proof is invalid.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROOF_INVALID',
      exitCode: 1,
      details: body,
    });
  }
  return {
    schema_version: 'dataset-derivative-rebuild-status.v1',
    request_id: submit.request_id,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    action_id: action.action_id,
    table: 'processes',
    id: action.id,
    version: action.version,
    status,
    phase,
    fence_active: body.fence_active as boolean,
    plan_request_sha256: submit.plan_request_sha256,
    action_request_sha256: submit.action_request_sha256,
    database_audit_id: submit.database_audit_id,
    summary_audit_id: submit.summary_audit_id,
    completed_snapshot_sha256: completedSnapshotSha256,
    completed_at: completedAt,
    error,
  };
}

export function derivativeStatusCategory(
  status: DatasetMaintenanceDerivativeRequestStatus,
): 'pending' | 'passed' | 'failed' {
  if (status === 'completed') return 'passed';
  if (['stale', 'failed'].includes(status)) return 'failed';
  return 'pending';
}
