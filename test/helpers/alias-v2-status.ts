// Builds the ACTUAL `dataset-alias-execution-status.v2` read envelope the database returns, exactly as
// `/tmp/funcs-only.sql` (Database #673) emits it: the full request/actor/project/freeze/approval/admission
// bindings, the one consumed dispatch, the three stored gate receipts, the live primary closure, the
// derivative orchestration aggregate and — only for a genuinely passed read — the terminal proof whose
// per-row audit identities and fresh observations come from the ledger and the live rows.

import { sha256Json, type JsonObject } from '../../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_CHUNK_TARGET_BOUND,
  ALIAS_V2_DERIVATIVE_ORCHESTRATION_SCHEMA,
  ALIAS_V2_GATE_NAMES,
  ALIAS_V2_STATUS_COMMAND,
  ALIAS_V2_STATUS_SCHEMA,
  aliasV2DerivativeChunkId,
  type AliasV2GateName,
} from '../../src/lib/dataset-alias-v2-status.js';
import type { AliasV2ExecutionIdentity } from '../../src/lib/dataset-alias-v2-protected-contract.js';

export type AliasV2StatusFixture = {
  plan: JsonObject;
  identity: AliasV2ExecutionIdentity;
};

export const ALIAS_V2_FIXTURE_CAPTURED_AT = '2026-09-21T00:00:10.000Z';

function functionalUnitTextOfAction(action: JsonObject): string | null {
  const before = action['expected_json_ordered'] as JsonObject;
  const dataSet = before?.['processDataSet'] as JsonObject;
  const processInformation = dataSet?.['processInformation'] as JsonObject;
  const quantitativeReference = processInformation?.['quantitativeReference'] as JsonObject;
  const functionalUnit = quantitativeReference?.['functionalUnitOrOther'] as JsonObject;
  const text = functionalUnit?.['#text'];
  return typeof text === 'string' ? text : null;
}

/**
 * The genuine terminal proof for one sealed execution: one recorded row audit per action whose
 * `after_sha256` is the plan's desired digest, and one fresh observation per action whose
 * `observed_sha256` equals the same digest — the direction the CLI checks (observed == desired).
 */
export function aliasV2TerminalProof(fixture: AliasV2StatusFixture): JsonObject {
  const plan = fixture.plan;
  const actions = plan['actions'] as JsonObject[];
  const expected = plan['expected'] as JsonObject;
  // A profile with no text action (Length*time) carries no `text_actions` block at all: every
  // process then shows the functional-unit text of its own before image, which is what the
  // readback comparison demands.
  const textActions = new Map(
    (Array.isArray(plan['text_actions']) ? (plan['text_actions'] as JsonObject[]) : []).map(
      (action) => [
        `${String(action['table'])}:${String(action['id'])}@${String(action['version'])}`,
        action['after_text'] as string,
      ],
    ),
  );
  let auditId = 1_000;
  return {
    status: 'applied',
    plan_sha256: plan['plan_sha256'],
    counts: expected,
    audit: {
      batch_count: expected['batch_count'],
      row_audit_count: actions.length,
      plan_summary_audit_id: 501,
      batch_summary_audit_id: 502,
      row_audits: actions.map((action) => {
        auditId += 1;
        return {
          audit_id: auditId,
          action_id: action['action_id'],
          table: action['table'],
          id: action['id'],
          version: action['version'],
          after_sha256: action['desired_sha256'],
        };
      }),
    },
    readback: {
      row_count: actions.length,
      exchange_count: expected['exchange_count'],
      rows: actions.map((action) => {
        const key = `${String(action['table'])}:${String(action['id'])}@${String(action['version'])}`;
        return {
          table: action['table'],
          id: action['id'],
          version: action['version'],
          observed_sha256: action['desired_sha256'],
          functional_unit_text:
            action['table'] === 'flows'
              ? null
              : (textActions.get(key) ?? functionalUnitTextOfAction(action)),
        };
      }),
    },
  };
}

