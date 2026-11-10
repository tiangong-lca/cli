import { CliError } from '../shared/errors.js';
import { isJsonObject } from './maintenance/contract/values.js';
import { readJsonFile, resolveMaintenancePlanArtifactPath } from './maintenance/contract/files.js';
import { sha256Json } from './canonical-json-hash.js';
import {
  type DatasetMaintenanceAliasBatchPlan,
  type DatasetMaintenancePlan,
  type DatasetMaintenancePlanAction,
  type JsonObject,
} from './maintenance/contract/types.js';

export function loadMaintenanceDesiredPayload(
  planDir: string,
  action: DatasetMaintenancePlanAction,
): JsonObject {
  if (!action.desired_payload) {
    throw new CliError(`Maintenance action lacks desired payload: ${action.action_id}`, {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  const payloadPath = resolveMaintenancePlanArtifactPath(
    planDir,
    action.desired_payload.path,
    'Maintenance desired payload path',
  );
  const payload = readJsonFile(payloadPath, 'Maintenance desired payload');
  if (!isJsonObject(payload) || sha256Json(payload) !== action.desired_payload.sha256) {
    throw new CliError(`Desired payload hash mismatch for action ${action.action_id}.`, {
      code: 'DATASET_MAINTENANCE_DESIRED_PAYLOAD_HASH_MISMATCH',
      exitCode: 1,
    });
  }
  return payload;
}

export function orderedAliasBatches(
  plan: DatasetMaintenancePlan,
): DatasetMaintenanceAliasBatchPlan[] {
  const time = plan.alias_batches?.find((batch) => batch.dimension === 'time');
  const lengthTime = plan.alias_batches?.find((batch) => batch.dimension === 'length_time');
  return [time, lengthTime].filter(
    (batch): batch is DatasetMaintenanceAliasBatchPlan => batch !== undefined,
  );
}

export function buildAliasBatchRequest(options: {
  plan: DatasetMaintenancePlan;
  batch: DatasetMaintenanceAliasBatchPlan;
  planDir: string;
}): JsonObject {
  if (options.plan.target_mode !== 'owner_draft') {
    throw new CliError('Alias batch request requires target_mode=owner_draft.', {
      code: 'DATASET_MAINTENANCE_TARGET_MODE_INVALID',
      exitCode: 2,
    });
  }
  const targetSnapshot = (
    snapshot: NonNullable<DatasetMaintenanceAliasBatchPlan['target_snapshots']['unitgroup']>,
  ): JsonObject => ({
    id: snapshot.id,
    version: snapshot.version,
    expected_modified_at: snapshot.modified_at!,
    expected_json_ordered: snapshot.json_ordered!,
  });
  const actions = options.batch.action_ids.map((actionId) => {
    const action = options.plan.actions.find((entry) => entry.action_id === actionId);
    if (!action?.before || !action.alias_mutation) {
      throw new CliError(`Alias action is incomplete: ${actionId}`, {
        code: 'DATASET_MAINTENANCE_ALIAS_PLAN_INVALID',
        exitCode: 2,
      });
    }
    return {
      action_id: action.action_id,
      action: 'update_json_ordered',
      table: action.table,
      id: action.id,
      version: action.version,
      expected_state_code: 0,
      expected_modified_at: action.before.modified_at!,
      expected_json_ordered: action.before.json_ordered!,
      desired_json_ordered: loadMaintenanceDesiredPayload(options.planDir, action),
      mutation: action.alias_mutation,
    };
  });
  return {
    schema_version: 'dataset-alias-batch.v1',
    target_visibility: 'owner_draft',
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    batch_id: options.batch.batch_id,
    dimension: options.batch.dimension,
    factor: options.batch.factor,
    target: {
      flowproperty: targetSnapshot(options.batch.target_snapshots.flowproperty!),
      unitgroup: targetSnapshot(options.batch.target_snapshots.unitgroup!),
      source_unitgroup: targetSnapshot(options.batch.target_snapshots.source_unitgroup!),
    },
    actions,
  };
}

export function buildAliasPlanRequest(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
}): JsonObject {
  if (options.plan.target_mode !== 'owner_draft') {
    throw new CliError('Alias plan request requires target_mode=owner_draft.', {
      code: 'DATASET_MAINTENANCE_TARGET_MODE_INVALID',
      exitCode: 2,
    });
  }
  const batches = orderedAliasBatches(options.plan);
  if (
    batches.length !== 2 ||
    batches[0]?.dimension !== 'time' ||
    batches[1]?.dimension !== 'length_time'
  ) {
    throw new CliError('Alias plan request requires time followed by length_time exactly once.', {
      code: 'DATASET_MAINTENANCE_ALIAS_PLAN_INVALID',
      exitCode: 2,
    });
  }
  return {
    schema_version: 'dataset-alias-plan.v1',
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    target_visibility: 'owner_draft',
    batches: batches.map((batch) =>
      buildAliasBatchRequest({ plan: options.plan, batch, planDir: options.planDir }),
    ),
  };
}
