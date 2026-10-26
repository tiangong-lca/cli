import { createHash } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import { withBatchRunLock } from '../batch.js';
import { readJsonLinesArtifact, writeJsonArtifact } from './artifacts.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import { semanticContextFromInput } from './process-semantic-validation.js';
import { runDatasetPatchApply, type DatasetPatchOperation } from './dataset-patch.js';
import {
  PREPARE_IDENTITIES,
  assertPrepareMutablePayload,
  parsePrepareEnvelope,
  parsePrepareResult,
  prepareCanonicalUri,
  prepareFail,
  prepareObject,
  prepareSame,
  prepareSelection,
  type PrepareEnvelope,
  type PrepareJson,
  type PrepareResult,
  type PrepareRow,
  type PrepareTable,
} from './dataset-prepare-draft-contract.js';

export type RunDatasetBindPreparedProposalOptions = {
  inputPath: string;
  proposalSha256: string;
  sourceSha256: string;
  preparationReportPath: string;
  predecessorFile?: string;
  predecessorSha256?: string;
  semanticContextFile?: string;
  semanticContextSha256?: string;
  outDir: string;
  /** Test seam for adversarial patch results; public CLI always uses its existing patch owner. */
  applyPatchImpl?: typeof runDatasetPatchApply;
};
export type DatasetPreparedProposalBinding = {
  schema_version: 'dataset-prepared-proposal-binding.v1';
  status: 'bound';
  save_ready: false;
  qualification: 'server_receipt_reported_readback' | 'observed_only';
  project_ref: string;
  actor_user_id: string;
  table: PrepareTable;
  id: string;
  source_version: string;
  target_version: string;
  hashes: {
    proposal: string;
    source: string;
    predecessor: string;
    preparation_report: string;
    preparation_request: string;
    receipt: string | null;
    target_before: string;
    desired: string;
    identity_patch: string;
    proposal_scientific_projection: string;
    desired_scientific_projection: string;
  };
  predecessor_origin: 'reviewed_file' | 'proposal';
  identity_changed_paths: string[];
  scientific_projection_unchanged: true;
  required_gates: [
    'identity_diff_review',
    'schema',
    'references',
    'current_owner_state',
    'fresh_full_before_image',
    'existing_business_review_requirements',
  ];
  review_policy: {
    scientific_review_status: 'not_inferred';
    existing_review: 'reusable_if_valid_and_bound_to_same_proposal_digest';
    reopen_scientific_review: 'only_for_material_scientific_changes';
  };
  semantic_context_binding:
    | { status: 'not_supplied' }
    | {
        status: 'rebound_identity_only';
        before_sha256: string;
        after_sha256: string;
        flow_documents_sha256: string;
        flow_documents_unchanged: true;
        flow_document_count: number;
        candidate_before_sha256: string;
        candidate_after_sha256: string;
      };
  inputs: Array<{ role: string; path: string; bytes_sha256: string }>;
  files: { desired: string; patch: string; evidence: string; binding: string };
};
type CapturedInput = {
  role: string;
  path: string;
  bytes: Buffer;
  value: unknown;
  bytesSha256: string;
};
// The public SDK exports the composed Process schema; this optional member wraps its
// shared GlobalReferenceTypeSchema without copying a validator or importing private SDK paths.
const globalReferenceSchema =
  ProcessSchema.shape.processDataSet.shape.administrativeInformation.shape.publicationAndOwnership.shape[
    'common:referenceToPrecedingDataSetVersion'
  ].unwrap();
