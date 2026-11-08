import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDatasetCommand, runDatasetHelp } from '../src/commands/dataset.js';
import {
  actionsFor,
  datasetTypes,
  datasetWrappers,
  type DatasetType,
  type DatasetPorts,
  type JsonObject,
} from '../src/application/dataset-types.js';
import {
  contentDigest,
  patchContent,
  diffContent,
  listContentReferences,
} from '../src/application/dataset-content.js';
import { queryCursor, nextCursor, discoverDatasets } from '../src/application/dataset-discovery.js';
import { extractTranslations, applyTranslations } from '../src/application/dataset-translations.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { allocationFixture } from './helpers/process-allocation-fixture.js';
import { makeFlow } from './helpers/flow-content.js';
import { result } from '../src/shared/command-result.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const content = (type: DatasetType): JsonObject => ({ [datasetWrappers[type]]: {} });
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dataset-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function file(dir: string, value: unknown, name = 'input.json') {
  const input = path.join(dir, name);
  writeFileSync(input, JSON.stringify(value));
  return input;
}
const parsed = (reply: { stdout: string }) => JSON.parse(reply.stdout);
function ports(overrides: Partial<DatasetPorts> = {}): DatasetPorts {
  return {
    now: () => '2026-11-08T00:00:00Z',
    read: async (type, query) => ({
      environment: 'https://example.test',
      total: 3,
      records: [
        {
          type,
          id: query.id ?? 'id',
          version: query.version === 'latest' ? '01.00.002' : (query.version ?? '01.00.001'),
          modifiedAt: null,
          stateCode: 0,
          owner: 'actor',
          content: content(type),
        },
      ],
    }),
    contract: async () => ({ components: {}, unavailable: [] }),
    validate: async () => ({ status: 'passed', issues: [], notChecked: ['remote_references'] }),
    search: async () => ({
      candidates: [],
      returned: 0,
      environment: 'https://example.test',
      hasMore: null,
    }),
    local: async () => ({ status: 'completed', qualification: { status: 'qualified' } }),
    mutate: async () => {
      throw new Error('unexpected mutation');
    },
    ...overrides,
  };
}
const run = (args: string[], overrides: Partial<DatasetPorts> = {}) =>
  runDatasetCommand([...args, '--json'], ports(overrides));

test('all Dataset types discover their own capabilities without transport effects', async () => {
  assert.deepEqual(Object.keys(parsed(runDatasetHelp(['--help', '--json'])).types), datasetTypes);
  assert.equal(runDatasetHelp(['--oops', '--json']).exitCode, 2);
  const noEffects = ports({
    read: async () => {
      throw new Error('network');
    },
  });
  for (const type of datasetTypes) {
    for (const action of actionsFor(type)) {
      const reply = await runDatasetCommand(
        [type, ...action.split(' '), '--help', '--json'],
        noEffects,
      );
      assert.equal(reply.exitCode, 0, `${type} ${action}`);
      assert.ok(parsed(reply).implementedActions.includes('contract'));
    }
    const reply = await run([type, '--help']);
    assert.equal(reply.exitCode, 0);
  }
  assert.equal((await run(['lciamethod', 'get'])).exitCode, 2);
  assert.equal((await run(['flowproperty', 'save'])).exitCode, 2);
  assert.equal((await run(['model', 'delete'])).exitCode, 2);
  assert.equal((await run(['unitgroup', 'search'])).exitCode, 2);
});

