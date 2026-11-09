import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFlowReferencePropertyIssues } from '../src/lib/flow-reference-properties.js';
import { flowReferenceFixture } from './helpers/flow-reference-fixture.js';

test('Flow reference factors accept exact TIDAS decimals and reject unsafe numeric values', () => {
  for (const valid of ['1', '1.', '+001.000E+00', '10e-1', '.01E02', 1]) {
    const flow = flowReferenceFixture();
    assert.deepEqual(
      collectFlowReferencePropertyIssues({
        flowDataSet: {
          ...flow,
          flowProperties: { flowProperty: { '@dataSetInternalID': 7, meanValue: valid } },
        },
      }),
      [],
    );
  }
  for (const [factor, code] of [
    ['1.00000000000000000001', 'reference_property_not_one'],
    ['0.99999999999999999999', 'reference_property_not_one'],
    ['2e-1', 'reference_property_not_one'],
    ['1.00e+1', 'reference_property_not_one'],
    ...[undefined, '', '0', '-0.01', '0x1', 'NaN', '1e500', '1e-500', Infinity, true].map(
      (factor) => [factor, 'flow_property_mean_value_not_positive'],
    ),
  ]) {
    const flow = flowReferenceFixture();
    assert.deepEqual(
      collectFlowReferencePropertyIssues({
        flowDataSet: {
          ...flow,
          flowProperties: { flowProperty: { '@dataSetInternalID': '7', meanValue: factor } },
        },
      }).map((issue) => issue.code),
      [code],
      String(factor),
    );
  }
});

test('Flow content validation reports non-reference failures and duplicate internal IDs', () => {
  const flow = flowReferenceFixture();
  const invalid = {
    ...flow,
    flowProperties: {
      flowProperty: [
        { '@dataSetInternalID': '0', meanValue: '-2' },
        flow.flowProperties.flowProperty,
        { '@dataSetInternalID': '0', meanValue: '2' },
        null,
      ],
    },
  };
  assert.deepEqual(
    collectFlowReferencePropertyIssues(invalid).map((issue) => issue.code),
    [
      'flow_property_mean_value_not_positive',
      'flow_property_duplicate_internal_id',
      'flow_property_invalid_internal_id',
      'flow_property_mean_value_not_positive',
    ],
  );
});
