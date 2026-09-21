// Deterministic, anonymized cohort fixture for the reviewed Length*time correction profile.
//
// The fixture reproduces the *shape* of the audited #186 cohort — 13 owner-draft processes, 13
// read-only Product flows on the canonical Length*time property, 39 selected exchange occurrences
// and 78 amount leaves, each multiplied by exactly 1000 — using synthetic datasets only: generated
// identifiers, the reviewed literal spellings, generated source numbers and no source payload,
// account, project or provenance content whatsoever.
//
// It is the ONE shared fixture: the CLI builds its plan from this input, and the storage-side owner
// seeds the same rows into a scratch stack to run the emitted plan through the real executor. The
// produced plan's digest is pinned by the CLI tests, so an accidental change to either half fails
// loudly instead of producing a second, hand-written "green".

import { sha256Json } from '../../src/lib/dataset-maintenance-contract.js';

type JsonObject = Record<string, unknown>;

/** The canonical Length*time flow property and unit group, embedded in the nested real structure. */
export const LENGTH_TIME_TARGET_FP = 'fd9d0d42-3655-5f1d-aa2f-e9ae1134fc82';
export const LENGTH_TIME_TARGET_UG = '8a1e27de-c1e7-5049-94bd-6c7ba80f52d1';
export const LENGTH_TIME_FIXTURE_ACTOR = 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7';

/** The reviewed literals and their exact x1000 products, alternating across the 39 instances. */
export const LENGTH_TIME_LITERAL_PAIRS = [
  ['0.014', '14'],
  ['0.0198', '19.8'],
  ['0.0549', '54.9'],
  ['0.0772', '77.2'],
  ['0.274', '274'],
  ['0.385', '385'],
  ['1', '1000'],
  ['2', '2000'],
] as const;

/**
 * Selected occurrences per process: one process carries seven of the 39 (the audited shape), the
 * rest carry two to four. The sum is exactly 39.
 */
export const LENGTH_TIME_INSTANCES_PER_PROCESS = [2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 7] as const;

/**
 * The frozen counts the reviewed cohort derives: the same eleven expected names the Time profile
 * uses. `unrelated_exchange_count` is the complement inside the 13 selected processes.
 */
export const LENGTH_TIME_COHORT_COUNTS = {
  action_count: 13,
  batch_count: 1,
  exchange_count: 39,
  amount_field_count: 78,
  unrelated_exchange_count: 13,
  audit_count: 15,
  flowproperty_count: 0,
  flow_count: 0,
  process_count: 13,
  derivative_target_count: 13,
  text_action_count: 0,
} as const;

/** Unrelated exchanges carried by each selected process (the complement the counts derive from). */
const UNRELATED_PER_PROCESS = 1;

const PROCESS_PREFIX = 'b20c0de0-0000-4000-8000-0000000000';
const FLOW_PREFIX = 'f10c0de0-0000-4000-8000-0000000000';
/** A flow outside the claimed set: the unrelated exchanges point here and it is never in scope. */
const UNRELATED_FLOW = 'f10c0de0-0000-4000-8000-000000000099';

const VERSION = '00.00.001';

/** Identity padding: two hex digits, so the fixture identifiers stay stable and readable. */
function hex2(index: number): string {
  return index.toString(16).padStart(2, '0');
}

export function lengthTimeProcessId(index: number): string {
  return `${PROCESS_PREFIX}${hex2(index + 1)}`;
}

export function lengthTimeFlowId(index: number): string {
  return `${FLOW_PREFIX}${hex2(index + 1)}`;
}

/**
 * The exact Length*time unit group at the canonical nested path, with the four rows and the factor
 * spellings the real snapshot carries: the reference `m*a` at `1.0`, the sibling `my` at `1.0`, the
 * prefixed `km*a` at `1000.0`, and the source `kmy` at `1000.0` — selected by the string internal id
 * of the reference row.
 */
export function lengthTimeUnitGroup(): JsonObject {
  return {
    unitGroupDataSet: {
      unitGroupInformation: {
        quantitativeReference: { referenceToReferenceUnit: '1' },
      },
      units: {
        unit: [
          { '@dataSetInternalID': '1', name: 'm*a', meanValue: '1.0' },
          { '@dataSetInternalID': '2', name: 'my', meanValue: '1.0' },
          { '@dataSetInternalID': '3', name: 'km*a', meanValue: '1000.0' },
          { '@dataSetInternalID': '4', name: 'kmy', meanValue: '1000.0' },
        ],
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
      },
    },
  };
}

