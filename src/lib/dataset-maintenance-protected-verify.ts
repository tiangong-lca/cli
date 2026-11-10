import { loadMaintenanceDesiredPayload } from './dataset-maintenance-alias-request.js';
import {
  isJsonObject,
  maintenanceRowKey,
  snapshotRemoteRow,
} from './maintenance/contract/values.js';
import { sha256Json } from './canonical-json-hash.js';
import {
  type DatasetMaintenancePlan,
  type DatasetMaintenanceRemoteRow,
} from './maintenance/contract/types.js';
import {
  PROTECTED_EXECUTION_COUNTS,
  parseProtectedDerivativeSnapshot,
  type ProtectedDerivativeSnapshot,
  type ProtectedExecutionIdentity,
  type ProtectedExecutionStatusProof,
  type ProtectedReportStatus,
  type ProtectedTerminalTargetProof,
} from './dataset-maintenance-protected-contract.js';
import { maintenanceProjectedReferenceFingerprint } from './dataset-maintenance-plan.js';
import { isSnapshotCompletenessCompatible } from './dataset-maintenance-pagination.js';
import {
  fetchMaintenanceAccountRows,
  fetchMaintenanceDerivativeSnapshot,
  fetchMaintenanceDerivativeTargetRows,
  type DatasetMaintenanceDerivativeRemoteRow,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';

const SHA256 = /^[a-f0-9]{64}$/u;

export type ProtectedVerificationIssue = {
  code: string;
  message: string;
  details?: unknown;
};

export type ProtectedLiveDerivativeReadback = {
  table: 'flows' | 'processes';
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  json_ordered_sha256: string;
  extracted_md_present: true;
  embedding_ft_present: true;
  embedding_ft_at: string;
};

type ProtectedPrimaryActionEvidence = {
  action_id: string;
  table: 'flowproperties' | 'flows' | 'processes';
  id: string;
  version: string;
  row_found: true;
  owner_matches: true;
  state_code_matches: true;
  json_matches: true;
  json_ordered_matches: true;
  desired_json_ordered_sha256: string;
  live_json_sha256: string;
  live_json_ordered_sha256: string;
  valid: true;
};

export type ProtectedVerificationResult = {
  status: ProtectedReportStatus;
  issues: ProtectedVerificationIssue[];
  account_readback: {
    rows: DatasetMaintenanceRemoteRow[];
    source_urls: string[];
    completeness: unknown;
  } | null;
  derivative_readback: {
    rows: ProtectedLiveDerivativeReadback[];
    snapshots: ProtectedDerivativeSnapshot[];
    source_urls: string[];
  } | null;
};

function issue(code: string, message: string, details?: unknown): ProtectedVerificationIssue {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parsePrimaryActionEvidence(value: unknown): ProtectedPrimaryActionEvidence | null {
  if (!isJsonObject(value)) return null;
  const actionId = requiredString(value.action_id);
  const id = requiredString(value.id);
  const version = requiredString(value.version);
  const desiredJsonOrderedSha256 = requiredString(value.desired_json_ordered_sha256);
  const liveJsonSha256 = requiredString(value.live_json_sha256);
  const liveJsonOrderedSha256 = requiredString(value.live_json_ordered_sha256);
  if (
    !actionId ||
    (value.table !== 'flowproperties' && value.table !== 'flows' && value.table !== 'processes') ||
    !id ||
    !version ||
    value.row_found !== true ||
    value.owner_matches !== true ||
    value.state_code_matches !== true ||
    value.json_matches !== true ||
    value.json_ordered_matches !== true ||
    !desiredJsonOrderedSha256 ||
    !SHA256.test(desiredJsonOrderedSha256) ||
    !liveJsonSha256 ||
    !SHA256.test(liveJsonSha256) ||
    !liveJsonOrderedSha256 ||
    !SHA256.test(liveJsonOrderedSha256) ||
    value.valid !== true
  ) {
    return null;
  }
  return {
    action_id: actionId,
    table: value.table,
    id,
    version,
    row_found: true,
    owner_matches: true,
    state_code_matches: true,
    json_matches: true,
    json_ordered_matches: true,
    desired_json_ordered_sha256: desiredJsonOrderedSha256,
    live_json_sha256: liveJsonSha256,
    live_json_ordered_sha256: liveJsonOrderedSha256,
    valid: true,
  };
}

function indexPrimaryActionEvidence(options: {
  closure: unknown;
  plan: DatasetMaintenancePlan;
}): Map<string, ProtectedPrimaryActionEvidence> | null {
  if (!isJsonObject(options.closure) || !Array.isArray(options.closure.action_evidence)) {
    return null;
  }
  if (options.closure.action_evidence.length !== options.plan.actions.length) return null;
  const byKey = new Map<string, ProtectedPrimaryActionEvidence>();
  const actionIds = new Set<string>();
  for (const raw of options.closure.action_evidence) {
    const evidence = parsePrimaryActionEvidence(raw);
    if (!evidence) return null;
    const key = maintenanceRowKey(evidence);
    if (byKey.has(key) || actionIds.has(evidence.action_id)) return null;
    byKey.set(key, evidence);
    actionIds.add(evidence.action_id);
  }
  if (
    options.plan.actions.some(
      (action) => byKey.get(maintenanceRowKey(action))?.action_id !== action.action_id,
    )
  ) {
    return null;
  }
  return byKey;
}

export function inspectProtectedLiveDerivative(
  row: DatasetMaintenanceDerivativeRemoteRow,
): ProtectedLiveDerivativeReadback | null {
  const raw = row.raw;
  const jsonOrdered = isJsonObject(raw.json_ordered) ? raw.json_ordered : null;
  const extractedMd = requiredString(raw.extracted_md);
  const embeddingAt = requiredString(raw.embedding_ft_at);
  if (
    row.state_code !== 0 ||
    !jsonOrdered ||
    !extractedMd ||
    raw.embedding_ft === null ||
    raw.embedding_ft === undefined ||
    !embeddingAt ||
    !Number.isFinite(Date.parse(embeddingAt))
  ) {
    return null;
  }
  return {
    table: row.table,
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: 0 as const,
    json_ordered_sha256: sha256Json(jsonOrdered),
    extracted_md_present: true,
    embedding_ft_present: true,
    embedding_ft_at: embeddingAt,
  };
}

function expectedFinalRows(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  rows: DatasetMaintenanceRemoteRow[];
}): DatasetMaintenanceRemoteRow[] {
  const rows = new Map(options.rows.map((row) => [maintenanceRowKey(row), { ...row }]));
  for (const action of options.plan.actions) {
    const current = rows.get(maintenanceRowKey(action));
    if (current) {
      rows.set(maintenanceRowKey(action), {
        ...current,
        json_ordered: loadMaintenanceDesiredPayload(options.planDir, action),
      });
    }
  }
  return [...rows.values()].sort((left, right) =>
    maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)),
  );
}

