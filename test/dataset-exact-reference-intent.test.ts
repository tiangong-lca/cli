import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildSupabaseTestEnv, makeSupabaseAuthResponse } from './helpers/supabase-auth.js';
import {
  runDatasetRemoteVerify,
  collectRemoteReferences,
  __testInternals,
} from '../src/lib/dataset/remote-verify.js';

const version = '00.00.001',
  newer = '00.00.002';
const identifier = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = identifier(90),
  owner = identifier(91),
  project = 'abcdefghijklmnopqrst';
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = __testInternals.sha256Json;
function flow(v: string) {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': identifier(1),
          name: {
            baseName:
              v === version ? 'Selected physical definition' : 'Changed physical definition',
          },
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': v } },
    },
  };
}
function consumer() {
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': identifier(2) } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
      exchanges: {
        exchange: [
          {
            referenceToFlowDataSet: {
              '@type': 'flow data set',
              '@refObjectId': identifier(1),
              '@version': version,
            },
          },
        ],
      },
    },
  };
}
function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exact-reference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [consumer()],
    input = path.join(root, 'rows.json'),
    reviewFile = path.join(root, 'review.json'),
    intentFile = path.join(root, 'intent.json');
  const selected = {
    table: 'flows',
    id: identifier(1),
    version,
    payload_sha256: sha(flow(version)),
    user_id: owner,
    state_code: 100,
  };
  const latest = { ...selected, version: newer, payload_sha256: sha(flow(newer)) };
  const reference = collectRemoteReferences(rows).find((ref) => ref.role === 'reference')!;
  fs.writeFileSync(input, JSON.stringify(rows));
  fs.writeFileSync(
    reviewFile,
    JSON.stringify({
      schema_version: 'dataset-exact-reference-review.v1',
      decision: 'use_selected_exact',
      reason:
        'The consumer models the selected physical definition; the latest definition changes its boundary.',
      selected,
      latest,
    }),
  );
  const intent = {
    schema_version: 'dataset-exact-reference-intent.v1',
    project_ref: project,
    actor_user_id: actor,
    consumers: [
      {
        row_index: 0,
        table: 'processes',
        id: identifier(2),
        version,
        payload_sha256: sha(rows[0]),
      },
    ],
    references: [
      {
        row_index: 0,
        path: reference.path,
        selected,
        review: { file: reviewFile, sha256: digest(reviewFile) },
      },
    ],
  };
  fs.writeFileSync(intentFile, JSON.stringify(intent));
  const calls: string[] = [];
  const options = {
    inputPath: input,
    outDir: path.join(root, 'verify'),
    rootPolicy: 'candidate' as const,
    referenceIntentFile: intentFile,
    resolveReferenceIdentityImpl: async () => {
      calls.push('identity');
      return { project_ref: project, user_id: actor };
    },
    lookupDatasetImpl: async (request: { table: string; id: string; version: string | null }) => {
      calls.push(`metadata:${request.table}:${request.version}`);
      return {
        exact: request.table === 'flows' ? { id: identifier(1), version } : null,
        latest: request.table === 'flows' ? { id: identifier(1), version: newer } : null,
        exact_source_url: null,
        latest_source_url: null,
      };
    },
    lookupReferencePayloadImpl: async (request: {
      table: string;
      id: string;
      version: string | null;
    }) => {
      calls.push(`payload:${request.table}:${request.version}`);
      const v = request.version ?? newer;
      return {
        id: request.id,
        version: v,
        user_id: owner,
        state_code: 100,
        modified_at: null,
        payload: flow(v),
        source_url: null,
      };
    },
  };
  return { root, options, intent, intentFile, reviewFile, calls };
}

test('an explicit reviewed exact reference can retain an older physical definition while default latest policy still blocks it', async (t) => {
  const f = fixture(t);
  const defaultReport = await runDatasetRemoteVerify({
    ...f.options,
    referenceIntentFile: undefined,
    outDir: path.join(f.root, 'default'),
  });
  assert.equal(defaultReport.status, 'blocked_remote_verification');
  assert.ok(defaultReport.blockers.some((blocker) => blocker.code === 'version_outdated'));
  const report = await runDatasetRemoteVerify(f.options);
  assert.equal(report.status, 'passed_remote_verification');
  assert.equal(report.counts.blockers, 0);
});

test('missing explicitly selected reference intent fails before remote lookups or report output', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.intentFile);
  await assert.rejects(runDatasetRemoteVerify(f.options));
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.options.outDir), false);
});

