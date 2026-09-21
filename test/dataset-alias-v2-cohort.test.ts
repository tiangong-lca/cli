import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_FACTOR,
  ALIAS_V2_PLAN_INVALID,
  ALIAS_V2_TARGET_SHAPE_INVALID,
  aliasV2TargetFlowPropertyReference,
  buildAliasV2Plan,
  type AliasV2PlanInput,
} from '../src/lib/dataset-alias-v2-plan.js';
import { isJsonObject } from '../src/lib/dataset-maintenance-contract.js';
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

test('the cohort plan resolves to its terminal proof through the protected lifecycle', () => {
  const requestId = '9f1c6f0e-6a2b-4a3f-9f0d-3b0d5a7c1e42';
  const binding = { plan: PLAN, request_id: requestId };
  let state = startAliasV2Lifecycle({ requestId, planSha256: PLAN['plan_sha256'] as string });
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
  state = advanceAliasV2Lifecycle(state, {
    stage: 'admit',
    result: { kind: 'ok', stage: 'admit', body: {} },
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
        result: { kind: 'ok', stage: 'admit', body: {} },
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
  // 'ecospold' is deliberately allowed: the reviewed comment schema names the source format, and
  // the fixture carries synthetic source numbers only.
  for (const forbidden of ['token', 'apikey', 'authorization', 'bafu', 'uslci']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, forbidden);
  }
  const identifiers = new Set<string>();
  for (const row of [...input.flows, ...input.processes]) {
    assert.match(row.id, /^[fb]?[0-9a-f]*c0de0-/u);
    identifiers.add(row.id);
  }
  assert.equal(identifiers.size, 113 + 274);
});

test('every cohort flow is a Product flow, and nothing wider is eligible', () => {
  const input = buildAliasV2CohortInput();
  // The fixture carries the real field on all 113 before images.
  for (const flow of input.flows) {
    const lciMethod = (
      (flow.json['flowDataSet'] as JsonObject)['modellingAndValidation'] as JsonObject
    )['LCIMethod'] as JsonObject;
    assert.equal(lciMethod['typeOfDataSet'], 'Product flow', flow.id);
  }
  for (const action of ACTIONS.filter((entry) => entry['table'] === 'flows')) {
    const lciMethod = (
      ((action['expected_json_ordered'] as JsonObject)['flowDataSet'] as JsonObject)[
        'modellingAndValidation'
      ] as JsonObject
    )['LCIMethod'] as JsonObject;
    assert.equal(lciMethod['typeOfDataSet'], 'Product flow', String(action['id']));
  }
  // A flow of another kind — or one missing the field altogether — is refused before any write.
  for (const typeOfDataSet of [undefined, 'Elementary flow', 'Waste flow']) {
    const json = JSON.parse(JSON.stringify(input.flows[0]!.json)) as JsonObject;
    if (typeOfDataSet === undefined) {
      delete (json['flowDataSet'] as JsonObject)['modellingAndValidation'];
    } else {
      (json['flowDataSet'] as JsonObject)['modellingAndValidation'] = {
        LCIMethod: { typeOfDataSet },
      };
    }
    assert.throws(
      () => buildAliasV2Plan({ ...input, flows: [{ ...input.flows[0]!, json }] }),
      (error: unknown) => (error as { code?: string }).code === ALIAS_V2_PLAN_INVALID,
      String(typeOfDataSet),
    );
  }
});

test('every reference in the cohort carries the real five-key shape, projected from the locked target', () => {
  const input = buildAliasV2CohortInput();
  const canonicalKeys = ['@refObjectId', '@type', '@uri', '@version', 'common:shortDescription'];
  const assertCanonical = (reference: JsonObject, label: string): void => {
    assert.deepEqual(Object.keys(reference).sort(), [...canonicalKeys].sort(), label);
    assert.equal(reference['@type'], 'flow property data set', label);
    assert.equal(
      reference['@uri'],
      `../flowproperties/${String(reference['@refObjectId'])}.json`,
      label,
    );
    assert.match(String(reference['@version']), /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u, label);
    const description = reference['common:shortDescription'] as JsonObject;
    assert.equal(Array.isArray(description), false, label);
    assert.deepEqual(Object.keys(description).sort(), ['#text', '@xml:lang'], label);
  };
  // The source rows the cohort starts from.
  for (const flow of input.flows) {
    const properties = ((flow.json['flowDataSet'] as JsonObject)['flowProperties'] as JsonObject)[
      'flowProperty'
    ] as JsonObject[];
    for (const entry of properties) {
      assertCanonical(entry['referenceToFlowPropertyDataSet'] as JsonObject, flow.id);
    }
  }
  // The target snapshot carries the real schema, and the projected reference takes its
  // description from the target's own language-tagged common:name — not from a name/baseName
  // array, not from a common:shortDescription, and not from any Process-shaped path.
  const target = input.target_flow_property;
  const information = (target.json['flowPropertyDataSet'] as JsonObject)[
    'flowPropertiesInformation'
  ] as JsonObject;
  const name = (information['dataSetInformation'] as JsonObject)['common:name'] as JsonObject;
  assert.deepEqual(Object.keys(information).sort(), [
    'dataSetInformation',
    'quantitativeReference',
  ]);
  assert.equal(Object.hasOwn(information, 'flowPropertyInformation'), false);
  assert.deepEqual(name, { '#text': 'Time', '@xml:lang': 'en' });
  assert.deepEqual(
    (
      (information['quantitativeReference'] as JsonObject)[
        'referenceToReferenceUnitGroup'
      ] as JsonObject
    )['@refObjectId'],
    (input.target_unit_group as { id: string }).id,
  );
  const projected = aliasV2TargetFlowPropertyReference(target, input.target_unit_group);
  assertCanonical(projected, 'projected target reference');
  assert.deepEqual(projected['common:shortDescription'], name);
  // Every action's desired reference and mutation reference is exactly that projection.
  for (const action of ACTIONS.filter((entry) => entry['table'] === 'flows')) {
    const desired = ((action['desired_json_ordered'] as JsonObject)['flowDataSet'] as JsonObject)[
      'flowProperties'
    ] as JsonObject;
    const derived = ((desired['flowProperty'] as JsonObject[])[0] as JsonObject)[
      'referenceToFlowPropertyDataSet'
    ] as JsonObject;
    assertCanonical(derived, String(action['id']));
    assert.deepEqual(derived, projected, String(action['id']));
    assert.deepEqual(
      (action['mutation'] as JsonObject)['reference'],
      projected,
      String(action['id']),
    );
  }
  // Every functional unit is an object, never an array or a bare string.
  for (const action of ACTIONS.filter((entry) => entry['table'] === 'processes')) {
    const quantitative = (
      ((action['expected_json_ordered'] as JsonObject)['processDataSet'] as JsonObject)[
        'processInformation'
      ] as JsonObject
    )['quantitativeReference'] as JsonObject;
    assert.equal(isJsonObject(quantitative['functionalUnitOrOther']), true, String(action['id']));
  }
  // A snapshot whose name lives at the Process-shaped path, or at common:shortDescription, or
  // whose unit group reference points elsewhere, is refused rather than projected.
  const mutateTarget = (mutate: (information: JsonObject) => void): AliasV2PlanInput => {
    const json = JSON.parse(JSON.stringify(target.json)) as JsonObject;
    mutate((json['flowPropertyDataSet'] as JsonObject)['flowPropertiesInformation'] as JsonObject);
    return { ...input, target_flow_property: { ...target, json } };
  };
  for (const mutate of [
    (information: JsonObject) => {
      information['dataSetInformation'] = { name: { baseName: [{ '#text': 'Time' }] } };
    },
    (information: JsonObject) => {
      information['dataSetInformation'] = {
        'common:shortDescription': { '#text': 'Time', '@xml:lang': 'en' },
      };
    },
    (information: JsonObject) => {
      information['quantitativeReference'] = {
        referenceToReferenceUnitGroup: { '@refObjectId': 'beefbeef-0000-4000-8000-000000000001' },
      };
    },
  ]) {
    assert.throws(
      () => buildAliasV2Plan(mutateTarget(mutate)),
      (error: unknown) => (error as { code?: string }).code === ALIAS_V2_TARGET_SHAPE_INVALID,
    );
  }
});
