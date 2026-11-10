import { CliError } from '../../../shared/errors.js';
import { orderedAliasBatches } from '../../dataset-maintenance-alias-request.js';
import { appendStableJsonLine, readJsonLinesIfPresent } from '../contract/files.js';
import { isJsonObject } from '../contract/values.js';
import { sha256Json } from '../../canonical-json-hash.js';
import type {
  DatasetMaintenancePlan,
  DatasetMaintenanceAliasBatchPlan,
  DatasetMaintenanceProgressEntry,
  JsonObject,
} from '../contract/types.js';
import type { DatasetMaintenanceRemoteContext } from '../../dataset-maintenance-remote.js';
import {
  type ProgressState,
  type AliasBatchProgressEntry,
  type AliasPlanBatchProof,
  type AliasPlanProgressEntry,
  type AliasPlanProgressState,
  type AliasBatchProgressState,
  type AliasRpcAuditProof,
  type AliasRpcResult,
  type AliasPlanRpcResult,
  type RetiredAliasExecutionProof,
  POSITIVE_INTEGER_TEXT,
} from './base.js';

export function validateAliasRpcResult(
  value: JsonObject,
  batch: DatasetMaintenanceAliasBatchPlan,
  plan: DatasetMaintenancePlan,
): AliasRpcResult {
  const audit = Array.isArray(value.audit) ? value.audit : [];
  const proofs = audit.filter(isJsonObject).map((entry) => ({
    action_id: entry.action_id,
    table: entry.table,
    id: entry.id,
    version: entry.version,
    audit_id: entry.audit_id,
  }));
  const proofByAction = new Map(
    proofs
      .filter(
        (entry): entry is AliasRpcAuditProof =>
          typeof entry.action_id === 'string' &&
          typeof entry.table === 'string' &&
          typeof entry.id === 'string' &&
          typeof entry.version === 'string' &&
          typeof entry.audit_id === 'string' &&
          POSITIVE_INTEGER_TEXT.test(entry.audit_id),
      )
      .map((entry) => [entry.action_id, entry]),
  );
  const actionsById = new Map(plan.actions.map((action) => [action.action_id, action]));
  const validProofs =
    proofByAction.size === batch.action_ids.length &&
    batch.action_ids.every((actionId) => {
      const action = actionsById.get(actionId);
      const proof = proofByAction.get(actionId);
      return Boolean(
        action &&
        proof &&
        proof.table === action.table &&
        proof.id === action.id &&
        proof.version === action.version,
      );
    });
  if (
    plan.target_mode !== 'owner_draft' ||
    value.ok !== true ||
    value.command !== 'cmd_dataset_alias_batch_guarded' ||
    value.target_visibility !== 'owner_draft' ||
    value.dimension !== batch.dimension ||
    value.batch_id !== batch.batch_id ||
    value.row_count !== batch.summary.rows ||
    value.exchange_count !== batch.summary.exchanges ||
    typeof value.summary_audit_id !== 'string' ||
    !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
    typeof value.batch_request_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
    typeof value.idempotent_replay !== 'boolean' ||
    audit.length !== batch.action_ids.length ||
    !validProofs
  ) {
    throw new CliError(`Alias batch RPC returned invalid proof for ${batch.batch_id}.`, {
      code: 'DATASET_MAINTENANCE_ALIAS_RPC_PROOF_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return {
    target_visibility: 'owner_draft',
    batch_request_sha256: value.batch_request_sha256,
    idempotent_replay: value.idempotent_replay,
    exchange_count: value.exchange_count,
    summary_audit_id: value.summary_audit_id,
    audits: proofByAction,
    raw: value,
  };
}

export function validateAliasPlanRpcResult(
  value: JsonObject,
  plan: DatasetMaintenancePlan,
): AliasPlanRpcResult {
  const batches = orderedAliasBatches(plan);
  const rawBatchResults = Array.isArray(value.batches) ? value.batches : [];
  const parsedBatchResults = rawBatchResults.map((entry, index) =>
    isJsonObject(entry) && batches[index]
      ? validateAliasRpcResult(entry, batches[index], plan)
      : null,
  );
  const validBatchResults = parsedBatchResults.every(
    (entry): entry is AliasRpcResult => entry !== null,
  );
  const batchSummaryAuditIds = validBatchResults
    ? parsedBatchResults.map((entry) => entry.summary_audit_id)
    : [];
  const rowAuditIds = validBatchResults
    ? parsedBatchResults.flatMap((entry) =>
        [...entry.audits.values()].map((proof) => proof.audit_id),
      )
    : [];
  if (
    plan.target_mode !== 'owner_draft' ||
    value.ok !== true ||
    value.command !== 'cmd_dataset_alias_plan_guarded' ||
    value.schema_version !== 'dataset-alias-plan.v1' ||
    value.plan_sha256 !== plan.plan_sha256 ||
    value.operation_id !== plan.operation_id ||
    value.target_visibility !== 'owner_draft' ||
    typeof value.plan_request_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
    value.batch_count !== 2 ||
    value.row_count !== 52 ||
    value.exchange_count !== 59 ||
    typeof value.summary_audit_id !== 'string' ||
    !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
    typeof value.idempotent_replay !== 'boolean' ||
    rawBatchResults.length !== 2 ||
    !validBatchResults ||
    parsedBatchResults.some(
      (entry, index) =>
        entry.idempotent_replay !== value.idempotent_replay ||
        entry.exchange_count !== batches[index]!.summary.exchanges,
    ) ||
    new Set(batchSummaryAuditIds).size !== 2 ||
    new Set(rowAuditIds).size !== 52 ||
    batchSummaryAuditIds.includes(value.summary_audit_id) ||
    rowAuditIds.includes(value.summary_audit_id) ||
    rowAuditIds.some((auditId) => batchSummaryAuditIds.includes(auditId))
  ) {
    throw new CliError('Alias plan RPC returned invalid whole-plan proof.', {
      code: 'DATASET_MAINTENANCE_ALIAS_PLAN_RPC_PROOF_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return {
    target_visibility: 'owner_draft',
    plan_request_sha256: value.plan_request_sha256,
    idempotent_replay: value.idempotent_replay,
    batch_count: 2,
    row_count: 52,
    exchange_count: 59,
    summary_audit_id: value.summary_audit_id,
    batches: new Map(
      batches.map((batch, index) => [batch.dimension, parsedBatchResults[index]!] as const),
    ),
    raw: value,
  };
}

export function aliasExchangeProgressKey(value: {
  batch_id: string;
  action_id: string;
  exchange_index: number;
  data_set_internal_id: string;
}): string {
  return `${value.batch_id}\u0000${value.action_id}\u0000${value.exchange_index}\u0000${value.data_set_internal_id}`;
}

export function appendAliasSuccessLogs(options: {
  plan: DatasetMaintenancePlan;
  batch: DatasetMaintenanceAliasBatchPlan;
  execution: RetiredAliasExecutionProof;
  progress: ProgressState;
  progressPath: string;
  exchangeProgressPath: string;
  context: DatasetMaintenanceRemoteContext;
  startedAt: string;
  endedAt: string;
}): void {
  const batchRpc = options.execution.rpc.batches.get(options.batch.dimension)!;
  for (const actionId of options.batch.action_ids) {
    const action = options.plan.actions.find((entry) => entry.action_id === actionId)!;
    const proof = batchRpc.audits.get(actionId)!;
    const existingSuccess = options.progress.successes.get(actionId);
    if (existingSuccess) {
      if (
        existingSuccess.target_mode !== 'owner_draft' ||
        existingSuccess.batch_id !== options.batch.batch_id ||
        existingSuccess.batch_request_sha256 !== batchRpc.batch_request_sha256 ||
        existingSuccess.database_audit_id !== proof.audit_id ||
        existingSuccess.summary_audit_id !== batchRpc.summary_audit_id ||
        existingSuccess.plan_request_sha256 !== options.execution.rpc.plan_request_sha256 ||
        existingSuccess.plan_summary_audit_id !== options.execution.rpc.summary_audit_id ||
        existingSuccess.after_sha256 !== options.execution.after_by_action.get(actionId)
      ) {
        throw new CliError('Existing alias row progress does not match replay audit proof.', {
          code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
          exitCode: 1,
          details: { action_id: actionId },
        });
      }
      continue;
    }
    const entry: DatasetMaintenanceProgressEntry = {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: action.action_id,
      action: action.action,
      table: action.table,
      id: action.id,
      version: action.version,
      reason_code: action.reason_code,
      audit_context: {
        plan_sha256: options.plan.plan_sha256,
        operation_id: options.plan.operation_id,
        action_id: action.action_id,
        reason_code: action.reason_code,
        source: 'tiangong-lca dataset maintenance apply',
        target_mode: 'owner_draft',
      },
      actor: { user_id: options.context.account.user_id, email: options.context.account.email },
      started_at_utc: options.startedAt,
      ended_at_utc: options.endedAt,
      before_sha256: action.before!.row_sha256,
      after_sha256: options.execution.after_by_action.get(actionId)!,
      remote_result_sha256: sha256Json({
        plan_response: options.execution.rpc.raw,
        batch_response: batchRpc.raw,
        audit: proof,
      }),
      result: 'success',
      error: null,
      rollback: action.rollback,
      batch_id: options.batch.batch_id,
      target_mode: 'owner_draft',
      batch_request_sha256: batchRpc.batch_request_sha256,
      database_audit_id: proof.audit_id,
      summary_audit_id: batchRpc.summary_audit_id,
      plan_request_sha256: options.execution.rpc.plan_request_sha256,
      plan_summary_audit_id: options.execution.rpc.summary_audit_id,
    };
    appendStableJsonLine(options.progressPath, entry);
    options.progress.entries.push(entry);
    options.progress.successes.set(actionId, entry);
    options.progress.latestFailures.delete(actionId);
  }

  const existing = readJsonLinesIfPresent(options.exchangeProgressPath);
  const existingKeys = new Set<string>();
  const expectedRewrites = new Map(
    options.plan.alias_batches!.flatMap((batch) =>
      batch.exchange_rewrites.map(
        (rewrite) =>
          [
            aliasExchangeProgressKey({ batch_id: batch.batch_id, ...rewrite }),
            { batch, rewrite },
          ] as const,
      ),
    ),
  );
  for (const value of existing) {
    const key =
      isJsonObject(value) &&
      typeof value.batch_id === 'string' &&
      typeof value.action_id === 'string' &&
      typeof value.exchange_index === 'number' &&
      typeof value.data_set_internal_id === 'string'
        ? aliasExchangeProgressKey({
            batch_id: value.batch_id,
            action_id: value.action_id,
            exchange_index: value.exchange_index,
            data_set_internal_id: value.data_set_internal_id,
          })
        : '';
    const expected = expectedRewrites.get(key);
    const rowProof = expected ? options.progress.successes.get(expected.rewrite.action_id) : null;
    if (
      !isJsonObject(value) ||
      !expected ||
      !rowProof ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== options.plan.plan_sha256 ||
      value.operation_id !== options.plan.operation_id ||
      value.target_mode !== 'owner_draft' ||
      value.factor !== expected.batch.factor ||
      value.result !== 'success' ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== options.plan.account.user_id ||
      value.actor.email !== options.plan.account.email ||
      typeof value.logged_at_utc !== 'string' ||
      typeof value.batch_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
      value.batch_request_sha256 !== rowProof.batch_request_sha256 ||
      typeof value.database_audit_id !== 'string' ||
      POSITIVE_INTEGER_TEXT.test(value.database_audit_id) === false ||
      value.database_audit_id !== rowProof.database_audit_id ||
      typeof value.summary_audit_id !== 'string' ||
      POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) === false ||
      value.summary_audit_id !== rowProof.summary_audit_id ||
      typeof value.plan_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
      value.plan_request_sha256 !== rowProof.plan_request_sha256 ||
      typeof value.plan_summary_audit_id !== 'string' ||
      !POSITIVE_INTEGER_TEXT.test(value.plan_summary_audit_id) ||
      value.plan_summary_audit_id !== rowProof.plan_summary_audit_id ||
      sha256Json({
        action_id: value.action_id,
        process_id: value.process_id,
        process_version: value.process_version,
        exchange_index: value.exchange_index,
        data_set_internal_id: value.data_set_internal_id,
        flow_id: value.flow_id,
        flow_version: value.flow_version,
        direction: value.direction,
        before_exchange_sha256: value.before_exchange_sha256,
        before_mean_amount: value.before_mean_amount,
        before_resulting_amount: value.before_resulting_amount,
        after_mean_amount: value.after_mean_amount,
        after_resulting_amount: value.after_resulting_amount,
        after_exchange_sha256: value.after_exchange_sha256,
      }) !== sha256Json(expected.rewrite) ||
      existingKeys.has(key)
    ) {
      throw new CliError('Alias exchange progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_ALIAS_EXCHANGE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    existingKeys.add(key);
  }
  for (const rewrite of options.batch.exchange_rewrites) {
    const key = aliasExchangeProgressKey({ batch_id: options.batch.batch_id, ...rewrite });
    if (existingKeys.has(key)) continue;
    const proof = batchRpc.audits.get(rewrite.action_id)!;
    appendStableJsonLine(options.exchangeProgressPath, {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      batch_id: options.batch.batch_id,
      target_mode: 'owner_draft',
      batch_request_sha256: batchRpc.batch_request_sha256,
      factor: options.batch.factor,
      actor: { user_id: options.context.account.user_id, email: options.context.account.email },
      logged_at_utc: options.endedAt,
      database_audit_id: proof.audit_id,
      summary_audit_id: batchRpc.summary_audit_id,
      plan_request_sha256: options.execution.rpc.plan_request_sha256,
      plan_summary_audit_id: options.execution.rpc.summary_audit_id,
      result: 'success',
      ...rewrite,
    });
    existingKeys.add(key);
  }
}

export function appendAliasProofProgress(options: {
  plan: DatasetMaintenancePlan;
  execution: RetiredAliasExecutionProof;
  planProgress: AliasPlanProgressState;
  batchProgress: AliasBatchProgressState;
  planProgressPath: string;
  batchProgressPath: string;
  context: DatasetMaintenanceRemoteContext;
  startedAt: string;
  endedAt: string;
}): AliasPlanProgressEntry {
  const batchProofs: AliasPlanBatchProof[] = [];
  for (const batch of orderedAliasBatches(options.plan)) {
    const rpc = options.execution.rpc.batches.get(batch.dimension)!;
    const existing = options.batchProgress.successes.get(batch.batch_id);
    if (
      existing &&
      (existing.batch_request_sha256 !== rpc.batch_request_sha256 ||
        existing.summary_audit_id !== rpc.summary_audit_id ||
        existing.plan_request_sha256 !== options.execution.rpc.plan_request_sha256 ||
        existing.plan_summary_audit_id !== options.execution.rpc.summary_audit_id)
    ) {
      throw new CliError('Existing alias batch proof does not match whole-plan replay.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
        exitCode: 1,
        details: { batch_id: batch.batch_id },
      });
    }
    const proof: AliasPlanBatchProof = {
      batch_id: batch.batch_id,
      dimension: batch.dimension,
      batch_request_sha256: rpc.batch_request_sha256,
      summary_audit_id: rpc.summary_audit_id,
    };
    batchProofs.push(proof);
    if (!existing) {
      const entry: AliasBatchProgressEntry = {
        schema_version: 1,
        plan_sha256: options.plan.plan_sha256,
        operation_id: options.plan.operation_id,
        batch_id: batch.batch_id,
        target_mode: 'owner_draft',
        dimension: batch.dimension,
        factor: batch.factor,
        actor: {
          user_id: options.context.account.user_id,
          email: options.context.account.email,
        },
        started_at_utc: options.startedAt,
        ended_at_utc: options.endedAt,
        batch_request_sha256: rpc.batch_request_sha256,
        idempotent_replay: rpc.idempotent_replay,
        row_count: batch.summary.rows,
        exchange_count: rpc.exchange_count,
        summary_audit_id: rpc.summary_audit_id,
        plan_request_sha256: options.execution.rpc.plan_request_sha256,
        plan_summary_audit_id: options.execution.rpc.summary_audit_id,
        result: 'success',
        error: null,
      };
      appendStableJsonLine(options.batchProgressPath, entry);
      options.batchProgress.entries.push(entry);
      options.batchProgress.successes.set(batch.batch_id, entry);
    }
  }
  const entry: AliasPlanProgressEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    target_mode: 'owner_draft',
    actor: { user_id: options.context.account.user_id, email: options.context.account.email },
    started_at_utc: options.startedAt,
    ended_at_utc: options.endedAt,
    plan_request_sha256: options.execution.rpc.plan_request_sha256,
    idempotent_replay: options.execution.rpc.idempotent_replay,
    batch_count: 2,
    row_count: 52,
    exchange_count: 59,
    summary_audit_id: options.execution.rpc.summary_audit_id,
    batches: batchProofs,
    result: 'success',
    error: null,
  };
  if (options.planProgress.success) {
    if (
      options.planProgress.success.plan_request_sha256 !== entry.plan_request_sha256 ||
      options.planProgress.success.summary_audit_id !== entry.summary_audit_id ||
      sha256Json(options.planProgress.success.batches) !== sha256Json(entry.batches)
    ) {
      throw new CliError('Existing alias plan proof does not match whole-plan replay.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PLAN_PROGRESS_INVALID',
        exitCode: 1,
      });
    }
    return options.planProgress.success;
  }
  appendStableJsonLine(options.planProgressPath, entry);
  options.planProgress.entries.push(entry);
  options.planProgress.success = entry;
  options.planProgress.latestFailure = null;
  return entry;
}
