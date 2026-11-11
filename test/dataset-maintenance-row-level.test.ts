import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals as applyInternals,
  runDatasetMaintenanceApply,
} from '../src/lib/maintenance/apply.js';
import {
  appendStableJsonLine,
  readJsonFile,
  readJsonLinesIfPresent,
  resolveMaintenancePlanArtifactPath,
  safeActionFileName,
  writeImmutableJson,
  writeImmutableJsonLines,
} from '../src/lib/maintenance/contract/files.js';
import { computePlanSha256, parseMaintenancePlan } from '../src/lib/maintenance/contract.js';
import {
  sha256Json,
  sha256Text,
  stableJsonText,
  stableJsonValue,
} from '../src/lib/platform/canonical-json-hash.js';
import {
  isJsonObject,
  maintenanceRowKey,
  snapshotRemoteRow,
} from '../src/lib/maintenance/contract/values.js';
import { parseMaintenanceScope } from '../src/lib/maintenance/contract/scope.js';
import {
  type DatasetMaintenancePlan,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceProgressEntry,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceScopeAction,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import {
  __testInternals as planInternals,
  runDatasetMaintenancePlan,
} from '../src/lib/maintenance/plan.js';
import {
  __testInternals as remoteInternals,
  deleteMaintenanceRow,
  fetchMaintenanceAccountRows,
  fetchMaintenanceExactRows,
  fetchMaintenanceVisibleTableRows,
  normalizeMaintenancePageSize,
  normalizeMaintenanceTimeout,
  resolveMaintenanceRemoteContext,
  saveDraftMaintenanceRow,
} from '../src/lib/maintenance/remote.js';
import {
  __testInternals as verifyInternals,
  runDatasetMaintenanceVerify,
} from '../src/lib/maintenance/verify.js';
import type { FetchLike, ResponseLike } from '../src/lib/transport/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type StoredRow = Omit<DatasetMaintenanceRemoteRow, 'table'>;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ResponseLike {
  const defaultContentRange = Array.isArray(body)
    ? body.length > 0
      ? `0-${body.length - 1}/${body.length}`
      : '*/0'
    : null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const normalized = name.toLowerCase();
        if (normalized === 'content-type') return 'application/json';
        if (normalized === 'content-range') {
          return headers['content-range'] ?? defaultContentRange;
        }
        return headers[normalized] ?? null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    },
  };
}

function processPayload(options: { id: string; version: string; sourceId?: string }): JsonObject {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: { 'common:UUID': options.id },
      },
      ...(options.sourceId
        ? {
            modellingAndValidation: {
              dataSourcesTreatmentAndRepresentativeness: {
                referenceToDataSource: {
                  '@refObjectId': options.sourceId,
                  '@version': '01.00.000',
                  '@type': 'source data set',
                },
              },
            },
          }
        : {}),
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

