import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import {
  runFlowBuildPlanMaterialize,
  runFlowBuildPlanValidate,
  runProcessBuildPlanMaterialize,
  runProcessBuildPlanValidate,
  __testInternals,
} from '../src/lib/process-flow-build-plan.js';
import type { SafeParseSchema } from '../src/lib/tidas-sdk-validation.js';

const now = new Date('2026-05-22T00:00:00.000Z');
const evidenceSourceId = '66666666-6666-6666-6666-666666666666';

const chemicalProductClassification = [
  {
    '@level': '0',
    '@classId': '3',
    '#text': 'Other transportable goods, except metal products, machinery and equipment',
  },
  { '@level': '1', '@classId': '34', '#text': 'Basic chemicals' },
  { '@level': '2', '@classId': '341', '#text': 'Basic organic chemicals' },
  {
    '@level': '3',
    '@classId': '3411',
    '#text': 'Hydrocarbons and their halogenated, sulphonated, nitrated or nitrosated derivatives',
  },
];

const energyProcessClassification = [
  {
    '@level': '0',
    '@classId': 'D',
    '#text': 'Electricity, gas, steam and air conditioning supply',
  },
  {
    '@level': '1',
    '@classId': '35',
    '#text': 'Electricity, gas, steam and air conditioning supply',
  },
  {
    '@level': '2',
    '@classId': '351',
    '#text': 'Electric power generation, transmission and distribution activities',
  },
  {
    '@level': '3',
    '@classId': '3511',
    '#text': 'Electric power generation activities from non-renewable sources',
  },
];

function failingSchema(): SafeParseSchema {
  return {
    safeParse: () => ({
      success: false as const,
      error: {
        issues: [
          {
            path: ['processDataSet', 'processInformation'],
            message: 'Missing process information',
            code: 'custom',
          },
        ],
      },
    }),
  };
}

function processPlan(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    kind: 'process',
    ruleset: {
      id: 'process-authoring/strict',
      version: '1',
    },
    target: {
      geography: 'CN',
      technology_route: 'PV installation',
    },
    classification_path: energyProcessClassification,
    identity_decision: {
      decision: 'create_new',
    },
    evidence_manifest: {
      sources: [{ id: evidenceSourceId, type: 'local-fixture' }],
      field_bindings: [
        { field_path: 'target' },
        { field_path: 'identity_decision.decision' },
        { field_path: 'unit_of_analysis' },
        { field_path: 'name_plan.base_name' },
        { field_path: 'target.geography' },
        { field_path: 'target.technology_route' },
        { field_path: 'quantitative_reference_plan.reference_flow_id' },
      ],
    },
    name_plan: {
      base_name: '3kWp facade installation, multi-Si, laminated, integrated, at building {CN}',
    },
    unit_of_analysis: {
      target_kind: 'countable_installation',
      decision: 'ready_for_materialization',
      functional_unit: {
        what: 'provide installed photovoltaic generation capacity',
        how_much: 'one 3 kWp facade-integrated installation',
        how_well: 'multi-Si laminated facade-integrated photovoltaic technology',
        how_long: 'service lifetime documented in source evidence',
      },
      reference_flow: {
        flow_identity: '3 kWp facade-integrated photovoltaic installation',
        reference_unit: 'unit',
        reference_amount: 1,
        flow_property: 'Number of items',
      },
      scaling_evidence_status: 'not_required_for_fixture',
    },
    quantitative_reference_plan: {
      reference_flow_id: '190f39ca-0ec8-5aab-b2d9-c91fc55ee58d',
      reference_unit: 'unit',
    },
    ...overrides,
  };
}

function flowPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'flow',
    ruleset_id: 'flow-authoring/strict',
    ruleset_version: '1',
    target: {
      flow_type: 'Product flow',
    },
    classificationPath: chemicalProductClassification,
    identityDecision: {
      decision: 'create_new',
    },
    evidenceManifest: {
      sources: [{ id: evidenceSourceId, type: 'local-fixture' }],
      fieldBindings: [
        { fieldPath: 'target' },
        { fieldPath: 'identity_decision.decision' },
        { fieldPath: 'unit_of_analysis' },
        { fieldPath: 'name_plan.base_name' },
        { fieldPath: 'target.flow_type' },
        { fieldPath: 'flow_property_plan.reference_property' },
        { fieldPath: 'flow_property_plan.reference_unit' },
      ],
    },
    namePlan: {
      baseName: 'Fluoroethylene carbonate',
    },
    unitOfAnalysis: {
      targetKind: 'bulk_material',
      decision: 'declared_unit_dataset',
      declaredUnit: {
        amount: 1,
        unit: 'kg',
        basis: 'flow reference property',
      },
      referenceFlow: {
        flowIdentity: 'Fluoroethylene carbonate',
        referenceUnit: 'kg',
        referenceAmount: 1,
        flowProperty: 'Mass',
      },
      scalingEvidenceStatus: 'not_required',
    },
    flowPropertyPlan: {
      referenceProperty: 'mass',
      referenceUnit: 'kg',
    },
    ...overrides,
  };
}

function classificationItemsAt(
  artifact: Record<string, unknown>,
  pathSegments: string[],
): Array<Record<string, unknown>> {
  let current: unknown = artifact;
  for (const segment of pathSegments) {
    assert.equal(typeof current, 'object', `expected ${segment} parent to be an object`);
    assert.notEqual(current, null, `expected ${segment} parent to be present`);
    assert.equal(Array.isArray(current), false, `expected ${segment} parent not to be an array`);
    current = (current as Record<string, unknown>)[segment];
  }
  assert.ok(Array.isArray(current), `expected ${pathSegments.join('.')} to be an array`);
  return current as Array<Record<string, unknown>>;
}

