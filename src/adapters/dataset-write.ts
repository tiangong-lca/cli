import path from 'node:path';
import os from 'node:os';
import { executeDatasetWrite } from '../application/dataset-write.js';
import { datasetKinds, datasetTables, type DatasetPorts } from '../application/dataset-types.js';
import { withMutationJournal } from './private-mutation-journal.js';
import { datasetIdentity } from '../lib/dataset-local.js';
import {
  resolveDatasetCommandTransport,
  createDatasetRecord,
  saveDraftDatasetRecord,
  deleteDatasetRecord,
} from '../lib/dataset-command.js';
import { fetchCurrentUser } from '../lib/auth-identity-receipt.js';
import type { FetchLike } from '../lib/http.js';
import { datasetReader } from './dataset-read.js';
import { qualifyDatasetWrite } from './dataset-write-checks.js';
import { writeModelDraft } from './model-write.js';

export function datasetWriter(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  stateDirectory = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'dataset-operations'),
  qualify: typeof qualifyDatasetWrite = qualifyDatasetWrite,
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
      }) =>
        intent === 'delete'
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
                }),
    });
  };
}
