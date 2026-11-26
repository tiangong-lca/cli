import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_IDENTITY_MAX_TIMEOUT_MS,
  AUTH_IDENTITY_RECEIPT_SCHEMA,
  parseAuthIdentityReceipt,
  type AuthIdentityReceipt,
} from '../src/auth-identity-receipt.js';
import * as internal from '../src/lib/auth/auth-identity-receipt.js';

test('public auth identity receipt entry is a direct bounded semantic re-export', () => {
  assert.equal(AUTH_IDENTITY_RECEIPT_SCHEMA, 'tiangong-lca.auth-identity-receipt.v1');
  assert.equal(AUTH_IDENTITY_MAX_TIMEOUT_MS, 2_147_483_647);
  assert.equal(parseAuthIdentityReceipt, internal.parseAuthIdentityReceipt);

  const acceptType = (receipt: AuthIdentityReceipt): string => receipt.receipt_scope_sha256;
  assert.equal(typeof acceptType, 'function');
  assert.throws(
    () => parseAuthIdentityReceipt({}),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'AUTH_IDENTITY_RECEIPT_INVALID');
      return true;
    },
  );
});

test('public auth identity receipt entry does not expose remote execution or internals', async () => {
  const publicApi = await import('../src/auth-identity-receipt.js');
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'AUTH_IDENTITY_MAX_TIMEOUT_MS',
    'AUTH_IDENTITY_RECEIPT_SCHEMA',
    'parseAuthIdentityReceipt',
  ]);
  assert.equal('runAuthIdentityReceipt' in publicApi, false);
  assert.equal('__testInternals' in publicApi, false);
});
