import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact } from './artifacts.js';
import { collectRemoteReferences } from './dataset-remote-verify.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { withStateFileLock } from './state-lock.js';
import {
  buildAliasBatchRequest,
  buildAliasPlanRequest,
  loadMaintenanceDesiredPayload,
  orderedAliasBatches,
} from './dataset-maintenance-alias-request.js';
import {
  MAINTENANCE_SCAN_TABLES,
  appendStableJsonLine,
  isJsonObject,
  maintenanceRowKey,
  parseMaintenancePlan,
  readJsonFile,
  readJsonLinesIfPresent,
  sha256Json,
  sha256Text,
  snapshotRemoteRow,
  stableJsonText,
  writeImmutableJson,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceAliasBatchPlan,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceProgressEntry,
  type DatasetMaintenanceMutableTable,
  type DatasetMaintenanceRemoteRow,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import {
  buildDerivativePlanRequest,
  derivativePlanAction,
  parseDerivativeSnapshotResponse,
  parseDerivativeSubmitResponse,
  type DatasetMaintenanceDerivativeSubmitProof,
} from './dataset-maintenance-derivatives.js';
import { maintenanceProjectedReferenceFingerprint } from './dataset-maintenance-plan.js';
import { isSnapshotCompletenessCompatible } from './dataset-maintenance-pagination.js';
import {
  assertMaintenanceDraftName,
  applyMaintenanceDerivativeRebuild,
  deleteMaintenanceRow,
  fetchMaintenanceAccountRows,
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceExactRows,
  fetchMaintenanceVisibleTableRows,
  resolveMaintenanceRemoteContext,
  saveDraftMaintenanceRow,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';

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
    alias_plan_progress?: string;
    alias_batch_progress?: string;
    alias_exchange_progress?: string;
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
  alias_plan_proof?: {
    plan_request_sha256: string;
    summary_audit_id: string;
    batch_count: 2;
    row_count: 52;
    exchange_count: 59;
    idempotent_replay: boolean;
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

type ParallelDeleteExecutionStatus = 'PREPARED' | 'DISPATCHED' | 'COMMITTED' | 'UNKNOWN';

// Process payloads can be large enough for the default 1,000-row page to exceed
// the database statement timeout. Keep the destructive all-visible RLS fence,
// but bound each SELECT-only page so admission can complete without weakening it.
const PARALLEL_DELETE_VISIBLE_PROCESS_PAGE_SIZE = 250;
const GLOBAL_INBOUND_PROOF_MAX_AGE_MS = 30 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type ParallelDeleteGlobalInboundProofChunk = {
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

type ParallelDeleteGlobalInboundProof = {
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

type ParallelDeleteExecutionEntry = {
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

type ParallelDeleteExecutionState = {
  entries: ParallelDeleteExecutionEntry[];
  byAction: Map<string, ParallelDeleteExecutionEntry[]>;
  dispatched: Set<string>;
  committed: Set<string>;
};

type ProgressState = {
  entries: DatasetMaintenanceProgressEntry[];
  successes: Map<string, DatasetMaintenanceProgressEntry>;
  latestFailures: Map<string, DatasetMaintenanceProgressEntry>;
};

type DerivativeSubmitProgressEntry = {
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

type DerivativeSubmitProgressState = {
  entries: DerivativeSubmitProgressEntry[];
  latest: DerivativeSubmitProgressEntry | null;
};

type DerivativeAdmissionAttempt = {
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

type AliasBatchProgressEntry = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  batch_id: string;
  target_mode: 'owner_draft';
  dimension: DatasetMaintenanceAliasBatchPlan['dimension'];
  factor: string;
  actor: { user_id: string; email: string };
  started_at_utc: string;
  ended_at_utc: string;
  batch_request_sha256: string;
  idempotent_replay: boolean;
  row_count: number;
  exchange_count: number;
  summary_audit_id: string;
  plan_request_sha256: string;
  plan_summary_audit_id: string;
  result: 'success';
  error: null;
};

type AliasPlanBatchProof = {
  batch_id: string;
  dimension: DatasetMaintenanceAliasBatchPlan['dimension'];
  batch_request_sha256: string;
  summary_audit_id: string;
};

type AliasPlanProgressEntry = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  target_mode: 'owner_draft';
  actor: { user_id: string; email: string };
  started_at_utc: string;
  ended_at_utc: string;
  plan_request_sha256: string | null;
  idempotent_replay: boolean | null;
  batch_count: 2;
  row_count: 52;
  exchange_count: 59;
  summary_audit_id: string | null;
  batches: AliasPlanBatchProof[];
  result: 'success' | 'failed';
  error: string | null;
};

type AliasPlanProgressState = {
  entries: AliasPlanProgressEntry[];
  success: AliasPlanProgressEntry | null;
  latestFailure: AliasPlanProgressEntry | null;
};

type AliasBatchProgressState = {
  entries: AliasBatchProgressEntry[];
  successes: Map<string, AliasBatchProgressEntry>;
};

type AliasRpcAuditProof = {
  action_id: string;
  table: DatasetMaintenancePlanAction['table'];
  id: string;
  version: string;
  audit_id: string;
};

type AliasRpcResult = {
  target_visibility: 'owner_draft';
  batch_request_sha256: string;
  idempotent_replay: boolean;
  exchange_count: number;
  summary_audit_id: string;
  audits: Map<string, AliasRpcAuditProof>;
  raw: JsonObject;
};

type AliasPlanRpcResult = {
  target_visibility: 'owner_draft';
  plan_request_sha256: string;
  idempotent_replay: boolean;
  batch_count: 2;
  row_count: 52;
  exchange_count: 59;
  summary_audit_id: string;
  batches: Map<DatasetMaintenanceAliasBatchPlan['dimension'], AliasRpcResult>;
  raw: JsonObject;
};

type RetiredAliasExecutionProof = {
  rpc: AliasPlanRpcResult;
  after_by_action: Map<string, string>;
};

const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;

function clock(options: RunDatasetMaintenanceApplyOptions): string {
  return (options.now ?? new Date()).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ABSENT_READBACK_SHA256 = sha256Json([]);

function parallelDeleteDesiredSha256(action: DatasetMaintenancePlanAction): string {
  return sha256Json({
    action: 'delete',
    table: action.table,
    id: action.id,
    version: action.version,
    desired: 'absent',
  });
}

function normalizeMaintenanceMaxParallel(value: number | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 8) {
    throw new CliError('--max-parallel must be an integer from 1 to 8.', {
      code: 'DATASET_MAINTENANCE_MAX_PARALLEL_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

function assertParallelDeletePlan(plan: DatasetMaintenancePlan): void {
  const targets = new Set<string>();
  if (
    plan.operation !== 'delete' ||
    plan.actions.length === 0 ||
    plan.actions.some((action) => action.action !== 'delete' || action.table !== 'flows') ||
    plan.summary.delete !== plan.actions.length ||
    plan.summary.save_draft !== 0 ||
    (plan.summary.update_json_ordered ?? 0) !== 0 ||
    (plan.summary.rebuild_derivatives ?? 0) !== 0 ||
    plan.summary.current_reference_impacts !== 0 ||
    plan.summary.projected_reference_impacts !== 0
  ) {
    throw new CliError(
      '--max-parallel maintenance apply requires a non-empty flow delete-only plan with zero current and projected inbound references.',
      {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_PLAN_REQUIRED',
        exitCode: 1,
      },
    );
  }
  for (const action of plan.actions) {
    const target = `${action.table}\u0000${action.id}\u0000${action.version}`;
    if (targets.has(target)) {
      throw new CliError('Parallel delete plan contains a repeated table/id/version target.', {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_TARGET_DUPLICATE',
        exitCode: 1,
        details: { table: action.table, id: action.id, version: action.version },
      });
    }
    targets.add(target);
  }
}

function parallelDeleteTargetBindingSha256(plan: DatasetMaintenancePlan): string {
  return sha256Json(
    plan.actions.map((action, index) => ({
      index,
      ordinal: action.ordinal,
      action_id: action.action_id,
      table: action.table,
      id: action.id,
      version: action.version,
      expected_user_id: action.expected_user_id,
      expected_state_code: action.expected_state_code,
      before_sha256: action.before?.row_sha256 ?? null,
    })),
  );
}

function invalidGlobalInboundProof(message: string, details?: unknown): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_INVALID',
    exitCode: 1,
    details,
  });
}

function assertGlobalInboundProofOptionShape(options: {
  parallelDeleteMode: boolean;
  proofPath?: string;
  approveProof?: string;
}): void {
  const hasPath = typeof options.proofPath === 'string' && options.proofPath.length > 0;
  const hasApproval = typeof options.approveProof === 'string' && options.approveProof.length > 0;
  if (hasPath !== hasApproval) {
    throw new CliError(
      '--global-inbound-proof and --approve-global-inbound-proof must be provided together.',
      {
        code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_OPTIONS_INCOMPLETE',
        exitCode: 2,
      },
    );
  }
  if ((hasPath || hasApproval) && !options.parallelDeleteMode) {
    throw new CliError(
      'A global inbound proof is allowed only with --max-parallel flow delete-only execution.',
      {
        code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_MODE_INVALID',
        exitCode: 2,
      },
    );
  }
  if (hasApproval && !SHA256_PATTERN.test(options.approveProof!)) {
    throw new CliError('--approve-global-inbound-proof must be a lowercase SHA-256.', {
      code: 'DATASET_MAINTENANCE_GLOBAL_INBOUND_PROOF_APPROVAL_INVALID',
      exitCode: 2,
    });
  }
}

function validateParallelDeleteGlobalInboundProof(options: {
  proofPath: string | undefined;
  approveProof: string | undefined;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  now: Date;
}): ParallelDeleteGlobalInboundProof | null {
  if (!options.proofPath || !options.approveProof) return null;
  if (!path.isAbsolute(options.proofPath)) {
    invalidGlobalInboundProof('Global inbound proof path must be absolute.');
  }

  let proofText: string;
  try {
    proofText = readFileSync(options.proofPath, 'utf8');
  } catch (error) {
    invalidGlobalInboundProof('Global inbound proof file could not be read.', errorMessage(error));
  }
  const proofSha256 = sha256Text(proofText!);
  if (proofSha256 !== options.approveProof) {
    invalidGlobalInboundProof('Global inbound proof file SHA-256 does not match approval.', {
      expected: options.approveProof,
      actual: proofSha256,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(proofText!);
  } catch (error) {
    invalidGlobalInboundProof('Global inbound proof is not valid JSON.', errorMessage(error));
  }
  if (!isJsonObject(value)) {
    invalidGlobalInboundProof('Global inbound proof must be a JSON object.');
  }

  const expectedBinding = parallelDeleteTargetBindingSha256(options.plan);
  const capturedAt =
    typeof value.captured_at_utc === 'string' ? Date.parse(value.captured_at_utc) : NaN;
  const nowMs = options.now.getTime();
  const capturedAgeMs = nowMs - capturedAt;
  const safePositiveInteger = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && Number(candidate) > 0;
  if (
    value.schema_version !== 'dataset-maintenance-global-inbound-proof.v1' ||
    value.status !== 'PASS_GLOBAL_ALL_PROCESS_INBOUND_ZERO' ||
    value.statement_kind !== 'SELECT' ||
    value.source !== 'supabase_select_only_raw_sql' ||
    value.process_scope !== 'all_process_rows_without_rls_restriction' ||
    !Number.isFinite(capturedAt) ||
    capturedAgeMs < -30_000 ||
    capturedAgeMs > GLOBAL_INBOUND_PROOF_MAX_AGE_MS ||
    value.project_ref !== options.context.project_ref ||
    value.actor_user_id !== options.context.account.user_id ||
    value.plan_sha256 !== options.plan.plan_sha256 ||
    value.operation !== 'delete' ||
    value.target_table !== 'flows' ||
    value.target_count !== options.plan.actions.length ||
    value.target_binding_sha256 !== expectedBinding ||
    !safePositiveInteger(value.global_process_rows) ||
    !safePositiveInteger(value.global_exchange_rows) ||
    value.inbound_exchanges !== 0 ||
    value.old_flow_identities_with_inbound !== 0 ||
    value.process_identities_with_inbound !== 0 ||
    value.p0 !== 0 ||
    value.p1 !== 0 ||
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0
  ) {
    invalidGlobalInboundProof('Global inbound proof metadata or zero-inbound result is invalid.', {
      expected_project_ref: options.context.project_ref,
      expected_actor_user_id: options.context.account.user_id,
      expected_plan_sha256: options.plan.plan_sha256,
      expected_target_count: options.plan.actions.length,
      expected_target_binding_sha256: expectedBinding,
    });
  }

  let expectedStart = 0;
  for (const [index, rawChunk] of value.chunks.entries()) {
    if (!isJsonObject(rawChunk)) {
      invalidGlobalInboundProof('Global inbound proof contains a non-object chunk.', { index });
    }
    const chunkCapturedAt =
      typeof rawChunk.captured_at_utc === 'string' ? Date.parse(rawChunk.captured_at_utc) : NaN;
    const chunkAgeMs = nowMs - chunkCapturedAt;
    if (
      rawChunk.index !== index ||
      rawChunk.start !== expectedStart ||
      !Number.isSafeInteger(rawChunk.end_exclusive) ||
      Number(rawChunk.end_exclusive) <= expectedStart ||
      Number(rawChunk.end_exclusive) > options.plan.actions.length ||
      rawChunk.target_count !== Number(rawChunk.end_exclusive) - expectedStart ||
      !Number.isFinite(chunkCapturedAt) ||
      chunkAgeMs < -30_000 ||
      chunkAgeMs > GLOBAL_INBOUND_PROOF_MAX_AGE_MS ||
      rawChunk.inbound_exchanges !== 0 ||
      rawChunk.old_flow_identities_with_inbound !== 0 ||
      rawChunk.process_identities_with_inbound !== 0 ||
      rawChunk.owner_draft_inbound !== 0 ||
      rawChunk.public_inbound !== 0 ||
      rawChunk.foreign_private_inbound !== 0 ||
      rawChunk.other_state_inbound !== 0 ||
      typeof rawChunk.sql_sha256 !== 'string' ||
      !SHA256_PATTERN.test(rawChunk.sql_sha256)
    ) {
      invalidGlobalInboundProof('Global inbound proof contains an invalid or incomplete chunk.', {
        index,
        expected_start: expectedStart,
      });
    }
    expectedStart = Number(rawChunk.end_exclusive);
  }
  if (expectedStart !== options.plan.actions.length) {
    invalidGlobalInboundProof('Global inbound proof chunks do not cover every delete target.', {
      expected_end: options.plan.actions.length,
      actual_end: expectedStart,
    });
  }

  return {
    ...(value as Omit<ParallelDeleteGlobalInboundProof, 'proof_path' | 'proof_sha256'>),
    proof_path: options.proofPath,
    proof_sha256: proofSha256,
  };
}

function parseParallelDeleteExecutionLog(
  plan: DatasetMaintenancePlan,
  executionLogPath: string,
): ParallelDeleteExecutionState {
  const actions = new Map(plan.actions.map((action) => [action.action_id, action]));
  const entries: ParallelDeleteExecutionEntry[] = [];
  const byAction = new Map<string, ParallelDeleteExecutionEntry[]>();
  const dispatched = new Set<string>();
  const committed = new Set<string>();
  for (const value of readJsonLinesIfPresent(executionLogPath)) {
    const action =
      isJsonObject(value) && typeof value.action_id === 'string'
        ? actions.get(value.action_id)
        : null;
    const expectedDesired = action ? parallelDeleteDesiredSha256(action) : null;
    const actionEntries = action ? (byAction.get(action.action_id) ?? []) : [];
    const priorDispatched = actionEntries.some((entry) => entry.status === 'DISPATCHED');
    const priorCommitted = actionEntries.some((entry) => entry.status === 'COMMITTED');
    const status = isJsonObject(value) ? value.status : null;
    const auditIdValid =
      isJsonObject(value) &&
      (value.audit_id === null ||
        (typeof value.audit_id === 'string' && POSITIVE_INTEGER_TEXT.test(value.audit_id)));
    const remoteHashValid =
      isJsonObject(value) &&
      (value.remote_result_sha256 === null ||
        (typeof value.remote_result_sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(value.remote_result_sha256)));
    const commonOutcomeFieldsValid =
      isJsonObject(value) &&
      typeof value.attempt_consumed === 'boolean' &&
      typeof value.recovered === 'boolean' &&
      (value.readback_sha256 === null ||
        (typeof value.readback_sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(value.readback_sha256))) &&
      (value.error === null || typeof value.error === 'string');
    const statusFieldsValid =
      isJsonObject(value) &&
      ((status === 'PREPARED' &&
        value.attempt_consumed === false &&
        value.recovered === false &&
        value.audit_id === null &&
        value.readback_sha256 === null &&
        value.remote_result_sha256 === null &&
        value.error === null &&
        !priorDispatched &&
        !priorCommitted) ||
        (status === 'DISPATCHED' &&
          value.attempt_consumed === true &&
          value.recovered === false &&
          value.audit_id === null &&
          value.readback_sha256 === null &&
          value.remote_result_sha256 === null &&
          value.error === null &&
          actionEntries.some((entry) => entry.status === 'PREPARED') &&
          !priorDispatched &&
          !priorCommitted) ||
        (status === 'UNKNOWN' &&
          value.attempt_consumed === true &&
          typeof value.error === 'string' &&
          value.error.length > 0 &&
          priorDispatched &&
          !priorCommitted) ||
        (status === 'COMMITTED' &&
          value.attempt_consumed === true &&
          value.readback_sha256 === ABSENT_READBACK_SHA256 &&
          value.error === null &&
          priorDispatched &&
          !priorCommitted));
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      !action ||
      action.action !== 'delete' ||
      action.table !== 'flows' ||
      value.attempt_key !== `${action.action_id}@${expectedDesired}` ||
      value.action !== 'delete' ||
      value.table !== 'flows' ||
      value.id !== action.id ||
      value.version !== action.version ||
      value.desired_sha256 !== expectedDesired ||
      value.before_sha256 !== action.before?.row_sha256 ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      !isJsonObject(value.audit_context) ||
      value.audit_context.plan_sha256 !== plan.plan_sha256 ||
      value.audit_context.operation_id !== plan.operation_id ||
      value.audit_context.action_id !== action.action_id ||
      value.audit_context.reason_code !== action.reason_code ||
      value.audit_context.source !== 'tiangong-lca dataset maintenance apply' ||
      typeof value.recorded_at_utc !== 'string' ||
      !Number.isFinite(Date.parse(value.recorded_at_utc)) ||
      !auditIdValid ||
      !remoteHashValid ||
      !commonOutcomeFieldsValid ||
      !statusFieldsValid
    ) {
      throw new CliError('Parallel delete execution log contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_LOG_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    const entry = value as ParallelDeleteExecutionEntry;
    entries.push(entry);
    actionEntries.push(entry);
    byAction.set(action.action_id, actionEntries);
    if (entry.status === 'DISPATCHED') dispatched.add(action.action_id);
    if (entry.status === 'COMMITTED') committed.add(action.action_id);
  }
  return { entries, byAction, dispatched, committed };
}

function appendParallelDeleteExecutionEntry(options: {
  path: string;
  state: ParallelDeleteExecutionState;
  plan: DatasetMaintenancePlan;
  action: DatasetMaintenancePlanAction;
  context: DatasetMaintenanceRemoteContext;
  status: ParallelDeleteExecutionStatus;
  recordedAtUtc: string;
  recovered?: boolean;
  auditId?: string | null;
  readbackSha256?: string | null;
  remoteResultSha256?: string | null;
  error?: string | null;
}): ParallelDeleteExecutionEntry {
  const desiredSha256 = parallelDeleteDesiredSha256(options.action);
  const entry: ParallelDeleteExecutionEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    attempt_key: `${options.action.action_id}@${desiredSha256}`,
    action: 'delete',
    table: 'flows',
    id: options.action.id,
    version: options.action.version,
    desired_sha256: desiredSha256,
    before_sha256: options.action.before!.row_sha256,
    actor: {
      user_id: options.context.account.user_id,
      email: options.context.account.email,
    },
    status: options.status,
    recorded_at_utc: options.recordedAtUtc,
    attempt_consumed: options.status !== 'PREPARED',
    recovered: options.recovered ?? false,
    audit_context: {
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: options.action.action_id,
      reason_code: options.action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    audit_id: options.auditId ?? null,
    readback_sha256: options.readbackSha256 ?? null,
    remote_result_sha256: options.remoteResultSha256 ?? null,
    error: options.error ?? null,
  };
  const descriptor = openSync(options.path, 'a', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${stableJsonText(entry)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  options.state.entries.push(entry);
  const actionEntries = options.state.byAction.get(options.action.action_id) ?? [];
  actionEntries.push(entry);
  options.state.byAction.set(options.action.action_id, actionEntries);
  if (entry.status === 'DISPATCHED') options.state.dispatched.add(options.action.action_id);
  if (entry.status === 'COMMITTED') options.state.committed.add(options.action.action_id);
  return entry;
}

function assertNoVisibleProcessInboundReferences(options: {
  plan: DatasetMaintenancePlan;
  rows: DatasetMaintenanceRemoteRow[];
}): { process_rows: number; process_references: number; snapshot_sha256: string } {
  const targets = new Set(
    options.plan.actions.map((action) => `${action.id}\u0000${action.version}`),
  );
  const targetIds = new Set(options.plan.actions.map((action) => action.id));
  const payloadRows = options.rows
    .filter((row) => row.table === 'processes' && row.json_ordered !== null)
    .map((row) => ({
      table: row.table,
      id: row.id,
      version: row.version,
      json_ordered: row.json_ordered as JsonObject,
    }));
  const references = collectRemoteReferences(payloadRows).filter(
    (reference) =>
      reference.role === 'reference' &&
      reference.table === 'flows' &&
      typeof reference.id === 'string',
  );
  const inbound = references.filter((reference) =>
    reference.version
      ? targets.has(`${reference.id}\u0000${reference.version}`)
      : targetIds.has(reference.id!),
  );
  if (inbound.length > 0) {
    throw new CliError('Parallel flow delete admission found visible process inbound references.', {
      code: 'DATASET_MAINTENANCE_PARALLEL_DELETE_INBOUND_REFERENCES',
      exitCode: 1,
      details: {
        inbound_count: inbound.length,
        first: inbound.slice(0, 20),
      },
    });
  }
  return {
    process_rows: payloadRows.length,
    process_references: references.length,
    snapshot_sha256: sha256Json(
      payloadRows.map((row) => ({
        table: row.table,
        id: row.id,
        version: row.version,
        payload_sha256: sha256Json(row.json_ordered),
      })),
    ),
  };
}

function loadDesiredPayload(planDir: string, action: DatasetMaintenancePlanAction): JsonObject {
  return loadMaintenanceDesiredPayload(planDir, action);
}

function parseProgress(plan: DatasetMaintenancePlan, progressPath: string): ProgressState {
  const rawEntries = readJsonLinesIfPresent(progressPath);
  const entries: DatasetMaintenanceProgressEntry[] = [];
  const actionsById = new Map(plan.actions.map((action) => [action.action_id, action]));
  for (const value of rawEntries) {
    const action =
      isJsonObject(value) && typeof value.action_id === 'string'
        ? actionsById.get(value.action_id)
        : null;
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      typeof value.action_id !== 'string' ||
      !action ||
      value.action !== action.action ||
      value.reason_code !== action.reason_code ||
      typeof value.before_sha256 !== 'string' ||
      !isJsonObject(value.audit_context) ||
      value.audit_context.plan_sha256 !== plan.plan_sha256 ||
      value.audit_context.operation_id !== plan.operation_id ||
      value.audit_context.action_id !== action.action_id ||
      value.audit_context.reason_code !== action.reason_code ||
      value.audit_context.source !== 'tiangong-lca dataset maintenance apply' ||
      (action.action === 'update_json_ordered' &&
        (value.target_mode !== 'owner_draft' ||
          value.audit_context.target_mode !== 'owner_draft' ||
          value.batch_id !== action.batch_id ||
          typeof value.batch_request_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
          typeof value.database_audit_id !== 'string' ||
          !POSITIVE_INTEGER_TEXT.test(value.database_audit_id) ||
          typeof value.summary_audit_id !== 'string' ||
          !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
          typeof value.plan_request_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
          typeof value.plan_summary_audit_id !== 'string' ||
          !POSITIVE_INTEGER_TEXT.test(value.plan_summary_audit_id))) ||
      (action.action !== 'update_json_ordered' &&
        ('target_mode' in value ||
          'target_mode' in value.audit_context ||
          'batch_id' in value ||
          'batch_request_sha256' in value ||
          'database_audit_id' in value ||
          'summary_audit_id' in value ||
          'plan_request_sha256' in value ||
          'plan_summary_audit_id' in value)) ||
      !['success', 'failed'].includes(String(value.result)) ||
      (value.result === 'success' && typeof value.remote_result_sha256 !== 'string') ||
      (value.result === 'failed' && value.remote_result_sha256 !== null)
    ) {
      throw new CliError('Apply progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    entries.push(value as DatasetMaintenanceProgressEntry);
  }
  const successes = new Map<string, DatasetMaintenanceProgressEntry>();
  const latestFailures = new Map<string, DatasetMaintenanceProgressEntry>();
  for (const entry of entries) {
    if (entry.result === 'success') {
      successes.set(entry.action_id, entry);
      latestFailures.delete(entry.action_id);
    } else if (!successes.has(entry.action_id)) {
      latestFailures.set(entry.action_id, entry);
    }
  }
  return { entries, successes, latestFailures };
}

function derivativeProofIdentity(proof: DatasetMaintenanceDerivativeSubmitProof): string {
  return sha256Json({
    schema_version: proof.schema_version,
    plan_sha256: proof.plan_sha256,
    operation_id: proof.operation_id,
    target_visibility: proof.target_visibility,
    plan_request_sha256: proof.plan_request_sha256,
    action_count: proof.action_count,
    accepted_count: proof.accepted_count,
    summary_audit_id: proof.summary_audit_id,
    request_id: proof.request_id,
    action_request_sha256: proof.action_request_sha256,
    database_audit_id: proof.database_audit_id,
  });
}

function parseDerivativeSubmitProgress(
  plan: DatasetMaintenancePlan,
  progressPath: string,
): DerivativeSubmitProgressState {
  const action = derivativePlanAction(plan);
  const entries = readJsonLinesIfPresent(progressPath).map((value) => {
    const rawProof = isJsonObject(value) && isJsonObject(value.proof) ? value.proof : null;
    let proof: DatasetMaintenanceDerivativeSubmitProof;
    try {
      proof = parseDerivativeSubmitResponse(
        rawProof
          ? {
              ok: true,
              command: 'cmd_dataset_derivative_rebuild_plan_guarded',
              ...rawProof,
            }
          : null,
        plan,
      );
    } catch (error) {
      throw new CliError('Derivative submit progress contains an invalid RPC proof.', {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
        exitCode: 1,
        details: errorMessage(error),
      });
    }
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      value.action_id !== action.action_id ||
      value.target_mode !== 'owner_draft' ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      typeof value.started_at_utc !== 'string' ||
      typeof value.ended_at_utc !== 'string' ||
      value.result !== 'accepted'
    ) {
      throw new CliError('Derivative submit progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    return { ...value, proof } as DerivativeSubmitProgressEntry;
  });
  const identities = new Set(entries.map((entry) => derivativeProofIdentity(entry.proof)));
  if (identities.size > 1) {
    throw new CliError('Derivative submit replays do not identify one durable request.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PROGRESS_INVALID',
      exitCode: 1,
    });
  }
  return { entries, latest: entries.at(-1) ?? null };
}

function validateDerivativeAdmissionAttempt(options: {
  path: string;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
}): DerivativeAdmissionAttempt | null {
  if (!existsSync(options.path)) return null;
  const value = readJsonFile(options.path, 'Derivative admission attempt');
  const action = derivativePlanAction(options.plan);
  if (
    !isJsonObject(value) ||
    value.schema_version !== 1 ||
    value.plan_sha256 !== options.plan.plan_sha256 ||
    value.operation_id !== options.plan.operation_id ||
    value.action_id !== action.action_id ||
    value.table !== 'processes' ||
    value.id !== action.id ||
    value.version !== action.version ||
    value.expected_snapshot_sha256 !== action.derivative_before?.snapshot_sha256 ||
    !isJsonObject(value.actor) ||
    value.actor.user_id !== options.context.account.user_id ||
    value.actor.email !== options.context.account.email ||
    typeof value.prepared_at_utc !== 'string' ||
    !Number.isFinite(Date.parse(value.prepared_at_utc))
  ) {
    throw new CliError('Derivative admission attempt is invalid or belongs to another plan.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_ATTEMPT_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return value as DerivativeAdmissionAttempt;
}

function parseAliasBatchProgress(
  plan: DatasetMaintenancePlan,
  progressPath: string,
): AliasBatchProgressState {
  const batches = new Map(plan.alias_batches!.map((batch) => [batch.batch_id, batch]));
  const entries = readJsonLinesIfPresent(progressPath).map((value) => {
    const batch =
      isJsonObject(value) && typeof value.batch_id === 'string'
        ? batches.get(value.batch_id)
        : null;
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      !batch ||
      value.target_mode !== 'owner_draft' ||
      value.dimension !== batch.dimension ||
      value.factor !== batch.factor ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      typeof value.started_at_utc !== 'string' ||
      typeof value.ended_at_utc !== 'string' ||
      value.row_count !== batch.summary.rows ||
      value.exchange_count !== batch.summary.exchanges ||
      value.result !== 'success' ||
      typeof value.batch_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
      typeof value.idempotent_replay !== 'boolean' ||
      typeof value.summary_audit_id !== 'string' ||
      !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
      typeof value.plan_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
      typeof value.plan_summary_audit_id !== 'string' ||
      !POSITIVE_INTEGER_TEXT.test(value.plan_summary_audit_id) ||
      value.error !== null
    ) {
      throw new CliError('Alias batch progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    return value as AliasBatchProgressEntry;
  });
  const successes = new Map<string, AliasBatchProgressEntry>();
  for (const entry of entries) {
    if (successes.has(entry.batch_id)) {
      throw new CliError('Alias batch progress contains duplicate success proof.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
        exitCode: 1,
        details: { batch_id: entry.batch_id },
      });
    }
    successes.set(entry.batch_id, entry);
  }
  return { entries, successes };
}

function parseAliasPlanProgress(
  plan: DatasetMaintenancePlan,
  progressPath: string,
): AliasPlanProgressState {
  const expectedBatches = orderedAliasBatches(plan);
  const entries = readJsonLinesIfPresent(progressPath).map((value) => {
    const batchProofs = isJsonObject(value) && Array.isArray(value.batches) ? value.batches : [];
    const validBatchProofs =
      batchProofs.length === expectedBatches.length &&
      batchProofs.every((proof, index) => {
        const batch = expectedBatches[index]!;
        return Boolean(
          isJsonObject(proof) &&
          proof.batch_id === batch.batch_id &&
          proof.dimension === batch.dimension &&
          typeof proof.batch_request_sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(proof.batch_request_sha256) &&
          typeof proof.summary_audit_id === 'string' &&
          POSITIVE_INTEGER_TEXT.test(proof.summary_audit_id),
        );
      });
    const batchRequestHashes = batchProofs
      .filter(isJsonObject)
      .map((proof) => proof.batch_request_sha256);
    const batchSummaryAuditIds = batchProofs
      .filter(isJsonObject)
      .map((proof) => proof.summary_audit_id);
    if (
      !isJsonObject(value) ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== plan.plan_sha256 ||
      value.operation_id !== plan.operation_id ||
      value.target_mode !== 'owner_draft' ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== plan.account.user_id ||
      value.actor.email !== plan.account.email ||
      typeof value.started_at_utc !== 'string' ||
      typeof value.ended_at_utc !== 'string' ||
      value.batch_count !== 2 ||
      value.row_count !== 52 ||
      value.exchange_count !== 59 ||
      !['success', 'failed'].includes(String(value.result)) ||
      (value.result === 'success' &&
        (typeof value.plan_request_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
          typeof value.idempotent_replay !== 'boolean' ||
          typeof value.summary_audit_id !== 'string' ||
          !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
          !validBatchProofs ||
          new Set(batchRequestHashes).size !== 2 ||
          new Set(batchSummaryAuditIds).size !== 2 ||
          batchSummaryAuditIds.includes(value.summary_audit_id) ||
          value.error !== null)) ||
      (value.result === 'failed' &&
        (value.plan_request_sha256 !== null ||
          value.idempotent_replay !== null ||
          value.summary_audit_id !== null ||
          batchProofs.length !== 0 ||
          typeof value.error !== 'string'))
    ) {
      throw new CliError('Alias plan progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PLAN_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    return value as AliasPlanProgressEntry;
  });
  let success: AliasPlanProgressEntry | null = null;
  let latestFailure: AliasPlanProgressEntry | null = null;
  for (const entry of entries) {
    if (entry.result === 'success') {
      if (success) {
        throw new CliError('Alias plan progress contains duplicate success proof.', {
          code: 'DATASET_MAINTENANCE_ALIAS_PLAN_PROGRESS_INVALID',
          exitCode: 1,
        });
      }
      success = entry;
      latestFailure = null;
    } else if (!success) {
      latestFailure = entry;
    }
  }
  return { entries, success, latestFailure };
}

function finalProjectedRows(options: {
  rows: DatasetMaintenanceRemoteRow[];
  plan: DatasetMaintenancePlan;
  planDir: string;
}): DatasetMaintenanceRemoteRow[] {
  const projected = new Map(options.rows.map((row) => [maintenanceRowKey(row), { ...row }]));
  for (const action of options.plan.actions.filter((entry) =>
    ['save_draft', 'update_json_ordered'].includes(entry.action),
  )) {
    const row = projected.get(maintenanceRowKey(action));
    if (row) {
      projected.set(maintenanceRowKey(action), {
        ...row,
        json_ordered: loadDesiredPayload(options.planDir, action),
      });
    }
  }
  for (const action of options.plan.actions.filter((entry) => entry.action === 'delete')) {
    projected.delete(maintenanceRowKey(action));
  }
  return [...projected.values()].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
}

function assertApplyPreconditions(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  currentRows: DatasetMaintenanceRemoteRow[];
  progress: ProgressState;
  aliasPlanProgress?: AliasPlanProgressState;
  attemptedDeleteActionIds?: Set<string>;
}): void {
  const current = new Map(options.currentRows.map((row) => [maintenanceRowKey(row), row]));
  const aliasBatchStates = new Map<string, 'before' | 'desired'>();
  for (const batch of options.plan.alias_batches ?? []) {
    const states = batch.action_ids.map((actionId) => {
      const action = options.plan.actions.find((entry) => entry.action_id === actionId)!;
      const row = current.get(maintenanceRowKey(action));
      const snapshot = row ? snapshotRemoteRow(row) : null;
      if (
        row?.state_code === 0 &&
        row.user_id === action.expected_user_id &&
        snapshot?.row_sha256 === action.before?.row_sha256
      ) {
        return 'before' as const;
      }
      if (
        row?.state_code === 0 &&
        row.user_id === action.expected_user_id &&
        snapshot?.payload_sha256 === action.desired_payload?.sha256 &&
        row.model_id === action.before?.model_id &&
        row.rule_verification === action.before?.rule_verification
      ) {
        return 'desired' as const;
      }
      return 'invalid' as const;
    });
    const unique = new Set(states);
    if (unique.size !== 1 || unique.has('invalid')) {
      throw new CliError(`Atomic alias batch row state drifted: ${batch.batch_id}`, {
        code: 'DATASET_MAINTENANCE_ALIAS_BATCH_DRIFT',
        exitCode: 1,
        details: { batch_id: batch.batch_id, states },
      });
    }
    aliasBatchStates.set(batch.batch_id, states[0] as 'before' | 'desired');
  }
  if (aliasBatchStates.size) {
    const planStates = new Set(aliasBatchStates.values());
    if (
      planStates.size !== 1 ||
      (Boolean(options.aliasPlanProgress?.success) && !planStates.has('desired'))
    ) {
      throw new CliError('Atomic alias plan rows are split across dimension states.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PLAN_DRIFT',
        exitCode: 1,
        details: { batches: Object.fromEntries(aliasBatchStates) },
      });
    }
  }
  const baselineKeys = new Set([
    ...options.plan.protected_rows.map(maintenanceRowKey),
    ...options.plan.actions.filter((action) => action.before).map(maintenanceRowKey),
  ]);
  for (const row of options.currentRows) {
    if (!baselineKeys.has(maintenanceRowKey(row))) {
      throw new CliError(`Unexpected current-account row appeared after planning: ${row.id}`, {
        code: 'DATASET_MAINTENANCE_PREFLIGHT_DRIFT',
        exitCode: 1,
        details: { table: row.table, id: row.id, version: row.version },
      });
    }
  }
  for (const protectedRow of options.plan.protected_rows) {
    const currentRow = current.get(maintenanceRowKey(protectedRow));
    if (!currentRow || snapshotRemoteRow(currentRow).row_sha256 !== protectedRow.row_sha256) {
      throw new CliError(`Protected row drifted after planning: ${protectedRow.id}`, {
        code: 'DATASET_MAINTENANCE_PROTECTED_ROW_DRIFT',
        exitCode: 1,
        details: protectedRow,
      });
    }
  }
  for (const action of options.plan.actions) {
    if (!action.before) {
      throw new CliError(`Ready plan action lacks before snapshot: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_PLAN_INVALID',
        exitCode: 2,
      });
    }
    const currentRow = current.get(maintenanceRowKey(action));
    const alreadySucceeded = options.progress.successes.has(action.action_id);
    if (alreadySucceeded && action.action === 'delete') {
      if (currentRow) {
        throw new CliError(`Previously deleted row is visible again: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_RESUME_DRIFT',
          exitCode: 1,
        });
      }
      continue;
    }
    if (action.action === 'delete' && options.attemptedDeleteActionIds?.has(action.action_id)) {
      // A request may have committed before its response or progress row was
      // persisted, or the target may have drifted after dispatch. The execution
      // ledger owns both cases and permits only read-only recovery, never an
      // automatic replay.
      continue;
    }
    if (!currentRow || currentRow.user_id !== action.expected_user_id) {
      throw new CliError(`Action row is missing, non-draft, or not owned: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_ACTION_ROW_DRIFT',
        exitCode: 1,
      });
    }
    const currentSnapshot = snapshotRemoteRow(currentRow);
    if (action.action === 'save_draft' && !alreadySucceeded) {
      assertMaintenanceDraftName(loadDesiredPayload(options.planDir, action), action.table);
    }
    if (action.action === 'update_json_ordered') {
      aliasBatchStates.get(action.batch_id!)!;
      continue;
    }
    if (alreadySucceeded) {
      const expectedPayloadSha256 = sha256Json(loadDesiredPayload(options.planDir, action));
      if (
        currentRow.state_code !== 0 ||
        currentSnapshot.payload_sha256 !== expectedPayloadSha256 ||
        currentRow.model_id !== action.before.model_id ||
        currentRow.rule_verification !== action.before.rule_verification
      ) {
        throw new CliError(`Previously saved row payload drifted: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_RESUME_DRIFT',
          exitCode: 1,
        });
      }
    } else if (
      currentRow.state_code !== 0 ||
      currentSnapshot.row_sha256 !== action.before.row_sha256
    ) {
      throw new CliError(`Pending action row drifted after planning: ${action.action_id}`, {
        code: 'DATASET_MAINTENANCE_ACTION_ROW_DRIFT',
        exitCode: 1,
      });
    }
  }
  const projected = finalProjectedRows({
    rows: options.currentRows,
    plan: options.plan,
    planDir: options.planDir,
  });
  const projectedReferenceSha256 = sha256Json(maintenanceProjectedReferenceFingerprint(projected));
  if (projectedReferenceSha256 !== options.plan.projected_reference_sha256) {
    throw new CliError('Projected reference closure drifted after planning.', {
      code: 'DATASET_MAINTENANCE_REFERENCE_PREFLIGHT_DRIFT',
      exitCode: 1,
      details: {
        expected: options.plan.projected_reference_sha256,
        actual: projectedReferenceSha256,
      },
    });
  }
}

function validateApprovalRecord(options: {
  path: string;
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
}): void {
  if (!existsSync(options.path)) {
    return;
  }
  const record = readJsonFile(options.path, 'Maintenance approval record');
  if (
    !isJsonObject(record) ||
    record.plan_sha256 !== options.plan.plan_sha256 ||
    record.target_mode !== options.plan.target_mode ||
    !isJsonObject(record.account) ||
    record.account.user_id !== options.context.account.user_id ||
    record.account.email !== options.context.account.email ||
    !isSnapshotCompletenessCompatible(
      record.snapshot_completeness,
      options.plan.snapshot_completeness,
      MAINTENANCE_SCAN_TABLES,
    )
  ) {
    throw new CliError('Existing approval record does not match this plan and actor.', {
      code: 'DATASET_MAINTENANCE_APPROVAL_RECORD_MISMATCH',
      exitCode: 1,
    });
  }
}

async function assertAliasSupportSnapshots(options: {
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
}): Promise<void> {
  if (options.plan.target_mode !== 'owner_draft') {
    throw new CliError('Alias apply requires target_mode=owner_draft.', {
      code: 'DATASET_MAINTENANCE_TARGET_MODE_INVALID',
      exitCode: 2,
    });
  }
  for (const batch of options.plan.alias_batches!) {
    const snapshots = [
      batch.target_snapshots.unitgroup!,
      batch.target_snapshots.flowproperty!,
      batch.target_snapshots.source_unitgroup!,
    ];
    for (const snapshot of snapshots) {
      const exact = await fetchMaintenanceExactRows({
        context: options.context,
        table: snapshot.table,
        id: snapshot.id,
        version: snapshot.version,
      });
      const current =
        exact.rows.length === 1 && exact.rows[0] ? snapshotRemoteRow(exact.rows[0]) : null;
      if (
        !current ||
        current.user_id !== options.plan.account.user_id ||
        current.state_code !== 0 ||
        current.row_sha256 !== snapshot.row_sha256
      ) {
        throw new CliError(`Alias support row drifted for batch ${batch.batch_id}.`, {
          code: 'DATASET_MAINTENANCE_ALIAS_SUPPORT_DRIFT',
          exitCode: 1,
          details: { table: snapshot.table, id: snapshot.id, version: snapshot.version },
        });
      }
    }
  }
}

function validateAliasRpcResult(
  value: JsonObject,
  batch: DatasetMaintenanceAliasBatchPlan,
  plan: DatasetMaintenancePlan,
): AliasRpcResult {
  const audit = Array.isArray(value.audit) ? value.audit : [];
  const proofs = audit.filter(isJsonObject).map((entry) => ({
    action_id: entry.action_id,
    table: entry.table,
    id: entry.id,
    version: entry.version,
    audit_id: entry.audit_id,
  }));
  const proofByAction = new Map(
    proofs
      .filter(
        (entry): entry is AliasRpcAuditProof =>
          typeof entry.action_id === 'string' &&
          typeof entry.table === 'string' &&
          typeof entry.id === 'string' &&
          typeof entry.version === 'string' &&
          typeof entry.audit_id === 'string' &&
          POSITIVE_INTEGER_TEXT.test(entry.audit_id),
      )
      .map((entry) => [entry.action_id, entry]),
  );
  const actionsById = new Map(plan.actions.map((action) => [action.action_id, action]));
  const validProofs =
    proofByAction.size === batch.action_ids.length &&
    batch.action_ids.every((actionId) => {
      const action = actionsById.get(actionId);
      const proof = proofByAction.get(actionId);
      return Boolean(
        action &&
        proof &&
        proof.table === action.table &&
        proof.id === action.id &&
        proof.version === action.version,
      );
    });
  if (
    plan.target_mode !== 'owner_draft' ||
    value.ok !== true ||
    value.command !== 'cmd_dataset_alias_batch_guarded' ||
    value.target_visibility !== 'owner_draft' ||
    value.dimension !== batch.dimension ||
    value.batch_id !== batch.batch_id ||
    value.row_count !== batch.summary.rows ||
    value.exchange_count !== batch.summary.exchanges ||
    typeof value.summary_audit_id !== 'string' ||
    !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
    typeof value.batch_request_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
    typeof value.idempotent_replay !== 'boolean' ||
    audit.length !== batch.action_ids.length ||
    !validProofs
  ) {
    throw new CliError(`Alias batch RPC returned invalid proof for ${batch.batch_id}.`, {
      code: 'DATASET_MAINTENANCE_ALIAS_RPC_PROOF_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return {
    target_visibility: 'owner_draft',
    batch_request_sha256: value.batch_request_sha256,
    idempotent_replay: value.idempotent_replay,
    exchange_count: value.exchange_count,
    summary_audit_id: value.summary_audit_id,
    audits: proofByAction,
    raw: value,
  };
}

function validateAliasPlanRpcResult(
  value: JsonObject,
  plan: DatasetMaintenancePlan,
): AliasPlanRpcResult {
  const batches = orderedAliasBatches(plan);
  const rawBatchResults = Array.isArray(value.batches) ? value.batches : [];
  const parsedBatchResults = rawBatchResults.map((entry, index) =>
    isJsonObject(entry) && batches[index]
      ? validateAliasRpcResult(entry, batches[index], plan)
      : null,
  );
  const validBatchResults = parsedBatchResults.every(
    (entry): entry is AliasRpcResult => entry !== null,
  );
  const batchSummaryAuditIds = validBatchResults
    ? parsedBatchResults.map((entry) => entry.summary_audit_id)
    : [];
  const rowAuditIds = validBatchResults
    ? parsedBatchResults.flatMap((entry) =>
        [...entry.audits.values()].map((proof) => proof.audit_id),
      )
    : [];
  if (
    plan.target_mode !== 'owner_draft' ||
    value.ok !== true ||
    value.command !== 'cmd_dataset_alias_plan_guarded' ||
    value.schema_version !== 'dataset-alias-plan.v1' ||
    value.plan_sha256 !== plan.plan_sha256 ||
    value.operation_id !== plan.operation_id ||
    value.target_visibility !== 'owner_draft' ||
    typeof value.plan_request_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
    value.batch_count !== 2 ||
    value.row_count !== 52 ||
    value.exchange_count !== 59 ||
    typeof value.summary_audit_id !== 'string' ||
    !POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) ||
    typeof value.idempotent_replay !== 'boolean' ||
    rawBatchResults.length !== 2 ||
    !validBatchResults ||
    parsedBatchResults.some(
      (entry, index) =>
        entry.idempotent_replay !== value.idempotent_replay ||
        entry.exchange_count !== batches[index]!.summary.exchanges,
    ) ||
    new Set(batchSummaryAuditIds).size !== 2 ||
    new Set(rowAuditIds).size !== 52 ||
    batchSummaryAuditIds.includes(value.summary_audit_id) ||
    rowAuditIds.includes(value.summary_audit_id) ||
    rowAuditIds.some((auditId) => batchSummaryAuditIds.includes(auditId))
  ) {
    throw new CliError('Alias plan RPC returned invalid whole-plan proof.', {
      code: 'DATASET_MAINTENANCE_ALIAS_PLAN_RPC_PROOF_INVALID',
      exitCode: 1,
      details: value,
    });
  }
  return {
    target_visibility: 'owner_draft',
    plan_request_sha256: value.plan_request_sha256,
    idempotent_replay: value.idempotent_replay,
    batch_count: 2,
    row_count: 52,
    exchange_count: 59,
    summary_audit_id: value.summary_audit_id,
    batches: new Map(
      batches.map((batch, index) => [batch.dimension, parsedBatchResults[index]!] as const),
    ),
    raw: value,
  };
}

function aliasExchangeProgressKey(value: {
  batch_id: string;
  action_id: string;
  exchange_index: number;
  data_set_internal_id: string;
}): string {
  return `${value.batch_id}\u0000${value.action_id}\u0000${value.exchange_index}\u0000${value.data_set_internal_id}`;
}

function appendAliasSuccessLogs(options: {
  plan: DatasetMaintenancePlan;
  batch: DatasetMaintenanceAliasBatchPlan;
  execution: RetiredAliasExecutionProof;
  progress: ProgressState;
  progressPath: string;
  exchangeProgressPath: string;
  context: DatasetMaintenanceRemoteContext;
  startedAt: string;
  endedAt: string;
}): void {
  const batchRpc = options.execution.rpc.batches.get(options.batch.dimension)!;
  for (const actionId of options.batch.action_ids) {
    const action = options.plan.actions.find((entry) => entry.action_id === actionId)!;
    const proof = batchRpc.audits.get(actionId)!;
    const existingSuccess = options.progress.successes.get(actionId);
    if (existingSuccess) {
      if (
        existingSuccess.target_mode !== 'owner_draft' ||
        existingSuccess.batch_id !== options.batch.batch_id ||
        existingSuccess.batch_request_sha256 !== batchRpc.batch_request_sha256 ||
        existingSuccess.database_audit_id !== proof.audit_id ||
        existingSuccess.summary_audit_id !== batchRpc.summary_audit_id ||
        existingSuccess.plan_request_sha256 !== options.execution.rpc.plan_request_sha256 ||
        existingSuccess.plan_summary_audit_id !== options.execution.rpc.summary_audit_id ||
        existingSuccess.after_sha256 !== options.execution.after_by_action.get(actionId)
      ) {
        throw new CliError('Existing alias row progress does not match replay audit proof.', {
          code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
          exitCode: 1,
          details: { action_id: actionId },
        });
      }
      continue;
    }
    const entry: DatasetMaintenanceProgressEntry = {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: action.action_id,
      action: action.action,
      table: action.table,
      id: action.id,
      version: action.version,
      reason_code: action.reason_code,
      audit_context: {
        plan_sha256: options.plan.plan_sha256,
        operation_id: options.plan.operation_id,
        action_id: action.action_id,
        reason_code: action.reason_code,
        source: 'tiangong-lca dataset maintenance apply',
        target_mode: 'owner_draft',
      },
      actor: { user_id: options.context.account.user_id, email: options.context.account.email },
      started_at_utc: options.startedAt,
      ended_at_utc: options.endedAt,
      before_sha256: action.before!.row_sha256,
      after_sha256: options.execution.after_by_action.get(actionId)!,
      remote_result_sha256: sha256Json({
        plan_response: options.execution.rpc.raw,
        batch_response: batchRpc.raw,
        audit: proof,
      }),
      result: 'success',
      error: null,
      rollback: action.rollback,
      batch_id: options.batch.batch_id,
      target_mode: 'owner_draft',
      batch_request_sha256: batchRpc.batch_request_sha256,
      database_audit_id: proof.audit_id,
      summary_audit_id: batchRpc.summary_audit_id,
      plan_request_sha256: options.execution.rpc.plan_request_sha256,
      plan_summary_audit_id: options.execution.rpc.summary_audit_id,
    };
    appendStableJsonLine(options.progressPath, entry);
    options.progress.entries.push(entry);
    options.progress.successes.set(actionId, entry);
    options.progress.latestFailures.delete(actionId);
  }

  const existing = readJsonLinesIfPresent(options.exchangeProgressPath);
  const existingKeys = new Set<string>();
  const expectedRewrites = new Map(
    options.plan.alias_batches!.flatMap((batch) =>
      batch.exchange_rewrites.map(
        (rewrite) =>
          [
            aliasExchangeProgressKey({ batch_id: batch.batch_id, ...rewrite }),
            { batch, rewrite },
          ] as const,
      ),
    ),
  );
  for (const value of existing) {
    const key =
      isJsonObject(value) &&
      typeof value.batch_id === 'string' &&
      typeof value.action_id === 'string' &&
      typeof value.exchange_index === 'number' &&
      typeof value.data_set_internal_id === 'string'
        ? aliasExchangeProgressKey({
            batch_id: value.batch_id,
            action_id: value.action_id,
            exchange_index: value.exchange_index,
            data_set_internal_id: value.data_set_internal_id,
          })
        : '';
    const expected = expectedRewrites.get(key);
    const rowProof = expected ? options.progress.successes.get(expected.rewrite.action_id) : null;
    if (
      !isJsonObject(value) ||
      !expected ||
      !rowProof ||
      value.schema_version !== 1 ||
      value.plan_sha256 !== options.plan.plan_sha256 ||
      value.operation_id !== options.plan.operation_id ||
      value.target_mode !== 'owner_draft' ||
      value.factor !== expected.batch.factor ||
      value.result !== 'success' ||
      !isJsonObject(value.actor) ||
      value.actor.user_id !== options.plan.account.user_id ||
      value.actor.email !== options.plan.account.email ||
      typeof value.logged_at_utc !== 'string' ||
      typeof value.batch_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.batch_request_sha256) ||
      value.batch_request_sha256 !== rowProof.batch_request_sha256 ||
      typeof value.database_audit_id !== 'string' ||
      POSITIVE_INTEGER_TEXT.test(value.database_audit_id) === false ||
      value.database_audit_id !== rowProof.database_audit_id ||
      typeof value.summary_audit_id !== 'string' ||
      POSITIVE_INTEGER_TEXT.test(value.summary_audit_id) === false ||
      value.summary_audit_id !== rowProof.summary_audit_id ||
      typeof value.plan_request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.plan_request_sha256) ||
      value.plan_request_sha256 !== rowProof.plan_request_sha256 ||
      typeof value.plan_summary_audit_id !== 'string' ||
      !POSITIVE_INTEGER_TEXT.test(value.plan_summary_audit_id) ||
      value.plan_summary_audit_id !== rowProof.plan_summary_audit_id ||
      sha256Json({
        action_id: value.action_id,
        process_id: value.process_id,
        process_version: value.process_version,
        exchange_index: value.exchange_index,
        data_set_internal_id: value.data_set_internal_id,
        flow_id: value.flow_id,
        flow_version: value.flow_version,
        direction: value.direction,
        before_exchange_sha256: value.before_exchange_sha256,
        before_mean_amount: value.before_mean_amount,
        before_resulting_amount: value.before_resulting_amount,
        after_mean_amount: value.after_mean_amount,
        after_resulting_amount: value.after_resulting_amount,
        after_exchange_sha256: value.after_exchange_sha256,
      }) !== sha256Json(expected.rewrite) ||
      existingKeys.has(key)
    ) {
      throw new CliError('Alias exchange progress contains an invalid or foreign entry.', {
        code: 'DATASET_MAINTENANCE_ALIAS_EXCHANGE_PROGRESS_INVALID',
        exitCode: 1,
        details: value,
      });
    }
    existingKeys.add(key);
  }
  for (const rewrite of options.batch.exchange_rewrites) {
    const key = aliasExchangeProgressKey({ batch_id: options.batch.batch_id, ...rewrite });
    if (existingKeys.has(key)) continue;
    const proof = batchRpc.audits.get(rewrite.action_id)!;
    appendStableJsonLine(options.exchangeProgressPath, {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      batch_id: options.batch.batch_id,
      target_mode: 'owner_draft',
      batch_request_sha256: batchRpc.batch_request_sha256,
      factor: options.batch.factor,
      actor: { user_id: options.context.account.user_id, email: options.context.account.email },
      logged_at_utc: options.endedAt,
      database_audit_id: proof.audit_id,
      summary_audit_id: batchRpc.summary_audit_id,
      plan_request_sha256: options.execution.rpc.plan_request_sha256,
      plan_summary_audit_id: options.execution.rpc.summary_audit_id,
      result: 'success',
      ...rewrite,
    });
    existingKeys.add(key);
  }
}

function appendAliasProofProgress(options: {
  plan: DatasetMaintenancePlan;
  execution: RetiredAliasExecutionProof;
  planProgress: AliasPlanProgressState;
  batchProgress: AliasBatchProgressState;
  planProgressPath: string;
  batchProgressPath: string;
  context: DatasetMaintenanceRemoteContext;
  startedAt: string;
  endedAt: string;
}): AliasPlanProgressEntry {
  const batchProofs: AliasPlanBatchProof[] = [];
  for (const batch of orderedAliasBatches(options.plan)) {
    const rpc = options.execution.rpc.batches.get(batch.dimension)!;
    const existing = options.batchProgress.successes.get(batch.batch_id);
    if (
      existing &&
      (existing.batch_request_sha256 !== rpc.batch_request_sha256 ||
        existing.summary_audit_id !== rpc.summary_audit_id ||
        existing.plan_request_sha256 !== options.execution.rpc.plan_request_sha256 ||
        existing.plan_summary_audit_id !== options.execution.rpc.summary_audit_id)
    ) {
      throw new CliError('Existing alias batch proof does not match whole-plan replay.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PROGRESS_INVALID',
        exitCode: 1,
        details: { batch_id: batch.batch_id },
      });
    }
    const proof: AliasPlanBatchProof = {
      batch_id: batch.batch_id,
      dimension: batch.dimension,
      batch_request_sha256: rpc.batch_request_sha256,
      summary_audit_id: rpc.summary_audit_id,
    };
    batchProofs.push(proof);
    if (!existing) {
      const entry: AliasBatchProgressEntry = {
        schema_version: 1,
        plan_sha256: options.plan.plan_sha256,
        operation_id: options.plan.operation_id,
        batch_id: batch.batch_id,
        target_mode: 'owner_draft',
        dimension: batch.dimension,
        factor: batch.factor,
        actor: {
          user_id: options.context.account.user_id,
          email: options.context.account.email,
        },
        started_at_utc: options.startedAt,
        ended_at_utc: options.endedAt,
        batch_request_sha256: rpc.batch_request_sha256,
        idempotent_replay: rpc.idempotent_replay,
        row_count: batch.summary.rows,
        exchange_count: rpc.exchange_count,
        summary_audit_id: rpc.summary_audit_id,
        plan_request_sha256: options.execution.rpc.plan_request_sha256,
        plan_summary_audit_id: options.execution.rpc.summary_audit_id,
        result: 'success',
        error: null,
      };
      appendStableJsonLine(options.batchProgressPath, entry);
      options.batchProgress.entries.push(entry);
      options.batchProgress.successes.set(batch.batch_id, entry);
    }
  }
  const entry: AliasPlanProgressEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    target_mode: 'owner_draft',
    actor: { user_id: options.context.account.user_id, email: options.context.account.email },
    started_at_utc: options.startedAt,
    ended_at_utc: options.endedAt,
    plan_request_sha256: options.execution.rpc.plan_request_sha256,
    idempotent_replay: options.execution.rpc.idempotent_replay,
    batch_count: 2,
    row_count: 52,
    exchange_count: 59,
    summary_audit_id: options.execution.rpc.summary_audit_id,
    batches: batchProofs,
    result: 'success',
    error: null,
  };
  if (options.planProgress.success) {
    if (
      options.planProgress.success.plan_request_sha256 !== entry.plan_request_sha256 ||
      options.planProgress.success.summary_audit_id !== entry.summary_audit_id ||
      sha256Json(options.planProgress.success.batches) !== sha256Json(entry.batches)
    ) {
      throw new CliError('Existing alias plan proof does not match whole-plan replay.', {
        code: 'DATASET_MAINTENANCE_ALIAS_PLAN_PROGRESS_INVALID',
        exitCode: 1,
      });
    }
    return options.planProgress.success;
  }
  appendStableJsonLine(options.planProgressPath, entry);
  options.planProgress.entries.push(entry);
  options.planProgress.success = entry;
  options.planProgress.latestFailure = null;
  return entry;
}

async function executeAction(options: {
  action: DatasetMaintenancePlanAction;
  plan: DatasetMaintenancePlan;
  planDir: string;
  context: DatasetMaintenanceRemoteContext;
}): Promise<{ afterSha256: string | null; remoteResultSha256: string }> {
  if (options.action.action === 'rebuild_derivatives') {
    throw new CliError(
      'Derivative rebuild actions may only execute through the guarded whole-plan RPC.',
      {
        code: 'DATASET_MAINTENANCE_DERIVATIVE_SEQUENTIAL_WRITE_FORBIDDEN',
        exitCode: 1,
      },
    );
  }
  if (!options.action.before) {
    throw new CliError(`Action lacks a before snapshot: ${options.action.action_id}`, {
      code: 'DATASET_MAINTENANCE_PLAN_INVALID',
      exitCode: 2,
    });
  }
  const justInTime = await fetchMaintenanceExactRows({
    context: options.context,
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
  });
  const pendingRow = justInTime.rows.length === 1 ? justInTime.rows[0] : null;
  const pendingSnapshot = pendingRow ? snapshotRemoteRow(pendingRow) : null;
  const exactDraft = Boolean(
    pendingRow &&
    pendingRow.state_code === 0 &&
    pendingSnapshot?.row_sha256 === options.action.before.row_sha256,
  );
  if (!pendingRow || pendingRow.user_id !== options.action.expected_user_id || !exactDraft) {
    throw new CliError(`Action row drifted immediately before write: ${options.action.action_id}`, {
      code: 'DATASET_MAINTENANCE_ACTION_JUST_IN_TIME_DRIFT',
      exitCode: 1,
    });
  }
  const audit = {
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    reason_code: options.action.reason_code,
    source: 'tiangong-lca dataset maintenance apply' as const,
  };
  if (options.action.action === 'save_draft') {
    const remoteResult = await saveDraftMaintenanceRow({
      context: options.context,
      table: options.action.table as DatasetMaintenanceMutableTable,
      id: options.action.id,
      version: options.action.version,
      payload: loadDesiredPayload(options.planDir, options.action),
      modelId: options.action.before?.model_id ?? null,
      ruleVerification: options.action.before?.rule_verification ?? null,
      audit,
    });
    const readback = await fetchMaintenanceExactRows({
      context: options.context,
      table: options.action.table,
      id: options.action.id,
      version: options.action.version,
    });
    const row = readback.rows[0];
    if (readback.rows.length !== 1 || !row) {
      throw new CliError(`save_draft readback failed for ${options.action.action_id}.`, {
        code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
        exitCode: 1,
      });
    }
    const expectedPayload = options.action.desired_payload?.sha256;
    const readbackSnapshot = snapshotRemoteRow(row);
    if (
      readbackSnapshot.payload_sha256 !== expectedPayload ||
      row.user_id !== options.action.expected_user_id ||
      row.state_code !== 0
    ) {
      throw new CliError(`save_draft readback mismatch for ${options.action.action_id}.`, {
        code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
        exitCode: 1,
      });
    }
    return {
      afterSha256: readbackSnapshot.row_sha256,
      remoteResultSha256: sha256Json(remoteResult),
    };
  }
  if (options.action.action === 'update_json_ordered') {
    throw new CliError('Atomic alias actions must execute through the whole-plan RPC.', {
      code: 'DATASET_MAINTENANCE_ALIAS_SEQUENTIAL_WRITE_FORBIDDEN',
      exitCode: 1,
    });
  }
  if (options.action.action !== 'delete') {
    throw new CliError(`Unsupported maintenance action: ${options.action.action}`, {
      code: 'DATASET_MAINTENANCE_ACTION_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const remoteResult = await deleteMaintenanceRow({
    context: options.context,
    table: options.action.table as DatasetMaintenanceMutableTable,
    id: options.action.id,
    version: options.action.version,
    audit,
  });
  const readback = await fetchMaintenanceExactRows({
    context: options.context,
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
  });
  if (readback.rows.length !== 0) {
    throw new CliError(`delete readback failed for ${options.action.action_id}.`, {
      code: 'DATASET_MAINTENANCE_ACTION_READBACK_FAILED',
      exitCode: 1,
    });
  }
  return { afterSha256: null, remoteResultSha256: sha256Json(remoteResult) };
}

function appendParallelDeleteProgress(options: {
  progressPath: string;
  progress: ProgressState;
  plan: DatasetMaintenancePlan;
  action: DatasetMaintenancePlanAction;
  context: DatasetMaintenanceRemoteContext;
  startedAtUtc: string;
  endedAtUtc: string;
  result: 'success' | 'failed';
  remoteResultSha256: string | null;
  error: string | null;
}): DatasetMaintenanceProgressEntry {
  const entry: DatasetMaintenanceProgressEntry = {
    schema_version: 1,
    plan_sha256: options.plan.plan_sha256,
    operation_id: options.plan.operation_id,
    action_id: options.action.action_id,
    action: 'delete',
    table: options.action.table,
    id: options.action.id,
    version: options.action.version,
    reason_code: options.action.reason_code,
    audit_context: {
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: options.action.action_id,
      reason_code: options.action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    actor: {
      user_id: options.context.account.user_id,
      email: options.context.account.email,
    },
    started_at_utc: options.startedAtUtc,
    ended_at_utc: options.endedAtUtc,
    before_sha256: options.action.before!.row_sha256,
    after_sha256: null,
    remote_result_sha256: options.remoteResultSha256,
    result: options.result,
    error: options.error,
    rollback: options.action.rollback,
  };
  appendStableJsonLine(options.progressPath, entry);
  options.progress.entries.push(entry);
  if (entry.result === 'success') {
    options.progress.successes.set(entry.action_id, entry);
    options.progress.latestFailures.delete(entry.action_id);
  } else if (!options.progress.successes.has(entry.action_id)) {
    options.progress.latestFailures.set(entry.action_id, entry);
  }
  return entry;
}

function remoteAuditId(value: JsonObject): string | null {
  const candidate = value.audit_id;
  return typeof candidate === 'string' && POSITIVE_INTEGER_TEXT.test(candidate) ? candidate : null;
}

async function exactParallelDeleteRows(options: {
  context: DatasetMaintenanceRemoteContext;
  action: DatasetMaintenancePlanAction;
}): Promise<DatasetMaintenanceRemoteRow[]> {
  return (
    await fetchMaintenanceExactRows({
      context: options.context,
      table: options.action.table,
      id: options.action.id,
      version: options.action.version,
    })
  ).rows;
}

function exactParallelDeleteBefore(options: {
  rows: DatasetMaintenanceRemoteRow[];
  action: DatasetMaintenancePlanAction;
}): boolean {
  const row = options.rows[0];
  return Boolean(
    options.rows.length === 1 &&
    row &&
    row.user_id === options.action.expected_user_id &&
    row.state_code === 0 &&
    snapshotRemoteRow(row).row_sha256 === options.action.before?.row_sha256,
  );
}

async function executeParallelDeletePlan(options: {
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  progress: ProgressState;
  progressPath: string;
  executionLogPath: string;
  execution: ParallelDeleteExecutionState;
  maxParallel: number;
  now: () => string;
}): Promise<Map<string, 'success' | 'failed' | 'unknown'>> {
  const statuses = new Map<string, 'success' | 'failed' | 'unknown'>();

  const recoverAttempted = async (action: DatasetMaintenancePlanAction): Promise<void> => {
    const startedAt = options.now();
    let rows: DatasetMaintenanceRemoteRow[];
    try {
      rows = await exactParallelDeleteRows({ context: options.context, action });
    } catch (error) {
      statuses.set(action.action_id, 'unknown');
      if (options.execution.byAction.get(action.action_id)?.at(-1)?.status !== 'UNKNOWN') {
        appendParallelDeleteExecutionEntry({
          path: options.executionLogPath,
          state: options.execution,
          plan: options.plan,
          action,
          context: options.context,
          status: 'UNKNOWN',
          recordedAtUtc: options.now(),
          recovered: true,
          error: `Read-only recovery failed: ${errorMessage(error)}`,
        });
      }
      return;
    }
    if (rows.length === 0) {
      const priorCommitted = options.execution.committed.has(action.action_id);
      if (!priorCommitted) {
        appendParallelDeleteExecutionEntry({
          path: options.executionLogPath,
          state: options.execution,
          plan: options.plan,
          action,
          context: options.context,
          status: 'COMMITTED',
          recordedAtUtc: options.now(),
          recovered: true,
          readbackSha256: ABSENT_READBACK_SHA256,
        });
      }
      if (!options.progress.successes.has(action.action_id)) {
        appendParallelDeleteProgress({
          progressPath: options.progressPath,
          progress: options.progress,
          plan: options.plan,
          action,
          context: options.context,
          startedAtUtc: startedAt,
          endedAtUtc: options.now(),
          result: 'success',
          remoteResultSha256: sha256Json({
            recovery: 'desired_absent',
            action_id: action.action_id,
            desired_sha256: parallelDeleteDesiredSha256(action),
          }),
          error: null,
        });
      }
      statuses.set(action.action_id, 'success');
      return;
    }
    const message = exactParallelDeleteBefore({ rows, action })
      ? 'Prior dispatch has exact-before readback but no zero-dispatch/zero-mutation audit proof; replay is forbidden.'
      : 'Prior dispatch has ambiguous or drifted readback; replay is forbidden.';
    if (
      !options.execution.committed.has(action.action_id) &&
      options.execution.byAction.get(action.action_id)?.at(-1)?.status !== 'UNKNOWN'
    ) {
      appendParallelDeleteExecutionEntry({
        path: options.executionLogPath,
        state: options.execution,
        plan: options.plan,
        action,
        context: options.context,
        status: 'UNKNOWN',
        recordedAtUtc: options.now(),
        recovered: true,
        readbackSha256: sha256Json(rows.map(snapshotRemoteRow)),
        error: message,
      });
    }
    if (!options.progress.successes.has(action.action_id)) {
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'failed',
        remoteResultSha256: null,
        error: `UNKNOWN: ${message}`,
      });
    }
    statuses.set(action.action_id, 'unknown');
  };

  const executeOne = async (action: DatasetMaintenancePlanAction): Promise<void> => {
    if (options.progress.successes.has(action.action_id)) {
      statuses.set(action.action_id, 'success');
      return;
    }
    if (options.execution.dispatched.has(action.action_id)) {
      await recoverAttempted(action);
      return;
    }

    const startedAt = options.now();
    let rows: DatasetMaintenanceRemoteRow[];
    try {
      rows = await exactParallelDeleteRows({ context: options.context, action });
      if (!exactParallelDeleteBefore({ rows, action })) {
        throw new CliError(`Action row drifted immediately before write: ${action.action_id}`, {
          code: 'DATASET_MAINTENANCE_ACTION_JUST_IN_TIME_DRIFT',
          exitCode: 1,
        });
      }
    } catch (error) {
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'failed',
        remoteResultSha256: null,
        error: errorMessage(error),
      });
      statuses.set(action.action_id, 'failed');
      return;
    }

    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'PREPARED',
      recordedAtUtc: options.now(),
    });
    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'DISPATCHED',
      recordedAtUtc: options.now(),
    });

    let remoteResult: JsonObject | null = null;
    let dispatchError: unknown = null;
    try {
      remoteResult = await deleteMaintenanceRow({
        context: options.context,
        table: action.table as DatasetMaintenanceMutableTable,
        id: action.id,
        version: action.version,
        audit: {
          plan_sha256: options.plan.plan_sha256,
          operation_id: options.plan.operation_id,
          action_id: action.action_id,
          reason_code: action.reason_code,
          desired_sha256: parallelDeleteDesiredSha256(action),
          source: 'tiangong-lca dataset maintenance apply',
        },
      });
    } catch (error) {
      dispatchError = error;
    }

    let readbackRows: DatasetMaintenanceRemoteRow[] | null = null;
    let readbackError: unknown = null;
    try {
      readbackRows = await exactParallelDeleteRows({ context: options.context, action });
    } catch (error) {
      readbackError = error;
    }
    if (readbackRows?.length === 0) {
      const remoteResultSha256 = remoteResult ? sha256Json(remoteResult) : null;
      appendParallelDeleteExecutionEntry({
        path: options.executionLogPath,
        state: options.execution,
        plan: options.plan,
        action,
        context: options.context,
        status: 'COMMITTED',
        recordedAtUtc: options.now(),
        recovered: dispatchError !== null,
        auditId: remoteResult ? remoteAuditId(remoteResult) : null,
        readbackSha256: ABSENT_READBACK_SHA256,
        remoteResultSha256,
      });
      appendParallelDeleteProgress({
        progressPath: options.progressPath,
        progress: options.progress,
        plan: options.plan,
        action,
        context: options.context,
        startedAtUtc: startedAt,
        endedAtUtc: options.now(),
        result: 'success',
        remoteResultSha256:
          remoteResultSha256 ??
          sha256Json({
            recovery: 'desired_absent',
            action_id: action.action_id,
            desired_sha256: parallelDeleteDesiredSha256(action),
          }),
        error: null,
      });
      statuses.set(action.action_id, 'success');
      return;
    }

    const error = readbackError
      ? `Readback failed after dispatch: ${errorMessage(readbackError)}`
      : dispatchError
        ? `Dispatch outcome ambiguous and desired absence was not observed: ${errorMessage(dispatchError)}`
        : 'Delete RPC returned but exact absent readback was not observed.';
    appendParallelDeleteExecutionEntry({
      path: options.executionLogPath,
      state: options.execution,
      plan: options.plan,
      action,
      context: options.context,
      status: 'UNKNOWN',
      recordedAtUtc: options.now(),
      recovered: dispatchError !== null,
      auditId: remoteResult ? remoteAuditId(remoteResult) : null,
      readbackSha256: readbackRows ? sha256Json(readbackRows.map(snapshotRemoteRow)) : null,
      remoteResultSha256: remoteResult ? sha256Json(remoteResult) : null,
      error,
    });
    appendParallelDeleteProgress({
      progressPath: options.progressPath,
      progress: options.progress,
      plan: options.plan,
      action,
      context: options.context,
      startedAtUtc: startedAt,
      endedAtUtc: options.now(),
      result: 'failed',
      remoteResultSha256: null,
      error: `UNKNOWN: ${error}`,
    });
    statuses.set(action.action_id, 'unknown');
  };

  let nextIndex = 0;
  let fatalError: unknown = null;
  const worker = async (): Promise<void> => {
    while (fatalError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.plan.actions.length) return;
      try {
        await executeOne(options.plan.actions[index]!);
      } catch (error) {
        fatalError ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.maxParallel, options.plan.actions.length) }, () =>
      worker(),
    ),
  );
  if (fatalError !== null) throw fatalError;
  return statuses;
}

