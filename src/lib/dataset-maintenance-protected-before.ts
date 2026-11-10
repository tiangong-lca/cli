import { loadMaintenanceDesiredPayload } from './dataset-maintenance-alias-request.js';
import {
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
} from './maintenance/contract/types.js';
import { maintenanceRowKey, snapshotRemoteRow } from './maintenance/contract/values.js';
import { sha256Json } from './canonical-json-hash.js';
import {
  PROTECTED_EXECUTION_COUNTS,
  parseProtectedDerivativeSnapshot,
  type ProtectedDerivativeSnapshot,
  type ProtectedDerivativeTarget,
} from './dataset-maintenance-protected-contract.js';
import { maintenanceProjectedReferenceFingerprint } from './dataset-maintenance-plan.js';
import { isSnapshotCompletenessCompatible } from './dataset-maintenance-pagination.js';
import {
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceExactRows,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { CliError } from '../shared/errors.js';

const DERIVATIVE_READ_CONCURRENCY = 5;

export type ProtectedDerivativeSnapshotTarget = Omit<
  ProtectedDerivativeTarget,
  'baseline_snapshot_sha256'
> & {
  baseline_snapshot_sha256?: string;
};

export type ProtectedBeforeReadDependencies = {
  fetchExactRows: typeof fetchMaintenanceExactRows;
  fetchDerivativeSnapshot: typeof fetchMaintenanceDerivativeSnapshot;
  parseDerivativeSnapshot: typeof parseProtectedDerivativeSnapshot;
};

export type ProtectedBeforeReadDependencyOverrides = Partial<ProtectedBeforeReadDependencies>;

export type ProtectedBeforeValidationResult = {
  projected_rows: DatasetMaintenanceRemoteRow[];
  support_snapshots: DatasetMaintenanceRowSnapshot[];
  derivative_snapshots: ProtectedDerivativeSnapshot[];
  derivative_mode: 'capture' | 'compare';
};

type ProtectedBeforeBaseOptions = {
  plan: DatasetMaintenancePlan;
  planDir: string;
  actorUserId: string;
  currentRows: DatasetMaintenanceRemoteRow[];
  completeness: unknown;
  context: DatasetMaintenanceRemoteContext;
  dependencies?: ProtectedBeforeReadDependencyOverrides;
};

export type ValidateProtectedBeforeStateOptions = ProtectedBeforeBaseOptions &
  (
    | {
        derivativeMode: 'capture';
        derivativeTargets: ProtectedDerivativeSnapshotTarget[];
      }
    | {
        derivativeMode: 'compare';
        derivativeTargets: ProtectedDerivativeTarget[];
      }
  );

function readDependencies(
  overrides: ProtectedBeforeReadDependencyOverrides = {},
): ProtectedBeforeReadDependencies {
  return {
    fetchExactRows: overrides.fetchExactRows ?? fetchMaintenanceExactRows,
    fetchDerivativeSnapshot:
      overrides.fetchDerivativeSnapshot ?? fetchMaintenanceDerivativeSnapshot,
    parseDerivativeSnapshot: overrides.parseDerivativeSnapshot ?? parseProtectedDerivativeSnapshot,
  };
}

function actorMismatch(message: string): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_PROTECTED_ACTOR_MISMATCH',
    exitCode: 1,
  });
}

function assertPlanActor(plan: DatasetMaintenancePlan, actorUserId: string): void {
  if (
    !actorUserId.trim() ||
    plan.account.user_id !== actorUserId ||
    plan.actions.some((action) => action.expected_user_id !== actorUserId)
  ) {
    actorMismatch('Protected preparation plan and actions must belong to the exact actor.');
  }
}

function assertReadContextActor(
  context: DatasetMaintenanceRemoteContext,
  actorUserId: string,
): void {
  if (context.account.user_id !== actorUserId) {
    actorMismatch('Authenticated read context does not match the protected preparation actor.');
  }
}

