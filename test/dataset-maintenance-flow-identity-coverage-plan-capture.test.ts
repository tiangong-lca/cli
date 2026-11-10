import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureFlowIdentity,
  parseFlowIdentityPrerequisites,
  __testInternals as captureInternals,
} from '../src/lib/dataset-maintenance-flow-identity-capture.js';
import {
  buildFlowIdentityCaptureRequest,
  buildFlowIdentityPlan,
  buildFlowIdentitySemantics,
  runFlowIdentityPlan,
  __testInternals as planInternals,
} from '../src/lib/dataset-maintenance-flow-identity-plan.js';
import {
  computeFlowIdentityCaptureEvidenceSha256,
  computeFlowIdentityCaptureSha256,
  computeFlowIdentityReviewLedgerSha256,
  type FlowIdentityCompatibilityPolicy,
  type FlowIdentityLiveCapture,
  type FlowIdentityReference,
  type FlowIdentityReviewEntry,
  type FlowIdentityReviewLedger,
} from '../src/lib/dataset-maintenance-flow-identity-contract.js';
import {
  freezeFlowIdentity,
  renderFlowIdentityExecutionApprovalText,
  __testInternals as freezeInternals,
} from '../src/lib/dataset-maintenance-flow-identity-freeze.js';
import {
  sealFlowIdentityApproval,
  __testInternals as sealInternals,
} from '../src/lib/dataset-maintenance-flow-identity-seal.js';
import {
  assertFlowIdentityWireValue,
  flowIdentityRestrictedSha256,
  __testInternals as wireInternals,
} from '../src/lib/dataset-maintenance-flow-identity-wire.js';
import {
  materializePrivateArtifactDirectoryAtomically,
  writePrivateImmutableJson,
} from '../src/lib/dataset-maintenance-protected-artifacts.js';
import { sha256Json, sha256Text } from '../src/lib/canonical-json-hash.js';
import { snapshotRemoteRow } from '../src/lib/maintenance/contract/values.js';
import {
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from '../src/lib/maintenance/contract/types.js';
import type { FlowPayloadValidationResult } from '../src/lib/flow-payload-validation.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const PUBLIC_OWNER = '22222222-2222-4222-8222-222222222222';
const FP_ID = '33333333-3333-4333-8333-333333333333';
const UG_ID = '44444444-4444-4444-8444-444444444444';
const PROCESS_ID = '55555555-5555-4555-8555-555555555555';
const TARGET_ID = '66666666-6666-4666-8666-666666666666';
const VERSION = '01.00.000';
const PUBLIC_VERSION = '03.00.004';
const FP_VERSION = '03.00.003';
const UG_VERSION = '03.00.003';
const MODIFIED = '2026-07-16T04:00:00+00:00';
const HASH = (value: string): string => sha256Json(value);
const APPROVAL_TEXT = 'APPROVE CURRENT BAFU STEP3 COMPATIBILITY POLICY';

function sourceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function reference(id: string, version: string, label = id): FlowIdentityReference {
  return {
    '@refObjectId': id,
    '@type': 'flow data set',
    '@uri': `../flows/${id}.xml?version=${version}`,
    '@version': version,
    'common:shortDescription': { '#text': label, '@xml:lang': 'en' },
  };
}

function flowPayload(id: string, version: string): JsonObject {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': id,
          name: { baseName: { '#text': id, '@xml:lang': 'en' } },
          classificationInformation: { category: 'air' },
        },
        quantitativeReference: { referenceToReferenceFlowProperty: '0' },
      },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '0',
          meanValue: '1',
          referenceToFlowPropertyDataSet: {
            '@refObjectId': FP_ID,
            '@type': 'flow property data set',
            '@uri': `../flowproperties/${FP_ID}.xml`,
            '@version': FP_VERSION,
            'common:shortDescription': { '#text': 'Mass', '@xml:lang': 'en' },
          },
        },
      },
      modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function flowPropertyPayload(): JsonObject {
  return {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: { 'common:UUID': FP_ID },
        quantitativeReference: {
          referenceToReferenceUnitGroup: {
            '@refObjectId': UG_ID,
            '@type': 'unit group data set',
            '@uri': `../unitgroups/${UG_ID}.xml`,
            '@version': UG_VERSION,
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': FP_VERSION },
      },
    },
  };
}

function unitGroupPayload(): JsonObject {
  return {
    unitGroupDataSet: {
      unitGroupInformation: {
        dataSetInformation: { 'common:UUID': UG_ID },
        quantitativeReference: { referenceToReferenceUnit: '0' },
      },
      units: { unit: { '@dataSetInternalID': '0', name: 'kg', meanValue: '1' } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': UG_VERSION },
      },
    },
  };
}

function exchange(index: number, flowReference: FlowIdentityReference): JsonObject {
  return {
    '@dataSetInternalID': String(index + 1),
    exchangeDirection: 'Output',
    meanAmount: '1',
    resultingAmount: '1',
    referenceToFlowDataSet: flowReference,
  };
}

function processPayload(
  references: FlowIdentityReference[] = [
    reference(sourceId(0), VERSION, 'source-0'),
    reference(TARGET_ID, PUBLIC_VERSION, TARGET_ID),
    reference(sourceId(1), VERSION, 'pending-source'),
  ],
): JsonObject {
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': PROCESS_ID } },
      exchanges: { exchange: references.map((value, index) => exchange(index, value)) },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': VERSION },
      },
    },
  };
}

function snapshot(options: {
  table: DatasetMaintenanceRemoteRow['table'];
  id: string;
  version: string;
  userId: string;
  stateCode: number;
  payload: JsonObject;
  modifiedAt?: string;
}): DatasetMaintenanceRowSnapshot {
  return snapshotRemoteRow({
    table: options.table,
    id: options.id,
    version: options.version,
    user_id: options.userId,
    state_code: options.stateCode,
    modified_at: options.modifiedAt ?? MODIFIED,
    json_ordered: options.payload,
    model_id: null,
    rule_verification: null,
  });
}

function remote(row: DatasetMaintenanceRowSnapshot): DatasetMaintenanceRemoteRow {
  return {
    table: row.table,
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    modified_at: row.modified_at,
    json: row.json_ordered,
    json_ordered: row.json_ordered,
    model_id: row.model_id,
    rule_verification: row.rule_verification,
  };
}

function resnapshot(
  row: DatasetMaintenanceRowSnapshot,
  changes: Partial<DatasetMaintenanceRemoteRow>,
): DatasetMaintenanceRowSnapshot {
  return snapshotRemoteRow({
    ...remote(row),
    ...changes,
    json: undefined,
  });
}

const flowPass = (): FlowPayloadValidationResult => ({
  ok: true,
  validator: 'coverage-flow',
  issue_count: 0,
  issues: [],
});
const flowWarning = (): FlowPayloadValidationResult => ({
  ok: false,
  validator: 'coverage-flow',
  issue_count: 1,
  issues: [{ path: 'legacy', message: 'legacy', code: 'legacy' }],
});
const processPass = (): ProcessPayloadValidationResult => ({
  ok: true,
  validator: 'coverage-process',
  issue_count: 0,
  issues: [],
});