/** The three passed gate receipts of one execution, with the fixture's expectation and receipt digests. */
export function aliasV2GateReceipts(
  fixture: AliasV2StatusFixture,
  options: { capturedAt?: string } = {},
): JsonObject[] {
  const capturedAt = options.capturedAt ?? ALIAS_V2_FIXTURE_CAPTURED_AT;
  return ALIAS_V2_GATE_NAMES.map((gate) => {
    const expected = sha256Json({ gate, plan: fixture.plan['plan_sha256'] });
    return {
      gate,
      expected_sha256: expected,
      observed_sha256: expected,
      status: 'passed',
      captured_at: capturedAt,
      receipt_sha256: sha256Json({ gate }),
    };
  });
}

/** The deterministic sub-batch list of one execution: ordinals 1..ceil(targets/50), chunked in order. */
export function aliasV2ChunkProofs(fixture: AliasV2StatusFixture): JsonObject[] {
  const targets = fixture.identity.derivative_targets;
  const chunkCount = Math.ceil(targets.length / ALIAS_V2_CHUNK_TARGET_BOUND);
  return Array.from({ length: chunkCount }, (_, index) => {
    const ordinal = index + 1;
    const start = index * ALIAS_V2_CHUNK_TARGET_BOUND;
    const count = Math.min(ALIAS_V2_CHUNK_TARGET_BOUND, targets.length - start);
    return {
      ordinal,
      batch_id: aliasV2DerivativeChunkId(
        fixture.identity.request_id,
        fixture.identity.plan_sha256,
        ordinal,
      ),
      status: 'completed',
      code: null,
      target_count: count,
      completed_count: count,
      nonterminal_count: 0,
      failed_count: 0,
      causal_terminal_proof: true,
    };
  });
}

/** The derivative orchestration aggregate of one completed execution. */
export function aliasV2DerivativeReadback(fixture: AliasV2StatusFixture): JsonObject {
  const targets = fixture.identity.derivative_targets;
  const chunks = aliasV2ChunkProofs(fixture);
  return {
    schema_version: ALIAS_V2_DERIVATIVE_ORCHESTRATION_SCHEMA,
    request_id: fixture.identity.request_id,
    chunk_count: chunks.length,
    chunk_target_bound: ALIAS_V2_CHUNK_TARGET_BOUND,
    target_count: targets.length,
    approved_target_count: targets.length,
    membership_exact: true,
    flow_count: targets.filter((target) => target.table === 'flows').length,
    process_count: targets.filter((target) => target.table === 'processes').length,
    completed_count: targets.length,
    nonterminal_count: 0,
    failed_count: 0,
    invalid_proof_count: 0,
    causal_terminal_proof: true,
    status: 'completed',
    chunks,
  };
}

/** The live primary closure of one committed execution. */
export function aliasV2PrimaryReadback(fixture: AliasV2StatusFixture): JsonObject {
  const expected = fixture.plan['expected'] as JsonObject;
  const actionCount = expected['action_count'] as number;
  return {
    row_count: actionCount,
    exchange_count: expected['exchange_count'],
    alias_audit_count: expected['audit_count'],
    live_closure_proof: true,
    closure: {
      ok: true,
      live_closure_proof: true,
      row_count: actionCount,
      claimed_row_count: actionCount,
      exchange_count: expected['exchange_count'],
      invalid_action_count: 0,
      proof_sha256: sha256Json({ closure: fixture.identity.request_id }),
    },
  };
}

/**
 * The full status envelope of one sealed execution. `overrides` replaces top-level fields (a `null`
 * value deletes the key, so absent-field cases are expressible), and `proof: null` removes the terminal
 * proof, which is what every non-passed state must carry.
 */
