import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadStudyCodec } from './study-codec.js';
import { CliError } from './errors.js';
import { readStudyBytes, readStudyJson } from './study-intent.js';
import {
  assertStudySafe,
  STUDY_ARTIFACT_LIMIT,
  studyDigest,
  studyFailure,
  studyObject,
  type StudyObject,
} from './study-protocol.js';
import { loadStudyRenderer } from './study-renderer.js';
import type { FetchLike } from './http.js';
import { runStudyRequest } from './study-transport.js';

export type StudyExportExpected = {
  issuerId: string;
  exportId: string;
  studyId: string;
  reportRevisionId: string;
  reportContentHash: string;
};
export type VerifiedStudyExport = {
  manifest: StudyObject;
  manifestBytes: Buffer;
  receiptBytes: Buffer;
  files: Array<{ path: 'report.html' | 'projection.json'; bytes: Uint8Array }>;
};
const FILES = ['export-manifest.json', 'export-receipt.json', 'projection.json', 'report.html'];

export function readStudyExportTrust(
  anchorsFile: string,
  expectedFile: string,
): { anchors: readonly unknown[]; expected: StudyExportExpected } {
  const anchors = readStudyJson(anchorsFile);
  const expected = readStudyJson(expectedFile);
  assertStudySafe(anchors);
  assertStudySafe(expected);
  if (
    !Array.isArray(anchors) ||
    !studyObject(expected) ||
    Object.keys(expected).sort().join(',') !==
      'exportId,issuerId,reportContentHash,reportRevisionId,studyId' ||
    !Object.values(expected).every((value) => typeof value === 'string')
  )
    studyFailure('STUDY_EXPORT_TRUST_INVALID');
  return { anchors, expected: expected as StudyExportExpected };
}

async function verifyParts(
  parts: { manifestBytes: Uint8Array; receipt: unknown; files: VerifiedStudyExport['files'] },
  anchors: readonly unknown[],
  expected: StudyExportExpected,
  env: NodeJS.ProcessEnv,
  originalReceiptBytes?: Uint8Array,
): Promise<VerifiedStudyExport> {
  const codec = await loadStudyCodec(env, 'v4');
  let manifest: StudyObject;
  try {
    if (
      originalReceiptBytes &&
      !Buffer.from(codec.canonicalReceiptBytes(parts.receipt)).equals(
        Buffer.from(originalReceiptBytes),
      )
    )
      studyFailure('STUDY_EXPORT_VERIFICATION_FAILED');
    manifest = await codec.verifyVersionedExport(
      parts.manifestBytes,
      parts.receipt,
      parts.files,
      anchors,
      expected,
    );
  } catch {
    return studyFailure('STUDY_EXPORT_VERIFICATION_FAILED');
  }
  const loaded = await loadStudyRenderer(env);
  const identity = manifest.renderer as { artifactHash: string };
  if (identity.artifactHash !== loaded.artifactHash) studyFailure('STUDY_EXPORT_RENDERER_MISMATCH');
  try {
    const projection = parts.files.find((file) => file.path === 'projection.json')!;
    const html = parts.files.find((file) => file.path === 'report.html')!;
    const view: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(projection.bytes),
    );
    const validated = loaded.renderer.validateReportView(view);
    const bindings =
      manifest.schemaVersion === 'lca.study-export-manifest.v1'
        ? await loadStudyCodec(env, 'v3')
        : codec;
    bindings.validateExportViewBindings(validated, manifest);
    const descriptor = (manifest.files as Array<{ path: string; sha256: string }>).find(
      (file) => file.path === 'projection.json',
    )!;
    const context = loaded.renderer.validateRenderContext({
      exportId: manifest.exportId,
      projectionHash: descriptor.sha256,
      verificationAtGeneration: 'verified_by_trusted_exporter',
    });
    const rendered = Buffer.from(await loaded.renderer.renderReport(validated, context), 'utf8');
    if (!rendered.equals(Buffer.from(html.bytes))) studyFailure('STUDY_EXPORT_RENDERER_MISMATCH');
    return {
      manifest,
      manifestBytes: Buffer.from(parts.manifestBytes),
      receiptBytes: Buffer.from(codec.canonicalReceiptBytes(parts.receipt)),
      files: parts.files,
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    return studyFailure('STUDY_EXPORT_RENDERER_MISMATCH');
  }
}

