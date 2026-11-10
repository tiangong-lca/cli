import { datasetKinds, isObject, type DatasetPorts } from '../application/dataset-types.js';
import {
  requireSupabaseRestRuntime,
  deriveSupabaseFunctionsBaseUrl,
  buildSupabaseAuthHeaders,
} from '../lib/supabase-client.js';
import { resolveSupabaseUserSession } from '../lib/supabase-session.js';
import { postJson, type FetchLike } from '../lib/http.js';
import { CliError } from '../shared/errors.js';

export function datasetSearcher(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): DatasetPorts['search'] {
  return async (type, query, limit, offset, state) => {
    const runtime = requireSupabaseRestRuntime(env);
    const session = await resolveSupabaseUserSession({ runtime, fetchImpl, timeoutMs: 10_000 });
    const response = await postJson({
      url: `${deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl)}/${datasetKinds[type]}_hybrid_search`,
      headers: buildSupabaseAuthHeaders(runtime.publishableKey, session.accessToken),
      body: {
        query,
        page_size: limit,
        page_current: offset / limit + 1,
        match_count: 100,
        data_source: 'my',
        ...(state === undefined ? {} : { state_code: state }),
      },
      timeoutMs: 30_000,
      fetchImpl,
    });
    const rows = Array.isArray(response) ? response : isObject(response) ? response.data : null;
    if (!Array.isArray(rows) || rows.length > limit)
      throw new CliError('Search response was invalid.', {
        code: 'SEARCH_RESPONSE_INVALID',
        exitCode: 1,
      });
    const candidates = rows.map((row: unknown) => {
      if (!isObject(row) || typeof row.id !== 'string' || typeof row.version !== 'string')
        throw new CliError('Search candidate identity was invalid.', {
          code: 'SEARCH_RESPONSE_INVALID',
          exitCode: 1,
        });
      return {
        type,
        id: row.id,
        version: row.version,
        score: row.combined_score ?? row.score ?? null,
        match: { source: 'domain_hybrid_search', semanticRoute: row.semantic_route ?? null },
        stateCode: row.state_code ?? null,
      };
    });
    // The service's bounded candidate population is not a reliable full-data cursor.
    return {
      candidates,
      environment: session.projectBaseUrl,
      scope: 'current_actor_latest_hybrid_candidates',
      hasMore: null,
      nextCursor: null,
      truncated: true,
      returned: candidates.length,
      total: null,
      candidateBudget: 100,
    };
  };
}
