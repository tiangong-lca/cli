import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { importStudyModule } from './study-codec.js';
import { readStudyBytes } from './study-intent.js';
import { studyDigest, studyFailure, studyObject, type StudyObject } from './study-protocol.js';

export const STUDY_RENDERER_ARCHIVE_SHA256 =
  '0eeb0ff800efed0936c221c5d68603c46d5362ff3aa1b36051c4308610a1f885';
export const STUDY_RENDERER_MANIFEST_SHA256 =
  'be659faa2869edfe1bca735e1509f7118c44a6312c8dbef143ff461bdc6c85bd';
export const STUDY_RENDERER_CANDIDATE_ENV = 'TIANGONG_LCA_STUDY_RENDERER_CANDIDATE_SHA256';
export const STUDY_V2_RENDERER_ARCHIVE_SHA256 =
  'dfbc7aa817996457b2d9a1c5c9d511f39c132e1523f9d1421a3ff1d74c7805fe';
export const STUDY_V2_RENDERER_MANIFEST_SHA256 =
  'b0c9bdd08a25b9a4ac22acf135f013602970049851725a9e612fe9e23ef6a50b';
export const STUDY_V2_RENDERER_CANDIDATE_ENV =
  'TIANGONG_LCA_STUDY_ADVANCED_RENDERER_CANDIDATE_SHA256';
export type StudyRendererVersion = 'v1' | 'v2';
const RENDERERS = {
  v1: {
    archive: 'study-report-renderer-1.0.0.tgz',
    version: '1.0.0',
    view: 'lca.study-report-view.v1',
    archiveSha256: STUDY_RENDERER_ARCHIVE_SHA256,
    manifestSha256: STUDY_RENDERER_MANIFEST_SHA256,
    candidate: STUDY_RENDERER_CANDIDATE_ENV,
  },
  v2: {
    archive: 'study-report-renderer-2.0.0.tgz',
    version: '2.0.0',
    view: 'lca.study-report-view.v2',
    archiveSha256: STUDY_V2_RENDERER_ARCHIVE_SHA256,
    manifestSha256: STUDY_V2_RENDERER_MANIFEST_SHA256,
    candidate: STUDY_V2_RENDERER_CANDIDATE_ENV,
  },
} as const;
export type StudyRenderer = {
  RENDERER_VERSION: string;
  VIEW_SCHEMA: string;
  validateReportView(input: unknown): StudyObject;
  validateRenderContext(input: unknown): StudyObject;
  renderReport(input: unknown, context: unknown): Promise<string>;
};
export type RendererPin = { archiveSha256: string; manifestSha256: string };

/** Pins are supplied by the trusted consumer, not by an untrusted report. */
export function verifyStudyRenderer(
  archive: Buffer,
  manifestBytes: Buffer,
  pin: RendererPin,
  readFile: (name: string) => Buffer,
  version: StudyRendererVersion = 'v1',
): { manifest: StudyObject; files: string[]; sources: ReadonlyMap<string, Buffer> } {
  if (
    studyDigest(archive) !== pin.archiveSha256 ||
    studyDigest(manifestBytes) !== pin.manifestSha256
  )
    studyFailure('STUDY_RENDERER_INTEGRITY');
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  } catch {
    return studyFailure('STUDY_RENDERER_INVALID');
  }
  if (
    !studyObject(manifest) ||
    manifest.schemaVersion !== 'lca.study-renderer-package.v1' ||
    manifest.rendererVersion !== RENDERERS[version].version ||
    manifest.viewModelVersion !== RENDERERS[version].view ||
    typeof manifest.sourceDirty !== 'boolean' ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 64
  )
    studyFailure('STUDY_RENDERER_INVALID');
  const names: string[] = [];
  const sources = new Map<string, Buffer>();
  for (const file of manifest.files) {
    if (
      !studyObject(file) ||
      typeof file.path !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(file.path) ||
      names.some((name) => name.toLowerCase() === String(file.path).toLowerCase()) ||
      typeof file.byteSize !== 'number' ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      file.byteSize > 2 * 1024 * 1024 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      studyFailure('STUDY_RENDERER_INVALID');
    const bytes = Buffer.from(readFile(file.path));
    if (bytes.length !== file.byteSize || studyDigest(bytes) !== file.sha256)
      studyFailure('STUDY_RENDERER_INTEGRITY');
    names.push(file.path);
    if (file.path.endsWith('.js')) sources.set(file.path, bytes);
  }
  if (
    !['index.js', 'package.json', 'render.js', 'viewModel.js', 'LICENSE'].every((name) =>
      names.includes(name),
    )
  )
    studyFailure('STUDY_RENDERER_INVALID');
  return { manifest, files: names, sources };
}