test('a reference occurrence sharing a root path cannot override root latest-version policy', async (t) => {
  const f = fixture(t),
    row = consumer();
  delete (row.processDataSet as Record<string, unknown>).exchanges;
  Object.assign(row.processDataSet, {
    '@refObjectId': identifier(1),
    '@version': version,
    '@type': 'flow data set',
  });
  f.intent.consumers[0].payload_sha256 = sha(row);
  f.intent.references[0].path = '/processDataSet';
  fs.writeFileSync(f.options.inputPath, JSON.stringify([row]));
  fs.writeFileSync(f.intentFile, JSON.stringify(f.intent));
  const report = await runDatasetRemoteVerify({
    ...f.options,
    lookupDatasetImpl: async (request) =>
      request.table === 'processes'
        ? {
            exact: { id: identifier(2), version },
            latest: { id: identifier(2), version: newer },
            exact_source_url: null,
            latest_source_url: null,
          }
        : f.options.lookupDatasetImpl(request),
  });
  assert.equal(report.status, 'blocked_remote_verification');
  assert.ok(
    report.blockers.some(
      (blocker) => blocker.role === 'root' && blocker.code === 'version_outdated',
    ),
  );
});

type IntentFixture = ReturnType<typeof fixture>['intent'];
function saveIntent(f: ReturnType<typeof fixture>) {
  fs.writeFileSync(f.intentFile, JSON.stringify(f.intent));
}
function editReview(
  f: ReturnType<typeof fixture>,
  edit: (review: {
    schema_version: string;
    decision: string;
    reason: string;
    selected: IntentFixture['references'][number]['selected'];
    latest: IntentFixture['references'][number]['selected'];
  }) => void,
) {
  const review = JSON.parse(fs.readFileSync(f.reviewFile, 'utf8')) as Parameters<typeof edit>[0];
  edit(review);
  fs.writeFileSync(f.reviewFile, JSON.stringify(review));
  for (const pin of f.intent.references) pin.review.sha256 = digest(f.reviewFile);
  saveIntent(f);
}
function checks(report: Awaited<ReturnType<typeof runDatasetRemoteVerify>>) {
  return fs
    .readFileSync(report.files.checks, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as import('../src/lib/dataset/remote-verify.js').RemoteVerificationCheck,
    );
}

test('malformed, stale, duplicate, root or unused intent scopes fail before identity and dataset reads', async (t) => {
  const mutations: ((intent: IntentFixture) => void)[] = [
    (x) => {
      x.schema_version = 'unsupported';
    },
    (x) => {
      x.project_ref = 'bad';
    },
    (x) => {
      x.actor_user_id = 'not-a-uuid';
    },
    (x) => {
      x.consumers[0].payload_sha256 = '0'.repeat(64);
    },
    (x) => {
      x.consumers[0].payload_sha256 = 'bad';
    },
    (x) => {
      x.consumers[0].row_index = 1;
    },
    (x) => {
      x.consumers[0].id = identifier(99);
    },
    (x) => {
      x.consumers.push(structuredClone(x.consumers[0]));
    },
    (x) => {
      x.consumers = [];
    },
    (x) => {
      x.references[0].row_index = -1;
    },
    (x) => {
      x.references[0].row_index = 1;
    },
    (x) => {
      x.references[0].path = '/processDataSet';
    },
    (x) => {
      x.references[0].path = '';
    },
    (x) => {
      x.references[0].path = '/unused';
    },
    (x) => {
      x.references[0].path += ' ';
    },
    (x) => {
      x.references[0].selected.table = 'sources';
    },
    (x) => {
      x.references[0].selected.table = 'unknown';
    },
    (x) => {
      x.references[0].selected.id = identifier(99);
    },
    (x) => {
      x.references[0].selected.version = newer;
    },
    (x) => {
      x.references[0].selected.version = 'latest';
    },
    (x) => {
      x.references[0].selected.state_code = 20;
    },
    (x) => {
      x.references[0].selected.state_code = 0;
    },
    (x) => {
      x.references[0].review.sha256 = '0'.repeat(64);
    },
    (x) => {
      x.references[0].review.file += ' ';
    },
    (x) => {
      x.references[0].review.file += '.missing';
    },
    (x) => {
      x.references.push(structuredClone(x.references[0]));
    },
    (x) => {
      x.references = [];
    },
    (x) => {
      Object.assign(x, { unsupported: true });
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = fixture(t);
    mutate(f.intent);
    saveIntent(f);
    await assert.rejects(
      runDatasetRemoteVerify(f.options),
      { code: 'DATASET_REFERENCE_INTENT_INVALID' },
      `mutation ${index}`,
    );
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.options.outDir), false);
  }
});

