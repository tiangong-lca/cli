import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  runFlowBuildPlanMaterialize,
  runFlowBuildPlanValidate,
  runFlowBuildPlanVerify,
  runProcessBuildPlanMaterialize,
  runProcessBuildPlanVerify,
  verifyProcessBuildPlanInvariants,
  verifyFlowBuildPlanInvariants,
  runProcessBuildPlanValidate,
  __testInternals,
} from '../src/lib/process-flow-build-plan.js';
import { CliError } from '../src/lib/errors.js';
import type { SafeParseSchema } from '../src/lib/tidas-sdk-validation.js';
import { propertyJsonHash } from '../src/lib/flow-property-conversion.js';

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

const PROCESS_REMEDIATION_PATH = [
  'Water supply; sewerage, waste management and remediation activities',
  'Remediation and other waste management service activities',
  'Remediation and other waste management service activities',
  'Remediation and other waste management service activities',
];

const ELEMENTARY_AIR_INDOOR_PATH = ['Emissions', 'Emissions to air', 'Emissions to air, indoor'];

function passingSchema(): SafeParseSchema {
  return {
    safeParse: () => ({
      success: true as const,
      data: {},
    }),
  };
}

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

function strictSourceEvidencePlan(exchangeOverrides: Record<string, unknown> = {}) {
  const base = processPlan();
  const primarySourceId = '22222222-2222-4222-8222-222222222222';
  const evidenceId = 'evidence-input-and-output';
  return {
    ...base,
    authoring_mode: 'source-evidence/strict',
    evidence_manifest: {
      ...base.evidence_manifest,
      sources: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
          title: 'General process source',
        },
        {
          id: primarySourceId,
          version: '01.00.000',
          title: 'Exchange calculation source',
        },
      ],
      evidence: [
        {
          id: evidenceId,
          source_id: primarySourceId,
          locator: 'page 12, table 4',
        },
      ],
    },
    modelling_and_validation: {
      annualSupplyOrProductionVolume: {
        en: '100000 kg/year documented production volume',
        zh: '100000 kg/年，有资料记录的年产量',
      },
    },
    publication: {
      rights_decision: {
        status: 'resolved',
        copyright: true,
        license_type: 'Other',
        access_restrictions: {
          en: 'Internal review only; publication requires owner approval.',
          zh: '仅限内部评审；发布前需要所有者批准。',
        },
      },
    },
    exchange_plan: {
      exchanges: [
        {
          internal_id: '2',
          flow_id: '33333333-3333-4333-8333-333333333333',
          version: '01.00.000',
          name: 'Material input',
          direction: 'Input',
          mean_amount: '0.01',
          resulting_amount: '0.01',
          data_source_type: 'Primary',
          data_derivation_type_status: 'Calculated',
          calculation_provenance: {
            source_values: [
              {
                id: 'input_total',
                value: '1000',
                unit: 'kg/year',
                primary_source_id: primarySourceId,
                evidence_id: evidenceId,
              },
              {
                id: 'annual_output',
                value: '100000',
                unit: 'kg/year',
                primary_source_id: primarySourceId,
                evidence_id: evidenceId,
              },
            ],
            conversion_steps: [
              {
                id: 'convert-1',
                description: 'No unit conversion is needed before normalization.',
                formula: 'converted_input = input_total',
                result: '1000',
                result_unit: 'kg/year',
              },
            ],
            normalization_denominator: {
              value: '100000',
              unit: 'kg/year',
              formula: 'annual_output',
              source_value_ids: ['annual_output'],
            },
            formula: 'input_total / annual_output',
            unrounded_result: '0.01',
            result_unit: 'kg/kg',
            rounding: {
              mode: 'none',
            },
            primary_source_ids: [primarySourceId],
            evidence_ids: [evidenceId],
            assumptions: [],
          },
          ...exchangeOverrides,
        },
      ],
    },
  };
}

function strictExchange(plan: unknown): Record<string, unknown> {
  const root = plan as Record<string, unknown>;
  const exchangePlan = root.exchange_plan as { exchanges: Array<Record<string, unknown>> };
  return exchangePlan.exchanges[0] as Record<string, unknown>;
}

function strictProvenance(plan: unknown): Record<string, unknown> {
  return strictExchange(plan).calculation_provenance as Record<string, unknown>;
}