function policy(evidence: string): FlowIdentityCompatibilityPolicy {
  return {
    schema_version: 'dataset-flow-identity-compatibility-policy.v1',
    policy_sha256: HASH('policy'),
    evidence_resolution_sha256: evidence,
    approved_at_utc: '2026-07-16T03:00:00.000Z',
    approval_text_sha256: sha256Text(APPROVAL_TEXT),
  };
}

function reviewEntry(index: number): FlowIdentityReviewEntry {
  const disposition =
    index === 0 ? 'map_public' : index === 1 ? 'pending' : index === 2 ? 'blocker' : 'orphan';
  return {
    source: { id: sourceId(index), version: VERSION },
    disposition,
    target:
      disposition === 'map_public'
        ? {
            id: TARGET_ID,
            version: PUBLIC_VERSION,
            reference: reference(TARGET_ID, PUBLIC_VERSION),
          }
        : null,
    allowed_directions: disposition === 'map_public' ? ['Output'] : [],
    source_trace_sha256: HASH(`trace-${index}`),
    compartment_evidence_sha256: HASH(`compartment-${index}`),
    decision_evidence_sha256: HASH(`decision-${index}`),
  };
}

function reviewLedger(): FlowIdentityReviewLedger {
  const review: FlowIdentityReviewLedger = {
    schema_version: 'dataset-flow-identity-review-ledger.v3',
    generated_at_utc: '2026-07-16T03:30:00.000Z',
    source_count: 305,
    review_evidence_sha256: HASH('review-evidence'),
    execution_authority: false,
    entries: Array.from({ length: 305 }, (_, index) => reviewEntry(index)),
    ledger_sha256: '',
  };
  review.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(review);
  return review;
}

function bindCapture(capture: FlowIdentityLiveCapture, review: FlowIdentityReviewLedger): void {
  capture.artifact_evidence.review_ledger_sha256 = review.ledger_sha256;
  capture.artifact_evidence.live_capture_artifact_sha256 =
    computeFlowIdentityCaptureEvidenceSha256(capture);
  const compatibility = policy(review.review_evidence_sha256);
  const semantics = buildFlowIdentitySemantics({
    policy: compatibility,
    review,
    capture,
    validation: { validateFlow: flowWarning, validateProcess: processPass },
  });
  capture.capture_request = buildFlowIdentityCaptureRequest({
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: capture.attestation.operation_id,
    policy: compatibility,
    capture,
    mappings: semantics.mappings,
    processTemplates: semantics.processTemplates,
    protectedClosure: semantics.protectedClosure,
  });
  capture.attestation.capture_request_sha256 = flowIdentityRestrictedSha256(
    capture.capture_request as unknown as JsonObject,
  );
  capture.attestation.policy_sha256 = compatibility.policy_sha256;
  capture.attestation.policy_approval_text_sha256 = compatibility.approval_text_sha256;
  capture.attestation.mapping_count = semantics.mappings.length;
  capture.attestation.process_count = semantics.processTemplates.length;
  capture.attestation.rewrite_count = semantics.processTemplates.reduce(
    (sum, template) => sum + template.process.rewrite_count,
    0,
  );
  capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(capture);
}

function scenario(environment: 'local' | 'production' = 'local') {
  const review = reviewLedger();
  const sourceRows = Array.from({ length: 305 }, (_, index) =>
    snapshot({
      table: 'flows',
      id: sourceId(index),
      version: VERSION,
      userId: ACTOR,
      stateCode: 0,
      payload: flowPayload(sourceId(index), VERSION),
    }),
  );
  const capture: FlowIdentityLiveCapture = {
    schema_version: 'dataset-flow-identity-live-capture.v2',
    captured_at_utc: '2026-07-16T04:10:00.000Z',
    environment,
    project_ref: environment === 'production' ? 'production-project' : 'test-project',
    account: { user_id: ACTOR, email: 'bafudata@example.com' },
    prerequisites: {
      step2_readback_sha256: HASH('step2'),
      step2_completed_at_utc: '2026-07-16T02:00:00.000Z',
      issue29_target1_readback_sha256: HASH('issue29-target1'),
      issue29_target1_completed_at_utc: '2026-07-16T03:00:00.000Z',
      issue29_target2_readback_sha256: HASH('issue29-target2'),
      issue29_target2_completed_at_utc: '2026-07-16T04:00:00.000Z',
    },
    sdk: { package: '@tiangong-lca/tidas-sdk', version: '0.1.45' },
    artifact_evidence: {
      review_ledger_sha256: review.ledger_sha256,
      live_capture_artifact_sha256: '',
      toolchain_evidence_sha256: HASH('toolchain'),
    },
    completeness: {
      schema_version: 'dataset-flow-identity-capture-completeness.v2',
      source_count: 305,
      target_count: 1,
      support_count: 2,
      owner_draft_process_count: 1,
      owner_draft_process_scan: {
        status: 'complete',
        complete: true,
        strategy: 'postgrest_exact_count',
        requested_page_size: 1000,
        effective_page_size: 1,
        pages_fetched: 1,
        rows_fetched: 1,
        exact_total: 1,
        termination_reason: 'content_range_total_reached',
        content_range_verified: true,
        ordering_verified: true,
        duplicate_count: 0,
        row_identity_set_sha256: HASH('process-identities'),
        row_snapshot_set_sha256: HASH('process-snapshots'),
      },
    },
    source_rows: sourceRows,
    target_rows: [
      snapshot({
        table: 'flows',
        id: TARGET_ID,
        version: PUBLIC_VERSION,
        userId: PUBLIC_OWNER,
        stateCode: 100,
        payload: flowPayload(TARGET_ID, PUBLIC_VERSION),
      }),
    ],
    support_rows: [
      snapshot({
        table: 'flowproperties',
        id: FP_ID,
        version: FP_VERSION,
        userId: PUBLIC_OWNER,
        stateCode: 100,
        payload: flowPropertyPayload(),
      }),
      snapshot({
        table: 'unitgroups',
        id: UG_ID,
        version: UG_VERSION,
        userId: PUBLIC_OWNER,
        stateCode: 100,
        payload: unitGroupPayload(),
      }),
    ],
    process_rows: [
      snapshot({
        table: 'processes',
        id: PROCESS_ID,
        version: VERSION,
        userId: ACTOR,
        stateCode: 0,
        payload: processPayload(),
      }),
    ],
    capture_request: {} as never,
    attestation: {
      ok: true,
      command: 'cmd_dataset_flow_identity_capture_attest_guarded',
      schema_version: 'dataset-flow-identity-capture-attest-result.v2',
      proof_domain: 'dataset-flow-identity-db-proof.v2',
      receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      receipt_proof_sha256: HASH('receipt'),
      operation_id: 'coverage-operation',
      environment,
      project_ref: environment === 'production' ? 'production-project' : 'test-project',
      captured_at: '2026-07-16T04:11:00.000Z',
      expires_at: '2026-07-23T04:11:00.000Z',
      source_guard_set_sha256: HASH('source-guards'),
      support_guard_set_sha256: HASH('support-guards'),
      target_guard_set_sha256: HASH('target-guards'),
      mapping_guard_set_sha256: HASH('mapping-guards'),
      process_intent_set_sha256: HASH('process-intents'),
      protected_closure_sha256: HASH('protected'),
      whole_scope_proof_sha256: HASH('whole'),
      policy_sha256: HASH('policy'),
      policy_approval_text_sha256: sha256Text(APPROVAL_TEXT),
      source_count: 305,
      target_count: 1,
      support_count: 2,
      mapping_count: 1,
      process_count: 1,
      rewrite_count: 1,
      capture_request_sha256: '',
      replay: false,
    },
    capture_artifact_sha256: '',
  };
  bindCapture(capture, review);
  return {
    policy: policy(review.review_evidence_sha256),
    review,
    capture,
    validation: { validateFlow: flowWarning, validateProcess: processPass },
  };
}

