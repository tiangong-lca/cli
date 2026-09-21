// Protected v2 lifecycle for the current Time alias cohort: the CLI side of the reviewed wire.
//
// The module is the CLI entry's decision layer, and it is deliberately pure: it names the
// approved endpoints, validates a dispatch outcome against the plan it was built from, and
// advances a lifecycle state machine that can never re-admit. Nothing here opens a connection
// or writes anything; the caller performs the dispatch and hands the outcome back in.
//
// The channel is the real protected one, versioned rather than replaced: the CLI prepares,
// passes the three gates and *admits*; the server-side queue then calls the private executor
// under its service-only ACL and the CLI only ever polls the read stage afterwards. There is no
// CLI-side execution stage and no second admission POST — the same shape the v1 capability has.
//
// The safety rules that matter most live here:
//
//   - every accepted proof is plan-bound: the applied plan digest, the derived counts, the audit
//     identities and the readback hash of every single action must equal what this plan built.
//     The frozen v1 constants (`2 / 52 / 59`) are not consulted on this path at all;
//   - an unknown admission outcome is terminal for admission. The only stage the lifecycle
//     accepts afterwards is the read stage, and a read that finds no durable evidence ends in an
//     explicit refusal for review rather than an automatic resubmission.

import { CliError } from './errors.js';
import {
  ALIAS_V2_COUNT_KEYS,
  ALIAS_V2_PREFLIGHT_INVALID_REQUEST,
  ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE,
} from './dataset-alias-v2-execution-request.js';

type JsonObject = Record<string, unknown>;

/** Approved protected endpoints (public `api` surface, protected-only exposure). */
export const ALIAS_V2_ENDPOINTS = {
  preflight: 'cmd_dataset_alias_execution_preflight_v2_guarded',
  gate: 'cmd_dataset_alias_execution_gate_v2_guarded',
  admit: 'cmd_dataset_alias_execution_admit_v2_guarded',
  read: 'cmd_dataset_alias_execution_read_v2',
} as const;

/**
 * Approved private executors. The CLI never calls these: the server-side queue reaches them
 * through the protected admission callback under its service-only ACL and nonce.
 */
export const ALIAS_V2_PRIVATE_EXECUTORS = {
  plan: 'private.cmd_dataset_alias_plan_v2_guarded',
  batch: 'private.cmd_dataset_alias_batch_v2_guarded',
  execute: 'private.cmd_dataset_alias_execution_execute_v2',
} as const;

/** Gate names and window are unchanged from v1; only the identities are version-separated. */
export const ALIAS_V2_GATE_NAMES = [
  'primary_support_plan',
  'execution_unused',
  'derivative_quiescence',
] as const;

export const ALIAS_V2_GATE_WINDOW_SECONDS = 180;

export const ALIAS_V2_AUDIT_COMMANDS = [
  'cmd_dataset_alias_plan_v2_guarded',
  'cmd_dataset_alias_batch_v2_guarded',
] as const;

export const ALIAS_V2_RESPONSE_KEYS = [
  'status',
  'plan_sha256',
  'counts',
  'audit',
  'readback',
] as const;
export const ALIAS_V2_AUDIT_KEYS = ['plan_summary_id', 'batch_summary_ids'] as const;
export const ALIAS_V2_READBACK_KEYS = ['flows', 'processes', 'text_actions'] as const;
export const ALIAS_V2_STATUS_APPLIED = 'applied';
export const ALIAS_V2_STATUS_REPLAY = 'idempotent_replay';
/** The in-flight read: the only two keys the server returns before a terminal proof exists. */
export const ALIAS_V2_STATUS_PENDING = 'pending';