test('multi-property Flow authoring preserves a nonzero reference and all historical property metadata', async () => {
  const oldPlan = flowPlan();
  const before = __testInternals.buildCanonicalFlowPayload(oldPlan, 'stable-plan.json') as Record<
    string,
    unknown
  >;
  const flow = before.flowDataSet as Record<string, unknown>;
  const properties = flow.flowProperties as Record<string, unknown>;
  const reference = properties.flowProperty as Record<string, unknown>;
  reference['@dataSetInternalID'] = '7';
  reference.generalComment = [{ '@xml:lang': 'en', '#text': 'Keep this measured basis.' }];
  reference.minimumValue = '0.99';
  reference.maximumValue = '1.01';
  reference.dataDerivationTypeStatus = 'Measured';
  (
    (flow.flowInformation as Record<string, unknown>).quantitativeReference as Record<
      string,
      unknown
    >
  ).referenceToReferenceFlowProperty = '7';
  const secondary = {
    '@dataSetInternalID': '0',
    meanValue: '0.001',
    referenceToFlowPropertyDataSet: {
      '@refObjectId': '93a60a56-a3c8-11da-a746-0800200b9a67',
      '@type': 'flow property data set',
      '@version': '01.00.000',
      'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Volume' }],
    },
  };
  const plan = flowPlan({
    identityDecision: { decision: 'update_same_row' },
    flow_property_plan: {
      reference_internal_id: '7',
      properties: [secondary],
      before_flow: before,
    },
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'flow-property-build-'));
  try {
    const gate = await runFlowBuildPlanMaterialize({
      inputPath: 'stable-plan.json',
      rawInput: plan,
      outDir: dir,
      schemas: { flow: passingSchema() },
    });
    assert.equal(gate.status, 'passed', JSON.stringify(gate.blockers));
    assert.equal(gate.property_validation?.reference_preserved, true);
    assert.equal(gate.property_validation?.preserved_property_count, 1);
    assert.equal(gate.property_validation?.property_count, 2);
    const candidate = JSON.parse(readFileSync(gate.files.materialized_artifact!, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(gate.property_validation?.candidate_sha256, propertyJsonHash(candidate));
    const verifyOptions = {
      inputPath: 'stable-plan.json',
      rawInput: plan,
      candidatePath: 'candidate.json',
      rawCandidate: candidate,
      schemas: { flow: passingSchema() },
    };
    const verified = await runFlowBuildPlanVerify(verifyOptions);
    assert.equal(verified.status, 'passed');
    const candidateFlow = candidate.flowDataSet as Record<string, unknown>;
    const candidateProps = (candidateFlow.flowProperties as Record<string, unknown>)
      .flowProperty as Array<Record<string, unknown>>;
    assert.deepEqual(candidateProps[1], reference);
    delete candidateProps[1]!.generalComment;
    assert.equal((await runFlowBuildPlanVerify(verifyOptions)).status, 'blocked');
    for (const mutation of [
      { reference_internal_id: '0', properties: [secondary], before_flow: before },
      {
        reference_internal_id: '7',
        properties: [{ ...reference, meanValue: '2' }],
        before_flow: before,
      },
      { reference_internal_id: '7', properties: [secondary] },
      { reference_internal_id: '7', properties: [reference, { ...reference }] },
    ]) {
      const blocked = await runFlowBuildPlanValidate({
        inputPath: 'stable-plan.json',
        rawInput: { ...plan, flow_property_plan: mutation },
      });
      assert.equal(blocked.status, 'blocked');
    }
    const fresh = flowPlan({
      flow_property_plan: { reference_internal_id: '7', properties: [secondary, reference] },
    });
    assert.equal(
      (await runFlowBuildPlanValidate({ inputPath: 'fresh.json', rawInput: fresh })).status,
      'passed',
    );
    assert.equal(
      (
        await runFlowBuildPlanValidate({
          inputPath: 'ef.json',
          rawInput: {
            ...fresh,
            target: { flow_type: 'Elementary flow' },
            payload: {
              flowDataSet: {
                ...flow,
                modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } },
              },
            },
          },
        })
      ).status,
      'blocked',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process conversion binds exact native inputs, safe source formula, reference quantities and intervals', async () => {
  const request = JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/request.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const operation = JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/operation-report.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const nativeReport = (operation.summary as Record<string, unknown>)
    .flow_property_conversion as Record<string, unknown>;
  const plan = strictSourceEvidencePlan({
    flow_id: '10000000-0000-4000-8000-000000000001',
    mean_amount: '2000',
    resulting_amount: '2000',
  });
  plan.quantitative_reference_plan.reference_unit = 'kg';
  const provenance = strictProvenance(plan);
  (provenance.source_values as Array<Record<string, unknown>>)[0]!.value = '200000';
  (provenance.source_values as Array<Record<string, unknown>>)[0]!.unit = 'm3/year';
  (provenance.conversion_steps as Array<Record<string, unknown>>)[0]!.result = '200000';
  (provenance.conversion_steps as Array<Record<string, unknown>>)[0]!.result_unit = 'm3/year';
  provenance.unrounded_result = '2';
  provenance.result_unit = 'm3/kg';
  provenance.flow_property_conversion = { request, report: nativeReport };
  const spawn = ((_executable: string, args: string[], opts: { input?: string }) => {
    if (args[0] === 'convert') {
      assert.deepEqual(args, [
        'convert',
        '-',
        '--to',
        'reference-unit',
        '--format',
        'json',
        '--progress',
        'never',
      ]);
      assert.deepEqual(JSON.parse(opts.input!), request);
    }
    const report =
      args[0] === 'version'
        ? {
            ...operation,
            command: 'version',
            summary: {
              binary_version: '0.3.0',
              operation_report_schema: 'tidas.operation-report.v1',
            },
          }
        : operation;
    return {
      pid: 1,
      output: [],
      stdout: JSON.stringify(report),
      stderr: '',
      status: 0,
      signal: null,
    };
  }) as unknown as typeof spawnSync;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'process-property-build-'));
  const options = {
    inputPath: 'conversion-plan.json',
    rawInput: plan,
    spawnImpl: spawn,
    tidasBin: 'tidas-test',
    env: {},
    schemas: { process: passingSchema() },
  };
  try {
    const gate = await runProcessBuildPlanMaterialize({ ...options, outDir: dir });
    assert.equal(gate.status, 'passed', JSON.stringify(gate.blockers));
    assert.equal(gate.property_validation?.conversion_count, 1);
    assert.equal(gate.invariant_verification?.status, 'passed');
    const candidate = JSON.parse(readFileSync(gate.files.materialized_artifact!, 'utf8')) as Record<
      string,
      unknown
    >;
    const exchange = (
      (candidate.processDataSet as Record<string, unknown>).exchanges as {
        exchange: Array<Record<string, unknown>>;
      }
    ).exchange[1]!;
    assert.equal(exchange.meanAmount, '2000');
    assert.equal(exchange.minimumAmount, '1900');
    assert.equal(exchange.maximumAmount, '2100');
    const verify = { ...options, candidatePath: 'candidate.json', rawCandidate: candidate };
    assert.equal((await runProcessBuildPlanVerify(verify)).status, 'passed');
    exchange.minimumAmount = '1.9';
    assert.equal((await runProcessBuildPlanVerify(verify)).status, 'blocked');
    const variants = [
      (p: Record<string, unknown>) => {
        (p.quantitative_reference_plan as Record<string, unknown>).mean_amount = '1.8';
      },
      (p: Record<string, unknown>) => {
        strictExchange(p).version = '01.00.001';
      },
      (p: Record<string, unknown>) => {
        strictExchange(p).mean_amount = '2';
      },
      (p: Record<string, unknown>) => {
        strictProvenance(p).formula = 'unbound_quantity';
      },
      (p: Record<string, unknown>) => {
        strictProvenance(p).result_unit = 'kg/kg';
      },
      (p: Record<string, unknown>) => {
        strictProvenance(p).flow_property_conversion = {};
      },
      (p: Record<string, unknown>) => {
        (
          (strictProvenance(p).flow_property_conversion as Record<string, unknown>)
            .report as Record<string, unknown>
        ).request_sha256 = 'stale';
      },
      (p: Record<string, unknown>) => {
        (
          (strictProvenance(p).flow_property_conversion as Record<string, unknown>)
            .request as Record<string, unknown>
        ).direction = 'from-reference';
      },
      (p: Record<string, unknown>) => {
        strictProvenance(p).unrounded_result = '3';
      },
      (p: Record<string, unknown>) => {
        p.authoring_mode = 'legacy';
      },
    ];
    for (const mutate of variants) {
      const changed = structuredClone(plan) as Record<string, unknown>;
      mutate(changed);
      assert.equal(
        (await runProcessBuildPlanValidate({ ...options, rawInput: changed })).status,
        'blocked',
      );
    }
    // A prebuilt payload cannot bypass native quantity/invariant checks.
    assert.equal(
      (
        await runProcessBuildPlanMaterialize({
          ...options,
          rawInput: { ...plan, payload: candidate },
        })
      ).status,
      'blocked',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provenance comment splitting respects delimiters at the capacity edge and UTF-16 pairs', () => {
  for (const text of [
    'a'.repeat(499) + ' | ' + 'b'.repeat(100),
    'a'.repeat(499) + '😀' + 'b'.repeat(100),
  ]) {
    const chunks = __testInternals.splitProvenanceComment(text, 'continued: ');
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 500));
    assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk)));
  }
});

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
      [{ '#text': '3.6 MJ/year', '@xml:lang': 'en' }],
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
    /do not resolve/u,
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
    [{ '#text': '1 unit/year', '@xml:lang': 'en' }],
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
    [{ '#text': '4.2 kg/year', '@xml:lang': 'en' }],
  );
  assert.deepEqual(__testInternals.buildAnnualSupply({}, { resultingAmount: '5.5' }), [
    { '#text': '5.5 unit/year', '@xml:lang': 'en' },
  ]);
  assert.deepEqual(__testInternals.buildAnnualSupply({}, {}), [
    { '#text': '1.0 unit/year', '@xml:lang': 'en' },
  ]);

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

