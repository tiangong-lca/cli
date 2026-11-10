import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import { runDatasetValidate } from '../src/lib/dataset/validate.js';
import { sha256Json } from '../src/lib/platform/canonical-json-hash.js';
import { collectProcessRequiredFieldIssues } from '../src/lib/validation/process-required-fields.js';
import {
  validateProcessPayload,
  summarizeProcessPayloadValidation,
} from '../src/lib/validation/process-payload-validation.js';
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
