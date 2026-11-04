import { generateKeyPairSync, sign } from 'node:crypto';
import { loadStudyRenderer } from '../../src/lib/study-renderer.js';
import { studyDigest, studyJson } from '../../src/lib/study-protocol.js';

export const EXPORT_TIME = '2026-11-03T00:00:00Z';
export function exportEnvironment(): NodeJS.ProcessEnv {
  return {
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
  };
}
export function exportView() {
  return {
    schemaVersion: 'lca.study-report-view.v1',
    rendererVersion: '1.0.0',
    report: {
      studyId: 'study-export',
      reportRevisionId: 'report-export',
      contentHash: 'a'.repeat(64),
      title: 'Unreviewed test fixture',
      generatedAt: EXPORT_TIME,
    },
    definition: {
      goal: 'Consumer protocol fixture, not a scientific study.',
      functionalUnit: { amount: '1.000', unit: 'kg', referenceFlowId: 'flow' },
      boundary: 'Synthetic bounded gate-to-gate.',
      methodRefs: [
        { id: 'method-climate', version: '01.00.000', name: 'Climate', unit: 'kg CO2 eq' },
      ],
    },
    runs: [
      {
        runId: 'run-export',
        scenarioRevisionId: 'scenario-export',
        label: 'Baseline',
        inputHash: 'b'.repeat(64),
        profileId: 'lca.study-explicit-v1',
        calculationContractRef: {
          kind: 'calculation_contract',
          schema: 'lca.calculation-contract.v1',
          sha256: 'c'.repeat(64),
        },
      },
    ],
    facts: [
      {
        factId: 'fact-zero',
        label: 'Characterized subtotal',
        runIds: ['run-export'],
        methodRef: { id: 'method-climate', version: '01.00.000' },
        canonicalValue: '0',
        unit: 'kg CO2 eq',
        coverage: 'partial',
        provenance: { type: 'analysisFacts', id: 'facts-export', contentHash: 'd'.repeat(64) },
      },
    ],
    sections: [],
    tables: [{ tableId: 'table', title: 'Exact facts', factIds: ['fact-zero'] }],
    charts: [],
    citations: [],
    assumptions: [],
    cutoffs: [],
    limitations: ['Synthetic consumer evidence. Incomplete coverage is not complete LCIA.'],
    snapshot: {
      validity: 'current',
      checkedAt: EXPORT_TIME,
      review: 'unreviewed',
      reviewIds: [] as string[],
      finalization: 'not_finalized',
    },
  };
}

type AdvancedExportFact = Omit<
  ReturnType<typeof exportView>['facts'][number],
  'canonicalValue' | 'methodRef'
