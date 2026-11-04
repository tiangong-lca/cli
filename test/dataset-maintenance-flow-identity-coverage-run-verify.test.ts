import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  buildFlowIdentityCaptureRequest,
  buildFlowIdentityPlan,
  buildFlowIdentitySemantics,
} from '../src/lib/dataset-maintenance-flow-identity-plan.js';
import {
  __testInternals as runInternals,
  runFlowIdentity,
} from '../src/lib/dataset-maintenance-flow-identity-run.js';
import {
  __testInternals as verifyInternals,
  verifyFlowIdentity,
  verifyFlowIdentityReadback,
} from '../src/lib/dataset-maintenance-flow-identity-verify.js';
import { writePrivateImmutableJson } from '../src/lib/dataset-maintenance-protected-artifacts.js';
import {
  buildFlowIdentityExecutionIdentity,
  buildFlowIdentityFinalizeRequest,
  buildFlowIdentityProcessRequest,
  computeFlowIdentityApprovalIdentitySha256,
  computeFlowIdentityFreezeSha256,
  parseFlowIdentityFinalizeProof,
  parseFlowIdentityProcessProof,
  parseFlowIdentityScopePreflightProof,
  parseFlowIdentityScopeStatus,
  parseFlowIdentityWholeScopeProof,
  __testInternals as executionInternals,
  type FlowIdentityApproval,
  type FlowIdentityFreeze,
} from '../src/lib/dataset-maintenance-flow-identity-execution-contract.js';
import { flowIdentityRestrictedSha256 } from '../src/lib/dataset-maintenance-flow-identity-wire.js';
import {
  sha256Json,
  sha256Text,
  snapshotRemoteRow,
  stableJsonText,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import type { DatasetMaintenanceRemoteContext } from '../src/lib/dataset-maintenance-remote.js';
import type { FlowPayloadValidationResult } from '../src/lib/flow-payload-validation.js';
import type { FetchLike } from '../src/lib/http.js';
import { claimFlowIdentityApproval } from '../src/lib/dataset-maintenance-flow-identity-approval-claim.js';
import {
  computeFlowIdentityRecoveryApprovalIdentitySha256,
  computeFlowIdentityRecoveryFreezeSha256,
  type FlowIdentityRecoveryApproval,
  type FlowIdentityRecoveryFreeze,
} from '../src/lib/dataset-maintenance-flow-identity-recovery.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WRAPPER_INVOCATION_ID = '77777777-7777-4777-8777-777777777777';
const PUBLIC_OWNER = '22222222-2222-4222-8222-222222222222';
const VERSION = '01.00.000';
const PUBLIC_VERSION = '03.00.004';
const FP_ID = '33333333-3333-4333-8333-333333333333';
const FP_VERSION = '03.00.003';
const UG_ID = '44444444-4444-4444-8444-444444444444';
const UG_VERSION = '03.00.003';
const PROCESS_ID = '55555555-5555-4555-8555-555555555555';
const PROCESS_ID_2 = '56565656-5656-4565-8565-565656565656';
const TARGET_ID = '66666666-6666-4666-8666-666666666666';
const MODIFIED = '2026-07-16T04:00:00+00:00';
const SCOPE_ID = '88888888-8888-4888-8888-888888888888';
const DERIVATIVE_BATCH_ID = '99999999-9999-4999-8999-999999999999';
const DERIVATIVE_REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVAL_TEXT = 'APPROVE CURRENT BAFU STEP3 COMPATIBILITY POLICY';
const PROCESS_INTENT_PROOF = sha256Json('db-process-intent-proof');
const HASH = (value: string): string => sha256Json(value);

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

function processPayload(processId = PROCESS_ID): JsonObject {
  const mapped = reference(sourceId(0), VERSION, 'source-0') as JsonObject;
  mapped['common:subReference'] = 'must-survive-five-field-patch';
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': processId } },
      exchanges: {
        exchange: [
          exchange(0, mapped as FlowIdentityReference, '1.250'),
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

function bindCaptureReceiptSemantics(
  capture: FlowIdentityLiveCapture,
  review: FlowIdentityReviewLedger,
): FlowIdentityLiveCapture {
  capture.artifact_evidence.review_ledger_sha256 = review.ledger_sha256;
  capture.artifact_evidence.live_capture_artifact_sha256 =
    computeFlowIdentityCaptureEvidenceSha256(capture);
  const capturePolicy = policy(review.review_evidence_sha256);
  const validation = { validateFlow: flowLegacyWarning, validateProcess: processPass };
  const semantics = buildFlowIdentitySemantics({
    policy: capturePolicy,
    review,
    capture,
    validation,
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

function liveCapture(
  review: FlowIdentityReviewLedger,
  processIds: string[] = [PROCESS_ID],
): FlowIdentityLiveCapture {
  const processRows = processIds.map((processId) =>
    snapshot({
      table: 'processes',
      id: processId,
      version: VERSION,
      userId: ACTOR,
      stateCode: 0,
      payload: processPayload(processId),
      modelId: '77777777-7777-4777-8777-777777777777',
      ruleVerification: false,
    }),
  );
  const capture: FlowIdentityLiveCapture = {
    schema_version: 'dataset-flow-identity-live-capture.v2',
    captured_at_utc: '2026-07-16T04:10:00.000Z',
    environment: 'production',
    project_ref: 'production-project',
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
      owner_draft_process_count: processRows.length,
      owner_draft_process_scan: {
        status: 'complete',
        complete: true,
        strategy: 'postgrest_exact_count',
        requested_page_size: 1000,
        effective_page_size: processRows.length,
        pages_fetched: 1,
        rows_fetched: processRows.length,
        exact_total: processRows.length,
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
    process_rows: processRows,
    capture_request: {} as never,
    attestation: {
      ok: true,
      command: 'cmd_dataset_flow_identity_capture_attest_guarded',
      schema_version: 'dataset-flow-identity-capture-attest-result.v2',
      proof_domain: 'dataset-flow-identity-db-proof.v2',
      receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      receipt_proof_sha256: HASH('receipt-proof'),
      operation_id: 'flow-identity-v2-test-operation',
      environment: 'production',
      project_ref: 'production-project',
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
      process_count: processRows.length,
      rewrite_count: processRows.length,
      capture_request_sha256: '',
      replay: false,
    },
    capture_artifact_sha256: '',
  };
  return bindCaptureReceiptSemantics(capture, review);
}

function executionScenario(processIds: string[] = [PROCESS_ID]) {
  const review = reviewLedger();
  const capture = liveCapture(review, processIds);
  const validation = { validateFlow: flowLegacyWarning, validateProcess: processPass };
  const bundle = buildFlowIdentityPlan({
    policy: policy(review.review_evidence_sha256),
    reviewLedger: review,
    liveCapture: capture,
    now: new Date('2026-07-16T04:20:00.000Z'),
    validation,
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
  return { ...bundle, capture, freeze, approval };
}

function materializeExecutionScenario(root: string, processIds?: string[]) {
  const input = executionScenario(processIds);
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

type Scenario = ReturnType<typeof executionScenario>;

function scopePreflightRaw(input: Scenario): JsonObject {
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_preflight_guarded',
    schema_version: 'dataset-flow-identity-scope-preflight-result.v2',
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    scope_id: SCOPE_ID,
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

function executionPermit(generation: number): JsonObject {
  return {
    schema_version: 'dataset-flow-identity-execution-permit.v1',
    invocation_id: WRAPPER_INVOCATION_ID,
    generation,
    token: HASH(`permit-${generation}`),
  };
}

function scopePreflightEnvelope(input: Scenario): JsonObject {
  return { ...scopePreflightRaw(input), execution_permit: executionPermit(0) };
}

function scopeLookupRaw(input: Scenario): JsonObject {
  const preflight = scopePreflightRaw(input);
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
    status: 'completed',
    process_count: preflight.process_count,
    mapping_count: preflight.mapping_count,
    support_snapshot_count: preflight.support_snapshot_count,
    source_universe_count: 305,
    rewrite_count: preflight.rewrite_count,
    next_ordinal: input.plan.processes.length + 1,
    audit_id: 'scope-audit-1',
    whole_scope_proof_sha256: HASH('whole-scope-terminal'),
    execution_permit: null,
  };
}

function scopeStatusRaw(options: {
  input: Scenario;
  phase: 'pending' | 'primary' | 'completed';
  processRequestSha256?: string;
  completedProcessCount?: number;
}): JsonObject {
  const completedProcessCount =
    options.completedProcessCount ??
    (options.phase === 'pending' ? 0 : options.input.plan.processes.length);
  const allCompleted = completedProcessCount === options.input.plan.processes.length;
  const terminal = options.phase === 'completed';
  const derivativeTargets = options.input.plan.processes
    .slice(0, completedProcessCount)
    .map((process, index) => ({
      ordinal: index + 1,
      id: process.id,
      version: process.version,
      original_batch_id: DERIVATIVE_BATCH_ID,
      effective_reference_id: DERIVATIVE_REQUEST_ID,
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
      current_snapshot_sha256: HASH(`${terminal ? 'terminal' : 'pending'}-${index}`),
      current_json_ordered_sha256: process.desired_payload_sha256,
      causal_terminal_proof: terminal,
    }));
  const derivativeSetProof = {
    ok: completedProcessCount > 0,
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: SCOPE_ID,
    status: terminal ? 'completed' : completedProcessCount > 0 ? 'pending' : 'failed',
    target_count: completedProcessCount,
    completed_count: terminal ? completedProcessCount : 0,
    pending_count: terminal ? 0 : completedProcessCount,
    failed_count: 0,
    causal_terminal_proof: terminal,
    targets: derivativeTargets,
    compensation_targets: [],
    proof_sha256: HASH(terminal ? 'terminal-derivative-set' : 'nonterminal-derivative-set'),
  };
  const wholeScopeProof = {
    schema_version: 'dataset-flow-identity-whole-scope-proof.v2',
    scope_id: SCOPE_ID,
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
    scope_id: SCOPE_ID,
    receipt_id: options.input.plan.receipt_id,
    receipt_proof_sha256: options.input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: options.input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: options.input.plan.process_intent_set_sha256,
    operation_id: options.input.plan.operation_id,
    plan_sha256: options.input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: terminal
      ? 'completed'
      : allCompleted
        ? 'derivatives_pending'
        : completedProcessCount > 0
          ? 'running'
          : 'sealed',
    process_count: options.input.plan.processes.length,
    completed_process_count: completedProcessCount,
    pending_process_count: options.input.plan.processes.length - completedProcessCount,
    failed_process_count: 0,
    next_ordinal: Math.min(completedProcessCount + 1, options.input.plan.processes.length + 1),
    rewrite_count: options.input.plan.summary.rewrites,
    completed_rewrite_count: options.input.plan.processes
      .slice(0, completedProcessCount)
      .reduce((sum, process) => sum + process.rewrite_count, 0),
    primary_complete: allCompleted,
    primary_current: true,
    live_guard_current: true,
    derivatives_current: terminal,
    derivative_pending_count: terminal ? 0 : completedProcessCount,
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
    cancellable: completedProcessCount === 0,
    strict_continuation_required: completedProcessCount > 0 && !allCompleted,
    processes: options.input.plan.processes.map((process, index) => {
      const completed = index < completedProcessCount;
      const intentProof = index === 0 ? PROCESS_INTENT_PROOF : HASH(`process-intent-${index + 1}`);
      const requestSha256 =
        index === 0 && options.processRequestSha256
          ? options.processRequestSha256
          : buildFlowIdentityProcessRequest({
              scopeProofSha256: HASH('scope-proof'),
              ordinal: index + 1,
              processIntentProofSha256: intentProof,
            }).process_request_sha256;
      return {
        ordinal: index + 1,
        id: process.id,
        version: process.version,
        status: completed ? 'completed' : 'pending',
        process_request_sha256: completed ? requestSha256 : null,
        process_intent_proof_sha256: intentProof,
        desired_payload_sha256: process.desired_payload_sha256,
        desired_exchange_set_sha256: process.desired_exchange_set_sha256,
        rewrite_count: 1,
        audit_id: completed ? `audit-${index + 1}` : null,
        before_payload_sha256: process.before_payload_sha256,
        before_exchange_set_sha256: process.before_exchange_set_sha256,
        after_payload_sha256: completed ? process.desired_payload_sha256 : null,
        after_exchange_set_sha256: completed ? process.desired_exchange_set_sha256 : null,
        derivative_batch_id: completed ? DERIVATIVE_BATCH_ID : null,
        derivative_request_id: completed ? DERIVATIVE_REQUEST_ID : null,
        derivative_status: terminal ? 'completed' : completed ? 'embedding_pending' : null,
        causal_terminal_proof: false,
        completed_at: completed ? '2026-07-16T04:50:00.000Z' : null,
        last_error: null,
      };
    }),
  };
}

function processRequest(input: Scenario): JsonObject {
  return buildFlowIdentityProcessRequest({
    scopeProofSha256: HASH('scope-proof'),
    ordinal: input.plan.processes[0]!.ordinal,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
  });
}

function readyStatusRaw(input: Scenario): JsonObject {
  const value = scopeStatusRaw({
    input,
    phase: 'completed',
    processRequestSha256: String(processRequest(input).process_request_sha256),
  });
  value.status = 'primary_complete';
  value.terminal_proof_sha256 = null;
  value.completed_at = null;
  return value;
}

function guardedStatusRaw(input: Scenario, change: 'guard_drift' | 'primary_drift'): JsonObject {
  const value = scopeStatusRaw({ input, phase: 'pending' });
  const whole = value.whole_scope_proof as JsonObject;
  if (change === 'guard_drift') {
    whole.protected_closure_current = false;
    whole.occurrence_closure_current = false;
    value.live_guard_current = false;
    value.protected_closure_current = false;
  } else {
    whole.primary_current = false;
    value.primary_current = false;
  }
  whole.proof_sha256 = HASH(change);
  value.whole_scope_proof_sha256 = whole.proof_sha256;
  return value;
}

function liveDriftRaw(input: Scenario, code: string | null = null): JsonObject {
  const value = guardedStatusRaw(input, 'guard_drift');
  value.ok = false;
  value.status = 'live_drift';
  value.cancellable = false;
  value.code = code ?? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT';
  return value;
}

function liveDriftRawWithoutReturnedCode(input: Scenario): JsonObject {
  const value = liveDriftRaw(input);
  let reads = 0;
  Object.defineProperty(value, 'code', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads <= 2 ? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT' : undefined;
    },
  });
  return value;
}

function failedStatusRaw(input: Scenario): JsonObject {
  const value = scopeStatusRaw({ input, phase: 'pending' });
  value.ok = false;
  value.status = 'failed';
  value.pending_process_count = 0;
  value.failed_process_count = 1;
  value.next_ordinal = 2;
  value.cancellable = false;
  value.processes = (value.processes as JsonObject[]).map((entry) => ({
    ...entry,
    status: 'failed',
    last_error: { code: 'FAILED' },
  }));
  return value;
}

function compensationTarget(input: Scenario, includeScopeReadFields: boolean): JsonObject {
  const reason = `FLOW_IDENTITY_SCOPE_COMPENSATION:${SCOPE_ID}:1`;
  return {
    ordinal: 1,
    table: 'processes',
    id: PROCESS_ID,
    version: VERSION,
    original_batch_id: DERIVATIVE_BATCH_ID,
    ...(includeScopeReadFields ? { original_request_id: null, original_error: null } : {}),
    original_status: 'missing',
    original_code: 'DERIVATIVE_BATCH_CHILD_MISSING',
    desired_payload_sha256: input.plan.processes[0]!.desired_payload_sha256,
    current_json_ordered_sha256: input.plan.processes[0]!.desired_payload_sha256,
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
}

function compensationStatusRaw(input: Scenario): JsonObject {
  const value = scopeStatusRaw({
    input,
    phase: 'primary',
    processRequestSha256: String(processRequest(input).process_request_sha256),
  });
  const target = compensationTarget(input, true);
  const derivativeTarget = {
    ordinal: 1,
    id: PROCESS_ID,
    version: VERSION,
    original_batch_id: DERIVATIVE_BATCH_ID,
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
    current_snapshot_sha256: target.current_snapshot_sha256,
    current_json_ordered_sha256: target.current_json_ordered_sha256,
    causal_terminal_proof: false,
  };
  const derivativeCompensationTarget = structuredClone(target);
  delete derivativeCompensationTarget.original_request_id;
  delete derivativeCompensationTarget.original_error;
  const derivativeSet = {
    ok: false,
    schema_version: 'dataset-flow-identity-derivative-set-proof.v1',
    scope_id: SCOPE_ID,
    status: 'compensation_required',
    target_count: 1,
    completed_count: 0,
    pending_count: 0,
    failed_count: 1,
    causal_terminal_proof: false,
    targets: [derivativeTarget],
    compensation_targets: [derivativeCompensationTarget],
    proof_sha256: HASH('missing-child-derivative-set'),
  };
  const whole = value.whole_scope_proof as JsonObject;
  whole.derivative_proof_set_sha256 = derivativeSet.proof_sha256;
  whole.derivatives_current = false;
  whole.causal_terminal_proof = false;
  whole.proof_sha256 = HASH('missing-child-whole-scope');
  value.ok = false;
  value.status = 'derivatives_pending';
  value.code = 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED';
  value.derivative_pending_count = 0;
  value.derivative_failed_count = 1;
  value.derivative_set_proof = derivativeSet;
  value.derivative_proof_set_sha256 = derivativeSet.proof_sha256;
  value.compensation_required = true;
  value.compensation_targets = [target];
  value.processes = (value.processes as JsonObject[]).map((entry) => ({
    ...entry,
    derivative_request_id: null,
    derivative_status: 'missing',
  }));
  value.whole_scope_proof_sha256 = whole.proof_sha256;
  return value;
}

function processProofRaw(input: Scenario, request: JsonObject): JsonObject {
  const process = input.plan.processes[0]!;
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
    schema_version: 'dataset-flow-identity-process-rewrite-result.v2',
    scope_id: SCOPE_ID,
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    ordinal: 1,
    process_id: process.id,
    process_version: process.version,
    process_request_sha256: request.process_request_sha256,
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
    derivative_batch_id: DERIVATIVE_BATCH_ID,
    status: 'completed',
    replay: false,
  };
}

function finalizeRequest(input: Scenario): JsonObject {
  const status = parseFlowIdentityScopeStatus(
    readyStatusRaw(input),
    input.plan,
    SCOPE_ID,
    HASH('scope-proof'),
  );
  return buildFlowIdentityFinalizeRequest({
    scopeProofSha256: HASH('scope-proof'),
    plan: input.plan,
    status,
  });
}

function finalizeRaw(
  input: Scenario,
  request: JsonObject,
  variant: 'completed' | 'pending' | 'live_drift' | 'failed' | 'compensation',
): JsonObject {
  const ready = readyStatusRaw(input);
  const whole = structuredClone(ready.whole_scope_proof as JsonObject);
  if (variant === 'completed') {
    const terminal = scopeStatusRaw({
      input,
      phase: 'completed',
      processRequestSha256: String(processRequest(input).process_request_sha256),
    });
    Object.assign(whole, terminal.whole_scope_proof as JsonObject);
  } else if (variant === 'live_drift') {
    whole.primary_current = false;
    whole.derivatives_current = false;
    whole.causal_terminal_proof = false;
    whole.proof_sha256 = HASH('finalize-live-drift');
  }
  const expected = request.expected as JsonObject;
  const completed = variant === 'completed';
  const liveDrift = variant === 'live_drift';
  const failed = variant === 'failed';
  const compensation = variant === 'compensation';
  return {
    ok: !failed && !liveDrift && !compensation,
    command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
    schema_version: 'dataset-flow-identity-scope-finalize-result.v2',
    scope_id: SCOPE_ID,
    receipt_id: input.plan.receipt_id,
    receipt_proof_sha256: input.plan.receipt_proof_sha256,
    mapping_guard_set_sha256: input.plan.mapping_guard_set_sha256,
    process_intent_set_sha256: input.plan.process_intent_set_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    permit_generation_before: 0,
    operation_id: input.plan.operation_id,
    plan_sha256: input.plan.plan_sha256,
    scope_proof_sha256: HASH('scope-proof'),
    status: completed
      ? 'completed'
      : liveDrift
        ? 'live_drift'
        : failed
          ? 'failed'
          : 'derivatives_pending',
    ...(!completed
      ? {
          code: compensation
            ? 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED'
            : failed
              ? 'FLOW_IDENTITY_FINALIZE_FAILED'
              : liveDrift
                ? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT'
                : 'FLOW_IDENTITY_DERIVATIVES_PENDING',
          compensation_required: compensation,
          automatic_retry: false,
          compensation_targets: compensation ? [compensationTarget(input, false)] : [],
        }
      : {}),
    process_count: expected.process_count,
    completed_process_count: expected.completed_process_count,
    rewrite_count: expected.rewrite_count,
    primary_closure_sha256: whole.primary_closure_sha256,
    protected_closure_sha256: whole.protected_closure_sha256,
    derivative_target_set_sha256: HASH('db-derivative-target-set'),
    derivative_proof_set_sha256: whole.derivative_proof_set_sha256,
    primary_current: whole.primary_current,
    live_guard_current: Boolean(
      whole.audit_current &&
      whole.source_guards_current &&
      whole.support_guards_current &&
      whole.target_guards_current &&
      whole.protected_closure_current &&
      whole.occurrence_closure_current,
    ),
    derivatives_current: whole.derivatives_current,
    terminal_proof_sha256: completed ? HASH('terminal-proof') : null,
    whole_scope_proof: whole,
    whole_scope_proof_sha256: whole.proof_sha256,
    audit_id: completed ? 'finalize-audit-1' : null,
    replay: false,
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

function contextFor(input: Scenario, fetchImpl: FetchLike): DatasetMaintenanceRemoteContext {
  return {
    project_ref: input.plan.project_ref,
    rest_base_url: 'https://production-project.supabase.co/rest/v1',
    publishable_key: 'publishable',
    access_token: 'access',
    account: { ...input.plan.account, session_source: 'test' },
    fetch_impl: fetchImpl,
    timeout_ms: 1_000,
  };
}

function commandFor(input: ReturnType<typeof materializeExecutionScenario>, name: string) {
  return {
    planPath: input.planPath,
    freezePath: input.freezePath,
    approvalPath: input.approvalPath,
    outDir: path.join(path.dirname(input.planPath), name),
    commit: true,
    statusOnly: false,
    approveExecution: buildFlowIdentityExecutionIdentity({
      plan: input.plan,
      freeze: input.freeze,
      approval: input.approval,
    }).identity_sha256,
    confirm: input.plan.account.email,
    waitSeconds: 0,
    pollMs: 100,
    env: {},
    fetchImpl: (async () => {
      throw new Error('unused');
    }) as FetchLike,
  };
}

function materializeRecoveryScenario(options: {
  root: string;
  baseline: (input: ReturnType<typeof materializeExecutionScenario>) => JsonObject;
  proofKind?: 'preflight' | 'lookup';
  processIds?: string[];
}) {
  const input = materializeExecutionScenario(path.join(options.root, 'input'), options.processIds);
  const identity = buildFlowIdentityExecutionIdentity({
    plan: input.plan,
    freeze: input.freeze,
    approval: input.approval,
  });
  const scope = options.proofKind === 'lookup' ? scopeLookupRaw(input) : scopePreflightRaw(input);
  const baselineRaw = options.baseline(input);
  const baseline = parseFlowIdentityScopeStatus(
    baselineRaw,
    input.plan,
    String(scope.scope_id),
    String(scope.scope_proof_sha256),
  );
  const remainingProcessPosts = input.plan.processes.length - baseline.completed_process_count;
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
    recovery_reason:
      remainingProcessPosts === 0
        ? 'derivatives_became_ready_after_wrapper_exit'
        : 'wrapper_exited_without_permit',
    recovery_mode: remainingProcessPosts === 0 ? 'finalize_only' : 'resume_and_finalize',
    baseline: {
      status: baseline.status,
      completed_process_count: baseline.completed_process_count,
      next_ordinal: baseline.next_ordinal,
      primary_complete: baseline.primary_complete,
      primary_current: baseline.primary_current,
      live_guard_current: baseline.live_guard_current,
      protected_closure_current: baseline.protected_closure_current,
      derivatives_current: baseline.derivatives_current,
      whole_scope_proof_sha256: baseline.whole_scope_proof_sha256,
    },
    toolchain_evidence_sha256: HASH('recovery-toolchain'),
    approval_reusable: false,
    maximum_wrapper_invocations: 1,
    maximum_cli_apply_spawns: 1,
    maximum_process_posts: remainingProcessPosts,
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
  const recoveryRunDir = path.join(options.root, 'recovery-input');
  writePrivateImmutableJson(
    path.join(
      recoveryRunDir,
      options.proofKind === 'lookup' ? 'scope-lookup-proof.json' : 'scope-preflight-proof.json',
    ),
    scope,
  );
  const recoveryFreezePath = path.join(options.root, 'recovery-freeze.json');
  const recoveryApprovalPath = path.join(options.root, 'recovery-approval.json');
  writePrivateImmutableJson(recoveryFreezePath, recoveryFreeze);
  writePrivateImmutableJson(recoveryApprovalPath, recoveryApproval);
  const command = {
    ...commandFor(input, 'run'),
    recoveryFreezePath,
    recoveryApprovalPath,
    recoveryRunDir,
    approveExecution: recoveryApproval.recovery_approval_identity_sha256,
  };
  return {
    input,
    identity,
    scope,
    baselineRaw,
    recoveryFreeze,
    recoveryApproval,
    command,
  };
}

function recoveryEnvelope(
  scenario: ReturnType<typeof materializeRecoveryScenario>,
  request: JsonObject,
): JsonObject {
  return {
    ok: true,
    command: 'cmd_dataset_flow_identity_scope_recover_guarded',
    schema_version: 'dataset-flow-identity-scope-recovery-result.v1',
    scope_id: scenario.recoveryFreeze.scope_id,
    scope_proof_sha256: scenario.recoveryFreeze.scope_proof_sha256,
    status: scenario.recoveryFreeze.baseline.status,
    completed_process_count: scenario.recoveryFreeze.baseline.completed_process_count,
    next_ordinal: scenario.recoveryFreeze.baseline.next_ordinal,
    whole_scope_proof_sha256: scenario.recoveryFreeze.baseline.whole_scope_proof_sha256,
    recovery_wire_request_sha256: flowIdentityRestrictedSha256(request),
    recovery_approval_identity_sha256: scenario.recoveryApproval.recovery_approval_identity_sha256,
    invocation_id: WRAPPER_INVOCATION_ID,
    audit_id: 'recovery-audit-1',
    replay: false,
    execution_permit: executionPermit(0),
  };
}

function recoveryDependencies(
  scenario: ReturnType<typeof materializeRecoveryScenario>,
  overrides: Record<string, unknown> = {},
) {
  return {
    resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
      contextFor(scenario.input, fetchImpl),
    preflight: async () => {
      throw new Error('recovery must not invoke initial preflight');
    },
    lookup: async () => {
      throw new Error('recovery must not invoke scope lookup');
    },
    recover: async ({ request }: { request: JsonObject }) => recoveryEnvelope(scenario, request),
    rewrite: async () => {
      throw new Error('rewrite must remain unreachable');
    },
    read: async () => scenario.baselineRaw,
    finalize: async () => {
      throw new Error('finalize must remain unreachable');
    },
    sleep: async () => undefined,
    now: () => new Date('2026-07-16T05:30:00.000Z'),
    ...overrides,
  } as never;
}

function writeFinalizeAttempt(outDir: string, request: JsonObject): string {
  const requestSha256 = flowIdentityRestrictedSha256(request);
  writePrivateImmutableJson(path.join(outDir, `finalize-attempt-${requestSha256}.json`), {
    schema_version: 'dataset-flow-identity-finalize-attempt.v3',
    generated_at_utc: '2026-07-16T05:25:00.000Z',
    scope_id: SCOPE_ID,
    request_sha256: requestSha256,
    request,
    max_posts: 1,
    automatic_retry: false,
  });
  return requestSha256;
}

function writeFinalizeRejection(outDir: string, requestSha256: string, message?: string): void {
  writePrivateImmutableJson(path.join(outDir, `finalize-domain-rejection-${requestSha256}.json`), {
    schema_version: 'dataset-flow-identity-finalize-domain-rejection.v1',
    status: 'rejected',
    scope_id: SCOPE_ID,
    request_sha256: requestSha256,
    automatic_retry: false,
    approval_reusable: false,
    recovery: 'operator_review_required',
    response: {
      ok: false,
      command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
      code: 'FLOW_IDENTITY_FINALIZE_SCOPE_BUSY',
      status: 409,
      ...(message === undefined ? {} : { message }),
    },
  });
}

test('execution proof parsers cover the remaining fail-closed v2 boundaries', () => {
  const input = executionScenario();
  const preflight = scopePreflightRaw(input);
  assert.equal(parseFlowIdentityScopePreflightProof(preflight, input.plan).scope_id, SCOPE_ID);
  assert.throws(
    () =>
      parseFlowIdentityScopePreflightProof(
        { ...preflight, support_snapshot_count: input.plan.support_snapshots.length + 1 },
        input.plan,
      ),
    /support\/source counts/u,
  );

  const request = processRequest(input);
  const rawProcess = processProofRaw(input, request);
  const processOptions = {
    scopeId: SCOPE_ID,
    process: input.plan.processes[0]!,
    requestSha256: String(request.process_request_sha256),
    receiptId: input.plan.receipt_id,
    receiptProofSha256: input.plan.receipt_proof_sha256,
    mappingGuardSetSha256: input.plan.mapping_guard_set_sha256,
    processIntentSetSha256: input.plan.process_intent_set_sha256,
    processIntentProofSha256: PROCESS_INTENT_PROOF,
    processCount: input.plan.processes.length,
  };
  assert.equal(
    parseFlowIdentityProcessProof({ value: rawProcess, ...processOptions }).status,
    'completed',
  );
  assert.throws(
    () => parseFlowIdentityProcessProof({ value: rawProcess, ...processOptions, processCount: 0 }),
    /count cannot bind/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityProcessProof({
        value: {
          ...rawProcess,
          primary_complete: false,
          next_ordinal: 2,
          replay: true,
        },
        ...processOptions,
      }),
    /does not bind/u,
  );

  const completedStatus = scopeStatusRaw({
    input,
    phase: 'completed',
    processRequestSha256: String(request.process_request_sha256),
  });
  assert.equal(
    parseFlowIdentityScopeStatus(completedStatus, input.plan, SCOPE_ID, HASH('scope-proof')).status,
    'completed',
  );
  const contradictoryStatus = structuredClone(completedStatus);
  const contradictoryWhole = contradictoryStatus.whole_scope_proof as JsonObject;
  contradictoryWhole.audit_current = false;
  contradictoryWhole.proof_sha256 = HASH('contradictory-completed-status');
  contradictoryStatus.live_guard_current = false;
  contradictoryStatus.whole_scope_proof_sha256 = contradictoryWhole.proof_sha256;
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(contradictoryStatus, input.plan, SCOPE_ID, HASH('scope-proof')),
    /contradicts/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityScopeStatus(
        { ...completedStatus, completed_at: 'not-an-instant' },
        input.plan,
        SCOPE_ID,
        HASH('scope-proof'),
      ),
    /completion timestamp/u,
  );

  const whole = completedStatus.whole_scope_proof as JsonObject;
  assert.throws(
    () =>
      parseFlowIdentityWholeScopeProof({
        value: null,
        scopeId: SCOPE_ID,
        receiptId: input.plan.receipt_id,
      }),
    /whole-scope proof is invalid/u,
  );
  assert.throws(
    () =>
      parseFlowIdentityWholeScopeProof({
        value: { ...whole, receipt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        scopeId: SCOPE_ID,
        receiptId: input.plan.receipt_id,
      }),
    /does not bind/u,
  );
  assert.throws(
    () =>
      executionInternals.parseCompensationEnvelope(
        {
          status: 'derivatives_pending',
          code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
          compensation_required: true,
          automatic_retry: false,
          compensation_targets: [],
        },
        input.plan,
        SCOPE_ID,
        'scope_read',
      ),
    /Required derivative compensation envelope/u,
  );

  const finalRequest = finalizeRequest(input);
  for (const variant of ['completed', 'live_drift', 'failed'] as const) {
    const value = finalizeRaw(input, finalRequest, variant);
    assert.equal(
      parseFlowIdentityFinalizeProof({
        value,
        plan: input.plan,
        scopeId: SCOPE_ID,
        scopeProofSha256: HASH('scope-proof'),
        request: finalRequest,
      }).status,
      variant,
    );
  }

  const staleCompleted = finalizeRaw(input, finalRequest, 'completed');
  const staleCompletedWhole = staleCompleted.whole_scope_proof as JsonObject;
  staleCompletedWhole.audit_current = false;
  staleCompletedWhole.proof_sha256 = HASH('stale-completed-finalize');
  staleCompleted.live_guard_current = false;
  staleCompleted.whole_scope_proof_sha256 = staleCompletedWhole.proof_sha256;
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: staleCompleted,
        plan: input.plan,
        scopeId: SCOPE_ID,
        scopeProofSha256: HASH('scope-proof'),
        request: finalRequest,
      }),
    /not dynamically current/u,
  );

  const invalidLiveDrift = finalizeRaw(input, finalRequest, 'live_drift');
  invalidLiveDrift.code = 'FOREIGN';
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: invalidLiveDrift,
        plan: input.plan,
        scopeId: SCOPE_ID,
        scopeProofSha256: HASH('scope-proof'),
        request: finalRequest,
      }),
    /non-compensable dynamic downgrade/u,
  );

  const contradictoryLiveDrift = finalizeRaw(input, finalRequest, 'live_drift');
  const contradictoryLiveWhole = contradictoryLiveDrift.whole_scope_proof as JsonObject;
  contradictoryLiveWhole.primary_current = true;
  contradictoryLiveWhole.proof_sha256 = HASH('contradictory-live-drift');
  contradictoryLiveDrift.primary_current = true;
  contradictoryLiveDrift.whole_scope_proof_sha256 = contradictoryLiveWhole.proof_sha256;
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: contradictoryLiveDrift,
        plan: input.plan,
        scopeId: SCOPE_ID,
        scopeProofSha256: HASH('scope-proof'),
        request: finalRequest,
      }),
    /non-compensable dynamic downgrade/u,
  );

  const invalidFailed = finalizeRaw(input, finalRequest, 'failed');
  invalidFailed.code = 'FOREIGN';
  assert.throws(
    () =>
      parseFlowIdentityFinalizeProof({
        value: invalidFailed,
        plan: input.plan,
        scopeId: SCOPE_ID,
        scopeProofSha256: HASH('scope-proof'),
        request: finalRequest,
      }),
    /exact non-compensable/u,
  );
});

test('runner pure guards cover pending ledger and completed closure decisions', () => {
  const input = executionScenario();
  const parsedPending = parseFlowIdentityScopeStatus(
    scopeStatusRaw({ input, phase: 'pending' }),
    input.plan,
    SCOPE_ID,
    HASH('scope-proof'),
  );
  const prepared = {
    templates: [{ process: {}, rewrites: [], collision_ledger: {} }],
  } as never;
  assert.equal(runInternals.requirePendingProcess(prepared, parsedPending, 1).ledger.ordinal, 1);
  assert.throws(
    () => runInternals.requirePendingProcess({ templates: [] } as never, parsedPending, 1),
    /pending next ordinal/u,
  );
  assert.throws(
    () => runInternals.requirePendingProcess(prepared, { ...parsedPending, processes: [] }, 1),
    /pending next ordinal/u,
  );
  assert.throws(
    () =>
      runInternals.requirePendingProcess(
        prepared,
        {
          ...parsedPending,
          processes: [{ ...parsedPending.processes[0]!, status: 'completed' }],
        },
        1,
      ),
    /pending next ordinal/u,
  );

  const parsedCompleted = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'completed',
      processRequestSha256: String(processRequest(input).process_request_sha256),
    }),
    input.plan,
    SCOPE_ID,
    HASH('scope-proof'),
  );
  assert.equal(runInternals.completedRunStatus(parsedCompleted), 'passed');
  assert.equal(
    runInternals.completedRunStatus({ ...parsedCompleted, derivatives_current: false }),
    'blocked',
  );
});

