import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  datasetIdentity,
  datasetRoot,
  detectDatasetKind,
  unwrapDatasetPayload,
} from '../src/lib/dataset-local.js';

import { __testInternals as contractInternals } from '../src/lib/dataset-contract.js';

import { __testInternals as validateInternals } from '../src/lib/dataset-validate.js';

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

function makeDeps() {
  return {
    env: buildSupabaseTestEnv({ TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1' }),
    dotEnvStatus,
    fetchImpl: (async (input) => {
      if (isSupabaseAuthTokenUrl(String(input))) {
        return makeSupabaseAuthResponse();
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ ok: true }),
      };
    }) as FetchLike,
  };
}

test('prepush coverage covers CLI parser error and help branches', async () => {
  const cases = [
    ['dataset', 'save-draft', '--bad-flag'],
    ['dataset', 'classification', 'children', '--bad-flag'],
    ['dataset', 'classification', 'children', '--limit', '0'],
    ['dataset', 'classification', 'path', '--bad-flag'],
    ['dataset', 'classification', 'audit', '--bad-flag'],
    ['dataset', 'classification', 'apply', '--bad-flag'],
    ['dataset', 'classification', 'bad-action'],
    ['dataset', 'curation-queue', 'next', '--bad-flag'],
    ['dataset', 'curation-queue', 'next', '--type', 'bad'],
    ['dataset', 'import-lca', 'convert', '--max-entry-mib', '0'],
    ['dataset', 'import-lca', 'convert', '--memory-budget-mib', '-1'],
    ['dataset', 'import-lca', 'convert', '--queue-capacity', 'invalid'],
    ['dataset', 'patch', 'apply', '--bad-flag'],
    ['dataset', 'verify-remote', '--state-code=bad'],
    ['dataset', 'maintenance', 'clear-account', '--bad-flag'],
    ['dataset', 'maintenance', 'clear-account', '--commit', '--dry-run'],
    ['dataset', 'maintenance', 'clear-account', '--state-code', 'bad'],
    ['dataset', 'maintenance', 'clear-account', '--page-size', 'bad'],
    ['dataset', 'maintenance', 'plan', '--bad-flag'],
    ['dataset', 'maintenance', 'plan'],
    ['dataset', 'maintenance', 'plan', '--scope', 'scope.json'],
    ['dataset', 'maintenance', 'plan', '--scope', 'scope.json', '--operation', 'delete'],
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      'scope.json',
      '--operation',
      'bad',
      '--out-dir',
      'out',
    ],
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      'scope.json',
      '--operation',
      'delete',
      '--out-dir',
      'out',
      '--page-size',
      'bad',
    ],
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      'scope.json',
      '--operation',
      'delete',
      '--out-dir',
      'out',
      '--page-size',
      '0',
    ],
    ['dataset', 'maintenance', 'apply', '--bad-flag'],
    ['dataset', 'maintenance', 'apply', '--commit'],
    ['dataset', 'maintenance', 'apply', '--plan', 'plan.json', '--commit', '--dry-run'],
    ['dataset', 'maintenance', 'apply', '--plan', 'plan.json', '--dry-run'],
    ['dataset', 'maintenance', 'apply', '--plan', 'plan.json'],
    ['dataset', 'maintenance', 'apply', '--plan', 'plan.json', '--commit'],
    ['dataset', 'maintenance', 'apply', '--plan', 'plan.json', '--commit', '--approve-plan', 'abc'],
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      'plan.json',
      '--commit',
      '--approve-plan',
      'abc',
      '--confirm',
      'user@example.com',
      '--timeout-ms',
      '0',
    ],
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      'plan.json',
      '--commit',
      '--approve-plan',
      'abc',
      '--confirm',
      'user@example.com',
      '--max-parallel',
      '0',
    ],
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      'plan.json',
      '--commit',
      '--approve-plan',
      'abc',
      '--confirm',
      'user@example.com',
      '--max-parallel',
      'bad',
    ],
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      'plan.json',
      '--commit',
      '--approve-plan',
      'abc',
      '--confirm',
      'user@example.com',
      '--max-parallel',
      '9',
    ],
    ['dataset', 'maintenance', 'verify', '--bad-flag'],
    ['dataset', 'maintenance', 'verify'],
    ['dataset', 'maintenance', 'verify', '--plan', 'plan.json', '--timeout-ms', 'bad'],
    ['dataset', 'maintenance', 'bad-action'],
    ['process', 'identity-preflight', '--timeout-ms', '0'],
  ];

  for (const args of cases) {
    const result = await executeCli(args, makeDeps());
    assert.equal(result.exitCode, 2, args.join(' '));
  }

  for (const args of [
    ['dataset', 'classification'],
    ['dataset', 'classification', 'children', '--help'],
    ['dataset', 'classification', 'path', '--help'],
    ['dataset', 'classification', 'audit', '--help'],
    ['dataset', 'classification', 'apply', '--help'],
  ]) {
    const result = await executeCli(args, makeDeps());
    assert.equal(result.exitCode, 0, args.join(' '));
  }

  const importNoBundles = await executeCli(
    [
      'dataset',
      'import-lca',
      'convert',
      '--input',
      'in.zip',
      '--output-dir',
      'out',
      '--no-process-bundles',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetImportLcaConvertImpl: async (options) => {
        assert.equal(options.processBundles, false);
        return {
          schema_version: 'tiangong-lca.dataset-import-lca-report.v2',
          status: 'succeeded',
          exit_class: 'success',
          exit_code: 0,
        } as never;
      },
    },
  );
  assert.equal(importNoBundles.exitCode, 0);

  const classificationAuditBlocked = await executeCli(
    ['dataset', 'classification', 'audit', '--input', 'rows.jsonl', '--out-dir', 'audit-out'],
    {
      ...makeDeps(),
      runDatasetClassificationAuditImpl: async (options) => {
        assert.equal(options.outDir, 'audit-out');
        return { status: 'blocked' } as never;
      },
    },
  );
  assert.equal(classificationAuditBlocked.exitCode, 1);

  const classificationApplyBlocked = await executeCli(
    [
      'dataset',
      'classification',
      'apply',
      '--input',
      'rows.jsonl',
      '--decisions',
      'decisions.json',
      '--out',
      'out.jsonl',
      '--out-dir',
      'apply-out',
    ],
    {
      ...makeDeps(),
      runDatasetClassificationApplyImpl: async (options) => {
        assert.equal(options.outDir, 'apply-out');
        return { status: 'blocked' } as never;
      },
    },
  );
  assert.equal(classificationApplyBlocked.exitCode, 1);

  const maintenanceHelp = await executeCli(['dataset', 'maintenance'], makeDeps());
  assert.equal(maintenanceHelp.exitCode, 0);

  const maintenanceCompleted = await executeCli(
    ['dataset', 'maintenance', 'clear-account', '--page-size', '100', '--json'],
    {
      ...makeDeps(),
      runDatasetMaintenanceClearAccountImpl: async (options) => {
        assert.equal(options.pageSize, 100);
        return { status: 'completed' } as never;
      },
    },
  );
  assert.equal(maintenanceCompleted.exitCode, 0);

  const maintenanceFailed = await executeCli(
    ['dataset', 'maintenance', 'clear-account', '--json'],
    {
      ...makeDeps(),
      runDatasetMaintenanceClearAccountImpl: async () =>
        ({
          schema_version: 1,
          generated_at_utc: '2026-06-04T00:00:00.000Z',
          status: 'completed_with_failures',
          mode: 'commit',
          account: { email: 'a@example.com', user_id: 'user-1', session_source: 'cache' },
          filters: {
            tables: ['processes'],
            state_codes: [0],
            page_size: 1000,
          },
          summary: {
            total_candidates: 1,
            total_deleted: 0,
            total_remaining: 1,
            total_failures: 1,
            by_table: {
              processes: { candidates: 1, deleted: 0, remaining: 1, failures: 1 },
            },
          },
          tables: [],
          artifacts: {
            dry_run_report: '/tmp/dry-run.json',
            approval_record: null,
            commit_report: null,
            readback_verify_report: null,
          },
        }) as never,
    },
  );
  assert.equal(maintenanceFailed.exitCode, 1);

  const maintenancePlanBlocked = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      'scope.json',
      '--operation',
      'delete',
      '--out-dir',
      'out',
    ],
    {
      ...makeDeps(),
      runDatasetMaintenancePlanImpl: async () => ({ status: 'blocked' }) as never,
    },
  );
  assert.equal(maintenancePlanBlocked.exitCode, 1);

  const maintenanceApplyFailed = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      'plan.json',
      '--commit',
      '--approve-plan',
      'abc',
      '--confirm',
      'user@example.com',
    ],
    {
      ...makeDeps(),
      runDatasetMaintenanceApplyImpl: async () => ({ status: 'completed_with_failures' }) as never,
    },
  );
  assert.equal(maintenanceApplyFailed.exitCode, 1);

  const maintenanceVerifyFailed = await executeCli(
    ['dataset', 'maintenance', 'verify', '--plan', 'plan.json'],
    {
      ...makeDeps(),
      runDatasetMaintenanceVerifyImpl: async () => ({ status: 'failed' }) as never,
    },
  );
  assert.equal(maintenanceVerifyFailed.exitCode, 1);
});