test('source-evidence strict process plans validate provenance and materialize auditable exchange fields', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'strict-process-build-plan-'));
  try {
    const plan = strictSourceEvidencePlan();
    const report = await runProcessBuildPlanMaterialize({
      inputPath: '/tmp/strict-process-plan.json',
      outDir,
      rawInput: plan,
      now,
    });

    assert.equal(report.status, 'passed');
    assert.deepEqual(report.calculation_provenance, {
      status: 'passed',
      required: true,
      calculated_exchange_count: 1,
      validated_exchange_count: 1,
    });
    assert.equal(existsSync(path.join(outDir, 'outputs', 'calculation-provenance.json')), true);
    const provenanceArtifact = JSON.parse(
      readFileSync(path.join(outDir, 'outputs', 'calculation-provenance.json'), 'utf8'),
    ) as {
      plan_sha256: string;
      calculated_exchange_count: number;
      exchanges: Array<{ generated_general_comment: Array<{ '#text': string }> }>;
    };
    assert.match(provenanceArtifact.plan_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(provenanceArtifact.calculated_exchange_count, 1);
    assert.match(
      provenanceArtifact.exchanges[0]?.generated_general_comment[0]?.['#text'] ?? '',
      /formula: input_total \/ annual_output/u,
    );

    const materialized = JSON.parse(
      readFileSync(path.join(outDir, 'outputs', 'materialized-process.json'), 'utf8'),
    ) as {
      processDataSet: {
        administrativeInformation: {
          publicationAndOwnership: Record<string, unknown>;
        };
        exchanges: {
          exchange: Array<Record<string, unknown>>;
        };
      };
    };
    const exchange = materialized.processDataSet.exchanges.exchange[1] ?? {};
    assert.equal(exchange.dataSourceType, 'Primary');
    const sourceReference = (
      exchange.referencesToDataSource as {
        referenceToDataSource: { '@refObjectId': string };
      }
    ).referenceToDataSource;
    assert.equal(sourceReference['@refObjectId'], '22222222-2222-4222-8222-222222222222');
    const comments = exchange.generalComment as Array<{ '#text': string; '@xml:lang': string }>;
    assert.deepEqual(
      comments.map((comment) => comment['@xml:lang']),
      ['en', 'zh'],
    );
    assert.match(comments[0]?.['#text'] ?? '', /values: input_total=1000 kg\/year/u);
    assert.match(comments[1]?.['#text'] ?? '', /计算/u);
    const rights = materialized.processDataSet.administrativeInformation.publicationAndOwnership;
    assert.equal(rights['common:copyright'], 'true');
    assert.equal(rights['common:licenseType'], 'Other');
    assert.deepEqual(rights['common:accessRestrictions'], [
      {
        '#text': 'Internal review only; publication requires owner approval.',
        '@xml:lang': 'en',
      },
      {
        '#text': '仅限内部评审；发布前需要所有者批准。',
        '@xml:lang': 'zh',
      },
    ]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('source-evidence strict mode safely evaluates declared calculation formulas', async () => {
  const plan = strictSourceEvidencePlan();
  const provenance = strictProvenance(plan);
  const conversion = (provenance.conversion_steps as Array<Record<string, unknown>>)[0] as Record<
    string,
    unknown
  >;
  conversion.formula = 'converted_input = -(-input_total) + 1e2';
  conversion.result = '1100';
  (provenance.conversion_steps as Array<Record<string, unknown>>).push({
    id: 'scaled_input',
    description: 'A later conversion may consume the prior assignment alias.',
    formula: 'converted_input / 11',
    result: '100',
    result_unit: 'kg/year',
  });
  const denominator = provenance.normalization_denominator as Record<string, unknown>;
  denominator.formula = 'lifetime_output = annual_output / (2 - 1)';
  provenance.formula = 'scaled_input / normalization_denominator * 10';

  const report = await runProcessBuildPlanValidate({
    inputPath: '/tmp/safe-calculation-formulas.json',
    rawInput: plan,
    now,
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.blockers, null, 2));

  const collisionPlan = strictSourceEvidencePlan();
  const collisionProvenance = strictProvenance(collisionPlan);
  (collisionProvenance.conversion_steps as Array<Record<string, unknown>>)[0]!.formula =
    'annual_output = input_total';
  const collisionReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/calculation-variable-collision.json',
    rawInput: collisionPlan,
    now,
  });
  assert.ok(
    collisionReport.blockers.some((finding) => finding.code === 'calculation_variable_collision'),
  );
});

test('source-evidence strict mode rejects unevaluable or inconsistent calculation formulas', async () => {
  const invalidPlan = strictSourceEvidencePlan();
  const invalidProvenance = strictProvenance(invalidPlan);
  invalidProvenance.conversion_steps = [
    {
      id: 'unknown-variable',
      description: 'Unknown variables must not be accepted.',
      formula: 'input_total + missing_value',
      result: '1000',
      result_unit: 'kg/year',
    },
    {
      id: 'wrong-result',
      description: 'The declared result must equal the formula result.',
      formula: 'input_total * 2',
      result: '1999',
      result_unit: 'kg/year',
    },
  ];
  (invalidProvenance.normalization_denominator as Record<string, unknown>).formula =
    'annual_output + 1';
  invalidProvenance.formula = 'input_total / 0';
  const invalidReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/invalid-calculation-formulas.json',
    rawInput: invalidPlan,
    now,
  });
  for (const code of [
    'calculation_conversion_formula_invalid',
    'calculation_conversion_result_mismatch',
    'calculation_normalization_value_mismatch',
    'calculation_formula_invalid',
  ]) {
    assert.ok(
      invalidReport.blockers.some((finding) => finding.code === code),
      code,
    );
  }

  const trailingPlan = strictSourceEvidencePlan();
  const trailingProvenance = strictProvenance(trailingPlan);
  (trailingProvenance.normalization_denominator as Record<string, unknown>).formula =
    'annual_output trailing';
  trailingProvenance.formula = 'input_total / annual_output + 1e-2';
  const trailingReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/trailing-calculation-formulas.json',
    rawInput: trailingPlan,
    now,
  });
  assert.ok(
    trailingReport.blockers.some(
      (finding) => finding.code === 'calculation_normalization_formula_invalid',
    ),
  );
  assert.ok(
    trailingReport.blockers.some(
      (finding) => finding.code === 'calculation_unrounded_result_mismatch',
    ),
  );

  const unboundPlan = strictSourceEvidencePlan();
  const unboundProvenance = strictProvenance(unboundPlan);
  (unboundProvenance.conversion_steps as Array<Record<string, unknown>>)[0]!.formula = '1000';
  (unboundProvenance.normalization_denominator as Record<string, unknown>).formula = '100000';
  unboundProvenance.formula = '0.01';
  const unboundReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/unbound-calculation-formulas.json',
    rawInput: unboundPlan,
    now,
  });
  for (const code of [
    'calculation_conversion_formula_unbound',
    'calculation_normalization_formula_unbound',
    'calculation_formula_unbound',
  ]) {
    assert.ok(
      unboundReport.blockers.some((finding) => finding.code === code),
      code,
    );
  }
});

test('safe arithmetic evaluator accepts the supported grammar and fails closed', () => {
  const variables = new Map([
    ['value', 4],
    ['other_value', 2],
  ]);
  assert.deepEqual(
    __testInternals.evaluateArithmeticExpression('alias = --value / +other_value', variables),
    {
      ok: true,
      value: 2,
      assigned_identifier: 'alias',
      referenced_identifiers: ['value', 'other_value'],
    },
  );
  assert.deepEqual(__testInternals.evaluateArithmeticExpression(' (.5 + 1.) * -2E+1 ', variables), {
    ok: true,
    value: -30,
    assigned_identifier: null,
    referenced_identifiers: [],
  });
  assert.deepEqual(__testInternals.evaluateArithmeticExpression('10 - 2 + 3 * 4 / 2', variables), {
    ok: true,
    value: 14,
    assigned_identifier: null,
    referenced_identifiers: [],
  });

  for (const [formula, expectedError] of [
    ['', /Expected a number/u],
    ['.', /Invalid numeric literal/u],
    ['1e999', /not finite/u],
    ['missing + 1', /Unknown identifier/u],
    ['1 2', /Unexpected trailing token/u],
    ['1 / 0', /non-finite result/u],
    ['(1 + 2', /Expected closing parenthesis/u],
    ['@', /Unexpected token/u],
    ['1 +', /Expected a number/u],
    ['1 = 1', /Unexpected trailing token/u],
  ] as Array<[string, RegExp]>) {
    const result = __testInternals.evaluateArithmeticExpression(formula, variables);
    assert.equal(result.ok, false, formula);
    if (!result.ok) {
      assert.match(result.error, expectedError, formula);
    }
  }

  const longResult = __testInternals.evaluateArithmeticExpression(' '.repeat(4097), variables);
  assert.equal(longResult.ok, false);
  if (!longResult.ok) {
    assert.match(longResult.error, /exceeds 4096 characters/u);
  }
  const nestedResult = __testInternals.evaluateArithmeticExpression(
    `${'('.repeat(130)}1${')'.repeat(130)}`,
    variables,
  );
  assert.equal(nestedResult.ok, false);
  if (!nestedResult.ok) {
    assert.match(nestedResult.error, /nesting exceeds 128/u);
  }
  const nonFiniteVariable = __testInternals.evaluateArithmeticExpression(
    'infinite',
    new Map([['infinite', Number.POSITIVE_INFINITY]]),
  );
  assert.equal(nonFiniteVariable.ok, false);
  if (!nonFiniteVariable.ok) {
    assert.match(nonFiniteVariable.error, /non-finite result/u);
  }
});

