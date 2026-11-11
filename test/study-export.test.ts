import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import {
  publishStudyExport,
  readStudyExportTrust,
  runStudyExportFiles,
  verifyStudyExportBundle,
  verifyStudyExportDirectory,
} from '../src/lib/study/export.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import { studyDigest, studyJson } from '../src/lib/study/protocol.js';
import { exportEnvironment, signedExportFixture } from './helpers/study-export-fixture.js';

const roots: string[] = [];
function root() {
  const value = mkdtempSync(path.join(os.tmpdir(), 'study-export-test-'));
  roots.push(value);
  return value;
}
test.after(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});
async function refuses(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof CliError && error.code === code,
  );
}

test('Independent signature, view bindings and same portable renderer authenticate the exact detached files', async () => {
  const value = await signedExportFixture();
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  assert(checked.manifestBytes.equals(value.manifestBytes));
  const directory = path.join(root(), 'report');
  const files = publishStudyExport(directory, checked);
  assert.equal(files.length, 4);
  assert.deepEqual(readdirSync(directory).sort(), [
    'export-manifest.json',
    'export-receipt.json',
    'projection.json',
    'report.html',
  ]);
  assert(readFileSync(path.join(directory, 'report.html')).equals(value.html));
  assert.match(value.html.toString('utf8'), /1\.000 kg/u);
  assert.match(value.html.toString('utf8'), /Unreviewed/u);
  assert(!value.html.includes(Buffer.from('lca.study-export-signature.v1')));
  if (process.platform !== 'win32')
    for (const file of files) assert.equal(statSync(file.path).mode & 0o077, 0);
  await verifyStudyExportDirectory(directory, value.anchors, value.expected, exportEnvironment());
  assert.throws(
    () => publishStudyExport(directory, checked),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_OUTPUT_EXISTS',
  );
});

