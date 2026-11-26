import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact } from '../platform/artifacts.js';
import { CliError } from '../../shared/errors.js';
import { withStateFileLock } from '../locks/state-lock.js';

import { appendStableJsonLine, readJsonFile, writeImmutableJson } from './contract/files.js';
import { parseMaintenancePlan } from './contract.js';
import { type DatasetMaintenanceProgressEntry } from './contract/types.js';
import { derivativePlanAction } from './derivatives.js';
import {
  fetchMaintenanceAccountRows,
  fetchMaintenanceVisibleTableRows,
  resolveMaintenanceRemoteContext,
} from './remote.js';
import {
  type DatasetMaintenanceApplyReport,
  type RunDatasetMaintenanceApplyOptions,
  PARALLEL_DELETE_VISIBLE_PROCESS_PAGE_SIZE,
  type ParallelDeleteExecutionState,
  type ProgressState,
  type DerivativeSubmitProgressEntry,
  type DerivativeSubmitProgressState,
  clock,
  errorMessage,
  parallelDeleteDesiredSha256,
  normalizeMaintenanceMaxParallel,
  loadDesiredPayload,
} from './apply/base.js';
import {
  assertParallelDeletePlan,
  parallelDeleteTargetBindingSha256,
  assertGlobalInboundProofOptionShape,
  validateParallelDeleteGlobalInboundProof,
  assertNoVisibleProcessInboundReferences,
  finalProjectedRows,
  assertApplyPreconditions,
  validateApprovalRecord,
} from './apply/preconditions.js';
import {
  parseParallelDeleteExecutionLog,
  appendParallelDeleteExecutionEntry,
  parseProgress,
  derivativeProofIdentity,
  parseDerivativeSubmitProgress,
  validateDerivativeAdmissionAttempt,
  nextAttemptPath,
  nextParallelDeleteInboundBarrierPath,
} from './apply/progress.js';

import {
  executeAction,
  remoteAuditId,
  executeParallelDeletePlan,
  executeDerivativeAdmission,
} from './apply/execution.js';
export {
  type DatasetMaintenanceApplyReport,
  type RunDatasetMaintenanceApplyOptions,
} from './apply/base.js';