const HASH = /^[a-f0-9]{64}$/u;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const IDENTITY_FIELDS = [
  'common:dataSetVersion',
  'common:permanentDataSetURI',
  'common:referenceToPrecedingDataSetVersion',
] as const;
function hashInput(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value))
    prepareFail(`${label} requires a canonical SHA-256.`, 'DATASET_PROPOSAL_BINDING_INVALID');
  return value;
}
function capture(role: string, file: string): CapturedInput {
  if (!file.trim())
    prepareFail(`Binding ${role} path is required.`, 'DATASET_PROPOSAL_BINDING_INVALID');
  const resolved = path.resolve(file);
  const bytes = readFileSync(resolved);
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    prepareFail(
      `Binding ${role} must be valid UTF-8 JSON.`,
      'DATASET_PROPOSAL_BINDING_UTF8_INVALID',
    );
  }
  return {
    role,
    path: resolved,
    bytes,
    value: JSON.parse(text),
    bytesSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function assertInputsCurrent(inputs: CapturedInput[]): void {
  if (inputs.some((input) => !readFileSync(input.path).equals(input.bytes)))
    prepareFail(
      'Binding inputs changed during offline application.',
      'DATASET_PROPOSAL_BINDING_INPUT_CHANGED',
    );
}
function publication(payload: PrepareJson, table: PrepareTable): PrepareJson {
  const root = payload[PREPARE_IDENTITIES[table].root];
  const admin = prepareObject(root) ? root.administrativeInformation : null;
  const pub = prepareObject(admin) ? admin.publicationAndOwnership : null;
  if (!prepareObject(pub))
    prepareFail(
      'Binding requires canonical publication/ownership fields.',
      'DATASET_PROPOSAL_BINDING_IDENTITY_INVALID',
    );
  return pub;
}
function payloadIdentity(payload: PrepareJson, table: PrepareTable): unknown {
  const root = payload[PREPARE_IDENTITIES[table].root];
  const info = prepareObject(root) ? root[PREPARE_IDENTITIES[table].information] : null;
  const data = prepareObject(info) ? info.dataSetInformation : null;
  return prepareObject(data) ? data['common:UUID'] : null;
}
function scientificProjection(payload: PrepareJson, table: PrepareTable): PrepareJson {
  const result = structuredClone(payload);
  const pub = publication(result, table);
  IDENTITY_FIELDS.forEach((field) => {
    delete pub[field];
  });
  return result;
}
type BindSemanticContext = { candidate_sha256: string; flow_documents: PrepareJson[] };
function bindSemanticContext(
  value: unknown,
  proposalSha256: string,
  table: PrepareTable,
): BindSemanticContext {
  if (table !== 'processes')
    prepareFail(
      'Semantic context identity rebinding is limited to standalone Process proposals.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_TYPE_UNSUPPORTED',
    );
  if (!prepareObject(value))
    prepareFail(
      'Semantic context must be an exact native context object.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_INVALID',
    );
  if (Object.keys(value).some((key) => !['candidate_sha256', 'flow_documents'].includes(key)))
    prepareFail(
      'Allocation transformation, invalid bindings and other generated provenance require their native owner.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_NATIVE_OWNER_REQUIRED',
    );
  const checked = semanticContextFromInput({ semantic_context: structuredClone(value) });
  if (
    checked.invalid_bindings ||
    !Array.isArray(value.flow_documents) ||
    typeof value.candidate_sha256 !== 'string' ||
    !prepareSame(checked, value)
  )
    prepareFail(
      'Semantic context must contain the complete unmodified Flow documents and exact candidate binding.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_INVALID',
    );
  if (value.candidate_sha256 !== proposalSha256)
    prepareFail(
      'Semantic context belongs to another scientific proposal.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_PROPOSAL_MISMATCH',
    );
  return {
    candidate_sha256: value.candidate_sha256,
    flow_documents: value.flow_documents as PrepareJson[],
  };
}
function predecessor(value: unknown, request: PrepareEnvelope): unknown {
  const reference = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const checked = globalReferenceSchema.safeParse(structuredClone(value));
  if (
    !prepareObject(reference) ||
    !checked.success ||
    !prepareSame(checked.data, value) ||
    reference['@type'] !== PREPARE_IDENTITIES[request.request.table].referenceType ||
    reference['@refObjectId'] !== request.request.id ||
    reference['@version'] !== request.request.source.version ||
    reference['@uri'] !==
      prepareCanonicalUri(request.request.table, request.request.id, request.request.source.version)
  )
    prepareFail(
      'A reviewed single predecessor reference must point to the exact public source with SDK-valid reference metadata.',
      'PREDECESSOR_BINDING_REQUIRED',
    );
  return value;
}
function preparedTarget(value: unknown) {
  if (
    !prepareObject(value) ||
    value.schema_version !== 'dataset-prepare-draft-report.v1' ||
    value.save_ready !== false ||
    !Array.isArray(value.reviews) ||
    value.reviews.length !== 0 ||
    !prepareObject(value.review_completeness) ||
    value.review_completeness.complete !== true ||
    value.review_completeness.exact_total !== 0 ||
    value.review_completeness.rows_fetched !== 0
  )
    prepareFail(
      'Binding requires a current successful preparation report without review conflicts.',
      'DATASET_PROPOSAL_BINDING_PREPARATION_INVALID',
    );
  const request = parsePrepareEnvelope(value.request);
  if (value.request_sha256 !== sha256Json(request))
    prepareFail(
      'Preparation report request digest drifted.',
      'DATASET_PROPOSAL_BINDING_PREPARATION_INVALID',
    );
  let receipt: PrepareResult | null = null;
  let target: Omit<PrepareRow, 'modelId'>;
  let qualification: DatasetPreparedProposalBinding['qualification'];
  if (value.status === 'prepared') {
    receipt = parsePrepareResult(value.receipt, request);
    target = receipt.selectedDraft;
    qualification = 'server_receipt_reported_readback';
  } else if (
    value.status === 'selected' &&
    value.mode === 'read_only' &&
    value.attempt_consumed === false &&
    value.mutation_dispatches === 0
  ) {
    const selected = prepareSelection(
      request.request.expectedDrafts,
      request.request.selectedVersion ?? null,
    );
    if (
      !selected ||
      !prepareObject(value.completeness) ||
      value.completeness.complete !== true ||
      value.completeness.exact_total !== request.request.expectedDrafts.length ||
      value.completeness.rows_fetched !== request.request.expectedDrafts.length
    )
      prepareFail(
        'Observed-only binding requires the fixed selected draft and a complete original census.',
        'DATASET_PROPOSAL_BINDING_PREPARATION_INVALID',
      );
    target = { ...selected, userId: request.request.expectedActorId, stateCode: 0 };
    qualification = 'observed_only';
  } else
    prepareFail(
      'Zero-draft, unknown, changed and conflicted reports cannot bind a proposal.',
      'DATASET_PROPOSAL_BINDING_PREPARATION_INVALID',
    );
  if (!prepareSame(value.target, target) || target.version === request.request.source.version)
    prepareFail(
      'Binding target differs from the fixed owner draft or aliases the public source.',
      'DATASET_PROPOSAL_BINDING_PREPARATION_INVALID',
    );
  assertPrepareMutablePayload(request.request.table, target.jsonOrdered);
  return { request, receipt, target, qualification };
}
function writeNew(file: string, value: unknown): void {
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function runDatasetBindPreparedProposal(
  options: RunDatasetBindPreparedProposalOptions,
): Promise<DatasetPreparedProposalBinding> {
  hashInput(options.proposalSha256, 'Proposal');
  hashInput(options.sourceSha256, 'Source');
  if (Boolean(options.predecessorFile) !== Boolean(options.predecessorSha256))
    prepareFail(
      'Predecessor file and canonical SHA-256 must be supplied together.',
      'PREDECESSOR_BINDING_REQUIRED',
    );
  if (Boolean(options.semanticContextFile) !== Boolean(options.semanticContextSha256))
    prepareFail(
      'Semantic context file and canonical SHA-256 must travel together.',
      'DATASET_PROPOSAL_SEMANTIC_CONTEXT_INVALID',
    );
  const proposalInput = capture('scientific_proposal', options.inputPath);
  const preparationInput = capture('preparation_report', options.preparationReportPath);
  const inputs = [proposalInput, preparationInput];
  const prepared = preparedTarget(preparationInput.value);
  const { request, receipt, target, qualification } = prepared;
  const table = request.request.table;
  if (
    !prepareObject(proposalInput.value) ||
    sha256Json(proposalInput.value) !== options.proposalSha256 ||
    sha256Json(request.request.source.jsonOrdered) !== options.sourceSha256
  )
    prepareFail(
      'Proposal or exact public source canonical digest differs from its reviewed binding.',
      'DATASET_PROPOSAL_BINDING_HASH_MISMATCH',
    );
  const proposal = proposalInput.value;
  const source = request.request.source.jsonOrdered;
  let semanticContext: BindSemanticContext | null = null;
  if (options.semanticContextFile) {
    hashInput(options.semanticContextSha256, 'Semantic context');
    const explicitContext = capture('native_semantic_context', options.semanticContextFile);
    inputs.push(explicitContext);
    if (sha256Json(explicitContext.value) !== options.semanticContextSha256)
      prepareFail(
        'Native semantic context canonical digest differs.',
        'DATASET_PROPOSAL_BINDING_HASH_MISMATCH',
      );
    semanticContext = bindSemanticContext(explicitContext.value, options.proposalSha256, table);
  }

  if (
    payloadIdentity(proposal, table) !== request.request.id ||
    payloadIdentity(source, table) !== request.request.id ||
    payloadIdentity(target.jsonOrdered, table) !== request.request.id
  )
    prepareFail(
      'Binding preserves the exact original typed dataset UUID.',
      'DATASET_PROPOSAL_BINDING_IDENTITY_INVALID',
    );
  const proposalPub = publication(proposal, table);
  const sourcePub = publication(source, table);
  if (
    proposalPub[IDENTITY_FIELDS[0]] !== request.request.source.version ||
    sourcePub[IDENTITY_FIELDS[0]] !== request.request.source.version ||
    !prepareSame(proposalPub[IDENTITY_FIELDS[1]] ?? null, sourcePub[IDENTITY_FIELDS[1]] ?? null)
  )
    prepareFail(
      'Scientific proposal must retain the exact original public version and URI before binding.',
      'DATASET_PROPOSAL_BINDING_IDENTITY_INVALID',
    );
  let preceding: unknown;
  if (options.predecessorFile) {
    hashInput(options.predecessorSha256, 'Predecessor');
    const explicit = capture('reviewed_predecessor', options.predecessorFile);
    inputs.push(explicit);
    if (sha256Json(explicit.value) !== options.predecessorSha256)
      prepareFail(
        'Reviewed predecessor canonical digest differs.',
        'DATASET_PROPOSAL_BINDING_HASH_MISMATCH',
      );
    preceding = predecessor(explicit.value, request);
  } else preceding = predecessor(proposalPub[IDENTITY_FIELDS[2]], request);
  const identityValues: Record<(typeof IDENTITY_FIELDS)[number], unknown> = {
    'common:dataSetVersion': target.version,
    'common:permanentDataSetURI': prepareCanonicalUri(table, request.request.id, target.version),
    'common:referenceToPrecedingDataSetVersion': preceding,
  };
  const prefix = `/${PREPARE_IDENTITIES[table].root}/administrativeInformation/publicationAndOwnership`;
  const changed = IDENTITY_FIELDS.filter(
    (field) => !prepareSame(proposalPub[field] ?? null, identityValues[field]),
  );
  const evidence = {
    source:
      'Exact prepared-target identity binding; scientific content remains the reviewed proposal.',
    proposal_sha256: options.proposalSha256,
    source_sha256: options.sourceSha256,
    predecessor_sha256: sha256Json(preceding),
    preparation_report_sha256: sha256Json(preparationInput.value),
    target_before_sha256: sha256Json(target.jsonOrdered),
  };
  const operations: DatasetPatchOperation[] = [];
  for (const field of changed) {
    const pointer = `/jsonOrdered${prefix}/${field}`;
    if (Object.hasOwn(proposalPub, field))
      operations.push({ op: 'test', path: pointer, value: proposalPub[field] });
    operations.push({
      op: Object.hasOwn(proposalPub, field) ? 'replace' : 'add',
      path: pointer,
      value: identityValues[field],
      evidence,
      basis: 'Only the three reviewed identity fields may differ.',
    });
  }
  const patch = {
    schema_version: 'dataset-prepared-identity-patch.v1',
    save_ready: false,
    patch_status: 'completed',
    patches: [{ row_index: 0, operations }],
  };
  if (!options.outDir.trim())
    prepareFail(
      'Binding requires a new private output directory.',
      'DATASET_PROPOSAL_BINDING_INVALID',
    );
  const outDir = path.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(outDir).isDirectory())
    prepareFail(
      'Binding output must be a private directory.',
      'DATASET_PROPOSAL_BINDING_OUTPUT_CONFLICT',
    );
  chmodSync(outDir, 0o700);
  return withBatchRunLock(
    {
      runPath: outDir,
      identity: 'dataset-prepared-proposal-binding.v1',
      reason: 'offline-prepared-proposal-binding',
      timeoutMs: 0,
    },
    async () => {
      if (readdirSync(outDir).some((name) => name !== '.tiangong-lca-batch-run.state.lock'))
        prepareFail(
          'Binding output directory already contains artifacts.',
          'DATASET_PROPOSAL_BINDING_OUTPUT_CONFLICT',
        );
      const work = mkdtempSync(path.join(outDir, '.identity-patch-'));
      try {
        assertInputsCurrent(inputs);
        const originalRow = { save_ready: false, jsonOrdered: proposal };
        const input = path.join(work, 'proposal-row.json');
        const patchFile = path.join(work, 'identity-patch.json');
        const patched = path.join(work, 'desired-row.jsonl');
        writeJsonArtifact(input, originalRow);
        writeJsonArtifact(patchFile, patch);
        const application = await (options.applyPatchImpl ?? runDatasetPatchApply)({
          inputPath: input,
          patchPath: patchFile,
          outPath: patched,
          outDir: work,
        });
        const rows = readJsonLinesArtifact(patched);
        const row = rows[0];
        if (
          application.status !== 'completed' ||
          rows.length !== 1 ||
          !prepareObject(row) ||
          row.save_ready !== false ||
          !prepareObject(row.jsonOrdered)
        )
          prepareFail(
            'Existing patch owner did not complete the exact identity application.',
            'DATASET_PROPOSAL_BINDING_PATCH_FAILED',
          );
        const desired = row.jsonOrdered;
        const desiredPub = publication(desired, table);
        if (
          !prepareSame(
            scientificProjection(desired, table),
            scientificProjection(proposal, table),
          ) ||
          payloadIdentity(desired, table) !== request.request.id ||
          IDENTITY_FIELDS.some((field) => !prepareSame(desiredPub[field], identityValues[field]))
        )
          prepareFail(
            'Identity application changed scientific content or the fixed target identity.',
            'DATASET_PROPOSAL_BINDING_SCIENCE_CHANGED',
          );
        const desiredSha256 = sha256Json(desired);
        // This is identity-only evidence transport: Flow documents are the same complete values,
        // and generated Model/result provenance never enters this path.
        const reboundContext = semanticContext
          ? { ...semanticContext, candidate_sha256: desiredSha256 }
          : null;
        const semanticBinding: DatasetPreparedProposalBinding['semantic_context_binding'] =
          semanticContext && reboundContext
            ? {
                status: 'rebound_identity_only',
                before_sha256: sha256Json(semanticContext),
                after_sha256: sha256Json(reboundContext),
                flow_documents_sha256: sha256Json(semanticContext.flow_documents),
                flow_documents_unchanged: true,
                flow_document_count: semanticContext.flow_documents.length,
                candidate_before_sha256: options.proposalSha256,
                candidate_after_sha256: desiredSha256,
              }
            : { status: 'not_supplied' };
        assertInputsCurrent(inputs);
        const files = {
          desired: path.join(outDir, 'desired.json'),
          patch: path.join(outDir, 'identity-patch.json'),
          evidence: path.join(outDir, 'evidence.json'),
          binding: path.join(outDir, 'binding.json'),
        };
        const binding: DatasetPreparedProposalBinding = {
          schema_version: 'dataset-prepared-proposal-binding.v1',
          status: 'bound',
          save_ready: false,
          qualification,
          project_ref: request.project_ref,
          actor_user_id: request.request.expectedActorId,
          table,
          id: request.request.id,
          source_version: request.request.source.version,
          target_version: target.version,
          hashes: {
            proposal: options.proposalSha256,
            source: options.sourceSha256,
            predecessor: sha256Json(preceding),
            preparation_report: sha256Json(preparationInput.value),
            preparation_request: sha256Json(request),
            receipt: receipt ? sha256Json(receipt) : null,
            target_before: sha256Json(target.jsonOrdered),
            desired: sha256Json(desired),
            identity_patch: sha256Json(patch),
            proposal_scientific_projection: sha256Json(scientificProjection(proposal, table)),
            desired_scientific_projection: sha256Json(scientificProjection(desired, table)),
          },
          predecessor_origin: options.predecessorFile ? 'reviewed_file' : 'proposal',
          identity_changed_paths: changed.map((field) => `${prefix}/${field}`),
          scientific_projection_unchanged: true,
          required_gates: [
            'identity_diff_review',
            'schema',
            'references',
            'current_owner_state',
            'fresh_full_before_image',
            'existing_business_review_requirements',
          ],
          review_policy: {
            scientific_review_status: 'not_inferred',
            existing_review: 'reusable_if_valid_and_bound_to_same_proposal_digest',
            reopen_scientific_review: 'only_for_material_scientific_changes',
          },
          semantic_context_binding: semanticBinding,
          inputs: inputs.map(({ role, path: file, bytesSha256 }) => ({
            role,
            path: file,
            bytes_sha256: bytesSha256,
          })),
          files,
        };
        writeNew(files.desired, {
          schema_version: 'dataset-prepared-proposal.v1',
          save_ready: false,
          table,
          id: request.request.id,
          version: target.version,
          jsonOrdered: desired,
          ...(reboundContext ? { semantic_context: reboundContext } : {}),
        });
        writeNew(files.patch, patch);
        writeNew(files.evidence, {
          schema_version: 'dataset-prepared-identity-evidence.v1',
          save_ready: false,
          ...evidence,
          patch_owner: 'dataset patch apply',
          patch_application: {
            status: application.status,
            operation_count: application.operation_count,
            applied_operation_count: application.applied_operation_count,
          },
          patch_evidence: readJsonLinesArtifact(application.files.patch_evidence!),
        });
        writeNew(files.binding, binding);
        return binding;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}
