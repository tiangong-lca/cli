import { CliError } from '../shared/errors.js';

export type DatasetMaintenanceTableCompleteness = {
  status: 'complete';
  complete: true;
  strategy: 'postgrest_exact_count';
  requested_page_size: number;
  effective_page_size: number;
  pages_fetched: number;
  rows_fetched: number;
  exact_total: number;
  termination_reason: 'content_range_total_reached';
  content_range_verified: true;
  ordering_verified: true;
  duplicate_count: 0;
};

export type DatasetMaintenanceSnapshotCompleteness<Table extends string = string> = {
  status: 'complete';
  complete: true;
  strategy: 'postgrest_exact_count_multi_request';
  requested_page_size: number;
  page_count: number;
  row_count: number;
  entity_counts: Record<Table, number>;
  tables: Array<{ table: Table } & DatasetMaintenanceTableCompleteness>;
};

export type DatasetMaintenancePage<T> = {
  rows: T[];
  source_url: string;
  content_range: string | null;
};

type ParsedContentRange = {
  start: number | null;
  end: number | null;
  total: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function isDatasetMaintenanceSnapshotCompleteness<Table extends string>(
  value: unknown,
  expectedTables: readonly Table[],
): value is DatasetMaintenanceSnapshotCompleteness<Table> {
  if (!isRecord(value)) return false;
  if (
    value.status !== 'complete' ||
    value.complete !== true ||
    value.strategy !== 'postgrest_exact_count_multi_request' ||
    !isIntegerBetween(value.requested_page_size, 1, 5_000) ||
    !isIntegerBetween(value.page_count, expectedTables.length, Number.MAX_SAFE_INTEGER) ||
    !isIntegerBetween(value.row_count, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }

  const entityCounts = value.entity_counts;
  if (!isRecord(entityCounts)) return false;
  const expectedTableSet = new Set<string>(expectedTables);
  const entityCountKeys = Object.keys(entityCounts);
  if (
    entityCountKeys.length !== expectedTables.length ||
    entityCountKeys.some((table) => !expectedTableSet.has(table))
  ) {
    return false;
  }
  for (const table of expectedTables) {
    if (!isIntegerBetween(entityCounts[table], 0, Number.MAX_SAFE_INTEGER)) {
      return false;
    }
  }

  if (!Array.isArray(value.tables) || value.tables.length !== expectedTables.length) return false;
  const observedTables = new Set<string>();
  let pageCount = 0;
  let rowCount = 0;
  for (const rawTable of value.tables) {
    if (!isRecord(rawTable)) return false;
    const table = rawTable.table;
    if (typeof table !== 'string' || !expectedTableSet.has(table) || observedTables.has(table)) {
      return false;
    }
    if (
      rawTable.status !== 'complete' ||
      rawTable.complete !== true ||
      rawTable.strategy !== 'postgrest_exact_count' ||
      rawTable.requested_page_size !== value.requested_page_size ||
      !isIntegerBetween(rawTable.effective_page_size, 0, value.requested_page_size) ||
      !isIntegerBetween(rawTable.pages_fetched, 1, Number.MAX_SAFE_INTEGER) ||
      !isIntegerBetween(rawTable.rows_fetched, 0, Number.MAX_SAFE_INTEGER) ||
      rawTable.exact_total !== rawTable.rows_fetched ||
      (rawTable.rows_fetched === 0) !== (rawTable.effective_page_size === 0) ||
      (rawTable.rows_fetched === 0
        ? rawTable.pages_fetched !== 1
        : rawTable.pages_fetched > rawTable.rows_fetched ||
          rawTable.effective_page_size > rawTable.rows_fetched - rawTable.pages_fetched + 1 ||
          rawTable.rows_fetched > rawTable.pages_fetched * rawTable.effective_page_size) ||
      rawTable.termination_reason !== 'content_range_total_reached' ||
      rawTable.content_range_verified !== true ||
      rawTable.ordering_verified !== true ||
      rawTable.duplicate_count !== 0 ||
      rawTable.rows_fetched !== entityCounts[table]
    ) {
      return false;
    }
    observedTables.add(table);
    pageCount += rawTable.pages_fetched;
    rowCount += rawTable.rows_fetched;
  }

  return pageCount === value.page_count && rowCount === value.row_count;
}

export function isSnapshotCompletenessCompatible<Table extends string>(
  value: unknown,
  baseline: DatasetMaintenanceSnapshotCompleteness<Table> | undefined,
  expectedTables: readonly Table[],
): boolean {
  if (value === undefined) return baseline === undefined;
  if (!isDatasetMaintenanceSnapshotCompleteness(value, expectedTables)) return false;
  if (baseline === undefined) return true;
  return (
    value.row_count === baseline.row_count &&
    expectedTables.every((table) => value.entity_counts[table] === baseline.entity_counts[table])
  );
}

function incomplete(details: Record<string, unknown>): never {
  throw new CliError('PostgREST pagination could not prove a complete maintenance snapshot.', {
    code: 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE',
    exitCode: 1,
    details,
  });
}

export function parseExactContentRange(
  value: string | null,
  details: Record<string, unknown> = {},
): ParsedContentRange {
  const match = value?.trim().match(/^(?:items\s+)?(?:(\d+)-(\d+)|\*)\/(\d+)$/iu);
  if (!match) {
    return incomplete({
      ...details,
      reason: 'content_range_missing_or_invalid',
      content_range: value,
    });
  }
  const start = match[1] === undefined ? null : Number.parseInt(match[1], 10);
  const end = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  const total = Number.parseInt(match[3]!, 10);
  if (
    !Number.isSafeInteger(total) ||
    (start !== null &&
      (end === null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end))) ||
    (start !== null && end! < start)
  ) {
    return incomplete({ ...details, reason: 'content_range_out_of_bounds', content_range: value });
  }
  return { start, end, total };
}

export async function fetchCompletePostgrestPages<T>(options: {
  table: string;
  requestedPageSize: number;
  fetchPage: (offset: number) => Promise<DatasetMaintenancePage<T>>;
  rowIdentity: (row: T) => string | null;
}): Promise<{
  rows: T[];
  source_urls: string[];
  completeness: DatasetMaintenanceTableCompleteness;
}> {
  const rows: T[] = [];
  const sourceUrls: string[] = [];
  let expectedTotal: number | null = null;
  let offset = 0;
  let pagesFetched = 0;
  let effectivePageSize = 0;
  let previousIdentity: string | null = null;

  while (true) {
    const page = await options.fetchPage(offset);
    pagesFetched += 1;
    sourceUrls.push(page.source_url);
    effectivePageSize = Math.max(effectivePageSize, page.rows.length);
    const range = parseExactContentRange(page.content_range, {
      table: options.table,
      offset,
      source_url: page.source_url,
    });
    if (expectedTotal === null) {
      expectedTotal = range.total;
    } else if (range.total !== expectedTotal) {
      return incomplete({
        table: options.table,
        offset,
        source_url: page.source_url,
        reason: 'exact_total_changed_between_pages',
        expected_total: expectedTotal,
        observed_total: range.total,
      });
    }

    if (page.rows.length === 0) {
      if (range.start !== null || offset !== 0 || range.total !== 0) {
        return incomplete({
          table: options.table,
          offset,
          source_url: page.source_url,
          reason: 'empty_page_before_exact_total',
          expected_total: expectedTotal,
          content_range: page.content_range,
        });
      }
      return {
        rows,
        source_urls: sourceUrls,
        completeness: {
          status: 'complete',
          complete: true,
          strategy: 'postgrest_exact_count',
          requested_page_size: options.requestedPageSize,
          effective_page_size: effectivePageSize,
          pages_fetched: pagesFetched,
          rows_fetched: 0,
          exact_total: 0,
          termination_reason: 'content_range_total_reached',
          content_range_verified: true,
          ordering_verified: true,
          duplicate_count: 0,
        },
      };
    }

    if (
      page.rows.length > options.requestedPageSize ||
      range.start !== offset ||
      range.end !== offset + page.rows.length - 1
    ) {
      return incomplete({
        table: options.table,
        offset,
        source_url: page.source_url,
        reason: 'content_range_does_not_match_page',
        requested_page_size: options.requestedPageSize,
        returned_rows: page.rows.length,
        content_range: page.content_range,
      });
    }

    for (const row of page.rows) {
      const identity = options.rowIdentity(row);
      if (!identity) {
        return incomplete({
          table: options.table,
          offset,
          source_url: page.source_url,
          reason: 'row_identity_missing',
        });
      }
      if (previousIdentity !== null && identity <= previousIdentity) {
        return incomplete({
          table: options.table,
          offset,
          source_url: page.source_url,
          reason: identity === previousIdentity ? 'duplicate_row_identity' : 'row_order_not_strict',
          previous_identity: previousIdentity,
          observed_identity: identity,
        });
      }
      previousIdentity = identity;
    }

    rows.push(...page.rows);
    const nextOffset = offset + page.rows.length;
    if (nextOffset > expectedTotal) {
      return incomplete({
        table: options.table,
        offset,
        source_url: page.source_url,
        reason: 'rows_exceed_exact_total',
        expected_total: expectedTotal,
        rows_fetched: nextOffset,
      });
    }
    if (nextOffset === expectedTotal) {
      return {
        rows,
        source_urls: sourceUrls,
        completeness: {
          status: 'complete',
          complete: true,
          strategy: 'postgrest_exact_count',
          requested_page_size: options.requestedPageSize,
          effective_page_size: effectivePageSize,
          pages_fetched: pagesFetched,
          rows_fetched: rows.length,
          exact_total: expectedTotal,
          termination_reason: 'content_range_total_reached',
          content_range_verified: true,
          ordering_verified: true,
          duplicate_count: 0,
        },
      };
    }
    offset = nextOffset;
  }
}

export function buildSnapshotCompleteness<Table extends string>(options: {
  tables: readonly Table[];
  requestedPageSize: number;
  results: Array<{ table: Table; completeness: DatasetMaintenanceTableCompleteness }>;
}): DatasetMaintenanceSnapshotCompleteness<Table> {
  const expectedTables = new Set(options.tables);
  const observedTables = new Set(options.results.map((result) => result.table));
  if (
    options.results.length !== options.tables.length ||
    observedTables.size !== expectedTables.size ||
    [...observedTables].some((table) => !expectedTables.has(table))
  ) {
    return incomplete({
      reason: 'aggregate_table_set_invalid',
      expected_tables: [...options.tables],
      observed_tables: options.results.map((result) => result.table),
    });
  }
  const entityCounts = Object.fromEntries(
    options.tables.map((table) => [
      table,
      options.results.find((result) => result.table === table)!.completeness.rows_fetched,
    ]),
  ) as Record<Table, number>;
  return {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count_multi_request',
    requested_page_size: options.requestedPageSize,
    page_count: options.results.reduce((sum, result) => sum + result.completeness.pages_fetched, 0),
    row_count: options.results.reduce((sum, result) => sum + result.completeness.rows_fetched, 0),
    entity_counts: entityCounts,
    tables: options.results.map((result) => ({
      table: result.table,
      ...result.completeness,
    })),
  };
}
