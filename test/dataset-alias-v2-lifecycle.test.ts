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
  type AliasV2Stage,
  type AliasV2StepResult,
} from '../src/lib/dataset-alias-v2-lifecycle.js';

type JsonObject = Record<string, unknown>;

const REQUEST_ID = '9f1c6f0e-6a2b-4a3f-9f0d-3b0d5a7c1e42';
const TARGET_FP = 'da11d28f-4db8-51eb-b3a9-8784b26771e6';
const SOURCE_FP = 'bd69e542-6a50-524c-8d04-195b1ec23150';

function planInput(): AliasV2PlanInput {
  return {
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
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
        exchange_indexes: [1],
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
                    '@refObjectId': 'flow-unrelated',
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
        exchange_indexes: [1],
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
                    '@refObjectId': 'flow-unrelated',
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
const BINDING = { plan: PLAN, request_id: REQUEST_ID };

/** The terminal proof the server is expected to return for this plan, before any case mutates it. */
function proof(overrides: JsonObject = {}): JsonObject {
  const actions = PLAN['actions'] as JsonObject[];
  const textActions = PLAN['text_actions'] as JsonObject[];
  return {
    status: 'applied',
    plan_sha256: PLAN['plan_sha256'],
    counts: PLAN['expected'],
    audit: {
      plan_summary_id: 'audit-plan-summary-1',
      batch_summary_ids: ['audit-batch-flows-1', 'audit-batch-processes-1'],
    },
    readback: {
      flows: actions
        .filter((action) => action['table'] === 'flows')
        .map((action) => ({
          table: 'flows',
          id: action['id'],
          version: action['version'],
          desired_sha256: action['desired_sha256'],
        })),
      processes: actions
        .filter((action) => action['table'] === 'processes')
        .map((action) => ({
          table: 'processes',
          id: action['id'],
          version: action['version'],
          desired_sha256: action['desired_sha256'],
        })),
      text_actions: textActions.map((action) => ({
        id: action['id'],
        version: action['version'],
        after_text: action['after_text'],
      })),
    },
    ...overrides,
  };
}

const ENVELOPE = { request_id: REQUEST_ID, plan_sha256: PLAN['plan_sha256'] };
const PENDING_READ = { status: 'pending', plan_sha256: PLAN['plan_sha256'] };

function classify(
  stage: AliasV2Stage,
  outcome: AliasV2DispatchOutcome,
  binding = BINDING,
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
  assert.deepEqual(classify('read', response(proof())), {
    kind: 'applied',
    stage: 'read',
    status: 'applied',
  });
  assert.deepEqual(classify('read', response(proof({ status: 'idempotent_replay' }))), {
    kind: 'idempotent_replay',
    stage: 'read',
  });
  // The read stage returning no durable evidence is its own outcome, never a resubmission.
  assert.deepEqual(classify('read', response(null)), { kind: 'not_applied' });
  // While the queued execution is in flight the server returns exactly the two bound keys.
  assert.deepEqual(classify('read', response(PENDING_READ)), { kind: 'pending', stage: 'read' });
  assert.equal(
    refusal({ ...PENDING_READ, plan_sha256: 'f'.repeat(64) }, 200, 'read'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.equal(
    refusal({ status: 'pending', plan_sha256: PLAN['plan_sha256'], counts: {} }, 200, 'read'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  // Admission answers with the same plan-bound envelope; when it already carries the terminal
  // proof the plan was applied by an earlier attempt of this same request.
  assert.deepEqual(classify('admit', response(ENVELOPE)), {
    kind: 'ok',
    stage: 'admit',
    body: ENVELOPE,
  });
  assert.deepEqual(classify('admit', response(proof())), {
    kind: 'applied',
    stage: 'admit',
    status: 'applied',
  });
  assert.deepEqual(classify('admit', response(proof({ status: 'idempotent_replay' }))), {
    kind: 'idempotent_replay',
    stage: 'admit',
  });
  // An admit body that looks like a proof but does not survive validation is refused with the
  // proof's own code, never treated as an admission.
  assert.equal(
    refusal(proof({ plan_sha256: 'f'.repeat(64) }), 200, 'admit'),
    ALIAS_V2_RESPONSE_INVALID,
  );
  assert.equal(
    refusal(proof({ counts: { action_count: 1 } }), 200, 'admit'),
    ALIAS_V2_RESPONSE_COUNT_MISMATCH,
  );
});

test('an invalid or diverging proof is refused rather than trusted', () => {
  const invalid = ALIAS_V2_RESPONSE_INVALID;
  const readbackMismatch = ALIAS_V2_RESPONSE_READBACK_MISMATCH;
  const flowEntries = (): unknown[] => (proof()['readback'] as JsonObject)['flows'] as unknown[];
  const cases: Array<[unknown, string]> = [
    ['nope', invalid],
    [proof({ status: 'ok' }), invalid],
    [proof({ plan_sha256: 'f'.repeat(64) }), invalid],
    [proof({ extra: 1 }), invalid],
    [
      (() => {
        const body = proof();
        const renamed = { ...body, status_note: body['status'] } as JsonObject;
        delete renamed['status'];
        return renamed;
      })(),
      invalid,
    ],
    [
      (() => {
        const body = proof() as JsonObject;
        delete body['audit'];
        return body;
      })(),
      invalid,
    ],
    [proof({ counts: undefined }), ALIAS_V2_RESPONSE_COUNT_MISMATCH],
    [
      proof({ counts: { ...(PLAN['expected'] as JsonObject), action_count: 999 } }),
      ALIAS_V2_RESPONSE_COUNT_MISMATCH,
    ],
    [proof({ counts: { action_count: 2 } }), ALIAS_V2_RESPONSE_COUNT_MISMATCH],
    [proof({ audit: {} }), invalid],
    [proof({ audit: { plan_summary_id: '', batch_summary_ids: ['a', 'b'] } }), invalid],
    [proof({ audit: { plan_summary_id: 'p', batch_summary_ids: ['a'] } }), invalid],
    [proof({ audit: { plan_summary_id: 'p', batch_summary_ids: ['a', 'a'] } }), invalid],
    [proof({ audit: { plan_summary_id: 'p', batch_summary_ids: ['a', 4] } }), invalid],
    [proof({ readback: null }), invalid],
    [proof({ readback: { flows: [], processes: [] } }), invalid],
    [proof({ readback: { flows: [], processes: [], text_actions: [] } }), readbackMismatch],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          flows: [flowEntries()[0], flowEntries()[0]],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: { ...(proof()['readback'] as JsonObject), flows: [null, flowEntries()[1]] },
      }),
      readbackMismatch,
    ],
    [
      proof({ readback: { ...(proof()['readback'] as JsonObject), processes: [] } }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          flows: [
            { table: 'flows', id: 'flow-a', version: '00.00.001', desired_sha256: '0'.repeat(64) },
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          processes: [
            {
              table: 'flows',
              id: 'process-a',
              version: '00.00.001',
              desired_sha256: (
                (proof()['readback'] as JsonObject)['processes'] as JsonObject[]
              )[0]!['desired_sha256'],
            },
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          text_actions: [
            ((proof()['readback'] as JsonObject)['text_actions'] as unknown[])[0] as never,
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          text_actions: [
            ((proof()['readback'] as JsonObject)['text_actions'] as unknown[])[0] as never,
            ((proof()['readback'] as JsonObject)['text_actions'] as unknown[])[0] as never,
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          text_actions: [
            null as never,
            ((proof()['readback'] as JsonObject)['text_actions'] as unknown[])[1] as never,
          ],
        },
      }),
      readbackMismatch,
    ],
    [
      proof({
        readback: {
          ...(proof()['readback'] as JsonObject),
          text_actions: [{ id: 'process-a', version: '00.00.001', after_text: 'wrong' }],
        },
      }),
      readbackMismatch,
    ],
  ];
  for (const [body, code] of cases) {
    assert.equal(refusal(body, 200, 'read'), code, JSON.stringify(body).slice(0, 120));
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
      result: classify('read', response(PENDING_READ)),
    });
    assert.deepEqual([state.phase, state.polls], ['admitted', poll + 1]);
  }
  state = advanceAliasV2Lifecycle(state, {
    stage: 'read',
    result: classify('read', response(proof())),
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

  // An admission that reports the stored proof is terminal too, and never queues a new one.
  const appliedAtAdmit = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: classify('admit', response(proof())),
  });
  assert.deepEqual([appliedAtAdmit.phase, appliedAtAdmit.admit_attempts], ['applied', 1]);
  const replayedAtAdmit = advanceAliasV2Lifecycle(gated(), {
    stage: 'admit',
    result: classify('admit', response(proof({ status: 'idempotent_replay' }))),
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
    result: classify('read', response(proof())),
  });
  assert.deepEqual([recovered.phase, recovered.read_attempts], ['applied', 1]);
  // A read that finds the stored proof of this same request is an idempotent replay.
  const replayedRead = advanceAliasV2Lifecycle(unknown, {
    stage: 'read',
    result: classify('read', response(proof({ status: 'idempotent_replay' }))),
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
        result: classify('read', response(proof())),
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
        result: classify('read', response(proof())),
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
      result: classify('read', response(PENDING_READ)),
    });
  }
  assert.equal(polling.polls, MAX_POLL_ATTEMPTS);
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(polling, {
        stage: 'read',
        result: classify('read', response(PENDING_READ)),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
});
