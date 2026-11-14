import { processAnnualEvidence } from './process-annual-evidence.js';
import type { DatasetPorts } from '../application/dataset-types.js';
import type { FetchLike } from '../lib/transport/http.js';
import { datasetReader } from './dataset-read.js';
import { datasetSearcher } from './dataset-search.js';
import { datasetContract, datasetValidation } from './dataset-local.js';
import { datasetOperations } from './dataset-operations.js';
import { datasetWriter } from './dataset-write.js';
import { checkDatasetReferences } from './dataset-references.js';

export function createDatasetPorts(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): DatasetPorts {
  return {
    read: datasetReader(env, fetchImpl),
    search: datasetSearcher(env, fetchImpl),
    contract: datasetContract,
    validate: async (type, content, checks, referenceDocuments) => {
      const evidence =
        type === 'process' && checks.includes('business') && checks.includes('references')
          ? await processAnnualEvidence(content, env, fetchImpl, referenceDocuments)
          : referenceDocuments;
      const localChecks = checks.filter((check) => check !== 'references');
      const local = localChecks.length
        ? await datasetValidation(type, content, localChecks, evidence)
        : null;
      if (!checks.includes('references')) return local!;
      const references = await checkDatasetReferences(content, env, fetchImpl);
      return {
        status:
          references.status === 'blocked_remote_verification' || local?.status === 'failed'
            ? 'failed'
            : local?.status === 'incomplete'
              ? 'incomplete'
              : 'passed',
        checks,
        local,
        references,
        notChecked: [
          ...(local
            ? (local.notChecked as string[]).filter((check) => check !== 'remote_references')
            : ['schema', 'business']),
          'scientific_reference_suitability',
          'cross_dataset_quantitative_consistency',
        ],
        scope: 'existing_exact_reference_admission_and_requested_local_checks',
      };
    },
    operations: datasetOperations(env, fetchImpl),
    mutate: datasetWriter(env, fetchImpl),
    now: () => new Date().toISOString(),
  };
}
