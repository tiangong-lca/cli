import { CliError } from '../shared/errors.js';
import { computePlanSha256 } from './dataset-maintenance-contract.js';
import { sha256Json, sha256Text, stableJsonText } from './canonical-json-hash.js';
import { isJsonObject } from './maintenance/contract/values.js';
import { type DatasetMaintenancePlan, type JsonObject } from './maintenance/contract/types.js';
import {
  PROTECTED_EXECUTION_CONTRACT,
  PROTECTED_EXECUTION_COUNTS,
  assertProtectedFreezeMatchesPlan,
  computeProtectedApprovalIdentitySha256,
  computeProtectedFreezeSha256,
  parseProtectedApproval,
  parseProtectedFreeze,
  protectedDerivativeBaselineSetSha256,
  protectedPlanSetHashes,
  type DatasetMaintenanceProtectedApproval,
  type DatasetMaintenanceProtectedFreeze,
  type ProtectedDerivativeSnapshot,
  type ProtectedDerivativeTarget,
} from './dataset-maintenance-protected-contract.js';

export const PROTECTED_PREPARATION_CONTRACT = {
  approval_request_schema: 'dataset-alias-execution-approval-request.v1',
} as const;

export const PROTECTED_PRODUCTION_PROJECT_REF = 'qgzvkongdjqiiamzbbts' as const;

export const PROTECTED_PREPARATION_REJECTED_PLAN_SHA256 = [
  '813a201ded0443c79639cfbdb8f5a2fad8a8781ef6edd3ec7019e9a45f5f33ce',
  '673331422e8dceeb7975984b07276f057b37e8d6de789d7f030ec29f3be29629',
  '7fdf7e2755599d426e31a9955985d54d5b7cef1adeaa7a10dcc7186353a6c3a8',
] as const;

const SHA256 = /^[a-f0-9]{64}$/u;

type ProtectedApprovalRequestCore = {
  schema_version: typeof PROTECTED_PREPARATION_CONTRACT.approval_request_schema;
  approved_at_utc: string;
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  plan: DatasetMaintenanceProtectedFreeze['plan'];
  freeze_file_sha256: string;
  freeze_sha256: string;
  sets: DatasetMaintenanceProtectedFreeze['sets'];
  expected: typeof PROTECTED_EXECUTION_COUNTS;
  policy: DatasetMaintenanceProtectedFreeze['policy'];
};

export type DatasetMaintenanceProtectedApprovalRequest = ProtectedApprovalRequestCore & {
  request_sha256: string;
  approval_text: string;
  approval_text_sha256: string;
};

export type CanonicalProtectedArtifact<T> = {
  value: T;
  canonical_file_text: string;
  file_sha256: string;
};

export type BuiltProtectedFreeze = CanonicalProtectedArtifact<DatasetMaintenanceProtectedFreeze> & {
  alias_plan_request_sha256: string;
};

export type BuiltProtectedApprovalRequest =
  CanonicalProtectedArtifact<DatasetMaintenanceProtectedApprovalRequest>;

export type BuiltProtectedApproval =
  CanonicalProtectedArtifact<DatasetMaintenanceProtectedApproval>;

export type ProtectedDerivativeSnapshotTarget = Omit<
  ProtectedDerivativeTarget,
  'baseline_snapshot_sha256'
>;

