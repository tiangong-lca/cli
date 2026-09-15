import path from 'node:path';
import { isRecord } from './dataset-local.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import { loadDatasetReadExclusions } from './dataset-read-exclusions.js';
import {
  DATASET_READ_LIMITS,
  datasetReadFile,
  publishDatasetReadArtifacts,
  withDatasetReadSession,
  type DatasetReadOptions,
} from './dataset-read.js';
import { CliError } from './errors.js';
import { deriveSupabaseRestBaseUrl } from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapability,
} from './supabase-data-api-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const COLUMNS = 'rank,id,version,modified_at,team_id,total_count';
export type RunDatasetSourceDiscoverOptions = DatasetReadOptions & {
  query: string;
  scope: string;
  limit?: number;
  exclusionsFile?: string;
};
type SourceCandidate = {
  type: 'source';
  id: string;
  version: string;
  rank: string;
  modified_at: string | null;
  team_id: string | null;
};
function fail(code: string, message: string, exitCode = 1): never {
  throw new CliError(message, { code: `DATASET_SOURCE_DISCOVER_${code}`, exitCode });
}
function count(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof text !== 'string' ||
    !/^[1-9]\d{0,18}$/u.test(text) ||
    BigInt(text) > 9223372036854775807n
  )
    fail('CANDIDATE_INVALID', 'Candidate rank and total must be positive lossless integers.');
  return text;
}

