import { CliError } from '../../shared/errors.js';
import { isJsonObject } from './contract/values.js';
import { readJsonFile, resolveMaintenancePlanArtifactPath } from './contract/files.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import { schemaForKind } from '../dataset/validate.js';
import type { DatasetKind } from '../dataset/local.js';
import {
  isDuplicateLanguageIssue,
  normalizeIssuePath,
  validateSchemaWithDeepFallback,
} from '../validation/tidas-sdk-validation.js';
import type {
  DatasetMaintenanceMutableTable,
  DatasetMaintenancePlanAction,
  JsonObject,
} from './contract/types.js';

const datasetKind: Record<DatasetMaintenanceMutableTable, DatasetKind> = {
  contacts: 'contact',
  sources: 'source',
  flows: 'flow',
  processes: 'process',
};

export function assertMaintenanceLocalizedTextAdmission(
  table: DatasetMaintenanceMutableTable,
  payload: JsonObject,
): void {
  const { schema, createEntity } = schemaForKind(datasetKind[table]);
  const outcome = validateSchemaWithDeepFallback(schema, structuredClone(payload), createEntity);
  const issues = outcome.issues.filter(isDuplicateLanguageIssue).map((issue) => ({
    code: issue.code,
    path: normalizeIssuePath(issue.path),
    message: issue.message,
  }));
  if (issues.length > 0) {
    throw new CliError(
      'Maintenance desired content contains repeated languages in a localized field.',
      {
        code: 'DATASET_MAINTENANCE_DUPLICATE_LANGUAGE_ENTRY',
        exitCode: 1,
        details: { table, issues },
      },
    );
  }
}
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
