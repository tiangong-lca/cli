// CLI-level proof that the v2 capability is reachable from the real command surface: the test
// drives `executeCli` with real argv through the real router and the real protected run, with
// only the HTTP transport stubbed. Nothing here imports a private build or a test-only entry.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import { buildAliasV2Plan } from '../src/lib/dataset-alias-v2-plan.js';
import {
  ALIAS_V2_PROTECTED_CONTRACT,
  aliasV2RequestId,
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  sealAliasV2Approval,
} from '../src/lib/dataset-alias-v2-protected.js';
import { COHORT_COUNTS, buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const USER_ID = 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7';
const EMAIL = 'fixture-owner@example.invalid';
const PROJECT_REF = 'qgzvkongdjqiiamzbbts';
const dotEnvStatus: DotEnvLoadResult = { loaded: false, path: '/tmp/.env', count: 0 };

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

/** The 387-action cohort plan and the artefacts that seal it, all inside a private temp dir. */
function sealedExecution(): {
  directory: string;
  planPath: string;
  freezePath: string;
  approvalPath: string;
  plan: JsonObject;
  requestId: string;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-cli-'));
  const plan = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
  const planPath = path.join(directory, 'alias-v2-plan.json');
  const planText = `${stableJsonText(plan)}\n`;
  writeFileSync(planPath, planText, { mode: 0o600 });
  const bindings = Object.fromEntries(
    [
      'plan_file_sha256',
      'freeze_file_sha256',
      'freeze_sha256',
      'approval_file_sha256',
      'approval_identity_sha256',
      'approval_text_sha256',
      'alias_plan_request_sha256',
      'before_hash_set_sha256',
      'desired_hash_set_sha256',
      'exchange_rewrite_set_sha256',
      'support_snapshot_set_sha256',
      'derivative_baseline_set_sha256',
      'derivative_target_set_sha256',
      'toolchain_evidence_sha256',
    ].map((key) => [key, sha256Json({ key, plan: plan['plan_sha256'] })]),
  );
  const freezeArtifact = buildAliasV2Freeze({
    plan,
    planFileSha256: createHash('sha256').update(planText).digest('hex'),
    projectRef: PROJECT_REF,
    account: { user_id: USER_ID, email: EMAIL },
    bindings,
    derivativeTargets: [
      {
        table: 'flows',
        id: 'f10c0de0-0000-4000-8000-000000000001',
        version: '00.00.001',
        user_id: USER_ID,
        state_code: 0,
        baseline_snapshot_sha256: 'b'.repeat(64),
      },
    ],
    expectedClosure: { roots: 6, references: 33 },
    toolchainEvidenceSha256: 'c'.repeat(64),
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
  });
  const freezePath = path.join(directory, 'protected-v2-execution-freeze.json');
  writeFileSync(freezePath, freezeArtifact.canonical_file_text, { mode: 0o600 });
  const request = buildAliasV2ApprovalRequest({
    freeze: freezeArtifact.value,
    freezeFileSha256: freezeArtifact.file_sha256,
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
    approvals: { plan: '', freeze: '', request: '', text: '' },
  });
  const requestPath = path.join(directory, 'protected-v2-approval-request.json');
  writeFileSync(requestPath, request.canonical_file_text, { mode: 0o600 });
  const approval = sealAliasV2Approval({
    request: request.value,
    requestFileSha256: request.file_sha256,
    approvals: {
      plan: request.value.plan_sha256,
      freeze: request.value.freeze_sha256,
      request: request.file_sha256,
      text: request.value.approval_text_sha256,
    },
    confirm: EMAIL,
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
  });
  const approvalPath = path.join(directory, 'protected-v2-approval.json');
  writeFileSync(approvalPath, approval.canonical_file_text, { mode: 0o600 });
  return {
    directory,
    planPath,
    freezePath,
    approvalPath,
    plan,
    requestId: aliasV2RequestId(
      freezeArtifact.value.plan.plan_sha256,
      freezeArtifact.value.freeze_sha256,
    ),
  };
}

type Call = { url: string; body: JsonObject };

/** Stubs the transport: Supabase auth plus the four versioned protected endpoints. */
function stubFetch(options: {
  plan: JsonObject;
  requestId: string;
  reads: Array<unknown>;
  calls: Call[];
  admitStatus?: number;
  admitBody?: unknown;
}): FetchLike {
  let readIndex = 0;
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ userId: USER_ID, email: EMAIL });
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as JsonObject) : {};
    options.calls.push({ url, body });
    if (url.includes('cmd_dataset_alias_execution_preflight_v2_guarded')) {
      return jsonResponse({
        ok: true,
        request_id: options.requestId,
        plan_sha256: options.plan['plan_sha256'],
        preflight_token: 'preflight-token',
      });
    }
    if (url.includes('cmd_dataset_alias_execution_gate_v2_guarded')) {
      return jsonResponse({
        ok: true,
        request_id: options.requestId,
        plan_sha256: options.plan['plan_sha256'],
        gate_name: body['p_gate_name'],
      });
    }
    if (url.includes('cmd_dataset_alias_execution_admit_v2_guarded')) {
      return options.admitBody === undefined
        ? jsonResponse({
            ok: true,
            request_id: options.requestId,
            plan_sha256: options.plan['plan_sha256'],
          })
        : jsonResponse(options.admitBody, options.admitStatus ?? 200);
    }
    if (url.includes('cmd_dataset_alias_execution_read_v2')) {
      const value = options.reads[Math.min(readIndex, options.reads.length - 1)];
      readIndex += 1;
      return value === null
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: true, ...(value as JsonObject) });
    }
    throw new Error(`Unexpected request in the stub: ${url}`);
  }) as FetchLike;
}

