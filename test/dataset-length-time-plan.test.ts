import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isJsonObject,
  sha256Json,
  stableJsonText,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  LENGTH_TIME_EXCHANGE_KEYS,
  LENGTH_TIME_FACTOR,
  LENGTH_TIME_PLAN_SCHEMA,
  LENGTH_TIME_PLAN_INVALID,
  LENGTH_TIME_COUNT_MISMATCH,
  LENGTH_TIME_DERIVE_MISMATCH,
  LENGTH_TIME_EVIDENCE_MISMATCH,
  LENGTH_TIME_SOURCE_SHAPE_INVALID,
  LENGTH_TIME_TARGET_SHAPE_INVALID,
  LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
  buildLengthTimePlan,
  lengthTimeEvidenceTuples,
  type LengthTimePlanInput,
} from '../src/lib/dataset-length-time-plan.js';
import {
  LENGTH_TIME_COHORT_COUNTS,
  LENGTH_TIME_LITERAL_PAIRS,
  LENGTH_TIME_TARGET_FP,
  LENGTH_TIME_TARGET_UG,
  buildLengthTimeCohort,
  buildLengthTimePlanInput,
  lengthTimeFlowProperty,
  lengthTimeUnitGroup,
} from './fixtures/length-time-cohort.js';

type JsonObject = Record<string, unknown>;

const PLAN_KEYS = [
  'schema_version',
  'actor_id',
  'target_visibility',
  'flow_snapshots',
  'target_flow_property',
  'target_unit_group',
  'source_evidence',
  'expected',
  'actions',
  'plan_sha256',
];

const ACTION_KEYS = [
  'action_id',
  'table',
  'id',
  'version',
  'expected_state_code',
  'expected_modified_at',
  'expected_json_ordered',
  'desired_json_ordered',
  'before_sha256',
  'desired_sha256',
  'mutation',
];

const INSTANCE_KEYS = [
  'index',
  'internal_id',
  'source_exchange_number',
  'direction',
  'flow_id',
  'flow_version',
  'before_literal',
  'after_literal',
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The deep form of one cohort input, overridable per case. */
function cohortInput(): JsonObject {
  return clone(buildLengthTimePlanInput()) as JsonObject;
}

function build(input: JsonObject, counts?: JsonObject): JsonObject {
  return buildLengthTimePlan(
    (counts === undefined
      ? input
      : { ...input, expected_counts: counts }) as unknown as LengthTimePlanInput,
  ).plan;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    assert.equal(typeof code, 'string', `expected a coded refusal, got ${String(error)}`);
    return code as string;
  }
  throw new Error('expected the call to refuse');
}

function exchangesOf(payload: JsonObject): JsonObject[] {
  const root = payload['processDataSet'] as JsonObject;
  const exchanges = root['exchanges'] as JsonObject;
  return exchanges['exchange'] as JsonObject[];
}

function instanceOf(process: JsonObject, index: number): JsonObject {
  const action = (process['actions'] as JsonObject[])[index] as JsonObject;
  return action;
}

test('builds the reviewed 13/39/78 plan from the shared cohort fixture', () => {
  const plan = build(cohortInput());
  assert.deepEqual(Object.keys(plan).sort(), [...PLAN_KEYS].sort());
  assert.equal(plan['schema_version'], LENGTH_TIME_PLAN_SCHEMA);
  assert.equal(plan['target_visibility'], 'owner_draft');
  assert.deepEqual(plan['expected'], LENGTH_TIME_COHORT_COUNTS);
  assert.equal(plan['plan_sha256'], sha256Json({ ...plan, plan_sha256: undefined }));
  const actions = plan['actions'] as JsonObject[];
  assert.equal(actions.length, 13);
});

