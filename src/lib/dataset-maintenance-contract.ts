import { sha256Json } from './canonical-json-hash.js';
import { inspectMaintenanceSupportPayload } from './dataset-maintenance-support-validation.js';
import { isDatasetMaintenanceSnapshotCompleteness } from './dataset-maintenance-pagination.js';
import { CliError } from '../shared/errors.js';
import {
  MAINTENANCE_SCAN_TABLES,
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceDerivativeSnapshot,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenancePlan,
} from './maintenance/contract/types.js';
import { isJsonObject, snapshotRemoteRow } from './maintenance/contract/values.js';
import { parseMaintenanceScope } from './maintenance/contract/scope.js';
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
  type DatasetMaintenanceAliasDimension,
  type DatasetMaintenanceEntityRef,
  type DatasetMaintenanceAliasBatch,
  type DatasetMaintenanceExchangeInstance,
  type DatasetMaintenanceAliasMutation,
  type DatasetMaintenanceScopeAction,
  type DatasetMaintenanceScope,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type DatasetMaintenanceBlocker,
  type DatasetMaintenanceProtectedRow,
  type DatasetMaintenanceReferenceImpact,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceAliasExchangeRewrite,
  type DatasetMaintenanceAliasBatchPlan,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceProgressEntry,
} from './maintenance/contract/types.js';
export {
  isJsonObject,
  snapshotRemoteRow,
  maintenanceRowKey,
} from './maintenance/contract/values.js';
export { parseMaintenanceScope } from './maintenance/contract/scope.js';
export {
  readJsonFile,
  writeImmutableJson,
  writeImmutableJsonLines,
  appendStableJsonLine,
  readJsonLinesIfPresent,
  safeActionFileName,
  resolveMaintenancePlanArtifactPath,
} from './maintenance/contract/files.js';

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
      ...(plan.alias_batches
        ? {
            alias_batches: plan.alias_batches.map((batch) => ({
              batch_id: batch.batch_id,
              dimension: batch.dimension,
              factor: batch.factor,
              source: batch.source,
              target: batch.target,
            })),
          }
        : {}),
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
      if (action.action === 'update_json_ordered' && !before.modified_at) {
        throw new CliError('Ready alias action requires a frozen modified_at value.', {
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
            : action.action === 'update_json_ordered'
              ? 'restore_atomic_alias_before_snapshot'
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
      (['save_draft', 'update_json_ordered'].includes(action.action) &&
        action.status === 'ready' &&
        (!isJsonObject(action.desired_payload) ||
          typeof action.desired_payload.path !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(String(action.desired_payload.sha256)))) ||
      (!['save_draft', 'update_json_ordered'].includes(action.action) &&
        action.desired_payload !== null)
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
    (plan.summary.update_json_ordered ?? 0) ===
      plan.actions.filter((action) => action.action === 'update_json_ordered').length &&
    (plan.summary.rebuild_derivatives ?? 0) ===
      plan.actions.filter((action) => action.action === 'rebuild_derivatives').length &&
    (plan.summary.atomic_batches ?? 0) === (plan.alias_batches?.length ?? 0) &&
    (plan.summary.scaled_exchanges ?? 0) ===
      (plan.alias_batches?.reduce((sum, batch) => sum + batch.summary.exchanges, 0) ?? 0) &&
    (plan.summary.scaled_amount_fields ?? 0) ===
      (plan.alias_batches?.reduce((sum, batch) => sum + batch.summary.amount_fields, 0) ?? 0) &&
    (plan.summary.unrelated_exchanges_preserved ?? 0) ===
      (plan.alias_batches?.reduce((sum, batch) => sum + batch.summary.unrelated_exchanges, 0) ??
        0) &&
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
  if (plan.operation === 'merge-support-aliases') {
    const batches = plan.alias_batches!;
    const batchActionIds = new Set(batches.flatMap((batch) => batch.action_ids));
    const expectedProfiles = {
      time: {
        factor: '0.00011415525114155251',
        rows: 25,
        flowproperties: 1,
        flows: 10,
        processes: 14,
        exchanges: 20,
      },
      length_time: {
        factor: '1000',
        rows: 27,
        flowproperties: 1,
        flows: 13,
        processes: 13,
        exchanges: 39,
      },
    } as const;
    const validAliasPlan =
      plan.target_mode === 'owner_draft' &&
      batches.length === 2 &&
      plan.artifacts.exchange_rewrite_plan === 'exchange-rewrite-plan.jsonl' &&
      batchActionIds.size === plan.actions.length &&
      batches.reduce((sum, batch) => sum + batch.action_ids.length, 0) === plan.actions.length &&
      batches.reduce((sum, batch) => sum + batch.summary.unrelated_exchanges, 0) === 309 &&
      plan.actions.every(
        (action) =>
          action.action === 'update_json_ordered' &&
          action.batch_id &&
          isJsonObject(action.alias_mutation) &&
          batches.some(
            (batch) =>
              batch.batch_id === action.batch_id && batch.action_ids.includes(action.action_id),
          ),
      ) &&
      batches.every((batch) => {
        const profile = expectedProfiles[batch.dimension];
        const actions = plan.actions.filter((action) => action.batch_id === batch.batch_id);
        const counts = {
          flowproperties: actions.filter((action) => action.table === 'flowproperties').length,
          flows: actions.filter((action) => action.table === 'flows').length,
          processes: actions.filter((action) => action.table === 'processes').length,
        };
        const targetSnapshots = [
          batch.target_snapshots.unitgroup,
          batch.target_snapshots.flowproperty,
        ];
        const sourceSnapshot = batch.target_snapshots.source_unitgroup;
        const supportPayloadsValid = (
          [
            {
              snapshot: batch.target_snapshots.unitgroup,
              table: 'unitgroups' as const,
              id: batch.target.unitgroup.id,
              version: batch.target.unitgroup.version,
            },
            {
              snapshot: batch.target_snapshots.flowproperty,
              table: 'flowproperties' as const,
              id: batch.target.flowproperty.id,
              version: batch.target.flowproperty.version,
            },
            {
              snapshot: sourceSnapshot,
              table: 'unitgroups' as const,
              id: batch.source.unitgroup.id,
              version: batch.source.unitgroup.version,
            },
          ] as const
        ).every((entry) => {
          if (!entry.snapshot?.json_ordered) return plan.status === 'blocked';
          const inspection = inspectMaintenanceSupportPayload({
            table: entry.table,
            payload: entry.snapshot.json_ordered,
          });
          return (
            inspection.identity.id === entry.id && inspection.identity.version === entry.version
          );
        });
        const snapshotsValid = (snapshots: DatasetMaintenanceRowSnapshot[]): boolean =>
          snapshots.every((snapshot) => {
            const remoteRow: DatasetMaintenanceRemoteRow = {
              table: snapshot.table,
              id: snapshot.id,
              version: snapshot.version,
              user_id: snapshot.user_id,
              state_code: snapshot.state_code,
              modified_at: snapshot.modified_at,
              json_ordered: snapshot.json_ordered,
              model_id: snapshot.model_id,
              rule_verification: snapshot.rule_verification,
            };
            const expectedSnapshot = snapshotRemoteRow(remoteRow);
            return (
              snapshot.row_sha256 === expectedSnapshot.row_sha256 &&
              snapshot.payload_sha256 === expectedSnapshot.payload_sha256
            );
          });
        const snapshotIdentityMatches = Boolean(
          batch.target_snapshots.unitgroup?.table === 'unitgroups' &&
          batch.target_snapshots.unitgroup.id === batch.target.unitgroup.id &&
          batch.target_snapshots.unitgroup.version === batch.target.unitgroup.version &&
          batch.target_snapshots.flowproperty?.table === 'flowproperties' &&
          batch.target_snapshots.flowproperty.id === batch.target.flowproperty.id &&
          batch.target_snapshots.flowproperty.version === batch.target.flowproperty.version &&
          sourceSnapshot?.table === 'unitgroups' &&
          sourceSnapshot.id === batch.source.unitgroup.id &&
          sourceSnapshot.version === batch.source.unitgroup.version,
        );
        const mutationsValid = actions.every((action) => {
          const mutation = action.alias_mutation!;
          if (action.table === 'flowproperties') {
            return (
              mutation.kind === 'flowproperty_unitgroup_reference' &&
              action.id === batch.source.flowproperty.id &&
              action.version === batch.source.flowproperty.version
            );
          }
          if (action.table === 'flows') {
            return (
              mutation.kind === 'flow_flowproperty_reference' &&
              mutation.flow_property_internal_id === '1' &&
              mutation.source_flowproperty_id === batch.source.flowproperty.id &&
              mutation.source_flowproperty_version === batch.source.flowproperty.version
            );
          }
          return (
            mutation.kind === 'process_exchange_amounts' &&
            sha256Json(mutation.exchanges) ===
              sha256Json(
                action.exchange_instances!.map((instance) => ({
                  index: instance.exchange_index,
                  internal_id: instance.data_set_internal_id,
                  flow_id: instance.flow_id,
                  flow_version: instance.flow_version,
                  direction: instance.direction,
                  before_exchange_sha256: instance.before_exchange_sha256,
                })),
              )
          );
        });
        const exchangeRewritesValid = batch.exchange_rewrites.every((rewrite) => {
          const action = actions.find((entry) => entry.action_id === rewrite.action_id);
          const instance = action?.exchange_instances?.find(
            (entry) =>
              entry.exchange_index === rewrite.exchange_index &&
              entry.data_set_internal_id === rewrite.data_set_internal_id &&
              entry.flow_id === rewrite.flow_id &&
              entry.flow_version === rewrite.flow_version,
          );
          return Boolean(
            action?.table === 'processes' &&
            instance &&
            rewrite.process_id === action.id &&
            rewrite.process_version === action.version &&
            rewrite.direction === instance.direction &&
            rewrite.before_exchange_sha256 === instance.before_exchange_sha256 &&
            /^[a-f0-9]{64}$/u.test(rewrite.after_exchange_sha256),
          );
        });
        return (
          profile !== undefined &&
          batch.factor === profile.factor &&
          batch.summary.rows === profile.rows &&
          counts.flowproperties === profile.flowproperties &&
          counts.flows === profile.flows &&
          counts.processes === profile.processes &&
          batch.summary.flowproperties === counts.flowproperties &&
          batch.summary.flows === counts.flows &&
          batch.summary.processes === counts.processes &&
          batch.summary.exchanges === profile.exchanges &&
          batch.postconditions.source_unitgroup_incoming_refs === 0 &&
          batch.postconditions.source_flowproperty_flow_refs === 0 &&
          batch.postconditions.target_flow_refs === (batch.dimension === 'time' ? 106 : 32) &&
          batch.postconditions.target_exchange_refs === (batch.dimension === 'time' ? 441 : 3216) &&
          batch.summary.rows === batch.action_ids.length &&
          batch.summary.amount_fields === batch.summary.exchanges * 2 &&
          batch.exchange_rewrites.length === batch.summary.exchanges &&
          snapshotIdentityMatches &&
          supportPayloadsValid &&
          mutationsValid &&
          exchangeRewritesValid &&
          (plan.status === 'blocked' ||
            (targetSnapshots.every(
              (snapshot) =>
                snapshot?.state_code === 0 &&
                snapshot.user_id === plan.account.user_id &&
                Boolean(snapshot.modified_at),
            ) &&
              sourceSnapshot?.state_code === 0 &&
              Boolean(sourceSnapshot.modified_at) &&
              sourceSnapshot.user_id === plan.account.user_id &&
              snapshotsValid([
                ...(targetSnapshots.filter(Boolean) as DatasetMaintenanceRowSnapshot[]),
                sourceSnapshot,
              ]) &&
              batch.conversion_evidence.source_unitgroup_payload_sha256 ===
                sourceSnapshot.payload_sha256 &&
              isJsonObject(batch.conversion_evidence.source_reference_unit) &&
              isJsonObject(batch.conversion_evidence.target_conversion_unit)))
        );
      });
    if (!validAliasPlan) {
      throw new CliError('Maintenance alias plan contract is inconsistent.', {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
      });
    }
  }
  if (plan.operation === 'rebuild-derivatives') {
    const action = plan.actions[0];
    const validDerivativePlan = Boolean(
      plan.target_mode === 'owner_draft' &&
      plan.actions.length === 1 &&
      !plan.alias_batches &&
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

export { sha256Json, sha256Text, stableJsonText, stableJsonValue } from './canonical-json-hash.js';
