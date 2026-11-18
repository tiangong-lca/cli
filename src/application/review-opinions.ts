import {
  datasetTables,
  editableTypes,
  isObject,
  type DatasetType,
  type JsonObject,
} from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export type ReviewTarget = { type: DatasetType; id: string; version: string };
export const reviewUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const exactVersion = /^\d{2}\.\d{2}\.\d{3}$/u;

export function exactReviewTarget(type: unknown, id: unknown, version: unknown): ReviewTarget {
  const kind = editableTypes.find((candidate) => candidate === type);
  if (
    !kind ||
    typeof id !== 'string' ||
    !reviewUuid.test(id) ||
    typeof version !== 'string' ||
    !exactVersion.test(version)
  )
    throw new CommandInputError(
      'IDENTITY_INVALID',
      'Provide --type flow|process|model|source|contact, --data-id UUID and --data-version 00.00.000 together.',
    );
  return { type: kind, id: id.toLowerCase(), version };
}

export function opinionReview(row: JsonObject) {
  const json = isObject(row.json) ? row.json : {};
  const data = isObject(json.data) ? json.data : {};
  const table = row.target_table;
  const id = row.data_id ?? data.id;
  const version = row.data_version ?? data.version;
  const scope = row.opinion_scope;
  const checksum = row.submitted_revision_checksum;
  if (
    typeof row.id !== 'string' ||
    !reviewUuid.test(row.id) ||
    typeof table !== 'string' ||
    typeof id !== 'string' ||
    !reviewUuid.test(id) ||
    typeof version !== 'string' ||
    !exactVersion.test(version) ||
    !Number.isInteger(row.state_code) ||
    (checksum !== null && !(typeof checksum === 'string' && /^[a-f0-9]{64}$/u.test(checksum))) ||
    (scope !== 'admin' && scope !== 'reviewer' && scope !== 'returned')
  )
    return null;
  const type = Object.keys(datasetTables).find(
    (key) => datasetTables[key as DatasetType] === table,
  );
  if (!type) return null;
  return {
    review_id: row.id,
    target: { type, table, data_id: id, data_version: version },
    submitted_revision_checksum: checksum,
    state_code: row.state_code,
    opinion_scope: scope,
    rejection_message:
      row.state_code === -1 && isObject(json.comment) && typeof json.comment.message === 'string'
        ? json.comment.message
        : null,
  };
}
