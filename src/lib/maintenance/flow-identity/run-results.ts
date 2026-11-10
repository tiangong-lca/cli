import { existsSync } from 'node:fs';
import { writePrivateImmutableJson } from '../../dataset-maintenance-protected-artifacts.js';
import { buildFlowIdentityProcessRequest } from './requests.js';
import {
  flowIdentityScopeHasCurrentDerivativeClosure,
  flowIdentityScopeIsReadyToFinalize,
} from './status.js';
import type { FlowIdentityScopeProof, FlowIdentityScopeStatus } from './base.js';
import type {
  MaintenanceRpcDomainFailure,
  DatasetMaintenanceRemoteContext,
} from '../../dataset-maintenance-remote.js';
import {
  type FlowIdentityRunStatus,
  type RunFlowIdentityOptions,
  type FlowIdentityRunReport,
  type ProcessTemplate,
  type PreparedRun,
  type RunDependencies,
  DEFAULT_POLL_MS,
  PARTIAL_EXECUTION_RECOVERY,
  OPERATOR_REVIEW_REQUIRED,
  fail,
  errorDetails,
} from './run-types.js';
import { numberedArtifact, readScope } from './scope-recovery.js';

export function validateCompletedRequests(
  prepared: PreparedRun,
  status: FlowIdentityScopeStatus,
): void {
  for (const ledger of status.processes.filter((entry) => entry.status === 'completed')) {
    const template = prepared.templates[ledger.ordinal - 1];
    if (!template) {
      fail(
        'Database progress contains a foreign completed ordinal.',
        'DATASET_FLOW_IDENTITY_PROGRESS_INVALID',
      );
    }
    const request = buildFlowIdentityProcessRequest({
      scopeProofSha256: status.scope_proof_sha256,
      ordinal: ledger.ordinal,
      processIntentProofSha256: ledger.process_intent_proof_sha256,
    });
    if (ledger.process_request_sha256 !== request.process_request_sha256) {
      fail(
        `Completed process ${ledger.ordinal} used a foreign request hash.`,
        'DATASET_FLOW_IDENTITY_PROGRESS_INVALID',
      );
    }
  }
}

export function requirePendingProcess(
  prepared: PreparedRun,
  status: FlowIdentityScopeStatus,
  ordinal: number,
): { ledger: FlowIdentityScopeStatus['processes'][number]; template: ProcessTemplate } {
  const ledger = status.processes[ordinal - 1];
  const template = prepared.templates[ordinal - 1];
  if (!ledger || !template || ledger.status !== 'pending') {
    fail(
      'Durable scope did not expose exactly one pending next ordinal.',
      'DATASET_FLOW_IDENTITY_NEXT_ORDINAL_INVALID',
    );
  }
  return { ledger, template };
}

export function report(options: {
  prepared: PreparedRun;
  mode: 'commit' | 'status_only';
  status: FlowIdentityRunStatus;
  scope: FlowIdentityScopeProof | null;
  database: FlowIdentityScopeStatus | null;
  issues?: FlowIdentityRunReport['issues'];
  now: Date;
}): FlowIdentityRunReport {
  const value: FlowIdentityRunReport = {
    schema_version: 'dataset-flow-identity-run-report.v2',
    generated_at_utc: options.now.toISOString(),
    mode: options.mode,
    status: options.status,
    operation_id: options.prepared.plan.operation_id,
    plan_sha256: options.prepared.plan.plan_sha256,
    request_id: options.prepared.identity.request_id,
    identity_sha256: options.prepared.identity.identity_sha256,
    scope_id: options.scope?.scope_id ?? null,
    database_status: options.database?.status ?? null,
    process_count: options.prepared.plan.processes.length,
    completed_process_count: options.database?.completed_process_count ?? 0,
    next_ordinal: options.database?.next_ordinal ?? null,
    automatic_retry: false,
    issues: options.issues ?? [],
  };
  writePrivateImmutableJson(numberedArtifact(options.prepared.outDir, 'run-report'), value);
  return value;
}

