import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../../../shared/errors.js';
import { resolveProductionRuntimeEnv } from '../../config/env.js';
import type { FetchLike } from '../../transport/http.js';
import {
  fetchExactOrLatestProcessRow,
  normalizeSupabaseProcessPayload,
  requireSupabaseRestRuntime,
} from '../../transport/supabase-rest.js';
import { createSupabaseDataRuntime } from '../../auth/supabase-session.js';
import {
  type JsonObject,
  DEFAULT_DATASET_VERSION,
  REMOTE_PROCESS_LOOKUP_TIMEOUT_MS,
  type LifecyclemodelResultingProcessRequest,
  type RemoteProcessLookupContext,
  type ProcessRecord,
  type ProcessInstance,
  type Edge,
  isRecord,
  ensureList,
  copyJson,
  firstNonEmpty,
  uniqueStrings,
  readJsonObject,
  lifecyclemodelRoot,
  processDatasetRoot,
  resolveNameField,
  PathSafe,
} from './base.js';
import { resolveLocalPath, toFiniteNumber, normalizeNumericOutput } from './base.js';

export function requireRemoteProcessLookupRuntime(configuredEnv: NodeJS.ProcessEnv) {
  const env = resolveProductionRuntimeEnv(configuredEnv);
  const missing: string[] = [];
  if (typeof env.TIANGONG_LCA_API_BASE_URL !== 'string' || !env.TIANGONG_LCA_API_BASE_URL.trim()) {
    missing.push('TIANGONG_LCA_API_BASE_URL');
  }

  if (
    ![env.TIANGONG_LCA_OAUTH_CLIENT_ID, env.TIANGONG_LCA_ACCESS_TOKEN].some(
      (value) => typeof value === 'string' && value.trim(),
    )
  ) {
    missing.push('TIANGONG_LCA_OAUTH_CLIENT_ID or TIANGONG_LCA_ACCESS_TOKEN');
  }

  if (
    typeof env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY !== 'string' ||
    !env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY.trim()
  ) {
    missing.push('TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY');
  }

  if (missing.length > 0) {
    throw new CliError(
      `Remote process lookup requires ${missing.join(', ')} when process_sources.allow_remote_lookup=true.`,
      {
        code: 'LIFECYCLEMODEL_REMOTE_LOOKUP_ENV_REQUIRED',
        exitCode: 2,
        details: { missing },
      },
    );
  }

  return requireSupabaseRestRuntime(env);
}

export async function fetchRemoteProcessRecord(options: {
  processId: string;
  requestedVersion: string;
  runtime: ReturnType<typeof createSupabaseDataRuntime>;
  fetchImpl: FetchLike;
}): Promise<{
  record: ProcessRecord;
  resolution: 'remote_supabase_exact' | 'remote_supabase_latest_fallback';
  sourcePath: string;
  resolvedVersion: string;
}> {
  const lookupKey = `${options.processId}@${options.requestedVersion}`;
  try {
    const lookup = await fetchExactOrLatestProcessRow({
      runtime: options.runtime,
      id: options.processId,
      version: options.requestedVersion,
      timeoutMs: REMOTE_PROCESS_LOOKUP_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
      fallbackToLatest: true,
    });

    if (!lookup) {
      throw new CliError(`Could not resolve remote process dataset for ${lookupKey}.`, {
        code: 'LIFECYCLEMODEL_REMOTE_PROCESS_NOT_FOUND',
        exitCode: 2,
        details: { process_id: options.processId, version: options.requestedVersion },
      });
    }

    const record = parseProcessRecord(normalizeSupabaseProcessPayload(lookup.row.json, lookupKey), {
      sourceLabel: 'remote:supabase',
      sourcePath: lookup.sourceUrl,
    });

    return {
      record,
      resolution:
        lookup.resolution === 'remote_supabase_latest_fallback'
          ? 'remote_supabase_latest_fallback'
          : 'remote_supabase_exact',
      sourcePath: lookup.sourceUrl,
      resolvedVersion: lookup.row.version || record.version,
    };
  } catch (error) {
    if (error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID') {
      throw new CliError(`Remote process lookup returned an invalid response for ${lookupKey}.`, {
        code: 'LIFECYCLEMODEL_REMOTE_LOOKUP_RESPONSE_INVALID',
        exitCode: 1,
        details: error.details,
      });
    }

    throw error;
  }
}

