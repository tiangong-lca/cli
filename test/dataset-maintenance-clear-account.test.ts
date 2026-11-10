import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FetchLike, ResponseLike } from '../src/lib/transport/http.js';
import type { DatasetCommandTransport } from '../src/lib/dataset/command.js';
import {
  __testInternals,
  runDatasetMaintenanceClearAccount,
} from '../src/lib/maintenance/clear-account.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ResponseLike {
  const defaultContentRange = Array.isArray(body)
    ? body.length > 0
      ? `0-${body.length - 1}/${body.length}`
      : '*/0'
    : null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const normalized = name.toLowerCase();
        if (normalized === 'content-type') return 'application/json';
        if (normalized === 'content-range') {
          return headers['content-range'] ?? defaultContentRange;
        }
        return headers[normalized] ?? null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    },
  };
}

function textResponse(body: string, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(): string | null {
        return 'text/plain';
      },
    },
    async text(): Promise<string> {
      return body;
    },
  };
}

function rowsForTable(table: string): unknown[] {
  if (table === 'processes') {
    return [
      {
        id: 'proc-1',
        version: '01.00.000',
        user_id: 'user-1',
        state_code: 0,
        modified_at: '2026-06-01T00:00:00.000Z',
      },
    ];
  }

  if (table === 'flows') {
    return [
      {
        id: 'flow-1',
        version: '01.00.000',
        user_id: 'user-1',
        state_code: 0,
        modified_at: '2026-06-01T00:00:00.000Z',
      },
    ];
  }

  return [];
}

test('runDatasetMaintenanceClearAccount writes a dry-run account snapshot', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-dry-run-'));
  const observedUrls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
    }
    observedUrls.push(url);
    if (url.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: 'user-1', email: 'user@example.com' });
    }
    const table = new URL(url).pathname.split('/').pop() ?? '';
    return jsonResponse(rowsForTable(table));
  };

  const report = await runDatasetMaintenanceClearAccount({
    outDir,
    stateCodes: [0],
    now: new Date('2026-06-04T00:00:00.000Z'),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    }),
    fetchImpl,
  });

  assert.equal(report.status, 'planned_account_clear');
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.account.email, 'user@example.com');
  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.total_deleted, 0);
  assert.equal(report.summary.by_table.processes.candidates, 1);
  assert.equal(report.summary.by_table.flows.candidates, 1);
  assert.equal(existsSync(report.artifacts.rls_visible_snapshot), true);
  assert.equal(existsSync(report.artifacts.dry_run_report), true);
  assert.equal(report.snapshot_completeness.complete, true);
  assert.deepEqual(report.snapshot_completeness.entity_counts, {
    lifecyclemodels: 0,
    processes: 1,
    flows: 1,
    sources: 0,
    contacts: 0,
  });
  const snapshotArtifact = JSON.parse(
    readFileSync(report.artifacts.rls_visible_snapshot, 'utf8'),
  ) as Record<string, unknown>;
  assert.equal((snapshotArtifact.completeness as { complete?: boolean }).complete, true);
  assert.match(readFileSync(report.artifacts.rls_visible_snapshot, 'utf8'), /proc-1/u);
  assert.equal(observedUrls.filter((url) => url.includes('/rest/v1/processes')).length, 1);
  assert.match(observedUrls.join('\n'), /state_code=in.%280%29/u);
  rmSync(outDir, { recursive: true, force: true });
});

