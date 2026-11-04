import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAINTENANCE_SCAN_TABLES,
  maintenanceRowKey,
  sha256Json,
  sha256Text,
  stableJsonText,
  snapshotRemoteRow,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  PROTECTED_EXECUTION_CONTRACT,
  type DatasetMaintenanceProtectedApproval,
  type DatasetMaintenanceProtectedFreeze,
  type ProtectedAdmissionProof,
  type ProtectedDerivativeSnapshot,
  type ProtectedExecutionIdentity,
  type ProtectedExecutionStatusProof,
  type ProtectedGateProof,
  type ProtectedPreflightProof,
} from '../src/lib/dataset-maintenance-protected-contract.js';
import { PROTECTED_PREPARATION_REJECTED_PLAN_SHA256 } from '../src/lib/dataset-maintenance-protected-preparation.js';
import {
  __testInternals as runInternals,
  runDatasetMaintenanceProtected,
  type RunDatasetMaintenanceProtectedOptions,
} from '../src/lib/dataset-maintenance-protected-run.js';
import { maintenanceProjectedReferenceFingerprint } from '../src/lib/dataset-maintenance-plan.js';
import type { DatasetMaintenanceRemoteContext } from '../src/lib/dataset-maintenance-remote.js';
import type { ProtectedVerificationResult } from '../src/lib/dataset-maintenance-protected-verify.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const USER_ID = 'dab05739-1a42-421b-8170-3b77146d1d64';
const EMAIL = 'bafudata@126.com';
const PROJECT_REF = 'qgzvkongdjqiiamzbbts';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const FLOW_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const VERSION = '00.00.001';

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
    requested_page_size: 1000,
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
        requested_page_size: 1000,
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

function planFixture(root: string): {
  plan: DatasetMaintenancePlan;
  rows: DatasetMaintenanceRemoteRow[];
  desired: JsonObject;
} {
  mkdirSync(root, { recursive: true });
  const before = row({ table: 'flows', id: FLOW_ID, payload: { value: 'before' } });
  const protectedRow = row({ table: 'sources', id: SOURCE_ID, payload: { source: true } });
  const rows = [before, protectedRow];
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
    before: snapshotRemoteRow(before),
    desired_payload: {
      path: path.basename(desiredPath),
      sha256: sha256Json(desired),
    },
    rollback: null,
  };
  const projected = [{ ...before, json_ordered: desired }, protectedRow].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
  const snapshots = rows
    .map(snapshotRemoteRow)
    .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)));
  const plan = {
    schema_version: 1,
    task_id: 'bafu-private-step-2',
    operation: 'merge-support-aliases',
    operation_id: 'bafu-private-step-2-operation',
    target_mode: 'owner_draft',
    plan_sha256: HASH_A,
    account: { user_id: USER_ID, email: EMAIL },
    status: 'ready',
    blockers: [],
    actions: [action],
    protected_rows: [snapshotRemoteRow(protectedRow)],
    alias_batches: [],
    snapshot_completeness: completeness(rows),
    visible_snapshot_sha256: sha256Json(snapshots),
    projected_reference_sha256: sha256Json(maintenanceProjectedReferenceFingerprint(projected)),
  } as unknown as DatasetMaintenancePlan;
  return { plan, rows, desired };
}

function identityFixture(): ProtectedExecutionIdentity {
  return {
    request_id: REQUEST_ID,
    identity_sha256: HASH_B,
    environment: 'production',
    project_ref: PROJECT_REF,
    actor: { user_id: USER_ID, email: EMAIL },
    target_visibility: 'owner_draft',
    plan_sha256: HASH_A,
    operation_id: 'bafu-private-step-2-operation',
    bindings: {
      plan_file_sha256: HASH_A,
      freeze_file_sha256: HASH_A,
      freeze_sha256: HASH_A,
      approval_file_sha256: HASH_A,
      approval_identity_sha256: HASH_A,
      approval_text_sha256: HASH_A,
      alias_plan_request_sha256: HASH_A,
      before_hash_set_sha256: HASH_A,
      desired_hash_set_sha256: HASH_A,
      exchange_rewrite_set_sha256: HASH_A,
      support_snapshot_set_sha256: HASH_A,
      derivative_baseline_set_sha256: HASH_A,
      derivative_target_set_sha256: HASH_A,
      toolchain_evidence_sha256: HASH_A,
    },
    expected: {} as ProtectedExecutionIdentity['expected'],
    derivative_targets: [],
  };
}

function contextFixture(fetchImpl: FetchLike = async () => jsonResponse({ ok: true })) {
  return {
    project_ref: PROJECT_REF,
    rest_base_url: `https://${PROJECT_REF}.supabase.co/rest/v1`,
    publishable_key: 'publishable',
    access_token: 'access',
    account: { user_id: USER_ID, email: EMAIL, session_source: 'test' },
    fetch_impl: fetchImpl,
    timeout_ms: 1000,
  } satisfies DatasetMaintenanceRemoteContext;
}

function commandFixture(root: string, commit = false): RunDatasetMaintenanceProtectedOptions {
  return {
    planPath: path.join(root, 'plan.json'),
    freezePath: path.join(root, 'freeze.json'),
    approvalPath: path.join(root, 'approval.json'),
    outDir: path.join(root, 'out'),
    commit,
    statusOnly: !commit,
    approveExecution: commit ? HASH_A : undefined,
    confirm: commit ? EMAIL : undefined,
    waitSeconds: 0,
    pollMs: 100,
    pageSize: 1000,
    env: {},
    fetchImpl: async () => jsonResponse({}),
    now: new Date('2026-07-15T00:00:00.000Z'),
  };
}

