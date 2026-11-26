import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readProcessResults,
  processResultRequest,
  ResultReadChanged,
} from '../src/application/process-results.js';
import type { JsonObject, DatasetPorts } from '../src/application/dataset-types.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const version = '01.00.000';
const input = { id, version };
const unit = {
  flowPropertyId: id,
  flowPropertyVersion: version,
  unitGroupId: id,
  unitGroupVersion: version,
  internalId: '0',
  name: 'kg',
};
const key = {
  flowId: id,
  flowVersion: version,
  direction: 'Output',
  location: null,
  functionType: null,
  unit,
};
const candidate = {
  uuid: id,
  version,
  relationKind: 'direct',
  lciAvailable: true,
  lciaAvailable: true,
};
const result = {
  uuid: id,
  version,
  relationKind: 'direct',
  quantitativeReference: { ...key, value: 1, amountField: 'resultingAmount' },
};
const publication = {
  publicationId: id,
  releaseVersion: '2026.11.1',
  format: 'final-result-pair.v2',
};
const selection = () => ({ publication, results: [candidate], nextResultKey: null });
const envelope = (data: JsonObject) => ({
  schemaVersion: 'result.query.response.v2',
  publicationId: id,
  runtimeRevision: id,
  result: { uuid: id, version },
  data,
});
function response(request: JsonObject): JsonObject {
  if (request.mode === 'source_results') return selection();
  const query = request.query as JsonObject;
  if (query.kind === 'overview')
    return envelope({ result, lciAvailable: true, lciaAvailable: true });
  if (query.kind === 'lcia')
    return envelope({
      result,
      impacts: [{ method: { id, version, unit: 'kg CO2 eq' }, amount: 0 }],
    });
  return envelope({
    result,
    items: [{ key, amount: -0.00000000001 }],
    nonzeroCount: 1,
    nextCursor: null,
  });
}
const query = async (request: JsonObject) => response(request);

test('result discovery and exact layer reads need no caller hashes or transport versions', async () => {
  assert.equal((await readProcessResults(input, true, query)).complete, true);
  for (const kind of ['overview', 'lci', 'lcia']) {
    const value = await readProcessResults({ ...input, kind, resultId: id }, false, query);
    assert.equal(value.complete, true);
    assert.equal(value.kind, kind);
  }
  assert.deepEqual(processResultRequest(input), {
    ...input,
    resultId: undefined,
    kind: 'overview',
    maxItems: 100000,
  });
  for (const bad of [
    { id: 'bad' },
    { version: 'latest' },
    { resultId: 'bad' },
    { kind: 'x' },
    { maxItems: 0 },
    { maxItems: '3' },
    { maxItems: 2000001 },
  ])
    assert.throws(() => processResultRequest({ ...input, ...bad }));
  const empty = await readProcessResults(input, true, async () => ({
    publication: null,
    results: [],
    nextResultKey: null,
  }));
  assert.deepEqual(empty.results, []);
});

test('LCI collects empty continuation pages and pins internal read context; only complete data succeeds', async () => {
  let calls = 0;
  const value = await readProcessResults({ ...input, kind: 'lci' }, false, async (request) => {
    if (request.mode === 'source_results') return selection();
    calls++;
    if (calls === 1) return envelope({ result, items: [], nonzeroCount: 1, nextCursor: 'next' });
    assert.equal(request.runtimeRevision, id);
    assert.equal(request.publicationId, id);
    assert.equal((request.query as JsonObject).cursor, 'next');
    return response(request);
  });
  assert.equal(calls, 2);
  assert.equal((value.data as JsonObject).nonzeroCount, 1);
  const zero = await readProcessResults({ ...input, kind: 'lci' }, false, async (request) =>
    request.mode === 'source_results'
      ? selection()
      : envelope({ result, items: [], nonzeroCount: 0, nextCursor: null }),
  );
  assert.deepEqual((zero.data as JsonObject).items, []);
  await assert.rejects(
    readProcessResults({ ...input, kind: 'lci', maxItems: 1 }, false, async (request) =>
      request.mode === 'source_results'
        ? selection()
        : envelope({ result, items: [], nonzeroCount: 2, nextCursor: null }),
    ),
    /Increase --max-items/,
  );
});

