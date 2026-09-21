// Contract tests for the Length*time profile inside the shared protected lifecycle.
//
// Each test pins one thing the shared engine must do for this second profile without widening the
// first: the closed discriminator, the profile-specific freeze projection, the profile-named human
// approval text, and the terminal-proof binding of a profile that has no text action at all.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  assertAliasV2CanonicalArtifact,
  assertAliasV2PlanDocument,
  assertAliasV2Bindings,
  assertProtectedPlanDocument,
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  parseAliasV2Approval,
  parseAliasV2Freeze,
  protectedTargetSnapshots,
  runAliasV2Protected,
  type AliasV2ProtectedReport,
} from '../src/lib/dataset-alias-v2-protected.js';
import {
  ALIAS_V2_PROTOCOL,
  type AliasV2ExecutionIdentity,
} from '../src/lib/dataset-alias-v2-protected-contract.js';
import {
  LENGTH_TIME_PLAN_INVALID,
  assertLengthTimePlanDocument,
  buildLengthTimePlan,
  lengthTimeTargetSnapshots,
  protectedPlanProfile,
  type LengthTimePlanInput,
} from '../src/lib/dataset-length-time-plan.js';
import { deriveAliasV2Sets } from '../src/lib/dataset-alias-v2-public.js';
import { buildAliasV2Plan } from '../src/lib/dataset-alias-v2-plan.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_APPROVED_AT,
  aliasV2DerivativeTargets,
  aliasV2Sets,
  sealedAliasV2Execution,
  sealedLengthTimeExecution,
  type SealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import { buildLengthTimePlanInput } from './fixtures/length-time-cohort.js';
import {
  aliasV2NotAdmittedEnvelope,
  aliasV2StatusEnvelope,
  aliasV2TerminalProof,
} from './helpers/alias-v2-status.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const TEST_PROJECT_REF = 'qgzvkongdjqiiamzbbts';
const START = Date.parse('2026-09-21T00:00:00.000Z');
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

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    assert.equal(typeof code, 'string', `expected a coded refusal, got ${String(error)}`);
    return code as string;
  }
  throw new Error('expected the call to refuse');
}

/** The fixture Length plan, optionally with one mutation applied for a refusal case. */
function lengthPlan(mutate?: (plan: JsonObject) => void): JsonObject {
  const plan = buildLengthTimePlan(
    buildLengthTimePlanInput() as unknown as LengthTimePlanInput,
  ).plan;
  if (mutate !== undefined) {
    mutate(plan);
  }
  return plan;
}

/** The freeze the public stage would build for one plan, through the shared builder. */
function freezeOf(plan: JsonObject): ReturnType<typeof buildAliasV2Freeze>['value'] {
  return buildAliasV2Freeze({
    plan,
    planFileSha256: sha256Json(plan),
    projectRef: TEST_PROJECT_REF,
    account: ALIAS_V2_TEST_ACCOUNT,
    sets: aliasV2Sets(plan['plan_sha256']),
    derivativeTargets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
  }).value;
}

// ---------------------------------------------------------------------------------------------
// The closed discriminator
// ---------------------------------------------------------------------------------------------

test('one closed discriminator selects the profile and refuses everything else', () => {
  const timePlan = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
  const lengthTimePlan = lengthPlan();
  assert.equal(protectedPlanProfile(timePlan), 'alias_v2');
  assert.equal(protectedPlanProfile(lengthTimePlan), 'length_time_v1');
  for (const foreign of [
    null,
    undefined,
    7,
    'dataset-alias-plan.v2',
    [],
    {},
    { schema_version: 7 },
  ]) {
    assert.equal(protectedPlanProfile(foreign), null);
  }
  assert.equal(assertProtectedPlanDocument(timePlan).profile, 'alias_v2');
  assert.equal(assertProtectedPlanDocument(lengthTimePlan).profile, 'length_time_v1');
  // Each profile's own predicate stays closed: neither accepts the other's document.
  assert.equal(
    codeOf(() => assertAliasV2PlanDocument(lengthTimePlan)),
    'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
  );
  assert.equal(
    codeOf(() => assertLengthTimePlanDocument(timePlan)),
    LENGTH_TIME_PLAN_INVALID,
  );
  assert.equal(
    codeOf(() => assertProtectedPlanDocument({ schema_version: 'dataset-other-plan.v1' })),
    'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
  );
});

