import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HISTORICAL_FLOW_IDENTITY_AUTHORITY_SHA256,
  assertCurrentFlowIdentityAuthority,
  computeFlowIdentityCaptureEvidenceSha256,
  computeFlowIdentityCaptureSha256,
  computeFlowIdentityPlanSha256,
  computeFlowIdentityProcessTemplateSha256,
  computeFlowIdentityReviewLedgerSha256,
  extractFlowIdentityReference,
  parseFlowIdentityCapture,
  parseFlowIdentityPlan,
  parseFlowIdentityPolicy,
  parseFlowIdentityReference,
  parseFlowIdentityReviewLedger,
  __testInternals as contractInternals,
  type FlowIdentityCompatibilityPolicy,
  type FlowIdentityLiveCapture,
  type FlowIdentityReference,
  type FlowIdentityReviewEntry,
  type FlowIdentityReviewLedger,
} from '../src/lib/dataset-maintenance-flow-identity-contract.js';
import {
  __testInternals as planInternals,
  buildFlowIdentityCaptureRequest,
  buildFlowIdentityPlan,
  buildFlowIdentitySemantics,
  runFlowIdentityPlan,
} from '../src/lib/dataset-maintenance-flow-identity-plan.js';
import {
  __testInternals as runInternals,
  runFlowIdentity,
} from '../src/lib/dataset-maintenance-flow-identity-run.js';
import {
  __testInternals as verifyInternals,
  verifyFlowIdentityReadback,
} from '../src/lib/dataset-maintenance-flow-identity-verify.js';
import {
  materializePrivateArtifactDirectoryAtomically,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from '../src/lib/dataset-maintenance-protected-artifacts.js';
import {
  computeFlowIdentityApprovalRequestSha256,
  freezeFlowIdentity,
  parseFlowIdentityApprovalRequest,
  type FlowIdentityApprovalRequest,
} from '../src/lib/dataset-maintenance-flow-identity-freeze.js';
import { sealFlowIdentityApproval } from '../src/lib/dataset-maintenance-flow-identity-seal.js';
import {
  __testInternals as recoveryInternals,
  assertFreshRecoveryBaseline,
  computeFlowIdentityRecoveryApprovalIdentitySha256,
  computeFlowIdentityRecoveryApprovalRequestSha256,
  computeFlowIdentityRecoveryFreezeSha256,
  freezeFlowIdentityRecovery,
  parseFlowIdentityRecoveryApproval,
  parseFlowIdentityRecoveryApprovalRequest,
  parseFlowIdentityRecoveryFreeze,
  prepareFlowIdentityRecoveryExecution,
  renderFlowIdentityRecoveryApprovalText,
  sealFlowIdentityRecoveryApproval,
  type FlowIdentityRecoveryApproval,
  type FlowIdentityRecoveryFreeze,
} from '../src/lib/dataset-maintenance-flow-identity-recovery.js';
import {
  buildFlowIdentityExecutionIdentity,
  buildFlowIdentityFinalizeRequest,
  buildFlowIdentityProcessRequest,
  buildFlowIdentityScopePreflightRequest,
  computeFlowIdentityApprovalIdentitySha256,
  computeFlowIdentityFreezeSha256,
  computeFlowIdentityProcessRequestSha256,
  flowIdentityScopeIsReadyToFinalize,
  parseFlowIdentityApproval,
  parseFlowIdentityFinalizeProof,
  parseFlowIdentityFreeze,
  parseFlowIdentityProcessProof,
  parseFlowIdentityScopePreflightProof,
  parseFlowIdentityScopeStatus,
  prepareFlowIdentityExecution,
  __testInternals as executionInternals,
  type FlowIdentityApproval,
  type FlowIdentityFreeze,
  type FlowIdentityScopeStatus,
} from '../src/lib/dataset-maintenance-flow-identity-execution-contract.js';
import { flowIdentityRestrictedSha256 } from '../src/lib/dataset-maintenance-flow-identity-wire.js';
import { claimFlowIdentityApproval } from '../src/lib/dataset-maintenance-flow-identity-approval-claim.js';
import {
  __testInternals as commandInternals,
  runFlowIdentityPlanFromFiles,
} from '../src/lib/dataset-maintenance-flow-identity-command.js';
import { __testInternals as captureInternals } from '../src/lib/dataset-maintenance-flow-identity-capture.js';
import { __testInternals as sealInternals } from '../src/lib/dataset-maintenance-flow-identity-seal.js';
import {
  sha256Json,
  sha256Text,
  snapshotRemoteRow,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import type { FlowPayloadValidationResult } from '../src/lib/flow-payload-validation.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';
import type { FetchLike } from '../src/lib/http.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const PUBLIC_OWNER = '22222222-2222-4222-8222-222222222222';
const VERSION = '01.00.000';
const PUBLIC_VERSION = '03.00.004';
const FP_ID = '33333333-3333-4333-8333-333333333333';
const FP_VERSION = '03.00.003';
const UG_ID = '44444444-4444-4444-8444-444444444444';
const UG_VERSION = '03.00.003';
const PROCESS_ID = '55555555-5555-4555-8555-555555555555';
const MODIFIED = '2026-07-16T04:00:00+00:00';
const HASH = (value: string): string => sha256Json(value);
const APPROVAL_TEXT = 'APPROVE CURRENT BAFU STEP3 COMPATIBILITY POLICY';
const PROCESS_INTENT_PROOF = HASH('db-process-intent-proof');

function toolchainEvidence(projectRef: string) {
  return {
    schema_version: 'dataset-alias-protected-toolchain-evidence.v1',
    environment: 'production',
    project_ref: projectRef,
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

function sourceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

const TARGET_ID = '66666666-6666-4666-8666-666666666666';

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
          classificationInformation: {
            'common:elementaryFlowCategorization': {
              'common:category': [
                { '@level': '0', '#text': 'Emissions' },
                { '@level': '1', '#text': 'Emissions to air' },
              ],
            },
          },
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

function exchange(index: number, flowReference: FlowIdentityReference, amount: string): JsonObject {
  return {
    '@dataSetInternalID': String(index + 1),
    exchangeDirection: 'Output',
    meanAmount: amount,
    resultingAmount: amount,
    referenceToFlowDataSet: flowReference,
    generalComment: { '#text': `keep-${index}`, '@xml:lang': 'en' },
    uncertaintyDistributionType: 'undefined',
  };
}

function processPayload(): JsonObject {
  const mappedSourceReference = reference(sourceId(0), VERSION, 'source-0') as JsonObject;
  mappedSourceReference['common:subReference'] = 'must-survive-five-field-patch';
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': PROCESS_ID } },
      exchanges: {
        exchange: [
          exchange(0, mappedSourceReference as FlowIdentityReference, '1.250'),
          exchange(1, reference(TARGET_ID, PUBLIC_VERSION, 'public-target'), '2.500'),
          exchange(2, reference(sourceId(1), VERSION, 'pending-source'), '-3.750'),
        ],
      },
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
  modelId?: string | null;
  ruleVerification?: boolean | null;
}): DatasetMaintenanceRowSnapshot {
  return snapshotRemoteRow({
    table: options.table,
    id: options.id,
    version: options.version,
    user_id: options.userId,
    state_code: options.stateCode,
    modified_at: MODIFIED,
    json_ordered: options.payload,
    model_id: options.modelId ?? null,
    rule_verification: options.ruleVerification ?? null,
  });
}

function policy(evidenceResolutionSha256: string): FlowIdentityCompatibilityPolicy {
  return {
    schema_version: 'dataset-flow-identity-compatibility-policy.v1',
    policy_sha256: HASH('new-policy-v3'),
    evidence_resolution_sha256: evidenceResolutionSha256,
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
    source_trace_sha256: HASH(`source-trace-${index}`),
    compartment_evidence_sha256: HASH(`compartment-${index}`),
    decision_evidence_sha256: HASH(`decision-${index}`),
  };
}

function reviewLedger(): FlowIdentityReviewLedger {
  const ledger: FlowIdentityReviewLedger = {
    schema_version: 'dataset-flow-identity-review-ledger.v3',
    generated_at_utc: '2026-07-16T03:30:00.000Z',
    source_count: 305,
    review_evidence_sha256: HASH('new-evidence-resolution-v3'),
    execution_authority: false,
    entries: Array.from({ length: 305 }, (_, index) => reviewEntry(index)),
    ledger_sha256: '',
  };
  ledger.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(ledger);
  return ledger;
}

function bindCaptureReceiptSemantics(
  capture: FlowIdentityLiveCapture,
  review: FlowIdentityReviewLedger,
): FlowIdentityLiveCapture {
  capture.artifact_evidence.review_ledger_sha256 = review.ledger_sha256;
  capture.artifact_evidence.live_capture_artifact_sha256 =
    computeFlowIdentityCaptureEvidenceSha256(capture);
  const capturePolicy = policy(review.review_evidence_sha256);
  const semantics = buildFlowIdentitySemantics({
    policy: capturePolicy,
    review,
    capture,
    validation: { validateFlow: flowLegacyWarning, validateProcess: processPass },
  });
  capture.capture_request = buildFlowIdentityCaptureRequest({
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: capture.attestation.operation_id,
    policy: capturePolicy,
    capture,
    mappings: semantics.mappings,
    processTemplates: semantics.processTemplates,
    protectedClosure: semantics.protectedClosure,
  });
  capture.attestation.capture_request_sha256 = flowIdentityRestrictedSha256(
    capture.capture_request as unknown as JsonObject,
  );
  capture.attestation.policy_sha256 = capturePolicy.policy_sha256;
  capture.attestation.policy_approval_text_sha256 = capturePolicy.approval_text_sha256;
  capture.attestation.mapping_count = semantics.mappings.length;
  capture.attestation.process_count = semantics.processTemplates.length;
  capture.attestation.rewrite_count = semantics.processTemplates.reduce(
    (sum, template) => sum + template.process.rewrite_count,
    0,
  );
  capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(capture);
  return capture;
}

function liveCapture(review = reviewLedger()): FlowIdentityLiveCapture {
  const processRow = snapshot({
    table: 'processes',
    id: PROCESS_ID,
    version: VERSION,
    userId: ACTOR,
    stateCode: 0,
    payload: processPayload(),
    modelId: '77777777-7777-4777-8777-777777777777',
    ruleVerification: false,
  });
  const capture: FlowIdentityLiveCapture = {
    schema_version: 'dataset-flow-identity-live-capture.v2',
    captured_at_utc: '2026-07-16T04:10:00.000Z',
    environment: 'local',
    project_ref: 'test-project',
    account: { user_id: ACTOR, email: 'bafudata@example.com' },
    prerequisites: {
      step2_readback_sha256: HASH('step2-readback'),
      step2_completed_at_utc: '2026-07-16T02:00:00.000Z',
      issue29_target1_readback_sha256: HASH('issue29-target1-readback'),
      issue29_target1_completed_at_utc: '2026-07-16T03:00:00.000Z',
      issue29_target2_readback_sha256: HASH('issue29-target2-readback'),
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
        row_identity_set_sha256: HASH('process-scan-identities'),
        row_snapshot_set_sha256: HASH('process-scan-snapshots'),
      },
    },
    source_rows: Array.from({ length: 305 }, (_, index) =>
      snapshot({
        table: 'flows',
        id: sourceId(index),
        version: VERSION,
        userId: ACTOR,
        stateCode: 0,
        payload: flowPayload(sourceId(index), VERSION),
      }),
    ),
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
    process_rows: [processRow],
    capture_request: {} as never,
    attestation: {
      ok: true,
      command: 'cmd_dataset_flow_identity_capture_attest_guarded',
      schema_version: 'dataset-flow-identity-capture-attest-result.v2',
      proof_domain: 'dataset-flow-identity-db-proof.v2',
      receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      receipt_proof_sha256: HASH('receipt-proof'),
      operation_id: 'flow-identity-v2-test-operation',
      environment: 'local',
      project_ref: 'test-project',
      captured_at: '2026-07-16T04:11:00.000Z',
      expires_at: '2026-07-23T04:11:00.000Z',
      source_guard_set_sha256: HASH('source-guard-set'),
      support_guard_set_sha256: HASH('support-guard-set'),
      target_guard_set_sha256: HASH('target-guard-set'),
      mapping_guard_set_sha256: HASH('mapping-guard-set'),
      process_intent_set_sha256: HASH('process-intent-set'),
      protected_closure_sha256: HASH('receipt-protected-closure'),
      whole_scope_proof_sha256: HASH('capture-whole-scope-proof'),
      policy_sha256: HASH('new-policy-v3'),
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
  return bindCaptureReceiptSemantics(capture, review);
}

const flowLegacyWarning = (): FlowPayloadValidationResult => ({
  ok: false,
  validator: 'test-flow-schema',
  issue_count: 1,
  issues: [{ path: 'legacy.path', message: 'legacy public row', code: 'legacy' }],
});

const processPass = (): ProcessPayloadValidationResult => ({
  ok: true,
  validator: 'test-process-schema',
  issue_count: 0,
  issues: [],
});

function scenario() {
  const review = reviewLedger();
  const capture = liveCapture(review);
  return {
    policy: policy(review.review_evidence_sha256),
    review,
    capture,
    validation: { validateFlow: flowLegacyWarning, validateProcess: processPass },
  };
}

function executionScenario() {
  const input = scenario();
  input.capture.environment = 'production';
  input.capture.project_ref = 'production-project';
  input.capture.attestation.environment = 'production';
  input.capture.attestation.project_ref = 'production-project';
  bindCaptureReceiptSemantics(input.capture, input.review);
  const bundle = buildFlowIdentityPlan({
    policy: input.policy,
    reviewLedger: input.review,
    liveCapture: input.capture,
    now: new Date('2026-07-16T04:20:00.000Z'),
    validation: input.validation,
  });
  const freeze: FlowIdentityFreeze = {
    schema_version: 'dataset-flow-identity-freeze.v2',
    generated_at_utc: '2026-07-16T04:30:00.000Z',
    environment: 'production',
    project_ref: bundle.plan.project_ref,
    actor: bundle.plan.account,
    plan_sha256: bundle.plan.plan_sha256,
    operation_id: bundle.plan.operation_id,
    capture_artifact_sha256: bundle.plan.capture_artifact_sha256,
    receipt_id: bundle.plan.receipt_id,
    receipt_proof_sha256: bundle.plan.receipt_proof_sha256,
    capture_request_sha256: bundle.plan.capture_request_sha256,
    source_guard_set_sha256: bundle.plan.source_guard_set_sha256,
    support_guard_set_sha256: bundle.plan.support_guard_set_sha256,
    target_guard_set_sha256: bundle.plan.target_guard_set_sha256,
    mapping_guard_set_sha256: bundle.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: bundle.plan.process_intent_set_sha256,
    receipt_protected_closure_sha256: bundle.plan.receipt_protected_closure_sha256,
    capture_whole_scope_proof_sha256: bundle.plan.capture_whole_scope_proof_sha256,
    source_universe_artifact_sha256: bundle.plan.source_universe_artifact_sha256,
    support_snapshot_artifact_sha256: bundle.plan.support_snapshot_artifact_sha256,
    mapping_artifact_sha256: bundle.plan.mapping_artifact_sha256,
    process_manifest_artifact_sha256: bundle.plan.process_manifest_artifact_sha256,
    protected_closure_artifact_sha256: bundle.plan.protected_closure_artifact_sha256,
    policy_approval_text_sha256: bundle.plan.compatibility_policy.approval_text_sha256,
    toolchain_evidence_sha256: HASH('toolchain'),
    freeze_sha256: '',
  };
  freeze.freeze_sha256 = computeFlowIdentityFreezeSha256(freeze);
  const approval: FlowIdentityApproval = {
    schema_version: 'dataset-flow-identity-execution-approval.v2',
    approved_at_utc: '2026-07-16T04:40:00.000Z',
    actor: bundle.plan.account,
    plan_sha256: bundle.plan.plan_sha256,
    freeze_sha256: freeze.freeze_sha256,
    toolchain_evidence_sha256: freeze.toolchain_evidence_sha256,
    policy_approval_text_sha256: bundle.plan.compatibility_policy.approval_text_sha256,
    execution_approval_request_sha256: HASH('execution-approval-request'),
    execution_approval_text_sha256: HASH('execution-approval-text'),
    execution_approval_identity_sha256: '',
  };
  approval.execution_approval_identity_sha256 = computeFlowIdentityApprovalIdentitySha256(approval);
  return { ...bundle, capture: input.capture, freeze, approval };
}

function materializeExecutionScenario(root: string) {
  const input = executionScenario();
  const planPath = path.join(root, input.plan.artifacts.plan);
  const freezePath = path.join(root, 'flow-identity-freeze.json');
  const approvalPath = path.join(root, 'flow-identity-approval.json');
  writePrivateImmutableJson(planPath, input.plan);
  writePrivateImmutableJson(path.join(root, input.plan.artifacts.live_capture), input.capture);
  writePrivateImmutableJson(freezePath, input.freeze);
  writePrivateImmutableJson(approvalPath, input.approval);
  for (const template of input.process_templates) {
    const stem = runInternals.processStem(
      template.process.ordinal,
      template.process.id,
      template.process.version,
    );
    writePrivateImmutableJson(
      path.join(root, input.plan.artifacts.desired_payload_dir, `${stem}.json`),
      template.desired_payload,
    );
    writePrivateImmutableJson(
      path.join(root, input.plan.artifacts.process_request_dir, `${stem}.json`),
      {
        process: template.process,
        rewrites: template.rewrites,
        collision_ledger: template.collision_ledger,
      },
    );
  }
  return { ...input, planPath, freezePath, approvalPath };
}

function scopePreflightRaw(input: ReturnType<typeof executionScenario>) {
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_preflight_guarded',
    schema_version: 'dataset-flow-identity-scope-preflight-result.v2',
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    scope_id: '88888888-8888-4888-8888-888888888888',
    operation_id: input.plan.operation_id,
    plan_sha256: input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: 'sealed',
    process_count: input.plan.processes.length,
    mapping_count: input.plan.mappings.length,
    mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: input.plan.process_intent_set_sha256,
    support_snapshot_count: input.plan.support_snapshots.length,
    source_universe_count: 305,
    rewrite_count: input.plan.summary.rewrites,
    next_ordinal: 1,
    audit_id: 'scope-audit-1',
    replay: false,
  };
}

const WRAPPER_INVOCATION_ID = '77777777-7777-4777-8777-777777777777';

function executionPermit(generation: number) {
  return {
    schema_version: 'dataset-flow-identity-execution-permit.v1',
    invocation_id: WRAPPER_INVOCATION_ID,
    generation,
    token: HASH(`permit-${generation}`),
  };
}

function scopePreflightEnvelope(input: ReturnType<typeof executionScenario>) {
  return { ...scopePreflightRaw(input), execution_permit: executionPermit(0) };
}

function scopeLookupRaw(input: ReturnType<typeof executionScenario>) {
  const preflight = scopePreflightRaw(input);
  const status = scopeStatusRaw({ input, phase: 'pending' });
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_lookup',
    schema_version: 'dataset-flow-identity-scope-lookup-result.v1',
    read_only: true,
    scope_id: preflight.scope_id,
    receipt_id: preflight.receipt_id,
    receipt_proof_sha256: preflight.receipt_proof_sha256,
    mapping_guard_set_sha256: preflight.mapping_guard_set_sha256,
    process_intent_set_sha256: preflight.process_intent_set_sha256,
    operation_id: preflight.operation_id,
    plan_sha256: preflight.plan_sha256,
    scope_proof_sha256: preflight.scope_proof_sha256,
    status: 'sealed',
    process_count: preflight.process_count,
    mapping_count: preflight.mapping_count,
    support_snapshot_count: preflight.support_snapshot_count,
    source_universe_count: 305,
    rewrite_count: preflight.rewrite_count,
    next_ordinal: 1,
    audit_id: preflight.audit_id,
    whole_scope_proof_sha256: status.whole_scope_proof_sha256,
    execution_permit: null,
  };
}

function processEnvelope(value: JsonObject, generation = 1) {
  return { ...value, execution_permit: executionPermit(generation) };
}

function finalizeEnvelope(value: JsonObject, generation: number | null) {
  return {
    ...value,
    execution_permit: generation === null ? null : executionPermit(generation),
  };
}

function scopeStatusRaw(options: {
  input: ReturnType<typeof executionScenario>;
  phase: 'pending' | 'primary' | 'completed';
  processRequestSha256?: string;
}) {
  const process = options.input.plan.processes[0]!;
  const completed = options.phase !== 'pending';
  const terminal = options.phase === 'completed';
  const derivativeTarget = completed
    ? {
        ordinal: 1,
        id: process.id,
        version: process.version,
        original_batch_id: '99999999-9999-4999-8999-999999999999',
        effective_reference_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        effective_reference_kind: 'protected_batch',
        status: terminal ? 'completed' : 'pending',
        request_status: terminal ? 'completed' : 'embedding_pending',
        phase: terminal ? 'completed' : 'embedding_queued',
        lineage_ok: true,
        proposals_committed: terminal,
        terminal_audit_present: terminal,
        residue: {
          http_requests: 0,
          embedding_jobs: 0,
          pending_jobs: terminal ? 0 : 1,
          failure_rows: 0,
          other_active_fences: 0,
        },
        current_snapshot_sha256: HASH(
          terminal ? 'terminal-derivative-snapshot' : 'pending-derivative-snapshot',
        ),
        current_json_ordered_sha256: process.desired_payload_sha256,
        causal_terminal_proof: terminal,
      }
    : null;
  const derivativeSetProof = {
    ok: completed,
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: '88888888-8888-4888-8888-888888888888',
    status: terminal ? 'completed' : completed ? 'pending' : 'failed',
    target_count: completed ? 1 : 0,
    completed_count: terminal ? 1 : 0,
    pending_count: completed && !terminal ? 1 : 0,
    failed_count: 0,
    causal_terminal_proof: terminal,
    targets: derivativeTarget ? [derivativeTarget] : [],
    compensation_targets: [],
    proof_sha256: HASH(terminal ? 'terminal-derivative-set' : 'nonterminal-derivative-set'),
  };
  const wholeScopeProof = {
    schema_version: 'dataset-flow-identity-whole-scope-proof.v2',
    scope_id: '88888888-8888-4888-8888-888888888888',
    receipt_id: options.input.plan.receipt_id,
    primary_current: true,
    audit_current: true,
    source_guards_current: true,
    support_guards_current: true,
    target_guards_current: true,
    approved_reference_residue_count: 0,
    protected_closure_current: true,
    occurrence_closure_current: true,
    derivatives_current: terminal,
    primary_closure_sha256: HASH('db-primary-closure'),
    source_guard_set_sha256: HASH('db-source-guard-set'),
    support_guard_set_sha256: HASH('db-support-guard-set'),
    target_guard_set_sha256: HASH('db-target-guard-set'),
    protected_closure_sha256: HASH('db-protected-closure'),
    derivative_proof_set_sha256: derivativeSetProof.proof_sha256,
    causal_terminal_proof: terminal,
    proof_sha256: HASH(terminal ? 'whole-scope-terminal' : 'whole-scope-pending'),
  };
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_read',
    schema_version: 'dataset-flow-identity-scope-status.v2',
    scope_id: '88888888-8888-4888-8888-888888888888',
    receipt_id: options.input.plan.receipt_id,
    receipt_proof_sha256: options.input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: options.input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: options.input.plan.process_intent_set_sha256,
    operation_id: options.input.plan.operation_id,
    plan_sha256: options.input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: terminal ? 'completed' : completed ? 'derivatives_pending' : 'sealed',
    process_count: 1,
    completed_process_count: completed ? 1 : 0,
    pending_process_count: completed ? 0 : 1,
    failed_process_count: 0,
    next_ordinal: completed ? 2 : 1,
    rewrite_count: 1,
    completed_rewrite_count: completed ? 1 : 0,
    primary_complete: completed,
    primary_current: true,
    live_guard_current: true,
    derivatives_current: terminal,
    derivative_pending_count: completed && !terminal ? 1 : 0,
    derivative_failed_count: 0,
    derivative_set_proof: derivativeSetProof,
    derivative_proof_set_sha256: derivativeSetProof.proof_sha256,
    compensation_required: false,
    compensation_targets: [],
    protected_closure_current: true,
    automatic_retry: false,
    whole_scope_proof: wholeScopeProof,
    whole_scope_proof_sha256: wholeScopeProof.proof_sha256,
    protected_closure_proof: { ok: true },
    terminal_proof_sha256: terminal ? HASH('terminal-proof') : null,
    completed_at: terminal ? '2026-07-16T05:00:00.000Z' : null,
    cancellable: !completed,
    strict_continuation_required: false,
    processes: [
      {
        ordinal: 1,
        id: process.id,
        version: process.version,
        status: completed ? 'completed' : 'pending',
        process_request_sha256: completed ? options.processRequestSha256 : null,
        process_intent_proof_sha256: PROCESS_INTENT_PROOF,
        desired_payload_sha256: process.desired_payload_sha256,
        desired_exchange_set_sha256: process.desired_exchange_set_sha256,
        rewrite_count: 1,
        audit_id: completed ? 'audit-1' : null,
        before_payload_sha256: process.before_payload_sha256,
        before_exchange_set_sha256: process.before_exchange_set_sha256,
        after_payload_sha256: completed ? process.desired_payload_sha256 : null,
        after_exchange_set_sha256: completed ? process.desired_exchange_set_sha256 : null,
        derivative_batch_id: completed ? '99999999-9999-4999-8999-999999999999' : null,
        derivative_request_id: completed ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
        derivative_status: terminal ? 'completed' : completed ? 'embedding_pending' : null,
        causal_terminal_proof: false,
        completed_at: completed ? '2026-07-16T04:50:00.000Z' : null,
        last_error: null,
      },
    ],
  };
}

function readyToFinalizeScopeStatusRaw(options: {
  input: ReturnType<typeof executionScenario>;
  processRequestSha256: string;
}) {
  const completed = scopeStatusRaw({
    input: options.input,
    phase: 'completed',
    processRequestSha256: options.processRequestSha256,
  });
  return {
    ...completed,
    status: 'primary_complete',
    terminal_proof_sha256: null,
    completed_at: null,
  };
}

function completedFinalizeRaw(options: {
  input: ReturnType<typeof executionScenario>;
  expected: JsonObject;
  replay?: boolean;
  permitGenerationBefore?: number;
}) {
  const completed = scopeStatusRaw({
    input: options.input,
    phase: 'completed',
    processRequestSha256: HASH('finalize-process-request'),
  });
  const whole = completed.whole_scope_proof;
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
    schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
    scope_id: completed.scope_id,
    receipt_id: options.input.plan.receipt_id,
    receipt_proof_sha256: options.input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: options.input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: options.input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: options.permitGenerationBefore ?? 0,
    operation_id: options.input.plan.operation_id,
    plan_sha256: options.input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: 'completed',
    process_count: options.expected.process_count,
    completed_process_count: options.expected.completed_process_count,
    rewrite_count: options.expected.rewrite_count,
    primary_closure_sha256: whole.primary_closure_sha256,
    protected_closure_sha256: whole.protected_closure_sha256,
    derivative_target_set_sha256: HASH('db-derivative-target-set'),
    derivative_proof_set_sha256: whole.derivative_proof_set_sha256,
    primary_current: true,
    live_guard_current: true,
    derivatives_current: true,
    terminal_proof_sha256: HASH('terminal-proof'),
    whole_scope_proof: whole,
    whole_scope_proof_sha256: whole.proof_sha256,
    audit_id: 'finalize-audit-1',
    replay: options.replay ?? false,
  };
}

