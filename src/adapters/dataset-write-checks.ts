import {
  assertProcessFlowNameWriteAdmission,
  distinctReferenceDocuments,
  flowNameReadContext,
} from '../lib/validation/process-flow-reference-names.js';
import { processAnnualEvidence } from './process-annual-evidence.js';
import { isObject, type DatasetType, type JsonObject } from '../application/dataset-types.js';
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
    type === 'process'
      ? distinctReferenceDocuments([
          ...(await processAnnualEvidence(content, env, fetchImpl)),
          ...(
            await assertProcessFlowNameWriteAdmission(
              [content],
              flowNameReadContext(env, fetchImpl),
            )
          )
            .map(({ document }) => document)
            .filter(isObject),
        ])
      : undefined;
  const validation = await datasetValidation(type, content, ['schema', 'business'], evidence);
  if (validation.status !== 'passed')
    throw new CommandInputError(
      'VALIDATION_REQUIRED',
      'Candidate content has failed or incomplete local checks. Run validate and resolve findings before writing.',
    );
  const references = await checkDatasetReferences(content, env, fetchImpl);
  if (references.status !== 'passed_remote_verification')
    throw Object.assign(
      new CommandInputError(
        'REFERENCE_CHECK_FAILED',
        'Candidate reference admission failed; no mutation was dispatched.',
      ),
      { details: { references: references.blockers } },
    );
  return references.warnings;
}