export function projectedRows(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  currentRows: DatasetMaintenanceRemoteRow[];
}): DatasetMaintenanceRemoteRow[] {
  const projected = new Map(options.currentRows.map((row) => [maintenanceRowKey(row), { ...row }]));
  for (const action of options.plan.actions) {
    const key = maintenanceRowKey(action);
    const row = projected.get(key);
    if (row) {
      projected.set(key, {
        ...row,
        json_ordered: loadMaintenanceDesiredPayload(options.planDir, action),
      });
    }
  }
  return [...projected.values()].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
}

export function assertStrictBeforeState(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  actorUserId: string;
  currentRows: DatasetMaintenanceRemoteRow[];
  completeness: unknown;
}): DatasetMaintenanceRemoteRow[] {
  const { plan } = options;
  assertPlanActor(plan, options.actorUserId);
  if (
    !plan.snapshot_completeness ||
    !isSnapshotCompletenessCompatible(
      options.completeness,
      plan.snapshot_completeness,
      MAINTENANCE_SCAN_TABLES,
    )
  ) {
    throw new CliError('Production RLS census does not match the frozen complete snapshot.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_SNAPSHOT_INCOMPLETE',
      exitCode: 1,
    });
  }

  const snapshots = options.currentRows
    .map(snapshotRemoteRow)
    .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)));
  if (sha256Json(snapshots) !== plan.visible_snapshot_sha256) {
    throw new CliError('Production RLS visible snapshot drifted after the freeze.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_VISIBLE_SNAPSHOT_DRIFT',
      exitCode: 1,
    });
  }

  const expectedKeys = new Set([
    ...plan.actions.map(maintenanceRowKey),
    ...plan.protected_rows.map(maintenanceRowKey),
  ]);
  const currentKeys = options.currentRows.map(maintenanceRowKey);
  if (
    expectedKeys.size !== options.currentRows.length ||
    new Set(currentKeys).size !== options.currentRows.length ||
    options.currentRows.some(
      (row) => row.user_id !== options.actorUserId || !expectedKeys.has(maintenanceRowKey(row)),
    )
  ) {
    throw new CliError('Production owner account contains missing or unexpected rows.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_ACCOUNT_CENSUS_DRIFT',
      exitCode: 1,
    });
  }

  const current = new Map(options.currentRows.map((row) => [maintenanceRowKey(row), row]));
  for (const row of plan.protected_rows) {
    const observed = current.get(maintenanceRowKey(row))!;
    if (snapshotRemoteRow(observed).row_sha256 !== row.row_sha256) {
      throw new CliError(`Protected row drifted: ${row.id}`, {
        code: 'DATASET_MAINTENANCE_PROTECTED_ROW_DRIFT',
        exitCode: 1,
        details: row,
      });
    }
  }

  for (const action of plan.actions) {
    const observed = current.get(maintenanceRowKey(action))!;
    if (
      !action.before ||
      observed.user_id !== options.actorUserId ||
      observed.user_id !== action.expected_user_id ||
      observed.state_code !== 0 ||
      snapshotRemoteRow(observed).row_sha256 !== action.before.row_sha256
    ) {
      throw new CliError(
        `Action row is no longer in the exact frozen before state: ${action.action_id}`,
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_ACTION_DRIFT',
          exitCode: 1,
        },
      );
    }
  }

  const finalRows = projectedRows({
    plan,
    planDir: options.planDir,
    currentRows: options.currentRows,
  });
  if (
    sha256Json(maintenanceProjectedReferenceFingerprint(finalRows)) !==
    plan.projected_reference_sha256
  ) {
    throw new CliError('Projected reference closure drifted before protected execution.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_REFERENCE_DRIFT',
      exitCode: 1,
    });
  }
  return finalRows;
}

