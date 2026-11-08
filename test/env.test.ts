import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDistModule } from './helpers/load-dist-module.js';
import {
  __testInternals,
  buildDoctorReport,
  maskSecret,
  readRuntimeEnv,
  resolveEnv,
} from '../src/lib/env.js';

test('resolveEnv prefers a present env key', () => {
  const resolved = resolveEnv(
    {
      key: 'A',
      required: true,
      description: 'demo',
    },
    { A: 'canonical' },
  );

  assert.equal(resolved.source, 'env');
  assert.equal(resolved.value, 'canonical');
});

test('resolveEnv falls back to defaults when env is missing', () => {
  const resolved = resolveEnv(
    {
      key: 'A',
      required: false,
      description: 'demo',
      defaultValue: 'fallback',
    },
    {},
  );

  assert.equal(resolved.source, 'default');
  assert.equal(resolved.value, 'fallback');
});

test('resolveEnv reports missing when nothing is available', () => {
  const resolved = resolveEnv(
    {
      key: 'A',
      required: true,
      description: 'demo',
    },
    {},
  );

  assert.equal(resolved.source, 'missing');
  assert.equal(resolved.present, false);
  assert.equal(resolved.value, null);
});

test('readRuntimeEnv returns the canonical TianGong LCA runtime config', () => {
  const runtime = readRuntimeEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
  });

  assert.deepEqual(runtime, {
    apiBaseUrl: 'https://example.com/functions/v1',
    authMode: null,
    oauthClientId: null,
    oauthRedirectUri: null,
    accessToken: 'secret-token',
    region: 'us-east-1',
    supabasePublishableKey: 'sb-publishable-key',
    sessionFile: null,
    disableSessionCache: false,
    forceReauth: false,
  });
});

test('readRuntimeEnv includes OAuth and headless configuration', () => {
  assert.deepEqual(
    readRuntimeEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.com',
      TIANGONG_LCA_AUTH_MODE: 'oauth',
      TIANGONG_LCA_OAUTH_CLIENT_ID: 'client-id',
      TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:49191/oauth/callback',
      TIANGONG_LCA_ACCESS_TOKEN: 'actor-token',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'publishable',
    }),
    {
      apiBaseUrl: 'https://example.com',
      authMode: 'oauth',
      oauthClientId: 'client-id',
      oauthRedirectUri: 'http://127.0.0.1:49191/oauth/callback',
      accessToken: 'actor-token',
      region: 'us-east-1',
      supabasePublishableKey: 'publishable',
      sessionFile: null,
      disableSessionCache: false,
      forceReauth: false,
    },
  );
});

test('maskSecret leaves short values unchanged and masks longer values', () => {
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret('short'), 'short');
  assert.equal(maskSecret('1234567890'), '1234...7890');
});

test('env boolean helpers normalize true-ish values and null fallbacks', () => {
  assert.equal(__testInternals.parseBooleanEnv(null), false);
  assert.equal(__testInternals.parseBooleanEnv('1'), true);
  assert.equal(__testInternals.parseBooleanEnv('true'), true);
  assert.equal(__testInternals.parseBooleanEnv('yes'), true);
  assert.equal(__testInternals.parseBooleanEnv('on'), true);
  assert.equal(__testInternals.parseBooleanEnv('no'), false);
});

test('buildDoctorReport records canonical TianGong LCA env keys', () => {
  const report = buildDoctorReport(
    {
      TIANGONG_LCA_API_BASE_URL: 'https://example.com',
      TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
    },
    { loaded: true, path: '/tmp/.env', count: 3 },
  );

  assert.equal(report.ok, true);
  const accessTokenCheck = report.checks.find((check) => check.key === 'TIANGONG_LCA_ACCESS_TOKEN');
  assert.equal(accessTokenCheck?.source, 'env');
  assert.equal(accessTokenCheck?.valuePreview, '[redacted]');
  assert.ok(
    !JSON.stringify(
      buildDoctorReport(
        { TIANGONG_LCA_ACCESS_TOKEN: 'tiny' },
        { loaded: false, path: '', count: 0 },
      ),
    ).includes('tiny'),
  );
  const publishableCheck = report.checks.find(
    (check) => check.key === 'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
  );
  assert.equal(publishableCheck?.source, 'env');

  assert.equal(buildDoctorReport({}, { loaded: false, path: '', count: 0 }).ok, true);
  assert.equal(
    buildDoctorReport(
      {
        TIANGONG_LCA_API_BASE_URL: 'https://example.com',
        TIANGONG_LCA_OAUTH_CLIENT_ID: 'client-id',
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'publishable',
      },
      { loaded: false, path: '', count: 0 },
    ).ok,
    true,
  );
});

test('built runtime and source expose the same official bootstrap and doctor behavior', async () => {
  const built = await loadDistModule<typeof import('../src/lib/env.js')>('src/lib/env.js');
  assert.deepEqual(built.readRuntimeEnv({}), readRuntimeEnv({}));
  assert.equal(
    built.resolveEnv({ key: 'A', required: false, description: 'demo' }, {}).present,
    false,
  );
  assert.equal(built.maskSecret('1234567890'), maskSecret('1234567890'));
  assert.equal(built.buildDoctorReport({}, { loaded: false, path: '', count: 0 }).ok, true);
});
