import { createSupabaseDataClient, requireSupabaseRestRuntime } from '../lib/supabase-client.js';
import { createSupabaseDataRuntime } from '../lib/supabase-session.js';
import { fetchCurrentUser } from '../lib/auth-identity-receipt.js';
import type { FetchLike } from '../lib/http.js';
import { isObject } from '../application/dataset-types.js';
import { CliError } from '../lib/errors.js';

export function reviewReader(env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  return async (input: {
    id?: string;
    role?: 'submitter' | 'reviewer';
    state?: number;
    limit: number;
    offset: number;
  }) => {
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
        p_data_id: null,
        p_data_version: null,
        p_state_codes: input.state === undefined ? null : [input.state],
      },
      { count: 'exact' },
    );
    if (input.role === 'submitter') query = query.eq('json->user->>id', actor.userId);
    if (input.role === 'reviewer') query = query.contains('reviewer_id', [actor.userId]);
    const response = await query.order('id').range(input.offset, input.offset + input.limit - 1);
    if (
      response.error ||
      !Array.isArray(response.data) ||
      response.data.some(
        (row) => !isObject(row) || typeof row.id !== 'string' || (input.id && row.id !== input.id),
      )
    )
      throw new CliError('Review read failed or returned invalid identities.', {
        code: 'REVIEW_READ_FAILED',
        exitCode: 1,
      });
    return { records: response.data, total: response.count, environment, actor: actor.userId };
  };
}