function verifyStatusStructure(options: {
  identity: ProtectedExecutionIdentity;
  proof: ProtectedExecutionStatusProof;
}): ProtectedVerificationIssue[] {
  const { identity, proof } = options;
  const issues: ProtectedVerificationIssue[] = [];
  const notAdmitted = proof.execution_status === 'not_admitted';
  const dispatchCountValid =
    proof.dispatch_count === 1 ||
    (proof.dispatch_count === 0 &&
      (proof.execution_status === 'failed' || proof.execution_status === 'indeterminate'));
  if (
    (notAdmitted && (proof.attempt_count !== 0 || proof.dispatch_count !== 0)) ||
    (!notAdmitted && (proof.attempt_count !== 1 || !dispatchCountValid))
  ) {
    issues.push(
      issue(
        'PROTECTED_ATTEMPT_DISPATCH_COUNT_INVALID',
        'Database did not prove the one-attempt, at-most-one-dispatch execution policy.',
        { attempt_count: proof.attempt_count, dispatch_count: proof.dispatch_count },
      ),
    );
  }
  if (proof.plan_sha256 !== identity.plan_sha256 || proof.operation_id !== identity.operation_id) {
    issues.push(
      issue(
        'PROTECTED_EXECUTION_IDENTITY_MISMATCH',
        'Database status does not round-trip the sealed plan identity.',
      ),
    );
  }
  const categoryMatches =
    (proof.status === 'passed' && proof.execution_status === 'completed') ||
    (proof.status === 'failed' &&
      (proof.execution_status === 'failed' || proof.execution_status === 'completed')) ||
    (proof.status === 'indeterminate' &&
      (proof.execution_status === 'not_admitted' || proof.execution_status === 'indeterminate')) ||
    (proof.status === 'pending' &&
      ['dispatching', 'dispatched', 'running', 'derivatives_pending'].includes(
        proof.execution_status,
      ));
  if (!categoryMatches) {
    issues.push(
      issue(
        'PROTECTED_STATUS_CATEGORY_INVALID',
        'Database status category is inconsistent with its execution ledger state.',
        { status: proof.status, execution_status: proof.execution_status },
      ),
    );
  }
  if (!notAdmitted) {
    const gateNames = proof.gates.map((gate) => gate.gate);
    const receiptHashes = proof.gates.map((gate) => gate.receipt_sha256);
    const gateClosureValid =
      proof.gate_count === 3 &&
      proof.gates.length === 3 &&
      new Set(gateNames).size === 3 &&
      new Set(receiptHashes).size === 3 &&
      proof.gates.every(
        (gate) => gate.observed_sha256 === gate.expected_sha256 && gate.status === 'passed',
      );
    if (!gateClosureValid) {
      issues.push(
        issue(
          'PROTECTED_GATE_CLOSURE_INVALID',
          'Database did not round-trip three unique server-captured gate receipts.',
          proof.gates,
        ),
      );
    }
  }
  return issues;
}