function materializeRecoveryExecutionScenario(root: string) {
  const input = materializeExecutionScenario(path.join(root, 'input'));
  const identity = buildFlowIdentityExecutionIdentity({
    plan: input.plan,
    freeze: input.freeze,
    approval: input.approval,
  });
  const scope = scopeLookupRaw(input);
  const recoveryRunDir = path.join(root, 'prior-run');
  writePrivateImmutableJson(path.join(recoveryRunDir, 'scope-lookup-proof.json'), scope);
  const baselineStatus = scopeStatusRaw({ input, phase: 'pending' });
  const recoveryFreeze: FlowIdentityRecoveryFreeze = {
    schema_version: 'dataset-flow-identity-recovery-freeze.v1',
    generated_at_utc: '2026-07-16T05:10:00.000Z',
    environment: 'production',
    project_ref: input.plan.project_ref,
    actor: input.plan.account,
    target_visibility: 'owner_draft',
    user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
    scope_id: String(scope.scope_id),
    scope_proof_sha256: String(scope.scope_proof_sha256),
    operation_id: input.plan.operation_id,
    plan_sha256: input.plan.plan_sha256,
    original_freeze_sha256: input.freeze.freeze_sha256,
    original_execution_request_id: identity.request_id,
    original_execution_identity_sha256: identity.identity_sha256,
    original_execution_approval_request_sha256: input.approval.execution_approval_request_sha256,
    original_execution_approval_text_sha256: input.approval.execution_approval_text_sha256,
    original_execution_approval_identity_sha256: input.approval.execution_approval_identity_sha256,
    recovery_reason: 'wrapper_exited_without_permit',
    recovery_mode: 'resume_and_finalize',
    baseline: {
      status: baselineStatus.status as FlowIdentityRecoveryFreeze['baseline']['status'],
      completed_process_count: baselineStatus.completed_process_count,
      next_ordinal: baselineStatus.next_ordinal,
      primary_complete: baselineStatus.primary_complete,
      primary_current: baselineStatus.primary_current,
      live_guard_current: baselineStatus.live_guard_current,
      protected_closure_current: baselineStatus.protected_closure_current,
      derivatives_current: baselineStatus.derivatives_current,
      whole_scope_proof_sha256: baselineStatus.whole_scope_proof_sha256,
    },
    toolchain_evidence_sha256: HASH('recovery-toolchain'),
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: 1,
    maximum_finalize_posts: 1,
    automatic_retry: false,
    recovery_freeze_sha256: '',
  };
  recoveryFreeze.recovery_freeze_sha256 = computeFlowIdentityRecoveryFreezeSha256(recoveryFreeze);
  const recoveryApproval: FlowIdentityRecoveryApproval = {
    schema_version: 'dataset-flow-identity-recovery-approval.v1',
    approved_at_utc: '2026-07-16T05:20:00.000Z',
    actor: input.plan.account,
    plan_sha256: input.plan.plan_sha256,
    scope_id: recoveryFreeze.scope_id,
    scope_proof_sha256: recoveryFreeze.scope_proof_sha256,
    recovery_freeze_sha256: recoveryFreeze.recovery_freeze_sha256,
    toolchain_evidence_sha256: recoveryFreeze.toolchain_evidence_sha256,
    recovery_approval_request_sha256: HASH('recovery-approval-request'),
    recovery_approval_text_sha256: HASH('recovery-approval-text'),
    recovery_approval_identity_sha256: '',
  };
  recoveryApproval.recovery_approval_identity_sha256 =
    computeFlowIdentityRecoveryApprovalIdentitySha256(recoveryApproval);
  const recoveryFreezePath = path.join(root, 'recovery-freeze.json');
  const recoveryApprovalPath = path.join(root, 'recovery-approval.json');
  writePrivateImmutableJson(recoveryFreezePath, recoveryFreeze);
  writePrivateImmutableJson(recoveryApprovalPath, recoveryApproval);
  return {
    ...input,
    identity,
    scope,
    baselineStatus,
    recoveryRunDir,
    recoveryFreeze,
    recoveryApproval,
    recoveryFreezePath,
    recoveryApprovalPath,
  };
}

function recoveryEnvelope(options: {
  input: ReturnType<typeof materializeRecoveryExecutionScenario>;
  request: JsonObject;
  replay?: boolean;
}) {
  const replay = options.replay ?? false;
  const freeze = options.input.recoveryFreeze;
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_recover_guarded',
    schema_version: 'dataset-flow-identity-scope-recovery-result.v1',
    scope_id: freeze.scope_id,
    scope_proof_sha256: freeze.scope_proof_sha256,
    status: freeze.baseline.status,
    completed_process_count: freeze.baseline.completed_process_count,
    next_ordinal: freeze.baseline.next_ordinal,
    whole_scope_proof_sha256: freeze.baseline.whole_scope_proof_sha256,
    recovery_wire_request_sha256: flowIdentityRestrictedSha256(options.request),
    recovery_approval_identity_sha256:
      options.input.recoveryApproval.recovery_approval_identity_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    audit_id: replay ? 'recovery-replay-audit-1' : 'recovery-audit-1',
    replay,
    execution_permit: replay ? null : executionPermit(0),
  };
}

function completedProcessRewriteEnvelope(options: {
  input: ReturnType<typeof executionScenario>;
  processRequestSha256: string;
}) {
  const process = options.input.plan.processes[0]!;
  return processEnvelope({
    ok: true,
    command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
    schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
    scope_id: scopePreflightRaw(options.input).scope_id,
    receipt_id: options.input.plan.receipt_id,
    receipt_proof_sha256: options.input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: options.input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: options.input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    ordinal: 1,
    process_id: process.id,
    process_version: process.version,
    process_request_sha256: options.processRequestSha256,
    process_intent_proof_sha256: PROCESS_INTENT_PROOF,
    desired_payload_sha256: process.desired_payload_sha256,
    desired_exchange_set_sha256: process.desired_exchange_set_sha256,
    completed_process_count: 1,
    next_ordinal: null,
    primary_complete: true,
    before_payload_sha256: process.before_payload_sha256,
    before_exchange_set_sha256: process.before_exchange_set_sha256,
    after_payload_sha256: process.desired_payload_sha256,
    after_exchange_set_sha256: process.desired_exchange_set_sha256,
    rewrite_count: 1,
    audit_id: 'recovery-process-audit-1',
    derivative_batch_id: '99999999-9999-4999-8999-999999999999',
    status: 'completed',
    replay: false,
  });
}

function pendingFinalizeRaw(options: {
  input: ReturnType<typeof executionScenario>;
  expected: JsonObject;
}) {
  const pending = scopeStatusRaw({
    input: options.input,
    phase: 'primary',
    processRequestSha256: HASH('finalize-process-request'),
  });
  const whole = pending.whole_scope_proof;
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
    schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
    scope_id: pending.scope_id,
    receipt_id: options.input.plan.receipt_id,
    receipt_proof_sha256: options.input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: options.input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: options.input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    operation_id: options.input.plan.operation_id,
    plan_sha256: options.input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: 'derivatives_pending',
    code: 'FLOW_IDENTITY_DERIVATIVES_PENDING',
    process_count: options.expected.process_count,
    completed_process_count: options.expected.completed_process_count,
    rewrite_count: options.expected.rewrite_count,
    primary_closure_sha256: whole.primary_closure_sha256,
    protected_closure_sha256: whole.protected_closure_sha256,
    derivative_target_set_sha256: HASH('db-derivative-target-set'),
    derivative_proof_set_sha256: whole.derivative_proof_set_sha256,
    primary_current: true,
    live_guard_current: true,
    derivatives_current: false,
    terminal_proof_sha256: null,
    whole_scope_proof: whole,
    whole_scope_proof_sha256: whole.proof_sha256,
    audit_id: null,
    replay: false,
    compensation_required: false,
    automatic_retry: false,
    compensation_targets: [],
  };
}

function missingOriginalDerivativeScopeRaw(options: {
  input: ReturnType<typeof executionScenario>;
  processRequestSha256: string;
}) {
  const base = scopeStatusRaw({
    input: options.input,
    phase: 'primary',
    processRequestSha256: options.processRequestSha256,
  });
  const reason = `FLOW_IDENTITY_SCOPE_COMPENSATION:${base.scope_id}:1`;
  const compensationTarget = {
    ordinal: 1,
    table: 'processes',
    id: PROCESS_ID,
    version: VERSION,
    original_batch_id: '99999999-9999-4999-8999-999999999999',
    original_request_id: null,
    original_status: 'missing',
    original_error: null,
    original_code: 'DERIVATIVE_BATCH_CHILD_MISSING',
    desired_payload_sha256: options.input.plan.processes[0]!.desired_payload_sha256,
    current_json_ordered_sha256: options.input.plan.processes[0]!.desired_payload_sha256,
    current_snapshot_sha256: HASH('missing-child-current-snapshot'),
    current_modified_at: '2026-07-16T05:30:00.000Z',
    components: ['extracted_md', 'embedding_ft'],
    reason_code: reason,
    operation_id_prefix: `${reason}:`,
    latest_compensation_request_id: null,
    latest_compensation_status: null,
    latest_compensation_plan_sha256: null,
    requires_new_plan_freeze_approval: true,
    automatic_retry: false,
  };
  const derivativeCompensationTarget = Object.fromEntries(
    Object.entries(compensationTarget).filter(
      ([key]) => key !== 'original_request_id' && key !== 'original_error',
    ),
  );
  const derivativeSetProof = {
    ok: false,
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: base.scope_id,
    status: 'compensation_required',
    target_count: 1,
    completed_count: 0,
    pending_count: 0,
    failed_count: 1,
    causal_terminal_proof: false,
    targets: [
      {
        ordinal: 1,
        id: PROCESS_ID,
        version: VERSION,
        original_batch_id: '99999999-9999-4999-8999-999999999999',
        effective_reference_id: null,
        effective_reference_kind: 'protected_batch',
        status: 'failed',
        request_status: 'missing',
        phase: 'missing',
        lineage_ok: false,
        proposals_committed: false,
        terminal_audit_present: false,
        residue: {
          http_requests: 0,
          embedding_jobs: 0,
          pending_jobs: 0,
          failure_rows: 0,
          other_active_fences: 0,
        },
        current_snapshot_sha256: compensationTarget.current_snapshot_sha256,
        current_json_ordered_sha256: compensationTarget.current_json_ordered_sha256,
        causal_terminal_proof: false,
      },
    ],
    compensation_targets: [derivativeCompensationTarget],
    proof_sha256: HASH('missing-child-derivative-set'),
  };
  const wholeScopeProof = {
    ...base.whole_scope_proof,
    derivative_proof_set_sha256: derivativeSetProof.proof_sha256,
    derivatives_current: false,
    causal_terminal_proof: false,
    proof_sha256: HASH('missing-child-whole-scope'),
  };
  return {
    ...base,
    ok: false,
    code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
    derivative_pending_count: 0,
    derivative_failed_count: 1,
    derivative_set_proof: derivativeSetProof,
    derivative_proof_set_sha256: derivativeSetProof.proof_sha256,
    compensation_required: true,
    compensation_targets: [compensationTarget],
    processes: base.processes.map((entry) => ({
      ...entry,
      derivative_request_id: null,
      derivative_status: 'missing',
      last_error: null,
    })),
    whole_scope_proof: wholeScopeProof,
    whole_scope_proof_sha256: wholeScopeProof.proof_sha256,
  };
}

function guardOnlyLiveDriftStatusRaw(options: {
  input: ReturnType<typeof executionScenario>;
  phase: 'pending' | 'primary';
  processRequestSha256?: string;
}) {
  const base = scopeStatusRaw(options);
  const whole = {
    ...base.whole_scope_proof,
    protected_closure_current: false,
    occurrence_closure_current: false,
    derivatives_current: false,
    causal_terminal_proof: false,
    proof_sha256: HASH(`guard-only-live-drift-${options.phase}`),
  };
  return {
    ...base,
    ok: false,
    status: 'live_drift',
    code: 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
    primary_current: true,
    live_guard_current: false,
    derivatives_current: false,
    protected_closure_current: false,
    protected_closure_proof: {
      ok: false,
      code: 'FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
    },
    compensation_required: false,
    compensation_targets: [],
    terminal_proof_sha256: null,
    completed_at: null,
    cancellable: false,
    whole_scope_proof: whole,
    whole_scope_proof_sha256: whole.proof_sha256,
  };
}

