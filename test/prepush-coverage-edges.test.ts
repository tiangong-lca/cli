import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  __testInternals as classificationInternals,
  runDatasetClassificationApply,
  runDatasetClassificationAudit,
} from '../src/lib/dataset-classification.js';
import {
  __testInternals as contractInternals,
  runDatasetContract,
} from '../src/lib/dataset-contract.js';
import {
  __testInternals as curationInternals,
  runDatasetCurationQueueBuild,
} from '../src/lib/dataset-curation-queue.js';
import {
  __testInternals as maintenanceInternals,
  runDatasetMaintenanceClearAccount,
} from '../src/lib/dataset-maintenance-clear-account.js';
import {
  __testInternals as patchInternals,
  runDatasetPatchApply,
} from '../src/lib/dataset-patch.js';
import {
  __testInternals as remoteVerifyInternals,
  runDatasetRemoteVerify,
} from '../src/lib/dataset-remote-verify.js';
import {
  __testInternals as saveDraftInternals,
  runDatasetSaveDraft,
} from '../src/lib/dataset-save-draft-run.js';
import { __testInternals as validateInternals } from '../src/lib/dataset-validate.js';
import { __testInternals as flowQaInternals, runFlowQa } from '../src/lib/flow-qa.js';
import { __testInternals as identityInternals } from '../src/lib/identity-preflight.js';
import {
  __testInternals as lifecyclemodelQaInternals,
  runLifecyclemodelQa,
} from '../src/lib/lifecyclemodel-qa.js';
import { __testInternals as processRequiredInternals } from '../src/lib/process-required-fields.js';
import { __testInternals as supabaseClientInternals } from '../src/lib/supabase-client.js';
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

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function maintenanceJsonHeaders(body: unknown) {
  const contentRange = Array.isArray(body)
    ? body.length > 0
      ? `0-${body.length - 1}/${body.length}`
      : '*/0'
    : null;
  return {
    get(name: string): string | null {
      return name.toLowerCase() === 'content-range' ? contentRange : 'application/json';
    },
  };
}

function sampleProcessRow(id = 'proc-1', version = '00.00.001') {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': id,
          name: { baseName: { '#text': 'Old process name' } },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': version,
        },
      },
    },
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
    ['dataset', 'curation-queue', 'next', '--help'],
    ['dataset', 'curation-queue', 'verify', '--help'],
    ['dataset', 'patch'],
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

  const classificationChildrenBlocked = await executeCli(
    [
      'dataset',
      'classification',
      'children',
      '--type',
      'process',
      '--query',
      'food',
      '--out-dir',
      'class-out',
    ],
    {
      ...makeDeps(),
      runDatasetClassificationChildrenImpl: async (options) => {
        assert.equal(options.query, 'food');
        assert.equal(options.outDir, 'class-out');
        return { status: 'blocked' } as never;
      },
    },
  );
  assert.equal(classificationChildrenBlocked.exitCode, 1);

  const classificationChildrenCompleted = await executeCli(
    ['dataset', 'classification', 'children', '--type', 'process', '--json'],
    {
      ...makeDeps(),
      runDatasetClassificationChildrenImpl: async () => ({ status: 'completed' }) as never,
    },
  );
  assert.equal(classificationChildrenCompleted.exitCode, 0);

  const classificationPathBlocked = await executeCli(
    [
      'dataset',
      'classification',
      'path',
      '--type',
      'process',
      '--code',
      '1080',
      '--out-dir',
      'path-out',
    ],
    {
      ...makeDeps(),
      runDatasetClassificationPathImpl: async (options) => {
        assert.equal(options.outDir, 'path-out');
        return { status: 'blocked' } as never;
      },
    },
  );
  assert.equal(classificationPathBlocked.exitCode, 1);

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

  const curationNextBlocked = await executeCli(
    ['dataset', 'curation-queue', 'next', '--queue-dir', 'queue'],
    {
      ...makeDeps(),
      runDatasetCurationQueueNextImpl: async () => ({ status: 'blocked' }) as never,
    },
  );
  assert.equal(curationNextBlocked.exitCode, 1);

  const curationVerifyBlocked = await executeCli(
    ['dataset', 'curation-queue', 'verify', '--queue-dir', 'queue'],
    {
      ...makeDeps(),
      runDatasetCurationQueueVerifyImpl: async () => ({ status: 'blocked' }) as never,
    },
  );
  assert.equal(curationVerifyBlocked.exitCode, 1);

  const patchBlocked = await executeCli(
    [
      'dataset',
      'patch',
      'apply',
      '--input',
      'rows.jsonl',
      '--patch',
      'patch.json',
      '--out',
      'out.jsonl',
    ],
    {
      ...makeDeps(),
      runDatasetPatchApplyImpl: async () => ({ status: 'blocked' }) as never,
    },
  );
  assert.equal(patchBlocked.exitCode, 1);

  const patchCompleted = await executeCli(
    [
      'dataset',
      'patch',
      'apply',
      '--input',
      'rows.jsonl',
      '--patch',
      'patch.json',
      '--out',
      'out.jsonl',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetPatchApplyImpl: async () => ({ status: 'completed' }) as never,
    },
  );
  assert.equal(patchCompleted.exitCode, 0);

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

  const lifecycleRows = await executeCli(
    ['qa', 'lifecyclemodel', '--rows-file', 'models.jsonl', '--out-dir', 'qa-out'],
    {
      ...makeDeps(),
      runLifecyclemodelQaImpl: async (options) =>
        ({
          schema_version: 1,
          generated_at_utc: '2026-06-04T00:00:00.000Z',
          status: 'completed_local_lifecyclemodel_qa',
          run_id: 'run-1',
          run_root: null,
          rows_file: options.rowsFile ?? null,
          input_mode: 'rows_file',
          out_dir: options.outDir,
          logic_version: 'lifecyclemodel-v1',
          model_count: 0,
          finding_count: 0,
          severity_counts: { info: 0, warning: 0, blocker: 0 },
          validation: { status: 'passed', model_count: 0, issue_count: 0 },
          files: {
            qa_input_summary: '/tmp/input.json',
            materialization_summary: null,
            model_summaries: '/tmp/models.jsonl',
            findings: '/tmp/findings.jsonl',
            qa_zh: '/tmp/zh.md',
            qa_en: '/tmp/en.md',
            timing: '/tmp/timing.md',
            report: '/tmp/report.json',
          },
          model_summaries: [],
          next_actions: [],
        }) as never,
    },
  );
  assert.equal(lifecycleRows.exitCode, 0);
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

