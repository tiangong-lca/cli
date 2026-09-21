// Versioned (v2) protected execution contract: the same protocol shape v1 already enforces,
// with versioned schema identifiers and plan-bound numbers instead of the frozen v1 constants.
//
// The v1 capability's protocol is the template, deliberately: a preflight request that carries
// the complete plan, freeze, approval, bindings, expected counts and derivative targets; a
// preflight proof whose window, bindings and simulation are checked against that identity; three
// gate receipts each bound to the preflight's gate expectation and to the same server window; an
// admission request of exactly five keys carrying the verified preflight proof digest and the
// three gate results; and an admission proof that proves a single consumed attempt. Nothing here
// weakens a check to make a mock pass.

import { CliError } from './errors.js';
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import { deterministicUuidFromSha256 } from './dataset-maintenance-protected-contract.js';
import type {
  AliasV2Account,
  AliasV2Approval,
  AliasV2Freeze,
} from './dataset-alias-v2-protected.js';

export const ALIAS_V2_PROTOCOL = {
  identity_schema: 'dataset-alias-execution-identity.v2',
  preflight_request_schema: 'dataset-alias-execution-preflight.v2',
  preflight_response_schema: 'dataset-alias-execution-preflight-proof.v2',
  preflight_command: 'cmd_dataset_alias_execution_preflight_v2_guarded',
  gate_response_schema: 'dataset-alias-execution-gate-receipt.v2',
  gate_command: 'cmd_dataset_alias_execution_gate_v2_guarded',
  admit_request_schema: 'dataset-alias-execution-admit.v2',
  admit_response_schema: 'dataset-alias-execution-admit-proof.v2',
  admit_command: 'cmd_dataset_alias_execution_admit_v2_guarded',
} as const;

export const ALIAS_V2_GATES = [
  'primary_support_plan',
  'execution_unused',
  'derivative_quiescence',
] as const;
export type AliasV2Gate = (typeof ALIAS_V2_GATES)[number];

/** The reviewed admission window and clock-skew allowance, unchanged from v1. */
export const ALIAS_V2_MAX_WINDOW_MS = 180_000;
export const ALIAS_V2_CLOCK_SKEW_MS = 5_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{16,4096}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type AliasV2ExecutionIdentity = {
  schema_version: typeof ALIAS_V2_PROTOCOL.identity_schema;
  request_id: string;
  identity_sha256: string;
  environment: 'production';
  project_ref: string;
  actor: AliasV2Account;
  target_visibility: 'owner_draft';
  plan_sha256: string;
  /** The reviewed expected counts the freeze derives from the plan; there is no declared closure. */
  expected: JsonObject;
  bindings: JsonObject;
  derivative_targets: JsonObject[];
};

export type AliasV2GateResult = {
  expected_sha256: string;
  observed_sha256: string;
  status: 'passed';
  captured_at: string;
};

export type AliasV2GateProof = {
  schema_version: typeof ALIAS_V2_PROTOCOL.gate_response_schema;
  command: typeof ALIAS_V2_PROTOCOL.gate_command;
  request_id: string;
  actor_user_id: string;
  preflight_proof_sha256: string;
  gate: AliasV2Gate;
  result: AliasV2GateResult;
  receipt_sha256: string;
};

export type AliasV2PreflightProof = {
  schema_version: typeof ALIAS_V2_PROTOCOL.preflight_response_schema;
  command: typeof ALIAS_V2_PROTOCOL.preflight_command;
  request_id: string;
  actor_user_id: string;
  environment: 'production';
  project_ref: string;
  server_context_sha256: string;
  plan_sha256: string;
  freeze_sha256: string;
  approval_identity_sha256: string;
  plan_request_sha256: string;
  bindings_sha256: string;
  expected_sha256: string;
  derivative_targets_sha256: string;
  gate_expectations: Record<`${AliasV2Gate}_sha256`, string>;
  gate_expectations_sha256: string;
  preflight_request_sha256: string;
  preflight_token: string;
  preflight_proof_sha256: string;
  simulation: { plan_rows: number; plan_exchanges: number; rolled_back: true };
  completed_at: string;
  expires_at: string;
};

