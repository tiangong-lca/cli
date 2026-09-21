// The strict adapter for the ACTUAL versioned protected read response.
//
// The database's read command answers with the rich `dataset-alias-execution-status.v2` envelope: the
// request/actor/environment/project bindings, the stored freeze/approval/admission/gate identities, the one
// consumed dispatch, the live primary closure, the derivative orchestration aggregate and — only for a
// genuinely successful close of the current state — a `terminal_proof` whose per-row audit identities and
// per-row observations were read from the ledger and from the live rows.
//
// This module binds that envelope and classifies it. Nothing here trusts a stored success: `applied` exists
// only when the strict terminal proof passes row by row against the sealed plan AND the fresh closure
// counters and memberships agree. Everything else — pending, failed, indeterminate, not admitted — is
// classified as what it is, and no classification in this module authorizes another admission.

import { createHash } from 'node:crypto';
import { ALIAS_V2_COUNT_KEYS } from './dataset-alias-v2-execution-request.js';
import type { AliasV2ExecutionIdentity } from './dataset-alias-v2-protected-contract.js';

type JsonObject = Record<string, unknown>;

/** The versioned read envelope the protected read command actually returns. */
export const ALIAS_V2_STATUS_SCHEMA = 'dataset-alias-execution-status.v2';
export const ALIAS_V2_STATUS_COMMAND = 'cmd_dataset_alias_execution_read_v2';

/** The derivative orchestration aggregate carried as the envelope's derivative readback. */
export const ALIAS_V2_DERIVATIVE_ORCHESTRATION_SCHEMA =
  'dataset-alias-v2-derivative-orchestration.v1';
/** The reviewed shared sub-batch bound the deterministic chunk ids derive from. */
export const ALIAS_V2_CHUNK_TARGET_BOUND = 50;

export const ALIAS_V2_GATE_NAMES = [
  'primary_support_plan',
  'execution_unused',
  'derivative_quiescence',
] as const;
export type AliasV2GateName = (typeof ALIAS_V2_GATE_NAMES)[number];

export const ALIAS_V2_STATUS_PENDING = 'pending';
export const ALIAS_V2_STATUS_PASSED = 'passed';
export const ALIAS_V2_STATUS_FAILED = 'failed';
export const ALIAS_V2_STATUS_INDETERMINATE = 'indeterminate';
export const ALIAS_V2_STATUS_APPLIED = 'applied';
export const ALIAS_V2_STATUS_REPLAY = 'idempotent_replay';

/** The ledger states that hold while the execution is not terminal. */
export const ALIAS_V2_IN_FLIGHT_EXECUTION_STATUSES = [
  'dispatching',
  'dispatched',
  'running',
  'derivatives_pending',
] as const;

export const ALIAS_V2_EXECUTION_NOT_ADMITTED_CODE = 'ALIAS_EXECUTION_NOT_ADMITTED';
export const ALIAS_V2_ADMISSION_LEDGER_MISSING_CODE = 'ALIAS_EXECUTION_ADMISSION_LEDGER_MISSING';
export const ALIAS_V2_REQUEST_NOT_FOUND_CODE = 'ALIAS_EXECUTION_REQUEST_NOT_FOUND';
export const ALIAS_V2_READ_STATE_CHANGED_CODE = 'ALIAS_EXECUTION_READ_STATE_CHANGED';
export const ALIAS_V2_READ_LOCK_BUSY_CODE = 'ALIAS_EXECUTION_READ_LOCK_BUSY';

/** Client-side classifications of a server state that is neither applied nor a plain refusal. */
export const ALIAS_V2_EXECUTION_FAILED = 'ALIAS_V2_EXECUTION_FAILED';
export const ALIAS_V2_EXECUTION_INDETERMINATE = 'ALIAS_V2_EXECUTION_INDETERMINATE';

export const ALIAS_V2_RESPONSE_INVALID = 'ALIAS_V2_RESPONSE_INVALID';
export const ALIAS_V2_RESPONSE_COUNT_MISMATCH = 'ALIAS_V2_RESPONSE_COUNT_MISMATCH';
export const ALIAS_V2_RESPONSE_READBACK_MISMATCH = 'ALIAS_V2_RESPONSE_READBACK_MISMATCH';