function remoteFromSnapshot(row: DatasetMaintenanceRowSnapshot): DatasetMaintenanceRemoteRow {
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

test('capture scans once, attests once, and persists only the reviewed process closure', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-capture-'));
  try {
    const input = scenario();
    const artifacts = path.join(root, 'inputs');
    const outDir = path.join(root, 'capture');
    writePrivateImmutableJson(path.join(artifacts, 'policy.json'), input.policy);
    writePrivateImmutableJson(path.join(artifacts, 'review.json'), input.review);
    writePrivateImmutableJson(path.join(artifacts, 'prerequisites.json'), {
      schema_version: 'dataset-flow-identity-prerequisites.v2',
      step2: {
        readback_sha256: HASH('step2-readback'),
        completed_at_utc: '2026-07-16T02:00:00.000Z',
        status: 'passed',
      },
      issue29_target1: {
        readback_sha256: HASH('issue29-target1-readback'),
        completed_at_utc: '2026-07-16T03:00:00.000Z',
        status: 'passed',
      },
      issue29_target2: {
        readback_sha256: HASH('issue29-target2-readback'),
        completed_at_utc: '2026-07-16T04:00:00.000Z',
        status: 'passed',
      },
    });
    writePrivateImmutableJson(
      path.join(artifacts, 'toolchain.json'),
      toolchainEvidence('production-project'),
    );
    const base = input.capture;
    const affected = remoteFromSnapshot(base.process_rows[0]!);
    const unaffected = Array.from({ length: 200 }, (_, index) => {
      const id = `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`;
      const payload = structuredClone(processPayload());
      const processRoot = payload.processDataSet as JsonObject;
      const information = processRoot.processInformation as JsonObject;
      const data = information.dataSetInformation as JsonObject;
      data['common:UUID'] = id;
      const exchangeRoot = processRoot.exchanges as JsonObject;
      const exchanges = exchangeRoot.exchange as JsonObject[];
      exchanges.splice(0, exchanges.length, exchange(0, reference(TARGET_ID, PUBLIC_VERSION), '1'));
      return remoteFromSnapshot(
        snapshot({
          table: 'processes',
          id,
          version: VERSION,
          userId: ACTOR,
          stateCode: 0,
          payload,
        }),
      );
    });
    const tableCompleteness = (count: number) => ({
      status: 'complete' as const,
      complete: true as const,
      strategy: 'postgrest_exact_count' as const,
      requested_page_size: 1000,
      effective_page_size: Math.min(1000, count),
      pages_fetched: 1,
      rows_fetched: count,
      exact_total: count,
      termination_reason: 'content_range_total_reached' as const,
      content_range_verified: true as const,
      ordering_verified: true as const,
      duplicate_count: 0 as const,
    });
    let flowScans = 0;
    let processScans = 0;
    let attestCalls = 0;
    const exactRows = new Map(
      [...base.target_rows, ...base.support_rows].map((row) => [
        `${row.table}\u0000${row.id}\u0000${row.version}`,
        remoteFromSnapshot(row),
      ]),
    );
    const report = await captureInternals.executeCapture(
      {
        policyPath: path.join(artifacts, 'policy.json'),
        reviewLedgerPath: path.join(artifacts, 'review.json'),
        prerequisitesPath: path.join(artifacts, 'prerequisites.json'),
        toolchainEvidencePath: path.join(artifacts, 'toolchain.json'),
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        operationId: 'flow-identity-v2-capture-test',
        expectedProjectRef: 'production-project',
        confirm: 'bafudata@example.com',
        cliVersion: '0.0.28',
        sdkVersion: '0.1.45',
        outDir,
        readConcurrency: 5,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
        now: new Date('2026-07-16T05:00:00.000Z'),
        validation: input.validation,
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: 'production-project',
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { user_id: ACTOR, email: 'bafudata@example.com', session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        fetchAccountTableRows: async ({ table }) => {
          if (table === 'flows') {
            flowScans += 1;
            return {
              rows: base.source_rows.map(remoteFromSnapshot),
              source_urls: ['flows'],
              completeness: tableCompleteness(305),
            };
          }
          processScans += 1;
          return {
            rows: [affected, ...unaffected].sort((left, right) =>
              `${left.id}\u0000${left.version}`.localeCompare(`${right.id}\u0000${right.version}`),
            ),
            source_urls: ['processes'],
            completeness: tableCompleteness(201),
          };
        },
        fetchExactRows: async ({ table, id, version }) => {
          const row = exactRows.get(`${table}\u0000${id}\u0000${version}`);
          return { rows: row ? [row] : [], source_url: 'exact' };
        },
        attest: async ({ request }) => {
          attestCalls += 1;
          const mappings = request.mappings as JsonObject[];
          const intents = request.process_intents as JsonObject[];
          return {
            ok: true,
            command: 'cmd_dataset_flow_identity_capture_attest_guarded',
            schema_version: 'dataset-flow-identity-capture-attest-result.v2',
            proof_domain: 'dataset-flow-identity-db-proof.v2',
            receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            receipt_proof_sha256: HASH('capture-receipt-proof'),
            operation_id: request.operation_id,
            environment: request.environment,
            project_ref: request.project_ref,
            captured_at: '2026-07-16T05:00:01.000Z',
            expires_at: '2026-07-22T05:00:01.000Z',
            source_guard_set_sha256: HASH('capture-source-guards'),
            support_guard_set_sha256: HASH('capture-support-guards'),
            target_guard_set_sha256: HASH('capture-target-guards'),
            mapping_guard_set_sha256: HASH('capture-mapping-guards'),
            process_intent_set_sha256: HASH('capture-process-intents'),
            protected_closure_sha256: HASH('capture-protected-closure'),
            whole_scope_proof_sha256: HASH('capture-whole-scope'),
            policy_sha256: (request.compatibility_policy as JsonObject).policy_sha256,
            policy_approval_text_sha256: (request.compatibility_policy as JsonObject)
              .approval_text_sha256,
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
        },
        materialize: materializePrivateArtifactDirectoryAtomically,
      },
    );
    assert.equal(flowScans, 1);
    assert.equal(processScans, 1);
    assert.equal(attestCalls, 1);
    assert.equal(report.counts.owner_draft_processes, 201);
    assert.equal(report.counts.affected_processes, 1);
    const persisted = JSON.parse(
      readFileSync(path.join(outDir, 'flow-identity-live-capture.json'), 'utf8'),
    ) as FlowIdentityLiveCapture;
    assert.equal(persisted.process_rows.length, 1);
    assert.equal(persisted.completeness.owner_draft_process_count, 201);
    assert.equal(
      readFileSync(path.join(outDir, 'flow-identity-live-capture.json'), 'utf8').includes(
        unaffected[0]!.id,
      ),
      false,
    );
    const roundtrip = buildFlowIdentityPlan({
      policy: input.policy,
      reviewLedger: input.review,
      liveCapture: persisted,
      now: new Date('2026-07-16T05:10:00.000Z'),
      validation: input.validation,
    });
    assert.equal(roundtrip.plan.summary.processes, 1);
    assert.equal(roundtrip.plan.summary.rewrites, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh v3 planner freezes exact reference-only rewrites, collisions, and protected closure', () => {
  const input = scenario();
  const bundle = buildFlowIdentityPlan({
    policy: input.policy,
    reviewLedger: input.review,
    liveCapture: input.capture,
    now: new Date('2026-07-16T04:20:00.000Z'),
    validation: input.validation,
  });
  const plan = parseFlowIdentityPlan(bundle.plan);
  assert.equal(plan.summary.semantic_sources, 305);
  assert.equal(plan.summary.mappings, 1);
  assert.equal(plan.summary.processes, 1);
  assert.equal(plan.summary.rewrites, 1);
  assert.equal(plan.summary.collision_entries, 1);
  assert.deepEqual(
    {
      pending: plan.summary.pending,
      blockers: plan.summary.blockers,
      orphans: plan.summary.orphans,
      protectedReferences: plan.summary.protected_references,
    },
    { pending: 1, blockers: 1, orphans: 302, protectedReferences: 1 },
  );
  assert.equal(plan.mappings[0]!.ordinal, 1);
  assert.equal(plan.mappings[0]!.compatibility.flow_schema.status, 'legacy_warning');
  assert.equal(
    plan.mappings[0]!.source.row_sha256,
    planInternals.flowGuardRowSha256(input.capture.source_rows[0]!),
  );
  assert.equal(
    plan.mappings[0]!.source.category_path_sha256,
    sha256Json(
      planInternals.flowClassificationInformation(input.capture.source_rows[0]!.json_ordered!),
    ),
  );
  assert.equal(plan.processes[0]!.ordinal, 1);
  assert.equal(plan.processes[0]!.rewrite_count, 1);
  assert.equal(plan.processes[0]!.model_id, '77777777-7777-4777-8777-777777777777');
  assert.equal(plan.processes[0]!.rule_verification, false);
  assert.equal(
    plan.processes[0]!.before_row_sha256,
    planInternals.processGuardRowSha256(input.capture.process_rows[0]!),
  );
  assert.notEqual(plan.processes[0]!.before_row_sha256, input.capture.process_rows[0]!.row_sha256);

  const template = bundle.process_templates[0]!;
  assert.equal(template.rewrites[0]!.exchange_index, 0);
  assert.equal(template.rewrites[0]!.ordinal, 1);
  assert.equal(template.rewrites[0]!.source_reference['@refObjectId'], sourceId(0));
  assert.equal(template.rewrites[0]!.target_reference['@refObjectId'], TARGET_ID);
  assert.deepEqual(template.collision_ledger.entries[0]!.exchange_indexes, [0, 1]);
  assert.deepEqual(template.collision_ledger.entries[0]!.internal_ids, ['1', '2']);
  assert.deepEqual(template.collision_ledger.entries[0]!.mapping_ids, [
    plan.mappings[0]!.mapping_id,
    null,
  ]);
  const before = processPayload();
  const desired = template.desired_payload;
  const beforeExchanges = planInternals.processExchanges(before)!;
  const desiredExchanges = planInternals.processExchanges(desired)!;
  assert.equal(desiredExchanges.length, beforeExchanges.length);
  assert.equal(desiredExchanges[0]!.meanAmount, '1.250');
  assert.deepEqual(desiredExchanges[0]!.generalComment, beforeExchanges[0]!.generalComment);
  assert.equal(
    (desiredExchanges[0]!.referenceToFlowDataSet as JsonObject)['common:subReference'],
    'must-survive-five-field-patch',
  );
  assert.deepEqual(desiredExchanges[1], beforeExchanges[1]);
  assert.deepEqual(desiredExchanges[2], beforeExchanges[2]);
  assert.equal(
    (desiredExchanges[0]!.referenceToFlowDataSet as JsonObject)['@refObjectId'],
    TARGET_ID,
  );
  assert.equal(
    plan.processes[0]!.process_template_sha256,
    bundle.process_templates[0]!.process.process_template_sha256,
  );
  const processTemplateBody = Object.fromEntries(
    Object.entries(plan.processes[0]!).filter(([key]) => key !== 'process_template_sha256'),
  );
  assert.equal(
    computeFlowIdentityProcessTemplateSha256(plan.processes[0]!),
    sha256Json(processTemplateBody),
  );
  assert.notEqual(
    plan.processes[0]!.process_template_sha256,
    sha256Json({ ...plan.processes[0], process_template_sha256: '' }),
  );
  assert.equal(plan.plan_sha256, computeFlowIdentityPlanSha256(plan));
});

test('planner writes immutable compact artifacts without a live database connection', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-plan-'));
  try {
    const input = scenario();
    const plan = runFlowIdentityPlan({
      policy: input.policy,
      reviewLedger: input.review,
      liveCapture: input.capture,
      now: new Date('2026-07-16T04:20:00.000Z'),
      validation: input.validation,
      outDir: root,
    });
    assert.equal(existsSync(path.join(root, 'flow-identity-plan.json')), true);
    assert.equal(existsSync(path.join(root, 'flow-identity-live-capture.json')), true);
    assert.equal(existsSync(path.join(root, 'flow-identity-process-manifest.jsonl')), true);
    assert.equal(existsSync(path.join(root, 'flow-identity-collision-ledger.jsonl')), true);
    assert.equal(existsSync(path.join(root, 'flow-identity-protected-closure.json')), true);
    const requestFiles = readFileSync(
      path.join(root, 'flow-identity-process-manifest.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    assert.equal(requestFiles.length, 1);
    const rerun = runFlowIdentityPlan({
      policy: input.policy,
      reviewLedger: input.review,
      liveCapture: input.capture,
      now: new Date('2026-07-16T04:20:00.000Z'),
      validation: input.validation,
      outDir: root,
    });
    assert.equal(rerun.plan_sha256, plan.plan_sha256);
    assert.throws(
      () =>
        runFlowIdentityPlan({
          policy: input.policy,
          reviewLedger: input.review,
          liveCapture: input.capture,
          now: new Date('2026-07-16T04:20:01.000Z'),
          validation: input.validation,
          outDir: root,
        }),
      /Refusing to overwrite protected evidence/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file-first planner accepts only canonical protected inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-files-'));
  try {
    const input = scenario();
    const policyPath = path.join(root, 'policy.json');
    const reviewPath = path.join(root, 'review.json');
    const capturePath = path.join(root, 'capture.json');
    writePrivateImmutableJson(policyPath, input.policy);
    writePrivateImmutableJson(reviewPath, input.review);
    writePrivateImmutableJson(capturePath, input.capture);
    assert.deepEqual(commandInternals.readCanonical(policyPath, 'policy'), input.policy);
    const plan = runFlowIdentityPlanFromFiles({
      policyPath,
      reviewLedgerPath: reviewPath,
      liveCapturePath: capturePath,
      outDir: path.join(root, 'plan'),
      now: new Date('2026-07-16T04:20:00.000Z'),
      validation: input.validation,
    });
    assert.equal(plan.summary.semantic_sources, 305);

    const nonCanonicalPath = path.join(root, 'noncanonical.json');
    writePrivateImmutableText(nonCanonicalPath, `${JSON.stringify(input.policy, null, 2)}\n`);
    assert.throws(
      () => commandInternals.readCanonical(nonCanonicalPath, 'policy'),
      /canonical JSON/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical Step 3 authority and stale or tampered captures fail closed', () => {
  const historical = [...HISTORICAL_FLOW_IDENTITY_AUTHORITY_SHA256][0]!;
  assert.throws(() => assertCurrentFlowIdentityAuthority({ oracleSha256: historical }), {
    name: 'CliError',
  });
  assert.throws(
    () =>
      assertCurrentFlowIdentityAuthority({
        approvalText: `APPROVE BAFU STEP3 LEGACY TARGET POLICY ${historical}`,
      }),
    /Historical Step 3/u,
  );
  assert.throws(() => assertCurrentFlowIdentityAuthority({ oracleGeneration: 'pre_step2' }), {
    name: 'CliError',
  });
  assert.throws(() => assertCurrentFlowIdentityAuthority({ sourceCount: 224 }), /224-row/u);

  const input = scenario();
  const oldPolicy = { ...input.policy, policy_sha256: historical };
  assert.throws(() => parseFlowIdentityPolicy(oldPolicy), /Historical Step 3/u);
  const stale = structuredClone(input.capture);
  stale.captured_at_utc = '2026-07-16T03:59:59.000Z';
  stale.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(stale);
  assert.throws(() => parseFlowIdentityCapture(stale), /stale/u);
  const tampered = structuredClone(input.capture);
  tampered.account.email = 'UPPER@example.com';
  tampered.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(tampered);
  assert.throws(() => parseFlowIdentityCapture(tampered), /tampered/u);
  const badReference = { ...reference(TARGET_ID, PUBLIC_VERSION), extra: true };
  assert.throws(
    () => parseFlowIdentityReference(badReference, 'target'),
    /exactly the five approved/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityReference({ ...reference(TARGET_ID, PUBLIC_VERSION), '@uri': '' }, 'target'),
    /non-empty/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityReference(
        { ...reference(TARGET_ID, PUBLIC_VERSION), '@uri': `../${'é'.repeat(1_100)}` },
        'target',
      ),
    /type or URI/u,
  );
});

test('capture tolerates bounded DB/client clock skew without weakening receipt TTL', () => {
  const input = scenario();
  const boundedClockSkew = structuredClone(input.capture);
  boundedClockSkew.attestation.captured_at = '2026-07-16T04:08:00.000Z';
  boundedClockSkew.attestation.expires_at = '2026-07-23T04:08:00.000Z';
  boundedClockSkew.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(boundedClockSkew);
  assert.equal(
    parseFlowIdentityCapture(boundedClockSkew).attestation.captured_at,
    '2026-07-16T04:08:00.000Z',
  );
  const excessiveClockSkew = structuredClone(input.capture);
  excessiveClockSkew.attestation.captured_at = '2026-07-16T04:04:59.000Z';
  excessiveClockSkew.attestation.expires_at = '2026-07-23T04:04:59.000Z';
  excessiveClockSkew.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(excessiveClockSkew);
  assert.throws(() => parseFlowIdentityCapture(excessiveClockSkew), /stale|tampered/u);
  const excessiveTtl = structuredClone(input.capture);
  excessiveTtl.attestation.expires_at = '2026-07-23T04:11:00.001Z';
  excessiveTtl.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(excessiveTtl);
  assert.throws(() => parseFlowIdentityCapture(excessiveTtl), /stale|tampered/u);
});

test('planner rejects phantom orphans, target drift, incompatible directions, missing baselines, and schema failures', () => {
  const phantom = scenario();
  phantom.review.entries[1] = { ...phantom.review.entries[1]!, disposition: 'orphan' };
  phantom.review.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(phantom.review);
  assert.throws(() => liveCapture(phantom.review), /reviewed orphan has live process references/u);

  const targetDrift = scenario();
  targetDrift.capture.target_rows[0]!.state_code = 0;
  targetDrift.capture.target_rows[0]!.row_sha256 = sha256Json({ bad: true });
  targetDrift.capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(
    targetDrift.capture,
  );
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: targetDrift.policy,
        reviewLedger: targetDrift.review,
        liveCapture: targetDrift.capture,
        validation: targetDrift.validation,
      }),
    /snapshot hash is invalid|tampered/u,
  );

  const direction = scenario();
  direction.review.entries[0]!.allowed_directions = ['Input'];
  direction.review.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(direction.review);
  assert.throws(() => liveCapture(direction.review), /compatibility guard/u);

  const equalCountSemanticDrift = scenario();
  const driftedMapping = equalCountSemanticDrift.capture.capture_request.mappings[0]!;
  (driftedMapping.target as JsonObject).id = '77777777-7777-4777-8777-777777777778';
  equalCountSemanticDrift.capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(
    equalCountSemanticDrift.capture,
  );
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: equalCountSemanticDrift.policy,
        reviewLedger: equalCountSemanticDrift.review,
        liveCapture: equalCountSemanticDrift.capture,
        validation: equalCountSemanticDrift.validation,
      }),
    /tampered|does not bind the exact local mapping/u,
  );

  const missingSupportVersion = scenario();
  const sourcePayload = structuredClone(
    missingSupportVersion.capture.source_rows[0]!.json_ordered!,
  );
  const sourceFlowPropertyReference = (
    (sourcePayload.flowDataSet as JsonObject).flowProperties as JsonObject
  ).flowProperty as JsonObject;
  delete (sourceFlowPropertyReference.referenceToFlowPropertyDataSet as JsonObject)['@version'];
  missingSupportVersion.capture.source_rows[0] = snapshot({
    table: 'flows',
    id: sourceId(0),
    version: VERSION,
    userId: ACTOR,
    stateCode: 0,
    payload: sourcePayload,
  });
  missingSupportVersion.capture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(
    missingSupportVersion.capture,
  );
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: missingSupportVersion.policy,
        reviewLedger: missingSupportVersion.review,
        liveCapture: missingSupportVersion.capture,
        validation: missingSupportVersion.validation,
      }),
    /tampered/u,
  );

  const whitespaceName = scenario();
  whitespaceName.review.entries[0]!.target!.reference['common:shortDescription'] = ` ${TARGET_ID} `;
  whitespaceName.review.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(
    whitespaceName.review,
  );
  assert.throws(() => liveCapture(whitespaceName.review), /compatibility guard/u);

  const schemaFailure = scenario();
  const processFail = (): ProcessPayloadValidationResult => ({
    ok: false,
    validator: 'test-process-schema',
    issue_count: 1,
    issues: [{ path: 'process', message: 'bad', code: 'custom' }],
  });
  const schemaFailureNow = Date.now();
  schemaFailure.capture.attestation.captured_at = new Date(schemaFailureNow - 60_000).toISOString();
  schemaFailure.capture.attestation.expires_at = new Date(schemaFailureNow + 60_000).toISOString();
  bindCaptureReceiptSemantics(schemaFailure.capture, schemaFailure.review);
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: schemaFailure.policy,
        reviewLedger: schemaFailure.review,
        liveCapture: schemaFailure.capture,
        validation: { ...schemaFailure.validation, validateProcess: processFail },
      }),
    /failed ProcessSchema/u,
  );
});

test('contract parsers reject review, policy, and plan tampering', () => {
  const input = scenario();
  assert.equal(parseFlowIdentityPolicy(input.policy).policy_sha256, input.policy.policy_sha256);
  assert.equal(parseFlowIdentityReviewLedger(input.review).entries.length, 305);
  assert.equal(parseFlowIdentityCapture(input.capture).source_rows.length, 305);

  const wrongPolicyEvidence = { ...input.policy, evidence_resolution_sha256: HASH('wrong') };
  assert.throws(
    () =>
      buildFlowIdentityPlan({
        policy: wrongPolicyEvidence,
        reviewLedger: input.review,
        liveCapture: input.capture,
        validation: input.validation,
      }),
    /does not bind/u,
  );
  const duplicateReview = structuredClone(input.review);
  duplicateReview.entries[304]!.source = { ...duplicateReview.entries[0]!.source };
  duplicateReview.ledger_sha256 = computeFlowIdentityReviewLedgerSha256(duplicateReview);
  assert.throws(() => parseFlowIdentityReviewLedger(duplicateReview), /305 unique/u);

  const currentWindow = Date.now();
  input.capture.attestation.captured_at = new Date(currentWindow - 60_000).toISOString();
  input.capture.attestation.expires_at = new Date(currentWindow + 60_000).toISOString();
  bindCaptureReceiptSemantics(input.capture, input.review);

  const bundle = buildFlowIdentityPlan({
    policy: input.policy,
    reviewLedger: input.review,
    liveCapture: input.capture,
    validation: input.validation,
  });
  const plan = structuredClone(bundle.plan);
  plan.processes[0]!.rewrite_count = 99;
  plan.plan_sha256 = computeFlowIdentityPlanSha256(plan);
  assert.throws(() => parseFlowIdentityPlan(plan), /inconsistent or tampered/u);

  const incompleteUniverse = structuredClone(bundle.plan);
  incompleteUniverse.protected_closure.orphans[1]!.source_id =
    incompleteUniverse.protected_closure.orphans[0]!.source_id;
  incompleteUniverse.protected_closure.orphan_set_sha256 = sha256Json(
    incompleteUniverse.protected_closure.orphans,
  );
  incompleteUniverse.protected_closure_artifact_sha256 = sha256Json(
    incompleteUniverse.protected_closure,
  );
  incompleteUniverse.processes[0]!.pending_blocker_closure_sha256 =
    incompleteUniverse.protected_closure_artifact_sha256;
  incompleteUniverse.processes[0]!.process_template_sha256 =
    computeFlowIdentityProcessTemplateSha256(incompleteUniverse.processes[0]!);
  incompleteUniverse.process_manifest_artifact_sha256 = sha256Json(incompleteUniverse.processes);
  const incompleteSourceUniverse = [
    ...incompleteUniverse.mappings.map((mapping) => ({
      id: mapping.source.id,
      version: mapping.source.version,
      user_id: incompleteUniverse.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...incompleteUniverse.protected_closure.pending.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: incompleteUniverse.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...incompleteUniverse.protected_closure.blockers.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: incompleteUniverse.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
    ...incompleteUniverse.protected_closure.orphans.map((entry) => ({
      id: entry.source_id,
      version: entry.source_version,
      user_id: incompleteUniverse.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    })),
  ].sort((left, right) =>
    `${left.id}\u0000${left.version}`.localeCompare(`${right.id}\u0000${right.version}`),
  );
  incompleteUniverse.source_universe_artifact_sha256 = sha256Json(incompleteSourceUniverse);
  incompleteUniverse.plan_sha256 = computeFlowIdentityPlanSha256(incompleteUniverse);
  assert.throws(() => parseFlowIdentityPlan(incompleteUniverse), /inconsistent or tampered/u);
});

test('planner internals handle singleton collections and exact patching', () => {
  assert.deepEqual(planInternals.arrayOfObjects({ a: 1 }), [{ a: 1 }]);
  assert.equal(planInternals.arrayOfObjects('bad'), null);
  assert.equal(planInternals.arrayOfObjects([{}, 'bad']), null);
  const mutable = reference(sourceId(0), VERSION);
  planInternals.patchReference(mutable, reference(TARGET_ID, PUBLIC_VERSION));
  assert.equal(mutable['@refObjectId'], TARGET_ID);
  assert.equal(planInternals.exchangeDirection({ exchangeDirection: 'Sideways' }), null);
  assert.equal(planInternals.exchangeInternalId({}), null);
  assert.equal(planInternals.exchangeReference({ referenceToFlowDataSet: { bad: true } }), null);
  assert.equal(planInternals.flowType({}), null);
  assert.equal(planInternals.flowIdentity({}), null);
});

test('execution contract binds production plan, freeze, approval, scope, and no-cycle process request', () => {
  const input = executionScenario();
  const parsedFreeze = parseFlowIdentityFreeze(input.freeze, input.plan);
  const parsedApproval = parseFlowIdentityApproval(input.approval, input.plan, parsedFreeze);
  const identity = buildFlowIdentityExecutionIdentity({
    plan: input.plan,
    freeze: parsedFreeze,
    approval: parsedApproval,
  });
  const preflightRequest = buildFlowIdentityScopePreflightRequest({
    plan: input.plan,
    identity,
  });
  assert.equal(preflightRequest.environment, 'production');
  assert.equal(preflightRequest.target_visibility, 'owner_draft');
  assert.equal('processes' in preflightRequest, false);
  assert.equal('desired_payload' in preflightRequest, false);

  const prepared = prepareFlowIdentityExecution({
    plan: input.plan,
    freeze: input.freeze,
    approval: input.approval,
  });
  assert.equal(prepared.identity.identity_sha256, identity.identity_sha256);
  assert.deepEqual(prepared.preflightRequest, preflightRequest);

  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  assert.equal(
    processRequest.process_request_sha256,
    computeFlowIdentityProcessRequestSha256(processRequest),
  );
  assert.deepEqual(Object.keys(processRequest).sort(), [
    'ordinal',
    'process_intent_proof_sha256',
    'process_request_sha256',
    'request_id',
    'schema_version',
    'scope_proof_sha256',
  ]);
  assert.notEqual(
    computeFlowIdentityProcessRequestSha256({ ...processRequest, ordinal: 2 }),
    processRequest.process_request_sha256,
  );
});

test('flow-identity contract helpers fail closed for every guarded shape', () => {
  const input = executionScenario();
  assert.throws(() => contractInternals.token(null, 'token'), /non-empty/u);
  assert.throws(() => contractInternals.hash('BAD', 'hash'), /SHA-256/u);
  assert.throws(() => contractInternals.instant('not-a-time', 'time'), /RFC3339/u);
  assert.throws(() => contractInternals.version('1', 'version'), /NN\.NN\.NNN/u);
  assert.equal(contractInternals.hasExactKeys(null, []), false);
  assert.equal(contractInternals.hasExactKeys({}, []), true);
  assert.throws(
    () =>
      assertCurrentFlowIdentityAuthority({
        approvalText: 'APPROVE BAFU STEP3 LEGACY TARGET POLICY abc',
      }),
    /Historical Step 3/u,
  );
  assert.throws(
    () => assertCurrentFlowIdentityAuthority({ oracleGeneration: 'pre_step2' }),
    /Pre-Step-2/u,
  );

  assert.throws(() => parseFlowIdentityReference(null, 'reference'), /object/u);
  assert.throws(
    () =>
      parseFlowIdentityReference(
        { ...reference(TARGET_ID, PUBLIC_VERSION), extra: true },
        'reference',
      ),
    /exactly the five/u,
  );
  const referenceMutations: Array<(value: JsonObject) => void> = [
    (value) => {
      value['@refObjectId'] = 'bad';
    },
    (value) => {
      value['@type'] = 'not a flow';
    },
    (value) => {
      value['@uri'] = 'ü'.repeat(1_025);
    },
    (value) => {
      value['common:shortDescription'] = 1;
    },
  ];
  for (const mutate of referenceMutations) {
    const value = structuredClone(reference(TARGET_ID, PUBLIC_VERSION)) as JsonObject;
    mutate(value);
    assert.throws(() => parseFlowIdentityReference(value, 'reference'), /invalid/u);
  }
  const arrayDescription = structuredClone(reference(TARGET_ID, PUBLIC_VERSION)) as JsonObject;
  arrayDescription['common:shortDescription'] = [{ '#text': 'target', '@xml:lang': 'en' }];
  assert.deepEqual(
    parseFlowIdentityReference(arrayDescription, 'reference')['common:shortDescription'],
    [{ '#text': 'target', '@xml:lang': 'en' }],
  );
  assert.throws(() => extractFlowIdentityReference(null, 'reference'), /object/u);

  assert.throws(() => parseFlowIdentityPolicy(null), /invalid/u);
  for (const mutate of [
    (value: JsonObject) => {
      value.extra = true;
    },
    (value: JsonObject) => {
      value.schema_version = 'v0';
    },
    (value: JsonObject) => {
      value.policy_sha256 = 'bad';
    },
    (value: JsonObject) => {
      value.evidence_resolution_sha256 = 'bad';
    },
    (value: JsonObject) => {
      value.approval_text_sha256 = 'bad';
    },
  ]) {
    const value = structuredClone(input.plan.compatibility_policy) as unknown as JsonObject;
    mutate(value);
    assert.throws(() => parseFlowIdentityPolicy(value), /invalid|SHA-256/u);
  }
  assert.throws(
    () => parseFlowIdentityPolicy({ ...input.plan.compatibility_policy, approved_at_utc: 'bad' }),
    /RFC3339/u,
  );

  assert.throws(() => contractInternals.parseReviewEntry(null, 0), /invalid/u);
  assert.deepEqual(
    contractInternals.parseReviewEntry({ ...reviewEntry(1), allowed_directions: null }, 1)
      .allowed_directions,
    [],
  );
  assert.throws(
    () => contractInternals.parseReviewEntry({ ...reviewEntry(0), disposition: 'foreign' }, 0),
    /unsupported/u,
  );
  for (const mutate of [
    (value: JsonObject) => {
      (value.source as JsonObject).id = 'bad';
    },
    (value: JsonObject) => {
      (value.target as JsonObject).id = 'bad';
    },
    (value: JsonObject) => {
      value.allowed_directions = ['Sideways'];
    },
    (value: JsonObject) => {
      value.allowed_directions = ['Output', 'Output'];
    },
    (value: JsonObject) => {
      value.target = null;
    },
  ]) {
    const value = structuredClone(reviewEntry(0)) as unknown as JsonObject;
    mutate(value);
    assert.throws(() => contractInternals.parseReviewEntry(value, 0), /target\/direction/u);
  }
  assert.throws(() => parseFlowIdentityReviewLedger(null), /invalid/u);
  assert.throws(() => parseFlowIdentityCapture(null), /invalid/u);
  assert.throws(() => parseFlowIdentityPlan(null), /invalid/u);

  const support = input.plan.support_snapshots[0]!;
  assert.equal(contractInternals.validSupportSnapshot(support, input.plan.account.user_id), true);
  const supportMutations: Array<(value: JsonObject) => void> = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.table = 'flows';
    },
    (value) => {
      value.id = 'bad';
    },
    (value) => {
      value.version = 'bad';
    },
    (value) => {
      value.user_id = 'bad';
    },
    (value) => {
      value.state_code = 1;
    },
    (value) => {
      value.modified_at = 'bad';
    },
    (value) => {
      value.payload_sha256 = 'bad';
    },
    (value) => {
      value.row_sha256 = HASH('bad-row');
    },
  ];
  for (const mutate of supportMutations) {
    const value = structuredClone(support) as unknown as JsonObject;
    mutate(value);
    assert.equal(
      contractInternals.validSupportSnapshot(value as never, input.plan.account.user_id),
      false,
    );
  }
  const privateSupport = structuredClone(support) as unknown as JsonObject;
  privateSupport.state_code = 0;
  privateSupport.user_id = input.plan.account.user_id;
  privateSupport.row_sha256 = contractInternals.supportSnapshotRowSha256(privateSupport as never);
  assert.equal(
    contractInternals.validSupportSnapshot(privateSupport as never, input.plan.account.user_id),
    true,
  );
  privateSupport.user_id = PUBLIC_OWNER;
  privateSupport.row_sha256 = contractInternals.supportSnapshotRowSha256(privateSupport as never);
  assert.equal(
    contractInternals.validSupportSnapshot(privateSupport as never, input.plan.account.user_id),
    false,
  );

  const occurrence = input.plan.protected_closure.pending[0]!;
  assert.equal(contractInternals.validOccurrenceEntry(occurrence), true);
  const secondOccurrence = {
    ...occurrence.occurrences[0]!,
    exchange_index: occurrence.occurrences[0]!.exchange_index + 1,
  };
  const orderedOccurrence = {
    ...occurrence,
    expected_reference_count: 2,
    occurrences: [...occurrence.occurrences, secondOccurrence],
    occurrence_set_sha256: sha256Json([...occurrence.occurrences, secondOccurrence]),
  };
  assert.equal(contractInternals.validOccurrenceEntry(orderedOccurrence), true);
  const reversed = {
    ...orderedOccurrence,
    occurrences: [...orderedOccurrence.occurrences].reverse(),
  };
  reversed.occurrence_set_sha256 = sha256Json(reversed.occurrences);
  assert.equal(contractInternals.validOccurrenceEntry(reversed), false);
  const occurrenceMutations: Array<{ mutate: (value: JsonObject) => void; nested?: true }> = [
    {
      mutate: (value) => {
        value.extra = true;
      },
    },
    {
      mutate: (value) => {
        value.source_id = 'bad';
      },
    },
    {
      mutate: (value) => {
        value.source_version = 'bad';
      },
    },
    {
      mutate: (value) => {
        value.expected_reference_count = 0;
      },
    },
    {
      mutate: (value) => {
        value.evidence_sha256 = 'bad';
      },
    },
    {
      mutate: (value) => {
        value.occurrence_set_sha256 = 'bad';
      },
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.extra = true;
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.process_id = 'bad';
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.process_version = 'bad';
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.exchange_index = 1.5;
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.exchange_index = -1;
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.internal_id = '';
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.direction = 'Sideways';
      },
      nested: true,
    },
    {
      mutate: (value) => {
        (value.occurrences as JsonObject[])[0]!.reference_sha256 = 'bad';
      },
      nested: true,
    },
  ];
  for (const { mutate, nested } of occurrenceMutations) {
    const value = structuredClone(occurrence) as unknown as JsonObject;
    mutate(value);
    if (nested) value.occurrence_set_sha256 = sha256Json(value.occurrences);
    assert.equal(contractInternals.validOccurrenceEntry(value as never), false);
  }
});