function preparedFixture(root: string, commit = false) {
  const { plan, rows, desired } = planFixture(root);
  const identity = identityFixture();
  const freeze = { marker: 'freeze' } as unknown as DatasetMaintenanceProtectedFreeze;
  const approval = {
    approval_identity_sha256: HASH_A,
  } as unknown as DatasetMaintenanceProtectedApproval;
  const command = commandFixture(root, commit);
  let approvedHash: string | undefined;
  const dependencies = {
    readArtifact: ({ label }: { label: string }) => {
      const value =
        label === 'Maintenance plan'
          ? plan
          : label === 'Protected execution freeze'
            ? freeze
            : approval;
      return {
        resolved:
          label === 'Maintenance plan'
            ? command.planPath
            : label === 'Protected execution freeze'
              ? command.freezePath
              : command.approvalPath,
        value,
        text: `${stableJsonText(value)}\n`,
        file_sha256: HASH_A,
      };
    },
    parsePlan: () => plan,
    buildAliasPlan: () => ({ schema_version: 'dataset-alias-plan.v1' }),
    parseFreeze: () => freeze,
    parseApproval: () => approval,
    assertFreezeMatchesPlan: () => undefined,
    assertApprovalBindings: (options: { approveExecution: string | undefined }) => {
      approvedHash = options.approveExecution;
    },
    buildIdentity: () => identity,
  } as unknown as Parameters<typeof runInternals.prepareProtectedExecutionWithDependencies>[1];
  const prepared = runInternals.prepareProtectedExecutionWithDependencies(command, dependencies);
  return {
    command,
    prepared,
    plan,
    rows,
    desired,
    identity,
    dependencies,
    approvedHash: () => approvedHash,
  };
}

function statusProof(
  status: 'pending' | 'passed' | 'failed' | 'indeterminate',
  executionStatus:
    | 'not_admitted'
    | 'dispatching'
    | 'dispatched'
    | 'running'
    | 'derivatives_pending'
    | 'completed'
    | 'failed'
    | 'indeterminate',
): ProtectedExecutionStatusProof {
  return {
    status,
    execution_status: executionStatus,
    primary_readback: null,
    derivative_readback: {
      schema_version: 'dataset-derivative-rebuild-batch-status.v1',
      batch_id: REQUEST_ID,
      status: 'not_started',
      proof_level: 'none',
      proof_deferred: false,
      code: 'DERIVATIVE_BATCH_NOT_STARTED',
      causal_terminal_proof: false,
      target_count: 0,
      flow_count: 0,
      process_count: 0,
      completed_count: 0,
      nonterminal_count: 0,
      failed_count: 0,
      invalid_proof_count: null,
      targets: [],
    },
  } as unknown as ProtectedExecutionStatusProof;
}

function verification(status: ProtectedVerificationResult['status']): ProtectedVerificationResult {
  return { status, issues: [], account_readback: null, derivative_readback: null };
}

function preflightFixture(): ProtectedPreflightProof {
  return {
    request_id: REQUEST_ID,
    preflight_token: 'secret-token',
    preflight_proof_sha256: HASH_B,
    completed_at: '2026-07-15T00:00:00.000Z',
    expires_at: '2026-07-15T00:03:00.000Z',
    gate_expectations: {
      primary_support_plan_sha256: HASH_D,
      execution_unused_sha256: HASH_D,
      derivative_quiescence_sha256: HASH_D,
    },
  } as unknown as ProtectedPreflightProof;
}

function gateProof(gate: ProtectedGateProof['gate'], index = 0): ProtectedGateProof {
  return {
    gate,
    receipt_sha256: [HASH_A, HASH_B, HASH_C][index]!,
    result: {
      expected_sha256: HASH_D,
      observed_sha256: HASH_D,
      status: 'passed',
      captured_at: '2026-07-15T00:00:00.000Z',
    },
  } as unknown as ProtectedGateProof;
}

function gateBundle() {
  const proofs = [
    gateProof('primary_support_plan', 0),
    gateProof('execution_unused', 1),
    gateProof('derivative_quiescence', 2),
  ];
  return {
    proofs,
    results: {
      primary_support_plan: proofs[0]!.result,
      execution_unused: proofs[1]!.result,
      derivative_quiescence: proofs[2]!.result,
    },
  };
}

function admissionFixture(): ProtectedAdmissionProof {
  return {
    request_id: REQUEST_ID,
    status: 'dispatched',
    attempt_count: 1,
    dispatch_count: 1,
    retry_allowed: false,
  } as unknown as ProtectedAdmissionProof;
}

