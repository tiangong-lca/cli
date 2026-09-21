// Versioned (v2) protected preflight request for the current Time alias cohort.
//
// CLI #358 keeps the real protected v1 envelope: one exact top-level key set, the same
// `owner_draft` visibility, the same environment enum, a client-generated request UUID, the
// same actor/binding sets and the real freeze/approval/bindings/expected/derivative_targets
// content. Only the schema identifiers and the plan content are versioned. Everything new
// (source evidence, target snapshots, counts, dimensions, FU text actions, per-action data)
// lives inside the plan, so the canonical plan/freeze/approval bindings cover it.
//
// Local implementation only: this module builds and validates the request an operator would
// submit through the protected lifecycle. It performs no network or database work, and it
// deliberately refuses anything outside the reviewed v2 shape (strict key sets, explicit upper
// bounds, no server-generated request identity).

import { CliError } from './errors.js';

export const ALIAS_V2_PREFLIGHT_SCHEMA = 'dataset-alias-execution-preflight.v2';
export const ALIAS_V2_PLAN_SCHEMA = 'dataset-alias-plan.v2';
export const ALIAS_V2_FREEZE_SCHEMA = 'dataset-alias-execution-freeze.v2';
export const ALIAS_V2_APPROVAL_SCHEMA = 'dataset-alias-execution-approval.v2';

export const ALIAS_V2_PREFLIGHT_INVALID_REQUEST = 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST';
export const ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE = 'ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE';

export const ALIAS_V2_ENVIRONMENTS = ['production', 'preview', 'local'] as const;

export const ALIAS_V2_PREFLIGHT_KEYS = [
  'schema_version',
  'request_id',
  'environment',
  'project_ref',
  'actor',
  'target_visibility',
  'plan',
  'freeze',
  'approval',
  'bindings',
  'expected',
  'derivative_targets',
] as const;

export const ALIAS_V2_ACTOR_KEYS = ['user_id', 'email'] as const;

export const ALIAS_V2_BINDING_KEYS = [
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
] as const;

export const ALIAS_V2_PLAN_KEYS = [
  'schema_version',
  'actor_id',
  'target_visibility',
  'source_evidence',
  'target_snapshots',
  'counts',
  'dimensions',
  'text_actions',
  'actions',
  'plan_sha256',
] as const;

const ALIAS_V2_PREFLIGHT_INPUT_KEYS = [
  'requestId',
  'environment',
  'projectRef',
  'actor',
  'plan',
  'freeze',
  'approval',
  'bindings',
  'expected',
  'derivativeTargets',
] as const;

export const ALIAS_V2_COUNT_KEYS = [
  'action_count',
  'flowproperty_count',
  'flow_count',
  'process_count',
  'exchange_count',
  'amount_field_count',
  'unrelated_exchange_count',
] as const;

export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_PLAN_ACTIONS = 1024;
export const MAX_PLAN_EXCHANGES = 8192;
export const MAX_TEXT_ACTIONS = 1024;
export const MAX_DERIVATIVE_TARGETS = 1024;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PROJECT_REF_BYTES = 128;
const MAX_EMAIL_BYTES = 320;

type JsonObject = Record<string, unknown>;

export type AliasV2PreflightRequestInput = {
  requestId: string;
  environment: string;
  projectRef: string;
  actor: JsonObject;
  plan: JsonObject;
  freeze: JsonObject;
  approval: JsonObject;
  bindings: JsonObject;
  expected: JsonObject;
  derivativeTargets: JsonObject[];
};

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string, details?: JsonObject): never {
  throw new CliError(message, {
    code: ALIAS_V2_PREFLIGHT_INVALID_REQUEST,
    exitCode: 2,
    ...(details === undefined ? {} : { details }),
  });
}

function tooLarge(message: string, details: JsonObject): never {
  throw new CliError(message, {
    code: ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE,
    exitCode: 2,
    details,
  });
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    invalid(`Alias v2 preflight ${label} must be a lowercase sha256.`, { label });
  }
  return value;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`Alias v2 preflight count ${label} must be a non-negative safe integer.`, { label });
  }
  return value;
}

/**
 * Builds the exact v2 protected preflight request. Any deviation from the reviewed shape is
 * refused before the request could be dispatched.
 */
