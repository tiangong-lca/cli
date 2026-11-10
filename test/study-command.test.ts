import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/shared/errors.js';
import {
  admitStudyCodecCandidate,
  STUDY_CODEC_CANDIDATE_ENV,
  STUDY_CODEC_MANIFEST_SHA256,
} from '../src/lib/study-codec.js';
import { readStudyIntent } from '../src/lib/study-intent.js';
import {
  STUDY_COMMANDS,
  STUDY_API_SCHEMA,
  studyDigest,
  studyObject,
  studyJson,
} from '../src/lib/study-protocol.js';
import { runStudyRequest, type StudyCommandReport } from '../src/lib/study-transport.js';
import type { FetchLike } from '../src/lib/http.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const STUDY = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const directories: string[] = [];
test.after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const file = mkdtempSync(path.join(os.tmpdir(), 'cli-study-'));
  directories.push(file);
  return file;
}
function token(actor = ACTOR, client = CLIENT): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: actor, client_id: client, role: 'authenticated' })).toString('base64url')}.synthetic-signature`;
}
function env(actor = ACTOR, client = CLIENT): NodeJS.ProcessEnv {
  return {
    TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56421/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: token(actor, client),
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function server(
  options: {
    userId?: string;
    disabled?: boolean;
    lost?: boolean;
    errorCode?: string;
    response?: (request: Record<string, unknown>) => Response;
    onWrite?: (request: Record<string, unknown>) => void;
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  const receipts = new Map<string, unknown>();
  let lost = options.lost ?? false;
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/auth/v1/user'))
      return json({
        id: options.userId ?? ACTOR,
        email: 'fixture@example.test',
        aud: 'authenticated',
        role: 'authenticated',
      });
    assert.equal(url, 'http://127.0.0.1:56421/functions/v1/app_lca_study');
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(new Headers(init?.headers).get('x-study-schema'), request.schemaVersion);
    requests.push(request);
    const envelope = (data: unknown) =>
      json({ schemaVersion: STUDY_API_SCHEMA, requestId: request.requestId, ok: true, data });
    if (request.operation === 'capability.read')
      return envelope({
        type: 'capabilities',
        contractVersion: '2.0.0',
        runtimeEnabled: !options.disabled,
        operations: options.disabled
          ? ['capability.read']
          : [...new Set(Object.values(STUDY_COMMANDS))],
        profiles: [
          {
            profileId: 'lca.study-explicit-v1',
            calculationContractRef: {
              kind: 'calculation_contract',
              schema: 'lca.calculation-contract.v1',
              sha256: HASH,
            },
          },
        ],
      });
    if (options.errorCode)
      return json(
        {
          schemaVersion: STUDY_API_SCHEMA,
          requestId: request.requestId,
          ok: false,
          code: options.errorCode,
          message: 'sanitized',
          retryable: false,
          issues: [],
        },
        403,
      );
    if (options.response) return options.response(request);
    if (request.operation === 'study.create') {
      const key = String(request.idempotencyKey);
      if (!receipts.has(key)) {
        options.onWrite?.(request);
        receipts.set(key, {
          type: 'study',
          value: {
            studyId: STUDY,
            revision: 1,
            scope: { kind: 'user', id: ACTOR },
            title: request.title,
            status: 'active',
            currentRevisionId: null,
          },
        });
      }
      if (lost) {
        lost = false;
        throw new Error('private provider message must not escape');
      }
      return envelope(receipts.get(key));
    }
    return envelope({
      type: 'study',
      value: {
        studyId: request.studyId,
        revision: 1,
        scope: { kind: 'user', id: ACTOR },
        title: 'fixture',
        status: 'active',
        currentRevisionId: null,
      },
    });
  };
  return { fetchImpl, requests, receipts };
}
function payload(file: string, value: unknown): string {
  writeFileSync(file, JSON.stringify(value));
  return file;
}
async function rejected(promise: Promise<unknown>, code: string): Promise<CliError> {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (error) {
    assert(error instanceof CliError);
    assert.equal(error.code, code);
    return error;
  }
}
function options(fetchImpl: FetchLike, stateDir = directory()) {
  return { env: env(), fetchImpl, stateDir, timeoutMs: 5000 };
}

test('Study help and P2 boundaries have no network or installation side effects', async () => {
  for (const args of [['study'], ['study', 'model', '--help'], ['study', '--help']]) {
    const result = await executeCli(args, {
      env: {},
      dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
      fetchImpl: async () => {
        throw new Error('unexpected');
      },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /request recover/u);
    assert.match(result.stdout, /no Study rights/u);
  }
  for (const action of ['analysis', 'report', 'export']) {
    const result = await executeCli(['study', action, '--json'], {
      env: {},
      dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
      fetchImpl: async () => {
        throw new Error('unexpected');
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'CAPABILITY_UNAVAILABLE');
  }
});

test('Study creation flushes immutable actor-bound intent before dispatch and retains no credentials', async () => {
  const root = directory();
  let beforeDispatch = false;
  const remote = server({
    onWrite: () => {
      const request = remote.requests.at(-1)!;
      assert.equal(request.operation, 'study.create');
      const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) =>
        file.endsWith('intent.json'),
      );
      assert.equal(files.length, 1);
      assert.equal(readStudyIntent(path.join(root, files[0])).request.requestId, request.requestId);
      beforeDispatch = true;
    },
  });
  const report = await runStudyRequest(
    'study.create',
    { title: 'A study', scope: { kind: 'personal' } },
    options(remote.fetchImpl, root),
  );
  assert(beforeDispatch);
  assert(report.intentFile);
  const saved = readStudyIntent(report.intentFile);
  assert.equal(saved.binding.actorId, ACTOR);
  assert.equal(saved.binding.clientId, CLIENT);
  assert.equal(saved.request.requestId, report.requestId);
  assert.equal(saved.requestSha256, studyDigest(studyJson(saved.request)));
  const text = readFileSync(report.intentFile, 'utf8');
  assert(!text.includes(token()));
  assert(!text.includes('fixture-publishable-key'));
  if (process.platform !== 'win32') assert.equal(statSync(report.intentFile).mode & 0o077, 0);
  assert.deepEqual(
    remote.requests.map((request) => request.operation),
    ['capability.read', 'study.create'],
  );
});

test('Lost mutation response recovers exactly the saved request and one server outcome', async () => {
  const remote = server({ lost: true });
  const settings = options(remote.fetchImpl);
  const error = await rejected(
    runStudyRequest('study.create', { title: 'Lost reply', scope: { kind: 'personal' } }, settings),
    'STUDY_TRANSPORT_UNKNOWN',
  );
  assert(studyObject(error.details) && typeof error.details.intentFile === 'string');
  assert(!JSON.stringify(error).includes('private provider message'));
  const file = error.details.intentFile;
  const saved = readStudyIntent(file);
  const report = await runStudyRequest(saved.request.operation, saved.request, {
    ...settings,
    recoverFile: file,
  });
  assert.equal(report.intentFile, file);
  assert.equal(report.requestId, saved.request.requestId);
  assert.equal(remote.receipts.size, 1);
  const writes = remote.requests.filter((request) => request.operation === 'study.create');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
});

test('Reusing a mutation key requires explicit recovery and rejects changed intent', async () => {
  const remote = server();
  const settings = options(remote.fetchImpl);
  const input = {
    requestId: 'stable-request',
    idempotencyKey: 'stable-key',
    title: 'first',
    scope: { kind: 'personal' },
  };
  const first = await runStudyRequest('study.create', input, settings);
  const retry = await rejected(
    runStudyRequest('study.create', input, settings),
    'STUDY_RECOVERY_REQUIRED',
  );
  assert(studyObject(retry.details));
  assert.equal(retry.details.intentFile, first.intentFile);
  await rejected(
    runStudyRequest('study.create', { ...input, title: 'changed' }, settings),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(remote.requests.filter((request) => request.operation === 'study.create').length, 1);
});

test('Recovery refuses a foreign destination, live actor, client or changed saved request', async () => {
  const remote = server();
  const settings = options(remote.fetchImpl);
  const report = await runStudyRequest(
    'study.create',
    { title: 'bound', scope: { kind: 'personal' } },
    settings,
  );
  const file = report.intentFile!;
  const saved = readStudyIntent(file);
  let network = 0;
  await rejected(
    runStudyRequest(saved.request.operation, saved.request, {
      ...settings,
      recoverFile: file,
      env: { ...env(), TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:56422' },
      fetchImpl: async () => {
        network++;
        throw new Error('must not fetch');
      },
    }),
    'STUDY_RECOVERY_BINDING_MISMATCH',
  );
  assert.equal(network, 0);
  for (const [actor, client] of [
    [OTHER, CLIENT],
    [ACTOR, OTHER],
  ]) {
    const switched = server({ userId: actor });
    await rejected(
      runStudyRequest(saved.request.operation, saved.request, {
        ...settings,
        recoverFile: file,
        env: env(actor, client),
        fetchImpl: switched.fetchImpl,
      }),
      'STUDY_RECOVERY_BINDING_MISMATCH',
    );
    assert.equal(switched.requests.length, 0);
  }
  const original = readFileSync(file, 'utf8');
  const corrupted = JSON.parse(original);
  corrupted.request.title = 'tampered';
  writeFileSync(file, JSON.stringify(corrupted), { mode: 0o600 });
  await rejected(
    runStudyRequest(saved.request.operation, saved.request, { ...settings, recoverFile: file }),
    'STUDY_INTENT_INVALID',
  );
  writeFileSync(file, original, { mode: 0o600 });
});

test('Selected token must match the live actor and configured OAuth client', async () => {
  const remote = server({ userId: ACTOR });
  await rejected(
    runStudyRequest('capability.read', {}, { ...options(remote.fetchImpl), env: env(OTHER) }),
    'STUDY_SESSION_BINDING_INVALID',
  );
  assert.equal(remote.requests.length, 0);
});

test('Current capability rejection never creates a mutation or a replacement key', async () => {
  const remote = server({ disabled: true });
  await rejected(
    runStudyRequest(
      'study.create',
      { title: 'not admitted', scope: { kind: 'personal' } },
      options(remote.fetchImpl),
    ),
    'CAPABILITY_UNAVAILABLE',
  );
  assert.deepEqual(
    remote.requests.map((request) => request.operation),
    ['capability.read'],
  );
  const denied = server({ errorCode: 'FORBIDDEN' });
  const rejection = await rejected(
    runStudyRequest(
      'study.create',
      { title: 'denied', scope: { kind: 'personal' } },
      options(denied.fetchImpl),
    ),
    'FORBIDDEN',
  );
  assert(studyObject(rejection.details) && typeof rejection.details.intentFile === 'string');
  assert.equal(denied.requests.filter((request) => request.operation === 'study.create').length, 1);
});

test('Owner codec rejects malformed requests before authentication or persistence', async () => {
  const remote = server();
  for (const input of [
    { title: 'a', scope: { kind: 'personal' }, actorId: OTHER },
    { title: '', scope: { kind: 'personal' } },
  ])
    await rejected(
      runStudyRequest('study.create', input, options(remote.fetchImpl)),
      'INVALID_REQUEST',
    );
  await rejected(
    runStudyRequest(
      'study.create',
      { title: 'secret', password: 'must-not-persist' },
      options(remote.fetchImpl),
    ),
    'STUDY_PRIVATE_PAYLOAD',
  );
  await rejected(
    runStudyRequest(
      'study.create',
      { schemaVersion: 'lca.study-api.v1' },
      options(remote.fetchImpl),
    ),
    'UNSUPPORTED_SCHEMA',
  );
  assert.equal(remote.requests.length, 0);
});

test('Artifacts are exact-byte verified, private, atomic and never echoed as base64', async () => {
  const bytes = Buffer.from('{"value":0}');
  const ref = {
    type: 'runResult',
    id: 'result-1',
    contentHash: studyDigest(bytes),
    digestScope: 'artifact_bytes_sha256',
    byteSize: bytes.length,
    mediaType: 'application/json',
    schemaVersion: 'lca.study-result.v1',
  };
  const root = directory();
  const output = path.join(root, 'result.json');
  const remote = server({
    response: (request) =>
      json({
        schemaVersion: STUDY_API_SCHEMA,
        requestId: request.requestId,
        ok: true,
        data: {
          type: 'artifact',
          studyId: STUDY,
          artifactRef: ref,
          encoding: 'base64',
          bytes: bytes.toString('base64'),
        },
      }),
  });
  const report = await runStudyRequest(
    'artifact.read',
    { studyId: STUDY, artifactRef: ref },
    { ...options(remote.fetchImpl), outputPath: output },
  );
  assert.equal(readFileSync(output, 'utf8'), bytes.toString());
  assert.equal(report.output?.sha256, ref.contentHash);
  assert.equal(report.data.bytes, undefined);
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o077, 0);
  await rejected(
    runStudyRequest(
      'artifact.read',
      { studyId: STUDY, artifactRef: ref },
      { ...options(remote.fetchImpl), outputPath: output },
    ),
    'STUDY_OUTPUT_EXISTS',
  );
  const corrupt = server({
    response: (request) =>
      json({
        schemaVersion: STUDY_API_SCHEMA,
        requestId: request.requestId,
        ok: true,
        data: {
          type: 'artifact',
          studyId: STUDY,
          artifactRef: ref,
          encoding: 'base64',
          bytes: Buffer.from('corrupt').toString('base64'),
        },
      }),
  });
  await rejected(
    runStudyRequest(
      'artifact.read',
      { studyId: STUDY, artifactRef: ref },
      { ...options(corrupt.fetchImpl), outputPath: path.join(root, 'corrupt.json') },
    ),
    'STUDY_ARTIFACT_INTEGRITY',
  );
});

test('Request recovery works through public command dispatch after a fresh invocation', async () => {
  const root = directory();
  const remote = server({ lost: true });
  const file = payload(path.join(root, 'request.json'), {
    title: 'CLI',
    scope: { kind: 'personal' },
  });
  const deps = {
    env: env(),
    fetchImpl: remote.fetchImpl,
    dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
  };
  const first = await executeCli(
    ['study', 'create', '--input', file, '--state-dir', root, '--json'],
    deps,
  );
  assert.equal(first.exitCode, 1);
  const intentFile = JSON.parse(first.stderr).error.details.intentFile as string;
  const recovered = await executeCli(
    ['study', 'request', 'recover', '--intent-file', intentFile, '--json'],
    { ...deps, env: { ...env() } },
  );
  assert.equal(recovered.exitCode, 0);
  assert.equal((JSON.parse(recovered.stdout) as StudyCommandReport).data.type, 'study');
});

test('Task wait uses scoped reads, returns pending honestly, and reports failed terminal tasks', async () => {
  const root = directory();
  const input = payload(path.join(root, 'task.json'), {
    studyId: STUDY,
    resource: { type: 'run', id: 'run-1' },
  });
  for (const status of ['queued', 'failed', 'completed']) {
    const remote = server({
      response: (request) =>
        json({
          schemaVersion: STUDY_API_SCHEMA,
          requestId: request.requestId,
          ok: true,
          data: {
            type: 'task',
            value: {
              studyId: STUDY,
              resource: { type: 'run', id: 'run-1' },
              execution: {
                jobId: 'job-1',
                status,
                phase: status === 'queued' ? 'queued' : 'complete',
                progress: status === 'queued' ? null : 1,
              },
              errorCode: status === 'failed' ? 'runtime_failed' : null,
            },
          },
        }),
    });
    const result = await executeCli(
      ['study', 'task', 'wait', '--input', input, '--wait-ms', '0', '--json'],
      {
        env: env(),
        fetchImpl: remote.fetchImpl,
        dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
      },
    );
    assert.equal(result.exitCode, status === 'failed' ? 1 : 0);
    assert.equal(JSON.parse(result.stdout).waiting, status === 'queued');
    assert.deepEqual(
      remote.requests.map((request) => request.operation),
      ['capability.read', 'task.read'],
    );
  }
});

test('Private recovery files refuse permissive mode and malformed contents', async () => {
  const root = directory();
  const file = payload(path.join(root, 'intent.json'), { invalid: true });
  assert.throws(() => readStudyIntent(file), CliError);
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    assert.throws(() => readStudyIntent(file), CliError);
  }
});

test('Existing OAuth cache selection retains its configured client and tolerates same-scope token rotation', async () => {
  const remote = server();
  const oauthInput: NodeJS.ProcessEnv = {
    ...env(),
    TIANGONG_LCA_AUTH_MODE: 'oauth',
    TIANGONG_LCA_OAUTH_CLIENT_ID: CLIENT,
  };
  delete oauthInput.TIANGONG_LCA_DISABLE_SESSION_CACHE;
  const oauth = buildSupabaseTestEnv(oauthInput);
  const first = await runStudyRequest(
    'study.create',
    { title: 'OAuth selected', scope: { kind: 'personal' } },
    { ...options(remote.fetchImpl), env: oauth },
  );
  assert(first.intentFile);
  const saved = readStudyIntent(first.intentFile);
  const rotated = `${token().split('.').slice(0, 2).join('.')}.another-synthetic-signature`;
  const second = await runStudyRequest(saved.request.operation, saved.request, {
    ...options(remote.fetchImpl),
    recoverFile: first.intentFile,
    env: { ...env(), TIANGONG_LCA_ACCESS_TOKEN: rotated },
  });
  assert.equal(second.requestId, first.requestId);
  const wrongInput: NodeJS.ProcessEnv = {
    ...env(ACTOR, OTHER),
    TIANGONG_LCA_AUTH_MODE: 'oauth',
    TIANGONG_LCA_OAUTH_CLIENT_ID: CLIENT,
  };
  delete wrongInput.TIANGONG_LCA_DISABLE_SESSION_CACHE;
  const wrongClient = buildSupabaseTestEnv(wrongInput);
  await rejected(
    runStudyRequest('capability.read', {}, { ...options(remote.fetchImpl), env: wrongClient }),
    'STUDY_SESSION_BINDING_INVALID',
  );
});

test('Clean bundled codecs need no candidate override while synthetic worktree artifacts retain the development boundary', async () => {
  const remote = server();
  const clean = { ...env() };
  delete clean[STUDY_CODEC_CANDIDATE_ENV];
  assert.equal(
    (await runStudyRequest('capability.read', {}, { ...options(remote.fetchImpl), env: clean }))
      .data.type,
    'capabilities',
  );
  for (const candidateEnv of [
    clean,
    {
      TIANGONG_LCA_API_BASE_URL: 'https://production.supabase.co',
      [STUDY_CODEC_CANDIDATE_ENV]: STUDY_CODEC_MANIFEST_SHA256,
    },
  ]) {
    assert.throws(
      () =>
        admitStudyCodecCandidate(
          { sourceStatus: 'worktree' },
          candidateEnv,
          STUDY_CODEC_MANIFEST_SHA256,
        ),
      (error: unknown) =>
        error instanceof CliError && error.code === 'STUDY_CONTRACT_CANDIDATE_REQUIRED',
    );
  }
});

test('Transport deadline keeps a dispatched unknown mutation recoverable without retry', async () => {
  const remote = server();
  let dispatched = 0;
  const stalled: FetchLike = (url, init) => {
    if (
      url.endsWith('/app_lca_study') &&
      JSON.parse(String(init?.body)).operation === 'study.create'
    ) {
      dispatched++;
      return new Promise(() => {});
    }
    return remote.fetchImpl(url, init);
  };
  const failure = await rejected(
    runStudyRequest(
      'study.create',
      { title: 'deadline', scope: { kind: 'personal' } },
      { ...options(stalled), timeoutMs: 30 },
    ),
    'DEADLINE_EXCEEDED',
  );
  assert.equal(dispatched, 1);
  assert(studyObject(failure.details) && typeof failure.details.intentFile === 'string');
  assert.equal(readStudyIntent(failure.details.intentFile).request.operation, 'study.create');
});

test('A stalled response reader is cancelled at the command deadline', async () => {
  let cancelled = false;
  const remote = server({
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await rejected(
    runStudyRequest(
      'study.read',
      { studyId: STUDY },
      { ...options(remote.fetchImpl), timeoutMs: 30 },
    ),
    'DEADLINE_EXCEEDED',
  );
  assert(cancelled);
});

test('Oversized, non-JSON, invalid-UTF8 and transplanted responses are rejected without provider text', async () => {
  const variants: Array<[string, (request: Record<string, unknown>) => Response]> = [
    [
      'PAYLOAD_TOO_LARGE',
      () =>
        new Response('sensitive provider text', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(6 * 1024 * 1024 + 1),
          },
        }),
    ],
    [
      'STUDY_RESPONSE_INVALID',
      () => new Response('sensitive provider text', { headers: { 'content-type': 'text/html' } }),
    ],
    [
      'STUDY_RESPONSE_INVALID',
      () =>
        new Response(new Uint8Array([0xff, 0xfe]), {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'STUDY_RESPONSE_SELECTION',
      () =>
        json({
          schemaVersion: STUDY_API_SCHEMA,
          requestId: 'another-request',
          ok: true,
          data: {
            type: 'study',
            value: {
              studyId: STUDY,
              revision: 1,
              scope: { kind: 'user', id: ACTOR },
              title: 'fixture',
              status: 'active',
              currentRevisionId: null,
            },
          },
        }),
    ],
    [
      'STUDY_PRIVATE_PAYLOAD',
      (request) =>
        json({
          schemaVersion: STUDY_API_SCHEMA,
          requestId: request.requestId,
          ok: true,
          data: { storageBucket: 'sensitive provider text' },
        }),
    ],
  ];
  for (const [code, response] of variants) {
    const remote = server({ response });
    const failure = await rejected(
      runStudyRequest('study.read', { studyId: STUDY }, options(remote.fetchImpl)),
      code,
    );
    assert(!JSON.stringify(failure).includes('sensitive provider text'));
  }
});

test('Artifact refusal preserves existing output and rejects credentials and service source bytes', async () => {
  const root = directory();
  const output = path.join(root, 'kept.json');
  for (const [kind, bytes, expected] of [
    ['runResult', Buffer.from(token()), 'STUDY_PRIVATE_PAYLOAD'],
    ['modelSource', Buffer.from('service-only source'), 'DISCLOSURE_DENIED'],
  ] as const) {
    const ref = {
      type: kind,
      id: 'artifact-private',
      contentHash: studyDigest(bytes),
      digestScope: 'artifact_bytes_sha256',
      byteSize: bytes.length,
      mediaType: 'application/json',
      schemaVersion: 'fixture.bytes.v1',
    };
    const remote = server({
      response: (request) =>
        json({
          schemaVersion: STUDY_API_SCHEMA,
          requestId: request.requestId,
          ok: true,
          data: {
            type: 'artifact',
            studyId: STUDY,
            artifactRef: ref,
            encoding: 'base64',
            bytes: bytes.toString('base64'),
          },
        }),
    });
    await rejected(
      runStudyRequest(
        'artifact.read',
        { studyId: STUDY, artifactRef: ref },
        { ...options(remote.fetchImpl), outputPath: output },
      ),
      expected,
    );
    assert.equal(existsSync(output), false);
  }
  writeFileSync(output, 'kept-user-output');
  const bytes = Buffer.from('replacement');
  const ref = {
    type: 'runResult',
    id: 'artifact-force',
    contentHash: studyDigest(bytes),
    digestScope: 'artifact_bytes_sha256',
    byteSize: bytes.length,
    mediaType: 'application/json',
    schemaVersion: 'fixture.bytes.v1',
  };
  const remote = server({
    response: (request) =>
      json({
        schemaVersion: STUDY_API_SCHEMA,
        requestId: request.requestId,
        ok: true,
        data: {
          type: 'artifact',
          studyId: STUDY,
          artifactRef: ref,
          encoding: 'base64',
          bytes: bytes.toString('base64'),
        },
      }),
  });
  await runStudyRequest(
    'artifact.read',
    { studyId: STUDY, artifactRef: ref },
    { ...options(remote.fetchImpl), outputPath: output, force: true },
  );
  assert.equal(readFileSync(output, 'utf8'), 'replacement');
});

test('Command usage errors never echo a credential-like argument', async () => {
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
    fetchImpl: async () => {
      throw new Error('no fetch');
    },
  };
  for (const args of [
    ['study', 'unknown'],
    ['study', 'create'],
    ['study', 'get', '--password', 'credential-sentinel'],
    ['study', 'request', 'recover'],
    ['study', 'capabilities', '--wait-ms', '1'],
    ['study', 'capabilities', '--timeout-ms', 'NaN'],
    ['study', 'capabilities', '--force'],
  ]) {
    const result = await executeCli(args, deps);
    assert.notEqual(result.exitCode, 0);
    assert(!result.stderr.includes('credential-sentinel'));
  }
});

test('Task polling uses bounded monotonic waits and refreshes live admission for every read', async (t) => {
  const root = directory();
  const input = payload(path.join(root, 'task.json'), {
    studyId: STUDY,
    resource: { type: 'run', id: 'run-1' },
  });
  for (const finish of [true, false]) {
    let reads = 0;
    const remote = server({
      response(request) {
        reads++;
        return json({
          schemaVersion: STUDY_API_SCHEMA,
          requestId: request.requestId,
          ok: true,
          data: {
            type: 'task',
            value: {
              studyId: STUDY,
              resource: { type: 'run', id: 'run-1' },
              execution: {
                jobId: 'job',
                status: finish && reads > 1 ? 'completed' : 'queued',
                phase: 'queued',
                progress: null,
              },
              errorCode: null,
            },
          },
        });
      },
    });
    let clockReads = 0;
    const monotonic = t.mock.method(performance, 'now', () => {
      clockReads++;
      return finish ? (clockReads < 3 ? 0 : 1) : clockReads < 3 ? 0 : 1000;
    });
    const result = await executeCli(
      [
        'study',
        'task',
        'wait',
        '--input',
        input,
        '--wait-ms',
        finish ? '500' : '5',
        '--poll-ms',
        finish ? '1' : '50',
        '--json',
      ],
      {
        env: env(),
        fetchImpl: remote.fetchImpl,
        dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
      },
    );
    monotonic.mock.restore();
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).waiting, !finish);
    if (finish) assert.equal(reads, 2);
    else assert(reads >= 1);
  }
  const remote = server();
  const human = await executeCli(['study', 'capabilities'], {
    env: env(),
    fetchImpl: remote.fetchImpl,
    dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
  });
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /Study capability.read/u);
});

test('Transport refuses malformed sessions, destinations and conflicting recovery or artifact output before dispatch', async () => {
  const noNetwork: FetchLike = async () => {
    throw new Error('must not dispatch');
  };
  for (const base of [
    'not-a-url',
    'http://192.0.2.1',
    'https://user:pass@example.test',
    'https://example.test/?query=1',
    'https://example.test/#fragment',
    'https://example.test/foreign',
  ])
    await rejected(
      runStudyRequest(
        'capability.read',
        {},
        { env: { ...env(), TIANGONG_LCA_API_BASE_URL: base }, fetchImpl: noNetwork },
      ),
      'STUDY_DESTINATION_INVALID',
    );
  for (const timeoutMs of [0, NaN, 60_001])
    await rejected(
      runStudyRequest('capability.read', {}, { env: env(), fetchImpl: noNetwork, timeoutMs }),
      'INVALID_ARGS',
    );
  for (const claims of [
    'malformed',
    Buffer.from('[]').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: ACTOR, client_id: 1 })).toString('base64url'),
  ]) {
    const remote = server();
    await rejected(
      runStudyRequest(
        'capability.read',
        {},
        {
          ...options(remote.fetchImpl),
          env: { ...env(), TIANGONG_LCA_ACCESS_TOKEN: `header.${claims}.fixture` },
        },
      ),
      'STUDY_SESSION_BINDING_INVALID',
    );
    assert.equal(remote.requests.length, 0);
  }
  const remote = server();
  await rejected(
    runStudyRequest(
      'capability.read',
      {},
      { ...options(remote.fetchImpl), outputPath: path.join(directory(), 'unwanted') },
    ),
    'INVALID_ARGS',
  );
  const created = await runStudyRequest(
    'study.create',
    { title: 'original', scope: { kind: 'personal' } },
    options(remote.fetchImpl),
  );
  const saved = readStudyIntent(created.intentFile!);
  await rejected(
    runStudyRequest(
      'study.create',
      { ...saved.request, title: 'changed' },
      { ...options(remote.fetchImpl), recoverFile: created.intentFile },
    ),
    'STUDY_INTENT_INVALID',
  );
  await rejected(
    runStudyRequest('study.create', saved.request, {
      ...options(remote.fetchImpl),
      apiVersion: 'v3',
      recoverFile: created.intentFile,
    }),
    'STUDY_RECOVERY_BINDING_MISMATCH',
  );
});

test('Exact calculation profile admission and atomic artifact output remain authoritative at transport', async () => {
  for (const [profileId, hash] of [
    ['foreign-profile', HASH],
    ['lca.study-explicit-v1', 'b'.repeat(64)],
    ['lca.study-explicit-v1', HASH],
  ]) {
    const remote = server({ errorCode: 'FORBIDDEN' });
    await rejected(
      runStudyRequest(
        'run.submit',
        {
          studyRevisionId: 'revision',
          scenarioRevisionId: 'scenario',
          expectedInputHash: HASH,
          profileId,
          calculationContractRef: {
            kind: 'calculation_contract',
            schema: 'lca.calculation-contract.v1',
            sha256: hash,
          },
        },
        options(remote.fetchImpl),
      ),
      profileId === 'lca.study-explicit-v1' && hash === HASH
        ? 'FORBIDDEN'
        : 'CAPABILITY_UNAVAILABLE',
    );
  }
  const bytes = Buffer.from('exact artifact');
  const artifactRef = {
    type: 'runResult',
    id: 'result',
    contentHash: studyDigest(bytes),
    digestScope: 'artifact_bytes_sha256',
    byteSize: bytes.length,
    mediaType: 'application/json',
    schemaVersion: 'lca.study-result.v1',
  };
  const remote = server({
    response: (request) =>
      json({
        schemaVersion: STUDY_API_SCHEMA,
        requestId: request.requestId,
        ok: true,
        data: {
          type: 'artifact',
          studyId: STUDY,
          artifactRef,
          encoding: 'base64',
          bytes: bytes.toString('base64'),
        },
      }),
  });
  await rejected(
    runStudyRequest('artifact.read', { studyId: STUDY, artifactRef }, options(remote.fetchImpl)),
    'STUDY_OUTPUT_REQUIRED',
  );
  const blocker = path.join(directory(), 'blocker');
  writeFileSync(blocker, 'other owner');
  await rejected(
    runStudyRequest(
      'artifact.read',
      { studyId: STUDY, artifactRef },
      { ...options(remote.fetchImpl), outputPath: path.join(blocker, 'artifact') },
    ),
    'STUDY_OUTPUT_WRITE_FAILED',
  );
  assert.equal(readFileSync(blocker, 'utf8'), 'other owner');
  const missingSubject = env();
  missingSubject.TIANGONG_LCA_ACCESS_TOKEN = 'single-token-segment';
  await rejected(
    runStudyRequest('capability.read', {}, { ...options(server().fetchImpl), env: missingSubject }),
    'STUDY_SESSION_BINDING_INVALID',
  );
});

test('A native fetch abort race retains the dispatched intent and stable deadline error', async () => {
  const remote = server();
  const fetchImpl: FetchLike = (url, init) => {
    if (
      url.endsWith('/auth/v1/user') ||
      JSON.parse(String(init?.body)).operation === 'capability.read'
    )
      return remote.fetchImpl(url, init);
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('private transport text', 'AbortError')),
        { once: true },
      ),
    );
  };
  await rejected(
    runStudyRequest(
      'study.create',
      { title: 'native abort', scope: { kind: 'personal' } },
      { ...options(fetchImpl), timeoutMs: 25 },
    ),
    'DEADLINE_EXCEEDED',
  );
});