test('protected runner validates scalar options and keeps private evidence immutable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-evidence-'));
  try {
    assert.equal(runInternals.normalizeWaitSeconds(), 0);
    assert.equal(runInternals.normalizeWaitSeconds(86_400), 86_400);
    assert.throws(() => runInternals.normalizeWaitSeconds(-1), /waitSeconds/u);
    assert.throws(() => runInternals.normalizeWaitSeconds(1.5), /waitSeconds/u);
    assert.equal(runInternals.normalizePollMs(), 10_000);
    assert.equal(runInternals.normalizePollMs(60_000), 60_000);
    assert.throws(() => runInternals.normalizePollMs(99), /pollMs/u);
    assert.throws(() => runInternals.normalizePollMs(60_001), /pollMs/u);
    assert.equal(
      runInternals.clock(commandFixture(root)).toISOString(),
      '2026-07-15T00:00:00.000Z',
    );
    assert.equal(Number.isFinite(runInternals.clock({} as never).getTime()), true);

    assert.deepEqual(runInternals.errorDetails('plain'), {
      name: 'Error',
      message: 'plain',
      code: null,
    });
    const coded = Object.assign(new Error('coded'), { code: 'CODED' });
    assert.deepEqual(runInternals.errorDetails(coded), {
      name: 'Error',
      message: 'coded',
      code: 'CODED',
    });

    const artifactPath = path.join(root, 'private', 'evidence.json');
    assert.equal(runInternals.writePrivateImmutableJson(artifactPath, { ok: true }), artifactPath);
    assert.equal(runInternals.writePrivateImmutableJson(artifactPath, { ok: true }), artifactPath);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.dirname(artifactPath)).mode & 0o777, 0o700);
      assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
    }
    assert.throws(
      () => runInternals.writePrivateImmutableJson(artifactPath, { ok: false }),
      /Refusing to overwrite/u,
    );
    const logPath = path.join(root, 'private', 'events.jsonl');
    runInternals.appendPrivateJsonLine(logPath, { ordinal: 1 });
    runInternals.appendPrivateJsonLine(logPath, { ordinal: 2 });
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2);

    assert.match(runInternals.nextAttemptReportPath(root), /attempt-0001/u);
    writeFileSync(path.join(root, 'protected-run-report.attempt-0001.json'), '{}');
    assert.match(runInternals.nextAttemptReportPath(root), /attempt-0002/u);
    writeFileSync(path.join(root, 'protected-primary-readback.attempt-0002.json'), '{}');
    assert.match(runInternals.nextAttemptReportPath(root), /attempt-0003/u);

    const source = path.join(root, 'source.json');
    writeFileSync(source, '{"ok":true}\n');
    assert.deepEqual(runInternals.readArtifact({ filePath: source, label: 'source' }), {
      resolved: source,
      value: { ok: true },
      text: '{"ok":true}\n',
      file_sha256: sha256Text('{"ok":true}\n'),
    });
    assert.doesNotThrow(() =>
      runInternals.assertCanonicalParsedArtifact({
        label: 'canonical',
        text: '{"ok":true}\n',
        value: { ok: true },
      }),
    );
    assert.throws(
      () =>
        runInternals.assertCanonicalParsedArtifact({
          label: 'noncanonical',
          text: '{ "ok": true }\n',
          value: { ok: true },
        }),
      /canonical JSON/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected preparation is exact-mode and binds status-only to the frozen approval', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-prepare-'));
  try {
    const invalid = commandFixture(root);
    invalid.statusOnly = false;
    assert.throws(
      () => runInternals.prepareProtectedExecutionWithDependencies(invalid, {} as never),
      /exactly one/u,
    );
    await assert.rejects(() => runDatasetMaintenanceProtected(invalid), /exactly one/u);

    const both = commandFixture(root, true);
    both.statusOnly = true;
    assert.throws(
      () => runInternals.prepareProtectedExecutionWithDependencies(both, {} as never),
      /exactly one/u,
    );
    const missingApproval = commandFixture(root, true);
    missingApproval.approveExecution = 'bad';
    assert.throws(
      () => runInternals.prepareProtectedExecutionWithDependencies(missingApproval, {} as never),
      /exact approval hash/u,
    );

    const status = preparedFixture(path.join(root, 'status'));
    assert.equal(status.approvedHash(), HASH_A);
    assert.equal(status.prepared.identity.request_id, REQUEST_ID);
    assert.match(status.prepared.artifacts.gate_receipts, /protected-gate-receipts/u);

    const commit = preparedFixture(path.join(root, 'commit'), true);
    assert.equal(commit.approvedHash(), HASH_A);
    assert.equal(commit.prepared.planPath, commit.command.planPath);
    const canonicalRead = commit.dependencies.readArtifact;
    assert.throws(
      () =>
        runInternals.prepareProtectedExecutionWithDependencies(commit.command, {
          ...commit.dependencies,
          readArtifact: (input) => {
            const artifact = canonicalRead(input);
            return input.label === 'Protected execution approval'
              ? { ...artifact, text: `${artifact.text} ` }
              : artifact;
          },
        }),
      /canonical JSON/u,
    );
    assert.throws(
      () =>
        runInternals.prepareProtectedExecutionWithDependencies(commit.command, {
          ...commit.dependencies,
          buildIdentity: () => ({ ...commit.identity, project_ref: 'dev-ref' }),
        }),
      /production project/u,
    );

    const historical = preparedFixture(path.join(root, 'historical'));
    historical.plan.plan_sha256 = PROTECTED_PREPARATION_REJECTED_PLAN_SHA256[0];
    const historicalDependencies = {
      readArtifact: ({ label }: { label: string }) => ({
        resolved: historical.command.planPath,
        value: label === 'Maintenance plan' ? historical.plan : {},
        text: `${stableJsonText(label === 'Maintenance plan' ? historical.plan : {})}\n`,
        file_sha256: HASH_A,
      }),
      parsePlan: () => historical.plan,
    } as unknown as Parameters<typeof runInternals.prepareProtectedExecutionWithDependencies>[1];
    assert.throws(
      () =>
        runInternals.prepareProtectedExecutionWithDependencies(
          {
            ...historical.command,
            commit: true,
            statusOnly: false,
            approveExecution: HASH_A,
            confirm: EMAIL,
          },
          historicalDependencies,
        ),
      /historical superseded plan/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected before-state and context checks fail closed on every drift class', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-before-'));
  try {
    const fixture = preparedFixture(root, true);
    const context = contextFixture();
    runInternals.assertContextBindings({
      prepared: fixture.prepared,
      context,
      confirm: EMAIL,
      commit: true,
    });
    assert.throws(
      () =>
        runInternals.assertContextBindings({
          prepared: fixture.prepared,
          context: { ...context, project_ref: 'foreign' },
          confirm: EMAIL,
          commit: true,
        }),
      /does not match/u,
    );
    runInternals.assertStrictBeforeState({
      prepared: fixture.prepared,
      currentRows: fixture.rows,
      completeness: fixture.plan.snapshot_completeness,
    });
    assert.deepEqual(
      runInternals
        .projectedRows({
          plan: fixture.plan,
          planDir: fixture.prepared.planDir,
          currentRows: fixture.rows,
        })
        .find((entry: DatasetMaintenanceRemoteRow) => entry.id === FLOW_ID)?.json_ordered,
      fixture.desired,
    );

    const check = (mutate: (copy: typeof fixture) => void, pattern: RegExp) => {
      const plan = structuredClone(fixture.plan);
      const copy = {
        ...fixture,
        plan,
        rows: structuredClone(fixture.rows),
        prepared: { ...fixture.prepared, plan },
      };
      mutate(copy);
      assert.throws(
        () =>
          runInternals.assertStrictBeforeState({
            prepared: copy.prepared,
            currentRows: copy.rows,
            completeness: copy.plan.snapshot_completeness,
          }),
        pattern,
      );
    };
    check((copy) => {
      copy.plan.snapshot_completeness = undefined;
    }, /complete snapshot/u);
    check((copy) => {
      copy.plan.visible_snapshot_sha256 = HASH_D;
    }, /visible snapshot drifted/u);
    check((copy) => {
      copy.rows.pop();
      copy.plan.visible_snapshot_sha256 = sha256Json(
        copy.rows
          .map(snapshotRemoteRow)
          .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right))),
      );
      copy.plan.snapshot_completeness = completeness(copy.rows);
    }, /missing or unexpected/u);
    check((copy) => {
      copy.rows[1]!.json_ordered = { drift: true };
      copy.plan.visible_snapshot_sha256 = sha256Json(
        copy.rows
          .map(snapshotRemoteRow)
          .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right))),
      );
    }, /Protected row drifted/u);
    check((copy) => {
      copy.rows[0]!.user_id = 'foreign';
      copy.plan.visible_snapshot_sha256 = sha256Json(
        copy.rows
          .map(snapshotRemoteRow)
          .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right))),
      );
    }, /missing or unexpected/u);
    check((copy) => {
      copy.plan.projected_reference_sha256 = HASH_D;
    }, /reference closure drifted/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('support and derivative baseline preflight checks compare exact owner-draft snapshots', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-support-'));
  try {
    const fixture = preparedFixture(root, true);
    const supportRows = [
      row({ table: 'unitgroups', id: '44444444-4444-4444-8444-444444444444', payload: {} }),
      row({ table: 'flowproperties', id: '55555555-5555-4555-8555-555555555555', payload: {} }),
      row({ table: 'unitgroups', id: '66666666-6666-4666-8666-666666666666', payload: {} }),
    ];
    const snapshots = supportRows.map(snapshotRemoteRow);
    fixture.plan.alias_batches = [
      {
        batch_id: 'time',
        target_snapshots: {
          unitgroup: snapshots[0],
          flowproperty: snapshots[1],
          source_unitgroup: snapshots[2],
        },
      },
    ] as never;
    const supportFetch: FetchLike = async (input) => {
      const url = new URL(input);
      const table = url.pathname.split('/').at(-1);
      const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
      const found = supportRows.find((entry) => entry.table === table && entry.id === id);
      return jsonResponse(found ? [found] : []);
    };
    await runInternals.assertSupportSnapshots({
      prepared: fixture.prepared,
      context: contextFixture(supportFetch),
    });
    const missing = structuredClone(fixture.prepared);
    missing.plan.alias_batches![0]!.target_snapshots.unitgroup = null;
    await assert.rejects(
      () => runInternals.assertSupportSnapshots({ prepared: missing, context: contextFixture() }),
      /snapshot is absent/u,
    );
    await assert.rejects(
      () =>
        runInternals.assertSupportSnapshots({
          prepared: fixture.prepared,
          context: contextFixture(async () => jsonResponse([])),
        }),
      /support row drifted/u,
    );
    const noBatches = structuredClone(fixture.prepared);
    noBatches.plan.alias_batches = undefined;
    await runInternals.assertSupportSnapshots({
      prepared: noBatches,
      context: contextFixture(),
    });

    fixture.identity.derivative_targets = Array.from({ length: 50 }, (_, index) => ({
      table: index < 23 ? ('flows' as const) : ('processes' as const),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: HASH_C,
    }));
    const derivativeContext = contextFixture(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        ok: true,
        command: 'cmd_dataset_derivative_rebuild_snapshot',
        schema_version: 'dataset-derivative-snapshot.v1',
        table: request.p_table,
        id: request.p_id,
        version: request.p_version,
        user_id: USER_ID,
        state_code: 0,
        modified_at: '2026-07-15T00:00:00.000Z',
        json_sha256: HASH_A,
        json_ordered_sha256: HASH_A,
        extracted_md_sha256: null,
        embedding_ft_sha256: null,
        embedding_ft_at: null,
        snapshot_sha256: HASH_C,
      });
    });
    await runInternals.assertDerivativeBaselines({
      prepared: fixture.prepared,
      context: derivativeContext,
    });
    fixture.identity.derivative_targets[0]!.baseline_snapshot_sha256 = HASH_D;
    await assert.rejects(
      () =>
        runInternals.assertDerivativeBaselines({
          prepared: fixture.prepared,
          context: derivativeContext,
        }),
      /baseline drifted/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate receipts persist incrementally and submission markers are immutable one-shot evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-gates-'));
  try {
    const fixture = preparedFixture(root, true);
    const captured: string[] = [];
    const appended: JsonObject[] = [];
    const gates = await runInternals.captureProtectedGatesWithDependencies(
      {
        prepared: fixture.prepared,
        context: contextFixture(),
        preflight: preflightFixture(),
        receiptPath: fixture.prepared.artifacts.gate_receipts,
      },
      {
        captureGate: async ({ gateName }: { gateName: string }) => {
          captured.push(gateName);
          return { gate: gateName };
        },
        parseGate: (_raw: unknown, options: { gate: ProtectedGateProof['gate'] }) =>
          gateProof(options.gate, captured.length - 1),
        appendReceipt: (_file: string, value: JsonObject) => {
          appended.push(value);
          return _file;
        },
        nowIso: () => '2026-07-15T00:00:00.000Z',
      } as never,
    );
    assert.deepEqual(captured, [
      'primary_support_plan',
      'execution_unused',
      'derivative_quiescence',
    ]);
    assert.equal(appended.length, 3);
    assert.equal(gates.proofs.length, 3);

    const rpcContext = contextFixture(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { p_gate_name: ProtectedGateProof['gate'] };
      return jsonResponse({
        ok: true,
        schema_version: PROTECTED_EXECUTION_CONTRACT.gate_response_schema,
        command: PROTECTED_EXECUTION_CONTRACT.gate_command,
        request_id: REQUEST_ID,
        actor_user_id: USER_ID,
        preflight_proof_sha256: HASH_B,
        gate: body.p_gate_name,
        status: 'passed',
        expected_sha256: HASH_D,
        observed_sha256: HASH_D,
        captured_at: '2026-07-15T00:01:00.000Z',
        receipt_sha256:
          body.p_gate_name === 'primary_support_plan'
            ? HASH_A
            : body.p_gate_name === 'execution_unused'
              ? HASH_B
              : HASH_C,
      });
    });
    const defaultGates = await runInternals.captureProtectedGates({
      prepared: fixture.prepared,
      context: rpcContext,
      preflight: preflightFixture(),
      receiptPath: path.join(root, 'default-gates.jsonl'),
    });
    assert.equal(defaultGates.proofs.length, 3);

    let attempts = 0;
    const persisted: JsonObject[] = [];
    await assert.rejects(
      () =>
        runInternals.captureProtectedGatesWithDependencies(
          {
            prepared: fixture.prepared,
            context: contextFixture(),
            preflight: preflightFixture(),
            receiptPath: fixture.prepared.artifacts.gate_receipts,
          },
          {
            captureGate: async () => {
              attempts += 1;
              if (attempts === 3) throw new Error('gate failed');
              return {};
            },
            parseGate: (_raw: unknown, options: { gate: ProtectedGateProof['gate'] }) =>
              gateProof(options.gate, attempts - 1),
            appendReceipt: (_file: string, value: JsonObject) => {
              persisted.push(value);
              return _file;
            },
            nowIso: () => '2026-07-15T00:00:00.000Z',
          } as never,
        ),
      /gate failed/u,
    );
    assert.equal(persisted.length, 2);

    const marker = fixture.prepared.artifacts.submission_attempt;
    assert.equal(runInternals.validateExistingMarker(marker, fixture.identity), null);
    runInternals.writePrivateImmutableJson(marker, {
      schema_version: PROTECTED_EXECUTION_CONTRACT.marker_schema,
      request_id: REQUEST_ID,
      identity_sha256: HASH_B,
      plan_sha256: HASH_A,
      operation_id: fixture.plan.operation_id,
      max_admit_posts: 1,
      automatic_retry: false,
    });
    assert.equal(
      runInternals.validateExistingMarker(marker, fixture.identity)?.request_id,
      REQUEST_ID,
    );
    const foreign = path.join(root, 'foreign-marker.json');
    writeFileSync(foreign, '{}');
    assert.throws(
      () => runInternals.validateExistingMarker(foreign, fixture.identity),
      /malformed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status reads retry only read failures inside the wait window and never retry admission', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-read-'));
  try {
    const fixture = preparedFixture(root);
    let now = 0;
    let reads = 0;
    let sleeps = 0;
    const command = { ...fixture.command, waitSeconds: 1, sleep: async () => void (sleeps += 1) };
    const proof = statusProof('passed', 'completed');
    const recovered = await runInternals.readAndVerifyWithDependencies(
      { command, prepared: fixture.prepared, context: contextFixture() },
      {
        readExecution: async () => {
          reads += 1;
          if (reads === 1) throw Object.assign(new Error('lock busy'), { code: 'LOCK_BUSY' });
          return { status: 'passed' };
        },
        parseStatus: () => proof,
        verifyExecution: async () => verification('passed'),
        nowMs: () => {
          now += 600;
          return now;
        },
      } as never,
    );
    assert.equal(recovered.verification.status, 'passed');
    assert.equal(reads, 2);
    assert.equal(sleeps, 1);
    assert.match(readFileSync(fixture.prepared.artifacts.status_progress, 'utf8'), /read_error/u);

    const exhausted = preparedFixture(path.join(root, 'exhausted'));
    const unavailable = await runInternals.readAndVerifyWithDependencies(
      { command: exhausted.command, prepared: exhausted.prepared, context: contextFixture() },
      {
        readExecution: async () => {
          throw 'offline';
        },
        parseStatus: () => proof,
        verifyExecution: async () => verification('passed'),
        nowMs: () => 0,
      } as never,
    );
    assert.equal(unavailable.verification.status, 'indeterminate');
    assert.equal(unavailable.proof, null);

    const defaultRead = preparedFixture(path.join(root, 'default-read'));
    const defaultUnavailable = await runInternals.readAndVerify({
      command: defaultRead.command,
      prepared: defaultRead.prepared,
      context: contextFixture(async () => {
        throw new Error('read offline');
      }),
    });
    assert.equal(defaultUnavailable.verification.status, 'indeterminate');

    const pendingFixture = preparedFixture(path.join(root, 'pending'));
    let pendingReads = 0;
    let pendingNow = 0;
    const pending = await runInternals.readAndVerifyWithDependencies(
      {
        command: {
          ...pendingFixture.command,
          waitSeconds: 1,
          sleep: async () => undefined,
        },
        prepared: pendingFixture.prepared,
        context: contextFixture(),
      },
      {
        readExecution: async () => ({ ordinal: ++pendingReads }),
        parseStatus: () =>
          pendingReads === 1
            ? statusProof('pending', 'running')
            : statusProof('passed', 'completed'),
        verifyExecution: async ({ proof }: { proof: ProtectedExecutionStatusProof }) =>
          verification(proof.status),
        nowMs: () => {
          pendingNow += 400;
          return pendingNow;
        },
      } as never,
    );
    assert.equal(pending.verification.status, 'passed');
    assert.equal(pendingReads, 2);

    const admissionVisibility = preparedFixture(path.join(root, 'admission-visibility'));
    let visibilityReads = 0;
    let visibilityNow = 0;
    let visibilityVerifies = 0;
    const visible = await runInternals.readAndVerifyWithDependencies(
      {
        command: {
          ...admissionVisibility.command,
          waitSeconds: 1,
          sleep: async () => undefined,
        },
        prepared: admissionVisibility.prepared,
        context: contextFixture(),
      },
      {
        readExecution: async () => ({ ordinal: ++visibilityReads }),
        parseStatus: () =>
          visibilityReads === 1
            ? statusProof('indeterminate', 'not_admitted')
            : statusProof('passed', 'completed'),
        verifyExecution: async () => {
          visibilityVerifies += 1;
          return verification('passed');
        },
        nowMs: () => {
          visibilityNow += 100;
          return visibilityNow;
        },
      } as never,
    );
    assert.equal(visible.verification.status, 'passed');
    assert.equal(visibilityReads, 2);
    assert.equal(visibilityVerifies, 1);

    const defaultSleep = preparedFixture(path.join(root, 'default-sleep'));
    let defaultSleepReads = 0;
    let defaultSleepNow = 0;
    const defaultSleepResult = await runInternals.readAndVerifyWithDependencies(
      {
        command: { ...defaultSleep.command, waitSeconds: 1 },
        prepared: defaultSleep.prepared,
        context: contextFixture(),
      },
      {
        readExecution: async () => ({ ordinal: ++defaultSleepReads }),
        parseStatus: () =>
          defaultSleepReads === 1
            ? statusProof('pending', 'running')
            : statusProof('passed', 'completed'),
        verifyExecution: async () => verification('passed'),
        nowMs: () => {
          defaultSleepNow += 100;
          return defaultSleepNow;
        },
      } as never,
    );
    assert.equal(defaultSleepResult.verification.status, 'passed');

    const readbackRecovery = preparedFixture(path.join(root, 'readback-recovery'));
    let readbackAttempts = 0;
    let readbackNow = 0;
    const recoveredReadback = await runInternals.readAndVerifyWithDependencies(
      {
        command: {
          ...readbackRecovery.command,
          waitSeconds: 1,
          sleep: async () => undefined,
        },
        prepared: readbackRecovery.prepared,
        context: contextFixture(),
      },
      {
        readExecution: async () => ({}),
        parseStatus: () => proof,
        verifyExecution: async () => {
          readbackAttempts += 1;
          if (readbackAttempts === 1) throw new Error('temporary RLS readback outage');
          return verification('passed');
        },
        nowMs: () => {
          readbackNow += 100;
          return readbackNow;
        },
      } as never,
    );
    assert.equal(recoveredReadback.verification.status, 'passed');
    assert.equal(readbackAttempts, 2);
    assert.match(
      readFileSync(readbackRecovery.prepared.artifacts.status_progress, 'utf8'),
      /verification_error/u,
    );

    const terminalFailure = preparedFixture(path.join(root, 'terminal-read-failure'));
    const indeterminate = await runInternals.readAndVerifyWithDependencies(
      {
        command: terminalFailure.command,
        prepared: terminalFailure.prepared,
        context: contextFixture(),
      },
      {
        readExecution: async () => ({}),
        parseStatus: () => proof,
        verifyExecution: async () => {
          throw new Error('RLS unavailable');
        },
        nowMs: () => 0,
      } as never,
    );
    assert.equal(
      indeterminate.verification.issues[0]?.code,
      'PROTECTED_TERMINAL_READBACK_UNAVAILABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report persistence defers the canonical terminal file only for retryable readback outages', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-persist-'));
  try {
    const fixture = preparedFixture(root);
    const proof = {
      ...statusProof('passed', 'completed'),
      primary_readback: { closure: true },
    } as unknown as ProtectedExecutionStatusProof;
    const accountRows = fixture.rows;
    const derivativeSnapshot = { table: 'flows' } as unknown as ProtectedDerivativeSnapshot;
    const fullVerification: ProtectedVerificationResult = {
      status: 'passed',
      issues: [],
      account_readback: { rows: accountRows, source_urls: [], completeness: {} },
      derivative_readback: { rows: [], snapshots: [derivativeSnapshot], source_urls: [] },
    };
    const report = runInternals.buildReport({
      command: fixture.command,
      prepared: fixture.prepared,
      admission: null,
      proof,
      verification: fullVerification,
    });
    runInternals.persistVerificationArtifacts({
      prepared: fixture.prepared,
      proof,
      verification: fullVerification,
      report,
    });
    assert.equal(existsSync(fixture.prepared.artifacts.audit_readback), true);
    assert.equal(existsSync(fixture.prepared.artifacts.primary_readback), true);
    assert.equal(existsSync(fixture.prepared.artifacts.reference_readback), true);
    assert.equal(existsSync(fixture.prepared.artifacts.derivative_readback), true);
    assert.equal(existsSync(fixture.prepared.artifacts.terminal_report), true);
    assert.equal(report.mode, 'status_only');

    const retryable = preparedFixture(path.join(root, 'retryable'));
    const retryVerification: ProtectedVerificationResult = {
      status: 'indeterminate',
      issues: [
        {
          code: 'PROTECTED_TERMINAL_READBACK_UNAVAILABLE',
          message: 'retry status read',
        },
      ],
      account_readback: null,
      derivative_readback: null,
    };
    const retryReport = runInternals.buildReport({
      command: retryable.command,
      prepared: retryable.prepared,
      admission: null,
      proof,
      verification: retryVerification,
    });
    runInternals.persistVerificationArtifacts({
      prepared: retryable.prepared,
      proof,
      verification: retryVerification,
      report: retryReport,
    });
    assert.equal(existsSync(retryable.prepared.artifacts.terminal_report), false);
    assert.equal(existsSync(retryable.prepared.artifacts.attempt_report), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runtimeDependencies(options: {
  context?: DatasetMaintenanceRemoteContext;
  rows?: DatasetMaintenanceRemoteRow[];
  completeness?: unknown;
  readback?: {
    proof: ProtectedExecutionStatusProof | null;
    verification: ProtectedVerificationResult;
  };
  admissionError?: Error;
  preflightParseError?: Error;
  counters: Record<string, number>;
}) {
  const bump = (name: string) => {
    options.counters[name] = (options.counters[name] ?? 0) + 1;
  };
  const preflight = preflightFixture();
  return {
    withStateLock: async (_path: string, _metadata: unknown, callback: () => Promise<unknown>) =>
      callback(),
    resolveContext: async () => options.context ?? contextFixture(),
    fetchAccountRows: async () => {
      bump('fetch');
      return {
        rows: options.rows ?? [],
        source_urls: [],
        completeness: options.completeness,
      };
    },
    assertSupport: async () => bump('support'),
    assertBaselines: async () => bump('baseline'),
    buildPreflightRequest: () => {
      bump('build_preflight');
      return { request: true };
    },
    preflightExecution: async () => {
      bump('preflight');
      return { raw: 'preflight' };
    },
    parsePreflight: () => {
      if (options.preflightParseError) throw options.preflightParseError;
      return preflight;
    },
    captureGates: async () => {
      bump('gates');
      return gateBundle();
    },
    buildAdmitRequest: () => ({ admit: true }),
    admitExecution: async () => {
      bump('admit');
      if (options.admissionError) throw options.admissionError;
      return { raw: 'admission' };
    },
    parseAdmission: () => admissionFixture(),
    readAndVerify: async () => {
      bump('read');
      return (
        options.readback ?? {
          proof: statusProof('pending', 'running'),
          verification: verification('pending'),
        }
      );
    },
  } as unknown as Parameters<typeof runInternals.runPreparedProtectedExecution>[2];
}

test('status-only core performs no preflight, gate, admission, or mutation prechecks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-status-only-'));
  try {
    const fixture = preparedFixture(root);
    const counters: Record<string, number> = {};
    const report = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({ counters }),
    );
    assert.equal(report.status, 'pending');
    assert.equal(counters.read, 1);
    for (const forbidden of ['fetch', 'support', 'baseline', 'preflight', 'gates', 'admit']) {
      assert.equal(counters[forbidden] ?? 0, 0, forbidden);
    }
    assert.equal(existsSync(fixture.prepared.artifacts.execution_seal), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('protected alias language admission stops before a seal or remote work and leaves status recovery available', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-language-'));
  try {
    const fixture = preparedFixture(root, true);
    fixture.prepared.aliasPlanRequest = {
      batches: [
        {
          actions: [
            {
              desired_json_ordered: {
                comment: [
                  { '@xml:lang': 'en', '#text': 'First.' },
                  { '@xml:lang': 'en', '#text': 'Second.' },
                ],
              },
            },
          ],
        },
      ],
    };
    const bytes = JSON.stringify(fixture.prepared.aliasPlanRequest);
    const counters: Record<string, number> = {};
    await assert.rejects(
      runInternals.runPreparedProtectedExecution(
        fixture.command,
        fixture.prepared,
        runtimeDependencies({
          counters,
          rows: fixture.rows,
          completeness: completeness(fixture.rows),
        }),
      ),
      { code: 'DATASET_DUPLICATE_LANGUAGE' },
    );
    assert.deepEqual(counters, {});
    assert.equal(existsSync(fixture.prepared.artifacts.execution_seal), false);
    assert.equal(existsSync(fixture.prepared.artifacts.submission_attempt), false);
    assert.equal(JSON.stringify(fixture.prepared.aliasPlanRequest), bytes);
    const recovered = await runInternals.runPreparedProtectedExecution(
      { ...fixture.command, commit: false, statusOnly: true },
      fixture.prepared,
      runtimeDependencies({ counters }),
    );
    assert.equal(recovered.status, 'pending');
    assert.deepEqual(counters, { read: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-directory pending to terminal recovery uses per-attempt readbacks and an idempotent canonical terminal', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-recovery-artifacts-'));
  try {
    const fixture = preparedFixture(root);
    const pendingProof = {
      ...statusProof('pending', 'running'),
      primary_readback: { stage: 'pending' },
    } as unknown as ProtectedExecutionStatusProof;
    const terminalProof = {
      ...statusProof('passed', 'completed'),
      primary_readback: { stage: 'terminal' },
    } as unknown as ProtectedExecutionStatusProof;
    const pendingVerification: ProtectedVerificationResult = {
      status: 'pending',
      issues: [],
      account_readback: { rows: fixture.rows, source_urls: [], completeness: {} },
      derivative_readback: null,
    };
    const terminalVerification: ProtectedVerificationResult = {
      status: 'passed',
      issues: [],
      account_readback: { rows: fixture.rows, source_urls: [], completeness: {} },
      derivative_readback: { rows: [], snapshots: [], source_urls: [] },
    };
    const pending = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({
        counters: {},
        readback: { proof: pendingProof, verification: pendingVerification },
      }),
    );
    const terminal = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({
        counters: {},
        readback: { proof: terminalProof, verification: terminalVerification },
      }),
    );
    const terminalAgain = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({
        counters: {},
        readback: { proof: terminalProof, verification: terminalVerification },
      }),
    );
    assert.match(pending.artifacts.attempt_report, /attempt-0001/u);
    assert.match(terminal.artifacts.attempt_report, /attempt-0002/u);
    assert.match(terminalAgain.artifacts.attempt_report, /attempt-0003/u);
    assert.notEqual(pending.artifacts.primary_readback, terminal.artifacts.primary_readback);
    assert.equal(terminal.artifacts.terminal_report, terminalAgain.artifacts.terminal_report);
    assert.equal(existsSync(terminal.artifacts.terminal_report), true);
    const canonical = JSON.parse(
      readFileSync(terminal.artifacts.terminal_report, 'utf8'),
    ) as JsonObject;
    assert.equal(canonical.artifact_kind, 'protected_terminal_canonical');
    assert.equal('generated_at_utc' in canonical, false);
    assert.equal('artifacts' in canonical, false);

    const canonicalBeforeDrift = readFileSync(terminal.artifacts.terminal_report, 'utf8');
    const driftProof = {
      ...terminalProof,
      status: 'failed',
      execution_status: 'completed',
    } as ProtectedExecutionStatusProof;
    const driftVerification: ProtectedVerificationResult = {
      status: 'failed',
      issues: [{ code: 'PROTECTED_DERIVATIVE_LIVE_MISMATCH', message: 'later live drift' }],
      account_readback: null,
      derivative_readback: null,
    };
    const drift = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({
        counters: {},
        readback: { proof: driftProof, verification: driftVerification },
      }),
    );
    assert.match(drift.artifacts.attempt_report, /attempt-0004/u);
    assert.equal(existsSync(drift.artifacts.attempt_report), true);
    assert.equal(readFileSync(terminal.artifacts.terminal_report, 'utf8'), canonicalBeforeDrift);

    const notAdmitted = preparedFixture(path.join(root, 'not-admitted'));
    const notAdmittedReport = await runInternals.runPreparedProtectedExecution(
      notAdmitted.command,
      notAdmitted.prepared,
      runtimeDependencies({
        counters: {},
        readback: {
          proof: statusProof('indeterminate', 'not_admitted'),
          verification: {
            status: 'indeterminate',
            issues: [{ code: 'PROTECTED_EXECUTION_NOT_FOUND', message: 'not visible yet' }],
            account_readback: null,
            derivative_readback: null,
          },
        },
      }),
    );
    assert.equal(existsSync(notAdmittedReport.artifacts.terminal_report), false);
    assert.equal(existsSync(notAdmittedReport.artifacts.attempt_report), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit core writes one-shot evidence and treats admission exceptions as consumed without retry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-commit-'));
  try {
    const fixture = preparedFixture(path.join(root, 'success'), true);
    const counters: Record<string, number> = {};
    const report = await runInternals.runPreparedProtectedExecution(
      fixture.command,
      fixture.prepared,
      runtimeDependencies({
        counters,
        rows: fixture.rows,
        completeness: fixture.plan.snapshot_completeness,
      }),
    );
    assert.equal(report.admission?.status, 'dispatched');
    assert.equal(counters.admit, 1);
    assert.equal(counters.read, 1);
    assert.equal(existsSync(fixture.prepared.artifacts.preflight_evidence), true);
    assert.equal(existsSync(fixture.prepared.artifacts.submission_attempt), true);
    assert.equal(existsSync(fixture.prepared.artifacts.admission_response), true);

    await assert.rejects(
      () =>
        runInternals.runPreparedProtectedExecution(
          fixture.command,
          fixture.prepared,
          runtimeDependencies({ counters }),
        ),
      /marker already exists/u,
    );

    const ambiguous = preparedFixture(path.join(root, 'ambiguous'), true);
    const ambiguousCounters: Record<string, number> = {};
    const ambiguousReport = await runInternals.runPreparedProtectedExecution(
      ambiguous.command,
      ambiguous.prepared,
      runtimeDependencies({
        counters: ambiguousCounters,
        rows: ambiguous.rows,
        completeness: ambiguous.plan.snapshot_completeness,
        admissionError: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
      }),
    );
    assert.equal(ambiguousReport.admission, null);
    assert.equal(ambiguousCounters.admit, 1);
    assert.equal(ambiguousCounters.read, 1);
    assert.equal(existsSync(ambiguous.prepared.artifacts.admission_transport_error), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commit core stops before gates, marker, and admission when preflight proof parsing fails', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-protected-preflight-rejected-'));
  try {
    const fixture = preparedFixture(root, true);
    const counters: Record<string, number> = {};
    await assert.rejects(
      () =>
        runInternals.runPreparedProtectedExecution(
          fixture.command,
          fixture.prepared,
          runtimeDependencies({
            counters,
            rows: fixture.rows,
            completeness: fixture.plan.snapshot_completeness,
            preflightParseError: new Error('future-issued proof rejected'),
          }),
        ),
      /future-issued proof rejected/u,
    );
    assert.equal(counters.preflight, 1);
    assert.equal(counters.gates ?? 0, 0);
    assert.equal(counters.admit ?? 0, 0);
    assert.equal(counters.read ?? 0, 0);
    assert.equal(existsSync(fixture.prepared.artifacts.execution_seal), true);
    assert.equal(existsSync(fixture.prepared.artifacts.preflight_evidence), false);
    assert.equal(existsSync(fixture.prepared.artifacts.submission_attempt), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
