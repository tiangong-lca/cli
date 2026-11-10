import { CliError } from '../../../shared/errors.js';
import { sha256Json } from '../../canonical-json-hash.js';
import { snapshotRemoteRow } from '../contract/values.js';
import { writeImmutableJson } from '../contract/files.js';
import type {
  DatasetMaintenancePlan,
  DatasetMaintenancePlanAction,
  DatasetMaintenanceMutableTable,
  DatasetMaintenanceRemoteRow,
  JsonObject,
} from '../contract/types.js';
import {
  buildDerivativePlanRequest,
  derivativePlanAction,
  parseDerivativeSnapshotResponse,
  parseDerivativeSubmitResponse,
  type DatasetMaintenanceDerivativeSubmitProof,
} from '../../dataset-maintenance-derivatives.js';
import {
  applyMaintenanceDerivativeRebuild,
  deleteMaintenanceRow,
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceExactRows,
  saveDraftMaintenanceRow,
  type DatasetMaintenanceRemoteContext,
} from '../../dataset-maintenance-remote.js';
import {
  type ParallelDeleteExecutionState,
  type ProgressState,
  type DerivativeAdmissionAttempt,
  POSITIVE_INTEGER_TEXT,
  errorMessage,
  ABSENT_READBACK_SHA256,
  parallelDeleteDesiredSha256,
  loadDesiredPayload,
} from './base.js';
import { appendParallelDeleteExecutionEntry, appendParallelDeleteProgress } from './progress.js';

