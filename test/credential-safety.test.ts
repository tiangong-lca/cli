import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __testInternals,
  fingerprintSecret,
  redactEmail,
} from '../src/lib/auth/credential-safety.js';
import { loadDistModule } from './helpers/load-dist-module.js';

test('fingerprintSecret is stable and rejects empty values', () => {
  assert.equal(fingerprintSecret('secret-value'), fingerprintSecret(' secret-value '));
  assert.match(fingerprintSecret('secret-value'), /^sha256:/u);
  assert.throws(() => fingerprintSecret('   '), /Cannot fingerprint an empty secret value/u);
});

test('redactEmail and normalization cover edge cases', () => {
  assert.equal(redactEmail('ab@example.com'), '****@example.com');
  assert.equal(redactEmail('abcdef@example.com'), 'ab****@example.com');
  assert.equal(redactEmail('invalid-address'), '****');
  assert.equal(__testInternals.normalizeCredentialValue(' value '), 'value');
  assert.equal(__testInternals.normalizeCredentialValue(null), '');
});

test('credential-safety helpers behave the same from the built dist module', async () => {
  const module = await loadDistModule<typeof import('../src/lib/auth/credential-safety.js')>(
    'src/lib/auth/credential-safety.js',
  );
  assert.equal(module.redactEmail('abcdef@example.com'), 'ab****@example.com');
  assert.equal(module.fingerprintSecret('secret-value'), fingerprintSecret('secret-value'));
});
