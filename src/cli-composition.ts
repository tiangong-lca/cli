import { runDatasetClassificationChildren } from './lib/dataset-classification.js';
import { runDatasetClassificationPath } from './lib/dataset-classification.js';
import { runValidation } from './lib/validation.js';
import { runDatasetImportLcaConvert } from './lib/dataset-import-lca.js';
import { runDatasetClassificationAudit } from './lib/dataset-classification.js';
import { runDatasetClassificationApply } from './lib/dataset-classification.js';
import { runDatasetMaintenanceClearAccount } from './lib/dataset-maintenance-clear-account.js';
import { runDatasetMaintenancePlan } from './lib/dataset-maintenance-plan.js';
import { runDatasetMaintenanceApply } from './lib/dataset-maintenance-apply.js';
import { freezeDatasetMaintenanceProtected } from './lib/dataset-maintenance-protected-freeze.js';
import { runDatasetMaintenanceProtectedDispatch } from './lib/dataset-maintenance-protected-dispatch.js';
import { sealDatasetMaintenanceProtectedApproval } from './lib/dataset-maintenance-protected-seal.js';
import { runDatasetMaintenanceVerify } from './lib/dataset-maintenance-verify.js';
import { runFlowIdentityPlanFromFiles } from './lib/dataset-maintenance-flow-identity-command.js';
import { captureFlowIdentity } from './lib/dataset-maintenance-flow-identity-capture.js';
import { freezeFlowIdentity } from './lib/dataset-maintenance-flow-identity-freeze.js';
import { sealFlowIdentityApproval } from './lib/dataset-maintenance-flow-identity-seal.js';
import { freezeFlowIdentityRecovery } from './lib/dataset-maintenance-flow-identity-recovery.js';
import { sealFlowIdentityRecoveryApproval } from './lib/dataset-maintenance-flow-identity-recovery.js';
import { runFlowIdentity } from './lib/dataset-maintenance-flow-identity-run.js';
import { verifyFlowIdentity } from './lib/dataset-maintenance-flow-identity-verify.js';
import { runLcaRelease } from './lib/lca-release.js';
import { runAuthIdentityReceipt } from './lib/auth-identity-receipt.js';
import { loginWithSupabaseOAuth } from './lib/supabase-session.js';
import { logoutSupabaseUserSession } from './lib/supabase-session.js';
import { inspectSupabaseAuthStatus } from './lib/supabase-session.js';
import type { CliDeps, ResolvedCliDeps } from './cli-deps.js';

/** Select production adapters once; callers may override explicit ports for isolated tests. */
export function composeCliDeps(deps: CliDeps): ResolvedCliDeps {
  return {
    ...deps,
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
    freezeDatasetMaintenanceProtectedImpl:
      deps.freezeDatasetMaintenanceProtectedImpl ?? freezeDatasetMaintenanceProtected,
    runDatasetMaintenanceProtectedImpl:
      deps.runDatasetMaintenanceProtectedImpl ?? runDatasetMaintenanceProtectedDispatch,
    sealDatasetMaintenanceProtectedApprovalImpl:
      deps.sealDatasetMaintenanceProtectedApprovalImpl ?? sealDatasetMaintenanceProtectedApproval,
    runDatasetMaintenanceVerifyImpl:
      deps.runDatasetMaintenanceVerifyImpl ?? runDatasetMaintenanceVerify,
    runFlowIdentityPlanFromFilesImpl:
      deps.runFlowIdentityPlanFromFilesImpl ?? runFlowIdentityPlanFromFiles,
    captureFlowIdentityImpl: deps.captureFlowIdentityImpl ?? captureFlowIdentity,
    freezeFlowIdentityImpl: deps.freezeFlowIdentityImpl ?? freezeFlowIdentity,
    sealFlowIdentityApprovalImpl: deps.sealFlowIdentityApprovalImpl ?? sealFlowIdentityApproval,
    freezeFlowIdentityRecoveryImpl:
      deps.freezeFlowIdentityRecoveryImpl ?? freezeFlowIdentityRecovery,
    sealFlowIdentityRecoveryApprovalImpl:
      deps.sealFlowIdentityRecoveryApprovalImpl ?? sealFlowIdentityRecoveryApproval,
    runFlowIdentityImpl: deps.runFlowIdentityImpl ?? runFlowIdentity,
    verifyFlowIdentityImpl: deps.verifyFlowIdentityImpl ?? verifyFlowIdentity,
    runLcaReleaseImpl: deps.runLcaReleaseImpl ?? runLcaRelease,
    runAuthIdentityReceiptImpl: deps.runAuthIdentityReceiptImpl ?? runAuthIdentityReceipt,
    loginWithSupabaseOAuthImpl: deps.loginWithSupabaseOAuthImpl ?? loginWithSupabaseOAuth,
    logoutSupabaseUserSessionImpl: deps.logoutSupabaseUserSessionImpl ?? logoutSupabaseUserSession,
    inspectSupabaseAuthStatusImpl: deps.inspectSupabaseAuthStatusImpl ?? inspectSupabaseAuthStatus,
  };
}
