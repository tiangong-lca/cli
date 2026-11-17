import {
  bindCurrentFlowNameEvidence,
  flowNameReadContext,
  populateGeneratedProcessFlowNames,
  readExactFlowNameEvidence,
  suppliedFlowNameEvidence,
} from '../../validation/process-flow-reference-names.js';
import { sha256Json } from '../../platform/canonical-json-hash.js';
import { validateProcessPayload } from '../../validation/process-payload-validation.js';
import {
  type JsonObject,
  type LifecyclemodelResultingProcessRequest,
  type RemoteProcessLookupContext,
  isRecord,
  sha256Text,
  nowIso,
  lifecyclemodelRoot,
  normalizedNameInfo,
  modelIdentifier,
} from './base.js';
import { normalizeProjectionMode } from './request.js';
import { buildSolvedResultGroup } from './solved-group.js';
import { extractProcessInstances, extractEdges, resolveProcessRecords } from './sources.js';
import {
  referenceToResultingProcess,
  referenceProcessInstanceId,
  buildResultingProcessPayload,
} from './payload.js';

export async function buildProjectionBundle(options: {
  existing?: { members: JsonObject[]; processes: JsonObject[] };
  request: LifecyclemodelResultingProcessRequest;
  sourceModelJson: JsonObject;
  modelPath: string | null;
  remoteLookup?: RemoteProcessLookupContext;
  readFlowNamesFromRemote?: boolean;
}): Promise<{
  bundle: JsonObject;
  report: JsonObject;
  sourceModelSummary: {
    id: string;
    version: string;
    name: string;
    json_ordered_path: string | null;
    reference_to_resulting_process_id: string | null;
    reference_to_resulting_process_version: string | null;
    reference_process_instance_id: string | null;
    resolved_process_summary: JsonObject;
  };
}> {
  normalizeProjectionMode(options.request.projection.mode);
  const root = lifecyclemodelRoot(options.sourceModelJson);
  const modelInfo = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  const modelDataInfo = isRecord(modelInfo.dataSetInformation) ? modelInfo.dataSetInformation : {};
  const modelIdentity = modelIdentifier(options.sourceModelJson, options.request.source_model);
  const sourceModelNameInfo = normalizedNameInfo(modelDataInfo.name, modelIdentity.name);
  const processInstances = extractProcessInstances(options.sourceModelJson);
  const edges = extractEdges(options.sourceModelJson);
  const processResolution = await resolveProcessRecords(options.request, {
    sourceModelJson: options.sourceModelJson,
    remoteLookup: options.remoteLookup,
  });
  const referenceProcess = referenceToResultingProcess(options.sourceModelJson);
  const referenceProcessInstance = referenceProcessInstanceId(options.sourceModelJson);
  const signatureSeed = {
    source_model_id: modelIdentity.id,
    source_model_version: modelIdentity.version,
    projection_mode: options.request.projection.mode,
    process_instances: processInstances.map((item) => ({
      instance_id: item.instance_id,
      process_id: item.process_id,
      process_version: item.process_version,
    })),
    edges,
  };
  const projectionSignature = `sha256:${sha256Text(JSON.stringify(signatureSeed))}`;
  const primaryProcessId =
    options.request.projection.process_id ??
    referenceProcess.id ??
    (options.request.projection.mode === 'all-subproducts'
      ? modelIdentity.id
      : `${modelIdentity.id}-resulting-process`);
  const primaryProcessVersion =
    options.request.projection.process_version ?? referenceProcess.version ?? modelIdentity.version;
  const notes = [
    'This command materializes a deterministic resulting processDataSet by aggregating included process exchanges and cancelling internal linked flows.',
    'Remote writes remain gated behind an explicit publish layer.',
  ];

  const transformationEvidence: JsonObject = {};
  const solved =
    options.request.projection.mode === 'all-subproducts'
      ? await buildSolvedResultGroup({
          model: root,
          identity: modelIdentity,
          modelName: sourceModelNameInfo,
          referenceInstance: referenceProcessInstance,
          primary: { id: primaryProcessId, version: primaryProcessVersion },
          instances: processInstances,
          edges,
          records: processResolution.records,
          signature: projectionSignature,
          metadataOverrides: options.request.projection.metadata_overrides,
          targetAmount: options.request.projection.target_amount,
          existing: options.existing,
        })
      : undefined;
  const primaryPayload = solved
    ? undefined
    : buildResultingProcessPayload({
        sourceModel: root,
        sourceModelId: modelIdentity.id,
        sourceModelVersion: modelIdentity.version,
        sourceModelName: modelIdentity.name,
        sourceModelNameInfo,
        processId: primaryProcessId,
        processVersion: primaryProcessVersion,
        role: 'primary',
        projectionSignature,
        processInstances,
        edges,
        processRecords: processResolution.records,
        referenceProcessInstanceId: referenceProcessInstance,
        metadataOverrides: options.request.projection.metadata_overrides,
        attachGraphSnapshotUri: options.request.projection.attach_graph_snapshot_uri,
        semanticContext: options.request.semantic_context,
        transformationEvidence,
      });
  const products = solved?.products ?? [
    {
      type: 'primary' as const,
      id: primaryProcessId,
      version: primaryProcessVersion,
      json_ordered: primaryPayload!,
    },
  ];

  const suppliedFlowNames = suppliedFlowNameEvidence(
    options.request.semantic_context?.flow_documents ?? [],
  );
  const flowNameEvidence =
    options.readFlowNamesFromRemote && options.remoteLookup
      ? bindCurrentFlowNameEvidence(
          await readExactFlowNameEvidence(
            products.map((product) => product.json_ordered),
            flowNameReadContext(options.remoteLookup.env, options.remoteLookup.fetchImpl),
          ),
          suppliedFlowNames,
        )
      : suppliedFlowNames;
  const validations = products.map((product) => {
    populateGeneratedProcessFlowNames(product.json_ordered, flowNameEvidence);
    return {
      id: product.id,
      version: product.version,
      validation: validateProcessPayload(
        product.json_ordered,
        undefined,
        undefined,
        options.request.semantic_context,
        flowNameEvidence,
      ),
    };
  });
  if (primaryPayload) transformationEvidence.candidate_sha256 = sha256Json(primaryPayload);
  const outputValidation = validations[0]!.validation;

  const sourceModelSummary = {
    id: modelIdentity.id,
    version: modelIdentity.version,
    name: modelIdentity.name,
    json_ordered_path: options.modelPath,
    reference_to_resulting_process_id: referenceProcess.id,
    reference_to_resulting_process_version: referenceProcess.version,
    reference_process_instance_id: referenceProcessInstance,
    resolved_process_summary: processResolution.resolutionSummary,
  };

  const publishReady = validations.every(
    ({ validation }) => validation.ok && validation.flow_reference_names.status === 'passed',
  );
  const draftReady = solved
    ? validations.every(({ validation }) => {
        const layers = validation.validation_layers;
        return (
          layers?.schema.status === 'passed' &&
          layers.content.status === 'passed' &&
          layers.authoring_evidence.issues.every(({ code }) =>
            [
              'annual_supply_or_production_volume_not_annualized',
              'annual_volume_basis_unsupported',
              'annual_volume_basis_missing',
            ].includes(code),
          ) &&
          validation.flow_reference_names.status === 'passed' &&
          validation.allocation_semantics?.status === 'passed'
        );
      })
    : undefined;
  const report = {
    generated_at: nowIso(),
    validation: outputValidation,
    ...(solved
      ? {
          member_validation: validations,
          calculation_kernel: solved.kernelCommit,
          expected_member_count: products.length,
          emitted_member_count: products.length,
          missing_members: [],
        }
      : {}),
    qualification: {
      status: publishReady
        ? 'qualified'
        : validations.every(
              ({ validation }) =>
                (validation.ok && validation.flow_reference_names.status !== 'failed') ||
                validation.allocation_semantics?.status === 'unresolved',
            )
          ? 'unresolved'
          : 'failed',
      publish_ready: publishReady,
      ...(draftReady !== undefined ? { draft_ready: draftReady } : {}),
    },
    allocation_transformation: transformationEvidence,
    status:
      options.request.publish.intent === 'publish'
        ? 'projected_local_bundle'
        : 'prepared_local_bundle',
    source_model: sourceModelSummary,
    projection_mode: options.request.projection.mode,
    node_count: processInstances.length,
    edge_count: edges.length,
    reference_process_instance_id: referenceProcessInstance,
    process_instance_preview: processInstances.slice(0, 10).map((item) => ({
      instance_id: item.instance_id,
      process_id: item.process_id,
      label: item.label,
    })),
    edge_preview: edges.slice(0, 10),
    projection_signature: projectionSignature,
    attach_graph_snapshot_uri: options.request.projection.attach_graph_snapshot_uri,
    resolved_process_summary: processResolution.resolutionSummary,
    projected_process_count: products.length,
    notes,
  };

  const bundle = {
    source_model: sourceModelSummary,
    ...(solved
      ? {
          model_candidate: { ...options.sourceModelJson, lifeCycleModelDataSet: solved.model },
          editor_model: options.sourceModelJson,
          reference_quantity: solved.referenceQuantity,
        }
      : {}),
    projected_processes: products.map((product) => ({
      role: product.type,
      id: product.id,
      version: product.version,
      name: modelIdentity.name,
      json_ordered: product.json_ordered,
      metadata: product.json_ordered.projectionMetadata,
      ...('finalId' in product ? { finalId: product.finalId } : {}),
      semantic_context: options.request.semantic_context,
      allocation_transformation: transformationEvidence,
    })),
    relations: products.map((product) => ({
      lifecyclemodel_id: modelIdentity.id,
      lifecyclemodel_version: modelIdentity.version,
      resulting_process_id: product.id,
      resulting_process_version: product.version,
      projection_role: product.type,
      projection_signature: projectionSignature,
      is_primary: product.type === 'primary',
    })),
    report,
    projection: {
      mode: options.request.projection.mode,
      metadata_overrides: options.request.projection.metadata_overrides,
      attach_graph_snapshot_uri: options.request.projection.attach_graph_snapshot_uri,
    },
  };

  return {
    bundle,
    report,
    sourceModelSummary,
  };
}