test('source-evidence strict mode blocks missing annual supply, unresolved rights, invalid provenance, and dangling references', async () => {
  const missingAnnual = strictSourceEvidencePlan() as Record<string, unknown>;
  delete missingAnnual.modelling_and_validation;
  const missingAnnualReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/missing-annual.json',
    rawInput: missingAnnual,
    now,
  });
  assert.ok(
    missingAnnualReport.blockers.some((finding) => finding.code === 'strict_annual_supply_missing'),
  );

  const unresolvedRights = strictSourceEvidencePlan() as Record<string, unknown>;
  unresolvedRights.publication = { rights_decision: { status: 'unknown' } };
  const unresolvedRightsReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/unresolved-rights.json',
    rawInput: unresolvedRights,
    now,
  });
  assert.ok(
    unresolvedRightsReport.blockers.some(
      (finding) => finding.code === 'publication_rights_unresolved',
    ),
  );

  const missingRights = strictSourceEvidencePlan() as Record<string, unknown>;
  delete missingRights.publication;
  const missingRightsReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/missing-rights.json',
    rawInput: missingRights,
    now,
  });
  assert.ok(
    missingRightsReport.blockers.some(
      (finding) => finding.code === 'publication_rights_decision_missing',
    ),
  );

  const invalidRights = strictSourceEvidencePlan() as Record<string, unknown>;
  invalidRights.publication = {
    rights_decision: {
      status: 'resolved',
      copyright: 'unknown',
      license_type: 'invented',
      access_restrictions: {},
    },
  };
  const invalidRightsReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/invalid-rights.json',
    rawInput: invalidRights,
    now,
  });
  for (const code of [
    'publication_copyright_invalid',
    'publication_license_type_invalid',
    'publication_access_restrictions_missing',
  ]) {
    assert.ok(
      invalidRightsReport.blockers.some((finding) => finding.code === code),
      code,
    );
  }

  const missingProvenanceReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/missing-provenance.json',
    rawInput: strictSourceEvidencePlan({ calculation_provenance: null }),
    now,
  });
  assert.ok(
    missingProvenanceReport.blockers.some(
      (finding) => finding.code === 'calculation_provenance_missing',
    ),
  );

  const badPlan = strictSourceEvidencePlan({
    data_source_type: 'Calculated',
    mean_amount: '0.02',
    resulting_amount: '0.03',
    calculation_provenance: {
      source_values: [
        {
          id: 'duplicate',
          value: 'not-a-number',
          unit: '',
          primary_source_id: 'missing-source',
          evidence_id: '',
        },
        {
          id: 'duplicate',
          value: '1',
          unit: 'kg',
          primary_source_id: 'missing-source',
          evidence_id: 'missing-evidence',
        },
      ],
      conversion_steps: [{ id: '', description: '', formula: '', result: 'x', result_unit: '' }],
      normalization_denominator: {
        value: '0',
        unit: '',
        formula: '',
        source_value_ids: ['missing-value'],
      },
      formula: '',
      unrounded_result: 'not-a-number',
      result_unit: '',
      rounding: { mode: 'decimal_places', digits: 16 },
      primary_source_ids: ['missing-source'],
      evidence_ids: ['missing-evidence'],
      assumptions: [''],
    },
  });
  const badReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/bad-provenance.json',
    rawInput: badPlan,
    now,
  });
  assert.equal(badReport.calculation_provenance?.status, 'failed');
  for (const code of [
    'calculated_exchange_data_source_type_invalid',
    'calculation_provenance_required_field_invalid',
    'calculation_rounding_digits_invalid',
    'calculation_source_reference_missing',
    'calculation_evidence_reference_missing',
    'calculation_source_value_id_invalid',
    'calculation_source_value_invalid',
    'calculation_source_value_source_reference_invalid',
    'calculation_source_value_evidence_reference_invalid',
    'calculation_conversion_step_invalid',
    'calculation_normalization_invalid',
    'calculation_normalization_source_reference_missing',
    'calculation_result_amount_mismatch',
  ]) {
    assert.ok(
      badReport.blockers.some((finding) => finding.code === code),
      code,
    );
  }

  const invalidModePlan = strictSourceEvidencePlan();
  (strictProvenance(invalidModePlan).rounding as Record<string, unknown>).mode = 'bankers';
  const invalidModeReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/invalid-rounding-mode.json',
    rawInput: invalidModePlan,
    now,
  });
  assert.ok(
    invalidModeReport.blockers.some((finding) => finding.code === 'calculation_rounding_invalid'),
  );

  const missingArraysPlan = strictSourceEvidencePlan();
  strictProvenance(missingArraysPlan).source_values = null;
  strictProvenance(missingArraysPlan).rounding = null;
  const missingArraysReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/missing-arrays.json',
    rawInput: missingArraysPlan,
    now,
  });
  assert.equal(missingArraysReport.calculation_provenance?.status, 'failed');

  const missingOperationsPlan = strictSourceEvidencePlan();
  const missingOperations = strictProvenance(missingOperationsPlan);
  delete missingOperations.conversion_steps;
  delete missingOperations.normalization_denominator;
  const missingOperationsReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/missing-calculation-operations.json',
    rawInput: missingOperationsPlan,
    now,
  });
  assert.ok(
    missingOperationsReport.blockers.some(
      (finding) => finding.code === 'calculation_conversion_steps_missing',
    ),
  );
  assert.ok(
    missingOperationsReport.blockers.some(
      (finding) => finding.code === 'calculation_normalization_missing',
    ),
  );

  const invalidEvidenceSourcePlan = strictSourceEvidencePlan() as Record<string, unknown>;
  const evidenceManifest = invalidEvidenceSourcePlan.evidence_manifest as {
    evidence: Array<Record<string, unknown>>;
  };
  evidenceManifest.evidence[0]!.source_id = 'missing-source';
  const invalidEvidenceSourceReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/invalid-evidence-source.json',
    rawInput: invalidEvidenceSourcePlan,
    now,
  });
  assert.ok(
    invalidEvidenceSourceReport.blockers.some(
      (finding) => finding.code === 'calculation_evidence_source_reference_missing',
    ),
  );

  const crossBoundEvidencePlan = strictSourceEvidencePlan() as Record<string, unknown>;
  const crossBoundManifest = crossBoundEvidencePlan.evidence_manifest as {
    evidence: Array<Record<string, unknown>>;
  };
  crossBoundManifest.evidence[0]!.source_id = '11111111-1111-4111-8111-111111111111';
  const crossBoundReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/cross-bound-evidence-source.json',
    rawInput: crossBoundEvidencePlan,
    now,
  });
  assert.ok(
    crossBoundReport.blockers.some(
      (finding) => finding.code === 'calculation_source_value_evidence_source_mismatch',
    ),
  );

  evidenceManifest.evidence.push({ source_id: '22222222-2222-4222-8222-222222222222' });
  await runProcessBuildPlanValidate({
    inputPath: '/tmp/evidence-without-id.json',
    rawInput: invalidEvidenceSourcePlan,
    now,
  });

  const longCommentPlan = strictSourceEvidencePlan();
  strictProvenance(longCommentPlan).assumptions = ['x'.repeat(600)];
  const longCommentReport = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/long-comment.json',
    rawInput: longCommentPlan,
    now,
  });
  assert.equal(longCommentReport.status, 'passed', JSON.stringify(longCommentReport, null, 2));
  const longCommentPayload = __testInternals.materializePlan(
    longCommentPlan,
    'process',
    '/tmp/long-comment.json',
  ) as {
    processDataSet: { exchanges: { exchange: Array<Record<string, unknown>> } };
  };
  const longComments = longCommentPayload.processDataSet.exchanges.exchange[1]
    ?.generalComment as Array<{ '#text': string; '@xml:lang': string }>;
  assert.ok(longComments.length > 2);
  assert.ok(longComments.every((comment) => comment['#text'].length <= 500));
  assert.equal(
    longComments
      .filter((comment) => comment['@xml:lang'] === 'en')
      .map((comment) => comment['#text'])
      .join('')
      .split('x').length - 1,
    600,
  );
});