function verifyAuditClosure(proof: ProtectedExecutionStatusProof): ProtectedVerificationIssue[] {
  const audit = proof.primary_readback;
  const closure = audit?.closure;
  let closureHashMatches = false;
  if (isJsonObject(closure) && typeof closure.live_closure_proof_sha256 === 'string') {
    const proofMaterial = { ...closure };
    const closureSha256 = String(proofMaterial.live_closure_proof_sha256);
    delete proofMaterial.ok;
    delete proofMaterial.row_count;
    delete proofMaterial.exchange_count;
    delete proofMaterial.live_closure_proof_sha256;
    closureHashMatches = sha256Json(proofMaterial) === closureSha256;
  }
  if (
    !audit ||
    audit.row_count !== PROTECTED_EXECUTION_COUNTS.action_count ||
    audit.exchange_count !== PROTECTED_EXECUTION_COUNTS.exchange_count ||
    audit.alias_audit_count !== PROTECTED_EXECUTION_COUNTS.audit_count ||
    audit.live_closure_proof !== true ||
    !isJsonObject(closure) ||
    closure.schema_version !== 'dataset-alias-primary-closure.v1' ||
    closure.ok !== true ||
    closure.actor_user_id !== proof.actor_user_id ||
    closure.batch_count !== PROTECTED_EXECUTION_COUNTS.batch_count ||
    closure.action_count !== PROTECTED_EXECUTION_COUNTS.action_count ||
    closure.distinct_action_count !== PROTECTED_EXECUTION_COUNTS.action_count ||
    closure.flowproperty_count !== PROTECTED_EXECUTION_COUNTS.flowproperty_count ||
    closure.flow_count !== PROTECTED_EXECUTION_COUNTS.flow_count ||
    closure.process_count !== PROTECTED_EXECUTION_COUNTS.process_count ||
    closure.support_reference_count !== 6 ||
    closure.flowproperty_support_count !== 2 ||
    closure.unitgroup_support_count !== 2 ||
    closure.source_unitgroup_support_count !== 2 ||
    closure.invalid_action_count !== 0 ||
    closure.invalid_support_count !== 0 ||
    !Array.isArray(closure.action_evidence) ||
    closure.action_evidence.length !== PROTECTED_EXECUTION_COUNTS.action_count ||
    closure.action_evidence.some((entry) => !isJsonObject(entry)) ||
    !Array.isArray(closure.support_evidence) ||
    closure.support_evidence.length !== 6 ||
    closure.support_evidence.some((entry) => !isJsonObject(entry)) ||
    closure.row_count !== PROTECTED_EXECUTION_COUNTS.action_count ||
    closure.exchange_count !== PROTECTED_EXECUTION_COUNTS.exchange_count ||
    closure.live_closure_proof !== true ||
    !closureHashMatches
  ) {
    return [
      issue(
        'PROTECTED_AUDIT_CLOSURE_INVALID',
        'Terminal execution did not prove the exact 52-row, 59-exchange, 55-audit primary closure.',
        audit,
      ),
    ];
  }
  return [];
}

