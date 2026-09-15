// data-api-relations: contacts, sources
import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { datasetIdentity, detectDatasetKind, isRecord } from './dataset-local.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import { CliError } from './errors.js';
import { loadDatasetReadExclusions, type ExclusionsFact } from './dataset-read-exclusions.js';
import { deriveSupabaseRestBaseUrl } from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapabilityFromUrl,
} from './supabase-data-api-contract.js';
import {
  withDatasetReadSession,
  publishDatasetReadArtifacts,
  datasetReadFile,
  DATASET_READ_LIMITS,
  type DatasetReadOptions,
} from './dataset-read.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const METADATA_COLUMNS = 'id,version,user_id,state_code,modified_at';
const FULL_COLUMNS = `${METADATA_COLUMNS},json,json_ordered`;
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
export type SourceReadObservation = Omit<ContactReadObservation, 'table' | 'schema'> & {
  table: 'sources';
  schema: { validator: '@tiangong-lca/tidas-sdk/SourceSchema'; ok: true };
};
type ReadObservation = ContactReadObservation | SourceReadObservation;
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
  exclusions: ExclusionsFact | null;
  bounds: typeof DATASET_READ_LIMITS & {
    timeout_ms: number;
    requests_observed: number;
    response_bytes_observed: number;
  };
  selected: ReadObservation;
  latest: ReadObservation | null;
  artifacts: { identity: string; report: string };
};
export type RunDatasetGetOptions = DatasetReadOptions & {
  type: string;
  id: string;
  version: string;
  scope: string;
  includeLatest?: boolean;
  exclusionsFile?: string;
};
function fail(code: string, message: string, exitCode = 1): never {
  throw new CliError(message, { code: `DATASET_GET_${code}`, exitCode });
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
    fail('ROW_INVALID', 'Dataset response has an invalid identity or metadata shape.');
  }
  return {
    id,
    version: value.version,
    user_id: value.user_id,
    state_code: value.state_code as number,
    modified_at: value.modified_at as string | null,
  };
}
export async function runDatasetGet(input: RunDatasetGetOptions): Promise<DatasetGetReport> {
  const options = { ...input, env: { ...input.env } };
  if (
    !['contact', 'source'].includes(options.type) ||
    !UUID.test(options.id) ||
    !VERSION.test(options.version)
  )
    fail(
      'SELECTION_INVALID',
      'dataset get requires --type contact|source, one canonical UUID and one exact version.',
      2,
    );
  if (!['public', 'owner-draft', 'public-or-owner-draft'].includes(options.scope))
    fail(
      'SCOPE_REQUIRED',
      'An explicit public, owner-draft or public-or-owner-draft scope is required.',
      2,
    );
  const scope = options.scope as Scope;
  const target =
    options.type === 'contact'
      ? ({
          kind: 'contact',
          table: 'contacts',
          schema: tidasSdk.ContactSchema,
          validator: '@tiangong-lca/tidas-sdk/ContactSchema',
        } as const)
      : ({
          kind: 'source',
          table: 'sources',
          schema: tidasSdk.SourceSchema,
          validator: '@tiangong-lca/tidas-sdk/SourceSchema',
        } as const);
  const exclusions = loadDatasetReadExclusions(options.exclusionsFile, fail);
  const admitVersion = (version: string) => {
    if (exclusions.keys.has(`${target.kind}:${options.id}@${version}`))
      fail(
        'TYPED_VERSION_EXCLUDED',
        'The requested typed version is excluded; its payload was not read.',
      );
  };
  admitVersion(options.version);
  return withDatasetReadSession(options, 'DATASET_GET', async (context) => {
    const { outDir, signal, actor, runtime, dataFetch } = context;
    const read = async (version: string | null): Promise<{ rows: unknown[]; text: string }> => {
      signal.throwIfAborted();
      const url = new URL(
        buildDataApiUrl(deriveSupabaseRestBaseUrl(runtime.apiBaseUrl), {
          kind: 'relation',
          name: target.table,
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
        if (!response.ok) fail('READ_FAILED', 'Dataset read request was rejected.');
        const text = await response.text();
        signal.throwIfAborted();
        let rows: unknown;
        try {
          rows = JSON.parse(text);
        } catch {
          fail('INVALID_JSON', 'Dataset response is not valid JSON.');
        }
        if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2)
          fail(
            'ROW_COUNT',
            'Dataset read requires a visible selected row and at most two bounded observations.',
          );
        return { rows, text };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError && error.code.startsWith('DATASET_GET_')) throw error;
        fail('READ_FAILED', 'Dataset read failed.');
      }
    };
    const exact = async (version: string, name: string, expected?: Metadata) => {
      admitVersion(version);
      const response = await read(version);
      if (response.rows.length !== 1)
        fail('ROW_COUNT', 'An exact dataset lookup returned duplicate rows.');
      const raw = response.rows[0];
      const facts = metadata(raw, options.id, true);
      if (facts.version !== version)
        fail('VERSION_MISMATCH', 'Dataset response does not match the selected exact version.');
      if (!permitted(facts, scope, actor))
        fail('SCOPE_VIOLATION', 'Dataset response escaped the requested content scope.');
      if (expected && sha256Json(facts) !== sha256Json(expected))
        fail('CONTENT_DRIFT', 'Latest dataset metadata changed before complete payload retrieval.');
      const row = raw as Record<string, unknown>;
      for (const candidate of [row.json, row.json_ordered]) {
        if (candidate === null) continue;
        if (!isRecord(candidate) || detectDatasetKind(candidate) !== target.kind)
          fail('PAYLOAD_INVALID', 'Dataset response has an invalid payload wrapper.');
        const identity = datasetIdentity({}, candidate, target.kind);
        if (identity.id !== facts.id || identity.version !== facts.version)
          fail('PAYLOAD_MISMATCH', 'Dataset payload identity does not match its row.');
        if (!target.schema.safeParse(structuredClone(candidate)).success)
          fail('SCHEMA_INVALID', 'Dataset payload failed the pinned dataset schema.');
      }
      const payload = row.json_ordered ?? row.json;
      if (!isRecord(payload)) fail('PAYLOAD_INVALID', 'Dataset row has no complete payload.');
      const artifact = datasetReadFile(path.join(outDir, name), response.text);
      const observation = {
        ...facts,
        table: target.table,
        payload_sha256: sha256Json(payload),
        artifact,
        schema: { validator: target.validator, ok: true },
      } as ReadObservation;
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
          'Latest Dataset response is duplicated or not in descending version order.',
        );
      const newest = rows[0]!;
      if (!permitted(newest, scope, actor))
        fail(
          'LATEST_OUTSIDE_SCOPE',
          'RLS-visible latest dataset is outside the requested content scope; its payload was not read.',
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
      captured_at_utc: context.identity.captured_at_utc,
      project_ref: context.identity.project.project_ref,
      actor_user_id: actor,
      scope,
      latest_resolution: options.includeLatest ? 'rls-visible' : 'not-requested',
      transactional_snapshot: false,
      exclusions: exclusions.fact,
      bounds: {
        ...DATASET_READ_LIMITS,
        timeout_ms: context.timeoutMs,
        requests_observed: context.requestCount,
        response_bytes_observed: context.responseBytes,
      },
      selected: selected.observation,
      latest: latest?.observation ?? null,
      artifacts,
    };
    publishDatasetReadArtifacts(
      context,
      artifacts.report,
      report,
      [selected, ...(latest ? [latest] : [])].map((item) => ({
        path: item.observation.artifact.path,
        text: item.text,
      })),
    );
    return report;
  });
}
