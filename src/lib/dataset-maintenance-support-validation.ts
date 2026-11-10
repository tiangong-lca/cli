import { FlowPropertySchema, UnitGroupSchema } from '@tiangong-lca/tidas-sdk';
import { collectRemoteReferences } from './dataset-remote-verify.js';
import {
  type DatasetMaintenanceSupportTable,
  type JsonObject,
} from './maintenance/contract/types.js';
import type { SafeParseResult, SafeParseSchema } from './tidas-sdk-validation.js';

export type DatasetMaintenanceSupportSchemas = Partial<
  Record<DatasetMaintenanceSupportTable, SafeParseSchema>
>;

const DEFAULT_SUPPORT_SCHEMAS: Record<DatasetMaintenanceSupportTable, SafeParseSchema> = {
  unitgroups: UnitGroupSchema as unknown as SafeParseSchema,
  flowproperties: FlowPropertySchema as unknown as SafeParseSchema,
};

export function maintenancePayloadIdentity(payload: JsonObject): {
  id: string | null;
  version: string | null;
} {
  const root = collectRemoteReferences([{ json_ordered: payload }]).find(
    (reference) => reference.role === 'root',
  );
  return { id: root?.id ?? null, version: root?.version ?? null };
}

export function inspectMaintenanceSupportPayload(options: {
  table: DatasetMaintenanceSupportTable;
  payload: JsonObject;
  schemas?: DatasetMaintenanceSupportSchemas;
}): {
  identity: { id: string | null; version: string | null };
  schemaResult: SafeParseResult;
} {
  const schema = options.schemas?.[options.table] ?? DEFAULT_SUPPORT_SCHEMAS[options.table];
  return {
    identity: maintenancePayloadIdentity(options.payload),
    schemaResult: schema.safeParse(options.payload),
  };
}
