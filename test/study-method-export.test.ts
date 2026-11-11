import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import { studyDigest, studyJson } from '../src/lib/study/protocol.js';
import {
  publishStudyExport,
  runStudyExportFiles,
  verifyStudyExportBundle,
  verifyStudyExportDirectory,
} from '../src/lib/study/export.js';
import {
  STUDY_RENDERER_ARCHIVE_SHA256,
  STUDY_V3_RENDERER_ARCHIVE_SHA256,
} from '../src/lib/study/renderer.js';
import {
  exportEnvironment,
  signedMethodExportFixture,
  signedAdvancedExportFixture,
  signedExportFixture,
  EXPORT_TIME,
} from './helpers/study-export-fixture.js';
const roots: string[] = [];
function root() {
  const p = mkdtempSync(path.join(os.tmpdir(), 'study-advanced-export-'));
  roots.push(p);
  return p;
}
function input(value: unknown) {
  const p = path.join(root(), 'input.json');
  writeFileSync(p, JSON.stringify(value));
  return p;
}
test.after(() => {
  for (const p of roots) rmSync(p, { recursive: true, force: true });
});
async function refuses(value: Promise<unknown>, code: string) {
  await assert.rejects(value, (e: unknown) => e instanceof CliError && e.code === code);
}
const offline: FetchLike = async () => {
  throw new Error('offline verification must not fetch');
};

