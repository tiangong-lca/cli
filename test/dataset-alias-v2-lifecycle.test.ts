import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aliasV2CohortSha256,
  buildAliasV2Plan,
  type AliasV2PlanInput,
} from '../src/lib/dataset-alias-v2-plan.js';
import {
  ALIAS_V2_AUDIT_COMMANDS,
  ALIAS_V2_ENDPOINTS,
  ALIAS_V2_EXECUTION_NOT_APPLIED,
  ALIAS_V2_GATE_NAMES,
  ALIAS_V2_GATE_WINDOW_SECONDS,
  ALIAS_V2_LIFECYCLE_REFUSED,
  ALIAS_V2_PRIVATE_EXECUTORS,
  ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  ALIAS_V2_RESPONSE_INVALID,
  ALIAS_V2_RESPONSE_READBACK_MISMATCH,
  ALIAS_V2_RESPONSE_STATUS_UNEXPECTED,
  ALIAS_V2_STAGE_UNKNOWN,
  MAX_POLL_ATTEMPTS,
  MAX_READBACK_ATTEMPTS,
  advanceAliasV2Lifecycle,
  classifyAliasV2Response,
  isAliasV2Terminal,
  startAliasV2Lifecycle,
  type AliasV2DispatchOutcome,
  type AliasV2Lifecycle,
  type AliasV2PlanBinding,
  type AliasV2Stage,
  type AliasV2StepResult,
} from '../src/lib/dataset-alias-v2-lifecycle.js';
import {
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  sealAliasV2Approval,
} from '../src/lib/dataset-alias-v2-protected.js';
import {
  ALIAS_V2_PROTOCOL,
  buildAliasV2ExecutionIdentity,
} from '../src/lib/dataset-alias-v2-protected-contract.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_APPROVED_AT,
  ALIAS_V2_TEST_PROJECT_REF,
  aliasV2Sets,
} from './helpers/alias-v2-artifacts.js';
import {
  aliasV2NotAdmittedEnvelope,
  aliasV2StatusEnvelope,
  aliasV2TerminalProof,
  type AliasV2StatusFixture,
} from './helpers/alias-v2-status.js';

type JsonObject = Record<string, unknown>;

const TARGET_FP = 'da11d28f-4db8-51eb-b3a9-8784b26771e6';
const SOURCE_FP = 'bd69e542-6a50-524c-8d04-195b1ec23150';

