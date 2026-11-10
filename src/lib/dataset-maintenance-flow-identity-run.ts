import path from 'node:path';
import {
  finalizeMaintenanceFlowIdentityScope,
  lookupMaintenanceFlowIdentityScope,
  preflightMaintenanceFlowIdentityScope,
  recoverMaintenanceFlowIdentityScope,
  readMaintenanceFlowIdentityScope,
  resolveMaintenanceRemoteContext,
  rewriteMaintenanceFlowIdentityProcess,
} from './dataset-maintenance-remote.js';
import { withStateFileLock } from './state-lock.js';
import { claimFlowIdentityApproval } from './dataset-maintenance-flow-identity-approval-claim.js';
import {
  type RunFlowIdentityOptions,
  type FlowIdentityRunReport,
  errorDetails,
} from './maintenance/flow-identity/run-types.js';
import {
  readCanonicalJson,
  processStem,
  loadProcessTemplates,
  prepareRun,
  assertContext,
} from './maintenance/flow-identity/run-preparation.js';
import { numberedArtifact } from './maintenance/flow-identity/scope-recovery.js';
import {
  validateCompletedRequests,
  requirePendingProcess,
  report,
  completedRunStatus,
  waitForFinalizeDecision,
} from './maintenance/flow-identity/run-results.js';
import { executeRun } from './maintenance/flow-identity/execution.js';
export {
  type FlowIdentityRunStatus,
  type RunFlowIdentityOptions,
  type FlowIdentityRunReport,
} from './maintenance/flow-identity/run-types.js';

export async function runFlowIdentity(
  options: RunFlowIdentityOptions,
): Promise<FlowIdentityRunReport> {
  // Status-only may be invoked with a different caller path. Resolve the
  // immutable approval claim before locking so every reader/writer serializes
  // on the one canonical run directory.
  const prepared = prepareRun(options);
  const outDir = prepared.outDir;
  return withStateFileLock(
    path.join(outDir, 'flow-identity-run-state'),
    { reason: 'dataset flow identity serial runner', timeoutMs: 0 },
    () =>
      executeRun(
        options,
        {
          resolveContext: resolveMaintenanceRemoteContext,
          preflight: preflightMaintenanceFlowIdentityScope,
          lookup: lookupMaintenanceFlowIdentityScope,
          recover: recoverMaintenanceFlowIdentityScope,
          rewrite: rewriteMaintenanceFlowIdentityProcess,
          read: readMaintenanceFlowIdentityScope,
          finalize: finalizeMaintenanceFlowIdentityScope,
          sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          now: () => options.now ?? new Date(),
          claimApproval: claimFlowIdentityApproval,
        },
        prepared,
      ),
  );
}

export const __testInternals = {
  assertContext,
  completedRunStatus,
  errorDetails,
  executeRun,
  loadProcessTemplates,
  numberedArtifact,
  prepareRun,
  processStem,
  readCanonicalJson,
  requirePendingProcess,
  report,
  validateCompletedRequests,
  waitForFinalizeDecision,
};
