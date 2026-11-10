import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals as applyInternals,
  runDatasetMaintenanceApply,
} from '../src/lib/maintenance/apply.js';
import { computePlanSha256, parseMaintenancePlan } from '../src/lib/maintenance/contract.js';
import { sha256Json, sha256Text } from '../src/lib/platform/canonical-json-hash.js';
import { parseMaintenanceScope } from '../src/lib/maintenance/contract/scope.js';
import { readJsonLinesIfPresent } from '../src/lib/maintenance/contract/files.js';
import {
  type DatasetMaintenancePlan,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import {
  buildDerivativePlanRequest,
  derivativePlanAction,
  derivativeStatusCategory,
  parseDerivativeSnapshotResponse,
  parseDerivativeStatusResponse,
  parseDerivativeSubmitResponse,
} from '../src/lib/maintenance/derivatives.js';
import { runDatasetMaintenancePlan } from '../src/lib/maintenance/plan.js';
import {
  applyMaintenanceDerivativeRebuild,
  fetchMaintenanceDerivativeSnapshot,
  readMaintenanceDerivativeRebuild,
  resolveMaintenanceRemoteContext,
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

const USER_ID = 'user-1';
const EMAIL = 'user@example.com';
const PROCESS_ID = '57ff1043-7376-3321-b0d5-b0bf47cf9062';
const VERSION = '00.00.001';
const MODIFIED_AT = '2026-07-14T01:00:00.000Z';
const BASE_EMBEDDING_AT = '2026-07-13T01:00:00.000Z';
const COMPLETED_EMBEDDING_AT = '2026-07-14T02:00:00.000Z';

function response(body: unknown, status = 200, contentRange?: string): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        if (name.toLowerCase() === 'content-range') {
          return (
            contentRange ??
            (Array.isArray(body) && body.length ? `0-${body.length - 1}/${body.length}` : '*/0')
          );
        }
        return null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    },
  };
}