function terminalTargetKey(target: { table: string; id: string; version: string }): string {
  return `${target.table}\u0000${target.id}\u0000${target.version}`;
}

function verifyTerminalTargets(options: {
  identity: ProtectedExecutionIdentity;
  proof: ProtectedExecutionStatusProof;
}): ProtectedVerificationIssue[] {
  const issues: ProtectedVerificationIssue[] = [];
  const batch = options.proof.derivative_readback;
  if (batch.proof_level !== 'causal_terminal' || batch.proof_deferred !== false) {
    return [
      issue(
        'PROTECTED_DERIVATIVE_TARGET_CLOSURE_INVALID',
        'Terminal proof must use the full causal-terminal evidence level.',
      ),
    ];
  }
  const targets = batch.targets;
  const keys = targets.map(terminalTargetKey);
  if (
    batch.schema_version !== 'dataset-derivative-rebuild-batch-status.v1' ||
    batch.batch_id !== options.identity.request_id ||
    batch.status !== 'completed' ||
    batch.code !== 'DERIVATIVE_BATCH_COMPLETED' ||
    batch.causal_terminal_proof !== true ||
    batch.target_count !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    batch.flow_count !== PROTECTED_EXECUTION_COUNTS.flow_count ||
    batch.process_count !== PROTECTED_EXECUTION_COUNTS.process_count ||
    batch.completed_count !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    batch.nonterminal_count !== 0 ||
    batch.failed_count !== 0 ||
    batch.invalid_proof_count !== 0 ||
    targets.length !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    new Set(keys).size !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    new Set(targets.map((target) => target.ordinal)).size !==
      PROTECTED_EXECUTION_COUNTS.derivative_target_count
  ) {
    return [
      issue(
        'PROTECTED_DERIVATIVE_TARGET_CLOSURE_INVALID',
        'Terminal proof must contain exactly 50 unique derivative targets.',
      ),
    ];
  }
  const frozen = new Map(
    options.identity.derivative_targets.map((target) => [terminalTargetKey(target), target]),
  );
  for (const [index, target] of targets.entries()) {
    const expected = frozen.get(terminalTargetKey(target));
    if (
      !expected ||
      target.ordinal !== index + 1 ||
      target.request_id === options.identity.request_id ||
      target.source_baseline_snapshot_sha256 !== expected.baseline_snapshot_sha256
    ) {
      issues.push(
        issue(
          'PROTECTED_DERIVATIVE_TARGET_IDENTITY_MISMATCH',
          'Terminal derivative proof contains a foreign or changed target.',
          { table: target.table, id: target.id, version: target.version },
        ),
      );
      continue;
    }
    if (
      target.status !== 'completed' ||
      !target.phase ||
      !target.completed_snapshot_sha256 ||
      !SHA256.test(target.expected_snapshot_sha256) ||
      !SHA256.test(target.completed_snapshot_sha256) ||
      target.completed_snapshot_sha256 === target.expected_snapshot_sha256 ||
      !target.primary_matches ||
      !target.terminal_snapshot_matches ||
      !target.proposals_committed ||
      !target.derivative_fresh ||
      !target.lifecycle_complete ||
      !target.terminal_audit_present ||
      Object.values(target.residue).some((count) => count !== 0) ||
      !target.causal_terminal_proof
    ) {
      issues.push(
        issue(
          'PROTECTED_DERIVATIVE_TARGET_NOT_TERMINAL',
          'Derivative target lacks causal completed/live equality or retains queue, failure, or fence state.',
          { table: target.table, id: target.id, version: target.version },
        ),
      );
    }
  }
  return issues;
}