test('query pages bind filters, preserve exact identities and use actual server caps', async () => {
  const first = await run([
    'flow',
    'list',
    '--owner',
    'actor',
    '--state',
    '0',
    '--limit',
    '2',
    '--fields',
    'id,version,stateCode',
  ]);
  const value = parsed(first);
  assert.equal(first.exitCode, 0);
  assert.equal(value.completeness.returned, 1);
  assert.equal(value.completeness.hasMore, true);
  assert.ok(value.nextActions[0].command.includes('--owner'));
  assert.ok(value.nextActions[0].command.includes('--state'));
  const cursor = value.completeness.nextCursor;
  let offset = -1;
  const second = await run(
    [
      'flow',
      'list',
      '--owner',
      'actor',
      '--state',
      '0',
      '--limit',
      '2',
      '--fields',
      'id,version,stateCode',
      '--cursor',
      cursor,
    ],
    {
      read: async (_type, query) => {
        offset = query.offset;
        return { records: [], total: 1, environment: 'https://example.test' };
      },
    },
  );
  assert.equal(second.exitCode, 0);
  assert.equal(offset, 1);
  assert.equal(parsed(second).completeness.hasMore, false);
  assert.equal((await run(['flow', 'list', '--limit', '3', '--cursor', cursor])).exitCode, 2);
  const latest = await run(['flow', 'get', '--id', 'id', '--version', 'latest']);
  assert.equal(parsed(latest).data.subject.version, '01.00.002');
  const missing = await run(['flow', 'get', '--id', 'id', '--version', '01'], {
    read: async () => ({ records: [], total: 0, environment: '' }),
  });
  assert.equal(missing.exitCode, 1);
  assert.equal(parsed(missing).outcome, 'not_found_or_not_visible');
  const projected = await run([
    'contact',
    'get',
    '--id',
    'id',
    '--version',
    '01',
    '--fields',
    'id,version',
  ]);
  assert.equal(parsed(projected).data.content, undefined);
  assert.deepEqual(Object.keys(parsed(projected).data.subject).sort(), ['id', 'type', 'version']);
  const versions = await run(['process', 'versions', '--id', 'id']);
  assert.equal(versions.exitCode, 0);
  assert.deepEqual(parsed(versions).context.defaultedInputs, { limit: 20 });
  assert.throws(() => queryCursor('not-json', {}), /Cursor/);
  assert.throws(
    () =>
      queryCursor(
        Buffer.from(JSON.stringify({ binding: contentDigest({}), offset: -1 })).toString(
          'base64url',
        ),
        {},
      ),
    /Cursor/,
  );
  assert.equal(queryCursor(nextCursor(3, {}), {}), 3);
  const uncounted = await discoverDatasets(
    'flow',
    'list',
    { limit: 2, offset: 0 },
    {},
    ports({ read: async () => ({ records: [], total: null, environment: '' }) }),
  );
  assert.equal(uncounted.completeness.truncated, true);
});

test('invalid query arguments reject before reading and transport errors remain redacted', async () => {
  let effects = 0;
  const read: DatasetPorts['read'] = async () => {
    effects++;
    throw new Error('Bearer secret');
  };
  for (const args of [
    ['unknown'],
    ['flow', '--oops'],
    ['flow', 'list', '--limit', '0'],
    ['flow', 'list', '--limit', '101'],
    ['flow', 'list', '--state', 'a'],
    ['flow', 'get', '--id', 'id'],
    ['flow', 'get', '--id', 'id', '--id', 'other'],
    ['flow', 'get', '--id'],
    ['flow', 'list', '--fields', 'unknown'],
    ['flow', 'list', '--fields', 'id,id'],
    ['flow', 'list', '--force'],
    ['flow', 'list', '--output', ' '],
  ]) {
    const reply = await run(args, { read });
    assert.equal(reply.exitCode, 2, args.join(' '));
  }
  assert.equal(effects, 0);
  const failed = await run(['flow', 'get', '--id', 'id', '--version', '01'], { read });
  assert.equal(failed.exitCode, 1);
  assert.ok(!failed.stdout.includes('secret'));
  for (const rows of [
    [{ type: 'source', id: 'id', version: '01' }],
    [{ type: 'flow', id: 'other', version: '01' }],
    [{ type: 'flow', id: 'id', version: '02' }],
    [{}, {}],
  ]) {
    const reply = await run(['flow', 'get', '--id', 'id', '--version', '01'], {
      read: async () => ({ records: rows as never, total: 1, environment: '' }),
    });
    assert.equal(reply.exitCode, 1);
  }
});

