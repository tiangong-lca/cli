import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { CliError } from '../shared/errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import { readJsonInput } from './io.js';
import {
  buildSupabaseAuthHeaders,
  createSupabaseFetch,
  deriveSupabaseFunctionsBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import { resolveSupabaseUserSession } from './supabase-session.js';

export const LCA_RELEASE_ACTIONS = [
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
] as const;

export type LcaReleaseAction = (typeof LCA_RELEASE_ACTIONS)[number];

export type LcaReleaseOutput = {
  path: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export type LcaReleaseReport = {
  schemaVersion: 'tiangong.cli.lca-release.v1';
  action: LcaReleaseAction;
  status: 'planned' | 'completed';
  complete: boolean;
  summary: Record<string, unknown>;
  data?: unknown;
  output?: LcaReleaseOutput;
  request?: Record<string, unknown>;
  warnings: string[];
  nextCommands: string[];
};

export type RunLcaReleaseOptions = {
  action: LcaReleaseAction;
  inputPath: string | null;
  outputPath: string | null;
  releaseRunId: string | null;
  packageId: string | null;
  artifactId: string | null;
  artifactPath: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  dryRun: boolean;
  force: boolean;
  fetchImpl: FetchLike;
};

type JsonRecord = Record<string, unknown>;
type LocalUploadArtifact = {
  profileId: string;
  format: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  filePath: string;
};

const COMMAND_ENDPOINT = 'app_lca_release_commands';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_UPLOAD_PAIRS = [
  'unit-process-full-closure.v1:tidas',
  'unit-process-full-closure.v1:ilcd',
  'standalone-lifecyclemodel-result-full-closure.v1:tidas',
  'standalone-lifecyclemodel-result-full-closure.v1:ilcd',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError(`Missing required ${field}.`, {
      code: 'LCA_RELEASE_FIELD_REQUIRED',
      exitCode: 2,
      details: { field },
    });
  }
  return value.trim();
}

function requiredId(value: string | null, flag: string): string {
  if (!value) {
    throw new CliError(`Missing required ${flag} value.`, {
      code: 'LCA_RELEASE_ID_REQUIRED',
      exitCode: 2,
      details: { flag },
    });
  }
  return value;
}

function requiredPath(value: string | null, flag: string): string {
  if (!value) {
    throw new CliError(`Missing required ${flag} value.`, {
      code: 'LCA_RELEASE_PATH_REQUIRED',
      exitCode: 2,
      details: { flag },
    });
  }
  return path.resolve(value);
}

function readObjectInput(inputPath: string | null): { inputPath: string; value: JsonRecord } {
  const resolved = requiredPath(inputPath, '--input');
  const value = readJsonInput(resolved);
  if (!isRecord(value)) {
    throw new CliError(`LCA release input must be a JSON object: ${resolved}`, {
      code: 'LCA_RELEASE_INPUT_OBJECT_REQUIRED',
      exitCode: 2,
    });
  }
  return { inputPath: resolved, value };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function outputRef(outputPath: string, bytes: Uint8Array, mediaType: string): LcaReleaseOutput {
  return {
    path: outputPath,
    sha256: sha256Bytes(bytes),
    byteSize: bytes.byteLength,
    mediaType,
  };
}

function writeOutput(
  outputPath: string,
  bytes: Uint8Array,
  mediaType: string,
  force: boolean,
): LcaReleaseOutput {
  if (existsSync(outputPath) && !force) {
    throw new CliError(`Output already exists: ${outputPath}. Use --force to replace it.`, {
      code: 'LCA_RELEASE_OUTPUT_EXISTS',
      exitCode: 2,
    });
  }
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(tempPath, bytes, { mode: 0o600 });
    renameSync(tempPath, outputPath);
    chmodSync(outputPath, 0o600);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Preserve the actionable write failure when the temporary path itself is unreachable.
    }
    throw new CliError(`Failed to write LCA release output: ${outputPath}`, {
      code: 'LCA_RELEASE_OUTPUT_WRITE_FAILED',
      exitCode: 1,
      details: String(error),
    });
  }
  return outputRef(outputPath, bytes, mediaType);
}

function writeJsonOutput(outputPath: string, value: unknown, force: boolean): LcaReleaseOutput {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return writeOutput(outputPath, bytes, 'application/json', force);
}

