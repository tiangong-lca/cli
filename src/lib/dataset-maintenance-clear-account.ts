// data-api-relations: contacts, flows, lifecyclemodels, processes, sources
import path from 'node:path';
import { writeJsonArtifact } from './artifacts.js';
import {
  deleteDatasetRecord,
  deriveSupabaseFunctionsBaseUrl,
  type DatasetCommandTransport,
} from './dataset-command.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import {
  buildSnapshotCompleteness,
  fetchCompletePostgrestPages,
  type DatasetMaintenanceSnapshotCompleteness,
  type DatasetMaintenanceTableCompleteness,
} from './dataset-maintenance-pagination.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  resolveDataApiCapability,
} from './supabase-data-api-contract.js';
import { resolveSupabaseUserSession } from './supabase-session.js';

type JsonObject = Record<string, unknown>;

export type DatasetMaintenanceClearAccountTable =
  'lifecyclemodels' | 'processes' | 'flows' | 'sources' | 'contacts';

export type DatasetMaintenanceClearAccountRow = {
  table: DatasetMaintenanceClearAccountTable;
  id: string | null;
  version: string | null;
  user_id: string | null;
  state_code: number | null;
  modified_at: string | null;
};

export type DatasetMaintenanceClearAccountTableReport = {
  table: DatasetMaintenanceClearAccountTable;
  status: 'dry_run' | 'skipped_empty' | 'deleted' | 'failed' | 'skipped_after_failure';
  candidates: number;
  deleted: number;
  remaining: number | null;
  source_urls: string[];
  delete_url: string | null;
  error: string | null;
};

export type DatasetMaintenanceClearAccountReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'planned_account_clear' | 'cleared_account' | 'completed_with_failures';
  mode: 'dry-run' | 'commit';
  account: {
    email: string;
    user_id: string;
    session_source: string;
  };
  filters: {
    tables: DatasetMaintenanceClearAccountTable[];
    state_codes: number[] | null;
    page_size: number;
  };
  snapshot_completeness: DatasetMaintenanceSnapshotCompleteness<DatasetMaintenanceClearAccountTable>;
  readback_completeness: DatasetMaintenanceSnapshotCompleteness<DatasetMaintenanceClearAccountTable> | null;
  readback_error: string | null;
  summary: {
    total_candidates: number;
    total_deleted: number;
    total_remaining: number;
    total_failures: number;
    by_table: Record<
      DatasetMaintenanceClearAccountTable,
      {
        candidates: number;
        deleted: number;
        remaining: number | null;
        status: DatasetMaintenanceClearAccountTableReport['status'];
      }
    >;
  };
  tables: DatasetMaintenanceClearAccountTableReport[];
  artifacts: {
    rls_visible_snapshot: string;
    dry_run_report: string;
    approval_record: string | null;
    commit_report: string | null;
    readback_verify_report: string | null;
  };
};

export type RunDatasetMaintenanceClearAccountOptions = {
  outDir?: string | null;
  stateCodes?: number[] | null;
  pageSize?: number;
  timeoutMs?: number;
  commit?: boolean;
  confirm?: string | null;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
};

const CLEAR_ACCOUNT_TABLES: DatasetMaintenanceClearAccountTable[] = [
  'lifecyclemodels',
  'processes',
  'flows',
  'sources',
  'contacts',
];

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function caughtErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeStateCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function normalizeStateCodes(values: number[] | null | undefined): number[] | null {
  const normalized = [...new Set((values ?? []).filter((value) => Number.isInteger(value)))].sort(
    (left, right) => left - right,
  );
  return normalized.length > 0 ? normalized : null;
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }

  if (!Number.isInteger(value) || value < 1 || value > 5_000) {
    throw new CliError('--page-size must be an integer between 1 and 5000.', {
      code: 'DATASET_MAINTENANCE_PAGE_SIZE_INVALID',
      exitCode: 2,
      details: value,
    });
  }

  return value;
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new CliError('--timeout-ms must be a positive integer.', {
      code: 'DATASET_MAINTENANCE_TIMEOUT_INVALID',
      exitCode: 2,
      details: value,
    });
  }

  return value;
}

function normalizeRow(
  table: DatasetMaintenanceClearAccountTable,
  value: unknown,
): DatasetMaintenanceClearAccountRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const modifiedAt = trimToken(value.modified_at);
  return {
    table,
    id: trimToken(value.id),
    version: trimToken(value.version),
    user_id: trimToken(value.user_id),
    state_code: normalizeStateCode(value.state_code),
    modified_at: modifiedAt,
  };
}

