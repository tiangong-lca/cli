import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __testInternals as classificationInternals,
  runDatasetClassificationApply,
  runDatasetClassificationAudit,
} from '../src/lib/dataset-classification.js';

import {
  __testInternals as maintenanceInternals,
  runDatasetMaintenanceClearAccount,
} from '../src/lib/dataset-maintenance-clear-account.js';

import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
