import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import { loadStudyCodec } from '../src/lib/study/codec.js';
import { readStudyIntent } from '../src/lib/study/intent.js';
import {
  prepareStudyRequest,
  studyDigest,
  STUDY_REVIEW_SCHEMA,
} from '../src/lib/study/protocol.js';
import { runStudyRequest } from '../src/lib/study/transport.js';
import { verifyStudyExportBundle, runStudyExportFiles } from '../src/lib/study/export.js';
import { signedExportFixture, EXPORT_TIME } from './helpers/study-export-fixture.js';
const ACTOR = '11111111-1111-4111-8111-111111111111',
  OTHER = '22222222-2222-4222-8222-222222222222',
  CLIENT = '33333333-3333-4333-8333-333333333333';
const STUDY = '44444444-4444-4444-8444-444444444444',
  REPORT = '55555555-5555-4555-8555-55555555555b';
const HASH = 'a'.repeat(64),
  HEAD = 'b'.repeat(64),
  TIME = EXPORT_TIME;
const roots: string[] = [];
function root() {
  const p = mkdtempSync(path.join(os.tmpdir(), 'cli-study-v4-'));
  roots.push(p);
  return p;
}
test.after(() => {
  for (const p of roots) rmSync(p, { recursive: true, force: true });
});
function environment(actor = ACTOR, client: string | null = CLIENT): NodeJS.ProcessEnv {
  return {
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'review-fixture-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    TIANGONG_LCA_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ sub: actor, ...(client ? { client_id: client } : {}) })).toString('base64url')}.synthetic-signature`,
  };
}
const binding = { studyId: STUDY, reportRevisionId: REPORT, reportContentHash: HASH };
const reportInput = { reportRevisionId: REPORT, expectedContentHash: HASH };
function finalization(id = 'finalization-original', actor = ACTOR) {
  return {
    ...binding,
    finalizationId: id,
    actorId: actor,
    profileId: 'lca.study-report-internal-review.v1',
    expectedReviewStateHash: HEAD,
    acceptedReviewIds: ['review-original'],
    finalizedAt: TIME,
  };
}
function state() {
  return {
    ...binding,
    reportRevision: 1,
    authorId: OTHER,
    reviewStateHash: HEAD,
    currentReviewIds: ['review-original'],
    acceptedReviewIds: ['review-original'],
    finalization: null as ReturnType<typeof finalization> | null,
    acceptance: 'not_finalized',
    validity: { status: 'current', checkedAt: TIME, reasonCodes: [] },
    checkedAt: TIME,
  };
}
function server(
  options: {
    lost?: boolean;
    deny?: string;
    caps?: Record<string, unknown>;
    actor?: string;
    response?: (request: Record<string, unknown>) => unknown;
    onWrite?: (request: Record<string, unknown>) => void;
  } = {},
) {
  const calls: string[] = [];
  const requests: Record<string, unknown>[] = [],
    receipts = new Map<string, unknown>();
  let lost = options.lost ?? false;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/auth/v1/user'))
      return json({
        id: options.actor ?? ACTOR,
        email: 'review-fixture@example.test',
        role: 'authenticated',
      });
    const r = JSON.parse(String(init?.body));
    requests.push(r);
    assert.equal(r.schemaVersion, STUDY_REVIEW_SCHEMA);
    assert.equal(new Headers(init?.headers).get('x-study-schema'), STUDY_REVIEW_SCHEMA);
    const ok = (data: unknown) =>
      json({ schemaVersion: STUDY_REVIEW_SCHEMA, requestId: r.requestId, ok: true, data });
    if (r.operation === 'capability.read')
      return ok({
        type: 'capabilities',
        contractVersion: '4.0.0',
        runtimeEnabled: true,
        operations: Object.keys((await loadStudyCodec(environment(), 'v4')).operationMetadata),
        finalizationProfiles: [
          'lca.study-report-unreviewed.v1',
          'lca.study-report-internal-review.v1',
        ],
        reviewClasses: ['internal'],
        disclosurePolicies: ['lca.study-report-summary-share.v1'],
        ...options.caps,
      });
    if (options.deny)
      return json(
        {
          schemaVersion: STUDY_REVIEW_SCHEMA,
          requestId: r.requestId,
          ok: false,
          code: options.deny,
          message: 'private provider text',
          retryable: false,
          issues: [],
        },
        403,
      );
    if (options.response) return ok(options.response(r));
    if (r.operation === 'resource.actions')
      return ok({
        type: 'actions',
        resource: r.resource,
        actions: ['comment.append', 'review.record'],
        corePermissions: { read: false, write: false },
        allowedMemberRoles: [],
      });
    if (r.operation === 'report.current') return ok({ type: 'reportState', value: state() });
    if (
      r.operation === 'comment.list' ||
      r.operation === 'review.list' ||
      r.operation === 'review.delegation.list' ||
      r.operation === 'share.list'
    )
      return ok({
        type: 'history',
        ...binding,
        kind: r.operation === 'review.delegation.list' ? 'delegation' : r.operation.split('.')[0],
        items: [],
        nextCursor: null,
      });
    const key = String(r.idempotencyKey);
    options.onWrite?.(r);
    let value = receipts.get(key);
    if (!value) {
      if (r.operation === 'review.record')
        value = {
          ...binding,
          reviewId: 'review-original',
          actorId: ACTOR,
          clientId: CLIENT,
          reviewClass: r.reviewClass,
          decision: r.decision,
          comment: r.comment,
          predecessorReviewId: r.predecessorReviewId,
          delegationId: r.delegationId,
          authorityKind: 'oauth_delegated_actor',
          createdAt: TIME,
        };
      else if (r.operation === 'report.finalize') value = finalization();
      else if (r.operation === 'member.set')
        value = {
          type: 'member',
          studyId: STUDY,
          studyRevision: 2,
          memberId: r.memberId,
          role: r.role,
        };
      else if (r.operation === 'comment.append')
        value = {
          ...binding,
          commentId: 'comment-original',
          actorId: ACTOR,
          clientId: CLIENT,
          text: r.text,
          createdAt: TIME,
        };
      else
        value = {
          ...binding,
          delegationId: r.delegationId ?? 'delegation-original',
          actorId: ACTOR,
          clientId: CLIENT,
          reviewClass: 'internal',
          decision: 'approve',
          predecessorReviewId: null,
          issuedAt: TIME,
          expiresAt: '2026-11-03T00:10:00Z',
          revokedAt: r.operation === 'review.delegation.revoke' ? TIME : null,
          consumedReviewId: null,
        };
      receipts.set(key, value);
    }
    if (lost) {
      lost = false;
      throw new Error('ambiguous private transport');
    }
    if (r.operation === 'review.record') return ok({ type: 'review', value, state: state() });
    if (r.operation === 'report.finalize') {
      const current = state();
      current.finalization = finalization('finalization-later', OTHER);
      current.acceptance = 'current';
      return ok({ type: 'finalization', value, state: current });
    }
    if (r.operation === 'member.set') return ok(value);
    return ok({ type: r.operation === 'comment.append' ? 'comment' : 'delegation', value });
  };
  return { fetchImpl, requests, receipts, calls };
}
const review = {
  ...reportInput,
  reviewClass: 'internal',
  decision: 'approve',
  comment: 'Exact revision decision; no independent-human claim.',
  predecessorReviewId: null,
  delegationId: 'delegation-original',
};
function settings(fetchImpl: FetchLike) {
  return { env: environment(), fetchImpl, apiVersion: 'v4' as const, stateDir: root() };
}
async function rejected(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (error: unknown) => error instanceof CliError && error.code === code);
}
async function command(args: string[], fetchImpl: FetchLike) {
  return executeCli(['study', ...args], {
    env: environment(),
    fetchImpl,
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
  });
}
function input(value: unknown) {
  const p = path.join(root(), 'input.json');
  writeFileSync(p, JSON.stringify(value));
  return p;
}

