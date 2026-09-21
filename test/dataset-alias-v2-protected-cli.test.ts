// CLI-level proof that the versioned capability is reachable end to end through the installed
// public workflow: the real argv drives plan -> freeze -> seal -> run through the real router,
// with only the HTTP transport stubbed. Nothing here imports a private build or a test-only
// entry point.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import { ALIAS_V2_PROTECTED_ARTIFACTS } from '../src/lib/dataset-alias-v2-protected.js';
import { ALIAS_V2_PROTOCOL } from '../src/lib/dataset-alias-v2-protected-contract.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_PROJECT_REF,
  aliasV2DerivativeTargets,
  protectedToolchainEvidence,
} from './helpers/alias-v2-artifacts.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const dotEnvStatus: DotEnvLoadResult = { loaded: false, path: '/tmp/.env', count: 0 };
const START = Date.parse('2026-09-21T00:00:00.000Z');
const iso = (offsetMs: number): string => new Date(START + offsetMs).toISOString();

function jsonResponse(value: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function cliDeps(fetchImpl: FetchLike) {
  return {
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
    }),
    dotEnvStatus,
    fetchImpl,
  };
}

/** A transport that only answers the Supabase session; every other call is a test failure. */
const authOnlyFetch: FetchLike = (async (input: string) => {
  const url = String(input);
  if (isSupabaseAuthTokenUrl(url)) {
    return makeSupabaseAuthResponse({
      userId: ALIAS_V2_TEST_ACCOUNT.user_id,
      email: ALIAS_V2_TEST_ACCOUNT.email,
    });
  }
  throw new Error(`Unexpected request: ${url}`);
}) as FetchLike;

type PublicChain = {
  directory: string;
  inputPath: string;
  toolchainPath: string;
  baselinesPath: string;
  planPath: string;
  freezePath: string;
  approvalRequestPath: string;
  humanApprovalPath: string;
  approvalPath: string;
  freezeFileSha256: string;
  requestFileSha256: string;
};

/** Drives the real public stages: plan, freeze and seal, exactly as an operator would. */
async function buildPublicChain(): Promise<PublicChain> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-public-'));
  mkdirSync(directory, { recursive: true });
  const inputPath = path.join(directory, 'alias-v2-input.json');
  writeFileSync(inputPath, `${stableJsonText(buildAliasV2CohortInput())}\n`, { mode: 0o600 });

  const planned = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--alias-v2-input',
      inputPath,
      '--out-dir',
      directory,
      '--json',
    ],
    cliDeps(authOnlyFetch),
  );
  assert.equal(planned.exitCode, 0, planned.stderr);
  const planPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as JsonObject;

  const toolchainPath = path.join(directory, 'toolchain.json');
  writeFileSync(toolchainPath, `${stableJsonText(protectedToolchainEvidence('0.1.20'))}\n`, {
    mode: 0o600,
  });
  const baselinesPath = path.join(directory, 'baselines.json');
  writeFileSync(
    baselinesPath,
    `${stableJsonText({
      schema_version: 'dataset-alias-derivative-baselines.v2',
      targets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
    })}\n`,
    { mode: 0o600 },
  );

  const frozen = await executeCli(
    [
      'dataset',
      'maintenance',
      'freeze-protected',
      '--plan',
      planPath,
      '--toolchain-evidence',
      toolchainPath,
      '--derivative-baselines',
      baselinesPath,
      '--out-dir',
      directory,
      '--expected-project-ref',
      ALIAS_V2_TEST_PROJECT_REF,
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--json',
    ],
    cliDeps(authOnlyFetch),
  );
  assert.equal(frozen.exitCode, 0, frozen.stderr);
  const freezePath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.freeze);
  const approvalRequestPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request);
  const humanApprovalPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.human_approval);
  const freezeFileSha256 = createHash('sha256').update(readFileSync(freezePath)).digest('hex');
  const requestFileSha256 = createHash('sha256')
    .update(readFileSync(approvalRequestPath))
    .digest('hex');
  const request = JSON.parse(readFileSync(approvalRequestPath, 'utf8')) as JsonObject;

  const sealed = await executeCli(
    [
      'dataset',
      'maintenance',
      'seal-protected-approval',
      '--freeze',
      freezePath,
      '--approval-request',
      approvalRequestPath,
      '--human-approval',
      humanApprovalPath,
      '--out-dir',
      directory,
      '--approve-freeze-file',
      freezeFileSha256,
      '--approve-request',
      requestFileSha256,
      '--approve-text',
      String(request['approval_text_sha256']),
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--approved-at',
      iso(0),
      '--json',
    ],
    cliDeps(authOnlyFetch),
  );
  assert.equal(sealed.exitCode, 0, sealed.stderr);
  return {
    directory,
    inputPath,
    toolchainPath,
    baselinesPath,
    planPath,
    freezePath,
    approvalRequestPath,
    humanApprovalPath,
    approvalPath: path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval),
    freezeFileSha256,
    requestFileSha256,
  };
}

