import assert from 'node:assert/strict';
import test from 'node:test';
import { isJsonObject, sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_BATCH_SCHEMA,
  ALIAS_V2_EXCHANGE_KEYS,
  ALIAS_V2_FACTOR,
  ALIAS_V2_PLAN_SCHEMA,
  ALIAS_V2_REFERENCE_SHAPE_INVALID,
  ALIAS_V2_TARGET_SHAPE_INVALID,
  aliasV2CohortSha256,
  aliasV2TargetFlowPropertyReference,
  assertCanonicalFlowPropertyReference,
  buildAliasV2Plan,
  type AliasV2PlanInput,
} from '../src/lib/dataset-alias-v2-plan.js';

type JsonObject = Record<string, unknown>;

const SOURCE_FP = 'bd69e542-6a50-524c-8d04-195b1ec23150';
const TARGET_FP = 'da11d28f-4db8-51eb-b3a9-8784b26771e6';
const TARGET_UG = '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb';
const SOURCE_UG = 'aeddc8ee-da6f-5181-9a99-73466e198b86';
const SOURCE_EVIDENCE = 'e'.repeat(64);

const TARGET_REFERENCE: JsonObject = {
  '@type': 'flow property data set',
  '@refObjectId': TARGET_FP,
  '@version': '01.00.000',
  '@uri': `../flowproperties/${TARGET_FP}.json`,
  'common:shortDescription': { '#text': 'Time', '@xml:lang': 'en' },
};

function propertyEntry(overrides: JsonObject = {}): JsonObject {
  return {
    '@dataSetInternalID': '1',
    meanValue: '1',
    referenceToFlowPropertyDataSet: {
      '@type': 'flow property data set',
      '@refObjectId': SOURCE_FP,
      '@version': '00.00.001',
      '@uri': `../flowproperties/${SOURCE_FP}.json`,
      'common:shortDescription': { '#text': 'Amount in hr', '@xml:lang': 'en' },
    },
    ...overrides,
  };
}

function flow(id: string, propertyEntries: JsonObject[] = [propertyEntry()]): JsonObject {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: { 'common:UUID': id },
        quantitativeReference: { referenceToReferenceFlowProperty: '1' },
      },
      flowProperties: { flowProperty: propertyEntries },
      modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
      administrativeInformation: { marker: 'unchanged' },
    },
  };
}

function exchange(internalId: string, overrides: JsonObject = {}, alias = true): JsonObject {
  return {
    '@dataSetInternalID': internalId,
    meanAmount: '1',
    resultingAmount: '1',
    exchangeDirection: 'Input',
    dataDerivationTypeStatus: 'Unknown derivation',
    uncertaintyDistributionType: 'log-normal',
    referenceToFlowDataSet: {
      '@type': 'flow data set',
      '@refObjectId': alias ? 'flow-a' : 'flow-unrelated',
      '@version': '00.00.001',
      'common:shortDescription': { '#text': 'Use, computer', '@xml:lang': 'en' },
    },
    generalComment: { '#text': 'Source EcoSpold1 exchange number: 1.', '@xml:lang': 'en' },
    ...overrides,
  };
}

function process(id: string, exchanges: JsonObject[], unitText = '1 kg Product'): JsonObject {
  return {
    processDataSet: {
      processInformation: {
        quantitativeReference: {
          referenceToReferenceFlow: '1',
          functionalUnitOrOther: { '#text': unitText, '@xml:lang': 'en' },
        },
        dataSetInformation: { 'common:UUID': id },
      },
      exchanges: { exchange: exchanges },
      administrativeInformation: { marker: 'unchanged' },
    },
  };
}