test('mapping and process manifest validators reject every widened database guard', () => {
  const input = executionScenario();
  const mapping = input.plan.mappings[0]!;
  assert.equal(contractInternals.validMapping(mapping, input.plan.account.user_id), true);
  const mappingMutations: Array<(value: JsonObject) => void> = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      (value.source as JsonObject).extra = true;
    },
    (value) => {
      (value.target as JsonObject).extra = true;
    },
    (value) => {
      (value.compatibility as JsonObject).extra = true;
    },
    (value) => {
      ((value.compatibility as JsonObject).flow_schema as JsonObject).extra = true;
    },
    (value) => {
      (value.source as JsonObject).id = 'bad';
    },
    (value) => {
      (value.target as JsonObject).id = 'bad';
    },
    (value) => {
      (value.source as JsonObject).version = 'bad';
    },
    (value) => {
      (value.target as JsonObject).version = 'bad';
    },
    (value) => {
      (value.source as JsonObject).user_id = PUBLIC_OWNER;
    },
    (value) => {
      (value.source as JsonObject).state_code = 100;
    },
    (value) => {
      (value.source as JsonObject).flow_type = 'Product flow';
    },
    (value) => {
      (value.source as JsonObject).modified_at = 'bad';
    },
    (value) => {
      (value.target as JsonObject).user_id = ACTOR;
    },
    (value) => {
      (value.target as JsonObject).state_code = 0;
    },
    (value) => {
      (value.target as JsonObject).flow_type = 'Product flow';
    },
    (value) => {
      (value.target as JsonObject).modified_at = 'bad';
    },
    (value) => {
      (value.target as JsonObject).flow_property_id = sourceId(100);
    },
    (value) => {
      (value.target as JsonObject).flow_property_version = VERSION;
    },
    (value) => {
      (value.target as JsonObject).unit_group_id = sourceId(101);
    },
    (value) => {
      (value.target as JsonObject).unit_group_version = VERSION;
    },
    (value) => {
      ((value.target as JsonObject).reference as JsonObject)['@refObjectId'] = sourceId(102);
    },
    (value) => {
      ((value.target as JsonObject).reference as JsonObject)['@version'] = VERSION;
    },
    (value) => {
      (value.compatibility as JsonObject).mode = 'conversion';
    },
    (value) => {
      (value.compatibility as JsonObject).confidence = 'pending';
    },
    (value) => {
      (value.compatibility as JsonObject).flow_property_compatible = false;
    },
    (value) => {
      (value.compatibility as JsonObject).unit_group_compatible = false;
    },
    (value) => {
      (value.compatibility as JsonObject).direction_compatible = false;
    },
    (value) => {
      (value.compatibility as JsonObject).compartment_compatible = false;
    },
    (value) => {
      (value.compatibility as JsonObject).conversion_factor = '2';
    },
    (value) => {
      ((value.compatibility as JsonObject).flow_schema as JsonObject).status = 'fail';
    },
    (value) => {
      (value.compatibility as JsonObject).process_schema_required = 'fail';
    },
    (value) => {
      (value.source as JsonObject).payload_sha256 = 'bad';
    },
  ];
  for (const mutate of mappingMutations) {
    const value = structuredClone(mapping) as unknown as JsonObject;
    mutate(value);
    assert.equal(contractInternals.validMapping(value as never, input.plan.account.user_id), false);
  }

  const process = input.plan.processes[0]!;
  assert.equal(contractInternals.validProcess(process, input.plan.account.user_id), true);
  const processMutations: Array<(value: JsonObject) => void> = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      (value.process_schema as JsonObject).extra = true;
    },
    (value) => {
      value.id = 'bad';
    },
    (value) => {
      value.version = 'bad';
    },
    (value) => {
      value.user_id = PUBLIC_OWNER;
    },
    (value) => {
      value.state_code = 100;
    },
    (value) => {
      value.modified_at = 'bad';
    },
    (value) => {
      value.model_id = 'bad';
    },
    (value) => {
      value.rule_verification = 'false';
    },
    (value) => {
      value.before_exchange_count = 1.5;
    },
    (value) => {
      value.before_exchange_count = 0;
    },
    (value) => {
      value.rewrite_count = 1.5;
    },
    (value) => {
      value.rewrite_count = 0;
    },
    (value) => {
      (value.process_schema as JsonObject).status = 'fail';
    },
    (value) => {
      value.before_payload_sha256 = 'bad';
    },
    (value) => {
      value.process_template_sha256 = HASH('foreign-template');
    },
  ];
  for (const mutate of processMutations) {
    const value = structuredClone(process) as unknown as JsonObject;
    mutate(value);
    assert.equal(contractInternals.validProcess(value as never, input.plan.account.user_id), false);
  }
});

test('execution proof parsers enforce exact durable progress and final closure', () => {
  const input = executionScenario();
  const identity = buildFlowIdentityExecutionIdentity({
    plan: input.plan,
    freeze: input.freeze,
    approval: input.approval,
  });
  const scopeId = '88888888-8888-4888-8888-888888888888';
  const scopeProof = HASH('scope-proof');
  const preflight = parseFlowIdentityScopePreflightProof(scopePreflightRaw(input), input.plan);
  assert.equal(preflight.scope_id, scopeId);
  assert.match(identity.request_id, /^[a-f0-9-]{36}$/u);

  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: scopeProof,
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const requestSha = String(processRequest.process_request_sha256);
  const process = input.plan.processes[0]!;
  const processProof = parseFlowIdentityProcessProof({
    value: {
      ok: true,
      command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
      schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
      scope_id: scopeId,
      receipt_id: input.plan.receipt_id,
      receipt_proof_sha256: input.plan.receipt_proof_sha256,
      mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
      process_intent_set_sha256: input.plan.process_intent_set_sha256,
      invocation_id: WRAPPER_INVOCATION_ID,
      permit_generation_before: 0,
      ordinal: 1,
      process_id: process.id,
      process_version: process.version,
      process_request_sha256: requestSha,
      process_intent_proof_sha256: PROCESS_INTENT_PROOF,
      desired_payload_sha256: process.desired_payload_sha256,
      desired_exchange_set_sha256: process.desired_exchange_set_sha256,
      completed_process_count: 1,
      next_ordinal: null,
      primary_complete: true,
      before_payload_sha256: process.before_payload_sha256,
      before_exchange_set_sha256: process.before_exchange_set_sha256,
      after_payload_sha256: process.desired_payload_sha256,
      after_exchange_set_sha256: process.desired_exchange_set_sha256,
      rewrite_count: 1,
      audit_id: 'audit-1',
      derivative_batch_id: '99999999-9999-4999-8999-999999999999',
      status: 'completed',
      replay: false,
    },
    scopeId,
    process,
    requestSha256: requestSha,
    receiptId: input.plan.receipt_id,
    receiptProofSha256: input.plan.receipt_proof_sha256,
    mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
    processIntentSetSha256: input.plan.process_intent_set_sha256,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
    processCount: input.plan.processes.length,
  });
  assert.equal(processProof.audit_id, 'audit-1');

  const status = parseFlowIdentityScopeStatus(
    scopeStatusRaw({ input, phase: 'primary', processRequestSha256: requestSha }),
    input.plan,
    scopeId,
    scopeProof,
  );
  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: scopeProof,
    plan: input.plan,
    status,
  });
  const expected = finalizeRequest.expected as JsonObject;
  const pending = parseFlowIdentityFinalizeProof({
    value: {
      ok: true,
      command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
      schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
      scope_id: scopeId,
      receipt_id: input.plan.receipt_id,
      receipt_proof_sha256: input.plan.receipt_proof_sha256,
      mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
      process_intent_set_sha256: input.plan.process_intent_set_sha256,
      operation_id: input.plan.operation_id,
      plan_sha256: input.plan.plan_sha256,
      scope_proof_sha256: scopeProof,
      invocation_id: WRAPPER_INVOCATION_ID,
      permit_generation_before: 0,
      status: 'derivatives_pending',
      code: 'FLOW_IDENTITY_DERIVATIVES_PENDING',
      process_count: expected.process_count,
      rewrite_count: expected.rewrite_count,
      completed_process_count: expected.completed_process_count,
      primary_closure_sha256: status.whole_scope_proof.primary_closure_sha256,
      protected_closure_sha256: status.whole_scope_proof.protected_closure_sha256,
      derivative_target_set_sha256: HASH('db-derivative-target-set'),
      derivative_proof_set_sha256: status.whole_scope_proof.derivative_proof_set_sha256,
      primary_current: true,
      live_guard_current: true,
      derivatives_current: false,
      compensation_required: false,
      compensation_targets: [],
      automatic_retry: false,
      terminal_proof_sha256: null,
      whole_scope_proof: status.whole_scope_proof,
      whole_scope_proof_sha256: status.whole_scope_proof.proof_sha256,
      audit_id: null,
      replay: false,
    },
    plan: input.plan,
    scopeId,
    scopeProofSha256: scopeProof,
    request: finalizeRequest,
  });
  assert.equal(pending.status, 'derivatives_pending');

  const auditBase = scopeStatusRaw({ input, phase: 'pending' });
  const auditWhole = {
    ...auditBase.whole_scope_proof,
    audit_current: false,
    derivatives_current: false,
    causal_terminal_proof: false,
    proof_sha256: HASH('audit-only-live-drift'),
  };
  const auditOnlyDrift = {
    ...auditBase,
    ok: false,
    status: 'live_drift',
    code: 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
    live_guard_current: false,
    derivatives_current: false,
    cancellable: false,
    whole_scope_proof: auditWhole,
    whole_scope_proof_sha256: auditWhole.proof_sha256,
  };
  assert.equal(
    parseFlowIdentityScopeStatus(auditOnlyDrift, input.plan, scopeId, scopeProof).status,
    'live_drift',
  );
  assert.equal(
    parseFlowIdentityScopeStatus(
      { ...auditOnlyDrift, code: 'FLOW_IDENTITY_SCOPE_TERMINAL_CONFLICT' },
      input.plan,
      scopeId,
      scopeProof,
    ).status,
    'live_drift',
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...auditOnlyDrift, live_guard_current: true },
        input.plan,
        scopeId,
        scopeProof,
      ),
    /does not match/u,
  );

  assert.throws(
    () =>
      parseFlowIdentityScopeStatus({ ...status, next_ordinal: 1 }, input.plan, scopeId, scopeProof),
    /does not match/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: { ...processProof, replay: true, after_payload_sha256: HASH('db-opaque') },
        scopeId,
        process,
        requestSha256: requestSha,
        receiptId: input.plan.receipt_id,
        receiptProofSha256: input.plan.receipt_proof_sha256,
        mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
        processIntentSetSha256: input.plan.process_intent_set_sha256,
        processIntentProofSha256: PROCESS_INTENT_PROOF,
        processCount: input.plan.processes.length,
      }),
    /does not bind/u,
  );
  const opaqueBefore = parseFlowIdentityProcessProof({
    value: { ...processProof, replay: true, before_payload_sha256: HASH('db-opaque-before') },
    scopeId,
    process,
    requestSha256: requestSha,
    receiptId: input.plan.receipt_id,
    receiptProofSha256: input.plan.receipt_proof_sha256,
    mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
    processIntentSetSha256: input.plan.process_intent_set_sha256,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
    processCount: input.plan.processes.length,
  });
  assert.equal(opaqueBefore.before_payload_sha256, HASH('db-opaque-before'));
  const advancedReplay = parseFlowIdentityProcessProof({
    value: {
      ...processProof,
      replay: true,
      completed_process_count: 2,
      primary_complete: true,
      next_ordinal: null,
    },
    scopeId,
    process,
    requestSha256: requestSha,
    receiptId: input.plan.receipt_id,
    receiptProofSha256: input.plan.receipt_proof_sha256,
    mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
    processIntentSetSha256: input.plan.process_intent_set_sha256,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
    processCount: 2,
  });
  assert.equal(advancedReplay.completed_process_count, 2);
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: { ...advancedReplay, replay: false },
        scopeId,
        process,
        requestSha256: requestSha,
        receiptId: input.plan.receipt_id,
        receiptProofSha256: input.plan.receipt_proof_sha256,
        mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
        processIntentSetSha256: input.plan.process_intent_set_sha256,
        processIntentProofSha256: PROCESS_INTENT_PROOF,
        processCount: 2,
      }),
    /does not bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: { ...processProof, primary_complete: false, next_ordinal: null },
        scopeId,
        process,
        requestSha256: requestSha,
        receiptId: input.plan.receipt_id,
        receiptProofSha256: input.plan.receipt_proof_sha256,
        mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
        processIntentSetSha256: input.plan.process_intent_set_sha256,
        processIntentProofSha256: PROCESS_INTENT_PROOF,
        processCount: 2,
      }),
    /does not bind/u,
  );
});

test('process success progress is DB-led and replay may only advance within the frozen ledger', () => {
  const input = executionScenario();
  const process = input.plan.processes[0]!;
  const scopeId = scopePreflightRaw(input).scope_id;
  const request = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const requestSha = String(request.process_request_sha256);
  const raw = {
    ok: true,
    command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
    schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
    scope_id: scopeId,
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    ordinal: process.ordinal,
    process_id: process.id,
    process_version: process.version,
    process_request_sha256: requestSha,
    process_intent_proof_sha256: PROCESS_INTENT_PROOF,
    desired_payload_sha256: process.desired_payload_sha256,
    desired_exchange_set_sha256: process.desired_exchange_set_sha256,
    completed_process_count: 2,
    next_ordinal: null,
    primary_complete: true,
    before_payload_sha256: process.before_payload_sha256,
    before_exchange_set_sha256: process.before_exchange_set_sha256,
    after_payload_sha256: process.desired_payload_sha256,
    after_exchange_set_sha256: process.desired_exchange_set_sha256,
    rewrite_count: process.rewrite_count,
    audit_id: 'audit-replay',
    derivative_batch_id: '99999999-9999-4999-8999-999999999999',
    status: 'completed',
    replay: true,
  };
  const options = {
    scopeId,
    process,
    requestSha256: requestSha,
    receiptId: input.plan.receipt_id,
    receiptProofSha256: input.plan.receipt_proof_sha256,
    mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
    processIntentSetSha256: input.plan.process_intent_set_sha256,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
    processCount: 2,
  };
  assert.equal(parseFlowIdentityProcessProof({ value: raw, ...options }).next_ordinal, null);
  assert.throws(
    () => parseFlowIdentityProcessProof({ value: { ...raw, replay: false }, ...options }),
    /does not bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: { ...raw, primary_complete: false, next_ordinal: null },
        ...options,
      }),
    /does not bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: { ...raw, completed_process_count: 3 },
        ...options,
      }),
    /does not bind/u,
  );
});

test('execution contract rejects non-production freeze and tampered or historical approvals', () => {
  const input = executionScenario();
  assert.throws(
    () =>
      parseFlowIdentityFreeze(
        { ...input.freeze, environment: 'preview', freeze_sha256: input.freeze.freeze_sha256 },
        input.plan,
      ),
    /does not exactly bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityApproval(
        { ...input.approval, approval_text_sha256: HASH('tampered') },
        input.plan,
        input.freeze,
      ),
    /does not exactly bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityApproval(
        {
          ...input.approval,
          policy_approval_text_sha256: [...HISTORICAL_FLOW_IDENTITY_AUTHORITY_SHA256][0],
        },
        input.plan,
        input.freeze,
      ),
    /Historical Step 3/u,
  );
});

test('execution contract primitive and outer guards reject malformed evidence', () => {
  const input = executionScenario();
  assert.throws(() => executionInternals.token(null, 'token'), /non-empty/u);
  assert.throws(() => executionInternals.hash('bad', 'hash'), /SHA-256/u);
  assert.throws(() => executionInternals.uuid('bad', 'uuid'), /UUID/u);
  assert.throws(() => executionInternals.instant('bad', 'instant'), /RFC3339/u);
  assert.throws(() => executionInternals.integer(1.5, 'integer'), /integer/u);
  assert.equal(executionInternals.integer(1, 'integer', 1), 1);
  assert.equal(
    executionInternals.instant('2026-07-16T05:00:00.000Z', 'instant'),
    '2026-07-16T05:00:00.000Z',
  );
  assert.throws(() => parseFlowIdentityFreeze(null, input.plan), /invalid/u);
  assert.throws(() => parseFlowIdentityApproval(null, input.plan, input.freeze), /invalid/u);
  assert.throws(() => parseFlowIdentityScopePreflightProof(null, input.plan), /invalid/u);
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: null,
        scopeId: scopePreflightRaw(input).scope_id,
        process: input.plan.processes[0]!,
        requestSha256: HASH('request'),
        receiptId: input.plan.receipt_id,
        receiptProofSha256: input.plan.receipt_proof_sha256,
        mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
        processIntentSetSha256: input.plan.process_intent_set_sha256,
        processIntentProofSha256: PROCESS_INTENT_PROOF,
        processCount: input.plan.processes.length,
      }),
    /invalid/u,
  );
  assert.throws(
    () => executionInternals.parseScopeProcess(null, input.plan.processes[0]!),
    /invalid/u,
  );
  assert.deepEqual(
    executionInternals.parseCompensationEnvelope(
      {} as JsonObject,
      input.plan,
      scopePreflightRaw(input).scope_id,
      'scope_read',
    ),
    [],
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        null,
        input.plan,
        scopePreflightRaw(input).scope_id,
        HASH('scope-proof'),
      ),
    /invalid/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: null,
        plan: input.plan,
        scopeId: scopePreflightRaw(input).scope_id,
        scopeProofSha256: HASH('scope-proof'),
        request: {},
      }),
    /invalid/u,
  );
  const incompleteStatus = scopeStatusRaw({ input, phase: 'pending' });
  assert.throws(
    () =>
      buildFlowIdentityFinalizeRequest({
        scopeProofSha256: HASH('scope-proof'),
        plan: input.plan,
        status: incompleteStatus as never,
      }),
    /exact completed database process ledger/u,
  );
});

test('execution proof parsers reject count, ledger, compensation, and terminal drift', () => {
  const input = executionScenario();
  const scopeId = scopePreflightRaw(input).scope_id;
  const scopeProof = HASH('scope-proof');
  assert.throws(
    () =>
      parseFlowIdentityScopePreflightProof(
        { ...scopePreflightRaw(input), process_count: 2 },
        input.plan,
      ),
    /counts/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityScopePreflightProof(
        { ...scopePreflightRaw(input), command: 'foreign' },
        input.plan,
      ),
    /does not bind/u,
  );

  const pendingLedger = scopeStatusRaw({ input, phase: 'pending' }).processes[0]!;
  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: scopeProof,
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const completedLedger = scopeStatusRaw({
    input,
    phase: 'primary',
    processRequestSha256: String(processRequest.process_request_sha256),
  }).processes[0]!;
  assert.throws(
    () =>
      executionInternals.parseScopeProcess(
        { ...pendingLedger, id: TARGET_ID },
        input.plan.processes[0]!,
      ),
    /does not match/u,
  );
  assert.throws(
    () =>
      executionInternals.parseScopeProcess(
        { ...completedLedger, derivative_request_id: null },
        input.plan.processes[0]!,
      ),
    /incomplete/u,
  );
  assert.throws(
    () =>
      executionInternals.parseScopeProcess(
        { ...pendingLedger, audit_id: 'unexpected' },
        input.plan.processes[0]!,
      ),
    /unexpectedly contains/u,
  );
  assert.throws(
    () =>
      executionInternals.parseScopeProcess(
        { ...pendingLedger, causal_terminal_proof: true },
        input.plan.processes[0]!,
      ),
    /terminal causal proof/u,
  );

  assert.throws(
    () =>
      executionInternals.parseCompensationEnvelope(
        { compensation_required: 'yes' } as JsonObject,
        input.plan,
        scopeId,
        'scope_read',
      ),
    /must be boolean/u,
  );
  assert.throws(
    () =>
      executionInternals.parseCompensationEnvelope(
        { compensation_required: false, compensation_targets: [{}] } as JsonObject,
        input.plan,
        scopeId,
        'scope_read',
      ),
    /malformed/u,
  );
  assert.throws(
    () =>
      executionInternals.parseCompensationEnvelope(
        {
          status: 'derivatives_pending',
          code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
          compensation_required: true,
          automatic_retry: false,
          compensation_targets: [null],
        } as unknown as JsonObject,
        input.plan,
        scopeId,
        'scope_read',
      ),
    /target is invalid/u,
  );

  const invalidCountStatus = scopeStatusRaw({ input, phase: 'pending' });
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...invalidCountStatus, pending_process_count: 0 },
        input.plan,
        scopeId,
        scopeProof,
      ),
    /counts/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...invalidCountStatus, terminal_proof_sha256: HASH('unexpected') },
        input.plan,
        scopeId,
        scopeProof,
      ),
    /terminal proof/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...invalidCountStatus, processes: [...invalidCountStatus.processes, pendingLedger] },
        input.plan,
        scopeId,
        scopeProof,
      ),
    /foreign process/u,
  );

  const primaryStatus = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'primary',
      processRequestSha256: String(processRequest.process_request_sha256),
    }),
    input.plan,
    scopeId,
    scopeProof,
  );
  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: scopeProof,
    plan: input.plan,
    status: primaryStatus,
  });
  const expected = finalizeRequest.expected as JsonObject;
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: {
          ...completedFinalizeRaw({ input, expected }),
          command: 'foreign',
        },
        plan: input.plan,
        scopeId,
        scopeProofSha256: scopeProof,
        request: finalizeRequest,
      }),
    /exact expected closure/u,
  );
});

