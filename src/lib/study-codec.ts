import { existsSync, readFileSync } from 'node:fs';
import {
  studyDigest,
  studyFailure,
  studyObject,
  type StudyObject,
  type StudyRequest,
  type StudyApiVersion,
} from './study-protocol.js';

export const STUDY_CODEC_MANIFEST_SHA256 =
  '6bdde9dcad10f2bfc474dd70f0bf3deb693cb7536137ef827a71fb879d792459';
export const STUDY_CODEC_CANDIDATE_ENV = 'TIANGONG_LCA_STUDY_CONTRACT_CANDIDATE_SHA256';
export const STUDY_V3_CODEC_MANIFEST_SHA256 =
  '983e4b9941e735e060dca3222d16c41018510def509615c94beaa79816e1a960';
export const STUDY_V3_CODEC_CANDIDATE_ENV = 'TIANGONG_LCA_STUDY_REPORT_CONTRACT_CANDIDATE_SHA256';
export const STUDY_V4_CODEC_MANIFEST_SHA256 =
  'a590d3aa43fadf1693670af62d89b148953d7ac2e3ef82b2a5f39e33e03173dc';
export const STUDY_V4_CODEC_CANDIDATE_ENV = 'TIANGONG_LCA_STUDY_REVIEW_CONTRACT_CANDIDATE_SHA256';
export const STUDY_V5_CODEC_MANIFEST_SHA256 =
  '3eea620ab4041f1a6fcfab34bd2afd275f8cbd3cbcf56ba6a187076e9bb3cf94';
export const STUDY_V5_CODEC_CANDIDATE_ENV = 'TIANGONG_LCA_STUDY_ADVANCED_CONTRACT_CANDIDATE_SHA256';
const CONTRACT_VERSIONS = { v2: '2.0.0', v3: '3.0.0', v4: '4.0.0', v5: '5.0.0' } as const;
export type StudyCodec = {
  API_SCHEMA: string;
  CONTRACT_VERSION: string;
  // Structural transport bridge only; complete owner declarations ship unchanged.
  parseRequest(value: unknown): StudyRequest;
  parseResponse(
    value: unknown,
  ): { schemaVersion: string; requestId: string } & (
    { ok: true; data: StudyObject } | { ok: false; code: string }
  );
  validateResponseForRequest(request: StudyRequest, response: unknown): void;
  operationMetadata: Readonly<
    Record<string, Readonly<{ operation: string; kind: 'query' | 'mutation' }>>
  >;
  analysisConfigHash?: (input: unknown) => Promise<string>;
  parseExportBundle?: (bytes: Uint8Array) => {
    manifestBytes: Uint8Array;
    receipt: unknown;
    files: Array<{ path: 'report.html' | 'projection.json'; bytes: Uint8Array }>;
  };
  verifyExport?: (
    manifest: Uint8Array,
    receipt: unknown,
    files: ReadonlyArray<{ path: 'report.html' | 'projection.json'; bytes: Uint8Array }>,
    anchors: readonly unknown[],
    expected: {
      issuerId: string;
      exportId: string;
      studyId: string;
      reportRevisionId: string;
      reportContentHash: string;
    },
  ) => Promise<StudyObject>;
  verifyVersionedExport?: NonNullable<StudyCodec['verifyExport']>;
  canonicalReceiptBytes?: (receipt: unknown) => Uint8Array;
  validateExportViewBindings?: (view: unknown, manifest: unknown) => void;
};

export type StudyReportingCodec = StudyCodec &
  Required<
    Pick<
      StudyCodec,
      | 'analysisConfigHash'
      | 'parseExportBundle'
      | 'verifyExport'
      | 'canonicalReceiptBytes'
      | 'validateExportViewBindings'
    >
  >;

export type StudyReviewCodec = StudyCodec &
  Required<
    Pick<
      StudyCodec,
      | 'parseExportBundle'
      | 'verifyExport'
      | 'verifyVersionedExport'
      | 'canonicalReceiptBytes'
      | 'validateExportViewBindings'
    >
  >;
export type StudyAdvancedCodec = StudyReviewCodec & Pick<StudyReportingCodec, 'analysisConfigHash'>;
/** Generic verification receives its expected digest from a separate caller trust anchor. */
export function verifyStudyCodecArtifact(
  manifestBytes: Buffer,
  expectedDigest: string,
  readOwnedFile: (name: string) => Buffer,
  version: StudyApiVersion = 'v2',
): { manifest: StudyObject; code: Buffer } {
  if (studyDigest(manifestBytes) !== expectedDigest) studyFailure('STUDY_CONTRACT_INTEGRITY');
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch {
    return studyFailure('STUDY_CONTRACT_INVALID');
  }
  if (
    !studyObject(manifest) ||
    manifest.schemaVersion !== 'lca.study-consumer-manifest.v1' ||
    manifest.apiSchema !== `lca.study-api.${version}` ||
    manifest.contractVersion !== CONTRACT_VERSIONS[version] ||
    manifest.sourceRepository !== 'tiangong-lca/edge-functions' ||
    typeof manifest.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 16
  )
    studyFailure('STUDY_CONTRACT_INVALID');
  if (manifest.sourceStatus !== 'worktree' && manifest.sourceStatus !== 'committed')
    studyFailure('STUDY_CONTRACT_INVALID');
  let code: Buffer | undefined;
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (
      !studyObject(file) ||
      typeof file.path !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(file.path) ||
      names.has(file.path) ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      typeof file.bytes !== 'number' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 8 * 1024 * 1024
    )
      studyFailure('STUDY_CONTRACT_INVALID');
    names.add(file.path);
    const bytes = readOwnedFile(file.path);
    if (bytes.byteLength !== file.bytes || studyDigest(bytes) !== file.sha256)
      studyFailure('STUDY_CONTRACT_INTEGRITY');
    if (file.path === 'index.mjs') code = bytes;
  }
  if (!code) studyFailure('STUDY_CONTRACT_INVALID');
  return { manifest, code };
}