export async function runDatasetSourceDiscover(input: RunDatasetSourceDiscoverOptions) {
  const options = { ...input, env: { ...input.env } };
  if (!options.query.trim() || Buffer.byteLength(options.query) > 4096)
    fail(
      'QUERY_INVALID',
      'Source discovery requires nonempty query text up to 4096 UTF-8 bytes.',
      2,
    );
  if (options.scope !== 'public100')
    fail('SCOPE_REQUIRED', 'Source discovery requires explicit --scope public100.', 2);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail('LIMIT_INVALID', 'Source discovery limit must be an integer from 1 to 100.', 2);
  const exclusions = loadDatasetReadExclusions(options.exclusionsFile, fail);
  return withDatasetReadSession(options, 'DATASET_SOURCE_DISCOVER', async (context) => {
    const { signal, runtime, dataFetch, outDir } = context;
    const capability = resolveDataApiCapability({ kind: 'rpc', name: 'search_sources' });
    const url = new URL(
      buildDataApiUrl(deriveSupabaseRestBaseUrl(runtime.apiBaseUrl), {
        kind: 'rpc',
        name: 'search_sources',
      }),
    );
    url.searchParams.set('select', COLUMNS);
    url.searchParams.set('limit', String(limit));
    const body = {
      query_text: options.query,
      filter_condition: {},
      page_size: limit,
      page_current: 1,
      data_source: 'tg',
      this_user_id: '',
      team_id_filter: null,
      state_code_filter: 100,
    };
    const request = {
      method: 'POST',
      rpc: capability.signature,
      url: url.toString(),
      body,
      project_ref: options.expectedProjectRef,
      actor_user_id: context.actor,
    };
    let text: string;
    let rows: unknown;
    try {
      const response = await dataFetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        body: JSON.stringify(body),
        headers: applyDataApiProfileHeaders(
          { 'content-type': 'application/json' },
          capability,
          'POST',
        ),
      });
      if (!response.ok) fail('READ_FAILED', 'Source candidate request was rejected.');
      text = await response.text();
      signal.throwIfAborted();
      try {
        rows = JSON.parse(text);
      } catch {
        fail('INVALID_JSON', 'Source candidate response is not valid JSON.');
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError && error.code.startsWith('DATASET_SOURCE_DISCOVER_'))
        throw error;
      fail('READ_FAILED', 'Source candidate discovery failed.');
    }
    if (!Array.isArray(rows) || rows.length > limit)
      fail(
        'ROW_LIMIT',
        'Source discovery response exceeded its bounded first page or was not an array.',
      );
    const ids = new Set<string>();
    let total: string | null = null;
    let previous: SourceCandidate | undefined;
    const candidates: SourceCandidate[] = [];
    let excludedCount = 0;
    for (const row of rows) {
      if (
        !isRecord(row) ||
        Object.keys(row).sort().join(',') !== COLUMNS.split(',').sort().join(',') ||
        typeof row.id !== 'string' ||
        !UUID.test(row.id) ||
        typeof row.version !== 'string' ||
        !VERSION.test(row.version) ||
        !(
          row.modified_at === null ||
          (typeof row.modified_at === 'string' && Number.isFinite(Date.parse(row.modified_at)))
        ) ||
        !(row.team_id === null || (typeof row.team_id === 'string' && UUID.test(row.team_id)))
      )
        fail(
          'CANDIDATE_INVALID',
          'Source discovery requires exact metadata-only typed candidates.',
        );
      const rank = count(row.rank);
      const rowTotal = count(row.total_count);
      if (
        (total !== null && total !== rowTotal) ||
        BigInt(rowTotal) < BigInt(rows.length) ||
        BigInt(rank) > BigInt(rowTotal)
      )
        fail('COUNT_INVALID', 'Source candidate totals changed or contradict the observed page.');
      total = rowTotal;
      if (
        ids.has(row.id) ||
        (previous &&
          (BigInt(rank) < BigInt(previous.rank) ||
            (rank === previous.rank && row.id <= previous.id)))
      )
        fail('CANDIDATE_ORDER', 'Source candidates are duplicated or out of rank/id order.');
      ids.add(row.id);
      const candidate: SourceCandidate = {
        type: 'source',
        id: row.id,
        version: row.version,
        rank,
        modified_at: row.modified_at,
        team_id: row.team_id,
      };
      previous = candidate;
      if (exclusions.keys.has(`source:${row.id}@${row.version}`)) excludedCount++;
      else candidates.push(candidate);
    }
    const artifacts = {
      identity: path.join(outDir, 'identity-receipt.json'),
      report: path.join(outDir, 'source-discovery-report.json'),
      request: datasetReadFile(path.join(outDir, 'request.json'), JSON.stringify(request) + '\n'),
      response: datasetReadFile(path.join(outDir, 'candidate-rows.json'), text),
    };
    const report = {
      schema_version: 1,
      command: 'dataset source discover',
      status: 'completed',
      remote_write_mode: 'read-only',
      captured_at_utc: context.identity.captured_at_utc,
      project_ref: context.identity.project.project_ref,
      actor_user_id: context.actor,
      scope: 'public100',
      page_current: 1,
      requested_limit: limit,
      observed_count: rows.length,
      server_total_count: total,
      page_truncated: total === null ? null : BigInt(total) > BigInt(rows.length),
      excluded_count: excludedCount,
      exclusions: exclusions.fact,
      candidates,
      candidate_semantics: 'latest-public100-version-of-matched-UUID',
      strict_match_evaluated: false,
      matched_version_proven: false,
      catalogue_absence_proven: false,
      partial: true,
      transactional_snapshot: false,
      request_sha256: sha256Json(request),
      attachments: 'metadata-only; no storage requests',
      limitations: [
        'An older matching version can yield a latest candidate that does not match the query.',
        'One public100 page does not cover other pages, states 101–199, unindexed text or historical exact versions.',
        'Projection and client deadlines do not bound SQL intermediates or prove server cancellation.',
        'Discovery and exact reads are separate observations; candidates grant no reference eligibility.',
      ],
      bounds: {
        ...DATASET_READ_LIMITS,
        query_bytes: 4096,
        timeout_ms: context.timeoutMs,
        requests_observed: context.requestCount,
        response_bytes_observed: context.responseBytes,
      },
      artifacts,
    };
    publishDatasetReadArtifacts(context, artifacts.report, report, [
      { path: artifacts.request.path, text: JSON.stringify(request) + '\n' },
      { path: artifacts.response.path, text },
    ]);
    return report;
  });
}
