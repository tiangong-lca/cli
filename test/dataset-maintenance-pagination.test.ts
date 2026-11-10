import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSnapshotCompleteness,
  fetchCompletePostgrestPages,
  isDatasetMaintenanceSnapshotCompleteness,
  isSnapshotCompletenessCompatible,
  parseExactContentRange,
  type DatasetMaintenancePage,
  type DatasetMaintenanceTableCompleteness,
} from '../src/lib/maintenance/pagination.js';

type Row = { id: string; version: string };

function row(index: number): Row {
  return { id: `row-${String(index).padStart(5, '0')}`, version: '00.00.001' };
}

function identity(value: Row): string {
  return `${value.id}\u0000${value.version}`;
}

function completeness(rows: number): DatasetMaintenanceTableCompleteness {
  return {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count',
    requested_page_size: 5_000,
    effective_page_size: rows,
    pages_fetched: 1,
    rows_fetched: rows,
    exact_total: rows,
    termination_reason: 'content_range_total_reached',
    content_range_verified: true,
    ordering_verified: true,
    duplicate_count: 0,
  };
}

test('exact-count paginator follows a server cap using actual returned offsets', async () => {
  const allRows = Array.from({ length: 2_501 }, (_, index) => row(index));
  const offsets: number[] = [];
  const preferCountExact: boolean[] = [];
  const result = await fetchCompletePostgrestPages({
    table: 'processes',
    requestedPageSize: 5_000,
    rowIdentity: identity,
    fetchPage: async (offset): Promise<DatasetMaintenancePage<Row>> => {
      offsets.push(offset);
      preferCountExact.push(true);
      const page = allRows.slice(offset, offset + 1_000);
      return {
        rows: page,
        source_url: `https://example.test/processes?offset=${offset}`,
        content_range: `${offset}-${offset + page.length - 1}/${allRows.length}`,
      };
    },
  });

  assert.deepEqual(offsets, [0, 1_000, 2_000]);
  assert.deepEqual(preferCountExact, [true, true, true]);
  assert.equal(result.rows.length, 2_501);
  assert.deepEqual(result.completeness, {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count',
    requested_page_size: 5_000,
    effective_page_size: 1_000,
    pages_fetched: 3,
    rows_fetched: 2_501,
    exact_total: 2_501,
    termination_reason: 'content_range_total_reached',
    content_range_verified: true,
    ordering_verified: true,
    duplicate_count: 0,
  });
});

test('exact-count paginator stops at an exact multiple and accepts an empty exact result', async () => {
  const allRows = Array.from({ length: 2_000 }, (_, index) => row(index));
  const offsets: number[] = [];
  const exactMultiple = await fetchCompletePostgrestPages({
    table: 'flows',
    requestedPageSize: 5_000,
    rowIdentity: identity,
    fetchPage: async (offset) => {
      offsets.push(offset);
      const page = allRows.slice(offset, offset + 1_000);
      return {
        rows: page,
        source_url: `https://example.test/flows?offset=${offset}`,
        content_range: `${offset}-${offset + page.length - 1}/${allRows.length}`,
      };
    },
  });
  assert.deepEqual(offsets, [0, 1_000]);
  assert.equal(exactMultiple.completeness.pages_fetched, 2);

  const empty = await fetchCompletePostgrestPages({
    table: 'contacts',
    requestedPageSize: 5_000,
    rowIdentity: identity,
    fetchPage: async () => ({
      rows: [],
      source_url: 'https://example.test/contacts?offset=0',
      content_range: '*/0',
    }),
  });
  assert.equal(empty.completeness.rows_fetched, 0);
  assert.equal(empty.completeness.effective_page_size, 0);
  assert.equal(empty.completeness.pages_fetched, 1);
});

test('exact-count parser accepts the PostgREST forms and rejects unprovable ranges', () => {
  assert.deepEqual(parseExactContentRange('items 0-9/10'), { start: 0, end: 9, total: 10 });
  assert.deepEqual(parseExactContentRange('*/0'), { start: null, end: null, total: 0 });
  assert.throws(() => parseExactContentRange(null), /complete maintenance snapshot/u);
  assert.throws(() => parseExactContentRange('0-0/*'), /complete maintenance snapshot/u);
  assert.throws(() => parseExactContentRange('5-4/10'), /complete maintenance snapshot/u);
  assert.throws(
    () => parseExactContentRange('0-999999999999999999999/999999999999999999999'),
    /complete maintenance snapshot/u,
  );
});

