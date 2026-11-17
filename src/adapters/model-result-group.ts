import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { object, isObject, text, type JsonObject } from '../application/dataset-types.js';
import { fetchCurrentUser } from '../lib/auth/auth-identity-receipt.js';
import { resolveDatasetCommandTransport } from '../lib/dataset/command.js';
import {
  buildLifecyclemodelBundlePlan,
  deriveLifecyclemodelJsonTg,
} from '../lib/model/bundle-save.js';
import { HttpResponseError, postJson, type FetchLike } from '../lib/transport/http.js';
import { buildSupabaseAuthHeaders } from '../lib/transport/supabase-client.js';
import {
  assertSeparateCommandFiles,
  readCommandInput,
  writeCommandOutput,
} from '../shared/command-files.js';
import { CommandInputError } from '../shared/command-result.js';
import { resolveRequestFile } from './model-input.js';

type Targets = { modelId: string; version: string };
type Existing = { members: JsonObject[]; processes: JsonObject[] };
type Snapshot = Existing & { model: JsonObject; revision: string };
type Generate = (request: JsonObject, existing?: Existing) => Promise<JsonObject>;

const protocol = 'model-bundle.v1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const key = (row: JsonObject) => String(row.id) + '@' + String(row.version);

function invalid(message: string): never {
  throw new CommandInputError('MODEL_RESULT_GROUP_INVALID', message);
}

function readObjects(value: unknown, field: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every(isObject))
    invalid(field + ' is not a complete record set.');
  return value;
}

function snapshotOf(reply: JsonObject, target: Targets): Snapshot | null {
  if (reply.status !== 'observed') invalid('The service did not return an observed snapshot.');
  if (reply.snapshot === null) return null;
  const observed = object(reply.snapshot, 'snapshot');
  const model = object(observed.model, 'snapshot Model');
  const revision = text(observed.revision, 'revision');
  if (
    !digestPattern.test(revision) ||
    model.id !== target.modelId ||
    model.version !== target.version
  )
    invalid('The snapshot identity or revision is invalid.');
  const members = readObjects(observed.members, 'members');
  const processes = readObjects(observed.processes, 'processes');
  if (
    new Set(members.map(key)).size !== members.length ||
    new Set(processes.map(key)).size !== processes.length ||
    members.length !== processes.length ||
    members.some(
      (member) =>
        !processes.some(
          (process) =>
            key(process) === key(member) &&
            process.model_id === target.modelId &&
            (process.model_version ?? process.version) === target.version,
        ),
    )
  )
    invalid('The stored Model and result members cannot be verified.');
  return { revision, model, members, processes };
}

