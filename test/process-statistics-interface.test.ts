import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { type TestContext } from 'node:test';
import { statisticsSelection, groupProcessRows } from '../src/application/process-statistics.js';
import { processStatistics } from '../src/adapters/process-statistics.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import type { DatasetPorts, DatasetRecord } from '../src/application/dataset-types.js';
import { businessFixture, businessActor } from './helpers/cli-business-fixtures.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const noNetwork = async () => {
  throw new Error('No external network permitted');
};
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'statistics-conformance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function row(
  id: string,
  stateCode: number | null = 0,
  owner: string | null = 'owner',
): DatasetRecord {
  return {
    type: 'process',
    id,
    version: '00.00.001',
    stateCode,
    owner,
    modifiedAt: null,
    content: businessFixture('process'),
  };
}
function reader(rows: DatasetRecord[], calls: number[] = [], cap = 1): DatasetPorts['read'] {
  return async (_type, q) => {
    calls.push(q.offset);
    const filtered = rows.filter(
      (row) =>
        (q.state === undefined || q.state === row.stateCode) &&
        (q.owner === undefined || q.owner === row.owner),
    );
    return {
      records: filtered.slice(q.offset, q.offset + Math.min(cap, q.limit)),
      total: filtered.length,
      environment: 'https://example.test',
    };
  };
}

test('Statistics honors owner/state filters, server caps, all-state defaults and exact classification groups', async () => {
  const calls: number[] = [];
  const rows = [row('a', 0), row('b', 100), row('c', 100, 'other')];
  const all = await processStatistics({}, {}, noNetwork, reader(rows, calls));
  assert.equal(all.status, 'completed');
  assert.equal(all.total_process_rows, 3);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(all.completeness.total, 3);
  assert.equal(all.state_codes, null);
  assert.equal(all.summary.state_codes, null);
  assert.deepEqual(all.groups, [
    { state: 0, count: 1 },
    { state: 100, count: 2 },
  ]);
  const scoped = await processStatistics(
    { owner: 'owner', stateCodes: [0, 100], groupBy: ['state', 'classification'] },
    {},
    noNetwork,

    reader(rows),
  );
  assert.equal(scoped.total_process_rows, 2);
  assert.equal(scoped.groups.length, 2);
  assert.ok(scoped.groups.every((group) => Array.isArray(group.classification)));
  assert.equal(scoped.completeness.snapshot, false);
  const empty = await processStatistics(
    { scope: 'visible', stateCodes: [-1], maxRows: 1, groupBy: ['classification'] },
    {},
    noNetwork,

    reader(rows),
  );
  assert.equal(empty.status, 'completed');
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.context.defaultedInputs, {});
});

test('Statistics reports scan bounds, count drift and repeated identities as partial observations', async () => {
  const rows = [row('a'), row('b'), row('c')];
  const limited = await processStatistics(
    { maxRows: 1 },
    {},
    noNetwork,

    reader(rows),
  );
  assert.equal(limited.status, 'partial');
  assert.equal(limited.total_process_rows, 1);
  assert.deepEqual(limited.completeness.reasons, ['scan_limit_reached']);
  assert.equal(limited.completeness.total, null);
  const unscanned = await processStatistics(
    { stateCodes: [0, 100], maxRows: 1 },
    {},
    noNetwork,

    reader([row('a'), row('b', 100)]),
  );
  assert.equal(unscanned.status, 'partial');
  const drift = await processStatistics({}, {}, noNetwork, async (_type, q) => ({
    records: q.offset === 0 ? [row('a')] : [],
    total: q.offset === 0 ? 3 : 4,
    environment: 'fixture',
  }));
  assert.deepEqual(drift.completeness.reasons, ['remote_count_changed', 'reported_count_mismatch']);
  const repeated = await processStatistics({}, {}, noNetwork, async () => ({
    records: [row('same')],
    total: 2,
    environment: 'fixture',
  }));
  assert.deepEqual(repeated.completeness.reasons, ['repeated_identity_during_scan']);
  assert.equal(repeated.total_process_rows, 1);
  const unknown = await processStatistics({}, {}, noNetwork, async (_type, q) => ({
    records: q.offset === 0 ? [row('a')] : [],
    total: null,
    environment: 'fixture',
  }));
  assert.equal(unknown.status, 'completed');
  assert.equal(unknown.completeness.total, null);
  const exhausted = await processStatistics(
    { maxRows: 1 },
    {},
    noNetwork,

    async () => ({ records: [row('a')], total: null, environment: 'fixture' }),
  );
  assert.equal(exhausted.status, 'partial');
});

test('Statistics never accepts response rows outside selected type/state/owner or a page larger than requested', async () => {
  for (const [request, records] of [
    [{ owner: 'owner' }, [row('a', 0, 'other')]],
    [{ stateCodes: [0] }, [row('a', 100)]],
    [{}, [{ ...row('a'), type: 'flow' }]],
    [{ maxRows: 1 }, [row('a'), row('b')]],
  ] as Array<[Record<string, unknown>, DatasetRecord[]]>) {
    await assert.rejects(
      processStatistics(request, {}, noNetwork, async () => ({
        records,
        total: records.length,
        environment: 'fixture',
      })),
      { code: 'STATISTICS_RESPONSE_INVALID' },
    );
  }
});