function planInput(): AliasV2PlanInput {
  return {
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    source_flow_property: {
      id: SOURCE_FP,
      version: '00.00.001',
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: { 'common:name': { '#text': 'Amount in hr', '@xml:lang': 'en' } },
            quantitativeReference: {
              referenceToReferenceUnitGroup: {
                '@type': 'unit group data set',
                '@refObjectId': '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb',
                '@version': '01.00.000',
              },
            },
          },
        },
      },
    },
    flows: [
      {
        id: 'flow-a',
        version: '00.00.001',
        json: {
          flowDataSet: {
            flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '1' } },
            modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
            flowProperties: {
              flowProperty: [
                {
                  '@dataSetInternalID': '1',
                  meanValue: '1',
                  referenceToFlowPropertyDataSet: {
                    '@type': 'flow property data set',
                    '@refObjectId': SOURCE_FP,
                    '@uri': `../flowproperties/${SOURCE_FP}.json`,
                    '@version': '00.00.001',
                    'common:shortDescription': { '#text': 'Amount in hr', '@xml:lang': 'en' },
                  },
                },
              ],
            },
          },
        },
      },
      {
        id: 'flow-b',
        version: '00.00.001',
        json: {
          flowDataSet: {
            flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '1' } },
            modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
            flowProperties: {
              flowProperty: [
                {
                  '@dataSetInternalID': '1',
                  meanValue: '1',
                  referenceToFlowPropertyDataSet: {
                    '@refObjectId': SOURCE_FP,
                    '@version': '00.00.001',
                  },
                },
              ],
            },
          },
        },
      },
    ],
    processes: [
      {
        id: 'process-a',
        version: '00.00.001',
        // The functional unit's reference exchange (internal id "1") is a selected alias occurrence.
        exchange_indexes: [0, 1],
        functional_unit: { source_exchange_number: '730045' },
        json: {
          processDataSet: {
            processInformation: {
              quantitativeReference: {
                referenceToReferenceFlow: '1',
                functionalUnitOrOther: { '#text': '1.0 a Use, computer', '@xml:lang': 'en' },
              },
            },
            exchanges: {
              exchange: [
                {
                  '@dataSetInternalID': '1',
                  meanAmount: '1.0',
                  resultingAmount: '1.0',
                  exchangeDirection: 'Output',
                  referenceToFlowDataSet: {
                    '@refObjectId': 'flow-a',
                    '@version': '00.00.001',
                  },
                  generalComment: {
                    '#text': 'Source EcoSpold1 exchange number: 730045.',
                    '@xml:lang': 'en',
                  },
                },
                {
                  '@dataSetInternalID': '2',
                  meanAmount: '2.0E-4',
                  resultingAmount: '2.0E-4',
                  exchangeDirection: 'Input',
                  referenceToFlowDataSet: {
                    '@refObjectId': 'flow-a',
                    '@version': '00.00.001',
                  },
                },
              ],
            },
          },
        },
      },
      {
        id: 'process-b',
        version: '00.00.001',
        exchange_indexes: [0, 1],
        functional_unit: { source_exchange_number: '730046' },
        json: {
          processDataSet: {
            processInformation: {
              quantitativeReference: {
                referenceToReferenceFlow: '1',
                functionalUnitOrOther: { '#text': '1.0 a Use, office', '@xml:lang': 'en' },
              },
            },
            exchanges: {
              exchange: [
                {
                  '@dataSetInternalID': '1',
                  meanAmount: '1.0',
                  resultingAmount: '1.0',
                  exchangeDirection: 'Output',
                  referenceToFlowDataSet: {
                    '@refObjectId': 'flow-a',
                    '@version': '00.00.001',
                  },
                  generalComment: {
                    '#text': 'Source EcoSpold1 exchange number: 730046.',
                    '@xml:lang': 'en',
                  },
                },
                {
                  '@dataSetInternalID': '2',
                  meanAmount: '9.1E-5',
                  resultingAmount: '9.1E-5',
                  exchangeDirection: 'Input',
                  referenceToFlowDataSet: {
                    '@refObjectId': 'flow-a',
                    '@version': '00.00.001',
                  },
                },
              ],
            },
          },
        },
      },
    ],
    target_flow_property: {
      id: TARGET_FP,
      version: '01.00.000',
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: { 'common:name': { '#text': 'Time', '@xml:lang': 'en' } },
            quantitativeReference: {
              referenceToReferenceUnitGroup: {
                '@refObjectId': '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb',
                '@version': '01.00.000',
              },
            },
          },
        },
      },
    },
    target_unit_group: {
      id: '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb',
      version: '01.00.000',
      json: {
        unitGroupDataSet: {
          // The real canonical shape: the base unit is selected by the reference's internal id,
          unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: '1' } },
          units: {
            unit: [
              { '@dataSetInternalID': '1', name: 'a', meanValue: '1' },
              { '@dataSetInternalID': '2', name: 'hr', meanValue: '0.00011415525114155251' },
            ],
          },
        },
      },
    },
    // The source alias's current declaration is the year-based table, not the orphan hour record.
    declared_source_unit_group: {
      id: '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb',
      version: '01.00.000',
      json: {
        unitGroupDataSet: {
          // The real canonical shape: the base unit is selected by the reference's internal id,
          unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: '1' } },
          units: {
            unit: [
              { '@dataSetInternalID': '1', name: 'a', meanValue: '1' },
              { '@dataSetInternalID': '2', name: 'hr', meanValue: '0.00011415525114155251' },
            ],
          },
        },
      },
    },
    source_alias: { id: SOURCE_FP, version: '00.00.001' },
    source_evidence: {
      sha256: 'e'.repeat(64),
      cohort_sha256: '',
      original_source_unit: 'hr',
    },
  };
}

