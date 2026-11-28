import {
  bindCurrentFlowNameEvidence,
  distinctReferenceDocuments,
  flowNameReadContext,
  processFlowNameReport,
  readExactFlowNameEvidence,
  suppliedFlowNameEvidence,
} from '../lib/validation/process-flow-reference-names.js';
import { isObject } from '../application/dataset-types.js';
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
      const suppliedNames = suppliedFlowNameEvidence(referenceDocuments ?? []);
      const remoteFlowEvidence =
        type === 'process' && checks.includes('references')
          ? await readExactFlowNameEvidence(
              [content],
              flowNameReadContext(env, fetchImpl),
              suppliedNames,
            )
          : null;
      const observedFlowEvidence = remoteFlowEvidence ?? [];
      const flowReferenceNames =
        remoteFlowEvidence === null
          ? null
          : processFlowNameReport(
              content,
              bindCurrentFlowNameEvidence(remoteFlowEvidence, suppliedNames),
            );
      const evidence =
        type === 'process' && checks.includes('business') && checks.includes('references')
          ? await processAnnualEvidence(
              content,
              env,
              fetchImpl,
              referenceDocuments,
              observedFlowEvidence,
            )
          : referenceDocuments;
      const localChecks = checks.filter((check) => check !== 'references');
      const local = localChecks.length
        ? await datasetValidation(
            type,
            content,
            localChecks,
            remoteFlowEvidence === null
              ? evidence
              : distinctReferenceDocuments([
                  ...(evidence ?? []),
                  ...observedFlowEvidence.map(({ document }) => document).filter(isObject),
                ]),
          )
        : null;
      if (!checks.includes('references')) return local!;
      const references = await checkDatasetReferences(content, env, fetchImpl);
      return {
        status:
          references.status === 'blocked_remote_verification' ||
          local?.status === 'failed' ||
          flowReferenceNames?.status === 'failed'
            ? 'failed'
            : local?.status === 'incomplete' || flowReferenceNames?.status === 'unresolved'
              ? 'incomplete'
              : 'passed',
        checks,
        local,
        references,
        warnings: references.warnings,
        ...(flowReferenceNames ? { flow_reference_names: flowReferenceNames } : {}),
        notChecked: [
          ...(local
            ? (local.notChecked as string[]).filter(
                (check) =>
                  !['remote_references', 'process_exchange_flow_reference_names'].includes(check),
              )
            : ['schema', 'business']),
          ...(flowReferenceNames?.status === 'unresolved'
            ? ['process_exchange_flow_reference_names']
            : []),
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