test('serial runner waits for derivative readiness before its only finalize POST', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-'));
  try {
    const input = materializeExecutionScenario(root);
    const outDir = path.join(root, 'run');
    let reads = 0;
    let rewrites = 0;
    let finalizeCalls = 0;
    let requestSha = '';
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }).identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 1,
        pollMs: 100,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async ({ request }) => {
          rewrites += 1;
          requestSha = String(request.process_request_sha256);
          const process = input.plan.processes[0]!;
          return processEnvelope({
            ok: true,
            command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
            schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
            scope_id: scopePreflightRaw(input).scope_id,
            receipt_id: input.plan.receipt_id,
            receipt_proof_sha256: input.plan.receipt_proof_sha256,
            mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
            process_intent_set_sha256: input.plan.process_intent_set_sha256,
            invocation_id: WRAPPER_INVOCATION_ID,
            permit_generation_before: 0,
            ordinal: 1,
            process_id: process.id,
            process_version: process.version,
            process_request_sha256: requestSha,
            process_intent_proof_sha256: PROCESS_INTENT_PROOF,
            desired_payload_sha256: process.desired_payload_sha256,
            desired_exchange_set_sha256: process.desired_exchange_set_sha256,
            completed_process_count: 1,
            next_ordinal: null,
            primary_complete: true,
            before_payload_sha256: process.before_payload_sha256,
            before_exchange_set_sha256: process.before_exchange_set_sha256,
            after_payload_sha256: process.desired_payload_sha256,
            after_exchange_set_sha256: process.desired_exchange_set_sha256,
            rewrite_count: 1,
            audit_id: 'audit-1',
            derivative_batch_id: '99999999-9999-4999-8999-999999999999',
            status: 'completed',
            replay: false,
          });
        },
        read: async () => {
          reads += 1;
          if (reads === 1) return scopeStatusRaw({ input, phase: 'pending' });
          if (reads === 2) {
            return scopeStatusRaw({ input, phase: 'primary', processRequestSha256: requestSha });
          }
          if (reads === 3) {
            return readyToFinalizeScopeStatusRaw({
              input,
              processRequestSha256: requestSha,
            });
          }
          return scopeStatusRaw({ input, phase: 'completed', processRequestSha256: requestSha });
        },
        finalize: async ({ request }) => {
          finalizeCalls += 1;
          const expected = request.expected as JsonObject;
          return finalizeEnvelope(
            completedFinalizeRaw({ input, expected, permitGenerationBefore: 1 }),
            null,
          );
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      },
    );
    assert.equal(report.status, 'passed');
    assert.equal(rewrites, 1);
    assert.equal(finalizeCalls, 1);
    assert.equal(reads, 4);
    assert.equal(existsSync(path.join(outDir, 'scope-preflight-proof.json')), true);
    assert.equal(existsSync(path.join(outDir, 'process-attempt-000001.json')), true);
    assert.equal(existsSync(path.join(outDir, 'process-proof-000001.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner resumes from a lookup proof and rotates its permit through process and finalize', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-run-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const outDir = path.join(root, 'recovery-run');
    let reads = 0;
    let recoverCalls = 0;
    let rewriteCalls = 0;
    let finalizeCalls = 0;
    let processRequestSha256 = '';
    let claimedApprovalIdentity = '';
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        recoveryFreezePath: input.recoveryFreezePath,
        recoveryApprovalPath: input.recoveryApprovalPath,
        recoveryRunDir: input.recoveryRunDir,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 1,
        pollMs: 100,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => {
          throw new Error('recovery must not replay preflight');
        },
        recover: async ({ scopeId, request }) => {
          recoverCalls += 1;
          assert.equal(scopeId, input.recoveryFreeze.scope_id);
          assert.equal(
            request.recovery_approval_identity_sha256,
            input.recoveryApproval.recovery_approval_identity_sha256,
          );
          return recoveryEnvelope({ input, request });
        },
        rewrite: async ({ authorization, request }) => {
          rewriteCalls += 1;
          assert.deepEqual(authorization, executionPermit(0));
          processRequestSha256 = String(request.process_request_sha256);
          return completedProcessRewriteEnvelope({ input, processRequestSha256 });
        },
        read: async () => {
          reads += 1;
          if (reads <= 2) return scopeStatusRaw({ input, phase: 'pending' });
          if (reads === 3) {
            return scopeStatusRaw({
              input,
              phase: 'primary',
              processRequestSha256,
            });
          }
          if (reads === 4) {
            return readyToFinalizeScopeStatusRaw({ input, processRequestSha256 });
          }
          return scopeStatusRaw({ input, phase: 'completed', processRequestSha256 });
        },
        finalize: async ({ authorization, request }) => {
          finalizeCalls += 1;
          assert.deepEqual(authorization, executionPermit(1));
          return finalizeEnvelope(
            completedFinalizeRaw({
              input,
              expected: request.expected as JsonObject,
              permitGenerationBefore: 1,
            }),
            null,
          );
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
        claimApproval: ({ claim }) => {
          assert.equal(claim.approval_kind, 'recovery');
          claimedApprovalIdentity = claim.approval_identity_sha256;
          return path.join(root, 'approval-claim.json');
        },
      },
    );
    assert.equal(report.status, 'passed');
    assert.equal(recoverCalls, 1);
    assert.equal(rewriteCalls, 1);
    assert.equal(finalizeCalls, 1);
    assert.equal(reads, 5);
    assert.equal(claimedApprovalIdentity, input.recoveryApproval.recovery_approval_identity_sha256);
    assert.equal(existsSync(path.join(outDir, 'scope-lookup-proof.json')), true);
    assert.equal(existsSync(path.join(outDir, 'scope-preflight-proof.json')), false);
    assert.equal(
      (JSON.parse(readFileSync(path.join(outDir, 'scope-lookup-proof.json'), 'utf8')) as JsonObject)
        .schema_version,
      'dataset-flow-identity-scope-lookup-result.v1',
    );
    for (const name of readdirSync(outDir).filter((entry) => entry.endsWith('.json'))) {
      const text = readFileSync(path.join(outDir, name), 'utf8');
      assert.equal(text.includes(String(executionPermit(0).token)), false, name);
      assert.equal(text.includes(String(executionPermit(1).token)), false, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner treats a replay without a permit as read-only and blocked', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-replay-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const outDir = path.join(root, 'recovery-run');
    let reads = 0;
    let recoverCalls = 0;
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        recoveryFreezePath: input.recoveryFreezePath,
        recoveryApprovalPath: input.recoveryApprovalPath,
        recoveryRunDir: input.recoveryRunDir,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 0,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => {
          throw new Error('must not preflight');
        },
        recover: async ({ request }) => {
          recoverCalls += 1;
          return recoveryEnvelope({ input, request, replay: true });
        },
        rewrite: async () => {
          throw new Error('replay must not rewrite');
        },
        read: async () => {
          reads += 1;
          return scopeStatusRaw({ input, phase: 'pending' });
        },
        finalize: async () => {
          throw new Error('replay must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      },
    );
    assert.equal(report.status, 'blocked');
    assert.equal(report.issues[0]?.code, 'DATASET_FLOW_IDENTITY_FRESH_RECOVERY_APPROVAL_REQUIRED');
    assert.equal(recoverCalls, 1);
    assert.equal(reads, 2);
    assert.equal(existsSync(path.join(outDir, 'scope-lookup-proof.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner records deterministic admission rejection without process writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-reject-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const outDir = path.join(root, 'recovery-run');
    let reads = 0;
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        recoveryFreezePath: input.recoveryFreezePath,
        recoveryApprovalPath: input.recoveryApprovalPath,
        recoveryRunDir: input.recoveryRunDir,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
        confirm: input.plan.account.email,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => {
          throw new Error('must not preflight');
        },
        recover: async () => ({
          ok: false,
          code: 'FLOW_IDENTITY_RECOVERY_BASELINE_REJECTED',
          status: 409,
          message: 'live baseline no longer matches',
        }),
        rewrite: async () => {
          throw new Error('rejected recovery must not rewrite');
        },
        read: async () => {
          reads += 1;
          return scopeStatusRaw({ input, phase: 'pending' });
        },
        finalize: async () => {
          throw new Error('rejected recovery must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      },
    );
    assert.equal(report.status, 'blocked');
    assert.equal(report.issues[0]?.code, 'FLOW_IDENTITY_RECOVERY_BASELINE_REJECTED');
    assert.equal(reads, 1);
    assert.equal(existsSync(path.join(outDir, 'scope-recovery-domain-rejection.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner makes one read after an ambiguous admission response and never continues', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-transport-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const outDir = path.join(root, 'recovery-run');
    let reads = 0;
    let recoverCalls = 0;
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        recoveryFreezePath: input.recoveryFreezePath,
        recoveryApprovalPath: input.recoveryApprovalPath,
        recoveryRunDir: input.recoveryRunDir,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
        confirm: input.plan.account.email,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => {
          throw new Error('must not preflight');
        },
        recover: async () => {
          recoverCalls += 1;
          throw new Error('connection lost after recovery admission POST');
        },
        rewrite: async () => {
          throw new Error('ambiguous recovery must not rewrite');
        },
        read: async () => {
          reads += 1;
          return scopeStatusRaw({ input, phase: 'pending' });
        },
        finalize: async () => {
          throw new Error('ambiguous recovery must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      },
    );
    assert.equal(report.status, 'indeterminate');
    assert.equal(report.issues[0]?.code, 'DATASET_FLOW_IDENTITY_RECOVERY_RESPONSE_AMBIGUOUS');
    assert.equal(recoverCalls, 1);
    assert.equal(reads, 2);
    assert.equal(existsSync(path.join(outDir, 'scope-recovery-transport-error.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner fails closed before an attempt when the recovery dependency is absent', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-missing-rpc-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const outDir = path.join(root, 'recovery-run');
    await assert.rejects(
      runInternals.executeRun(
        {
          planPath: input.planPath,
          freezePath: input.freezePath,
          approvalPath: input.approvalPath,
          recoveryFreezePath: input.recoveryFreezePath,
          recoveryApprovalPath: input.recoveryApprovalPath,
          recoveryRunDir: input.recoveryRunDir,
          outDir,
          commit: true,
          statusOnly: false,
          approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
          confirm: input.plan.account.email,
          env: {},
          fetchImpl: async () => {
            throw new Error('unused');
          },
        },
        {
          resolveContext: async ({ fetchImpl }) => ({
            project_ref: input.plan.project_ref,
            rest_base_url: 'https://example.test/rest/v1',
            publishable_key: 'key',
            access_token: 'token',
            account: { ...input.plan.account, session_source: 'test' },
            fetch_impl: fetchImpl,
            timeout_ms: 1_000,
          }),
          preflight: async () => {
            throw new Error('must not preflight');
          },
          rewrite: async () => {
            throw new Error('must not rewrite');
          },
          read: async () => scopeStatusRaw({ input, phase: 'pending' }),
          finalize: async () => {
            throw new Error('must not finalize');
          },
          sleep: async () => undefined,
          now: () => new Date('2026-07-16T05:30:00.000Z'),
        },
      ),
      /Recovery RPC dependency is unavailable/u,
    );
    assert.equal(existsSync(path.join(outDir, 'scope-recovery-attempt.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery preparation rejects validly hashed artifacts that do not bind the original execution', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-binding-'));
  try {
    const input = materializeRecoveryExecutionScenario(root);
    const recoveryFreeze: FlowIdentityRecoveryFreeze = {
      ...input.recoveryFreeze,
      operation_id: 'foreign-operation',
      recovery_freeze_sha256: '',
    };
    recoveryFreeze.recovery_freeze_sha256 = computeFlowIdentityRecoveryFreezeSha256(recoveryFreeze);
    const recoveryApproval: FlowIdentityRecoveryApproval = {
      ...input.recoveryApproval,
      recovery_freeze_sha256: recoveryFreeze.recovery_freeze_sha256,
      recovery_approval_identity_sha256: '',
    };
    recoveryApproval.recovery_approval_identity_sha256 =
      computeFlowIdentityRecoveryApprovalIdentitySha256(recoveryApproval);
    assert.throws(
      () =>
        prepareFlowIdentityRecoveryExecution({
          plan: input.plan,
          originalFreeze: input.freeze,
          originalApproval: input.approval,
          scope: input.scope,
          recoveryFreeze,
          recoveryApproval,
        }),
      /do not bind the original immutable execution/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner preparation rejects partial recovery inputs and invalid consumed claims', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-preparation-'));
  try {
    const recoveryInput = materializeRecoveryExecutionScenario(path.join(root, 'recovery'));
    const recoveryCommand = {
      planPath: recoveryInput.planPath,
      freezePath: recoveryInput.freezePath,
      approvalPath: recoveryInput.approvalPath,
      outDir: path.join(root, 'recovery-run'),
      commit: true,
      statusOnly: false,
      approveExecution: recoveryInput.recoveryApproval.recovery_approval_identity_sha256,
      confirm: recoveryInput.plan.account.email,
      env: {},
      fetchImpl: (async () => {
        throw new Error('unused');
      }) as FetchLike,
    };
    assert.throws(
      () =>
        runInternals.prepareRun({
          ...recoveryCommand,
          recoveryFreezePath: recoveryInput.recoveryFreezePath,
        }),
      /requires recoveryFreezePath, recoveryApprovalPath, and recoveryRunDir together/u,
    );
    assert.throws(
      () =>
        runInternals.prepareRun({
          ...recoveryCommand,
          recoveryFreezePath: recoveryInput.recoveryFreezePath,
          recoveryApprovalPath: recoveryInput.recoveryApprovalPath,
          recoveryRunDir: path.join(root, 'missing-recovery-scope'),
        }),
      /requires an exact preflight or read-only lookup scope proof/u,
    );

    const input = materializeExecutionScenario(path.join(root, 'initial'));
    const identity = buildFlowIdentityExecutionIdentity({
      plan: input.plan,
      freeze: input.freeze,
      approval: input.approval,
    });
    const statusCommand = {
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      outDir: path.join(root, 'ignored-status-run'),
      commit: false,
      statusOnly: true,
      env: {},
      fetchImpl: (async () => {
        throw new Error('unused');
      }) as FetchLike,
    };
    const approvalClaim = (canonicalOutDir: string, projectRef = input.plan.project_ref) => ({
      schema_version: 'dataset-flow-identity-local-approval-claim.v1' as const,
      claimed_at_utc: '2026-07-16T05:30:00.000Z',
      approval_kind: 'initial' as const,
      approval_identity_sha256: input.approval.execution_approval_identity_sha256,
      execution_identity_sha256: identity.identity_sha256,
      request_id: identity.request_id,
      environment: 'production' as const,
      project_ref: projectRef,
      actor_user_id: input.plan.account.user_id,
      actor_email: input.plan.account.email,
      target_visibility: 'owner_draft' as const,
      user_state_claim: 'authenticated_actor_state_100_plus_own_state_0' as const,
      plan_sha256: input.plan.plan_sha256,
      freeze_sha256: input.freeze.freeze_sha256,
      canonical_out_dir: canonicalOutDir,
      maximum_cli_apply_spawns: 1 as const,
      approval_reusable: false as const,
    });

    const missingXdg = path.join(root, 'missing-claim-state');
    claimFlowIdentityApproval({
      claim: approvalClaim(path.join(root, 'missing-canonical-run')),
      env: {},
      stateRoot: path.join(missingXdg, 'tiangong-lca-cli'),
    });
    assert.throws(
      () =>
        runInternals.prepareRun({
          ...statusCommand,
          env: { XDG_STATE_HOME: missingXdg },
        }),
      /points to a missing canonical run directory/u,
    );

    const mismatchXdg = path.join(root, 'mismatch-claim-state');
    const canonicalRun = path.join(root, 'canonical-run');
    writePrivateImmutableJson(path.join(canonicalRun, 'marker.json'), { ok: true });
    claimFlowIdentityApproval({
      claim: approvalClaim(canonicalRun, 'foreign-project'),
      env: {},
      stateRoot: path.join(mismatchXdg, 'tiangong-lca-cli'),
    });
    assert.throws(
      () =>
        runInternals.prepareRun({
          ...statusCommand,
          env: { XDG_STATE_HOME: mismatchXdg },
        }),
      /does not bind this immutable execution/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects bearer permits on domain failures and keeps recovery ambiguity read-only', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-domain-permit-'));
  try {
    const contextFor = (input: ReturnType<typeof executionScenario>, fetchImpl: FetchLike) => ({
      project_ref: input.plan.project_ref,
      rest_base_url: 'https://example.test/rest/v1',
      publishable_key: 'key',
      access_token: 'token',
      account: { ...input.plan.account, session_source: 'test' as const },
      fetch_impl: fetchImpl,
      timeout_ms: 1_000,
    });
    const recoveryCommandFor = (
      input: ReturnType<typeof materializeRecoveryExecutionScenario>,
    ) => ({
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      recoveryFreezePath: input.recoveryFreezePath,
      recoveryApprovalPath: input.recoveryApprovalPath,
      recoveryRunDir: input.recoveryRunDir,
      outDir: path.join(path.dirname(input.recoveryFreezePath), 'run'),
      commit: true,
      statusOnly: false,
      approveExecution: input.recoveryApproval.recovery_approval_identity_sha256,
      confirm: input.plan.account.email,
      env: {},
      fetchImpl: (async () => {
        throw new Error('unused');
      }) as FetchLike,
    });
    const recoveryDependencies = (
      input: ReturnType<typeof materializeRecoveryExecutionScenario>,
      overrides: Record<string, unknown>,
    ) => ({
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(input, fetchImpl),
      preflight: async () => {
        throw new Error('must not preflight');
      },
      rewrite: async () => {
        throw new Error('must not rewrite');
      },
      read: async () => scopeStatusRaw({ input, phase: 'pending' }),
      finalize: async () => {
        throw new Error('must not finalize');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:30:00.000Z'),
      ...overrides,
    });

    const baselinePermitInput = materializeRecoveryExecutionScenario(
      path.join(root, 'baseline-permit'),
    );
    await assert.rejects(
      runInternals.executeRun(
        recoveryCommandFor(baselinePermitInput),
        recoveryDependencies(baselinePermitInput, {
          recover: async () => {
            throw new Error('must not recover');
          },
          read: async () => ({
            ok: false,
            code: 'FLOW_IDENTITY_BASELINE_REJECTED',
            status: 409,
            execution_permit: executionPermit(0),
          }),
        }) as never,
      ),
      /unexpectedly contained a bearer permit/u,
    );

    const recoveryPermitInput = materializeRecoveryExecutionScenario(
      path.join(root, 'recovery-permit'),
    );
    await assert.rejects(
      runInternals.executeRun(
        recoveryCommandFor(recoveryPermitInput),
        recoveryDependencies(recoveryPermitInput, {
          recover: async () => ({
            ok: false,
            code: 'FLOW_IDENTITY_RECOVERY_REJECTED',
            status: 409,
            execution_permit: executionPermit(0),
          }),
        }) as never,
      ),
      /unexpectedly contained a bearer permit/u,
    );

    const ambiguousInput = materializeRecoveryExecutionScenario(
      path.join(root, 'ambiguous-read-domain'),
    );
    let ambiguityReads = 0;
    const ambiguous = await runInternals.executeRun(
      recoveryCommandFor(ambiguousInput),
      recoveryDependencies(ambiguousInput, {
        recover: async () => {
          throw new Error('recovery response lost');
        },
        read: async () => {
          ambiguityReads += 1;
          return ambiguityReads === 1
            ? scopeStatusRaw({ input: ambiguousInput, phase: 'pending' })
            : {
                ok: false,
                code: 'FLOW_IDENTITY_SCOPE_READ_REJECTED',
                status: 409,
              };
        },
      }) as never,
    );
    assert.equal(ambiguous.status, 'indeterminate');
    assert.equal(ambiguous.database_status, null);
    assert.equal(ambiguityReads, 2);

    const initialInput = materializeExecutionScenario(path.join(root, 'preflight-permit'));
    const initialCommand = {
      planPath: initialInput.planPath,
      freezePath: initialInput.freezePath,
      approvalPath: initialInput.approvalPath,
      outDir: path.join(root, 'preflight-permit-run'),
      commit: true,
      statusOnly: false,
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: initialInput.plan,
        freeze: initialInput.freeze,
        approval: initialInput.approval,
      }).identity_sha256,
      confirm: initialInput.plan.account.email,
      env: {},
      fetchImpl: (async () => {
        throw new Error('unused');
      }) as FetchLike,
    };
    await assert.rejects(
      runInternals.executeRun(initialCommand, {
        resolveContext: async ({ fetchImpl }) => contextFor(initialInput, fetchImpl),
        preflight: async () => ({
          ok: false,
          code: 'FLOW_IDENTITY_PREFLIGHT_REJECTED',
          status: 409,
          execution_permit: executionPermit(0),
        }),
        rewrite: async () => {
          throw new Error('must not rewrite');
        },
        read: async () => {
          throw new Error('must not read');
        },
        finalize: async () => {
          throw new Error('must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      }),
      /unexpectedly contained a bearer permit/u,
    );

    const lookupInput = materializeExecutionScenario(path.join(root, 'lookup-domain'));
    const lookupCommand = {
      ...initialCommand,
      planPath: lookupInput.planPath,
      freezePath: lookupInput.freezePath,
      approvalPath: lookupInput.approvalPath,
      outDir: path.join(root, 'lookup-domain-run'),
      commit: false,
      statusOnly: true,
      approveExecution: undefined,
      confirm: undefined,
    };
    const lookupPrepared = runInternals.prepareRun({
      ...lookupCommand,
      commit: true,
      statusOnly: false,
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: lookupInput.plan,
        freeze: lookupInput.freeze,
        approval: lookupInput.approval,
      }).identity_sha256,
      confirm: lookupInput.plan.account.email,
    });
    const lookupReport = await runInternals.executeRun(
      lookupCommand,
      {
        resolveContext: async ({ fetchImpl }) => contextFor(lookupInput, fetchImpl),
        preflight: async () => {
          throw new Error('must not preflight');
        },
        lookup: async () => ({
          ok: false,
          code: 'FLOW_IDENTITY_SCOPE_NOT_FOUND',
          status: 404,
        }),
        rewrite: async () => {
          throw new Error('must not rewrite');
        },
        read: async () => {
          throw new Error('must not read');
        },
        finalize: async () => {
          throw new Error('must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      },
      {
        ...lookupPrepared,
        approvalClaim: {
          schema_version: 'dataset-flow-identity-local-approval-claim.v1',
          claimed_at_utc: '2026-07-16T05:29:00.000Z',
          approval_kind: 'initial',
          approval_identity_sha256: lookupInput.approval.execution_approval_identity_sha256,
          execution_identity_sha256: lookupPrepared.identity.identity_sha256,
          request_id: lookupPrepared.identity.request_id,
          environment: 'production',
          project_ref: lookupInput.plan.project_ref,
          actor_user_id: lookupInput.plan.account.user_id,
          actor_email: lookupInput.plan.account.email,
          target_visibility: 'owner_draft',
          user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
          plan_sha256: lookupInput.plan.plan_sha256,
          freeze_sha256: lookupInput.freeze.freeze_sha256,
          canonical_out_dir: lookupPrepared.outDir,
          maximum_cli_apply_spawns: 1,
          approval_reusable: false,
        },
      },
    );
    assert.equal(lookupReport.status, 'blocked');

    const invalidLookupInput = materializeExecutionScenario(path.join(root, 'invalid-lookup'));
    const invalidLookupCommand = {
      ...initialCommand,
      planPath: invalidLookupInput.planPath,
      freezePath: invalidLookupInput.freezePath,
      approvalPath: invalidLookupInput.approvalPath,
      outDir: path.join(root, 'invalid-lookup-run'),
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: invalidLookupInput.plan,
        freeze: invalidLookupInput.freeze,
        approval: invalidLookupInput.approval,
      }).identity_sha256,
      confirm: invalidLookupInput.plan.account.email,
    };
    const invalidLookupPrepared = runInternals.prepareRun(invalidLookupCommand);
    writePrivateImmutableJson(path.join(invalidLookupPrepared.outDir, 'scope-lookup-proof.json'), {
      schema_version: 'dataset-flow-identity-scope-lookup-result.v1',
    });
    await assert.rejects(
      runInternals.executeRun(
        invalidLookupCommand,
        {
          resolveContext: async ({ fetchImpl }) => contextFor(invalidLookupInput, fetchImpl),
          preflight: async () => {
            throw new Error('must not preflight');
          },
          rewrite: async () => {
            throw new Error('must not rewrite');
          },
          read: async () => {
            throw new Error('must not read');
          },
          finalize: async () => {
            throw new Error('must not finalize');
          },
          sleep: async () => undefined,
          now: () => new Date('2026-07-16T05:30:00.000Z'),
        },
        invalidLookupPrepared,
      ),
      /keys do not match|does not bind/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial runner leaves pending derivatives read-only at a zero-second deadline', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-pending-'));
  try {
    const input = materializeExecutionScenario(root);
    const outDir = path.join(root, 'run');
    const processRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: 1,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    let finalizeCalls = 0;
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        outDir,
        commit: true,
        statusOnly: false,
        approveExecution: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }).identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 0,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          throw new Error('must not rewrite');
        },
        read: async () =>
          scopeStatusRaw({
            input,
            phase: 'primary',
            processRequestSha256: String(processRequest.process_request_sha256),
          }),
        finalize: async () => {
          finalizeCalls += 1;
          throw new Error('must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      },
    );
    assert.equal(report.status, 'pending');
    assert.equal(report.issues[0]?.code, 'FLOW_IDENTITY_DERIVATIVES_PENDING');
    assert.equal(finalizeCalls, 0);
    assert.equal(existsSync(path.join(outDir, 'finalize-attempt.000001.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial runner does not retry when a readiness race returns derivatives pending', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-finalize-race-'));
  try {
    const input = materializeExecutionScenario(root);
    const processRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: 1,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    let reads = 0;
    let finalizeCalls = 0;
    const report = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        outDir: path.join(root, 'run'),
        commit: true,
        statusOnly: false,
        approveExecution: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }).identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 60,
        pollMs: 100,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          throw new Error('must not rewrite');
        },
        read: async () => {
          reads += 1;
          return reads === 1
            ? readyToFinalizeScopeStatusRaw({
                input,
                processRequestSha256: String(processRequest.process_request_sha256),
              })
            : scopeStatusRaw({
                input,
                phase: 'primary',
                processRequestSha256: String(processRequest.process_request_sha256),
              });
        },
        finalize: async ({ request }) => {
          finalizeCalls += 1;
          return finalizeEnvelope(
            pendingFinalizeRaw({ input, expected: request.expected as JsonObject }),
            1,
          );
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      },
    );
    assert.equal(report.status, 'pending');
    assert.equal(finalizeCalls, 1);
    assert.equal(reads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial runner stops after an ambiguous process response and never auto-retries', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-ambiguous-'));
  try {
    const input = materializeExecutionScenario(root);
    const outDir = path.join(root, 'run');
    let rewriteCalls = 0;
    let preflightCalls = 0;
    const command = {
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      outDir,
      commit: true,
      statusOnly: false,
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: input.plan,
        freeze: input.freeze,
        approval: input.approval,
      }).identity_sha256,
      confirm: input.plan.account.email,
      waitSeconds: 0,
      env: {},
      fetchImpl: async () => {
        throw new Error('unused');
      },
    };
    const dependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) => ({
        project_ref: input.plan.project_ref,
        rest_base_url: 'https://example.test/rest/v1',
        publishable_key: 'key',
        access_token: 'token',
        account: { ...input.plan.account, session_source: 'test' },
        fetch_impl: fetchImpl,
        timeout_ms: 1_000,
      }),
      preflight: async () => {
        preflightCalls += 1;
        return scopePreflightEnvelope(input);
      },
      rewrite: async () => {
        rewriteCalls += 1;
        throw new Error('connection lost after POST');
      },
      read: async () => scopeStatusRaw({ input, phase: 'pending' }),
      finalize: async () => {
        throw new Error('must not finalize');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const first = await runInternals.executeRun(command, dependencies);
    assert.equal(first.status, 'indeterminate');
    assert.equal(rewriteCalls, 1);
    assert.equal(preflightCalls, 1);

    const second = await runInternals.executeRun(command, dependencies);
    assert.equal(second.status, 'blocked');
    assert.equal(rewriteCalls, 1);
    assert.equal(preflightCalls, 1);
    assert.match(second.issues[0]!.message, /fresh exact recovery freeze/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial runner treats an already completed scope as terminal without another finalize', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-completed-'));
  try {
    const input = materializeExecutionScenario(root);
    const processRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: input.process_templates[0]!.process.ordinal,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    let rewriteCalls = 0;
    let finalizeCalls = 0;
    let initialClaimCalls = 0;
    const result = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        outDir: path.join(root, 'run'),
        commit: true,
        statusOnly: false,
        approveExecution: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }).identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 0,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          rewriteCalls += 1;
          throw new Error('must not rewrite');
        },
        read: async () =>
          scopeStatusRaw({
            input,
            phase: 'completed',
            processRequestSha256: String(processRequest.process_request_sha256),
          }),
        finalize: async () => {
          finalizeCalls += 1;
          throw new Error('must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
        claimApproval: ({ claim }) => {
          initialClaimCalls += 1;
          assert.equal(claim.approval_kind, 'initial');
          assert.equal(
            claim.approval_identity_sha256,
            input.approval.execution_approval_identity_sha256,
          );
          return path.join(root, 'initial-claim.json');
        },
      },
    );
    assert.equal(result.status, 'passed');
    assert.equal(rewriteCalls, 0);
    assert.equal(finalizeCalls, 0);
    assert.equal(initialClaimCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serial runner blocks protected-closure drift before the next process submission', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-closure-drift-'));
  try {
    const input = materializeExecutionScenario(root);
    let rewriteCalls = 0;
    let finalizeCalls = 0;
    const result = await runInternals.executeRun(
      {
        planPath: input.planPath,
        freezePath: input.freezePath,
        approvalPath: input.approvalPath,
        outDir: path.join(root, 'run'),
        commit: true,
        statusOnly: false,
        approveExecution: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }).identity_sha256,
        confirm: input.plan.account.email,
        waitSeconds: 0,
        env: {},
        fetchImpl: async () => {
          throw new Error('unused');
        },
      },
      {
        resolveContext: async ({ fetchImpl }) => ({
          project_ref: input.plan.project_ref,
          rest_base_url: 'https://example.test/rest/v1',
          publishable_key: 'key',
          access_token: 'token',
          account: { ...input.plan.account, session_source: 'test' },
          fetch_impl: fetchImpl,
          timeout_ms: 1_000,
        }),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          rewriteCalls += 1;
          throw new Error('must not rewrite');
        },
        read: async () => guardOnlyLiveDriftStatusRaw({ input, phase: 'pending' }),
        finalize: async () => {
          finalizeCalls += 1;
          throw new Error('must not finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      },
    );
    assert.equal(result.status, 'blocked');
    assert.equal(result.issues[0]?.code, 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT');
    assert.equal(rewriteCalls, 0);
    assert.equal(finalizeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner helper guards cover artifacts, context, durable proof, timing, and public lock entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-guards-'));
  try {
    const input = materializeExecutionScenario(root);
    const baseCommand = {
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      outDir: path.join(root, 'run'),
      commit: true,
      statusOnly: false,
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: input.plan,
        freeze: input.freeze,
        approval: input.approval,
      }).identity_sha256,
      confirm: input.plan.account.email,
      waitSeconds: 0,
      env: {},
      fetchImpl: async () => {
        throw new Error('unused');
      },
    };
    assert.throws(
      () => runInternals.prepareRun({ ...baseCommand, commit: false, statusOnly: false }),
      /exactly one/u,
    );
    assert.throws(
      () => runInternals.prepareRun({ ...baseCommand, approveExecution: 'bad' }),
      /exact execution identity/u,
    );
    const prepared = runInternals.prepareRun(baseCommand);
    const context = {
      project_ref: input.plan.project_ref,
      rest_base_url: 'https://example.test/rest/v1',
      publishable_key: 'key',
      access_token: 'token',
      account: { ...input.plan.account, session_source: 'test' as const },
      fetch_impl: baseCommand.fetchImpl,
      timeout_ms: 1_000,
    };
    assert.throws(
      () => runInternals.assertContext(prepared, { ...context, project_ref: 'foreign' }),
      /does not match/u,
    );
    assert.deepEqual(runInternals.errorDetails('plain failure'), {
      name: 'Error',
      message: 'plain failure',
      code: null,
    });
    const codedError = Object.assign(new Error('coded'), { code: 'E_CODE' });
    assert.equal(runInternals.errorDetails(codedError).code, 'E_CODE');

    const nonCanonicalPath = path.join(root, 'noncanonical-run.json');
    writePrivateImmutableText(nonCanonicalPath, `${JSON.stringify(input.plan, null, 2)}\n`);
    assert.throws(
      () => runInternals.readCanonicalJson(nonCanonicalPath, 'plan'),
      /canonical JSON/u,
    );
    const numberedDir = path.join(root, 'numbered');
    const firstNumbered = runInternals.numberedArtifact(numberedDir, 'proof');
    writePrivateImmutableJson(firstNumbered, {});
    assert.match(runInternals.numberedArtifact(numberedDir, 'proof'), /000002/u);

    const request = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: input.process_templates[0]!.process.ordinal,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    const completed = parseFlowIdentityScopeStatus(
      scopeStatusRaw({
        input,
        phase: 'completed',
        processRequestSha256: String(request.process_request_sha256),
      }),
      input.plan,
      scopePreflightRaw(input).scope_id,
      HASH('scope-proof'),
    );
    runInternals.validateCompletedRequests(prepared, completed);
    assert.throws(
      () =>
        runInternals.validateCompletedRequests(prepared, {
          ...completed,
          processes: [{ ...completed.processes[0]!, process_request_sha256: HASH('foreign') }],
        }),
      /foreign request hash/u,
    );
    assert.throws(
      () =>
        runInternals.validateCompletedRequests(prepared, {
          ...completed,
          processes: [{ ...completed.processes[0]!, ordinal: 2 }],
        }),
      /foreign completed ordinal/u,
    );

    const nullReport = runInternals.report({
      prepared,
      mode: 'status_only',
      status: 'pending',
      scope: null,
      database: null,
      now: new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(nullReport.scope_id, null);
    assert.equal(nullReport.completed_process_count, 0);

    const scope = parseFlowIdentityScopePreflightProof(scopePreflightRaw(input), input.plan);
    const pending = parseFlowIdentityScopeStatus(
      scopeStatusRaw({ input, phase: 'pending' }),
      input.plan,
      scope.scope_id,
      scope.scope_proof_sha256,
    );
    const dependencies = {
      resolveContext: async () => context,
      preflight: async () => scopePreflightEnvelope(input),
      rewrite: async () => ({}),
      read: async () => scopeStatusRaw({ input, phase: 'pending' }),
      finalize: async () => ({}),
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    await assert.rejects(
      runInternals.waitForFinalizeDecision({
        command: { ...baseCommand, waitSeconds: -1 },
        prepared,
        context,
        scope,
        initial: pending,
        dependencies,
      }),
      /waitSeconds/u,
    );
    await assert.rejects(
      runInternals.waitForFinalizeDecision({
        command: { ...baseCommand, pollMs: 99 },
        prepared,
        context,
        scope,
        initial: pending,
        dependencies,
      }),
      /pollMs/u,
    );
    await assert.rejects(
      runFlowIdentity({
        ...baseCommand,
        outDir: path.join(root, 'public-entry'),
        commit: false,
        statusOnly: false,
      }),
      /exactly one/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner status-only, failed, post-rewrite drift, and transport recovery paths stay read-led', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-paths-'));
  try {
    const materialize = (name: string) => materializeExecutionScenario(path.join(root, name));
    const commandFor = (
      input: ReturnType<typeof materializeExecutionScenario>,
      statusOnly = false,
    ) => ({
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      outDir: path.join(path.dirname(input.planPath), 'run'),
      commit: !statusOnly,
      statusOnly,
      approveExecution: buildFlowIdentityExecutionIdentity({
        plan: input.plan,
        freeze: input.freeze,
        approval: input.approval,
      }).identity_sha256,
      confirm: input.plan.account.email,
      waitSeconds: statusOnly ? 1 : 0,
      pollMs: 100,
      env: {},
      fetchImpl: async () => {
        throw new Error('unused');
      },
    });
    const contextFor = (
      input: ReturnType<typeof materializeExecutionScenario>,
      fetchImpl: FetchLike,
    ) => ({
      project_ref: input.plan.project_ref,
      rest_base_url: 'https://example.test/rest/v1',
      publishable_key: 'key',
      access_token: 'token',
      account: { ...input.plan.account, session_source: 'test' as const },
      fetch_impl: fetchImpl,
      timeout_ms: 1_000,
    });

    const missingScope = materialize('missing-scope');
    await assert.rejects(
      runInternals.executeRun(commandFor(missingScope, true), {
        resolveContext: async ({ fetchImpl }) => contextFor(missingScope, fetchImpl),
        preflight: async () => {
          throw new Error('must not preflight');
        },
        rewrite: async () => ({}),
        read: async () => ({}),
        finalize: async () => ({}),
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      }),
      /immutable local scope proof/u,
    );

    const statusInput = materialize('status-only');
    const statusCommand = commandFor(statusInput, true);
    writePrivateImmutableJson(
      path.join(statusCommand.outDir, 'scope-preflight-proof.json'),
      scopePreflightRaw(statusInput),
    );
    const statusRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: statusInput.process_templates[0]!.process.ordinal,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    let statusReads = 0;
    const statusReport = await runInternals.executeRun(statusCommand, {
      resolveContext: async ({ fetchImpl }) => contextFor(statusInput, fetchImpl),
      preflight: async () => {
        throw new Error('must not preflight');
      },
      rewrite: async () => {
        throw new Error('must not rewrite');
      },
      read: async () => {
        statusReads += 1;
        return statusReads === 1
          ? scopeStatusRaw({ input: statusInput, phase: 'pending' })
          : scopeStatusRaw({
              input: statusInput,
              phase: 'completed',
              processRequestSha256: String(statusRequest.process_request_sha256),
            });
      },
      finalize: async () => {
        throw new Error('must not finalize');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(statusReport.status, 'passed');

    const failedInput = materialize('failed');
    const failedRaw = scopeStatusRaw({ input: failedInput, phase: 'pending' });
    const failedStatus = {
      ...failedRaw,
      ok: false,
      status: 'failed',
      pending_process_count: 0,
      failed_process_count: 1,
      next_ordinal: 2,
      cancellable: false,
      processes: [{ ...failedRaw.processes[0]!, status: 'failed', last_error: { code: 'FAILED' } }],
    };
    let failedFinalizeCalls = 0;
    const failedReport = await runInternals.executeRun(commandFor(failedInput), {
      resolveContext: async ({ fetchImpl }) => contextFor(failedInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(failedInput),
      rewrite: async () => ({}),
      read: async () => failedStatus,
      finalize: async () => {
        failedFinalizeCalls += 1;
        return {};
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(failedReport.status, 'failed');
    assert.equal(failedFinalizeCalls, 0);

    const driftInput = materialize('post-rewrite-drift');
    let driftReads = 0;
    let driftRequestSha = '';
    let driftFinalizeCalls = 0;
    const driftReport = await runInternals.executeRun(commandFor(driftInput), {
      resolveContext: async ({ fetchImpl }) => contextFor(driftInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(driftInput),
      rewrite: async ({ request }) => {
        driftRequestSha = String(request.process_request_sha256);
        const process = driftInput.plan.processes[0]!;
        return processEnvelope({
          ok: true,
          command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
          schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
          scope_id: scopePreflightRaw(driftInput).scope_id,
          receipt_id: driftInput.plan.receipt_id,
          receipt_proof_sha256: driftInput.plan.receipt_proof_sha256,
          mapping_guard_set_sha256: driftInput.plan.mapping_guard_set_sha256,
          process_intent_set_sha256: driftInput.plan.process_intent_set_sha256,
          invocation_id: WRAPPER_INVOCATION_ID,
          permit_generation_before: 0,
          ordinal: 1,
          process_id: process.id,
          process_version: process.version,
          process_request_sha256: driftRequestSha,
          process_intent_proof_sha256: PROCESS_INTENT_PROOF,
          desired_payload_sha256: process.desired_payload_sha256,
          desired_exchange_set_sha256: process.desired_exchange_set_sha256,
          completed_process_count: 1,
          next_ordinal: null,
          primary_complete: true,
          before_payload_sha256: process.before_payload_sha256,
          before_exchange_set_sha256: process.before_exchange_set_sha256,
          after_payload_sha256: process.desired_payload_sha256,
          after_exchange_set_sha256: process.desired_exchange_set_sha256,
          rewrite_count: 1,
          audit_id: 'audit-1',
          derivative_batch_id: '99999999-9999-4999-8999-999999999999',
          status: 'completed',
          replay: false,
        });
      },
      read: async () => {
        driftReads += 1;
        return driftReads === 1
          ? scopeStatusRaw({ input: driftInput, phase: 'pending' })
          : guardOnlyLiveDriftStatusRaw({
              input: driftInput,
              phase: 'primary',
              processRequestSha256: driftRequestSha,
            });
      },
      finalize: async () => {
        driftFinalizeCalls += 1;
        return {};
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(driftReport.status, 'blocked');
    assert.equal(driftFinalizeCalls, 0);

    for (const phase of ['process', 'finalize'] as const) {
      const transportInput = materialize(`transport-${phase}`);
      const transportCommand = commandFor(transportInput);
      let reads = 0;
      const request = buildFlowIdentityProcessRequest({
        scopeProofSha256: HASH('scope-proof'),
        ordinal: transportInput.process_templates[0]!.process.ordinal,
        processIntentProofSha256: PROCESS_INTENT_PROOF,
      });
      const transportReport = await runInternals.executeRun(transportCommand, {
        resolveContext: async ({ fetchImpl }) => contextFor(transportInput, fetchImpl),
        preflight: async () => scopePreflightEnvelope(transportInput),
        rewrite: async () => {
          if (phase === 'process') throw new Error('rewrite transport lost');
          return {};
        },
        read: async () => {
          reads += 1;
          if (reads > 1) throw new Error('recovery read lost');
          return phase === 'process'
            ? scopeStatusRaw({ input: transportInput, phase: 'pending' })
            : readyToFinalizeScopeStatusRaw({
                input: transportInput,
                processRequestSha256: String(request.process_request_sha256),
              });
        },
        finalize: async () => {
          throw new Error('finalize transport lost');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      });
      assert.equal(transportReport.status, 'indeterminate');
      assert.equal(transportReport.database_status, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independent verifier proves exact rows, zero approved residue, protected closure, and terminal derivatives', () => {
  const input = executionScenario();
  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const status = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'completed',
      processRequestSha256: String(processRequest.process_request_sha256),
    }),
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const originalProcess = input.capture.process_rows[0]!;
  const desiredProcess: DatasetMaintenanceRemoteRow = {
    ...remoteFromSnapshot(originalProcess),
    json: input.process_templates[0]!.desired_payload,
    json_ordered: input.process_templates[0]!.desired_payload,
  };
  const passed = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status,
    currentStableRows: [
      ...input.capture.source_rows,
      ...input.capture.target_rows,
      ...input.capture.support_rows,
    ].map(remoteFromSnapshot),
    currentOwnerDraftProcesses: [desiredProcess],
    processScanComplete: true,
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.checks.approved_source_reference_residue, 0);
  assert.equal(passed.checks.protected_closure_exact, true);
  assert.equal(passed.checks.derivatives_causally_terminal, true);

  const residue = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status,
    currentStableRows: [
      ...input.capture.source_rows,
      ...input.capture.target_rows,
      ...input.capture.support_rows,
    ].map(remoteFromSnapshot),
    currentOwnerDraftProcesses: [remoteFromSnapshot(originalProcess)],
    processScanComplete: true,
  });
  assert.equal(residue.status, 'failed');
  assert.equal(residue.checks.approved_source_reference_residue, 1);
  assert.equal(residue.checks.affected_processes_exact, false);

  const mirroredColumnDrift = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status,
    currentStableRows: [
      ...input.capture.source_rows,
      ...input.capture.target_rows,
      ...input.capture.support_rows,
    ].map(remoteFromSnapshot),
    currentOwnerDraftProcesses: [{ ...desiredProcess, json: originalProcess.json_ordered }],
    processScanComplete: true,
  });
  assert.equal(mirroredColumnDrift.status, 'failed');
  assert.equal(mirroredColumnDrift.checks.affected_processes_exact, false);
  assert.equal(
    mirroredColumnDrift.issues.some(
      (issue) => issue.code === 'FLOW_IDENTITY_AFFECTED_PROCESS_DRIFT',
    ),
    true,
  );

  for (const mutate of [
    (target: JsonObject) => {
      target.current_snapshot_sha256 = 'bad';
      target.causal_terminal_proof = false;
    },
    (target: JsonObject) => {
      target.proposals_committed = false;
    },
    (target: JsonObject) => {
      (target.residue as JsonObject).pending_jobs = 1;
    },
    (target: JsonObject) => {
      (target.residue as JsonObject).other_active_fences = 1;
    },
  ]) {
    const driftedStatus = structuredClone(status) as unknown as FlowIdentityScopeStatus;
    mutate(driftedStatus.derivative_set_proof.targets[0] as unknown as JsonObject);
    const drift = verifyFlowIdentityReadback({
      plan: input.plan,
      capture: input.capture,
      status: driftedStatus,
      currentStableRows: [
        ...input.capture.source_rows,
        ...input.capture.target_rows,
        ...input.capture.support_rows,
      ].map(remoteFromSnapshot),
      currentOwnerDraftProcesses: [desiredProcess],
      processScanComplete: true,
    });
    assert.equal(drift.status, 'failed');
    assert.equal(drift.checks.derivatives_causally_terminal, false);
    assert.equal(
      drift.issues.some((issue) => issue.code === 'FLOW_IDENTITY_TERMINAL_PROOF_NOT_CURRENT'),
      true,
    );
  }
});

test('independent verifier reserves pending for clean asynchronous derivatives', () => {
  const input = executionScenario();
  const request = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const pendingStatus = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'primary',
      processRequestSha256: String(request.process_request_sha256),
    }),
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const original = remoteFromSnapshot(input.capture.process_rows[0]!);
  const desired: DatasetMaintenanceRemoteRow = {
    ...original,
    json: input.process_templates[0]!.desired_payload,
    json_ordered: input.process_templates[0]!.desired_payload,
  };
  const stableRows = [
    ...input.capture.source_rows,
    ...input.capture.target_rows,
    ...input.capture.support_rows,
  ].map(remoteFromSnapshot);
  const readback = (options: {
    status?: FlowIdentityScopeStatus;
    stableRows?: DatasetMaintenanceRemoteRow[];
  }) =>
    verifyFlowIdentityReadback({
      plan: input.plan,
      capture: input.capture,
      status: options.status ?? pendingStatus,
      currentStableRows: options.stableRows ?? stableRows,
      currentOwnerDraftProcesses: [desired],
      processScanComplete: true,
    });

  assert.equal(readback({}).status, 'pending');

  for (const missingIndex of [
    0,
    input.capture.source_rows.length,
    input.capture.source_rows.length + input.capture.target_rows.length,
  ]) {
    assert.equal(
      readback({ stableRows: stableRows.filter((_, index) => index !== missingIndex) }).status,
      'failed',
    );
  }

  const liveDriftStatus = parseFlowIdentityScopeStatus(
    guardOnlyLiveDriftStatusRaw({
      input,
      phase: 'primary',
      processRequestSha256: String(request.process_request_sha256),
    }),
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const liveDrift = readback({ status: liveDriftStatus });
  assert.equal(liveDrift.database_status, 'live_drift');
  assert.equal(liveDrift.status, 'failed');
});

test('verifier internals reject malformed exchanges, stable drift, protected drift, and incomplete scans', () => {
  const input = executionScenario();
  const issues: Array<{ code: string; message: string; details?: unknown }> = [];
  assert.equal(verifyInternals.processExchanges(null), null);
  assert.equal(verifyInternals.processExchanges({ processDataSet: {} }), null);
  const singletonPayload = processPayload();
  ((singletonPayload.processDataSet as JsonObject).exchanges as JsonObject).exchange = exchange(
    0,
    reference(TARGET_ID, PUBLIC_VERSION),
    '1',
  );
  assert.equal(verifyInternals.processExchanges(singletonPayload)?.length, 1);

  const original = remoteFromSnapshot(input.capture.process_rows[0]!);
  const malformedRows: DatasetMaintenanceRemoteRow[] = [
    { ...original, id: sourceId(200), json_ordered: { processDataSet: {} } },
    {
      ...original,
      id: sourceId(201),
      json_ordered: {
        processDataSet: {
          exchanges: {
            exchange: {
              '@dataSetInternalID': '1',
              exchangeDirection: 'Output',
              referenceToFlowDataSet: { bad: true },
            },
          },
        },
      },
    },
    {
      ...original,
      id: sourceId(202),
      json_ordered: {
        processDataSet: {
          exchanges: {
            exchange: {
              '@dataSetInternalID': 1,
              exchangeDirection: 'Sideways',
              referenceToFlowDataSet: reference(TARGET_ID, PUBLIC_VERSION),
            },
          },
        },
      },
    },
  ];
  verifyInternals.buildOccurrenceIndex(malformedRows, issues);
  assert.deepEqual(
    new Set(issues.map((issue) => issue.code)),
    new Set([
      'FLOW_IDENTITY_PROCESS_EXCHANGES_INVALID',
      'FLOW_IDENTITY_PROCESS_REFERENCE_INVALID',
      'FLOW_IDENTITY_PROCESS_EXCHANGE_IDENTITY_INVALID',
    ]),
  );

  const stableIssues: Array<{ code: string; message: string; details?: unknown }> = [];
  assert.equal(
    verifyInternals.compareStableRows({
      expected: [input.capture.source_rows[0]!],
      currentByKey: new Map(),
      code: 'STABLE_DRIFT',
      issues: stableIssues,
    }),
    false,
  );
  assert.equal(stableIssues[0]?.code, 'STABLE_DRIFT');
  assert.equal(verifyInternals.jsonColumnsMatch({ ...original, json: undefined }), false);

  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const completedStatus = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'completed',
      processRequestSha256: String(processRequest.process_request_sha256),
    }),
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const desired = structuredClone(input.process_templates[0]!.desired_payload);
  const desiredRow: DatasetMaintenanceRemoteRow = {
    ...original,
    json: desired,
    json_ordered: desired,
  };
  const stableRows = [
    ...input.capture.source_rows,
    ...input.capture.target_rows,
    ...input.capture.support_rows,
  ].map(remoteFromSnapshot);
  const incomplete = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status: completedStatus,
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: [desiredRow],
    processScanComplete: false,
  });
  assert.equal(incomplete.status, 'failed');
  assert.equal(incomplete.checks.complete_owner_draft_process_scan, false);
  assert.equal(
    incomplete.issues.some((issue) => issue.code === 'FLOW_IDENTITY_PROCESS_SCAN_INCOMPLETE'),
    true,
  );

  const orphanPayload = structuredClone(desired);
  const orphanExchanges = verifyInternals.processExchanges(orphanPayload)!;
  orphanExchanges.push(exchange(9, reference(sourceId(3), VERSION), '1'));
  const orphanRow = { ...desiredRow, json: orphanPayload, json_ordered: orphanPayload };
  const orphanReport = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status: completedStatus,
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: [orphanRow],
    processScanComplete: true,
  });
  assert.equal(orphanReport.status, 'failed');
  assert.equal(orphanReport.checks.protected_closure_exact, false);
  assert.equal(
    orphanReport.issues.some((issue) => issue.code === 'FLOW_IDENTITY_ORPHAN_REFERENCE_APPEARED'),
    true,
  );

  const nonterminal = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status: {
      ...completedStatus,
      status: 'failed',
      derivatives_current: false,
      terminal_proof_sha256: null,
    },
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: [desiredRow],
    processScanComplete: true,
  });
  assert.equal(nonterminal.status, 'failed');
  assert.equal(
    nonterminal.issues.some((issue) => issue.code === 'FLOW_IDENTITY_TERMINAL_PROOF_NOT_CURRENT'),
    true,
  );
});

test('v2 freeze and seal keep policy evidence separate from byte-exact execution approval', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-freeze-'));
  try {
    const input = materializeExecutionScenario(root);
    const toolchainPath = path.join(root, 'toolchain-evidence.json');
    writePrivateImmutableJson(toolchainPath, toolchainEvidence(input.plan.project_ref));
    const freezeDir = path.join(root, 'freeze');
    const freezeReport = freezeFlowIdentity({
      planPath: input.planPath,
      toolchainEvidencePath: toolchainPath,
      expectedProjectRef: input.plan.project_ref,
      confirm: input.plan.account.email,
      approvedAtUtc: '2026-07-16T05:20:00.000Z',
      cliVersion: '0.0.28',
      outDir: freezeDir,
      now: new Date('2026-07-16T05:10:00.000Z'),
    });
    assert.equal(freezeReport.execution_submitted, false);
    assert.equal(freezeReport.network_calls, 0);
    assert.equal(freezeReport.database_calls, 0);
    const executionApprovalText = readFileSync(freezeReport.artifacts.approval_text, 'utf8');
    assert.notEqual(executionApprovalText, APPROVAL_TEXT);
    assert.equal(freezeReport.execution_approval_text_sha256, sha256Text(executionApprovalText));
    assert.notEqual(
      freezeReport.policy_approval_text_sha256,
      freezeReport.execution_approval_text_sha256,
    );
    const validRequest = JSON.parse(
      readFileSync(freezeReport.artifacts.approval_request, 'utf8'),
    ) as FlowIdentityApprovalRequest;
    assert.equal(parseFlowIdentityApprovalRequest(validRequest).semantic_source_count, 305);
    assert.throws(() => parseFlowIdentityApprovalRequest(null), /invalid/u);
    const requestMutations: Array<(value: JsonObject) => void> = [
      (value) => {
        value.schema_version = 'v0';
      },
      (value) => {
        value.environment = 'preview';
      },
      (value) => {
        value.receipt_id = 'foreign';
      },
      (value) => {
        value.semantic_source_count = 304;
      },
      (value) => {
        value.mapping_count = 1.5;
      },
      (value) => {
        value.automatic_retry = true;
      },
      (value) => {
        value.extra = true;
      },
    ];
    for (const mutate of requestMutations) {
      const value = structuredClone(validRequest) as unknown as JsonObject;
      mutate(value);
      if (!('extra' in value)) {
        value.request_sha256 = computeFlowIdentityApprovalRequestSha256(
          value as unknown as FlowIdentityApprovalRequest,
        );
      }
      assert.throws(
        () => parseFlowIdentityApprovalRequest(value),
        /inconsistent|keys are not exact/u,
      );
    }
    assert.throws(
      () =>
        freezeFlowIdentity({
          planPath: input.planPath,
          toolchainEvidencePath: toolchainPath,
          expectedProjectRef: input.plan.project_ref,
          confirm: 'wrong@example.com',
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          cliVersion: '0.0.28',
          outDir: path.join(root, 'wrong-account-freeze'),
        }),
      /exact production project and account/u,
    );
    const nonCanonicalPlanPath = path.join(root, 'noncanonical-plan.json');
    writePrivateImmutableText(nonCanonicalPlanPath, `${JSON.stringify(input.plan, null, 2)}\n`);
    assert.throws(
      () =>
        freezeFlowIdentity({
          planPath: nonCanonicalPlanPath,
          toolchainEvidencePath: toolchainPath,
          expectedProjectRef: input.plan.project_ref,
          confirm: input.plan.account.email,
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          cliVersion: '0.0.28',
          outDir: path.join(root, 'noncanonical-plan-freeze'),
        }),
      /plan must be canonical/u,
    );
    const nonCanonicalToolchainPath = path.join(root, 'noncanonical-toolchain.json');
    writePrivateImmutableText(
      nonCanonicalToolchainPath,
      `${JSON.stringify(toolchainEvidence(input.plan.project_ref), null, 2)}\n`,
    );
    assert.throws(
      () =>
        freezeFlowIdentity({
          planPath: input.planPath,
          toolchainEvidencePath: nonCanonicalToolchainPath,
          expectedProjectRef: input.plan.project_ref,
          confirm: input.plan.account.email,
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          cliVersion: '0.0.28',
          outDir: path.join(root, 'noncanonical-toolchain-freeze'),
        }),
      /toolchain evidence must be canonical/u,
    );
    assert.throws(
      () =>
        freezeFlowIdentity({
          planPath: input.planPath,
          toolchainEvidencePath: toolchainPath,
          expectedProjectRef: input.plan.project_ref,
          confirm: input.plan.account.email,
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          cliVersion: '0.0.29',
          outDir: path.join(root, 'foreign-toolchain-freeze'),
        }),
      /does not bind the running published CLI version/u,
    );

    const approvalDir = path.join(root, 'approval');
    const sealReport = sealFlowIdentityApproval({
      planPath: input.planPath,
      freezePath: freezeReport.artifacts.freeze,
      approvalRequestPath: freezeReport.artifacts.approval_request,
      humanApprovalPath: freezeReport.artifacts.approval_text,
      approveFreezeFile: freezeReport.freeze_file_sha256,
      approveRequest: freezeReport.execution_approval_request_sha256,
      approveText: freezeReport.execution_approval_text_sha256,
      confirm: input.plan.account.email,
      approvedAtUtc: '2026-07-16T05:20:00.000Z',
      outDir: approvalDir,
      now: new Date('2026-07-16T05:20:01.000Z'),
    });
    assert.equal(sealReport.execution_submitted, false);
    assert.equal(sealReport.network_calls, 0);
    assert.equal(sealReport.database_calls, 0);
    assert.equal(existsSync(sealReport.artifacts.approval), true);
    const prepared = prepareFlowIdentityExecution({
      plan: JSON.parse(readFileSync(input.planPath, 'utf8')),
      freeze: JSON.parse(readFileSync(freezeReport.artifacts.freeze, 'utf8')),
      approval: JSON.parse(readFileSync(sealReport.artifacts.approval, 'utf8')),
    });
    assert.equal(
      prepared.approval.execution_approval_identity_sha256,
      sealReport.execution_approval_identity_sha256,
    );

    assert.throws(() => sealInternals.requireHash('bad', 'hash'), /lowercase SHA-256/u);
    assert.throws(
      () => sealInternals.requireCanonicalJson(nonCanonicalPlanPath, 'plan'),
      /canonical JSON/u,
    );
    assert.throws(
      () =>
        sealFlowIdentityApproval({
          planPath: input.planPath,
          freezePath: freezeReport.artifacts.freeze,
          approvalRequestPath: freezeReport.artifacts.approval_request,
          humanApprovalPath: freezeReport.artifacts.approval_text,
          approveFreezeFile: freezeReport.freeze_file_sha256,
          approveRequest: freezeReport.execution_approval_request_sha256,
          approveText: freezeReport.execution_approval_text_sha256,
          confirm: input.plan.account.email,
          approvedAtUtc: 'bad',
          outDir: path.join(root, 'bad-time-approval'),
        }),
      /approvedAtUtc/u,
    );

    const wrongTextPath = path.join(root, 'wrong-approval.txt');
    writePrivateImmutableText(wrongTextPath, APPROVAL_TEXT);
    assert.throws(
      () =>
        sealFlowIdentityApproval({
          planPath: input.planPath,
          freezePath: freezeReport.artifacts.freeze,
          approvalRequestPath: freezeReport.artifacts.approval_request,
          humanApprovalPath: wrongTextPath,
          approveFreezeFile: freezeReport.freeze_file_sha256,
          approveRequest: freezeReport.execution_approval_request_sha256,
          approveText: sha256Text(APPROVAL_TEXT),
          confirm: input.plan.account.email,
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          outDir: path.join(root, 'wrong-approval'),
        }),
      /does not exactly bind/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery freeze consumes persisted lookup proof or performs one exact read-only fallback', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-freeze-'));
  try {
    const input = materializeExecutionScenario(path.join(root, 'input'));
    const toolchainPath = path.join(root, 'toolchain-evidence.json');
    writePrivateImmutableJson(toolchainPath, toolchainEvidence(input.plan.project_ref));
    const context = (fetchImpl: FetchLike) => ({
      project_ref: input.plan.project_ref,
      rest_base_url: 'https://example.test/rest/v1',
      publishable_key: 'key',
      access_token: 'token',
      account: { ...input.plan.account, session_source: 'test' as const },
      fetch_impl: fetchImpl,
      timeout_ms: 1_000,
    });
    const base = {
      planPath: input.planPath,
      freezePath: input.freezePath,
      approvalPath: input.approvalPath,
      toolchainEvidencePath: toolchainPath,
      expectedProjectRef: input.plan.project_ref,
      confirm: input.plan.account.email,
      approvedAtUtc: '2026-07-16T05:20:00.000Z',
      recoveryReason: 'wrapper_exited_without_permit' as const,
      cliVersion: '0.0.28',
      env: {},
      fetchImpl: (async () => {
        throw new Error('injected dependencies must avoid network');
      }) as FetchLike,
      now: new Date('2026-07-16T05:10:00.000Z'),
    };

    const persistedRunDir = path.join(root, 'persisted-run');
    writePrivateImmutableJson(
      path.join(persistedRunDir, 'scope-lookup-proof.json'),
      scopeLookupRaw(input),
    );
    let persistedLookupCalls = 0;
    let persistedReadCalls = 0;
    const persisted = await freezeFlowIdentityRecovery({
      ...base,
      runDir: persistedRunDir,
      outDir: path.join(root, 'persisted-freeze'),
      dependencies: {
        resolveContext: async ({ fetchImpl }) => context(fetchImpl),
        lookup: async () => {
          persistedLookupCalls += 1;
          return scopeLookupRaw(input);
        },
        read: async () => {
          persistedReadCalls += 1;
          return scopeStatusRaw({ input, phase: 'pending' });
        },
      },
    });
    assert.equal(persistedLookupCalls, 0);
    assert.equal(persistedReadCalls, 1);
    assert.equal(persisted.network_calls, 2);
    assert.equal(persisted.database_calls, 1);

    const humanApprovalPath = path.join(root, 'recovery-human-approval.txt');
    writePrivateImmutableText(
      humanApprovalPath,
      readFileSync(persisted.artifacts.approval_text, 'utf8'),
    );
    const sealed = sealFlowIdentityRecoveryApproval({
      recoveryFreezePath: persisted.artifacts.freeze,
      approvalRequestPath: persisted.artifacts.approval_request,
      humanApprovalPath,
      approveFreezeFile: persisted.recovery_freeze_file_sha256,
      approveRequest: persisted.recovery_approval_request_sha256,
      approveText: persisted.recovery_approval_text_sha256,
      confirm: input.plan.account.email,
      approvedAtUtc: '2026-07-16T05:20:00.000Z',
      outDir: path.join(root, 'recovery-approval'),
      now: new Date('2026-07-16T05:21:00.000Z'),
    });
    const parsedFreeze = parseFlowIdentityRecoveryFreeze(
      JSON.parse(readFileSync(persisted.artifacts.freeze, 'utf8')),
    );
    const parsedApproval = parseFlowIdentityRecoveryApproval(
      JSON.parse(readFileSync(sealed.artifacts.approval, 'utf8')),
      parsedFreeze,
    );
    assert.equal(sealed.status, 'sealed');
    assert.equal(
      parsedApproval.recovery_approval_identity_sha256,
      sealed.recovery_approval_identity_sha256,
    );
    assert.throws(
      () =>
        assertFreshRecoveryBaseline(
          parseFlowIdentityScopeStatus(
            readyToFinalizeScopeStatusRaw({
              input,
              processRequestSha256: String(
                buildFlowIdentityProcessRequest({
                  scopeProofSha256: HASH('scope-proof'),
                  ordinal: 1,
                  processIntentProofSha256: PROCESS_INTENT_PROOF,
                }).process_request_sha256,
              ),
            }),
            input.plan,
            String(scopeLookupRaw(input).scope_id),
            String(scopeLookupRaw(input).scope_proof_sha256),
          ),
          parsedFreeze,
        ),
      /Live scope changed after recovery freeze/u,
    );
    assert.throws(
      () =>
        parseFlowIdentityRecoveryFreeze({
          ...parsedFreeze,
          actor: { ...parsedFreeze.actor, user_id: 'not-a-uuid' },
        }),
      /tampered/u,
    );
    assert.throws(
      () =>
        parseFlowIdentityRecoveryApproval(
          { ...parsedApproval, approved_at_utc: 'not-a-timestamp' },
          parsedFreeze,
        ),
      /exact recovery freeze/u,
    );
    const parsedRequest = JSON.parse(
      readFileSync(persisted.artifacts.approval_request, 'utf8'),
    ) as JsonObject;
    assert.throws(() => parseFlowIdentityRecoveryFreeze(null), /freeze is invalid/u);
    assert.throws(
      () => parseFlowIdentityRecoveryFreeze({ ...parsedFreeze, baseline: null }),
      /baseline is invalid/u,
    );
    assert.throws(
      () =>
        parseFlowIdentityRecoveryFreeze({
          ...parsedFreeze,
          baseline: { ...parsedFreeze.baseline, next_ordinal: 0 },
        }),
      /baseline is inconsistent/u,
    );
    assert.throws(() => parseFlowIdentityRecoveryApprovalRequest(null), /request is invalid/u);
    const invalidTimestampRequest = {
      ...parsedRequest,
      approved_at_utc: 'not-a-timestamp',
      request_sha256: '',
    };
    invalidTimestampRequest.request_sha256 = computeFlowIdentityRecoveryApprovalRequestSha256(
      invalidTimestampRequest as never,
    );
    assert.throws(
      () => parseFlowIdentityRecoveryApprovalRequest(invalidTimestampRequest),
      /canonical RFC3339/u,
    );
    const inconsistentRequest = {
      ...parsedRequest,
      automatic_retry: true,
      request_sha256: '',
    };
    inconsistentRequest.request_sha256 = computeFlowIdentityRecoveryApprovalRequestSha256(
      inconsistentRequest as never,
    );
    assert.throws(
      () => parseFlowIdentityRecoveryApprovalRequest(inconsistentRequest),
      /inconsistent or tampered/u,
    );
    assert.throws(
      () => parseFlowIdentityRecoveryApproval(null, parsedFreeze),
      /approval is invalid/u,
    );
    assert.throws(
      () => renderFlowIdentityRecoveryApprovalText(parsedRequest as never, 'not-a-hash'),
      /must be a SHA-256/u,
    );

    const defaultTimestampSeal = sealFlowIdentityRecoveryApproval({
      recoveryFreezePath: persisted.artifacts.freeze,
      approvalRequestPath: persisted.artifacts.approval_request,
      humanApprovalPath,
      approveFreezeFile: persisted.recovery_freeze_file_sha256,
      approveRequest: persisted.recovery_approval_request_sha256,
      approveText: persisted.recovery_approval_text_sha256,
      confirm: input.plan.account.email,
      approvedAtUtc: '2026-07-16T05:20:00.000Z',
      outDir: path.join(root, 'recovery-approval-default-time'),
    });
    assert.equal(defaultTimestampSeal.status, 'sealed');
    assert.throws(
      () =>
        sealFlowIdentityRecoveryApproval({
          recoveryFreezePath: persisted.artifacts.freeze,
          approvalRequestPath: persisted.artifacts.approval_request,
          humanApprovalPath,
          approveFreezeFile: persisted.recovery_freeze_file_sha256,
          approveRequest: persisted.recovery_approval_request_sha256,
          approveText: persisted.recovery_approval_text_sha256,
          confirm: 'wrong@example.com',
          approvedAtUtc: '2026-07-16T05:20:00.000Z',
          outDir: path.join(root, 'recovery-approval-drift'),
        }),
      /does not exactly bind/u,
    );

    const preflightRunDir = path.join(root, 'preflight-run');
    writePrivateImmutableJson(
      path.join(preflightRunDir, 'scope-preflight-proof.json'),
      scopePreflightRaw(input),
    );
    assert.equal(
      recoveryInternals.readRecoveryScopeProof({
        runDir: preflightRunDir,
        plan: input.plan,
        identity: buildFlowIdentityExecutionIdentity({
          plan: input.plan,
          freeze: input.freeze,
          approval: input.approval,
        }),
      })?.schema_version,
      'dataset-flow-identity-scope-preflight-result.v2',
    );
    const noncanonicalRunDir = path.join(root, 'noncanonical-run');
    const noncanonicalScopePath = path.join(noncanonicalRunDir, 'scope-preflight-proof.json');
    writePrivateImmutableText(
      noncanonicalScopePath,
      `${JSON.stringify(scopePreflightRaw(input))}\n`,
    );
    assert.throws(
      () =>
        recoveryInternals.readRecoveryScopeProof({
          runDir: noncanonicalRunDir,
          plan: input.plan,
          identity: buildFlowIdentityExecutionIdentity({
            plan: input.plan,
            freeze: input.freeze,
            approval: input.approval,
          }),
        }),
      /canonical JSON/u,
    );

    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        expectedProjectRef: 'wrong-project',
        runDir: persistedRunDir,
        outDir: path.join(root, 'wrong-project-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => scopeLookupRaw(input),
          read: async () => scopeStatusRaw({ input, phase: 'pending' }),
        },
      }),
      /exact production project/u,
    );
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        approvedAtUtc: 'not-a-timestamp',
        runDir: persistedRunDir,
        outDir: path.join(root, 'bad-time-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => scopeLookupRaw(input),
          read: async () => scopeStatusRaw({ input, phase: 'pending' }),
        },
      }),
      /canonical RFC3339/u,
    );
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        approvedAtUtc: '2026-07-16T05:09:00.000Z',
        runDir: persistedRunDir,
        outDir: path.join(root, 'approval-before-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => scopeLookupRaw(input),
          read: async () => scopeStatusRaw({ input, phase: 'pending' }),
        },
      }),
      /cannot precede/u,
    );
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        runDir: persistedRunDir,
        outDir: path.join(root, 'bad-context-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => ({
            ...context(fetchImpl),
            project_ref: 'wrong-project',
          }),
          lookup: async () => scopeLookupRaw(input),
          read: async () => scopeStatusRaw({ input, phase: 'pending' }),
        },
      }),
      /context does not match/u,
    );
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        runDir: path.join(root, 'lookup-domain-run'),
        outDir: path.join(root, 'lookup-domain-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => ({
            ok: false,
            code: 'FLOW_IDENTITY_SCOPE_NOT_FOUND',
            status: 404,
          }),
          read: async () => {
            throw new Error('must not read after lookup rejection');
          },
        },
      }),
      /lookup could not recover/u,
    );
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        runDir: persistedRunDir,
        outDir: path.join(root, 'read-domain-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => scopeLookupRaw(input),
          read: async () => ({
            ok: false,
            code: 'FLOW_IDENTITY_SCOPE_READ_REJECTED',
            status: 409,
          }),
        },
      }),
      /rejected the read-only recovery scope snapshot/u,
    );
    const completedProcessRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: 1,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    await assert.rejects(
      freezeFlowIdentityRecovery({
        ...base,
        runDir: persistedRunDir,
        outDir: path.join(root, 'terminal-status-freeze'),
        dependencies: {
          resolveContext: async ({ fetchImpl }) => context(fetchImpl),
          lookup: async () => scopeLookupRaw(input),
          read: async () =>
            scopeStatusRaw({
              input,
              phase: 'completed',
              processRequestSha256: String(completedProcessRequest.process_request_sha256),
            }),
        },
      }),
      /not eligible/u,
    );

    let fallbackLookupCalls = 0;
    let fallbackReadCalls = 0;
    const fallback = await freezeFlowIdentityRecovery({
      ...base,
      runDir: path.join(root, 'lost-preflight-run'),
      outDir: path.join(root, 'fallback-freeze'),
      dependencies: {
        resolveContext: async ({ fetchImpl }) => context(fetchImpl),
        lookup: async () => {
          fallbackLookupCalls += 1;
          return scopeLookupRaw(input);
        },
        read: async () => {
          fallbackReadCalls += 1;
          return scopeStatusRaw({ input, phase: 'pending' });
        },
      },
    });
    assert.equal(fallbackLookupCalls, 1);
    assert.equal(fallbackReadCalls, 1);
    assert.equal(fallback.network_calls, 3);
    assert.equal(fallback.database_calls, 2);
    assert.equal(
      (JSON.parse(readFileSync(fallback.artifacts.scope_proof, 'utf8')) as JsonObject)
        .schema_version,
      'dataset-flow-identity-scope-lookup-result.v1',
    );

    const processRequest = buildFlowIdentityProcessRequest({
      scopeProofSha256: HASH('scope-proof'),
      ordinal: 1,
      processIntentProofSha256: PROCESS_INTENT_PROOF,
    });
    const finalizeOnly = await freezeFlowIdentityRecovery({
      ...base,
      recoveryReason: 'derivatives_became_ready_after_wrapper_exit',
      runDir: persistedRunDir,
      outDir: path.join(root, 'finalize-only-freeze'),
      dependencies: {
        resolveContext: async ({ fetchImpl }) => context(fetchImpl),
        lookup: async () => {
          throw new Error('persisted proof must avoid lookup');
        },
        read: async () =>
          readyToFinalizeScopeStatusRaw({
            input,
            processRequestSha256: String(processRequest.process_request_sha256),
          }),
      },
    });
    const finalizeOnlyFreeze = parseFlowIdentityRecoveryFreeze(
      JSON.parse(readFileSync(finalizeOnly.artifacts.freeze, 'utf8')),
    );
    assert.equal(finalizeOnlyFreeze.recovery_mode, 'finalize_only');
    assert.equal(finalizeOnlyFreeze.maximum_process_posts, 0);

    const defaultGeneratedAt = await freezeFlowIdentityRecovery({
      ...base,
      now: undefined,
      approvedAtUtc: '2099-01-01T00:00:00.000Z',
      runDir: persistedRunDir,
      outDir: path.join(root, 'default-generated-at-freeze'),
      dependencies: {
        resolveContext: async ({ fetchImpl }) => context(fetchImpl),
        lookup: async () => scopeLookupRaw(input),
        read: async () => scopeStatusRaw({ input, phase: 'pending' }),
      },
    });
    assert.equal(defaultGeneratedAt.status, 'frozen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed finalize uses the exact noncompensable v2 envelope', () => {
  const input = executionScenario();
  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: 1,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const status = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'primary',
      processRequestSha256: String(processRequest.process_request_sha256),
    }),
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const request = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: HASH('scope-proof'),
    plan: input.plan,
    status,
  });
  const expected = request.expected as JsonObject;
  const value = {
    ok: false,
    command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
    schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
    scope_id: scopePreflightRaw(input).scope_id,
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    operation_id: input.plan.operation_id,
    plan_sha256: input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: 'failed',
    code: 'FLOW_IDENTITY_FINALIZE_FAILED',
    process_count: expected.process_count,
    completed_process_count: expected.completed_process_count,
    rewrite_count: expected.rewrite_count,
    primary_closure_sha256: status.whole_scope_proof.primary_closure_sha256,
    protected_closure_sha256: status.whole_scope_proof.protected_closure_sha256,
    derivative_target_set_sha256: HASH('db-derivative-target-set'),
    derivative_proof_set_sha256: status.whole_scope_proof.derivative_proof_set_sha256,
    primary_current: true,
    live_guard_current: true,
    derivatives_current: false,
    terminal_proof_sha256: null,
    whole_scope_proof: status.whole_scope_proof,
    whole_scope_proof_sha256: status.whole_scope_proof.proof_sha256,
    audit_id: null,
    replay: false,
    compensation_required: false,
    automatic_retry: false,
    compensation_targets: [],
  };
  const options = {
    plan: input.plan,
    scopeId: scopePreflightRaw(input).scope_id,
    scopeProofSha256: HASH('scope-proof'),
    request,
  };
  assert.equal(parseFlowIdentityFinalizeProof({ value, ...options }).status, 'failed');
  const missingCode = { ...value } as Record<string, unknown>;
  delete missingCode.code;
  assert.throws(
    () => parseFlowIdentityFinalizeProof({ value: missingCode, ...options }),
    /keys do not match/u,
  );
});