test('V6 signed export4 verifies complete owner method summary and exact renderer3 HTML', async () => {
  const value = await signedMethodExportFixture();
  const verified = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
    'v6',
  );
  assert.equal(verified.manifest.schemaVersion, 'lca.study-export-manifest.v4');
  const summary = value.view.methodAssessment;
  assert.equal((summary.requirements as unknown[]).length, 20);
  assert.equal((summary.categories as unknown[]).length, 25);
  assert.equal((summary.factCatalog as unknown[]).length, 58);
  assert.equal(summary.pefConformityQualified, false);
  assert.equal(summary.scientificRankingQualified, false);
  assert.equal(summary.businessPilotQualified, false);
  assert.match(
    value.html.toString(),
    /not_qualified_professional_and_actual_study_evidence_pending/u,
  );
  assert.equal(
    (
      summary.candidateNormalisationWeighting as {
        status: string;
        canonicalCandidateSingleScore: null;
      }
    ).status,
    'unavailable',
  );
  assert.equal(
    (summary.candidateNormalisationWeighting as { canonicalCandidateSingleScore: null })
      .canonicalCandidateSingleScore,
    null,
  );
  assert.equal(
    (verified.manifest.renderer as { artifactHash: string }).artifactHash,
    STUDY_V3_RENDERER_ARCHIVE_SHA256,
  );
  const directory = path.join(root(), 'verified');
  publishStudyExport(directory, verified);
  await verifyStudyExportDirectory(
    directory,
    value.anchors,
    value.expected,
    exportEnvironment(),
    'v6',
  );
  const result = await executeCli(
    [
      'study',
      'export',
      'verify',
      '--api-version',
      '6',
      '--directory',
      directory,
      '--anchors',
      input(value.anchors),
      '--expected',
      input(value.expected),
      '--json',
    ],
    {
      env: exportEnvironment(),
      fetchImpl: offline,
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
});

test('V6 versioned verification keeps historical manifest1/2 bound to original renderer1 bytes', async () => {
  for (const finalized of [undefined, { reviewed: true }]) {
    const value = await signedExportFixture(undefined, finalized);
    const verified = await verifyStudyExportBundle(
      value.bytes,
      value.anchors,
      value.expected,
      exportEnvironment(),
      'v6',
    );
    assert.equal(
      (verified.manifest.renderer as { artifactHash: string }).artifactHash,
      STUDY_RENDERER_ARCHIVE_SHA256,
    );
    assert(verified.files.find((f) => f.path === 'report.html')!.bytes);
    assert.equal(
      verified.manifest.schemaVersion,
      finalized ? 'lca.study-export-manifest.v2' : 'lca.study-export-manifest.v1',
    );
  }
});

test('V6 offline verifier retains numerical manifest3 with its original renderer2', async () => {
  const f = await signedAdvancedExportFixture();
  const verified = await verifyStudyExportBundle(
    f.bytes,
    f.anchors,
    f.expected,
    exportEnvironment(),
    'v6',
  );
  assert.equal(verified.manifest.schemaVersion, 'lca.study-export-manifest.v3');
});

test('V6 detached bytes and finalized metadata tampering never authenticate', async () => {
  const value = await signedMethodExportFixture();
  const html = structuredClone(value.bundle);
  html.files[0].bytes = Buffer.from('edited visible result').toString('base64');
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(html)),
      value.anchors,
      value.expected,
      exportEnvironment(),
      'v6',
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const changed = value.signManifest({
    ...value.manifest,
    finalization: { ...value.manifest.finalization!, reportContentHash: 'f'.repeat(64) },
  });
  await refuses(
    verifyStudyExportBundle(
      changed.bytes,
      value.anchors,
      value.expected,
      exportEnvironment(),
      'v6',
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  await refuses(
    verifyStudyExportBundle(value.bytes, [], value.expected, exportEnvironment(), 'v6'),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  await refuses(
    verifyStudyExportBundle(
      value.bytes,
      value.anchors,
      { ...value.expected, exportId: 'other' },
      exportEnvironment(),
      'v6',
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const unknownHash = 'b'.repeat(64),
    different = value.signManifest({
      ...value.manifest,
      renderer: { ...value.manifest.renderer, artifactHash: unknownHash },
    });
  await refuses(
    verifyStudyExportBundle(
      different.bytes,
      [{ ...value.anchors[0], rendererArtifactHashes: [unknownHash] }],
      value.expected,
      exportEnvironment(),
      'v6',
    ),
    'STUDY_EXPORT_RENDERER_MISMATCH',
  );
  const replaced = Buffer.from('<!doctype html><title>genuinely signed substitute</title>');
  const signed = value.signManifest({
    ...value.manifest,
    files: value.manifest.files.map((f) =>
      f.path === 'report.html'
        ? { ...f, sha256: studyDigest(replaced), byteSize: replaced.length }
        : f,
    ),
  });
  signed.bundle.files[0].bytes = replaced.toString('base64');
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(signed.bundle)),
      value.anchors,
      value.expected,
      exportEnvironment(),
      'v6',
    ),
    'STUDY_EXPORT_RENDERER_MISMATCH',
  );
});

async function records() {
  const signed = await signedMethodExportFixture();
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
      'projection-p4',
      signed.projection,
      'lca.study-report-view.v3',
    ),
    bundleRef = ref('reportExportBundle', 'bundle-p4', signed.bytes, 'lca.study-export-bundle.v4');
  const exported = {
    ...bound,
    exportId: signed.expected.exportId,
    finalization: signed.manifest.finalization!,
    generatedAt: EXPORT_TIME,
    projectionRef,
    resourcesRef: ref(
      'renderResources',
      'manifest-p4',
      signed.manifestBytes,
      'lca.study-export-manifest.v4',
    ),
    bundleRef,
    receipt: signed.receipt,
  };
  const share = {
    ...bound,
    shareId: 'share-p4',
    exportId: signed.expected.exportId,
    finalizationId: 'finalization-fixture',
    issuerId: '11111111-1111-4111-8111-111111111111',
    recipientId: '22222222-2222-4222-8222-222222222222',
    disclosurePolicyId: 'lca.study-report-summary-share.v1',
    disclosureContextHash: 'e'.repeat(64),
    grantEpoch: 1,
    projectionRef,
    bundleRef,
    createdAt: EXPORT_TIME,
    expiresAt: '2026-11-03T01:00:00Z',
    revokedAt: null,
    status: 'active',
  };
  return { signed, exported, share };
}
function remote(response: unknown, operation: string, deny = false) {
  const actor = '11111111-1111-4111-8111-111111111111';
  const env = {
    ...exportEnvironment(),
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    TIANGONG_LCA_ACCESS_TOKEN: `header.${Buffer.from(JSON.stringify({ sub: actor })).toString('base64url')}.signature`,
  };
  const operations: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const json = (v: unknown) =>
      new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/v1/user'))
      return json({ id: actor, email: 'fixture@example.test', role: 'authenticated' });
    const req = JSON.parse(String(init?.body));
    operations.push(req.operation);
    assert.equal(new Headers(init?.headers).get('x-study-schema'), 'lca.study-api.v6');
    return json(
      deny
        ? {
            schemaVersion: 'lca.study-api.v6',
            requestId: req.requestId,
            ok: false,
            code: 'FORBIDDEN',
            message: 'Denied',
            retryable: false,
            issues: [],
          }
        : {
            schemaVersion: 'lca.study-api.v6',
            requestId: req.requestId,
            ok: true,
            data:
              req.operation === 'capability.read'
                ? {
                    type: 'capabilities',
                    contractVersion: '6.0.0',
                    runtimeEnabled: true,
                    operations: ['capability.read', operation],
                    methodProfiles: [],
                    limits: {
                      maxEvidenceRefs: 128,
                      maxSelectedFactorRecords: 8192,
                      maxFactsBytes: 4194304,
                      maxProjectionBytes: 2000000,
                    },
                    reportTemplates: [],
                    finalizationProfiles: [],
                    reviewClasses: [],
                    disclosurePolicies: [],
                  }
                : response,
          },
    );
  };
  return { env, fetchImpl, operations: () => operations };
}
test('V6 export and named-share downloads verify exact live metadata before publishing', async () => {
  const f = await records();
  for (const kind of ['export', 'share'] as const) {
    const record = kind === 'export' ? f.exported : f.share;
    const response =
      kind === 'export'
        ? {
            type: 'exportDownload',
            export: record,
            encoding: 'base64',
            bytes: f.signed.bytes.toString('base64'),
          }
        : {
            type: 'download',
            share: record,
            encoding: 'base64',
            bytes: f.signed.bytes.toString('base64'),
          };
    const r = remote(response, `${kind}.download`);
    const output = path.join(root(), 'report');
    const report = await runStudyExportFiles(
      'download',
      {
        apiVersion: 'v6',
        downloadKind: kind,
        inputFile: input(
          kind === 'export' ? { exportId: f.exported.exportId } : { shareId: f.share.shareId },
        ),
        outputDirectory: output,
        anchorsFile: input(f.signed.anchors),
        expectedFile: input(f.signed.expected),
      },
      r.fetchImpl,
      r.env,
    );
    assert.equal(report.rendererMatched, true);
    assert.equal(
      (report.authorizationAtDownload as { operation: string }).operation,
      `${kind}.download`,
    );
    assert(readFileSync(path.join(output, 'report.html')).equals(f.signed.html));
    assert.deepEqual(r.operations(), ['capability.read', `${kind}.download`]);
  }
});

