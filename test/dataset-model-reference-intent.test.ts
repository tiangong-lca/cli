import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  __testInternals,
  runDatasetRemoteVerify,
  type DatasetRemoteVerificationReport,
  type RemoteVerificationCheck,
} from '../src/lib/dataset-remote-verify.js';
import type { FetchLike } from '../src/lib/http.js';
import { buildSupabaseTestEnv, makeSupabaseAuthResponse } from './helpers/supabase-auth.js';

const modelId = '00000000-0000-4000-8000-000000000001';
const consumerId = '00000000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000003';
const owner = '00000000-0000-4000-8000-000000000004';
const project = 'abcdefghijklmnopqrst';
const origin = `https://${project}.supabase.co`;
const accessToken = 'synthetic-model-reference-token';
const older = '00.00.001';
const newer = '00.00.002';
const sha = __testInternals.sha256Json;

const provenancePath =
  '/processDataSet/processInformation/dataSetInformation/generatedFromLifecycleModel';
const predecessorPath =
  '/lifeCycleModelDataSet/administrativeInformation/publicationAndOwnership/common:referenceToPrecedingDataSetVersion/0';
const predecessor = {
  '@type': 'other external file',
  '@refObjectId': modelId,
  '@version': older,
  '@uri': `../lifecyclemodels/${modelId}_${older}.xml`,
  'common:shortDescription': { '@xml:lang': 'en', '#text': 'Reviewed Model predecessor' },
};

function model(id: string, version: string, name: string, preceding?: typeof predecessor) {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: { dataSetInformation: { 'common:UUID': id, name } },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': version,
          ...(preceding ? { 'common:referenceToPrecedingDataSetVersion': [preceding] } : {}),
        },
      },
    },
  };
}

const contexts = [
  {
    name: 'legacy Model provenance',
    referencePath: provenancePath,
    rootTable: 'processes',
    payload: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': consumerId,
            generatedFromLifecycleModel: { id: modelId, version: older, role: 'primary' },
          },
        },
        administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': newer } },
      },
    },
  },
  {
    name: 'Model predecessor array item',
    referencePath: predecessorPath,
    rootTable: 'lifecyclemodels',
    payload: model(consumerId, newer, 'Model successor', predecessor),
  },
] as const;

type Context = (typeof contexts)[number];
type Fault =
  | 'none'
  | 'actor'
  | 'missing-dataset'
  | 'missing-version'
  | 'no-longer-visible'
  | 'wrong-payload-version'
  | 'payload'
  | 'owner'
  | 'state'
  | 'outdated-root';

const selectedPayload = model(modelId, older, 'Reviewed Model');
const latestPayload = model(modelId, newer, 'Latest Model');

function fixture(t: TestContext, context: Context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-model-reference-intent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.json');
  const referenceIntentFile = path.join(directory, 'intent.json');
  const reviewFile = path.join(directory, 'review.json');
  const selected = {
    table: 'lifecyclemodels',
    id: modelId,
    version: older,
    payload_sha256: sha(selectedPayload),
    user_id: owner,
    state_code: 100,
  };
  const review = JSON.stringify({
    schema_version: 'dataset-exact-reference-review.v1',
    decision: 'use_selected_exact',
    reason: 'The Model consumer was reviewed against this exact inventory definition.',
    selected,
    latest: { ...selected, version: newer, payload_sha256: sha(latestPayload) },
  });
  writeFileSync(inputPath, JSON.stringify([context.payload]));
  writeFileSync(reviewFile, review);
  writeFileSync(
    referenceIntentFile,
    JSON.stringify({
      schema_version: 'dataset-exact-reference-intent.v1',
      project_ref: project,
      actor_user_id: actor,
      consumers: [
        {
          row_index: 0,
          table: context.rootTable,
          id: consumerId,
          version: newer,
          payload_sha256: sha(context.payload),
        },
      ],
      references: [
        {
          row_index: 0,
          path: context.referencePath,
          selected,
          review: { file: reviewFile, sha256: createHash('sha256').update(review).digest('hex') },
        },
      ],
    }),
  );
  return { directory, inputPath, referenceIntentFile, rootPolicy: 'existing' as const };
}

function remote(context: Context, fault: Fault = 'none') {
  const requests: { url: URL; method: string; authorization: string | null }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input, origin);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
    });
    assert.equal(url.origin, origin);
    if (url.pathname === '/auth/v1/user')
      return makeSupabaseAuthResponse({
        userId: fault === 'actor' ? owner : actor,
        email: 'reader@example.invalid',
        accessToken,
      });

    const exact = url.searchParams.get('version');
    const id = url.searchParams.get('id');
    if (id === `eq.${consumerId}`) {
      assert.equal(url.pathname, `/rest/v1/${context.rootTable}`);
      assert.equal(url.searchParams.get('select'), 'id,version');
      return Response.json([
        { id: consumerId, version: !exact && fault === 'outdated-root' ? '00.00.003' : newer },
      ]);
    }

    assert.equal(id, `eq.${modelId}`);
    assert.equal(url.pathname, '/rest/v1/lifecyclemodels');
    if (exact) assert.equal(exact, `eq.${older}`);
    const metadata = url.searchParams.get('select') === 'id,version';
    if (fault === 'missing-dataset' || (exact && fault === 'missing-version'))
      return Response.json([]);
    const version = exact ? older : newer;
    if (metadata) return Response.json([{ id: modelId, version }]);
    if (exact && fault === 'no-longer-visible') return Response.json([]);
    const observedVersion = fault === 'wrong-payload-version' ? newer : version;
    return Response.json([
      {
        id: modelId,
        version: observedVersion,
        user_id: exact && fault === 'owner' ? actor : owner,
        state_code: exact && fault === 'state' ? 0 : 100,
        json:
          observedVersion === older
            ? fault === 'payload'
              ? model(modelId, older, 'Changed Model content')
              : selectedPayload
            : latestPayload,
      },
    ]);
  };
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: `${origin}/functions/v1`,
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
    TIANGONG_LCA_ACCESS_TOKEN: accessToken,
  });
  return { env, fetchImpl, requests };
}

