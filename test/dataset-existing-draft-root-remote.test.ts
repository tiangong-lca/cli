import test from 'node:test';
import assert from 'node:assert/strict';
import { observeExistingDraftRoot } from '../src/lib/dataset-existing-draft-root-remote.js';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import type { FetchLike } from '../src/lib/http.js';
import type { SupabaseDataRuntime } from '../src/lib/supabase-client.js';

const ID = '11111111-1111-1111-1111-111111111111';
const ACTOR = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';
const VERSION = '01.00.001';
const COLUMNS =
  'id,version,user_id,state_code,modified_at,json_ordered,team_id,model_id,model_version,review_id';
const runtime: SupabaseDataRuntime = {
  apiBaseUrl: 'https://root-test.supabase.co',
  publishableKey: 'public-key',
  getAccessToken: async () => 'test-access-token',
};
function row(version = VERSION, state = 0): Record<string, unknown> {
  return {
    id: ID,
    version,
    user_id: ACTOR,
    state_code: state,
    modified_at: '2026-10-21T01:00:00+00:00',
    json_ordered: {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': ID } },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': version },
        },
        exchanges: { exchange: [{ retained: 'full-payload' }] },
      },
    },
    team_id: null,
    model_id: null,
    model_version: null,
    review_id: null,
  };
}
function response(body: unknown, range: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      ...(range === null ? {} : { 'Content-Range': range }),
    },
  });
}
function observe(
  fetchImpl: FetchLike,
  overrides: Partial<Parameters<typeof observeExistingDraftRoot>[0]> = {},
) {
  return observeExistingDraftRoot({
    runtime,
    fetchImpl,
    timeoutMs: 1_000,
    id: ID,
    version: VERSION,
    actorUserId: ACTOR,
    ...overrides,
  });
}
function transport(
  overrides: {
    exact?: unknown;
    latest?: unknown;
    drafts?: unknown;
    reviews?: unknown;
    draftRange?: string | null;
    reviewRange?: string | null;
  } = {},
): FetchLike {
  return async (input) => {
    const url = new URL(input);
    if (url.searchParams.has('version')) return response(overrides.exact ?? [row()]);
    if (url.searchParams.get('state_code') === 'eq.100')
      return response(overrides.latest ?? [row('01.00.002', 100)]);
    if (url.searchParams.get('state_code') === 'eq.0')
      return response(
        overrides.drafts ?? [row()],
        overrides.draftRange === undefined ? '0-0/1' : overrides.draftRange,
      );
    return response(
      overrides.reviews ?? [],
      overrides.reviewRange === undefined ? '*/0' : overrides.reviewRange,
    );
  };
}
const invalid = { code: 'DATASET_EXISTING_DRAFT_ROOT_REMOTE_INVALID' };
const incomplete = { code: 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE' };

test('existing root observation uses four fresh authenticated GET scopes with exact count and process profile', async () => {
  const urls: URL[] = [];
  const target = row();
  const baseline = { ...row('01.00.002', 100), user_id: OTHER, team_id: OTHER, review_id: OTHER };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    urls.push(url);
    assert.equal(url.origin, 'https://root-test.supabase.co');
    assert.equal(url.pathname, '/rest/v1/processes');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-access-token');
    assert.equal(headers.get('apikey'), 'public-key');
    assert.equal(headers.get('accept-profile'), 'public');
    assert.equal(headers.get('prefer'), 'count=exact');
    assert.equal(url.searchParams.get('id'), `eq.${ID}`);
    if (url.searchParams.has('version')) return response([target]);
    if (url.searchParams.get('state_code') === 'eq.100') return response([baseline]);
    if (url.searchParams.get('state_code') === 'eq.0') return response([target], '0-0/1');
    return response([], '*/0');
  };
  const result = await observe(fetchImpl);
  assert.equal(urls.length, 4);
  assert.equal(urls[0]!.searchParams.get('select'), COLUMNS);
  assert.equal(urls[0]!.searchParams.get('version'), `eq.${VERSION}`);
  assert.equal(urls[0]!.searchParams.get('user_id'), `eq.${ACTOR}`);
  assert.equal(urls[0]!.searchParams.get('state_code'), 'eq.0');
  assert.equal(urls[0]!.searchParams.get('limit'), '2');
  assert.equal(urls[1]!.searchParams.get('order'), 'version.desc');
  assert.equal(urls[1]!.searchParams.get('limit'), '1');
  for (const url of urls.slice(2)) {
    assert.equal(url.searchParams.get('user_id'), `eq.${ACTOR}`);
    assert.equal(url.searchParams.get('order'), 'version.asc');
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(url.searchParams.get('offset'), '0');
  }
  assert.equal(urls[3]!.searchParams.get('and'), '(state_code.gte.20,state_code.lt.100)');
  assert.equal(urls[3]!.searchParams.get('select'), 'id,version,user_id,state_code,review_id');
  assert.equal(result.selected.payload_sha256, sha256Json(target.json_ordered));
  assert.equal(result.selected.row_sha256, sha256Json(target));
  assert.equal(result.published_baseline.row_sha256, sha256Json(baseline));
  assert.deepEqual(result.drafts, [result.selected]);
  assert.deepEqual(result.reviews, []);
  assert.deepEqual(result.completeness.entity_counts, { drafts: 1, reviews: 0 });
  assert.equal(result.completeness.page_count, 2);
  await observe(fetchImpl);
  assert.equal(urls.length, 8);
});

