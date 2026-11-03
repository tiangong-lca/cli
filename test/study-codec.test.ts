import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  admitStudyCodecCandidate,
  assertStudyCodecModule,
  studyCodecRoot,
  verifyStudyCodecArtifact,
  STUDY_CODEC_CANDIDATE_ENV,
} from '../src/lib/study-codec.js';
import { studyDigest } from '../src/lib/study-protocol.js';
import { CliError } from '../src/lib/errors.js';

const code = Buffer.from('export const fixture = true;');
function manifest() {
  return {
    schemaVersion: 'lca.study-consumer-manifest.v1',
    apiSchema: 'lca.study-api.v2',
    contractVersion: '2.0.0',
    sourceRepository: 'tiangong-lca/edge-functions',
    sourceCommit: 'a'.repeat(40),
    sourceStatus: 'committed',
    files: [{ path: 'index.mjs', sha256: studyDigest(code), bytes: code.length }],
  };
}
function verify(value: unknown, reader = (_name: string) => code) {
  const bytes = Buffer.from(JSON.stringify(value));
  return verifyStudyCodecArtifact(bytes, studyDigest(bytes), reader);
}
function codeError(run: () => unknown, expected: string) {
  assert.throws(run, (error: unknown) => error instanceof CliError && error.code === expected);
}

test('Contained codec verification binds an independent manifest digest and every emitted file', () => {
  const valid = verify(manifest());
  assert.equal(valid.code, code);
  assert.equal(valid.manifest.sourceStatus, 'committed');
  const bytes = Buffer.from(JSON.stringify(manifest()));
  codeError(
    () => verifyStudyCodecArtifact(bytes, '0'.repeat(64), () => code),
    'STUDY_CONTRACT_INTEGRITY',
  );
  codeError(() => verify(manifest(), () => Buffer.from('wrong size')), 'STUDY_CONTRACT_INTEGRITY');
  codeError(() => verify(manifest(), () => Buffer.alloc(code.length)), 'STUDY_CONTRACT_INTEGRITY');
  const malformed = Buffer.from('{');
  codeError(
    () => verifyStudyCodecArtifact(malformed, studyDigest(malformed), () => code),
    'STUDY_CONTRACT_INVALID',
  );
});

test('Codec metadata rejects foreign protocols, repositories, source states and unsafe file tables', () => {
  const root = manifest();
  const variants: unknown[] = [
    null,
    { ...root, schemaVersion: 'other' },
    { ...root, apiSchema: 'v1' },
    { ...root, contractVersion: '3.0.0' },
    { ...root, sourceRepository: 'other/repo' },
    { ...root, sourceCommit: null },
    { ...root, sourceCommit: 'bad' },
    { ...root, sourceStatus: 'unqualified' },
    { ...root, files: {} },
    { ...root, files: Array(17).fill(root.files[0]) },
    { ...root, files: [] },
  ];
  for (const file of [
    null,
    { ...root.files[0], path: 3 },
    { ...root.files[0], path: '../index.mjs' },
    { ...root.files[0], sha256: 3 },
    { ...root.files[0], sha256: 'bad' },
    { ...root.files[0], bytes: null },
    { ...root.files[0], bytes: 1.5 },
    { ...root.files[0], bytes: -1 },
    { ...root.files[0], bytes: 8 * 1024 * 1024 + 1 },
  ])
    variants.push({ ...root, files: [file] });
  variants.push({ ...root, files: [root.files[0], root.files[0]] });
  variants.push({ ...root, files: [{ ...root.files[0], path: 'other.mjs' }] });
  for (const value of variants) codeError(() => verify(value), 'STUDY_CONTRACT_INVALID');
});

test('Worktree candidates require an external expected digest and an explicit loopback destination', () => {
  admitStudyCodecCandidate(manifest(), {}, 'expected');
  const development = { ...manifest(), sourceStatus: 'worktree' };
  admitStudyCodecCandidate(
    development,
    {
      [STUDY_CODEC_CANDIDATE_ENV]: 'expected',
      TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
    },
    'expected',
  );
  for (const env of [
    {},
    { [STUDY_CODEC_CANDIDATE_ENV]: 'expected' },
    { [STUDY_CODEC_CANDIDATE_ENV]: 'wrong', TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421' },
    { [STUDY_CODEC_CANDIDATE_ENV]: 'expected', TIANGONG_LCA_API_BASE_URL: 'not-a-url' },
    {
      [STUDY_CODEC_CANDIDATE_ENV]: 'expected',
      TIANGONG_LCA_API_BASE_URL: 'https://another.supabase.co',
    },
  ])
    codeError(
      () => admitStudyCodecCandidate(development, env, 'expected'),
      'STUDY_CONTRACT_CANDIDATE_REQUIRED',
    );
  codeError(
    () => admitStudyCodecCandidate({ ...development, sourceStatus: 'unknown' }, {}, 'expected'),
    'STUDY_CONTRACT_INVALID',
  );
});

test('The portable module must expose the exact codec ABI and version', () => {
  const valid = {
    API_SCHEMA: 'lca.study-api.v2',
    CONTRACT_VERSION: '2.0.0',
    parseRequest: () => {},
    parseResponse: () => {},
    validateResponseForRequest: () => {},
    operationMetadata: {},
  };
  assert.equal(assertStudyCodecModule(valid), valid);
  for (const value of [
    null,
    { ...valid, API_SCHEMA: 'other' },
    { ...valid, CONTRACT_VERSION: '3' },
    { ...valid, parseRequest: null },
    { ...valid, parseResponse: null },
    { ...valid, validateResponseForRequest: null },
    { ...valid, operationMetadata: null },
  ])
    codeError(() => assertStudyCodecModule(value), 'STUDY_CONTRACT_INVALID');
});

test('Codec discovery supports source and built package layouts without a sibling fallback', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'study-codec-paths-'));
  try {
    const source = pathToFileURL(path.join(root, 'package/src/lib/study-codec.ts')).href;
    const built = pathToFileURL(path.join(root, 'package/dist/src/lib/study-codec.js')).href;
    codeError(() => studyCodecRoot(source), 'STUDY_CONTRACT_MISSING');
    const assets = path.join(root, 'package/assets/study-contract/v2');
    mkdirSync(assets, { recursive: true });
    writeFileSync(path.join(assets, 'manifest.json'), '{}');
    assert.equal(studyCodecRoot(source).href, pathToFileURL(assets + path.sep).href);
    assert.equal(studyCodecRoot(built).href, pathToFileURL(assets + path.sep).href);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Reporting codec requires every owner export helper and never accepts partial ABI', () => {
  const full = {
    API_SCHEMA: 'lca.study-api.v3',
    CONTRACT_VERSION: '3.0.0',
    parseRequest() {},
    parseResponse() {},
    validateResponseForRequest() {},
    operationMetadata: {},
    analysisConfigHash() {},
    parseExportBundle() {},
    verifyExport() {},
    canonicalReceiptBytes() {},
    validateExportViewBindings() {},
  };
  assert.equal(assertStudyCodecModule(full, 'v3'), full);
  for (const key of [
    'analysisConfigHash',
    'parseExportBundle',
    'verifyExport',
    'canonicalReceiptBytes',
    'validateExportViewBindings',
  ])
    codeError(
      () => assertStudyCodecModule({ ...full, [key]: null }, 'v3'),
      'STUDY_CONTRACT_INVALID',
    );
});
