import { CliError } from '../shared/errors.js';
import { stringifyJson } from '../lib/io.js';
import { loadCliPackageVersion } from '../lib/package-version.js';

import {
  freezeAliasV2Protected,
  isAliasV2FreezeFile,
  planAliasV2,
  protectedPlanFileProfile,
  sealAliasV2ProtectedApproval,
} from '../lib/dataset-alias-v2-public.js';
import { planLengthTime } from '../lib/dataset-length-time-public.js';

import type { ResolvedCliDeps, CliResult } from './ports.js';
import {
  renderDatasetMaintenanceHelp,
  renderDatasetMaintenanceFlowIdentityHelp,
  renderDatasetMaintenancePlanHelp,
  renderDatasetMaintenanceApplyHelp,
  renderDatasetMaintenanceFreezeProtectedHelp,
  renderDatasetMaintenanceSealProtectedApprovalHelp,
  renderDatasetMaintenanceRunProtectedHelp,
  renderDatasetMaintenanceVerifyHelp,
  renderDatasetMaintenanceClearAccountHelp,
} from './maintenance-help.js';
import {
  parseDatasetMaintenanceClearAccountFlags,
  parseDatasetMaintenancePlanFlags,
  parseDatasetMaintenanceApplyFlags,
  parseDatasetMaintenanceFreezeProtectedFlags,
  parseDatasetMaintenanceSealProtectedApprovalFlags,
  parseDatasetMaintenanceProtectedFlags,
  parseDatasetMaintenanceFlowIdentityFlags,
  parseDatasetMaintenanceVerifyFlags,
} from './maintenance-options.js';