function input(overrides: Partial<AliasV2PlanInput> = {}): AliasV2PlanInput {
  const base: AliasV2PlanInput = {
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    flows: [
      { id: 'flow-a', version: '00.00.001', json: flow('flow-a') },
      { id: 'flow-b', version: '00.00.001', json: flow('flow-b') },
    ],
    processes: [
      {
        id: 'process-a',
        version: '00.00.001',
        exchange_indexes: [0],
        json: process('process-a', [exchange('1'), exchange('2', {}, false)]),
      },
      {
        id: 'process-b',
        version: '00.00.001',
        exchange_indexes: [1],
        functional_unit: { source_exchange_number: '730045' },
        json: process(
          'process-b',
          [
            exchange(
              '1',
              {
                generalComment: {
                  '#text': 'Source EcoSpold1 exchange number: 730045.',
                  '@xml:lang': 'en',
                },
                meanAmount: '1.0',
                resultingAmount: '1.0',
              },
              false,
            ),
            exchange('2', {
              generalComment: {
                '#text': 'Source EcoSpold1 exchange number: 730046.',
                '@xml:lang': 'en',
              },
              meanAmount: '1.03E-4',
              resultingAmount: '1.03E-4',
            }),
          ],
          '1.0 a Use, computer, office use',
        ),
      },
    ],
    target_flow_property: {
      id: TARGET_FP,
      version: '01.00.000',
      // The real snapshot schema: plural information node, name at dataSetInformation["common:name"],
      // unit group reference at quantitativeReference.referenceToReferenceUnitGroup.
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: { 'common:name': { '#text': 'Time', '@xml:lang': 'en' } },
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
              { '@dataSetInternalID': '1', name: 'a', meanValue: '1' },
              { '@dataSetInternalID': '2', name: 'hr', meanValue: ALIAS_V2_FACTOR },
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
    source_alias: { id: SOURCE_FP, version: '00.00.001' },
    source_evidence: { sha256: SOURCE_EVIDENCE, cohort_sha256: '' },
    ...overrides,
  };
  // The evidence document binds this exact cohort: the fixture computes it from the cohort the
  // builder will see, through the same shared definition the builder recomputes with.
  return {
    ...base,
    source_evidence:
      isJsonObject(base.source_evidence) &&
      base.source_evidence['cohort_sha256'] === '' &&
      base.source_evidence['sha256'] === SOURCE_EVIDENCE
        ? { ...base.source_evidence, cohort_sha256: aliasV2CohortSha256(base) }
        : base.source_evidence,
  };
}

function singleFlow(json: JsonObject): Partial<AliasV2PlanInput> {
  return { flows: [{ id: 'flow-a', version: '00.00.001', json }] };
}

function singleProcess(
  json: JsonObject,
  extra: Partial<AliasV2PlanInput['processes'][number]> = {},
): Partial<AliasV2PlanInput> {
  return {
    processes: [{ id: 'process-a', version: '00.00.001', exchange_indexes: [0], json, ...extra }],
  };
}

function rejects(overrides: Partial<AliasV2PlanInput>, code: string): void {
  assert.throws(
    () => buildAliasV2Plan(input(overrides)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === code,
    code,
  );
}

test('the v2 plan derives the exact action, occurrence and invariant counts', () => {
  const { plan, batch } = buildAliasV2Plan(
    input({
      expected_counts: {
        action_count: 4,
        flowproperty_count: 0,
        flow_count: 2,
        process_count: 2,
        exchange_count: 2,
        amount_field_count: 4,
        unrelated_exchange_count: 2,
      },
    }),
  );
  assert.equal(plan.schema_version, ALIAS_V2_PLAN_SCHEMA);
  assert.equal(plan.target_visibility, 'owner_draft');
  assert.deepEqual(plan.counts, {
    action_count: 4,
    flowproperty_count: 0,
    flow_count: 2,
    process_count: 2,
    exchange_count: 2,
    amount_field_count: 4,
    unrelated_exchange_count: 2,
  });
  assert.equal(plan.plan_sha256, sha256Json({ ...plan, plan_sha256: undefined }));
  assert.equal(batch.schema_version, ALIAS_V2_BATCH_SCHEMA);
  assert.equal(batch.plan_sha256, plan.plan_sha256);
  assert.equal((batch.actions as unknown[]).length, 4);
  assert.equal((batch.counts as JsonObject).exchange_count, 2);

  // Flow actions: only the property reference changes; the quantitative reference id is kept.
  const flowAction = (batch.actions as JsonObject[])[0] as JsonObject;
  const beforeFlow = flowAction.expected_json_ordered as JsonObject;
  const desiredFlow = flowAction.desired_json_ordered as JsonObject;
  assert.deepEqual(
    (desiredFlow.flowDataSet as JsonObject).flowInformation,
    (beforeFlow.flowDataSet as JsonObject).flowInformation,
  );
  assert.deepEqual(
    ((desiredFlow.flowDataSet as JsonObject).flowProperties as JsonObject).flowProperty,
    [{ ...propertyEntry(), referenceToFlowPropertyDataSet: TARGET_REFERENCE }],
  );
  assert.equal(flowAction.before_sha256, sha256Json(beforeFlow));
  assert.notEqual(flowAction.before_sha256, flowAction.desired_sha256);

  // Process actions: only the listed exchange amounts change.
  const processAction = (batch.actions as JsonObject[])[2] as JsonObject;
  const desiredProcess = processAction.desired_json_ordered as JsonObject;
  const desiredExchanges = ((desiredProcess.processDataSet as JsonObject).exchanges as JsonObject)
    .exchange as JsonObject[];
  assert.equal(desiredExchanges[0]!.meanAmount, ALIAS_V2_FACTOR);
  assert.equal(desiredExchanges[0]!.resultingAmount, ALIAS_V2_FACTOR);
  assert.equal(desiredExchanges[1]!.meanAmount, '1');
  assert.equal(desiredExchanges[1]!.resultingAmount, '1');
  const desiredQuantitative = (
    (desiredProcess.processDataSet as JsonObject).processInformation as JsonObject
  ).quantitativeReference as JsonObject;
  assert.equal(desiredQuantitative.referenceToReferenceFlow, '1');
  assert.deepEqual(desiredQuantitative.functionalUnitOrOther, {
    '#text': '1 kg Product',
    '@xml:lang': 'en',
  });
  // The scaled process carries the exponent amount as its canonical trimmed decimal.
  const textCaseAction = (batch.actions as JsonObject[])[3] as JsonObject;
  const textCaseDesired = textCaseAction.desired_json_ordered as JsonObject;
  assert.equal(
    (
      ((textCaseDesired.processDataSet as JsonObject).exchanges as JsonObject)
        .exchange as JsonObject[]
    )[1]!.meanAmount,
    '0.00000001175799086757990853',
  );
  assert.deepEqual(
    (
      ((textCaseDesired.processDataSet as JsonObject).processInformation as JsonObject)
        .quantitativeReference as JsonObject
    ).functionalUnitOrOther,
    { '#text': '1.0 hr Use, computer, office use', '@xml:lang': 'en' },
  );

  // The functional-unit correction is a first-class, source-proven text action.
  assert.deepEqual((plan.text_actions as JsonObject[])[0], {
    table: 'processes',
    id: 'process-b',
    version: '00.00.001',
    before_text: '1.0 a Use, computer, office use',
    after_text: '1.0 hr Use, computer, office use',
    source_exchange_number: '730045',
  });
  assert.equal(textCaseAction.action_id, 'process:process-b@00.00.001');
  assert.equal(textCaseAction.quantitative_reference, '1');
  assert.deepEqual((textCaseAction.mutation as JsonObject).exchanges, [
    {
      index: 1,
      internal_id: '2',
      flow_id: 'flow-a',
      flow_version: '00.00.001',
      direction: 'Input',
      before_amount: '1.03E-4',
      after_amount: '0.00000001175799086757990853',
      before_resulting_amount: '1.03E-4',
      after_resulting_amount: '0.00000001175799086757990853',
    },
  ]);
  assert.equal(
    ((plan.dimensions as JsonObject[])[0] as JsonObject).factor,
    '0.00011415525114155251',
  );
  assert.equal((plan.source_evidence as JsonObject).exchange_count, 2);
  assert.deepEqual((plan.target_snapshots as JsonObject).flowproperty, {
    id: TARGET_FP,
    version: '01.00.000',
    sha256: sha256Json((input().target_flow_property as { json: JsonObject }).json),
  });
});

test('each payload shape is resolved through its own accessor, never a neighbouring one', () => {
  const invalid = 'ALIAS_V2_PLAN_INVALID';
  // A singleton entry is the same shape as a one-element array, and a missing node is not a
  // malformed one: both must resolve through the same accessor without borrowing another root.
  const singleton = buildAliasV2Plan(
    input({
      flows: [
        {
          id: 'flow-a',
          version: '00.00.001',
          json: {
            flowDataSet: {
              modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
              flowProperties: { flowProperty: propertyEntry() },
            },
          },
        },
      ],
      processes: [
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [0],
          json: {
            processDataSet: {
              processInformation: { quantitativeReference: { referenceToReferenceFlow: '1' } },
              exchanges: { exchange: exchange('1') },
            },
          },
        },
      ],
    }),
  );
  assert.equal((singleton.plan.counts as JsonObject).action_count, 2);
  // An exchange reference without object id or version stays an explicit null rather than
  // borrowing the process or flow identity.
  const partial = buildAliasV2Plan(
    input({
      processes: [
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [1],
          json: process('process-a', [exchange('1', {}, false), exchange('2')]),
        },
      ],
    }),
  );
  assert.deepEqual(
    (
      (
        (partial.batch.actions as JsonObject[]).find(
          (action) => action.table === 'processes',
        ) as JsonObject
      ).mutation as JsonObject
    ).exchanges,
    [
      {
        index: 1,
        internal_id: '2',
        flow_id: 'flow-a',
        flow_version: '00.00.001',
        direction: 'Input',
        before_amount: '1',
        after_amount: '0.00011415525114155251',
        before_resulting_amount: '1',
        after_resulting_amount: '0.00011415525114155251',
      },
    ],
  );
  // Malformed roots on either family are refused instead of being read with the other root.
  rejects(singleFlow({}), invalid);
  rejects(
    singleFlow({
      flowDataSet: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
      },
    }),
    invalid,
  );
  rejects(
    singleFlow({
      flowDataSet: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
        flowProperties: 'nope',
      },
    }),
    invalid,
  );
  rejects(
    singleFlow({
      flowDataSet: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
        flowProperties: { flowProperty: 'nope' },
      },
    }),
    invalid,
  );
  rejects(
    singleFlow({
      flowDataSet: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } },
        flowProperties: { flowProperty: [1] },
      },
    }),
    invalid,
  );
  rejects(singleFlow({ flowDataSet: [] }), invalid);
  rejects(singleFlow({ flowDataSet: { flowProperties: null } }), invalid);
  rejects(singleFlow({ flowDataSet: { flowProperties: 'nope' } }), invalid);
  rejects(singleFlow({ flowDataSet: { flowProperties: { flowProperty: [1] } } }), invalid);
  rejects(singleProcess({}), invalid);
  rejects(singleProcess({ processDataSet: [] }), invalid);
  rejects(singleProcess({ processDataSet: { exchanges: { exchange: [1] } } }), invalid);
  rejects(singleProcess({ processDataSet: { exchanges: { exchange: [exchange('1')] } } }), invalid);
  rejects(
    singleProcess({
      processDataSet: { processInformation: 'nope', exchanges: { exchange: [exchange('1')] } },
    }),
    invalid,
  );
  rejects(
    singleProcess({
      processDataSet: {
        processInformation: { quantitativeReference: 'nope' },
        exchanges: { exchange: [exchange('1')] },
      },
    }),
    invalid,
  );
  rejects(
    singleProcess({
      processDataSet: {
        processInformation: { quantitativeReference: { referenceToReferenceFlow: '1' } },
        exchanges: { exchange: 'nope' },
      },
    }),
    invalid,
  );
  // A source-proven text action needs a functional-unit text node, and that node needs a text.
  rejects(
    singleProcess(process('process-a', [exchange('1')], ''), {
      functional_unit: { source_exchange_number: '1' },
    }).processes !== undefined
      ? {
          processes: [
            {
              id: 'process-a',
              version: '00.00.001',
              exchange_indexes: [0],
              functional_unit: { source_exchange_number: '1' },
              json: {
                processDataSet: {
                  processInformation: { quantitativeReference: { referenceToReferenceFlow: '1' } },
                  exchanges: { exchange: [exchange('1')] },
                },
              },
            },
          ],
        }
      : {},
    'ALIAS_V2_TEXT_RULE_VIOLATION',
  );
  rejects(
    {
      processes: [
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [0],
          functional_unit: { source_exchange_number: '1' },
          json: {
            processDataSet: {
              processInformation: {
                quantitativeReference: {
                  referenceToReferenceFlow: '1',
                  functionalUnitOrOther: { '@xml:lang': 'en' },
                },
              },
              exchanges: { exchange: [exchange('1')] },
            },
          },
        },
      ],
    },
    'ALIAS_V2_TEXT_RULE_VIOLATION',
  );
});