export type AliasV2AdmissionProof = {
  schema_version: typeof ALIAS_V2_PROTOCOL.admit_response_schema;
  command: typeof ALIAS_V2_PROTOCOL.admit_command;
  request_id: string;
  plan_sha256: string;
  preflight_proof_sha256: string;
  admission_request_sha256: string;
  gate_results_sha256: string;
  status: 'dispatched';
  attempt_count: 1;
  dispatch_count: 1;
  net_request_id: string;
  attempt_consumed: true;
  retry_allowed: false;
};

function fail(message: string, details?: JsonObject): never {
  throw new CliError(message, {
    code: 'ALIAS_V2_PROTECTED_PROOF_INVALID',
    exitCode: 1,
    ...(details ? { details } : {}),
  });
}
function hashOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a lowercase sha256.`);
  }
  return value;
}
function tokenOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    fail(`${label} must be an opaque token.`);
  }
  return value;
}
/**
 * The dispatched callback's own identity. The database returns the pg_net row id rendered as text
 * (a short numeric string), exactly the shape v1 already accepted, so this is a non-empty string
 * rather than a long opaque token.
 */
function dispatchIdOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}
function timestampOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an RFC 3339 timestamp.`);
  }
  return value;
}

/** The complete contract the v2 freeze and approval build the identity from. */
export function buildAliasV2ExecutionIdentity(options: {
  freeze: AliasV2Freeze;
  approval: AliasV2Approval;
  freezeFileSha256: string;
  approvalFileSha256: string;
}): AliasV2ExecutionIdentity {
  const body = {
    environment: 'production' as const,
    project_ref: options.freeze.project_ref,
    actor: options.freeze.account,
    target_visibility: 'owner_draft' as const,
    plan_sha256: options.freeze.plan.plan_sha256,
    expected: options.freeze.expected,
    bindings: {
      plan_file_sha256: options.freeze.plan.plan_file_sha256,
      freeze_file_sha256: options.freezeFileSha256,
      freeze_sha256: options.freeze.freeze_sha256,
      approval_file_sha256: options.approvalFileSha256,
      approval_identity_sha256: options.approval.approval_identity_sha256,
      approval_text_sha256: options.approval.approval_text_sha256,
      ...options.freeze.sets,
    },
    derivative_targets: options.freeze.derivative_targets,
  };
  const identitySha256 = sha256Json(body);
  const requestId = deterministicUuidFromSha256(
    sha256Text(`dataset-alias-protected-request.v2 ${identitySha256}`),
  );
  return {
    schema_version: ALIAS_V2_PROTOCOL.identity_schema,
    request_id: requestId,
    identity_sha256: identitySha256,
    ...body,
  };
}

/** The preflight request: the real v1 twelve-key top level, versioned. */
export function buildAliasV2PreflightRequest(options: {
  identity: AliasV2ExecutionIdentity;
  plan: JsonObject;
  freeze: AliasV2Freeze;
  approval: AliasV2Approval;
}): JsonObject {
  return {
    schema_version: ALIAS_V2_PROTOCOL.preflight_request_schema,
    request_id: options.identity.request_id,
    environment: options.identity.environment,
    project_ref: options.identity.project_ref,
    actor: options.identity.actor,
    target_visibility: options.identity.target_visibility,
    plan: options.plan,
    freeze: options.freeze,
    approval: options.approval,
    bindings: options.identity.bindings,
    expected: options.identity.expected,
    derivative_targets: options.identity.derivative_targets,
  };
}

