import os from 'node:os';
import path from 'node:path';
import { executeReviewWrite, type ReviewMutationAction } from '../application/review-write.js';
import { type JsonObject } from '../application/dataset-types.js';
import { resolveDatasetCommandTransport } from '../lib/dataset/command.js';
import { fetchCurrentUser } from '../lib/auth/auth-identity-receipt.js';
import {
  buildSupabaseAuthHeaders,
  createSupabaseDataClient,
} from '../lib/transport/supabase-client.js';
import type { FetchLike } from '../lib/transport/http.js';
import { reviewServiceDiagnostic } from '../application/review-service-diagnostic.js';
import { datasetReader } from './dataset-read.js';
import { reviewReader } from './review-read.js';
import { runMutationIntent } from './mutation-intent.js';

const endpoints = {
  submit: 'app_dataset_submit_review',
  resubmit: 'app_dataset_submit_review',
  comment: 'app_review_save_comment_draft',
  decide: 'app_review_batch_decision',
} satisfies Record<ReviewMutationAction, string>;

export function reviewWriter(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  directory = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'review-operations'),
) {
  return async (action: ReviewMutationAction, request: JsonObject, dryRun: boolean) => {
    let transport: Awaited<ReturnType<typeof resolveDatasetCommandTransport>>;
    return executeReviewWrite(action, request, dryRun, {
      identity: async () => {
        transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 10_000 });
        const environment = new URL(transport.functionsBaseUrl).origin;
        const actor = await fetchCurrentUser({
          projectBaseUrl: environment,
          publishableKey: transport.publishableKey,
          accessToken: transport.accessToken,
          timeoutMs: 10_000,
          fetchImpl,
        });
        return { environment, actor };
      },
      readReview: reviewReader(env, fetchImpl),
      readDataset: datasetReader(env, fetchImpl),
      endpoint: (action) => endpoints[action],
      executeIntent: (options) => runMutationIntent({ directory, ...options }),
      previewSubmissionScope: async ({ table, id, version }) => {
        const { client } = createSupabaseDataClient(
          {
            apiBaseUrl: transport.functionsBaseUrl,
            publishableKey: transport.publishableKey,
            getAccessToken: async () => transport.accessToken,
          },
          fetchImpl,
          10_000,
        );
        const { data, error, status } = await client.schema('api').rpc('qry_review_submit_scope', {
          p_target_table: table,
          p_target_id: id,
          p_target_version: version,
        });
        if (error) {
          const { message, ...diagnostic } = reviewServiceDiagnostic(error, status);
          return {
            ok: false,
            status,
            payload: {
              ok: false,
              code: diagnostic.serviceCode ?? 'REVIEW_SCOPE_PREVIEW_FAILED',
              status,
              ...(message ? { message } : {}),
            },
          };
        }
        return { ok: true, payload: data, status };
      },
      recoverSubmission: async ({ table, id, version }, operationKey) => {
        const { client } = createSupabaseDataClient(
          {
            apiBaseUrl: transport.functionsBaseUrl,
            publishableKey: transport.publishableKey,
            getAccessToken: async () => transport.accessToken,
          },
          fetchImpl,
          10_000,
        );
        const { data: receipt, error } = await client.schema('api').rpc(
          'qry_review_submit_receipt',
          {
            p_operation_key: operationKey,
            p_target_table: table,
            p_target_id: id,
            p_target_version: version,
          },
          { get: true },
        );
        if (error) return null;
        return typeof receipt === 'string' &&
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(receipt)
          ? receipt
          : null;
      },
      dispatch: async (intent, body, operationKey) => {
        const response = await fetchImpl(`${transport.functionsBaseUrl}/${endpoints[intent]}`, {
          method: 'POST',
          headers: {
            ...buildSupabaseAuthHeaders(transport.publishableKey, transport.accessToken),
            'Content-Type': 'application/json',
            ...(operationKey ? { 'X-Review-Operation-Key': operationKey } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        let payload: unknown = null;
        try {
          payload = JSON.parse(await response.text()) as unknown;
        } catch {
          // An unreadable acknowledgement still has an observed HTTP status.
        }
        return {
          status: response.status,
          ok: response.ok,
          payload,
        };
      },
    });
  };
}
