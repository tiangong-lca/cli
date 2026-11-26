import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeCli } from '../src/cli.js';
import { readStudyIntent } from '../src/lib/study/intent.js';
import type { FetchLike } from '../src/lib/transport/http.js';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const STUDY = '44444444-4444-4444-8444-444444444444';
const roots: string[] = [];
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function fixture(status: 'active' | 'archived', revision: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-archive-cas-'));
  roots.push(root);
  const env = {
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'archive-fixture-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ sub: ACTOR })).toString('base64url')}.synthetic`,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
  };
  let selected = { status, revision };
  const requests: Record<string, unknown>[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/auth/v1/user'))
      return json({ id: ACTOR, email: 'archive@example.test', role: 'authenticated' });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const data =
      request.operation === 'capability.read'
        ? {
            type: 'capabilities',
            contractVersion: '2.0.0',
            runtimeEnabled: true,
            operations: ['capability.read', 'study.archive'],
            profiles: [],
          }
        : {
            type: 'study',
            value: {
              studyId: STUDY,
              scope: { kind: 'user', id: ACTOR },
              title: 'Archive CAS fixture',
              currentRevisionId: null,
              ...selected,
            },
          };
    if (request.operation === 'study.archive') requests.push(request);
    return json({
      schemaVersion: 'lca.study-api.v2',
      requestId: request.requestId,
      ok: true,
      data,
    });
  };
  const invoke = (args: string[]) =>
    executeCli(['study', ...args, '--json'], {
      fetchImpl,
      env,
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    });
  const input = path.join(root, 'archive.json');
  writeFileSync(
    input,
    JSON.stringify({
      requestId: 'archive-original',
      idempotencyKey: 'archive-cas-key',
      target: { type: 'study', id: STUDY, expectedRevision: 7 },
    }),
  );
  return {
    root,
    input,
    requests,
    invoke,
    valid: () => {
      selected = { status: 'archived', revision: 8 };
    },
  };
}
for (const [status, revision] of [
  ['active', 7],
  ['active', 8],
  ['archived', 7],
  ['archived', 10],
] as const) {
  test(`V2 archive rejects ${status}${revision}, retains unknown intent, and recovers only archived8`, async () => {
    const f = fixture(status, revision);
    const first = await f.invoke(['archive', '--input', f.input, '--state-dir', f.root]);
    assert.equal(first.exitCode, 1, first.stdout);
    const failure = JSON.parse(first.stderr) as {
      error: { code: string; details: { intentFile: string } };
    };
    assert.equal(failure.error.code, 'STUDY_RESPONSE_SELECTION');
    const intentFile = failure.error.details.intentFile,
      bytes = readFileSync(intentFile);
    const intent = readStudyIntent(intentFile);
    assert.equal(intent.request.schemaVersion, 'lca.study-api.v2');
    assert.equal(intent.request.requestId, 'archive-original');
    assert.equal(intent.request.idempotencyKey, 'archive-cas-key');
    assert.equal(f.requests.length, 1, 'a rejected success cannot cause automatic replay');
    const refused = await f.invoke(['request', 'recover', '--intent-file', intentFile]);
    assert.equal(refused.exitCode, 1, refused.stdout);
    assert.match(refused.stderr, /STUDY_RESPONSE_SELECTION/u);
    assert(readFileSync(intentFile).equals(bytes));
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0], f.requests[1]);
    f.valid();
    const recovered = await f.invoke(['request', 'recover', '--intent-file', intentFile]);
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).data.value.status, 'archived');
    assert.equal(JSON.parse(recovered.stdout).data.value.revision, 8);
    assert(readFileSync(intentFile).equals(bytes));
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.requests[0], f.requests[2]);
  });
}
test('V2 archive accepts exact archived8 on initial dispatch without changing its original journal', async () => {
  const f = fixture('archived', 8);
  const result = await f.invoke(['archive', '--input', f.input, '--state-dir', f.root]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    intentFile: string;
    data: { value: { status: string; revision: number } };
  };
  assert.equal(report.data.value.status, 'archived');
  assert.equal(report.data.value.revision, 8);
  assert.equal(f.requests.length, 1);
  assert.equal(readStudyIntent(report.intentFile).request.idempotencyKey, 'archive-cas-key');
});
