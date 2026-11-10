import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import { maintenanceRowKey, snapshotRemoteRow } from '../src/lib/maintenance/contract/values.js';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import {
  assertDerivativeBaselines,
  assertDerivativeCensusBindings,
  assertStrictBeforeState,
  assertSupportSnapshots,
  captureDerivativeSnapshots,
  projectedRows,
  validateProtectedBeforeState,
  type ProtectedBeforeReadDependencyOverrides,
  type ProtectedDerivativeSnapshotTarget,
} from '../src/lib/dataset-maintenance-protected-before.js';
import type {
  ProtectedDerivativeSnapshot,
  ProtectedDerivativeTarget,
} from '../src/lib/dataset-maintenance-protected-contract.js';
import { maintenanceProjectedReferenceFingerprint } from '../src/lib/dataset-maintenance-plan.js';
import type { DatasetMaintenanceRemoteContext } from '../src/lib/dataset-maintenance-remote.js';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const USER_ID = 'dab05739-1a42-421b-8170-3b77146d1d64';
const OTHER_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERSION = '00.00.001';
const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_UNITGROUP_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_FLOWPROPERTY_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_UNITGROUP_ID = '55555555-5555-4555-8555-555555555555';
const HASH_D = 'd'.repeat(64);

function jsonResponse(value: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function row(options: {
  table: DatasetMaintenanceRemoteRow['table'];
  id: string;
  payload: JsonObject;
}): DatasetMaintenanceRemoteRow {
  return {
    table: options.table,
    id: options.id,
    version: VERSION,
    user_id: USER_ID,
    state_code: 0,
    modified_at: '2026-07-15T00:00:00.000Z',
    json_ordered: options.payload,
    model_id: null,
    rule_verification: false,
  };
}

function completeness(
  rows: DatasetMaintenanceRemoteRow[],
): DatasetMaintenancePlan['snapshot_completeness'] {
  const entityCounts = Object.fromEntries(
    MAINTENANCE_SCAN_TABLES.map((table) => [
      table,
      rows.filter((entry) => entry.table === table).length,
    ]),
  ) as Record<(typeof MAINTENANCE_SCAN_TABLES)[number], number>;
  return {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count_multi_request',
    requested_page_size: 1_000,
    page_count: MAINTENANCE_SCAN_TABLES.length,
    row_count: rows.length,
    entity_counts: entityCounts,
    tables: MAINTENANCE_SCAN_TABLES.map((table) => {
      const count = entityCounts[table];
      return {
        table,
        status: 'complete' as const,
        complete: true as const,
        strategy: 'postgrest_exact_count' as const,
        requested_page_size: 1_000,
        effective_page_size: count === 0 ? 0 : count,
        pages_fetched: 1,
        rows_fetched: count,
        exact_total: count,
        termination_reason: 'content_range_total_reached' as const,
        content_range_verified: true as const,
        ordering_verified: true as const,
        duplicate_count: 0 as const,
      };
    }),
  };
}

type Fixture = ReturnType<typeof fixture>;

function fixture(root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-before-new-'))) {
  mkdirSync(root, { recursive: true });
  const actionRow = row({ table: 'flows', id: FLOW_ID, payload: { value: 'before' } });
  const protectedRow = row({ table: 'sources', id: SOURCE_ID, payload: { source: true } });
  const supportRows = [
    row({ table: 'unitgroups', id: TARGET_UNITGROUP_ID, payload: { support: 'target-ug' } }),
    row({
      table: 'flowproperties',
      id: TARGET_FLOWPROPERTY_ID,
      payload: { support: 'target-fp' },
    }),
    row({ table: 'unitgroups', id: SOURCE_UNITGROUP_ID, payload: { support: 'source-ug' } }),
  ];
  const rows = [actionRow, protectedRow, ...supportRows];
  const desired = { value: 'after' };
  const desiredPath = path.join(root, 'desired-flow.json');
  writeFileSync(desiredPath, JSON.stringify(desired));
  const action = {
    ordinal: 1,
    action_id: 'flow-action',
    action: 'update_json_ordered' as const,
    table: 'flows' as const,
    id: FLOW_ID,
    version: VERSION,
    expected_user_id: USER_ID,
    expected_state_code: 0 as const,
    reason_code: 'BAFU_STEP_2',
    reason: 'test',
    evidence: [],
    status: 'ready' as const,
    before: snapshotRemoteRow(actionRow),
    desired_payload: {
      path: path.basename(desiredPath),
      sha256: sha256Json(desired),
    },
    blockers: [],
    rollback: {
      strategy: 'restore_atomic_alias_before_snapshot' as const,
      before_payload_sha256: sha256Json(actionRow.json_ordered),
      before_payload: actionRow.json_ordered,
      model_id: null,
      rule_verification: false,
    },
  };
  const projected = [{ ...actionRow, json_ordered: desired }, protectedRow, ...supportRows].sort(
    (left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
  const plan = {
    schema_version: 1,
    task_id: 'bafu-private-step-2',
    operation: 'merge-support-aliases',
    operation_id: 'bafu-private-step-2-operation',
    target_mode: 'owner_draft',
    plan_sha256: 'a'.repeat(64),
    account: { user_id: USER_ID, email: 'bafudata@126.com' },
    status: 'ready',
    blockers: [],
    actions: [action],
    protected_rows: [protectedRow, ...supportRows].map((entry) => ({
      ...snapshotRemoteRow(entry),
      reason: 'non_action_visible_row' as const,
    })),
    alias_batches: [
      {
        batch_id: 'time',
        target_snapshots: {
          unitgroup: snapshotRemoteRow(supportRows[0]!),
          flowproperty: snapshotRemoteRow(supportRows[1]!),
          source_unitgroup: snapshotRemoteRow(supportRows[2]!),
        },
      },
    ],
    snapshot_completeness: completeness(rows),
    visible_snapshot_sha256: sha256Json(
      rows
        .map(snapshotRemoteRow)
        .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right))),
    ),
    projected_reference_sha256: sha256Json(maintenanceProjectedReferenceFingerprint(projected)),
  } as unknown as DatasetMaintenancePlan;
  return { root, plan, rows, desired, desiredPath, supportRows };
}