test('compensation-required proof is strict, derivative-only, and never authorizes process replay', () => {
  const input = executionScenario();
  const request = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const baseStatusRaw = scopeStatusRaw({
    input,
    phase: 'primary',
    processRequestSha256: String(request.process_request_sha256),
  });
  const status = parseFlowIdentityScopeStatus(
    baseStatusRaw,
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: HASH('scope-proof'),
    plan: input.plan,
    status,
  });
  const expected = finalizeRequest.expected as JsonObject;
  const reason = `FLOW_IDENTITY_SCOPE_COMPENSATION:${scopePreflightRaw(input).scope_id}:1`;
  const target = {
    ordinal: 1,
    table: 'processes',
    id: PROCESS_ID,
    version: VERSION,
    original_batch_id: '99999999-9999-4999-8999-999999999999',
    original_status: 'failed',
    original_code: 'DERIVATIVE_BATCH_CHILD_FAILED',
    desired_payload_sha256: input.plan.processes[0]!.desired_payload_sha256,
    current_json_ordered_sha256: input.plan.processes[0]!.desired_payload_sha256,
    current_snapshot_sha256: HASH('current-derivative-snapshot'),
    current_modified_at: '2026-07-16T05:30:00.000Z',
    components: ['extracted_md', 'embedding_ft'],
    reason_code: reason,
    operation_id_prefix: `${reason}:`,
    latest_compensation_request_id: null,
    latest_compensation_status: null,
    latest_compensation_plan_sha256: null,
    requires_new_plan_freeze_approval: true,
    automatic_retry: false,
  };
  const compensationWholeScopeProof = {
    ...baseStatusRaw.whole_scope_proof,
    derivatives_current: false,
    causal_terminal_proof: false,
    proof_sha256: HASH('compensation-whole-scope-proof'),
  };
  const proof = parseFlowIdentityFinalizeProof({
    value: {
      ok: false,
      command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
      schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
      scope_id: scopePreflightRaw(input).scope_id,
      receipt_id: input.plan.receipt_id,
      receipt_proof_sha256: input.plan.receipt_proof_sha256,
      mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
      process_intent_set_sha256: input.plan.process_intent_set_sha256,
      invocation_id: WRAPPER_INVOCATION_ID,
      permit_generation_before: 0,
      operation_id: input.plan.operation_id,
      plan_sha256: input.plan.plan_sha256,
      scope_proof_sha256: HASH('scope-proof'),
      status: 'derivatives_pending',
      code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
      process_count: expected.process_count,
      rewrite_count: expected.rewrite_count,
      completed_process_count: expected.completed_process_count,
      primary_closure_sha256: compensationWholeScopeProof.primary_closure_sha256,
      protected_closure_sha256: compensationWholeScopeProof.protected_closure_sha256,
      derivative_target_set_sha256: HASH('db-derivative-target-set'),
      derivative_proof_set_sha256: compensationWholeScopeProof.derivative_proof_set_sha256,
      primary_current: true,
      live_guard_current: true,
      derivatives_current: false,
      terminal_proof_sha256: null,
      whole_scope_proof: compensationWholeScopeProof,
      whole_scope_proof_sha256: compensationWholeScopeProof.proof_sha256,
      audit_id: 'finalize-compensation-audit',
      replay: false,
      compensation_required: true,
      automatic_retry: false,
      compensation_targets: [target],
    },
    plan: input.plan,
    scopeId: scopePreflightRaw(input).scope_id,
    scopeProofSha256: HASH('scope-proof'),
    request: finalizeRequest,
  });
  assert.equal(proof.compensation_required, true);
  assert.equal(proof.compensation_targets?.[0]?.requires_new_plan_freeze_approval, true);
  for (const mutate of [
    (value: JsonObject) => {
      value.latest_compensation_request_id = 'bad';
    },
    (value: JsonObject) => {
      value.latest_compensation_status = 1;
    },
    (value: JsonObject) => {
      value.latest_compensation_plan_sha256 = 'bad';
    },
    (value: JsonObject) => {
      value.original_code = '';
    },
  ]) {
    const invalidTarget = structuredClone(target) as unknown as JsonObject;
    mutate(invalidTarget);
    assert.throws(
      () =>
        parseFlowIdentityFinalizeProof({
          value: { ...proof, compensation_targets: [invalidTarget] },
          plan: input.plan,
          scopeId: scopePreflightRaw(input).scope_id,
          scopeProofSha256: HASH('scope-proof'),
          request: finalizeRequest,
        }),
      /does not bind|provenance/u,
    );
  }
  const opaqueHashProof = parseFlowIdentityFinalizeProof({
    value: {
      ...proof,
      compensation_targets: [{ ...target, current_json_ordered_sha256: HASH('db-opaque') }],
    },
    plan: input.plan,
    scopeId: scopePreflightRaw(input).scope_id,
    scopeProofSha256: HASH('scope-proof'),
    request: finalizeRequest,
  });
  assert.equal(
    opaqueHashProof.compensation_targets?.[0]?.current_json_ordered_sha256,
    HASH('db-opaque'),
  );
});

