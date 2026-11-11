import type { ReviewMutationAction } from '../src/application/review-write.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reviewWriter } from '../src/adapters/review-write.js';
import { reviewMaterials } from '../src/adapters/review-materials.js';
import { runReviewCommand } from '../src/commands/review.js';
import { result } from '../src/shared/command-result.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  makeSupabaseAuthResponse,
  isSupabaseAuthTokenUrl,
} from './helpers/supabase-auth.js';

const actor = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const version = '00.00.001';
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
const content = { contactDataSet: {} };
const base = {
  requestId: 'r1',
  expectedActor: actor,
  expectedEnvironment: 'https://example.supabase.co',
};
const submit = { ...base, targets: [{ type: 'contact', id, version }] };
function setup(
  t: TestContext,
  options: {
    payload?: unknown;
    httpStatus?: number;
    transportFailure?: boolean;
    breakJournal?: boolean;
    state?: number;
    noTarget?: boolean;
    targetType?: string;
    targetVersion?: string;
    reviewMissing?: boolean;
  } = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'review-write-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: Array<{ url: string; body: JsonObject }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
    if (url.includes('/functions/v1/')) {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (options.transportFailure) throw new Error('Bearer hidden-secret');
      if (options.breakJournal) {
        const journal = path.join(
          directory,
          readdirSync(directory).find((file) => file.endsWith('.json'))!,
        );
        rmSync(journal);
        mkdirSync(journal);
      }
      return new Response(
        JSON.stringify(
          options.payload === undefined
            ? url.endsWith('/app_review_batch_decision')
              ? { ok: true, results: [{ reviewId, ok: true }] }
              : { ok: true, data: { reviewId } }
            : options.payload,
        ),
        { status: options.httpStatus ?? 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const rows = url.includes('/rpc/')
      ? options.reviewMissing
        ? []
        : [
            {
              id: reviewId,
              state_code: options.state ?? 1,
              json: {
                data: {
                  table: options.targetType ?? 'contacts',
                  id,
                  version: options.targetVersion ?? version,
                },
              },
            },
          ]
      : options.noTarget
        ? []
        : [{ id, version, state_code: 0, user_id: actor, json: content }];
    return new Response(JSON.stringify(rows), {
      headers: { 'content-type': 'application/json', 'content-range': `0-0/${rows.length}` },
    });
  };
  return { directory, calls, fetchImpl, writer: reviewWriter(env, fetchImpl, directory) };
}

test('existing submission binds actor, defaults related data and journals one accepted application', async (t) => {
  const fixture = setup(t);
  const preview = await fixture.writer('submit', submit, true);
  assert.equal(preview.outcome, 'preview_completed');
  assert.deepEqual(preview.context.defaultedInputs, { includeRelated: true });
  assert.ok((preview.completeness.notChecked as string[]).includes('server_related_scope'));
  assert.deepEqual(readdirSync(fixture.directory), []);
  assert.equal(fixture.calls.length, 0);
  const responses = await Promise.all([
    fixture.writer('submit', submit, false),
    fixture.writer('submit', submit, false),
  ]);
  assert.equal(fixture.calls.length, 1);
  assert.equal(responses[0]!.status, 'accepted');
  assert.equal(responses[1]!.outcome, 'original_result_returned');
  assert.deepEqual(fixture.calls[0]!.body, { table: 'contacts', id, version });
  const input = path.join(fixture.directory, 'request.json');
  writeFileSync(input, JSON.stringify(submit));
  const presented = await runReviewCommand(
    ['submit', '--input', input, '--json'],
    async () => {
      throw new Error('unexpected read');
    },
    {
      mutate: fixture.writer,
      materials: async () => {
        throw new Error('unexpected material read');
      },
    },
  );
  assert.ok(JSON.parse(presented.stdout).nextActions[0].command.includes(reviewId));
  assert.equal(fixture.calls.length, 1);
  rmSync(input);
  await assert.rejects(
    fixture.writer('submit', { ...submit, includeRelated: true }, false),
    /already bound/,
  );
  if (process.platform !== 'win32') {
    chmodSync(
      path.join(
        fixture.directory,
        readdirSync(fixture.directory).find((file) => file.endsWith('.json'))!,
      ),
      0o644,
    );
    await assert.rejects(fixture.writer('submit', submit, false), /private regular/);
  }
});

test('resubmit records the rejected predecessor without claiming a backend round link', async (t) => {
  const fixture = setup(t, { state: -1 });
  const request = { ...submit, reviewId, expectedState: -1, changeSummary: 'Corrected source' };
  const response = await fixture.writer('resubmit', request, false);
  assert.equal(response.status, 'accepted');
  assert.equal(
    (response.data.previousReview as JsonObject).association,
    'caller_observed_not_server_round_link',
  );
  assert.deepEqual(fixture.calls[0]!.body, { table: 'contacts', id, version });
  const mismatch = setup(t, { state: -1, targetVersion: '00.00.002' });
  await assert.rejects(mismatch.writer('resubmit', request, false), /identify the rejected/);
  assert.equal(mismatch.calls.length, 0);
});

test('review draft and reviewer decision use separate existing endpoints and do not infer whole-review approval', async (t) => {
  const fixture = setup(t);
  assert.equal(
    (
      await fixture.writer(
        'comment',
        { ...base, requestId: 'preview', reviewId, expectedState: 1, json: {} },
        true,
      )
    ).outcome,
    'preview_completed',
  );
  const draft = await fixture.writer(
    'comment',
    { ...base, reviewId, expectedState: 1, json: { comment: { message: 'Evidence assessed' } } },
    false,
  );
  assert.equal(draft.outcome, 'review_draft_saved');
  assert.ok(fixture.calls[0]!.url.endsWith('/app_review_save_comment_draft'));
  for (const decision of ['approve', 'reject']) {
    const response = await fixture.writer(
      'decide',
      {
        ...base,
        requestId: decision,
        reviewId,
        expectedState: 1,
        decision,
        ...(decision === 'reject' ? { reason: 'Evidence missing' } : {}),
      },
      false,
    );
    assert.equal(response.outcome, 'reviewer_decision_recorded');
    assert.match(response.summary, /not a claim of overall/);
    assert.ok(fixture.calls.at(-1)!.url.endsWith('/app_review_batch_decision'));
    assert.deepEqual(fixture.calls.at(-1)!.body.reviewIds, [reviewId]);
  }
});

test('definitive rejection is retained and ambiguous outcomes never replay', async (t) => {
  for (const options of [
    { transportFailure: true },
    { payload: null },
    {
      payload: {
        ok: false,
        code: 'Bearer hidden-secret',
        results: [
          { reviewId, ok: false, code: 'REVIEW_DRAFT_REQUIRED', message: 'hidden-secret' },
          { reviewId, ok: false, code: 'Bearer hidden-secret' },
          null,
        ],
      },
      httpStatus: 409,
    },
    { payload: { ok: false, code: 'VERSION_CONFLICT' }, httpStatus: 500 },
    { payload: { ok: true }, httpStatus: 500 },
    { payload: { ok: true, data: {} } },
    { payload: { ok: true, data: { reviewId: 'bad identity' } } },
  ]) {
    const fixture = setup(t, options);
    assert.equal((await fixture.writer('submit', submit, false)).status, 'unknown');
    assert.equal((await fixture.writer('submit', submit, false)).status, 'unknown');
    assert.equal(fixture.calls.length, 1);
  }
  for (const payload of [
    { ok: false, code: 'DATA_UNDER_REVIEW', message: 'Bearer hidden-secret' },
  ]) {
    const fixture = setup(t, { payload, httpStatus: 409 });
    const response = await fixture.writer('submit', submit, false);
    assert.equal(response.status, 'failed');
    assert.ok(!JSON.stringify(response).includes('hidden-secret'));
    assert.equal((await fixture.writer('submit', submit, false)).status, 'failed');
    assert.equal(fixture.calls.length, 1);
  }
});

test('unsupported new semantics and stale bindings reject before any domain mutation', async (t) => {
  const fixture = setup(t);
  for (const changed of [
    { includeRelated: false },
    { includeRelated: 'yes' },
    { targets: [] },
    { targets: [...submit.targets, ...submit.targets] },
    { package: {} },
    { targets: [{ ...submit.targets[0], revision: 'r1' }] },
    { targets: [{ type: 'unitgroup', id, version }] },
    { targets: [{ type: 'contact', id: 'bad', version }] },
    { targets: [{ type: 'contact', id, version: 'latest' }] },
    { expectedActor: 'other' },
    { expectedEnvironment: 'https://wrong.test' },
  ])
    await assert.rejects(fixture.writer('submit', { ...submit, ...changed }, false));
  for (const request of [
    { reviewId },
    { reviewId, expectedState: 1, decision: 'other' },
    { reviewId, expectedState: 1, decision: 'approve', reason: 'bad' },
    { reviewId, expectedState: 1, decision: 'reject' },
    { reviewId, expectedState: 1, decision: 'reject', reason: 'a'.repeat(1001) },
  ])
    await assert.rejects(fixture.writer('decide', { ...base, ...request }, false));
  await assert.rejects(
    fixture.writer(
      'resubmit',
      { ...submit, reviewId, expectedState: 1, changeSummary: 'change' },
      false,
    ),
  );
  await assert.rejects(
    fixture.writer('withdraw' as ReviewMutationAction, { ...base, reviewId }, false),
  );
  await assert.rejects(fixture.writer('comment', { ...base, reviewId, expectedState: 1 }, false));
  for (const options of [{ noTarget: true }, { reviewMissing: true }]) {
    const missing = setup(t, options);
    await assert.rejects(
      missing.writer(
        options.noTarget ? 'submit' : 'decide',
        options.noTarget ? submit : { ...base, reviewId, expectedState: 1, decision: 'approve' },
        false,
      ),
    );
    assert.equal(missing.calls.length, 0);
  }
  await assert.rejects(
    fixture.writer('decide', { ...base, reviewId, expectedState: 0, decision: 'approve' }, false),
    /changed state/,
  );
  assert.equal(fixture.calls.length, 0);
});

test('materials read the current exact target without inventing a historical snapshot', async (t) => {
  const fixture = setup(t);
  const materials = await reviewMaterials(env, fixture.fetchImpl)(reviewId);
  assert.deepEqual(materials.subject, { type: 'contact', id, version });
  assert.deepEqual(materials.currentContent, content);
  assert.equal(materials.historicalSnapshot, false);
  for (const options of [
    { reviewMissing: true },
    { targetType: 'unknown' },
    { targetVersion: 'latest' },
    { noTarget: true },
  ]) {
    const failed = setup(t, options);
    await assert.rejects(reviewMaterials(env, failed.fetchImpl)(reviewId));
  }
});

test('Review command renders actual effects, preview, failures and output errors without repeating effects', async (t) => {
  const fixture = setup(t);
  const input = path.join(fixture.directory, 'request.json');
  const output = path.join(fixture.directory, 'materials.json');
  writeFileSync(input, JSON.stringify(submit));
  const operations = { mutate: fixture.writer, materials: reviewMaterials(env, fixture.fetchImpl) };
  const read = async () => ({ records: [], total: 0, actor, environment: '' });
  const invoke = (args: string[]) => runReviewCommand([...args, '--json'], read, operations);
  assert.equal(
    JSON.parse((await invoke(['submit', '--input', input, '--dry-run'])).stdout).outcome,
    'preview_completed',
  );
  const accepted = JSON.parse(
    (await invoke(['submit', '--input', input, '--output', output])).stdout,
  );
  assert.equal(accepted.status, 'accepted');
  const duplicate = JSON.parse(
    (await invoke(['submit', '--input', input, '--output', output])).stdout,
  );
  assert.equal(duplicate.status, 'partial');
  assert.equal(fixture.calls.length, 1);
  const material = await invoke(['materials', '--id', reviewId, '--output', output, '--force']);
  assert.equal(material.exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).currentContent, content);
  assert.equal((await invoke(['materials', '--id', reviewId])).exitCode, 0);
  for (const status of ['completed', 'failed', 'unknown', 'partial'] as const) {
    const value = result('review decide');
    value.status = status;
    const response = await runReviewCommand(['decide', '--input', input, '--json'], read, {
      ...operations,
      mutate: async () => value,
    });
    assert.equal(response.exitCode, status === 'completed' ? 0 : 1);
  }
});

test('a decision receipt must acknowledge exactly the requested review and result', async (t) => {
  for (const payload of [
    { ok: true },
    { ok: true, results: [] },
    { ok: true, results: [null] },
    { ok: true, results: [{ reviewId: id, ok: true }] },
    { ok: true, results: [{ reviewId, ok: false }] },
  ]) {
    const fixture = setup(t, { payload });
    const request = { ...base, reviewId, expectedState: 1, decision: 'approve' };
    assert.equal((await fixture.writer('decide', request, false)).status, 'unknown');
    assert.equal((await fixture.writer('decide', request, false)).status, 'unknown');
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = setup(t, {
    payload: { ok: false, results: [{ reviewId, ok: false, code: 'REVIEW_DRAFT_REQUIRED' }] },
  });
  assert.equal(
    (
      await fixture.writer(
        'decide',
        { ...base, reviewId, expectedState: 1, decision: 'approve' },
        false,
      )
    ).status,
    'failed',
  );
});

test('HTTP Review refusal codes survive every supported mutation without exposing service text', async (t) => {
  for (const action of ['submit', 'resubmit', 'comment', 'decide'] as const) {
    for (const [httpStatus, code, category] of [
      [403, 'FORBIDDEN', 'authentication'],
      [409, 'VERSION_CONFLICT', 'conflict'],
      [400, 'INVALID_PAYLOAD', 'input'],
    ] as const) {
      const f = setup(t, {
        httpStatus,
        payload: { ok: false, code, message: 'Bearer hidden-secret' },
        ...(action === 'resubmit' ? { state: -1 } : {}),
      });
      const request =
        action === 'submit'
          ? submit
          : action === 'resubmit'
            ? { ...submit, reviewId, expectedState: -1, changeSummary: 'fixed' }
            : {
                ...base,
                reviewId,
                expectedState: 1,
                ...(action === 'comment' ? { json: {} } : { decision: 'approve' }),
              };
      const first = await f.writer(action, request, false);
      assert.equal(first.status, 'failed');
      assert.equal(first.error?.code, code);
      assert.equal(first.error?.category, category);
      assert.ok(!JSON.stringify(first).includes('hidden-secret'));
      const second = await f.writer(action, request, false);
      assert.equal(second.outcome, 'service_rejected');
      assert.deepEqual(second.error, first.error);
      assert.equal(f.calls.length, 1);
    }
  }
});

test('Review preserves documented endpoint refusals and recovers them without dispatch', async (t) => {
  for (const [action, code, status, category] of [
    ['submit', 'INVALID_DATASET_TABLE', 400, 'input'],
    ['submit', 'ROOT_DATASET_NOT_OWNED', 403, 'authentication'],
    ['resubmit', 'APPROVED_DATASET_IMMUTABLE', 409, 'conflict'],
    ['comment', 'REVIEWER_REQUIRED', 403, 'authentication'],
    ['comment', 'INVALID_COMMENT_JSON', 400, 'input'],
    ['comment', 'INVALID_REVIEW_STATE', 409, 'conflict'],
    ['comment', 'INVALID_COMMENT_STATE', 409, 'conflict'],
    ['decide', 'REVIEWER_REQUIRED', 403, 'authentication'],
    ['decide', 'REVIEW_COMMENT_NOT_PENDING', 409, 'conflict'],
  ] as const) {
    const refusal = { ok: false, code, message: 'Bearer hidden-secret' };
    const f = setup(t, {
      httpStatus: action === 'decide' ? 200 : status,
      payload:
        action === 'decide' ? { ok: false, results: [{ ...refusal, reviewId, status }] } : refusal,
      ...(action === 'resubmit' ? { state: -1 } : {}),
    });
    const request =
      action === 'submit'
        ? submit
        : action === 'resubmit'
          ? { ...submit, reviewId, expectedState: -1, changeSummary: 'fixed' }
          : {
              ...base,
              reviewId,
              expectedState: 1,
              ...(action === 'comment' ? { json: {} } : { decision: 'approve' }),
            };
    const first = await f.writer(action, request, false);
    assert.equal(first.outcome, 'service_rejected', code);
    assert.equal(first.error?.code, code);
    assert.equal(first.error?.category, category);
    assert.ok(!JSON.stringify(first).includes('hidden-secret'));
    assert.deepEqual((await f.writer(action, request, false)).error, first.error);
    assert.equal(f.calls.length, 1);
  }
});

test('Review does not infer refusal from codes outside their service path or status', async (t) => {
  for (const [httpStatus, code, status] of [
    [403, 'REVIEWER_REQUIRED', undefined],
    [403, 'REFERENCE_ACCESS_DENIED', undefined],
    [409, 'REFERENCE_OWNER_UNRESOLVED', undefined],
    [409, 'ROOT_DATASET_NOT_OWNED', undefined],
    [409, 'ROOT_DATASET_NOT_OWNED', 403],
  ] as const) {
    const f = setup(t, { httpStatus, payload: { ok: false, code, status } });
    assert.equal((await f.writer('submit', submit, false)).status, 'unknown', code);
    assert.equal((await f.writer('submit', submit, false)).status, 'unknown', code);
    assert.equal(f.calls.length, 1);
  }
});

test('missing Review and target materials use the same absence category and runtime exit code', async (t) => {
  for (const options of [{ reviewMissing: true }, { noTarget: true }]) {
    const f = setup(t, options);
    const reply = await runReviewCommand(
      ['materials', '--id', reviewId, '--json'],
      async () => ({ records: [], total: 0, environment: 'test', actor }),
      { mutate: f.writer, materials: reviewMaterials(env, f.fetchImpl) },
    );
    assert.equal(reply.exitCode, 1);
    assert.equal(JSON.parse(reply.stdout).error.category, 'not_found_or_not_visible');
  }
});

test('Review journal update failure preserves observed refusal but not an unrecorded success', async (t) => {
  for (const rejected of [true, false]) {
    const f = setup(t, {
      breakJournal: true,
      ...(rejected ? { payload: { ok: false, code: 'FORBIDDEN' }, httpStatus: 403 } : {}),
    });
    const response = await f.writer('submit', submit, false);
    assert.equal(response.outcome, rejected ? 'service_rejected' : 'write_outcome_unknown');
    if (rejected)
      assert.ok(response.warnings.some((warning) => warning.code === 'JOURNAL_UPDATE_UNAVAILABLE'));
    await assert.rejects(f.writer('submit', submit, false), /private regular/u);
    assert.equal(f.calls.length, 1);
  }
});
