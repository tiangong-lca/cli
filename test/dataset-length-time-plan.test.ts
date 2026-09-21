import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cwd } from 'node:process';
import test from 'node:test';
import {
  isJsonObject,
  sha256Json,
  stableJsonText,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  LENGTH_TIME_EXCHANGE_KEYS,
  LENGTH_TIME_FACTOR,
  LENGTH_TIME_OPTIONAL_EXCHANGE_KEYS,
  LENGTH_TIME_REQUIRED_EXCHANGE_KEYS,
  LENGTH_TIME_PLAN_SCHEMA,
  LENGTH_TIME_PLAN_INVALID,
  LENGTH_TIME_COUNT_MISMATCH,
  LENGTH_TIME_DERIVE_MISMATCH,
  LENGTH_TIME_EVIDENCE_MISMATCH,
  LENGTH_TIME_SOURCE_SHAPE_INVALID,
  LENGTH_TIME_TARGET_SHAPE_INVALID,
  LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
  assertLengthTimeTargetUnitGroup,
  buildLengthTimePlan,
  lengthTimeCohortSha256,
  lengthTimeEvidenceTuples,
  lengthTimeInstances,
  lengthTimeSourceExchangeNumber,
  type LengthTimeProcessRow,
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

test('the direct readers fail closed on the shapes the builder refuses earlier', () => {
  const cohort = buildLengthTimeCohort();
  const process = cohort.processes[0] as unknown as LengthTimeProcessRow;
  // The occurrence reader is also used directly: a payload with no exchange array is refused here
  // rather than silently yielding no occurrences.
  // The exchange node is read at its canonical path in every shape it can take: a list of entries,
  // a single entry, a list carrying a non-entry, and nothing usable at all.
  for (const json of [
    {},
    { processDataSet: {} },
    { processDataSet: { exchanges: {} } },
    { processDataSet: { exchanges: { exchange: 'x' } } },
    { processDataSet: { exchanges: { exchange: [1] } } },
  ]) {
    assert.equal(
      codeOf(() => lengthTimeInstances({ ...process, json })),
      LENGTH_TIME_PLAN_INVALID,
      JSON.stringify(json),
    );
  }
  // A single entry node is the same one occurrence the array form carries.
  const single = {
    ...process,
    json: clone(process.json) as JsonObject,
  };
  const singleRoot = single.json['processDataSet'] as JsonObject;
  const singleEntries = exchangesOf(single.json);
  (singleRoot['exchanges'] as JsonObject)['exchange'] = singleEntries[0] as JsonObject;
  assert.equal(lengthTimeInstances(single).length, 1);
  // An identity without its version cannot be an occurrence's flow reference.
  const noVersion = { ...process, json: clone(process.json) as JsonObject };
  (exchangesOf(noVersion.json)[2] as JsonObject)['referenceToFlowDataSet'] = {
    '@refObjectId': 'f10c0de0-0000-4000-8000-000000000001',
  };
  assert.equal(lengthTimeInstances(noVersion).length, 2);

  // A unit-group row without a readable table cannot be read at the canonical path at all.
  for (const json of [{}, { unitGroupDataSet: {} }, { unitGroupDataSet: { units: {} } }]) {
    assert.equal(
      codeOf(() =>
        assertLengthTimeTargetUnitGroup({
          id: process.id,
          version: process.version,
          json,
        }),
      ),
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      JSON.stringify(json),
    );
  }
  // The tuple table of an input with no read-only flows is empty, not an error, and the exported
  // cohort digest is the one the builder binds.
  assert.deepEqual(
    lengthTimeEvidenceTuples({
      ...(cohortInput() as unknown as LengthTimePlanInput),
      flows: null as unknown as [],
    }),
    [],
  );
  assert.equal(
    lengthTimeCohortSha256(cohortInput() as unknown as LengthTimePlanInput),
    (cohortInput()['source_evidence'] as JsonObject)['cohort_sha256'],
  );
});

test('a process with no readable functional unit is refused after its occurrences are derived', () => {
  for (const information of [{}, 'deleted']) {
    const input = cohortInput();
    const process = (input['processes'] as JsonObject[])[0] as JsonObject;
    const root = (process['json'] as JsonObject)['processDataSet'] as JsonObject;
    if (information === 'deleted') {
      delete root['processInformation'];
    } else {
      root['processInformation'] = information;
    }
    assert.equal(
      codeOf(() => build(input)),
      LENGTH_TIME_PLAN_INVALID,
    );
  }
});

test('the shared fixture pins the exact plan digest both halves build against', () => {
  // The one shared fixture: the storage-side owner seeds the same rows and runs this exact
  // document. If either half changes and the digest moves, this fails loudly rather than letting
  // two hand-written "green" contracts drift apart.
  const plan = build(cohortInput());
  assert.equal(
    plan['plan_sha256'],
    '3d143fe85eb47eb095ff0ebf0f35eba59c3ef79001be44d646624ba7ba544775',
  );
  const evidence = cohortInput()['source_evidence'] as JsonObject;
  assert.equal(
    evidence['sha256'],
    '9668586aed28628f64d79265b14a079951c9d1dc1c092cde61ebcf983fef3a7d',
  );
  assert.equal(
    evidence['cohort_sha256'],
    '1814071ed2ab68e6f998df784c30add48d8245ae924ca915d0821091bf004a85',
  );
  assert.deepEqual(plan['expected'], LENGTH_TIME_COHORT_COUNTS);
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

test('the source number comes from its anchored declaration and nothing else', () => {
  // Every shared vector the grammar admits is admitted and every one it refuses is refused: the CLI
  // and the executor read the same list, so neither can drift into picking other digits.
  const vectors = JSON.parse(
    readFileSync(path.join(cwd(), 'test/fixtures/length-time-source-comment-vectors.json'), 'utf8'),
  ) as { accepted: { text: string; number: string }[]; refused: { text: string }[] };
  assert.equal(vectors.accepted.length, 7);
  assert.equal(vectors.refused.length, 10);
  for (const vector of vectors.accepted) {
    assert.equal(
      lengthTimeSourceExchangeNumber({ '#text': vector.text }),
      vector.number,
      vector.text,
    );
  }
  for (const vector of vectors.refused) {
    assert.equal(lengthTimeSourceExchangeNumber({ '#text': vector.text }), null, vector.text);
  }
  // A non-string or absent leaf declares nothing at all.
  for (const comment of [null, undefined, {}, { '#text': 730045 }, [], { '#text': '' }]) {
    assert.equal(lengthTimeSourceExchangeNumber(comment), null);
  }
  // The fixture's own 39 selected comments — 13 plain and 26 with an EcoSpold metadata suffix —
  // all parse to exactly the number the fixture's tuple table binds.
  const cohort = buildLengthTimeCohort();
  let parsed = 0;
  for (const process of cohort.processes) {
    const entries = exchangesOf(process.json);
    for (const instance of process.instances) {
      const comment = (entries[instance.index] as JsonObject)['generalComment'];
      assert.equal(
        lengthTimeSourceExchangeNumber(comment),
        instance.source_exchange_number,
        String((comment as JsonObject)['#text']),
      );
      parsed += 1;
    }
  }
  assert.equal(parsed, 39);

  // Inside a real cohort, a refused declaration is an instance-derivation failure...
  const refused = cohortInput();
  const process = (refused['processes'] as JsonObject[])[0] as JsonObject;
  (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['generalComment'] = {
    '#text': 'Source EcoSpold1 exchange number: 730045 and 730999.',
  };
  assert.equal(
    codeOf(() => build(refused)),
    LENGTH_TIME_DERIVE_MISMATCH,
  );

  // ...while an absent comment is a shape deviation from the exact reviewed key set.
  const absent = cohortInput();
  const noComment = (absent['processes'] as JsonObject[])[3] as JsonObject;
  const exchange = exchangesOf(noComment['json'] as JsonObject)[0] as JsonObject;
  delete exchange['generalComment'];
  assert.equal(
    codeOf(() => build(absent)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('the uncertainty pair is optional and preserved exactly as the source declares it', () => {
  // The audited corpus carries the uncertainty keys unevenly: 13 occurrences declare no distribution
  // and no standard deviation, 22 declare `log-normal` without one, 4 declare `log-normal` with one.
  // Every combination is accepted and copied through unchanged — the correction never invents a
  // standard deviation, never defaults one to zero and never reinterprets the distribution.
  const cohort = buildLengthTimeCohort();
  const shapes = new Set<string>();
  for (const process of cohort.processes) {
    const entries = exchangesOf(process.json);
    for (const instance of process.instances) {
      const exchange = entries[instance.index] as JsonObject;
      shapes.add(
        `${String(exchange['uncertaintyDistributionType'] ?? 'none')}/${Object.hasOwn(exchange, 'relativeStandardDeviation95In') ? 'sd' : 'no-sd'}`,
      );
    }
  }
  assert.deepEqual([...shapes].sort(), ['log-normal/no-sd', 'log-normal/sd', 'none/no-sd']);

  const plan = build(cohortInput());
  for (const action of plan['actions'] as JsonObject[]) {
    const before = exchangesOf(action['expected_json_ordered'] as JsonObject);
    const desired = exchangesOf(action['desired_json_ordered'] as JsonObject);
    for (const instance of (action['mutation'] as JsonObject)['exchanges'] as JsonObject[]) {
      const index = instance['index'] as number;
      const source = before[index] as JsonObject;
      const result = desired[index] as JsonObject;
      // Presence and byte-exact value survive; only the two amount leaves moved.
      assert.equal(
        Object.hasOwn(result, 'uncertaintyDistributionType'),
        Object.hasOwn(source, 'uncertaintyDistributionType'),
      );
      assert.deepEqual(
        result['uncertaintyDistributionType'],
        source['uncertaintyDistributionType'],
      );
      assert.deepEqual(
        result['relativeStandardDeviation95In'],
        source['relativeStandardDeviation95In'],
      );
    }
  }

  // An occurrence that declares neither key is still a complete reviewed occurrence.
  const stripped = cohortInput();
  const process = (stripped['processes'] as JsonObject[])[0] as JsonObject;
  const exchange = exchangesOf(process['json'] as JsonObject)[0] as JsonObject;
  delete exchange['uncertaintyDistributionType'];
  delete exchange['relativeStandardDeviation95In'];
  assert.equal(typeof build(stripped)['plan_sha256'], 'string');
});

test('unreviewed or unstable exchange keys refuse rather than being copied through', () => {
  // A key outside the reviewed set is still refused even though two of the nine are optional.
  for (const key of ['dataSetInternalID', 'comment', 'pedigreeUncertainty', 'other']) {
    const unreviewed = cohortInput();
    const process = (unreviewed['processes'] as JsonObject[])[0] as JsonObject;
    (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)[key] = 'x';
    assert.equal(
      codeOf(() => build(unreviewed)),
      LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
      key,
    );
  }
  // A missing *required* key is a shape deviation; the optional pair is exactly two keys.
  for (const key of LENGTH_TIME_REQUIRED_EXCHANGE_KEYS) {
    const incomplete = cohortInput();
    const process = (incomplete['processes'] as JsonObject[])[0] as JsonObject;
    delete (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)[key];
    // Dropping the flow reference removes the occurrence from the selected set altogether, so the
    // frozen cohort no longer matches; every other missing field is caught as a shape deviation.
    assert.equal(
      codeOf(() => build(incomplete)),
      key === 'referenceToFlowDataSet' ? LENGTH_TIME_EVIDENCE_MISMATCH : LENGTH_TIME_PLAN_INVALID,
      key,
    );
  }
  assert.equal(LENGTH_TIME_REQUIRED_EXCHANGE_KEYS.length, 7);
  assert.deepEqual(
    [...LENGTH_TIME_OPTIONAL_EXCHANGE_KEYS],
    ['relativeStandardDeviation95In', 'uncertaintyDistributionType'],
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

test('the canonical property reference is exact in id, version and kind', () => {
  const pointAt = (patch: (declared: JsonObject) => void): string => {
    const input = cohortInput();
    const property = lengthTimeFlowProperty();
    const info = (property['flowPropertyDataSet'] as JsonObject)[
      'flowPropertiesInformation'
    ] as JsonObject;
    patch(
      (info['quantitativeReference'] as JsonObject)['referenceToReferenceUnitGroup'] as JsonObject,
    );
    (input['target_flow_property'] as JsonObject)['json'] = property;
    return codeOf(() => build(input));
  };
  // A missing version is refused: the pointer must name the locked version, not merely an id.
  assert.equal(
    pointAt((declared) => delete declared['@version']),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A different version is refused even when the id and kind are right.
  assert.equal(
    pointAt((declared) => (declared['@version'] = '01.00.001')),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A wrong or missing reference kind is refused.
  assert.equal(
    pointAt((declared) => (declared['@type'] = 'flow property data set')),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  assert.equal(
    pointAt((declared) => delete declared['@type']),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A missing reference object is refused rather than read as "no pointer to check".
  assert.equal(
    pointAt((declared) => {
      for (const key of Object.keys(declared)) {
        delete declared[key];
      }
    }),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  assert.equal(
    pointAt((declared) => delete declared['@refObjectId']),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  assert.equal(
    pointAt((declared) => {
      declared['@refObjectId'] = 'fd9d0d42-3655-5f1d-aa2f-e9ae1134fc82';
      delete declared['@version'];
    }),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
});

test('the reviewed factors are compared as exact decimals, never as literals or floats', () => {
  // The real snapshot spells the reference `1.0` and the source ratio `1000.0`; the reviewed
  // constants are `1` and `1000`. The comparison is the module's own bounded-decimal normaliser, so
  // any value-equal spelling is accepted and nothing else is.
  const withFactor = (name: string, factor: unknown): boolean => {
    const input = cohortInput();
    const group = lengthTimeUnitGroup();
    const units = (group['unitGroupDataSet'] as JsonObject)['units'] as JsonObject;
    units['unit'] = (units['unit'] as JsonObject[]).map((unit) =>
      unit['name'] === name ? { ...unit, meanValue: factor } : unit,
    );
    (input['target_unit_group'] as JsonObject)['json'] = group;
    try {
      build(input);
      return true;
    } catch {
      return false;
    }
  };
  for (const spelling of ['1.0', '1.00', '1', '1.000']) {
    assert.equal(withFactor('m*a', spelling), true, spelling);
  }
  for (const spelling of ['1000.0', '1000', '1000.0000']) {
    assert.equal(withFactor('kmy', spelling), true, spelling);
  }
  for (const spelling of [
    '1.1',
    '0.999',
    '10.00',
    '100',
    '10000',
    '',
    '1,0',
    'NaN',
    'Infinity',
    null,
    1,
  ]) {
    assert.equal(withFactor('kmy', spelling), false, String(spelling));
  }
});

test('the unit table must carry unique internal ids and exactly one selected reference', () => {
  const withUnits = (units: JsonObject[]): string => {
    const input = cohortInput();
    const group = lengthTimeUnitGroup();
    ((group['unitGroupDataSet'] as JsonObject)['units'] as JsonObject)['unit'] = units;
    (input['target_unit_group'] as JsonObject)['json'] = group;
    return codeOf(() => build(input));
  };
  // A repeated internal id makes "the base unit" ambiguous, whichever row carries the factor.
  assert.equal(
    withUnits([
      { '@dataSetInternalID': '1', name: 'm*a', meanValue: '1' },
      { '@dataSetInternalID': '1', name: 'kmy', meanValue: '1000' },
      { '@dataSetInternalID': '2', name: 'kmy', meanValue: '1000' },
    ]),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A unit row without an internal id cannot be selected or ruled out: refused.
  assert.equal(
    withUnits([
      { name: 'm*a', meanValue: '1' },
      { '@dataSetInternalID': '2', name: 'kmy', meanValue: '1000' },
    ]),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // The selected reference must exist: an id no row carries is not a base unit.
  assert.equal(
    withUnits([
      { '@dataSetInternalID': '2', name: 'm*a', meanValue: '1' },
      { '@dataSetInternalID': '3', name: 'kmy', meanValue: '1000' },
    ]),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // The reviewed four-row table itself is still accepted, and so is a table whose factors are
  // spelled without trailing zeros: the rule refuses ambiguity, not the cohort or its spellings.
  for (const units of [
    [1, 2, 3, 4].map((index) => ({
      '@dataSetInternalID': String(index),
      name: ['m*a', 'my', 'km*a', 'kmy'][index - 1] as string,
      meanValue: index > 2 ? '1000' : '1',
    })),
  ]) {
    const input = cohortInput();
    const group = lengthTimeUnitGroup();
    ((group['unitGroupDataSet'] as JsonObject)['units'] as JsonObject)['unit'] = units;
    (input['target_unit_group'] as JsonObject)['json'] = group;
    assert.equal(typeof build(input)['plan_sha256'], 'string');
  }
});

test('every required scalar of the Length envelopes fails closed when it is null', () => {
  const cases: [string, (input: JsonObject) => void][] = [
    [
      'a null source-evidence digest',
      (input) => ((input['source_evidence'] as JsonObject)['sha256'] = null),
    ],
    [
      'a null cohort digest',
      (input) => ((input['source_evidence'] as JsonObject)['cohort_sha256'] = null),
    ],
    [
      'a null source unit',
      (input) => ((input['source_evidence'] as JsonObject)['source_unit'] = null),
    ],
    [
      'a null reference unit',
      (input) => ((input['source_evidence'] as JsonObject)['reference_unit'] = null),
    ],
    ['a null factor', (input) => ((input['source_evidence'] as JsonObject)['factor'] = null)],
    [
      'a null instance count',
      (input) => ((input['source_evidence'] as JsonObject)['instance_count'] = null),
    ],
    ['a null actor id', (input) => (input['actor_id'] = null)],
    [
      'a null target unit group payload',
      (input) => ((input['target_unit_group'] as JsonObject)['json'] = null),
    ],
    [
      'a null target unit group version',
      (input) => ((input['target_unit_group'] as JsonObject)['version'] = null),
    ],
    [
      'a null target property id',
      (input) => ((input['target_flow_property'] as JsonObject)['id'] = null),
    ],
    [
      'a null flow payload',
      (input) => (((input['flows'] as JsonObject[])[0] as JsonObject)['json'] = null),
    ],
    [
      'a null flow version',
      (input) => (((input['flows'] as JsonObject[])[0] as JsonObject)['version'] = null),
    ],
    [
      'a null process payload',
      (input) => (((input['processes'] as JsonObject[])[0] as JsonObject)['json'] = null),
    ],
    [
      'a null process version',
      (input) => (((input['processes'] as JsonObject[])[0] as JsonObject)['version'] = null),
    ],
    [
      'a null process timestamp',
      (input) => (((input['processes'] as JsonObject[])[0] as JsonObject)['modified_at'] = null),
    ],
    [
      'a null exchange amount',
      (input) => {
        const process = (input['processes'] as JsonObject[])[0] as JsonObject;
        (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['meanAmount'] = null;
      },
    ],
    [
      'a null exchange direction',
      (input) => {
        const process = (input['processes'] as JsonObject[])[0] as JsonObject;
        (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['exchangeDirection'] = null;
      },
    ],
    [
      'a null flow reference',
      (input) => {
        const process = (input['processes'] as JsonObject[])[0] as JsonObject;
        (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['referenceToFlowDataSet'] =
          null;
      },
    ],
    [
      'a null internal id',
      (input) => {
        const process = (input['processes'] as JsonObject[])[0] as JsonObject;
        (exchangesOf(process['json'] as JsonObject)[0] as JsonObject)['@dataSetInternalID'] = null;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const input = cohortInput();
    mutate(input);
    const code = codeOf(() => build(input));
    assert.notEqual(code, undefined, label);
    assert.equal(typeof code, 'string', label);
  }
  // None of them may slip through: each mutation must be refused by one of the family's codes.
  for (const [label, mutate] of cases) {
    const input = cohortInput();
    mutate(input);
    assert.match(
      codeOf(() => build(input)),
      /^LENGTH_TIME_/u,
      label,
    );
  }
});

test('a process without a readable functional-unit text is refused', () => {
  const missing = cohortInput();
  const process = (missing['processes'] as JsonObject[])[0] as JsonObject;
  const root = (process['json'] as JsonObject)['processDataSet'] as JsonObject;
  delete ((root['processInformation'] as JsonObject)['quantitativeReference'] as JsonObject)[
    'functionalUnitOrOther'
  ];
  assert.equal(
    codeOf(() => build(missing)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const empty = cohortInput();
  const emptyProcess = (empty['processes'] as JsonObject[])[1] as JsonObject;
  const emptyRoot = (emptyProcess['json'] as JsonObject)['processDataSet'] as JsonObject;
  (
    ((emptyRoot['processInformation'] as JsonObject)['quantitativeReference'] as JsonObject)[
      'functionalUnitOrOther'
    ] as JsonObject
  )['#text'] = '';
  assert.equal(
    codeOf(() => build(empty)),
    LENGTH_TIME_PLAN_INVALID,
  );

  const nonString = cohortInput();
  const oddProcess = (nonString['processes'] as JsonObject[])[2] as JsonObject;
  const oddRoot = (oddProcess['json'] as JsonObject)['processDataSet'] as JsonObject;
  (
    ((oddRoot['processInformation'] as JsonObject)['quantitativeReference'] as JsonObject)[
      'functionalUnitOrOther'
    ] as JsonObject
  )['#text'] = 1;
  assert.equal(
    codeOf(() => build(nonString)),
    LENGTH_TIME_PLAN_INVALID,
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

  // A flow payload with no readable data-set kind is not a Product flow: the kind leaf is read at
  // its canonical path, and every missing or differently-shaped level fails closed.
  for (const payload of [
    {},
    { flowDataSet: {} },
    { flowDataSet: { modellingAndValidation: {} } },
    { flowDataSet: { modellingAndValidation: { LCIMethod: { typeOfDataSet: 7 } } } },
  ]) {
    const shapeless = cohortInput();
    ((shapeless['flows'] as JsonObject[])[0] as JsonObject)['json'] = payload;
    assert.equal(
      codeOf(() => build(shapeless)),
      LENGTH_TIME_SOURCE_SHAPE_INVALID,
    );
  }
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

test('every canonical target shape gap refuses rather than being read as a shorter path', () => {
  const withProperty = (mutate: (property: JsonObject) => void): string => {
    const input = cohortInput();
    const property = lengthTimeFlowProperty();
    mutate(property);
    (input['target_flow_property'] as JsonObject)['json'] = property;
    return codeOf(() => build(input));
  };
  // The plural information node is the only canonical path: a flattened or missing one refuses.
  assert.equal(
    withProperty((property) => delete property['flowPropertyDataSet']),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  assert.equal(
    withProperty(
      (property) =>
        delete (property['flowPropertyDataSet'] as JsonObject)['flowPropertiesInformation'],
    ),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A quantitative reference that is absent, or whose unit-group reference is absent, refuses.
  assert.equal(
    withProperty(
      (property) =>
        delete (
          (property['flowPropertyDataSet'] as JsonObject)['flowPropertiesInformation'] as JsonObject
        )['quantitativeReference'],
    ),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );

  const withGroup = (mutate: (units: JsonObject[]) => JsonObject[]): string => {
    const input = cohortInput();
    const group = lengthTimeUnitGroup();
    const units = (group['unitGroupDataSet'] as JsonObject)['units'] as JsonObject;
    units['unit'] = mutate(units['unit'] as JsonObject[]);
    (input['target_unit_group'] as JsonObject)['json'] = group;
    return codeOf(() => build(input));
  };
  // The selected reference row must be named exactly `m*a` and sit at exactly factor 1.
  assert.equal(
    withGroup((units) => [{ ...(units[0] as JsonObject), name: 'km' }, ...units.slice(1)]),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  assert.equal(
    withGroup((units) => [{ ...(units[0] as JsonObject), meanValue: '2' }, ...units.slice(1)]),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A selected reference row with no name at all is refused, and its missing name is reported.
  assert.equal(
    withGroup((units) => {
      const first = { ...(units[0] as JsonObject) };
      delete first['name'];
      return [first, ...units.slice(1)];
    }),
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  // A kmy factor the reviewed decimal grammar cannot read — malformed, out of bounds or merely near
  // the reviewed value — refuses just as a drifted literal does.
  for (const factor of ['1000.0001', '999.9', '1000.0.0', '', ' 1000.0', 1000]) {
    assert.equal(
      withGroup((units) =>
        units.map((unit, index) => (index === 3 ? { ...unit, meanValue: factor } : unit)),
      ),
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      String(factor),
    );
  }
  // The real four-row table is accepted exactly as the snapshot spells it: `1.0` and `1000.0` are
  // value-equal to the reviewed constants through the exact-decimal normaliser, not by enumeration.
  const accepted = cohortInput();
  assert.equal(
    build(accepted)['plan_sha256'],
    '3d143fe85eb47eb095ff0ebf0f35eba59c3ef79001be44d646624ba7ba544775',
  );
});

test('a process payload that cannot even be read refuses at its own step', () => {
  // No exchange array at all: the action cannot be derived.
  const noExchanges = cohortInput();
  ((noExchanges['processes'] as JsonObject[])[0] as JsonObject)['json'] = { processDataSet: {} };
  assert.equal(
    codeOf(() => build(noExchanges)),
    LENGTH_TIME_PLAN_INVALID,
  );

  // A readable exchange array but no process information: the functional-unit text is unreadable,
  // so the readback would have nothing to compare against.
  for (const payload of [
    { processDataSet: { exchanges: { exchange: [{ '@dataSetInternalID': '1' }] } } },
    {
      processDataSet: {
        processInformation: {},
        exchanges: { exchange: [{ '@dataSetInternalID': '1' }] },
      },
    },
  ]) {
    const input = cohortInput();
    ((input['processes'] as JsonObject[])[0] as JsonObject)['json'] = payload;
    assert.equal(
      codeOf(() => build(input)),
      LENGTH_TIME_PLAN_INVALID,
    );
  }
});

test('the occurrence reader refuses a reference it cannot resolve, with or without a claim set', () => {
  // Called without a claim set the reader derives every exchange that resolves to some flow: an
  // exchange with no resolvable reference is skipped, and one whose identity is malformed refuses
  // rather than being copied into a plan.
  const cohort = buildLengthTimeCohort();
  const source = cohort.processes[0] as unknown as LengthTimeProcessRow;
  const process: LengthTimeProcessRow = {
    id: source.id,
    version: source.version,
    modified_at: source.modified_at,
    json: clone(source.json) as JsonObject,
  };
  const selected = [0, 1];
  const unrelated = selected.length;
  const exchangeAt = (index: number): JsonObject => exchangesOf(process.json)[index] as JsonObject;
  // The third exchange is the fixture's unrelated one: give it a readable source declaration so it
  // is a well-formed occurrence of *some* flow, which is what the no-claim reading counts.
  (exchangeAt(unrelated) as JsonObject)['generalComment'] = {
    '#text': 'Source EcoSpold1 exchange number: 730900.',
  };
  // Without a claim set every resolvable reference counts, and one that resolves to nothing is
  // simply not an occurrence.
  assert.equal(lengthTimeInstances(process).length, selected.length + 1);
  exchangeAt(unrelated)['referenceToFlowDataSet'] = { '@version': '00.00.001' };
  assert.equal(lengthTimeInstances(process).length, selected.length);
  // An identity that is not a flow reference at all refuses rather than entering a plan.
  exchangeAt(unrelated)['referenceToFlowDataSet'] = {
    '@refObjectId': 'not-a-uuid',
    '@version': '00.00.001',
  };
  assert.equal(
    codeOf(() => lengthTimeInstances(process)),
    LENGTH_TIME_PLAN_INVALID,
  );

  // With a claim set, only the claimed flows are occurrences: the third exchange is not one.
  const claimed = new Set([
    `${String(exchangeAt(0)['referenceToFlowDataSet'] && (exchangeAt(0)['referenceToFlowDataSet'] as JsonObject)['@refObjectId'])}@00.00.001`,
  ]);
  assert.equal(lengthTimeInstances(process, claimed).length, 1);
  assert.deepEqual(
    lengthTimeInstances(process, claimed).map((instance) => instance.flow_id),
    [(exchangeAt(0)['referenceToFlowDataSet'] as JsonObject)['@refObjectId']],
  );
});

test('an exchange set that would change nothing refuses instead of minting a no-op action', () => {
  // Zero scales to zero, so a process whose every selected occurrence is already zero would
  // produce an action that changes no byte: that is refused rather than emitted as a no-op.
  const input = cohortInput();
  const cohort = buildLengthTimeCohort();
  const process = (input['processes'] as JsonObject[])[0] as JsonObject;
  const entries = exchangesOf(process['json'] as JsonObject);
  for (const instance of (cohort.processes[0] as { instances: { index: number }[] }).instances) {
    (entries[instance.index] as JsonObject)['meanAmount'] = '0';
    (entries[instance.index] as JsonObject)['resultingAmount'] = '0';
  }
  assert.equal(
    codeOf(() => build(input)),
    LENGTH_TIME_PLAN_INVALID,
  );
});

test('a source evidence block that is not an object refuses at its own shape check', () => {
  for (const value of [null, 'bound', [], 7]) {
    const input = cohortInput();
    input['source_evidence'] = value;
    assert.equal(
      codeOf(() => build(input)),
      LENGTH_TIME_PLAN_INVALID,
    );
  }
});

test('a flow property array written as one object is read, two entries refuse, none refuse', () => {
  const asObject = cohortInput();
  const flow = (asObject['flows'] as JsonObject[])[0] as JsonObject;
  const root = (flow['json'] as JsonObject)['flowDataSet'] as JsonObject;
  const properties = (root['flowProperties'] as JsonObject)['flowProperty'] as JsonObject[];
  (root['flowProperties'] as JsonObject)['flowProperty'] = properties[0] as JsonObject;
  // The entry itself is read identically; only the payload bytes (and so the plan digest) differ.
  const cohort = buildLengthTimeCohort();
  const plan = build(asObject);
  const action = (plan['actions'] as JsonObject[])[0] as JsonObject;
  assert.equal(
    ((action['mutation'] as JsonObject)['exchanges'] as JsonObject[])[0]?.['flow_id'],
    cohort.flows[0]?.id,
  );

  // Two entries are not the reviewed shape, neither is an empty one, and neither is a shape that
  // is neither an entry nor a list of entries.
  for (const value of [
    [...(properties as JsonObject[]), properties[0] as JsonObject],
    [],
    'x' as unknown as JsonObject,
    undefined as unknown as JsonObject,
  ]) {
    const input = cohortInput();
    const flow = (input['flows'] as JsonObject[])[0] as JsonObject;
    const flowRoot = (flow['json'] as JsonObject)['flowDataSet'] as JsonObject;
    (flowRoot['flowProperties'] as JsonObject)['flowProperty'] = value;
    assert.equal(
      codeOf(() => build(input)),
      LENGTH_TIME_SOURCE_SHAPE_INVALID,
    );
  }
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
