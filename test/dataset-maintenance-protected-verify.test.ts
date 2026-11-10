import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { maintenanceRowKey, snapshotRemoteRow } from '../src/lib/maintenance/contract/values.js';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import {
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import { maintenanceProjectedReferenceFingerprint } from '../src/lib/dataset-maintenance-plan.js';
import {
  PROTECTED_EXECUTION_CONTRACT,
  PROTECTED_EXECUTION_COUNTS,
  type ProtectedDerivativeSnapshot,
  type ProtectedDerivativeTarget,
  type ProtectedExecutionIdentity,
  type ProtectedExecutionStatusProof,
  type ProtectedTerminalTargetProof,
} from '../src/lib/dataset-maintenance-protected-contract.js';
import {
  __testInternals,
  inspectProtectedLiveDerivative,
  verifyProtectedExecution,
  type ProtectedLiveDerivativeReadback,
} from '../src/lib/dataset-maintenance-protected-verify.js';
import type {
  DatasetMaintenanceDerivativeRemoteRow,
  DatasetMaintenanceRemoteContext,
} from '../src/lib/dataset-maintenance-remote.js';
import type { FetchLike } from '../src/lib/http.js';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'bafudata@126.com';
const VERSION = '00.00.001';
const MODIFIED_AT = '2026-07-15T00:00:00.000Z';
const EMBEDDING_FT_AT = '2026-07-15T00:02:00.000Z';
const PRE_SNAPSHOT_SHA256 = 'a'.repeat(64);
const EXPECTED_SNAPSHOT_SHA256 = 'b'.repeat(64);
const COMPLETED_SNAPSHOT_SHA256 = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);

type Scenario = ReturnType<typeof scenario>;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function derivativeTargets(): ProtectedDerivativeTarget[] {
  return [
    ...Array.from({ length: 23 }, (_, index) => ({
      table: 'flows' as const,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: PRE_SNAPSHOT_SHA256,
    })),
    ...Array.from({ length: 27 }, (_, index) => ({
      table: 'processes' as const,
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0 as const,
      baseline_snapshot_sha256: PRE_SNAPSHOT_SHA256,
    })),
  ];
}

function protectedActionTargets(targets: ProtectedDerivativeTarget[]) {
  return [
    {
      table: 'flowproperties' as const,
      id: '44444444-4444-4444-8444-444444444441',
      version: VERSION,
    },
    {
      table: 'flowproperties' as const,
      id: '44444444-4444-4444-8444-444444444442',
      version: VERSION,
    },
    ...targets.map(({ table, id, version }) => ({ table, id, version })),
  ];
}

function databaseJsonbHash(target: { table: string; id: string; version: string }): string {
  return sha256Json({
    hash_domain: 'postgres_jsonb_text',
    table: target.table,
    id: target.id,
    version: target.version,
  });
}

function primaryActionEvidence(executionIdentity: ProtectedExecutionIdentity): JsonObject[] {
  return protectedActionTargets(executionIdentity.derivative_targets).map((target, index) => {
    const databaseHash = databaseJsonbHash(target);
    return {
      batch_ordinality: index < 2 ? 1 : 2,
      action_ordinality: index + 1,
      dimension: index < 2 ? 'time' : 'length_time',
      action_id: `action-${String(index + 1).padStart(2, '0')}`,
      table: target.table,
      id: target.id,
      version: target.version,
      row_found: true,
      owner_matches: true,
      state_code_matches: true,
      json_matches: true,
      json_ordered_matches: true,
      desired_json_ordered_sha256: databaseHash,
      live_json_sha256: databaseHash,
      live_json_ordered_sha256: databaseHash,
      valid: true,
    };
  });
}

function identity(targets = derivativeTargets()): ProtectedExecutionIdentity {
  return {
    request_id: '33333333-3333-4333-8333-333333333333',
    identity_sha256: HASH_D,
    environment: 'production',
    project_ref: 'qgzvkongdjqiiamzbbts',
    actor: { user_id: USER_ID, email: EMAIL },
    target_visibility: 'owner_draft',
    plan_sha256: HASH_E,
    operation_id: 'bafu-private-step-2-owner-draft',
    bindings: {
      plan_file_sha256: HASH_D,
      freeze_file_sha256: HASH_D,
      freeze_sha256: HASH_D,
      approval_file_sha256: HASH_D,
      approval_identity_sha256: HASH_D,
      approval_text_sha256: HASH_D,
      alias_plan_request_sha256: HASH_D,
      before_hash_set_sha256: HASH_D,
      desired_hash_set_sha256: HASH_D,
      exchange_rewrite_set_sha256: HASH_D,
      support_snapshot_set_sha256: HASH_D,
      derivative_baseline_set_sha256: HASH_D,
      derivative_target_set_sha256: HASH_D,
      toolchain_evidence_sha256: HASH_D,
    },
    expected: PROTECTED_EXECUTION_COUNTS,
    derivative_targets: targets,
  };
}

function rowFor(
  table: 'flowproperties' | 'flows' | 'processes',
  id: string,
  jsonOrdered: JsonObject,
): DatasetMaintenanceRemoteRow {
  return {
    table,
    id,
    version: VERSION,
    user_id: USER_ID,
    state_code: 0,
    modified_at: MODIFIED_AT,
    json_ordered: jsonOrdered,
    model_id: table === 'processes' ? `model-${id}` : null,
    rule_verification: table === 'processes',
  };
}

