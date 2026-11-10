import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import { parseFlowIdentityScopePreflightProof } from './maintenance/flow-identity/proofs.js';
import { parseFlowIdentityScopeStatus } from './maintenance/flow-identity/status.js';
import { prepareFlowIdentityExecution } from './dataset-maintenance-flow-identity-execution-contract.js';
import { type FlowIdentityScopeStatus } from './maintenance/flow-identity/base.js';
import {
  extractFlowIdentityReference,
  parseFlowIdentityCapture,
  type FlowIdentityLiveCapture,
  type FlowIdentityOccurrence,
  type FlowIdentityPlan,
} from './dataset-maintenance-flow-identity-contract.js';
import {
  isJsonObject,
  maintenanceRowKey,
  snapshotRemoteRow,
} from './maintenance/contract/values.js';
import { sha256Json, stableJsonText } from './canonical-json-hash.js';
import {
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from './maintenance/contract/types.js';
import {
  fetchMaintenanceAccountTableRows,
  fetchMaintenanceExactRows,
  normalizeMaintenancePageSize,
  readMaintenanceFlowIdentityScope,
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';

export type VerifyFlowIdentityOptions = {
  planPath: string;
  freezePath: string;
  approvalPath: string;
  runDir: string;
  outDir: string;
  pageSize?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
};

export type FlowIdentityVerificationIssue = {
  code: string;
  message: string;
  details?: unknown;
};

export type FlowIdentityVerificationReport = {
  schema_version: 'dataset-flow-identity-verification-report.v1';
  generated_at_utc: string;
  status: 'passed' | 'pending' | 'failed';
  plan_sha256: string;
  operation_id: string;
  scope_id: string;
  database_status: FlowIdentityScopeStatus['status'];
  terminal_proof_sha256: string | null;
  checks: {
    source_rows_unchanged: boolean;
    public_target_rows_unchanged: boolean;
    support_rows_unchanged: boolean;
    affected_processes_exact: boolean;
    approved_source_reference_residue: number;
    protected_closure_exact: boolean;
    complete_owner_draft_process_scan: boolean;
    derivatives_causally_terminal: boolean;
  };
  counts: {
    source_rows: number;
    public_target_rows: number;
    support_rows: number;
    affected_processes: number;
    owner_draft_processes_scanned: number;
  };
  issues: FlowIdentityVerificationIssue[];
};

type ReadbackInput = {
  plan: FlowIdentityPlan;
  capture: FlowIdentityLiveCapture;
  status: FlowIdentityScopeStatus;
  currentStableRows: DatasetMaintenanceRemoteRow[];
  currentOwnerDraftProcesses: DatasetMaintenanceRemoteRow[];
  processScanComplete: boolean;
};

function fail(message: string, code: string): never {
  throw new CliError(message, { code, exitCode: 1 });
}

function readCanonicalJson(filePath: string, label: string): unknown {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(`${label} must be canonical JSON.`, 'DATASET_FLOW_IDENTITY_ARTIFACT_NONCANONICAL');
  }
  return artifact.value;
}

function rowKey(table: string, id: string, version: string, userId: string | null): string {
  return `${table}\u0000${id}\u0000${version}\u0000${userId ?? ''}`;
}

function snapshotKey(row: DatasetMaintenanceRowSnapshot): string {
  return rowKey(row.table, row.id, row.version, row.user_id);
}

function currentKey(row: DatasetMaintenanceRemoteRow): string {
  return rowKey(row.table, row.id, row.version, row.user_id);
}

function snapshotWithoutJson(row: DatasetMaintenanceRemoteRow): DatasetMaintenanceRowSnapshot {
  const snapshotInput = { ...row };
  delete snapshotInput.json;
  return snapshotRemoteRow(snapshotInput);
}

function jsonColumnsMatch(row: DatasetMaintenanceRemoteRow): boolean {
  return Boolean(
    row.json !== undefined &&
    row.json !== null &&
    row.json_ordered !== null &&
    sha256Json(row.json) === sha256Json(row.json_ordered),
  );
}

function processExchanges(payload: JsonObject | null): JsonObject[] | null {
  if (!payload || !isJsonObject(payload.processDataSet)) return null;
  const exchanges = isJsonObject(payload.processDataSet.exchanges)
    ? payload.processDataSet.exchanges.exchange
    : null;
  const rows = Array.isArray(exchanges) ? exchanges : isJsonObject(exchanges) ? [exchanges] : null;
  return rows?.every(isJsonObject) ? rows : null;
}

function buildOccurrenceIndex(
  rows: DatasetMaintenanceRemoteRow[],
  issues: FlowIdentityVerificationIssue[],
): Map<string, FlowIdentityOccurrence[]> {
  const result = new Map<string, FlowIdentityOccurrence[]>();
  for (const row of [...rows].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  )) {
    const exchanges = processExchanges(row.json_ordered);
    if (!exchanges) {
      issues.push({
        code: 'FLOW_IDENTITY_PROCESS_EXCHANGES_INVALID',
        message: 'An owner-draft process has a malformed exchange collection.',
        details: { id: row.id, version: row.version },
      });
      continue;
    }
    exchanges.forEach((exchange, exchangeIndex) => {
      let reference;
      try {
        reference = extractFlowIdentityReference(
          exchange.referenceToFlowDataSet,
          'exchange reference',
        );
      } catch {
        issues.push({
          code: 'FLOW_IDENTITY_PROCESS_REFERENCE_INVALID',
          message: 'An owner-draft process has a malformed flow reference.',
          details: { id: row.id, version: row.version, exchange_index: exchangeIndex },
        });
        return;
      }
      const internalId = exchange['@dataSetInternalID'];
      const direction = exchange.exchangeDirection;
      if (typeof internalId !== 'string' || (direction !== 'Input' && direction !== 'Output')) {
        issues.push({
          code: 'FLOW_IDENTITY_PROCESS_EXCHANGE_IDENTITY_INVALID',
          message: 'An owner-draft exchange has an invalid internal ID or direction.',
          details: { id: row.id, version: row.version, exchange_index: exchangeIndex },
        });
        return;
      }
      const key = `${reference['@refObjectId']}\u0000${reference['@version']}`;
      const entries = result.get(key) ?? [];
      entries.push({
        process_id: row.id,
        process_version: row.version,
        exchange_index: exchangeIndex,
        internal_id: internalId,
        direction,
        reference_sha256: sha256Json(reference),
      });
      result.set(key, entries);
    });
  }
  return result;
}