class DerivativeRemote {
  readonly env = buildSupabaseTestEnv();
  readonly calls: Array<{ url: string; method: string; body: JsonObject | null }> = [];
  readonly primary = {
    id: PROCESS_ID,
    version: VERSION,
    user_id: USER_ID,
    state_code: 0,
    modified_at: MODIFIED_AT,
    json_ordered: {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': PROCESS_ID } },
      },
    },
    model_id: null,
    rule_verification: false,
  };
  snapshotJsonSha: string | null = null;
  extractedMdSha: string | null = sha256Text('same deterministic markdown');
  embeddingSha: string | null = sha256Text('same deterministic embedding');
  embeddingAt: string | null = BASE_EMBEDDING_AT;
  status:
    | 'queued'
    | 'dispatching'
    | 'markdown_pending'
    | 'embedding_pending'
    | 'completed'
    | 'stale'
    | 'failed' = 'queued';
  admitted = false;
  loseNextAdmissionResponse = false;
  fenceState = 'held';
  requestId = '11111111-1111-1111-1111-111111111111';
  otherProcesses: JsonObject[] = [];

  snapshot(): JsonObject {
    const jsonSha = this.snapshotJsonSha ?? sha256Json(this.primary.json_ordered);
    const fields = {
      schema_version: 'dataset-derivative-snapshot.v1',
      table: 'processes',
      id: PROCESS_ID,
      version: VERSION,
      user_id: USER_ID,
      state_code: 0,
      modified_at: this.primary.modified_at,
      json_sha256: jsonSha,
      json_ordered_sha256: jsonSha,
      extracted_md_sha256: this.extractedMdSha,
      embedding_ft_sha256: this.embeddingSha,
      embedding_ft_at: this.embeddingAt,
    };
    return {
      ok: true,
      command: 'cmd_dataset_derivative_rebuild_snapshot',
      ...fields,
      snapshot_sha256: sha256Json(fields),
    };
  }

  submitProof(idempotentReplay: boolean): JsonObject {
    return {
      ok: true,
      command: 'cmd_dataset_derivative_rebuild_plan_guarded',
      schema_version: 'dataset-derivative-rebuild-plan.v1',
      plan_sha256: this.lastPlanSha,
      operation_id: this.lastOperationId,
      target_visibility: 'owner_draft',
      plan_request_sha256: sha256Text('plan-request'),
      idempotent_replay: idempotentReplay,
      action_count: 1,
      accepted_count: 1,
      summary_audit_id: '9007199254740993',
      request_id: this.requestId,
      status: 'queued',
      action_request_sha256: sha256Text('action-request'),
      database_audit_id: '9007199254740994',
    };
  }

  lastPlanSha = '';
  lastOperationId = '';

  statusProof(): JsonObject {
    const snapshot = this.snapshot();
    const completed = this.status === 'completed';
    return {
      ok: true,
      command: 'cmd_dataset_derivative_rebuild_read',
      schema_version: 'dataset-derivative-rebuild-status.v1',
      request_id: this.requestId,
      plan_sha256: this.lastPlanSha,
      operation_id: this.lastOperationId,
      action_id: 'rebuild-one-process',
      table: 'processes',
      id: PROCESS_ID,
      version: VERSION,
      status: this.status,
      phase: this.status,
      fence_active: this.fenceState !== 'released',
      plan_request_sha256: sha256Text('plan-request'),
      action_request_sha256: sha256Text('action-request'),
      database_audit_id: '9007199254740994',
      summary_audit_id: '9007199254740993',
      completed_snapshot_sha256: completed ? snapshot.snapshot_sha256 : null,
      completed_at: completed ? '2026-07-14T02:01:00.000Z' : null,
      error: ['stale', 'failed'].includes(this.status)
        ? { code: 'DERIVATIVE_EXECUTION_FAILED' }
        : null,
      primary_write_fence: {
        state: this.fenceState,
        released_at: this.fenceState === 'released' ? '2026-07-14T02:02:00.000Z' : null,
        timeout_uncertain: this.fenceState === 'uncertain',
      },
    };
  }

  fetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
    const parsed = new URL(url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as JsonObject) : null;
    this.calls.push({ url, method: String(init?.method ?? 'GET'), body });
    if (parsed.pathname.endsWith('/auth/v1/user')) {
      return response({ id: USER_ID, email: EMAIL });
    }
    if (parsed.pathname.endsWith('/rpc/cmd_dataset_derivative_rebuild_snapshot')) {
      return response(this.snapshot());
    }
    if (parsed.pathname.endsWith('/rpc/cmd_dataset_derivative_rebuild_plan_guarded')) {
      const request = body?.p_plan as JsonObject;
      this.lastPlanSha = String(request.plan_sha256);
      this.lastOperationId = String(request.operation_id);
      const replay = this.admitted;
      this.admitted = true;
      if (this.loseNextAdmissionResponse) {
        this.loseNextAdmissionResponse = false;
        return response({ ok: false, code: 'LOST_RESPONSE' }, 504);
      }
      return response(this.submitProof(replay));
    }
    if (parsed.pathname.endsWith('/rpc/cmd_dataset_derivative_rebuild_read')) {
      return response(this.statusProof());
    }
    const table = parsed.pathname.split('/').at(-1)!;
    let visible = table === 'processes' ? [{ ...this.primary }, ...this.otherProcesses] : [];
    const idFilter = parsed.searchParams.get('id');
    const versionFilter = parsed.searchParams.get('version');
    if (idFilter?.startsWith('eq.')) {
      visible = visible.filter((row) => row.id === idFilter.slice(3));
    }
    if (versionFilter?.startsWith('eq.')) {
      visible = visible.filter((row) => row.version === versionFilter.slice(3));
    }
    const offset = Number.parseInt(parsed.searchParams.get('offset') ?? '0', 10);
    const limit = Number.parseInt(parsed.searchParams.get('limit') ?? '1000', 10);
    const page = visible.slice(offset, offset + limit);
    const contentRange = page.length
      ? `${offset}-${offset + page.length - 1}/${visible.length}`
      : '*/0';
    return response(page, 200, contentRange);
  };
}

function scope(): JsonObject {
  return {
    schema_version: 1,
    task_id: 'issue-165-test',
    operation: 'rebuild-derivatives',
    target_mode: 'owner_draft',
    account: { user_id: USER_ID, email: EMAIL },
    actions: [
      {
        action_id: 'rebuild-one-process',
        action: 'rebuild_derivatives',
        table: 'processes',
        id: PROCESS_ID,
        version: VERSION,
        expected_user_id: USER_ID,
        expected_state_code: 0,
        reason_code: 'STALE_DERIVATIVE',
        reason: 'Rebuild stale markdown and vector derivatives.',
        evidence: [{ source: 'readback' }],
        components: ['extracted_md', 'embedding_ft'],
      },
    ],
  };
}

function ordinaryDeleteScope(): JsonObject {
  const value = scope();
  value.operation = 'delete';
  delete value.target_mode;
  const action = (value.actions as JsonObject[])[0]!;
  action.action = 'delete';
  delete action.components;
  return value;
}

