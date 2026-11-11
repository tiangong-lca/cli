import { parseArgs } from 'node:util';
import { selectLoopbackAuthDiagnostic, runLoopbackAuthDiagnostic } from '../lib/study/transport.js';
import { CliError } from '../shared/errors.js';
import { stringifyJson } from '../lib/platform/io.js';
import { loadCliPackageVersion } from '../lib/platform/package-version.js';
import { requireSupabaseRestRuntime } from '../lib/transport/supabase-client.js';

import { OAUTH_LOGIN_TIMEOUT_MAX_MS } from '../lib/auth/oauth-loopback.js';
import {
  AUTH_IDENTITY_MAX_TIMEOUT_MS,
  AUTH_IDENTITY_RECEIPT_SCHEMA,
} from '../lib/auth/auth-identity-receipt.js';

import { cliFailure } from '../shared/legacy-command-result.js';
import type { ResolvedCliDeps, CliResult } from './ports.js';
function renderAuthHelp(): string {
  return `Usage:
  tiangong-lca auth <login|status|whoami|doctor-auth|logout|identity-receipt> [options]

Implemented Subcommands:
  login             Authorize the registered public CLI through browser PKCE and store a private rotating session
  status            Inspect only local auth readiness without reading or printing credentials
  whoami             Run the live, redacted identity receipt for the current user
  doctor-auth        Combine local readiness with a live, redacted identity check
  logout            Remove only this local CLI session; revoke the connected-app grant from the account page
  identity-receipt  Live, read-only proof of the authenticated account and Supabase project

Use "tiangong-lca auth <subcommand> --help" for details.
`.trim();
}

function renderAuthStatusHelp(): string {
  return `Usage:
  tiangong-lca auth status [--json]

Inspects only the matching local session metadata. It performs no network request, never refreshes
a token, and never emits email, token, session path, or credential fingerprint. A ready result can
still be remotely revoked; use "auth doctor-auth" when live verification is required. If OAuth login
is required, hand the terminal to the human user and run "tiangong-lca auth login". Never ask an AI
agent to collect a username, password, authorization code, access token, or refresh token.
`.trim();
}

function renderAuthWhoamiHelp(): string {
  return `Usage:
  tiangong-lca auth whoami [--timeout-ms <n>] [--json]

Runs the same live, read-only and redacted proof as "auth identity-receipt" without requiring an
expected identity assertion. It may refresh an OAuth session under the private session lock. Output
contains no token, full email address, session path, or credential fingerprint.
`.trim();
}

function renderAuthDoctorHelp(): string {
  return `Usage:
  tiangong-lca auth doctor-auth [--timeout-ms <n>] [--json]

First checks local readiness without network access. If ready, it performs the live redacted identity
receipt. Missing OAuth authorization returns login-required without attempting password bootstrap.
An explicit complete loopback configuration uses the distinct local-only diagnostic schema; it
validates the current origin/client/callback and live actor without claiming a canonical project
receipt or proving the historical login callback. Production/default behavior is unchanged.
Run "tiangong-lca auth login" only in a trusted human-controlled terminal.
`.trim();
}

function renderAuthLoginHelp(): string {
  return `Usage:
  tiangong-lca auth login [options]

Options:
  --timeout-ms <n>  Browser callback timeout 1..${OAUTH_LOGIN_TIMEOUT_MAX_MS} ms (default: 180000)
  --json            Print compact JSON; default output is pretty JSON
  -h, --help

Official Production requires no environment configuration. Run auth login directly.
For a custom environment, configure its complete public tuple (never mix projects):
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_OAUTH_CLIENT_ID

Optional env:
  TIANGONG_LCA_AUTH_MODE=oauth
  TIANGONG_LCA_OAUTH_REDIRECT_URI (default: exact registered 127.0.0.1 callback)
  TIANGONG_LCA_SESSION_FILE

The CLI binds only 127.0.0.1, opens the system browser without a shell, verifies state and S256
PKCE, and atomically writes access/rotating refresh tokens to a private session file. It never
accepts a username, password, authorization code, access token, or refresh token as an argv value.
`.trim();
}

function renderAuthLogoutHelp(): string {
  return `Usage:
  tiangong-lca auth logout [--json]

Removes only the locally cached session bound to the current project/client. To revoke the OAuth
grant and every refresh token, disconnect TianGong CLI from Connected applications in the account
page. An explicit TIANGONG_LCA_ACCESS_TOKEN is never persisted and therefore has nothing to delete.
`.trim();
}