async function executeDerivativeAdmission(options: {
  plan: DatasetMaintenancePlan;
  context: DatasetMaintenanceRemoteContext;
  replayPossible: boolean;
  attemptPath: string;
  preparedAtUtc: string;
}): Promise<DatasetMaintenanceDerivativeSubmitProof> {
  const action = derivativePlanAction(options.plan);
  const plannedSnapshot = action.derivative_before!;
  const preflight = parseDerivativeSnapshotResponse(
    await fetchMaintenanceDerivativeSnapshot({
      context: options.context,
      id: action.id,
      version: action.version,
    }),
    { id: action.id, version: action.version, userId: action.expected_user_id },
  );
  if (
    preflight.modified_at !== plannedSnapshot.modified_at ||
    preflight.json_sha256 !== plannedSnapshot.json_sha256 ||
    preflight.json_ordered_sha256 !== plannedSnapshot.json_ordered_sha256
  ) {
    throw new CliError('Derivative action primary preconditions drifted after planning.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_PRIMARY_DRIFT',
      exitCode: 1,
      details: {
        expected_snapshot_sha256: plannedSnapshot.snapshot_sha256,
        actual_snapshot_sha256: preflight.snapshot_sha256,
      },
    });
  }
  if (!options.replayPossible && preflight.snapshot_sha256 !== plannedSnapshot.snapshot_sha256) {
    throw new CliError('Derivative action-scoped snapshot drifted before first admission.', {
      code: 'DATASET_MAINTENANCE_DERIVATIVE_SNAPSHOT_DRIFT',
      exitCode: 1,
      details: {
        expected: plannedSnapshot.snapshot_sha256,
        actual: preflight.snapshot_sha256,
      },
    });
  }
  if (!options.replayPossible) {
    writeImmutableJson(options.attemptPath, {
      schema_version: 1,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
      action_id: action.action_id,
      table: 'processes',
      id: action.id,
      version: action.version,
      expected_snapshot_sha256: plannedSnapshot.snapshot_sha256,
      actor: {
        user_id: options.context.account.user_id,
        email: options.context.account.email,
      },
      prepared_at_utc: options.preparedAtUtc,
    } satisfies DerivativeAdmissionAttempt);
  }
  const result = await applyMaintenanceDerivativeRebuild({
    context: options.context,
    plan: buildDerivativePlanRequest(options.plan),
  });
  return parseDerivativeSubmitResponse(result, options.plan);
}