test('process build-plan validate passes and writes a gate report', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'process-build-plan-'));
  try {
    const report = await runProcessBuildPlanValidate({
      inputPath: '/tmp/process-build-plan.json',
      outDir,
      rawInput: processPlan(),
      now,
    });

    assert.equal(report.generated_at_utc, '2026-05-22T00:00:00.000Z');
    assert.equal(report.kind, 'process');
    assert.equal(report.action, 'validate');
    assert.equal(report.status, 'passed');
    assert.equal(report.next_action, 'materialize_payload');
    assert.equal(report.ruleset_id, 'process-authoring/strict');
    assert.equal(report.inputs.plan_schema_version, '1');
    assert.equal(report.inputs.identity_decision, 'create_new');
    assert.equal(report.inputs.unit_of_analysis_decision, 'ready_for_materialization');
    assert.equal(report.required_fields.missing.length, 0);
    assert.equal(
      report.files.materialized_artifact,
      path.join(outDir, 'outputs', 'materialized-process.json'),
    );
    assert.equal(existsSync(path.join(outDir, 'outputs', 'build-plan-gate-report.json')), true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('flow build-plan materialize writes a deterministic canonical flow payload', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'flow-build-plan-'));
  try {
    const report = await runFlowBuildPlanMaterialize({
      inputPath: '/tmp/flow-build-plan.json',
      outDir,
      rawInput: {
        build_plan: flowPlan(),
      },
      now,
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.kind, 'flow');
    assert.equal(report.action, 'materialize');
    assert.equal(report.next_action, 'use_materialized_artifact');
    assert.equal(report.schema_validation.status, 'passed');
    assert.equal(
      report.files.materialized_artifact,
      path.join(outDir, 'outputs', 'materialized-flow.json'),
    );

    const materialized = JSON.parse(
      readFileSync(path.join(outDir, 'outputs', 'materialized-flow.json'), 'utf8'),
    ) as {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            name: { baseName: Array<{ '#text': string }> };
            classificationInformation: {
              'common:classification': { 'common:class': Array<Record<string, string>> };
            };
          };
        };
        modellingAndValidation: { LCIMethod: { typeOfDataSet: string } };
        flowProperties: {
          flowProperty: { referenceToFlowPropertyDataSet: { '@refObjectId': string } };
        };
      };
    };
    assert.equal(
      materialized.flowDataSet.flowInformation.dataSetInformation.name.baseName[0]?.['#text'],
      'Fluoroethylene carbonate',
    );
    assert.equal(
      materialized.flowDataSet.modellingAndValidation.LCIMethod.typeOfDataSet,
      'Product flow',
    );
    assert.equal(
      materialized.flowDataSet.flowProperties.flowProperty.referenceToFlowPropertyDataSet[
        '@refObjectId'
      ],
      '93a60a56-a3c8-11da-a746-0800200b9a66',
    );
    assert.deepEqual(
      materialized.flowDataSet.flowInformation.dataSetInformation.classificationInformation[
        'common:classification'
      ]['common:class'],
      chemicalProductClassification,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('process build-plan materialize builds canonical payloads from name, qref, exchanges, and source evidence', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'process-build-plan-canonical-'));
  try {
    const report = await runProcessBuildPlanMaterialize({
      inputPath: '/tmp/process-build-plan.json',
      outDir,
      rawInput: processPlan({
        target: {
          id: '012fc8f6-9a30-4d98-9b03-34ddec3a6f10',
          version: '01.01.002',
          geography: 'CN-HB',
          technology_route: 'electricity production mix',
          reference_year: '2025',
          classification_path: energyProcessClassification,
        },
        name_plan: {
          base_name: [
            { '#text': 'Electricity, medium voltage, production mix, Hubei', '@xml:lang': 'en' },
            { '#text': '电力，中压，生产组合，湖北', '@xml:lang': 'zh' },
          ],
          treatment_standards_routes: 'production mix',
          mix_and_location_types: 'CN-HB',
          functional_unit_flow_properties: 'MJ',
        },
        quantitative_reference_plan: {
          reference_flow_id: 'd92a1a12-2545-49e2-a585-55c259997756',
          reference_flow_version: '20.20.002',
          reference_flow_name: 'Electricity, medium voltage',
          reference_flow_internal_id: '5',
          mean_amount: '3.6',
          reference_unit: 'MJ',
        },
        exchange_plan: {
          exchanges: [
            {
              internal_id: '6',
              flow_id: '11111111-1111-4111-8111-111111111111',
              version: '01.00.000',
              direction: 'Input',
              mean_amount: '0.42',
            },
          ],
        },
      }),
      now,
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.schema_validation.status, 'passed');

    const materialized = JSON.parse(
      readFileSync(path.join(outDir, 'outputs', 'materialized-process.json'), 'utf8'),
    ) as {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            classificationInformation: {
              'common:classification': { 'common:class': Array<Record<string, string>> };
            };
          };
          quantitativeReference: { referenceToReferenceFlow: string };
        };
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: Array<{ '#text': string; '@xml:lang': string }>;
          };
        };
        exchanges: {
          exchange: Array<{
            '@dataSetInternalID': string;
            meanAmount: string;
            referenceToFlowDataSet: Record<string, unknown>;
          }>;
        };
      };
    };
    assert.equal(
      materialized.processDataSet.processInformation.quantitativeReference.referenceToReferenceFlow,
      '5',
    );
    assert.equal(materialized.processDataSet.exchanges.exchange[0]?.['@dataSetInternalID'], '5');
    assert.equal(materialized.processDataSet.exchanges.exchange[1]?.meanAmount, '0.42');
    assert.deepEqual(
      materialized.processDataSet.exchanges.exchange[1]?.referenceToFlowDataSet[
        'common:shortDescription'
      ],
      { '#text': 'Exchange flow 6', '@xml:lang': 'en' },
    );
    assert.deepEqual(
      materialized.processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness
        .annualSupplyOrProductionVolume,
      [],
      'the 3.6 MJ quantitative reference is a reference amount, not annual-volume evidence',
    );
    assert.deepEqual(
      materialized.processDataSet.processInformation.dataSetInformation.classificationInformation[
        'common:classification'
      ]['common:class'],
      energyProcessClassification,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('build-plan classification materialization is canonical and fail-closed', () => {
  const elementaryFlow = __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      target: { flow_type: 'Elementary flow' },
      classificationPath: [
        { '@level': '0', '@catId': '1', '#text': 'Emissions' },
        { '@level': '1', '@catId': '1.3', '#text': 'Emissions to air' },
      ],
    }),
    '/tmp/elementary-flow-plan.json',
  );
  assert.deepEqual(
    (
      (
        (elementaryFlow.flowDataSet as Record<string, unknown>).flowInformation as Record<
          string,
          unknown
        >
      ).dataSetInformation as Record<string, unknown>
    ).classificationInformation,
    {
      'common:elementaryFlowCategorization': {
        'common:category': [
          { '@level': '0', '@catId': '1', '#text': 'Emissions' },
          { '@level': '1', '@catId': '1.3', '#text': 'Emissions to air' },
        ],
      },
    },
  );
  assert.equal(
    __testInternals.validateMaterializedSchema(elementaryFlow, 'flow', undefined).status,
    'passed',
  );

  assert.throws(
    () =>
      __testInternals.buildCanonicalFlowPayload(
        flowPlan({ classificationPath: undefined }),
        '/tmp/missing-classification-flow-plan.json',
      ),
    /requires classification_path/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalProcessPayload(
        processPlan({ classification_path: undefined }),
        '/tmp/missing-classification-process-plan.json',
      ),
    /requires classification_path/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalFlowPayload(
        flowPlan({ classificationPath: ['Arbitrary label'] }),
        '/tmp/string-classification-flow-plan.json',
      ),
    /canonical object/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalProcessPayload(
        processPlan({ classification_path: [] }),
        '/tmp/empty-classification-process-plan.json',
      ),
    /must not be empty/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalFlowPayload(
        flowPlan({ classificationPath: 'not-an-array' }),
        '/tmp/non-array-classification-flow-plan.json',
      ),
    /must be an array/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalProcessPayload(
        processPlan({
          classification_path: [{ '@level': '1', '@classId': '35', '#text': 'Electricity' }],
        }),
        '/tmp/out-of-order-classification-process-plan.json',
      ),
    /expected @level 0/u,
  );
  assert.throws(
    () =>
      __testInternals.buildCanonicalFlowPayload(
        flowPlan({ classificationPath: [{ '@level': '0', '@classId': '3' }] }),
        '/tmp/incomplete-classification-flow-plan.json',
      ),
    /non-empty #text string/u,
  );

  const spoofedTaxonomy = __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      classificationPath: [
        {
          '@level': '0',
          '@classId': '11111111-1111-4111-8111-111111111111',
          '#text': 'Arbitrary label',
        },
      ],
    }),
    '/tmp/spoofed-classification-flow-plan.json',
  );
  assert.equal(
    __testInternals.validateMaterializedSchema(spoofedTaxonomy, 'flow', undefined).status,
    'failed',
  );

  assert.throws(
    () =>
      __testInternals.buildCanonicalProcessPayload(
        processPlan({
          classification_path: [
            {
              '@level': '0',
              '@classId': 'D',
              '#text': 'Electricity, gas, steam and air conditioning supply',
            },
            {
              '@level': '1',
              '@classId': '01',
              '#text': 'Crop and animal production, hunting and related service activities',
            },
          ],
        }),
        '/tmp/cross-branch-process-classification-plan.json',
      ),
    /not a valid process hierarchy/u,
  );

  for (const flowType of ['Product flow', 'Waste flow']) {
    assert.throws(
      () =>
        __testInternals.buildCanonicalFlowPayload(
          flowPlan({
            target: { flow_type: flowType },
            classificationPath: [
              {
                '@level': '0',
                '@classId': '3',
                '#text':
                  'Other transportable goods, except metal products, machinery and equipment',
              },
              {
                '@level': '1',
                '@classId': '01',
                '#text': 'Products of agriculture, horticulture and market gardening',
              },
            ],
          }),
          `/tmp/cross-branch-${flowType.toLowerCase().replace(' ', '-')}-classification-plan.json`,
        ),
      /not a valid product-flow hierarchy/u,
    );
  }

  assert.throws(
    () =>
      __testInternals.buildCanonicalFlowPayload(
        flowPlan({
          target: { flow_type: 'Elementary flow' },
          classificationPath: [
            { '@level': '0', '@catId': '1', '#text': 'Emissions' },
            { '@level': '1', '@catId': '2.1', '#text': 'Resources from ground' },
          ],
        }),
        '/tmp/cross-branch-elementary-classification-plan.json',
      ),
    /not a valid elementary-flow hierarchy/u,
  );
});

