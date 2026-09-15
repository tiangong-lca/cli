import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  runAuthIdentityReceipt,
  type ResolveAuthIdentitySession,
  type AuthIdentityReceipt,
} from './auth-identity-receipt.js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import { createSupabaseFetch, requireSupabaseRestRuntime } from './supabase-client.js';
import {
  resolveSupabaseUserSession,
  type ResolvedSupabaseUserSession,
} from './supabase-session.js';

export const DATASET_READ_LIMITS = {
  response_bytes: 4 * 1024 * 1024,
  metadata_response_bytes: 64 * 1024,
  auth_response_bytes: 256 * 1024,
  total_response_bytes: 8 * 1024 * 1024,
  requests: 16,
} as const;
export type ReadFailure = (code: string, message: string, exitCode?: number) => never;
export type DatasetReadOptions = {
  outDir: string;
  expectedProjectRef: string;
  expectedUserId: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  cliVersion: string;
  timeoutMs?: number;
  now?: Date;
  resolveSessionImpl?: ResolveAuthIdentitySession;
};
export type DatasetReadFile = { path: string; sha256: string; bytes: number };
export function datasetReadFile(file: string, text: string): DatasetReadFile {
  return {
    path: file,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
  };
}
export type DatasetReadContext = {
  outDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  actor: string;
  identity: AuthIdentityReceipt;
  dataFetch: ReturnType<typeof createSupabaseFetch>;
  runtime: ReturnType<typeof requireSupabaseRestRuntime>;
  requestCount: number;
  responseBytes: number;
  fail: ReadFailure;
};
async function boundedText(
  response: ResponseLike,
  limit: number,
  signal: AbortSignal,
  fail: ReadFailure,
): Promise<string> {
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > limit)
    fail('BYTE_LIMIT', 'Dataset response exceeded its byte limit.');
  if (!response.body) {
    const value = await response.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(value) > limit)
      fail('BYTE_LIMIT', 'Dataset response exceeded its byte limit.');
    return value;
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
      if (bytes > limit) {
        await reader.cancel();
        fail('BYTE_LIMIT', 'Dataset response exceeded its byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
async function withDeadline<T>(
  timeoutMs: number,
  errorPrefix: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CliError('Dataset read exceeded the operation deadline.', {
        code: `${errorPrefix}_TIME_LIMIT`,
        exitCode: 1,
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function withDatasetReadSession<T>(
  input: DatasetReadOptions,
  errorPrefix: 'DATASET_GET' | 'DATASET_SOURCE_DISCOVER',
  operation: (context: DatasetReadContext) => Promise<T>,
): Promise<T> {
  const options = { ...input, env: { ...input.env } };
  const fail: ReadFailure = (code, message, exitCode = 1) => {
    throw new CliError(message, { code: `${errorPrefix}_${code}`, exitCode });
  };
  if (!options.expectedProjectRef.trim() || !options.expectedUserId.trim())
    fail('IDENTITY_REQUIRED', 'Both expected project and user assertions are required.', 2);
  if (!options.outDir.trim()) fail('OUT_DIR_REQUIRED', 'A fresh --out-dir is required.', 2);
  const outDir = path.resolve(options.outDir);
  if (lstatSync(outDir, { throwIfNoEntry: false }))
    fail('OUTPUT_EXISTS', 'Dataset read output already exists.', 2);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    fail('TIMEOUT_INVALID', 'Timeout must be an integer from 1 to 120000 milliseconds.', 2);
  const runtime = requireSupabaseRestRuntime(options.env);
  return withDeadline(timeoutMs, errorPrefix, async (signal) => {
    let requestCount = 0;
    let responseBytes = 0;
    const fetchImpl: FetchLike = async (url, init = {}) => {
      signal.throwIfAborted();
      if (++requestCount > DATASET_READ_LIMITS.requests)
        fail('REQUEST_LIMIT', 'Dataset read exceeded its request limit.');
      const response = await options.fetchImpl(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
      });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        return new Response(null, { status: response.status });
      }
      const target = new URL(url);
      const limit = target.pathname.startsWith('/auth/')
        ? DATASET_READ_LIMITS.auth_response_bytes
        : target.searchParams.get('select')?.split(',').includes('json')
          ? DATASET_READ_LIMITS.response_bytes
          : DATASET_READ_LIMITS.metadata_response_bytes;
      const text = await boundedText(response, limit, signal, fail);
      responseBytes += Buffer.byteLength(text);
      if (responseBytes > DATASET_READ_LIMITS.total_response_bytes)
        fail('BYTE_LIMIT', 'Dataset read exceeded its total byte limit.');
      return new Response(text, {
        status: response.status,
        headers:
          response.headers.get('content-type') === null
            ? {}
            : { 'content-type': response.headers.get('content-type')! },
      });
    };
    const resolver = options.resolveSessionImpl ?? resolveSupabaseUserSession;
    let session: ResolvedSupabaseUserSession;
    const identify = async (forceRefresh = false) =>
      runAuthIdentityReceipt({
        env: options.env,
        fetchImpl,
        cliVersion: options.cliVersion,
        timeoutMs,
        now: options.now,
        expectedProjectRef: options.expectedProjectRef,
        expectedUserId: options.expectedUserId,
        resolveSessionImpl: async (request) => {
          session = await resolver({
            ...request,
            forceRefresh: forceRefresh || request.forceRefresh,
          });
          return session;
        },
      });
    let identity = await identify();
    const actor = identity.identity.user_id;
    const dataFetch = createSupabaseFetch(fetchImpl, timeoutMs, {
      apiBaseUrl: runtime.apiBaseUrl,
      publishableKey: runtime.publishableKey,
      getAccessToken: async () => session.accessToken,
      ...(runtime.authMode === 'oauth'
        ? {
            refreshAccessToken: async () => {
              identity = await identify(true);
              return session.accessToken;
            },
          }
        : {}),
    });
    return operation({
      outDir,
      signal,
      timeoutMs,
      actor,
      runtime,
      dataFetch,
      fail,
      get identity() {
        return identity;
      },
      get requestCount() {
        return requestCount;
      },
      get responseBytes() {
        return responseBytes;
      },
    });
  });
}

export function publishDatasetReadArtifacts(
  context: DatasetReadContext,
  reportPath: string,
  report: unknown,
  files: Array<{ path: string; text: string }>,
): void {
  const { outDir, signal, fail } = context;
  signal.throwIfAborted();
  try {
    mkdirSync(path.dirname(outDir), { recursive: true, mode: 0o700 });
    mkdirSync(outDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('OUTPUT_EXISTS', 'Dataset read output already exists.', 2);
    fail('ARTIFACT_WRITE_FAILED', 'Dataset read could not reserve its output directory.');
  }
  try {
    for (const file of files) writeFileSync(file.path, file.text, { flag: 'wx', mode: 0o600 });
    writeFileSync(
      path.join(outDir, 'identity-receipt.json'),
      JSON.stringify(context.identity) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    writeFileSync(reportPath + '.tmp', JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(reportPath + '.tmp', reportPath);
  } catch {
    rmSync(outDir, { recursive: true, force: true });
    fail('ARTIFACT_WRITE_FAILED', 'Dataset read could not publish its completion report.');
  }
}