export async function executeAction(options: {
  action: DatasetMaintenancePlanAction;
  plan: DatasetMaintenancePlan;
  planDir: string;
  context: DatasetMaintenanceRemoteContext;
}): Promise<{ afterSha256: string | null; remoteResultSha256: string }> {
  if (options.action.action === 'rebuild_derivatives') {
    throw new CliError(
      'Derivative rebuild actions may only execute through the guarded whole-plan RPC.',
      {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_SEQUENTIAL_WRITE_FORBIDDEN',
        exitCode: 1,
      },
    );
  }
  if (!options.action.before) {
    throw new CliError(`Action lacks a before snapshot: ${options.action.action_id}`, {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  const justInTime = await fetchMaintenanceExactRows({
    context: options.context,
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
  });
  const pendingRow = justInTime.rows.length === 1 ? justInTime.rows[0] : null;
  const pendingSnapshot = pendingRow ? snapshotRemoteRow(pendingRow) : null;
  const exactDraft = Boolean(
    pendingRow &&
    pendingRow.state_code === 0 &&
    pendingSnapshot?.row_sha256 === options.action.before.row_sha256,
  );
  if (!pendingRow || pendingRow.user_id !== options.action.expected_user_id || !exactDraft) {
    throw new CliError(`Action row drifted immediately before write: ${options.action.action_id}`, {
      code: 'DATASET_MAINTENANCE_ACTION_JUST_IN_TIME_DRIFT',
      exitCode: 1,
    });
  }
  const audit = {
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    reason_code: options.action.reason_code,
    source: 'tiangong-lca dataset maintenance apply' as const,
  };
  if (options.action.action === 'save_draft') {
    const remoteResult = await saveDraftMaintenanceRow({
      context: options.context,
      table: options.action.table as DatasetMaintenanceMutableTable,
      id: options.action.id,
      version: options.action.version,
      payload: loadDesiredPayload(options.planDir, options.action),
      modelId: options.action.before?.model_id ?? null,
      ruleVerification: options.action.before?.rule_verification ?? null,
      audit,
    });
    const readback = await fetchMaintenanceExactRows({
      context: options.context,
      table: options.action.table,
      id: options.action.id,
      version: options.action.version,
    });
    const row = readback.rows[0];
    if (readback.rows.length !== 1 || !row) {
      throw new CliError(`save_draft readback failed for ${options.action.action_id}.`, {
        code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
        exitCode: 1,
      });
    }
    const expectedPayload = options.action.desired_payload?.sha256;
    const readbackSnapshot = snapshotRemoteRow(row);
    if (
      readbackSnapshot.payload_sha256 !== expectedPayload ||
      row.user_id !== options.action.expected_user_id ||
      row.state_code !== 0
    ) {
      throw new CliError(`save_draft readback mismatch for ${options.action.action_id}.`, {
        code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
        exitCode: 1,
      });
    }
    return {
      afterSha256: readbackSnapshot.row_sha256,
      remoteResultSha256: sha256Json(remoteResult),
    };
  }
  if (options.action.action === 'update_json_ordered') {
    throw new CliError('Atomic alias actions must execute through the whole-plan RPC.', {
      code: 'DATASET_MAINTENANCE_ALIAS_SEQUENTIAL_WRITE_FORBIDDEN',
      exitCode: 1,
    });
  }
  if (options.action.action !== 'delete') {
    throw new CliError(`Unsupported maintenance action: ${options.action.action}`, {
      code: 'DATASET_MAINTENANCE_ACTION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const remoteResult = await deleteMaintenanceRow({
    context: options.context,
    table: options.action.table as DatasetMaintenanceMutableTable,
    id: options.action.id,
    version: options.action.version,
    audit,
  });
  const readback = await fetchMaintenanceExactRows({
    context: options.context,
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
  });
  if (readback.rows.length !== 0) {
    throw new CliError(`delete readback failed for ${options.action.action_id}.`, {
      code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
      exitCode: 1,
    });
  }
  return { afterSha256: null, remoteResultSha256: sha256Json(remoteResult) };
}

export function remoteAuditId(value: JsonObject): string | null {
  const candidate = value.audit_id;
  return typeof candidate === 'string' && POSITIVE_INTEGER_TEXT.test(candidate) ? candidate : null;
}

export async function exactParallelDeleteRows(options: {
  context: DatasetMaintenanceRemoteContext;
  action: DatasetMaintenancePlanAction;
}): Promise<DatasetMaintenanceRemoteRow[]> {
  return (
    await fetchMaintenanceExactRows({
      context: options.context,
      table: options.action.table,
      id: options.action.id,
      version: options.action.version,
    })
  ).rows;
}

export function exactParallelDeleteBefore(options: {
  rows: DatasetMaintenanceRemoteRow[];
  action: DatasetMaintenancePlanAction;
}): boolean {
  const row = options.rows[0];
  return Boolean(
    options.rows.length === 1 &&
    row &&
    row.user_id === options.action.expected_user_id &&
    row.state_code === 0 &&
    snapshotRemoteRow(row).row_sha256 === options.action.before?.row_sha256,
  );
}

export async function executeParallelDeletePlan(options: {
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  progress: ProgressState;
  progressPath: string;
  executionLogPath: string;
  execution: ParallelDeleteExecutionState;
  maxParallel: number;
  now: () => string;
}): Promise<Map<string, 'success' | 'failed' | 'unknown'>> {
  const statuses = new Map<string, 'success' | 'failed' | 'unknown'>();

  const recoverAttempted = async (action: DatasetMaintenancePlanAction): Promise<void> => {
    const startedAt = options.now();
    let rows: DatasetMaintenanceRemoteRow[];
    try {
      rows = await exactParallelDeleteRows({ context: options.context, action });
    } catch (error) {
      statuses.set(action.action_id, 'unknown');
      if (options.execution.byAction.get(action.action_id)?.at(-1)?.status !== 'UNKNOWN') {
        appendParallelDeleteExecutionEntry({
          path: options.executionLogPath,
          state: options.execution,
          plan: options.plan,
          action,
          context: options.context,
          status: 'UNKNOWN',
          recordedAtUtc: options.now(),
          recovered: true,
          error: `Read-only recovery failed: ${errorMessage(error)}`,
        });
      }
      return;
    }
    if (rows.length === 0) {
      const priorCommitted = options.execution.committed.has(action.action_id);
      if (!priorCommitted) {
        appendParallelDeleteExecutionEntry({
          path: options.executionLogPath,
          state: options.execution,
          plan: options.plan,
          action,
          context: options.context,
          status: 'COMMITTED',
          recordedAtUtc: options.now(),
          recovered: true,
          readbackSha256: ABSENT_READBACK_SHA256,
        });
      }
      if (!options.progress.successes.has(action.action_id)) {
        appendParallelDeleteProgress({
          progressPath: options.progressPath,
          progress: options.progress,
          plan: options.plan,
          action,
          context: options.context,
          startedAtUtc: startedAt,
          endedAtUtc: options.now(),
          result: 'success',
          remoteResultSha256: sha256Json({
            recovery: 'desired_absent',
            action_id: action.action_id,
            desired_sha256: parallelDeleteDesiredSha256(action),
          }),
          error: null,
        });
      }
      statuses.set(action.action_id, 'success');
      return;
    }
    const message = exactParallelDeleteBefore({ rows, action })
      ? 'Prior dispatch has exact-before readback but no zero-dispatch/zero-mutation audit proof; replay is forbidden.'
      : 'Prior dispatch has ambiguous or drifted readback; replay is forbidden.';
    if (
      !options.execution.committed.has(action.action_id) &&
      options.execution.byAction.get(action.action_id)?.at(-1)?.status !== 'UNKNOWN'
    ) {
      appendParallelDeleteExecutionEntry({
        path: options.executionLogPath,
        state: options.execution,
        plan: options.plan,
        action,
        context: options.context,
        status: 'UNKNOWN',
        recordedAtUtc: options.now(),
        recovered: true,
        readbackSha256: sha256Json(rows.map(snapshotRemoteRow)),
        error: message,
      });
    }
    if (!options.progress.successes.has(action.action_id)) {
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'failed',
        remoteResultSha256: null,
        error: `UNKNOWN: ${message}`,
      });
    }
    statuses.set(action.action_id, 'unknown');
  };

  const executeOne = async (action: DatasetMaintenancePlanAction): Promise<void> => {
    if (options.progress.successes.has(action.action_id)) {
      statuses.set(action.action_id, 'success');
      return;
    }
    if (options.execution.dispatched.has(action.action_id)) {
      await recoverAttempted(action);
      return;
    }

    const startedAt = options.now();
    let rows: DatasetMaintenanceRemoteRow[];
    try {
      rows = await exactParallelDeleteRows({ context: options.context, action });
      if (!exactParallelDeleteBefore({ rows, action })) {
        throw new CliError(`Action row drifted immediately before write: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_ACTION_JUST_IN_TIME_DRIFT',
          exitCode: 1,
        });
      }
    } catch (error) {
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'failed',
        remoteResultSha256: null,
        error: errorMessage(error),
      });
      statuses.set(action.action_id, 'failed');
      return;
    }

    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'PREPARED',
      recordedAtUtc: options.now(),
    });
    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'DISPATCHED',
      recordedAtUtc: options.now(),
    });

    let remoteResult: JsonObject | null = null;
    let dispatchError: unknown = null;
    try {
      remoteResult = await deleteMaintenanceRow({
        context: options.context,
        table: action.table as DatasetMaintenanceMutableTable,
        id: action.id,
        version: action.version,
        audit: {
          plan_sha256: options.plan.plan_sha256,
          operation_id: options.plan.operation_id,
          action_id: action.action_id,
          reason_code: action.reason_code,
          desired_sha256: parallelDeleteDesiredSha256(action),
          source: 'tiangong-lca dataset maintenance apply',
        },
      });
    } catch (error) {
      dispatchError = error;
    }

    let readbackRows: DatasetMaintenanceRemoteRow[] | null = null;
    let readbackError: unknown = null;
    try {
      readbackRows = await exactParallelDeleteRows({ context: options.context, action });
    } catch (error) {
      readbackError = error;
    }
    if (readbackRows?.length === 0) {
      const remoteResultSha256 = remoteResult ? sha256Json(remoteResult) : null;
      appendParallelDeleteExecutionEntry({
        path: options.executionLogPath,
        state: options.execution,
        plan: options.plan,
        action,
        context: options.context,
        status: 'COMMITTED',
        recordedAtUtc: options.now(),
        recovered: dispatchError !== null,
        auditId: remoteResult ? remoteAuditId(remoteResult) : null,
        readbackSha256: ABSENT_READBACK_SHA256,
        remoteResultSha256,
      });
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'success',
        remoteResultSha256:
          remoteResultSha256 ??
          sha256Json({
            recovery: 'desired_absent',
            action_id: action.action_id,
            desired_sha256: parallelDeleteDesiredSha256(action),
          }),
        error: null,
      });
      statuses.set(action.action_id, 'success');
      return;
    }

    const error = readbackError
      ? `Readback failed after dispatch: ${errorMessage(readbackError)}`
      : dispatchError
        ? `Dispatch outcome ambiguous and desired absence was not observed: ${errorMessage(dispatchError)}`
        : 'Delete RPC returned but exact absent readback was not observed.';
    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'UNKNOWN',
      recordedAtUtc: options.now(),
      recovered: dispatchError !== null,
      auditId: remoteResult ? remoteAuditId(remoteResult) : null,
      readbackSha256: readbackRows ? sha256Json(readbackRows.map(snapshotRemoteRow)) : null,
      remoteResultSha256: remoteResult ? sha256Json(remoteResult) : null,
      error,
    });
    appendParallelDeleteProgress({
      progressPath: options.progressPath,
      progress: options.progress,
      plan: options.plan,
      action,
      context: options.context,
      startedAtUtc: startedAt,
      endedAtUtc: options.now(),
      result: 'failed',
      remoteResultSha256: null,
      error: `UNKNOWN: ${error}`,
    });
    statuses.set(action.action_id, 'unknown');
  };

  let nextIndex = 0;
  let fatalError: unknown = null;
  const worker = async (): Promise<void> => {
    while (fatalError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.plan.actions.length) return;
      try {
        await executeOne(options.plan.actions[index]!);
      } catch (error) {
        fatalError ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.maxParallel, options.plan.actions.length) }, () =>
      worker(),
    ),
  );
  if (fatalError !== null) throw fatalError;
  return statuses;
}

export async function executeDerivativeAdmission(options: {
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  replayPossible: boolean;
  attemptPath: string;
  preparedAtUtc: string;
}): Promise<DatasetMaintenanceDerivativeSubmitProof> {
  const action = derivativePlanAction(options.plan);
  const plannedSnapshot = action.derivative_before!;
  const preflight = parseDerivativeSnapshotResponse(
    await fetchMaintenanceDerivativeSnapshot({
      context: options.context,
      id: action.id,
      version: action.version,
    }),
    { id: action.id, version: action.version, userId: action.expected_user_id },
  );
  if (
    preflight.modified_at !== plannedSnapshot.modified_at ||
    preflight.json_sha256 !== plannedSnapshot.json_sha256 ||
    preflight.json_ordered_sha256 !== plannedSnapshot.json_ordered_sha256
  ) {
    throw new CliError('Derivative action primary preconditions drifted after planning.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PRIMARY_DRIFT',
      exitCode: 1,
      details: {
        expected_snapshot_sha256: plannedSnapshot.snapshot_sha256,
        actual_snapshot_sha256: preflight.snapshot_sha256,
      },
    });
  }
  if (!options.replayPossible && preflight.snapshot_sha256 !== plannedSnapshot.snapshot_sha256) {
    throw new CliError('Derivative action-scoped snapshot drifted before first admission.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_SNAPSHOT_DRIFT',
      exitCode: 1,
      details: {
        expected: plannedSnapshot.snapshot_sha256,
        actual: preflight.snapshot_sha256,
      },
    });
  }
  if (!options.replayPossible) {
    writeImmutableJson(options.attemptPath, {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: action.action_id,
      table: 'processes',
      id: action.id,
      version: action.version,
      expected_snapshot_sha256: plannedSnapshot.snapshot_sha256,
      actor: {
        user_id: options.context.account.user_id,
        email: options.context.account.email,
      },
      prepared_at_utc: options.preparedAtUtc,
    } satisfies DerivativeAdmissionAttempt);
  }
  const result = await applyMaintenanceDerivativeRebuild({
    context: options.context,
    plan: buildDerivativePlanRequest(options.plan),
  });
  return parseDerivativeSubmitResponse(result, options.plan);
}
