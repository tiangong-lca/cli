import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { runDatasetGet } from '../src/lib/dataset-get.js';
import { executeCli } from '../src/cli.js';
import { runDatasetSourceDiscover } from '../src/lib/dataset-source-discover.js';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import type { FetchLike } from '../src/lib/http.js';
import type { ResolvedSupabaseUserSession } from '../src/lib/supabase-session.js';

const PROJECT = 'abcdefghijklmnopqrst';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-15T08:00:00.000Z');
const env = {
  TIANGONG_LCA_AUTH_MODE: 'oauth',
  TIANGONG_LCA_API_BASE_URL: `https://${PROJECT}.supabase.co/functions/v1`,
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
  TIANGONG_LCA_OAUTH_CLIENT_ID: '44444444-4444-4444-8444-444444444444',
  TIANGONG_LCA_SESSION_FILE: path.join(tmpdir(), 'source-reader-fixture-session.json'),
};
const session: ResolvedSupabaseUserSession = {
  accessToken: 'header-only-secret',
  refreshToken: 'refresh-secret',
  expiresAt: NOW.getTime() / 1000 + 3600,
  userEmail: 'owner@example.test',
  projectBaseUrl: `https://${PROJECT}.supabase.co`,
  sessionFile: env.TIANGONG_LCA_SESSION_FILE,
  authMethod: 'oauth',
  source: 'cache',
};
const ref = (type: string) => ({
  '@type': type,
  '@refObjectId': OTHER,
  '@version': '00.00.001',
  '@uri': `https://example.test/${OTHER}`,
  'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Synthetic reference' }],
});
function source(version = '00.00.001') {
  return {
    sourceDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Source',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Source ../../schemas/ILCD_SourceDataSet.xsd',
      sourceInformation: {
        dataSetInformation: {
          'common:UUID': ID,
          'common:shortName': [
            { '@xml:lang': 'en', '#text': 'Synthetic source' },
            { '@xml:lang': 'zh', '#text': '合成文献' },
          ],
          classificationInformation: {
            'common:classification': {
              'common:class': {
                '@level': '0',
                '@classId': '5',
                '#text': 'Publications and communications',
              },
            },
          },
          sourceCitation: 'Synthetic fixture; doi:10.0000/example',
          publicationType: 'Article in periodical',
          sourceDescriptionOrComment: [
            { '@xml:lang': 'en', '#text': 'Complete first paragraph.\nComplete second paragraph.' },
            { '@xml:lang': 'zh', '#text': '完整第一段。\n完整第二段。' },
          ],
          referenceToDigitalFile: [
            { '@uri': 'https://example.test/private-document.pdf' },
            { '@uri': '../external_docs/source.pdf' },
          ],
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp': NOW.toISOString(),
          'common:referenceToDataSetFormat': ref('source data set'),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': version,
          'common:referenceToOwnershipOfDataSet': ref('contact data set'),
        },
      },
    },
  };
}
function row(version = '00.00.001', state = 100, owner = USER) {
  return {
    id: ID,
    version,
    user_id: owner,
    state_code: state,
    modified_at: NOW.toISOString(),
    json: source(version),
    json_ordered: source(version),
  };
}
function fixture(selected = row()) {
  const root = mkdtempSync(path.join(tmpdir(), 'source-reader-'));
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/auth/v1/user')
      return new Response(
        JSON.stringify({ id: USER, email: session.userEmail, role: 'authenticated' }),
        { headers: { 'content-type': 'application/json' } },
      );
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(url.pathname, '/rest/v1/sources');
    assert.equal(url.searchParams.get('id'), `eq.${ID}`);
    assert.equal(url.searchParams.get('version'), `eq.${selected.version}`);
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(new Headers(init?.headers).get('Accept-Profile'), 'public');
    assert.ok(url.searchParams.has('or') || url.searchParams.has('state_code'));
    return new Response(JSON.stringify([selected]));
  };
  return {
    root,
    calls,
    selected,
    options: {
      type: 'source',
      id: ID,
      version: selected.version,
      scope: 'public-or-owner-draft',
      outDir: path.join(root, 'result'),
      env,
      fetchImpl,
      now: NOW,
      cliVersion: '0.1.15',
      expectedProjectRef: PROJECT,
      expectedUserId: USER,
      resolveSessionImpl: async () => session,
    },
  };
}