function sourcePayload(id: string, version = '01.00.000'): JsonObject {
  return {
    sourceDataSet: {
      sourceInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function flowPayload(id: string, version = '01.00.000'): JsonObject {
  return {
    flowDataSet: {
      flowInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function processFlowReferencePayload(options: {
  processId: string;
  flowId: string;
  version?: string;
}): JsonObject {
  const version = options.version ?? '01.00.000';
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': options.processId } },
      exchanges: {
        exchange: {
          '@dataSetInternalID': '1',
          referenceToFlowDataSet: {
            '@refObjectId': options.flowId,
            '@version': version,
            '@type': 'flow data set',
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

class FakeMaintenanceRemote {
  readonly userId = '11111111-1111-4111-8111-111111111111';
  readonly email = 'owner@example.com';
  readonly env: NodeJS.ProcessEnv;
  readonly rows = new Map<string, StoredRow[]>();
  readonly rpcOrder: string[] = [];
  readonly rpcBodies: Record<string, unknown>[] = [];
  failDeleteOnce = false;
  failDeleteAfterCommitOnce = false;
  deleteDelayMs = 0;
  activeDeletes = 0;
  maxActiveDeletes = 0;
  invalidJson = false;
  serverPageCap = 1_000;
  duplicateExactLookup = false;

  constructor(label: string) {
    this.env = buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${label}.example.com/functions/v1`,
    });
    const sessionFile = this.env.TIANGONG_LCA_SESSION_FILE;
    if (sessionFile) {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
      session.user_email = this.email;
      writeFileSync(sessionFile, `${JSON.stringify(session)}\n`, 'utf8');
    }
    for (const table of [
      'contacts',
      'sources',
      'flows',
      'processes',
      'lifecyclemodels',
      'unitgroups',
      'flowproperties',
    ]) {
      this.rows.set(table, []);
    }
  }

  add(table: string, id: string, payload: JsonObject, extras: Partial<StoredRow> = {}): void {
    this.rows.get(table)?.push({
      id,
      version: '01.00.000',
      user_id: this.userId,
      state_code: 0,
      modified_at: '2026-07-01T00:00:00.000Z',
      json_ordered: payload,
      model_id: null,
      rule_verification: null,
      ...extras,
    });
  }

  readonly fetch: FetchLike = async (input, init) => {
    const textUrl = String(input);
    if (isSupabaseAuthTokenUrl(textUrl)) {
      return makeSupabaseAuthResponse({ email: this.email, userId: this.userId });
    }
    if (textUrl.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: this.userId, email: this.email });
    }
    if (this.invalidJson) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async text() {
          return '{bad';
        },
      };
    }
    const url = new URL(textUrl);
    const rpc = url.pathname.split('/rpc/')[1];
    if (rpc) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.rpcOrder.push(rpc);
      this.rpcBodies.push(body);
      if (rpc === 'cmd_dataset_delete' && this.failDeleteOnce) {
        this.failDeleteOnce = false;
        return jsonResponse({ message: 'injected delete failure' }, 500);
      }
      const table = String(body.p_table);
      const tableRows = this.rows.get(table) ?? [];
      const rowIndex = tableRows.findIndex(
        (row) => row.id === body.p_id && row.version === body.p_version,
      );
      if (rpc === 'cmd_dataset_delete') {
        this.activeDeletes += 1;
        this.maxActiveDeletes = Math.max(this.maxActiveDeletes, this.activeDeletes);
        if (this.deleteDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
        }
        const deleteIndex = tableRows.findIndex(
          (row) => row.id === body.p_id && row.version === body.p_version,
        );
        if (deleteIndex >= 0) {
          tableRows.splice(deleteIndex, 1);
        }
        this.activeDeletes -= 1;
        if (this.failDeleteAfterCommitOnce) {
          this.failDeleteAfterCommitOnce = false;
          return jsonResponse({ message: 'response lost after delete commit' }, 500);
        }
      } else if (rowIndex >= 0) {
        tableRows[rowIndex] = {
          ...tableRows[rowIndex]!,
          json_ordered: body.p_json_ordered as JsonObject,
          model_id: (body.p_model_id as string | null) ?? null,
          rule_verification: (body.p_rule_verification as boolean | null) ?? null,
          modified_at: '2026-07-02T00:00:00.000Z',
        };
      }
      return jsonResponse({
        ok: true,
        audit: body.p_audit,
        data: rowIndex >= 0 ? tableRows[rowIndex] : null,
      });
    }
    const table = url.pathname.split('/rest/v1/')[1] ?? '';
    let values = [...(this.rows.get(table) ?? [])];
    const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
    const version = url.searchParams.get('version')?.replace(/^eq\./u, '');
    const userId = url.searchParams.get('user_id')?.replace(/^eq\./u, '');
    if (id) values = values.filter((row) => row.id === id);
    if (version) values = values.filter((row) => row.version === version);
    if (userId) values = values.filter((row) => row.user_id === userId);
    if (id && this.duplicateExactLookup) values = [...values, ...values];
    values.sort((left, right) =>
      `${left.id}\u0000${left.version}`.localeCompare(`${right.id}\u0000${right.version}`),
    );
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? values.length);
    const page = values.slice(offset, offset + Math.min(limit, this.serverPageCap));
    return jsonResponse(page, 200, {
      'content-range':
        page.length > 0
          ? `${offset}-${offset + page.length - 1}/${values.length}`
          : `*/${values.length}`,
    });
  };
}

function buildScopeFiles(options: {
  root: string;
  remote: FakeMaintenanceRemote;
  includeSave?: boolean;
}): { scopePath: string; desiredPath: string; outDir: string } {
  const desiredPath = path.join(options.root, 'desired-process.json');
  writeFileSync(
    desiredPath,
    JSON.stringify(
      processPayload({ id: '22222222-2222-4222-8222-222222222222', version: '01.00.000' }),
    ),
  );
  const actions: object[] = [
    {
      action_id: 'delete-source',
      action: 'delete',
      table: 'sources',
      id: '33333333-3333-4333-8333-333333333333',
      version: '01.00.000',
      expected_user_id: options.remote.userId,
      expected_state_code: 0,
      reason_code: 'DUPLICATE_SOURCE',
      reason: 'Source is superseded after references are repaired.',
      evidence: ['assessment/source-audit.json'],
    },
  ];
  if (options.includeSave !== false) {
    actions.push({
      action_id: 'repair-process-source',
      action: 'save_draft',
      table: 'processes',
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
      expected_user_id: options.remote.userId,
      expected_state_code: 0,
      reason_code: 'REWRITE_SOURCE_REFERENCE',
      reason: 'Remove reference to the superseded source.',
      evidence: ['assessment/source-audit.json'],
      desired_payload_path: path.basename(desiredPath),
    });
  }
  const scopePath = path.join(options.root, 'scope.json');
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      task_id: 'bafu-cleanup-test',
      operation: 'repair-references',
      account: { user_id: options.remote.userId, email: options.remote.email },
      actions,
    }),
  );
  return { scopePath, desiredPath, outDir: path.join(options.root, 'maintenance') };
}

async function prepareParallelFlowDeleteScenario(options: {
  root: string;
  label: string;
  count: number;
}): Promise<{
  remote: FakeMaintenanceRemote;
  flowIds: string[];
  plan: DatasetMaintenancePlan;
  planPath: string;
}> {
  const scenarioRoot = path.join(options.root, options.label);
  mkdirSync(scenarioRoot, { recursive: true });
  const remote = new FakeMaintenanceRemote(options.label);
  const flowIds = Array.from(
    { length: options.count },
    (_, index) => `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  for (const flowId of flowIds) remote.add('flows', flowId, flowPayload(flowId));
  const scopePath = path.join(scenarioRoot, 'scope.json');
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      task_id: `parallel-delete-${options.label}`,
      operation: 'delete',
      account: { user_id: remote.userId, email: remote.email },
      actions: flowIds.map((id, index) => ({
        action_id: `delete-flow-${index + 1}`,
        action: 'delete',
        table: 'flows',
        id,
        version: '01.00.000',
        expected_user_id: remote.userId,
        expected_state_code: 0,
        reason_code: 'OBSOLETE_FLOW_TOPOLOGY',
        reason: 'Flow is outside the admitted candidate topology.',
        evidence: ['topology/global-inbound-zero.json'],
      })),
    }),
  );
  const outDir = path.join(scenarioRoot, 'maintenance');
  const plan = await runDatasetMaintenancePlan({
    scopePath,
    operation: 'delete',
    outDir,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-24T10:00:00.000Z'),
  });
  assert.equal(plan.status, 'ready');
  return { remote, flowIds, plan, planPath: path.join(outDir, 'maintenance-plan.json') };
}

function buildParallelDeleteGlobalInboundProof(options: {
  plan: DatasetMaintenancePlan;
  projectRef: string;
  actorUserId: string;
  capturedAtUtc: string;
}): JsonObject {
  return {
    schema_version: 'dataset-maintenance-global-inbound-proof.v1',
    status: 'PASS_GLOBAL_ALL_PROCESS_INBOUND_ZERO',
    statement_kind: 'SELECT',
    source: 'supabase_select_only_raw_sql',
    process_scope: 'all_process_rows_without_rls_restriction',
    captured_at_utc: options.capturedAtUtc,
    project_ref: options.projectRef,
    actor_user_id: options.actorUserId,
    plan_sha256: options.plan.plan_sha256,
    operation: 'delete',
    target_table: 'flows',
    target_count: options.plan.actions.length,
    target_binding_sha256: applyInternals.parallelDeleteTargetBindingSha256(options.plan),
    global_process_rows: 253,
    global_exchange_rows: 253,
    inbound_exchanges: 0,
    old_flow_identities_with_inbound: 0,
    process_identities_with_inbound: 0,
    chunks: [
      {
        index: 0,
        start: 0,
        end_exclusive: options.plan.actions.length,
        target_count: options.plan.actions.length,
        captured_at_utc: options.capturedAtUtc,
        inbound_exchanges: 0,
        old_flow_identities_with_inbound: 0,
        process_identities_with_inbound: 0,
        owner_draft_inbound: 0,
        public_inbound: 0,
        foreign_private_inbound: 0,
        other_state_inbound: 0,
        sql_sha256: 'b'.repeat(64),
      },
    ],
    p0: 0,
    p1: 0,
  };
}

function writeParallelDeleteGlobalInboundProof(options: {
  root: string;
  fileName: string;
  value: JsonObject;
}): { path: string; sha256: string } {
  const proofPath = path.join(options.root, options.fileName);
  const text = `${stableJsonText(options.value)}\n`;
  writeFileSync(proofPath, text);
  return { path: proofPath, sha256: sha256Text(text) };
}

function seed(remote: FakeMaintenanceRemote): void {
  remote.add(
    'processes',
    '22222222-2222-4222-8222-222222222222',
    processPayload({
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
      sourceId: '33333333-3333-4333-8333-333333333333',
    }),
    { model_id: '44444444-4444-4444-8444-444444444444', rule_verification: true },
  );
  remote.add(
    'sources',
    '33333333-3333-4333-8333-333333333333',
    sourcePayload('33333333-3333-4333-8333-333333333333'),
  );
  remote.add(
    'flows',
    '55555555-5555-4555-8555-555555555555',
    flowPayload('55555555-5555-4555-8555-555555555555'),
  );
}

async function prepareSeededScenario(
  root: string,
  label: string,
): Promise<{
  remote: FakeMaintenanceRemote;
  files: ReturnType<typeof buildScopeFiles>;
  plan: DatasetMaintenancePlan;
  context: Awaited<ReturnType<typeof resolveMaintenanceRemoteContext>>;
}> {
  const scenarioRoot = path.join(root, label);
  mkdirSync(scenarioRoot, { recursive: true });
  const remote = new FakeMaintenanceRemote(label);
  seed(remote);
  const files = buildScopeFiles({ root: scenarioRoot, remote });
  const plan = await runDatasetMaintenancePlan({
    scopePath: files.scopePath,
    operation: 'repair-references',
    outDir: files.outDir,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-11T00:00:00.000Z'),
  });
  const context = await resolveMaintenanceRemoteContext({
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-11T00:00:00.000Z'),
  });
  return { remote, files, plan, context };
}

function scopeAction(
  remote: FakeMaintenanceRemote,
  overrides: Record<string, unknown> = {},
): DatasetMaintenanceScopeAction {
  return {
    action_id: 'delete-source',
    action: 'delete',
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
    expected_user_id: remote.userId,
    expected_state_code: 0,
    reason_code: 'TEST',
    reason: 'test reason',
    evidence: [],
    ...overrides,
  } as DatasetMaintenanceScopeAction;
}

function scopeValue(
  remote: FakeMaintenanceRemote,
  actions: unknown[] = [scopeAction(remote)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'edge-task',
    operation: 'delete',
    account: { user_id: remote.userId },
    actions,
    ...overrides,
  };
}

function successProgressEntry(
  plan: DatasetMaintenancePlan,
  action: DatasetMaintenancePlanAction,
): DatasetMaintenanceProgressEntry {
  return {
    schema_version: 1,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    action_id: action.action_id,
    action: action.action,
    table: action.table,
    id: action.id,
    version: action.version,
    reason_code: action.reason_code,
    audit_context: {
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      action_id: action.action_id,
      reason_code: action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    actor: { user_id: plan.account.user_id, email: plan.account.email ?? '' },
    started_at_utc: '2026-07-11T00:00:00.000Z',
    ended_at_utc: '2026-07-11T00:00:00.000Z',
    before_sha256: action.before?.row_sha256 ?? '',
    after_sha256: action.desired_payload?.sha256 ?? null,
    remote_result_sha256: 'a'.repeat(64),
    result: 'success',
    error: null,
    rollback: action.rollback,
  };
}

function stripMaintenanceContentRange(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!String(input).includes('/rest/v1/')) return response;
    return {
      ...response,
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === 'content-range' ? null : response.headers.get(name);
        },
      },
    };
  };
}

test('row-level maintenance plans update-first closure, resumes failure, and verifies readback', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-row-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-main');
  seed(remote);
  const files = buildScopeFiles({ root, remote });
  const now = new Date('2026-07-11T01:02:03.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      pageSize: 1,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.target_mode, null);
    assert.equal(plan.summary.current_reference_impacts, 1);
    assert.equal(plan.summary.projected_reference_impacts, 0);
    assert.equal(plan.summary.protected_rows, 1);
    assert.equal(plan.plan_sha256, computePlanSha256(plan));
    assert.equal(parseMaintenancePlan(plan).plan_sha256, plan.plan_sha256);
    assert.equal(existsSync(path.join(files.outDir, 'maintenance-scope.json')), true);
    assert.equal(existsSync(path.join(files.outDir, 'protected-rows.jsonl')), true);
    assert.equal(plan.snapshot_completeness?.complete, true);
    assert.equal(plan.snapshot_completeness?.row_count, 3);
    const snapshotArtifact = JSON.parse(
      readFileSync(path.join(files.outDir, 'rls-visible-snapshot.json'), 'utf8'),
    ) as JsonObject;
    assert.ok(isJsonObject(snapshotArtifact.completeness));
    assert.equal(snapshotArtifact.completeness.complete, true);
    assert.equal(snapshotArtifact.completeness.row_count, 3);
    const dryRunArtifact = JSON.parse(
      readFileSync(path.join(files.outDir, 'dry-run-report.json'), 'utf8'),
    ) as JsonObject;
    assert.ok(isJsonObject(dryRunArtifact.snapshot_completeness));
    assert.equal(dryRunArtifact.snapshot_completeness.complete, true);

    remote.failDeleteOnce = true;
    const partial = await runDatasetMaintenanceApply({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: plan.plan_sha256,
      confirm: remote.email,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(partial.status, 'completed_with_failures');
    assert.equal(partial.summary.success, 1);
    assert.equal(partial.summary.failed, 1);
    assert.deepEqual(remote.rpcOrder, ['cmd_dataset_save_draft', 'cmd_dataset_delete']);

    const failedVerify = await runDatasetMaintenanceVerify({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      outDir: path.join(files.outDir, 'verify-partial'),
      pageSize: 2,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(failedVerify.status, 'failed');
    assert.match(failedVerify.issues.map((entry) => entry.code).join(','), /DELETE_TARGET/u);

    const completed = await runDatasetMaintenanceApply({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: plan.plan_sha256,
      confirm: remote.email,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.summary.resumed_successes, 1);
    assert.deepEqual(remote.rpcOrder, [
      'cmd_dataset_save_draft',
      'cmd_dataset_delete',
      'cmd_dataset_delete',
    ]);
    const progress = readJsonLinesIfPresent(path.join(files.outDir, 'apply-progress.jsonl'));
    assert.deepEqual(
      progress.map((entry) => (entry as { result: string }).result),
      ['success', 'failed', 'success'],
    );
    const firstProgress = progress[0] as Record<string, unknown>;
    assert.equal(firstProgress.action, 'save_draft');
    assert.equal(firstProgress.reason_code, 'REWRITE_SOURCE_REFERENCE');
    assert.equal(typeof firstProgress.before_sha256, 'string');
    assert.equal(typeof firstProgress.after_sha256, 'string');
    assert.equal(typeof firstProgress.remote_result_sha256, 'string');
    assert.deepEqual(firstProgress.audit_context, {
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      action_id: 'repair-process-source',
      reason_code: 'REWRITE_SOURCE_REFERENCE',
      source: 'tiangong-lca dataset maintenance apply',
    });
    assert.equal(completed.database_audit.rpc_transaction_log, 'public.command_audit_log');
    assert.match(
      readFileSync(path.join(files.outDir, 'approval-record.json'), 'utf8'),
      /plan_sha256/u,
    );

    const verified = await runDatasetMaintenanceVerify({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      pageSize: 1,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(verified.status, 'passed');
    assert.equal(verified.summary.action_checks_passed, 2);
    assert.equal(verified.summary.protected_checks_passed, 1);
    assert.equal(verified.summary.dangling_deleted_target_references, 0);
    assert.equal(verified.snapshot_completeness.complete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete apply is bounded, durable, globally fenced, and never replays success', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-delete-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({ root, label: 'success', count: 4 });
    scenario.remote.add(
      'processes',
      '81000000-0000-4000-8000-000000000001',
      processFlowReferencePayload({
        processId: '81000000-0000-4000-8000-000000000001',
        flowId: '81000000-0000-4000-8000-000000000099',
      }),
      { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
    );
    scenario.remote.add(
      'processes',
      '81000000-0000-4000-8000-000000000002',
      processFlowReferencePayload({
        processId: '81000000-0000-4000-8000-000000000002',
        flowId: '81000000-0000-4000-8000-000000000098',
      }),
      { user_id: null, state_code: null },
    );
    for (let index = 3; index <= 253; index += 1) {
      const suffix = String(index).padStart(12, '0');
      scenario.remote.add(
        'processes',
        `81000000-0000-4000-8000-${suffix}`,
        processFlowReferencePayload({
          processId: `81000000-0000-4000-8000-${suffix}`,
          flowId: `82000000-0000-4000-8000-${suffix}`,
        }),
        { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
      );
    }
    scenario.remote.deleteDelayMs = 20;
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requestedUrls.push(String(input));
      return scenario.remote.fetch(input, init);
    };
    const report = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 4,
      env: scenario.remote.env,
      fetchImpl,
      now: new Date('2026-07-24T10:01:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.success, 4);
    assert.ok(scenario.remote.maxActiveDeletes > 1);
    assert.equal(report.artifacts.execution_log?.endsWith('apply-execution-log.jsonl'), true);
    const events = readJsonLinesIfPresent(report.artifacts.execution_log!);
    for (const action of scenario.plan.actions) {
      const actionEvents = events.filter(
        (entry) => isJsonObject(entry) && entry.action_id === action.action_id,
      );
      assert.deepEqual(
        actionEvents.map((entry) => (entry as JsonObject).status),
        ['PREPARED', 'DISPATCHED', 'COMMITTED'],
      );
      assert.equal((actionEvents[0] as JsonObject).attempt_consumed, false);
      assert.equal((actionEvents[1] as JsonObject).attempt_consumed, true);
      assert.equal(
        (actionEvents[1] as JsonObject).attempt_key,
        `${action.action_id}@${(actionEvents[1] as JsonObject).desired_sha256}`,
      );
      assert.equal((actionEvents[2] as JsonObject).readback_sha256, sha256Json([]));
    }
    const barrier = readJsonFile(report.artifacts.inbound_reference_barrier!, 'barrier');
    assert.ok(isJsonObject(barrier));
    assert.equal(barrier.inbound_reference_count, 0);
    assert.equal(barrier.target_count, 4);
    assert.equal(barrier.process_rows, 253);
    assert.equal(barrier.process_references, 253);
    const visibleProcessUrls = requestedUrls
      .filter((requestedUrl) => requestedUrl.includes('/rest/v1/processes'))
      .map((requestedUrl) => new URL(requestedUrl))
      .filter((requestedUrl) => !requestedUrl.searchParams.has('user_id'));
    assert.ok(visibleProcessUrls.length > 0);
    assert.deepEqual(
      visibleProcessUrls.map((requestedUrl) => requestedUrl.searchParams.get('offset')),
      ['0', '250'],
    );
    for (const requestedUrl of visibleProcessUrls) {
      assert.equal(requestedUrl.searchParams.get('limit'), '250');
      assert.equal(requestedUrl.searchParams.get('user_id'), null);
      assert.equal(requestedUrl.searchParams.get('order'), 'id.asc,version.asc');
    }

    const rpcCount = scenario.remote.rpcOrder.length;
    const resumed = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 4,
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-24T10:02:00.000Z'),
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.summary.resumed_successes, 4);
    assert.equal(scenario.remote.rpcOrder.length, rpcCount);
    assert.equal(readJsonLinesIfPresent(report.artifacts.execution_log!).length, events.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete accepts an exact fresh global SELECT proof and skips the live all-visible scan', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-global-proof-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'global-proof',
      count: 2,
    });
    const now = new Date('2026-07-24T10:01:00.000Z');
    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    const proof = writeParallelDeleteGlobalInboundProof({
      root,
      fileName: 'global-inbound-proof.json',
      value: buildParallelDeleteGlobalInboundProof({
        plan: scenario.plan,
        projectRef: context.project_ref,
        actorUserId: context.account.user_id,
        capturedAtUtc: '2026-07-24T10:00:30.000Z',
      }),
    });
    const requestedUrls: string[] = [];
    const report = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 2,
      globalInboundProofPath: proof.path,
      approveGlobalInboundProof: proof.sha256,
      env: scenario.remote.env,
      fetchImpl: async (input, init) => {
        requestedUrls.push(String(input));
        return scenario.remote.fetch(input, init);
      },
      now,
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.success, 2);
    const unfilteredProcessReads = requestedUrls
      .filter((requestedUrl) => requestedUrl.includes('/rest/v1/processes'))
      .map((requestedUrl) => new URL(requestedUrl))
      .filter((requestedUrl) => !requestedUrl.searchParams.has('user_id'));
    assert.deepEqual(unfilteredProcessReads, []);
    const barrier = readJsonFile(report.artifacts.inbound_reference_barrier!, 'global barrier');
    assert.ok(isJsonObject(barrier));
    assert.equal(barrier.snapshot_sha256, proof.sha256);
    assert.equal(barrier.process_rows, 253);
    assert.equal(barrier.process_references, 253);
    assert.ok(isJsonObject(barrier.completeness));
    assert.equal(barrier.completeness.strategy, 'sha256_approved_global_select_only_all_processes');
    assert.equal(barrier.completeness.proof_sha256, proof.sha256);
    assert.equal(
      barrier.completeness.target_binding_sha256,
      applyInternals.parallelDeleteTargetBindingSha256(scenario.plan),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('global inbound proof admission rejects stale, foreign, mutated, incomplete, or unapproved evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-global-proof-invalid-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'global-proof-invalid',
      count: 2,
    });
    const now = new Date('2026-07-24T10:01:00.000Z');
    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    const base = buildParallelDeleteGlobalInboundProof({
      plan: scenario.plan,
      projectRef: context.project_ref,
      actorUserId: context.account.user_id,
      capturedAtUtc: '2026-07-24T10:00:30.000Z',
    });
    const absentBeforePlan = structuredClone(scenario.plan);
    absentBeforePlan.actions[0]!.before = null;
    assert.notEqual(
      applyInternals.parallelDeleteTargetBindingSha256(absentBeforePlan),
      applyInternals.parallelDeleteTargetBindingSha256(scenario.plan),
    );
    const mutations: Array<[string, (value: JsonObject) => void]> = [
      [
        'stale',
        (value) => {
          value.captured_at_utc = '2026-07-24T09:00:00.000Z';
          (value.chunks as JsonObject[])[0]!.captured_at_utc = '2026-07-24T09:00:00.000Z';
        },
      ],
      [
        'project',
        (value) => {
          value.project_ref = 'foreign-project';
        },
      ],
      [
        'actor',
        (value) => {
          value.actor_user_id = '99999999-9999-4999-8999-999999999999';
        },
      ],
      [
        'plan',
        (value) => {
          value.plan_sha256 = 'c'.repeat(64);
        },
      ],
      [
        'binding',
        (value) => {
          value.target_binding_sha256 = 'd'.repeat(64);
        },
      ],
      [
        'statement',
        (value) => {
          value.statement_kind = 'UPDATE';
        },
      ],
      [
        'inbound',
        (value) => {
          value.inbound_exchanges = 1;
        },
      ],
      [
        'p0',
        (value) => {
          value.p0 = 1;
        },
      ],
      [
        'captured-type',
        (value) => {
          value.captured_at_utc = 1;
        },
      ],
      [
        'chunk-gap',
        (value) => {
          (value.chunks as JsonObject[])[0]!.start = 1;
        },
      ],
      [
        'chunk-type',
        (value) => {
          value.chunks = [null];
        },
      ],
      [
        'chunk-captured-type',
        (value) => {
          (value.chunks as JsonObject[])[0]!.captured_at_utc = 1;
        },
      ],
      [
        'chunk-inbound',
        (value) => {
          (value.chunks as JsonObject[])[0]!.foreign_private_inbound = 1;
        },
      ],
      [
        'chunk-partial',
        (value) => {
          (value.chunks as JsonObject[])[0]!.end_exclusive = 1;
          (value.chunks as JsonObject[])[0]!.target_count = 1;
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const value = structuredClone(base);
      mutate(value);
      const proof = writeParallelDeleteGlobalInboundProof({
        root,
        fileName: `${label}.json`,
        value,
      });
      assert.throws(
        () =>
          applyInternals.validateParallelDeleteGlobalInboundProof({
            proofPath: proof.path,
            approveProof: proof.sha256,
            plan: scenario.plan,
            context,
            now,
          }),
        /Global inbound proof/u,
        label,
      );
    }

    const approved = writeParallelDeleteGlobalInboundProof({
      root,
      fileName: 'approved.json',
      value: base,
    });
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: approved.path,
          approveProof: 'e'.repeat(64),
          plan: scenario.plan,
          context,
          now,
        }),
      /does not match approval/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: true,
          proofPath: approved.path,
        }),
      /must be provided together/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: false,
          proofPath: approved.path,
          approveProof: approved.sha256,
        }),
      /only with --max-parallel/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: true,
          proofPath: approved.path,
          approveProof: 'BAD',
        }),
      /lowercase SHA-256/u,
    );
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: 'relative-proof.json',
          approveProof: approved.sha256,
          plan: scenario.plan,
          context,
          now,
        }),
      /must be absolute/u,
    );
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: path.join(root, 'missing-proof.json'),
          approveProof: 'f'.repeat(64),
          plan: scenario.plan,
          context,
          now,
        }),
      /could not be read/u,
    );
    for (const [fileName, text, pattern] of [
      ['malformed.json', '{bad', /not valid JSON/u],
      ['primitive.json', 'null', /must be a JSON object/u],
    ] as const) {
      const invalidPath = path.join(root, fileName);
      writeFileSync(invalidPath, text);
      assert.throws(
        () =>
          applyInternals.validateParallelDeleteGlobalInboundProof({
            proofPath: invalidPath,
            approveProof: sha256Text(text),
            plan: scenario.plan,
            context,
            now,
          }),
        pattern,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete recovers committed ambiguity and continues after terminal UNKNOWN', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-recovery-'));
  try {
    const recovered = await prepareParallelFlowDeleteScenario({
      root,
      label: 'recovered',
      count: 2,
    });
    recovered.remote.failDeleteAfterCommitOnce = true;
    const recoveredReport = await runDatasetMaintenanceApply({
      planPath: recovered.planPath,
      commit: true,
      approvePlan: recovered.plan.plan_sha256,
      confirm: recovered.remote.email,
      maxParallel: 1,
      env: recovered.remote.env,
      fetchImpl: recovered.remote.fetch,
    });
    assert.equal(recoveredReport.status, 'completed');
    const recoveredEvents = readJsonLinesIfPresent(recoveredReport.artifacts.execution_log!);
    assert.equal(
      recoveredEvents.some(
        (entry) => isJsonObject(entry) && entry.status === 'COMMITTED' && entry.recovered === true,
      ),
      true,
    );

    const unknown = await prepareParallelFlowDeleteScenario({ root, label: 'unknown', count: 2 });
    unknown.remote.failDeleteOnce = true;
    const unknownReport = await runDatasetMaintenanceApply({
      planPath: unknown.planPath,
      commit: true,
      approvePlan: unknown.plan.plan_sha256,
      confirm: unknown.remote.email,
      maxParallel: 1,
      env: unknown.remote.env,
      fetchImpl: unknown.remote.fetch,
    });
    assert.equal(unknownReport.status, 'completed_with_unknowns');
    assert.equal(unknownReport.summary.unknown, 1);
    assert.equal(unknownReport.summary.success, 1);
    assert.deepEqual(
      unknownReport.actions.map((action) => action.status),
      ['unknown', 'success'],
    );
    assert.equal(unknown.remote.rpcOrder.length, 2);

    const resumed = await runDatasetMaintenanceApply({
      planPath: unknown.planPath,
      commit: true,
      approvePlan: unknown.plan.plan_sha256,
      confirm: unknown.remote.email,
      maxParallel: 1,
      env: unknown.remote.env,
      fetchImpl: unknown.remote.fetch,
    });
    assert.equal(resumed.status, 'completed_with_unknowns');
    assert.equal(unknown.remote.rpcOrder.length, 2);
    const firstActionEvents = readJsonLinesIfPresent(resumed.artifacts.execution_log!).filter(
      (entry) => isJsonObject(entry) && entry.action_id === 'delete-flow-1',
    );
    assert.equal(
      firstActionEvents.filter((entry) => isJsonObject(entry) && entry.status === 'DISPATCHED')
        .length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete rejects non-delete plans and any globally visible process inbound edge', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-barrier-'));
  try {
    const mixed = await prepareSeededScenario(root, 'mixed-plan');
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(mixed.files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: mixed.plan.plan_sha256,
          confirm: mixed.remote.email,
          maxParallel: 2,
          env: mixed.remote.env,
          fetchImpl: mixed.remote.fetch,
        }),
      /flow delete-only plan/u,
    );

    const inbound = await prepareParallelFlowDeleteScenario({ root, label: 'inbound', count: 1 });
    inbound.remote.add(
      'processes',
      '80000000-0000-4000-8000-000000000001',
      processFlowReferencePayload({
        processId: '80000000-0000-4000-8000-000000000001',
        flowId: inbound.flowIds[0]!,
      }),
      { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: inbound.planPath,
          commit: true,
          approvePlan: inbound.plan.plan_sha256,
          confirm: inbound.remote.email,
          maxParallel: 8,
          env: inbound.remote.env,
          fetchImpl: inbound.remote.fetch,
        }),
      /visible process inbound references/u,
    );
    assert.equal(inbound.remote.rpcOrder.length, 0);

    const context = await resolveMaintenanceRemoteContext({
      env: inbound.remote.env,
      fetchImpl: inbound.remote.fetch,
    });
    const visible = await fetchMaintenanceVisibleTableRows({
      context,
      table: 'processes',
      pageSize: 1,
    });
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.completeness.complete, true);

    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: inbound.planPath,
          commit: true,
          approvePlan: inbound.plan.plan_sha256,
          confirm: inbound.remote.email,
          maxParallel: 9,
          env: inbound.remote.env,
          fetchImpl: inbound.remote.fetch,
        }),
      /integer from 1 to 8/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete ledger recovers crash windows without a second dispatch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-crash-'));
  try {
    const committed = await prepareParallelFlowDeleteScenario({
      root,
      label: 'committed-ledger',
      count: 1,
    });
    await runDatasetMaintenanceApply({
      planPath: committed.planPath,
      commit: true,
      approvePlan: committed.plan.plan_sha256,
      confirm: committed.remote.email,
      maxParallel: 1,
      env: committed.remote.env,
      fetchImpl: committed.remote.fetch,
    });
    rmSync(path.join(path.dirname(committed.planPath), 'apply-progress.jsonl'));
    const committedRpcCount = committed.remote.rpcOrder.length;
    const recoveredCommitted = await runDatasetMaintenanceApply({
      planPath: committed.planPath,
      commit: true,
      approvePlan: committed.plan.plan_sha256,
      confirm: committed.remote.email,
      maxParallel: 1,
      env: committed.remote.env,
      fetchImpl: committed.remote.fetch,
    });
    assert.equal(recoveredCommitted.status, 'completed');
    assert.equal(committed.remote.rpcOrder.length, committedRpcCount);

    const dispatched = await prepareParallelFlowDeleteScenario({
      root,
      label: 'dispatched-ledger',
      count: 1,
    });
    await runDatasetMaintenanceApply({
      planPath: dispatched.planPath,
      commit: true,
      approvePlan: dispatched.plan.plan_sha256,
      confirm: dispatched.remote.email,
      maxParallel: 1,
      env: dispatched.remote.env,
      fetchImpl: dispatched.remote.fetch,
    });
    const executionPath = path.join(path.dirname(dispatched.planPath), 'apply-execution-log.jsonl');
    const firstTwo = readJsonLinesIfPresent(executionPath).slice(0, 2);
    writeFileSync(executionPath, `${firstTwo.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    rmSync(path.join(path.dirname(dispatched.planPath), 'apply-progress.jsonl'));
    const dispatchedRpcCount = dispatched.remote.rpcOrder.length;
    const recoveredDispatched = await runDatasetMaintenanceApply({
      planPath: dispatched.planPath,
      commit: true,
      approvePlan: dispatched.plan.plan_sha256,
      confirm: dispatched.remote.email,
      maxParallel: 1,
      env: dispatched.remote.env,
      fetchImpl: dispatched.remote.fetch,
    });
    assert.equal(recoveredDispatched.status, 'completed');
    assert.equal(dispatched.remote.rpcOrder.length, dispatchedRpcCount);
    assert.deepEqual(
      readJsonLinesIfPresent(executionPath).map((entry) => (entry as { status: string }).status),
      ['PREPARED', 'DISPATCHED', 'COMMITTED'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete recovery classifies exact-before, drift, and read failures as UNKNOWN', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-unknown-'));
  try {
    for (const mode of ['exact-before', 'drift', 'read-failure'] as const) {
      const scenario = await prepareParallelFlowDeleteScenario({ root, label: mode, count: 1 });
      scenario.remote.failDeleteOnce = true;
      await runDatasetMaintenanceApply({
        planPath: scenario.planPath,
        commit: true,
        approvePlan: scenario.plan.plan_sha256,
        confirm: scenario.remote.email,
        maxParallel: 1,
        env: scenario.remote.env,
        fetchImpl: scenario.remote.fetch,
      });
      const planDir = path.dirname(scenario.planPath);
      const executionPath = path.join(planDir, 'apply-execution-log.jsonl');
      const dispatchedOnly = readJsonLinesIfPresent(executionPath).slice(0, 2);
      writeFileSync(
        executionPath,
        `${dispatchedOnly.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      );
      rmSync(path.join(planDir, 'apply-progress.jsonl'));
      if (mode === 'drift') {
        scenario.remote.rows.get('flows')![0]!.json_ordered = flowPayload(
          '82000000-0000-4000-8000-000000000099',
        );
      }
      const fetchImpl: FetchLike =
        mode === 'read-failure'
          ? async (input, init) => {
              const url = new URL(String(input));
              return url.pathname.endsWith('/rest/v1/flows') && url.searchParams.has('id')
                ? jsonResponse({ message: 'recovery lookup failed' }, 500)
                : scenario.remote.fetch(input, init);
            }
          : scenario.remote.fetch;
      const rpcCount = scenario.remote.rpcOrder.length;
      const report = await runDatasetMaintenanceApply({
        planPath: scenario.planPath,
        commit: true,
        approvePlan: scenario.plan.plan_sha256,
        confirm: scenario.remote.email,
        maxParallel: 1,
        env: scenario.remote.env,
        fetchImpl,
      });
      assert.equal(report.status, 'completed_with_unknowns');
      assert.equal(scenario.remote.rpcOrder.length, rpcCount);
      const latest = readJsonLinesIfPresent(executionPath).at(-1);
      assert.ok(isJsonObject(latest));
      assert.equal(latest.status, 'UNKNOWN');
      assert.match(
        String(latest.error),
        mode === 'exact-before'
          ? /exact-before/u
          : mode === 'drift'
            ? /drifted/u
            : /Read-only recovery failed/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete continues pre-dispatch failures and records post-dispatch readback variants', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-edges-'));
  try {
    const preflight = await prepareParallelFlowDeleteScenario({
      root,
      label: 'jit-duplicate',
      count: 2,
    });
    preflight.remote.duplicateExactLookup = true;
    const preflightReport = await runDatasetMaintenanceApply({
      planPath: preflight.planPath,
      commit: true,
      approvePlan: preflight.plan.plan_sha256,
      confirm: preflight.remote.email,
      maxParallel: 2,
      env: preflight.remote.env,
      fetchImpl: preflight.remote.fetch,
    });
    assert.equal(preflightReport.status, 'completed_with_failures');
    assert.equal(preflightReport.summary.failed, 2);
    assert.equal(preflight.remote.rpcOrder.length, 0);

    const retained = await prepareParallelFlowDeleteScenario({
      root,
      label: 'retained-readback',
      count: 1,
    });
    const retainedReport = await runDatasetMaintenanceApply({
      planPath: retained.planPath,
      commit: true,
      approvePlan: retained.plan.plan_sha256,
      confirm: retained.remote.email,
      maxParallel: 1,
      env: retained.remote.env,
      fetchImpl: async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_delete')
          ? jsonResponse({ ok: true, audit_id: '123' })
          : retained.remote.fetch(input, init),
    });
    assert.equal(retainedReport.status, 'completed_with_unknowns');
    const retainedEvent = readJsonLinesIfPresent(retainedReport.artifacts.execution_log!).at(-1);
    assert.ok(isJsonObject(retainedEvent));
    assert.equal(retainedEvent.audit_id, '123');
    assert.match(String(retainedEvent.error), /returned but exact absent/u);

    const lostReadback = await prepareParallelFlowDeleteScenario({
      root,
      label: 'lost-readback',
      count: 1,
    });
    let dispatched = false;
    const lostReadbackReport = await runDatasetMaintenanceApply({
      planPath: lostReadback.planPath,
      commit: true,
      approvePlan: lostReadback.plan.plan_sha256,
      confirm: lostReadback.remote.email,
      maxParallel: 1,
      env: lostReadback.remote.env,
      fetchImpl: async (input, init) => {
        if (String(input).includes('/rpc/cmd_dataset_delete')) {
          const response = await lostReadback.remote.fetch(input, init);
          dispatched = true;
          return response;
        }
        const url = new URL(String(input));
        if (dispatched && url.pathname.endsWith('/rest/v1/flows') && url.searchParams.has('id')) {
          return jsonResponse({ message: 'readback unavailable' }, 500);
        }
        return lostReadback.remote.fetch(input, init);
      },
    });
    assert.equal(lostReadbackReport.status, 'completed_with_unknowns');
    const lostEvent = readJsonLinesIfPresent(lostReadbackReport.artifacts.execution_log!).at(-1);
    assert.ok(isJsonObject(lostEvent));
    assert.equal(lostEvent.readback_sha256, null);
    assert.match(String(lostEvent.error), /Readback failed after dispatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete internals reject duplicate targets, corrupt ledgers, and fatal ledger writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-internals-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'internals',
      count: 2,
    });
    const duplicate = structuredClone(scenario.plan);
    duplicate.actions[1] = {
      ...duplicate.actions[1]!,
      id: duplicate.actions[0]!.id,
      version: duplicate.actions[0]!.version,
    };
    assert.throws(() => applyInternals.assertParallelDeletePlan(duplicate), /repeated/u);
    const legacySummary = structuredClone(scenario.plan);
    delete legacySummary.summary.update_json_ordered;
    delete legacySummary.summary.rebuild_derivatives;
    assert.doesNotThrow(() => applyInternals.assertParallelDeletePlan(legacySummary));
    assert.equal(applyInternals.normalizeMaintenanceMaxParallel(undefined), 1);
    assert.equal(applyInternals.normalizeMaintenanceMaxParallel(8), 8);
    assert.throws(() => applyInternals.normalizeMaintenanceMaxParallel(0), /integer/u);
    assert.equal(applyInternals.remoteAuditId({ audit_id: '7' }), '7');
    assert.equal(applyInternals.remoteAuditId({ audit_id: 'bad' }), null);

    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    const executionLogPath = path.join(path.dirname(scenario.planPath), 'manual-log.jsonl');
    const execution = {
      entries: [],
      byAction: new Map(),
      dispatched: new Set<string>(),
      committed: new Set<string>(),
    };
    const action = scenario.plan.actions[0]!;
    applyInternals.appendParallelDeleteExecutionEntry({
      path: executionLogPath,
      state: execution,
      plan: scenario.plan,
      action,
      context,
      status: 'PREPARED',
      recordedAtUtc: '2026-07-24T10:00:00.000Z',
    });
    applyInternals.appendParallelDeleteExecutionEntry({
      path: executionLogPath,
      state: execution,
      plan: scenario.plan,
      action,
      context,
      status: 'DISPATCHED',
      recordedAtUtc: '2026-07-24T10:00:01.000Z',
    });
    const validEntries = readJsonLinesIfPresent(executionLogPath);
    const corruptions: unknown[] = [
      null,
      { ...(validEntries[0] as JsonObject), action_id: 'foreign-action' },
      { ...(validEntries[0] as JsonObject), audit_id: 'bad' },
      { ...(validEntries[0] as JsonObject), remote_result_sha256: 'bad' },
      { ...(validEntries[0] as JsonObject), attempt_consumed: 'bad' },
      { ...(validEntries[0] as JsonObject), recovered: 'bad' },
      { ...(validEntries[0] as JsonObject), readback_sha256: 'bad' },
      { ...(validEntries[0] as JsonObject), error: 1 },
      { ...(validEntries[0] as JsonObject), status: 'COMMITTED' },
      { ...(validEntries[0] as JsonObject), recorded_at_utc: 'bad' },
    ];
    for (const [index, corrupted] of corruptions.entries()) {
      const corruptPath = path.join(root, `corrupt-${index}.jsonl`);
      writeFileSync(corruptPath, `${JSON.stringify(corrupted)}\n`);
      assert.throws(
        () => applyInternals.parseParallelDeleteExecutionLog(scenario.plan, corruptPath),
        /invalid or foreign/u,
      );
    }

    const fatalLogPath = path.join(root, 'ledger-as-directory');
    mkdirSync(fatalLogPath);
    const progressPath = path.join(root, 'fatal-progress.jsonl');
    await assert.rejects(
      () =>
        applyInternals.executeParallelDeletePlan({
          plan: { ...scenario.plan, actions: [action] },
          context,
          progress: applyInternals.parseProgress(
            { ...scenario.plan, actions: [action] },
            progressPath,
          ),
          progressPath,
          executionLogPath: fatalLogPath,
          execution: {
            entries: [],
            byAction: new Map(),
            dispatched: new Set(),
            committed: new Set(),
          },
          maxParallel: 1,
          now: () => '2026-07-24T10:00:00.000Z',
        }),
      /EISDIR|EPERM|illegal operation on a directory/u,
    );

    const unversioned = processFlowReferencePayload({
      processId: '83000000-0000-4000-8000-000000000001',
      flowId: scenario.flowIds[0]!,
    });
    const reference = ((unversioned.processDataSet as JsonObject).exchanges as JsonObject)
      .exchange as JsonObject;
    delete (reference.referenceToFlowDataSet as JsonObject)['@version'];
    assert.throws(
      () =>
        applyInternals.assertNoVisibleProcessInboundReferences({
          plan: scenario.plan,
          rows: [
            {
              table: 'processes',
              id: '83000000-0000-4000-8000-000000000001',
              version: '01.00.000',
              user_id: null,
              state_code: 100,
              modified_at: null,
              json_ordered: unversioned,
              model_id: null,
              rule_verification: null,
            },
          ],
        }),
      /visible process inbound/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('row-level plan blocks a delete with projected inbound references', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-blocked-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-blocked');
  seed(remote);
  const files = buildScopeFiles({ root, remote, includeSave: false });
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.summary.projected_reference_impacts, 1);
    assert.match(plan.blockers.map((entry) => entry.code).join(','), /PROJECTED_INBOUND/u);
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /Blocked maintenance plan/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance contracts and remote adapters reject unsafe inputs and invalid responses', async () => {
  const remote = new FakeMaintenanceRemote('row-maintenance-edges');
  seed(remote);
  assert.equal(normalizeMaintenancePageSize(), 1000);
  assert.equal(normalizeMaintenanceTimeout(), 10000);
  assert.throws(() => normalizeMaintenancePageSize(0), /page size/u);
  assert.throws(() => normalizeMaintenancePageSize(5001), /page size/u);
  assert.throws(() => normalizeMaintenanceTimeout(0), /timeout/u);
  assert.equal(safeActionFileName(' / '), sha256Text(' / ').slice(0, 16));
  assert.throws(
    () =>
      parseMaintenanceScope({
        schema_version: 1,
        task_id: 'bad',
        operation: 'delete',
        account: { user_id: remote.userId },
        actions: [
          {
            action_id: 'bad',
            action: 'delete',
            table: 'unitgroups',
            id: 'id',
            version: '01.00.000',
            expected_user_id: remote.userId,
            expected_state_code: 0,
            reason_code: 'bad',
            reason: 'bad',
            evidence: [],
          },
        ],
      }),
    /protected or unsupported/u,
  );
  const context = await resolveMaintenanceRemoteContext({
    env: remote.env,
    fetchImpl: remote.fetch,
    timeoutMs: 1000,
  });
  const exact = await fetchMaintenanceExactRows({
    context,
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
  });
  assert.equal(exact.rows.length, 1);
  const account = await fetchMaintenanceAccountRows({
    context,
    userId: remote.userId,
    pageSize: 1,
  });
  assert.equal(account.rows.length, 3);
  await assert.rejects(
    () =>
      fetchMaintenanceAccountRows({
        context: {
          ...context,
          fetch_impl: async () =>
            jsonResponse([
              {
                id: 'foreign-contact',
                version: '01.00.000',
                user_id: 'other-user',
                state_code: 0,
              },
            ]),
        },
        userId: remote.userId,
      }),
    /foreign account row/u,
  );
  await saveDraftMaintenanceRow({
    context,
    table: 'processes',
    id: '22222222-2222-4222-8222-222222222222',
    version: '01.00.000',
    payload: processPayload({
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
    }),
    modelId: null,
    ruleVerification: false,
    audit: { source: 'test' },
  });
  await deleteMaintenanceRow({
    context,
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
    audit: { source: 'test' },
  });

  remote.invalidJson = true;
  await assert.rejects(
    () =>
      fetchMaintenanceExactRows({
        context,
        table: 'flows',
        id: '55555555-5555-4555-8555-555555555555',
        version: '01.00.000',
      }),
    /not valid JSON/u,
  );
  assert.equal(remoteInternals.selectForTable('processes').includes('model_id'), true);
  assert.equal(remoteInternals.selectForTable('flows').includes('model_id'), false);
  assert.equal(
    remoteInternals.selectForTable('flows', true).includes('modified_at,json,json_ordered'),
    true,
  );
  assert.equal(remoteInternals.normalizeRemoteRow('flows', null), null);
  assert.equal(remoteInternals.normalizeRemoteRow('flows', { id: '', version: '' }), null);
  assert.deepEqual(
    remoteInternals.normalizeRemoteRow('flows', {
      id: ' id ',
      version: ' 01.00.000 ',
      user_id: 2,
      state_code: '0',
      modified_at: '',
      json_ordered: [],
      model_id: ' ',
      rule_verification: 'no',
    }),
    {
      table: 'flows',
      id: 'id',
      version: '01.00.000',
      user_id: null,
      state_code: 0,
      modified_at: null,
      json_ordered: null,
      model_id: null,
      rule_verification: null,
    },
  );
  assert.equal(
    remoteInternals.normalizeRemoteRow('flows', {
      id: 'id',
      version: '01.00.000',
      state_code: 'bad',
    })?.state_code,
    null,
  );
  assert.deepEqual(
    remoteInternals.normalizeRemoteRow(
      'flows',
      {
        id: 'id',
        version: '01.00.000',
        json: { mirrored: true },
        json_ordered: { mirrored: true },
      },
      true,
    )?.json,
    { mirrored: true },
  );
  assert.equal(
    remoteInternals.normalizeRemoteRow('flows', { id: 'id', version: '01.00.000', json: [] }, true)
      ?.json,
    null,
  );
  assert.throws(() => remoteInternals.normalizeRemoteRows('flows', {}, 'test'), /not an array/u);
  assert.throws(() => remoteInternals.normalizeRemoteRows('flows', [{}], 'test'), /invalid row/u);
  const partialContext = {
    publishable_key: 'key',
    access_token: 'token',
    timeout_ms: 1000,
    fetch_impl: (async () => jsonResponse({}, 500)) as FetchLike,
  };
  await assert.rejects(
    () =>
      remoteInternals.fetchJson({
        context: partialContext,
        url: 'https://example.test/fail',
        label: 'fail',
      }),
    /HTTP 500/u,
  );
  assert.equal(
    await remoteInternals.fetchJson({
      context: {
        ...partialContext,
        fetch_impl: async () => ({
          ...jsonResponse(null),
          async text() {
            return '';
          },
        }),
      },
      url: 'https://example.test/empty',
      label: 'empty',
    }),
    null,
  );

  const fallbackRemote = new FakeMaintenanceRemote('row-maintenance-email-fallback');
  const fallbackContext = await resolveMaintenanceRemoteContext({
    env: fallbackRemote.env,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/auth/v1/user')) {
        return jsonResponse({ id: fallbackRemote.userId });
      }
      return fallbackRemote.fetch(input, init);
    },
  });
  assert.equal(fallbackContext.account.email, fallbackRemote.email);
  const invalidUserRemote = new FakeMaintenanceRemote('row-maintenance-invalid-user');
  await assert.rejects(
    () =>
      resolveMaintenanceRemoteContext({
        env: invalidUserRemote.env,
        fetchImpl: async (input, init) =>
          String(input).endsWith('/auth/v1/user')
            ? jsonResponse({ email: invalidUserRemote.email })
            : invalidUserRemote.fetch(input, init),
      }),
    /did not return id and email/u,
  );
  const badRpcContext = {
    ...context,
    fetch_impl: (async (input, init) =>
      String(input).includes('/rpc/')
        ? jsonResponse({ ok: false })
        : remote.fetch(input, init)) as FetchLike,
  };
  await assert.rejects(
    () =>
      deleteMaintenanceRow({
        context: badRpcContext,
        table: 'sources',
        id: 'missing',
        version: '01.00.000',
        audit: {},
      }),
    /unexpected response/u,
  );
});

