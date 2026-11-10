import { isJsonObject } from './maintenance/contract/values.js';
import { sha256Json } from './canonical-json-hash.js';
import {
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from './maintenance/contract/types.js';
import { CliError } from '../shared/errors.js';
import {
  assertFlowIdentityWireJson,
  flowIdentityRestrictedSha256,
  isStandardFlowIdentityShortDescription,
  type StandardStMultiLang,
} from './dataset-maintenance-flow-identity-wire.js';

export const FLOW_IDENTITY_SOURCE_COUNT = 305;
export const FLOW_IDENTITY_REFERENCE_FIELDS = [
  '@refObjectId',
  '@type',
  '@uri',
  '@version',
  'common:shortDescription',
] as const;

export const HISTORICAL_FLOW_IDENTITY_AUTHORITY_SHA256 = new Set([
  '70fc59ec2fc6059d5c38f7e36aad0d83e977244f84d2e618da9a964d8b8bcb24',
  '6de26ed76f41f9fd37473fd1eb2ba34084ad28a273db01d97d97b434c38c5a9a',
  '1ea6b533cd2e0b7ac75c72bdc2140cb64dac3422deb25c1f880795c42a5b9505',
  'cc0d2c13763666be51a837c87c013ff7d6b9a2a2a141fa3f14bffb07b7429829',
  '06f81114f6a6c473d401612b16594ee15f017e9f627ac7189ccf7b94d32dcd58',
]);

const HISTORICAL_APPROVAL_PATTERN =
  /^APPROVE BAFU STEP3 (?:LEGACY TARGET POLICY|EVIDENCE RESOLUTION)(?: V2)? /u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{3}$/u;
const POSTGREST_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00:00$/u;

export type FlowIdentityDirection = 'Input' | 'Output';
export type FlowIdentityDisposition = 'map_public' | 'pending' | 'blocker' | 'orphan';
export type FlowIdentityArtifactSha256 = string;
export type FlowIdentityDbOpaqueSha256 = string;
export type FlowIdentitySharedRequestSha256 = string;

export type FlowIdentityReference = {
  '@refObjectId': string;
  '@type': 'flow data set';
  '@uri': string;
  '@version': string;
  'common:shortDescription': StandardStMultiLang;
};

export type FlowIdentityCompatibilityPolicy = {
  schema_version: 'dataset-flow-identity-compatibility-policy.v1';
  policy_sha256: string;
  evidence_resolution_sha256: string;
  approved_at_utc: string;
  approval_text_sha256: string;
};

export type FlowIdentityReviewEntry = {
  source: { id: string; version: string };
  disposition: FlowIdentityDisposition;
  target: { id: string; version: string; reference: FlowIdentityReference } | null;
  allowed_directions: FlowIdentityDirection[];
  source_trace_sha256: string;
  compartment_evidence_sha256: string;
  decision_evidence_sha256: string;
};

export type FlowIdentityReviewLedger = {
  schema_version: 'dataset-flow-identity-review-ledger.v3';
  generated_at_utc: string;
  source_count: 305;
  review_evidence_sha256: string;
  execution_authority: false;
  entries: FlowIdentityReviewEntry[];
  ledger_sha256: string;
};

export type FlowIdentityCaptureAttestation = {
  ok: true;
  command: 'cmd_dataset_flow_identity_capture_attest_guarded';
  schema_version: 'dataset-flow-identity-capture-attest-result.v2';
  proof_domain: 'dataset-flow-identity-db-proof.v2';
  receipt_id: string;
  receipt_proof_sha256: FlowIdentityDbOpaqueSha256;
  operation_id: string;
  environment: 'production' | 'preview' | 'local';
  project_ref: string;
  captured_at: string;
  expires_at: string;
  source_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  support_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  target_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  mapping_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  process_intent_set_sha256: FlowIdentityDbOpaqueSha256;
  protected_closure_sha256: FlowIdentityDbOpaqueSha256;
  whole_scope_proof_sha256: FlowIdentityDbOpaqueSha256;
  policy_sha256: FlowIdentityDbOpaqueSha256;
  policy_approval_text_sha256: FlowIdentityDbOpaqueSha256;
  source_count: 305;
  target_count: number;
  support_count: number;
  mapping_count: number;
  process_count: number;
  rewrite_count: number;
  capture_request_sha256: FlowIdentitySharedRequestSha256;
  replay: boolean;
};

export type FlowIdentityCaptureRequest = {
  schema_version: 'dataset-flow-identity-capture-attest.v2';
  request_id: string;
  environment: 'production' | 'preview' | 'local';
  project_ref: string;
  actor: { user_id: string; email: string };
  target_visibility: 'owner_draft';
  operation_id: string;
  compatibility_policy: FlowIdentityCompatibilityPolicy;
  artifact_evidence: {
    review_ledger_sha256: FlowIdentityArtifactSha256;
    live_capture_artifact_sha256: FlowIdentityArtifactSha256;
    toolchain_evidence_sha256: FlowIdentityArtifactSha256;
  };
  mappings: JsonObject[];
  process_intents: JsonObject[];
  protected_closure: JsonObject;
};

export type FlowIdentityCaptureCompleteness = {
  schema_version: 'dataset-flow-identity-capture-completeness.v2';
  source_count: 305;
  target_count: number;
  support_count: number;
  owner_draft_process_count: number;
  owner_draft_process_scan: JsonObject;
};

export type FlowIdentityLiveCapture = {
  schema_version: 'dataset-flow-identity-live-capture.v2';
  captured_at_utc: string;
  environment: 'production' | 'preview' | 'local';
  project_ref: string;
  account: { user_id: string; email: string };
  prerequisites: {
    step2_readback_sha256: string;
    step2_completed_at_utc: string;
    issue29_target1_readback_sha256: string;
    issue29_target1_completed_at_utc: string;
    issue29_target2_readback_sha256: string;
    issue29_target2_completed_at_utc: string;
  };
  sdk: { package: '@tiangong-lca/tidas-sdk'; version: string };
  artifact_evidence: {
    review_ledger_sha256: FlowIdentityArtifactSha256;
    live_capture_artifact_sha256: FlowIdentityArtifactSha256;
    toolchain_evidence_sha256: FlowIdentityArtifactSha256;
  };
  completeness: FlowIdentityCaptureCompleteness;
  source_rows: DatasetMaintenanceRowSnapshot[];
  target_rows: DatasetMaintenanceRowSnapshot[];
  support_rows: DatasetMaintenanceRowSnapshot[];
  process_rows: DatasetMaintenanceRowSnapshot[];
  capture_request: FlowIdentityCaptureRequest;
  attestation: FlowIdentityCaptureAttestation;
  capture_artifact_sha256: FlowIdentityArtifactSha256;
};

export type FlowIdentityMappingEndpoint = {
  id: string;
  version: string;
  user_id: string;
  state_code: number;
  modified_at: string;
  payload_sha256: string;
  row_sha256: string;
  flow_type: 'Elementary flow';
  flow_property_id: string;
  flow_property_version: string;
  unit_group_id: string;
  unit_group_version: string;
  category_path_sha256: string;
};

export type FlowIdentityMapping = {
  ordinal: number;
  mapping_id: string;
  source: FlowIdentityMappingEndpoint & { source_trace_sha256: string };
  target: FlowIdentityMappingEndpoint & { reference: FlowIdentityReference };
  compatibility: {
    policy_sha256: string;
    mode: 'identity';
    confidence: 'approved';
    flow_property_compatible: true;
    unit_group_compatible: true;
    direction_compatible: true;
    compartment_compatible: true;
    conversion_factor: '1';
    evidence_sha256: string;
    flow_schema: {
      status: 'pass' | 'legacy_warning';
      warning_set_sha256: string;
    };
    process_schema_required: 'pass';
  };
};

export type FlowIdentitySupportSnapshot = {
  ordinal: number;
  table: 'flowproperties' | 'unitgroups';
  id: string;
  version: string;
  user_id: string;
  state_code: 0 | 100;
  modified_at: string;
  payload_sha256: string;
  row_sha256: string;
};

export type FlowIdentityProcessManifest = {
  ordinal: number;
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  modified_at: string;
  model_id: string | null;
  rule_verification: boolean | null;
  before_row_sha256: string;
  before_payload_sha256: string;
  before_exchange_set_sha256: string;
  before_exchange_count: number;
  desired_payload_sha256: string;
  desired_exchange_set_sha256: string;
  rewrite_count: number;
  process_template_sha256: string;
  rewrite_set_sha256: string;
  collision_ledger_sha256: string;
  process_schema: { status: 'pass'; evidence_sha256: string };
  pending_blocker_closure_sha256: string;
};

export type FlowIdentityRewrite = {
  ordinal: number;
  exchange_index: number;
  internal_id: string;
  direction: FlowIdentityDirection;
  mapping_id: string;
  source_reference: FlowIdentityReference;
  target_reference: FlowIdentityReference;
  before_reference_sha256: string;
  after_reference_sha256: string;
};

export type FlowIdentityCollisionEntry = {
  target_id: string;
  target_version: string;
  exchange_indexes: number[];
  internal_ids: Array<string | null>;
  mapping_ids: Array<string | null>;
  preserve_rows: true;
};

export type FlowIdentityCollisionLedger = {
  schema_version: 'dataset-flow-identity-collision-ledger.v1';
  entries: FlowIdentityCollisionEntry[];
};

export type FlowIdentityOccurrence = {
  process_id: string;
  process_version: string;
  exchange_index: number;
  internal_id: string;
  direction: FlowIdentityDirection;
  reference_sha256: string;
};

export type FlowIdentityProtectedReferenceEntry = {
  source_id: string;
  source_version: string;
  expected_reference_count: number;
  occurrences: FlowIdentityOccurrence[];
  occurrence_set_sha256: string;
  evidence_sha256: string;
};

export type FlowIdentityProtectedOrphanEntry = {
  source_id: string;
  source_version: string;
  evidence_sha256: string;
};

export type FlowIdentityProtectedClosure = {
  schema_version: 'dataset-flow-identity-protected-closure.v1';
  pending: FlowIdentityProtectedReferenceEntry[];
  blockers: FlowIdentityProtectedReferenceEntry[];
  orphans: FlowIdentityProtectedOrphanEntry[];
  pending_set_sha256: string;
  blocker_set_sha256: string;
  orphan_set_sha256: string;
  total_expected_reference_count: number;
};

export type FlowIdentityProcessTemplate = {
  process: FlowIdentityProcessManifest;
  rewrites: FlowIdentityRewrite[];
  collision_ledger: FlowIdentityCollisionLedger;
  desired_payload: JsonObject;
};

export type FlowIdentityPlan = {
  schema_version: 'dataset-flow-identity-plan.v2';
  generated_at_utc: string;
  environment: FlowIdentityLiveCapture['environment'];
  project_ref: string;
  account: FlowIdentityLiveCapture['account'];
  operation_id: string;
  status: 'ready';
  target_visibility: 'owner_draft';
  review_ledger_sha256: string;
  capture_artifact_sha256: FlowIdentityArtifactSha256;
  receipt_id: string;
  receipt_proof_sha256: FlowIdentityDbOpaqueSha256;
  capture_request_sha256: FlowIdentitySharedRequestSha256;
  source_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  support_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  target_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  mapping_guard_set_sha256: FlowIdentityDbOpaqueSha256;
  process_intent_set_sha256: FlowIdentityDbOpaqueSha256;
  receipt_protected_closure_sha256: FlowIdentityDbOpaqueSha256;
  capture_whole_scope_proof_sha256: FlowIdentityDbOpaqueSha256;
  source_universe_artifact_sha256: FlowIdentityArtifactSha256;
  compatibility_policy: FlowIdentityCompatibilityPolicy;
  support_snapshot_artifact_sha256: FlowIdentityArtifactSha256;
  mapping_artifact_sha256: FlowIdentityArtifactSha256;
  process_manifest_artifact_sha256: FlowIdentityArtifactSha256;
  protected_closure_artifact_sha256: FlowIdentityArtifactSha256;
  support_snapshots: FlowIdentitySupportSnapshot[];
  mappings: FlowIdentityMapping[];
  processes: FlowIdentityProcessManifest[];
  protected_closure: FlowIdentityProtectedClosure;
  summary: {
    semantic_sources: 305;
    mappings: number;
    processes: number;
    rewrites: number;
    collision_entries: number;
    pending: number;
    blockers: number;
    orphans: number;
    protected_references: number;
  };
  artifacts: {
    plan: 'flow-identity-plan.json';
    live_capture: 'flow-identity-live-capture.json';
    process_manifest: 'flow-identity-process-manifest.jsonl';
    collision_ledger: 'flow-identity-collision-ledger.jsonl';
    protected_closure: 'flow-identity-protected-closure.json';
    desired_payload_dir: 'desired-processes';
    process_request_dir: 'process-requests';
  };
  plan_sha256: string;
};

export type FlowIdentityPlanBundle = {
  plan: FlowIdentityPlan;
  process_templates: FlowIdentityProcessTemplate[];
};

function fail(message: string, code = 'DATASET_FLOW_IDENTITY_CONTRACT_INVALID'): never {
  throw new CliError(message, { code, exitCode: 2 });
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function hash(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!HASH_PATTERN.test(normalized)) fail(`${label} must be a lowercase SHA-256.`);
  return normalized;
}

function instant(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!Number.isFinite(Date.parse(normalized))) fail(`${label} must be an RFC3339 timestamp.`);
  return normalized;
}

