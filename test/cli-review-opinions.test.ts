import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const actor = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const dataset = '00000000-0000-4000-8000-000000000003';
const target = ['--type', 'process', '--data-id', dataset, '--data-version', '01.00.000'];
const item = {
  id,
  data_id: dataset,
  data_version: '01.00.000',
  target_table: 'processes',
  submitted_revision_checksum: 'a'.repeat(64),
  state_code: 1,
  opinion_scope: 'admin',
  json: {},
};
const opinion = {
  review_id: id,
  reviewer_id: actor,
  state_code: 1,
  json: { z: 1, a: 2 },
  created_at: '2026-01-01T00:00:00Z',
  modified_at: '2026-01-01T00:00:00Z',
};
function fixture(
  rows: unknown,
  commentPages: unknown[] = [],
  totals?: (number | null)[],
  reviewCount = 1,
) {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  let page = 0;
  const run = async (args: string[]) => {
    const reply = await executeCli(['review', ...args, '--json'], {
      env: buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' }),
      dotEnvStatus: { loaded: false, count: 0, path: '/tmp/review-opinions.env' },
      fetchImpl: async (url, init) => {
        if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
        const u = new URL(url);
        calls.push({
          url: u,
          method: String(init?.method),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const isReview = u.pathname.endsWith('/qry_review_get_items');
        if (!isReview) {
          assert.equal(u.pathname, '/rest/v1/rpc/qry_review_get_comment_items');
          assert.equal(init?.method, 'GET');
        }
        const data = isReview ? rows : commentPages[page];
        if (data instanceof Response) return data;
        const count = isReview
          ? reviewCount
          : totals
            ? totals[page]
            : Array.isArray(data)
              ? data.length
              : null;
        if (!isReview) page++;
        return new Response(JSON.stringify(data), {
          headers: {
            'content-type': 'application/json',
            ...(count === null ? {} : { 'content-range': `0-0/${count}` }),
          },
        });
      },
    });
    return { exit: reply.exitCode, result: JSON.parse(reply.stdout) };
  };
  return { calls, run };
}
test('public opinions binds visible comments and stable digests to the exact review and submission', async () => {
  const f = fixture(
    [item],
    [
      [opinion, { ...opinion, state_code: 0, json: { a: 2, z: 1 } }],
      [
        { ...opinion, state_code: -3 },
        { ...opinion, state_code: -1 },
      ],
    ],
    [4, 4],
  );
  const { result, exit } = await f.run(['opinions', '--id', id]);
  assert.equal(exit, 0);
  const review = result.data.review;
  assert.equal(review.review_id, id);
  assert.equal(review.target.data_id, dataset);
  assert.equal(review.submitted_revision_checksum, item.submitted_revision_checksum);
  assert.deepEqual(
    review.comments.map((c: JsonObject) => c.state_code),
    [1, 0, -3, -1],
  );
  assert.match(review.comments[0].json_digest, /^[a-f0-9]{64}$/u);
  assert.equal(review.comments[0].json_digest, review.comments[1].json_digest);
  assert.equal(f.calls[1]!.url.searchParams.get('p_scope'), 'opinions');
  assert.equal(f.calls[2]!.url.searchParams.get('offset'), '2');
  assert.deepEqual(
    f.calls.map((c) => c.url.pathname.split('/').at(-1)),
    ['qry_review_get_items', 'qry_review_get_comment_items', 'qry_review_get_comment_items'],
  );
});
test('public target filters and continuations retain type, exact version and role', async () => {
  for (const role of ['submitter', 'reviewer', 'review-admin', undefined]) {
    const f = fixture([item], [], [], 2);
    const { result, exit } = await f.run([
      'list',
      ...target,
      '--limit',
      '1',
      ...(role ? ['--role', role] : []),
    ]);
    assert.equal(exit, 0);
    assert.ok(result.nextActions[0].command.includes('--type process'));
    if (role) assert.ok(result.nextActions[0].command.includes('--role ' + role));
    assert.equal(f.calls[0]!.url.searchParams.get('target_table'), 'eq.processes');
    const params = f.calls[0]!.body as JsonObject;
    assert.equal(params.p_data_id, dataset);
    assert.equal(params.p_data_version, '01.00.000');
    if (role === 'review-admin')
      assert.equal(f.calls[0]!.url.searchParams.get('opinion_scope'), 'eq.admin');
  }
  const second = '00000000-0000-4000-8000-000000000004';
  const f = fixture(
    [item, { ...item, id: second, submitted_revision_checksum: 'b'.repeat(64) }],
    [[], []],
    undefined,
    2,
  );
  const { result, exit } = await f.run(['opinions', ...target]);
  assert.equal(exit, 0);
  assert.deepEqual(
    result.data.items.map((r: JsonObject) => r.review_id),
    [id, second],
  );
  assert.deepEqual(
    result.data.items.map((r: JsonObject) => r.submitted_revision_checksum),
    [item.submitted_revision_checksum, 'b'.repeat(64)],
  );
});
test('member and author views retain only visible data and distinguish older missing evidence', async () => {
  const member = fixture([{ ...item, opinion_scope: 'reviewer' }], [[opinion]]);
  assert.equal(
    (await member.run(['opinions', '--id', id])).result.data.review.comments[0].reviewer_id,
    actor,
  );
  const feedback = {
    ...item,
    data_id: null,
    data_version: null,
    json: { data: { id: dataset, version: '01.00.000' }, comment: { message: 'Revise process' } },
    submitted_revision_checksum: null,
    state_code: -1,
    opinion_scope: 'returned',
  };
  const author = fixture([feedback], [[{ ...opinion, reviewer_id: null, state_code: -1 }]]);
  const { result, exit } = await author.run(['opinions', ...target]);
  assert.equal(exit, 0);
  assert.equal(author.calls[1]!.url.searchParams.get('p_scope'), 'returned');
  assert.equal(result.data.items[0].rejection_message, 'Revise process');
  assert.equal(result.data.items[0].submitted_revision_checksum, null);
  assert.equal(result.data.items[0].comments[0].reviewer_id, null);
  const empty = fixture([{ ...item, opinion_scope: 'returned' }], [[]]);
  assert.deepEqual((await empty.run(['opinions', '--id', id])).result.data.review.comments, []);
  assert.equal(
    (await fixture([], [], [], 0).run(['opinions', '--id', id])).result.outcome,
    'not_found_or_not_visible',
  );
});
test('invalid selectors fail before transport', async () => {
  const f = fixture([]);
  for (const args of [
    [],
    ['--id', 'bad'],
    ['--id', id, ...target],
    ['--id', id, '--cursor', 'x'],
    ['--id', id, '--limit', '1'],
    target.slice(0, -2),
    ['--type', 'flow', '--data-version', '01.00.000'],
    [...target.slice(0, -1), 'latest'],
    ['--type', 'unknown', ...target.slice(2)],
    ['--type', 'process', '--data-id', 'bad', ...target.slice(4)],
  ])
    assert.equal((await f.run(['opinions', ...args])).exit, 2);
  assert.equal(f.calls.length, 0);
});
test('data protocol errors cannot become empty or cross-role opinion successes', async () => {
  assert.equal(
    (await fixture([{ ...item, opinion_scope: null }]).run(['opinions', '--id', id])).exit,
    1,
  );
  for (const bad of [
    { id: 'x' },
    { id: undefined },
    { target_table: null },
    { target_table: 'unknown' },
    { data_id: 'bad' },
    { data_id: null },
    { data_version: 'latest' },
    { data_version: null },
    { state_code: null },
    { submitted_revision_checksum: 'bad' },
    { opinion_scope: undefined },
    { data_id: actor },
    { data_version: '01.00.001' },
    { target_table: 'flows' },
  ]) {
    const f = fixture([{ ...item, ...bad, json: null }]);
    assert.equal((await f.run(['opinions', ...target])).exit, 1);
  }
  for (const [review, comments, count] of [
    [item, [{}], 1],
    [item, undefined, 1],
    [item, [], null],
    [item, [], NaN],
    [item, [opinion], 0],
    [item, [], 1],
    [item, [null], 1],
    [item, [{ ...opinion, review_id: actor }], 1],
    [item, [{ ...opinion, state_code: '1' }], 1],
    [item, [{ ...opinion, json: null }], 1],
    [item, [{ ...opinion, reviewer_id: null }], 1],
    [{ ...item, opinion_scope: 'reviewer' }, [{ ...opinion, reviewer_id: dataset }], 1],
    [{ ...item, opinion_scope: 'returned' }, [opinion], 1],
    [{ ...item, opinion_scope: 'returned' }, [{ ...opinion, reviewer_id: null }], 1],
    [
      { ...item, opinion_scope: 'returned' },
      [{ ...opinion, reviewer_id: null, state_code: -1 }],
      1,
    ],
    [
      { ...item, state_code: -1, target_table: 'flows', opinion_scope: 'returned' },
      [{ ...opinion, reviewer_id: null, state_code: -1 }],
      1,
    ],
  ] as const) {
    const f = fixture([review], [comments], [count]);
    assert.equal(
      (await f.run(['opinions', '--id', id])).exit,
      1,
      JSON.stringify({ review, comments, count }),
    );
  }
});

test('an author client denied the opinion RPC receives a structured authorization error', async () => {
  const denied = new Response(
    JSON.stringify({ code: '42501', message: 'OAuth client is not authorized for this API route' }),
    { status: 403 },
  );
  const f = fixture([{ ...item, opinion_scope: 'returned' }], [denied]);
  const { exit, result } = await f.run(['opinions', '--id', id]);
  assert.equal(exit, 1);
  assert.equal(result.error.category, 'authorization');
  assert.equal(result.error.serviceCode, '42501');
});

test('a previous database contract reports the rollout dependency before reading any comments', async () => {
  const f = fixture([{ id, state_code: -1, json: {} }]);
  const { exit, result } = await f.run(['opinions', '--id', id]);
  assert.equal(exit, 1);
  assert.equal(result.error.code, 'REVIEW_OPINIONS_UNAVAILABLE');
  assert.equal(f.calls.length, 1);
});