test('V4 query framing, exact owner codec, actions and response selection keep identity and DB projections intact', async () => {
  for (const operation of [
    'resource.actions',
    'report.current',
    'report.view',
    'share.view',
    'export.download',
    'share.download',
  ])
    assert.equal(prepareStudyRequest(operation, {}, 'v4').idempotencyKey, undefined);
  const remote = server();
  const result = await runStudyRequest(
    'resource.actions',
    { resource: { type: 'reportRevision', id: REPORT } },
    settings(remote.fetchImpl),
  );
  assert.deepEqual(result.data.corePermissions, { read: false, write: false });
  assert.deepEqual(result.data.allowedMemberRoles, []);
  const transplanted = server({
    response: () => ({
      type: 'actions',
      resource: { type: 'reportRevision', id: 'another-report' },
      actions: [],
      corePermissions: { read: false, write: false },
      allowedMemberRoles: [],
    }),
  });
  await rejected(
    runStudyRequest(
      'resource.actions',
      { resource: { type: 'reportRevision', id: REPORT } },
      settings(transplanted.fetchImpl),
    ),
    'STUDY_RESPONSE_SELECTION',
  );
});

test('Delegated actor review persists before dispatch and recovers the exact schema/key without a replacement grant', async () => {
  const local = root();
  const safe = server({
    lost: true,
    onWrite: (r) => {
      const files = findIntents(local);
      assert.equal(files.length, 1);
      const saved = readStudyIntent(files[0]);
      assert.equal(saved.request.requestId, r.requestId);
      assert.equal(saved.request.delegationId, 'delegation-original');
    },
  });
  let savedFile = '';
  try {
    await runStudyRequest('review.record', review, {
      ...settings(safe.fetchImpl),
      stateDir: local,
    });
    assert.fail('lost reply');
  } catch (error) {
    assert(error instanceof CliError);
    assert.equal(error.code, 'STUDY_TRANSPORT_UNKNOWN');
    savedFile = (error.details as { intentFile: string }).intentFile;
  }
  const saved = readStudyIntent(savedFile);
  assert(savedFile.includes(`${path.sep}v4${path.sep}`));
  assert(!readFileSync(savedFile, 'utf8').includes(environment().TIANGONG_LCA_ACCESS_TOKEN!));
  const replay = await runStudyRequest('review.record', saved.request, {
    ...settings(safe.fetchImpl),
    recoverFile: savedFile,
  });
  assert.equal((replay.data.value as Record<string, unknown>).reviewId, 'review-original');
  assert.deepEqual(
    safe.requests.filter((r) => r.operation === 'review.record'),
    [saved.request, saved.request],
  );
  assert.equal(safe.receipts.size, 1);
  const wrong = server();
  await rejected(
    runStudyRequest('review.record', saved.request, {
      ...settings(wrong.fetchImpl),
      env: environment(ACTOR, OTHER),
      recoverFile: savedFile,
    }),
    'STUDY_RECOVERY_BINDING_MISMATCH',
  );
  assert.equal(wrong.requests.length, 0);
  const denied = server({ deny: 'FORBIDDEN' });
  await rejected(
    runStudyRequest('review.record', saved.request, {
      ...settings(denied.fetchImpl),
      recoverFile: savedFile,
    }),
    'FORBIDDEN',
  );
});
function findIntents(directory: string): string[] {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('intent.json'))
    .map((p) => path.join(directory, p));
}