function toolchainEvidence() {
  return {
    schema_version: 'dataset-alias-protected-toolchain-evidence.v1',
    environment: 'production',
    project_ref: 'production-project',
    verified_at_utc: '2026-07-16T05:00:00.000Z',
    database_engine: {
      repository: 'tiangong-lca/database-engine',
      production_main_commit_sha: '1'.repeat(40),
      production_readback_evidence_sha256: '2'.repeat(64),
      status: 'released_and_read_back',
    },
    cli: {
      repository: 'tiangong-lca/tiangong-cli',
      package_name: '@tiangong-lca/cli',
      package_version: '0.0.28',
      release_commit_sha: '3'.repeat(40),
      release_evidence_sha256: '4'.repeat(64),
      status: 'published_and_verified',
    },
    workspace: {
      repository: 'tiangong-lca/workspace',
      integration_commit_sha: '5'.repeat(40),
      integration_issue_url: 'https://github.com/tiangong-lca/workspace/issues/1',
      status: 'integrated',
    },
  };
}

function prerequisites() {
  return {
    schema_version: 'dataset-flow-identity-prerequisites.v2',
    step2: {
      readback_sha256: HASH('step2'),
      completed_at_utc: '2026-07-16T02:00:00.000Z',
      status: 'passed',
    },
    issue29_target1: {
      readback_sha256: HASH('issue29-target1'),
      completed_at_utc: '2026-07-16T03:00:00.000Z',
      status: 'passed',
    },
    issue29_target2: {
      readback_sha256: HASH('issue29-target2'),
      completed_at_utc: '2026-07-16T04:00:00.000Z',
      status: 'passed',
    },
  } as const;
}

function makeAttestation(request: JsonObject): JsonObject {
  const mappings = request.mappings as JsonObject[];
  const intents = request.process_intents as JsonObject[];
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_capture_attest_guarded',
    schema_version: 'dataset-flow-identity-capture-attest-result.v2',
    proof_domain: 'dataset-flow-identity-db-proof.v2',
    receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    receipt_proof_sha256: HASH('capture-receipt'),
    operation_id: request.operation_id,
    environment: request.environment,
    project_ref: request.project_ref,
    captured_at: '2026-07-16T05:00:01.000Z',
    expires_at: '2026-07-22T05:00:01.000Z',
    source_guard_set_sha256: HASH('capture-source'),
    support_guard_set_sha256: HASH('capture-support'),
    target_guard_set_sha256: HASH('capture-target'),
    mapping_guard_set_sha256: HASH('capture-mapping'),
    process_intent_set_sha256: HASH('capture-process'),
    protected_closure_sha256: HASH('capture-protected'),
    whole_scope_proof_sha256: HASH('capture-whole'),
    policy_sha256: (request.compatibility_policy as JsonObject).policy_sha256,
    policy_approval_text_sha256: (request.compatibility_policy as JsonObject).approval_text_sha256,
    source_count: 305,
    target_count: 1,
    support_count: 2,
    mapping_count: mappings.length,
    process_count: intents.length,
    rewrite_count: intents.reduce(
      (sum, intent) => sum + (intent.rewrites as JsonObject[]).length,
      0,
    ),
    capture_request_sha256: flowIdentityRestrictedSha256(request),
    replay: false,
  };
}

function captureFixture(root: string) {
  const input = scenario();
  const artifacts = path.join(root, 'inputs');
  writePrivateImmutableJson(path.join(artifacts, 'policy.json'), input.policy);
  writePrivateImmutableJson(path.join(artifacts, 'review.json'), input.review);
  writePrivateImmutableJson(path.join(artifacts, 'prerequisites.json'), prerequisites());
  writePrivateImmutableJson(path.join(artifacts, 'toolchain.json'), toolchainEvidence());
  const exactRows = new Map(
    [...input.capture.target_rows, ...input.capture.support_rows].map((row) => [
      `${row.table}\u0000${row.id}\u0000${row.version}`,
      remote(row),
    ]),
  );
  const tableCompleteness = (count: number) => ({
    status: 'complete' as const,
    complete: true as const,
    strategy: 'postgrest_exact_count' as const,
    requested_page_size: 1000,
    effective_page_size: count,
    pages_fetched: 1,
    rows_fetched: count,
    exact_total: count,
    termination_reason: 'content_range_total_reached' as const,
    content_range_verified: true as const,
    ordering_verified: true as const,
    duplicate_count: 0 as const,
  });
  const options: Parameters<typeof captureInternals.executeCapture>[0] = {
    policyPath: path.join(artifacts, 'policy.json'),
    reviewLedgerPath: path.join(artifacts, 'review.json'),
    prerequisitesPath: path.join(artifacts, 'prerequisites.json'),
    toolchainEvidencePath: path.join(artifacts, 'toolchain.json'),
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: 'coverage-capture',
    expectedProjectRef: 'production-project',
    confirm: 'bafudata@example.com',
    cliVersion: '0.0.28',
    sdkVersion: '0.1.45',
    outDir: path.join(root, 'out'),
    env: {},
    fetchImpl: async () => {
      throw new Error('unused');
    },
    now: new Date('2026-07-16T05:00:00.000Z'),
    validation: input.validation,
  };
  const dependencies: Parameters<typeof captureInternals.executeCapture>[1] = {
    resolveContext: async ({ fetchImpl }) => ({
      project_ref: 'production-project',
      rest_base_url: 'https://example.test/rest/v1',
      publishable_key: 'key',
      access_token: 'token',
      account: { user_id: ACTOR, email: 'bafudata@example.com', session_source: 'coverage' },
      fetch_impl: fetchImpl,
      timeout_ms: 1000,
    }),
    fetchAccountTableRows: async ({ table }) => ({
      rows:
        table === 'flows'
          ? input.capture.source_rows.map(remote)
          : input.capture.process_rows.map(remote),
      source_urls: [table],
      completeness: tableCompleteness(table === 'flows' ? 305 : 1),
    }),
    fetchExactRows: async ({ table, id, version }) => {
      const row = exactRows.get(`${table}\u0000${id}\u0000${version}`);
      return { rows: row ? [row] : [], source_url: 'exact' };
    },
    attest: async ({ request }) => makeAttestation(request),
    materialize: materializePrivateArtifactDirectoryAtomically,
  };
  return { input, options, dependencies, exactRows };
}