export function aliasV2StatusEnvelope(
  fixture: AliasV2StatusFixture,
  overrides: Record<string, unknown> = {},
): JsonObject {
  const identity = fixture.identity;
  const status = (overrides['status'] as string) ?? 'passed';
  const terminalProof =
    'terminal_proof' in overrides
      ? overrides['terminal_proof']
      : status === 'passed'
        ? aliasV2TerminalProof(fixture)
        : null;
  const executionStatus =
    (overrides['execution_status'] as string) ??
    (status === 'passed'
      ? 'completed'
      : status === 'failed'
        ? 'failed'
        : status === 'indeterminate'
          ? 'indeterminate'
          : 'derivatives_pending');
  const envelope: JsonObject = {
    ok: true,
    command: ALIAS_V2_STATUS_COMMAND,
    schema_version: ALIAS_V2_STATUS_SCHEMA,
    request_id: identity.request_id,
    status,
    terminal_proof: terminalProof,
    execution_status: executionStatus,
    retry_allowed: false,
    actor_user_id: identity.actor.user_id,
    environment: identity.environment,
    project_ref: identity.project_ref,
    target_visibility: identity.target_visibility,
    plan_sha256: identity.plan_sha256,
    operation_id: 'fixture-operation-1',
    plan_request_sha256: sha256Json({ plan: identity.plan_sha256 }),
    freeze_sha256: identity.bindings['freeze_sha256'],
    approval_identity_sha256: identity.bindings['approval_identity_sha256'],
    approval_text_sha256: identity.bindings['approval_text_sha256'],
    derivative_target_set_sha256: identity.bindings['derivative_target_set_sha256'],
    server_derivative_targets_sha256: sha256Json({ targets: identity.derivative_targets.length }),
    preflight_proof_sha256: sha256Json({ preflight: identity.request_id }),
    admission_request_sha256: sha256Json({ admit: identity.request_id }),
    gate_results_sha256: sha256Json({ gates: identity.request_id }),
    attempt_count: 1,
    dispatch_count: 1,
    net_request_id: 'fixture-net-request-1',
    preflight_completed_at: '2026-09-21T00:00:00.000Z',
    preflight_expires_at: '2026-09-21T00:02:30.000Z',
    preflight_consumed_at: '2026-09-21T00:00:05.000Z',
    admitted_at: '2026-09-21T00:00:05.000Z',
    dispatched_at: '2026-09-21T00:00:06.000Z',
    started_at: '2026-09-21T00:00:07.000Z',
    primary_committed_at: status === 'pending' ? null : '2026-09-21T00:00:20.000Z',
    terminal_at: status === 'pending' ? null : '2026-09-21T00:03:00.000Z',
    gate_count: 3,
    gates: aliasV2GateReceipts(fixture),
    primary_readback: aliasV2PrimaryReadback(fixture),
    derivative_readback: aliasV2DerivativeReadback(fixture),
    error:
      status === 'failed' || status === 'indeterminate'
        ? { phase: 'readback', code: `ALIAS_V2_FIXTURE_${status.toUpperCase()}` }
        : null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null && key !== 'terminal_proof') {
      delete envelope[key];
    } else {
      envelope[key] = value;
    }
  }
  return envelope;
}

/** The envelope the database returns for a request whose ledger row does not exist yet. */
export function aliasV2NotAdmittedEnvelope(
  fixture: AliasV2StatusFixture,
  overrides: JsonObject = {},
): JsonObject {
  const identity = fixture.identity;
  return {
    ok: true,
    command: ALIAS_V2_STATUS_COMMAND,
    schema_version: ALIAS_V2_STATUS_SCHEMA,
    request_id: identity.request_id,
    status: 'indeterminate',
    execution_status: 'not_admitted',
    code: 'ALIAS_EXECUTION_NOT_ADMITTED',
    retry_allowed: false,
    actor_user_id: identity.actor.user_id,
    environment: identity.environment,
    project_ref: identity.project_ref,
    plan_sha256: identity.plan_sha256,
    operation_id: 'fixture-operation-1',
    plan_request_sha256: sha256Json({ plan: identity.plan_sha256 }),
    preflight_proof_sha256: sha256Json({ preflight: identity.request_id }),
    preflight_completed_at: '2026-09-21T00:00:00.000Z',
    preflight_expires_at: '2026-09-21T00:02:30.000Z',
    preflight_consumed_at: null,
    gate_count: 0,
    gates: [],
    ...overrides,
  };
}

/** The three gate names as a typed list, for tests that enumerate them. */
export const ALIAS_V2_FIXTURE_GATES: readonly AliasV2GateName[] = ALIAS_V2_GATE_NAMES;