test('account maintenance snapshot follows a 1000-row server cap for a requested page size of 5000', async () => {
  const visibleFlows: StoredRow[] = Array.from({ length: 2_203 }, (_, index) => {
    const id = `flow-${String(index).padStart(5, '0')}`;
    return {
      id,
      version: '00.00.001',
      user_id: 'user-1',
      state_code: 0,
      modified_at: '2026-07-13T00:00:00.000Z',
      json_ordered: flowPayload(id, '00.00.001'),
      model_id: null,
      rule_verification: null,
    };
  });
  const flowOffsets: number[] = [];
  const preferHeaders: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/rest/v1/')[1] ?? '';
    const rows = table === 'flows' ? visibleFlows : [];
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const requestedLimit = Number(url.searchParams.get('limit') ?? rows.length);
    const page = rows.slice(offset, offset + Math.min(requestedLimit, 1_000));
    if (table === 'flows') flowOffsets.push(offset);
    preferHeaders.push(new Headers(init?.headers).get('prefer') ?? '');
    return jsonResponse(page, 200, {
      'content-range':
        page.length > 0
          ? `${offset}-${offset + page.length - 1}/${rows.length}`
          : `*/${rows.length}`,
    });
  };
  const snapshot = await fetchMaintenanceAccountRows({
    context: {
      rest_base_url: 'https://example.test/rest/v1',
      project_ref: 'example',
      publishable_key: 'publishable',
      access_token: 'access',
      account: { user_id: 'user-1', email: 'user@example.com', session_source: 'credentials' },
      fetch_impl: fetchImpl,
      timeout_ms: 1_000,
    },
    userId: 'user-1',
    pageSize: 5_000,
  });

  assert.equal(snapshot.rows.length, 2_203);
  assert.deepEqual(flowOffsets, [0, 1_000, 2_000]);
  assert.equal(
    preferHeaders.every((value) => value === 'count=exact'),
    true,
  );
  assert.equal(snapshot.completeness.complete, true);
  assert.equal(snapshot.completeness.requested_page_size, 5_000);
  assert.equal(snapshot.completeness.entity_counts.flows, 2_203);
  assert.equal(snapshot.completeness.entity_counts.lifecyclemodels, 0);
  assert.equal(snapshot.completeness.page_count, 9);
});

