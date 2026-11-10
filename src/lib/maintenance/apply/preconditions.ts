import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { collectRemoteReferences } from '../../dataset/remote-verify.js';
import { CliError } from '../../../shared/errors.js';
import { assertFlowReferencePropertyWriteAdmission } from '../../validation/flow-reference-properties.js';
import {
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from '../contract/types.js';
import { isJsonObject, maintenanceRowKey, snapshotRemoteRow } from '../contract/values.js';
import { readJsonFile } from '../contract/files.js';
import { sha256Json, sha256Text } from '../../platform/canonical-json-hash.js';
import { maintenanceProjectedReferenceFingerprint } from '../plan.js';
import { isSnapshotCompletenessCompatible } from '../pagination.js';
import { type DatasetMaintenanceRemoteContext } from '../remote.js';
import {
  GLOBAL_INBOUND_PROOF_MAX_AGE_MS,
  SHA256_PATTERN,
  type ParallelDeleteGlobalInboundProof,
  type ProgressState,
  errorMessage,
  loadDesiredPayload,
} from './base.js';

export function assertParallelDeletePlan(plan: DatasetMaintenancePlan): void {
  const targets = new Set<string>();
  if (
    plan.operation !== 'delete' ||
    plan.actions.length === 0 ||
    plan.actions.some((action) => action.action !== 'delete' || action.table !== 'flows') ||
    plan.summary.delete !== plan.actions.length ||
    plan.summary.save_draft !== 0 ||
    (plan.summary.update_json_ordered ?? 0) !== 0 ||
    (plan.summary.rebuild_derivatives ?? 0) !== 0 ||
    plan.summary.current_reference_impacts !== 0 ||
    plan.summary.projected_reference_impacts !== 0
  ) {
    throw new CliError(
      '--max-parallel maintenance apply requires a non-empty flow delete-only plan with zero current and projected inbound references.',
      {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_PLAN_REQUIRED',
        exitCode: 1,
      },
    );
  }
  for (const action of plan.actions) {
    const target = `${action.table}\u0000${action.id}\u0000${action.version}`;
    if (targets.has(target)) {
      throw new CliError('Parallel delete plan contains a repeated table/id/version target.', {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_TARGET_DUPLICATE',
        exitCode: 1,
        details: { table: action.table, id: action.id, version: action.version },
      });
    }
    targets.add(target);
  }
}

export function parallelDeleteTargetBindingSha256(plan: DatasetMaintenancePlan): string {
  return sha256Json(
    plan.actions.map((action, index) => ({
      index,
      ordinal: action.ordinal,
      action_id: action.action_id,
      table: action.table,
      id: action.id,
      version: action.version,
      expected_user_id: action.expected_user_id,
      expected_state_code: action.expected_state_code,
      before_sha256: action.before?.row_sha256 ?? null,
    })),
  );
}

export function invalidGlobalInboundProof(message: string, details?: unknown): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_INVALID',
    exitCode: 1,
    details,
  });
}

export function assertGlobalInboundProofOptionShape(options: {
  parallelDeleteMode: boolean;
  proofPath?: string;
  approveProof?: string;
}): void {
  const hasPath = typeof options.proofPath === 'string' && options.proofPath.length > 0;
  const hasApproval = typeof options.approveProof === 'string' && options.approveProof.length > 0;
  if (hasPath !== hasApproval) {
    throw new CliError(
      '--global-inbound-proof and --approve-global-inbound-proof must be provided together.',
      {
        code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_OPTIONS_INCOMPLETE',
        exitCode: 2,
      },
    );
  }
  if ((hasPath || hasApproval) && !options.parallelDeleteMode) {
    throw new CliError(
      'A global inbound proof is allowed only with --max-parallel flow delete-only execution.',
      {
        code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_MODE_INVALID',
        exitCode: 2,
      },
    );
  }
  if (hasApproval && !SHA256_PATTERN.test(options.approveProof!)) {
    throw new CliError('--approve-global-inbound-proof must be a lowercase SHA-256.', {
      code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_APPROVAL_INVALID',
      exitCode: 2,
    });
  }
}

