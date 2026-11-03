import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/lib/errors.js';
import {
  assertStudySafe,
  parseStudyResponse,
  prepareStudyRequest,
  STUDY_API_SCHEMA,
  STUDY_REQUEST_LIMIT,
  studyDigest,
  studyApiVersion,
  studyJson,
} from '../src/lib/study-protocol.js';
import {
  instantiateStudyCodec,
  loadStudyCodec,
  STUDY_CODEC_CANDIDATE_ENV,
  STUDY_CODEC_MANIFEST_SHA256,
} from '../src/lib/study-codec.js';
import {
  persistStudyIntent,
  readStudyBytes,
  readStudyIntent,
  readStudyJson,
} from '../src/lib/study-intent.js';
import { createStudyAuthFetch, verifyStudyArtifact } from '../src/lib/study-transport.js';

const roots: string[] = [];
function temporary() {
  const value = mkdtempSync(path.join(os.tmpdir(), 'study-boundary-'));
  roots.push(value);
  return value;
}
test.after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});
function rejects(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof CliError && error.code === code);
}
const selected = {
  endpoint: 'http://127.0.0.1:1234/functions/v1/app_lca_study',
  actorId: 'actor-a',
  clientId: null,
};

test('Request framing preserves arrays/zero and rejects identity drift, deep inputs and credentials', () => {
  assert.equal(studyJson({ z: [0, null, true], a: 'x' }), '{"a":"x","z":[0,null,true]}');
  assertStudySafe('ordinary', ['']);
  rejects(
    () => assertStudySafe('credential-sentinel', ['', 'credential-sentinel']),
    'STUDY_PRIVATE_PAYLOAD',
  );
  let nested: unknown = null;
  for (let i = 0; i < 34; i++) nested = { value: nested };
  rejects(() => assertStudySafe(nested), 'STUDY_PAYLOAD_TOO_DEEP');
  rejects(() => prepareStudyRequest('unknown', {}), 'STUDY_REQUEST_INVALID');
  rejects(() => prepareStudyRequest('study.create', []), 'STUDY_REQUEST_INVALID');
  rejects(
    () => prepareStudyRequest('study.create', { operation: 'run.submit' }),
    'STUDY_OPERATION_MISMATCH',
  );
  for (const requestId of [null, 3, '', '/unsafe'])
    rejects(() => prepareStudyRequest('study.create', { requestId }), 'STUDY_REQUEST_INVALID');
  for (const idempotencyKey of [null, 3, ''])
    rejects(() => prepareStudyRequest('study.create', { idempotencyKey }), 'STUDY_REQUEST_INVALID');
  rejects(
    () => prepareStudyRequest('study.read', { idempotencyKey: 'unexpected' }),
    'STUDY_REQUEST_INVALID',
  );
  rejects(
    () => prepareStudyRequest('study.create', { title: 'x'.repeat(STUDY_REQUEST_LIMIT) }),
    'PAYLOAD_TOO_LARGE',
  );
});

test('Response framing rejects invalid owner payload and contradictory HTTP status', async () => {
  const codec = await loadStudyCodec({
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421',
    [STUDY_CODEC_CANDIDATE_ENV]: STUDY_CODEC_MANIFEST_SHA256,
  });
  const request = prepareStudyRequest('capability.read', {});
  rejects(() => parseStudyResponse(null, request, 200, codec), 'STUDY_RESPONSE_INVALID');
  const success = {
    schemaVersion: STUDY_API_SCHEMA,
    requestId: request.requestId,
    ok: true,
    data: {
      type: 'capabilities',
      contractVersion: '2.0.0',
      runtimeEnabled: false,
      operations: ['capability.read'],
      profiles: [],
    },
  };
  rejects(() => parseStudyResponse(success, request, 500, codec), 'STUDY_RESPONSE_INVALID');
  assert.equal(parseStudyResponse(success, request, 200, codec).type, 'capabilities');
});

test('Contained module instantiation sanitizes incompatible JavaScript and allows the qualified ABI', async () => {
  await assert.rejects(
    instantiateStudyCodec(Buffer.from('this is not valid JavaScript !!!')),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_CONTRACT_INVALID',
  );
  const code = Buffer.from(
    'export const API_SCHEMA="lca.study-api.v2",CONTRACT_VERSION="2.0.0",operationMetadata={}; export function parseRequest(v){return v} export function parseResponse(v){return v} export function validateResponseForRequest(){}; export default {};',
  );
  assert.equal((await instantiateStudyCodec(code)).API_SCHEMA, STUDY_API_SCHEMA);
});