test('clear-account uses the verified session email when current-user omits email', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-session-email-'));
  let userCalls = 0;
  try {
    const report = await runDatasetMaintenanceClearAccount({
      outDir,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
        TIANGONG_LCA_ACCESS_TOKEN: 'session-email-access-token',
      }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/auth/v1/user')) {
          userCalls += 1;
          return userCalls === 1
            ? makeSupabaseAuthResponse({ email: 'session@example.com', userId: 'user-1' })
            : jsonResponse({ id: 'user-1' });
        }
        return jsonResponse([]);
      },
    });

    assert.equal(report.account.email, 'session@example.com');
    assert.equal(userCalls, 2);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runDatasetMaintenanceClearAccount deletes account rows and verifies readback', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-commit-'));
  const deletedTables: string[] = [];
  const readbackCounts = new Map<string, number>();
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
    }
    if (url.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: 'user-1', email: 'user@example.com' });
    }

    const table = new URL(url).pathname.split('/').pop() ?? '';
    if (init?.method === 'POST' && url.endsWith('/functions/v1/app_dataset_delete')) {
      const body = JSON.parse(String(init.body)) as { table: string };
      deletedTables.push(body.table);
      return jsonResponse({
        ok: true,
        command: 'dataset_delete',
        data: rowsForTable(body.table)[0] ?? null,
      });
    }

    if (deletedTables.includes(table)) {
      readbackCounts.set(table, (readbackCounts.get(table) ?? 0) + 1);
      return jsonResponse([]);
    }

    return jsonResponse(rowsForTable(table));
  };

  const report = await runDatasetMaintenanceClearAccount({
    outDir,
    commit: true,
    confirm: 'user@example.com',
    now: new Date('2026-06-04T00:00:00.000Z'),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    }),
    fetchImpl,
  });

  assert.equal(report.status, 'cleared_account');
  assert.equal(report.mode, 'commit');
  assert.deepEqual(deletedTables, ['processes', 'flows']);
  assert.equal(readbackCounts.get('processes'), 2);
  assert.equal(readbackCounts.get('flows'), 2);
  assert.equal(report.summary.total_candidates, 2);
  assert.equal(report.summary.total_deleted, 2);
  assert.equal(report.summary.total_remaining, 0);
  assert.equal(report.snapshot_completeness.complete, true);
  assert.equal(report.readback_completeness?.complete, true);
  assert.equal(report.readback_completeness?.tables.length, 5);
  assert.equal(report.readback_completeness?.row_count, 0);
  assert.equal(report.readback_error, null);
  assert.equal(existsSync(report.artifacts.approval_record!), true);
  assert.equal(existsSync(report.artifacts.commit_report!), true);
  assert.equal(existsSync(report.artifacts.readback_verify_report!), true);
  rmSync(outDir, { recursive: true, force: true });
});

test('runDatasetMaintenanceClearAccount requires matching commit confirmation', async () => {
  await assert.rejects(
    () =>
      runDatasetMaintenanceClearAccount({
        commit: true,
        confirm: 'other@example.com',
        now: new Date('2026-06-04T00:00:00.000Z'),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
          TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
        }),
        fetchImpl: (async (input) => {
          const url = String(input);
          if (isSupabaseAuthTokenUrl(url)) {
            return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
          }
          return jsonResponse({ id: 'user-1', email: 'user@example.com' });
        }) as FetchLike,
      }),
    /--commit requires --confirm/u,
  );
});

