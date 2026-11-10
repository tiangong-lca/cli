import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact } from '../platform/artifacts.js';
import { collectRemoteReferences } from '../dataset/remote-verify.js';
import { CliError } from '../../shared/errors.js';
import type { FetchLike } from '../transport/http.js';
import {
  MAINTENANCE_SCAN_TABLES,
  type DatasetMaintenancePlan,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from './contract/types.js';
import { isJsonObject, maintenanceRowKey, snapshotRemoteRow } from './contract/values.js';
import { parseMaintenancePlan } from './contract.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import {
  readJsonFile,
  readJsonLinesIfPresent,
  resolveMaintenancePlanArtifactPath,
} from './contract/files.js';
import {
  derivativePlanAction,
  derivativeStatusCategory,
  parseDerivativeSnapshotResponse,
  parseDerivativeStatusResponse,
  parseDerivativeSubmitResponse,
  type DatasetMaintenanceDerivativeStatusProof,
  type DatasetMaintenanceDerivativeSubmitProof,
} from './derivatives.js';
import { maintenanceProjectedReferenceFingerprint } from './plan.js';
import {
  isSnapshotCompletenessCompatible,
  type DatasetMaintenanceSnapshotCompleteness,
} from './pagination.js';
import {
  fetchMaintenanceAccountRows,
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceExactRows,
  normalizeMaintenancePageSize,
  readMaintenanceDerivativeRebuild,
  resolveMaintenanceRemoteContext,
} from './remote.js';

export type DatasetMaintenanceVerifyIssue = {
  code: string;
  message: string;
  action_id?: string;
  table?: string;
  id?: string;
  version?: string;
  details?: unknown;
};

export type DatasetMaintenanceVerifyReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'pending' | 'passed' | 'failed';
  task_id: string;
  operation: DatasetMaintenancePlan['operation'];
  operation_id: string;
  target_mode: DatasetMaintenancePlan['target_mode'];
  plan_sha256: string;
  actor: { user_id: string; email: string };
  snapshot_completeness: DatasetMaintenanceSnapshotCompleteness;
  summary: {
    actions: number;
    action_checks_passed: number;
    protected_rows: number;
    protected_checks_passed: number;
    progress_successes: number;
    atomic_plan_proofs?: number;
    atomic_batches?: number;
    atomic_batch_successes?: number;
    exchange_rewrite_logs?: number;
    derivative_admissions?: number;
    derivative_request_status?: string;
    dangling_deleted_target_references: number;
    issues: number;
  };
  action_checks: Array<{
    action_id: string;
    status: 'pending' | 'passed' | 'failed';
    observed:
      'desired_payload' | 'absent' | 'mismatch' | 'derivative_pending' | 'derivative_current';
  }>;
  issues: DatasetMaintenanceVerifyIssue[];
  artifacts: {
    plan: string;
    approval_record: string;
    apply_progress: string;
    commit_report: string;
    derivative_submit_progress?: string;
    report: string;
  };
  derivative_status?: {
    proof: DatasetMaintenanceDerivativeStatusProof;
    raw_evidence: JsonObject;
    note: string;
  };
};

export type RunDatasetMaintenanceVerifyOptions = {
  planPath: string;
  outDir?: string;
  pageSize?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
};

function issue(
  code: string,
  message: string,
  action?: DatasetMaintenancePlanAction,
  details?: unknown,
): DatasetMaintenanceVerifyIssue {
  return {
    code,
    message,
    ...(action
      ? {
          action_id: action.action_id,
          table: action.table,
          id: action.id,
          version: action.version,
        }
      : {}),
    ...(details === undefined ? {} : { details }),
  };
}

function desiredPayload(planDir: string, action: DatasetMaintenancePlanAction): JsonObject | null {
  if (!action.desired_payload) {
    return null;
  }
  const raw = readJsonFile(
    resolveMaintenancePlanArtifactPath(
      planDir,
      action.desired_payload.path,
      'Maintenance desired payload path',
    ),
    'Maintenance desired payload',
  );
  return isJsonObject(raw) && sha256Json(raw) === action.desired_payload.sha256 ? raw : null;
}