function compareStableRows(options: {
  expected: DatasetMaintenanceRowSnapshot[];
  currentByKey: Map<string, DatasetMaintenanceRemoteRow>;
  code: string;
  issues: FlowIdentityVerificationIssue[];
}): boolean {
  let valid = true;
  for (const expected of options.expected) {
    const current = options.currentByKey.get(snapshotKey(expected));
    if (
      !current ||
      !jsonColumnsMatch(current) ||
      snapshotWithoutJson(current).row_sha256 !== expected.row_sha256
    ) {
      valid = false;
      options.issues.push({
        code: options.code,
        message: 'A sealed source/public/support row is missing or changed.',
        details: { table: expected.table, id: expected.id, version: expected.version },
      });
    }
  }
  return valid;
}

function derivativeSetIsCausallyTerminal(input: ReadbackInput): boolean {
  const proof = input.status.derivative_set_proof;
  return Boolean(
    input.status.status === 'completed' &&
    input.status.primary_complete &&
    input.status.protected_closure_current &&
    input.status.derivatives_current &&
    typeof input.status.terminal_proof_sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(input.status.terminal_proof_sha256) &&
    proof.ok &&
    proof.status === 'completed' &&
    proof.target_count === input.plan.processes.length &&
    proof.completed_count === input.plan.processes.length &&
    proof.pending_count === 0 &&
    proof.failed_count === 0 &&
    proof.causal_terminal_proof &&
    proof.targets.length === input.plan.processes.length &&
    proof.compensation_targets.length === 0 &&
    /^[a-f0-9]{64}$/u.test(proof.proof_sha256) &&
    proof.targets.every((target, index) => {
      const process = input.plan.processes[index];
      return Boolean(
        process &&
        target.ordinal === index + 1 &&
        target.id === process.id &&
        target.version === process.version &&
        target.status === 'completed' &&
        target.request_status === 'completed' &&
        target.phase === 'completed' &&
        target.lineage_ok &&
        target.proposals_committed &&
        target.terminal_audit_present &&
        /^[a-f0-9]{64}$/u.test(target.current_json_ordered_sha256) &&
        /^[a-f0-9]{64}$/u.test(target.current_snapshot_sha256) &&
        Object.values(target.residue).every((count) => count === 0) &&
        target.causal_terminal_proof,
      );
    }),
  );
}

