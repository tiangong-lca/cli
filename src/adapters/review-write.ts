import os from 'node:os';
import path from 'node:path';
import { executeReviewWrite, type ReviewMutationAction } from '../application/review-write.js';
import { type JsonObject } from '../application/dataset-types.js';
import { resolveDatasetCommandTransport } from '../lib/dataset-command.js';
import { fetchCurrentUser } from '../lib/auth-identity-receipt.js';
import { buildSupabaseAuthHeaders } from '../lib/supabase-client.js';
import type { FetchLike } from '../lib/http.js';
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
      dispatch: async (intent, body) => {
        const response = await fetchImpl(`${transport.functionsBaseUrl}/${endpoints[intent]}`, {
          method: 'POST',
          headers: {
            ...buildSupabaseAuthHeaders(transport.publishableKey, transport.accessToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return { ok: response.ok, payload: JSON.parse(await response.text()) as unknown };
      },
    });
  };
}