test('source-evidence strict mode accepts explicit N/A operations and deterministic rounding policies', async () => {
  const decimalPlan = strictSourceEvidencePlan();
  const decimalExchange = strictExchange(decimalPlan);
  const decimalProvenance = strictProvenance(decimalPlan);
  decimalExchange.mean_amount = '0.01';
  decimalExchange.resulting_amount = '0.01';
  delete decimalProvenance.conversion_steps;
  decimalProvenance.conversion_not_applicable_reason = 'Source and result use the same unit.';
  delete decimalProvenance.normalization_denominator;
  decimalProvenance.normalization_not_applicable_reason =
    'The source value is already expressed per functional unit.';
  decimalProvenance.source_values = [
    {
      id: 'reported_amount',
      value: '0.0149',
      unit: 'kg/kg',
      primary_source_id: '22222222-2222-4222-8222-222222222222',
      evidence_id: 'evidence-input-and-output',
    },
  ];
  decimalProvenance.formula = 'reported_amount';
  decimalProvenance.unrounded_result = '0.0149';
  decimalProvenance.rounding = { mode: 'decimal_places', digits: 2 };
  decimalProvenance.assumptions = ['The reported precision is two decimal places.'];
  decimalProvenance.primary_source_ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  (decimalPlan.publication.rights_decision as Record<string, unknown>).copyright = 'false';
  const decimalReport = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/decimal-rounding.json',
    rawInput: decimalPlan,
    now,
  });
  assert.equal(decimalReport.status, 'passed', JSON.stringify(decimalReport, null, 2));
  const decimalPayload = __testInternals.materializePlan(
    decimalPlan,
    'process',
    '/tmp/decimal-rounding.json',
  ) as {
    processDataSet: { exchanges: { exchange: Array<Record<string, unknown>> } };
  };
  const decimalSourceReferences = (
    decimalPayload.processDataSet.exchanges.exchange[1]?.referencesToDataSource as {
      referenceToDataSource: Array<{ '@refObjectId': string }>;
    }
  ).referenceToDataSource;
  assert.deepEqual(
    decimalSourceReferences.map((reference) => reference['@refObjectId']),
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  );
  assert.match(
    String(
      (
        decimalPayload.processDataSet.exchanges.exchange[1]?.generalComment as Array<{
          '#text': string;
        }>
      )[0]?.['#text'],
    ),
    /N\/A: Source and result use the same unit/u,
  );

  const significantPlan = strictSourceEvidencePlan();
  const significantExchange = strictExchange(significantPlan);
  const significantProvenance = strictProvenance(significantPlan);
  significantExchange.mean_amount = '0.012';
  significantExchange.resulting_amount = '0.012';
  significantProvenance.formula = '+(input_total / annual_output * 1.234)';
  significantProvenance.unrounded_result = '0.01234';
  significantProvenance.rounding = { mode: 'significant_figures', digits: 2 };
  const significantReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/significant-rounding.json',
    rawInput: significantPlan,
    now,
  });
  assert.equal(significantReport.status, 'passed');

  const implicitResultPlan = strictSourceEvidencePlan();
  delete strictExchange(implicitResultPlan).resulting_amount;
  const implicitResultReport = await runProcessBuildPlanValidate({
    inputPath: '/tmp/implicit-result.json',
    rawInput: implicitResultPlan,
    now,
  });
  assert.equal(implicitResultReport.status, 'passed');
  assert.equal(
    (
      __testInternals.calculationProvenanceArtifact(implicitResultPlan).exchanges as Array<
        Record<string, unknown>
      >
    )[0]?.resulting_amount,
    '0.01',
  );
});

test('source-evidence strict mode applies provenance to a calculated quantitative reference exchange', async () => {
  const plan = strictSourceEvidencePlan();
  const referenceProvenance = structuredClone(strictProvenance(plan));
  referenceProvenance.formula = 'input_total / input_total';
  referenceProvenance.unrounded_result = '1';
  referenceProvenance.result_unit = 'unit';
  referenceProvenance.rounding = { mode: 'none' };
  (plan as Record<string, unknown>).quantitative_reference_plan = {
    ...plan.quantitative_reference_plan,
    mean_amount: '1',
    resulting_amount: '1',
    data_source_type: 'Secondary',
    data_derivation_type_status: 'Calculated',
    calculation_provenance: referenceProvenance,
  };
  const report = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/calculated-reference.json',
    rawInput: plan,
    now,
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.calculation_provenance?.calculated_exchange_count, 2);
  const payload = __testInternals.materializePlan(
    plan,
    'process',
    '/tmp/calculated-reference.json',
  ) as {
    processDataSet: { exchanges: { exchange: Array<Record<string, unknown>> } };
  };
  const reference = payload.processDataSet.exchanges.exchange[0] ?? {};
  assert.equal(reference.dataSourceType, 'Secondary');
  assert.match(
    String((reference.generalComment as Array<{ '#text': string }>)[0]?.['#text']),
    /formula: input_total \/ input_total/u,
  );
  const provenanceArtifact = __testInternals.calculationProvenanceArtifact(plan);
  const referenceArtifact = (provenanceArtifact.exchanges as Array<Record<string, unknown>>).find(
    (entry) => entry.path === 'quantitative_reference_plan',
  );
  assert.equal(referenceArtifact?.flow_id, '190f39ca-0ec8-5aab-b2d9-c91fc55ee58d');
});

