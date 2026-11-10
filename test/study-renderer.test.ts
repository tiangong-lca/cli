import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from '../src/shared/errors.js';
import { studyDigest } from '../src/lib/study/protocol.js';
import {
  assertStudyRenderer,
  admitStudyRendererCandidate,
  loadStudyRenderer,
  instantiateStudyRenderer,
  studyRendererRoot,
  verifyStudyRenderer,
  STUDY_RENDERER_ARCHIVE_SHA256,
  STUDY_RENDERER_CANDIDATE_ENV,
  STUDY_RENDERER_MANIFEST_SHA256,
} from '../src/lib/study/renderer.js';
import { importStudyModule } from '../src/lib/study/codec.js';
import { exportEnvironment, exportView } from './helpers/study-export-fixture.js';

function fails(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof CliError && error.code === code);
}
test('Renderer pins and closed inventory reject corrupt, foreign, duplicate and traversing packages', () => {
  const root = studyRendererRoot();
  const archive = readFileSync(path.join(root, 'study-report-renderer-1.0.0.tgz'));
  const bytes = readFileSync(path.join(root, 'package/manifest.json'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  const read = (name: string) => readFileSync(path.join(root, 'package', name));
  const check = (value: unknown, reader = read) => {
    const content = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    return verifyStudyRenderer(
      archive,
      content,
      {
        archiveSha256: STUDY_RENDERER_ARCHIVE_SHA256,
        manifestSha256: studyDigest(content),
      },
      reader,
    );
  };
  assert(check(manifest).files.includes('index.js'));
  fails(
    () =>
      verifyStudyRenderer(
        Buffer.from('bad'),
        bytes,
        {
          archiveSha256: STUDY_RENDERER_ARCHIVE_SHA256,
          manifestSha256: STUDY_RENDERER_MANIFEST_SHA256,
        },
        read,
      ),
    'STUDY_RENDERER_INTEGRITY',
  );
  fails(
    () =>
      verifyStudyRenderer(
        archive,
        Buffer.from('bad'),
        {
          archiveSha256: STUDY_RENDERER_ARCHIVE_SHA256,
          manifestSha256: STUDY_RENDERER_MANIFEST_SHA256,
        },
        read,
      ),
    'STUDY_RENDERER_INTEGRITY',
  );
  for (const value of [
    '{',
    null,
    { ...manifest, schemaVersion: 'foreign' },
    { ...manifest, rendererVersion: '9' },
    { ...manifest, viewModelVersion: 'foreign' },
    { ...manifest, sourceDirty: null },
    { ...manifest, files: null },
    { ...manifest, files: Array(65).fill(null) },
    { ...manifest, files: [] },
  ])
    fails(() => check(value), 'STUDY_RENDERER_INVALID');
  const first = manifest.files[0];
  for (const entry of [
    null,
    { ...first, path: '../index.js' },
    { ...first, path: 1 },
    { ...first, byteSize: null },
    { ...first, byteSize: 0.5 },
    { ...first, byteSize: -1 },
    { ...first, byteSize: 2 * 1024 * 1024 + 1 },
    { ...first, sha256: null },
    { ...first, sha256: 'X'.repeat(64) },
  ])
    fails(() => check({ ...manifest, files: [entry] }), 'STUDY_RENDERER_INVALID');
  fails(() => check({ ...manifest, files: [first, first] }), 'STUDY_RENDERER_INVALID');
  fails(
    () => check({ ...manifest, files: [first, { ...first, path: first.path.toUpperCase() }] }),
    'STUDY_RENDERER_INVALID',
  );
  fails(() => check(manifest, () => Buffer.from('changed bytes')), 'STUDY_RENDERER_INTEGRITY');
  fails(
    () =>
      check(manifest, (name) => {
        const changed = Buffer.from(read(name));
        changed[0] ^= 1;
        return changed;
      }),
    'STUDY_RENDERER_INTEGRITY',
  );
});

test('Renderer ABI, layout and explicit development policy cannot select arbitrary code or Production', async () => {
  const valid = {
    RENDERER_VERSION: '1.0.0',
    VIEW_SCHEMA: 'lca.study-report-view.v1',
    validateReportView() {},
    validateRenderContext() {},
    async renderReport() {
      return '';
    },
  };
  assert.equal(assertStudyRenderer(valid), valid);
  for (const value of [
    null,
    { ...valid, RENDERER_VERSION: 'other' },
    { ...valid, VIEW_SCHEMA: 'other' },
    { ...valid, validateReportView: null },
    { ...valid, validateRenderContext: null },
    { ...valid, renderReport: null },
  ])
    fails(() => assertStudyRenderer(value), 'STUDY_RENDERER_INVALID');
  const root = mkdtempSync(path.join(os.tmpdir(), 'study-renderer-layout-'));
  try {
    const source = pathToFileURL(path.join(root, 'src/lib/study/renderer.ts')).href;
    const built = pathToFileURL(path.join(root, 'dist/src/lib/study/renderer.js')).href;
    fails(() => studyRendererRoot(source), 'STUDY_RENDERER_MISSING');
    const assets = path.join(root, 'assets/study-renderer/v1');
    mkdirSync(path.join(assets, 'package'), { recursive: true });
    writeFileSync(path.join(assets, 'package/manifest.json'), '{}');
    assert.equal(studyRendererRoot(source), realpathSync(assets));
    assert.equal(studyRendererRoot(built), realpathSync(assets));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const env of [
    {},
    { TIANGONG_LCA_API_BASE_URL: 'not-a-url' },
    {
      TIANGONG_LCA_API_BASE_URL: 'https://production.supabase.co',
      [STUDY_RENDERER_CANDIDATE_ENV]: STUDY_RENDERER_ARCHIVE_SHA256,
    },
  ])
    fails(
      () => admitStudyRendererCandidate({ sourceDirty: true }, env),
      'STUDY_RENDERER_CANDIDATE_REQUIRED',
    );
  assert.equal((await loadStudyRenderer({})).artifactHash, STUDY_RENDERER_ARCHIVE_SHA256);
});

test('Qualified clean renderer policy is distinct from explicit dirty candidate admission', () => {
  admitStudyRendererCandidate({ sourceDirty: false }, {});
  admitStudyRendererCandidate(
    { sourceDirty: true },
    { ...exportEnvironment(), [STUDY_RENDERER_CANDIDATE_ENV]: STUDY_RENDERER_ARCHIVE_SHA256 },
  );
});

test('Runtime renderer inventory rejects unexpected files and nonregular package paths before importing', async () => {
  const packageRoot = realpathSync(path.join(studyRendererRoot(), 'package'));
  const entry = path.join(packageRoot, 'index.js');
  let inventoryInjections = 0,
    entryInjections = 0;
  const fs = createRequire(import.meta.url)('node:fs') as {
    readdirSync: typeof import('node:fs').readdirSync;
    lstatSync: typeof import('node:fs').lstatSync;
  };
  const list = fs.readdirSync,
    stat = fs.lstatSync;
  try {
    fs.readdirSync = ((filename: string, options: unknown) => {
      const result = list(filename, options as never);
      if (filename === packageRoot) {
        inventoryInjections++;
        return [...result, 'foreign.js'];
      }
      return result;
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    await assert.rejects(
      loadStudyRenderer(exportEnvironment()),
      (error: unknown) => error instanceof CliError && error.code === 'STUDY_RENDERER_INTEGRITY',
    );
    assert.equal(
      inventoryInjections,
      1,
      'the native package directory must receive the inventory injection',
    );
    fs.readdirSync = list;
    fs.lstatSync = ((filename: string, options: unknown) => {
      if (filename === entry) {
        entryInjections++;
        return { isFile: () => false };
      }
      return stat(filename, options as never);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    await assert.rejects(
      loadStudyRenderer(exportEnvironment()),
      (error: unknown) => error instanceof CliError && error.code === 'STUDY_RENDERER_INTEGRITY',
    );
    assert.equal(
      entryInjections,
      1,
      'the native entry path must receive the nonregular-file injection',
    );
  } finally {
    fs.readdirSync = list;
    fs.lstatSync = stat;
    syncBuiltinESMExports();
  }
});

test('Renderer execution uses the complete verified memory graph after entry and dependency files change', async () => {
  const original = studyRendererRoot();
  const root = mkdtempSync(path.join(os.tmpdir(), 'study-renderer-snapshot-'));
  try {
    cpSync(path.join(original, 'package'), root, { recursive: true });
    const snapshot = verifyStudyRenderer(
      readFileSync(path.join(original, 'study-report-renderer-1.0.0.tgz')),
      readFileSync(path.join(root, 'manifest.json')),
      {
        archiveSha256: STUDY_RENDERER_ARCHIVE_SHA256,
        manifestSha256: STUDY_RENDERER_MANIFEST_SHA256,
      },
      (name) => readFileSync(path.join(root, name)),
    );
    const sentinel = '__studyUnverifiedRendererExecuted';
    for (const file of ['index.js', 'render.js', 'viewModel.js', 'documentLanguage.js']) {
      rmSync(path.join(root, file));
      writeFileSync(
        path.join(root, file),
        `globalThis.${sentinel}=true; throw new Error('unverified bytes executed');`,
      );
    }
    const pending = instantiateStudyRenderer(snapshot.sources);
    // Mutation of caller-owned buffers after admission also cannot alter this load.
    for (const bytes of snapshot.sources.values()) bytes.fill(0);
    const unrelated = importStudyModule('data:text/javascript,export const unrelated=true');
    const renderer = await pending;
    assert.equal(((await unrelated) as { unrelated: boolean }).unrelated, true);
    assert.equal((globalThis as Record<string, unknown>)[sentinel], undefined);
    const rendered = await renderer.renderReport(exportView(), {
      exportId: 'snapshot-export',
      projectionHash: 'a'.repeat(64),
      verificationAtGeneration: 'verified_by_trusted_exporter',
    });
    assert.match(rendered, /Unreviewed test fixture/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('The memory renderer loader rejects missing modules and filesystem, built-in or network dependencies', async () => {
  const base = `export const RENDERER_VERSION='1.0.0',VIEW_SCHEMA='lca.study-report-view.v1';export function validateReportView(v){return v}export function validateRenderContext(v){return v}export async function renderReport(){return '<verified>'}`;
  for (const code of [
    'import "./missing.js";' + base,
    'import "file:///unverified.js";' + base,
    'import "node:fs";' + base,
    'import "https://example.test/module.js";' + base,
    'import "./nested/escape.js";' + base,
    'invalid JavaScript',
  ]) {
    await assert.rejects(
      instantiateStudyRenderer(new Map([['index.js', Buffer.from(code)]])),
      (error: unknown) => error instanceof CliError && error.code === 'STUDY_RENDERER_INVALID',
    );
  }
  await assert.rejects(
    instantiateStudyRenderer(new Map()),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_RENDERER_INVALID',
  );
});

test('Renderer2 is a separately pinned profile and never widens the original renderer ABI', async () => {
  const {
    STUDY_V2_RENDERER_ARCHIVE_SHA256,
    STUDY_V2_RENDERER_MANIFEST_SHA256,
    STUDY_V2_RENDERER_CANDIDATE_ENV,
  } = await import('../src/lib/study/renderer.js');
  const root = studyRendererRoot(
    new URL('../src/lib/study/renderer.ts', import.meta.url).href,
    'v2',
  );
  assert(root.endsWith(path.join('assets', 'study-renderer', 'v2')));
  const archive = readFileSync(path.join(root, 'study-report-renderer-2.0.0.tgz'));
  const manifest = readFileSync(path.join(root, 'package/manifest.json'));
  const read = (name: string) => readFileSync(path.join(root, 'package', name));
  const pin = {
    archiveSha256: STUDY_V2_RENDERER_ARCHIVE_SHA256,
    manifestSha256: STUDY_V2_RENDERER_MANIFEST_SHA256,
  };
  const verified = verifyStudyRenderer(archive, manifest, pin, read, 'v2');
  fails(() => verifyStudyRenderer(archive, manifest, pin, read), 'STUDY_RENDERER_INVALID');
  const loaded = await loadStudyRenderer({}, 'v2');
  assert.equal(loaded.artifactHash, STUDY_V2_RENDERER_ARCHIVE_SHA256);
  assert.equal(loaded.renderer.RENDERER_VERSION, '2.0.0');
  assert.equal(loaded.renderer.VIEW_SCHEMA, 'lca.study-report-view.v2');
  assert.equal(assertStudyRenderer(loaded.renderer, 'v2'), loaded.renderer);
  fails(() => assertStudyRenderer(loaded.renderer), 'STUDY_RENDERER_INVALID');
  const memory = await instantiateStudyRenderer(verified.sources, 'v2');
  assert.equal(memory.RENDERER_VERSION, '2.0.0');
  admitStudyRendererCandidate({ sourceDirty: false }, {}, 'v2');
  fails(
    () => admitStudyRendererCandidate({ sourceDirty: true }, exportEnvironment(), 'v2'),
    'STUDY_RENDERER_CANDIDATE_REQUIRED',
  );
  fails(
    () =>
      admitStudyRendererCandidate(
        { sourceDirty: true },
        { ...exportEnvironment(), [STUDY_RENDERER_CANDIDATE_ENV]: STUDY_RENDERER_ARCHIVE_SHA256 },
        'v2',
      ),
    'STUDY_RENDERER_CANDIDATE_REQUIRED',
  );
  admitStudyRendererCandidate(
    { sourceDirty: true },
    { ...exportEnvironment(), [STUDY_V2_RENDERER_CANDIDATE_ENV]: STUDY_V2_RENDERER_ARCHIVE_SHA256 },
    'v2',
  );
});

test('Renderer2 layout selection does not fall back to an existing v1 directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'study-renderer-v2-layout-'));
  try {
    const source = pathToFileURL(path.join(root, 'src/lib/study/renderer.ts')).href;
    const built = pathToFileURL(path.join(root, 'dist/src/lib/study/renderer.js')).href;
    const old = path.join(root, 'assets/study-renderer/v1/package');
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, 'manifest.json'), '{}');
    fails(() => studyRendererRoot(source, 'v2'), 'STUDY_RENDERER_MISSING');
    const current = path.join(root, 'assets/study-renderer/v2');
    mkdirSync(path.join(current, 'package'), { recursive: true });
    writeFileSync(path.join(current, 'package/manifest.json'), '{}');
    assert.equal(studyRendererRoot(source, 'v2'), realpathSync(current));
    assert.equal(studyRendererRoot(built, 'v2'), realpathSync(current));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