test('scope-read compensation proof binds the original derivative request without retry authority', () => {
  const input = executionScenario();
  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const base = scopeStatusRaw({
    input,
    phase: 'primary',
    processRequestSha256: String(processRequest.process_request_sha256),
  });
  const reason = `FLOW_IDENTITY_SCOPE_COMPENSATION:${scopePreflightRaw(input).scope_id}:1`;
  const target = {
    ordinal: 1,
    table: 'processes',
    id: PROCESS_ID,
    version: VERSION,
    original_batch_id: '99999999-9999-4999-8999-999999999999',
    original_request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    original_status: 'failed',
    original_error: { code: 'DERIVATIVE_BATCH_CHILD_FAILED' },
    original_code: 'DERIVATIVE_BATCH_CHILD_FAILED',
    desired_payload_sha256: input.plan.processes[0]!.desired_payload_sha256,
    current_json_ordered_sha256: input.plan.processes[0]!.desired_payload_sha256,
    current_snapshot_sha256: HASH('scope-read-current-snapshot'),
    current_modified_at: '2026-07-16T05:30:00.000Z',
    components: ['extracted_md', 'embedding_ft'],
    reason_code: reason,
    operation_id_prefix: `${reason}:`,
    latest_compensation_request_id: null,
    latest_compensation_status: null,
    latest_compensation_plan_sha256: null,
    requires_new_plan_freeze_approval: true,
    automatic_retry: false,
  };
  const derivativeCompensationTarget = Object.fromEntries(
    Object.entries(target).filter(
      ([key]) => key !== 'original_request_id' && key !== 'original_error',
    ),
  );
  const failedDerivativeSetProof = {
    ok: false,
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: scopePreflightRaw(input).scope_id,
    status: 'compensation_required',
    target_count: 1,
    completed_count: 0,
    pending_count: 0,
    failed_count: 1,
    causal_terminal_proof: false,
    targets: [
      {
        ordinal: 1,
        id: PROCESS_ID,
        version: VERSION,
        original_batch_id: '99999999-9999-4999-8999-999999999999',
        effective_reference_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        effective_reference_kind: 'protected_batch',
        status: 'failed',
        request_status: 'failed',
        phase: 'failed_drained',
        lineage_ok: true,
        proposals_committed: false,
        terminal_audit_present: false,
        residue: {
          http_requests: 0,
          embedding_jobs: 0,
          pending_jobs: 0,
          failure_rows: 0,
          other_active_fences: 0,
        },
        current_snapshot_sha256: target.current_snapshot_sha256,
        current_json_ordered_sha256: target.current_json_ordered_sha256,
        causal_terminal_proof: false,
      },
    ],
    compensation_targets: [derivativeCompensationTarget],
    proof_sha256: HASH('failed-derivative-set'),
  };
  const failedWholeScopeProof = {
    ...base.whole_scope_proof,
    derivative_proof_set_sha256: failedDerivativeSetProof.proof_sha256,
    derivatives_current: false,
    causal_terminal_proof: false,
    proof_sha256: HASH('failed-whole-scope-proof'),
  };
  const raw = {
    ...base,
    ok: false,
    code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
    derivative_pending_count: 0,
    derivative_failed_count: 1,
    derivative_proof_set_sha256: failedDerivativeSetProof.proof_sha256,
    compensation_required: true,
    compensation_targets: [target],
    processes: base.processes.map((entry) => ({ ...entry, derivative_status: 'failed' })),
    derivative_set_proof: failedDerivativeSetProof,
    whole_scope_proof: failedWholeScopeProof,
    whole_scope_proof_sha256: failedWholeScopeProof.proof_sha256,
  };
  const parsed = parseFlowIdentityScopeStatus(
    raw,
    input.plan,
    scopePreflightRaw(input).scope_id,
    HASH('scope-proof'),
  );
  assert.equal(parsed.compensation_required, true);
  assert.equal(parsed.compensation_targets?.[0]?.original_request_id, target.original_request_id);
  assert.equal(parsed.automatic_retry, false);
  const missingRequestTarget = Object.fromEntries(
    Object.entries(target).filter(([key]) => key !== 'original_request_id'),
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...raw, compensation_targets: [missingRequestTarget] },
        input.plan,
        scopePreflightRaw(input).scope_id,
        HASH('scope-proof'),
      ),
    /provenance/u,
  );
  const convenienceDrift = structuredClone(raw) as unknown as JsonObject;
  const nestedCompensation = (
    (convenienceDrift.derivative_set_proof as JsonObject).compensation_targets as JsonObject[]
  )[0]!;
  nestedCompensation.latest_compensation_status = 'failed';
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        convenienceDrift,
        input.plan,
        scopePreflightRaw(input).scope_id,
        HASH('scope-proof'),
      ),
    /convenience fields/u,
  );
});

