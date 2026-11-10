import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';
import {
  __testInternals,
  renderLcaReleaseReport,
  runLcaRelease,
  type LcaReleaseAction,
  type LcaReleaseReport,
  type RunLcaReleaseOptions,
} from '../src/lib/lca-release.js';
import { __testInternals as sessionInternals } from '../src/lib/supabase-session.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PACKAGE_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_HASH = 'a'.repeat(64);
let envSequence = 0;

afterEach(() => {
  sessionInternals.SESSION_MEMORY_CACHE.clear();
  sessionInternals.SESSION_OPERATION_CHAINS.clear();
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tg-lca-release-'));
}

function releaseEnv(): NodeJS.ProcessEnv {
  envSequence += 1;
  return buildSupabaseTestEnv({
    TIANGONG_LCA_ACCESS_TOKEN: `release-password-${envSequence}`,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
  });
}

function jsonResponse(payload: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function binaryResponse(bytes: Uint8Array, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/octet-stream' },
    async text() {
      return Buffer.from(bytes).toString('utf8');
    },
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

function baseOptions(overrides: Partial<RunLcaReleaseOptions>): RunLcaReleaseOptions {
  return {
    action: 'current',
    inputPath: null,
    outputPath: null,
    releaseRunId: null,
    packageId: null,
    artifactId: null,
    artifactPath: null,
    env: releaseEnv(),
    timeoutMs: 1000,
    dryRun: false,
    force: false,
    fetchImpl: async () => {
      throw new Error('unexpected fetch');
    },
    ...overrides,
  };
}

function commandFetch(
  data: unknown,
  observer?: (body: Record<string, unknown>) => void,
): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    assert.match(url, /app_lca_release_commands$/u);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    observer?.(body);
    return jsonResponse({ ok: true, command: body.action, data });
  };
}

const UPLOAD_PAIRS = [
  ['unit-process-full-closure.v1', 'tidas'],
  ['unit-process-full-closure.v1', 'ilcd'],
  ['standalone-lifecyclemodel-result-full-closure.v1', 'tidas'],
  ['standalone-lifecyclemodel-result-full-closure.v1', 'ilcd'],
] as const;

function makeUploadFixture(directory: string) {
  const artifacts = UPLOAD_PAIRS.map(([profileId, format], index) => {
    const bytes = Buffer.from(`release-zip-${index}`, 'utf8');
    const filePath = path.join(directory, `${index}.zip`);
    writeFileSync(filePath, bytes);
    return {
      profileId,
      format,
      path: index === 0 ? `${index}.zip` : filePath,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
      mediaType: 'application/zip',
      filePath,
    };
  });
  const inputPath = path.join(directory, 'upload.json');
  writeFileSync(
    inputPath,
    JSON.stringify({
      releaseRunId: RUN_ID,
      publishPlanHash: PLAN_HASH,
      artifacts: [artifacts[3], artifacts[1], artifacts[0], artifacts[2]].map((artifact) => ({
        profileId: artifact.profileId,
        format: artifact.format,
        path: artifact.path,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        mediaType: artifact.mediaType,
      })),
    }),
  );
  return { artifacts, inputPath };
}

test('dry-run builds every direct release command and masks credentials', async () => {
  const directory = tempDir();
  try {
    const inputPath = path.join(directory, 'command.json');
    writeFileSync(
      inputPath,
      JSON.stringify({ releaseRunId: RUN_ID, credentialFingerprint: 'bad' }),
    );
    const actions: LcaReleaseAction[] = [
      'prepare',
      'finalize',
      'approve',
      'publish',
      'readback-verify',
      'unpublish',
      'status',
      'current',
      'calculation-bundle',
      'calculation-artifact',
      'artifact-download',
    ];
    for (const action of actions) {
      const report = await runLcaRelease(
        baseOptions({
          action,
          inputPath,
          releaseRunId: RUN_ID,
          packageId: PACKAGE_ID,
          artifactId: ARTIFACT_ID,
          dryRun: true,
        }),
      );
      assert.equal(report.status, 'planned');
      assert.equal(report.complete, false);
      assert.deepEqual((report.request?.headers as object) ?? {}, {
        Authorization: 'Bearer ****',
        apikey: '****',
      });
      assert.doesNotMatch(JSON.stringify(report), /release-password/u);
      if (action === 'publish') {
        const body = report.request?.body as Record<string, unknown>;
        assert.equal('credentialFingerprint' in body, false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upload dry-run validates and sorts four local packages without network writes', async () => {
  const directory = tempDir();
  try {
    const fixture = makeUploadFixture(directory);
    const outputPath = path.join(directory, 'upload-receipt.json');
    const report = await runLcaRelease(
      baseOptions({
        action: 'upload',
        inputPath: fixture.inputPath,
        outputPath,
        dryRun: true,
      }),
    );
    assert.equal(report.status, 'planned');
    assert.equal(report.summary.artifactCount, 4);
    const body = report.request?.body as {
      artifacts: Array<{ profileId: string; format: string }>;
    };
    assert.deepEqual(
      body.artifacts.map((artifact) => `${artifact.profileId}:${artifact.format}`),
      UPLOAD_PAIRS.map(([profileId, format]) => `${profileId}:${format}`),
    );
    assert.equal(exists(outputPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function exists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

test('upload obtains canonical signed URLs, uploads bytes, and writes a secret-free receipt', async () => {
  const directory = tempDir();
  try {
    const fixture = makeUploadFixture(directory);
    const outputPath = path.join(directory, 'receipt.json');
    const storagePuts: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (url.endsWith('/app_lca_release_commands')) {
        const body = JSON.parse(String(init?.body)) as {
          artifacts: Array<Record<string, unknown>>;
        };
        assert.equal(
          body.artifacts.some((artifact) => 'path' in artifact),
          false,
        );
        return jsonResponse({
          ok: true,
          data: body.artifacts.map((artifact) => ({
            ...artifact,
            storageBucket: 'lca_results',
            objectKey: `lca-releases/${artifact.profileId}/${artifact.format}.zip`,
            token: `token-${artifact.format}`,
            signedUploadUrl: 'https://unused.example/upload',
          })),
        });
      }
      if (url.includes('/storage/v1/object/upload/sign/')) {
        storagePuts.push(url);
        assert.equal(init?.method, 'PUT');
        return jsonResponse({ Key: 'lca_results/object.zip' });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const report = await runLcaRelease(
      baseOptions({
        action: 'upload',
        inputPath: fixture.inputPath,
        outputPath,
        fetchImpl,
      }),
    );
    assert.equal(report.complete, true);
    assert.equal(storagePuts.length, 4);
    assert.equal(report.output?.path, outputPath);
    if (process.platform !== 'win32') {
      assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    }
    const receiptText = readFileSync(outputPath, 'utf8');
    assert.doesNotMatch(receiptText, /token-/u);
    assert.doesNotMatch(receiptText, /signedUploadUrl/u);
    assert.equal((JSON.parse(receiptText) as { artifacts: unknown[] }).artifacts.length, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upload surfaces storage failures with the local artifact path', async () => {
  const directory = tempDir();
  try {
    const fixture = makeUploadFixture(directory);
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (url.endsWith('/app_lca_release_commands')) {
        const body = JSON.parse(String(init?.body)) as {
          artifacts: Array<Record<string, unknown>>;
        };
        return jsonResponse({
          ok: true,
          data: body.artifacts.map((artifact) => ({
            ...artifact,
            storageBucket: 'lca_results',
            objectKey: `${artifact.format}.zip`,
            token: 'token',
          })),
        });
      }
      return jsonResponse({ message: 'storage rejected upload', statusCode: '500' }, 500);
    };
    await assert.rejects(
      () =>
        runLcaRelease(
          baseOptions({
            action: 'upload',
            inputPath: fixture.inputPath,
            outputPath: path.join(directory, 'receipt.json'),
            fetchImpl,
          }),
        ),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'LCA_RELEASE_ARTIFACT_UPLOAD_FAILED');
        assert.match(error.message, /\.zip/u);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status and current preserve compact data or write a durable JSON projection', async () => {
  const directory = tempDir();
  try {
    const status = await runLcaRelease(
      baseOptions({
        action: 'status',
        releaseRunId: RUN_ID,
        fetchImpl: commandFetch({
          releaseRunId: RUN_ID,
          releaseVersion: '01.00.000',
          status: 'approved',
        }),
      }),
    );
    assert.equal((status.data as { status: string }).status, 'approved');
    assert.deepEqual(status.nextCommands, []);

    const outputPath = path.join(directory, 'current.json');
    const current = await runLcaRelease(
      baseOptions({
        action: 'current',
        outputPath,
        fetchImpl: commandFetch({ releaseRunId: RUN_ID, status: 'readback_verified' }),
      }),
    );
    assert.equal(current.data, undefined);
    assert.equal(current.output?.path, outputPath);
    assert.match(readFileSync(outputPath, 'utf8'), /readback_verified/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Calculation Bundle projection is written to a file with bounded summary context', async () => {
  const directory = tempDir();
  try {
    const outputPath = path.join(directory, 'bundle.json');
    const data = {
      packageId: PACKAGE_ID,
      calculationBundle: {
        calculationId: RUN_ID,
        bundleContentHash: PLAN_HASH,
        manifest: { scope: { processCount: 12 } },
        artifacts: [{ path: 'chunks/lci.jsonl.gz' }, { path: 'chunks/lcia.jsonl.gz' }],
      },
    };
    const report = await runLcaRelease(
      baseOptions({
        action: 'calculation-bundle',
        packageId: PACKAGE_ID,
        outputPath,
        fetchImpl: commandFetch(data),
      }),
    );
    assert.deepEqual(report.summary, {
      packageId: PACKAGE_ID,
      calculationId: RUN_ID,
      bundleContentHash: PLAN_HASH,
      processCount: 12,
      artifactCount: 2,
    });
    assert.equal(report.data, undefined);
    assert.match(readFileSync(outputPath, 'utf8'), /chunks\/lci/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release ZIP and Calculation Bundle chunk downloads verify bytes before writing', async () => {
  const directory = tempDir();
  try {
    const bytes = Buffer.from('verified-download', 'utf8');
    const releaseOutput = path.join(directory, 'release.zip');
    const releaseData = {
      artifactId: ARTIFACT_ID,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
      mediaType: 'application/zip',
      signedDownloadUrl: 'https://download.example/release.zip',
    };
    const releaseFetch: FetchLike = async (input) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (url.endsWith('/app_lca_release_commands')) {
        return jsonResponse({ ok: true, data: releaseData });
      }
      return binaryResponse(bytes);
    };
    const release = await runLcaRelease(
      baseOptions({
        action: 'artifact-download',
        artifactId: ARTIFACT_ID,
        outputPath: releaseOutput,
        fetchImpl: releaseFetch,
      }),
    );
    assert.deepEqual(readFileSync(releaseOutput), bytes);
    assert.equal(release.summary.artifactId, ARTIFACT_ID);

    const chunkOutput = path.join(directory, 'chunk.jsonl.gz');
    const chunkPath = 'chunks/lci-00000.jsonl.gz';
    const calculationFetch: FetchLike = async (input) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (url.endsWith('/app_lca_release_commands')) {
        return jsonResponse({
          ok: true,
          data: {
            calculationBundle: {
              artifacts: [
                {
                  path: chunkPath,
                  sha256: sha256(bytes),
                  byteSize: bytes.byteLength,
                  signedDownloadUrl: 'https://download.example/chunk',
                },
              ],
            },
          },
        });
      }
      return binaryResponse(bytes);
    };
    const calculation = await runLcaRelease(
      baseOptions({
        action: 'calculation-artifact',
        packageId: PACKAGE_ID,
        artifactPath: chunkPath,
        outputPath: chunkOutput,
        fetchImpl: calculationFetch,
      }),
    );
    assert.deepEqual(readFileSync(chunkOutput), bytes);
    assert.equal(calculation.summary.artifactPath, chunkPath);
    assert.equal(calculation.output?.mediaType, 'application/octet-stream');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('readJsonResponse returns valid envelopes and preserves remote application errors', async () => {
  const url = 'https://example.com/release';
  assert.deepEqual(
    await __testInternals.readJsonResponse(jsonResponse({ ok: true, data: { id: 1 } }), url),
    { ok: true, data: { id: 1 } },
  );
  await assert.rejects(
    () =>
      __testInternals.readJsonResponse(
        jsonResponse(
          { ok: false, code: 'not_data_product_manager', message: 'Manager required' },
          403,
        ),
        url,
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'not_data_product_manager');
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
  await assert.rejects(
    () =>
      __testInternals.readJsonResponse(
        {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => 'not-json',
        },
        url,
      ),
    /not valid JSON/u,
  );
  await assert.rejects(
    () => __testInternals.readJsonResponse(jsonResponse(['not-object']), url),
    /not a JSON object/u,
  );
  await assert.rejects(
    () => __testInternals.readJsonResponse(jsonResponse({ ok: true }), url),
    /missing ok:true and data/u,
  );
  await assert.rejects(
    () => __testInternals.readJsonResponse(jsonResponse({}, 500), url),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'LCA_RELEASE_REMOTE_FAILED');
      assert.match(error.message, /HTTP 500/u);
      return true;
    },
  );
});

test('downloadBytes rejects HTTP and text-only transports', async () => {
  await assert.rejects(
    () =>
      __testInternals.downloadBytes('https://download.example/fail', 10, async () =>
        binaryResponse(new Uint8Array(), 404),
      ),
    /HTTP 404/u,
  );
  await assert.rejects(
    () =>
      __testInternals.downloadBytes('https://download.example/text', 10, async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => 'text',
      })),
    /binary response support/u,
  );
});

test('output writers are atomic, permission-restricted, force-aware, and actionable on failure', () => {
  const directory = tempDir();
  try {
    const outputPath = path.join(directory, 'result.json');
    const first = __testInternals.writeJsonOutput(outputPath, { ok: true }, false);
    assert.equal(first.mediaType, 'application/json');
    assert.equal(first.sha256, sha256(readFileSync(outputPath)));
    assert.throws(
      () => __testInternals.writeJsonOutput(outputPath, { ok: false }, false),
      /Use --force/u,
    );
    const second = __testInternals.writeJsonOutput(outputPath, { ok: false }, true);
    assert.notEqual(second.sha256, first.sha256);

    const parentFile = path.join(directory, 'not-a-directory');
    writeFileSync(parentFile, 'x');
    assert.throws(
      () =>
        __testInternals.writeOutput(
          path.join(parentFile, 'child'),
          Buffer.from('x'),
          'x/test',
          false,
        ),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'LCA_RELEASE_OUTPUT_WRITE_FAILED');
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upload input validation rejects malformed metadata, local drift, and incomplete sets', () => {
  const directory = tempDir();
  try {
    const fixture = makeUploadFixture(directory);
    const valid = JSON.parse(readFileSync(fixture.inputPath, 'utf8')) as Record<string, unknown>;
    const parse = (value: Record<string, unknown>) =>
      __testInternals.parseLocalUploadArtifacts(value, fixture.inputPath);

    assert.throws(() => parse({}), /artifacts\[\]/u);
    assert.throws(() => parse({ artifacts: [null] }), /must be a JSON object/u);
    assert.throws(() => parse({ artifacts: [{ profileId: '', format: 'tidas' }] }), /profileId/u);

    const variants = (mutate: (artifact: Record<string, unknown>) => void) => {
      const copy = structuredClone(valid);
      const artifact = (copy.artifacts as Array<Record<string, unknown>>)[0];
      mutate(artifact);
      return copy;
    };
    assert.throws(() => parse(variants((artifact) => (artifact.sha256 = 'bad'))), /invalid SHA/u);
    assert.throws(
      () => parse(variants((artifact) => (artifact.byteSize = 0))),
      /invalid byteSize/u,
    );
    assert.throws(
      () => parse(variants((artifact) => (artifact.mediaType = 'text/plain'))),
      /application\/zip/u,
    );
    assert.throws(
      () => parse(variants((artifact) => (artifact.path = './missing.zip'))),
      /file not found/u,
    );
    assert.throws(
      () => parse(variants((artifact) => (artifact.path = directory))),
      /file not found/u,
    );
    assert.throws(
      () => parse(variants((artifact) => (artifact.byteSize = Number(artifact.byteSize) + 1))),
      /byte size mismatch/u,
    );
    assert.throws(
      () => parse(variants((artifact) => (artifact.sha256 = 'b'.repeat(64)))),
      /SHA-256 mismatch/u,
    );
    assert.throws(
      () => parse({ ...valid, artifacts: (valid.artifacts as unknown[]).slice(0, 3) }),
      /each TIDAS\/ILCD/u,
    );
    const duplicate = structuredClone(valid);
    (duplicate.artifacts as unknown[])[1] = (duplicate.artifacts as unknown[])[0];
    assert.throws(() => parse(duplicate), /each TIDAS\/ILCD/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upload URL projection validation rejects incomplete and drifted server responses', () => {
  const directory = tempDir();
  try {
    const fixture = makeUploadFixture(directory);
    const input = JSON.parse(readFileSync(fixture.inputPath, 'utf8')) as Record<string, unknown>;
    const local = __testInternals.parseLocalUploadArtifacts(input, fixture.inputPath);
    const valid = local.map((artifact) => ({
      profileId: artifact.profileId,
      format: artifact.format,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      mediaType: artifact.mediaType,
      storageBucket: 'bucket',
      objectKey: `${artifact.format}.zip`,
      token: 'token',
    }));
    assert.throws(() => __testInternals.parseUploadResponse({ data: null }, local), /all four/u);
    assert.throws(
      () => __testInternals.parseUploadResponse({ data: valid.slice(0, 3) }, local),
      /all four/u,
    );
    const missing = structuredClone(valid);
    missing[0].profileId = 'unknown';
    assert.throws(() => __testInternals.parseUploadResponse({ data: missing }, local), /missing/u);
    for (const field of ['sha256', 'byteSize', 'mediaType'] as const) {
      const drifted = structuredClone(valid);
      (drifted[0] as Record<string, unknown>)[field] = field === 'byteSize' ? 999 : 'drift';
      assert.throws(
        () => __testInternals.parseUploadResponse({ data: drifted }, local),
        /metadata drifted/u,
      );
    }
    const missingStorage = structuredClone(valid);
    missingStorage[0].storageBucket = '';
    assert.throws(
      () => __testInternals.parseUploadResponse({ data: missingStorage }, local),
      /storageBucket/u,
    );
    assert.equal(__testInternals.parseUploadResponse({ data: valid }, local).length, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('download selection reports bounded Calculation Bundle candidates', () => {
  assert.deepEqual(
    __testInternals.selectDownload('artifact-download', { artifactId: ARTIFACT_ID }, null),
    { artifactId: ARTIFACT_ID },
  );
  assert.deepEqual(__testInternals.selectDownload('artifact-download', null, null), {});
  assert.throws(
    () =>
      __testInternals.selectDownload(
        'calculation-artifact',
        {
          calculationBundle: {
            artifacts: [
              null,
              { path: 1 },
              ...Array.from({ length: 22 }, (_, index) => ({ path: `p${index}` })),
            ],
          },
        },
        'missing',
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      const details = error.details as { candidates: string[]; total: number };
      assert.equal(details.candidates.length, 20);
      assert.equal(details.total, 24);
      return true;
    },
  );
  assert.throws(
    () => __testInternals.selectDownload('calculation-artifact', {}, null),
    /--artifact-path/u,
  );
});

test('download verification rejects invalid metadata, size drift, and hash drift', async () => {
  const directory = tempDir();
  try {
    const bytes = Buffer.from('download');
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      if (url.endsWith('/app_lca_release_commands')) {
        return jsonResponse({
          ok: true,
          data: {
            signedDownloadUrl: 'https://download.example/file',
            sha256: sha256(bytes),
            byteSize: bytes.byteLength,
          },
        });
      }
      return binaryResponse(bytes);
    };
    const mutations = [
      { byteSize: 'bad', code: 'LCA_RELEASE_DOWNLOAD_SIZE_INVALID' },
      { byteSize: bytes.byteLength + 1, code: 'LCA_RELEASE_DOWNLOAD_SIZE_MISMATCH' },
      { sha256: 'f'.repeat(64), code: 'LCA_RELEASE_DOWNLOAD_HASH_MISMATCH' },
    ];
    for (const mutation of mutations) {
      const mutatedFetch: FetchLike = async (input) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
        if (url.endsWith('/app_lca_release_commands')) {
          return jsonResponse({
            ok: true,
            data: {
              signedDownloadUrl: 'https://download.example/file',
              sha256: sha256(bytes),
              byteSize: bytes.byteLength,
              ...mutation,
            },
          });
        }
        return binaryResponse(bytes);
      };
      await assert.rejects(
        () =>
          runLcaRelease(
            baseOptions({
              action: 'artifact-download',
              artifactId: ARTIFACT_ID,
              outputPath: path.join(directory, `${mutation.code}.bin`),
              fetchImpl: mutatedFetch,
            }),
          ),
        (error) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, mutation.code);
          return true;
        },
      );
    }
    assert.equal(typeof fetchImpl, 'function');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('helpers expose actionable required-value and action errors', () => {
  assert.throws(() => __testInternals.requiredString(null, 'field'), /field/u);
  assert.throws(() => __testInternals.requiredString(' ', 'field'), /field/u);
  assert.equal(__testInternals.requiredString(' value ', 'field'), 'value');
  assert.throws(() => __testInternals.requiredId(null, '--id'), /--id/u);
  assert.equal(__testInternals.requiredId('id', '--id'), 'id');
  assert.throws(() => __testInternals.requiredPath(null, '--output'), /--output/u);
  assert.equal(__testInternals.requiredPath('.', '--output'), path.resolve('.'));
  assert.throws(() => __testInternals.commandAction('upload'), /does not map/u);
  assert.match(
    __testInternals.edgeUrl('https://example.supabase.co'),
    /app_lca_release_commands$/u,
  );
});

test('release command input must be an object even when the JSON file is valid', async () => {
  const directory = tempDir();
  try {
    const inputPath = path.join(directory, 'array.json');
    writeFileSync(inputPath, '[]');
    await assert.rejects(
      () => runLcaRelease(baseOptions({ action: 'prepare', inputPath, dryRun: true })),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'LCA_RELEASE_INPUT_OBJECT_REQUIRED');
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('next-action, summary, and human rendering stay bounded and explicit', () => {
  for (const action of [
    'prepare',
    'upload',
    'finalize',
    'approve',
    'publish',
    'readback-verify',
    'unpublish',
    'status',
    'current',
    'calculation-bundle',
    'calculation-artifact',
    'artifact-download',
  ] as LcaReleaseAction[]) {
    assert.ok(Array.isArray(__testInternals.nextCommands(action, { releaseRunId: RUN_ID })));
  }
  assert.deepEqual(__testInternals.nextCommands('status', null), []);
  assert.deepEqual(__testInternals.nextCommands('unknown' as never, null), []);
  assert.deepEqual(__testInternals.summarize('status', null), {
    releaseRunId: null,
    releaseVersion: null,
    status: 'completed',
  });
  assert.deepEqual(__testInternals.summarize('calculation-bundle', null), {
    packageId: null,
    calculationId: null,
    bundleContentHash: null,
    processCount: null,
    artifactCount: 0,
  });
  const report: LcaReleaseReport = {
    schemaVersion: 'tiangong.cli.lca-release.v1',
    action: 'status',
    status: 'completed',
    complete: true,
    summary: { status: 'approved', blockers: 0 },
    output: { path: '/tmp/report.json', sha256: PLAN_HASH, byteSize: 1, mediaType: 'x' },
    warnings: [],
    nextCommands: ['tiangong-lca release publish --input ./publish.json'],
  };
  const human = renderLcaReleaseReport(report);
  assert.match(human, /Summary:/u);
  assert.match(human, /Next:/u);
  assert.match(human, /\/tmp\/report\.json/u);
  assert.match(
    renderLcaReleaseReport({ ...report, output: undefined, nextCommands: [] }),
    /Next:\n- none/u,
  );
});

test('writeOutput preserves its actionable error when temporary cleanup also fails', () => {
  assert.throws(
    () => __testInternals.writeOutput('\0', Buffer.from('x'), 'x', false),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'LCA_RELEASE_OUTPUT_WRITE_FAILED');
      return true;
    },
  );
});
