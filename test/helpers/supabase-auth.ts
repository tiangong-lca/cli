import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResponseLike } from '../../src/lib/transport/http.js';

export type SupabaseTestSessionOptions = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  email?: string;
  userId?: string;
};

const TEST_OAUTH_CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const sessionDirectories = new Set<string>();

process.once('exit', () => {
  for (const directory of sessionDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value.trim()).digest('hex')}`;
}

function projectBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl
    .trim()
    .replace(/\/(?:functions|rest)\/v1\/?$/u, '')
    .replace(/\/+$/u, '');
}

function createOAuthSessionFile(options: {
  accessToken: string;
  apiBaseUrl: string;
  clientId: string;
  publishableKey: string;
}): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tiangong-cli-oauth-test-'));
  sessionDirectories.add(directory);
  const sessionFile = path.join(directory, 'session.json');
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      schema_version: 2,
      auth_method: 'oauth',
      supabase_url: projectBaseUrl(options.apiBaseUrl),
      publishable_key_fingerprint: fingerprint(options.publishableKey),
      auth_binding_fingerprint: fingerprint(`oauth-client:${options.clientId}`),
      user_email: 'user@example.com',
      access_token: options.accessToken,
      refresh_token: 'refresh-token',
      expires_at: 4_102_444_800,
      granted_scopes: ['email', 'openid', 'profile'],
      updated_at_utc: '2026-09-01T00:00:00.000Z',
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  chmodSync(directory, 0o700);
  return sessionFile;
}

export function buildSupabaseTestEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const memoryOnly = /^(?:1|true|yes|on)$/iu.test(
    overrides.TIANGONG_LCA_DISABLE_SESSION_CACHE ?? '',
  );
  if (overrides.TIANGONG_LCA_AUTH_MODE === 'access-token' || memoryOnly) {
    return {
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
      ...overrides,
      TIANGONG_LCA_ACCESS_TOKEN: overrides.TIANGONG_LCA_ACCESS_TOKEN ?? 'access-token',
    } as NodeJS.ProcessEnv;
  }

  const apiBaseUrl =
    overrides.TIANGONG_LCA_API_BASE_URL ?? 'https://example.supabase.co/functions/v1';
  const publishableKey = overrides.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY ?? 'sb-publishable-key';
  const clientId = overrides.TIANGONG_LCA_OAUTH_CLIENT_ID ?? TEST_OAUTH_CLIENT_ID;
  const accessToken = overrides.TIANGONG_LCA_ACCESS_TOKEN || 'access-token';
  const sessionFile = createOAuthSessionFile({
    accessToken,
    apiBaseUrl,
    clientId,
    publishableKey,
  });
  const normalizedOverrides = { ...overrides };
  delete normalizedOverrides.TIANGONG_LCA_ACCESS_TOKEN;
  delete normalizedOverrides.TIANGONG_LCA_AUTH_MODE;
  delete normalizedOverrides.TIANGONG_LCA_OAUTH_CLIENT_ID;
  delete normalizedOverrides.TIANGONG_LCA_SESSION_FILE;
  delete normalizedOverrides.TIANGONG_LCA_DISABLE_SESSION_CACHE;
  delete normalizedOverrides.TIANGONG_LCA_FORCE_REAUTH;

  return {
    TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
    ...normalizedOverrides,
    TIANGONG_LCA_AUTH_MODE: 'oauth',
    TIANGONG_LCA_OAUTH_CLIENT_ID: clientId,
    TIANGONG_LCA_SESSION_FILE: sessionFile,
  } as NodeJS.ProcessEnv;
}

export function isSupabaseAuthTokenUrl(url: string): boolean {
  return url.includes('/auth/v1/oauth/token') || url.includes('/auth/v1/user');
}

export function makeSupabaseAuthResponse(options: SupabaseTestSessionOptions = {}): ResponseLike {
  const expiresAt = options.expiresAt ?? 4_102_444_800;
  const expiresIn = options.expiresIn ?? 3_600;
  const payload = {
    id: options.userId ?? 'user-1',
    email: options.email ?? 'user@example.com',
    access_token: options.accessToken ?? 'access-token',
    refresh_token: options.refreshToken ?? 'refresh-token',
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    user: {
      id: options.userId ?? 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: options.email ?? 'user@example.com',
    },
  };

  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(payload);
    },
  };
}