test('the v2 plan refuses anything outside the reviewed shape', () => {
  const invalid = 'ALIAS_V2_PLAN_INVALID';
  assert.throws(
    () => buildAliasV2Plan({ ...input(), actor_id: undefined as unknown as string }),
    invalid,
  );
  rejects({ flows: [] }, invalid);
  rejects({ processes: [] }, invalid);
  rejects({ source_evidence: { sha256: 'nope', cohort_sha256: 'a'.repeat(64) } }, invalid);
  rejects({ source_evidence: { sha256: 'a'.repeat(64), cohort_sha256: 'nope' } }, invalid);
  rejects(
    { source_evidence: undefined as unknown as { sha256: string; cohort_sha256: string } },
    invalid,
  );
  // The target reference is a projection of the locked snapshot, so a snapshot that does not
  // carry the real schema — the plural information node, the language-tagged common:name at
  // dataSetInformation, and the unit group reference — is refused rather than projected from an
  // assumed path. The Process name shape is deliberately not accepted here.
  const targetShapeInvalid = ALIAS_V2_TARGET_SHAPE_INVALID;
  const targetSnapshot = (json: JsonObject): Partial<AliasV2PlanInput> => ({
    target_flow_property: { id: TARGET_FP, version: '01.00.000', json },
  });
  const realTarget = (): JsonObject =>
    JSON.parse(JSON.stringify(input().target_flow_property.json)) as JsonObject;
  const withInformation = (
    mutate: (information: JsonObject) => void,
  ): Partial<AliasV2PlanInput> => {
    const json = realTarget();
    const information = (json['flowPropertyDataSet'] as JsonObject)[
      'flowPropertiesInformation'
    ] as JsonObject;
    mutate(information);
    return targetSnapshot(json);
  };
  rejects(targetSnapshot({}), targetShapeInvalid);
  rejects(targetSnapshot({ flowPropertyDataSet: {} }), targetShapeInvalid);
  rejects(
    // No data set information node at all: there is nothing to project a name from.
    withInformation((information) => {
      delete information['dataSetInformation'];
    }),
    targetShapeInvalid,
  );
  rejects(
    withInformation((information) => {
      information['dataSetInformation'] = 'nope';
    }),
    targetShapeInvalid,
  );
  rejects(
    // The singular spelling is a path the data does not have.
    targetSnapshot({ flowPropertyDataSet: { flowPropertyInformation: {} } }),
    targetShapeInvalid,
  );
  rejects(
    withInformation((information) => {
      information['dataSetInformation'] = {
        'common:shortDescription': { '#text': 'Time', '@xml:lang': 'en' },
      };
    }),
    targetShapeInvalid,
  );
  rejects(
    // The Process-style name path is not this data set family's shape.
    withInformation((information) => {
      information['dataSetInformation'] = { name: { baseName: [{ '#text': 'Time' }] } };
    }),
    targetShapeInvalid,
  );
  for (const name of [
    [{ '#text': 'Time', '@xml:lang': 'en' }],
    'Time',
    { '#text': 'Time' },
    { '@xml:lang': 'en' },
    { '#text': '', '@xml:lang': 'en' },
    { '#text': 'Time', '@xml:lang': '' },
  ]) {
    rejects(
      withInformation((information) => {
        information['dataSetInformation'] = { 'common:name': name };
      }),
      targetShapeInvalid,
    );
  }
  rejects(
    withInformation((information) => {
      delete information['quantitativeReference'];
    }),
    targetShapeInvalid,
  );
  for (const unitGroup of [
    { '@refObjectId': 'beefbeef-0000-4000-8000-000000000001' },
    { '@refObjectId': TARGET_UG, '@version': '02.00.000' },
  ]) {
    rejects(
      withInformation((information) => {
        information['quantitativeReference'] = { referenceToReferenceUnitGroup: unitGroup };
      }),
      targetShapeInvalid,
    );
  }
  // Duplicate rows, wrong property-entry counts and unreviewed entry values.
  rejects({ flows: [input().flows[0]!, input().flows[0]!] }, invalid);
  rejects(singleFlow(flow('flow-a', [propertyEntry(), propertyEntry()])), invalid);
  rejects(singleFlow(flow('flow-a', [])), invalid);
  rejects(singleFlow(flow('flow-a', [propertyEntry({ '@dataSetInternalID': '2' })])), invalid);
  rejects(singleFlow(flow('flow-a', [propertyEntry({ meanValue: '2' })])), invalid);
  rejects(singleFlow({ flowDataSet: { flowProperties: { flowProperty: 'nope' } } }), invalid);
  rejects(singleFlow({ flowDataSet: { flowProperties: { flowProperty: [1] } } }), invalid);
  rejects(
    singleFlow(
      flow('flow-a', [
        propertyEntry({
          referenceToFlowPropertyDataSet: { '@refObjectId': TARGET_FP, '@version': '01.00.000' },
        }),
      ]),
    ),
    invalid,
  );
  // Process payload shapes.
  rejects(
    singleProcess({ processDataSet: { processInformation: {}, administrativeInformation: {} } }),
    invalid,
  );
  rejects(
    singleProcess({
      processDataSet: {
        processInformation: { quantitativeReference: { referenceToReferenceFlow: '1' } },
        exchanges: { exchange: {} },
      },
    }),
    invalid,
  );
  for (const exchange_indexes of [[], [5], [-1], [0, 0], ['0' as unknown as number]]) {
    rejects(
      {
        processes: [
          {
            id: 'process-a',
            version: '00.00.001',
            exchange_indexes,
            json: process('process-a', [exchange('1')]),
          },
        ],
      },
      invalid,
    );
  }
  rejects(singleProcess(process('process-a', [exchange('1', { meanAmount: 1 })])), invalid);
  // An occurrence without any alias flow reference is not an occurrence at all: it can neither
  // be declared as one nor be rescaled by guesswork.
  rejects(
    singleProcess(
      process('process-a', [
        exchange('1', { referenceToFlowDataSet: undefined as unknown as JsonObject }),
      ]),
    ),
    invalid,
  );
  rejects(
    singleProcess(
      process('process-a', [
        exchange('1', { referenceToFlowDataSet: undefined as unknown as JsonObject }),
      ]),
    ),
    invalid,
  );
});