function version(value: unknown, label: string): string {
  const normalized = token(value, label);
  if (!VERSION_PATTERN.test(normalized)) fail(`${label} must match NN.NN.NNN.`);
  return normalized;
}

function computeSelfHash(value: Record<string, unknown>, field: string): string {
  return sha256Json({ ...value, [field]: '' });
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isJsonObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

export function assertCurrentFlowIdentityAuthority(value: {
  oracleSha256?: unknown;
  authoritySha256?: unknown;
  approvalText?: unknown;
  oracleGeneration?: unknown;
  sourceCount?: unknown;
}): void {
  for (const candidate of [value.oracleSha256, value.authoritySha256]) {
    if (typeof candidate === 'string' && HISTORICAL_FLOW_IDENTITY_AUTHORITY_SHA256.has(candidate)) {
      fail(
        'Historical Step 3 authority hash is permanently non-executable.',
        'DATASET_FLOW_IDENTITY_HISTORICAL_AUTHORITY',
      );
    }
  }
  if (
    typeof value.approvalText === 'string' &&
    HISTORICAL_APPROVAL_PATTERN.test(value.approvalText.trim())
  ) {
    fail(
      'Historical Step 3 v1/v2 approval text is permanently non-executable.',
      'DATASET_FLOW_IDENTITY_HISTORICAL_AUTHORITY',
    );
  }
  if (value.oracleGeneration === 'pre_step2' || value.sourceCount === 224) {
    fail(
      'Pre-Step-2 and 224-row Step 3 projections are permanently non-executable.',
      'DATASET_FLOW_IDENTITY_HISTORICAL_AUTHORITY',
    );
  }
}

export function computeFlowIdentityReviewLedgerSha256(ledger: FlowIdentityReviewLedger): string {
  return computeSelfHash(ledger as unknown as Record<string, unknown>, 'ledger_sha256');
}

export function computeFlowIdentityCaptureSha256(capture: FlowIdentityLiveCapture): string {
  return computeSelfHash(capture as unknown as Record<string, unknown>, 'capture_artifact_sha256');
}

export function computeFlowIdentityCaptureEvidenceSha256(
  capture: Omit<FlowIdentityLiveCapture, 'attestation' | 'capture_artifact_sha256'>,
): string {
  return sha256Json({
    schema_version: capture.schema_version,
    captured_at_utc: capture.captured_at_utc,
    environment: capture.environment,
    project_ref: capture.project_ref,
    account: capture.account,
    prerequisites: capture.prerequisites,
    sdk: capture.sdk,
    review_ledger_sha256: capture.artifact_evidence.review_ledger_sha256,
    toolchain_evidence_sha256: capture.artifact_evidence.toolchain_evidence_sha256,
    completeness: capture.completeness,
    source_rows: capture.source_rows,
    target_rows: capture.target_rows,
    support_rows: capture.support_rows,
    process_rows: capture.process_rows,
  });
}

export function computeFlowIdentityMappingId(
  mapping: Omit<FlowIdentityMapping, 'mapping_id'> | FlowIdentityMapping,
): string {
  const identity = Object.fromEntries(
    Object.entries(mapping).filter(([key]) => key !== 'ordinal' && key !== 'mapping_id'),
  );
  return sha256Json(identity);
}

export function computeFlowIdentityProcessTemplateSha256(
  process: FlowIdentityProcessManifest,
): string {
  const body = Object.fromEntries(
    Object.entries(process).filter(([key]) => key !== 'process_template_sha256'),
  );
  return sha256Json(body);
}

export function computeFlowIdentityPlanSha256(plan: FlowIdentityPlan): string {
  return computeSelfHash(plan as unknown as Record<string, unknown>, 'plan_sha256');
}

export function parseFlowIdentityReference(value: unknown, label: string): FlowIdentityReference {
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  if (sha256Json(keys) !== sha256Json([...FLOW_IDENTITY_REFERENCE_FIELDS].sort())) {
    fail(`${label} must contain exactly the five approved reference fields.`);
  }
  const id = token(value['@refObjectId'], `${label}.@refObjectId`);
  const referenceVersion = version(value['@version'], `${label}.@version`);
  const uri = token(value['@uri'], `${label}.@uri`);
  const shortDescription = value['common:shortDescription'];
  if (
    !UUID_PATTERN.test(id) ||
    value['@type'] !== 'flow data set' ||
    Buffer.byteLength(uri, 'utf8') > 2_048 ||
    !isStandardFlowIdentityShortDescription(shortDescription)
  ) {
    fail(`${label} type or URI is invalid.`);
  }
  return {
    '@refObjectId': id,
    '@type': 'flow data set',
    '@uri': uri,
    '@version': referenceVersion,
    'common:shortDescription': structuredClone(shortDescription),
  };
}

export function extractFlowIdentityReference(value: unknown, label: string): FlowIdentityReference {
  if (!isJsonObject(value)) fail(`${label} must be an object.`);
  return parseFlowIdentityReference(
    Object.fromEntries(FLOW_IDENTITY_REFERENCE_FIELDS.map((field) => [field, value[field]])),
    label,
  );
}

export function parseFlowIdentityPolicy(value: unknown): FlowIdentityCompatibilityPolicy {
  if (!isJsonObject(value)) fail('Flow identity compatibility policy is invalid.');
  assertCurrentFlowIdentityAuthority({
    authoritySha256: value.policy_sha256,
    approvalText: value.approval_text,
  });
  assertCurrentFlowIdentityAuthority({ authoritySha256: value.evidence_resolution_sha256 });
  assertCurrentFlowIdentityAuthority({ authoritySha256: value.approval_text_sha256 });
  if (
    !hasExactKeys(value, [
      'schema_version',
      'policy_sha256',
      'evidence_resolution_sha256',
      'approved_at_utc',
      'approval_text_sha256',
    ]) ||
    value.schema_version !== 'dataset-flow-identity-compatibility-policy.v1' ||
    !HASH_PATTERN.test(token(value.policy_sha256, 'policy_sha256')) ||
    !HASH_PATTERN.test(token(value.evidence_resolution_sha256, 'evidence_resolution_sha256')) ||
    !HASH_PATTERN.test(token(value.approval_text_sha256, 'approval_text_sha256'))
  ) {
    fail('Flow identity compatibility policy fields are invalid.');
  }
  instant(value.approved_at_utc, 'approved_at_utc');
  return value as FlowIdentityCompatibilityPolicy;
}

function parseReviewEntry(value: unknown, index: number): FlowIdentityReviewEntry {
  const label = `entries[${index}]`;
  if (!isJsonObject(value) || !isJsonObject(value.source)) fail(`${label} is invalid.`);
  const disposition = token(value.disposition, `${label}.disposition`);
  const sourceId = token(value.source.id, `${label}.source.id`);
  if (!['map_public', 'pending', 'blocker', 'orphan'].includes(disposition)) {
    fail(`${label}.disposition is unsupported.`);
  }
  const target = isJsonObject(value.target)
    ? {
        id: token(value.target.id, `${label}.target.id`),
        version: version(value.target.version, `${label}.target.version`),
        reference: parseFlowIdentityReference(value.target.reference, `${label}.target.reference`),
      }
    : null;
  const directions = Array.isArray(value.allowed_directions)
    ? value.allowed_directions.map((entry) => token(entry, `${label}.allowed_directions`))
    : [];
  if (
    !UUID_PATTERN.test(sourceId) ||
    (target !== null && !UUID_PATTERN.test(target.id)) ||
    directions.some((entry) => entry !== 'Input' && entry !== 'Output') ||
    new Set(directions).size !== directions.length ||
    (disposition === 'map_public') !== Boolean(target && directions.length)
  ) {
    fail(`${label} target/direction fields do not match its disposition.`);
  }
  return {
    source: {
      id: sourceId,
      version: version(value.source.version, `${label}.source.version`),
    },
    disposition: disposition as FlowIdentityDisposition,
    target,
    allowed_directions: directions as FlowIdentityDirection[],
    source_trace_sha256: hash(value.source_trace_sha256, `${label}.source_trace_sha256`),
    compartment_evidence_sha256: hash(
      value.compartment_evidence_sha256,
      `${label}.compartment_evidence_sha256`,
    ),
    decision_evidence_sha256: hash(
      value.decision_evidence_sha256,
      `${label}.decision_evidence_sha256`,
    ),
  };
}

export function parseFlowIdentityReviewLedger(value: unknown): FlowIdentityReviewLedger {
  if (!isJsonObject(value) || !Array.isArray(value.entries)) {
    fail('Flow identity review ledger is invalid.');
  }
  assertCurrentFlowIdentityAuthority({
    oracleSha256: value.ledger_sha256,
    oracleGeneration: value.oracle_generation,
    sourceCount: value.source_count,
  });
  const entries = value.entries.map(parseReviewEntry);
  const ledger = { ...value, entries } as FlowIdentityReviewLedger;
  if (
    ledger.schema_version !== 'dataset-flow-identity-review-ledger.v3' ||
    ledger.source_count !== FLOW_IDENTITY_SOURCE_COUNT ||
    ledger.execution_authority !== false ||
    entries.length !== FLOW_IDENTITY_SOURCE_COUNT ||
    new Set(entries.map((entry) => `${entry.source.id}@${entry.source.version}`)).size !==
      entries.length ||
    !Number.isFinite(Date.parse(ledger.generated_at_utc)) ||
    !HASH_PATTERN.test(ledger.review_evidence_sha256) ||
    ledger.ledger_sha256 !== computeFlowIdentityReviewLedgerSha256(ledger)
  ) {
    fail('Review ledger must contain exactly 305 unique v3 source decisions.');
  }
  return ledger;
}

export function parseFlowIdentityCapture(value: unknown): FlowIdentityLiveCapture {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.account) ||
    !isJsonObject(value.prerequisites) ||
    !isJsonObject(value.sdk) ||
    !isJsonObject(value.artifact_evidence) ||
    !isJsonObject(value.completeness) ||
    !isJsonObject(value.capture_request) ||
    !isJsonObject(value.attestation)
  ) {
    fail('Flow identity live capture is invalid.');
  }
  assertCurrentFlowIdentityAuthority({ oracleSha256: value.capture_artifact_sha256 });
  const capture = value as FlowIdentityLiveCapture;
  const capturedAt = Date.parse(instant(capture.captured_at_utc, 'captured_at_utc'));
  const step2At = Date.parse(
    instant(capture.prerequisites.step2_completed_at_utc, 'step2_completed_at_utc'),
  );
  const issue29Target1At = Date.parse(
    instant(
      capture.prerequisites.issue29_target1_completed_at_utc,
      'issue29_target1_completed_at_utc',
    ),
  );
  const issue29Target2At = Date.parse(
    instant(
      capture.prerequisites.issue29_target2_completed_at_utc,
      'issue29_target2_completed_at_utc',
    ),
  );
  const attestation = capture.attestation;
  const attestedAt = Date.parse(instant(attestation.captured_at, 'attestation.captured_at'));
  const expiresAt = Date.parse(instant(attestation.expires_at, 'attestation.expires_at'));
  const attestationKeys = [
    'ok',
    'command',
    'schema_version',
    'proof_domain',
    'receipt_id',
    'receipt_proof_sha256',
    'operation_id',
    'environment',
    'project_ref',
    'captured_at',
    'expires_at',
    'source_guard_set_sha256',
    'support_guard_set_sha256',
    'target_guard_set_sha256',
    'mapping_guard_set_sha256',
    'process_intent_set_sha256',
    'protected_closure_sha256',
    'whole_scope_proof_sha256',
    'policy_sha256',
    'policy_approval_text_sha256',
    'source_count',
    'target_count',
    'support_count',
    'mapping_count',
    'process_count',
    'rewrite_count',
    'capture_request_sha256',
    'replay',
  ] as const;
  const completeness = capture.completeness;
  const processScan = completeness.owner_draft_process_scan;
  const request = assertFlowIdentityWireJson(
    capture.capture_request as unknown as JsonObject,
  ) as unknown as FlowIdentityCaptureRequest;
  const requestHash = flowIdentityRestrictedSha256(request as unknown as JsonObject);
  if (
    capture.schema_version !== 'dataset-flow-identity-live-capture.v2' ||
    !['production', 'preview', 'local'].includes(capture.environment) ||
    !token(capture.project_ref, 'project_ref') ||
    !token(capture.account.user_id, 'account.user_id') ||
    capture.account.email !== token(capture.account.email, 'account.email').toLowerCase() ||
    capture.sdk.package !== '@tiangong-lca/tidas-sdk' ||
    !token(capture.sdk.version, 'sdk.version') ||
    !Array.isArray(capture.source_rows) ||
    !Array.isArray(capture.target_rows) ||
    !Array.isArray(capture.support_rows) ||
    !Array.isArray(capture.process_rows) ||
    !hasExactKeys(request, [
      'schema_version',
      'request_id',
      'environment',
      'project_ref',
      'actor',
      'target_visibility',
      'operation_id',
      'compatibility_policy',
      'artifact_evidence',
      'mappings',
      'process_intents',
      'protected_closure',
    ]) ||
    !isJsonObject(request.actor) ||
    !hasExactKeys(request.actor, ['user_id', 'email']) ||
    !isJsonObject(request.artifact_evidence) ||
    !hasExactKeys(request.artifact_evidence, [
      'review_ledger_sha256',
      'live_capture_artifact_sha256',
      'toolchain_evidence_sha256',
    ]) ||
    !isJsonObject(request.compatibility_policy) ||
    !Array.isArray(request.mappings) ||
    !Array.isArray(request.process_intents) ||
    !isJsonObject(request.protected_closure) ||
    request.schema_version !== 'dataset-flow-identity-capture-attest.v2' ||
    !UUID_PATTERN.test(request.request_id) ||
    request.environment !== capture.environment ||
    request.project_ref !== capture.project_ref ||
    request.actor.user_id !== capture.account.user_id ||
    request.actor.email !== capture.account.email ||
    request.target_visibility !== 'owner_draft' ||
    request.operation_id !== attestation.operation_id ||
    request.artifact_evidence.review_ledger_sha256 !==
      capture.artifact_evidence.review_ledger_sha256 ||
    request.artifact_evidence.live_capture_artifact_sha256 !==
      capture.artifact_evidence.live_capture_artifact_sha256 ||
    request.artifact_evidence.toolchain_evidence_sha256 !==
      capture.artifact_evidence.toolchain_evidence_sha256 ||
    !hasExactKeys(attestation, attestationKeys) ||
    attestation.ok !== true ||
    attestation.command !== 'cmd_dataset_flow_identity_capture_attest_guarded' ||
    attestation.schema_version !== 'dataset-flow-identity-capture-attest-result.v2' ||
    attestation.proof_domain !== 'dataset-flow-identity-db-proof.v2' ||
    !UUID_PATTERN.test(attestation.receipt_id) ||
    !HASH_PATTERN.test(attestation.receipt_proof_sha256) ||
    ![
      attestation.receipt_proof_sha256,
      attestation.source_guard_set_sha256,
      attestation.support_guard_set_sha256,
      attestation.target_guard_set_sha256,
      attestation.mapping_guard_set_sha256,
      attestation.process_intent_set_sha256,
      attestation.protected_closure_sha256,
      attestation.whole_scope_proof_sha256,
      attestation.policy_sha256,
      attestation.policy_approval_text_sha256,
      attestation.capture_request_sha256,
    ].every((digest) => HASH_PATTERN.test(digest)) ||
    attestation.capture_request_sha256 !== requestHash ||
    attestation.policy_sha256 !== request.compatibility_policy.policy_sha256 ||
    attestation.policy_approval_text_sha256 !== request.compatibility_policy.approval_text_sha256 ||
    attestation.environment !== capture.environment ||
    attestation.project_ref !== capture.project_ref ||
    attestation.source_count !== FLOW_IDENTITY_SOURCE_COUNT ||
    !Number.isSafeInteger(attestation.target_count) ||
    attestation.target_count < 1 ||
    !Number.isSafeInteger(attestation.support_count) ||
    attestation.support_count < 2 ||
    !Number.isSafeInteger(attestation.mapping_count) ||
    attestation.mapping_count < 1 ||
    attestation.mapping_count !== request.mappings.length ||
    !Number.isSafeInteger(attestation.process_count) ||
    attestation.process_count < 1 ||
    attestation.process_count !== request.process_intents.length ||
    !Number.isSafeInteger(attestation.rewrite_count) ||
    attestation.rewrite_count < 1 ||
    typeof attestation.replay !== 'boolean' ||
    attestedAt + 5 * 60 * 1_000 < capturedAt ||
    expiresAt <= attestedAt ||
    expiresAt - attestedAt > 7 * 24 * 60 * 60 * 1_000 ||
    completeness.schema_version !== 'dataset-flow-identity-capture-completeness.v2' ||
    completeness.source_count !== FLOW_IDENTITY_SOURCE_COUNT ||
    completeness.target_count !== capture.target_rows.length ||
    completeness.support_count !== capture.support_rows.length ||
    !Number.isSafeInteger(completeness.owner_draft_process_count) ||
    completeness.owner_draft_process_count < capture.process_rows.length ||
    !isJsonObject(processScan) ||
    processScan.status !== 'complete' ||
    processScan.complete !== true ||
    processScan.strategy !== 'postgrest_exact_count' ||
    processScan.rows_fetched !== completeness.owner_draft_process_count ||
    processScan.exact_total !== completeness.owner_draft_process_count ||
    processScan.content_range_verified !== true ||
    processScan.ordering_verified !== true ||
    processScan.duplicate_count !== 0 ||
    !HASH_PATTERN.test(String(processScan.row_identity_set_sha256)) ||
    !HASH_PATTERN.test(String(processScan.row_snapshot_set_sha256)) ||
    new Set(capture.process_rows.map((row) => `${row.id}\u0000${row.version}`)).size !==
      capture.process_rows.length ||
    capture.source_rows.length !== FLOW_IDENTITY_SOURCE_COUNT ||
    attestation.target_count !== capture.target_rows.length ||
    attestation.support_count !== capture.support_rows.length ||
    capturedAt < step2At ||
    capturedAt < issue29Target1At ||
    capturedAt < issue29Target2At ||
    !HASH_PATTERN.test(capture.prerequisites.step2_readback_sha256) ||
    !HASH_PATTERN.test(capture.prerequisites.issue29_target1_readback_sha256) ||
    !HASH_PATTERN.test(capture.prerequisites.issue29_target2_readback_sha256) ||
    !HASH_PATTERN.test(capture.artifact_evidence.review_ledger_sha256) ||
    !HASH_PATTERN.test(capture.artifact_evidence.live_capture_artifact_sha256) ||
    !HASH_PATTERN.test(capture.artifact_evidence.toolchain_evidence_sha256) ||
    capture.artifact_evidence.live_capture_artifact_sha256 !==
      computeFlowIdentityCaptureEvidenceSha256(capture) ||
    capture.capture_artifact_sha256 !== computeFlowIdentityCaptureSha256(capture)
  ) {
    fail('Live capture is stale, incomplete, historical, or tampered.');
  }
  return capture;
}