/** The canonical Length*time property: plural information node, one unit-group reference. */
export function lengthTimeFlowProperty(): JsonObject {
  return {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: { 'common:name': { '#text': 'Length*time', '@xml:lang': 'en' } },
        quantitativeReference: {
          referenceToReferenceUnitGroup: {
            '@type': 'unit group data set',
            '@refObjectId': LENGTH_TIME_TARGET_UG,
            '@version': '01.00.000',
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
      },
    },
  };
}

/** One read-only Product flow carrying exactly one property entry onto the canonical property. */
export function lengthTimeFlow(index: number): JsonObject {
  const id = lengthTimeFlowId(index);
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: { 'common:UUID': id },
        quantitativeReference: { referenceToReferenceFlowProperty: '1' },
      },
      flowProperties: {
        flowProperty: [
          {
            '@dataSetInternalID': '1',
            meanValue: '1',
            referenceToFlowPropertyDataSet: {
              '@type': 'flow property data set',
              '@refObjectId': LENGTH_TIME_TARGET_FP,
              '@version': '01.00.000',
            },
          },
        ],
      },
      modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': VERSION },
      },
    },
  };
}

/** The reviewed exchange key set: both amount leaves are absolute, everything else is preserved. */
const REVIEWED_EXCHANGE_KEYS = [
  '@dataSetInternalID',
  'dataDerivationTypeStatus',
  'exchangeDirection',
  'generalComment',
  'meanAmount',
  'referenceToFlowDataSet',
  'relativeStandardDeviation95In',
  'resultingAmount',
  'uncertaintyDistributionType',
] as const;