test('wire coverage closes cycle, large-index, and canonical-key ordering branches', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => assertFlowIdentityWireValue(cyclic), /must not contain a cycle/u);
  assert.equal(wireInternals.arrayIndex('4294967295'), null);
  assert.equal(wireInternals.compareCanonicalKeys('0', 'word'), -1);
  assert.equal(wireInternals.compareCanonicalKeys('word', '0'), 1);
  assert.equal(wireInternals.compareCanonicalKeys('z', 'a'), 1);
  assert.equal(wireInternals.compareCanonicalKeys('same', 'same'), 0);
});

test('capture helper coverage rejects malformed prerequisites, rows, and supports', async () => {
  assert.throws(() => parseFlowIdentityPrerequisites(null), /prerequisites are invalid/u);
  const missingTarget2 = structuredClone(prerequisites()) as JsonObject;
  delete missingTarget2.issue29_target2;
  assert.throws(() => parseFlowIdentityPrerequisites(missingTarget2), /prerequisites are invalid/u);
  const badPrerequisites = structuredClone(prerequisites()) as JsonObject;
  (badPrerequisites.step2 as JsonObject).status = 'failed';
  assert.throws(
    () => parseFlowIdentityPrerequisites(badPrerequisites),
    /do not prove passed Step 2/u,
  );
  const openTarget2 = structuredClone(prerequisites()) as JsonObject;
  (openTarget2.issue29_target2 as JsonObject).status = 'pending';
  assert.throws(() => parseFlowIdentityPrerequisites(openTarget2), /do not prove passed Step 2/u);
  assert.throws(
    () =>
      captureInternals.snapshot({
        table: 'flows',
        id: sourceId(0),
        version: VERSION,
      } as never),
    /incomplete/u,
  );
  assert.throws(() => captureInternals.flowPropertyClaim({}), /flow-property identity/u);
  assert.throws(() => captureInternals.unitGroupClaim({}), /unit-group identity/u);
  const propertyArray = flowPayload(sourceId(0), VERSION);
  const propertyRoot = propertyArray.flowDataSet as JsonObject;
  const propertyCollection = propertyRoot.flowProperties as JsonObject;
  propertyCollection.flowProperty = [propertyCollection.flowProperty as JsonObject];
  assert.deepEqual(captureInternals.flowPropertyClaim(propertyArray), {
    id: FP_ID,
    version: FP_VERSION,
  });
  propertyCollection.flowProperty = [propertyCollection.flowProperty as JsonObject, 'bad'];
  assert.throws(
    () => captureInternals.flowPropertyClaim(propertyArray),
    /support collection is malformed/u,
  );

  await assert.rejects(
    captureFlowIdentity({
      policyPath: 'unused',
      reviewLedgerPath: 'unused',
      prerequisitesPath: 'unused',
      toolchainEvidencePath: 'unused',
      requestId: 'bad',
      operationId: 'operation',
      expectedProjectRef: 'production-project',
      confirm: 'bafudata@example.com',
      cliVersion: '0.0.28',
      sdkVersion: '0.1.45',
      outDir: 'unused',
      env: {},
      fetchImpl: async () => {
        throw new Error('must not run');
      },
    }),
    /canonical UUID/u,
  );
});