test('dataset maintenance internals normalize inputs and remote response failures', async () => {
  assert.equal(__testInternals.normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(__testInternals.normalizeEmail(null), '');
  assert.equal(__testInternals.normalizeStateCode(0), 0);
  assert.equal(__testInternals.normalizeStateCode(' -1 '), -1);
  assert.equal(__testInternals.normalizeStateCode('1.2'), null);
  assert.deepEqual(__testInternals.normalizeStateCodes([2, 0, 2, 1.5]), [0, 2]);
  assert.equal(__testInternals.normalizeStateCodes([]), null);
  assert.equal(__testInternals.normalizeStateCodes(null), null);
  assert.equal(__testInternals.normalizePageSize(undefined), 1000);
  assert.equal(__testInternals.normalizeTimeoutMs(undefined), 10000);
  assert.throws(() => __testInternals.normalizePageSize(0), /--page-size/u);
  assert.throws(() => __testInternals.normalizePageSize(5001), /--page-size/u);
  assert.throws(() => __testInternals.normalizeTimeoutMs(0), /--timeout-ms/u);

  assert.equal(__testInternals.normalizeRow('flows', null), null);
  assert.deepEqual(
    __testInternals.normalizeRow('flows', {
      id: ' flow-1 ',
      version: ' 01.00.000 ',
      user_id: ' user-1 ',
      state_code: '0',
      modified_at: ' now ',
    }),
    {
      table: 'flows',
      id: 'flow-1',
      version: '01.00.000',
      user_id: 'user-1',
      state_code: 0,
      modified_at: 'now',
    },
  );
  const filterUrl = __testInternals.buildTableFilterUrl({
    restBaseUrl: 'https://example.test/rest/v1',
    table: 'flows',
    userId: 'user-1',
    stateCodes: [0, 2],
  });
  assert.match(filterUrl.toString(), /state_code=in.%280%2C2%29/u);

  await assert.rejects(
    () =>
      __testInternals.fetchJson({
        url: 'https://example.test/rest/v1/flows',
        init: { method: 'GET' },
        fetchImpl: async () => textResponse('nope', 500),
        timeoutMs: 1000,
        label: 'flows',
      }),
    /HTTP 500/u,
  );
  await assert.rejects(
    () =>
      __testInternals.fetchJson({
        url: 'https://example.test/rest/v1/flows',
        init: { method: 'GET' },
        fetchImpl: async () => textResponse('{bad-json}', 200),
        timeoutMs: 1000,
        label: 'flows',
      }),
    /not valid JSON/u,
  );
  const empty = await __testInternals.fetchJson({
    url: 'https://example.test/rest/v1/flows',
    init: { method: 'GET' },
    fetchImpl: async () => textResponse('', 200),
    timeoutMs: 1000,
    label: 'flows',
  });
  assert.equal(empty.body, null);
  await assert.rejects(
    () =>
      __testInternals.fetchCurrentUser({
        projectBaseUrl: 'https://example.test',
        publishableKey: 'anon',
        accessToken: 'token',
        fetchImpl: async () => jsonResponse({ email: 'user@example.com' }),
        timeoutMs: 1000,
      }),
    /without a user id/u,
  );
});

test('dataset maintenance internals page through rows and protect delete requests', async () => {
  const observedOffsets: string[] = [];
  const rows = await __testInternals.fetchTableRows({
    restBaseUrl: 'https://example.test/rest/v1',
    table: 'flows',
    userId: 'user-1',
    stateCodes: [0],
    pageSize: 1,
    publishableKey: 'anon',
    accessToken: 'token',
    timeoutMs: 1000,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      observedOffsets.push(url.searchParams.get('offset') ?? '');
      if (url.searchParams.get('offset') === '0') {
        return jsonResponse([
          { id: 'flow-1', version: '01.00.000', user_id: 'user-1', state_code: 0 },
        ]);
      }
      return jsonResponse([]);
    },
  });
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(observedOffsets, ['0']);
  await assert.rejects(
    () =>
      __testInternals.fetchTableRows({
        restBaseUrl: 'https://example.test/rest/v1',
        table: 'flows',
        userId: 'user-1',
        stateCodes: null,
        pageSize: 100,
        publishableKey: 'anon',
        accessToken: 'token',
        timeoutMs: 1000,
        fetchImpl: async () => jsonResponse({ rows: [] }),
      }),
    /snapshot response was not an array/u,
  );
  await assert.rejects(
    () =>
      __testInternals.fetchTableRows({
        restBaseUrl: 'https://example.test/rest/v1',
        table: 'flows',
        userId: 'user-1',
        stateCodes: null,
        pageSize: 100,
        publishableKey: 'anon',
        accessToken: 'token',
        timeoutMs: 1000,
        fetchImpl: async () => jsonResponse([null]),
      }),
    /invalid account row/u,
  );

  const observedDeletes: unknown[] = [];
  const transport: DatasetCommandTransport = {
    functionsBaseUrl: 'https://example.test/functions/v1',
    publishableKey: 'anon',
    accessToken: 'token',
    timeoutMs: 1000,
    fetchImpl: async (_input, init) => {
      observedDeletes.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true, data: {} });
    },
  };
  const result = await __testInternals.deleteTableRows({
    transport,
    table: 'flows',
    rows: [
      {
        table: 'flows',
        id: null,
        version: '01.00.000',
        user_id: 'user-1',
        state_code: 0,
        modified_at: null,
      },
      {
        table: 'flows',
        id: 'flow-2',
        version: '01.00.000',
        user_id: 'user-1',
        state_code: 1,
        modified_at: null,
      },
      {
        table: 'flows',
        id: 'flow-3',
        version: '01.00.000',
        user_id: 'user-1',
        state_code: 0,
        modified_at: null,
      },
    ],
  });
  assert.equal(result.deletedRows.length, 1);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(observedDeletes, [{ table: 'flows', id: 'flow-3', version: '01.00.000' }]);

  const summary = __testInternals.buildSummary([
    {
      table: 'flows',
      status: 'failed',
      candidates: 3,
      deleted: 1,
      remaining: 2,
      source_urls: [],
      delete_url: null,
      error: 'failed',
    },
  ]);
  assert.equal(summary.total_failures, 1);
  assert.equal(summary.by_table.contacts.status, 'skipped_after_failure');
});