export async function runModelResultGroup(
  request: JsonObject,
  inputPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  generate: Generate,
  stateDir = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'model-result-groups'),
): Promise<JsonObject> {
  const modelId = text(request.modelId, 'modelId');
  const version = text(request.version, 'version');
  const action = request.action;
  if (!uuidPattern.test(modelId) || !versionPattern.test(version))
    invalid('Select an exact Model UUID and version.');
  const fields =
    action === 'inspect'
      ? ['action', 'modelId', 'version']
      : action === 'save'
        ? [
            'action',
            'modelId',
            'version',
            'baseline',
            'generation',
            'expectedActor',
            'expectedEnvironment',
          ]
        : action === 'recover'
          ? ['action', 'modelId', 'version', 'operationId', 'expectedActor', 'expectedEnvironment']
          : [];
  if (!fields.length || Object.keys(request).some((k) => !fields.includes(k)))
    invalid('Select inspect, save, or recover and the corresponding documented inputs.');
  const target = { modelId, version };
  const transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 20_000 });
  const environment = new URL(transport.functionsBaseUrl).origin;
  const actor = await fetchCurrentUser({
    projectBaseUrl: environment,
    accessToken: transport.accessToken,
    publishableKey: transport.publishableKey,
    timeoutMs: transport.timeoutMs,
    fetchImpl,
  });
  const binding = { expectedActor: actor.userId, expectedEnvironment: environment };
  if (
    action !== 'inspect' &&
    (request.expectedActor !== binding.expectedActor ||
      request.expectedEnvironment !== binding.expectedEnvironment)
  )
    invalid('The signed-in actor or project differs from this original request.');
  const call = async (body: JsonObject) => {
    const reply: unknown = await postJson({
      url: transport.functionsBaseUrl + '/save_lifecycle_model_bundle',
      headers: {
        ...buildSupabaseAuthHeaders(transport.publishableKey, transport.accessToken),
        'Content-Type': 'application/json',
      },
      body: { protocol, ...target, ...body },
      timeoutMs: transport.timeoutMs,
      fetchImpl,
    });
    if (!isObject(reply) || reply.ok !== true || reply.protocol !== protocol)
      invalid(
        'The service did not acknowledge guarded Model result groups. Verify the server version.',
      );
    return reply;
  };
  const inspect = async () => snapshotOf(await call({ action: 'inspect' }), target);
  if (action === 'inspect') {
    const snapshot = await inspect();
    return { status: 'observed', ...target, ...binding, snapshot };
  }

  const outcome = async (
    reply: JsonObject,
    operationId: string,
    recoveryFile?: string,
  ): Promise<JsonObject> => {
    if (
      reply.status !== 'committed' ||
      reply.operationId !== operationId ||
      reply.modelId !== modelId ||
      reply.version !== version ||
      typeof reply.revision !== 'string' ||
      !digestPattern.test(reply.revision)
    )
      return {
        status: 'unknown',
        ...target,
        operationId,
        ...(recoveryFile ? { recoveryFile } : {}),
      };

    const receipt = {
      operationId,
      revision: reply.revision,
      savedAt: reply.savedAt,
      members: reply.members,
    };
    try {
      const current = await inspect();
      if (current?.revision === receipt.revision)
        return { status: 'verified', ...target, receipt, snapshot: current };
    } catch {
      // The original receipt remains valid if current readback is unavailable.
    }
    return {
      status: 'committed_readback_unverified',
      ...target,
      receipt,
      ...(recoveryFile ? { recoveryFile } : {}),
    };
  };

  if (action === 'recover') {
    const operationId = text(request.operationId, 'operationId');
    if (!uuidPattern.test(operationId)) invalid('Use the original operation UUID.');
    return outcome(await call({ action: 'recover', operationId }), operationId);
  }

  const baselinePath =
    request.baseline === null ? null : resolveRequestFile(request.baseline, inputPath);
  const base = baselinePath ? readCommandInput(baselinePath) : null;
  const current = await inspect();
  if (base) {
    if (
      base.modelId !== modelId ||
      base.version !== version ||
      base.expectedActor !== binding.expectedActor ||
      base.expectedEnvironment !== environment ||
      !isObject(base.snapshot) ||
      !current ||
      base.snapshot.revision !== current.revision ||
      current.model.state_code !== 0
    )
      throw new CommandInputError(
        'MODEL_BUNDLE_CONFLICT',
        'The Model, graph, or result group changed after inspection.',
        'conflict',
      );
  } else if (current) {
    throw new CommandInputError(
      'MODEL_BUNDLE_CONFLICT',
      'This exact Model already exists. Inspect it before updating.',
      'conflict',
    );
  }

  const generation = object(request.generation, 'generation');
  const artifacts = await generate(
    {
      ...generation,
      projection: { ...object(generation.projection ?? {}, 'projection'), mode: 'all-subproducts' },
    },
    current ?? undefined,
  );
  const qualification = object(artifacts.qualification, 'generation qualification');
  if (qualification.draft_ready !== true) {
    return {
      status: 'draft_validation_failed',
      ...target,
      qualification,
      validation: object(artifacts.projection ?? {}, 'generation report').member_validation,
    };
  }
  const bundle = object(artifacts.bundle, 'generated result group');
  const source = object(bundle.source_model, 'generated source Model');
  if (source.id !== modelId || source.version !== version)
    invalid('Generated Model identity does not match the requested target.');
  const generated = readObjects(bundle.projected_processes, 'generated members');
  const members = generated.map(({ id, version, role, finalId }) => ({
    id,
    version,
    type: role,
    finalId,
  }));
  const saved = new Set(current?.members.map(key) ?? []);
  const next = new Set(members.map(key));
  const mutations: JsonObject[] = generated.map((member) => ({
    op: saved.has(key(member)) ? 'update' : 'create',
    id: member.id,
    version: member.version,
    modelId,
    jsonOrdered: { processDataSet: object(member.json_ordered, 'result candidate').processDataSet },
    ruleVerification: false,
  }));
  for (const member of current?.members ?? []) {
    if (!next.has(key(member)))
      mutations.push({ op: 'delete', id: member.id, version: member.version });
  }
  const graph = current && isObject(current.model.json_tg) ? current.model.json_tg : {};
  const candidate = object(bundle.model_candidate, 'Model candidate');
  const sourceGraph = deriveLifecyclemodelJsonTg(object(bundle.editor_model, 'editor Model')).xflow;
  const storedGraph = isObject(graph.xflow) ? graph.xflow : {};
  const quantity = object(bundle.reference_quantity, 'calculated reference quantity');
  const storedNodes = Array.isArray(storedGraph.nodes) ? storedGraph.nodes.filter(isObject) : [];
  const nodeIds = new Map<unknown, unknown>();
  for (const node of sourceGraph.nodes) {
    const index = node.id;
    const data = object(node.data, 'generated node');
    const previous = storedNodes.find(
      (value) => value.id === index || (isObject(value.data) && value.data.index === index),
    );
    if (previous) {
      node.id = previous.id;
      nodeIds.set(index, node.id);
      for (const field of ['x', 'y', 'width', 'height', 'angle', 'position', 'size']) {
        if (Object.hasOwn(previous, field)) node[field] = previous[field];
      }
    }
    const isReference = index === quantity.instanceId;
    const originalAmount = Number(quantity.originalAmount);
    const targetAmount = Number(quantity.targetAmount);
    node.data = {
      ...data,
      index,
      quantitativeReference: isReference ? '1' : '0',
      ...(isReference
        ? { originalAmount, targetAmount, scalingFactor: targetAmount / originalAmount }
        : {}),
    };
  }
  for (const edge of sourceGraph.edges) {
    const connection = object(object(edge.data, 'generated edge').node, 'generated endpoints');
    for (const [endpoint, field] of [
      ['source', 'sourceNodeID'],
      ['target', 'targetNodeID'],
    ] as const) {
      const link = object(edge[endpoint], 'generated endpoint');
      link.cell = nodeIds.get(link.cell) ?? link.cell;
      connection[field] = link.cell;
    }
  }
  const plan = {
    ...buildLifecyclemodelBundlePlan({
      id: modelId,
      version,
      mode: current ? 'update' : 'create',
      payload: candidate,
      metadata: {
        json_tg: { ...graph, xflow: sourceGraph, submodels: members },
        processMutations: mutations,
        ruleVerification: false,
      },
    }),
    version,
  };

  const operationId = randomUUID();
  const recoveryFile = path.join(stateDir, operationId + '.json');
  if (baselinePath) assertSeparateCommandFiles(recoveryFile, baselinePath);
  writeCommandOutput(
    recoveryFile,
    { action: 'recover', ...target, ...binding, operationId },
    false,
  );
  let reply: JsonObject;
  try {
    reply = await call({
      action: 'save',
      operationId,
      plan,
      expectedRevision: current?.revision ?? null,
    });
  } catch (error) {
    if (error instanceof HttpResponseError && isObject(error.payload)) {
      const code = error.payload.code;
      if (
        typeof code === 'string' &&
        [
          'MODEL_BUNDLE_CONFLICT',
          'MODEL_MEMBERSHIP_INVALID',
          'MODEL_OPERATION_CONFLICT',
          'MODEL_MEMBERSHIP_BUSY',
          'VERSION_CONFLICT',
          'PROCESS_NOT_FOUND',
          'MODEL_NOT_FOUND',
          'FORBIDDEN',
          'AUTH_REQUIRED',
          'INVALID_PAYLOAD',
        ].includes(code)
      )
        throw new CommandInputError(
          code,
          'The service rejected the Model group save; inspect the current Model.',
          'conflict',
        );
    }
    try {
      reply = await call({ action: 'recover', operationId });
    } catch {
      reply = {};
    }
  }
  return { ...(await outcome(reply, operationId, recoveryFile)), qualification };
}