export async function assertSupportSnapshots(options: {
  plan: DatasetMaintenancePlan;
  actorUserId: string;
  context: DatasetMaintenanceRemoteContext;
  dependencies?: ProtectedBeforeReadDependencyOverrides;
}): Promise<DatasetMaintenanceRowSnapshot[]> {
  assertPlanActor(options.plan, options.actorUserId);
  assertReadContextActor(options.context, options.actorUserId);
  const dependencies = readDependencies(options.dependencies);
  const verified: DatasetMaintenanceRowSnapshot[] = [];
  for (const batch of options.plan.alias_batches ?? []) {
    for (const snapshot of [
      batch.target_snapshots.unitgroup,
      batch.target_snapshots.flowproperty,
      batch.target_snapshots.source_unitgroup,
    ]) {
      if (!snapshot) {
        throw new CliError(`Alias support snapshot is absent for ${batch.batch_id}.`, {
          code: 'DATASET_MAINTENANCE_PROTECTED_SUPPORT_DRIFT',
          exitCode: 1,
        });
      }
      const exact = await dependencies.fetchExactRows({
        context: options.context,
        table: snapshot.table,
        id: snapshot.id,
        version: snapshot.version,
      });
      const row = exact.rows.length === 1 ? exact.rows[0] : null;
      if (
        !row ||
        row.user_id !== options.actorUserId ||
        row.state_code !== 0 ||
        snapshotRemoteRow(row).row_sha256 !== snapshot.row_sha256
      ) {
        throw new CliError(`Alias support row drifted for ${batch.batch_id}.`, {
          code: 'DATASET_MAINTENANCE_PROTECTED_SUPPORT_DRIFT',
          exitCode: 1,
          details: { table: snapshot.table, id: snapshot.id, version: snapshot.version },
        });
      }
      verified.push(snapshotRemoteRow(row));
    }
  }
  return verified;
}

function derivativeTargetKey(target: ProtectedDerivativeSnapshotTarget): string {
  return `${target.table}\u0000${target.id}\u0000${target.version}`;
}

function stableDerivativeTargets(
  targets: ProtectedDerivativeSnapshotTarget[],
  actorUserId: string,
): ProtectedDerivativeSnapshotTarget[] {
  const keys = targets.map(derivativeTargetKey);
  if (
    targets.length !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    new Set(keys).size !== targets.length ||
    targets.filter((target) => target.table === 'flows').length !==
      PROTECTED_EXECUTION_COUNTS.flow_count ||
    targets.filter((target) => target.table === 'processes').length !==
      PROTECTED_EXECUTION_COUNTS.process_count ||
    targets.some(
      (target) =>
        !target.id.trim() ||
        !target.version.trim() ||
        target.user_id !== actorUserId ||
        target.state_code !== 0,
    )
  ) {
    throw new CliError('Protected derivative targets are incomplete, duplicate, or foreign.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_TARGET_INVALID',
      exitCode: 1,
    });
  }
  return [...targets].sort((left, right) =>
    derivativeTargetKey(left).localeCompare(derivativeTargetKey(right)),
  );
}

export async function captureDerivativeSnapshots(options: {
  actorUserId: string;
  context: DatasetMaintenanceRemoteContext;
  derivativeTargets: ProtectedDerivativeSnapshotTarget[];
  dependencies?: ProtectedBeforeReadDependencyOverrides;
}): Promise<ProtectedDerivativeSnapshot[]> {
  assertReadContextActor(options.context, options.actorUserId);
  const targets = stableDerivativeTargets(options.derivativeTargets, options.actorUserId);
  const dependencies = readDependencies(options.dependencies);
  const verified: ProtectedDerivativeSnapshot[] = [];
  for (let offset = 0; offset < targets.length; offset += DERIVATIVE_READ_CONCURRENCY) {
    const chunk = targets.slice(offset, offset + DERIVATIVE_READ_CONCURRENCY);
    const snapshots = await Promise.all(
      chunk.map(async (target) =>
        dependencies.parseDerivativeSnapshot(
          await dependencies.fetchDerivativeSnapshot({
            context: options.context,
            table: target.table,
            id: target.id,
            version: target.version,
          }),
          {
            table: target.table,
            id: target.id,
            version: target.version,
            userId: target.user_id,
          },
        ),
      ),
    );
    verified.push(...snapshots);
  }
  return verified;
}

