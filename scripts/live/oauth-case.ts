import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium } from 'playwright';
import { parseAuthIdentityReceipt } from '../../src/auth-identity-receipt.js';
import { runAuthIdentityReceipt } from '../../src/lib/auth/auth-identity-receipt.js';
import { OFFICIAL_PRODUCTION_PROFILE } from '../../src/lib/config/env.js';
import { requireSupabaseRestRuntime } from '../../src/lib/transport/supabase-client.js';
import {
  loginWithSupabaseOAuth,
  resolveSupabaseUserSession,
} from '../../src/lib/auth/supabase-session.js';
import {
  assertLoginOrigin,
  createPrivateCase,
  loadPrivateCredentials,
  LOGIN_ORIGIN,
  safeCaseReport,
  withCaseBrowser,
  type CaseStage,
} from './case-safety.js';

// Maintainer-only harness. Never ship this entry or credentials in the npm package.
const runFile = promisify(execFile);
let stage: CaseStage = 'inputs';
let caseId = 'unstarted';

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('LIVE_PLATFORM_NOT_QUALIFIED');
  const { values } = parseArgs({
    options: {
      'credentials-file': { type: 'string' },
      'case-dir': { type: 'string' },
      'installed-cli': { type: 'string' },
    },
    strict: true,
  });
  const credentialFile = values['credentials-file'];
  const caseDirectory = values['case-dir'];
  const installedCli = values['installed-cli'];
  if (!credentialFile || !caseDirectory || !installedCli || !isAbsolute(installedCli))
    throw new Error('LIVE_INPUTS_REQUIRED');
  const installedPackage = JSON.parse(
    readFileSync(join(dirname(installedCli), '..', 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  if (installedPackage.name !== '@tiangong-lca/cli' || installedPackage.version !== '0.1.8')
    throw new Error('LIVE_INSTALLED_CLI_MISMATCH');
  const credentials = loadPrivateCredentials(credentialFile);
  const context = createPrivateCase(caseDirectory);
  caseId = context.caseId;
  const authEnv = {
    TIANGONG_LCA_AUTH_MODE: 'oauth',
    TIANGONG_LCA_SESSION_FILE: context.sessionFile,
  };
  const runtime = requireSupabaseRestRuntime(authEnv);
  const project = new URL(OFFICIAL_PRODUCTION_PROFILE.apiBaseUrl).hostname.split('.')[0];
  const cleanEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: context.directory,
    TMPDIR: context.directory,
    TEMP: context.directory,
    SystemRoot: process.env.SystemRoot,
    ...authEnv,
  };
  stage = 'browser-login';
  const browser = await chromium.launch({ headless: true, env: cleanEnv });
  // No tracing, HAR, video, screenshots, saved browser storage, or response logging.
  await withCaseBrowser(browser, async (browserContext) => {
    const page = await browserContext.newPage();
    page.setDefaultTimeout(45_000);
    // Abort navigation off the reviewed auth, login and loopback origins.
    const allowedOrigins = new Set([
      LOGIN_ORIGIN,
      new URL(runtime.apiBaseUrl).origin,
      new URL(runtime.oauthRedirectUri as string).origin,
    ]);
    await browserContext.route('**/*', async (route) => {
      if (
        route.request().isNavigationRequest() &&
        !allowedOrigins.has(new URL(route.request().url()).origin)
      ) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await loginWithSupabaseOAuth({
      runtime,
      fetchImpl: fetch,
      requestTimeoutMs: 30_000,
      loginTimeoutMs: 120_000,
      openBrowserImpl: async (authorizationUrl) => {
        if (new URL(authorizationUrl).origin !== new URL(runtime.apiBaseUrl).origin)
          throw new Error('LIVE_AUTH_ORIGIN_REJECTED');
        await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('docs-capture-login-email').waitFor();
        assertLoginOrigin(page.url());
        await page.getByTestId('docs-capture-login-email').fill(credentials.username);
        assertLoginOrigin(page.url());
        await page.getByTestId('docs-capture-login-password').fill(credentials.password);
        assertLoginOrigin(page.url());
        await page.getByTestId('docs-capture-login-submit').click();
        const allow = page.getByRole('button', { name: 'Allow connection', exact: true });
        await allow.waitFor();
        assertLoginOrigin(page.url());
        await allow.click();
      },
    });
  });
  stage = 'source-identity';
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: fetch,
    timeoutMs: 30_000,
  });
  if (session.userEmail.toLowerCase() !== credentials.username.toLowerCase())
    throw new Error('LIVE_ACCOUNT_MISMATCH');
  const cliPackage = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const source = await runAuthIdentityReceipt({
    env: authEnv,
    fetchImpl: fetch,
    cliVersion: cliPackage.version,
    expectedProjectRef: project,
    timeoutMs: 30_000,
  });
  writeFileSync(
    join(context.directory, 'source-identity.json'),
    JSON.stringify(source, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  stage = 'installed-identity';
  const { stdout } = await runFile(
    process.execPath,
    [
      installedCli,
      'auth',
      'identity-receipt',
      '--expected-project-ref',
      project,
      '--expected-user-id',
      source.identity.user_id,
    ],
    { cwd: context.directory, env: cleanEnv, timeout: 60_000, maxBuffer: 128 * 1024 },
  );
  const installed = parseAuthIdentityReceipt(JSON.parse(stdout));
  if (
    installed.cli.package_version !== installedPackage.version ||
    installed.identity.user_id !== source.identity.user_id ||
    installed.assertions.mode !== 'intent-bound'
  )
    throw new Error('LIVE_INSTALLED_IDENTITY_MISMATCH');
  writeFileSync(
    join(context.directory, 'installed-identity.json'),
    JSON.stringify(installed, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  stage = 'complete';
  const report = safeCaseReport({ caseId, stage, status: 'passed' });
  writeFileSync(join(context.directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(report) + '\n');
}

main().catch(() => {
  // Exceptions may contain URLs, PKCE state, account values, or subprocess output.
  process.stderr.write(JSON.stringify(safeCaseReport({ caseId, stage, status: 'failed' })) + '\n');
  process.exitCode = 1;
});