test('every action carries the reviewed process shape and derived digests', () => {
  const input = cohortInput();
  const plan = build(input);
  const actions = plan['actions'] as JsonObject[];
  const cohort = buildLengthTimeCohort();
  for (const [position, action] of actions.entries()) {
    assert.deepEqual(Object.keys(action).sort(), [...ACTION_KEYS].sort());
    assert.equal(action['table'], 'processes');
    assert.equal(action['expected_state_code'], 0);
    const source = (input['processes'] as JsonObject[])[position] as JsonObject;
    assert.equal(action['id'], source['id']);
    assert.equal(action['version'], source['version']);
    assert.equal(action['expected_modified_at'], source['modified_at']);
    assert.equal(action['expected_json_ordered'] ? 1 : 0, 1);
    assert.deepEqual(action['expected_json_ordered'], source['json']);
    assert.equal(action['before_sha256'], sha256Json(source['json']));
    assert.equal(action['desired_sha256'], sha256Json(action['desired_json_ordered']));
    assert.equal(
      action['action_id'],
      `process:${String(source['id'])}@${String(source['version'])}`,
    );
    const instances = (action['mutation'] as JsonObject)['exchanges'] as JsonObject[];
    for (const [offset, entry] of instances.entries()) {
      assert.deepEqual(Object.keys(entry).sort(), [...INSTANCE_KEYS].sort());
      assert.equal(entry['index'], offset);
      const tuple = cohort.processes[position]?.instances[offset];
      assert.equal(entry['internal_id'], tuple?.internal_id);
      assert.equal(entry['source_exchange_number'], tuple?.source_exchange_number);
      assert.equal(entry['direction'], tuple?.direction);
      assert.equal(entry['flow_id'], tuple?.flow_id);
      assert.equal(entry['flow_version'], tuple?.flow_version);
      assert.equal(entry['before_literal'], tuple?.before_literal);
      assert.equal(entry['after_literal'], tuple?.after_literal);
    }
  }
});

test('the change set is exactly the named amount leaves of the selected exchanges', () => {
  const plan = build(cohortInput());
  const desiredTotals: string[] = [];
  for (const action of plan['actions'] as JsonObject[]) {
    const before = clone(action['expected_json_ordered']) as JsonObject;
    const desired = clone(action['desired_json_ordered']) as JsonObject;
    const instances = (action['mutation'] as JsonObject)['exchanges'] as JsonObject[];
    const beforeExchanges = exchangesOf(before);
    const desiredExchanges = exchangesOf(desired);
    assert.equal(beforeExchanges.length, desiredExchanges.length);
    for (const [index, entry] of beforeExchanges.entries()) {
      const selected = instances.find((instance) => instance['index'] === index);
      const after = desiredExchanges[index] as JsonObject;
      if (selected === undefined) {
        assert.deepEqual(after, entry);
        continue;
      }
      assert.equal(entry['meanAmount'], selected['before_literal']);
      assert.equal(entry['resultingAmount'], selected['before_literal']);
      assert.equal(after['meanAmount'], selected['after_literal']);
      assert.equal(after['resultingAmount'], selected['after_literal']);
      desiredTotals.push(after['meanAmount'] as string, after['resultingAmount'] as string);
      // Everything else about the exchange survives byte-for-byte.
      const { meanAmount: _mean, resultingAmount: _resulting, ...rest } = after;
      const { meanAmount: _bMean, resultingAmount: _bResulting, ...beforeRest } = entry;
      assert.deepEqual(rest, beforeRest);
    }
  }
  assert.equal(desiredTotals.length, LENGTH_TIME_COHORT_COUNTS.amount_field_count);
  assert.deepEqual(
    [...new Set(desiredTotals)].sort(),
    [...new Set(LENGTH_TIME_LITERAL_PAIRS.map((pair) => pair[1]))].sort(),
  );
});

test('the functional unit text survives untouched', () => {
  const plan = build(cohortInput());
  for (const action of plan['actions'] as JsonObject[]) {
    const readText = (payload: JsonObject): unknown =>
      (
        ((payload['processDataSet'] as JsonObject)['processInformation'] as JsonObject)[
          'quantitativeReference'
        ] as JsonObject
      )['functionalUnitOrOther'];
    assert.deepEqual(
      readText(action['desired_json_ordered'] as JsonObject),
      readText(action['expected_json_ordered'] as JsonObject),
    );
  }
});

