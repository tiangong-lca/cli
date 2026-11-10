import { sha256Json, stableJsonValue } from '../platform/canonical-json-hash.js';
import path from 'node:path';
import { CliError } from '../../shared/errors.js';
import type { FetchLike } from '../transport/http.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  requireSupabaseRestRuntime,
  type SupabaseRestRuntime,
} from '../transport/supabase-client.js';
import {
  resolveSupabaseUserSession,
  type ResolvedSupabaseUserSession,
} from './supabase-session.js';
import { redactEmail } from './credential-safety.js';

export const AUTH_IDENTITY_RECEIPT_SCHEMA = 'tiangong-lca.auth-identity-receipt.v1' as const;
export const AUTH_IDENTITY_MAX_TIMEOUT_MS = 2_147_483_647;

const CLI_PACKAGE_NAME = '@tiangong-lca/cli' as const;
const CURRENT_USER_PATH = '/auth/v1/user' as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SESSION_REFRESH_WINDOW_SECONDS = 300;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const SESSION_SOURCES = ['memory', 'cache', 'refresh', 'oauth_login', 'access_token'] as const;
const CACHE_MODES = ['disabled', 'custom-file', 'platform-default'] as const;

type SessionSource = (typeof SESSION_SOURCES)[number];
type CacheMode = (typeof CACHE_MODES)[number];
type JsonObject = Record<string, unknown>;

class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('Response body exceeded the identity receipt byte limit.');
    this.name = 'ResponseBodyTooLargeError';
  }
}

export type AuthIdentityReceiptScope = {
  schema: typeof AUTH_IDENTITY_RECEIPT_SCHEMA;
  status: 'passed';
  operation: 'current-user-read';
  remote_write_mode: 'read-only';
  captured_at_utc: string;
  cli: {
    package_name: typeof CLI_PACKAGE_NAME;
    package_version: string;
  };
  project: {
    project_ref: string;
    project_base_url: string;
  };
  identity: {
    user_id: string;
    display_email: string;
  };
  session: {
    source: SessionSource;
    cache_mode: CacheMode;
    force_reauth: boolean;
    expires_at_utc: string | null;
  };
  bindings: {
    request_sha256: string;
    response_sha256: string;
  };
  assertions: {
    mode: 'observed' | 'partial' | 'intent-bound';
    requested_count: 0 | 1 | 2;
    expected_project_ref: string | null;
    expected_user_id: string | null;
    project_ref_passed: true | null;
    user_id_passed: true | null;
    passed: true;
  };
};

export type AuthIdentityReceipt = AuthIdentityReceiptScope & {
  receipt_scope_sha256: string;
};

export type ResolveAuthIdentitySession = (options: {
  runtime: SupabaseRestRuntime;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
  forceRefresh?: boolean;
}) => Promise<ResolvedSupabaseUserSession>;