const withEvidence = (value: AliasV2PlanInput): AliasV2PlanInput => ({
  ...value,
  source_evidence: {
    ...value.source_evidence,
    cohort_sha256: aliasV2CohortSha256(value),
  },
});
const built = buildAliasV2Plan(withEvidence(planInput()));
const PLAN = built.plan;

/**
 * The sealed execution of this exact plan: the freeze, the approval and the identity derived by the
 * same real builders the public stages use, so the read envelope can be bound to a genuine identity.
 */
function sealedFixture(): AliasV2StatusFixture {
  const freeze = buildAliasV2Freeze({
    plan: PLAN,
    planFileSha256: sha256Json(PLAN),
    projectRef: ALIAS_V2_TEST_PROJECT_REF,
    account: ALIAS_V2_TEST_ACCOUNT,
    sets: aliasV2Sets(PLAN['plan_sha256']),
    derivativeTargets: (PLAN['actions'] as JsonObject[]).map((action) => ({
      table: action['table'],
      id: action['id'],
      version: action['version'],
      user_id: ALIAS_V2_TEST_ACCOUNT.user_id,
      state_code: 0,
      baseline_snapshot_sha256: sha256Json({ baseline: action['id'] }),
    })),
  });
  const freezeFileSha256 = sha256Json(freeze.value);
  const request = buildAliasV2ApprovalRequest({
    freeze: freeze.value,
    freezeFileSha256,
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
    profile: 'alias_v2',
  });
  const approval = sealAliasV2Approval({
    request: request.value,
    requestFileSha256: sha256Json(request.value),
    humanApprovalText: request.value.approval_text,
    approvals: {
      plan: request.value.plan_sha256,
      freeze: request.value.freeze_sha256,
      request: sha256Json(request.value),
      text: request.value.approval_text_sha256,
    },
    confirm: ALIAS_V2_TEST_ACCOUNT.email,
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
  });
  const identity = buildAliasV2ExecutionIdentity({
    freeze: freeze.value,
    approval: approval.value,
    freezeFileSha256,
    approvalFileSha256: sha256Json(approval.value),
  });
  return { plan: PLAN, identity };
}

const FIXTURE = sealedFixture();
const REQUEST_ID = FIXTURE.identity.request_id;
const BINDING: AliasV2PlanBinding = {
  plan: PLAN,
  request_id: REQUEST_ID,
  identity: FIXTURE.identity,
  observed: {
    preflight_proof_sha256: sha256Json({ preflight: REQUEST_ID }),
    admission_request_sha256: sha256Json({ admit: REQUEST_ID }),
    gate_results_sha256: sha256Json({ gates: REQUEST_ID }),
    gate_expected_sha256: Object.fromEntries(
      ALIAS_V2_GATE_NAMES.map((gate) => [gate, sha256Json({ gate, plan: PLAN['plan_sha256'] })]),
    ),
    gate_receipt_sha256: Object.fromEntries(
      ALIAS_V2_GATE_NAMES.map((gate) => [gate, sha256Json({ gate })]),
    ),
  },
};

/** The actual terminal proof of this execution, before any case mutates it. */
function proof(): JsonObject {
  return aliasV2TerminalProof(FIXTURE);
}

/** The actual read envelope of this execution; `overrides` replaces top-level fields. */
function statusEnvelope(overrides: JsonObject = {}): JsonObject {
  return aliasV2StatusEnvelope(FIXTURE, overrides);
}

/** The actual passed envelope carrying the given terminal proof. */
function envelopeWithProof(value: JsonObject, overrides: JsonObject = {}): JsonObject {
  return aliasV2StatusEnvelope(FIXTURE, { terminal_proof: value, ...overrides });
}

/** The real admission reply body: the versioned consumption proof of this exact request. */
const ENVELOPE = {
  schema_version: ALIAS_V2_PROTOCOL.admit_response_schema,
  command: ALIAS_V2_PROTOCOL.admit_command,
  request_id: REQUEST_ID,
  plan_sha256: PLAN['plan_sha256'],
};

function classify(
  stage: AliasV2Stage,
  outcome: AliasV2DispatchOutcome,
  binding: AliasV2PlanBinding = BINDING,
): AliasV2StepResult {
  return classifyAliasV2Response({ stage, outcome, ...binding });
}