/** The exact five keys of the terminal proof, and the exact keys of its own blocks. */
export const ALIAS_V2_TERMINAL_PROOF_KEYS = [
  'status',
  'plan_sha256',
  'counts',
  'audit',
  'readback',
] as const;
export const ALIAS_V2_PROOF_AUDIT_KEYS = [
  'batch_count',
  'row_audit_count',
  'plan_summary_audit_id',
  'batch_summary_audit_id',
  'row_audits',
] as const;
export const ALIAS_V2_PROOF_AUDIT_ROW_KEYS = [
  'audit_id',
  'action_id',
  'table',
  'id',
  'version',
  'after_sha256',
] as const;
export const ALIAS_V2_PROOF_READBACK_KEYS = ['row_count', 'exchange_count', 'rows'] as const;
export const ALIAS_V2_PROOF_READBACK_ROW_KEYS = [
  'table',
  'id',
  'version',
  'observed_sha256',
  'functional_unit_text',
] as const;

/**
 * The server identities this run itself observed, when it observed them: a terminal read must not be
 * accepted for a different preflight/admission/gate set than the one this invocation executed.
 */
export type AliasV2ObservedServerIdentities = {
  preflight_proof_sha256?: string;
  admission_request_sha256?: string;
  gate_results_sha256?: string;
  gate_expected_sha256?: Partial<Record<AliasV2GateName, string>>;
  gate_receipt_sha256?: Partial<Record<AliasV2GateName, string>>;
};

export type AliasV2ReadBinding = {
  plan: JsonObject;
  request_id: string;
  /** The sealed identity this request was frozen and approved with. */
  identity: AliasV2ExecutionIdentity;
  observed?: AliasV2ObservedServerIdentities;
};

export type AliasV2StatusClassification =
  | { kind: 'pending' }
  | { kind: 'applied'; status: typeof ALIAS_V2_STATUS_APPLIED }
  | { kind: 'idempotent_replay' }
  | { kind: 'failed'; code: string }
  | { kind: 'indeterminate'; code: string }
  | { kind: 'not_applied' }
  | { kind: 'invalid'; code: string };

const SHA256 = /^[a-f0-9]{64}$/u;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function invalid(code: string = ALIAS_V2_RESPONSE_INVALID): { kind: 'invalid'; code: string } {
  return { kind: 'invalid', code };
}
function rowKey(table: unknown, id: unknown, version: unknown): string {
  return `${String(table)}:${String(id)}@${String(version)}`;
}

/**
 * The deterministic sub-batch identity the database derives for one alias execution: the md5 of
 * `request_id:plan_sha256:ordinal` rendered as a UUID. The CLI recomputes it, so the orchestration
 * aggregate cannot claim chunks this execution never admitted.
 */