test('V6 stale metadata, revoked reads and unsupported selection retain no published directory', async () => {
  const f = await records();
  for (const kind of ['export', 'share'] as const) {
    const record =
      kind === 'export'
        ? {
            ...f.exported,
            finalization: { ...f.exported.finalization, finalizationId: 'other-finalization' },
          }
        : { ...f.share, projectionRef: { ...f.share.projectionRef, contentHash: 'a'.repeat(64) } };
    const response =
      kind === 'export'
        ? {
            type: 'exportDownload',
            export: record,
            encoding: 'base64',
            bytes: f.signed.bytes.toString('base64'),
          }
        : {
            type: 'download',
            share: record,
            encoding: 'base64',
            bytes: f.signed.bytes.toString('base64'),
          };
    const r = remote(response, `${kind}.download`);
    const output = path.join(root(), 'refused');
    await refuses(
      runStudyExportFiles(
        'download',
        {
          apiVersion: 'v6',
          downloadKind: kind,
          inputFile: input(
            kind === 'export' ? { exportId: f.exported.exportId } : { shareId: f.share.shareId },
          ),
          outputDirectory: output,
          anchorsFile: input(f.signed.anchors),
          expectedFile: input(f.signed.expected),
        },
        r.fetchImpl,
        r.env,
      ),
      'STUDY_EXPORT_SELECTION',
    );
    assert.equal(existsSync(output), false);
  }
  const denied = remote(null, 'share.download', true);
  await refuses(
    runStudyExportFiles(
      'download',
      {
        apiVersion: 'v6',
        downloadKind: 'share',
        inputFile: input({ shareId: f.share.shareId }),
        outputDirectory: path.join(root(), 'denied'),
        anchorsFile: input(f.signed.anchors),
        expectedFile: input(f.signed.expected),
      },
      denied.fetchImpl,
      denied.env,
    ),
    'FORBIDDEN',
  );
});

test('V6 downloads bind the actual canonical bundle and manifest family to their selected descriptor', async () => {
  const f = await records();
  const historical = await signedExportFixture(undefined, { reviewed: true });
  const mislabeled = { ...f.signed.bundle, schemaVersion: 'lca.study-export-bundle.v2' };
  for (const mode of ['historical-manifest', 'wrong-envelope'] as const) {
    const signed = mode === 'historical-manifest' ? historical : f.signed;
    const bytes =
      mode === 'historical-manifest'
        ? Buffer.from(
            studyJson({ ...historical.bundle, schemaVersion: 'lca.study-export-bundle.v4' }),
          )
        : Buffer.from(studyJson(mislabeled));
    const exported = {
      ...f.exported,
      studyId: signed.expected.studyId,
      reportRevisionId: signed.expected.reportRevisionId,
      reportContentHash: signed.expected.reportContentHash,
      finalization: signed.manifest.finalization!,
      receipt: signed.receipt,
      projectionRef: {
        ...f.exported.projectionRef,
        contentHash: studyDigest(signed.projection),
        byteSize: signed.projection.length,
      },
      resourcesRef: {
        ...f.exported.resourcesRef,
        contentHash: studyDigest(signed.manifestBytes),
        byteSize: signed.manifestBytes.length,
      },
      bundleRef: {
        ...f.exported.bundleRef,
        contentHash: studyDigest(bytes),
        byteSize: bytes.length,
      },
    };
    const r = remote(
      {
        type: 'exportDownload',
        export: exported,
        encoding: 'base64',
        bytes: bytes.toString('base64'),
      },
      'export.download',
    );
    const output = path.join(root(), 'family-refused');
    await refuses(
      runStudyExportFiles(
        'download',
        {
          apiVersion: 'v6',
          downloadKind: 'export',
          inputFile: input({ exportId: exported.exportId }),
          outputDirectory: output,
          anchorsFile: input(signed.anchors),
          expectedFile: input(signed.expected),
        },
        r.fetchImpl,
        r.env,
      ),
      'STUDY_EXPORT_SELECTION',
    );
    assert.equal(existsSync(output), false);
  }
});