test('reference discovery is local, bounded, preserves incomplete and repeated occurrences', async (t) => {
  const dir = directory(t);
  const input = file(dir, {
    processDataSet: {
      a: [
        { '@type': 'flow data set', '@refObjectId': 'x', '@version': '01' },
        { '@refObjectId': 'x' },
      ],
      referenceToMissing: {},
      other: { '@flowUUID': 'f', '@version': '02' },
    },
  });
  let effects = 0;
  const read: DatasetPorts['read'] = async () => {
    effects++;
    throw new Error('network');
  };
  const first = await run(['process', 'list-references', '--input', input, '--limit', '1'], {
    read,
  });
  const value = parsed(first);
  assert.equal(first.exitCode, 0);
  assert.equal(value.completeness.total, 4);
  assert.equal(value.completeness.targetsChecked, false);
  assert.equal(value.data.references[0].type, 'flow');
  assert.equal(value.data.references[0].declaredType, 'flow data set');
  const second = await run(
    [
      'process',
      'list-references',
      '--input',
      input,
      '--limit',
      '1',
      '--cursor',
      value.completeness.nextCursor,
    ],
    { read },
  );
  assert.equal(parsed(second).data.references[0].id, 'x');
  assert.ok(parsed(second).data.references[0].missing.includes('version'));
  const output = path.join(dir, 'refs.json');
  await run(['process', 'list-references', '--input', input, '--output', output], { read });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).references.length, 4);
  assert.equal(effects, 0);
  assert.equal(
    (await run(['process', 'list-references', '--input', input, '--id', 'id'])).exitCode,
    2,
  );
  assert.equal(
    (await run(['process', 'list-references', '--id', 'id', '--version', 'latest'])).exitCode,
    2,
  );
  const remote = await run(['process', 'list-references', '--id', 'id', '--version', '01']);
  assert.equal(remote.exitCode, 0);
  const missing = await run(['process', 'list-references', '--id', 'id', '--version', '01'], {
    read: async () => ({ records: [], total: 0, environment: '' }),
  });
  assert.equal(missing.exitCode, 1);
});

test('reference discovery returns executable CLI type names while preserving unknown declarations', () => {
  const types = [
    'flow data set',
    'process data set',
    'life cycle model data set',
    'source data set',
    'contact data set',
    'flow property data set',
    'unit group data set',
    'LCIA method data set',
    'flow',
    'unknown data set',
    'constructor',
  ];
  const refs = listContentReferences({
    refs: types.map((type) => ({ '@type': type, '@refObjectId': 'id', '@version': '01' })),
  });
  assert.deepEqual(
    refs.map((ref) => ref.type),
    [
      'flow',
      'process',
      'model',
      'source',
      'contact',
      'flowproperty',
      'unitgroup',
      'lciamethod',
      'flow',
      null,
      null,
    ],
  );
  assert.equal(refs.at(-2)!.declaredType, 'unknown data set');
  assert.equal(refs.at(-1)!.unresolvedType, true);
  assert.deepEqual(refs.at(-1)!.missing, []);
});