export async function executeMaintenanceCommand(
  commandArgs: string[],
  deps: ResolvedCliDeps,
): Promise<CliResult> {
  const datasetMaintenanceClearAccountImpl = deps.runDatasetMaintenanceClearAccountImpl;
  const datasetMaintenancePlanImpl = deps.runDatasetMaintenancePlanImpl;
  const datasetMaintenanceApplyImpl = deps.runDatasetMaintenanceApplyImpl;
  const datasetMaintenanceProtectedFreezeImpl = deps.freezeDatasetMaintenanceProtectedImpl;
  const datasetMaintenanceProtectedImpl = deps.runDatasetMaintenanceProtectedImpl;
  const datasetMaintenanceProtectedApprovalSealImpl =
    deps.sealDatasetMaintenanceProtectedApprovalImpl;
  const datasetMaintenanceVerifyImpl = deps.runDatasetMaintenanceVerifyImpl;
  const flowIdentityPlanImpl = deps.runFlowIdentityPlanFromFilesImpl;
  const flowIdentityCaptureImpl = deps.captureFlowIdentityImpl;
  const flowIdentityFreezeImpl = deps.freezeFlowIdentityImpl;
  const flowIdentityApprovalSealImpl = deps.sealFlowIdentityApprovalImpl;
  const flowIdentityRecoveryFreezeImpl = deps.freezeFlowIdentityRecoveryImpl;
  const flowIdentityRecoveryApprovalSealImpl = deps.sealFlowIdentityRecoveryApprovalImpl;
  const flowIdentityRunImpl = deps.runFlowIdentityImpl;
  const flowIdentityVerifyImpl = deps.verifyFlowIdentityImpl;

  const action = commandArgs[0] ?? '';
  if (!action || action === '--help' || action === '-h') {
    return { exitCode: 0, stdout: `${renderDatasetMaintenanceHelp()}\n`, stderr: '' };
  }
  if (action === 'flow-identity') {
    const flowAction = commandArgs[1] ?? '';
    if (!flowAction || flowAction === '--help' || flowAction === '-h') {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceFlowIdentityHelp()}\n`,
        stderr: '',
      };
    }
    const datasetFlags = parseDatasetMaintenanceFlowIdentityFlags(commandArgs.slice(2));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceFlowIdentityHelp()}\n`,
        stderr: '',
      };
    }
    const required = (value: string, flag: string): string => {
      if (!value) {
        throw new CliError(`dataset maintenance flow-identity ${flowAction} requires ${flag}.`, {
          code: 'DATASET_FLOW_IDENTITY_ARGUMENT_REQUIRED',
          exitCode: 2,
        });
      }
      return value;
    };
    if (flowAction === 'capture') {
      const report = await flowIdentityCaptureImpl({
        policyPath: required(datasetFlags.policyPath, '--policy'),
        reviewLedgerPath: required(datasetFlags.reviewLedgerPath, '--review-ledger'),
        prerequisitesPath: required(datasetFlags.prerequisitesPath, '--prerequisites'),
        toolchainEvidencePath: required(datasetFlags.toolchainEvidencePath, '--toolchain-evidence'),
        requestId: required(datasetFlags.requestId, '--request-id'),
        operationId: required(datasetFlags.operationId, '--operation-id'),
        expectedProjectRef: required(datasetFlags.expectedProjectRef, '--expected-project-ref'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        sdkVersion: required(datasetFlags.sdkVersion, '--sdk-version'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
        pageSize: datasetFlags.pageSize,
        readConcurrency: datasetFlags.readConcurrency,
        timeoutMs: datasetFlags.timeoutMs,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      return { exitCode: 0, stdout: stringifyJson(report, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'plan') {
      const plan = await flowIdentityPlanImpl({
        policyPath: required(datasetFlags.policyPath, '--policy'),
        reviewLedgerPath: required(datasetFlags.reviewLedgerPath, '--review-ledger'),
        liveCapturePath: required(datasetFlags.liveCapturePath, '--live-capture'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
      });
      return { exitCode: 0, stdout: stringifyJson(plan, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'freeze') {
      const report = await flowIdentityFreezeImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        toolchainEvidencePath: required(datasetFlags.toolchainEvidencePath, '--toolchain-evidence'),
        approvedAtUtc: required(datasetFlags.approvedAtUtc, '--approved-at'),
        expectedProjectRef: required(datasetFlags.expectedProjectRef, '--expected-project-ref'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        outDir: required(datasetFlags.outDir, '--out-dir'),
      });
      return { exitCode: 0, stdout: stringifyJson(report, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'seal-approval') {
      const report = await flowIdentityApprovalSealImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        freezePath: required(datasetFlags.freezePath, '--freeze'),
        approvalRequestPath: required(datasetFlags.approvalRequestPath, '--approval-request'),
        humanApprovalPath: required(datasetFlags.humanApprovalPath, '--human-approval'),
        approveFreezeFile: required(datasetFlags.approveFreezeFile, '--approve-freeze-file'),
        approveRequest: required(datasetFlags.approveRequest, '--approve-request'),
        approveText: required(datasetFlags.approveText, '--approve-text'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        approvedAtUtc: required(datasetFlags.approvedAtUtc, '--approved-at'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
      });
      return { exitCode: 0, stdout: stringifyJson(report, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'freeze-recovery') {
      const recoveryReason = required(datasetFlags.recoveryReason, '--recovery-reason');
      if (
        ![
          'wrapper_exited_without_permit',
          'process_response_ambiguous',
          'process_domain_rejected',
          'finalize_response_ambiguous',
          'derivatives_became_ready_after_wrapper_exit',
        ].includes(recoveryReason)
      ) {
        throw new CliError('flow-identity recovery reason is not allowed.', {
          code: 'DATASET_FLOW_IDENTITY_RECOVERY_REASON_INVALID',
          exitCode: 2,
        });
      }
      const report = await flowIdentityRecoveryFreezeImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        freezePath: required(datasetFlags.freezePath, '--freeze'),
        approvalPath: required(datasetFlags.approvalPath, '--approval'),
        runDir: required(datasetFlags.runDir, '--run-dir'),
        toolchainEvidencePath: required(datasetFlags.toolchainEvidencePath, '--toolchain-evidence'),
        expectedProjectRef: required(datasetFlags.expectedProjectRef, '--expected-project-ref'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        approvedAtUtc: required(datasetFlags.approvedAtUtc, '--approved-at'),
        recoveryReason: recoveryReason as
          | 'wrapper_exited_without_permit'
          | 'process_response_ambiguous'
          | 'process_domain_rejected'
          | 'finalize_response_ambiguous'
          | 'derivatives_became_ready_after_wrapper_exit',
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        outDir: required(datasetFlags.outDir, '--out-dir'),
        timeoutMs: datasetFlags.timeoutMs,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      return { exitCode: 0, stdout: stringifyJson(report, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'seal-recovery-approval') {
      const report = flowIdentityRecoveryApprovalSealImpl({
        recoveryFreezePath: required(datasetFlags.recoveryFreezePath, '--recovery-freeze'),
        approvalRequestPath: required(datasetFlags.approvalRequestPath, '--approval-request'),
        humanApprovalPath: required(datasetFlags.humanApprovalPath, '--human-approval'),
        approveFreezeFile: required(datasetFlags.approveFreezeFile, '--approve-freeze-file'),
        approveRequest: required(datasetFlags.approveRequest, '--approve-request'),
        approveText: required(datasetFlags.approveText, '--approve-text'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        approvedAtUtc: required(datasetFlags.approvedAtUtc, '--approved-at'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
      });
      return { exitCode: 0, stdout: stringifyJson(report, datasetFlags.json), stderr: '' };
    }
    if (flowAction === 'run-recovery') {
      if (!datasetFlags.commit || datasetFlags.statusOnly) {
        throw new CliError('flow-identity run-recovery requires --commit only.', {
          code: 'DATASET_FLOW_IDENTITY_RECOVERY_RUN_MODE_INVALID',
          exitCode: 2,
        });
      }
      const report = await flowIdentityRunImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        freezePath: required(datasetFlags.freezePath, '--freeze'),
        approvalPath: required(datasetFlags.approvalPath, '--approval'),
        recoveryRunDir: required(datasetFlags.runDir, '--run-dir'),
        recoveryFreezePath: required(datasetFlags.recoveryFreezePath, '--recovery-freeze'),
        recoveryApprovalPath: required(datasetFlags.recoveryApprovalPath, '--recovery-approval'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
        commit: true,
        statusOnly: false,
        approveExecution: required(datasetFlags.approveExecution, '--approve-execution'),
        confirm: required(datasetFlags.confirm, '--confirm'),
        waitSeconds: datasetFlags.waitSeconds,
        pollMs: datasetFlags.pollMs,
        timeoutMs: datasetFlags.timeoutMs,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      return {
        exitCode: report.status === 'passed' ? 0 : 1,
        stdout: stringifyJson(report, datasetFlags.json),
        stderr: '',
      };
    }
    if (flowAction === 'run') {
      if (datasetFlags.commit === datasetFlags.statusOnly) {
        throw new CliError('flow-identity run requires exactly one of --commit or --status-only.', {
          code: 'DATASET_FLOW_IDENTITY_RUN_MODE_INVALID',
          exitCode: 2,
        });
      }
      if (datasetFlags.commit) {
        required(datasetFlags.approveExecution, '--approve-execution');
        required(datasetFlags.confirm, '--confirm');
      }
      const report = await flowIdentityRunImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        freezePath: required(datasetFlags.freezePath, '--freeze'),
        approvalPath: required(datasetFlags.approvalPath, '--approval'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
        commit: datasetFlags.commit,
        statusOnly: datasetFlags.statusOnly,
        approveExecution: datasetFlags.approveExecution || undefined,
        confirm: datasetFlags.confirm || undefined,
        waitSeconds: datasetFlags.waitSeconds,
        pollMs: datasetFlags.pollMs,
        timeoutMs: datasetFlags.timeoutMs,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      return {
        exitCode: report.status === 'passed' ? 0 : 1,
        stdout: stringifyJson(report, datasetFlags.json),
        stderr: '',
      };
    }
    if (flowAction === 'verify') {
      const report = await flowIdentityVerifyImpl({
        planPath: required(datasetFlags.planPath, '--plan'),
        freezePath: required(datasetFlags.freezePath, '--freeze'),
        approvalPath: required(datasetFlags.approvalPath, '--approval'),
        runDir: required(datasetFlags.runDir, '--run-dir'),
        outDir: required(datasetFlags.outDir, '--out-dir'),
        pageSize: datasetFlags.pageSize,
        timeoutMs: datasetFlags.timeoutMs,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      return {
        exitCode: report.status === 'passed' ? 0 : 1,
        stdout: stringifyJson(report, datasetFlags.json),
        stderr: '',
      };
    }
    throw new CliError(
      "dataset maintenance flow-identity action must be 'capture', 'plan', 'freeze', 'seal-approval', 'run', 'freeze-recovery', 'seal-recovery-approval', 'run-recovery', or 'verify'.",
      { code: 'DATASET_FLOW_IDENTITY_ACTION_INVALID', exitCode: 2 },
    );
  }
  if (action === 'clear-account') {
    const datasetFlags = parseDatasetMaintenanceClearAccountFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceClearAccountHelp()}\n`,
        stderr: '',
      };
    }
    const report = await datasetMaintenanceClearAccountImpl({
      outDir: datasetFlags.outDir,
      stateCodes: datasetFlags.stateCodes,
      pageSize: datasetFlags.pageSize,
      timeoutMs: datasetFlags.timeoutMs,
      commit: datasetFlags.commit,
      confirm: datasetFlags.confirm,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: report.status === 'completed_with_failures' ? 1 : 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'plan') {
    const datasetFlags = parseDatasetMaintenancePlanFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenancePlanHelp()}\n`,
        stderr: '',
      };
    }
    if (datasetFlags.lengthTimeInputPath) {
      // Explicit versioned selection: the reviewed Length*time planning input builds the
      // versioned plan through the builder the protected run consumes.
      if (!datasetFlags.outDir) {
        throw new CliError('dataset maintenance plan requires --out-dir.', {
          code: 'DATASET_MAINTENANCE_OUT_DIR_REQUIRED',
          exitCode: 2,
        });
      }
      const lengthPlan = planLengthTime({
        inputPath: datasetFlags.lengthTimeInputPath,
        outDir: datasetFlags.outDir,
      });
      return {
        exitCode: 0,
        stdout: stringifyJson(lengthPlan, datasetFlags.json),
        stderr: '',
      };
    }
    if (datasetFlags.aliasV2InputPath) {
      // Explicit versioned selection: the reviewed alias-plan input document builds the
      // versioned plan and batch through the same builder the protected run consumes.
      if (!datasetFlags.outDir) {
        throw new CliError('dataset maintenance plan requires --out-dir.', {
          code: 'DATASET_MAINTENANCE_OUT_DIR_REQUIRED',
          exitCode: 2,
        });
      }
      const v2Plan = planAliasV2({
        inputPath: datasetFlags.aliasV2InputPath,
        outDir: datasetFlags.outDir,
      });
      return {
        exitCode: 0,
        stdout: stringifyJson(v2Plan, datasetFlags.json),
        stderr: '',
      };
    }
    if (!datasetFlags.scopePath) {
      throw new CliError('dataset maintenance plan requires --scope.', {
        code: 'DATASET_MAINTENANCE_SCOPE_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.operation) {
      throw new CliError('dataset maintenance plan requires --operation.', {
        code: 'DATASET_MAINTENANCE_OPERATION_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.outDir) {
      throw new CliError('dataset maintenance plan requires --out-dir.', {
        code: 'DATASET_MAINTENANCE_OUT_DIR_REQUIRED',
        exitCode: 2,
      });
    }
    const report = await datasetMaintenancePlanImpl({
      scopePath: datasetFlags.scopePath,
      operation: datasetFlags.operation,
      outDir: datasetFlags.outDir,
      pageSize: datasetFlags.pageSize,
      timeoutMs: datasetFlags.timeoutMs,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: report.status === 'blocked' ? 1 : 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'apply') {
    const datasetFlags = parseDatasetMaintenanceApplyFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceApplyHelp()}\n`,
        stderr: '',
      };
    }
    if (!datasetFlags.planPath) {
      throw new CliError('dataset maintenance apply requires --plan.', {
        code: 'DATASET_MAINTENANCE_PLAN_REQUIRED',
        exitCode: 2,
      });
    }
    if (datasetFlags.commit && datasetFlags.dryRun) {
      throw new CliError('Cannot pass both --commit and --dry-run.', {
        code: 'DATASET_MAINTENANCE_APPLY_MODE_CONFLICT',
        exitCode: 2,
      });
    }
    if (datasetFlags.dryRun) {
      throw new CliError(
        'dataset maintenance apply is commit-only; use dataset maintenance plan for a dry run.',
        {
          code: 'DATASET_MAINTENANCE_APPLY_COMMIT_ONLY',
          exitCode: 2,
        },
      );
    }
    if (!datasetFlags.commit) {
      throw new CliError('dataset maintenance apply requires --commit.', {
        code: 'DATASET_MAINTENANCE_APPLY_COMMIT_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.approvePlan) {
      throw new CliError('dataset maintenance apply requires --approve-plan <sha256>.', {
        code: 'DATASET_MAINTENANCE_APPROVAL_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.confirm) {
      throw new CliError('dataset maintenance apply requires --confirm <email>.', {
        code: 'DATASET_MAINTENANCE_CONFIRM_REQUIRED',
        exitCode: 2,
      });
    }
    const report = await datasetMaintenanceApplyImpl({
      planPath: datasetFlags.planPath,
      commit: datasetFlags.commit,
      approvePlan: datasetFlags.approvePlan,
      confirm: datasetFlags.confirm,
      timeoutMs: datasetFlags.timeoutMs,
      maxParallel: datasetFlags.maxParallel,
      globalInboundProofPath: datasetFlags.globalInboundProofPath || undefined,
      approveGlobalInboundProof: datasetFlags.approveGlobalInboundProof || undefined,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: ['completed_with_failures', 'completed_with_unknowns'].includes(report.status)
        ? 1
        : 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'freeze-protected') {
    const datasetFlags = parseDatasetMaintenanceFreezeProtectedFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceFreezeProtectedHelp()}\n`,
        stderr: '',
      };
    }
    if (!datasetFlags.planPath) {
      throw new CliError('dataset maintenance freeze-protected requires --plan.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_PLAN_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.toolchainEvidencePath) {
      throw new CliError('dataset maintenance freeze-protected requires --toolchain-evidence.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_TOOLCHAIN_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.expectedProjectRef) {
      throw new CliError('dataset maintenance freeze-protected requires --expected-project-ref.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_PROJECT_REF_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.confirm) {
      throw new CliError('dataset maintenance freeze-protected requires --confirm.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.outDir) {
      throw new CliError('dataset maintenance freeze-protected requires --out-dir.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_OUT_DIR_REQUIRED',
        exitCode: 2,
      });
    }
    if (protectedPlanFileProfile(datasetFlags.planPath) !== null) {
      // The versioned freeze derives every binding from the plan, the toolchain evidence and
      // the frozen derivative baselines; the account is the authenticated owner's.
      if (!datasetFlags.derivativeBaselinesPath) {
        throw new CliError(
          'dataset maintenance freeze-protected requires --derivative-baselines for a versioned plan.',
          {
            code: 'DATASET_MAINTENANCE_PROTECTED_BASELINES_REQUIRED',
            exitCode: 2,
          },
        );
      }
      const v2Freeze = await freezeAliasV2Protected({
        planPath: datasetFlags.planPath,
        toolchainEvidencePath: datasetFlags.toolchainEvidencePath,
        derivativeBaselinesPath: datasetFlags.derivativeBaselinesPath,
        outDir: datasetFlags.outDir,
        expectedProjectRef: datasetFlags.expectedProjectRef,
        confirm: datasetFlags.confirm,
        cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
        env: deps.env,
        fetchImpl: deps.fetchImpl,
        ...(datasetFlags.timeoutMs === undefined ? {} : { timeoutMs: datasetFlags.timeoutMs }),
      });
      return {
        exitCode: 0,
        stdout: stringifyJson(v2Freeze, datasetFlags.json),
        stderr: '',
      };
    }
    const report = await datasetMaintenanceProtectedFreezeImpl({
      planPath: datasetFlags.planPath,
      toolchainEvidencePath: datasetFlags.toolchainEvidencePath,
      outDir: datasetFlags.outDir,
      expectedProjectRef: datasetFlags.expectedProjectRef,
      confirm: datasetFlags.confirm,
      cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
      pageSize: datasetFlags.pageSize,
      timeoutMs: datasetFlags.timeoutMs,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'seal-protected-approval') {
    const datasetFlags = parseDatasetMaintenanceSealProtectedApprovalFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceSealProtectedApprovalHelp()}\n`,
        stderr: '',
      };
    }
    if (!datasetFlags.freezePath) {
      throw new CliError('dataset maintenance seal-protected-approval requires --freeze.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.approvalRequestPath) {
      throw new CliError(
        'dataset maintenance seal-protected-approval requires --approval-request.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_REQUEST_REQUIRED',
          exitCode: 2,
        },
      );
    }
    if (!datasetFlags.humanApprovalPath) {
      throw new CliError('dataset maintenance seal-protected-approval requires --human-approval.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_HUMAN_APPROVAL_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.approveFreezeFile) {
      throw new CliError(
        'dataset maintenance seal-protected-approval requires --approve-freeze-file.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_CONFIRMATION_REQUIRED',
          exitCode: 2,
        },
      );
    }
    if (!datasetFlags.approveRequest) {
      throw new CliError(
        'dataset maintenance seal-protected-approval requires --approve-request.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_REQUEST_CONFIRMATION_REQUIRED',
          exitCode: 2,
        },
      );
    }
    if (!datasetFlags.approveText) {
      throw new CliError('dataset maintenance seal-protected-approval requires --approve-text.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_TEXT_CONFIRMATION_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.confirm) {
      throw new CliError('dataset maintenance seal-protected-approval requires --confirm.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.approvedAtUtc) {
      throw new CliError('dataset maintenance seal-protected-approval requires --approved-at.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_APPROVED_AT_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.outDir) {
      throw new CliError('dataset maintenance seal-protected-approval requires --out-dir.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_OUT_DIR_REQUIRED',
        exitCode: 2,
      });
    }
    if (isAliasV2FreezeFile(datasetFlags.freezePath)) {
      const v2Seal = sealAliasV2ProtectedApproval({
        freezePath: datasetFlags.freezePath,
        approvalRequestPath: datasetFlags.approvalRequestPath,
        humanApprovalPath: datasetFlags.humanApprovalPath,
        outDir: datasetFlags.outDir,
        approveFreezeFile: datasetFlags.approveFreezeFile,
        approveRequest: datasetFlags.approveRequest,
        approveText: datasetFlags.approveText,
        confirm: datasetFlags.confirm,
        approvedAtUtc: datasetFlags.approvedAtUtc,
      });
      return {
        exitCode: 0,
        stdout: stringifyJson(v2Seal, datasetFlags.json),
        stderr: '',
      };
    }
    const report = await datasetMaintenanceProtectedApprovalSealImpl({
      freezePath: datasetFlags.freezePath,
      approvalRequestPath: datasetFlags.approvalRequestPath,
      humanApprovalPath: datasetFlags.humanApprovalPath,
      outDir: datasetFlags.outDir,
      approveFreezeFile: datasetFlags.approveFreezeFile,
      approveRequest: datasetFlags.approveRequest,
      approveText: datasetFlags.approveText,
      confirm: datasetFlags.confirm,
      approvedAtUtc: datasetFlags.approvedAtUtc,
    });
    return {
      exitCode: 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'run-protected') {
    const datasetFlags = parseDatasetMaintenanceProtectedFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceRunProtectedHelp()}\n`,
        stderr: '',
      };
    }
    if (!datasetFlags.planPath) {
      throw new CliError('dataset maintenance run-protected requires --plan.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_PLAN_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.freezePath) {
      throw new CliError('dataset maintenance run-protected requires --freeze.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.approvalPath) {
      throw new CliError('dataset maintenance run-protected requires --approval.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_FILE_REQUIRED',
        exitCode: 2,
      });
    }
    if (!datasetFlags.outDir) {
      throw new CliError('dataset maintenance run-protected requires --out-dir.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_OUT_DIR_REQUIRED',
        exitCode: 2,
      });
    }
    if (datasetFlags.commit && datasetFlags.statusOnly) {
      throw new CliError('Cannot pass both --commit and --status-only.', {
        code: 'DATASET_MAINTENANCE_PROTECTED_MODE_CONFLICT',
        exitCode: 2,
      });
    }
    if (!datasetFlags.commit && !datasetFlags.statusOnly) {
      throw new CliError(
        'dataset maintenance run-protected requires either --commit or --status-only.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_MODE_REQUIRED',
          exitCode: 2,
        },
      );
    }
    if (datasetFlags.commit && !datasetFlags.approveExecution) {
      throw new CliError(
        'dataset maintenance run-protected requires --approve-execution <sha256> with --commit.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_REQUIRED',
          exitCode: 2,
        },
      );
    }
    if (datasetFlags.commit && !datasetFlags.confirm) {
      throw new CliError(
        'dataset maintenance run-protected requires --confirm <email> with --commit.',
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_CONFIRM_REQUIRED',
          exitCode: 2,
        },
      );
    }
    const report = await datasetMaintenanceProtectedImpl({
      planPath: datasetFlags.planPath,
      freezePath: datasetFlags.freezePath,
      approvalPath: datasetFlags.approvalPath,
      outDir: datasetFlags.outDir,
      commit: datasetFlags.commit,
      statusOnly: datasetFlags.statusOnly,
      approveExecution: datasetFlags.approveExecution,
      confirm: datasetFlags.confirm,
      waitSeconds: datasetFlags.waitSeconds,
      pollMs: datasetFlags.pollMs,
      pageSize: datasetFlags.pageSize,
      timeoutMs: datasetFlags.timeoutMs,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: report.status === 'passed' ? 0 : 1,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (action === 'verify') {
    const datasetFlags = parseDatasetMaintenanceVerifyFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return {
        exitCode: 0,
        stdout: `${renderDatasetMaintenanceVerifyHelp()}\n`,
        stderr: '',
      };
    }
    if (!datasetFlags.planPath) {
      throw new CliError('dataset maintenance verify requires --plan.', {
        code: 'DATASET_MAINTENANCE_PLAN_REQUIRED',
        exitCode: 2,
      });
    }
    const report = await datasetMaintenanceVerifyImpl({
      planPath: datasetFlags.planPath,
      outDir: datasetFlags.outDir,
      pageSize: datasetFlags.pageSize,
      timeoutMs: datasetFlags.timeoutMs,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: report.status === 'passed' ? 0 : 1,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  throw new CliError(
    "dataset maintenance action must be 'clear-account', 'plan', 'apply', 'freeze-protected', 'seal-protected-approval', 'run-protected', 'verify', or 'flow-identity'.",
    {
      code: 'DATASET_MAINTENANCE_ACTION_INVALID',
      exitCode: 2,
    },
  );
}
