// The actual read-response contract: the versioned `dataset-alias-execution-status.v2` envelope as the
// database emits it (Database #673 `/tmp/funcs-only.sql`), bound strictly to the sealed execution and
// classified without ever trusting a stored success. The terminal proof only authorizes `applied` when
// its per-row audit identities, fresh observations and functional-unit texts equal what the sealed plan
// built, and its batch count is the plan's own scientific batch count.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Json, type JsonObject } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_EXECUTION_FAILED,
  ALIAS_V2_EXECUTION_INDETERMINATE,
  ALIAS_V2_GATE_NAMES,
  ALIAS_V2_READ_LOCK_BUSY_CODE,
  ALIAS_V2_READ_STATE_CHANGED_CODE,
  ALIAS_V2_REQUEST_NOT_FOUND_CODE,
  ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  ALIAS_V2_RESPONSE_INVALID,
  ALIAS_V2_RESPONSE_READBACK_MISMATCH,
  ALIAS_V2_STATUS_SCHEMA,
  aliasV2DerivativeChunkId,
  classifyAliasV2ReadEnvelope,
  type AliasV2ReadBinding,
  type AliasV2StatusClassification,
} from '../src/lib/dataset-alias-v2-status.js';
import { classifyAliasV2ReadRefusal } from '../src/lib/dataset-alias-v2-lifecycle.js';
import {
  sealedAliasV2Execution,
  type SealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import {
  aliasV2NotAdmittedEnvelope,
  aliasV2StatusEnvelope,
  aliasV2TerminalProof,
} from './helpers/alias-v2-status.js';

const SEALED: SealedAliasV2Execution = sealedAliasV2Execution();
const ACTIONS = SEALED.plan['actions'] as JsonObject[];

/** Clones a fixture and applies dotted-path edits; `undefined` deletes the addressed key. */
function patched(base: JsonObject, edits: Array<[string, unknown]>): JsonObject {
  const clone = structuredClone(base) as JsonObject;
  for (const [path, value] of edits) {
    const keys = path.split('.');
    let node: JsonObject = clone;
    for (const key of keys.slice(0, -1)) {
      node = node[key] as JsonObject;
    }
    const last = keys[keys.length - 1] as string;
    if (value === undefined) {
      delete node[last];
    } else {
      node[last] = value;
    }
  }
  return clone;
}

function binding(sealed: SealedAliasV2Execution = SEALED): AliasV2ReadBinding {
  return {
    plan: sealed.plan,
    request_id: sealed.identity.request_id,
    identity: sealed.identity,
    observed: {
      preflight_proof_sha256: sha256Json({ preflight: sealed.identity.request_id }),
      admission_request_sha256: sha256Json({ admit: sealed.identity.request_id }),
      gate_results_sha256: sha256Json({ gates: sealed.identity.request_id }),
      gate_expected_sha256: Object.fromEntries(
        ALIAS_V2_GATE_NAMES.map((gate) => [
          gate,
          sha256Json({ gate, plan: sealed.plan['plan_sha256'] }),
        ]),
      ),
      gate_receipt_sha256: Object.fromEntries(
        ALIAS_V2_GATE_NAMES.map((gate) => [gate, sha256Json({ gate })]),
      ),
    },
  };
}

function classify(
  body: unknown,
  sealed: SealedAliasV2Execution = SEALED,
  overrideBinding: Partial<AliasV2ReadBinding> = {},
): AliasV2StatusClassification {
  return classifyAliasV2ReadEnvelope(body, { ...binding(sealed), ...overrideBinding });
}

function refusalCode(
  edits: Array<[string, unknown]>,
  base: JsonObject = aliasV2StatusEnvelope(SEALED),
): string {
  const result = classify(patched(base, edits));
  assert.equal(result.kind, 'invalid', JSON.stringify(result));
  return (result as { code: string }).code;
}

test('the actual envelope keeps the deployed names and the deterministic sub-batch ids', () => {
  const envelope = aliasV2StatusEnvelope(SEALED);
  assert.equal(envelope['schema_version'], ALIAS_V2_STATUS_SCHEMA);
  assert.equal(envelope['command'], 'cmd_dataset_alias_execution_read_v2');
  // 387 targets at the reviewed bound of fifty are the deterministic eight sub-batches.
  assert.equal((envelope['derivative_readback'] as JsonObject)['chunk_count'], 8);
  // The chunk id is the md5 of `request_id:plan_sha256:ordinal` rendered as a UUID — pinned here so a
  // different derivation on either side can never agree by accident.
  assert.equal(
    aliasV2DerivativeChunkId(
      'fcfbc113-8d7e-575c-a7f3-ba5abfbf2265',
      '48aa6563e3b2cacfd8edf3e34c181de81761799329818a01a5456896c5b94d63',
      1,
    ),
    '2f221e57-a670-a742-16b6-7d7733fdc4f3',
  );
  assert.equal(
    aliasV2DerivativeChunkId(
      'fcfbc113-8d7e-575c-a7f3-ba5abfbf2265',
      '48aa6563e3b2cacfd8edf3e34c181de81761799329818a01a5456896c5b94d63',
      1,
    ).length,
    36,
  );
});

test('a passed envelope with its genuine terminal proof is applied', () => {
  assert.deepEqual(classify(aliasV2StatusEnvelope(SEALED)), {
    kind: 'applied',
    status: 'applied',
  });
  const replay = aliasV2StatusEnvelope(SEALED, {
    terminal_proof: { ...aliasV2TerminalProof(SEALED), status: 'idempotent_replay' },
  });
  assert.deepEqual(classify(replay), { kind: 'idempotent_replay' });
});

test('nothing that is not the actual envelope can become applied', () => {
  // The bare proof shapes are not the server's answer any more, and neither is anything else.
  assert.equal(classify(aliasV2TerminalProof(SEALED)).kind, 'invalid');
  assert.equal(
    classify({ status: 'pending', plan_sha256: SEALED.plan['plan_sha256'] }).kind,
    'invalid',
  );
  assert.equal(classify({ status: 'applied' }).kind, 'invalid');
  assert.equal(classify(null).kind, 'invalid');
  assert.equal(classify('passed').kind, 'invalid');
  assert.equal(classify([aliasV2StatusEnvelope(SEALED)]).kind, 'invalid');
  assert.equal(classify(aliasV2StatusEnvelope(SEALED)['terminal_proof']).kind, 'invalid');
  assert.equal(
    refusalCode([['command', 'cmd_dataset_alias_execution_read']]),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.equal(
    refusalCode([['schema_version', 'dataset-alias-execution-status.v1']]),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('the envelope is bound to this exact request, actor, project, environment and plan', () => {
  for (const edit of [
    ['request_id', 'f'.repeat(8) + '-0000-4000-8000-000000000000'],
    ['actor_user_id', 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb8'],
    ['environment', 'preview'],
    ['project_ref', 'another-project-ref'],
    ['plan_sha256', 'a'.repeat(64)],
    ['retry_allowed', true],
    ['retry_allowed', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]) + String(edit[1]));
  }
  // The actor must equal the plan's own actor too, not only the sealed identity's.
  const foreignPlan = { ...SEALED.plan, actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb8' };
  assert.equal(
    classify(aliasV2StatusEnvelope(SEALED), SEALED, { plan: foreignPlan }).kind,
    'invalid',
  );
});

test('the envelope must carry this execution freeze and approval identities', () => {
  for (const edit of [
    ['target_visibility', 'public'],
    ['freeze_sha256', 'b'.repeat(64)],
    ['approval_identity_sha256', 'c'.repeat(64)],
    ['approval_text_sha256', 'd'.repeat(64)],
    ['derivative_target_set_sha256', 'e'.repeat(64)],
    ['server_derivative_targets_sha256', 'not-a-sha'],
    ['preflight_proof_sha256', undefined],
    ['admission_request_sha256', 'not-a-sha'],
    ['gate_results_sha256', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]));
  }
});

test('the observed server identities of this run are re-bound when available', () => {
  const base = aliasV2StatusEnvelope(SEALED);
  for (const path of [
    'preflight_proof_sha256',
    'admission_request_sha256',
    'gate_results_sha256',
    'gates.2.receipt_sha256',
    'gates.0.expected_sha256',
  ]) {
    // A well-formed but foreign stored identity is refused while this run still holds its own.
    const foreign = sha256Json({ foreign: path });
    assert.equal(refusalCode([[path, foreign]]), ALIAS_V2_RESPONSE_INVALID, path);
  }
  // A status-only run holds no observed set: the same well-formed values then pass, because there is
  // nothing to re-bind them to in this invocation.
  const statusOnlyBinding = {
    plan: SEALED.plan,
    request_id: SEALED.identity.request_id,
    identity: SEALED.identity,
  };
  const foreignPreflight = patched(base, [
    ['preflight_proof_sha256', sha256Json({ foreign: 'x' })],
  ]);
  assert.equal(classifyAliasV2ReadEnvelope(foreignPreflight, statusOnlyBinding).kind, 'applied');
  // The gate expectations this run observed are also re-bound against the stored receipts.
  const foreignExpectation = patched(base, [
    ['gates.1.expected_sha256', sha256Json({ foreign: 'gate' })],
    ['gates.1.observed_sha256', sha256Json({ foreign: 'gate' })],
  ]);
  assert.equal(classify(foreignExpectation).kind, 'invalid');
  assert.equal(classifyAliasV2ReadEnvelope(foreignExpectation, statusOnlyBinding).kind, 'applied');
});

test('the stored gate receipts must be the three passed gates this run captured', () => {
  for (const edit of [
    ['gate_count', 2],
    ['gates', 'not-an-array'],
    ['gates', []],
    ['gates.0', 'not-an-object'],
    ['gates.0.gate', 5],
    ['gates.0.gate', 'another_gate'],
    ['gates.0.status', 'failed'],
    ['gates.0.expected_sha256', 'not-a-sha'],
    ['gates.0.observed_sha256', sha256Json({ other: true })],
    ['gates.0.receipt_sha256', 'not-a-sha'],
    ['gates.0.captured_at', 'not-a-timestamp'],
    ['gates.0.captured_at', undefined],
    ['gates.1.gate', 'primary_support_plan'],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]) + String(edit[1]));
  }
});

test('one consumed dispatch: attempt one, dispatch at most one, never a retry', () => {
  for (const edit of [
    ['attempt_count', 2],
    ['attempt_count', 0],
    ['attempt_count', undefined],
    ['dispatch_count', 2],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]) + String(edit[1]));
  }
  // A dispatch that has not happened yet is an in-flight state, not an invalid envelope.
  const notYetDispatched = patched(aliasV2StatusEnvelope(SEALED, { status: 'pending' }), [
    ['dispatch_count', 0],
  ]);
  assert.deepEqual(classify(notYetDispatched), { kind: 'pending' });
  // For a passed execution the dispatch must have happened exactly once.
  assert.equal(
    refusalCode([['dispatch_count', 0]], aliasV2StatusEnvelope(SEALED)),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('a passed state without a genuine terminal proof is refused, never trusted', () => {
  assert.equal(refusalCode([['terminal_proof', null]]), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(refusalCode([['terminal_proof', undefined]]), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(refusalCode([['terminal_proof', 'trust me']]), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(
    refusalCode([['execution_status', 'derivatives_pending']]),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('the terminal proof is bound to the plan and to its own exact shape', () => {
  for (const edit of [
    ['terminal_proof', 'not-an-object'],
    ['terminal_proof', { ...aliasV2TerminalProof(SEALED), extra: true }],
    ['terminal_proof.status', 'completed'],
    ['terminal_proof.plan_sha256', 'a'.repeat(64)],
    ['terminal_proof.audit', 'not-an-object'],
    ['terminal_proof.readback', 'not-an-object'],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]) + String(edit[1]));
  }
  for (const edit of [
    ['terminal_proof.counts.action_count', 386],
    ['terminal_proof.counts.extra', 1],
    ['terminal_proof.counts', null],
    ['terminal_proof.counts', 'not-an-object'],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_COUNT_MISMATCH, String(edit[0]));
  }
});

test('the audit block must describe the plan own batch topology, not a per-table guess', () => {
  // The scientific batch count is one; the old per-table rule demanded two and must now fail.
  assert.equal(
    refusalCode([['terminal_proof.audit.batch_count', 2]]),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
  assert.equal(
    refusalCode([['terminal_proof.audit.batch_count', 8]]),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
  assert.equal(
    refusalCode([['terminal_proof.audit.row_audit_count', 386]]),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
  for (const edit of [
    ['terminal_proof.audit.plan_summary_audit_id', 0],
    ['terminal_proof.audit.plan_summary_audit_id', 'p'],
    ['terminal_proof.audit.batch_summary_audit_id', 0],
    ['terminal_proof.audit', null],
    [
      'terminal_proof.audit',
      { ...(aliasV2TerminalProof(SEALED)['audit'] as JsonObject), extra: 1 },
    ],
    ['terminal_proof.audit.row_audits.0', 'not-an-object'],
    ['terminal_proof.audit.row_audits.0.audit_id', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]) + String(edit[1]));
  }
  for (const edit of [
    ['terminal_proof.audit.row_audits', []],
    ['terminal_proof.audit.row_audits.0.audit_id', -1],
    ['terminal_proof.audit.row_audits.0.audit_id', 1002],
    ['terminal_proof.audit.row_audits.0.after_sha256', 'f'.repeat(64)],
    ['terminal_proof.audit.row_audits.0.action_id', 'flow:foreign'],
    ['terminal_proof.audit.row_audits.0.id', 'foreign-row'],
    ['terminal_proof.audit.row_audits.0.table', 'processes'],
  ] as Array<[string, unknown]>) {
    assert.equal(
      refusalCode([edit]),
      ALIAS_V2_RESPONSE_READBACK_MISMATCH,
      String(edit[0]) + String(edit[1]),
    );
  }
  assert.equal(
    refusalCode([['terminal_proof.audit.row_audits', 'not-an-array']]),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('the readback block must carry one fresh observation per action, byte-equal to the plan', () => {
  assert.equal(
    refusalCode([['terminal_proof.readback.row_count', 386]]),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
  assert.equal(
    refusalCode([['terminal_proof.readback.exchange_count', 1]]),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
  for (const edit of [
    ['terminal_proof.readback.rows', 'not-an-array'],
    ['terminal_proof.readback.rows.0', 'not-an-object'],
    ['terminal_proof.readback.rows.0.observed_sha256', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_INVALID, String(edit[0]));
  }
  for (const edit of [
    ['terminal_proof.readback.rows', []],
    ['terminal_proof.readback.rows.0.observed_sha256', 'f'.repeat(64)],
    ['terminal_proof.readback.rows.0.id', 'foreign-row'],
    ['terminal_proof.readback.rows.1.id', String(ACTIONS[0]?.['id'])],
  ] as Array<[string, unknown]>) {
    assert.equal(
      refusalCode([edit]),
      ALIAS_V2_RESPONSE_READBACK_MISMATCH,
      String(edit[0]) + String(edit[1]),
    );
  }
  assert.equal(refusalCode([['terminal_proof.readback', null]]), ALIAS_V2_RESPONSE_INVALID);
});

test('the functional-unit text of a process must be the approved or the unchanged text', () => {
  const envelope = aliasV2StatusEnvelope(SEALED);
  const proof = envelope['terminal_proof'] as JsonObject;
  const entries = (proof['readback'] as JsonObject)['rows'] as JsonObject[];
  const corrected = entries.findIndex((entry) => entry['functional_unit_text'] !== null);
  const flowRow = entries.findIndex((entry) => entry['table'] === 'flows');
  assert.notEqual(corrected, -1);
  assert.notEqual(flowRow, -1);
  // A corrected process must show the approved post text, byte for byte.
  assert.equal(
    refusalCode([
      [
        'terminal_proof.readback.rows.' + String(corrected) + '.functional_unit_text',
        '1.0 hr changed',
      ],
    ]),
    ALIAS_V2_RESPONSE_READBACK_MISMATCH,
  );
  assert.equal(
    refusalCode([
      ['terminal_proof.readback.rows.' + String(corrected) + '.functional_unit_text', null],
    ]),
    ALIAS_V2_RESPONSE_READBACK_MISMATCH,
  );
  // A flow row carries no functional-unit expectation, so any observed value is ignored...
  assert.equal(
    classify(
      patched(envelope, [
        ['terminal_proof.readback.rows.' + String(flowRow) + '.functional_unit_text', 'ignored'],
      ]),
    ).kind,
    'applied',
  );
  // ...but the row still has to be the exact recorded shape, functional-unit key included.
  assert.equal(
    refusalCode([
      ['terminal_proof.readback.rows.' + String(flowRow) + '.functional_unit_text', undefined],
    ]),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('a functional-unit leaf that is not a string reads as no text, like a missing one', () => {
  const textActionIds = new Set(
    (SEALED.plan['text_actions'] as JsonObject[]).map((action) => String(action['id'])),
  );
  const index = ACTIONS.findIndex(
    (action) => action['table'] === 'processes' && !textActionIds.has(String(action['id'])),
  );
  assert.notEqual(index, -1);
  const action = ACTIONS[index] as JsonObject;
  // The path resolves, but its leaf is not a string: exactly the same "no text" reading.
  const oddBefore = structuredClone(action);
  oddBefore['expected_json_ordered'] = {
    processDataSet: {
      processInformation: {
        quantitativeReference: { functionalUnitOrOther: { '#text': 123 } },
      },
    },
  };
  const oddPlan = {
    ...SEALED.plan,
    actions: ACTIONS.map((entry, at) => (at === index ? oddBefore : entry)),
  };
  const proof = aliasV2TerminalProof(SEALED);
  const rows = (proof['readback'] as JsonObject)['rows'] as JsonObject[];
  const rowIndex = rows.findIndex((row) => row['id'] === action['id']);
  assert.notEqual(rowIndex, -1);
  const nullObservation = patched(aliasV2StatusEnvelope(SEALED, { terminal_proof: proof }), [
    ['terminal_proof.readback.rows.' + String(rowIndex) + '.functional_unit_text', null],
  ]);
  assert.equal(
    (classify(nullObservation, SEALED, { plan: oddPlan }) as { kind: string }).kind,
    'applied',
  );
});

test('a plan that carries no text actions expects every process to keep its before text', () => {
  // Every process row's observation is its own before-image text, and the plan carries no text
  // actions at all: the readback must still line up.
  const proof = aliasV2TerminalProof(SEALED);
  const rows = (proof['readback'] as JsonObject)['rows'] as JsonObject[];
  for (const row of rows) {
    if (row['table'] !== 'processes') {
      continue;
    }
    const action = ACTIONS.find((entry) => entry['id'] === row['id']) as JsonObject;
    const before = action['expected_json_ordered'] as JsonObject;
    const text = (
      ((before['processDataSet'] as JsonObject)['processInformation'] as JsonObject)[
        'quantitativeReference'
      ] as JsonObject
    )['functionalUnitOrOther'] as JsonObject;
    row['functional_unit_text'] = text['#text'];
  }
  const planWithoutTextActions = structuredClone(SEALED.plan);
  delete planWithoutTextActions['text_actions'];
  assert.equal(
    (
      classify(aliasV2StatusEnvelope(SEALED, { terminal_proof: proof }), SEALED, {
        plan: planWithoutTextActions,
      }) as { kind: string }
    ).kind,
    'applied',
  );
  // A malformed text action is not a text action: a non-object entry and a non-string after text are
  // both ignored, so the plan expects the unchanged before text and the genuine proof (which carries
  // the corrected text) no longer lines up.
  const corrected = (SEALED.plan['text_actions'] as JsonObject[])[0] as JsonObject;
  for (const malformed of ['not-an-object', { ...corrected, after_text: 5 }]) {
    const plan = structuredClone(SEALED.plan);
    plan['text_actions'] = [malformed];
    assert.equal(
      (classify(aliasV2StatusEnvelope(SEALED), SEALED, { plan }) as { kind: string }).kind,
      'invalid',
      JSON.stringify(malformed).slice(0, 60),
    );
  }
});

test('a plan without actions, with malformed actions or with duplicate identities refuses', () => {
  const noActions = { ...SEALED.plan, actions: [] };
  assert.equal(
    classify(aliasV2StatusEnvelope(SEALED), SEALED, { plan: noActions }).kind,
    'invalid',
  );
  const malformed = {
    ...SEALED.plan,
    actions: [...ACTIONS.slice(1), 'not-an-object'],
  };
  assert.equal(
    classify(aliasV2StatusEnvelope(SEALED), SEALED, { plan: malformed }).kind,
    'invalid',
  );
  const duplicated = { ...SEALED.plan, actions: [...ACTIONS.slice(0, -1), ACTIONS[0]] };
  assert.equal(
    classify(aliasV2StatusEnvelope(SEALED), SEALED, { plan: duplicated }).kind,
    'invalid',
  );
});

test('the before image reads the functional-unit leaf tolerantly, and a missing leaf means no text', () => {
  // Find a process whose text is unchanged and whose plan carries no text action for it.
  const textActionIds = new Set(
    (SEALED.plan['text_actions'] as JsonObject[]).map((action) => String(action['id'])),
  );
  const index = ACTIONS.findIndex(
    (action) => action['table'] === 'processes' && !textActionIds.has(String(action['id'])),
  );
  assert.notEqual(index, -1);
  const action = ACTIONS[index] as JsonObject;
  // A before image whose functional-unit leaf is not a nested string reads as no text: a proof that
  // claims a text there is refused...
  const flatBefore = structuredClone(action);
  flatBefore['expected_json_ordered'] = { processDataSet: 'not-an-object' };
  const flatPlan = {
    ...SEALED.plan,
    actions: ACTIONS.map((entry, at) => (at === index ? flatBefore : entry)),
  };
  const proof = aliasV2TerminalProof(SEALED);
  const rows = (proof['readback'] as JsonObject)['rows'] as JsonObject[];
  const rowIndex = rows.findIndex((row) => row['id'] === action['id']);
  assert.notEqual(rowIndex, -1);
  const claimingText = patched(aliasV2StatusEnvelope(SEALED, { terminal_proof: proof }), [
    ['terminal_proof.readback.rows.' + String(rowIndex) + '.functional_unit_text', 'claimed text'],
  ]);
  assert.equal(
    (classify(claimingText, SEALED, { plan: flatPlan }) as { kind: string }).kind,
    'invalid',
  );
  // ...while a null observation is exactly the missing leaf's own value, bound by the complete
  // observed payload hash above it.
  const claimingNull = patched(aliasV2StatusEnvelope(SEALED, { terminal_proof: proof }), [
    ['terminal_proof.readback.rows.' + String(rowIndex) + '.functional_unit_text', null],
  ]);
  const accepted = classify(claimingNull, SEALED, { plan: flatPlan });
  assert.equal(accepted.kind, 'applied');
});

test('the fresh primary closure must agree with the proof and the plan', () => {
  for (const edit of [
    ['primary_readback', 'not-an-object'],
    ['primary_readback.row_count', 386],
    ['primary_readback.exchange_count', 1],
    ['primary_readback.alias_audit_count', 1],
    ['primary_readback.live_closure_proof', false],
    ['primary_readback.closure', 'not-an-object'],
    ['primary_readback.closure.ok', false],
    ['primary_readback.closure.live_closure_proof', false],
    ['primary_readback.closure.row_count', 386],
    ['primary_readback.closure.claimed_row_count', 386],
    ['primary_readback.closure.invalid_action_count', 1],
    ['primary_readback.closure.proof_sha256', 'not-a-sha'],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit]), ALIAS_V2_RESPONSE_READBACK_MISMATCH, String(edit[0]));
  }
});

test('the derivative closure must be exactly the deterministic sub-batches of this execution', () => {
  for (const edit of [
    ['derivative_readback', 'not-an-object'],
    ['derivative_readback.schema_version', 'dataset-derivative-rebuild-batch-status.v1'],
    ['derivative_readback.request_id', 'f'.repeat(8) + '-0000-4000-8000-000000000000'],
    ['derivative_readback.status', 'pending'],
    ['derivative_readback.causal_terminal_proof', false],
    ['derivative_readback.membership_exact', false],
    ['derivative_readback.chunk_target_bound', 100],
    ['derivative_readback.target_count', 'many'],
    ['derivative_readback.target_count', 386],
    ['derivative_readback.approved_target_count', 386],
    ['derivative_readback.completed_count', 386],
    ['derivative_readback.nonterminal_count', 1],
    ['derivative_readback.failed_count', 1],
    ['derivative_readback.invalid_proof_count', 1],
    ['derivative_readback.flow_count', 1],
    ['derivative_readback.process_count', 1],
    ['derivative_readback.chunk_count', 7],
    ['derivative_readback.chunks', 'not-an-array'],
    ['derivative_readback.chunks', []],
    ['derivative_readback.chunks.0', 'not-an-object'],
    ['derivative_readback.chunks.0.ordinal', 2],
    ['derivative_readback.chunks.0.batch_id', 'f'.repeat(8) + '-0000-4000-8000-000000000000'],
    ['derivative_readback.chunks.0.status', 'pending'],
    ['derivative_readback.chunks.0.causal_terminal_proof', false],
    ['derivative_readback.chunks.0.failed_count', 1],
    ['derivative_readback.chunks.0.nonterminal_count', 1],
    ['derivative_readback.chunks.0.target_count', 0],
    ['derivative_readback.chunks.0.target_count', 51],
    ['derivative_readback.chunks.0.completed_count', 49],
    ['derivative_readback.chunks.7', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(
      refusalCode([edit]),
      ALIAS_V2_RESPONSE_READBACK_MISMATCH,
      String(edit[0]) + String(edit[1]),
    );
  }
});

test('a plan whose target count is not a usable count can never authorize anything', () => {
  // The closure comparison reads the plan's own derivative target count first; a plan that does not
  // carry a usable one is refused before any stored `completed` is even considered.
  for (const unusable of ['many', -1]) {
    const corruptedPlan = {
      ...SEALED.plan,
      expected: { ...(SEALED.plan['expected'] as JsonObject), derivative_target_count: unusable },
    };
    const envelope = aliasV2StatusEnvelope(SEALED, {
      terminal_proof: {
        ...aliasV2TerminalProof(SEALED),
        counts: corruptedPlan['expected'],
      },
    });
    assert.equal(
      (classify(envelope, SEALED, { plan: corruptedPlan }) as { kind: string }).kind,
      'invalid',
      String(unusable),
    );
  }
});

test('the in-flight, failed, indeterminate and not-admitted states classify as themselves', () => {
  for (const executionStatus of ['dispatching', 'dispatched', 'running', 'derivatives_pending']) {
    const envelope = aliasV2StatusEnvelope(SEALED, {
      status: 'pending',
      execution_status: executionStatus,
    });
    assert.deepEqual(classify(envelope), { kind: 'pending' }, executionStatus);
  }
  const pending = aliasV2StatusEnvelope(SEALED, { status: 'pending' });
  for (const edit of [
    ['execution_status', 'completed'],
    ['primary_readback', undefined],
    ['derivative_readback', undefined],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit], pending), ALIAS_V2_RESPONSE_INVALID, String(edit[0]));
  }
  const failed = aliasV2StatusEnvelope(SEALED, { status: 'failed' });
  assert.deepEqual(classify(failed), { kind: 'failed', code: 'ALIAS_V2_FIXTURE_FAILED' });
  for (const error of [null, { phase: 'x' }, { code: '' }]) {
    assert.deepEqual(classify(patched(failed, [['error', error]])), {
      kind: 'failed',
      code: ALIAS_V2_EXECUTION_FAILED,
    });
  }
  assert.deepEqual(classify(patched(failed, [['execution_status', 'completed']])).kind, 'failed');
  assert.equal(refusalCode([['execution_status', 'running']], failed), ALIAS_V2_RESPONSE_INVALID);
  const indeterminate = aliasV2StatusEnvelope(SEALED, { status: 'indeterminate' });
  assert.deepEqual(classify(indeterminate), {
    kind: 'indeterminate',
    code: 'ALIAS_V2_FIXTURE_INDETERMINATE',
  });
  for (const error of [null, { code: '' }]) {
    assert.deepEqual(classify(patched(indeterminate, [['error', error]])), {
      kind: 'indeterminate',
      code: ALIAS_V2_EXECUTION_INDETERMINATE,
    });
  }
  assert.equal(
    refusalCode([['execution_status', 'failed']], indeterminate),
    ALIAS_V2_RESPONSE_INVALID,
  );
  // An unknown status category is refused by the fall-through itself, so the base carries no proof.
  assert.equal(
    refusalCode([
      ['status', 'weird'],
      ['terminal_proof', null],
    ]),
    ALIAS_V2_RESPONSE_INVALID,
  );
});

test('a fabricated terminal proof on any non-passed state is refused', () => {
  for (const status of ['pending', 'failed', 'indeterminate']) {
    const envelope = aliasV2StatusEnvelope(SEALED, { status });
    assert.equal(
      classify(patched(envelope, [['terminal_proof', aliasV2TerminalProof(SEALED)]])).kind,
      'invalid',
      status,
    );
  }
});

test('the not-admitted answer maps to no-admission, and a missing ledger never does', () => {
  const notAdmitted = aliasV2NotAdmittedEnvelope(SEALED);
  assert.deepEqual(classify(notAdmitted), { kind: 'not_applied' });
  // The shape never carries a proof key at all, and an explicit null is equivalent.
  assert.deepEqual(classify(patched(notAdmitted, [['terminal_proof', undefined]])), {
    kind: 'not_applied',
  });
  assert.deepEqual(classify(patched(notAdmitted, [['terminal_proof', null]])), {
    kind: 'not_applied',
  });
  // A fabricated proof on a not-admitted answer is refused like on every other non-passed state.
  assert.equal(
    refusalCode([['terminal_proof', aliasV2TerminalProof(SEALED)]], notAdmitted),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.deepEqual(
    classify(patched(notAdmitted, [['code', 'ALIAS_EXECUTION_ADMISSION_LEDGER_MISSING']])),
    { kind: 'indeterminate', code: 'ALIAS_EXECUTION_ADMISSION_LEDGER_MISSING' },
  );
  for (const edit of [
    ['status', 'pending'],
    ['code', 'SOMETHING_ELSE'],
    ['preflight_proof_sha256', 'not-a-sha'],
    ['preflight_proof_sha256', sha256Json({ preflight: 'foreign' })],
  ] as Array<[string, unknown]>) {
    assert.equal(refusalCode([edit], notAdmitted), ALIAS_V2_RESPONSE_INVALID, String(edit[0]));
  }
  // A consumed preflight whose ledger row is missing must never read as not-admitted.
  assert.equal(
    classify(patched(notAdmitted, [['code', 'ALIAS_EXECUTION_ADMISSION_LEDGER_MISSING']])).kind,
    'indeterminate',
  );
});

test('the read-only retry codes stay a read-only retry', () => {
  assert.deepEqual(
    classifyAliasV2ReadRefusal({ status: 409, code: ALIAS_V2_READ_STATE_CHANGED_CODE }),
    {
      kind: 'pending',
      stage: 'read',
    },
  );
  assert.deepEqual(classifyAliasV2ReadRefusal({ status: 0, code: ALIAS_V2_READ_LOCK_BUSY_CODE }), {
    kind: 'pending',
    stage: 'read',
  });
  assert.deepEqual(
    classifyAliasV2ReadRefusal({ status: 404, code: ALIAS_V2_REQUEST_NOT_FOUND_CODE }),
    {
      kind: 'not_applied',
    },
  );
  assert.deepEqual(classifyAliasV2ReadRefusal({ status: 409, code: 'ALIAS_V2_REPLAY_CONFLICT' }), {
    kind: 'refused',
    status: 409,
    code: 'ALIAS_V2_REPLAY_CONFLICT',
  });
});