test('Private state uses the existing per-user root and rejects corrupt binding, schema and path', () => {
  const root = temporary();
  const request = prepareStudyRequest('study.create', {
    requestId: 'persisted',
    idempotencyKey: 'retained',
    title: 'state',
    scope: { kind: 'personal' },
  });
  const file = persistStudyIntent(request, selected, { XDG_STATE_HOME: root });
  assert(file.startsWith(path.join(root, 'tiangong-lca-cli', 'study')));
  const original = readFileSync(file, 'utf8');
  const record = JSON.parse(original);
  const variants: unknown[] = [
    null,
    { ...record, schemaVersion: 'other' },
    { ...record, binding: null },
    { ...record, request: null },
    { ...record, binding: { ...record.binding, endpoint: 3 } },
    { ...record, binding: { ...record.binding, actorId: 3 } },
    { ...record, binding: { ...record.binding, clientId: 3 } },
    { ...record, binding: { ...record.binding, extra: true } },
    { ...record, extra: true },
  ];
  for (const value of variants) {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    rejects(() => readStudyIntent(file), 'STUDY_INTENT_INVALID');
  }
  writeFileSync(file, original, { mode: 0o600 });
  const another = path.join(path.dirname(file), 'wrong-name.json');
  copyFileSync(file, another);
  rejects(() => readStudyIntent(another), 'STUDY_INTENT_INVALID');
  const foreign = path.join(root, 'foreign');
  mkdirSync(foreign, { mode: 0o700 });
  copyFileSync(file, path.join(foreign, 'intent.json'));
  rejects(() => readStudyIntent(path.join(foreign, 'intent.json')), 'STUDY_INTENT_INVALID');
  rejects(
    () => readStudyIntent(path.join(root, 'nonexistent-parent', 'intent.json')),
    'STUDY_INTENT_INVALID',
  );
  if (process.platform !== 'win32') {
    chmodSync(path.dirname(file), 0o755);
    rejects(() => readStudyIntent(file), 'STUDY_INTENT_INVALID');
    rejects(
      () => persistStudyIntent(request, selected, { XDG_STATE_HOME: root }),
      'STUDY_STATE_INVALID',
    );
    chmodSync(path.dirname(file), 0o700);
  }
});

test('Bounded file reads reject directories, oversize, malformed UTF8 and growth after stat', () => {
  const root = temporary();
  const file = path.join(root, 'input.json');
  writeFileSync(file, '{"value":1}', { mode: 0o600 });
  rejects(() => readStudyJson(root), 'STUDY_INPUT_INVALID');
  rejects(() => readStudyJson(file, 1), 'STUDY_INPUT_INVALID');
  const invalid = path.join(root, 'invalid.json');
  writeFileSync(invalid, Buffer.from([0xff]));
  rejects(() => readStudyJson(invalid), 'STUDY_INPUT_INVALID');
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const stat = fs.fstatSync;
  try {
    fs.fstatSync = ((fd: number) => ({
      mode: stat(fd).mode,
      size: 0,
      isFile: () => true,
    })) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    rejects(() => readStudyJson(file, 2), 'PAYLOAD_TOO_LARGE');
    fs.fstatSync = ((fd: number) => ({
      mode: stat(fd).mode,
      size: 0,
      isFile: () => false,
    })) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    rejects(() => readStudyJson(file), 'STUDY_INPUT_INVALID');
  } finally {
    fs.fstatSync = stat;
    syncBuiltinESMExports();
  }
});

test('Intent publication failure cannot overwrite a competing request or leave a partial temporary file', () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const link = fs.linkSync;
  for (const mode of ['failure', 'same', 'different']) {
    const root = temporary();
    const request = prepareStudyRequest('study.create', {
      requestId: 'publication',
      idempotencyKey: 'key',
      title: 'initial',
      scope: { kind: 'personal' },
    });
    try {
      fs.linkSync = ((source: string, target: string) => {
        if (mode !== 'failure') {
          const value = JSON.parse(readFileSync(source, 'utf8'));
          if (mode === 'different') {
            value.request.title = 'competing';
            value.requestSha256 = studyDigest(studyJson(value.request));
          }
          writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
        }
        throw new Error('private publication error');
      }) as typeof fs.linkSync;
      syncBuiltinESMExports();
      rejects(
        () => persistStudyIntent(request, selected, {}, root),
        mode === 'failure'
          ? 'STUDY_STATE_WRITE_FAILED'
          : mode === 'same'
            ? 'STUDY_RECOVERY_REQUIRED'
            : 'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) =>
          file.endsWith('.tmp'),
        ).length,
        0,
      );
    } finally {
      fs.linkSync = link;
      syncBuiltinESMExports();
    }
  }
  const blocked = path.join(temporary(), 'file-not-directory');
  writeFileSync(blocked, 'owned');
  rejects(
    () => persistStudyIntent(prepareStudyRequest('study.create', {}), selected, {}, blocked),
    'STUDY_STATE_WRITE_FAILED',
  );
});