/** Parses the preflight proof and proves it belongs to this exact frozen identity. */
export function parseAliasV2PreflightProof(
  value: unknown,
  identity: AliasV2ExecutionIdentity,
  now = new Date(),
): AliasV2PreflightProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== ALIAS_V2_PROTOCOL.preflight_response_schema ||
    value.command !== ALIAS_V2_PROTOCOL.preflight_command ||
    value.request_id !== identity.request_id ||
    value.actor_user_id !== identity.actor.user_id ||
    value.environment !== identity.environment ||
    value.project_ref !== identity.project_ref ||
    value.plan_sha256 !== identity.plan_sha256 ||
    !isJsonObject(value.simulation)
  ) {
    fail('Alias v2 preflight returned a foreign or unsupported proof envelope.');
  }
  const expectations = value.gate_expectations;
  if (!isJsonObject(expectations)) {
    fail('Alias v2 preflight must carry its gate expectations.');
  }
  const proof: AliasV2PreflightProof = {
    schema_version: ALIAS_V2_PROTOCOL.preflight_response_schema,
    command: ALIAS_V2_PROTOCOL.preflight_command,
    request_id: identity.request_id,
    actor_user_id: identity.actor.user_id,
    environment: 'production',
    project_ref: identity.project_ref,
    server_context_sha256: hashOf(value.server_context_sha256, 'server_context_sha256'),
    plan_sha256: identity.plan_sha256,
    freeze_sha256: hashOf(value.freeze_sha256, 'freeze_sha256'),
    approval_identity_sha256: hashOf(value.approval_identity_sha256, 'approval_identity_sha256'),
    plan_request_sha256: hashOf(value.plan_request_sha256, 'plan_request_sha256'),
    bindings_sha256: hashOf(value.bindings_sha256, 'bindings_sha256'),
    expected_sha256: hashOf(value.expected_sha256, 'expected_sha256'),
    derivative_targets_sha256: hashOf(value.derivative_targets_sha256, 'derivative_targets_sha256'),
    gate_expectations: Object.fromEntries(
      ALIAS_V2_GATES.map((gate) => [
        `${gate}_sha256`,
        hashOf(expectations[`${gate}_sha256`], `gate_expectations.${gate}_sha256`),
      ]),
    ) as AliasV2PreflightProof['gate_expectations'],
    gate_expectations_sha256: hashOf(value.gate_expectations_sha256, 'gate_expectations_sha256'),
    preflight_request_sha256: hashOf(value.preflight_request_sha256, 'preflight_request_sha256'),
    preflight_token: tokenOf(value.preflight_token, 'preflight_token'),
    preflight_proof_sha256: hashOf(value.preflight_proof_sha256, 'preflight_proof_sha256'),
    simulation: {
      plan_rows: Number(value.simulation.plan_rows),
      plan_exchanges: Number(value.simulation.plan_exchanges),
      rolled_back: value.simulation.rolled_back as true,
    },
    completed_at: timestampOf(value.completed_at, 'completed_at'),
    expires_at: timestampOf(value.expires_at, 'expires_at'),
  };
  if (
    proof.freeze_sha256 !== identity.bindings['freeze_sha256'] ||
    proof.approval_identity_sha256 !== identity.bindings['approval_identity_sha256'] ||
    proof.simulation.plan_rows !== identity.expected['action_count'] ||
    proof.simulation.plan_exchanges !== identity.expected['exchange_count'] ||
    proof.simulation.rolled_back !== true
  ) {
    fail('Alias v2 preflight simulation did not prove the exact plan-bound profile and rollback.');
  }
  const issued = Date.parse(proof.completed_at);
  const expires = Date.parse(proof.expires_at);
  const nowMs = now.getTime();
  const windowMs = expires - issued;
  const timing = {
    completed_at: proof.completed_at,
    expires_at: proof.expires_at,
    observed_at: now.toISOString(),
    window_ms: windowMs,
  };
  if (windowMs <= 0) {
    fail('Alias v2 preflight expiry must be later than its completion time.', timing);
  }
  if (windowMs > ALIAS_V2_MAX_WINDOW_MS) {
    fail('Alias v2 preflight token exceeds the 180-second admission window.', timing);
  }
  if (issued - nowMs > ALIAS_V2_CLOCK_SKEW_MS) {
    fail('Alias v2 preflight token is future-issued beyond the clock-skew allowance.', timing);
  }
  if (expires <= nowMs) {
    fail('Alias v2 preflight token is stale.', timing);
  }
  return proof;
}