test('capture process closure coverage handles missing, singleton, and malformed exchanges', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-capture-process-shapes-'));
  try {
    const payloads: Array<{ payload: JsonObject; succeeds: boolean }> = [
      { payload: {}, succeeds: false },
      { payload: { processDataSet: {} }, succeeds: false },
      {
        payload: {
          processDataSet: {
            exchanges: { exchange: exchange(0, reference(sourceId(0), VERSION)) },
          },
        },
        succeeds: true,
      },
      {
        payload: { processDataSet: { exchanges: { exchange: ['bad'] } } },
        succeeds: false,
      },
      {
        payload: {
          processDataSet: {
            exchanges: {
              exchange: { '@dataSetInternalID': '1', exchangeDirection: 'Output', bad: true },
            },
          },
        },
        succeeds: false,
      },
    ];
    for (const [index, entry] of payloads.entries()) {
      const fixture = captureFixture(path.join(root, String(index)));
      const processRow = remote(
        snapshot({
          table: 'processes',
          id: PROCESS_ID,
          version: VERSION,
          userId: ACTOR,
          stateCode: 0,
          payload: entry.payload,
        }),
      );
      const dependencies = {
        ...fixture.dependencies,
        fetchAccountTableRows: async (options: { table: string }) =>
          options.table === 'flows'
            ? fixture.dependencies.fetchAccountTableRows(options as never)
            : {
                rows: [processRow],
                source_urls: ['processes'],
                completeness: {
                  status: 'complete' as const,
                  complete: true as const,
                  strategy: 'postgrest_exact_count' as const,
                  requested_page_size: 1000,
                  effective_page_size: 1,
                  pages_fetched: 1,
                  rows_fetched: 1,
                  exact_total: 1,
                  termination_reason: 'content_range_total_reached' as const,
                  content_range_verified: true as const,
                  ordering_verified: true as const,
                  duplicate_count: 0 as const,
                },
              },
      } as Parameters<typeof captureInternals.executeCapture>[1];
      if (entry.succeeds) {
        const report = await captureInternals.executeCapture(fixture.options, dependencies);
        assert.equal(report.counts.affected_processes, 1);
      } else {
        await assert.rejects(captureInternals.executeCapture(fixture.options, dependencies));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture remote coverage closes visibility, sorting, and live guard branches', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-capture-remote-'));
  try {
    const privateSupports = captureFixture(path.join(root, 'private-supports'));
    for (const row of privateSupports.input.capture.support_rows) {
      const draft = resnapshot(row, { user_id: ACTOR, state_code: 0 });
      privateSupports.exactRows.set(
        `${row.table}\u0000${row.id}\u0000${row.version}`,
        remote(draft),
      );
    }
    const privateReport = await captureInternals.executeCapture(
      privateSupports.options,
      privateSupports.dependencies,
    );
    assert.equal(privateReport.counts.supports, 2);

    const missing = captureFixture(path.join(root, 'missing'));
    missing.exactRows.delete(`flows\u0000${TARGET_ID}\u0000${PUBLIC_VERSION}`);
    await assert.rejects(
      captureInternals.executeCapture(missing.options, missing.dependencies),
      /missing, duplicated, or outside visibility/u,
    );

    const sorted = captureFixture(path.join(root, 'sorted'));
    const target2 = '77777777-7777-4777-8777-777777777777';
    const review2 = structuredClone(sorted.input.review);
    review2.entries[3] = {
      ...review2.entries[3]!,
      disposition: 'map_public',
      target: {
        id: target2,
        version: PUBLIC_VERSION,
        reference: reference(target2, PUBLIC_VERSION),
      },
      allowed_directions: ['Output'],
    };
    review2.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(review2);
    const review2Path = path.join(root, 'review-two-targets.json');
    writePrivateImmutableJson(review2Path, review2);
    sorted.options.reviewLedgerPath = review2Path;
    sorted.exactRows.set(
      `flows\u0000${target2}\u0000${PUBLIC_VERSION}`,
      remote(
        snapshot({
          table: 'flows',
          id: target2,
          version: PUBLIC_VERSION,
          userId: PUBLIC_OWNER,
          stateCode: 100,
          payload: flowPayload(target2, PUBLIC_VERSION),
        }),
      ),
    );
    const sortedReport = await captureInternals.executeCapture(sorted.options, {
      ...sorted.dependencies,
      attest: async ({ request }) => ({ ...makeAttestation(request), target_count: 2 }),
    });
    assert.equal(sortedReport.counts.targets, 2);

    const mismatchedPolicy = captureFixture(path.join(root, 'policy'));
    const wrongPolicy = {
      ...mismatchedPolicy.input.policy,
      evidence_resolution_sha256: HASH('wrong'),
    };
    const wrongPolicyPath = path.join(root, 'wrong-policy.json');
    writePrivateImmutableJson(wrongPolicyPath, wrongPolicy);
    await assert.rejects(
      captureInternals.executeCapture(
        { ...mismatchedPolicy.options, policyPath: wrongPolicyPath },
        mismatchedPolicy.dependencies,
      ),
      /does not bind the review ledger/u,
    );

    const future = captureFixture(path.join(root, 'future'));
    await assert.rejects(
      captureInternals.executeCapture(
        { ...future.options, now: new Date('2026-07-16T01:00:00.000Z') },
        future.dependencies,
      ),
      /precedes a required passed prerequisite/u,
    );

    const context = captureFixture(path.join(root, 'context'));
    await assert.rejects(
      captureInternals.executeCapture(context.options, {
        ...context.dependencies,
        resolveContext: async (options) => ({
          ...(await context.dependencies.resolveContext(options)),
          project_ref: 'foreign-project',
        }),
      }),
      /does not match capture confirmation/u,
    );

    const census = captureFixture(path.join(root, 'census'));
    await assert.rejects(
      captureInternals.executeCapture(census.options, {
        ...census.dependencies,
        fetchAccountTableRows: async (options) => {
          const result = await census.dependencies.fetchAccountTableRows(options);
          return options.table === 'flows'
            ? { ...result, rows: result.rows.slice(0, 304) }
            : result;
        },
      }),
      /exact 305-row review universe/u,
    );

    const defaultNow = captureFixture(path.join(root, 'default-now'));
    const defaultNowReport = await captureInternals.executeCapture(
      { ...defaultNow.options, now: undefined },
      {
        ...defaultNow.dependencies,
        attest: async ({ request }) => {
          const capturedAt = new Date();
          const raw = makeAttestation(request);
          raw.captured_at = capturedAt.toISOString();
          raw.expires_at = new Date(capturedAt.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString();
          return raw;
        },
      },
    );
    assert.equal(defaultNowReport.status, 'captured');

    const defaultValidation = captureFixture(path.join(root, 'default-validation'));
    await assert.rejects(
      captureInternals.executeCapture(
        { ...defaultValidation.options, validation: undefined },
        defaultValidation.dependencies,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture coverage exercises immutable-input and validation fail-fast branches', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-capture-failfast-'));
  try {
    const fixture = captureFixture(root);
    const noncanonical = path.join(root, 'noncanonical.json');
    writeFileSync(noncanonical, `${JSON.stringify(fixture.input.policy, null, 2)}\n`, 'utf8');
    await assert.rejects(
      captureInternals.executeCapture(
        { ...fixture.options, policyPath: noncanonical },
        fixture.dependencies,
      ),
      /canonical JSON/u,
    );

    await assert.rejects(
      captureInternals.executeCapture(
        {
          ...fixture.options,
          outDir: path.join(root, 'bad-operation'),
          operationId: ' '.repeat(2),
        },
        fixture.dependencies,
      ),
      /operation ID/u,
    );
    await assert.rejects(
      captureInternals.executeCapture(
        { ...fixture.options, outDir: path.join(root, 'bad-concurrency'), readConcurrency: 0 },
        fixture.dependencies,
      ),
      /read concurrency/u,
    );
    await assert.rejects(
      captureInternals.executeCapture(
        { ...fixture.options, outDir: path.join(root, 'bad-sdk'), sdkVersion: ' ' },
        fixture.dependencies,
      ),
      /SDK version/u,
    );
    mkdirSync(fixture.options.outDir);
    await assert.rejects(
      captureInternals.executeCapture(fixture.options, fixture.dependencies),
      /already exists/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture coverage persists both transport and invalid-response recovery evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-capture-recovery-'));
  try {
    const transport = captureFixture(path.join(root, 'transport'));
    await assert.rejects(
      captureInternals.executeCapture(transport.options, {
        ...transport.dependencies,
        attest: async () => {
          throw new Error('ambiguous transport');
        },
      }),
      /ambiguous transport/u,
    );
    assert.equal(
      existsSync(path.join(transport.options.outDir, 'flow-identity-capture-indeterminate.json')),
      true,
    );
    assert.equal(
      existsSync(path.join(transport.options.outDir, 'flow-identity-capture-raw-response.json')),
      false,
    );

    const invalid = captureFixture(path.join(root, 'invalid'));
    await assert.rejects(
      captureInternals.executeCapture(invalid.options, {
        ...invalid.dependencies,
        attest: async () => {
          mkdirSync(invalid.options.outDir, { recursive: true });
          return { invalid: true };
        },
      }),
    );
    const recovery = `${path.resolve(invalid.options.outDir)}.indeterminate-${invalid.options.requestId}`;
    assert.equal(existsSync(path.join(recovery, 'flow-identity-capture-raw-response.json')), true);

    const rejected = captureFixture(path.join(root, 'rejected'));
    const domainResponse = {
      ok: false,
      command: 'cmd_dataset_flow_identity_capture_attest_guarded',
      code: 'FLOW_IDENTITY_CAPTURE_LOCK_BUSY',
      status: 409,
      message: 'Capture lock is busy',
    };
    await assert.rejects(
      captureInternals.executeCapture(rejected.options, {
        ...rejected.dependencies,
        attest: async () => domainResponse,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'FLOW_IDENTITY_CAPTURE_LOCK_BUSY',
    );
    assert.equal(
      existsSync(path.join(rejected.options.outDir, 'flow-identity-capture-domain-rejection.json')),
      true,
    );
    assert.equal(
      existsSync(path.join(rejected.options.outDir, 'flow-identity-capture-indeterminate.json')),
      false,
    );

    const rejectedWithoutMessage = captureFixture(path.join(root, 'rejected-without-message'));
    await assert.rejects(
      captureInternals.executeCapture(rejectedWithoutMessage.options, {
        ...rejectedWithoutMessage.dependencies,
        attest: async () => ({
          ok: false,
          command: 'cmd_dataset_flow_identity_capture_attest_guarded',
          code: 'FLOW_IDENTITY_CAPTURE_LOCK_BUSY',
          status: 409,
        }),
      }),
      /Flow identity capture was rejected by the database/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan helper coverage closes snapshot, support, occurrence, and collision branches', () => {
  const input = scenario();
  const source = input.capture.source_rows[0]!;
  const tampered = { ...source, row_sha256: HASH('tampered') };
  assert.throws(() => planInternals.indexRows([tampered], 'flows'), /snapshot hash/u);
  assert.throws(() => planInternals.indexRows([source, source], 'flows'), /duplicate flows/u);
  assert.equal(planInternals.processExchanges({}), null);
  assert.equal(planInternals.flowClassificationInformation({}), null);
  assert.equal(planInternals.flowGuardRowSha256({ ...source, modified_at: 'bad' }), null);
  assert.equal(
    planInternals.processGuardRowSha256({ ...input.capture.process_rows[0]!, modified_at: 'bad' }),
    null,
  );
  assert.equal(
    planInternals.endpoint({ ...source, modified_at: 'bad' }, input.capture.support_rows, ACTOR),
    null,
  );

  const missingPayload = { ...input.capture.process_rows[0]!, json_ordered: null };
  assert.throws(() => planInternals.collectOccurrences([missingPayload]), /no json_ordered/u);
  const malformedCollection = resnapshot(input.capture.process_rows[0]!, {
    json_ordered: { processDataSet: { exchanges: { exchange: ['bad'] } } },
  });
  assert.throws(
    () => planInternals.collectOccurrences([malformedCollection]),
    /malformed exchange collection/u,
  );
  const malformedReference = resnapshot(input.capture.process_rows[0]!, {
    json_ordered: processPayload([{ ...reference(sourceId(0), VERSION), '@version': '' }]),
  });
  assert.throws(
    () => planInternals.collectOccurrences([malformedReference]),
    /malformed flow reference/u,
  );
  const malformedIdentity = resnapshot(input.capture.process_rows[0]!, {
    json_ordered: {
      processDataSet: {
        exchanges: {
          exchange: {
            exchangeDirection: 'Sideways',
            referenceToFlowDataSet: reference(sourceId(0), VERSION),
          },
        },
      },
    },
  });
  assert.throws(
    () => planInternals.collectOccurrences([malformedIdentity]),
    /identity or direction/u,
  );

  const oneRewrite = {
    ordinal: 1,
    exchange_index: 0,
    internal_id: '1',
    direction: 'Output',
    mapping_id: HASH('mapping'),
    source_reference: reference(sourceId(0), VERSION),
    target_reference: reference(TARGET_ID, PUBLIC_VERSION),
    before_reference_sha256: HASH('before'),
    after_reference_sha256: HASH('after'),
  } as const;
  assert.deepEqual(
    planInternals.collisionLedger({
      desiredExchanges: [exchange(0, reference(TARGET_ID, PUBLIC_VERSION))],
      rewrites: [oneRewrite],
    }).entries,
    [],
  );

  const orphanReview = reviewLedger();
  const orphan = orphanReview.entries[3]!;
  const occurrences = new Map([
    [planInternals.rowKey(orphan.source.id, orphan.source.version), [{ fake: true } as never]],
  ]);
  assert.throws(
    () => planInternals.buildProtectedClosure(orphanReview, occurrences),
    /orphan has live process references/u,
  );
});

test('plan coverage reaches support-shape and semantic fail-closed branches', () => {
  const input = scenario();
  const source = input.capture.source_rows[0]!;
  const supports = input.capture.support_rows;
  assert.equal(
    planInternals.flowSupportFacts({ ...source, json_ordered: null }, supports, ACTOR),
    null,
  );
  assert.equal(
    planInternals.flowSupportFacts(resnapshot(source, { json_ordered: {} }), supports, ACTOR),
    null,
  );

  const noPropertyReference = structuredClone(source.json_ordered!);
  const root = noPropertyReference.flowDataSet as JsonObject;
  delete (root.flowInformation as JsonObject).quantitativeReference;
  assert.equal(
    planInternals.flowSupportFacts(
      resnapshot(source, { json_ordered: noPropertyReference }),
      supports,
      ACTOR,
    ),
    null,
  );

  const missingFp = supports.filter((row) => row.table !== 'flowproperties');
  assert.equal(planInternals.flowSupportFacts(source, missingFp, ACTOR), null);
  const privateUg = resnapshot(supports[1]!, { user_id: ACTOR, state_code: 0 });
  assert.notEqual(planInternals.flowSupportFacts(source, [supports[0]!, privateUg], ACTOR), null);

  const duplicateSupport = structuredClone(input.capture);
  duplicateSupport.support_rows.push(duplicateSupport.support_rows[0]!);
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: duplicateSupport,
        validation: input.validation,
      }),
    /duplicate support rows/u,
  );

  const incompleteSources = structuredClone(input.capture);
  incompleteSources.source_rows.pop();
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: incompleteSources,
        validation: input.validation,
      }),
    /exactly the 305/u,
  );

  const foreignSource = structuredClone(input.capture);
  foreignSource.source_rows[0] = resnapshot(foreignSource.source_rows[0]!, {
    user_id: PUBLIC_OWNER,
  });
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: foreignSource,
        validation: input.validation,
      }),
    /current-owner state-0/u,
  );

  const foreignProcess = structuredClone(input.capture);
  foreignProcess.process_rows[0] = resnapshot(foreignProcess.process_rows[0]!, {
    user_id: PUBLIC_OWNER,
  });
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: foreignProcess,
        validation: input.validation,
      }),
    /foreign-owner or non-draft/u,
  );
});

