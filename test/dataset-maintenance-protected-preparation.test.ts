import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTECTED_PREPARATION_CONTRACT,
  PROTECTED_PREPARATION_REJECTED_PLAN_SHA256,
  PROTECTED_PRODUCTION_PROJECT_REF,
  assertProtectedPreparationPlanSha256,
  assertProtectedProductionProjectRef,
  buildProtectedApprovalRequest,
  buildProtectedFreeze,
  deriveProtectedDerivativeSnapshotTargets,
  parseProtectedApprovalRequest,
  sealProtectedApproval,
} from '../src/lib/dataset-maintenance-protected-preparation.js';
import { computePlanSha256 } from '../src/lib/dataset-maintenance-contract.js';
import { sha256Text } from '../src/lib/canonical-json-hash.js';
import {
  type DatasetMaintenancePlan,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import {
  parseProtectedApproval,
  type ProtectedDerivativeSnapshot,
} from '../src/lib/dataset-maintenance-protected-contract.js';
import { CliError } from '../src/shared/errors.js';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const EMAIL = 'bafudata@126.com';
const VERSION = '00.00.001';
const PROJECT_REF = PROTECTED_PRODUCTION_PROJECT_REF;
const PLAN_FILE_SHA256 = sha256Text('plan-file');
const TOOLCHAIN_SHA256 = sha256Text('production-toolchain');
const APPROVED_AT = '2026-07-16T00:00:00.000Z';

function copy<T>(value: T): T {
  return structuredClone(value);
}

function expectFailure(action: () => unknown, message?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.exitCode, 2);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function entityId(table: 'flows' | 'processes', index: number): string {
  const prefix = table === 'flows' ? '00000000-0000-4000-8000-' : '11111111-1111-4111-8111-';
  return `${prefix}${String(index + 1).padStart(12, '0')}`;
}

function planFixture(): DatasetMaintenancePlan {
  const targets = [
    ...Array.from({ length: 23 }, (_, index) => ({
      table: 'flows' as const,
      id: entityId('flows', index),
    })),
    ...Array.from({ length: 27 }, (_, index) => ({
      table: 'processes' as const,
      id: entityId('processes', index),
    })),
  ];
  const rows = [
    { table: 'flowproperties' as const, id: 'flowproperty-time' },
    { table: 'flowproperties' as const, id: 'flowproperty-length-time' },
    ...targets,
  ];
  const actions = rows
    .map((row, index) => ({
      action_id: `${row.table}-${String(index + 1).padStart(2, '0')}`,
      action: 'update_json_ordered' as const,
      table: row.table,
      id: row.id,
      version: VERSION,
      expected_user_id: USER_ID,
      expected_state_code: 0 as const,
      reason_code: 'BAFU_PRIVATE_STEP_2',
      reason: 'test fixture',
      evidence: [],
      ordinal: index + 1,
      status: 'ready' as const,
      before: {
        table: row.table,
        id: row.id,
        version: VERSION,
        user_id: USER_ID,
        state_code: 0,
        modified_at: '2026-07-15T00:00:00.000Z',
        json_ordered: {},
        model_id: null,
        rule_verification: null,
        row_sha256: sha256Text(`before:${row.table}:${row.id}`),
        payload_sha256: sha256Text(`before-payload:${row.table}:${row.id}`),
      },
      desired_payload: {
        path: `payloads/${row.table}-${index}.json`,
        sha256: sha256Text(`desired:${row.table}:${row.id}`),
      },
      blockers: [],
      rollback: {
        strategy: 'restore_atomic_alias_before_snapshot' as const,
        before_payload_sha256: null,
        before_payload: null,
        model_id: null,
        rule_verification: null,
      },
    }))
    .reverse();
  const plan = {
    schema_version: 1,
    generated_at_utc: '2026-07-15T00:00:00.000Z',
    task_id: 'bafu-private-step-2',
    operation: 'merge-support-aliases',
    operation_id: 'bafu-private-step-2-owner-draft',
    account: { user_id: USER_ID, email: EMAIL },
    source_import_run_id: null,
    source_lineage: null,
    target_mode: 'owner_draft',
    status: 'ready',
    scope_sha256: sha256Text('scope'),
    visible_snapshot_sha256: sha256Text('visible-snapshot'),
    projected_reference_sha256: sha256Text('projected-reference'),
    plan_sha256: '',
    summary: {
      actions: 52,
      save_draft: 0,
      delete: 0,
      update_json_ordered: 52,
      rebuild_derivatives: 0,
      atomic_batches: 2,
      scaled_exchanges: 59,
      scaled_amount_fields: 118,
      unrelated_exchanges_preserved: 309,
      protected_rows: 0,
      blockers: 0,
      current_reference_impacts: 0,
      projected_reference_impacts: 0,
    },
    artifacts: {
      maintenance_scope: 'maintenance-scope.json',
      rls_visible_snapshot: 'rls-visible-snapshot.json',
      protected_rows: 'protected-rows.jsonl',
      reference_impact_report: 'reference-impact-report.json',
      maintenance_plan: 'maintenance-plan.json',
      dry_run_report: 'dry-run-report.json',
      payload_dir: 'payloads',
    },
    actions,
    alias_batches: [
      {
        batch_id: 'time',
        dimension: 'time',
        factor: '0.00011415525114155251',
        action_ids: [],
        exchange_rewrites: Array.from({ length: 20 }, (_, index) => ({
          dimension: 'time',
          index,
        })),
        target_snapshots: { flowproperty: { dimension: 'time' } },
      },
      {
        batch_id: 'length_time',
        dimension: 'length_time',
        factor: '1000',
        action_ids: [],
        exchange_rewrites: Array.from({ length: 39 }, (_, index) => ({
          dimension: 'length_time',
          index,
        })),
        target_snapshots: { flowproperty: { dimension: 'length_time' } },
      },
    ],
    protected_rows: [],
    blockers: [],
  } as unknown as DatasetMaintenancePlan;
  plan.plan_sha256 = computePlanSha256(plan);
  return plan;
}

function aliasPlanRequest(plan: DatasetMaintenancePlan): JsonObject {
  return {
    schema_version: 'dataset-alias-plan.v1',
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    target_visibility: 'owner_draft',
    batches: ['time', 'length_time'].map((dimension) => ({
      schema_version: 'dataset-alias-batch.v1',
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      target_visibility: 'owner_draft',
      dimension,
    })),
  };
}

function snapshots(plan: DatasetMaintenancePlan): ProtectedDerivativeSnapshot[] {
  return plan.actions
    .filter((action) => action.table === 'flows' || action.table === 'processes')
    .sort(
      (left, right) =>
        left.table.localeCompare(right.table) ||
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version),
    )
    .map((action) => {
      const jsonSha256 = sha256Text(`json:${action.table}:${action.id}`);
      return {
        schema_version: 'dataset-derivative-snapshot.v1',
        table: action.table as 'flows' | 'processes',
        id: action.id,
        version: action.version,
        user_id: USER_ID,
        state_code: 0,
        modified_at: '2026-07-15T00:00:00.000Z',
        json_sha256: jsonSha256,
        json_ordered_sha256: jsonSha256,
        extracted_md_sha256: sha256Text(`md:${action.table}:${action.id}`),
        embedding_ft_sha256: sha256Text(`embedding:${action.table}:${action.id}`),
        embedding_ft_at: '2026-07-15T00:00:00.000Z',
        snapshot_sha256: sha256Text(`snapshot:${action.table}:${action.id}`),
      };
    });
}

