import { buildDoctorReport, hasProductionProfileMismatch, readRuntimeEnv } from '../lib/env.js';
import { describeCliRuntime } from '../runtime.js';
import {
  requireSupabaseRestRuntime,
  deriveSupabaseProjectBaseUrl,
} from '../lib/supabase-client.js';
import type { FetchLike } from '../lib/http.js';
import type { DotEnvLoadResult } from '../lib/dotenv.js';

export function doctorPorts(
  env: NodeJS.ProcessEnv,
  dotEnv: DotEnvLoadResult,
  fetchImpl: FetchLike,
) {
  return {
    local: () => ({
      report: buildDoctorReport(env, dotEnv),
      conflicts: hasProductionProfileMismatch(env) ? ['production_profile_mismatch'] : [],
      target: readRuntimeEnv(env).apiBaseUrl,
    }),
    runtime: describeCliRuntime,
    online: async (timeoutMs: number) => {
      const runtime = requireSupabaseRestRuntime(env);
      const environment = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
      const endpoint = `${environment}/auth/v1/health`;
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers: { apikey: runtime.publishableKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.body) await response.body.cancel().catch(() => {});
      return {
        environment,
        endpoint,
        httpStatus: response.status,
        passed: response.status === 200,
        scope: 'supabase_auth_health',
      };
    },
  };
}