export function assertStudyRenderer(
  value: unknown,
  version: StudyRendererVersion = 'v1',
): StudyRenderer {
  if (
    !studyObject(value) ||
    value.RENDERER_VERSION !== RENDERERS[version].version ||
    value.VIEW_SCHEMA !== RENDERERS[version].view ||
    typeof value.validateReportView !== 'function' ||
    typeof value.validateRenderContext !== 'function' ||
    typeof value.renderReport !== 'function'
  )
    studyFailure('STUDY_RENDERER_INVALID');
  return value as unknown as StudyRenderer;
}

export function studyRendererRoot(
  moduleUrl = import.meta.url,
  version: StudyRendererVersion = 'v1',
): string {
  const root = [
    `../../assets/study-renderer/${version}/`,
    `../../../assets/study-renderer/${version}/`,
  ]
    .map((name) => new URL(name, moduleUrl))
    .find((candidate) => existsSync(new URL('package/manifest.json', candidate)));
  if (!root) studyFailure('STUDY_RENDERER_MISSING');
  return realpathSync(fileURLToPath(root));
}

/** A clean issuer artifact needs no development override; dirty artifacts cannot select Production. */
export function admitStudyRendererCandidate(
  manifest: StudyObject,
  env: NodeJS.ProcessEnv,
  version: StudyRendererVersion = 'v1',
): void {
  if (manifest.sourceDirty) {
    let loopback = false;
    try {
      loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(env.TIANGONG_LCA_API_BASE_URL ?? '').hostname,
      );
    } catch {
      /* Rejected below. */
    }
    if (env[RENDERERS[version].candidate] !== RENDERERS[version].archiveSha256 || !loopback)
      studyFailure('STUDY_RENDERER_CANDIDATE_REQUIRED');
  }
}

/**
 * Execute a private snapshot of the complete verified JS graph, without rewriting
 * owner source or reopening package files. Hooks are restricted to this unique
 * scheme and removed after graph evaluation; unrelated imports keep their owner.
 */
export async function instantiateStudyRenderer(
  sources: ReadonlyMap<string, Buffer>,
  version: StudyRendererVersion = 'v1',
): Promise<StudyRenderer> {
  const snapshot = new Map([...sources].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const prefix = `lca-study-renderer:///${randomUUID()}/`;
  const select = (url: string): Buffer => {
    const name = url.slice(prefix.length);
    const bytes = snapshot.get(name);
    if (!bytes || !/^[A-Za-z][A-Za-z0-9_.-]*\.js$/u.test(name))
      studyFailure('STUDY_RENDERER_INVALID');
    return bytes;
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(prefix)) {
        if (!/^\.\/[A-Za-z][A-Za-z0-9_.-]*\.js$/u.test(specifier))
          studyFailure('STUDY_RENDERER_INVALID');
        const url = new URL(specifier, context.parentURL).href;
        select(url);
        return { url, format: 'module', shortCircuit: true };
      }
      if (specifier.startsWith(prefix)) {
        select(specifier);
        return { url: specifier, format: 'module', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(prefix))
        return { format: 'module', source: select(url), shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  try {
    return assertStudyRenderer(await importStudyModule(`${prefix}index.js`), version);
  } catch {
    return studyFailure('STUDY_RENDERER_INVALID');
  } finally {
    hooks.deregister();
  }
}

export async function loadStudyRenderer(
  env: NodeJS.ProcessEnv,
  version: StudyRendererVersion = 'v1',
): Promise<{ renderer: StudyRenderer; artifactHash: string }> {
  const root = studyRendererRoot(import.meta.url, version);
  const packageRoot = realpathSync(path.join(root, 'package'));
  const read = (name: string): Buffer => {
    const file = path.join(packageRoot, name);
    if (!lstatSync(file).isFile() || realpathSync(file) !== file)
      studyFailure('STUDY_RENDERER_INTEGRITY');
    return readStudyBytes(file, 2 * 1024 * 1024);
  };
  const verified = verifyStudyRenderer(
    readStudyBytes(path.join(root, RENDERERS[version].archive), 2 * 1024 * 1024),
    read('manifest.json'),
    {
      archiveSha256: RENDERERS[version].archiveSha256,
      manifestSha256: RENDERERS[version].manifestSha256,
    },
    read,
    version,
  );
  const inventory = [...verified.files, 'manifest.json'].sort();
  if (JSON.stringify(readdirSync(packageRoot).sort()) !== JSON.stringify(inventory))
    studyFailure('STUDY_RENDERER_INTEGRITY');
  admitStudyRendererCandidate(verified.manifest, env, version);
  const renderer = await instantiateStudyRenderer(verified.sources, version);
  return { renderer, artifactHash: RENDERERS[version].archiveSha256 };
}