test('Current-user statistics binds the live actor and refuses another owner', async () => {
  const backend = createBusinessBackend();
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
  });
  const record = row('a', 0, businessActor);
  const own = await processStatistics(
    { scope: 'current-user', owner: businessActor },
    env,
    backend.fetchImpl,

    reader([record]),
  );
  assert.deepEqual(own.context.actor, { id: businessActor, source: 'online' });
  const implicit = await processStatistics(
    { scope: 'current-user' },
    env,
    backend.fetchImpl,

    reader([record]),
  );
  assert.equal(implicit.selection.owner, businessActor);
  await assert.rejects(
    processStatistics(
      { scope: 'current-user', owner: 'other' },
      env,
      backend.fetchImpl,

      noNetwork,
    ),
    { code: 'OWNER_CONFLICT' },
  );
});

test('Statistics rejects malformed selections, and grouping preserves unknown identities without inventing a category', () => {
  for (const input of [
    { unknown: true },
    { scope: 'all' },
    { owner: '' },
    { stateCodes: [] },
    { stateCodes: ['0'] },
    { stateCodes: [0, 0] },
    { stateCodes: 0 },
    { groupBy: [] },
    { groupBy: ['bad'] },
    { groupBy: ['state', 'state'] },
    { groupBy: 'state' },
    { maxRows: 0 },
    { maxRows: 100001 },
    { maxRows: 1.5 },
  ])
    assert.throws(() => statisticsSelection(input));
  const missing = { ...row('a', null, null), content: { processDataSet: {} } };
  assert.deepEqual(groupProcessRows([missing], ['classification']), [
    { classification: null, count: 1 },
  ]);
  const single = {
    ...missing,
    content: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            classificationInformation: {
              'common:classification': { 'common:class': { '@classId': '7', '@level': '0' } },
            },
          },
        },
      },
    },
  };
  assert.deepEqual(groupProcessRows([single], ['classification']), [
    { classification: [{ level: '0', code: '7' }], count: 1 },
  ]);
  const malformed = {
    ...missing,
    content: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            classificationInformation: { 'common:classification': { 'common:class': [{}, null] } },
          },
        },
      },
    },
  };
  assert.deepEqual(groupProcessRows([malformed], ['classification']), [
    {
      classification: [
        { level: null, code: null },
        { level: null, code: null },
      ],
      count: 1,
    },
  ]);
});

test('Statistics command exposes requests, accepts declared flags, rejects ambiguous selections and bounds stdout groups', async (t) => {
  const dir = directory(t);
  const ports = createDatasetPorts({}, noNetwork);
  const help = JSON.parse(
    (await runDatasetCommand(['process', 'statistics', '--help', '--json'], ports)).stdout,
  );
  assert.ok(help.request.scope);
  assert.ok(help.options.includes('group-by'));
  ports.local = async (_type, _action, request) => {
    assert.deepEqual(request, {
      scope: 'visible',
      owner: 'owner',
      stateCodes: [0],
      groupBy: ['state', 'classification'],
      maxRows: 10,
    });
    return {
      status: 'completed',
      groups: Array.from({ length: 8 }, (_, i) => ({ state: i, count: 1 })),
      context: { environment: 'fixture' },
      completeness: { snapshot: false },
    };
  };
  const output = path.join(dir, 'statistics.json');
  const args = [
    'process',
    'statistics',
    '--scope',
    'visible',
    '--owner',
    'owner',
    '--state',
    '0',
    '--group-by',
    'state,classification',
    '--max-rows',
    '10',
    '--json',
  ];
  const io = await runDatasetCommand([...args, '--output', output], ports);
  assert.equal(io.exitCode, 0);
  const result = JSON.parse(io.stdout);
  assert.equal(result.data.groups.length, 5);
  assert.equal(result.data.groupsCount, 8);
  assert.equal(result.completeness.truncated, true);
  const request = path.join(dir, 'request.json');
  writeFileSync(request, JSON.stringify({ scope: 'visible' }));
  for (const extra of [
    ['--input', request, '--state', '0'],
    ['--group-by', 'bad'],
    ['--state', 'oops'],
    ['--max-rows', '0'],
  ]) {
    const invalid = await runDatasetCommand(['process', 'statistics', ...extra, '--json'], ports);
    assert.equal(invalid.exitCode, 2);
  }
  ports.local = async () => ({
    status: 'partial',
    groups: [],
    context: {},
    completeness: { partial: true },
  });
  assert.equal(
    (await runDatasetCommand(['process', 'statistics', '--input', request, '--json'], ports))
      .exitCode,
    1,
  );
});