test('exact body transport excludes a selected version that becomes an owner review or foreign draft', async () => {
  const changedRows: Record<string, unknown>[] = [
    { ...row(), state_code: 20 },
    { ...row(), user_id: OTHER },
  ];
  for (const changed of changedRows) {
    const delivered: unknown[][] = [];
    const urls: URL[] = [];
    await assert.rejects(
      observe(async (input, init) => {
        const url = new URL(input);
        urls.push(url);
        assert.equal(init?.method, 'GET');
        assert.equal(init?.body, undefined);
        assert.equal(url.searchParams.get('version'), `eq.${VERSION}`);
        assert.equal(url.searchParams.get('user_id'), `eq.${ACTOR}`);
        assert.equal(url.searchParams.get('state_code'), 'eq.0');
        // Model server predicates: an ineligible body must never cross this transport.
        const allowed = [changed].filter(
          (candidate) =>
            `eq.${candidate.user_id}` === url.searchParams.get('user_id') &&
            `eq.${candidate.state_code}` === url.searchParams.get('state_code'),
        );
        delivered.push(allowed);
        return response(allowed);
      }),
      invalid,
    );
    assert.equal(urls.length, 1);
    assert.deepEqual(delivered, [[]]);
  }
});

test('row hash binds exactly ten original fields while full ordered payload changes payload hash', async () => {
  const original = row();
  const first = await observe(
    transport({ exact: [{ ...original, ignored: 'outside-projection' }] }),
  );
  const second = await observe(transport({ exact: [original] }));
  assert.equal(first.selected.row_sha256, second.selected.row_sha256);
  const changed = row();
  (changed.json_ordered as Record<string, unknown>).processDataSet = {
    ...((changed.json_ordered as Record<string, unknown>).processDataSet as Record<
      string,
      unknown
    >),
    extra: { nested: ['content'] },
  };
  const third = await observe(transport({ exact: [changed] }));
  assert.notEqual(third.selected.payload_sha256, first.selected.payload_sha256);
  assert.notEqual(third.selected.row_sha256, first.selected.row_sha256);
  const fourth = await observe(transport({ exact: [{ ...original, modified_at: null }] }));
  assert.notEqual(fourth.selected.row_sha256, first.selected.row_sha256);
  assert.equal(fourth.selected.payload_sha256, first.selected.payload_sha256);
});