export function validateParallelDeleteGlobalInboundProof(options: {
  proofPath: string | undefined;
  approveProof: string | undefined;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  now: Date;
}): ParallelDeleteGlobalInboundProof | null {
  if (!options.proofPath || !options.approveProof) return null;
  if (!path.isAbsolute(options.proofPath)) {
    invalidGlobalInboundProof('Global inbound proof path must be absolute.');
  }

  let proofText: string;
  try {
    proofText = readFileSync(options.proofPath, 'utf8');
  } catch (error) {
    invalidGlobalInboundProof('Global inbound proof file could not be read.', errorMessage(error));
  }
  const proofSha256 = sha256Text(proofText!);
  if (proofSha256 !== options.approveProof) {
    invalidGlobalInboundProof('Global inbound proof file SHA-256 does not match approval.', {
      expected: options.approveProof,
      actual: proofSha256,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(proofText!);
  } catch (error) {
    invalidGlobalInboundProof('Global inbound proof is not valid JSON.', errorMessage(error));
  }
  if (!isJsonObject(value)) {
    invalidGlobalInboundProof('Global inbound proof must be a JSON object.');
  }

  const expectedBinding = parallelDeleteTargetBindingSha256(options.plan);
  const capturedAt =
    typeof value.captured_at_utc === 'string' ? Date.parse(value.captured_at_utc) : NaN;
  const nowMs = options.now.getTime();
  const capturedAgeMs = nowMs - capturedAt;
  const safePositiveInteger = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && Number(candidate) > 0;
  if (
    value.schema_version !== 'dataset-maintenance-global-inbound-proof.v1' ||
    value.status !== 'PASS_GLOBAL_ALL_PROCESS_INBOUND_ZERO' ||
    value.statement_kind !== 'SELECT' ||
    value.source !== 'supabase_select_only_raw_sql' ||
    value.process_scope !== 'all_process_rows_without_rls_restriction' ||
    !Number.isFinite(capturedAt) ||
    capturedAgeMs < -30_000 ||
    capturedAgeMs > GLOBAL_INBOUND_PROOF_MAX_AGE_MS ||
    value.project_ref !== options.context.project_ref ||
    value.actor_user_id !== options.context.account.user_id ||
    value.plan_sha256 !== options.plan.plan_sha256 ||
    value.operation !== 'delete' ||
    value.target_table !== 'flows' ||
    value.target_count !== options.plan.actions.length ||
    value.target_binding_sha256 !== expectedBinding ||
    !safePositiveInteger(value.global_process_rows) ||
    !safePositiveInteger(value.global_exchange_rows) ||
    value.inbound_exchanges !== 0 ||
    value.old_flow_identities_with_inbound !== 0 ||
    value.process_identities_with_inbound !== 0 ||
    value.p0 !== 0 ||
    value.p1 !== 0 ||
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0
  ) {
    invalidGlobalInboundProof('Global inbound proof metadata or zero-inbound result is invalid.', {
      expected_project_ref: options.context.project_ref,
      expected_actor_user_id: options.context.account.user_id,
      expected_plan_sha256: options.plan.plan_sha256,
      expected_target_count: options.plan.actions.length,
      expected_target_binding_sha256: expectedBinding,
    });
  }

  let expectedStart = 0;
  for (const [index, rawChunk] of value.chunks.entries()) {
    if (!isJsonObject(rawChunk)) {
      invalidGlobalInboundProof('Global inbound proof contains a non-object chunk.', { index });
    }
    const chunkCapturedAt =
      typeof rawChunk.captured_at_utc === 'string' ? Date.parse(rawChunk.captured_at_utc) : NaN;
    const chunkAgeMs = nowMs - chunkCapturedAt;
    if (
      rawChunk.index !== index ||
      rawChunk.start !== expectedStart ||
      !Number.isSafeInteger(rawChunk.end_exclusive) ||
      Number(rawChunk.end_exclusive) <= expectedStart ||
      Number(rawChunk.end_exclusive) > options.plan.actions.length ||
      rawChunk.target_count !== Number(rawChunk.end_exclusive) - expectedStart ||
      !Number.isFinite(chunkCapturedAt) ||
      chunkAgeMs < -30_000 ||
      chunkAgeMs > GLOBAL_INBOUND_PROOF_MAX_AGE_MS ||
      rawChunk.inbound_exchanges !== 0 ||
      rawChunk.old_flow_identities_with_inbound !== 0 ||
      rawChunk.process_identities_with_inbound !== 0 ||
      rawChunk.owner_draft_inbound !== 0 ||
      rawChunk.public_inbound !== 0 ||
      rawChunk.foreign_private_inbound !== 0 ||
      rawChunk.other_state_inbound !== 0 ||
      typeof rawChunk.sql_sha256 !== 'string' ||
      !SHA256_PATTERN.test(rawChunk.sql_sha256)
    ) {
      invalidGlobalInboundProof('Global inbound proof contains an invalid or incomplete chunk.', {
        index,
        expected_start: expectedStart,
      });
    }
    expectedStart = Number(rawChunk.end_exclusive);
  }
  if (expectedStart !== options.plan.actions.length) {
    invalidGlobalInboundProof('Global inbound proof chunks do not cover every delete target.', {
      expected_end: options.plan.actions.length,
      actual_end: expectedStart,
    });
  }

  return {
    ...(value as Omit<ParallelDeleteGlobalInboundProof, 'proof_path' | 'proof_sha256'>),
    proof_path: options.proofPath,
    proof_sha256: proofSha256,
  };
}

export function assertNoVisibleProcessInboundReferences(options: {
  plan: DatasetMaintenancePlan;
  rows: DatasetMaintenanceRemoteRow[];
}): { process_rows: number; process_references: number; snapshot_sha256: string } {
  const targets = new Set(
    options.plan.actions.map((action) => `${action.id}\u0000${action.version}`),
  );
  const targetIds = new Set(options.plan.actions.map((action) => action.id));
  const payloadRows = options.rows
    .filter((row) => row.table === 'processes' && row.json_ordered !== null)
    .map((row) => ({
      table: row.table,
      id: row.id,
      version: row.version,
      json_ordered: row.json_ordered as JsonObject,
    }));
  const references = collectRemoteReferences(payloadRows).filter(
    (reference) =>
      reference.role === 'reference' &&
      reference.table === 'flows' &&
      typeof reference.id === 'string',
  );
  const inbound = references.filter((reference) =>
    reference.version
      ? targets.has(`${reference.id}\u0000${reference.version}`)
      : targetIds.has(reference.id!),
  );
  if (inbound.length > 0) {
    throw new CliError('Parallel flow delete admission found visible process inbound references.', {
      code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_INBOUND_REFERENCES',
      exitCode: 1,
      details: {
        inbound_count: inbound.length,
        first: inbound.slice(0, 20),
      },
    });
  }
  return {
    process_rows: payloadRows.length,
    process_references: references.length,
    snapshot_sha256: sha256Json(
      payloadRows.map((row) => ({
        table: row.table,
        id: row.id,
        version: row.version,
        payload_sha256: sha256Json(row.json_ordered),
      })),
    ),
  };
}

export function finalProjectedRows(options: {
  rows: DatasetMaintenanceRemoteRow[];
  plan: DatasetMaintenancePlan;
  planDir: string;
}): DatasetMaintenanceRemoteRow[] {
  const projected = new Map(options.rows.map((row) => [maintenanceRowKey(row), { ...row }]));
  for (const action of options.plan.actions.filter((entry) =>
    ['save_draft'].includes(entry.action),
  )) {
    const row = projected.get(maintenanceRowKey(action));
    if (row) {
      projected.set(maintenanceRowKey(action), {
        ...row,
        json_ordered: loadDesiredPayload(options.planDir, action),
      });
    }
  }
  for (const action of options.plan.actions.filter((entry) => entry.action === 'delete')) {
    projected.delete(maintenanceRowKey(action));
  }
  return [...projected.values()].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
}

export function assertApplyPreconditions(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  currentRows: DatasetMaintenanceRemoteRow[];
  progress: ProgressState;
  attemptedDeleteActionIds?: Set<string>;
}): void {
  const current = new Map(options.currentRows.map((row) => [maintenanceRowKey(row), row]));
  const baselineKeys = new Set([
    ...options.plan.protected_rows.map(maintenanceRowKey),
    ...options.plan.actions.filter((action) => action.before).map(maintenanceRowKey),
  ]);
  for (const row of options.currentRows) {
    if (!baselineKeys.has(maintenanceRowKey(row))) {
      throw new CliError(`Unexpected current-account row appeared after planning: ${row.id}`, {
        code: 'DATASET_MAINTENANCE_PREFLIGHT_DRIFT',
        exitCode: 1,
        details: { table: row.table, id: row.id, version: row.version },
      });
    }
  }
  for (const protectedRow of options.plan.protected_rows) {
    const currentRow = current.get(maintenanceRowKey(protectedRow));
    if (!currentRow || snapshotRemoteRow(currentRow).row_sha256 !== protectedRow.row_sha256) {
      throw new CliError(`Protected row drifted after planning: ${protectedRow.id}`, {
        code: 'DATASET_MAINTENANCE_PROTECTED_ROW_DRIFT',
        exitCode: 1,
        details: protectedRow,
      });
    }
  }
  for (const action of options.plan.actions) {
    if (!action.before) {
      throw new CliError(`Ready plan action lacks before snapshot: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
      });
    }
    const currentRow = current.get(maintenanceRowKey(action));
    const alreadySucceeded = options.progress.successes.has(action.action_id);
    if (alreadySucceeded && action.action === 'delete') {
      if (currentRow) {
        throw new CliError(`Previously deleted row is visible again: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_RESUME_DRIFT',
          exitCode: 1,
        });
      }
      continue;
    }
    if (action.action === 'delete' && options.attemptedDeleteActionIds?.has(action.action_id)) {
      // A request may have committed before its response or progress row was
      // persisted, or the target may have drifted after dispatch. The execution
      // ledger owns both cases and permits only read-only recovery, never an
      // automatic replay.
      continue;
    }
    if (!currentRow || currentRow.user_id !== action.expected_user_id) {
      throw new CliError(`Action row is missing, non-draft, or not owned: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_ACTION_ROW_DRIFT',
        exitCode: 1,
      });
    }
    const currentSnapshot = snapshotRemoteRow(currentRow);

    if (alreadySucceeded) {
      const expectedPayloadSha256 = sha256Json(loadDesiredPayload(options.planDir, action));
      if (
        currentRow.state_code !== 0 ||
        currentSnapshot.payload_sha256 !== expectedPayloadSha256 ||
        currentRow.model_id !== action.before.model_id ||
        currentRow.rule_verification !== action.before.rule_verification
      ) {
        throw new CliError(`Previously saved row payload drifted: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_RESUME_DRIFT',
          exitCode: 1,
        });
      }
    } else if (
      currentRow.state_code !== 0 ||
      currentSnapshot.row_sha256 !== action.before.row_sha256
    ) {
      throw new CliError(`Pending action row drifted after planning: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_ACTION_ROW_DRIFT',
        exitCode: 1,
      });
    }
    if (!alreadySucceeded && action.action === 'save_draft' && action.table === 'flows') {
      assertFlowReferencePropertyWriteAdmission(loadDesiredPayload(options.planDir, action));
    }
  }
  const projected = finalProjectedRows({
    rows: options.currentRows,
    plan: options.plan,
    planDir: options.planDir,
  });
  const projectedReferenceSha256 = sha256Json(maintenanceProjectedReferenceFingerprint(projected));
  if (projectedReferenceSha256 !== options.plan.projected_reference_sha256) {
    throw new CliError('Projected reference closure drifted after planning.', {
      code: 'DATASET_MAINTENANCE_REFERENCE_PREFLIGHT_DRIFT',
      exitCode: 1,
      details: {
        expected: options.plan.projected_reference_sha256,
        actual: projectedReferenceSha256,
      },
    });
  }
}

export function validateApprovalRecord(options: {
  path: string;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
}): void {
  if (!existsSync(options.path)) {
    return;
  }
  const record = readJsonFile(options.path, 'Maintenance approval record');
  if (
    !isJsonObject(record) ||
    record.plan_sha256 !== options.plan.plan_sha256 ||
    record.target_mode !== options.plan.target_mode ||
    !isJsonObject(record.account) ||
    record.account.user_id !== options.context.account.user_id ||
    record.account.email !== options.context.account.email ||
    !isSnapshotCompletenessCompatible(
      record.snapshot_completeness,
      options.plan.snapshot_completeness,
      MAINTENANCE_SCAN_TABLES,
    )
  ) {
    throw new CliError('Existing approval record does not match this plan and actor.', {
      code: 'DATASET_MAINTENANCE_APPROVAL_RECORD_MISMATCH',
      exitCode: 1,
    });
  }
}