function buildFreeze(
  options: {
    plan?: DatasetMaintenancePlan;
    account?: { user_id: string; email: string };
    toolchainEvidenceSha256?: string;
    derivativeSnapshots?: ProtectedDerivativeSnapshot[];
    aliasRequest?: JsonObject;
  } = {},
) {
  const plan = options.plan ?? planFixture();
  return buildProtectedFreeze({
    plan,
    planFileSha256: PLAN_FILE_SHA256,
    aliasPlanRequest: options.aliasRequest ?? aliasPlanRequest(plan),
    projectRef: PROJECT_REF,
    account: options.account ?? { user_id: USER_ID, email: EMAIL },
    toolchainEvidenceSha256: options.toolchainEvidenceSha256 ?? TOOLCHAIN_SHA256,
    derivativeSnapshots: options.derivativeSnapshots ?? snapshots(plan),
  });
}

function approvalInputs() {
  const freeze = buildFreeze();
  const request = buildProtectedApprovalRequest({
    freeze: freeze.value,
    freezeFileSha256: freeze.file_sha256,
    approvedAtUtc: APPROVED_AT,
  });
  return { freeze, request };
}

test('builds a canonical freeze, unapproved request, and explicit sealed approval', () => {
  const { freeze, request } = approvalInputs();
  assert.equal(freeze.value.derivative_targets.length, 50);
  assert.equal(
    freeze.value.derivative_targets.slice(0, 23).every((row) => row.table === 'flows'),
    true,
  );
  assert.equal(
    freeze.value.derivative_targets.slice(23).every((row) => row.table === 'processes'),
    true,
  );
  assert.equal(sha256Text(freeze.canonical_file_text), freeze.file_sha256);
  assert.equal(
    request.value.schema_version,
    PROTECTED_PREPARATION_CONTRACT.approval_request_schema,
  );
  assert.equal(request.value.approval_text.includes(request.value.request_sha256), true);
  assert.equal(sha256Text(request.value.approval_text), request.value.approval_text_sha256);
  assert.equal('approved' in request.value, false);
  assert.equal(request.value.approved_at_utc, APPROVED_AT);
  assert.equal(request.value.approval_text.includes(`approved_at_utc=${APPROVED_AT}`), true);
  assert.deepEqual(parseProtectedApprovalRequest(request.value), request.value);

  const sealed = sealProtectedApproval({
    approvalRequest: request.value,
    freeze: freeze.value,
    freezeFileSha256: freeze.file_sha256,
    humanApprovalText: request.value.approval_text,
    approveRequestSha256: request.value.request_sha256,
    approveTextSha256: request.value.approval_text_sha256,
    approvedAtUtc: APPROVED_AT,
    confirmAccountEmail: EMAIL,
  });
  assert.deepEqual(parseProtectedApproval(sealed.value), sealed.value);
  assert.equal(sealed.value.freeze_file_sha256, freeze.file_sha256);
  assert.equal(sealed.value.approval_text_sha256, request.value.approval_text_sha256);
  assert.equal(sha256Text(sealed.canonical_file_text), sealed.file_sha256);

  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: request.value.approval_text,
        approveRequestSha256: request.value.request_sha256,
        approveTextSha256: request.value.approval_text_sha256,
        approvedAtUtc: '2026-07-16T00:00:01.000Z',
        confirmAccountEmail: EMAIL,
      }),
    /approved timestamp/u,
  );
});