test('review schema, decision, scope, reason and same-version consistency are validated locally', async (t) => {
  const changes: Parameters<typeof editReview>[1][] = [
    (x) => {
      x.schema_version = 'bad';
    },
    (x) => {
      x.decision = 'automatic';
    },
    (x) => {
      x.reason = '';
    },
    (x) => {
      x.latest.id = identifier(99);
    },
    (x) => {
      x.latest.version = '00.00.000';
    },
    (x) => {
      x.latest.version = version;
    },
    (x) => {
      x.selected.user_id = identifier(99);
    },
    (x) => {
      Object.assign(x, { extra: true });
    },
  ];
  for (const change of changes) {
    const f = fixture(t);
    editReview(f, change);
    await assert.rejects(runDatasetRemoteVerify(f.options), {
      code: 'DATASET_REFERENCE_INTENT_INVALID',
    });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(t);
  editReview(f, (x) => {
    x.reason = 'Reviewed physical boundary.\n保留所选定义。';
  });
  assert.equal((await runDatasetRemoteVerify(f.options)).status, 'passed_remote_verification');
});

test('current actor and project must match before reference transport', async (t) => {
  for (const identity of [
    { project_ref: project, user_id: identifier(99) },
    { project_ref: 'zzzzzzzzzzzzzzzzzzzz', user_id: actor },
  ]) {
    const f = fixture(t);
    await assert.rejects(
      runDatasetRemoteVerify({ ...f.options, resolveReferenceIdentityImpl: async () => identity }),
      { code: 'DATASET_REFERENCE_INTENT_IDENTITY_MISMATCH' },
    );
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.options.outDir), false);
  }
});

test('selected payload, owner, state and latest review drift replace the occurrence check with a blocker', async (t) => {
  for (const mode of [
    'selected-payload',
    'selected-owner',
    'selected-state',
    'latest-payload',
    'latest-version',
    'missing',
    'lookup-error',
  ] as const) {
    const f = fixture(t),
      original = f.options.lookupReferencePayloadImpl;
    const report = await runDatasetRemoteVerify({
      ...f.options,
      lookupReferencePayloadImpl: async (request) => {
        if (mode === 'lookup-error')
          throw new Error('Transport failure must not become an accepted reference.');
        if (mode === 'missing') return null;
        const row = await original(request);
        if (request.version !== null && mode === 'selected-payload')
          row.payload.flowDataSet.flowInformation.dataSetInformation.name.baseName = 'drifted';
        if (request.version !== null && mode === 'selected-owner') row.user_id = actor;
        if (request.version !== null && mode === 'selected-state') row.state_code = 0;
        if (request.version === null && mode === 'latest-payload')
          row.payload.flowDataSet.flowInformation.dataSetInformation.name.baseName =
            'new definition';
        if (request.version === null && mode === 'latest-version') {
          row.version = '00.00.003';
          row.payload = flow(row.version);
        }
        return row;
      },
    });
    assert.equal(report.status, 'blocked_remote_verification', mode);
    const referenceChecks = checks(report).filter((check) => check.role === 'reference');
    assert.equal(referenceChecks.length, 1, mode);
    assert.equal(referenceChecks[0].status, 'reference_intent_mismatch', mode);
    assert.equal(referenceChecks[0].reference_intent?.applied, false, mode);
    assert.ok(report.blockers.some((blocker) => blocker.path === f.intent.references[0].path));
  }
});

test('missing versions and failed metadata reads retain their original blockers without payload lookups', async (t) => {
  for (const mode of ['missing', 'failure'] as const) {
    const f = fixture(t);
    const report = await runDatasetRemoteVerify({
      ...f.options,
      lookupDatasetImpl: async (request) => {
        if (request.table !== 'flows') return f.options.lookupDatasetImpl(request);
        if (mode === 'failure') throw new Error('Metadata unavailable');
        return { exact: null, latest: null, exact_source_url: null, latest_source_url: null };
      },
    });
    assert.equal(report.status, 'blocked_remote_verification');
    assert.ok(
      report.blockers.some(
        (blocker) => blocker.code === (mode === 'failure' ? 'lookup_failed' : 'missing_dataset'),
      ),
    );
    assert.ok(!f.calls.some((call) => call.startsWith('payload:')));
  }
});

