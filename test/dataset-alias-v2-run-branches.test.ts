// The protected run's per-stage behaviour: what it does with a refusal, an unknown transport
// outcome, an unexpected status, a malformed proof, an inconclusive read and a readback that
// never becomes terminal. Each case pins the reviewed outcome, not the implementation.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  runAliasV2Protected,
} from '../src/lib/dataset-alias-v2-protected.js';
import { ALIAS_V2_PROTOCOL } from '../src/lib/dataset-alias-v2-protected-contract.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_PROJECT_REF,
  sealedAliasV2Execution,
  type SealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import { aliasV2StatusEnvelope } from './helpers/alias-v2-status.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

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

type Stage = 'preflight' | 'gate' | 'admit' | 'read';

/** What the transport answers: a response, an unexpected status, or a transport failure. */
type Answer =
  | { kind: 'ok'; body: JsonObject; status?: number }
  | { kind: 'coded'; status: number; code: string }
  | { kind: 'status'; status: number; body?: JsonObject }
  | { kind: 'transport'; reason: string };

function preflightProof(sealed: SealedAliasV2Execution, overrides: JsonObject = {}): JsonObject {
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
    ...overrides,
  };
}

function gateProof(preflight: JsonObject, gate: string, overrides: JsonObject = {}): JsonObject {
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
    ...overrides,
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

/** The actual versioned status envelope of this execution. */
function readEnvelope(sealed: SealedAliasV2Execution, overrides: JsonObject = {}): JsonObject {
  return aliasV2StatusEnvelope(sealed, overrides);
}

/** A transport whose answer per stage is scripted, with the read stage repeating its last answer. */
function transport(
  sealed: SealedAliasV2Execution,
  script: Partial<Record<Stage, Answer[]>>,
): FetchLike {
  const answers = {
    preflight: script.preflight ?? [{ kind: 'ok', body: preflightProof(sealed) }],
    gate: script.gate ?? [
      { kind: 'ok', body: gateProof(preflightProof(sealed), 'primary_support_plan') },
    ],
    admit: script.admit ?? [{ kind: 'ok', body: admissionProof(preflightProof(sealed), sealed) }],
    read: script.read ?? [{ kind: 'ok', body: readEnvelope(sealed, { status: 'pending' }) }],
  } as Record<Stage, Answer[]>;
  const seen: Record<Stage, number> = { preflight: 0, gate: 0, admit: 0, read: 0 };
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: ALIAS_V2_TEST_ACCOUNT.user_id,
        email: ALIAS_V2_TEST_ACCOUNT.email,
      });
    }
    const stage: Stage | null = url.includes(ALIAS_V2_PROTOCOL.preflight_command)
      ? 'preflight'
      : url.includes(ALIAS_V2_PROTOCOL.gate_command)
        ? 'gate'
        : url.includes(ALIAS_V2_PROTOCOL.admit_command)
          ? 'admit'
          : url.includes('cmd_dataset_alias_execution_read_v2')
            ? 'read'
            : null;
    if (stage === null) {
      throw new Error(`Unexpected request: ${url}`);
    }
    const index = Math.min(seen[stage], answers[stage].length - 1);
    seen[stage] += 1;
    const answer = answers[stage][index] as Answer;
    if (answer.kind === 'transport') {
      throw new Error(answer.reason);
    }
    if (answer.kind === 'coded') {
      return jsonResponse({ ok: false, code: answer.code }, answer.status);
    }
    if (answer.kind === 'status') {
      return jsonResponse(answer.body ?? { ok: true }, answer.status);
    }
    const body = answer.body;
    // The gate stage answers for the gate the request asked for, with that gate's own expectation
    // and receipt, so a scripted receipt is valid whichever gate is being captured.
    if (stage === 'gate' && typeof init?.body === 'string') {
      const asked = String((JSON.parse(init.body) as JsonObject)['p_gate_name']);
      const expectations = preflightProof(sealed)['gate_expectations'] as JsonObject;
      const expected = expectations[`${asked}_sha256`];
      return jsonResponse({
        ...body,
        gate: asked,
        expected_sha256: expected,
        observed_sha256: expected,
        receipt_sha256: sha256Json({ gate: asked }),
      });
    }
    return jsonResponse({ ok: true, ...body }, answer.status ?? 200);
  }) as FetchLike;
}