function commandAction(action: LcaReleaseAction): string {
  const mapping: Partial<Record<LcaReleaseAction, string>> = {
    prepare: 'prepare',
    finalize: 'finalize_artifacts',
    approve: 'approve',
    publish: 'publish',
    'readback-verify': 'readback_verify',
    unpublish: 'unpublish',
    status: 'get_release',
    current: 'get_current',
    'calculation-bundle': 'get_calculation_bundle',
    'calculation-artifact': 'get_calculation_bundle',
    'artifact-download': 'create_artifact_download',
  };
  const result = mapping[action];
  if (!result) {
    throw new CliError(`Action ${action} does not map to a direct release command.`, {
      code: 'LCA_RELEASE_ACTION_NOT_DIRECT',
      exitCode: 2,
    });
  }
  return result;
}

function buildCommandPayload(options: RunLcaReleaseOptions): {
  body: JsonRecord;
  inputPath: string | null;
} {
  if (
    options.action === 'prepare' ||
    options.action === 'finalize' ||
    options.action === 'approve' ||
    options.action === 'publish' ||
    options.action === 'readback-verify' ||
    options.action === 'unpublish'
  ) {
    const input = readObjectInput(options.inputPath);
    const body: JsonRecord = { ...input.value, action: commandAction(options.action) };
    if (options.action === 'publish') {
      delete body.credentialFingerprint;
    }
    return { body, inputPath: input.inputPath };
  }
  if (options.action === 'status') {
    return {
      body: {
        action: commandAction(options.action),
        releaseRunId: requiredId(options.releaseRunId, '--release-run-id'),
      },
      inputPath: null,
    };
  }
  if (options.action === 'current') {
    return { body: { action: commandAction(options.action) }, inputPath: null };
  }
  if (options.action === 'calculation-bundle' || options.action === 'calculation-artifact') {
    return {
      body: {
        action: commandAction(options.action),
        packageId: requiredId(options.packageId, '--package-id'),
      },
      inputPath: null,
    };
  }
  return {
    body: {
      action: commandAction(options.action),
      artifactId: requiredId(options.artifactId, '--artifact-id'),
    },
    inputPath: null,
  };
}

function edgeUrl(apiBaseUrl: string): string {
  return `${deriveSupabaseFunctionsBaseUrl(apiBaseUrl)}/${COMMAND_ENDPOINT}`;
}