test('derivative targets use one stable flow/process/id/version order', () => {
  const plan = planFixture();
  const ordered = buildFreeze({ plan, derivativeSnapshots: snapshots(plan) });
  const targets = deriveProtectedDerivativeSnapshotTargets(plan, {
    user_id: USER_ID,
    email: EMAIL,
  });
  assert.equal(targets.length, 50);
  assert.deepEqual(
    ordered.value.derivative_targets.map(({ table, id, version, user_id, state_code }) => ({
      table,
      id,
      version,
      user_id,
      state_code,
    })),
    targets,
  );
  const keys = ordered.value.derivative_targets.map(
    (row) => `${row.table}\u0000${row.id}\u0000${row.version}`,
  );
  assert.deepEqual(
    keys,
    [...keys].sort((left, right) => left.localeCompare(right)),
  );
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: snapshots(plan).reverse() }),
    /stable target order/u,
  );
});

test('protected preparation is machine-bound to the production project', () => {
  assert.equal(assertProtectedProductionProjectRef(PROJECT_REF), PROJECT_REF);
  expectFailure(() => assertProtectedProductionProjectRef('dev-ref'), /production project/u);
});

test('approval text and its explicit hashes are byte exact', () => {
  const { freeze, request } = approvalInputs();
  const changedRequest = { ...request.value, approval_text: `${request.value.approval_text} ` };
  expectFailure(() => parseProtectedApprovalRequest(changedRequest), /byte-exact/u);
  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: request.value.approval_text.replaceAll('\n', '\r\n'),
        approveRequestSha256: request.value.request_sha256,
        approveTextSha256: request.value.approval_text_sha256,
        approvedAtUtc: APPROVED_AT,
        confirmAccountEmail: EMAIL,
      }),
    /Explicit human approval/u,
  );
  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: request.value.approval_text,
        approveRequestSha256: sha256Text('wrong request'),
        approveTextSha256: request.value.approval_text_sha256,
        approvedAtUtc: APPROVED_AT,
        confirmAccountEmail: EMAIL,
      }),
    /Explicit human approval/u,
  );
  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: request.value.approval_text,
        approveRequestSha256: request.value.request_sha256,
        approveTextSha256: sha256Text('wrong text'),
        approvedAtUtc: APPROVED_AT,
        confirmAccountEmail: EMAIL,
      }),
    /Explicit human approval/u,
  );
});