test('process build-plan materialize validates complete embedded payloads with the production schema', async () => {
  const payload = __testInternals.buildCanonicalProcessPayload(
    processPlan(),
    '/tmp/embedded-valid-process-plan.json',
  );
  const report = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: processPlan({
      payload,
    }),
    now,
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.schema_validation.status, 'passed');
  assert.equal(report.schema_validation.validator, '@tiangong-lca/tidas-sdk/ProcessSchema');
});

test('embedded canonical payload validation rejects cross-branch classification hierarchies', async () => {
  const processPayload = __testInternals.buildCanonicalProcessPayload(
    processPlan(),
    '/tmp/embedded-process-plan.json',
  );
  assert.equal(
    __testInternals.validateMaterializedSchema(processPayload, 'process', undefined).status,
    'passed',
  );
  classificationItemsAt(processPayload, [
    'processDataSet',
    'processInformation',
    'dataSetInformation',
    'classificationInformation',
    'common:classification',
    'common:class',
  ])[1] = {
    '@level': '1',
    '@classId': '01',
    '#text': 'Crop and animal production, hunting and related service activities',
  };
  const invalidProcess = __testInternals.validateMaterializedSchema(
    processPayload,
    'process',
    undefined,
  );
  assert.equal(invalidProcess.status, 'failed');
  assert.equal(invalidProcess.issues[0]?.code, 'classification_hierarchy_error');
  const processReport = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/embedded-cross-branch-process-plan.json',
    rawInput: processPlan({ payload: processPayload }),
    now,
  });
  assert.equal(processReport.status, 'blocked');
  assert.equal(processReport.next_action, 'fix_build_plan');
  assert.equal(processReport.schema_validation.issues[0]?.code, 'classification_hierarchy_error');

  for (const flowType of ['Product flow', 'Waste flow']) {
    const flowPayload = __testInternals.buildCanonicalFlowPayload(
      flowPlan({ target: { flow_type: flowType } }),
      `/tmp/embedded-${flowType.toLowerCase().replace(' ', '-')}-plan.json`,
    );
    assert.equal(
      __testInternals.validateMaterializedSchema(flowPayload, 'flow', undefined).status,
      'passed',
    );
    classificationItemsAt(flowPayload, [
      'flowDataSet',
      'flowInformation',
      'dataSetInformation',
      'classificationInformation',
      'common:classification',
      'common:class',
    ])[1] = {
      '@level': '1',
      '@classId': '01',
      '#text': 'Products of agriculture, horticulture and market gardening',
    };
    const invalidFlow = __testInternals.validateMaterializedSchema(flowPayload, 'flow', undefined);
    assert.equal(invalidFlow.status, 'failed');
    assert.equal(invalidFlow.issues[0]?.code, 'classification_hierarchy_error');
    const flowReport = await runFlowBuildPlanMaterialize({
      inputPath: `/tmp/embedded-cross-branch-${flowType.toLowerCase().replace(' ', '-')}-plan.json`,
      rawInput: flowPlan({ target: { flow_type: flowType }, payload: flowPayload }),
      now,
    });
    assert.equal(flowReport.status, 'blocked');
    assert.equal(flowReport.next_action, 'fix_build_plan');
    assert.equal(flowReport.schema_validation.issues[0]?.code, 'classification_hierarchy_error');
  }

  const elementaryPayload = __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      target: { flow_type: 'Elementary flow' },
      classificationPath: [
        { '@level': '0', '@catId': '1', '#text': 'Emissions' },
        { '@level': '1', '@catId': '1.3', '#text': 'Emissions to air' },
      ],
    }),
    '/tmp/embedded-elementary-flow-plan.json',
  );
  assert.equal(
    __testInternals.validateMaterializedSchema(elementaryPayload, 'flow', undefined).status,
    'passed',
  );
  classificationItemsAt(elementaryPayload, [
    'flowDataSet',
    'flowInformation',
    'dataSetInformation',
    'classificationInformation',
    'common:elementaryFlowCategorization',
    'common:category',
  ])[1] = {
    '@level': '1',
    '@catId': '2.1',
    '#text': 'Resources from ground',
  };
  const invalidElementary = __testInternals.validateMaterializedSchema(
    elementaryPayload,
    'flow',
    undefined,
  );
  assert.equal(invalidElementary.status, 'failed');
  assert.equal(invalidElementary.issues[0]?.code, 'classification_hierarchy_error');
  const elementaryReport = await runFlowBuildPlanMaterialize({
    inputPath: '/tmp/embedded-cross-branch-elementary-plan.json',
    rawInput: flowPlan({
      target: { flow_type: 'Elementary flow' },
      classificationPath: [
        { '@level': '0', '@catId': '1', '#text': 'Emissions' },
        { '@level': '1', '@catId': '1.3', '#text': 'Emissions to air' },
      ],
      payload: elementaryPayload,
    }),
    now,
  });
  assert.equal(elementaryReport.status, 'blocked');
  assert.equal(elementaryReport.next_action, 'fix_build_plan');
  assert.equal(
    elementaryReport.schema_validation.issues[0]?.code,
    'classification_hierarchy_error',
  );
});

