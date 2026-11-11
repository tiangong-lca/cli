import { collectRemoteReferences } from '../dataset/remote-verify.js';
import type { JsonObject } from './contract/types.js';

export function maintenancePayloadIdentity(payload: JsonObject): {
  id: string | null;
  version: string | null;
} {
  const root = collectRemoteReferences([{ json_ordered: payload }]).find(
    (reference) => reference.role === 'root',
  );
  return { id: root?.id ?? null, version: root?.version ?? null };
}