test('empty censuses and actual server page lengths are recorded without inferred rows', async () => {
  const empty = await observe(transport({ drafts: [], draftRange: '*/0' }));
  assert.deepEqual(empty.completeness.entity_counts, { drafts: 0, reviews: 0 });
  const offsets: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    if (url.searchParams.has('version') || url.searchParams.get('state_code') !== 'eq.0')
      return transport()(input, init);
    const offset = url.searchParams.get('offset')!;
    offsets.push(offset);
    return response(
      [row(offset === '0' ? '01.00.001' : '01.00.002')],
      offset === '0' ? '0-0/2' : '1-1/2',
    );
  };
  const multiple = await observe(fetchImpl);
  assert.deepEqual(offsets, ['0', '1']);
  assert.equal(multiple.completeness.tables[0]!.effective_page_size, 1);
  assert.equal(multiple.drafts.length, 2);
});

test('owner review conflicts are observations with typed identities, versions and review ids', async () => {
  const reviews = [
    { id: ID, version: '01.00.003', user_id: ACTOR, state_code: 20, review_id: null },
    { id: ID, version: '01.00.004', user_id: ACTOR, state_code: 99, review_id: OTHER },
  ];
  const seenOffsets: string[] = [];
  const result = await observe(async (input, init) => {
    const url = new URL(input);
    if (!url.searchParams.has('and')) return transport()(input, init);
    const offset = Number(url.searchParams.get('offset'));
    seenOffsets.push(String(offset));
    return response([reviews[offset]], `${offset}-${offset}/2`);
  });
  assert.deepEqual(result.reviews, reviews);
  assert.deepEqual(seenOffsets, ['0', '1']);
});

test('exact and published lookups require one correctly scoped row', async () => {
  for (const exact of [
    [],
    [row(), row()],
    {},
    [null],
    [{ ...row(), id: OTHER }],
    [{ ...row(), version: '01.00.003' }],
    [{ ...row(), user_id: OTHER }],
    [{ ...row(), state_code: 100 }],
  ]) {
    await assert.rejects(observe(transport({ exact })), invalid);
  }
  for (const latest of [
    [],
    [row('01.00.002', 100), row('01.00.003', 100)],
    [row()],
    [{ ...row('01.00.002', 100), id: OTHER }],
  ]) {
    await assert.rejects(observe(transport({ latest })), invalid);
  }
});

test('snapshot rejects missing columns, malformed values, model binding and non-owner draft metadata', async () => {
  for (const key of COLUMNS.split(',')) {
    const missing = row();
    delete missing[key];
    await assert.rejects(observe(transport({ exact: [missing] })), invalid);
  }
  for (const patch of [
    { id: 'invalid' },
    { id: ID.toUpperCase().replace('11111111', 'ABCDEFAB') },
    { version: '1.0.1' },
    { user_id: 'owner' },
    { state_code: '0' },
    { modified_at: 10 },
    { modified_at: 'not-a-date' },
    { modified_at: '2026-99-99T00:00:00Z' },
    { modified_at: ' 2026-10-21T00:00:00Z' },
    { model_id: OTHER },
    { model_version: '01.00.001' },
    { team_id: OTHER },
    { review_id: OTHER },
    { team_id: 'bad' },
    { review_id: 1 },
    { json_ordered: null },
    { json_ordered: [] },
  ]) {
    await assert.rejects(observe(transport({ exact: [{ ...row(), ...patch }] })), invalid);
  }
  for (const patch of [
    { model_id: OTHER },
    { model_version: '01.00.001' },
    { team_id: 'bad' },
    { review_id: 3 },
  ]) {
    await assert.rejects(
      observe(transport({ latest: [{ ...row('01.00.002', 100), ...patch }] })),
      invalid,
    );
  }
});

test('ordered payload requires exactly one Process wrapper and matching embedded identity/version', async () => {
  const payloads = [
    {},
    { flowDataSet: {} },
    { processDataSet: {}, flowDataSet: {} },
    { processDataSet: null },
    { processDataSet: [] },
    { processDataSet: {} },
    { processDataSet: { processInformation: {} } },
    { processDataSet: { processInformation: { dataSetInformation: {} } } },
    {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': OTHER } },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': VERSION },
        },
      },
    },
    {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': ID } },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': '01.00.002' },
        },
      },
    },
    {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': 'invalid' } },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': VERSION },
        },
      },
    },
  ];
  for (const payload of payloads)
    await assert.rejects(
      observe(
        transport({ exact: [{ ...row(), json_ordered: payload, json: row().json_ordered }] }),
      ),
      invalid,
    );
});