test('process build-plan verify emits stable hashes and blocks critical candidate drift', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'process-build-plan-verify-'));
  try {
    const inputPath = '/tmp/strict-process-plan.json';
    const plan = strictSourceEvidencePlan();
    const candidate = __testInternals.materializePlan(plan, 'process', inputPath);
    const passed = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: '/tmp/candidate.json',
      outDir,
      rawInput: plan,
      rawCandidate: candidate,
      now,
    });
    assert.equal(passed.status, 'passed');
    assert.equal(passed.next_action, 'use_verified_artifact');
    assert.equal(passed.invariant_verification?.status, 'passed');
    assert.equal(passed.invariant_verification?.authoring_mode, 'source-evidence/strict');
    assert.equal(passed.invariant_verification?.mismatch_count, 0);
    assert.equal(passed.invariant_verification?.calculated_exchange_count, 1);
    assert.match(passed.invariant_verification?.plan_sha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.match(passed.invariant_verification?.candidate_sha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(
      existsSync(path.join(outDir, 'outputs', 'build-plan-invariant-report.json')),
      true,
    );

    const drifted = structuredClone(candidate) as {
      processDataSet: { exchanges: { exchange: Array<{ meanAmount: string }> } };
    };
    drifted.processDataSet.exchanges.exchange[1]!.meanAmount = '0.02';
    const failed = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: '/tmp/drifted.json',
      rawInput: plan,
      rawCandidate: drifted,
      now,
      schemas: { process: passingSchema() },
    });
    assert.equal(failed.status, 'blocked');
    assert.equal(failed.invariant_verification?.status, 'failed');
    assert.ok((failed.invariant_verification?.mismatch_count ?? 0) > 0);
    assert.ok(failed.blockers.some((finding) => finding.code === 'critical_invariant_mismatch'));

    const rightsDrift = structuredClone(candidate) as {
      processDataSet: {
        administrativeInformation: {
          publicationAndOwnership: Record<string, unknown>;
        };
      };
    };
    rightsDrift.processDataSet.administrativeInformation.publicationAndOwnership[
      'common:copyright'
    ] = 'false';
    const rightsDriftReport = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: '/tmp/rights-drift-candidate.json',
      rawInput: plan,
      rawCandidate: rightsDrift,
      now,
      schemas: { process: passingSchema() },
    });
    assert.equal(rightsDriftReport.invariant_verification?.status, 'failed');
    assert.ok(
      rightsDriftReport.invariant_verification?.checks.some(
        (check) => check.path === 'publication_rights' && check.status === 'failed',
      ),
    );

    const embeddedPayloadPlan = strictSourceEvidencePlan() as Record<string, unknown>;
    const embeddedPayload = structuredClone(candidate) as {
      processDataSet: { exchanges: { exchange: Array<{ meanAmount: string }> } };
    };
    embeddedPayload.processDataSet.exchanges.exchange[1]!.meanAmount = '0.02';
    embeddedPayloadPlan.payload = embeddedPayload;
    const embeddedPayloadDrift = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: '/tmp/embedded-payload-candidate.json',
      rawInput: embeddedPayloadPlan,
      rawCandidate: embeddedPayload,
      now,
      schemas: { process: passingSchema() },
    });
    assert.equal(embeddedPayloadDrift.invariant_verification?.status, 'failed');
    assert.ok(
      embeddedPayloadDrift.blockers.some(
        (finding) => finding.code === 'critical_invariant_mismatch',
      ),
    );

    const pureReport = verifyProcessBuildPlanInvariants(plan, candidate, now, inputPath);
    assert.deepEqual(pureReport, passed.invariant_verification);

    const compatiblePlan = processPlan();
    const compatibleCandidate = __testInternals.materializePlan(
      compatiblePlan,
      'process',
      '<invariant-verification>',
    );
    assert.equal(
      verifyProcessBuildPlanInvariants(compatiblePlan, compatibleCandidate, now).status,
      'passed',
    );

    const candidateFile = path.join(outDir, 'candidate.json');
    writeFileSync(candidateFile, JSON.stringify(candidate), 'utf8');
    const fileCandidateReport = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: candidateFile,
      rawInput: plan,
      now,
    });
    assert.equal(fileCandidateReport.invariant_verification?.status, 'passed');

    const malformedProjection = verifyProcessBuildPlanInvariants(
      plan,
      {
        processDataSet: {
          exchanges: {
            exchange: [
              { generalComment: [{}] },
              { referenceToFlowDataSet: null, referencesToDataSource: null },
            ],
          },
        },
      },
      now,
    );
    assert.equal(malformedProjection.status, 'failed');
    assert.ok(malformedProjection.mismatch_count > 0);

    const blockedPlan = strictSourceEvidencePlan({ calculation_provenance: null });
    const blockedVerify = await runProcessBuildPlanVerify({
      inputPath: '/tmp/blocked-plan.json',
      candidatePath: '/tmp/candidate.json',
      rawInput: blockedPlan,
      rawCandidate: candidate,
      now,
    });
    assert.equal(blockedVerify.invariant_verification?.status, 'not_applicable');

    await assert.rejects(
      () =>
        runProcessBuildPlanVerify({
          inputPath: '/tmp/strict-process-plan.json',
          candidatePath: '/tmp/candidate.json',
          rawInput: plan,
          rawCandidate: 1,
          now,
        }),
      /build-plan candidate must be a JSON object/u,
    );
    await assert.rejects(
      () =>
        runProcessBuildPlanVerify({
          inputPath: '/tmp/strict-process-plan.json',
          rawInput: plan,
          now,
        }),
      /Missing required --candidate value/u,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('process build-plan verify preserves generated identities without trusting candidate UUIDs', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'process-generated-identity-'));
  try {
    for (const [mode, plan] of [
      ['compatibility', processPlan()],
      ['strict', strictSourceEvidencePlan()],
    ] as const) {
      const inputPath = path.join(outDir, `${mode}-plan.json`);
      const materialized = await runProcessBuildPlanMaterialize({
        inputPath,
        outDir: path.join(outDir, mode),
        rawInput: plan,
        now,
      });
      assert.equal(materialized.status, 'passed');
      const candidatePath = materialized.files.materialized_artifact;
      assert.ok(candidatePath);
      const verified = await runProcessBuildPlanVerify({
        inputPath,
        candidatePath,
        rawInput: plan,
        now,
      });
      assert.equal(verified.status, 'passed', JSON.stringify(verified, null, 2));
      assert.equal(verified.invariant_verification?.mismatch_count, 0);

      const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
        processDataSet: { processInformation: { dataSetInformation: { 'common:UUID': string } } };
      };
      candidate.processDataSet.processInformation.dataSetInformation['common:UUID'] =
        '44444444-4444-4444-8444-444444444444';
      const drifted = await runProcessBuildPlanVerify({
        inputPath,
        candidatePath,
        rawInput: plan,
        rawCandidate: candidate,
        now,
      });
      assert.equal(drifted.status, 'blocked');
      assert.ok(
        drifted.invariant_verification?.checks.some(
          (check) => check.path === 'dataset_uuid' && check.status === 'failed',
        ),
      );
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('process build-plan verify protects reference year, geography, and complete source identities', async () => {
  const inputPath = '/tmp/protected-process-plan.json';
  const sourcePlan = strictSourceEvidencePlan();
  const plan = {
    ...sourcePlan,
    target: {
      ...sourcePlan.target,
      uuid: '44444444-4444-4444-8444-444444444444',
      reference_year: 2025,
    },
  };
  const candidate = __testInternals.materializePlan(plan, 'process', inputPath);
  const baseline = await runProcessBuildPlanVerify({
    inputPath,
    candidatePath: '/tmp/protected-candidate.json',
    rawInput: plan,
    rawCandidate: candidate,
    now,
  });
  assert.equal(baseline.status, 'passed');
  assert.equal(verifyProcessBuildPlanInvariants(plan, candidate, now).status, 'passed');

  const exchangeSourcePath = [
    'exchanges',
    'exchange',
    1,
    'referencesToDataSource',
    'referenceToDataSource',
  ];
  const processSourcePath = [
    'modellingAndValidation',
    'dataSourcesTreatmentAndRepresentativeness',
    'referenceToDataSource',
  ];
  const cases = [
    {
      name: 'reference year',
      path: ['processInformation', 'time', 'common:referenceYear'],
      value: 2024,
      check: 'reference_year',
    },
    {
      name: 'geography',
      path: [
        'processInformation',
        'geography',
        'locationOfOperationSupplyOrProduction',
        '@location',
      ],
      value: 'US',
      check: 'geography',
    },
    {
      name: 'exchange source UUID',
      path: [...exchangeSourcePath, '@refObjectId'],
      value: '55555555-5555-4555-8555-555555555555',
      check: 'exchanges[2].source_references',
    },
    {
      name: 'exchange source version',
      path: [...exchangeSourcePath, '@version'],
      value: '02.00.000',
      check: 'exchanges[2].source_references',
    },
    {
      name: 'process source UUID',
      path: [...processSourcePath, '@refObjectId'],
      value: '55555555-5555-4555-8555-555555555555',
      check: 'source_references',
    },
    {
      name: 'process source version',
      path: [...processSourcePath, '@version'],
      value: '02.00.000',
      check: 'source_references',
    },
  ];
  for (const drift of cases) {
    const changed = structuredClone(candidate);
    let container: unknown = changed.processDataSet;
    for (const segment of drift.path.slice(0, -1)) {
      assert.ok(container !== null && typeof container === 'object');
      container = (container as Record<string | number, unknown>)[segment];
    }
    assert.ok(container !== null && typeof container === 'object');
    (container as Record<string | number, unknown>)[drift.path.at(-1)!] = drift.value;
    const report = await runProcessBuildPlanVerify({
      inputPath,
      candidatePath: '/tmp/protected-candidate.json',
      rawInput: plan,
      rawCandidate: changed,
      now,
    });
    assert.equal(report.schema_validation.status, 'passed', drift.name);
    assert.equal(report.status, 'blocked', drift.name);
    assert.ok(
      report.invariant_verification?.checks.some(
        (check) => check.path === drift.check && check.status === 'failed',
      ),
      drift.name,
    );
  }
});

test('canonical JSON sorts object keys with default code-point lexical order', () => {
  const canonical = __testInternals.canonicalJsonValue({
    a: 7,
    A: 6,
    _: 5,
    Z: 4,
    '-': 2,
    '!': 1,
    nested: { z: 3, Z: 2, _: 1 },
  }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(canonical), ['!', '-', 'A', 'Z', '_', 'a', 'nested']);
  assert.deepEqual(Object.keys(canonical.nested as Record<string, unknown>), ['Z', '_', 'z']);
});

test('process build-plan materialize validates supplied canonical payloads', async () => {
  const suppliedPayload = __testInternals.buildCanonicalProcessPayload(
    processPlan(),
    '/tmp/supplied-process-payload.json',
  );
  const report = await runProcessBuildPlanMaterialize({
    inputPath: '/tmp/process-build-plan.json',
    rawInput: processPlan({
      payload: suppliedPayload,
    }),
    now,
    schemas: {
      process: passingSchema(),
    },
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.schema_validation.status, 'passed');
  assert.equal(report.schema_validation.validator, 'injected');
});

test('label and canonical paths retain locked SDK classification validation', async () => {
  const processOutDir = mkdtempSync(path.join(os.tmpdir(), 'process-current-classification-'));
  const flowOutDir = mkdtempSync(path.join(os.tmpdir(), 'flow-current-classification-'));
  try {
    const canonicalProcessPath = PROCESS_REMEDIATION_PATH.map((label, index) => ({
      '@level': String(index),
      '@classId': ['E', '39', '390', '3900'][index],
      '#text': label,
    }));
    for (const classificationPath of [PROCESS_REMEDIATION_PATH, canonicalProcessPath]) {
      const processReport = await runProcessBuildPlanMaterialize({
        inputPath: '/tmp/process-current-classification.json',
        outDir: processOutDir,
        rawInput: processPlan({ classification_path: classificationPath }),
        now,
      });
      assert.equal(processReport.status, 'passed', JSON.stringify(processReport, null, 2));
      assert.equal(processReport.schema_validation.status, 'passed');
      const materialized = JSON.parse(
        readFileSync(path.join(processOutDir, 'outputs/materialized-process.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(
        classificationItemsAt(materialized, [
          'processDataSet',
          'processInformation',
          'dataSetInformation',
          'classificationInformation',
          'common:classification',
          'common:class',
        ]),
        canonicalProcessPath,
      );
    }

    const flowReport = await runFlowBuildPlanMaterialize({
      inputPath: '/tmp/flow-current-classification.json',
      outDir: flowOutDir,
      rawInput: flowPlan({
        target: { flow_type: 'Elementary flow' },
        classificationPath: ELEMENTARY_AIR_INDOOR_PATH,
      }),
      now,
    });
    assert.equal(flowReport.status, 'passed', JSON.stringify(flowReport, null, 2));
    assert.equal(flowReport.schema_validation.status, 'passed');
  } finally {
    rmSync(processOutDir, { recursive: true, force: true });
    rmSync(flowOutDir, { recursive: true, force: true });
  }
});

test('process build-plan verify validates the actual candidate when the plan embeds a payload', async () => {
  const sourcePlan = strictSourceEvidencePlan();
  const plan = {
    ...sourcePlan,
    target: { ...sourcePlan.target, uuid: '44444444-4444-4444-8444-444444444444' },
  };
  const payload = __testInternals.buildCanonicalProcessPayload(plan, '/tmp/strict-plan.json');
  assert.equal(
    __testInternals.validateMaterializedSchema(payload, 'process', undefined).status,
    'passed',
  );
  const candidate = structuredClone(payload);
  const process = candidate.processDataSet as Record<string, unknown>;
  const information = process.processInformation as Record<string, unknown>;
  const dataSetInformation = information.dataSetInformation as Record<string, unknown>;
  delete dataSetInformation.name;

  const report = await runProcessBuildPlanVerify({
    inputPath: '/tmp/strict-plan.json',
    candidatePath: '/tmp/invalid-candidate.json',
    rawInput: { ...plan, payload },
    rawCandidate: candidate,
    now,
  });

  assert.equal(
    report.invariant_verification?.status,
    'passed',
    JSON.stringify(report.invariant_verification, null, 2),
  );
  assert.equal(report.schema_validation.status, 'failed');
  assert.equal(report.status, 'blocked');
  assert.ok(report.blockers.some((finding) => finding.code === 'materialized_schema_failed'));
});

test('strict provenance helpers retain sparse-input and invariant projection behavior', () => {
  assert.deepEqual(
    __testInternals.calculatedExchangeEntries({ exchange_plan: { exchanges: [null, 'x'] } }),
    [],
  );
  assert.deepEqual(__testInternals.evidenceRecords({ evidence_manifest: 'invalid' }), []);
  assert.deepEqual(
    __testInternals.evidenceRecords({ evidence_manifest: { evidence: 'invalid' } }),
    [],
  );
  assert.equal(
    __testInternals.evidenceRecordId({ evidence_id: 'evidence-alias' }),
    'evidence-alias',
  );
  assert.equal(
    __testInternals.evidenceRecordSourceId({ primary_source_id: 'source-alias' }),
    'source-alias',
  );
  assert.equal(__testInternals.roundedResult({ unrounded_result: '1', rounding: null }), null);
  assert.equal(
    __testInternals.roundedResult({
      unrounded_result: '1',
      rounding: { mode: 'decimal_places', digits: 'not-an-integer' },
    }),
    null,
  );
  const sparseComment = __testInternals.provenanceComment({
    calculation_provenance: {
      source_values: null,
      conversion_steps: null,
      conversion_not_applicable_reason: 'not applicable',
      normalization_not_applicable_reason: 'not applicable',
      formula: 'one',
      unrounded_result: '1',
      result_unit: 'kg',
      rounding: null,
      primary_source_ids: null,
      evidence_ids: null,
      assumptions: null,
    },
  });
  assert.match(String(sparseComment?.[0]?.['#text']), /convert: N\/A: not applicable/u);
  assert.deepEqual(__testInternals.sourceReferenceIds({ '@refObjectId': 'one' }), ['one']);
  assert.deepEqual(__testInternals.sourceReferenceIds([{}, { '@refObjectId': 'two' }]), ['two']);
  assert.deepEqual(__testInternals.localizedTextProjection({}), [{ lang: null, text: '' }]);
  assert.equal(__testInternals.canonicalJsonValue(undefined), null);
  assert.equal(
    (__testInternals.referenceExchange({}).referenceToFlowDataSet as Record<string, unknown>)[
      '@type'
    ],
    'flow data set',
  );

  const strictArtifactPlan = strictSourceEvidencePlan();
  const artifact = __testInternals.calculationProvenanceArtifact(strictArtifactPlan);
  assert.equal(artifact.calculated_exchange_count, 1);
  const critical = __testInternals.processCriticalProjection(
    (
      __testInternals.materializePlan(
        strictArtifactPlan,
        'process',
        '/tmp/strict-artifact.json',
      ) as { processDataSet: Record<string, unknown> }
    ).processDataSet,
  );
  assert.equal(Array.isArray(critical.exchanges), true);
});

test('Flow addition gates reject invalid before documents, stale identities and embedded property loss', async () => {
  const plan = JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/flow-plan.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, any>;
  const before = plan.flow_property_plan.before_flow;
  const candidate = __testInternals.buildCanonicalFlowPayload(plan, 'addition.json');
  for (const name of ['uuid', 'version']) {
    const changed = structuredClone(plan);
    changed.target[name] = name === 'uuid' ? '20000000-0000-4000-8000-000000000002' : '99.00.000';
    const report = await runFlowBuildPlanValidate({
      inputPath: 'addition.json',
      rawInput: changed,
    });
    assert.ok(report.blockers.some((item) => item.code === 'flow_property_identity_changed'));
  }
  const brokenBefore = structuredClone(plan);
  brokenBefore.flow_property_plan.before_flow.flowDataSet.flowProperties.flowProperty[0].meanValue =
    '2';
  brokenBefore.payload = candidate;
  assert.ok(
    (
      await runFlowBuildPlanValidate({ inputPath: 'addition.json', rawInput: brokenBefore })
    ).blockers.some((item) => item.code === 'before_flow_property_reference_not_normalized'),
  );
  const removed = structuredClone(candidate) as Record<string, any>;
  removed.flowDataSet.flowProperties.flowProperty = [];
  const removal = await runFlowBuildPlanValidate({
    inputPath: 'addition.json',
    rawInput: { ...plan, payload: removed },
  });
  assert.ok(removal.blockers.some((item) => item.code === 'flow_property_existing_value_changed'));
  const barePlan = structuredClone(plan);
  barePlan.flow_property_plan.before_flow = before.flowDataSet;
  assert.equal(
    (await runFlowBuildPlanValidate({ inputPath: 'addition.json', rawInput: barePlan })).status,
    'passed',
  );
  assert.equal(
    verifyFlowBuildPlanInvariants(
      { ...plan, payload: candidate.flowDataSet },
      candidate.flowDataSet as Record<string, unknown>,
    ).status,
    'passed',
  );
  const incomplete = structuredClone(plan);
  incomplete.flow_property_plan.before_flow = {};
  assert.equal(
    (await runFlowBuildPlanValidate({ inputPath: 'addition.json', rawInput: incomplete })).status,
    'blocked',
  );
  const malformed = structuredClone(plan);
  malformed.flow_property_plan.properties = [null, ...malformed.flow_property_plan.properties];
  assert.equal(
    (await runFlowBuildPlanValidate({ inputPath: 'addition.json', rawInput: malformed })).status,
    'blocked',
  );
  delete malformed.flow_property_plan.reference_internal_id;
  assert.equal(
    (await runFlowBuildPlanValidate({ inputPath: 'addition.json', rawInput: malformed })).status,
    'blocked',
  );
});

test('Process conversion refuses missing identities, duplicate ports, stale result precision and unbound source amount', async () => {
  const baseline = JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/process-plan.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, any>;
  const operation = JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/operation-report.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, any>;
  const spawn = ((_exe: string, args: string[]) => ({
    pid: 1,
    output: [],
    stdout: JSON.stringify(
      args[0] === 'version'
        ? {
            ...operation,
            command: 'version',
            summary: {
              binary_version: '0.3.0',
              operation_report_schema: 'tidas.operation-report.v1',
            },
          }
        : operation,
    ),
    stderr: '',
    status: 0,
    signal: null,
  })) as unknown as typeof spawnSync;
  const options = {
    inputPath: 'conversion.json',
    spawnImpl: spawn,
    tidasBin: 'tidas-test',
    env: {},
  };
  const entry = (plan: Record<string, any>) => plan.exchange_plan.exchanges[0];
  const binding = (plan: Record<string, any>) =>
    entry(plan).calculation_provenance.flow_property_conversion;
  for (const mutation of [
    (p: Record<string, any>) => delete entry(p).internal_id,
    (p: Record<string, any>) => p.exchange_plan.exchanges.push(structuredClone(entry(p))),
    (p: Record<string, any>) => delete entry(p).flow_id,
    (p: Record<string, any>) => delete entry(p).version,
    (p: Record<string, any>) => delete binding(p).request.flow,
    (p: Record<string, any>) => delete binding(p).request.source,
    (p: Record<string, any>) => (entry(p).resulting_amount = '2000.00000000000000000000000001'),
    (p: Record<string, any>) => (binding(p).request.source.amount = '2.00000000000000000000000001'),
  ]) {
    const changed = structuredClone(baseline);
    mutation(changed);
    assert.equal(
      (await runProcessBuildPlanValidate({ ...options, rawInput: changed })).status,
      'blocked',
    );
  }
  const bare = structuredClone(baseline);
  binding(bare).request.flow = binding(bare).request.flow.flowDataSet;
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: bare })).status,
    'passed',
  );
  const omittedResult = structuredClone(baseline);
  delete entry(omittedResult).resulting_amount;
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: omittedResult })).status,
    'passed',
  );
  const noReference = structuredClone(baseline);
  delete noReference.quantitative_reference_plan;
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: noReference })).status,
    'blocked',
  );
  const ratioNoReference = structuredClone(baseline);
  delete ratioNoReference.quantitative_reference_plan.reference_unit;
  entry(ratioNoReference).calculation_provenance.result_unit = 'm3/kg';
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: ratioNoReference })).status,
    'blocked',
  );
  const reference = structuredClone(baseline);
  reference.quantitative_reference_plan = {
    ...entry(reference),
    reference_flow_id: entry(reference).flow_id,
    reference_flow_version: entry(reference).version,
    reference_flow_internal_id: '1',
    reference_unit: 'kg',
  };
  reference.exchange_plan.exchanges = [];
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: reference })).status,
    'passed',
  );
  delete reference.quantitative_reference_plan.reference_flow_version;
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: reference })).status,
    'passed',
  );
  const defaultRatio = structuredClone(baseline);
  delete defaultRatio.quantitative_reference_plan.mean_amount;
  delete defaultRatio.quantitative_reference_plan.resulting_amount;
  entry(defaultRatio).calculation_provenance.result_unit = 'm3/kg';
  assert.equal(
    (await runProcessBuildPlanValidate({ ...options, rawInput: defaultRatio })).status,
    'passed',
  );
});