function runOptions(
  sealed: SealedAliasV2Execution,
  fetchImpl: FetchLike,
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
    fetchImpl,
    now: new Date(START),
    sleep: async () => {},
    ...overrides,
  } as Parameters<typeof runAliasV2Protected>[0];
}

function withSealed(body: (sealed: SealedAliasV2Execution) => Promise<void>): () => Promise<void> {
  return async () => {
    const sealed = sealedAliasV2Execution();
    try {
      await body(sealed);
    } finally {
      rmSync(sealed.directory, { recursive: true, force: true });
    }
  };
}

test(
  'a coded refusal at any stage stops the run with the server code',
  withSealed(async (sealed) => {
    const cases: Array<[Stage, string]> = [
      ['preflight', 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST'],
      ['gate', 'ALIAS_V2_DERIVE_MISMATCH'],
      ['admit', 'ALIAS_V2_COUNT_MISMATCH'],
    ];
    for (const [stage, code] of cases) {
      const report = await runAliasV2Protected(
        runOptions(sealed, transport(sealed, { [stage]: [{ kind: 'coded', status: 409, code }] }), {
          outDir: mkdtempSync(path.join(os.tmpdir(), `alias-v2-${stage}-refused-`)),
        }),
      );
      assert.deepEqual(
        [report.status, report.code],
        ['failed', code],
        `${stage}: ${JSON.stringify(report)}`,
      );
      assert.equal(
        report.admission_attempts,
        stage === 'admit' ? 1 : 0,
        `${stage} must not admit when refused before it`,
      );
    }
    // The read stage's coded refusal is adopted as well.
    const readRefused = await runAliasV2Protected(
      runOptions(
        sealed,
        transport(sealed, {
          read: [{ kind: 'coded', status: 409, code: 'ALIAS_V2_REPLAY_CONFLICT' }],
        }),
        { outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-read-refused-')) },
      ),
    );
    assert.deepEqual(
      [readRefused.status, readRefused.code],
      ['failed', 'ALIAS_V2_REPLAY_CONFLICT'],
    );
  }),
);

test(
  'an unknown transport outcome is observed, never retried',
  withSealed(async (sealed) => {
    // Preflight: nothing was posted, so the run reports indeterminate and stops.
    const preflightUnknown = await runAliasV2Protected(
      runOptions(
        sealed,
        transport(sealed, { preflight: [{ kind: 'transport', reason: 'socket hang up' }] }),
        { outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-preflight-unknown-')) },
      ),
    );
    assert.deepEqual(
      [preflightUnknown.status, preflightUnknown.code, preflightUnknown.admission_attempts],
      ['indeterminate', 'ALIAS_V2_STAGE_UNKNOWN', 0],
    );
    // Gate: the admission is never posted.
    const gateUnknown = await runAliasV2Protected(
      runOptions(sealed, transport(sealed, { gate: [{ kind: 'transport', reason: 'reset' }] }), {
        outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-gate-unknown-')),
      }),
    );
    assert.equal(gateUnknown.admission_attempts, 0);
    assert.equal(gateUnknown.status, 'failed');
    // Admission: exactly one POST, then the read stage decides.
    let admitPosts = 0;
    const admitUnknown = await runAliasV2Protected(
      runOptions(
        sealed,
        (async (input: string, init?: RequestInit) => {
          if (String(input).includes(ALIAS_V2_PROTOCOL.admit_command)) {
            admitPosts += 1;
          }
          return transport(sealed, {
            admit: [{ kind: 'transport', reason: 'socket hang up' }],
            read: [{ kind: 'ok', body: readEnvelope(sealed, { status: 'pending' }) }],
          })(input, init);
        }) as FetchLike,
        { outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-admit-unknown-')), waitSeconds: 2 },
      ),
    );
    assert.equal(admitPosts, 1);
    assert.equal(admitUnknown.phase, 'readback_required');
    assert.equal(admitUnknown.status, 'indeterminate');
  }),
);

test(
  'an unexpected HTTP status is reported with its status, not treated as a proof',
  withSealed(async (sealed) => {
    for (const stage of ['preflight', 'gate'] as const) {
      const report = await runAliasV2Protected(
        runOptions(
          sealed,
          transport(sealed, {
            [stage]: [{ kind: 'status', status: 503, body: { message: 'unavailable' } }],
          }),
          { outDir: mkdtempSync(path.join(os.tmpdir(), `alias-v2-${stage}-503-`)) },
        ),
      );
      assert.equal(report.status, 'failed', stage);
      assert.equal(
        String(report.code).includes('503'),
        true,
        `${stage} must report the status it saw: ${String(report.code)}`,
      );
      assert.equal(report.admission_attempts, 0, stage);
    }
  }),
);

test(
  'a malformed proof is refused at whichever stage returned it',
  withSealed(async (sealed) => {
    const cases: Array<[Stage, JsonObject]> = [
      [
        'preflight',
        preflightProof(sealed, {
          simulation: { plan_rows: 1, plan_exchanges: 1, rolled_back: true },
        }),
      ],
      ['gate', gateProof(preflightProof(sealed), 'primary_support_plan', { status: 'failed' })],
    ];
    for (const [stage, body] of cases) {
      const report = await runAliasV2Protected(
        runOptions(sealed, transport(sealed, { [stage]: [{ kind: 'ok', body }] }), {
          outDir: mkdtempSync(path.join(os.tmpdir(), `alias-v2-${stage}-malformed-`)),
        }),
      );
      assert.equal(report.status, 'failed', stage);
      assert.equal(typeof report.code, 'string', stage);
    }
  }),
);

test(
  'an inconclusive read stays inconclusive, and a readback that never settles is bounded',
  withSealed(async (sealed) => {
    // A 5xx read: the run reports indeterminate without claiming the execution failed.
    const inconclusive = await runAliasV2Protected(
      runOptions(
        sealed,
        transport(sealed, {
          read: [{ kind: 'status', status: 502, body: { message: 'bad gateway' } }],
        }),
        { outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-read-502-')), waitSeconds: 1 },
      ),
    );
    assert.equal(inconclusive.status, 'indeterminate');
    assert.equal(inconclusive.admission_attempts, 1);
    // A read that reports the server's own terminal unknown state is published as indeterminate
    // immediately: no further polling, and never another admission.
    let resolvedReads = 0;
    const resolved = await runAliasV2Protected(
      runOptions(
        sealed,
        (async (input: string, init?: RequestInit) => {
          if (String(input).includes('cmd_dataset_alias_execution_read_v2')) {
            resolvedReads += 1;
          }
          return transport(sealed, {
            read: [{ kind: 'ok', body: readEnvelope(sealed, { status: 'indeterminate' }) }],
          })(input, init);
        }) as FetchLike,
        { outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-read-indeterminate-')) },
      ),
    );
    assert.deepEqual(
      [resolved.status, resolved.code, resolved.admission_attempts],
      ['indeterminate', 'ALIAS_V2_FIXTURE_INDETERMINATE', 1],
    );
    assert.equal(resolvedReads, 1);
    // A readback that keeps reporting no durable evidence while the admission is unknown is
    // bounded: the run refuses for review rather than polling forever.
    const neverSettles = await runAliasV2Protected(
      runOptions(
        sealed,
        transport(sealed, {
          admit: [{ kind: 'transport', reason: 'socket hang up' }],
          read: [{ kind: 'transport', reason: 'reset' }],
        }),
        {
          outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-readback-bound-')),
          waitSeconds: 30,
        },
      ),
    );
    assert.equal(neverSettles.status, 'indeterminate');
    assert.equal(neverSettles.read_attempts <= 3, true, String(neverSettles.read_attempts));
    assert.equal(neverSettles.admission_attempts, 1);
  }),
);

test(
  'an admitted execution that never reports durable evidence fails for review',
  withSealed(async (sealed) => {
    const report = await runAliasV2Protected(
      runOptions(sealed, transport(sealed, { read: [{ kind: 'ok', body: {} as JsonObject }] }), {
        outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-not-applied-')),
      }),
    );
    // The bare success envelope carries no proof: the execution has no durable evidence.
    assert.equal(report.status, 'failed');
    assert.equal(report.code, 'ALIAS_V2_EXECUTION_NOT_APPLIED');
  }),
);

test(
  'the run refuses an out-of-range wait and poll before any work',
  withSealed(async (sealed) => {
    await assert.rejects(
      () => runAliasV2Protected(runOptions(sealed, transport(sealed, {}), { waitSeconds: -1 })),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_WAIT_INVALID',
    );
    await assert.rejects(
      () => runAliasV2Protected(runOptions(sealed, transport(sealed, {}), { pollMs: 10 })),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_POLL_INVALID',
    );
  }),
);

test(
  'the seal refuses a paraphrase, a wrong confirmation and foreign approvals',
  withSealed(async (sealed) => {
    const { sealAliasV2ProtectedApproval } = await import('../src/lib/dataset-alias-v2-public.js');
    const requestPath = path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request);
    const request = JSON.parse(readFileSync(requestPath, 'utf8')) as JsonObject;
    const humanApprovalPath = path.join(sealed.directory, 'human.txt');
    writeFileSync(humanApprovalPath, `Approved: ${String(request['approval_text'])}`, {
      mode: 0o600,
    });
    const base = {
      freezePath: sealed.freezePath,
      approvalRequestPath: requestPath,
      humanApprovalPath,
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-seal-')),
      approveFreezeFile: sealed.freezeFileSha256,
      approveRequest: sha256Json({ request: true }),
      approveText: String(request['approval_text_sha256']),
      confirm: ALIAS_V2_TEST_ACCOUNT.email,
      approvedAtUtc: iso(0),
    };
    assert.throws(
      () => sealAliasV2ProtectedApproval(base),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
      'a paraphrase of the approval text is not the approved text',
    );
    // The exact text passes the text check and fails on the request digest instead.
    writeFileSync(humanApprovalPath, String(request['approval_text']), { mode: 0o600 });
    assert.throws(
      () => sealAliasV2ProtectedApproval({ ...base, approveRequest: 'f'.repeat(64) }),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
    );
    assert.throws(
      () => sealAliasV2ProtectedApproval({ ...base, confirm: 'someone-else@example.invalid' }),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
    );
    assert.throws(
      () => sealAliasV2ProtectedApproval({ ...base, approveFreezeFile: 'f'.repeat(64) }),
      (error: unknown) => (error as { code?: string }).code === 'ALIAS_V2_PUBLIC_SEAL_MISMATCH',
    );
  }),
);

test('a plan artefact that is not a versioned plan is refused by the run', async () => {
  const sealed = sealedAliasV2Execution();
  try {
    const notAPlan = path.join(sealed.directory, 'not-a-plan.json');
    writeFileSync(
      notAPlan,
      `${stableJsonText({ schema_version: 'dataset-maintenance-plan.v1' })}\n`,
      {
        mode: 0o600,
      },
    );
    const cases: Array<[string, JsonObject]> = [
      ['foreign schema', { schema_version: 'dataset-maintenance-plan.v1' }],
      [
        'no actions',
        {
          schema_version: 'dataset-alias-plan.v2',
          plan_sha256: 'a'.repeat(64),
          actions: [],
          counts: {},
          target_snapshots: {},
          source_evidence: {},
        },
      ],
      [
        'bad digest',
        {
          schema_version: 'dataset-alias-plan.v2',
          plan_sha256: 'x',
          actions: [{}],
          counts: {},
          target_snapshots: {},
          source_evidence: {},
        },
      ],
      [
        'bad counts',
        {
          schema_version: 'dataset-alias-plan.v2',
          plan_sha256: 'a'.repeat(64),
          actions: [{}],
          counts: { action_count: 1 },
          target_snapshots: {},
          source_evidence: {},
        },
      ],
      [
        'no snapshots',
        {
          schema_version: 'dataset-alias-plan.v2',
          plan_sha256: 'a'.repeat(64),
          actions: [{}],
          counts: {},
          target_snapshots: 'nope',
          source_evidence: {},
        },
      ],
    ];
    for (const [label, value] of cases) {
      const file = path.join(sealed.directory, `plan-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, `${stableJsonText(value)}\n`, { mode: 0o600 });
      await assert.rejects(
        runAliasV2Protected(runOptions(sealed, transport(sealed, {}), { planPath: file })),
        (error: unknown) =>
          (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
        label,
      );
    }
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});