function exchange(overrides: JsonObject): JsonObject {
  const base: JsonObject = {
    '@dataSetInternalID': '1',
    dataDerivationTypeStatus: 'Measured',
    exchangeDirection: 'Output',
    generalComment: { '#text': '730001' },
    meanAmount: '1',
    referenceToFlowDataSet: {
      '@refObjectId': UNRELATED_FLOW,
      '@version': VERSION,
    },
    resultingAmount: '1',
  };
  const merged = { ...base, ...overrides };
  // The reviewed key set is exact on both sides of the wire; a fixture that drifted would make the
  // CLI's own refusal test pass for the wrong reason.
  for (const key of Object.keys(merged)) {
    if (!(REVIEWED_EXCHANGE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Length*time fixture exchange carries an unreviewed key: ${key}`);
    }
  }
  return merged;
}

/**
 * One source comment in the shape the audited corpus actually carries: the anchored declaration
 * label, the number, its `.` delimiter — and then, for most of the corpus, an EcoSpold metadata
 * suffix whose own digits are NOT source ids. The plain and suffixed forms are interleaved so the
 * fixture exercises exactly the 13-plain / 26-suffixed split of the 39 real comments.
 */
function sourceComment(sourceNumber: string, suffixed: boolean): JsonObject {
  const label = `Source EcoSpold1 exchange number: ${sourceNumber}.`;
  return {
    '#text': suffixed ? `${label} (1,2,3,4,5,6,BU:7.8); ;` : label,
  };
}

export type LengthTimeFixtureProcess = {
  id: string;
  version: string;
  modified_at: string;
  json: JsonObject;
  /** The selected occurrences, in payload order: the reviewed source tuple table for this process. */
  instances: {
    index: number;
    internal_id: string;
    source_exchange_number: string;
    direction: string;
    flow_id: string;
    flow_version: string;
    before_literal: string;
    after_literal: string;
  }[];
};

export type LengthTimeCohortFixture = {
  actor_id: string;
  flows: { id: string; version: string; json: JsonObject }[];
  processes: LengthTimeFixtureProcess[];
  target_flow_property: { id: string; version: string; json: JsonObject };
  target_unit_group: { id: string; version: string; json: JsonObject };
};

/**
 * Builds the shared cohort: 13 processes whose own reference output is the first selected
 * occurrence, plus component inputs drawn from the other claimed flows, one unrelated exchange per
 * process, and the reviewed literals alternating across the 39 instances.
 */
export function buildLengthTimeCohort(): LengthTimeCohortFixture {
  const flows = Array.from({ length: LENGTH_TIME_COHORT_COUNTS.action_count }, (_value, index) => ({
    id: lengthTimeFlowId(index),
    version: VERSION,
    json: lengthTimeFlow(index),
  }));

  let sourceCounter = 730101;
  let literalCursor = 0;
  // The audited split of the 39 selected comments: 13 declare only the number and its delimiter,
  // 26 continue with EcoSpold metadata whose digits are not source ids.
  let commentCounter = 0;
  let selectedCounter = 0;
  const processes: LengthTimeFixtureProcess[] = [];
  for (const [processIndex, instanceCount] of LENGTH_TIME_INSTANCES_PER_PROCESS.entries()) {
    const id = lengthTimeProcessId(processIndex);
    const exchanges: JsonObject[] = [];
    const instances: LengthTimeFixtureProcess['instances'] = [];
    // The process's own reference exchange comes first, exactly as the audited payloads carry it:
    // internal id 1, Output, the process flow's own identity, functional unit `1 kmy`.
    for (let offset = 0; offset < instanceCount; offset += 1) {
      const isReference = offset === 0;
      const flowIndex = (processIndex + offset) % LENGTH_TIME_COHORT_COUNTS.action_count;
      const pair = LENGTH_TIME_LITERAL_PAIRS[literalCursor % LENGTH_TIME_LITERAL_PAIRS.length] as
        readonly [string, string] | undefined;
      literalCursor += 1;
      if (pair === undefined) {
        throw new Error('Length*time fixture literal table is empty.');
      }
      const [before, after] = pair;
      const internalId = String(offset + 1);
      const sourceNumber = String(sourceCounter);
      sourceCounter += 1;
      // The audited uncertainty carrier: every occurrence declares a distribution — the first 13 the
      // literal string `undefined`, the remaining 26 `log-normal` — and only the last 4 also declare
      // a standard deviation. Values are part of the fixture because the correction must preserve
      // them exactly, including the `undefined` spelling.
      const uncertainty =
        selectedCounter < 13
          ? { uncertaintyDistributionType: 'undefined' }
          : selectedCounter < 35
            ? { uncertaintyDistributionType: 'log-normal' }
            : {
                uncertaintyDistributionType: 'log-normal',
                relativeStandardDeviation95In: { '#text': '0.1' },
              };
      const entry = exchange({
        '@dataSetInternalID': internalId,
        dataDerivationTypeStatus: 'Measured',
        exchangeDirection: isReference ? 'Output' : 'Input',
        generalComment: sourceComment(sourceNumber, commentCounter >= 13),
        meanAmount: before,
        referenceToFlowDataSet: {
          '@refObjectId': lengthTimeFlowId(flowIndex),
          '@version': VERSION,
        },
        resultingAmount: before,
        ...uncertainty,
      });
      exchanges.push(entry);
      commentCounter += 1;
      selectedCounter += 1;
      instances.push({
        index: offset,
        internal_id: internalId,
        source_exchange_number: sourceNumber,
        direction: isReference ? 'Output' : 'Input',
        flow_id: lengthTimeFlowId(flowIndex),
        flow_version: VERSION,
        before_literal: before,
        after_literal: after,
      });
    }
    for (let extra = 0; extra < UNRELATED_PER_PROCESS; extra += 1) {
      exchanges.push(
        exchange({
          '@dataSetInternalID': String(instanceCount + extra + 1),
          exchangeDirection: 'Input',
          generalComment: { '#text': 'unrelated' },
          meanAmount: '42',
          referenceToFlowDataSet: { '@refObjectId': UNRELATED_FLOW, '@version': VERSION },
          resultingAmount: '42',
          // The unrelated exchanges carry the reviewed carrier too: the field is on every real
          // exchange, and this one is outside the correction set rather than outside the shape.
          uncertaintyDistributionType: 'undefined',
        }),
      );
    }
    processes.push({
      id,
      version: VERSION,
      // Synthetic, deterministic and explicit-offset: the plan carries this verbatim and the
      // executor re-checks it against the live row.
      modified_at: `2026-09-22T00:00:${String(processIndex + 1).padStart(2, '0')}.000000+00:00`,
      json: {
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': id },
            quantitativeReference: {
              referenceToReferenceFlow: '1',
              functionalUnitOrOther: { '@xml:lang': 'en', '#text': '1 kmy' },
            },
          },
          exchanges: { exchange: exchanges },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': VERSION },
          },
        },
      },
      instances,
    });
  }

  // The fixture must reproduce the real 13-plain / 26-metadata split, or the tests would keep
  // passing on a shape the audited corpus does not have.
  const selectedComments = processes.flatMap((process) =>
    process.instances.map(
      (instance) =>
        (
          ((process.json['processDataSet'] as JsonObject)['exchanges'] as JsonObject)[
            'exchange'
          ] as JsonObject[]
        )[instance.index] as JsonObject,
    ),
  );
  const suffixed = selectedComments.filter((exchange) =>
    String((exchange['generalComment'] as JsonObject)['#text']).includes('(1,2,3,4,5,6,BU:7.8)'),
  ).length;
  if (selectedComments.length - suffixed !== 13 || suffixed !== 26) {
    throw new Error('Length*time fixture must carry 13 plain and 26 metadata source comments.');
  }
  // The real uncertainty carrier: the distribution key is on every occurrence (13 spelled
  // `undefined`, 26 `log-normal`) and only 4 carry a standard deviation.
  const distributions = selectedComments.map((exchange) =>
    Object.hasOwn(exchange, 'uncertaintyDistributionType')
      ? String(exchange['uncertaintyDistributionType'])
      : null,
  );
  const deviations = selectedComments.map((exchange) =>
    Object.hasOwn(exchange, 'relativeStandardDeviation95In'),
  );
  if (
    distributions.filter((value) => value === 'undefined').length !== 13 ||
    distributions.filter((value) => value === 'log-normal').length !== 26 ||
    distributions.some((value) => value === null) ||
    deviations.filter(Boolean).length !== 4
  ) {
    throw new Error('Length*time fixture must carry the reviewed distribution/SD carrier.');
  }
  return {
    actor_id: LENGTH_TIME_FIXTURE_ACTOR,
    flows,
    processes,
    target_flow_property: {
      id: LENGTH_TIME_TARGET_FP,
      version: '01.00.000',
      json: lengthTimeFlowProperty(),
    },
    target_unit_group: {
      id: LENGTH_TIME_TARGET_UG,
      version: '01.00.000',
      json: lengthTimeUnitGroup(),
    },
  };
}

/** The complete instance tuple table the cohort derives, in the CLI's own canonical spelling. */
export function lengthTimeCohortTuples(cohort: LengthTimeCohortFixture): {
  process_id: string;
  version: string;
  instance: LengthTimeFixtureProcess['instances'][number];
}[] {
  return cohort.processes.flatMap((process) =>
    process.instances.map((instance) => ({
      process_id: process.id,
      version: process.version,
      instance,
    })),
  );
}

/**
 * The frozen source-evidence document the CLI planning input binds: the artifact digest, the exact
 * tuple-table digest the builder recomputes, and the reviewed unit pair and factor.
 */
export function lengthTimeSourceEvidence(cohort: LengthTimeCohortFixture): {
  sha256: string;
  cohort_sha256: string;
  source_unit: 'kmy';
  reference_unit: 'm*a';
  factor: '1000';
  instance_count: number;
} {
  return {
    // Synthetic stand-in for the frozen source artifact digest: the CLI only carries it through,
    // it never re-derives it from the artefact (which it does not read).
    sha256: sha256Json({ fixture: 'length-time-source-evidence', actor: cohort.actor_id }),
    cohort_sha256: sha256Json(lengthTimeEvidenceTuples(cohort)),
    source_unit: 'kmy',
    reference_unit: 'm*a',
    factor: '1000',
    instance_count: LENGTH_TIME_COHORT_COUNTS.exchange_count,
  };
}

/**
 * The evidence tuple spelling the frozen table digest is taken over: one line per occurrence, with
 * the complete source proof tuple. The builder recomputes exactly this from the before images.
 */
export function lengthTimeEvidenceTuples(cohort: LengthTimeCohortFixture): string[] {
  return lengthTimeCohortTuples(cohort)
    .map(
      ({ process_id, version, instance }) =>
        `${process_id}@${version}#${instance.index}:${instance.internal_id}:${instance.source_exchange_number}:${instance.direction}:${instance.flow_id}@${instance.flow_version}:${instance.before_literal}->${instance.after_literal}`,
    )
    .sort();
}

/** The planning input the CLI builder consumes: the fixture plus its bound source evidence. */
export function buildLengthTimePlanInput(overrides: JsonObject = {}): Record<string, unknown> {
  const cohort = buildLengthTimeCohort();
  return {
    actor_id: cohort.actor_id,
    flows: cohort.flows,
    processes: cohort.processes,
    target_flow_property: cohort.target_flow_property,
    target_unit_group: cohort.target_unit_group,
    source_evidence: lengthTimeSourceEvidence(cohort),
    ...overrides,
  };
}