test('plan, apply, and verify fail closed when account pagination completeness is unproven', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-incomplete-pagination-'));
  try {
    const planningRemote = new FakeMaintenanceRemote('incomplete-plan');
    seed(planningRemote);
    const planningRoot = path.join(root, 'plan');
    mkdirSync(planningRoot, { recursive: true });
    const planningFiles = buildScopeFiles({
      root: planningRoot,
      remote: planningRemote,
    });
    await assert.rejects(
      () =>
        runDatasetMaintenancePlan({
          scopePath: planningFiles.scopePath,
          operation: 'repair-references',
          outDir: planningFiles.outDir,
          env: planningRemote.env,
          fetchImpl: stripMaintenanceContentRange(planningRemote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(existsSync(path.join(planningFiles.outDir, 'maintenance-plan.json')), false);

    const scenario = await prepareSeededScenario(root, 'apply-verify');
    const planPath = path.join(scenario.files.outDir, 'maintenance-plan.json');
    const rpcCount = scenario.remote.rpcOrder.length;
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath,
          commit: true,
          approvePlan: scenario.plan.plan_sha256,
          confirm: scenario.remote.email,
          env: scenario.remote.env,
          fetchImpl: stripMaintenanceContentRange(scenario.remote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(scenario.remote.rpcOrder.length, rpcCount);
    assert.equal(existsSync(path.join(scenario.files.outDir, 'approval-record.json')), false);

    const verifyOut = path.join(root, 'verify');
    await assert.rejects(
      () =>
        runDatasetMaintenanceVerify({
          planPath,
          outDir: verifyOut,
          env: scenario.remote.env,
          fetchImpl: stripMaintenanceContentRange(scenario.remote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(existsSync(path.join(verifyOut, 'readback-verify-report.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance contract validates every frozen scope guard and immutable artifact edge', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-contract-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-contract');
  try {
    assert.equal(isJsonObject({}), true);
    assert.equal(isJsonObject(null), false);
    assert.equal(isJsonObject([]), false);
    assert.deepEqual(stableJsonValue({ z: [2, { b: 1, a: 0 }], a: null }), {
      a: null,
      z: [2, { a: 0, b: 1 }],
    });
    assert.equal(stableJsonText({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(
      snapshotRemoteRow({
        table: 'contacts',
        id: 'id',
        version: '01.00.000',
        user_id: null,
        state_code: null,
        modified_at: null,
        json_ordered: null,
        model_id: null,
        rule_verification: null,
      }).payload_sha256,
      null,
    );
    assert.equal(
      maintenanceRowKey({ table: 'flows', id: 'id', version: '01.00.000' }),
      'flows\u0000id\u000001.00.000',
    );

    const invalidScopes: unknown[] = [
      null,
      {},
      scopeValue(remote, [null]),
      scopeValue(remote, [scopeAction(remote, { action: 'publish' })]),
      scopeValue(remote, [scopeAction(remote, { expected_state_code: 100 })]),
      scopeValue(remote, [scopeAction(remote, { expected_user_id: 'other' })]),
      scopeValue(remote, [scopeAction(remote, { evidence: 'no' })]),
      scopeValue(remote, [scopeAction(remote, { action: 'save_draft' })]),
      scopeValue(remote, [scopeAction(remote, { desired_payload_path: 'unexpected.json' })]),
      scopeValue(remote, [
        scopeAction(remote, {
          action: 'update_json_ordered',
          table: 'flows',
          batch_id: 'unexpected-batch',
        }),
      ]),
      scopeValue(remote, [scopeAction(remote, { expected_before_sha256: 'bad' })]),
      scopeValue(remote, [scopeAction(remote, { id: ' ' })]),
      scopeValue(remote, [scopeAction(remote)], { operation: 'unsupported' }),
      scopeValue(remote, [scopeAction(remote)], { target_mode: 'owner_draft' }),
      scopeValue(remote, []),
      scopeValue(remote, [scopeAction(remote), scopeAction(remote)]),
      scopeValue(remote, [
        scopeAction(remote, { action_id: 'one' }),
        scopeAction(remote, { action_id: 'two' }),
      ]),
      scopeValue(remote, [
        scopeAction(remote, { action_id: 'a/b' }),
        scopeAction(remote, {
          action_id: 'a_b',
          id: '66666666-6666-4666-8666-666666666666',
        }),
      ]),
    ];
    for (const invalid of invalidScopes) {
      assert.throws(() => parseMaintenanceScope(invalid));
    }
    assert.throws(
      () => parseMaintenanceScope(scopeValue(remote), 'repair-references'),
      /does not match requested/u,
    );
    const optional = parseMaintenanceScope(
      scopeValue(
        remote,
        [
          scopeAction(remote, {
            action: 'save_draft',
            desired_payload_path: 'payload.json',
            expected_before_sha256: 'a'.repeat(64),
          }),
        ],
        {
          account: { user_id: remote.userId, email: ' OWNER@EXAMPLE.COM ' },
          source_import_run_id: ' run ',
          source_lineage: { manifest: 'redo.json' },
        },
      ),
      'delete',
    );
    assert.equal(optional.account.email, 'OWNER@EXAMPLE.COM');
    assert.equal(optional.source_import_run_id, 'run');
    assert.deepEqual(optional.source_lineage, { manifest: 'redo.json' });

    const jsonPath = path.join(root, 'immutable.json');
    const jsonlPath = path.join(root, 'immutable.jsonl');
    assert.equal(writeImmutableJson(jsonPath, { b: 1, a: 2 }), path.resolve(jsonPath));
    assert.equal(writeImmutableJson(jsonPath, { a: 2, b: 1 }), path.resolve(jsonPath));
    assert.throws(() => writeImmutableJson(jsonPath, { a: 3 }), /immutable/u);
    assert.equal(writeImmutableJsonLines(jsonlPath, []), path.resolve(jsonlPath));
    assert.equal(writeImmutableJsonLines(jsonlPath, []), path.resolve(jsonlPath));
    const appendedPath = path.join(root, 'append.jsonl');
    appendStableJsonLine(appendedPath, { b: 1, a: 2 });
    assert.deepEqual(readJsonLinesIfPresent(appendedPath), [{ a: 2, b: 1 }]);
    assert.deepEqual(readJsonLinesIfPresent(path.join(root, 'missing.jsonl')), []);
    writeFileSync(path.join(root, 'bad.json'), '{bad');
    assert.throws(() => readJsonFile(path.join(root, 'missing.json'), 'Missing'), /not found/u);
    assert.throws(() => readJsonFile(path.join(root, 'bad.json'), 'Bad'), /not valid JSON/u);
    writeFileSync(path.join(root, 'bad.jsonl'), '{}\n{bad\n');
    assert.throws(() => readJsonLinesIfPresent(path.join(root, 'bad.jsonl')), /Invalid/u);
    assert.throws(() => parseMaintenancePlan({}), /valid schema_version/u);
    assert.throws(
      () =>
        parseMaintenancePlan({
          schema_version: 1,
          actions: [],
          protected_rows: [],
          blockers: [],
          account: {},
          artifacts: {},
          plan_sha256: 'bad',
        }),
      /hash does not match/u,
    );
    assert.equal(
      resolveMaintenancePlanArtifactPath(root, 'payloads/action.json', 'Desired payload'),
      path.join(root, 'payloads/action.json'),
    );
    for (const unsafePath of [
      '',
      path.resolve(root, 'absolute.json'),
      '.',
      '..',
      '../escape.json',
    ]) {
      assert.throws(
        () => resolveMaintenancePlanArtifactPath(root, unsafePath, 'Desired payload'),
        /must (?:be a relative path|stay inside)/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance plan parser rejects tampered action, snapshot, summary, and blocker contracts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-contract-'));
  try {
    const scenario = await prepareSeededScenario(root, 'valid-plan');
    const basePlan = structuredClone(scenario.plan);
    const invalidPlan = (
      mutate: (plan: DatasetMaintenancePlan) => void,
      message: RegExp = /invalid|inconsistent|protected or unsupported|does not match|must|unsupported/iu,
    ): void => {
      const plan = structuredClone(basePlan);
      mutate(plan);
      plan.plan_sha256 = computePlanSha256(plan);
      assert.throws(() => parseMaintenancePlan(plan), message);
    };

    const withImportRun = structuredClone(basePlan);
    withImportRun.source_import_run_id = 'bafu-import-run';
    withImportRun.plan_sha256 = computePlanSha256(withImportRun);
    assert.equal(parseMaintenancePlan(withImportRun).source_import_run_id, 'bafu-import-run');

    const legacyPlan = structuredClone(basePlan);
    delete legacyPlan.snapshot_completeness;
    legacyPlan.plan_sha256 = computePlanSha256(legacyPlan);
    assert.equal(parseMaintenancePlan(legacyPlan).snapshot_completeness, undefined);
    // Optional zero counters are inert in older ordinary v1 plans, but remain hash-bound.
    const withoutCounters = structuredClone(basePlan);
    for (const key of [
      'update_json_ordered',
      'atomic_batches',
      'scaled_exchanges',
      'scaled_amount_fields',
      'unrelated_exchanges_preserved',
    ] as const) {
      delete withoutCounters.summary[key];
      invalidPlan((plan) => {
        plan.summary[key] = 1;
      });
    }
    withoutCounters.plan_sha256 = computePlanSha256(withoutCounters);
    assert.deepEqual(parseMaintenancePlan(withoutCounters).summary, withoutCounters.summary);

    invalidPlan((plan) => {
      plan.snapshot_completeness!.complete = false as true;
    });
    invalidPlan((plan) => {
      plan.snapshot_completeness!.entity_counts.flows += 1;
    });
    invalidPlan((plan) => {
      Object.assign(plan.snapshot_completeness!, { entity_counts: [] });
    });
    invalidPlan((plan) => {
      Object.assign(plan.snapshot_completeness!.entity_counts, { flows: 'not-a-count' });
    });
    invalidPlan((plan) => {
      Object.assign(plan, { snapshot_completeness: null });
    });
    invalidPlan((plan) => {
      plan.snapshot_completeness!.tables[1]!.table = plan.snapshot_completeness!.tables[0]!.table;
    });

    invalidPlan((plan) => Object.assign(plan.actions[0]!, { table: 'unitgroups' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { expected_user_id: 'other-user' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { expected_state_code: 100 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { action: 'publish' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { ordinal: -1 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { status: 'unknown' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { blockers: 'not-an-array' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { rollback: null }));

    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { state_code: 100 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { user_id: 'other-user' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { json_ordered: null }));
    invalidPlan((plan) => {
      plan.actions[0]!.before!.row_sha256 = '0'.repeat(64);
    });
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { strategy: 'unknown' }));
    invalidPlan((plan) =>
      Object.assign(plan.actions[0]!.rollback, { before_payload_sha256: '0'.repeat(64) }),
    );
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { before_payload: null }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { before_payload: {} }));
    invalidPlan((plan) =>
      Object.assign(plan.actions[0]!.rollback, {
        model_id: '44444444-4444-4444-8444-444444444444',
      }),
    );
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { rule_verification: true }));
    invalidPlan((plan) => {
      const saveAction = plan.actions.find((action) => action.action === 'save_draft')!;
      saveAction.desired_payload = null;
    });
    invalidPlan((plan) => {
      const deleteAction = plan.actions.find((action) => action.action === 'delete')!;
      deleteAction.desired_payload = { path: 'unexpected.json', sha256: '0'.repeat(64) };
    });

    const summaryMutations: Array<(plan: DatasetMaintenancePlan) => void> = [
      (plan) => {
        plan.summary.actions += 1;
      },
      (plan) => {
        plan.summary.save_draft += 1;
      },
      (plan) => {
        plan.summary.delete += 1;
      },
      (plan) => {
        plan.summary.protected_rows += 1;
      },
      (plan) => {
        plan.summary.blockers += 1;
      },
      (plan) => {
        plan.summary.current_reference_impacts = -1;
      },
      (plan) => {
        plan.summary.current_reference_impacts = 0.5;
      },
      (plan) => {
        plan.summary.projected_reference_impacts = -1;
      },
      (plan) => {
        plan.summary.projected_reference_impacts = 0.5;
      },
    ];
    for (const mutate of summaryMutations) {
      invalidPlan(mutate, /status or blocker contract is inconsistent/u);
    }
    invalidPlan((plan) => {
      plan.status = 'blocked';
    }, /status or blocker contract is inconsistent/u);

    const blocker = {
      code: 'TEST_BLOCKER',
      message: 'test blocker',
      action_id: basePlan.actions[0]!.action_id,
      table: basePlan.actions[0]!.table,
      id: basePlan.actions[0]!.id,
      version: basePlan.actions[0]!.version,
    };
    const validBlockedPlan = structuredClone(basePlan);
    validBlockedPlan.status = 'blocked';
    validBlockedPlan.actions[0]!.status = 'blocked';
    validBlockedPlan.actions[0]!.blockers = [blocker];
    validBlockedPlan.blockers = [blocker];
    validBlockedPlan.summary.blockers = 1;
    validBlockedPlan.plan_sha256 = computePlanSha256(validBlockedPlan);
    assert.equal(parseMaintenancePlan(validBlockedPlan).status, 'blocked');

    const mismatchedBlockers = structuredClone(validBlockedPlan);
    mismatchedBlockers.blockers[0] = {
      ...mismatchedBlockers.blockers[0]!,
      message: 'different global blocker',
    };
    mismatchedBlockers.plan_sha256 = computePlanSha256(mismatchedBlockers);
    assert.throws(
      () => parseMaintenancePlan(mismatchedBlockers),
      /status or blocker contract is inconsistent/u,
    );

    const saveAction = basePlan.actions.find((action) => action.action === 'save_draft')!;
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(scenario.files.outDir, {
          ...saveAction,
          desired_payload: {
            path: '../escaped-payload.json',
            sha256: saveAction.desired_payload!.sha256,
          },
        }),
      /stay inside/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance apply guards reject artifact, preflight, approval, and just-in-time drift', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-apply-edges-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-apply-edges');
  seed(remote);
  const files = buildScopeFiles({ root, remote });
  const now = new Date('2026-07-11T00:00:00.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    const planDir = files.outDir;
    const context = await resolveMaintenanceRemoteContext({
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    const current = await fetchMaintenanceAccountRows({ context, userId: remote.userId });
    const emptyProgress = applyInternals.parseProgress(plan, path.join(root, 'no-progress.jsonl'));
    const saveAction = plan.actions.find((action) => action.action === 'save_draft')!;
    const deleteAction = plan.actions.find((action) => action.action === 'delete')!;

    assert.equal(applyInternals.clock({ now } as never), now.toISOString());
    assert.equal(typeof applyInternals.clock({} as never), 'string');
    assert.equal(applyInternals.errorMessage(new Error('error')), 'error');
    assert.equal(applyInternals.errorMessage('string-error'), 'string-error');
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(planDir, {
          ...saveAction,
          desired_payload: null,
        }),
      /lacks desired payload/u,
    );
    const wrongPayloadPath = path.join(planDir, 'payloads', 'wrong.json');
    writeFileSync(wrongPayloadPath, '{}');
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(planDir, {
          ...saveAction,
          desired_payload: { path: 'payloads/wrong.json', sha256: '0'.repeat(64) },
        }),
      /hash mismatch/u,
    );
    const invalidProgressPath = path.join(root, 'invalid-progress.jsonl');
    writeFileSync(invalidProgressPath, '{}\n');
    assert.throws(
      () => applyInternals.parseProgress(plan, invalidProgressPath),
      /invalid or foreign/u,
    );

    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: [
            ...current.rows,
            {
              ...current.rows[0]!,
              id: '77777777-7777-4777-8777-777777777777',
            },
          ],
          progress: emptyProgress,
        }),
      /Unexpected current-account row/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'flows'),
          progress: emptyProgress,
        }),
      /Protected row drifted/u,
    );
    const noBeforePlan = structuredClone(plan);
    noBeforePlan.actions[0]!.before = null;
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: noBeforePlan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'sources'),
          progress: emptyProgress,
        }),
      /lacks before snapshot/u,
    );
    const deleteSuccessProgress = applyInternals.parseProgress(
      plan,
      path.join(root, 'delete-success.jsonl'),
    );
    deleteSuccessProgress.successes.set(
      deleteAction.action_id,
      successProgressEntry(plan, deleteAction),
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows,
          progress: deleteSuccessProgress,
        }),
      /visible again/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'sources'),
          progress: emptyProgress,
        }),
      /missing, non-draft, or not owned/u,
    );
    const saveSuccessProgress = applyInternals.parseProgress(
      plan,
      path.join(root, 'save-success.jsonl'),
    );
    saveSuccessProgress.successes.set(saveAction.action_id, successProgressEntry(plan, saveAction));
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows,
          progress: saveSuccessProgress,
        }),
      /Previously saved row payload drifted/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.map((row) =>
            row.table === 'sources' ? { ...row, modified_at: 'changed' } : row,
          ),
          progress: emptyProgress,
        }),
      /Pending action row drifted/u,
    );
    const referenceDriftPlan = structuredClone(plan);
    referenceDriftPlan.projected_reference_sha256 = '0'.repeat(64);
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: referenceDriftPlan,
          planDir,
          currentRows: current.rows,
          progress: emptyProgress,
        }),
      /reference closure drifted/u,
    );
    const approvalPath = path.join(root, 'bad-approval.json');
    writeFileSync(approvalPath, '{}');
    assert.throws(
      () => applyInternals.validateApprovalRecord({ path: approvalPath, plan, context }),
      /does not match/u,
    );
    const validApproval = {
      plan_sha256: plan.plan_sha256,
      target_mode: plan.target_mode,
      account: context.account,
      snapshot_completeness: plan.snapshot_completeness,
    };
    writeFileSync(approvalPath, JSON.stringify(validApproval));
    applyInternals.validateApprovalRecord({ path: approvalPath, plan, context });
    writeFileSync(
      approvalPath,
      JSON.stringify({
        plan_sha256: plan.plan_sha256,
        target_mode: plan.target_mode,
        account: context.account,
      }),
    );
    assert.throws(
      () => applyInternals.validateApprovalRecord({ path: approvalPath, plan, context }),
      /does not match/u,
    );
    applyInternals.validateApprovalRecord({
      path: path.join(root, 'missing-approval.json'),
      plan,
      context,
    });

    const processRow = remote.rows.get('processes')!.find((row) => row.id === saveAction.id)!;
    processRow.modified_at = '2026-07-11T00:00:01.000Z';
    await assert.rejects(
      () => applyInternals.executeAction({ action: saveAction, plan, planDir, context }),
      /immediately before write/u,
    );
    assert.equal(remote.rpcOrder.length, 0);
    processRow.modified_at = saveAction.before!.modified_at;

    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: false,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /requires commit/u,
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: 'wrong',
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /exactly match/u,
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: 'wrong@example.com',
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /confirm must exactly match/u,
    );

    const redoPlan = structuredClone(plan);
    redoPlan.operation = 'redo-import';
    redoPlan.source_import_run_id = null;
    redoPlan.source_lineage = null;
    redoPlan.plan_sha256 = computePlanSha256(redoPlan);
    const redoPath = path.join(root, 'redo-plan.json');
    writeImmutableJson(redoPath, redoPlan);
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: redoPath,
          commit: true,
          approvePlan: redoPlan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /requires frozen redo/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance planning records target visibility, ownership, draft, payload, and identity blockers', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-edges-'));
  const now = new Date('2026-07-11T00:00:00.000Z');
  async function planScenario(
    label: string,
    remote: FakeMaintenanceRemote,
    scope: Record<string, unknown>,
    payload?: unknown,
  ): Promise<DatasetMaintenancePlan> {
    const scenario = path.join(root, label);
    mkdirSync(scenario, { recursive: true });
    const scopePath = path.join(scenario, 'scope.json');
    const desiredPath = path.join(scenario, 'desired.json');
    writeFileSync(scopePath, JSON.stringify(scope));
    if (payload !== undefined) writeFileSync(desiredPath, JSON.stringify(payload));
    return runDatasetMaintenancePlan({
      scopePath,
      operation: scope.operation as 'delete' | 'repair-references',
      outDir: path.join(scenario, 'out'),
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
  }
  try {
    const accountRemote = new FakeMaintenanceRemote('plan-account-mismatch');
    await assert.rejects(
      () =>
        planScenario(
          'account',
          accountRemote,
          scopeValue(accountRemote, [scopeAction(accountRemote, { expected_user_id: 'other' })], {
            account: { user_id: 'other' },
          }),
        ),
      /authenticated user does not match/u,
    );
    const emailRemote = new FakeMaintenanceRemote('plan-email-mismatch');
    await assert.rejects(
      () =>
        planScenario(
          'email',
          emailRemote,
          scopeValue(emailRemote, [scopeAction(emailRemote)], {
            account: { user_id: emailRemote.userId, email: 'wrong@example.com' },
          }),
        ),
      /authenticated email does not match/u,
    );

    const missingRemote = new FakeMaintenanceRemote('plan-missing');
    const missing = await planScenario('missing', missingRemote, scopeValue(missingRemote));
    assert.match(missing.blockers.map((entry) => entry.code).join(','), /TARGET_NOT_VISIBLE/u);
    assert.equal(missing.actions[0]?.before, null);

    const duplicateRemote = new FakeMaintenanceRemote('plan-duplicate');
    duplicateRemote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
    );
    duplicateRemote.duplicateExactLookup = true;
    const duplicate = await planScenario('duplicate', duplicateRemote, scopeValue(duplicateRemote));
    assert.match(duplicate.blockers.map((entry) => entry.code).join(','), /TARGET_NOT_UNIQUE/u);

    const protectedRemote = new FakeMaintenanceRemote('plan-protected');
    protectedRemote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
      { user_id: 'other', state_code: 100, json_ordered: null },
    );
    const protectedPlan = await planScenario(
      'protected',
      protectedRemote,
      scopeValue(protectedRemote, [
        scopeAction(protectedRemote, { expected_before_sha256: '0'.repeat(64) }),
      ]),
    );
    const protectedCodes = protectedPlan.blockers.map((entry) => entry.code).join(',');
    assert.match(protectedCodes, /TARGET_OWNER_MISMATCH/u);
    assert.match(protectedCodes, /TARGET_NOT_DRAFT/u);
    assert.match(protectedCodes, /TARGET_PAYLOAD_MISSING/u);
    assert.match(protectedCodes, /EXPECTED_BEFORE_HASH_MISMATCH/u);
    assert.match(protectedCodes, /SNAPSHOT_DRIFT/u);

    const desiredRemote = new FakeMaintenanceRemote('plan-desired');
    desiredRemote.add(
      'processes',
      '22222222-2222-4222-8222-222222222222',
      processPayload({ id: '22222222-2222-4222-8222-222222222222', version: '01.00.000' }),
    );
    const desiredAction = scopeAction(desiredRemote, {
      action_id: 'save',
      action: 'save_draft',
      table: 'processes',
      id: '22222222-2222-4222-8222-222222222222',
      desired_payload_path: 'desired.json',
    });
    await assert.rejects(
      () =>
        planScenario(
          'desired-invalid',
          desiredRemote,
          scopeValue(desiredRemote, [desiredAction]),
          [],
        ),
      /must be a JSON object/u,
    );
    const wrongIdentity = await planScenario(
      'desired-identity',
      desiredRemote,
      scopeValue(desiredRemote, [desiredAction]),
      processPayload({ id: 'wrong-id', version: '01.00.000' }),
    );
    assert.match(
      wrongIdentity.blockers.map((entry) => entry.code).join(','),
      /DESIRED_PAYLOAD_IDENTITY_MISMATCH/u,
    );
    assert.equal(wrongIdentity.protected_rows[0]?.reason, 'blocked_action_row');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance internals preserve canonical hashes and detect deleted-target references', () => {
  const row: DatasetMaintenanceRemoteRow = {
    table: 'processes',
    id: 'proc',
    version: '01.00.000',
    user_id: 'user',
    state_code: 0,
    modified_at: null,
    json_ordered: processPayload({
      id: 'proc',
      version: '01.00.000',
      sourceId: 'source',
    }),
    model_id: null,
    rule_verification: null,
  };
  const action = {
    action_id: 'delete',
    action: 'delete' as const,
    table: 'sources' as const,
    id: 'source',
    version: '01.00.000',
    expected_user_id: 'user',
    expected_state_code: 0 as const,
    reason_code: 'test',
    reason: 'test',
    evidence: [],
    ordinal: 0,
    status: 'ready' as const,
    before: null,
    desired_payload: null,
    blockers: [],
    rollback: {
      strategy: 'restore_deleted_before_snapshot' as const,
      before_payload_sha256: null,
      before_payload: null,
      model_id: null,
      rule_verification: null,
    },
  };
  assert.equal(snapshotRemoteRow(row).row_sha256.length, 64);
  assert.equal(
    planInternals.referenceImpacts({ rows: [row], deletes: [action], phase: 'current' }).length,
    1,
  );
  assert.equal(
    verifyInternals.deletedTargetReferences({ rows: [row], deletes: [action] }).length,
    1,
  );
  assert.equal(typeof applyInternals.parseProgress, 'function');
});