/** Parses one gate receipt and proves it matches the preflight's frozen expectation. */
export function parseAliasV2GateProof(
  value: unknown,
  options: {
    identity: AliasV2ExecutionIdentity;
    preflight: AliasV2PreflightProof;
    gate: AliasV2Gate;
  },
): AliasV2GateProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== ALIAS_V2_PROTOCOL.gate_response_schema ||
    value.command !== ALIAS_V2_PROTOCOL.gate_command ||
    value.request_id !== options.identity.request_id ||
    value.actor_user_id !== options.identity.actor.user_id ||
    value.preflight_proof_sha256 !== options.preflight.preflight_proof_sha256 ||
    value.gate !== options.gate ||
    value.status !== 'passed'
  ) {
    fail('Alias v2 gate returned a foreign, failed, or unsupported receipt.');
  }
  const expectedSha256 = hashOf(value.expected_sha256, 'gate.expected_sha256');
  const observedSha256 = hashOf(value.observed_sha256, 'gate.observed_sha256');
  const capturedAt = timestampOf(value.captured_at, 'gate.captured_at');
  if (
    expectedSha256 !== options.preflight.gate_expectations[`${options.gate}_sha256`] ||
    observedSha256 !== expectedSha256 ||
    Date.parse(capturedAt) < Date.parse(options.preflight.completed_at) ||
    Date.parse(capturedAt) > Date.parse(options.preflight.expires_at)
  ) {
    fail('Alias v2 gate receipt does not match the frozen digest or server preflight window.');
  }
  return {
    schema_version: ALIAS_V2_PROTOCOL.gate_response_schema,
    command: ALIAS_V2_PROTOCOL.gate_command,
    request_id: options.identity.request_id,
    actor_user_id: options.identity.actor.user_id,
    preflight_proof_sha256: options.preflight.preflight_proof_sha256,
    gate: options.gate,
    result: {
      expected_sha256: expectedSha256,
      observed_sha256: observedSha256,
      status: 'passed',
      captured_at: capturedAt,
    },
    receipt_sha256: hashOf(value.receipt_sha256, 'gate.receipt_sha256'),
  };
}

/** The admission request: exactly the five reviewed keys, never the preflight envelope. */
export function buildAliasV2AdmitRequest(options: {
  preflight: AliasV2PreflightProof;
  gateResults: Record<AliasV2Gate, AliasV2GateResult>;
}): JsonObject {
  return {
    schema_version: ALIAS_V2_PROTOCOL.admit_request_schema,
    request_id: options.preflight.request_id,
    preflight_token: options.preflight.preflight_token,
    preflight_proof_sha256: options.preflight.preflight_proof_sha256,
    gate_results: options.gateResults,
  };
}

/** Parses the admission proof: one dispatched, consumed attempt with no retry. */
export function parseAliasV2AdmissionProof(
  value: unknown,
  identity: AliasV2ExecutionIdentity,
  preflight: AliasV2PreflightProof,
): AliasV2AdmissionProof {
  if (
    !isJsonObject(value) ||
    value.ok !== true ||
    value.schema_version !== ALIAS_V2_PROTOCOL.admit_response_schema ||
    value.command !== ALIAS_V2_PROTOCOL.admit_command ||
    value.request_id !== identity.request_id ||
    value.plan_sha256 !== identity.plan_sha256 ||
    value.preflight_proof_sha256 !== preflight.preflight_proof_sha256 ||
    value.status !== 'dispatched' ||
    value.attempt_count !== 1 ||
    value.dispatch_count !== 1 ||
    value.attempt_consumed !== true ||
    value.retry_allowed !== false
  ) {
    fail('Alias v2 admission returned a foreign, duplicate, or unsupported proof envelope.');
  }
  return {
    schema_version: ALIAS_V2_PROTOCOL.admit_response_schema,
    command: ALIAS_V2_PROTOCOL.admit_command,
    request_id: identity.request_id,
    plan_sha256: identity.plan_sha256,
    preflight_proof_sha256: preflight.preflight_proof_sha256,
    admission_request_sha256: hashOf(value.admission_request_sha256, 'admission_request_sha256'),
    gate_results_sha256: hashOf(value.gate_results_sha256, 'gate_results_sha256'),
    status: 'dispatched',
    attempt_count: 1,
    dispatch_count: 1,
    net_request_id: dispatchIdOf(value.net_request_id, 'net_request_id'),
    attempt_consumed: true,
    retry_allowed: false,
  };
}

export { UUID as ALIAS_V2_UUID_PATTERN };