test('Edited HTML/projection, forged signatures and transplanted scope never authenticate', async () => {
  const value = await signedExportFixture();
  const changedHtml = structuredClone(value.bundle);
  changedHtml.files[0].bytes = Buffer.from('edited').toString('base64');
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(changedHtml)),
      value.anchors,
      value.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const signature = structuredClone(value.bundle);
  signature.receipt.signature = 'A'.repeat(86);
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(signature)),
      value.anchors,
      value.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  await refuses(
    verifyStudyExportBundle(value.bytes, [], value.expected, exportEnvironment()),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  await refuses(
    verifyStudyExportBundle(
      value.bytes,
      value.anchors,
      { ...value.expected, exportId: 'another-export' },
      exportEnvironment(),
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const projection = structuredClone(value.bundle);
  projection.files[1].bytes = Buffer.from('{}').toString('base64');
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(projection)),
      value.anchors,
      value.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const directory = path.join(root(), 'report');
  publishStudyExport(
    directory,
    await verifyStudyExportBundle(value.bytes, value.anchors, value.expected, exportEnvironment()),
  );
  writeFileSync(path.join(directory, 'report.html'), 'edited-after-download');
  await refuses(
    verifyStudyExportDirectory(directory, value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
});

test('A genuine issuer signature cannot replace metadata/view bindings or renderer identity', async () => {
  const mismatched = await signedExportFixture((view) => {
    view.report.reportRevisionId = 'another-view-report';
  });
  await refuses(
    verifyStudyExportBundle(
      mismatched.bytes,
      mismatched.anchors,
      mismatched.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_RENDERER_MISMATCH',
  );
  const value = await signedExportFixture();
  const different = {
    ...value.manifest,
    renderer: { ...value.manifest.renderer, artifactHash: 'b'.repeat(64) },
  };
  const signed = value.signManifest(different);
  await refuses(
    verifyStudyExportBundle(
      signed.bytes,
      [{ ...value.anchors[0], rendererArtifactHashes: ['b'.repeat(64)] }],
      value.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_RENDERER_MISMATCH',
  );
});

test('Offline public CLI verification needs independent selectors/anchors and makes no auth/network calls', async () => {
  const value = await signedExportFixture();
  const directory = root();
  const bundle = path.join(directory, 'bundle.json'),
    anchors = path.join(directory, 'trusted-anchors.json'),
    expected = path.join(directory, 'expected.json');
  writeFileSync(bundle, value.bytes);
  writeFileSync(anchors, JSON.stringify(value.anchors));
  writeFileSync(expected, JSON.stringify(value.expected));
  const fetchImpl = async () => {
    throw new Error('offline verification must not contact Auth/API');
  };
  const report = await runStudyExportFiles(
    'verify',
    { bundleFile: bundle, anchorsFile: anchors, expectedFile: expected },
    fetchImpl,
    exportEnvironment(),
  );
  assert.equal(report.signatureVerified, true);
  assert.equal(report.currentAccess, 'not-checked-offline');
  assert.equal(report.currentReview, 'not-checked-offline');
  const result = await executeCli(
    [
      'study',
      'export',
      'verify',
      '--bundle',
      bundle,
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--json',
    ],
    {
      env: exportEnvironment(),
      fetchImpl,
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rendererMatched, true);
});

test('Authorized v3 bundle download verifies before publishing and selects the exact independent export', async () => {
  const value = await signedExportFixture();
  const selected = root();
  const actor = '11111111-1111-4111-8111-111111111111';
  const artifactRef = {
    type: 'reportExportBundle',
    id: 'bundle-export',
    contentHash: studyDigest(value.bytes),
    byteSize: value.bytes.length,
    digestScope: 'artifact_bytes_sha256',
    mediaType: 'application/json',
    schemaVersion: 'lca.study-export-bundle.v1',
  };
  const inputFile = path.join(selected, 'input.json'),
    anchorsFile = path.join(selected, 'anchors.json'),
    expectedFile = path.join(selected, 'expected.json');
  writeFileSync(inputFile, JSON.stringify({ studyId: value.expected.studyId, artifactRef }));
  writeFileSync(anchorsFile, JSON.stringify(value.anchors));
  writeFileSync(expectedFile, JSON.stringify(value.expected));
  const env = {
    ...exportEnvironment(),
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    TIANGONG_LCA_ACCESS_TOKEN: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: actor })).toString('base64url')}.fixture`,
  };
  let calls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls++;
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/auth/v1/user'))
      return json({ id: actor, email: 'download-fixture@example.test', role: 'authenticated' });
    const request = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('x-study-schema'), 'lca.study-api.v3');
    return json({
      schemaVersion: 'lca.study-api.v3',
      requestId: request.requestId,
      ok: true,
      data:
        request.operation === 'capability.read'
          ? {
              type: 'capabilities',
              contractVersion: '3.0.0',
              runtimeEnabled: true,
              operations: ['capability.read', 'artifact.read'],
              analysisProfiles: [],
              reportTemplates: [],
            }
          : {
              type: 'artifact',
              studyId: value.expected.studyId,
              artifactRef,
              encoding: 'base64',
              bytes: value.bytes.toString('base64'),
            },
    });
  };
  const outputDirectory = path.join(selected, 'download');
  const report = await runStudyExportFiles(
    'download',
    { inputFile, anchorsFile, expectedFile, outputDirectory },
    fetchImpl,
    env,
  );
  assert.equal(report.rendererMatched, true);
  assert.equal(calls, 4);
  await verifyStudyExportDirectory(outputDirectory, value.anchors, value.expected, env);
  await refuses(
    runStudyExportFiles(
      'download',
      { inputFile, anchorsFile, expectedFile, outputDirectory },
      fetchImpl,
      env,
    ),
    'STUDY_OUTPUT_EXISTS',
  );
  assert.equal(calls, 4);
  const publicResult = await executeCli(
    [
      'study',
      'export',
      'download',
      '--input',
      inputFile,
      '--output-dir',
      path.join(selected, 'public-download'),
      '--anchors',
      anchorsFile,
      '--expected',
      expectedFile,
      '--json',
    ],
    { env, fetchImpl, dotEnvStatus: { loaded: false, path: '/unused', count: 0 } },
  );
  assert.equal(publicResult.exitCode, 0, publicResult.stderr);
  assert.equal(JSON.parse(publicResult.stdout).signatureVerified, true);
  writeFileSync(inputFile, JSON.stringify({ studyId: 'wrong-study', artifactRef }));
  await refuses(
    runStudyExportFiles(
      'download',
      { inputFile, anchorsFile, expectedFile, outputDirectory: path.join(selected, 'other') },
      fetchImpl,
      env,
    ),
    'STUDY_EXPORT_SELECTION',
  );
  await refuses(
    runStudyExportFiles('download', { anchorsFile, expectedFile }, fetchImpl, env),
    'INVALID_ARGS',
  );
});

test('Detached directories require a closed file inventory and canonical receipt bytes', async () => {
  const value = await signedExportFixture();
  const absent = path.join(root(), 'missing-sensitive-path');
  await refuses(
    verifyStudyExportDirectory(absent, value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_DIRECTORY_INVALID',
  );
  writeFileSync(absent, 'regular file');
  await refuses(
    verifyStudyExportDirectory(absent, value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_DIRECTORY_INVALID',
  );
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  const directory = path.join(root(), 'report');
  publishStudyExport(directory, checked);
  const receiptFile = path.join(directory, 'export-receipt.json');
  writeFileSync(receiptFile, `${readFileSync(receiptFile, 'utf8')}\n`);
  await refuses(
    verifyStudyExportDirectory(directory, value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  writeFileSync(path.join(directory, 'untrusted-extra.js'), 'arbitrary file');
  await refuses(
    verifyStudyExportDirectory(directory, value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_DIRECTORY_INVALID',
  );
  await refuses(
    verifyStudyExportBundle(Buffer.from('{}'), value.anchors, value.expected, exportEnvironment()),
    'STUDY_EXPORT_VERIFICATION_FAILED',
  );
  const selected = root();
  const anchors = path.join(selected, 'anchors.json'),
    expected = path.join(selected, 'expected.json');
  writeFileSync(anchors, '{}');
  writeFileSync(expected, JSON.stringify(value.expected));
  assert.throws(
    () => readStudyExportTrust(anchors, expected),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_EXPORT_TRUST_INVALID',
  );
  writeFileSync(anchors, JSON.stringify(value.anchors));
  writeFileSync(expected, JSON.stringify({ ...value.expected, extra: 'forbidden' }));
  assert.throws(
    () => readStudyExportTrust(anchors, expected),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_EXPORT_TRUST_INVALID',
  );
});

function directoryLink(target: string, filename: string) {
  symlinkSync(target, filename, process.platform === 'win32' ? 'junction' : 'dir');
}

test('Final directory replacement cannot redirect staged writes or delete unrelated same-byte files', async () => {
  const value = await signedExportFixture();
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  const fs = createRequire(import.meta.url)('node:fs') as {
    writeFileSync: typeof import('node:fs').writeFileSync;
  };
  const write = fs.writeFileSync;
  for (const failSecond of [false, true]) {
    const parent = root(),
      output = path.join(parent, 'report'),
      unrelated = path.join(parent, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, 'export-manifest.json'), checked.manifestBytes);
    writeFileSync(path.join(unrelated, 'sentinel.txt'), 'foreign owner');
    let writes = 0,
      failure: CliError | undefined;
    try {
      fs.writeFileSync = ((fd: number, bytes: Uint8Array) => {
        assert.equal(typeof fd, 'number');
        writes++;
        if (writes === 1) directoryLink(unrelated, output);
        if (failSecond && writes === 2) throw new Error('simulated stage disk failure');
        return write(fd, bytes);
      }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      try {
        publishStudyExport(output, checked);
        assert.fail('replacement must refuse publication');
      } catch (error) {
        assert(error instanceof CliError);
        failure = error;
      }
    } finally {
      fs.writeFileSync = write;
      syncBuiltinESMExports();
    }
    assert.equal(failure?.code, 'STUDY_OUTPUT_WRITE_FAILED');
    assert.equal(writes, failSecond ? 2 : 4);
    assert.deepEqual(readdirSync(unrelated).sort(), ['export-manifest.json', 'sentinel.txt']);
    assert(
      readFileSync(path.join(unrelated, 'export-manifest.json')).equals(checked.manifestBytes),
    );
    assert.equal(readFileSync(path.join(unrelated, 'sentinel.txt'), 'utf8'), 'foreign owner');
    const details = failure?.details as { stagingDirectory: string; stagingDisposition: string };
    assert.equal(details.stagingDisposition, 'retained-inspect-before-cleanup');
    assert(statSync(details.stagingDirectory).isDirectory());
    assert(
      readFileSync(path.join(details.stagingDirectory, 'export-manifest.json')).equals(
        checked.manifestBytes,
      ),
    );
  }
});

test('The single publication rename refuses final symlink and nonempty directory races without cleanup', async () => {
  const value = await signedExportFixture();
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  const fs = createRequire(import.meta.url)('node:fs') as {
    renameSync: typeof import('node:fs').renameSync;
  };
  const rename = fs.renameSync;
  for (const kind of ['symlink', 'nonempty']) {
    const parent = root(),
      output = path.join(parent, 'report'),
      unrelated = path.join(parent, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(path.join(unrelated, 'sentinel'), 'untouched');
    let failure: CliError | undefined;
    try {
      fs.renameSync = ((source: string, target: string) => {
        assert.equal(target, output);
        if (kind === 'symlink') directoryLink(unrelated, output);
        else {
          mkdirSync(output);
          writeFileSync(path.join(output, 'sentinel'), 'target owner');
        }
        return rename(source, target);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try {
        publishStudyExport(output, checked);
        assert.fail('race must refuse publication');
      } catch (error) {
        assert(error instanceof CliError);
        failure = error;
      }
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    assert.equal(failure?.code, 'STUDY_OUTPUT_WRITE_FAILED');
    assert.equal(readFileSync(path.join(unrelated, 'sentinel'), 'utf8'), 'untouched');
    if (kind === 'nonempty')
      assert.equal(readFileSync(path.join(output, 'sentinel'), 'utf8'), 'target owner');
    const stage = (failure?.details as { stagingDirectory: string }).stagingDirectory;
    assert.deepEqual(readdirSync(stage).sort(), [
      'export-manifest.json',
      'export-receipt.json',
      'projection.json',
      'report.html',
    ]);
  }
});

test('After the final rename no publication write or cleanup follows a replaced output path', async () => {
  const value = await signedExportFixture(),
    parent = root(),
    output = path.join(parent, 'report'),
    moved = path.join(parent, 'displaced'),
    unrelated = path.join(parent, 'unrelated');
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  mkdirSync(unrelated);
  writeFileSync(path.join(unrelated, 'sentinel'), 'foreign owner');
  const fs = createRequire(import.meta.url)('node:fs') as {
    renameSync: typeof import('node:fs').renameSync;
  };
  const rename = fs.renameSync;
  try {
    fs.renameSync = ((source: string, target: string) => {
      rename(source, target);
      rename(target, moved);
      directoryLink(unrelated, target);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    assert.equal(publishStudyExport(output, checked).length, 4);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(unrelated), ['sentinel']);
  await verifyStudyExportDirectory(moved, value.anchors, value.expected, exportEnvironment());
});

test('Even genuinely signed HTML must equal the validated owner renderer output', async () => {
  const value = await signedExportFixture();
  const differentHtml = Buffer.from('<!doctype html><title>signed but substituted</title>');
  const different = {
    ...value.manifest,
    files: value.manifest.files.map((file) =>
      file.path === 'report.html'
        ? { ...file, sha256: studyDigest(differentHtml), byteSize: differentHtml.length }
        : file,
    ),
  };
  const signed = value.signManifest(different);
  signed.bundle.files[0].bytes = differentHtml.toString('base64');
  await refuses(
    verifyStudyExportBundle(
      Buffer.from(studyJson(signed.bundle)),
      value.anchors,
      value.expected,
      exportEnvironment(),
    ),
    'STUDY_EXPORT_RENDERER_MISMATCH',
  );
});

test('Public export commands validate file selectors and support offline directory/human output', async () => {
  const value = await signedExportFixture(),
    selected = root();
  const anchors = path.join(selected, 'anchors.json'),
    expected = path.join(selected, 'expected.json'),
    bundle = path.join(selected, 'bundle.json');
  writeFileSync(anchors, JSON.stringify(value.anchors));
  writeFileSync(expected, JSON.stringify(value.expected));
  writeFileSync(bundle, value.bytes);
  const directory = path.join(selected, 'report');
  publishStudyExport(
    directory,
    await verifyStudyExportBundle(value.bytes, value.anchors, value.expected, exportEnvironment()),
  );
  const deps = {
    env: exportEnvironment(),
    fetchImpl: async () => {
      throw new Error('offline must not fetch');
    },
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
  };
  const success = await executeCli(
    [
      'study',
      'export',
      'verify',
      '--directory',
      directory,
      '--anchors',
      anchors,
      '--expected',
      expected,
    ],
    deps,
  );
  assert.equal(success.exitCode, 0, success.stderr);
  assert.match(success.stdout, /LCA calculation export verification/u);
  for (const args of [
    ['export', 'verify', '--api-version', '2'],
    ['export', 'verify'],
    ['export', 'verify', '--anchors', anchors, '--expected', expected],
    [
      'export',
      'verify',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--directory',
      directory,
      '--bundle',
      bundle,
    ],
    ['export', 'download', '--anchors', anchors, '--expected', expected],
    ['export', 'download', '--anchors', anchors, '--expected', expected, '--input', bundle],
    [
      'export',
      'download',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--input',
      bundle,
      '--output-dir',
      selected,
      '--bundle',
      bundle,
    ],
    [
      'export',
      'download',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--input',
      bundle,
      '--output-dir',
      selected,
      '--directory',
      directory,
    ],
    [
      'export',
      'verify',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--bundle',
      bundle,
      '--input',
      bundle,
    ],
    [
      'export',
      'verify',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--bundle',
      bundle,
      '--output-dir',
      selected,
    ],
    [
      'export',
      'verify',
      '--anchors',
      anchors,
      '--expected',
      expected,
      '--bundle',
      bundle,
      '--force',
    ],
    ['capabilities', '--anchors', anchors],
    ['capabilities', '--api-version', 'unknown'],
    ['request', 'recover', '--intent-file', bundle, '--api-version', '3'],
  ]) {
    const result = await executeCli(['study', ...args, '--json'], deps);
    assert.notEqual(result.exitCode, 0, JSON.stringify(args));
  }
});

test('Publication setup failures are stable and do not clean unknown entries', async () => {
  const value = await signedExportFixture();
  const checked = await verifyStudyExportBundle(
    value.bytes,
    value.anchors,
    value.expected,
    exportEnvironment(),
  );
  const parent = root(),
    blocker = path.join(parent, 'blocker');
  writeFileSync(blocker, 'foreign owner');
  assert.throws(
    () => publishStudyExport(path.join(blocker, 'report'), checked),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_OUTPUT_WRITE_FAILED',
  );
  assert.equal(readFileSync(blocker, 'utf8'), 'foreign owner');
  const fs = createRequire(import.meta.url)('node:fs') as {
    mkdirSync: typeof import('node:fs').mkdirSync;
    lstatSync: typeof import('node:fs').lstatSync;
  };
  const mkdir = fs.mkdirSync,
    lstat = fs.lstatSync;
  const deniedOutput = path.resolve(parent, 'denied-report');
  let preflightFailures = 0;
  try {
    fs.lstatSync = ((filename: string, options: unknown) => {
      if (filename === deniedOutput) {
        preflightFailures++;
        throw Object.assign(new Error('private filesystem diagnostic'), { code: 'EACCES' });
      }
      return lstat(filename, options as never);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    assert.throws(
      () => publishStudyExport(deniedOutput, checked),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === 'STUDY_OUTPUT_WRITE_FAILED' &&
        !error.message.includes('private filesystem diagnostic'),
    );
    assert.equal(
      preflightFailures,
      1,
      'the final-path preflight must receive the injected access failure',
    );
    assert.deepEqual(readdirSync(parent), ['blocker']);
    assert.equal(readFileSync(blocker, 'utf8'), 'foreign owner');
  } finally {
    fs.lstatSync = lstat;
    syncBuiltinESMExports();
  }
  try {
    fs.mkdirSync = (() => {
      throw new Error('simulated parent disk failure');
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    assert.throws(
      () => publishStudyExport(path.join(parent, 'report'), checked),
      (error: unknown) => error instanceof CliError && error.code === 'STUDY_OUTPUT_WRITE_FAILED',
    );
  } finally {
    fs.mkdirSync = mkdir;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readdirSync(parent), ['blocker']);
});
