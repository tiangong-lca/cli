import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { executeCli } from '../src/cli.js';
import {
  loadExactReferenceIntent,
  evaluateExactReference,
} from '../src/lib/dataset-exact-reference-intent.js';
import type {
  RemoteDatasetReference,
  RemoteVerificationCheck,
} from '../src/lib/dataset-remote-verify.js';
import { runDatasetGet } from '../src/lib/dataset-get.js';
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
  TIANGONG_LCA_SESSION_FILE: path.join(tmpdir(), 'dataset-get-fixture-session.json'),
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
function contact(version = '00.00.001') {
  return {
    contactDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Contact',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Contact ../../schemas/ILCD_ContactDataSet.xsd',
      contactInformation: {
        dataSetInformation: {
          'common:UUID': ID,
          'common:shortName': [{ '@xml:lang': 'en', '#text': 'Test institute' }],
          'common:name': [{ '@xml:lang': 'en', '#text': 'Synthetic research institute' }],
          classificationInformation: {
            'common:classification': {
              'common:class': { '@level': '0', '@classId': '2', '#text': 'Organisations' },
            },
          },
          contactDescriptionOrComment: [
            { '@xml:lang': 'en', '#text': 'Complete first paragraph.\nComplete second paragraph.' },
            { '@xml:lang': 'zh', '#text': '完整第一段。\n完整第二段。' },
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
    json: contact(version),
    json_ordered: contact(version),
  };
}
function fixture(selected = row(), latest = row('00.00.002', 0)) {
  const root = mkdtempSync(path.join(tmpdir(), 'dataset-get-'));
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
    assert.equal(url.pathname, '/rest/v1/contacts');
    assert.equal(url.searchParams.get('id'), `eq.${ID}`);
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(new Headers(init?.headers).get('Accept-Profile'), 'public');
    if (!url.searchParams.get('select')?.includes('json')) {
      const { json: _json, json_ordered: _ordered, ...metadata } = latest;
      return new Response(JSON.stringify([metadata]));
    }
    assert.ok(url.searchParams.has('or') || url.searchParams.has('state_code'));
    const value = url.searchParams.get('version') === `eq.${selected.version}` ? selected : latest;
    return new Response(JSON.stringify([value]));
  };
  return {
    root,
    calls,
    selected,
    latest,
    options: {
      type: 'contact',
      id: ID,
      version: selected.version,
      scope: 'public-or-owner-draft',
      includeLatest: true,
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

test('dataset get exports complete exact and RLS-visible latest Contacts with explicit content scope', async () => {
  const f = fixture();
  try {
    assert.equal(tidasSdk.ContactSchema.safeParse(contact()).success, true);
    const report = await runDatasetGet(f.options);
    assert.equal(report.selected.version, '00.00.001');
    assert.equal(report.latest?.version, '00.00.002');
    assert.equal(report.latest_resolution, 'rls-visible');
    assert.equal(report.selected.payload_sha256, sha256Json(f.selected.json_ordered));
    assert.deepEqual(JSON.parse(readFileSync(report.selected.artifact.path, 'utf8')), [f.selected]);
    assert.deepEqual(JSON.parse(readFileSync(report.latest!.artifact.path, 'utf8')), [f.latest]);
    assert.equal(JSON.stringify(report).includes(session.accessToken), false);
    assert.equal(f.calls.filter((c) => c.url.pathname.includes('/rest/')).length, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('dataset get is available through the public CLI with explicit argument and help gates', async () => {
  const f = fixture();
  const deps = {
    env,
    fetchImpl: f.options.fetchImpl,
    dotEnvStatus: { loaded: false, path: '.env', count: 0 },
  };
  try {
    const help = await executeCli(['dataset', 'get', '--help'], deps);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /--scope/u);
    const result = await executeCli(
      [
        'dataset',
        'get',
        '--type',
        'contact',
        '--id',
        ID,
        '--version',
        '00.00.001',
        '--scope',
        'public',
        '--out-dir',
        f.options.outDir,
        '--expected-project-ref',
        PROJECT,
        '--expected-user-id',
        USER,
        '--include-latest',
        '--timeout-ms',
        '1000',
        '--json',
      ],
      {
        ...deps,
        runDatasetGetImpl: async (options) => {
          assert.equal(options.scope, 'public');
          assert.equal(options.includeLatest, true);
          assert.equal(options.timeoutMs, 1000);
          return runDatasetGet({
            ...options,
            scope: 'public-or-owner-draft',
            resolveSessionImpl: async () => session,
          });
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).selected.id, ID);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function rejectsResponse(body: unknown, code: string) {
  const f = fixture();
  const base = f.options.fetchImpl;
  try {
    await assert.rejects(
      runDatasetGet({
        ...f.options,
        fetchImpl: async (url, init) =>
          url.includes('/rest/') ? new Response(JSON.stringify(body)) : base(url, init),
      }),
      { code },
    );
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test('explicit public and own-draft scopes preserve both supported payload columns and nullable timestamps', async () => {
  for (const [state, owner, scope] of [
    [100, OTHER, 'public'],
    [101, OTHER, 'public'],
    [199, OTHER, 'public'],
    [0, USER, 'owner-draft'],
    [0, USER, 'public-or-owner-draft'],
  ] as const) {
    const selected = { ...row('00.00.001', state, owner), modified_at: null };
    const f = fixture(selected as never);
    try {
      const report = await runDatasetGet({ ...f.options, scope, includeLatest: false });
      assert.equal(report.selected.state_code, state);
      assert.equal(report.selected.user_id, owner);
      assert.equal(report.latest, null);
      assert.equal(report.latest_resolution, 'not-requested');
      assert.equal(report.selected.modified_at, null);
      if (scope === 'owner-draft')
        assert.equal(f.calls[1]?.url.searchParams.get('user_id'), `eq.${USER}`);
      else
        assert.match(
          f.calls[1]!.url.searchParams.get('or')!,
          /state_code.gte.100,state_code.lte.199/u,
        );
      if (process.platform !== 'win32') {
        assert.equal(statSync(f.options.outDir).mode & 0o777, 0o700);
        assert.equal(statSync(report.selected.artifact.path).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  for (const key of ['json', 'json_ordered']) {
    const f = fixture({ ...row(), [key]: null } as never);
    try {
      assert.equal(
        (await runDatasetGet({ ...f.options, includeLatest: false })).selected.payload_sha256,
        sha256Json(contact()),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('invalid selection, scope, identity assertions and output paths fail before Contact queries', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { type: 'flow' },
      { id: '' },
      { version: 'latest' },
      { scope: '' },
      { scope: 'rls-visible' },
      { expectedProjectRef: '' },
      { expectedUserId: '' },
      { outDir: '' },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { timeoutMs: 120001 },
      { expectedProjectRef: 'wrongproject' },
      { expectedUserId: OTHER },
    ]) {
      await assert.rejects(runDatasetGet({ ...f.options, ...patch }));
    }
    assert.equal(
      f.calls.some((c) => c.url.pathname.includes('/rest/')),
      false,
    );
    writeFileSync(f.options.outDir, 'preserve');
    await assert.rejects(runDatasetGet(f.options), { code: 'DATASET_GET_OUTPUT_EXISTS' });
    assert.equal(readFileSync(f.options.outDir, 'utf8'), 'preserve');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing, duplicate, malformed and mismatched exact rows never fall back or publish artifacts', async () => {
  for (const body of [[], {}, [row(), row(), row()], [row(), row()]])
    await rejectsResponse(body, 'DATASET_GET_ROW_COUNT');
  for (const body of [
    null,
    {},
    { ...row(), id: OTHER },
    { ...row(), version: null },
    { ...row(), version: 'latest' },
    { ...row(), user_id: 1 },
    { ...row(), user_id: 'bad' },
    { ...row(), state_code: 1.5 },
    { ...row(), modified_at: 'not a date' },
    { ...row(), extra: 'unexpected' },
  ])
    await rejectsResponse([body], 'DATASET_GET_ROW_INVALID');
  await rejectsResponse([row('00.00.002')], 'DATASET_GET_VERSION_MISMATCH');
  await rejectsResponse([row('00.00.001', 0, OTHER)], 'DATASET_GET_SCOPE_VIOLATION');
  await rejectsResponse([row('00.00.001', 200, OTHER)], 'DATASET_GET_SCOPE_VIOLATION');
  for (const patch of [
    { json: [], json_ordered: contact() },
    { json: { processDataSet: {} } },
    { json: null, json_ordered: null },
  ])
    await rejectsResponse([{ ...row(), ...patch }], 'DATASET_GET_PAYLOAD_INVALID');
  const wrongId = contact();
  wrongId.contactDataSet.contactInformation.dataSetInformation['common:UUID'] = OTHER;
  await rejectsResponse([{ ...row(), json_ordered: wrongId }], 'DATASET_GET_PAYLOAD_MISMATCH');
  await rejectsResponse(
    [{ ...row(), json_ordered: contact('00.00.002') }],
    'DATASET_GET_PAYLOAD_MISMATCH',
  );
  const invalid = contact();
  delete (invalid.contactDataSet.contactInformation.dataSetInformation as Record<string, unknown>)[
    'common:name'
  ];
  await rejectsResponse([{ ...row(), json_ordered: invalid }], 'DATASET_GET_SCHEMA_INVALID');
});

test('RLS-visible foreign latest metadata cannot cause a full foreign-draft read', async () => {
  const f = fixture(row(), row('00.00.002', 0, OTHER));
  try {
    await assert.rejects(runDatasetGet(f.options), { code: 'DATASET_GET_LATEST_OUTSIDE_SCOPE' });
    const bodyCalls = f.calls.filter((c) => c.url.searchParams.get('select')?.includes('json'));
    assert.equal(bodyCalls.length, 1);
    assert.equal(bodyCalls[0]?.url.searchParams.get('version'), 'eq.00.00.001');
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('latest metadata must be bounded, correctly ordered and unchanged before exact body retrieval', async () => {
  for (const mode of ['duplicates', 'unordered', 'payload-leak', 'drift', 'ordered'] as const) {
    const f = fixture();
    const base = f.options.fetchImpl;
    try {
      const options = {
        ...f.options,
        fetchImpl: async (url: string, init?: RequestInit) => {
          const parsed = new URL(url);
          if (
            parsed.pathname.includes('/rest/') &&
            !parsed.searchParams.get('select')?.includes('json')
          ) {
            const { json: _json, json_ordered: _ordered, ...latest } = f.latest;
            return new Response(
              JSON.stringify(
                mode === 'payload-leak'
                  ? [{ ...latest, json: contact() }]
                  : mode === 'drift'
                    ? [{ ...latest, modified_at: '2026-09-15T08:01:00Z' }]
                    : [
                        latest,
                        {
                          ...latest,
                          version:
                            mode === 'duplicates'
                              ? latest.version
                              : mode === 'unordered'
                                ? '00.00.003'
                                : '00.00.001',
                        },
                      ],
              ),
            );
          }
          return base(url, init);
        },
      };
      if (mode === 'ordered')
        assert.equal((await runDatasetGet(options)).latest?.version, '00.00.002');
      else
        await assert.rejects(runDatasetGet(options), {
          code:
            mode === 'payload-leak'
              ? 'DATASET_GET_ROW_INVALID'
              : mode === 'drift'
                ? 'DATASET_GET_CONTENT_DRIFT'
                : 'DATASET_GET_LATEST_AMBIGUOUS',
        });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('read failures never disclose remote bodies or arbitrary thrown secrets', async () => {
  const f = fixture();
  const base = f.options.fetchImpl;
  try {
    for (const response of [
      () => new Response('PRIVATE_CANARY', { status: 500 }),
      () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => 'PRIVATE_CANARY',
      }),
      () => {
        throw new Error('PRIVATE_CANARY');
      },
      () => new Response('PRIVATE_CANARY'),
    ]) {
      await assert.rejects(
        runDatasetGet({
          ...f.options,
          fetchImpl: async (url, init) => (url.includes('/rest/') ? response() : base(url, init)),
        }),
        (error: unknown) => {
          assert.equal(JSON.stringify(error).includes('PRIVATE_CANARY'), false);
          assert.match((error as Error).message, /Contact/u);
          return true;
        },
      );
      assert.equal(existsSync(f.options.outDir), false);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a single read-only auth refresh verifies the actor again before replaying the same GET', async () => {
  for (const mode of ['success', 'still-denied', 'wrong-actor'] as const) {
    const f = fixture();
    const base = f.options.fetchImpl;
    let dataCalls = 0;
    let resolutions = 0;
    try {
      const options = {
        ...f.options,
        includeLatest: false,
        resolveSessionImpl: async (request: { forceRefresh?: boolean }) => {
          resolutions += 1;
          if (resolutions === 2) assert.equal(request.forceRefresh, true);
          return { ...session, accessToken: resolutions === 1 ? 'first-token' : 'refreshed-token' };
        },
        fetchImpl: async (url: string, init?: RequestInit) => {
          if (url.includes('/rest/')) {
            dataCalls += 1;
            if (dataCalls === 1 || mode === 'still-denied')
              return new Response('PRIVATE_CANARY', { status: 401 });
            assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer refreshed-token');
          } else if (mode === 'wrong-actor' && resolutions > 1)
            return new Response(JSON.stringify({ id: OTHER, email: session.userEmail }), {
              headers: { 'content-type': 'application/json' },
            });
          return base(url, init);
        },
      };
      if (mode === 'success') assert.equal((await runDatasetGet(options)).status, 'completed');
      else await assert.rejects(runDatasetGet(options), { code: 'DATASET_GET_READ_FAILED' });
      assert.equal(resolutions, 2);
      assert.equal(dataCalls, mode === 'wrong-actor' ? 1 : 2);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('the existing explicitly verified headless-token owner remains available without refresh replay', async () => {
  const f = fixture();
  try {
    const report = await runDatasetGet({
      ...f.options,
      includeLatest: false,
      resolveSessionImpl: undefined,
      env: {
        ...env,
        TIANGONG_LCA_AUTH_MODE: 'access-token',
        TIANGONG_LCA_ACCESS_TOKEN: 'fixture-headless-token',
      },
    });
    assert.equal(report.actor_user_id, USER);
    assert.equal(report.selected.id, ID);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('per-response and total byte caps stop text, streaming and declared oversized responses', async () => {
  const f = fixture();
  const base = f.options.fetchImpl;
  let canceled = false;
  const max = 4 * 1024 * 1024;
  try {
    for (const response of [
      () => new Response('[]', { headers: { 'content-length': String(max + 1) } }),
      () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => ' '.repeat(max + 1),
      }),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(max + 1));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    ]) {
      await assert.rejects(
        runDatasetGet({
          ...f.options,
          fetchImpl: async (url, init) => (url.includes('/rest/') ? response() : base(url, init)),
        }),
        { code: 'DATASET_GET_BYTE_LIMIT' },
      );
    }
    assert.equal(canceled, true);
    await assert.rejects(
      runDatasetGet({
        ...f.options,
        fetchImpl: async (url, init) => {
          const response = await base(url, init);
          if (new URL(url).searchParams.get('select')?.includes('json')) {
            const text = await response.text();
            return new Response(text + ' '.repeat(max - Buffer.byteLength(text)));
          }
          return response;
        },
      }),
      { code: 'DATASET_GET_BYTE_LIMIT' },
    );
    assert.equal(existsSync(f.options.outDir), false);
    const report = await runDatasetGet({
      ...f.options,
      includeLatest: false,
      fetchImpl: async (url, init) => {
        if (url.includes('/rest/'))
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify([row()]),
          };
        return base(url, init);
      },
    });
    assert.equal(report.selected.id, ID);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the operation deadline blocks late uncooperative fetch completion from writing artifacts', async () => {
  const f = fixture();
  const base = f.options.fetchImpl;
  let finish: ((value: Response) => void) | undefined;
  let reached = false;
  try {
    const result = runDatasetGet({
      ...f.options,
      timeoutMs: 30,
      fetchImpl: async (url, init) => {
        if (!url.includes('/rest/')) return base(url, init);
        reached = true;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
    });
    await assert.rejects(result, { code: 'DATASET_GET_TIME_LIMIT' });
    assert.equal(reached, true);
    assert.equal(existsSync(f.options.outDir), false);
    finish!(new Response(JSON.stringify([row()])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('output reservation collisions preserve another writer and failed publication removes only this result', async () => {
  const require = createRequire(import.meta.url);
  const fs = require('node:fs') as typeof import('node:fs');
  const originalMkdir = fs.mkdirSync;
  const originalWrite = fs.writeFileSync;
  for (const mode of ['collision', 'reservation-error', 'write-error'] as const) {
    const f = fixture();
    try {
      fs.mkdirSync = ((target: string, ...args: unknown[]) => {
        if (path.resolve(target) === f.options.outDir && mode !== 'write-error') {
          if (mode === 'collision') {
            originalMkdir(target);
            originalWrite(path.join(target, 'keep.txt'), 'preserve');
          }
          throw Object.assign(new Error('PRIVATE_CANARY'), {
            code: mode === 'collision' ? 'EEXIST' : 'EACCES',
          });
        }
        return (originalMkdir as (...values: unknown[]) => unknown)(target, ...args);
      }) as typeof fs.mkdirSync;
      fs.writeFileSync = ((target: string, ...args: unknown[]) => {
        if (String(target).endsWith('get-report.json.tmp') && mode === 'write-error')
          throw new Error('PRIVATE_CANARY');
        return (originalWrite as (...values: unknown[]) => unknown)(target, ...args);
      }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      await assert.rejects(runDatasetGet({ ...f.options, includeLatest: false }), {
        code:
          mode === 'collision' ? 'DATASET_GET_OUTPUT_EXISTS' : 'DATASET_GET_ARTIFACT_WRITE_FAILED',
      });
      if (mode === 'collision')
        assert.equal(readFileSync(path.join(f.options.outDir, 'keep.txt'), 'utf8'), 'preserve');
      else assert.equal(existsSync(f.options.outDir), false);
    } finally {
      fs.mkdirSync = originalMkdir;
      fs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

function reviewIntent(
  root: string,
  selected: Awaited<ReturnType<typeof runDatasetGet>>['selected'],
  latest: Awaited<ReturnType<typeof runDatasetGet>>['selected'],
) {
  const snapshot = (value: typeof selected) => ({
    table: value.table,
    id: value.id,
    version: value.version,
    payload_sha256: value.payload_sha256,
    user_id: value.user_id,
    state_code: value.state_code,
  });
  const consumers = [
    {
      row_index: 0,
      table: 'processes' as const,
      id: OTHER,
      version: '00.00.001',
      payload_sha256: sha256Json({ synthetic: 'exact consumer bytes' }),
    },
  ];
  const reference: RemoteDatasetReference = {
    row_index: 0,
    role: 'reference',
    table: 'contacts',
    type: 'contact data set',
    id: ID,
    version: selected.version,
    path: '/processDataSet/contact',
    short_description: null,
  };
  const file = path.join(root, 'intent.json');
  const review = path.join(root, 'review.json');
  writeFileSync(
    review,
    JSON.stringify({
      schema_version: 'dataset-exact-reference-review.v1',
      decision: 'use_selected_exact',
      reason:
        'The independently reviewed selected contact describes the source institution for this consumer.',
      selected: snapshot(selected),
      latest: snapshot(latest),
    }),
  );
  const reviewHash = createHash('sha256').update(readFileSync(review)).digest('hex');
  writeFileSync(
    file,
    JSON.stringify({
      schema_version: 'dataset-exact-reference-intent.v1',
      project_ref: PROJECT,
      actor_user_id: USER,
      consumers,
      references: [
        {
          row_index: 0,
          path: reference.path,
          selected: snapshot(selected),
          review: { file: review, sha256: reviewHash },
        },
      ],
    }),
  );
  return { file, consumers, references: [reference] };
}

test('complete Contact observations feed unchanged exact-reference pins and never widen eligibility', async () => {
  for (const state of [100, 0, 101, 199]) {
    const f = fixture(row('00.00.001', state), row('00.00.002', state));
    try {
      const report = await runDatasetGet(f.options);
      const input = reviewIntent(f.root, report.selected, report.latest!);
      if (state === 101 || state === 199) {
        assert.throws(() => loadExactReferenceIntent(input), /state 100/u);
        continue;
      }
      const intent = loadExactReferenceIntent(input);
      const check: RemoteVerificationCheck = {
        ...input.references[0]!,
        status: 'version_outdated',
        exact_version: report.selected.version,
        latest_version: report.latest!.version,
        exact_source_url: null,
        latest_source_url: null,
        message: 'A newer visible version exists.',
      };
      const result = evaluateExactReference({
        intent,
        pin: intent.references[0]!,
        check,
        selected: report.selected,
        latest: report.latest,
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.reference_intent?.applied, true);
      assert.equal(
        evaluateExactReference({
          intent,
          pin: intent.references[0]!,
          check,
          selected: { ...report.selected, payload_sha256: '0'.repeat(64) },
          latest: report.latest,
        }).reference_intent?.failure,
        'selected_snapshot_mismatch',
      );
      assert.equal(
        evaluateExactReference({
          intent,
          pin: intent.references[0]!,
          check,
          selected: report.selected,
          latest: { ...report.latest!, payload_sha256: '0'.repeat(64) },
        }).reference_intent?.failure,
        'latest_review_changed',
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('public CLI rejects missing bounds and preserves optional argument defaults', async () => {
  const deps = {
    env: {},
    fetchImpl: async () => {
      throw new Error('Unexpected network');
    },
    dotEnvStatus: { loaded: false, path: '.env', count: 0 },
  };
  for (const args of [[], ['-h']])
    assert.equal((await executeCli(['dataset', 'get', ...args], deps)).exitCode, 0);
  for (const args of [
    ['--unknown'],
    ['--type', 'contact'],
    ['--id', ID],
    ['--version', '00.00.001'],
  ])
    assert.notEqual((await executeCli(['dataset', 'get', ...args], deps)).exitCode, 0);
  const f = fixture();
  try {
    const result = await executeCli(
      ['dataset', 'get', '--type', 'contact', '--id', ID, '--version', '00.00.001'],
      {
        ...deps,
        runDatasetGetImpl: async (options) => {
          assert.equal(options.scope, '');
          assert.equal(options.outDir, '');
          assert.equal(options.expectedProjectRef, '');
          assert.equal(options.expectedUserId, '');
          assert.equal(options.includeLatest, false);
          assert.equal(options.timeoutMs, undefined);
          return runDatasetGet({ ...f.options, includeLatest: false });
        },
      },
    );
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('session adapter GETs inherit the operation deadline when request options are omitted', async () => {
  const f = fixture();
  const base = f.options.fetchImpl;
  try {
    const report = await runDatasetGet({
      ...f.options,
      includeLatest: false,
      resolveSessionImpl: async (request) => {
        await request.fetchImpl(`https://${PROJECT}.supabase.co/auth/v1/user`);
        return session;
      },
      fetchImpl: async (url, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        return base(url, init);
      },
    });
    assert.equal(report.status, 'completed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('each explicit content scope rejects rows that qualify only for the other scope', async () => {
  for (const [state, scope] of [
    [0, 'public'],
    [100, 'owner-draft'],
  ] as const) {
    const f = fixture(row('00.00.001', state));
    try {
      await assert.rejects(runDatasetGet({ ...f.options, scope, includeLatest: false }), {
        code: 'DATASET_GET_SCOPE_VIOLATION',
      });
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