test('control-file or consumer drift during verification prevents publication of a passing report', async (t) => {
  for (const mode of ['intent', 'review', 'consumer'] as const) {
    const f = fixture(t);
    await assert.rejects(
      runDatasetRemoteVerify({
        ...f.options,
        lookupDatasetImpl: async (request) => {
          const result = await f.options.lookupDatasetImpl(request);
          if (mode === 'intent') fs.appendFileSync(f.intentFile, ' ');
          else if (mode === 'review') fs.appendFileSync(f.reviewFile, ' ');
          else {
            const row = consumer();
            Object.assign(row.processDataSet.processInformation, { changed: true });
            fs.writeFileSync(f.options.inputPath, JSON.stringify([row]));
          }
          return result;
        },
      }),
      { code: 'DATASET_REFERENCE_INTENT_INVALID' },
    );
    assert.equal(fs.existsSync(f.options.outDir), false);
  }
});

test('own draft pins reuse one exact latest payload and reject foreign-owner readback', async (t) => {
  for (const foreign of [false, true]) {
    const f = fixture(t);
    const selected = { ...f.intent.references[0].selected, user_id: actor, state_code: 0 };
    f.intent.references[0].selected = selected;
    editReview(f, (review) => {
      review.selected = selected;
      review.latest = { ...selected };
    });
    const report = await runDatasetRemoteVerify({
      ...f.options,
      lookupDatasetImpl: async (request) =>
        request.table === 'flows'
          ? {
              exact: { id: identifier(1), version },
              latest: { id: identifier(1), version },
              exact_source_url: null,
              latest_source_url: null,
            }
          : f.options.lookupDatasetImpl(request),
      lookupReferencePayloadImpl: async (request) => {
        f.calls.push(`payload:${request.version}`);
        return {
          id: identifier(1),
          version,
          payload: flow(version),
          user_id: foreign ? owner : actor,
          state_code: 0,
          modified_at: null,
          source_url: null,
        };
      },
    });
    assert.equal(
      report.status,
      foreign ? 'blocked_remote_verification' : 'passed_remote_verification',
    );
    assert.equal(f.calls.filter((call) => call.startsWith('payload:')).length, 1);
    assert.equal(checks(report).filter((check) => check.role === 'reference').length, 1);
  }
});

test('multiple consumers share exact payload observations and deduplicated review evidence', async (t) => {
  const f = fixture(t),
    first = consumer(),
    second = consumer();
  second.processDataSet.processInformation.dataSetInformation['common:UUID'] = identifier(3);
  fs.writeFileSync(f.options.inputPath, JSON.stringify([first, second]));
  f.intent.consumers.push({
    row_index: 1,
    table: 'processes',
    id: identifier(3),
    version,
    payload_sha256: sha(second),
  });
  f.intent.references.push({ ...structuredClone(f.intent.references[0]), row_index: 1 });
  saveIntent(f);
  const report = await runDatasetRemoteVerify(f.options);
  assert.equal(report.status, 'passed_remote_verification');
  assert.equal(report.reference_intent!.review_files.length, 1);
  assert.equal(report.reference_intent!.references.length, 2);
  assert.equal(f.calls.filter((call) => call.startsWith('payload:')).length, 2);
  const selected = checks(report).filter((check) => check.role === 'reference');
  assert.equal(selected.length, 2);
  assert.ok(
    selected.every(
      (check) =>
        check.reference_intent?.applied &&
        check.reference_intent.original_status === 'version_outdated' &&
        check.latest_version === newer,
    ),
  );
});

test('undeclared older references and missing roots retain their default blockers', async (t) => {
  const f = fixture(t),
    row = consumer();
  row.processDataSet.exchanges.exchange.push({
    referenceToFlowDataSet: {
      '@type': 'flow data set',
      '@refObjectId': identifier(4),
      '@version': version,
    },
  });
  fs.writeFileSync(f.options.inputPath, JSON.stringify([row]));
  f.intent.consumers[0].payload_sha256 = sha(row);
  saveIntent(f);
  const report = await runDatasetRemoteVerify({ ...f.options, rootPolicy: 'existing' });
  assert.equal(report.status, 'blocked_remote_verification');
  assert.ok(report.blockers.some((blocker) => blocker.role === 'root'));
  assert.ok(
    report.blockers.some(
      (blocker) => blocker.id === identifier(4) && blocker.code === 'version_outdated',
    ),
  );
  assert.equal(f.calls.filter((call) => call.startsWith('payload:')).length, 2);
});