function buildTableFilterUrl(options: {
  restBaseUrl: string;
  table: DatasetMaintenanceClearAccountTable;
  userId: string;
  stateCodes: number[] | null;
}): URL {
  const url = new URL(`${options.restBaseUrl}/${options.table}`);
  url.searchParams.set('select', 'id,version,user_id,state_code,modified_at');
  url.searchParams.set('user_id', `eq.${options.userId}`);
  if (options.stateCodes) {
    url.searchParams.set('state_code', `in.(${options.stateCodes.join(',')})`);
  }
  return url;
}

async function fetchJson(options: {
  url: string;
  init: RequestInit;
  fetchImpl: FetchLike;
  timeoutMs: number;
  label: string;
}): Promise<{ body: unknown; headers: ResponseLike['headers'] }> {
  const response = await options.fetchImpl(options.url, {
    ...options.init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const rawText = await response.text();

  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned from ${options.label}`, {
      code: 'DATASET_MAINTENANCE_REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: {
        url: options.url,
        body: rawText,
      },
    });
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    return { body: null, headers: response.headers };
  }

  try {
    return { body: JSON.parse(trimmed), headers: response.headers };
  } catch (error) {
    throw new CliError(`Remote response was not valid JSON for ${options.label}`, {
      code: 'DATASET_MAINTENANCE_REMOTE_INVALID_JSON',
      exitCode: 1,
      details: {
        url: options.url,
        error: String(error),
      },
    });
  }
}

async function fetchCurrentUser(options: {
  projectBaseUrl: string;
  publishableKey: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{ id: string; email: string | null }> {
  const url = `${options.projectBaseUrl}/auth/v1/user`;
  const response = await fetchJson({
    url,
    init: {
      method: 'GET',
      headers: buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
    },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    label: 'supabase current-user lookup',
  });

  const body = isRecord(response.body) ? response.body : {};
  const id = trimToken(body.id);
  if (!id) {
    throw new CliError('Supabase current-user lookup succeeded without a user id.', {
      code: 'DATASET_MAINTENANCE_CURRENT_USER_ID_MISSING',
      exitCode: 1,
    });
  }

  return {
    id,
    email: trimToken(body.email),
  };
}

async function fetchTableRows(options: {
  restBaseUrl: string;
  table: DatasetMaintenanceClearAccountTable;
  userId: string;
  stateCodes: number[] | null;
  pageSize: number;
  publishableKey: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{
  rows: DatasetMaintenanceClearAccountRow[];
  sourceUrls: string[];
  completeness: DatasetMaintenanceTableCompleteness;
}> {
  const result = await fetchCompletePostgrestPages({
    table: options.table,
    requestedPageSize: options.pageSize,
    rowIdentity: (row: DatasetMaintenanceClearAccountRow) => `${row.id!}\u0000${row.version!}`,
    fetchPage: async (offset) => {
      const capability = resolveDataApiCapability({
        kind: 'relation',
        name: options.table,
      });
      const url = buildTableFilterUrl(options);
      url.searchParams.set('order', 'id.asc,version.asc');
      url.searchParams.set('limit', String(options.pageSize));
      url.searchParams.set('offset', String(offset));

      const sourceUrl = url.toString();
      const response = await fetchJson({
        url: sourceUrl,
        init: {
          method: 'GET',
          headers: applyDataApiProfileHeaders(
            {
              ...buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
              Prefer: 'count=exact',
            },
            capability,
          ),
        },
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        label: `${options.table} RLS visible snapshot`,
      });

      if (!Array.isArray(response.body)) {
        throw new CliError(`Remote ${options.table} snapshot response was not an array.`, {
          code: 'DATASET_MAINTENANCE_SNAPSHOT_INVALID',
          exitCode: 1,
          details: response.body,
        });
      }

      const pageRows = response.body.map((row) => normalizeRow(options.table, row));
      if (
        pageRows.some(
          (row) => row === null || !row.id || !row.version || row.user_id !== options.userId,
        )
      ) {
        throw new CliError(`Remote ${options.table} snapshot contained an invalid account row.`, {
          code: 'DATASET_MAINTENANCE_SNAPSHOT_INVALID',
          exitCode: 1,
        });
      }
      return {
        rows: pageRows as DatasetMaintenanceClearAccountRow[],
        source_url: sourceUrl,
        content_range: response.headers.get('content-range'),
      };
    },
  });
  return { rows: result.rows, sourceUrls: result.source_urls, completeness: result.completeness };
}

async function fetchAccountSnapshot(
  options: Omit<Parameters<typeof fetchTableRows>[0], 'table'>,
): Promise<{
  tables: Array<{
    table: DatasetMaintenanceClearAccountTable;
    rows: DatasetMaintenanceClearAccountRow[];
    sourceUrls: string[];
    completeness: DatasetMaintenanceTableCompleteness;
  }>;
  rows: DatasetMaintenanceClearAccountRow[];
  completeness: DatasetMaintenanceSnapshotCompleteness<DatasetMaintenanceClearAccountTable>;
}> {
  const tables = await Promise.all(
    CLEAR_ACCOUNT_TABLES.map(async (table) => ({
      table,
      ...(await fetchTableRows({ ...options, table })),
    })),
  );
  return {
    tables,
    rows: tables.flatMap((table) => table.rows),
    completeness: buildSnapshotCompleteness({
      tables: CLEAR_ACCOUNT_TABLES,
      requestedPageSize: options.pageSize,
      results: tables,
    }),
  };
}

async function deleteTableRows(options: {
  transport: DatasetCommandTransport;
  table: DatasetMaintenanceClearAccountTable;
  rows: DatasetMaintenanceClearAccountRow[];
}): Promise<{
  deletedRows: DatasetMaintenanceClearAccountRow[];
  deleteUrl: string;
  failures: Array<{ row: DatasetMaintenanceClearAccountRow; error: string }>;
}> {
  const deleteUrl = `${options.transport.functionsBaseUrl}/app_dataset_delete`;
  const deletedRows: DatasetMaintenanceClearAccountRow[] = [];
  const failures: Array<{ row: DatasetMaintenanceClearAccountRow; error: string }> = [];

  for (const row of options.rows) {
    if (!row.id || !row.version) {
      failures.push({
        row,
        error: 'Row is missing id or version and cannot be deleted through app_dataset_delete.',
      });
      continue;
    }

    if (row.state_code !== 0) {
      failures.push({
        row,
        error: `Protected non-draft row state_code=${String(
          row.state_code,
        )}; cmd_dataset_delete only deletes draft rows.`,
      });
      continue;
    }

    try {
      await deleteDatasetRecord({
        transport: options.transport,
        table: options.table,
        id: row.id,
        version: row.version,
      });
      deletedRows.push(row);
    } catch (error) {
      failures.push({
        row,
        error: caughtErrorMessage(error),
      });
    }
  }

  return { deletedRows, deleteUrl, failures };
}

function buildSummary(
  tables: DatasetMaintenanceClearAccountTableReport[],
  additionalFailures = 0,
): DatasetMaintenanceClearAccountReport['summary'] {
  const byTable = Object.fromEntries(
    CLEAR_ACCOUNT_TABLES.map((table) => {
      const report = tables.find((entry) => entry.table === table);
      return [
        table,
        {
          candidates: report?.candidates ?? 0,
          deleted: report?.deleted ?? 0,
          remaining: report?.remaining ?? null,
          status: report?.status ?? 'skipped_after_failure',
        },
      ];
    }),
  ) as DatasetMaintenanceClearAccountReport['summary']['by_table'];

  return {
    total_candidates: tables.reduce((sum, table) => sum + table.candidates, 0),
    total_deleted: tables.reduce((sum, table) => sum + table.deleted, 0),
    total_remaining: tables.reduce((sum, table) => sum + (table.remaining ?? 0), 0),
    total_failures: tables.filter((table) => table.status === 'failed').length + additionalFailures,
    by_table: byTable,
  };
}

export async function runDatasetMaintenanceClearAccount(
  options: RunDatasetMaintenanceClearAccountOptions,
): Promise<DatasetMaintenanceClearAccountReport> {
  const now = options.now ?? new Date();
  const generatedAtUtc = now.toISOString();
  const pageSize = normalizePageSize(options.pageSize);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const stateCodes = normalizeStateCodes(options.stateCodes);
  const commit = Boolean(options.commit);
  const outDir = path.resolve(options.outDir ?? 'dataset-maintenance/clear-account');
  const runtime = requireSupabaseRestRuntime(options.env);
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
  const restBaseUrl = deriveSupabaseRestBaseUrl(projectBaseUrl);
  const functionsBaseUrl = deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl);
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs,
    now,
  });
  const currentUser = await fetchCurrentUser({
    projectBaseUrl,
    publishableKey: runtime.publishableKey,
    accessToken: session.accessToken,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  const accountEmail = currentUser.email ?? session.userEmail;
  const commandTransport: DatasetCommandTransport = {
    functionsBaseUrl,
    publishableKey: runtime.publishableKey,
    accessToken: session.accessToken,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  };

  if (commit && normalizeEmail(options.confirm) !== normalizeEmail(accountEmail)) {
    throw new CliError(
      '--commit requires --confirm to exactly match the current authenticated account email.',
      {
        code: 'DATASET_MAINTENANCE_CONFIRMATION_REQUIRED',
        exitCode: 2,
        details: {
          expected_email: accountEmail,
          received_email: options.confirm ?? null,
        },
      },
    );
  }

  const initialSnapshot = await fetchAccountSnapshot({
    restBaseUrl,
    userId: currentUser.id,
    stateCodes,
    pageSize,
    publishableKey: runtime.publishableKey,
    accessToken: session.accessToken,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  const snapshotTables = initialSnapshot.tables;
  const snapshotRows = initialSnapshot.rows;
  const snapshotCompleteness = initialSnapshot.completeness;
  const artifacts: DatasetMaintenanceClearAccountReport['artifacts'] = {
    rls_visible_snapshot: path.join(outDir, 'rls-visible-snapshot.json'),
    dry_run_report: path.join(outDir, 'dry-run-report.json'),
    approval_record: commit ? path.join(outDir, 'approval-record.json') : null,
    commit_report: commit ? path.join(outDir, 'commit-report.json') : null,
    readback_verify_report: commit ? path.join(outDir, 'readback-verify-report.json') : null,
  };

  writeJsonArtifact(artifacts.rls_visible_snapshot, {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    account: {
      email: accountEmail,
      user_id: currentUser.id,
      session_source: session.source,
    },
    filters: {
      tables: CLEAR_ACCOUNT_TABLES,
      state_codes: stateCodes,
      page_size: pageSize,
    },
    completeness: snapshotCompleteness,
    row_count: snapshotRows.length,
    rows: snapshotRows,
  });

  const tableReports: DatasetMaintenanceClearAccountTableReport[] = [];
  let blockedByFailure = false;

  for (const table of CLEAR_ACCOUNT_TABLES) {
    const snapshot = snapshotTables.find((entry) => entry.table === table)!;

    if (!commit) {
      tableReports.push({
        table,
        status: 'dry_run',
        candidates: snapshot.rows.length,
        deleted: 0,
        remaining: null,
        source_urls: snapshot.sourceUrls,
        delete_url: null,
        error: null,
      });
      continue;
    }

    if (blockedByFailure) {
      tableReports.push({
        table,
        status: 'skipped_after_failure',
        candidates: snapshot.rows.length,
        deleted: 0,
        remaining: snapshot.rows.length,
        source_urls: snapshot.sourceUrls,
        delete_url: null,
        error: 'Skipped because an earlier table delete or readback verification failed.',
      });
      continue;
    }

    if (snapshot.rows.length === 0) {
      tableReports.push({
        table,
        status: 'skipped_empty',
        candidates: 0,
        deleted: 0,
        remaining: 0,
        source_urls: snapshot.sourceUrls,
        delete_url: null,
        error: null,
      });
      continue;
    }

    try {
      const deleteResult = await deleteTableRows({
        transport: commandTransport,
        table,
        rows: snapshot.rows,
      });
      const readback = await fetchTableRows({
        restBaseUrl,
        table,
        userId: currentUser.id,
        stateCodes,
        pageSize,
        publishableKey: runtime.publishableKey,
        accessToken: session.accessToken,
        fetchImpl: options.fetchImpl,
        timeoutMs,
      });
      const remaining = readback.rows.length;
      const failed = remaining > 0 || deleteResult.failures.length > 0;
      blockedByFailure = failed;
      const failureDetails = deleteResult.failures
        .slice(0, 5)
        .map(
          (failure) =>
            `${failure.row.table}:${failure.row.id!}@${failure.row.version!} ${failure.error}`,
        );

      tableReports.push({
        table,
        status: failed ? 'failed' : 'deleted',
        candidates: snapshot.rows.length,
        deleted: Math.max(snapshot.rows.length - remaining, deleteResult.deletedRows.length),
        remaining,
        source_urls: [...snapshot.sourceUrls, ...readback.sourceUrls],
        delete_url: deleteResult.deleteUrl,
        error: failed
          ? [
              deleteResult.failures.length > 0
                ? `${deleteResult.failures.length} row delete request(s) failed.`
                : null,
              remaining > 0 ? `${remaining} row(s) remained after delete readback.` : null,
              ...failureDetails,
            ]
              .filter((message): message is string => typeof message === 'string')
              .join(' ')
          : null,
      });
    } catch (error) {
      blockedByFailure = true;
      tableReports.push({
        table,
        status: 'failed',
        candidates: snapshot.rows.length,
        deleted: 0,
        remaining: snapshot.rows.length,
        source_urls: snapshot.sourceUrls,
        delete_url: null,
        error: caughtErrorMessage(error),
      });
    }
  }

  let readbackCompleteness: DatasetMaintenanceClearAccountReport['readback_completeness'] = null;
  let readbackError: string | null = null;
  if (commit) {
    try {
      const finalReadback = await fetchAccountSnapshot({
        restBaseUrl,
        userId: currentUser.id,
        stateCodes,
        pageSize,
        publishableKey: runtime.publishableKey,
        accessToken: session.accessToken,
        fetchImpl: options.fetchImpl,
        timeoutMs,
      });
      readbackCompleteness = finalReadback.completeness;
      for (const table of CLEAR_ACCOUNT_TABLES) {
        const tableReadback = finalReadback.tables.find((entry) => entry.table === table)!;
        const tableReport = tableReports.find((entry) => entry.table === table)!;
        tableReport.remaining = tableReadback.rows.length;
        tableReport.source_urls.push(...tableReadback.sourceUrls);
        if (tableReadback.rows.length > 0) {
          const message = `${tableReadback.rows.length} row(s) remained in the final all-table readback.`;
          tableReport.status = 'failed';
          tableReport.error = [tableReport.error, message].filter(Boolean).join(' ');
        }
      }
    } catch (error) {
      readbackError = `Final all-table readback could not prove account state: ${caughtErrorMessage(
        error,
      )}`;
    }
  }

  const summary = buildSummary(tableReports, readbackError ? 1 : 0);
  const finalReadbackPassed = readbackCompleteness !== null && readbackCompleteness.row_count === 0;
  const report: DatasetMaintenanceClearAccountReport = {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    status: commit
      ? summary.total_failures === 0 && summary.total_remaining === 0 && finalReadbackPassed
        ? 'cleared_account'
        : 'completed_with_failures'
      : 'planned_account_clear',
    mode: commit ? 'commit' : 'dry-run',
    account: {
      email: accountEmail,
      user_id: currentUser.id,
      session_source: session.source,
    },
    filters: {
      tables: CLEAR_ACCOUNT_TABLES,
      state_codes: stateCodes,
      page_size: pageSize,
    },
    snapshot_completeness: snapshotCompleteness,
    readback_completeness: readbackCompleteness,
    readback_error: readbackError,
    summary,
    tables: tableReports,
    artifacts,
  };

  writeJsonArtifact(artifacts.dry_run_report, {
    ...report,
    mode: 'dry-run',
    status: 'planned_account_clear',
  });

  if (
    commit &&
    artifacts.approval_record &&
    artifacts.commit_report &&
    artifacts.readback_verify_report
  ) {
    writeJsonArtifact(artifacts.approval_record, {
      schema_version: 1,
      approved_at_utc: generatedAtUtc,
      operation: 'clear-account',
      account: report.account,
      confirmed_email: options.confirm,
      filters: report.filters,
      candidate_count: summary.total_candidates,
      snapshot_completeness: snapshotCompleteness,
    });
    writeJsonArtifact(artifacts.commit_report, report);
    writeJsonArtifact(artifacts.readback_verify_report, {
      schema_version: 1,
      generated_at_utc: generatedAtUtc,
      status: report.status,
      initial_snapshot_completeness: snapshotCompleteness,
      readback_completeness: readbackCompleteness,
      readback_error: readbackError,
      tables: tableReports.map((table) => ({
        table: table.table,
        candidates: table.candidates,
        deleted: table.deleted,
        remaining: table.remaining,
        status: table.status,
        error: table.error,
      })),
    });
  }

  return report;
}

export const __testInternals = {
  buildSummary,
  buildTableFilterUrl,
  caughtErrorMessage,
  deleteTableRows,
  fetchAccountSnapshot,
  fetchCurrentUser,
  fetchJson,
  fetchTableRows,
  normalizeEmail,
  normalizePageSize,
  normalizeRow,
  normalizeStateCode,
  normalizeStateCodes,
  normalizeTimeoutMs,
};
