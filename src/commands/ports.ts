import type { DotEnvLoadResult } from '../lib/config/dotenv.js';
import type { FetchLike } from '../lib/transport/http.js';
import type {
  inspectSupabaseAuthStatus,
  loginWithSupabaseOAuth,
  logoutSupabaseUserSession,
} from '../lib/auth/supabase-session.js';
import type {
  AuthIdentityReceipt,
  RunAuthIdentityReceiptOptions,
} from '../lib/auth/auth-identity-receipt.js';
import type { LcaReleaseReport, RunLcaReleaseOptions } from '../lib/release/lca-release.js';
import type { RunValidationOptions, ValidationRunReport } from '../lib/validation/validation.js';
import type {
  DatasetImportLcaReport,
  RunDatasetImportLcaConvertOptions,
} from '../lib/dataset/import-lca.js';
import type {
  DatasetClassificationApplyReport,
  DatasetClassificationAuditReport,
  DatasetClassificationChildrenReport,
  DatasetClassificationPathReport,
  RunDatasetClassificationApplyOptions,
  RunDatasetClassificationAuditOptions,
  RunDatasetClassificationChildrenOptions,
  RunDatasetClassificationPathOptions,
} from '../lib/dataset/classification.js';
import type {
  DatasetMaintenanceClearAccountReport,
  RunDatasetMaintenanceClearAccountOptions,
} from '../lib/maintenance/clear-account.js';
import type { runDatasetMaintenancePlan } from '../lib/maintenance/plan.js';
import type { runDatasetMaintenanceApply } from '../lib/maintenance/apply.js';

import type { runDatasetMaintenanceVerify } from '../lib/maintenance/verify.js';

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
  runDatasetMaintenanceVerifyImpl?: typeof runDatasetMaintenanceVerify;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ResolvedCliDeps = Required<CliDeps>;