/** Every leaf path at which two JSON payloads differ, in a stable order. */
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

test('each action changes exactly the reviewed paths and nothing else', () => {
  const { batch } = buildAliasV2Plan(input());
  const actions = batch.actions as JsonObject[];
  // Flow: only the property entry's reference is retargeted; the quantitative reference, which
  // carries the internal id the reviewed rule preserves, is untouched.
  const referencePath = 'flowDataSet.flowProperties.flowProperty.0.referenceToFlowPropertyDataSet';
  assert.deepEqual(
    changedPaths(actions[0]!.expected_json_ordered, actions[0]!.desired_json_ordered).sort(),
    [
      `${referencePath}.@refObjectId`,
      `${referencePath}.@uri`,
      `${referencePath}.@version`,
      `${referencePath}.common:shortDescription.#text`,
    ],
  );
  // Process: exactly the two amount fields of the named occurrence.
  assert.deepEqual(
    changedPaths(actions[2]!.expected_json_ordered, actions[2]!.desired_json_ordered).sort(),
    [
      'processDataSet.exchanges.exchange.0.meanAmount',
      'processDataSet.exchanges.exchange.0.resultingAmount',
    ],
  );
  // Process with the functional-unit correction: the same two fields plus the unit text.
  assert.deepEqual(
    changedPaths(actions[3]!.expected_json_ordered, actions[3]!.desired_json_ordered).sort(),
    [
      'processDataSet.exchanges.exchange.1.meanAmount',
      'processDataSet.exchanges.exchange.1.resultingAmount',
      'processDataSet.processInformation.quantitativeReference.functionalUnitOrOther.#text',
    ],
  );
  // The unrelated exchange of each process is byte-identical in both images, which is the
  // invariant the whole plan is checked against.
  const desiredExchanges = (
    (actions[2]!.desired_json_ordered as JsonObject).processDataSet as JsonObject
  ).exchanges as JsonObject;
  const beforeExchanges = (
    (actions[2]!.expected_json_ordered as JsonObject).processDataSet as JsonObject
  ).exchanges as JsonObject;
  assert.equal(
    sha256Json((desiredExchanges.exchange as JsonObject[])[1]),
    sha256Json((beforeExchanges.exchange as JsonObject[])[1]),
  );
});

