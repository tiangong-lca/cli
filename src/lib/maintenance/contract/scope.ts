import { CliError } from '../../../shared/errors.js';
import {
  MAINTENANCE_MUTABLE_TABLES,
  type DatasetMaintenanceActionTable,
  type DatasetMaintenanceOperation,
  type DatasetMaintenanceActionKind,
  DERIVATIVE_REBUILD_COMPONENTS,
  type DatasetMaintenanceScopeAction,
  type DatasetMaintenanceScope,
} from './types.js';
import { token, isJsonObject, maintenanceRowKey, requireToken } from './values.js';
import { safeActionFileName } from './files.js';

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
  if (!['save_draft', 'delete', 'rebuild_derivatives'].includes(action)) {
    throw new CliError(`Unsupported maintenance action: ${action}`, {
      code: 'DATASET_MAINTENANCE_ACTION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const derivativeAction = action === 'rebuild_derivatives';
  const allowedTable = derivativeAction
    ? table === 'processes'
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
  if ((operation === 'rebuild-derivatives') !== derivativeAction) {
    throw new CliError(`Maintenance operation ${operation} cannot contain ${action} actions.`, {
      code: 'DATASET_MAINTENANCE_OPERATION_UNSUPPORTED',
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
  if ('batch_id' in value || 'exchange_instances' in value || 'alias_mutation' in value) {
    throw new CliError('Specialized repair action fields are not supported.', {
      code: 'DATASET_MAINTENANCE_ACTION_UNSUPPORTED',
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
    !['delete', 'retire', 'redo-import', 'repair-references', 'rebuild-derivatives'].includes(
      operation,
    )
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
    (operation === 'rebuild-derivatives' && targetMode !== 'owner_draft') ||
    (operation !== 'rebuild-derivatives' && targetMode !== null)
  ) {
    throw new CliError(
      'rebuild-derivatives requires target_mode=owner_draft; other operations forbid target_mode.',
      {
        code: 'DATASET_MAINTENANCE_TARGET_MODE_INVALID',
        exitCode: 2,
        details: { operation, target_mode: targetMode },
      },
    );
  }
  if ('alias_batches' in value) {
    throw new CliError('Specialized repair batches are not supported.', {
      code: 'DATASET_MAINTENANCE_OPERATION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  if (operation === 'rebuild-derivatives' && actions.length !== 1) {
    throw new CliError('rebuild-derivatives requires exactly one action.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_ACTION_COUNT_INVALID',
      exitCode: 2,
    });
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
    actions,
  };
}