export async function runDatasetMaintenanceApply(
  options: RunDatasetMaintenanceApplyOptions,
): Promise<DatasetMaintenanceApplyReport> {
  if (!options.commit) {
    throw new CliError('Dataset maintenance apply requires commit=true.', {
      code: 'DATASET_MAINTENANCE_COMMIT_REQUIRED',
      exitCode: 2,
    });
  }
  const planPath = path.resolve(options.planPath);
  const planDir = path.dirname(planPath);
  const plan = parseMaintenancePlan(readJsonFile(planPath, 'Maintenance plan'));
  const parallelDeleteMode = options.maxParallel !== undefined;
  const maxParallel = normalizeMaintenanceMaxParallel(options.maxParallel);
  assertGlobalInboundProofOptionShape({
    parallelDeleteMode,
    proofPath: options.globalInboundProofPath,
    approveProof: options.approveGlobalInboundProof,
  });
  if (parallelDeleteMode) {
    assertParallelDeletePlan(plan);
  }
  if (options.approvePlan !== plan.plan_sha256) {
    throw new CliError('approvePlan must exactly match the canonical maintenance plan hash.', {
      code: 'DATASET_MAINTENANCE_PLAN_APPROVAL_REQUIRED',
      exitCode: 2,
    });
  }
  if (plan.status !== 'ready' || plan.blockers.length > 0) {
    throw new CliError('Blocked maintenance plan cannot be applied.', {
      code: 'DATASET_MAINTENANCE_PLAN_BLOCKED',
      exitCode: 1,
      details: plan.blockers,
    });
  }

  if (
    plan.operation === 'redo-import' &&
    !plan.source_import_run_id &&
    plan.source_lineage === null
  ) {
    throw new CliError('redo-import apply requires frozen redo source/import lineage.', {
      code: 'DATASET_MAINTENANCE_REDO_NOT_READY',
      exitCode: 1,
    });
  }

  const progressPath = path.join(
    planDir,
    plan.operation === 'rebuild-derivatives'
      ? 'derivative-submit-progress.jsonl'
      : 'apply-progress.jsonl',
  );
  return withStateFileLock(
    progressPath,
    { reason: `dataset_maintenance_apply_${plan.operation_id}` },
    async () => {
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
      if (options.confirm !== context.account.email) {
        throw new CliError('confirm must exactly match the current authenticated account email.', {
          code: 'DATASET_MAINTENANCE_CONFIRMATION_REQUIRED',
          exitCode: 2,
        });
      }
      const globalInboundProof = parallelDeleteMode
        ? validateParallelDeleteGlobalInboundProof({
            proofPath: options.globalInboundProofPath,
            approveProof: options.approveGlobalInboundProof,
            plan,
            context,
            now: options.now ?? new Date(),
          })
        : null;
      const derivativeProgress: DerivativeSubmitProgressState =
        plan.operation === 'rebuild-derivatives'
          ? parseDerivativeSubmitProgress(plan, progressPath)
          : { entries: [], latest: null };
      const progress: ProgressState =
        plan.operation === 'rebuild-derivatives'
          ? { entries: [], successes: new Map(), latestFailures: new Map() }
          : parseProgress(plan, progressPath);
      const executionLogPath = path.join(planDir, 'apply-execution-log.jsonl');
      const parallelDeleteExecution: ParallelDeleteExecutionState = parallelDeleteMode
        ? parseParallelDeleteExecutionLog(plan, executionLogPath)
        : { entries: [], byAction: new Map(), dispatched: new Set(), committed: new Set() };
      const resumedSuccesses = progress.successes.size;
      const [current, visibleProcesses] = await Promise.all([
        fetchMaintenanceAccountRows({
          context,
          userId: plan.account.user_id,
        }),
        parallelDeleteMode && !globalInboundProof
          ? fetchMaintenanceVisibleTableRows({
              context,
              table: 'processes',
              pageSize: PARALLEL_DELETE_VISIBLE_PROCESS_PAGE_SIZE,
            })
          : Promise.resolve(null),
      ]);
      assertApplyPreconditions({
        plan,
        planDir,
        currentRows: current.rows,
        progress,
        attemptedDeleteActionIds: parallelDeleteExecution.dispatched,
      });

      const inboundBarrierPath = nextParallelDeleteInboundBarrierPath(planDir);
      const inboundBarrier = globalInboundProof
        ? {
            process_rows: globalInboundProof.global_process_rows,
            process_references: globalInboundProof.global_exchange_rows,
            snapshot_sha256: globalInboundProof.proof_sha256,
          }
        : parallelDeleteMode && visibleProcesses
          ? assertNoVisibleProcessInboundReferences({ plan, rows: visibleProcesses.rows })
          : null;
      if (inboundBarrier && (visibleProcesses || globalInboundProof)) {
        writeImmutableJson(inboundBarrierPath, {
          schema_version: 1,
          generated_at_utc: clock(options),
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          actor: { user_id: context.account.user_id, email: context.account.email },
          target_table: 'flows',
          target_count: plan.actions.length,
          inbound_reference_count: 0,
          ...inboundBarrier,
          completeness: globalInboundProof
            ? {
                status: 'complete',
                complete: true,
                strategy: 'sha256_approved_global_select_only_all_processes',
                statement_kind: globalInboundProof.statement_kind,
                process_scope: globalInboundProof.process_scope,
                proof_path: globalInboundProof.proof_path,
                proof_sha256: globalInboundProof.proof_sha256,
                captured_at_utc: globalInboundProof.captured_at_utc,
                target_binding_sha256: globalInboundProof.target_binding_sha256,
                chunk_count: globalInboundProof.chunks.length,
                global_process_rows: globalInboundProof.global_process_rows,
                global_exchange_rows: globalInboundProof.global_exchange_rows,
                inbound_exchanges: globalInboundProof.inbound_exchanges,
              }
            : visibleProcesses!.completeness,
        });
      }

      const approvalPath = path.join(planDir, 'approval-record.json');
      const approvalAlreadyExisted = existsSync(approvalPath);
      validateApprovalRecord({ path: approvalPath, plan, context });
      if (!approvalAlreadyExisted) {
        writeImmutableJson(approvalPath, {
          schema_version: 1,
          approved_at_utc: clock(options),
          plan_path: planPath,
          plan_sha256: plan.plan_sha256,
          task_id: plan.task_id,
          operation: plan.operation,
          target_mode: plan.target_mode,
          operation_id: plan.operation_id,
          account: {
            user_id: context.account.user_id,
            email: context.account.email,
          },
          confirmed_email: options.confirm,
          row_counts: plan.summary,
          snapshot_completeness: current.completeness,
          redo_rows_ready:
            plan.operation === 'redo-import'
              ? Boolean(plan.source_import_run_id || plan.source_lineage !== null)
              : null,
        });
      }

      if (plan.operation === 'rebuild-derivatives') {
        const startedAt = clock(options);
        const derivativeAttemptPath = path.join(planDir, 'derivative-admission-attempt.json');
        const derivativeAttempt = validateDerivativeAdmissionAttempt({
          path: derivativeAttemptPath,
          plan,
          context,
        });
        const proof = await executeDerivativeAdmission({
          plan,
          context,
          replayPossible: derivativeAttempt !== null,
          attemptPath: derivativeAttemptPath,
          preparedAtUtc: startedAt,
        });
        if (
          derivativeProgress.latest &&
          derivativeProofIdentity(derivativeProgress.latest.proof) !==
            derivativeProofIdentity(proof)
        ) {
          throw new CliError('Derivative guarded-RPC replay returned a different request proof.', {
            code: 'DATASET_MAINTENANCE_DERIVATIVE_REPLAY_MISMATCH',
            exitCode: 1,
          });
        }
        const action = derivativePlanAction(plan);
        const entry: DerivativeSubmitProgressEntry = {
          schema_version: 1,
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          action_id: action.action_id,
          target_mode: 'owner_draft',
          actor: { user_id: context.account.user_id, email: context.account.email },
          started_at_utc: startedAt,
          ended_at_utc: clock(options),
          result: 'accepted',
          proof,
        };
        appendStableJsonLine(progressPath, entry);
        const attemptPath = nextAttemptPath(planDir);
        const report: DatasetMaintenanceApplyReport = {
          schema_version: 1,
          generated_at_utc: clock(options),
          status: 'accepted',
          task_id: plan.task_id,
          operation: plan.operation,
          operation_id: plan.operation_id,
          target_mode: plan.target_mode,
          plan_sha256: plan.plan_sha256,
          actor: { user_id: context.account.user_id, email: context.account.email },
          summary: {
            actions: 1,
            success: 0,
            failed: 0,
            pending: 1,
            resumed_successes: 0,
            accepted: 1,
          },
          actions: [
            {
              action_id: action.action_id,
              action: action.action,
              table: action.table,
              id: action.id,
              version: action.version,
              status: 'accepted',
              error: null,
            },
          ],
          artifacts: {
            approval_record: approvalPath,
            apply_progress: progressPath,
            derivative_submit_progress: progressPath,
            derivative_admission_attempt: derivativeAttemptPath,
            commit_report: path.join(planDir, 'commit-report.json'),
            attempt_report: attemptPath,
          },
          database_audit: {
            rpc_transaction_log: 'public.command_audit_log',
            source: 'tiangong-lca dataset maintenance apply',
            correlation_fields: [
              'plan_sha256',
              'operation_id',
              'action_id',
              'target_visibility',
              'plan_request_sha256',
              'action_request_sha256',
              'request_id',
            ],
          },
          derivative_admission: { ...proof, admission: 'accepted' },
        };
        writeImmutableJson(attemptPath, report);
        writeJsonArtifact(report.artifacts.commit_report, report);
        return report;
      }

      if (parallelDeleteMode) {
        const executionStatuses = await executeParallelDeletePlan({
          plan,
          context,
          progress,
          progressPath,
          executionLogPath,
          execution: parallelDeleteExecution,
          maxParallel,
          now: () => clock(options),
        });
        const actions = plan.actions.map((action) => {
          const status = executionStatuses.get(action.action_id) as
            'success' | 'failed' | 'unknown';
          return {
            action_id: action.action_id,
            action: action.action,
            table: action.table,
            id: action.id,
            version: action.version,
            status,
            error: progress.latestFailures.get(action.action_id)?.error ?? null,
          };
        });
        const successCount = actions.filter((action) => action.status === 'success').length;
        const failureCount = actions.filter((action) => action.status === 'failed').length;
        const unknownCount = actions.filter((action) => action.status === 'unknown').length;
        const attemptPath = nextAttemptPath(planDir);
        const report: DatasetMaintenanceApplyReport = {
          schema_version: 1,
          generated_at_utc: clock(options),
          status:
            unknownCount > 0
              ? 'completed_with_unknowns'
              : successCount === actions.length
                ? 'completed'
                : 'completed_with_failures',
          task_id: plan.task_id,
          operation: plan.operation,
          operation_id: plan.operation_id,
          target_mode: plan.target_mode,
          plan_sha256: plan.plan_sha256,
          actor: { user_id: context.account.user_id, email: context.account.email },
          summary: {
            actions: actions.length,
            success: successCount,
            failed: failureCount,
            unknown: unknownCount,
            pending: actions.length - successCount - failureCount - unknownCount,
            resumed_successes: resumedSuccesses,
          },
          actions,
          artifacts: {
            approval_record: approvalPath,
            apply_progress: progressPath,
            execution_log: executionLogPath,
            inbound_reference_barrier: inboundBarrierPath,
            commit_report: path.join(planDir, 'commit-report.json'),
            attempt_report: attemptPath,
          },
          database_audit: {
            rpc_transaction_log: 'public.command_audit_log',
            source: 'tiangong-lca dataset maintenance apply',
            correlation_fields: [
              'plan_sha256',
              'operation_id',
              'action_id',
              'reason_code',
              'desired_sha256',
            ],
          },
        };
        writeImmutableJson(attemptPath, report);
        writeJsonArtifact(report.artifacts.commit_report, report);
        return report;
      }

      const ordered = [...plan.actions].sort((left, right) => {
        const rank = {
          save_draft: 0,
          rebuild_derivatives: 0,
          delete: 1,
        } as const;
        const actionOrder = rank[left.action] - rank[right.action];
        return actionOrder || left.ordinal - right.ordinal;
      });
      for (const action of ordered) {
        if (progress.successes.has(action.action_id)) {
          continue;
        }
        const startedAt = clock(options);
        try {
          const actionResult = await executeAction({ action, plan, planDir, context });
          const entry: DatasetMaintenanceProgressEntry = {
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
            actor: { user_id: context.account.user_id, email: context.account.email },
            started_at_utc: startedAt,
            ended_at_utc: clock(options),
            before_sha256: action.before!.row_sha256,
            after_sha256: actionResult.afterSha256,
            remote_result_sha256: actionResult.remoteResultSha256,
            result: 'success',
            error: null,
            rollback: action.rollback,
          };
          appendStableJsonLine(progressPath, entry);
          progress.entries.push(entry);
          progress.successes.set(action.action_id, entry);
          progress.latestFailures.delete(action.action_id);
        } catch (error) {
          const entry: DatasetMaintenanceProgressEntry = {
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
            actor: { user_id: context.account.user_id, email: context.account.email },
            started_at_utc: startedAt,
            ended_at_utc: clock(options),
            before_sha256: action.before!.row_sha256,
            after_sha256: null,
            remote_result_sha256: null,
            result: 'failed',
            error: errorMessage(error),
            rollback: action.rollback,
          };
          appendStableJsonLine(progressPath, entry);
          progress.entries.push(entry);
          progress.latestFailures.set(action.action_id, entry);
          break;
        }
      }

      const actions = plan.actions.map((action) => {
        const success = progress.successes.get(action.action_id);
        const failure = progress.latestFailures.get(action.action_id);
        return {
          action_id: action.action_id,
          action: action.action,
          table: action.table,
          id: action.id,
          version: action.version,
          status: success
            ? ('success' as const)
            : failure
              ? ('failed' as const)
              : ('pending' as const),
          error: failure?.error ?? null,
        };
      });
      const successCount = actions.filter((action) => action.status === 'success').length;
      const failureCount = actions.filter((action) => action.status === 'failed').length;
      const attemptPath = nextAttemptPath(planDir);
      const report: DatasetMaintenanceApplyReport = {
        schema_version: 1,
        generated_at_utc: clock(options),
        status: successCount === actions.length ? 'completed' : 'completed_with_failures',
        task_id: plan.task_id,
        operation: plan.operation,
        operation_id: plan.operation_id,
        target_mode: plan.target_mode,
        plan_sha256: plan.plan_sha256,
        actor: { user_id: context.account.user_id, email: context.account.email },
        summary: {
          actions: actions.length,
          success: successCount,
          failed: failureCount,
          pending: actions.length - successCount - failureCount,
          resumed_successes: resumedSuccesses,
        },
        actions,
        artifacts: {
          approval_record: approvalPath,
          apply_progress: progressPath,
          commit_report: path.join(planDir, 'commit-report.json'),
          attempt_report: attemptPath,
        },
        database_audit: {
          rpc_transaction_log: 'public.command_audit_log',
          source: 'tiangong-lca dataset maintenance apply',
          correlation_fields: ['plan_sha256', 'operation_id', 'action_id', 'reason_code'],
        },
      };
      writeImmutableJson(attemptPath, report);
      writeJsonArtifact(report.artifacts.commit_report, report);
      return report;
    },
  );
}

export const __testInternals = {
  appendParallelDeleteExecutionEntry,
  assertNoVisibleProcessInboundReferences,
  assertApplyPreconditions,
  assertGlobalInboundProofOptionShape,
  assertParallelDeletePlan,
  clock,
  errorMessage,
  executeDerivativeAdmission,
  executeAction,
  executeParallelDeletePlan,
  finalProjectedRows,
  loadDesiredPayload,
  nextAttemptPath,
  nextParallelDeleteInboundBarrierPath,
  normalizeMaintenanceMaxParallel,
  parallelDeleteDesiredSha256,
  parallelDeleteTargetBindingSha256,
  parseDerivativeSubmitProgress,
  validateDerivativeAdmissionAttempt,
  parseProgress,
  parseParallelDeleteExecutionLog,
  remoteAuditId,
  validateApprovalRecord,
  validateParallelDeleteGlobalInboundProof,
};
