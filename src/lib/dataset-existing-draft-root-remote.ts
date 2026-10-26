// data-api-relations: processes
import { CliError } from './errors.js';
import { sha256Json } from './canonical-json-hash.js';
import type { FetchLike } from './http.js';
import type { ExistingDraftRootSnapshot } from './dataset-existing-draft-root-intent.js';
import {
  buildSnapshotCompleteness,
  fetchCompletePostgrestPages,
  type DatasetMaintenanceSnapshotCompleteness,
} from './dataset-maintenance-pagination.js';
import {
  createSupabaseFetch,
  deriveSupabaseRestBaseUrl,
  type SupabaseDataRuntime,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapability,
} from './supabase-data-api-contract.js';

export type ExistingDraftReviewPoint = {
  id: string;
  version: string;
  user_id: string;
  state_code: number;
  review_id: string | null;
};

export type ExistingDraftRootObservation = {
  selected: ExistingDraftRootSnapshot;
  published_baseline: ExistingDraftRootSnapshot;
  drafts: ExistingDraftRootSnapshot[];
  reviews: ExistingDraftReviewPoint[];
  completeness: DatasetMaintenanceSnapshotCompleteness<'drafts' | 'reviews'>;
};

const PAGE_SIZE = 1_000;
const ROW_COLUMNS = [
  'id',
  'version',
  'user_id',
  'state_code',
  'modified_at',
  'json_ordered',
  'team_id',
  'model_id',
  'model_version',
  'review_id',
] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
type RecordValue = Record<string, unknown>;

function requireObservation(condition: unknown): asserts condition {
  if (!condition) {
    throw new CliError('Existing draft root observation was missing or invalid.', {
      code: 'DATASET_EXISTING_DRAFT_ROOT_REMOTE_INVALID',
      exitCode: 1,
    });
  }
}

