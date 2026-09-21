// Contract tests for the versioned protected run. Each of these pins a behaviour root's review
// found missing or weakened: the exact wire shapes, the local preconditions that must fail
// before any fetch, the honest marker semantics, the fresh actor/project match, the absence of
// raw nonce material in stored evidence, and bounded polling.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_PROTECTED_ARTIFACTS,
  buildAliasV2Freeze,
  parseAliasV2Approval,
  __testInternals as protectedInternals,
  runAliasV2Protected,
  type AliasV2Freeze,
} from '../src/lib/dataset-alias-v2-protected.js';
import {
  ALIAS_V2_PROTOCOL,
  buildAliasV2AdmitRequest,
  buildAliasV2PreflightRequest,
  parseAliasV2AdmissionProof,
  parseAliasV2GateProof,
  parseAliasV2PreflightProof,
} from '../src/lib/dataset-alias-v2-protected-contract.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_PROJECT_REF,
  aliasV2DerivativeTargets,
  aliasV2Sets,
  sealedAliasV2Execution,
  type SealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import { buildAliasV2Plan, type AliasV2Row } from '../src/lib/dataset-alias-v2-plan.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import { aliasV2StatusEnvelope, aliasV2TerminalProof } from './helpers/alias-v2-status.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

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

const START = Date.parse('2026-09-21T00:00:00.000Z');
const iso = (offsetMs: number): string => new Date(START + offsetMs).toISOString();

/** The strict preflight proof the server must return for this identity. */
function preflightProof(sealed: SealedAliasV2Execution): JsonObject {
  const identity = sealed.identity;
  return {
    ok: true,
    schema_version: ALIAS_V2_PROTOCOL.preflight_response_schema,
    command: ALIAS_V2_PROTOCOL.preflight_command,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    environment: 'production',
    project_ref: identity.project_ref,
    server_context_sha256: sha256Json({ context: identity.project_ref }),
    plan_sha256: identity.plan_sha256,
    freeze_sha256: sealed.freeze.freeze_sha256,
    approval_identity_sha256: sealed.approveExecution,
    plan_request_sha256: sha256Json({ plan: identity.plan_sha256 }),
    bindings_sha256: sha256Json(identity.bindings),
    expected_sha256: sha256Json(identity.expected),
    derivative_targets_sha256: sha256Json(identity.derivative_targets),
    gate_expectations: Object.fromEntries(
      ['primary_support_plan', 'execution_unused', 'derivative_quiescence'].map((gate) => [
        `${gate}_sha256`,
        sha256Json({ gate, plan: identity.plan_sha256 }),
      ]),
    ),
    gate_expectations_sha256: sha256Json({ gates: identity.plan_sha256 }),
    preflight_request_sha256: sha256Json({ request: identity.plan_sha256 }),
    preflight_token: 'preflight-token-abcdefghij',
    preflight_proof_sha256: sha256Json({ preflight: identity.request_id }),
    simulation: {
      plan_rows: identity.expected['action_count'],
      plan_exchanges: identity.expected['exchange_count'],
      rolled_back: true,
    },
    completed_at: iso(0),
    expires_at: iso(150_000),
  };
}

function gateProof(preflight: JsonObject, gate: string): JsonObject {
  const expected = (preflight['gate_expectations'] as JsonObject)[`${gate}_sha256`];
  return {
    ok: true,
    schema_version: ALIAS_V2_PROTOCOL.gate_response_schema,
    command: ALIAS_V2_PROTOCOL.gate_command,
    request_id: preflight['request_id'],
    actor_user_id: preflight['actor_user_id'],
    preflight_proof_sha256: preflight['preflight_proof_sha256'],
    gate,
    expected_sha256: expected,
    observed_sha256: expected,
    status: 'passed',
    captured_at: iso(10_000),
    receipt_sha256: sha256Json({ gate }),
  };
}

function admissionProof(preflight: JsonObject, sealed: SealedAliasV2Execution): JsonObject {
  return {
    ok: true,
    schema_version: ALIAS_V2_PROTOCOL.admit_response_schema,
    command: ALIAS_V2_PROTOCOL.admit_command,
    request_id: preflight['request_id'],
    plan_sha256: sealed.identity.plan_sha256,
    preflight_proof_sha256: preflight['preflight_proof_sha256'],
    admission_request_sha256: sha256Json({ admit: sealed.identity.request_id }),
    gate_results_sha256: sha256Json({ gates: sealed.identity.request_id }),
    status: 'dispatched',
    attempt_count: 1,
    dispatch_count: 1,
    net_request_id: 'net-request-abcdefghij',
    attempt_consumed: true,
    retry_allowed: false,
  };
}