export type RunAuthIdentityReceiptOptions = {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  cliVersion: string;
  expectedProjectRef?: string | null;
  expectedUserId?: string | null;
  timeoutMs?: number;
  now?: Date;
  resolveSessionImpl?: ResolveAuthIdentitySession;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function token(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeEmail(value: unknown): string | null {
  const normalized = token(value)?.toLowerCase() ?? null;
  if (!normalized || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function identityError(
  message: string,
  code: string,
  options: { exitCode?: number; details?: unknown } = {},
): never {
  throw new CliError(message, {
    code,
    exitCode: options.exitCode ?? 1,
    ...(options.details === undefined ? {} : { details: options.details }),
  });
}

function receiptInvalid(message: string): never {
  return identityError(message, 'AUTH_IDENTITY_RECEIPT_INVALID');
}

function normalizeExpectation(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = token(value);
  if (!normalized) {
    return identityError(
      `${label} must be a non-empty string when provided.`,
      'AUTH_IDENTITY_EXPECTATION_INVALID',
      {
        exitCode: 2,
        details: { option: label },
      },
    );
  }
  return normalized;
}

function normalizeExpectedUserId(value: string | null | undefined): string | null {
  const normalized = normalizeExpectation(value, '--expected-user-id');
  if (normalized !== null && !isCanonicalUuid(normalized)) {
    return identityError(
      '--expected-user-id must be a canonical lowercase UUID.',
      'AUTH_IDENTITY_EXPECTATION_INVALID',
      { exitCode: 2, details: { option: '--expected-user-id' } },
    );
  }
  return normalized;
}

function normalizeTimeoutMs(value: number | undefined): number {
  const normalized = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(normalized) ||
    normalized <= 0 ||
    normalized > AUTH_IDENTITY_MAX_TIMEOUT_MS
  ) {
    return identityError(
      `Auth identity timeout must be an integer between 1 and ${AUTH_IDENTITY_MAX_TIMEOUT_MS}.`,
      'AUTH_IDENTITY_TIMEOUT_INVALID',
      { exitCode: 2 },
    );
  }
  return normalized;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function canonicalProjectIdentity(
  projectBaseUrl: unknown,
): { projectBaseUrl: string; projectRef: string } | null {
  const normalized = token(projectBaseUrl);
  if (!normalized || normalized !== projectBaseUrl) {
    return null;
  }
  try {
    const url = new URL(normalized);
    const suffix = '.supabase.co';
    const hostname = url.hostname.toLowerCase();
    const projectRef = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : '';
    if (
      url.protocol !== 'https:' ||
      url.origin !== normalized ||
      url.username ||
      url.password ||
      url.port ||
      !projectRef ||
      projectRef.includes('.') ||
      !/^[a-z0-9-]+$/u.test(projectRef)
    ) {
      return null;
    }
    return { projectBaseUrl: url.origin, projectRef };
  } catch {
    return null;
  }
}

function projectRefFromBaseUrl(projectBaseUrl: string): string {
  const identity = canonicalProjectIdentity(projectBaseUrl);
  if (!identity) {
    return identityError(
      'The Supabase project URL did not contain a project identity.',
      'AUTH_IDENTITY_PROJECT_INVALID',
      { exitCode: 2 },
    );
  }
  return identity.projectRef;
}

function resolveProjectIdentity(apiBaseUrl: string): {
  projectBaseUrl: string;
  projectRef: string;
} {
  let projectBaseUrl: string;
  try {
    projectBaseUrl = deriveSupabaseProjectBaseUrl(apiBaseUrl);
  } catch {
    return identityError(
      'TIANGONG_LCA_API_BASE_URL must identify a canonical Supabase project.',
      'AUTH_IDENTITY_PROJECT_INVALID',
      { exitCode: 2 },
    );
  }
  const projectRef = projectRefFromBaseUrl(projectBaseUrl);
  return { projectBaseUrl, projectRef };
}

function cacheMode(runtime: SupabaseRestRuntime): CacheMode {
  if (runtime.authMode === 'access_token' || runtime.disableSessionCache) {
    return 'disabled';
  }
  return runtime.sessionFile ? 'custom-file' : 'platform-default';
}

function sessionExpiresAtUtc(expiresAt: number | null): string | null {
  if (expiresAt === null) {
    return null;
  }
  if (!Number.isFinite(expiresAt)) {
    return identityError(
      'Resolved auth session contained an invalid expiry.',
      'AUTH_IDENTITY_SESSION_MISMATCH',
    );
  }
  const timestamp = new Date(Math.floor(expiresAt) * 1000);
  if (Number.isNaN(timestamp.getTime())) {
    return identityError(
      'Resolved auth session contained an invalid expiry.',
      'AUTH_IDENTITY_SESSION_MISMATCH',
    );
  }
  return timestamp.toISOString();
}

function assertSessionBinding(options: {
  runtime: SupabaseRestRuntime;
  session: ResolvedSupabaseUserSession;
  projectBaseUrl: string;
  now: Date;
}): void {
  const { runtime, session } = options;
  const sessionEmail = normalizeEmail(session.userEmail);
  const accessToken = token(session.accessToken);
  const source = session.source as string;
  const expectedMode = cacheMode(runtime);
  const customSessionPath = runtime.sessionFile ? path.resolve(runtime.sessionFile) : null;
  const sessionPath = session.sessionFile ? path.resolve(session.sessionFile) : null;
  const cachePathMatches =
    expectedMode === 'disabled'
      ? sessionPath === null
      : expectedMode === 'custom-file'
        ? sessionPath === customSessionPath
        : sessionPath !== null;
  const cacheSourceFresh =
    !['memory', 'cache'].includes(source) ||
    (typeof session.expiresAt === 'number' &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt >
        Math.floor(options.now.getTime() / 1000) + SESSION_REFRESH_WINDOW_SECONDS);

  if (
    !accessToken ||
    session.authMethod !== runtime.authMode ||
    session.projectBaseUrl !== options.projectBaseUrl ||
    !sessionEmail ||
    !SESSION_SOURCES.includes(session.source) ||
    !cachePathMatches ||
    !cacheSourceFresh ||
    (runtime.forceReauth && ['memory', 'cache'].includes(source))
  ) {
    identityError(
      'Resolved auth session does not match the requested credential, project, or cache boundary.',
      'AUTH_IDENTITY_SESSION_MISMATCH',
    );
  }
}

async function resolveBoundSession(options: {
  runtime: SupabaseRestRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: Date;
  forceRefresh?: boolean;
  resolveSessionImpl: ResolveAuthIdentitySession;
}): Promise<ResolvedSupabaseUserSession> {
  try {
    return await options.resolveSessionImpl({
      runtime: options.runtime,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      now: options.now,
      forceRefresh: options.forceRefresh,
    });
  } catch (error) {
    const causeCode =
      error instanceof CliError
        ? error.code
        : isRecord(error) && typeof error.code === 'string'
          ? error.code
          : 'UNEXPECTED_SESSION_FAILURE';
    return identityError(
      'Failed to resolve the authenticated user session.',
      'AUTH_IDENTITY_SESSION_FAILED',
      { details: { cause_code: causeCode } },
    );
  }
}

function currentUserFailureStatus(error: unknown): number | null {
  if (
    !(error instanceof CliError) ||
    error.code !== 'AUTH_IDENTITY_REMOTE_REQUEST_FAILED' ||
    !isRecord(error.details) ||
    typeof error.details.status !== 'number' ||
    !Number.isInteger(error.details.status)
  ) {
    return null;
  }
  return error.details.status;
}

function declaredResponseBytes(response: {
  headers: { get(name: string): string | null };
}): number | null {
  const value = response.headers.get('content-length')?.trim() ?? '';
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  return Number(value);
}

async function readBoundedResponseText(response: {
  body?: ReadableStream<Uint8Array> | null;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}): Promise<string> {
  const declaredBytes = declaredResponseBytes(response);
  if (declaredBytes !== null && declaredBytes > MAX_RESPONSE_BYTES) {
    throw new ResponseBodyTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new ResponseBodyTooLargeError();
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let observedBytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      observedBytes += chunk.value.byteLength;
      if (observedBytes > MAX_RESPONSE_BYTES) {
        await Promise.allSettled([reader.cancel()]);
        throw new ResponseBodyTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

// Internal CLI consumers may bind their already selected session to this bounded
// live lookup, including an explicitly configured loopback test project. This
// does not change the public receipt's canonical project restrictions.
export async function fetchCurrentUser(options: {
  projectBaseUrl: string;
  publishableKey: string;
  accessToken: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<{ userId: string; email: string }> {
  const url = `${options.projectBaseUrl}${CURRENT_USER_PATH}`;
  let response;
  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      headers: buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    return identityError(
      'Authenticated current-user lookup failed before a response was received.',
      'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
      {
        details: {
          endpoint: CURRENT_USER_PATH,
          cause: error instanceof Error ? error.name : typeof error,
        },
      },
    );
  }

  if (!response.ok) {
    return identityError(
      `Authenticated current-user lookup returned HTTP ${response.status}.`,
      'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
      { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
    );
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    return identityError(
      'Authenticated current-user response did not declare JSON content.',
      'AUTH_IDENTITY_REMOTE_INVALID_JSON',
      { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
    );
  }

  let text: string;
  try {
    text = await readBoundedResponseText(response);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return identityError(
        'Authenticated current-user response exceeded the bounded receipt limit.',
        'AUTH_IDENTITY_RESPONSE_TOO_LARGE',
        { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
      );
    }
    return identityError(
      'Authenticated current-user response could not be read.',
      'AUTH_IDENTITY_REMOTE_REQUEST_FAILED',
      {
        details: {
          endpoint: CURRENT_USER_PATH,
          status: response.status,
          cause: error instanceof Error ? error.name : typeof error,
        },
      },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return identityError(
      'Authenticated current-user response was not valid JSON.',
      'AUTH_IDENTITY_REMOTE_INVALID_JSON',
      { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
    );
  }
  if (isRecord(payload) && payload.ok === false) {
    return identityError(
      'Authenticated current-user response explicitly reported ok:false.',
      'AUTH_IDENTITY_REMOTE_REJECTED',
      { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
    );
  }
  const userId = isRecord(payload) && isCanonicalUuid(payload.id) ? payload.id : null;
  const email = isRecord(payload) ? normalizeEmail(payload.email) : null;
  if (!userId || !email) {
    return identityError(
      'Authenticated current-user response did not contain a valid id and email.',
      'AUTH_IDENTITY_RESPONSE_INVALID',
      { details: { endpoint: CURRENT_USER_PATH, status: response.status } },
    );
  }
  return { userId, email };
}

function requestFingerprint(projectRef: string): string {
  return sha256Json({
    method: 'GET',
    path: CURRENT_USER_PATH,
    project_ref: projectRef,
    redirect: 'error',
    header_names: ['accept', 'apikey', 'authorization'],
  });
}

function responseFingerprint(options: {
  projectRef: string;
  userId: string;
  displayEmail: string;
}): string {
  return sha256Json({
    project_ref: options.projectRef,
    user_id: options.userId,
    display_email: options.displayEmail,
  });
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isCanonicalToken(value: unknown): value is string {
  return typeof value === 'string' && token(value) === value;
}

function isMaskedEmail(value: unknown): value is string {
  return isCanonicalToken(value) && /^(?:[^*@\s]{2})?\*{4}@[^@\s]+\.[^@\s]+$/u.test(value);
}

function receiptScope(receipt: AuthIdentityReceipt): AuthIdentityReceiptScope {
  const { receipt_scope_sha256: _receiptScopeSha256, ...scope } = receipt;
  return scope;
}

export function parseAuthIdentityReceipt(value: unknown): AuthIdentityReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'assertions',
      'bindings',
      'captured_at_utc',
      'cli',
      'identity',
      'operation',
      'project',
      'receipt_scope_sha256',
      'remote_write_mode',
      'schema',
      'session',
      'status',
    ])
  ) {
    return receiptInvalid('Auth identity receipt must be an exact object.');
  }

  const cli = value.cli;
  const project = value.project;
  const identity = value.identity;
  const session = value.session;
  const bindings = value.bindings;
  const assertions = value.assertions;
  const parsedProject =
    isRecord(project) && typeof project.project_base_url === 'string'
      ? canonicalProjectIdentity(project.project_base_url)
      : null;
  if (
    value.schema !== AUTH_IDENTITY_RECEIPT_SCHEMA ||
    value.status !== 'passed' ||
    value.operation !== 'current-user-read' ||
    value.remote_write_mode !== 'read-only' ||
    !canonicalTimestamp(value.captured_at_utc) ||
    !isRecord(cli) ||
    !hasExactKeys(cli, ['package_name', 'package_version']) ||
    cli.package_name !== CLI_PACKAGE_NAME ||
    !isCanonicalToken(cli.package_version) ||
    !isRecord(project) ||
    !hasExactKeys(project, ['project_base_url', 'project_ref']) ||
    !isCanonicalToken(project.project_ref) ||
    !parsedProject ||
    parsedProject.projectRef !== project.project_ref ||
    !isRecord(identity) ||
    !hasExactKeys(identity, ['display_email', 'user_id']) ||
    !isCanonicalUuid(identity.user_id) ||
    !isMaskedEmail(identity.display_email) ||
    !isRecord(session) ||
    !hasExactKeys(session, ['cache_mode', 'expires_at_utc', 'force_reauth', 'source']) ||
    !isOneOf(session.source, SESSION_SOURCES) ||
    !isOneOf(session.cache_mode, CACHE_MODES) ||
    typeof session.force_reauth !== 'boolean' ||
    !(session.expires_at_utc === null || canonicalTimestamp(session.expires_at_utc)) ||
    !isRecord(bindings) ||
    !hasExactKeys(bindings, ['request_sha256', 'response_sha256']) ||
    typeof bindings.request_sha256 !== 'string' ||
    !SHA256_PATTERN.test(bindings.request_sha256) ||
    typeof bindings.response_sha256 !== 'string' ||
    !SHA256_PATTERN.test(bindings.response_sha256) ||
    bindings.request_sha256 !== requestFingerprint(project.project_ref as string) ||
    bindings.response_sha256 !==
      responseFingerprint({
        projectRef: project.project_ref as string,
        userId: identity.user_id as string,
        displayEmail: identity.display_email as string,
      }) ||
    !isRecord(assertions) ||
    !hasExactKeys(assertions, [
      'expected_project_ref',
      'expected_user_id',
      'mode',
      'passed',
      'project_ref_passed',
      'requested_count',
      'user_id_passed',
    ]) ||
    !isOneOf(assertions.mode, ['observed', 'partial', 'intent-bound'] as const) ||
    ![0, 1, 2].includes(assertions.requested_count as number) ||
    !(
      assertions.expected_project_ref === null || isCanonicalToken(assertions.expected_project_ref)
    ) ||
    !(assertions.expected_user_id === null || isCanonicalUuid(assertions.expected_user_id)) ||
    !(assertions.project_ref_passed === true || assertions.project_ref_passed === null) ||
    !(assertions.user_id_passed === true || assertions.user_id_passed === null) ||
    assertions.passed !== true ||
    (assertions.expected_project_ref === null) !== (assertions.project_ref_passed === null) ||
    (assertions.expected_user_id === null) !== (assertions.user_id_passed === null) ||
    assertions.requested_count !==
      Number(assertions.expected_project_ref !== null) +
        Number(assertions.expected_user_id !== null) ||
    assertions.mode !==
      (assertions.requested_count === 0
        ? 'observed'
        : assertions.requested_count === 2
          ? 'intent-bound'
          : 'partial') ||
    (assertions.expected_project_ref !== null &&
      assertions.expected_project_ref !== project.project_ref) ||
    (assertions.expected_user_id !== null && assertions.expected_user_id !== identity.user_id) ||
    typeof value.receipt_scope_sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.receipt_scope_sha256)
  ) {
    return receiptInvalid('Auth identity receipt failed schema validation.');
  }

  const receipt = value as AuthIdentityReceipt;
  if (receipt.receipt_scope_sha256 !== sha256Json(receiptScope(receipt))) {
    return receiptInvalid('Auth identity receipt canonical scope hash does not match.');
  }
  return receipt;
}

export async function runAuthIdentityReceipt(
  options: RunAuthIdentityReceiptOptions,
): Promise<AuthIdentityReceipt> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const expectedProjectRef = normalizeExpectation(
    options.expectedProjectRef,
    '--expected-project-ref',
  );
  const expectedUserId = normalizeExpectedUserId(options.expectedUserId);
  const cliVersion = token(options.cliVersion);
  if (!cliVersion) {
    return identityError(
      'CLI package version is required for an identity receipt.',
      'AUTH_IDENTITY_VERSION_INVALID',
      { exitCode: 2 },
    );
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    return identityError(
      'Identity receipt capture time is invalid.',
      'AUTH_IDENTITY_CAPTURE_TIME_INVALID',
      { exitCode: 2 },
    );
  }

  const runtime = requireSupabaseRestRuntime(options.env);
  const { projectBaseUrl, projectRef } = resolveProjectIdentity(runtime.apiBaseUrl);
  if (expectedProjectRef !== null && expectedProjectRef !== projectRef) {
    return identityError(
      'Authenticated project does not match --expected-project-ref.',
      'AUTH_IDENTITY_PROJECT_MISMATCH',
      { details: { expected_project_ref: expectedProjectRef, observed_project_ref: projectRef } },
    );
  }
  let session = await resolveBoundSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs,
    now,
    resolveSessionImpl: options.resolveSessionImpl ?? resolveSupabaseUserSession,
  });
  assertSessionBinding({
    runtime,
    session,
    projectBaseUrl,
    now,
  });

  let currentUser: Awaited<ReturnType<typeof fetchCurrentUser>>;
  try {
    currentUser = await fetchCurrentUser({
      projectBaseUrl,
      publishableKey: runtime.publishableKey,
      accessToken: session.accessToken,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const status = currentUserFailureStatus(error);
    if (status === null || ![401, 403].includes(status)) {
      throw error;
    }
    session = await resolveBoundSession({
      runtime,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      now,
      forceRefresh: true,
      resolveSessionImpl: options.resolveSessionImpl ?? resolveSupabaseUserSession,
    });
    assertSessionBinding({
      runtime,
      session,
      projectBaseUrl,
      now,
    });
    currentUser = await fetchCurrentUser({
      projectBaseUrl,
      publishableKey: runtime.publishableKey,
      accessToken: session.accessToken,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
  const sessionEmail = normalizeEmail(session.userEmail);
  if (!sessionEmail || currentUser.email !== sessionEmail) {
    return identityError(
      'Server-verified current user does not match the resolved session identity.',
      'AUTH_IDENTITY_SESSION_MISMATCH',
    );
  }
  if (expectedUserId !== null && expectedUserId !== currentUser.userId) {
    return identityError(
      'Authenticated user does not match --expected-user-id.',
      'AUTH_IDENTITY_USER_MISMATCH',
      { details: { expected_user_id: expectedUserId, observed_user_id: currentUser.userId } },
    );
  }

  const displayEmail = redactEmail(currentUser.email);
  const requestedAssertionCount =
    Number(expectedProjectRef !== null) + Number(expectedUserId !== null);
  const scope: AuthIdentityReceiptScope = {
    schema: AUTH_IDENTITY_RECEIPT_SCHEMA,
    status: 'passed',
    operation: 'current-user-read',
    remote_write_mode: 'read-only',
    captured_at_utc: now.toISOString(),
    cli: {
      package_name: CLI_PACKAGE_NAME,
      package_version: cliVersion,
    },
    project: {
      project_ref: projectRef,
      project_base_url: projectBaseUrl,
    },
    identity: {
      user_id: currentUser.userId,
      display_email: displayEmail,
    },
    session: {
      source: session.source,
      cache_mode: cacheMode(runtime),
      force_reauth: runtime.forceReauth,
      expires_at_utc: sessionExpiresAtUtc(session.expiresAt),
    },
    bindings: {
      request_sha256: requestFingerprint(projectRef),
      response_sha256: responseFingerprint({
        projectRef,
        userId: currentUser.userId,
        displayEmail,
      }),
    },
    assertions: {
      mode:
        requestedAssertionCount === 0
          ? 'observed'
          : requestedAssertionCount === 2
            ? 'intent-bound'
            : 'partial',
      requested_count: requestedAssertionCount as 0 | 1 | 2,
      expected_project_ref: expectedProjectRef,
      expected_user_id: expectedUserId,
      project_ref_passed: expectedProjectRef === null ? null : true,
      user_id_passed: expectedUserId === null ? null : true,
      passed: true,
    },
  };
  return parseAuthIdentityReceipt({
    ...scope,
    receipt_scope_sha256: sha256Json(scope),
  });
}

export const __testInternals = {
  MAX_RESPONSE_BYTES,
  assertSessionBinding,
  cacheMode,
  canonicalTimestamp,
  canonicalProjectIdentity,
  currentUserFailureStatus,
  declaredResponseBytes,
  fetchCurrentUser,
  hasExactKeys,
  isCanonicalToken,
  isCanonicalUuid,
  isMaskedEmail,
  isOneOf,
  normalizeEmail,
  normalizeExpectation,
  normalizeExpectedUserId,
  normalizeTimeoutMs,
  projectRefFromBaseUrl,
  readBoundedResponseText,
  requestFingerprint,
  responseFingerprint,
  resolveProjectIdentity,
  sessionExpiresAtUtc,
  sha256Json,
  stableJsonValue,
  token,
};