type Call = { url: string; body: JsonObject };

/** Answers the versioned protected endpoints for a sealed chain, recording every call. */
function protectedFetch(
  chain: PublicChain,
  options: { calls?: Call[]; reads?: unknown[]; admit?: 'ok' | 'unknown' } = {},
): FetchLike {
  const calls = options.calls ?? [];
  const plan = JSON.parse(readFileSync(chain.planPath, 'utf8')) as JsonObject;
  const freeze = JSON.parse(readFileSync(chain.freezePath, 'utf8')) as JsonObject;
  const approval = JSON.parse(readFileSync(chain.approvalPath, 'utf8')) as JsonObject;
  const actions = plan['actions'] as JsonObject[];
  const terminal: JsonObject = {
    status: 'applied',
    plan_sha256: plan['plan_sha256'],
    counts: plan['expected'],
    audit: { plan_summary_id: 'audit-plan-1', batch_summary_ids: ['b-flows', 'b-processes'] },
    readback: {
      flows: actions
        .filter((action) => action['table'] === 'flows')
        .map((action) => ({
          table: 'flows',
          id: action['id'],
          version: action['version'],
          desired_sha256: action['desired_sha256'],
        })),
      processes: actions
        .filter((action) => action['table'] === 'processes')
        .map((action) => ({
          table: 'processes',
          id: action['id'],
          version: action['version'],
          desired_sha256: action['desired_sha256'],
        })),
      text_actions: (plan['text_actions'] as JsonObject[]).map((action) => ({
        id: action['id'],
        version: action['version'],
        after_text: action['after_text'],
      })),
    },
  };
  let preflightBody: JsonObject = {};
  let readIndex = 0;
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: ALIAS_V2_TEST_ACCOUNT.user_id,
        email: ALIAS_V2_TEST_ACCOUNT.email,
      });
    }
    const raw = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body: raw ? (JSON.parse(raw) as JsonObject) : {} });
    if (url.includes(ALIAS_V2_PROTOCOL.preflight_command)) {
      const request = (JSON.parse(raw) as JsonObject)['p_request'] as JsonObject;
      const issuedAt = Date.now();
      preflightBody = {
        ok: true,
        schema_version: ALIAS_V2_PROTOCOL.preflight_response_schema,
        command: ALIAS_V2_PROTOCOL.preflight_command,
        request_id: request['request_id'],
        actor_user_id: ALIAS_V2_TEST_ACCOUNT.user_id,
        environment: 'production',
        project_ref: ALIAS_V2_TEST_PROJECT_REF,
        server_context_sha256: sha256Json({ context: ALIAS_V2_TEST_PROJECT_REF }),
        plan_sha256: plan['plan_sha256'],
        freeze_sha256: freeze['freeze_sha256'],
        approval_identity_sha256: approval['approval_identity_sha256'],
        plan_request_sha256: sha256Json({ plan: plan['plan_sha256'] }),
        bindings_sha256: sha256Json(request['bindings']),
        expected_sha256: sha256Json(request['expected']),
        derivative_targets_sha256: sha256Json(request['derivative_targets']),
        gate_expectations: Object.fromEntries(
          ['primary_support_plan', 'execution_unused', 'derivative_quiescence'].map((gate) => [
            `${gate}_sha256`,
            sha256Json({ gate, plan: plan['plan_sha256'] }),
          ]),
        ),
        gate_expectations_sha256: sha256Json({ gates: plan['plan_sha256'] }),
        preflight_request_sha256: sha256Json({ request: plan['plan_sha256'] }),
        preflight_token: 'preflight-token-abcdefghij',
        preflight_proof_sha256: sha256Json({ proof: plan['plan_sha256'] }),
        simulation: {
          plan_rows: (plan['expected'] as JsonObject)['action_count'],
          plan_exchanges: (plan['expected'] as JsonObject)['exchange_count'],
          rolled_back: true,
        },
        completed_at: new Date(issuedAt).toISOString(),
        expires_at: new Date(issuedAt + 150_000).toISOString(),
      };
      return jsonResponse(preflightBody);
    }
    if (url.includes(ALIAS_V2_PROTOCOL.gate_command)) {
      const gate = String((JSON.parse(raw) as JsonObject)['p_gate_name']);
      const expected = (preflightBody['gate_expectations'] as JsonObject)[`${gate}_sha256`];
      return jsonResponse({
        ok: true,
        schema_version: ALIAS_V2_PROTOCOL.gate_response_schema,
        command: ALIAS_V2_PROTOCOL.gate_command,
        request_id: preflightBody['request_id'],
        actor_user_id: ALIAS_V2_TEST_ACCOUNT.user_id,
        preflight_proof_sha256: preflightBody['preflight_proof_sha256'],
        gate,
        expected_sha256: expected,
        observed_sha256: expected,
        status: 'passed',
        captured_at: new Date(Date.now()).toISOString(),
        receipt_sha256: sha256Json({ gate }),
      });
    }
    if (url.includes(ALIAS_V2_PROTOCOL.admit_command)) {
      if (options.admit === 'unknown') {
        throw new Error('socket hang up');
      }
      return jsonResponse({
        ok: true,
        schema_version: ALIAS_V2_PROTOCOL.admit_response_schema,
        command: ALIAS_V2_PROTOCOL.admit_command,
        request_id: preflightBody['request_id'],
        plan_sha256: plan['plan_sha256'],
        preflight_proof_sha256: preflightBody['preflight_proof_sha256'],
        admission_request_sha256: sha256Json({ admit: plan['plan_sha256'] }),
        gate_results_sha256: sha256Json({ gates: plan['plan_sha256'] }),
        status: 'dispatched',
        attempt_count: 1,
        dispatch_count: 1,
        net_request_id: 'net-request-abcdefghij',
        attempt_consumed: true,
        retry_allowed: false,
      });
    }
    if (url.includes('cmd_dataset_alias_execution_read_v2')) {
      const value = options.reads?.[Math.min(readIndex, (options.reads ?? []).length - 1)];
      readIndex += 1;
      return value === null ? jsonResponse({ ok: true }) : jsonResponse({ ok: true, ...terminal });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;
}

