import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { CliError } from './errors.js';
import { hasProductionProfileMismatch, resolveProductionRuntimeEnv } from './env.js';
import type { FetchLike, ResponseLike } from './http.js';
import { DEFAULT_OAUTH_REDIRECT_URI, requireOAuthLoopbackRedirectUri } from './oauth-loopback.js';
import { requireOAuthClientId } from './oauth-pkce.js';
import { isDataApiAuthRefreshReplaySafe } from './supabase-data-api-replay.js';

export type SupabaseAuthMode = 'oauth' | 'access_token';

export type SupabaseRestRuntime = {
  apiBaseUrl: string;
  authMode: SupabaseAuthMode;
  oauthClientId: string | null;
  oauthRedirectUri: string | null;
  accessToken: string | null;
  publishableKey: string;
  sessionFile: string | null;
  disableSessionCache: boolean;
  forceReauth: boolean;
};

export type SupabaseDataRuntime = {
  apiBaseUrl: string;
  publishableKey: string;
  getAccessToken: () => Promise<string>;
  refreshAccessToken?: () => Promise<string>;
};

function trimToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBooleanEnv(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

function resolveSupabaseAuthMode(options: {
  configuredMode: string;
  oauthClientId: string;
  accessToken: string;
}): SupabaseAuthMode | null {
  const configuredMode = options.configuredMode.trim().toLowerCase();
  if (configuredMode) {
    switch (configuredMode) {
      case 'oauth':
        return 'oauth';
      case 'access-token':
        return 'access_token';
      default:
        throw new CliError('TIANGONG_LCA_AUTH_MODE must be oauth or access-token.', {
          code: 'SUPABASE_AUTH_MODE_INVALID',
          exitCode: 2,
        });
    }
  }

  if (options.accessToken) return 'access_token';
  if (options.oauthClientId) return 'oauth';
  return null;
}

export function requireSupabaseRestRuntime(
  configuredEnv: NodeJS.ProcessEnv,
  options: { allowProductionDefaults?: boolean } = {},
): SupabaseRestRuntime {
  if (hasProductionProfileMismatch(configuredEnv)) {
    throw new CliError(
      'Official Production OAuth configuration cannot be used with another API project.',
      {
        code: 'SUPABASE_RUNTIME_PROFILE_MISMATCH',
        exitCode: 2,
      },
    );
  }
  const env =
    options.allowProductionDefaults === false
      ? configuredEnv
      : resolveProductionRuntimeEnv(configuredEnv);
  const apiBaseUrl = trimToken(env.TIANGONG_LCA_API_BASE_URL);
  const oauthClientId = trimToken(env.TIANGONG_LCA_OAUTH_CLIENT_ID);
  const accessToken = trimToken(env.TIANGONG_LCA_ACCESS_TOKEN);
  const configuredAuthMode = trimToken(env.TIANGONG_LCA_AUTH_MODE);
  const publishableKey = trimToken(env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY);
  const sessionFile = trimToken(env.TIANGONG_LCA_SESSION_FILE) || null;
  const disableSessionCache = parseBooleanEnv(env.TIANGONG_LCA_DISABLE_SESSION_CACHE);
  const forceReauth = parseBooleanEnv(env.TIANGONG_LCA_FORCE_REAUTH);
  const missing: string[] = [];
  const authMode = resolveSupabaseAuthMode({
    configuredMode: configuredAuthMode,
    oauthClientId,
    accessToken,
  });

  if (!apiBaseUrl) {
    missing.push('TIANGONG_LCA_API_BASE_URL');
  }

  if (!authMode) {
    missing.push('TIANGONG_LCA_OAUTH_CLIENT_ID or TIANGONG_LCA_ACCESS_TOKEN');
  }

  if (!publishableKey) {
    missing.push('TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY');
  }

  if (missing.length > 0) {
    throw new CliError(`Missing Supabase REST runtime env: ${missing.join(', ')}`, {
      code: 'SUPABASE_REST_ENV_REQUIRED',
      exitCode: 2,
      details: { missing },
    });
  }
  const resolvedAuthMode = authMode as SupabaseAuthMode;

  if (resolvedAuthMode === 'oauth' && !oauthClientId) {
    throw new CliError('OAuth auth mode requires TIANGONG_LCA_OAUTH_CLIENT_ID.', {
      code: 'SUPABASE_OAUTH_CLIENT_ID_REQUIRED',
      exitCode: 2,
    });
  }
  if (resolvedAuthMode === 'access_token' && !accessToken) {
    throw new CliError('Access-token auth mode requires TIANGONG_LCA_ACCESS_TOKEN.', {
      code: 'SUPABASE_ACCESS_TOKEN_REQUIRED',
      exitCode: 2,
    });
  }
  const normalizedOAuthClientId =
    resolvedAuthMode === 'oauth' ? requireOAuthClientId(oauthClientId) : null;
  const normalizedOAuthRedirectUri =
    resolvedAuthMode === 'oauth'
      ? requireOAuthLoopbackRedirectUri(
          trimToken(env.TIANGONG_LCA_OAUTH_REDIRECT_URI) || DEFAULT_OAUTH_REDIRECT_URI,
        ).redirectUri
      : null;

  return {
    apiBaseUrl,
    authMode: resolvedAuthMode,
    oauthClientId: normalizedOAuthClientId,
    oauthRedirectUri: normalizedOAuthRedirectUri,
    accessToken: resolvedAuthMode === 'access_token' ? accessToken : null,
    publishableKey,
    sessionFile,
    disableSessionCache,
    forceReauth,
  };
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new CliError('Cannot derive Supabase URLs from an empty API base URL.', {
      code: 'SUPABASE_REST_BASE_URL_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

export function deriveSupabaseProjectBaseUrl(apiBaseUrl: string): string {
  const normalized = normalizeBaseUrl(apiBaseUrl);

  if (normalized.endsWith('/functions/v1')) {
    return normalized.replace(/\/functions\/v1$/u, '');
  }

  if (normalized.endsWith('/rest/v1')) {
    return normalized.replace(/\/rest\/v1$/u, '');
  }

  if (/^https?:\/\/[^/]+$/u.test(normalized)) {
    return normalized;
  }

  throw new CliError(
    'Cannot derive a Supabase project base URL from TIANGONG_LCA_API_BASE_URL. Use a Supabase project base URL, a /functions/v1 base URL, or a /rest/v1 base URL.',
    {
      code: 'SUPABASE_REST_BASE_URL_INVALID',
      exitCode: 2,
      details: normalized,
    },
  );
}

export function deriveSupabaseRestBaseUrl(apiBaseUrl: string): string {
  return `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/rest/v1`;
}

export const deriveSupabaseFunctionsBaseUrl = (apiBaseUrl: string): string =>
  `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/functions/v1`;

function mergeSignals(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function buildSupabaseAuthHeaders(
  publishableKey: string,
  accessToken: string,
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    apikey: publishableKey,
  };
}

async function toResponse(
  responseLike: ResponseLike,
  method: string | undefined,
): Promise<Response> {
  if (responseLike instanceof Response) {
    return responseLike;
  }

  const body = await responseLike.text();
  const contentType = responseLike.headers.get('content-type') ?? '';
  const normalizedBody =
    responseLike.ok &&
    method !== undefined &&
    !['GET', 'HEAD'].includes(method.toUpperCase()) &&
    body.length > 0 &&
    !contentType.includes('application/json')
      ? ''
      : body;
  const headers = new Headers();
  for (const headerName of ['content-type', 'content-range', 'location']) {
    const value = responseLike.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  return new Response(normalizedBody, {
    status: responseLike.status,
    headers,
  });
}

function buildResolvedHeaders(
  initHeaders: HeadersInit | undefined,
  publishableKey: string,
  accessToken: string,
): Headers {
  const headers = new Headers(initHeaders);
  const authHeaders = buildSupabaseAuthHeaders(publishableKey, accessToken);

  Object.entries(authHeaders).forEach(([headerName, value]) => {
    headers.set(headerName, value);
  });

  return headers;
}

async function performFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<ResponseLike> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  try {
    return await fetchImpl(url, {
      ...init,
      signal: mergeSignals(init?.signal, timeoutMs),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function createSupabaseFetch(
  fetchImpl: FetchLike,
  timeoutMs: number,
  runtime?: SupabaseDataRuntime,
): typeof fetch {
  return async (input, init) => {
    if (!runtime) {
      const responseLike = await performFetch(input, init, fetchImpl, timeoutMs);
      return toResponse(responseLike, init?.method);
    }

    const accessToken = await runtime.getAccessToken();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const replaySafe = isDataApiAuthRefreshReplaySafe({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      method,
    });
    let responseLike = await performFetch(
      input,
      {
        ...init,
        headers: buildResolvedHeaders(init?.headers, runtime.publishableKey, accessToken),
      },
      fetchImpl,
      timeoutMs,
    );

    if (
      replaySafe &&
      [401, 403].includes(responseLike.status) &&
      typeof runtime.refreshAccessToken === 'function'
    ) {
      const refreshedAccessToken = await runtime.refreshAccessToken();
      responseLike = await performFetch(
        input,
        {
          ...init,
          headers: buildResolvedHeaders(
            init?.headers,
            runtime.publishableKey,
            refreshedAccessToken,
          ),
        },
        fetchImpl,
        timeoutMs,
      );
    }

    return toResponse(responseLike, init?.method);
  };
}

type SupabaseQueryResult<T> = {
  data: T | null;
  error: PostgrestError | null;
  status: number;
};

function formatPostgrestError(error: PostgrestError): {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
} {
  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: error.message,
    details: typeof error.details === 'string' ? error.details : null,
    hint: typeof error.hint === 'string' ? error.hint : null,
  };
}

function isPostgrestInvalidJsonError(error: PostgrestError, status: number): boolean {
  const code = trimToken(error.code);
  const message = trimToken(error.message);
  if (code) {
    return false;
  }

  if (status === 0 && /^SyntaxError:/u.test(message)) {
    return true;
  }

  return status >= 200 && status < 300;
}

function postgrestInvalidJsonDetails(error: PostgrestError): string {
  return trimToken(error.details) || trimToken(error.message) || 'invalid JSON response';
}

export async function runSupabaseArrayQuery<T>(
  queryPromise: PromiseLike<SupabaseQueryResult<T[]>>,
  sourceUrl: string,
  options: { requireArray?: boolean } = {},
): Promise<T[]> {
  const data = await runSupabaseQuery(queryPromise, sourceUrl);
  if (options.requireArray && !Array.isArray(data))
    throw new CliError('Supabase REST response was not a JSON array.', {
      code: 'SUPABASE_REST_RESPONSE_INVALID',
      exitCode: 1,
    });
  return (data ?? []) as T[];
}

export async function runSupabaseQuery<T>(
  queryPromise: PromiseLike<SupabaseQueryResult<T>>,
  sourceUrl: string,
): Promise<T | null> {
  try {
    const result = await queryPromise;
    if (result.error) {
      if (isPostgrestInvalidJsonError(result.error, result.status)) {
        throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
          code: 'REMOTE_INVALID_JSON',
          exitCode: 1,
          details: postgrestInvalidJsonDetails(result.error),
        });
      }

      throw new CliError(`HTTP ${result.status} returned from ${sourceUrl}`, {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: formatPostgrestError(result.error),
      });
    }
    return result.data;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
        code: 'REMOTE_INVALID_JSON',
        exitCode: 1,
        details: error.message,
      });
    }

    throw new CliError(`Supabase request failed for ${sourceUrl}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runSupabaseMutation(
  queryPromise: PromiseLike<{
    error: PostgrestError | null;
    status: number;
  }>,
  sourceUrl: string,
): Promise<void> {
  try {
    const result = await queryPromise;
    if (result.error) {
      if (isPostgrestInvalidJsonError(result.error, result.status)) {
        throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
          code: 'REMOTE_INVALID_JSON',
          exitCode: 1,
          details: postgrestInvalidJsonDetails(result.error),
        });
      }

      throw new CliError(`HTTP ${result.status} returned from ${sourceUrl}`, {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: formatPostgrestError(result.error),
      });
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
        code: 'REMOTE_INVALID_JSON',
        exitCode: 1,
        details: error.message,
      });
    }

    throw new CliError(`Supabase request failed for ${sourceUrl}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createSupabaseDataClient(
  runtime: SupabaseDataRuntime,
  fetchImpl: FetchLike,
  timeoutMs: number,
) {
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);

  return {
    client: createClient(projectBaseUrl, runtime.publishableKey, {
      db: {
        // Core entity access is deliberately pinned to public. Never rely on
        // supabase-js/PostgREST's implicit default schema.
        schema: 'public',
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: createSupabaseFetch(fetchImpl, timeoutMs, runtime),
      },
    }),
    restBaseUrl: deriveSupabaseRestBaseUrl(projectBaseUrl),
    functionsBaseUrl: deriveSupabaseFunctionsBaseUrl(projectBaseUrl),
  };
}

export const __testInternals = {
  postgrestInvalidJsonDetails,
  parseBooleanEnv,
  resolveSupabaseAuthMode,
  trimToken,
};
