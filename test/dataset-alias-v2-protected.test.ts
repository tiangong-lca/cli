// Library-level tests for the versioned protected artefacts and the protected run's failure
// paths. The CLI-level file next to this one proves the real argv reaches this chain; these
// cases drive the builders and the transport outcomes an operator can actually meet.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import { buildAliasV2Plan } from '../src/lib/dataset-alias-v2-plan.js';
import {
  ALIAS_V2_PROTECTED_CONTRACT,
  __testInternals as protectedInternals,
  aliasV2RequestId,
  assertAliasV2PlanDocument,
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  runAliasV2Protected,
  sealAliasV2Approval,
  type AliasV2Freeze,
} from '../src/lib/dataset-alias-v2-protected.js';
import {
  detectProtectedRunVersion,
  runDatasetMaintenanceProtectedDispatch,
} from '../src/lib/dataset-maintenance-protected-dispatch.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const USER_ID = 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7';
const EMAIL = 'fixture-owner@example.invalid';
const PROJECT_REF = 'qgzvkongdjqiiamzbbts';
const PLAN = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
const BINDING_KEYS = [
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
];

function bindings(): JsonObject {
  return Object.fromEntries(
    BINDING_KEYS.map((key) => [key, sha256Json({ key, plan: PLAN['plan_sha256'] })]),
  );
}

function freezeOptions(overrides: Partial<Parameters<typeof buildAliasV2Freeze>[0]> = {}) {
  return {
    plan: PLAN,
    planFileSha256: 'd'.repeat(64),
    projectRef: PROJECT_REF,
    account: { user_id: USER_ID, email: EMAIL },
    bindings: bindings(),
    derivativeTargets: [{ table: 'flows', id: 'f', version: '00.00.001' }],
    expectedClosure: { roots: 6, references: 33 },
    toolchainEvidenceSha256: 'c'.repeat(64),
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

function rejectsCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === code,
    code,
  );
}

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

/** A sealed execution on disk, ready for the run: plan, freeze and approval artefacts. */
function sealedExecution(): {
  directory: string;
  planPath: string;
  freezePath: string;
  approvalPath: string;
  requestId: string;
  freeze: AliasV2Freeze;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-lib-'));
  const planPath = path.join(directory, 'alias-v2-plan.json');
  const planText = `${stableJsonText(PLAN)}\n`;
  writeFileSync(planPath, planText, { mode: 0o600 });
  const freezeArtifact = buildAliasV2Freeze(
    freezeOptions({ planFileSha256: createHash('sha256').update(planText).digest('hex') }),
  );
  const freezePath = path.join(directory, 'freeze.json');
  writeFileSync(freezePath, freezeArtifact.canonical_file_text, { mode: 0o600 });
  const request = buildAliasV2ApprovalRequest({
    freeze: freezeArtifact.value,
    freezeFileSha256: freezeArtifact.file_sha256,
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
    approvals: { plan: '', freeze: '', request: '', text: '' },
  });
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
  const approvalPath = path.join(directory, 'approval.json');
  writeFileSync(approvalPath, approval.canonical_file_text, { mode: 0o600 });
  return {
    directory,
    planPath,
    freezePath,
    approvalPath,
    freeze: freezeArtifact.value,
    requestId: aliasV2RequestId(
      freezeArtifact.value.plan.plan_sha256,
      freezeArtifact.value.freeze_sha256,
    ),
  };
}

/** A transport that answers one scripted outcome per versioned endpoint, then reads. */
function scriptedFetch(script: {
  binding?: { requestId: string; planSha256: string };
  preflight?: () => Promise<ResponseLike>;
  gate?: () => Promise<ResponseLike>;
  admit?: () => Promise<ResponseLike>;
  read?: () => Promise<ResponseLike>;
  calls?: string[];
}): FetchLike {
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ userId: USER_ID, email: EMAIL });
    }
    script.calls?.push(url);
    const binding = script.binding ?? { requestId: '', planSha256: '' };
    if (url.includes('preflight_v2_guarded')) {
      return script.preflight
        ? script.preflight()
        : jsonResponse({
            ok: true,
            request_id: binding.requestId,
            plan_sha256: binding.planSha256,
            preflight_token: 'token',
          });
    }
    if (url.includes('gate_v2_guarded')) {
      return script.gate
        ? script.gate()
        : jsonResponse({
            ok: true,
            gate_name: (JSON.parse(String(init?.body)) as JsonObject)['p_gate_name'],
          });
    }
    if (url.includes('admit_v2_guarded')) {
      return script.admit
        ? script.admit()
        : jsonResponse({
            ok: true,
            request_id: binding.requestId,
            plan_sha256: binding.planSha256,
          });
    }
    if (url.includes('read_v2')) {
      return script.read ? script.read() : jsonResponse({ ok: true, status: 'pending' });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as FetchLike;
}