function response(body: unknown, status = 200): AliasV2DispatchOutcome {
  return { kind: 'response', status, body };
}

function refusal(body: unknown, status: number, stage: AliasV2Stage = 'admit'): string {
  const result = classify(stage, response(body, status));
  assert.equal(result.kind, 'refused', JSON.stringify(result));
  return (result as { code: string }).code;
}

/** A lifecycle that has passed preflight and all three gates, ready for one admission. */
function gated(): AliasV2Lifecycle {
  let state = startAliasV2Lifecycle({
    requestId: REQUEST_ID,
    planSha256: PLAN['plan_sha256'] as string,
  });
  state = advanceAliasV2Lifecycle(state, {
    stage: 'preflight',
    result: { kind: 'ok', stage: 'preflight', body: {} },
  });
  for (const gate of ALIAS_V2_GATE_NAMES) {
    state = advanceAliasV2Lifecycle(state, {
      stage: 'gate',
      result: { kind: 'ok', stage: 'gate', body: { gate_name: gate } },
    });
  }
  return state;
}

test('the approved wire identities are frozen here', () => {
  assert.deepEqual(ALIAS_V2_ENDPOINTS, {
    preflight: 'cmd_dataset_alias_execution_preflight_v2_guarded',
    gate: 'cmd_dataset_alias_execution_gate_v2_guarded',
    admit: 'cmd_dataset_alias_execution_admit_v2_guarded',
    read: 'cmd_dataset_alias_execution_read_v2',
  });
  assert.deepEqual(ALIAS_V2_PRIVATE_EXECUTORS, {
    plan: 'private.cmd_dataset_alias_plan_v2_guarded',
    batch: 'private.cmd_dataset_alias_batch_v2_guarded',
    execute: 'private.cmd_dataset_alias_execution_execute_v2',
  });
  assert.deepEqual(ALIAS_V2_GATE_NAMES, [
    'primary_support_plan',
    'execution_unused',
    'derivative_quiescence',
  ]);
  assert.equal(ALIAS_V2_GATE_WINDOW_SECONDS, 180);
  assert.deepEqual(ALIAS_V2_AUDIT_COMMANDS, [
    'cmd_dataset_alias_plan_v2_guarded',
    'cmd_dataset_alias_batch_v2_guarded',
  ]);
});

