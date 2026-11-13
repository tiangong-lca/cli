import type { JsonObject } from '../application/dataset-types.js';
import type { FetchLike } from '../lib/transport/http.js';
import { annualProjectionRequired } from '../lib/validation/process-annual-projection.js';
import { resolveProcessReferenceUnit } from '../lib/validation/process-reference-unit.js';
import { sha256Json } from '../lib/platform/canonical-json-hash.js';
import { CommandInputError } from '../shared/command-result.js';
import { datasetReader } from './dataset-read.js';

/** Fresh RLS-scoped exact reads. Local declarations never stand in for remote unit evidence. */
export async function processAnnualEvidence(
  content: JsonObject,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  supplied: JsonObject[] = [],
): Promise<JsonObject[]> {
  if (!annualProjectionRequired(content)) return supplied;
  const read = datasetReader(env, fetchImpl);
  const documents: JsonObject[] = [];
  // The chain contains exactly Flow -> FlowProperty -> UnitGroup; it never follows arbitrary references.
  for (let step = 0; step < 3; step++) {
    const unit = resolveProcessReferenceUnit(content, documents);
    if (!unit.needed) break;
    const { type, id, version } = unit.needed;
    const page = await read(type, { id, version, limit: 2, offset: 0 });
    if (page.records.length !== 1 || page.total !== 1)
      throw new CommandInputError(
        'ANNUAL_REFERENCE_UNAVAILABLE',
        `Annual evidence needs one readable exact ${type} ${id}@${version}.`,
      );
    documents.push(page.records[0]!.content);
  }
  if (
    supplied.some(
      (document) => !documents.some((remote) => sha256Json(remote) === sha256Json(document)),
    )
  )
    throw new CommandInputError(
      'ANNUAL_REFERENCE_STALE',
      'Local annual evidence differs from current exact reference content. Refresh the reference documents.',
    );
  return documents;
}
