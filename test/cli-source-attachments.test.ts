import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadSourceAttachments } from '../src/adapters/source-attachments.js';
import { datasetOperations } from '../src/adapters/dataset-operations.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import type { FetchLike } from '../src/lib/transport/http.js';

const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
function setup(
  t: TestContext,
  references: unknown = [
    { '@uri': 'a.pdf' },
    'b.pdf',
    { '@uri': 'https://example.test/remote.pdf' },
    null,
  ],
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'source-upload-new-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  for (const name of ['a.pdf', 'b.pdf']) writeFileSync(path.join(directory, name), 'snapshot');
  const content = {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: { 'common:UUID': 'source-1', referenceToDigitalFile: references },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '00.00.001' },
      },
    },
  };
  const attachments = ['a.pdf', 'b.pdf'].map((name) => ({
    name,
    path: name,
    size: 8,
    sha256: createHash('sha256').update('snapshot').digest('hex'),
  }));
  return { directory, content, request: { content, bucket: 'external_docs', attachments } };
}
test('attachments snapshot exact bytes, refuse upsert, independently verify content, and preserve failed references', async (t) => {
  const fixture = setup(t);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    calls.push({ url, init });
    if (init?.method === 'POST' && !url.includes('/object/sign/')) {
      assert.equal(new Headers(init.headers).get('x-upsert'), 'false');
      assert.equal(await (init.body as Blob).text(), 'snapshot');
      return new Response('', { status: url.includes('b.pdf') ? 409 : 200 });
    }
    if (init?.method === 'POST')
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    return new Response('snapshot', { headers: { 'content-type': 'application/pdf' } });
  };
  const preview = await uploadSourceAttachments(
    { ...fixture.request, dryRun: true },
    path.join(fixture.directory, 'request.json'),
    env,
    fetchImpl,
  );
  assert.equal(preview.status, 'preview_completed');
  assert.equal(calls.length, 0);
  assert.deepEqual(preview.content, fixture.content);
  const uploaded = await uploadSourceAttachments(
    fixture.request,
    path.join(fixture.directory, 'request.json'),
    env,
    fetchImpl,
  );
  assert.equal(uploaded.status, 'partial');
  const references = (
    ((uploaded.content.sourceDataSet as JsonObject).sourceInformation as JsonObject)
      .dataSetInformation as JsonObject
  ).referenceToDigitalFile as unknown[];
  assert.notDeepEqual(references[0], { '@uri': 'a.pdf' });
  assert.equal(references[1], 'b.pdf');
  assert.deepEqual(
    fixture.content.sourceDataSet.sourceInformation.dataSetInformation.referenceToDigitalFile,
    [{ '@uri': 'a.pdf' }, 'b.pdf', { '@uri': 'https://example.test/remote.pdf' }, null],
  );
  assert.equal(uploaded.summary.files_uploaded, 1);
  assert.equal(uploaded.files[1]?.status, 'failed');
  assert.ok(!JSON.stringify(uploaded).includes('source-attachments-'));
  const routed = await datasetOperations(
    env,
    fetchImpl,
  )({
    type: 'source',
    action: 'upload-attachments',
    request: { ...fixture.request, dryRun: true },
    inputPath: path.join(fixture.directory, 'request.json'),
  });
  assert.equal(routed.status, 'preview_completed');
});

test('attachment validation rejects drift, ambiguous names and unresolved selection before network', async (t) => {
  const fixture = setup(t, [{ '@uri': 'a.pdf' }, { '@uri': 'b.pdf' }]);
  let effects = 0;
  const noNetwork: FetchLike = async () => {
    effects++;
    throw new Error('network');
  };
  const input = path.join(fixture.directory, 'request.json');
  for (const request of [
    { ...fixture.request, bucket: '../escape' },
    { ...fixture.request, attachments: [] },
    { ...fixture.request, attachments: [{ ...fixture.request.attachments[0], name: '../a.pdf' }] },
    {
      ...fixture.request,
      attachments: [fixture.request.attachments[0], fixture.request.attachments[0]],
    },
    { ...fixture.request, attachments: [{ ...fixture.request.attachments[0], size: 1 }] },
    { ...fixture.request, attachments: [{ ...fixture.request.attachments[0], sha256: 'wrong' }] },
    { ...fixture.request, attachments: [fixture.request.attachments[0]] },
  ])
    await assert.rejects(uploadSourceAttachments(request, input, env, noNetwork));
  await assert.rejects(uploadSourceAttachments(fixture.request, '-', env, noNetwork), /absolute/);
  assert.equal(effects, 0);
});

test('verified attachment transfer rewrites a string URI and returns completed without saving the Source', async (t) => {
  const fixture = setup(t, 'a.pdf');
  const response = await uploadSourceAttachments(
    { ...fixture.request, attachments: [fixture.request.attachments[0]] },
    path.join(fixture.directory, 'request.json'),
    env,
    async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      return init?.method === 'POST'
        ? new Response('{}', { headers: { 'content-type': 'application/json' } })
        : new Response('snapshot');
    },
  );
  assert.equal(response.status, 'completed');
  assert.notEqual(
    ((response.content.sourceDataSet as JsonObject).sourceInformation as JsonObject)
      .dataSetInformation &&
      (
        ((response.content.sourceDataSet as JsonObject).sourceInformation as JsonObject)
          .dataSetInformation as JsonObject
      ).referenceToDigitalFile,
    'a.pdf',
  );
  assert.equal(response.summary.files_uploaded, 1);
});

test('attachment readback mismatch retains the original single reference and a recovery receipt', async (t) => {
  for (const body of ['different', 'snapshox', null]) {
    const fixture = setup(t, 'a.pdf');
    const fetchImpl: FetchLike = async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (init?.method === 'POST')
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      return body === null ? new Response('unavailable', { status: 404 }) : new Response(body);
    };
    const result = await uploadSourceAttachments(
      {
        ...fixture.request,
        attachments: [
          { ...fixture.request.attachments[0], path: path.join(fixture.directory, 'a.pdf') },
        ],
      },
      '-',
      env,
      fetchImpl,
    );
    assert.equal(result.status, 'partial');
    assert.equal(
      result.content.sourceDataSet &&
        ((result.content.sourceDataSet as JsonObject).sourceInformation as JsonObject)
          .dataSetInformation &&
        (
          ((result.content.sourceDataSet as JsonObject).sourceInformation as JsonObject)
            .dataSetInformation as JsonObject
        ).referenceToDigitalFile,
      'a.pdf',
    );
    assert.equal(result.recovery.automaticRetry, false);
  }
});
