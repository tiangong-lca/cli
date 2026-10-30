import { runAuthIdentityReceipt } from './auth-identity-receipt.js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import { loadCliPackageVersion } from './package-version.js';
import {
  createSupabaseFetch,
  requireSupabaseRestRuntime,
  type SupabaseDataRuntime,
} from './supabase-client.js';
import { resolveSupabaseUserSession } from './supabase-session.js';

export const OBJECT_READ_LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  requests: 16,
  durationMs: 30_000,
} as const;

export function objectReadError(code: string, message: string, exitCode = 1): never {
  throw new CliError(message, { code: `OBJECT_GET_${code}`, exitCode });
}

// Reproject only stable session-owner failures; provider text and details stay private.
function safeSessionError(error: unknown): CliError | null {
  if (!(error instanceof CliError)) return null;
  if (error.code === 'SUPABASE_OAUTH_LOGIN_REQUIRED')
    return new CliError(
      'No usable OAuth session is available. Run `tiangong-lca auth login` in a trusted terminal.',
      { code: error.code, exitCode: 1 },
    );
  if (error.code === 'SUPABASE_OAUTH_REFRESH_UNAVAILABLE')
    return new CliError('OAuth refresh could not complete. Retry the command later.', {
      code: error.code,
      exitCode: 1,
    });
  return null;
}

async function responseText(response: ResponseLike, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > OBJECT_READ_LIMITS.responseBytes)
    objectReadError('BYTE_LIMIT', 'Object response exceeded the byte limit.');
  if (!response.body) {
    const text = await response.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(text) > OBJECT_READ_LIMITS.responseBytes)
      objectReadError('BYTE_LIMIT', 'Object response exceeded the byte limit.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > OBJECT_READ_LIMITS.responseBytes) {
        await reader.cancel();
        objectReadError('BYTE_LIMIT', 'Object response exceeded the byte limit.');
      }
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}

/** Includes auth, refresh and response consumption in one finite read operation. */
export async function withObjectReadTransport<T>(
  options: {
    env: NodeJS.ProcessEnv;
    fetchImpl: FetchLike;
    timeoutMs: number;
    expectedProjectRef?: string;
    expectedUserId?: string;
    now?: Date;
  },
  operation: (transport: {
    fetchImpl: typeof fetch;
    runtime: SupabaseDataRuntime;
    actorUserId: string;
  }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new CliError('Object read exceeded its deadline.', {
          code: 'OBJECT_GET_TIMEOUT',
          exitCode: 1,
        }),
      );
    }, OBJECT_READ_LIMITS.durationMs);
  });
  const work = async (): Promise<T> => {
    let requests = 0;
    let totalBytes = 0;
    const boundedFetch: FetchLike = async (url, init) => {
      controller.signal.throwIfAborted();
      if (++requests > OBJECT_READ_LIMITS.requests)
        objectReadError('REQUEST_LIMIT', 'Object read exceeded its request limit.');
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs)]);
      let requestTimer: ReturnType<typeof setTimeout>;
      const requestDeadline = new Promise<never>((_resolve, reject) => {
        requestTimer = setTimeout(
          () =>
            reject(
              new CliError('Object request timed out.', {
                code: 'OBJECT_GET_TIMEOUT',
                exitCode: 1,
              }),
            ),
          options.timeoutMs,
        );
      });
      try {
        return await Promise.race([
          requestDeadline,
          (async () => {
            const response = await options.fetchImpl(url, { ...init, signal, redirect: 'error' });
            const text = await responseText(response, signal);
            totalBytes += Buffer.byteLength(text);
            if (totalBytes > OBJECT_READ_LIMITS.totalBytes)
              objectReadError('BYTE_LIMIT', 'Object read exceeded its total byte limit.');
            return {
              ok: response.ok,
              status: response.status,
              headers: response.headers,
              text: async () => text,
            };
          })(),
        ]);
      } finally {
        clearTimeout(requestTimer!);
      }
    };
    const env = { ...options.env };
    const config = requireSupabaseRestRuntime(env);
    let actorUserId: string | undefined;
    let verifiedToken: string | undefined;
    let invalidated = false;
    const token = async (forceRefresh = false): Promise<string> => {
      if (invalidated)
        objectReadError('SESSION_INVALID', 'Object read session is no longer valid.');
      let resolverFailure: unknown;
      try {
        let session = await resolveSupabaseUserSession({
          runtime: config,
          fetchImpl: boundedFetch,
          timeoutMs: options.timeoutMs,
          now: options.now,
          forceRefresh,
        });
        if (forceRefresh || session.accessToken !== verifiedToken) {
          const receipt = await runAuthIdentityReceipt({
            env,
            fetchImpl: boundedFetch,
            cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
            expectedProjectRef: options.expectedProjectRef,
            expectedUserId: actorUserId ?? options.expectedUserId,
            timeoutMs: options.timeoutMs,
            now: options.now,
            resolveSessionImpl: async (request) => {
              if (request.forceRefresh) {
                try {
                  session = await resolveSupabaseUserSession({
                    runtime: config,
                    fetchImpl: boundedFetch,
                    timeoutMs: options.timeoutMs,
                    now: options.now,
                    forceRefresh: true,
                  });
                } catch (error) {
                  resolverFailure = error;
                  throw error;
                }
              }
              return session;
            },
          });
          actorUserId = receipt.identity.user_id;
          verifiedToken = session.accessToken;
        }
        return session.accessToken;
      } catch (error) {
        invalidated = true;
        const sessionError = safeSessionError(resolverFailure ?? error);
        if (sessionError) throw sessionError;
        return objectReadError(
          'SESSION_INVALID',
          'Object read could not verify the current project and actor.',
        );
      }
    };
    await token();
    const runtime: SupabaseDataRuntime = {
      apiBaseUrl: config.apiBaseUrl,
      publishableKey: config.publishableKey,
      getAccessToken: () => token(),
      ...(config.authMode === 'oauth' ? { refreshAccessToken: () => token(true) } : {}),
    };
    const result = await operation({
      runtime,
      fetchImpl: createSupabaseFetch(boundedFetch, options.timeoutMs, runtime),
      actorUserId: actorUserId!,
    });
    await token();
    return result;
  };
  try {
    return await Promise.race([deadline, work()]);
  } catch (error) {
    const sessionError = safeSessionError(error);
    if (sessionError) throw sessionError;
    if (error instanceof CliError && /^(OBJECT_GET_|OBJECT_READ_)/u.test(error.code)) throw error;
    return objectReadError('FAILED', 'Object read failed without a complete valid result.');
  } finally {
    controller.abort();
    clearTimeout(timer!);
  }
}
