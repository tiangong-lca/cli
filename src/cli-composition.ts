import { writeResearchReport } from './adapters/report.js';
import { runDatasetClassificationChildren } from './lib/dataset/classification.js';
import { runDatasetClassificationPath } from './lib/dataset/classification.js';
import { runValidation } from './lib/validation/validation.js';
import { runDatasetImportLcaConvert } from './lib/dataset/import-lca.js';
import { runDatasetClassificationAudit } from './lib/dataset/classification.js';
import { runDatasetClassificationApply } from './lib/dataset/classification.js';
import { runDatasetMaintenanceClearAccount } from './lib/maintenance/clear-account.js';
import { runDatasetMaintenancePlan } from './lib/maintenance/plan.js';
import { runDatasetMaintenanceApply } from './lib/maintenance/apply.js';
import { runDatasetMaintenanceVerify } from './lib/maintenance/verify.js';
import { runLcaRelease } from './lib/release/lca-release.js';
import { runAuthIdentityReceipt } from './lib/auth/auth-identity-receipt.js';
import { loginWithSupabaseOAuth } from './lib/auth/supabase-session.js';
import { logoutSupabaseUserSession } from './lib/auth/supabase-session.js';
import { inspectSupabaseAuthStatus } from './lib/auth/supabase-session.js';
import type { CliDeps, ResolvedCliDeps } from './cli-deps.js';

/** Select production adapters once; callers may override explicit ports for isolated tests. */
export function composeCliDeps(deps: CliDeps): ResolvedCliDeps {
  return {
    ...deps,
    writeResearchReportImpl: deps.writeResearchReportImpl ?? writeResearchReport,
    runDatasetClassificationChildrenImpl:
      deps.runDatasetClassificationChildrenImpl ?? runDatasetClassificationChildren,
    runDatasetClassificationPathImpl:
      deps.runDatasetClassificationPathImpl ?? runDatasetClassificationPath,
    runValidationImpl: deps.runValidationImpl ?? runValidation,
    runDatasetImportLcaConvertImpl:
      deps.runDatasetImportLcaConvertImpl ?? runDatasetImportLcaConvert,
    runDatasetClassificationAuditImpl:
      deps.runDatasetClassificationAuditImpl ?? runDatasetClassificationAudit,
    runDatasetClassificationApplyImpl:
      deps.runDatasetClassificationApplyImpl ?? runDatasetClassificationApply,
    runDatasetMaintenanceClearAccountImpl:
      deps.runDatasetMaintenanceClearAccountImpl ?? runDatasetMaintenanceClearAccount,
    runDatasetMaintenancePlanImpl: deps.runDatasetMaintenancePlanImpl ?? runDatasetMaintenancePlan,
    runDatasetMaintenanceApplyImpl:
      deps.runDatasetMaintenanceApplyImpl ?? runDatasetMaintenanceApply,
    runDatasetMaintenanceVerifyImpl:
      deps.runDatasetMaintenanceVerifyImpl ?? runDatasetMaintenanceVerify,
    runLcaReleaseImpl: deps.runLcaReleaseImpl ?? runLcaRelease,
    runAuthIdentityReceiptImpl: deps.runAuthIdentityReceiptImpl ?? runAuthIdentityReceipt,
    loginWithSupabaseOAuthImpl: deps.loginWithSupabaseOAuthImpl ?? loginWithSupabaseOAuth,
    logoutSupabaseUserSessionImpl: deps.logoutSupabaseUserSessionImpl ?? logoutSupabaseUserSession,
    inspectSupabaseAuthStatusImpl: deps.inspectSupabaseAuthStatusImpl ?? inspectSupabaseAuthStatus,
  };
}