test('patch is atomic, guards the complete source, and rejects unsafe pointers and stale tests', () => {
  const original = { sourceDataSet: { a: [1, 2], 'slash/key': { '~': 3 }, old: true } };
  const expectedDigest = contentDigest(original);
  const patched = patchContent({
    content: original,
    expectedDigest,
    operations: [
      { op: 'test', path: '/sourceDataSet/a/0', value: 1 },
      { op: 'replace', path: '/sourceDataSet/a/0', value: 4, basis: 'evidence' },
      { op: 'add', path: '/sourceDataSet/a/-', value: 5, basis: 'evidence' },
      { op: 'remove', path: '/sourceDataSet/a/1', basis: 'evidence' },
      { op: 'remove', path: '/sourceDataSet/old', basis: 'evidence' },
      { op: 'add', path: '/sourceDataSet/new', value: null, basis: 'evidence' },
      { op: 'replace', path: '/sourceDataSet/slash~1key/~0', value: 6, basis: 'evidence' },
    ],
  });
  assert.deepEqual((patched.content.sourceDataSet as JsonObject).a, [4, 5]);
  assert.deepEqual(original.sourceDataSet.a, [1, 2]);
  assert.ok(patched.changes.length);
  for (const operation of [
    { op: 'replace', path: '/__proto__/polluted', value: true },
    { op: 'test', path: '/sourceDataSet/a/0', value: 999 },
    { op: 'test', path: '/sourceDataSet/a/0' },
    { op: 'replace', path: 'not-pointer' },
    { op: 'replace', path: '/x~2' },
    { op: 'replace', path: '/absent/a' },
    { op: 'replace', path: '/sourceDataSet/old/a' },
    { op: 'replace', path: '/sourceDataSet/missing' },
    { op: 'replace', path: '/sourceDataSet/old' },
    { op: 'replace', path: '/sourceDataSet/old', basis: 'x' },
    { op: 'unsupported', path: '/sourceDataSet/old' },
    { op: 'add', path: '/sourceDataSet/a/-1', value: 3, basis: 'x' },
    { op: 'remove', path: '/sourceDataSet/a/2', basis: 'x' },
  ]) {
    assert.throws(() =>
      patchContent({ content: original, expectedDigest, operations: [operation] }),
    );
    assert.deepEqual(original.sourceDataSet.a, [1, 2]);
  }
  assert.throws(() => patchContent({ content: original, expectedDigest: 'stale', operations: [] }));
  assert.throws(() => patchContent({ content: original, expectedDigest, operations: [] }));
  assert.deepEqual(diffContent(original, structuredClone(original)), []);
  assert.ok(diffContent({ old: 1 }, { added: 2 }).some((change) => change.beforePresent === false));
  assert.deepEqual(listContentReferences({ a: null, b: 1 }), []);
});

test('translation applies only supplied text bound to unchanged content and source positions', () => {
  const source = {
    contactDataSet: {
      labels: [
        { '@xml:lang': 'en', '#text': 'Name' },
        { '@xml:lang': 'zh', '#text': '旧' },
      ],
      nested: [{ x: [{ '@xml:lang': 'en', '#text': 'Only' }] }],
      absent: [{ '@xml:lang': 'fr', '#text': 'Nom' }],
    },
  };
  const request = { content: source, sourceLanguage: 'en', targetLanguage: 'zh' };
  const extraction = extractTranslations(request);
  assert.equal(extraction.units.length, 2);
  const translated = applyTranslations({
    ...request,
    sourceDigest: extraction.sourceDigest,
    translations: extraction.units.map((unit) => ({
      path: unit.path,
      sourceText: unit.sourceText,
      text: '译文',
      basis: 'provided text',
    })),
  });
  assert.equal(
    (translated.content.contactDataSet as typeof source.contactDataSet).labels[1]?.['#text'],
    '译文',
  );
  assert.equal(source.contactDataSet.labels[1]?.['#text'], '旧');
  assert.deepEqual(
    applyTranslations({ ...request, sourceDigest: extraction.sourceDigest, translations: [] })
      .content,
    source,
  );
  for (const overrides of [
    { sourceDigest: 'stale', translations: [] },
    { translations: null },
    { translations: [{ path: '/missing', sourceText: 'x', text: 'y' }] },
    { translations: [{ path: extraction.units[0]!.path, sourceText: 'stale', text: 'y' }] },
    {
      translations: Array(2).fill({
        path: extraction.units[0]!.path,
        sourceText: 'Name',
        text: 'new',
        basis: 'evidence',
      }),
    },
  ])
    assert.throws(() =>
      applyTranslations({ ...request, sourceDigest: extraction.sourceDigest, ...overrides }),
    );
  assert.throws(() => extractTranslations({ ...request, targetLanguage: 'en' }));
});

