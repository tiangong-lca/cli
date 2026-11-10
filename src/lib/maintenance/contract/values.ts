import { sha256Json } from '../../platform/canonical-json-hash.js';
import { CliError } from '../../../shared/errors.js';
import type {
  JsonObject,
  DatasetMaintenanceScanTable,
  DatasetMaintenanceRemoteRow,
  DatasetMaintenanceRowSnapshot,
} from './types.js';

export function token(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function snapshotRemoteRow(row: DatasetMaintenanceRemoteRow): DatasetMaintenanceRowSnapshot {
  return {
    ...row,
    row_sha256: sha256Json(row),
    payload_sha256: row.json_ordered ? sha256Json(row.json_ordered) : null,
  };
}

export function maintenanceRowKey(row: {
  table: DatasetMaintenanceScanTable;
  id: string;
  version: string;
}): string {
  return `${row.table}\u0000${row.id}\u0000${row.version}`;
}

export function requireToken(value: unknown, label: string): string {
  const normalized = token(value);
  if (!normalized) {
    throw new CliError(`Maintenance scope ${label} must be a non-empty string.`, {
      code: 'DATASET_MAINTENANCE_SCOPE_INVALID',
      exitCode: 2,
      details: { field: label },
    });
  }
  return normalized;
}
