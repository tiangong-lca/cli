import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { JsonObject } from '../src/lib/dataset-local.js';
import { __testInternals } from '../src/lib/process-flow-build-plan.js';

function request(): JsonObject {
  return JSON.parse(
    readFileSync(
      new URL('./fixtures/flow-property-conversion/request.json', import.meta.url),
      'utf8',
    ),
  ) as JsonObject;
}

function flow(value: JsonObject): JsonObject {
  return (value.flow as JsonObject).flowDataSet as JsonObject;
}

function sourceProperty(value: JsonObject): JsonObject {
  return ((flow(value).flowProperties as JsonObject).flowProperty as JsonObject[])[0]!;
}

function sourcePropertyDocument(value: JsonObject): JsonObject {
  return (value.flow_properties as JsonObject[])[1]!.flowPropertyDataSet as JsonObject;
}

function sourceUnitGroup(value: JsonObject): JsonObject {
  return (value.unit_groups as JsonObject[])[1]!.unitGroupDataSet as JsonObject;
}

test('source unit follows exact property and unit IDs independently of reference IDs and order', () => {
  const value = request();
  const source = value.source as JsonObject;
  assert.equal(__testInternals.conversionSourceUnitName(value), 'm3');
  source.unit_internal_id = '3';
  assert.equal(__testInternals.conversionSourceUnitName(value), 'L');
  source.flow_property_internal_id = '7';
  assert.equal(__testInternals.conversionSourceUnitName(value), 'g');
  source.unit_internal_id = '9';
  assert.equal(__testInternals.conversionSourceUnitName(value), 'kg');
  ((flow(value).flowProperties as JsonObject).flowProperty as JsonObject[]).reverse();
  (value.flow_properties as JsonObject[]).reverse();
  (value.unit_groups as JsonObject[]).reverse();
  assert.equal(__testInternals.conversionSourceUnitName(value), 'kg');
});

test('source unit accepts bare or wrapped evidence and singleton unit objects', () => {
  for (let wrappers = 0; wrappers < 8; wrappers += 1) {
    const value = request();
    const group = sourceUnitGroup(value);
    const units = group.units as JsonObject;
    units.unit = (units.unit as JsonObject[])[0];
    if ((wrappers & 1) === 0) value.flow = flow(value);
    if ((wrappers & 2) === 0)
      value.flow_properties = (value.flow_properties as JsonObject[]).map(
        (document) => document.flowPropertyDataSet,
      );
    if ((wrappers & 4) === 0)
      value.unit_groups = (value.unit_groups as JsonObject[]).map(
        (document) => document.unitGroupDataSet,
      );
    assert.equal(__testInternals.conversionSourceUnitName(value), 'm3', `wrapper mask ${wrappers}`);
  }
});

test('source unit does not substitute missing identities, versions, properties or units', () => {
  const mutations: Array<(value: JsonObject) => void> = [
    (value) => {
      value.flow = null;
    },
    (value) => {
      value.source = null;
    },
    (value) => {
      (value.source as JsonObject).flow_property_internal_id = '999';
    },
    (value) => {
      (value.source as JsonObject).unit_internal_id = '999';
    },
    (value) => {
      sourceProperty(value).referenceToFlowPropertyDataSet = null;
    },
    (value) => {
      delete (sourceProperty(value).referenceToFlowPropertyDataSet as JsonObject)['@version'];
    },
    (value) => {
      value.flow_properties = {};
    },
    (value) => {
      value.unit_groups = null;
    },
    (value) => {
      const info = sourcePropertyDocument(value).flowPropertiesInformation as JsonObject;
      delete info.quantitativeReference;
    },
    (value) => {
      const info = sourcePropertyDocument(value).administrativeInformation as JsonObject;
      (info.publicationAndOwnership as JsonObject)['common:dataSetVersion'] = '01.00.001';
    },
    (value) => {
      const info = sourceUnitGroup(value).administrativeInformation as JsonObject;
      (info.publicationAndOwnership as JsonObject)['common:dataSetVersion'] = '01.00.001';
    },
    (value) => {
      delete sourceUnitGroup(value).units;
    },
    (value) => {
      const units = (sourceUnitGroup(value).units as JsonObject).unit as JsonObject[];
      delete units[0]!.name;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = request();
    mutate(value);
    assert.equal(
      __testInternals.conversionSourceUnitName(value),
      null,
      `missing evidence ${index}`,
    );
  }
});

test('source unit skips malformed dependency entries while selecting the exact valid chain', () => {
  const value = request();
  value.flow_properties = [null, 'not a dataset', ...(value.flow_properties as JsonObject[])];
  value.unit_groups = [false, 12, ...(value.unit_groups as JsonObject[])];
  assert.equal(__testInternals.conversionSourceUnitName(value), 'm3');
});