function completeness(rows: DatasetMaintenanceRemoteRow[]) {
  const tables = [
    'contacts',
    'sources',
    'flows',
    'processes',
    'lifecyclemodels',
    'unitgroups',
    'flowproperties',
  ] as const;
  const entityCounts = Object.fromEntries(
    tables.map((table) => [table, rows.filter((row) => row.table === table).length]),
  ) as Record<(typeof tables)[number], number>;
  return {
    status: 'complete' as const,
    complete: true as const,
    strategy: 'postgrest_exact_count_multi_request' as const,
    requested_page_size: 100,
    page_count: tables.length,
    row_count: rows.length,
    entity_counts: entityCounts,
    tables: tables.map((table) => {
      const count = entityCounts[table];
      return {
        table,
        status: 'complete' as const,
        complete: true as const,
        strategy: 'postgrest_exact_count' as const,
        requested_page_size: 100,
        effective_page_size: count,
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

function scenario() {
  const planDir = mkdtempSync(path.join(os.tmpdir(), 'protected-verify-'));
  mkdirSync(path.join(planDir, 'payloads'));
  const targets = derivativeTargets();
  const actionTargets = protectedActionTargets(targets);
  const beforeRows: DatasetMaintenanceRemoteRow[] = [];
  const finalRows: DatasetMaintenanceRemoteRow[] = [];
  const actions = actionTargets.map((target, index) => {
    const beforePayload = { id: target.id, version: VERSION, stage: 'before' };
    const desiredPayload = { id: target.id, version: VERSION, stage: 'desired' };
    const before = rowFor(target.table, target.id, beforePayload);
    const final = rowFor(target.table, target.id, desiredPayload);
    beforeRows.push(before);
    finalRows.push(final);
    const payloadPath = `payloads/${String(index + 1).padStart(2, '0')}.json`;
    writeFileSync(path.join(planDir, payloadPath), `${JSON.stringify(desiredPayload)}\n`);
    return {
      action_id: `action-${String(index + 1).padStart(2, '0')}`,
      action: 'update_json_ordered' as const,
      table: target.table,
      id: target.id,
      version: VERSION,
      expected_user_id: USER_ID,
      expected_state_code: 0 as const,
      reason_code: 'BAFU_STEP_2',
      reason: 'protected verification fixture',
      evidence: [],
      ordinal: index + 1,
      status: 'ready' as const,
      before: snapshotRemoteRow(before),
      desired_payload: { path: payloadPath, sha256: sha256Json(desiredPayload) },
      blockers: [],
      rollback: {
        strategy: 'restore_atomic_alias_before_snapshot' as const,
        before_payload_sha256: sha256Json(beforePayload),
        before_payload: beforePayload,
        model_id: before.model_id,
        rule_verification: before.rule_verification,
      },
    };
  });
  const plan: DatasetMaintenancePlan = {
    schema_version: 1,
    generated_at_utc: MODIFIED_AT,
    task_id: 'bafu-private-step-2',
    operation: 'merge-support-aliases',
    operation_id: 'bafu-private-step-2-owner-draft',
    account: { user_id: USER_ID, email: EMAIL },
    source_import_run_id: null,
    source_lineage: null,
    target_mode: 'owner_draft',
    status: 'ready',
    scope_sha256: HASH_D,
    visible_snapshot_sha256: HASH_D,
    snapshot_completeness: completeness(finalRows),
    projected_reference_sha256: sha256Json(maintenanceProjectedReferenceFingerprint(finalRows)),
    plan_sha256: HASH_E,
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
      maintenance_scope: 'scope.json',
      rls_visible_snapshot: 'snapshot.json',
      protected_rows: 'protected.json',
      reference_impact_report: 'references.json',
      maintenance_plan: 'plan.json',
      dry_run_report: 'dry-run.json',
      payload_dir: 'payloads',
    },
    actions,
    protected_rows: [],
    blockers: [],
  };
  return {
    planDir,
    plan,
    beforeRows,
    finalRows,
    identity: identity(targets),
    cleanup: () => rmSync(planDir, { recursive: true, force: true }),
  };
}

function gateReceipts(): ProtectedExecutionStatusProof['gates'] {
  return [
    ['primary_support_plan', PRE_SNAPSHOT_SHA256, HASH_D],
    ['execution_unused', EXPECTED_SNAPSHOT_SHA256, HASH_E],
    ['derivative_quiescence', COMPLETED_SNAPSHOT_SHA256, HASH_F],
  ].map(([gate, expected, receipt]) => ({
    gate: gate as ProtectedExecutionStatusProof['gates'][number]['gate'],
    expected_sha256: expected!,
    observed_sha256: expected!,
    status: 'passed' as const,
    captured_at: MODIFIED_AT,
    receipt_sha256: receipt!,
  }));
}

function auditClosure(
  actorUserId = USER_ID,
  executionIdentity: ProtectedExecutionIdentity = identity(),
): JsonObject {
  const proofMaterial: JsonObject = {
    schema_version: 'dataset-alias-primary-closure.v1',
    actor_user_id: actorUserId,
    batch_count: 2,
    action_count: 52,
    distinct_action_count: 52,
    flowproperty_count: 2,
    flow_count: 23,
    process_count: 27,
    support_reference_count: 6,
    flowproperty_support_count: 2,
    unitgroup_support_count: 2,
    source_unitgroup_support_count: 2,
    invalid_action_count: 0,
    invalid_support_count: 0,
    action_evidence: primaryActionEvidence(executionIdentity),
    support_evidence: Array.from({ length: 6 }, (_, index) => ({ ordinal: index + 1 })),
    live_closure_proof: true,
  };
  return {
    ...proofMaterial,
    ok: true,
    row_count: 52,
    exchange_count: 59,
    live_closure_proof_sha256: sha256Json(proofMaterial),
  };
}

function terminalTargets(
  executionIdentity: ProtectedExecutionIdentity,
): ProtectedTerminalTargetProof[] {
  return executionIdentity.derivative_targets.map((target, index) => ({
    ordinal: index + 1,
    request_id: `child-request-${String(index + 1).padStart(2, '0')}`,
    table: target.table,
    id: target.id,
    version: target.version,
    status: 'completed',
    phase: 'terminal',
    source_baseline_snapshot_sha256: PRE_SNAPSHOT_SHA256,
    expected_snapshot_sha256: EXPECTED_SNAPSHOT_SHA256,
    completed_snapshot_sha256: COMPLETED_SNAPSHOT_SHA256,
    primary_matches: true,
    terminal_snapshot_matches: true,
    proposals_committed: true,
    derivative_fresh: true,
    lifecycle_complete: true,
    terminal_audit_present: true,
    residue: {
      http_requests: 0,
      embedding_jobs: 0,
      pending_jobs: 0,
      failure_rows: 0,
      other_active_fences: 0,
    },
    causal_terminal_proof: true,
  }));
}

function proof(
  executionIdentity: ProtectedExecutionIdentity,
  status: ProtectedExecutionStatusProof['status'] = 'passed',
): ProtectedExecutionStatusProof {
  const executionStatus =
    status === 'passed'
      ? ('completed' as const)
      : status === 'pending'
        ? ('derivatives_pending' as const)
        : status === 'failed'
          ? ('failed' as const)
          : ('indeterminate' as const);
  const derivativeReadback: ProtectedExecutionStatusProof['derivative_readback'] =
    status === 'passed'
      ? {
          schema_version: 'dataset-derivative-rebuild-batch-status.v1',
          batch_id: executionIdentity.request_id,
          status: 'completed',
          code: 'DERIVATIVE_BATCH_COMPLETED',
          proof_level: 'causal_terminal',
          proof_deferred: false,
          causal_terminal_proof: true,
          target_count: 50,
          flow_count: 23,
          process_count: 27,
          completed_count: 50,
          nonterminal_count: 0,
          failed_count: 0,
          invalid_proof_count: 0,
          targets: terminalTargets(executionIdentity),
        }
      : status === 'pending'
        ? {
            schema_version: 'dataset-derivative-rebuild-batch-status.v1',
            batch_id: executionIdentity.request_id,
            status: 'pending',
            code: 'DERIVATIVE_BATCH_PENDING',
            proof_level: 'status_only',
            proof_deferred: true,
            causal_terminal_proof: false,
            target_count: 50,
            flow_count: 23,
            process_count: 27,
            completed_count: 0,
            nonterminal_count: 50,
            failed_count: 0,
            invalid_proof_count: null,
            targets: executionIdentity.derivative_targets.map((target, index) => ({
              ordinal: index + 1,
              request_id: `child-request-${index + 1}`,
              table: target.table,
              id: target.id,
              version: target.version,
              status: 'pending',
              phase: 'queued',
              error: null,
              causal_terminal_proof: false,
            })),
          }
        : {
            schema_version: 'dataset-derivative-rebuild-batch-status.v1',
            batch_id: executionIdentity.request_id,
            status: 'not_started',
            code: 'DERIVATIVE_BATCH_NOT_STARTED',
            proof_level: 'none',
            proof_deferred: false,
            causal_terminal_proof: false,
            target_count: 0,
            flow_count: 0,
            process_count: 0,
            completed_count: 0,
            nonterminal_count: 0,
            failed_count: 0,
            invalid_proof_count: null,
            targets: [],
          };
  return {
    schema_version: PROTECTED_EXECUTION_CONTRACT.status_response_schema,
    command: PROTECTED_EXECUTION_CONTRACT.read_command,
    request_id: executionIdentity.request_id,
    status,
    execution_status: executionStatus,
    retry_allowed: false,
    actor_user_id: USER_ID,
    environment: 'production',
    project_ref: executionIdentity.project_ref,
    target_visibility: 'owner_draft',
    plan_sha256: executionIdentity.plan_sha256,
    operation_id: executionIdentity.operation_id,
    plan_request_sha256: HASH_D,
    freeze_sha256: HASH_D,
    approval_identity_sha256: HASH_D,
    approval_text_sha256: HASH_D,
    derivative_target_set_sha256: HASH_D,
    preflight_proof_sha256: HASH_D,
    admission_request_sha256: HASH_D,
    gate_results_sha256: HASH_D,
    attempt_count: 1,
    dispatch_count: status === 'indeterminate' ? 0 : 1,
    gate_count: 3,
    gates: gateReceipts(),
    primary_readback:
      status === 'passed'
        ? {
            row_count: 52,
            exchange_count: 59,
            alias_audit_count: 55,
            live_closure_proof: true,
            closure: auditClosure(USER_ID, executionIdentity),
          }
        : null,
    derivative_readback: derivativeReadback,
    failure: status === 'failed' || status === 'indeterminate' ? { code: 'TEST' } : null,
  };
}

function notAdmittedProof(executionIdentity: ProtectedExecutionIdentity) {
  const result = proof(executionIdentity, 'indeterminate');
  result.execution_status = 'not_admitted';
  result.attempt_count = 0;
  result.dispatch_count = 0;
  result.gate_count = 0;
  result.gates = [];
  result.target_visibility = null;
  result.admission_request_sha256 = null;
  result.gate_results_sha256 = null;
  return result;
}

function desiredPayloadByTarget(s: Scenario, table: string, id: string): JsonObject {
  const action = s.plan.actions.find((entry) => entry.table === table && entry.id === id)!;
  const row = s.finalRows.find((entry) => entry.table === table && entry.id === id)!;
  assert.ok(action.desired_payload);
  assert.equal(action.desired_payload.sha256, sha256Json(row.json_ordered));
  return row.json_ordered!;
}

function liveRows(s: Scenario): DatasetMaintenanceDerivativeRemoteRow[] {
  return s.identity.derivative_targets.map((target) => ({
    table: target.table,
    id: target.id,
    version: target.version,
    user_id: USER_ID,
    state_code: 0,
    raw: {
      json_ordered: desiredPayloadByTarget(s, target.table, target.id),
      extracted_md: 'rendered markdown',
      embedding_ft: [0.1, 0.2],
      embedding_ft_at: EMBEDDING_FT_AT,
    },
  }));
}

function snapshots(s: Scenario): ProtectedDerivativeSnapshot[] {
  return s.identity.derivative_targets.map((target) => {
    const payload = desiredPayloadByTarget(s, target.table, target.id);
    const payloadHash = databaseJsonbHash(target);
    assert.notEqual(payloadHash, sha256Json(payload));
    return {
      schema_version: 'dataset-derivative-snapshot.v1',
      table: target.table,
      id: target.id,
      version: target.version,
      user_id: USER_ID,
      state_code: 0,
      modified_at: MODIFIED_AT,
      json_sha256: payloadHash,
      json_ordered_sha256: payloadHash,
      extracted_md_sha256: HASH_E,
      embedding_ft_sha256: HASH_F,
      embedding_ft_at: EMBEDDING_FT_AT,
      snapshot_sha256: COMPLETED_SNAPSHOT_SHA256,
    };
  });
}

function liveReadbacks(s: Scenario): ProtectedLiveDerivativeReadback[] {
  return liveRows(s).map((row) => inspectProtectedLiveDerivative(row)!);
}

function context(fetchImpl?: FetchLike): DatasetMaintenanceRemoteContext {
  return {
    project_ref: 'qgzvkongdjqiiamzbbts',
    rest_base_url: 'https://qgzvkongdjqiiamzbbts.supabase.co/rest/v1',
    publishable_key: 'publishable-key',
    access_token: 'access-token',
    account: { user_id: USER_ID, email: EMAIL, session_source: 'test' },
    fetch_impl:
      fetchImpl ??
      (async () => {
        throw new Error('unexpected network request');
      }),
    timeout_ms: 1_000,
  };
}

function issueCodes(issues: Array<{ code: string }>): string[] {
  return issues.map((entry) => entry.code);
}

test('inspectProtectedLiveDerivative accepts only complete owner-draft derivative rows', () => {
  const s = scenario();
  try {
    const valid = liveRows(s)[0]!;
    const inspected = inspectProtectedLiveDerivative(valid);
    assert.deepEqual(inspected, {
      table: valid.table,
      id: valid.id,
      version: valid.version,
      user_id: USER_ID,
      state_code: 0,
      json_ordered_sha256: sha256Json(valid.raw.json_ordered),
      extracted_md_present: true,
      embedding_ft_present: true,
      embedding_ft_at: EMBEDDING_FT_AT,
    });

    const mutations: Array<(row: DatasetMaintenanceDerivativeRemoteRow) => void> = [
      (row) => {
        row.state_code = 100;
      },
      (row) => {
        row.raw.json_ordered = null;
      },
      (row) => {
        row.raw.extracted_md = '';
      },
      (row) => {
        row.raw.embedding_ft = null;
      },
      (row) => {
        delete row.raw.embedding_ft;
      },
      (row) => {
        row.raw.embedding_ft_at = '';
      },
      (row) => {
        row.raw.embedding_ft_at = 'not-a-time';
      },
    ];
    for (const mutate of mutations) {
      const row = copy(valid);
      mutate(row);
      assert.equal(inspectProtectedLiveDerivative(row), null);
    }
  } finally {
    s.cleanup();
  }
});

test('verifyStatusStructure enforces one attempt, status categories, identity, and gate closure', () => {
  const executionIdentity = identity();
  const verify = (candidate: ProtectedExecutionStatusProof) =>
    __testInternals.verifyStatusStructure({ identity: executionIdentity, proof: candidate });

  assert.deepEqual(verify(proof(executionIdentity)), []);
  assert.deepEqual(verify(notAdmittedProof(executionIdentity)), []);
  for (const executionStatus of ['dispatching', 'dispatched', 'running'] as const) {
    const candidate = proof(executionIdentity, 'pending');
    candidate.execution_status = executionStatus;
    assert.deepEqual(verify(candidate), []);
  }
  assert.deepEqual(verify(proof(executionIdentity, 'failed')), []);
  const completedFailure = proof(executionIdentity, 'failed');
  completedFailure.execution_status = 'completed';
  assert.deepEqual(verify(completedFailure), []);
  assert.deepEqual(verify(proof(executionIdentity, 'indeterminate')), []);

  const mutations: Array<[string, (candidate: ProtectedExecutionStatusProof) => void]> = [
    ['PROTECTED_ATTEMPT_DISPATCH_COUNT_INVALID', (candidate) => (candidate.attempt_count = 0)],
    ['PROTECTED_ATTEMPT_DISPATCH_COUNT_INVALID', (candidate) => (candidate.dispatch_count = 2)],
    ['PROTECTED_EXECUTION_IDENTITY_MISMATCH', (candidate) => (candidate.plan_sha256 = HASH_F)],
    ['PROTECTED_EXECUTION_IDENTITY_MISMATCH', (candidate) => (candidate.operation_id = 'foreign')],
    ['PROTECTED_STATUS_CATEGORY_INVALID', (candidate) => (candidate.status = 'pending')],
    ['PROTECTED_GATE_CLOSURE_INVALID', (candidate) => (candidate.gate_count = 2)],
    ['PROTECTED_GATE_CLOSURE_INVALID', (candidate) => candidate.gates.pop()],
    [
      'PROTECTED_GATE_CLOSURE_INVALID',
      (candidate) => (candidate.gates[1]!.gate = candidate.gates[0]!.gate),
    ],
    [
      'PROTECTED_GATE_CLOSURE_INVALID',
      (candidate) => (candidate.gates[1]!.receipt_sha256 = candidate.gates[0]!.receipt_sha256),
    ],
    [
      'PROTECTED_GATE_CLOSURE_INVALID',
      (candidate) => (candidate.gates[0]!.observed_sha256 = HASH_F),
    ],
    [
      'PROTECTED_GATE_CLOSURE_INVALID',
      (candidate) =>
        Object.assign(candidate.gates[0]!, { status: 'failed' as unknown as 'passed' }),
    ],
  ];
  for (const [expectedCode, mutate] of mutations) {
    const candidate = proof(executionIdentity);
    mutate(candidate);
    assert.ok(issueCodes(verify(candidate)).includes(expectedCode));
  }

  const missing = notAdmittedProof(executionIdentity);
  missing.attempt_count = 1;
  assert.deepEqual(issueCodes(verify(missing)), ['PROTECTED_ATTEMPT_DISPATCH_COUNT_INVALID']);
});

test('verifyAuditClosure validates every exact primary closure invariant and SHA', () => {
  const executionIdentity = identity();
  const valid = proof(executionIdentity);
  assert.deepEqual(__testInternals.verifyAuditClosure(valid), []);

  const mutateClosure = (mutate: (closure: JsonObject) => void) => {
    const candidate = copy(valid);
    mutate(candidate.primary_readback!.closure);
    return candidate;
  };
  const invalid: ProtectedExecutionStatusProof[] = [
    Object.assign(copy(valid), { primary_readback: null }),
    Object.assign(copy(valid), {
      primary_readback: { ...copy(valid.primary_readback!), row_count: 51 },
    }),
    Object.assign(copy(valid), {
      primary_readback: { ...copy(valid.primary_readback!), exchange_count: 58 },
    }),
    Object.assign(copy(valid), {
      primary_readback: { ...copy(valid.primary_readback!), alias_audit_count: 54 },
    }),
    Object.assign(copy(valid), {
      primary_readback: { ...copy(valid.primary_readback!), live_closure_proof: false },
    }),
    Object.assign(copy(valid), {
      primary_readback: {
        ...copy(valid.primary_readback!),
        closure: null as unknown as JsonObject,
      },
    }),
    ...[
      ['schema_version', 'wrong'],
      ['ok', false],
      ['actor_user_id', 'foreign-user'],
      ['batch_count', 1],
      ['action_count', 51],
      ['distinct_action_count', 51],
      ['flowproperty_count', 1],
      ['flow_count', 22],
      ['process_count', 26],
      ['support_reference_count', 5],
      ['flowproperty_support_count', 1],
      ['unitgroup_support_count', 1],
      ['source_unitgroup_support_count', 1],
      ['invalid_action_count', 1],
      ['invalid_support_count', 1],
      ['row_count', 51],
      ['exchange_count', 58],
      ['live_closure_proof', false],
      ['live_closure_proof_sha256', HASH_F],
    ].map(([key, value]) => mutateClosure((closure) => (closure[String(key)] = value))),
    mutateClosure((closure) => (closure.action_evidence = {})),
    mutateClosure((closure) => (closure.action_evidence = [])),
    mutateClosure((closure) => ((closure.action_evidence as unknown[])[0] = null)),
    mutateClosure((closure) => (closure.support_evidence = {})),
    mutateClosure((closure) => (closure.support_evidence = [])),
    mutateClosure((closure) => ((closure.support_evidence as unknown[])[0] = null)),
    mutateClosure((closure) => delete closure.live_closure_proof_sha256),
  ];
  for (const candidate of invalid) {
    assert.deepEqual(issueCodes(__testInternals.verifyAuditClosure(candidate)), [
      'PROTECTED_AUDIT_CLOSURE_INVALID',
    ]);
  }
});

test('verifyTerminalTargets requires an exact causal 50-target terminal proof', () => {
  const executionIdentity = identity();
  const valid = proof(executionIdentity);
  assert.deepEqual(
    __testInternals.verifyTerminalTargets({ identity: executionIdentity, proof: valid }),
    [],
  );
  const targets = valid.derivative_readback.targets as ProtectedTerminalTargetProof[];
  assert.equal(targets.length, 50);
  assert.ok(
    targets.every(
      (target) =>
        target.source_baseline_snapshot_sha256 !== target.completed_snapshot_sha256 &&
        target.expected_snapshot_sha256 !== target.completed_snapshot_sha256 &&
        target.completed_snapshot_sha256?.length === 64,
    ),
  );

  const deferred = proof(executionIdentity, 'pending');
  assert.deepEqual(
    issueCodes(
      __testInternals.verifyTerminalTargets({ identity: executionIdentity, proof: deferred }),
    ),
    ['PROTECTED_DERIVATIVE_TARGET_CLOSURE_INVALID'],
  );

  const aggregateMutations: Array<(candidate: ProtectedExecutionStatusProof) => void> = [
    (candidate) =>
      ((candidate.derivative_readback as { schema_version: string }).schema_version = 'wrong'),
    (candidate) => (candidate.derivative_readback.batch_id = 'foreign-batch'),
    (candidate) => Object.assign(candidate.derivative_readback, { status: 'failed' as const }),
    (candidate) => (candidate.derivative_readback.code = 'WRONG'),
    (candidate) => (candidate.derivative_readback.causal_terminal_proof = false),
    (candidate) => (candidate.derivative_readback.target_count = 49),
    (candidate) => (candidate.derivative_readback.flow_count = 22),
    (candidate) => (candidate.derivative_readback.process_count = 26),
    (candidate) => (candidate.derivative_readback.completed_count = 49),
    (candidate) => (candidate.derivative_readback.nonterminal_count = 1),
    (candidate) => (candidate.derivative_readback.failed_count = 1),
    (candidate) =>
      ((candidate.derivative_readback as { invalid_proof_count: number }).invalid_proof_count = 1),
    (candidate) => candidate.derivative_readback.targets.pop(),
    (candidate) => {
      candidate.derivative_readback.targets[1] = copy(candidate.derivative_readback.targets[0]!);
    },
    (candidate) => {
      candidate.derivative_readback.targets[1]!.ordinal = 1;
    },
  ];
  for (const mutate of aggregateMutations) {
    const candidate = proof(executionIdentity);
    mutate(candidate);
    assert.deepEqual(
      issueCodes(
        __testInternals.verifyTerminalTargets({ identity: executionIdentity, proof: candidate }),
      ),
      ['PROTECTED_DERIVATIVE_TARGET_CLOSURE_INVALID'],
    );
  }

  const targetMutations: Array<
    [
      string,
      (target: ProtectedTerminalTargetProof, candidate: ProtectedExecutionStatusProof) => void,
    ]
  > = [
    ['PROTECTED_DERIVATIVE_TARGET_IDENTITY_MISMATCH', (target) => (target.id = 'foreign')],
    ['PROTECTED_DERIVATIVE_TARGET_IDENTITY_MISMATCH', (target) => (target.ordinal = 51)],
    [
      'PROTECTED_DERIVATIVE_TARGET_IDENTITY_MISMATCH',
      (target, candidate) => (target.request_id = candidate.request_id),
    ],
    [
      'PROTECTED_DERIVATIVE_TARGET_IDENTITY_MISMATCH',
      (target) => (target.source_baseline_snapshot_sha256 = HASH_F),
    ],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.status = 'failed')],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.phase = '')],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.completed_snapshot_sha256 = null),
    ],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.expected_snapshot_sha256 = 'bad'),
    ],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.completed_snapshot_sha256 = 'bad'),
    ],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.completed_snapshot_sha256 = target.expected_snapshot_sha256),
    ],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.primary_matches = false)],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.terminal_snapshot_matches = false),
    ],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.proposals_committed = false)],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.derivative_fresh = false)],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.lifecycle_complete = false)],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.terminal_audit_present = false),
    ],
    ['PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL', (target) => (target.residue.pending_jobs = 1)],
    [
      'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
      (target) => (target.causal_terminal_proof = false),
    ],
  ];
  for (const [mutationIndex, [expectedCode, mutate]] of targetMutations.entries()) {
    const candidate = proof(executionIdentity);
    const candidateTargets = candidate.derivative_readback
      .targets as ProtectedTerminalTargetProof[];
    mutate(candidateTargets[0]!, candidate);
    const codes = issueCodes(
      __testInternals.verifyTerminalTargets({ identity: executionIdentity, proof: candidate }),
    );
    assert.ok(codes.includes(expectedCode), `mutation ${mutationIndex}: ${codes.join(',')}`);
  }
});

