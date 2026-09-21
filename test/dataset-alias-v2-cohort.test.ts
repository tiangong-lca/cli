import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import {
  buildAliasV2Plan,
  ALIAS_V2_FACTOR,
  type AliasV2PlanInput,
} from '../src/lib/dataset-alias-v2-plan.js';
import { buildAliasV2PreflightRequest } from '../src/lib/dataset-alias-v2-execution-request.js';
import {
  ALIAS_V2_GATE_NAMES,
  ALIAS_V2_LIFECYCLE_REFUSED,
  advanceAliasV2Lifecycle,
  classifyAliasV2Response,
  startAliasV2Lifecycle,
} from '../src/lib/dataset-alias-v2-lifecycle.js';
import {
  COHORT_COUNTS,
  COHORT_CORRECT_UNIT_TEXT_COUNT,
  COHORT_TEXT_ACTION_COUNT,
  buildAliasV2CohortInput,
} from './fixtures/alias-v2-cohort.js';

type JsonObject = Record<string, unknown>;

const built = buildAliasV2Plan(buildAliasV2CohortInput());
const PLAN = built.plan;
const BATCH = built.batch;
const ACTIONS = PLAN['actions'] as JsonObject[];

/** Every leaf path at which two JSON payloads differ. */
function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object'
  ) {
    return [prefix];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const paths: string[] = [];
  for (const key of [...keys].sort()) {
    paths.push(
      ...changedPaths(
        (before as JsonObject)[key],
        (after as JsonObject)[key],
        prefix === '' ? key : `${prefix}.${key}`,
      ),
    );
  }
  return paths;
}

test('the full cohort derives exactly the frozen 387 / 654 / 4 147 counts', () => {
  assert.deepEqual(PLAN['counts'], { ...COHORT_COUNTS });
  assert.equal(ACTIONS.length, COHORT_COUNTS.action_count);
  assert.equal(ACTIONS.filter((action) => action['table'] === 'flows').length, 113);
  assert.equal(ACTIONS.filter((action) => action['table'] === 'processes').length, 274);
  // No flow-property action exists in this cohort, and the plan says so.
  assert.equal(COHORT_COUNTS.flowproperty_count, 0);
  assert.equal((BATCH['actions'] as JsonObject[]).length, COHORT_COUNTS.action_count);
  assert.equal(BATCH['plan_sha256'], PLAN['plan_sha256']);
  assert.equal(((PLAN['dimensions'] as JsonObject[])[0] as JsonObject)['factor'], ALIAS_V2_FACTOR);
});

