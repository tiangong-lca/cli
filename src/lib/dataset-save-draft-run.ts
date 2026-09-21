// data-api-relations: contacts, flowproperties, flows, processes, sources, unitgroups
// data-api-dynamic-relation-expression: options.table
import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';
import { createBatchContract, runBoundedBatch, type BatchJsonValue } from '../batch.js';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { collectImportContentIssues } from './dataset-validate.js';
import {
  DRAFT_REPAIR_ADMISSION_SCHEMA,
  DRAFT_REPAIR_POLICY,
  evaluateProcessMetadataRepairAdmission,
  isProcessMetadataRepairCandidate,
  type DraftRepairAdmission,
} from './dataset-draft-repair-admission.js';
import {
  createDatasetRecord,
  saveDraftDatasetRecord,
  type DatasetCommandTable,
} from './dataset-command.js';
import { readDatasetRowsInput } from './dataset-local.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';
import { validateProcessPayload } from './process-payload-validation.js';
import { buildDatasetCommandTransport } from './dataset-command.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
  type SupabaseDataRuntime,
} from './supabase-client.js';
import { createSupabaseDataRuntime } from './supabase-session.js';
import {
  collectRemoteReferences,
  lookupRemoteDataset,
  type RemoteDatasetLookup,
  type RemoteDatasetReference,
  type RemoteDatasetTable,
} from './dataset-remote-verify.js';
import {
  readJsonFile,
  readJsonLinesIfPresent,
  sha256Json,
  stableJsonText,
} from './dataset-maintenance-contract.js';
import { resolveFlowIdentityApprovalClaimRoot } from './dataset-maintenance-flow-identity-approval-claim.js';
import {
  buildDatasetValidationLayers,
  type DatasetValidationLayers,
} from './dataset-validation-layers.js';

type JsonObject = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10_000;

export type DatasetSaveDraftType =
  'auto' | 'contact' | 'source' | 'unitgroup' | 'flowproperty' | 'flow' | 'process';

type ConcreteDatasetSaveDraftType = Exclude<DatasetSaveDraftType, 'auto'>;

type DatasetTypeConfig = {
  table: DatasetCommandTable;
  rootKey: string;
  informationKey: string;
  schemaName: keyof typeof tidasSdk;
  factoryName: keyof typeof tidasSdk;
};

type DatasetSaveDraftValidationIssue = {
  path: string;
  message: string;
  code: string;
};

type DatasetSaveDraftValidationResult = {
  payload_sha256?: string;
  validation_layers?: DatasetValidationLayers;
} & (
  | {
      ok: true;
      validator: string;
      issue_count: 0;
      issues: [];
    }
  | {
      ok: false;
      validator: string;
      issue_count: number;
      issues: DatasetSaveDraftValidationIssue[];
    }
);

function normalizeValidationIssue(issue: {
  path?: Array<string | number>;
  message?: string;
  code?: string;
}): DatasetSaveDraftValidationIssue {
  return {
    path: normalizeIssuePath(issue.path ?? []),
    message: issue.message ?? 'Validation failed',
    code: issue.code ?? 'custom',
  };
}

export type DatasetSaveDraftRowReport = {
  index: number;
  id: string | null;
  version: string | null;
  type: ConcreteDatasetSaveDraftType | null;
  table: DatasetCommandTable | null;
  status: 'prepared' | 'executed' | 'failed' | 'unknown' | 'blocked';
  operation:
    | 'would_sync'
    | 'insert'
    | 'save_draft'
    | 'skipped_invalid'
    | 'reference_only_type'
    | 'type_unknown'
    | 'identity_missing'
    | 'elementary_flow_insert_blocked'
    | 'remote_reference_unresolved'
    | 'recovered_exact_readback'
    | 'blocked_dependency'
    | 'retained_outcome'
    | 'retained_attempt'
    | null;
  validation: DatasetSaveDraftValidationResult | null;
  visible_row?: VisibleDatasetRow | null;
  error?: { message: string; details?: unknown };
  action_id?: string;
  desired_sha256?: string;
  attempt_consumed?: boolean;
  replayed?: false;
  readback?: 'desired_exact' | 'not_desired' | 'not_performed';
  draft_repair_admission?: DraftRepairAdmission;
};

export type DatasetSaveDraftReport = {
  schema_version: 1 | 2;
  generated_at_utc: string;
  input_path: string;
  requested_type: DatasetSaveDraftType;
  out_dir: string;
  commit: boolean;
  mode: 'dry_run' | 'commit';
  status: 'completed' | 'completed_with_failures' | 'completed_with_unknowns';
  counts: {
    selected: number;
    prepared: number;
    executed: number;
    failed: number;
    unknown?: number;
    blocked?: number;
    attempts_consumed?: number;
    by_table: Partial<Record<DatasetCommandTable, number>>;
    operations: Record<string, number>;
  };
  files: {
    selected_rows: string;
    progress_jsonl: string;
    failures_jsonl: string;
    summary_json: string;
    execution_ledger?: string;
  };
  rows: DatasetSaveDraftRowReport[];
  execution_contract?: {
    path: string;
    sha256: string;
    execution_id: string;
    target_mode: 'owner_draft';
    max_parallel: number;
    serial_prefix_actions: number;
    parallel_suffix_actions: number;
  };
};

export type RunDatasetSaveDraftOptions = {
  inputPath: string;
  type?: string | null;
  outDir?: string | null;
  commit?: boolean | null;
  rawInput?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  /**
   * Explicit opt-in to write account-local (My Data, state_code=0) Unit Group and
   * Flow Property support rows that are otherwise reference-only. Default false keeps
   * the CLI safe-by-default for interactive operators.
   */
  allowReferenceOnlySupport?: boolean | null;
  executionContractPath?: string | null;
  maxParallel?: number | null;
};

type DatasetSaveDraftExecutionAction = {
  action_id: string;
  desired_sha256: string;
  expected_operation: 'insert' | 'save_draft';
  table: DatasetCommandTable;
  id: string;
  version: string;
  before_sha256: string | null;
  dependency_action_ids: string[];
};

type DatasetSaveDraftExecutionContract = {
  schema_version: 'dataset-save-draft-execution-contract.v1';
  execution_id: string;
  project_ref: string;
  target_mode: 'owner_draft';
  owner: {
    user_id: string;
    email: string;
    state_code: 0;
  };
  actions: DatasetSaveDraftExecutionAction[];
};

type DatasetSaveDraftLedgerEvent = {
  schema_version: 'dataset-save-draft-execution-event.v1';
  sequence: number;
  contract_sha256: string;
  action_id: string;
  desired_sha256: string;
  action_binding_sha256: string;
  event_type: 'attempt_emitted' | 'outcome';
  operation: 'insert' | 'save_draft';
  outcome: 'executed' | 'unknown' | null;
  recovered: boolean;
  recorded_at_utc: string;
  // Optional and hash-bound: a first attempt of an admitted metadata repair carries the verified
  // admission so a later recovery can return the original evidence instead of re-inventing it.
  draft_repair_admission?: DraftRepairAdmission;
  previous_event_sha256: string | null;
  event_sha256: string;
};

const DRAFT_REPAIR_ADMISSION_KEYS = [
  'before_sha256',
  'changed_paths',
  'desired_sha256',
  'policy',
  'publication_ready',
  'schema',
  'status',
].join(',');

function isLedgerRepairAdmission(value: unknown): value is DraftRepairAdmission {
  if (!isRecord(value) || !Array.isArray(value.changed_paths)) {
    return false;
  }
  return (
    Object.keys(value).sort().join(',') === DRAFT_REPAIR_ADMISSION_KEYS &&
    value.schema === DRAFT_REPAIR_ADMISSION_SCHEMA &&
    value.status === 'admitted' &&
    value.policy === DRAFT_REPAIR_POLICY &&
    value.publication_ready === false &&
    typeof value.before_sha256 === 'string' &&
    SHA256_PATTERN.test(value.before_sha256) &&
    typeof value.desired_sha256 === 'string' &&
    SHA256_PATTERN.test(value.desired_sha256) &&
    value.changed_paths.length > 0 &&
    value.changed_paths.every((path) => typeof path === 'string' && path.length > 0)
  );
}

type ExecutionLedgerState = {
  events: Map<string, DatasetSaveDraftLedgerEvent[]>;
  attempts: Map<string, DatasetSaveDraftLedgerEvent>;
  outcomes: Map<string, DatasetSaveDraftLedgerEvent>;
};

type PreparedDatasetRow = {
  index: number;
  row: JsonObject;
  payload: JsonObject;
  type: ConcreteDatasetSaveDraftType | null;
  config: DatasetTypeConfig | null;
  id: string | null;
  version: string | null;
  validation: DatasetSaveDraftValidationResult | null;
};

type VisibleDatasetRow = {
  id: string;
  version: string;
  user_id: string | null;
  state_code: number | null;
};

type ExecutionDatasetRow = VisibleDatasetRow & {
  json_ordered: JsonObject | null;
};

type SupabaseDataClient = ReturnType<typeof createSupabaseDataClient>['client'];

type MissingFlowRemoteReference = {
  table: RemoteDatasetTable | null;
  id: string | null;
  version: string | null;
  path: string;
  short_description: string | null;
  status:
    | 'missing_dataset'
    | 'missing_version'
    | 'unsupported_type'
    | 'version_missing'
    | 'version_outdated';
  latest_version: string | null;
};