test('verifyFinalAccountRows proves the exact account census, protected rows, actions, and references', () => {
  const s = scenario();
  try {
    const verify = (
      plan: DatasetMaintenancePlan = s.plan,
      rows: DatasetMaintenanceRemoteRow[] = s.finalRows,
      finalCompleteness: unknown = completeness(rows),
    ) =>
      __testInternals.verifyFinalAccountRows({
        plan,
        planDir: s.planDir,
        rows,
        completeness: finalCompleteness,
      });
    assert.deepEqual(verify(), []);
    assert.deepEqual(
      __testInternals.expectedFinalRows({
        plan: s.plan,
        planDir: s.planDir,
        rows: s.beforeRows,
      }),
      [...s.finalRows].sort((left, right) =>
        maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
      ),
    );
    assert.deepEqual(
      __testInternals.expectedFinalRows({
        plan: { ...s.plan, actions: [s.plan.actions[0]!] },
        planDir: s.planDir,
        rows: [],
      }),
      [],
    );

    const missingCompleteness = copy(s.plan);
    delete missingCompleteness.snapshot_completeness;
    assert.deepEqual(issueCodes(verify(missingCompleteness)), [
      'PROTECTED_FINAL_SNAPSHOT_INCOMPLETE',
    ]);
    assert.deepEqual(issueCodes(verify(s.plan, s.finalRows, null)), [
      'PROTECTED_FINAL_SNAPSHOT_INCOMPLETE',
    ]);

    const missing = s.finalRows.slice(1);
    assert.ok(
      issueCodes(verify(s.plan, missing, completeness(missing))).includes(
        'PROTECTED_FINAL_SNAPSHOT_INCOMPLETE',
      ),
    );
    const extra = [
      ...s.finalRows,
      rowFor('flows', '99999999-9999-4999-8999-999999999999', { stage: 'extra' }),
    ];
    const censusDrift = verify(s.plan, extra, s.plan.snapshot_completeness);
    assert.ok(issueCodes(censusDrift).includes('PROTECTED_FINAL_ACCOUNT_CENSUS_DRIFT'));

    const protectedPlan = copy(s.plan);
    const protectedSnapshot = snapshotRemoteRow(s.finalRows[0]!);
    protectedPlan.protected_rows = [
      {
        table: protectedSnapshot.table,
        id: protectedSnapshot.id,
        version: protectedSnapshot.version,
        modified_at: protectedSnapshot.modified_at,
        row_sha256: protectedSnapshot.row_sha256,
        payload_sha256: protectedSnapshot.payload_sha256,
        reason: 'non_action_visible_row',
      },
    ];
    assert.deepEqual(verify(protectedPlan), []);
    protectedPlan.protected_rows[0]!.row_sha256 = HASH_F;
    assert.ok(issueCodes(verify(protectedPlan)).includes('PROTECTED_ROW_DRIFT'));

    const actionMutations: Array<(rows: DatasetMaintenanceRemoteRow[]) => void> = [
      (rows) => rows.splice(0, 1),
      (rows) => (rows[0]!.user_id = 'foreign-user'),
      (rows) => (rows[0]!.state_code = 100),
      (rows) => (rows[0]!.json_ordered = { stage: 'wrong' }),
      (rows) => (rows[0]!.model_id = 'wrong-model'),
      (rows) => (rows[0]!.rule_verification = !rows[0]!.rule_verification),
    ];
    for (const mutate of actionMutations) {
      const rows = copy(s.finalRows);
      mutate(rows);
      assert.ok(
        issueCodes(verify(s.plan, rows, s.plan.snapshot_completeness)).includes(
          'PROTECTED_ACTION_READBACK_MISMATCH',
        ),
      );
    }

    const badReferencePlan = copy(s.plan);
    badReferencePlan.projected_reference_sha256 = HASH_F;
    assert.ok(
      issueCodes(verify(badReferencePlan)).includes('PROTECTED_REFERENCE_CLOSURE_MISMATCH'),
    );
  } finally {
    s.cleanup();
  }
});