test('unreviewed exchange fields and functional-unit forms fail closed with their own codes', () => {
  for (const field of ['standardDeviation95', 'meanValue', 'otherAbsolute']) {
    rejects(
      singleProcess(process('process-a', [exchange('1', { [field]: '1.32' })])),
      'ALIAS_V2_UNCERTAINTY_UNSUPPORTED',
    );
  }
  const textCase = (unitText: string, functionalUnit?: JsonObject) =>
    singleProcess(
      process(
        'process-b',
        [exchange('1', {}, false), exchange('2', { meanAmount: '2' })],
        unitText,
      ),
      functionalUnit === undefined
        ? { exchange_indexes: [1] }
        : {
            exchange_indexes: [1],
            functional_unit: functionalUnit as { source_exchange_number: string },
          },
    );
  // A source-proven action must carry exactly the reviewed incorrect prefix.
  rejects(textCase('1.0 hr x', { source_exchange_number: '1' }), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  rejects(textCase('2.0 a x', { source_exchange_number: '1' }), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  rejects(textCase('1 a', { source_exchange_number: '1' }), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  rejects(textCase('1 kg x', { source_exchange_number: '1' }), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  rejects(textCase('1.0 a x', { source_exchange_number: ' ' }), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  // The reviewed incorrect prefix without its source proof is never left silently in place.
  rejects(textCase('1.0 a x'), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  rejects(textCase('1 a x'), 'ALIAS_V2_TEXT_RULE_VIOLATION');
  // The reviewed forms are accepted and produce exactly one text action each.
  for (const [text, expectedAfter] of [
    ['1.0 a Use, printer', '1.0 hr Use, printer'],
    ['1 a  Use, printer', '1 hr  Use, printer'],
  ] as const) {
    const { plan } = buildAliasV2Plan(input(textCase(text, { source_exchange_number: '1' })));
    assert.equal((plan.text_actions as JsonObject[]).length, 1);
    assert.equal((plan.text_actions as JsonObject[])[0]!.after_text, expectedAfter);
  }
  // Neither `mean` nor `resulting` uncertainty fields are absolute amounts.
  assert.equal(ALIAS_V2_EXCHANGE_KEYS.includes('relativeStandardDeviation95In'), true);
  assert.equal(ALIAS_V2_EXCHANGE_KEYS.includes('uncertaintyDistributionType'), true);
});

test('the target reference is projected from the locked snapshot, never carried in', () => {
  const target = input().target_flow_property;
  const unitGroup = input().target_unit_group;
  const projected = aliasV2TargetFlowPropertyReference(target, unitGroup);
  // Exactly the five canonical keys, and the description is the target's own language object.
  assert.deepEqual(projected, TARGET_REFERENCE);
  assert.deepEqual(projected['common:shortDescription'], {
    '#text': 'Time',
    '@xml:lang': 'en',
  });
  // Nothing else from the name object is projected into the reference.
  const loose = aliasV2TargetFlowPropertyReference(
    {
      ...target,
      json: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: {
              'common:name': { '#text': 'Time', '@xml:lang': 'en', '@extra': 'x' },
            },
            quantitativeReference: {
              referenceToReferenceUnitGroup: { '@refObjectId': TARGET_UG },
            },
          },
        },
      },
    },
    unitGroup,
  );
  assert.deepEqual(Object.keys(loose['common:shortDescription'] as JsonObject).sort(), [
    '#text',
    '@xml:lang',
  ]);
  // A unit group reference without a version is accepted; the identity is what binds it.
  assert.equal(loose['@version'], '01.00.000');
  // The reference identity a caller reads back is the target's own row identity.
  assert.equal(loose['@refObjectId'], target.id);
  assert.equal(loose['@uri'], `../flowproperties/${target.id}.json`);
  // The canonical-shape guard itself refuses every deficient spelling, including the ones a
  // neighbouring data set family would produce.
  const shapeInvalid = ALIAS_V2_REFERENCE_SHAPE_INVALID;
  const deficient: Array<[string, unknown]> = [
    ['not-an-object', null],
    ['not-an-object', 'nope'],
    ['missing-@type', { ...TARGET_REFERENCE, '@type': undefined }],
    ['wrong-@type', { ...TARGET_REFERENCE, '@type': 'unit group data set' }],
    ['wrong-@uri', { ...TARGET_REFERENCE, '@uri': '../flowproperties/other.json' }],
    ['empty-id', { ...TARGET_REFERENCE, '@refObjectId': '' }],
    ['bad-version', { ...TARGET_REFERENCE, '@version': '1.0.0' }],
    ['array-description', { ...TARGET_REFERENCE, 'common:shortDescription': ['Time'] }],
    ['no-lang', { ...TARGET_REFERENCE, 'common:shortDescription': { '#text': 'Time' } }],
    ['no-text', { ...TARGET_REFERENCE, 'common:shortDescription': { '@xml:lang': 'en' } }],
    ['extra-key', { ...TARGET_REFERENCE, extra: 'x' }],
  ];
  for (const [label, value] of deficient) {
    if (label === 'not-an-object') {
      assert.throws(
        () => assertCanonicalFlowPropertyReference(value),
        (error: unknown) => (error as { code?: string }).code === shapeInvalid,
        label,
      );
      continue;
    }
    const candidate = { ...(value as JsonObject) };
    if (label === 'missing-@type') {
      delete candidate['@type'];
    }
    assert.throws(
      () => assertCanonicalFlowPropertyReference(candidate),
      (error: unknown) => (error as { code?: string }).code === shapeInvalid,
      label,
    );
  }
});

test('only the reviewed Product flow kind is eligible, and nothing wider', () => {
  const invalid = 'ALIAS_V2_PLAN_INVALID';
  const flowWith = (mutate: (payload: JsonObject) => void): JsonObject => {
    const payload = flow('flow-a');
    mutate(payload);
    return payload;
  };
  // The reviewed value is accepted (the base fixture already carries it).
  assert.doesNotThrow(() => buildAliasV2Plan(input()));
  // Missing, elementary, waste and non-string values are all refused before any write.
  const cases: Array<[string, (payload: JsonObject) => void]> = [
    [
      'missing modellingAndValidation',
      (payload) => {
        delete (payload['flowDataSet'] as JsonObject)['modellingAndValidation'];
      },
    ],
    [
      'missing LCIMethod',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = {};
      },
    ],
    [
      'missing typeOfDataSet',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = { LCIMethod: {} };
      },
    ],
    [
      'Elementary flow',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = {
          LCIMethod: { typeOfDataSet: 'Elementary flow' },
        };
      },
    ],
    [
      'Waste flow',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = {
          LCIMethod: { typeOfDataSet: 'Waste flow' },
        };
      },
    ],
    [
      'non-string',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = {
          LCIMethod: { typeOfDataSet: 3 },
        };
      },
    ],
    [
      'LCIMethod as array',
      (payload) => {
        (payload['flowDataSet'] as JsonObject)['modellingAndValidation'] = {
          LCIMethod: [{ typeOfDataSet: 'Product flow' }],
        };
      },
    ],
  ];
  for (const [, mutate] of cases) {
    rejects(singleFlow(flowWith(mutate)), invalid);
  }
});