export const ALIAS_V2_LIFECYCLE_REFUSED = 'ALIAS_V2_LIFECYCLE_REFUSED';
export const ALIAS_V2_STAGE_UNKNOWN = 'ALIAS_V2_STAGE_UNKNOWN';
export const ALIAS_V2_RESPONSE_INVALID = 'ALIAS_V2_RESPONSE_INVALID';
export const ALIAS_V2_RESPONSE_COUNT_MISMATCH = 'ALIAS_V2_RESPONSE_COUNT_MISMATCH';
export const ALIAS_V2_RESPONSE_READBACK_MISMATCH = 'ALIAS_V2_RESPONSE_READBACK_MISMATCH';
export const ALIAS_V2_RESPONSE_STATUS_UNEXPECTED = 'ALIAS_V2_RESPONSE_STATUS_UNEXPECTED';
export const ALIAS_V2_REQUEST_TOO_LARGE = ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE;
export const ALIAS_V2_EXECUTION_NOT_APPLIED = 'ALIAS_V2_EXECUTION_NOT_APPLIED';
export const ALIAS_V2_POLL_EXHAUSTED = 'ALIAS_V2_POLL_EXHAUSTED';

/** Server-side refusals the CLI passes through verbatim rather than reinterpreting. */
export const ALIAS_V2_SERVER_REFUSAL_CODES = [
  'ALIAS_V2_COUNT_MISMATCH',
  'ALIAS_V2_REPLAY_CONFLICT',
  'ALIAS_V2_DERIVE_MISMATCH',
  'ALIAS_V2_TEXT_BLOCK_MISMATCH',
  'ALIAS_V2_TEXT_RULE_VIOLATION',
  'ALIAS_V2_UNCERTAINTY_UNSUPPORTED',
  'ALIAS_V2_FACTOR_UNSUPPORTED',
  'ALIAS_V2_PLAN_INVALID',
  ALIAS_V2_PREFLIGHT_INVALID_REQUEST,
] as const;

/** Bounded polling: an observed read is cheap, but it is still bounded and never unbounded. */
export const MAX_READBACK_ATTEMPTS = 3;
export const MAX_POLL_ATTEMPTS = 600;

export type AliasV2Stage = 'preflight' | 'gate' | 'admit' | 'read';

export type AliasV2DispatchOutcome =
  { kind: 'response'; status: number; body: unknown } | { kind: 'unknown'; reason: string };

export type AliasV2StepResult =
  | { kind: 'ok'; stage: AliasV2Stage; body: JsonObject }
  | { kind: 'pending'; stage: AliasV2Stage }
  | { kind: 'applied'; stage: AliasV2Stage; status: string }
  | { kind: 'idempotent_replay'; stage: AliasV2Stage }
  | { kind: 'not_applied' }
  | { kind: 'refused'; status: number; code: string; reason?: string }
  | { kind: 'readback_required'; code: string; reason: string };

export type AliasV2PlanBinding = {
  plan: JsonObject;
  request_id: string;
};

export type AliasV2ClassificationInput = AliasV2PlanBinding & {
  stage: AliasV2Stage;
  outcome: AliasV2DispatchOutcome;
};

export type AliasV2Phase =
  | 'prepared'
  | 'preflight_passed'
  | 'gated'
  | 'admitted'
  | 'applied'
  | 'idempotent_replay'
  | 'readback_required'
  | 'refused';

export type AliasV2Lifecycle = {
  phase: AliasV2Phase;
  request_id: string;
  plan_sha256: string;
  gates: string[];
  admit_attempts: number;
  read_attempts: number;
  polls: number;
  code: string | null;
};