function referenceCheck(report: DatasetRemoteVerificationReport, context: Context) {
  const checks = readFileSync(report.files.checks, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RemoteVerificationCheck);
  const references = checks.filter((check) => check.role === 'reference');
  assert.equal(references.length, 1);
  const [reference] = references;
  assert.equal(reference.path, context.referencePath);
  assert.equal(reference.table, 'lifecyclemodels');
  assert.equal(reference.id, modelId);
  assert.equal(reference.version, older);
  return reference;
}

function assertReadOnly(requests: ReturnType<typeof remote>['requests']) {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.authorization, `Bearer ${accessToken}`);
    assert.equal(request.url.origin, origin);
    assert.match(
      request.url.pathname,
      /^\/(?:auth\/v1\/user|rest\/v1\/(?:processes|lifecyclemodels))$/u,
    );
  }
}

for (const context of contexts) {
  test(`${context.name} requires a reviewed exact intent for an older version`, async (t) => {
    const f = fixture(t, context);
    const withoutIntent = remote(context);
    const blocked = await runDatasetRemoteVerify({
      ...f,
      ...withoutIntent,
      outDir: path.join(f.directory, 'unreviewed'),
      referenceIntentFile: undefined,
    });
    assert.equal(blocked.status, 'blocked_remote_verification');
    assert.equal(referenceCheck(blocked, context).status, 'version_outdated');
    assertReadOnly(withoutIntent.requests);

    const reviewed = remote(context);
    const result = await executeCli(
      [
        'dataset',
        'verify-remote',
        '--input',
        f.inputPath,
        '--out-dir',
        path.join(f.directory, 'reviewed'),
        '--reference-intent-file',
        f.referenceIntentFile,
        '--json',
      ],
      { ...reviewed, dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 } },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout) as DatasetRemoteVerificationReport;
    assert.equal(report.status, 'passed_remote_verification');
    const check = referenceCheck(report, context);
    assert.equal(check.reference_intent?.applied, true);
    assert.equal(check.reference_intent.original_status, 'version_outdated');
    assert.equal(check.reference_intent.selected?.payload_sha256, sha(selectedPayload));
    assert.equal(check.reference_intent.latest?.payload_sha256, sha(latestPayload));
    assert.equal(reviewed.requests[0]?.url.pathname, '/auth/v1/user');
    const payloadReads = reviewed.requests
      .map(({ url }) => url)
      .filter((url) => url.searchParams.get('select')?.includes('json_ordered'));
    assert.deepEqual(
      payloadReads.map((url) => url.searchParams.get('version')),
      [null, `eq.${older}`],
    );
    assertReadOnly(reviewed.requests);
  });

  test(`${context.name} still blocks missing, wrong-version and drifted Model evidence`, async (t) => {
    const f = fixture(t, context);
    const faults = [
      ['missing-dataset', 'missing_dataset', 'base_check_blocked'],
      ['missing-version', 'missing_version', 'base_check_blocked'],
      ['no-longer-visible', 'reference_intent_mismatch', 'selected_snapshot_mismatch'],
      ['wrong-payload-version', 'reference_intent_mismatch', 'selected_snapshot_mismatch'],
      ['payload', 'reference_intent_mismatch', 'selected_snapshot_mismatch'],
      ['owner', 'reference_intent_mismatch', 'selected_snapshot_mismatch'],
      ['state', 'reference_intent_mismatch', 'selected_snapshot_mismatch'],
    ] as const;
    for (const [fault, status, failure] of faults) {
      const transport = remote(context, fault);
      const report = await runDatasetRemoteVerify({
        ...f,
        ...transport,
        outDir: path.join(f.directory, fault),
      });
      assert.equal(report.status, 'blocked_remote_verification', fault);
      assert.equal(report.blockers.length, 1, fault);
      const check = referenceCheck(report, context);
      assert.equal(check.status, status, fault);
      assert.equal(check.reference_intent?.applied, false, fault);
      assert.equal(check.reference_intent.failure, failure, fault);
      assertReadOnly(transport.requests);
    }
  });

  test(`${context.name} leaves actor and consumer root checks independent`, async (t) => {
    const f = fixture(t, context);
    const wrongActor = remote(context, 'actor');
    await assert.rejects(
      runDatasetRemoteVerify({
        ...f,
        ...wrongActor,
        outDir: path.join(f.directory, 'wrong-actor'),
      }),
      { code: 'AUTH_IDENTITY_USER_MISMATCH' },
    );
    assert.deepEqual(
      wrongActor.requests.map(({ url }) => url.pathname),
      ['/auth/v1/user'],
    );
    assertReadOnly(wrongActor.requests);

    const outdatedRoot = remote(context, 'outdated-root');
    const report = await runDatasetRemoteVerify({
      ...f,
      ...outdatedRoot,
      outDir: path.join(f.directory, 'outdated-root'),
    });
    assert.equal(report.status, 'blocked_remote_verification');
    assert.deepEqual(
      report.blockers.map(({ role, id, code }) => ({ role, id, code })),
      [{ role: 'root', id: consumerId, code: 'version_outdated' }],
    );
    assert.equal(referenceCheck(report, context).reference_intent?.applied, true);
    assertReadOnly(outdatedRoot.requests);
  });
}
