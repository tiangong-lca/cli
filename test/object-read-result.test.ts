import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError } from '../src/lib/errors.js';
import {
  isObjectReadUuid,
  isObjectReadVersion,
  validateObjectReadResult,
  validateObjectReadRows,
  type ObjectReadDatasetType,
} from '../src/lib/object-read-result.js';

const id = '11111111-1111-4111-8111-111111111111';
const version = '01.00.003';
const descriptors: [ObjectReadDatasetType, string, string][] = [
  ['process', 'processDataSet', 'processInformation'],
  ['flow', 'flowDataSet', 'flowInformation'],
  ['contact', 'contactDataSet', 'contactInformation'],
  ['source', 'sourceDataSet', 'sourceInformation'],
  ['lifecyclemodel', 'lifeCycleModelDataSet', 'lifeCycleModelInformation'],
  ['flowproperty', 'flowPropertyDataSet', 'flowPropertiesInformation'],
  ['unitgroup', 'unitGroupDataSet', 'unitGroupInformation'],
];

function canonical(wrapper = 'flowDataSet', information = 'flowInformation') {
  return {
    [wrapper]: {
      [information]: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
      preserved: [{ '@xml:lang': 'zh', '#text': '原始数据' }],
    },
  };
}

function options() {
  return {
    datasetType: 'flow' as ObjectReadDatasetType,
    requestedId: id,
    requestedVersion: version as string | null,
    rowId: id as unknown,
    rowVersion: version as unknown,
    payload: canonical() as unknown,
    resolution: 'remote_supabase_exact' as const,
  };
}

test('all object kinds retain the complete original payload and actual identity', () => {
  for (const [datasetType, wrapper, information] of descriptors) {
    const payload = canonical(wrapper, information);
    const result = validateObjectReadResult({ ...options(), datasetType, payload });
    assert.equal(result.payload, payload);
    assert.equal(result.id, id);
    assert.equal(result.resolved_version, version);
    assert.equal(result.version_fallback, false);
    assert.deepEqual(result.warnings, []);
  }
});

test('latest and fallback reports distinguish intent from the actual version', () => {
  const latest = validateObjectReadResult({
    ...options(),
    requestedVersion: null,
    resolution: 'remote_supabase_latest',
  });
  assert.equal(latest.requested_version, null);
  assert.equal(latest.version_fallback, false);
  const fallback = validateObjectReadResult({
    ...options(),
    requestedVersion: '99.00.000',
    resolution: 'remote_supabase_latest_fallback',
  });
  assert.equal(fallback.version_fallback, true);
  assert.deepEqual(fallback.warnings, [
    {
      code: 'VERSION_FALLBACK',
      requested_version: '99.00.000',
      resolved_version: version,
      message:
        'Requested version was not visible in the selected scope; returned the latest visible version.',
    },
  ]);
});

test('invalid identities, wrappers and embedded versions fail without manufacturing fields', () => {
  const mutations: Partial<ReturnType<typeof options>>[] = [
    { rowId: null },
    { rowId: 'not-a-uuid' },
    { rowId: '22222222-2222-4222-8222-222222222222' },
    { rowVersion: undefined },
    { rowVersion: '' },
    { rowVersion: '1.0.3' },
    { requestedVersion: '' },
    { requestedVersion: '01.00.002' },
    { payload: null },
    { payload: [] },
    { payload: {} },
    { payload: { processDataSet: canonical().flowDataSet } },
    { payload: { ...canonical(), processDataSet: {} } },
    { payload: { flowDataSet: 1 } },
    { payload: { flowDataSet: { flowInformation: {} } } },
    {
      payload: {
        flowDataSet: {
          ...canonical().flowDataSet,
          flowInformation: { dataSetInformation: { 'common:UUID': 'bad-id' } },
        },
      },
    },
    {
      payload: {
        flowDataSet: {
          ...canonical().flowDataSet,
          flowInformation: {
            dataSetInformation: { 'common:UUID': '22222222-2222-4222-8222-222222222222' },
          },
        },
      },
    },
    {
      payload: {
        flowDataSet: {
          ...canonical().flowDataSet,
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.002' },
          },
        },
      },
    },
  ];
  for (const mutation of mutations)
    assert.throws(
      () => validateObjectReadResult({ ...options(), ...mutation }),
      (error) => error instanceof CliError && error.code === 'OBJECT_GET_RESPONSE_INVALID',
    );
  assert.throws(() =>
    validateObjectReadResult({ ...options(), resolution: 'remote_supabase_latest' }),
  );
  assert.throws(() =>
    validateObjectReadResult({
      ...options(),
      requestedVersion: null,
      resolution: 'remote_supabase_latest_fallback',
    }),
  );
});

test('identity format predicates reject unsupported values and accept UUID case', () => {
  assert.equal(isObjectReadUuid(3), false);
  assert.equal(isObjectReadUuid('bad'), false);
  assert.equal(isObjectReadUuid('ABCDEFAB-1234-1234-1234-ABCDEFABCDEF'), true);
  assert.equal(isObjectReadVersion(3), false);
  assert.equal(isObjectReadVersion('01.00.003'), true);
  assert.equal(isObjectReadVersion(' 01.00.003 '), false);
});

test('object row sets reject more rows than the bounded query requested', () => {
  const row = { id, version, payload: canonical() };
  assert.throws(
    () =>
      validateObjectReadRows({
        datasetType: 'flow',
        requestedId: id,
        requestedVersion: version,
        rows: [row, row, row],
      }),
    (error) => error instanceof CliError && error.code === 'OBJECT_GET_RESPONSE_INVALID',
  );
});

test('compiled result validation preserves native identities and refuses fabricated fallback versions', async () => {
  const built = (await import(
    new URL('../dist/src/lib/object-read-result.js', import.meta.url).href
  )) as typeof import('../src/lib/object-read-result.js');
  const selection = {
    datasetType: 'flow' as const,
    requestedId: id,
    requestedVersion: version,
    rows: [{ id, version, payload: canonical() }],
  };
  built.validateObjectReadRows(selection);
  const input = {
    ...options(),
    requestedVersion: '99.99.999',
    resolution: 'remote_supabase_latest_fallback' as const,
  };
  assert.deepEqual(built.validateObjectReadResult(input), validateObjectReadResult(input));
  assert.throws(() => built.validateObjectReadResult({ ...input, rowVersion: undefined }), {
    code: 'OBJECT_GET_RESPONSE_INVALID',
  });
});
