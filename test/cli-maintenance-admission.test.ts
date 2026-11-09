import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import type { DatasetMaintenanceSnapshotCompleteness } from '../src/lib/dataset-maintenance-pagination.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';
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

test('protected maintenance keeps discovery, account guard forwarding and exact result projection', async () => {
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

test('protected preparation refuses every missing binding before adapter or transport', async () => {
  const groups = [
    {
      action: 'freeze-protected',
      fields: [
        ['plan', 'missing-plan.json', 'PLAN'],
        ['toolchain-evidence', 'toolchain.json', 'TOOLCHAIN'],
        ['expected-project-ref', 'project', 'PROJECT_REF'],
        ['confirm', 'owner@example.com', 'CONFIRM'],
        ['out-dir', 'output', 'OUT_DIR'],
      ],
    },
    {
      action: 'seal-protected-approval',
      fields: [
        ['freeze', 'freeze.json', 'FREEZE'],
        ['approval-request', 'request.json', 'APPROVAL_REQUEST'],
        ['human-approval', 'approval.txt', 'HUMAN_APPROVAL'],
        ['approve-freeze-file', 'frozen-hash', 'FREEZE_CONFIRMATION'],
        ['approve-request', 'request-hash', 'REQUEST_CONFIRMATION'],
        ['approve-text', 'text-hash', 'TEXT_CONFIRMATION'],
        ['confirm', 'owner@example.com', 'CONFIRM'],
        ['approved-at', '2026-11-09T00:00:00Z', 'APPROVED_AT'],
        ['out-dir', 'output', 'OUT_DIR'],
      ],
    },
  ];
  for (const { action, fields } of groups) {
    let calls = 0;
    const deps = {
      ...makeDeps(),
      fetchImpl: async () => {
        calls++;
        throw new Error('Unexpected transport');
      },
      freezeDatasetMaintenanceProtectedImpl: async () => {
        calls++;
        throw new Error('Unexpected freeze');
      },
      sealDatasetMaintenanceProtectedApprovalImpl: () => {
        calls++;
        throw new Error('Unexpected seal');
      },
    };
    const help = await executeCli(['dataset', 'maintenance', action, '--help'], deps);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /--confirm/);
    for (const [missing, , code] of fields) {
      const args = fields
        .filter(([flag]) => flag !== missing)
        .flatMap(([flag, value]) => [`--${flag}`, value!]);
      const rejected = await executeCli(['dataset', 'maintenance', action, ...args], deps);
      assert.equal(rejected.exitCode, 2, missing);
      assert.equal(
        JSON.parse(rejected.stderr).error.code,
        `DATASET_MAINTENANCE_PROTECTED_${code}_REQUIRED`,
      );
    }
    const malformed = await executeCli(['dataset', 'maintenance', action, '--bad-flag'], deps);
    assert.equal(malformed.exitCode, 2);
    assert.equal(JSON.parse(malformed.stderr).error.code, 'INVALID_ARGS');
    assert.equal(calls, 0);
  }
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

test('run-protected help exposes one-shot commit and status-only recovery without IO', async () => {
  const result = await executeCli(
    ['dataset', 'maintenance', 'run-protected', '--help'],
    makeDeps(),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--status-only/);
  assert.match(result.stdout, /--commit/);
});

test('executeCli separates production read-only freeze from offline approval sealing', async () => {
  const deps = makeDeps();
  const freezeHelp = await executeCli(
    ['dataset', 'maintenance', 'freeze-protected', '--help'],
    deps,
  );
  assert.equal(freezeHelp.exitCode, 0);
  assert.match(freezeHelp.stdout, /only authenticated table reads/u);
  assert.match(freezeHelp.stdout, /never emits an approval artifact/u);

  const sealHelp = await executeCli(
    ['dataset', 'maintenance', 'seal-protected-approval', '--help'],
    deps,
  );
  assert.equal(sealHelp.exitCode, 0);
  assert.match(sealHelp.stdout, /byte-for-byte without trimming/u);
  assert.match(sealHelp.stdout, /zero authentication, network/u);

  let observedFreeze: unknown = null;
  const freeze = await executeCli(
    [
      'dataset',
      'maintenance',
      'freeze-protected',
      '--plan',
      './maintenance-plan.json',
      '--toolchain-evidence',
      './toolchain.json',
      '--expected-project-ref',
      'production-ref',
      '--confirm',
      'owner@example.com',
      '--out-dir',
      './protected-freeze',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      freezeDatasetMaintenanceProtectedImpl: async (options) => {
        observedFreeze = options;
        return { status: 'ready_for_human_approval', marker: 'freeze' } as never;
      },
    },
  );
  assert.equal(freeze.exitCode, 0);
  assert.deepEqual(JSON.parse(freeze.stdout), {
    status: 'ready_for_human_approval',
    marker: 'freeze',
  });
  assert.deepEqual(observedFreeze, {
    planPath: './maintenance-plan.json',
    toolchainEvidencePath: './toolchain.json',
    outDir: './protected-freeze',
    expectedProjectRef: 'production-ref',
    confirm: 'owner@example.com',
    cliVersion: '0.1.29',
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const freezeRequiredCases = [
    [],
    ['--plan', 'plan.json'],
    ['--plan', 'plan.json', '--toolchain-evidence', 'toolchain.json'],
    [
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--expected-project-ref',
      'production-ref',
    ],
    [
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--expected-project-ref',
      'production-ref',
      '--confirm',
      'owner@example.com',
    ],
  ];
  for (const args of freezeRequiredCases) {
    const result = await executeCli(['dataset', 'maintenance', 'freeze-protected', ...args], deps);
    assert.equal(result.exitCode, 2, args.join(' '));
  }
  for (const args of [['--unknown'], ['--page-size', '0']]) {
    const result = await executeCli(
      [
        'dataset',
        'maintenance',
        'freeze-protected',
        '--plan',
        'plan.json',
        '--toolchain-evidence',
        'toolchain.json',
        '--expected-project-ref',
        'production-ref',
        '--confirm',
        'owner@example.com',
        '--out-dir',
        'out',
        ...args,
      ],
      deps,
    );
    assert.equal(result.exitCode, 2, args.join(' '));
  }

  const hash = 'a'.repeat(64);
  let observedSeal: unknown = null;
  const seal = await executeCli(
    [
      'dataset',
      'maintenance',
      'seal-protected-approval',
      '--freeze',
      './freeze.json',
      '--approval-request',
      './request.json',
      '--human-approval',
      './human.txt',
      '--approve-freeze-file',
      hash,
      '--approve-request',
      hash,
      '--approve-text',
      hash,
      '--confirm',
      'owner@example.com',
      '--approved-at',
      '2026-07-15T12:00:00.000Z',
      '--out-dir',
      './approval',
      '--json',
    ],
    {
      ...deps,
      sealDatasetMaintenanceProtectedApprovalImpl: async (options) => {
        observedSeal = options;
        return { status: 'sealed', marker: 'seal' } as never;
      },
    },
  );
  assert.equal(seal.exitCode, 0);
  assert.deepEqual(JSON.parse(seal.stdout), { status: 'sealed', marker: 'seal' });
  assert.deepEqual(observedSeal, {
    freezePath: './freeze.json',
    approvalRequestPath: './request.json',
    humanApprovalPath: './human.txt',
    outDir: './approval',
    approveFreezeFile: hash,
    approveRequest: hash,
    approveText: hash,
    confirm: 'owner@example.com',
    approvedAtUtc: '2026-07-15T12:00:00.000Z',
  });

  const sealFlags = [
    '--freeze',
    'freeze.json',
    '--approval-request',
    'request.json',
    '--human-approval',
    'human.txt',
    '--approve-freeze-file',
    hash,
    '--approve-request',
    hash,
    '--approve-text',
    hash,
    '--confirm',
    'owner@example.com',
    '--approved-at',
    '2026-07-15T12:00:00.000Z',
    '--out-dir',
    'approval',
  ];
  for (let end = 0; end < sealFlags.length; end += 2) {
    const result = await executeCli(
      ['dataset', 'maintenance', 'seal-protected-approval', ...sealFlags.slice(0, end)],
      deps,
    );
    assert.equal(result.exitCode, 2, String(end));
  }
  const invalidSeal = await executeCli(
    ['dataset', 'maintenance', 'seal-protected-approval', ...sealFlags, '--unknown'],
    deps,
  );
  assert.equal(invalidSeal.exitCode, 2);
});
