import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthCommand } from '../src/commands/auth.js';
import { runDoctorCommand } from '../src/commands/doctor.js';
import { doctorPorts } from '../src/adapters/doctor.js';
import { buildDoctorReport, OFFICIAL_PRODUCTION_PROFILE } from '../src/lib/config/env.js';
import { describeCliRuntime } from '../src/runtime.js';
import { runAuthIdentityReceipt } from '../src/lib/auth/auth-identity-receipt.js';
import { parseAuthIdentityReceipt } from '../src/auth-identity-receipt.js';
import { executeCli } from '../src/cli.js';
import { buildSupabaseTestEnv, makeSupabaseAuthResponse } from './helpers/supabase-auth.js';
import type { CommandIO } from '../src/shared/command-result.js';
const dot = { loaded: false, path: '/unused', count: 0 };
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
const actor = '00000000-0000-4000-8000-000000000001';
const parsed = (r: CommandIO) => JSON.parse(r.stdout);
const runtime = describeCliRuntime();
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const response = (value: unknown, exitCode = 0): CommandIO => ({
  exitCode,
  stdout: JSON.stringify(value),
  stderr: '',
});

test('Auth context preserves exact identity receipts both in the envelope and standalone output', async (t) => {
  const output = path.join(directory(t), 'identity.json');
  const target = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';
  const receipt = await runAuthIdentityReceipt({
    env: { ...env, TIANGONG_LCA_API_BASE_URL: target },
    fetchImpl: async () => makeSupabaseAuthResponse({ userId: actor }),
    cliVersion: runtime.package.version,
    expectedProjectRef: 'abcdefghijklmnopqrst',
    expectedUserId: actor,
  });
  let calls = 0;
  const result = await runAuthCommand(
    [
      'identity-receipt',
      '--expected-project-ref',
      'abcdefghijklmnopqrst',
      '--expected-user-id',
      actor,
      '--output',
      output,
      '--json',
    ],
    async (args) => {
      calls++;
      assert.ok(!args.includes('--output'));
      return response(receipt);
    },
    target,
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(parseAuthIdentityReceipt(parsed(result).data.receipt), receipt);
  assert.deepEqual(parseAuthIdentityReceipt(JSON.parse(readFileSync(output, 'utf8'))), receipt);
  assert.deepEqual(parsed(result).context.actor, { id: actor, source: 'online' });
  assert.equal(parsed(result).context.environment, 'https://abcdefghijklmnopqrst.supabase.co');
  assert.ok(parsed(result).replyTemplate.endsWith('query-result.md'));
  assert.ok(!result.stdout.includes(env.TIANGONG_LCA_ACCESS_TOKEN!));
  const failedOutput = await runAuthCommand(
    ['identity-receipt', '--output', output, '--json'],
    async () => response(receipt),
    target,
  );
  assert.equal(parsed(failedOutput).status, 'partial');
  assert.deepEqual(parsed(failedOutput).data.receipt, receipt);
  assert.equal(
    (
      await runAuthCommand(
        ['identity-receipt', '--output', output, '--force', '--json'],
        async () => response(receipt),
        target,
      )
    ).exitCode,
    0,
  );
});

test('local identity observations, absent logout and loopback diagnostics retain their actual provenance', async () => {
  const status = parsed(
    await runAuthCommand(
      ['status', '--json'],
      async () => response({ status: 'ready', onlineVerified: false }),
      'https://user:secret@example.test/functions/v1?secret=hidden',
    ),
  );
  assert.equal(status.context.observation.source, 'local_session');
  assert.equal(status.context.environment, 'https://example.test');
  assert.ok(status.completeness.notChecked.includes('online_identity'));
  assert.ok(!JSON.stringify(status).includes('secret'));
  const absent = parsed(
    await runAuthCommand(['logout', '--json'], async () => response({ removed: false })),
  );
  assert.equal(absent.outcome, 'local_session_absent');
  const blocked = parsed(
    await runAuthCommand(
      ['doctor-auth', '--json'],
      async () => response({ status: 'login-required', local: {}, live: null }, 1),
      'invalid credential-bearing target',
    ),
  );
  assert.equal(blocked.context.observation.source, 'local_session');
  assert.equal(blocked.context.environment, null);
  const loopback = parsed(
    await runAuthCommand(['doctor-auth', '--json'], async () =>
      response({
        live: { origin: 'http://127.0.0.1:55000', actorId: actor, onlineVerified: true },
      }),
    ),
  );
  assert.equal(loopback.context.actor.id, actor);
  assert.equal(loopback.context.environment, 'http://127.0.0.1:55000');
  assert.equal(
    (
      await runAuthCommand(['whoami'], async () =>
        response({ projectBaseUrl: 'https://example.test' }),
      )
    ).exitCode,
    0,
  );
  assert.equal(
    (await runAuthCommand(['login', '--json'], async () => response({ status: 'authenticated' })))
      .exitCode,
    0,
  );
});

test('Auth help and invalid input stay effect-free and failures never echo unsafe diagnostics', async (t) => {
  let calls = 0;
  const execute = async () => {
    calls++;
    return { exitCode: 0, stdout: 'Existing auth help', stderr: '' };
  };
  for (const args of [[], ['--json'], ['--help'], ['login', '--help', '--json']])
    assert.equal((await runAuthCommand(args, execute)).exitCode, 0);
  calls = 0;
  for (const args of [
    ['unknown'],
    ['status', '--json', '--json'],
    ['status', '--force'],
    ['status', '--oops'],
    ['status', 'positional'],
  ])
    assert.equal((await runAuthCommand(args, execute)).exitCode, 2);
  assert.equal(calls, 0);
  for (const body of ['not JSON', 'null']) {
    const result = await runAuthCommand(['whoami', '--json'], async () => ({
      exitCode: 0,
      stdout: body,
      stderr: '',
    }));
    assert.equal(parsed(result).error.code, 'AUTH_OPERATION_FAILED');
  }
  const error = await runAuthCommand(['whoami', '--json'], async () => ({
    exitCode: 2,
    stdout: '',
    stderr: JSON.stringify({ error: { code: 'Bearer hidden-secret', message: 'hidden-secret' } }),
  }));
  assert.equal(parsed(error).error.code, 'AUTH_CHECK_FAILED');
  assert.ok(!error.stdout.includes('hidden-secret'));
  const output = path.join(directory(t), 'failure.json');
  writeFileSync(output, 'existing');
  const failedOutput = parsed(
    await runAuthCommand(['status', '--json', '--output', output], async () =>
      response({ status: 'login-required' }, 1),
    ),
  );
  assert.equal(failedOutput.status, 'failed');
  assert.equal(failedOutput.warnings[0].code, 'OUTPUT_UNAVAILABLE');
});

test('Doctor default is local, bounded, redacted and carries observed runtime identity', async (t) => {
  let online = 0;
  const ports = {
    local: () => ({
      report: buildDoctorReport({}, dot),
      conflicts: [],
      target: 'https://example.test/functions/v1',
    }),
    runtime: () => runtime,
    online: async () => {
      online++;
      return {
        environment: 'https://example.test',
        endpoint: 'https://example.test/auth/v1/health',
        httpStatus: 200,
        passed: true,
        scope: 'supabase_auth_health',
      };
    },
  };
  const output = path.join(directory(t), 'doctor.json');
  const value = parsed(await runDoctorCommand(['--json', '--output', output], ports));
  assert.equal(value.status, 'completed');
  assert.equal(online, 0);
  assert.equal(value.data.runtime.nodeVersion, process.versions.node);
  assert.ok(value.completeness.notChecked.includes('service_connections'));
  assert.equal(
    JSON.parse(readFileSync(output, 'utf8')).runtime.content_sha256,
    runtime.content_sha256,
  );
  const onlineResult = parsed(await runDoctorCommand(['--online', '--json'], ports));
  assert.equal(onlineResult.data.connection.httpStatus, 200);
  assert.equal(online, 1);
  assert.deepEqual(onlineResult.context.defaultedInputs, { timeoutMs: 5000 });
  const custom = await runDoctorCommand(['--online', '--timeout-ms', '12'], ports);
  assert.equal(custom.exitCode, 0);
  assert.match(custom.stdout, /TianGong CLI doctor/);
  assert.equal(
    parsed(await runDoctorCommand(['--json', '--output', output], ports)).status,
    'partial',
  );
  assert.equal(
    (await runDoctorCommand(['--json', '--output', output, '--force'], ports)).exitCode,
    0,
  );
});

test('Doctor failures preserve facts and never broaden a failed local configuration into an online request', async () => {
  let online = 0;
  const ports = {
    local: () => ({
      report: buildDoctorReport({}, dot),
      conflicts: [],
      target: null as string | null,
    }),
    runtime: () => runtime,
    online: async () => {
      online++;
      return {
        environment: 'example',
        endpoint: 'health',
        httpStatus: 401,
        passed: false,
        scope: 'supabase_auth_health',
      };
    },
  };
  assert.equal(parsed(await runDoctorCommand(['--online', '--json'], ports)).status, 'failed');
  const offline = {
    ...ports,
    local: () => ({
      report: buildDoctorReport(
        { TIANGONG_LCA_API_BASE_URL: '', TIANGONG_LCA_ACCESS_TOKEN: '' },
        dot,
      ),
      conflicts: ['configuration_conflict'],
      target: 'invalid',
    }),
  };
  online = 0;
  assert.equal((await runDoctorCommand(['--online'], offline)).exitCode, 1);
  assert.equal(online, 0);
  const runtimeFailure = parsed(
    await runDoctorCommand(['--json'], {
      ...ports,
      runtime: () => {
        throw new Error('private path');
      },
    }),
  );
  assert.equal(runtimeFailure.warnings[0].code, 'RUNTIME_CHECK_FAILED');
  const networkFailure = parsed(
    await runDoctorCommand(['--online', '--json'], {
      ...ports,
      online: async () => {
        throw new Error('Bearer hidden-secret');
      },
    }),
  );
  assert.equal(networkFailure.data.connection.reason, 'connection_failed_or_timed_out');
  assert.ok(!JSON.stringify(networkFailure).includes('hidden-secret'));
  for (const args of [['--help'], ['--help', '--json']])
    assert.equal((await runDoctorCommand(args, ports)).exitCode, 0);
  for (const args of [
    ['--force'],
    ['--timeout-ms', '1'],
    ['--online', '--timeout-ms', '0'],
    ['--online', '--timeout-ms', '30001'],
    ['--online', '--timeout-ms', '1.5'],
    ['--oops', '--json'],
    ['--json', '--json'],
  ])
    assert.equal((await runDoctorCommand(args, ports)).exitCode, 2);
  assert.equal(
    parsed(
      await runDoctorCommand(['--json'], {
        ...ports,
        local: () => {
          throw new Error('hidden-secret');
        },
      }),
    ).error.code,
    'DOCTOR_OPERATION_FAILED',
  );
});

test('Doctor online adapter performs only the documented public health GET with bounded cancellation', async () => {
  let requests = 0;
  const ports = doctorPorts(env, dot, async (url, init) => {
    requests++;
    assert.equal(url, 'https://example.supabase.co/auth/v1/health');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response('do not print upstream bodies');
  });
  assert.equal(ports.local().report.ok, true);
  assert.ok(ports.runtime().content_sha256);
  assert.equal((await ports.online(100)).passed, true);
  assert.equal(requests, 1);
  const bodyless = doctorPorts(env, dot, async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => '',
  }));
  assert.equal((await bodyless.online(100)).passed, true);
  const failedCancel = doctorPorts(
    env,
    dot,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return Promise.reject(new Error('cancel failure'));
          },
        }),
      ),
  );
  assert.equal((await failedCancel.online(100)).passed, true);
  assert.deepEqual(
    doctorPorts(
      { ...env, TIANGONG_LCA_OAUTH_CLIENT_ID: OFFICIAL_PRODUCTION_PROFILE.oauthClientId },
      dot,
      async () => {
        throw new Error('no fetch');
      },
    ).local().conflicts,
    ['production_profile_mismatch'],
  );
});

