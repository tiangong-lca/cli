import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { qualifyDatasetWrite } from '../src/adapters/dataset-write-checks.js';
import { makeFlow } from './helpers/flow-content.js';
import { datasetValidation } from '../src/adapters/dataset-local.js';
import { contentDigest } from '../src/application/dataset-content.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import {
  makeSupabaseAuthResponse,
  isSupabaseAuthTokenUrl,
  buildSupabaseTestEnv,
} from './helpers/supabase-auth.js';

const id = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const version = '00.00.001';
const content = {
  contactDataSet: {
    contactInformation: { dataSetInformation: { 'common:UUID': id, 'common:name': 'New' } },
    administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
  },
};
const before = {
  ...content,
  contactDataSet: {
    ...content.contactDataSet,
    contactInformation: { dataSetInformation: { 'common:UUID': id, 'common:name': 'Before' } },
  },
};
const request = {
  id,
  version,
  content,
  requestId: 'request-1',
  expectedActor: actor,
  expectedEnvironment: 'https://example.supabase.co',
};
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
function fixture(
  t: TestContext,
  initial: JsonObject | null = null,
  ambiguous = false,
  wrongReadback = false,
  candidate: JsonObject = content,
  invalidAcknowledgement = false,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dataset-write-test-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  let stored = initial;
  let writes = 0;
  const bodies: JsonObject[] = [];
  const writer = datasetWriter(
    env,
    async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
      if (init?.method === 'POST') {
        writes++;
        bodies.push(JSON.parse(String(init.body)));
        if (ambiguous) throw new Error('Bearer secret');
        stored = String(url).endsWith('/app_dataset_delete')
          ? null
          : wrongReadback
            ? before
            : candidate;
        return new Response(
          JSON.stringify(
            String(url).endsWith('/save_lifecycle_model_bundle')
              ? { ok: true, modelId: invalidAcknowledgement ? 'wrong' : id, version }
              : { ok: true, data: { id, version } },
          ),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify(
          stored
            ? [
                {
                  id,
                  version,
                  user_id: actor,
                  state_code: 0,
                  json: stored,
                  json_tg: { submodels: [], custom: 'retained' },
                },
              ]
            : [],
        ),
        {
          headers: {
            'content-type': 'application/json',
            'content-range': stored ? '0-0/1' : '*/0',
          },
        },
      );
    },
    directory,
    async () => {},
  );
  return { writer, directory, bodies, writes: () => writes };
}

test('create and guarded save keep distinct intent, exact content readback and one dispatch', async (t) => {
  const created = fixture(t);
  const preview = await created.writer('contact', 'create', request, true);
  assert.equal(preview.outcome, 'preview_completed');
  assert.equal(created.writes(), 0);
  assert.deepEqual(readdirSync(created.directory), []);
  const first = await created.writer('contact', 'create', request, false);
  assert.equal(first.outcome, 'dataset_written');
  assert.equal(created.writes(), 1);
  assert.equal(created.bodies[0]!.table, 'contacts');
  const duplicate = await created.writer('contact', 'create', request, false);
  assert.equal(duplicate.outcome, 'original_result_returned');
  assert.equal(created.writes(), 1);
  const saved = fixture(t, before);
  const response = await saved.writer(
    'contact',
    'save',
    { ...request, expectedContent: before },
    false,
  );
  assert.equal(response.status, 'completed');
  assert.deepEqual(saved.bodies[0]!.expectedJsonOrdered, before);
  assert.equal(saved.writes(), 1);
  await assert.rejects(
    saved.writer('contact', 'create', { ...request, requestId: 'different' }, false),
    /already exists/,
  );
  assert.equal(saved.writes(), 1);
});

test('model create uses the existing atomic service with no generated mutations or update fallback', async (t) => {
  const model = {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
  const modelRequest = { ...request, content: model };
  const created = fixture(t, null, false, false, model);
  assert.equal((await created.writer('model', 'create', modelRequest, false)).status, 'completed');
  assert.equal(created.bodies[0]!.mode, 'create');
  assert.deepEqual(created.bodies[0]!.processMutations, []);
  assert.equal(created.bodies[0]!.modelId, id);
  assert.deepEqual((created.bodies[0]!.parent as JsonObject).jsonOrdered, model);
  await assert.rejects(
    created.writer('model', 'create', { ...modelRequest, requestId: 'conflict' }, false),
    /already exists/,
  );
  assert.equal(created.writes(), 1);
  await assert.rejects(created.writer('model', 'save', modelRequest, false), /expectedContent/);
  for (const invalid of [true, false]) {
    const failed = fixture(t, null, !invalid, false, model, invalid);
    assert.equal((await failed.writer('model', 'create', modelRequest, false)).status, 'unknown');
    assert.equal((await failed.writer('model', 'create', modelRequest, false)).status, 'unknown');
    assert.equal(failed.writes(), 1);
    assert.equal(failed.bodies[0]!.mode, 'create');
  }
});

test('unknown writes retain recovery, never replay, and reject changed request binding', async (t) => {
  for (const mode of ['transport', 'readback']) {
    const instance = fixture(t, null, mode === 'transport', mode === 'readback');
    const first = await instance.writer('contact', 'create', request, false);
    assert.equal(first.status, 'unknown');
    assert.equal(instance.writes(), 1);
    assert.ok(!JSON.stringify(first).includes('secret'));
    const repeated = await instance.writer('contact', 'create', request, false);
    assert.equal(repeated.status, 'unknown');
    assert.equal(instance.writes(), 1);
    await assert.rejects(
      instance.writer('contact', 'save', { ...request, expectedContent: before }, false),
      /already bound/,
    );
    assert.equal(instance.writes(), 1);
    const journal = readdirSync(instance.directory).find((name) => name.endsWith('.json'))!;
    assert.equal(
      JSON.parse(readFileSync(path.join(instance.directory, journal), 'utf8')).state,
      'unknown',
    );
    if (process.platform !== 'win32') {
      chmodSync(path.join(instance.directory, journal), 0o644);
      await assert.rejects(instance.writer('contact', 'create', request, false), /private regular/);
    }
  }
});

test('writes reject missing identities, wrong actor/environment and stale save without dispatch', async (t) => {
  const instance = fixture(t, before);
  for (const changed of [
    { extra: true },
    { id: 'id' },
    { version: 'latest' },
    { content: { contactDataSet: {} } },
    { expectedActor: 'other' },
    { expectedEnvironment: 'https://wrong.test' },
  ])
    await assert.rejects(instance.writer('contact', 'create', { ...request, ...changed }, false));
  await assert.rejects(instance.writer('contact', 'save', request, false), /expectedContent/);
  await assert.rejects(
    instance.writer('contact', 'save', { ...request, expectedContent: content }, false),
    /must match/,
  );
  await assert.rejects(instance.writer('contact', 'delete', request, false), /content/);
  await assert.rejects(instance.writer('unitgroup', 'create', request, false), /read-only/);
  const absent = fixture(t);
  await assert.rejects(
    absent.writer('contact', 'save', { ...request, expectedContent: before }, false),
    /Existing owner draft/,
  );
  assert.equal(instance.writes(), 0);
  await assert.rejects(
    qualifyDatasetWrite('contact', { contactDataSet: {} }, env, async () => {
      throw new Error('network should not be called');
    }),
    /local checks/,
  );
});

test('parallel calls share the original request result without duplicate dispatch', async (t) => {
  const instance = fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => instance.writer('contact', 'create', request, false)),
  );
  assert.equal(instance.writes(), 1);
  assert.equal(
    responses.filter((response) => response.outcome === 'original_result_returned').length,
    2,
  );
});

