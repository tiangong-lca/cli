import { POSITIVE_INTEGER_TEXT } from './base.js';
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../../../shared/errors.js';

import { appendStableJsonLine, readJsonFile, readJsonLinesIfPresent } from '../contract/files.js';
import { isJsonObject } from '../contract/values.js';
import { sha256Json, stableJsonText } from '../../platform/canonical-json-hash.js';
import type {
  DatasetMaintenancePlan,
  DatasetMaintenancePlanAction,
  DatasetMaintenanceProgressEntry,
} from '../contract/types.js';
import {
  derivativePlanAction,
  parseDerivativeSubmitResponse,
  type DatasetMaintenanceDerivativeSubmitProof,
} from '../derivatives.js';
import type { DatasetMaintenanceRemoteContext } from '../remote.js';
import {
  type ParallelDeleteExecutionStatus,
  type ParallelDeleteExecutionEntry,
  type ParallelDeleteExecutionState,
  type ProgressState,
  type DerivativeSubmitProgressEntry,
  type DerivativeSubmitProgressState,
  type DerivativeAdmissionAttempt,
  errorMessage,
  ABSENT_READBACK_SHA256,
  parallelDeleteDesiredSha256,
} from './base.js';

export function parseParallelDeleteExecutionLog(
  plan: DatasetMaintenancePlan,
  executionLogPath: string,
): ParallelDeleteExecutionState {
  const actions = new Map(plan.actions.map((action) => [action.action_id, action]));
  const entries: ParallelDeleteExecutionEntry[] = [];
  const byAction = new Map<string, ParallelDeleteExecutionEntry[]>();
  const dispatched = new Set<string>();
  const committed = new Set<string>();
  for (const value of readJsonLinesIfPresent(executionLogPath)) {
    const action =
      isJsonObject(value) && typeof value.action_id === 'string'
        ? actions.get(value.action_id)
        : null;
    const expectedDesired = action ? parallelDeleteDesiredSha256(action) : null;
    const actionEntries = action ? (byAction.get(action.action_id) ?? []) : [];
    const priorDispatched = actionEntries.some((entry) => entry.status === 'DISPATCHED');
    const priorCommitted = actionEntries.some((entry) => entry.status === 'COMMITTED');
    const status = isJsonObject(value) ? value.status : null;
    const auditIdValid =
      isJsonObject(value) &&
      (value.audit_id === null ||
        (typeof value.audit_id === 'string' && POSITIVE_INTEGER_TEXT.test(value.audit_id)));
    const remoteHashValid =
      isJsonObject(value) &&
      (value.remote_result_sha256 === null ||
        (typeof value.remote_result_sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(value.remote_result_sha256)));
    const commonOutcomeFieldsValid =
      isJsonObject(value) &&
      typeof value.attempt_consumed === 'boolean' &&
      typeof value.recovered === 'boolean' &&
      (value.readback_sha256 === null ||
        (typeof value.readback_sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(value.readback_sha256))) &&
      (value.error === null || typeof value.error === 'string');
    const statusFieldsValid =
      isJsonObject(value) &&
      ((status === 'PREPARED' &&
        value.attempt_consumed === false &&
        value.recovered === false &&
        value.audit_id === null &&
        value.readback_sha256 === null &&
        value.remote_result_sha256 === null &&
        value.error === null &&
        !priorDispatched &&
        !priorCommitted) ||
        (status === 'DISPATCHED' &&
          value.attempt_consumed === true &&
          value.recovered === false &&
          value.audit_id === null &&
          value.readback_sha256 === null &&
          value.remote_result_sha256 === null &&
          value.error === null &&
          actionEntries.some((entry) => entry.status === 'PREPARED') &&
          !priorDispatched &&
          !priorCommitted) ||
        (status === 'UNKNOWN' &&
          value.attempt_consumed === true &&
          typeof value.error === 'string' &&
          value.error.length > 0 &&
          priorDispatched &&
          !priorCommitted) ||
        (status === 'COMMITTED' &&
          value.attempt_consumed === true &&
          value.readback_sha256 === ABSENT_READBACK_SHA256 &&
          value.error === null &&
          priorDispatched &&
          !priorCommitted));
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      !action ||
      action.action !== 'delete' ||
      action.table !== 'flows' ||
      value.attempt_key !== `${action.action_id}@${expectedDesired}` ||
      value.action !== 'delete' ||
      value.table !== 'flows' ||
      value.id !== action.id ||
      value.version !== action.version ||
      value.desired_sha256 !== expectedDesired ||
      value.before_sha256 !== action.before?.row_sha256 ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      !isJsonObject(value.audit_context) ||
      value.audit_context.plan_sha256 !== plan.plan_sha256 ||
      value.audit_context.operation_id !== plan.operation_id ||
      value.audit_context.action_id !== action.action_id ||
      value.audit_context.reason_code !== action.reason_code ||
      value.audit_context.source !== 'tiangong-lca dataset maintenance apply' ||
      typeof value.recorded_at_utc !== 'string' ||
      !Number.isFinite(Date.parse(value.recorded_at_utc)) ||
      !auditIdValid ||
      !remoteHashValid ||
      !commonOutcomeFieldsValid ||
      !statusFieldsValid
    ) {
      throw new CliError('Parallel delete execution log contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_LOG_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    const entry = value as ParallelDeleteExecutionEntry;
    entries.push(entry);
    actionEntries.push(entry);
    byAction.set(action.action_id, actionEntries);
    if (entry.status === 'DISPATCHED') dispatched.add(action.action_id);
    if (entry.status === 'COMMITTED') committed.add(action.action_id);
  }
  return { entries, byAction, dispatched, committed };
}

export function appendParallelDeleteExecutionEntry(options: {
  path: string;
  state: ParallelDeleteExecutionState;
  plan: DatasetMaintenancePlan;
  action: DatasetMaintenancePlanAction;
  context: DatasetMaintenanceRemoteContext;
  status: ParallelDeleteExecutionStatus;
  recordedAtUtc: string;
  recovered?: boolean;
  auditId?: string | null;
  readbackSha256?: string | null;
  remoteResultSha256?: string | null;
  error?: string | null;
}): ParallelDeleteExecutionEntry {
  const desiredSha256 = parallelDeleteDesiredSha256(options.action);
  const entry: ParallelDeleteExecutionEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    attempt_key: `${options.action.action_id}@${desiredSha256}`,
    action: 'delete',
    table: 'flows',
    id: options.action.id,
    version: options.action.version,
    desired_sha256: desiredSha256,
    before_sha256: options.action.before!.row_sha256,
    actor: {
      user_id: options.context.account.user_id,
      email: options.context.account.email,
    },
    status: options.status,
    recorded_at_utc: options.recordedAtUtc,
    attempt_consumed: options.status !== 'PREPARED',
    recovered: options.recovered ?? false,
    audit_context: {
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: options.action.action_id,
      reason_code: options.action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    audit_id: options.auditId ?? null,
    readback_sha256: options.readbackSha256 ?? null,
    remote_result_sha256: options.remoteResultSha256 ?? null,
    error: options.error ?? null,
  };
  const descriptor = openSync(options.path, 'a', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${stableJsonText(entry)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  options.state.entries.push(entry);
  const actionEntries = options.state.byAction.get(options.action.action_id) ?? [];
  actionEntries.push(entry);
  options.state.byAction.set(options.action.action_id, actionEntries);
  if (entry.status === 'DISPATCHED') options.state.dispatched.add(options.action.action_id);
  if (entry.status === 'COMMITTED') options.state.committed.add(options.action.action_id);
  return entry;
}

export function parseProgress(plan: DatasetMaintenancePlan, progressPath: string): ProgressState {
  const rawEntries = readJsonLinesIfPresent(progressPath);
  const entries: DatasetMaintenanceProgressEntry[] = [];
  const actionsById = new Map(plan.actions.map((action) => [action.action_id, action]));
  for (const value of rawEntries) {
    const action =
      isJsonObject(value) && typeof value.action_id === 'string'
        ? actionsById.get(value.action_id)
        : null;
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      typeof value.action_id !== 'string' ||
      !action ||
      value.action !== action.action ||
      value.reason_code !== action.reason_code ||
      typeof value.before_sha256 !== 'string' ||
      !isJsonObject(value.audit_context) ||
      value.audit_context.plan_sha256 !== plan.plan_sha256 ||
      value.audit_context.operation_id !== plan.operation_id ||
      value.audit_context.action_id !== action.action_id ||
      value.audit_context.reason_code !== action.reason_code ||
      value.audit_context.source !== 'tiangong-lca dataset maintenance apply' ||
      'target_mode' in value ||
      'target_mode' in value.audit_context ||
      'batch_id' in value ||
      'batch_request_sha256' in value ||
      'database_audit_id' in value ||
      'summary_audit_id' in value ||
      'plan_request_sha256' in value ||
      'plan_summary_audit_id' in value ||
      !['success', 'failed'].includes(String(value.result)) ||
      (value.result === 'success' && typeof value.remote_result_sha256 !== 'string') ||
      (value.result === 'failed' && value.remote_result_sha256 !== null)
    ) {
      throw new CliError('Apply progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    entries.push(value as DatasetMaintenanceProgressEntry);
  }
  const successes = new Map<string, DatasetMaintenanceProgressEntry>();
  const latestFailures = new Map<string, DatasetMaintenanceProgressEntry>();
  for (const entry of entries) {
    if (entry.result === 'success') {
      successes.set(entry.action_id, entry);
      latestFailures.delete(entry.action_id);
    } else if (!successes.has(entry.action_id)) {
      latestFailures.set(entry.action_id, entry);
    }
  }
  return { entries, successes, latestFailures };
}

export function derivativeProofIdentity(proof: DatasetMaintenanceDerivativeSubmitProof): string {
  return sha256Json({
    schema_version: proof.schema_version,
    plan_sha256: proof.plan_sha256,
    operation_id: proof.operation_id,
    target_visibility: proof.target_visibility,
    plan_request_sha256: proof.plan_request_sha256,
    action_count: proof.action_count,
    accepted_count: proof.accepted_count,
    summary_audit_id: proof.summary_audit_id,
    request_id: proof.request_id,
    action_request_sha256: proof.action_request_sha256,
    database_audit_id: proof.database_audit_id,
  });
}

export function parseDerivativeSubmitProgress(
  plan: DatasetMaintenancePlan,
  progressPath: string,
): DerivativeSubmitProgressState {
  const action = derivativePlanAction(plan);
  const entries = readJsonLinesIfPresent(progressPath).map((value) => {
    const rawProof = isJsonObject(value) && isJsonObject(value.proof) ? value.proof : null;
    let proof: DatasetMaintenanceDerivativeSubmitProof;
    try {
      proof = parseDerivativeSubmitResponse(
        rawProof
          ? {
              ok: true,
              command: 'cmd_dataset_derivative_rebuild_plan_guarded',
              ...rawProof,
            }
          : null,
        plan,
      );
    } catch (error) {
      throw new CliError('Derivative submit progress contains an invalid RPC proof.', {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
        exitCode: 1,
        details: errorMessage(error),
      });
    }
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      value.action_id !== action.action_id ||
      value.target_mode !== 'owner_draft' ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      typeof value.started_at_utc !== 'string' ||
      typeof value.ended_at_utc !== 'string' ||
      value.result !== 'accepted'
    ) {
      throw new CliError('Derivative submit progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    return { ...value, proof } as DerivativeSubmitProgressEntry;
  });
  const identities = new Set(entries.map((entry) => derivativeProofIdentity(entry.proof)));
  if (identities.size > 1) {
    throw new CliError('Derivative submit replays do not identify one durable request.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
      exitCode: 1,
    });
  }
  return { entries, latest: entries.at(-1) ?? null };
}

export function validateDerivativeAdmissionAttempt(options: {
  path: string;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
}): DerivativeAdmissionAttempt | null {
  if (!existsSync(options.path)) return null;
  const value = readJsonFile(options.path, 'Derivative admission attempt');
  const action = derivativePlanAction(options.plan);
  if (
    !isJsonObject(value) ||
    value.schema_version !== 1 ||
    value.plan_sha256 !== options.plan.plan_sha256 ||
    value.operation_id !== options.plan.operation_id ||
    value.action_id !== action.action_id ||
    value.table !== 'processes' ||
    value.id !== action.id ||
    value.version !== action.version ||
    value.expected_snapshot_sha256 !== action.derivative_before?.snapshot_sha256 ||
    !isJsonObject(value.actor) ||
    value.actor.user_id !== options.context.account.user_id ||
    value.actor.email !== options.context.account.email ||
    typeof value.prepared_at_utc !== 'string' ||
    !Number.isFinite(Date.parse(value.prepared_at_utc))
  ) {
    throw new CliError('Derivative admission attempt is invalid or belongs to another plan.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_ATTEMPT_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return value as DerivativeAdmissionAttempt;
}

export function appendParallelDeleteProgress(options: {
  progressPath: string;
  progress: ProgressState;
  plan: DatasetMaintenancePlan;
  action: DatasetMaintenancePlanAction;
  context: DatasetMaintenanceRemoteContext;
  startedAtUtc: string;
  endedAtUtc: string;
  result: 'success' | 'failed';
  remoteResultSha256: string | null;
  error: string | null;
}): DatasetMaintenanceProgressEntry {
  const entry: DatasetMaintenanceProgressEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    action: 'delete',
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
    reason_code: options.action.reason_code,
    audit_context: {
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: options.action.action_id,
      reason_code: options.action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    actor: {
      user_id: options.context.account.user_id,
      email: options.context.account.email,
    },
    started_at_utc: options.startedAtUtc,
    ended_at_utc: options.endedAtUtc,
    before_sha256: options.action.before!.row_sha256,
    after_sha256: null,
    remote_result_sha256: options.remoteResultSha256,
    result: options.result,
    error: options.error,
    rollback: options.action.rollback,
  };
  appendStableJsonLine(options.progressPath, entry);
  options.progress.entries.push(entry);
  if (entry.result === 'success') {
    options.progress.successes.set(entry.action_id, entry);
    options.progress.latestFailures.delete(entry.action_id);
  } else if (!options.progress.successes.has(entry.action_id)) {
    options.progress.latestFailures.set(entry.action_id, entry);
  }
  return entry;
}

export function nextAttemptPath(planDir: string): string {
  let attempt = 1;
  while (
    existsSync(path.join(planDir, `commit-report.attempt-${String(attempt).padStart(4, '0')}.json`))
  ) {
    attempt += 1;
  }
  return path.join(planDir, `commit-report.attempt-${String(attempt).padStart(4, '0')}.json`);
}

export function nextParallelDeleteInboundBarrierPath(planDir: string): string {
  let attempt = 1;
  while (
    existsSync(
      path.join(
        planDir,
        `parallel-delete-inbound-barrier.attempt-${String(attempt).padStart(4, '0')}.json`,
      ),
    )
  ) {
    attempt += 1;
  }
  return path.join(
    planDir,
    `parallel-delete-inbound-barrier.attempt-${String(attempt).padStart(4, '0')}.json`,
  );
}
