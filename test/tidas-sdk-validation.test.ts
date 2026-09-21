import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeIssuePath,
  runEntityValidation,
  validateEntityWithDeepFallback,
  validateSchemaWithDeepFallback,
  validationIssues,
  validationSucceeded,
  type SdkValidationFactory,
} from '../src/lib/tidas-sdk-validation.js';

test('tidas sdk validation helpers keep schema success on the fast path', () => {
  let factoryCalls = 0;
  const result = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({ success: true, data: { ok: true } }),
    },
    { ok: true },
    (() => {
      factoryCalls += 1;
      return { validateEnhanced: () => ({ success: true }) };
    }) as SdkValidationFactory,
  );

  assert.equal(result.success, true);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(result.issues, []);
});

test('tidas sdk validation helpers use deep entity issues after schema failure', () => {
  const configs: boolean[] = [];
  const result = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({
        success: false,
        error: { issues: [{ path: ['fast'], message: 'fast issue', code: 'fast' }] },
      }),
    },
    { invalid: true },
    ((_, config) => {
      configs.push(config?.deepValidation ?? false);
      return {
        validateEnhanced: () =>
          config?.deepValidation
            ? {
                success: false,
                error: {
                  issues: [{ path: ['deep'], message: 'deep issue', code: 'deep' }],
                },
              }
            : {
                success: false,
                error: {
                  issues: [{ path: ['shallow'], message: 'shallow issue', code: 'shallow' }],
                },
              },
      };
    }) as SdkValidationFactory,
  );

  assert.equal(result.success, false);
  assert.deepEqual(configs, [false, true]);
  assert.deepEqual(result.issues, [{ path: ['deep'], message: 'deep issue', code: 'deep' }]);
});

test('tidas sdk validation helpers preserve indexed schema issues over unindexed deep failures', () => {
  const indexedIssue = {
    path: ['processDataSet', 'modellingAndValidation', 'validation', 'review', 1, '@type'],
    message: 'invalid second review',
    code: 'invalid_type',
  };
  const result = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({ success: false, error: { issues: [indexedIssue] } }),
    },
    { invalid: true },
    (() => ({
      validateEnhanced: () => ({
        success: false,
        error: { issues: [{ path: ['review'], message: 'entity rejected review array' }] },
      }),
    })) as SdkValidationFactory,
  );

  assert.equal(result.success, false);
  assert.deepEqual(result.issues, [indexedIssue]);
});

test('tidas sdk validation helpers prefer empty deep failures when schema has no issues', () => {
  const deepFailure = { success: false, error: { issues: [] } };
  const result = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({ success: false, error: { issues: [] } }),
    },
    { invalid: true },
    ((_, config) => ({
      validateEnhanced: () => (config?.deepValidation ? deepFailure : { success: false }),
    })) as SdkValidationFactory,
  );

  assert.equal(result.success, false);
  assert.deepEqual(result.issues, []);
  assert.equal(result.result, deepFailure);
});

test('tidas sdk validation helpers preserve schema issues when entity fallback cannot help', () => {
  const schemaFailure = {
    path: ['schema'],
    message: 'schema issue',
    code: 'schema',
  };
  const thrown = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({ success: false, error: { issues: [schemaFailure] } }),
    },
    {},
    (() => {
      throw new Error('entity unavailable');
    }) as SdkValidationFactory,
  );
  assert.equal(thrown.success, false);
  assert.deepEqual(thrown.issues, [schemaFailure]);

  const noFactory = validateSchemaWithDeepFallback(
    {
      safeParse: () => ({ success: false, error: { issues: [schemaFailure] } }),
    },
    {},
    null,
  );
  assert.equal(noFactory.success, false);
  assert.deepEqual(noFactory.issues, [schemaFailure]);
});

test('tidas sdk validation helpers prefer validateEnhanced and fall back to validate', () => {
  assert.deepEqual(runEntityValidation(null), null);
  assert.deepEqual(runEntityValidation({}), null);
  assert.deepEqual(runEntityValidation({ validate: () => ({ success: true, data: 1 }) }), {
    success: true,
    data: 1,
  });
  assert.deepEqual(
    runEntityValidation({
      validateEnhanced: () => ({ success: true, data: 2 }),
      validate: () => ({ success: true, data: 1 }),
    }),
    { success: true, data: 2 },
  );
});

test('tidas sdk validation helpers run deep validation only after entity failure', () => {
  const successConfigs: boolean[] = [];
  const success = validateEntityWithDeepFallback({}, ((_, config) => {
    successConfigs.push(config?.deepValidation ?? false);
    return { validateEnhanced: () => ({ success: true }) };
  }) as SdkValidationFactory);
  assert.deepEqual(successConfigs, [false]);
  assert.deepEqual(success, { success: true });

  const failureConfigs: boolean[] = [];
  const failure = validateEntityWithDeepFallback({}, ((_, config) => {
    failureConfigs.push(config?.deepValidation ?? false);
    return config?.deepValidation
      ? { validate: () => ({ success: false, validationIssues: [{ path: ['deep'] }] }) }
      : { validate: () => ({ success: false, error: { issues: [{ path: ['fast'] }] } }) };
  }) as SdkValidationFactory);
  assert.deepEqual(failureConfigs, [false, true]);
  assert.deepEqual(validationIssues(failure), [{ path: ['deep'] }]);
});

test('tidas sdk validation helpers normalize issue paths and results', () => {
  assert.equal(validationSucceeded({ success: true }), true);
  assert.equal(validationSucceeded({ success: false }), false);
  assert.equal(validationSucceeded(null), false);
  assert.deepEqual(validationIssues({ success: false, error: { issues: [null, { path: [] }] } }), [
    { path: [] },
  ]);
  assert.deepEqual(validationIssues({ success: false, validationIssues: [{ path: ['x'] }] }), [
    { path: ['x'] },
  ]);
  assert.deepEqual(validationIssues('failure'), []);
  assert.equal(normalizeIssuePath(undefined), '<root>');
  assert.equal(normalizeIssuePath([], '/'), '<root>');
  assert.equal(normalizeIssuePath(['a', 0, 'b'], '/'), 'a/0/b');
});