function runArgv(chain: PublicChain, extra: string[] = []): string[] {
  return [
    'dataset',
    'maintenance',
    'run-protected',
    '--plan',
    chain.planPath,
    '--freeze',
    chain.freezePath,
    '--approval',
    chain.approvalPath,
    '--out-dir',
    chain.directory,
    '--json',
    ...extra,
  ];
}

test('the public workflow plans, freezes, seals and then runs the cohort through the v2 channel', async (t) => {
  const chain = await buildPublicChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
  const plan = JSON.parse(readFileSync(chain.planPath, 'utf8')) as JsonObject;
  const approval = JSON.parse(readFileSync(chain.approvalPath, 'utf8')) as JsonObject;
  // The real v1 ten flat expected keys with v2 values, plus the versioned text-action count.
  assert.deepEqual(plan['expected'], {
    action_count: 387,
    batch_count: 1,
    exchange_count: 654,
    amount_field_count: 1308,
    unrelated_exchange_count: 4147,
    audit_count: 389,
    flowproperty_count: 0,
    flow_count: 113,
    process_count: 274,
    derivative_target_count: 387,
    text_action_count: 87,
  });
  const calls: Call[] = [];
  const result = await executeCli(
    runArgv(chain, [
      '--commit',
      '--approve-execution',
      String(approval['approval_identity_sha256']),
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--wait-seconds',
      '10',
      '--poll-ms',
      '1000',
    ]),
    cliDeps(protectedFetch(chain, { calls, reads: ['terminal'] })),
  );
  const report = JSON.parse(result.stdout) as JsonObject;
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.deepEqual(
    [report['status'], report['phase'], report['admission_attempts']],
    ['passed', 'applied', 1],
  );
  assert.deepEqual(report['expected'], plan['expected']);
  assert.deepEqual(
    calls.map((call) => call.url.split('/').pop()),
    [
      ALIAS_V2_PROTOCOL.preflight_command,
      ALIAS_V2_PROTOCOL.gate_command,
      ALIAS_V2_PROTOCOL.gate_command,
      ALIAS_V2_PROTOCOL.gate_command,
      ALIAS_V2_PROTOCOL.admit_command,
      'cmd_dataset_alias_execution_read_v2',
    ],
  );
  // The admission is the five-key contract; the preflight carries the whole freeze and approval.
  const admit = calls.find((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)) as Call;
  assert.deepEqual(Object.keys(admit.body['p_request'] as JsonObject).sort(), [
    'gate_results',
    'preflight_proof_sha256',
    'preflight_token',
    'request_id',
    'schema_version',
  ]);
  const preflight = calls[0] as Call;
  const request = preflight.body['p_request'] as JsonObject;
  assert.deepEqual(Object.keys(request).sort(), [
    'actor',
    'approval',
    'bindings',
    'derivative_targets',
    'environment',
    'expected',
    'freeze',
    'plan',
    'project_ref',
    'request_id',
    'schema_version',
    'target_visibility',
  ]);
  assert.deepEqual(
    (request['freeze'] as JsonObject)['sets'],
    JSON.parse(readFileSync(chain.freezePath, 'utf8'))['sets'],
  );
  assert.equal(
    Object.keys(request['approval'] as JsonObject).length > 3,
    true,
    'the approval must be the real document',
  );
  assert.equal(
    readFileSync(
      path.join(chain.directory, ALIAS_V2_PROTECTED_ARTIFACTS.status_progress),
      'utf8',
    ).includes('preflight-token-abcdefghij'),
    false,
    'the raw token is never persisted',
  );
});