test('exact Source reads retain complete multilingual payload and attachment references without storage access', async () => {
  const f = fixture();
  try {
    assert.equal(
      tidasSdk.SourceSchema.safeParse(structuredClone(f.selected.json_ordered)).success,
      true,
    );
    const report = await runDatasetGet(f.options);
    assert.equal(report.selected.table, 'sources');
    assert.equal(report.selected.schema.validator, '@tiangong-lca/tidas-sdk/SourceSchema');
    assert.equal(report.selected.payload_sha256, sha256Json(f.selected.json_ordered));
    assert.deepEqual(JSON.parse(readFileSync(report.selected.artifact.path, 'utf8')), [f.selected]);
    assert.equal(f.calls.length, 2);
    assert.equal(report.transactional_snapshot, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('typed exclusions reject an exact Source before any identity or full-body request', async () => {
  const f = fixture();
  try {
    const exclusionsFile = path.join(f.root, 'exclusions.json');
    writeFileSync(
      exclusionsFile,
      JSON.stringify([{ type: 'source', id: ID, version: '00.00.001' }]),
    );
    await assert.rejects(runDatasetGet({ ...f.options, exclusionsFile }), {
      code: 'DATASET_GET_TYPED_VERSION_EXCLUDED',
    });
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source discovery is a single metadata-only public100 page through the official RPC', async () => {
  const f = fixture();
  const candidate = {
    rank: 1,
    id: ID,
    version: '00.00.002',
    modified_at: NOW.toISOString(),
    team_id: null,
    total_count: 7,
  };
  try {
    const result = await executeCli(
      [
        'dataset',
        'source',
        'discover',
        '--query',
        '10.0000/example',
        '--scope',
        'public100',
        '--limit',
        '1',
        '--out-dir',
        f.options.outDir,
        '--expected-project-ref',
        PROJECT,
        '--expected-user-id',
        USER,
        '--json',
      ],
      {
        env,
        fetchImpl: f.options.fetchImpl,
        dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
        runDatasetSourceDiscoverImpl: async (options) => {
          const { runDatasetSourceDiscover } =
            await import('../src/lib/dataset-source-discover.js');
          return runDatasetSourceDiscover({
            ...options,
            now: NOW,
            resolveSessionImpl: async () => session,
            fetchImpl: async (input, init) => {
              const url = new URL(input);
              if (url.pathname === '/auth/v1/user') return f.options.fetchImpl(input, init);
              f.calls.push({ url, init });
              assert.equal(url.pathname, '/rest/v1/rpc/search_sources');
              assert.equal(
                url.searchParams.get('select'),
                'rank,id,version,modified_at,team_id,total_count',
              );
              assert.equal(url.searchParams.get('limit'), '1');
              assert.equal(init?.method, 'POST');
              assert.equal(new Headers(init?.headers).get('Content-Profile'), 'api');
              assert.deepEqual(JSON.parse(String(init?.body)), {
                query_text: '10.0000/example',
                filter_condition: {},
                page_size: 1,
                page_current: 1,
                data_source: 'tg',
                this_user_id: '',
                team_id_filter: null,
                state_code_filter: 100,
              });
              return new Response(JSON.stringify([candidate]));
            },
          });
        },
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.candidates[0].version, '00.00.002');
    assert.equal(report.candidates[0].type, 'source');
    assert.equal(report.candidate_semantics, 'latest-public100-version-of-matched-UUID');
    assert.equal(report.strict_match_evaluated, false);
    assert.equal(report.catalogue_absence_proven, false);
    assert.equal(report.partial, true);
    assert.equal(report.page_truncated, true);
    assert.equal(f.calls.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function candidate(
  id = ID,
  version = '00.00.002',
  rank: number | string = 1,
  total: number | string = 1,
) {
  return { rank, id, version, modified_at: NOW.toISOString(), team_id: null, total_count: total };
}
function discovery(rows: unknown = [candidate()]) {
  const f = fixture();
  const original = f.options.fetchImpl;
  return {
    ...f,
    options: {
      ...f.options,
      query: 'Synthetic source title',
      scope: 'public100',
      limit: 20,
      fetchImpl: (async (input, init) => {
        const url = new URL(input);
        if (url.pathname === '/auth/v1/user') return original(input, init);
        f.calls.push({ url, init });
        assert.equal(url.pathname, '/rest/v1/rpc/search_sources');
        assert.equal(
          url.searchParams.get('select'),
          'rank,id,version,modified_at,team_id,total_count',
        );
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('Content-Profile'), 'api');
        const request = JSON.parse(String(init?.body));
        assert.equal(request.data_source, 'tg');
        assert.equal(request.state_code_filter, 100);
        assert.equal(request.page_current, 1);
        assert.equal(request.this_user_id, '');
        assert.deepEqual(request.filter_condition, {});
        assert.equal(request.team_id_filter, null);
        return new Response(JSON.stringify(rows));
      }) as FetchLike,
    },
  };
}

test('Source exact reads fence public100/101/199 and only current-owner state0 before full requests', async () => {
  for (const [state, owner, scope] of [
    [100, OTHER, 'public'],
    [101, OTHER, 'public'],
    [199, OTHER, 'public-or-owner-draft'],
    [0, USER, 'owner-draft'],
  ] as const) {
    const f = fixture(row('00.00.001', state, owner));
    try {
      const report = await runDatasetGet({ ...f.options, scope });
      const url = f.calls[1]!.url;
      if (state === 0) {
        assert.equal(url.searchParams.get('state_code'), 'eq.0');
        assert.equal(url.searchParams.get('user_id'), `eq.${USER}`);
      } else
        assert.ok(url.searchParams.get('or')!.includes('state_code.gte.100,state_code.lte.199'));
      assert.equal(report.selected.state_code, state);
      assert.equal(report.selected.user_id, owner);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  for (const [state, owner, scope] of [
    [0, OTHER, 'public-or-owner-draft'],
    [0, USER, 'public'],
    [100, USER, 'owner-draft'],
    [99, USER, 'public'],
    [200, USER, 'public'],
  ] as const) {
    const f = fixture(row('00.00.001', state, owner));
    try {
      await assert.rejects(runDatasetGet({ ...f.options, scope }), {
        code: 'DATASET_GET_SCOPE_VIOLATION',
      });
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Source body/schema/identity failures and missing exact rows never fall back or publish', async () => {
  const wrongUuid = source();
  wrongUuid.sourceDataSet.sourceInformation.dataSetInformation['common:UUID'] = OTHER;
  const invalidSchema = source();
  invalidSchema.sourceDataSet['@version'] = 'invalid';
  const inputs: unknown[] = [
    [],
    [row(), row()],
    [{ ...row(), id: OTHER }],
    [{ ...row(), version: '00.00.002' }],
    [{ ...row(), json_ordered: {} }],
    [{ ...row(), json_ordered: wrongUuid }],
    [{ ...row(), json_ordered: source('00.00.002') }],
    [{ ...row(), json: invalidSchema }],
    [{ ...row(), json: null, json_ordered: null }],
  ];
  for (const rows of inputs) {
    const f = fixture();
    const original = f.options.fetchImpl;
    try {
      await assert.rejects(
        runDatasetGet({
          ...f.options,
          fetchImpl: async (url, init) =>
            url.includes('/rest/') ? new Response(JSON.stringify(rows)) : original(url, init),
        }),
      );
      assert.equal(f.calls.filter((c) => c.url.pathname !== '/auth/v1/user').length, 0);
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Source body hashes bind changed content and exclusion facts bind exact input bytes and type', async () => {
  const hashes: string[] = [];
  for (let changed = 0; changed < 2; changed++) {
    const f = fixture();
    try {
      const exclusionsFile = path.join(f.root, 'excluded.json');
      const bytes =
        JSON.stringify(
          [
            { type: 'contact', id: ID, version: '00.00.001' },
            { type: 'source', id: ID, version: '00.00.002' },
          ],
          null,
          2,
        ) + '\n';
      writeFileSync(exclusionsFile, bytes.replace(/\\n$/u, '\n'));
      if (changed)
        f.selected.json_ordered.sourceDataSet.sourceInformation.dataSetInformation.sourceCitation +=
          ' Revised content.';
      const report = await runDatasetGet({ ...f.options, exclusionsFile });
      hashes.push(report.selected.payload_sha256);
      const inputBytes = readFileSync(exclusionsFile);
      assert.equal(
        report.exclusions!.sha256,
        createHash('sha256').update(inputBytes).digest('hex'),
      );
      assert.equal(report.exclusions!.entries, 2);
      assert.equal(
        report.selected.artifact.sha256,
        createHash('sha256').update(readFileSync(report.selected.artifact.path)).digest('hex'),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  assert.notEqual(hashes[0], hashes[1]);
});

test('an excluded latest Source is rejected after metadata and before its complete body', async () => {
  const f = fixture();
  const original = f.options.fetchImpl;
  let bodyReads = 0;
  try {
    const exclusionsFile = path.join(f.root, 'excluded.json');
    writeFileSync(
      exclusionsFile,
      JSON.stringify([{ type: 'source', id: ID, version: '00.00.002' }]),
    );
    await assert.rejects(
      runDatasetGet({
        ...f.options,
        includeLatest: true,
        exclusionsFile,
        fetchImpl: async (input, init) => {
          const url = new URL(input);
          if (url.pathname === '/auth/v1/user') return original(input, init);
          if (url.searchParams.get('select')!.includes('json')) {
            bodyReads++;
            return original(input, init);
          }
          assert.equal(url.searchParams.get('order'), 'version.desc');
          return new Response(
            JSON.stringify([
              {
                id: ID,
                version: '00.00.002',
                user_id: USER,
                state_code: 100,
                modified_at: NOW.toISOString(),
              },
            ]),
          );
        },
      }),
      { code: 'DATASET_GET_TYPED_VERSION_EXCLUDED' },
    );
    assert.equal(bodyReads, 1);
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('typed exclusions reject malformed, oversized, duplicate and non-file input without network access', async () => {
  const values: unknown[] = [
    {},
    [null],
    [{ type: 'source', id: ID, version: '00.00.001', extra: true }],
    [{ type: 1, id: ID, version: '00.00.001' }],
    [{ type: 'unknown', id: ID, version: '00.00.001' }],
    [{ type: 'source', id: 1, version: '00.00.001' }],
    [{ type: 'source', id: 'invalid', version: '00.00.001' }],
    [{ type: 'source', id: ID, version: 1 }],
    [{ type: 'source', id: ID, version: 'invalid' }],
    Array(2).fill({ type: 'source', id: ID, version: '00.00.001' }),
    Array(10001).fill({}),
  ];
  const inputs = [
    ...values.map((x) => Buffer.from(JSON.stringify(x))),
    Buffer.from([255]),
    Buffer.from('{'),
    Buffer.alloc(1024 * 1024 + 1),
  ];
  for (const bytes of inputs) {
    const f = fixture();
    try {
      const exclusionsFile = path.join(f.root, 'excluded.json');
      writeFileSync(exclusionsFile, bytes);
      await assert.rejects(runDatasetGet({ ...f.options, exclusionsFile }), {
        code: 'DATASET_GET_EXCLUSIONS_INVALID',
      });
      assert.equal(f.calls.length, 0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const f = fixture();
  try {
    for (const exclusionsFile of [f.root, path.join(f.root, 'missing')])
      await assert.rejects(runDatasetGet({ ...f.options, exclusionsFile }), {
        code: 'DATASET_GET_EXCLUSIONS_INVALID',
      });
    assert.equal(f.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source discovery reports empty and truncated observations without match or absence claims', async () => {
  for (const rows of [
    [],
    [candidate()],
    [{ ...candidate(), modified_at: null, team_id: OTHER, total_count: '9223372036854775807' }],
  ]) {
    const f = discovery(rows);
    try {
      const report = await runDatasetSourceDiscover({ ...f.options, limit: undefined });
      assert.equal(report.requested_limit, 20);
      assert.equal(report.strict_match_evaluated, false);
      assert.equal(report.matched_version_proven, false);
      assert.equal(report.catalogue_absence_proven, false);
      assert.equal(report.partial, true);
      assert.equal(
        report.page_truncated,
        rows.length === 0 ? null : typeof rows[0]!.total_count === 'string',
      );
      assert.equal(
        report.server_total_count,
        rows.length === 0 ? null : String(rows[0]!.total_count),
      );
      assert.equal(f.calls.length, 2);
      assert.equal(
        report.artifacts.response.sha256,
        createHash('sha256').update(readFileSync(report.artifacts.response.path)).digest('hex'),
      );
      assert.equal(
        report.request_sha256,
        sha256Json(JSON.parse(readFileSync(report.artifacts.request.path, 'utf8'))),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Source discovery applies explicit typed exclusions without fetching candidate bodies', async () => {
  const f = discovery(
    [candidate(), candidate(OTHER, '00.00.001', 2, 2)].map((r) => ({ ...r, total_count: 2 })),
  );
  try {
    const exclusionsFile = path.join(f.root, 'excluded.json');
    writeFileSync(
      exclusionsFile,
      JSON.stringify([
        { type: 'source', id: ID, version: '00.00.002' },
        { type: 'contact', id: OTHER, version: '00.00.001' },
      ]),
    );
    const report = await runDatasetSourceDiscover({ ...f.options, exclusionsFile });
    assert.equal(report.excluded_count, 1);
    assert.deepEqual(
      report.candidates.map((c) => c.id),
      [OTHER],
    );
    assert.equal(report.observed_count, 2);
    assert.equal(report.exclusions!.entries, 2);
    assert.equal(f.calls.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('discovery rejects invalid caller bounds and scope before any data request', async () => {
  const f = discovery();
  try {
    for (const patch of [
      { query: '' },
      { query: '  ' },
      { query: '文'.repeat(1400) },
      { scope: '' },
      { scope: 'public' },
      { scope: 'owner-draft' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: NaN },
      { expectedProjectRef: '' },
      { expectedUserId: '' },
      { outDir: '' },
      { timeoutMs: 0 },
      { timeoutMs: 120001 },
    ]) {
      await assert.rejects(runDatasetSourceDiscover({ ...f.options, ...patch }));
      assert.equal(f.calls.length, 0);
    }
    mkdirSync(f.options.outDir);
    await assert.rejects(runDatasetSourceDiscover(f.options), {
      code: 'DATASET_SOURCE_DISCOVER_OUTPUT_EXISTS',
    });
    assert.equal(f.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source discovery fails closed on non-metadata rows, malformed identity/counts, duplicates and ordering', async () => {
  const badRows: unknown[] = [
    null,
    {},
    Array(21).fill(candidate()),
    [null],
    [{ ...candidate(), json: source() }],
    [{ ...candidate(), id: 1 }],
    [{ ...candidate(), id: 'bad' }],
    [{ ...candidate(), version: 1 }],
    [{ ...candidate(), version: 'latest' }],
    [{ ...candidate(), modified_at: 1 }],
    [{ ...candidate(), modified_at: 'invalid' }],
    [{ ...candidate(), team_id: 1 }],
    [{ ...candidate(), team_id: 'invalid' }],
  ];
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808', null])
    badRows.push([{ ...candidate(), rank: bad }]);
  badRows.push(
    [candidate(ID, '00.00.001', 2, 1)],
    [candidate(ID, '00.00.001', 1, 1), candidate(OTHER, '00.00.001', 2, 2)],
    [candidate(ID, '00.00.001', 1, 2), candidate(OTHER, '00.00.001', 2, 3)],
    [candidate(ID, '00.00.001', 1, 2), candidate(ID, '00.00.002', 2, 2)],
    [candidate(ID, '00.00.001', 2, 2), candidate(OTHER, '00.00.001', 1, 2)],
    [candidate(OTHER, '00.00.001', 1, 2), candidate(ID, '00.00.001', 1, 2)],
  );
  for (const rows of badRows) {
    const f = discovery(rows);
    try {
      await assert.rejects(runDatasetSourceDiscover(f.options));
      assert.equal(existsSync(f.options.outDir), false);
      assert.equal(f.calls.length, 2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const f = discovery([
    candidate(ID, '00.00.001', '1', '2'),
    candidate(OTHER, '00.00.001', '1', '2'),
  ]);
  try {
    assert.equal((await runDatasetSourceDiscover(f.options)).candidates.length, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source RPC read-only refresh rechecks the actor before its one permitted replay', async () => {
  for (const mode of ['success', 'still-denied', 'wrong-actor'] as const) {
    const f = discovery();
    const original = f.options.fetchImpl;
    let dataCalls = 0;
    let resolutions = 0;
    try {
      const options = {
        ...f.options,
        resolveSessionImpl: async (request: { forceRefresh?: boolean }) => {
          resolutions++;
          if (resolutions === 2) assert.equal(request.forceRefresh, true);
          return { ...session, accessToken: resolutions === 1 ? 'first-token' : 'refreshed-token' };
        },
        fetchImpl: async (url: string, init?: RequestInit) => {
          if (url.includes('/rest/')) {
            dataCalls++;
            if (dataCalls === 1 || mode === 'still-denied')
              return new Response('PRIVATE_CANARY', { status: 401 });
            assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer refreshed-token');
          } else if (mode === 'wrong-actor' && resolutions > 1)
            return new Response(JSON.stringify({ id: OTHER, role: 'authenticated' }), {
              headers: { 'content-type': 'application/json' },
            });
          return original(url, init);
        },
      };
      if (mode === 'success')
        assert.equal((await runDatasetSourceDiscover(options)).status, 'completed');
      else {
        await assert.rejects(runDatasetSourceDiscover(options), {
          code: 'DATASET_SOURCE_DISCOVER_READ_FAILED',
        });
        assert.equal(existsSync(f.options.outDir), false);
      }
      assert.equal(resolutions, 2);
      assert.equal(dataCalls, mode === 'wrong-actor' ? 1 : 2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Source discovery redacts HTTP, transport, decoding and JSON failures and enforces metadata byte caps', async () => {
  for (const response of [
    () => new Response('PRIVATE_CANARY', { status: 500 }),
    () => {
      throw new Error('PRIVATE_CANARY');
    },
    () => new Response('PRIVATE_CANARY'),
    () => new Response(new Uint8Array([255])),
    () => new Response('[]', { headers: { 'content-length': String(64 * 1024 + 1) } }),
    () => new Response(' '.repeat(64 * 1024 + 1)),
    () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => ' '.repeat(64 * 1024 + 1),
    }),
  ]) {
    const f = discovery();
    const original = f.options.fetchImpl;
    try {
      await assert.rejects(
        runDatasetSourceDiscover({
          ...f.options,
          fetchImpl: async (url, init) =>
            url.includes('/rest/') ? response() : original(url, init),
        }),
        (error: unknown) => {
          assert.equal(String(error).includes('PRIVATE_CANARY'), false);
          assert.equal(JSON.stringify(error).includes('PRIVATE_CANARY'), false);
          return true;
        },
      );
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const f = discovery();
  const original = f.options.fetchImpl;
  try {
    const report = await runDatasetSourceDiscover({
      ...f.options,
      fetchImpl: async (url, init) =>
        url.includes('/rest/')
          ? new Response(new TextEncoder().encode(JSON.stringify([candidate()])))
          : original(url, init),
    });
    assert.equal(report.candidates.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source read budgets cover identity responses and every resolver request', async () => {
  const f = discovery();
  try {
    await assert.rejects(
      runDatasetSourceDiscover({
        ...f.options,
        resolveSessionImpl: async (request) => {
          for (let i = 0; i < 17; i++)
            await request.fetchImpl(`https://${PROJECT}.supabase.co/auth/v1/user`);
          return session;
        },
      }),
    );
    assert.equal(f.calls.length, 16);
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  for (const headers of [
    { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) },
    {},
  ] as HeadersInit[]) {
    const f = discovery();
    try {
      let requests = 0;
      await assert.rejects(
        runDatasetSourceDiscover({
          ...f.options,
          fetchImpl: async () => {
            requests++;
            return new Response(JSON.stringify({ id: USER, role: 'authenticated' }), { headers });
          },
        }),
      );
      assert.equal(requests, 1);
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Source discovery deadline blocks late output even when a fetch adapter ignores cancellation', async () => {
  const f = discovery();
  const original = f.options.fetchImpl;
  let lateReturned = false;
  try {
    await assert.rejects(
      runDatasetSourceDiscover({
        ...f.options,
        timeoutMs: 5,
        fetchImpl: async (url, init) => {
          if (!url.includes('/rest/')) return original(url, init);
          await new Promise((resolve) => setTimeout(resolve, 30));
          lateReturned = true;
          return new Response(JSON.stringify([candidate()]));
        },
      }),
      { code: 'DATASET_SOURCE_DISCOVER_TIME_LIMIT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lateReturned, true);
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Source discovery preserves a competing output directory and removes failed writes', async () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const originalWrite = fs.writeFileSync;
  for (const mode of ['collision', 'write-error'] as const) {
    const f = discovery();
    const original = f.options.fetchImpl;
    try {
      if (mode === 'write-error') {
        fs.writeFileSync = ((file: string, ...args: unknown[]) => {
          if (String(file).endsWith('source-discovery-report.json.tmp'))
            throw new Error('PRIVATE_CANARY');
          return (originalWrite as (...args: unknown[]) => unknown)(file, ...args);
        }) as typeof fs.writeFileSync;
        syncBuiltinESMExports();
      }
      await assert.rejects(
        runDatasetSourceDiscover({
          ...f.options,
          fetchImpl: async (url, init) => {
            if (mode === 'collision' && url.includes('/rest/')) {
              mkdirSync(f.options.outDir);
              originalWrite(path.join(f.options.outDir, 'keep.txt'), 'preserve');
            }
            return original(url, init);
          },
        }),
        {
          code:
            mode === 'collision'
              ? 'DATASET_SOURCE_DISCOVER_OUTPUT_EXISTS'
              : 'DATASET_SOURCE_DISCOVER_ARTIFACT_WRITE_FAILED',
        },
      );
      if (mode === 'collision')
        assert.equal(readFileSync(path.join(f.options.outDir, 'keep.txt'), 'utf8'), 'preserve');
      else assert.equal(existsSync(f.options.outDir), false);
    } finally {
      fs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('typed exclusion reads reject a changed descriptor or growth beyond the input byte cap', async () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const originalFstat = fs.fstatSync;
  for (const mode of ['descriptor', 'growth'] as const) {
    const f = fixture();
    const exclusionsFile = path.join(f.root, 'excluded.json');
    writeFileSync(exclusionsFile, '[]');
    try {
      fs.fstatSync = ((fd: number) => {
        const stat = originalFstat(fd);
        if (mode === 'descriptor') return Object.assign(stat, { isFile: () => false });
        writeFileSync(exclusionsFile, Buffer.alloc(1024 * 1024 + 1));
        return stat;
      }) as typeof fs.fstatSync;
      syncBuiltinESMExports();
      await assert.rejects(runDatasetGet({ ...f.options, exclusionsFile }), {
        code: 'DATASET_GET_EXCLUSIONS_INVALID',
      });
      assert.equal(f.calls.length, 0);
    } finally {
      fs.fstatSync = originalFstat;
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('public Source help, required/default flags and typed-exclusion forwarding stay in CLI dispatch', async () => {
  const f = discovery();
  try {
    for (const args of [
      ['dataset', 'source'],
      ['dataset', 'source', '--help'],
      ['dataset', 'source', 'discover'],
      ['dataset', 'source', 'discover', '--help'],
    ]) {
      const result = await executeCli(args, {
        env,
        fetchImpl: f.options.fetchImpl,
        dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /candidate|matched-version/u);
    }
    const missing = await executeCli(['dataset', 'source', 'discover', '--scope', 'public100'], {
      env,
      fetchImpl: f.options.fetchImpl,
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    });
    assert.equal(missing.exitCode, 2);
    assert.equal(f.calls.length, 0);
    const missingScope = await executeCli(['dataset', 'source', 'discover', '--query', 'title'], {
      env,
      fetchImpl: f.options.fetchImpl,
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    });
    assert.equal(missingScope.exitCode, 2);
    assert.match(missingScope.stderr, /DATASET_SOURCE_DISCOVER_SCOPE_REQUIRED/u);
    assert.equal(f.calls.length, 0);
    const exclusionsFile = path.join(f.root, 'excluded.json');
    writeFileSync(exclusionsFile, '[]');
    const result = await executeCli(
      [
        'dataset',
        'source',
        'discover',
        '--query',
        'test',
        '--scope',
        'public100',
        '--out-dir',
        f.options.outDir,
        '--expected-project-ref',
        PROJECT,
        '--expected-user-id',
        USER,
        '--timeout-ms',
        '5000',
        '--exclude-typed-versions',
        exclusionsFile,
      ],
      {
        env,
        fetchImpl: f.options.fetchImpl,
        dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
        runDatasetSourceDiscoverImpl: async (options) => {
          assert.equal(options.limit, undefined);
          assert.equal(options.timeoutMs, 5000);
          assert.equal(options.exclusionsFile, exclusionsFile);
          return runDatasetSourceDiscover({
            ...options,
            fetchImpl: f.options.fetchImpl,
            resolveSessionImpl: async () => session,
          });
        },
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const read = fixture();
    try {
      const got = await executeCli(
        [
          'dataset',
          'get',
          '--type',
          'source',
          '--id',
          ID,
          '--version',
          '00.00.001',
          '--scope',
          'public',
          '--out-dir',
          read.options.outDir,
          '--expected-project-ref',
          PROJECT,
          '--expected-user-id',
          USER,
          '--exclude-typed-versions',
          exclusionsFile,
        ],
        {
          env,
          fetchImpl: read.options.fetchImpl,
          dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
          runDatasetGetImpl: async (options) => {
            assert.equal(options.exclusionsFile, exclusionsFile);
            assert.equal(options.type, 'source');
            return runDatasetGet({ ...options, resolveSessionImpl: async () => session });
          },
        },
      );
      assert.equal(got.exitCode, 0, got.stderr);
    } finally {
      rmSync(read.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