export function extractProcessInstances(model: JsonObject): ProcessInstance[] {
  const root = lifecyclemodelRoot(model);
  const info = isRecord(root.lifeCycleModelInformation) ? root.lifeCycleModelInformation : {};
  const technology = isRecord(info.technology)
    ? info.technology
    : isRecord(root.technology)
      ? root.technology
      : {};
  const processes = isRecord(technology.processes) ? technology.processes : {};
  const instances = ensureList<JsonObject>(processes.processInstance);

  return instances.filter(isRecord).map((item, index) => {
    const ref = isRecord(item.referenceToProcess) ? item.referenceToProcess : {};
    const rawFactor = item['@multiplicationFactor'];
    if (rawFactor === undefined || rawFactor === null || String(rawFactor).trim() === '')
      throw new CliError('A process instance requires an explicit multiplication factor.', {
        code: 'LIFECYCLEMODEL_MULTIPLIER_REQUIRED',
        exitCode: 2,
      });
    if (typeof rawFactor !== 'string' && typeof rawFactor !== 'number')
      throw new CliError('A process instance multiplication factor must be a numeric scalar.', {
        code: 'LIFECYCLEMODEL_INVALID_NUMBER',
        exitCode: 2,
      });
    const factor = toFiniteNumber(rawFactor, 'processInstance.@multiplicationFactor');
    if (factor < 0)
      throw new CliError('A process instance multiplication factor must be nonnegative.', {
        code: 'LIFECYCLEMODEL_INVALID_NUMBER',
        exitCode: 2,
      });
    return {
      instance_id:
        firstNonEmpty(item['@dataSetInternalID'], item['@id'], item.id) ?? `pi-${index + 1}`,
      process_id: firstNonEmpty(ref['@refObjectId'], ref.id, ref.processId) ?? `proc-${index + 1}`,
      process_version: firstNonEmpty(ref['@version'], ref.version) ?? DEFAULT_DATASET_VERSION,
      label:
        firstNonEmpty(
          resolveNameField(ref['common:shortDescription']),
          resolveNameField(ref.shortDescription),
          resolveNameField(ref.name),
          ref['@refObjectId'],
        ) ?? `process-${index + 1}`,
      multiplication_factor: factor,
      reference_to_process: copyJson(ref),
      raw: copyJson(item),
    };
  });
}

export function extractEdges(model: JsonObject): Edge[] {
  const edges: Edge[] = [];

  extractProcessInstances(model).forEach((instance) => {
    const connections = isRecord(instance.raw.connections) ? instance.raw.connections : {};
    const outputs = ensureList<JsonObject>(connections.outputExchange);

    outputs.filter(isRecord).forEach((exchange, edgeIndex) => {
      const downstreamItems = ensureList<JsonObject>(exchange.downstreamProcess).filter(isRecord);
      downstreamItems.forEach((downstream, downstreamIndex) => {
        const downstreamId = firstNonEmpty(
          downstream['@refObjectId'],
          downstream['@id'],
          downstream.id,
          exchange.downstreamProcessId,
        );
        if (!downstreamId) {
          return;
        }

        edges.push({
          edge_id:
            firstNonEmpty(exchange['@id'], exchange.id) ??
            `${instance.instance_id}-edge-${edgeIndex + 1}-${downstreamIndex + 1}`,
          from: instance.instance_id,
          to: downstreamId,
          exchange_id: firstNonEmpty(exchange['@id'], exchange.id),
          flow_uuid: firstNonEmpty(
            exchange['@flowUUID'],
            downstream['@flowUUID'],
            exchange.flowUUID,
          ),
        });
      });
    });
  });

  return edges;
}

