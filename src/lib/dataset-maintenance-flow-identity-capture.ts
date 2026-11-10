// data-api-relations: flowproperties, flows, unitgroups
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  computeFlowIdentityCaptureEvidenceSha256,
  computeFlowIdentityCaptureSha256,
  parseFlowIdentityCapture,
  parseFlowIdentityPolicy,
  parseFlowIdentityReviewLedger,
  type FlowIdentityLiveCapture,
} from './dataset-maintenance-flow-identity-contract.js';
import {
  buildFlowIdentityCaptureRequest,
  buildFlowIdentitySemantics,
  flowType,
  type ValidationDeps,
} from './dataset-maintenance-flow-identity-plan.js';
import {
  materializePrivateArtifactDirectoryAtomically,
  readProtectedJsonArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import { parseProtectedToolchainEvidence } from './dataset-maintenance-protected-toolchain.js';
import {
  attestMaintenanceFlowIdentityCapture,
  fetchMaintenanceAccountTableRows,
  fetchMaintenanceExactRows,
  isMaintenanceRpcDomainFailure,
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { isJsonObject, snapshotRemoteRow } from './maintenance/contract/values.js';
import { sha256Json, stableJsonText } from './canonical-json-hash.js';
import {
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from './maintenance/contract/types.js';
import { flowIdentityRestrictedSha256 } from './dataset-maintenance-flow-identity-wire.js';
import { validateFlowPayload } from './flow-payload-validation.js';
import { validateProcessPayload } from './process-payload-validation.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;

export type FlowIdentityPrerequisites = {
  schema_version: 'dataset-flow-identity-prerequisites.v2';
  step2: {
    readback_sha256: string;
    completed_at_utc: string;
    status: 'passed';
  };
  issue29_target1: {
    readback_sha256: string;
    completed_at_utc: string;
    status: 'passed';
  };
  issue29_target2: {
    readback_sha256: string;
    completed_at_utc: string;
    status: 'passed';
  };
};

export type CaptureFlowIdentityOptions = {
  policyPath: string;
  reviewLedgerPath: string;
  prerequisitesPath: string;
  toolchainEvidencePath: string;
  requestId: string;
  operationId: string;
  expectedProjectRef: string;
  confirm: string;
  cliVersion: string;
  sdkVersion: string;
  outDir: string;
  pageSize?: number;
  readConcurrency?: number;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
  validation?: Partial<ValidationDeps>;
};

export type FlowIdentityCaptureReport = {
  schema_version: 'dataset-flow-identity-capture-report.v2';
  generated_at_utc: string;
  status: 'captured';
  environment: 'production';
  project_ref: string;
  actor: { user_id: string; email: string };
  operation_id: string;
  request_id: string;
  receipt_id: string;
  receipt_proof_sha256: string;
  capture_request_sha256: string;
  live_capture_evidence_core_sha256: string;
  capture_artifact_sha256: string;
  counts: {
    sources: 305;
    targets: number;
    supports: number;
    owner_draft_processes: number;
    mappings: number;
    affected_processes: number;
    rewrites: number;
  };
  calls: {
    capture_attest: 1;
    scope_preflight: 0;
    process_rewrite: 0;
    scope_finalize: 0;
    automatic_retry: false;
  };
  artifacts: {
    request: string;
    attestation: string;
    live_capture: string;
    report: string;
  };
};

type CaptureDependencies = {
  resolveContext: typeof resolveMaintenanceRemoteContext;
  fetchAccountTableRows: typeof fetchMaintenanceAccountTableRows;
  fetchExactRows: typeof fetchMaintenanceExactRows;
  attest: typeof attestMaintenanceFlowIdentityCapture;
  materialize: typeof materializePrivateArtifactDirectoryAtomically;
};

const DEFAULT_DEPENDENCIES: CaptureDependencies = {
  resolveContext: resolveMaintenanceRemoteContext,
  fetchAccountTableRows: fetchMaintenanceAccountTableRows,
  fetchExactRows: fetchMaintenanceExactRows,
  attest: attestMaintenanceFlowIdentityCapture,
  materialize: materializePrivateArtifactDirectoryAtomically,
};

function fail(message: string, code = 'DATASET_FLOW_IDENTITY_CAPTURE_INVALID'): never {
  throw new CliError(message, { code, exitCode: 1 });
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readCanonical(filePath: string, label: string) {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    fail(`${label} must be canonical JSON with one trailing newline.`);
  }
  return artifact;
}

export function parseFlowIdentityPrerequisites(value: unknown): FlowIdentityPrerequisites {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.step2) ||
    !isJsonObject(value.issue29_target1) ||
    !isJsonObject(value.issue29_target2) ||
    !exactKeys(value, ['schema_version', 'step2', 'issue29_target1', 'issue29_target2']) ||
    !exactKeys(value.step2, ['readback_sha256', 'completed_at_utc', 'status']) ||
    !exactKeys(value.issue29_target1, ['readback_sha256', 'completed_at_utc', 'status']) ||
    !exactKeys(value.issue29_target2, ['readback_sha256', 'completed_at_utc', 'status'])
  ) {
    fail('Flow identity prerequisites are invalid.');
  }
  const parsed = value as FlowIdentityPrerequisites;
  if (
    parsed.schema_version !== 'dataset-flow-identity-prerequisites.v2' ||
    parsed.step2.status !== 'passed' ||
    parsed.issue29_target1.status !== 'passed' ||
    parsed.issue29_target2.status !== 'passed' ||
    !HASH.test(parsed.step2.readback_sha256) ||
    !HASH.test(parsed.issue29_target1.readback_sha256) ||
    !HASH.test(parsed.issue29_target2.readback_sha256) ||
    !Number.isFinite(Date.parse(parsed.step2.completed_at_utc)) ||
    !Number.isFinite(Date.parse(parsed.issue29_target1.completed_at_utc)) ||
    !Number.isFinite(Date.parse(parsed.issue29_target2.completed_at_utc))
  ) {
    fail('Flow identity prerequisites do not prove passed Step 2 and issue #29 readbacks.');
  }
  return parsed;
}

function snapshot(row: DatasetMaintenanceRemoteRow): DatasetMaintenanceRowSnapshot {
  if (
    !row.user_id ||
    row.state_code === null ||
    !row.modified_at ||
    !row.json_ordered ||
    !row.json ||
    sha256Json(row.json) !== sha256Json(row.json_ordered)
  ) {
    fail('A capture row is incomplete or its json/json_ordered columns differ.');
  }
  return snapshotRemoteRow({
    table: row.table,
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    modified_at: row.modified_at,
    json_ordered: row.json_ordered,
    model_id: row.model_id,
    rule_verification: row.rule_verification,
  });
}

function identity(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function referenceIdentity(value: unknown): { id: string; version: string } | null {
  if (
    !isJsonObject(value) ||
    typeof value['@refObjectId'] !== 'string' ||
    typeof value['@version'] !== 'string' ||
    !UUID.test(value['@refObjectId']) ||
    !VERSION.test(value['@version'])
  ) {
    return null;
  }
  return { id: value['@refObjectId'], version: value['@version'] };
}

function arrayOfObjects(value: unknown): JsonObject[] {
  const values = Array.isArray(value) ? value : isJsonObject(value) ? [value] : [];
  if (!values.every(isJsonObject)) fail('A flow support collection is malformed.');
  return values;
}

function flowPropertyClaim(payload: JsonObject): { id: string; version: string } {
  const root = isJsonObject(payload.flowDataSet) ? payload.flowDataSet : null;
  const information = isJsonObject(root?.flowInformation) ? root.flowInformation : null;
  const quantitative = isJsonObject(information?.quantitativeReference)
    ? information.quantitativeReference
    : null;
  const properties = isJsonObject(root?.flowProperties) ? root.flowProperties : null;
  const referenceInternalId = quantitative?.referenceToReferenceFlowProperty;
  const property = arrayOfObjects(properties?.flowProperty).find(
    (entry) => entry['@dataSetInternalID'] === referenceInternalId,
  );
  const claim = referenceIdentity(property?.referenceToFlowPropertyDataSet);
  if (!claim) fail('A mapped flow lacks an exact reference flow-property identity.');
  return claim;
}

function unitGroupClaim(payload: JsonObject): { id: string; version: string } {
  const root = isJsonObject(payload.flowPropertyDataSet) ? payload.flowPropertyDataSet : null;
  const information = isJsonObject(root?.flowPropertiesInformation)
    ? root.flowPropertiesInformation
    : null;
  const quantitative = isJsonObject(information?.quantitativeReference)
    ? information.quantitativeReference
    : null;
  const claim = referenceIdentity(quantitative?.referenceToReferenceUnitGroup);
  if (!claim) fail('A captured flow property lacks an exact unit-group identity.');
  return claim;
}

function processReferencesReviewedSource(
  row: DatasetMaintenanceRowSnapshot,
  reviewed: ReadonlySet<string>,
): boolean {
  const root = isJsonObject(row.json_ordered?.processDataSet)
    ? row.json_ordered.processDataSet
    : null;
  const exchanges = isJsonObject(root?.exchanges) ? root.exchanges : null;
  const values = Array.isArray(exchanges?.exchange)
    ? exchanges.exchange
    : isJsonObject(exchanges?.exchange)
      ? [exchanges.exchange]
      : [];
  for (const value of values) {
    if (!isJsonObject(value)) fail('A captured process has a malformed exchange collection.');
    const reference = referenceIdentity(value.referenceToFlowDataSet);
    if (!reference) fail('A captured process exchange has a malformed flow reference.');
    if (reviewed.has(identity(reference.id, reference.version))) return true;
  }
  return false;
}

async function fetchUniqueRows(options: {
  identities: Array<{
    table: 'flows' | 'flowproperties' | 'unitgroups';
    id: string;
    version: string;
  }>;
  context: DatasetMaintenanceRemoteContext;
  actorUserId: string;
  publicOnly: boolean;
  concurrency: number;
  dependencies: CaptureDependencies;
}): Promise<DatasetMaintenanceRowSnapshot[]> {
  const rows: DatasetMaintenanceRowSnapshot[] = [];
  for (let offset = 0; offset < options.identities.length; offset += options.concurrency) {
    const chunk = options.identities.slice(offset, offset + options.concurrency);
    const fetched = await Promise.all(
      chunk.map(async (claim) => {
        const result = await options.dependencies.fetchExactRows({
          context: options.context,
          table: claim.table,
          id: claim.id,
          version: claim.version,
          includeJson: true,
        });
        const visible = result.rows.filter((row) =>
          options.publicOnly
            ? row.state_code === 100 && row.user_id !== options.actorUserId
            : row.state_code === 100 ||
              (row.state_code === 0 && row.user_id === options.actorUserId),
        );
        if (visible.length !== 1) {
          fail('A capture target/support identity is missing, duplicated, or outside visibility.');
        }
        return snapshot(visible[0]!);
      }),
    );
    rows.push(...fetched);
  }
  return rows.sort((left, right) =>
    `${left.table}\u0000${identity(left.id, left.version)}`.localeCompare(
      `${right.table}\u0000${identity(right.id, right.version)}`,
    ),
  );
}

function validateInputs(options: CaptureFlowIdentityOptions): { concurrency: number } {
  const concurrency = options.readConcurrency ?? 5;
  if (!UUID.test(options.requestId)) fail('capture request ID must be a canonical UUID.');
  if (!options.operationId.trim() || Buffer.byteLength(options.operationId, 'utf8') > 512) {
    fail('capture operation ID must be a non-empty token of at most 512 UTF-8 bytes.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    fail('capture read concurrency must be an integer between 1 and 5.');
  }
  if (!options.sdkVersion.trim()) fail('capture SDK version is required.');
  return { concurrency };
}

async function executeCapture(
  options: CaptureFlowIdentityOptions,
  dependencies: CaptureDependencies,
): Promise<FlowIdentityCaptureReport> {
  const { concurrency } = validateInputs(options);
  if (existsSync(path.resolve(options.outDir))) {
    fail('Capture output directory already exists; protected capture artifacts are immutable.');
  }
  const policyArtifact = readCanonical(options.policyPath, 'Flow identity compatibility policy');
  const reviewArtifact = readCanonical(options.reviewLedgerPath, 'Flow identity review ledger');
  const prerequisitesArtifact = readCanonical(
    options.prerequisitesPath,
    'Flow identity prerequisites',
  );
  const toolchainArtifact = readCanonical(
    options.toolchainEvidencePath,
    'Protected toolchain evidence',
  );
  const policy = parseFlowIdentityPolicy(policyArtifact.value);
  const review = parseFlowIdentityReviewLedger(reviewArtifact.value);
  const prerequisites = parseFlowIdentityPrerequisites(prerequisitesArtifact.value);
  if (policy.evidence_resolution_sha256 !== review.review_evidence_sha256) {
    fail('Compatibility policy does not bind the review ledger.');
  }
  parseProtectedToolchainEvidence(toolchainArtifact.value, {
    projectRef: options.expectedProjectRef,
    cliVersion: options.cliVersion,
  });
  const capturedAt = options.now ?? new Date();
  if (
    Date.parse(prerequisites.step2.completed_at_utc) > capturedAt.getTime() ||
    Date.parse(prerequisites.issue29_target1.completed_at_utc) > capturedAt.getTime() ||
    Date.parse(prerequisites.issue29_target2.completed_at_utc) > capturedAt.getTime()
  ) {
    fail('Capture time precedes a required passed prerequisite.');
  }
  const context = await dependencies.resolveContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  if (
    context.project_ref !== options.expectedProjectRef ||
    context.account.email.trim().toLowerCase() !== options.confirm.trim().toLowerCase()
  ) {
    fail('Authenticated production project/account does not match capture confirmation.');
  }
  const [flowCensus, processCensus] = await Promise.all([
    dependencies.fetchAccountTableRows({
      context,
      userId: context.account.user_id,
      table: 'flows',
      stateCode: 0,
      includeJson: true,
      pageSize: options.pageSize,
    }),
    dependencies.fetchAccountTableRows({
      context,
      userId: context.account.user_id,
      table: 'processes',
      stateCode: 0,
      includeJson: true,
      pageSize: options.pageSize,
    }),
  ]);
  const reviewed = new Set(
    review.entries.map((entry) => identity(entry.source.id, entry.source.version)),
  );
  const elementary = flowCensus.rows.filter(
    (row) => row.json_ordered && flowType(row.json_ordered) === 'Elementary flow',
  );
  const observed = new Set(elementary.map((row) => identity(row.id, row.version)));
  if (
    elementary.length !== 305 ||
    observed.size !== 305 ||
    [...reviewed].some((key) => !observed.has(key)) ||
    [...observed].some((key) => !reviewed.has(key))
  ) {
    fail(
      'Authenticated owner-draft Elementary-flow census is not the exact 305-row review universe.',
    );
  }
  const sourceRows = elementary
    .map(snapshot)
    .sort((left, right) =>
      identity(left.id, left.version).localeCompare(identity(right.id, right.version)),
    );
  const fullProcessRows = processCensus.rows
    .map(snapshot)
    .sort((left, right) =>
      identity(left.id, left.version).localeCompare(identity(right.id, right.version)),
    );
  const processRows = fullProcessRows.filter((row) =>
    processReferencesReviewedSource(row, reviewed),
  );
  const processScanProof: JsonObject = {
    ...(processCensus.completeness as unknown as JsonObject),
    row_identity_set_sha256: sha256Json(
      fullProcessRows.map((row) => ({ id: row.id, version: row.version })),
    ),
    row_snapshot_set_sha256: sha256Json(
      fullProcessRows.map((row) => ({
        id: row.id,
        version: row.version,
        row_sha256: row.row_sha256,
      })),
    ),
  };
  const targetClaims = [
    ...new Map(
      review.entries
        .filter((entry) => entry.disposition === 'map_public')
        .map((entry) => [
          identity(entry.target!.id, entry.target!.version),
          {
            table: 'flows' as const,
            id: entry.target!.id,
            version: entry.target!.version,
          },
        ]),
    ).values(),
  ];
  const targetRows = await fetchUniqueRows({
    identities: targetClaims,
    context,
    actorUserId: context.account.user_id,
    publicOnly: true,
    concurrency,
    dependencies,
  });
  const fpClaims = [
    ...new Map(
      [
        ...sourceRows.filter((row) =>
          review.entries.some(
            (entry) =>
              entry.disposition === 'map_public' &&
              entry.source.id === row.id &&
              entry.source.version === row.version,
          ),
        ),
        ...targetRows,
      ].map((row) => {
        const claim = flowPropertyClaim(row.json_ordered!);
        return [
          identity(claim.id, claim.version),
          {
            table: 'flowproperties' as const,
            ...claim,
          },
        ];
      }),
    ).values(),
  ];
  const flowPropertyRows = await fetchUniqueRows({
    identities: fpClaims,
    context,
    actorUserId: context.account.user_id,
    publicOnly: false,
    concurrency,
    dependencies,
  });
  const unitGroupClaims = [
    ...new Map(
      flowPropertyRows.map((row) => {
        const claim = unitGroupClaim(row.json_ordered!);
        return [identity(claim.id, claim.version), { table: 'unitgroups' as const, ...claim }];
      }),
    ).values(),
  ];
  const unitGroupRows = await fetchUniqueRows({
    identities: unitGroupClaims,
    context,
    actorUserId: context.account.user_id,
    publicOnly: false,
    concurrency,
    dependencies,
  });
  const supportRows = [...flowPropertyRows, ...unitGroupRows].sort((left, right) =>
    `${left.table}\u0000${identity(left.id, left.version)}`.localeCompare(
      `${right.table}\u0000${identity(right.id, right.version)}`,
    ),
  );
  const capture: FlowIdentityLiveCapture = {
    schema_version: 'dataset-flow-identity-live-capture.v2',
    captured_at_utc: capturedAt.toISOString(),
    environment: 'production',
    project_ref: context.project_ref,
    account: {
      user_id: context.account.user_id,
      email: context.account.email.trim().toLowerCase(),
    },
    prerequisites: {
      step2_readback_sha256: prerequisites.step2.readback_sha256,
      step2_completed_at_utc: prerequisites.step2.completed_at_utc,
      issue29_target1_readback_sha256: prerequisites.issue29_target1.readback_sha256,
      issue29_target1_completed_at_utc: prerequisites.issue29_target1.completed_at_utc,
      issue29_target2_readback_sha256: prerequisites.issue29_target2.readback_sha256,
      issue29_target2_completed_at_utc: prerequisites.issue29_target2.completed_at_utc,
    },
    sdk: { package: '@tiangong-lca/tidas-sdk', version: options.sdkVersion.trim() },
    artifact_evidence: {
      review_ledger_sha256: review.ledger_sha256,
      live_capture_artifact_sha256: '',
      toolchain_evidence_sha256: toolchainArtifact.file_sha256,
    },
    completeness: {
      schema_version: 'dataset-flow-identity-capture-completeness.v2',
      source_count: 305,
      target_count: targetRows.length,
      support_count: supportRows.length,
      owner_draft_process_count: fullProcessRows.length,
      owner_draft_process_scan: processScanProof,
    },
    source_rows: sourceRows,
    target_rows: targetRows,
    support_rows: supportRows,
    process_rows: processRows,
    capture_request: {} as FlowIdentityLiveCapture['capture_request'],
    attestation: {} as FlowIdentityLiveCapture['attestation'],
    capture_artifact_sha256: '',
  };
  capture.artifact_evidence.live_capture_artifact_sha256 =
    computeFlowIdentityCaptureEvidenceSha256(capture);
  const validation: ValidationDeps = {
    validateFlow: options.validation?.validateFlow ?? validateFlowPayload,
    validateProcess: options.validation?.validateProcess ?? validateProcessPayload,
  };
  const semantics = buildFlowIdentitySemantics({ policy, review, capture, validation });
  capture.capture_request = buildFlowIdentityCaptureRequest({
    requestId: options.requestId,
    operationId: options.operationId,
    policy,
    capture,
    mappings: semantics.mappings,
    processTemplates: semantics.processTemplates,
    protectedClosure: semantics.protectedClosure,
  });
  const requestSha256 = flowIdentityRestrictedSha256(
    capture.capture_request as unknown as JsonObject,
  );
  const materializeIndeterminate = (error: unknown, rawResponse?: JsonObject): void => {
    const preferred = path.resolve(options.outDir);
    const recoveryDir = existsSync(preferred)
      ? `${preferred}.indeterminate-${options.requestId}`
      : preferred;
    dependencies.materialize(recoveryDir, (staging) => {
      writePrivateImmutableJson(
        path.join(staging, 'flow-identity-capture-request.json'),
        capture.capture_request,
      );
      if (rawResponse) {
        writePrivateImmutableJson(
          path.join(staging, 'flow-identity-capture-raw-response.json'),
          rawResponse,
        );
      }
      writePrivateImmutableJson(path.join(staging, 'flow-identity-capture-indeterminate.json'), {
        schema_version: 'dataset-flow-identity-capture-indeterminate.v2',
        status: 'indeterminate',
        request_id: options.requestId,
        capture_request_sha256: requestSha256,
        post_attempt_count: 1,
        automatic_retry: false,
        normal_capture_rerun_allowed: false,
        recovery: 'operator_exact_request_status_or_replay_required',
        error: String(error),
      });
    });
  };
  const materializeRejected = (rawResponse: JsonObject): void => {
    dependencies.materialize(path.resolve(options.outDir), (staging) => {
      writePrivateImmutableJson(
        path.join(staging, 'flow-identity-capture-request.json'),
        capture.capture_request,
      );
      writePrivateImmutableJson(path.join(staging, 'flow-identity-capture-domain-rejection.json'), {
        schema_version: 'dataset-flow-identity-capture-domain-rejection.v1',
        status: 'rejected',
        request_id: options.requestId,
        capture_request_sha256: requestSha256,
        post_attempt_count: 1,
        automatic_retry: false,
        same_request_replay_allowed: false,
        recovery: 'new_request_and_output_directory_required',
        response: rawResponse,
      });
    });
  };
  let rawAttestation: JsonObject;
  try {
    rawAttestation = await dependencies.attest({
      context,
      request: capture.capture_request as unknown as JsonObject,
    });
  } catch (error) {
    materializeIndeterminate(error);
    throw error;
  }
  if (isMaintenanceRpcDomainFailure(rawAttestation)) {
    materializeRejected(rawAttestation);
    throw new CliError(
      typeof rawAttestation.message === 'string'
        ? rawAttestation.message
        : 'Flow identity capture was rejected by the database.',
      {
        code: rawAttestation.code,
        exitCode: 1,
        details: rawAttestation,
      },
    );
  }
  try {
    capture.attestation = rawAttestation as FlowIdentityLiveCapture['attestation'];
    capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(capture);
    const parsed = parseFlowIdentityCapture(capture);
    const generatedAt = options.now ?? new Date();
    const artifactPaths = {
      request: path.join(path.resolve(options.outDir), 'flow-identity-capture-request.json'),
      attestation: path.join(
        path.resolve(options.outDir),
        'flow-identity-capture-attestation.json',
      ),
      live_capture: path.join(path.resolve(options.outDir), 'flow-identity-live-capture.json'),
      report: path.join(path.resolve(options.outDir), 'flow-identity-capture-report.json'),
    };
    const report: FlowIdentityCaptureReport = {
      schema_version: 'dataset-flow-identity-capture-report.v2',
      generated_at_utc: generatedAt.toISOString(),
      status: 'captured',
      environment: 'production',
      project_ref: parsed.project_ref,
      actor: parsed.account,
      operation_id: parsed.attestation.operation_id,
      request_id: parsed.capture_request.request_id,
      receipt_id: parsed.attestation.receipt_id,
      receipt_proof_sha256: parsed.attestation.receipt_proof_sha256,
      capture_request_sha256: parsed.attestation.capture_request_sha256,
      live_capture_evidence_core_sha256: parsed.artifact_evidence.live_capture_artifact_sha256,
      capture_artifact_sha256: parsed.capture_artifact_sha256,
      counts: {
        sources: 305,
        targets: parsed.target_rows.length,
        supports: parsed.support_rows.length,
        owner_draft_processes: parsed.completeness.owner_draft_process_count,
        mappings: semantics.mappings.length,
        affected_processes: semantics.processTemplates.length,
        rewrites: semantics.processTemplates.reduce(
          (sum, template) => sum + template.process.rewrite_count,
          0,
        ),
      },
      calls: {
        capture_attest: 1,
        scope_preflight: 0,
        process_rewrite: 0,
        scope_finalize: 0,
        automatic_retry: false,
      },
      artifacts: artifactPaths,
    };
    dependencies.materialize(options.outDir, (staging) => {
      writePrivateImmutableJson(
        path.join(staging, path.basename(artifactPaths.request)),
        parsed.capture_request,
      );
      writePrivateImmutableJson(
        path.join(staging, path.basename(artifactPaths.attestation)),
        parsed.attestation,
      );
      writePrivateImmutableJson(
        path.join(staging, path.basename(artifactPaths.live_capture)),
        parsed,
      );
      writePrivateImmutableJson(path.join(staging, path.basename(artifactPaths.report)), report);
    });
    return report;
  } catch (error) {
    materializeIndeterminate(error, rawAttestation);
    throw error;
  }
}

export async function captureFlowIdentity(
  options: CaptureFlowIdentityOptions,
): Promise<FlowIdentityCaptureReport> {
  return executeCapture(options, DEFAULT_DEPENDENCIES);
}

export const __testInternals = {
  executeCapture,
  flowPropertyClaim,
  parseFlowIdentityPrerequisites,
  snapshot,
  unitGroupClaim,
};
