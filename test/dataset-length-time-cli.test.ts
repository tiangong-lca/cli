// CLI-level proof that the Length*time profile is reachable through the installed public workflow:
// the real argv drives plan -> freeze -> seal -> run through the real router, with only the HTTP
// transport stubbed. Nothing here imports a private build or a test-only entry point.

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
import {
  ALIAS_V2_PROTOCOL,
  buildAliasV2ExecutionIdentity,
} from '../src/lib/dataset-alias-v2-protected-contract.js';
import { parseAliasV2Approval, parseAliasV2Freeze } from '../src/lib/dataset-alias-v2-protected.js';
import {
  LENGTH_TIME_PLAN_SCHEMA,
  buildLengthTimePlan,
  type LengthTimePlanInput,
} from '../src/lib/dataset-length-time-plan.js';
import { LENGTH_TIME_PROTECTED_ARTIFACTS } from '../src/lib/dataset-length-time-public.js';
import { aliasV2StatusEnvelope } from './helpers/alias-v2-status.js';
import { buildLengthTimePlanInput } from './fixtures/length-time-cohort.js';
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
// The protected run reads the real clock: the preflight window it accepts is anchored to the
// moment this invocation actually started, not to a fixed fixture date.
const START = Date.now();
const iso = (offsetMs: number): string => new Date(START + offsetMs).toISOString();

function jsonResponse(value: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
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

type LengthChain = {
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

function canonical(value: unknown): string {
  return `${stableJsonText(value)}\n`;
}

/** Drives the real public stages for the Length profile: plan, freeze and seal. */
async function buildLengthChain(): Promise<LengthChain> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'length-time-public-'));
  mkdirSync(directory, { recursive: true });
  const inputPath = path.join(directory, 'length-time-input.json');
  writeFileSync(inputPath, canonical(buildLengthTimePlanInput()), { mode: 0o600 });

  const planned = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--length-time-input',
      inputPath,
      '--out-dir',
      directory,
      '--json',
    ],
    cliDeps(authOnlyFetch),
  );
  assert.equal(planned.exitCode, 0, planned.stderr);
  const planPath = path.join(directory, LENGTH_TIME_PROTECTED_ARTIFACTS.plan_file);
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as JsonObject;
  assert.equal(plan['schema_version'], LENGTH_TIME_PLAN_SCHEMA);
  // The plan the command wrote is byte-identical to the builder's own document, and it is the
  // canonical serialisation of its content.
  assert.equal(readFileSync(planPath, 'utf8'), canonical(plan));
  assert.equal(
    plan['plan_sha256'],
    buildLengthTimePlan(buildLengthTimePlanInput() as unknown as LengthTimePlanInput).plan[
      'plan_sha256'
    ],
  );

  const toolchainPath = path.join(directory, 'toolchain.json');
  writeFileSync(toolchainPath, canonical(protectedToolchainEvidence('0.1.21')), { mode: 0o600 });
  const baselinesPath = path.join(directory, 'baselines.json');
  writeFileSync(
    baselinesPath,
    canonical({
      schema_version: 'dataset-alias-derivative-baselines.v2',
      targets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
    }),
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
  const freezeFileSha256 = sha256OfText(readFileSync(freezePath, 'utf8'));
  const requestFileSha256 = sha256OfText(readFileSync(approvalRequestPath, 'utf8'));
  const request = JSON.parse(readFileSync(approvalRequestPath, 'utf8')) as {
    approved_at_utc: string;
  };

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
      sha256OfText(readFileSync(humanApprovalPath, 'utf8')),
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--approved-at',
      // The seal reuses the timestamp this request designated, never an operator-chosen instant.
      request.approved_at_utc,
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

function sha256OfText(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function errorCode(result: { exitCode: number; stderr: string }): string {
  // The router reports a coded failure as one JSON envelope (with --json) or as `CODE: message`.
  try {
    const parsed = JSON.parse(result.stderr) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === 'string') {
      return parsed.error.code;
    }
  } catch {
    // fall through to the plain spelling
  }
  const match = /^([A-Z0-9_]+):/u.exec(result.stderr);
  return match?.[1] ?? result.stderr;
}

test('the Length plan, freeze and seal stages run through the real argv', async (t) => {
  const chain = await buildLengthChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));

  const plan = JSON.parse(readFileSync(chain.planPath, 'utf8')) as JsonObject;
  const freeze = parseAliasV2Freeze(JSON.parse(readFileSync(chain.freezePath, 'utf8')) as unknown);
  assert.deepEqual(freeze.target_snapshots, {
    flowproperty: plan['target_flow_property'],
    unitgroup: plan['target_unit_group'],
  });
  assert.deepEqual(freeze.expected, plan['expected']);
  assert.equal(freeze.plan.plan_file_sha256, sha256OfText(readFileSync(chain.planPath, 'utf8')));
  assert.equal(freeze.derivative_targets.length, 13);

  const request = JSON.parse(readFileSync(chain.approvalRequestPath, 'utf8')) as JsonObject;
  assert.match(request['approval_text'] as string, /^Approved Length\*time plan /u);
  // The human approval file is the same words, byte for byte: the operator approves exactly these.
  assert.equal(readFileSync(chain.humanApprovalPath, 'utf8'), request['approval_text']);

  const approval = parseAliasV2Approval(
    JSON.parse(readFileSync(chain.approvalPath, 'utf8')) as unknown,
  );
  const identity = buildAliasV2ExecutionIdentity({
    freeze,
    approval,
    freezeFileSha256: chain.freezeFileSha256,
    approvalFileSha256: sha256OfText(readFileSync(chain.approvalPath, 'utf8')),
  });
  assert.equal(identity.plan_sha256, plan['plan_sha256']);
  assert.equal(identity.expected['exchange_count'], 39);
});