export function processReferencePairs(
  model: JsonObject,
): Array<{ process_id: string; version: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ process_id: string; version: string }> = [];

  extractProcessInstances(model).forEach((instance) => {
    const key = `${instance.process_id}@${instance.process_version}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    pairs.push({
      process_id: instance.process_id,
      version: instance.process_version,
    });
  });

  return pairs;
}

export function parseProcessRecord(
  payload: JsonObject,
  options: {
    sourceLabel: string;
    sourcePath: string | null;
  },
): ProcessRecord {
  const dataset = processDatasetRoot(payload);
  const info = isRecord(dataset.processInformation) ? dataset.processInformation : {};
  const dataInfo = isRecord(info.dataSetInformation) ? info.dataSetInformation : {};
  const administrative = isRecord(dataset.administrativeInformation)
    ? dataset.administrativeInformation
    : {};
  const publication = isRecord(administrative.publicationAndOwnership)
    ? administrative.publicationAndOwnership
    : {};
  const processUuid = firstNonEmpty(dataInfo['common:UUID']);
  if (!processUuid) {
    throw new CliError(`processDataSet missing common:UUID from ${options.sourceLabel}`, {
      code: 'LIFECYCLEMODEL_PROCESS_UUID_REQUIRED',
      exitCode: 2,
    });
  }

  const version = firstNonEmpty(publication['common:dataSetVersion']) ?? DEFAULT_DATASET_VERSION;
  const quantitativeReference = isRecord(info.quantitativeReference)
    ? info.quantitativeReference
    : {};
  const referenceInternalId = firstNonEmpty(quantitativeReference.referenceToReferenceFlow);
  const exchangesWrapper = isRecord(dataset.exchanges) ? dataset.exchanges : {};
  const exchanges = ensureList<JsonObject>(exchangesWrapper.exchange).filter(isRecord);
  const referenceExchange = exchanges.find(
    (item) => String(item['@dataSetInternalID'] ?? '') === String(referenceInternalId ?? ''),
  );

  if (!referenceExchange) {
    throw new CliError(
      `reference exchange ${referenceInternalId ?? '(missing)'} not found for process ${processUuid}`,
      {
        code: 'LIFECYCLEMODEL_REFERENCE_EXCHANGE_NOT_FOUND',
        exitCode: 2,
      },
    );
  }

  const inputAmounts: Record<string, number> = {};
  const outputAmounts: Record<string, number> = {};

  exchanges.forEach((exchange) => {
    const flowRef = isRecord(exchange.referenceToFlowDataSet)
      ? exchange.referenceToFlowDataSet
      : {};
    const flowUuid = firstNonEmpty(flowRef['@refObjectId']);
    const direction = firstNonEmpty(exchange.exchangeDirection) ?? '';
    if (!flowUuid) {
      return;
    }

    const amount = normalizeNumericOutput(
      toFiniteNumber(exchange.meanAmount ?? exchange.resultingAmount, 'exchange amount'),
    );

    if (direction === 'Input') {
      inputAmounts[flowUuid] = normalizeNumericOutput((inputAmounts[flowUuid] ?? 0) + amount);
    } else if (direction === 'Output') {
      outputAmounts[flowUuid] = normalizeNumericOutput((outputAmounts[flowUuid] ?? 0) + amount);
    }
  });

  const referenceFlow = isRecord(referenceExchange.referenceToFlowDataSet)
    ? referenceExchange.referenceToFlowDataSet
    : {};

  return {
    processUuid,
    version,
    raw: {
      processDataSet: dataset,
    },
    sourceLabel: options.sourceLabel,
    sourcePath: options.sourcePath,
    referenceExchangeInternalId: String(referenceInternalId ?? ''),
    referenceFlowUuid: firstNonEmpty(referenceFlow['@refObjectId']) ?? '',
    referenceDirection: firstNonEmpty(referenceExchange.exchangeDirection) ?? '',
    referenceAmount: normalizeNumericOutput(
      toFiniteNumber(
        referenceExchange.meanAmount ?? referenceExchange.resultingAmount,
        'reference amount',
      ),
    ),
    inputAmounts,
    outputAmounts,
  };
}

export function autoDetectProcessCatalogPath(modelPath: string | null): string | null {
  if (!modelPath) {
    return null;
  }

  const resolved = PathSafe.resolve(modelPath);
  if (!resolved) {
    return null;
  }

  if (path.basename(path.dirname(resolved)) !== 'lifecyclemodels') {
    return null;
  }

  const tidasBundleDir = path.dirname(path.dirname(resolved));
  if (path.basename(tidasBundleDir) !== 'tidas_bundle') {
    return null;
  }

  const candidate = path.join(path.dirname(tidasBundleDir), 'process-catalog.json');
  return existsSync(candidate) ? candidate : null;
}

export function autoDetectProcessJsonDirs(modelPath: string | null): string[] {
  if (!modelPath) {
    return [];
  }

  const resolved = PathSafe.resolve(modelPath);
  if (!resolved) {
    return [];
  }

  const candidates = [path.join(path.dirname(resolved), 'processes')];

  if (path.basename(path.dirname(resolved)) === 'lifecyclemodels') {
    candidates.push(path.join(path.dirname(path.dirname(resolved)), 'processes'));
  }

  const stem = path.basename(resolved, path.extname(resolved));
  if (stem.endsWith('-model')) {
    const prefix = stem.slice(0, -'-model'.length).trim();
    if (prefix) {
      candidates.push(path.join(path.dirname(resolved), `${prefix}-processes`));
    }
  }
  if (stem.endsWith('_model')) {
    const prefix = stem.slice(0, -'_model'.length).trim();
    if (prefix) {
      candidates.push(path.join(path.dirname(resolved), `${prefix}_processes`));
    }
  }

  return uniqueStrings(candidates.filter((candidate) => existsSync(candidate)));
}

export function processSourceDirs(request: LifecyclemodelResultingProcessRequest): string[] {
  const dirs = [...request.process_sources.process_json_dirs];

  request.process_sources.run_dirs.forEach((runDir) => {
    const candidate = path.join(runDir, 'exports', 'processes');
    if (existsSync(candidate)) {
      dirs.push(candidate);
    }
  });

  if (request.process_sources.process_catalog_path) {
    try {
      const payload = JSON.parse(
        readFileSync(request.process_sources.process_catalog_path, 'utf8'),
      ) as unknown;
      ensureList<JsonObject>(payload)
        .filter(isRecord)
        .forEach((item) => {
          const sourceLabel = firstNonEmpty(item.source_label);
          if (!sourceLabel) {
            return;
          }
          const candidate = path.join(sourceLabel, 'exports', 'processes');
          if (existsSync(candidate)) {
            dirs.push(candidate);
          }
        });
    } catch {
      // Keep local process resolution best-effort for catalog expansion.
    }
  }

  return uniqueStrings(dirs);
}

export function locateLocalProcessFile(
  processId: string,
  version: string,
  options: {
    processDirs: string[];
    processFiles: string[];
  },
): string | null {
  const targetFileName = `${processId}_${version}.json`;

  for (const directory of options.processDirs) {
    const candidate = path.join(directory, targetFileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const filePath of options.processFiles) {
    if (existsSync(filePath) && path.basename(filePath) === targetFileName) {
      return filePath;
    }
  }

  return null;
}

export async function resolveProcessRecords(
  request: LifecyclemodelResultingProcessRequest,
  options: {
    sourceModelJson: JsonObject;
    remoteLookup?: RemoteProcessLookupContext;
  },
): Promise<{
  records: Record<string, ProcessRecord>;
  resolutionSummary: JsonObject;
}> {
  const requiredPairs = processReferencePairs(options.sourceModelJson);
  const processFiles = request.process_sources.process_json_files;
  const processDirs = processSourceDirs(request);
  const records: Record<string, ProcessRecord> = {};
  const resolutionItems: JsonObject[] = [];
  const unresolved: Array<{ process_id: string; version: string }> = [];

  requiredPairs.forEach(({ process_id, version }) => {
    const localPath = locateLocalProcessFile(process_id, version, {
      processDirs,
      processFiles,
    });

    if (localPath) {
      const record = parseProcessRecord(
        readJsonObject(localPath, 'LIFECYCLEMODEL_PROCESS_FILE_NOT_OBJECT'),
        {
          sourceLabel: path.dirname(localPath),
          sourcePath: localPath,
        },
      );
      records[`${process_id}@${version}`] = record;
      resolutionItems.push({
        process_id,
        version,
        resolution: 'local_file',
        source_path: localPath,
      });
      return;
    }

    unresolved.push({ process_id, version });
  });

  if (unresolved.length > 0 && request.process_sources.allow_remote_lookup) {
    const env = options.remoteLookup?.env ?? process.env;
    const fetchImpl = options.remoteLookup?.fetchImpl ?? (fetch as FetchLike);
    const runtime = createSupabaseDataRuntime({
      runtime: requireRemoteProcessLookupRuntime(env),
      fetchImpl,
      timeoutMs: REMOTE_PROCESS_LOOKUP_TIMEOUT_MS,
    });

    for (const item of unresolved) {
      const remoteRecord = await fetchRemoteProcessRecord({
        processId: item.process_id,
        requestedVersion: item.version,
        runtime,
        fetchImpl,
      });
      records[`${item.process_id}@${item.version}`] = remoteRecord.record;
      resolutionItems.push({
        process_id: item.process_id,
        requested_version: item.version,
        resolved_version: remoteRecord.resolvedVersion,
        resolution: remoteRecord.resolution,
        source_path: remoteRecord.sourcePath,
      });
    }
  }

  const remainingUnresolved = requiredPairs.filter(
    ({ process_id, version }) => !records[`${process_id}@${version}`],
  );

  if (remainingUnresolved.length > 0) {
    const missing = remainingUnresolved
      .map((item) => `${item.process_id}@${item.version}`)
      .join(', ');
    throw new CliError(
      `Could not resolve referenced process datasets for lifecycle model: ${missing}.`,
      {
        code: 'LIFECYCLEMODEL_PROCESS_RESOLUTION_FAILED',
        exitCode: 2,
      },
    );
  }

  return {
    records,
    resolutionSummary: {
      required_process_count: requiredPairs.length,
      resolved_process_count: Object.keys(records).length,
      local_process_dir_count: processDirs.length,
      explicit_process_file_count: processFiles.length,
      remote_resolution_count: resolutionItems.filter((item) =>
        String(item.resolution).startsWith('remote_'),
      ).length,
      items: resolutionItems,
    },
  };
}

export function loadSourceModel(request: LifecyclemodelResultingProcessRequest): {
  sourceModelJson: JsonObject;
  modelPath: string | null;
} {
  if (request.source_model.json_ordered) {
    return {
      sourceModelJson: copyJson(request.source_model.json_ordered),
      modelPath: null,
    };
  }

  if (!request.source_model.json_ordered_path) {
    throw new CliError('source_model must include json_ordered or json_ordered_path.', {
      code: 'LIFECYCLEMODEL_SOURCE_MODEL_PATH_REQUIRED',
      exitCode: 2,
    });
  }

  const localPath = resolveLocalPath(
    request.source_model.json_ordered_path,
    'source_model.json_ordered_path',
  );

  return {
    sourceModelJson: readJsonObject(localPath, 'LIFECYCLEMODEL_SOURCE_MODEL_NOT_OBJECT'),
    modelPath: localPath,
  };
}
