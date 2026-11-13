import {
  datasetKinds,
  datasetWrappers,
  isObject,
  type DatasetPorts,
  type DatasetType,
} from '../application/dataset-types.js';
import {
  requireSupabaseRestRuntime,
  deriveSupabaseFunctionsBaseUrl,
  buildSupabaseAuthHeaders,
} from '../lib/transport/supabase-client.js';
import { resolveSupabaseUserSession } from '../lib/auth/supabase-session.js';
import { postJson, type FetchLike } from '../lib/transport/http.js';
import { CliError } from '../shared/errors.js';

const informationKeys = {
  flow: 'flowInformation',
  process: 'processInformation',
  model: 'lifeCycleModelInformation',
  source: 'sourceInformation',
  contact: 'contactInformation',
  flowproperty: 'flowPropertiesInformation',
  unitgroup: 'unitGroupInformation',
  lciamethod: 'LCIAMethodInformation',
} as const satisfies Record<DatasetType, string>;

export function datasetSearcher(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): DatasetPorts['search'] {
  return async (type, query, limit, offset, state, scope = 'current-user') => {
    const versioned = type === 'process' || type === 'flow';
    const runtime = requireSupabaseRestRuntime(env);
    const session = await resolveSupabaseUserSession({ runtime, fetchImpl, timeoutMs: 10_000 });
    const response = await postJson({
      url: `${deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl)}/${datasetKinds[type]}_hybrid_search`,
      headers: buildSupabaseAuthHeaders(runtime.publishableKey, session.accessToken),
      body: {
        query,
        page_size: limit,
        page_current: offset / limit + 1,
        match_count: versioned ? 200 : 100,
        ...(versioned ? { version_scope: 'matched' } : {}),
        data_source: scope === 'public' ? 'tg' : 'my',
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
      const content = isObject(row.json) ? row.json[datasetWrappers[type]] : null;
      const info = isObject(content) ? content[informationKeys[type]] : null;
      const identity =
        isObject(info) && isObject(info.dataSetInformation) ? info.dataSetInformation : {};
      return {
        type,
        id: row.id,
        version: row.version,
        name: identity.name ?? identity['common:shortName'] ?? null,
        score: row.combined_score ?? row.score ?? null,
        match: { source: 'domain_hybrid_search', semanticRoute: row.semantic_route ?? null },
        stateCode: row.state_code ?? null,
      };
    });
    // The service's bounded candidate population is not a reliable full-data cursor.
    return {
      candidates,
      environment: session.projectBaseUrl,
      scope,
      versionScope: versioned ? 'matched' : 'service_default',
      stateFilter: scope === 'public' ? 100 : (state ?? null),
      hasMore: null,
      nextCursor: null,
      truncated: true,
      returned: candidates.length,
      total: null,
      candidateBudget: versioned ? 200 : 100,
    };
  };
}