function renderAuthIdentityReceiptHelp(): string {
  return `Usage:
  tiangong-lca auth identity-receipt [options]

Options:
  --expected-project-ref <ref>  Assert the exact Supabase project before session/network access
  --expected-user-id <id>       Assert the exact server-verified authenticated user
  --timeout-ms <n>              Request timeout 1..${AUTH_IDENTITY_MAX_TIMEOUT_MS} ms (default: 10000)
  --json                        Print compact JSON; default output is pretty JSON
  -h, --help

Receipt schema:
  ${AUTH_IDENTITY_RECEIPT_SCHEMA}

Safety:
  This is a read-only command that performs one live read of /auth/v1/user, with at most one
  force-refresh retry after a 401 or 403. It never emits API keys, bearer/session
  tokens, full email addresses, session paths, or credential-derived fingerprints. Production guards
  must pass both expected assertions and require assertions.mode="intent-bound".

Official Production uses the bundled public profile and a prior "tiangong-lca auth login".
For a custom environment, configure:
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_OAUTH_CLIENT_ID and a prior "tiangong-lca auth login"

Headless alternative:
  TIANGONG_LCA_ACCESS_TOKEN (short-lived actor token; never cached or refreshed)

Optional session env:
  TIANGONG_LCA_SESSION_FILE
  TIANGONG_LCA_DISABLE_SESSION_CACHE
  TIANGONG_LCA_FORCE_REAUTH
`.trim();
}

function parseAuthIdentityReceiptFlags(args: string[]): {
  help: boolean;
  json: boolean;
  expectedProjectRef: string | null;
  expectedUserId: string | null;
  timeoutMs: number;
} {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'expected-project-ref': { type: 'string' },
      'expected-user-id': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });

  const timeoutText =
    typeof parsed.values['timeout-ms'] === 'string' ? parsed.values['timeout-ms'] : undefined;
  const timeoutMs = timeoutText === undefined ? 10_000 : Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > AUTH_IDENTITY_MAX_TIMEOUT_MS) {
    throw new CliError(
      `Expected --timeout-ms to be an integer between 1 and ${AUTH_IDENTITY_MAX_TIMEOUT_MS}.`,
      {
        code: 'INVALID_TIMEOUT',
        exitCode: 2,
      },
    );
  }

  return {
    help: Boolean(parsed.values.help),
    json: Boolean(parsed.values.json),
    expectedProjectRef:
      typeof parsed.values['expected-project-ref'] === 'string'
        ? parsed.values['expected-project-ref']
        : null,
    expectedUserId:
      typeof parsed.values['expected-user-id'] === 'string'
        ? parsed.values['expected-user-id']
        : null,
    timeoutMs,
  };
}

function parseAuthLoginFlags(args: string[]): {
  help: boolean;
  json: boolean;
  timeoutMs: number;
} {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
    },
  });

  const timeoutText = parsed.values['timeout-ms'];
  const timeoutMs = typeof timeoutText === 'string' ? Number(timeoutText) : 180_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > OAUTH_LOGIN_TIMEOUT_MAX_MS
  ) {
    throw new CliError(
      `Expected --timeout-ms to be an integer between 1 and ${OAUTH_LOGIN_TIMEOUT_MAX_MS}.`,
      { code: 'INVALID_TIMEOUT', exitCode: 2 },
    );
  }

  return {
    help: Boolean(parsed.values.help),
    json: Boolean(parsed.values.json),
    timeoutMs,
  };
}

function parseAuthLogoutFlags(args: string[]): { help: boolean; json: boolean } {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
  });
  return { help: Boolean(values.help), json: Boolean(values.json) };
}

function parseAuthLiveFlags(args: string[]): { help: boolean; json: boolean; timeoutMs: number } {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'timeout-ms': { type: 'string' },
    },
  });

  const timeoutText = parsed.values['timeout-ms'];
  const timeoutMs = typeof timeoutText === 'string' ? Number(timeoutText) : 10_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > AUTH_IDENTITY_MAX_TIMEOUT_MS
  ) {
    throw new CliError(
      `Expected --timeout-ms to be an integer between 1 and ${AUTH_IDENTITY_MAX_TIMEOUT_MS}.`,
      { code: 'INVALID_TIMEOUT', exitCode: 2 },
    );
  }
  return {
    help: Boolean(parsed.values.help),
    json: Boolean(parsed.values.json),
    timeoutMs,
  };
}

