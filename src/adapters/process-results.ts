import {
  readProcessResults,
  ResultReadChanged,
  resultProblem,
} from '../application/process-results.js';
import { isObject, type JsonObject } from '../application/dataset-types.js';
import {
  requireSupabaseRestRuntime,
  deriveSupabaseFunctionsBaseUrl,
  buildSupabaseAuthHeaders,
} from '../lib/transport/supabase-client.js';
import { resolveSupabaseUserSession } from '../lib/auth/supabase-session.js';
import { postJson, HttpResponseError, type FetchLike } from '../lib/transport/http.js';

export async function processResults(
  request: JsonObject,
  list: boolean,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): Promise<JsonObject> {
  const runtime = requireSupabaseRestRuntime(env);
  const session = await resolveSupabaseUserSession({ runtime, fetchImpl, timeoutMs: 10000 });
  const value = await readProcessResults(request, list, async (body) => {
    let response: unknown;
    try {
      response = await postJson({
        url: `${deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl)}/lca_release_results`,
        headers: buildSupabaseAuthHeaders(runtime.publishableKey, session.accessToken),
        body,
        timeoutMs: 15000,
        fetchImpl,
      });
    } catch (error) {
      if (error instanceof HttpResponseError) {
        const payload = isObject(error.payload) ? error.payload : {};
        const detail = isObject(payload.error) ? payload.error : payload;
        if (
          error.status === 409 &&
          ['PUBLICATION_CHANGED', 'RESULT_RUNTIME_CHANGED'].includes(String(detail.code))
        )
          throw new ResultReadChanged();
        if (error.status === 404)
          return resultProblem(
            'PROCESS_RESULT_UNAVAILABLE',
            'The selected Process or published result is not available to this account.',
          );
      }
      throw error;
    }
    if (!isObject(response) || response.ok !== true || !isObject(response.data))
      return resultProblem(
        'RESULT_RESPONSE_INVALID',
        'The result service did not return a complete result.',
      );
    return response.data;
  });
  return { ...value, environment: session.projectBaseUrl };
}