test('matchLiveTargets requires exact unique live/snapshot sets and completed snapshot equality', () => {
  const s = scenario();
  try {
    const terminalProofs = terminalTargets(s.identity);
    const validLive = liveReadbacks(s);
    const validSnapshots = snapshots(s);
    const validPrimaryClosure = auditClosure(USER_ID, s.identity);
    const verify = (
      live: ProtectedLiveDerivativeReadback[] = validLive,
      snapshotRows: ProtectedDerivativeSnapshot[] = validSnapshots,
      proofs: ProtectedTerminalTargetProof[] = terminalProofs,
      plan: DatasetMaintenancePlan = s.plan,
      primaryClosure: unknown = validPrimaryClosure,
    ) =>
      __testInternals.matchLiveTargets({
        proofs,
        live,
        snapshots: snapshotRows,
        primaryClosure,
        plan,
        identity: s.identity,
      });
    assert.ok(
      validLive.every(
        (row, index) => row.json_ordered_sha256 !== validSnapshots[index]!.json_ordered_sha256,
      ),
    );
    assert.deepEqual(verify(), []);

    const setMutations: Array<[ProtectedLiveDerivativeReadback[], ProtectedDerivativeSnapshot[]]> =
      [
        [validLive.slice(1), validSnapshots],
        [[validLive[0]!, ...validLive.slice(0, 49)], validSnapshots],
        [validLive, validSnapshots.slice(1)],
        [validLive, [validSnapshots[0]!, ...validSnapshots.slice(0, 49)]],
      ];
    for (const [live, snapshotRows] of setMutations) {
      assert.ok(
        issueCodes(verify(live, snapshotRows)).includes('PROTECTED_DERIVATIVE_LIVE_SET_MISMATCH'),
      );
    }

    const liveMutations: Array<(row: ProtectedLiveDerivativeReadback) => void> = [
      (row) => (row.user_id = 'foreign-user'),
      (row) => Object.assign(row, { state_code: 100 as unknown as 0 }),
      (row) => (row.json_ordered_sha256 = HASH_F),
    ];
    for (const mutate of liveMutations) {
      const rows = copy(validLive);
      mutate(rows[0]!);
      assert.ok(issueCodes(verify(rows)).includes('PROTECTED_DERIVATIVE_LIVE_MISMATCH'));
    }

    const snapshotMutations: Array<(row: ProtectedDerivativeSnapshot) => void> = [
      (row) => (row.user_id = 'foreign-user'),
      (row) => Object.assign(row, { state_code: 100 as unknown as 0 }),
      (row) => (row.json_ordered_sha256 = HASH_F),
      (row) => (row.snapshot_sha256 = EXPECTED_SNAPSHOT_SHA256),
      (row) => (row.extracted_md_sha256 = null),
      (row) => (row.embedding_ft_sha256 = null),
      (row) => (row.embedding_ft_at = null),
    ];
    for (const mutate of snapshotMutations) {
      const rows = copy(validSnapshots);
      mutate(rows[0]!);
      assert.ok(issueCodes(verify(validLive, rows)).includes('PROTECTED_DERIVATIVE_LIVE_MISMATCH'));
    }

    const primaryClosureShapeMutations: Array<(closure: JsonObject) => void> = [
      (closure) => (closure.action_evidence = {}),
      (closure) => (closure.action_evidence = (closure.action_evidence as JsonObject[]).slice(1)),
      (closure) => ((closure.action_evidence as unknown[])[2] = null),
      (closure) => {
        const evidence = closure.action_evidence as JsonObject[];
        evidence[3] = copy(evidence[2]!);
      },
      (closure) => {
        const evidence = closure.action_evidence as JsonObject[];
        evidence[3]!.action_id = evidence[2]!.action_id;
      },
      (closure) =>
        ((closure.action_evidence as JsonObject[])[2]!.id = '99999999-9999-4999-8999-999999999999'),
      (closure) => ((closure.action_evidence as JsonObject[])[2]!.action_id = 'foreign-action'),
    ];
    for (const mutate of primaryClosureShapeMutations) {
      const closure = copy(validPrimaryClosure);
      mutate(closure);
      assert.ok(
        issueCodes(verify(validLive, validSnapshots, terminalProofs, s.plan, closure)).includes(
          'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
        ),
      );
    }
    assert.ok(
      issueCodes(verify(validLive, validSnapshots, terminalProofs, s.plan, null)).includes(
        'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
      ),
    );

    const invalidEvidenceValues: Array<[string, unknown]> = [
      ['action_id', ''],
      ['table', 'sources'],
      ['id', ''],
      ['version', ''],
      ['row_found', false],
      ['owner_matches', false],
      ['state_code_matches', false],
      ['json_matches', false],
      ['json_ordered_matches', false],
      ['desired_json_ordered_sha256', 'bad'],
      ['live_json_sha256', 'bad'],
      ['live_json_ordered_sha256', 'bad'],
      ['valid', false],
    ];
    for (const [field, value] of invalidEvidenceValues) {
      const closure = copy(validPrimaryClosure);
      (closure.action_evidence as JsonObject[])[2]![field] = value;
      assert.ok(
        issueCodes(verify(validLive, validSnapshots, terminalProofs, s.plan, closure)).includes(
          'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
        ),
      );
    }

    const primaryHashMutations = [
      'desired_json_ordered_sha256',
      'live_json_sha256',
      'live_json_ordered_sha256',
    ];
    for (const field of primaryHashMutations) {
      const closure = copy(validPrimaryClosure);
      (closure.action_evidence as JsonObject[])[2]![field] = HASH_F;
      assert.ok(
        issueCodes(verify(validLive, validSnapshots, terminalProofs, s.plan, closure)).includes(
          'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
        ),
      );
    }

    assert.ok(
      issueCodes(verify(validLive, validSnapshots, terminalProofs.slice(1))).includes(
        'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
      ),
    );
    const noDesiredPlan = copy(s.plan);
    noDesiredPlan.actions[2]!.desired_payload = null;
    assert.ok(
      issueCodes(verify(validLive, validSnapshots, terminalProofs, noDesiredPlan)).includes(
        'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
      ),
    );
  } finally {
    s.cleanup();
  }
});