test('quantity projection preserves finite decimal tokens and safely omits absent converted bounds', () => {
  for (const provenance of [
    undefined,
    {},
    { flow_property_conversion: {} },
    { flow_property_conversion: { report: {} } },
  ]) {
    assert.deepEqual(
      __testInternals.convertedExchangeQuantities({ calculation_provenance: provenance }),
      {},
    );
  }
  assert.deepEqual(
    __testInternals.convertedExchangeQuantities({
      mean_amount: '2',
      calculation_provenance: {
        flow_property_conversion: {
          report: { result: { amount: '2', minimum_amount: null, maximum_amount: null } },
        },
      },
    }),
    { meanAmount: '2', resultingAmount: '2' },
  );
  const plan = processPlan();
  (plan.quantitative_reference_plan as Record<string, unknown>).mean_amount = 'not-finite';
  assert.equal(__testInternals.referenceExchange(plan).meanAmount, 'not-finite');
  const artifact = __testInternals.buildCanonicalProcessPayload(plan, 'malformed.json') as Record<
    string,
    any
  >;
  artifact.processDataSet.exchanges.exchange[0].minimumAmount = '0.9';
  artifact.processDataSet.exchanges.exchange[0].maximumAmount = '1.1';
  const projection = __testInternals.processCriticalProjection(artifact) as Record<string, any>;
  assert.equal(projection.exchanges[0].minimum_amount, '0.9');
});