export async function verifyStudyExportBundle(
  bytes: Uint8Array,
  anchors: readonly unknown[],
  expected: StudyExportExpected,
  env: NodeJS.ProcessEnv,
): Promise<VerifiedStudyExport> {
  const codec = await loadStudyCodec(env, 'v4');
  let parts;
  try {
    parts = codec.parseExportBundle(bytes);
  } catch {
    return studyFailure('STUDY_EXPORT_VERIFICATION_FAILED');
  }
  return verifyParts(parts, anchors, expected, env);
}

export async function verifyStudyExportDirectory(
  directory: string,
  anchors: readonly unknown[],
  expected: StudyExportExpected,
  env: NodeJS.ProcessEnv,
): Promise<VerifiedStudyExport> {
  const root = path.resolve(directory);
  try {
    if (
      !lstatSync(root).isDirectory() ||
      JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(FILES)
    )
      studyFailure('STUDY_EXPORT_DIRECTORY_INVALID');
  } catch {
    return studyFailure('STUDY_EXPORT_DIRECTORY_INVALID');
  }
  const parts = {
    manifestBytes: readStudyBytes(path.join(root, 'export-manifest.json')),
    receipt: readStudyJson(path.join(root, 'export-receipt.json')),
    files: [
      {
        path: 'report.html' as const,
        bytes: readStudyBytes(path.join(root, 'report.html'), STUDY_ARTIFACT_LIMIT),
      },
      {
        path: 'projection.json' as const,
        bytes: readStudyBytes(path.join(root, 'projection.json'), STUDY_ARTIFACT_LIMIT),
      },
    ],
  };
  return verifyParts(
    parts,
    anchors,
    expected,
    env,
    readStudyBytes(path.join(root, 'export-receipt.json')),
  );
}

/**
 * Complete a private sibling stage before one directory rename. The final path
 * is never used for writes or cleanup. Node has no portable directory
 * RENAME_NOREPLACE: a concurrently created empty directory can be replaced on
 * POSIX. Existing targets observed before publication are refused; nonempty
 * directories and symlinks cannot redirect writes. The parent is trusted local
 * storage, not an adversarial same-UID ancestor-mutation boundary.
 */
