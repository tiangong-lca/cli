import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
} from '../lib/transport/supabase-client.js';
import { createSupabaseDataRuntime } from '../lib/auth/supabase-session.js';
import { fetchCurrentUser } from '../lib/auth/auth-identity-receipt.js';
import type { FetchLike } from '../lib/transport/http.js';
import { opinionReview } from '../application/review-opinions.js';
import { sha256Json } from '../lib/platform/canonical-json-hash.js';
import {
  datasetTables,
  isObject,
  type JsonObject,
  type ReviewRead,
} from '../application/dataset-types.js';
import {
  isReviewOAuthRouteDenial,
  ReviewReadServiceError,
  reviewServiceDiagnostic,
} from '../application/review-service-diagnostic.js';

function checkService(response: { error: unknown; status: number }) {
  if (response.error) {
    const { message, ...diagnostic } = reviewServiceDiagnostic(response.error, response.status);
    throw new ReviewReadServiceError({
      code: 'REVIEW_READ_FAILED',
      ...diagnostic,
      category: isReviewOAuthRouteDenial(message)
        ? 'authorization'
        : response.status === 401
          ? 'authentication'
          : 'service',
      message:
        message ??
        (response.status === 0
          ? 'Review read failed before receiving an HTTP response.'
          : 'Review read failed at the service.'),
    });
  }
}

function invalidResponse(status: number): never {
  throw new ReviewReadServiceError({
    code: 'REVIEW_READ_INVALID_RESPONSE',
    category: 'service',
    message: 'Review read returned an invalid response.',
    httpStatus: status,
  });
}

export function reviewReader(env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  return async (input: Parameters<ReviewRead>[0]) => {
    const runtime = createSupabaseDataRuntime({
      runtime: requireSupabaseRestRuntime(env),
      fetchImpl,
      timeoutMs: 10_000,
    });
    const { client, restBaseUrl } = createSupabaseDataClient(runtime, fetchImpl, 10_000);
    const environment = new URL(restBaseUrl).origin;
    const actor = await fetchCurrentUser({
      projectBaseUrl: environment,
      accessToken: await runtime.getAccessToken(),
      publishableKey: runtime.publishableKey,
      timeoutMs: 10_000,
      fetchImpl,
    });
    let query = client.schema('api').rpc(
      'qry_review_get_items',
      {
        p_review_ids: input.id ? [input.id] : null,
        p_data_id: input.target?.id ?? null,
        p_data_version: input.target?.version ?? null,
        p_state_codes: input.state === undefined ? null : [input.state],
      },
      { count: 'exact' },
    );
    if (input.role === 'submitter') query = query.eq('json->user->>id', actor.userId);
    if (input.role === 'reviewer')
      query = query.contains('reviewer_id', JSON.stringify([actor.userId]));
    if (input.role === 'review-admin') query = query.eq('opinion_scope', 'admin');
    if (input.target) query = query.eq('target_table', datasetTables[input.target.type]);
    const response = await query.order('id').range(input.offset, input.offset + input.limit - 1);
    checkService(response);
    if (
      !Array.isArray(response.data) ||
      response.data.some(
        (row) => !isObject(row) || typeof row.id !== 'string' || (input.id && row.id !== input.id),
      )
    )
      invalidResponse(response.status);
    const records: JsonObject[] = [];
    for (const row of response.data) {
      const facts = input.target || input.opinions ? opinionReview(row) : null;
      if (
        input.target &&
        (facts?.target.type !== input.target.type ||
          facts.target.data_id !== input.target.id ||
          facts.target.data_version !== input.target.version)
      )
        invalidResponse(response.status);
      if (!input.opinions) {
        records.push(row);
        continue;
      }
      if (!facts) invalidResponse(response.status);
      const comments: JsonObject[] = [];
      let total: number;
      do {
        const page = await client
          .schema('api')
          .rpc(
            'qry_review_get_comment_items',
            {
              p_review_id: facts.review_id,
              p_scope: facts.opinion_scope === 'returned' ? 'returned' : 'opinions',
            },
            { get: true, count: 'exact' },
          )
          .range(comments.length, comments.length + 99);
        checkService(page);
        if (
          !Array.isArray(page.data) ||
          typeof page.count !== 'number' ||
          !Number.isSafeInteger(page.count) ||
          comments.length + page.data.length > page.count ||
          (!page.data.length && comments.length < page.count)
        )
          invalidResponse(page.status);
        for (const opinion of page.data) {
          if (
            !isObject(opinion) ||
            opinion.review_id !== facts.review_id ||
            !Number.isInteger(opinion.state_code) ||
            !isObject(opinion.json) ||
            (facts.opinion_scope === 'returned'
              ? opinion.reviewer_id !== null ||
                opinion.state_code !== -1 ||
                facts.state_code !== -1 ||
                facts.target.type !== 'process'
              : typeof opinion.reviewer_id !== 'string' ||
                (facts.opinion_scope === 'reviewer' && opinion.reviewer_id !== actor.userId))
          )
            invalidResponse(page.status);
          comments.push({
            review_id: facts.review_id,
            reviewer_id: opinion.reviewer_id,
            state_code: opinion.state_code,
            json: opinion.json,
            json_digest: sha256Json(opinion.json),
            created_at: opinion.created_at,
            modified_at: opinion.modified_at,
          });
        }
        total = page.count;
      } while (comments.length < total);
      records.push({ ...facts, comments });
    }
    return { records, total: response.count, environment, actor: actor.userId };
  };
}