> & {
  methodRef: { id: string; version: string } | null;
  canonicalValue: string | null;
  reasonCodes: string[];
};
export function advancedExportView() {
  const base = exportView();
  return {
    ...base,
    schemaVersion: 'lca.study-report-view.v2',
    rendererVersion: '2.0.0',
    facts: base.facts.map((fact) => ({
      ...fact,
      reasonCodes: [] as string[],
      canonicalValue: fact.canonicalValue as string | null,
    })) as AdvancedExportFact[],
  };
}
/** Independent native-crypto test issuer; its private key never enters the export. */
export async function signedExportFixture(
  change?: (view: ReturnType<typeof exportView>) => void,
  finalized?: { reviewed: boolean },
) {
  const view = exportView();
  if (finalized) {
    view.snapshot.finalization = 'finalized';
    view.snapshot.review = finalized.reviewed ? 'reviewed' : 'unreviewed';
    view.snapshot.reviewIds = finalized.reviewed ? ['review-fixture'] : [];
  }
  change?.(view);
  return { ...(await issueExportFixture(view, 'v1', finalized)), view };
}
export async function signedAdvancedExportFixture(
  change?: (view: ReturnType<typeof advancedExportView>) => void,
  finalized = { reviewed: true },
) {
  const view = advancedExportView();
  view.snapshot.finalization = 'finalized';
  view.snapshot.review = finalized.reviewed ? 'reviewed' : 'unreviewed';
  view.snapshot.reviewIds = finalized.reviewed ? ['review-fixture'] : [];
  change?.(view);
  return { ...(await issueExportFixture(view, 'v2', finalized)), view };
}
async function issueExportFixture(
  view: ReturnType<typeof exportView> | ReturnType<typeof advancedExportView>,
  version: 'v1' | 'v2',
  finalized?: { reviewed: boolean },
) {
  const loaded = await loadStudyRenderer(exportEnvironment(), version);
  const projection = Buffer.from(studyJson(view));
  const html = Buffer.from(
    await loaded.renderer.renderReport(view, {
      exportId: 'export-fixture',
      projectionHash: studyDigest(projection),
      verificationAtGeneration: 'verified_by_trusted_exporter',
    }),
  );
  const key = generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion:
      version === 'v2'
        ? 'lca.study-export-manifest.v3'
        : finalized
          ? 'lca.study-export-manifest.v2'
          : 'lca.study-export-manifest.v1',
    issuerId: 'fixture-issuer',
    exportId: 'export-fixture',
    studyId: 'study-export',
    reportRevisionId: 'report-export',
    reportContentHash: 'a'.repeat(64),
    actorId: 'actor-export',
    clientId: null,
    grantEpoch: 1,
    policyId: 'lca.study-report-disclosure.v1',
    disclosureContextHash: 'e'.repeat(64),
    generatedAt: EXPORT_TIME,
    validitySnapshot: { status: 'current', checkedAt: EXPORT_TIME, reasonCodes: [] },
    reviewIds: view.snapshot.reviewIds,
    ...(finalized
      ? {
          finalization: {
            studyId: view.report.studyId,
            reportRevisionId: view.report.reportRevisionId,
            reportContentHash: view.report.contentHash,
            finalizationId: 'finalization-fixture',
            actorId: '11111111-1111-4111-8111-111111111111',
            profileId: finalized.reviewed
              ? 'lca.study-report-internal-review.v1'
              : 'lca.study-report-unreviewed.v1',
            expectedReviewStateHash: 'f'.repeat(64),
            acceptedReviewIds: view.snapshot.reviewIds,
            finalizedAt: EXPORT_TIME,
          },
        }
      : {}),
    renderer: {
      version: view.rendererVersion,
      viewModelVersion: view.schemaVersion,
      artifactHash: loaded.artifactHash,
    },
    files: [
      {
        path: 'report.html',
        mediaType: 'text/html',
        sha256: studyDigest(html),
        byteSize: html.length,
      },
      {
        path: 'projection.json',
        mediaType: 'application/json',
        sha256: studyDigest(projection),
        byteSize: projection.length,
      },
    ],
  };
  function signManifest(value = manifest) {
    const manifestBytes = Buffer.from(studyJson(value));
    const signed = Buffer.concat([Buffer.from('lca.study-export-signature.v1\0'), manifestBytes]);
    const receipt = {
      schemaVersion: 'lca.study-export-receipt.v2',
      keyId: 'fixture-key',
      algorithm: 'Ed25519',
      manifestHash: studyDigest(signed),
      signature: sign(null, signed, key.privateKey).toString('base64url'),
    };
    const bundle = {
      schemaVersion:
        version === 'v2'
          ? 'lca.study-export-bundle.v3'
          : finalized
            ? 'lca.study-export-bundle.v2'
            : 'lca.study-export-bundle.v1',
      manifestBase64: manifestBytes.toString('base64'),
      receipt,
      files: [
        { path: 'report.html', encoding: 'base64', bytes: html.toString('base64') },
        { path: 'projection.json', encoding: 'base64', bytes: projection.toString('base64') },
      ],
    };
    return { manifestBytes, receipt, bundle, bytes: Buffer.from(studyJson(bundle)) };
  }
  const anchors = [
    {
      issuerId: 'fixture-issuer',
      keyId: 'fixture-key',
      publicKeySpki: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2027-01-01T00:00:00Z',
      rendererArtifactHashes: [loaded.artifactHash],
    },
  ];
  const expected = {
    issuerId: 'fixture-issuer',
    exportId: 'export-fixture',
    studyId: 'study-export',
    reportRevisionId: 'report-export',
    reportContentHash: 'a'.repeat(64),
  };
  return { ...signManifest(), anchors, expected, view, manifest, html, projection, signManifest };
}
