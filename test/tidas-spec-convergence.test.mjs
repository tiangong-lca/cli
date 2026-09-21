import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(root, 'assets', 'tidas-schemas');
const readSchema = (name) => JSON.parse(fs.readFileSync(path.join(schemaRoot, name), 'utf8'));

test('bundled TIDAS assets bind the approved canonical source identity', () => {
  const identity = JSON.parse(
    fs.readFileSync(path.join(root, 'assets', 'tidas-spec-source.json'), 'utf8'),
  );
  assert.equal(identity.schema, 'tiangong-lca.cli-tidas-spec-source.v1');
  assert.equal(identity.spec_repository, 'tiangong-lca/tidas-spec');
  assert.equal(identity.spec_commit, '8a9470a7dd4c074ae246bb9967b3bfae3e371e32');
  assert.equal(identity.source_repository, 'https://github.com/tiangong-lca/tidas-toolkit');
  assert.equal(identity.source_commit, '9c0d8b1c8ceb1841074f5bc6de5fbb7fcc9318f5');
  assert.equal(identity.spec_version, '0.2.2');
  assert.equal(
    identity.manifest_sha256,
    '620e2e389d91af7a774e92e1d7c67e282ccb910e0c2e9f9391926cbe1c5e5f09',
  );
  assert.equal(identity.schemas.length, 18);
});

function reviewSchema(schema, rootKey) {
  return schema.properties[rootKey].properties.modellingAndValidation.properties.validation
    .properties.review;
}

function reviewObjectSchema(schema, rootKey) {
  const review = reviewSchema(schema, rootKey);
  const localReference = review.anyOf?.find((branch) => branch.$ref?.startsWith('#/$defs/'))?.$ref;
  return localReference ? schema.$defs[localReference.slice('#/$defs/'.length)] : review;
}

test('Process review accepts one object or a non-empty ordered array', () => {
  const schema = readSchema('tidas_processes.json');
  const review = reviewSchema(schema, 'processDataSet');
  assert.deepEqual(review.anyOf, [
    { $ref: '#/$defs/ProcessReview' },
    {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/ProcessReview' },
    },
  ]);
});

test('review-report references are optional only for Process and LCIA Method', () => {
  for (const [name, rootKey] of [
    ['tidas_processes.json', 'processDataSet'],
    ['tidas_lciamethods.json', 'LCIAMethodDataSet'],
  ]) {
    const schema = readSchema(name);
    const review = reviewObjectSchema(schema, rootKey);
    const required = review.allOf[0].else.required;
    assert.deepEqual(required, [
      'common:scope',
      'common:reviewDetails',
      'common:referenceToNameOfReviewerAndInstitution',
    ]);
    assert.deepEqual(review.properties['common:referenceToCompleteReviewReport'], {
      $ref: 'tidas_data_types.json#/$defs/GlobalReferenceType',
      description: '"Source data set" of the complete review report.',
    });
  }

  const lifecycle = reviewSchema(readSchema('tidas_lifecyclemodels.json'), 'lifeCycleModelDataSet');
  assert.equal(lifecycle.allOf, undefined);
  assert.deepEqual(lifecycle.anyOf[0].required, ['common:referenceToNameOfReviewerAndInstitution']);
  assert.equal(
    lifecycle.anyOf[0].properties['common:referenceToCompleteReviewReport'].$ref,
    'tidas_data_types.json#/$defs/GlobalReferenceType',
  );
});

test('canonical changed constraints accept the selected code and reject the old CLI code', () => {
  const locations = readSchema('tidas_locations_category.json');
  const constants = new Set(locations.oneOf.map((entry) => entry.const));
  assert.equal(constants.has('HK'), true);
  assert.equal(constants.has('TW'), true);
  assert.equal(constants.has('MO'), true);
  assert.equal(constants.has('CN-HK'), false);
  assert.equal(constants.has('CN-TW'), false);
  assert.equal(constants.has('CN-MO'), false);
});

test('canonical version and reference constraints are installed, not the stale generic forms', () => {
  const dataTypes = readSchema('tidas_data_types.json');
  assert.equal(dataTypes.$defs.Version.pattern.startsWith('^\\d'), true);
  assert.equal(dataTypes.$defs.GlobalReferenceTypeValues.enum.includes('flow data set'), true);
  const contacts = readSchema('tidas_contacts.json');
  const version =
    contacts.properties.contactDataSet.properties.administrativeInformation.properties
      .publicationAndOwnership.properties['common:dataSetVersion'];
  assert.deepEqual(version.allOf, [{ $ref: 'tidas_data_types.json#/$defs/Version' }]);
});
