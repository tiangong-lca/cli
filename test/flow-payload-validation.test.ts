import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testInternals,
  summarizeFlowPayloadValidation,
  validateFlowPayload,
} from '../src/lib/flow-payload-validation.js';

test('validateFlowPayload summarizes injected FlowSchema success and failures', () => {
  const success = validateFlowPayload(
    {},
    {
      safeParse: () => ({ success: true }),
    },
    null,
  );
  assert.equal(success.ok, true);
  assert.equal(summarizeFlowPayloadValidation(success), 'local FlowSchema validation passed');

  const failure = validateFlowPayload(
    {},
    {
      safeParse: () => ({
        success: false,
        error: {
          issues: [
            {
              path: ['flowDataSet', 'flowInformation'],
              message: 'Required',
              code: 'invalid_type',
            },
          ],
        },
      }),
    },
    null,
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.issue_count, 1);
  assert.deepEqual(failure.issues[0], {
    path: 'flowDataSet.flowInformation',
    message: 'Required',
    code: 'invalid_type',
  });
  assert.match(summarizeFlowPayloadValidation(failure), /local FlowSchema validation failed/u);

  const fallbackFailure = validateFlowPayload(
    {},
    {
      safeParse: () => ({
        success: false,
        error: {
          issues: [
            {
              path: [],
            },
          ],
        },
      }),
    },
    null,
  );
  assert.equal(fallbackFailure.ok, false);
  assert.deepEqual(fallbackFailure.issues[0], {
    path: '<root>',
    message: 'Validation failed',
    code: 'custom',
  });
  assert.equal(
    summarizeFlowPayloadValidation({
      ok: false,
      validator: 'test-flow-validator',
      issue_count: 0,
      issues: [],
    }),
    'local FlowSchema validation failed with 0 issue(s)',
  );
});

test('flow payload validation internals detect optional SDK factory support', () => {
  assert.equal(typeof __testInternals.getFlowSchema().safeParse, 'function');
  assert.throws(() => __testInternals.getFlowSchema({}), /FlowSchema is unavailable/u);
  assert.equal(__testInternals.getFlowFactory({ createFlow: 'not-a-function' }), null);
  assert.equal(typeof __testInternals.getFlowFactory({ createFlow: () => ({}) }), 'function');
});

test('flow payload validation rejects semicolons in every name segment and language without rewriting synonyms', () => {
  const schema = { safeParse: () => ({ success: true as const }) };
  for (const field of [
    'baseName',
    'treatmentStandardsRoutes',
    'mixAndLocationTypes',
    'flowProperties',
  ]) {
    for (const punctuation of [';', '；']) {
      const payload = {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              name: {
                baseName: { '@xml:lang': 'en', '#text': 'Battery' },
                [field]: [
                  { '@xml:lang': 'en', '#text': 'Battery' },
                  { '@xml:lang': 'de', '#text': `Batterie${punctuation} Prüfung` },
                ],
              },
              'common:synonyms': { '@xml:lang': 'en', '#text': 'battery; accumulator；cell' },
            },
          },
        },
      };
      const before = structuredClone(payload);
      const result = validateFlowPayload(payload, schema, null);
      assert.equal(result.ok, false, `${field}: ${punctuation}`);
      assert.equal(result.issue_count, 1);
      assert.equal(result.issues[0]?.code, 'dataset_name_semicolon');
      assert.equal(
        result.issues[0]?.path,
        `flowDataSet.flowInformation.dataSetInformation.name.${field}.1.#text`,
      );
      assert.deepEqual(payload, before);
    }
  }
  const synonymsOnly = {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          name: { baseName: { '@xml:lang': 'de', '#text': 'Batterie, wiederaufladbar' } },
          'common:synonyms': { '@xml:lang': 'en', '#text': 'battery; accumulator；cell' },
        },
      },
    },
  };
  const before = structuredClone(synonymsOnly);
  assert.equal(validateFlowPayload(synonymsOnly, schema, null).ok, true);
  assert.deepEqual(synonymsOnly, before);
});