const DATASET_CONFIGS: Record<ConcreteDatasetSaveDraftType, DatasetTypeConfig> = {
  contact: {
    table: 'contacts',
    rootKey: 'contactDataSet',
    informationKey: 'contactInformation',
    schemaName: 'ContactSchema',
    factoryName: 'createContact',
  },
  source: {
    table: 'sources',
    rootKey: 'sourceDataSet',
    informationKey: 'sourceInformation',
    schemaName: 'SourceSchema',
    factoryName: 'createSource',
  },
  unitgroup: {
    table: 'unitgroups',
    rootKey: 'unitGroupDataSet',
    informationKey: 'unitGroupInformation',
    schemaName: 'UnitGroupSchema',
    factoryName: 'createUnitGroup',
  },
  flowproperty: {
    table: 'flowproperties',
    rootKey: 'flowPropertyDataSet',
    informationKey: 'flowPropertiesInformation',
    schemaName: 'FlowPropertySchema',
    factoryName: 'createFlowProperty',
  },
  flow: {
    table: 'flows',
    rootKey: 'flowDataSet',
    informationKey: 'flowInformation',
    schemaName: 'FlowSchema',
    factoryName: 'createFlow',
  },
  process: {
    table: 'processes',
    rootKey: 'processDataSet',
    informationKey: 'processInformation',
    schemaName: 'ProcessSchema',
    factoryName: 'createProcess',
  },
};

const REFERENCE_ONLY_SAVE_DRAFT_TYPES = new Set<ConcreteDatasetSaveDraftType>([
  'unitgroup',
  'flowproperty',
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function executionContractError(message: string): never {
  throw new CliError(message, {
    code: 'DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID',
    exitCode: 2,
  });
}

function requireExecutionToken(value: unknown, label: string): string {
  const normalized = trimToken(value);
  return normalized ?? executionContractError(`${label} must be a non-empty string.`);
}

function requireExecutionSha(value: unknown, label: string): string {
  const normalized = requireExecutionToken(value, label);
  return SHA256_PATTERN.test(normalized)
    ? normalized
    : executionContractError(`${label} must be a lowercase SHA-256 digest.`);
}

function parseExecutionContract(value: unknown): DatasetSaveDraftExecutionContract {
  if (!isRecord(value)) {
    executionContractError('Execution contract must be a JSON object.');
  }
  if (
    value.schema_version !== 'dataset-save-draft-execution-contract.v1' ||
    value.target_mode !== 'owner_draft' ||
    !isRecord(value.owner) ||
    value.owner.state_code !== 0 ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0
  ) {
    executionContractError('Execution contract header is invalid.');
  }
  const executionId = requireExecutionToken(value.execution_id, 'execution_id');
  const projectRef = requireExecutionToken(value.project_ref, 'project_ref');
  const ownerUserId = requireExecutionToken(value.owner.user_id, 'owner.user_id');
  const ownerEmail = requireExecutionToken(value.owner.email, 'owner.email').toLowerCase();
  const actions: DatasetSaveDraftExecutionAction[] = [];
  const seen = new Set<string>();
  for (const [index, rawAction] of value.actions.entries()) {
    if (!isRecord(rawAction) || !Array.isArray(rawAction.dependency_action_ids)) {
      executionContractError(`actions[${index}] is invalid.`);
    }
    const actionId = requireExecutionToken(rawAction.action_id, `actions[${index}].action_id`);
    if (seen.has(actionId)) {
      executionContractError(`Duplicate action_id: ${actionId}`);
    }
    const table = requireExecutionToken(rawAction.table, `actions[${index}].table`);
    if (!Object.values(DATASET_CONFIGS).some((config) => config.table === table)) {
      executionContractError(`actions[${index}].table is unsupported.`);
    }
    const expectedOperation = rawAction.expected_operation;
    if (expectedOperation !== 'insert' && expectedOperation !== 'save_draft') {
      executionContractError(`actions[${index}].expected_operation is invalid.`);
    }
    const beforeSha =
      rawAction.before_sha256 === null
        ? null
        : requireExecutionSha(rawAction.before_sha256, `actions[${index}].before_sha256`);
    if (
      (expectedOperation === 'insert' && beforeSha !== null) ||
      (expectedOperation === 'save_draft' && beforeSha === null)
    ) {
      executionContractError(`actions[${index}].before_sha256 contradicts expected_operation.`);
    }
    const dependencies = rawAction.dependency_action_ids.map((dependency, dependencyIndex) =>
      requireExecutionToken(
        dependency,
        `actions[${index}].dependency_action_ids[${dependencyIndex}]`,
      ),
    );
    if (
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some((id) => !seen.has(id))
    ) {
      executionContractError(
        `actions[${index}].dependency_action_ids must be unique earlier actions.`,
      );
    }
    actions.push({
      action_id: actionId,
      desired_sha256: requireExecutionSha(
        rawAction.desired_sha256,
        `actions[${index}].desired_sha256`,
      ),
      expected_operation: expectedOperation,
      table: table as DatasetCommandTable,
      id: requireExecutionToken(rawAction.id, `actions[${index}].id`),
      version: requireExecutionToken(rawAction.version, `actions[${index}].version`),
      before_sha256: beforeSha,
      dependency_action_ids: dependencies,
    });
    seen.add(actionId);
  }
  return {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: executionId,
    project_ref: projectRef,
    target_mode: 'owner_draft',
    owner: { user_id: ownerUserId, email: ownerEmail, state_code: 0 },
    actions,
  };
}

function bindExecutionContractRows(
  contract: DatasetSaveDraftExecutionContract,
  rows: PreparedDatasetRow[],
): void {
  if (contract.actions.length !== rows.length) {
    executionContractError('Execution contract action count does not match selected rows.');
  }
  contract.actions.forEach((action, index) => {
    const row = rows[index];
    const payloadIdentity = row?.config
      ? extractIdentity(row.payload, {}, row.config)
      : { id: null, version: null };
    if (
      !row ||
      row.config?.table !== action.table ||
      row.id !== action.id ||
      row.version !== action.version ||
      payloadIdentity.id !== action.id ||
      payloadIdentity.version !== action.version ||
      sha256Json(row.payload) !== action.desired_sha256
    ) {
      executionContractError(
        `Execution contract action ${action.action_id} does not bind row ${index}.`,
      );
    }
  });
}

function executionActionBindingSha256(action: DatasetSaveDraftExecutionAction): string {
  return sha256Json({
    schema_version: 'dataset-save-draft-action-binding.v1',
    action_id: action.action_id,
    desired_sha256: action.desired_sha256,
    expected_operation: action.expected_operation,
    table: action.table,
    id: action.id,
    version: action.version,
    before_sha256: action.before_sha256,
  });
}

function executionLedgerRoot(
  env: NodeJS.ProcessEnv,
  contract: DatasetSaveDraftExecutionContract,
): string {
  const ownerScopeSha256 = sha256Json({
    schema_version: 'dataset-save-draft-owner-scope.v1',
    project_ref: contract.project_ref,
    owner: contract.owner,
  });
  return path.join(
    resolveFlowIdentityApprovalClaimRoot({ env }),
    'execution-ledgers',
    'dataset-save-draft',
    'v1',
    ownerScopeSha256,
  );
}

function executionLedgerPath(ledgerRoot: string, action: DatasetSaveDraftExecutionAction): string {
  const actionIdentitySha256 = sha256Json({
    schema_version: 'dataset-save-draft-action-identity.v1',
    action_id: action.action_id,
    desired_sha256: action.desired_sha256,
  });
  return path.join(path.resolve(ledgerRoot), `${actionIdentitySha256}.events.jsonl`);
}

function eventWithoutSha(
  event: DatasetSaveDraftLedgerEvent,
): Omit<DatasetSaveDraftLedgerEvent, 'event_sha256'> {
  const core: Partial<DatasetSaveDraftLedgerEvent> = { ...event };
  delete core.event_sha256;
  return core as Omit<DatasetSaveDraftLedgerEvent, 'event_sha256'>;
}

function parseLedgerEvent(value: unknown, index: number): DatasetSaveDraftLedgerEvent {
  if (!isRecord(value)) {
    executionContractError(`Execution ledger event ${index} is not an object.`);
  }
  const event = value as DatasetSaveDraftLedgerEvent;
  if (
    event.schema_version !== 'dataset-save-draft-execution-event.v1' ||
    event.sequence !== index + 1 ||
    !SHA256_PATTERN.test(event.contract_sha256) ||
    !trimToken(event.action_id) ||
    !SHA256_PATTERN.test(event.desired_sha256) ||
    !SHA256_PATTERN.test(event.action_binding_sha256) ||
    !['attempt_emitted', 'outcome'].includes(event.event_type) ||
    !['insert', 'save_draft'].includes(event.operation) ||
    !['executed', 'unknown', null].includes(event.outcome) ||
    typeof event.recovered !== 'boolean' ||
    !trimToken(event.recorded_at_utc) ||
    !(event.previous_event_sha256 === null || SHA256_PATTERN.test(event.previous_event_sha256)) ||
    (event.draft_repair_admission !== undefined &&
      !isLedgerRepairAdmission(event.draft_repair_admission)) ||
    !SHA256_PATTERN.test(event.event_sha256)
  ) {
    executionContractError(`Execution ledger event ${index} has an invalid shape.`);
  }
  if (
    (event.event_type === 'attempt_emitted' && event.outcome !== null) ||
    (event.event_type === 'outcome' && event.outcome === null)
  ) {
    executionContractError(`Execution ledger event ${index} has an invalid outcome.`);
  }
  return event;
}

function loadExecutionLedger(
  ledgerRoot: string,
  contract: DatasetSaveDraftExecutionContract,
): ExecutionLedgerState {
  const events = new Map<string, DatasetSaveDraftLedgerEvent[]>();
  const attempts = new Map<string, DatasetSaveDraftLedgerEvent>();
  const outcomes = new Map<string, DatasetSaveDraftLedgerEvent>();
  for (const action of contract.actions) {
    const actionEvents: DatasetSaveDraftLedgerEvent[] = [];
    const rawEvents = readJsonLinesIfPresent(executionLedgerPath(ledgerRoot, action));
    for (const [index, value] of rawEvents.entries()) {
      const event = parseLedgerEvent(value, index);
      const previous = actionEvents.at(-1) ?? null;
      if (
        event.action_id !== action.action_id ||
        event.desired_sha256 !== action.desired_sha256 ||
        event.action_binding_sha256 !== executionActionBindingSha256(action) ||
        event.operation !== action.expected_operation ||
        (event.draft_repair_admission !== undefined &&
          (event.draft_repair_admission.before_sha256 !== action.before_sha256 ||
            event.draft_repair_admission.desired_sha256 !== action.desired_sha256)) ||
        event.previous_event_sha256 !== (previous?.event_sha256 ?? null) ||
        event.event_sha256 !== sha256Json(eventWithoutSha(event))
      ) {
        executionContractError(
          `Execution ledger event ${index} failed its hash or action binding for ${action.action_id}.`,
        );
      }
      if (event.event_type === 'attempt_emitted') {
        if (attempts.has(event.action_id) || outcomes.has(event.action_id)) {
          executionContractError(`Execution ledger repeats attempt for ${event.action_id}.`);
        }
        attempts.set(event.action_id, event);
      } else {
        if (!attempts.has(event.action_id) || outcomes.has(event.action_id)) {
          executionContractError(
            `Execution ledger outcome ordering is invalid for ${event.action_id}.`,
          );
        }
        outcomes.set(event.action_id, event);
      }
      actionEvents.push(event);
    }
    events.set(action.action_id, actionEvents);
  }
  return { events, attempts, outcomes };
}

function appendExecutionEvent(options: {
  ledgerRoot: string;
  ledger: ExecutionLedgerState;
  contractSha256: string;
  action: DatasetSaveDraftExecutionAction;
  eventType: 'attempt_emitted' | 'outcome';
  outcome: 'executed' | 'unknown' | null;
  recovered: boolean;
  recordedAtUtc: string;
  draftRepairAdmission?: DraftRepairAdmission;
}): DatasetSaveDraftLedgerEvent {
  const actionEvents = options.ledger.events.get(
    options.action.action_id,
  ) as DatasetSaveDraftLedgerEvent[];
  const core = {
    schema_version: 'dataset-save-draft-execution-event.v1' as const,
    sequence: actionEvents.length + 1,
    contract_sha256: options.contractSha256,
    action_id: options.action.action_id,
    desired_sha256: options.action.desired_sha256,
    action_binding_sha256: executionActionBindingSha256(options.action),
    event_type: options.eventType,
    operation: options.action.expected_operation,
    outcome: options.outcome,
    recovered: options.recovered,
    recorded_at_utc: options.recordedAtUtc,
    ...(options.draftRepairAdmission
      ? { draft_repair_admission: options.draftRepairAdmission }
      : {}),
    previous_event_sha256: actionEvents.at(-1)?.event_sha256 ?? null,
  };
  const event: DatasetSaveDraftLedgerEvent = { ...core, event_sha256: sha256Json(core) };
  const ledgerPath = executionLedgerPath(options.ledgerRoot, options.action);
  mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(ledgerPath), 0o700);
  if (event.event_type === 'attempt_emitted') {
    const createDescriptor = openSync(ledgerPath, 'wx', 0o600);
    try {
      writeFileSync(createDescriptor, `${stableJsonText(event)}\n`, 'utf8');
      fsyncSync(createDescriptor);
    } finally {
      closeSync(createDescriptor);
    }
  } else {
    const appendDescriptor = openSync(ledgerPath, 'a', 0o600);
    try {
      writeFileSync(appendDescriptor, `${stableJsonText(event)}\n`, 'utf8');
      fsyncSync(appendDescriptor);
    } finally {
      closeSync(appendDescriptor);
    }
  }
  chmodSync(ledgerPath, 0o600);
  actionEvents.push(event);
  options.ledger.events.set(event.action_id, actionEvents);
  if (event.event_type === 'attempt_emitted') {
    options.ledger.attempts.set(event.action_id, event);
  } else {
    options.ledger.outcomes.set(event.action_id, event);
  }
  return event;
}

function projectRefFromApiBaseUrl(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).hostname.split('.')[0] as string;
}

