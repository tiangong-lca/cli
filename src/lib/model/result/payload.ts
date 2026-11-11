import { sha256Json } from '../../platform/canonical-json-hash.js';
import {
  analyzeProcessPayloadSemantics,
  type ProcessSemanticContext,
} from '../../validation/process-semantic-validation.js';
import {
  allocationAggregationKey,
  hasAllocationDeclaration,
  reconcileResultingAllocations,
  type AllocationGroup,
} from '../resulting-process-allocation.js';
import { CliError } from '../../../shared/errors.js';
import {
  type JsonObject,
  type ProcessRecord,
  type ProcessInstance,
  type Edge,
  isRecord,
  ensureList,
  copyJson,
  firstNonEmpty,
  lifecyclemodelRoot,
  processDatasetRoot,
  multilangFromText,
} from './base.js';
import { toFiniteNumber, normalizeNumericOutput } from './base.js';

export function referenceToResultingProcess(model: JsonObject): {
  id: string | null;
  version: string | null;
} {
  const root = lifecyclemodelRoot(model);
  const info = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  const dataInfo = isRecord(info.dataSetInformation) ? info.dataSetInformation : {};
  const ref = isRecord(dataInfo.referenceToResultingProcess)
    ? dataInfo.referenceToResultingProcess
    : {};

  return {
    id: firstNonEmpty(ref['@refObjectId'], ref.id),
    version: firstNonEmpty(ref['@version'], ref.version),
  };
}

export function referenceProcessInstanceId(model: JsonObject): string | null {
  const root = lifecyclemodelRoot(model);
  const info = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  const quantitative = isRecord(info.quantitativeReference) ? info.quantitativeReference : {};
  const ref = quantitative.referenceToReferenceProcess;
  if (ref === undefined) return null;
  const value = isRecord(ref) ? (ref['@refObjectId'] ?? ref.id) : ref;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  const id = firstNonEmpty(value);
  if (id) return id;
  throw new CliError('The declared reference process instance is invalid.', {
    code: 'LIFECYCLEMODEL_REFERENCE_INSTANCE_INVALID',
    exitCode: 2,
  });
}

export function chooseReferenceInstance(
  processInstances: ProcessInstance[],
  requestedInstanceId: string | null,
): ProcessInstance {
  if (processInstances.length === 0)
    throw new CliError('Lifecycle model does not contain any process instances.', {
      code: 'LIFECYCLEMODEL_PROCESS_INSTANCES_REQUIRED',
      exitCode: 2,
    });
  const ids = new Set<string>();
  for (const instance of processInstances) {
    if (ids.has(instance.instance_id))
      throw new CliError(`Duplicate process instance ID ${instance.instance_id}`, {
        code: 'LIFECYCLEMODEL_REFERENCE_INSTANCE_AMBIGUOUS',
        exitCode: 2,
      });
    ids.add(instance.instance_id);
  }
  const directMatch = requestedInstanceId
    ? processInstances.find((item) => item.instance_id === requestedInstanceId)
    : null;
  if (directMatch) {
    return directMatch;
  }
  if (requestedInstanceId !== null)
    throw new CliError(`Reference process instance ${requestedInstanceId} was not found.`, {
      code: 'LIFECYCLEMODEL_REFERENCE_INSTANCE_NOT_FOUND',
      exitCode: 2,
    });

  const scaled = processInstances.find((item) => item.multiplication_factor > 0);
  if (scaled) {
    return scaled;
  }

  return processInstances[0];
}

export function cloneExchangeWithAmount(
  exchange: JsonObject,
  amount: number,
  internalId: string,
  options: {
    quantitativeReference: boolean;
  },
): JsonObject {
  const cloned = copyJson(exchange);
  cloned['@dataSetInternalID'] = internalId;
  const normalizedAmount = normalizeNumericOutput(amount);
  cloned.meanAmount = String(normalizedAmount);
  if ('resultingAmount' in cloned) {
    cloned.resultingAmount = String(normalizedAmount);
  }
  cloned.quantitativeReference = options.quantitativeReference;
  return cloned;
}

