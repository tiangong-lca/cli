import { createHash, randomUUID } from 'node:crypto';
import { CliError } from '../../shared/errors.js';
import type { StudyCodec } from './codec.js';

export const STUDY_API_SCHEMA = 'lca.study-api.v2' as const;
export const STUDY_REPORT_SCHEMA = 'lca.study-api.v3' as const;
export const STUDY_REVIEW_SCHEMA = 'lca.study-api.v4' as const;
export const STUDY_ADVANCED_SCHEMA = 'lca.study-api.v5' as const;
export const STUDY_METHOD_SCHEMA = 'lca.study-api.v6' as const;
export type StudyApiVersion = 'v2' | 'v3' | 'v4' | 'v5' | 'v6';
export const STUDY_REQUEST_LIMIT = 256 * 1024;
export const STUDY_RESPONSE_LIMIT = 6 * 1024 * 1024;
export const STUDY_ARTIFACT_LIMIT = 4 * 1024 * 1024;
export type StudyObject = Record<string, unknown>;
export type StudyRequest = StudyObject & {
  schemaVersion:
    | typeof STUDY_API_SCHEMA
    | typeof STUDY_REPORT_SCHEMA
    | typeof STUDY_REVIEW_SCHEMA
    | typeof STUDY_ADVANCED_SCHEMA
    | typeof STUDY_METHOD_SCHEMA;
  requestId: string;
  operation: string;
};

export const STUDY_CORE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  capabilities: 'capability.read',
  create: 'study.create',
  get: 'study.read',
  list: 'study.list',
  resources: 'study.resources.list',
  archive: 'study.archive',
  'select-revision': 'study.select_revision',
  'member set': 'member.set',
  'model source resolve': 'model.source.resolve',
  'model source get': 'model.source.read',
  'model prepare': 'model.prepare',
  'model get': 'model.read',
  'revision create': 'revision.create',
  'revision save': 'revision.save',
  'revision get': 'revision.read',
  'revision freeze': 'revision.freeze',
  'scenario create': 'scenario.create',
  'scenario save': 'scenario.save',
  'scenario get': 'scenario.read',
  'scenario freeze': 'scenario.freeze',
  'run submit': 'run.submit',
  'run get': 'run.read',
  'run cancel': 'run.cancel',
  'task get': 'task.read',
  'task wait': 'task.read',
  'task cancel': 'task.cancel',
  'artifact download': 'artifact.read',
});
export const STUDY_REPORT_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  'analysis request': 'analysis.request',
  'analysis get': 'analysis.read',
  'analysis task get': 'task.read',
  'analysis task wait': 'task.read',
  'analysis task cancel': 'task.cancel',
  'report create': 'report.create',
  'report save': 'report.save',
  'report get': 'report.read',
  'report freeze': 'report.freeze',
  'export request': 'export.request',
  'export get': 'export.read',
  'report resources': 'study.resources.list',
});
export const STUDY_REVIEW_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  actions: 'resource.actions',
  'member set': 'member.set',
  'comment append': 'comment.append',
  'comment list': 'comment.list',
  'review record': 'review.record',
  'review list': 'review.list',
  'review delegation issue': 'review.delegation.issue',
  'review delegation revoke': 'review.delegation.revoke',
  'review delegation list': 'review.delegation.list',
  'report current': 'report.current',
  'report view': 'report.view',
  'report finalize': 'report.finalize',
  'export request': 'export.request',
  'export get': 'export.read',
  'share create': 'share.create',
  'share get': 'share.read',
  'share view': 'share.view',
  'share revoke': 'share.revoke',
  'share list': 'share.list',
});
export const STUDY_ADVANCED_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  ...STUDY_REPORT_COMMANDS,
  ...Object.fromEntries(
    Object.entries(STUDY_REVIEW_COMMANDS).filter(([name]) => name !== 'member set'),
  ),
  'analysis parameters': 'analysis.parameters.read',
  'export download': 'export.download',
  'share download': 'share.download',
  capabilities: 'capability.read',
  resources: 'study.resources.list',
  'task get': 'task.read',
  'task wait': 'task.read',
  'task cancel': 'task.cancel',
  'artifact download': 'artifact.read',
});
export const STUDY_METHOD_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(STUDY_REPORT_COMMANDS).filter(([name]) => !name.startsWith('analysis ')),
  ),
  ...Object.fromEntries(
    Object.entries(STUDY_REVIEW_COMMANDS).filter(([name]) => name !== 'member set'),
  ),
  'method evidence register': 'method.evidence.create',
  'method evidence get': 'method.evidence.read',
  'method assessment request': 'method.assessment.request',
  'method assessment get': 'method.assessment.read',
  'method assessment task get': 'task.read',
  'method assessment task wait': 'task.read',
  'method assessment task cancel': 'task.cancel',
  'export download': 'export.download',
  'share download': 'share.download',
  capabilities: 'capability.read',
  resources: 'study.resources.list',
  'task get': 'task.read',
  'task wait': 'task.read',
  'task cancel': 'task.cancel',
  'artifact download': 'artifact.read',
});
export const STUDY_COMMANDS = Object.freeze({ ...STUDY_CORE_COMMANDS, ...STUDY_REPORT_COMMANDS });
export function studyApiVersion(schema: unknown): StudyApiVersion {
  if (schema === STUDY_API_SCHEMA) return 'v2';
  if (schema === STUDY_REPORT_SCHEMA) return 'v3';
  if (schema === STUDY_REVIEW_SCHEMA) return 'v4';
  if (schema === STUDY_ADVANCED_SCHEMA) return 'v5';
  if (schema === STUDY_METHOD_SCHEMA) return 'v6';
  return studyFailure('UNSUPPORTED_SCHEMA');
}