function validOneBasedOrdinals(values: Array<{ ordinal: number }>): boolean {
  return values.every((value, index) => value.ordinal === index + 1);
}

function validOccurrenceEntry(entry: FlowIdentityProtectedReferenceEntry): boolean {
  return Boolean(
    hasExactKeys(entry, [
      'source_id',
      'source_version',
      'expected_reference_count',
      'occurrences',
      'occurrence_set_sha256',
      'evidence_sha256',
    ]) &&
    UUID_PATTERN.test(entry.source_id) &&
    VERSION_PATTERN.test(entry.source_version) &&
    Number.isInteger(entry.expected_reference_count) &&
    entry.expected_reference_count === entry.occurrences.length &&
    HASH_PATTERN.test(entry.evidence_sha256) &&
    entry.occurrence_set_sha256 === sha256Json(entry.occurrences) &&
    entry.occurrences.every(
      (occurrence, index) =>
        hasExactKeys(occurrence, [
          'process_id',
          'process_version',
          'exchange_index',
          'internal_id',
          'direction',
          'reference_sha256',
        ]) &&
        UUID_PATTERN.test(occurrence.process_id) &&
        VERSION_PATTERN.test(occurrence.process_version) &&
        Number.isInteger(occurrence.exchange_index) &&
        occurrence.exchange_index >= 0 &&
        Boolean(occurrence.internal_id) &&
        ['Input', 'Output'].includes(occurrence.direction) &&
        HASH_PATTERN.test(occurrence.reference_sha256) &&
        (index === 0 ||
          `${entry.occurrences[index - 1]!.process_id}\u0000${entry.occurrences[index - 1]!.process_version}\u0000${String(entry.occurrences[index - 1]!.exchange_index).padStart(12, '0')}` <
            `${occurrence.process_id}\u0000${occurrence.process_version}\u0000${String(occurrence.exchange_index).padStart(12, '0')}`),
    ),
  );
}