test('root JSON and argument separators reach the typed command contracts without hidden effects', async () => {
  const deps = {
    env,
    dotEnvStatus: dot,
    fetchImpl: async () => {
      throw new Error('unexpected network');
    },
  };
  assert.equal(parsed(await executeCli(['--json', 'auth', '--help'], deps)).command, 'auth');
  assert.equal(
    parsed(await executeCli(['--', 'auth', 'status', '--json'], deps)).data.receipt.onlineVerified,
    false,
  );
  assert.equal(
    parsed(await executeCli(['--json', 'dataset', 'flow', '--help'], deps)).command,
    'dataset flow',
  );
  assert.equal(parsed(await executeCli(['--json', 'doctor', '--help'], deps)).command, 'doctor');
  assert.equal(parsed(await executeCli(['--json'], deps)).command, 'tiangong-lca');
  assert.ok(
    parsed(await executeCli(['--help', '--json'], deps)).commands.dataset.model.includes(
      'aggregate',
    ),
  );
  assert.match(
    (await executeCli(['--help', '--', 'doctor'], deps)).stdout,
    /Unified TianGong command entrypoint/u,
  );
  assert.equal((await executeCli(['--'], deps)).exitCode, 0);
  let effects = 0;
  const guarded = {
    ...deps,
    loginWithSupabaseOAuthImpl: async () => {
      effects++;
      throw new Error('must not log in');
    },
    runDatasetClassificationApplyImpl: async () => {
      effects++;
      return { status: 'completed' } as never;
    },
  };
  assert.equal((await executeCli(['--', '--', 'auth', 'login'], guarded)).exitCode, 2);
  assert.equal(
    (await executeCli(['--', '--', 'dataset', 'classification', 'unknown'], guarded)).exitCode,
    2,
  );
  assert.equal(effects, 0);
});