test('local processing and contract routes preserve full artifacts and bounded validation findings', async (t) => {
  const dir = directory(t);
  const before = content('flow');
  const after = { flowDataSet: { name: 'new' } };
  for (const [action, request] of [
    ['diff', { before, after }],
    [
      'patch',
      {
        content: before,
        expectedDigest: contentDigest(before),
        operations: [{ op: 'add', path: '/flowDataSet/name', value: 'new', basis: 'evidence' }],
      },
    ],
    ['translations extract', { content: before, sourceLanguage: 'en', targetLanguage: 'zh' }],
    [
      'translations apply',
      {
        content: before,
        sourceDigest: contentDigest(before),
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        translations: [],
      },
    ],
  ] as const) {
    const input = file(dir, request);
    const reply = await run(['flow', ...action.split(' '), '--input', input]);
    assert.equal(reply.exitCode, 0, reply.stdout);
  }
  const input = file(dir, before);
  const output = path.join(dir, 'full.json');
  const reply = await run(['flow', 'validate', '--input', input, '--output', output], {
    validate: async () => ({ status: 'failed', issues: Array(8).fill({ code: 'bad' }) }),
  });
  assert.equal(reply.exitCode, 1);
  assert.equal(parsed(reply).data.validation.issues.length, 5);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).issues.length, 8);
  assert.equal(
    (await run(['flow', 'validate', '--input', input, '--checks', 'references'])).exitCode,
    0,
  );
  assert.equal(
    (await run(['lciamethod', 'validate', '--input', input, '--checks', 'business'])).exitCode,
    2,
  );
  assert.equal((await run(['flow', 'contract'])).exitCode, 0);
  assert.equal((await run(['flow', 'search', '--query', 'name'])).exitCode, 0);
  assert.equal((await run(['flow', 'search', '--query', 'name', '--cursor', 'x'])).exitCode, 2);
  assert.equal((await run(['flow', 'search', '--query', 'name', '--state', 'bad'])).exitCode, 2);
  assert.equal((await run(['model', 'aggregate', '--input', file(dir, {})])).exitCode, 0);
  const getFile = path.join(dir, 'get.json');
  assert.equal(
    (await run(['source', 'get', '--id', 'id', '--version', '01', '--output', getFile])).exitCode,
    0,
  );
  assert.deepEqual(JSON.parse(readFileSync(getFile, 'utf8')), content('source'));
});

test('read adapters retain current-user transport, exact filters and server counts for seven types', async () => {
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'test-secret',
  });
  for (const type of datasetTypes.filter((type) => type !== 'lciamethod')) {
    const urls: URL[] = [];
    const real = createDatasetPorts(env, async (url) => {
      if (isSupabaseAuthTokenUrl(String(url))) return makeSupabaseAuthResponse();
      urls.push(new URL(String(url)));
      return new Response(
        JSON.stringify([
          {
            id: 'id',
            version: '01',
            json: content(type),
            user_id: 'actor',
            state_code: 0,
            modified_at: '2026-11-08T00:00:00Z',
          },
        ]),
        { headers: { 'content-type': 'application/json', 'content-range': '0-0/3' } },
      );
    });
    const page = await real.read(type, {
      id: 'id',
      version: '01',
      owner: 'actor',
      state: 0,
      offset: 0,
      limit: 2,
    });
    assert.equal(page.total, 3);
    assert.equal(page.records[0]?.type, type);
    assert.match(urls[0]!.search, /version=eq.01/);
    assert.equal(urls.length, 1);
    await real.read(type, { version: 'latest', limit: 1, offset: 0 });
    assert.equal(urls[1]!.searchParams.get('order'), 'version.desc');
    assert.ok(real.now());
    assert.equal((await real.contract(type, ['schema'])).source, 'sdk-contract-api');
    assert.equal((await real.validate(type, content(type), ['schema'])).status, 'failed');
    assert.equal(
      (await real.validate(type, content(type), ['schema', 'business'])).status,
      'failed',
    );
  }
});

