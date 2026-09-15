import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  CORE_PUBLIC_RELATIONS,
  DATA_API_CONTRACT,
  DATA_API_PROFILE_ENV,
  DATA_API_RPC_REPLAY_CLASSIFICATION,
  DATA_API_RPC_TARGETS,
  isDataApiAuthRefreshReplaySafe,
  isDataApiUrl,
  resolveDataApiCapability,
  resolveDataApiCapabilityFromUrl,
  resolveDataApiProfile,
} from '../src/lib/supabase-data-api-contract.js';

test('data api manifest freezes the exact database contract and complete CLI inventory', () => {
  assert.equal(DATA_API_CONTRACT.schemaVersion, 'tiangong-lca-cli.data-api-contract.v1');
  assert.equal(
    DATA_API_CONTRACT.databaseContract.databaseCommit,
    '1320dcc506fe37af6b625ae30fbe0bec38cf87c6',
  );
  assert.equal(DATA_API_CONTRACT.databaseContract.migrationHead, '20260902104500');
  assert.equal(DATA_API_CONTRACT.databaseContract.contractReady, true);
  assert.equal(
    DATA_API_CONTRACT.databaseContract.migrationSetGitTreeSha,
    '88e212220c0037cee673d0522340d3cca5e791dd',
  );
  assert.deepEqual(DATA_API_CONTRACT.databaseContract.contractMigrations, {
    fullSchemaCutover: {
      path: 'supabase/migrations/20260805130000_full_schema_cutover.sql',
      sha256: 'd409022fb25d9313d17b0f76216ca6e4abbfce7d6c5b6e74c869314d1c7e5afb',
    },
    apiContractClosure: {
      path: 'supabase/migrations/20260806160000_api_contract_closure.sql',
      sha256: 'e0e7aec8e03d70c60ee0d5c2b332ce73fa7b4b229725c9a9fcb0e1a1d7e8c511',
    },
    processModelVersionContract: {
      path: 'supabase/migrations/20260902100000_process_model_version_contract.sql',
      sha256: '99cbaf474098281ea8c57fcef093174d0ef78a18300f133dd8cc6f9e59a4a29b',
    },
    processSaveDraftModelVersion: {
      path: 'supabase/migrations/20260902103509_add_process_model_version_to_dataset_save_draft.sql',
      sha256: 'ca93f3279673e292803bd8c477aec76b772c7246e16114808d31e64994037723',
    },
    migrationHead: {
      path: 'supabase/migrations/20260902104500_use_exact_model_version_in_review_ownership.sql',
      sha256: '538ec3001f7683b57817e4a89973ded127522ce94521720ed583de99711bbe60',
    },
  });
  assert.equal(
    DATA_API_CONTRACT.databaseContract.snapshotRole,
    'frozen-process-model-version-contract',
  );
  assert.equal(
    DATA_API_CONTRACT.databaseContract.provenanceIssue,
    'tiangong-lca/database-engine#589',
  );
  assert.equal(DATA_API_CONTRACT.databaseContract.publicCoreTableCount, 9);
  assert.equal(DATA_API_CONTRACT.databaseContract.publicRoutineCount, 0);
  assert.deepEqual(CORE_PUBLIC_RELATIONS, [
    'contacts',
    'flowproperties',
    'flows',
    'ilcd',
    'lciamethods',
    'lifecyclemodels',
    'processes',
    'sources',
    'unitgroups',
  ]);
  assert.equal(Object.keys(DATA_API_RPC_TARGETS).length, 17);
  assert.equal(Object.keys(DATA_API_RPC_REPLAY_CLASSIFICATION).length, 17);
  assert.equal(
    DATA_API_RPC_TARGETS.search_sources.signature,
    'api.search_sources(query_text text, filter_condition jsonb, page_size integer, page_current integer, data_source text, this_user_id text, team_id_filter uuid, state_code_filter integer)',
  );
  assert.deepEqual(DATA_API_RPC_REPLAY_CLASSIFICATION.search_sources, {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  });
  assert.deepEqual(
    Object.keys(DATA_API_RPC_REPLAY_CLASSIFICATION).sort(),
    Object.keys(DATA_API_RPC_TARGETS).sort(),
  );
  assert.deepEqual(DATA_API_CONTRACT.views, []);
  assert.equal(DATA_API_CONTRACT.retryPolicy.mutations.startsWith('no automatic'), true);
  assert.deepEqual(DATA_API_CONTRACT.blockers, []);
  assert.equal(
    DATA_API_CONTRACT.retiredCapabilities[0].capability,
    'rpc:cmd_dataset_alias_plan_guarded',
  );
  assert.equal(
    Object.values(DATA_API_RPC_TARGETS).every(
      (target) => target.targetSchema === 'api' && target.signature.startsWith('api.'),
    ),
    true,
  );
});