test('build-plan gates block schema failures and mismatched canonical payload kinds', async () => {
  const schemaFailure = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: processPlan({
      payload: {
        processDataSet: {},
      },
    }),
    now,
    schemas: {
      process: failingSchema(),
    },
  });
  assert.equal(schemaFailure.status, 'blocked');
  assert.equal(schemaFailure.schema_validation.status, 'failed');
  assert.equal(
    schemaFailure.schema_validation.issues[0]?.path,
    'processDataSet.processInformation',
  );
  assert.equal(schemaFailure.blockers.at(-1)?.code, 'materialized_schema_failed');

  const kindMismatch = await runFlowBuildPlanMaterialize({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: flowPlan({
      payload: {
        processDataSet: {},
      },
    }),
    now,
  });
  assert.equal(kindMismatch.status, 'blocked');
  assert.equal(kindMismatch.schema_validation.issues[0]?.code, 'dataset_kind_mismatch');
});

test('build-plan validation blocks missing evidence, review decisions, missing fields, and kind mismatch', async () => {
  const report = await runProcessBuildPlanValidate({
    inputPath: '/tmp/process-build-plan.json',
    reportOnly: true,
    rawInput: {
      processBuildPlan: processPlan({
        kind: 'flow',
        target: {},
        identity_decision: {
          decision: 'manual_review',
        },
        evidence_manifest: {
          sources: [],
          field_bindings: [{ field_path: 'target' }],
        },
        name_plan: {},
        quantitative_reference_plan: {},
      }),
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.report_only, true);
  assert.equal(report.next_action, 'fix_build_plan');
  assert.ok(report.blockers.some((finding) => finding.code === 'build_plan_kind_mismatch'));
  assert.ok(report.blockers.some((finding) => finding.code === 'identity_decision_not_automatic'));
  assert.ok(report.blockers.some((finding) => finding.code === 'evidence_sources_missing'));
  assert.ok(
    report.blockers.some((finding) => finding.code === 'build_plan_required_field_missing'),
  );
});

test('build-plan validation blocks unsupported or absent identity decisions', async () => {
  const invalidDecision = await runFlowBuildPlanValidate({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: flowPlan({
      decision: 'unsupported',
      identityDecision: {},
    }),
    now,
  });
  assert.equal(invalidDecision.status, 'blocked');
  assert.ok(
    invalidDecision.blockers.some((finding) => finding.code === 'identity_decision_missing'),
  );

  const absentDecision = await runFlowBuildPlanValidate({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: flowPlan({
      identityDecision: {},
    }),
    now,
  });
  assert.equal(absentDecision.inputs.identity_decision, null);
  assert.ok(
    absentDecision.blockers.some((finding) => finding.code === 'identity_decision_missing'),
  );
});

test('build-plan validation requires a skill-authored unit-of-analysis artifact', async () => {
  const missingArtifactPlan = processPlan() as Record<string, unknown>;
  delete missingArtifactPlan.unit_of_analysis;
  const missingArtifact = await runProcessBuildPlanValidate({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: missingArtifactPlan,
    now,
  });
  assert.equal(missingArtifact.status, 'blocked');
  assert.equal(missingArtifact.inputs.unit_of_analysis_decision, null);
  assert.ok(
    missingArtifact.blockers.some((finding) => finding.code === 'unit_of_analysis_missing'),
  );

  const manualReview = await runProcessBuildPlanValidate({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: processPlan({
      unit_of_analysis: {
        target_kind: 'countable_product',
        decision: 'manual_review',
        functional_unit: {
          what: 'provide display service',
        },
        reference_flow: {
          reference_unit: 'item',
          reference_amount: 1,
          flow_property: 'Number of items',
        },
        scaling_evidence_status: 'source_required',
      },
    }),
    now,
  });
  assert.equal(manualReview.inputs.unit_of_analysis_decision, 'manual_review');
  assert.ok(
    manualReview.blockers.some((finding) => finding.code === 'unit_of_analysis_not_automatic'),
  );

  const incompleteArtifact = await runFlowBuildPlanValidate({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: flowPlan({
      unitOfAnalysis: {
        decision: 'unsupported',
        referenceFlow: {
          referenceUnit: 'kg',
        },
      },
    }),
    now,
  });
  assert.equal(incompleteArtifact.inputs.unit_of_analysis_decision, null);
  assert.ok(
    incompleteArtifact.blockers.some(
      (finding) => finding.code === 'unit_of_analysis_decision_missing',
    ),
  );
  assert.ok(
    incompleteArtifact.blockers.some(
      (finding) => finding.code === 'unit_of_analysis_required_field_missing',
    ),
  );
  assert.ok(
    incompleteArtifact.blockers.some(
      (finding) => finding.code === 'unit_of_analysis_basis_missing',
    ),
  );

  const missingScalingEvidence = await runProcessBuildPlanValidate({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: processPlan({
      unit_of_analysis: {
        target_kind: 'countable_product',
        decision: 'ready_for_materialization',
        functional_unit: {
          what: 'provide display service',
        },
        reference_flow: {
          reference_unit: 'item',
          reference_amount: 1,
          flow_property: 'Number of items',
        },
      },
    }),
    now,
  });
  assert.ok(
    missingScalingEvidence.blockers.some((finding) => finding.code === 'scaling_evidence_missing'),
  );
});

test('build-plan reports default ruleset values when no explicit ruleset is provided', async () => {
  const plan = flowPlan();
  (plan as Record<string, unknown>).ruleset_id = '   ';
  (plan as Record<string, unknown>).ruleset_version = '';

  const report = await runFlowBuildPlanValidate({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: plan,
    now,
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.ruleset_id, 'flow-authoring/strict');
  assert.equal(report.ruleset_version, '1');
});

test('build-plan required-field checks accept non-empty array values', async () => {
  const report = await runFlowBuildPlanValidate({
    inputPath: '/tmp/flow-build-plan.json',
    rawInput: flowPlan({
      target: ['array-target'],
    }),
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.ok(report.required_fields.satisfied.includes('target'));
  assert.ok(report.blockers.some((finding) => finding.path === 'target.flow_type'));
});

test('build-plan commands read JSON files and report input shape errors', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'build-plan-input-'));
  try {
    const inputPath = path.join(workDir, 'plan.json');
    writeFileSync(inputPath, JSON.stringify(flowPlan()), 'utf8');
    const report = await runFlowBuildPlanValidate({ inputPath, now });
    assert.equal(report.status, 'passed');
    assert.equal(report.ruleset_id, 'flow-authoring/strict');

    await assert.rejects(
      () => runFlowBuildPlanValidate({ inputPath: '   ', rawInput: flowPlan() }),
      /Missing required --input value/u,
    );
    await assert.rejects(
      () => runFlowBuildPlanValidate({ inputPath: '/tmp/plan.json', rawInput: 1 }),
      /build-plan input must be a JSON object/u,
    );
    await assert.rejects(
      () =>
        runFlowBuildPlanValidate({
          inputPath: '/tmp/plan.json',
          rawInput: { buildPlan: 'invalid' },
        }),
      /nested build plan must be a JSON object/u,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('build-plan internals cover evidence path normalization and SDK schema fallback', async () => {
  const bindingPaths = __testInternals.evidenceBindingPaths({
    evidence_manifest: {
      field_bindings: [null, { path: 'target' }, { field: 'name_plan.base_name' }],
    },
  });
  assert.deepEqual([...bindingPaths].sort(), ['name_plan.base_name', 'target']);
  assert.deepEqual([...__testInternals.evidenceBindingPaths({ evidence_manifest: 'none' })], []);

  const materialized = __testInternals.materializePlan(
    flowPlan({
      materializedPayload: {
        flowDataSet: {},
      },
    }),
    'flow',
    '/tmp/flow-plan.json',
  );
  assert.deepEqual(materialized, { flowDataSet: {} });

  const schema = __testInternals.validateMaterializedSchema(
    { processDataSet: {} },
    'process',
    undefined,
  );
  assert.equal(schema.status, 'failed');
  assert.match(schema.validator ?? '', /ProcessSchema/u);

  const flowSchema = __testInternals.validateMaterializedSchema(
    { flowDataSet: {} },
    'flow',
    undefined,
  );
  assert.equal(flowSchema.status, 'failed');
  assert.match(flowSchema.validator ?? '', /FlowSchema/u);

  const defaultedSchemaIssue = __testInternals.validateMaterializedSchema(
    { flowDataSet: {} },
    'flow',
    {
      flow: {
        safeParse: () => ({
          success: false as const,
          error: {
            issues: [{ path: ['flowDataSet'] }],
          },
        }),
      },
    },
  );
  assert.equal(defaultedSchemaIssue.issues[0]?.message, 'Validation failed');
  assert.equal(defaultedSchemaIssue.issues[0]?.code, 'custom');

  const notApplicableSchema = __testInternals.validateMaterializedSchema(
    { build_plan_seed: true },
    'flow',
    undefined,
  );
  assert.equal(notApplicableSchema.status, 'not_applicable');

  const blockedDecision = __testInternals.evaluateBuildPlan(
    processPlan({
      identity_decision: {
        decision: 'block_duplicate',
      },
    }),
    'process',
  );
  assert.ok(
    blockedDecision.blockers.some((finding) => finding.code === 'identity_decision_not_automatic'),
  );

  const defaultRuleset = __testInternals.evaluateBuildPlan(
    flowPlan({
      ruleset_id: '   ',
      evidenceManifest: 'none',
    }),
    'flow',
  );
  assert.ok(defaultRuleset.blockers.some((finding) => finding.code === 'evidence_sources_missing'));

  const emptySeed = __testInternals.materializePlan(
    { classification_path: chemicalProductClassification },
    'flow',
    '/tmp/empty-flow-plan.json',
  );
  assert.equal(
    ((emptySeed.flowDataSet as Record<string, unknown>).flowInformation as Record<string, unknown>)
      ? true
      : false,
    true,
  );

  const flowWithOptionalFields = __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      target: {
        flow_type: 'Elementary flow',
        geography: 'CN',
        CASNumber: '50-00-0',
      },
      classificationPath: [{ '@level': '0', '@catId': '1', '#text': 'Emissions' }],
      namePlan: {
        baseName: { en: 'Formaldehyde', zh: '甲醛' },
        treatmentStandardsRoutes: { '#text': 'emission', '@xml:lang': 'en' },
        mixAndLocationTypes: ['air'],
      },
      flowPropertyPlan: {
        referenceProperty: 'volume',
        referenceUnit: 'm3',
        meanValue: 'not-numeric',
      },
      administrativeInformation: {
        owner: {
          id: 'owner-1',
          name: 'Owner',
        },
      },
    }),
    '/tmp/flow-plan.json',
  ) as Record<string, unknown>;
  const flowDataSet = flowWithOptionalFields.flowDataSet as Record<string, unknown>;
  const flowInfo = flowDataSet.flowInformation as Record<string, unknown>;
  const flowDataInfo = flowInfo.dataSetInformation as Record<string, unknown>;
  assert.equal(flowDataInfo.CASNumber, '50-00-0');
  assert.equal(
    (
      (flowDataSet.modellingAndValidation as Record<string, unknown>).LCIMethod as Record<
        string,
        unknown
      >
    ).typeOfDataSet,
    'Elementary flow',
  );

  const fallbackProcess = __testInternals.buildCanonicalProcessPayload(
    {
      schema_version: 1,
      kind: 'process',
      target: {},
      identity_decision: {
        decision: 'create_new',
      },
      evidence_manifest: {
        sources: [],
      },
      classification_path: energyProcessClassification,
      name_plan: {
        base_name: 'Fallback process',
      },
      quantitative_reference_plan: {
        reference_flow_id: 'flow-fallback',
        reference_flow_internal_id: '9',
        resulting_amount: '2.5',
      },
      required_fields: {
        annualSupplyOrProductionVolume: {
          en: '1000 kg/year',
        },
      },
      exchange_plan: {
        exchanges: [null, { mean_amount: '0.75' }],
      },
      modelling_and_validation: {
        type_of_dataset: 'LCI result',
      },
      administrative_information: {
        time_stamp: '2026-05-22T00:00:00.000Z',
        intended_applications: { en: 'Regression test' },
      },
    },
    '/tmp/process-plan.json',
  ) as Record<string, unknown>;
  const fallbackProcessDataSet = fallbackProcess.processDataSet as Record<string, unknown>;
  const fallbackProcessInfo = fallbackProcessDataSet.processInformation as Record<string, unknown>;
  const fallbackDataInfo = fallbackProcessInfo.dataSetInformation as Record<string, unknown>;
  const fallbackName = fallbackDataInfo.name as Record<string, unknown>;
  assert.deepEqual(fallbackName.treatmentStandardsRoutes, [
    {
      '#text': 'Technology route documented in build plan',
      '@xml:lang': 'en',
    },
  ]);
  assert.deepEqual(
    (fallbackProcessInfo.technology as Record<string, unknown>)
      .technologyDescriptionAndIncludedProcesses,
    [
      {
        '#text': 'Technology route documented in build plan evidence.',
        '@xml:lang': 'en',
      },
    ],
  );
  const fallbackModelling = fallbackProcessDataSet.modellingAndValidation as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    (fallbackModelling.dataSourcesTreatmentAndRepresentativeness as Record<string, unknown>)
      .annualSupplyOrProductionVolume,
    [{ '#text': '1000 kg/year', '@xml:lang': 'en' }],
  );
  const fallbackExchanges = (fallbackProcessDataSet.exchanges as Record<string, unknown>)
    .exchange as Array<Record<string, unknown>>;
  assert.equal(fallbackExchanges[1]?.['@dataSetInternalID'], '2');
  assert.equal(fallbackExchanges[1]?.meanAmount, '0.75');
  const sparseExchangeRef = fallbackExchanges[1]?.referenceToFlowDataSet as Record<string, unknown>;
  assert.equal(sparseExchangeRef['@type'], 'flow data set');
  assert.match(String(sparseExchangeRef['@refObjectId']), /^[0-9a-f-]{36}$/u);
  assert.equal(
    sparseExchangeRef['@uri'],
    `../flow-data-set/${String(sparseExchangeRef['@refObjectId'])}.xml`,
  );
  assert.deepEqual(sparseExchangeRef['common:shortDescription'], {
    '#text': 'Exchange flow 2',
    '@xml:lang': 'en',
  });

  assert.deepEqual(
    __testInternals.multiLangFromValue(
      [{ text: '数组文本' }, {}, 'Plain text', ''],
      'Fallback text',
      'zh',
    ),
    [
      { '#text': '数组文本', '@xml:lang': 'zh' },
      { '#text': 'Plain text', '@xml:lang': 'zh' },
    ],
  );
  assert.deepEqual(__testInternals.multiLangFromValue({ '#text': '单值文本' }, 'Fallback'), [
    { '#text': '单值文本', '@xml:lang': 'en' },
  ]);
  assert.deepEqual(__testInternals.multiLangFromValue({ zh: '仅中文' }, 'Fallback'), [
    { '#text': '仅中文', '@xml:lang': 'zh' },
  ]);

  const wasteFlow = __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      target: {
        flow_type: 'Waste flow',
      },
      classification_path: [
        {
          '@level': '0',
          '@classId': '3',
          '#text': 'Other transportable goods, except metal products, machinery and equipment',
        },
      ],
      evidenceManifest: {
        sources: [
          {
            source_id: 'source-alias',
            uri: 'https://example.invalid/source',
            name: 'Source alias',
          },
        ],
      },
      name_plan: {
        base_name: 'Waste reference flow',
      },
      complianceReference: {
        refObjectId: 'compliance-ref',
        version: '01.00.000',
        uri: 'https://example.invalid/compliance',
        shortDescription: 'Compliance ref',
      },
      formatReference: {
        refObjectId: 'format-ref',
        version: '01.00.000',
        uri: 'https://example.invalid/format',
        name: 'Format ref',
      },
      administrative_information: {
        owner: {
          refObjectId: 'owner-ref',
          version: '01.00.000',
          uri: 'https://example.invalid/owner',
          shortDescription: 'Owner ref',
        },
      },
    }),
    '/tmp/waste-flow-plan.json',
  ) as Record<string, unknown>;
  const wasteFlowDataSet = wasteFlow.flowDataSet as Record<string, unknown>;
  assert.equal(
    (
      (wasteFlowDataSet.modellingAndValidation as Record<string, unknown>).LCIMethod as Record<
        string,
        unknown
      >
    ).typeOfDataSet,
    'Waste flow',
  );
  assert.equal(
    (
      (
        (wasteFlowDataSet.administrativeInformation as Record<string, unknown>)
          .publicationAndOwnership as Record<string, unknown>
      )['common:referenceToOwnershipOfDataSet'] as Record<string, unknown>
    )['@refObjectId'],
    'owner-ref',
  );

  const defaultedProcess = __testInternals.buildCanonicalProcessPayload(
    {
      schema_version: 1,
      kind: 'process',
      target: {
        reference_year: 'not-a-year',
      },
      identity_decision: {
        decision: 'create_new',
      },
      classification_path: energyProcessClassification,
      name_plan: {
        base_name: [{ value: 'Defaulted process', lang: 'en' }],
      },
      quantitative_reference_plan: {},
      exchange_plan: {
        exchanges: [
          {
            '@dataSetInternalID': '11',
            referenceFlowId: 'camel-flow',
            resultingAmount: '0.2',
            exchangeDirection: 'Input',
            quantitativeReference: true,
          },
        ],
      },
      administrativeInformation: {
        commissioner: {
          ref_object_id: 'commissioner-ref',
          name: 'Commissioner ref',
        },
        data_entry: {
          refObjectId: 'data-entry-ref',
          name: 'Data entry ref',
        },
      },
    },
    '/tmp/defaulted-process-plan.json',
  ) as Record<string, unknown>;
  const defaultedProcessDataSet = defaultedProcess.processDataSet as Record<string, unknown>;
  const defaultedProcessInfo = defaultedProcessDataSet.processInformation as Record<
    string,
    unknown
  >;
  assert.equal(
    ((defaultedProcessInfo.time as Record<string, unknown>) ?? {})['common:referenceYear'],
    1970,
  );
  assert.deepEqual(
    (
      (defaultedProcessDataSet.modellingAndValidation as Record<string, unknown>)
        .dataSourcesTreatmentAndRepresentativeness as Record<string, unknown>
    ).annualSupplyOrProductionVolume,
    [],
    'a defaulted plan carries no annual-volume evidence, so it must stay unknown',
  );

  const resultingAmountProcess = __testInternals.buildCanonicalProcessPayload(
    processPlan({
      quantitative_reference_plan: {
        reference_flow_id: 'resulting-flow',
        resulting_amount: '4.2',
        reference_unit: 'kg',
      },
    }),
    '/tmp/resulting-amount-process-plan.json',
  ) as Record<string, unknown>;
  assert.deepEqual(
    (
      (
        (resultingAmountProcess.processDataSet as Record<string, unknown>)
          .modellingAndValidation as Record<string, unknown>
      ).dataSourcesTreatmentAndRepresentativeness as Record<string, unknown>
    ).annualSupplyOrProductionVolume,
    [],
    'a 4.2 kg resulting amount is a reference amount, not annual-volume evidence',
  );
  assert.deepEqual(__testInternals.buildAnnualSupply({}), []);
  assert.deepEqual(
    __testInternals.buildAnnualSupply({
      required_fields: {
        annualSupplyOrProductionVolume: [
          { '#text': '1000 kg/year', '@xml:lang': 'zh' },
          { '#text': '1000 kg/year', '@xml:lang': 'en' },
        ],
      },
    }),
    [
      { '#text': '1000 kg/year', '@xml:lang': 'zh' },
      { '#text': '1000 kg/year', '@xml:lang': 'en' },
    ],
    'a real explicit language array keeps its exact content and order',
  );

  __testInternals.buildCanonicalProcessPayload(
    processPlan({
      evidence_manifest: {
        sources: [{ source_id: 'source-id-only', short_description: 'Source ID only' }],
      },
    }),
    '/tmp/source-id-process-plan.json',
  );
  __testInternals.buildCanonicalProcessPayload(
    processPlan({
      evidence_manifest: {
        sources: [{ ref_object_id: 'ref-object-id-only', title: 'Ref object ID only' }],
      },
    }),
    '/tmp/ref-object-id-process-plan.json',
  );
  __testInternals.buildCanonicalFlowPayload(
    flowPlan({
      complianceReference: {
        name: 'Named compliance fallback',
      },
    }),
    '/tmp/named-compliance-flow-plan.json',
  );
});

