import path from 'node:path';
import { collectRemoteReferences } from './dataset-remote-verify.js';
import {
  buildAliasRewritePlan,
  type DatasetMaintenanceAliasSchemas,
} from './dataset-maintenance-alias-rewrite.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  computePlanSha256,
  isJsonObject,
  maintenanceRowKey,
  parseMaintenanceScope,
  readJsonFile,
  safeActionFileName,
  sha256Json,
  snapshotRemoteRow,
  writeImmutableJson,
  writeImmutableJsonLines,
  type DatasetMaintenanceBlocker,
  type DatasetMaintenanceAliasBatchPlan,
  type DatasetMaintenanceOperation,
  type DatasetMaintenancePlan,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceProtectedRow,
  type DatasetMaintenanceReferenceImpact,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type DatasetMaintenanceScopeAction,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import { parseDerivativeSnapshotResponse } from './dataset-maintenance-derivatives.js';
import {
  inspectMaintenanceSupportPayload,
  maintenancePayloadIdentity,
  type DatasetMaintenanceSupportSchemas,
} from './dataset-maintenance-support-validation.js';
import {
  collectMaintenanceDraftNameIssues,
  fetchMaintenanceAccountRows,
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceExactRows,
  normalizeMaintenancePageSize,
  resolveMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';

export type RunDatasetMaintenancePlanOptions = {
  scopePath: string;
  operation: DatasetMaintenanceOperation;
  outDir: string;
  pageSize?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  supportSchemas?: DatasetMaintenanceSupportSchemas;
  aliasSchemas?: DatasetMaintenanceAliasSchemas;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function blocker(
  action: DatasetMaintenanceScopeAction,
  code: string,
  message: string,
  details?: unknown,
): DatasetMaintenanceBlocker {
  return {
    code,
    message,
    action_id: action.action_id,
    table: action.table,
    id: action.id,
    version: action.version,
    ...(details === undefined ? {} : { details }),
  };
}

function referenceImpacts(options: {
  rows: DatasetMaintenanceRemoteRow[];
  deletes: DatasetMaintenanceScopeAction[];
  phase: DatasetMaintenanceReferenceImpact['phase'];
}): DatasetMaintenanceReferenceImpact[] {
  const payloadRows = options.rows
    .filter((row) => row.json_ordered !== null)
    .map((row) => ({
      table: row.table,
      id: row.id,
      version: row.version,
      json_ordered: row.json_ordered as JsonObject,
    }));
  const references = collectRemoteReferences(payloadRows).filter(
    (reference) => reference.role === 'reference',
  );
  const impacts: DatasetMaintenanceReferenceImpact[] = [];
  for (const reference of references) {
    const source = payloadRows[reference.row_index];
    if (!reference.table || !reference.id) {
      continue;
    }
    for (const target of options.deletes) {
      const sameTarget =
        reference.table === target.table &&
        reference.id === target.id &&
        (!reference.version || reference.version === target.version);
      if (sameTarget) {
        impacts.push({
          target_action_id: target.action_id,
          target_table: target.table,
          target_id: target.id,
          target_version: target.version,
          phase: options.phase,
          source_table: source!.table,
          source_id: source!.id,
          source_version: source!.version,
          reference_path: reference.path,
          reference_version: reference.version,
        });
      }
    }
  }
  return impacts.sort((left, right) =>
    [
      left.target_action_id,
      left.source_table,
      left.source_id,
      left.source_version,
      left.reference_path,
    ]
      .join('\u0000')
      .localeCompare(
        [
          right.target_action_id,
          right.source_table,
          right.source_id,
          right.source_version,
          right.reference_path,
        ].join('\u0000'),
      ),
  );
}

function projectedRows(options: {
  current: DatasetMaintenanceRemoteRow[];
  actions: DatasetMaintenancePlanAction[];
  desiredPayloads: Map<string, JsonObject>;
}): DatasetMaintenanceRemoteRow[] {
  const projected = new Map(options.current.map((row) => [maintenanceRowKey(row), { ...row }]));
  for (const action of options.actions.filter((entry) =>
    ['save_draft', 'update_json_ordered'].includes(entry.action),
  )) {
    const key = maintenanceRowKey(action);
    const row = projected.get(key);
    const payload = options.desiredPayloads.get(action.action_id);
    if (row && payload) {
      projected.set(key, { ...row, json_ordered: payload });
    }
  }
  for (const action of options.actions.filter((entry) => entry.action === 'delete')) {
    projected.delete(maintenanceRowKey(action));
  }
  return [...projected.values()].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
}

export function maintenanceProjectedReferenceFingerprint(
  rows: DatasetMaintenanceRemoteRow[],
): unknown[] {
  const payloadRows = rows
    .filter((row) => row.json_ordered !== null)
    .map((row) => ({
      table: row.table,
      id: row.id,
      version: row.version,
      json_ordered: row.json_ordered as JsonObject,
    }));
  return collectRemoteReferences(payloadRows)
    .filter((reference) => reference.role === 'reference')
    .map((reference) => ({
      source: maintenanceRowKey(payloadRows[reference.row_index]!),
      table: reference.table,
      id: reference.id,
      version: reference.version,
      path: reference.path,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function protectedRows(options: {
  snapshot: DatasetMaintenanceRowSnapshot[];
  actions: DatasetMaintenancePlanAction[];
}): DatasetMaintenanceProtectedRow[] {
  const readyActionKeys = new Set(
    options.actions
      .filter((action) => action.before && action.status === 'ready')
      .map(maintenanceRowKey),
  );
  const blockedActionKeys = new Set(
    options.actions
      .filter((action) => action.before && action.status === 'blocked')
      .map(maintenanceRowKey),
  );
  return options.snapshot
    .filter((row) => !readyActionKeys.has(maintenanceRowKey(row)))
    .map((row) => ({
      table: row.table,
      id: row.id,
      version: row.version,
      modified_at: row.modified_at,
      row_sha256: row.row_sha256,
      payload_sha256: row.payload_sha256,
      reason: blockedActionKeys.has(maintenanceRowKey(row))
        ? ('blocked_action_row' as const)
        : ('non_action_visible_row' as const),
    }));
}

export async function runDatasetMaintenancePlan(
  options: RunDatasetMaintenancePlanOptions,
): Promise<DatasetMaintenancePlan> {
  const scopePath = path.resolve(options.scopePath);
  const outDir = path.resolve(options.outDir);
  const pageSize = normalizeMaintenancePageSize(options.pageSize);
  const generatedAtUtc = (options.now ?? new Date()).toISOString();
  const scope = parseMaintenanceScope(
    readJsonFile(scopePath, 'Maintenance scope'),
    options.operation,
  );
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  if (context.account.user_id !== scope.account.user_id) {
    throw new CliError('Current authenticated user does not match maintenance scope account.', {
      code: 'DATASET_MAINTENANCE_ACCOUNT_MISMATCH',
      exitCode: 1,
      details: {
        expected_user_id: scope.account.user_id,
        current_user_id: context.account.user_id,
      },
    });
  }
  if (
    scope.account.email &&
    normalizeEmail(scope.account.email) !== normalizeEmail(context.account.email)
  ) {
    throw new CliError('Current authenticated email does not match maintenance scope account.', {
      code: 'DATASET_MAINTENANCE_ACCOUNT_EMAIL_MISMATCH',
      exitCode: 1,
      details: {
        expected_email: scope.account.email,
        current_email: context.account.email,
      },
    });
  }

  const accountSnapshot = await fetchMaintenanceAccountRows({
    context,
    userId: scope.account.user_id,
    pageSize,
  });
  const snapshotRows = accountSnapshot.rows
    .map(snapshotRemoteRow)
    .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)));
  const snapshotByKey = new Map(snapshotRows.map((row) => [maintenanceRowKey(row), row]));
  const desiredPayloads = new Map<string, JsonObject>();
  const actionPlans: DatasetMaintenancePlanAction[] = [];
  const aliasTargetSnapshots = new Map<
    string,
    DatasetMaintenanceAliasBatchPlan['target_snapshots']
  >();
  for (const batch of scope.alias_batches ?? []) {
    const targetRows = await Promise.all(
      (['unitgroup', 'flowproperty'] as const).map(async (kind) => {
        const target = batch.target[kind];
        const table = kind === 'unitgroup' ? 'unitgroups' : 'flowproperties';
        const exact = await fetchMaintenanceExactRows({
          context,
          table,
          id: target.id,
          version: target.version,
        });
        const row = exact.rows.length === 1 ? exact.rows[0] : null;
        if (!row?.json_ordered) return null;
        const inspection = inspectMaintenanceSupportPayload({
          table,
          payload: row.json_ordered,
          schemas: options.supportSchemas,
        });
        return inspection.identity.id === target.id &&
          inspection.identity.version === target.version &&
          inspection.schemaResult.success
          ? snapshotRemoteRow(row)
          : null;
      }),
    );
    const sourceUnitGroupSnapshot = snapshotByKey.get(
      maintenanceRowKey({
        table: 'unitgroups',
        id: batch.source.unitgroup.id,
        version: batch.source.unitgroup.version,
      }),
    );
    const sourceUnitGroupInspection = sourceUnitGroupSnapshot?.json_ordered
      ? inspectMaintenanceSupportPayload({
          table: 'unitgroups',
          payload: sourceUnitGroupSnapshot.json_ordered,
          schemas: options.supportSchemas,
        })
      : null;
    aliasTargetSnapshots.set(batch.batch_id, {
      unitgroup: targetRows[0],
      flowproperty: targetRows[1],
      source_unitgroup:
        sourceUnitGroupSnapshot &&
        sourceUnitGroupInspection?.identity.id === batch.source.unitgroup.id &&
        sourceUnitGroupInspection.identity.version === batch.source.unitgroup.version &&
        sourceUnitGroupInspection.schemaResult.success
          ? sourceUnitGroupSnapshot
          : null,
    });
  }

  for (const [ordinal, action] of scope.actions.entries()) {
    const actionBlockers: DatasetMaintenanceBlocker[] = [];
    const exact = await fetchMaintenanceExactRows({
      context,
      table: action.table,
      id: action.id,
      version: action.version,
    });
    const remote = exact.rows[0] ?? null;
    if (exact.rows.length === 0) {
      actionBlockers.push(
        blocker(
          action,
          'TARGET_NOT_VISIBLE',
          'Exact target row is not visible under the current authenticated RLS session.',
        ),
      );
    }
    if (exact.rows.length > 1) {
      actionBlockers.push(
        blocker(action, 'TARGET_NOT_UNIQUE', 'Exact target lookup returned multiple rows.'),
      );
    }
    const before = remote ? snapshotRemoteRow(remote) : null;
    if (before && before.user_id !== action.expected_user_id) {
      actionBlockers.push(
        blocker(action, 'TARGET_OWNER_MISMATCH', 'Target row is not owned by the expected user.', {
          visible_user_id: before.user_id,
        }),
      );
    }
    if (before && before.state_code !== 0) {
      actionBlockers.push(
        blocker(action, 'TARGET_NOT_DRAFT', 'Target row is not a draft with state_code=0.', {
          visible_state_code: before.state_code,
        }),
      );
    }
    if (before && !before.json_ordered) {
      actionBlockers.push(
        blocker(action, 'TARGET_PAYLOAD_MISSING', 'Target row has no object json_ordered payload.'),
      );
    }
    if (action.action === 'update_json_ordered' && before && !before.modified_at) {
      actionBlockers.push(
        blocker(
          action,
          'ALIAS_EXPECTED_MODIFIED_AT_MISSING',
          `${action.action} target requires a non-null modified_at optimistic-lock value.`,
        ),
      );
    }
    if (
      before &&
      action.expected_before_sha256 &&
      action.expected_before_sha256 !== before.row_sha256
    ) {
      actionBlockers.push(
        blocker(action, 'EXPECTED_BEFORE_HASH_MISMATCH', 'Target row hash differs from scope.', {
          expected: action.expected_before_sha256,
          actual: before.row_sha256,
        }),
      );
    }
    const snapshotRow = snapshotByKey.get(maintenanceRowKey(action));
    if (before && (!snapshotRow || snapshotRow.row_sha256 !== before.row_sha256)) {
      actionBlockers.push(
        blocker(
          action,
          'SNAPSHOT_DRIFT',
          'Exact target row differs from the same-account visible snapshot.',
        ),
      );
    }

    let desiredPayload: DatasetMaintenancePlanAction['desired_payload'] = null;
    if (action.action === 'save_draft' && action.desired_payload_path) {
      const sourcePayloadPath = path.resolve(path.dirname(scopePath), action.desired_payload_path);
      const rawPayload = readJsonFile(sourcePayloadPath, 'Maintenance desired payload');
      if (!isJsonObject(rawPayload)) {
        throw new CliError(`Desired payload must be a JSON object: ${sourcePayloadPath}`, {
          code: 'DATASET_MAINTENANCE_DESIRED_PAYLOAD_INVALID',
          exitCode: 2,
        });
      }
      for (const issue of collectMaintenanceDraftNameIssues(rawPayload, action.table)) {
        actionBlockers.push(
          blocker(action, 'DATASET_MAINTENANCE_NAME_INVALID', issue.message, issue),
        );
      }
      const payloadPath = path.join(
        outDir,
        'payloads',
        `${safeActionFileName(action.action_id)}.json`,
      );
      writeImmutableJson(payloadPath, rawPayload);
      desiredPayloads.set(action.action_id, rawPayload);
      desiredPayload = {
        path: path.relative(outDir, payloadPath),
        sha256: sha256Json(rawPayload),
      };
      const identity = maintenancePayloadIdentity(rawPayload);
      if (identity.id !== action.id || identity.version !== action.version) {
        actionBlockers.push(
          blocker(
            action,
            'DESIRED_PAYLOAD_IDENTITY_MISMATCH',
            'Desired payload root id/version does not match the target row.',
            identity,
          ),
        );
      }
    }
    let derivativeBefore: DatasetMaintenancePlanAction['derivative_before'];
    if (action.action === 'rebuild_derivatives' && before && actionBlockers.length === 0) {
      const rawSnapshot = await fetchMaintenanceDerivativeSnapshot({
        context,
        id: action.id,
        version: action.version,
      });
      derivativeBefore = parseDerivativeSnapshotResponse(rawSnapshot, {
        id: action.id,
        version: action.version,
        userId: action.expected_user_id,
      });
      if (derivativeBefore.modified_at !== before.modified_at) {
        actionBlockers.push(
          blocker(
            action,
            'DERIVATIVE_PRIMARY_SNAPSHOT_DRIFT',
            'Derivative snapshot modified_at differs from the lean account snapshot.',
            {
              account_snapshot_modified_at: before.modified_at,
              derivative_snapshot_modified_at: derivativeBefore.modified_at,
            },
          ),
        );
      }
    }
    actionPlans.push({
      ...action,
      ordinal,
      status: actionBlockers.length ? 'blocked' : 'ready',
      before,
      desired_payload: desiredPayload,
      blockers: actionBlockers,
      ...(derivativeBefore ? { derivative_before: derivativeBefore } : {}),
      rollback: {
        strategy:
          action.action === 'save_draft'
            ? 'save_before_snapshot'
            : action.action === 'delete'
              ? 'restore_deleted_before_snapshot'
              : action.action === 'update_json_ordered'
                ? 'restore_atomic_alias_before_snapshot'
                : 'none_derivative_only',
        before_payload_sha256:
          action.action === 'rebuild_derivatives' ? null : (before?.payload_sha256 ?? null),
        before_payload:
          action.action === 'rebuild_derivatives' ? null : (before?.json_ordered ?? null),
        model_id: action.action === 'rebuild_derivatives' ? null : (before?.model_id ?? null),
        rule_verification:
          action.action === 'rebuild_derivatives' ? null : (before?.rule_verification ?? null),
      },
    });
  }

  let aliasBatches: DatasetMaintenanceAliasBatchPlan[] | undefined;
  if (scope.operation === 'merge-support-aliases') {
    const aliasPlan = buildAliasRewritePlan({
      scope,
      actions: actionPlans,
      accountRows: accountSnapshot.rows,
      targetSnapshots: aliasTargetSnapshots,
      schemas: options.aliasSchemas,
    });
    aliasBatches = aliasPlan.batches;
    for (const action of actionPlans) {
      const rawPayload = aliasPlan.desired_payloads.get(action.action_id);
      if (!rawPayload) continue;
      const payloadPath = path.join(
        outDir,
        'payloads',
        `${safeActionFileName(action.action_id)}.json`,
      );
      writeImmutableJson(payloadPath, rawPayload);
      desiredPayloads.set(action.action_id, rawPayload);
      action.desired_payload = {
        path: path.relative(outDir, payloadPath),
        sha256: sha256Json(rawPayload),
      };
      const identity = maintenancePayloadIdentity(rawPayload);
      if (identity.id !== action.id || identity.version !== action.version) {
        action.blockers.push(
          blocker(
            action,
            'DESIRED_PAYLOAD_IDENTITY_MISMATCH',
            'Generated alias payload root id/version does not match the target row.',
            identity,
          ),
        );
        action.status = 'blocked';
      }
    }
  }

  const intendedRows = projectedRows({
    current: accountSnapshot.rows,
    actions: actionPlans,
    desiredPayloads,
  });
  const deleteActions = scope.actions.filter((action) => action.action === 'delete');
  const currentImpacts = referenceImpacts({
    rows: accountSnapshot.rows,
    deletes: deleteActions,
    phase: 'current',
  });
  const projectedImpacts = referenceImpacts({
    rows: intendedRows,
    deletes: deleteActions,
    phase: 'projected',
  });
  for (const action of actionPlans.filter((entry) => entry.action === 'delete')) {
    const impacts = projectedImpacts.filter(
      (impact) => impact.target_action_id === action.action_id,
    );
    if (impacts.length) {
      action.blockers.push(
        blocker(
          action,
          'PROJECTED_INBOUND_REFERENCES',
          `Projected state still contains ${impacts.length} inbound reference(s) to this delete target.`,
          impacts,
        ),
      );
      action.status = 'blocked';
    }
  }
  const allBlockers = actionPlans.flatMap((action) => action.blockers);
  const protectedRowList = protectedRows({ snapshot: snapshotRows, actions: actionPlans });
  const scopeSha256 = sha256Json(scope);
  const plan: DatasetMaintenancePlan = {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    task_id: scope.task_id,
    operation: scope.operation,
    operation_id: `maintenance-${scopeSha256.slice(0, 20)}`,
    account: {
      user_id: scope.account.user_id,
      email: context.account.email,
    },
    source_import_run_id: scope.source_import_run_id ?? null,
    source_lineage: scope.source_lineage ?? null,
    target_mode: scope.target_mode ?? null,
    status: allBlockers.length ? 'blocked' : 'ready',
    scope_sha256: scopeSha256,
    visible_snapshot_sha256: sha256Json(snapshotRows),
    snapshot_completeness: accountSnapshot.completeness,
    projected_reference_sha256: sha256Json(maintenanceProjectedReferenceFingerprint(intendedRows)),
    plan_sha256: '',
    summary: {
      actions: actionPlans.length,
      save_draft: actionPlans.filter((action) => action.action === 'save_draft').length,
      delete: actionPlans.filter((action) => action.action === 'delete').length,
      update_json_ordered: actionPlans.filter((action) => action.action === 'update_json_ordered')
        .length,
      rebuild_derivatives: actionPlans.filter((action) => action.action === 'rebuild_derivatives')
        .length,
      atomic_batches: aliasBatches?.length ?? 0,
      scaled_exchanges: aliasBatches?.reduce((sum, batch) => sum + batch.summary.exchanges, 0) ?? 0,
      scaled_amount_fields:
        aliasBatches?.reduce((sum, batch) => sum + batch.summary.amount_fields, 0) ?? 0,
      unrelated_exchanges_preserved:
        aliasBatches?.reduce((sum, batch) => sum + batch.summary.unrelated_exchanges, 0) ?? 0,
      protected_rows: protectedRowList.length,
      blockers: allBlockers.length,
      current_reference_impacts: currentImpacts.length,
      projected_reference_impacts: projectedImpacts.length,
    },
    artifacts: {
      maintenance_scope: 'maintenance-scope.json',
      rls_visible_snapshot: 'rls-visible-snapshot.json',
      protected_rows: 'protected-rows.jsonl',
      reference_impact_report: 'reference-impact-report.json',
      maintenance_plan: 'maintenance-plan.json',
      dry_run_report: 'dry-run-report.json',
      payload_dir: 'payloads',
      ...(aliasBatches ? { exchange_rewrite_plan: 'exchange-rewrite-plan.jsonl' } : {}),
      ...(scope.operation === 'rebuild-derivatives'
        ? { derivative_baseline: 'derivative-baseline.json' }
        : {}),
    },
    actions: actionPlans,
    ...(aliasBatches ? { alias_batches: aliasBatches } : {}),
    protected_rows: protectedRowList,
    blockers: allBlockers,
  };
  plan.plan_sha256 = computePlanSha256(plan);

  writeImmutableJson(path.join(outDir, plan.artifacts.maintenance_scope), scope);
  writeImmutableJson(path.join(outDir, plan.artifacts.rls_visible_snapshot), {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    account: {
      user_id: scope.account.user_id,
      email: context.account.email,
      session_source: context.account.session_source,
    },
    page_size: pageSize,
    completeness: accountSnapshot.completeness,
    source_urls: accountSnapshot.source_urls,
    row_count: snapshotRows.length,
    snapshot_sha256: plan.visible_snapshot_sha256,
    rows: snapshotRows,
  });
  writeImmutableJsonLines(path.join(outDir, plan.artifacts.protected_rows), protectedRowList);
  if (plan.artifacts.derivative_baseline) {
    writeImmutableJson(
      path.join(outDir, plan.artifacts.derivative_baseline),
      plan.actions[0]!.derivative_before ?? null,
    );
  }
  if (plan.artifacts.exchange_rewrite_plan) {
    writeImmutableJsonLines(
      path.join(outDir, plan.artifacts.exchange_rewrite_plan),
      plan.alias_batches!.flatMap((batch) =>
        batch.exchange_rewrites.map((rewrite) => ({
          schema_version: 1,
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          batch_id: batch.batch_id,
          factor: batch.factor,
          ...rewrite,
        })),
      ),
    );
  }
  writeImmutableJson(path.join(outDir, plan.artifacts.reference_impact_report), {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    plan_sha256: plan.plan_sha256,
    status: plan.status,
    current: currentImpacts,
    projected: projectedImpacts,
    projected_reference_sha256: plan.projected_reference_sha256,
  });
  writeImmutableJson(path.join(outDir, plan.artifacts.dry_run_report), {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    status: plan.status,
    operation: plan.operation,
    target_mode: plan.target_mode,
    task_id: plan.task_id,
    plan_sha256: plan.plan_sha256,
    account: plan.account,
    snapshot_completeness: accountSnapshot.completeness,
    summary: plan.summary,
    actions: plan.actions.map((action) => ({
      action_id: action.action_id,
      action: action.action,
      table: action.table,
      id: action.id,
      version: action.version,
      status: action.status,
      blockers: action.blockers,
      ...(action.derivative_before ? { derivative_before: action.derivative_before } : {}),
    })),
    alias_batches: plan.alias_batches?.map((batch) => ({
      batch_id: batch.batch_id,
      dimension: batch.dimension,
      factor: batch.factor,
      summary: batch.summary,
      postconditions: batch.postconditions,
      target_snapshots: batch.target_snapshots,
    })),
    blockers: plan.blockers,
  });
  writeImmutableJson(path.join(outDir, plan.artifacts.maintenance_plan), plan);
  return plan;
}

export const __testInternals = {
  desiredPayloadIdentity: maintenancePayloadIdentity,
  maintenanceProjectedReferenceFingerprint,
  projectedRows,
  protectedRows,
  referenceImpacts,
};