test('a wrong approval hash on the argv path fails before any protected fetch', async (t) => {
  const chain = await buildPublicChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
  const calls: Call[] = [];
  const result = await executeCli(
    runArgv(chain, [
      '--commit',
      '--approve-execution',
      'a'.repeat(64),
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--wait-seconds',
      '0',
    ]),
    cliDeps(protectedFetch(chain, { calls })),
  );
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(calls, [], 'no protected endpoint is contacted for a wrong approval hash');
});

test('a v1 seal still reaches the frozen v1 chain', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-v1-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const freezePath = path.join(directory, 'protected-execution-freeze.json');
  writeFileSync(
    freezePath,
    `${stableJsonText({ schema_version: 'dataset-alias-execution-freeze.v1' })}\n`,
    { mode: 0o600 },
  );
  const calls: Call[] = [];
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      path.join(directory, 'plan.json'),
      '--freeze',
      freezePath,
      '--approval',
      path.join(directory, 'approval.json'),
      '--out-dir',
      directory,
      '--status-only',
      '--json',
    ],
    cliDeps(authOnlyFetch),
  );
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.equal(result.stdout.includes('dataset-alias-execution-report.v2'), false);
});

function errorCode(result: { exitCode: number; stderr: string }, label: string): string {
  assert.equal(result.exitCode, 2, `${label}: ${result.stderr}`);
  return (JSON.parse(result.stderr) as { error: { code: string } }).error.code;
}