test('the terminal read is accepted only when it is bound to this exact plan', () => {
  assert.deepEqual(classify('read', response(statusEnvelope())), {
    kind: 'applied',
    stage: 'read',
    status: 'applied',
  });
  const replayed = envelopeWithProof({ ...proof(), status: 'idempotent_replay' });
  assert.deepEqual(classify('read', response(replayed)), {
    kind: 'idempotent_replay',
    stage: 'read',
  });
  // The read stage returning no durable evidence at all is its own outcome, never a resubmission.
  assert.deepEqual(classify('read', response(null)), { kind: 'not_applied' });
  // While the queued execution is in flight the server returns the bound in-flight envelope.
  assert.deepEqual(classify('read', response(statusEnvelope({ status: 'pending' }))), {
    kind: 'pending',
    stage: 'read',
  });
  // A terminal server state the server itself cannot resolve is published, not polled away.
  assert.deepEqual(classify('read', response(statusEnvelope({ status: 'indeterminate' }))), {
    kind: 'indeterminate',
    stage: 'read',
    code: 'ALIAS_V2_FIXTURE_INDETERMINATE',
  });
  assert.deepEqual(classify('read', response(statusEnvelope({ status: 'failed' }))), {
    kind: 'refused',
    status: 200,
    code: 'ALIAS_V2_FIXTURE_FAILED',
  });
  // The not-admitted answer proves no admission exists for this request id.
  assert.deepEqual(classify('read', response(aliasV2NotAdmittedEnvelope(FIXTURE))), {
    kind: 'not_applied',
  });
  // The old bare shapes are not the actual answer any more and are refused.
  assert.equal(refusal(proof(), 200, 'read'), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(
    refusal({ status: 'pending', plan_sha256: PLAN['plan_sha256'] }, 200, 'read'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.equal(
    refusal(statusEnvelope({ plan_sha256: 'f'.repeat(64) }), 200, 'read'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  // Without the sealed identity the envelope cannot be bound, so it is refused.
  const noIdentity = classify('read', response(statusEnvelope()), {
    plan: PLAN,
    request_id: REQUEST_ID,
  });
  assert.deepEqual(noIdentity, { kind: 'refused', status: 200, code: ALIAS_V2_RESPONSE_INVALID });
  // Admission answers with the plan-bound consumption proof; a terminal proof only ever arrives
  // through the read stage, so an admission reply shaped like one is refused.
  assert.deepEqual(classify('admit', response(ENVELOPE)), {
    kind: 'ok',
    stage: 'admit',
    body: ENVELOPE,
  });
  assert.equal(refusal(proof(), 200, 'admit'), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(refusal(statusEnvelope(), 200, 'admit'), ALIAS_V2_RESPONSE_INVALID);
  assert.equal(refusal(ENVELOPE, 200, 'read'), ALIAS_V2_RESPONSE_INVALID);
});

test('an invalid or diverging terminal proof is refused rather than trusted', () => {
  const invalid = ALIAS_V2_RESPONSE_INVALID;
  const countMismatch = ALIAS_V2_RESPONSE_COUNT_MISMATCH;
  const readbackMismatch = ALIAS_V2_RESPONSE_READBACK_MISMATCH;
  const auditOf = (value: JsonObject): JsonObject => value['audit'] as JsonObject;
  const rowsOf = (value: JsonObject): JsonObject[] =>
    (value['readback'] as JsonObject)['rows'] as JsonObject[];
  const cases: Array<[unknown, string]> = [
    ['nope', invalid],
    [envelopeWithProof({ ...proof(), status: 'ok' }), invalid],
    [envelopeWithProof({ ...proof(), plan_sha256: 'f'.repeat(64) }), invalid],
    [envelopeWithProof({ ...proof(), extra: 1 }), invalid],
    [
      (() => {
        const body = proof();
        const renamed = { ...body, status_note: body['status'] } as JsonObject;
        delete renamed['status'];
        return envelopeWithProof(renamed);
      })(),
      invalid,
    ],
    [
      (() => {
        const body = proof();
        delete body['audit'];
        return envelopeWithProof(body);
      })(),
      invalid,
    ],
    [envelopeWithProof({ ...proof(), counts: undefined }), countMismatch],
    [
      envelopeWithProof({
        ...proof(),
        counts: { ...(PLAN['expected'] as JsonObject), action_count: 999 },
      }),
      countMismatch,
    ],
    [envelopeWithProof({ ...proof(), counts: { action_count: 2 } }), countMismatch],
    // The batch count is the plan's one scientific batch, never the two tables or eight chunks.
    [
      envelopeWithProof({
        ...proof(),
        audit: { ...auditOf(proof()), batch_count: 2 },
      }),
      countMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: { ...auditOf(proof()), batch_count: 8 },
      }),
      countMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: { ...auditOf(proof()), row_audit_count: 1 },
      }),
      countMismatch,
    ],
    [envelopeWithProof({ ...proof(), audit: {} }), invalid],
    [
      envelopeWithProof({
        ...proof(),
        audit: { ...auditOf(proof()), plan_summary_audit_id: 0 },
      }),
      invalid,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: { ...auditOf(proof()), row_audits: [rowsOf(proof())[0]] },
      }),
      readbackMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: {
          ...auditOf(proof()),
          row_audits: [null, ...(auditOf(proof())['row_audits'] as unknown[]).slice(1)],
        },
      }),
      invalid,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: {
          ...auditOf(proof()),
          row_audits: [
            { ...(auditOf(proof())['row_audits'] as JsonObject[])[0], audit_id: -1 },
            ...(auditOf(proof())['row_audits'] as unknown[]).slice(1),
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        audit: {
          ...auditOf(proof()),
          row_audits: [
            {
              ...(auditOf(proof())['row_audits'] as JsonObject[])[0],
              after_sha256: '0'.repeat(64),
            },
            ...(auditOf(proof())['row_audits'] as unknown[]).slice(1),
          ],
        },
      }),
      readbackMismatch,
    ],
    [envelopeWithProof({ ...proof(), readback: null }), invalid],
    [
      envelopeWithProof({
        ...proof(),
        readback: { ...(proof()['readback'] as JsonObject), row_count: 1 },
      }),
      countMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        readback: { ...(proof()['readback'] as JsonObject), rows: [] },
      }),
      readbackMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        readback: {
          ...(proof()['readback'] as JsonObject),
          rows: [null, ...rowsOf(proof()).slice(1)],
        },
      }),
      invalid,
    ],
    [
      envelopeWithProof({
        ...proof(),
        readback: {
          ...(proof()['readback'] as JsonObject),
          rows: [
            { ...rowsOf(proof())[0], observed_sha256: '0'.repeat(64) },
            ...rowsOf(proof()).slice(1),
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        readback: {
          ...(proof()['readback'] as JsonObject),
          rows: [rowsOf(proof())[0], rowsOf(proof())[0]],
        },
      }),
      readbackMismatch,
    ],
    [
      envelopeWithProof({
        ...proof(),
        readback: {
          ...(proof()['readback'] as JsonObject),
          rows: (() => {
            const rows = structuredClone(rowsOf(proof()));
            const processRow = rows.findIndex((row) => row['table'] === 'processes');
            rows[processRow]!['functional_unit_text'] = 'wrong text';
            return rows;
          })(),
        },
      }),
      readbackMismatch,
    ],
  ];
  for (const [body, code] of cases) {
    assert.equal(refusal(body, 200, 'read'), code, JSON.stringify(body).slice(0, 200));
  }
});