test('preparation fails closed on plan, account, alias, toolchain, and snapshot mismatches', () => {
  const plan = planFixture();
  expectFailure(
    () => buildFreeze({ plan, account: { user_id: OTHER_USER_ID, email: EMAIL } }),
    /exact canonical ready owner-draft plan and account/u,
  );

  const changedPlan = copy(plan);
  changedPlan.operation_id = 'changed-operation';
  expectFailure(
    () => buildFreeze({ plan: changedPlan }),
    /exact canonical ready owner-draft plan and account/u,
  );

  expectFailure(
    () => buildFreeze({ plan, toolchainEvidenceSha256: 'not-a-hash' }),
    /lowercase SHA-256/u,
  );

  const wrongAlias = aliasPlanRequest(plan);
  wrongAlias.plan_sha256 = sha256Text('other-plan');
  expectFailure(
    () => buildFreeze({ plan, aliasRequest: wrongAlias }),
    /Alias plan request does not bind/u,
  );

  const missingSnapshot = snapshots(plan).slice(1);
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: missingSnapshot }),
    /exact 50-target set/u,
  );

  const duplicateSnapshot = snapshots(plan);
  duplicateSnapshot[duplicateSnapshot.length - 1] = duplicateSnapshot[0]!;
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: duplicateSnapshot }),
    /stable target order/u,
  );

  const foreignOwner = snapshots(plan);
  foreignOwner[0] = { ...foreignOwner[0]!, user_id: OTHER_USER_ID };
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: foreignOwner }),
    /stable target order/u,
  );
});

test('seal cross-binds the actual freeze bytes, account, and toolchain evidence', () => {
  const { freeze, request } = approvalInputs();
  const alternateFreeze = buildFreeze({ toolchainEvidenceSha256: sha256Text('other-toolchain') });
  expectFailure(
    () =>
      buildProtectedApprovalRequest({
        freeze: freeze.value,
        freezeFileSha256: sha256Text('different freeze bytes'),
        approvedAtUtc: APPROVED_AT,
      }),
    /canonical freeze artifact bytes/u,
  );
  const base = {
    approvalRequest: request.value,
    humanApprovalText: request.value.approval_text,
    approveRequestSha256: request.value.request_sha256,
    approveTextSha256: request.value.approval_text_sha256,
    approvedAtUtc: APPROVED_AT,
    confirmAccountEmail: EMAIL,
  };
  expectFailure(
    () =>
      sealProtectedApproval({
        ...base,
        freeze: freeze.value,
        freezeFileSha256: sha256Text('different freeze bytes'),
      }),
    /canonical freeze artifact bytes/u,
  );
  expectFailure(
    () =>
      sealProtectedApproval({
        ...base,
        freeze: alternateFreeze.value,
        freezeFileSha256: alternateFreeze.file_sha256,
      }),
    /does not bind the supplied freeze file, plan, account, or toolchain/u,
  );
  expectFailure(
    () =>
      sealProtectedApproval({
        ...base,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        confirmAccountEmail: 'other@example.com',
      }),
    /Explicit human approval/u,
  );
});

test('approval is never inferred from a request artifact', () => {
  const { freeze, request } = approvalInputs();
  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: undefined as never,
        approveRequestSha256: undefined as never,
        approveTextSha256: undefined as never,
        approvedAtUtc: undefined as never,
        confirmAccountEmail: undefined as never,
      }),
    /approveRequestSha256 must be/u,
  );
  expectFailure(
    () => parseProtectedApprovalRequest({ ...request.value, approved: true }),
    /must contain exactly/u,
  );
  expectFailure(
    () =>
      sealProtectedApproval({
        approvalRequest: request.value,
        freeze: freeze.value,
        freezeFileSha256: freeze.file_sha256,
        humanApprovalText: request.value.approval_text,
        approveRequestSha256: request.value.request_sha256,
        approveTextSha256: request.value.approval_text_sha256,
        approvedAtUtc: '2026-07-16T00:00:00Z',
        confirmAccountEmail: EMAIL,
      }),
    /canonical ISO timestamp/u,
  );
});

test('all historical Step 2 plan hashes are denied by builder and parser', () => {
  for (const denied of PROTECTED_PREPARATION_REJECTED_PLAN_SHA256) {
    expectFailure(
      () => assertProtectedPreparationPlanSha256(denied),
      /historical superseded plan/u,
    );
    const plan = planFixture();
    plan.plan_sha256 = denied;
    expectFailure(() => buildFreeze({ plan }), /historical superseded plan/u);

    const request = approvalInputs().request.value;
    const historicalRequest = copy(request);
    historicalRequest.plan.plan_sha256 = denied;
    expectFailure(
      () => parseProtectedApprovalRequest(historicalRequest),
      /historical superseded plan/u,
    );
  }
});

