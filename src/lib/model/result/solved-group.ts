import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CliError } from '../../../shared/errors.js';
import {
  ensureList,
  isRecord,
  copyJson,
  processDatasetRoot,
  type JsonObject,
  type ProcessRecord,
  type ProcessInstance,
  type Edge,
} from './base.js';
import { materializeResultProcess } from './payload.js';

type KernelExchange = {
  internalId: string;
  direction: 'INPUT' | 'OUTPUT';
  flowId: string;
  amount: number | null;
  raw: JsonObject;
};
type KernelConnection = {
  upstreamIndex: string;
  downstreamIndex: string;
  inputFlowId: string;
  outputFlowId: string;
  inputFlowVersion?: string;
  outputFlowVersion?: string;
  edgeId: string;
};
type KernelResult = {
  groups: Array<{
    type: 'primary' | 'secondary';
    root: { instanceIndex: string; pivotExchangeId: string };
    pivotFlowId: string;
    pivotDirection: KernelExchange['direction'];
    exchanges: Array<{
      template: KernelExchange;
      amount: number;
      direction: KernelExchange['direction'];
      quantitativeReference: boolean;
    }>;
    refProcesses: Array<{ id: string; version: string }>;
  }>;
  productSystem: {
    refInstanceIndex: string;
    instances: Array<{
      instanceIndex: string;
      sourceInstanceIndex: string;
      sourceExchangeId: string;
      processId: string;
      processVersion: string;
      multiplier: number;
      refExchangeInternalId: string;
      materialize: boolean;
      exchanges: KernelExchange[];
      connections: KernelConnection[];
    }>;
  };
};
type KernelReply =
  { ok: true; result: KernelResult } | { ok: false; error: { code: string; issues: unknown[] } };
type Member = {
  id: string;
  version: string;
  type: 'primary' | 'secondary' | 'allocated';
  finalId: JsonObject;
};
type ResultProcess = Member & { json_ordered: JsonObject };

const kernelDigest = 'c103250bd64776914bf549985f81bcce318d0488437b9171b4c95a2f4b920861';
const kernelCommit = '7f30060b07330b7ba44331e2ce822e1bb1eb21e3';

function fail(message: string, details?: unknown): never {
  throw new CliError(message, {
    code: 'LIFECYCLEMODEL_RESULT_GROUP_INVALID',
    exitCode: 2,
    details,
  });
}

async function calculate(input: JsonObject): Promise<KernelResult> {
  let artifact = new URL('../../../../assets/model-result-kernel/index.mjs', import.meta.url);
  let bytes: Buffer;
  try {
    bytes = readFileSync(artifact);
  } catch {
    artifact = new URL('../../../../../assets/model-result-kernel/index.mjs', import.meta.url);
    bytes = readFileSync(artifact);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== kernelDigest)
    fail('The installed Model calculation artifact failed integrity verification.');
  const kernel = (await import(artifact.href)) as {
    runMatrixCalculation(request: JsonObject): KernelReply;
  };
  const reply = kernel.runMatrixCalculation({
    type: 'calculate',
    runId: 'cli-result-group',
    payload: input,
  });
  if (!reply.ok) fail('Model calculation failed: ' + reply.error.code, reply.error.issues);
  return reply.result;
}

const record = (value: unknown): JsonObject => (isRecord(value) ? value : {});
const string = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const optional = (value: unknown): string | undefined => string(value) || undefined;

function sourceConnections(instance: ProcessInstance): KernelConnection[] {
  return ensureList(record(instance.raw.connections).outputExchange).flatMap((value) => {
    const exchange = record(value);
    return ensureList(exchange.downstreamProcess).map((value, index) => {
      const downstream = record(value);
      const flow = string(exchange['@flowUUID']);
      const target = string(downstream['@id'] ?? downstream['@refObjectId']);
      return {
        upstreamIndex: instance.instance_id,
        downstreamIndex: target,
        outputFlowId: flow,
        inputFlowId: string(downstream['@flowUUID']) || flow,
        outputFlowVersion: optional(exchange['@version']),
        inputFlowVersion: optional(downstream['@version']),
        edgeId: [instance.instance_id, target, flow, index].join(':'),
      };
    });
  });
}

