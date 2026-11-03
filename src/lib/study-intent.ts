import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { resolveFlowIdentityApprovalClaimRoot } from './dataset-maintenance-flow-identity-approval-claim.js';
import {
  assertStudySafe,
  prepareStudyRequest,
  STUDY_REQUEST_LIMIT,
  studyDigest,
  studyFailure,
  studyJson,
  studyObject,
  type StudyRequest,
  studyApiVersion,
} from './study-protocol.js';

export type StudyActorBinding = { endpoint: string; actorId: string; clientId: string | null };
export type StudyIntent = {
  schemaVersion: 'tiangong.cli.study-intent.v1';
  binding: StudyActorBinding;
  request: StudyRequest;
  requestSha256: string;
};

export function readStudyBytes(
  file: string,
  maximum = STUDY_REQUEST_LIMIT,
  privateFile = false,
): Buffer {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) studyFailure('STUDY_INPUT_INVALID');
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > maximum ||
      (privateFile && process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      studyFailure('STUDY_INPUT_INVALID');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) studyFailure('PAYLOAD_TOO_LARGE');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof CliError) throw error;
    return studyFailure('STUDY_INPUT_INVALID');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readStudyJson(
  file: string,
  maximum = STUDY_REQUEST_LIMIT,
  privateFile = false,
): unknown {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readStudyBytes(file, maximum, privateFile)),
    ) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return studyFailure('STUDY_INPUT_INVALID');
  }
}

function scopeHash(binding: StudyActorBinding, request: StudyRequest): string {
  return studyDigest(
    studyJson({
      binding,
      operation: request.operation,
      idempotencyKey: request.idempotencyKey,
      ...(request.schemaVersion === 'lca.study-api.v3' ? { apiSchema: request.schemaVersion } : {}),
    }),
  );
}

export function readStudyIntent(file: string): StudyIntent {
  let parent;
  try {
    parent = lstatSync(path.dirname(file));
  } catch {
    return studyFailure('STUDY_INTENT_INVALID');
  }
  if (!parent.isDirectory() || (process.platform !== 'win32' && (parent.mode & 0o077) !== 0))
    studyFailure('STUDY_INTENT_INVALID');
  const raw = readStudyJson(file, STUDY_REQUEST_LIMIT + 8192, true);
  assertStudySafe(raw);
  if (
    !studyObject(raw) ||
    raw.schemaVersion !== 'tiangong.cli.study-intent.v1' ||
    !studyObject(raw.binding) ||
    !studyObject(raw.request)
  )
    studyFailure('STUDY_INTENT_INVALID');
  const binding = raw.binding;
  if (
    typeof binding.endpoint !== 'string' ||
    typeof binding.actorId !== 'string' ||
    !(binding.clientId === null || typeof binding.clientId === 'string') ||
    Object.keys(binding).sort().join(',') !== 'actorId,clientId,endpoint'
  )
    studyFailure('STUDY_INTENT_INVALID');
  const request = prepareStudyRequest(
    String(raw.request.operation),
    raw.request,
    studyApiVersion(raw.request.schemaVersion),
  );
  if (
    raw.requestSha256 !== studyDigest(studyJson(request)) ||
    Object.keys(raw).sort().join(',') !== 'binding,request,requestSha256,schemaVersion'
  )
    studyFailure('STUDY_INTENT_INVALID');
  const intent: StudyIntent = {
    schemaVersion: 'tiangong.cli.study-intent.v1',
    binding: binding as StudyActorBinding,
    request,
    requestSha256: raw.requestSha256 as string,
  };
  if (
    path.basename(file) !== 'intent.json' ||
    path.basename(path.dirname(file)) !== scopeHash(intent.binding, request) ||
    path.basename(path.dirname(path.dirname(file))) !== studyApiVersion(request.schemaVersion)
  )
    studyFailure('STUDY_INTENT_INVALID');
  return intent;
}

/** Immutable, fsync-flushed intent publication occurs before the first domain dispatch. */
export function persistStudyIntent(
  request: StudyRequest,
  binding: StudyActorBinding,
  env: NodeJS.ProcessEnv,
  stateDir?: string,
): string {
  const root = stateDir ? path.resolve(stateDir) : resolveFlowIdentityApprovalClaimRoot({ env });
  const directory = path.join(
    root,
    'study',
    studyApiVersion(request.schemaVersion),
    scopeHash(binding, request),
  );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return studyFailure('STUDY_STATE_WRITE_FAILED');
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
    studyFailure('STUDY_STATE_INVALID');
  const file = path.join(directory, 'intent.json');
  const intent: StudyIntent = {
    schemaVersion: 'tiangong.cli.study-intent.v1',
    binding,
    request,
    requestSha256: studyDigest(studyJson(request)),
  };
  if (existsSync(file)) {
    const previous = readStudyIntent(file);
    if (studyJson(previous) !== studyJson(intent))
      studyFailure('IDEMPOTENCY_CONFLICT', { intentFile: file });
    studyFailure('STUDY_RECOVERY_REQUIRED', { intentFile: file });
  }
  const temporary = path.join(directory, `.intent-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${studyJson(intent)}\n`, { mode: 0o600, flag: 'wx', flush: true });
    linkSync(temporary, file);
  } catch {
    if (existsSync(file)) {
      if (studyJson(readStudyIntent(file)) !== studyJson(intent))
        studyFailure('IDEMPOTENCY_CONFLICT', { intentFile: file });
      studyFailure('STUDY_RECOVERY_REQUIRED', { intentFile: file });
    }
    studyFailure('STUDY_STATE_WRITE_FAILED');
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function assertStudyBinding(expected: StudyActorBinding, actual: StudyActorBinding): void {
  if (studyJson(expected) !== studyJson(actual)) studyFailure('STUDY_RECOVERY_BINDING_MISMATCH');
}
