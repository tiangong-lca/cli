import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import type { DatasetMaintenanceSnapshotCompleteness } from '../src/lib/maintenance/pagination.js';
import type { DotEnvLoadResult } from '../src/lib/config/dotenv.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

const makeDeps = (overrides?: Partial<NodeJS.ProcessEnv>) => ({
  env: buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    TIANGONG_LCA_REGION: 'us-east-1',
    ...overrides,
  }),
  dotEnvStatus,
  fetchImpl: (async (input) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    };
  }) as FetchLike,
});

test('ordinary maintenance keeps discovery, account guard forwarding and exact result projection', async () => {
  const datasetMaintenanceHelp = await executeCli(['dataset', 'maintenance', '--help'], makeDeps());
  assert.equal(datasetMaintenanceHelp.exitCode, 0);
  assert.match(
    datasetMaintenanceHelp.stdout,
    /current-user RLS and platform dataset command paths/u,
  );
  assert.match(datasetMaintenanceHelp.stdout, /apply is commit-only/u);
  assert.match(datasetMaintenanceHelp.stdout, /maintenance-plan\.json/u);

  const datasetMaintenanceClearHelp = await executeCli(
    ['dataset', 'maintenance', 'clear-account', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceClearHelp.exitCode, 0);
  assert.match(
    datasetMaintenanceClearHelp.stdout,
    /tiangong-lca dataset maintenance clear-account/u,
  );
  assert.match(datasetMaintenanceClearHelp.stdout, /--confirm <email>/u);
  assert.match(datasetMaintenanceClearHelp.stdout, /1-5000.*exact counts/u);
  assert.doesNotMatch(datasetMaintenanceClearHelp.stdout, /Planned command/u);

  const datasetMaintenancePlanHelp = await executeCli(
    ['dataset', 'maintenance', 'plan', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenancePlanHelp.exitCode, 0);
  assert.match(datasetMaintenancePlanHelp.stdout, /--operation <operation>/u);
  assert.match(datasetMaintenancePlanHelp.stdout, /rebuild-derivatives/u);
  assert.match(datasetMaintenancePlanHelp.stdout, /1-5000.*exact counts/u);

  const datasetMaintenanceApplyHelp = await executeCli(
    ['dataset', 'maintenance', 'apply', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceApplyHelp.exitCode, 0);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--approve-plan <sha256>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--global-inbound-proof <file>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--approve-global-inbound-proof <sha256>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /Commit-only/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /guarded admission is queued/u);

  const datasetMaintenanceVerifyHelp = await executeCli(
    ['dataset', 'maintenance', 'verify', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceVerifyHelp.exitCode, 0);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /readback-verify-report\.json/u);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /1-5000.*exact counts/u);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /pending, passed, or failed/u);

  let observedClearAccountOptions: unknown = null;
  const emptyClearCompleteness: DatasetMaintenanceSnapshotCompleteness<
    'lifecyclemodels' | 'processes' | 'flows' | 'sources' | 'contacts'
  > = {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count_multi_request',
    requested_page_size: 1000,
    page_count: 5,
    row_count: 0,
    entity_counts: {
      lifecyclemodels: 0,
      processes: 0,
      flows: 0,
      sources: 0,
      contacts: 0,
    },
    tables: [],
  };
  const clearAccountDeps = makeDeps();
  const datasetMaintenanceClear = await executeCli(
    [
      'dataset',
      'maintenance',
      'clear-account',
      '--state-code',
      '0',
      '--out-dir',
      './account-clear',
      '--commit',
      '--confirm',
      'user@example.com',
      '--json',
    ],
    {
      ...clearAccountDeps,
      runDatasetMaintenanceClearAccountImpl: async (options) => {
        observedClearAccountOptions = options;
        return {
          schema_version: 1,
          generated_at_utc: '2026-06-04T00:00:00.000Z',
          status: 'cleared_account',
          mode: 'commit',
          account: {
            email: 'user@example.com',
            user_id: 'user-1',
            session_source: 'memory',
          },
          filters: {
            tables: ['lifecyclemodels', 'processes', 'flows', 'sources', 'contacts'],
            state_codes: [0],
            page_size: 1000,
          },
          snapshot_completeness: emptyClearCompleteness,
          readback_completeness: emptyClearCompleteness,
          readback_error: null,
          summary: {
            total_candidates: 0,
            total_deleted: 0,
            total_remaining: 0,
            total_failures: 0,
            by_table: {
              lifecyclemodels: {
                candidates: 0,
                deleted: 0,
                remaining: 0,
                status: 'skipped_empty',
              },
              processes: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              flows: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              sources: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              contacts: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
            },
          },
          tables: [],
          artifacts: {
            rls_visible_snapshot: './account-clear/rls-visible-snapshot.json',
            dry_run_report: './account-clear/dry-run-report.json',
            approval_record: './account-clear/approval-record.json',
            commit_report: './account-clear/commit-report.json',
            readback_verify_report: './account-clear/readback-verify-report.json',
          },
        };
      },
    },
  );
  assert.equal(datasetMaintenanceClear.exitCode, 0);
  assert.deepEqual(JSON.parse(datasetMaintenanceClear.stdout), {
    schema_version: 1,
    generated_at_utc: '2026-06-04T00:00:00.000Z',
    status: 'cleared_account',
    mode: 'commit',
    account: {
      email: 'user@example.com',
      user_id: 'user-1',
      session_source: 'memory',
    },
    filters: {
      tables: ['lifecyclemodels', 'processes', 'flows', 'sources', 'contacts'],
      state_codes: [0],
      page_size: 1000,
    },
    snapshot_completeness: emptyClearCompleteness,
    readback_completeness: emptyClearCompleteness,
    readback_error: null,
    summary: {
      total_candidates: 0,
      total_deleted: 0,
      total_remaining: 0,
      total_failures: 0,
      by_table: {
        lifecyclemodels: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        processes: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        flows: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        sources: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        contacts: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
      },
    },
    tables: [],
    artifacts: {
      rls_visible_snapshot: './account-clear/rls-visible-snapshot.json',
      dry_run_report: './account-clear/dry-run-report.json',
      approval_record: './account-clear/approval-record.json',
      commit_report: './account-clear/commit-report.json',
      readback_verify_report: './account-clear/readback-verify-report.json',
    },
  });
  assert.deepEqual(observedClearAccountOptions, {
    outDir: './account-clear',
    stateCodes: [0],
    pageSize: undefined,
    timeoutMs: undefined,
    commit: true,
    confirm: 'user@example.com',
    env: clearAccountDeps.env,
    fetchImpl: clearAccountDeps.fetchImpl,
  });
});

test('clear-account rejects malformed scope and forwards bounded numeric controls', async () => {
  for (const args of [
    ['--state-code', 'not-an-integer'],
    ['--page-size', '1.5'],
    ['--timeout-ms', 'bad'],
    ['--bad-flag'],
  ]) {
    let calls = 0;
    const result = await executeCli(['dataset', 'maintenance', 'clear-account', ...args], {
      ...makeDeps(),
      runDatasetMaintenanceClearAccountImpl: async () => {
        calls++;
        throw new Error('Unexpected clear');
      },
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /INVALID/);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'clear-account',
      '--state-code',
      '0',
      '--page-size',
      '200',
      '--timeout-ms',
      '3000',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetMaintenanceClearAccountImpl: async (options) => {
        calls++;
        assert.equal(options.pageSize, 200);
        assert.equal(options.timeoutMs, 3000);
        assert.deepEqual(options.stateCodes, [0]);
        assert.equal(options.commit, false);
        return { status: 'completed_with_failures' } as never;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'completed_with_failures' });
});