test('auth refresh replay classification is method- and capability-aware', () => {
  const rest = 'https://example.supabase.co/rest/v1';
  assert.equal(isDataApiAuthRefreshReplaySafe({ url: `${rest}/processes`, method: 'HEAD' }), true);
  assert.equal(
    isDataApiAuthRefreshReplaySafe({
      url: `${rest}/rpc/cmd_dataset_derivative_rebuild_read`,
      method: 'POST',
    }),
    true,
  );
  assert.equal(
    isDataApiAuthRefreshReplaySafe({
      url: `${rest}/rpc/cmd_dataset_save_draft`,
      method: 'POST',
    }),
    false,
  );
  assert.equal(
    isDataApiAuthRefreshReplaySafe({ url: `${rest}/rpc/unknown_rpc`, method: 'POST' }),
    false,
  );
  assert.equal(
    isDataApiAuthRefreshReplaySafe({ url: `${rest}/processes`, method: 'PATCH' }),
    false,
  );
});

test('profile parsing defaults to the frozen api contract and rejects retired public profiles', () => {
  assert.equal(resolveDataApiProfile({}), 'api-contract-v1');
  assert.equal(
    resolveDataApiProfile({ [DATA_API_PROFILE_ENV]: ' api-contract-v1 ' }),
    'api-contract-v1',
  );
  assert.throws(
    () => resolveDataApiProfile({ [DATA_API_PROFILE_ENV]: 'legacy-public-v1' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_PROFILE_INVALID',
  );
});

test('core relations stay explicitly public under the frozen api profile', () => {
  const capability = resolveDataApiCapability({
    kind: 'relation',
    name: 'processes',
  });
  assert.equal(capability.schema, 'public');
  assert.equal(capability.profile, 'api-contract-v1');
  assert.equal(capability.signature, null);
  assert.throws(
    () => resolveDataApiCapability({ kind: 'relation', name: 'process_build_runs' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_CAPABILITY_UNMANIFESTED',
  );
});

test('rpc resolution uses only frozen api signatures and rejects retired private executors', () => {
  const current = resolveDataApiCapability({
    kind: 'rpc',
    name: 'cmd_dataset_delete',
  });
  assert.equal(current.schema, 'api');
  assert.match(current.signature ?? '', /^api\.cmd_dataset_delete\(.+p_audit jsonb\)$/u);

  assert.throws(
    () => resolveDataApiCapability({ kind: 'rpc', name: 'cmd_dataset_alias_plan_guarded' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_CAPABILITY_UNMANIFESTED',
  );
  assert.throws(
    () => resolveDataApiCapability({ kind: 'rpc', name: 'guessed_future_rpc' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_CAPABILITY_UNMANIFESTED',
  );
});

test('CLI role matrix fails closed for anon and service credentials', () => {
  assert.equal(
    resolveDataApiCapability({ kind: 'relation', name: 'flows', role: 'authenticated' }).role,
    'authenticated',
  );
  for (const role of ['anon', 'service_role'] as const) {
    assert.throws(
      () => resolveDataApiCapability({ kind: 'relation', name: 'flows', role }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'DATA_API_ROLE_FORBIDDEN',
    );
  }
});

test('profile headers are explicit and method-aware', () => {
  const relation = resolveDataApiCapability({ kind: 'relation', name: 'flows' });
  assert.deepEqual(applyDataApiProfileHeaders({ Prefer: 'count=exact' }, relation), {
    'accept-profile': 'public',
    prefer: 'count=exact',
  });
  assert.equal(applyDataApiProfileHeaders(undefined, relation, 'HEAD')['accept-profile'], 'public');

  const rpc = resolveDataApiCapability({
    kind: 'rpc',
    name: 'cmd_dataset_delete',
    profile: 'api-contract-v1',
  });
  assert.equal(applyDataApiProfileHeaders(undefined, rpc, 'POST')['content-profile'], 'api');
  assert.equal(applyDataApiProfileHeaders(undefined, rpc, 'PATCH')['content-profile'], 'api');
});

test('URL resolution binds relations and RPCs to the manifest', () => {
  assert.equal(isDataApiUrl('https://example.supabase.co/rest/v1/processes'), true);
  assert.equal(isDataApiUrl('https://example.supabase.co/auth/v1/user'), false);
  const relation = resolveDataApiCapabilityFromUrl({
    url: 'https://example.supabase.co/rest/v1/processes?id=eq.1',
  });
  assert.equal(relation.name, 'processes');
  assert.equal(
    buildDataApiUrl('https://example.supabase.co/rest/v1/', relation),
    'https://example.supabase.co/rest/v1/processes',
  );

  const rpc = resolveDataApiCapabilityFromUrl({
    url: 'https://example.supabase.co/rest/v1/rpc/cmd_dataset_delete',
    method: 'POST',
    profile: 'api-contract-v1',
  });
  assert.equal(rpc.schema, 'api');
  assert.equal(
    buildDataApiUrl('https://example.supabase.co/rest/v1', rpc),
    'https://example.supabase.co/rest/v1/rpc/cmd_dataset_delete',
  );

  assert.throws(
    () => resolveDataApiCapabilityFromUrl({ url: 'https://example.supabase.co/auth/v1/user' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_URL_INVALID',
  );
  assert.throws(
    () => resolveDataApiCapabilityFromUrl({ url: 'https://example.supabase.co/rest/v1/' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'DATA_API_URL_INVALID',
  );
});
