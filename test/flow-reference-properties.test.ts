import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as sdk from '@tiangong-lca/tidas-sdk';
import {
  assertFlowReferencePropertyWriteAdmission,
  collectFlowReferencePropertyIssues,
  flowPropertyFactor,
  inspectFlowReferenceProperties,
} from '../src/lib/flow-reference-properties.js';
import { CliError } from '../src/lib/errors.js';
import { createDatasetRecord, saveDraftDatasetRecord } from '../src/lib/dataset-command.js';
import { createTidasSdkPackageValidator } from '../src/lib/tidas-sdk-package-validator.js';
import { datasetValidation } from '../src/adapters/dataset-local.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import { businessActor, businessIdentity } from './helpers/cli-business-fixtures.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';
import {
  businessFlowReferenceFixture,
  flowReferenceFixture,
} from './helpers/flow-reference-fixture.js';

test('Flow factors use exact decimal identity and reject unusable numeric representations', () => {
  for (const value of ['1', '1.', '1.0000', '+001.000E+00', '10e-1', '.01E02', ' 1 ', 1])
    assert.equal(flowPropertyFactor(value), 'one', String(value));
  for (const value of ['0.45', '1.00000000000000000001', '0.99999999999999999999', '1e-3', 2])
    assert.equal(flowPropertyFactor(value), 'positive', String(value));
  for (const value of [
    undefined,
    null,
    {},
    [],
    true,
    '',
    '0',
    0,
    '-1',
    '-0',
    'NaN',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'Infinity',
    '0x1',
    '1e999',
    '1e-999',
    '1e',
    '1_0',
  ])
    assert.equal(flowPropertyFactor(value), 'invalid', String(value));
});

test('Flow reference resolution preserves singleton/array content, metadata and uncertainty', () => {
  const payload = flowReferenceFixture();
  Object.assign(payload.flowDataSet.flowProperties.flowProperty[1]!, {
    minimumValue: '0.9',
    maximumValue: '1.1',
    uncertaintyDistributionType: 'normal',
    'common:generalComment': { '@xml:lang': 'en', '#text': 'Measured conversion' },
  });
  const before = structuredClone(payload);
  const report = inspectFlowReferenceProperties(payload.flowDataSet);
  assert.deepEqual(report.issues, []);
  assert.equal(report.reference, payload.flowDataSet.flowProperties.flowProperty[1]);
  assert.equal(report.referenceId, '7');
  assert.equal(report.propertyCount, 2);
  assertFlowReferencePropertyWriteAdmission(payload);
  assert.deepEqual(payload, before);
  const single = {
    flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '99999' } },
    flowProperties: { flowProperty: { '@dataSetInternalID': '99999', meanValue: '1e0' } },
  };
  assert.deepEqual(inspectFlowReferenceProperties(single).issues, []);
  assert.deepEqual(collectFlowReferencePropertyIssues(single), []);
});

test('Flow diagnostics identify invalid identities, pointers and every invalid factor without selecting a replacement', () => {
  assert.deepEqual(
    collectFlowReferencePropertyIssues({}).map((i) => i.code),
    ['missing_flow_property', 'missing_quantitative_reference'],
  );
  assert.equal(
    collectFlowReferencePropertyIssues({ flowInformation: null })[1]?.code,
    'missing_quantitative_reference',
  );
  for (const id of ['', '01', '100000', '-1', '1.0', ' 7 ', '7\n', 7, undefined]) {
    const report = inspectFlowReferenceProperties({
      flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: id } },
      flowProperties: { flowProperty: { '@dataSetInternalID': id, meanValue: '1' } },
    });
    assert.deepEqual(
      report.issues.map((i) => i.code),
      ['missing_quantitative_reference', 'flow_property_invalid_internal_id'],
    );
    assert.equal(report.reference, null);
  }
  const missing = flowReferenceFixture();
  missing.flowDataSet.flowInformation.quantitativeReference.referenceToReferenceFlowProperty = '8';
  assert.equal(
    collectFlowReferencePropertyIssues(missing)[0]?.code,
    'methodology_quant_ref_missing_target',
  );
  const duplicate = flowReferenceFixture();
  duplicate.flowDataSet.flowProperties.flowProperty[0]!['@dataSetInternalID'] = '7';
  const report = inspectFlowReferenceProperties(duplicate.flowDataSet);
  assert.equal(report.reference, null);
  assert.equal(
    report.issues[0]?.path,
    'flowDataSet.flowProperties.flowProperty.1.@dataSetInternalID',
  );
  assert.equal(report.issues[0]?.code, 'flow_property_duplicate_internal_id');
  const invalid = inspectFlowReferenceProperties({
    flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '7' } },
    flowProperties: { flowProperty: [null, { '@dataSetInternalID': '7', meanValue: '0' }] },
  });
  assert.equal(
    invalid.issues.filter((i) => i.code === 'flow_property_mean_value_not_positive').length,
    2,
  );
  assert.equal(invalid.issues.at(-1)?.path, 'flowDataSet.flowProperties.flowProperty.1.meanValue');
  const singleton = inspectFlowReferenceProperties({
    flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '7' } },
    flowProperties: { flowProperty: { '@dataSetInternalID': '7', meanValue: '0.45' } },
  });
  assert.equal(singleton.issues[0]?.path, 'flowDataSet.flowProperties.flowProperty.meanValue');
  assert.throws(
    () => assertFlowReferencePropertyWriteAdmission(flowReferenceFixture('0.45')),
    (e) => e instanceof CliError && e.code === 'FLOW_REFERENCE_PROPERTY_INVALID',
  );
});