function record(value: unknown): RecordValue {
  requireObservation(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as RecordValue;
}

function uuid(value: unknown): string {
  requireObservation(typeof value === 'string' && UUID.test(value));
  return value;
}

function version(value: unknown): string {
  requireObservation(typeof value === 'string' && VERSION.test(value));
  return value;
}

function nullableUuid(value: unknown): void {
  requireObservation(value === null || (typeof value === 'string' && UUID.test(value)));
}

function snapshot(
  value: unknown,
  expected: { id: string; version?: string; actorUserId?: string; state: 0 | 100 },
): ExistingDraftRootSnapshot {
  const row = record(value);
  requireObservation(ROW_COLUMNS.every((column) => Object.hasOwn(row, column)));
  const id = uuid(row.id);
  const rowVersion = version(row.version);
  const owner = uuid(row.user_id);
  requireObservation(
    id === expected.id &&
      (expected.version === undefined || rowVersion === expected.version) &&
      (expected.actorUserId === undefined || owner === expected.actorUserId) &&
      row.state_code === expected.state &&
      row.model_id === null &&
      row.model_version === null,
  );
  requireObservation(
    row.modified_at === null ||
      (typeof row.modified_at === 'string' &&
        row.modified_at.trim() === row.modified_at &&
        /^\d{4}-\d{2}-\d{2}T/u.test(row.modified_at) &&
        Number.isFinite(Date.parse(row.modified_at))),
  );
  nullableUuid(row.team_id);
  nullableUuid(row.review_id);
  if (expected.state === 0) {
    requireObservation(row.team_id === null && row.review_id === null);
  }
  const payload = record(row.json_ordered);
  requireObservation(Object.keys(payload).length === 1 && Object.hasOwn(payload, 'processDataSet'));
  const process = record(payload.processDataSet);
  const information = record(record(process.processInformation).dataSetInformation);
  const publication = record(record(process.administrativeInformation).publicationAndOwnership);
  requireObservation(
    uuid(information['common:UUID']) === id &&
      version(publication['common:dataSetVersion']) === rowVersion,
  );
  const beforeImage = Object.fromEntries(ROW_COLUMNS.map((column) => [column, row[column]]));
  return {
    table: 'processes',
    id,
    version: rowVersion,
    user_id: owner,
    state_code: expected.state,
    payload_sha256: sha256Json(payload),
    row_sha256: sha256Json(beforeImage),
  };
}

function review(value: unknown, id: string, actorUserId: string): ExistingDraftReviewPoint {
  const row = record(value);
  const rowId = uuid(row.id);
  const owner = uuid(row.user_id);
  const rowVersion = version(row.version);
  requireObservation(
    rowId === id &&
      owner === actorUserId &&
      typeof row.state_code === 'number' &&
      Number.isInteger(row.state_code) &&
      row.state_code >= 20 &&
      row.state_code < 100,
  );
  nullableUuid(row.review_id);
  return {
    id: rowId,
    version: rowVersion,
    user_id: owner,
    state_code: row.state_code,
    review_id: row.review_id as string | null,
  };
}

export async function observeExistingDraftRoot(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  id: string;
  version: string;
  actorUserId: string;
}): Promise<ExistingDraftRootObservation> {
  uuid(options.id);
  version(options.version);
  uuid(options.actorUserId);
  requireObservation(
    Number.isSafeInteger(options.timeoutMs) &&
      options.timeoutMs > 0 &&
      options.timeoutMs <= 4_294_967_295,
  );
  const capability = resolveDataApiCapability({ kind: 'relation', name: 'processes' });
  const relationUrl = buildDataApiUrl(
    deriveSupabaseRestBaseUrl(options.runtime.apiBaseUrl),
    capability,
  );
  const fetch = createSupabaseFetch(options.fetchImpl, options.timeoutMs, options.runtime);
  async function get(params: Record<string, string>) {
    const url = new URL(relationUrl);
    url.search = new URLSearchParams({
      select: ROW_COLUMNS.join(','),
      id: `eq.${options.id}`,
      ...params,
    }).toString();
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        headers: applyDataApiProfileHeaders({ Prefer: 'count=exact' }, capability),
      });
      if (!response.ok) throw new Error('request failed');
      body = await response.json();
    } catch {
      throw new CliError('Existing draft root read request failed.', {
        code: 'DATASET_EXISTING_DRAFT_ROOT_REMOTE_REQUEST_FAILED',
        exitCode: 1,
      });
    }
    requireObservation(Array.isArray(body));
    return {
      rows: body as unknown[],
      source_url: url.toString(),
      content_range: response.headers.get('content-range'),
    };
  }
  const exact = await get({
    version: `eq.${options.version}`,
    user_id: `eq.${options.actorUserId}`,
    state_code: 'eq.0',
    limit: '2',
  });
  requireObservation(exact.rows.length === 1);
  const selected = snapshot(exact.rows[0], {
    id: options.id,
    version: options.version,
    actorUserId: options.actorUserId,
    state: 0,
  });
  const latest = await get({ state_code: 'eq.100', order: 'version.desc', limit: '1' });
  requireObservation(latest.rows.length === 1);
  const publishedBaseline = snapshot(latest.rows[0], { id: options.id, state: 100 });
  const drafts = await fetchCompletePostgrestPages({
    table: 'drafts',
    requestedPageSize: PAGE_SIZE,
    fetchPage: async (offset) => {
      const page = await get({
        user_id: `eq.${options.actorUserId}`,
        state_code: 'eq.0',
        order: 'version.asc',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      return {
        ...page,
        rows: page.rows.map((row) =>
          snapshot(row, { id: options.id, actorUserId: options.actorUserId, state: 0 }),
        ),
      };
    },
    rowIdentity: (row) => row.version,
  });
  const reviews = await fetchCompletePostgrestPages({
    table: 'reviews',
    requestedPageSize: PAGE_SIZE,
    fetchPage: async (offset) => {
      const page = await get({
        user_id: `eq.${options.actorUserId}`,
        and: '(state_code.gte.20,state_code.lt.100)',
        select: 'id,version,user_id,state_code,review_id',
        order: 'version.asc',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      return {
        ...page,
        rows: page.rows.map((row) => review(row, options.id, options.actorUserId)),
      };
    },
    rowIdentity: (row) => row.version,
  });
  return {
    selected,
    published_baseline: publishedBaseline,
    drafts: drafts.rows,
    reviews: reviews.rows,
    completeness: buildSnapshotCompleteness({
      tables: ['drafts', 'reviews'],
      requestedPageSize: PAGE_SIZE,
      results: [
        { table: 'drafts', completeness: drafts.completeness },
        { table: 'reviews', completeness: reviews.completeness },
      ],
    }),
  };
}