test('each Length stage refuses its own missing argument before any fetch', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'length-time-args-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.json');
  writeFileSync(inputPath, canonical(buildLengthTimePlanInput()), { mode: 0o600 });
  const calls: string[] = [];
  const deps = cliDeps((async (input: string) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: ALIAS_V2_TEST_ACCOUNT.user_id,
        email: ALIAS_V2_TEST_ACCOUNT.email,
      });
    }
    calls.push(url);
    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike);

  assert.equal(
    errorCode(
      await executeCli(
        ['dataset', 'maintenance', 'plan', '--length-time-input', inputPath, '--json'],
        deps,
      ),
    ),
    'DATASET_MAINTENANCE_OUT_DIR_REQUIRED',
  );
  // The reviewed planning input is required to exist and to be the reviewed document.
  assert.equal(
    errorCode(
      await executeCli(
        [
          'dataset',
          'maintenance',
          'plan',
          '--length-time-input',
          path.join(directory, 'missing.json'),
          '--out-dir',
          directory,
          '--json',
        ],
        deps,
      ),
    ),
    // A planning input that is not there is an unreadable-file failure of the shared reader, the
    // same way the Time plan stage reports it; nothing invents a plan from a missing document.
    'UNEXPECTED_ERROR',
  );
  assert.deepEqual(calls, [], 'no protected endpoint is contacted for a missing argument');
});

test('a planning input that is not an object is refused before any artefact is written', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'length-time-shape-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [label, text] of [
    ['an array', `${stableJsonText([1, 2, 3])}\n`],
    ['a string', `"not a planning input"\n`],
    ['a number', `7\n`],
    ['null', `null\n`],
  ] as const) {
    const inputPath = path.join(directory, `input-${label.replace(/ /g, '-')}.json`);
    writeFileSync(inputPath, text, { mode: 0o600 });
    const result = await executeCli(
      [
        'dataset',
        'maintenance',
        'plan',
        '--length-time-input',
        inputPath,
        '--out-dir',
        directory,
        '--json',
      ],
      cliDeps(authOnlyFetch),
    );
    assert.equal(result.exitCode, 2, label);
    assert.equal(errorCode(result), 'LENGTH_TIME_PUBLIC_ARTIFACT_INVALID', label);
  }
});

test('the Length help documents its own versioned input', async () => {
  const help = await executeCli(
    ['dataset', 'maintenance', 'plan', '--help'],
    cliDeps(authOnlyFetch),
  );
  assert.equal(help.exitCode, 0, help.stderr);
  assert.equal(help.stdout.includes('--length-time-input'), true);
  assert.equal(help.stdout.includes('dataset-length-time-plan.v1'), true);
  assert.equal(help.stdout.includes('--alias-v2-input'), true);
});

test('a Length plan without its frozen derivative baselines is refused', async (t) => {
  const chain = await buildLengthChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
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
          path.join(chain.directory, 'second'),
          '--expected-project-ref',
          ALIAS_V2_TEST_PROJECT_REF,
          '--confirm',
          ALIAS_V2_TEST_ACCOUNT.email,
          '--json',
        ],
        cliDeps(authOnlyFetch),
      ),
    ),
    'DATASET_MAINTENANCE_PROTECTED_BASELINES_REQUIRED',
  );
});

