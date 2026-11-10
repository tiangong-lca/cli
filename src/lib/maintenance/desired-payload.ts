import { CliError } from '../../shared/errors.js';
import { isJsonObject } from './contract/values.js';
import { readJsonFile, resolveMaintenancePlanArtifactPath } from './contract/files.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import type { DatasetMaintenancePlanAction, JsonObject } from './contract/types.js';
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