function decodeExecutionActor(accessToken: string): { user_id: string; email: string } {
  const payload = accessToken.split('.')[1];
  if (!payload) {
    executionContractError('Owner-session access token is not a JWT.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    executionContractError('Owner-session access token JWT payload is invalid.');
  }
  if (!isRecord(decoded)) {
    executionContractError('Owner-session access token JWT payload is not an object.');
  }
  return {
    user_id: requireExecutionToken(decoded.sub, 'owner-session sub'),
    email: requireExecutionToken(decoded.email, 'owner-session email').toLowerCase(),
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function serializeError(error: unknown): { message: string; details?: unknown } {
  if (error instanceof CliError) {
    return { message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

function normalizeType(
  value: string | null | undefined,
  allowReferenceOnlySupport = false,
): DatasetSaveDraftType {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return 'auto';
  }
  if (normalized === 'contact' || normalized === 'contacts') {
    return 'contact';
  }
  if (normalized === 'source' || normalized === 'sources') {
    return 'source';
  }
  if (
    normalized === 'unitgroup' ||
    normalized === 'unitgroups' ||
    normalized === 'unit-group' ||
    normalized === 'unit-groups'
  ) {
    if (allowReferenceOnlySupport) {
      return 'unitgroup';
    }
    throw new CliError(
      'Unit groups are reference-only support data for dataset save-draft. Select an existing database row instead of creating a custom My Data unit group.',
      {
        code: 'DATASET_SAVE_DRAFT_REFERENCE_ONLY_TYPE',
        exitCode: 2,
        details: { type: normalized },
      },
    );
  }
  if (
    normalized === 'flowproperty' ||
    normalized === 'flowproperties' ||
    normalized === 'flow-property' ||
    normalized === 'flow-properties'
  ) {
    if (allowReferenceOnlySupport) {
      return 'flowproperty';
    }
    throw new CliError(
      'Flow properties are reference-only support data for dataset save-draft. Select an existing database row instead of creating a custom My Data flow property.',
      {
        code: 'DATASET_SAVE_DRAFT_REFERENCE_ONLY_TYPE',
        exitCode: 2,
        details: { type: normalized },
      },
    );
  }
  if (normalized === 'flow' || normalized === 'flows') {
    return 'flow';
  }
  if (normalized === 'process' || normalized === 'processes') {
    return 'process';
  }

  throw new CliError('Expected --type to be auto, contact, source, flow, or process.', {
    code: 'DATASET_SAVE_DRAFT_TYPE_INVALID',
    exitCode: 2,
    details: value,
  });
}

function unwrapPayload(row: JsonObject): JsonObject {
  for (const key of ['json_ordered', 'jsonOrdered', 'payload', 'json'] as const) {
    if (isRecord(row[key])) {
      return row[key];
    }
  }
  return row;
}

function detectType(payload: JsonObject): ConcreteDatasetSaveDraftType | null {
  for (const [type, config] of Object.entries(DATASET_CONFIGS)) {
    if (isRecord(payload[config.rootKey])) {
      return type as ConcreteDatasetSaveDraftType;
    }
  }
  return null;
}

function schemaForConfig(config: DatasetTypeConfig): {
  schema: SafeParseSchema;
  createEntity: SdkValidationFactory | null;
} {
  const schema = (tidasSdk as Record<string, unknown>)[config.schemaName];
  if (
    !schema ||
    typeof schema !== 'object' ||
    typeof (schema as SafeParseSchema).safeParse !== 'function'
  ) {
    throw new CliError(`${String(config.schemaName)} is unavailable in @tiangong-lca/tidas-sdk.`, {
      code: 'DATASET_SAVE_DRAFT_SCHEMA_UNAVAILABLE',
      exitCode: 2,
      details: { table: config.table },
    });
  }
  const createEntity = (tidasSdk as Record<string, unknown>)[config.factoryName];
  return {
    schema:
      config.table === 'processes'
        ? withOptionalReviewReportReference(schema as SafeParseSchema, 'processes')
        : (schema as SafeParseSchema),
    createEntity:
      typeof createEntity === 'function' ? (createEntity as SdkValidationFactory) : null,
  };
}

function validatePayload(
  payload: JsonObject,
  type: ConcreteDatasetSaveDraftType,
  config: DatasetTypeConfig,
): DatasetSaveDraftValidationResult {
  const { schema, createEntity } = schemaForConfig(config);
  if (type === 'process') return validateProcessPayload(payload, schema, createEntity);
  // SDK schema/entity validation may apply defaults by mutating its input. Keep validation
  // isolated so execution-contract hashing, dispatch, and readback all use the exact input.
  const validationPayload = structuredClone(payload);
  const outcome = validateSchemaWithDeepFallback(schema, validationPayload, createEntity);
  const contentIssues = collectImportContentIssues(payload);
  const { additional_multilingual_issues, ...evidence } = buildDatasetValidationLayers(
    payload,
    outcome,
    [],
    contentIssues,
  );
  const issues: DatasetSaveDraftValidationIssue[] = [
    ...outcome.issues.map(normalizeValidationIssue),
    ...contentIssues,
    ...additional_multilingual_issues,
  ];

  if (outcome.success && issues.length === 0) {
    return {
      ok: true,
      validator: `@tiangong-lca/tidas-sdk/${String(config.schemaName)}+tiangong/import-content`,
      issue_count: 0,
      issues: [],
      ...evidence,
    };
  }

  return {
    ok: false,
    validator: `@tiangong-lca/tidas-sdk/${String(config.schemaName)}+tiangong/import-content`,
    issue_count: issues.length,
    issues,
    ...evidence,
  };
}

function extractIdentity(
  payload: JsonObject,
  row: JsonObject,
  config: DatasetTypeConfig,
): {
  id: string | null;
  version: string | null;
} {
  const rootCandidate = payload[config.rootKey];
  const root: JsonObject = isRecord(rootCandidate) ? rootCandidate : payload;
  const informationCandidate = root[config.informationKey];
  const information: JsonObject = isRecord(informationCandidate) ? informationCandidate : {};
  const dataSetInformationCandidate = information.dataSetInformation;
  const dataSetInformation = isRecord(dataSetInformationCandidate)
    ? dataSetInformationCandidate
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};

  return {
    id: trimToken(row.id) ?? trimToken(dataSetInformation['common:UUID']),
    version:
      trimToken(row.version) ?? trimToken(publicationAndOwnership['common:dataSetVersion']) ?? null,
  };
}

function flowType(payload: JsonObject): string | null {
  const rootCandidate = payload.flowDataSet;
  const root = isRecord(rootCandidate) ? rootCandidate : payload;
  const modellingCandidate = root.modellingAndValidation;
  const modelling = isRecord(modellingCandidate) ? modellingCandidate : {};
  const lciMethodCandidate = modelling.LCIMethod;
  const lciMethod = isRecord(lciMethodCandidate) ? lciMethodCandidate : {};
  return trimToken(lciMethod.typeOfDataSet);
}

function isElementaryFlowPayload(payload: JsonObject): boolean {
  return flowType(payload)?.trim().toLowerCase() === 'elementary flow';
}

function compareVersions(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  const leftParts = left.split(/[._-]/u);
  const rightParts = right.split(/[._-]/u);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }
    } else {
      const compared = leftPart.localeCompare(rightPart);
      if (compared !== 0) {
        return compared > 0 ? 1 : -1;
      }
    }
  }
  return 0;
}

function supportLookupKey(reference: {
  table: RemoteDatasetTable;
  id: string;
  version: string | null;
}): string {
  return `${reference.table}:${reference.id}:${reference.version ?? ''}`;
}

function isLookupableRemoteReference(
  reference: RemoteDatasetReference,
): reference is RemoteDatasetReference & { table: RemoteDatasetTable; id: string } {
  return Boolean(reference.table && reference.id);
}

function uniqueFlowRemoteReferences(payload: JsonObject): RemoteDatasetReference[] {
  const references = new Map<string, RemoteDatasetReference>();
  for (const reference of collectRemoteReferences([payload])) {
    if (reference.role !== 'reference') {
      continue;
    }
    if (reference.table && reference.id) {
      references.set(
        supportLookupKey({
          table: reference.table,
          id: reference.id,
          version: reference.version,
        }),
        reference,
      );
    } else {
      references.set(remoteReferenceFallbackKey(reference), reference);
    }
  }
  return [...references.values()];
}

function remoteReferenceFallbackKey(
  reference: Pick<RemoteDatasetReference, 'path' | 'type'>,
): string {
  return `${reference.path}:${reference.type ?? 'unknown'}`;
}

async function lookupCachedReferenceOnlySupport(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  cache: Map<string, Promise<RemoteDatasetLookup>>;
  reference: RemoteDatasetReference & { table: RemoteDatasetTable; id: string };
}): Promise<RemoteDatasetLookup> {
  const key = supportLookupKey(options.reference);
  if (!options.cache.has(key)) {
    options.cache.set(
      key,
      lookupRemoteDataset({
        runtime: options.runtime,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        request: {
          table: options.reference.table,
          id: options.reference.id,
          version: options.reference.version,
        },
      }),
    );
  }
  return options.cache.get(key) as Promise<RemoteDatasetLookup>;
}

