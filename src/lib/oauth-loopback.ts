import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { CliError } from '../shared/errors.js';

export const DEFAULT_OAUTH_REDIRECT_URI = 'http://127.0.0.1:49191/oauth/callback';
export const OAUTH_LOGIN_TIMEOUT_MAX_MS = 5 * 60 * 1000;

const CALLBACK_PATH = '/oauth/callback';
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const OAUTH_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

type SpawnedBrowser = {
  once(event: 'error', listener: (error: Error) => void): SpawnedBrowser;
  once(event: 'spawn', listener: () => void): SpawnedBrowser;
  unref(): void;
};

export type BrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: true; shell: false; stdio: 'ignore' },
) => SpawnedBrowser;

export type OAuthLoopbackBinding = {
  redirectUri: string;
  hostname: '127.0.0.1';
  port: number;
  pathname: typeof CALLBACK_PATH;
};

export const SYSTEM_BROWSER_OPTIONS = {
  platform: process.platform,
  spawnImpl: spawn as unknown as BrowserSpawn,
} satisfies { platform: NodeJS.Platform; spawnImpl: BrowserSpawn };

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function requireOAuthLoopbackRedirectUri(value: string): OAuthLoopbackBinding {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError('OAuth redirect URI is invalid.', {
      code: 'OAUTH_REDIRECT_URI_INVALID',
      exitCode: 2,
    });
  }

  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== CALLBACK_PATH ||
    parsed.search ||
    parsed.hash ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535
  ) {
    throw new CliError(
      'OAuth redirect URI must be an exact http://127.0.0.1:<port>/oauth/callback URL.',
      {
        code: 'OAUTH_REDIRECT_URI_INVALID',
        exitCode: 2,
      },
    );
  }

  return {
    redirectUri: parsed.toString(),
    hostname: '127.0.0.1',
    port,
    pathname: CALLBACK_PATH,
  };
}

function browserCommand(platform: NodeJS.Platform, authorizationUrl: string) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [authorizationUrl] };
    case 'win32':
      return {
        command: 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', authorizationUrl],
      };
    case 'linux':
      return { command: 'xdg-open', args: [authorizationUrl] };
    default:
      throw new CliError(`Cannot open a browser automatically on ${platform}.`, {
        code: 'OAUTH_BROWSER_UNSUPPORTED',
        exitCode: 1,
      });
  }
}

export async function openSystemBrowser(
  authorizationUrl: string,
  options: {
    platform: NodeJS.Platform;
    spawnImpl: BrowserSpawn;
  },
): Promise<void> {
  const target = browserCommand(options.platform, authorizationUrl);
  const spawnImpl = options.spawnImpl;

  await new Promise<void>((resolve, reject) => {
    let child: SpawnedBrowser;
    try {
      child = spawnImpl(target.command, target.args, {
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
    } catch (error) {
      reject(
        new CliError('Failed to start the system browser.', {
          code: 'OAUTH_BROWSER_OPEN_FAILED',
          exitCode: 1,
          details: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(
        new CliError('Failed to start the system browser.', {
          code: 'OAUTH_BROWSER_OPEN_FAILED',
          exitCode: 1,
          details: error.message,
        }),
      );
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function safeStateEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function writeResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function callbackError(message: string, code: string, details?: unknown): CliError {
  return new CliError(message, { code, exitCode: 1, details });
}

export async function receiveOAuthLoopbackCallback(options: {
  redirectUri: string;
  expectedState: string;
  timeoutMs: number;
  onListening: () => void | Promise<void>;
}): Promise<string> {
  const binding = requireOAuthLoopbackRedirectUri(options.redirectUri);
  if (!STATE_PATTERN.test(options.expectedState)) {
    throw callbackError('OAuth state is invalid.', 'OAUTH_STATE_INVALID');
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > OAUTH_LOGIN_TIMEOUT_MAX_MS
  ) {
    throw new CliError(
      `OAuth login timeout must be an integer between 1 and ${OAUTH_LOGIN_TIMEOUT_MAX_MS}.`,
      { code: 'OAUTH_LOGIN_TIMEOUT_INVALID', exitCode: 2 },
    );
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const server = createServer((request, response) => {
      const callbackUrl = new URL(request.url as string, binding.redirectUri);

      if (request.method !== 'GET' || callbackUrl.pathname !== binding.pathname) {
        writeResponse(response, 404, '<h1>Not found</h1>');
        return;
      }

      const stateValues = callbackUrl.searchParams.getAll('state');
      const codeValues = callbackUrl.searchParams.getAll('code');
      const errorValue = trimString(callbackUrl.searchParams.get('error'));
      if (
        stateValues.length !== 1 ||
        !STATE_PATTERN.test(stateValues[0] as string) ||
        !safeStateEqual(stateValues[0] as string, options.expectedState)
      ) {
        writeResponse(response, 400, '<h1>OAuth state mismatch</h1>');
        finish(callbackError('OAuth callback state did not match.', 'OAUTH_STATE_MISMATCH'));
        return;
      }

      if (errorValue) {
        const safeError = OAUTH_ERROR_PATTERN.test(errorValue)
          ? errorValue
          : 'authorization_failed';
        writeResponse(response, 400, '<h1>Authorization was not completed</h1>');
        finish(
          callbackError('OAuth authorization was not completed.', 'OAUTH_AUTHORIZATION_DENIED', {
            error: safeError,
          }),
        );
        return;
      }

      const authorizationCode = codeValues.length === 1 ? trimString(codeValues[0]) : '';
      if (!authorizationCode || authorizationCode.length > 4096) {
        writeResponse(response, 400, '<h1>Authorization code missing</h1>');
        finish(
          callbackError(
            'OAuth callback did not contain one authorization code.',
            'OAUTH_AUTHORIZATION_CODE_INVALID',
          ),
        );
        return;
      }

      writeResponse(
        response,
        200,
        '<!doctype html><meta charset="utf-8"><title>TianGong LCA CLI</title><h1>Authorization complete</h1><p>You can close this window and return to the CLI.</p>',
      );
      finish(null, authorizationCode);
    });

    const complete = (error: CliError | null, authorizationCode?: string) => {
      if (error) reject(error);
      else resolve(authorizationCode as string);
    };

    const finish = (error: CliError | null, authorizationCode?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (server.listening) {
        server.close(() => complete(error, authorizationCode));
      } else {
        complete(error, authorizationCode);
      }
    };

    server.once('error', (error) => {
      finish(
        new CliError('Could not bind the OAuth loopback callback.', {
          code: 'OAUTH_LOOPBACK_BIND_FAILED',
          exitCode: 1,
          details: error.message,
        }),
      );
    });

    server.listen(binding.port, binding.hostname, async () => {
      timer = setTimeout(() => {
        finish(callbackError('OAuth login timed out.', 'OAUTH_LOGIN_TIMEOUT'));
      }, options.timeoutMs);
      try {
        await options.onListening();
      } catch (error) {
        finish(
          error instanceof CliError
            ? error
            : new CliError('Could not start OAuth authorization.', {
                code: 'OAUTH_AUTHORIZATION_START_FAILED',
                exitCode: 1,
                details: error instanceof Error ? error.message : String(error),
              }),
        );
      }
    });
  });
}

export const __testInternals = {
  browserCommand,
  callbackError,
  safeStateEqual,
  trimString,
  writeResponse,
};
