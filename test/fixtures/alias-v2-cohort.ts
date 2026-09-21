// Deterministic, anonymized cohort fixture for the reviewed Time alias v2 plan.
//
// The fixture reproduces the *shape* of the current source-proven cohort — 113 flows, 274
// processes, 654 alias exchange occurrences and 4 147 unrelated exchanges across those
// processes, with 87 source-proven incorrect functional-unit prefixes — using synthetic
// datasets only: generated identifiers, generated amounts chosen from the reviewed exponent and
// plain spellings, and no source payload, account, comment or provenance content whatsoever.
// Its purpose is to make the frozen cohort counts and the per-action invariants testable at
// full scale, and to give the storage-side owner the same generated fixture to check against.

import type { AliasV2PlanInput } from '../../src/lib/dataset-alias-v2-plan.js';

type JsonObject = Record<string, unknown>;

/** The frozen cohort counts the current source-proven plan must derive. */
export const COHORT_COUNTS = {
  action_count: 387,
  flowproperty_count: 0,
  flow_count: 113,
  process_count: 274,
  exchange_count: 654,
  amount_field_count: 1308,
  unrelated_exchange_count: 4147,
} as const;

/** Source-proven functional-unit corrections, and the correct forms that stay untouched. */
export const COHORT_TEXT_ACTION_COUNT = 87;
export const COHORT_CORRECT_UNIT_TEXT_COUNT = 41;

const FLOW_COUNT = COHORT_COUNTS.flow_count;
const PROCESS_COUNT = COHORT_COUNTS.process_count;
const SOURCE_FP = 'bd69e542-6a50-524c-8d04-195b1ec23150';
const TARGET_FP = 'da11d28f-4db8-51eb-b3a9-8784b26771e6';
const SOURCE_UG = 'aeddc8ee-da6f-5181-9a99-73466e198b86';
const TARGET_UG = '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb';

/** Reviewed spellings the fixture draws its amounts from: exponent forms and plain decimals. */
const AMOUNT_SPELLINGS = [
  '2.0E-4',
  '9.1E-5',
  '1.03E-4',
  '1.18E-7',
  '9.423E-4',
  '2.43E-6',
  '8.499E-5',
  '1.836E-5',
  '6.17e-4',
  '3.5e-3',
  '1E-3',
  '0.0002',
  '0.0009',
  '1',
  '1.0',
  '2.5',
] as const;

const UNCERTAINTY_TYPES = ['undefined', 'log-normal'] as const;