async function missingFlowRemoteReferences(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  cache: Map<string, Promise<RemoteDatasetLookup>>;
  payload: JsonObject;
}): Promise<MissingFlowRemoteReference[]> {
  const missing: MissingFlowRemoteReference[] = [];
  for (const reference of uniqueFlowRemoteReferences(options.payload)) {
    if (!isLookupableRemoteReference(reference)) {
      missing.push({
        table: reference.table,
        id: reference.id,
        version: reference.version,
        path: reference.path,
        short_description: reference.short_description,
        status: 'unsupported_type',
        latest_version: null,
      });
      continue;
    }
    if (!reference.version) {
      missing.push({
        table: reference.table,
        id: reference.id,
        version: null,
        path: reference.path,
        short_description: reference.short_description,
        status: 'version_missing',
        latest_version: null,
      });
      continue;
    }
    const lookup = await lookupCachedReferenceOnlySupport({ ...options, reference });
    if (!lookup.latest) {
      missing.push({
        table: reference.table,
        id: reference.id,
        version: reference.version,
        path: reference.path,
        short_description: reference.short_description,
        status: 'missing_dataset',
        latest_version: null,
      });
    } else if (!lookup.exact) {
      missing.push({
        table: reference.table,
        id: reference.id,
        version: reference.version,
        path: reference.path,
        short_description: reference.short_description,
        status: 'missing_version',
        latest_version: lookup.latest.version,
      });
    } else if (compareVersions(lookup.latest.version, reference.version) > 0) {
      missing.push({
        table: reference.table,
        id: reference.id,
        version: reference.version,
        path: reference.path,
        short_description: reference.short_description,
        status: 'version_outdated',
        latest_version: lookup.latest.version,
      });
    }
  }
  return missing;
}

function prepareRows(
  inputPath: string,
  rawInput: unknown | undefined,
  requestedType: DatasetSaveDraftType,
): PreparedDatasetRow[] {
  const rows = readDatasetRowsInput(inputPath, rawInput);
  return rows.map((row, index) => {
    const payload = unwrapPayload(row);
    const type = requestedType === 'auto' ? detectType(payload) : requestedType;
    const config = type ? DATASET_CONFIGS[type] : null;
    const identity = config ? extractIdentity(payload, row, config) : { id: null, version: null };
    return {
      index,
      row,
      payload,
      type,
      config,
      id: identity.id,
      version: identity.version,
      validation: config && type ? validatePayload(payload, type, config) : null,
    };
  });
}

function buildFiles(outDir: string): DatasetSaveDraftReport['files'] {
  const outputDir = path.join(outDir, 'outputs', 'dataset-save-draft');
  return {
    selected_rows: path.join(outputDir, 'selected-rows.jsonl'),
    progress_jsonl: path.join(outputDir, 'progress.jsonl'),
    failures_jsonl: path.join(outputDir, 'failures.jsonl'),
    summary_json: path.join(outputDir, 'summary.json'),
  };
}

function defaultOutDir(inputPath: string, commit: boolean, now: Date): string {
  const mode = commit ? 'commit' : 'dry-run';
  const timestamp = now.toISOString().replace(/[:.]/gu, '').replace(/Z$/u, 'Z');
  return path.join(
    path.dirname(inputPath),
    'artifacts',
    'dataset-save-draft',
    `${mode}-${timestamp}`,
  );
}