test('a sealed Length execution runs and passes through the real run-protected command', async (t) => {
  const chain = await buildLengthChain();
  t.after(() => rmSync(chain.directory, { recursive: true, force: true }));
  const freeze = parseAliasV2Freeze(JSON.parse(readFileSync(chain.freezePath, 'utf8')) as unknown);
  const approval = parseAliasV2Approval(
    JSON.parse(readFileSync(chain.approvalPath, 'utf8')) as unknown,
  );
  const identity = buildAliasV2ExecutionIdentity({
    freeze,
    approval,
    freezeFileSha256: chain.freezeFileSha256,
    approvalFileSha256: sha256OfText(readFileSync(chain.approvalPath, 'utf8')),
  });
  const plan = JSON.parse(readFileSync(chain.planPath, 'utf8')) as JsonObject;
  const preflight = {
    ok: true,
    schema_version: ALIAS_V2_PROTOCOL.preflight_response_schema,
    command: ALIAS_V2_PROTOCOL.preflight_command,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    environment: 'production',
    project_ref: identity.project_ref,
    server_context_sha256: 'a'.repeat(64),
    plan_sha256: identity.plan_sha256,
    freeze_sha256: freeze.freeze_sha256,
    approval_identity_sha256: approval.approval_identity_sha256,
    plan_request_sha256: 'b'.repeat(64),
    bindings_sha256: 'c'.repeat(64),
    expected_sha256: 'd'.repeat(64),
    derivative_targets_sha256: 'e'.repeat(64),
    gate_expectations: Object.fromEntries(
      ['primary_support_plan', 'execution_unused', 'derivative_quiescence'].map((gate) => [
        `${gate}_sha256`,
        sha256Json({ gate, plan: identity.plan_sha256 }),
      ]),
    ),
    gate_expectations_sha256: sha256Json({ gates: identity.plan_sha256 }),
    preflight_request_sha256: sha256Json({ request: identity.plan_sha256 }),
    preflight_token: 'preflight-token-abcdefghij',
    // The digests the read envelope will report back must be the ones this run observed itself.
    preflight_proof_sha256: sha256Json({ preflight: identity.request_id }),
    simulation: {
      plan_rows: 13,
      plan_exchanges: 39,
      rolled_back: true,
    },
    completed_at: iso(0),
    expires_at: iso(150_000),
  };
  const calls: { url: string; body: JsonObject }[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: ALIAS_V2_TEST_ACCOUNT.user_id,
        email: ALIAS_V2_TEST_ACCOUNT.email,
      });
    }
    calls.push({ url, body: raw ? (JSON.parse(raw) as JsonObject) : {} });
    if (url.includes(ALIAS_V2_PROTOCOL.preflight_command)) {
      return jsonResponse(preflight);
    }
    if (url.includes(ALIAS_V2_PROTOCOL.gate_command)) {
      const body = JSON.parse(raw) as JsonObject;
      const gate = String(body['p_gate_name']);
      const expected = (preflight.gate_expectations as JsonObject)[`${gate}_sha256`];
      return jsonResponse({
        ok: true,
        schema_version: ALIAS_V2_PROTOCOL.gate_response_schema,
        command: ALIAS_V2_PROTOCOL.gate_command,
        request_id: identity.request_id,
        actor_user_id: identity.actor.user_id,
        preflight_proof_sha256: preflight.preflight_proof_sha256,
        gate,
        expected_sha256: expected,
        observed_sha256: expected,
        status: 'passed',
        captured_at: iso(10_000),
        receipt_sha256: sha256Json({ gate }),
      });
    }
    if (url.includes(ALIAS_V2_PROTOCOL.admit_command)) {
      return jsonResponse({
        ok: true,
        schema_version: ALIAS_V2_PROTOCOL.admit_response_schema,
        command: ALIAS_V2_PROTOCOL.admit_command,
        request_id: identity.request_id,
        plan_sha256: identity.plan_sha256,
        preflight_proof_sha256: preflight.preflight_proof_sha256,
        admission_request_sha256: sha256Json({ admit: identity.request_id }),
        gate_results_sha256: sha256Json({ gates: identity.request_id }),
        status: 'dispatched',
        attempt_count: 1,
        dispatch_count: 1,
        net_request_id: '50018',
        attempt_consumed: true,
        retry_allowed: false,
      });
    }
    if (url.includes('cmd_dataset_alias_execution_read_v2')) {
      return jsonResponse({ ok: true, ...aliasV2StatusEnvelope({ plan, identity }) });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;

  const outDir = path.join(chain.directory, 'run');
  const run = await executeCli(
    [
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
      outDir,
      '--commit',
      '--approve-execution',
      approval.approval_identity_sha256,
      '--confirm',
      ALIAS_V2_TEST_ACCOUNT.email,
      '--json',
    ],
    cliDeps(fetchImpl),
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const report = JSON.parse(run.stdout) as JsonObject;
  assert.equal(report['status'], 'passed');
  assert.equal(report['plan_sha256'], plan['plan_sha256']);
  assert.deepEqual(report['expected'], plan['expected']);
  assert.equal(
    calls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)).length,
    1,
  );
  // The plan the server was asked to execute is the Length document itself.
  const preflightCall = calls.find((call) =>
    call.url.includes(ALIAS_V2_PROTOCOL.preflight_command),
  );
  assert.equal(
    ((preflightCall?.body['p_request'] as JsonObject)['plan'] as JsonObject)['schema_version'],
    LENGTH_TIME_PLAN_SCHEMA,
  );
});