test('the Length plan predicate refuses every widened or malformed document', () => {
  const cases: [string, (plan: JsonObject) => void][] = [
    ['an extra top-level key', (plan) => (plan['dimensions'] = [])],
    ['a missing key', (plan) => delete plan['flow_snapshots']],
    ['a foreign visibility', (plan) => (plan['target_visibility'] = 'public')],
    ['a non-uuid actor', (plan) => (plan['actor_id'] = 'actor')],
    ['a malformed plan digest', (plan) => (plan['plan_sha256'] = 'nope')],
    ['a missing expected block', (plan) => delete plan['expected']],
    ['a null expected block', (plan) => (plan['expected'] = null)],
    ['a missing count key', (plan) => delete (plan['expected'] as JsonObject)['audit_count']],
    ['a quoted count', (plan) => ((plan['expected'] as JsonObject)['audit_count'] = '15')],
    ['a negative count', (plan) => ((plan['expected'] as JsonObject)['audit_count'] = -1)],
    ['no flow snapshots', (plan) => (plan['flow_snapshots'] = [])],
    [
      'a four-key flow snapshot',
      (plan) => (((plan['flow_snapshots'] as JsonObject[])[0] as JsonObject)['extra'] = 'x'),
    ],
    [
      'a malformed target group',
      (plan) => ((plan['target_unit_group'] as JsonObject)['sha256'] = 'x'),
    ],
    [
      'a widened source evidence',
      (plan) => ((plan['source_evidence'] as JsonObject)['cohort'] = 'x'),
    ],
    ['no actions', (plan) => (plan['actions'] = [])],
    [
      'a non-process action',
      (plan) => (((plan['actions'] as JsonObject[])[0] as JsonObject)['table'] = 'flows'),
    ],
    [
      'an incomplete action',
      (plan) => delete ((plan['actions'] as JsonObject[])[0] as JsonObject)['mutation'],
    ],
    [
      'a malformed action digest',
      (plan) => (((plan['actions'] as JsonObject[])[0] as JsonObject)['before_sha256'] = 'x'),
    ],
    [
      'an action without its functional-unit text',
      (plan) => {
        const action = (plan['actions'] as JsonObject[])[0] as JsonObject;
        const before = action['expected_json_ordered'] as JsonObject;
        delete (
          ((before['processDataSet'] as JsonObject)['processInformation'] as JsonObject)[
            'quantitativeReference'
          ] as JsonObject
        )['functionalUnitOrOther'];
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    assert.equal(
      codeOf(() => assertLengthTimePlanDocument(lengthPlan(mutate))),
      LENGTH_TIME_PLAN_INVALID,
      label,
    );
  }
  // The unmutated document is exactly what the predicate accepts.
  const plan = lengthPlan();
  assert.equal(assertLengthTimePlanDocument(plan)['plan_sha256'], plan['plan_sha256']);
});

// ---------------------------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------------------------

test('the freeze carries the fixed target-snapshot projection and the plan counts', () => {
  const plan = lengthPlan();
  const freeze = parseAliasV2Freeze(freezeOf(plan));
  assert.deepEqual(freeze.target_snapshots, {
    flowproperty: plan['target_flow_property'],
    unitgroup: plan['target_unit_group'],
  });
  assert.deepEqual(freeze.target_snapshots, lengthTimeTargetSnapshots(plan));
  assert.deepEqual(freeze.target_snapshots, protectedTargetSnapshots(plan));
  assert.deepEqual(freeze.expected, plan['expected']);
  assert.deepEqual(freeze.source_evidence, plan['source_evidence']);
  assert.equal(freeze.plan.plan_sha256, plan['plan_sha256']);
  assert.equal(freeze.freeze_sha256, sha256Json({ ...freeze, freeze_sha256: undefined }));
  assert.equal(freeze.policy.max_admit_posts, 1);
  assert.equal(freeze.derivative_targets.length, 13);
  assert.equal(
    freeze.derivative_targets.every((target) => target.table === 'processes'),
    true,
  );
  // The Time profile's own projection is untouched.
  const timePlan = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
  assert.deepEqual(protectedTargetSnapshots(timePlan), timePlan['target_snapshots']);
});

test('a derivative target set that is not exactly the plan rows refuses', () => {
  const plan = lengthPlan();
  const targets = aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id);
  const build = (derivativeTargets: JsonObject[]): unknown =>
    buildAliasV2Freeze({
      plan,
      planFileSha256: sha256Json(plan),
      projectRef: TEST_PROJECT_REF,
      account: ALIAS_V2_TEST_ACCOUNT,
      sets: aliasV2Sets(plan['plan_sha256']),
      derivativeTargets,
    });
  assert.equal(
    codeOf(() => build(targets.slice(0, 12))),
    'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
  );
  assert.equal(
    codeOf(() =>
      build([
        ...targets.slice(0, 12),
        { ...(targets[0] as JsonObject), id: '5c1f4e5e-0000-4000-8000-000000000000' },
      ]),
    ),
    'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
  );
  assert.equal(build(targets) ? 'built' : 'built', 'built');
});

test('the support snapshot set covers the read-only flows and the canonical targets', () => {
  const plan = lengthPlan();
  const sets = deriveAliasV2Sets({
    plan,
    derivativeTargets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
    toolchainEvidenceSha256: 'f'.repeat(64),
  });
  assert.equal(
    sets['support_snapshot_set_sha256'],
    sha256Json({
      flow_snapshots: plan['flow_snapshots'],
      target_snapshots: lengthTimeTargetSnapshots(plan),
    }),
  );
  // The rewrite set is the derived instance table, and the hash sets cover every action.
  assert.equal(
    sets['exchange_rewrite_set_sha256'],
    sha256Json(
      (plan['actions'] as JsonObject[]).map(
        (action) => (action['mutation'] as JsonObject)['exchanges'],
      ),
    ),
  );
  assert.equal(
    sets['before_hash_set_sha256'],
    sha256Json(
      (plan['actions'] as JsonObject[])
        .map((action) => String(action['before_sha256']))
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
  assert.equal(sets['alias_plan_request_sha256'], sha256Json({ ...plan, plan_sha256: undefined }));
  assert.equal(
    sets['derivative_target_set_sha256'],
    sha256Json(
      aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id)
        .map(
          (target) =>
            `${String(target['table'])}:${String(target['id'])}@${String(target['version'])}`,
        )
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
});

test('the human approval text names the profile the operator is approving', () => {
  const plan = lengthPlan();
  const freeze = freezeOf(plan);
  const request = buildAliasV2ApprovalRequest({
    freeze,
    freezeFileSha256: sha256Json(freeze),
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
    profile: 'length_time_v1',
  });
  assert.match(
    request.value.approval_text,
    new RegExp(`^Approved Length\\*time plan ${plan['plan_sha256'] as string} `, 'u'),
  );
  assert.match(request.value.approval_text, /owner-draft visibility only\.$/u);
  assert.match(request.value.approval_text, /Counts: \{.*"text_action_count":0.*\}\. /u);
  // The Time profile's own text is unchanged.
  const timePlan = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
  const timeRequest = buildAliasV2ApprovalRequest({
    freeze: freezeOf(timePlan),
    freezeFileSha256: sha256Json(freezeOf(timePlan)),
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
    profile: 'alias_v2',
  });
  assert.match(
    timeRequest.value.approval_text,
    new RegExp(`^Approved Time alias v2 plan ${timePlan['plan_sha256'] as string} `, 'u'),
  );
});

test('the binding proof refuses a freeze that projected different target snapshots', () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const approval = parseAliasV2Approval(
      JSON.parse(readFileSync(sealed.approvalPath, 'utf8')) as unknown,
    );
    const identity: AliasV2ExecutionIdentity = assertAliasV2Bindings({
      plan: sealed.plan,
      planFileSha256: sealed.planFileSha256,
      freeze: sealed.freeze,
      freezeFileSha256: sealed.freezeFileSha256,
      approval,
      approvalFileSha256: sealed.approvalFileSha256,
      approveExecution: sealed.approveExecution,
    });
    assert.equal(identity.plan_sha256, sealed.plan['plan_sha256']);
    assert.equal(identity.expected['action_count'], 13);
    // A freeze that bound some other projection is refused against the same plan.
    assert.equal(
      codeOf(() =>
        assertAliasV2Bindings({
          plan: sealed.plan,
          planFileSha256: sealed.planFileSha256,
          freeze: {
            ...sealed.freeze,
            target_snapshots: { flowproperty: sealed.freeze.target_snapshots['unitgroup'] },
          },
          freezeFileSha256: sealed.freezeFileSha256,
          approval,
          approvalFileSha256: sealed.approvalFileSha256,
          approveExecution: sealed.approveExecution,
        }),
      ),
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

type Call = { url: string; body: JsonObject };

/** The strict preflight proof the server returns for this identity. */
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
    net_request_id: '50018',
    attempt_consumed: true,
    retry_allowed: false,
  };
}

/** A transport that answers the real shared endpoints and records every request it sees. */
function scriptedFetch(
  sealed: SealedAliasV2Execution,
  options: { calls?: Call[]; reads?: unknown[]; admit?: 'ok' | 'unknown' } = {},
): FetchLike {
  const calls = options.calls ?? [];
  const preflight = preflightProof(sealed);
  let readIndex = 0;
  return (async (input: string, init?: RequestInit) => {
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
      return jsonResponse(gateProof(preflight, String(body['p_gate_name'])));
    }
    if (url.includes(ALIAS_V2_PROTOCOL.admit_command)) {
      if (options.admit === 'unknown') {
        throw new Error('socket hang up');
      }
      return jsonResponse(admissionProof(preflight, sealed));
    }
    if (url.includes('cmd_dataset_alias_execution_read_v2')) {
      const value = options.reads?.[Math.min(readIndex, (options.reads ?? []).length - 1)];
      readIndex += 1;
      return jsonResponse({ ok: true, ...(value as JsonObject) });
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
      TIANGONG_LCA_API_BASE_URL: `https://${TEST_PROJECT_REF}.supabase.co/functions/v1`,
    }),
    fetchImpl: scriptedFetch(sealed, { reads: [aliasV2StatusEnvelope(sealed)] }),
    now: new Date(START),
    sleep: async () => {},
    ...overrides,
  } as Parameters<typeof runAliasV2Protected>[0];
}

/**
 * A passed report must always bind this exact plan and its counts; the gate list and the single
 * admission only exist on an invocation that actually ran those stages — a status-only inspection
 * or a resume from a durable marker observes the server without them.
 */
function assertPassed(
  report: AliasV2ProtectedReport,
  sealed: SealedAliasV2Execution,
  stages: { gated?: boolean; admissionAttempts?: number } = {},
): void {
  assert.equal(report.status, 'passed');
  assert.equal(report.plan_sha256, sealed.plan['plan_sha256']);
  assert.deepEqual(report.expected, sealed.plan['expected']);
  if (stages.gated === false) {
    assert.equal(report.admission_attempts, stages.admissionAttempts ?? 0);
    assert.deepEqual(report.gates, []);
    return;
  }
  assert.equal(report.admission_attempts, 1);
  assert.deepEqual(report.gates, [
    'primary_support_plan',
    'execution_unused',
    'derivative_quiescence',
  ]);
}

test('a Length execution commits through the shared lifecycle and passes on the observed proof', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const calls: Call[] = [];
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          calls,
          reads: [
            aliasV2StatusEnvelope(sealed, { status: 'pending' }),
            aliasV2StatusEnvelope(sealed),
          ],
        }),
      }),
    );
    assertPassed(report, sealed);
    // The admission carries exactly the five reviewed keys, never the preflight envelope.
    const admitCalls = calls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command));
    assert.equal(admitCalls.length, 1);
    assert.deepEqual(Object.keys((admitCalls[0] as Call).body), ['p_request']);
    assert.deepEqual(Object.keys((admitCalls[0] as Call).body['p_request'] as JsonObject).sort(), [
      'gate_results',
      'preflight_proof_sha256',
      'preflight_token',
      'request_id',
      'schema_version',
    ]);
    // The preflight request carries the Length plan itself, not a rewritten one.
    const preflightCalls = calls.filter((call) =>
      call.url.includes(ALIAS_V2_PROTOCOL.preflight_command),
    );
    assert.equal(preflightCalls.length, 1);
    const sent = (preflightCalls[0] as Call).body['p_request'] as JsonObject;
    assert.deepEqual(sent['plan'], sealed.plan);
    assert.equal((sent['plan'] as JsonObject)['schema_version'], 'dataset-length-time-plan.v1');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the terminal proof of a Length execution binds the before-image functional unit text', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    // A readback whose functional-unit text drifted from the plan's before image is refused: this
    // profile has no text action, so the before text is the only admissible one.
    const drifted = aliasV2TerminalProof(sealed);
    const rows = (drifted['readback'] as JsonObject)['rows'] as JsonObject[];
    (rows[0] as JsonObject)['functional_unit_text'] = '1 my';
    const refused = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          reads: [aliasV2StatusEnvelope(sealed, { terminal_proof: drifted })],
        }),
      }),
    );
    assert.equal(refused.status, 'failed');
    assert.equal(refused.code, 'ALIAS_V2_RESPONSE_READBACK_MISMATCH');
    // The same proof with the before text is accepted.
    const accepted = await runAliasV2Protected(
      runOptions(sealed, {
        outDir: `${sealed.directory}/accepted`,
        fetchImpl: scriptedFetch(sealed, { reads: [aliasV2StatusEnvelope(sealed)] }),
      }),
    );
    assertPassed(accepted, sealed);
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('an envelope for another plan identity is refused, not accepted as this execution', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          reads: [aliasV2StatusEnvelope(sealed, { plan_sha256: 'e'.repeat(64) })],
        }),
      }),
    );
    assert.equal(report.status, 'failed');
    assert.equal(report.code, 'ALIAS_V2_RESPONSE_INVALID');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('an unknown admission reply is never re-admitted and ends in the read path', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const calls: Call[] = [];
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          calls,
          admit: 'unknown',
          reads: [aliasV2StatusEnvelope(sealed, { status: 'pending' })],
        }),
      }),
    );
    assert.equal(report.status, 'indeterminate');
    assert.equal(report.admission_attempts, 1);
    assert.equal(
      calls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)).length,
      1,
    );
    // The durable marker proves exactly one admission was posted, so a resume only observes.
    const resumedCalls: Call[] = [];
    const resumed = await runAliasV2Protected(
      runOptions(sealed, {
        fetchImpl: scriptedFetch(sealed, {
          calls: resumedCalls,
          reads: [aliasV2StatusEnvelope(sealed)],
        }),
      }),
    );
    // The marker proves exactly one admission was posted even though this invocation never posted.
    assertPassed(resumed, sealed, { gated: false, admissionAttempts: 1 });
    assert.equal(
      resumedCalls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.admit_command)).length,
      0,
    );
    assert.equal(
      resumedCalls.filter((call) => call.url.includes(ALIAS_V2_PROTOCOL.preflight_command)).length,
      0,
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('a status-only inspection of a Length execution reports the authoritative answer', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const report = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        fetchImpl: scriptedFetch(sealed, { reads: [aliasV2StatusEnvelope(sealed)] }),
      }),
    );
    assertPassed(report, sealed, { gated: false });
    assert.equal(report.mode, 'status_only');
    // With no marker and no ledger row, the same command reports no admission rather than guessing.
    const absent = await runAliasV2Protected(
      runOptions(sealed, {
        commit: false,
        statusOnly: true,
        approveExecution: undefined,
        confirm: undefined,
        outDir: `${sealed.directory}/fresh`,
        fetchImpl: scriptedFetch(sealed, { reads: [aliasV2NotAdmittedEnvelope(sealed)] }),
      }),
    );
    assert.equal(absent.status, 'not_admitted');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('a foreign freeze never authorises a Length run', async () => {
  const sealed = sealedLengthTimeExecution();
  const timeSealed = sealedAliasV2Execution();
  try {
    // The local binding proof refuses before any fetch: a foreign freeze never reaches the wire.
    await assert.rejects(
      () =>
        runAliasV2Protected(
          runOptions(sealed, {
            freezePath: timeSealed.freezePath,
            fetchImpl: scriptedFetch(sealed, { reads: [aliasV2StatusEnvelope(sealed)] }),
          }),
        ),
      (error: unknown) =>
        (error as { code?: string }).code === 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
    rmSync(timeSealed.directory, { recursive: true, force: true });
  }
});

test('a plan file that is not the canonical serialisation of its content is refused', async () => {
  const sealed = sealedLengthTimeExecution();
  try {
    const planText = readFileSync(sealed.planPath, 'utf8');
    assert.equal(planText, `${stableJsonText(sealed.plan)}\n`);
    // The freeze stage re-reads the exact bytes it binds: reformatted (but content-identical)
    // bytes are not the bundle this execution sealed, so they are refused before any remote call.
    writeFileSync(sealed.planPath, `${JSON.stringify(sealed.plan)}\n`, { mode: 0o600 });
    assert.equal(
      codeOf(() =>
        assertAliasV2CanonicalArtifact({
          label: 'Length*time plan',
          text: readFileSync(sealed.planPath, 'utf8'),
          value: sealed.plan,
        }),
      ),
      'ALIAS_V2_PROTECTED_ARTIFACT_INVALID',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});