function operationCount(rows: DatasetSaveDraftRowReport[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.operation ?? 'none';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function byTable(rows: PreparedDatasetRow[]): Partial<Record<DatasetCommandTable, number>> {
  const counts: Partial<Record<DatasetCommandTable, number>> = {};
  for (const row of rows) {
    if (row.config) {
      counts[row.config.table] = (counts[row.config.table] ?? 0) + 1;
    }
  }
  return counts;
}

function selectedRow(row: PreparedDatasetRow): JsonObject {
  return {
    index: row.index,
    type: row.type,
    table: row.config?.table ?? null,
    id: row.id,
    version: row.version,
    validation: row.validation,
    payload: row.payload,
  };
}

function buildPreparedFailure(
  row: PreparedDatasetRow,
  allowReferenceOnlySupport = false,
): DatasetSaveDraftRowReport | null {
  if (!row.type || !row.config) {
    return {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.type,
      table: null,
      status: 'failed',
      operation: 'type_unknown',
      validation: null,
      error: {
        message: 'Could not detect dataset type. Use --type or provide a supported TIDAS wrapper.',
      },
    };
  }

  if (REFERENCE_ONLY_SAVE_DRAFT_TYPES.has(row.type) && !allowReferenceOnlySupport) {
    return {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.type,
      table: row.config.table,
      status: 'failed',
      operation: 'reference_only_type',
      validation: row.validation,
      error: {
        message:
          'Unit Groups and Flow Properties are reference-only support data. Rewrite references to existing database rows instead of writing these rows through dataset save-draft.',
      },
    };
  }

  if (!row.id || !row.version) {
    return {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.type,
      table: row.config.table,
      status: 'failed',
      operation: 'identity_missing',
      validation: row.validation,
      error: {
        message:
          'Dataset row is missing common:UUID or common:dataSetVersion required for save-draft.',
      },
    };
  }

  if (!row.validation?.ok) {
    return {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.type,
      table: row.config.table,
      status: 'failed',
      operation: 'skipped_invalid',
      validation: row.validation,
      error: {
        message: `Local dataset validation failed with ${row.validation?.issue_count ?? 0} issue(s).`,
      },
    };
  }

  return null;
}

function buildVisibleRowsUrl(
  restBaseUrl: string,
  table: DatasetCommandTable,
  id: string,
  version: string,
): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/${table}`);
  url.searchParams.set('select', 'id,version,user_id,state_code');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

function parseVisibleRows(payload: unknown, url: string): VisibleDatasetRow[] {
  if (!Array.isArray(payload)) {
    throw new CliError(`Supabase REST response was not a JSON array for ${url}`, {
      code: 'SUPABASE_REST_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  return payload.map((item, index) => {
    if (!isRecord(item)) {
      throw new CliError(`Supabase REST row ${index} was not a JSON object for ${url}`, {
        code: 'SUPABASE_REST_RESPONSE_INVALID',
        exitCode: 1,
        details: item,
      });
    }
    return {
      id: trimToken(item.id) ?? '',
      version: trimToken(item.version) ?? '',
      user_id: trimToken(item.user_id),
      state_code: typeof item.state_code === 'number' ? item.state_code : null,
    };
  });
}

async function exactVisibleRows(options: {
  client: SupabaseDataClient;
  restBaseUrl: string;
  table: DatasetCommandTable;
  id: string;
  version: string;
}): Promise<VisibleDatasetRow[]> {
  const url = buildVisibleRowsUrl(options.restBaseUrl, options.table, options.id, options.version);
  const payload = await runSupabaseArrayQuery(
    options.client
      .from(options.table)
      .select('id,version,user_id,state_code')
      .eq('id', options.id)
      .eq('version', options.version),
    url,
  );
  return parseVisibleRows(payload, url);
}

function parseExecutionRows(payload: unknown, url: string): ExecutionDatasetRow[] {
  const visible = parseVisibleRows(payload, url);
  return visible.map((row, index) => {
    const raw = (payload as unknown[])[index];
    const jsonOrdered = isRecord(raw) && isRecord(raw.json_ordered) ? raw.json_ordered : null;
    return { ...row, json_ordered: jsonOrdered };
  });
}

async function exactExecutionRows(options: {
  client: SupabaseDataClient;
  restBaseUrl: string;
  table: DatasetCommandTable;
  id: string;
  version: string;
}): Promise<ExecutionDatasetRow[]> {
  const url = new URL(
    buildVisibleRowsUrl(options.restBaseUrl, options.table, options.id, options.version),
  );
  url.searchParams.set('select', 'id,version,user_id,state_code,json_ordered');
  const payload = await runSupabaseArrayQuery(
    options.client
      .from(options.table)
      .select('id,version,user_id,state_code,json_ordered')
      .eq('id', options.id)
      .eq('version', options.version),
    url.toString(),
  );
  return parseExecutionRows(payload, url.toString());
}

function exactDesiredReadback(options: {
  rows: ExecutionDatasetRow[];
  action: DatasetSaveDraftExecutionAction;
  contract: DatasetSaveDraftExecutionContract;
}): boolean {
  const row = options.rows[0];
  return Boolean(
    options.rows.length === 1 &&
    row &&
    row.id === options.action.id &&
    row.version === options.action.version &&
    row.user_id === options.contract.owner.user_id &&
    row.state_code === 0 &&
    row.json_ordered &&
    sha256Json(row.json_ordered) === options.action.desired_sha256,
  );
}

function contractRowReport(options: {
  row: PreparedDatasetRow;
  action: DatasetSaveDraftExecutionAction;
  status: 'executed' | 'failed' | 'unknown' | 'blocked' | 'prepared';
  operation: DatasetSaveDraftRowReport['operation'];
  attemptConsumed: boolean;
  readback: DatasetSaveDraftRowReport['readback'];
  error?: { message: string; details?: unknown };
  visibleRow?: VisibleDatasetRow | null;
  draftRepairAdmission?: DraftRepairAdmission;
}): DatasetSaveDraftRowReport {
  return {
    index: options.row.index,
    id: options.row.id,
    version: options.row.version,
    type: options.row.type,
    table: options.action.table,
    status: options.status,
    operation: options.operation,
    validation: options.row.validation,
    action_id: options.action.action_id,
    desired_sha256: options.action.desired_sha256,
    attempt_consumed: options.attemptConsumed,
    replayed: false,
    readback: options.readback,
    ...(options.visibleRow !== undefined ? { visible_row: options.visibleRow } : {}),
    ...(options.draftRepairAdmission
      ? { draft_repair_admission: options.draftRepairAdmission }
      : {}),
    ...(options.error ? { error: options.error } : {}),
  };
}

async function finalizeAttemptedAction(options: {
  row: PreparedDatasetRow;
  action: DatasetSaveDraftExecutionAction;
  contract: DatasetSaveDraftExecutionContract;
  contractSha256: string;
  ledgerRoot: string;
  ledger: ExecutionLedgerState;
  client: SupabaseDataClient;
  restBaseUrl: string;
  now: () => string;
  recovered: boolean;
  draftRepairAdmission?: DraftRepairAdmission;
}): Promise<DatasetSaveDraftRowReport> {
  const desiredExact = await readbackIsDesiredExact(options);
  appendExecutionEvent({
    ledgerRoot: options.ledgerRoot,
    ledger: options.ledger,
    contractSha256: options.contractSha256,
    action: options.action,
    eventType: 'outcome',
    outcome: desiredExact ? 'executed' : 'unknown',
    recovered: options.recovered,
    recordedAtUtc: options.now(),
  });
  return contractRowReport({
    row: options.row,
    action: options.action,
    status: desiredExact ? 'executed' : 'unknown',
    operation:
      desiredExact && options.recovered
        ? 'recovered_exact_readback'
        : options.action.expected_operation,
    attemptConsumed: true,
    readback: desiredExact ? 'desired_exact' : 'not_desired',
    ...(options.draftRepairAdmission ? { draftRepairAdmission: options.draftRepairAdmission } : {}),
    ...(desiredExact
      ? {}
      : {
          error: {
            message:
              'A prior protected request was emitted without a terminal desired-exact readback; the action is UNKNOWN and will never be replayed.',
          },
        }),
  });
}

async function readbackIsDesiredExact(options: {
  client: SupabaseDataClient;
  restBaseUrl: string;
  action: DatasetSaveDraftExecutionAction;
  contract: DatasetSaveDraftExecutionContract;
}): Promise<boolean> {
  try {
    return exactDesiredReadback({
      rows: await exactExecutionRows({
        client: options.client,
        restBaseUrl: options.restBaseUrl,
        table: options.action.table,
        id: options.action.id,
        version: options.action.version,
      }),
      action: options.action,
      contract: options.contract,
    });
  } catch {
    return false;
  }
}

function normalizeExecutionMaxParallel(value: number | null | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 8) {
    executionContractError('Execution contract --max-parallel must be an integer from 1 to 8.');
  }
  return normalized;
}

function executionSerialPrefixLength(contract: DatasetSaveDraftExecutionContract): number {
  const actionIndexes = new Map(
    contract.actions.map((action, index) => [action.action_id, index] as const),
  );
  let highestDependencyIndex = -1;
  for (const action of contract.actions) {
    for (const dependencyActionId of action.dependency_action_ids) {
      highestDependencyIndex = Math.max(
        highestDependencyIndex,
        actionIndexes.get(dependencyActionId) as number,
      );
    }
  }
  return highestDependencyIndex + 1;
}

function assertParallelSuffixTargetsAreUnique(
  contract: DatasetSaveDraftExecutionContract,
  serialPrefixLength: number,
): void {
  const targets = new Set<string>();
  for (const action of contract.actions.slice(serialPrefixLength)) {
    const target = `${action.table}\u0000${action.id}\u0000${action.version}`;
    if (targets.has(target)) {
      executionContractError(
        'Execution contract parallel suffix contains a repeated table/id/version target.',
      );
    }
    targets.add(target);
  }
}

function executionReferenceTargetKey(reference: {
  table: string | null;
  id: string | null;
  version: string | null;
}): string {
  return JSON.stringify([reference.table, reference.id, reference.version]);
}

/**
 * Dataset identities that this action may legitimately still be missing because earlier actions of
 * the same contract insert them. The walk follows only declared earlier dependencies, which the
 * contract parser already restricts to unique, acyclic, backward references.
 */
function dryRunPendingInsertTargets(
  contract: DatasetSaveDraftExecutionContract,
  action: DatasetSaveDraftExecutionAction,
): Set<string> {
  const byId = new Map(contract.actions.map((entry) => [entry.action_id, entry] as const));
  const targets = new Set<string>();
  const pending = [...action.dependency_action_ids];
  while (pending.length > 0) {
    const dependency = byId.get(pending.pop() as string) as DatasetSaveDraftExecutionAction;
    if (dependency.expected_operation === 'insert') {
      targets.add(
        executionReferenceTargetKey({
          table: dependency.table,
          id: dependency.id,
          version: dependency.version,
        }),
      );
    }
    pending.push(...dependency.dependency_action_ids);
  }
  return targets;
}

function executionBatchActionContent(action: DatasetSaveDraftExecutionAction): BatchJsonValue {
  return {
    action_id: action.action_id,
    desired_sha256: action.desired_sha256,
    expected_operation: action.expected_operation,
    table: action.table,
    id: action.id,
    version: action.version,
    before_sha256: action.before_sha256,
    dependency_action_ids: [...action.dependency_action_ids],
  };
}

async function renewExecutionOwnerToken(options: {
  runtime: SupabaseDataRuntime;
  commandTransport: NonNullable<Awaited<ReturnType<typeof buildDatasetCommandTransport>>>;
  contract: DatasetSaveDraftExecutionContract;
}): Promise<void> {
  const accessToken = options.runtime.refreshAccessToken
    ? await options.runtime.refreshAccessToken()
    : await options.runtime.getAccessToken();
  const actor = decodeExecutionActor(accessToken);
  if (
    actor.user_id !== options.contract.owner.user_id ||
    actor.email !== options.contract.owner.email
  ) {
    executionContractError('Renewed owner session does not match the execution contract.');
  }
  options.commandTransport.accessToken = accessToken;
}

async function runExecutionContractBatch(options: {
  contractPath: string;
  contract: DatasetSaveDraftExecutionContract;
  preparedRows: PreparedDatasetRow[];
  allowReferenceOnlySupport: boolean;
  files: DatasetSaveDraftReport['files'];
  inputPath: string;
  requestedType: DatasetSaveDraftType;
  outDir: string;
  env: NodeJS.ProcessEnv;
  runtime: SupabaseDataRuntime;
  commandTransport: NonNullable<Awaited<ReturnType<typeof buildDatasetCommandTransport>>>;
  dataClient: NonNullable<ReturnType<typeof createSupabaseDataClient>>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: () => string;
  maxParallel: number;
  mode: 'commit' | 'dry_run';
}): Promise<DatasetSaveDraftReport> {
  const contractSha256 = sha256Json(options.contract);
  const ledgerRoot = executionLedgerRoot(options.env, options.contract);
  // Both modes read attempt state read-only (`loadExecutionLedger` only computes paths and reads
  // existing JSONL files; it never creates a directory or event). A dry-run must see a retained
  // attempt or outcome and report it as retained rather than re-authorize it as prepared.
  const ledger: ExecutionLedgerState = loadExecutionLedger(ledgerRoot, options.contract);
  const actor = decodeExecutionActor(options.commandTransport.accessToken);
  if (
    projectRefFromApiBaseUrl(options.runtime.apiBaseUrl) !== options.contract.project_ref ||
    actor.user_id !== options.contract.owner.user_id ||
    actor.email !== options.contract.owner.email
  ) {
    executionContractError('Owner session or project does not match the execution contract.');
  }
  if (options.mode === 'commit') {
    options.files.execution_ledger = ledgerRoot;
  }
  const serialPrefixLength = executionSerialPrefixLength(options.contract);
  if (options.maxParallel > 1) {
    assertParallelSuffixTargetsAreUnique(options.contract, serialPrefixLength);
  }
  const reports: Array<DatasetSaveDraftRowReport | undefined> = new Array(
    options.contract.actions.length,
  );
  const statuses = new Map<string, DatasetSaveDraftRowReport['status']>();
  const referenceOnlySupportCache = new Map<string, Promise<RemoteDatasetLookup>>();

  const executeAction = async (index: number): Promise<void> => {
    const action = options.contract.actions[index] as DatasetSaveDraftExecutionAction;
    const row = options.preparedRows[index] as PreparedDatasetRow;
    const storeReport = (report: DatasetSaveDraftRowReport): void => {
      reports[index] = report;
      statuses.set(action.action_id, report.status);
    };
    const preparedFailure = buildPreparedFailure(row, options.allowReferenceOnlySupport);
    if (options.mode === 'dry_run') {
      // Retained evidence is read-only in a preflight: an action that already owns an attempt or
      // outcome is never re-authorized as prepared, and it is never reported as executed either.
      const retainedOutcome = ledger.outcomes.get(action.action_id);
      const retainedAttempt = ledger.attempts.get(action.action_id);
      if (retainedOutcome || retainedAttempt) {
        storeReport(
          contractRowReport({
            row,
            action,
            status: 'blocked',
            operation: retainedOutcome ? 'retained_outcome' : 'retained_attempt',
            attemptConsumed: true,
            readback: 'not_performed',
            error: {
              message: retainedOutcome
                ? 'Terminal attempt evidence already exists for this action; a dry-run preflight cannot re-authorize it.'
                : 'An unresolved attempt already exists for this action; it must be resolved by readback before any new plan.',
              details: { retained: retainedOutcome ? 'outcome' : 'attempt' },
            },
          }),
        );
        return;
      }
    }

    // Recovery returns the admission bound to the original attempt; it is never re-derived from a
    // fresh read that may already hold the desired content.
    const recoveredAdmission = ledger.attempts.get(action.action_id)?.draft_repair_admission;

    const priorOutcome = ledger.outcomes.get(action.action_id);
    if (priorOutcome) {
      const desiredStillExact =
        priorOutcome.outcome === 'executed' &&
        (await readbackIsDesiredExact({
          client: options.dataClient.client,
          restBaseUrl: options.dataClient.restBaseUrl,
          action,
          contract: options.contract,
        }));
      const status = desiredStillExact ? 'executed' : 'unknown';
      const report = contractRowReport({
        row,
        action,
        status,
        operation: action.expected_operation,
        attemptConsumed: true,
        readback: desiredStillExact ? 'desired_exact' : 'not_desired',
        ...(recoveredAdmission ? { draftRepairAdmission: recoveredAdmission } : {}),
        ...(status === 'unknown'
          ? {
              error: {
                message:
                  priorOutcome.outcome === 'unknown'
                    ? 'Terminal UNKNOWN action retained; replay is forbidden.'
                    : 'A terminal success no longer has exact desired owner readback; replay is forbidden.',
              },
            }
          : {}),
      });
      storeReport(report);
      return;
    }

    if (ledger.attempts.has(action.action_id)) {
      const report = await finalizeAttemptedAction({
        row,
        action,
        contract: options.contract,
        contractSha256,
        ledgerRoot,
        ledger,
        client: options.dataClient.client,
        restBaseUrl: options.dataClient.restBaseUrl,
        now: options.now,
        recovered: true,
        ...(recoveredAdmission ? { draftRepairAdmission: recoveredAdmission } : {}),
      });
      storeReport(report);
      return;
    }

    // Validation and policy classification come after every retained-attempt decision above: an
    // already consumed attempt must never be reported as an unconsumed preparation failure.
    const repairCandidate = Boolean(
      preparedFailure &&
      isProcessMetadataRepairCandidate({
        operation: action.expected_operation,
        table: action.table,
        validation: row.validation,
      }),
    );
    if (preparedFailure && !repairCandidate) {
      const report = {
        ...preparedFailure,
        action_id: action.action_id,
        desired_sha256: action.desired_sha256,
        attempt_consumed: false,
        replayed: false as const,
        readback: 'not_performed' as const,
      };
      storeReport(report);
      return;
    }

    const blockingDependencies = action.dependency_action_ids.filter((dependency) => {
      const dependencyStatus = statuses.get(dependency);
      // A commit still requires each dependency to be a terminal success. A dry run cannot execute
      // anything, so an action prepared earlier in this same preflight satisfies its dependents;
      // failed, blocked or retained dependencies keep blocking their descendants.
      return options.mode === 'dry_run'
        ? dependencyStatus !== 'prepared'
        : dependencyStatus !== 'executed';
    });
    if (blockingDependencies.length > 0) {
      const report = contractRowReport({
        row,
        action,
        status: 'blocked',
        operation: 'blocked_dependency',
        attemptConsumed: false,
        readback: 'not_performed',
        error: {
          message:
            options.mode === 'dry_run'
              ? 'Action dependencies are not prepared in this preflight; no request was emitted.'
              : 'Action dependencies are not terminal successes; no request was emitted.',
          details: { dependency_action_ids: blockingDependencies },
        },
      });
      storeReport(report);
      return;
    }

    let beforeRows: ExecutionDatasetRow[];
    let transportFailed = false;
    let beforeImage: JsonObject | null = null;
    try {
      beforeRows = await exactExecutionRows({
        client: options.dataClient.client,
        restBaseUrl: options.dataClient.restBaseUrl,
        table: action.table,
        id: action.id,
        version: action.version,
      });
      const before = beforeRows[0];
      beforeImage = beforeRows.length === 1 ? (before as ExecutionDatasetRow).json_ordered : null;
      const observedOperation = beforeRows.length === 0 ? 'insert' : 'save_draft';
      const beforeExact = Boolean(
        beforeRows.length === 1 &&
        before &&
        before.id === action.id &&
        before.version === action.version &&
        before.user_id === options.contract.owner.user_id &&
        before.state_code === 0 &&
        before.json_ordered &&
        sha256Json(before.json_ordered) === action.before_sha256,
      );
      if (
        beforeRows.length > 1 ||
        observedOperation !== action.expected_operation ||
        (observedOperation === 'save_draft' && !beforeExact)
      ) {
        throw new CliError('Execution action before-state or expected operation drifted.', {
          code: 'DATASET_SAVE_DRAFT_EXECUTION_BEFORE_DRIFT',
          exitCode: 1,
        });
      }
      if (row.type === 'flow') {
        const unresolvedReferences = await missingFlowRemoteReferences({
          runtime: options.runtime,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          cache: referenceOnlySupportCache,
          payload: row.payload,
        });
        if (unresolvedReferences.length > 0) {
          if (options.mode === 'dry_run') {
            // A preflight never invents remote rows. When every still-missing reference is a
            // dataset an earlier action of this contract inserts, the action is honestly blocked
            // on that dependency instead of being failed or faked as prepared.
            const pendingInsertTargets = dryRunPendingInsertTargets(options.contract, action);
            const pendingReferences = unresolvedReferences.filter((reference) =>
              pendingInsertTargets.has(executionReferenceTargetKey(reference)),
            );
            if (pendingReferences.length === unresolvedReferences.length) {
              storeReport(
                contractRowReport({
                  row,
                  action,
                  status: 'blocked',
                  operation: 'blocked_dependency',
                  attemptConsumed: false,
                  readback: 'not_performed',
                  error: {
                    message:
                      'A referenced dataset is created by an earlier action of this contract; the preflight cannot prove it before that action executes.',
                    details: { references: pendingReferences },
                  },
                }),
              );
              return;
            }
          }
          throw new CliError('Flow execution action has unresolved remote references.', {
            code: 'DATASET_SAVE_DRAFT_REMOTE_REFERENCE_UNRESOLVED',
            exitCode: 1,
            details: { references: unresolvedReferences },
          });
        }
      }
      await renewExecutionOwnerToken({
        runtime: options.runtime,
        commandTransport: options.commandTransport,
        contract: options.contract,
      });
    } catch (error) {
      const report = contractRowReport({
        row,
        action,
        status: 'failed',
        operation: action.expected_operation,
        attemptConsumed: false,
        readback: 'not_performed',
        error: serializeError(error),
      });
      storeReport(report);
      return;
    }

    // The bounded Process metadata repair decides only here, against the complete before image
    // this run just read and proved owner/state-0/before-hash for.
    let draftRepairAdmission: DraftRepairAdmission | undefined;
    if (repairCandidate) {
      const outcome = evaluateProcessMetadataRepairAdmission({
        before: beforeImage,
        candidate: row.payload,
        // The stored draft is verified with the same real validator the candidate uses, on a
        // clone, so a before with any other error is refused and its exact bytes cannot change.
        beforeValidation: validatePayload(
          structuredClone(beforeImage as JsonObject),
          'process',
          DATASET_CONFIGS.process,
        ),
        beforeSha256: sha256Json(beforeImage as JsonObject),
        desiredSha256: action.desired_sha256,
      });
      if (outcome.status !== 'admitted') {
        storeReport(
          contractRowReport({
            row,
            action,
            status: 'failed',
            operation: action.expected_operation,
            attemptConsumed: false,
            readback: 'not_performed',
            error: {
              message: outcome.message,
              details: { code: outcome.code, ...outcome.details },
            },
          }),
        );
        return;
      }
      draftRepairAdmission = outcome.admission;
    }

    if (options.mode === 'dry_run') {
      // Preflight evidence only: this run verified the exact contract, owner, draft state and
      // before/content binding. Nothing is dispatched, no attempt is consumed, and the row can
      // never read back as executed.
      storeReport(
        contractRowReport({
          row,
          action,
          status: 'prepared',
          operation: 'would_sync',
          attemptConsumed: false,
          readback: 'not_performed',
          ...(draftRepairAdmission ? { draftRepairAdmission } : {}),
          visibleRow: beforeRows.length
            ? {
                id: beforeRows[0]!.id,
                version: beforeRows[0]!.version,
                user_id: beforeRows[0]!.user_id,
                state_code: beforeRows[0]!.state_code,
              }
            : null,
        }),
      );
      return;
    }

    try {
      const beforeDispatch = () => {
        appendExecutionEvent({
          ledgerRoot,
          ledger,
          contractSha256,
          action,
          eventType: 'attempt_emitted',
          outcome: null,
          recovered: false,
          recordedAtUtc: options.now(),
          ...(draftRepairAdmission ? { draftRepairAdmission } : {}),
        });
      };
      if (action.expected_operation === 'insert') {
        await createDatasetRecord({
          transport: options.commandTransport,
          table: action.table,
          id: action.id,
          payload: row.payload,
          extraData: { ruleVerification: true },
          beforeDispatch,
        });
      } else {
        // The before-state check above proved one exact owner state-0 row whose stored
        // json_ordered matched this action's before hash in this run; that same object is the
        // transport's complete before image. A guard conflict is terminal: no fallback, no retry.
        await saveDraftDatasetRecord({
          transport: options.commandTransport,
          table: action.table,
          id: action.id,
          version: action.version,
          payload: row.payload,
          expectedJsonOrdered: beforeImage as JsonObject,
          // Only the bounded metadata repair writes without the platform rule-verification flag;
          // it is exactly the case whose authoring evidence gap the admission records.
          extraData: { ruleVerification: draftRepairAdmission === undefined },
          beforeDispatch,
        });
      }
    } catch (error) {
      if (error instanceof CliError && error.code === 'DATASET_COMMAND_BEFORE_DISPATCH_FAILED') {
        throw error;
      }
      // Once emission is durably recorded, transport outcomes are resolved by readback only.
      transportFailed = true;
    }
    const report = await finalizeAttemptedAction({
      row,
      action,
      contract: options.contract,
      contractSha256,
      ledgerRoot,
      ledger,
      client: options.dataClient.client,
      restBaseUrl: options.dataClient.restBaseUrl,
      now: options.now,
      recovered: transportFailed,
      ...(draftRepairAdmission ? { draftRepairAdmission } : {}),
    });
    storeReport(report);
  };

  if (options.mode === 'dry_run') {
    // A preflight stays serial in contract order: it dispatches nothing, takes no scheduler
    // claim or run lock, and keeps dependency-bearing actions deferred.
    for (let index = 0; index < options.contract.actions.length; index += 1) {
      await executeAction(index);
    }
  } else {
    for (let index = 0; index < serialPrefixLength; index += 1) {
      await executeAction(index);
    }

    const parallelIndexes = options.contract.actions
      .slice(serialPrefixLength)
      .map((_action, suffixIndex) => serialPrefixLength + suffixIndex);
    const parallelBatch = await runBoundedBatch({
      contract: createBatchContract({
        identity: {
          schema: 'dataset-save-draft.parallel-suffix.v1',
          execution_id: options.contract.execution_id,
          contract_sha256: contractSha256,
        },
        content: parallelIndexes.map((index) =>
          executionBatchActionContent(
            options.contract.actions[index] as DatasetSaveDraftExecutionAction,
          ),
        ),
        policy: {
          max_parallel: options.maxParallel,
          serial_prefix_actions: serialPrefixLength,
          mutation_retry: 'none',
          fatal_stop: true,
        },
      }),
      items: parallelIndexes,
      getItemIdentity: (index) =>
        (options.contract.actions[index] as DatasetSaveDraftExecutionAction).action_id,
      projectItemContent: (index) =>
        executionBatchActionContent(
          options.contract.actions[index] as DatasetSaveDraftExecutionAction,
        ),
      projectItemPolicy: (index) => {
        const action = options.contract.actions[index] as DatasetSaveDraftExecutionAction;
        return {
          contract_sha256: contractSha256,
          target_mode: 'owner_draft',
          expected_operation: action.expected_operation,
        };
      },
      getExclusiveKey: ({ item: index }) => {
        const action = options.contract.actions[index] as DatasetSaveDraftExecutionAction;
        return JSON.stringify([action.table, action.id, action.version]);
      },
      mode: 'mutation',
      maxConcurrency: options.maxParallel,
      execute: async ({ item: index }) => executeAction(index),
      shouldStop: ({ last_result: lastResult }) => lastResult.status === 'failed',
    });
    const fatalWorkerResult = parallelBatch.results_completion_order.find(
      (result) => result.status === 'failed',
    );
    if (fatalWorkerResult?.status === 'failed') {
      throw fatalWorkerResult.error;
    }
  }

  const completedReports = reports as DatasetSaveDraftRowReport[];
  const failures = completedReports.filter((row) =>
    ['failed', 'unknown', 'blocked'].includes(row.status),
  );
  writeJsonLinesArtifact(options.files.progress_jsonl, completedReports);
  writeJsonLinesArtifact(options.files.failures_jsonl, failures);
  const unknown = completedReports.filter((row) => row.status === 'unknown').length;
  const failed = completedReports.filter((row) => row.status === 'failed').length;
  const blocked = completedReports.filter((row) => row.status === 'blocked').length;
  const report: DatasetSaveDraftReport = {
    schema_version: 2,
    generated_at_utc: options.now(),
    input_path: options.inputPath,
    requested_type: options.requestedType,
    out_dir: options.outDir,
    commit: options.mode === 'commit',
    mode: options.mode,
    status:
      unknown > 0
        ? 'completed_with_unknowns'
        : failed + blocked > 0
          ? 'completed_with_failures'
          : 'completed',
    counts: {
      selected: options.preparedRows.length,
      prepared: 0,
      executed: completedReports.filter((row) => row.status === 'executed').length,
      failed,
      unknown,
      blocked,
      attempts_consumed: ledger.attempts.size,
      by_table: byTable(options.preparedRows),
      operations: operationCount(completedReports),
    },
    files: options.files,
    rows: completedReports,
    execution_contract: {
      path: path.resolve(options.contractPath),
      sha256: contractSha256,
      execution_id: options.contract.execution_id,
      target_mode: 'owner_draft',
      max_parallel: options.maxParallel,
      serial_prefix_actions: serialPrefixLength,
      parallel_suffix_actions: options.contract.actions.length - serialPrefixLength,
    },
  };
  writeJsonArtifact(options.files.summary_json, report);
  return report;
}

export async function runDatasetSaveDraft(
  options: RunDatasetSaveDraftOptions,
): Promise<DatasetSaveDraftReport> {
  const now = options.now ?? new Date();
  const inputPath = path.resolve(options.inputPath);
  const commit = options.commit === true;
  const allowReferenceOnlySupport =
    options.allowReferenceOnlySupport === true ||
    (options.env?.TIANGONG_ALLOW_ACCOUNT_LOCAL_SUPPORT ?? '') === '1';
  const requestedType = normalizeType(options.type, allowReferenceOnlySupport);
  const outDir = path.resolve(options.outDir ?? defaultOutDir(inputPath, commit, now));
  const files = buildFiles(outDir);
  const preparedRows = prepareRows(inputPath, options.rawInput, requestedType);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxParallel = normalizeExecutionMaxParallel(options.maxParallel);
  const executionContractPath = options.executionContractPath
    ? path.resolve(options.executionContractPath)
    : null;
  const executionContract = executionContractPath
    ? parseExecutionContract(
        readJsonFile(executionContractPath, 'Dataset save-draft execution contract'),
      )
    : null;

  if (executionContract && !commit && maxParallel !== 1) {
    executionContractError('--max-parallel greater than 1 requires --commit.');
  }
  if (!executionContract && maxParallel !== 1) {
    executionContractError('--max-parallel greater than 1 requires --execution-contract.');
  }
  if (executionContract) {
    bindExecutionContractRows(executionContract, preparedRows);
  }

  // An execution contract always needs real auth and REST bindings: a commit dispatches guarded
  // owner writes, and a dry-run preflights the exact owner/draft/before state against the platform.
  const needsRuntime = commit || Boolean(executionContract);
  if (needsRuntime && (!options.env || !options.fetchImpl)) {
    throw new CliError('Dataset save-draft execution requires env and fetch runtime bindings.', {
      code: 'DATASET_SAVE_DRAFT_RUNTIME_REQUIRED',
      exitCode: 2,
    });
  }

  writeJsonLinesArtifact(files.selected_rows, preparedRows.map(selectedRow));

  const runtime =
    needsRuntime && options.env && options.fetchImpl
      ? createSupabaseDataRuntime({
          runtime: requireSupabaseRestRuntime(options.env),
          fetchImpl: options.fetchImpl,
          timeoutMs,
        })
      : null;
  const commandTransport =
    runtime && options.fetchImpl
      ? await buildDatasetCommandTransport({
          runtime,
          fetchImpl: options.fetchImpl,
          timeoutMs,
        })
      : null;
  const dataClient =
    runtime && options.fetchImpl
      ? createSupabaseDataClient(runtime, options.fetchImpl, timeoutMs)
      : null;
  const referenceOnlySupportCache = new Map<string, Promise<RemoteDatasetLookup>>();

  if (executionContract && executionContractPath) {
    return runExecutionContractBatch({
      contractPath: executionContractPath,
      contract: executionContract,
      preparedRows,
      allowReferenceOnlySupport,
      files,
      inputPath,
      requestedType,
      outDir,
      env: options.env!,
      runtime: runtime!,
      commandTransport: commandTransport!,
      dataClient: dataClient!,
      fetchImpl: options.fetchImpl!,
      timeoutMs,
      now: () => now.toISOString(),
      maxParallel,
      mode: commit ? 'commit' : 'dry_run',
    });
  }

  const reports: DatasetSaveDraftRowReport[] = [];
  for (const row of preparedRows) {
    const preparedFailure = buildPreparedFailure(row, allowReferenceOnlySupport);
    if (preparedFailure) {
      reports.push(preparedFailure);
      continue;
    }

    const baseReport: DatasetSaveDraftRowReport = {
      index: row.index,
      id: row.id,
      version: row.version,
      type: row.type,
      table: row.config!.table,
      status: 'prepared',
      operation: 'would_sync',
      validation: row.validation,
    };

    if (!commit) {
      reports.push(baseReport);
      continue;
    }

    try {
      const visibleRows = await exactVisibleRows({
        client: dataClient!.client,
        restBaseUrl: dataClient!.restBaseUrl,
        table: row.config!.table,
        id: row.id!,
        version: row.version!,
      });
      const visibleRow = visibleRows[0] ?? null;
      if (row.type === 'flow') {
        if (!visibleRow && isElementaryFlowPayload(row.payload) && !allowReferenceOnlySupport) {
          reports.push({
            ...baseReport,
            status: 'failed',
            operation: 'elementary_flow_insert_blocked',
            visible_row: null,
            error: {
              message:
                'Elementary flows are reference-only for dataset save-draft. Resolve the flow with remote hybrid search and reference the existing database row instead of creating a My Data flow.',
              details: {
                code: 'DATASET_SAVE_DRAFT_ELEMENTARY_FLOW_INSERT_BLOCKED',
              },
            },
          });
          continue;
        }

        const unresolvedReferences = await missingFlowRemoteReferences({
          runtime: runtime!,
          fetchImpl: options.fetchImpl!,
          timeoutMs,
          cache: referenceOnlySupportCache,
          payload: row.payload,
        });
        if (unresolvedReferences.length > 0) {
          reports.push({
            ...baseReport,
            status: 'failed',
            operation: 'remote_reference_unresolved',
            visible_row: visibleRow,
            error: {
              message:
                'Flow save-draft commit requires all referenced datasets to already resolve in the remote database.',
              details: {
                code: 'DATASET_SAVE_DRAFT_REMOTE_REFERENCE_UNRESOLVED',
                references: unresolvedReferences,
              },
            },
          });
          continue;
        }
      }
      if (visibleRow) {
        await saveDraftDatasetRecord({
          transport: commandTransport!,
          table: row.config!.table,
          id: row.id!,
          version: row.version!,
          payload: row.payload,
          extraData: { ruleVerification: true },
        });
        reports.push({
          ...baseReport,
          status: 'executed',
          operation: 'save_draft',
          visible_row: visibleRow,
        });
      } else {
        await createDatasetRecord({
          transport: commandTransport!,
          table: row.config!.table,
          id: row.id!,
          payload: row.payload,
          extraData: { ruleVerification: true },
        });
        reports.push({
          ...baseReport,
          status: 'executed',
          operation: 'insert',
          visible_row: null,
        });
      }
    } catch (error) {
      reports.push({
        ...baseReport,
        status: 'failed',
        error: serializeError(error),
      });
    }
  }

  const failures = reports.filter((row) => row.status === 'failed');
  writeJsonLinesArtifact(files.progress_jsonl, reports);
  writeJsonLinesArtifact(files.failures_jsonl, failures);

  const report: DatasetSaveDraftReport = {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    input_path: inputPath,
    requested_type: requestedType,
    out_dir: outDir,
    commit,
    mode: commit ? 'commit' : 'dry_run',
    status: failures.length > 0 ? 'completed_with_failures' : 'completed',
    counts: {
      selected: preparedRows.length,
      prepared: reports.filter((row) => row.status === 'prepared').length,
      executed: reports.filter((row) => row.status === 'executed').length,
      failed: failures.length,
      by_table: byTable(preparedRows),
      operations: operationCount(reports),
    },
    files,
    rows: reports,
  };

  writeJsonArtifact(files.summary_json, report);
  return report;
}

export const __testInternals = {
  DATASET_CONFIGS,
  buildFiles,
  buildPreparedFailure,
  buildVisibleRowsUrl,
  byTable,
  compareVersions,
  defaultOutDir,
  detectType,
  decodeExecutionActor,
  bindExecutionContractRows,
  executionLedgerRoot,
  executionLedgerPath,
  executionActionBindingSha256,
  loadExecutionLedger,
  exactDesiredReadback,
  extractIdentity,
  flowType,
  isElementaryFlowPayload,
  isLookupableRemoteReference,
  missingFlowRemoteReferences,
  normalizeValidationIssue,
  normalizeType,
  operationCount,
  parseVisibleRows,
  parseExecutionContract,
  parseExecutionRows,
  parseLedgerEvent,
  projectRefFromApiBaseUrl,
  prepareRows,
  remoteReferenceFallbackKey,
  selectedRow,
  serializeError,
  supportLookupKey,
  unwrapPayload,
  uniqueFlowRemoteReferences,
  validatePayload,
};