test('the status policy maps to the reviewed refusals', () => {
  assert.equal(
    refusal({ code: 'ALIAS_V2_TEXT_RULE_VIOLATION' }, 400),
    'ALIAS_V2_TEXT_RULE_VIOLATION',
  );
  assert.equal(refusal({ code: '' }, 400), 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST');
  assert.equal(refusal('nope', 400), 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST');
  assert.equal(refusal({}, 413), 'ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE');
  assert.equal(refusal({ code: 'ALIAS_V2_REPLAY_CONFLICT' }, 409), 'ALIAS_V2_REPLAY_CONFLICT');
  assert.equal(refusal({}, 409), 'ALIAS_V2_DRIFT_OR_REPLAY');
  assert.equal(refusal({}, 418), ALIAS_V2_RESPONSE_STATUS_UNEXPECTED);
  assert.deepEqual(classify('admit', { kind: 'unknown', reason: 'socket hang up' }), {
    kind: 'readback_required',
    code: ALIAS_V2_STAGE_UNKNOWN,
    reason: 'socket hang up',
  });
  assert.deepEqual(classify('read', { kind: 'unknown', reason: 'reset' }), {
    kind: 'readback_required',
    code: ALIAS_V2_STAGE_UNKNOWN,
    reason: 'reset',
  });
  for (const stage of ['preflight', 'gate'] as const) {
    assert.deepEqual(classify(stage, { kind: 'unknown', reason: 'reset' }), {
      kind: 'refused',
      status: 0,
      code: ALIAS_V2_STAGE_UNKNOWN,
      reason: 'reset',
    });
  }
});

test('the read-only stages keep the client request and plan binding', () => {
  for (const stage of ['preflight', 'gate'] as const) {
    assert.deepEqual(classify(stage, response(ENVELOPE)), { kind: 'ok', stage, body: ENVELOPE });
    assert.equal(
      refusal({ ...ENVELOPE, request_id: 'other' }, 200, stage),
      ALIAS_V2_RESPONSE_INVALID,
    );
    assert.equal(
      refusal({ ...ENVELOPE, plan_sha256: 'f'.repeat(64) }, 200, stage),
      ALIAS_V2_RESPONSE_INVALID,
    );
    assert.equal(refusal('nope', 200, stage), ALIAS_V2_RESPONSE_INVALID);
  }
  assert.equal(
    refusal({ ...ENVELOPE, request_id: 'other' }, 200, 'admit'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.equal(refusal('nope', 200, 'admit'), ALIAS_V2_RESPONSE_INVALID);
});

test('the lifecycle admits once, polls to a terminal proof, and never resubmits', () => {
  let state = gated();
  assert.deepEqual([state.phase, state.admit_attempts, state.polls], ['gated', 0, 0]);
  state = advanceAliasV2Lifecycle(state, {
    stage: 'admit',
    result: classify('admit', response(ENVELOPE)),
  });
  assert.equal(state.phase, 'admitted');
  assert.equal(state.admit_attempts, 1);
  // Polling observes the queued execution until the terminal proof arrives.
  for (let poll = 0; poll < 2; poll += 1) {
    state = advanceAliasV2Lifecycle(state, {
      stage: 'read',
      result: classify('read', response(statusEnvelope({ status: 'pending' }))),
    });
    assert.deepEqual([state.phase, state.polls], ['admitted', poll + 1]);
  }
  state = advanceAliasV2Lifecycle(state, {
    stage: 'read',
    result: classify('read', response(statusEnvelope())),
  });
  assert.deepEqual([state.phase, state.code, state.polls], ['applied', null, 3]);
  assert.equal(isAliasV2Terminal(state.phase), true);
  // No phase can reach a second admission.
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(state, {
        stage: 'admit',
        result: classify('admit', response(ENVELOPE)),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );

  // An admission result that already carries a terminal state is final: it never queues a new one.
  const appliedAtAdmit = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: { kind: 'applied', stage: 'admit', status: 'applied' },
  });
  assert.deepEqual([appliedAtAdmit.phase, appliedAtAdmit.admit_attempts], ['applied', 1]);
  const replayedAtAdmit = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: { kind: 'idempotent_replay', stage: 'admit' },
  });
  assert.deepEqual(
    [replayedAtAdmit.phase, replayedAtAdmit.admit_attempts],
    ['idempotent_replay', 1],
  );
  // An unknown admission outcome suspends the lifecycle on the readback path, and the only stage
  // that can follow is the read stage.
  let unknown = gated();
  unknown = advanceAliasV2Lifecycle(unknown, {
    stage: 'admit',
    result: classify('admit', { kind: 'unknown', reason: 'socket hang up' }),
  });
  assert.deepEqual([unknown.phase, unknown.admit_attempts], ['readback_required', 1]);
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(unknown, {
        stage: 'admit',
        result: classify('admit', response(ENVELOPE)),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  // A read that finds the work applied closes the request.
  const recovered = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', response(statusEnvelope())),
  });
  assert.deepEqual([recovered.phase, recovered.read_attempts], ['applied', 1]);
  // A read that finds the stored proof of this same request is an idempotent replay.
  const replayedRead = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify(
      'read',
      response(envelopeWithProof({ ...proof(), status: 'idempotent_replay' })),
    ),
  });
  assert.deepEqual([replayedRead.phase, replayedRead.read_attempts], ['idempotent_replay', 1]);
  // A read that finds no durable evidence refuses the request for review: no automatic replay.
  const notApplied = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', response(null)),
  });
  assert.deepEqual(
    [notApplied.phase, notApplied.code],
    ['refused', ALIAS_V2_EXECUTION_NOT_APPLIED],
  );
  // A read that the server itself resolves as terminal unknown is published as indeterminate, and
  // the lifecycle stops observing.
  const resolvedUnknown = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', response(statusEnvelope({ status: 'indeterminate' }))),
  });
  assert.deepEqual(
    [resolvedUnknown.phase, resolvedUnknown.code],
    ['indeterminate', 'ALIAS_V2_FIXTURE_INDETERMINATE'],
  );
  assert.equal(isAliasV2Terminal(resolvedUnknown.phase), true);
  // A read that is itself refused adopts the server's code.
  const refusedRead = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', response({ code: 'ALIAS_V2_REPLAY_CONFLICT' }, 409)),
  });
  assert.deepEqual([refusedRead.phase, refusedRead.code], ['refused', 'ALIAS_V2_REPLAY_CONFLICT']);
  // A read that could not be dispatched stays on the readback path, bounded.
  let retrying = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', { kind: 'unknown', reason: 'reset' }),
  });
  assert.deepEqual([retrying.phase, retrying.read_attempts], ['readback_required', 1]);
  for (let attempt = 1; attempt < MAX_READBACK_ATTEMPTS; attempt += 1) {
    retrying = advanceAliasV2Lifecycle(retrying, {
      stage: 'read',
      result: classify('read', { kind: 'unknown', reason: 'reset' }),
    });
  }
  assert.equal(retrying.read_attempts, MAX_READBACK_ATTEMPTS);
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(retrying, {
        stage: 'read',
        result: classify('read', response(statusEnvelope())),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
});