test('fetchProtectedDerivativeSnapshots reads all 50 exact actor-owned target snapshots', async () => {
  const executionIdentity = identity();
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      p_table: 'flows' | 'processes';
      p_id: string;
      p_version: string;
    };
    seen.push(`${body.p_table}:${body.p_id}:${body.p_version}`);
    const payloadHash = sha256Json({ id: body.p_id });
    return new Response(
      JSON.stringify({
        ok: true,
        command: 'cmd_dataset_derivative_rebuild_snapshot',
        schema_version: 'dataset-derivative-snapshot.v1',
        table: body.p_table,
        id: body.p_id,
        version: body.p_version,
        user_id: USER_ID,
        state_code: 0,
        modified_at: MODIFIED_AT,
        json_sha256: payloadHash,
        json_ordered_sha256: payloadHash,
        extracted_md_sha256: HASH_E,
        embedding_ft_sha256: HASH_F,
        embedding_ft_at: EMBEDDING_FT_AT,
        snapshot_sha256: COMPLETED_SNAPSHOT_SHA256,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const result = await __testInternals.fetchProtectedDerivativeSnapshots({
    context: context(fetchImpl),
    identity: executionIdentity,
  });
  assert.equal(seen.length, 50);
  assert.equal(new Set(seen).size, 50);
  assert.equal(result.length, 50);
  assert.ok(result.every((entry) => entry.user_id === USER_ID && entry.state_code === 0));
});

function verificationDependencies(s: Scenario, options: { invalidLive?: boolean } = {}) {
  const calls = { account: 0, derivative: 0, snapshots: 0 };
  const dependencies: Parameters<
    typeof __testInternals.verifyProtectedExecutionWithDependencies
  >[1] = {
    fetchAccountRows: async ({ userId, pageSize }) => {
      calls.account += 1;
      assert.equal(userId, USER_ID);
      assert.equal(pageSize, 321);
      return {
        rows: s.finalRows,
        source_urls: ['account://readback'],
        completeness: completeness(s.finalRows),
      };
    },
    fetchDerivativeRows: async ({ targets }) => {
      calls.derivative += 1;
      assert.equal(targets.length, 50);
      const rows = liveRows(s);
      if (options.invalidLive) rows[0]!.raw.extracted_md = '';
      return { rows, source_urls: ['derivative://readback'] };
    },
    fetchSnapshots: async ({ identity: requestedIdentity }) => {
      calls.snapshots += 1;
      assert.equal(requestedIdentity.request_id, s.identity.request_id);
      return snapshots(s);
    },
  };
  return { calls, dependencies };
}

test('verifyProtectedExecutionWithDependencies reports all ledger states without unsafe reads', async () => {
  const s = scenario();
  try {
    const options = (statusProof: ProtectedExecutionStatusProof) => ({
      plan: s.plan,
      planDir: s.planDir,
      identity: s.identity,
      proof: statusProof,
      context: context(),
      pageSize: 321,
    });
    const cases: Array<
      [ProtectedExecutionStatusProof, 'pending' | 'failed' | 'indeterminate', string | null]
    > = [
      [notAdmittedProof(s.identity), 'indeterminate', 'PROTECTED_EXECUTION_NOT_FOUND'],
      [proof(s.identity, 'pending'), 'pending', null],
      [proof(s.identity, 'indeterminate'), 'indeterminate', 'PROTECTED_EXECUTION_INDETERMINATE'],
      [proof(s.identity, 'failed'), 'failed', 'PROTECTED_EXECUTION_FAILED'],
    ];
    for (const [statusProof, expectedStatus, expectedIssue] of cases) {
      const { calls, dependencies } = verificationDependencies(s);
      const result = await __testInternals.verifyProtectedExecutionWithDependencies(
        options(statusProof),
        dependencies,
      );
      assert.equal(result.status, expectedStatus);
      assert.deepEqual(issueCodes(result.issues), expectedIssue ? [expectedIssue] : []);
      assert.deepEqual(calls, { account: 0, derivative: 0, snapshots: 0 });
      assert.equal(result.account_readback, null);
      assert.equal(result.derivative_readback, null);
    }

    const invalidStructure = proof(s.identity);
    invalidStructure.attempt_count = 2;
    const invalidDependencies = verificationDependencies(s);
    const invalidResult = await __testInternals.verifyProtectedExecutionWithDependencies(
      options(invalidStructure),
      invalidDependencies.dependencies,
    );
    assert.equal(invalidResult.status, 'failed');
    assert.deepEqual(invalidDependencies.calls, { account: 0, derivative: 0, snapshots: 0 });

    const invalidIndeterminateStructure = proof(s.identity, 'indeterminate');
    invalidIndeterminateStructure.attempt_count = 2;
    const indeterminateDependencies = verificationDependencies(s);
    const indeterminateResult = await __testInternals.verifyProtectedExecutionWithDependencies(
      options(invalidIndeterminateStructure),
      indeterminateDependencies.dependencies,
    );
    assert.equal(indeterminateResult.status, 'indeterminate');
    assert.deepEqual(indeterminateDependencies.calls, {
      account: 0,
      derivative: 0,
      snapshots: 0,
    });

    const invalidClosure = proof(s.identity);
    invalidClosure.primary_readback!.closure.live_closure_proof_sha256 = HASH_F;
    const closureDependencies = verificationDependencies(s);
    const closureResult = await __testInternals.verifyProtectedExecutionWithDependencies(
      options(invalidClosure),
      closureDependencies.dependencies,
    );
    assert.equal(closureResult.status, 'failed');
    assert.deepEqual(closureDependencies.calls, { account: 0, derivative: 0, snapshots: 0 });
  } finally {
    s.cleanup();
  }
});

test('verifyProtectedExecutionWithDependencies independently passes or fails final live readback', async () => {
  const s = scenario();
  try {
    const verificationOptions = {
      plan: s.plan,
      planDir: s.planDir,
      identity: s.identity,
      proof: proof(s.identity),
      context: context(),
      pageSize: 321,
    };
    const passing = verificationDependencies(s);
    const passed = await __testInternals.verifyProtectedExecutionWithDependencies(
      verificationOptions,
      passing.dependencies,
    );
    assert.equal(passed.status, 'passed');
    assert.deepEqual(passed.issues, []);
    assert.deepEqual(passing.calls, { account: 1, derivative: 1, snapshots: 1 });
    assert.equal(passed.account_readback?.rows.length, 52);
    assert.deepEqual(passed.account_readback?.source_urls, ['account://readback']);
    assert.equal(passed.derivative_readback?.rows.length, 50);
    assert.equal(passed.derivative_readback?.snapshots.length, 50);
    assert.deepEqual(passed.derivative_readback?.source_urls, ['derivative://readback']);

    const changedEvidenceOptions = {
      ...verificationOptions,
      proof: proof(s.identity),
    };
    const changedEvidence = verificationDependencies(s);
    const fetchAccountRows = changedEvidence.dependencies.fetchAccountRows;
    changedEvidence.dependencies.fetchAccountRows = async (options) => {
      const account = await fetchAccountRows(options);
      changedEvidenceOptions.proof.derivative_readback = proof(
        s.identity,
        'pending',
      ).derivative_readback;
      return account;
    };
    const changedEvidenceResult = await __testInternals.verifyProtectedExecutionWithDependencies(
      changedEvidenceOptions,
      changedEvidence.dependencies,
    );
    assert.equal(changedEvidenceResult.status, 'failed');
    assert.ok(
      issueCodes(changedEvidenceResult.issues).includes('PROTECTED_DERIVATIVE_LIVE_MISMATCH'),
    );

    const invalidLive = verificationDependencies(s, { invalidLive: true });
    verificationOptions.proof = proof(s.identity);
    const failed = await __testInternals.verifyProtectedExecutionWithDependencies(
      verificationOptions,
      invalidLive.dependencies,
    );
    assert.equal(failed.status, 'failed');
    assert.ok(issueCodes(failed.issues).includes('PROTECTED_DERIVATIVE_LIVE_INVALID'));
    assert.equal(failed.derivative_readback?.rows.length, 49);
    assert.deepEqual(invalidLive.calls, { account: 1, derivative: 1, snapshots: 1 });
  } finally {
    s.cleanup();
  }
});

test('public protected verifier can classify not-admitted proof without network access', async () => {
  const s = scenario();
  try {
    const result = await verifyProtectedExecution({
      plan: s.plan,
      planDir: s.planDir,
      identity: s.identity,
      proof: notAdmittedProof(s.identity),
      context: context(),
    });
    assert.equal(result.status, 'indeterminate');
    assert.deepEqual(issueCodes(result.issues), ['PROTECTED_EXECUTION_NOT_FOUND']);
  } finally {
    s.cleanup();
  }
});