function deletedTargetReferences(options: {
  rows: DatasetMaintenanceRemoteRow[];
  deletes: DatasetMaintenancePlanAction[];
}): Array<{
  target_action_id: string;
  source_key: string;
  path: string;
}> {
  const payloadRows = options.rows
    .filter((row) => row.json_ordered)
    .map((row) => ({ ...row, json_ordered: row.json_ordered as JsonObject }));
  const references = collectRemoteReferences(payloadRows).filter(
    (reference) => reference.role === 'reference',
  );
  return references.flatMap((reference) => {
    const source = payloadRows[reference.row_index];
    if (!reference.table || !reference.id) {
      return [];
    }
    return options.deletes
      .filter(
        (target) =>
          target.table === reference.table &&
          target.id === reference.id &&
          (!reference.version || target.version === reference.version),
      )
      .map((target) => ({
        target_action_id: target.action_id,
        source_key: maintenanceRowKey(source!),
        path: reference.path,
      }));
  });
}

function derivativeSubmitIdentity(proof: DatasetMaintenanceDerivativeSubmitProof): string {
  return sha256Json({
    schema_version: proof.schema_version,
    plan_sha256: proof.plan_sha256,
    operation_id: proof.operation_id,
    target_visibility: proof.target_visibility,
    plan_request_sha256: proof.plan_request_sha256,
    action_count: proof.action_count,
    accepted_count: proof.accepted_count,
    summary_audit_id: proof.summary_audit_id,
    request_id: proof.request_id,
    action_request_sha256: proof.action_request_sha256,
    database_audit_id: proof.database_audit_id,
  });
}

function readDerivativeSubmitProof(options: {
  plan: DatasetMaintenancePlan;
  progressPath: string;
  problems: DatasetMaintenanceVerifyIssue[];
}): { proof: DatasetMaintenanceDerivativeSubmitProof | null; admissions: number } {
  const action = derivativePlanAction(options.plan);
  const proofs: DatasetMaintenanceDerivativeSubmitProof[] = [];
  for (const [index, value] of readJsonLinesIfPresent(options.progressPath).entries()) {
    try {
      if (
        !isJsonObject(value) ||
        value.schema_version !== 1 ||
        value.plan_sha256 !== options.plan.plan_sha256 ||
        value.operation_id !== options.plan.operation_id ||
        value.action_id !== action.action_id ||
        value.target_mode !== 'owner_draft' ||
        !isJsonObject(value.actor) ||
        value.actor.user_id !== options.plan.account.user_id ||
        value.actor.email !== options.plan.account.email ||
        typeof value.started_at_utc !== 'string' ||
        typeof value.ended_at_utc !== 'string' ||
        value.result !== 'accepted' ||
        !isJsonObject(value.proof)
      ) {
        throw new Error('wrapper mismatch');
      }
      proofs.push(
        parseDerivativeSubmitResponse(
          {
            ok: true,
            command: 'cmd_dataset_derivative_rebuild_plan_guarded',
            ...value.proof,
          },
          options.plan,
        ),
      );
    } catch (error) {
      options.problems.push({
        code: 'DERIVATIVE_SUBMIT_PROGRESS_INVALID',
        message: 'Derivative submit progress contains an invalid or foreign entry.',
        details: { line: index + 1, error: String(error) },
      });
    }
  }
  if (proofs.length === 0) {
    options.problems.push({
      code: 'DERIVATIVE_ADMISSION_MISSING',
      message: 'No valid guarded-RPC derivative admission proof exists.',
    });
    return { proof: null, admissions: 0 };
  }
  if (new Set(proofs.map(derivativeSubmitIdentity)).size !== 1) {
    options.problems.push({
      code: 'DERIVATIVE_ADMISSION_REPLAY_MISMATCH',
      message: 'Derivative admission entries do not identify one durable request.',
    });
    return { proof: null, admissions: proofs.length };
  }
  return { proof: proofs.at(-1)!, admissions: proofs.length };
}