function supportSnapshotRowSha256(snapshot: FlowIdentitySupportSnapshot): string {
  return sha256Json({
    id: snapshot.id,
    version: snapshot.version,
    user_id: snapshot.user_id,
    state_code: snapshot.state_code,
    modified_at: snapshot.modified_at,
    payload_sha256: snapshot.payload_sha256,
  });
}

function validSupportSnapshot(snapshot: FlowIdentitySupportSnapshot, actorUserId: string): boolean {
  return Boolean(
    hasExactKeys(snapshot, [
      'ordinal',
      'table',
      'id',
      'version',
      'user_id',
      'state_code',
      'modified_at',
      'payload_sha256',
      'row_sha256',
    ]) &&
    ['flowproperties', 'unitgroups'].includes(snapshot.table) &&
    UUID_PATTERN.test(snapshot.id) &&
    VERSION_PATTERN.test(snapshot.version) &&
    UUID_PATTERN.test(snapshot.user_id) &&
    [0, 100].includes(snapshot.state_code) &&
    (snapshot.state_code !== 0 || snapshot.user_id === actorUserId) &&
    POSTGREST_UTC_TIMESTAMP_PATTERN.test(snapshot.modified_at) &&
    HASH_PATTERN.test(snapshot.payload_sha256) &&
    snapshot.row_sha256 === supportSnapshotRowSha256(snapshot),
  );
}

