import { CliError } from '../../../shared/errors.js';
import {
  MAINTENANCE_MUTABLE_TABLES,
  type DatasetMaintenanceActionTable,
  type DatasetMaintenanceOperation,
  type DatasetMaintenanceActionKind,
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceAliasDimension,
  type DatasetMaintenanceEntityRef,
  type DatasetMaintenanceAliasBatch,
  type DatasetMaintenanceExchangeInstance,
  type DatasetMaintenanceScopeAction,
  type DatasetMaintenanceScope,
} from './types.js';
import { token, isJsonObject, maintenanceRowKey, requireToken } from './values.js';
import { safeActionFileName } from './files.js';

export function parseEntityRef(value: unknown, label: string): DatasetMaintenanceEntityRef {
  if (!isJsonObject(value)) {
    throw new CliError(`Maintenance scope ${label} must be an object.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  return {
    id: requireToken(value.id, `${label}.id`),
    version: requireToken(value.version, `${label}.version`),
  };
}

export function parseAliasBatch(value: unknown, index: number): DatasetMaintenanceAliasBatch {
  const label = `alias_batches[${index}]`;
  if (!isJsonObject(value) || !isJsonObject(value.source) || !isJsonObject(value.target)) {
    throw new CliError(`Maintenance scope ${label} must include source and target objects.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const dimension = requireToken(value.dimension, `${label}.dimension`);
  const factors: Record<DatasetMaintenanceAliasDimension, string> = {
    time: '0.00011415525114155251',
    length_time: '1000',
  };
  if (!(dimension in factors)) {
    throw new CliError(`Unsupported alias-rewrite dimension: ${dimension}`, {
      code: 'DATASET_MAINTENANCE_ALIAS_DIMENSION_INVALID',
      exitCode: 2,
    });
  }
  const factor = requireToken(value.factor, `${label}.factor`);
  if (factor !== factors[dimension as DatasetMaintenanceAliasDimension]) {
    throw new CliError(`Alias-rewrite factor does not match dimension ${dimension}.`, {
      code: 'DATASET_MAINTENANCE_ALIAS_FACTOR_INVALID',
      exitCode: 2,
    });
  }
  return {
    batch_id: requireToken(value.batch_id, `${label}.batch_id`),
    dimension: dimension as DatasetMaintenanceAliasDimension,
    factor,
    source: {
      unitgroup: parseEntityRef(value.source.unitgroup, `${label}.source.unitgroup`),
      flowproperty: parseEntityRef(value.source.flowproperty, `${label}.source.flowproperty`),
    },
    target: {
      unitgroup: parseEntityRef(value.target.unitgroup, `${label}.target.unitgroup`),
      flowproperty: parseEntityRef(value.target.flowproperty, `${label}.target.flowproperty`),
    },
  };
}

export function parseExchangeInstance(
  value: unknown,
  actionIndex: number,
  exchangeIndex: number,
): DatasetMaintenanceExchangeInstance {
  const label = `actions[${actionIndex}].exchange_instances[${exchangeIndex}]`;
  if (
    !isJsonObject(value) ||
    typeof value.exchange_index !== 'number' ||
    !Number.isInteger(value.exchange_index) ||
    value.exchange_index < 0
  ) {
    throw new CliError(
      `Maintenance scope ${label}.exchange_index must be a non-negative integer.`,
      {
        code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
        exitCode: 2,
      },
    );
  }
  const beforeExchangeSha256 = requireToken(
    value.before_exchange_sha256,
    `${label}.before_exchange_sha256`,
  );
  if (!/^[a-f0-9]{64}$/u.test(beforeExchangeSha256)) {
    throw new CliError(`Maintenance scope ${label}.before_exchange_sha256 is invalid.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const direction = requireToken(value.direction, `${label}.direction`);
  if (!['Input', 'Output'].includes(direction)) {
    throw new CliError(`Maintenance scope ${label}.direction must be Input or Output.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  return {
    exchange_index: value.exchange_index as number,
    data_set_internal_id: requireToken(value.data_set_internal_id, `${label}.data_set_internal_id`),
    flow_id: requireToken(value.flow_id, `${label}.flow_id`),
    flow_version: requireToken(value.flow_version, `${label}.flow_version`),
    direction: direction as 'Input' | 'Output',
    before_exchange_sha256: beforeExchangeSha256,
    before_mean_amount: requireToken(value.before_mean_amount, `${label}.before_mean_amount`),
    before_resulting_amount: requireToken(
      value.before_resulting_amount,
      `${label}.before_resulting_amount`,
    ),
  };
}

export function parseAction(
  value: unknown,
  index: number,
  accountUserId: string,
  operation: DatasetMaintenanceOperation,
): DatasetMaintenanceScopeAction {
  if (!isJsonObject(value)) {
    throw new CliError(`Maintenance scope action ${index} must be an object.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const action = requireToken(value.action, `actions[${index}].action`);
  const table = requireToken(value.table, `actions[${index}].table`);
  if (!['save_draft', 'delete', 'update_json_ordered', 'rebuild_derivatives'].includes(action)) {
    throw new CliError(`Unsupported maintenance action: ${action}`, {
      code: 'DATASET_MAINTENANCE_ACTION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const aliasAction = action === 'update_json_ordered';
  const derivativeAction = action === 'rebuild_derivatives';
  const allowedTable = derivativeAction
    ? table === 'processes'
    : aliasAction
      ? ['flowproperties', 'flows', 'processes'].includes(table)
      : (MAINTENANCE_MUTABLE_TABLES as readonly string[]).includes(table);
  if (!allowedTable) {
    throw new CliError(
      `Maintenance cannot mutate protected or unsupported dataset table: ${table}`,
      {
        code: 'DATASET_MAINTENANCE_TABLE_PROTECTED',
        exitCode: 2,
      },
    );
  }
  if (
    (operation === 'merge-support-aliases' && !aliasAction) ||
    (operation === 'rebuild-derivatives' && !derivativeAction) ||
    (!['merge-support-aliases', 'rebuild-derivatives'].includes(operation) &&
      (aliasAction || derivativeAction))
  ) {
    throw new CliError(`Maintenance operation ${operation} cannot contain ${action} actions.`, {
      code: 'DATASET_MAINTENANCE_OPERATION_ACTION_MISMATCH',
      exitCode: 2,
    });
  }
  if (value.expected_state_code !== 0) {
    throw new CliError(`Maintenance action ${index} must require expected_state_code=0.`, {
      code: 'DATASET_MAINTENANCE_NON_DRAFT_FORBIDDEN',
      exitCode: 2,
    });
  }
  const expectedUserId = requireToken(value.expected_user_id, `actions[${index}].expected_user_id`);
  if (expectedUserId !== accountUserId) {
    throw new CliError(`Maintenance action ${index} owner does not match scope account.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_OWNER_MISMATCH',
      exitCode: 2,
    });
  }
  if (!Array.isArray(value.evidence)) {
    throw new CliError(`Maintenance action ${index} evidence must be an array.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const desiredPayloadPath = token(value.desired_payload_path);
  if (action === 'save_draft' && !desiredPayloadPath) {
    throw new CliError(`Maintenance save_draft action ${index} requires desired_payload_path.`, {
      code: 'DATASET_MAINTENANCE_DESIRED_PAYLOAD_REQUIRED',
      exitCode: 2,
    });
  }
  if (action !== 'save_draft' && desiredPayloadPath) {
    throw new CliError(
      `Maintenance ${action} action ${index} cannot include desired_payload_path.`,
      {
        code: 'DATASET_MAINTENANCE_DESIRED_PAYLOAD_FORBIDDEN',
        exitCode: 2,
      },
    );
  }
  const batchId = token(value.batch_id);
  if (aliasAction !== Boolean(batchId)) {
    throw new CliError(
      aliasAction
        ? `Maintenance alias action ${index} requires batch_id.`
        : `Maintenance non-alias action ${index} cannot include batch_id.`,
      {
        code: 'DATASET_MAINTENANCE_ALIAS_BATCH_BINDING_INVALID',
        exitCode: 2,
      },
    );
  }
  const exchangeInstances = Array.isArray(value.exchange_instances)
    ? value.exchange_instances.map((entry, exchangeIndex) =>
        parseExchangeInstance(entry, index, exchangeIndex),
      )
    : [];
  if (
    aliasAction &&
    ((table === 'processes' && exchangeInstances.length === 0) ||
      (table !== 'processes' && exchangeInstances.length > 0))
  ) {
    throw new CliError(
      `Alias action ${index} exchange_instances must be non-empty only for processes.`,
      {
        code: 'DATASET_MAINTENANCE_ALIAS_EXCHANGE_SCOPE_INVALID',
        exitCode: 2,
      },
    );
  }
  if (!aliasAction && 'exchange_instances' in value) {
    throw new CliError(`Maintenance non-alias action ${index} cannot include exchange_instances.`, {
      code: 'DATASET_MAINTENANCE_ALIAS_EXCHANGE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const components = Array.isArray(value.components)
    ? value.components.map((component, componentIndex) =>
        requireToken(component, `actions[${index}].components[${componentIndex}]`),
      )
    : [];
  if (
    derivativeAction &&
    (components.length !== DERIVATIVE_REBUILD_COMPONENTS.length ||
      components.some(
        (component, componentIndex) => component !== DERIVATIVE_REBUILD_COMPONENTS[componentIndex],
      ))
  ) {
    throw new CliError(
      `Derivative rebuild action ${index} requires components in exact order: ${DERIVATIVE_REBUILD_COMPONENTS.join(', ')}.`,
      {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_COMPONENTS_INVALID',
        exitCode: 2,
      },
    );
  }
  if (!derivativeAction && 'components' in value) {
    throw new CliError(`Maintenance non-derivative action ${index} cannot include components.`, {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_COMPONENTS_INVALID',
      exitCode: 2,
    });
  }
  const exchangeKeys = new Set(
    exchangeInstances.map(
      (entry) => `${entry.exchange_index}\u0000${entry.data_set_internal_id}\u0000${entry.flow_id}`,
    ),
  );
  if (exchangeKeys.size !== exchangeInstances.length) {
    throw new CliError(`Alias action ${index} contains duplicate exchange instances.`, {
      code: 'DATASET_MAINTENANCE_ALIAS_EXCHANGE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const expectedBeforeSha256 = token(value.expected_before_sha256);
  if (expectedBeforeSha256 && !/^[a-f0-9]{64}$/u.test(expectedBeforeSha256)) {
    throw new CliError(`Maintenance action ${index} expected_before_sha256 is invalid.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }

  return {
    action_id: requireToken(value.action_id, `actions[${index}].action_id`),
    action: action as DatasetMaintenanceActionKind,
    table: table as DatasetMaintenanceActionTable,
    id: requireToken(value.id, `actions[${index}].id`),
    version: requireToken(value.version, `actions[${index}].version`),
    expected_user_id: expectedUserId,
    expected_state_code: 0,
    reason_code: requireToken(value.reason_code, `actions[${index}].reason_code`),
    reason: requireToken(value.reason, `actions[${index}].reason`),
    evidence: value.evidence,
    ...(batchId ? { batch_id: batchId } : {}),
    ...(exchangeInstances.length ? { exchange_instances: exchangeInstances } : {}),
    ...(desiredPayloadPath ? { desired_payload_path: desiredPayloadPath } : {}),
    ...(expectedBeforeSha256 ? { expected_before_sha256: expectedBeforeSha256 } : {}),
    ...(derivativeAction ? { components: [...DERIVATIVE_REBUILD_COMPONENTS] } : {}),
  };
}

export function parseMaintenanceScope(
  value: unknown,
  expectedOperation?: DatasetMaintenanceOperation,
): DatasetMaintenanceScope {
  if (!isJsonObject(value) || value.schema_version !== 1 || !isJsonObject(value.account)) {
    throw new CliError('Maintenance scope must use schema_version=1 and include account.', {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const operation = requireToken(value.operation, 'operation');
  if (
    ![
      'delete',
      'retire',
      'redo-import',
      'repair-references',
      'merge-support-aliases',
      'rebuild-derivatives',
    ].includes(operation)
  ) {
    throw new CliError(`Unsupported maintenance operation: ${operation}`, {
      code: 'DATASET_MAINTENANCE_OPERATION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  if (expectedOperation && operation !== expectedOperation) {
    throw new CliError(
      `Scope operation ${operation} does not match requested operation ${expectedOperation}.`,
      {
        code: 'DATASET_MAINTENANCE_OPERATION_MISMATCH',
        exitCode: 2,
      },
    );
  }
  const userId = requireToken(value.account.user_id, 'account.user_id');
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new CliError('Maintenance scope actions must be a non-empty array.', {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
    });
  }
  const actions = value.actions.map((entry, index) =>
    parseAction(entry, index, userId, operation as DatasetMaintenanceOperation),
  );
  const targetMode = token(value.target_mode);
  if (
    (['merge-support-aliases', 'rebuild-derivatives'].includes(operation) &&
      targetMode !== 'owner_draft') ||
    (!['merge-support-aliases', 'rebuild-derivatives'].includes(operation) && targetMode !== null)
  ) {
    throw new CliError(
      'merge-support-aliases and rebuild-derivatives require target_mode=owner_draft; other operations forbid target_mode.',
      {
        code: 'DATASET_MAINTENANCE_TARGET_MODE_INVALID',
        exitCode: 2,
        details: { operation, target_mode: targetMode },
      },
    );
  }
  const aliasBatches = Array.isArray(value.alias_batches)
    ? value.alias_batches.map(parseAliasBatch)
    : [];
  if (
    (operation === 'merge-support-aliases' && aliasBatches.length !== 2) ||
    (operation !== 'merge-support-aliases' && aliasBatches.length !== 0)
  ) {
    throw new CliError(
      'merge-support-aliases requires exactly two alias_batches; other operations forbid them.',
      {
        code: 'DATASET_MAINTENANCE_ALIAS_BATCH_SCOPE_INVALID',
        exitCode: 2,
      },
    );
  }
  if (operation === 'rebuild-derivatives' && actions.length !== 1) {
    throw new CliError('rebuild-derivatives requires exactly one action.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_ACTION_COUNT_INVALID',
      exitCode: 2,
    });
  }
  if (aliasBatches.length) {
    const batchIds = new Set(aliasBatches.map((batch) => batch.batch_id));
    const dimensions = new Set(aliasBatches.map((batch) => batch.dimension));
    if (
      batchIds.size !== 2 ||
      dimensions.size !== 2 ||
      !dimensions.has('time') ||
      !dimensions.has('length_time') ||
      actions.some((action) => !action.batch_id || !batchIds.has(action.batch_id))
    ) {
      throw new CliError(
        'Alias batches and action batch_id bindings are incomplete or duplicate.',
        {
          code: 'DATASET_MAINTENANCE_ALIAS_BATCH_SCOPE_INVALID',
          exitCode: 2,
        },
      );
    }
  }
  const actionIds = new Set<string>();
  const rowKeys = new Set<string>();
  const payloadNames = new Set<string>();
  for (const action of actions) {
    if (actionIds.has(action.action_id)) {
      throw new CliError(`Duplicate maintenance action_id: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_ACTION_ID_DUPLICATE',
        exitCode: 2,
      });
    }
    actionIds.add(action.action_id);
    const rowKey = maintenanceRowKey(action);
    if (rowKeys.has(rowKey)) {
      throw new CliError(`Multiple maintenance actions target the same row: ${action.id}`, {
        code: 'DATASET_MAINTENANCE_TARGET_DUPLICATE',
        exitCode: 2,
      });
    }
    rowKeys.add(rowKey);
    const payloadName = safeActionFileName(action.action_id);
    if (payloadNames.has(payloadName)) {
      throw new CliError(`Maintenance action ids collide as payload filenames: ${payloadName}`, {
        code: 'DATASET_MAINTENANCE_ACTION_FILENAME_COLLISION',
        exitCode: 2,
      });
    }
    payloadNames.add(payloadName);
  }
  const email = token(value.account.email);
  const sourceImportRunId = token(value.source_import_run_id);
  return {
    schema_version: 1,
    task_id: requireToken(value.task_id, 'task_id'),
    operation: operation as DatasetMaintenanceOperation,
    account: {
      user_id: userId,
      ...(email ? { email } : {}),
    },
    ...(sourceImportRunId ? { source_import_run_id: sourceImportRunId } : {}),
    ...('source_lineage' in value ? { source_lineage: value.source_lineage } : {}),
    ...(targetMode === 'owner_draft' ? { target_mode: targetMode } : {}),
    ...(aliasBatches.length ? { alias_batches: aliasBatches } : {}),
    actions,
  };
}
