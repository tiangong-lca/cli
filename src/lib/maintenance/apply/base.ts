import { loadMaintenanceDesiredPayload } from '../desired-payload.js';
import { CliError } from '../../../shared/errors.js';
import type { FetchLike } from '../../transport/http.js';

import { sha256Json } from '../../platform/canonical-json-hash.js';
import type {
  DatasetMaintenancePlan,
  DatasetMaintenancePlanAction,
  DatasetMaintenanceProgressEntry,
  JsonObject,
} from '../contract/types.js';
import type { DatasetMaintenanceDerivativeSubmitProof } from '../derivatives.js';

export type DatasetMaintenanceApplyReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'completed_with_failures' | 'completed_with_unknowns' | 'accepted';
  task_id: string;
  operation: DatasetMaintenancePlan['operation'];
  operation_id: string;
  target_mode: DatasetMaintenancePlan['target_mode'];
  plan_sha256: string;
  actor: { user_id: string; email: string };
  summary: {
    actions: number;
    success: number;
    failed: number;
    unknown?: number;
    pending: number;
    resumed_successes: number;
    accepted?: number;
  };
  actions: Array<{
    action_id: string;
    action: DatasetMaintenancePlanAction['action'];
    table: DatasetMaintenancePlanAction['table'];
    id: string;
    version: string;
    status: 'success' | 'failed' | 'unknown' | 'pending' | 'accepted';
    error: string | null;
  }>;
  artifacts: {
    approval_record: string;
    apply_progress: string;
    commit_report: string;
    attempt_report: string;
    derivative_submit_progress?: string;
    derivative_admission_attempt?: string;
    execution_log?: string;
    inbound_reference_barrier?: string;
  };
  database_audit: {
    rpc_transaction_log: 'public.command_audit_log';
    source: 'tiangong-lca dataset maintenance apply';
    correlation_fields: string[];
  };
  derivative_admission?: DatasetMaintenanceDerivativeSubmitProof & {
    admission: 'accepted';
  };
};

export type RunDatasetMaintenanceApplyOptions = {
  planPath: string;
  commit: boolean;
  approvePlan: string;
  confirm: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  maxParallel?: number;
  globalInboundProofPath?: string;
  approveGlobalInboundProof?: string;
};

export type ParallelDeleteExecutionStatus = 'PREPARED' | 'DISPATCHED' | 'COMMITTED' | 'UNKNOWN';

// Process payloads can be large enough for the default 1,000-row page to exceed
// the database statement timeout. Keep the destructive all-visible RLS fence,
// but bound each SELECT-only page so admission can complete without weakening it.
export const PARALLEL_DELETE_VISIBLE_PROCESS_PAGE_SIZE = 250;
export const GLOBAL_INBOUND_PROOF_MAX_AGE_MS = 30 * 60 * 1_000;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ParallelDeleteGlobalInboundProofChunk = {
  index: number;
  start: number;
  end_exclusive: number;
  target_count: number;
  captured_at_utc: string;
  inbound_exchanges: 0;
  old_flow_identities_with_inbound: 0;
  process_identities_with_inbound: 0;
  owner_draft_inbound: 0;
  public_inbound: 0;
  foreign_private_inbound: 0;
  other_state_inbound: 0;
  sql_sha256: string;
};

export type ParallelDeleteGlobalInboundProof = {
  schema_version: 'dataset-maintenance-global-inbound-proof.v1';
  status: 'PASS_GLOBAL_ALL_PROCESS_INBOUND_ZERO';
  statement_kind: 'SELECT';
  source: 'supabase_select_only_raw_sql';
  process_scope: 'all_process_rows_without_rls_restriction';
  captured_at_utc: string;
  project_ref: string;
  actor_user_id: string;
  plan_sha256: string;
  operation: 'delete';
  target_table: 'flows';
  target_count: number;
  target_binding_sha256: string;
  global_process_rows: number;
  global_exchange_rows: number;
  inbound_exchanges: 0;
  old_flow_identities_with_inbound: 0;
  process_identities_with_inbound: 0;
  chunks: ParallelDeleteGlobalInboundProofChunk[];
  p0: 0;
  p1: 0;
  proof_path: string;
  proof_sha256: string;
};

export type ParallelDeleteExecutionEntry = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  action_id: string;
  attempt_key: string;
  action: 'delete';
  table: 'flows';
  id: string;
  version: string;
  desired_sha256: string;
  before_sha256: string;
  actor: { user_id: string; email: string };
  status: ParallelDeleteExecutionStatus;
  recorded_at_utc: string;
  attempt_consumed: boolean;
  recovered: boolean;
  audit_context: {
    plan_sha256: string;
    operation_id: string;
    action_id: string;
    reason_code: string;
    source: 'tiangong-lca dataset maintenance apply';
  };
  audit_id: string | null;
  readback_sha256: string | null;
  remote_result_sha256: string | null;
  error: string | null;
};

export type ParallelDeleteExecutionState = {
  entries: ParallelDeleteExecutionEntry[];
  byAction: Map<string, ParallelDeleteExecutionEntry[]>;
  dispatched: Set<string>;
  committed: Set<string>;
};

export type ProgressState = {
  entries: DatasetMaintenanceProgressEntry[];
  successes: Map<string, DatasetMaintenanceProgressEntry>;
  latestFailures: Map<string, DatasetMaintenanceProgressEntry>;
};

export type DerivativeSubmitProgressEntry = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  action_id: string;
  target_mode: 'owner_draft';
  actor: { user_id: string; email: string };
  started_at_utc: string;
  ended_at_utc: string;
  result: 'accepted';
  proof: DatasetMaintenanceDerivativeSubmitProof;
};

export type DerivativeSubmitProgressState = {
  entries: DerivativeSubmitProgressEntry[];
  latest: DerivativeSubmitProgressEntry | null;
};

export type DerivativeAdmissionAttempt = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  action_id: string;
  table: 'processes';
  id: string;
  version: string;
  expected_snapshot_sha256: string;
  actor: { user_id: string; email: string };
  prepared_at_utc: string;
};

export function clock(options: RunDatasetMaintenanceApplyOptions): string {
  return (options.now ?? new Date()).toISOString();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ABSENT_READBACK_SHA256 = sha256Json([]);

export function parallelDeleteDesiredSha256(action: DatasetMaintenancePlanAction): string {
  return sha256Json({
    action: 'delete',
    table: action.table,
    id: action.id,
    version: action.version,
    desired: 'absent',
  });
}

export function normalizeMaintenanceMaxParallel(value: number | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 8) {
    throw new CliError('--max-parallel must be an integer from 1 to 8.', {
      code: 'DATASET_MAINTENANCE_MAX_PARALLEL_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

export function loadDesiredPayload(
  planDir: string,
  action: DatasetMaintenancePlanAction,
): JsonObject {
  return loadMaintenanceDesiredPayload(planDir, action);
}

export const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;
