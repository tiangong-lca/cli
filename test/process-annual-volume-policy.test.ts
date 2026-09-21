import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import { runDatasetValidate } from '../src/lib/dataset-validate.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import {
  collectProcessRequiredFieldIssues,
  runProcessRequiredFieldsComplete,
} from '../src/lib/process-required-fields.js';
import {
  validateProcessPayload,
  summarizeProcessPayloadValidation,
} from '../src/lib/process-payload-validation.js';
import { runDatasetSaveDraft } from '../src/lib/dataset-save-draft-run.js';
import { resolveTidasSdkPath } from './helpers/tidas-sdk-path.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

function fixture(): JsonRecord {
  return JSON.parse(
    readFileSync(resolveTidasSdkPath('test-data', 'process-annual-volume.json'), 'utf8'),
  ) as JsonRecord;
}

function sources(payload: JsonRecord): JsonRecord {
  return record(
    record(record(payload.processDataSet).modellingAndValidation)
      .dataSourcesTreatmentAndRepresentativeness,
  );
}

async function complete(payload: JsonRecord) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-annual-policy-'));
  try {
    const outPath = path.join(directory, 'completed.jsonl');
    const report = await runProcessRequiredFieldsComplete({
      inputPath: 'annual-volume-fixture',
      rawInput: [payload],
      outPath,
      outDir: directory,
      defaultUnit: 'kg',
    });
    const output = JSON.parse(readFileSync(outPath, 'utf8').trim()) as JsonRecord;
    return { report, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('unknown annual volume is SDK-valid but completion retains the evidence gap', async () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [];
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  const before = structuredClone(payload);
  const { report, output } = await complete(payload);
  assert.deepEqual(payload, before, 'the caller-owned input must not be changed');
  assert.deepEqual(sources(output).annualSupplyOrProductionVolume, []);
  assert.equal(report.status, 'completed_with_blockers');
  assert.equal(report.counts.blocked, 1);
  assert.ok(
    report.rows[0]?.issues.some(
      (issue) => issue.code === 'annual_supply_or_production_volume_missing',
    ),
  );
  assert.equal(
    report.rows[0]?.completions.some((item) => item.amount === '9999'),
    false,
  );
});

test('absent annual volume becomes an explicit unknown without reference-amount fallback', async () => {
  const payload = fixture();
  delete sources(payload).annualSupplyOrProductionVolume;
  const { report, output } = await complete(payload);
  assert.deepEqual(sources(output).annualSupplyOrProductionVolume, []);
  assert.equal(ProcessSchema.safeParse(structuredClone(output)).success, true);
  assert.equal(report.status, 'completed_with_blockers');
});

test('historical sentinel is not authoring evidence, while a real 9999 quantity is preserved', async () => {
  const sentinel = fixture();
  sources(sentinel).annualSupplyOrProductionVolume = [
    { '@xml:lang': 'en', '#text': '9999 missing-data-sentinel/year' },
  ];
  assert.ok(
    collectProcessRequiredFieldIssues(sentinel).some(
      (issue) => issue.code === 'annual_supply_or_production_volume_missing',
    ),
  );
  const normalized = await complete(sentinel);
  assert.deepEqual(sources(normalized.output).annualSupplyOrProductionVolume, []);
  assert.equal(normalized.report.status, 'completed_with_blockers');

  const real = fixture();
  const values = [
    { '@xml:lang': 'zh', '#text': '9999 kg/年' },
    { '@xml:lang': 'en', '#text': '9999 kg/year' },
  ];
  sources(real).annualSupplyOrProductionVolume = values;
  assert.equal(ProcessSchema.safeParse(structuredClone(real)).success, true);
  const preserved = await complete(real);
  assert.deepEqual(sources(preserved.output).annualSupplyOrProductionVolume, values);
  assert.equal(preserved.report.status, 'completed');
});

test('legacy deferred trace cannot waive an unknown annual-volume evidence gap', () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [];
  const info = record(record(record(payload.processDataSet).processInformation).dataSetInformation);
  info['common:other'] = {
    'tiangongfoundry:unresolvedTrace': [
      {
        status: 'unresolved_deferred',
        action_item_code: 'annual_supply_or_production_volume_missing',
        blocked_path:
          'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      },
    ],
  };
  assert.ok(
    collectProcessRequiredFieldIssues(payload).some(
      (issue) => issue.code === 'annual_supply_or_production_volume_missing',
    ),
  );
});

test('dataset validation separates schema success from authoring evidence failure on exact content', async () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [];
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  const before = JSON.stringify(payload);
  const report = await runDatasetValidate({
    inputPath: 'annual-volume-fixture',
    rawInput: [payload],
    type: 'process',
  });
  const row = record(report.rows[0]);
  const layers = record(row.validation_layers);
  assert.equal(record(layers.schema).status, 'passed');
  assert.equal(record(layers.authoring_evidence).status, 'failed');
  assert.equal(record(layers.content).status, 'passed');
  assert.equal(record(layers.multilingual).status, 'passed');
  assert.equal(row.payload_sha256, sha256Json(payload));
  assert.equal(
    row.status,
    'invalid',
    'structure-only success cannot imply write or publication readiness',
  );
  assert.equal(JSON.stringify(payload), before);
  const saveValidation = record(validateProcessPayload(payload));
  assert.equal(record(record(saveValidation.validation_layers).schema).status, 'passed');
  assert.equal(saveValidation.ok, false);
  assert.match(
    summarizeProcessPayloadValidation(validateProcessPayload(payload)),
    /schema: passed/u,
  );
  assert.match(
    summarizeProcessPayloadValidation(validateProcessPayload(payload)),
    /authoring_evidence: failed/u,
  );
});

