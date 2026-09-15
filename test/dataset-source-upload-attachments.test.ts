import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/lib/errors.js';
import {
  __testInternals,
  runDatasetSourceUploadAttachments,
  type DatasetSourceUploadAttachmentsReport,
} from '../src/lib/dataset-source-upload-attachments.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = { loaded: false, path: '/tmp/.env', count: 0 };

function okResponse(status = 200, body = ''): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text(): Promise<string> {
      return body;
    },
  };
}

function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function source(
  uuid: string,
  refValue: unknown,
  options: { wrap?: boolean; version?: string; omitInfo?: boolean } = {},
): Record<string, unknown> {
  const dataSetInformation: Record<string, unknown> = { 'common:UUID': uuid };
  if (refValue !== undefined) {
    dataSetInformation.referenceToDigitalFile = refValue;
  }
  const inner: Record<string, unknown> = options.omitInfo
    ? {}
    : {
        sourceInformation: { dataSetInformation },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': options.version ?? '01.00.000' },
        },
      };
  return options.wrap === false ? inner : { sourceDataSet: inner };
}

function buildExternalDocs(): string {
  const dir = tmp('tg-extdocs-');
  for (const name of [
    'pef_method.pdf',
    'eaf.png',
    'European_Commission_EPLCA_logo_x.jpg',
    'worldsteel+blast+furnace.jpg',
  ]) {
    writeFileSync(path.join(dir, name), `bytes-of-${name}`);
  }
  return dir;
}

function writeJsonl(rows: unknown[]): string {
  const dir = tmp('tg-srcrows-');
  const file = path.join(dir, 'sources.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n\n');
  return file;
}

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

test('classifyDigitalFileUri distinguishes empty, remote, local', () => {
  assert.equal(__testInternals.classifyDigitalFileUri(42), 'empty');
  assert.equal(__testInternals.classifyDigitalFileUri('   '), 'empty');
  assert.equal(__testInternals.classifyDigitalFileUri('http://x/y'), 'remote');
  assert.equal(__testInternals.classifyDigitalFileUri('HTTPS://x/y'), 'remote');
  assert.equal(__testInternals.classifyDigitalFileUri('../external_docs/a.pdf'), 'local');
});

test('digitalFileBasename normalizes slashes and backslashes', () => {
  assert.equal(__testInternals.digitalFileBasename('../external_docs/a.pdf'), 'a.pdf');
  assert.equal(__testInternals.digitalFileBasename('..\\external_docs\\B.JPG'), 'B.JPG');
  assert.equal(__testInternals.digitalFileBasename('bare.png'), 'bare.png');
});

test('mimeTypeForFile maps known extensions and falls back', () => {
  assert.equal(__testInternals.mimeTypeForFile('a.pdf'), 'application/pdf');
  assert.equal(__testInternals.mimeTypeForFile('a.JPG'), 'image/jpeg');
  assert.equal(__testInternals.mimeTypeForFile('a.bin'), 'application/octet-stream');
});

test('digitalFileEntries wraps singletons and tolerates nullish', () => {
  assert.deepEqual(__testInternals.digitalFileEntries(undefined), []);
  assert.deepEqual(__testInternals.digitalFileEntries(null), []);
  assert.deepEqual(__testInternals.digitalFileEntries({ '@uri': 'x' }), [{ '@uri': 'x' }]);
  assert.deepEqual(__testInternals.digitalFileEntries(['a', 'b']), ['a', 'b']);
});

test('entryUri and withRewrittenUri handle string, object, and other shapes', () => {
  assert.equal(__testInternals.entryUri('x'), 'x');
  assert.equal(__testInternals.entryUri({ '@uri': 'y' }), 'y');
  assert.equal(__testInternals.entryUri({ other: 1 }), '');
  assert.equal(__testInternals.entryUri(7), '');
  assert.equal(__testInternals.withRewrittenUri('old', 'new'), 'new');
  assert.deepEqual(__testInternals.withRewrittenUri({ '@uri': 'old', k: 1 }, 'new'), {
    '@uri': 'new',
    k: 1,
  });
  assert.equal(__testInternals.withRewrittenUri(7, 'new'), 7);
});

