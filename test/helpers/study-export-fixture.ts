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
      reviewIds: [],
      finalization: 'not_finalized',
    },
  };
}

/** Independent native-crypto test issuer; its private key never enters the export. */
export async function signedExportFixture(change?: (view: ReturnType<typeof exportView>) => void) {
  const loaded = await loadStudyRenderer(exportEnvironment());
  const view = exportView();
  change?.(view);
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
    schemaVersion: 'lca.study-export-manifest.v1',
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
    reviewIds: [],
    renderer: {
      version: '1.0.0',
      viewModelVersion: 'lca.study-report-view.v1',
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
      schemaVersion: 'lca.study-export-bundle.v1',
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