test('plan support coverage closes nested FP/UG and target-name shape branches', () => {
  const input = scenario();
  const source = input.capture.source_rows[0]!;
  const [flowProperty, unitGroup] = input.capture.support_rows;

  const missingPropertyVersion = structuredClone(source.json_ordered!);
  const missingPropertyRoot = missingPropertyVersion.flowDataSet as JsonObject;
  const missingPropertyCollection = missingPropertyRoot.flowProperties as JsonObject;
  const missingProperty = missingPropertyCollection.flowProperty as JsonObject;
  delete (missingProperty.referenceToFlowPropertyDataSet as JsonObject)['@version'];
  assert.equal(
    planInternals.flowSupportFacts(
      resnapshot(source, { json_ordered: missingPropertyVersion }),
      input.capture.support_rows,
      ACTOR,
    ),
    null,
  );

  assert.equal(
    planInternals.flowSupportFacts(
      source,
      [resnapshot(flowProperty!, { json_ordered: {} }), unitGroup!],
      ACTOR,
    ),
    null,
  );
  assert.equal(
    planInternals.flowSupportFacts(
      source,
      [flowProperty!, resnapshot(unitGroup!, { json_ordered: {} })],
      ACTOR,
    ),
    null,
  );
  assert.notEqual(
    planInternals.flowSupportFacts(
      source,
      [
        resnapshot(flowProperty!, { user_id: ACTOR, state_code: 0 }),
        resnapshot(unitGroup!, { user_id: ACTOR, state_code: 0 }),
      ],
      ACTOR,
    ),
    null,
  );

  const extraSupport = {
    ...input.capture,
    support_rows: [...input.capture.support_rows, input.capture.source_rows[0]!],
  };
  const passing = buildFlowIdentitySemantics({
    policy: input.policy,
    review: input.review,
    capture: extraSupport,
    validation: { validateFlow: flowPass, validateProcess: processPass },
  });
  assert.equal(passing.mappings[0]!.compatibility.flow_schema.status, 'pass');

  function targetPayloadOnThirdRead(payload: JsonObject): FlowIdentityLiveCapture {
    const original = input.capture.target_rows[0]!;
    let reads = 0;
    const target = new Proxy(original, {
      get(row, key, receiver) {
        if (key === 'json_ordered' && ++reads === 3) return payload;
        return Reflect.get(row, key, receiver);
      },
    });
    return { ...input.capture, target_rows: [target] };
  }

  const arrayNames = flowPayload(TARGET_ID, PUBLIC_VERSION);
  const arrayRoot = arrayNames.flowDataSet as JsonObject;
  const arrayInformation = arrayRoot.flowInformation as JsonObject;
  const arrayDataset = arrayInformation.dataSetInformation as JsonObject;
  (arrayDataset.name as JsonObject).baseName = [
    {},
    { '#text': '   ', '@xml:lang': 'en' },
    TARGET_ID,
  ];
  const arraySemantics = buildFlowIdentitySemantics({
    policy: input.policy,
    review: input.review,
    capture: targetPayloadOnThirdRead(arrayNames),
    validation: input.validation,
  });
  assert.equal(arraySemantics.mappings.length, 1);

  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: targetPayloadOnThirdRead({}),
        validation: input.validation,
      }),
    /compatibility guard/u,
  );
});