function validMapping(mapping: FlowIdentityMapping, actorUserId: string): boolean {
  const targetReference = parseFlowIdentityReference(
    mapping.target.reference,
    'mapping target.reference',
  );
  const hashes = [
    mapping.source.payload_sha256,
    mapping.source.row_sha256,
    mapping.source.category_path_sha256,
    mapping.source.source_trace_sha256,
    mapping.target.payload_sha256,
    mapping.target.row_sha256,
    mapping.target.category_path_sha256,
    mapping.compatibility.policy_sha256,
    mapping.compatibility.evidence_sha256,
    mapping.compatibility.flow_schema.warning_set_sha256,
  ];
  return Boolean(
    hasExactKeys(mapping, ['ordinal', 'mapping_id', 'source', 'target', 'compatibility']) &&
    hasExactKeys(mapping.source, [
      'id',
      'version',
      'user_id',
      'state_code',
      'modified_at',
      'payload_sha256',
      'row_sha256',
      'flow_type',
      'flow_property_id',
      'flow_property_version',
      'unit_group_id',
      'unit_group_version',
      'category_path_sha256',
      'source_trace_sha256',
    ]) &&
    hasExactKeys(mapping.target, [
      'id',
      'version',
      'user_id',
      'state_code',
      'modified_at',
      'payload_sha256',
      'row_sha256',
      'flow_type',
      'flow_property_id',
      'flow_property_version',
      'unit_group_id',
      'unit_group_version',
      'category_path_sha256',
      'reference',
    ]) &&
    hasExactKeys(mapping.compatibility, [
      'policy_sha256',
      'mode',
      'confidence',
      'flow_property_compatible',
      'unit_group_compatible',
      'direction_compatible',
      'compartment_compatible',
      'conversion_factor',
      'evidence_sha256',
      'flow_schema',
      'process_schema_required',
    ]) &&
    hasExactKeys(mapping.compatibility.flow_schema, ['status', 'warning_set_sha256']) &&
    UUID_PATTERN.test(mapping.source.id) &&
    UUID_PATTERN.test(mapping.target.id) &&
    VERSION_PATTERN.test(mapping.source.version) &&
    VERSION_PATTERN.test(mapping.target.version) &&
    mapping.source.user_id === actorUserId &&
    mapping.source.state_code === 0 &&
    mapping.source.flow_type === 'Elementary flow' &&
    POSTGREST_UTC_TIMESTAMP_PATTERN.test(mapping.source.modified_at) &&
    mapping.target.user_id !== actorUserId &&
    mapping.target.state_code === 100 &&
    mapping.target.flow_type === 'Elementary flow' &&
    POSTGREST_UTC_TIMESTAMP_PATTERN.test(mapping.target.modified_at) &&
    mapping.source.flow_property_id === mapping.target.flow_property_id &&
    mapping.source.flow_property_version === mapping.target.flow_property_version &&
    mapping.source.unit_group_id === mapping.target.unit_group_id &&
    mapping.source.unit_group_version === mapping.target.unit_group_version &&
    targetReference['@refObjectId'] === mapping.target.id &&
    targetReference['@version'] === mapping.target.version &&
    mapping.compatibility.mode === 'identity' &&
    mapping.compatibility.confidence === 'approved' &&
    mapping.compatibility.flow_property_compatible === true &&
    mapping.compatibility.unit_group_compatible === true &&
    mapping.compatibility.direction_compatible === true &&
    mapping.compatibility.compartment_compatible === true &&
    mapping.compatibility.conversion_factor === '1' &&
    ['pass', 'legacy_warning'].includes(mapping.compatibility.flow_schema.status) &&
    mapping.compatibility.process_schema_required === 'pass' &&
    hashes.every((value) => HASH_PATTERN.test(value)),
  );
}