test('Dataset adapters reject malformed read/search responses without exposing remote text', async () => {
  const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
  for (const body of [
    {},
    [null],
    [{ id: 'id', version: '01', json: {} }],
    [{ id: 'id', version: '01', json: { flowDataSet: {} } }],
  ]) {
    const adapter = createDatasetPorts(env, async (url) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse()
        : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    if (Array.isArray(body) && body[0]?.json && 'flowDataSet' in body[0].json) {
      const read = await adapter.read('flow', { limit: 1, offset: 0 });
      assert.equal(read.records[0]!.owner, null);
      assert.equal(read.records[0]!.stateCode, null);
    } else await assert.rejects(adapter.read('flow', { limit: 1, offset: 0 }));
  }
  const bad = createDatasetPorts(env, async (url) =>
    isSupabaseAuthTokenUrl(url)
      ? makeSupabaseAuthResponse()
      : new Response('secret', { status: 400 }),
  );
  await assert.rejects(bad.read('flow', { limit: 1, offset: 0 }), /Dataset read/);
  for (const type of ['flow', 'process', 'model', 'source', 'contact'] as const) {
    let requests = 0;
    const real = createDatasetPorts(env, async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      requests++;
      assert.equal(JSON.parse(String(init?.body)).query, 'name');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'id', version: '01', score: 0.5, state_code: 0, semantic_route: 'semantic' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const value = await real.search(type, 'name', 20, 0, 0);
    assert.equal((value.candidates as unknown[]).length, 1);
    assert.equal(value.hasMore, null);
    assert.equal(requests, 1);
  }
  for (const body of [
    null,
    [],
    { data: [{ id: 'id', version: '01' }] },
    { data: [{}] },
    { data: null },
    { data: [{}, {}] },
  ]) {
    const adapter = createDatasetPorts(env, async (url) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse()
        : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    if (Array.isArray(body) || (body && body.data?.length === 1 && 'id' in body.data[0]!))
      assert.ok(await adapter.search('source', 'name', 1, 0));
    else await assert.rejects(adapter.search('source', 'name', 1, 0));
  }
});

test('reference validation reuses exact admission, combines local findings and reports uncovered scientific checks', async () => {
  const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
  const transport = (available: boolean) => async (url: string) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    const parsed = new URL(url);
    return new Response(
      JSON.stringify(
        available
          ? [
              {
                id: parsed.searchParams.get('id')?.replace(/^eq\./u, ''),
                version: parsed.searchParams.get('version')?.replace(/^eq\./u, '') ?? '00.00.001',
              },
            ]
          : [],
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const real = createDatasetPorts(env, transport(true));
  const passed = await real.validate('flow', makeFlow(), ['schema', 'references']);
  assert.equal(passed.status, 'passed');
  assert.ok(!JSON.stringify(passed).includes('dataset-reference-checks-'));
  assert.ok((passed.notChecked as string[]).includes('scientific_reference_suitability'));
  assert.equal(
    (await real.validate('contact', content('contact'), ['schema', 'references'])).status,
    'failed',
  );
  assert.equal((await real.validate('flow', makeFlow(), ['references'])).status, 'passed');
  assert.equal(
    (await createDatasetPorts(env, transport(false)).validate('flow', makeFlow(), ['references']))
      .status,
    'failed',
  );
  const unresolved = allocationFixture().payload;
  const fixVersions = (entry: unknown): void => {
    if (Array.isArray(entry)) entry.forEach(fixVersions);
    else if (entry && typeof entry === 'object') {
      const row = entry as JsonObject;
      if (row['@refObjectId']) row['@version'] = '00.00.001';
      Object.values(row).forEach(fixVersions);
    }
  };
  fixVersions(unresolved);
  assert.equal((await real.validate('process', unresolved, ['business'])).status, 'incomplete');
  assert.equal(
    (await real.validate('process', unresolved, ['business', 'references'])).status,
    'incomplete',
  );
  const contract = await real.contract('contact', ['schema', 'methodology', 'ruleset']);
  assert.ok(Array.isArray(contract.unavailable));
  assert.equal(
    (await real.contract('flow', ['ruleset'])).components &&
      ((await real.contract('flow', ['ruleset'])).components as JsonObject).schema,
    null,
  );
});

test('public Dataset mutation routes preserve outcomes, artifacts, projection and supplied business failures', async (t) => {
  const dir = directory(t);
  const input = file(dir, {});
  const output = path.join(dir, 'result.json');
  for (const status of ['completed', 'unknown', 'partial'] as const) {
    for (const action of ['create', 'save', 'delete']) {
      const value = result(`dataset flow ${action}`);
      value.status = status;
      const response = await run(
        [
          'flow',
          action,
          '--input',
          input,
          '--output',
          path.join(dir, `${status}-${action}.json`),
          ...(action === 'create' ? ['--dry-run'] : []),
        ],
        {
          mutate: async (_type, selected, _request, dryRun) => {
            assert.equal(selected, action);
            assert.equal(dryRun, action === 'create');
            return value;
          },
        },
      );
      assert.equal(parsed(response).status, status);
    }
  }
  writeFileSync(output, 'existing');
  const preserved = result('dataset flow create');
  const outputFailure = await run(['flow', 'create', '--input', input, '--output', output], {
    mutate: async () => preserved,
  });
  assert.equal(parsed(outputFailure).status, 'partial');
  assert.equal(parsed(outputFailure).warnings[0].code, 'OUTPUT_UNAVAILABLE');
  const componentResult = parsed(
    await run(['flow', 'contract', '--output', path.join(dir, 'contract.json')], {
      contract: async () => ({
        components: { schema: null, methodology: 'methodology', ruleset: { version: 1 } },
        unavailable: ['schema'],
      }),
    }),
  );
  assert.equal(componentResult.data.components.schema.available, false);
  assert.ok(componentResult.data.components.ruleset.bytes > 0);
  assert.equal((await run(['flow', 'search', '--query', 'steel', '--limit', '2'])).exitCode, 0);
  const lciaInput = file(dir, content('lciamethod'), 'lcia.json');
  assert.equal((await run(['lciamethod', 'validate', '--input', lciaInput])).exitCode, 0);
  const refsReply = parsed(
    await run(['flow', 'list-references', '--id', 'id', '--version', '01', '--limit', '1'], {
      read: async (type) => ({
        environment: 'example',
        total: 1,
        records: [
          {
            type,
            id: 'id',
            version: '01',
            content: {
              flowDataSet: {
                refs: [
                  { '@refObjectId': 'a', '@version': '01' },
                  { '@refObjectId': 'b', '@version': '01' },
                ],
              },
            },
            modifiedAt: null,
            stateCode: 0,
            owner: 'actor',
          },
        ],
      }),
    }),
  );
  assert.match(refsReply.nextActions[0].command, /--id 'id' --version '01'/);
  const searched = await run(['source', 'search', '--query', 'steel', '--state', '0']);
  assert.equal(parsed(searched).outcome, 'candidates_returned');
  const listed = await run(['flow', 'list', '--fields', 'content']);
  assert.deepEqual(parsed(listed).data.items[0].content, content('flow'));
  const rows = {
    unavailable: null,
    schema: { status: 'failed', issue_count: 9, issues: Array(9).fill('detail') },
  };
  const validated = await run(['flow', 'validate', '--input', input], {
    validate: async () => ({
      status: 'failed',
      validation_layers: rows,
      local: { status: 'failed', issues: Array(8).fill('issue') },
      references: {
        status: 'failed',
        blockers: Array(8).fill('blocker'),
        checks: Array(8).fill('check'),
      },
    }),
  });
  // The input must be typed before validation can execute.
  assert.equal(validated.exitCode, 2);
  const typed = file(dir, content('flow'), 'typed.json');
  const projected = parsed(
    await run(['flow', 'validate', '--input', typed], {
      validate: async () => ({
        status: 'failed',
        validation_layers: rows,
        local: { status: 'failed', issues: Array(8).fill('issue') },
        references: {
          status: 'failed',
          blockers: Array(8).fill('blocker'),
          checks: Array(8).fill('check'),
        },
      }),
    }),
  );
  assert.equal(projected.data.validation.references.checks.length, 5);
  assert.deepEqual(projected.data.validation.validation_layers.schema, {
    status: 'failed',
    issue_count: 9,
  });
  assert.equal(projected.completeness.truncated, true);
  const localInput = file(dir, { content: content('source') }, 'upload.json');
  for (const status of ['preview_completed', 'partial', 'completed']) {
    const response = parsed(
      await run(
        [
          'source',
          'upload-attachments',
          '--input',
          localInput,
          ...(status === 'preview_completed' ? ['--dry-run'] : []),
        ],
        {
          local: async (_type, _action, request) => {
            assert.equal(request.dryRun, status === 'preview_completed');
            return { status };
          },
        },
      ),
    );
    assert.equal(
      response.outcome,
      status === 'preview_completed'
        ? 'preview_completed'
        : status === 'partial'
          ? 'attachments_partially_uploaded'
          : 'attachments_uploaded',
    );
  }
});

test('complete content artifacts avoid duplicate stdout payloads while failed output preserves observed facts', async (t) => {
  const dir = directory(t);
  const output = path.join(dir, 'candidate.json');
  const before = { flowDataSet: { name: [{ '@xml:lang': 'en', '#text': 'Before' }] } };
  const input = file(dir, {
    content: before,
    expectedDigest: contentDigest(before),
    operations: [
      {
        op: 'replace',
        path: '/flowDataSet/name/0/#text',
        value: 'After',
        basis: 'Explicit fixture correction',
      },
    ],
  });
  const patched = parsed(await run(['flow', 'patch', '--input', input, '--output', output]));
  const candidate = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(candidate.flowDataSet.name[0]['#text'], 'After');
  assert.equal(patched.data.content, undefined);
  assert.equal(patched.data.contentDigest, contentDigest(candidate));
  assert.equal(patched.completeness.stdoutProjection, 'artifact_summary');
  assert.equal(patched.data.changes.length, 1);
  const labels = {
    flowDataSet: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `label${i}`,
        [{ '@xml:lang': 'en', '#text': `Value ${i}` }],
      ]),
    ),
  };
  const extraction = file(
    dir,
    { content: labels, sourceLanguage: 'en', targetLanguage: 'zh' },
    'translations.json',
  );
  const translationsOutput = path.join(dir, 'units.json');
  const extracted = parsed(
    await run([
      'flow',
      'translations',
      'extract',
      '--input',
      extraction,
      '--output',
      translationsOutput,
    ]),
  );
  assert.equal(extracted.data.units.length, 5);
  assert.equal(extracted.data.unitsCount, 10);
  assert.equal(JSON.parse(readFileSync(translationsOutput, 'utf8')).units.length, 10);
  const failed = parsed(
    await run(['flow', 'get', '--id', 'id', '--version', '01', '--output', output]),
  );
  assert.equal(failed.status, 'partial');
  assert.deepEqual(failed.data.content, content('flow'));
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).flowDataSet.name[0]['#text'], 'After');
});