test('BuildPlan gates reject mixed classification entries and preserve ordinary exchange comments', async () => {
  const invalid = processPlan();
  (invalid.target as Record<string, unknown>).classification_path = [
    energyProcessClassification[0],
    'invalid mixed label',
  ];
  const report = await runProcessBuildPlanValidate({
    inputPath: 'invalid-classification.json',
    rawInput: invalid,
  });
  assert.ok(report.blockers.some((item) => item.code === 'build_plan_classification_invalid'));
  const normal = processPlan({
    exchange_plan: {
      exchanges: [{ internal_id: '2', general_comment: 'Retained original exchange note.' }],
    },
  });
  const payload = __testInternals.buildCanonicalProcessPayload(normal, 'comment.json') as Record<
    string,
    any
  >;
  assert.equal(
    payload.processDataSet.exchanges.exchange[1].generalComment[0]['#text'],
    'Retained original exchange note.',
  );
  const singleton = { '@refObjectId': evidenceSourceId, '@version': '01.00.000' };
  payload.processDataSet.exchanges.exchange[0].referencesToDataSource.referenceToDataSource =
    singleton;
  const projected = __testInternals.processCriticalProjection(payload) as Record<string, any>;
  assert.deepEqual(projected.exchanges[0].source_references, [
    { uuid: evidenceSourceId, version: '01.00.000' },
  ]);
  payload.processDataSet.exchanges.exchange[0].referencesToDataSource.referenceToDataSource = [
    singleton,
    { ...singleton, '@version': '01.00.001' },
  ];
  const multiple = __testInternals.processCriticalProjection(payload) as Record<string, any>;
  assert.deepEqual(multiple.exchanges[0].source_references, [
    { uuid: evidenceSourceId, version: '01.00.000' },
    { uuid: evidenceSourceId, version: '01.00.001' },
  ]);
});

test('gate exceptions retain typed errors and fail closed for corrupt local assets or non-Error native failures', () => {
  assert.deepEqual(
    __testInternals.gateException(
      new CliError('Known problem', { code: 'KNOWN_PROBLEM', exitCode: 2 }),
      'fallback',
      'Fallback',
    ),
    { code: 'known_problem', message: 'Known problem' },
  );
  assert.deepEqual(
    __testInternals.gateException(
      new SyntaxError('Corrupt local JSON asset'),
      'asset_invalid',
      'Fallback',
    ),
    { code: 'asset_invalid', message: 'Corrupt local JSON asset' },
  );
  assert.deepEqual(
    __testInternals.gateException(
      'native failure',
      'conversion_invalid',
      'Native conversion failed.',
    ),
    { code: 'conversion_invalid', message: 'Native conversion failed.' },
  );
});