function fail(message: string): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_PROTECTED_PREPARATION_INVALID',
    exitCode: 2,
  });
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(', ')}.`);
  }
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    fail(`${label} must be a non-empty canonical string.`);
  }
  return value;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty byte-exact string.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const digest = token(value, label);
  if (!SHA256.test(digest)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return digest;
}

export function assertProtectedPreparationPlanSha256(
  value: unknown,
  label = 'plan_sha256',
): string {
  const digest = hash(value, label);
  if ((PROTECTED_PREPARATION_REJECTED_PLAN_SHA256 as readonly string[]).includes(digest)) {
    fail(`${label} is a historical superseded plan and cannot be prepared or approved.`);
  }
  return digest;
}

export function assertProtectedProductionProjectRef(value: unknown): string {
  const projectRef = token(value, 'project_ref');
  if (projectRef !== PROTECTED_PRODUCTION_PROJECT_REF) {
    fail('Protected BAFU preparation and commit are restricted to the production project.');
  }
  return projectRef;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = token(value, label);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return timestamp;
}

function timestamp(value: unknown, label: string): string {
  const result = token(value, label);
  if (!Number.isFinite(Date.parse(result))) fail(`${label} must be an ISO timestamp.`);
  return result;
}

function account(value: unknown, label: string): { user_id: string; email: string } {
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  exactKeys(value, ['user_id', 'email'], label);
  return {
    user_id: token(value.user_id, `${label}.user_id`),
    email: token(value.email, `${label}.email`),
  };
}

function planBinding(value: unknown): DatasetMaintenanceProtectedFreeze['plan'] {
  if (!isJsonObject(value)) fail('plan must be an object.');
  exactKeys(value, ['plan_file_sha256', 'plan_sha256', 'operation_id'], 'plan');
  return {
    plan_file_sha256: hash(value.plan_file_sha256, 'plan.plan_file_sha256'),
    plan_sha256: assertProtectedPreparationPlanSha256(value.plan_sha256, 'plan.plan_sha256'),
    operation_id: token(value.operation_id, 'plan.operation_id'),
  };
}

function freezeSets(value: unknown): DatasetMaintenanceProtectedFreeze['sets'] {
  if (!isJsonObject(value)) fail('sets must be an object.');
  const keys = [
    'alias_plan_request_sha256',
    'before_hash_set_sha256',
    'desired_hash_set_sha256',
    'exchange_rewrite_set_sha256',
    'support_snapshot_set_sha256',
    'derivative_baseline_set_sha256',
    'derivative_target_set_sha256',
    'toolchain_evidence_sha256',
  ] as const;
  exactKeys(value, keys, 'sets');
  return Object.fromEntries(
    keys.map((key) => [key, hash(value[key], `sets.${key}`)]),
  ) as DatasetMaintenanceProtectedFreeze['sets'];
}

function expectedCounts(value: unknown): typeof PROTECTED_EXECUTION_COUNTS {
  if (!isJsonObject(value)) fail('expected must be an object.');
  const keys = Object.keys(PROTECTED_EXECUTION_COUNTS);
  exactKeys(value, keys, 'expected');
  for (const [key, expected] of Object.entries(PROTECTED_EXECUTION_COUNTS)) {
    if (value[key] !== expected) fail(`expected.${key} must equal ${expected}.`);
  }
  return PROTECTED_EXECUTION_COUNTS;
}

function freezePolicy(value: unknown): DatasetMaintenanceProtectedFreeze['policy'] {
  if (!isJsonObject(value)) fail('policy must be an object.');
  const keys = [
    'state_code_changes',
    'save_draft',
    'deletes',
    'rebuild_derivatives',
    'unitgroup_actions',
    'person_distance_actions',
    'max_admit_posts',
    'automatic_retry',
  ] as const;
  exactKeys(value, keys, 'policy');
  if (
    value.state_code_changes !== 0 ||
    value.save_draft !== 0 ||
    value.deletes !== 0 ||
    value.rebuild_derivatives !== 0 ||
    value.unitgroup_actions !== 0 ||
    value.person_distance_actions !== 0 ||
    value.max_admit_posts !== 1 ||
    value.automatic_retry !== false
  ) {
    fail('policy must preserve the one-shot owner-draft execution boundary.');
  }
  return {
    state_code_changes: 0,
    save_draft: 0,
    deletes: 0,
    rebuild_derivatives: 0,
    unitgroup_actions: 0,
    person_distance_actions: 0,
    max_admit_posts: 1,
    automatic_retry: false,
  };
}

function canonicalArtifact<T>(value: T): CanonicalProtectedArtifact<T> {
  const canonicalFileText = `${stableJsonText(value)}\n`;
  return {
    value,
    canonical_file_text: canonicalFileText,
    file_sha256: sha256Text(canonicalFileText),
  };
}

function approvalRequestCore(
  freeze: DatasetMaintenanceProtectedFreeze,
  freezeFileSha256: string,
  approvedAtUtc: string,
): ProtectedApprovalRequestCore {
  assertProtectedPreparationPlanSha256(freeze.plan.plan_sha256, 'freeze.plan.plan_sha256');
  const freezeFileDigest = hash(freezeFileSha256, 'freeze_file_sha256');
  if (freezeFileDigest !== canonicalArtifact(freeze).file_sha256) {
    fail('freeze_file_sha256 does not match the canonical freeze artifact bytes.');
  }
  return {
    schema_version: PROTECTED_PREPARATION_CONTRACT.approval_request_schema,
    approved_at_utc: canonicalTimestamp(approvedAtUtc, 'approved_at_utc'),
    environment: 'production',
    project_ref: assertProtectedProductionProjectRef(freeze.project_ref),
    account: freeze.account,
    target_visibility: 'owner_draft',
    plan: freeze.plan,
    freeze_file_sha256: freezeFileDigest,
    freeze_sha256: freeze.freeze_sha256,
    sets: freeze.sets,
    expected: PROTECTED_EXECUTION_COUNTS,
    policy: freeze.policy,
  };
}

export function renderProtectedApprovalText(
  core: ProtectedApprovalRequestCore,
  requestSha256: string,
): string {
  const requestHash = hash(requestSha256, 'request_sha256');
  return [
    'BAFU protected owner-draft execution approval request',
    `schema_version=${core.schema_version}`,
    `approved_at_utc=${core.approved_at_utc}`,
    `request_sha256=${requestHash}`,
    `environment=${core.environment}`,
    `project_ref=${core.project_ref}`,
    `account_email=${core.account.email}`,
    `account_user_id=${core.account.user_id}`,
    `target_visibility=${core.target_visibility}`,
    `plan_sha256=${core.plan.plan_sha256}`,
    `operation_id=${core.plan.operation_id}`,
    `plan_file_sha256=${core.plan.plan_file_sha256}`,
    `freeze_file_sha256=${core.freeze_file_sha256}`,
    `freeze_sha256=${core.freeze_sha256}`,
    `alias_plan_request_sha256=${core.sets.alias_plan_request_sha256}`,
    `before_hash_set_sha256=${core.sets.before_hash_set_sha256}`,
    `desired_hash_set_sha256=${core.sets.desired_hash_set_sha256}`,
    `exchange_rewrite_set_sha256=${core.sets.exchange_rewrite_set_sha256}`,
    `support_snapshot_set_sha256=${core.sets.support_snapshot_set_sha256}`,
    `derivative_baseline_set_sha256=${core.sets.derivative_baseline_set_sha256}`,
    `derivative_target_set_sha256=${core.sets.derivative_target_set_sha256}`,
    `toolchain_evidence_sha256=${core.sets.toolchain_evidence_sha256}`,
    `action_count=${core.expected.action_count}`,
    `batch_count=${core.expected.batch_count}`,
    `exchange_count=${core.expected.exchange_count}`,
    `amount_field_count=${core.expected.amount_field_count}`,
    `unrelated_exchange_count=${core.expected.unrelated_exchange_count}`,
    `audit_count=${core.expected.audit_count}`,
    `flowproperty_count=${core.expected.flowproperty_count}`,
    `flow_count=${core.expected.flow_count}`,
    `process_count=${core.expected.process_count}`,
    `derivative_target_count=${core.expected.derivative_target_count}`,
    `state_code_changes=${core.policy.state_code_changes}`,
    `save_draft=${core.policy.save_draft}`,
    `deletes=${core.policy.deletes}`,
    `rebuild_derivatives=${core.policy.rebuild_derivatives}`,
    `unitgroup_actions=${core.policy.unitgroup_actions}`,
    `person_distance_actions=${core.policy.person_distance_actions}`,
    `max_admit_posts=${core.policy.max_admit_posts}`,
    `automatic_retry=${String(core.policy.automatic_retry)}`,
    'Approve only by returning this text byte-for-byte without edits.',
    '',
  ].join('\n');
}

export function parseProtectedApprovalRequest(
  value: unknown,
): DatasetMaintenanceProtectedApprovalRequest {
  if (!isJsonObject(value)) fail('Approval request must be an object.');
  exactKeys(
    value,
    [
      'schema_version',
      'approved_at_utc',
      'environment',
      'project_ref',
      'account',
      'target_visibility',
      'plan',
      'freeze_file_sha256',
      'freeze_sha256',
      'sets',
      'expected',
      'policy',
      'request_sha256',
      'approval_text',
      'approval_text_sha256',
    ],
    'approval_request',
  );
  if (
    value.schema_version !== PROTECTED_PREPARATION_CONTRACT.approval_request_schema ||
    value.environment !== 'production' ||
    value.target_visibility !== 'owner_draft'
  ) {
    fail('Approval request must be the production owner-draft v1 contract.');
  }
  const core: ProtectedApprovalRequestCore = {
    schema_version: PROTECTED_PREPARATION_CONTRACT.approval_request_schema,
    approved_at_utc: canonicalTimestamp(value.approved_at_utc, 'approved_at_utc'),
    environment: 'production',
    project_ref: token(value.project_ref, 'project_ref'),
    account: account(value.account, 'account'),
    target_visibility: 'owner_draft',
    plan: planBinding(value.plan),
    freeze_file_sha256: hash(value.freeze_file_sha256, 'freeze_file_sha256'),
    freeze_sha256: hash(value.freeze_sha256, 'freeze_sha256'),
    sets: freezeSets(value.sets),
    expected: expectedCounts(value.expected),
    policy: freezePolicy(value.policy),
  };
  const requestSha256 = hash(value.request_sha256, 'request_sha256');
  if (sha256Json(core) !== requestSha256) {
    fail('request_sha256 does not match the canonical approval-request core.');
  }
  const approvalText = exactText(value.approval_text, 'approval_text');
  const expectedText = renderProtectedApprovalText(core, requestSha256);
  if (approvalText !== expectedText) {
    fail('approval_text is not the byte-exact canonical request text.');
  }
  const approvalTextSha256 = hash(value.approval_text_sha256, 'approval_text_sha256');
  if (sha256Text(approvalText) !== approvalTextSha256) {
    fail('approval_text_sha256 does not match the byte-exact approval text.');
  }
  return {
    ...core,
    request_sha256: requestSha256,
    approval_text: approvalText,
    approval_text_sha256: approvalTextSha256,
  };
}

function assertAliasPlanRequest(plan: DatasetMaintenancePlan, value: JsonObject): void {
  if (
    value.schema_version !== 'dataset-alias-plan.v1' ||
    value.plan_sha256 !== plan.plan_sha256 ||
    value.operation_id !== plan.operation_id ||
    value.target_visibility !== 'owner_draft' ||
    !Array.isArray(value.batches) ||
    value.batches.length !== 2
  ) {
    fail('Alias plan request does not bind the exact owner-draft maintenance plan.');
  }
  const dimensions = ['time', 'length_time'];
  for (const [index, batch] of value.batches.entries()) {
    if (
      !isJsonObject(batch) ||
      batch.plan_sha256 !== plan.plan_sha256 ||
      batch.operation_id !== plan.operation_id ||
      batch.target_visibility !== 'owner_draft' ||
      batch.dimension !== dimensions[index]
    ) {
      fail('Alias plan request batches must be exact ordered plan-bound time/length_time batches.');
    }
  }
}

export function deriveProtectedDerivativeSnapshotTargets(
  plan: DatasetMaintenancePlan,
  expectedAccount: { user_id: string; email: string },
): ProtectedDerivativeSnapshotTarget[] {
  const preparedAccount = account(expectedAccount, 'account');
  assertProtectedPreparationPlanSha256(plan.plan_sha256, 'plan.plan_sha256');
  if (
    plan.operation !== 'merge-support-aliases' ||
    plan.status !== 'ready' ||
    plan.target_mode !== 'owner_draft' ||
    plan.blockers.length !== 0 ||
    plan.account.user_id !== preparedAccount.user_id ||
    plan.account.email !== preparedAccount.email ||
    computePlanSha256(plan) !== plan.plan_sha256
  ) {
    fail('Derivative target derivation requires the exact canonical owner-draft plan and account.');
  }
  const actions = plan.actions
    .filter((action) => action.table === 'flows' || action.table === 'processes')
    .sort(
      (left, right) =>
        left.table.localeCompare(right.table) ||
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version),
    );
  if (
    actions.length !== PROTECTED_EXECUTION_COUNTS.derivative_target_count ||
    actions.filter((action) => action.table === 'flows').length !==
      PROTECTED_EXECUTION_COUNTS.flow_count ||
    actions.filter((action) => action.table === 'processes').length !==
      PROTECTED_EXECUTION_COUNTS.process_count ||
    actions.some(
      (action) =>
        action.expected_user_id !== preparedAccount.user_id || action.expected_state_code !== 0,
    )
  ) {
    fail('Plan derivative targets must contain exactly 23 owner-draft flows and 27 processes.');
  }
  const targets = actions.map((action) => ({
    table: action.table as 'flows' | 'processes',
    id: action.id,
    version: action.version,
    user_id: action.expected_user_id,
    state_code: 0 as const,
  }));
  const keys = targets.map((target) => `${target.table}\u0000${target.id}\u0000${target.version}`);
  if (new Set(keys).size !== targets.length) {
    fail('Plan derivative targets must not contain duplicate table/id/version identities.');
  }
  return targets;
}

function derivativeTargets(options: {
  plan: DatasetMaintenancePlan;
  account: { user_id: string; email: string };
  snapshots: ProtectedDerivativeSnapshot[];
}): ProtectedDerivativeTarget[] {
  const actions = deriveProtectedDerivativeSnapshotTargets(options.plan, options.account);
  if (options.snapshots.length !== actions.length) {
    fail('Derivative actions and snapshots must form one exact 50-target set without duplicates.');
  }
  return actions.map((action, index) => {
    const snapshot: unknown = options.snapshots[index];
    if (
      !isJsonObject(snapshot) ||
      snapshot.schema_version !== 'dataset-derivative-snapshot.v1' ||
      snapshot.table !== action.table ||
      snapshot.id !== action.id ||
      snapshot.version !== action.version ||
      snapshot.user_id !== action.user_id ||
      snapshot.state_code !== 0
    ) {
      fail(`Derivative snapshot ${index} does not match the stable target order and identity.`);
    }
    exactKeys(
      snapshot,
      [
        'schema_version',
        'table',
        'id',
        'version',
        'user_id',
        'state_code',
        'modified_at',
        'json_sha256',
        'json_ordered_sha256',
        'extracted_md_sha256',
        'embedding_ft_sha256',
        'embedding_ft_at',
        'snapshot_sha256',
      ],
      `derivativeSnapshots[${index}]`,
    );
    timestamp(snapshot.modified_at, `derivativeSnapshots[${index}].modified_at`);
    const jsonSha256 = hash(snapshot.json_sha256, `derivativeSnapshots[${index}].json_sha256`);
    const jsonOrderedSha256 = hash(
      snapshot.json_ordered_sha256,
      `derivativeSnapshots[${index}].json_ordered_sha256`,
    );
    if (jsonSha256 !== jsonOrderedSha256) {
      fail(`Derivative snapshot ${index} json and json_ordered hashes are inconsistent.`);
    }
    if (snapshot.extracted_md_sha256 !== null) {
      hash(snapshot.extracted_md_sha256, `derivativeSnapshots[${index}].extracted_md_sha256`);
    }
    if (snapshot.embedding_ft_sha256 !== null) {
      hash(snapshot.embedding_ft_sha256, `derivativeSnapshots[${index}].embedding_ft_sha256`);
    }
    if (snapshot.embedding_ft_at !== null) {
      timestamp(snapshot.embedding_ft_at, `derivativeSnapshots[${index}].embedding_ft_at`);
    }
    const snapshotSha256 = hash(
      snapshot.snapshot_sha256,
      `derivativeSnapshots[${index}].snapshot_sha256`,
    );
    return {
      table: action.table,
      id: action.id,
      version: action.version,
      user_id: action.user_id,
      state_code: 0,
      baseline_snapshot_sha256: snapshotSha256,
    };
  });
}

export function buildProtectedFreeze(options: {
  plan: DatasetMaintenancePlan;
  planFileSha256: string;
  aliasPlanRequest: JsonObject;
  projectRef: string;
  account: { user_id: string; email: string };
  toolchainEvidenceSha256: string;
  derivativeSnapshots: ProtectedDerivativeSnapshot[];
}): BuiltProtectedFreeze {
  const planFileSha256 = hash(options.planFileSha256, 'planFileSha256');
  const toolchainEvidenceSha256 = hash(options.toolchainEvidenceSha256, 'toolchainEvidenceSha256');
  const preparedAccount = account(options.account, 'account');
  assertProtectedPreparationPlanSha256(options.plan.plan_sha256, 'plan.plan_sha256');
  if (
    options.plan.operation !== 'merge-support-aliases' ||
    options.plan.status !== 'ready' ||
    options.plan.target_mode !== 'owner_draft' ||
    options.plan.blockers.length !== 0 ||
    options.plan.account.user_id !== preparedAccount.user_id ||
    options.plan.account.email !== preparedAccount.email ||
    computePlanSha256(options.plan) !== options.plan.plan_sha256
  ) {
    fail('Freeze builder requires the exact canonical ready owner-draft plan and account.');
  }
  assertAliasPlanRequest(options.plan, options.aliasPlanRequest);
  const aliasPlanRequestSha256 = sha256Json(options.aliasPlanRequest);
  const targets = derivativeTargets({
    plan: options.plan,
    account: preparedAccount,
    snapshots: options.derivativeSnapshots,
  });
  const planSets = protectedPlanSetHashes(options.plan);
  const candidate: DatasetMaintenanceProtectedFreeze = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.freeze_schema,
    environment: 'production',
    project_ref: assertProtectedProductionProjectRef(options.projectRef),
    account: preparedAccount,
    target_visibility: 'owner_draft',
    plan: {
      plan_file_sha256: planFileSha256,
      plan_sha256: options.plan.plan_sha256,
      operation_id: options.plan.operation_id,
    },
    sets: {
      ...planSets,
      alias_plan_request_sha256: aliasPlanRequestSha256,
      derivative_baseline_set_sha256: protectedDerivativeBaselineSetSha256(targets),
      toolchain_evidence_sha256: toolchainEvidenceSha256,
    },
    expected: PROTECTED_EXECUTION_COUNTS,
    derivative_targets: targets,
    policy: {
      state_code_changes: 0,
      save_draft: 0,
      deletes: 0,
      rebuild_derivatives: 0,
      unitgroup_actions: 0,
      person_distance_actions: 0,
      max_admit_posts: 1,
      automatic_retry: false,
    },
    freeze_sha256: '',
  };
  candidate.freeze_sha256 = computeProtectedFreezeSha256(candidate);
  const freeze = parseProtectedFreeze(candidate);
  assertProtectedFreezeMatchesPlan({
    plan: options.plan,
    planFileSha256,
    aliasPlanRequestSha256,
    freeze,
  });
  return {
    ...canonicalArtifact(freeze),
    alias_plan_request_sha256: aliasPlanRequestSha256,
  };
}

export function buildProtectedApprovalRequest(options: {
  freeze: DatasetMaintenanceProtectedFreeze;
  freezeFileSha256: string;
  approvedAtUtc: string;
}): BuiltProtectedApprovalRequest {
  const freeze = parseProtectedFreeze(options.freeze);
  const core = approvalRequestCore(freeze, options.freezeFileSha256, options.approvedAtUtc);
  const requestSha256 = sha256Json(core);
  const approvalText = renderProtectedApprovalText(core, requestSha256);
  const request = parseProtectedApprovalRequest({
    ...core,
    request_sha256: requestSha256,
    approval_text: approvalText,
    approval_text_sha256: sha256Text(approvalText),
  });
  return canonicalArtifact(request);
}

export function sealProtectedApproval(options: {
  approvalRequest: unknown;
  freeze: DatasetMaintenanceProtectedFreeze;
  freezeFileSha256: string;
  humanApprovalText: string;
  approveRequestSha256: string;
  approveTextSha256: string;
  approvedAtUtc: string;
  confirmAccountEmail: string;
}): BuiltProtectedApproval {
  const request = parseProtectedApprovalRequest(options.approvalRequest);
  const freeze = parseProtectedFreeze(options.freeze);
  assertProtectedProductionProjectRef(freeze.project_ref);
  const freezeFileSha256 = hash(options.freezeFileSha256, 'freezeFileSha256');
  const approveRequestSha256 = hash(options.approveRequestSha256, 'approveRequestSha256');
  const approveTextSha256 = hash(options.approveTextSha256, 'approveTextSha256');
  const approvedAtUtc = canonicalTimestamp(options.approvedAtUtc, 'approvedAtUtc');
  if (
    options.humanApprovalText !== request.approval_text ||
    approveRequestSha256 !== request.request_sha256 ||
    approveTextSha256 !== request.approval_text_sha256 ||
    options.confirmAccountEmail !== request.account.email ||
    approvedAtUtc !== request.approved_at_utc
  ) {
    fail(
      'Explicit human approval does not match the byte-exact request, hashes, account, or approved timestamp.',
    );
  }
  const expectedCore = approvalRequestCore(freeze, freezeFileSha256, request.approved_at_utc);
  if (sha256Json(expectedCore) !== request.request_sha256) {
    fail('Approval request does not bind the supplied freeze file, plan, account, or toolchain.');
  }
  const approval: DatasetMaintenanceProtectedApproval = {
    schema_version: PROTECTED_EXECUTION_CONTRACT.approval_schema,
    approved_at_utc: request.approved_at_utc,
    environment: 'production',
    project_ref: freeze.project_ref,
    account: freeze.account,
    target_visibility: 'owner_draft',
    plan_sha256: freeze.plan.plan_sha256,
    operation_id: freeze.plan.operation_id,
    plan_file_sha256: freeze.plan.plan_file_sha256,
    freeze_file_sha256: freezeFileSha256,
    freeze_sha256: freeze.freeze_sha256,
    approval_text_sha256: request.approval_text_sha256,
    max_admit_posts: 1,
    automatic_retry: false,
    approval_identity_sha256: '',
  };
  approval.approval_identity_sha256 = computeProtectedApprovalIdentitySha256(approval);
  return canonicalArtifact(parseProtectedApproval(approval));
}