export function publishStudyExport(
  directory: string,
  verified: VerifiedStudyExport,
): Array<{ path: string; sha256: string; byteSize: number }> {
  const root = path.resolve(directory);
  let existing;
  try {
    existing = lstatSync(root, { throwIfNoEntry: false });
  } catch {
    return studyFailure('STUDY_OUTPUT_WRITE_FAILED');
  }
  if (existing) studyFailure('STUDY_OUTPUT_EXISTS');
  const files = [
    { path: 'export-manifest.json', bytes: verified.manifestBytes },
    ...verified.files,
    { path: 'export-receipt.json', bytes: verified.receiptBytes },
  ];
  let stage: string | undefined;
  try {
    const parent = path.dirname(root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    stage = mkdtempSync(path.join(parent, '.study-export-'));
    const identity = lstatSync(stage);
    const outputs: Array<{ path: string; sha256: string; byteSize: number }> = [];
    for (const file of files) {
      const output = path.join(stage, file.path);
      const fd = openSync(output, 'wx', 0o600);
      try {
        // The exclusive handle remains the write target even if a filename moves.
        writeFileSync(fd, file.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      outputs.push({
        path: path.join(root, file.path),
        sha256: studyDigest(file.bytes),
        byteSize: file.bytes.byteLength,
      });
    }
    const current = lstatSync(stage);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      lstatSync(root, { throwIfNoEntry: false })
    )
      studyFailure('STUDY_OUTPUT_WRITE_FAILED');
    renameSync(stage, root);
    return outputs;
  } catch {
    // No path-based rollback: replaced/uncertain entries are never deleted. A
    // failed private stage is deliberately retained for explicit inspection.
    return studyFailure(
      'STUDY_OUTPUT_WRITE_FAILED',
      stage
        ? {
            stagingDirectory: stage,
            stagingDisposition: 'retained-inspect-before-cleanup',
            stagingIdentity: 'unverified-after-failure',
          }
        : {},
    );
  }
}

export type StudyExportFileOptions = {
  anchorsFile: string;
  expectedFile: string;
  directory?: string;
  bundleFile?: string;
  inputFile?: string;
  outputDirectory?: string;
  timeoutMs?: number;
  apiVersion?: 'v3' | 'v4';
  downloadKind?: 'export' | 'share';
};

/** Offline verification never obtains a token or contacts the API. */
export async function runStudyExportFiles(
  action: 'verify' | 'download',
  options: StudyExportFileOptions,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<StudyObject> {
  const { anchors, expected } = readStudyExportTrust(options.anchorsFile, options.expectedFile);
  let verified: VerifiedStudyExport;
  let outputs: ReturnType<typeof publishStudyExport> | undefined;
  let authorizationAtDownload: StudyObject | undefined;
  if (action === 'verify') {
    verified = options.directory
      ? await verifyStudyExportDirectory(options.directory, anchors, expected, env)
      : await verifyStudyExportBundle(
          readStudyBytes(options.bundleFile as string, STUDY_ARTIFACT_LIMIT),
          anchors,
          expected,
          env,
        );
  } else {
    if (!options.inputFile || !options.outputDirectory) studyFailure('INVALID_ARGS');
    const input = readStudyJson(options.inputFile);
    const version = options.apiVersion ?? 'v3';
    const kind = options.downloadKind ?? 'export';
    if (
      !studyObject(input) ||
      (version === 'v3'
        ? input.studyId !== expected.studyId ||
          !studyObject(input.artifactRef) ||
          input.artifactRef.type !== 'reportExportBundle'
        : kind === 'export'
          ? input.exportId !== expected.exportId
          : typeof input.shareId !== 'string')
    )
      studyFailure('STUDY_EXPORT_SELECTION');
    if (existsSync(options.outputDirectory)) studyFailure('STUDY_OUTPUT_EXISTS');
    await loadStudyCodec(env, version);
    await loadStudyRenderer(env);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'tiangong-study-export-'));
    try {
      const bundle = path.join(scratch, 'bundle.json');
      const operation = version === 'v3' ? 'artifact.read' : `${kind}.download`;
      const download = await runStudyRequest(operation, input, {
        env,
        fetchImpl,
        apiVersion: version,
        outputPath: bundle,
        timeoutMs: options.timeoutMs,
      });
      verified = await verifyStudyExportBundle(
        readStudyBytes(bundle, STUDY_ARTIFACT_LIMIT),
        anchors,
        expected,
        env,
      );
      if (version === 'v4') {
        const record = download.data[kind] as StudyObject;
        const finalizationId =
          kind === 'export'
            ? (record.finalization as StudyObject).finalizationId
            : record.finalizationId;
        const projection = (
          verified.manifest.files as Array<{ path: string; sha256: string }>
        ).find((file) => file.path === 'projection.json')!;
        if (
          record.studyId !== expected.studyId ||
          record.reportRevisionId !== expected.reportRevisionId ||
          record.reportContentHash !== expected.reportContentHash ||
          record.exportId !== expected.exportId ||
          !studyObject(verified.manifest.finalization) ||
          verified.manifest.finalization.finalizationId !== finalizationId ||
          (record.projectionRef as StudyObject).contentHash !== projection.sha256 ||
          (kind === 'export' &&
            !Buffer.from(
              (await loadStudyCodec(env, 'v4')).canonicalReceiptBytes(record.receipt),
            ).equals(verified.receiptBytes))
        )
          studyFailure('STUDY_EXPORT_SELECTION');
        authorizationAtDownload = {
          operation,
          resourceId: input[kind === 'export' ? 'exportId' : 'shareId'],
          scope: 'server-authorized-exact-bundle-at-download',
        };
      }
      outputs = publishStudyExport(options.outputDirectory, verified);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    schemaVersion: 'tiangong.cli.study-export-verification.v1',
    signatureVerified: true,
    filesVerified: true,
    rendererMatched: true,
    scope: 'detached-bytes-and-renderer-consistency',
    currentAccess: 'not-checked-offline',
    currentReview: 'not-checked-offline',
    ...expected,
    ...(verified.manifest.finalization
      ? { historicalFinalization: verified.manifest.finalization }
      : {}),
    ...(authorizationAtDownload ? { authorizationAtDownload } : {}),
    ...(outputs ? { outputs } : {}),
  };
}