export type AliasV2LifecycleStep = { stage: AliasV2Stage; result: AliasV2StepResult };

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function refused(code: string, status: number, message: string): never {
  throw new CliError(message, { code, exitCode: 2, details: { status } });
}
function resultRefused(status: number, code: string, reason?: string): AliasV2StepResult {
  return { kind: 'refused', status, code, ...(reason === undefined ? {} : { reason }) };
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
function serverCode(body: unknown, fallback: string): string {
  const code = isJsonObject(body) ? body['code'] : null;
  return nonEmptyString(code) ? code : fallback;
}
function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/**
 * Validates a terminal server proof against the plan it claims to have applied. Every field the
 * plan can predict must match exactly; anything else is refused as an invalid response rather
 * than accepted as evidence.
 */
function validateProof(
  body: unknown,
  binding: AliasV2PlanBinding,
): { status: string } | { code: string } {
  if (!isJsonObject(body) || !hasExactKeys(body, ALIAS_V2_RESPONSE_KEYS)) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const status = body['status'];
  if (status !== ALIAS_V2_STATUS_APPLIED && status !== ALIAS_V2_STATUS_REPLAY) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (body['plan_sha256'] !== binding.plan['plan_sha256']) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const counts = body['counts'];
  const planCounts = binding.plan['counts'];
  if (
    !isJsonObject(counts) ||
    !isJsonObject(planCounts) ||
    Object.keys(counts).length !== ALIAS_V2_COUNT_KEYS.length
  ) {
    return { code: ALIAS_V2_RESPONSE_COUNT_MISMATCH };
  }
  for (const key of ALIAS_V2_COUNT_KEYS) {
    if (counts[key] !== planCounts[key]) {
      return { code: ALIAS_V2_RESPONSE_COUNT_MISMATCH };
    }
  }
  const audit = body['audit'];
  if (
    !isJsonObject(audit) ||
    Object.keys(audit).length !== ALIAS_V2_AUDIT_KEYS.length ||
    !nonEmptyString(audit['plan_summary_id']) ||
    !Array.isArray(audit['batch_summary_ids'])
  ) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const batchIds = audit['batch_summary_ids'] as unknown[];
  // One audit batch per table that carries actions; never a fixed v1 constant.
  const actions = binding.plan['actions'] as JsonObject[];
  const textActions = binding.plan['text_actions'] as JsonObject[];
  const expectedBatches = new Set(actions.map((action) => action['table'])).size;
  if (
    batchIds.length !== expectedBatches ||
    !batchIds.every(nonEmptyString) ||
    new Set(batchIds).size !== batchIds.length
  ) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const readback = body['readback'];
  if (
    !isJsonObject(readback) ||
    Object.keys(readback).length !== ALIAS_V2_READBACK_KEYS.length ||
    ALIAS_V2_READBACK_KEYS.some((key) => !Array.isArray(readback[key]))
  ) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const expected = {
    flows: actions.filter((action) => action['table'] === 'flows'),
    processes: actions.filter((action) => action['table'] === 'processes'),
  };
  for (const table of ['flows', 'processes'] as const) {
    const entries = readback[table] as unknown[];
    const rows = expected[table] as JsonObject[];
    if (entries.length !== rows.length) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
    const byKey = new Map(
      entries.map((entry) => [
        isJsonObject(entry) ? `${String(entry['id'])}@${String(entry['version'])}` : '',
        entry,
      ]),
    );
    if (byKey.size !== rows.length) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
    for (const row of rows) {
      const entry = byKey.get(`${String(row['id'])}@${String(row['version'])}`);
      if (
        !isJsonObject(entry) ||
        entry['desired_sha256'] !== row['desired_sha256'] ||
        entry['table'] !== table
      ) {
        return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
      }
    }
  }
  const textEntries = readback['text_actions'] as unknown[];
  if (textEntries.length !== textActions.length) {
    return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
  }
  const textByKey = new Map(
    textEntries.map((entry) => [
      isJsonObject(entry) ? `${String(entry['id'])}@${String(entry['version'])}` : '',
      entry,
    ]),
  );
  if (textByKey.size !== textActions.length) {
    return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
  }
  for (const action of textActions) {
    const entry = textByKey.get(`${String(action['id'])}@${String(action['version'])}`);
    if (!isJsonObject(entry) || entry['after_text'] !== action['after_text']) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
  }
  return { status };
}

function terminalResult(stage: AliasV2Stage, status: string): AliasV2StepResult {
  return status === ALIAS_V2_STATUS_REPLAY
    ? { kind: 'idempotent_replay', stage }
    : { kind: 'applied', stage, status };
}

/**
 * Classifies one dispatch outcome. A response is validated against the plan; an unknown outcome
 * is retryable evidence-free for the read-only stages and terminal for admission.
 */
export function classifyAliasV2Response(input: AliasV2ClassificationInput): AliasV2StepResult {
  const { stage, outcome } = input;
  if (outcome.kind === 'unknown') {
    if (stage === 'admit' || stage === 'read') {
      // Admission and readback are the two stages where an unknown outcome exists: both stay on
      // the readback path, where the only possible next step is another read.
      return { kind: 'readback_required', code: ALIAS_V2_STAGE_UNKNOWN, reason: outcome.reason };
    }
    return resultRefused(0, ALIAS_V2_STAGE_UNKNOWN, outcome.reason);
  }
  const { status, body } = outcome;
  if (status === 200) {
    if (stage === 'preflight' || stage === 'gate') {
      if (!isJsonObject(body)) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      // The preflight answer is the identity-bound token; a gate receipt acknowledges one gate
      // name and, when it carries the binding keys at all, must carry them correctly.
      if (stage === 'preflight') {
        if (
          body['request_id'] !== input.request_id ||
          body['plan_sha256'] !== input.plan['plan_sha256']
        ) {
          return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
        }
      } else if (
        (Object.hasOwn(body, 'request_id') && body['request_id'] !== input.request_id) ||
        (Object.hasOwn(body, 'plan_sha256') && body['plan_sha256'] !== input.plan['plan_sha256'])
      ) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      return { kind: 'ok', stage, body };
    }
    if (stage === 'admit') {
      if (!isJsonObject(body)) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      // Admission may already carry the terminal proof (an earlier attempt of this same request
      // was applied); that is a terminal success, not an admission to queue again.
      if (hasExactKeys(body, ALIAS_V2_RESPONSE_KEYS)) {
        const proof = validateProof(body, input);
        return 'code' in proof
          ? resultRefused(status, proof.code)
          : terminalResult(stage, proof.status);
      }
      if (
        body['request_id'] !== input.request_id ||
        body['plan_sha256'] !== input.plan['plan_sha256']
      ) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      return { kind: 'ok', stage, body };
    }
    if (body === null) {
      // The read stage returns no durable evidence for this request id: the mutation never
      // committed, and the CLI must not turn that into a second admission.
      return { kind: 'not_applied' };
    }
    if (
      isJsonObject(body) &&
      hasExactKeys(body, ['status', 'plan_sha256']) &&
      body['status'] === ALIAS_V2_STATUS_PENDING
    ) {
      return body['plan_sha256'] === input.plan['plan_sha256']
        ? { kind: 'pending', stage }
        : resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
    }
    const proof = validateProof(body, input);
    return 'code' in proof
      ? resultRefused(status, proof.code)
      : terminalResult(stage, proof.status);
  }
  if (status === 400) {
    return resultRefused(status, serverCode(body, ALIAS_V2_PREFLIGHT_INVALID_REQUEST));
  }
  if (status === 413) {
    return resultRefused(status, ALIAS_V2_REQUEST_TOO_LARGE);
  }
  if (status === 409) {
    return resultRefused(status, serverCode(body, 'ALIAS_V2_DRIFT_OR_REPLAY'));
  }
  return resultRefused(status, ALIAS_V2_RESPONSE_STATUS_UNEXPECTED);
}

/** Starts a lifecycle for one client request id bound to one plan digest. */
export function startAliasV2Lifecycle(input: {
  requestId: string;
  planSha256: string;
}): AliasV2Lifecycle {
  if (!nonEmptyString(input.requestId) || !nonEmptyString(input.planSha256)) {
    refused(
      ALIAS_V2_LIFECYCLE_REFUSED,
      2,
      'Alias v2 lifecycle requires the client request id and the plan digest.',
    );
  }
  return {
    phase: 'prepared',
    request_id: input.requestId,
    plan_sha256: input.planSha256,
    gates: [],
    admit_attempts: 0,
    read_attempts: 0,
    polls: 0,
    code: null,
  };
}

/**
 * Advances the lifecycle by one stage result. Every illegal transition — a stage out of order, a
 * gate acknowledged twice or out of order, a second admission attempt, an automatic
 * resubmission after an unknown outcome — is refused here rather than left to the caller.
 */
export function advanceAliasV2Lifecycle(
  state: AliasV2Lifecycle,
  step: AliasV2LifecycleStep,
): AliasV2Lifecycle {
  const { stage, result } = step;
  if (stage === 'read') {
    const observing = state.phase === 'admitted' || state.phase === 'readback_required';
    if (!observing) {
      refused(
        ALIAS_V2_LIFECYCLE_REFUSED,
        2,
        `Alias v2 read stage is not valid in phase ${state.phase}.`,
      );
    }
    const readback = state.phase === 'readback_required';
    if (
      (readback && state.read_attempts >= MAX_READBACK_ATTEMPTS) ||
      (!readback && state.polls >= MAX_POLL_ATTEMPTS)
    ) {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 read stage is exhausted.');
    }
    const observed = readback
      ? { ...state, read_attempts: state.read_attempts + 1 }
      : { ...state, polls: state.polls + 1 };
    if (result.kind === 'applied') {
      return { ...observed, phase: 'applied', code: null };
    }
    if (result.kind === 'idempotent_replay') {
      return { ...observed, phase: 'idempotent_replay', code: null };
    }
    if (result.kind === 'not_applied') {
      return { ...observed, phase: 'refused', code: ALIAS_V2_EXECUTION_NOT_APPLIED };
    }
    if (result.kind === 'refused') {
      return { ...observed, phase: 'refused', code: result.code };
    }
    if (result.kind === 'pending') {
      // In flight: the same phase, one poll counted, and only another read may follow.
      return observed;
    }
    // A read that could not be dispatched stays on the readback path; the caller may retry the
    // read (bounded above) but never the admission.
    return observed;
  }
  if (stage === 'admit') {
    // Checked first: whatever the phase, an admission attempt that already happened is final.
    if (state.admit_attempts !== 0) {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 admission is never attempted twice.');
    }
    if (state.phase !== 'gated') {
      refused(
        ALIAS_V2_LIFECYCLE_REFUSED,
        2,
        `Alias v2 admission is only valid after the gates, not in phase ${state.phase}.`,
      );
    }
    const admitted = { ...state, admit_attempts: 1 };
    if (result.kind === 'ok') {
      return { ...admitted, phase: 'admitted', code: null };
    }
    if (result.kind === 'applied') {
      return { ...admitted, phase: 'applied', code: null };
    }
    if (result.kind === 'idempotent_replay') {
      return { ...admitted, phase: 'idempotent_replay', code: null };
    }
    if (result.kind === 'readback_required') {
      return { ...admitted, phase: 'readback_required', code: result.code };
    }
    if (result.kind === 'refused') {
      return { ...admitted, phase: 'refused', code: result.code };
    }
    refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 admission cannot accept this result.');
  }
  const expectedPhase: Record<'preflight' | 'gate', AliasV2Phase> = {
    preflight: 'prepared',
    gate: 'preflight_passed',
  };
  if (state.phase !== expectedPhase[stage]) {
    refused(
      ALIAS_V2_LIFECYCLE_REFUSED,
      2,
      `Alias v2 ${stage} is not valid in phase ${state.phase}.`,
    );
  }
  if (result.kind === 'refused') {
    return { ...state, phase: 'refused', code: result.code };
  }
  if (stage === 'preflight') {
    if (result.kind !== 'ok') {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 preflight cannot accept this result.');
    }
    return { ...state, phase: 'preflight_passed' };
  }
  const gate = result.kind === 'ok' ? result.body['gate_name'] : null;
  if (gate !== ALIAS_V2_GATE_NAMES[state.gates.length]) {
    refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 gates must be acknowledged once, in order.');
  }
  const gates = [...state.gates, gate as string];
  return gates.length === ALIAS_V2_GATE_NAMES.length
    ? { ...state, gates, phase: 'gated' }
    : { ...state, gates };
}

/** True when the lifecycle is in a terminal phase that publishes nothing further. */
export function isAliasV2Terminal(phase: AliasV2Phase): boolean {
  return (
    phase === 'applied' ||
    phase === 'idempotent_replay' ||
    phase === 'refused' ||
    phase === 'readback_required'
  );
}