test('missing original derivative child has one exact nullable compensation shape', () => {
  const input = executionScenario();
  const processRequest = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: 1,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const raw = missingOriginalDerivativeScopeRaw({
    input,
    processRequestSha256: String(processRequest.process_request_sha256),
  });
  const parse = (value: unknown) =>
    parseFlowIdentityScopeStatus(
      value,
      input.plan,
      scopePreflightRaw(input).scope_id,
      HASH('scope-proof'),
    );
  const parsed = parse(raw);
  assert.equal(parsed.processes[0]?.derivative_request_id, null);
  assert.equal(parsed.processes[0]?.derivative_status, 'missing');
  assert.equal(parsed.derivative_set_proof.targets[0]?.effective_reference_id, null);
  assert.equal(parsed.derivative_set_proof.targets[0]?.request_status, 'missing');
  assert.equal(parsed.compensation_targets?.[0]?.original_request_id, null);
  assert.equal(parsed.compensation_targets?.[0]?.original_status, 'missing');

  const reject = (mutate: (value: JsonObject) => void) => {
    const value = structuredClone(raw) as unknown as JsonObject;
    mutate(value);
    assert.throws(() => parse(value), /incomplete|does not bind|provenance|counts\/status/u);
  };
  const process = (value: JsonObject) => (value.processes as JsonObject[])[0]!;
  const derivativeProof = (value: JsonObject) => value.derivative_set_proof as JsonObject;
  const target = (value: JsonObject) => (derivativeProof(value).targets as JsonObject[])[0]!;
  const nestedCompensation = (value: JsonObject) =>
    (derivativeProof(value).compensation_targets as JsonObject[])[0]!;
  const scopeCompensation = (value: JsonObject) => (value.compensation_targets as JsonObject[])[0]!;

  reject((value) => {
    process(value).derivative_status = null;
  });
  reject((value) => {
    process(value).derivative_request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  });
  reject((value) => {
    target(value).effective_reference_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  });
  reject((value) => {
    target(value).request_status = 'failed';
  });
  reject((value) => {
    target(value).phase = 'failed';
  });
  reject((value) => {
    target(value).lineage_ok = true;
  });
  reject((value) => {
    target(value).proposals_committed = true;
  });
  reject((value) => {
    target(value).terminal_audit_present = true;
  });
  reject((value) => {
    target(value).effective_reference_kind = 'separate_compensation';
    target(value).request_status = 'failed';
    target(value).phase = 'failed';
  });
  reject((value) => {
    scopeCompensation(value).original_request_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  });
  reject((value) => {
    delete scopeCompensation(value).original_error;
  });
  reject((value) => {
    scopeCompensation(value).original_status = 'failed';
  });
  reject((value) => {
    nestedCompensation(value).original_status = 'failed';
  });
  reject((value) => {
    nestedCompensation(value).original_code = 'DERIVATIVE_BATCH_CHILD_FAILED';
  });

  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: HASH('scope-proof'),
    plan: input.plan,
    status: parsed,
  });
  const expected = finalizeRequest.expected as JsonObject;
  const pending = pendingFinalizeRaw({ input, expected });
  const finalizeTarget = (raw.derivative_set_proof.compensation_targets as JsonObject[])[0]!;
  const finalizeRaw = {
    ...pending,
    ok: false,
    code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
    derivative_proof_set_sha256: parsed.derivative_proof_set_sha256,
    primary_closure_sha256: parsed.whole_scope_proof.primary_closure_sha256,
    protected_closure_sha256: parsed.whole_scope_proof.protected_closure_sha256,
    whole_scope_proof: parsed.whole_scope_proof,
    whole_scope_proof_sha256: parsed.whole_scope_proof_sha256,
    compensation_required: true,
    compensation_targets: [finalizeTarget],
  };
  assert.equal(
    parseFlowIdentityFinalizeProof({
      value: finalizeRaw,
      plan: input.plan,
      scopeId: scopePreflightRaw(input).scope_id,
      scopeProofSha256: HASH('scope-proof'),
      request: finalizeRequest,
    }).compensation_targets?.[0]?.original_status,
    'missing',
  );
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: {
          ...finalizeRaw,
          compensation_targets: [{ ...finalizeTarget, original_request_id: null }],
        },
        plan: input.plan,
        scopeId: scopePreflightRaw(input).scope_id,
        scopeProofSha256: HASH('scope-proof'),
        request: finalizeRequest,
      }),
    /provenance/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: {
          ...finalizeRaw,
          compensation_targets: [{ ...finalizeTarget, original_error: null }],
        },
        plan: input.plan,
        scopeId: scopePreflightRaw(input).scope_id,
        scopeProofSha256: HASH('scope-proof'),
        request: finalizeRequest,
      }),
    /provenance/u,
  );

  const recoveredRaw = readyToFinalizeScopeStatusRaw({
    input,
    processRequestSha256: String(processRequest.process_request_sha256),
  });
  recoveredRaw.processes = recoveredRaw.processes.map((entry) => ({
    ...entry,
    derivative_request_id: null,
    derivative_status: 'missing',
  }));
  recoveredRaw.derivative_set_proof.targets = recoveredRaw.derivative_set_proof.targets.map(
    (entry) => ({
      ...entry,
      effective_reference_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      effective_reference_kind: 'separate_compensation',
    }),
  );
  recoveredRaw.derivative_set_proof.proof_sha256 = HASH('recovered-derivative-set');
  recoveredRaw.derivative_proof_set_sha256 = recoveredRaw.derivative_set_proof.proof_sha256;
  recoveredRaw.whole_scope_proof.derivative_proof_set_sha256 =
    recoveredRaw.derivative_set_proof.proof_sha256;
  recoveredRaw.whole_scope_proof.proof_sha256 = HASH('recovered-whole-scope');
  recoveredRaw.whole_scope_proof_sha256 = recoveredRaw.whole_scope_proof.proof_sha256;
  const recovered = parse(recoveredRaw);
  assert.equal(
    recovered.derivative_set_proof.targets[0]?.effective_reference_kind,
    'separate_compensation',
  );
  assert.equal(
    recovered.derivative_set_proof.targets[0]?.effective_reference_id,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  assert.equal(flowIdentityScopeIsReadyToFinalize(recovered), true);
  const nullableSeparateCompensation = structuredClone(recoveredRaw) as unknown as JsonObject;
  (
    (nullableSeparateCompensation.derivative_set_proof as JsonObject).targets as JsonObject[]
  )[0]!.effective_reference_id = null;
  assert.throws(() => parse(nullableSeparateCompensation), /does not bind/u);
});

test('dynamic derivative set proof is exact, ordered, and fail-closed', () => {
  const input = executionScenario();
  const request = buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.process_templates[0]!.process.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
  const base = scopeStatusRaw({
    input,
    phase: 'completed',
    processRequestSha256: String(request.process_request_sha256),
  });
  const reject = (mutate: (value: JsonObject) => void, pattern: RegExp) => {
    const value = structuredClone(base) as unknown as JsonObject;
    mutate(value);
    assert.throws(
      () =>
        parseFlowIdentityScopeStatus(
          value,
          input.plan,
          scopePreflightRaw(input).scope_id,
          HASH('scope-proof'),
        ),
      pattern,
    );
  };
  const proof = (value: JsonObject) => value.derivative_set_proof as JsonObject;
  const target = (value: JsonObject) => (proof(value).targets as JsonObject[])[0]!;
  reject((value) => {
    value.derivative_set_proof = null;
  }, /set proof is invalid/u);
  reject((value) => {
    proof(value).extra = true;
  }, /keys/u);
  reject((value) => {
    proof(value).targets = null;
  }, /arrays/u);
  reject((value) => {
    proof(value).targets = [null];
  }, /must be an object/u);
  reject((value) => {
    target(value).extra = true;
  }, /keys/u);
  reject((value) => {
    target(value).residue = null;
  }, /must be an object/u);
  reject((value) => {
    (target(value).residue as JsonObject).extra = 0;
  }, /keys/u);
  reject((value) => {
    target(value).lineage_ok = 'yes';
  }, /must be boolean/u);
  reject((value) => {
    target(value).causal_terminal_proof = 'yes';
  }, /must be boolean/u);
  reject((value) => {
    target(value).effective_reference_kind = 'separate_compensation';
  }, /does not bind/u);
  reject((value) => {
    target(value).request_status = 'queued';
  }, /does not bind/u);
  reject((value) => {
    target(value).current_snapshot_sha256 = 'bad';
  }, /does not bind/u);
  reject((value) => {
    (proof(value).targets as JsonObject[]).push(structuredClone(target(value)));
  }, /foreign target/u);
  reject((value) => {
    proof(value).target_count = 0;
  }, /counts\/status/u);
  reject((value) => {
    proof(value).causal_terminal_proof = 'yes';
  }, /must be boolean/u);
  reject((value) => {
    proof(value).proof_sha256 = 'bad';
  }, /counts\/status/u);
  reject((value) => {
    value.derivative_pending_count = 1;
  }, /progress ledger/u);
});