test('runDatasetMaintenanceClearAccount blocks later tables after delete readback failure', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-failure-'));
  const deletedTables: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
    }
    if (url.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: 'user-1', email: 'user@example.com' });
    }
    if (init?.method === 'POST' && url.endsWith('/functions/v1/app_dataset_delete')) {
      const body = JSON.parse(String(init.body)) as { table: string };
      deletedTables.push(body.table);
      return jsonResponse({ ok: true, data: {} });
    }

    const table = new URL(url).pathname.split('/').pop() ?? '';
    if (table === 'lifecyclemodels') {
      return jsonResponse([]);
    }
    if (table === 'processes') {
      return jsonResponse([
        {
          id: 'proc-1',
          version: '01.00.000',
          user_id: 'user-1',
          state_code: 0,
          modified_at: '2026-06-01T00:00:00.000Z',
        },
      ]);
    }
    if (table === 'flows') {
      return jsonResponse([
        {
          id: 'flow-1',
          version: '01.00.000',
          user_id: 'user-1',
          state_code: 0,
          modified_at: '2026-06-01T00:00:00.000Z',
        },
      ]);
    }
    return jsonResponse([]);
  };

  try {
    const report = await runDatasetMaintenanceClearAccount({
      outDir,
      commit: true,
      confirm: 'USER@example.com',
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      }),
      fetchImpl,
    });
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(
      report.tables.find((table) => table.table === 'lifecyclemodels')?.status,
      'skipped_empty',
    );
    assert.equal(report.tables.find((table) => table.table === 'processes')?.status, 'failed');
    assert.equal(report.tables.find((table) => table.table === 'flows')?.status, 'failed');
    assert.match(
      report.tables.find((table) => table.table === 'flows')?.error ?? '',
      /final all-table readback/u,
    );
    assert.equal(report.readback_completeness?.tables.length, 5);
    assert.equal(report.readback_completeness?.row_count, 2);
    assert.deepEqual(deletedTables, ['processes']);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('clear-account paginator follows a 1000-row server cap for a requested page size of 5000', async () => {
  const rows = Array.from({ length: 2_203 }, (_, index) => ({
    id: `flow-${String(index).padStart(5, '0')}`,
    version: '00.00.001',
    user_id: 'user-1',
    state_code: 0,
    modified_at: '2026-07-13T00:00:00.000Z',
  }));
  const offsets: number[] = [];
  const preferHeaders: string[] = [];
  const result = await __testInternals.fetchTableRows({
    restBaseUrl: 'https://example.test/rest/v1',
    table: 'flows',
    userId: 'user-1',
    stateCodes: [0],
    pageSize: 5_000,
    publishableKey: 'anon',
    accessToken: 'token',
    timeoutMs: 1_000,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const page = rows.slice(offset, offset + 1_000);
      offsets.push(offset);
      preferHeaders.push(new Headers(init?.headers).get('prefer') ?? '');
      return jsonResponse(page, 200, {
        'content-range': `${offset}-${offset + page.length - 1}/${rows.length}`,
      });
    },
  });

  assert.deepEqual(offsets, [0, 1_000, 2_000]);
  assert.equal(
    preferHeaders.every((value) => value === 'count=exact'),
    true,
  );
  assert.equal(result.rows.length, 2_203);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.completeness.effective_page_size, 1_000);
  assert.equal(result.completeness.pages_fetched, 3);
});