test('write dispatch is blocked if the intent cannot be persisted after preflight', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dataset-intent-fail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let writes = 0;
  const writer = datasetWriter(
    env,
    async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
      if (init?.method === 'POST') writes++;
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    },
    directory,
    async () => {
      mkdirSync(path.join(directory, `${contentDigest(request.requestId)}.json`));
    },
  );
  await assert.rejects(
    writer('contact', 'create', request, false),
    /blocked before request dispatch/,
  );
  assert.equal(writes, 0);
});

test('post-dispatch journal failure preserves unknown outcome and prohibits a second write', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dataset-post-dispatch-fail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, `${contentDigest(request.requestId)}.json`);
  let writes = 0;
  const writer = datasetWriter(
    env,
    async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
      if (init?.method === 'POST') {
        writes++;
        rmSync(journal);
        mkdirSync(journal);
        return new Response(JSON.stringify({ ok: true, data: { id, version } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(
          writes ? [{ id, version, user_id: actor, state_code: 0, json: content }] : [],
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    },
    directory,
    async () => {},
  );
  const response = await writer('contact', 'create', request, false);
  assert.equal(response.status, 'unknown');
  assert.equal(response.warnings[0]!.code, 'JOURNAL_UPDATE_UNAVAILABLE');
  assert.equal((response.data.readback as JsonObject).establishesRequestOutcome, false);
  await assert.rejects(writer('contact', 'create', request, false), /private regular file/);
  assert.equal(writes, 1);
});

test('write qualification runs real local rules and existing remote reference admission', async () => {
  const flow = makeFlow();
  assert.equal((await datasetValidation('flow', flow, ['schema'])).status, 'passed');
  assert.equal((await datasetValidation('flow', flow, ['schema', 'business'])).status, 'passed');
  let reads = 0;
  const fetchImpl = async (url: string) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    reads++;
    const selected = new URL(url).searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
    return new Response(JSON.stringify([{ id: selected, version: '00.00.001' }]), {
      headers: { 'content-type': 'application/json' },
    });
  };
  await qualifyDatasetWrite('flow', flow, env, fetchImpl);
  assert.ok(reads > 0);
  await assert.rejects(
    qualifyDatasetWrite('flow', flow, env, async (url) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse()
        : new Response('[]', { headers: { 'content-type': 'application/json' } }),
    ),
    /reference admission/,
  );
});

test('existing model save and draft delete retain distinct service semantics and disclose preflight-only content checks', async (t) => {
  const deleted = fixture(t, before);
  const intent = { ...request, expectedContent: before };
  assert.equal(
    (await deleted.writer('contact', 'delete', intent, true)).outcome,
    'preview_completed',
  );
  const result = await deleted.writer('contact', 'delete', intent, false);
  assert.equal(result.outcome, 'dataset_deleted');
  assert.deepEqual(result.data.readback, {
    targetAbsent: true,
    subject: { type: 'contact', id, version },
  });
  assert.ok(
    (result.completeness.notChecked as string[]).includes('server_content_compare_and_swap'),
  );
  assert.equal(deleted.writes(), 1);
  const conflict = fixture(t, before);
  await assert.rejects(
    conflict.writer('contact', 'delete', { ...request, expectedContent: content }, false),
    /must match current content/,
  );
  assert.equal(conflict.writes(), 0);
  const model = {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
  const saved = fixture(t, model, false, false, model);
  assert.equal(
    (
      await saved.writer(
        'model',
        'save',
        { ...request, content: model, expectedContent: model },
        false,
      )
    ).status,
    'completed',
  );
  assert.equal(saved.bodies[0]!.mode, 'update');
  await assert.rejects(saved.writer('model', 'delete', request, false), /outside this interface/);
});