test('Current typed Flow validation distinguishes schema, content and unchecked remote references', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flow-reference-validation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ports = createDatasetPorts({}, async () => {
    throw new Error('Validation must stay local');
  });
  for (const factor of [
    '0.45',
    '0',
    '-1',
    '1.00000000000000000001',
    '0.99999999999999999999',
    '1.0',
  ]) {
    const payload = businessFlowReferenceFixture(factor);
    const file = path.join(directory, 'candidate.json');
    const source = JSON.stringify(payload);
    writeFileSync(file, source);
    const response = await runDatasetCommand(
      ['flow', 'validate', '--input', file, '--json'],
      ports,
    );
    const result = JSON.parse(response.stdout);
    assert.equal(response.exitCode, factor === '1.0' ? 0 : 1, response.stdout);
    const validation = result.data.validation;
    assert.equal(validation.validation_layers.schema.status, 'passed');
    assert.equal(
      validation.validation_layers.content.status,
      factor === '1.0' ? 'passed' : 'failed',
    );
    assert.deepEqual(validation.notChecked, ['remote_references']);
    if (factor !== '1.0')
      assert.equal(
        validation.issues.at(-1).path,
        'flowDataSet.flowProperties.flowProperty.1.meanValue',
      );
    assert.equal(readFileSync(file, 'utf8'), source);
  }
  const schemaOnly = await datasetValidation('flow', businessFlowReferenceFixture('0.45'), [
    'schema',
  ]);
  assert.equal(schemaOnly.status, 'passed');
  assert.ok((schemaOnly.notChecked as string[]).includes('business'));
});

test('Current Flow create/save and direct dispatch refuse invalid content without POST or beforeDispatch', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flow-reference-writes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backend = createBusinessBackend();
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
  });
  const mutate = datasetWriter(env, backend.fetchImpl, directory);
  const content = businessFlowReferenceFixture('0.45');
  const identity = businessIdentity('flow', content);
  for (const action of ['create', 'save'] as const) {
    await assert.rejects(
      () =>
        mutate(
          'flow',
          action,
          {
            ...identity,
            content,
            ...(action === 'save' ? { expectedContent: businessFlowReferenceFixture() } : {}),
            requestId: `invalid-${action}`,
            expectedActor: businessActor,
            expectedEnvironment: 'https://example.supabase.co',
          },
          false,
        ),
      { code: 'VALIDATION_REQUIRED' },
    );
  }
  assert.equal(backend.calls.filter((call) => call.path.startsWith('/functions/')).length, 0);
  let dispatches = 0;
  const transport = {
    functionsBaseUrl: 'https://example.supabase.co/functions/v1',
    accessToken: 'test',
    publishableKey: 'test',
    timeoutMs: 10,
    fetchImpl: async () => {
      throw new Error('No transport permitted');
    },
  };
  const options = {
    transport,
    table: 'flows' as const,
    ...identity,
    payload: content,
    beforeDispatch: () => {
      dispatches += 1;
    },
  };
  await assert.rejects(() => createDatasetRecord(options), {
    code: 'FLOW_REFERENCE_PROPERTY_INVALID',
  });
  await assert.rejects(() => saveDraftDatasetRecord(options), {
    code: 'FLOW_REFERENCE_PROPERTY_INVALID',
  });
  assert.equal(dispatches, 0);
});

test('Real SDK package validation applies the same semantic rule and preserves the package', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flow-reference-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'flows'));
  const file = path.join(directory, 'flows', 'candidate.json');
  const validator = createTidasSdkPackageValidator(
    sdk as unknown as Parameters<typeof createTidasSdkPackageValidator>[0],
    '@tiangong-lca/tidas-sdk',
  )!;
  for (const factor of ['0.45', '1.00000000000000000001', '1.0']) {
    const source = JSON.stringify(businessFlowReferenceFixture(factor));
    writeFileSync(file, source);
    const report = validator.validatePackageDir(directory);
    const issues = report.categories.flatMap((category) => category.issues);
    assert.equal(issues.length, factor === '1.0' ? 0 : 1, JSON.stringify(report));
    if (factor !== '1.0') {
      assert.equal(issues[0]?.issue_code, 'reference_property_not_one');
      assert.equal(issues[0]?.location, 'flowDataSet/flowProperties/flowProperty/1/meanValue');
    }
    assert.equal(readFileSync(file, 'utf8'), source);
  }
});
