// data-api-relations: lifecyclemodels
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';
import {
  buildSupabaseAuthHeaders,
  createSupabaseDataClient,
  deriveSupabaseFunctionsBaseUrl,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
} from './supabase-client.js';
import { createSupabaseDataRuntime } from './supabase-session.js';

type JsonObject = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NODE_WIDTH = 350;
const DEFAULT_NODE_HEIGHT = 120;
const DEFAULT_NODE_GAP_X = 420;
const DEFAULT_NODE_GAP_Y = 180;

export type LifecyclemodelPublishMetadata = {
  json_tg?: JsonObject;
  processMutations?: JsonObject[];
  ruleVerification?: boolean;
};

type LifecyclemodelVisibleRow = {
  id: string;
  version: string;
};

type LifecyclemodelBundlePlan = {
  mode: 'create' | 'update';
  modelId: string;
  version?: string;
  parent: {
    jsonOrdered: JsonObject;
    jsonTg: JsonObject;
    ruleVerification?: boolean;
  };
  processMutations: JsonObject[];
};

export type LifecyclemodelBundleWriteResult = {
  status: 'success';
  operation: 'create' | 'update' | 'update_after_create_conflict';
  mode: 'create' | 'update';
  transport: 'save_lifecycle_model_bundle';
  response: JsonObject;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureList<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? (value as T[]) : ([value] as T[]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const trimmed = trimToken(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function lifecyclemodelRoot(payload: JsonObject): JsonObject {
  return isRecord(payload.lifeCycleModelDataSet) ? payload.lifeCycleModelDataSet : payload;
}

function technology(root: JsonObject): JsonObject {
  const info = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  return isRecord(info.technology) ? info.technology : {};
}

function processesBlock(root: JsonObject): JsonObject {
  const tech = technology(root);
  return isRecord(tech.processes) ? tech.processes : {};
}

function extractProcessInstances(payload: JsonObject): JsonObject[] {
  return ensureList<JsonObject>(processesBlock(lifecyclemodelRoot(payload)).processInstance).filter(
    isRecord,
  );
}

function outputConnections(instance: JsonObject): JsonObject[] {
  const connections = isRecord(instance.connections) ? instance.connections : {};
  return ensureList<JsonObject>(connections.outputExchange).filter(isRecord);
}

function displayName(reference: JsonObject): unknown {
  if (reference.name !== undefined) {
    return cloneJson(reference.name);
  }

  if (reference['common:shortDescription'] !== undefined) {
    return cloneJson(reference['common:shortDescription']);
  }

  return undefined;
}

function buildNodeLabel(reference: JsonObject, fallback: string): unknown {
  return displayName(reference) ?? fallback;
}

function deriveXflowNodes(payload: JsonObject): JsonObject[] {
  const instances = extractProcessInstances(payload);
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(Math.max(instances.length, 1))));

  return instances.map((instance, index) => {
    const reference = isRecord(instance.referenceToProcess) ? instance.referenceToProcess : {};
    const internalId = firstNonEmpty(instance['@dataSetInternalID'], `node-${index + 1}`)!;
    const processId = firstNonEmpty(reference['@refObjectId'], `process-${index + 1}`)!;
    const version = trimToken(reference['@version']);
    const x = (index % columnCount) * DEFAULT_NODE_GAP_X;
    const y = Math.floor(index / columnCount) * DEFAULT_NODE_GAP_Y;

    return {
      id: internalId,
      x,
      y,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      data: {
        id: processId,
        ...(version ? { version } : {}),
        label: buildNodeLabel(reference, processId),
        shortDescription: cloneJson(reference['common:shortDescription'] ?? []),
      },
    };
  });
}

function deriveXflowEdges(payload: JsonObject): JsonObject[] {
  const instances = extractProcessInstances(payload);
  const nodeByInternalId = new Map<string, { processId: string; version: string | null }>(
    instances.map((instance, index) => {
      const reference = isRecord(instance.referenceToProcess) ? instance.referenceToProcess : {};
      return [
        firstNonEmpty(instance['@dataSetInternalID'], `node-${index + 1}`)!,
        {
          processId: firstNonEmpty(reference['@refObjectId'], `process-${index + 1}`)!,
          version: trimToken(reference['@version']),
        },
      ];
    }),
  );

  let edgeIndex = 0;
  const edges: JsonObject[] = [];

  instances.forEach((instance, index) => {
    const sourceCell = firstNonEmpty(instance['@dataSetInternalID'], `node-${index + 1}`)!;
    const sourceNode = nodeByInternalId.get(sourceCell)!;

    outputConnections(instance).forEach((outputExchange) => {
      const flowUuid = trimToken(outputExchange['@flowUUID']);
      const downstreamProcesses = ensureList<JsonObject>(outputExchange.downstreamProcess).filter(
        isRecord,
      );

      downstreamProcesses.forEach((downstreamProcess) => {
        const targetCell = trimToken(downstreamProcess['@id']);
        if (!targetCell) {
          return;
        }

        const targetNode = nodeByInternalId.get(targetCell) ?? { processId: null, version: null };
        edgeIndex += 1;
        edges.push({
          id: [sourceCell, targetCell, flowUuid ?? `edge-${edgeIndex}`].join(':'),
          source: {
            cell: sourceCell,
          },
          target: {
            cell: targetCell,
          },
          labels: [],
          data: {
            connection: {
              outputExchange: {
                ...(flowUuid ? { '@flowUUID': flowUuid } : {}),
                downstreamProcess: cloneJson(downstreamProcess),
              },
            },
            node: {
              sourceNodeID: sourceCell,
              targetNodeID: targetCell,
              sourceProcessId: sourceNode.processId,
              ...(sourceNode.version ? { sourceProcessVersion: sourceNode.version } : {}),
              ...(targetNode.processId ? { targetProcessId: targetNode.processId } : {}),
              ...(targetNode.version ? { targetProcessVersion: targetNode.version } : {}),
            },
          },
        });
      });
    });
  });

  return edges;
}

export function deriveLifecyclemodelJsonTg(payload: JsonObject): JsonObject {
  return {
    xflow: {
      nodes: deriveXflowNodes(payload),
      edges: deriveXflowEdges(payload),
    },
    // Inputs belong to the composition graph. Generated members require explicit metadata.
    submodels: [],
  };
}

function mergeLifecyclemodelJsonTg(explicit: JsonObject | null, derived: JsonObject): JsonObject {
  if (!explicit) {
    return derived;
  }

  const derivedXflow = isRecord(derived.xflow) ? derived.xflow : {};
  const explicitXflow = isRecord(explicit.xflow) ? explicit.xflow : null;

  return {
    ...derived,
    ...cloneJson(explicit),
    xflow: explicitXflow
      ? {
          ...cloneJson(derivedXflow),
          ...cloneJson(explicitXflow),
          nodes: Array.isArray(explicitXflow.nodes)
            ? cloneJson(explicitXflow.nodes)
            : derivedXflow.nodes,
          edges: Array.isArray(explicitXflow.edges)
            ? cloneJson(explicitXflow.edges)
            : derivedXflow.edges,
        }
      : derived.xflow,
    submodels: Array.isArray(explicit.submodels)
      ? cloneJson(explicit.submodels)
      : derived.submodels,
  };
}

function normalizeProcessMutations(value: unknown): JsonObject[] {
  if (value === undefined || value === null) {
    return [];
  }

  const mutations = ensureList<JsonObject>(value);
  if (!mutations.every(isRecord)) {
    throw new CliError(
      'Lifecyclemodel publish metadata expected processMutations to contain JSON objects.',
      {
        code: 'LIFECYCLEMODEL_PROCESS_MUTATIONS_INVALID',
        exitCode: 2,
        details: value,
      },
    );
  }

  return cloneJson(mutations);
}

function validateGeneratedMembers(explicit: JsonObject | null, payload: JsonObject): void {
  if (!explicit || explicit.submodels === undefined) return;
  const inputIds = new Set(
    extractProcessInstances(payload).map((instance) => {
      const ref = isRecord(instance.referenceToProcess) ? instance.referenceToProcess : {};
      return `${trimToken(ref['@refObjectId'])}@${trimToken(ref['@version'])}`;
    }),
  );
  const seen = new Set<string>();
  if (!Array.isArray(explicit.submodels)) {
    throw new CliError('json_tg.submodels must be an array of generated results.', {
      code: 'LIFECYCLEMODEL_GENERATED_MEMBERS_INVALID',
      exitCode: 2,
    });
  }
  for (const member of explicit.submodels) {
    const id = isRecord(member) ? trimToken(member.id) : null;
    const version = isRecord(member) ? trimToken(member.version) : null;
    const key = `${id}@${version}`;
    if (
      !id ||
      !version ||
      !['primary', 'secondary', 'allocated'].includes(String(member.type)) ||
      seen.has(key) ||
      (inputIds.has(key) && member.type !== 'allocated')
    ) {
      throw new CliError(
        'Generated members require unique id/version and primary, secondary or allocated type; an input cannot also be a primary or secondary result. Allocated providers may be composition members.',
        {
          code: 'LIFECYCLEMODEL_GENERATED_MEMBERS_INVALID',
          exitCode: 2,
        },
      );
    }
    seen.add(key);
  }
}

export function buildLifecyclemodelBundlePlan(options: {
  id: string;
  version: string;
  payload: JsonObject;
  metadata?: LifecyclemodelPublishMetadata | null;
  mode: 'create' | 'update';
}): LifecyclemodelBundlePlan {
  const explicitJsonTg = isRecord(options.metadata?.json_tg) ? options.metadata?.json_tg : null;
  const derivedJsonTg = deriveLifecyclemodelJsonTg(options.payload);
  validateGeneratedMembers(explicitJsonTg, options.payload);

  return {
    mode: options.mode,
    modelId: options.id,
    ...(options.mode === 'update' ? { version: options.version } : {}),
    parent: {
      jsonOrdered: cloneJson(options.payload),
      jsonTg: mergeLifecyclemodelJsonTg(explicitJsonTg, derivedJsonTg),
      ...(typeof options.metadata?.ruleVerification === 'boolean'
        ? { ruleVerification: options.metadata.ruleVerification }
        : {}),
    },
    processMutations: normalizeProcessMutations(options.metadata?.processMutations),
  };
}

function buildVisibleRowsUrl(restBaseUrl: string, id: string, version: string): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/lifecyclemodels`);
  url.searchParams.set('select', 'id,version');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

function parseVisibleRows(payload: unknown, url: string): LifecyclemodelVisibleRow[] {
  if (!Array.isArray(payload)) {
    throw new CliError(`Supabase REST response was not a JSON array for ${url}`, {
      code: 'SUPABASE_REST_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  return payload.map((item, index) => {
    if (!isRecord(item)) {
      throw new CliError(`Supabase REST row ${index} was not a JSON object for ${url}`, {
        code: 'SUPABASE_REST_RESPONSE_INVALID',
        exitCode: 1,
        details: item,
      });
    }

    return {
      id: trimToken(item.id) ?? '',
      version: trimToken(item.version) ?? '',
    };
  });
}

async function exactVisibleRows(options: {
  id: string;
  version: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<LifecyclemodelVisibleRow[]> {
  const runtime = createSupabaseDataRuntime({
    runtime: requireSupabaseRestRuntime(options.env),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const { client, restBaseUrl } = createSupabaseDataClient(
    runtime,
    options.fetchImpl,
    options.timeoutMs,
  );
  const url = buildVisibleRowsUrl(restBaseUrl, options.id, options.version);
  const payload = await runSupabaseArrayQuery(
    client
      .from('lifecyclemodels')
      .select('id,version')
      .eq('id', options.id)
      .eq('version', options.version),
    url,
  );

  return parseVisibleRows(payload, url);
}

function parseLifecyclemodelBundleJson(rawText: string, url: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new CliError(`Remote response was not valid JSON for ${url}`, {
      code: 'REMOTE_INVALID_JSON',
      exitCode: 1,
      details: String(error),
    });
  }
}

function requireLifecyclemodelBundleResponse(payload: unknown, url: string): JsonObject {
  if (!isRecord(payload)) {
    throw new CliError(`Lifecyclemodel bundle endpoint returned an unexpected payload for ${url}`, {
      code: 'REMOTE_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  if (payload.ok === false) {
    const code = trimToken(payload.code) ?? 'REMOTE_APPLICATION_ERROR';
    const message =
      trimToken(payload.message) ?? `Remote application response returned ok:false for ${url}`;
    throw new CliError(message, {
      code,
      exitCode: 1,
      details: payload.details ?? payload,
    });
  }

  return payload;
}

function throwLifecyclemodelBundleHttpError(
  status: number,
  payload: unknown,
  rawText: string,
  url: string,
): never {
  if (isRecord(payload)) {
    const code = trimToken(payload.code);
    const message = trimToken(payload.message);
    if (code && message) {
      throw new CliError(message, {
        code,
        exitCode: 1,
        details: payload.details ?? payload,
      });
    }
  }

  throw new CliError(`HTTP ${status} returned from ${url}`, {
    code: 'REMOTE_REQUEST_FAILED',
    exitCode: 1,
    details: rawText,
  });
}

async function invokeSaveLifecyclemodelBundle(options: {
  plan: LifecyclemodelBundlePlan;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<JsonObject> {
  const runtime = createSupabaseDataRuntime({
    runtime: requireSupabaseRestRuntime(options.env),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const accessToken = await runtime.getAccessToken();
  const url = `${deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl)}/save_lifecycle_model_bundle`;
  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      ...buildSupabaseAuthHeaders(runtime.publishableKey, accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options.plan),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const payload =
    contentType.includes('application/json') && rawText.length > 0
      ? parseLifecyclemodelBundleJson(rawText, url)
      : rawText;

  if (!response.ok) {
    throwLifecyclemodelBundleHttpError(response.status, payload, rawText, url);
  }

  return requireLifecyclemodelBundleResponse(payload, url);
}

export async function syncLifecyclemodelBundleRecord(options: {
  id: string;
  version: string;
  payload: JsonObject;
  metadata?: LifecyclemodelPublishMetadata | null;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<LifecyclemodelBundleWriteResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const visibleRows = await exactVisibleRows({
    id: options.id,
    version: options.version,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });

  if (visibleRows.length > 0) {
    return {
      status: 'success',
      operation: 'update',
      mode: 'update',
      transport: 'save_lifecycle_model_bundle',
      response: await invokeSaveLifecyclemodelBundle({
        plan: buildLifecyclemodelBundlePlan({
          id: options.id,
          version: options.version,
          payload: options.payload,
          metadata: options.metadata,
          mode: 'update',
        }),
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs,
      }),
    };
  }

  try {
    return {
      status: 'success',
      operation: 'create',
      mode: 'create',
      transport: 'save_lifecycle_model_bundle',
      response: await invokeSaveLifecyclemodelBundle({
        plan: buildLifecyclemodelBundlePlan({
          id: options.id,
          version: options.version,
          payload: options.payload,
          metadata: options.metadata,
          mode: 'create',
        }),
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs,
      }),
    };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'VERSION_CONFLICT') {
      throw error;
    }

    const visibleAfterConflict = await exactVisibleRows({
      id: options.id,
      version: options.version,
      env: options.env,
      fetchImpl: options.fetchImpl,
      timeoutMs,
    });
    if (visibleAfterConflict.length === 0) {
      throw error;
    }

    return {
      status: 'success',
      operation: 'update_after_create_conflict',
      mode: 'update',
      transport: 'save_lifecycle_model_bundle',
      response: await invokeSaveLifecyclemodelBundle({
        plan: buildLifecyclemodelBundlePlan({
          id: options.id,
          version: options.version,
          payload: options.payload,
          metadata: options.metadata,
          mode: 'update',
        }),
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs,
      }),
    };
  }
}

export const __testInternals = {
  buildLifecyclemodelBundlePlan,
  deriveLifecyclemodelJsonTg,
  exactVisibleRows,
  firstNonEmpty,
  mergeLifecyclemodelJsonTg,
  parseVisibleRows,
  requireLifecyclemodelBundleResponse,
  trimToken,
};