export function verifyFlowIdentityReadback(input: ReadbackInput): FlowIdentityVerificationReport {
  const issues: FlowIdentityVerificationIssue[] = [];
  const currentByKey = new Map(input.currentStableRows.map((row) => [currentKey(row), row]));
  const sourceRowsUnchanged = compareStableRows({
    expected: input.capture.source_rows,
    currentByKey,
    code: 'FLOW_IDENTITY_SOURCE_ROW_DRIFT',
    issues,
  });
  const targetRowsUnchanged = compareStableRows({
    expected: input.capture.target_rows,
    currentByKey,
    code: 'FLOW_IDENTITY_PUBLIC_TARGET_ROW_DRIFT',
    issues,
  });
  const supportRowsUnchanged = compareStableRows({
    expected: input.capture.support_rows,
    currentByKey,
    code: 'FLOW_IDENTITY_SUPPORT_ROW_DRIFT',
    issues,
  });

  const processByKey = new Map(
    input.currentOwnerDraftProcesses.map((row) => [`${row.id}\u0000${row.version}`, row]),
  );
  let affectedProcessesExact = true;
  for (const expected of input.plan.processes) {
    const current = processByKey.get(`${expected.id}\u0000${expected.version}`);
    const exchanges = processExchanges(current?.json_ordered ?? null);
    if (
      !current ||
      current.user_id !== input.plan.account.user_id ||
      current.state_code !== 0 ||
      current.model_id !== expected.model_id ||
      current.rule_verification !== expected.rule_verification ||
      !jsonColumnsMatch(current) ||
      sha256Json(current.json_ordered) !== expected.desired_payload_sha256 ||
      !exchanges ||
      sha256Json(exchanges) !== expected.desired_exchange_set_sha256
    ) {
      affectedProcessesExact = false;
      issues.push({
        code: 'FLOW_IDENTITY_AFFECTED_PROCESS_DRIFT',
        message:
          'An affected process does not match the exact desired payload/exchange/metadata seal.',
        details: { id: expected.id, version: expected.version },
      });
    }
  }

  const occurrenceIndex = buildOccurrenceIndex(input.currentOwnerDraftProcesses, issues);
  let residue = 0;
  for (const mapping of input.plan.mappings) {
    residue +=
      occurrenceIndex.get(`${mapping.source.id}\u0000${mapping.source.version}`)?.length ?? 0;
  }
  if (residue > 0) {
    issues.push({
      code: 'FLOW_IDENTITY_APPROVED_SOURCE_REFERENCE_RESIDUE',
      message: 'At least one approved source flow reference remains in owner-draft processes.',
      details: { count: residue },
    });
  }

  let protectedClosureExact = true;
  for (const expected of [
    ...input.plan.protected_closure.pending,
    ...input.plan.protected_closure.blockers,
  ]) {
    const observed =
      occurrenceIndex.get(`${expected.source_id}\u0000${expected.source_version}`) ?? [];
    if (
      observed.length !== expected.expected_reference_count ||
      sha256Json(observed) !== expected.occurrence_set_sha256
    ) {
      protectedClosureExact = false;
      issues.push({
        code: 'FLOW_IDENTITY_PROTECTED_REFERENCE_DRIFT',
        message: 'A pending/blocker occurrence closure changed.',
        details: { source_id: expected.source_id, source_version: expected.source_version },
      });
    }
  }
  for (const expected of input.plan.protected_closure.orphans) {
    const observed =
      occurrenceIndex.get(`${expected.source_id}\u0000${expected.source_version}`) ?? [];
    if (observed.length > 0) {
      protectedClosureExact = false;
      issues.push({
        code: 'FLOW_IDENTITY_ORPHAN_REFERENCE_APPEARED',
        message: 'A sealed orphan now has a process reference.',
        details: { source_id: expected.source_id, source_version: expected.source_version },
      });
    }
  }
  if (!input.processScanComplete) {
    issues.push({
      code: 'FLOW_IDENTITY_PROCESS_SCAN_INCOMPLETE',
      message: 'The owner-draft process census did not have exact-count completeness proof.',
    });
  }

  const terminalProof = derivativeSetIsCausallyTerminal(input);
  if (!terminalProof) {
    issues.push({
      code: 'FLOW_IDENTITY_TERMINAL_PROOF_NOT_CURRENT',
      message:
        'The durable scope does not yet prove current causal derivatives and protected closure.',
    });
  }

  const passed =
    sourceRowsUnchanged &&
    targetRowsUnchanged &&
    supportRowsUnchanged &&
    affectedProcessesExact &&
    residue === 0 &&
    protectedClosureExact &&
    input.processScanComplete &&
    terminalProof &&
    issues.length === 0;
  const hardReadbackMismatch = issues.some(
    (issue) => issue.code !== 'FLOW_IDENTITY_TERMINAL_PROOF_NOT_CURRENT',
  );
  const reportStatus: FlowIdentityVerificationReport['status'] = passed
    ? 'passed'
    : input.status.status === 'derivatives_pending' && !hardReadbackMismatch
      ? 'pending'
      : 'failed';
  const terminalSha = input.status.terminal_proof_sha256;
  return {
    schema_version: 'dataset-flow-identity-verification-report.v1',
    generated_at_utc: new Date().toISOString(),
    status: reportStatus,
    plan_sha256: input.plan.plan_sha256,
    operation_id: input.plan.operation_id,
    scope_id: input.status.scope_id,
    database_status: input.status.status,
    terminal_proof_sha256: terminalSha,
    checks: {
      source_rows_unchanged: sourceRowsUnchanged,
      public_target_rows_unchanged: targetRowsUnchanged,
      support_rows_unchanged: supportRowsUnchanged,
      affected_processes_exact: affectedProcessesExact,
      approved_source_reference_residue: residue,
      protected_closure_exact: protectedClosureExact,
      complete_owner_draft_process_scan: input.processScanComplete,
      derivatives_causally_terminal: terminalProof,
    },
    counts: {
      source_rows: input.capture.source_rows.length,
      public_target_rows: input.capture.target_rows.length,
      support_rows: input.capture.support_rows.length,
      affected_processes: input.plan.processes.length,
      owner_draft_processes_scanned: input.currentOwnerDraftProcesses.length,
    },
    issues,
  };
}