test('read-only flows become three-key snapshots and never actions', () => {
  const input = cohortInput();
  const plan = build(input);
  const snapshots = plan['flow_snapshots'] as JsonObject[];
  assert.equal(snapshots.length, 13);
  for (const [index, snapshot] of snapshots.entries()) {
    assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'sha256', 'version']);
    const row = (input['flows'] as JsonObject[])[index] as JsonObject;
    assert.equal(snapshot['id'], row['id']);
    assert.equal(snapshot['version'], row['version']);
    assert.equal(snapshot['sha256'], sha256Json(row['json']));
  }
  assert.equal(
    (plan['actions'] as JsonObject[]).some((action) => action['table'] !== 'processes'),
    false,
  );
});

test('the plan carries the reviewed factor, unit pair and five-key source evidence', () => {
  const plan = build(cohortInput());
  assert.deepEqual(Object.keys(plan['source_evidence'] as JsonObject).sort(), [
    'factor',
    'instance_count',
    'reference_unit',
    'sha256',
    'source_unit',
  ]);
  const evidence = plan['source_evidence'] as JsonObject;
  assert.equal(evidence['factor'], LENGTH_TIME_FACTOR);
  assert.equal(evidence['source_unit'], 'kmy');
  assert.equal(evidence['reference_unit'], 'm*a');
  assert.equal(evidence['instance_count'], 39);
  for (const action of plan['actions'] as JsonObject[]) {
    assert.equal((action['mutation'] as JsonObject)['factor'], LENGTH_TIME_FACTOR);
  }
  assert.deepEqual(plan['target_flow_property'], {
    id: LENGTH_TIME_TARGET_FP,
    version: '01.00.000',
    sha256: sha256Json(flowPropertyForFixture()),
  });
  assert.deepEqual(plan['target_unit_group'], {
    id: LENGTH_TIME_TARGET_UG,
    version: '01.00.000',
    sha256: sha256Json(lengthTimeUnitGroup()),
  });
});

function flowPropertyForFixture(): JsonObject {
  return lengthTimeFlowProperty();
}

test('the evidence tuple table is the one the builder recomputes', () => {
  const input = cohortInput();
  const tuples = lengthTimeEvidenceTuples(input as unknown as LengthTimePlanInput);
  assert.equal(tuples.length, 39);
  assert.equal(sha256Json(tuples), (input['source_evidence'] as JsonObject)['cohort_sha256']);
  // Every tuple is unique and carries the complete source proof.
  assert.equal(new Set(tuples).size, tuples.length);
  assert.match(
    tuples[0] as string,
    /^[0-9a-f-]{36}@00\.00\.001#\d+:\d+:\d+:(Input|Output):[0-9a-f-]{36}@00\.00\.001:[\d.]+->[\d.]+$/u,
  );
});

test('the builder is deterministic and does not depend on key order', () => {
  const first = build(cohortInput());
  const second = build(cohortInput());
  assert.equal(stableJsonText(first), stableJsonText(second));
  const reordered = cohortInput();
  const processes = reordered['processes'] as JsonObject[];
  reordered['processes'] = processes
    .map((process) => ({
      json: process['json'],
      modified_at: process['modified_at'],
      version: process['version'],
      id: process['id'],
    }))
    .reverse();
  const third = build(reordered);
  assert.equal(stableJsonText(third), stableJsonText(first));
});

test('the frozen expected counts are cross-checked and a mismatch refuses', () => {
  const plan = build(cohortInput(), { ...LENGTH_TIME_COHORT_COUNTS });
  assert.deepEqual(plan['expected'], LENGTH_TIME_COHORT_COUNTS);
  assert.equal(
    codeOf(() => build(cohortInput(), { ...LENGTH_TIME_COHORT_COUNTS, exchange_count: 38 })),
    LENGTH_TIME_COUNT_MISMATCH,
  );
  assert.equal(
    codeOf(() => build(cohortInput(), { ...LENGTH_TIME_COHORT_COUNTS, flow_count: 13 })),
    LENGTH_TIME_COUNT_MISMATCH,
  );
});