test('consumer wrapper identity conflicts reject even when the supplied payload hash is unchanged', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.options.inputPath,
    JSON.stringify([{ id: identifier(99), version, process: consumer() }]),
  );
  f.intent.consumers[0].id = identifier(99);
  saveIntent(f);
  await assert.rejects(runDatasetRemoteVerify(f.options), {
    code: 'DATASET_REFERENCE_INTENT_INVALID',
  });
  assert.deepEqual(f.calls, []);
});

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(value),
  };
}

test('default identity and RLS adapters read current latest content with authenticated GETs only', async (t) => {
  const f = fixture(t),
    calls: URL[] = [];
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
    TIANGONG_LCA_ACCESS_TOKEN: 'exact-reference-test-token',
  });
  const report = await runDatasetRemoteVerify({
    ...f.options,
    env,
    resolveReferenceIdentityImpl: undefined,
    lookupDatasetImpl: undefined,
    lookupReferencePayloadImpl: undefined,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
      if (url.pathname === '/auth/v1/user')
        return makeSupabaseAuthResponse({
          userId: actor,
          email: 'reader@example.invalid',
          accessToken: 'exact-reference-test-token',
        });
      if (url.pathname.endsWith('/processes')) return jsonResponse([]);
      assert.ok(url.pathname.endsWith('/flows'), url.pathname);
      const requested = url.searchParams.get('version')?.slice(3) ?? newer;
      if (url.searchParams.get('select') === 'id,version')
        return jsonResponse([{ id: identifier(1), version: requested }]);
      return jsonResponse([
        {
          id: identifier(1),
          version: requested,
          user_id: owner,
          state_code: 100,
          modified_at: null,
          json: flow(requested),
        },
      ]);
    },
  });
  assert.equal(report.status, 'passed_remote_verification');
  assert.ok(calls.some((url) => url.pathname === '/auth/v1/user'));
  const payloadCalls = calls.filter((url) =>
    url.searchParams.get('select')?.includes('json_ordered'),
  );
  assert.equal(payloadCalls.length, 2);
  assert.ok(
    payloadCalls.some(
      (url) =>
        url.searchParams.get('order') === 'version.desc' &&
        url.searchParams.get('limit') === '1' &&
        !url.searchParams.has('version'),
    ),
  );
  assert.ok(payloadCalls.some((url) => url.searchParams.get('version') === `eq.${version}`));
  assert.ok(!JSON.stringify(report).includes('exact-reference-test-token'));
});

test('nonregular, malformed UTF-8/JSON and oversized selected files are rejected without network', async (t) => {
  for (const mode of ['directory', 'oversized', 'json', 'utf8', 'array', 'null'] as const) {
    const f = fixture(t);
    if (mode === 'directory') {
      fs.unlinkSync(f.intentFile);
      fs.mkdirSync(f.intentFile);
    } else if (mode === 'oversized') fs.truncateSync(f.intentFile, 8 * 1024 * 1024 + 1);
    else if (mode === 'utf8') fs.writeFileSync(f.intentFile, Buffer.from([0xff]));
    else fs.writeFileSync(f.intentFile, mode === 'json' ? '{' : mode === 'array' ? '[]' : 'null');
    await assert.rejects(runDatasetRemoteVerify(f.options), {
      code: 'DATASET_REFERENCE_INTENT_INVALID',
    });
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.options.outDir), false);
  }
});

test('missing payload runtime or invalid payload identities cannot stand in for exact observed content', async (t) => {
  for (const mode of ['no-runtime', 'null-payload', 'wrong-payload-id'] as const) {
    const f = fixture(t);
    const report = await runDatasetRemoteVerify({
      ...f.options,
      lookupReferencePayloadImpl:
        mode === 'no-runtime'
          ? undefined
          : async (request) => {
              const row = await f.options.lookupReferencePayloadImpl(request);
              if (mode === 'null-payload') return { ...row, payload: null };
              row.payload.flowDataSet.flowInformation.dataSetInformation['common:UUID'] =
                identifier(99);
              return row;
            },
    });
    assert.equal(report.status, 'blocked_remote_verification');
    assert.ok(report.blockers.some((blocker) => blocker.code === 'reference_intent_mismatch'));
  }
});

test('memory-provided consumer rows remain bound through verification', async (t) => {
  const f = fixture(t);
  assert.equal(
    (await runDatasetRemoteVerify({ ...f.options, rawInput: [consumer()] })).status,
    'passed_remote_verification',
  );
});