test('census rejects foreign filter violations and malformed review fields', async () => {
  for (const patch of [{ id: OTHER }, { user_id: OTHER }, { state_code: 100 }])
    await assert.rejects(observe(transport({ drafts: [{ ...row(), ...patch }] })), invalid);
  const validReview = { id: ID, version: VERSION, user_id: ACTOR, state_code: 20, review_id: null };
  for (const patch of [
    { id: OTHER },
    { user_id: OTHER },
    { state_code: 0 },
    { state_code: 100 },
    { state_code: 20.5 },
    { state_code: '20' },
    { version: 'bad' },
    { review_id: 'bad' },
    { review_id: undefined },
  ])
    await assert.rejects(
      observe(transport({ reviews: [{ ...validReview, ...patch }], reviewRange: '0-0/1' })),
      invalid,
    );
});

test('pagination fails closed on absent, truncated, drifting, duplicate or out-of-order evidence', async () => {
  for (const draftRange of [null, '0-0/*', '0-1/1', '*/0', '0-0/0'])
    await assert.rejects(observe(transport({ draftRange })), incomplete);
  await assert.rejects(observe(transport({ reviewRange: null })), incomplete);
  await assert.rejects(
    observe(transport({ drafts: [row(), row()], draftRange: '0-1/2' })),
    incomplete,
  );
  await assert.rejects(
    observe(transport({ drafts: [row('01.00.002'), row()], draftRange: '0-1/2' })),
    incomplete,
  );
  for (const mode of ['empty', 'total-drift', 'repeat', 'range-drift']) {
    await assert.rejects(
      observe(async (input, init) => {
        const url = new URL(input);
        if (url.searchParams.has('version') || url.searchParams.get('state_code') !== 'eq.0')
          return transport()(input, init);
        if (url.searchParams.get('offset') === '0') return response([row()], '0-0/2');
        if (mode === 'empty') return response([], '*/2');
        return response(
          [row(mode === 'repeat' ? VERSION : '01.00.002')],
          mode === 'total-drift' ? '1-1/3' : mode === 'range-drift' ? '2-2/2' : '1-1/2',
        );
      }),
      incomplete,
    );
  }
});

test('HTTP, JSON, body and transport errors never expose remote response bodies or tokens', async () => {
  for (const fetchImpl of [
    async () => new Response('private-token-and-body', { status: 403 }),
    async () => new Response('private-token-and-body', { status: 200 }),
    async () => new Response('', { status: 200 }),
    async () => {
      throw new Error('private-token-and-body');
    },
    async () => {
      throw 'private-token-and-body';
    },
  ] satisfies FetchLike[]) {
    await assert.rejects(observe(fetchImpl), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { code: string }).code,
        'DATASET_EXISTING_DRAFT_ROOT_REMOTE_REQUEST_FAILED',
      );
      assert.ok(!JSON.stringify(error).includes('private-token-and-body'));
      assert.ok(!error.message.includes('private-token-and-body'));
      return true;
    });
  }
  await assert.rejects(
    observe(transport(), {
      runtime: {
        ...runtime,
        getAccessToken: async () => {
          throw new Error('private-token-and-body');
        },
      },
    }),
    { code: 'DATASET_EXISTING_DRAFT_ROOT_REMOTE_REQUEST_FAILED' },
  );
});

test('invalid requested identities or timeout stop before transport', async () => {
  for (const patch of [
    { id: 'invalid' },
    { version: '1.0.1' },
    { actorUserId: 'invalid' },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: Number.NaN },
    { timeoutMs: 4_294_967_296 },
  ]) {
    await assert.rejects(
      observe(async () => {
        assert.fail('unexpected transport');
      }, patch),
      invalid,
    );
  }
});