async function runDerivativeMaintenanceVerify(options: {
  plan: DatasetMaintenancePlan;
  planPath: string;
  planDir: string;
  reportPath: string;
  approvalRecordPath: string;
  commitReportPath: string;
  progressPath: string;
  context: Awaited<ReturnType<typeof resolveMaintenanceRemoteContext>>;
  current: Awaited<ReturnType<typeof fetchMaintenanceAccountRows>>;
  now?: Date;
}): Promise<DatasetMaintenanceVerifyReport> {
  const action = derivativePlanAction(options.plan);
  const baseline = action.derivative_before!;
  const problems: DatasetMaintenanceVerifyIssue[] = [];
  const currentByKey = new Map(options.current.rows.map((row) => [maintenanceRowKey(row), row]));
  let protectedPassed = 0;
  for (const protectedRow of options.plan.protected_rows) {
    const row = currentByKey.get(maintenanceRowKey(protectedRow));
    if (row && snapshotRemoteRow(row).row_sha256 === protectedRow.row_sha256) {
      protectedPassed += 1;
    } else {
      problems.push({
        code: 'PROTECTED_ROW_CHANGED',
        message: 'Protected primary row changed or disappeared after derivative admission.',
        table: protectedRow.table,
        id: protectedRow.id,
        version: protectedRow.version,
      });
    }
  }
  const expectedKeys = new Set([
    ...options.plan.protected_rows.map(maintenanceRowKey),
    maintenanceRowKey(action),
  ]);
  for (const row of options.current.rows) {
    if (!expectedKeys.has(maintenanceRowKey(row))) {
      problems.push({
        code: 'UNEXPECTED_ACCOUNT_ROW',
        message: 'Unexpected current-account primary row exists after derivative admission.',
        table: row.table,
        id: row.id,
        version: row.version,
      });
    }
  }
  const primaryRow = currentByKey.get(maintenanceRowKey(action));
  if (!primaryRow || snapshotRemoteRow(primaryRow).row_sha256 !== action.before?.row_sha256) {
    problems.push(
      issue(
        'DERIVATIVE_PRIMARY_ROW_DRIFT',
        'The process primary row changed after derivative planning.',
        action,
      ),
    );
  }
  const referenceSha256 = sha256Json(
    maintenanceProjectedReferenceFingerprint(options.current.rows),
  );
  if (referenceSha256 !== options.plan.projected_reference_sha256) {
    problems.push({
      code: 'PROJECTED_REFERENCE_CLOSURE_MISMATCH',
      message: 'Primary readback reference closure differs from the approved plan.',
      details: { expected: options.plan.projected_reference_sha256, actual: referenceSha256 },
    });
  }

  if (!existsSync(options.approvalRecordPath)) {
    problems.push({ code: 'APPROVAL_RECORD_MISSING', message: 'approval-record.json is missing.' });
  } else {
    const approval = readJsonFile(options.approvalRecordPath, 'Maintenance approval record');
    if (
      !isJsonObject(approval) ||
      approval.schema_version !== 1 ||
      approval.plan_sha256 !== options.plan.plan_sha256 ||
      approval.task_id !== options.plan.task_id ||
      approval.operation !== 'rebuild-derivatives' ||
      approval.operation_id !== options.plan.operation_id ||
      approval.target_mode !== 'owner_draft' ||
      !isJsonObject(approval.account) ||
      approval.account.user_id !== options.plan.account.user_id ||
      approval.account.email !== options.plan.account.email ||
      approval.confirmed_email !== options.plan.account.email ||
      !isJsonObject(approval.row_counts) ||
      sha256Json(approval.row_counts) !== sha256Json(options.plan.summary) ||
      !isSnapshotCompletenessCompatible(
        approval.snapshot_completeness,
        options.plan.snapshot_completeness,
        MAINTENANCE_SCAN_TABLES,
      )
    ) {
      problems.push({
        code: 'APPROVAL_RECORD_INVALID',
        message: 'approval-record.json does not match the immutable derivative plan and actor.',
      });
    }
  }

  const admission = readDerivativeSubmitProof({
    plan: options.plan,
    progressPath: options.progressPath,
    problems,
  });
  if (!existsSync(options.commitReportPath)) {
    problems.push({ code: 'COMMIT_REPORT_MISSING', message: 'commit-report.json is missing.' });
  } else {
    const commit = readJsonFile(options.commitReportPath, 'Maintenance commit report');
    const commitProof =
      isJsonObject(commit) && isJsonObject(commit.derivative_admission)
        ? commit.derivative_admission
        : null;
    if (
      !isJsonObject(commit) ||
      commit.schema_version !== 1 ||
      commit.status !== 'accepted' ||
      commit.plan_sha256 !== options.plan.plan_sha256 ||
      commit.operation !== 'rebuild-derivatives' ||
      commit.operation_id !== options.plan.operation_id ||
      !commitProof ||
      commitProof.admission !== 'accepted' ||
      !admission.proof ||
      derivativeSubmitIdentity(commitProof as DatasetMaintenanceDerivativeSubmitProof) !==
        derivativeSubmitIdentity(admission.proof)
    ) {
      problems.push({
        code: 'COMMIT_REPORT_INCOMPLETE',
        message: 'commit-report.json does not prove guarded derivative admission.',
      });
    }
  }

  let statusProof: DatasetMaintenanceDerivativeStatusProof | null = null;
  let rawStatus: JsonObject | null = null;
  let category: 'pending' | 'passed' | 'failed' = 'failed';
  if (admission.proof) {
    try {
      rawStatus = await readMaintenanceDerivativeRebuild({
        context: options.context,
        requestId: admission.proof.request_id,
      });
      statusProof = parseDerivativeStatusResponse(rawStatus, options.plan, admission.proof);
      category = derivativeStatusCategory(statusProof.status);
    } catch (error) {
      problems.push({
        code: 'DERIVATIVE_STATUS_READ_FAILED',
        message: 'Guarded derivative request status could not be validated.',
        details: String(error),
      });
    }
  }

  let currentSnapshot = null;
  try {
    currentSnapshot = parseDerivativeSnapshotResponse(
      await fetchMaintenanceDerivativeSnapshot({
        context: options.context,
        id: action.id,
        version: action.version,
      }),
      { id: action.id, version: action.version, userId: action.expected_user_id },
    );
  } catch (error) {
    problems.push(
      issue(
        'DERIVATIVE_SNAPSHOT_READ_FAILED',
        'Fresh action-scoped derivative snapshot could not be validated.',
        action,
        String(error),
      ),
    );
  }
  if (
    currentSnapshot &&
    (currentSnapshot.modified_at !== baseline.modified_at ||
      currentSnapshot.json_sha256 !== baseline.json_sha256 ||
      currentSnapshot.json_ordered_sha256 !== baseline.json_ordered_sha256)
  ) {
    problems.push(
      issue(
        'DERIVATIVE_PRIMARY_SNAPSHOT_DRIFT',
        'Fresh derivative snapshot no longer matches frozen primary preconditions.',
        action,
      ),
    );
  }
  if (statusProof && category === 'failed') {
    problems.push(
      issue(
        'DERIVATIVE_REQUEST_FAILED',
        'The durable derivative request reached a failed terminal state. This does not prove that its primary-write fence has been released; inspect raw_evidence.',
        action,
        { status: statusProof.status, error: statusProof.error },
      ),
    );
  }
  if (statusProof && category === 'passed') {
    const currentEmbeddingAt = currentSnapshot?.embedding_ft_at
      ? Date.parse(currentSnapshot.embedding_ft_at)
      : Number.NaN;
    const baselineEmbeddingAt = baseline.embedding_ft_at
      ? Date.parse(baseline.embedding_ft_at)
      : Number.NEGATIVE_INFINITY;
    if (
      !currentSnapshot ||
      statusProof.completed_snapshot_sha256 !== currentSnapshot.snapshot_sha256 ||
      !currentSnapshot.extracted_md_sha256 ||
      !currentSnapshot.embedding_ft_sha256 ||
      !Number.isFinite(currentEmbeddingAt) ||
      currentEmbeddingAt <= baselineEmbeddingAt
    ) {
      problems.push(
        issue(
          'DERIVATIVE_COMPLETION_PROOF_MISMATCH',
          'Completed status lacks matching current markdown/vector freshness proof.',
          action,
        ),
      );
    }
  }

  const finalStatus: DatasetMaintenanceVerifyReport['status'] = problems.length
    ? 'failed'
    : category;
  const actionStatus = finalStatus;
  const report: DatasetMaintenanceVerifyReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: finalStatus,
    task_id: options.plan.task_id,
    operation: options.plan.operation,
    operation_id: options.plan.operation_id,
    target_mode: options.plan.target_mode,
    plan_sha256: options.plan.plan_sha256,
    actor: {
      user_id: options.context.account.user_id,
      email: options.context.account.email,
    },
    snapshot_completeness: options.current.completeness,
    summary: {
      actions: 1,
      action_checks_passed: actionStatus === 'passed' ? 1 : 0,
      protected_rows: options.plan.protected_rows.length,
      protected_checks_passed: protectedPassed,
      progress_successes: 0,
      derivative_admissions: admission.admissions,
      derivative_request_status: statusProof?.status ?? 'unknown',
      dangling_deleted_target_references: 0,
      issues: problems.length,
    },
    action_checks: [
      {
        action_id: action.action_id,
        status: actionStatus,
        observed:
          actionStatus === 'passed'
            ? 'derivative_current'
            : actionStatus === 'pending'
              ? 'derivative_pending'
              : 'mismatch',
      },
    ],
    issues: problems,
    artifacts: {
      plan: options.planPath,
      approval_record: options.approvalRecordPath,
      apply_progress: options.progressPath,
      derivative_submit_progress: options.progressPath,
      commit_report: options.commitReportPath,
      report: options.reportPath,
    },
    ...(statusProof && rawStatus
      ? {
          derivative_status: {
            proof: statusProof,
            raw_evidence: rawStatus,
            note: 'raw_evidence preserves database fence and timeout state; failed does not imply the primary row is editable unless that evidence explicitly proves fence release.',
          },
        }
      : {}),
  };
  writeJsonArtifact(options.reportPath, report);
  return report;
}

