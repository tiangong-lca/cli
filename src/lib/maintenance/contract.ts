import { sha256Json } from '../platform/canonical-json-hash.js';

import { isDatasetMaintenanceSnapshotCompleteness } from './pagination.js';
import { CliError } from '../../shared/errors.js';
import {
  MAINTENANCE_SCAN_TABLES,
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceDerivativeSnapshot,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenancePlan,
} from './contract/types.js';
import { isJsonObject, snapshotRemoteRow } from './contract/values.js';
import { parseMaintenanceScope } from './contract/scope.js';
export {
  type JsonObject,
  MAINTENANCE_MUTABLE_TABLES,
  MAINTENANCE_SUPPORT_TABLES,
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenanceMutableTable,
  type DatasetMaintenanceSupportTable,
  type DatasetMaintenanceActionTable,
  type DatasetMaintenanceScanTable,
  type DatasetMaintenanceOperation,
  type DatasetMaintenanceActionKind,
  type DatasetMaintenanceTargetMode,
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceDerivativeComponent,
  type DatasetMaintenanceDerivativeSnapshot,
  type DatasetMaintenanceScopeAction,
  type DatasetMaintenanceScope,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type DatasetMaintenanceBlocker,
  type DatasetMaintenanceProtectedRow,
  type DatasetMaintenanceReferenceImpact,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceProgressEntry,
} from './contract/types.js';
export { isJsonObject, snapshotRemoteRow, maintenanceRowKey } from './contract/values.js';
export { parseMaintenanceScope } from './contract/scope.js';
export {
  readJsonFile,
  writeImmutableJson,
  writeImmutableJsonLines,
  appendStableJsonLine,
  readJsonLinesIfPresent,
  safeActionFileName,
  resolveMaintenancePlanArtifactPath,
} from './contract/files.js';

export function computePlanSha256(plan: DatasetMaintenancePlan): string {
  const body = { ...plan, plan_sha256: '' };
  return sha256Json(body);
}

export function validDerivativeSnapshot(
  value: unknown,
  action: DatasetMaintenancePlanAction,
): value is DatasetMaintenanceDerivativeSnapshot {
  if (!isJsonObject(value)) return false;
  const requiredHashes = [value.json_sha256, value.json_ordered_sha256, value.snapshot_sha256];
  const nullableHashes = [value.extracted_md_sha256, value.embedding_ft_sha256];
  return Boolean(
    value.schema_version === 'dataset-derivative-snapshot.v1' &&
    value.table === 'processes' &&
    value.id === action.id &&
    value.version === action.version &&
    value.user_id === action.expected_user_id &&
    value.state_code === 0 &&
    value.modified_at === action.before?.modified_at &&
    typeof value.modified_at === 'string' &&
    Number.isFinite(Date.parse(value.modified_at)) &&
    requiredHashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash)) &&
    nullableHashes.every(
      (hash) => hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash)),
    ) &&
    value.json_sha256 === value.json_ordered_sha256 &&
    (value.embedding_ft_at === null ||
      (typeof value.embedding_ft_at === 'string' &&
        Number.isFinite(Date.parse(value.embedding_ft_at)))),
  );
}