function annualSupplyOf(payload: Record<string, unknown>): unknown {
  return (
    (
      (payload.processDataSet as Record<string, unknown>).modellingAndValidation as Record<
        string,
        unknown
      >
    ).dataSourcesTreatmentAndRepresentativeness as Record<string, unknown>
  ).annualSupplyOrProductionVolume;
}

test('build plan never fabricates annual supply from the quantitative reference', () => {
  for (const [amount, unit] of [
    ['1', 'kg'],
    ['3.6', 'MJ'],
  ] as const) {
    const payload = __testInternals.buildCanonicalProcessPayload(
      processPlan({
        quantitative_reference_plan: {
          reference_flow_id: '190f39ca-0ec8-5aab-b2d9-c91fc55ee58d',
          mean_amount: amount,
          reference_unit: unit,
        },
      }),
      `/tmp/qref-${amount}-process-plan.json`,
    ) as Record<string, unknown>;
    assert.deepEqual(
      annualSupplyOf(payload),
      [],
      `a ${amount} ${unit} quantitative reference is not annual-volume evidence`,
    );
    assert.equal(
      ProcessSchema.safeParse(structuredClone(payload)).success,
      true,
      'the unknown representation must stay SDK-valid',
    );
  }

  // The same rule holds at the internals boundary, whatever the reference exchange carries.
  assert.deepEqual(__testInternals.buildAnnualSupply({}), []);
  assert.deepEqual(
    __testInternals.buildAnnualSupply({
      required_fields: { annualSupplyOrProductionVolume: ['Not specified'] },
    }),
    ['Not specified'],
    'a malformed explicit shape must reach the SDK gate instead of being repaired',
  );
});

