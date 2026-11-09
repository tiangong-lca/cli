import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals,
  runDatasetRemoteVerify,
  type RemoteDatasetLookupRequest,
} from '../src/lib/dataset-remote-verify.js';
import type { JsonObject } from '../src/lib/dataset-local.js';

const collectVerificationReferences = __testInternals.collectVerificationReferences;

const modelId = '00000000-0000-4000-8000-000000000001';
const processId = '00000000-0000-4000-8000-000000000002';
const version = '00.00.001';

function provenanceRow() {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': processId,
          generatedFromLifecycleModel: { id: modelId, version, role: 'primary' },
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
}

function predecessorRow() {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: { dataSetInformation: { 'common:UUID': modelId } },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.002',
          'common:referenceToPrecedingDataSetVersion': {
            '@type': 'other external file',
            '@refObjectId': modelId,
            '@version': version,
            '@uri': `../lifecyclemodels/${modelId}_${version}.xml`,
            'common:shortDescription': { '@xml:lang': 'en', '#text': 'Published predecessor' },
          },
        },
      },
    },
  };
}

function referenceAt(row: JsonObject, occurrence: string) {
  return collectVerificationReferences([row]).find((reference) => reference.path === occurrence);
}

const provenancePath =
  '/processDataSet/processInformation/dataSetInformation/generatedFromLifecycleModel';
const predecessorPath =
  '/lifeCycleModelDataSet/administrativeInformation/publicationAndOwnership/common:referenceToPrecedingDataSetVersion';

test('native provenance resolves only at its exact Process field and preserves Model type aliases', () => {
  for (const type of [undefined, 'life cycle model data set', 'lifecyclemodel']) {
    const row = provenanceRow();
    const reference =
      row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel;
    if (type) Object.assign(reference, { type });
    assert.equal(referenceAt(row, provenancePath)?.table, 'lifecyclemodels');
    assert.equal(referenceAt(row, provenancePath)?.id, modelId);
  }
  for (const type of ['source data set', 'other external file', 'unknown']) {
    const row = provenanceRow();
    Object.assign(
      row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
      { type },
    );
    assert.equal(referenceAt(row, provenancePath)?.table, null);
  }
  const value =
    provenanceRow().processDataSet.processInformation.dataSetInformation
      .generatedFromLifecycleModel;
  for (const row of [
    { arbitrary: value },
    { extension: provenanceRow() },
    { processDataSet: { extension: { generatedFromLifecycleModel: value } } },
    {
      processDataSet: {
        processInformation: { dataSetInformation: { generatedFromLifecycleModel: [value] } },
      },
    },
  ]) {
    const references = collectVerificationReferences([row]).filter(
      (reference) => reference.role === 'reference',
    );
    assert.equal(references.length, 1);
    assert.equal(references[0].table, null);
  }
});

test('Model predecessor context accepts singleton and direct array occurrences without rewriting pointers', () => {
  const row = predecessorRow();
  const publication = row.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership;
  const reference = publication['common:referenceToPrecedingDataSetVersion'];
  for (const value of [reference, [reference, reference]]) {
    const candidate = structuredClone(row);
    Object.assign(
      candidate.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership,
      {
        'common:referenceToPrecedingDataSetVersion': value,
      },
    );
    const references = collectVerificationReferences([candidate]).filter(
      (item) => item.role === 'reference',
    );
    assert.deepEqual(
      references.map((item) => item.path),
      Array.isArray(value) ? [`${predecessorPath}/0`, `${predecessorPath}/1`] : [predecessorPath],
    );
    assert.ok(
      references.every(
        (item) =>
          item.table === 'lifecyclemodels' && item.id === modelId && item.version === version,
      ),
    );
  }
  for (const value of [undefined, []]) {
    Object.assign(publication, { 'common:referenceToPrecedingDataSetVersion': value });
    assert.equal(
      collectVerificationReferences([row]).filter((item) => item.role === 'reference').length,
      0,
    );
  }
});

test('native provenance cannot be redirected by conflicting generic reference aliases', () => {
  for (const aliases of [
    { '@refObjectId': processId },
    { refObjectId: processId },
    { '@version': '00.00.999' },
    { id: undefined, '@refObjectId': modelId },
    { version: undefined, '@version': version },
  ]) {
    const row = provenanceRow();
    Object.assign(
      row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
      aliases,
    );
    assert.equal(referenceAt(row, provenancePath)?.table, null, JSON.stringify(aliases));
  }
  const row = provenanceRow();
  Object.assign(
    row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
    {
      '@refObjectId': modelId,
      '@version': version,
    },
  );
  assert.equal(referenceAt(row, provenancePath)?.table, 'lifecyclemodels');
});

test('context inference requires the canonical predecessor type', () => {
  for (const changed of [
    { '@type': undefined, type: 'other external file' },
    { '@type': ' OTHER EXTERNAL FILE ' },
  ]) {
    const row = predecessorRow();
    Object.assign(
      row.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
        'common:referenceToPrecedingDataSetVersion'
      ],
      changed,
    );
    assert.equal(referenceAt(row, predecessorPath)?.table, null);
  }
});

test('context inference requires unambiguous native provenance types', () => {
  for (const changed of [
    { type: 'process data set', '@type': 'life cycle model data set' },
    { type: 42 },
    { type: null },
    { type: '' },
    { '@type': 42 },
    { '@type': null },
    { '@type': '' },
  ]) {
    const row = provenanceRow();
    Object.assign(
      row.processDataSet.processInformation.dataSetInformation.generatedFromLifecycleModel,
      changed,
    );
    assert.equal(referenceAt(row, provenancePath)?.table, null, JSON.stringify(changed));
  }
});