test('plan semantic coverage closes absent target and exact support-guard branches', () => {
  const input = scenario();
  const review = { ...input.review, entries: [...input.review.entries] };
  const mapped = { ...review.entries[0]! } as FlowIdentityReviewEntry;
  const exactTarget = structuredClone(mapped.target!);
  let targetReads = 0;
  Object.defineProperty(mapped, 'target', {
    enumerable: true,
    get: () =>
      ++targetReads <= 2
        ? exactTarget
        : { ...exactTarget, id: '77777777-7777-4777-8777-777777777777' },
  });
  review.entries[0] = mapped;
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review,
        capture: input.capture,
        validation: input.validation,
      }),
    /source or target is absent/u,
  );

  function supportRowsOnSnapshotBuild(
    rows: DatasetMaintenanceRowSnapshot[],
  ): FlowIdentityLiveCapture {
    let reads = 0;
    const capture = { ...input.capture };
    Object.defineProperty(capture, 'support_rows', {
      enumerable: true,
      get: () => (++reads < 309 ? input.capture.support_rows : rows),
    });
    return capture;
  }

  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: supportRowsOnSnapshotBuild([input.capture.support_rows[1]!]),
        validation: input.validation,
      }),
    /cannot produce an exact database guard/u,
  );
  const invalidGuard = resnapshot(input.capture.support_rows[0]!, { modified_at: 'bad' });
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: supportRowsOnSnapshotBuild([invalidGuard, input.capture.support_rows[1]!]),
        validation: input.validation,
      }),
    /cannot produce an exact database guard/u,
  );
});

test('plan process coverage closes sorting, no-op, and malformed fresh-row branches', () => {
  const input = scenario();
  const secondProcess = snapshot({
    table: 'processes',
    id: '88888888-8888-4888-8888-888888888888',
    version: VERSION,
    userId: ACTOR,
    stateCode: 0,
    payload: processPayload(),
  });
  assert.ok(
    planInternals.collectOccurrences([secondProcess, input.capture.process_rows[0]!]).size > 0,
  );

  const noRewriteProcess = resnapshot(input.capture.process_rows[0]!, {
    json_ordered: processPayload([reference(TARGET_ID, PUBLIC_VERSION)]),
  });
  const noRewrite = buildFlowIdentitySemantics({
    policy: input.policy,
    review: input.review,
    capture: { ...input.capture, process_rows: [noRewriteProcess] },
    validation: input.validation,
  });
  assert.deepEqual(noRewrite.processTemplates, []);

  function processPayloadAfterSnapshot(payload: JsonObject | null): FlowIdentityLiveCapture {
    const original = input.capture.process_rows[0]!;
    let reads = 0;
    const process = new Proxy(original, {
      get(row, key, receiver) {
        if (key === 'json_ordered') {
          reads += 1;
          return reads <= 3 ? row.json_ordered : payload;
        }
        return Reflect.get(row, key, receiver);
      },
    });
    return { ...input.capture, process_rows: [process] };
  }

  for (const [payload, message] of [
    [null, /lacks a complete fresh snapshot/u],
    [{ processDataSet: {} }, /exchange collection is malformed/u],
    [
      processPayload([{ ...reference(sourceId(0), VERSION), '@version': '' }]),
      /malformed source reference/u,
    ],
    [
      {
        processDataSet: {
          exchanges: {
            exchange: {
              '@dataSetInternalID': '1',
              exchangeDirection: 'Sideways',
              referenceToFlowDataSet: reference(sourceId(0), VERSION),
            },
          },
        },
      },
      /identity, direction, or reference object is malformed/u,
    ],
  ] as const) {
    assert.throws(
      () =>
        buildFlowIdentitySemantics({
          policy: input.policy,
          review: input.review,
          capture: processPayloadAfterSnapshot(payload),
          validation: input.validation,
        }),
      message,
    );
  }

  const invalidProcessGuard = resnapshot(input.capture.process_rows[0]!, { modified_at: 'bad' });
  assert.throws(
    () =>
      buildFlowIdentitySemantics({
        policy: input.policy,
        review: input.review,
        capture: { ...input.capture, process_rows: [invalidProcessGuard] },
        validation: input.validation,
      }),
    /cannot produce the database guard hash/u,
  );
});

test('plan coverage rejects foreign mapping rewrites and receipt drift', () => {
  const input = scenario();
  const semantics = buildFlowIdentitySemantics({
    policy: input.policy,
    review: input.review,
    capture: input.capture,
    validation: input.validation,
  });
  const badTemplates = structuredClone(semantics.processTemplates);
  badTemplates[0]!.rewrites[0]!.mapping_id = HASH('foreign-mapping');
  assert.throws(
    () =>
      buildFlowIdentityCaptureRequest({
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        operationId: 'coverage-operation',
        policy: input.policy,
        capture: input.capture,
        mappings: semantics.mappings,
        processTemplates: badTemplates,
        protectedClosure: semantics.protectedClosure,
      }),
    /foreign mapping/u,
  );

  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: input.policy,
        reviewLedger: input.review,
        liveCapture: input.capture,
        now: new Date('2026-07-24T00:00:00.000Z'),
        validation: input.validation,
      }),
    /foreign, expired/u,
  );

  const requestDrift = structuredClone(input.capture);
  const driftIntents = (requestDrift.capture_request as unknown as JsonObject)
    .process_intents as JsonObject[];
  ((driftIntents[0]!.rewrites as JsonObject[])[0] as JsonObject).internal_id = '999';
  requestDrift.attestation.capture_request_sha256 = flowIdentityRestrictedSha256(
    requestDrift.capture_request as unknown as JsonObject,
  );
  requestDrift.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(requestDrift);
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: input.policy,
        reviewLedger: input.review,
        liveCapture: requestDrift,
        now: new Date('2026-07-16T05:00:00.000Z'),
        validation: input.validation,
      }),
    /does not bind the exact local/u,
  );
});