export function buildResultingProcessPayload(options: {
  sourceModelId: string;
  sourceModelVersion: string;
  sourceModelName: string;
  sourceModelNameInfo: JsonObject;
  processId: string;
  processVersion: string;
  role: 'primary';
  projectionSignature: string;
  processInstances: ProcessInstance[];
  edges: Edge[];
  processRecords: Record<string, ProcessRecord>;
  referenceProcessInstanceId: string | null;
  metadataOverrides: JsonObject;
  attachGraphSnapshotUri: string | null;
  semanticContext?: ProcessSemanticContext;
  transformationEvidence?: JsonObject;
}): JsonObject {
  const chosenInstance = chooseReferenceInstance(
    options.processInstances,
    options.referenceProcessInstanceId,
  );
  const chosenKey = `${chosenInstance.process_id}@${chosenInstance.process_version}`;
  const finalRecord = options.processRecords[chosenKey];
  const finalProcess = copyJson(finalRecord.raw);
  const finalDataset = processDatasetRoot(finalProcess);
  const totals = new Map<string, AllocationGroup>();
  const sourceTargets = new Map<string, AllocationGroup>();
  const instancesWithAllocation = new Set<string>();

  options.processInstances.forEach((instance) => {
    if (instance.multiplication_factor === 0) {
      return;
    }

    const record = options.processRecords[`${instance.process_id}@${instance.process_version}`];
    const recordDataset = processDatasetRoot(record.raw);
    const exchangesWrapper = isRecord(recordDataset.exchanges)
      ? (recordDataset.exchanges as JsonObject)
      : {};
    const exchanges = ensureList<JsonObject>(exchangesWrapper.exchange).filter(isRecord);
    const sourceMethod = isRecord(recordDataset.modellingAndValidation)
      ? (recordDataset.modellingAndValidation.LCIMethodAndAllocation as JsonObject | undefined)
      : undefined;
    const alreadyAllocated = sourceMethod?.typeOfDataSet === 'LCI result';
    const semantics = analyzeProcessPayloadSemantics(record.raw, {
      flow_documents: options.semanticContext?.flow_documents,
    });
    if (
      exchanges.some((exchange) => exchange.allocations !== undefined) &&
      semantics.status !== 'passed'
    )
      throw new CliError(
        `Source allocation semantics failed at ${instance.instance_id}: ${semantics.issues.map((issue) => `${issue.path}: ${issue.code}`).join('; ')}`,
        { code: 'LIFECYCLEMODEL_SOURCE_ALLOCATION_INVALID', exitCode: 2 },
      );

    exchanges.forEach((exchange) => {
      const flowRef = isRecord(exchange.referenceToFlowDataSet)
        ? exchange.referenceToFlowDataSet
        : {};
      const flowUuid = firstNonEmpty(flowRef['@refObjectId']);
      const direction = firstNonEmpty(exchange.exchangeDirection);

      if (!flowUuid || (direction !== 'Input' && direction !== 'Output')) {
        return;
      }

      const interpretation = semantics.interpretations?.find(
        (item) => item.exchangeId === String(exchange['@dataSetInternalID']),
      );
      const compatibilityVector =
        interpretation?.mode.startsWith('legacy-') && interpretation.allocations
          ? interpretation.allocations
          : undefined;
      if (
        interpretation?.mode === 'legacy-output-share' &&
        compatibilityVector &&
        !compatibilityVector.some((item) => item.targetId === record.referenceExchangeInternalId)
      )
        throw new CliError(
          `Legacy Output-share compatibility has default-one reference outside the declared targets at ${instance.instance_id}; no conservative explicit-vector conversion is available.`,
          { code: 'LIFECYCLEMODEL_ALLOCATION_COMPATIBILITY_UNREPRESENTABLE', exitCode: 2 },
        );
      const contributionExchange = compatibilityVector
        ? {
            ...exchange,
            allocations: {
              allocation: compatibilityVector.map(({ targetId, fraction }) => ({
                '@internalReferenceToCoProduct': targetId,
                '@allocatedFraction': String(fraction),
              })),
            },
          }
        : exchange;
      const undeclaredReferenceProjection =
        semantics.status === 'passed' &&
        interpretation &&
        (interpretation.mode === 'undeclared' || interpretation.mode === 'legacy-scalar-empty') &&
        semantics.reference?.ids.length === 1
          ? [{ targetId: semantics.reference.ids[0], fraction: 100 }]
          : undefined;
      const key = allocationAggregationKey(exchange);
      const source = `${instance.instance_id}/${String(exchange['@dataSetInternalID'])}`;
      const sourceKey = JSON.stringify([
        instance.instance_id,
        String(exchange['@dataSetInternalID']),
      ]);
      if (sourceTargets.has(sourceKey))
        throw new CliError(`Duplicate exchange identity ${source}`, {
          code: 'LIFECYCLEMODEL_ALLOCATION_ID_AMBIGUOUS',
          exitCode: 2,
        });
      if (hasAllocationDeclaration(exchange)) {
        instancesWithAllocation.add(instance.instance_id);
        if (alreadyAllocated)
          throw new CliError(`Already allocated inventory cannot declare allocation at ${source}`, {
            code: 'LIFECYCLEMODEL_ALLOCATION_ALREADY_APPLIED',
            exitCode: 2,
          });
      }
      const scaledAmount =
        toFiniteNumber(exchange.meanAmount ?? exchange.resultingAmount, 'exchange amount') *
        instance.multiplication_factor;
      if (!Number.isFinite(scaledAmount))
        throw new CliError(`Scaled exchange amount is not finite at ${source}`, {
          code: 'LIFECYCLEMODEL_INVALID_NUMBER',
          exitCode: 2,
        });
      if (hasAllocationDeclaration(contributionExchange) && scaledAmount <= 0)
        throw new CliError(`Zero or signed allocated contribution at ${source}`, {
          code: 'LIFECYCLEMODEL_ALLOCATION_TRANSFORMATION_UNSUPPORTED',
          exitCode: 2,
        });
      const existing = totals.get(key);
      if (existing) {
        existing.amount += scaledAmount;
        existing.contributions.push({
          source,
          instance: instance.instance_id,
          mode: semantics.interpretations?.find(
            (item) => item.exchangeId === String(exchange['@dataSetInternalID']),
          )?.mode,
          exchange: contributionExchange,
          fallbackAllocations: undeclaredReferenceProjection,
          alreadyAllocated,
          amount: scaledAmount,
        });
        sourceTargets.set(sourceKey, existing);
        return;
      }

      const group = {
        key,
        amount: scaledAmount,
        exchange: copyJson(exchange),
        contributions: [
          {
            source,
            instance: instance.instance_id,
            mode: semantics.interpretations?.find(
              (item) => item.exchangeId === String(exchange['@dataSetInternalID']),
            )?.mode,
            exchange: contributionExchange,
            fallbackAllocations: undeclaredReferenceProjection,
            alreadyAllocated,
            amount: scaledAmount,
          },
        ],
      };
      totals.set(key, group);
      sourceTargets.set(sourceKey, group);
    });
  });

  for (const group of totals.values()) {
    group.contributions.sort((left, right) =>
      JSON.stringify([left.instance, left.exchange['@dataSetInternalID']]).localeCompare(
        JSON.stringify([right.instance, right.exchange['@dataSetInternalID']]),
      ),
    );
    group.amount = normalizeNumericOutput(
      group.contributions.reduce((sum, item) => sum + item.amount, 0),
    );
    if (group.contributions.some((item) => hasAllocationDeclaration(item.exchange))) {
      if (group.amount <= 0)
        throw new CliError(`Zero or signed allocated quantity basis at ${group.key}`, {
          code: 'LIFECYCLEMODEL_ALLOCATION_TRANSFORMATION_UNSUPPORTED',
          exitCode: 2,
        });
      for (const item of group.contributions) {
        if (item.alreadyAllocated)
          throw new CliError(
            `Already allocated inventory cannot participate in declared allocation at ${item.source}`,
            {
              code: 'LIFECYCLEMODEL_ALLOCATION_ALREADY_APPLIED',
              exitCode: 2,
            },
          );
        if (
          item.exchange.resultingAmount !== undefined &&
          Number(item.exchange.meanAmount) !== Number(item.exchange.resultingAmount)
        )
          throw new CliError(`Conflicting quantity basis at ${item.source}`, {
            code: 'LIFECYCLEMODEL_ALLOCATION_QUANTITY_BASIS_CONFLICT',
            exitCode: 2,
          });
      }
    }
  }

  const instanceById = new Map(options.processInstances.map((item) => [item.instance_id, item]));
  const connections = [...options.edges].sort((left, right) =>
    JSON.stringify([left.from, left.to, left.flow_uuid, left.edge_id]).localeCompare(
      JSON.stringify([right.from, right.to, right.flow_uuid, right.edge_id]),
    ),
  );
  connections.forEach((edge) => {
    if (!edge.flow_uuid) {
      return;
    }

    const downstreamInstance = instanceById.get(edge.to);
    if (!downstreamInstance) {
      return;
    }
    if (
      downstreamInstance.multiplication_factor === 0 ||
      instanceById.get(edge.from)?.multiplication_factor === 0
    )
      return;

    const downstreamCandidates = [...totals.values()]
      .flatMap((group) => group.contributions.map((contribution) => ({ group, contribution })))
      .filter(
        ({ contribution }) =>
          contribution.instance === edge.to &&
          (contribution.exchange.referenceToFlowDataSet as JsonObject)?.['@refObjectId'] ===
            edge.flow_uuid &&
          contribution.exchange.exchangeDirection === 'Input',
      );
    const upstreamCandidates = [...totals.values()]
      .flatMap((group) => group.contributions.map((contribution) => ({ group, contribution })))
      .filter(
        ({ contribution }) =>
          contribution.instance === edge.from &&
          (contribution.exchange.referenceToFlowDataSet as JsonObject)?.['@refObjectId'] ===
            edge.flow_uuid &&
          contribution.exchange.exchangeDirection === 'Output',
      );
    const affectedAllocationGroup = [...downstreamCandidates, ...upstreamCandidates].some(
      ({ group }) => group.contributions.some((item) => hasAllocationDeclaration(item.exchange)),
    );
    const allocated =
      instancesWithAllocation.has(edge.from) ||
      instancesWithAllocation.has(edge.to) ||
      affectedAllocationGroup;
    const competing = options.edges.some(
      (other) =>
        other !== edge &&
        instanceById.get(other.from)?.multiplication_factor !== 0 &&
        instanceById.get(other.to)?.multiplication_factor !== 0 &&
        other.flow_uuid === edge.flow_uuid &&
        (other.from === edge.from || other.to === edge.to),
    );
    if (
      competing ||
      downstreamCandidates.length !== 1 ||
      upstreamCandidates.length !== 1 ||
      upstreamCandidates[0].group.key.replace('"Output"', '"Input"') !==
        downstreamCandidates[0].group.key ||
      downstreamCandidates[0].contribution.amount < 0 ||
      upstreamCandidates[0].contribution.amount < 0
    ) {
      throw new CliError(
        `${allocated ? 'Allocation cancellation has no unique source lineage' : 'Mixed exact Flow/basis cancellation or competing connection'} at ${edge.edge_id}; retain unique exact endpoint exchanges and explicit connection quantities.`,
        {
          code: allocated
            ? 'LIFECYCLEMODEL_ALLOCATION_CANCELLATION_AMBIGUOUS'
            : 'LIFECYCLEMODEL_CANCELLATION_BASIS_AMBIGUOUS',
          exitCode: 2,
        },
      );
    }
    const internalAmount = Math.min(
      downstreamCandidates[0].contribution.amount,
      upstreamCandidates[0].contribution.amount,
    );
    for (const { group, contribution } of [downstreamCandidates[0], upstreamCandidates[0]]) {
      contribution.amount = normalizeNumericOutput(contribution.amount - internalAmount);
      group.amount = normalizeNumericOutput(group.amount - internalAmount);
    }
  });

  const exchangeItems: JsonObject[] = [];
  let nextInternalId = 1;
  let referenceExchangeInternalId = '';
  const sortedEntries = [...totals.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  const finalIds = new Map<AllocationGroup, string>();
  for (const [, group] of sortedEntries)
    if (group.amount > 0) finalIds.set(group, String(finalIds.size + 1));
  reconcileResultingAllocations(
    sortedEntries.filter(([, group]) => group.amount > 0).map(([, group]) => group),
    sourceTargets,
    finalIds,
  );
  if (options.transformationEvidence)
    Object.assign(options.transformationEvidence, {
      profile: 'tiangong.resulting-process-allocation.v1',
      inventory_mode: 'allocation-not-applied-by-builder',
      allocation_percentage_precision: 3,
      allocation_percentage_error_bound: 0.001,
      allocation_absolute_amount_error_bound_factor: 0.00001,
      allocation_quantization: [...totals.values()].flatMap((group) =>
        (group.quantization ?? []).map((item) => ({
          ...item,
          final_exchange_id: finalIds.get(group) ?? null,
        })),
      ),
      source_processes: options.processInstances.map((instance) => ({
        instance_id: instance.instance_id,
        process_id: instance.process_id,
        version: instance.process_version,
        content_sha256: sha256Json(
          options.processRecords[`${instance.process_id}@${instance.process_version}`].raw,
        ),
        multiplier: instance.multiplication_factor,
      })),
      provenance: [...sourceTargets.entries()].map(([identity, group]) => ({
        identity: JSON.parse(identity) as unknown,
        final_exchange_id: finalIds.get(group) ?? null,
      })),
      contributions: [...totals.values()].flatMap((group) =>
        group.contributions.map((item) => ({
          source: item.source,
          instance: item.instance,
          remaining_amount: item.amount,
          final_exchange_id: finalIds.get(group) ?? null,
        })),
      ),
    });
  const chosenTarget =
    sourceTargets.get(
      JSON.stringify([chosenInstance.instance_id, finalRecord.referenceExchangeInternalId]),
    ) ??
    [...totals.values()].find(
      (group) =>
        group.contributions.some(
          (item) =>
            item.instance === chosenInstance.instance_id &&
            item.exchange['@dataSetInternalID'] === undefined,
        ) &&
        (group.exchange.referenceToFlowDataSet as JsonObject)?.['@refObjectId'] ===
          finalRecord.referenceFlowUuid &&
        group.exchange.exchangeDirection === (finalRecord.referenceDirection || 'Output'),
    );
  sortedEntries.forEach(([, payload]) => {
    if (payload.amount <= 0) {
      return;
    }

    const quantitativeReference = payload === chosenTarget && !referenceExchangeInternalId;

    const internalId = String(nextInternalId);
    nextInternalId += 1;
    if (quantitativeReference) {
      referenceExchangeInternalId = internalId;
    }

    exchangeItems.push(
      cloneExchangeWithAmount(payload.exchange, payload.amount, internalId, {
        quantitativeReference,
      }),
    );
  });

  if (!referenceExchangeInternalId) {
    throw new CliError(
      `Could not build resulting process reference exchange for lifecycle model ${options.sourceModelId}.`,
      {
        code: 'LIFECYCLEMODEL_REFERENCE_OUTPUT_REQUIRED',
        exitCode: 2,
      },
    );
  }

  const processInformation = isRecord(finalDataset.processInformation)
    ? (finalDataset.processInformation as JsonObject)
    : {};
  finalDataset.processInformation = processInformation;
  const dataInfo = isRecord(processInformation.dataSetInformation)
    ? (processInformation.dataSetInformation as JsonObject)
    : {};
  processInformation.dataSetInformation = dataInfo;
  dataInfo['common:UUID'] = options.processId;
  dataInfo.name = copyJson(options.sourceModelNameInfo);
  const generalComment = ensureList<JsonObject>(dataInfo['common:generalComment']).filter(isRecord);
  generalComment.push(
    ...multilangFromText(
      `Local ${options.role} resulting process generated from lifecycle model ${options.sourceModelId}; exchanges are aggregated from included processes with internal linked flows cancelled.`,
      `本地为生命周期模型 ${options.sourceModelId} 生成的 ${options.role} resulting process；其 exchanges 由包含过程聚合并抵消内部连接 flow 后得到。`,
    ),
  );
  dataInfo['common:generalComment'] = generalComment;

  const quantitativeReference = isRecord(processInformation.quantitativeReference)
    ? (processInformation.quantitativeReference as JsonObject)
    : {};
  processInformation.quantitativeReference = quantitativeReference;
  quantitativeReference.referenceToReferenceFlow = referenceExchangeInternalId;

  const technology = isRecord(processInformation.technology)
    ? (processInformation.technology as JsonObject)
    : {};
  processInformation.technology = technology;
  const includedRefs = options.processInstances.map((item) => copyJson(item.reference_to_process));
  if (includedRefs.length > 0) {
    technology.referenceToIncludedProcesses =
      includedRefs.length === 1 ? includedRefs[0] : includedRefs;
  }

  finalDataset.exchanges = {
    exchange: exchangeItems,
  };

  const administrative = isRecord(finalDataset.administrativeInformation)
    ? (finalDataset.administrativeInformation as JsonObject)
    : {};
  finalDataset.administrativeInformation = administrative;
  const publication = isRecord(administrative.publicationAndOwnership)
    ? (administrative.publicationAndOwnership as JsonObject)
    : {};
  administrative.publicationAndOwnership = publication;
  publication['common:dataSetVersion'] = options.processVersion;
  publication['common:permanentDataSetURI'] =
    `https://local.tiangong.invalid/processes/${options.processId}?version=${options.processVersion}`;

  const modellingAndValidation = isRecord(finalDataset.modellingAndValidation)
    ? (finalDataset.modellingAndValidation as JsonObject)
    : {};
  finalDataset.modellingAndValidation = modellingAndValidation;
  const lciMethod = isRecord(modellingAndValidation.LCIMethodAndAllocation)
    ? (modellingAndValidation.LCIMethodAndAllocation as JsonObject)
    : {};
  modellingAndValidation.LCIMethodAndAllocation = lciMethod;
  const typeOfDataSet =
    firstNonEmpty(options.metadataOverrides.type_of_data_set) ?? 'Partly terminated system';
  lciMethod.typeOfDataSet = typeOfDataSet;

  dataInfo.generatedFromLifecycleModel = {
    '@type': 'life cycle model data set',
    id: options.sourceModelId,
    version: options.sourceModelVersion,
    role: options.role,
  };

  const metadata: JsonObject = {
    generated_from_lifecyclemodel_id: options.sourceModelId,
    generated_from_lifecyclemodel_version: options.sourceModelVersion,
    projection_role: options.role,
    projection_signature: options.projectionSignature,
    type_of_data_set: typeOfDataSet,
    ...copyJson(options.metadataOverrides),
  };
  if (options.attachGraphSnapshotUri) {
    metadata.graph_snapshot_uri = options.attachGraphSnapshotUri;
  }

  finalProcess.projectionMetadata = metadata;
  finalProcess.topologySummary = {
    process_instance_count: options.processInstances.length,
    edge_count: options.edges.length,
  };

  return finalProcess;
}