test('Public P3 actions, reviewer grants, comments and history negotiate v4 without upgrading legacy operations', async () => {
  const remote = server();
  const cases: Array<[string[], Record<string, unknown>]> = [
    [['actions'], { resource: { type: 'reportRevision', id: REPORT } }],
    [
      ['member', 'set', '--api-version', '4'],
      {
        target: { type: 'study', id: STUDY, expectedRevision: 1 },
        memberId: OTHER,
        role: 'reviewer',
      },
    ],
    [['comment', 'append'], { ...reportInput, text: 'Bound annotation, not an approval.' }],
    [['comment', 'list'], { ...reportInput, cursor: null, limit: 5 }],
    [['review', 'list'], { ...reportInput, cursor: null, limit: 5 }],
    [['review', 'delegation', 'list'], { ...reportInput, cursor: null, limit: 5 }],
    [['review', 'delegation', 'revoke'], { delegationId: 'delegation-original' }],
    [['report', 'current'], reportInput],
    [['share', 'list'], { ...reportInput, cursor: null, limit: 5 }],
  ];
  for (const [args, value] of cases) {
    const result = await command(
      [...args, '--input', input(value), '--state-dir', root(), '--json'],
      remote.fetchImpl,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).apiSchema, STUDY_REVIEW_SCHEMA);
  }
  const caps = await command(['capabilities', '--api-version', '4', '--json'], remote.fetchImpl);
  assert.equal(caps.exitCode, 0, caps.stderr);
  const before = remote.requests.length;
  for (const args of [
    ['member', 'set', '--input', input(cases[1][1])],
    ['report', 'current', '--api-version', '3', '--input', input(reportInput)],
    ['report', 'create', '--api-version', '4'],
    ['artifact', 'download', '--api-version', '4'],
  ]) {
    const result = await command([...args, '--json'], remote.fetchImpl);
    assert.notEqual(result.exitCode, 0);
  }
  assert.equal(remote.requests.length, before);
  const denied = server({ deny: 'FORBIDDEN' });
  const delegation = await command(
    [
      'review',
      'delegation',
      'issue',
      '--input',
      input({
        ...reportInput,
        clientId: CLIENT,
        reviewClass: 'internal',
        decision: 'approve',
        predecessorReviewId: null,
        expiresAt: '2026-11-03T00:10:00Z',
      }),
      '--state-dir',
      root(),
      '--json',
    ],
    (url, init) => {
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        `Bearer ${environment().TIANGONG_LCA_ACCESS_TOKEN}`,
      );
      return denied.fetchImpl(url, init);
    },
  );
  assert.equal(delegation.exitCode, 1);
  assert.equal(JSON.parse(delegation.stderr).error.code, 'FORBIDDEN');
  assert.equal(denied.requests.filter((r) => r.operation === 'review.delegation.issue').length, 1);
});