export function buildAliasV2PreflightRequest(input: AliasV2PreflightRequestInput): JsonObject {
  for (const key of Object.keys(input)) {
    if (!(ALIAS_V2_PREFLIGHT_INPUT_KEYS as readonly string[]).includes(key)) {
      invalid(`Alias v2 preflight request carries an unknown key: ${key}.`, { key });
    }
  }
  if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
    invalid('Alias v2 preflight request_id must be a client-generated lowercase UUID.');
  }
  if (!(ALIAS_V2_ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    invalid('Alias v2 preflight environment must be production, preview or local.', {
      environment: input.environment,
    });
  }
  if (
    typeof input.projectRef !== 'string' ||
    input.projectRef.trim() === '' ||
    Buffer.byteLength(input.projectRef, 'utf8') > MAX_PROJECT_REF_BYTES
  ) {
    invalid('Alias v2 preflight project_ref must be a non-empty string of at most 128 bytes.');
  }
  if (
    !isJsonObject(input.actor) ||
    !hasExactKeys(input.actor, ALIAS_V2_ACTOR_KEYS) ||
    typeof input.actor['user_id'] !== 'string' ||
    typeof input.actor['email'] !== 'string' ||
    Buffer.byteLength(input.actor['email'] as string, 'utf8') > MAX_EMAIL_BYTES
  ) {
    invalid('Alias v2 preflight actor must be exactly {user_id, email}.');
  }
  const plan = input.plan;
  if (!isJsonObject(plan) || !hasExactKeys(plan, ALIAS_V2_PLAN_KEYS)) {
    invalid('Alias v2 preflight plan must match the reviewed plan key set exactly.');
  }
  if (plan['schema_version'] !== ALIAS_V2_PLAN_SCHEMA) {
    invalid('Alias v2 preflight plan schema_version must be dataset-alias-plan.v2.');
  }
  if (plan['target_visibility'] !== 'owner_draft') {
    invalid('Alias v2 preflight plan target_visibility must be owner_draft.');
  }
  if (!isJsonObject(plan['counts']) || !hasExactKeys(plan['counts'], ALIAS_V2_COUNT_KEYS)) {
    invalid('Alias v2 preflight plan counts must match the reviewed count key set exactly.');
  }
  const counts = plan['counts'];
  for (const key of ALIAS_V2_COUNT_KEYS) {
    requireCount(counts[key], key);
  }
  const dimensions = plan['dimensions'];
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 1 ||
    !isJsonObject(dimensions[0]) ||
    dimensions[0]['dimension'] !== 'time' ||
    dimensions[0]['factor'] !== '0.00011415525114155251'
  ) {
    invalid('Alias v2 preflight plan must carry exactly one reviewed time dimension.');
  }
  if (!isJsonObject(plan['source_evidence']) || !isJsonObject(plan['target_snapshots'])) {
    invalid('Alias v2 preflight plan must bind source evidence and target snapshots.');
  }
  requireSha256(plan['plan_sha256'], 'plan_sha256');
  const actions = plan['actions'];
  const textActions = plan['text_actions'];
  if (!Array.isArray(actions) || !Array.isArray(textActions)) {
    invalid('Alias v2 preflight plan actions and text_actions must be arrays.');
  }
  if (!isJsonObject(input.freeze) || input.freeze['schema_version'] !== ALIAS_V2_FREEZE_SCHEMA) {
    invalid('Alias v2 preflight freeze must be a dataset-alias-execution-freeze.v2 object.');
  }
  if (
    !isJsonObject(input.approval) ||
    input.approval['schema_version'] !== ALIAS_V2_APPROVAL_SCHEMA
  ) {
    invalid('Alias v2 preflight approval must be a dataset-alias-execution-approval.v2 object.');
  }
  if (!isJsonObject(input.bindings) || !hasExactKeys(input.bindings, ALIAS_V2_BINDING_KEYS)) {
    invalid('Alias v2 preflight bindings must match the reviewed binding key set exactly.');
  }
  for (const key of ALIAS_V2_BINDING_KEYS) {
    requireSha256(input.bindings[key], key);
  }
  if (!isJsonObject(input.expected) || !hasExactKeys(input.expected, ['counts', 'closure'])) {
    invalid('Alias v2 preflight expected must carry exactly the plan-bound counts and closure.');
  }
  if (!isJsonObject(input.expected['counts'])) {
    invalid('Alias v2 preflight expected counts must be an object.');
  }
  for (const key of ALIAS_V2_COUNT_KEYS) {
    if (input.expected['counts'][key] !== counts[key]) {
      invalid('Alias v2 preflight expected counts must equal the plan counts exactly.', { key });
    }
  }
  if (!Array.isArray(input.derivativeTargets) || input.derivativeTargets.length === 0) {
    invalid('Alias v2 preflight derivative_targets must be a non-empty array.');
  }
  if (input.derivativeTargets.some((target) => !isJsonObject(target))) {
    invalid('Alias v2 preflight derivative_targets entries must be objects.');
  }

  // Explicit upper bounds: an unbounded arbitrary plan is refused as too large.
  if (actions.length > MAX_PLAN_ACTIONS) {
    tooLarge('Alias v2 preflight plan exceeds the reviewed action bound.', {
      bound: MAX_PLAN_ACTIONS,
      actual: actions.length,
    });
  }
  if (textActions.length > MAX_TEXT_ACTIONS) {
    tooLarge('Alias v2 preflight plan exceeds the reviewed text action bound.', {
      bound: MAX_TEXT_ACTIONS,
      actual: textActions.length,
    });
  }
  if ((counts['exchange_count'] as number) > MAX_PLAN_EXCHANGES) {
    tooLarge('Alias v2 preflight plan exceeds the reviewed exchange bound.', {
      bound: MAX_PLAN_EXCHANGES,
      actual: counts['exchange_count'],
    });
  }
  if (input.derivativeTargets.length > MAX_DERIVATIVE_TARGETS) {
    tooLarge('Alias v2 preflight request exceeds the reviewed derivative target bound.', {
      bound: MAX_DERIVATIVE_TARGETS,
      actual: input.derivativeTargets.length,
    });
  }

  const request: JsonObject = {
    schema_version: ALIAS_V2_PREFLIGHT_SCHEMA,
    request_id: input.requestId,
    environment: input.environment,
    project_ref: input.projectRef,
    actor: { user_id: input.actor['user_id'], email: input.actor['email'] },
    target_visibility: 'owner_draft',
    plan,
    freeze: input.freeze,
    approval: input.approval,
    bindings: input.bindings,
    expected: input.expected,
    derivative_targets: input.derivativeTargets,
  };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) {
    tooLarge('Alias v2 preflight request exceeds 64 MiB.', { bound: MAX_REQUEST_BYTES });
  }
  return request;
}
