import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { cliFailure } from '../src/shared/legacy-command-result.js';
import { parseMaintenanceScope } from '../src/lib/maintenance/contract/scope.js';
import { computePlanSha256, parseMaintenancePlan } from '../src/lib/maintenance/contract.js';
import { resolveCliStateDirectory } from '../src/shared/state-directory.js';
import {
  batchRunLockPath,
  withBatchRunLock,
  BatchRunLockIdentityConflictError,
} from '../src/batch.js';
import * as internalLocks from '../src/lib/locks/run-lock.js';
import { BatchRunLockIdentityConflictError as InternalConflict } from '../src/lib/locks/errors.js';

test('retired repair commands and planning flags reject before IO', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-retired-maintenance-'));
  const output = path.join(root, 'not-created');
  let effects = 0;
  try {
    const deps = {
      env: {},
      dotEnvStatus: { loaded: false, path: '/unused', count: 0 },
      fetchImpl: async () => {
        effects++;
        throw new Error('No transport permitted');
      },
      runDatasetMaintenancePlanImpl: async () => {
        effects++;
        throw new Error('No plan permitted');
      },
    };
    for (const args of [
      ...['capture', 'plan', 'freeze', 'seal-approval', 'run', 'verify'].map((action) => [
        'flow-identity',
        action,
      ]),
      ...['freeze-protected', 'seal-protected-approval', 'run-protected'].map((action) => [action]),
      ['plan', '--alias-v2-input', 'missing.json'],
      ['plan', '--length-time-input', 'missing.json'],
      ['plan', '--scope', 'missing.json', '--operation', 'merge-support-aliases'],
    ]) {
      for (const help of [[], ['--help']]) {
        const result = await executeCli(
          ['dataset', 'maintenance', ...args, '--out-dir', output, ...help],
          deps,
        );
        assert.equal(result.exitCode, 2, args.join(' '));
      }
    }
    const help = await executeCli(['dataset', 'maintenance', '--help'], deps);
    assert.equal(help.exitCode, 0);
    assert.doesNotMatch(
      help.stdout,
      /alias-v2|length-time|flow-identity|freeze-protected|run-protected/u,
    );
    assert.equal(effects, 0);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const scope = {
  schema_version: 1,
  task_id: 'test',
  operation: 'delete',
  account: { user_id: 'owner' },
  actions: [
    {
      action_id: 'delete',
      action: 'delete',
      table: 'flows',
      id: 'flow',
      version: '01.00.000',
      expected_user_id: 'owner',
      expected_state_code: 0,
      reason_code: 'test',
      reason: 'test',
      evidence: [],
    },
  ],
};

test('ordinary maintenance cannot reinterpret repair manifests as generic mutations', () => {
  for (const value of [
    { ...scope, operation: 'merge-support-aliases' },
    { ...scope, alias_batches: [] },
    ...['batch_id', 'exchange_instances', 'alias_mutation'].map((field) => ({
      ...scope,
      actions: [{ ...scope.actions[0], [field]: null }],
    })),
    { ...scope, actions: [{ ...scope.actions[0], action: 'update_json_ordered' }] },
    { ...scope, actions: [{ ...scope.actions[0], table: 'flowproperties' }] },
    { ...scope, operation: 'rebuild-derivatives' },
  ])
    assert.throws(() => parseMaintenanceScope(value), /Unsupported|not supported|cannot/u);
  assert.throws(
    () =>
      parseMaintenancePlan({
        schema_version: 1,
        actions: [],
        protected_rows: [],
        blockers: [],
        account: {},
        artifacts: {},
        alias_batches: [],
      }),
    /not supported/u,
  );
  // A correctly hashed ordinary artifact still must pass operation/action admission.
  const raw = {
    ...scope,
    actions: [{ ...scope.actions[0], action: 'rebuild_derivatives' }],
    protected_rows: [],
    blockers: [],
    artifacts: {},
    plan_sha256: '',
  };
  const plan = raw as unknown as Parameters<typeof computePlanSha256>[0];
  plan.plan_sha256 = computePlanSha256(plan);
  assert.throws(() => parseMaintenancePlan(plan), /protected|unsupported/u);
});

test('public and internal locks share functions, classes and the same reentrant domain', async () => {
  assert.equal(withBatchRunLock, internalLocks.withBatchRunLock);
  assert.equal(BatchRunLockIdentityConflictError, InternalConflict);
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-shared-lock-'));
  try {
    assert.equal(batchRunLockPath(root), internalLocks.batchRunLockPath(root));
    await internalLocks.withBatchRunLock(
      { runPath: root, reason: 'internal', identity: { run: 1 } },
      async (outer) => {
        await withBatchRunLock({ runPath: root, reason: 'public', identity: { run: 1 } }, (inner) =>
          assert.equal(inner, outer),
        );
        await assert.rejects(
          withBatchRunLock(
            { runPath: root, reason: 'conflict', identity: { run: 2 } },
            () => undefined,
          ),
          InternalConflict,
        );
      },
    );
    assert.equal(existsSync(batchRunLockPath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared state-directory extraction preserves Study storage locations on every platform', async () => {
  assert.equal(
    resolveCliStateDirectory({
      env: { XDG_STATE_HOME: '/state' },
      homeDir: '/home',
      platform: 'linux',
    }),
    path.resolve('/state/tiangong-lca-cli'),
  );
  assert.equal(
    resolveCliStateDirectory({
      env: { LOCALAPPDATA: '/local' },
      homeDir: '/home',
      platform: 'win32',
    }),
    path.resolve('/local/tiangong-lca-cli'),
  );
  for (const platform of ['linux', 'darwin', 'win32'] as const)
    assert.equal(
      resolveCliStateDirectory({ env: {}, homeDir: '/home', platform }),
      path.resolve('/home/.local/state/tiangong-lca-cli'),
    );
  assert.equal(
    resolveCliStateDirectory({ env: {}, homeDir: '', platform: 'darwin' }),
    path.resolve(os.homedir(), 'Library/Application Support/tiangong-lca-cli'),
  );
  assert.equal(
    resolveCliStateDirectory({ env: { LOCALAPPDATA: ' ' }, homeDir: '', platform: 'win32' }),
    path.resolve('.tiangong-lca-cli-state'),
  );
  assert.equal(
    resolveCliStateDirectory({ env: {} }),
    path.resolve(os.homedir(), '.local/state/tiangong-lca-cli'),
  );
  assert.deepEqual(Object.keys(await import('../src/lib/locks/types.js')), []);
});

test('a non-domain process failure retains the error projection and failing exit status', () => {
  assert.deepEqual(cliFailure(new Error('fixture failure')), {
    exitCode: 1,
    stdout: '',
    stderr: '{"error":{"code":"UNEXPECTED_ERROR","message":"fixture failure"}}\n',
  });
});