test('digitalFileNode resolves wrapped, unwrapped, and missing nodes', () => {
  assert.ok(__testInternals.digitalFileNode(source('a', { '@uri': 'x' })));
  assert.ok(__testInternals.digitalFileNode(source('a', { '@uri': 'x' }, { wrap: false })));
  assert.equal(__testInternals.digitalFileNode({ sourceDataSet: {} }), null);
  assert.equal(__testInternals.digitalFileNode({ sourceDataSet: { sourceInformation: {} } }), null);
});

test('sourceIdentity extracts id and version with graceful fallbacks', () => {
  assert.deepEqual(
    __testInternals.sourceIdentity(source('id-1', undefined, { version: '03.00.004' })),
    {
      id: 'id-1',
      version: '03.00.004',
    },
  );
  assert.deepEqual(__testInternals.sourceIdentity({ sourceDataSet: { sourceInformation: {} } }), {
    id: null,
    version: null,
  });
  assert.deepEqual(
    __testInternals.sourceIdentity({
      sourceDataSet: { administrativeInformation: {} },
    }),
    { id: null, version: null },
  );
});

test('resolveReferences classifies local/remote/unresolved entries', () => {
  const dir = buildExternalDocs();
  try {
    const index = __testInternals.buildExternalDocsIndex(dir);
    const resolved = __testInternals.resolveReferences(
      { id: 's', version: '1' },
      [
        { '@uri': '../external_docs/pef_method.pdf' },
        { '@uri': 'http://lca.jrc.ec.europa.eu' },
        { '@uri': '../external_docs/missing.pdf' },
      ],
      index,
      'external_docs',
    );
    assert.equal(resolved[0].reference.status, 'rewritten');
    assert.equal(resolved[0].reference.rewritten_uri, '../external_docs/pef_method.pdf');
    assert.equal(resolved[1].reference.status, 'left_as_is');
    assert.equal(resolved[1].reference.kind, 'remote');
    assert.equal(resolved[2].reference.status, 'unresolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildExternalDocsIndex throws on an unreadable directory', () => {
  assert.throws(
    () => __testInternals.buildExternalDocsIndex(path.join(os.tmpdir(), 'tg-missing-dir-xyz')),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === 'DATASET_SOURCE_UPLOAD_EXTERNAL_DOCS_DIR_UNREADABLE',
  );
});

test('rewriteDigitalFileValue handles arrays, singletons, and nullish', () => {
  const arrayResolved = __testInternals.resolveReferences(
    { id: 's', version: '1' },
    [{ '@uri': '../external_docs/pef_method.pdf' }, { '@uri': 'http://x' }],
    new Map([['pef_method.pdf', 'pef_method.pdf']]),
    'external_docs',
  );
  const rewrittenArray = __testInternals.rewriteDigitalFileValue(
    [{ '@uri': '../external_docs/pef_method.pdf' }, { '@uri': 'http://x' }],
    arrayResolved,
  );
  assert.deepEqual(rewrittenArray, [
    { '@uri': '../external_docs/pef_method.pdf' },
    { '@uri': 'http://x' },
  ]);

  // single object that has no matching resolution → returned unchanged via rewritten[0]
  assert.deepEqual(__testInternals.rewriteDigitalFileValue({ '@uri': 'keep' }, []), {
    '@uri': 'keep',
  });
  // nullish value with no entries exercises the `rewritten[0] ?? value` fallback
  assert.equal(__testInternals.rewriteDigitalFileValue(null, []), null);
});

test('trimToken and caughtErrorMessage cover their fallback branches', () => {
  assert.equal(__testInternals.trimToken('  x  '), 'x');
  assert.equal(__testInternals.trimToken('   '), null);
  assert.equal(__testInternals.trimToken(42), null);
  assert.equal(__testInternals.caughtErrorMessage(new Error('boom')), 'boom');
  assert.equal(__testInternals.caughtErrorMessage('plain string error'), 'plain string error');
});

test('normalizeTimeoutMs validates the timeout', () => {
  assert.equal(__testInternals.normalizeTimeoutMs(undefined), 30_000);
  assert.equal(__testInternals.normalizeTimeoutMs(1_000), 1_000);
  assert.throws(
    () => __testInternals.normalizeTimeoutMs(0),
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_SOURCE_UPLOAD_TIMEOUT_INVALID',
  );
});

test('loadSourceRows reads directories, jsonl, json objects, and json arrays', () => {
  const dir = tmp('tg-loadrows-');
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(path.join(dir, 'a.json'), JSON.stringify(source('a', undefined)));
  writeFileSync(path.join(dir, 'nested', 'b.json'), JSON.stringify(source('b', undefined)));
  writeFileSync(path.join(dir, 'note.txt'), 'ignored');
  assert.equal(__testInternals.loadSourceRows(dir).length, 2);

  const jsonl = writeJsonl([source('a', undefined), source('b', undefined)]);
  assert.equal(__testInternals.loadSourceRows(jsonl).length, 2);

  const single = tmp('tg-single-');
  const singleFile = path.join(single, 'one.json');
  writeFileSync(singleFile, JSON.stringify(source('a', undefined)));
  assert.equal(__testInternals.loadSourceRows(singleFile).length, 1);

  const arr = tmp('tg-arr-');
  const arrFile = path.join(arr, 'arr.json');
  writeFileSync(arrFile, JSON.stringify([source('a', undefined), 7, source('b', undefined)]));
  assert.equal(__testInternals.loadSourceRows(arrFile).length, 2);

  rmSync(dir, { recursive: true, force: true });
  rmSync(single, { recursive: true, force: true });
  rmSync(arr, { recursive: true, force: true });
});

test('loadSourceRows surfaces unreadable, invalid, and non-object inputs', () => {
  assert.throws(
    () => __testInternals.loadSourceRows(path.join(os.tmpdir(), 'tg-no-input-xyz.json')),
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_SOURCE_UPLOAD_INPUT_UNREADABLE',
  );

  const badDir = tmp('tg-bad-');
  const badFile = path.join(badDir, 'bad.json');
  writeFileSync(badFile, '{not json');
  assert.throws(
    () => __testInternals.loadSourceRows(badFile),
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_SOURCE_UPLOAD_INPUT_INVALID_JSON',
  );

  const numFile = path.join(badDir, 'num.json');
  writeFileSync(numFile, '42');
  assert.throws(
    () => __testInternals.loadSourceRows(numFile),
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_SOURCE_UPLOAD_INPUT_NOT_OBJECT',
  );

  const numLines = path.join(badDir, 'lines.jsonl');
  writeFileSync(numLines, '42\n');
  assert.throws(
    () => __testInternals.loadSourceRows(numLines),
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_SOURCE_UPLOAD_INPUT_NOT_OBJECT',
  );

  rmSync(badDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Integration: runDatasetSourceUploadAttachments
// ---------------------------------------------------------------------------

function mixedRows(): unknown[] {
  return [
    source('src-pef-a', { '@uri': '../external_docs/pef_method.pdf' }, { version: '01.00.000' }),
    source('src-pef-b', { '@uri': '../external_docs/pef_method.pdf' }, { version: '01.00.000' }),
    source(
      'src-logo',
      [
        { '@uri': '..\\external_docs\\European_Commission_EPLCA_logo_x.jpg' },
        { '@uri': '../external_docs/european_commission_eplca_logo_x.jpg' },
        { '@uri': 'http://lca.jrc.ec.europa.eu' },
        { '@uri': '../external_docs/missing.pdf' },
      ],
      { version: '03.00.000' },
    ),
    source('src-no-ref', undefined),
    source('src-string', '../external_docs/eaf.png', { wrap: false }),
    source('src-already', { '@uri': '../external_docs/worldsteel+blast+furnace.jpg' }),
    { sourceDataSet: {} },
  ];
}

test('dry-run plans uploads, dedups files, rewrites URIs, and flags unresolved refs', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl(mixedRows());
  const outDir = tmp('tg-out-');
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      outDir,
      env: buildSupabaseTestEnv(),
      fetchImpl: async () => okResponse(),
      now: new Date('2026-06-29T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_unresolved_refs');
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.bucket, 'external_docs');
    assert.equal(report.summary.remote_refs, 1);
    assert.equal(report.summary.unresolved_refs, 1);
    // pef + logo + eaf + worldsteel = 4 distinct files
    assert.equal(report.summary.files_planned, 4);
    assert.equal(report.summary.files_uploaded, 0);
    // only src-logo's @uri strings actually change (backslash + lowercase → canonical);
    // refs already in canonical "../external_docs/<file>" form are uploaded but not rewritten
    assert.equal(report.summary.sources_rewritten, 1);

    const pef = report.files.find((file) => file.bucket_key === 'pef_method.pdf');
    assert.ok(pef);
    assert.deepEqual(pef.referenced_by, ['src-pef-a@01.00.000', 'src-pef-b@01.00.000']);
    assert.equal(pef.status, 'planned');

    const logo = report.files.find(
      (file) => file.bucket_key === 'European_Commission_EPLCA_logo_x.jpg',
    );
    assert.ok(logo);
    assert.deepEqual(logo.referenced_by, ['src-logo@03.00.000']);

    const rewritten = readFileSync(path.join(outDir, 'rewritten-sources.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rewritten.length, 7);
    // string-ref source rewritten to canonical 3-part uri
    const stringSource = rewritten.find(
      (row) =>
        (row.sourceInformation as Record<string, Record<string, unknown>>)?.dataSetInformation?.[
          'common:UUID'
        ] === 'src-string',
    );
    assert.equal(
      (stringSource?.sourceInformation as Record<string, Record<string, unknown>>)
        .dataSetInformation.referenceToDigitalFile,
      '../external_docs/eaf.png',
    );
  } finally {
    for (const dir of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('dry-run with only resolvable refs reports planned status', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl([source('s', { '@uri': '../external_docs/eaf.png' })]);
  const outDir = tmp('tg-out-');
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      outDir,
      bucket: 'external_docs',
      env: buildSupabaseTestEnv(),
      fetchImpl: async () => okResponse(),
    });
    assert.equal(report.status, 'planned_attachment_upload');
    assert.equal(report.summary.unresolved_refs, 0);
  } finally {
    for (const dir of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('commit uploads each binary once and can verify via signed url', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl(mixedRows());
  const outDir = tmp('tg-out-');
  const uploads: string[] = [];
  const signs: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse();
    }
    if (url.includes('/storage/v1/object/sign/')) {
      signs.push(url);
      return okResponse(200, JSON.stringify({ signedURL: '/signed' }));
    }
    uploads.push(url);
    return okResponse(200);
  };
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      outDir,
      commit: true,
      verify: true,
      env: buildSupabaseTestEnv(),
      fetchImpl,
    });
    assert.equal(report.status, 'uploaded_attachments');
    assert.equal(report.mode, 'commit');
    assert.equal(report.summary.files_uploaded, 4);
    assert.equal(report.summary.files_failed, 0);
    assert.equal(uploads.length, 4);
    assert.equal(signs.length, 4);
    assert.ok(report.files.every((file) => file.status === 'verified'));
    // worldsteel+...jpg key must be percent-encoded in the request path
    assert.ok(uploads.some((url) => url.includes('worldsteel%2Bblast%2Bfurnace.jpg')));
  } finally {
    for (const dir of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('commit records per-file failures from upload and verify errors', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl([
    source('a', { '@uri': '../external_docs/pef_method.pdf' }),
    source('b', { '@uri': '../external_docs/eaf.png' }),
  ]);
  const outDir = tmp('tg-out-');
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse();
    }
    if (url.includes('pef_method.pdf')) {
      return okResponse(500, 'upload boom');
    }
    if (url.includes('/storage/v1/object/sign/')) {
      return okResponse(403, 'sign denied');
    }
    return okResponse(200);
  };
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      outDir,
      commit: true,
      verify: true,
      env: buildSupabaseTestEnv(),
      fetchImpl,
    });
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.summary.files_failed, 2);
    const pef = report.files.find((file) => file.bucket_key === 'pef_method.pdf');
    assert.equal(pef?.status, 'failed');
    assert.match(pef?.error ?? '', /uploading pef_method\.pdf/u);
  } finally {
    for (const dir of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('commit with no local attachments needs no session and reports uploaded status', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl([source('s', { '@uri': 'http://lca.jrc.ec.europa.eu' })]);
  const outDir = tmp('tg-out-');
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      outDir,
      commit: true,
      env: buildSupabaseTestEnv(),
      fetchImpl: async () => {
        throw new Error('no network expected');
      },
    });
    assert.equal(report.status, 'uploaded_attachments');
    assert.equal(report.summary.files_planned, 0);
    assert.equal(report.summary.remote_refs, 1);
  } finally {
    for (const dir of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('commit without verify defaults outDir and labels unidentified sources', async () => {
  const externalDocsDir = buildExternalDocs();
  // resolvable ref on a source with no UUID and no administrativeInformation →
  // exercises the id/version "unknown" fallback branches.
  const inputPath = writeJsonl([
    {
      sourceDataSet: {
        sourceInformation: {
          dataSetInformation: { referenceToDigitalFile: { '@uri': '../external_docs/eaf.png' } },
        },
      },
    },
  ]);

  const cwd = process.cwd();
  const workDir = tmp('tg-cwd-');
  process.chdir(workDir);
  try {
    const report = await runDatasetSourceUploadAttachments({
      inputPath,
      externalDocsDir,
      commit: true,
      env: buildSupabaseTestEnv(),
      fetchImpl: async (input) =>
        isSupabaseAuthTokenUrl(String(input)) ? makeSupabaseAuthResponse() : okResponse(200),
    });
    assert.equal(report.status, 'uploaded_attachments');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].status, 'uploaded');
    assert.deepEqual(report.files[0].referenced_by, ['unknown@unknown']);
    assert.match(
      report.artifacts.report,
      /dataset-source-upload-attachments[/\\]attachments-report\.json$/u,
    );
  } finally {
    process.chdir(cwd);
    rmSync(workDir, { recursive: true, force: true });
    rmSync(externalDocsDir, { recursive: true, force: true });
    rmSync(path.dirname(inputPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    dotEnvStatus,
    fetchImpl: (async () => okResponse()) as FetchLike,
    ...overrides,
  };
}

function stubReport(
  status: DatasetSourceUploadAttachmentsReport['status'],
): DatasetSourceUploadAttachmentsReport {
  return {
    schema_version: 1,
    generated_at_utc: '2026-06-29T00:00:00.000Z',
    status,
    mode: status === 'uploaded_attachments' ? 'commit' : 'dry-run',
    bucket: 'external_docs',
    external_docs_dir: '/x',
    summary: {
      sources_scanned: 0,
      local_refs: 0,
      remote_refs: 0,
      unresolved_refs: 0,
      files_planned: 0,
      files_uploaded: 0,
      files_failed: 0,
      sources_rewritten: 0,
    },
    files: [],
    references: [],
    artifacts: { report: '/x/r.json', rewritten_sources: '/x/s.jsonl' },
  };
}

test('executeCli renders source upload-attachments help', async () => {
  const bare = await executeCli(['dataset', 'source'], makeDeps());
  assert.equal(bare.exitCode, 0);
  assert.match(bare.stdout, /upload-attachments/u);

  const help = await executeCli(['dataset', 'source', 'upload-attachments', '--help'], makeDeps());
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /referenceToDigitalFile/u);
});

test('executeCli rejects an unknown source action', async () => {
  const result = await executeCli(['dataset', 'source', 'frobnicate'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /dataset source action must be 'discover' or 'upload-attachments'/u);
});

test('executeCli requires --input and --external-docs-dir', async () => {
  const noInput = await executeCli(['dataset', 'source', 'upload-attachments'], makeDeps());
  assert.equal(noInput.exitCode, 2);
  assert.match(noInput.stderr, /requires --input/u);

  const noDocs = await executeCli(
    ['dataset', 'source', 'upload-attachments', '--input', 'x.jsonl'],
    makeDeps(),
  );
  assert.equal(noDocs.exitCode, 2);
  assert.match(noDocs.stderr, /requires --external-docs-dir/u);
});

test('executeCli rejects conflicting and malformed flags', async () => {
  const conflict = await executeCli(
    [
      'dataset',
      'source',
      'upload-attachments',
      '--input',
      'x',
      '--external-docs-dir',
      'y',
      '--commit',
      '--dry-run',
    ],
    makeDeps(),
  );
  assert.equal(conflict.exitCode, 2);
  assert.match(conflict.stderr, /Cannot pass both --commit and --dry-run/u);

  const badTimeout = await executeCli(
    [
      'dataset',
      'source',
      'upload-attachments',
      '--input',
      'x',
      '--external-docs-dir',
      'y',
      '--timeout-ms',
      'abc',
    ],
    makeDeps(),
  );
  assert.equal(badTimeout.exitCode, 2);
  assert.match(badTimeout.stderr, /--timeout-ms must be an integer/u);
});

test('executeCli maps upload-attachments status to an exit code', async () => {
  const calls: Record<string, unknown>[] = [];
  const deps = makeDeps({
    runDatasetSourceUploadAttachmentsImpl: async (options: Record<string, unknown>) => {
      calls.push(options);
      return stubReport('uploaded_attachments');
    },
  });
  const ok = await executeCli(
    [
      'dataset',
      'source',
      'upload-attachments',
      '--input',
      'rows.jsonl',
      '--external-docs-dir',
      'docs',
      '--bucket',
      'external_docs',
      '--verify',
      '--timeout-ms',
      '5000',
      '--json',
    ],
    deps,
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(calls[0].inputPath, 'rows.jsonl');
  assert.equal(calls[0].externalDocsDir, 'docs');
  assert.equal(calls[0].bucket, 'external_docs');
  assert.equal(calls[0].outDir, null);
  assert.equal(calls[0].commit, false);
  assert.equal(calls[0].verify, true);
  assert.equal(calls[0].timeoutMs, 5000);
  assert.equal(calls[0].env, deps.env);
  assert.equal(calls[0].fetchImpl, deps.fetchImpl);

  const failed = await executeCli(
    ['dataset', 'source', 'upload-attachments', '--input', 'r', '--external-docs-dir', 'd'],
    makeDeps({
      runDatasetSourceUploadAttachmentsImpl: async () => stubReport('completed_with_failures'),
    }),
  );
  assert.equal(failed.exitCode, 1);
});

test('executeCli renders source help for --help and -h action aliases', async () => {
  for (const arg of ['--help', '-h']) {
    const result = await executeCli(['dataset', 'source', arg], makeDeps());
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /upload-attachments/u);
  }
});

test('executeCli runs source upload-attachments end-to-end through the real impl', async () => {
  const externalDocsDir = buildExternalDocs();
  const inputPath = writeJsonl([source('s', { '@uri': '../external_docs/eaf.png' })]);
  const outDir = tmp('tg-cli-e2e-');
  try {
    const result = await executeCli(
      [
        'dataset',
        'source',
        'upload-attachments',
        '--input',
        inputPath,
        '--external-docs-dir',
        externalDocsDir,
        '--out-dir',
        outDir,
        '--json',
      ],
      makeDeps({ env: buildSupabaseTestEnv(), fetchImpl: async () => okResponse() }),
    );
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'planned_attachment_upload');
    assert.equal(report.summary.files_planned, 1);
  } finally {
    for (const d of [externalDocsDir, path.dirname(inputPath), outDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test('executeCli rejects an unknown flag for source upload-attachments', async () => {
  const result = await executeCli(
    ['dataset', 'source', 'upload-attachments', '--input', 'x', '--bogus'],
    makeDeps(),
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /INVALID_ARGS|Unknown option|--bogus/u);
});
