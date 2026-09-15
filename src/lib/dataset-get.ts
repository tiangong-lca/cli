// data-api-relations: contacts
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  runAuthIdentityReceipt,
  type ResolveAuthIdentitySession,
} from './auth-identity-receipt.js';
import { datasetIdentity, detectDatasetKind, isRecord } from './dataset-local.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import {
  createSupabaseFetch,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapabilityFromUrl,
} from './supabase-data-api-contract.js';
import {
  resolveSupabaseUserSession,
  type ResolvedSupabaseUserSession,
} from './supabase-session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const METADATA_COLUMNS = 'id,version,user_id,state_code,modified_at';
const FULL_COLUMNS = `${METADATA_COLUMNS},json,json_ordered`;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
type Scope = 'public' | 'owner-draft' | 'public-or-owner-draft';
type Metadata = {
  id: string;
  version: string;
  user_id: string;
  state_code: number;
  modified_at: string | null;
};
type FileFact = { path: string; sha256: string; bytes: number };
export type ContactReadObservation = Metadata & {
  table: 'contacts';
  payload_sha256: string;
  artifact: FileFact;
  schema: { validator: '@tiangong-lca/tidas-sdk/ContactSchema'; ok: true };
};
export type DatasetGetReport = {
  schema_version: 1;
  command: 'dataset get';
  status: 'completed';
  remote_write_mode: 'read-only';
  captured_at_utc: string;
  project_ref: string;
  actor_user_id: string;
  scope: Scope;
  latest_resolution: 'rls-visible' | 'not-requested';
  transactional_snapshot: false;
  selected: ContactReadObservation;
  latest: ContactReadObservation | null;
  artifacts: { identity: string; report: string };
};
export type RunDatasetGetOptions = {
  type: string;
  id: string;
  version: string;
  scope: string;
  includeLatest?: boolean;
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
function fail(code: string, message: string, exitCode = 1): never {
  throw new CliError(message, { code: `DATASET_GET_${code}`, exitCode });
}
function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function permitted(row: Metadata, scope: Scope, actor: string): boolean {
  return (
    (scope !== 'owner-draft' && row.state_code >= 100 && row.state_code <= 199) ||
    (scope !== 'public' && row.state_code === 0 && row.user_id === actor)
  );
}
function metadata(value: unknown, id: string, full: boolean): Metadata {
  const columns = full ? FULL_COLUMNS : METADATA_COLUMNS;
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== columns.split(',').sort().join(',') ||
    value.id !== id ||
    typeof value.version !== 'string' ||
    !VERSION.test(value.version) ||
    typeof value.user_id !== 'string' ||
    !UUID.test(value.user_id) ||
    !Number.isSafeInteger(value.state_code) ||
    !(
      value.modified_at === null ||
      (typeof value.modified_at === 'string' && Number.isFinite(Date.parse(value.modified_at)))
    )
  ) {
    fail('ROW_INVALID', 'Contact response has an invalid identity or metadata shape.');
  }
  return {
    id,
    version: value.version,
    user_id: value.user_id,
    state_code: value.state_code as number,
    modified_at: value.modified_at as string | null,
  };
}
async function boundedText(
  response: ResponseLike,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > limit)
    fail('BYTE_LIMIT', 'Contact response exceeded its byte limit.');
  if (!response.body) {
    const value = await response.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(value) > limit)
      fail('BYTE_LIMIT', 'Contact response exceeded its byte limit.');
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
        fail('BYTE_LIMIT', 'Contact response exceeded its byte limit.');
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
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CliError('Contact read exceeded the operation deadline.', {
        code: 'DATASET_GET_TIME_LIMIT',
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

export async function runDatasetGet(input: RunDatasetGetOptions): Promise<DatasetGetReport> {
  const options = { ...input, env: { ...input.env } };
  if (options.type !== 'contact' || !UUID.test(options.id) || !VERSION.test(options.version))
    fail(
      'SELECTION_INVALID',
      'dataset get requires --type contact, one canonical UUID and one exact version.',
      2,
    );
  if (!['public', 'owner-draft', 'public-or-owner-draft'].includes(options.scope))
    fail(
      'SCOPE_REQUIRED',
      'An explicit public, owner-draft or public-or-owner-draft scope is required.',
      2,
    );
  if (!options.expectedProjectRef.trim() || !options.expectedUserId.trim())
    fail('IDENTITY_REQUIRED', 'Both expected project and user assertions are required.', 2);
  if (!options.outDir.trim()) fail('OUT_DIR_REQUIRED', 'A fresh --out-dir is required.', 2);
  const outDir = path.resolve(options.outDir);
  if (lstatSync(outDir, { throwIfNoEntry: false }))
    fail('OUTPUT_EXISTS', 'Contact read output already exists.', 2);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    fail('TIMEOUT_INVALID', 'Timeout must be an integer from 1 to 120000 milliseconds.', 2);
  const scope = options.scope as Scope;
  const runtime = requireSupabaseRestRuntime(options.env);
  return withDeadline(timeoutMs, async (signal) => {
    const fetchImpl: FetchLike = (url, init = {}) => {
      signal.throwIfAborted();
      return options.fetchImpl(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
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
    let totalBytes = 0;
    const boundedFetch: FetchLike = async (url, init) => {
      const response = await fetchImpl(url, init);
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        return new Response(null, { status: response.status });
      }
      const limit =
        new URL(url).searchParams.get('select') === METADATA_COLUMNS
          ? 64 * 1024
          : MAX_RESPONSE_BYTES;
      const text = await boundedText(response, limit, signal);
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > MAX_TOTAL_BYTES)
        fail('BYTE_LIMIT', 'Contact read exceeded its total byte limit.');
      return new Response(text, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    const dataFetch = createSupabaseFetch(boundedFetch, timeoutMs, {
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
    const read = async (version: string | null): Promise<{ rows: unknown[]; text: string }> => {
      signal.throwIfAborted();
      const url = new URL(
        buildDataApiUrl(deriveSupabaseRestBaseUrl(runtime.apiBaseUrl), {
          kind: 'relation',
          name: 'contacts',
        }),
      );
      url.searchParams.set('select', version === null ? METADATA_COLUMNS : FULL_COLUMNS);
      url.searchParams.set('id', `eq.${options.id}`);
      url.searchParams.set('limit', '2');
      if (version === null) url.searchParams.set('order', 'version.desc');
      else {
        url.searchParams.set('version', `eq.${version}`);
        if (scope === 'owner-draft') {
          url.searchParams.set('state_code', 'eq.0');
          url.searchParams.set('user_id', `eq.${actor}`);
        } else {
          url.searchParams.set(
            'or',
            scope === 'public'
              ? '(and(state_code.gte.100,state_code.lte.199))'
              : `(and(state_code.gte.100,state_code.lte.199),and(state_code.eq.0,user_id.eq.${actor}))`,
          );
        }
      }
      try {
        const response = await dataFetch(url, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: applyDataApiProfileHeaders(
            {},
            resolveDataApiCapabilityFromUrl({ url: url.toString(), method: 'GET' }),
            'GET',
          ),
        });
        if (!response.ok) fail('READ_FAILED', 'Contact read request was rejected.');
        const text = await response.text();
        signal.throwIfAborted();
        let rows: unknown;
        try {
          rows = JSON.parse(text);
        } catch {
          fail('INVALID_JSON', 'Contact response is not valid JSON.');
        }
        if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2)
          fail(
            'ROW_COUNT',
            'Contact read requires a visible selected row and at most two bounded observations.',
          );
        return { rows, text };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError && error.code.startsWith('DATASET_GET_')) throw error;
        fail('READ_FAILED', 'Contact read failed.');
      }
    };
    const exact = async (version: string, name: string, expected?: Metadata) => {
      const response = await read(version);
      if (response.rows.length !== 1)
        fail('ROW_COUNT', 'An exact Contact lookup returned duplicate rows.');
      const raw = response.rows[0];
      const facts = metadata(raw, options.id, true);
      if (facts.version !== version)
        fail('VERSION_MISMATCH', 'Contact response does not match the selected exact version.');
      if (!permitted(facts, scope, actor))
        fail('SCOPE_VIOLATION', 'Contact response escaped the requested content scope.');
      if (expected && sha256Json(facts) !== sha256Json(expected))
        fail('CONTENT_DRIFT', 'Latest Contact metadata changed before complete payload retrieval.');
      const row = raw as Record<string, unknown>;
      for (const candidate of [row.json, row.json_ordered]) {
        if (candidate === null) continue;
        if (!isRecord(candidate) || detectDatasetKind(candidate) !== 'contact')
          fail('PAYLOAD_INVALID', 'Contact response has an invalid payload wrapper.');
        const identity = datasetIdentity({}, candidate, 'contact');
        if (identity.id !== facts.id || identity.version !== facts.version)
          fail('PAYLOAD_MISMATCH', 'Contact payload identity does not match its row.');
        if (!tidasSdk.ContactSchema.safeParse(structuredClone(candidate)).success)
          fail('SCHEMA_INVALID', 'Contact payload failed the pinned ContactSchema.');
      }
      const payload = row.json_ordered ?? row.json;
      if (!isRecord(payload)) fail('PAYLOAD_INVALID', 'Contact row has no complete payload.');
      const artifact = {
        path: path.join(outDir, name),
        sha256: digest(response.text),
        bytes: Buffer.byteLength(response.text),
      };
      const observation: ContactReadObservation = {
        ...facts,
        table: 'contacts',
        payload_sha256: sha256Json(payload),
        artifact,
        schema: { validator: '@tiangong-lca/tidas-sdk/ContactSchema', ok: true },
      };
      return { observation, text: response.text };
    };
    const selected = await exact(options.version, 'selected-row.json');
    let latest: Awaited<ReturnType<typeof exact>> | null = null;
    if (options.includeLatest) {
      const response = await read(null);
      const rows = response.rows.map((row) => metadata(row, options.id, false));
      if (rows.length === 2 && rows[0]!.version <= rows[1]!.version)
        fail(
          'LATEST_AMBIGUOUS',
          'Latest Contact response is duplicated or not in descending version order.',
        );
      const newest = rows[0]!;
      if (!permitted(newest, scope, actor))
        fail(
          'LATEST_OUTSIDE_SCOPE',
          'RLS-visible latest Contact is outside the requested content scope; its payload was not read.',
        );
      latest = await exact(newest.version, 'latest-row.json', newest);
    }
    const artifacts = {
      identity: path.join(outDir, 'identity-receipt.json'),
      report: path.join(outDir, 'get-report.json'),
    };
    const report: DatasetGetReport = {
      schema_version: 1,
      command: 'dataset get',
      status: 'completed',
      remote_write_mode: 'read-only',
      captured_at_utc: identity.captured_at_utc,
      project_ref: identity.project.project_ref,
      actor_user_id: actor,
      scope,
      latest_resolution: options.includeLatest ? 'rls-visible' : 'not-requested',
      transactional_snapshot: false,
      selected: selected.observation,
      latest: latest?.observation ?? null,
      artifacts,
    };
    signal.throwIfAborted();
    try {
      mkdirSync(path.dirname(outDir), { recursive: true, mode: 0o700 });
      mkdirSync(outDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        fail('OUTPUT_EXISTS', 'Contact read output already exists.', 2);
      fail('ARTIFACT_WRITE_FAILED', 'Contact read could not reserve its output directory.');
    }
    try {
      for (const item of [selected, ...(latest ? [latest] : [])])
        writeFileSync(item.observation.artifact.path, item.text, { flag: 'wx', mode: 0o600 });
      writeFileSync(artifacts.identity, JSON.stringify(identity) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(artifacts.report + '.tmp', JSON.stringify(report) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(artifacts.report + '.tmp', artifacts.report);
    } catch {
      rmSync(outDir, { recursive: true, force: true });
      fail('ARTIFACT_WRITE_FAILED', 'Contact read could not publish its completion report.');
    }
    return report;
  });
}