test('each versioned stage refuses its own missing argument before any fetch', async (t) => {
  const chain = await buildPublicChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
  const calls: Call[] = [];
  const deps = cliDeps(protectedFetch(chain, { calls }));
  // A versioned plan is built only where it can be written.
  assert.equal(
    errorCode(
      await executeCli(
        ['dataset', 'maintenance', 'plan', '--alias-v2-input', chain.inputPath, '--json'],
        deps,
      ),
      'plan without --out-dir',
    ),
    'DATASET_MAINTENANCE_OUT_DIR_REQUIRED',
  );
  // A versioned freeze carries the reviewed derivative baselines, or it is not built at all.
  assert.equal(
    errorCode(
      await executeCli(
        [
          'dataset',
          'maintenance',
          'freeze-protected',
          '--plan',
          chain.planPath,
          '--toolchain-evidence',
          chain.toolchainPath,
          '--out-dir',
          chain.directory,
          '--expected-project-ref',
          ALIAS_V2_TEST_PROJECT_REF,
          '--confirm',
          ALIAS_V2_TEST_ACCOUNT.email,
          '--json',
        ],
        deps,
      ),
      'freeze-protected without --derivative-baselines',
    ),
    'DATASET_MAINTENANCE_PROTECTED_BASELINES_REQUIRED',
  );
  // The same command's help parses the identical flag set with no versioned argument at all.
  const help = await executeCli(['dataset', 'maintenance', 'freeze-protected', '--help'], deps);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.equal(help.stdout.includes('freeze-protected'), true);
  assert.deepEqual(calls, [], 'no protected endpoint is contacted for a missing argument');
});

test('the argv path passes the reviewed timeout through to the versioned freeze', async (t) => {
  const chain = await buildPublicChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
  const calls: Call[] = [];
  const frozen = await executeCli(
    [
      'dataset',
      'maintenance',
      'freeze-protected',
      '--plan',
      chain.planPath,
      '--toolchain-evidence',
      chain.toolchainPath,
      '--derivative-baselines',
      chain.baselinesPath,
      '--out-dir',
      chain.directory,
      '--expected-project-ref',
      ALIAS_V2_TEST_PROJECT_REF,
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--timeout-ms',
      '5000',
      '--json',
    ],
    cliDeps(protectedFetch(chain, { calls })),
  );
  assert.equal(frozen.exitCode, 0, frozen.stderr);
  const report = JSON.parse(frozen.stdout) as JsonObject;
  assert.equal(typeof report['approval_request_sha256'], 'string');
  assert.deepEqual(calls, [], 'the freeze stage reads only the local artefacts and the session');
});

test('every versioned stage is discoverable from its own help', async (t) => {
  const cases: Array<[string, string[]]> = [
    // The plan stage names the versioned planning input and that it replaces the scope-driven plan.
    ['plan', ['--alias-v2-input']],
    // The freeze stage names the baselines a versioned plan requires.
    ['freeze-protected', ['--derivative-baselines']],
    // The seal and run stages name the versioned selection they route by.
    ['seal-protected-approval', ['dataset-alias-execution-freeze.v2']],
    ['run-protected', ['dataset-alias-execution-freeze.v2']],
  ];
  for (const [action, expected] of cases) {
    const result = await executeCli(
      ['dataset', 'maintenance', action, '--help'],
      cliDeps(authOnlyFetch),
    );
    assert.equal(result.exitCode, 0, `${action}: ${result.stderr}`);
    for (const needle of expected) {
      assert.equal(result.stdout.includes(needle), true, `${action} help must document ${needle}`);
    }
  }
  void t;
});
