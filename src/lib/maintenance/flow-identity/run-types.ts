import type { prepareFlowIdentityExecution } from '../../dataset-maintenance-flow-identity-execution-contract.js';
import type {
  FlowIdentityExecutionPermit,
  FlowIdentityScopeProof,
  FlowIdentityScopeStatus,
} from './base.js';
import type { PreparedFlowIdentityRecoveryExecution } from '../../dataset-maintenance-flow-identity-recovery.js';
import type { FlowIdentityProcessTemplate } from '../../dataset-maintenance-flow-identity-contract.js';
import type {
  finalizeMaintenanceFlowIdentityScope,
  lookupMaintenanceFlowIdentityScope,
  preflightMaintenanceFlowIdentityScope,
  recoverMaintenanceFlowIdentityScope,
  readMaintenanceFlowIdentityScope,
  resolveMaintenanceRemoteContext,
  rewriteMaintenanceFlowIdentityProcess,
  MaintenanceRpcDomainFailure,
} from '../../dataset-maintenance-remote.js';
import { CliError } from '../../../shared/errors.js';
import type { FetchLike } from '../../http.js';
import type { FlowIdentityApprovalClaim } from '../../dataset-maintenance-flow-identity-approval-claim.js';

export type FlowIdentityRunStatus = 'passed' | 'pending' | 'blocked' | 'failed' | 'indeterminate';

export type RunFlowIdentityOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  recoveryFreezePath?: string;
  recoveryApprovalPath?: string;
  recoveryRunDir?: string;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  approveExecution?: string;
  confirm?: string;
  waitSeconds?: number;
  pollMs?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
};

export type FlowIdentityRunReport = {
  schema_version: 'dataset-flow-identity-run-report.v2';
  generated_at_utc: string;
  mode: 'commit' | 'status_only';
  status: FlowIdentityRunStatus;
  operation_id: string;
  plan_sha256: string;
  request_id: string;
  identity_sha256: string;
  scope_id: string | null;
  database_status: FlowIdentityScopeStatus['status'] | null;
  process_count: number;
  completed_process_count: number;
  next_ordinal: number | null;
  automatic_retry: false;
  issues: Array<{ code: string; message: string; details?: unknown }>;
};

export type ProcessTemplate = Pick<
  FlowIdentityProcessTemplate,
  'process' | 'rewrites' | 'collision_ledger'
>;

export type PreparedRun = ReturnType<typeof prepareFlowIdentityExecution> & {
  planPath: string;
  outDir: string;
  templates: ProcessTemplate[];
  recovery: PreparedFlowIdentityRecoveryExecution | null;
  approvalClaim: FlowIdentityApprovalClaim | null;
};

export type RunDependencies = {
  resolveContext: typeof resolveMaintenanceRemoteContext;
  preflight: typeof preflightMaintenanceFlowIdentityScope;
  lookup?: typeof lookupMaintenanceFlowIdentityScope;
  recover?: typeof recoverMaintenanceFlowIdentityScope;
  rewrite: typeof rewriteMaintenanceFlowIdentityProcess;
  read: typeof readMaintenanceFlowIdentityScope;
  finalize: typeof finalizeMaintenanceFlowIdentityScope;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  claimApproval?: (options: { claim: FlowIdentityApprovalClaim; env: NodeJS.ProcessEnv }) => string;
};

export type ObtainedScope = {
  scope: FlowIdentityScopeProof | MaintenanceRpcDomainFailure;
  executionPermit: FlowIdentityExecutionPermit | null;
  recoveryAmbiguity?: {
    observed: FlowIdentityScopeStatus | null;
    error: { name: string; message: string; code: string | null };
  };
};

export const DEFAULT_POLL_MS = 10_000;
export const PARTIAL_EXECUTION_RECOVERY =
  'partial_execution_requires_status_read_and_operator_approved_scope_recovery';
export const OPERATOR_REVIEW_REQUIRED = 'operator_review_required';

export function fail(message: string, code: string, details?: unknown): never {
  throw new CliError(message, {
    code,
    exitCode: 1,
    ...(details === undefined ? {} : { details }),
  });
}

export function errorDetails(error: unknown): {
  name: string;
  message: string;
  code: string | null;
} {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    code:
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null,
  };
}

export function assertDomainFailureHasNoPermit(
  value: MaintenanceRpcDomainFailure,
  label: string,
): void {
  if (Object.hasOwn(value, 'execution_permit')) {
    fail(
      `${label} domain rejection unexpectedly contained a bearer permit.`,
      'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_PERMIT_INVALID',
    );
  }
}
