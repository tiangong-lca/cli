import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { maintenanceProjectedReferenceFingerprint } from '../src/lib/dataset-maintenance-plan.js';
import {
  sha256Json,
  type DatasetMaintenanceRemoteRow,
} from '../src/lib/dataset-maintenance-contract.js';
import { runDatasetRemoteRefresh } from '../src/lib/dataset-remote-refresh.js';
import {
  collectRemoteReferences,
  runDatasetRemoteVerify,
} from '../src/lib/dataset-remote-verify.js';

const modelId = '00000000-0000-4000-8000-000000000001';
const processId = '00000000-0000-4000-8000-000000000002';
const older = '00.00.001';
const newer = '00.00.002';
const provenancePath =
  '/processDataSet/processInformation/dataSetInformation/generatedFromLifecycleModel';
const predecessorPath =
  '/lifeCycleModelDataSet/administrativeInformation/publicationAndOwnership/common:referenceToPrecedingDataSetVersion';

function processRow(typed = false) {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': processId,
          generatedFromLifecycleModel: {
            ...(typed ? { type: 'life cycle model data set' } : {}),
            id: modelId,
            version: older,
            role: 'primary',
          },
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': newer } },
    },
  };
}

function modelRow(array = false) {
  const predecessor = {
    '@type': 'other external file',
    '@refObjectId': modelId,
    '@version': older,
    '@uri': `../lifecyclemodels/${modelId}_${older}.xml`,
    'common:shortDescription': { '@xml:lang': 'en', '#text': 'Published predecessor' },
  };
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: { dataSetInformation: { 'common:UUID': modelId } },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': newer,
          'common:referenceToPrecedingDataSetVersion': array ? [predecessor] : predecessor,
        },
      },
    },
  };
}

test('historical Model references retain the existing maintenance fingerprint and shared collector', () => {
  const rows: DatasetMaintenanceRemoteRow[] = [
    { table: 'processes', id: processId, json_ordered: processRow() },
    { table: 'lifecyclemodels', id: modelId, json_ordered: modelRow() },
  ].map((row) => ({
    ...row,
    version: newer,
    user_id: null,
    state_code: 0,
    modified_at: null,
    model_id: null,
    rule_verification: null,
  })) as DatasetMaintenanceRemoteRow[];
  const expected = [
    {
      source: `lifecyclemodels\u0000${modelId}\u0000${newer}`,
      table: null,
      id: modelId,
      version: older,
      path: predecessorPath,
    },
    {
      source: `processes\u0000${processId}\u0000${newer}`,
      table: null,
      id: modelId,
      version: older,
      path: provenancePath,
    },
  ];
  const fingerprint = maintenanceProjectedReferenceFingerprint(rows);
  assert.deepEqual(fingerprint, expected);
  assert.equal(sha256Json(fingerprint), sha256Json(expected));
  assert.ok(
    collectRemoteReferences(rows)
      .filter((reference) => reference.role === 'reference')
      .every((reference) => reference.table === null),
  );
});

for (const [name, row] of [
  ['untyped provenance', processRow()],
  ['typed provenance', processRow(true)],
  ['Model predecessor', modelRow()],
  ['Model predecessor array', modelRow(true)],
] as const) {
  test(`refresh-remote preserves exact ${name} and its real blockers`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-fixed-model-reference-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const missing of [false, true]) {
      const outDir = path.join(directory, String(missing));
      const report = await runDatasetRemoteRefresh({
        inputPath: path.join(directory, 'input.json'),
        rawInput: [row],
        outPath: path.join(outDir, 'output.jsonl'),
        outDir,
        rootPolicy: 'candidate',
        runDatasetRemoteVerifyImpl: (options) =>
          runDatasetRemoteVerify({
            ...options,
            lookupDatasetImpl: async (request) => ({
              exact:
                missing && request.version === older
                  ? null
                  : { id: request.id, version: request.version },
              latest: { id: request.id, version: newer },
              exact_source_url: null,
              latest_source_url: null,
            }),
          }),
      });
      assert.equal(report.counts.patched_references, 0);
      assert.equal(report.counts.refreshable_references, 0);
      assert.equal(report.status, 'completed_with_blockers');
      assert.deepEqual(
        report.remaining_blockers.map((blocker) => blocker.code),
        [missing ? 'missing_version' : 'version_outdated'],
      );
      assert.deepEqual(JSON.parse(readFileSync(report.files.output_rows, 'utf8')), row);
    }
  });
}

test('refresh-remote still updates ordinary references beside fixed Model provenance', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-model-reference-mixed-refresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const row = processRow();
  const ordinary = {
    '@type': 'life cycle model data set',
    '@refObjectId': modelId,
    '@version': older,
  };
  Object.assign(row.processDataSet.processInformation.dataSetInformation, {
    otherReference: ordinary,
  });
  Object.assign(row.processDataSet, {
    exchanges: {
      exchange: {
        referenceToFlowDataSet: {
          '@type': 'flow data set',
          '@refObjectId': processId,
          '@version': older,
        },
      },
    },
  });
  const original = structuredClone(row);
  const report = await runDatasetRemoteRefresh({
    inputPath: path.join(directory, 'input.json'),
    rawInput: [row],
    outPath: path.join(directory, 'output.jsonl'),
    outDir: directory,
    rootPolicy: 'candidate',
    runDatasetRemoteVerifyImpl: (options) =>
      runDatasetRemoteVerify({
        ...options,
        lookupDatasetImpl: async (request) => ({
          exact: { id: request.id, version: request.version },
          latest: { id: request.id, version: newer },
          exact_source_url: null,
          latest_source_url: null,
        }),
      }),
  });
  assert.equal(report.counts.patched_references, 2);
  assert.equal(report.counts.refreshable_references, 2);
  assert.deepEqual(
    report.remaining_blockers.map((blocker) => blocker.path),
    [provenancePath],
  );
  const output = JSON.parse(readFileSync(report.files.output_rows, 'utf8'));
  assert.deepEqual(
    output.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
    row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
  );
  assert.equal(
    output.processDataSet.processInformation.dataSetInformation.otherReference['@version'],
    newer,
  );
  assert.equal(output.processDataSet.exchanges.exchange.referenceToFlowDataSet['@version'], newer);
  assert.deepEqual(row, original);
});
