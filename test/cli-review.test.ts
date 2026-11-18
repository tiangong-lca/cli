import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReviewCommand } from '../src/commands/review.js';
import { reviewReader } from '../src/adapters/review-read.js';
import type { ReviewRead } from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  makeSupabaseAuthResponse,
  isSupabaseAuthTokenUrl,
} from './helpers/supabase-auth.js';
import { commandFailure } from '../src/shared/command-errors.js';
import { CommandInputError } from '../src/shared/command-result.js';
import { CliError } from '../src/shared/errors.js';

const actor = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const parsed = (value: { stdout: string }) => JSON.parse(value.stdout);
const read: ReviewRead = async () => ({
  records: [{ id, state_code: 0 }],
  total: 3,
  actor,
  environment: 'https://example.supabase.co',
});
const run = (args: string[], reader = read) => runReviewCommand([...args, '--json'], reader);
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'review-new-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
test('Review discovery describes partial reads and service requirements without side effects', async () => {
  let effects = 0;
  const noRead: ReviewRead = async () => {
    effects++;
    throw new Error('network');
  };
  for (const args of [
    [],
    ['--help'],
    ...['get', 'list', 'submit', 'resubmit', 'materials', 'comment', 'decide', 'withdraw'].map(
      (action) => [action, '--help'],
    ),
  ]) {
    const response = await run(args, noRead);
    assert.equal(response.exitCode, 0);
    assert.deepEqual(parsed(response).implementedActions, [
      'submit',
      'resubmit',
      'get',
      'list',
      'materials',
      'comment',
      'decide',
    ]);
  }
  assert.equal(effects, 0);
});
test('Review refuses unavailable effects and historical material requests before transport', async () => {
  let effects = 0;
  const noRead: ReviewRead = async () => {
    effects++;
    throw new Error('network');
  };
  assert.equal(parsed(await run(['withdraw'], noRead)).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(
    parsed(await run(['materials', '--id', id, '--round', '1'], noRead)).error.code,
    'CAPABILITY_UNSUPPORTED',
  );
  assert.equal(
    parsed(await run(['submit', '--input', 'request.json'], noRead)).error.code,
    'REVIEW_ADAPTER_REQUIRED',
  );
  assert.equal(effects, 0);
});
test('Review reads preserve records, missing package scope and bound pagination without manufacturing progress', async (t) => {
  const dir = directory(t);
  const output = path.join(dir, 'reviews.json');
  const first = await run([
    'list',
    '--role',
    'submitter',
    '--state',
    '0',
    '--limit',
    '2',
    '--output',
    output,
  ]);
  assert.equal(first.exitCode, 0);
  const value = parsed(first);
  assert.equal(value.status, 'completed');
  assert.deepEqual(value.data.items, [{ id, state_code: 0 }]);
  assert.equal(value.completeness.hasMore, true);
  assert.ok(value.completeness.notChecked.includes('historical_package'));
  assert.ok(value.nextActions[0].command.includes('--state 0'));
  const second = await run(
    [
      'list',
      '--role',
      'submitter',
      '--state',
      '0',
      '--limit',
      '2',
      '--cursor',
      value.completeness.nextCursor,
    ],
    async (query) => {
      assert.equal(query.offset, 1);
      return { records: [], total: 1, actor, environment: '' };
    },
  );
  assert.equal(parsed(second).completeness.hasMore, false);
  const unknownCount = await run(['list', '--role', 'reviewer'], async () => ({
    records: [],
    total: null,
    actor,
    environment: '',
  }));
  assert.equal(parsed(unknownCount).completeness.hasMore, null);
  const get = await run(['get', '--id', id]);
  assert.equal(parsed(get).data.review.id, id);
  const missing = await run(['get', '--id', id], async () => ({
    records: [],
    total: 0,
    actor,
    environment: '',
  }));
  assert.equal(parsed(missing).error.code, 'REVIEW_NOT_FOUND');
  const fileFailure = await run(['list', '--role', 'reviewer', '--output', output]);
  assert.equal(parsed(fileFailure).warnings[0].code, 'OUTPUT_UNAVAILABLE');
});
test('invalid Review read arguments fail before transport and unexpected errors are redacted', async () => {
  let effects = 0;
  const noRead: ReviewRead = async () => {
    effects++;
    throw new Error('Bearer secret');
  };
  for (const args of [
    ['unknown'],
    ['--oops'],
    ['get'],
    ['get', '--id', id, '--id', id],
    ['list', '--role', 'admin'],
    ['list', '--role', 'reviewer', '--limit', '101'],
    ['list', '--role', 'reviewer', '--state', 'bad'],
    ['list', '--role', 'submitter', '--cursor', 'bad'],
    ['list', '--role', 'reviewer', '--force'],
    ['list', '--id', id],
    ['get', '--input', 'x'],
  ])
    assert.equal((await run(args, noRead)).exitCode, 2, args.join(' '));
  assert.equal(effects, 0);
  const error = await run(['get', '--id', id], noRead);
  assert.equal(error.exitCode, 1);
  assert.ok(!error.stdout.includes('secret'));
});
test('Review adapter uses the existing API read capability with online actor and RLS-narrowing role filters', async () => {
  const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
  const observed: Array<{ url: URL; headers: Headers; body: unknown }> = [];
  const reader = reviewReader(env, async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
    observed.push({
      url: new URL(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify([{ id, state_code: 0 }]), {
      headers: { 'content-type': 'application/json', 'content-range': '0-0/3' },
    });
  });
  for (const selection of [
    { id, limit: 1, offset: 0 },
    { role: 'submitter' as const, state: 0, limit: 2, offset: 0 },
    { role: 'reviewer' as const, limit: 2, offset: 0 },
  ])
    assert.equal((await reader(selection)).actor, actor);
  assert.equal(observed[0]!.headers.get('content-profile'), 'api');
  assert.deepEqual((observed[0]!.body as { p_review_ids: unknown }).p_review_ids, [id]);
  assert.ok(observed[1]!.url.searchParams.get('json->user->>id')?.includes(actor));
  assert.equal(observed[2]!.url.searchParams.get('reviewer_id'), `cs.${JSON.stringify([actor])}`);
  for (const body of [{}, [{ id: 'different' }], [{}]]) {
    const bad = reviewReader(env, async (url) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse({ userId: actor })
        : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    await assert.rejects(bad({ id, limit: 1, offset: 0 }), /Review read/);
  }
});
test('Review distinguishes expired credentials, generic route errors, invalid bodies and network failure', async () => {
  const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
  const routeMessage = 'OAuth client is not authorized for this API route';
  for (const [status, body, code, category, message] of [
    [403, { code: '42501', message: routeMessage }, '42501', 'authorization', routeMessage],
    [
      401,
      { code: 'PGRST301', message: 'JWT expired' },
      'PGRST301',
      'authentication',
      'JWT expired',
    ],
    [403, { code: '42501' }, '42501', 'service', 'Review read failed at the service.'],
    [
      500,
      { code: 'XX000', message: 'hidden-secret' },
      'XX000',
      'service',
      'Review read failed at the service.',
    ],
    [502, 'hidden-secret', undefined, 'service', 'Review read failed at the service.'],
    [0, undefined, undefined, 'service', 'Review read failed before receiving an HTTP response.'],
  ] as const) {
    const reader = reviewReader(env, async (url) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
      if (!status) throw new Error('hidden-secret');
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    });
    const reply = await run(['get', '--id', id], reader);
    assert.equal(reply.exitCode, 1);
    assert.deepEqual(parsed(reply).error, {
      code: 'REVIEW_READ_FAILED',
      category,
      message,
      ...(status ? { httpStatus: status } : {}),
      ...(code ? { serviceCode: code } : {}),
    });
    assert.doesNotMatch(reply.stdout, /hidden-secret/u);
  }
  const denied = reviewReader(env, async (url) =>
    isSupabaseAuthTokenUrl(url)
      ? makeSupabaseAuthResponse({ userId: actor })
      : new Response(JSON.stringify({ code: '42501', message: routeMessage }), { status: 403 }),
  );
  const human = await runReviewCommand(['list', '--role', 'submitter'], denied);
  assert.match(human.stdout, /HTTP 403 \(42501\)/u);
  assert.equal(human.stdout.split(routeMessage).length, 2);
});
test('shared errors distinguish input, conflict, authentication, precondition and service without raw secrets', () => {
  for (const [error, category, exit] of [
    [new CommandInputError('VALUE_REQUIRED', 'id required'), 'input', 2],
    [new CommandInputError('CONTENT_CONFLICT', 'stale'), 'conflict', 1],
    [new CommandInputError('CAPABILITY_UNSUPPORTED', 'unavailable'), 'capability_unsupported', 2],
    [new CommandInputError('VALIDATION_REQUIRED', 'invalid content'), 'precondition', 1],
    [new CliError('Bearer secret', { code: 'AUTH_REQUIRED', exitCode: 1 }), 'authentication', 1],
    [new CliError('secret', { code: 'REMOTE_REQUEST_FAILED', exitCode: 1 }), 'service', 1],
    [new Error('secret'), 'service', 1],
  ] as const) {
    const result = commandFailure(error, 'FAILED');
    assert.equal(result.category, category);
    assert.equal(result.exitCode, exit);
    assert.ok(!result.message.includes('secret'));
  }
});