function terminalProof(plan: JsonObject): JsonObject {
  const actions = plan['actions'] as JsonObject[];
  return {
    status: 'applied',
    plan_sha256: plan['plan_sha256'],
    counts: plan['counts'],
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
}

test('the real argv runs the 387-action v2 plan through the versioned protected channel', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const calls: Call[] = [];
  const fetchImpl = stubFetch({
    plan: sealed.plan,
    requestId: sealed.requestId,
    reads: [
      { status: 'pending', plan_sha256: sealed.plan['plan_sha256'] },
      terminalProof(sealed.plan),
    ],
    calls,
  });
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      sealed.planPath,
      '--freeze',
      sealed.freezePath,
      '--approval',
      sealed.approvalPath,
      '--out-dir',
      sealed.directory,
      '--commit',
      '--approve-execution',
      sealed.plan['plan_sha256'] as string,
      '--confirm',
      EMAIL,
      '--wait-seconds',
      '5',
      '--poll-ms',
      '100',
      '--json',
    ],
    { env: buildSupabaseTestEnv(), dotEnvStatus, fetchImpl },
  );
  const report = JSON.parse(result.stdout) as JsonObject;
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(report['status'], 'passed');
  assert.equal(report['phase'], 'applied');
  assert.deepEqual(report['counts'], { ...COHORT_COUNTS });
  assert.equal(report['admission_attempts'], 1);
  assert.equal(report['polls'], 2);
  assert.equal(report['code'], null);
  // The versioned endpoints are the ones on the wire, and no private executor is ever called.
  const rpcNames = calls
    .map((call) => call.url.split('/').pop())
    .filter((name) => name?.startsWith('cmd_'));
  assert.deepEqual(rpcNames, [
    'cmd_dataset_alias_execution_preflight_v2_guarded',
    'cmd_dataset_alias_execution_gate_v2_guarded',
    'cmd_dataset_alias_execution_gate_v2_guarded',
    'cmd_dataset_alias_execution_gate_v2_guarded',
    'cmd_dataset_alias_execution_admit_v2_guarded',
    'cmd_dataset_alias_execution_read_v2',
    'cmd_dataset_alias_execution_read_v2',
  ]);
  assert.equal(
    calls.some((call) => call.url.includes('private.')),
    false,
    'the CLI never dispatches a private executor',
  );
  // The admission is the exact reviewed preflight envelope, once.
  const admit = calls.find((call) => call.url.includes('admit_v2_guarded')) as Call;
  const envelope = admit.body['p_request'] as JsonObject;
  assert.deepEqual(Object.keys(envelope).sort(), [
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
  assert.equal(envelope['request_id'], sealed.requestId);
  assert.equal((envelope['plan'] as JsonObject)['plan_sha256'], sealed.plan['plan_sha256']);
  // The durable evidence is the versioned one, in the operator's own run directory.
  const ledger = readFileSync(
    path.join(sealed.directory, 'protected-v2-status-progress.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonObject);
  assert.deepEqual(
    ledger.map((entry) => entry['stage']),
    ['preflight', 'gate', 'gate', 'gate', 'admit', 'read', 'read'],
  );
  assert.equal(
    (
      JSON.parse(
        readFileSync(path.join(sealed.directory, 'protected-v2-attempt.json'), 'utf8'),
      ) as JsonObject
    )['admission_posts'],
    1,
  );
});

test('an unknown admission outcome is never retried, on argv or on a later run', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const firstCalls: Call[] = [];
  const first = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      sealed.planPath,
      '--freeze',
      sealed.freezePath,
      '--approval',
      sealed.approvalPath,
      '--out-dir',
      sealed.directory,
      '--commit',
      '--approve-execution',
      sealed.plan['plan_sha256'] as string,
      '--confirm',
      EMAIL,
      '--wait-seconds',
      '0',
      '--json',
    ],
    {
      env: buildSupabaseTestEnv(),
      dotEnvStatus,
      // The admission transport fails without a status: an unknown outcome.
      fetchImpl: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({ userId: USER_ID, email: EMAIL });
        }
        firstCalls.push({
          url,
          body: init?.body ? (JSON.parse(String(init.body)) as JsonObject) : {},
        });
        if (url.includes('preflight_v2_guarded')) {
          return jsonResponse({
            ok: true,
            request_id: sealed.requestId,
            plan_sha256: sealed.plan['plan_sha256'],
            preflight_token: 'preflight-token',
          });
        }
        if (url.includes('gate_v2_guarded')) {
          return jsonResponse({
            ok: true,
            request_id: sealed.requestId,
            plan_sha256: sealed.plan['plan_sha256'],
            gate_name: (JSON.parse(String(init?.body)) as JsonObject)['p_gate_name'],
          });
        }
        if (url.includes('admit_v2_guarded')) {
          throw new Error('socket hang up');
        }
        throw new Error(`Unexpected request in the stub: ${url}`);
      }) as FetchLike,
    },
  );
  const firstReport = JSON.parse(first.stdout) as JsonObject;
  assert.equal(first.exitCode, 1, first.stdout);
  assert.equal(firstReport['status'], 'indeterminate');
  assert.equal(firstReport['phase'], 'readback_required');
  assert.equal(
    firstCalls.filter((call) => call.url.includes('admit_v2_guarded')).length,
    1,
    'one admission POST even when its outcome is unknown',
  );

  // A later run of the very same execution may only read: the durable marker forbids a second
  // admission, and the read stage resolves the outcome.
  const secondCalls: Call[] = [];
  const second = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      sealed.planPath,
      '--freeze',
      sealed.freezePath,
      '--approval',
      sealed.approvalPath,
      '--out-dir',
      sealed.directory,
      '--status-only',
      '--wait-seconds',
      '5',
      '--poll-ms',
      '100',
      '--json',
    ],
    {
      env: buildSupabaseTestEnv(),
      dotEnvStatus,
      fetchImpl: stubFetch({
        plan: sealed.plan,
        requestId: sealed.requestId,
        reads: [terminalProof(sealed.plan)],
        calls: secondCalls,
      }),
    },
  );
  const secondReport = JSON.parse(second.stdout) as JsonObject;
  assert.equal(second.exitCode, 0, second.stdout);
  assert.equal(secondReport['status'], 'passed');
  assert.equal(secondReport['mode'], 'status_only');
  assert.deepEqual(
    secondCalls.map((call) => call.url.split('/').pop()),
    ['cmd_dataset_alias_execution_read_v2'],
    'a resumed run reads; it never re-admits',
  );
});

