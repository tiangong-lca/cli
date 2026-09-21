import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanDataApiConsumers } from '../scripts/scan-data-api-consumers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scanFixture(
  source: string,
  relationConsumers: Record<string, readonly string[]> = {},
  rpcTargets: Record<string, unknown> = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'data-api-scan-'));
  try {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'fixture.ts'), source, 'utf8');
    return scanDataApiConsumers(root, { relationConsumers, rpcTargets });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('consumer-zero scan inventories every active relation and api RPC without retired public routes', () => {
  const report = scanDataApiConsumers(repoRoot);
  assert.equal(report.consumer_zero, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.inventory.view_names, []);
  assert.deepEqual(report.inventory.core_relation_names, [
    'contacts',
    'flowproperties',
    'flows',
    'lciamethods',
    'lifecyclemodels',
    'processes',
    'sources',
    'unitgroups',
  ]);
  // The versioned (v2) protected lifecycle endpoints are approved surface: four additive names.
  assert.equal(report.inventory.rpc_names.length, 20);
  for (const name of [
    'cmd_dataset_alias_execution_preflight_v2_guarded',
    'cmd_dataset_alias_execution_gate_v2_guarded',
    'cmd_dataset_alias_execution_admit_v2_guarded',
    'cmd_dataset_alias_execution_read_v2',
  ]) {
    assert.equal(report.inventory.rpc_names.includes(name), true, name);
  }
  assert.equal(report.inventory.rpc_names.includes('cmd_dataset_alias_plan_guarded'), false);
  assert.equal(
    report.inventory.rpc_names.includes('private.cmd_dataset_alias_batch_v2_guarded'),
    false,
  );
  assert.equal(report.contract.contractReady, true);
  assert.equal(report.contract.databaseCommit, '1320dcc506fe37af6b625ae30fbe0bec38cf87c6');
  assert.equal(report.contract.migrationHead, '20260902104500');
});

test('scan rejects a static non-core relation', () => {
  const report = scanFixture("client.from('private_table').select('*');\n");
  assert.ok(report.findings.some((finding) => finding.code === 'UNMANIFESTED_RELATION'));
});

test('scan rejects an RPC literal missing from the manifest', () => {
  const report = scanFixture("client.rpc('unknown_rpc', {});\n");
  assert.ok(report.findings.some((finding) => finding.code === 'UNMANIFESTED_RPC'));
});

test('scan rejects dynamic relation and RPC identifiers without an explicit helper annotation', () => {
  const report = scanFixture('client.from(table).select();\nclient.rpc(rpcName, {});\n');
  assert.ok(report.findings.some((finding) => finding.code === 'DYNAMIC_RELATION_IDENTIFIER'));
  assert.ok(report.findings.some((finding) => finding.code === 'DYNAMIC_RPC_IDENTIFIER'));
});

test('scan rejects a manifest that omits an observed relation consumer', () => {
  const report = scanFixture("client.from('processes').select('*');\n", { processes: [] });
  assert.ok(report.findings.some((finding) => finding.code === 'RELATION_CONSUMER_UNDECLARED'));
});

test('scan rejects a manifest consumer that is not observed in that file', () => {
  const report = scanFixture('export const value = 1;\n', {
    processes: ['src/fixture.ts'],
  });
  assert.ok(report.findings.some((finding) => finding.code === 'MANIFEST_CONSUMER_NOT_OBSERVED'));
});