test('every action changes exactly the reviewed paths over the whole cohort', () => {
  let aliasOccurrences = 0;
  let unrelatedOccurrences = 0;
  let foreignUnrelated = 0;
  for (const action of ACTIONS) {
    const before = action['expected_json_ordered'] as JsonObject;
    const desired = action['desired_json_ordered'] as JsonObject;
    const paths = changedPaths(before, desired).sort();
    if (action['table'] === 'flows') {
      const root = 'flowDataSet.flowProperties.flowProperty.0.referenceToFlowPropertyDataSet';
      assert.deepEqual(paths, [
        `${root}.@refObjectId`,
        `${root}.@uri`,
        `${root}.@version`,
        `${root}.common:shortDescription.#text`,
      ]);
      // The quantitative reference internal id is never touched.
      assert.deepEqual(
        (desired['flowDataSet'] as JsonObject)['flowInformation'],
        (before['flowDataSet'] as JsonObject)['flowInformation'],
      );
      continue;
    }
    const instances = (action['mutation'] as JsonObject)['exchanges'] as JsonObject[];
    const aliasIndexes = new Set(instances.map((instance) => instance['index'] as number));
    aliasOccurrences += instances.length;
    for (const instance of instances) {
      // Each occurrence carries its original literal and the canonical desired text.
      assert.equal(instance['before_amount'], (instance['before_amount'] as string).trim());
      assert.match(instance['after_amount'] as string, /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
      assert.ok((instance['after_amount'] as string).length <= 128);
      assert.equal(instance['after_resulting_amount'], instance['after_amount']);
    }
    const beforeExchanges = ((before['processDataSet'] as JsonObject)['exchanges'] as JsonObject)
      .exchange as JsonObject[];
    const desiredExchanges = ((desired['processDataSet'] as JsonObject)['exchanges'] as JsonObject)
      .exchange as JsonObject[];
    assert.equal(beforeExchanges.length, desiredExchanges.length);
    for (const [index, exchange] of beforeExchanges.entries()) {
      if (aliasIndexes.has(index)) continue;
      unrelatedOccurrences += 1;
      // Every unrelated exchange survives byte-for-byte, and no path outside the named
      // occurrences may appear in the change set.
      if (sha256Json(exchange) !== sha256Json(desiredExchanges[index])) {
        foreignUnrelated += 1;
      }
      assert.equal(
        paths.some((path) => path.startsWith(`processDataSet.exchanges.exchange.${index}.`)),
        false,
        `${String(action['id'])} exchange ${index}`,
      );
    }
    // The named occurrences are exactly the paths that may change; the FU leaf is the only
    // other permitted difference.
    for (const path of paths) {
      const occurrence =
        /^processDataSet\.exchanges\.exchange\.(\d+)\.(meanAmount|resultingAmount)$/u.exec(path);
      if (occurrence) {
        assert.equal(aliasIndexes.has(Number(occurrence[1])), true, path);
        continue;
      }
      assert.equal(
        path,
        'processDataSet.processInformation.quantitativeReference.functionalUnitOrOther.#text',
        path,
      );
    }
    assert.equal(
      ((desired['processDataSet'] as JsonObject)['processInformation'] as JsonObject)
        .quantitativeReference &&
        ((
          ((desired['processDataSet'] as JsonObject)['processInformation'] as JsonObject)
            .quantitativeReference as JsonObject
        )['referenceToReferenceFlow'] as string),
      '1',
    );
  }
  assert.equal(aliasOccurrences, COHORT_COUNTS.exchange_count);
  assert.equal(unrelatedOccurrences, COHORT_COUNTS.unrelated_exchange_count);
  assert.equal(foreignUnrelated, 0);
});

test('the 87 source-proven functional units are corrected and the 41 correct ones untouched', () => {
  const textActions = PLAN['text_actions'] as JsonObject[];
  assert.equal(textActions.length, COHORT_TEXT_ACTION_COUNT);
  assert.equal(COHORT_CORRECT_UNIT_TEXT_COUNT, 41);
  for (const action of textActions) {
    assert.equal(
      String(action['before_text']).startsWith('1.0 a '),
      true,
      String(action['before_text']),
    );
    assert.equal(
      action['after_text'],
      String(action['before_text']).replace('1.0 a ', '1.0 hr '),
      String(action['after_text']),
    );
    assert.match(String(action['source_exchange_number']), /^[0-9]+$/u);
  }
  // Processes with the already-correct form keep their text byte-for-byte.
  const unitText = (payload: JsonObject): string =>
    String(
      (
        (
          ((payload['processDataSet'] as JsonObject)['processInformation'] as JsonObject)
            .quantitativeReference as JsonObject
        )['functionalUnitOrOther'] as JsonObject
      )['#text'],
    );
  const correct = ACTIONS.filter(
    (action) =>
      action['table'] === 'processes' &&
      unitText(action['expected_json_ordered'] as JsonObject).startsWith('1 hr '),
  );
  assert.equal(correct.length, COHORT_CORRECT_UNIT_TEXT_COUNT);
  for (const action of correct) {
    assert.equal(
      unitText(action['desired_json_ordered'] as JsonObject),
      unitText(action['expected_json_ordered'] as JsonObject),
    );
    assert.equal(
      textActions.some((text) => text['id'] === action['id']),
      false,
      String(action['id']),
    );
  }
});

test('the cohort plan is admissible through the protected request and lifecycle', () => {
  const requestId = '9f1c6f0e-6a2b-4a3f-9f0d-3b0d5a7c1e42';
  const request = buildAliasV2PreflightRequest({
    requestId,
    environment: 'production',
    projectRef: 'qgzvkongdjqiiamzbbts',
    actor: { user_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7', email: 'owner@example.com' },
    plan: PLAN as unknown as Record<string, unknown>,
    freeze: { schema_version: 'dataset-alias-execution-freeze.v2' },
    approval: { schema_version: 'dataset-alias-execution-approval.v2' },
    bindings: Object.fromEntries(
      [
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
      ].map((key) => [key, sha256Json({ key, plan: PLAN['plan_sha256'] })]),
    ),
    expected: { counts: PLAN['counts'], closure: { roots: 6, references: 33 } },
    derivativeTargets: [{ table: 'flows', id: 'f', version: '01.00.000' }],
  });
  assert.equal(request['request_id'], requestId);
  assert.deepEqual((request['expected'] as JsonObject)['counts'], PLAN['counts']);

  // The lifecycle accepts the plan-bound proof and refuses to execute it a second time.
  const binding = { plan: PLAN, request_id: requestId };
  const envelope = { request_id: requestId, plan_sha256: PLAN['plan_sha256'] };
  let state = startAliasV2Lifecycle({ requestId, planSha256: PLAN['plan_sha256'] as string });
  state = advanceAliasV2Lifecycle(state, {
    stage: 'preflight',
    result: classifyAliasV2Response({
      stage: 'preflight',
      outcome: { kind: 'response', status: 200, body: envelope },
      ...binding,
    }),
  });
  for (const gate of ALIAS_V2_GATE_NAMES) {
    state = advanceAliasV2Lifecycle(state, {
      stage: 'gate',
      result: classifyAliasV2Response({
        stage: 'gate',
        outcome: { kind: 'response', status: 200, body: { ...envelope, gate_name: gate } },
        ...binding,
      }),
    });
  }
  state = advanceAliasV2Lifecycle(state, {
    stage: 'admit',
    result: classifyAliasV2Response({
      stage: 'admit',
      outcome: { kind: 'response', status: 200, body: envelope },
      ...binding,
    }),
  });
  assert.equal(state.phase, 'admitted');
  const proof = {
    status: 'applied',
    plan_sha256: PLAN['plan_sha256'],
    counts: PLAN['counts'],
    audit: { plan_summary_id: 'audit-plan-1', batch_summary_ids: ['b-flows', 'b-processes'] },
    readback: {
      flows: ACTIONS.filter((action) => action['table'] === 'flows').map((action) => ({
        table: 'flows',
        id: action['id'],
        version: action['version'],
        desired_sha256: action['desired_sha256'],
      })),
      processes: ACTIONS.filter((action) => action['table'] === 'processes').map((action) => ({
        table: 'processes',
        id: action['id'],
        version: action['version'],
        desired_sha256: action['desired_sha256'],
      })),
      text_actions: (PLAN['text_actions'] as JsonObject[]).map((action) => ({
        id: action['id'],
        version: action['version'],
        after_text: action['after_text'],
      })),
    },
  };
  // The read stage resolves the queued execution to its terminal proof.
  const classified = classifyAliasV2Response({
    stage: 'read',
    outcome: { kind: 'response', status: 200, body: proof },
    ...binding,
  });
  assert.deepEqual(classified, { kind: 'applied', stage: 'read', status: 'applied' });
  state = advanceAliasV2Lifecycle(state, { stage: 'read', result: classified });
  assert.deepEqual([state.phase, state.admit_attempts], ['applied', 1]);
  assert.throws(
    () =>
      advanceAliasV2Lifecycle(state, {
        stage: 'admit',
        result: classifyAliasV2Response({
          stage: 'admit',
          outcome: { kind: 'response', status: 200, body: proof },
          ...binding,
        }),
      }),
    (error: unknown) => (error as { code?: string }).code === ALIAS_V2_LIFECYCLE_REFUSED,
  );
});

test('the cohort fixture is anonymized and deterministic', () => {
  const input: AliasV2PlanInput = buildAliasV2CohortInput();
  const again = buildAliasV2Plan(buildAliasV2CohortInput());
  assert.equal(again.plan['plan_sha256'], PLAN['plan_sha256']);
  assert.equal(
    input.processes.filter((row) => row.functional_unit !== undefined).length,
    COHORT_TEXT_ACTION_COUNT,
  );
  // Synthetic identifiers and synthetic amounts only: no account, credential or source content,
  // and no identifier outside the fixture's own generated prefix.
  const serialized = JSON.stringify(input);
  for (const forbidden of ['token', 'apikey', 'authorization', 'ecospold', 'bafu', 'uslci']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
  const identifiers = new Set<string>();
  for (const row of [...input.flows, ...input.processes]) {
    assert.match(row.id, /^[fb]?[0-9a-f]*c0de0-/u);
    identifiers.add(row.id);
  }
  assert.equal(identifiers.size, 113 + 274);
});