test('the functional-unit binding keeps the two id namespaces apart', () => {
  const violation = 'ALIAS_V2_TEXT_RULE_VIOLATION';
  // The reviewed shape: the quantitative reference names the INTERNAL id "1" (its own output at
  // amount 1.0 with the original source number in its comment), and the alias occurrence is a
  // different exchange with a different internal id and a different original source number.
  const reviewed = (
    overrides: {
      sourceNumber?: string;
      commentNumber?: string;
      referenceAmount?: string;
      aliasAmount?: string;
    } = {},
  ): JsonObject =>
    process(
      'process-b',
      [
        exchange(
          '1',
          {
            exchangeDirection: 'Output',
            meanAmount: overrides.referenceAmount ?? '1.0',
            resultingAmount: overrides.referenceAmount ?? '1.0',
            generalComment: {
              '#text': `Source EcoSpold1 exchange number: ${overrides.commentNumber ?? '730045'}.`,
              '@xml:lang': 'en',
            },
          },
          false,
        ),
        exchange('2', {
          exchangeDirection: 'Input',
          meanAmount: overrides.aliasAmount ?? '1.03E-4',
          resultingAmount: overrides.aliasAmount ?? '1.03E-4',
          generalComment: {
            '#text': 'Source EcoSpold1 exchange number: 730046.',
            '@xml:lang': 'en',
          },
        }),
      ],
      '1.0 a Use, computer, office use',
    );
  const build = (json: JsonObject, sourceNumber = '730045') =>
    buildAliasV2Plan(
      input({
        processes: [
          {
            id: 'process-b',
            version: '00.00.001',
            exchange_indexes: [1],
            functional_unit: { source_exchange_number: sourceNumber },
            json,
          },
        ],
      }),
    );
  // Two different original numbers bind two different exchanges: the reviewed case passes and the
  // internal pointer keeps naming the reference exchange.
  const accepted = build(reviewed());
  const action = (accepted.batch.actions as JsonObject[]).find(
    (entry) => entry['table'] === 'processes',
  ) as JsonObject;
  assert.equal(action['quantitative_reference'], '1');
  assert.deepEqual((action['mutation'] as JsonObject)['exchanges'], [
    {
      index: 1,
      internal_id: '2',
      flow_id: 'flow-a',
      flow_version: '00.00.001',
      direction: 'Input',
      before_amount: '1.03E-4',
      after_amount: '0.00000001175799086757990853',
      before_resulting_amount: '1.03E-4',
      after_resulting_amount: '0.00000001175799086757990853',
    },
  ]);
  assert.equal(
    (
      (
        ((action['desired_json_ordered'] as JsonObject)['processDataSet'] as JsonObject)[
          'processInformation'
        ] as JsonObject
      )['quantitativeReference'] as JsonObject
    )['referenceToReferenceFlow'],
    '1',
  );
  // A reviewed number that the reference exchange's own comment does not carry is refused.
  assert.throws(
    () => build(reviewed(), '730046'),
    (error: unknown) => (error as { code?: string }).code === violation,
  );
  assert.throws(
    () => build(reviewed({ commentNumber: '999999' })),
    (error: unknown) => (error as { code?: string }).code === violation,
  );
  // The functional unit describes the reference exchange's quantity: an amount that is not the
  // reviewed 1/1.0 output cannot carry the correction.
  for (const referenceAmount of ['1.03E-4', '2', '']) {
    assert.throws(
      () => build(reviewed({ referenceAmount })),
      (error: unknown) => (error as { code?: string }).code === violation,
      referenceAmount,
    );
  }
  // The text quantity and the reference amount must agree: a `1.0 a` prefix on an exchange whose
  // amount is not 1/1.0 is exactly the physically impossible case.
  assert.throws(
    () => build(reviewed({ aliasAmount: '1.0', referenceAmount: '1.03E-4' })),
    (error: unknown) => (error as { code?: string }).code === violation,
  );
  // An internal id the payload does not carry cannot resolve the reference exchange.
  assert.throws(
    () =>
      buildAliasV2Plan(
        input({
          processes: [
            {
              id: 'process-b',
              version: '00.00.001',
              exchange_indexes: [1],
              functional_unit: { source_exchange_number: '730045' },
              json: {
                processDataSet: {
                  processInformation: {
                    quantitativeReference: {
                      referenceToReferenceFlow: '9',
                      functionalUnitOrOther: { '#text': '1.0 a x', '@xml:lang': 'en' },
                    },
                  },
                  exchanges: { exchange: [exchange('1', {}, false), exchange('2')] },
                },
              },
            },
          ],
        }),
      ),
    (error: unknown) => (error as { code?: string }).code === violation,
  );
});