test('stage order, gate order, polling bounds and unsupported results are all refused', () => {
  const started = startAliasV2Lifecycle({
    requestId: REQUEST_ID,
    planSha256: PLAN['plan_sha256'] as string,
  });
  assert.throws(
    () => startAliasV2Lifecycle({ requestId: '', planSha256: 'x' }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  assert.equal(isAliasV2Terminal('prepared'), false);
  // A gate before preflight, and an admission before the gates.
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(started, {
        stage: 'gate',
        result: { kind: 'ok', stage: 'gate', body: { gate_name: 'primary_support_plan' } },
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(started, {
        stage: 'admit',
        result: classify('admit', response(ENVELOPE)),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  // A gate acknowledged out of order, or twice, is refused.
  const partial = advanceAliasV2Lifecycle(
    advanceAliasV2Lifecycle(started, {
      stage: 'preflight',
      result: { kind: 'ok', stage: 'preflight', body: {} },
    }),
    {
      stage: 'gate',
      result: { kind: 'ok', stage: 'gate', body: { gate_name: 'primary_support_plan' } },
    },
  );
  assert.deepEqual([partial.gates, partial.phase], [['primary_support_plan'], 'preflight_passed']);
  for (const body of [{ gate_name: 'derivative_quiescence' }, {}]) {
    assert.throws(
      () =>
        advanceAliasV2Lifecycle(partial, {
          stage: 'gate',
          result: { kind: 'ok', stage: 'gate', body },
        }),
      (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
    );
  }
  // A gate result that is not an acknowledgement cannot advance or gate the plan.
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(partial, {
        stage: 'gate',
        result: { kind: 'readback_required', code: ALIAS_V2_STAGE_UNKNOWN, reason: 'reset' },
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  // Refusals at each stage stop the lifecycle with the server's code.
  const preflightRefused = advanceAliasV2Lifecycle(started, {
    stage: 'preflight',
    result: classify('preflight', response({ code: 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST' }, 400)),
  });
  assert.deepEqual(
    [preflightRefused.phase, preflightRefused.code],
    ['refused', 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST'],
  );
  const admitRefused = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: classify('admit', response({ code: 'ALIAS_V2_COUNT_MISMATCH' }, 409)),
  });
  assert.deepEqual([admitRefused.phase, admitRefused.code], ['refused', 'ALIAS_V2_COUNT_MISMATCH']);
  // Unsupported result kinds at a stage are refused rather than ignored.
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(started, {
        stage: 'preflight',
        result: { kind: 'applied', stage: 'preflight', status: 'applied' },
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(gated(), {
        stage: 'admit',
        result: { kind: 'pending', stage: 'admit' },
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  // A read before any admission is refused, and polling is bounded.
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(started, {
        stage: 'read',
        result: classify('read', response(statusEnvelope())),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
  let polling = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: classify('admit', response(ENVELOPE)),
  });
  for (let poll = 0; poll < MAX_POLL_ATTEMPTS; poll += 1) {
    polling = advanceAliasV2Lifecycle(polling, {
      stage: 'read',
      result: classify('read', response(statusEnvelope({ status: 'pending' }))),
    });
  }
  assert.equal(polling.polls, MAX_POLL_ATTEMPTS);
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(polling, {
        stage: 'read',
        result: classify('read', response(statusEnvelope({ status: 'pending' }))),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
});
