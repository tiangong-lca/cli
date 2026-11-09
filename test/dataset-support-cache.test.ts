import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync } from 'node:fs';
import { runDatasetSupportCacheExport } from '../src/lib/dataset-support-cache.js';
import type { FetchLike } from '../src/lib/http.js';
import type { ResolvedSupabaseUserSession } from '../src/lib/supabase-session.js';

const PROJECT = 'exampleprojectref';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-04T08:00:00.000Z');
const env = {
  TIANGONG_LCA_AUTH_MODE: 'oauth',
  TIANGONG_LCA_API_BASE_URL: `https://${PROJECT}.supabase.co/functions/v1`,
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
  TIANGONG_LCA_OAUTH_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  TIANGONG_LCA_SESSION_FILE: path.join(tmpdir(), 'fixture-support-session.json'),
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
const row = (id: string, text = 'value') => ({
  id,
  version: '00.00.001',
  state_code: 100,
  json: { name: text },
});

function fixture(rows = [row('a'), row('b')]) {
  const root = mkdtempSync(path.join(tmpdir(), 'support-export-'));
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: input, method: init?.method });
    if (url.pathname === '/auth/v1/user')
      return new Response(JSON.stringify({ id: USER, email: session.userEmail }), {
        headers: { 'content-type': 'application/json' },
      });
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Prefer'), 'count=exact');
    assert.equal(new Headers(init?.headers).get('Accept-Profile'), 'public');
    const selected = url.pathname.endsWith('unitgroups') ? [] : rows;
    const offset = Number(url.searchParams.get('offset'));
    const page = selected.slice(offset, offset + 1); // server caps below requested size
    const range = page.length ? `${offset}-${offset}/${selected.length}` : '*/0';
    return new Response(JSON.stringify(page), { headers: { 'content-range': range } });
  };
  return {
    root,
    calls,
    options: {
      outDir: path.join(root, 'result'),
      env,
      fetchImpl,
      now: NOW,
      cliVersion: '0.1.8',
      expectedProjectRef: PROJECT,
      expectedUserId: USER,
      resolveSessionImpl: async () => session,
    },
  };
}

