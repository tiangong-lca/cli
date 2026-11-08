import type { ProcessPorts } from '../application/process.js';
import type { FetchLike } from '../lib/http.js';
import {
  fetchExactOrLatestProcessRow,
  normalizeSupabaseProcessPayload,
  requireSupabaseRestRuntime,
} from '../lib/supabase-rest.js';
import { createSupabaseDataRuntime } from '../lib/supabase-session.js';
import { validateProcessPayload } from '../lib/process-payload-validation.js';
import { semanticContextFromInput } from '../lib/process-semantic-validation.js';

export function createProcessPorts(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): ProcessPorts {
  return {
    now: () => new Date().toISOString(),
    validate: (content) =>
      validateProcessPayload(content, undefined, undefined, semanticContextFromInput(content)),
    async get(id, version) {
      const configuration = requireSupabaseRestRuntime(env);
      const runtime = createSupabaseDataRuntime({
        runtime: configuration,
        fetchImpl,
        timeoutMs: 10_000,
      });
      const lookup = await fetchExactOrLatestProcessRow({
        runtime,
        id,
        version: version === 'latest' ? null : version,
        timeoutMs: 10_000,
        fetchImpl,
        fallbackToLatest: false,
      });
      if (!lookup) return null;
      return {
        id: lookup.row.id,
        version: lookup.row.version,
        modifiedAt: lookup.row.modified_at,
        stateCode: lookup.row.state_code,
        content: normalizeSupabaseProcessPayload(lookup.row.json, `${id}@${version}`),
        environment: new URL(lookup.sourceUrl).origin,
      };
    },
  };
}