export async function reportProcessDomainRejection(options: {
  prepared: PreparedRun;
  mode: 'commit' | 'status_only';
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  dependencies: RunDependencies;
  ordinal: number;
  requestSha256: string;
  response: MaintenanceRpcDomainFailure;
  rejectionPath: string;
}): Promise<FlowIdentityRunReport> {
  let recovered: FlowIdentityScopeStatus | null = null;
  let readError: unknown = null;
  try {
    recovered = await readScope({
      prepared: options.prepared,
      context: options.context,
      scope: options.scope,
      dependencies: options.dependencies,
    });
    validateCompletedRequests(options.prepared, recovered);
  } catch (error) {
    readError = error;
  }
  const recovery =
    recovered && recovered.completed_process_count > 0
      ? PARTIAL_EXECUTION_RECOVERY
      : OPERATOR_REVIEW_REQUIRED;
  if (!existsSync(options.rejectionPath)) {
    writePrivateImmutableJson(options.rejectionPath, {
      schema_version: 'dataset-flow-identity-process-domain-rejection.v2',
      status: 'rejected',
      ordinal: options.ordinal,
      process_request_sha256: options.requestSha256,
      automatic_retry: false,
      approval_reusable: false,
      recovery,
      response: options.response,
    });
  }
  writePrivateImmutableJson(
    numberedArtifact(
      options.prepared.outDir,
      `process-domain-rejection-recovery-${String(options.ordinal).padStart(6, '0')}`,
    ),
    {
      schema_version: 'dataset-flow-identity-process-domain-rejection-recovery.v1',
      observed_at_utc: options.dependencies.now().toISOString(),
      scope_id: options.scope.scope_id,
      ordinal: options.ordinal,
      process_request_sha256: options.requestSha256,
      status_read_succeeded: recovered !== null,
      completed_process_count: recovered?.completed_process_count ?? null,
      next_ordinal: recovered?.next_ordinal ?? null,
      strict_continuation_required: recovered?.strict_continuation_required ?? null,
      recovery,
      automatic_retry: false,
      ...(readError === null ? {} : { error: errorDetails(readError) }),
    },
  );
  const recoveryIssue =
    recovery === PARTIAL_EXECUTION_RECOVERY
      ? {
          code: 'DATASET_FLOW_IDENTITY_PARTIAL_EXECUTION_REQUIRES_STATUS_READ_AND_OPERATOR_APPROVED_SCOPE_RECOVERY',
          message:
            'Primary writes already exist. Recovery requires fresh status reads and an operator-approved scope recovery; do not start a fresh capture.',
          details: { recovery },
        }
      : {
          code: 'DATASET_FLOW_IDENTITY_OPERATOR_REVIEW_REQUIRED',
          message:
            'No completed primary write is proven by the bounded status read; operator review is required before any next action.',
          details: { recovery },
        };
  return report({
    prepared: options.prepared,
    mode: options.mode,
    status: readError === null ? 'blocked' : 'indeterminate',
    scope: options.scope,
    database: recovered,
    issues: [
      {
        code: options.response.code,
        message:
          typeof options.response.message === 'string'
            ? options.response.message
            : `The database deterministically rejected process ${options.ordinal}.`,
        details: { response: options.response, recovery },
      },
      ...(readError === null
        ? [recoveryIssue]
        : [
            {
              code: 'DATASET_FLOW_IDENTITY_PROCESS_DOMAIN_REJECTION_STATUS_READ_FAILED',
              message:
                'The bounded recovery status read failed; execution is indeterminate and requires operator review.',
              details: { recovery, error: errorDetails(readError) },
            },
          ]),
    ],
    now: options.dependencies.now(),
  });
}

export function hasFlowIdentityFinalizeDecision(status: FlowIdentityScopeStatus): boolean {
  return (
    status.status === 'completed' ||
    status.status === 'live_drift' ||
    status.status === 'failed' ||
    status.compensation_required === true ||
    flowIdentityScopeIsReadyToFinalize(status)
  );
}

export function completedRunStatus(status: FlowIdentityScopeStatus): 'passed' | 'blocked' {
  return flowIdentityScopeHasCurrentDerivativeClosure(status) ? 'passed' : 'blocked';
}

export async function waitForFinalizeDecision(options: {
  command: RunFlowIdentityOptions;
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  initial: FlowIdentityScopeStatus;
  dependencies: RunDependencies;
}): Promise<FlowIdentityScopeStatus> {
  const waitSeconds = options.command.waitSeconds ?? 0;
  const pollMs = options.command.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 86_400) {
    fail('waitSeconds must be an integer from 0 to 86400.', 'DATASET_FLOW_IDENTITY_WAIT_INVALID');
  }
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
    fail('pollMs must be an integer from 100 to 60000.', 'DATASET_FLOW_IDENTITY_POLL_INVALID');
  }
  const deadline = Date.now() + waitSeconds * 1_000;
  let current = options.initial;
  while (!hasFlowIdentityFinalizeDecision(current) && Date.now() < deadline) {
    await options.dependencies.sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
    current = await readScope(options);
    validateCompletedRequests(options.prepared, current);
  }
  return current;
}