async function readJsonResponse(response: ResponseLike, url: string): Promise<JsonRecord> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Remote response was not valid JSON for ${url}`, {
      code: 'LCA_RELEASE_REMOTE_INVALID_JSON',
      exitCode: 1,
      details: String(error),
    });
  }
  if (!isRecord(payload)) {
    throw new CliError(`Remote response was not a JSON object for ${url}`, {
      code: 'LCA_RELEASE_REMOTE_OBJECT_REQUIRED',
      exitCode: 1,
    });
  }
  if (!response.ok || payload.ok === false) {
    const code = typeof payload.code === 'string' ? payload.code : 'LCA_RELEASE_REMOTE_FAILED';
    const message =
      typeof payload.message === 'string'
        ? payload.message
        : `HTTP ${response.status} returned from ${url}`;
    throw new CliError(message, {
      code,
      exitCode: response.status === 401 || response.status === 403 ? 3 : 1,
      details: payload.details ?? payload,
    });
  }
  if (payload.ok !== true || !('data' in payload)) {
    throw new CliError(`Remote release response was missing ok:true and data for ${url}`, {
      code: 'LCA_RELEASE_REMOTE_ENVELOPE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }
  return payload;
}

async function invokeCommand(options: {
  url: string;
  publishableKey: string;
  accessToken: string;
  body: JsonRecord;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<JsonRecord> {
  const response = await options.fetchImpl(options.url, {
    method: 'POST',
    headers: {
      ...buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return readJsonResponse(response, options.url);
}

function parseLocalUploadArtifacts(value: JsonRecord, inputPath: string): LocalUploadArtifact[] {
  if (!Array.isArray(value.artifacts)) {
    throw new CliError('Release upload input must contain artifacts[].', {
      code: 'LCA_RELEASE_UPLOAD_ARTIFACTS_REQUIRED',
      exitCode: 2,
    });
  }
  const baseDir = path.dirname(inputPath);
  const artifacts = value.artifacts.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new CliError(`Release upload artifact ${index} must be a JSON object.`, {
        code: 'LCA_RELEASE_UPLOAD_ARTIFACT_INVALID',
        exitCode: 2,
      });
    }
    const profileId = requiredString(candidate.profileId, `artifacts[${index}].profileId`);
    const format = requiredString(candidate.format, `artifacts[${index}].format`);
    const sha256 = requiredString(candidate.sha256, `artifacts[${index}].sha256`);
    const mediaType = requiredString(candidate.mediaType, `artifacts[${index}].mediaType`);
    const localPath = requiredString(candidate.path, `artifacts[${index}].path`);
    if (!SHA256_PATTERN.test(sha256)) {
      throw new CliError(`Release upload artifact ${index} has an invalid SHA-256.`, {
        code: 'LCA_RELEASE_UPLOAD_HASH_INVALID',
        exitCode: 2,
      });
    }
    if (!Number.isSafeInteger(candidate.byteSize) || Number(candidate.byteSize) <= 0) {
      throw new CliError(`Release upload artifact ${index} has an invalid byteSize.`, {
        code: 'LCA_RELEASE_UPLOAD_SIZE_INVALID',
        exitCode: 2,
      });
    }
    if (mediaType !== 'application/zip') {
      throw new CliError(`Release upload artifact ${index} must use application/zip.`, {
        code: 'LCA_RELEASE_UPLOAD_MEDIA_TYPE_INVALID',
        exitCode: 2,
      });
    }
    const filePath = path.isAbsolute(localPath) ? localPath : path.resolve(baseDir, localPath);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new CliError(`Release upload artifact file not found: ${filePath}`, {
        code: 'LCA_RELEASE_UPLOAD_FILE_NOT_FOUND',
        exitCode: 2,
      });
    }
    const bytes = readFileSync(filePath);
    if (bytes.byteLength !== Number(candidate.byteSize)) {
      throw new CliError(`Release upload artifact byte size mismatch: ${filePath}`, {
        code: 'LCA_RELEASE_UPLOAD_SIZE_MISMATCH',
        exitCode: 2,
      });
    }
    if (sha256Bytes(bytes) !== sha256) {
      throw new CliError(`Release upload artifact SHA-256 mismatch: ${filePath}`, {
        code: 'LCA_RELEASE_UPLOAD_HASH_MISMATCH',
        exitCode: 2,
      });
    }
    return {
      profileId,
      format,
      sha256,
      byteSize: bytes.byteLength,
      mediaType,
      filePath,
    };
  });
  const pairs = artifacts.map((artifact) => `${artifact.profileId}:${artifact.format}`);
  if (
    artifacts.length !== REQUIRED_UPLOAD_PAIRS.length ||
    new Set(pairs).size !== REQUIRED_UPLOAD_PAIRS.length ||
    REQUIRED_UPLOAD_PAIRS.some((pair) => !pairs.includes(pair))
  ) {
    throw new CliError('Release upload requires each TIDAS/ILCD profile pair exactly once.', {
      code: 'LCA_RELEASE_UPLOAD_SET_INVALID',
      exitCode: 2,
      details: { expected: REQUIRED_UPLOAD_PAIRS, actual: pairs },
    });
  }
  return artifacts.sort(
    (left, right) =>
      REQUIRED_UPLOAD_PAIRS.indexOf(`${left.profileId}:${left.format}` as never) -
      REQUIRED_UPLOAD_PAIRS.indexOf(`${right.profileId}:${right.format}` as never),
  );
}

function parseUploadResponse(payload: JsonRecord, local: LocalUploadArtifact[]) {
  const responseArtifacts = payload.data;
  if (!Array.isArray(responseArtifacts) || responseArtifacts.length !== local.length) {
    throw new CliError('Release upload URL response did not contain all four artifacts.', {
      code: 'LCA_RELEASE_UPLOAD_URLS_INVALID',
      exitCode: 1,
      details: payload,
    });
  }
  return local.map((artifact) => {
    const match = responseArtifacts.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.profileId === artifact.profileId &&
        candidate.format === artifact.format,
    );
    if (!isRecord(match)) {
      throw new CliError(
        `Release upload URL is missing ${artifact.profileId}:${artifact.format}.`,
        {
          code: 'LCA_RELEASE_UPLOAD_URL_MISSING',
          exitCode: 1,
        },
      );
    }
    if (
      match.sha256 !== artifact.sha256 ||
      match.byteSize !== artifact.byteSize ||
      match.mediaType !== artifact.mediaType
    ) {
      throw new CliError(`Release upload URL metadata drifted for ${artifact.filePath}.`, {
        code: 'LCA_RELEASE_UPLOAD_URL_METADATA_MISMATCH',
        exitCode: 1,
      });
    }
    return {
      local: artifact,
      storageBucket: requiredString(match.storageBucket, 'storageBucket'),
      objectKey: requiredString(match.objectKey, 'objectKey'),
      token: requiredString(match.token, 'token'),
    };
  });
}

async function runUpload(
  options: RunLcaReleaseOptions,
  runtime: ReturnType<typeof requireSupabaseRestRuntime>,
  url: string,
): Promise<LcaReleaseReport> {
  const input = readObjectInput(options.inputPath);
  const outputPath = requiredPath(options.outputPath, '--output');
  const releaseRunId = requiredString(input.value.releaseRunId, 'releaseRunId');
  const publishPlanHash = requiredString(input.value.publishPlanHash, 'publishPlanHash');
  const artifacts = parseLocalUploadArtifacts(input.value, input.inputPath);
  const requestBody = {
    action: 'create_artifact_uploads',
    releaseRunId,
    publishPlanHash,
    artifacts: artifacts.map((artifact) => ({
      profileId: artifact.profileId,
      format: artifact.format,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      mediaType: artifact.mediaType,
    })),
  };
  if (options.dryRun) {
    return {
      schemaVersion: 'tiangong.cli.lca-release.v1',
      action: 'upload',
      status: 'planned',
      complete: false,
      summary: { releaseRunId, artifactCount: artifacts.length, outputPath },
      request: {
        method: 'POST',
        url,
        headers: { Authorization: 'Bearer ****', apikey: '****' },
        body: requestBody,
        plannedUploads: artifacts.map((artifact) => artifact.filePath),
      },
      warnings: [],
      nextCommands: [
        `tiangong-lca release upload --input ${input.inputPath} --output ${outputPath}`,
      ],
    };
  }

  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const signed = await invokeCommand({
    url,
    publishableKey: runtime.publishableKey,
    accessToken: session.accessToken,
    body: requestBody,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const uploads = parseUploadResponse(signed, artifacts);
  const storage = createClient(session.projectBaseUrl, runtime.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: createSupabaseFetch(options.fetchImpl, options.timeoutMs) },
  });
  for (const upload of uploads) {
    const result = await storage.storage
      .from(upload.storageBucket)
      .uploadToSignedUrl(upload.objectKey, upload.token, readFileSync(upload.local.filePath), {
        contentType: upload.local.mediaType,
        cacheControl: '31536000',
      });
    if (result.error) {
      throw new CliError(`Failed to upload release artifact: ${upload.local.filePath}`, {
        code: 'LCA_RELEASE_ARTIFACT_UPLOAD_FAILED',
        exitCode: 1,
        details: result.error.message,
      });
    }
  }
  const receipt = {
    schemaVersion: 'tiangong.release-upload-receipt.v1',
    releaseRunId,
    publishPlanHash,
    artifacts: uploads.map((upload) => ({
      profileId: upload.local.profileId,
      format: upload.local.format,
      storageBucket: upload.storageBucket,
      objectKey: upload.objectKey,
      sha256: upload.local.sha256,
      byteSize: upload.local.byteSize,
      mediaType: upload.local.mediaType,
    })),
  };
  const output = writeJsonOutput(outputPath, receipt, options.force);
  return {
    schemaVersion: 'tiangong.cli.lca-release.v1',
    action: 'upload',
    status: 'completed',
    complete: true,
    summary: { releaseRunId, artifactCount: uploads.length },
    data: receipt,
    output,
    warnings: [],
    nextCommands: ['tiangong-lca release finalize --input ./release-finalize.json --json'],
  };
}

async function downloadBytes(
  signedUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<Uint8Array> {
  const response = await fetchImpl(signedUrl, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned while downloading ${signedUrl}`, {
      code: 'LCA_RELEASE_DOWNLOAD_FAILED',
      exitCode: 1,
    });
  }
  if (!response.arrayBuffer) {
    throw new CliError('Download transport did not provide binary response support.', {
      code: 'LCA_RELEASE_DOWNLOAD_BINARY_UNAVAILABLE',
      exitCode: 1,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

function selectDownload(
  action: 'artifact-download' | 'calculation-artifact',
  data: unknown,
  artifactPath: string | null,
): JsonRecord {
  const root = isRecord(data) ? data : {};
  if (action === 'artifact-download') return root;
  const bundle = isRecord(root.calculationBundle) ? root.calculationBundle : {};
  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
  const requested = requiredId(artifactPath, '--artifact-path');
  const selected = artifacts.find((artifact) => isRecord(artifact) && artifact.path === requested);
  if (!isRecord(selected)) {
    const candidates = artifacts
      .filter(isRecord)
      .map((artifact) => artifact.path)
      .filter((value): value is string => typeof value === 'string')
      .slice(0, 20);
    throw new CliError(`Calculation Bundle artifact not found: ${requested}`, {
      code: 'LCA_RELEASE_CALCULATION_ARTIFACT_NOT_FOUND',
      exitCode: 2,
      details: { candidates, total: artifacts.length },
    });
  }
  return selected;
}

async function writeDownload(
  options: RunLcaReleaseOptions,
  data: unknown,
): Promise<{ output: LcaReleaseOutput; selected: JsonRecord }> {
  const outputPath = requiredPath(options.outputPath, '--output');
  const selected = selectDownload(
    options.action as 'artifact-download' | 'calculation-artifact',
    data,
    options.artifactPath,
  );
  const signedUrl = requiredString(selected.signedDownloadUrl, 'signedDownloadUrl');
  const expectedSha256 = requiredString(selected.sha256, 'sha256');
  const expectedByteSize = selected.byteSize;
  if (!Number.isSafeInteger(expectedByteSize) || Number(expectedByteSize) < 0) {
    throw new CliError('Download metadata contains an invalid byteSize.', {
      code: 'LCA_RELEASE_DOWNLOAD_SIZE_INVALID',
      exitCode: 1,
    });
  }
  const bytes = await downloadBytes(signedUrl, options.timeoutMs, options.fetchImpl);
  if (bytes.byteLength !== Number(expectedByteSize)) {
    throw new CliError('Downloaded artifact byte size differs from the durable reference.', {
      code: 'LCA_RELEASE_DOWNLOAD_SIZE_MISMATCH',
      exitCode: 1,
      details: { expected: expectedByteSize, actual: bytes.byteLength },
    });
  }
  const observedSha256 = sha256Bytes(bytes);
  if (observedSha256 !== expectedSha256) {
    throw new CliError('Downloaded artifact SHA-256 differs from the durable reference.', {
      code: 'LCA_RELEASE_DOWNLOAD_HASH_MISMATCH',
      exitCode: 1,
      details: { expected: expectedSha256, actual: observedSha256 },
    });
  }
  const mediaType =
    typeof selected.mediaType === 'string' ? selected.mediaType : 'application/octet-stream';
  return {
    output: writeOutput(outputPath, bytes, mediaType, options.force),
    selected,
  };
}

function nextCommands(action: LcaReleaseAction, data: unknown): string[] {
  const record = isRecord(data) ? data : {};
  const releaseRunId = typeof record.releaseRunId === 'string' ? record.releaseRunId : '<run-id>';
  const mapping: Partial<Record<LcaReleaseAction, string[]>> = {
    prepare: [
      'tiangong-lca release upload --input ./release-upload.json --output ./upload-receipt.json',
    ],
    upload: ['tiangong-lca release finalize --input ./release-finalize.json --json'],
    finalize: ['tiangong-lca release approve --input ./release-approval.json --json'],
    approve: ['tiangong-lca release publish --input ./release-publish.json --json'],
    publish: ['tiangong-lca release readback-verify --input ./release-readback.json --json'],
    'readback-verify': [`tiangong-lca release status --release-run-id ${releaseRunId} --json`],
    unpublish: ['tiangong-lca release current --json'],
    status: [],
    current: [],
    'calculation-bundle': [
      'tiangong-lca release calculation-artifact --package-id <package-id> --artifact-path <path> --output ./result.jsonl.gz',
    ],
    'calculation-artifact': [],
    'artifact-download': [],
  };
  return mapping[action] ?? [];
}

function summarize(action: LcaReleaseAction, data: unknown): Record<string, unknown> {
  const record = isRecord(data) ? data : {};
  if (action === 'calculation-bundle') {
    const bundle = isRecord(record.calculationBundle) ? record.calculationBundle : {};
    const manifest = isRecord(bundle.manifest) ? bundle.manifest : {};
    const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : [];
    const scope = isRecord(manifest.scope) ? manifest.scope : {};
    return {
      packageId: record.packageId ?? null,
      calculationId: bundle.calculationId ?? null,
      bundleContentHash: bundle.bundleContentHash ?? null,
      processCount: scope.processCount ?? null,
      artifactCount: artifacts.length,
    };
  }
  return {
    releaseRunId: record.releaseRunId ?? null,
    releaseVersion: record.releaseVersion ?? null,
    status: record.status ?? 'completed',
  };
}

export async function runLcaRelease(options: RunLcaReleaseOptions): Promise<LcaReleaseReport> {
  const runtime = requireSupabaseRestRuntime(options.env);
  const url = edgeUrl(runtime.apiBaseUrl);
  if (options.action === 'upload') return runUpload(options, runtime, url);

  const command = buildCommandPayload(options);
  if (options.dryRun) {
    return {
      schemaVersion: 'tiangong.cli.lca-release.v1',
      action: options.action,
      status: 'planned',
      complete: false,
      summary: { inputPath: command.inputPath },
      request: {
        method: 'POST',
        url,
        headers: { Authorization: 'Bearer ****', apikey: '****' },
        body: command.body,
      },
      warnings: [],
      nextCommands: [],
    };
  }

  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const envelope = await invokeCommand({
    url,
    publishableKey: runtime.publishableKey,
    accessToken: session.accessToken,
    body: command.body,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const data = envelope.data;

  if (options.action === 'artifact-download' || options.action === 'calculation-artifact') {
    const downloaded = await writeDownload(options, data);
    return {
      schemaVersion: 'tiangong.cli.lca-release.v1',
      action: options.action,
      status: 'completed',
      complete: true,
      summary: {
        artifactId: downloaded.selected.artifactId ?? null,
        artifactPath: downloaded.selected.path ?? null,
      },
      output: downloaded.output,
      warnings: [],
      nextCommands: [],
    };
  }

  let output: LcaReleaseOutput | undefined;
  if (options.action === 'calculation-bundle') {
    output = writeJsonOutput(requiredPath(options.outputPath, '--output'), data, options.force);
  } else if (options.outputPath) {
    output = writeJsonOutput(path.resolve(options.outputPath), data, options.force);
  }
  return {
    schemaVersion: 'tiangong.cli.lca-release.v1',
    action: options.action,
    status: 'completed',
    complete: true,
    summary: summarize(options.action, data),
    ...(output ? { output } : { data }),
    warnings: [],
    nextCommands: nextCommands(options.action, data),
  };
}

export function renderLcaReleaseReport(report: LcaReleaseReport): string {
  const lines = [
    `LCA release ${report.action}: ${report.status}`,
    '',
    'Summary:',
    ...Object.entries(report.summary).map(
      ([key, value]) => `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    ),
    `- complete: ${report.complete}`,
  ];
  if (report.output) lines.push(`- output: ${report.output.path} (${report.output.sha256})`);
  lines.push('', 'Next:');
  if (report.nextCommands.length === 0) lines.push('- none');
  for (const command of report.nextCommands) lines.push(`- ${command}`);
  return `${lines.join('\n')}\n`;
}

export const __testInternals = {
  buildCommandPayload,
  commandAction,
  downloadBytes,
  edgeUrl,
  invokeCommand,
  isRecord,
  nextCommands,
  outputRef,
  parseLocalUploadArtifacts,
  parseUploadResponse,
  readJsonResponse,
  requiredId,
  requiredPath,
  requiredString,
  runUpload,
  selectDownload,
  sha256Bytes,
  summarize,
  writeJsonOutput,
  writeOutput,
};
