// Deterministic, anonymized cohort fixture for the reviewed Time alias v2 plan.
//
// The fixture reproduces the *shape* of the current source-proven cohort — 113 flows, 274
// processes, 654 alias exchange occurrences and 4 147 unrelated exchanges across those
// processes, with 87 source-proven incorrect functional-unit prefixes — using synthetic
// datasets only: generated identifiers, generated amounts chosen from the reviewed exponent and
// plain spellings, and no source payload, account, comment or provenance content whatsoever.
// Its purpose is to make the frozen cohort counts and the per-action invariants testable at
// full scale, and to give the storage-side owner the same generated fixture to check against.

import { sha256Json } from '../../src/lib/dataset-maintenance-contract.js';
import { aliasV2CohortSha256, type AliasV2PlanInput } from '../../src/lib/dataset-alias-v2-plan.js';

type JsonObject = Record<string, unknown>;

/**
 * The frozen cohort counts the current source-proven plan must derive: the real v1 ten flat
 * expected keys with v2 values, plus the versioned functional-unit text-action count.
 */
export const COHORT_COUNTS = {
  action_count: 387,
  batch_count: 1,
  exchange_count: 654,
  amount_field_count: 1308,
  unrelated_exchange_count: 4147,
  audit_count: 389,
  flowproperty_count: 0,
  flow_count: 113,
  process_count: 274,
  derivative_target_count: 387,
  text_action_count: 87,
} as const;

/** Source-proven functional-unit corrections, and the correct forms that stay untouched. */
export const COHORT_TEXT_ACTION_COUNT = COHORT_COUNTS.text_action_count;
export const COHORT_CORRECT_UNIT_TEXT_COUNT = 41;

const FLOW_COUNT = COHORT_COUNTS.flow_count;
const PROCESS_COUNT = COHORT_COUNTS.process_count;
const SOURCE_FP = 'bd69e542-6a50-524c-8d04-195b1ec23150';
const TARGET_FP = 'da11d28f-4db8-51eb-b3a9-8784b26771e6';
/**
 * The orphan hour unit group: an old `hr`-based record that survives in the account. It is
 * historical provenance for the ORIGINAL source unit, and nothing is made to reference it.
 */
const ORPHAN_HOUR_UG = 'aeddc8ee-da6f-5181-9a99-73466e198b86';
const TARGET_UG = '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb';

/** The synthetic reviewed-evidence record the frozen source-evidence digest binds. */
const REVIEWED_SOURCE_EVIDENCE = {
  schema_version: 'alias-v2-reviewed-source-evidence.fixture.v1',
  campaign_id: 'fixture-campaign',
  source_archive_sha256: 'a1b2c3d4'.repeat(8),
  orphan_hour_unit_group_id: ORPHAN_HOUR_UG,
  // The original physical unit the campaign proves for the before amounts. Some before values are
  // exponent spellings of it; the unit group the source alias declares TODAY is the year-based
  // table below, and it is never read as proof that the amounts are already in the original unit.
  original_source_unit: 'hr',
} as const;

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
  // The reviewed campaign relationship: the functional unit's reference exchange IS one of the
  // selected alias occurrences, so the selection starts at the reference (internal id "1" at
  // position 0) and covers the alias inputs that follow it.
  const exchange_indexes = Array.from({ length: aliases }, (_, offset) => offset);
  const exchanges: JsonObject[] = [];
  for (let position = 0; position < exchangeCount; position += 1) {
    const isAlias = position < aliases;
    const spelling = AMOUNT_SPELLINGS[
      (index * 7 + position * 3) % AMOUNT_SPELLINGS.length
    ] as string;
    const isReference = position === 0;
    const sourceNumber = 730_000 + index;
    const exchange: JsonObject = {
      '@dataSetInternalID': String(position + 1),
      meanAmount: isReference ? '1.0' : isAlias ? spelling : '1',
      resultingAmount: isReference ? '1.0' : isAlias ? spelling : '1',
      // The reference exchange is the produced one-hour output at quantity 1.0; the alias
      // occurrences are separate, exponent-valued inputs.
      exchangeDirection: isReference ? 'Output' : position % 2 === 0 ? 'Input' : 'Output',
      dataDerivationTypeStatus: 'Unknown derivation',
      uncertaintyDistributionType: UNCERTAINTY_TYPES[(index + position) % 2] as string,
      referenceToFlowDataSet: {
        '@type': 'flow data set',
        '@refObjectId': isAlias
          ? syntheticId('flow', (index * 31 + position) % FLOW_COUNT)
          : syntheticId('flow', FLOW_COUNT + (index % 5)),
        '@version': '00.00.001',
      },
      generalComment: isReference
        ? {
            '#text': `Source EcoSpold1 exchange number: ${sourceNumber}.`,
            '@xml:lang': 'en',
          }
        : {
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
        ? { functional_unit: { source_exchange_number: String(730_000 + index) } }
        : {}),
    };
  });
  return {
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    source_alias: { id: SOURCE_FP, version: '00.00.001' },
    // The complete locked SOURCE flow property: the reviewed alias identity, its own payload, and
    // its current declaration of the (year-based) source unit group the before amounts are read in.
    source_flow_property: {
      id: SOURCE_FP,
      version: '00.00.001',
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: {
              'common:name': { '#text': 'Amount in hr', '@xml:lang': 'en' },
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
          // The real canonical shape: the base unit is selected by the reference's internal id,
          unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: '1' } },
          units: {
            // The real "Units of time" table: the year base unit at factor 1 and the fixed hour
            // factor. A fixture with hr = 1 is not a target and is refused by the plan builder.
            unit: [
              { '@dataSetInternalID': '1', name: 'a', meanValue: '1.0' },
              { '@dataSetInternalID': '2', name: 'hr', meanValue: '0.00011415525114155251' },
            ],
          },
        },
      },
    },
    // The unit group the source alias's flow property declares TODAY: the same locked year-based
    // "Units of time" table the target uses, whose base unit is the year. The orphan hour record
    // above is not this pointer.
    declared_source_unit_group: {
      id: TARGET_UG,
      version: '01.00.000',
      json: {
        unitGroupDataSet: {
          // The real canonical shape: the base unit is selected by the reference's internal id,
          unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: '1' } },
          units: {
            unit: [
              { '@dataSetInternalID': '1', name: 'a', meanValue: '1.0' },
              { '@dataSetInternalID': '2', name: 'hr', meanValue: '0.00011415525114155251' },
            ],
          },
        },
      },
    },
    source_evidence: {
      // The digest of the reviewed evidence artefact the campaign holds, computed from the
      // synthetic record above. The Database side can bind this identity; it cannot read the
      // original archive, and this fixture does not claim it did. The cohort digest is computed
      // from this very cohort through the shared definition, so the builder's recomputation can
      // only agree with the real tuple set.
      sha256: sha256Json(REVIEWED_SOURCE_EVIDENCE),
      cohort_sha256: aliasV2CohortSha256({
        actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
        source_alias: { id: SOURCE_FP, version: '00.00.001' },
        flows,
        processes,
        target_flow_property: {} as never,
        target_unit_group: {} as never,
        declared_source_unit_group: {} as never,
        source_flow_property: {} as never,
        source_evidence: {
          sha256: sha256Json(REVIEWED_SOURCE_EVIDENCE),
          cohort_sha256: '',
          original_source_unit: REVIEWED_SOURCE_EVIDENCE.original_source_unit,
        },
      }),
      original_source_unit: REVIEWED_SOURCE_EVIDENCE.original_source_unit,
    },
  };
}