test('the admission proof accepts the real dispatched callback identity', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const preflight = parseAliasV2PreflightProof(
      preflightProof(sealed),
      sealed.identity,
      new Date(START),
    );
    // The database returns the pg_net row id as text (a short numeric string); v1 accepted exactly
    // that shape and the versioned parser must too.
    const proof = parseAliasV2AdmissionProof(
      { ...admissionProof(preflightProof(sealed), sealed), net_request_id: '50018' },
      sealed.identity,
      preflight,
    );
    assert.equal(proof.net_request_id, '50018');
    // A missing, empty or non-string identity is still refused.
    for (const bad of ['', '   ', 7, undefined]) {
      assert.throws(
        () =>
          parseAliasV2AdmissionProof(
            { ...admissionProof(preflightProof(sealed), sealed), net_request_id: bad },
            sealed.identity,
            preflight,
          ),
        (error: unknown) =>
          (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_PROOF_INVALID',
        String(bad),
      );
    }
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

/** The actual versioned status envelope of this execution, as the read command returns it. */
function readEnvelope(sealed: SealedAliasV2Execution, overrides: JsonObject = {}): JsonObject {
  return aliasV2StatusEnvelope(sealed, overrides);
}

/** The actual status envelope carrying the given (possibly mutated) terminal proof. */
function readEnvelopeWithProof(
  sealed: SealedAliasV2Execution,
  proofOverrides: JsonObject = {},
): JsonObject {
  return aliasV2StatusEnvelope(sealed, {
    terminal_proof: { ...aliasV2TerminalProof(sealed), ...proofOverrides },
  });
}

type Call = { url: string; body: JsonObject; raw: string };

/** A transport that answers the real v2 endpoints and records every request it sees. */
function scriptedFetch(
  sealed: SealedAliasV2Execution,
  options: {
    calls?: Call[];
    actor?: { userId: string; email: string };
    reads?: unknown[];
    admit?: 'ok' | 'unknown' | 'refused';
    neverTerminal?: boolean;
  } = {},
): FetchLike {
  const calls = options.calls ?? [];
  const preflight = preflightProof(sealed);
  let readIndex = 0;
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: options.actor?.userId ?? ALIAS_V2_TEST_ACCOUNT.user_id,
        email: options.actor?.email ?? ALIAS_V2_TEST_ACCOUNT.email,
      });
    }
    calls.push({ url, body: raw ? (JSON.parse(raw) as JsonObject) : {}, raw });
    if (url.includes(ALIAS_V2_PROTOCOL.preflight_command)) {
      return jsonResponse(preflight);
    }
    if (url.includes(ALIAS_V2_PROTOCOL.gate_command)) {
      const body = JSON.parse(raw) as JsonObject;
      return jsonResponse(gateProof(preflight, String(body['p_gate_name'])));
    }
    if (url.includes(ALIAS_V2_PROTOCOL.admit_command)) {
      if (options.admit === 'unknown') {
        throw new Error('socket hang up');
      }
      if (options.admit === 'refused') {
        return jsonResponse({ ok: false, code: 'ALIAS_V2_COUNT_MISMATCH', status: 409 });
      }
      return jsonResponse(admissionProof(preflight, sealed));
    }
    if (url.includes('cmd_dataset_alias_execution_read_v2')) {
      if (options.neverTerminal) {
        return jsonResponse(readEnvelope(sealed, { status: 'pending' }));
      }
      const value = options.reads?.[Math.min(readIndex, (options.reads ?? []).length - 1)];
      readIndex += 1;
      return value === null
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: true, ...(value as JsonObject) });
    }
    throw new Error(`Unexpected request in the stub: ${url}`);
  }) as FetchLike;
}

function runOptions(
  sealed: SealedAliasV2Execution,
  overrides: JsonObject = {},
): Parameters<typeof runAliasV2Protected>[0] {
  return {
    planPath: sealed.planPath,
    freezePath: sealed.freezePath,
    approvalPath: sealed.approvalPath,
    outDir: sealed.directory,
    commit: true,
    statusOnly: false,
    approveExecution: sealed.approveExecution,
    confirm: ALIAS_V2_TEST_ACCOUNT.email,
    waitSeconds: 60,
    pollMs: 1_000,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
    }),
    fetchImpl: scriptedFetch(sealed, { reads: [readEnvelope(sealed)] }),
    now: new Date(START),
    sleep: async () => {},
    ...overrides,
  } as Parameters<typeof runAliasV2Protected>[0];
}

