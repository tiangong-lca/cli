import { CliError, toErrorPayload } from './lib/errors.js';
import type { DotEnvLoadResult } from './lib/dotenv.js';
import type { FetchLike } from './lib/http.js';
import type {
  inspectSupabaseAuthStatus,
  loginWithSupabaseOAuth,
  logoutSupabaseUserSession,
} from './lib/supabase-session.js';
import type {
  AuthIdentityReceipt,
  RunAuthIdentityReceiptOptions,
} from './lib/auth-identity-receipt.js';
import type { LcaReleaseReport, RunLcaReleaseOptions } from './lib/lca-release.js';
import type { RunValidationOptions, ValidationRunReport } from './lib/validation.js';
import type {
  DatasetImportLcaReport,
  RunDatasetImportLcaConvertOptions,
} from './lib/dataset-import-lca.js';
import type {
  DatasetClassificationApplyReport,
  DatasetClassificationAuditReport,
  DatasetClassificationChildrenReport,
  DatasetClassificationPathReport,
  RunDatasetClassificationApplyOptions,
  RunDatasetClassificationAuditOptions,
  RunDatasetClassificationChildrenOptions,
  RunDatasetClassificationPathOptions,
} from './lib/dataset-classification.js';
import type {
  DatasetMaintenanceClearAccountReport,
  RunDatasetMaintenanceClearAccountOptions,
} from './lib/dataset-maintenance-clear-account.js';
import type { runDatasetMaintenancePlan } from './lib/dataset-maintenance-plan.js';
import type { runDatasetMaintenanceApply } from './lib/dataset-maintenance-apply.js';
import type { freezeDatasetMaintenanceProtected } from './lib/dataset-maintenance-protected-freeze.js';
import type {
  DatasetMaintenanceProtectedReport,
  RunDatasetMaintenanceProtectedOptions,
} from './lib/dataset-maintenance-protected-run.js';
import type { AliasV2ProtectedReport } from './lib/dataset-alias-v2-protected.js';
import type { sealDatasetMaintenanceProtectedApproval } from './lib/dataset-maintenance-protected-seal.js';
import type { runDatasetMaintenanceVerify } from './lib/dataset-maintenance-verify.js';
import type { runFlowIdentityPlanFromFiles } from './lib/dataset-maintenance-flow-identity-command.js';
import type { captureFlowIdentity } from './lib/dataset-maintenance-flow-identity-capture.js';
import type { freezeFlowIdentity } from './lib/dataset-maintenance-flow-identity-freeze.js';
import type { sealFlowIdentityApproval } from './lib/dataset-maintenance-flow-identity-seal.js';
import type {
  freezeFlowIdentityRecovery,
  sealFlowIdentityRecoveryApproval,
} from './lib/dataset-maintenance-flow-identity-recovery.js';
import type { runFlowIdentity } from './lib/dataset-maintenance-flow-identity-run.js';
import type { verifyFlowIdentity } from './lib/dataset-maintenance-flow-identity-verify.js';

export type CliDeps = {
  env: NodeJS.ProcessEnv;
  dotEnvStatus: DotEnvLoadResult;
  fetchImpl: FetchLike;
  runAuthIdentityReceiptImpl?: (
    options: RunAuthIdentityReceiptOptions,
  ) => Promise<AuthIdentityReceipt>;
  loginWithSupabaseOAuthImpl?: typeof loginWithSupabaseOAuth;
  logoutSupabaseUserSessionImpl?: typeof logoutSupabaseUserSession;
  inspectSupabaseAuthStatusImpl?: typeof inspectSupabaseAuthStatus;
  runValidationImpl?: (options: RunValidationOptions) => Promise<ValidationRunReport>;
  runLcaReleaseImpl?: (options: RunLcaReleaseOptions) => Promise<LcaReleaseReport>;
  runDatasetImportLcaConvertImpl?: (
    options: RunDatasetImportLcaConvertOptions,
  ) => Promise<DatasetImportLcaReport> | DatasetImportLcaReport;
  runDatasetClassificationChildrenImpl?: (
    options: RunDatasetClassificationChildrenOptions,
  ) => Promise<DatasetClassificationChildrenReport>;
  runDatasetClassificationPathImpl?: (
    options: RunDatasetClassificationPathOptions,
  ) => Promise<DatasetClassificationPathReport>;
  runDatasetClassificationAuditImpl?: (
    options: RunDatasetClassificationAuditOptions,
  ) => Promise<DatasetClassificationAuditReport>;
  runDatasetClassificationApplyImpl?: (
    options: RunDatasetClassificationApplyOptions,
  ) => Promise<DatasetClassificationApplyReport>;
  runDatasetMaintenanceClearAccountImpl?: (
    options: RunDatasetMaintenanceClearAccountOptions,
  ) => Promise<DatasetMaintenanceClearAccountReport>;
  runDatasetMaintenancePlanImpl?: typeof runDatasetMaintenancePlan;
  runDatasetMaintenanceApplyImpl?: typeof runDatasetMaintenanceApply;
  freezeDatasetMaintenanceProtectedImpl?: typeof freezeDatasetMaintenanceProtected;
  runDatasetMaintenanceProtectedImpl?: (
    options: RunDatasetMaintenanceProtectedOptions,
  ) => Promise<DatasetMaintenanceProtectedReport | AliasV2ProtectedReport>;
  sealDatasetMaintenanceProtectedApprovalImpl?: typeof sealDatasetMaintenanceProtectedApproval;
  runDatasetMaintenanceVerifyImpl?: typeof runDatasetMaintenanceVerify;
  runFlowIdentityPlanFromFilesImpl?: typeof runFlowIdentityPlanFromFiles;
  captureFlowIdentityImpl?: typeof captureFlowIdentity;
  freezeFlowIdentityImpl?: typeof freezeFlowIdentity;
  sealFlowIdentityApprovalImpl?: typeof sealFlowIdentityApproval;
  freezeFlowIdentityRecoveryImpl?: typeof freezeFlowIdentityRecovery;
  sealFlowIdentityRecoveryApprovalImpl?: typeof sealFlowIdentityRecoveryApproval;
  runFlowIdentityImpl?: typeof runFlowIdentity;
  verifyFlowIdentityImpl?: typeof verifyFlowIdentity;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Project a failure consistently at the process IO boundary. */
export function cliFailure(error: unknown): CliResult {
  return {
    exitCode: error instanceof CliError ? error.exitCode : 1,
    stdout: '',
    stderr: `${JSON.stringify(toErrorPayload(error))}\n`,
  };
}