test('clear-account refuses an unproven snapshot before writing artifacts or deleting rows', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-incomplete-'));
  let deleteRequests = 0;
  const withoutContentRange = (body: unknown): ResponseLike => ({
    ok: true,
    status: 200,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    },
  });
  try {
    await assert.rejects(
      () =>
        runDatasetMaintenanceClearAccount({
          outDir,
          commit: true,
          confirm: 'user@example.com',
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
            TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
          }),
          fetchImpl: async (input, init) => {
            const url = String(input);
            if (isSupabaseAuthTokenUrl(url)) {
              return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
            }
            if (url.endsWith('/auth/v1/user')) {
              return jsonResponse({ id: 'user-1', email: 'user@example.com' });
            }
            if (init?.method === 'POST') deleteRequests += 1;
            return withoutContentRange([]);
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(deleteRequests, 0);
    assert.equal(existsSync(path.join(outDir, 'rls-visible-snapshot.json')), false);
    assert.equal(existsSync(path.join(outDir, 'approval-record.json')), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('clear-account final all-table readback catches rows added after an empty initial snapshot', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-final-row-'));
  const reads = new Map<string, number>();
  let deleteRequests = 0;
  try {
    const report = await runDatasetMaintenanceClearAccount({
      outDir,
      commit: true,
      confirm: 'user@example.com',
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      }),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
        }
        if (url.endsWith('/auth/v1/user')) {
          return jsonResponse({ id: 'user-1', email: 'user@example.com' });
        }
        if (init?.method === 'POST') deleteRequests += 1;
        const table = new URL(url).pathname.split('/').pop() ?? '';
        const count = (reads.get(table) ?? 0) + 1;
        reads.set(table, count);
        return jsonResponse(
          table === 'processes' && count === 2
            ? [
                {
                  id: 'late-process',
                  version: '01.00.000',
                  user_id: 'user-1',
                  state_code: 0,
                },
              ]
            : [],
        );
      },
    });

    assert.equal(deleteRequests, 0);
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.readback_completeness?.tables.length, 5);
    assert.equal(report.readback_completeness?.row_count, 1);
    assert.equal(report.tables.find((table) => table.table === 'processes')?.candidates, 0);
    assert.equal(report.tables.find((table) => table.table === 'processes')?.remaining, 1);
    assert.equal(report.tables.find((table) => table.table === 'processes')?.status, 'failed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('clear-account records a failed final completeness proof after commit mode starts', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'tg-clear-account-final-incomplete-'));
  const reads = new Map<string, number>();
  try {
    const report = await runDatasetMaintenanceClearAccount({
      outDir,
      commit: true,
      confirm: 'user@example.com',
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({ email: 'user@example.com', userId: 'user-1' });
        }
        if (url.endsWith('/auth/v1/user')) {
          return jsonResponse({ id: 'user-1', email: 'user@example.com' });
        }
        const table = new URL(url).pathname.split('/').pop() ?? '';
        const count = (reads.get(table) ?? 0) + 1;
        reads.set(table, count);
        if (table === 'processes' && count === 2) {
          return {
            ...jsonResponse([]),
            headers: { get: () => null },
          };
        }
        return jsonResponse([]);
      },
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.readback_completeness, null);
    assert.match(report.readback_error ?? '', /could not prove account state/u);
    assert.equal(report.summary.total_failures, 1);
    assert.equal(existsSync(report.artifacts.commit_report!), true);
    assert.equal(existsSync(report.artifacts.readback_verify_report!), true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
