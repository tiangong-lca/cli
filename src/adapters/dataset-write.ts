import { ServiceRejectedError, serviceRejection } from '../application/service-rejection.js';
import { HttpResponseError } from '../lib/transport/http.js';
import { CliError } from '../shared/errors.js';
import { commandFailure } from '../shared/command-errors.js';
import path from 'node:path';
import os from 'node:os';
import { executeDatasetWrite, type DatasetWritePorts } from '../application/dataset-write.js';
import { datasetKinds, datasetTables, type DatasetPorts } from '../application/dataset-types.js';
import { withMutationJournal } from './private-mutation-journal.js';
import { datasetIdentity } from '../lib/dataset/local.js';
import {
  resolveDatasetCommandTransport,
  createDatasetRecord,
  saveDraftDatasetRecord,
  deleteDatasetRecord,
} from '../lib/dataset/command.js';
import { fetchCurrentUser } from '../lib/auth/auth-identity-receipt.js';
import type { FetchLike } from '../lib/transport/http.js';
import { datasetReader } from './dataset-read.js';
import { qualifyDatasetWrite } from './dataset-write-checks.js';
import { writeModelDraft } from './model-write.js';
import { ProcessFlowNameAdmissionError } from '../lib/validation/process-flow-reference-names.js';

export function datasetWriter(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  stateDirectory = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'dataset-operations'),
  qualify: (
    ...args: Parameters<typeof qualifyDatasetWrite>
  ) => ReturnType<DatasetWritePorts['qualify']> = qualifyDatasetWrite,
): DatasetPorts['mutate'] {
  return async (type, action, request, dryRun) => {
    let transport: Awaited<ReturnType<typeof resolveDatasetCommandTransport>>;
    return executeDatasetWrite(type, action, request, dryRun, {
      identity: async () => {
        transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 10_000 });
        const environment = new URL(transport.functionsBaseUrl).origin;
        const actor = await fetchCurrentUser({
          projectBaseUrl: environment,
          publishableKey: transport.publishableKey,
          accessToken: transport.accessToken,
          timeoutMs: transport.timeoutMs,
          fetchImpl,
        });
        return { environment, actor };
      },
      contentIdentity: (content, selectedType) =>
        datasetIdentity({}, content, datasetKinds[selectedType]),
      read: datasetReader(env, fetchImpl),
      qualify: (selectedType, content) => qualify(selectedType, content, env, fetchImpl),
      failureData: (error) =>
        error instanceof ProcessFlowNameAdmissionError
          ? { validation: { flow_reference_names: error.report } }
          : {},
      describeFailure: (error) => {
        const failure = commandFailure(error, 'DATASET_WRITE_FAILED');
        const receipt = error instanceof ServiceRejectedError ? error.receipt : null;
        let message = error instanceof Error ? error.message : failure.message;
        const secrets = [
          transport.accessToken,
          transport.publishableKey,
          ...Object.entries(env)
            .filter(([key]) => /token|key|secret|cookie|password|authorization/iu.test(key))
            .map(([, value]) => value)
            .filter((value): value is string => Boolean(value && value.length >= 6)),
        ];
        for (const secret of secrets) {
          if (secret) message = message.split(secret).join('[REDACTED]');
        }
        message = message
          .replace(/\b(?:bearer|basic)\s+[^\s,;"']+/giu, '[REDACTED]')
          .replace(
            /["']?\b(?:authorization|proxy-authorization|(?:set-)?cookie|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)["']?\s*[:=]\s*[^\r\n]*/giu,
            '[REDACTED]',
          );
        return {
          category: receipt?.category ?? failure.category,
          code:
            receipt?.code ??
            (/^[A-Z0-9_]{1,128}$/u.test(failure.code) ? failure.code : 'DATASET_WRITE_FAILED'),
          ...(error instanceof HttpResponseError ? { httpStatus: error.status } : {}),
          message,
        };
      },
      withJournal: (requestId, target, execute) =>
        withMutationJournal(
          { directory: stateDirectory, requestId, target, scope: 'dataset' },
          execute,
        ),
      dispatch: async ({
        type: selectedType,
        action: intent,
        id,
        version,
        content,
        expected,
        previousGraph,
        beforeDispatch,
      }) => {
        try {
          return await (intent === 'delete'
            ? deleteDatasetRecord({
                transport,
                table: datasetTables[selectedType],
                id,
                version,
                beforeDispatch,
              })
            : selectedType === 'model'
              ? writeModelDraft(
                  transport,
                  id,
                  version,
                  content,
                  beforeDispatch,
                  intent,
                  previousGraph,
                )
              : intent === 'create'
                ? createDatasetRecord({
                    transport,
                    table: datasetTables[selectedType],
                    id,
                    payload: content,
                    beforeDispatch,
                  })
                : saveDraftDatasetRecord({
                    transport,
                    table: datasetTables[selectedType],
                    id,
                    version,
                    payload: content,
                    expectedJsonOrdered: expected!,
                    beforeDispatch,
                  }));
        } catch (error) {
          const receipt =
            error instanceof HttpResponseError
              ? serviceRejection(error.payload, error.status)
              : error instanceof CliError
                ? serviceRejection(error.details)
                : null;
          if (receipt) throw new ServiceRejectedError(receipt);
          throw error;
        }
      },
    });
  };
}
