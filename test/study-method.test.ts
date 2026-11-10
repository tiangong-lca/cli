import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import {
  loadStudyCodec,
  assertStudyCodecModule,
  admitStudyCodecCandidate,
  STUDY_V6_CODEC_CANDIDATE_ENV,
  STUDY_V6_CODEC_MANIFEST_SHA256,
} from '../src/lib/study-codec.js';
import { runStudyRequest, verifyStudyArtifact } from '../src/lib/study-transport.js';
import { readStudyIntent } from '../src/lib/study-intent.js';
import {
  STUDY_METHOD_SCHEMA,
  STUDY_METHOD_COMMANDS,
  studyDigest,
  studyJson,
  parseStudyResponse,
  prepareStudyRequest,
} from '../src/lib/study-protocol.js';
import { studyRendererRoot } from '../src/lib/study-renderer.js';
import type { FetchLike } from '../src/lib/http.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(9),
  STUDY = id(1),
  ASSESSMENT = id(104),
  JOB = id(5),
  HASH = 'a'.repeat(64),
  STAMP = '2026-11-04T00:00:00Z';
const PROFILE = 'lca.study-method-pef-2021-ef31-cement-intermediate.v1';
const component = JSON.parse(
  readFileSync(
    path.join(studyRendererRoot(undefined, 'v3'), 'package/methodProtocol.fixture.json'),
    'utf8',
  ),
) as {
  summary: { config: Record<string, unknown> };
  sourceFactsRef: Record<string, unknown>;
  stored: { content: Record<string, unknown> };
};
const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(path.join(os.tmpdir(), 'cli-study-method-'));
  roots.push(r);
  return r;
};
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const environment = () => ({
  TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'method-fixture-public-key',
  TIANGONG_LCA_AUTH_MODE: 'access-token',
  TIANGONG_LCA_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ sub: ACTOR })).toString('base64url')}.synthetic`,
  TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
});
const invoke = (args: string[], fetchImpl: FetchLike) =>
  executeCli(args, {
    fetchImpl,
    env: environment(),
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
  });
const input = (value: unknown) => {
  const p = path.join(root(), 'request.json');
  writeFileSync(p, JSON.stringify(value));
  return p;
};
const evidence = () => ({
  schemaVersion: 'lca.study-method-evidence.v1',
  requirementId: 'PEF-01',
  declaredKind: 'sourceRecord',
  title: 'Bounded evidence 🧪',
  statement: 'Recorded statement; no professional approval.',
  citations: [],
});
const caps = () => ({
  type: 'capabilities',
  contractVersion: '6.0.0',
  runtimeEnabled: true,
  operations: [...new Set(Object.values(STUDY_METHOD_COMMANDS))],
  methodProfiles: [PROFILE],
  reportTemplates: ['lca.study-method-report.v1'],
  finalizationProfiles: ['lca.study-report-unreviewed.v1', 'lca.study-report-internal-review.v1'],
  reviewClasses: ['internal'],
  disclosurePolicies: ['lca.study-report-summary-share.v1'],
  limits: {
    maxEvidenceRefs: 128,
    maxSelectedFactorRecords: 8192,
    maxFactsBytes: 4194304,
    maxProjectionBytes: 2000000,
  },
});
function fixture(
  options: {
    lost?: boolean;
    deny?: boolean;
    caps?: Record<string, unknown>;
    change?: (data: Record<string, unknown>) => void;
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  let lost = options.lost ?? false;
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/auth/v1/user'))
      return json({ id: ACTOR, email: 'method@example.test', role: 'authenticated' });
    const r = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(r);
    assert.equal(r.schemaVersion, STUDY_METHOD_SCHEMA);
    assert.equal(new Headers(init?.headers).get('x-study-schema'), STUDY_METHOD_SCHEMA);
    const reply = (data: unknown) =>
      json({ schemaVersion: STUDY_METHOD_SCHEMA, requestId: r.requestId, ok: true, data });
    if (r.operation === 'capability.read') return reply(options.caps ?? caps());
    if (options.deny)
      return json(
        {
          schemaVersion: STUDY_METHOD_SCHEMA,
          requestId: r.requestId,
          ok: false,
          code: 'FORBIDDEN',
          message: 'Denied',
          retryable: false,
          issues: [],
        },
        403,
      );
    let data: Record<string, unknown>;
    if (r.operation === 'method.assessment.request' || r.operation === 'method.assessment.read')
      data = {
        type: 'methodAssessment',
        value: {
          assessmentId: ASSESSMENT,
          studyId: STUDY,
          profileId: PROFILE,
          config: r.config ?? component.summary.config,
          configHash: r.configHash ?? HASH,
          execution: { jobId: JOB, status: 'queued' },
          factsRef: null,
        },
      };
    else if (r.operation === 'method.evidence.create' || r.operation === 'method.evidence.read') {
      const content = r.content ?? evidence();
      const bytes = Buffer.from(studyJson(content));
      data = {
        type: 'methodEvidence',
        value: {
          schemaVersion: 'lca.study-method-evidence-record.v1',
          evidenceId: id(80),
          studyId: STUDY,
          requirementId: 'PEF-01',
          declaredKind: 'sourceRecord',
          artifactRef: {
            type: 'methodEvidence',
            id: id(81),
            contentHash: studyDigest(bytes),
            digestScope: 'artifact_bytes_sha256',
            byteSize: bytes.length,
            mediaType: 'application/json',
            schemaVersion: 'lca.study-method-evidence.v1',
          },
          recordedAt: STAMP,
          status: 'recorded_unverified',
        },
      };
    } else if (r.operation === 'report.create' || r.operation === 'report.save') {
      data = {
        type: 'reportRevision',
        value: {
          reportRevisionId: id(300),
          studyId: STUDY,
          parentReportRevisionId: null,
          authorId: ACTOR,
          revision:
            r.operation === 'report.create'
              ? 1
              : (r.target as { expectedRevision: number }).expectedRevision + 1,
          status: 'draft',
          contentHash: HASH,
          runIds: [id(10)],
          methodAssessmentIds: [ASSESSMENT],
          factsRefs: [component.sourceFactsRef],
          contentRef: {
            type: 'reportContent',
            id: id(82),
            contentHash: HASH,
            digestScope: 'artifact_bytes_sha256',
            byteSize: 1,
            mediaType: 'application/json',
            schemaVersion: 'lca.study-method-report-content.v1',
          },
          templateId: 'lca.study-method-report.v1',
          finalization: {
            status: 'not_finalized',
            profileId: 'lca.study-report-unreviewed.v1',
            reviewRequirement: 'none',
            finalizedAt: null,
            reviewIds: [],
          },
          validitySnapshot: { status: 'current', checkedAt: STAMP, reasonCodes: [] },
        },
      };
    } else if (r.operation === 'comment.append')
      data = {
        type: 'comment',
        value: {
          studyId: STUDY,
          reportRevisionId: id(300),
          reportContentHash: HASH,
          commentId: id(90),
          actorId: ACTOR,
          clientId: null,
          text: r.text,
          createdAt: STAMP,
        },
      };
    else if (r.operation === 'task.read' || r.operation === 'task.cancel')
      data = {
        type: 'task',
        value: {
          studyId: STUDY,
          resource: r.resource,
          execution: { jobId: JOB, status: 'completed', phase: 'complete', progress: 1 },
          errorCode: null,
        },
      };
    else throw new Error('unhandled method fixture operation');
    options.change?.(data);
    if (lost) {
      lost = false;
      throw new Error('lost reply');
    }
    return reply(data);
  };
  return { fetchImpl, requests };
}
const refuses = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof CliError && e.code === code);
test('V6 owner artifact ABI is pinned and every advertised operation has an explicit native command', async () => {
  const c = await loadStudyCodec({}, 'v6');
  assert.equal(c.API_SCHEMA, STUDY_METHOD_SCHEMA);
  assert.deepEqual(
    Object.keys(c.operationMetadata).sort(),
    [...new Set(Object.values(STUDY_METHOD_COMMANDS))].sort(),
  );
  assert.equal(assertStudyCodecModule(c, 'v6'), c);
  for (const name of [
    'methodConfigHash',
    'validateResponseContentForRequest',
    'verifyVersionedExport',
  ])
    assert.throws(() => assertStudyCodecModule({ ...c, [name]: null }, 'v6'), CliError);
  assert.throws(
    () =>
      admitStudyCodecCandidate(
        { sourceStatus: 'worktree' },
        {},
        STUDY_V6_CODEC_MANIFEST_SHA256,
        'v6',
      ),
    CliError,
  );
  admitStudyCodecCandidate(
    { sourceStatus: 'worktree' },
    {
      TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:1234',
      [STUDY_V6_CODEC_CANDIDATE_ENV]: STUDY_V6_CODEC_MANIFEST_SHA256,
    },
    STUDY_V6_CODEC_MANIFEST_SHA256,
    'v6',
  );
});
test('V6 assessment uses the owner configuration hash and preserves original intent through unknown recovery', async () => {
  const f = fixture({ lost: true }),
    r = root(),
    p = input({
      studyId: STUDY,
      profileId: PROFILE,
      config: component.summary.config,
      idempotencyKey: 'method-unknown',
    });
  const failed = await invoke(
    [
      'study',
      'method',
      'assessment',
      'request',
      '--api-version',
      '6',
      '--input',
      p,
      '--state-dir',
      r,
      '--json',
    ],
    f.fetchImpl,
  );
  assert.equal(failed.exitCode, 1, failed.stderr);
  const parsed = JSON.parse(failed.stderr) as { error: { details: { intentFile: string } } };
  const file = parsed.error.details.intentFile;
  assert(file.includes(`${path.sep}v6${path.sep}`));
  const bytes = readFileSync(file),
    intent = readStudyIntent(file);
  assert.equal(
    intent.request.configHash,
    await (await loadStudyCodec({}, 'v6')).methodConfigHash(component.summary.config),
  );
  const recovered = await invoke(
    ['study', 'request', 'recover', '--intent-file', file, '--json'],
    f.fetchImpl,
  );
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert(readFileSync(file).equals(bytes));
  const mutations = f.requests.filter((r) => r.operation === 'method.assessment.request');
  assert.deepEqual(mutations[0], mutations[1]);
  await refuses(
    runStudyRequest(
      'method.assessment.request',
      { studyId: STUDY, profileId: PROFILE, config: component.summary.config, configHash: HASH },
      { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: r },
    ),
    'REFERENCE_MISMATCH',
  );
  await refuses(
    runStudyRequest('method.assessment.request', intent.request, {
      env: environment(),
      fetchImpl: f.fetchImpl,
      apiVersion: 'v5',
      recoverFile: file,
    }),
    'STUDY_RECOVERY_BINDING_MISMATCH',
  );
});
test('V6 evidence registration retains recorded_unverified and strict Unicode/identity validation', async () => {
  const f = fixture();
  const out = await runStudyRequest(
    'method.evidence.create',
    { studyId: STUDY, content: evidence() },
    { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
  );
  assert.equal((out.data.value as Record<string, unknown>).status, 'recorded_unverified');
  const q = input({ evidenceId: id(80) });
  const get = await invoke(
    ['study', 'method', 'evidence', 'get', '--api-version', '6', '--input', q, '--json'],
    f.fetchImpl,
  );
  assert.equal(get.exitCode, 0, get.stderr);
  for (const title of ['\ud800', 'x'.repeat(257), '😀'.repeat(257)])
    await refuses(
      runStudyRequest(
        'method.evidence.create',
        { studyId: STUDY, content: { ...evidence(), title } },
        { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
      ),
      'INVALID_REQUEST',
    );
  const wrong = fixture({
    change: (d) => {
      (d.value as Record<string, unknown>).evidenceId = id(99);
    },
  });
  await refuses(
    runStudyRequest(
      'method.evidence.read',
      { evidenceId: id(80) },
      { env: environment(), fetchImpl: wrong.fetchImpl, apiVersion: 'v6' },
    ),
    'STUDY_RESPONSE_SELECTION',
  );
});
test('V6 evidence receipts cannot acknowledge different content bytes', async () => {
  const f = fixture({
    change: (d) => {
      const record = d.value as Record<string, unknown>;
      (record.artifactRef as Record<string, unknown>).contentHash = HASH;
    },
  });
  await refuses(
    runStudyRequest(
      'method.evidence.create',
      { studyId: STUDY, content: evidence() },
      { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'STUDY_RESPONSE_SELECTION',
  );
});
test('V6 evidence receipt byte size is bound by the async owner validator', async () => {
  const f = fixture({
    change: (d) => {
      const record = d.value as Record<string, unknown>;
      (record.artifactRef as Record<string, unknown>).byteSize = 1;
    },
  });
  await refuses(
    runStudyRequest(
      'method.evidence.create',
      { studyId: STUDY, content: evidence() },
      { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'STUDY_RESPONSE_SELECTION',
  );
});

test('V6 is always explicitly selected and exposes local exact owner JSON schemas without authentication', async () => {
  const f = fixture();
  for (const args of [
    ['method', 'assessment', 'get'],
    ['method', 'evidence', 'register'],
  ]) {
    const r = await invoke(['study', ...args, '--input', input({}), '--json'], f.fetchImpl);
    assert.match(r.stderr, /UNSUPPORTED_SCHEMA/u);
  }
  for (const action of [['create'], ['member', 'set'], ['analysis', 'request']]) {
    const r = await invoke(
      ['study', ...action, '--api-version', '6', '--input', input({}), '--json'],
      f.fetchImpl,
    );
    assert.match(r.stderr, /UNSUPPORTED_SCHEMA/u);
  }
  for (const kind of ['request', 'response']) {
    const r = await invoke(['study', 'schema', kind, '--api-version', '6', '--json'], async () => {
      throw new Error('schema is offline');
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(
      JSON.parse(r.stdout),
      JSON.parse(
        readFileSync(
          new URL(`../assets/study-contract/v6/${kind}.schema.json`, import.meta.url),
          'utf8',
        ),
      ),
    );
  }
  for (const extra of [[], ['--input', input({})]]) {
    const r = await invoke(['study', 'schema', 'request', ...extra, '--json'], f.fetchImpl);
    assert.match(r.stderr, /INVALID_ARGS/u);
  }
  assert.match((await invoke(['study', '--help'], f.fetchImpl)).stdout, /--api-version 6/u);
});
test('V6 historical reads survive admission rollback and current denial prevents recovery replay', async () => {
  const cap = {
    ...caps(),
    runtimeEnabled: false,
    operations: ['capability.read', 'method.assessment.read'],
    methodProfiles: [],
    reportTemplates: [],
    finalizationProfiles: [],
    reviewClasses: [],
    disclosurePolicies: [],
  };
  const f = fixture({ caps: cap });
  assert.equal(
    (
      await runStudyRequest(
        'method.assessment.read',
        { assessmentId: ASSESSMENT },
        { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6' },
      )
    ).data.type,
    'methodAssessment',
  );
  await refuses(
    runStudyRequest(
      'method.assessment.request',
      { studyId: STUDY, profileId: PROFILE, config: component.summary.config },
      { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'CAPABILITY_UNAVAILABLE',
  );
  const denied = fixture({ deny: true });
  await refuses(
    runStudyRequest(
      'method.assessment.read',
      { assessmentId: ASSESSMENT },
      { env: environment(), fetchImpl: denied.fetchImpl, apiVersion: 'v6' },
    ),
    'FORBIDDEN',
  );
  const missing = fixture({ caps: { ...caps(), methodProfiles: [] } });
  await refuses(
    runStudyRequest(
      'method.assessment.request',
      { studyId: STUDY, profileId: PROFILE, config: component.summary.config },
      { env: environment(), fetchImpl: missing.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'CAPABILITY_UNAVAILABLE',
  );
  const template = fixture({ caps: { ...caps(), reportTemplates: [] } });
  await refuses(
    runStudyRequest(
      'report.create',
      {
        studyId: STUDY,
        parentReportRevisionId: null,
        runIds: [id(10)],
        methodAssessmentIds: [ASSESSMENT],
        templateId: 'lca.study-method-report.v1',
        content: component.stored.content,
      },
      { env: environment(), fetchImpl: template.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'CAPABILITY_UNAVAILABLE',
  );
});
test('V6 actor projections and raw artifact kind/hash boundaries remain strict', async () => {
  const f = fixture();
  await runStudyRequest(
    'comment.append',
    { reportRevisionId: id(300), expectedContentHash: HASH, text: 'Bounded method comment.' },
    { env: environment(), fetchImpl: f.fetchImpl, apiVersion: 'v6', stateDir: root() },
  );
  const wrong = fixture({
    change: (d) => {
      (d.value as Record<string, unknown>).actorId = id(99);
    },
  });
  await refuses(
    runStudyRequest(
      'comment.append',
      { reportRevisionId: id(300), expectedContentHash: HASH, text: 'Bounded method comment.' },
      { env: environment(), fetchImpl: wrong.fetchImpl, apiVersion: 'v6', stateDir: root() },
    ),
    'STUDY_RESPONSE_ACTOR_BINDING',
  );
  const bytes = Buffer.from('owner facts');
  for (const type of [
    'methodAssessmentFacts',
    'methodEvidence',
    'reportContent',
    'modelInput',
    'runResult',
    'reportExportBundle',
  ]) {
    const artifactRef = {
      type,
      id: id(90),
      contentHash: studyDigest(bytes),
      byteSize: bytes.length,
    };
    const q = {
      schemaVersion: STUDY_METHOD_SCHEMA,
      operation: 'artifact.read',
      requestId: 'artifact',
      studyId: STUDY,
      artifactRef,
    };
    const d = { studyId: STUDY, artifactRef, encoding: 'base64', bytes: bytes.toString('base64') };
    if (type === 'reportExportBundle') assert.throws(() => verifyStudyArtifact(q, d, []), CliError);
    else assert(verifyStudyArtifact(q, d, []).bytes.equals(bytes));
  }
});

test('V6 method task waits and cancel use the owner typed assessment selector', async () => {
  const f = fixture();
  const p = input({ studyId: STUDY, resource: { type: 'methodAssessment', id: ASSESSMENT } });
  const result = await invoke(
    [
      'study',
      'method',
      'assessment',
      'task',
      'wait',
      '--api-version',
      '6',
      '--input',
      p,
      '--wait-ms',
      '0',
      '--json',
    ],
    f.fetchImpl,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).waiting, false);
  const cancel = await invoke(
    [
      'study',
      'method',
      'assessment',
      'task',
      'cancel',
      '--api-version',
      '6',
      '--input',
      input({
        studyId: STUDY,
        resource: { type: 'methodAssessment', id: ASSESSMENT },
        reason: 'Cancel synthetic owned task',
      }),
      '--state-dir',
      root(),
      '--json',
    ],
    f.fetchImpl,
  );
  assert.equal(cancel.exitCode, 0, cancel.stderr);
  const request = await invoke(
    [
      'study',
      'method',
      'assessment',
      'get',
      '--api-version',
      '6',
      '--input',
      input({ assessmentId: ASSESSMENT }),
      '--json',
    ],
    f.fetchImpl,
  );
  assert.equal(request.exitCode, 0, request.stderr);
});

test('V6 denial envelopes must retain the exact current request identity', async () => {
  const codec = await loadStudyCodec({}, 'v6');
  const request = prepareStudyRequest('method.assessment.read', { assessmentId: ASSESSMENT }, 'v6');
  assert.throws(
    () =>
      parseStudyResponse(
        {
          schemaVersion: STUDY_METHOD_SCHEMA,
          requestId: 'different',
          ok: false,
          code: 'FORBIDDEN',
          message: 'Denied',
          retryable: false,
          issues: [],
        },
        request,
        403,
        codec,
      ),
    (e: unknown) => e instanceof CliError && e.code === 'STUDY_RESPONSE_SELECTION',
  );
});

type MethodDraft = {
  title: string;
  claims: Array<Record<string, unknown>>;
  sections: Array<{ sectionId: string; title: string; paragraphs: string[]; claimIds: string[] }>;
};
function methodDraft(): MethodDraft {
  const content = structuredClone(component.stored.content) as unknown as MethodDraft;
  content.sections = [
    {
      sectionId: 'unicode-section',
      title: 'Valid section',
      paragraphs: ['Valid authored paragraph'],
      claimIds: [],
    },
  ];
  return content;
}
function reportInput(verb: 'create' | 'save', content: MethodDraft) {
  return verb === 'create'
    ? {
        studyId: STUDY,
        parentReportRevisionId: null,
        runIds: [id(10)],
        methodAssessmentIds: [ASSESSMENT],
        templateId: 'lca.study-method-report.v1',
        content,
      }
    : { target: { type: 'reportRevision', id: id(300), expectedRevision: 7 }, content };
}
for (const verb of ['create', 'save'] as const)
  for (const field of ['title', 'paragraph', 'unit'] as const)
    for (const scalar of ['\ud800', '\udc00']) {
      test(`V6 report ${verb} rejects ${field} unpaired ${scalar.charCodeAt(0).toString(16)} before Auth/domain I/O or intent publication`, async () => {
        const content = methodDraft();
        if (field === 'title') content.title = scalar;
        else if (field === 'paragraph') content.sections[0].paragraphs = [scalar];
        else content.claims[0].unit = scalar;
        const state = path.join(root(), 'unpublished-state');
        let calls = 0;
        const result = await invoke(
          [
            'study',
            'report',
            verb,
            '--api-version',
            '6',
            '--input',
            input(reportInput(verb, content)),
            '--state-dir',
            state,
            '--json',
          ],
          async () => {
            calls++;
            throw new Error('malformed local draft cannot call Auth or domain');
          },
        );
        assert.equal(result.exitCode, 1, result.stdout);
        const failure = JSON.parse(result.stderr) as {
          error: { code: string; details?: { intentFile?: string } };
        };
        assert.equal(failure.error.code, 'INVALID_REQUEST');
        assert.equal(calls, 0);
        assert.equal(existsSync(state), false);
        assert.equal(failure.error.details?.intentFile, undefined);
      });
    }
for (const verb of ['create', 'save'] as const) {
  test(`V6 report ${verb} retains valid Unicode and exact immutable recovery`, async () => {
    const content = methodDraft();
    content.title = '🧪'.repeat(256);
    content.sections[0].paragraphs = ['Valid authored Unicode 🧪'];
    content.claims[0].unit = 'kg 🧪';
    const f = fixture({ lost: true }),
      state = root();
    const result = await invoke(
      [
        'study',
        'report',
        verb,
        '--api-version',
        '6',
        '--input',
        input(reportInput(verb, content)),
        '--state-dir',
        state,
        '--json',
      ],
      f.fetchImpl,
    );
    assert.equal(result.exitCode, 1, result.stdout);
    const failure = JSON.parse(result.stderr) as {
      error: { code: string; details: { intentFile: string } };
    };
    assert.equal(failure.error.code, 'STUDY_TRANSPORT_UNKNOWN');
    const file = failure.error.details.intentFile,
      bytes = readFileSync(file),
      saved = readStudyIntent(file);
    assert.deepEqual(saved.request.content, content);
    assert.equal(saved.request.schemaVersion, STUDY_METHOD_SCHEMA);
    const recovered = await invoke(
      ['study', 'request', 'recover', '--intent-file', file, '--json'],
      f.fetchImpl,
    );
    assert.equal(recovered.exitCode, 0, recovered.stderr);
    assert(readFileSync(file).equals(bytes));
    const writes = f.requests.filter((r) => r.operation === `report.${verb}`);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], writes[1]);
    let calls = 0;
    const invalidState = path.join(root(), 'unpublished-overlimit');
    const overlimit = await invoke(
      [
        'study',
        'report',
        verb,
        '--api-version',
        '6',
        '--input',
        input(reportInput(verb, { ...content, title: '🧪'.repeat(257) })),
        '--state-dir',
        invalidState,
        '--json',
      ],
      async () => {
        calls++;
        throw new Error('bound rejection stays local');
      },
    );
    assert.match(overlimit.stderr, /INVALID_REQUEST/u);
    assert.equal(calls, 0);
    assert.equal(existsSync(invalidState), false);
  });
}