test('Artifact verifier binds every selection and enforces independent byte limits before publication', () => {
  const bytes = Buffer.from('0');
  const ref = { type: 'runResult', id: 'artifact', byteSize: 1, contentHash: studyDigest(bytes) };
  const request = prepareStudyRequest('artifact.read', { studyId: 'study', artifactRef: ref });
  const response = {
    type: 'artifact',
    studyId: 'study',
    artifactRef: ref,
    encoding: 'base64',
    bytes: bytes.toString('base64'),
  };
  assert.equal(verifyStudyArtifact(request, response, []).bytes.toString(), '0');
  rejects(
    () => verifyStudyArtifact(request, { ...response, studyId: 'other' }, []),
    'STUDY_ARTIFACT_BINDING',
  );
  rejects(
    () => verifyStudyArtifact(request, { ...response, artifactRef: { ...ref, id: 'other' } }, []),
    'STUDY_ARTIFACT_BINDING',
  );
  for (const byteSize of [-1, 1.5, 4 * 1024 * 1024 + 1]) {
    const changed = { ...ref, byteSize };
    rejects(
      () =>
        verifyStudyArtifact(
          { ...request, artifactRef: changed },
          { ...response, artifactRef: changed },
          [],
        ),
      'PAYLOAD_TOO_LARGE',
    );
  }
  rejects(
    () => verifyStudyArtifact(request, { ...response, bytes: 'MA' }, []),
    'STUDY_ARTIFACT_INTEGRITY',
  );
});

test('Auth wrapper scopes destinations, deadlines and fallback responses without relaxing the Auth owner', async () => {
  let calls = 0;
  const controller = new AbortController();
  const fallback = createStudyAuthFetch('http://127.0.0.1:1234', controller.signal, async () => ({
    ok: true,
    status: 204,
    headers: { get: () => null },
    text: async () => {
      calls++;
      return '';
    },
  }));
  assert.equal((await fallback('http://127.0.0.1:1234/auth/v1/user')).status, 204);
  assert.equal(calls, 1);
  await assert.rejects(
    fallback('http://127.0.0.1:5678/auth/v1/user'),
    (error: unknown) => error instanceof CliError && error.code === 'STUDY_DESTINATION_INVALID',
  );
  controller.abort();
  await assert.rejects(
    fallback('http://127.0.0.1:1234/auth/v1/user'),
    (error: unknown) => error instanceof CliError && error.code === 'DEADLINE_EXCEEDED',
  );
  assert.equal(calls, 1);
});

test('Unknown wire versions and raw file errors stay within stable CLI error envelopes', () => {
  rejects(() => studyApiVersion('lca.study-api.foreign'), 'UNSUPPORTED_SCHEMA');
  rejects(() => readStudyBytes(path.join(temporary(), 'missing')), 'STUDY_INPUT_INVALID');
});

test('Contained ESM loading handles compatibility namespace shapes without bypassing ABI validation', async () => {
  const fields =
    'API_SCHEMA:"lca.study-api.v2",CONTRACT_VERSION:"2.0.0",operationMetadata:{},parseRequest(v){return v},parseResponse(v){return v},validateResponseForRequest(){}';
  assert.equal(
    (await instantiateStudyCodec(Buffer.from('export default {__esModule:true,' + fields + '}')))
      .API_SCHEMA,
    STUDY_API_SCHEMA,
  );
  for (const value of ['false', '"ordinary string"', 'null'])
    await assert.rejects(
      instantiateStudyCodec(Buffer.from('export default ' + value)),
      (error: unknown) => error instanceof CliError && error.code === 'STUDY_CONTRACT_INVALID',
    );
});

test('Auth response budgets reject oversized streams and fallback text even if cancellation rejects', async () => {
  const controller = new AbortController();
  for (const streaming of [true, false]) {
    const fetchImpl = createStudyAuthFetch(
      selected.endpoint.split('/functions/')[0],
      controller.signal,
      async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        ...(streaming
          ? {
              body: new ReadableStream<Uint8Array>({
                start(output) {
                  output.enqueue(new Uint8Array(65 * 1024));
                },
                cancel() {
                  throw new Error('cancel refuses');
                },
              }),
            }
          : {}),
        text: async () => 'x'.repeat(65 * 1024),
      }),
    );
    await assert.rejects(
      fetchImpl('http://127.0.0.1:1234/auth/v1/user'),
      (error: unknown) => error instanceof CliError && error.code === 'PAYLOAD_TOO_LARGE',
    );
  }
});
