import { createHash, randomBytes } from 'node:crypto';
import { CliError } from '../shared/errors.js';
import type { FetchLike, ResponseLike } from './http.js';

export const OAUTH_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_OAUTH_SCOPES = ['openid', 'email', 'profile'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const OAUTH_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type OAuthPkceValues = {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
};

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string[];
};

export type OAuthUserInfo = {
  userId: string;
  email: string;
};

type RandomBytes = (size: number) => Uint8Array;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireProjectBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError('OAuth project URL is invalid.', {
      code: 'OAUTH_PROJECT_URL_INVALID',
      exitCode: 2,
    });
  }

  const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/u, '') ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback))
  ) {
    throw new CliError('OAuth project URL must be an HTTPS origin or a loopback HTTP origin.', {
      code: 'OAUTH_PROJECT_URL_INVALID',
      exitCode: 2,
    });
  }

  return parsed.origin;
}

export function requireOAuthClientId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new CliError('TIANGONG_LCA_OAUTH_CLIENT_ID must be a canonical UUID.', {
      code: 'OAUTH_CLIENT_ID_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

export function createOAuthPkceValues(
  randomBytesImpl: RandomBytes = (size) => randomBytes(size),
): OAuthPkceValues {
  const verifierBytes = randomBytesImpl(64);
  const stateBytes = randomBytesImpl(32);
  if (verifierBytes.byteLength !== 64 || stateBytes.byteLength !== 32) {
    throw new CliError('Secure OAuth randomness source returned an invalid length.', {
      code: 'OAUTH_RANDOMNESS_INVALID',
      exitCode: 1,
    });
  }

  const codeVerifier = base64Url(verifierBytes);
  const state = base64Url(stateBytes);
  return {
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    state,
  };
}

export function buildOAuthAuthorizationUrl(options: {
  projectBaseUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const projectBaseUrl = requireProjectBaseUrl(options.projectBaseUrl);
  const clientId = requireOAuthClientId(options.clientId);
  if (!PKCE_VALUE_PATTERN.test(options.codeChallenge)) {
    throw new CliError('OAuth PKCE code challenge is invalid.', {
      code: 'OAUTH_PKCE_CHALLENGE_INVALID',
      exitCode: 1,
    });
  }
  if (!STATE_PATTERN.test(options.state)) {
    throw new CliError('OAuth state is invalid.', {
      code: 'OAUTH_STATE_INVALID',
      exitCode: 1,
    });
  }

  const authorizationUrl = new URL(`${projectBaseUrl}/auth/v1/oauth/authorize`);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri,
    scope: DEFAULT_OAUTH_SCOPES.join(' '),
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state,
  }).toString();
  return authorizationUrl.toString();
}

function parseOAuthTokenSet(value: unknown, previousRefreshToken = ''): OAuthTokenSet {
  if (!isRecord(value)) {
    throw new CliError('OAuth token response was not an object.', {
      code: 'OAUTH_TOKEN_RESPONSE_INVALID',
      exitCode: 1,
    });
  }

  const accessToken = trimString(value.access_token);
  const refreshToken = trimString(value.refresh_token) || trimString(previousRefreshToken);
  const tokenType = trimString(value.token_type).toLowerCase();
  const expiresIn = value.expires_in;
  const scopeText = trimString(value.scope);
  const scope = scopeText ? [...new Set(scopeText.split(/\s+/u).filter(Boolean))].sort() : [];

  if (
    !accessToken ||
    !refreshToken ||
    tokenType !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new CliError('OAuth token response did not contain a usable bearer session.', {
      code: 'OAUTH_TOKEN_RESPONSE_INVALID',
      exitCode: 1,
    });
  }

  return { accessToken, refreshToken, expiresIn, scope };
}

function parseOAuthFailureCode(value: unknown, status: number): string {
  const fallback = 'oauth_request_failed';
  if (!isRecord(value)) return fallback;

  // RFC OAuth and Supabase HTTP errors use different envelopes. Mixed forms
  // are ambiguous: never let one field override a conflicting provider code.
  if ('error' in value) {
    if ('error_code' in value || 'code' in value) return fallback;
    const error = trimString(value.error);
    return OAUTH_ERROR_PATTERN.test(error) ? error : fallback;
  }

  // Only the observed, upstream-defined terminal code is admitted. Provider
  // messages and unknown native code strings must not enter a CLI error payload.
  if ('error_code' in value) {
    return value.code === status && value.error_code === 'refresh_token_not_found'
      ? 'refresh_token_not_found'
      : fallback;
  }
  return value.code === 'refresh_token_not_found' ? 'refresh_token_not_found' : fallback;
}

async function readBoundedJson(response: ResponseLike, url: string): Promise<unknown> {
  const contentLengthText = response.headers.get('content-length');
  if (contentLengthText) {
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new CliError('OAuth response Content-Length is invalid.', {
        code: 'OAUTH_RESPONSE_INVALID',
        exitCode: 1,
      });
    }
    if (contentLength > OAUTH_TOKEN_RESPONSE_MAX_BYTES) {
      throw new CliError('OAuth response exceeded the byte limit.', {
        code: 'OAUTH_RESPONSE_TOO_LARGE',
        exitCode: 1,
      });
    }
  }

  const rawText = await response.text();
  if (Buffer.byteLength(rawText, 'utf8') > OAUTH_TOKEN_RESPONSE_MAX_BYTES) {
    throw new CliError('OAuth response exceeded the byte limit.', {
      code: 'OAUTH_RESPONSE_TOO_LARGE',
      exitCode: 1,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CliError(`OAuth response was not valid JSON for ${url}.`, {
      code: 'OAUTH_RESPONSE_INVALID',
      exitCode: 1,
    });
  }

  if (!response.ok) {
    const oauthError = parseOAuthFailureCode(parsed, response.status);
    throw new CliError(`OAuth endpoint returned HTTP ${response.status}.`, {
      code: 'OAUTH_REQUEST_FAILED',
      exitCode: 1,
      details: { status: response.status, error: oauthError },
    });
  }

  return parsed;
}

async function requestOAuthToken(options: {
  projectBaseUrl: string;
  body: URLSearchParams;
  fetchImpl: FetchLike;
  timeoutMs: number;
  previousRefreshToken?: string;
}): Promise<OAuthTokenSet> {
  const projectBaseUrl = requireProjectBaseUrl(options.projectBaseUrl);
  const url = `${projectBaseUrl}/auth/v1/oauth/token`;
  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: options.body.toString(),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  return parseOAuthTokenSet(await readBoundedJson(response, url), options.previousRefreshToken);
}

export async function exchangeOAuthAuthorizationCode(options: {
  projectBaseUrl: string;
  clientId: string;
  redirectUri: string;
  authorizationCode: string;
  codeVerifier: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<OAuthTokenSet> {
  const clientId = requireOAuthClientId(options.clientId);
  const authorizationCode = trimString(options.authorizationCode);
  if (!authorizationCode || authorizationCode.length > 4096) {
    throw new CliError('OAuth authorization code is invalid.', {
      code: 'OAUTH_AUTHORIZATION_CODE_INVALID',
      exitCode: 1,
    });
  }
  if (!PKCE_VALUE_PATTERN.test(options.codeVerifier)) {
    throw new CliError('OAuth PKCE verifier is invalid.', {
      code: 'OAUTH_PKCE_VERIFIER_INVALID',
      exitCode: 1,
    });
  }

  return requestOAuthToken({
    projectBaseUrl: options.projectBaseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: clientId,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    }),
  });
}

export async function refreshOAuthTokens(options: {
  projectBaseUrl: string;
  clientId: string;
  refreshToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<OAuthTokenSet> {
  const clientId = requireOAuthClientId(options.clientId);
  const refreshToken = trimString(options.refreshToken);
  if (!refreshToken) {
    throw new CliError('OAuth refresh token is missing.', {
      code: 'OAUTH_REFRESH_TOKEN_REQUIRED',
      exitCode: 1,
    });
  }

  return requestOAuthToken({
    projectBaseUrl: options.projectBaseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    previousRefreshToken: refreshToken,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

export async function fetchOAuthUserInfo(options: {
  projectBaseUrl: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<OAuthUserInfo> {
  const projectBaseUrl = requireProjectBaseUrl(options.projectBaseUrl);
  const accessToken = trimString(options.accessToken);
  if (!accessToken) {
    throw new CliError('OAuth access token is missing.', {
      code: 'OAUTH_ACCESS_TOKEN_REQUIRED',
      exitCode: 1,
    });
  }

  const url = `${projectBaseUrl}/auth/v1/oauth/userinfo`;
  const response = await options.fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const value = await readBoundedJson(response, url);
  const userId = isRecord(value) ? trimString(value.sub) : '';
  const email = isRecord(value) ? trimString(value.email) : '';
  if (!UUID_PATTERN.test(userId) || !email || email.length > 320) {
    throw new CliError('OAuth UserInfo response did not contain a usable user identity.', {
      code: 'OAUTH_USERINFO_INVALID',
      exitCode: 1,
    });
  }
  return { userId: userId.toLowerCase(), email };
}

export const __testInternals = {
  base64Url,
  parseOAuthTokenSet,
  readBoundedJson,
  requireProjectBaseUrl,
  trimString,
};