test('exact-count paginator rejects totals, ranges, and identities that cannot prove completeness', async () => {
  const scenarios: Array<{
    name: string;
    requestedPageSize?: number;
    rowIdentity?: (value: Row) => string | null;
    pages: Array<DatasetMaintenancePage<Row>>;
  }> = [
    {
      name: 'missing content range',
      pages: [{ rows: [row(0)], source_url: 'missing', content_range: null }],
    },
    {
      name: 'total changes',
      pages: [
        { rows: [row(0)], source_url: 'changed-0', content_range: '0-0/2' },
        { rows: [row(1)], source_url: 'changed-1', content_range: '1-1/3' },
      ],
    },
    {
      name: 'empty before total',
      pages: [{ rows: [], source_url: 'early-empty', content_range: '*/2' }],
    },
    {
      name: 'range does not match offset',
      pages: [{ rows: [row(0)], source_url: 'range-offset', content_range: '1-1/1' }],
    },
    {
      name: 'server exceeds requested page size',
      requestedPageSize: 1,
      pages: [{ rows: [row(0), row(1)], source_url: 'too-large', content_range: '0-1/2' }],
    },
    {
      name: 'rows exceed exact total',
      pages: [{ rows: [row(0), row(1)], source_url: 'over-total', content_range: '0-1/1' }],
    },
    {
      name: 'duplicate identity',
      pages: [{ rows: [row(0), row(0)], source_url: 'duplicate', content_range: '0-1/2' }],
    },
    {
      name: 'non-strict order',
      pages: [{ rows: [row(1), row(0)], source_url: 'unordered', content_range: '0-1/2' }],
    },
    {
      name: 'missing identity',
      rowIdentity: () => null,
      pages: [{ rows: [row(0)], source_url: 'identity', content_range: '0-0/1' }],
    },
  ];

  for (const scenario of scenarios) {
    let index = 0;
    await assert.rejects(
      () =>
        fetchCompletePostgrestPages({
          table: 'flows',
          requestedPageSize: scenario.requestedPageSize ?? 5_000,
          rowIdentity: scenario.rowIdentity ?? identity,
          fetchPage: async () => scenario.pages[index++]!,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
      scenario.name,
    );
  }
});

test('snapshot completeness aggregates exact per-entity counts and rejects a partial table set', () => {
  const aggregate = buildSnapshotCompleteness({
    tables: ['flows', 'sources'] as const,
    requestedPageSize: 5_000,
    results: [
      { table: 'flows', completeness: completeness(2) },
      { table: 'sources', completeness: completeness(1) },
    ],
  });
  assert.equal(aggregate.row_count, 3);
  assert.equal(aggregate.page_count, 2);
  assert.deepEqual(aggregate.entity_counts, { flows: 2, sources: 1 });
  assert.throws(
    () =>
      buildSnapshotCompleteness({
        tables: ['flows', 'sources'] as const,
        requestedPageSize: 5_000,
        results: [{ table: 'flows', completeness: completeness(2) }],
      }),
    /complete maintenance snapshot/u,
  );
});

test('snapshot completeness validator rejects malformed, partial, and internally inconsistent proofs', () => {
  const expectedTables = ['flows', 'sources'] as const;
  const base = buildSnapshotCompleteness({
    tables: expectedTables,
    requestedPageSize: 5_000,
    results: [
      { table: 'flows', completeness: completeness(2) },
      { table: 'sources', completeness: completeness(0) },
    ],
  });
  assert.equal(isDatasetMaintenanceSnapshotCompleteness(base, expectedTables), true);
  assert.equal(isDatasetMaintenanceSnapshotCompleteness(null, expectedTables), false);

  const counts = (proof: Record<string, unknown>): Record<string, unknown> =>
    proof.entity_counts as Record<string, unknown>;
  const tables = (proof: Record<string, unknown>): Array<Record<string, unknown>> =>
    proof.tables as Array<Record<string, unknown>>;

  const invalidMutations: Array<{
    name: string;
    mutate: (proof: Record<string, unknown>) => void;
  }> = [
    { name: 'status', mutate: (proof) => (proof.status = 'partial') },
    { name: 'complete', mutate: (proof) => (proof.complete = false) },
    { name: 'aggregate strategy', mutate: (proof) => (proof.strategy = 'other') },
    { name: 'requested page size', mutate: (proof) => (proof.requested_page_size = 0) },
    { name: 'aggregate page count', mutate: (proof) => (proof.page_count = 1) },
    { name: 'aggregate row count', mutate: (proof) => (proof.row_count = -1) },
    { name: 'entity counts object', mutate: (proof) => (proof.entity_counts = []) },
    {
      name: 'extra entity count',
      mutate: (proof) => (counts(proof).contacts = 0),
    },
    { name: 'invalid entity count', mutate: (proof) => (counts(proof).flows = '2') },
    { name: 'tables array', mutate: (proof) => (proof.tables = {}) },
    { name: 'table count', mutate: (proof) => void tables(proof).pop() },
    { name: 'table object', mutate: (proof) => (proof.tables = [null, ...tables(proof).slice(1)]) },
    { name: 'table name type', mutate: (proof) => (tables(proof)[0]!.table = 1) },
    { name: 'unknown table', mutate: (proof) => (tables(proof)[0]!.table = 'contacts') },
    { name: 'duplicate table', mutate: (proof) => (tables(proof)[1]!.table = 'flows') },
    { name: 'table status', mutate: (proof) => (tables(proof)[0]!.status = 'partial') },
    { name: 'table complete', mutate: (proof) => (tables(proof)[0]!.complete = false) },
    { name: 'table strategy', mutate: (proof) => (tables(proof)[0]!.strategy = 'other') },
    {
      name: 'table requested page size',
      mutate: (proof) => (tables(proof)[0]!.requested_page_size = 1_000),
    },
    {
      name: 'effective page size',
      mutate: (proof) => (tables(proof)[0]!.effective_page_size = 5_001),
    },
    { name: 'pages fetched', mutate: (proof) => (tables(proof)[0]!.pages_fetched = 0) },
    { name: 'rows fetched', mutate: (proof) => (tables(proof)[0]!.rows_fetched = -1) },
    { name: 'exact total', mutate: (proof) => (tables(proof)[0]!.exact_total = 1) },
    {
      name: 'non-empty effective size',
      mutate: (proof) => (tables(proof)[0]!.effective_page_size = 0),
    },
    {
      name: 'empty effective size',
      mutate: (proof) => (tables(proof)[1]!.effective_page_size = 1),
    },
    {
      name: 'empty result extra pages',
      mutate: (proof) => {
        tables(proof)[1]!.pages_fetched = 2;
        proof.page_count = 3;
      },
    },
    {
      name: 'more pages than rows',
      mutate: (proof) => {
        tables(proof)[0]!.pages_fetched = 3;
        proof.page_count = 4;
      },
    },
    {
      name: 'effective page cannot fit remaining pages',
      mutate: (proof) => {
        tables(proof)[0]!.pages_fetched = 2;
        proof.page_count = 3;
      },
    },
    {
      name: 'effective page capacity below row count',
      mutate: (proof) => (tables(proof)[0]!.effective_page_size = 1),
    },
    {
      name: 'termination reason',
      mutate: (proof) => (tables(proof)[0]!.termination_reason = 'short_page'),
    },
    {
      name: 'content range flag',
      mutate: (proof) => (tables(proof)[0]!.content_range_verified = false),
    },
    {
      name: 'ordering flag',
      mutate: (proof) => (tables(proof)[0]!.ordering_verified = false),
    },
    { name: 'duplicate count', mutate: (proof) => (tables(proof)[0]!.duplicate_count = 1) },
    {
      name: 'entity/table mismatch',
      mutate: (proof) => {
        counts(proof).flows = 1;
        proof.row_count = 1;
      },
    },
    { name: 'page sum', mutate: (proof) => (proof.page_count = 3) },
    { name: 'row sum', mutate: (proof) => (proof.row_count = 3) },
  ];

  for (const scenario of invalidMutations) {
    const proof = structuredClone(base) as unknown as Record<string, unknown>;
    scenario.mutate(proof);
    assert.equal(
      isDatasetMaintenanceSnapshotCompleteness(proof, expectedTables),
      false,
      scenario.name,
    );
  }

  assert.equal(isSnapshotCompletenessCompatible(undefined, undefined, expectedTables), true);
  assert.equal(isSnapshotCompletenessCompatible(undefined, base, expectedTables), false);
  assert.equal(isSnapshotCompletenessCompatible(null, base, expectedTables), false);
  assert.equal(isSnapshotCompletenessCompatible(base, undefined, expectedTables), true);
  assert.equal(isSnapshotCompletenessCompatible(base, base, expectedTables), true);
  const changedCounts = structuredClone(base);
  changedCounts.entity_counts.flows += 1;
  changedCounts.row_count += 1;
  assert.equal(isSnapshotCompletenessCompatible(changedCounts, base, expectedTables), false);
});