test('prepush coverage covers classification edge helpers and blockers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-classification-edges-'));
  const outPath = path.join(dir, 'out.jsonl');
  try {
    assert.equal(classificationInternals.normalizeType('unit-groups'), 'unitgroup');
    assert.throws(() => classificationInternals.normalizeType('unknown-kind'), /Unsupported/u);
    assert.throws(() => classificationInternals.normalizeType(null), /Unsupported/u);
    assert.throws(
      () => classificationInternals.schemasDir([path.join(dir, 'missing')]),
      /not found/u,
    );
    assert.equal(classificationInternals.isJsonSchemaFileName('category.json'), true);
    assert.equal(classificationInternals.isJsonSchemaFileName('README.md'), false);

    const entries: Array<{
      code: string;
      text: string;
      level: number;
      value_key: '@classId' | '@catId' | '@code';
    }> = [];
    classificationInternals.collectEntriesFromNode(null, '@classId', entries);
    classificationInternals.collectEntriesFromNode(
      { const: 'X', description: 'Description X' },
      '@classId',
      entries,
    );
    classificationInternals.collectEntriesFromNode(
      {
        properties: {
          '@level': { const: '0' },
          '@code': { const: 'custom-code' },
          '#text': { const: 'Custom Text' },
        },
      },
      '@code',
      entries,
    );
    classificationInternals.collectEntriesFromNode(
      {
        properties: {
          '@level': { const: '0' },
          '#text': { const: 'Sparse Text' },
        },
      },
      '@classId',
      entries,
    );
    assert.deepEqual(entries, [
      { level: 0, code: 'X', text: 'Description X', value_key: '@code' },
      { level: 0, code: 'custom-code', text: 'Custom Text', value_key: '@code' },
    ]);
    const sparseNavigator = classificationInternals.buildNavigator([
      { level: 2, code: 'sparse-child', text: 'Sparse child', value_key: '@classId' },
    ]);
    assert.equal(sparseNavigator.parentMap.has('sparse-child'), false);
    assert.ok(
      classificationInternals.normalizePathFromClasses('process', {
        '@level': '0',
        '@classId': 'C',
        '#text': 'Manufacturing',
      }).length > 0,
    );
    assert.deepEqual(classificationInternals.normalizePathFromClasses('process', []), []);
    assert.deepEqual(classificationInternals.normalizePathFromClasses('process', [{}]), []);
    assert.deepEqual(
      classificationInternals.normalizePathFromClasses('process', [
        { '@level': '0', '@classId': 'not-a-code', '#text': 'Broken' },
      ]),
      [],
    );
    assert.deepEqual(
      classificationInternals.normalizePathFromDecision('process', {
        classification_path: ['Energy'],
        class_ids: ['1080'],
      }),
      [],
    );
    assert.deepEqual(
      classificationInternals.normalizePathFromDecision('process', {
        classification_path: ['Energy'],
        class_ids: ['1080', 'extra'],
      }),
      [],
    );
    assert.ok(
      classificationInternals.normalizePathFromDecision('process', {
        classificationPath: [
          'Manufacturing',
          'Manufacture of food products',
          'Manufacture of prepared animal feeds',
          'Manufacture of prepared animal feeds',
        ],
        classIds: ['C', '10', '108', '1080'],
      }).length > 0,
    );
    assert.deepEqual(
      classificationInternals.normalizePathFromDecision('process', {
        classification_path: 'Energy',
        class_ids: '1080',
      }),
      [],
    );
    assert.ok(
      classificationInternals.normalizePathFromDecision('process', {
        classification: {
          'common:class': [
            { '@level': '0', '@classId': 'C', '#text': 'Manufacturing' },
            { '@level': '1', '@classId': '10', '#text': 'Manufacture of food products' },
            { '@level': '2', '@classId': '108', '#text': 'Manufacture of prepared animal feeds' },
            { '@level': '3', '@classId': '1080', '#text': 'Manufacture of prepared animal feeds' },
          ],
        },
      }).length > 0,
    );
    const elementaryCode =
      classificationInternals.navigatorFor('flow-elementary').navigator.entries[0]!.code;
    const elementaryPath = classificationInternals.normalizePathFromDecision('flow-elementary', {
      classification: {
        'common:category': [{ '@level': '0', '@catId': elementaryCode, '#text': 'Emissions' }],
      },
    });
    assert.equal(classificationInternals.classCode(elementaryPath[0]), elementaryCode);
    assert.ok(
      classificationInternals.normalizePathFromDecision('process', {
        classification: {
          classes: [
            { '@level': '0', '@classId': 'C', '#text': 'Manufacturing' },
            { '@level': '1', '@classId': '10', '#text': 'Manufacture of food products' },
            { '@level': '2', '@classId': '108', '#text': 'Manufacture of prepared animal feeds' },
            { '@level': '3', '@classId': '1080', '#text': 'Manufacture of prepared animal feeds' },
          ],
        },
      }).length > 0,
    );
    const numericRowIndexBlockers: unknown[] = [];
    assert.equal(
      classificationInternals.normalizeDecision(
        { row_index: '0', type: 'process', code: '1080' },
        0,
        null,
        numericRowIndexBlockers as never,
      )?.rowIndex,
      0,
    );
    const typeMissingBlockers: Array<Record<string, unknown>> = [];
    assert.equal(
      classificationInternals.normalizeDecision(
        { dataset_id: 'row-1', code: '1080' },
        0,
        null,
        typeMissingBlockers as never,
      ),
      null,
    );
    assert.equal(typeMissingBlockers[0]?.row_index, undefined);
    const pathInvalidBlockers: Array<Record<string, unknown>> = [];
    assert.equal(
      classificationInternals.normalizeDecision(
        { dataset_id: 'row-1', type: 'process', code: 'bad-code' },
        0,
        null,
        pathInvalidBlockers as never,
      ),
      null,
    );
    assert.equal(pathInvalidBlockers[0]?.row_index, undefined);
    const classRows = classificationInternals.prepareRows('memory', [sampleProcessRow()]);
    const classContainer = classificationInternals.classificationContainer(
      classRows[0]!,
      'process',
    );
    assert.ok(classContainer && typeof classContainer === 'object');
    assert.equal(classificationInternals.classificationContainer(classRows[0]!, 'location'), null);
    assert.equal(
      classificationInternals.classificationContainer(
        {
          ...classRows[0]!,
          payload: { processDataSet: 'broken' },
          rootKey: 'processDataSet',
          informationKey: 'processInformation',
        },
        'process',
      ),
      null,
    );
    assert.equal(
      classificationInternals.classificationContainer(
        {
          ...classRows[0]!,
          payload: { processDataSet: { processInformation: 'broken' } },
          rootKey: 'processDataSet',
          informationKey: 'processInformation',
        },
        'process',
      ),
      null,
    );
    const repairedRows = classificationInternals.prepareRows('memory', [
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: null,
          },
        },
      },
    ]);
    assert.ok(classificationInternals.classificationContainer(repairedRows[0]!, 'process'));
    const flowRows = classificationInternals.prepareRows('memory', [
      {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': 'flow-1',
            },
          },
        },
      },
    ]);
    assert.equal(
      classificationInternals.setClassification(flowRows[0]!, 'flow-elementary', elementaryPath),
      true,
    );
    assert.deepEqual(
      classificationInternals.currentClassification(flowRows[0]!, 'flow-elementary'),
      elementaryPath,
    );
    assert.throws(() => classificationInternals.readDecisions('', undefined), /--decisions/u);
    const badJsonl = path.join(dir, 'bad.jsonl');
    writeFileSync(badJsonl, '1\n', 'utf8');
    assert.throws(
      () => classificationInternals.readDecisions(badJsonl, undefined),
      /not an object/u,
    );
    const decisionsJson = path.join(dir, 'decisions.json');
    writeJson(decisionsJson, {
      decisions: [{ dataset_id: 'row-1', type: 'process', code: '1080' }],
    });
    assert.equal(classificationInternals.readDecisions(decisionsJson, undefined).length, 1);
    assert.deepEqual(classificationInternals.normalizeStructuredDecisions({ rows: [{ a: 1 }] }), [
      { a: 1 },
    ]);
    assert.deepEqual(classificationInternals.normalizeStructuredDecisions({ a: 1 }), [{ a: 1 }]);
    const classificationReportWithFiles = classificationInternals.maybeWriteReport(
      {},
      dir,
      'edge.json',
    ) as { files: { report: string } };
    assert.deepEqual(classificationReportWithFiles.files, {
      report: path.join(dir, 'outputs', 'edge.json'),
    });

    const missingContainer = await runDatasetClassificationApply({
      inputPath: 'rows.jsonl',
      decisionsPath: 'decisions.json',
      outPath,
      rawInput: [{ id: 'row-1', version: '01.00.000' }],
      rawDecisions: [{ dataset_id: 'row-1', type: 'process', code: '1080' }],
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(missingContainer.status, 'blocked');
    assert.ok(
      missingContainer.blockers.some(
        (blocker) => blocker.code === 'classification_container_missing',
      ),
    );

    const targetNotFound = await runDatasetClassificationApply({
      inputPath: 'rows.jsonl',
      decisionsPath: 'decisions.json',
      outPath,
      rawInput: [{ id: 'row-1', version: '01.00.000' }],
      rawDecisions: [{ dataset_id: 'missing', type: 'process', code: '1080' }],
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.ok(
      targetNotFound.blockers.some((blocker) => blocker.code === 'classification_target_not_found'),
    );

    const applyWithoutNow = await runDatasetClassificationApply({
      inputPath: 'rows.jsonl',
      decisionsPath: 'decisions.json',
      outPath,
      rawInput: [sampleProcessRow('proc-default-now')],
      rawDecisions: [{ dataset_id: 'proc-default-now', type: 'process', code: '1080' }],
    });
    assert.match(applyWithoutNow.generated_at_utc, /\d{4}-\d{2}-\d{2}T/u);

    const locationAmbiguous = await runDatasetClassificationApply({
      inputPath: 'rows.jsonl',
      decisionsPath: 'decisions.json',
      outPath,
      rawInput: [
        {
          processDataSet: {
            processInformation: {
              dataSetInformation: {
                'common:UUID': 'row-location',
              },
              geography: {
                locationOfOperationSupplyOrProduction: {
                  '@location': 'CH',
                  location: 'RER',
                },
              },
            },
          },
        },
      ],
      rawDecisions: [{ dataset_id: 'row-location', type: 'location', code: 'CH' }],
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.ok(
      locationAmbiguous.blockers.some((blocker) => blocker.code === 'location_target_ambiguous'),
    );

    const auditWithoutNow = await runDatasetClassificationAudit({
      type: 'location',
      inputPath: 'rows.jsonl',
      rawInput: [sampleProcessRow()],
      outDir: path.join(dir, 'audit-default-now'),
    });
    assert.equal(auditWithoutNow.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepush coverage covers patch edge branches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-patch-edges-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const patchPath = path.join(dir, 'patch.json');
  const outPath = path.join(dir, 'out.jsonl');
  const packageDir = path.join(dir, 'packages');
  mkdirSync(packageDir, { recursive: true });
  writeJsonl(inputPath, [sampleProcessRow()]);

  try {
    assert.equal(
      patchInternals.normalizePatchPayload({ patch_status: 'completed', operations: [] }).patches
        .length,
      1,
    );
    assert.equal(
      patchInternals.normalizePatchPayload({
        patch_status: 'completed',
        suggestions: [{ op: 'test', path: '/x', value: 1 }],
      }).blockers[0]?.code,
      'patch_row_required',
    );
    assert.equal(
      patchInternals.normalizePatchPayload({
        patch_status: 'completed',
        items: [{ row_index: 0, operations: [] }],
      }).patches.length,
      1,
    );
    assert.equal(patchInternals.caughtErrorMessage(new Error('error message')), 'error message');
    assert.equal(patchInternals.caughtErrorMessage('string failure'), 'string failure');
    assert.equal(patchInternals.normalizeClosure('   '), null);

    const arrayParent = { items: [{ name: 'a' }] };
    const arrayNestedTarget = patchInternals.resolvePatchTarget(
      arrayParent,
      '/items/0/name',
      false,
    );
    assert.equal(patchInternals.getTargetValue(arrayNestedTarget), 'a');
    const arrayReplaceTarget = patchInternals.resolvePatchTarget(arrayParent, '/items/0', false);
    patchInternals.setTargetValue(arrayReplaceTarget, { name: 'b' }, false);
    assert.deepEqual(arrayParent.items, [{ name: 'b' }]);
    const rootArrayTarget = patchInternals.resolvePatchTarget(
      [{ name: 'root-array' }] as never,
      '/0',
      false,
    );
    assert.deepEqual(patchInternals.getTargetValue(rootArrayTarget), { name: 'root-array' });
    assert.throws(
      () => patchInternals.getTargetValue({ container: {}, key: 'missing' } as never),
      /does not exist/u,
    );
    assert.throws(
      () =>
        patchInternals.applyOperation(
          {},
          { op: 'replace', path: '/missing', value: 'x', basis: 'evidence' },
        ),
      /does not exist/u,
    );
    assert.throws(
      () => patchInternals.resolvePatchTarget({ a: 1 }, '/a/b', false),
      /Patch parent is not an object or array/u,
    );
    assert.throws(
      () => patchInternals.resolvePatchTarget({ a: 1 }, '/a/b/c', false),
      /Patch parent is not an object or array/u,
    );

    writeJson(path.join(packageDir, 'process-id-only.json'), {
      process_id: 'package-proc',
      version: '02.00.000',
    });
    const patchWithPackageFallback = patchInternals.normalizePatchPayload({
      patch_status: 'completed',
      dataset_id: 'patch-proc',
      dataset_version: '01.00.000',
      authoring_package: 'process-id-only.json',
      operations: [],
    }).patches[0]!;
    const packageFallback = patchInternals.readAuthoringPackageContext({
      patch: patchWithPackageFallback,
      rowIndex: 0,
      rowId: null,
      rowVersion: null,
      patchIndex: 0,
      authoringPackageDir: packageDir,
    });
    assert.deepEqual(packageFallback.context?.actionItems, []);
    assert.ok(
      packageFallback.blockers.some(
        (blocker) => blocker.code === 'authoring_package_entity_mismatch',
      ),
    );
    assert.ok(
      packageFallback.blockers.some(
        (blocker) => blocker.code === 'authoring_package_version_mismatch',
      ),
    );

    writeJson(path.join(packageDir, 'mismatch.json'), {
      entity_id: 'other',
      version: '99.00.000',
      action_items: [{ code: 'known', path: '/x' }],
    });
    writeJson(patchPath, {
      patch_status: 'completed',
      patches: [
        {
          row_index: 0,
          authoring_package: 'mismatch.json',
          operations: [
            {
              op: 'replace',
              path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
              value: 'new',
              basis: 'evidence',
              closes_action_items: [{ code: 'unknown', path: '/x' }],
            },
          ],
        },
      ],
    });
    const mismatch = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      authoringPackageDir: packageDir,
      requireActionItemClosure: true,
    });
    assert.ok(
      mismatch.blockers.some((blocker) => blocker.code === 'authoring_package_entity_mismatch'),
    );
    assert.ok(
      mismatch.blockers.some((blocker) => blocker.code === 'authoring_package_version_mismatch'),
    );
    assert.equal(
      patchInternals.resolveAuthoringPackagePath(path.join(packageDir, 'mismatch.json'), null),
      path.join(packageDir, 'mismatch.json'),
    );

    writeJson(patchPath, {
      patch_status: 'completed',
      patches: [
        {
          row_index: 99,
          operations: [{ op: 'test', path: '/x', value: 1 }],
        },
      ],
    });
    const invalidTarget = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
    });
    assert.ok(invalidTarget.blockers.some((blocker) => blocker.code === 'patch_row_index_invalid'));

    const noIdentityInputPath = path.join(dir, 'no-identity.jsonl');
    writeJsonl(noIdentityInputPath, [
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              name: { baseName: { '#text': 'No identity process' } },
            },
          },
        },
      },
    ]);
    writeJson(patchPath, {
      patch_status: 'completed',
      patches: [{ row_index: 0, operations: [] }],
    });
    const noIdentity = await runDatasetPatchApply({
      inputPath: noIdentityInputPath,
      patchPath,
      outPath,
    });
    assert.ok(noIdentity.blockers.some((blocker) => blocker.code === 'patch_operations_missing'));

    writeFileSync(path.join(packageDir, 'bad.json'), '{bad json', 'utf8');
    writeJson(patchPath, {
      patch_status: 'completed',
      patches: [
        {
          row_index: 0,
          authoring_package: 'bad.json',
          operations: [{ op: 'test', path: '/x', value: 1 }],
        },
      ],
    });
    const invalidPackage = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      authoringPackageDir: packageDir,
    });
    assert.ok(
      invalidPackage.blockers.some((blocker) => blocker.code === 'authoring_package_invalid'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepush coverage covers save-draft and import-lca edge branches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-save-draft-edges-'));
  try {
    const originalContactSchema = saveDraftInternals.DATASET_CONFIGS.contact.schemaName;
    try {
      saveDraftInternals.DATASET_CONFIGS.contact.schemaName = 'MissingSchema' as never;
      assert.throws(
        () =>
          saveDraftInternals.validatePayload(
            { contactDataSet: {} },
            'contact',
            saveDraftInternals.DATASET_CONFIGS.contact,
          ),
        /MissingSchema/u,
      );
    } finally {
      saveDraftInternals.DATASET_CONFIGS.contact.schemaName = originalContactSchema;
    }
    const originalContactFactory = saveDraftInternals.DATASET_CONFIGS.contact.factoryName;
    try {
      saveDraftInternals.DATASET_CONFIGS.contact.factoryName = 'MissingFactory' as never;
      assert.equal(
        saveDraftInternals.validatePayload(
          { contactDataSet: {} },
          'contact',
          saveDraftInternals.DATASET_CONFIGS.contact,
        ).ok,
        false,
      );
    } finally {
      saveDraftInternals.DATASET_CONFIGS.contact.factoryName = originalContactFactory;
    }

    assert.deepEqual(saveDraftInternals.normalizeValidationIssue({ path: ['a', 0] }), {
      path: 'a.0',
      message: 'Validation failed',
      code: 'custom',
    });
    assert.deepEqual(
      saveDraftInternals.normalizeValidationIssue({ message: 'Explicit', code: 'explicit' }),
      {
        path: '<root>',
        message: 'Explicit',
        code: 'explicit',
      },
    );
    assert.equal(
      saveDraftInternals.remoteReferenceFallbackKey({ path: 'payload.ref', type: null }),
      'payload.ref:unknown',
    );
    assert.equal(saveDraftInternals.compareVersions('01.alpha', '01.beta'), -1);
    assert.equal(saveDraftInternals.compareVersions('01.beta', '01.alpha'), 1);
    assert.equal(saveDraftInternals.compareVersions('02', '01'), 1);
    assert.equal(saveDraftInternals.compareVersions('01.02', '01'), 1);
    assert.equal(saveDraftInternals.compareVersions('01', '01.02'), -1);
    assert.match(
      saveDraftInternals.defaultOutDir(
        path.join(dir, 'rows.jsonl'),
        true,
        new Date('2026-06-04T00:00:00.000Z'),
      ),
      /commit-2026-06-04T000000000Z/u,
    );
    assert.match(
      saveDraftInternals.defaultOutDir(
        path.join(dir, 'rows.jsonl'),
        false,
        new Date('2026-06-04T00:00:00.000Z'),
      ),
      /dry-run-2026-06-04T000000000Z/u,
    );
    assert.equal(
      saveDraftInternals.flowType({ flowDataSet: { modellingAndValidation: {} } }),
      null,
    );
    assert.deepEqual(
      saveDraftInternals.parseVisibleRows(
        [{ id: 1, version: 2, state_code: '0' }],
        'https://example.test',
      ),
      [{ id: '', version: '', user_id: null, state_code: null }],
    );
    assert.deepEqual(
      saveDraftInternals.parseVisibleRows(
        [{ id: '   ', version: '   ', user_id: ' user-1 ', state_code: 0 }],
        'https://example.test',
      ),
      [{ id: '', version: '', user_id: 'user-1', state_code: 0 }],
    );
    assert.equal(
      saveDraftInternals.buildPreparedFailure({
        index: 0,
        id: 'proc-1',
        version: '01.00.000',
        type: 'process',
        table: 'processes',
        config: saveDraftInternals.DATASET_CONFIGS.process,
        row: {},
        payload: {},
        validation: null,
      } as never)?.error?.message,
      'Local dataset validation failed with 0 issue(s).',
    );

    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: 'rows.jsonl',
          rawInput: [],
          type: 'contact',
          commit: true,
        }),
      /requires env and fetch runtime/u,
    );
    const preparedFailure = await runDatasetSaveDraft({
      inputPath: 'rows.jsonl',
      rawInput: [{}],
      type: 'auto',
      outDir: path.join(dir, 'save-draft-out'),
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(preparedFailure.rows[0]?.operation, 'type_unknown');

    const contract = await runDatasetContract({
      type: 'contact',
      outDir: path.join(dir, 'contract'),
      include: ['schema'],
      mode: 'contract',
      sdkModule: {},
    });
    assert.equal(contract.source, 'sdk-runtime-assets');
    assert.ok(contractInternals.resolveSdkRuntimeAssetsRoot().length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepush coverage covers maintenance delete failures and readback catch', async () => {
  const row = {
    table: 'processes' as const,
    id: 'proc-1',
    version: '01.00.000',
    user_id: 'user-1',
    state_code: 0,
    modified_at: null,
  };
  const failures = await maintenanceInternals.deleteTableRows({
    transport: {
      functionsBaseUrl: 'https://example.com/functions/v1',
      publishableKey: 'pub',
      accessToken: 'token',
      timeoutMs: 1000,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ error: 'nope' }),
      }),
    },
    table: 'processes',
    rows: [row],
  });
  assert.equal(failures.failures.length, 1);
  assert.equal(
    maintenanceInternals.caughtErrorMessage(new Error('maintenance error')),
    'maintenance error',
  );
  assert.equal(maintenanceInternals.caughtErrorMessage('maintenance string'), 'maintenance string');
  assert.equal(maintenanceInternals.normalizePageSize(undefined), 1000);
  assert.equal(maintenanceInternals.normalizeEmail(null), '');
  assert.equal(maintenanceInternals.normalizeTimeoutMs(undefined), 10000);
  assert.equal(maintenanceInternals.normalizeTimeoutMs(2500), 2500);
  assert.deepEqual(maintenanceInternals.normalizeStateCodes([0, 0, 2]), [0, 2]);
  assert.deepEqual(maintenanceInternals.normalizeStateCodes([]), null);
  assert.equal(
    (
      await maintenanceInternals.fetchCurrentUser({
        projectBaseUrl: 'https://example.com',
        publishableKey: 'pub',
        accessToken: 'token',
        timeoutMs: 1000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ id: 'user-1', email: '   ' }),
        }),
      })
    ).email,
    null,
  );
  await assert.rejects(
    () =>
      maintenanceInternals.fetchCurrentUser({
        projectBaseUrl: 'https://example.com',
        publishableKey: 'pub',
        accessToken: 'token',
        timeoutMs: 1000,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify(null),
        }),
      }),
    /without a user id/u,
  );

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-maintenance-edges-'));
  let sawCurrentUser = false;
  let processReadCount = 0;
  try {
    const report = await runDatasetMaintenanceClearAccount({
      outDir: dir,
      stateCodes: [0],
      pageSize: 1,
      commit: true,
      confirm: 'private-account@example.test',
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv({ TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1' }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/auth/v1/user')) {
          sawCurrentUser = true;
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({ id: 'user-1', email: 'private-account@example.test' }),
          };
        }
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({ email: 'private-account@example.test' });
        }
        if (url.includes('/rest/v1/')) {
          const parsedUrl = new URL(url);
          let body: unknown = [];
          if (url.includes('/processes?') && parsedUrl.searchParams.get('offset') === '0') {
            if (processReadCount === 0) {
              body = [
                {
                  id: 'proc-1',
                  version: '01.00.000',
                  user_id: 'user-1',
                  state_code: 0,
                },
              ];
            } else if (processReadCount === 1) {
              body = { not: 'an array' };
            }
            processReadCount += 1;
          }
          return {
            ok: true,
            status: 200,
            headers: maintenanceJsonHeaders(body),
            text: async () => JSON.stringify(body),
          };
        }
        if (url.endsWith('/functions/v1/app_dataset_delete')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ ok: true }),
          };
        }
        return {
          ok: false,
          status: 500,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ error: 'delete failed' }),
        };
      },
    });
    assert.equal(sawCurrentUser, true);
    assert.equal(report.status, 'completed_with_failures');
    assert.ok(report.tables.some((table) => table.status === 'failed'));

    await assert.rejects(
      () =>
        runDatasetMaintenanceClearAccount({
          outDir: path.join(dir, 'confirm-missing'),
          stateCodes: [0],
          commit: true,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
          }),
          fetchImpl: async (input) => {
            const url = String(input);
            if (isSupabaseAuthTokenUrl(url)) {
              return makeSupabaseAuthResponse({ email: 'private-account@example.test' });
            }
            if (url.endsWith('/auth/v1/user')) {
              return {
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                text: async () => JSON.stringify({ id: 'user-1' }),
              };
            }
            return {
              ok: true,
              status: 200,
              headers: { get: () => 'application/json' },
              text: async () => JSON.stringify([]),
            };
          },
        }),
      /requires --confirm/u,
    );

    let deleteFailureReadCount = 0;
    const deleteFailureReport = await runDatasetMaintenanceClearAccount({
      outDir: path.join(dir, 'delete-failure'),
      stateCodes: [0],
      pageSize: 2,
      commit: true,
      confirm: 'private-account@example.test',
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv({ TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1' }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({ email: 'private-account@example.test' });
        }
        if (url.endsWith('/auth/v1/user')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({ id: 'user-1', email: 'private-account@example.test' }),
          };
        }
        if (url.includes('/rest/v1/processes?')) {
          deleteFailureReadCount += 1;
          const body =
            deleteFailureReadCount === 1
              ? [
                  {
                    id: 'proc-delete-failure',
                    version: '01.00.000',
                    user_id: 'user-1',
                    state_code: 0,
                  },
                ]
              : [];
          return {
            ok: true,
            status: 200,
            headers: maintenanceJsonHeaders(body),
            text: async () => JSON.stringify(body),
          };
        }
        if (url.includes('/rest/v1/')) {
          const body: unknown[] = [];
          return {
            ok: true,
            status: 200,
            headers: maintenanceJsonHeaders(body),
            text: async () => JSON.stringify(body),
          };
        }
        if (url.endsWith('/functions/v1/app_dataset_delete')) {
          return {
            ok: false,
            status: 500,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ error: 'delete failed' }),
          };
        }
        return {
          ok: false,
          status: 500,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ error: 'unexpected' }),
        };
      },
    });
    assert.ok(deleteFailureReadCount >= 2);
    const processDeleteFailure = deleteFailureReport.tables.find(
      (table) => table.table === 'processes',
    );
    assert.match(processDeleteFailure?.error ?? '', /row delete request/u);
    assert.doesNotMatch(processDeleteFailure?.error ?? '', /remained after delete readback/u);
    assert.match(processDeleteFailure?.error ?? '', /proc-delete-failure/u);

    let invalidIdentityReadCount = 0;
    await assert.rejects(
      () =>
        runDatasetMaintenanceClearAccount({
          outDir: path.join(dir, 'delete-invalid-identity'),
          stateCodes: [0],
          pageSize: 2,
          commit: true,
          confirm: 'private-account@example.test',
          now: new Date('2026-06-04T00:00:00.000Z'),
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
          }),
          fetchImpl: async (input) => {
            const url = String(input);
            if (isSupabaseAuthTokenUrl(url)) {
              return makeSupabaseAuthResponse({ email: 'private-account@example.test' });
            }
            if (url.endsWith('/auth/v1/user')) {
              return {
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                text: async () =>
                  JSON.stringify({ id: 'user-1', email: 'private-account@example.test' }),
              };
            }
            if (url.includes('/rest/v1/processes?')) {
              invalidIdentityReadCount += 1;
              const body =
                invalidIdentityReadCount === 1
                  ? [
                      {
                        user_id: 'user-1',
                        state_code: 0,
                      },
                    ]
                  : [];
              return {
                ok: true,
                status: 200,
                headers: maintenanceJsonHeaders(body),
                text: async () => JSON.stringify(body),
              };
            }
            if (url.includes('/rest/v1/')) {
              const body: unknown[] = [];
              return {
                ok: true,
                status: 200,
                headers: maintenanceJsonHeaders(body),
                text: async () => JSON.stringify(body),
              };
            }
            return {
              ok: false,
              status: 500,
              headers: { get: () => 'application/json' },
              text: async () => JSON.stringify({ error: 'unexpected' }),
            };
          },
        }),
      /invalid account row/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepush coverage covers remote verify root readback and helper edges', async () => {
  assert.deepEqual(
    remoteVerifyInternals.sha256Json([{ b: 2, a: 1 }]),
    remoteVerifyInternals.sha256Json([{ a: 1, b: 2 }]),
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ id: 'row-1', version: 'v1', json: { a: 1 } })
      ?.payload?.a,
    1,
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ id: 'row-empty', version: 'v1' })?.payload,
    null,
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ version: 'v1', json_ordered: {} })?.id,
    '',
  );
  assert.equal(remoteVerifyInternals.normalizePayloadRow(null), null);
  assert.deepEqual(remoteVerifyInternals.normalizeRows([{ id: 1 }, { id: 'ok' }]), [
    { id: 'ok', version: null },
  ]);

  const report = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        id: 'proc-1',
        version: '01.00.000',
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-edges'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    lookupDatasetImpl: async () => ({
      exact: { id: 'proc-1', version: '01.00.000' },
      latest: { id: 'proc-1', version: '01.00.000' },
      exact_source_url: 'https://example.test/processes',
      latest_source_url: 'https://example.test/processes',
    }),
    lookupRootPayloadImpl: async () => {
      throw new Error('lookup failed');
    },
  });
  assert.ok(report.blockers.some((blocker) => blocker.code === 'lookup_failed'));

  const noRuntimeReadback = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        id: 'proc-1',
        version: '01.00.000',
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-no-runtime'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    lookupDatasetImpl: async () => ({
      exact: { id: 'proc-1', version: '01.00.000' },
      latest: { id: 'proc-1', version: '01.00.000' },
      exact_source_url: null,
      latest_source_url: null,
    }),
  });
  assert.ok(noRuntimeReadback.blockers.some((blocker) => blocker.code === 'lookup_failed'));

  const missingOwnerStateChecks = remoteVerifyInternals.rootReadbackChecks({
    reference: {
      role: 'root',
      table: 'processes',
      type: 'process',
      id: 'proc-1',
      version: '01.00.000',
      path: '$',
      row_index: 0,
      short_description: null,
    },
    localPayload: {},
    remote: {
      id: 'proc-1',
      version: '01.00.000',
      user_id: null,
      state_code: null,
      modified_at: null,
      payload: {},
      source_url: null,
    },
    compareRootPayload: false,
    targetUserId: 'user-1',
    stateCode: 0,
  });
  assert.ok(missingOwnerStateChecks.some((check) => /<missing>/u.test(check.message)));

  let sawDefaultRootPayloadLookup = false;
  const defaultLookupReport = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-default-root'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    targetUserId: 'user-1',
    stateCode: 0,
    env: buildSupabaseTestEnv(),
    fetchImpl: async (input) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) {
        return makeSupabaseAuthResponse({ accessToken: 'remote-token' });
      }
      if (url.includes('/rest/v1/processes?')) {
        sawDefaultRootPayloadLookup = true;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify([
              {
                id: 'proc-1',
                version: '01.00.000',
                user_id: 'user-1',
                state_code: 0,
                json_ordered: {
                  processDataSet: {
                    processInformation: {
                      dataSetInformation: { 'common:UUID': 'proc-1' },
                    },
                    administrativeInformation: {
                      publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
                    },
                  },
                },
              },
            ]),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify([]),
      };
    },
  });
  assert.equal(sawDefaultRootPayloadLookup, true);
  assert.equal(defaultLookupReport.status, 'passed_remote_verification');

  const payloadRuntime = {
    apiBaseUrl: 'https://example.com/functions/v1',
    publishableKey: 'pub',
    getAccessToken: async () => 'token',
  };
  const missingPayload = await remoteVerifyInternals.lookupRemoteDatasetPayload({
    runtime: payloadRuntime,
    timeoutMs: 1000,
    request: {
      table: 'processes',
      id: 'missing',
      version: '01.00.000',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify([]),
    }),
  });
  assert.equal(missingPayload, null);
  const nonArrayPayload = await remoteVerifyInternals.lookupRemoteDatasetPayload({
    runtime: payloadRuntime,
    timeoutMs: 1000,
    request: {
      table: 'processes',
      id: 'object-row',
      version: '01.00.000',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 'object-row', version: '01.00.000' }),
    }),
  });
  assert.equal(nonArrayPayload, null);
});