async function fetchStableRows(options: {
  context: DatasetMaintenanceRemoteContext;
  snapshots: DatasetMaintenanceRowSnapshot[];
}): Promise<DatasetMaintenanceRemoteRow[]> {
  const result: DatasetMaintenanceRemoteRow[] = [];
  const concurrency = 10;
  for (let offset = 0; offset < options.snapshots.length; offset += concurrency) {
    const chunk = options.snapshots.slice(offset, offset + concurrency);
    const reads = await Promise.all(
      chunk.map(async (expected) => {
        const exact = await fetchMaintenanceExactRows({
          context: options.context,
          table: expected.table,
          id: expected.id,
          version: expected.version,
          includeJson: true,
        });
        const matching = exact.rows.filter(
          (row) => row.user_id === expected.user_id && row.state_code === expected.state_code,
        );
        if (matching.length !== 1) {
          fail(
            'A sealed source/public/support row is missing or ambiguous.',
            'DATASET_FLOW_IDENTITY_STABLE_ROW_READ_INVALID',
          );
        }
        return matching[0]!;
      }),
    );
    result.push(...reads);
  }
  return result;
}

export async function verifyFlowIdentity(
  options: VerifyFlowIdentityOptions,
): Promise<FlowIdentityVerificationReport> {
  const planPath = path.resolve(options.planPath);
  const prepared = prepareFlowIdentityExecution({
    plan: readCanonicalJson(planPath, 'Flow identity plan'),
    freeze: readCanonicalJson(options.freezePath, 'Flow identity freeze'),
    approval: readCanonicalJson(options.approvalPath, 'Flow identity approval'),
  });
  const capture = parseFlowIdentityCapture(
    readCanonicalJson(
      path.join(path.dirname(planPath), prepared.plan.artifacts.live_capture),
      'Flow identity live capture',
    ),
  );
  if (capture.capture_artifact_sha256 !== prepared.plan.capture_artifact_sha256) {
    fail('Live capture does not bind the plan.', 'DATASET_FLOW_IDENTITY_CAPTURE_MISMATCH');
  }
  const scope = parseFlowIdentityScopePreflightProof(
    readCanonicalJson(
      path.join(options.runDir, 'scope-preflight-proof.json'),
      'Flow identity scope preflight proof',
    ),
    prepared.plan,
  );
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  if (
    context.project_ref !== prepared.plan.project_ref ||
    context.account.user_id !== prepared.plan.account.user_id ||
    context.account.email.trim().toLowerCase() !== prepared.plan.account.email
  ) {
    fail(
      'Authenticated RLS context does not match the plan.',
      'DATASET_FLOW_IDENTITY_CONTEXT_MISMATCH',
    );
  }
  const rawStatus = await readMaintenanceFlowIdentityScope({ context, scopeId: scope.scope_id });
  const status = parseFlowIdentityScopeStatus(
    rawStatus,
    prepared.plan,
    scope.scope_id,
    scope.scope_proof_sha256,
  );
  const stableRows = await fetchStableRows({
    context,
    snapshots: [...capture.source_rows, ...capture.target_rows, ...capture.support_rows],
  });
  const processScan = await fetchMaintenanceAccountTableRows({
    context,
    userId: prepared.plan.account.user_id,
    table: 'processes',
    stateCode: 0,
    includeJson: true,
    pageSize: normalizeMaintenancePageSize(options.pageSize),
  });
  const generatedAt = options.now ?? new Date();
  const report = verifyFlowIdentityReadback({
    plan: prepared.plan,
    capture,
    status,
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: processScan.rows,
    processScanComplete:
      processScan.completeness.complete &&
      processScan.completeness.rows_fetched === processScan.rows.length,
  });
  report.generated_at_utc = generatedAt.toISOString();
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  writePrivateImmutableJson(path.join(outDir, 'flow-identity-verification-report.json'), report);
  return report;
}

export const __testInternals = {
  buildOccurrenceIndex,
  compareStableRows,
  currentKey,
  derivativeSetIsCausallyTerminal,
  processExchanges,
  jsonColumnsMatch,
  rowKey,
  snapshotKey,
  snapshotWithoutJson,
};