/** Synthetic identifiers: fixed prefix, zero padding, no account or dataset content. */
function syntheticId(kind: 'flow' | 'process', index: number): string {
  const prefix = kind === 'flow' ? 'f10c0de0' : 'b20c0de0';
  return `${prefix}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function flowPayload(id: string): JsonObject {
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
              '@refObjectId': SOURCE_FP,
              '@version': '00.00.001',
              '@uri': `../flowproperties/${SOURCE_FP}.json`,
              'common:shortDescription': { '#text': 'Amount in hr', '@xml:lang': 'en' },
            },
          },
        ],
      },
      modellingAndValidation: {
        LCIMethod: { typeOfDataSet: 'Product flow' },
      },
      administrativeInformation: { 'common:other': 'fixture' },
    },
  };
}

/**
 * Exchange occurrences per process: 17 or 18 in total, of which 2 or 3 are the alias occurrence.
 * The distribution is fixed so the totals are exactly 654 alias occurrences and 4 147 unrelated
 * exchanges across the 274 processes.
 */
function cohortShape(index: number): { exchanges: number; aliases: number } {
  const exchanges = index < 143 ? 18 : 17;
  const aliases = index < 106 ? 3 : 2;
  return { exchanges, aliases };
}

function processPayload(
  id: string,
  index: number,
  aliases: number,
  exchangeCount: number,
  unitText: string,
): { json: JsonObject; exchange_indexes: number[] } {
  const exchange_indexes = Array.from({ length: aliases }, (_, offset) => offset);
  const exchanges: JsonObject[] = [];
  for (let position = 0; position < exchangeCount; position += 1) {
    const isAlias = position < aliases;
    const spelling = AMOUNT_SPELLINGS[
      (index * 7 + position * 3) % AMOUNT_SPELLINGS.length
    ] as string;
    const exchange: JsonObject = {
      '@dataSetInternalID': String(position + 1),
      meanAmount: isAlias ? spelling : '1',
      resultingAmount: isAlias ? spelling : '1',
      exchangeDirection: position % 2 === 0 ? 'Input' : 'Output',
      dataDerivationTypeStatus: 'Unknown derivation',
      uncertaintyDistributionType: UNCERTAINTY_TYPES[(index + position) % 2] as string,
      referenceToFlowDataSet: {
        '@type': 'flow data set',
        '@refObjectId': syntheticId('flow', (index * 31 + position) % FLOW_COUNT),
        '@version': '00.00.001',
      },
      generalComment: {
        '#text': `Fixture occurrence ${position + 1}.`,
        '@xml:lang': 'en',
      },
    };
    if (position % 20 === 0) {
      // Dimensionless dispersion: preserved byte-for-byte, never scaled.
      exchange['relativeStandardDeviation95In'] = '1.32';
    }
    exchanges.push(exchange);
  }
  return {
    json: {
      processDataSet: {
        processInformation: {
          dataSetInformation: { 'common:UUID': id },
          quantitativeReference: {
            referenceToReferenceFlow: '1',
            functionalUnitOrOther: { '#text': unitText, '@xml:lang': 'en' },
          },
        },
        exchanges: { exchange: exchanges },
        administrativeInformation: { 'common:other': 'fixture' },
      },
    },
    exchange_indexes,
  };
}

/**
 * Builds the full anonymized cohort. Processes 1-87 carry the source-proven incorrect `1.0 a`
 * prefix, processes 88-128 carry the already-correct `1 hr` form, and the rest carry a
 * non-time functional unit that is left alone.
 */
export function buildAliasV2CohortInput(): AliasV2PlanInput {
  const flows = Array.from({ length: FLOW_COUNT }, (_, index) => {
    const id = syntheticId('flow', index);
    return { id, version: '00.00.001', json: flowPayload(id) };
  });
  const processes = Array.from({ length: PROCESS_COUNT }, (_, index) => {
    const id = syntheticId('process', index);
    const { exchanges, aliases } = cohortShape(index);
    const unitText =
      index < COHORT_TEXT_ACTION_COUNT
        ? `1.0 a Fixture unit ${index + 1}`
        : index < COHORT_TEXT_ACTION_COUNT + COHORT_CORRECT_UNIT_TEXT_COUNT
          ? `1 hr Fixture unit ${index + 1}`
          : `1 kg Fixture product ${index + 1}`;
    const { json, exchange_indexes } = processPayload(id, index, aliases, exchanges, unitText);
    return {
      id,
      version: '00.00.001',
      json,
      exchange_indexes,
      ...(index < COHORT_TEXT_ACTION_COUNT
        ? { functional_unit: { source_exchange_number: String(10_000 + index) } }
        : {}),
    };
  });
  return {
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    flows,
    processes,
    target_flow_property: {
      id: TARGET_FP,
      version: '01.00.000',
      // The real snapshot schema: the plural information node, the name at
      // dataSetInformation["common:name"] as a language object, and the unit group reference at
      // quantitativeReference.referenceToReferenceUnitGroup.
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: {
              'common:name': { '#text': 'Time', '@xml:lang': 'en' },
            },
            quantitativeReference: {
              referenceToReferenceUnitGroup: {
                '@type': 'unit group data set',
                '@refObjectId': TARGET_UG,
                '@version': '01.00.000',
              },
            },
          },
        },
      },
    },
    target_unit_group: {
      id: TARGET_UG,
      version: '01.00.000',
      json: {
        unitGroupDataSet: {
          units: {
            unit: [
              { name: 'a', meanValue: '1' },
              { name: 'hr', meanValue: '1' },
            ],
          },
        },
      },
    },
    source_unit_group: {
      id: SOURCE_UG,
      version: '00.00.001',
      json: { unitGroupDataSet: { units: { unit: [{ name: 'hr', meanValue: '1' }] } } },
    },
    source_evidence_sha256: 'a1b2c3d4'.repeat(8),
  };
}