function processRow(id: string, options: { reference?: boolean } = {}): JsonObject {
  return {
    id,
    version: VERSION,
    user_id: USER_ID,
    state_code: 0,
    modified_at: MODIFIED_AT,
    json_ordered: {
      processDataSet: {
        processInformation: { dataSetInformation: { 'common:UUID': id } },
        ...(options.reference
          ? {
              exchanges: {
                exchange: {
                  referenceToFlowDataSet: {
                    '@refObjectId': '00000000-0000-4000-8000-000000000001',
                    '@type': 'flow data set',
                    '@uri': '../flows/00000000-0000-4000-8000-000000000001.json',
                    '@version': VERSION,
                  },
                },
              },
            }
          : {}),
      },
    },
    model_id: null,
    rule_verification: false,
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

async function makePlan(root: string, remote: DerivativeRemote): Promise<DatasetMaintenancePlan> {
  mkdirSync(root, { recursive: true });
  const scopePath = path.join(root, 'scope.json');
  writeFileSync(scopePath, `${JSON.stringify(scope())}\n`);
  return runDatasetMaintenancePlan({
    scopePath,
    operation: 'rebuild-derivatives',
    outDir: root,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-14T01:10:00.000Z'),
  });
}

async function applyPlan(root: string, plan: DatasetMaintenancePlan, remote: DerivativeRemote) {
  return runDatasetMaintenanceApply({
    planPath: path.join(root, 'maintenance-plan.json'),
    commit: true,
    approvePlan: plan.plan_sha256,
    confirm: EMAIL,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-14T01:20:00.000Z'),
  });
}

test('derivative maintenance plans one exact owner-draft process without widening account scans', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-plan-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.summary.rebuild_derivatives, 1);
    assert.equal(plan.summary.save_draft, 0);
    assert.equal(plan.summary.delete, 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.target_mode, 'owner_draft');
    assert.equal(plan.artifacts.derivative_baseline, 'derivative-baseline.json');
    assert.equal(
      derivativePlanAction(plan).derivative_before?.schema_version,
      'dataset-derivative-snapshot.v1',
    );
    assert.equal(parseMaintenancePlan(plan).plan_sha256, plan.plan_sha256);
    const baselinePath = path.join(root, 'derivative-baseline.json');
    assert.ok(existsSync(baselinePath));
    assert.deepEqual(
      JSON.parse(readFileSync(baselinePath, 'utf8')),
      derivativePlanAction(plan).derivative_before,
    );
    const tableUrls = remote.calls
      .filter((call) => call.url.includes('/rest/v1/') && !call.url.includes('/rpc/'))
      .map((call) => call.url);
    assert.ok(
      tableUrls.every((url) => !url.includes('embedding_ft') && !url.includes('extracted_md')),
    );
    const request = buildDerivativePlanRequest(plan);
    assert.deepEqual(Object.keys(request).sort(), [
      'actions',
      'operation_id',
      'plan_sha256',
      'schema_version',
      'target_visibility',
    ]);
    assert.deepEqual((request.actions as JsonObject[])[0]?.components, [
      'extracted_md',
      'embedding_ft',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative apply records queued admission only and replays one durable request', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-apply-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    const first = await applyPlan(root, plan, remote);
    assert.equal(first.status, 'accepted');
    assert.equal(first.summary.success, 0);
    assert.equal(first.summary.pending, 1);
    assert.equal(first.derivative_admission?.status, 'queued');
    assert.equal(first.derivative_admission?.admission, 'accepted');
    assert.ok(existsSync(path.join(root, 'derivative-admission-attempt.json')));
    const replay = await applyPlan(root, plan, remote);
    assert.equal(replay.status, 'accepted');
    assert.equal(replay.derivative_admission?.idempotent_replay, true);
    const entries = readJsonLinesIfPresent(path.join(root, 'derivative-submit-progress.jsonl'));
    assert.equal(entries.length, 2);
    const planCalls = remote.calls.filter((call) =>
      call.url.endsWith('/rpc/cmd_dataset_derivative_rebuild_plan_guarded'),
    );
    assert.equal(planCalls.length, 2);
    assert.deepEqual(Object.keys(planCalls[0]?.body ?? {}), ['p_plan']);
    assert.equal(
      remote.calls.some(
        (call) =>
          call.url.includes('/functions/v1/') ||
          call.url.includes('embedding-run') ||
          call.url.includes('/queue'),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative apply blocks first-admission snapshot drift but recovers a lost admitted response', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-replay-'));
  try {
    const driftRemote = new DerivativeRemote();
    const driftPlan = await makePlan(path.join(root, 'drift'), driftRemote);
    driftRemote.embeddingAt = '2026-07-14T01:15:00.000Z';
    await assert.rejects(
      () => applyPlan(path.join(root, 'drift'), driftPlan, driftRemote),
      /snapshot drifted before first admission/u,
    );
    assert.ok(existsSync(path.join(root, 'drift', 'approval-record.json')));
    assert.equal(existsSync(path.join(root, 'drift', 'derivative-admission-attempt.json')), false);
    await assert.rejects(
      () => applyPlan(path.join(root, 'drift'), driftPlan, driftRemote),
      /snapshot drifted before first admission/u,
    );
    assert.equal(
      driftRemote.calls.filter((call) =>
        call.url.endsWith('/rpc/cmd_dataset_derivative_rebuild_plan_guarded'),
      ).length,
      0,
    );

    const replayRemote = new DerivativeRemote();
    const replayRoot = path.join(root, 'replay');
    const replayPlan = await makePlan(replayRoot, replayRemote);
    replayRemote.loseNextAdmissionResponse = true;
    await assert.rejects(() => applyPlan(replayRoot, replayPlan, replayRemote), /HTTP 504/u);
    assert.ok(existsSync(path.join(replayRoot, 'approval-record.json')));
    assert.ok(existsSync(path.join(replayRoot, 'derivative-admission-attempt.json')));
    replayRemote.embeddingAt = COMPLETED_EMBEDDING_AT;
    const recovered = await applyPlan(replayRoot, replayPlan, replayRemote);
    assert.equal(recovered.status, 'accepted');
    assert.equal(recovered.derivative_admission?.idempotent_replay, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative verify independently distinguishes pending, passed same-output rebuild, and failed fence uncertainty', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-verify-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    await applyPlan(root, plan, remote);

    const pending = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'maintenance-plan.json'),
      outDir: path.join(root, 'verify-pending'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.action_checks[0]?.observed, 'derivative_pending');

    remote.status = 'completed';
    remote.embeddingAt = COMPLETED_EMBEDDING_AT;
    remote.fenceState = 'released';
    const passed = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'maintenance-plan.json'),
      outDir: path.join(root, 'verify-passed'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(passed.status, 'passed');
    assert.equal(passed.action_checks[0]?.observed, 'derivative_current');
    assert.equal(passed.derivative_status?.raw_evidence.primary_write_fence !== undefined, true);
    assert.match(passed.derivative_status?.note ?? '', /does not imply/u);

    remote.status = 'failed';
    remote.fenceState = 'uncertain';
    const failed = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'maintenance-plan.json'),
      outDir: path.join(root, 'verify-failed'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.issues.some((entry) => entry.code === 'DERIVATIVE_REQUEST_FAILED'));
    assert.deepEqual(failed.derivative_status?.raw_evidence.primary_write_fence, {
      state: 'uncertain',
      released_at: null,
      timeout_uncertain: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative scope and RPC proof parsers reject widened or malformed contracts', async () => {
  const valid = scope();
  assert.equal(parseMaintenanceScope(valid).operation, 'rebuild-derivatives');
  for (const mutation of [
    { actions: [] },
    { target_mode: undefined },
    { action: 'save_draft' },
    { table: 'flows' },
    { components: ['embedding_ft', 'extracted_md'] },
    { components: ['extracted_md'] },
  ]) {
    const candidate = structuredClone(valid);
    if ('actions' in mutation) candidate.actions = mutation.actions;
    if ('target_mode' in mutation) delete candidate.target_mode;
    if ('action' in mutation) (candidate.actions as JsonObject[])[0]!.action = mutation.action;
    if ('table' in mutation) (candidate.actions as JsonObject[])[0]!.table = mutation.table;
    if ('components' in mutation)
      (candidate.actions as JsonObject[])[0]!.components = mutation.components;
    assert.throws(() => parseMaintenanceScope(candidate));
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-parser-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    remote.lastPlanSha = plan.plan_sha256;
    remote.lastOperationId = plan.operation_id;
    const snapshot = remote.snapshot();
    assert.equal(
      parseDerivativeSnapshotResponse(snapshot, {
        id: PROCESS_ID,
        version: VERSION,
        userId: USER_ID,
      }).id,
      PROCESS_ID,
    );
    assert.throws(() =>
      parseDerivativeSnapshotResponse(
        { ...snapshot, json_sha256: 'bad' },
        {
          id: PROCESS_ID,
          version: VERSION,
          userId: USER_ID,
        },
      ),
    );
    const submit = remote.submitProof(false);
    const parsedSubmit = parseDerivativeSubmitResponse(submit, plan);
    assert.equal(parsedSubmit.status, 'queued');
    assert.throws(() => parseDerivativeSubmitResponse({ ...submit, status: 'completed' }, plan));
    const status = remote.statusProof();
    assert.equal(parseDerivativeStatusResponse(status, plan, parsedSubmit).status, 'queued');
    assert.equal(derivativeStatusCategory('queued'), 'pending');
    assert.equal(derivativeStatusCategory('completed'), 'passed');
    assert.equal(derivativeStatusCategory('stale'), 'failed');
    assert.throws(() =>
      parseDerivativeStatusResponse({ ...status, completed_at: MODIFIED_AT }, plan, parsedSubmit),
    );

    const context = await resolveMaintenanceRemoteContext({
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(
      (await fetchMaintenanceDerivativeSnapshot({ context, id: PROCESS_ID, version: VERSION }))
        .command,
      'cmd_dataset_derivative_rebuild_snapshot',
    );
    assert.equal(
      (await applyMaintenanceDerivativeRebuild({ context, plan: buildDerivativePlanRequest(plan) }))
        .status,
      'queued',
    );
    assert.equal(
      (await readMaintenanceDerivativeRebuild({ context, requestId: parsedSubmit.request_id }))
        .command,
      'cmd_dataset_derivative_rebuild_read',
    );

    const tampered = structuredClone(plan);
    tampered.actions[0]!.components = ['extracted_md'];
    tampered.plan_sha256 = computePlanSha256(tampered);
    assert.throws(() => parseMaintenancePlan(tampered));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sequential action executor rejects derivative rebuild before any mutation transport', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-no-fallback-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    const context = await resolveMaintenanceRemoteContext({
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    const callsBefore = remote.calls.length;
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: plan.actions[0]!,
          plan,
          planDir: root,
          context,
        }),
      /guarded whole-plan RPC/u,
    );
    assert.equal(remote.calls.length, callsBefore);

    const invalidAttemptPath = path.join(root, 'invalid-derivative-attempt.json');
    writeJson(invalidAttemptPath, {});
    assert.throws(() =>
      applyInternals.validateDerivativeAdmissionAttempt({
        path: invalidAttemptPath,
        plan,
        context,
      }),
    );

    const unsupportedAction = structuredClone(plan.actions[0]!);
    unsupportedAction.action = 'unsupported' as never;
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: unsupportedAction,
          plan,
          planDir: root,
          context,
        }),
      /Unsupported maintenance action/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative verify fails closed on primary drift and incomplete terminal evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-failclosed-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    await applyPlan(root, plan, remote);
    remote.status = 'completed';
    remote.embeddingAt = COMPLETED_EMBEDDING_AT;
    remote.embeddingSha = null;
    remote.fenceState = 'released';
    const incomplete = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'maintenance-plan.json'),
      outDir: path.join(root, 'verify-incomplete'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(incomplete.status, 'failed');
    assert.ok(
      incomplete.issues.some((entry) => entry.code === 'DERIVATIVE_COMPLETION_PROOF_MISMATCH'),
    );

    remote.embeddingSha = sha256Text('same deterministic embedding');
    remote.primary.modified_at = '2026-07-14T03:00:00.000Z';
    const drifted = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'maintenance-plan.json'),
      outDir: path.join(root, 'verify-drifted'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(drifted.status, 'failed');
    assert.ok(drifted.issues.some((entry) => entry.code === 'DERIVATIVE_PRIMARY_ROW_DRIFT'));
    assert.ok(drifted.issues.some((entry) => entry.code === 'DERIVATIVE_PRIMARY_SNAPSHOT_DRIFT'));
    assert.ok(
      readFileSync(path.join(root, 'verify-drifted', 'readback-verify-report.json'), 'utf8'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative parsers reject every malformed identity, timestamp, status, and terminal proof edge', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-proof-edges-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    remote.lastPlanSha = plan.plan_sha256;
    remote.lastOperationId = plan.operation_id;
    const snapshot = remote.snapshot();
    const expected = { id: PROCESS_ID, version: VERSION, userId: USER_ID };

    for (const candidate of [
      null,
      { ...snapshot, table: 'flows' },
      { ...snapshot, modified_at: null },
      { ...snapshot, modified_at: '' },
      { ...snapshot, modified_at: 'not-a-timestamp' },
      { ...snapshot, json_ordered_sha256: sha256Text('different-json') },
    ]) {
      assert.throws(() => parseDerivativeSnapshotResponse(candidate, expected));
    }

    const submit = remote.submitProof(false);
    for (const candidate of [
      { ...submit, status: 'unsupported' },
      { ...submit, summary_audit_id: 'not-numeric' },
      { ...submit, request_id: '' },
      { ...submit, plan_request_sha256: 'not-a-hash' },
    ]) {
      assert.throws(() => parseDerivativeSubmitResponse(candidate, plan));
    }
    const parsedSubmit = parseDerivativeSubmitResponse(submit, plan);
    const status = remote.statusProof();
    for (const candidate of [
      { ...status, status: 'unsupported' },
      { ...status, phase: '' },
      { ...status, request_id: 'another-request' },
      { ...status, error: 'not-an-object' },
    ]) {
      assert.throws(() => parseDerivativeStatusResponse(candidate, plan, parsedSubmit));
    }

    const notDerivative = structuredClone(plan);
    notDerivative.operation = 'delete';
    assert.throws(() => derivativePlanAction(notDerivative));

    const missingSummary = structuredClone(plan) as DatasetMaintenancePlan & {
      summary: Record<string, unknown>;
    };
    delete missingSummary.summary.rebuild_derivatives;
    missingSummary.plan_sha256 = computePlanSha256(missingSummary);
    assert.throws(() => parseMaintenancePlan(missingSummary));

    const invalidSnapshot = structuredClone(plan);
    invalidSnapshot.actions[0]!.derivative_before = null as never;
    invalidSnapshot.plan_sha256 = computePlanSha256(invalidSnapshot);
    assert.throws(() => parseMaintenancePlan(invalidSnapshot));

    const invalidDerivativePlan = structuredClone(plan);
    invalidDerivativePlan.artifacts.derivative_baseline = 'wrong.json';
    invalidDerivativePlan.plan_sha256 = computePlanSha256(invalidDerivativePlan);
    assert.throws(() => parseMaintenancePlan(invalidDerivativePlan));

    const ordinaryWithComponents = ordinaryDeleteScope();
    (ordinaryWithComponents.actions as JsonObject[])[0]!.components = ['extracted_md'];
    assert.throws(() => parseMaintenanceScope(ordinaryWithComponents));

    const multipleActions = scope();
    const second = structuredClone((multipleActions.actions as JsonObject[])[0]!);
    second.action_id = 'rebuild-another-process';
    second.id = '00000000-0000-4000-8000-000000000099';
    (multipleActions.actions as JsonObject[]).push(second);
    assert.throws(() => parseMaintenanceScope(multipleActions));

    const ordinaryRoot = path.join(root, 'ordinary');
    const ordinaryScopePath = path.join(root, 'ordinary-scope.json');
    writeJson(ordinaryScopePath, ordinaryDeleteScope());
    const ordinaryPlan = await runDatasetMaintenancePlan({
      scopePath: ordinaryScopePath,
      operation: 'delete',
      outDir: ordinaryRoot,
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    ordinaryPlan.artifacts.derivative_baseline = 'derivative-baseline.json';
    ordinaryPlan.plan_sha256 = computePlanSha256(ordinaryPlan);
    assert.throws(() => parseMaintenancePlan(ordinaryPlan));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative planning records snapshot drift and blocked null baselines', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-plan-edges-'));
  try {
    const driftRemote = new DerivativeRemote();
    const originalSnapshot = driftRemote.snapshot.bind(driftRemote);
    driftRemote.snapshot = () => ({
      ...originalSnapshot(),
      modified_at: '2026-07-14T01:00:01.000Z',
    });
    const drifted = await makePlan(path.join(root, 'drift'), driftRemote);
    assert.equal(drifted.status, 'blocked');
    assert.ok(drifted.blockers.some((entry) => entry.code === 'DERIVATIVE_PRIMARY_SNAPSHOT_DRIFT'));

    const blockedRemote = new DerivativeRemote();
    blockedRemote.primary.state_code = 100;
    const blockedRoot = path.join(root, 'blocked');
    const blocked = await makePlan(blockedRoot, blockedRemote);
    assert.equal(blocked.status, 'blocked');
    assert.equal(
      JSON.parse(readFileSync(path.join(blockedRoot, 'derivative-baseline.json'), 'utf8')),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative apply rejects corrupt progress, primary drift, and replay identity changes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-apply-edges-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(path.join(root, 'progress'), remote);
    remote.lastPlanSha = plan.plan_sha256;
    remote.lastOperationId = plan.operation_id;
    const rawProof = remote.submitProof(false);
    const entry = {
      schema_version: 1,
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      action_id: 'rebuild-one-process',
      target_mode: 'owner_draft',
      actor: { user_id: USER_ID, email: EMAIL },
      started_at_utc: '2026-07-14T01:20:00.000Z',
      ended_at_utc: '2026-07-14T01:20:01.000Z',
      result: 'accepted',
      proof: rawProof,
    };
    const invalidProofPath = path.join(root, 'invalid-proof.jsonl');
    writeJson(invalidProofPath, { ...entry, proof: null });
    assert.throws(() => applyInternals.parseDerivativeSubmitProgress(plan, invalidProofPath));

    const invalidWrapperPath = path.join(root, 'invalid-wrapper.jsonl');
    writeJson(invalidWrapperPath, { ...entry, result: 'wrong' });
    assert.throws(() => applyInternals.parseDerivativeSubmitProgress(plan, invalidWrapperPath));

    const mismatchPath = path.join(root, 'mismatch.jsonl');
    const second = structuredClone(entry);
    (second.proof as JsonObject).request_id = '22222222-2222-2222-2222-222222222222';
    writeFileSync(mismatchPath, `${JSON.stringify(entry)}\n${JSON.stringify(second)}\n`);
    assert.throws(() => applyInternals.parseDerivativeSubmitProgress(plan, mismatchPath));

    const driftRemote = new DerivativeRemote();
    const driftRoot = path.join(root, 'primary-drift');
    const driftPlan = await makePlan(driftRoot, driftRemote);
    driftRemote.snapshotJsonSha = sha256Text('changed primary payload');
    await assert.rejects(
      () => applyPlan(driftRoot, driftPlan, driftRemote),
      /primary preconditions/u,
    );

    const replayRemote = new DerivativeRemote();
    const replayRoot = path.join(root, 'replay-mismatch');
    const replayPlan = await makePlan(replayRoot, replayRemote);
    await applyPlan(replayRoot, replayPlan, replayRemote);
    replayRemote.requestId = '22222222-2222-2222-2222-222222222222';
    await assert.rejects(
      () => applyPlan(replayRoot, replayPlan, replayRemote),
      /different request proof/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative verify reports missing, corrupt, and mismatched durable artifacts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-verify-artifacts-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    await applyPlan(root, plan, remote);
    const planPath = path.join(root, 'maintenance-plan.json');
    const approvalPath = path.join(root, 'approval-record.json');
    const commitPath = path.join(root, 'commit-report.json');
    const progressPath = path.join(root, 'derivative-submit-progress.jsonl');
    const approvalText = readFileSync(approvalPath, 'utf8');
    const commitText = readFileSync(commitPath, 'utf8');
    const progressText = readFileSync(progressPath, 'utf8');
    let sequence = 0;
    const verify = async () =>
      runDatasetMaintenanceVerify({
        planPath,
        outDir: path.join(root, `verify-${sequence++}`),
        env: remote.env,
        fetchImpl: remote.fetch,
      });

    rmSync(approvalPath);
    assert.ok((await verify()).issues.some((entry) => entry.code === 'APPROVAL_RECORD_MISSING'));
    writeJson(approvalPath, {});
    assert.ok((await verify()).issues.some((entry) => entry.code === 'APPROVAL_RECORD_INVALID'));
    writeFileSync(approvalPath, approvalText);

    rmSync(commitPath);
    assert.ok((await verify()).issues.some((entry) => entry.code === 'COMMIT_REPORT_MISSING'));
    writeJson(commitPath, {});
    assert.ok((await verify()).issues.some((entry) => entry.code === 'COMMIT_REPORT_INCOMPLETE'));
    writeFileSync(commitPath, commitText);

    writeFileSync(progressPath, '');
    const missingAdmission = await verify();
    assert.ok(
      missingAdmission.issues.some((entry) => entry.code === 'DERIVATIVE_ADMISSION_MISSING'),
    );
    assert.equal(missingAdmission.summary.derivative_request_status, 'unknown');
    assert.equal(missingAdmission.derivative_status, undefined);

    writeJson(progressPath, {});
    const invalidProgress = await verify();
    assert.ok(
      invalidProgress.issues.some((entry) => entry.code === 'DERIVATIVE_SUBMIT_PROGRESS_INVALID'),
    );

    const originalEntry = JSON.parse(progressText) as JsonObject;
    const secondEntry = structuredClone(originalEntry);
    (secondEntry.proof as JsonObject).request_id = '22222222-2222-2222-2222-222222222222';
    writeFileSync(
      progressPath,
      `${JSON.stringify(originalEntry)}\n${JSON.stringify(secondEntry)}\n`,
    );
    const mismatched = await verify();
    assert.ok(
      mismatched.issues.some((entry) => entry.code === 'DERIVATIVE_ADMISSION_REPLAY_MISMATCH'),
    );

    writeFileSync(progressPath, progressText);
    const originalStatus = remote.statusProof.bind(remote);
    remote.statusProof = () => ({ ...originalStatus(), request_id: 'wrong-request' });
    assert.ok(
      (await verify()).issues.some((entry) => entry.code === 'DERIVATIVE_STATUS_READ_FAILED'),
    );
    remote.statusProof = originalStatus;

    const originalSnapshot = remote.snapshot.bind(remote);
    remote.snapshot = () => ({ ...originalSnapshot(), table: 'flows' });
    assert.ok(
      (await verify()).issues.some((entry) => entry.code === 'DERIVATIVE_SNAPSHOT_READ_FAILED'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative verify protects other rows, reference closure, and null embedding timestamps', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-verify-edges-'));
  try {
    const remote = new DerivativeRemote();
    remote.otherProcesses.push(processRow('70000000-0000-4000-8000-000000000001'));
    const plan = await makePlan(path.join(root, 'closure'), remote);
    await applyPlan(path.join(root, 'closure'), plan, remote);
    const protectedPending = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'closure', 'maintenance-plan.json'),
      outDir: path.join(root, 'closure-protected'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.equal(protectedPending.summary.protected_checks_passed, 1);
    remote.otherProcesses[0]!.modified_at = '2026-07-14T03:00:00.000Z';
    remote.otherProcesses.push(
      processRow('80000000-0000-4000-8000-000000000001', { reference: true }),
    );
    const closure = await runDatasetMaintenanceVerify({
      planPath: path.join(root, 'closure', 'maintenance-plan.json'),
      outDir: path.join(root, 'closure-verify'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    for (const code of [
      'PROTECTED_ROW_CHANGED',
      'UNEXPECTED_ACCOUNT_ROW',
      'PROJECTED_REFERENCE_CLOSURE_MISMATCH',
    ]) {
      assert.ok(closure.issues.some((entry) => entry.code === code));
    }

    const timestampRemote = new DerivativeRemote();
    timestampRemote.embeddingAt = null;
    const timestampRoot = path.join(root, 'timestamps');
    const timestampPlan = await makePlan(timestampRoot, timestampRemote);
    await applyPlan(timestampRoot, timestampPlan, timestampRemote);
    timestampRemote.status = 'completed';
    timestampRemote.fenceState = 'released';
    timestampRemote.embeddingAt = COMPLETED_EMBEDDING_AT;
    assert.equal(
      (
        await runDatasetMaintenanceVerify({
          planPath: path.join(timestampRoot, 'maintenance-plan.json'),
          outDir: path.join(root, 'timestamp-pass'),
          env: timestampRemote.env,
          fetchImpl: timestampRemote.fetch,
        })
      ).status,
      'passed',
    );
    timestampRemote.embeddingAt = null;
    const missingTimestamp = await runDatasetMaintenanceVerify({
      planPath: path.join(timestampRoot, 'maintenance-plan.json'),
      outDir: path.join(root, 'timestamp-missing'),
      env: timestampRemote.env,
      fetchImpl: timestampRemote.fetch,
    });
    assert.ok(
      missingTimestamp.issues.some(
        (entry) => entry.code === 'DERIVATIVE_COMPLETION_PROOF_MISMATCH',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derivative verify progress helper keeps only one exact accepted request', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-derivative-verify-helper-'));
  try {
    const remote = new DerivativeRemote();
    const plan = await makePlan(root, remote);
    remote.lastPlanSha = plan.plan_sha256;
    remote.lastOperationId = plan.operation_id;
    const problems: Parameters<typeof verifyInternals.readDerivativeSubmitProof>[0]['problems'] =
      [];
    const missing = verifyInternals.readDerivativeSubmitProof({
      plan,
      progressPath: path.join(root, 'missing-progress.jsonl'),
      problems,
    });
    assert.equal(missing.proof, null);
    assert.equal(missing.admissions, 0);
    assert.equal(problems[0]?.code, 'DERIVATIVE_ADMISSION_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