test('a v2 seal whose evidence no longer matches its plan is refused before any dispatch', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const freeze = JSON.parse(readFileSync(sealed.freezePath, 'utf8')) as JsonObject;
  freeze['plan'] = { ...(freeze['plan'] as JsonObject), plan_sha256: 'e'.repeat(64) };
  const forgedPath = path.join(sealed.directory, 'protected-v2-execution-freeze.json');
  writeFileSync(forgedPath, `${JSON.stringify(freeze)}\n`, { mode: 0o600 });
  const calls: Call[] = [];
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      sealed.planPath,
      '--freeze',
      forgedPath,
      '--approval',
      sealed.approvalPath,
      '--out-dir',
      sealed.directory,
      '--status-only',
      '--json',
    ],
    {
      env: buildSupabaseTestEnv(),
      dotEnvStatus,
      fetchImpl: stubFetch({
        plan: sealed.plan,
        requestId: sealed.requestId,
        reads: [terminalProof(sealed.plan)],
        calls,
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /freeze must bind this exact plan file and digest/u);
  assert.deepEqual(
    calls.filter((call) => call.url.includes('cmd_dataset_alias_execution')),
    [],
    'nothing is dispatched when the seal does not bind the plan',
  );
});

test('the version dispatch leaves the v1 seal on the frozen v1 chain', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-dispatch-'));
  try {
    const freezePath = path.join(directory, 'protected-execution-freeze.json');
    writeFileSync(
      freezePath,
      `${JSON.stringify({ schema_version: 'dataset-alias-execution-freeze.v1' })}\n`,
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
      {
        env: buildSupabaseTestEnv(),
        dotEnvStatus,
        fetchImpl: stubFetch({
          plan: { plan_sha256: 'a'.repeat(64) },
          requestId: 'x',
          reads: [null],
          calls,
        }),
      },
    );
    // The v1 chain rejects the artifact itself: the v2 module was never entered.
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /artifact|plan|freeze|JSON/iu);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the versioned contract and the request identity are stable', () => {
  assert.equal(ALIAS_V2_PROTECTED_CONTRACT.freeze_schema, 'dataset-alias-execution-freeze.v2');
  const first = aliasV2RequestId('a'.repeat(64), 'b'.repeat(64));
  assert.equal(first, aliasV2RequestId('a'.repeat(64), 'b'.repeat(64)));
  assert.notEqual(first, aliasV2RequestId('a'.repeat(64), 'c'.repeat(64)));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
});