function verifyFinalAccountRows(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  rows: DatasetMaintenanceRemoteRow[];
  completeness: unknown;
}): ProtectedVerificationIssue[] {
  const issues: ProtectedVerificationIssue[] = [];
  if (
    !options.plan.snapshot_completeness ||
    !isSnapshotCompletenessCompatible(
      options.completeness,
      options.plan.snapshot_completeness,
      Object.keys(options.plan.snapshot_completeness.entity_counts),
    )
  ) {
    issues.push(
      issue(
        'PROTECTED_FINAL_SNAPSHOT_INCOMPLETE',
        'Final RLS account scan does not prove the same complete table census as the plan.',
      ),
    );
    return issues;
  }
  const expectedKeys = new Set([
    ...options.plan.actions.map(maintenanceRowKey),
    ...options.plan.protected_rows.map(maintenanceRowKey),
  ]);
  const actualKeys = new Set(options.rows.map(maintenanceRowKey));
  if (
    expectedKeys.size !== actualKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    issues.push(
      issue(
        'PROTECTED_FINAL_ACCOUNT_CENSUS_DRIFT',
        'Final RLS account rows contain missing or unexpected entities.',
      ),
    );
  }
  const current = new Map(options.rows.map((row) => [maintenanceRowKey(row), row]));
  for (const protectedRow of options.plan.protected_rows) {
    const row = current.get(maintenanceRowKey(protectedRow));
    if (!row || snapshotRemoteRow(row).row_sha256 !== protectedRow.row_sha256) {
      issues.push(
        issue('PROTECTED_ROW_DRIFT', 'A protected non-action row changed.', protectedRow),
      );
    }
  }
  for (const action of options.plan.actions) {
    const row = current.get(maintenanceRowKey(action));
    const desired = loadMaintenanceDesiredPayload(options.planDir, action);
    if (
      !row ||
      row.user_id !== action.expected_user_id ||
      row.state_code !== 0 ||
      sha256Json(row.json_ordered) !== sha256Json(desired) ||
      row.model_id !== action.before?.model_id ||
      row.rule_verification !== action.before?.rule_verification
    ) {
      issues.push(
        issue(
          'PROTECTED_ACTION_READBACK_MISMATCH',
          'An action row does not match the desired owner-draft payload.',
          { action_id: action.action_id },
        ),
      );
    }
  }
  const projected = expectedFinalRows({
    plan: options.plan,
    planDir: options.planDir,
    rows: options.rows,
  });
  if (
    sha256Json(maintenanceProjectedReferenceFingerprint(projected)) !==
    options.plan.projected_reference_sha256
  ) {
    issues.push(
      issue(
        'PROTECTED_REFERENCE_CLOSURE_MISMATCH',
        'Final reference closure does not match the frozen projected closure.',
      ),
    );
  }
  return issues;
}

