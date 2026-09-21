// Protected v2 lifecycle for the current Time alias cohort: the CLI side of the reviewed wire.
//
// The module is the CLI entry's decision layer, and it is deliberately pure: it names the
// approved endpoints, validates a dispatch outcome against the plan it was built from, and
// advances a lifecycle state machine that can never re-execute. Nothing here opens a connection
// or writes anything; the caller performs the dispatch and hands the outcome back in.
//
// The two safety rules that matter most live here:
//
//   - every accepted proof is plan-bound: the applied plan digest, the derived counts, the audit
//     identities and the readback hash of every single action must equal what this plan built.
//     The frozen v1 constants (`2 / 52 / 59`) are not consulted on this path at all;
//   - an unknown outcome is terminal for execution. The only stage the lifecycle accepts after
//     an unknown execute outcome is the read stage, and a read that finds no durable evidence
//     ends in an explicit refusal for review rather than an automatic resubmission. Nothing in
//     this module can ever issue a second execution attempt.

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

/** Approved private executors: never granted, reached only from the protected lifecycle. */
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

export const ALIAS_V2_LIFECYCLE_REFUSED = 'ALIAS_V2_LIFECYCLE_REFUSED';
export const ALIAS_V2_STAGE_UNKNOWN = 'ALIAS_V2_STAGE_UNKNOWN';
export const ALIAS_V2_RESPONSE_INVALID = 'ALIAS_V2_RESPONSE_INVALID';
export const ALIAS_V2_RESPONSE_COUNT_MISMATCH = 'ALIAS_V2_RESPONSE_COUNT_MISMATCH';
export const ALIAS_V2_RESPONSE_READBACK_MISMATCH = 'ALIAS_V2_RESPONSE_READBACK_MISMATCH';
export const ALIAS_V2_RESPONSE_STATUS_UNEXPECTED = 'ALIAS_V2_RESPONSE_STATUS_UNEXPECTED';
export const ALIAS_V2_REQUEST_TOO_LARGE = ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE;
export const ALIAS_V2_EXECUTION_NOT_APPLIED = 'ALIAS_V2_EXECUTION_NOT_APPLIED';

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

export const MAX_READBACK_ATTEMPTS = 3;

export type AliasV2Stage = 'preflight' | 'gate' | 'admit' | 'execute' | 'read';

export type AliasV2DispatchOutcome =
  { kind: 'response'; status: number; body: unknown } | { kind: 'unknown'; reason: string };

export type AliasV2StepResult =
  | { kind: 'ok'; stage: AliasV2Stage; body: JsonObject }
  | { kind: 'applied'; stage: AliasV2Stage; status: string }
  | { kind: 'idempotent_replay'; stage: AliasV2Stage }
  | { kind: 'not_applied' }
  | { kind: 'refused'; status: number; code: string }
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
  execute_attempts: number;
  readback_attempts: number;
  code: string | null;
};