export async function assertDerivativeBaselines(options: {
  actorUserId: string;
  context: DatasetMaintenanceRemoteContext;
  derivativeTargets: ProtectedDerivativeTarget[];
  dependencies?: ProtectedBeforeReadDependencyOverrides;
}): Promise<ProtectedDerivativeSnapshot[]> {
  const snapshots = await captureDerivativeSnapshots({
    actorUserId: options.actorUserId,
    context: options.context,
    derivativeTargets: options.derivativeTargets,
    dependencies: options.dependencies,
  });
  const expectedByKey = new Map(
    options.derivativeTargets.map((target) => [derivativeTargetKey(target), target]),
  );
  for (const snapshot of snapshots) {
    const target = expectedByKey.get(derivativeTargetKey(snapshot));
    if (!target || snapshot.snapshot_sha256 !== target.baseline_snapshot_sha256) {
      throw new CliError('A protected derivative baseline drifted before preflight.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_BASELINE_DRIFT',
        exitCode: 1,
        details: { table: snapshot.table, id: snapshot.id, version: snapshot.version },
      });
    }
  }
  return snapshots;
}

export function assertDerivativeCensusBindings(options: {
  actorUserId: string;
  currentRows: DatasetMaintenanceRemoteRow[];
  derivativeSnapshots: ProtectedDerivativeSnapshot[];
}): void {
  const current = new Map(
    options.currentRows
      .filter((row) => row.table === 'flows' || row.table === 'processes')
      .map((row) => [maintenanceRowKey(row), row]),
  );
  for (const snapshot of options.derivativeSnapshots) {
    const row = current.get(maintenanceRowKey(snapshot));
    if (
      !row ||
      row.user_id !== options.actorUserId ||
      row.state_code !== 0 ||
      row.modified_at !== snapshot.modified_at
    ) {
      throw new CliError(
        'A protected derivative snapshot does not match the immediately preceding account census.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_DERIVATIVE_CENSUS_DRIFT',
          exitCode: 1,
          details: {
            table: snapshot.table,
            id: snapshot.id,
            version: snapshot.version,
            census_modified_at: row?.modified_at ?? null,
            derivative_modified_at: snapshot.modified_at,
          },
        },
      );
    }
  }
}

export async function validateProtectedBeforeState(
  options: ValidateProtectedBeforeStateOptions,
): Promise<ProtectedBeforeValidationResult> {
  const projected = assertStrictBeforeState({
    plan: options.plan,
    planDir: options.planDir,
    actorUserId: options.actorUserId,
    currentRows: options.currentRows,
    completeness: options.completeness,
  });
  const support = await assertSupportSnapshots({
    plan: options.plan,
    actorUserId: options.actorUserId,
    context: options.context,
    dependencies: options.dependencies,
  });
  const derivatives =
    options.derivativeMode === 'capture'
      ? await captureDerivativeSnapshots({
          actorUserId: options.actorUserId,
          context: options.context,
          derivativeTargets: options.derivativeTargets,
          dependencies: options.dependencies,
        })
      : await assertDerivativeBaselines({
          actorUserId: options.actorUserId,
          context: options.context,
          derivativeTargets: options.derivativeTargets,
          dependencies: options.dependencies,
        });
  assertDerivativeCensusBindings({
    actorUserId: options.actorUserId,
    currentRows: options.currentRows,
    derivativeSnapshots: derivatives,
  });
  return {
    projected_rows: projected,
    support_snapshots: support,
    derivative_snapshots: derivatives,
    derivative_mode: options.derivativeMode,
  };
}