test('native draft preparation retains the same content-bound validation layers without dispatch', async () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-annual-native-'));
  try {
    const report = await runDatasetSaveDraft({
      inputPath: 'annual-volume-fixture',
      rawInput: [payload],
      type: 'process',
      outDir: directory,
      fetchImpl: async () => {
        throw new Error('A local validation case must not call remote transport');
      },
    });
    assert.equal(report.counts.executed, 0);
    assert.equal(report.counts.failed, 1);
    const validation = record(report.rows[0]?.validation);
    assert.equal(validation.payload_sha256, sha256Json(payload));
    const layers = record(validation.validation_layers);
    assert.equal(record(layers.schema).status, 'passed');
    assert.equal(record(layers.authoring_evidence).status, 'failed');
    assert.equal(validation.ok, false);
    assert.deepEqual(
      validation,
      validateProcessPayload(payload),
      'both draft command families must consume one Process validation policy',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate language values remain a multilingual failure without losing the exact candidate', async () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [
    { '@xml:lang': 'en', '#text': '100 kg/year' },
    { '@xml:lang': 'en', '#text': '200 kg/year' },
  ];
  const before = structuredClone(payload);
  const report = await runDatasetValidate({
    inputPath: 'annual-volume-fixture',
    rawInput: [payload],
    type: 'process',
  });
  const row = record(report.rows[0]);
  const multilingual = record(record(row.validation_layers).multilingual);
  assert.equal(multilingual.status, 'failed');
  assert.ok(
    (multilingual.issues as Array<{ code: string }>).some(
      (x) => x.code === 'duplicate_language_entry',
    ),
  );
  assert.deepEqual(payload, before);
  assert.equal(row.payload_sha256, sha256Json(before));
  assert.equal(row.status, 'invalid');
});

test('completion preserves malformed annual shapes for schema diagnosis instead of fabricating a quantity', async () => {
  for (const malformed of [
    7,
    {},
    { '@xml:lang': 'en', '#text': 7 },
    ['Not specified'],
    [null],
    [{ '#text': 'Not specified' }],
    [{ '@xml:lang': '', '#text': 'Not specified' }],
    [{ '@xml:lang': 'en', value: 'Not specified' }],
  ]) {
    const payload = fixture();
    sources(payload).annualSupplyOrProductionVolume = malformed;
    assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, false);
    const { report, output } = await complete(payload);
    assert.deepEqual(sources(output).annualSupplyOrProductionVolume, malformed);
    assert.equal(report.status, 'completed_with_blockers');
    assert.equal(ProcessSchema.safeParse(structuredClone(output)).success, false);
  }
});

test('explicit annual evidence keeps its existing year unit and rejects a nonnumeric amount', async () => {
  for (const [amount, unit, expected] of [
    ['2', 'kg/year', [{ '@xml:lang': 'en', '#text': '2 kg/year' }]],
    ['not-a-number', 'kg', []],
  ] as const) {
    const payload = fixture();
    sources(payload).annualSupplyOrProductionVolume = [];
    const wrapped = {
      json_ordered: payload,
      evidence_manifest: {
        field_bindings: [
          {
            field_path:
              'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
            amount,
            unit,
          },
        ],
      },
    };
    const { report, output } = await complete(wrapped);
    assert.deepEqual(sources(record(output.json_ordered)).annualSupplyOrProductionVolume, expected);
    assert.equal(report.status, amount === '2' ? 'completed' : 'completed_with_blockers');
  }
});

test('classification records are not mistaken for one multilingual annual-volume field', async () => {
  const payload = fixture();
  const info = record(record(record(payload.processDataSet).processInformation).dataSetInformation);
  const classification = record(record(info.classificationInformation)['common:classification']);
  const classes = classification['common:class'] as JsonRecord[];
  for (const entry of classes) entry['@xml:lang'] = 'en';
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  const report = await runDatasetValidate({
    inputPath: 'annual-volume-fixture',
    rawInput: [payload],
    type: 'process',
  });
  assert.equal(report.rows[0]?.status, 'valid');
  assert.equal(report.rows[0]?.validation_layers?.multilingual.status, 'passed');
});

test('nested SDK union diagnostics retain the exact invalid-language path in the multilingual layer', async () => {
  const payload = fixture();
  sources(payload).annualSupplyOrProductionVolume = [
    { '@xml:lang': 'not-a-language', '#text': '100 kg/year' },
  ];
  const report = await runDatasetValidate({
    inputPath: 'annual-volume-fixture',
    rawInput: [payload],
    type: 'process',
  });
  const row = report.rows[0];
  assert.equal(row?.status, 'invalid');
  assert.equal(row?.validation_layers?.schema.status, 'failed');
  assert.equal(row?.validation_layers?.multilingual.status, 'failed');
  assert.ok(
    row?.validation_layers?.multilingual.issues.some((issue) =>
      issue.path.endsWith('annualSupplyOrProductionVolume.0.@xml:lang'),
    ),
  );
});