export async function runDatasetMaintenanceVerify(
  options: RunDatasetMaintenanceVerifyOptions,
): Promise<DatasetMaintenanceVerifyReport> {
  const planPath = path.resolve(options.planPath);
  const planDir = path.dirname(planPath);
  const outDir = path.resolve(options.outDir ?? path.join(planDir, 'verify'));
  const reportPath = path.join(outDir, 'readback-verify-report.json');
  const approvalRecordPath = path.join(planDir, 'approval-record.json');
  const plan = parseMaintenancePlan(readJsonFile(planPath, 'Maintenance plan'));
  const progressPath = path.join(
    planDir,
    plan.operation === 'rebuild-derivatives'
      ? 'derivative-submit-progress.jsonl'
      : 'apply-progress.jsonl',
  );
  const commitReportPath = path.join(planDir, 'commit-report.json');
  const pageSize = normalizeMaintenancePageSize(options.pageSize);
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  if (
    context.account.user_id !== plan.account.user_id ||
    context.account.email !== plan.account.email
  ) {
    throw new CliError('Current authenticated account does not match the maintenance plan.', {
      code: 'DATASET_MAINTENANCE_ACCOUNT_MISMATCH',
      exitCode: 1,
    });
  }

  const problems: DatasetMaintenanceVerifyIssue[] = [];
  const current = await fetchMaintenanceAccountRows({
    context,
    userId: plan.account.user_id,
    pageSize,
  });
  if (plan.operation === 'rebuild-derivatives') {
    return runDerivativeMaintenanceVerify({
      plan,
      planPath,
      planDir,
      reportPath,
      approvalRecordPath,
      commitReportPath,
      progressPath,
      context,
      current,
      now: options.now,
    });
  }
  const currentByKey = new Map(current.rows.map((row) => [maintenanceRowKey(row), row]));
  const actionChecks: DatasetMaintenanceVerifyReport['action_checks'] = [];
  for (const action of plan.actions) {
    const exact = await fetchMaintenanceExactRows({
      context,
      table: action.table,
      id: action.id,
      version: action.version,
    });
    if (action.action === 'delete') {
      const passed = exact.rows.length === 0;
      if (!passed) {
        problems.push(
          issue('DELETE_TARGET_STILL_VISIBLE', 'Deleted target is still visible.', action),
        );
      }
      actionChecks.push({
        action_id: action.action_id,
        status: passed ? 'passed' : 'failed',
        observed: passed ? 'absent' : 'mismatch',
      });
      continue;
    }
    const payload = desiredPayload(planDir, action);
    const row = exact.rows.length === 1 ? exact.rows[0] : null;
    const snapshot = row ? snapshotRemoteRow(row) : null;
    const passed = Boolean(
      row &&
      payload &&
      snapshot?.payload_sha256 === action.desired_payload?.sha256 &&
      row.user_id === action.expected_user_id &&
      row.state_code === 0 &&
      row.model_id === action.before?.model_id &&
      row.rule_verification === action.before?.rule_verification,
    );
    if (!passed) {
      problems.push(
        issue(
          'SAVE_DRAFT_READBACK_MISMATCH',
          'Saved draft payload, owner, state, model_id, or rule_verification did not match the plan.',
          action,
        ),
      );
    }
    actionChecks.push({
      action_id: action.action_id,
      status: passed ? 'passed' : 'failed',
      observed: passed ? 'desired_payload' : 'mismatch',
    });
  }

  const progress = readJsonLinesIfPresent(progressPath);
  const actionsById = new Map(plan.actions.map((action) => [action.action_id, action]));

  let protectedPassed = 0;
  for (const protectedRow of plan.protected_rows) {
    const row = currentByKey.get(maintenanceRowKey(protectedRow));
    if (row && snapshotRemoteRow(row).row_sha256 === protectedRow.row_sha256) {
      protectedPassed += 1;
    } else {
      problems.push({
        code: 'PROTECTED_ROW_CHANGED',
        message: 'Protected row changed or disappeared after maintenance.',
        table: protectedRow.table,
        id: protectedRow.id,
        version: protectedRow.version,
      });
    }
  }
  const expectedFinalKeys = new Set([
    ...plan.protected_rows.map(maintenanceRowKey),
    ...plan.actions.filter((action) => action.action !== 'delete').map(maintenanceRowKey),
  ]);
  for (const row of current.rows) {
    if (!expectedFinalKeys.has(maintenanceRowKey(row))) {
      problems.push({
        code: 'UNEXPECTED_ACCOUNT_ROW',
        message: 'Unexpected current-account row exists after maintenance.',
        table: row.table,
        id: row.id,
        version: row.version,
      });
    }
  }

  const referenceSha256 = sha256Json(maintenanceProjectedReferenceFingerprint(current.rows));
  if (referenceSha256 !== plan.projected_reference_sha256) {
    problems.push({
      code: 'PROJECTED_REFERENCE_CLOSURE_MISMATCH',
      message: 'Readback reference closure differs from the approved plan.',
      details: { expected: plan.projected_reference_sha256, actual: referenceSha256 },
    });
  }
  const danglingReferences = deletedTargetReferences({
    rows: current.rows,
    deletes: plan.actions.filter((action) => action.action === 'delete'),
  });
  if (danglingReferences.length) {
    problems.push({
      code: 'DELETED_TARGET_REFERENCED',
      message: 'Readback contains references to a deleted target.',
      details: danglingReferences,
    });
  }

  if (!existsSync(approvalRecordPath)) {
    problems.push({
      code: 'APPROVAL_RECORD_MISSING',
      message: 'approval-record.json is missing.',
    });
  } else {
    const approvalRecord = readJsonFile(approvalRecordPath, 'Maintenance approval record');
    if (
      !isJsonObject(approvalRecord) ||
      approvalRecord.schema_version !== 1 ||
      approvalRecord.plan_sha256 !== plan.plan_sha256 ||
      approvalRecord.task_id !== plan.task_id ||
      approvalRecord.operation !== plan.operation ||
      approvalRecord.operation_id !== plan.operation_id ||
      approvalRecord.target_mode !== plan.target_mode ||
      !isJsonObject(approvalRecord.account) ||
      approvalRecord.account.user_id !== plan.account.user_id ||
      approvalRecord.account.email !== plan.account.email ||
      approvalRecord.confirmed_email !== plan.account.email ||
      !isJsonObject(approvalRecord.row_counts) ||
      sha256Json(approvalRecord.row_counts) !== sha256Json(plan.summary) ||
      !isSnapshotCompletenessCompatible(
        approvalRecord.snapshot_completeness,
        plan.snapshot_completeness,
        MAINTENANCE_SCAN_TABLES,
      )
    ) {
      problems.push({
        code: 'APPROVAL_RECORD_INVALID',
        message: 'approval-record.json does not match the immutable plan and actor.',
      });
    }
  }

  const successfulActionIds = new Set<string>();
  for (const [index, entry] of progress.entries()) {
    const action =
      isJsonObject(entry) && typeof entry.action_id === 'string'
        ? actionsById.get(entry.action_id)
        : null;
    const valid = Boolean(
      isJsonObject(entry) &&
      entry.schema_version === 1 &&
      action &&
      entry.plan_sha256 === plan.plan_sha256 &&
      entry.operation_id === plan.operation_id &&
      entry.action === action.action &&
      entry.table === action.table &&
      entry.id === action.id &&
      entry.version === action.version &&
      entry.reason_code === action.reason_code &&
      entry.before_sha256 === action.before?.row_sha256 &&
      typeof entry.started_at_utc === 'string' &&
      typeof entry.ended_at_utc === 'string' &&
      isJsonObject(entry.actor) &&
      entry.actor.user_id === plan.account.user_id &&
      entry.actor.email === plan.account.email &&
      isJsonObject(entry.audit_context) &&
      entry.audit_context.plan_sha256 === plan.plan_sha256 &&
      entry.audit_context.operation_id === plan.operation_id &&
      entry.audit_context.action_id === action.action_id &&
      entry.audit_context.reason_code === action.reason_code &&
      entry.audit_context.source === 'tiangong-lca dataset maintenance apply' &&
      !('target_mode' in entry) &&
      !('target_mode' in entry.audit_context) &&
      !('batch_id' in entry) &&
      !('batch_request_sha256' in entry) &&
      !('database_audit_id' in entry) &&
      !('summary_audit_id' in entry) &&
      !('plan_request_sha256' in entry) &&
      !('plan_summary_audit_id' in entry) &&
      isJsonObject(entry.rollback) &&
      sha256Json(entry.rollback) === sha256Json(action.rollback) &&
      (entry.result === 'success' || entry.result === 'failed') &&
      (entry.result === 'success'
        ? typeof entry.remote_result_sha256 === 'string' &&
          entry.error === null &&
          (action.action === 'delete'
            ? entry.after_sha256 === null
            : typeof entry.after_sha256 === 'string')
        : entry.remote_result_sha256 === null &&
          entry.after_sha256 === null &&
          typeof entry.error === 'string'),
    );
    if (!valid) {
      problems.push({
        code: 'APPLY_PROGRESS_ENTRY_INVALID',
        message: 'apply-progress.jsonl contains an invalid or foreign entry.',
        details: { line: index + 1, action_id: action?.action_id ?? null },
      });
      continue;
    }
    if (isJsonObject(entry) && entry.result === 'success' && action) {
      if (successfulActionIds.has(action.action_id)) {
        problems.push({
          code: 'APPLY_PROGRESS_SUCCESS_DUPLICATE',
          message: 'apply-progress.jsonl contains more than one success proof for an action.',
          details: { line: index + 1, action_id: action.action_id },
        });
        continue;
      }
      successfulActionIds.add(action.action_id);
    }
  }
  for (const action of plan.actions) {
    if (!successfulActionIds.has(action.action_id)) {
      problems.push(
        issue('ACTION_SUCCESS_LOG_MISSING', 'No successful apply-progress entry exists.', action),
      );
    }
  }
  if (!existsSync(commitReportPath)) {
    problems.push({ code: 'COMMIT_REPORT_MISSING', message: 'commit-report.json is missing.' });
  } else {
    const commitReport = readJsonFile(commitReportPath, 'Maintenance commit report');
    const commitActions =
      isJsonObject(commitReport) && Array.isArray(commitReport.actions) ? commitReport.actions : [];
    const commitActionsById = new Map(
      commitActions
        .filter(
          (entry): entry is JsonObject =>
            isJsonObject(entry) && typeof entry.action_id === 'string',
        )
        .map((entry) => [entry.action_id as string, entry]),
    );
    const commitActionsMatch =
      commitActions.length === plan.actions.length &&
      commitActionsById.size === plan.actions.length &&
      plan.actions.every((action) => {
        const entry = commitActionsById.get(action.action_id);
        return Boolean(
          entry &&
          entry.action === action.action &&
          entry.table === action.table &&
          entry.id === action.id &&
          entry.version === action.version &&
          entry.status === 'success' &&
          entry.error === null,
        );
      });
    if (
      !isJsonObject(commitReport) ||
      commitReport.schema_version !== 1 ||
      commitReport.plan_sha256 !== plan.plan_sha256 ||
      commitReport.task_id !== plan.task_id ||
      commitReport.operation !== plan.operation ||
      commitReport.operation_id !== plan.operation_id ||
      commitReport.target_mode !== plan.target_mode ||
      commitReport.status !== 'completed' ||
      !isJsonObject(commitReport.actor) ||
      commitReport.actor.user_id !== plan.account.user_id ||
      commitReport.actor.email !== plan.account.email ||
      !isJsonObject(commitReport.summary) ||
      commitReport.summary.actions !== plan.actions.length ||
      commitReport.summary.success !== plan.actions.length ||
      commitReport.summary.failed !== 0 ||
      commitReport.summary.pending !== 0 ||
      !commitActionsMatch
    ) {
      problems.push({
        code: 'COMMIT_REPORT_INCOMPLETE',
        message: 'commit-report.json does not prove full successful completion for this plan.',
      });
    }
  }

  const report: DatasetMaintenanceVerifyReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: problems.length ? 'failed' : 'passed',
    task_id: plan.task_id,
    operation: plan.operation,
    operation_id: plan.operation_id,
    target_mode: plan.target_mode,
    plan_sha256: plan.plan_sha256,
    actor: { user_id: context.account.user_id, email: context.account.email },
    snapshot_completeness: current.completeness,
    summary: {
      actions: plan.actions.length,
      action_checks_passed: actionChecks.filter((check) => check.status === 'passed').length,
      protected_rows: plan.protected_rows.length,
      protected_checks_passed: protectedPassed,
      progress_successes: successfulActionIds.size,
      dangling_deleted_target_references: danglingReferences.length,
      issues: problems.length,
    },
    action_checks: actionChecks,
    issues: problems,
    artifacts: {
      plan: planPath,
      approval_record: approvalRecordPath,
      apply_progress: progressPath,
      commit_report: commitReportPath,
      report: reportPath,
    },
  };
  writeJsonArtifact(reportPath, report);
  return report;
}

export const __testInternals = {
  deletedTargetReferences,
  derivativeSubmitIdentity,
  desiredPayload,
  issue,
  readDerivativeSubmitProof,
};