test('malformed amounts, incomplete occurrence sets and stale evidence fail closed', () => {
  const invalid = 'ALIAS_V2_PLAN_INVALID';
  const violation = 'ALIAS_V2_TEXT_RULE_VIOLATION';
  const targetShapeInvalid = ALIAS_V2_TARGET_SHAPE_INVALID;
  const single = (
    json: JsonObject,
    extra: Partial<AliasV2PlanInput['processes'][number]> = {},
  ): Partial<AliasV2PlanInput> => ({
    processes: [{ id: 'process-a', version: '00.00.001', exchange_indexes: [0], json, ...extra }],
  });

  // The source alias is the reviewed identity or nothing: a version outside the reviewed form
  // cannot pin the before images this plan rescales.
  rejects({ source_alias: { id: SOURCE_FP, version: '1.0' } }, invalid);

  // The caller's occurrence set must be exactly the set the payload carries. Declaring an
  // exchange that is not an alias occurrence is refused rather than rescaled under this request.
  rejects(
    {
      processes: [
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [0, 1],
          json: process('process-a', [exchange('1'), exchange('2', {}, false)]),
        },
      ],
    },
    invalid,
  );
  // One row, one action: the same process twice is a repeated action, not two actions.
  rejects(
    {
      processes: [
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [0],
          json: process('process-a', [exchange('1')]),
        },
        {
          id: 'process-a',
          version: '00.00.001',
          exchange_indexes: [0],
          json: process('process-a', [exchange('1')]),
        },
      ],
    },
    invalid,
  );
  // A reference whose identity fields are not strings is not an alias occurrence at all.
  for (const referenceToFlowDataSet of [
    { '@refObjectId': 42, '@version': '00.00.001' },
    { '@refObjectId': 'flow-a', '@version': 7 },
  ]) {
    rejects(single(process('process-a', [exchange('1', { referenceToFlowDataSet })])), invalid);
  }
  // An amount outside the reviewed numeric bounds is refused before any desired value exists.
  rejects(
    single(
      process('process-a', [exchange('1', { meanAmount: '1E-31', resultingAmount: '1E-31' })]),
    ),
    invalid,
  );
  // An occurrence whose canonical amount is already the reviewed one carries no change at all:
  // a zero amount is the degenerate case and cannot become an action.
  rejects(
    single(process('process-a', [exchange('1', { meanAmount: '0', resultingAmount: '0' })])),
    invalid,
  );

  // The target unit table is read through one accessor, and every deficient shape is refused.
  const unitGroup = (json: unknown): Partial<AliasV2PlanInput> => ({
    target_unit_group: { id: TARGET_UG, version: '01.00.000', json: json as JsonObject },
  });
  rejects(unitGroup('nope'), targetShapeInvalid);
  rejects(unitGroup({ unitGroupDataSet: { units: { unit: 'nope' } } }), targetShapeInvalid);
  rejects(
    unitGroup({ unitGroupDataSet: { units: { unit: { name: 'a', meanValue: '1' } } } }),
    targetShapeInvalid,
  );
  rejects(
    unitGroup({
      unitGroupDataSet: { units: { unit: [{ name: 'hr', meanValue: ALIAS_V2_FACTOR }] } },
    }),
    targetShapeInvalid,
  );

  // The functional unit resolves its reference exchange by TIDAS internal id, and the id at that
  // position must be the one the quantitative reference names.
  const withReference = (
    referenceToReferenceFlow: string,
    firstInternalId: string,
  ): Partial<AliasV2PlanInput> =>
    single(
      {
        processDataSet: {
          processInformation: {
            quantitativeReference: {
              referenceToReferenceFlow,
              functionalUnitOrOther: { '#text': '1.0 a x', '@xml:lang': 'en' },
            },
          },
          exchanges: {
            exchange: [
              exchange(
                firstInternalId,
                {
                  generalComment: {
                    '#text': 'Source EcoSpold1 exchange number: 730045.',
                    '@xml:lang': 'en',
                  },
                  meanAmount: '1.0',
                  resultingAmount: '1.0',
                },
                false,
              ),
              exchange('2', {
                generalComment: {
                  '#text': 'Source EcoSpold1 exchange number: 730046.',
                  '@xml:lang': 'en',
                },
                meanAmount: '1.03E-4',
                resultingAmount: '1.03E-4',
              }),
            ],
          },
        },
      },
      { exchange_indexes: [1], functional_unit: { source_exchange_number: '730045' } },
    );
  rejects(withReference('not-a-number', '1'), violation);
  rejects(withReference('1', '3'), violation);
  // A comment that is not the language object the payload family uses, or that carries no source
  // number at all, cannot prove the reviewed source exchange.
  for (const generalComment of [
    'Source EcoSpold1 exchange number: 730045.',
    { '#text': 'No source number recorded.', '@xml:lang': 'en' },
  ]) {
    rejects(
      single(
        process('process-a', [
          exchange(
            '1',
            {
              generalComment,
              meanAmount: '1.0',
              resultingAmount: '1.0',
            },
            false,
          ),
          exchange('2'),
        ]),
        { exchange_indexes: [1], functional_unit: { source_exchange_number: '730045' } },
      ),
      violation,
    );
  }

  // Frozen evidence that does not bind this exact before cohort cannot certify the plan.
  rejects({ source_evidence: { sha256: SOURCE_EVIDENCE, cohort_sha256: 'b'.repeat(64) } }, invalid);
  // The derived counts are compared with the frozen ones, never asserted by the caller.
  rejects({ expected_counts: { action_count: 999 } }, 'ALIAS_V2_COUNT_MISMATCH');
});