function matchLiveTargets(options: {
  proofs: ProtectedTerminalTargetProof[];
  live: ProtectedLiveDerivativeReadback[];
  snapshots: ProtectedDerivativeSnapshot[];
  primaryClosure: unknown;
  plan: DatasetMaintenancePlan;
  identity: ProtectedExecutionIdentity;
}): ProtectedVerificationIssue[] {
  const proofs = new Map(options.proofs.map((proof) => [terminalTargetKey(proof), proof]));
  const snapshots = new Map(
    options.snapshots.map((snapshot) => [terminalTargetKey(snapshot), snapshot]),
  );
  const live = new Map(options.live.map((row) => [terminalTargetKey(row), row]));
  const actions = new Map(
    options.plan.actions.map((action) => [maintenanceRowKey(action), action]),
  );
  const primaryEvidence = indexPrimaryActionEvidence({
    closure: options.primaryClosure,
    plan: options.plan,
  });
  const issues: ProtectedVerificationIssue[] = [];
  const expectedKeys = new Set(options.identity.derivative_targets.map(terminalTargetKey));
  const liveKeys = options.live.map(terminalTargetKey);
  const snapshotKeys = options.snapshots.map(terminalTargetKey);
  if (
    liveKeys.length !== expectedKeys.size ||
    new Set(liveKeys).size !== expectedKeys.size ||
    snapshotKeys.length !== expectedKeys.size ||
    new Set(snapshotKeys).size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !live.has(key) || !snapshots.has(key))
  ) {
    issues.push(
      issue(
        'PROTECTED_DERIVATIVE_LIVE_SET_MISMATCH',
        'Independent derivative rows and snapshots must be unique and exactly match all 50 frozen targets.',
      ),
    );
  }
  for (const target of options.identity.derivative_targets) {
    const key = terminalTargetKey(target);
    const row = live.get(key);
    const proof = proofs.get(key);
    const snapshot = snapshots.get(key);
    const action = actions.get(key);
    const evidence = primaryEvidence?.get(key);
    if (
      !row ||
      !proof ||
      !snapshot ||
      !action?.desired_payload ||
      !evidence ||
      row.user_id !== options.identity.actor.user_id ||
      row.state_code !== 0 ||
      snapshot.user_id !== options.identity.actor.user_id ||
      snapshot.state_code !== 0 ||
      row.json_ordered_sha256 !== action.desired_payload.sha256 ||
      evidence.live_json_sha256 !== evidence.desired_json_ordered_sha256 ||
      evidence.live_json_ordered_sha256 !== evidence.desired_json_ordered_sha256 ||
      snapshot.json_ordered_sha256 !== evidence.desired_json_ordered_sha256 ||
      snapshot.snapshot_sha256 !== proof.completed_snapshot_sha256 ||
      !snapshot.extracted_md_sha256 ||
      !snapshot.embedding_ft_sha256 ||
      !snapshot.embedding_ft_at
    ) {
      issues.push(
        issue(
          'PROTECTED_DERIVATIVE_LIVE_MISMATCH',
          'Independent RLS derivative readback does not match the terminal database proof.',
          { table: target.table, id: target.id, version: target.version },
        ),
      );
    }
  }
  return issues;
}

async function fetchProtectedDerivativeSnapshots(options: {
  context: DatasetMaintenanceRemoteContext;
  identity: ProtectedExecutionIdentity;
}): Promise<ProtectedDerivativeSnapshot[]> {
  const snapshots: ProtectedDerivativeSnapshot[] = [];
  const targets = options.identity.derivative_targets;
  for (let offset = 0; offset < targets.length; offset += 5) {
    const chunk = targets.slice(offset, offset + 5);
    snapshots.push(
      ...(await Promise.all(
        chunk.map(async (target) =>
          parseProtectedDerivativeSnapshot(
            await fetchMaintenanceDerivativeSnapshot({
              context: options.context,
              table: target.table,
              id: target.id,
              version: target.version,
            }),
            {
              table: target.table,
              id: target.id,
              version: target.version,
              userId: target.user_id,
            },
          ),
        ),
      )),
    );
  }
  return snapshots;
}

type ProtectedVerificationDependencies = {
  fetchAccountRows: typeof fetchMaintenanceAccountRows;
  fetchDerivativeRows: typeof fetchMaintenanceDerivativeTargetRows;
  fetchSnapshots: typeof fetchProtectedDerivativeSnapshots;
};

