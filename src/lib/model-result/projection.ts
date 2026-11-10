import { sha256Json } from '../canonical-json-hash.js';
import { validateProcessPayload } from '../process-payload-validation.js';
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
import { extractProcessInstances, extractEdges, resolveProcessRecords } from './sources.js';
import {
  referenceToResultingProcess,
  referenceProcessInstanceId,
  buildResultingProcessPayload,
} from './payload.js';

export async function buildProjectionBundle(options: {
  request: LifecyclemodelResultingProcessRequest;
  sourceModelJson: JsonObject;
  modelPath: string | null;
  remoteLookup?: RemoteProcessLookupContext;
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
    `${modelIdentity.id}-resulting-process`;
  const primaryProcessVersion =
    options.request.projection.process_version ?? referenceProcess.version ?? modelIdentity.version;
  const notes = [
    'This command materializes a deterministic resulting processDataSet by aggregating included process exchanges and cancelling internal linked flows.',
    'Remote writes remain gated behind an explicit publish layer.',
  ];

  const transformationEvidence: JsonObject = {};
  const primaryPayload = buildResultingProcessPayload({
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

  transformationEvidence.candidate_sha256 = sha256Json(primaryPayload);
  const outputValidation = validateProcessPayload(
    primaryPayload,
    undefined,
    undefined,
    options.request.semantic_context,
  );

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

  const report = {
    generated_at: nowIso(),
    validation: outputValidation,
    qualification: {
      status: outputValidation.ok
        ? 'qualified'
        : outputValidation.allocation_semantics?.status === 'unresolved'
          ? 'unresolved'
          : 'failed',
      publish_ready: outputValidation.ok,
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
    projected_process_count: 1,
    notes,
  };

  const bundle = {
    source_model: sourceModelSummary,
    projected_processes: [
      {
        role: 'primary',
        id: primaryProcessId,
        version: primaryProcessVersion,
        name: modelIdentity.name,
        json_ordered: primaryPayload,
        metadata: primaryPayload.projectionMetadata,
        semantic_context: options.request.semantic_context,
        allocation_transformation: transformationEvidence,
      },
    ],
    relations: [
      {
        lifecyclemodel_id: modelIdentity.id,
        lifecyclemodel_version: modelIdentity.version,
        resulting_process_id: primaryProcessId,
        resulting_process_version: primaryProcessVersion,
        projection_role: 'primary',
        projection_signature: projectionSignature,
        is_primary: true,
      },
    ],
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