test('preparation rejects every malformed request shape and derivative edge', () => {
  const { request } = approvalInputs();
  const malformedRequests: Array<[unknown, RegExp]> = [
    [null, /Approval request must be an object/u],
    [{ ...request.value, schema_version: 'old' }, /production owner-draft v1/u],
    [{ ...request.value, account: null }, /account must be an object/u],
    [{ ...request.value, plan: null }, /plan must be an object/u],
    [{ ...request.value, sets: null }, /sets must be an object/u],
    [{ ...request.value, expected: null }, /expected must be an object/u],
    [
      {
        ...request.value,
        expected: { ...request.value.expected, action_count: 51 },
      },
      /expected.action_count/u,
    ],
    [{ ...request.value, policy: null }, /policy must be an object/u],
    [
      { ...request.value, policy: { ...request.value.policy, save_draft: 1 } },
      /one-shot owner-draft/u,
    ],
    [{ ...request.value, request_sha256: sha256Text('wrong request') }, /request_sha256/u],
    [{ ...request.value, approval_text: '' }, /non-empty byte-exact string/u],
    [{ ...request.value, approval_text_sha256: sha256Text('wrong text') }, /approval_text_sha256/u],
  ];
  for (const [value, pattern] of malformedRequests) {
    expectFailure(() => parseProtectedApprovalRequest(value), pattern);
  }

  const plan = planFixture();
  const badTimestamp = snapshots(plan);
  badTimestamp[0]!.modified_at = 'not-time';
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: badTimestamp }),
    /must be an ISO timestamp/u,
  );

  const mismatchedJson = snapshots(plan);
  mismatchedJson[0]!.json_ordered_sha256 = sha256Text('different json');
  expectFailure(
    () => buildFreeze({ plan, derivativeSnapshots: mismatchedJson }),
    /json and json_ordered hashes/u,
  );

  const malformedAlias = aliasPlanRequest(plan);
  (malformedAlias.batches as unknown[])[0] = null;
  expectFailure(
    () => buildFreeze({ plan, aliasRequest: malformedAlias }),
    /exact ordered plan-bound/u,
  );

  const wrongOperation = planFixture();
  wrongOperation.operation = 'repair-references';
  wrongOperation.plan_sha256 = computePlanSha256(wrongOperation);
  expectFailure(
    () =>
      deriveProtectedDerivativeSnapshotTargets(wrongOperation, {
        user_id: USER_ID,
        email: EMAIL,
      }),
    /exact canonical owner-draft plan/u,
  );

  const missingTarget = planFixture();
  const processIndex = missingTarget.actions.findIndex((action) => action.table === 'processes');
  missingTarget.actions.splice(processIndex, 1);
  missingTarget.plan_sha256 = computePlanSha256(missingTarget);
  expectFailure(
    () =>
      deriveProtectedDerivativeSnapshotTargets(missingTarget, {
        user_id: USER_ID,
        email: EMAIL,
      }),
    /exactly 23 owner-draft flows and 27 processes/u,
  );

  const duplicateTarget = planFixture();
  const duplicateFlows = duplicateTarget.actions.filter((action) => action.table === 'flows');
  duplicateFlows[1]!.id = duplicateFlows[0]!.id;
  duplicateFlows[1]!.version = duplicateFlows[0]!.version;
  duplicateTarget.plan_sha256 = computePlanSha256(duplicateTarget);
  expectFailure(
    () =>
      deriveProtectedDerivativeSnapshotTargets(duplicateTarget, {
        user_id: USER_ID,
        email: EMAIL,
      }),
    /must not contain duplicate/u,
  );

  const versionOrdered = planFixture();
  const versionFlows = versionOrdered.actions.filter((action) => action.table === 'flows');
  versionFlows[1]!.id = versionFlows[0]!.id;
  versionFlows[1]!.version = '00.00.002';
  versionOrdered.plan_sha256 = computePlanSha256(versionOrdered);
  const derived = deriveProtectedDerivativeSnapshotTargets(versionOrdered, {
    user_id: USER_ID,
    email: EMAIL,
  });
  const sameId = derived.filter((target) => target.id === versionFlows[0]!.id);
  assert.deepEqual(
    sameId.map((target) => target.version),
    ['00.00.001', '00.00.002'],
  );
});