test('a confirmed context change restarts the whole read once, without mixing old pages', async () => {
  let attempts = 0;
  let calls = 0;
  const value = await readProcessResults({ ...input, kind: 'lci' }, false, async (request) => {
    if (request.mode === 'source_results') {
      attempts++;
      return selection();
    }
    calls++;
    if (attempts === 1) {
      if (calls === 1)
        return envelope({
          result,
          items: [{ key, amount: 7 }],
          nonzeroCount: 2,
          nextCursor: 'old',
        });
      throw new ResultReadChanged();
    }
    return response(request);
  });
  assert.equal(attempts, 2);
  assert.equal(((value.data as JsonObject).items as JsonObject[])[0]!.amount, -0.00000000001);
  await assert.rejects(
    readProcessResults(input, true, async () => {
      throw new ResultReadChanged();
    }),
    /changed repeatedly/,
  );
  let failing = 0;
  await assert.rejects(
    readProcessResults(input, true, async () => {
      failing++;
      if (failing === 1) throw new ResultReadChanged();
      throw new Error('unavailable');
    }),
    /unavailable/,
  );
});

test('result ambiguity, unavailable layers and inconsistent pages never become usable inventory', async () => {
  for (const rows of [[], [candidate, { ...candidate, uuid: other }]]) {
    await assert.rejects(
      readProcessResults(input, false, async () => ({ ...selection(), results: rows })),
      /No published|Several results/,
    );
  }
  await assert.rejects(
    readProcessResults({ ...input, resultId: other }, false, query),
    /No published/,
  );
  for (const kind of ['lci', 'lcia'])
    await assert.rejects(
      readProcessResults({ ...input, kind }, false, async () => ({
        ...selection(),
        results: [{ ...candidate, lciAvailable: false, lciaAvailable: false }],
      })),
      /does not provide/,
    );
  for (const bad of [
    null,
    {},
    { ...selection(), results: [candidate, candidate] },
    { ...selection(), results: [{}] },
    { ...selection(), nextResultKey: '', results: [] },
    { ...selection(), publication: {} },
  ])
    await assert.rejects(readProcessResults(input, true, async () => bad as unknown as JsonObject));
  const broken = [
    { items: [], nonzeroCount: 1 },
    { items: [{ key, amount: Infinity }], nonzeroCount: 1 },
    { items: [{ key: { ...key, unit: {} }, amount: 1 }], nonzeroCount: 1 },
    {
      items: [
        { key, amount: 1 },
        { key, amount: 1 },
      ],
      nonzeroCount: 2,
    },
    { items: [{ key, amount: 1 }], nonzeroCount: 0 },
    { items: [], nonzeroCount: -1 },
  ];
  for (const bad of broken)
    await assert.rejects(
      readProcessResults({ ...input, kind: 'lci' }, false, async (request) =>
        request.mode === 'source_results'
          ? selection()
          : envelope({ result, nextCursor: null, ...bad }),
      ),
      /inconsistent/,
    );
  for (const bad of [
    { result: { ...result, quantitativeReference: { ...result.quantitativeReference, value: 0 } } },
    { result: { ...result, uuid: other } },
    { status: 'preparing' },
  ])
    await assert.rejects(
      readProcessResults(input, false, async (request) =>
        request.mode === 'source_results' ? selection() : envelope(bad),
      ),
    );
  await assert.rejects(
    readProcessResults({ ...input, kind: 'lcia' }, false, async (request) =>
      request.mode === 'source_results'
        ? selection()
        : envelope({ result, impacts: [{ method: {}, amount: 1 }] }),
    ),
  );
});

function adapter(transform?: (body: JsonObject) => { status?: number; value: unknown }) {
  const requests: JsonObject[] = [];
  const ports = createDatasetPorts(buildSupabaseTestEnv(), async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    assert.ok(String(url).endsWith('/lca_release_results'));
    const body = JSON.parse(String(init?.body)) as JsonObject;
    requests.push(body);
    const reply = transform?.(body) ?? { value: { ok: true, data: response(body) } };
    return new Response(JSON.stringify(reply.value), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { ports, requests };
}
test('public Process commands discover, read and save full inventories with compact stdout', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'process-result-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { ports, requests } = adapter();
  const run = (args: string[]) => runDatasetCommand(['process', ...args, '--json'], ports);
  for (const action of ['results', 'get-result']) {
    assert.equal((await run([action, '--help'])).exitCode, 0);
    const reply = await run([action, '--id', id, '--version', version]);
    assert.equal(reply.exitCode, 0, reply.stderr);
  }
  const file = path.join(dir, 'background.json');
  let reply = await run([
    'get-result',
    '--id',
    id,
    '--version',
    version,
    '--kind',
    'lci',
    '--output',
    file,
  ]);
  assert.equal(reply.exitCode, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).data.data.itemCount, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).data.items.length, 1);
  reply = await run([
    'get-result',
    '--id',
    id,
    '--version',
    version,
    '--kind',
    'lci',
    '--output',
    file,
  ]);
  assert.equal(reply.exitCode, 1);
  const before = requests.length;
  for (const flags of [
    ['--kind', 'lci'],
    ['--kind', 'bad'],
    ['--max-items', 'bad'],
  ])
    assert.equal(
      (await run(['get-result', '--id', id, '--version', version, ...flags])).exitCode,
      2,
    );
  assert.equal(requests.length, before);
  const lcia = await run([
    'get-result',
    '--id',
    id,
    '--version',
    version,
    '--kind',
    'lcia',
    '--output',
    path.join(dir, 'impact.json'),
  ]);
  assert.equal(lcia.exitCode, 0);
  assert.equal(
    (
      await run([
        'get-result',
        '--id',
        id,
        '--version',
        version,
        '--output',
        path.join(dir, 'overview.json'),
      ])
    ).exitCode,
    0,
  );
});