test('prepush coverage covers dataset local and validate aliases', () => {
  assert.deepEqual(datasetRoot({ contactDataSet: { a: 1 } }, 'contact'), { a: 1 });
  assert.deepEqual(datasetRoot({ flowPropertyDataSet: { a: 1 } }, 'flowproperty'), { a: 1 });
  assert.deepEqual(datasetRoot({ sourceDataSet: { a: 1 } }, 'source'), { a: 1 });
  assert.deepEqual(datasetRoot({ unitGroupDataSet: { a: 1 } }, 'unitgroup'), { a: 1 });
  assert.deepEqual(datasetRoot({}, 'contact'), {});
  assert.deepEqual(datasetRoot({}, 'flowproperty'), {});
  assert.deepEqual(datasetRoot({}, 'source'), {});
  assert.deepEqual(datasetRoot({}, 'unitgroup'), {});
  assert.equal(detectDatasetKind({ contact: {} }), 'contact');
  assert.equal(detectDatasetKind({ flowproperty: {} }), 'flowproperty');
  assert.equal(detectDatasetKind({ source: {} }), 'source');
  assert.equal(detectDatasetKind({ unitgroup: {} }), 'unitgroup');
  assert.deepEqual(unwrapDatasetPayload({ contact: { id: 'c' } }), { id: 'c' });
  assert.deepEqual(unwrapDatasetPayload({ source: { id: 's' } }), { id: 's' });
  assert.deepEqual(unwrapDatasetPayload({ unitgroup: { id: 'u' } }), { id: 'u' });
  assert.deepEqual(unwrapDatasetPayload({ flowproperty: { id: 'fp' } }), { id: 'fp' });
  assert.deepEqual(
    datasetIdentity(
      {},
      {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: { 'common:UUID': 'source-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
      'source',
    ),
    { id: 'source-1', version: '01.00.000' },
  );
  assert.deepEqual(datasetIdentity({}, {}, 'contact'), { id: null, version: null });

  assert.equal(validateInternals.normalizeType('contacts'), 'contact');
  assert.equal(validateInternals.normalizeType('flow-properties'), 'flowproperty');
  assert.equal(validateInternals.normalizeType('sources'), 'source');
  assert.equal(validateInternals.normalizeType('unit-groups'), 'unitgroup');
});

test('prepush coverage covers contract asset discovery edge branches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-save-draft-edges-'));
  try {
    assert.ok(contractInternals.resolveSdkRuntimeAssetsRoot().length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