function nextAttemptPath(planDir: string): string {
  let attempt = 1;
  while (
    existsSync(path.join(planDir, `commit-report.attempt-${String(attempt).padStart(4, '0')}.json`))
  ) {
    attempt += 1;
  }
  return path.join(planDir, `commit-report.attempt-${String(attempt).padStart(4, '0')}.json`);
}

function nextParallelDeleteInboundBarrierPath(planDir: string): string {
  let attempt = 1;
  while (
    existsSync(
      path.join(
        planDir,
        `parallel-delete-inbound-barrier.attempt-${String(attempt).padStart(4, '0')}.json`,
      ),
    )
  ) {
    attempt += 1;
  }
  return path.join(
    planDir,
    `parallel-delete-inbound-barrier.attempt-${String(attempt).padStart(4, '0')}.json`,
  );
}

export async function runDatasetMaintenanceApply(
  options: RunDatasetMaintenanceApplyOptions,
): Promise<DatasetMaintenanceApplyReport> {
  if (!options.commit) {
    throw new CliError('Dataset maintenance apply requires commit=true.', {
      code: 'DATASET_MAINTENANCE_COMMIT_REQUIRED',
      exitCode: 2,
    });
  }
  const planPath = path.resolve(options.planPath);
  const planDir = path.dirname(planPath);
  const plan = parseMaintenancePlan(readJsonFile(planPath, 'Maintenance plan'));
  const parallelDeleteMode = options.maxParallel !== undefined;
  const maxParallel = normalizeMaintenanceMaxParallel(options.maxParallel);
  assertGlobalInboundProofOptionShape({
    parallelDeleteMode,
    proofPath: options.globalInboundProofPath,
    approveProof: options.approveGlobalInboundProof,
  });
  if (parallelDeleteMode) {
    assertParallelDeletePlan(plan);
  }
  if (options.approvePlan !== plan.plan_sha256) {
    throw new CliError('approvePlan must exactly match the canonical maintenance plan hash.', {
      code: 'DATASET_MAINTENANCE_PLAN_APPROVAL_REQUIRED',
      exitCode: 2,
    });
  }
  if (plan.status !== 'ready' || plan.blockers.length > 0) {
    throw new CliError('Blocked maintenance plan cannot be applied.', {
      code: 'DATASET_MAINTENANCE_PLAN_BLOCKED',
      exitCode: 1,
      details: plan.blockers,
    });
  }
  if (plan.operation === 'merge-support-aliases') {
    throw new CliError(
      'merge-support-aliases is sealed for dataset maintenance run-protected and cannot use ordinary apply.',
      {
        code: 'DATASET_MAINTENANCE_PROTECTED_RUN_REQUIRED',
        exitCode: 1,
      },
    );
  }
  if (
    plan.operation === 'redo-import' &&
    !plan.source_import_run_id &&
    plan.source_lineage === null
  ) {
    throw new CliError('redo-import apply requires frozen redo source/import lineage.', {
      code: 'DATASET_MAINTENANCE_REDO_NOT_READY',
      exitCode: 1,
    });
  }

  const progressPath = path.join(
    planDir,
    plan.operation === 'rebuild-derivatives'
      ? 'derivative-submit-progress.jsonl'
      : 'apply-progress.jsonl',
  );
  return withStateFileLock(
    progressPath,
    { reason: `dataset_maintenance_apply_${plan.operation_id}` },
    async () => {
      const context = await resolveMaintenanceRemoteContext({
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      if (
        context.account.user_id !== plan.account.user_id ||
        context.account.email !== plan.account.email
      ) {
        throw new CliError('Current authenticated account does not match the maintenance plan.', {
          code: 'DATASET_MAINTENANCE_ACCOUNT_MISMATCH',
          exitCode: 1,
        });
      }
      if (options.confirm !== context.account.email) {
        throw new CliError('confirm must exactly match the current authenticated account email.', {
          code: 'DATASET_MAINTENANCE_CONFIRMATION_REQUIRED',
          exitCode: 2,
        });
      }
      const globalInboundProof = parallelDeleteMode
        ? validateParallelDeleteGlobalInboundProof({
            proofPath: options.globalInboundProofPath,
            approveProof: options.approveGlobalInboundProof,
            plan,
            context,
            now: options.now ?? new Date(),
          })
        : null;
      const derivativeProgress: DerivativeSubmitProgressState =
        plan.operation === 'rebuild-derivatives'
          ? parseDerivativeSubmitProgress(plan, progressPath)
          : { entries: [], latest: null };
      const progress: ProgressState =
        plan.operation === 'rebuild-derivatives'
          ? { entries: [], successes: new Map(), latestFailures: new Map() }
          : parseProgress(plan, progressPath);
      const executionLogPath = path.join(planDir, 'apply-execution-log.jsonl');
      const parallelDeleteExecution: ParallelDeleteExecutionState = parallelDeleteMode
        ? parseParallelDeleteExecutionLog(plan, executionLogPath)
        : { entries: [], byAction: new Map(), dispatched: new Set(), committed: new Set() };
      const resumedSuccesses = progress.successes.size;
      const [current, visibleProcesses] = await Promise.all([
        fetchMaintenanceAccountRows({
          context,
          userId: plan.account.user_id,
        }),
        parallelDeleteMode && !globalInboundProof
          ? fetchMaintenanceVisibleTableRows({
              context,
              table: 'processes',
              pageSize: PARALLEL_DELETE_VISIBLE_PROCESS_PAGE_SIZE,
            })
          : Promise.resolve(null),
      ]);
      assertApplyPreconditions({
        plan,
        planDir,
        currentRows: current.rows,
        progress,
        aliasPlanProgress: { entries: [], success: null, latestFailure: null },
        attemptedDeleteActionIds: parallelDeleteExecution.dispatched,
      });

      const inboundBarrierPath = nextParallelDeleteInboundBarrierPath(planDir);
      const inboundBarrier = globalInboundProof
        ? {
            process_rows: globalInboundProof.global_process_rows,
            process_references: globalInboundProof.global_exchange_rows,
            snapshot_sha256: globalInboundProof.proof_sha256,
          }
        : parallelDeleteMode && visibleProcesses
          ? assertNoVisibleProcessInboundReferences({ plan, rows: visibleProcesses.rows })
          : null;
      if (inboundBarrier && (visibleProcesses || globalInboundProof)) {
        writeImmutableJson(inboundBarrierPath, {
          schema_version: 1,
          generated_at_utc: clock(options),
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          actor: { user_id: context.account.user_id, email: context.account.email },
          target_table: 'flows',
          target_count: plan.actions.length,
          inbound_reference_count: 0,
          ...inboundBarrier,
          completeness: globalInboundProof
            ? {
                status: 'complete',
                complete: true,
                strategy: 'sha256_approved_global_select_only_all_processes',
                statement_kind: globalInboundProof.statement_kind,
                process_scope: globalInboundProof.process_scope,
                proof_path: globalInboundProof.proof_path,
                proof_sha256: globalInboundProof.proof_sha256,
                captured_at_utc: globalInboundProof.captured_at_utc,
                target_binding_sha256: globalInboundProof.target_binding_sha256,
                chunk_count: globalInboundProof.chunks.length,
                global_process_rows: globalInboundProof.global_process_rows,
                global_exchange_rows: globalInboundProof.global_exchange_rows,
                inbound_exchanges: globalInboundProof.inbound_exchanges,
              }
            : visibleProcesses!.completeness,
        });
      }

      const approvalPath = path.join(planDir, 'approval-record.json');
      const approvalAlreadyExisted = existsSync(approvalPath);
      validateApprovalRecord({ path: approvalPath, plan, context });
      if (!approvalAlreadyExisted) {
        writeImmutableJson(approvalPath, {
          schema_version: 1,
          approved_at_utc: clock(options),
          plan_path: planPath,
          plan_sha256: plan.plan_sha256,
          task_id: plan.task_id,
          operation: plan.operation,
          target_mode: plan.target_mode,
          operation_id: plan.operation_id,
          account: {
            user_id: context.account.user_id,
            email: context.account.email,
          },
          confirmed_email: options.confirm,
          row_counts: plan.summary,
          snapshot_completeness: current.completeness,
          redo_rows_ready:
            plan.operation === 'redo-import'
              ? Boolean(plan.source_import_run_id || plan.source_lineage !== null)
              : null,
        });
      }

      if (plan.operation === 'rebuild-derivatives') {
        const startedAt = clock(options);
        const derivativeAttemptPath = path.join(planDir, 'derivative-admission-attempt.json');
        const derivativeAttempt = validateDerivativeAdmissionAttempt({
          path: derivativeAttemptPath,
          plan,
          context,
        });
        const proof = await executeDerivativeAdmission({
          plan,
          context,
          replayPossible: derivativeAttempt !== null,
          attemptPath: derivativeAttemptPath,
          preparedAtUtc: startedAt,
        });
        if (
          derivativeProgress.latest &&
          derivativeProofIdentity(derivativeProgress.latest.proof) !==
            derivativeProofIdentity(proof)
        ) {
          throw new CliError('Derivative guarded-RPC replay returned a different request proof.', {
            code: 'DATASET_MAINTENANCE_DERIVATIVE_REPLAY_MISMATCH',
            exitCode: 1,
          });
        }
        const action = derivativePlanAction(plan);
        const entry: DerivativeSubmitProgressEntry = {
          schema_version: 1,
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          action_id: action.action_id,
          target_mode: 'owner_draft',
          actor: { user_id: context.account.user_id, email: context.account.email },
          started_at_utc: startedAt,
          ended_at_utc: clock(options),
          result: 'accepted',
          proof,
        };
        appendStableJsonLine(progressPath, entry);
        const attemptPath = nextAttemptPath(planDir);
        const report: DatasetMaintenanceApplyReport = {
          schema_version: 1,
          generated_at_utc: clock(options),
          status: 'accepted',
          task_id: plan.task_id,
          operation: plan.operation,
          operation_id: plan.operation_id,
          target_mode: plan.target_mode,
          plan_sha256: plan.plan_sha256,
          actor: { user_id: context.account.user_id, email: context.account.email },
          summary: {
            actions: 1,
            success: 0,
            failed: 0,
            pending: 1,
            resumed_successes: 0,
            accepted: 1,
          },
          actions: [
            {
              action_id: action.action_id,
              action: action.action,
              table: action.table,
              id: action.id,
              version: action.version,
              status: 'accepted',
              error: null,
            },
          ],
          artifacts: {
            approval_record: approvalPath,
            apply_progress: progressPath,
            derivative_submit_progress: progressPath,
            derivative_admission_attempt: derivativeAttemptPath,
            commit_report: path.join(planDir, 'commit-report.json'),
            attempt_report: attemptPath,
          },
          database_audit: {
            rpc_transaction_log: 'public.command_audit_log',
            source: 'tiangong-lca dataset maintenance apply',
            correlation_fields: [
              'plan_sha256',
              'operation_id',
              'action_id',
              'target_visibility',
              'plan_request_sha256',
              'action_request_sha256',
              'request_id',
            ],
          },
          derivative_admission: { ...proof, admission: 'accepted' },
        };
        writeImmutableJson(attemptPath, report);
        writeJsonArtifact(report.artifacts.commit_report, report);
        return report;
      }

      if (parallelDeleteMode) {
        const executionStatuses = await executeParallelDeletePlan({
          plan,
          context,
          progress,
          progressPath,
          executionLogPath,
          execution: parallelDeleteExecution,
          maxParallel,
          now: () => clock(options),
        });
        const actions = plan.actions.map((action) => {
          const status = executionStatuses.get(action.action_id) as
            'success' | 'failed' | 'unknown';
          return {
            action_id: action.action_id,
            action: action.action,
            table: action.table,
            id: action.id,
            version: action.version,
            status,
            error: progress.latestFailures.get(action.action_id)?.error ?? null,
          };
        });
        const successCount = actions.filter((action) => action.status === 'success').length;
        const failureCount = actions.filter((action) => action.status === 'failed').length;
        const unknownCount = actions.filter((action) => action.status === 'unknown').length;
        const attemptPath = nextAttemptPath(planDir);
        const report: DatasetMaintenanceApplyReport = {
          schema_version: 1,
          generated_at_utc: clock(options),
          status:
            unknownCount > 0
              ? 'completed_with_unknowns'
              : successCount === actions.length
                ? 'completed'
                : 'completed_with_failures',
          task_id: plan.task_id,
          operation: plan.operation,
          operation_id: plan.operation_id,
          target_mode: plan.target_mode,
          plan_sha256: plan.plan_sha256,
          actor: { user_id: context.account.user_id, email: context.account.email },
          summary: {
            actions: actions.length,
            success: successCount,
            failed: failureCount,
            unknown: unknownCount,
            pending: actions.length - successCount - failureCount - unknownCount,
            resumed_successes: resumedSuccesses,
          },
          actions,
          artifacts: {
            approval_record: approvalPath,
            apply_progress: progressPath,
            execution_log: executionLogPath,
            inbound_reference_barrier: inboundBarrierPath,
            commit_report: path.join(planDir, 'commit-report.json'),
            attempt_report: attemptPath,
          },
          database_audit: {
            rpc_transaction_log: 'public.command_audit_log',
            source: 'tiangong-lca dataset maintenance apply',
            correlation_fields: [
              'plan_sha256',
              'operation_id',
              'action_id',
              'reason_code',
              'desired_sha256',
            ],
          },
        };
        writeImmutableJson(attemptPath, report);
        writeJsonArtifact(report.artifacts.commit_report, report);
        return report;
      }

      const ordered = [...plan.actions].sort((left, right) => {
        const rank = {
          save_draft: 0,
          update_json_ordered: 0,
          rebuild_derivatives: 0,
          delete: 1,
        } as const;
        const actionOrder = rank[left.action] - rank[right.action];
        return actionOrder || left.ordinal - right.ordinal;
      });
      for (const action of ordered) {
        if (progress.successes.has(action.action_id)) {
          continue;
        }
        const startedAt = clock(options);
        try {
          const actionResult = await executeAction({ action, plan, planDir, context });
          const entry: DatasetMaintenanceProgressEntry = {
            schema_version: 1,
            plan_sha256: plan.plan_sha256,
            operation_id: plan.operation_id,
            action_id: action.action_id,
            action: action.action,
            table: action.table,
            id: action.id,
            version: action.version,
            reason_code: action.reason_code,
            audit_context: {
              plan_sha256: plan.plan_sha256,
              operation_id: plan.operation_id,
              action_id: action.action_id,
              reason_code: action.reason_code,
              source: 'tiangong-lca dataset maintenance apply',
            },
            actor: { user_id: context.account.user_id, email: context.account.email },
            started_at_utc: startedAt,
            ended_at_utc: clock(options),
            before_sha256: action.before!.row_sha256,
            after_sha256: actionResult.afterSha256,
            remote_result_sha256: actionResult.remoteResultSha256,
            result: 'success',
            error: null,
            rollback: action.rollback,
          };
          appendStableJsonLine(progressPath, entry);
          progress.entries.push(entry);
          progress.successes.set(action.action_id, entry);
          progress.latestFailures.delete(action.action_id);
        } catch (error) {
          const entry: DatasetMaintenanceProgressEntry = {
            schema_version: 1,
            plan_sha256: plan.plan_sha256,
            operation_id: plan.operation_id,
            action_id: action.action_id,
            action: action.action,
            table: action.table,
            id: action.id,
            version: action.version,
            reason_code: action.reason_code,
            audit_context: {
              plan_sha256: plan.plan_sha256,
              operation_id: plan.operation_id,
              action_id: action.action_id,
              reason_code: action.reason_code,
              source: 'tiangong-lca dataset maintenance apply',
            },
            actor: { user_id: context.account.user_id, email: context.account.email },
            started_at_utc: startedAt,
            ended_at_utc: clock(options),
            before_sha256: action.before!.row_sha256,
            after_sha256: null,
            remote_result_sha256: null,
            result: 'failed',
            error: errorMessage(error),
            rollback: action.rollback,
          };
          appendStableJsonLine(progressPath, entry);
          progress.entries.push(entry);
          progress.latestFailures.set(action.action_id, entry);
          break;
        }
      }

      const actions = plan.actions.map((action) => {
        const success = progress.successes.get(action.action_id);
        const failure = progress.latestFailures.get(action.action_id);
        return {
          action_id: action.action_id,
          action: action.action,
          table: action.table,
          id: action.id,
          version: action.version,
          status: success
            ? ('success' as const)
            : failure
              ? ('failed' as const)
              : ('pending' as const),
          error: failure?.error ?? null,
        };
      });
      const successCount = actions.filter((action) => action.status === 'success').length;
      const failureCount = actions.filter((action) => action.status === 'failed').length;
      const attemptPath = nextAttemptPath(planDir);
      const report: DatasetMaintenanceApplyReport = {
        schema_version: 1,
        generated_at_utc: clock(options),
        status: successCount === actions.length ? 'completed' : 'completed_with_failures',
        task_id: plan.task_id,
        operation: plan.operation,
        operation_id: plan.operation_id,
        target_mode: plan.target_mode,
        plan_sha256: plan.plan_sha256,
        actor: { user_id: context.account.user_id, email: context.account.email },
        summary: {
          actions: actions.length,
          success: successCount,
          failed: failureCount,
          pending: actions.length - successCount - failureCount,
          resumed_successes: resumedSuccesses,
        },
        actions,
        artifacts: {
          approval_record: approvalPath,
          apply_progress: progressPath,
          commit_report: path.join(planDir, 'commit-report.json'),
          attempt_report: attemptPath,
        },
        database_audit: {
          rpc_transaction_log: 'public.command_audit_log',
          source: 'tiangong-lca dataset maintenance apply',
          correlation_fields: ['plan_sha256', 'operation_id', 'action_id', 'reason_code'],
        },
      };
      writeImmutableJson(attemptPath, report);
      writeJsonArtifact(report.artifacts.commit_report, report);
      return report;
    },
  );
}

export const __testInternals = {
  aliasExchangeProgressKey,
  appendAliasSuccessLogs,
  appendAliasProofProgress,
  appendParallelDeleteExecutionEntry,
  assertNoVisibleProcessInboundReferences,
  assertApplyPreconditions,
  assertAliasSupportSnapshots,
  assertGlobalInboundProofOptionShape,
  assertParallelDeletePlan,
  buildAliasBatchRequest,
  buildAliasPlanRequest,
  clock,
  errorMessage,
  executeDerivativeAdmission,
  executeAction,
  executeParallelDeletePlan,
  finalProjectedRows,
  loadDesiredPayload,
  nextAttemptPath,
  nextParallelDeleteInboundBarrierPath,
  normalizeMaintenanceMaxParallel,
  parallelDeleteDesiredSha256,
  parallelDeleteTargetBindingSha256,
  parseDerivativeSubmitProgress,
  validateDerivativeAdmissionAttempt,
  parseAliasBatchProgress,
  parseAliasPlanProgress,
  parseProgress,
  parseParallelDeleteExecutionLog,
  remoteAuditId,
  validateAliasRpcResult,
  validateAliasPlanRpcResult,
  validateApprovalRecord,
  validateParallelDeleteGlobalInboundProof,
};