export function parseMaintenancePlan(value: unknown): DatasetMaintenancePlan {
  if (
    !isJsonObject(value) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.protected_rows) ||
    !Array.isArray(value.blockers) ||
    !isJsonObject(value.account) ||
    !isJsonObject(value.artifacts)
  ) {
    throw new CliError('Maintenance plan is not a valid schema_version=1 plan.', {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  if ('alias_batches' in value)
    throw new CliError('Specialized repair plans are not supported.', {
      code: 'DATASET_MAINTENANCE_OPERATION_UNSUPPORTED',
      exitCode: 2,
    });
  const plan = value as DatasetMaintenancePlan;
  if (
    plan.snapshot_completeness !== undefined &&
    !isDatasetMaintenanceSnapshotCompleteness(plan.snapshot_completeness, MAINTENANCE_SCAN_TABLES)
  ) {
    throw new CliError('Maintenance plan snapshot completeness proof is invalid.', {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  const expected = computePlanSha256(plan);
  if (plan.plan_sha256 !== expected) {
    throw new CliError('Maintenance plan hash does not match its canonical contents.', {
      code: 'DATASET_MAINTENANCE_PLAN_HASH_MISMATCH',
      exitCode: 2,
      details: { expected, received: plan.plan_sha256 },
    });
  }

  const normalizedScope = parseMaintenanceScope(
    {
      schema_version: 1,
      task_id: plan.task_id,
      operation: plan.operation,
      account: plan.account,
      ...(plan.source_import_run_id ? { source_import_run_id: plan.source_import_run_id } : {}),
      source_lineage: plan.source_lineage,
      ...(plan.target_mode ? { target_mode: plan.target_mode } : {}),
      actions: plan.actions,
    },
    plan.operation,
  );
  const actionIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const [index, action] of plan.actions.entries()) {
    const normalizedAction = normalizedScope.actions[index];
    if (
      !normalizedAction ||
      action.action_id !== normalizedAction.action_id ||
      !Number.isInteger(action.ordinal) ||
      action.ordinal < 0 ||
      ordinals.has(action.ordinal) ||
      !['ready', 'blocked'].includes(action.status) ||
      !Array.isArray(action.blockers) ||
      !isJsonObject(action.rollback)
    ) {
      throw new CliError('Maintenance plan contains an invalid action contract.', {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
        details: { index, action_id: action.action_id },
      });
    }
    actionIds.add(action.action_id);
    ordinals.add(action.ordinal);
    if (action.status === 'ready') {
      const before = action.before;
      if (
        !isJsonObject(before) ||
        before.table !== action.table ||
        before.id !== action.id ||
        before.version !== action.version ||
        before.user_id !== action.expected_user_id ||
        before.state_code !== 0 ||
        !isJsonObject(before.json_ordered) ||
        typeof before.row_sha256 !== 'string' ||
        typeof before.payload_sha256 !== 'string' ||
        action.blockers.length > 0
      ) {
        throw new CliError('Ready maintenance plan action has an invalid before snapshot.', {
          code: 'DATASET_MAINTENANCE_PLAN_INVALID',
          exitCode: 2,
          details: { action_id: action.action_id },
        });
      }
      const remoteRow: DatasetMaintenanceRemoteRow = {
        table: before.table,
        id: before.id,
        version: before.version,
        user_id: before.user_id,
        state_code: before.state_code,
        modified_at: before.modified_at,
        json_ordered: before.json_ordered,
        model_id: before.model_id,
        rule_verification: before.rule_verification,
      };
      const expectedSnapshot = snapshotRemoteRow(remoteRow);
      if (
        before.row_sha256 !== expectedSnapshot.row_sha256 ||
        before.payload_sha256 !== expectedSnapshot.payload_sha256
      ) {
        throw new CliError('Ready maintenance plan action before snapshot hash is invalid.', {
          code: 'DATASET_MAINTENANCE_PLAN_INVALID',
          exitCode: 2,
          details: { action_id: action.action_id },
        });
      }
      const expectedRollbackStrategy =
        action.action === 'save_draft'
          ? 'save_before_snapshot'
          : action.action === 'delete'
            ? 'restore_deleted_before_snapshot'
            : 'none_derivative_only';
      const derivativeRollback = action.action === 'rebuild_derivatives';
      const rollbackMatches = derivativeRollback
        ? action.rollback.strategy === expectedRollbackStrategy &&
          action.rollback.before_payload_sha256 === null &&
          action.rollback.before_payload === null &&
          action.rollback.model_id === null &&
          action.rollback.rule_verification === null
        : action.rollback.strategy === expectedRollbackStrategy &&
          action.rollback.before_payload_sha256 === before.payload_sha256 &&
          isJsonObject(action.rollback.before_payload) &&
          sha256Json(action.rollback.before_payload) === before.payload_sha256 &&
          action.rollback.model_id === before.model_id &&
          action.rollback.rule_verification === before.rule_verification;
      if (!rollbackMatches) {
        throw new CliError('Ready maintenance plan action rollback snapshot is invalid.', {
          code: 'DATASET_MAINTENANCE_PLAN_INVALID',
          exitCode: 2,
          details: { action_id: action.action_id },
        });
      }
    }
    if (
      (['save_draft'].includes(action.action) &&
        action.status === 'ready' &&
        (!isJsonObject(action.desired_payload) ||
          typeof action.desired_payload.path !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(String(action.desired_payload.sha256)))) ||
      (!['save_draft'].includes(action.action) && action.desired_payload !== null)
    ) {
      throw new CliError('Maintenance plan action desired payload contract is invalid.', {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
        details: { action_id: action.action_id },
      });
    }
  }
  const flattenedBlockers = plan.actions.flatMap((action) => action.blockers);
  const summaryMatches =
    isJsonObject(plan.summary) &&
    plan.summary.actions === plan.actions.length &&
    plan.summary.save_draft ===
      plan.actions.filter((action) => action.action === 'save_draft').length &&
    plan.summary.delete === plan.actions.filter((action) => action.action === 'delete').length &&
    (plan.summary.update_json_ordered ?? 0) === 0 &&
    (plan.summary.rebuild_derivatives ?? 0) ===
      plan.actions.filter((action) => action.action === 'rebuild_derivatives').length &&
    (plan.summary.atomic_batches ?? 0) === 0 &&
    (plan.summary.scaled_exchanges ?? 0) === 0 &&
    (plan.summary.scaled_amount_fields ?? 0) === 0 &&
    (plan.summary.unrelated_exchanges_preserved ?? 0) === 0 &&
    plan.summary.protected_rows === plan.protected_rows.length &&
    plan.summary.blockers === plan.blockers.length &&
    Number.isInteger(plan.summary.current_reference_impacts) &&
    plan.summary.current_reference_impacts >= 0 &&
    Number.isInteger(plan.summary.projected_reference_impacts) &&
    plan.summary.projected_reference_impacts >= 0;
  const ready =
    plan.status === 'ready' &&
    plan.blockers.length === 0 &&
    flattenedBlockers.length === 0 &&
    plan.actions.every((action) => action.status === 'ready');
  const blocked =
    plan.status === 'blocked' &&
    plan.blockers.length > 0 &&
    flattenedBlockers.length > 0 &&
    plan.actions.some((action) => action.status === 'blocked');
  if (
    actionIds.size !== plan.actions.length ||
    !summaryMatches ||
    (!ready && !blocked) ||
    sha256Json(plan.blockers) !== sha256Json(flattenedBlockers)
  ) {
    throw new CliError('Maintenance plan status or blocker contract is inconsistent.', {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }

  if (plan.operation === 'rebuild-derivatives') {
    const action = plan.actions[0];
    const validDerivativePlan = Boolean(
      plan.target_mode === 'owner_draft' &&
      plan.actions.length === 1 &&
      plan.artifacts.derivative_baseline === 'derivative-baseline.json' &&
      action?.action === 'rebuild_derivatives' &&
      action.table === 'processes' &&
      sha256Json(action.components) === sha256Json(DERIVATIVE_REBUILD_COMPONENTS) &&
      action.desired_payload === null &&
      action.rollback.strategy === 'none_derivative_only' &&
      (action.status === 'blocked' || validDerivativeSnapshot(action.derivative_before, action)),
    );
    if (!validDerivativePlan) {
      throw new CliError('Maintenance derivative rebuild plan contract is inconsistent.', {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
      });
    }
  } else if (
    plan.actions.some((action) => action.derivative_before !== undefined) ||
    plan.artifacts.derivative_baseline !== undefined
  ) {
    throw new CliError('Non-derivative maintenance plan contains derivative-only fields.', {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  return plan;
}

export {
  sha256Json,
  sha256Text,
  stableJsonText,
  stableJsonValue,
} from '../platform/canonical-json-hash.js';