function validProcess(process: FlowIdentityProcessManifest, actorUserId: string): boolean {
  const hashes = [
    process.before_row_sha256,
    process.before_payload_sha256,
    process.before_exchange_set_sha256,
    process.desired_payload_sha256,
    process.desired_exchange_set_sha256,
    process.process_template_sha256,
    process.rewrite_set_sha256,
    process.collision_ledger_sha256,
    process.process_schema.evidence_sha256,
    process.pending_blocker_closure_sha256,
  ];
  return Boolean(
    hasExactKeys(process, [
      'ordinal',
      'id',
      'version',
      'user_id',
      'state_code',
      'modified_at',
      'model_id',
      'rule_verification',
      'before_row_sha256',
      'before_payload_sha256',
      'before_exchange_set_sha256',
      'before_exchange_count',
      'desired_payload_sha256',
      'desired_exchange_set_sha256',
      'rewrite_count',
      'process_template_sha256',
      'rewrite_set_sha256',
      'collision_ledger_sha256',
      'process_schema',
      'pending_blocker_closure_sha256',
    ]) &&
    hasExactKeys(process.process_schema, ['status', 'evidence_sha256']) &&
    UUID_PATTERN.test(process.id) &&
    VERSION_PATTERN.test(process.version) &&
    process.user_id === actorUserId &&
    process.state_code === 0 &&
    POSTGREST_UTC_TIMESTAMP_PATTERN.test(process.modified_at) &&
    (process.model_id === null || UUID_PATTERN.test(process.model_id)) &&
    (process.rule_verification === null || typeof process.rule_verification === 'boolean') &&
    Number.isInteger(process.before_exchange_count) &&
    process.before_exchange_count > 0 &&
    Number.isInteger(process.rewrite_count) &&
    process.rewrite_count > 0 &&
    process.process_schema.status === 'pass' &&
    hashes.every((value) => HASH_PATTERN.test(value)) &&
    process.process_template_sha256 === computeFlowIdentityProcessTemplateSha256(process),
  );
}

