import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/lib/errors.js';
import {
  STUDY_CODEC_CANDIDATE_ENV,
  STUDY_CODEC_MANIFEST_SHA256,
  STUDY_V3_CODEC_CANDIDATE_ENV,
  STUDY_V3_CODEC_MANIFEST_SHA256,
  loadStudyCodec,
} from '../src/lib/study-codec.js';
import { readStudyIntent } from '../src/lib/study-intent.js';
import { runStudyRequest } from '../src/lib/study-transport.js';
import { STUDY_REPORT_SCHEMA, studyObject } from '../src/lib/study-protocol.js';
import type { FetchLike } from '../src/lib/http.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const RUN_A = '22222222-2222-4222-8222-222222222222';
const RUN_B = '33333333-3333-4333-8333-333333333333';
const STUDY = '44444444-4444-4444-8444-444444444444';
const ANALYSIS = '55555555-5555-4555-8555-555555555555';
const PROFILE = 'lca.study-analysis-explicit-v1';
const TEMPLATE = 'lca.study-report.v1';
const roots: string[] = [];
function root() {
  const value = mkdtempSync(path.join(os.tmpdir(), 'cli-study-v3-'));
  roots.push(value);
  return value;
}
test.after(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});
function environment(): NodeJS.ProcessEnv {
  return {
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: ACTOR })).toString('base64url')}.synthetic-signature`,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    [STUDY_CODEC_CANDIDATE_ENV]: STUDY_CODEC_MANIFEST_SHA256,
    [STUDY_V3_CODEC_CANDIDATE_ENV]: STUDY_V3_CODEC_MANIFEST_SHA256,
  };
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function fixture(options: { lost?: boolean; profile?: boolean; template?: boolean } = {}) {
  const requests: Record<string, unknown>[] = [];
  let lost = options.lost ?? false;
  const replies = new Map<string, unknown>();
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/auth/v1/user'))
      return json({ id: ACTOR, email: 'reporting-fixture@example.test', role: 'authenticated' });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(new Headers(init?.headers).get('x-study-schema'), request.schemaVersion);
    requests.push(request);
    assert.equal(request.schemaVersion, STUDY_REPORT_SCHEMA);
    const envelope = (data: unknown) =>
      json({ schemaVersion: STUDY_REPORT_SCHEMA, requestId: request.requestId, ok: true, data });
    if (request.operation === 'capability.read')
      return envelope({
        type: 'capabilities',
        contractVersion: '3.0.0',
        runtimeEnabled: true,
        operations: [
          'capability.read',
          'analysis.request',
          'analysis.read',
          'report.create',
          'report.save',
          'report.freeze',
          'report.read',
          'task.read',
          'task.cancel',
          'study.resources.list',
        ],
        analysisProfiles: options.profile === false ? [] : [PROFILE],
        reportTemplates: options.template === false ? [] : [TEMPLATE],
      });
    if (request.operation === 'analysis.request') {
      const key = String(request.idempotencyKey);
      if (!replies.has(key))
        replies.set(key, {
          type: 'analysis',
          value: {
            analysisId: ANALYSIS,
            studyId: STUDY,
            profileId: PROFILE,
            config: request.config,
            configHash: request.configHash,
            execution: { jobId: 'analysis-job', status: 'queued' },
            comparability: { status: 'not_assessed', reasonCodes: [] },
            factsRef: null,
          },
        });
      if (lost) {
        lost = false;
        throw new Error('lost reporting response');
      }
      return envelope(replies.get(key));
    }
    if (request.operation === 'task.read')
      return envelope({
        type: 'task',
        value: {
          studyId: STUDY,
          resource: request.resource,
          execution: { jobId: 'analysis-job', status: 'completed', phase: 'complete', progress: 1 },
          errorCode: null,
        },
      });
    if (request.operation === 'report.create')
      return envelope({ type: 'reportRevision', value: reportRecord(request) });
    return envelope({
      type: 'resourcePage',
      studyId: STUDY,
      kind: 'analysis',
      items: [],
      nextCursor: null,
    });
  };
  return { fetchImpl, requests, replies };
}
const artifact = {
  type: 'analysisFacts',
  id: 'facts-1',
  contentHash: 'a'.repeat(64),
  byteSize: 128,
  digestScope: 'artifact_bytes_sha256',
  mediaType: 'application/json',
  schemaVersion: 'lca.study-analysis-facts.v1',
};
function reportRecord(request: Record<string, unknown>) {
  return {
    reportRevisionId: 'report-1',
    studyId: STUDY,
    parentReportRevisionId: null,
    authorId: ACTOR,
    revision: 1,
    status: 'draft',
    contentHash: 'b'.repeat(64),
    runIds: request.runIds,
    analysisIds: request.analysisIds,
    factsRefs: [artifact],
    contentRef: {
      ...artifact,
      type: 'reportContent',
      id: 'content-1',
      schemaVersion: 'lca.study-report-draft.v1',
    },
    templateId: TEMPLATE,
    finalization: {
      status: 'not_finalized',
      profileId: 'unreviewed',
      reviewRequirement: 'none',
      finalizedAt: null,
      reviewIds: [],
    },
    validitySnapshot: { status: 'current', checkedAt: '2026-11-03T00:00:00Z', reasonCodes: [] },
  };
}
function analysisInput() {
  return {
    studyId: STUDY,
    profileId: PROFILE,
    config: {
      schemaVersion: 'lca.study-analysis-config.v1',
      kind: 'comparison',
      runIds: [RUN_A, RUN_B],
    },
  };
}
const content = {
  schemaVersion: 'lca.study-report-draft.v1',
  title: 'Unreviewed fixture',
  claims: [
    {
      claimId: 'claim-1',
      bundleRef: artifact,
      factId: 'fact-zero',
      canonicalValue: '0',
      unit: 'kg CO2 eq',
      display: { style: 'exact' },
    },
  ],
  sections: [],
  tables: [],
  charts: [],
  additionalLimitations: ['Synthetic HTTP consumer evidence only.'],
};

test('v3 analysis derives its config identity only through the owner codec and preserves exact recovery', async () => {
  const remote = fixture({ lost: true });
  const stateDir = root();
  const settings = {
    env: environment(),
    fetchImpl: remote.fetchImpl,
    stateDir,
    apiVersion: 'v3' as const,
  };
  let intentFile = '';
  await assert.rejects(
    runStudyRequest('analysis.request', analysisInput(), settings),
    (error: unknown) => {
      assert(error instanceof CliError && studyObject(error.details));
      intentFile = String(error.details.intentFile);
      return error.code === 'STUDY_TRANSPORT_UNKNOWN';
    },
  );
  const saved = readStudyIntent(intentFile);
  assert.equal(saved.request.schemaVersion, STUDY_REPORT_SCHEMA);
  assert(intentFile.includes(`${path.sep}v3${path.sep}`));
  const codec = await loadStudyCodec(environment(), 'v3');
  assert.equal(saved.request.configHash, await codec.analysisConfigHash!(analysisInput().config));
  const recovered = await runStudyRequest(saved.request.operation, saved.request, {
    ...settings,
    apiVersion: undefined,
    recoverFile: intentFile,
  });
  assert.equal(recovered.apiSchema, STUDY_REPORT_SCHEMA);
  assert.equal(recovered.data.type, 'analysis');
  assert.equal(remote.replies.size, 1);
  const writes = remote.requests.filter((request) => request.operation === 'analysis.request');
  assert.deepEqual(writes[0], writes[1]);
  await assert.rejects(
    runStudyRequest(saved.request.operation, saved.request, {
      ...settings,
      apiVersion: 'v2',
      recoverFile: intentFile,
    }),
    (error: unknown) =>
      error instanceof CliError && error.code === 'STUDY_RECOVERY_BINDING_MISMATCH',
  );
});

test('v3 rejects a supplied conflicting config hash and does not downgrade to core v2', async () => {
  const remote = fixture();
  await assert.rejects(
    runStudyRequest(
      'analysis.request',
      { ...analysisInput(), configHash: '0'.repeat(64) },
      { env: environment(), fetchImpl: remote.fetchImpl, apiVersion: 'v3' },
    ),
    (error: unknown) => error instanceof CliError && error.code === 'REFERENCE_MISMATCH',
  );
  await assert.rejects(
    runStudyRequest('analysis.request', analysisInput(), {
      env: environment(),
      fetchImpl: remote.fetchImpl,
      apiVersion: 'v2',
    }),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_REQUEST_INVALID',
  );
  assert.equal(remote.requests.length, 0);
});

test('v3 profile/template capability discovery is independent from v2 and never invents content references', async () => {
  const denied = fixture({ profile: false });
  await assert.rejects(
    runStudyRequest('analysis.request', analysisInput(), {
      env: environment(),
      fetchImpl: denied.fetchImpl,
      apiVersion: 'v3',
    }),
    (error: unknown) => error instanceof CliError && error.code === 'CAPABILITY_UNAVAILABLE',
  );
  const remote = fixture();
  const stateDir = root();
  const request = {
    studyId: STUDY,
    parentReportRevisionId: null,
    runIds: [RUN_A, RUN_B],
    analysisIds: [ANALYSIS],
    content,
    templateId: TEMPLATE,
  };
  const report = await runStudyRequest('report.create', request, {
    env: environment(),
    fetchImpl: remote.fetchImpl,
    stateDir,
    apiVersion: 'v3',
  });
  assert.equal(report.data.type, 'reportRevision');
  assert(report.intentFile);
  assert.deepEqual(readStudyIntent(report.intentFile).request.content, content);
  assert.equal((report.data.value as Record<string, unknown>).status, 'draft');
  const noTemplate = fixture({ template: false });
  await assert.rejects(
    runStudyRequest('report.create', request, {
      env: environment(),
      fetchImpl: noTemplate.fetchImpl,
      apiVersion: 'v3',
    }),
    (error: unknown) => error instanceof CliError && error.code === 'CAPABILITY_UNAVAILABLE',
  );
});

test('Public v3 command groups and independent capability selection preserve the selected wire', async () => {
  const remote = fixture();
  const stateDir = root();
  const file = path.join(stateDir, 'analysis.json');
  writeFileSync(file, JSON.stringify(analysisInput()));
  const deps = {
    env: environment(),
    fetchImpl: remote.fetchImpl,
    dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
  };
  const result = await executeCli(
    ['study', 'analysis', 'request', '--input', file, '--state-dir', stateDir, '--json'],
    deps,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).apiSchema, STUDY_REPORT_SCHEMA);
  const caps = await executeCli(['study', 'capabilities', '--api-version', '3', '--json'], deps);
  assert.equal(caps.exitCode, 0, caps.stderr);
  assert.equal(JSON.parse(caps.stdout).data.contractVersion, '3.0.0');
  const task = path.join(stateDir, 'task.json');
  writeFileSync(
    task,
    JSON.stringify({ studyId: STUDY, resource: { type: 'analysis', id: ANALYSIS } }),
  );
  const waited = await executeCli(
    ['study', 'analysis', 'task', 'wait', '--input', task, '--wait-ms', '0', '--json'],
    deps,
  );
  assert.equal(waited.exitCode, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).waiting, false);
  for (const args of [
    ['study', 'analysis', 'get', '--api-version', '2'],
    ['study', 'get', '--api-version', '3'],
    ['study', 'capabilities', '--api-version', '4'],
  ]) {
    const invalid = await executeCli(args, deps);
    assert.notEqual(invalid.exitCode, 0);
  }
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(analysisInput()));
});

test('v3 schema negotiation preserves pre-body authentication errors without silent fallback', async () => {
  let domainCalls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/auth/v1/user'))
      return json({ id: ACTOR, email: 'reporting-fixture@example.test', role: 'authenticated' });
    domainCalls++;
    assert.equal(new Headers(init?.headers).get('x-study-schema'), STUDY_REPORT_SCHEMA);
    const request = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        schemaVersion: STUDY_REPORT_SCHEMA,
        requestId: request.requestId,
        ok: false,
        code: 'AUTH_REQUIRED',
        message: 'safe generic error',
        retryable: false,
        issues: [],
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  };
  await assert.rejects(
    runStudyRequest(
      'capability.read',
      {},
      {
        env: environment(),
        fetchImpl,
        apiVersion: 'v3',
      },
    ),
    (error: unknown) => error instanceof CliError && error.code === 'AUTH_REQUIRED',
  );
  assert.equal(domainCalls, 1);
});