function kernelExchanges(source: ProcessRecord): KernelExchange[] {
  return ensureList(record(processDatasetRoot(source.raw).exchanges).exchange).map((value) => {
    const raw = record(value);
    const direction = string(raw.exchangeDirection).toUpperCase();
    const amount = Number(
      [raw.resultingAmount, raw.meanAmount, raw.meanValue].find(
        (v) => v !== '' && v !== undefined && v !== null,
      ),
    );
    if (direction !== 'INPUT' && direction !== 'OUTPUT')
      fail('Invalid direction in exact Process ' + source.processUuid + '@' + source.version);
    return {
      internalId: string(raw['@dataSetInternalID']),
      flowId: string(record(raw.referenceToFlowDataSet)['@refObjectId']),
      direction,
      amount: Number.isFinite(amount) ? amount : null,
      allocations: raw.allocations,
      raw,
    };
  });
}

function stableId(modelId: string, key: JsonObject): string {
  const namespace = Buffer.from(modelId.replaceAll('-', ''), 'hex');
  const id = createHash('sha1')
    .update(namespace)
    .update(JSON.stringify(key))
    .digest()
    .subarray(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x50;
  id[8] = (id[8]! & 0x3f) | 0x80;
  const hex = id.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function stripScientificClaims(payload: JsonObject, retained?: JsonObject) {
  const root = processDatasetRoot(payload);
  const info = record(root.processInformation);
  delete info.mathematicalRelations;
  delete root.LCIAResults;
  const validation = record(root.modellingAndValidation);
  const oldValidation = retained
    ? record(record(processDatasetRoot(retained).modellingAndValidation).validation)
    : {};
  const reviews = ensureList(oldValidation.review).filter(isRecord);
  validation.validation = {
    ...oldValidation,
    review:
      reviews.length > 0
        ? reviews.map((review) => ({ '@type': 'Not reviewed', ...review }))
        : { '@type': 'Not reviewed' },
  };
  const compliance = record(validation.complianceDeclarations);
  for (const item of ensureList(compliance.compliance).filter(isRecord)) {
    for (const key of [
      'approvalOfOverallCompliance',
      'nomenclatureCompliance',
      'methodologicalCompliance',
      'reviewCompliance',
      'documentationCompliance',
      'qualityCompliance',
    ])
      item['common:' + key] = 'Not defined';
  }
}

function exchangePayload(
  template: JsonObject,
  direction: KernelExchange['direction'],
  quantity: number,
  pivot: boolean,
  index: number,
) {
  const item = copyJson(template);
  for (const key of [
    'allocations',
    'allocatedFraction',
    'referenceToVariable',
    'minimumAmount',
    'maximumAmount',
    'uncertaintyDistributionType',
    'relativeStandardDeviation95In',
  ])
    delete item[key];
  return {
    ...item,
    '@dataSetInternalID': String(index + 1),
    exchangeDirection: direction === 'INPUT' ? 'Input' : 'Output',
    meanAmount: String(quantity),
    resultingAmount: String(quantity),
    quantitativeReference: pivot,
    dataDerivationTypeStatus: 'Calculated',
  };
}

export async function buildSolvedResultGroup(options: {
  model: JsonObject;
  identity: { id: string; version: string; name: string };
  modelName: JsonObject;
  referenceInstance: string | null;
  primary: { id: string; version: string };
  instances: ProcessInstance[];
  edges: Edge[];
  records: Record<string, ProcessRecord>;
  signature: string;
  metadataOverrides: JsonObject;
  targetAmount?: number;
  existing?: { members: JsonObject[]; processes: JsonObject[] };
}) {
  const { identity, instances, records } = options;
  const instanceById = new Map(instances.map((instance) => [instance.instance_id, instance]));
  const sourceFor = (instance: ProcessInstance) => {
    const source = records[instance.process_id + '@' + instance.process_version];
    if (!source || source.version !== instance.process_version)
      fail('The exact Process source is unavailable.');
    return source;
  };
  const reference = instanceById.get(options.referenceInstance ?? '');
  if (!reference) fail('Select an exact reference instance before calculating all results.');
  const targetAmount =
    options.targetAmount ?? sourceFor(reference).referenceAmount * reference.multiplication_factor;
  const result = await calculate({
    refInstanceIndex: reference.instance_id,
    targetAmount,
    instances: instances.map((instance) => {
      const source = sourceFor(instance);
      return {
        instanceIndex: instance.instance_id,
        processId: instance.process_id,
        processVersion: instance.process_version,
        process: {
          id: source.processUuid,
          version: source.version,
          exchanges: kernelExchanges(source),
          refExchangeInternalId: source.referenceExchangeInternalId,
        },
        connections: sourceConnections(instance),
      };
    }),
  });

  const products: ResultProcess[] = [];
  const make = (
    type: Member['type'],
    instance: ProcessInstance,
    finalId: JsonObject,
    exchangeItems: JsonObject[],
    included: ProcessInstance[],
  ): ResultProcess => {
    const old =
      options.existing?.members.filter((item) => {
        if (item.type !== type) return false;
        if (type === 'primary') return true;
        const oldId = record(item.finalId);
        return Object.entries(finalId).every(([key, value]) => oldId[key] === value);
      }) ?? [];
    if (old.length > 1) fail('More than one stored result matches a calculated product.', finalId);
    const prior = old[0];
    const id = prior
      ? string(prior.id)
      : type === 'primary'
        ? options.primary.id
        : stableId(identity.id, { type, ...finalId });
    const version = prior
      ? string(prior.version)
      : type === 'primary'
        ? options.primary.version
        : identity.version;
    const retained = prior
      ? options.existing?.processes.find((p) => p.id === id && p.version === version)?.json_ordered
      : undefined;
    if (prior && !isRecord(retained))
      fail('A declared result has no verified stored payload.', { id, version });
    const pivot = exchangeItems.find((e) => e.quantitativeReference === true);
    if (!pivot) fail('The calculated product has no quantitative reference.', finalId);
    const generatedName =
      type === 'primary'
        ? options.modelName
        : {
            ...options.modelName,
            baseName:
              record(pivot.referenceToFlowDataSet)['common:shortDescription'] ??
              options.modelName.baseName,
          };
    const json_ordered = materializeResultProcess(
      isRecord(retained) && type !== 'allocated' ? retained : sourceFor(instance).raw,
      exchangeItems,
      string(pivot['@dataSetInternalID']),
      {
        ...(type !== 'allocated' ? { sourceModel: options.model } : {}),
        sourceModelId: identity.id,
        sourceModelVersion: identity.version,
        sourceModelName: identity.name,
        sourceModelNameInfo: generatedName,
        processId: id,
        processVersion: version,
        role: type,
        projectionSignature: options.signature,
        processInstances: included,
        edges: options.edges,
        metadataOverrides: {
          ...options.metadataOverrides,
          ...(type === 'allocated' ? { type_of_data_set: 'Unit process, single operation' } : {}),
        },
        attachGraphSnapshotUri: null,
      },
    );
    const sourceInfo = record(
      record(processDatasetRoot(sourceFor(instance).raw).processInformation).dataSetInformation,
    );
    const resultInfo = record(
      record(processDatasetRoot(json_ordered).processInformation).dataSetInformation,
    );
    const modelInfo = record(record(options.model.lifeCycleModelInformation).dataSetInformation);
    resultInfo.classificationInformation =
      modelInfo.classificationInformation ??
      resultInfo.classificationInformation ??
      sourceInfo.classificationInformation;
    stripScientificClaims(json_ordered, isRecord(retained) ? retained : undefined);
    return { type, id, version, finalId, json_ordered };
  };

  for (const group of result.groups) {
    const instance = instanceById.get(group.root.instanceIndex)!;
    const finalId = {
      nodeId: instance.instance_id,
      processId: instance.process_id,
      allocatedExchangeFlowId: group.pivotFlowId,
      allocatedExchangeDirection: group.pivotDirection,
    };
    const included = instances.filter((source) =>
      group.refProcesses.some(
        (ref) => ref.id === source.process_id && ref.version === source.process_version,
      ),
    );
    products.push(
      make(
        group.type,
        instance,
        finalId,
        group.exchanges.map((exchange, index) =>
          exchangePayload(
            exchange.template.raw,
            exchange.direction,
            exchange.direction === 'INPUT' ? -exchange.amount : exchange.amount,
            exchange.quantitativeReference,
            index,
          ),
        ),
        included,
      ),
    );
  }

  // The canonical Model refers to allocated unit providers, while the editable
  // graph retains the original source Process references.
  const model = copyJson(options.model);
  const info = record(model.lifeCycleModelInformation);
  const processes = record(record(info.technology).processes);
  processes.processInstance = result.productSystem.instances.map((view) => {
    const instance = instanceById.get(view.sourceInstanceIndex)!;
    const source = copyJson(instance.raw);
    if (view.materialize) {
      const pivot = view.exchanges.find(
        (exchange) => exchange.internalId === view.refExchangeInternalId,
      )!;
      const finalId = {
        nodeId: instance.instance_id,
        processId: instance.process_id,
        sourceVersion: instance.process_version,
        exchangeId: view.sourceExchangeId,
        allocatedExchangeFlowId: pivot.flowId,
        allocatedExchangeDirection: pivot.direction,
      };
      const provider = make(
        'allocated',
        instance,
        finalId,
        view.exchanges.map((exchange, index) =>
          exchangePayload(
            exchange.raw,
            exchange.direction,
            exchange.amount!,
            exchange.internalId === view.refExchangeInternalId,
            index,
          ),
        ),
        [instance],
      );
      products.push(provider);
      source.referenceToProcess = {
        '@type': 'process data set',
        '@refObjectId': provider.id,
        '@version': provider.version,
        '@uri': '../processes/' + provider.id + '.xml',
        'common:shortDescription': record(pivot.raw.referenceToFlowDataSet)[
          'common:shortDescription'
        ],
      };
      delete source.parameters;
    }
    const flowOutputs = new Map<
      string,
      { '@flowUUID': string; '@version'?: string; downstreamProcess: JsonObject[] }
    >();
    for (const connection of view.connections) {
      const key = connection.outputFlowId + '@' + (connection.outputFlowVersion ?? '');
      const output = flowOutputs.get(key) ?? {
        '@flowUUID': connection.outputFlowId,
        '@version': connection.outputFlowVersion,
        downstreamProcess: [],
      };
      output.downstreamProcess.push({
        '@id': connection.downstreamIndex,
        '@flowUUID': connection.inputFlowId,
        '@version': connection.inputFlowVersion,
      });
      flowOutputs.set(key, output);
    }
    return {
      ...source,
      '@dataSetInternalID': view.instanceIndex,
      '@multiplicationFactor': String(view.multiplier),
      connections: { outputExchange: [...flowOutputs.values()] },
    };
  });
  record(info.quantitativeReference).referenceToReferenceProcess = Number(
    result.productSystem.refInstanceIndex,
  );
  const primary = products.find((item) => item.type === 'primary');
  if (!primary) fail('The calculated group is missing a primary result.');
  record(info.dataSetInformation).referenceToResultingProcess = {
    '@type': 'process data set',
    '@refObjectId': primary.id,
    '@version': primary.version,
    '@uri': '../processes/' + primary.id + '.xml',
    'common:shortDescription': options.modelName.baseName,
  };
  if (new Set(products.map((item) => item.id + '@' + item.version)).size !== products.length)
    fail('Calculated group members have conflicting identities.');
  return {
    products,
    model,
    kernelCommit,
    referenceQuantity: {
      instanceId: reference.instance_id,
      originalAmount: sourceFor(reference).referenceAmount,
      targetAmount,
    },
  };
}