export function aliasV2DerivativeChunkId(
  requestId: string,
  planSha256: string,
  ordinal: number,
): string {
  const digest = createHash('md5')
    .update(`${requestId}:${planSha256}:${ordinal}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/** Reads one nested string leaf, tolerating any missing or differently-shaped level. */
function readTextLeaf(value: unknown, path: readonly string[]): string | null {
  let node: unknown = value;
  for (const key of path) {
    if (!isJsonObject(node)) {
      return null;
    }
    node = node[key];
  }
  return typeof node === 'string' ? node : null;
}

/** The functional-unit text a process action's own before image carries. */
function beforeTextOfProcess(action: JsonObject): string | null {
  return readTextLeaf(action['expected_json_ordered'], [
    'processDataSet',
    'processInformation',
    'quantitativeReference',
    'functionalUnitOrOther',
    '#text',
  ]);
}

/**
 * The plan's actions keyed by `table:id@version`, each carrying the process's approved post text where
 * the plan corrects one — so the readback comparison can demand the approved text of a corrected process
 * and the before text of every other one without a second lookup.
 */
function planActionsWithTexts(plan: JsonObject): Map<string, JsonObject> | null {
  const actions = plan['actions'];
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }
  const texts = new Map<string, string>();
  const textActions = plan['text_actions'];
  if (Array.isArray(textActions)) {
    for (const action of textActions) {
      if (isJsonObject(action) && typeof action['after_text'] === 'string') {
        texts.set(rowKey(action['table'], action['id'], action['version']), action['after_text']);
      }
    }
  }
  const index = new Map<string, JsonObject>();
  for (const action of actions) {
    if (!isJsonObject(action)) {
      return null;
    }
    const key = rowKey(action['table'], action['id'], action['version']);
    const after = texts.get(key);
    index.set(key, after === undefined ? action : { ...action, after_text: after });
  }
  return index.size === actions.length ? index : null;
}

/**
 * Validates the terminal proof against the plan it claims to have applied. The proof's per-row audit
 * identities, per-row fresh observations and functional-unit texts must all equal what this plan built;
 * the audit block must describe exactly the plan's own batch topology (`expected.batch_count`), never a
 * per-table or per-chunk count invented on either side.
 */
export function validateAliasV2TerminalProof(
  value: unknown,
  binding: Pick<AliasV2ReadBinding, 'plan'>,
): { status: typeof ALIAS_V2_STATUS_APPLIED | typeof ALIAS_V2_STATUS_REPLAY } | { code: string } {
  if (!isJsonObject(value) || !hasExactKeys(value, ALIAS_V2_TERMINAL_PROOF_KEYS)) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  const status = value['status'];
  if (status !== ALIAS_V2_STATUS_APPLIED && status !== ALIAS_V2_STATUS_REPLAY) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (value['plan_sha256'] !== binding.plan['plan_sha256']) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  // The proof's count block is the plan's own expected counts, key for key.
  const counts = value['counts'];
  const planCounts = binding.plan['expected'];
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
  const actionCount = planCounts['action_count'];
  const actions = planActionsWithTexts(binding.plan);
  if (actions === null) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  // The audit block: one recorded summary per topology level, one recorded row audit per action, and the
  // batch count must be the plan's own scientific batch count.
  const audit = value['audit'];
  if (!isJsonObject(audit) || !hasExactKeys(audit, ALIAS_V2_PROOF_AUDIT_KEYS)) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (audit['batch_count'] !== planCounts['batch_count']) {
    return { code: ALIAS_V2_RESPONSE_COUNT_MISMATCH };
  }
  if (audit['row_audit_count'] !== actionCount) {
    return { code: ALIAS_V2_RESPONSE_COUNT_MISMATCH };
  }
  if (
    !isPositiveInteger(audit['plan_summary_audit_id']) ||
    !isPositiveInteger(audit['batch_summary_audit_id'])
  ) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (!Array.isArray(audit['row_audits'])) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (audit['row_audits'].length !== actionCount) {
    return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
  }
  const auditedKeys = new Set<string>();
  const auditIds = new Set<number>();
  for (const entry of audit['row_audits']) {
    if (!isJsonObject(entry) || !hasExactKeys(entry, ALIAS_V2_PROOF_AUDIT_ROW_KEYS)) {
      return { code: ALIAS_V2_RESPONSE_INVALID };
    }
    const key = rowKey(entry['table'], entry['id'], entry['version']);
    const action = actions.get(key);
    if (
      action === undefined ||
      auditedKeys.has(key) ||
      entry['action_id'] !== action['action_id'] ||
      entry['after_sha256'] !== action['desired_sha256'] ||
      !isPositiveInteger(entry['audit_id']) ||
      auditIds.has(entry['audit_id'])
    ) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
    auditedKeys.add(key);
    auditIds.add(entry['audit_id']);
  }
  // The readback block: one fresh observation per action, byte-equal to the plan's desired payload, with
  // the functional-unit text the row currently carries.
  const readback = value['readback'];
  if (!isJsonObject(readback) || !hasExactKeys(readback, ALIAS_V2_PROOF_READBACK_KEYS)) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (
    readback['row_count'] !== actionCount ||
    readback['exchange_count'] !== planCounts['exchange_count']
  ) {
    return { code: ALIAS_V2_RESPONSE_COUNT_MISMATCH };
  }
  if (!Array.isArray(readback['rows'])) {
    return { code: ALIAS_V2_RESPONSE_INVALID };
  }
  if (readback['rows'].length !== actionCount) {
    return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
  }
  const observedKeys = new Set<string>();
  for (const entry of readback['rows']) {
    if (!isJsonObject(entry) || !hasExactKeys(entry, ALIAS_V2_PROOF_READBACK_ROW_KEYS)) {
      return { code: ALIAS_V2_RESPONSE_INVALID };
    }
    const key = rowKey(entry['table'], entry['id'], entry['version']);
    const action = actions.get(key);
    if (
      action === undefined ||
      observedKeys.has(key) ||
      entry['observed_sha256'] !== action['desired_sha256']
    ) {
      return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
    }
    if (entry['table'] === 'processes') {
      // A process carrying a text action must show the approved post text; every other process must
      // still show the functional-unit text of its own before image.
      const expectedText =
        typeof action['after_text'] === 'string'
          ? action['after_text']
          : beforeTextOfProcess(action);
      if ((entry['functional_unit_text'] ?? null) !== expectedText) {
        return { code: ALIAS_V2_RESPONSE_READBACK_MISMATCH };
      }
    }
    observedKeys.add(key);
  }
  return { status };
}

/** True when the envelope's binding fields are exactly this sealed execution's. */
function matchesEnvelopeBinding(body: JsonObject, binding: AliasV2ReadBinding): boolean {
  const { identity, plan } = binding;
  return (
    body['request_id'] === binding.request_id &&
    body['actor_user_id'] === identity.actor.user_id &&
    body['actor_user_id'] === plan['actor_id'] &&
    body['environment'] === identity.environment &&
    body['project_ref'] === identity.project_ref &&
    body['plan_sha256'] === identity.plan_sha256 &&
    body['plan_sha256'] === plan['plan_sha256'] &&
    body['retry_allowed'] === false
  );
}

function matchesObservedIdentities(
  body: JsonObject,
  observed: AliasV2ObservedServerIdentities | undefined,
): boolean {
  if (observed === undefined) {
    return true;
  }
  if (
    observed.preflight_proof_sha256 !== undefined &&
    body['preflight_proof_sha256'] !== observed.preflight_proof_sha256
  ) {
    return false;
  }
  if (
    observed.admission_request_sha256 !== undefined &&
    body['admission_request_sha256'] !== observed.admission_request_sha256
  ) {
    return false;
  }
  return !(
    observed.gate_results_sha256 !== undefined &&
    body['gate_results_sha256'] !== observed.gate_results_sha256
  );
}

/**
 * The stored gate receipts of this execution: three passed receipts, each still equal to the expectation
 * (and the receipt) this run observed at gate time when those are available.
 */
function matchesGateReceipts(
  body: JsonObject,
  observed: AliasV2ObservedServerIdentities | undefined,
): boolean {
  const gates = body['gates'];
  if (body['gate_count'] !== ALIAS_V2_GATE_NAMES.length || !Array.isArray(gates)) {
    return false;
  }
  if (gates.length !== ALIAS_V2_GATE_NAMES.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of gates) {
    if (!isJsonObject(entry)) {
      return false;
    }
    const gate = entry['gate'];
    if (
      typeof gate !== 'string' ||
      !(ALIAS_V2_GATE_NAMES as readonly string[]).includes(gate) ||
      seen.has(gate) ||
      entry['status'] !== 'passed' ||
      !isSha256(entry['expected_sha256']) ||
      entry['observed_sha256'] !== entry['expected_sha256'] ||
      !isSha256(entry['receipt_sha256']) ||
      typeof entry['captured_at'] !== 'string' ||
      Number.isNaN(Date.parse(entry['captured_at']))
    ) {
      return false;
    }
    seen.add(gate);
    const name = gate as AliasV2GateName;
    if (
      observed?.gate_expected_sha256?.[name] !== undefined &&
      entry['expected_sha256'] !== observed.gate_expected_sha256[name]
    ) {
      return false;
    }
    if (
      observed?.gate_receipt_sha256?.[name] !== undefined &&
      entry['receipt_sha256'] !== observed.gate_receipt_sha256[name]
    ) {
      return false;
    }
  }
  return seen.size === ALIAS_V2_GATE_NAMES.length;
}

/** The one consumed dispatch: attempt one, at most one dispatch, never a retry. */
function matchesConsumedDispatch(body: JsonObject, dispatched: boolean): boolean {
  if (body['attempt_count'] !== 1) {
    return false;
  }
  const dispatchCount = body['dispatch_count'];
  return dispatched ? dispatchCount === 1 : dispatchCount === 0 || dispatchCount === 1;
}

function errorCodeOf(body: JsonObject, fallback: string): string {
  const error = body['error'];
  const code = isJsonObject(error) ? error['code'] : null;
  return typeof code === 'string' && code !== '' ? code : fallback;
}

/**
 * The live primary closure of a passed read: the fresh row and exchange counters, the exact audit count
 * and the closure proof the database re-read from the current rows.
 */
function matchesPrimaryClosure(body: JsonObject, counts: JsonObject): boolean {
  const readback = body['primary_readback'];
  if (!isJsonObject(readback)) {
    return false;
  }
  const closure = readback['closure'];
  return (
    readback['row_count'] === counts['action_count'] &&
    readback['exchange_count'] === counts['exchange_count'] &&
    readback['alias_audit_count'] === counts['audit_count'] &&
    readback['live_closure_proof'] === true &&
    isJsonObject(closure) &&
    closure['ok'] === true &&
    closure['live_closure_proof'] === true &&
    closure['row_count'] === counts['action_count'] &&
    closure['claimed_row_count'] === counts['action_count'] &&
    closure['invalid_action_count'] === 0 &&
    isSha256(closure['proof_sha256'])
  );
}

/**
 * The derivative orchestration aggregate of a passed read: every deterministic sub-batch of this exact
 * execution admitted, completed through its own causal terminal proof, and covering exactly the frozen
 * target set — recomputed here so a stored `completed` cannot stand in for a missing chunk.
 */
function matchesDerivativeClosure(
  body: JsonObject,
  binding: AliasV2ReadBinding,
  counts: JsonObject,
): boolean {
  const readback = body['derivative_readback'];
  if (!isJsonObject(readback)) {
    return false;
  }
  const targetCount = counts['derivative_target_count'];
  if (!Number.isSafeInteger(targetCount) || (targetCount as number) < 0) {
    return false;
  }
  const targets = binding.identity.derivative_targets;
  const flowTargets = targets.filter((target) => target.table === 'flows').length;
  const processTargets = targets.filter((target) => target.table === 'processes').length;
  if (
    readback['schema_version'] !== ALIAS_V2_DERIVATIVE_ORCHESTRATION_SCHEMA ||
    readback['request_id'] !== binding.request_id ||
    readback['status'] !== 'completed' ||
    readback['causal_terminal_proof'] !== true ||
    readback['membership_exact'] !== true ||
    readback['chunk_target_bound'] !== ALIAS_V2_CHUNK_TARGET_BOUND ||
    readback['target_count'] !== targetCount ||
    readback['approved_target_count'] !== targetCount ||
    readback['completed_count'] !== targetCount ||
    readback['nonterminal_count'] !== 0 ||
    readback['failed_count'] !== 0 ||
    readback['invalid_proof_count'] !== 0 ||
    readback['flow_count'] !== flowTargets ||
    readback['process_count'] !== processTargets ||
    targets.length !== targetCount
  ) {
    return false;
  }
  const chunkCount = Math.ceil((targetCount as number) / ALIAS_V2_CHUNK_TARGET_BOUND);
  if (readback['chunk_count'] !== chunkCount || !Array.isArray(readback['chunks'])) {
    return false;
  }
  if (readback['chunks'].length !== chunkCount) {
    return false;
  }
  let chunkedTargets = 0;
  for (const [index, chunk] of readback['chunks'].entries()) {
    if (!isJsonObject(chunk)) {
      return false;
    }
    const ordinal = index + 1;
    const chunkTargets = chunk['target_count'];
    if (
      chunk['ordinal'] !== ordinal ||
      chunk['batch_id'] !==
        aliasV2DerivativeChunkId(
          binding.request_id,
          binding.plan['plan_sha256'] as string,
          ordinal,
        ) ||
      chunk['status'] !== 'completed' ||
      chunk['causal_terminal_proof'] !== true ||
      chunk['failed_count'] !== 0 ||
      chunk['nonterminal_count'] !== 0 ||
      !Number.isSafeInteger(chunkTargets) ||
      (chunkTargets as number) < 1 ||
      (chunkTargets as number) > ALIAS_V2_CHUNK_TARGET_BOUND ||
      chunk['completed_count'] !== chunkTargets
    ) {
      return false;
    }
    chunkedTargets += chunkTargets as number;
  }
  return chunkedTargets === targetCount;
}

function classifyNotAdmitted(
  body: JsonObject,
  binding: AliasV2ReadBinding,
): AliasV2StatusClassification {
  if (
    body['status'] !== ALIAS_V2_STATUS_INDETERMINATE ||
    !isSha256(body['preflight_proof_sha256']) ||
    (body['terminal_proof'] !== undefined && body['terminal_proof'] !== null)
  ) {
    return invalid();
  }
  const observedPreflight = binding.observed?.preflight_proof_sha256;
  if (observedPreflight !== undefined && body['preflight_proof_sha256'] !== observedPreflight) {
    return invalid();
  }
  const code = body['code'];
  if (code === ALIAS_V2_EXECUTION_NOT_ADMITTED_CODE) {
    return { kind: 'not_applied' };
  }
  if (code === ALIAS_V2_ADMISSION_LEDGER_MISSING_CODE) {
    return { kind: 'indeterminate', code };
  }
  return invalid();
}

function classifyFullEnvelope(
  body: JsonObject,
  binding: AliasV2ReadBinding,
): AliasV2StatusClassification {
  const identity = binding.identity;
  const bindings = identity.bindings;
  if (
    body['target_visibility'] !== identity.target_visibility ||
    body['freeze_sha256'] !== bindings['freeze_sha256'] ||
    body['approval_identity_sha256'] !== bindings['approval_identity_sha256'] ||
    body['approval_text_sha256'] !== bindings['approval_text_sha256'] ||
    body['derivative_target_set_sha256'] !== bindings['derivative_target_set_sha256'] ||
    !isSha256(body['server_derivative_targets_sha256']) ||
    !isSha256(body['preflight_proof_sha256']) ||
    !isSha256(body['admission_request_sha256']) ||
    !isSha256(body['gate_results_sha256']) ||
    !matchesObservedIdentities(body, binding.observed) ||
    !matchesGateReceipts(body, binding.observed)
  ) {
    return invalid();
  }
  const status = body['status'];
  if (status === ALIAS_V2_STATUS_PASSED) {
    if (!matchesConsumedDispatch(body, true) || body['execution_status'] !== 'completed') {
      return invalid();
    }
    // The proof is the authorization: a passed envelope without a genuine one is refused, always.
    const proof = validateAliasV2TerminalProof(body['terminal_proof'], binding);
    if ('code' in proof) {
      return invalid(proof.code);
    }
    const counts = binding.plan['expected'];
    if (
      !isJsonObject(counts) ||
      !matchesPrimaryClosure(body, counts) ||
      !matchesDerivativeClosure(body, binding, counts)
    ) {
      return invalid(ALIAS_V2_RESPONSE_READBACK_MISMATCH);
    }
    return proof.status === ALIAS_V2_STATUS_REPLAY
      ? { kind: 'idempotent_replay' }
      : { kind: 'applied', status: ALIAS_V2_STATUS_APPLIED };
  }
  // Every non-passed state must carry no terminal proof at all: a fabricated observation is refused
  // rather than ignored.
  if (body['terminal_proof'] !== undefined && body['terminal_proof'] !== null) {
    return invalid();
  }
  if (status === ALIAS_V2_STATUS_PENDING) {
    if (
      !matchesConsumedDispatch(body, false) ||
      !isJsonObject(body['primary_readback']) ||
      !isJsonObject(body['derivative_readback']) ||
      !(ALIAS_V2_IN_FLIGHT_EXECUTION_STATUSES as readonly string[]).includes(
        body['execution_status'] as string,
      )
    ) {
      return invalid();
    }
    return { kind: 'pending' };
  }
  if (status === ALIAS_V2_STATUS_FAILED) {
    const executionStatus = body['execution_status'];
    if (executionStatus !== 'failed' && executionStatus !== 'completed') {
      return invalid();
    }
    return { kind: 'failed', code: errorCodeOf(body, ALIAS_V2_EXECUTION_FAILED) };
  }
  if (status === ALIAS_V2_STATUS_INDETERMINATE) {
    if (body['execution_status'] !== ALIAS_V2_STATUS_INDETERMINATE) {
      return invalid();
    }
    return { kind: 'indeterminate', code: errorCodeOf(body, ALIAS_V2_EXECUTION_INDETERMINATE) };
  }
  return invalid();
}

/**
 * Classifies the payload of one protected read response. Only the actual versioned envelope is
 * understood: anything else is refused as an invalid response, and no classification here authorizes an
 * admission.
 */
export function classifyAliasV2ReadEnvelope(
  body: unknown,
  binding: AliasV2ReadBinding,
): AliasV2StatusClassification {
  if (
    !isJsonObject(body) ||
    body['command'] !== ALIAS_V2_STATUS_COMMAND ||
    body['schema_version'] !== ALIAS_V2_STATUS_SCHEMA ||
    !matchesEnvelopeBinding(body, binding)
  ) {
    return invalid();
  }
  return body['execution_status'] === 'not_admitted'
    ? classifyNotAdmitted(body, binding)
    : classifyFullEnvelope(body, binding);
}