test('result transport handles refusals and only retries explicit context changes', async () => {
  for (const [status, value] of [
    [404, { error: { code: 'RESULT_NOT_AVAILABLE' } }],
    [503, { code: 'unavailable' }],
    [200, { ok: false }],
    [200, null],
  ] as const) {
    const { ports } = adapter(() => ({ status, value }));
    const reply = await runDatasetCommand(
      ['process', 'results', '--id', id, '--version', version, '--json'],
      ports,
    );
    assert.equal(reply.exitCode, 1);
  }
  let count = 0;
  const { ports } = adapter((body) => {
    count++;
    return count === 1
      ? { status: 409, value: { error: { code: 'PUBLICATION_CHANGED' } } }
      : { value: { ok: true, data: response(body) } };
  });
  const reply = await runDatasetCommand(
    ['process', 'results', '--id', id, '--version', version, '--json'],
    ports,
  );
  assert.equal(reply.exitCode, 0);
  assert.equal(count, 2);
});

test('search forwards explicit public scope and effective state via matched Process/Flow version search', async () => {
  const requests: JsonObject[] = [];
  const ports: DatasetPorts = createDatasetPorts(buildSupabaseTestEnv(), async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    requests.push(JSON.parse(String(init?.body)) as JsonObject);
    return new Response(
      JSON.stringify([
        {
          id,
          version,
          json: {
            processDataSet: {
              processInformation: { dataSetInformation: { name: { baseName: 'electricity' } } },
            },
          },
        },
      ]),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const reply = await runDatasetCommand(
    [
      'process',
      'search',
      '--query',
      'electricity',
      '--scope',
      'public',
      '--state',
      '100',
      '--json',
    ],
    ports,
  );
  assert.equal(reply.exitCode, 0, reply.stderr);
  assert.equal(requests[0]!.data_source, 'tg');
  assert.equal(requests[0]!.version_scope, 'matched');
  assert.equal(requests[0]!.state_code, 100);
  assert.equal(requests[0]!.match_count, 200);
  assert.deepEqual(JSON.parse(reply.stdout).data.candidates[0].name, { baseName: 'electricity' });
  for (const flags of [
    ['--scope', 'bad'],
    ['--scope', 'public', '--state', '0'],
  ])
    assert.equal(
      (await runDatasetCommand(['process', 'search', '--query', 'x', ...flags, '--json'], ports))
        .exitCode,
      2,
    );
  assert.equal(requests.length, 1);
});

test('result readers enforce bounded continuation and never accept repeated partial pages', async () => {
  let pages = 0;
  await assert.rejects(
    readProcessResults(input, true, async (request) => {
      pages++;
      if (pages > 1) assert.equal(request.publicationId, id);
      const next = pages.toString().padStart(12, '0');
      return {
        publication,
        results: [{ ...candidate, uuid: `00000000-0000-4000-8000-${next}` }],
        nextResultKey: `page-${pages}`,
      };
    }),
    /Too many result candidates/,
  );
  assert.equal(pages, 20);
  pages = 0;
  await assert.rejects(
    readProcessResults({ ...input, kind: 'lci' }, false, async (request) => {
      if (request.mode === 'source_results') return selection();
      pages++;
      return envelope({ result, items: [], nonzeroCount: 1, nextCursor: `page-${pages}` });
    }),
    /page budget/,
  );
  assert.equal(pages, 2000);
  pages = 0;
  const selected = await readProcessResults(input, true, async () => {
    pages++;
    return {
      publication,
      results: [{ ...candidate, uuid: pages === 1 ? id : other }],
      nextResultKey: pages === 1 ? 'next' : null,
    };
  });
  assert.equal((selected.results as unknown[]).length, 2);
  for (const failure of [new Error('network'), null]) {
    const ports = createDatasetPorts(buildSupabaseTestEnv(), async (url) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (failure) throw failure;
      return new Response('null', { status: 500, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(
      (
        await runDatasetCommand(
          ['process', 'results', '--id', id, '--version', version, '--json'],
          ports,
        )
      ).exitCode,
      1,
    );
  }
});