function withSealed(
  body: (sealed: SealedAliasV2Execution) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const sealed = sealedAliasV2Execution();
    try {
      await body(sealed);
    } finally {
      rmSync(sealed.directory, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------------

test('the admission carries exactly the five reviewed keys, never the preflight envelope', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const preflight = parseAliasV2PreflightProof(
      preflightProof(sealed),
      sealed.identity,
      new Date(START),
    );
    const gates = Object.fromEntries(
      ['primary_support_plan', 'execution_unused', 'derivative_quiescence'].map((gate) => {
        const proof = parseAliasV2GateProof(gateProof(preflightProof(sealed), gate), {
          identity: sealed.identity,
          preflight,
          gate: gate as 'primary_support_plan',
        });
        return [gate, proof.result];
      }),
    ) as Record<'primary_support_plan' | 'execution_unused' | 'derivative_quiescence', never>;
    const request = buildAliasV2AdmitRequest({ preflight, gateResults: gates });
    assert.deepEqual(Object.keys(request).sort(), [
      'gate_results',
      'preflight_proof_sha256',
      'preflight_token',
      'request_id',
      'schema_version',
    ]);
    assert.equal(request['schema_version'], 'dataset-alias-execution-admit.v2');
    assert.equal(request['preflight_proof_sha256'], preflight.preflight_proof_sha256);
    assert.deepEqual(Object.keys(request['gate_results'] as JsonObject).sort(), [
      'derivative_quiescence',
      'execution_unused',
      'primary_support_plan',
    ]);
    // The preflight envelope's own keys never appear on the admission.
    for (const leaked of [
      'plan',
      'freeze',
      'approval',
      'bindings',
      'expected',
      'derivative_targets',
      'actor',
    ]) {
      assert.equal(Object.hasOwn(request, leaked), false, leaked);
    }
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the preflight request carries the complete freeze and approval documents', () => {
  const sealed = sealedAliasV2Execution();
  const request = buildAliasV2PreflightRequest({
    identity: sealed.identity,
    plan: sealed.plan,
    freeze: sealed.freeze,
    approval: parseAliasV2Approval(parseApproval(sealed)),
  });
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
  // The nested documents are the real ones, not three-field stubs.
  const freeze = request['freeze'] as JsonObject;
  assert.deepEqual(Object.keys(freeze).sort(), Object.keys(sealed.freeze).sort());
  assert.deepEqual(freeze['sets'], sealed.freeze.sets);
  assert.equal(
    (freeze['derivative_targets'] as unknown[]).length,
    sealed.freeze.derivative_targets.length,
  );
  const approval = request['approval'] as JsonObject;
  assert.deepEqual(Object.keys(approval).sort(), Object.keys(parseApproval(sealed)).sort());
  assert.equal(
    (request['bindings'] as JsonObject)['plan_file_sha256'],
    sealed.identity.bindings['plan_file_sha256'],
  );
  assert.deepEqual(request['expected'], sealed.identity.expected);
  rmSync(sealed.directory, { recursive: true, force: true });
});

function parseApproval(sealed: SealedAliasV2Execution): JsonObject {
  return JSON.parse(
    readFileSync(path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval), 'utf8'),
  ) as JsonObject;
}

test('a foreign or malformed proof envelope is refused, at every stage', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const identity = sealed.identity;
    const good = preflightProof(sealed);
    const cases: Array<[string, JsonObject]> = [
      ['not-ok', { ...good, ok: false }],
      ['foreign schema', { ...good, schema_version: 'dataset-alias-execution-preflight-proof.v1' }],
      ['foreign command', { ...good, command: 'cmd_dataset_alias_execution_preflight_guarded' }],
      ['foreign request', { ...good, request_id: 'a'.repeat(8) + '-0000-5000-8000-000000000000' }],
      ['foreign actor', { ...good, actor_user_id: 'someone-else' }],
      ['foreign project', { ...good, project_ref: 'otherproject' }],
      ['foreign plan', { ...good, plan_sha256: 'f'.repeat(64) }],
      ['foreign freeze', { ...good, freeze_sha256: 'f'.repeat(64) }],
      ['foreign approval', { ...good, approval_identity_sha256: 'f'.repeat(64) }],
      [
        'wrong simulation',
        {
          ...good,
          simulation: { plan_rows: 1, plan_exchanges: 1, rolled_back: true },
        },
      ],
      [
        'not rolled back',
        {
          ...good,
          simulation: {
            plan_rows: identity.expected['action_count'],
            plan_exchanges: identity.expected['exchange_count'],
            rolled_back: false,
          },
        },
      ],
      ['window too wide', { ...good, expires_at: iso(200_000) }],
      ['already expired', { ...good, expires_at: iso(-1) }],
      ['nonce too short', { ...good, preflight_token: 'short' }],
      ['context digest not a sha256', { ...good, server_context_sha256: 'not-a-sha256' }],
      ['unparsable completion time', { ...good, completed_at: 'not-a-timestamp' }],
      ['missing gate expectations', { ...good, gate_expectations: 'nope' }],
      [
        'issued ahead of the clock-skew allowance',
        { ...good, completed_at: iso(10_000), expires_at: iso(150_000) },
      ],
      // A token that is stale, and no longer than the window: the window is fine, the token
      // is not, so this is refused for its age rather than for its length.
      ['stale token', { ...good, completed_at: iso(-100_000), expires_at: iso(-1_000) }],
    ];
    for (const [label, value] of cases) {
      assert.throws(
        () => parseAliasV2PreflightProof(value, identity, new Date(START)),
        (error: unknown) =>
          (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_PROOF_INVALID',
        label,
      );
    }
    // Gate receipts must bind the preflight's frozen expectation and its window.
    const preflight = parseAliasV2PreflightProof(good, identity, new Date(START));
    const gateCases: Array<[string, JsonObject]> = [
      ['foreign gate', { ...gateProof(good, 'primary_support_plan'), gate: 'another_gate' }],
      ['failed', { ...gateProof(good, 'primary_support_plan'), status: 'failed' }],
      [
        'diverging digest',
        { ...gateProof(good, 'primary_support_plan'), observed_sha256: 'f'.repeat(64) },
      ],
      ['outside window', { ...gateProof(good, 'primary_support_plan'), captured_at: iso(200_000) }],
      [
        'unparsable capture time',
        { ...gateProof(good, 'primary_support_plan'), captured_at: 'nope' },
      ],
      [
        'other preflight',
        { ...gateProof(good, 'primary_support_plan'), preflight_proof_sha256: 'f'.repeat(64) },
      ],
    ];
    for (const [label, value] of gateCases) {
      assert.throws(
        () =>
          parseAliasV2GateProof(value, {
            identity,
            preflight,
            gate: 'primary_support_plan',
          }),
        (error: unknown) =>
          (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_PROOF_INVALID',
        label,
      );
    }
    const admit = admissionProof(good, sealed);
    const admitCases: Array<[string, JsonObject]> = [
      ['duplicate attempt', { ...admit, attempt_count: 2 }],
      ['retry allowed', { ...admit, retry_allowed: true }],
      ['not dispatched', { ...admit, status: 'queued' }],
      ['unconsumed', { ...admit, attempt_consumed: false }],
      ['second dispatch', { ...admit, dispatch_count: 2 }],
    ];
    for (const [label, value] of admitCases) {
      assert.throws(
        () => parseAliasV2AdmissionProof(value, identity, preflight),
        (error: unknown) =>
          (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_PROOF_INVALID',
        label,
      );
    }
    assert.equal(parseAliasV2AdmissionProof(admit, identity, preflight).status, 'dispatched');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Zero-fetch preconditions
// ---------------------------------------------------------------------------------------------

test(
  'a wrong or missing approval hash, or tampered freeze bytes, fail before any fetch',
  withSealed(async (sealed) => {
    const cases: Array<[string, JsonObject]> = [
      ['missing approval hash', { approveExecution: undefined }],
      ['malformed approval hash', { approveExecution: 'not-a-hash' }],
      ['wrong approval hash', { approveExecution: 'a'.repeat(64) }],
      ['missing confirm', { confirm: undefined }],
      ['foreign confirm', { confirm: 'someone-else@example.invalid' }],
    ];
    for (const [label, overrides] of cases) {
      const calls: Call[] = [];
      await assert.rejects(
        () =>
          runAliasV2Protected(
            runOptions(sealed, { ...overrides, fetchImpl: scriptedFetch(sealed, { calls }) }),
          ),
        `Expected ${label} to be refused before any fetch`,
      );
      assert.deepEqual(calls, [], label);
    }
    const tampered = path.join(sealed.directory, 'tampered-freeze.json');
    const calls: Call[] = [];
    // Tampered content with the original digest: the content identity is recomputed and fails.
    const contentTampered = JSON.parse(readFileSync(sealed.freezePath, 'utf8')) as JsonObject;
    (contentTampered['expected'] as JsonObject)['text_action_count'] = 0;
    writeFileSync(tampered, `${stableJsonText(contentTampered)}\n`, { mode: 0o600 });
    await assert.rejects(() =>
      runAliasV2Protected(
        runOptions(sealed, { freezePath: tampered, fetchImpl: scriptedFetch(sealed, { calls }) }),
      ),
    );
    assert.deepEqual(calls, []);
    // A forged self-hash on tampered content is refused as well: even a self-consistent freeze
    // no longer matches the bytes the approval was sealed against.
    const forged = JSON.parse(readFileSync(sealed.freezePath, 'utf8')) as JsonObject;
    (forged['expected'] as JsonObject)['text_action_count'] = 0;
    forged['freeze_sha256'] = sha256Json({ ...forged, freeze_sha256: undefined });
    writeFileSync(tampered, `${stableJsonText(forged)}\n`, { mode: 0o600 });
    await assert.rejects(() =>
      runAliasV2Protected(
        runOptions(sealed, { freezePath: tampered, fetchImpl: scriptedFetch(sealed, { calls }) }),
      ),
    );
    assert.deepEqual(calls, []);
  }),
);

test(
  'a fresh context that does not match the frozen actor or project never reaches preflight',
  withSealed(async (sealed) => {
    for (const actor of [
      { userId: 'a0df7777-0000-4000-8000-000000000001', email: ALIAS_V2_TEST_ACCOUNT.email },
      { userId: ALIAS_V2_TEST_ACCOUNT.user_id, email: 'someone-else@example.invalid' },
    ]) {
      const calls: Call[] = [];
      await assert.rejects(
        () =>
          runAliasV2Protected(
            runOptions(sealed, { fetchImpl: scriptedFetch(sealed, { calls, actor }) }),
          ),
        (error: unknown) =>
          (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_CONTEXT_MISMATCH',
      );
      assert.deepEqual(
        calls.filter((call) => call.url.includes('cmd_dataset_alias_execution')),
        [],
        'no stage call may happen for a foreign context',
      );
    }
  }),
);

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

test(
  'the full commit runs the real sequence once and stores no raw nonce material',
  withSealed(async (sealed) => {
    const calls: Call[] = [];
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          calls,
          reads: [readEnvelope(sealed, { status: 'pending' }), readEnvelope(sealed)],
        }),
      }),
    );
    assert.deepEqual(
      [report.status, report.phase, report.admission_attempts],
      ['passed', 'applied', 1],
    );
    assert.deepEqual(
      calls.map((call) => call.url.split('/').pop()),
      [
        ALIAS_V2_PROTOCOL.preflight_command,
        ALIAS_V2_PROTOCOL.gate_command,
        ALIAS_V2_PROTOCOL.gate_command,
        ALIAS_V2_PROTOCOL.gate_command,
        ALIAS_V2_PROTOCOL.admit_command,
        'cmd_dataset_alias_execution_read_v2',
        'cmd_dataset_alias_execution_read_v2',
      ],
    );
    // The admission body is the five-key contract, not the preflight envelope.
    const admit = calls.find((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)) as Call;
    const admitRequest = admit.body['p_request'] as JsonObject;
    assert.deepEqual(Object.keys(admitRequest).sort(), [
      'gate_results',
      'preflight_proof_sha256',
      'preflight_token',
      'request_id',
      'schema_version',
    ]);
    assert.deepEqual(Object.keys(admitRequest['gate_results'] as JsonObject).sort(), [
      'derivative_quiescence',
      'execution_unused',
      'primary_support_plan',
    ]);
    // The preflight body carries the complete freeze and approval.
    const preflight = calls[0] as Call;
    const request = preflight.body['p_request'] as JsonObject;
    assert.deepEqual(Object.keys((request['freeze'] as JsonObject).sets as JsonObject).sort(), [
      'alias_plan_request_sha256',
      'before_hash_set_sha256',
      'derivative_baseline_set_sha256',
      'derivative_target_set_sha256',
      'desired_hash_set_sha256',
      'exchange_rewrite_set_sha256',
      'support_snapshot_set_sha256',
      'toolchain_evidence_sha256',
    ]);
    assert.equal(
      Object.keys(request['approval'] as JsonObject).length > 3,
      true,
      'approval must not be a three-field stub',
    );
    // Stored evidence never contains the raw token, and keeps its digest instead.
    const evidence = readFileSync(
      path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.preflight_evidence),
      'utf8',
    );
    const marker = readFileSync(
      path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.submission_marker),
      'utf8',
    );
    const ledger = readFileSync(
      path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.status_progress),
      'utf8',
    );
    for (const [label, text] of [
      ['preflight evidence', evidence],
      ['submission marker', marker],
      ['status ledger', ledger],
    ] as const) {
      assert.equal(text.includes('preflight-token-abcdefghij'), false, label);
    }
    const evidenceValue = JSON.parse(evidence) as JsonObject;
    assert.equal(typeof evidenceValue['preflight_token_sha256'], 'string');
    assert.equal(
      evidenceValue['preflight_token_sha256'],
      createHash('sha256').update('preflight-token-abcdefghij').digest('hex'),
    );
    assert.equal((evidenceValue['proof'] as JsonObject)['preflight_token'], undefined);
  }),
);

