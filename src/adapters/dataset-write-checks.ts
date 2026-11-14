import { processAnnualEvidence } from './process-annual-evidence.js';
import type { DatasetType, JsonObject } from '../application/dataset-types.js';
import { datasetValidation } from './dataset-local.js';
import { checkDatasetReferences } from './dataset-references.js';
import { CommandInputError } from '../shared/command-result.js';
import type { FetchLike } from '../lib/transport/http.js';

export async function qualifyDatasetWrite(
  type: DatasetType,
  content: JsonObject,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  const evidence =
    type === 'process' ? await processAnnualEvidence(content, env, fetchImpl) : undefined;
  const validation = await datasetValidation(type, content, ['schema', 'business'], evidence);
  if (validation.status !== 'passed')
    throw new CommandInputError(
      'VALIDATION_REQUIRED',
      'Candidate content has failed or incomplete local checks. Run validate and resolve findings before writing.',
    );
  const references = await checkDatasetReferences(content, env, fetchImpl);
  if (references.status !== 'passed_remote_verification')
    throw new CommandInputError(
      'REFERENCE_CHECK_FAILED',
      'Candidate reference admission failed; no mutation was dispatched.',
    );
}