async function verifyProtectedExecutionWithDependencies(
  options: {
    plan: DatasetMaintenancePlan;
    planDir: string;
    identity: ProtectedExecutionIdentity;
    proof: ProtectedExecutionStatusProof;
    context: DatasetMaintenanceRemoteContext;
    pageSize?: number;
  },
  dependencies: ProtectedVerificationDependencies,
): Promise<ProtectedVerificationResult> {
  const { fetchAccountRows, fetchDerivativeRows, fetchSnapshots } = dependencies;
  const structuralIssues = verifyStatusStructure({
    identity: options.identity,
    proof: options.proof,
  });
  if (structuralIssues.length) {
    return {
      status: options.proof.status === 'indeterminate' ? 'indeterminate' : 'failed',
      issues: structuralIssues,
      account_readback: null,
      derivative_readback: null,
    };
  }
  if (options.proof.execution_status === 'not_admitted') {
    return {
      status: 'indeterminate',
      issues: [
        issue(
          'PROTECTED_EXECUTION_NOT_FOUND',
          'The server has a protected preflight but no admitted execution; admission must not be retried.',
        ),
      ],
      account_readback: null,
      derivative_readback: null,
    };
  }
  if (options.proof.status === 'pending') {
    return { status: 'pending', issues: [], account_readback: null, derivative_readback: null };
  }
  if (options.proof.status === 'indeterminate') {
    return {
      status: 'indeterminate',
      issues: [
        issue(
          'PROTECTED_EXECUTION_INDETERMINATE',
          'Database reported an indeterminate terminal execution; admission must not be retried.',
          options.proof.failure,
        ),
      ],
      account_readback: null,
      derivative_readback: null,
    };
  }
  if (options.proof.status === 'failed') {
    return {
      status: 'failed',
      issues: [
        issue(
          'PROTECTED_EXECUTION_FAILED',
          'Database reported a definitive protected execution failure.',
          options.proof.failure,
        ),
      ],
      account_readback: null,
      derivative_readback: null,
    };
  }

  const issues = [
    ...verifyAuditClosure(options.proof),
    ...verifyTerminalTargets({ identity: options.identity, proof: options.proof }),
  ];
  if (issues.length) {
    return { status: 'failed', issues, account_readback: null, derivative_readback: null };
  }
  const account = await fetchAccountRows({
    context: options.context,
    userId: options.identity.actor.user_id,
    pageSize: options.pageSize,
  });
  issues.push(
    ...verifyFinalAccountRows({
      plan: options.plan,
      planDir: options.planDir,
      rows: account.rows,
      completeness: account.completeness,
    }),
  );
  const derivative = await fetchDerivativeRows({
    context: options.context,
    targets: options.identity.derivative_targets,
  });
  const live = derivative.rows.map(inspectProtectedLiveDerivative);
  if (live.some((row) => row === null)) {
    issues.push(
      issue(
        'PROTECTED_DERIVATIVE_LIVE_INVALID',
        'A live derivative row lacks primary JSON, extracted markdown, embedding, or timestamps.',
      ),
    );
  }
  const validLive = live.filter((row): row is ProtectedLiveDerivativeReadback => row !== null);
  const snapshots = await fetchSnapshots({
    context: options.context,
    identity: options.identity,
  });
  if (validLive.length === PROTECTED_EXECUTION_COUNTS.derivative_target_count) {
    const terminalProofs =
      options.proof.derivative_readback.proof_level === 'causal_terminal'
        ? options.proof.derivative_readback.targets
        : [];
    issues.push(
      ...matchLiveTargets({
        proofs: terminalProofs,
        live: validLive,
        snapshots,
        primaryClosure: options.proof.primary_readback?.closure,
        plan: options.plan,
        identity: options.identity,
      }),
    );
  }
  return {
    status: issues.length ? 'failed' : 'passed',
    issues,
    account_readback: {
      rows: account.rows,
      source_urls: account.source_urls,
      completeness: account.completeness,
    },
    derivative_readback: {
      rows: validLive,
      snapshots,
      source_urls: derivative.source_urls,
    },
  };
}

export async function verifyProtectedExecution(options: {
  plan: DatasetMaintenancePlan;
  planDir: string;
  identity: ProtectedExecutionIdentity;
  proof: ProtectedExecutionStatusProof;
  context: DatasetMaintenanceRemoteContext;
  pageSize?: number;
}): Promise<ProtectedVerificationResult> {
  return verifyProtectedExecutionWithDependencies(options, {
    fetchAccountRows: fetchMaintenanceAccountRows,
    fetchDerivativeRows: fetchMaintenanceDerivativeTargetRows,
    fetchSnapshots: fetchProtectedDerivativeSnapshots,
  });
}

export const __testInternals = {
  expectedFinalRows,
  fetchProtectedDerivativeSnapshots,
  inspectProtectedLiveDerivative,
  matchLiveTargets,
  verifyAuditClosure,
  verifyFinalAccountRows,
  verifyStatusStructure,
  verifyTerminalTargets,
  verifyProtectedExecutionWithDependencies,
};
