import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFlowProperties } from '../src/lib/flow-property-contract.js';
import { __testInternals as qa } from '../src/lib/flow-qa.js';
import { __testInternals as remediate } from '../src/lib/flow-remediate.js';

const mass = {
  '@dataSetInternalID': '7',
  meanValue: '1.000',
  referenceToFlowPropertyDataSet: {
    '@refObjectId': '93a60a56-a3c8-11da-a746-0800200b9a66',
    '@version': '03.00.003',
    'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
  },
  generalComment: [{ '@xml:lang': 'en', '#text': 'Measured on dry basis.' }],
  minimumValue: '0.999',
  maximumValue: '1.001',
  uncertaintyDistributionType: 'normal',
  dataDerivationTypeStatus: 'Measured',
  custom: { retained: true },
};
const volume = {
  '@dataSetInternalID': '0',
  meanValue: '0.001',
  referenceToFlowPropertyDataSet: {
    '@refObjectId': '93a60a56-a3c8-11da-a746-0800200b9a67',
    '@version': '03.00.003',
  },
};
function flow(
  properties: unknown = [volume, mass],
  reference: unknown = '7',
): Record<string, unknown> {
  return {
    flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: reference } },
    flowProperties: { flowProperty: properties },
  };
}

test('declared nonzero reference is independent of order, and descriptive zero is not an invertible conversion', () => {
  for (const properties of [
    [volume, mass],
    [mass, volume],
  ]) {
    const result = inspectFlowProperties(flow(properties));
    assert.equal(result.reference, mass);
    assert.deepEqual(result.issues, []);
    assert.equal(
      qa.buildFlowSummaryAndRuleFindings({ flowDataSet: flow(properties) }, 'built_in').summary
        .flow_property.referenced_uuid,
      mass.referenceToFlowPropertyDataSet['@refObjectId'],
    );
  }
  assert.deepEqual(inspectFlowProperties(flow([{ ...volume, meanValue: '0' }, mass])).issues, []);
});

test('reference and property ambiguities fail without selecting an arbitrary first row', () => {
  const invalid = [
    flow([mass, { ...mass, meanValue: '2' }]),
    flow([
      mass,
      {
        ...volume,
        referenceToFlowPropertyDataSet: {
          ...mass.referenceToFlowPropertyDataSet,
          '@version': '01.01.001',
        },
      },
    ]),
    flow([mass], 'unknown'),
    flow([mass], null),
    flow([mass], ''),
    flow([{ ...mass, meanValue: '2' }]),
    flow([{ ...mass, meanValue: 'Infinity' }]),
    flow([{ ...mass, meanValue: '1e999' }]),
    flow([{ ...mass, '@dataSetInternalID': '-1' }]),
    flow([null]),
    flow(null),
    flow({ '@dataSetInternalID': '7', meanValue: '', referenceToFlowPropertyDataSet: {} }),
  ];
  for (const value of invalid) assert.ok(inspectFlowProperties(value).issues.length > 0);
  assert.equal(inspectFlowProperties(flow([mass], '0')).reference, null);
  const qaResult = qa.buildFlowSummaryAndRuleFindings(
    { flowDataSet: flow([mass], '0') },
    'built_in',
  );
  const pointerFinding = qaResult.findings.find(
    (finding) => finding.rule_id === 'flow_property_reference_unresolved',
  );
  assert.equal(pointerFinding?.methodology_rule_id, 'tidas.flow.reference-property-unit.required');
  assert.equal(qa.flowRulesetGate(qaResult.findings).status, 'blocked');
  assert.deepEqual(inspectFlowProperties({}).properties, []);
});

test('reference normalization uses exact decimal identity rather than floating-point rounding', () => {
  for (const meanValue of ['1', '1.0000', '10e-1', '.1e1', '+0001e+0', '1000E-3']) {
    assert.deepEqual(inspectFlowProperties(flow([{ ...mass, meanValue }])).issues, []);
  }
  for (const meanValue of [
    '1.00000000000000000000000000000000000001',
    '0.999999999999999999999999999999999999',
    '1e-400',
    '1e309',
    '-1',
    '1e999999999999999999999999',
  ]) {
    assert.ok(
      inspectFlowProperties(flow([{ ...mass, meanValue }])).issues.some(
        (issue) => issue.code === 'flow_property_reference_not_normalized',
      ),
    );
  }
});

test('remediation preserves full property metadata and never repairs reference by array position', () => {
  const original = structuredClone(mass);
  const value = flow([mass, volume]);
  const normalized = remediate.normalize_flow_properties(value, []);
  const repaired = normalized.items[0]!;
  for (const [key, entry] of Object.entries(original)) {
    if (key !== 'referenceToFlowPropertyDataSet') assert.deepEqual(repaired[key], entry);
  }
  const ref = repaired.referenceToFlowPropertyDataSet as Record<string, unknown>;
  for (const [key, entry] of Object.entries(original.referenceToFlowPropertyDataSet))
    assert.deepEqual(ref[key], entry);
  const missing = flow([mass, volume], '999');
  const unresolved: Array<{ code: string }> = [];
  remediate.normalize_quantitative_reference(missing, normalized.items, [], unresolved as never);
  assert.equal(
    (
      (missing.flowInformation as Record<string, unknown>).quantitativeReference as Record<
        string,
        unknown
      >
    ).referenceToReferenceFlowProperty,
    '999',
  );
  assert.equal(unresolved[0]?.code, 'flow_property_reference_unresolved');
  assert.deepEqual(mass, original);
});

test('QA reports a selected property without identity and preserves advisory-only gate semantics', () => {
  const missing = qa.buildFlowSummaryAndRuleFindings(
    { flowDataSet: flow([{ ...mass, referenceToFlowPropertyDataSet: 'invalid' }]) },
    'built_in',
  );
  assert.ok(
    missing.findings.some((finding) => finding.rule_id === 'invalid_flow_property_reference'),
  );
  assert.equal(
    qa.findUuidInNode('prefix aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa suffix'),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  );
  assert.equal(
    qa.flowRulesetGate([
      {
        flow_uuid: 'test',
        base_version: '',
        severity: 'warning',
        source: 'rule',
        rule_id: 'advisory',
      },
    ]).status,
    'needs_review',
  );
  const custom = qa.createRuleFinding('test', '', 'warning', 'advisory', 'Review recommended.', {
    action: 'review',
  });
  assert.equal(custom.action, 'review');
});