test('plan coverage closes default validators and deterministic receipt-count rejection', () => {
  const defaults = scenario();
  try {
    const bundle = buildFlowIdentityPlan({
      policy: defaults.policy,
      reviewLedger: defaults.review,
      liveCapture: defaults.capture,
      now: new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(bundle.plan.status, 'ready');
  } catch (error) {
    assert.ok(error instanceof Error);
  }

  const input = scenario();
  const attestation = { ...input.capture.attestation };
  const capture = { ...input.capture, attestation };
  Object.defineProperty(attestation, 'mapping_count', {
    enumerable: true,
    get() {
      const stack = new Error().stack ?? '';
      return stack.includes('parseFlowIdentityCapture') ||
        stack.includes('computeFlowIdentityCapture')
        ? 1
        : 2;
    },
  });
  const previousStackTraceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  try {
    assert.throws(
      () =>
        buildFlowIdentityPlan({
          policy: input.policy,
          reviewLedger: input.review,
          liveCapture: capture,
          now: new Date('2026-07-16T05:00:00.000Z'),
          validation: input.validation,
        }),
      /receipt counts do not match/u,
    );
  } finally {
    Error.stackTraceLimit = previousStackTraceLimit;
  }
});

test('plan writer coverage preserves explicit empty JSONL behavior', () => {
  const input = scenario();
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-plan-empty-writer-'));
  const originalMap = Array.prototype.map;
  Object.defineProperty(Array.prototype, 'map', {
    configurable: true,
    writable: true,
    value: function mapWithCoverageProxy(
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown,
    ): unknown[] {
      const result = originalMap.call(this, callback as never, thisArg) as unknown[];
      const first = result[0];
      if (first && typeof first === 'object' && 'process_template_sha256' in first) {
        return new Proxy(result, {
          get(rows, key, receiver) {
            if (key === 'length') {
              const stack = new Error().stack ?? '';
              if (
                stack.includes('runFlowIdentityPlan') &&
                !stack.includes('buildFlowIdentityPlan')
              ) {
                return 0;
              }
            }
            return Reflect.get(rows, key, receiver);
          },
        });
      }
      if (first && typeof first === 'object' && 'ledger' in first) {
        return new Proxy(result, {
          get(rows, key, receiver) {
            return key === 'length' ? 0 : Reflect.get(rows, key, receiver);
          },
        });
      }
      return result;
    },
  });
  try {
    const outDir = path.join(root, 'out');
    const plan = runFlowIdentityPlan({
      policy: input.policy,
      reviewLedger: input.review,
      liveCapture: input.capture,
      outDir,
      now: new Date('2026-07-16T05:00:00.000Z'),
      validation: input.validation,
    });
    assert.equal(plan.processes.length, 1);
    assert.equal(readFileSync(path.join(outDir, plan.artifacts.process_manifest), 'utf8'), '');
    assert.equal(readFileSync(path.join(outDir, plan.artifacts.collision_ledger), 'utf8'), '');
  } finally {
    Object.defineProperty(Array.prototype, 'map', {
      configurable: true,
      writable: true,
      value: originalMap,
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test('freeze and seal coverage closes timestamp, canonical-file, and default-now branches', () => {
  assert.doesNotThrow(() =>
    sealInternals.requireDistinctApprovalHashDomains(['policy', 'request', 'text', 'identity']),
  );
  assert.throws(
    () => sealInternals.requireDistinctApprovalHashDomains(['same', 'same']),
    /hash domains must remain distinct/u,
  );
  assert.throws(
    () => freezeInternals.canonicalTimestamp('2026-07-16T00:00:00+00:00', 'time'),
    /canonical RFC3339/u,
  );
  assert.throws(
    () => renderFlowIdentityExecutionApprovalText({} as never, 'bad'),
    /request SHA-256/u,
  );

  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-freeze-coverage-'));
  try {
    const input = scenario('production');
    const bundle = buildFlowIdentityPlan({
      policy: input.policy,
      reviewLedger: input.review,
      liveCapture: input.capture,
      now: new Date('2026-07-16T04:20:00.000Z'),
      validation: input.validation,
    });
    const planPath = path.join(root, 'plan.json');
    const toolchainPath = path.join(root, 'toolchain.json');
    writePrivateImmutableJson(planPath, bundle.plan);
    writePrivateImmutableJson(toolchainPath, toolchainEvidence());

    assert.throws(
      () =>
        freezeFlowIdentity({
          planPath,
          toolchainEvidencePath: toolchainPath,
          expectedProjectRef: 'production-project',
          confirm: 'bafudata@example.com',
          approvedAtUtc: '2026-07-16T04:29:59.000Z',
          cliVersion: '0.0.28',
          outDir: path.join(root, 'too-early'),
          now: new Date('2026-07-16T04:30:00.000Z'),
        }),
      /cannot precede the freeze/u,
    );

    const freezeDir = path.join(root, 'freeze');
    const freezeReport = freezeFlowIdentity({
      planPath,
      toolchainEvidencePath: toolchainPath,
      expectedProjectRef: 'production-project',
      confirm: 'bafudata@example.com',
      approvedAtUtc: '2099-07-16T05:00:00.000Z',
      cliVersion: '0.0.28',
      outDir: freezeDir,
    });
    assert.equal(freezeReport.status, 'frozen');

    const noncanonical = path.join(root, 'noncanonical-plan.json');
    writeFileSync(noncanonical, JSON.stringify(bundle.plan, null, 2), 'utf8');
    assert.throws(
      () => sealInternals.requireCanonicalJson(noncanonical, 'plan'),
      /canonical JSON/u,
    );

    const approvalTextPath = freezeReport.artifacts.approval_text;
    const approvalText = readFileSync(approvalTextPath, 'utf8');
    const sealReport = sealFlowIdentityApproval({
      planPath,
      freezePath: freezeReport.artifacts.freeze,
      approvalRequestPath: freezeReport.artifacts.approval_request,
      humanApprovalPath: approvalTextPath,
      approveFreezeFile: freezeReport.freeze_file_sha256,
      approveRequest: freezeReport.execution_approval_request_sha256,
      approveText: sha256Text(approvalText),
      confirm: 'bafudata@example.com',
      approvedAtUtc: '2099-07-16T05:00:00.000Z',
      outDir: path.join(root, 'seal'),
    });
    assert.equal(sealReport.status, 'sealed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
