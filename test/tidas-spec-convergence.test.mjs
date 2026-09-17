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
  assert.equal(identity.spec_commit, '6fb497bad562125ccc0c00a803351207b9ed438f');
  assert.equal(identity.source_repository, 'https://github.com/tiangong-lca/tidas-toolkit');
  assert.equal(identity.source_commit, '9c0d8b1c8ceb1841074f5bc6de5fbb7fcc9318f5');
  assert.equal(identity.schemas.length, 18);
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
