import { CliError } from '../shared/errors.js';
import { stringifyJson } from '../lib/platform/io.js';

import type { ResolvedCliDeps, CliResult } from './ports.js';
import {
  renderDatasetMaintenanceHelp,
  renderDatasetMaintenancePlanHelp,
  renderDatasetMaintenanceApplyHelp,
  renderDatasetMaintenanceVerifyHelp,
  renderDatasetMaintenanceClearAccountHelp,
} from './maintenance-help.js';
import {
  parseDatasetMaintenanceClearAccountFlags,
  parseDatasetMaintenancePlanFlags,
  parseDatasetMaintenanceApplyFlags,
  parseDatasetMaintenanceVerifyFlags,
} from './maintenance-options.js';

export async function executeMaintenanceCommand(
  commandArgs: string[],
  deps: ResolvedCliDeps,
): Promise<CliResult> {
  const datasetMaintenanceClearAccountImpl = deps.runDatasetMaintenanceClearAccountImpl;
  const datasetMaintenancePlanImpl = deps.runDatasetMaintenancePlanImpl;
  const datasetMaintenanceApplyImpl = deps.runDatasetMaintenanceApplyImpl;
  const datasetMaintenanceVerifyImpl = deps.runDatasetMaintenanceVerifyImpl;

  const action = commandArgs[0] ?? '';
  if (!action || action === '--help' || action === '-h') {
    return { exitCode: 0, stdout: `${renderDatasetMaintenanceHelp()}\n`, stderr: '' };
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
    "dataset maintenance action must be 'clear-account', 'plan', 'apply', or 'verify'.",
    {
      code: 'DATASET_MAINTENANCE_ACTION_INVALID',
      exitCode: 2,
    },
  );
}