test('support export follows capped pages twice and publishes private evidence only after stable reads', async () => {
  const f = fixture();
  try {
    const report = await runDatasetSupportCacheExport(f.options);
    assert.equal(report.status, 'completed');
    assert.equal(report.remote_write_mode, 'read-only');
    assert.equal(report.snapshot.transactional_snapshot, false);
    assert.equal(report.snapshot.status, 'observed-stable');
    assert.equal(report.tables.flowproperties.rows, 2);
    assert.equal(report.tables.unitgroups.rows, 0);
    assert.equal(
      readFileSync(report.artifacts.flowproperties, 'utf8'),
      [row('a'), row('b')].map((x) => JSON.stringify(x) + '\n').join(''),
    );
    assert.equal(readFileSync(report.artifacts.unitgroups, 'utf8'), '');
    assert.equal(JSON.stringify(report).includes(session.accessToken), false);
    assert.equal(f.calls.filter((c) => c.url.includes('/flowproperties')).length, 4);
    if (process.platform !== 'win32') {
      assert.equal(statSync(f.options.outDir).mode & 0o777, 0o700);
      assert.equal(statSync(report.artifacts.report).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('wrong intent and non-OAuth sessions fail before support data requests', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({ ...f.options, expectedProjectRef: 'wrongproject' }),
    );
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        expectedUserId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        env: {
          ...env,
          TIANGONG_LCA_AUTH_MODE: 'access-token',
          TIANGONG_LCA_ACCESS_TOKEN: 'explicit-token',
        },
      }),
    );
    assert.equal(
      f.calls.some((c) => c.url.includes('/rest/v1/')),
      false,
    );
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('changed row payloads, partial responses and existing outputs cannot produce a completed export', async () => {
  const f = fixture([row('a')]);
  let calls = 0;
  const base = f.options.fetchImpl;
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        fetchImpl: async (input, init) => {
          if (input.includes('/flowproperties') && ++calls > 1)
            return new Response(JSON.stringify([row('a', 'changed')]), {
              headers: { 'content-range': '0-0/1' },
            });
          return base(input, init);
        },
      }),
      /changed between observations/u,
    );
    assert.equal(existsSync(f.options.outDir), false);
    writeFileSync(f.options.outDir, 'preserve');
    await assert.rejects(runDatasetSupportCacheExport(f.options), /already exists/u);
    assert.equal(readFileSync(f.options.outDir, 'utf8'), 'preserve');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function rejectDataResponse(
  makeResponse: () => Promise<Awaited<ReturnType<FetchLike>>> | Awaited<ReturnType<FetchLike>>,
  expectedCode: string,
) {
  const f = fixture();
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        fetchImpl: (input, init) =>
          input.includes('/auth/v1/user')
            ? f.options.fetchImpl(input, init)
            : Promise.resolve().then(makeResponse),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error);
        assert.equal(error.code, expectedCode);
        assert.equal(JSON.stringify(error).includes('PRIVATE_CANARY'), false);
        return true;
      },
    );
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test('invalid options fail before authentication or directory reservation', async () => {
  const f = fixture();
  try {
    for (const changes of [
      { outDir: '' },
      { pageSize: 0 },
      { pageSize: 5001 },
      { pageSize: 1.5 },
      { timeoutMs: 0 },
      { timeoutMs: 120001 },
      { stateCodes: [] },
      { stateCodes: [Number.NaN] },
      { stateCodes: [2147483648] },
    ]) {
      await assert.rejects(runDatasetSupportCacheExport({ ...f.options, ...changes }));
    }
    assert.equal(f.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('export normalizes explicit filters and supports a JSON-only response adapter', async () => {
  const f = fixture([]);
  try {
    const base = f.options.fetchImpl;
    const report = await runDatasetSupportCacheExport({
      ...f.options,
      stateCodes: [100, 0, 100],
      pageSize: 2,
      timeoutMs: 100,
      fetchImpl: async (input, init) => {
        const response = await base(input, init);
        if (input.includes('/auth/v1/user')) return response;
        return { ok: true, status: 200, headers: response.headers, text: async () => '[]' };
      },
    });
    assert.deepEqual(report.filters.state_codes, [0, 100]);
    assert.equal(
      f.calls
        .filter((call) => call.url.includes('/rest/v1/'))
        .every((call) => new URL(call.url).searchParams.get('state_code') === 'in.(0,100)'),
      true,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('malformed rows and responses cannot publish or leak upstream content', async () => {
  for (const body of [
    null,
    {},
    [null],
    [[]],
    [{ ...row('a'), id: 1 }],
    [row(' ')],
    [{ ...row('a'), version: 0 }],
    [{ ...row('a'), version: '' }],
    [{ ...row('a'), state_code: 1.5 }],
    [{ ...row('a'), json: null }],
    [{ ...row('a'), json: [] }],
  ]) {
    await rejectDataResponse(
      () => new Response(JSON.stringify(body), { headers: { 'content-range': '0-0/1' } }),
      'DATASET_SUPPORT_CACHE_ROWS_INVALID',
    );
  }
  await rejectDataResponse(
    () =>
      new Response(JSON.stringify([{ ...row('a'), state_code: 0 }]), {
        headers: { 'content-range': '0-0/1' },
      }),
    'DATASET_SUPPORT_CACHE_STATE_FENCE_VIOLATION',
  );
  await rejectDataResponse(
    () => new Response('PRIVATE_CANARY', { status: 500 }),
    'DATASET_SUPPORT_CACHE_READ_FAILED',
  );
  await rejectDataResponse(() => {
    throw new Error('PRIVATE_CANARY');
  }, 'DATASET_SUPPORT_CACHE_READ_FAILED');
  await rejectDataResponse(
    () => new Response('PRIVATE_CANARY', { headers: { 'content-range': '*/0' } }),
    'DATASET_SUPPORT_CACHE_INVALID_JSON',
  );
  await rejectDataResponse(
    () => new Response('[]', { headers: { 'content-range': 'PRIVATE_CANARY' } }),
    'DATASET_SUPPORT_CACHE_SNAPSHOT_INCOMPLETE',
  );
  await rejectDataResponse(
    () =>
      new Response(JSON.stringify([row('PRIVATE_CANARY'), row('PRIVATE_CANARY')]), {
        headers: { 'content-range': '0-1/2' },
      }),
    'DATASET_SUPPORT_CACHE_SNAPSHOT_INCOMPLETE',
  );
  await rejectDataResponse(
    () =>
      new Response(JSON.stringify([row('b'), row('a')]), { headers: { 'content-range': '0-1/2' } }),
    'DATASET_SUPPORT_CACHE_SNAPSHOT_INCOMPLETE',
  );
});

test('row, byte and elapsed-time limits prevent completion', async () => {
  await rejectDataResponse(
    () => new Response('[]', { headers: { 'content-range': '*/100001' } }),
    'DATASET_SUPPORT_CACHE_ROW_LIMIT',
  );
  await rejectDataResponse(
    () => new Response('[]', { headers: { 'content-range': '*/0', 'content-length': '8388609' } }),
    'DATASET_SUPPORT_CACHE_BYTE_LIMIT',
  );
  await rejectDataResponse(
    () =>
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'content-range': '*/0' } }),
    'DATASET_SUPPORT_CACHE_BYTE_LIMIT',
  );
  await rejectDataResponse(
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-range': '*/0' }),
      text: async () => ' '.repeat(8 * 1024 * 1024 + 1),
    }),
    'DATASET_SUPPORT_CACHE_BYTE_LIMIT',
  );
  const f = fixture();
  let tick = 0;
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        monotonicNow: () => (tick++ === 0 ? 0 : 120000),
      }),
      /operation deadline/u,
    );
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a missing real session is rejected without borrowing the operator session', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        env: { ...env, TIANGONG_LCA_SESSION_FILE: path.join(f.root, 'absent-session.json') },
        resolveSessionImpl: undefined,
      }),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('pagination and total-byte caps stop a pathological but structurally valid service', async () => {
  for (const mode of ['pages', 'bytes']) {
    const f = fixture();
    const text = mode === 'bytes' ? 'x'.repeat(6 * 1024 * 1024) : 'small';
    let requests = 0;
    try {
      await assert.rejects(
        runDatasetSupportCacheExport({
          ...f.options,
          fetchImpl: async (input, init) => {
            if (input.includes('/auth/v1/user')) return f.options.fetchImpl(input, init);
            const offset = Number(new URL(input).searchParams.get('offset'));
            requests += 1;
            const total = mode === 'pages' ? 1001 : 20;
            return new Response(JSON.stringify([row(String(offset).padStart(5, '0'), text)]), {
              headers: { 'content-range': `${offset}-${offset}/${total}` },
            });
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error && 'code' in error);
          assert.equal(
            error.code,
            mode === 'pages'
              ? 'DATASET_SUPPORT_CACHE_PAGE_LIMIT'
              : 'DATASET_SUPPORT_CACHE_BYTE_LIMIT',
          );
          return true;
        },
      );
      assert.equal(requests, mode === 'pages' ? 1000 : 11);
      assert.equal(existsSync(f.options.outDir), false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('expiry after the last observation still prevents publication', async () => {
  const f = fixture([]);
  let ticks = 0;
  try {
    await assert.rejects(
      runDatasetSupportCacheExport({
        ...f.options,
        monotonicNow: () => (++ticks <= 5 ? 0 : 120000),
      }),
      /operation deadline/u,
    );
    assert.equal(existsSync(f.options.outDir), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('output reservation races preserve the winning writer and publication failure removes only owned output', async () => {
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  for (const mode of ['race', 'reserve-error', 'publish-error']) {
    const f = fixture([]);
    let dataCalls = 0;
    const originalMkdir = mutableFs.mkdirSync;
    const originalRename = mutableFs.renameSync;
    try {
      if (mode === 'reserve-error')
        mutableFs.mkdirSync = (() => {
          throw Object.assign(new Error('PRIVATE_CANARY'), { code: 'EACCES' });
        }) as typeof mutableFs.mkdirSync;
      if (mode === 'publish-error')
        mutableFs.renameSync = () => {
          throw new Error('PRIVATE_CANARY');
        };
      syncBuiltinESMExports();
      await assert.rejects(
        runDatasetSupportCacheExport({
          ...f.options,
          fetchImpl: async (input, init) => {
            const response = await f.options.fetchImpl(input, init);
            if (!input.includes('/auth/v1/user') && ++dataCalls === 4 && mode === 'race') {
              mkdirSync(f.options.outDir);
              writeFileSync(path.join(f.options.outDir, 'keep'), 'winning writer');
            }
            return response;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error && 'code' in error);
          assert.equal(
            error.code,
            mode === 'race'
              ? 'DATASET_SUPPORT_CACHE_OUTPUT_EXISTS'
              : 'DATASET_SUPPORT_CACHE_ARTIFACT_WRITE_FAILED',
          );
          assert.equal(JSON.stringify(error).includes('PRIVATE_CANARY'), false);
          return true;
        },
      );
      if (mode === 'race')
        assert.equal(readFileSync(path.join(f.options.outDir, 'keep'), 'utf8'), 'winning writer');
      else assert.equal(existsSync(f.options.outDir), false);
    } finally {
      mutableFs.mkdirSync = originalMkdir;
      mutableFs.renameSync = originalRename;
      syncBuiltinESMExports();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