test('fresh flow identity admission rejects every bound desired candidate before any claim or transport', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-language-admission-'));
  try {
    const input = materializeExecutionScenario(root, [PROCESS_ID, PROCESS_ID_2]);
    const command = commandFor(input, 'run');
    const prepared = runInternals.prepareRun(command);
    const candidate = structuredClone(input.process_templates[1]!.desired_payload);
    const process = candidate.processDataSet as JsonObject;
    process.generalComment = [
      { '@xml:lang': 'en', '#text': 'first', '@note': 'retained' },
      { '@xml:lang': 'en', '#text': 'second' },
    ];
    prepared.plan.processes[1]!.desired_payload_sha256 = sha256Json(candidate);
    const manifest = prepared.plan.processes[1]!;
    const stem = runInternals.processStem(manifest.ordinal, manifest.id, manifest.version);
    writeFileSync(
      path.join(root, input.plan.artifacts.desired_payload_dir, `${stem}.json`),
      `${stableJsonText(candidate)}\n`,
      { mode: 0o600 },
    );
    const calls: string[] = [];
    await assert.rejects(
      runInternals.executeRun(
        command,
        {
          resolveContext: async ({ fetchImpl }) => {
            calls.push('auth');
            return contextFor(input, fetchImpl);
          },
          claimApproval: () => {
            calls.push('claim');
            return '';
          },
          preflight: async () => {
            calls.push('preflight');
            throw new Error('unexpected preflight');
          },
          rewrite: async () => {
            calls.push('rewrite');
            return {};
          },
          read: async () => {
            calls.push('read');
            return {};
          },
          finalize: async () => {
            calls.push('finalize');
            return {};
          },
          sleep: async () => undefined,
          now: () => new Date('2026-07-16T05:00:00.000Z'),
        },
        prepared,
      ),
      (error: unknown) => (error as { code?: string }).code === 'DATASET_DUPLICATE_LANGUAGE',
    );
    assert.deepEqual(calls, []);
    assert.equal(existsSync(path.join(command.outDir, 'scope-preflight-attempt.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flow identity admission binds desired bytes and preserves historical readback and completed recovery rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-language-history-'));
  try {
    const input = materializeExecutionScenario(path.join(root, 'initial'));
    const command = commandFor(input, 'run');
    const prepared = runInternals.prepareRun(command);
    const process = input.plan.processes[0]!;
    const stem = runInternals.processStem(process.ordinal, process.id, process.version);
    const desiredPath = path.join(
      path.dirname(input.planPath),
      input.plan.artifacts.desired_payload_dir,
      `${stem}.json`,
    );
    for (const desired of [null, { processDataSet: {} }]) {
      writeFileSync(desiredPath, `${stableJsonText(desired)}\n`, { mode: 0o600 });
      assert.throws(
        () => runInternals.assertFreshDesiredProcessLanguages(command, prepared),
        (error: unknown) =>
          (error as { code?: string }).code === 'DATASET_FLOW_IDENTITY_DESIRED_PAYLOAD_INVALID',
      );
    }
    rmSync(desiredPath);
    writePrivateImmutableJson(
      path.join(command.outDir, 'scope-preflight-proof.json'),
      scopePreflightRaw(input),
    );
    command.commit = false;
    command.statusOnly = true;
    const result = await runInternals.executeRun(command, {
      resolveContext: async ({ fetchImpl }) => contextFor(input, fetchImpl),
      preflight: async () => {
        throw new Error('historical admission');
      },
      rewrite: async () => {
        throw new Error('historical rewrite');
      },
      read: async () => scopeStatusRaw({ input, phase: 'completed' }),
      finalize: async () => {
        throw new Error('historical finalize');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(result.status, 'passed');

    const recovery = materializeRecoveryScenario({
      root: path.join(root, 'recovery'),
      processIds: [PROCESS_ID, PROCESS_ID_2],
      baseline: (input) => scopeStatusRaw({ input, phase: 'pending', completedProcessCount: 1 }),
    });
    const recoveryPrepared = runInternals.prepareRun(recovery.command);
    const complete = recovery.input.plan.processes[0]!;
    rmSync(
      path.join(
        path.dirname(recovery.input.planPath),
        recovery.input.plan.artifacts.desired_payload_dir,
        `${runInternals.processStem(complete.ordinal, complete.id, complete.version)}.json`,
      ),
    );
    assert.doesNotThrow(() =>
      runInternals.assertFreshDesiredProcessLanguages(recovery.command, recoveryPrepared),
    );
    const pending = recovery.input.plan.processes[1]!;
    const pendingPath = path.join(
      path.dirname(recovery.input.planPath),
      recovery.input.plan.artifacts.desired_payload_dir,
      `${runInternals.processStem(pending.ordinal, pending.id, pending.version)}.json`,
    );
    const duplicate = {
      processDataSet: {
        generalComment: [
          { '@xml:lang': 'en', '#text': 'one' },
          { '@xml:lang': 'en', '#text': 'two' },
        ],
      },
    };
    recoveryPrepared.plan.processes[1]!.desired_payload_sha256 = sha256Json(duplicate);
    writeFileSync(pendingPath, `${stableJsonText(duplicate)}\n`, { mode: 0o600 });
    assert.throws(
      () => runInternals.assertFreshDesiredProcessLanguages(recovery.command, recoveryPrepared),
      (error: unknown) => (error as { code?: string }).code === 'DATASET_DUPLICATE_LANGUAGE',
    );
    writePrivateImmutableJson(
      path.join(recovery.command.outDir, 'scope-recovery-attempt.json'),
      {},
    );
    assert.doesNotThrow(() =>
      runInternals.assertFreshDesiredProcessLanguages(recovery.command, recoveryPrepared),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner wait helper applies its zero-second default', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-wait-default-'));
  try {
    const input = materializeExecutionScenario(root);
    const { waitSeconds, ...command } = commandFor(input, 'run');
    assert.equal(waitSeconds, 0);
    const prepared = runInternals.prepareRun(command);
    const context = contextFor(input, command.fetchImpl);
    const scope = parseFlowIdentityScopePreflightProof(scopePreflightRaw(input), input.plan);
    const initial = parseFlowIdentityScopeStatus(
      scopeStatusRaw({ input, phase: 'pending' }),
      input.plan,
      SCOPE_ID,
      HASH('scope-proof'),
    );
    const result = await runInternals.waitForFinalizeDecision({
      command,
      prepared,
      context,
      scope,
      initial,
      dependencies: {
        resolveContext: async () => context,
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => ({}),
        read: async () => scopeStatusRaw({ input, phase: 'pending' }),
        finalize: async () => ({}),
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      },
    });
    assert.equal(result.status, 'sealed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner rejects a canonically encoded process template that no longer binds the manifest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-template-coverage-'));
  try {
    const input = materializeExecutionScenario(root);
    const template = input.process_templates[0]!;
    const stem = runInternals.processStem(
      template.process.ordinal,
      template.process.id,
      template.process.version,
    );
    const templatePath = path.join(root, input.plan.artifacts.process_request_dir, `${stem}.json`);
    const value = JSON.parse(readFileSync(templatePath, 'utf8')) as JsonObject;
    value.rewrites = [];
    writeFileSync(templatePath, `${stableJsonText(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    assert.throws(
      () => runInternals.prepareRun(commandFor(input, 'invalid-template')),
      /does not bind the sealed manifest/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner covers initial, status-only, and post-wait guarded decisions without mutation replay', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-run-decisions-'));
  try {
    const execute = async (options: {
      name: string;
      statusOnly?: boolean;
      statuses: (input: ReturnType<typeof materializeExecutionScenario>) => JsonObject[];
      fakeDeadline?: boolean;
    }) => {
      const input = materializeExecutionScenario(path.join(root, options.name));
      const command = commandFor(input, 'run');
      if (options.statusOnly) {
        command.commit = false;
        command.statusOnly = true;
        writePrivateImmutableJson(
          path.join(command.outDir, 'scope-preflight-proof.json'),
          scopePreflightRaw(input),
        );
      }
      command.waitSeconds = options.statuses(input).length > 1 ? 1 : 0;
      const statuses = options.statuses(input);
      let readIndex = 0;
      let finalizeCalls = 0;
      const originalNow = Date.now;
      let clock = 0;
      if (options.fakeDeadline) Date.now = () => clock;
      try {
        const result = await runInternals.executeRun(command, {
          resolveContext: async ({ fetchImpl }) => contextFor(input, fetchImpl),
          preflight: async () => scopePreflightEnvelope(input),
          rewrite: async () => {
            throw new Error('rewrite must remain unreachable');
          },
          read: async () => {
            const value = statuses[Math.min(readIndex, statuses.length - 1)]!;
            readIndex += 1;
            return value;
          },
          finalize: async () => {
            finalizeCalls += 1;
            return {};
          },
          sleep: async () => {
            if (options.fakeDeadline) clock = 1_001;
          },
          now: () => new Date('2026-07-16T05:00:00.000Z'),
        });
        return { result, finalizeCalls };
      } finally {
        Date.now = originalNow;
      }
    };

    const initialGuard = await execute({
      name: 'initial-guard',
      statuses: (input) => [guardedStatusRaw(input, 'guard_drift')],
    });
    assert.equal(initialGuard.result.status, 'blocked');
    assert.equal(initialGuard.finalizeCalls, 0);

    const primaryDrift = await execute({
      name: 'primary-drift',
      statuses: (input) => [guardedStatusRaw(input, 'primary_drift')],
    });
    assert.equal(primaryDrift.result.status, 'blocked');
    assert.equal(primaryDrift.finalizeCalls, 0);

    const initialCodeFallback = await execute({
      name: 'initial-code-fallback',
      statuses: (input) => [liveDriftRawWithoutReturnedCode(input)],
    });
    assert.equal(
      initialCodeFallback.result.issues[0]?.code,
      'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
    );

    const statusCompensation = await execute({
      name: 'status-compensation',
      statusOnly: true,
      statuses: (input) => [compensationStatusRaw(input)],
    });
    assert.equal(statusCompensation.result.status, 'pending');
    assert.equal(
      statusCompensation.result.issues[0]?.code,
      'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
    );

    const statusReady = await execute({
      name: 'status-ready',
      statusOnly: true,
      statuses: (input) => [readyStatusRaw(input)],
    });
    assert.equal(statusReady.result.issues[0]?.code, 'FLOW_IDENTITY_FINALIZE_READY');

    for (const [name, terminal, expected] of [
      [
        'completed',
        (input: Scenario) =>
          scopeStatusRaw({
            input,
            phase: 'completed',
            processRequestSha256: String(processRequest(input).process_request_sha256),
          }),
        'passed',
      ],
      ['live-drift', (input: Scenario) => liveDriftRaw(input), 'blocked'],
      ['failed', (input: Scenario) => failedStatusRaw(input), 'failed'],
    ] as const) {
      const statusResult = await execute({
        name: `status-transition-${name}`,
        statusOnly: true,
        statuses: (input) => [scopeStatusRaw({ input, phase: 'pending' }), terminal(input)],
      });
      assert.equal(statusResult.result.status, expected);
      assert.equal(statusResult.finalizeCalls, 0);

      const postWaitResult = await execute({
        name: `post-wait-${name}`,
        statuses: (input) => [
          scopeStatusRaw({
            input,
            phase: 'primary',
            processRequestSha256: String(processRequest(input).process_request_sha256),
          }),
          terminal(input),
        ],
      });
      assert.equal(postWaitResult.result.status, expected);
      assert.equal(postWaitResult.finalizeCalls, 0);
    }

    const postWaitGuard = await execute({
      name: 'post-wait-guard',
      fakeDeadline: true,
      statuses: (input) => [
        scopeStatusRaw({
          input,
          phase: 'primary',
          processRequestSha256: String(processRequest(input).process_request_sha256),
        }),
        guardedStatusRaw(input, 'guard_drift'),
      ],
    });
    assert.equal(postWaitGuard.result.status, 'blocked');
    assert.equal(postWaitGuard.finalizeCalls, 0);

    const postWaitCompensation = await execute({
      name: 'post-wait-compensation',
      statuses: (input) => [
        scopeStatusRaw({
          input,
          phase: 'primary',
          processRequestSha256: String(processRequest(input).process_request_sha256),
        }),
        compensationStatusRaw(input),
      ],
    });
    assert.equal(postWaitCompensation.result.status, 'pending');
    assert.equal(
      postWaitCompensation.result.issues[0]?.code,
      'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
    );

    const postWaitCodeFallback = await execute({
      name: 'post-wait-code-fallback',
      statuses: (input) => [
        scopeStatusRaw({
          input,
          phase: 'primary',
          processRequestSha256: String(processRequest(input).process_request_sha256),
        }),
        liveDriftRawWithoutReturnedCode(input),
      ],
    });
    assert.equal(
      postWaitCodeFallback.result.issues[0]?.code,
      'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumed claim recovers a lost preflight response through one read-only lookup', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-lost-preflight-'));
  try {
    const input = materializeExecutionScenario(path.join(root, 'input'));
    const canonicalOutDir = path.join(root, 'canonical-run');
    writePrivateImmutableJson(path.join(canonicalOutDir, 'claim-anchor.json'), { ok: true });
    const stateHome = path.join(root, 'state');
    const env = { XDG_STATE_HOME: stateHome };
    const identity = buildFlowIdentityExecutionIdentity({
      plan: input.plan,
      freeze: input.freeze,
      approval: input.approval,
    });
    claimFlowIdentityApproval({
      env,
      claim: {
        schema_version: 'dataset-flow-identity-local-approval-claim.v1',
        claimed_at_utc: '2026-07-16T05:00:00.000Z',
        approval_kind: 'initial',
        approval_identity_sha256: input.approval.execution_approval_identity_sha256,
        execution_identity_sha256: identity.identity_sha256,
        request_id: identity.request_id,
        environment: 'production',
        project_ref: input.plan.project_ref,
        actor_user_id: input.plan.account.user_id,
        actor_email: input.plan.account.email,
        target_visibility: 'owner_draft',
        user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
        plan_sha256: input.plan.plan_sha256,
        freeze_sha256: input.freeze.freeze_sha256,
        canonical_out_dir: canonicalOutDir,
        maximum_cli_apply_spawns: 1,
        approval_reusable: false,
      },
    });
    const command = commandFor(input, 'caller-run');
    command.commit = false;
    command.statusOnly = true;
    command.env = env;
    let lookupCalls = 0;
    let readCalls = 0;
    let writeCalls = 0;
    const result = await runInternals.executeRun(command, {
      resolveContext: async ({ fetchImpl }) => contextFor(input, fetchImpl),
      preflight: async () => {
        writeCalls += 1;
        throw new Error('guarded preflight must not be replayed');
      },
      lookup: async () => {
        lookupCalls += 1;
        return scopeLookupRaw(input);
      },
      rewrite: async () => {
        writeCalls += 1;
        throw new Error('rewrite must remain unreachable');
      },
      read: async () => {
        readCalls += 1;
        return scopeStatusRaw({
          input,
          phase: 'completed',
          processRequestSha256: String(processRequest(input).process_request_sha256),
        });
      },
      finalize: async () => {
        writeCalls += 1;
        throw new Error('finalize must remain unreachable');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(result.status, 'passed');
    assert.equal(lookupCalls, 1);
    assert.equal(readCalls, 1);
    assert.equal(writeCalls, 0);
    assert.equal(existsSync(path.join(canonicalOutDir, 'scope-lookup-proof.json')), true);
    assert.equal(existsSync(path.join(command.outDir, 'scope-lookup-proof.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner preserves determinate preflight and process domain rejections without approval reuse', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-domain-rejection-'));
  try {
    const preflightInput = materializeExecutionScenario(path.join(root, 'preflight'));
    const preflightCommand = commandFor(preflightInput, 'run');
    let preflightCalls = 0;
    const preflightDependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(preflightInput, fetchImpl),
      preflight: async () => {
        preflightCalls += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_scope_preflight_guarded',
          code: 'FLOW_IDENTITY_PREFLIGHT_LOCK_BUSY',
          status: 409,
          message: 'Preflight lock is busy',
        };
      },
      rewrite: async () => {
        throw new Error('rewrite must remain unreachable');
      },
      read: async () => {
        throw new Error('read must remain unreachable');
      },
      finalize: async () => {
        throw new Error('finalize must remain unreachable');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const firstPreflight = await runInternals.executeRun(preflightCommand, preflightDependencies);
    const secondPreflight = await runInternals.executeRun(preflightCommand, preflightDependencies);
    assert.equal(firstPreflight.status, 'blocked');
    assert.equal(secondPreflight.status, 'blocked');
    assert.equal(firstPreflight.issues[0]?.code, 'FLOW_IDENTITY_PREFLIGHT_LOCK_BUSY');
    assert.equal(secondPreflight.issues[0]?.code, 'FLOW_IDENTITY_PREFLIGHT_LOCK_BUSY');
    assert.equal(preflightCalls, 1);
    assert.equal(
      existsSync(path.join(preflightCommand.outDir, 'scope-preflight-domain-rejection.json')),
      true,
    );

    const processInput = materializeExecutionScenario(path.join(root, 'process'));
    const processCommand = commandFor(processInput, 'run');
    let processPreflightCalls = 0;
    let rewriteCalls = 0;
    const processDependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(processInput, fetchImpl),
      preflight: async () => {
        processPreflightCalls += 1;
        return scopePreflightEnvelope(processInput);
      },
      rewrite: async () => {
        rewriteCalls += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
          code: 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY',
          status: 409,
          message: 'Process scope is busy',
        };
      },
      read: async () => scopeStatusRaw({ input: processInput, phase: 'pending' }),
      finalize: async () => {
        throw new Error('finalize must remain unreachable');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const firstProcess = await runInternals.executeRun(processCommand, processDependencies);
    const secondProcess = await runInternals.executeRun(processCommand, processDependencies);
    assert.equal(firstProcess.status, 'blocked');
    assert.equal(secondProcess.status, 'blocked');
    assert.equal(firstProcess.issues[0]?.code, 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY');
    assert.equal(
      secondProcess.issues[0]?.code,
      'DATASET_FLOW_IDENTITY_FRESH_RECOVERY_APPROVAL_REQUIRED',
    );
    assert.equal(processPreflightCalls, 1);
    assert.equal(rewriteCalls, 1);
    assert.equal(
      existsSync(path.join(processCommand.outDir, 'process-domain-rejection-000001.json')),
      true,
    );
    assert.equal(
      (
        JSON.parse(
          readFileSync(
            path.join(processCommand.outDir, 'process-domain-rejection-000001.json'),
            'utf8',
          ),
        ) as JsonObject
      ).recovery,
      'operator_review_required',
    );

    const partialInput = materializeExecutionScenario(path.join(root, 'partial'), [
      PROCESS_ID,
      PROCESS_ID_2,
    ]);
    const partialCommand = commandFor(partialInput, 'run');
    let partialReads = 0;
    let partialRewrites = 0;
    const partialStatus = () =>
      scopeStatusRaw({
        input: partialInput,
        phase: 'pending',
        completedProcessCount: 1,
      });
    const partialDependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(partialInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(partialInput),
      rewrite: async () => {
        partialRewrites += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
          code: 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY',
          status: 409,
          message: 'Process scope is busy',
        };
      },
      read: async () => {
        partialReads += 1;
        return partialStatus();
      },
      finalize: async () => {
        throw new Error('finalize must remain unreachable');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const firstPartial = await runInternals.executeRun(partialCommand, partialDependencies);
    const secondPartial = await runInternals.executeRun(partialCommand, partialDependencies);
    assert.equal(firstPartial.status, 'blocked');
    assert.equal(secondPartial.status, 'blocked');
    assert.equal(firstPartial.completed_process_count, 1);
    assert.equal(firstPartial.next_ordinal, 2);
    assert.equal(partialRewrites, 1);
    assert.equal(partialReads, 3);
    assert.equal(
      firstPartial.issues.some(
        (issue) =>
          issue.code ===
          'DATASET_FLOW_IDENTITY_PARTIAL_EXECUTION_REQUIRES_STATUS_READ_AND_OPERATOR_APPROVED_SCOPE_RECOVERY',
      ),
      true,
    );
    const recoveryArtifact = JSON.parse(
      readFileSync(
        path.join(partialCommand.outDir, 'process-domain-rejection-recovery-000002.000001.json'),
        'utf8',
      ),
    ) as JsonObject;
    assert.equal(
      recoveryArtifact.recovery,
      'partial_execution_requires_status_read_and_operator_approved_scope_recovery',
    );

    const readFailureInput = materializeExecutionScenario(path.join(root, 'read-failure'));
    const readFailureCommand = commandFor(readFailureInput, 'run');
    let readFailureReads = 0;
    const readFailure = await runInternals.executeRun(readFailureCommand, {
      resolveContext: async ({ fetchImpl }) => contextFor(readFailureInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(readFailureInput),
      rewrite: async () => ({
        ok: false,
        command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
        code: 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY',
        status: 409,
      }),
      read: async () => {
        readFailureReads += 1;
        if (readFailureReads > 1) throw new Error('bounded status read failed');
        return scopeStatusRaw({ input: readFailureInput, phase: 'pending' });
      },
      finalize: async () => {
        throw new Error('finalize must remain unreachable');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(readFailure.status, 'indeterminate');
    assert.equal(readFailureReads, 2);
    assert.equal(
      readFailure.issues.some(
        (issue) =>
          issue.code === 'DATASET_FLOW_IDENTITY_PROCESS_DOMAIN_REJECTION_STATUS_READ_FAILED',
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner fails closed on stored rejection tamper and recovery admission ambiguity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-recovery-ledger-'));
  try {
    const tamperedInput = materializeExecutionScenario(path.join(root, 'tampered-scope'));
    const tamperedCommand = commandFor(tamperedInput, 'run');
    const preflightRequestSha256 = HASH('tampered-preflight-request');
    writePrivateImmutableJson(
      path.join(tamperedCommand.outDir, 'scope-preflight-domain-rejection.json'),
      {
        status: 'rejected',
        request_sha256: preflightRequestSha256,
        automatic_retry: false,
        approval_reusable: false,
        response: { ok: true },
      },
    );
    await assert.rejects(
      runInternals.executeRun(tamperedCommand, {
        resolveContext: async ({ fetchImpl }) => contextFor(tamperedInput, fetchImpl),
        preflight: async () => {
          throw new Error('tampered artifact must block preflight');
        },
        rewrite: async () => {
          throw new Error('rewrite must remain unreachable');
        },
        read: async () => {
          throw new Error('read must remain unreachable');
        },
        finalize: async () => {
          throw new Error('finalize must remain unreachable');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:30:00.000Z'),
      }),
      /does not contain an exact database domain rejection/u,
    );

    const statusOnly = materializeRecoveryScenario({
      root: path.join(root, 'status-only'),
      baseline: (input) => scopeStatusRaw({ input, phase: 'pending' }),
    });
    statusOnly.command.commit = false;
    statusOnly.command.statusOnly = true;
    await assert.rejects(
      runInternals.executeRun(statusOnly.command, recoveryDependencies(statusOnly)),
      /Recovery admission is write-capable/u,
    );

    const ambiguous = materializeRecoveryScenario({
      root: path.join(root, 'ambiguous'),
      baseline: (input) => scopeStatusRaw({ input, phase: 'pending' }),
    });
    let ambiguityReads = 0;
    let recoveryCalls = 0;
    const ambiguousResult = await runInternals.executeRun(
      ambiguous.command,
      recoveryDependencies(ambiguous, {
        recover: async () => {
          recoveryCalls += 1;
          throw new Error('recovery response lost');
        },
        read: async () => {
          ambiguityReads += 1;
          if (ambiguityReads === 1) return ambiguous.baselineRaw;
          throw new Error('single ambiguity status read failed');
        },
      }),
    );
    assert.equal(ambiguousResult.status, 'indeterminate');
    assert.equal(ambiguousResult.database_status, null);
    assert.equal(recoveryCalls, 1);
    assert.equal(ambiguityReads, 2);

    const storedProcess = materializeRecoveryScenario({
      root: path.join(root, 'stored-process-rejection'),
      baseline: (input) => scopeStatusRaw({ input, phase: 'pending' }),
      proofKind: 'preflight',
    });
    const processRequestSha256 = String(processRequest(storedProcess.input).process_request_sha256);
    writePrivateImmutableJson(
      path.join(storedProcess.command.outDir, 'process-attempt-000001.json'),
      {
        schema_version: 'dataset-flow-identity-process-attempt.v2',
        process_request_sha256: processRequestSha256,
      },
    );
    writePrivateImmutableJson(
      path.join(storedProcess.command.outDir, 'process-domain-rejection-000001.json'),
      {
        schema_version: 'dataset-flow-identity-process-domain-rejection.v2',
        status: 'rejected',
        ordinal: 1,
        process_request_sha256: processRequestSha256,
        automatic_retry: false,
        approval_reusable: false,
        recovery: 'operator_review_required',
        response: {
          ok: false,
          command: 'cmd_dataset_flow_identity_process_rewrite_guarded',
          code: 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY',
          status: 409,
        },
      },
    );
    let rewriteCalls = 0;
    const storedProcessResult = await runInternals.executeRun(
      storedProcess.command,
      recoveryDependencies(storedProcess, {
        rewrite: async () => {
          rewriteCalls += 1;
          throw new Error('stored rejection must suppress process replay');
        },
      }),
    );
    assert.equal(storedProcessResult.status, 'blocked');
    assert.equal(storedProcessResult.issues[0]?.code, 'FLOW_IDENTITY_PROCESS_SCOPE_BUSY');
    assert.equal(rewriteCalls, 0);
    assert.equal(
      existsSync(path.join(storedProcess.command.outDir, 'scope-preflight-proof.json')),
      true,
    );

    const storedAmbiguous = materializeRecoveryScenario({
      root: path.join(root, 'stored-process-ambiguous'),
      baseline: (input) => scopeStatusRaw({ input, phase: 'pending' }),
    });
    writePrivateImmutableJson(
      path.join(storedAmbiguous.command.outDir, 'process-attempt-000001.json'),
      {
        schema_version: 'dataset-flow-identity-process-attempt.v2',
        process_request_sha256: String(
          processRequest(storedAmbiguous.input).process_request_sha256,
        ),
      },
    );
    let ambiguousRewriteCalls = 0;
    const storedAmbiguousResult = await runInternals.executeRun(
      storedAmbiguous.command,
      recoveryDependencies(storedAmbiguous, {
        rewrite: async () => {
          ambiguousRewriteCalls += 1;
          throw new Error('ambiguous marker must suppress process replay');
        },
      }),
    );
    assert.equal(storedAmbiguousResult.status, 'blocked');
    assert.equal(
      storedAmbiguousResult.issues[0]?.code,
      'DATASET_FLOW_IDENTITY_PROCESS_ATTEMPT_AMBIGUOUS',
    );
    assert.equal(ambiguousRewriteCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner classifies finalize variants and performs one read-only recovery after transport loss', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-finalize-coverage-'));
  try {
    for (const [variant, expected] of [
      ['live_drift', 'blocked'],
      ['failed', 'failed'],
      ['compensation', 'pending'],
    ] as const) {
      const input = materializeExecutionScenario(path.join(root, variant));
      const command = commandFor(input, 'run');
      const request = finalizeRequest(input);
      let reads = 0;
      const result = await runInternals.executeRun(command, {
        resolveContext: async ({ fetchImpl }) => contextFor(input, fetchImpl),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          throw new Error('rewrite must remain unreachable');
        },
        read: async () => {
          reads += 1;
          return readyStatusRaw(input);
        },
        finalize: async () => finalizeRaw(input, request, variant),
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      });
      assert.equal(result.status, expected);
      assert.equal(reads, 2);
      if (variant === 'compensation') {
        assert.equal(result.issues[0]?.code, 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED');
      }
    }

    const domainInput = materializeExecutionScenario(path.join(root, 'domain'));
    const domainCommand = commandFor(domainInput, 'run');
    const domainRequestSha256 = flowIdentityRestrictedSha256(finalizeRequest(domainInput));
    let domainFinalizeCalls = 0;
    const domainDependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(domainInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(domainInput),
      rewrite: async () => {
        throw new Error('rewrite must remain unreachable');
      },
      read: async () => readyStatusRaw(domainInput),
      finalize: async () => {
        domainFinalizeCalls += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
          code: 'FLOW_IDENTITY_FINALIZE_SCOPE_BUSY',
          status: 409,
          message: 'Finalize scope is busy',
        };
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const firstDomain = await runInternals.executeRun(domainCommand, domainDependencies);
    const secondDomain = await runInternals.executeRun(domainCommand, domainDependencies);
    assert.equal(firstDomain.status, 'blocked');
    assert.equal(secondDomain.status, 'blocked');
    assert.equal(domainFinalizeCalls, 1);
    assert.equal(
      existsSync(path.join(domainCommand.outDir, `finalize-attempt-${domainRequestSha256}.json`)),
      true,
    );
    assert.equal(
      existsSync(
        path.join(domainCommand.outDir, `finalize-domain-rejection-${domainRequestSha256}.json`),
      ),
      true,
    );
    assert.equal(
      existsSync(
        path.join(domainCommand.outDir, `finalize-transport-error-${domainRequestSha256}.json`),
      ),
      false,
    );

    for (const variant of [
      'completed-with-permit',
      'pending-without-permit',
      'rejected-with-permit',
      'invalid-response',
    ] as const) {
      const input = materializeExecutionScenario(path.join(root, variant));
      const command = commandFor(input, 'run');
      const request = finalizeRequest(input);
      let finalizeCalls = 0;
      const result = await runInternals.executeRun(command, {
        resolveContext: async ({ fetchImpl }) => contextFor(input, fetchImpl),
        preflight: async () => scopePreflightEnvelope(input),
        rewrite: async () => {
          throw new Error('rewrite must remain unreachable');
        },
        read: async () => readyStatusRaw(input),
        finalize: async () => {
          finalizeCalls += 1;
          if (variant === 'completed-with-permit') {
            return {
              ...finalizeRaw(input, request, 'completed'),
              execution_permit: executionPermit(1),
            };
          }
          if (variant === 'pending-without-permit') {
            return {
              ...finalizeRaw(input, request, 'pending'),
              execution_permit: null,
            };
          }
          return variant === 'rejected-with-permit'
            ? {
                ...finalizeRaw(input, request, 'failed'),
                execution_permit: executionPermit(1),
              }
            : { ok: true };
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      });
      assert.equal(result.status, 'indeterminate');
      assert.equal(finalizeCalls, 1);
      assert.equal(result.issues[0]?.code, 'DATASET_FLOW_IDENTITY_FINALIZE_RESPONSE_AMBIGUOUS');
    }

    const invalidStoredInput = materializeExecutionScenario(
      path.join(root, 'invalid-stored-finalize'),
    );
    const invalidStoredCommand = commandFor(invalidStoredInput, 'run');
    const invalidStoredRequest = finalizeRequest(invalidStoredInput);
    const invalidStoredRequestSha256 = flowIdentityRestrictedSha256(invalidStoredRequest);
    writePrivateImmutableJson(
      path.join(invalidStoredCommand.outDir, `finalize-attempt-${invalidStoredRequestSha256}.json`),
      {
        schema_version: 'dataset-flow-identity-finalize-attempt.v3',
        generated_at_utc: '2026-07-16T05:00:00.000Z',
        scope_id: SCOPE_ID,
        request_sha256: invalidStoredRequestSha256,
        request: invalidStoredRequest,
        max_posts: 2,
        automatic_retry: false,
      },
    );
    await assert.rejects(
      runInternals.executeRun(invalidStoredCommand, {
        resolveContext: async ({ fetchImpl }) => contextFor(invalidStoredInput, fetchImpl),
        preflight: async () => scopePreflightEnvelope(invalidStoredInput),
        rewrite: async () => {
          throw new Error('rewrite must remain unreachable');
        },
        read: async () => readyStatusRaw(invalidStoredInput),
        finalize: async () => {
          throw new Error('invalid stored attempt must block finalize');
        },
        sleep: async () => undefined,
        now: () => new Date('2026-07-16T05:00:00.000Z'),
      }),
      /does not bind the exact request/u,
    );

    const ambiguousInput = materializeExecutionScenario(path.join(root, 'ambiguous'));
    const ambiguousCommand = commandFor(ambiguousInput, 'run');
    const ambiguousRequestSha256 = flowIdentityRestrictedSha256(finalizeRequest(ambiguousInput));
    let ambiguousFinalizeCalls = 0;
    const ambiguousDependencies = {
      resolveContext: async ({ fetchImpl }: { fetchImpl: FetchLike }) =>
        contextFor(ambiguousInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(ambiguousInput),
      rewrite: async () => {
        throw new Error('rewrite must remain unreachable');
      },
      read: async () => readyStatusRaw(ambiguousInput),
      finalize: async () => {
        ambiguousFinalizeCalls += 1;
        throw new Error('finalize response lost');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    };
    const firstAmbiguous = await runInternals.executeRun(ambiguousCommand, ambiguousDependencies);
    const secondAmbiguous = await runInternals.executeRun(ambiguousCommand, ambiguousDependencies);
    assert.equal(firstAmbiguous.status, 'indeterminate');
    assert.equal(secondAmbiguous.status, 'blocked');
    assert.equal(
      secondAmbiguous.issues[0]?.code,
      'DATASET_FLOW_IDENTITY_FRESH_RECOVERY_APPROVAL_REQUIRED',
    );
    assert.equal(ambiguousFinalizeCalls, 1);
    assert.equal(
      existsSync(
        path.join(
          ambiguousCommand.outDir,
          `finalize-transport-error-${ambiguousRequestSha256}.json`,
        ),
      ),
      true,
    );

    const recoveryInput = materializeExecutionScenario(path.join(root, 'recovery'));
    const recoveryCommand = commandFor(recoveryInput, 'run');
    let recoveryReads = 0;
    const recovered = await runInternals.executeRun(recoveryCommand, {
      resolveContext: async ({ fetchImpl }) => contextFor(recoveryInput, fetchImpl),
      preflight: async () => scopePreflightEnvelope(recoveryInput),
      rewrite: async () => {
        throw new Error('rewrite must remain unreachable');
      },
      read: async () => {
        recoveryReads += 1;
        return recoveryReads === 1
          ? readyStatusRaw(recoveryInput)
          : scopeStatusRaw({
              input: recoveryInput,
              phase: 'completed',
              processRequestSha256: String(processRequest(recoveryInput).process_request_sha256),
            });
      },
      finalize: async () => {
        throw new Error('finalize response lost');
      },
      sleep: async () => undefined,
      now: () => new Date('2026-07-16T05:00:00.000Z'),
    });
    assert.equal(recovered.status, 'indeterminate');
    assert.equal(recovered.database_status, 'completed');

    const invalidModeInput = materializeExecutionScenario(path.join(root, 'public-sleep'));
    await assert.rejects(
      runFlowIdentity({
        ...commandFor(invalidModeInput, 'run'),
        commit: false,
        statusOnly: false,
        sleep: async () => undefined,
      }),
      /exactly one/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery runner enforces the exact finalize attempt, rejection, and proof ledger', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-finalize-ledger-'));
  try {
    const scenario = (name: string) =>
      materializeRecoveryScenario({
        root: path.join(root, name),
        baseline: (input) => readyStatusRaw(input),
      });
    const execute = async (
      input: ReturnType<typeof materializeRecoveryScenario>,
      overrides: Record<string, unknown> = {},
    ) => runInternals.executeRun(input.command, recoveryDependencies(input, overrides));
    const writeProof = (
      input: ReturnType<typeof materializeRecoveryScenario>,
      request: JsonObject,
      requestSha256: string,
      variant: 'completed' | 'pending' | 'live_drift' | 'failed',
    ) => {
      writePrivateImmutableJson(
        path.join(input.command.outDir, `finalize-proof-${requestSha256}.json`),
        finalizeRaw(input.input, request, variant),
      );
    };

    const invalid = scenario('invalid-late-attempt');
    const invalidRequest = finalizeRequest(invalid.input);
    const invalidRequestSha256 = flowIdentityRestrictedSha256(invalidRequest);
    writePrivateImmutableJson(
      path.join(invalid.command.outDir, `finalize-attempt-${invalidRequestSha256}.json`),
      {
        schema_version: 'dataset-flow-identity-finalize-attempt.v3',
        generated_at_utc: '2026-07-16T05:25:00.000Z',
        scope_id: SCOPE_ID,
        request_sha256: invalidRequestSha256,
        request: { malformed: true },
        max_posts: 1,
        automatic_retry: false,
      },
    );
    await assert.rejects(execute(invalid), /does not bind the exact request/u);

    const conflict = scenario('exact-conflict');
    const conflictRequest = finalizeRequest(conflict.input);
    const conflictHash = writeFinalizeAttempt(conflict.command.outDir, conflictRequest);
    writeFinalizeRejection(conflict.command.outDir, conflictHash, 'stored rejection');
    writeProof(conflict, conflictRequest, conflictHash, 'pending');
    await assert.rejects(execute(conflict), /contradictory rejection and proof artifacts/u);

    const rejection = scenario('exact-rejection');
    const rejectionRequest = finalizeRequest(rejection.input);
    const rejectionHash = writeFinalizeAttempt(rejection.command.outDir, rejectionRequest);
    writeFinalizeRejection(rejection.command.outDir, rejectionHash);
    let exactRejectionFinalizeCalls = 0;
    const rejectionResult = await execute(rejection, {
      finalize: async () => {
        exactRejectionFinalizeCalls += 1;
        throw new Error('stored rejection must suppress finalize replay');
      },
    });
    assert.equal(rejectionResult.status, 'blocked');
    assert.equal(
      rejectionResult.issues[0]?.message,
      'The database deterministically rejected finalize.',
    );
    assert.equal(exactRejectionFinalizeCalls, 0);

    const rejectionWithMessage = scenario('exact-rejection-message');
    const rejectionWithMessageRequest = finalizeRequest(rejectionWithMessage.input);
    const rejectionWithMessageHash = writeFinalizeAttempt(
      rejectionWithMessage.command.outDir,
      rejectionWithMessageRequest,
    );
    writeFinalizeRejection(
      rejectionWithMessage.command.outDir,
      rejectionWithMessageHash,
      'Stored finalize rejection',
    );
    const rejectionWithMessageResult = await execute(rejectionWithMessage);
    assert.equal(rejectionWithMessageResult.issues[0]?.message, 'Stored finalize rejection');

    for (const [variant, expected] of [
      ['failed', 'failed'],
      ['live_drift', 'blocked'],
      ['pending', 'pending'],
    ] as const) {
      const stored = scenario(`exact-proof-${variant}`);
      const request = finalizeRequest(stored.input);
      const requestSha256 = writeFinalizeAttempt(stored.command.outDir, request);
      writeProof(stored, request, requestSha256, variant);
      let finalizeCalls = 0;
      const result = await execute(stored, {
        finalize: async () => {
          finalizeCalls += 1;
          throw new Error('stored proof must suppress finalize replay');
        },
      });
      assert.equal(result.status, expected);
      assert.equal(result.issues[0]?.code, 'DATASET_FLOW_IDENTITY_FINALIZE_REQUEST_ALREADY_PROVEN');
      assert.equal(finalizeCalls, 0);
    }

    const exactAmbiguous = scenario('exact-attempt-ambiguous');
    const exactAmbiguousRequest = finalizeRequest(exactAmbiguous.input);
    writeFinalizeAttempt(exactAmbiguous.command.outDir, exactAmbiguousRequest);
    const exactAmbiguousResult = await execute(exactAmbiguous);
    assert.equal(exactAmbiguousResult.status, 'indeterminate');
    assert.equal(
      exactAmbiguousResult.issues[0]?.code,
      'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
    );

    for (const orphanKind of ['rejection', 'proof'] as const) {
      const orphan = scenario(`orphan-${orphanKind}`);
      const request = finalizeRequest(orphan.input);
      const requestSha256 = flowIdentityRestrictedSha256(request);
      if (orphanKind === 'rejection') {
        writeFinalizeRejection(orphan.command.outDir, requestSha256);
      } else {
        writeProof(orphan, request, requestSha256, 'pending');
      }
      await assert.rejects(execute(orphan), /terminal artifact exists without its exact attempt/u);
    }

    const priorRequestFor = (input: ReturnType<typeof materializeRecoveryScenario>) => ({
      ...finalizeRequest(input.input),
      request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    const priorAmbiguous = scenario('prior-ambiguous');
    writeFinalizeAttempt(priorAmbiguous.command.outDir, priorRequestFor(priorAmbiguous));
    const priorAmbiguousResult = await execute(priorAmbiguous);
    assert.equal(priorAmbiguousResult.status, 'indeterminate');
    assert.equal(
      priorAmbiguousResult.issues[0]?.code,
      'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
    );

    const priorRejection = scenario('prior-rejection');
    const priorRejectedRequest = priorRequestFor(priorRejection);
    const priorRejectedHash = writeFinalizeAttempt(
      priorRejection.command.outDir,
      priorRejectedRequest,
    );
    writeFinalizeRejection(priorRejection.command.outDir, priorRejectedHash);
    const priorRejectionResult = await execute(priorRejection);
    assert.equal(priorRejectionResult.status, 'blocked');
    assert.equal(priorRejectionResult.issues[0]?.code, 'FLOW_IDENTITY_FINALIZE_SCOPE_BUSY');

    const vanishedPrior = scenario('prior-attempt-vanished');
    const vanishedHash = HASH('vanished-prior-attempt');
    writePrivateImmutableJson(path.join(vanishedPrior.command.outDir, 'ledger-anchor.json'), {
      purpose: 'create-private-test-directory',
    });
    symlinkSync(
      path.join(vanishedPrior.command.outDir, 'missing-finalize-attempt.json'),
      path.join(vanishedPrior.command.outDir, `finalize-attempt-${vanishedHash}.json`),
    );
    let vanishedFinalizeCalls = 0;
    const vanishedResult = await execute(vanishedPrior, {
      finalize: async () => {
        vanishedFinalizeCalls += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
          code: 'FLOW_IDENTITY_FINALIZE_SCOPE_BUSY',
          status: 409,
          message: 'Current finalize reached after vanished prior marker',
        };
      },
    });
    assert.equal(vanishedResult.status, 'blocked');
    assert.equal(vanishedFinalizeCalls, 1);

    for (const [variant, expected] of [
      ['failed', 'failed'],
      ['completed', 'blocked'],
    ] as const) {
      const prior = scenario(`prior-proof-${variant}`);
      const priorRequest = priorRequestFor(prior);
      const priorHash = writeFinalizeAttempt(prior.command.outDir, priorRequest);
      writeProof(prior, priorRequest, priorHash, variant);
      const result = await execute(prior);
      assert.equal(result.status, expected);
      assert.equal(
        result.issues[0]?.code,
        'DATASET_FLOW_IDENTITY_FINALIZE_NEW_REQUEST_NOT_AUTHORIZED',
      );
    }

    const authorized = scenario('prior-pending-authorizes-new-request');
    const authorizedPriorRequest = priorRequestFor(authorized);
    const authorizedPriorHash = writeFinalizeAttempt(
      authorized.command.outDir,
      authorizedPriorRequest,
    );
    writeProof(authorized, authorizedPriorRequest, authorizedPriorHash, 'pending');
    let authorizedFinalizeCalls = 0;
    const authorizedResult = await execute(authorized, {
      finalize: async () => {
        authorizedFinalizeCalls += 1;
        return {
          ok: false,
          command: 'cmd_dataset_flow_identity_scope_finalize_guarded',
          code: 'FLOW_IDENTITY_FINALIZE_SCOPE_BUSY',
          status: 409,
        };
      },
    });
    assert.equal(authorizedResult.status, 'blocked');
    assert.equal(
      authorizedResult.issues[0]?.message,
      'The database deterministically rejected finalize.',
    );
    assert.equal(authorizedFinalizeCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function jsonResponse(value: unknown, contentRange?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(contentRange ? { 'content-range': contentRange } : {}),
    },
  });
}

function verifyFetch(options: {
  input: ReturnType<typeof materializeExecutionScenario>;
  currentUserId?: string;
  omitStableRows?: boolean;
}): FetchLike {
  const stableRows = [
    ...options.input.capture.source_rows,
    ...options.input.capture.target_rows,
    ...options.input.capture.support_rows,
  ].map(remoteFromSnapshot);
  const desiredProcess: DatasetMaintenanceRemoteRow = {
    ...remoteFromSnapshot(options.input.capture.process_rows[0]!),
    json: options.input.process_templates[0]!.desired_payload,
    json_ordered: options.input.process_templates[0]!.desired_payload,
  };
  const status = scopeStatusRaw({
    input: options.input,
    phase: 'completed',
    processRequestSha256: String(processRequest(options.input).process_request_sha256),
  });
  return async (request) => {
    const textUrl = String(request);
    if (isSupabaseAuthTokenUrl(textUrl)) {
      return makeSupabaseAuthResponse({
        email: options.input.plan.account.email,
        userId: options.currentUserId ?? options.input.plan.account.user_id,
      });
    }
    if (textUrl.endsWith('/auth/v1/user')) {
      return jsonResponse({
        id: options.currentUserId ?? options.input.plan.account.user_id,
        email: options.input.plan.account.email,
      });
    }
    const url = new URL(textUrl);
    if (url.pathname.endsWith('/rpc/cmd_dataset_flow_identity_scope_read')) {
      return jsonResponse(status);
    }
    const table = url.pathname.split('/').at(-1) as DatasetMaintenanceRemoteRow['table'];
    const idFilter = url.searchParams.get('id');
    if (idFilter) {
      if (options.omitStableRows) return jsonResponse([]);
      const id = idFilter.replace(/^eq\./u, '');
      const version = String(url.searchParams.get('version')).replace(/^eq\./u, '');
      return jsonResponse(
        stableRows.filter((row) => row.table === table && row.id === id && row.version === version),
      );
    }
    if (table === 'processes') return jsonResponse([desiredProcess], '0-0/1');
    throw new Error(`Unexpected verification request: ${textUrl}`);
  };
}

function verifyOptions(input: ReturnType<typeof materializeExecutionScenario>, name: string) {
  const runDir = path.join(path.dirname(input.planPath), 'run-proof');
  writePrivateImmutableJson(
    path.join(runDir, 'scope-preflight-proof.json'),
    scopePreflightRaw(input),
  );
  return {
    planPath: input.planPath,
    freezePath: input.freezePath,
    approvalPath: input.approvalPath,
    runDir,
    outDir: path.join(path.dirname(input.planPath), name),
    pageSize: 1000,
    timeoutMs: 1_000,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://production-project.supabase.co/functions/v1',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      TIANGONG_LCA_FORCE_REAUTH: '1',
    }),
    fetchImpl: verifyFetch({ input }),
    now: new Date('2026-07-16T06:00:00.000Z'),
  };
}

test('public verifier performs bounded RLS readback and writes an exact passing report', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-verify-public-'));
  try {
    const input = materializeExecutionScenario(root);
    const options = verifyOptions(input, 'verify');
    const result = await verifyFlowIdentity(options);
    assert.equal(result.status, 'passed');
    assert.equal(result.checks.complete_owner_draft_process_scan, true);
    assert.equal(result.counts.source_rows, 305);
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(options.outDir, 'flow-identity-verification-report.json'), 'utf8'),
      ),
      result,
    );
    const withoutFixedNow = await verifyFlowIdentity({
      ...options,
      outDir: path.join(root, 'verify-with-runtime-clock'),
      now: undefined,
    });
    assert.equal(withoutFixedNow.status, 'passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('public verifier rejects noncanonical evidence, actor drift, capture drift, and missing stable rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-identity-verify-guards-'));
  try {
    const noncanonical = materializeExecutionScenario(path.join(root, 'noncanonical'));
    const noncanonicalOptions = verifyOptions(noncanonical, 'verify');
    const planValue = JSON.parse(readFileSync(noncanonical.planPath, 'utf8'));
    writeFileSync(noncanonical.planPath, `${JSON.stringify(planValue, null, 2)}\n`, 'utf8');
    await assert.rejects(verifyFlowIdentity(noncanonicalOptions), /must be canonical JSON/u);

    const foreignActor = materializeExecutionScenario(path.join(root, 'foreign-actor'));
    const foreignOptions = verifyOptions(foreignActor, 'verify');
    foreignOptions.fetchImpl = verifyFetch({
      input: foreignActor,
      currentUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    await assert.rejects(verifyFlowIdentity(foreignOptions), /RLS context does not match/u);

    const captureDrift = materializeExecutionScenario(path.join(root, 'capture-drift'));
    const captureOptions = verifyOptions(captureDrift, 'verify');
    const changedCapture = structuredClone(captureDrift.capture);
    changedCapture.captured_at_utc = '2026-07-16T04:10:01.000Z';
    changedCapture.artifact_evidence.live_capture_artifact_sha256 =
      computeFlowIdentityCaptureEvidenceSha256(changedCapture);
    changedCapture.capture_request.artifact_evidence.live_capture_artifact_sha256 =
      changedCapture.artifact_evidence.live_capture_artifact_sha256;
    changedCapture.attestation.capture_request_sha256 = flowIdentityRestrictedSha256(
      changedCapture.capture_request as unknown as JsonObject,
    );
    changedCapture.capture_artifact_sha256 = computeFlowIdentityCaptureSha256(changedCapture);
    writeFileSync(
      path.join(path.dirname(captureDrift.planPath), captureDrift.plan.artifacts.live_capture),
      `${stableJsonText(changedCapture)}\n`,
      'utf8',
    );
    await assert.rejects(verifyFlowIdentity(captureOptions), /does not bind the plan/u);

    const missingStable = materializeExecutionScenario(path.join(root, 'missing-stable'));
    const missingOptions = verifyOptions(missingStable, 'verify');
    missingOptions.fetchImpl = verifyFetch({ input: missingStable, omitStableRows: true });
    await assert.rejects(verifyFlowIdentity(missingOptions), /missing or ambiguous/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier readback covers nullable keys, absent affected rows, and protected occurrence drift', () => {
  const input = executionScenario();
  assert.equal(verifyInternals.rowKey('flows', TARGET_ID, VERSION, null).endsWith('\u0000'), true);
  const status = parseFlowIdentityScopeStatus(
    scopeStatusRaw({
      input,
      phase: 'completed',
      processRequestSha256: String(processRequest(input).process_request_sha256),
    }),
    input.plan,
    SCOPE_ID,
    HASH('scope-proof'),
  );
  const stableRows = [
    ...input.capture.source_rows,
    ...input.capture.target_rows,
    ...input.capture.support_rows,
  ].map(remoteFromSnapshot);
  const absent = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status,
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: [],
    processScanComplete: true,
  });
  assert.equal(absent.checks.affected_processes_exact, false);

  const desiredPayload = structuredClone(input.process_templates[0]!.desired_payload);
  const exchanges = verifyInternals.processExchanges(desiredPayload)!;
  exchanges.splice(2, 1);
  const original = remoteFromSnapshot(input.capture.process_rows[0]!);
  const protectedDrift = verifyFlowIdentityReadback({
    plan: input.plan,
    capture: input.capture,
    status,
    currentStableRows: stableRows,
    currentOwnerDraftProcesses: [
      { ...original, json: desiredPayload, json_ordered: desiredPayload },
    ],
    processScanComplete: true,
  });
  assert.equal(protectedDrift.checks.protected_closure_exact, false);
  assert.equal(
    protectedDrift.issues.some((issue) => issue.code === 'FLOW_IDENTITY_PROTECTED_REFERENCE_DRIFT'),
    true,
  );
});