function runOptions(sealed: ReturnType<typeof sealedExecution>, overrides: JsonObject = {}) {
  return {
    planPath: sealed.planPath,
    freezePath: sealed.freezePath,
    approvalPath: sealed.approvalPath,
    outDir: sealed.directory,
    commit: true,
    statusOnly: false,
    confirm: EMAIL,
    waitSeconds: 0,
    pollMs: 100,
    env: buildSupabaseTestEnv(),
    fetchImpl: scriptedFetch({
      binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
    }),
    sleep: async () => {},
    ...overrides,
  } as Parameters<typeof runAliasV2Protected>[0];
}

test('the plan document a freeze may bind is validated field by field', () => {
  rejectsCode(() => assertAliasV2PlanDocument(null), 'ALIAS_V2_RESPONSE_INVALID');
  rejectsCode(
    () => assertAliasV2PlanDocument({ schema_version: 'dataset-alias-plan.v1' }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () => assertAliasV2PlanDocument({ schema_version: 'dataset-alias-plan.v2' }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () =>
      assertAliasV2PlanDocument({
        schema_version: 'dataset-alias-plan.v2',
        plan_sha256: 'a'.repeat(64),
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () =>
      assertAliasV2PlanDocument({
        schema_version: 'dataset-alias-plan.v2',
        plan_sha256: 'a'.repeat(64),
        actions: [],
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  assert.equal(assertAliasV2PlanDocument(PLAN), PLAN);
});

test('the freeze binds the plan, its counts, its targets and the fourteen bindings', () => {
  const built = buildAliasV2Freeze(freezeOptions());
  assert.equal(built.value.schema_version, ALIAS_V2_PROTECTED_CONTRACT.freeze_schema);
  assert.deepEqual(built.value.counts, PLAN['counts']);
  assert.equal(built.value.plan.plan_sha256, PLAN['plan_sha256']);
  assert.equal(built.value.freeze_sha256, sha256Json({ ...built.value, freeze_sha256: undefined }));
  assert.equal(built.file_sha256, sha256TextOf(built.canonical_file_text));
  const invalid = 'ALIAS_V2_RESPONSE_INVALID';
  rejectsCode(() => buildAliasV2Freeze(freezeOptions({ planFileSha256: 'nope' })), invalid);
  rejectsCode(() => buildAliasV2Freeze(freezeOptions({ projectRef: ' ' })), invalid);
  rejectsCode(
    () => buildAliasV2Freeze(freezeOptions({ bindings: { ...bindings(), plan_file_sha256: 'x' } })),
    invalid,
  );
  rejectsCode(
    () =>
      buildAliasV2Freeze(
        freezeOptions({ bindings: Object.fromEntries(Object.entries(bindings()).slice(1)) }),
      ),
    invalid,
  );
  rejectsCode(() => buildAliasV2Freeze(freezeOptions({ toolchainEvidenceSha256: 'x' })), invalid);
  rejectsCode(() => buildAliasV2Freeze(freezeOptions({ derivativeTargets: [] })), invalid);
  rejectsCode(
    () => buildAliasV2Freeze(freezeOptions({ account: { user_id: '', email: '' } })),
    invalid,
  );
});

function sha256TextOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('the approval is content-bound and only the owner account can confirm it', () => {
  const freeze = buildAliasV2Freeze(freezeOptions());
  const request = buildAliasV2ApprovalRequest({
    freeze: freeze.value,
    freezeFileSha256: freeze.file_sha256,
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
    approvals: { plan: '', freeze: '', request: '', text: '' },
  });
  assert.equal(request.value.schema_version, 'dataset-alias-execution-approval-request.v2');
  assert.match(request.value.approval_text, /One admission, no automatic retry/u);
  rejectsCode(
    () =>
      buildAliasV2ApprovalRequest({
        freeze: { ...freeze.value, schema_version: 'dataset-alias-execution-freeze.v1' } as never,
        freezeFileSha256: freeze.file_sha256,
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
        approvals: { plan: '', freeze: '', request: '', text: '' },
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () =>
      buildAliasV2ApprovalRequest({
        freeze: freeze.value,
        freezeFileSha256: 'nope',
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
        approvals: { plan: '', freeze: '', request: '', text: '' },
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  const approvals = {
    plan: request.value.plan_sha256,
    freeze: request.value.freeze_sha256,
    request: request.file_sha256,
    text: request.value.approval_text_sha256,
  };
  const sealed = sealAliasV2Approval({
    request: request.value,
    requestFileSha256: request.file_sha256,
    approvals,
    confirm: EMAIL,
    approvedAtUtc: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(
    sealed.value.approval_identity_sha256,
    sha256Json({ ...sealed.value, approval_identity_sha256: undefined }),
  );
  rejectsCode(
    () =>
      sealAliasV2Approval({
        request: {
          ...request.value,
          schema_version: 'dataset-alias-execution-approval-request.v1',
        } as never,
        requestFileSha256: request.file_sha256,
        approvals,
        confirm: EMAIL,
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () =>
      sealAliasV2Approval({
        request: request.value,
        requestFileSha256: 'nope',
        approvals,
        confirm: EMAIL,
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
      }),
    'ALIAS_V2_RESPONSE_INVALID',
  );
  rejectsCode(
    () =>
      sealAliasV2Approval({
        request: request.value,
        requestFileSha256: request.file_sha256,
        approvals,
        confirm: 'someone-else@example.invalid',
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
      }),
    'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
  );
  rejectsCode(
    () =>
      sealAliasV2Approval({
        request: request.value,
        requestFileSha256: request.file_sha256,
        approvals: { ...approvals, text: 'f'.repeat(64) },
        confirm: EMAIL,
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
      }),
    'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
  );
});

test('the run refuses a seal that does not bind its plan, its counts or its approval', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const tamper = (mutate: (freeze: JsonObject) => void): string => {
    const freeze = JSON.parse(readFileSync(sealed.freezePath, 'utf8')) as JsonObject;
    mutate(freeze);
    const target = path.join(
      sealed.directory,
      `freeze-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(target, `${JSON.stringify(freeze)}\n`, { mode: 0o600 });
    return target;
  };
  const cases: Array<[(freeze: JsonObject) => void, string]> = [
    [
      (freeze) => (freeze['schema_version'] = 'dataset-alias-execution-freeze.v1'),
      'ALIAS_V2_RESPONSE_INVALID',
    ],
    [
      (freeze) =>
        (freeze['plan'] = { ...(freeze['plan'] as JsonObject), plan_file_sha256: 'e'.repeat(64) }),
      'ALIAS_V2_RESPONSE_INVALID',
    ],
    [(freeze) => (freeze['counts'] = { action_count: 1 }), 'ALIAS_V2_RESPONSE_INVALID'],
  ];
  for (const [mutate, code] of cases) {
    const freezePath = tamper(mutate);
    await assert.rejects(
      () => runAliasV2Protected(runOptions(sealed, { freezePath })),
      (error: unknown) => (error as { code?: string }).code === code,
    );
  }
  // An approval that describes another freeze, another owner or a different project is refused.
  const approval = JSON.parse(readFileSync(sealed.approvalPath, 'utf8')) as JsonObject;
  for (const mutate of [
    (value: JsonObject) => (value['freeze_sha256'] = 'e'.repeat(64)),
    (value: JsonObject) => (value['project_ref'] = 'other-project'),
    (value: JsonObject) => (value['approval_identity_sha256'] = 'e'.repeat(64)),
  ]) {
    const tampered = { ...approval } as JsonObject;
    mutate(tampered);
    const target = path.join(
      sealed.directory,
      `approval-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(target, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    await assert.rejects(
      () => runAliasV2Protected(runOptions(sealed, { approvalPath: target })),
      (error: unknown) => (error as { code?: string }).code === 'ALIAS_V2_RESPONSE_INVALID',
    );
  }
  // The run must be exactly one mode, and only the owner confirms a commit.
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { commit: false, statusOnly: false })),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_MODE_REQUIRED',
  );
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { confirm: 'someone-else@example.invalid' })),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
  );
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { waitSeconds: 1.5 })),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_WAIT_INVALID',
  );
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { pollMs: 10 })),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_POLL_INVALID',
  );
});

test('a status-only run before any admission reports that nothing was admitted', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const report = await runAliasV2Protected(
    runOptions(sealed, {
      commit: false,
      statusOnly: true,
      confirm: undefined,
      fetchImpl: scriptedFetch({ calls }),
    }),
  );
  assert.deepEqual(
    [report.status, report.phase, report.mode],
    ['not_admitted', 'prepared', 'status_only'],
  );
  assert.deepEqual(calls, []);
  // The run must also refuse a marker that belongs to a different execution.
  const foreign = JSON.parse(readFileSync(sealed.freezePath, 'utf8')) as JsonObject;
  const otherFreeze = path.join(sealed.directory, 'freeze-other.json');
  writeFileSync(otherFreeze, `${JSON.stringify({ ...foreign, freeze_sha256: 'a'.repeat(64) })}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { freezePath: otherFreeze })),
    (error: unknown) => (error as { code?: string }).code === 'ALIAS_V2_RESPONSE_INVALID',
  );
});

test('a server-side refusal is adopted verbatim, at every stage', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  // Preflight refused with the additive code the policy passes through.
  const preflightRefused = await runAliasV2Protected(
    runOptions(sealed, {
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        preflight: async () =>
          jsonResponse({ ok: false, code: 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST', status: 400 }),
      }),
    }),
  );
  assert.deepEqual(
    [preflightRefused.status, preflightRefused.code, preflightRefused.phase],
    ['failed', 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST', 'refused'],
  );
  assert.equal(preflightRefused.admission_attempts, 0);

  // A preflight that is not bound to the client request at all is refused, and one that is
  // bound but answers without a usable token is refused by the run itself.
  const unbound = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-notoken-')),
      fetchImpl: scriptedFetch({ preflight: async () => jsonResponse({ ok: true }) }),
    }),
  );
  assert.deepEqual([unbound.status, unbound.code], ['failed', 'ALIAS_V2_RESPONSE_INVALID']);
  await assert.rejects(
    () =>
      runAliasV2Protected(
        runOptions(sealed, {
          outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-emptytoken-')),
          fetchImpl: scriptedFetch({
            binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
            preflight: async () =>
              jsonResponse({
                ok: true,
                request_id: sealed.requestId,
                plan_sha256: PLAN['plan_sha256'],
                preflight_token: '',
              }),
          }),
        }),
      ),
    (error: unknown) => (error as { code?: string }).code === 'ALIAS_V2_RESPONSE_INVALID',
  );

  // A gate refused inside the window stops the run before any admission.
  const gateRefused = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-gate-')),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        gate: async () =>
          jsonResponse({ ok: false, code: 'ALIAS_V2_DERIVE_MISMATCH', status: 409 }),
      }),
    }),
  );
  assert.deepEqual([gateRefused.status, gateRefused.code], ['failed', 'ALIAS_V2_DERIVE_MISMATCH']);
  assert.equal(gateRefused.admission_attempts, 0);

  // An admission refused with the server's code; then a read refused with its own.
  const admitRefused = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-admit-')),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        admit: async () =>
          jsonResponse({ ok: false, code: 'ALIAS_V2_COUNT_MISMATCH', status: 409 }),
      }),
    }),
  );
  assert.deepEqual(
    [admitRefused.status, admitRefused.code, admitRefused.admission_attempts],
    ['failed', 'ALIAS_V2_COUNT_MISMATCH', 1],
  );
  const readRefused = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-read-')),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        read: async () =>
          jsonResponse({ ok: false, code: 'ALIAS_V2_REPLAY_CONFLICT', status: 409 }),
      }),
    }),
  );
  assert.deepEqual([readRefused.status, readRefused.code], ['failed', 'ALIAS_V2_REPLAY_CONFLICT']);
  // The read stage answering with no durable evidence is a failure for review, not a retry.
  const notApplied = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-empty-')),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        read: async () => jsonResponse({ ok: true }),
      }),
    }),
  );
  assert.deepEqual(
    [notApplied.status, notApplied.code],
    ['failed', 'ALIAS_V2_EXECUTION_NOT_APPLIED'],
  );
});

test('a transport failure inside the readback phase is observed, bounded and never re-admitted', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const report = await runAliasV2Protected(
    runOptions(sealed, {
      waitSeconds: 0,
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        calls,
        admit: async () => {
          throw new Error('socket hang up');
        },
        read: async () => {
          throw new Error('socket reset with a non-JSON explanation');
        },
      }),
    }),
  );
  assert.deepEqual(
    [report.status, report.phase, report.code, report.admission_attempts],
    ['indeterminate', 'readback_required', 'ALIAS_V2_STAGE_UNKNOWN', 1],
  );
  assert.equal(calls.filter((url) => url.includes('admit_v2_guarded')).length, 1);
  // A later status-only run of the same execution reads; it never admits again.
  const resumedCalls: string[] = [];
  const resumed = await runAliasV2Protected(
    runOptions(sealed, {
      commit: false,
      statusOnly: true,
      confirm: undefined,
      waitSeconds: 0,
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        calls: resumedCalls,
        read: async () => jsonResponse({ ok: true }),
      }),
    }),
  );
  assert.deepEqual([resumed.status, resumed.phase], ['failed', 'refused']);
  assert.equal(
    resumedCalls.some((url) => url.includes('admit_v2_guarded')),
    false,
  );
});

test('an HTTP refusal carries the server code through the transport error', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const report = await runAliasV2Protected(
    runOptions(sealed, {
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        preflight: async () => ({
          ...jsonResponse({}),
          ok: false,
          status: 409,
          async text() {
            return JSON.stringify({ ok: false, code: 'ALIAS_V2_REPLAY_CONFLICT' });
          },
        }),
      }),
    }),
  );
  assert.deepEqual([report.status, report.code], ['failed', 'ALIAS_V2_REPLAY_CONFLICT']);
});

test('the success envelope is unwrapped, and anything outside it is refused or observed', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const binding = { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string };
  // The envelope helper is a pure function: a success envelope yields its payload, an envelope
  // with nothing but ok yields nothing, and a domain refusal yields the server code.
  assert.deepEqual(protectedInternals.normalizeEnvelope({ ok: true, status: 'pending' }), {
    kind: 'payload',
    body: { status: 'pending' },
  });
  assert.deepEqual(protectedInternals.normalizeEnvelope({ ok: true }), {
    kind: 'payload',
    body: null,
  });
  assert.deepEqual(protectedInternals.normalizeEnvelope({ ok: false, code: 'X', status: 409 }), {
    kind: 'refusal',
    status: 409,
    code: 'X',
  });
  assert.deepEqual(protectedInternals.normalizeEnvelope({ ok: false }), {
    kind: 'payload',
    body: { ok: false },
  });
  assert.deepEqual(protectedInternals.normalizeEnvelope('nope'), { kind: 'payload', body: 'nope' });
  assert.equal(protectedInternals.parseMaybeJson('<html>'), null);
  assert.equal(protectedInternals.parseMaybeJson('  '), null);
  assert.equal(protectedInternals.parseMaybeJson(undefined), null);
  assert.deepEqual(protectedInternals.parseMaybeJson('{"ok":true}'), { ok: true });
  // The read stage answering with an empty envelope means no durable evidence: a failure for
  // review, never a retry.
  const empty = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-empty-')),
      fetchImpl: scriptedFetch({ binding, read: async () => jsonResponse({ ok: true }) }),
    }),
  );
  assert.deepEqual([empty.status, empty.code], ['failed', 'ALIAS_V2_EXECUTION_NOT_APPLIED']);
  // A read that is refused inside the reviewed policy is adopted; an inconclusive one is an
  // unknown outcome and the run reports it without re-admitting.
  const refused = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-refused-read-')),
      fetchImpl: scriptedFetch({
        binding,
        read: async () =>
          jsonResponse({ ok: false, code: 'ALIAS_V2_REPLAY_CONFLICT', status: 409 }),
      }),
    }),
  );
  assert.deepEqual([refused.status, refused.code], ['failed', 'ALIAS_V2_REPLAY_CONFLICT']);
  const inconclusive = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-inconclusive-')),
      fetchImpl: scriptedFetch({
        binding,
        read: async () => ({
          ...jsonResponse({}),
          ok: false,
          status: 502,
          async text() {
            return 'bad gateway';
          },
        }),
      }),
    }),
  );
  assert.deepEqual([inconclusive.status, inconclusive.phase], ['failed', 'refused']);
});

test('an unfamiliar transport status is reported, not retried', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const report = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-500-')),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        preflight: async () => ({
          ...jsonResponse({}),
          ok: false,
          status: 500,
          async text() {
            return 'internal error';
          },
        }),
      }),
    }),
  );
  assert.deepEqual([report.status, report.code], ['failed', 'ALIAS_V2_RESPONSE_STATUS_UNEXPECTED']);
  assert.equal(report.admission_attempts, 0);
});

test('the version dispatch routes each seal to its own chain and passes the operator options', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const v2 = await runDatasetMaintenanceProtectedDispatch({
    planPath: sealed.planPath,
    freezePath: sealed.freezePath,
    approvalPath: sealed.approvalPath,
    outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-dispatch-')),
    commit: false,
    statusOnly: true,
    waitSeconds: 0,
    pollMs: 250,
    timeoutMs: 7_500,
    now: new Date('2026-09-21T00:00:00.000Z'),
    sleep: async () => {},
    env: buildSupabaseTestEnv(),
    fetchImpl: scriptedFetch({
      binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
    }),
  });
  assert.deepEqual([v2.mode, v2.status], ['status_only', 'not_admitted']);
  // A freeze file that is not a JSON object is refused by the version probe itself.
  const arrayFreeze = path.join(sealed.directory, 'freeze-array.json');
  writeFileSync(arrayFreeze, '[]\n', { mode: 0o600 });
  assert.throws(
    () => detectProtectedRunVersion(arrayFreeze),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_FREEZE_INVALID',
  );
});

test('a plan artifact that is not an object, and a poll that never settles', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const arrayPlan = path.join(sealed.directory, 'plan-array.json');
  writeFileSync(arrayPlan, '[]\n', { mode: 0o600 });
  await assert.rejects(
    () => runAliasV2Protected(runOptions(sealed, { planPath: arrayPlan })),
    (error: unknown) =>
      (error as { code?: string }).code === 'DATASET_MAINTENANCE_ARTIFACT_INVALID',
  );
  // A queued execution that never returns a terminal proof exhausts its poll window.
  const exhausted = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-poll-')),
      timeoutMs: 5_000,
      now: new Date('2026-09-21T00:00:00.000Z'),
      fetchImpl: scriptedFetch({
        binding: { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string },
        read: async () =>
          jsonResponse({ ok: true, status: 'pending', plan_sha256: PLAN['plan_sha256'] }),
      }),
    }),
  );
  assert.deepEqual(
    [exhausted.status, exhausted.code, exhausted.phase, exhausted.polls],
    ['indeterminate', 'ALIAS_V2_POLL_EXHAUSTED', 'admitted', 1],
  );
});

test('a transport failure outside the envelope shape is still read as an unknown outcome', async (t) => {
  const sealed = sealedExecution();
  t.after(() => rmSync(sealed.directory, { recursive: true, force: true }));
  const binding = { requestId: sealed.requestId, planSha256: PLAN['plan_sha256'] as string };
  // A failure whose carried body is a plain string, and one that is not an Error at all.
  const stringDetails = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-stringdetails-')),
      waitSeconds: undefined,
      timeoutMs: undefined,
      fetchImpl: scriptedFetch({
        binding,
        preflight: async () => {
          const error = new Error('HTTP 502 returned from preflight');
          (error as unknown as { details?: unknown }).details = 'bad gateway';
          throw error;
        },
      }),
    }),
  );
  assert.deepEqual(
    [stringDetails.status, stringDetails.code],
    ['failed', 'ALIAS_V2_RESPONSE_STATUS_UNEXPECTED'],
  );
  const notAnError = await runAliasV2Protected(
    runOptions(sealed, {
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-notanerror-')),
      fetchImpl: scriptedFetch({
        binding,
        admit: async () => {
          throw { reason: 'a bare object failure' } as unknown as Error;
        },
      }),
    }),
  );
  assert.deepEqual([notAnError.status, notAnError.phase], ['indeterminate', 'readback_required']);
});