test('a stale or substituted source evidence document refuses', () => {
  const stale = cohortInput();
  (stale['source_evidence'] as JsonObject)['cohort_sha256'] = 'a'.repeat(64);
  assert.equal(
    codeOf(() => build(stale)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );

  const countDrift = cohortInput();
  (countDrift['source_evidence'] as JsonObject)['instance_count'] = 38;
  assert.equal(
    codeOf(() => build(countDrift)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );

  const unitDrift = cohortInput();
  (unitDrift['source_evidence'] as JsonObject)['source_unit'] = 'my';
  assert.equal(
    codeOf(() => build(unitDrift)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );

  const referenceDrift = cohortInput();
  (referenceDrift['source_evidence'] as JsonObject)['reference_unit'] = 'km';
  assert.equal(
    codeOf(() => build(referenceDrift)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );

  const factorDrift = cohortInput();
  (factorDrift['source_evidence'] as JsonObject)['factor'] = '100';
  assert.equal(
    codeOf(() => build(factorDrift)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );

  const digestDrift = cohortInput();
  (digestDrift['source_evidence'] as JsonObject)['sha256'] = 'nope';
  assert.equal(
    codeOf(() => build(digestDrift)),
    LENGTH_TIME_SOURCE_SHAPE_INVALID,
  );
});

test('a before literal that moved after the evidence was frozen refuses', () => {
  const moved = cohortInput();
  const processes = moved['processes'] as JsonObject[];
  const payload = (processes[0] as JsonObject)['json'] as JsonObject;
  const entry = exchangesOf(payload)[0] as JsonObject;
  entry['meanAmount'] = '0.0139';
  entry['resultingAmount'] = '0.0139';
  assert.equal(
    codeOf(() => build(moved)),
    LENGTH_TIME_EVIDENCE_MISMATCH,
  );
});

test('unreviewed exchange fields, absolute uncertainty and split amounts refuse', () => {
  const unreviewed = cohortInput();
  const withExtra = (unreviewed['processes'] as JsonObject[])[0] as JsonObject;
  (exchangesOf(withExtra['json'] as JsonObject)[0] as JsonObject)['pedigreeUncertainty'] = '5';
  assert.equal(
    codeOf(() => build(unreviewed)),
    LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
  );

  for (const field of [
    'minimumAmount',
    'maximumAmount',
    'standardDeviation95In',
    'variance',
    'standardDeviation',
  ]) {
    const absolute = cohortInput();
    const process = (absolute['processes'] as JsonObject[])[0] as JsonObject;
    (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)[field] = '1';
    assert.equal(
      codeOf(() => build(absolute)),
      LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
    );
  }

  const split = cohortInput();
  const process = (split['processes'] as JsonObject[])[1] as JsonObject;
  (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['resultingAmount'] = '0.015';
  assert.equal(
    codeOf(() => build(split)),
    LENGTH_TIME_DERIVE_MISMATCH,
  );
});

test('the source number must be the single number the stored comment carries', () => {
  const missing = cohortInput();
  const process = (missing['processes'] as JsonObject[])[0] as JsonObject;
  (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['generalComment'] = {
    '#text': 'no number here',
  };
  assert.equal(
    codeOf(() => build(missing)),
    LENGTH_TIME_DERIVE_MISMATCH,
  );

  const ambiguous = cohortInput();
  const other = (ambiguous['processes'] as JsonObject[])[2] as JsonObject;
  (exchangesOf(other['json'] as JsonObject)[0] as JsonObject)['generalComment'] = {
    '#text': 'Source EcoSpold1 exchange number: 730103 and 730999',
  };
  assert.equal(
    codeOf(() => build(ambiguous)),
    LENGTH_TIME_DERIVE_MISMATCH,
  );

  // A comment that is absent altogether is a shape deviation from the exact reviewed key set; only
  // a present but unreadable comment is an instance-derivation failure.
  const absent = cohortInput();
  const noComment = (absent['processes'] as JsonObject[])[3] as JsonObject;
  const exchange = exchangesOf(noComment['json'] as JsonObject)[0] as JsonObject;
  delete exchange['generalComment'];
  assert.equal(
    codeOf(() => build(absent)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('unreviewed or unstable exchange keys refuse rather than being copied through', () => {
  const unreviewed = cohortInput();
  const process = (unreviewed['processes'] as JsonObject[])[0] as JsonObject;
  const exchange = exchangesOf(process['json'] as JsonObject)[0] as JsonObject;
  delete exchange['uncertaintyDistributionType'];
  assert.equal(
    codeOf(() => build(unreviewed)),
    LENGTH_TIME_PLAN_INVALID,
  );

  assert.equal(LENGTH_TIME_EXCHANGE_KEYS.length, 9);
});

test('the target property and unit group are proven at their canonical paths', () => {
  const wrongUnit = cohortInput();
  const units = lengthTimeUnitGroup();
  const unitRoot = units['unitGroupDataSet'] as JsonObject;
  (unitRoot['units'] as JsonObject)['unit'] = [
    { '@dataSetInternalID': '1', name: 'm*a', meanValue: '1' },
    { '@dataSetInternalID': '2', name: 'kmy', meanValue: '999' },
  ];
  (wrongUnit['target_unit_group'] as JsonObject)['json'] = units;
  assert.equal(
    codeOf(() => build(wrongUnit)),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );

  const noKmy = cohortInput();
  const noKmyUnits = lengthTimeUnitGroup();
  ((noKmyUnits['unitGroupDataSet'] as JsonObject)['units'] as JsonObject)['unit'] = [
    { '@dataSetInternalID': '1', name: 'm*a', meanValue: '1' },
  ];
  (noKmy['target_unit_group'] as JsonObject)['json'] = noKmyUnits;
  assert.equal(
    codeOf(() => build(noKmy)),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );

  const flatReference = cohortInput();
  const flat = lengthTimeUnitGroup();
  const flatRoot = flat['unitGroupDataSet'] as JsonObject;
  flatRoot['quantitativeReference'] = { referenceToReferenceUnit: '1' };
  delete (flatRoot['unitGroupInformation'] as JsonObject)['quantitativeReference'];
  (flatReference['target_unit_group'] as JsonObject)['json'] = flat;
  assert.equal(
    codeOf(() => build(flatReference)),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );

  const wrongProperty = cohortInput();
  const property = lengthTimeFlowProperty();
  const info = (property['flowPropertyDataSet'] as JsonObject)[
    'flowPropertiesInformation'
  ] as JsonObject;
  (info['quantitativeReference'] as JsonObject)['referenceToReferenceUnitGroup'] = {
    '@refObjectId': '00000000-0000-4000-8000-000000000000',
    '@version': '01.00.000',
  };
  (wrongProperty['target_flow_property'] as JsonObject)['json'] = property;
  assert.equal(
    codeOf(() => build(wrongProperty)),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
});

test('a claimed flow must be a Product flow with exactly one canonical property', () => {
  const elementary = cohortInput();
  const flow = (elementary['flows'] as JsonObject[])[0] as JsonObject;
  const flowRoot = (flow['json'] as JsonObject)['flowDataSet'] as JsonObject;
  ((flowRoot['modellingAndValidation'] as JsonObject)['LCIMethod'] as JsonObject)['typeOfDataSet'] =
    'Elementary flow';
  assert.equal(
    codeOf(() => build(elementary)),
    LENGTH_TIME_SOURCE_SHAPE_INVALID,
  );

  const twoProperties = cohortInput();
  const second = (twoProperties['flows'] as JsonObject[])[1] as JsonObject;
  const secondRoot = (second['json'] as JsonObject)['flowDataSet'] as JsonObject;
  const properties = (secondRoot['flowProperties'] as JsonObject)['flowProperty'] as JsonObject[];
  properties.push(clone(properties[0] as JsonObject));
  assert.equal(
    codeOf(() => build(twoProperties)),
    LENGTH_TIME_SOURCE_SHAPE_INVALID,
  );

  const foreignProperty = cohortInput();
  const third = (foreignProperty['flows'] as JsonObject[])[2] as JsonObject;
  const thirdRoot = (third['json'] as JsonObject)['flowDataSet'] as JsonObject;
  const entry = (
    (thirdRoot['flowProperties'] as JsonObject)['flowProperty'] as JsonObject[]
  )[0] as JsonObject;
  (entry['referenceToFlowPropertyDataSet'] as JsonObject)['@refObjectId'] =
    '00000000-0000-4000-8000-000000000000';
  assert.equal(
    codeOf(() => build(foreignProperty)),
    LENGTH_TIME_SOURCE_SHAPE_INVALID,
  );

  const duplicate = cohortInput();
  const flows = duplicate['flows'] as JsonObject[];
  flows[1] = clone(flows[0] as JsonObject);
  assert.equal(
    codeOf(() => build(duplicate)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('process identity, payload and modification timestamp are required and unique', () => {
  const duplicate = cohortInput();
  const processes = duplicate['processes'] as JsonObject[];
  processes[1] = clone(processes[0] as JsonObject);
  assert.equal(
    codeOf(() => build(duplicate)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const noTimestamp = cohortInput();
  delete ((noTimestamp['processes'] as JsonObject[])[0] as JsonObject)['modified_at'];
  assert.equal(
    codeOf(() => build(noTimestamp)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const badTimestamp = cohortInput();
  ((badTimestamp['processes'] as JsonObject[])[0] as JsonObject)['modified_at'] = 'yesterday';
  assert.equal(
    codeOf(() => build(badTimestamp)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const noExchanges = cohortInput();
  const stripped = (noExchanges['processes'] as JsonObject[])[0] as JsonObject;
  const root = (stripped['json'] as JsonObject)['processDataSet'] as JsonObject;
  delete root['exchanges'];
  assert.equal(
    codeOf(() => build(noExchanges)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const emptyInput = cohortInput();
  emptyInput['flows'] = [];
  assert.equal(
    codeOf(() => build(emptyInput)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const noProcesses = cohortInput();
  noProcesses['processes'] = [];
  assert.equal(
    codeOf(() => build(noProcesses)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const noActor = cohortInput();
  delete noActor['actor_id'];
  assert.equal(
    codeOf(() => build(noActor)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('a process with no claimed occurrence refuses instead of emitting a no-op action', () => {
  const input = cohortInput();
  const process = (input['processes'] as JsonObject[])[0] as JsonObject;
  const entries = exchangesOf(process['json'] as JsonObject);
  for (const entry of entries) {
    (entry['referenceToFlowDataSet'] as JsonObject)['@refObjectId'] =
      '11111111-1111-4111-8111-111111111111';
  }
  assert.equal(
    codeOf(() => build(input)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('an amount outside the reviewed numeric bounds refuses', () => {
  const input = cohortInput();
  const process = (input['processes'] as JsonObject[])[0] as JsonObject;
  const entry = exchangesOf(process['json'] as JsonObject)[0] as JsonObject;
  entry['meanAmount'] = '1e900';
  entry['resultingAmount'] = '1e900';
  assert.equal(
    codeOf(() => build(input)),
    LENGTH_TIME_DERIVE_MISMATCH,
  );
});

test('the fixture tuple table and the built plan agree instance for instance', () => {
  const plan = build(cohortInput());
  const cohort = buildLengthTimeCohort();
  const built = (plan['actions'] as JsonObject[]).flatMap((action) =>
    ((action['mutation'] as JsonObject)['exchanges'] as JsonObject[]).map((entry) => ({
      index: entry['index'],
      internal_id: entry['internal_id'],
      source_exchange_number: entry['source_exchange_number'],
      direction: entry['direction'],
      flow_id: entry['flow_id'],
      flow_version: entry['flow_version'],
      before_literal: entry['before_literal'],
      after_literal: entry['after_literal'],
    })),
  );
  assert.deepEqual(
    built,
    cohort.processes.flatMap((process) => process.instances),
  );
  assert.equal(instanceOf(plan, 0)['table'], 'processes');
  assert.equal(isJsonObject(plan['expected']), true);
});