export async function executeAuthService(
  subcommand: string | null,
  commandArgs: string[],
  deps: ResolvedCliDeps,
): Promise<CliResult> {
  try {
    const authIdentityReceiptImpl = deps.runAuthIdentityReceiptImpl;
    const oauthLoginImpl = deps.loginWithSupabaseOAuthImpl;
    const oauthLogoutImpl = deps.logoutSupabaseUserSessionImpl;
    const authStatusImpl = deps.inspectSupabaseAuthStatusImpl;
    if (!subcommand) return { exitCode: 0, stdout: `${renderAuthHelp()}\n`, stderr: '' };

    if (subcommand === 'identity-receipt') {
      const authFlags = parseAuthIdentityReceiptFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthIdentityReceiptHelp()}\n`, stderr: '' };
      }
      const receipt = await authIdentityReceiptImpl({
        env: deps.env,
        fetchImpl: deps.fetchImpl,
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        expectedProjectRef: authFlags.expectedProjectRef,
        expectedUserId: authFlags.expectedUserId,
        timeoutMs: authFlags.timeoutMs,
      });
      return {
        exitCode: 0,
        stdout: stringifyJson(receipt, authFlags.json),
        stderr: '',
      };
    }

    if (subcommand === 'status') {
      const authFlags = parseAuthLogoutFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthStatusHelp()}\n`, stderr: '' };
      }
      const receipt = authStatusImpl({ runtime: requireSupabaseRestRuntime(deps.env) });
      return {
        exitCode: receipt.status === 'ready' ? 0 : 1,
        stdout: stringifyJson(receipt, authFlags.json),
        stderr: '',
      };
    }

    if (subcommand === 'whoami') {
      const authFlags = parseAuthLiveFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthWhoamiHelp()}\n`, stderr: '' };
      }
      const receipt = await authIdentityReceiptImpl({
        env: deps.env,
        fetchImpl: deps.fetchImpl,
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        expectedProjectRef: null,
        expectedUserId: null,
        timeoutMs: authFlags.timeoutMs,
      });
      return { exitCode: 0, stdout: stringifyJson(receipt, authFlags.json), stderr: '' };
    }

    if (subcommand === 'doctor-auth') {
      const authFlags = parseAuthLiveFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthDoctorHelp()}\n`, stderr: '' };
      }
      const loopback = selectLoopbackAuthDiagnostic(deps.env);
      const local = authStatusImpl({
        runtime: loopback?.runtime ?? requireSupabaseRestRuntime(deps.env),
      });
      const diagnosticIdentity = loopback
        ? { schemaVersion: 'tiangong.cli-loopback-auth-doctor.v1', scope: 'explicit-loopback' }
        : { schemaVersion: 'tiangong.cli-auth-doctor.v1' };
      if (local.status !== 'ready') {
        return {
          exitCode: 1,
          stdout: stringifyJson(
            {
              ...diagnosticIdentity,
              status: 'login-required',
              local,
              live: null,
            },
            authFlags.json,
          ),
          stderr: '',
        };
      }
      const live = loopback
        ? await runLoopbackAuthDiagnostic(loopback, {
            fetchImpl: deps.fetchImpl,
            timeoutMs: authFlags.timeoutMs,
          })
        : await authIdentityReceiptImpl({
            env: deps.env,
            fetchImpl: deps.fetchImpl,
            cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
            expectedProjectRef: null,
            expectedUserId: null,
            timeoutMs: authFlags.timeoutMs,
          });
      return {
        exitCode: 0,
        stdout: stringifyJson(
          {
            ...diagnosticIdentity,
            status: 'passed',
            local,
            live,
          },
          authFlags.json,
        ),
        stderr: '',
      };
    }

    if (subcommand === 'login') {
      const authFlags = parseAuthLoginFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthLoginHelp()}\n`, stderr: '' };
      }
      const receipt = await oauthLoginImpl({
        runtime: requireSupabaseRestRuntime(deps.env),
        fetchImpl: deps.fetchImpl,
        loginTimeoutMs: authFlags.timeoutMs,
      });
      return { exitCode: 0, stdout: stringifyJson(receipt, authFlags.json), stderr: '' };
    }

    if (subcommand === 'logout') {
      const authFlags = parseAuthLogoutFlags(commandArgs);
      if (authFlags.help) {
        return { exitCode: 0, stdout: `${renderAuthLogoutHelp()}\n`, stderr: '' };
      }
      const receipt = await oauthLogoutImpl({ runtime: requireSupabaseRestRuntime(deps.env) });
      return { exitCode: 0, stdout: stringifyJson(receipt, authFlags.json), stderr: '' };
    }

    throw new CliError('Unknown auth action.', { code: 'UNKNOWN_COMMAND', exitCode: 2 });
  } catch (error) {
    return cliFailure(error);
  }
}