test('context inference preserves ordinary explicit reference type routes', () => {
  for (const [type, table] of [
    ['process data set', 'processes'],
    ['life cycle model data set', 'lifecyclemodels'],
  ] as const) {
    const row = predecessorRow();
    Object.assign(
      row.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
        'common:referenceToPrecedingDataSetVersion'
      ],
      {
        '@type': type,
        '@uri': `../${table}/${modelId}_${version}.xml`,
      },
    );
    assert.equal(referenceAt(row, predecessorPath)?.table, table);
  }
});

test('context inference is bound to the selected root', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-model-reference-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const row = { ...provenanceRow(), ...predecessorRow() };
  assert.equal(referenceAt(row, predecessorPath)?.table, null);
  assert.equal(referenceAt(row, provenancePath)?.table, 'lifecyclemodels');
  const report = await runDatasetRemoteVerify({
    inputPath: path.join(root, 'synthetic.json'),
    rawInput: [row],
    outDir: root,
    rootPolicy: 'candidate',
    lookupDatasetImpl: async (request) => ({
      exact: { id: request.id, version: request.version },
      latest: { id: request.id, version: request.version },
      exact_source_url: null,
      latest_source_url: null,
    }),
  });
  assert.deepEqual(
    report.blockers.map((blocker) => ({ code: blocker.code, path: blocker.path })),
    [{ code: 'unsupported_type', path: predecessorPath }],
  );
});

test('Model predecessor inference rejects external, mismatched and malformed locators', () => {
  const original = predecessorRow();
  const originalRef =
    original.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
      'common:referenceToPrecedingDataSetVersion'
    ];
  const invalid: JsonObject[] = [
    { '@type': undefined },
    { '@refObjectId': undefined, id: modelId },
    { '@refObjectId': 'not-a-uuid', '@uri': `../lifecyclemodels/not-a-uuid_${version}.xml` },
    { '@version': undefined, version },
    { '@version': 1 },
    { '@version': '1.0', '@uri': `../lifecyclemodels/${modelId}_1.0.xml` },
    ...[
      undefined,
      `../lifecyclemodels/${modelId}.xml`,
      `../lifecyclemodels/${modelId}_00.00.999.xml`,
      `../lifecyclemodels/${processId}_${version}.xml`,
      `../processes/${modelId}_${version}.xml`,
      `https://example.invalid/lifecyclemodels/${modelId}_${version}.xml`,
      `../lifecyclemodels/${modelId}_${version}.xml?download=1`,
      `../lifecyclemodels/${modelId}_${version}.xml#section`,
      `../lifecyclemodels/../lifecyclemodels/${modelId}_${version}.xml`,
    ].map((uri) => ({ '@uri': uri })),
  ];
  for (const changed of invalid) {
    const row = structuredClone(original);
    Object.assign(
      row.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
        'common:referenceToPrecedingDataSetVersion'
      ],
      changed,
    );
    assert.equal(referenceAt(row, predecessorPath)?.table, null, JSON.stringify(changed));
  }
  const shortVersion = structuredClone(original);
  Object.assign(
    shortVersion.lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
      'common:referenceToPrecedingDataSetVersion'
    ],
    {
      '@version': '01.00',
      '@uri': `../lifecyclemodels/${modelId}_01.00.xml`,
    },
  );
  assert.equal(referenceAt(shortVersion, predecessorPath)?.table, 'lifecyclemodels');
  assert.equal(originalRef['@version'], version);
});

test('Model-shaped URIs outside the exact predecessor context remain unsupported', () => {
  const reference =
    predecessorRow().lifeCycleModelDataSet.administrativeInformation.publicationAndOwnership[
      'common:referenceToPrecedingDataSetVersion'
    ];
  const publication = { 'common:referenceToPrecedingDataSetVersion': reference };
  for (const row of [
    { externalFile: reference },
    { processDataSet: { administrativeInformation: { publicationAndOwnership: publication } } },
    {
      extension: {
        lifeCycleModelDataSet: {
          administrativeInformation: { publicationAndOwnership: publication },
        },
      },
    },
    ...[[[reference]], { 0: reference }, { extension: reference }].map((value) => ({
      lifeCycleModelDataSet: {
        administrativeInformation: {
          publicationAndOwnership: { 'common:referenceToPrecedingDataSetVersion': value },
        },
      },
    })),
  ]) {
    const references = collectVerificationReferences([row]).filter((item) => item.role === 'reference');
    assert.equal(references.length, 1);
    assert.equal(references[0].table, null);
  }
  assert.equal(
    collectVerificationReferences([{ other: { ...reference, '@type': 'source data set' } }])[0].table,
    'sources',
  );
});

for (const [name, row] of [
  ['legacy native Model provenance', provenanceRow()],
  ['schema-valid Model predecessor', predecessorRow()],
] as const) {
  test(`verify-remote resolves ${name} through exact Model lookup`, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cli-model-reference-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const calls: RemoteDatasetLookupRequest[] = [];
    const report = await runDatasetRemoteVerify({
      inputPath: path.join(root, 'synthetic.json'),
      rawInput: [row],
      outDir: path.join(root, 'verify'),
      rootPolicy: 'candidate',
      lookupDatasetImpl: async (request) => {
        calls.push(request);
        const target = request.table === 'lifecyclemodels' && request.version === version;
        return {
          exact: target ? { id: modelId, version } : null,
          latest: target ? { id: modelId, version } : null,
          exact_source_url: null,
          latest_source_url: null,
        };
      },
    });
    assert.equal(report.counts.by_status.unsupported_type, 0);
    assert.equal(report.status, 'passed_remote_verification');
    assert.ok(
      calls.some(
        (call) =>
          call.table === 'lifecyclemodels' && call.id === modelId && call.version === version,
      ),
    );
  });
}