function rebaseline(plan: DatasetMaintenancePlan, rows: DatasetMaintenanceRemoteRow[]): void {
  plan.snapshot_completeness = completeness(rows);
  plan.visible_snapshot_sha256 = sha256Json(
    rows
      .map(snapshotRemoteRow)
      .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right))),
  );
}

function context(
  fetchImpl: FetchLike = async () => {
    throw new Error('Unexpected context fetch');
  },
): DatasetMaintenanceRemoteContext {
  return {
    project_ref: 'qgzvkongdjqiiamzbbts',
    rest_base_url: 'https://qgzvkongdjqiiamzbbts.supabase.co/rest/v1',
    publishable_key: 'publishable',
    access_token: 'access',
    account: { user_id: USER_ID, email: 'bafudata@126.com', session_source: 'test' },
    fetch_impl: fetchImpl,
    timeout_ms: 1_000,
  };
}

function assertCliCode(block: () => unknown, code: string): void {
  assert.throws(block, (error: unknown) => error instanceof CliError && error.code === code);
}

async function assertCliCodeAsync(block: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(block, (error: unknown) => error instanceof CliError && error.code === code);
}

function targetId(table: 'flows' | 'processes', ordinal: number): string {
  const prefix = table === 'flows' ? '10000000' : '20000000';
  return `${prefix}-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}

function derivativeTargets(): ProtectedDerivativeTarget[] {
  const targets = [
    ...Array.from({ length: 23 }, (_, index) => ({ table: 'flows' as const, ordinal: index + 1 })),
    ...Array.from({ length: 27 }, (_, index) => ({
      table: 'processes' as const,
      ordinal: index + 1,
    })),
  ].map(({ table, ordinal }) => {
    const id = targetId(table, ordinal);
    return {
      table,
      id,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: sha256Json({ table, id, version: VERSION }),
    };
  });
  return targets.reverse();
}

function derivativeKey(target: { table: string; id: string; version: string }): string {
  return `${target.table}\u0000${target.id}\u0000${target.version}`;
}

function bindDerivativeCensus(value: Fixture, targets: ProtectedDerivativeTarget[]) {
  const plan = structuredClone(value.plan);
  const targetRows = targets.map((target) =>
    row({ table: target.table, id: target.id, payload: { target: derivativeKey(target) } }),
  );
  const rows = [...structuredClone(value.rows), ...targetRows];
  plan.protected_rows.push(
    ...targetRows.map((entry) => ({
      ...snapshotRemoteRow(entry),
      reason: 'non_action_visible_row' as const,
    })),
  );
  rebaseline(plan, rows);
  plan.projected_reference_sha256 = sha256Json(
    maintenanceProjectedReferenceFingerprint(
      projectedRows({ plan, planDir: value.root, currentRows: rows }),
    ),
  );
  return { plan, rows, targetRows };
}

function rawDerivativeSnapshot(
  target: ProtectedDerivativeSnapshotTarget,
  overrides: JsonObject = {},
): JsonObject {
  const jsonHash = sha256Json({ target: derivativeKey(target), kind: 'json' });
  return {
    ok: true,
    command: 'cmd_dataset_derivative_rebuild_snapshot',
    schema_version: 'dataset-derivative-snapshot.v1',
    table: target.table,
    id: target.id,
    version: target.version,
    user_id: target.user_id,
    state_code: 0,
    modified_at: '2026-07-15T00:00:00.000Z',
    json_sha256: jsonHash,
    json_ordered_sha256: jsonHash,
    extracted_md_sha256: null,
    embedding_ft_sha256: null,
    embedding_ft_at: null,
    snapshot_sha256: target.baseline_snapshot_sha256 ?? sha256Json(target),
    ...overrides,
  };
}

function injectedReads(options: {
  fixture: Fixture;
  derivativeFetch?: ProtectedBeforeReadDependencyOverrides['fetchDerivativeSnapshot'];
}): ProtectedBeforeReadDependencyOverrides {
  return {
    fetchExactRows: async ({ table, id, version }) => ({
      rows: options.fixture.supportRows.filter(
        (entry) => entry.table === table && entry.id === id && entry.version === version,
      ),
      source_url: 'injected:exact-row',
    }),
    fetchDerivativeSnapshot:
      options.derivativeFetch ??
      (async ({ table, id, version }) => {
        const target = derivativeTargets().find(
          (entry) => entry.table === table && entry.id === id && entry.version === version,
        )!;
        return rawDerivativeSnapshot(target);
      }),
  };
}

test('strict protected before-state validation projects desired rows and rejects every drift class', () => {
  const value = fixture();
  try {
    const projected = assertStrictBeforeState({
      plan: value.plan,
      planDir: value.root,
      actorUserId: USER_ID,
      currentRows: value.rows,
      completeness: value.plan.snapshot_completeness,
    });
    assert.deepEqual(projected.find((entry) => entry.id === FLOW_ID)?.json_ordered, value.desired);
    assert.deepEqual(
      projectedRows({
        plan: value.plan,
        planDir: value.root,
        currentRows: value.rows.filter((entry) => entry.id !== FLOW_ID),
      }).map((entry) => entry.id),
      value.rows
        .filter((entry) => entry.id !== FLOW_ID)
        .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)))
        .map((entry) => entry.id),
    );

    const run = (
      mutate: (plan: DatasetMaintenancePlan, rows: DatasetMaintenanceRemoteRow[]) => void,
      code: string,
      actorUserId = USER_ID,
    ) => {
      const plan = structuredClone(value.plan);
      const rows = structuredClone(value.rows);
      mutate(plan, rows);
      assertCliCode(
        () =>
          assertStrictBeforeState({
            plan,
            planDir: value.root,
            actorUserId,
            currentRows: rows,
            completeness: plan.snapshot_completeness,
          }),
        code,
      );
    };

    run(() => undefined, 'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH', '');
    run((plan) => {
      plan.account.user_id = OTHER_USER_ID;
    }, 'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH');
    run((plan) => {
      plan.actions[0]!.expected_user_id = OTHER_USER_ID;
    }, 'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH');
    run((plan) => {
      plan.snapshot_completeness = undefined;
    }, 'DATASET_MAINTENANCE_PROTECTED_SNAPSHOT_INCOMPLETE');
    const incompatiblePlan = structuredClone(value.plan);
    const incompatible = structuredClone(value.plan.snapshot_completeness!);
    incompatible.entity_counts.flows += 1;
    assertCliCode(
      () =>
        assertStrictBeforeState({
          plan: incompatiblePlan,
          planDir: value.root,
          actorUserId: USER_ID,
          currentRows: structuredClone(value.rows),
          completeness: incompatible,
        }),
      'DATASET_MAINTENANCE_PROTECTED_SNAPSHOT_INCOMPLETE',
    );
    run((plan) => {
      plan.visible_snapshot_sha256 = HASH_D;
    }, 'DATASET_MAINTENANCE_PROTECTED_VISIBLE_SNAPSHOT_DRIFT');
    run((plan, rows) => {
      rows.pop();
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ACCOUNT_CENSUS_DRIFT');
    run((plan, rows) => {
      rows[4] = structuredClone(rows[3]!);
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ACCOUNT_CENSUS_DRIFT');
    run((plan, rows) => {
      rows[4] = row({
        table: 'processes',
        id: '66666666-6666-4666-8666-666666666666',
        payload: { unexpected: true },
      });
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ACCOUNT_CENSUS_DRIFT');
    run((plan, rows) => {
      rows[1]!.user_id = OTHER_USER_ID;
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ACCOUNT_CENSUS_DRIFT');
    run((plan, rows) => {
      rows[1]!.json_ordered = { drift: true };
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ROW_DRIFT');
    run((plan) => {
      plan.actions[0]!.before = null;
    }, 'DATASET_MAINTENANCE_PROTECTED_ACTION_DRIFT');
    run((plan, rows) => {
      rows[0]!.state_code = 20;
      rebaseline(plan, rows);
    }, 'DATASET_MAINTENANCE_PROTECTED_ACTION_DRIFT');
    run((plan) => {
      plan.projected_reference_sha256 = HASH_D;
    }, 'DATASET_MAINTENANCE_PROTECTED_REFERENCE_DRIFT');

    writeFileSync(value.desiredPath, JSON.stringify({ tampered: true }));
    assertCliCode(
      () => projectedRows({ plan: value.plan, planDir: value.root, currentRows: value.rows }),
      'DATASET_MAINTENANCE_DESIRED_PAYLOAD_HASH_MISMATCH',
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('support snapshot validation uses exact read-only rows and rejects absence, owner, state, and hash drift', async () => {
  const value = fixture();
  try {
    const calls: string[] = [];
    const passed = await assertSupportSnapshots({
      plan: value.plan,
      actorUserId: USER_ID,
      context: context(),
      dependencies: {
        fetchExactRows: async (options) => {
          calls.push(`${options.table}:${options.id}:${options.version}`);
          return injectedReads({ fixture: value }).fetchExactRows!(options);
        },
      },
    });
    assert.equal(passed.length, 3);
    assert.deepEqual(
      calls.map((entry) => entry.split(':')[0]),
      ['unitgroups', 'flowproperties', 'unitgroups'],
    );

    const noBatches = structuredClone(value.plan);
    noBatches.alias_batches = undefined;
    assert.deepEqual(
      await assertSupportSnapshots({
        plan: noBatches,
        actorUserId: USER_ID,
        context: context(),
        dependencies: injectedReads({ fixture: value }),
      }),
      [],
    );

    const missingSnapshot = structuredClone(value.plan);
    missingSnapshot.alias_batches![0]!.target_snapshots.unitgroup = null;
    await assertCliCodeAsync(
      () =>
        assertSupportSnapshots({
          plan: missingSnapshot,
          actorUserId: USER_ID,
          context: context(),
          dependencies: injectedReads({ fixture: value }),
        }),
      'DATASET_MAINTENANCE_PROTECTED_SUPPORT_DRIFT',
    );
    await assertCliCodeAsync(
      () =>
        assertSupportSnapshots({
          plan: value.plan,
          actorUserId: USER_ID,
          context: { ...context(), account: { ...context().account, user_id: OTHER_USER_ID } },
          dependencies: injectedReads({ fixture: value }),
        }),
      'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH',
    );

    for (const mutate of [
      () => null,
      (entry: DatasetMaintenanceRemoteRow) => ({ ...entry, user_id: OTHER_USER_ID }),
      (entry: DatasetMaintenanceRemoteRow) => ({ ...entry, state_code: 100 }),
      (entry: DatasetMaintenanceRemoteRow) => ({ ...entry, json_ordered: { drift: true } }),
    ]) {
      await assertCliCodeAsync(
        () =>
          assertSupportSnapshots({
            plan: value.plan,
            actorUserId: USER_ID,
            context: context(),
            dependencies: {
              fetchExactRows: async (options) => {
                const found = value.supportRows.find(
                  (entry) =>
                    entry.table === options.table &&
                    entry.id === options.id &&
                    entry.version === options.version,
                )!;
                const changed = mutate(structuredClone(found));
                return { rows: changed ? [changed] : [], source_url: 'injected:drift' };
              },
            },
          }),
        'DATASET_MAINTENANCE_PROTECTED_SUPPORT_DRIFT',
      );
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('derivative capture sorts targets, limits read concurrency to five, and compares baselines', async () => {
  const targets = derivativeTargets();
  const expectedOrder = [...targets].sort((left, right) =>
    derivativeKey(left).localeCompare(derivativeKey(right)),
  );
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const reads: ProtectedBeforeReadDependencyOverrides = {
    fetchDerivativeSnapshot: async ({ table, id, version }) => {
      const target = targets.find(
        (entry) => entry.table === table && entry.id === id && entry.version === version,
      )!;
      started.push(derivativeKey(target));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, Number(id.at(-1)) % 3));
      active -= 1;
      return rawDerivativeSnapshot(target);
    },
  };
  const captured = await captureDerivativeSnapshots({
    actorUserId: USER_ID,
    context: context(),
    derivativeTargets: targets,
    dependencies: reads,
  });
  assert.equal(maximumActive, 5);
  assert.deepEqual(started, expectedOrder.map(derivativeKey));
  assert.deepEqual(captured.map(derivativeKey), expectedOrder.map(derivativeKey));
  assert.deepEqual(
    (
      await assertDerivativeBaselines({
        actorUserId: USER_ID,
        context: context(),
        derivativeTargets: targets,
        dependencies: reads,
      })
    ).map(derivativeKey),
    expectedOrder.map(derivativeKey),
  );

  const drifted = structuredClone(targets);
  drifted[0]!.baseline_snapshot_sha256 = HASH_D;
  await assertCliCodeAsync(
    () =>
      assertDerivativeBaselines({
        actorUserId: USER_ID,
        context: context(),
        derivativeTargets: drifted,
        dependencies: reads,
      }),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_BASELINE_DRIFT',
  );
});

test('derivative snapshots are cross-bound to the immediately preceding census', async () => {
  const targets = derivativeTargets();
  const targetRows = targets.map((target) =>
    row({ table: target.table, id: target.id, payload: { target: derivativeKey(target) } }),
  );
  const snapshots = await captureDerivativeSnapshots({
    actorUserId: USER_ID,
    context: context(),
    derivativeTargets: targets,
    dependencies: {
      fetchDerivativeSnapshot: async ({ table, id, version }) => {
        const target = targets.find(
          (entry) => entry.table === table && entry.id === id && entry.version === version,
        )!;
        return rawDerivativeSnapshot(target);
      },
    },
  });
  assert.doesNotThrow(() =>
    assertDerivativeCensusBindings({
      actorUserId: USER_ID,
      currentRows: targetRows,
      derivativeSnapshots: snapshots,
    }),
  );
  const drifted = structuredClone(targetRows);
  drifted[0]!.modified_at = '2026-07-15T00:00:01.000Z';
  assertCliCode(
    () =>
      assertDerivativeCensusBindings({
        actorUserId: USER_ID,
        currentRows: drifted,
        derivativeSnapshots: snapshots,
      }),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_CENSUS_DRIFT',
  );
  assertCliCode(
    () =>
      assertDerivativeCensusBindings({
        actorUserId: USER_ID,
        currentRows: targetRows.slice(1),
        derivativeSnapshots: snapshots,
      }),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_CENSUS_DRIFT',
  );
});

test('derivative validation rejects malformed closures and stops before later read chunks', async () => {
  const targets = derivativeTargets();
  let calls = 0;
  const attempt = (candidate: ProtectedDerivativeSnapshotTarget[], actorUserId = USER_ID) =>
    captureDerivativeSnapshots({
      actorUserId,
      context: context(),
      derivativeTargets: candidate,
      dependencies: {
        fetchDerivativeSnapshot: async (options) => {
          calls += 1;
          const target = targets.find(
            (entry) => entry.table === options.table && entry.id === options.id,
          )!;
          return rawDerivativeSnapshot(target);
        },
      },
    });

  await assertCliCodeAsync(
    () => attempt(targets.slice(1)),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
  );
  const duplicate = structuredClone(targets);
  duplicate[0] = structuredClone(duplicate[1]!);
  await assertCliCodeAsync(
    () => attempt(duplicate),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
  );
  const wrongSplit = structuredClone(targets);
  wrongSplit.find((target) => target.table === 'flows')!.table = 'processes';
  await assertCliCodeAsync(
    () => attempt(wrongSplit as ProtectedDerivativeSnapshotTarget[]),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
  );
  const unknownTable = structuredClone(targets);
  (unknownTable.find((target) => target.table === 'processes') as { table: string }).table =
    'contacts';
  await assertCliCodeAsync(
    () => attempt(unknownTable as ProtectedDerivativeSnapshotTarget[]),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
  );
  for (const mutate of [
    (target: ProtectedDerivativeSnapshotTarget) => {
      target.id = '';
    },
    (target: ProtectedDerivativeSnapshotTarget) => {
      target.version = '';
    },
    (target: ProtectedDerivativeSnapshotTarget) => {
      target.user_id = OTHER_USER_ID;
    },
    (target: ProtectedDerivativeSnapshotTarget) => {
      (target as { state_code: number }).state_code = 100;
    },
  ]) {
    const invalid = structuredClone(targets);
    mutate(invalid[0]!);
    await assertCliCodeAsync(
      () => attempt(invalid),
      'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
    );
  }
  assert.equal(calls, 0);

  await assertCliCodeAsync(
    () =>
      captureDerivativeSnapshots({
        actorUserId: USER_ID,
        context: { ...context(), account: { ...context().account, user_id: OTHER_USER_ID } },
        derivativeTargets: targets,
        dependencies: {},
      }),
    'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH',
  );

  let failedCalls = 0;
  await assert.rejects(() =>
    captureDerivativeSnapshots({
      actorUserId: USER_ID,
      context: context(),
      derivativeTargets: targets,
      dependencies: {
        fetchDerivativeSnapshot: async () => {
          failedCalls += 1;
          throw new Error('read failed');
        },
      },
    }),
  );
  assert.equal(failedCalls, 5);

  await assert.rejects(() =>
    captureDerivativeSnapshots({
      actorUserId: USER_ID,
      context: context(),
      derivativeTargets: targets,
      dependencies: {
        fetchDerivativeSnapshot: async ({ table, id, version }) => {
          const target = targets.find(
            (entry) => entry.table === table && entry.id === id && entry.version === version,
          )!;
          return rawDerivativeSnapshot(target, { id: OTHER_USER_ID });
        },
      },
    }),
  );

  await assertCliCodeAsync(
    () =>
      assertDerivativeBaselines({
        actorUserId: USER_ID,
        context: context(),
        derivativeTargets: targets,
        dependencies: {
          fetchDerivativeSnapshot: async ({ table, id, version }) => {
            const target = targets.find(
              (entry) => entry.table === table && entry.id === id && entry.version === version,
            )!;
            return rawDerivativeSnapshot(target);
          },
          parseDerivativeSnapshot: (_value, expected) =>
            ({
              ...rawDerivativeSnapshot({
                table: expected.table,
                id: OTHER_USER_ID,
                version: expected.version,
                user_id: expected.userId,
                state_code: 0,
              }),
              table: expected.table,
              id: OTHER_USER_ID,
              version: expected.version,
              user_id: expected.userId,
              state_code: 0,
              schema_version: 'dataset-derivative-snapshot.v1',
              modified_at: '2026-07-15T00:00:00.000Z',
              snapshot_sha256: HASH_D,
            }) as ProtectedDerivativeSnapshot,
        },
      }),
    'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_BASELINE_DRIFT',
  );
});

test('combined preparation uses only exact GET and derivative snapshot RPC reads in capture and compare modes', async () => {
  const value = fixture();
  try {
    const targets = derivativeTargets();
    const bound = bindDerivativeCensus(value, targets);
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(input);
      calls.push({ path: url.pathname, method: init?.method ?? 'GET' });
      if (url.pathname.endsWith('/rpc/cmd_dataset_derivative_rebuild_snapshot')) {
        const body = JSON.parse(String(init?.body)) as {
          p_table: 'flows' | 'processes';
          p_id: string;
          p_version: string;
        };
        const target = targets.find(
          (entry) =>
            entry.table === body.p_table &&
            entry.id === body.p_id &&
            entry.version === body.p_version,
        )!;
        return jsonResponse(rawDerivativeSnapshot(target));
      }
      const table = url.pathname.split('/').at(-1);
      const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
      const version = url.searchParams.get('version')?.replace(/^eq\./u, '');
      const found = value.supportRows.find(
        (entry) => entry.table === table && entry.id === id && entry.version === version,
      );
      return jsonResponse(found ? [found] : []);
    };

    const captured = await validateProtectedBeforeState({
      plan: bound.plan,
      planDir: value.root,
      actorUserId: USER_ID,
      currentRows: bound.rows,
      completeness: bound.plan.snapshot_completeness,
      context: context(fetchImpl),
      derivativeMode: 'capture',
      derivativeTargets: targets,
    });
    assert.equal(captured.derivative_mode, 'capture');
    assert.equal(captured.projected_rows.length, bound.rows.length);
    assert.equal(captured.support_snapshots.length, 3);
    assert.equal(captured.derivative_snapshots.length, 50);
    assert.equal(calls.filter((entry) => entry.method === 'GET').length, 3);
    assert.equal(calls.filter((entry) => entry.method === 'POST').length, 50);
    assert.ok(
      calls.every(
        (entry) =>
          entry.method === 'GET' ||
          entry.path.endsWith('/rpc/cmd_dataset_derivative_rebuild_snapshot'),
      ),
    );

    const injectedCalls = { support: 0, derivative: 0 };
    const dependencies = injectedReads({
      fixture: value,
      derivativeFetch: async ({ table, id, version }) => {
        injectedCalls.derivative += 1;
        const target = targets.find(
          (entry) => entry.table === table && entry.id === id && entry.version === version,
        )!;
        return rawDerivativeSnapshot(target);
      },
    });
    const exact = dependencies.fetchExactRows!;
    dependencies.fetchExactRows = async (options) => {
      injectedCalls.support += 1;
      return exact(options);
    };
    const compared = await validateProtectedBeforeState({
      plan: bound.plan,
      planDir: value.root,
      actorUserId: USER_ID,
      currentRows: bound.rows,
      completeness: bound.plan.snapshot_completeness,
      context: context(),
      derivativeMode: 'compare',
      derivativeTargets: targets,
      dependencies,
    });
    assert.equal(compared.derivative_mode, 'compare');
    assert.deepEqual(injectedCalls, { support: 3, derivative: 50 });
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