test('build plan preserves an explicit annual-supply language array and the unknown array', () => {
  const explicit = [
    { '#text': '3.6 MJ/年', '@xml:lang': 'zh' },
    { '#text': '3.6 MJ/year', '@xml:lang': 'en' },
  ];
  const payload = __testInternals.buildCanonicalProcessPayload(
    processPlan({
      quantitative_reference_plan: {
        reference_flow_id: '190f39ca-0ec8-5aab-b2d9-c91fc55ee58d',
        mean_amount: '1',
        reference_unit: 'kg',
      },
      required_fields: { annualSupplyOrProductionVolume: explicit },
    }),
    '/tmp/explicit-annual-supply-process-plan.json',
  ) as Record<string, unknown>;
  assert.equal(
    JSON.stringify(annualSupplyOf(payload)),
    JSON.stringify(explicit),
    'an explicit language array must keep its exact content and order',
  );
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);

  assert.deepEqual(
    __testInternals.buildAnnualSupply({ required_fields: { annualSupplyOrProductionVolume: [] } }),
    [],
    'an explicit unknown array must stay unknown rather than be filled in',
  );

  const emptyPlanPayload = __testInternals.buildCanonicalProcessPayload(
    processPlan({
      required_fields: { annualSupplyOrProductionVolume: [] },
    }),
    '/tmp/explicit-unknown-annual-supply-process-plan.json',
  ) as Record<string, unknown>;
  assert.deepEqual(annualSupplyOf(emptyPlanPayload), []);
  assert.equal(ProcessSchema.safeParse(structuredClone(emptyPlanPayload)).success, true);
});