export function admitStudyCodecCandidate(
  manifest: StudyObject,
  env: NodeJS.ProcessEnv,
  expectedDigest: string,
  version: StudyApiVersion = 'v2',
): void {
  if (manifest.sourceStatus === 'committed') return;
  if (manifest.sourceStatus !== 'worktree') studyFailure('STUDY_CONTRACT_INVALID');
  let loopback = false;
  try {
    loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(env.TIANGONG_LCA_API_BASE_URL ?? '').hostname,
    );
  } catch {
    /* Rejected by the explicit admission check. */
  }
  if (
    env[
      {
        v2: STUDY_CODEC_CANDIDATE_ENV,
        v3: STUDY_V3_CODEC_CANDIDATE_ENV,
        v4: STUDY_V4_CODEC_CANDIDATE_ENV,
        v5: STUDY_V5_CODEC_CANDIDATE_ENV,
      }[version]
    ] !== expectedDigest ||
    !loopback
  )
    studyFailure('STUDY_CONTRACT_CANDIDATE_REQUIRED');
}

export function assertStudyCodecModule(
  value: unknown,
  version: StudyApiVersion = 'v2',
): StudyCodec {
  if (
    !studyObject(value) ||
    value.API_SCHEMA !== `lca.study-api.${version}` ||
    value.CONTRACT_VERSION !== CONTRACT_VERSIONS[version] ||
    typeof value.parseRequest !== 'function' ||
    typeof value.parseResponse !== 'function' ||
    typeof value.validateResponseForRequest !== 'function' ||
    !studyObject(value.operationMetadata)
  )
    studyFailure('STUDY_CONTRACT_INVALID');
  if (
    version !== 'v2' &&
    (((version === 'v3' || version === 'v5') && typeof value.analysisConfigHash !== 'function') ||
      typeof value.parseExportBundle !== 'function' ||
      typeof value.verifyExport !== 'function' ||
      typeof value.canonicalReceiptBytes !== 'function' ||
      typeof value.validateExportViewBindings !== 'function')
  )
    studyFailure('STUDY_CONTRACT_INVALID');
  if ((version === 'v4' || version === 'v5') && typeof value.verifyVersionedExport !== 'function')
    studyFailure('STUDY_CONTRACT_INVALID');
  return value as unknown as StudyCodec;
}

export function studyCodecRoot(moduleUrl = import.meta.url, version: StudyApiVersion = 'v2'): URL {
  const root = [
    `../../assets/study-contract/${version}/`,
    `../../../assets/study-contract/${version}/`,
  ]
    .map((value) => new URL(value, moduleUrl))
    .find((value) => existsSync(new URL('manifest.json', value)));
  if (!root) studyFailure('STUDY_CONTRACT_MISSING');
  return root;
}

/** The command uses these pinned package artifacts only, never a sibling/custom codec. */
export function loadStudyCodec(env: NodeJS.ProcessEnv, version: 'v3'): Promise<StudyReportingCodec>;
export function loadStudyCodec(env: NodeJS.ProcessEnv, version: 'v4'): Promise<StudyReviewCodec>;
export function loadStudyCodec(env: NodeJS.ProcessEnv, version: 'v5'): Promise<StudyAdvancedCodec>;
export function loadStudyCodec(
  env: NodeJS.ProcessEnv,
  version?: StudyApiVersion,
): Promise<StudyCodec>;
export async function loadStudyCodec(
  env: NodeJS.ProcessEnv,
  version: StudyApiVersion = 'v2',
): Promise<StudyCodec> {
  const root = studyCodecRoot(import.meta.url, version);
  const digest = {
    v2: STUDY_CODEC_MANIFEST_SHA256,
    v3: STUDY_V3_CODEC_MANIFEST_SHA256,
    v4: STUDY_V4_CODEC_MANIFEST_SHA256,
    v5: STUDY_V5_CODEC_MANIFEST_SHA256,
  }[version];
  const { manifest, code } = verifyStudyCodecArtifact(
    readFileSync(new URL('manifest.json', root)),
    digest,
    (file) => readFileSync(new URL(file, root)),
    version,
  );
  admitStudyCodecCandidate(manifest, env, digest, version);
  return instantiateStudyCodec(code, version);
}

/** Internal ESM compatibility bridge. Only callers with independently verified bytes/paths may use it. */
export async function importStudyModule(url: string): Promise<unknown> {
  return import(url);
}

/** Caller must verify these bytes against its independent artifact trust anchor first. */
export async function instantiateStudyCodec(
  code: Buffer,
  version: StudyApiVersion = 'v2',
): Promise<StudyCodec> {
  let module: unknown;
  try {
    module = await importStudyModule(`data:text/javascript;base64,${code.toString('base64')}`);
  } catch {
    return studyFailure('STUDY_CONTRACT_INVALID');
  }
  return assertStudyCodecModule(module, version);
}
