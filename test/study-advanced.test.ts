import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import {
  loadStudyCodec,
  assertStudyCodecModule,
  admitStudyCodecCandidate,
  STUDY_V5_CODEC_CANDIDATE_ENV,
  STUDY_V5_CODEC_MANIFEST_SHA256,
} from '../src/lib/study/codec.js';
import { runStudyRequest, verifyStudyArtifact } from '../src/lib/study/transport.js';
import { readStudyIntent } from '../src/lib/study/intent.js';
import { STUDY_ADVANCED_SCHEMA, studyObject, studyDigest } from '../src/lib/study/protocol.js';
import type { FetchLike } from '../src/lib/transport/http.js';
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1),
  STUDY = id(2),
  RUN = id(3),
  ANALYSIS = id(4),
  JOB = id(5),
  HASH = 'a'.repeat(64),
  STAMP = '2026-11-04T00:00:00Z';
const PROFILE = 'lca.study-sensitivity-oat.v1';
const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(path.join(os.tmpdir(), 'cli-study-v5-'));
  roots.push(r);
  return r;
};
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const env = () => ({
  TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'advanced-fixture-public-key',
  TIANGONG_LCA_AUTH_MODE: 'access-token',
  TIANGONG_LCA_ACCESS_TOKEN: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: ACTOR })).toString('base64url')}.synthetic-signature`,
  TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
});
const invoke = (args: string[], fetchImpl: FetchLike, environment: NodeJS.ProcessEnv) =>
  executeCli(args, {
    fetchImpl,
    env: environment,
    dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
  });
const config = () => ({
  schemaVersion: 'lca.study-analysis-config.v2',
  kind: 'sensitivityOat',
  baselineRunId: RUN,
  parameters: [
    {
      path: '/instances/a/exchanges/e/amount',
      unit: 'kg',
      baselineAmount: '1.0000000000000001e18',
      low: '0',
      high: '1.0000000000000001e18',
    },
  ],
});
const inputFile = (r: string, n: string, value: unknown) => {
  const f = path.join(r, n);
  writeFileSync(f, JSON.stringify(value));
  return f;
};
function fixture(
  options: { lost?: boolean; caps?: Record<string, unknown>; actor?: string; deny?: boolean } = {},
) {
  const requests: Record<string, unknown>[] = [];
  let lost = options.lost ?? false;
  const responses = new Map<string, unknown>();
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/auth/v1/user'))
      return json({ id: ACTOR, email: 'advanced-fixture@example.test', role: 'authenticated' });
    const r = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(r);
    assert.equal(r.schemaVersion, STUDY_ADVANCED_SCHEMA);
    assert.equal(new Headers(init?.headers).get('x-study-schema'), STUDY_ADVANCED_SCHEMA);
    const reply = (data: unknown) =>
      json({ schemaVersion: STUDY_ADVANCED_SCHEMA, requestId: r.requestId, ok: true, data });
    if (r.operation === 'capability.read')
      return reply(
        options.caps ?? {
          type: 'capabilities',
          contractVersion: '5.0.0',
          runtimeEnabled: true,
          operations: [
            'capability.read',
            'analysis.request',
            'analysis.read',
            'analysis.parameters.read',
            'report.create',
            'report.save',
            'report.freeze',
            'report.read',
            'comment.append',
            'report.finalize',
          ],
          analysisProfiles: [PROFILE, 'lca.study-uncertainty-bounded.v1'],
          reportTemplates: ['lca.study-report.v2'],
          finalizationProfiles: [
            'lca.study-report-unreviewed.v1',
            'lca.study-report-internal-review.v1',
          ],
          reviewClasses: ['internal'],
          disclosurePolicies: ['lca.study-report-summary-share.v1'],
        },
      );
    if (options.deny)
      return json(
        {
          schemaVersion: STUDY_ADVANCED_SCHEMA,
          requestId: r.requestId,
          ok: false,
          code: 'FORBIDDEN',
          message: 'Request denied.',
          retryable: false,
          issues: [],
        },
        403,
      );
    if (r.operation === 'analysis.request' || r.operation === 'analysis.read') {
      const key = String(r.idempotencyKey);
      if (!responses.has(key))
        responses.set(key, {
          type: 'analysis',
          value: {
            analysisId: ANALYSIS,
            studyId: STUDY,
            profileId: PROFILE,
            config: r.config ?? config(),
            configHash: r.configHash ?? HASH,
            execution: { jobId: JOB, status: 'queued' },
            factsRef: null,
          },
        });
      if (lost && r.operation === 'analysis.request') {
        lost = false;
        throw new Error('lost synthetic reply');
      }
      return reply(responses.get(key));
    }
    if (r.operation === 'analysis.parameters.read')
      return reply({
        type: 'parameterCatalog',
        studyId: STUDY,
        baselineRunId: RUN,
        inputHash: HASH,
        preparedArtifactRef: {
          type: 'modelInput',
          id: id(10),
          contentHash: HASH,
          digestScope: 'artifact_bytes_sha256',
          byteSize: 1,
          mediaType: 'application/json',
          schemaVersion: 'lca.study-prepared-input.v1',
        },
        parameters: [
          {
            path: '/instances/a/exchanges/e/amount',
            flow: { id: 'flow', version: '01.00.000' },
            direction: 'Output',
            unit: 'kg',
            support: [],
            baselineAmount: '1.0000000000000001e18',
          },
        ],
      });
    if (r.operation === 'comment.append')
      return reply({
        type: 'comment',
        value: {
          commentId: id(20),
          studyId: STUDY,
          reportRevisionId: id(6),
          reportContentHash: HASH,
          actorId: options.actor ?? ACTOR,
          clientId: null,
          text: r.text,
          createdAt: STAMP,
        },
      });
    throw new Error('unhandled synthetic V5 operation');
  };
  return { fetchImpl, requests };
}

test('V5 codec and candidate ABI remain contained and independently pinned', async () => {
  const codec = await loadStudyCodec({}, 'v5');
  assert.equal(codec.API_SCHEMA, STUDY_ADVANCED_SCHEMA);
  assert.equal(typeof codec.analysisConfigHash, 'function');
  assert.equal(typeof codec.verifyVersionedExport, 'function');
  assert.equal(codec.operationMetadata['analysis.parameters.read'].kind, 'query');
  assert.equal(assertStudyCodecModule(codec, 'v5'), codec);
  for (const name of ['analysisConfigHash', 'verifyVersionedExport'])
    assert.throws(
      () => assertStudyCodecModule({ ...codec, [name]: null }, 'v5'),
      (e: unknown) => e instanceof CliError && e.code === 'STUDY_CONTRACT_INVALID',
    );
  const candidate = { sourceStatus: 'worktree' };
  assert.throws(
    () => admitStudyCodecCandidate(candidate, {}, STUDY_V5_CODEC_MANIFEST_SHA256, 'v5'),
    CliError,
  );
  admitStudyCodecCandidate(
    candidate,
    {
      TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:1234',
      [STUDY_V5_CODEC_CANDIDATE_ENV]: STUDY_V5_CODEC_MANIFEST_SHA256,
    },
    STUDY_V5_CODEC_MANIFEST_SHA256,
    'v5',
  );
});

test('V5 analysis retains owner scientific strings, computes only the owner config hash and journals exact requests', async () => {
  const r = root(),
    f = fixture();
  const input = {
    studyId: STUDY,
    profileId: PROFILE,
    config: config(),
    idempotencyKey: 'v5-first',
  };
  const result = await runStudyRequest('analysis.request', input, {
    env: env(),
    fetchImpl: f.fetchImpl,
    apiVersion: 'v5',
    stateDir: r,
  });
  assert.equal(result.apiSchema, STUDY_ADVANCED_SCHEMA);
  assert(result.intentFile?.includes(`${path.sep}v5${path.sep}`));
  assert(result.intentFile);
  const intent = readStudyIntent(result.intentFile);
  assert.equal(intent.request.schemaVersion, STUDY_ADVANCED_SCHEMA);
  assert.deepEqual(intent.request.config, config());
  const codec = await loadStudyCodec({}, 'v5');
  assert.equal(intent.request.configHash, await codec.analysisConfigHash(config()));
  assert.equal(f.requests.filter((q) => q.operation === 'analysis.request').length, 1);
  const before = f.requests.length;
  await assert.rejects(
    () =>
      runStudyRequest(
        'analysis.request',
        { ...input, idempotencyKey: 'bad-hash', configHash: 'b'.repeat(64) },
        { env: env(), fetchImpl: f.fetchImpl, apiVersion: 'v5', stateDir: r },
      ),
    (e: unknown) => e instanceof CliError && e.code === 'REFERENCE_MISMATCH',
  );
  assert.equal(f.requests.length, before);
});

test('V5 unknown analysis outcome recovers the same retained version, key and configuration', async () => {
  const r = root(),
    f = fixture({ lost: true }),
    p = inputFile(r, 'request.json', {
      studyId: STUDY,
      profileId: PROFILE,
      config: config(),
      idempotencyKey: 'unknown-v5',
    });
  const failed = await invoke(
    [
      'study',
      'analysis',
      'request',
      '--api-version',
      '5',
      '--input',
      p,
      '--state-dir',
      r,
      '--json',
    ],
    f.fetchImpl,
    env(),
  );
  assert.equal(failed.exitCode, 1);
  const body = JSON.parse(failed.stderr) as { error: { details: { intentFile: string } } };
  const file = body.error.details.intentFile;
  assert(file);
  const original = readFileSync(file);
  const recovered = await invoke(
    ['study', 'request', 'recover', '--intent-file', file, '--json'],
    f.fetchImpl,
    env(),
  );
  assert.equal(recovered.exitCode, 0);
  assert.equal(readFileSync(file).equals(original), true);
  const mutations = f.requests.filter((q) => q.operation === 'analysis.request');
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0], mutations[1]);
});

test('V5 parameter catalog command is explicit while old defaults and unsupported Study roles remain separated', async () => {
  const r = root(),
    f = fixture(),
    p = inputFile(r, 'catalog.json', { studyId: STUDY, baselineRunId: RUN });
  const value = await invoke(
    ['study', 'analysis', 'parameters', '--input', p, '--json'],
    f.fetchImpl,
    env(),
  );
  assert.equal(value.exitCode, 0);
  const b = JSON.parse(value.stdout) as { data: { parameters: Array<{ baselineAmount: string }> } };
  assert.equal(b.data.parameters[0].baselineAmount, '1.0000000000000001e18');
  for (const flag of ['2', '3', '4']) {
    const denied = await invoke(
      ['study', 'analysis', 'parameters', '--api-version', flag, '--input', p, '--json'],
      f.fetchImpl,
      env(),
    );
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stderr, /UNSUPPORTED_SCHEMA/u);
  }
  for (const args of [['member', 'set'], ['create']]) {
    const denied = await invoke(
      ['study', ...args, '--api-version', '5', '--input', p, '--json'],
      f.fetchImpl,
      env(),
    );
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stderr, /UNSUPPORTED_SCHEMA/u);
  }
  const help = await invoke(['study', '--help'], f.fetchImpl, env());
  assert.match(help.stdout, /--api-version 5/u);
});

test('V5 historical reads survive explicit admission rollback and recheck authorization', async () => {
  const caps = {
    type: 'capabilities',
    contractVersion: '5.0.0',
    runtimeEnabled: false,
    operations: ['capability.read', 'analysis.read', 'analysis.parameters.read'],
    analysisProfiles: [],
    reportTemplates: [],
    finalizationProfiles: [],
    reviewClasses: [],
    disclosurePolicies: [],
  };
  const f = fixture({ caps });
  const q = { studyId: STUDY, baselineRunId: RUN };
  assert.equal(
    (
      await runStudyRequest('analysis.parameters.read', q, {
        env: env(),
        fetchImpl: f.fetchImpl,
        apiVersion: 'v5',
      })
    ).data.type,
    'parameterCatalog',
  );
  await assert.rejects(
    () =>
      runStudyRequest(
        'analysis.request',
        { studyId: STUDY, profileId: PROFILE, config: config() },
        { env: env(), fetchImpl: f.fetchImpl, apiVersion: 'v5', stateDir: root() },
      ),
    (e: unknown) => e instanceof CliError && e.code === 'CAPABILITY_UNAVAILABLE',
  );
  const denied = fixture({ caps, deny: true });
  await assert.rejects(
    () =>
      runStudyRequest('analysis.parameters.read', q, {
        env: env(),
        fetchImpl: denied.fetchImpl,
        apiVersion: 'v5',
      }),
    (e: unknown) => e instanceof CliError && e.code === 'FORBIDDEN',
  );
});

test('V5 analysis profile and review actor capability boundaries remain owner controlled', async () => {
  const codec = await loadStudyCodec({}, 'v5');
  const caps = {
    type: 'capabilities',
    contractVersion: '5.0.0',
    runtimeEnabled: true,
    operations: ['capability.read', 'analysis.request', 'comment.append'],
    analysisProfiles: [],
    reportTemplates: [],
    finalizationProfiles: [],
    reviewClasses: [],
    disclosurePolicies: [],
  };
  const f = fixture({ caps });
  await assert.rejects(
    () =>
      runStudyRequest(
        'analysis.request',
        { studyId: STUDY, profileId: PROFILE, config: config() },
        { env: env(), fetchImpl: f.fetchImpl, apiVersion: 'v5', stateDir: root() },
      ),
    CliError,
  );
  assert.equal(
    f.requests.some((q) => q.operation === 'analysis.request'),
    false,
  );
  const comment = {
    reportRevisionId: id(6),
    expectedContentHash: HASH,
    text: 'A bounded comment.',
  };
  const valid = fixture();
  const out = await runStudyRequest('comment.append', comment, {
    env: env(),
    fetchImpl: valid.fetchImpl,
    apiVersion: 'v5',
    stateDir: root(),
  });
  assert.equal(out.data.type, 'comment');
  const wrong = fixture({ actor: id(99) });
  await assert.rejects(
    () =>
      runStudyRequest('comment.append', comment, {
        env: env(),
        fetchImpl: wrong.fetchImpl,
        apiVersion: 'v5',
        stateDir: root(),
      }),
    (e: unknown) => e instanceof CliError && e.code === 'STUDY_RESPONSE_ACTOR_BINDING',
  );
  assert(studyObject(codec));
});

test('V5 raw artifacts cannot substitute a signed bundle for an allowed facts or content read', () => {
  const bytes = Buffer.from('owner-artifact'),
    ref = {
      type: 'analysisFacts',
      id: id(80),
      contentHash: studyDigest(bytes),
      digestScope: 'artifact_bytes_sha256',
      byteSize: bytes.length,
      mediaType: 'application/json',
      schemaVersion: 'lca.study-analysis-facts.v2',
    };
  const q = {
    schemaVersion: STUDY_ADVANCED_SCHEMA,
    requestId: 'artifact',
    operation: 'artifact.read',
    studyId: STUDY,
    artifactRef: ref,
  };
  const d = {
    studyId: STUDY,
    artifactRef: ref,
    encoding: 'base64',
    bytes: bytes.toString('base64'),
  };
  assert.equal(verifyStudyArtifact(q, d, []).bytes.equals(bytes), true);
  const bundle = {
    ...ref,
    type: 'reportExportBundle',
    schemaVersion: 'lca.study-export-bundle.v3',
  };
  assert.throws(
    () => verifyStudyArtifact({ ...q, artifactRef: bundle }, { ...d, artifactRef: bundle }, []),
    (e: unknown) => e instanceof CliError && e.code === 'DISCLOSURE_DENIED',
  );
});