test('prepush coverage covers curation and identity helper edges', async () => {
  const curationDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-edges-'));
  try {
    const checkpointPath = path.join(curationDir, 'checkpoint.json');
    writeJson(checkpointPath, {});
    assert.equal(curationInternals.readCheckpointStatus(checkpointPath), 'blocked');

    const processesPath = path.join(curationDir, 'processes.jsonl');
    const flowsPath = path.join(curationDir, 'flows.jsonl');
    writeJsonl(processesPath, [
      {
        id: 'process-1',
        version: '01.00.000',
        json_ordered: {
          processDataSet: {
            processInformation: {
              dataSetInformation: {
                'common:UUID': 'process-1',
              },
            },
            exchanges: {
              exchange: [
                {
                  referenceToFlowDataSet: {
                    '@refObjectId': 'missing-flow',
                    '@version': '01.00.000',
                  },
                },
              ],
            },
            administrativeInformation: {
              publicationAndOwnership: {
                'common:dataSetVersion': '01.00.000',
              },
            },
          },
        },
      },
    ]);
    writeJsonl(flowsPath, []);
    const queueReport = await runDatasetCurationQueueBuild({
      processesPath,
      flowsPath,
      outDir: path.join(curationDir, 'queue'),
    });
    assert.equal(queueReport.status, 'blocked');
    assert.equal(queueReport.blockers[0]?.code, 'process_flow_reference_unresolved');

    const deferredProcessesPath = path.join(curationDir, 'deferred-processes.jsonl');
    writeJsonl(deferredProcessesPath, [
      {
        id: 'process-deferred',
        version: '01.00.000',
        json_ordered: {
          processDataSet: {
            processInformation: {
              dataSetInformation: {
                'common:UUID': 'process-deferred',
                'common:other': {
                  'tiangongfoundry:unresolvedTrace': [
                    {
                      action_item_code: 'elementary_flow_identity_manual_review',
                      reference_id: 'deferred-flow',
                      reference_version: '01.00.000',
                      blocked_path: 'processDataSet.exchanges.exchange.0.referenceToFlowDataSet',
                    },
                  ],
                },
              },
            },
            exchanges: {
              exchange: [
                {
                  referenceToFlowDataSet: {
                    '@refObjectId': 'deferred-flow',
                    '@version': '01.00.000',
                  },
                },
              ],
            },
            administrativeInformation: {
              publicationAndOwnership: {
                'common:dataSetVersion': '01.00.000',
              },
            },
          },
        },
      },
    ]);
    const deferredQueue = await runDatasetCurationQueueBuild({
      processesPath: deferredProcessesPath,
      outDir: path.join(curationDir, 'deferred-queue'),
    });
    const processTask = deferredQueue.tasks.find((task) => task.entity_type === 'process');
    assert.ok(processTask);
    const closure = JSON.parse(readFileSync(processTask.closure_file, 'utf8')) as {
      dependencies?: { deferred_refs?: Array<{ reason: string | null }> };
    };
    assert.equal(closure.dependencies?.deferred_refs?.[0]?.reason, null);

    assert.equal(
      curationInternals.parseQueueBlocker(
        {
          code: 'blocked',
          entity_type: 'flow',
          entity_id: 'flow-string',
          version: '01.00.000',
          message: 'Blocked',
        },
        'blockers.jsonl',
        1,
      ).version,
      '01.00.000',
    );
  } finally {
    rmSync(curationDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    curationInternals.parseQueueTask(
      {
        entity_type: 'flow',
        task_id: 'flow:1',
        entity_id: 'flow-1',
        version: '01.00.000',
        lock_key: 'flow:1',
        depends_on: ['a', 1],
        input_rows_file: 'input.jsonl',
        work_dir: 'work',
        checkpoint_file: 'checkpoint.json',
        run_plan_file: 'plan.json',
        closure_file: 'closure.json',
      },
      'tasks.jsonl',
      0,
    ).depends_on,
    ['a'],
  );
  assert.deepEqual(
    curationInternals.parseQueueTask(
      {
        entity_type: 'flow',
        task_id: 'flow:2',
        entity_id: 'flow-2',
        version: '01.00.000',
        lock_key: 'flow:2',
        input_rows_file: 'input.jsonl',
        work_dir: 'work',
        checkpoint_file: 'checkpoint.json',
        run_plan_file: 'plan.json',
        closure_file: 'closure.json',
      },
      'tasks.jsonl',
      1,
    ).depends_on,
    [],
  );
  assert.equal(
    curationInternals.parseQueueBlocker(
      {
        code: 'blocked',
        entity_type: 'flow',
        entity_id: 123,
        version: 456,
        message: 'Blocked',
      },
      'blockers.jsonl',
      0,
    ).entity_id,
    null,
  );
  assert.equal(
    curationInternals.extractProcessFlowRefs({
      exchanges: {
        exchange: {
          referenceToFlowDataSet: {
            '@refObjectId': 'flow-1',
            '@version': '01.00.000',
          },
        },
      },
    })[0]?.path,
    'exchanges.exchange.referenceToFlowDataSet',
  );
  assert.deepEqual(
    curationInternals.extractDeferredProcessFlowRefs({
      'tiangongfoundry:unresolvedTrace': [
        null,
        { action_item_code: 'other' },
        { action_item_code: 'elementary_flow_identity_manual_review' },
        {
          action_item_code: 'elementary_flow_identity_manual_review',
          reference_id: 'flow-deferred',
          blocked_path: '/exchanges/0/referenceToFlowDataSet',
          reference_version: '01.00.000',
          reason: 'manual review',
        },
      ],
    }),
    [
      {
        id: 'flow-deferred',
        version: '01.00.000',
        path: 'exchanges.0.referenceToFlowDataSet',
        actionItemCode: 'elementary_flow_identity_manual_review',
        reason: 'manual review',
      },
    ],
  );
  assert.equal(curationInternals.normalizeReferencePath('/a//b'), 'a.b');
  assert.equal(
    curationInternals.extractDeferredProcessFlowRefs({
      'tiangongfoundry:unresolvedTrace': {
        action_item_code: 'elementary_flow_identity_manual_review',
        reference_id: 'flow-single',
        blocked_path: '/x',
      },
    })[0]?.id,
    'flow-single',
  );
  assert.deepEqual(
    curationInternals
      .extractDeferredProcessFlowRefs({
        'tiangongfoundry:unresolvedTrace': [
          {
            action_item_code: 'elementary_flow_identity_manual_review',
            reference_id: 'flow-b',
            blocked_path: '/z',
          },
          {
            action_item_code: 'elementary_flow_identity_manual_review',
            reference_id: 'flow-a',
            reference_version: '01.00.000',
            blocked_path: '/a',
          },
        ],
      })
      .map((ref) => `${ref.id}@${ref.version ?? ''}@${ref.path}`),
    ['flow-a@01.00.000@a', 'flow-b@@z'],
  );
  assert.deepEqual(
    curationInternals
      .extractDeferredProcessFlowRefs({
        'tiangongfoundry:unresolvedTrace': [
          {
            action_item_code: 'elementary_flow_identity_manual_review',
            reference_id: 'flow-d',
            blocked_path: '/d',
          },
          {
            action_item_code: 'elementary_flow_identity_manual_review',
            reference_id: 'flow-c',
            blocked_path: '/c',
          },
        ],
      })
      .map((ref) => `${ref.id}@${ref.version ?? ''}@${ref.path}`),
    ['flow-c@@c', 'flow-d@@d'],
  );
  assert.deepEqual(curationInternals.jsonLines([]), '');

  const processProfile = identityInternals.processProfile({
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          name: { baseName: 'Process with category' },
          classificationInformation: {
            'common:classification': {
              'common:class': {
                '@level': '0',
                '@classId': '1080',
                '#text': 'Energy',
              },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(processProfile.fields.categories, ['1080', 'Energy']);
  assert.deepEqual(
    identityInternals.remoteSearchOptions({
      enabled: true,
      query: null,
      filter: null,
      profileHints: null,
      limit: null,
      dataSource: null,
      matchThreshold: null,
      lexicalWeight: null,
      semanticWeight: null,
      rrfK: null,
      pageSize: 20,
      pageCurrent: 2,
    }),
    { page_size: 20, page_current: 2 },
  );
  const selectedReferenceExchange = identityInternals.processReferenceExchange({
    processInformation: {
      quantitativeReference: {
        referenceToReferenceFlow: '7',
      },
    },
    exchanges: {
      exchange: {
        '@dataSetInternalID': '7',
        referenceToFlowDataSet: { '@refObjectId': 'flow-7' },
      },
    },
  });
  assert.equal(
    (selectedReferenceExchange?.referenceToFlowDataSet as Record<string, unknown> | undefined)?.[
      '@refObjectId'
    ],
    'flow-7',
  );
  const fallbackReferenceExchange = identityInternals.processReferenceExchange({
    processInformation: {
      quantitativeReference: {
        referenceToReferenceFlow: '7',
      },
    },
    exchanges: {
      exchange: {
        referenceToFlowDataSet: { '@refObjectId': 'flow-fallback' },
      },
    },
  });
  assert.equal(
    (fallbackReferenceExchange?.referenceToFlowDataSet as Record<string, unknown> | undefined)?.[
      '@refObjectId'
    ],
    'flow-fallback',
  );
  assert.equal(
    identityInternals.identityKeyFromProfile(
      'process',
      [],
      {
        geography: ['not-scalar'],
        time: null,
        operation: null,
        quantitative_reference: null,
        technology_route: null,
        system_boundary: null,
        provider_role: null,
        reference_flow_ids: [],
        reference_flow_names: [],
        categories: [],
      },
      [],
    ),
    '',
  );
  assert.equal(
    identityInternals.identityKeyFromProfile(
      'flow',
      [],
      {
        type_of_dataset: null,
        cas: null,
        flow_property: ['not-scalar'],
        reference_unit: null,
        categories: [],
        geography: null,
      },
      [],
    ),
    '',
  );
  const hintedFlow = identityInternals.applyIdentityProfileHints(
    identityInternals.flowProfile({
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            name: { baseName: 'Old flow' },
          },
        },
      },
    }),
    {
      names: ['New flow'],
      categories: ['Emissions'],
      cas: '7732-18-5',
      flow_property: 'Mass',
    },
    'flow',
  );
  assert.deepEqual(hintedFlow.names, ['New flow']);
  assert.deepEqual(hintedFlow.fields.categories, ['Emissions']);
  assert.equal(hintedFlow.fields.cas, '7732-18-5');
  assert.equal(identityInternals.sameCasField(['7732-18-5'], '7732185'), true);
  assert.equal(identityInternals.sameCasField('7732185', ['7732-18-5']), true);
});

test('prepush coverage covers lifecyclemodel and process required field helpers', async () => {
  assert.equal(lifecyclemodelQaInternals.sanitizeFileName(null), 'missing');
  assert.equal(lifecyclemodelQaInternals.sanitizeFileName('@@@'), 'missing');
  await assert.rejects(
    async () =>
      runLifecyclemodelQa({
        rowsFile: 'rows.jsonl',
        runDir: 'run',
        outDir: 'out',
      }),
    /either --rows-file or --run-dir/u,
  );
  assert.throws(
    () =>
      lifecyclemodelQaInternals.materializeRowsFile({
        rowsFile: path.join(os.tmpdir(), 'missing-lifecyclemodels.jsonl'),
      } as never),
    /rows file not found/u,
  );
  const lifecycleDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-edges-'));
  try {
    const rowsFile = path.join(lifecycleDir, 'rows.jsonl');
    writeJsonl(rowsFile, [{ processDataSet: {} }]);
    await assert.rejects(
      async () =>
        runLifecyclemodelQa({
          rowsFile,
          outDir: path.join(lifecycleDir, 'out'),
        }),
      /Expected lifecyclemodel row/u,
    );
    const lifecycleRowsFile = path.join(lifecycleDir, 'lifecyclemodels.jsonl');
    writeJsonl(lifecycleRowsFile, [
      {
        version: '01.00.000',
        json_ordered: {
          lifeCycleModelDataSet: {
            lifeCycleModelInformation: {
              dataSetInformation: {},
              technology: {
                processes: {
                  processInstance: { '@id': '1', '@multiplicationFactor': '1' },
                },
              },
            },
          },
        },
      },
    ]);
    const lifecycleReport = await runLifecyclemodelQa({
      rowsFile: lifecycleRowsFile,
      outDir: path.join(lifecycleDir, 'lifecycle-out'),
      now: () => new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(lifecycleReport.input_mode, 'rows_file');

    const flowsDir = path.join(lifecycleDir, 'flows');
    mkdirSync(flowsDir, { recursive: true });
    writeJson(path.join(flowsDir, 'flow.json'), {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': 'flow-qa-1',
            name: { baseName: { '@xml:lang': 'en', '#text': 'Flow QA sample' } },
          },
        },
      },
    });
    const flowQaReport = await runFlowQa({
      flowsDir,
      outDir: path.join(lifecycleDir, 'flow-qa-out'),
      now: () => new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(flowQaInternals.reportRowsFile(null), '');
    assert.equal(
      flowQaInternals.reportRowsFile(flowQaReport.files.qa_input_summary),
      flowQaReport.files.qa_input_summary,
    );
    assert.equal(flowQaReport.rows_file, '');
    const flowRowsFile = path.join(lifecycleDir, 'flow-rows.jsonl');
    writeJsonl(flowRowsFile, [
      {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': 'flow-qa-row-1',
              name: { baseName: { '@xml:lang': 'en', '#text': 'Flow QA row sample' } },
            },
          },
        },
      },
    ]);
    const flowRowsQaReport = await runFlowQa({
      rowsFile: flowRowsFile,
      outDir: path.join(lifecycleDir, 'flow-qa-rows-out'),
      now: () => new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(flowRowsQaReport.rows_file, flowRowsFile);
  } finally {
    rmSync(lifecycleDir, { recursive: true, force: true });
  }

  const deferred = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      modellingAndValidation: {
        complianceDeclarations: {
          compliance: {
            'tiangongfoundry:unresolvedTrace': {
              action_item_code: 'annual_supply_or_production_volume_missing',
              blocked_path:
                'processDataSet.modellingAndValidation.complianceDeclarations.compliance.dataSources.annualSupplyOrProductionVolume',
              status: 'needs_followup',
            },
          },
        },
      },
    },
  });
  assert.equal(
    deferred.some((issue) => issue.code === 'annual_supply_or_production_volume_missing'),
    false,
  );
  // A legacy deferred trace is not annual-volume evidence. The collector used to consult a
  // bypass predicate for exactly these trace shapes; the real external behavior is that a
  // complete, side-effect-free payload keeps reporting the evidence gap whatever the trace says.
  for (const legacyTrace of [
    {
      blocked_path:
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      status: 'needs_followup',
    },
    {
      fieldPath:
        'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      decisionStatus: 'deferred_to_common_other',
    },
    { path: 'nested.annualSupplyOrProductionVolume', status: 'unresolved_deferred' },
  ]) {
    const payload = {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': '77777777-7777-4777-8777-777777777777',
            'common:other': { 'tiangongfoundry:unresolvedTrace': legacyTrace },
          },
        },
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [],
          },
        },
      },
    };
    const before = JSON.stringify(payload);
    assert.equal(
      processRequiredInternals
        .collectProcessRequiredFieldIssues(payload)
        .some((issue) => issue.code === 'annual_supply_or_production_volume_missing'),
      true,
      `legacy trace must not waive the gap: ${JSON.stringify(legacyTrace)}`,
    );
    assert.equal(JSON.stringify(payload), before, 'issue collection must not mutate its input');
  }
  const deferredWithDataSources = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:other': {
            'tiangongfoundry:unresolvedTrace': {
              action_item_code: 'invalid_format',
              blocked_path:
                'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
              status: 'deferred_to_common_other',
            },
          },
        },
      },
      modellingAndValidation: {
        dataSourcesTreatmentAndRepresentativeness: {},
      },
    },
  });
  assert.equal(
    deferredWithDataSources.some(
      (issue) => issue.code === 'annual_supply_or_production_volume_missing',
    ),
    true,
    'a deferred_to_common_other trace is not evidence and must not waive the annual-volume gap',
  );

  const missingDataSources = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      modellingAndValidation: {
        complianceDeclarations: {
          compliance: {},
        },
      },
    },
  });
  assert.equal(
    missingDataSources.some((issue) => issue.code === 'process_data_sources_treatment_missing'),
    true,
  );
  assert.equal(
    supabaseClientInternals.postgrestInvalidJsonDetails({
      message: 'bad',
      details: '',
    } as never),
    'bad',
  );
  assert.equal(
    supabaseClientInternals.postgrestInvalidJsonDetails({
      message: '',
      details: '',
    } as never),
    'invalid JSON response',
  );
});