export function parseFlowIdentityPlan(value: unknown): FlowIdentityPlan {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.support_snapshots) ||
    !Array.isArray(value.mappings) ||
    !Array.isArray(value.processes) ||
    !isJsonObject(value.protected_closure) ||
    !isJsonObject(value.summary) ||
    !isJsonObject(value.artifacts)
  ) {
    fail('Flow identity plan is invalid.');
  }
  assertCurrentFlowIdentityAuthority({ oracleSha256: value.capture_artifact_sha256 });
  const plan = value as FlowIdentityPlan;
  parseFlowIdentityPolicy(plan.compatibility_policy);
  const protectedClosure = plan.protected_closure;
  const sourceUniverse = [
    ...plan.mappings.map((mapping) => ({
      id: mapping.source.id,
      version: mapping.source.version,
      user_id: plan.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...protectedClosure.pending.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: plan.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...protectedClosure.blockers.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: plan.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...protectedClosure.orphans.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: plan.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
  ].sort((left, right) =>
    `${left.id}\u0000${left.version}`.localeCompare(`${right.id}\u0000${right.version}`),
  );
  const validSourceUniverse =
    sourceUniverse.length === FLOW_IDENTITY_SOURCE_COUNT &&
    new Set(sourceUniverse.map((entry) => `${entry.id}\u0000${entry.version}`)).size ===
      FLOW_IDENTITY_SOURCE_COUNT &&
    plan.source_universe_artifact_sha256 === sha256Json(sourceUniverse);
  const claimedSupport = new Set<string>();
  for (const mapping of plan.mappings) {
    for (const endpoint of [mapping.source, mapping.target]) {
      claimedSupport.add(
        `flowproperties\u0000${endpoint.flow_property_id}\u0000${endpoint.flow_property_version}`,
      );
      claimedSupport.add(
        `unitgroups\u0000${endpoint.unit_group_id}\u0000${endpoint.unit_group_version}`,
      );
    }
  }
  const sealedSupport = new Set(
    plan.support_snapshots.map(
      (snapshot) => `${snapshot.table}\u0000${snapshot.id}\u0000${snapshot.version}`,
    ),
  );
  const validSupport =
    plan.support_snapshots.length >= 2 &&
    plan.support_snapshots.length <= 100 &&
    validOneBasedOrdinals(plan.support_snapshots) &&
    sealedSupport.size === plan.support_snapshots.length &&
    sealedSupport.size === claimedSupport.size &&
    [...sealedSupport].every((identity) => claimedSupport.has(identity)) &&
    plan.support_snapshots.every((snapshot) =>
      validSupportSnapshot(snapshot, plan.account.user_id),
    ) &&
    plan.support_snapshot_artifact_sha256 === sha256Json(plan.support_snapshots);
  const validProtected =
    hasExactKeys(protectedClosure, [
      'schema_version',
      'pending',
      'blockers',
      'orphans',
      'pending_set_sha256',
      'blocker_set_sha256',
      'orphan_set_sha256',
      'total_expected_reference_count',
    ]) &&
    protectedClosure.schema_version === 'dataset-flow-identity-protected-closure.v1' &&
    Array.isArray(protectedClosure.pending) &&
    Array.isArray(protectedClosure.blockers) &&
    Array.isArray(protectedClosure.orphans) &&
    protectedClosure.pending_set_sha256 === sha256Json(protectedClosure.pending) &&
    protectedClosure.blocker_set_sha256 === sha256Json(protectedClosure.blockers) &&
    protectedClosure.orphan_set_sha256 === sha256Json(protectedClosure.orphans) &&
    protectedClosure.total_expected_reference_count ===
      [...protectedClosure.pending, ...protectedClosure.blockers].reduce(
        (sum, entry) => sum + entry.expected_reference_count,
        0,
      ) &&
    [...protectedClosure.pending, ...protectedClosure.blockers].every(validOccurrenceEntry) &&
    protectedClosure.orphans.every(
      (entry) =>
        hasExactKeys(entry, ['source_id', 'source_version', 'evidence_sha256']) &&
        UUID_PATTERN.test(entry.source_id) &&
        VERSION_PATTERN.test(entry.source_version) &&
        HASH_PATTERN.test(entry.evidence_sha256),
    );
  const valid =
    plan.schema_version === 'dataset-flow-identity-plan.v2' &&
    plan.status === 'ready' &&
    plan.target_visibility === 'owner_draft' &&
    plan.summary.semantic_sources === FLOW_IDENTITY_SOURCE_COUNT &&
    plan.summary.mappings === plan.mappings.length &&
    plan.summary.mappings > 0 &&
    plan.summary.processes === plan.processes.length &&
    plan.summary.processes > 0 &&
    plan.summary.rewrites === plan.processes.reduce((sum, entry) => sum + entry.rewrite_count, 0) &&
    Number.isInteger(plan.summary.collision_entries) &&
    plan.summary.collision_entries >= 0 &&
    plan.summary.pending === protectedClosure.pending.length &&
    plan.summary.blockers === protectedClosure.blockers.length &&
    plan.summary.orphans === protectedClosure.orphans.length &&
    plan.summary.protected_references === protectedClosure.total_expected_reference_count &&
    validSourceUniverse &&
    validSupport &&
    validOneBasedOrdinals(plan.mappings) &&
    validOneBasedOrdinals(plan.processes) &&
    new Set(plan.mappings.map((mapping) => mapping.mapping_id)).size === plan.mappings.length &&
    new Set(plan.mappings.map((mapping) => `${mapping.source.id}\u0000${mapping.source.version}`))
      .size === plan.mappings.length &&
    new Set(plan.processes.map((process) => `${process.id}\u0000${process.version}`)).size ===
      plan.processes.length &&
    plan.mappings.every((mapping) => {
      return (
        validMapping(mapping, plan.account.user_id) &&
        mapping.compatibility.policy_sha256 === plan.compatibility_policy.policy_sha256 &&
        mapping.mapping_id === computeFlowIdentityMappingId(mapping)
      );
    }) &&
    plan.processes.every(
      (process) =>
        validProcess(process, plan.account.user_id) &&
        process.pending_blocker_closure_sha256 === plan.protected_closure_artifact_sha256,
    ) &&
    plan.mapping_artifact_sha256 === sha256Json(plan.mappings) &&
    plan.process_manifest_artifact_sha256 === sha256Json(plan.processes) &&
    plan.protected_closure_artifact_sha256 === sha256Json(protectedClosure) &&
    UUID_PATTERN.test(plan.receipt_id) &&
    [
      plan.receipt_proof_sha256,
      plan.capture_request_sha256,
      plan.source_guard_set_sha256,
      plan.support_guard_set_sha256,
      plan.target_guard_set_sha256,
      plan.mapping_guard_set_sha256,
      plan.process_intent_set_sha256,
      plan.receipt_protected_closure_sha256,
      plan.capture_whole_scope_proof_sha256,
      plan.capture_artifact_sha256,
    ].every((digest) => HASH_PATTERN.test(digest)) &&
    validProtected &&
    plan.plan_sha256 === computeFlowIdentityPlanSha256(plan) &&
    plan.artifacts.plan === 'flow-identity-plan.json' &&
    plan.artifacts.live_capture === 'flow-identity-live-capture.json' &&
    plan.artifacts.process_manifest === 'flow-identity-process-manifest.jsonl' &&
    plan.artifacts.collision_ledger === 'flow-identity-collision-ledger.jsonl' &&
    plan.artifacts.protected_closure === 'flow-identity-protected-closure.json' &&
    plan.artifacts.desired_payload_dir === 'desired-processes' &&
    plan.artifacts.process_request_dir === 'process-requests';
  if (!valid) fail('Flow identity plan is internally inconsistent or tampered.');
  return plan;
}

export const __testInternals = {
  computeSelfHash,
  hash,
  hasExactKeys,
  instant,
  parseReviewEntry,
  supportSnapshotRowSha256,
  token,
  validMapping,
  validOccurrenceEntry,
  validOneBasedOrdinals,
  validProcess,
  validSupportSnapshot,
  version,
};