const PRIVATE_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'password',
  'servicekey',
  'servicerolekey',
  'apikey',
  'privatekey',
  'leasetoken',
  'sourceauthorization',
  'storagebucket',
  'storageobjectpath',
  'objectkey',
  'signedurl',
  'downloadurl',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function studyFailure(code: string, details?: unknown): never {
  throw new CliError(
    'Study command could not complete. Inspect its stable code and recovery identity.',
    {
      code,
      exitCode: code === 'INVALID_ARGS' ? 2 : 1,
      ...(details === undefined ? {} : { details }),
    },
  );
}

export function studyObject(value: unknown): value is StudyObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Transport identity only. This is NOT a producer/model/content fingerprint. */
export function studyJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (studyObject(input))
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalize(input[key])]),
      );
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function studyDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Reject credentials/locators rather than silently altering the exact intent. */
export function assertStudySafe(value: unknown, secrets: readonly string[] = [], depth = 0): void {
  if (depth > 32) studyFailure('STUDY_PAYLOAD_TOO_DEEP');
  if (
    typeof value === 'string' &&
    secrets.some((secret) => secret.length > 0 && value.includes(secret))
  )
    studyFailure('STUDY_PRIVATE_PAYLOAD');
  if (Array.isArray(value)) value.forEach((entry) => assertStudySafe(entry, secrets, depth + 1));
  else if (studyObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase()))
        studyFailure('STUDY_PRIVATE_PAYLOAD');
      assertStudySafe(entry, secrets, depth + 1);
    }
  }
}

export function studyQuery(operation: string): boolean {
  return (
    operation.endsWith('.read') ||
    operation.endsWith('.list') ||
    [
      'resource.actions',
      'report.current',
      'report.view',
      'share.view',
      'export.download',
      'share.download',
    ].includes(operation)
  );
}

/** Construct only the transport envelope; the owner codec validates domain fields. */
export function prepareStudyRequest(
  operation: string,
  value: unknown,
  version: StudyApiVersion = 'v2',
): StudyRequest {
  const schema = `lca.study-api.${version}` as StudyRequest['schemaVersion'];
  const operations =
    version === 'v2'
      ? Object.values(STUDY_CORE_COMMANDS)
      : version === 'v3'
        ? [...Object.values(STUDY_REPORT_COMMANDS), 'capability.read', 'artifact.read']
        : version === 'v6'
          ? Object.values(STUDY_METHOD_COMMANDS)
          : version === 'v5'
            ? Object.values(STUDY_ADVANCED_COMMANDS)
            : [
                ...Object.values(STUDY_REVIEW_COMMANDS),
                'capability.read',
                'export.download',
                'share.download',
              ];
  if (!operations.includes(operation) || !studyObject(value)) studyFailure('STUDY_REQUEST_INVALID');
  assertStudySafe(value);
  if (value.schemaVersion !== undefined && value.schemaVersion !== schema)
    studyFailure('UNSUPPORTED_SCHEMA');
  if (value.operation !== undefined && value.operation !== operation)
    studyFailure('STUDY_OPERATION_MISMATCH');
  if (value.requestId !== undefined && typeof value.requestId !== 'string')
    studyFailure('STUDY_REQUEST_INVALID');
  const request: StudyRequest = {
    ...value,
    schemaVersion: schema,
    operation,
    requestId: typeof value.requestId === 'string' ? value.requestId : randomUUID(),
  };
  if (!ID.test(request.requestId)) studyFailure('STUDY_REQUEST_INVALID');
  if (!studyQuery(operation)) {
    request.idempotencyKey =
      value.idempotencyKey === undefined ? randomUUID() : value.idempotencyKey;
    if (typeof request.idempotencyKey !== 'string' || !ID.test(request.idempotencyKey))
      studyFailure('STUDY_REQUEST_INVALID');
  } else if (value.idempotencyKey !== undefined) studyFailure('STUDY_REQUEST_INVALID');
  if (Buffer.byteLength(studyJson(request)) > STUDY_REQUEST_LIMIT)
    studyFailure('PAYLOAD_TOO_LARGE');
  return request;
}

export function parseStudyResponse(
  value: unknown,
  request: StudyRequest,
  status: number,
  codec: StudyCodec,
): StudyObject {
  assertStudySafe(value);
  let parsed;
  try {
    parsed = codec.parseResponse(value);
  } catch {
    return studyFailure('STUDY_RESPONSE_INVALID');
  }
  if (parsed.requestId !== request.requestId) studyFailure('STUDY_RESPONSE_SELECTION');
  if (!parsed.ok) studyFailure(parsed.code, { httpStatus: status, requestId: request.requestId });
  if (status < 200 || status >= 300) studyFailure('STUDY_RESPONSE_INVALID');
  try {
    codec.validateResponseForRequest(codec.parseRequest(request), parsed);
  } catch {
    return studyFailure('STUDY_RESPONSE_SELECTION');
  }
  return parsed.data as unknown as StudyObject;
}