test('maintenance planning and remote helpers cover sparse references and runtime fallbacks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-fallbacks-'));
  const remote = new FakeMaintenanceRemote('plan-runtime-fallbacks');
  try {
    assert.deepEqual(planInternals.desiredPayloadIdentity({}), { id: null, version: null });

    const unsupportedReferenceRow: DatasetMaintenanceRemoteRow = {
      table: 'processes',
      id: 'unsupported-reference',
      version: '01.00.000',
      user_id: remote.userId,
      state_code: 0,
      modified_at: null,
      json_ordered: {
        processDataSet: {
          customReference: { '@refObjectId': 'source-without-a-table-hint' },
        },
      },
      model_id: null,
      rule_verification: null,
    };
    const deleteAction = scopeAction(remote);
    assert.deepEqual(
      planInternals.referenceImpacts({
        rows: [unsupportedReferenceRow],
        deletes: [deleteAction],
        phase: 'current',
      }),
      [],
    );
    assert.deepEqual(
      verifyInternals.deletedTargetReferences({
        rows: [unsupportedReferenceRow],
        deletes: [
          {
            ...deleteAction,
            ordinal: 0,
            status: 'ready',
            before: null,
            desired_payload: null,
            blockers: [],
            rollback: {
              strategy: 'restore_deleted_before_snapshot',
              before_payload_sha256: null,
              before_payload: null,
              model_id: null,
              rule_verification: null,
            },
          } as DatasetMaintenancePlanAction,
        ],
      }),
      [],
    );

    const referencedRows = ['process-b', 'process-a'].map((id): DatasetMaintenanceRemoteRow => ({
      table: 'processes',
      id,
      version: '01.00.000',
      user_id: remote.userId,
      state_code: 0,
      modified_at: null,
      json_ordered: processPayload({
        id,
        version: '01.00.000',
        sourceId: '33333333-3333-4333-8333-333333333333',
      }),
      model_id: null,
      rule_verification: null,
    }));
    const sortedImpacts = planInternals.referenceImpacts({
      rows: referencedRows,
      deletes: [deleteAction],
      phase: 'current',
    });
    assert.deepEqual(
      sortedImpacts.map((impact) => impact.source_id),
      ['process-a', 'process-b'],
    );

    remote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
    );
    const scopePath = path.join(root, 'scope.json');
    writeFileSync(scopePath, JSON.stringify(scopeValue(remote)));
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'delete',
      outDir: path.join(root, 'out'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.match(plan.generated_at_utc, /^\d{4}-\d{2}-\d{2}T/u);

    const nonObjectUserRemote = new FakeMaintenanceRemote('non-object-current-user');
    await assert.rejects(
      () =>
        resolveMaintenanceRemoteContext({
          env: nonObjectUserRemote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse([])
              : nonObjectUserRemote.fetch(input, init),
        }),
      /did not return id and email/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance apply defensively records resume, readback, actor, redo, and pending edges', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-apply-defensive-'));
  try {
    const resume = await prepareSeededScenario(root, 'resume-delete');
    const saveAction = resume.plan.actions.find((action) => action.action === 'save_draft')!;
    const deleteAction = resume.plan.actions.find((action) => action.action === 'delete')!;
    const current = await fetchMaintenanceAccountRows({
      context: resume.context,
      userId: resume.remote.userId,
    });
    const resumedProgress = applyInternals.parseProgress(
      resume.plan,
      path.join(root, 'missing-progress.jsonl'),
    );
    resumedProgress.successes.set(
      deleteAction.action_id,
      successProgressEntry(resume.plan, deleteAction),
    );
    applyInternals.assertApplyPreconditions({
      plan: resume.plan,
      planDir: resume.files.outDir,
      currentRows: current.rows.filter((row) => row.table !== 'sources'),
      progress: resumedProgress,
    });

    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: { ...saveAction, before: null },
          plan: resume.plan,
          planDir: resume.files.outDir,
          context: resume.context,
        }),
      /lacks a before snapshot/u,
    );
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: {
            ...saveAction,
            id: 'missing-row',
          },
          plan: resume.plan,
          planDir: resume.files.outDir,
          context: resume.context,
        }),
      /immediately before write/u,
    );

    const fallback = await prepareSeededScenario(root, 'optional-before-metadata');
    const fallbackAction = fallback.plan.actions.find((action) => action.action === 'save_draft')!;
    let beforeReads = 0;
    const actionWithVanishingOptionalMetadata = { ...fallbackAction };
    Object.defineProperty(actionWithVanishingOptionalMetadata, 'before', {
      enumerable: true,
      get() {
        beforeReads += 1;
        return beforeReads <= 2 ? fallbackAction.before : null;
      },
    });
    const fallbackResult = await applyInternals.executeAction({
      action: actionWithVanishingOptionalMetadata,
      plan: fallback.plan,
      planDir: fallback.files.outDir,
      context: fallback.context,
    });
    assert.equal(fallbackResult.afterSha256?.length, 64);
    assert.equal(beforeReads, 4);

    const missingReadback = await prepareSeededScenario(root, 'missing-save-readback');
    const missingReadbackAction = missingReadback.plan.actions.find(
      (action) => action.action === 'save_draft',
    )!;
    const missingReadbackContext = {
      ...missingReadback.context,
      fetch_impl: (async (input, init) => {
        const response = await missingReadback.remote.fetch(input, init);
        if (String(input).includes('/rpc/cmd_dataset_save_draft')) {
          missingReadback.remote.rows.set('processes', []);
        }
        return response;
      }) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: missingReadbackAction,
          plan: missingReadback.plan,
          planDir: missingReadback.files.outDir,
          context: missingReadbackContext,
        }),
      /save_draft readback failed/u,
    );

    const mismatchReadback = await prepareSeededScenario(root, 'mismatch-save-readback');
    const mismatchAction = mismatchReadback.plan.actions.find(
      (action) => action.action === 'save_draft',
    )!;
    const mismatchContext = {
      ...mismatchReadback.context,
      fetch_impl: (async (input, init) => {
        const response = await mismatchReadback.remote.fetch(input, init);
        if (String(input).includes('/rpc/cmd_dataset_save_draft')) {
          mismatchReadback.remote.rows.get('processes')![0]!.state_code = 100;
        }
        return response;
      }) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: mismatchAction,
          plan: mismatchReadback.plan,
          planDir: mismatchReadback.files.outDir,
          context: mismatchContext,
        }),
      /save_draft readback mismatch/u,
    );

    const deleteReadback = await prepareSeededScenario(root, 'delete-readback');
    const deleteReadbackAction = deleteReadback.plan.actions.find(
      (action) => action.action === 'delete',
    )!;
    const deleteReadbackContext = {
      ...deleteReadback.context,
      fetch_impl: (async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_delete')
          ? jsonResponse({ ok: true })
          : deleteReadback.remote.fetch(input, init)) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: deleteReadbackAction,
          plan: deleteReadback.plan,
          planDir: deleteReadback.files.outDir,
          context: deleteReadbackContext,
        }),
      /delete readback failed/u,
    );

    const actorMismatch = await prepareSeededScenario(root, 'actor-mismatch');
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(actorMismatch.files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: actorMismatch.plan.plan_sha256,
          confirm: actorMismatch.remote.email,
          env: actorMismatch.remote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse({ id: actorMismatch.remote.userId, email: 'other@example.com' })
              : actorMismatch.remote.fetch(input, init),
        }),
      /does not match the maintenance plan/u,
    );

    const pending = await prepareSeededScenario(root, 'pending-after-failure');
    const pendingReport = await runDatasetMaintenanceApply({
      planPath: path.join(pending.files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: pending.plan.plan_sha256,
      confirm: pending.remote.email,
      env: pending.remote.env,
      fetchImpl: async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_save_draft')
          ? jsonResponse({ message: 'save failed' }, 500)
          : pending.remote.fetch(input, init),
    });
    assert.deepEqual(
      pendingReport.actions.map((action) => action.status),
      ['pending', 'failed'],
    );

    const redoRoot = path.join(root, 'redo-delete');
    mkdirSync(redoRoot, { recursive: true });
    const redoRemote = new FakeMaintenanceRemote('redo-delete');
    for (const id of [
      '33333333-3333-4333-8333-333333333333',
      '66666666-6666-4666-8666-666666666666',
    ]) {
      redoRemote.add('sources', id, sourcePayload(id));
    }
    const redoScopePath = path.join(redoRoot, 'scope.json');
    writeFileSync(
      redoScopePath,
      JSON.stringify(
        scopeValue(redoRemote, [
          scopeAction(redoRemote),
          scopeAction(redoRemote, {
            action_id: 'delete-source-2',
            id: '66666666-6666-4666-8666-666666666666',
          }),
        ]),
      ),
    );
    const deletePlan = await runDatasetMaintenancePlan({
      scopePath: redoScopePath,
      operation: 'delete',
      outDir: path.join(redoRoot, 'planned'),
      env: redoRemote.env,
      fetchImpl: redoRemote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    const redoPlan = structuredClone(deletePlan);
    redoPlan.operation = 'redo-import';
    redoPlan.source_import_run_id = null;
    redoPlan.source_lineage = { manifest: 'bafu-redo-source-manifest.json' };
    redoPlan.plan_sha256 = computePlanSha256(redoPlan);
    const redoPlanPath = path.join(redoRoot, 'apply', 'maintenance-plan.json');
    writeImmutableJson(redoPlanPath, redoPlan);
    const redoReport = await runDatasetMaintenanceApply({
      planPath: redoPlanPath,
      commit: true,
      approvePlan: redoPlan.plan_sha256,
      confirm: redoRemote.email,
      env: redoRemote.env,
      fetchImpl: redoRemote.fetch,
    });
    assert.equal(redoReport.status, 'completed');
    assert.match(
      readFileSync(path.join(path.dirname(redoPlanPath), 'approval-record.json'), 'utf8'),
      /"redo_rows_ready":true/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance verify reports every incomplete readback proof without mutating rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-verify-defensive-'));
  try {
    const scenario = await prepareSeededScenario(root, 'pre-apply');
    const planPath = path.join(scenario.files.outDir, 'maintenance-plan.json');
    const report = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-before-apply'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    const codes = report.issues.map((entry) => entry.code).join(',');
    assert.match(codes, /DELETE_TARGET_STILL_VISIBLE/u);
    assert.match(codes, /SAVE_DRAFT_READBACK_MISMATCH/u);
    assert.match(codes, /PROJECTED_REFERENCE_CLOSURE_MISMATCH/u);
    assert.match(codes, /DELETED_TARGET_REFERENCED/u);
    assert.match(codes, /ACTION_SUCCESS_LOG_MISSING/u);
    assert.match(codes, /COMMIT_REPORT_MISSING/u);

    const invalidApprovalCompleteness = structuredClone(scenario.plan.snapshot_completeness!);
    invalidApprovalCompleteness.tables[1]!.table = invalidApprovalCompleteness.tables[0]!.table;
    writeFileSync(
      path.join(scenario.files.outDir, 'approval-record.json'),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: scenario.plan.plan_sha256,
        task_id: scenario.plan.task_id,
        operation: scenario.plan.operation,
        operation_id: scenario.plan.operation_id,
        target_mode: scenario.plan.target_mode,
        account: scenario.plan.account,
        confirmed_email: scenario.plan.account.email,
        row_counts: scenario.plan.summary,
        snapshot_completeness: invalidApprovalCompleteness,
      }),
    );
    const malformedRollbackEntry = {
      ...successProgressEntry(scenario.plan, scenario.plan.actions[0]!),
      rollback: null,
    };
    writeFileSync(
      path.join(scenario.files.outDir, 'apply-progress.jsonl'),
      [
        'null',
        '{"action_id":"foreign-action"}',
        '{"action_id":"delete-source"}',
        JSON.stringify(malformedRollbackEntry),
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(scenario.files.outDir, 'commit-report.json'), '{}');
    const invalidProofReport = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-invalid-proof-chain'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    const invalidProofCodes = invalidProofReport.issues.map((entry) => entry.code).join(',');
    assert.match(invalidProofCodes, /APPROVAL_RECORD_INVALID/u);
    assert.match(invalidProofCodes, /APPLY_PROGRESS_ENTRY_INVALID/u);
    assert.match(invalidProofCodes, /COMMIT_REPORT_INCOMPLETE/u);

    scenario.remote.rows.set('flows', []);
    scenario.remote.rows.set('processes', []);
    const protectedReport = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-protected-change'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    assert.match(
      protectedReport.issues.map((entry) => entry.code).join(','),
      /PROTECTED_ROW_CHANGED/u,
    );

    await assert.rejects(
      () =>
        runDatasetMaintenanceVerify({
          planPath,
          env: scenario.remote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse({ id: scenario.remote.userId, email: 'other@example.com' })
              : scenario.remote.fetch(input, init),
        }),
      /does not match the maintenance plan/u,
    );

    assert.deepEqual(verifyInternals.issue('CODE', 'message'), {
      code: 'CODE',
      message: 'message',
    });
    assert.deepEqual(verifyInternals.issue('CODE', 'message', undefined, { detail: true }), {
      code: 'CODE',
      message: 'message',
      details: { detail: true },
    });
    const saveAction = scenario.plan.actions.find((action) => action.action === 'save_draft')!;
    assert.equal(
      verifyInternals.desiredPayload(scenario.files.outDir, {
        ...saveAction,
        desired_payload: null,
      }),
      null,
    );
    const invalidPayloadPath = path.join(scenario.files.outDir, 'payloads', 'invalid.json');
    writeFileSync(invalidPayloadPath, '[]');
    assert.equal(
      verifyInternals.desiredPayload(scenario.files.outDir, {
        ...saveAction,
        desired_payload: {
          path: 'payloads/invalid.json',
          sha256: '0'.repeat(64),
        },
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary maintenance verify rejects duplicate success proofs without replaying mutations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-duplicate-proof-'));
  try {
    const scenario = await prepareSeededScenario(root, 'duplicate');
    const planPath = path.join(scenario.files.outDir, 'maintenance-plan.json');
    const applied = await runDatasetMaintenanceApply({
      planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    assert.equal(applied.status, 'completed');
    const progressPath = path.join(scenario.files.outDir, 'apply-progress.jsonl');
    const progress = readJsonLinesIfPresent(progressPath);
    writeFileSync(
      progressPath,
      [...progress, progress[0]].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    const mutations = scenario.remote.rpcOrder.length;
    const report = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verified'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    assert.ok(report.issues.some((issue) => issue.code === 'APPLY_PROGRESS_SUCCESS_DUPLICATE'));
    assert.equal(report.status, 'failed');
    assert.equal(scenario.remote.rpcOrder.length, mutations);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