export type AliasV2LifecycleStep = { stage: AliasV2Stage; result: AliasV2StepResult };

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function refused(code: string, status: number, message: string): never {
  throw new CliError(message, { code, exitCode: 2, details: { status } });
}
function resultRefused(status: number, code: string): AliasV2StepResult {
  return { kind: 'refused', status, code };
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
function serverCode(body: unknown, fallback: string): string {
  const code = isJsonObject(body) ? body['code'] : null;
  return nonEmptyString(code) ? code : fallback;
}

/**
 * Validates a server proof against the plan it claims to have applied. Every field the plan can
 * predict must match exactly; anything else is refused as an invalid response rather than
 * accepted as evidence.
 */
function validateProof(
  body: unknown,
  binding: AliasV2PlanBinding,
): { status: string } | { code: string } {
  if (!isJsonObject(body)) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const keys = Object.keys(body);
  if (keys.length !== ALIAS_V2_RESPONSE_KEYS.length) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  for (const key of ALIAS_V2_RESPONSE_KEYS) {
    if (!Object.hasOwn(body, key)) {
      return { code: ALIAS_V2_RESPONSE_INVALID };
    }
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
    flows: actions.filter((action) => (action as JsonObject)['table'] === 'flows'),
    processes: actions.filter((action) => (action as JsonObject)['table'] === 'processes'),
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
  for (const action of textActions as JsonObject[]) {
    const entry = textByKey.get(`${String(action['id'])}@${String(action['version'])}`);
    if (!isJsonObject(entry) || entry['after_text'] !== action['after_text']) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
  }
  return { status };
}

/**
 * Classifies one dispatch outcome. A response is validated against the plan; an unknown outcome
 * is retryable evidence-free for the read-only stages and terminal for execution.
 */
export function classifyAliasV2Response(input: AliasV2ClassificationInput): AliasV2StepResult {
  const { stage, outcome } = input;
  if (outcome.kind === 'unknown') {
    if (stage === 'execute' || stage === 'read') {
      // Execution and readback are the two stages where an unknown outcome exists: both stay in
      // the readback phase, where the only possible next step is another read.
      return { kind: 'readback_required', code: ALIAS_V2_STAGE_UNKNOWN, reason: outcome.reason };
    }
    return resultRefused(0, ALIAS_V2_STAGE_UNKNOWN);
  }
  const { status, body } = outcome;
  if (status === 200) {
    if (stage === 'preflight' || stage === 'gate' || stage === 'admit') {
      if (!isJsonObject(body)) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      // Admission may already carry the executed proof (the plan was applied by an earlier
      // attempt of this same request); that is a terminal success, not an admission to execute.
      if (
        stage === 'admit' &&
        Object.keys(body).length === ALIAS_V2_RESPONSE_KEYS.length &&
        ALIAS_V2_RESPONSE_KEYS.every((key) => Object.hasOwn(body, key))
      ) {
        const proof = validateProof(body, input);
        if ('code' in proof) {
          return resultRefused(status, proof.code);
        }
        return proof.status === ALIAS_V2_STATUS_REPLAY
          ? { kind: 'idempotent_replay', stage }
          : { kind: 'applied', stage, status: proof.status };
      }
      if (
        body['request_id'] !== input.request_id ||
        body['plan_sha256'] !== input.plan['plan_sha256']
      ) {
        return resultRefused(status, ALIAS_V2_RESPONSE_INVALID);
      }
      return { kind: 'ok', stage, body };
    }
    if (stage === 'read' && body === null) {
      // The read stage returns no durable evidence for this request id: the mutation never
      // committed, and the CLI must not turn that into a second attempt.
      return { kind: 'not_applied' };
    }
    const proof = validateProof(body, input);
    if ('code' in proof) {
      return resultRefused(status, proof.code);
    }
    return proof.status === ALIAS_V2_STATUS_REPLAY
      ? { kind: 'idempotent_replay', stage }
      : { kind: 'applied', stage, status: proof.status };
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
    execute_attempts: 0,
    readback_attempts: 0,
    code: null,
  };
}

/**
 * Advances the lifecycle by one stage result. Every illegal transition — a stage out of order, a
 * gate acknowledged twice or out of order, a second execution attempt, an automatic resubmission
 * after an unknown outcome — is refused here rather than left to the caller.
 */
export function advanceAliasV2Lifecycle(
  state: AliasV2Lifecycle,
  step: AliasV2LifecycleStep,
): AliasV2Lifecycle {
  const { stage, result } = step;
  if (stage === 'read') {
    if (state.phase !== 'readback_required') {
      refused(
        ALIAS_V2_LIFECYCLE_REFUSED,
        2,
        'Alias v2 read stage is only valid after an unknown outcome.',
      );
    }
    if (state.readback_attempts >= MAX_READBACK_ATTEMPTS) {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 readback attempts are exhausted.');
    }
    const readbackAttempts = state.readback_attempts + 1;
    if (result.kind === 'applied') {
      return { ...state, phase: 'applied', readback_attempts: readbackAttempts, code: null };
    }
    if (result.kind === 'idempotent_replay') {
      return {
        ...state,
        phase: 'idempotent_replay',
        readback_attempts: readbackAttempts,
        code: null,
      };
    }
    if (result.kind === 'not_applied') {
      return {
        ...state,
        phase: 'refused',
        readback_attempts: readbackAttempts,
        code: ALIAS_V2_EXECUTION_NOT_APPLIED,
      };
    }
    if (result.kind === 'refused') {
      return { ...state, phase: 'refused', readback_attempts: readbackAttempts, code: result.code };
    }
    // A read that could not be dispatched stays in the readback phase; the caller may retry the
    // read (bounded above) but never the execution.
    return { ...state, readback_attempts: readbackAttempts };
  }
  if (stage === 'execute') {
    // Checked first: whatever the phase, an execution attempt that already happened is final.
    if (state.execute_attempts !== 0) {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 execution is never attempted twice.');
    }
    if (state.phase !== 'admitted') {
      refused(
        ALIAS_V2_LIFECYCLE_REFUSED,
        2,
        `Alias v2 execution is only valid after admission, not in phase ${state.phase}.`,
      );
    }
    const executed = { ...state, execute_attempts: 1 };
    if (result.kind === 'applied') {
      return { ...executed, phase: 'applied', code: null };
    }
    if (result.kind === 'idempotent_replay') {
      return { ...executed, phase: 'idempotent_replay', code: null };
    }
    if (result.kind === 'readback_required') {
      return { ...executed, phase: 'readback_required', code: result.code };
    }
    if (result.kind === 'refused') {
      return { ...executed, phase: 'refused', code: result.code };
    }
    refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 execution cannot accept this result.');
  }
  const expectedPhase: Record<'preflight' | 'gate' | 'admit', AliasV2Phase> = {
    preflight: 'prepared',
    gate: 'preflight_passed',
    admit: 'gated',
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
  if (result.kind === 'applied' && stage === 'admit') {
    // Admission reported the plan already applied: terminal, and no execution may follow.
    return { ...state, phase: 'applied', code: null };
  }
  if (result.kind === 'idempotent_replay' && stage === 'admit') {
    return { ...state, phase: 'idempotent_replay', code: null };
  }
  if (stage === 'preflight') {
    if (result.kind !== 'ok') {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 preflight cannot accept this result.');
    }
    return { ...state, phase: 'preflight_passed' };
  }
  if (stage === 'gate') {
    const gate = result.kind === 'ok' ? result.body['gate_name'] : null;
    if (gate !== ALIAS_V2_GATE_NAMES[state.gates.length]) {
      refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, 'Alias v2 gates must be acknowledged once, in order.');
    }
    const gates = [...state.gates, gate as string];
    return gates.length === ALIAS_V2_GATE_NAMES.length
      ? { ...state, gates, phase: 'gated' }
      : { ...state, gates };
  }
  if (result.kind !== 'ok') {
    refused(ALIAS_V2_LIFECYCLE_REFUSED, 2, `Alias v2 ${stage} cannot accept this result.`);
  }
  return { ...state, phase: 'admitted' };
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