test('Finalization replay preserves original actor/result while exposing a different latest current state', async () => {
  const remote = server(),
    value = {
      target: { type: 'reportRevision', id: REPORT, expectedRevision: 1 },
      expectedContentHash: HASH,
      expectedReviewStateHash: HEAD,
      profileId: 'lca.study-report-internal-review.v1',
      acceptedReviewIds: ['review-original'],
    };
  const first = await runStudyRequest('report.finalize', value, settings(remote.fetchImpl));
  assert.equal(
    (first.data.value as Record<string, unknown>).finalizationId,
    'finalization-original',
  );
  assert.equal(
    ((first.data.state as Record<string, unknown>).finalization as Record<string, unknown>).actorId,
    OTHER,
  );
  const saved = readStudyIntent(first.intentFile!);
  const replay = await runStudyRequest('report.finalize', saved.request, {
    ...settings(remote.fetchImpl),
    recoverFile: first.intentFile,
  });
  assert.equal((replay.data.value as Record<string, unknown>).actorId, ACTOR);
  assert.equal(
    ((replay.data.state as Record<string, unknown>).finalization as Record<string, unknown>)
      .finalizationId,
    'finalization-later',
  );
  const publicResult = await command(
    ['report', 'finalize', '--input', input(value), '--state-dir', root(), '--json'],
    remote.fetchImpl,
  );
  assert.equal(publicResult.exitCode, 0, publicResult.stderr);
  for (const [operation, request, caps] of [
    ['report.finalize', value, { finalizationProfiles: [] }],
    ['review.record', review, { reviewClasses: [] }],
    [
      'share.create',
      {
        ...reportInput,
        exportId: 'export',
        recipientId: OTHER,
        disclosurePolicyId: 'lca.study-report-summary-share.v1',
        expiresAt: '2026-11-03T01:00:00Z',
      },
      { disclosurePolicies: [] },
    ],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
    const no = server({ caps });
    await rejected(
      runStudyRequest(operation, request, settings(no.fetchImpl)),
      'CAPABILITY_UNAVAILABLE',
    );
    assert.equal(no.requests.length, 1);
  }
});

test('Exact owner failures and authenticated outcome binding reject forged, stale and aliased review attempts', async () => {
  const bad = server({
    response: (r) => ({
      type: 'review',
      value: {
        ...binding,
        reviewId: 'review-original',
        actorId: OTHER,
        clientId: CLIENT,
        reviewClass: 'internal',
        decision: r.decision,
        comment: r.comment,
        predecessorReviewId: r.predecessorReviewId,
        delegationId: r.delegationId,
        authorityKind: 'oauth_delegated_actor',
        createdAt: TIME,
      },
      state: state(),
    }),
  });
  await rejected(
    runStudyRequest('review.record', review, settings(bad.fetchImpl)),
    'STUDY_RESPONSE_ACTOR_BINDING',
  );
  const client = server({
    response: (r) => ({
      type: 'comment',
      value: {
        ...binding,
        commentId: 'comment',
        actorId: ACTOR,
        clientId: OTHER,
        text: r.text,
        createdAt: TIME,
      },
    }),
  });
  await rejected(
    runStudyRequest(
      'comment.append',
      { ...reportInput, text: 'identity binding' },
      settings(client.fetchImpl),
    ),
    'STUDY_RESPONSE_ACTOR_BINDING',
  );
  const denied = server({ deny: 'REFERENCE_MISMATCH' });
  await rejected(
    runStudyRequest(
      'review.record',
      { ...review, expectedContentHash: 'c'.repeat(64) },
      settings(denied.fetchImpl),
    ),
    'REFERENCE_MISMATCH',
  );
  const structural = server();
  await rejected(
    runStudyRequest(
      'review.record',
      { ...review, decision: 'withdraw' },
      settings(structural.fetchImpl),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(structural.requests.length, 0);
  assert.equal(structural.calls.length, 0);
  await rejected(
    runStudyRequest(
      'review.record',
      { ...review, authorityKind: 'first_party_actor', actorId: ACTOR },
      settings(structural.fetchImpl),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(structural.calls.length, 0);
  const absentGrant = server({ deny: 'FORBIDDEN' });
  await rejected(
    runStudyRequest(
      'review.record',
      { ...review, delegationId: null },
      settings(absentGrant.fetchImpl),
    ),
    'FORBIDDEN',
  );
  assert.deepEqual(
    absentGrant.requests.map((r) => r.operation),
    ['capability.read', 'review.record'],
  );
  assert.equal(absentGrant.requests[1].delegationId, null);
  const stale = server({ deny: 'REVISION_CONFLICT' });
  await rejected(
    runStudyRequest(
      'review.record',
      { ...review, predecessorReviewId: 'stale-predecessor' },
      settings(stale.fetchImpl),
    ),
    'REVISION_CONFLICT',
  );
  const alias = server({ deny: 'INVALID_REQUEST' }),
    upper = REPORT.toUpperCase();
  await rejected(
    runStudyRequest(
      'comment.append',
      { ...reportInput, reportRevisionId: upper, text: 'Exact spelling, no client rewrite.' },
      settings(alias.fetchImpl),
    ),
    'INVALID_REQUEST',
  );
  assert.equal(alias.requests[1].reportRevisionId, upper);
});

test('P3 signed manifest retains exact historical finalization and old P2 bytes keep their original meaning', async () => {
  for (const reviewed of [false, true]) {
    const value = await signedExportFixture(undefined, { reviewed });
    const verified = await verifyStudyExportBundle(
      value.bytes,
      value.anchors,
      value.expected,
      environment(),
    );
    assert.equal(verified.manifest.schemaVersion, 'lca.study-export-manifest.v2');
    assert.equal(
      (verified.manifest.finalization as Record<string, unknown>).finalizationId,
      'finalization-fixture',
    );
    const altered = value.signManifest({
      ...value.manifest,
      finalization: { ...value.manifest.finalization!, reportContentHash: '0'.repeat(64) },
    });
    await rejected(
      verifyStudyExportBundle(altered.bytes, value.anchors, value.expected, environment()),
      'STUDY_EXPORT_VERIFICATION_FAILED',
    );
  }
  const old = await signedExportFixture();
  const verified = await verifyStudyExportBundle(
    old.bytes,
    old.anchors,
    old.expected,
    environment(),
  );
  assert.equal(verified.manifest.schemaVersion, 'lca.study-export-manifest.v1');
  assert.equal(verified.manifest.finalization, undefined);
});

async function exportRecords() {
  const signed = await signedExportFixture(undefined, { reviewed: true });
  const bound = {
    studyId: signed.expected.studyId,
    reportRevisionId: signed.expected.reportRevisionId,
    reportContentHash: signed.expected.reportContentHash,
  };
  const ref = (type: string, id: string, bytes: Uint8Array, schemaVersion: string) => ({
    type,
    id,
    contentHash: studyDigest(bytes),
    byteSize: bytes.byteLength,
    digestScope: 'artifact_bytes_sha256',
    mediaType: 'application/json',
    schemaVersion,
  });
  const projectionRef = ref(
    'reportProjection',
    'projection-p3',
    signed.projection,
    'lca.study-report-view.v1',
  );
  const bundleRef = ref(
    'reportExportBundle',
    'bundle-p3',
    signed.bytes,
    'lca.study-export-bundle.v2',
  );
  const exported = {
    ...bound,
    exportId: signed.expected.exportId,
    finalization: signed.manifest.finalization!,
    generatedAt: TIME,
    projectionRef,
    resourcesRef: ref(
      'renderResources',
      'manifest-p3',
      signed.manifestBytes,
      'lca.study-export-manifest.v2',
    ),
    bundleRef,
    receipt: signed.receipt,
  };
  const share = {
    ...bound,
    shareId: 'share-p3',
    exportId: signed.expected.exportId,
    finalizationId: 'finalization-fixture',
    issuerId: ACTOR,
    recipientId: OTHER,
    disclosurePolicyId: 'lca.study-report-summary-share.v1',
    disclosureContextHash: 'e'.repeat(64),
    grantEpoch: 1,
    projectionRef,
    bundleRef,
    createdAt: TIME,
    expiresAt: '2026-11-03T01:00:00Z',
    revokedAt: null as string | null,
    status: 'active',
  };
  return { signed, exported, share };
}

test('Finalized export/share downloads bind live resource, independent signature selection and exact renderer bytes', async () => {
  const { signed, exported, share } = await exportRecords();
  const anchors = input(signed.anchors),
    expected = input(signed.expected);
  for (const kind of ['export', 'share'] as const) {
    const selected =
      kind === 'export' ? { exportId: exported.exportId } : { shareId: share.shareId };
    const remote = server({
      response: () =>
        kind === 'export'
          ? {
              type: 'exportDownload',
              export: exported,
              encoding: 'base64',
              bytes: signed.bytes.toString('base64'),
            }
          : { type: 'download', share, encoding: 'base64', bytes: signed.bytes.toString('base64') },
    });
    const output = path.join(root(), 'verified');
    const report = await runStudyExportFiles(
      'download',
      {
        apiVersion: 'v4',
        downloadKind: kind,
        inputFile: input(selected),
        outputDirectory: output,
        anchorsFile: anchors,
        expectedFile: expected,
      },
      remote.fetchImpl,
      environment(),
    );
    assert.equal(report.rendererMatched, true);
    assert.equal(report.currentReview, 'not-checked-offline');
    assert.equal(
      (report.historicalFinalization as Record<string, unknown>).finalizationId,
      'finalization-fixture',
    );
    assert.equal(
      (report.authorizationAtDownload as Record<string, unknown>).operation,
      `${kind}.download`,
    );
    assert(readFileSync(path.join(output, 'report.html')).equals(signed.html));
    assert(!JSON.stringify(report).includes(signed.bytes.toString('base64')));
    const args = [
      kind,
      'download',
      ...(kind === 'export' ? ['--api-version', '4'] : []),
      '--input',
      input(selected),
      '--output-dir',
      path.join(root(), 'public'),
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--json',
    ];
    const publicResult = await command(args, remote.fetchImpl);
    assert.equal(publicResult.exitCode, 0, publicResult.stderr);
    assert.equal(JSON.parse(publicResult.stdout).signatureVerified, true);
    await rejected(
      runStudyRequest(`${kind}.download`, selected, settings(remote.fetchImpl)),
      'STUDY_OUTPUT_REQUIRED',
    );
  }
  const refused = server({ deny: 'FORBIDDEN' });
  await rejected(
    runStudyExportFiles(
      'download',
      {
        apiVersion: 'v4',
        downloadKind: 'share',
        inputFile: input({ shareId: share.shareId }),
        outputDirectory: path.join(root(), 'revoked'),
        anchorsFile: anchors,
        expectedFile: expected,
      },
      refused.fetchImpl,
      environment(),
    ),
    'FORBIDDEN',
  );
});

test('Wrong finalized download metadata, poisoned bytes and invalid export selection cannot publish a trusted directory', async () => {
  const { signed, exported, share } = await exportRecords();
  const anchors = input(signed.anchors),
    expected = input(signed.expected);
  for (const [record, kind, code] of [
    [
      {
        ...exported,
        finalization: { ...exported.finalization, finalizationId: 'another-finalization' },
      },
      'export',
      'STUDY_EXPORT_SELECTION',
    ],
    [
      { ...share, projectionRef: { ...share.projectionRef, contentHash: '0'.repeat(64) } },
      'share',
      'STUDY_EXPORT_SELECTION',
    ],
    [
      { ...exported, receipt: { ...exported.receipt, signature: 'A'.repeat(86) } },
      'export',
      'STUDY_EXPORT_SELECTION',
    ],
  ] as const) {
    const remote = server({
      response: () =>
        kind === 'export'
          ? {
              type: 'exportDownload',
              export: record,
              encoding: 'base64',
              bytes: signed.bytes.toString('base64'),
            }
          : {
              type: 'download',
              share: record,
              encoding: 'base64',
              bytes: signed.bytes.toString('base64'),
            },
    });
    await rejected(
      runStudyExportFiles(
        'download',
        {
          apiVersion: 'v4',
          downloadKind: kind,
          inputFile: input(
            kind === 'export' ? { exportId: exported.exportId } : { shareId: share.shareId },
          ),
          outputDirectory: path.join(root(), 'refused'),
          anchorsFile: anchors,
          expectedFile: expected,
        },
        remote.fetchImpl,
        environment(),
      ),
      code,
    );
  }
  const remote = server();
  await rejected(
    runStudyExportFiles(
      'download',
      {
        apiVersion: 'v4',
        inputFile: input({ exportId: 'foreign-export' }),
        outputDirectory: path.join(root(), 'foreign'),
        anchorsFile: anchors,
        expectedFile: expected,
      },
      remote.fetchImpl,
      environment(),
    ),
    'STUDY_EXPORT_SELECTION',
  );
  assert.equal(remote.requests.length, 0);
  const corrupt = server({
    response: () => ({
      type: 'download',
      share,
      encoding: 'base64',
      bytes: Buffer.from('tampered bundle').toString('base64'),
    }),
  });
  await rejected(
    runStudyRequest(
      'share.download',
      { shareId: share.shareId },
      { ...settings(corrupt.fetchImpl), outputPath: path.join(root(), 'raw-bundle') },
    ),
    'STUDY_ARTIFACT_INTEGRITY',
  );
});

test('Share metadata operations and safe current views return JSON without authoring preview HTML', async () => {
  const { signed, exported, share } = await exportRecords();
  const create = {
    reportRevisionId: share.reportRevisionId,
    expectedContentHash: share.reportContentHash,
    exportId: share.exportId,
    recipientId: OTHER,
    disclosurePolicyId: share.disclosurePolicyId,
    expiresAt: share.expiresAt,
  };
  const remote = server({
    response: (r) =>
      r.operation === 'export.request' || r.operation === 'export.read'
        ? { type: 'export', value: exported }
        : {
            type: 'share',
            value:
              r.operation === 'share.revoke'
                ? { ...share, status: 'revoked', revokedAt: TIME }
                : share,
          },
  });
  for (const [args, value] of [
    [['share', 'create'], create],
    [['share', 'get'], { shareId: share.shareId }],
    [
      ['share', 'revoke'],
      { shareId: share.shareId, reason: 'Issuer revoked this named projection.' },
    ],
    [['export', 'get', '--api-version', '4'], { exportId: exported.exportId }],
    [
      ['export', 'request', '--api-version', '4'],
      {
        reportRevisionId: share.reportRevisionId,
        expectedContentHash: share.reportContentHash,
        finalizationId: 'finalization-fixture',
        expectedReviewStateHash: 'f'.repeat(64),
        rendererVersion: '1.0.0',
        viewModelVersion: 'lca.study-report-view.v1',
      },
    ],
  ] as Array<[string[], Record<string, unknown>]>) {
    const result = await command(
      [...args, '--input', input(value), '--state-dir', root(), '--json'],
      remote.fetchImpl,
    );
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const wrong = server({
    response: () => ({ type: 'share', value: { ...share, issuerId: OTHER } }),
  });
  await rejected(
    runStudyRequest('share.create', create, settings(wrong.fetchImpl)),
    'STUDY_RESPONSE_ACTOR_BINDING',
  );
  const viewState = {
    ...state(),
    ...{
      studyId: share.studyId,
      reportRevisionId: share.reportRevisionId,
      reportContentHash: share.reportContentHash,
    },
    finalization: signed.manifest.finalization!,
    acceptance: 'current',
    currentReviewIds: ['review-fixture'],
    acceptedReviewIds: ['review-fixture'],
  };
  const view = server({
    response: (r) => ({
      type: 'view',
      view: signed.view,
      state: viewState,
      share: r.operation === 'share.view' ? share : null,
    }),
  });
  for (const [action, value] of [
    [
      ['report', 'view'],
      { reportRevisionId: share.reportRevisionId, expectedContentHash: share.reportContentHash },
    ],
    [['share', 'view'], { shareId: share.shareId }],
  ] as Array<[string[], Record<string, unknown>]>) {
    const result = await command([...action, '--input', input(value), '--json'], view.fetchImpl);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).data.type, 'view');
    assert(!result.stdout.includes('<!doctype html>'));
  }
});