test(
  'an unknown admission is recovered only by the read stage, and only once admitted',
  withSealed(async (sealed) => {
    const calls: Call[] = [];
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          calls,
          admit: 'unknown',
          reads: [readEnvelope(sealed, { status: 'pending' }), readEnvelope(sealed)],
        }),
      }),
    );
    assert.equal(report.admission_attempts, 1);
    assert.equal(
      calls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)).length,
      1,
    );
    assert.equal(report.status, 'passed');
    // The marker exists, so a resumed run cannot admit again.
    const resumedCalls: Call[] = [];
    const resumed = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        fetchImpl: scriptedFetch(sealed, { calls: resumedCalls, reads: [readEnvelope(sealed)] }),
      }),
    );
    assert.deepEqual([resumed.status, resumed.mode], ['passed', 'status_only']);
    assert.deepEqual(
      resumedCalls.map((call) => call.url.split('/').pop()),
      ['cmd_dataset_alias_execution_read_v2'],
    );
  }),
);

test(
  'a corrupt or foreign marker is never treated as absent',
  withSealed(async (sealed) => {
    const markerPath = path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.submission_marker);
    // Corrupt bytes: the run must not claim "no admission", and it must not admit either — it
    // observes the authoritative read path and reports what the server holds.
    writeFileSync(markerPath, '{ not json\n', { mode: 0o600 });
    assert.equal(protectedInternals.readMarkerState(markerPath).state, 'unreadable');
    const corruptCalls: Call[] = [];
    const observed = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        fetchImpl: scriptedFetch(sealed, { calls: corruptCalls, reads: [readEnvelope(sealed)] }),
      }),
    );
    assert.deepEqual([observed.status, observed.phase], ['passed', 'applied']);
    assert.deepEqual(
      corruptCalls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)),
      [],
      'a corrupt marker can never authorise an admission',
    );
    // With a corrupt marker and no durable server evidence the run refuses for review; it never
    // reports not_admitted, because it cannot prove that.
    const refused = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        fetchImpl: scriptedFetch(sealed, { reads: [null] }),
      }),
    );
    assert.equal(refused.status !== 'not_admitted', true, refused.status);
    assert.equal(refused.status, 'failed');
    // A schema-correct marker from a different execution is read as present and then refused.
    writeFileSync(
      markerPath,
      `${stableJsonText({
        schema_version: 'dataset-alias-execution-submission.v2',
        prepared_at_utc: iso(0),
        request_id: sealed.identity.request_id,
        identity_sha256: 'b'.repeat(64),
        plan_sha256: 'c'.repeat(64),
        actor: ALIAS_V2_TEST_ACCOUNT,
        project_ref: ALIAS_V2_TEST_PROJECT_REF,
        preflight_proof_sha256: 'd'.repeat(64),
        preflight_token_sha256: 'e'.repeat(64),
        preflight_completed_at: iso(0),
        preflight_expires_at: iso(150_000),
        gate_results: {},
        gate_receipt_sha256: {},
        max_admit_posts: 1,
        automatic_retry: false,
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal(protectedInternals.readMarkerState(markerPath).state, 'present');
    const foreignCalls: Call[] = [];
    await assert.rejects(
      () =>
        runAliasV2Protected(
          runOptions(sealed, {
            fetchImpl: scriptedFetch(sealed, {
              calls: foreignCalls,
              reads: [readEnvelope(sealed)],
            }),
          }),
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_MARKER_INVALID',
    );
    assert.deepEqual(foreignCalls, []);
  }),
);

test(
  'status only without a marker consults the server instead of asserting no admission',
  withSealed(async (sealed) => {
    const calls: Call[] = [];
    const notAdmitted = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        fetchImpl: scriptedFetch(sealed, { calls, reads: [null] }),
      }),
    );
    assert.equal(notAdmitted.status, 'not_admitted');
    assert.equal(
      calls.some((call) => call.url.includes('read_v2')),
      true,
      'the server is consulted',
    );
    assert.equal(
      calls.some((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)),
      false,
    );
    // A different outDir with its own empty state never claims the execution was never admitted
    // when the server still holds the attempt.
    const otherDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-other-'));
    mkdirSync(otherDir, { recursive: true });
    try {
      const applied = await runAliasV2Protected(
        runOptions(sealed, {
          commit: false,
          statusOnly: true,
          approveExecution: undefined,
          confirm: undefined,
          outDir: otherDir,
          fetchImpl: scriptedFetch(sealed, { reads: [readEnvelope(sealed)] }),
        }),
      );
      assert.deepEqual([applied.status, applied.phase], ['passed', 'applied']);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  }),
);

test(
  'polling is bounded even when the clock is injected and never advances',
  withSealed(async (sealed) => {
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        waitSeconds: 3,
        pollMs: 1_000,
        fetchImpl: scriptedFetch(sealed, { neverTerminal: true }),
      }),
    );
    assert.deepEqual([report.status, report.code], ['indeterminate', 'ALIAS_V2_POLL_EXHAUSTED']);
    assert.equal(report.polls >= 3, true, String(report.polls));
    assert.equal(report.polls <= 4, true, String(report.polls));
  }),
);

test(
  'a server refusal inside the reviewed policy stops the run with its own code',
  withSealed(async (sealed) => {
    const report = await runAliasV2Protected(
      runOptions(sealed, { fetchImpl: scriptedFetch(sealed, { admit: 'refused' }) }),
    );
    assert.deepEqual([report.status, report.code], ['failed', 'ALIAS_V2_COUNT_MISMATCH']);
    assert.equal(report.admission_attempts, 1);
  }),
);

test('the freeze document the builder emits is the strict one the parser accepts', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const freeze = sealed.freeze as AliasV2Freeze;
    assert.equal(freeze.freeze_sha256, sha256Json({ ...freeze, freeze_sha256: undefined }));
    assert.deepEqual(Object.keys(freeze.sets).sort(), [
      'alias_plan_request_sha256',
      'before_hash_set_sha256',
      'derivative_baseline_set_sha256',
      'derivative_target_set_sha256',
      'desired_hash_set_sha256',
      'exchange_rewrite_set_sha256',
      'support_snapshot_set_sha256',
      'toolchain_evidence_sha256',
    ]);
    assert.equal(freeze.derivative_targets.length, (sealed.plan['actions'] as unknown[]).length);
    assert.equal(readFileSync(sealed.freezePath, 'utf8'), `${stableJsonText(freeze)}\n`);
    // The freeze's expected counts are the plan's own derived block, and its derivative targets
    // are exactly the rows the plan changes: a short list, a placeholder or a foreign row is
    // refused rather than frozen as an executable subset.
    assert.deepEqual(freeze.expected, sealed.plan['expected']);
    const targets = aliasV2DerivativeTargets(sealed.plan, ALIAS_V2_TEST_ACCOUNT.user_id);
    const build = (derivativeTargets: JsonObject[]): unknown =>
      buildAliasV2Freeze({
        plan: sealed.plan,
        planFileSha256: sealed.identity.bindings['plan_file_sha256'] as string,
        projectRef: ALIAS_V2_TEST_PROJECT_REF,
        account: ALIAS_V2_TEST_ACCOUNT,
        sets: aliasV2Sets(sealed.plan['plan_sha256']),
        derivativeTargets,
      });
    assert.throws(
      () => build(targets.slice(1)),
      (error: unknown) =>
        (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      'a derivative target list that skips a changed row',
    );
    assert.throws(
      () =>
        build([
          {
            ...(targets[0] as JsonObject),
            id: 'f0000000-0000-4000-8000-000000000000',
          },
          ...targets.slice(1),
        ]),
      (error: unknown) =>
        (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
      'a foreign target standing in for a changed row',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The admission and the read stage
// ---------------------------------------------------------------------------------------------

/** Answers the named stage with one scripted answer and every other stage as usual. */
function stageFetch(
  sealed: SealedAliasV2Execution,
  stage: 'preflight' | 'admit' | 'read',
  answer: (input: string, init?: RequestInit) => Promise<ResponseLike>,
  fallback: { reads?: unknown[] } = {},
): FetchLike {
  const marker =
    stage === 'preflight'
      ? ALIAS_V2_PROTOCOL.preflight_command
      : stage === 'admit'
        ? ALIAS_V2_PROTOCOL.admit_command
        : 'cmd_dataset_alias_execution_read_v2';
  return (async (input: string, init?: RequestInit) => {
    if (String(input).includes(marker)) {
      return answer(String(input), init);
    }
    return scriptedFetch(sealed, fallback)(input, init);
  }) as FetchLike;
}

test(
  'an admission that fails with a status, or answers with an unusable proof, recovers by read',
  withSealed(async (sealed) => {
    // A non-200 admission status is reported with that status, and the attempt itself is durable:
    // a later run of the same execution must not post a second admission for it.
    let admits = 0;
    const unavailable = stageFetch(
      sealed,
      'admit',
      async () => {
        admits += 1;
        return jsonResponse({ message: 'service unavailable' }, 503);
      },
      { reads: [readEnvelope(sealed)] },
    );
    const failed = await runAliasV2Protected(
      runOptions(sealed, { waitSeconds: 0, fetchImpl: unavailable }),
    );
    assert.deepEqual(
      [failed.status, failed.code, failed.admission_attempts, admits],
      ['failed', 'ALIAS_V2_ADMIT_HTTP_503', 1, 1],
    );
    const resumed = await runAliasV2Protected(runOptions(sealed, { fetchImpl: unavailable }));
    assert.deepEqual([resumed.status, resumed.admission_attempts, admits], ['passed', 1, 1]);

    // An admission acknowledged with a proof that does not prove a single consumed attempt is not
    // an admission: the run moves to the readback path, posts nothing further, and lets the
    // server's read decide the outcome.
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-admit-proof-'));
    let posts = 0;
    try {
      const recovered = await runAliasV2Protected(
        runOptions(sealed, {
          outDir,
          fetchImpl: stageFetch(
            sealed,
            'admit',
            async () => {
              posts += 1;
              return jsonResponse({
                ...admissionProof(preflightProof(sealed), sealed),
                attempt_count: 2,
              });
            },
            { reads: [readEnvelope(sealed)] },
          ),
        }),
      );
      assert.equal(posts, 1, 'an unusable admission proof is never re-posted');
      assert.deepEqual(
        [recovered.status, recovered.phase, recovered.admission_attempts],
        ['passed', 'applied', 1],
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }),
);

test(
  'a status-only run decides from the server, never from a fresh directory',
  withSealed(async (sealed) => {
    const cases: Array<[string, () => ResponseLike, string, string | null]> = [
      [
        'a coded refusal',
        () => jsonResponse({ ok: false, code: 'ALIAS_V2_REPLAY_CONFLICT', status: 409 }, 409),
        'failed',
        'ALIAS_V2_REPLAY_CONFLICT',
      ],
      ['an applied proof', () => jsonResponse(readEnvelope(sealed)), 'passed', null],
      [
        'an idempotent replay proof',
        () => jsonResponse(readEnvelopeWithProof(sealed, { status: 'idempotent_replay' })),
        'passed',
        null,
      ],
      [
        'a proof that is not this plan',
        () =>
          jsonResponse(
            aliasV2StatusEnvelope(sealed, {
              terminal_proof: {
                ...aliasV2TerminalProof(sealed),
                counts: { ...(sealed.identity.expected as JsonObject), action_count: 1 },
              },
            }),
          ),
        'failed',
        'ALIAS_V2_RESPONSE_COUNT_MISMATCH',
      ],
      [
        'an in-flight read',
        () => jsonResponse(readEnvelope(sealed, { status: 'pending' })),
        'indeterminate',
        'ALIAS_V2_STAGE_UNKNOWN',
      ],
      [
        'a terminal indeterminate execution',
        () => jsonResponse(readEnvelope(sealed, { status: 'indeterminate' })),
        'indeterminate',
        'ALIAS_V2_FIXTURE_INDETERMINATE',
      ],
    ];
    for (const [label, answer, status, code] of cases) {
      // A fresh directory holds no marker: the run must still ask the server rather than report
      // that nothing was admitted.
      const outDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-status-only-'));
      const calls: string[] = [];
      try {
        const report = await runAliasV2Protected(
          runOptions(sealed, {
            outDir,
            commit: false,
            statusOnly: true,
            waitSeconds: 0,
            fetchImpl: stageFetch(sealed, 'read', async () => {
              calls.push('read');
              return answer();
            }),
          }),
        );
        assert.deepEqual([report.status, report.code], [status, code], label);
        assert.deepEqual(
          [calls.length, report.admission_attempts],
          [1, 0],
          `${label}: a status-only run reads once and never admits`,
        );
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }

    // An operator who names no window still runs under the reviewed defaults: the same read
    // decides the run, and no unbounded wait is created by omitting the option.
    const defaultOutDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-status-defaults-'));
    try {
      const report = await runAliasV2Protected(
        runOptions(sealed, {
          outDir: defaultOutDir,
          commit: false,
          statusOnly: true,
          waitSeconds: undefined,
          pollMs: undefined,
          fetchImpl: stageFetch(sealed, 'read', async () => jsonResponse(readEnvelope(sealed))),
        }),
      );
      assert.deepEqual([report.status, report.polls, report.read_attempts], ['passed', 0, 0]);
    } finally {
      rmSync(defaultOutDir, { recursive: true, force: true });
    }
  }),
);

test(
  'the run refuses an ambiguous mode, a non-Error transport failure and an exhausted deadline',
  withSealed(async (sealed) => {
    // Neither commit nor status-only: there is no defined action, so nothing is even read.
    await assert.rejects(
      () =>
        runAliasV2Protected({
          planPath: sealed.planPath,
          freezePath: sealed.freezePath,
          approvalPath: sealed.approvalPath,
          outDir: sealed.directory,
          commit: false,
          statusOnly: false,
          env: buildSupabaseTestEnv({}),
          fetchImpl: (async () => {
            throw new Error('no endpoint is contacted without a mode');
          }) as FetchLike,
        }),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_MODE_REQUIRED',
    );

    // A transport that fails without an Error still reaches the reviewed unknown-outcome path.
    const nonError = await runAliasV2Protected(
      runOptions(sealed, {
        waitSeconds: 0,
        fetchImpl: stageFetch(sealed, 'preflight', async () => {
          throw 'socket hang up';
        }),
      }),
    );
    assert.deepEqual([nonError.status, nonError.code], ['indeterminate', 'ALIAS_V2_STAGE_UNKNOWN']);

    // The deadline is the same bound whether it is measured on the progress clock or the wall
    // clock: neither can be talked into an unbounded wait or a false exhaustion.
    assert.equal(protectedInternals.nowMsExceeded(0, 1, 999, true), false);
    assert.equal(protectedInternals.nowMsExceeded(0, 1, 1_000, true), true);
    assert.equal(protectedInternals.nowMsExceeded(Date.now(), 1, 0, false), false);
    assert.equal(protectedInternals.nowMsExceeded(Date.now() - 5_000, 1, 0, false), true);
    // A body that is absent or blank is not a payload; a JSON body is.
    assert.equal(protectedInternals.parseMaybeJson(undefined), null);
    assert.equal(protectedInternals.parseMaybeJson('   '), null);
    assert.deepEqual(protectedInternals.parseMaybeJson('{"a":1}'), { a: 1 });
  }),
);

test(
  'a source flow property that changed after the freeze cannot ride the old seal',
  withSealed(async (sealed) => {
    // The live source row moving is exactly what the content evidence exists to catch: a name-only
    // change keeps the identity and the unit-group pointer but produces a different binding, so a
    // plan re-derived from the changed row cannot ride a seal that was frozen for the old content.
    const sourceInput = buildAliasV2CohortInput();
    const renamed = JSON.parse(JSON.stringify(sourceInput.source_flow_property)) as AliasV2Row;
    const information = (renamed.json['flowPropertyDataSet'] as JsonObject)[
      'flowPropertiesInformation'
    ] as JsonObject;
    information['dataSetInformation'] = {
      'common:name': { '#text': 'Amount in hour', '@xml:lang': 'en' },
    };
    const replanned = buildAliasV2Plan({ ...sourceInput, source_flow_property: renamed }).plan;
    const digest = (plan: JsonObject): unknown =>
      ((plan['source_evidence'] as JsonObject)['source_flowproperty'] as JsonObject)['sha256'];
    assert.notEqual(digest(replanned), digest(sealed.plan));
    assert.notEqual(replanned['plan_sha256'], sealed.plan['plan_sha256']);
    const replannedPath = path.join(sealed.directory, 'replanned-source-plan.json');
    writeFileSync(replannedPath, `${stableJsonText(replanned)}\n`, { mode: 0o600 });
    const calls: Call[] = [];
    await assert.rejects(
      () =>
        runAliasV2Protected(
          runOptions(sealed, {
            planPath: replannedPath,
            fetchImpl: scriptedFetch(sealed, { calls }),
          }),
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
    );
    assert.deepEqual(calls, [], 'stale source evidence never reaches the network');
  }),
);
