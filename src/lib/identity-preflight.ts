import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { readRuntimeEnv } from './env.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { postJson } from './http.js';
import {
  datasetIdentity,
  detectDatasetKind,
  isRecord,
  readDatasetRowsInput,
  unwrapDatasetPayload,
  type DatasetKind,
  type JsonObject,
} from './dataset-local.js';
import { readJsonInput } from './io.js';
import { deriveSupabaseFunctionsBaseUrl, requireSupabaseRestRuntime } from './supabase-client.js';
import { resolveSupabaseUserSession } from './supabase-session.js';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';

type IdentityPreflightKind = 'process' | 'flow';

export type IdentityPreflightDecision =
  'reuse' | 'update_same_row' | 'version_bump' | 'create_new' | 'block_duplicate' | 'manual_review';

export type IdentityPreflightStatus = 'passed' | 'blocked' | 'needs_review';

export type IdentityPreflightFinding = {
  code: string;
  severity: 'info' | 'warning' | 'blocker';
  message: string;
  candidate_index?: number;
};

type ValidationSummary = {
  status: 'passed' | 'failed' | 'not_applicable';
  validator: string | null;
  issue_count: number;
  issues: Array<{
    path: string;
    message: string;
    code: string;
  }>;
};

type IdentityProfile = {
  id: string | null;
  version: string | null;
  state_code: number | null;
  names: string[];
  normalized_names: string[];
  identity_key: string;
  exchange_signature: string[];
  fields: Record<string, string | null | string[]>;
};

export type IdentityPreflightCandidateReport = {
  index: number;
  id: string | null;
  version: string | null;
  state_code: number | null;
  names: string[];
  fields: Record<string, string | null | string[]>;
  exchange_signature: string[];
  identity_key: string;
  match_score: number;
  match_reasons: string[];
  decision_hint: IdentityPreflightDecision | null;
};

export type IdentityPreflightCandidateSourceReport = {
  path: string;
  kind: 'embedded_request' | 'file' | 'directory' | 'remote_search';
  row_count: number;
  scanned_files: string[];
  endpoint?: string;
  query?: string;
  filter?: JsonObject | null;
  options?: JsonObject | null;
};

export type IdentityPreflightReport = {
  schema_version: 1;
  generated_at_utc: string;
  kind: IdentityPreflightKind;
  status: IdentityPreflightStatus;
  decision: IdentityPreflightDecision;
  confidence: 'high' | 'medium' | 'low';
  input_path: string;
  out_dir: string | null;
  target: {
    id: string | null;
    version: string | null;
    names: string[];
    fields: Record<string, string | null | string[]>;
    identity_key: string;
    exchange_signature: string[];
    schema_validation: ValidationSummary;
  };
  candidates: IdentityPreflightCandidateReport[];
  candidate_sources: IdentityPreflightCandidateSourceReport[];
  findings: IdentityPreflightFinding[];
  blockers: IdentityPreflightFinding[];
  next_action:
    | 'reuse_existing'
    | 'repair_existing_draft'
    | 'prepare_version_update'
    | 'materialize_new_payload'
    | 'stop_duplicate'
    | 'queue_manual_review';
  files: {
    identity_decision: string | null;
    candidates: string | null;
    candidate_sources: string | null;
  };
};

export type RunIdentityPreflightOptions = {
  inputPath: string;
  outDir?: string | null;
  rawInput?: unknown;
  candidateInputPaths?: string[];
  remoteCandidateSearch?: boolean;
  remoteQuery?: string | null;
  remoteFilter?: JsonObject | null;
  remoteLimit?: number | null;
  remoteDataSource?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  schemas?: Partial<Record<IdentityPreflightKind, SafeParseSchema>>;
};

export type RunProcessIdentityPreflightOptions = RunIdentityPreflightOptions;
export type RunFlowIdentityPreflightOptions = RunIdentityPreflightOptions;
export type ProcessIdentityPreflightReport = IdentityPreflightReport & { kind: 'process' };
export type FlowIdentityPreflightReport = IdentityPreflightReport & { kind: 'flow' };

type NormalizedInput = {
  target: JsonObject;
  candidates: JsonObject[];
  candidateInputPaths: string[];
  remoteCandidateSearch: RemoteCandidateSearchConfig;
};

type CandidateEvaluation = {
  report: IdentityPreflightCandidateReport;
  findings: IdentityPreflightFinding[];
};

type RemoteCandidateSearchConfig = {
  enabled: boolean;
  query: string | null;
  filter: JsonObject | null;
  profileHints: JsonObject | null;
  limit: number | null;
  dataSource: string | null;
  matchThreshold: number | null;
  lexicalWeight: number | null;
  semanticWeight: number | null;
  rrfK: number | null;
  pageSize: number | null;
  pageCurrent: number | null;
};

type RemoteCandidateRead = {
  rows: JsonObject[];
  source: IdentityPreflightCandidateSourceReport;
};

const SCHEMA_EXPORTS: Record<IdentityPreflightKind, keyof typeof tidasSdk> = {
  flow: 'FlowSchema' as keyof typeof tidasSdk,
  process: 'ProcessSchema' as keyof typeof tidasSdk,
};

const REMOTE_DATA_SOURCES = new Set(['tg', 'co', 'my', 'te']);

const ENTITY_FACTORY_EXPORTS: Record<IdentityPreflightKind, keyof typeof tidasSdk> = {
  flow: 'createFlow' as keyof typeof tidasSdk,
  process: 'createProcess' as keyof typeof tidasSdk,
};

function requiredInputPath(inputPath: string): string {
  const normalized = inputPath.trim();
  if (!normalized) {
    throw new CliError('Missing required --input value.', {
      code: 'IDENTITY_PREFLIGHT_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  return normalized;
}

function normalizeToRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new CliError(`${label} must be a JSON object.`, {
      code: 'IDENTITY_PREFLIGHT_INVALID_INPUT',
      exitCode: 2,
    });
  }
  return value;
}

function normalizeRows(value: unknown, label: string): JsonObject[] {
  if (value === undefined || value === null) {
    return [];
  }
  const rows = isRecord(value) && Array.isArray(value.rows) ? value.rows : value;
  const normalizedRows = Array.isArray(rows) ? rows : [rows];
  return normalizedRows.map((row, index) => normalizeToRecord(row, `${label}[${index}]`));
}

function normalizePathList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry, index) => {
    if (typeof entry !== 'string') {
      throw new CliError(`${label}[${index}] must be a string path.`, {
        code: 'IDENTITY_PREFLIGHT_INVALID_CANDIDATE_INPUT',
        exitCode: 2,
      });
    }
    return entry
      .split(',')
      .map((pathValue) => pathValue.trim())
      .filter(Boolean);
  });
}

function normalizePositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`Expected ${label} to be a positive integer.`, {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_LIMIT',
      exitCode: 2,
    });
  }
  return parsed;
}

function normalizeNonNegativeNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`Expected ${label} to be a non-negative number.`, {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_SEARCH_OPTION',
      exitCode: 2,
    });
  }
  return parsed;
}

function normalizeMatchThreshold(value: unknown): number | null {
  const parsed = normalizeNonNegativeNumber(value, 'remote_candidate_search.match_threshold');
  if (parsed === null) {
    return null;
  }
  if (parsed > 1) {
    throw new CliError('Expected remote_candidate_search.match_threshold to be between 0 and 1.', {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_SEARCH_OPTION',
      exitCode: 2,
    });
  }
  return parsed;
}

function emptyRemoteCandidateSearchConfig(enabled = false): RemoteCandidateSearchConfig {
  return {
    enabled,
    query: null,
    filter: null,
    profileHints: null,
    limit: null,
    dataSource: null,
    matchThreshold: null,
    lexicalWeight: null,
    semanticWeight: null,
    rrfK: null,
    pageSize: null,
    pageCurrent: null,
  };
}

function normalizeRemoteCandidateSearch(value: unknown): RemoteCandidateSearchConfig {
  if (value === undefined || value === null) {
    return emptyRemoteCandidateSearchConfig(false);
  }
  if (typeof value === 'boolean') {
    return emptyRemoteCandidateSearchConfig(value);
  }
  if (!isRecord(value)) {
    throw new CliError('remote_candidate_search must be a boolean or object.', {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_SEARCH',
      exitCode: 2,
    });
  }

  const enabled = value.enabled === undefined ? true : Boolean(value.enabled);
  const query = textValue(value.query) ?? textValue(value.search_query);
  const filter =
    value.filter === undefined || value.filter === null
      ? null
      : normalizeToRecord(value.filter, 'remote_candidate_search.filter');
  const profileHintsInput =
    value.profile_hints ?? value.profileHints ?? value.identity_profile_hints;
  const profileHints =
    profileHintsInput === undefined || profileHintsInput === null
      ? null
      : normalizeToRecord(profileHintsInput, 'remote_candidate_search.profile_hints');
  const dataSource =
    textValue(value.data_source) ?? textValue(value.dataSource) ?? textValue(value.source) ?? null;
  if (dataSource && !REMOTE_DATA_SOURCES.has(dataSource)) {
    throw new CliError('remote_candidate_search.data_source must be one of tg, co, my, or te.', {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_DATA_SOURCE',
      exitCode: 2,
    });
  }

  return {
    enabled,
    query,
    filter,
    profileHints,
    limit: normalizePositiveInteger(value.limit, 'remote_candidate_search.limit'),
    dataSource,
    matchThreshold: normalizeMatchThreshold(value.match_threshold ?? value.matchThreshold),
    lexicalWeight: normalizeNonNegativeNumber(
      value.lexical_weight ?? value.lexicalWeight,
      'remote_candidate_search.lexical_weight',
    ),
    semanticWeight: normalizeNonNegativeNumber(
      value.semantic_weight ?? value.semanticWeight,
      'remote_candidate_search.semantic_weight',
    ),
    rrfK: normalizePositiveInteger(value.rrf_k ?? value.rrfK, 'remote_candidate_search.rrf_k'),
    pageSize: normalizePositiveInteger(
      value.page_size ?? value.pageSize,
      'remote_candidate_search.page_size',
    ),
    pageCurrent: normalizePositiveInteger(
      value.page_current ?? value.pageCurrent,
      'remote_candidate_search.page_current',
    ),
  };
}

function pickKindTarget(input: JsonObject, kind: IdentityPreflightKind): unknown {
  if (input.target !== undefined) {
    return input.target;
  }
  if (input.candidate !== undefined) {
    return input.candidate;
  }
  if (kind === 'process' && input.process !== undefined) {
    return input.process;
  }
  if (kind === 'flow' && input.flow !== undefined) {
    return input.flow;
  }
  return input;
}

function normalizePreflightInput(rawInput: unknown, kind: IdentityPreflightKind): NormalizedInput {
  const input = normalizeToRecord(rawInput, 'identity preflight input');
  const target = normalizeToRecord(pickKindTarget(input, kind), 'identity preflight target');
  const candidateGroups = [
    ...normalizeRows(input.candidates, 'candidates'),
    ...normalizeRows(input.existing, 'existing'),
    ...normalizeRows(input.existing_rows, 'existing_rows'),
    ...normalizeRows(input.rows, 'rows'),
  ];

  return {
    target,
    candidates: candidateGroups,
    candidateInputPaths: [
      ...normalizePathList(input.candidate_input, 'candidate_input'),
      ...normalizePathList(input.candidate_inputs, 'candidate_inputs'),
      ...normalizePathList(input.candidateInputPaths, 'candidateInputPaths'),
      ...normalizePathList(input.candidate_files, 'candidate_files'),
      ...normalizePathList(input.candidateFiles, 'candidateFiles'),
    ],
    remoteCandidateSearch: normalizeRemoteCandidateSearch(
      input.remote_candidate_search ?? input.remoteCandidateSearch ?? input.remote_candidates,
    ),
  };
}

interface CandidateInputStats {
  isFile(): boolean;
  isDirectory(): boolean;
}

function isCandidateDatasetFile(filePath: string): boolean {
  return /\.(?:json|jsonl)$/iu.test(path.basename(filePath));
}

function throwUnsupportedCandidateInput(resolved: string): never {
  throw new CliError(`Candidate input must be a JSON/JSONL file or directory: ${resolved}`, {
    code: 'IDENTITY_PREFLIGHT_CANDIDATE_INPUT_UNSUPPORTED',
    exitCode: 2,
  });
}

function collectCandidateFilesFromStats(resolved: string, stats: CandidateInputStats): string[] {
  if (stats.isFile()) {
    if (!isCandidateDatasetFile(resolved)) {
      throwUnsupportedCandidateInput(resolved);
    }
    return [resolved];
  }
  if (!stats.isDirectory()) {
    throwUnsupportedCandidateInput(resolved);
  }

  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && isCandidateDatasetFile(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  visit(resolved);
  return files.sort((left, right) => left.localeCompare(right));
}

function collectCandidateFiles(candidatePath: string): string[] {
  const resolved = path.resolve(candidatePath);
  if (!existsSync(resolved)) {
    throw new CliError(`Candidate input not found: ${resolved}`, {
      code: 'IDENTITY_PREFLIGHT_CANDIDATE_INPUT_NOT_FOUND',
      exitCode: 2,
    });
  }

  const stats = statSync(resolved);
  return collectCandidateFilesFromStats(resolved, stats);
}

function readCandidateSource(candidatePath: string): {
  rows: JsonObject[];
  source: IdentityPreflightCandidateSourceReport;
} {
  const resolved = path.resolve(candidatePath);
  const files = collectCandidateFiles(resolved);
  const rows = files.flatMap((file) => readDatasetRowsInput(file));
  const kind = statSync(resolved).isDirectory() ? 'directory' : 'file';
  return {
    rows,
    source: {
      path: resolved,
      kind,
      row_count: rows.length,
      scanned_files: files,
    },
  };
}

function mergeRemoteCandidateSearchConfig(
  inputConfig: RemoteCandidateSearchConfig,
  options: RunIdentityPreflightOptions,
): RemoteCandidateSearchConfig {
  const dataSource = options.remoteDataSource?.trim() || inputConfig.dataSource;
  if (dataSource && !REMOTE_DATA_SOURCES.has(dataSource)) {
    throw new CliError('--remote-data-source must be one of tg, co, my, or te.', {
      code: 'IDENTITY_PREFLIGHT_INVALID_REMOTE_DATA_SOURCE',
      exitCode: 2,
    });
  }
  return {
    enabled: options.remoteCandidateSearch ?? inputConfig.enabled,
    query: options.remoteQuery?.trim() || inputConfig.query,
    filter: options.remoteFilter ?? inputConfig.filter,
    profileHints: inputConfig.profileHints,
    limit: options.remoteLimit ?? inputConfig.limit,
    dataSource,
    matchThreshold: inputConfig.matchThreshold,
    lexicalWeight: inputConfig.lexicalWeight,
    semanticWeight: inputConfig.semanticWeight,
    rrfK: inputConfig.rrfK,
    pageSize: inputConfig.pageSize,
    pageCurrent: inputConfig.pageCurrent,
  };
}

function remoteSearchEndpoint(kind: IdentityPreflightKind): string {
  return kind === 'process' ? 'process_hybrid_search' : 'flow_hybrid_search';
}

function isRemoteQueryNoiseText(value: string): boolean {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!text) {
    return true;
  }
  if (/^(not specified|not declared|unspecified|n\/a|none|null)$/iu.test(text)) {
    return true;
  }
  if (/^not specified by the .* source\.?$/iu.test(text)) {
    return true;
  }
  if (/^ilcd format$/iu.test(text)) {
    return true;
  }
  if (/^ilcd data network\s*-\s*entry-level$/iu.test(text)) {
    return true;
  }
  return false;
}

function queryFieldValues(value: string | null | string[], limit = 4): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => !isRemoteQueryNoiseText(entry))
    .slice(0, limit);
}

function appendQueryLine(
  lines: string[],
  label: string,
  value: string | null | string[],
  limit = 4,
) {
  const values = queryFieldValues(value, limit);
  if (values.length === 0) {
    return;
  }
  lines.push(`${label}: ${values.join('; ')}`);
}

function exchangeFlowRefsFromSignature(signature: string[]): string[] {
  const refs = new Set<string>();
  for (const entry of signature) {
    const ref = entry.split(':')[0]?.trim();
    if (ref) {
      refs.add(ref);
    }
    if (refs.size >= 8) {
      break;
    }
  }
  return [...refs];
}

function compactRemoteQuery(lines: string[], fallback: string): string | null {
  const text = lines
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1800)
    .trim();
  if (text) {
    return text;
  }
  return fallback ? fallback.slice(0, 1800).trim() || null : null;
}

function fallbackRemoteQueryText(profile: IdentityProfile): string {
  return (
    Object.values(profile.fields)
      .flat()
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
    profile.identity_key
  );
}

function flowRemoteQuery(profile: IdentityProfile): string | null {
  const lines: string[] = [];
  appendQueryLine(lines, 'flow name', profile.names, 4);
  appendQueryLine(lines, 'flow type', profile.fields.type_of_dataset);
  appendQueryLine(lines, 'CAS', profile.fields.cas);
  appendQueryLine(lines, 'reference property', profile.fields.flow_property);
  appendQueryLine(lines, 'reference unit', profile.fields.reference_unit);
  appendQueryLine(lines, 'category or compartment', profile.fields.categories, 6);
  appendQueryLine(lines, 'geography or market', profile.fields.geography);
  return compactRemoteQuery(lines, fallbackRemoteQueryText(profile));
}

function processRemoteQuery(profile: IdentityProfile): string | null {
  const lines: string[] = [];
  appendQueryLine(lines, 'process name', profile.names, 4);
  appendQueryLine(
    lines,
    'reference flow',
    [
      ...queryFieldValues(profile.fields.reference_flow_names, 4),
      ...queryFieldValues(profile.fields.reference_flow_ids, 4),
    ],
    8,
  );
  appendQueryLine(lines, 'quantitative reference', profile.fields.quantitative_reference);
  appendQueryLine(lines, 'geography', profile.fields.geography);
  appendQueryLine(lines, 'time', profile.fields.time);
  appendQueryLine(lines, 'classification or sector', profile.fields.categories, 6);
  appendQueryLine(lines, 'technology route', profile.fields.technology_route);
  appendQueryLine(lines, 'system boundary', profile.fields.system_boundary);
  appendQueryLine(lines, 'operation', profile.fields.operation);
  appendQueryLine(lines, 'provider role', profile.fields.provider_role);
  appendQueryLine(
    lines,
    'exchange flow refs',
    exchangeFlowRefsFromSignature(profile.exchange_signature),
    8,
  );
  return compactRemoteQuery(lines, fallbackRemoteQueryText(profile));
}

function defaultRemoteQuery(profile: IdentityProfile): string | null {
  const hasProcessFields =
    'reference_flow_ids' in profile.fields ||
    'technology_route' in profile.fields ||
    profile.exchange_signature.length > 0;
  return hasProcessFields ? processRemoteQuery(profile) : flowRemoteQuery(profile);
}

function remoteSearchFilter(
  kind: IdentityPreflightKind,
  profile: IdentityProfile,
  explicitFilter: JsonObject | null,
): JsonObject | null {
  const filter: JsonObject = explicitFilter ? { ...explicitFilter } : {};
  if (kind === 'flow' && filter.flowType === undefined) {
    const flowType = Array.isArray(profile.fields.type_of_dataset)
      ? profile.fields.type_of_dataset[0]
      : profile.fields.type_of_dataset;
    if (flowType) {
      filter.flowType = flowType;
    }
  }
  return Object.keys(filter).length > 0 ? filter : null;
}

function remoteSearchOptions(config: RemoteCandidateSearchConfig): JsonObject | null {
  const options: JsonObject = {
    ...(config.matchThreshold !== null ? { match_threshold: config.matchThreshold } : {}),
    ...(config.lexicalWeight !== null ? { lexical_weight: config.lexicalWeight } : {}),
    ...(config.semanticWeight !== null ? { semantic_weight: config.semanticWeight } : {}),
    ...(config.rrfK !== null ? { rrf_k: config.rrfK } : {}),
    ...(config.pageSize !== null ? { page_size: config.pageSize } : {}),
    ...(config.pageCurrent !== null ? { page_current: config.pageCurrent } : {}),
  };
  return Object.keys(options).length > 0 ? options : null;
}

function rowsFromRemoteSearchResponse(value: unknown): JsonObject[] {
  const rows = isRecord(value)
    ? (value.data ?? value.rows ?? value.results ?? value.candidates ?? [])
    : value;
  if (rows === undefined || rows === null) {
    return [];
  }
  return normalizeRows(rows, 'remote search candidates');
}

async function readRemoteCandidateSource(
  kind: IdentityPreflightKind,
  targetProfile: IdentityProfile,
  config: RemoteCandidateSearchConfig,
  options: RunIdentityPreflightOptions,
): Promise<RemoteCandidateRead | null> {
  if (!config.enabled) {
    return null;
  }

  const query = config.query ?? defaultRemoteQuery(targetProfile);
  if (!query) {
    throw new CliError('Remote identity candidate search requires a query.', {
      code: 'IDENTITY_PREFLIGHT_REMOTE_QUERY_REQUIRED',
      exitCode: 2,
    });
  }

  const runtimeEnv = readRuntimeEnv(options.env ?? process.env);
  const runtime = requireSupabaseRestRuntime(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const endpoint = remoteSearchEndpoint(kind);
  const url = `${deriveSupabaseFunctionsBaseUrl(runtime.apiBaseUrl)}/${endpoint}`;
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl,
    timeoutMs,
    now: options.now,
  });
  const filter = remoteSearchFilter(kind, targetProfile, config.filter);
  const searchOptions = remoteSearchOptions(config);
  const pageSize = config.pageSize ?? config.limit;
  const sourceOptions: JsonObject = {
    ...(config.limit ? { limit: config.limit, match_count: config.limit } : {}),
    ...(pageSize ? { page_size: pageSize } : {}),
    ...(config.dataSource ? { data_source: config.dataSource } : {}),
    ...(searchOptions ?? {}),
  };
  const body: JsonObject = {
    query,
    ...(filter ? { filter } : {}),
    ...(config.limit ? { match_count: config.limit } : {}),
    ...(pageSize ? { page_size: pageSize } : {}),
    ...(config.dataSource ? { data_source: config.dataSource } : {}),
    ...(searchOptions ?? {}),
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
  };
  if (runtimeEnv.region) {
    headers['x-region'] = runtimeEnv.region;
  }

  const response = await postJson({
    url,
    headers,
    body,
    timeoutMs,
    fetchImpl,
  });
  const rows = rowsFromRemoteSearchResponse(response);
  const limitedRows = config.limit ? rows.slice(0, config.limit) : rows;
  return {
    rows: limitedRows,
    source: {
      path: url,
      kind: 'remote_search',
      row_count: limitedRows.length,
      scanned_files: [],
      endpoint,
      query,
      filter,
      options: Object.keys(sourceOptions).length > 0 ? sourceOptions : null,
    },
  };
}

function schemaForKind(
  kind: IdentityPreflightKind,
  schemas: Partial<Record<IdentityPreflightKind, SafeParseSchema>> | undefined,
): { validator: string; schema: SafeParseSchema; createEntity: SdkValidationFactory | null } {
  if (schemas?.[kind]) {
    return {
      validator: 'injected',
      schema: schemas[kind],
      createEntity: null,
    };
  }

  const exportName = SCHEMA_EXPORTS[kind];
  const candidate = (tidasSdk as Record<string, unknown>)[exportName];
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as SafeParseSchema).safeParse !== 'function'
  ) {
    throw new CliError(`${String(exportName)} is unavailable in @tiangong-lca/tidas-sdk.`, {
      code: 'IDENTITY_PREFLIGHT_SCHEMA_UNAVAILABLE',
      exitCode: 2,
      details: { kind },
    });
  }

  const factoryName = ENTITY_FACTORY_EXPORTS[kind];
  const createEntity = (tidasSdk as Record<string, unknown>)[factoryName];
  return {
    validator: `@tiangong-lca/tidas-sdk/${String(exportName)}`,
    schema:
      kind === 'process'
        ? withOptionalReviewReportReference(candidate as SafeParseSchema, 'processes')
        : (candidate as SafeParseSchema),
    createEntity:
      typeof createEntity === 'function' ? (createEntity as SdkValidationFactory) : null,
  };
}

function validateTargetSchema(
  target: JsonObject,
  kind: IdentityPreflightKind,
  schemas: Partial<Record<IdentityPreflightKind, SafeParseSchema>> | undefined,
): ValidationSummary {
  const detectedKind = detectDatasetKind(target);
  if (detectedKind && detectedKind !== kind) {
    return {
      status: 'failed',
      validator: null,
      issue_count: 1,
      issues: [
        {
          path: '<root>',
          message: `Expected ${kind} target but detected ${detectedKind}.`,
          code: 'dataset_kind_mismatch',
        },
      ],
    };
  }

  if (!detectedKind) {
    return {
      status: 'not_applicable',
      validator: null,
      issue_count: 0,
      issues: [],
    };
  }

  const { validator, schema, createEntity } = schemaForKind(kind, schemas);
  const payload = unwrapDatasetPayload(target);
  const outcome = validateSchemaWithDeepFallback(schema, payload, createEntity);
  if (outcome.success) {
    return {
      status: 'passed',
      validator,
      issue_count: 0,
      issues: [],
    };
  }

  return {
    status: 'failed',
    validator,
    issue_count: outcome.issues.length,
    issues: outcome.issues.map((issue) => ({
      path: normalizeIssuePath(issue.path),
      message: issue.message ?? 'Validation failed',
      code: issue.code ?? 'custom',
    })),
  };
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeKey(key: string): string {
  return key
    .split(':')
    .pop()!
    .replace(/[^a-zA-Z0-9]+/gu, '')
    .toLowerCase();
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function collectText(value: unknown, output: string[] = []): string[] {
  const direct = textValue(value);
  if (direct) {
    output.push(direct);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, output);
    }
    return output;
  }
  if (isRecord(value)) {
    if (textValue(value['#text'])) {
      output.push(textValue(value['#text']) as string);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '#text' || key.startsWith('@')) {
        continue;
      }
      collectText(entry, output);
    }
  }
  return output;
}

function collectValuesByKey(
  value: unknown,
  wantedKeys: Set<string>,
  output: unknown[] = [],
): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectValuesByKey(entry, wantedKeys, output);
    }
    return output;
  }
  if (!isRecord(value)) {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (wantedKeys.has(normalizeKey(key))) {
      output.push(entry);
    }
    collectValuesByKey(entry, wantedKeys, output);
  }
  return output;
}

function uniqueTexts(values: unknown[]): string[] {
  const normalized = new Map<string, string>();
  for (const value of values) {
    for (const text of collectText(value)) {
      const key = normalizeText(text);
      if (key && !normalized.has(key)) {
        normalized.set(key, text.trim());
      }
    }
  }
  return [...normalized.values()].sort((a, b) => normalizeText(a).localeCompare(normalizeText(b)));
}

function uniqueTextsInOrder(values: unknown[]): string[] {
  const normalized = new Map<string, string>();
  for (const value of values) {
    for (const text of collectText(value)) {
      const key = normalizeText(text);
      if (key && !normalized.has(key)) {
        normalized.set(key, text.trim());
      }
    }
  }
  return [...normalized.values()];
}

function firstUniqueText(...values: unknown[]): string | null {
  return uniqueTexts(values)[0] ?? null;
}

function firstTextInOrder(...values: unknown[]): string | null {
  return uniqueTextsInOrder(values)[0] ?? null;
}

function pathValue(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function textAtPath(value: unknown, keys: string[]): string | null {
  return firstTextInOrder(pathValue(value, keys));
}

function textsAtPath(value: unknown, keys: string[]): string[] {
  return uniqueTextsInOrder([pathValue(value, keys)]);
}

function recordsFromValue(value: unknown): JsonObject[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(isRecord);
}

function meaningfulTexts(values: string[]): string[] {
  return values.filter((value) => !isRemoteQueryNoiseText(value));
}

function meaningfulText(value: string | null): string | null {
  return value && !isRemoteQueryNoiseText(value) ? value : null;
}

function fieldFromKeys(row: JsonObject, payload: JsonObject, keys: string[]): string | null {
  const wanted = new Set(keys.map(normalizeKey));
  return firstUniqueText(
    ...collectValuesByKey(row, wanted),
    ...collectValuesByKey(payload, wanted),
  );
}

function textListFromKeys(row: JsonObject, payload: JsonObject, keys: string[]): string[] {
  const wanted = new Set(keys.map(normalizeKey));
  return uniqueTexts([...collectValuesByKey(row, wanted), ...collectValuesByKey(payload, wanted)]);
}

function normalizedList(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))].sort();
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function collectExchangeLikeRecords(value: unknown, output: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectExchangeLikeRecords(entry, output);
    }
    return output;
  }
  if (!isRecord(value)) {
    return output;
  }

  const keys = new Set(Object.keys(value).map(normalizeKey));
  if (
    keys.has('referencetoflowdataset') ||
    keys.has('flowid') ||
    keys.has('flowuuid') ||
    keys.has('flow') ||
    keys.has('exchangedirection')
  ) {
    output.push(value);
  }

  for (const entry of Object.values(value)) {
    collectExchangeLikeRecords(entry, output);
  }
  return output;
}

function exchangeRecordSignature(record: JsonObject): string | null {
  const flowReference = isRecord(record.referenceToFlowDataSet)
    ? record.referenceToFlowDataSet
    : null;
  const flowId =
    firstTextInOrder(
      flowReference?.['@refObjectId'],
      record['@refObjectId'],
      record.refObjectId,
      record.flow_id,
      record.flowId,
      record.flow_uuid,
      record.flowUuid,
    ) ??
    fieldFromKeys(record, record, [
      '@refObjectId',
      'refObjectId',
      'flow_id',
      'flowId',
      'flow_uuid',
      'flowUuid',
    ]);
  const direction =
    firstTextInOrder(
      record.exchangeDirection,
      record.direction,
      record.inputGroup,
      record.outputGroup,
    ) ??
    fieldFromKeys(record, record, ['exchangeDirection', 'direction', 'inputGroup', 'outputGroup']);
  const amount =
    firstTextInOrder(
      record.meanAmount,
      record.mean_amount,
      record.resultingAmount,
      record.resulting_amount,
      record.amount,
      record.meanValue,
    ) ??
    fieldFromKeys(record, record, [
      'meanAmount',
      'mean_amount',
      'resultingAmount',
      'resulting_amount',
      'amount',
      'meanValue',
    ]);

  const normalizedFlowId = flowId ? normalizeText(flowId) : '';
  if (!normalizedFlowId) {
    return null;
  }
  return [normalizedFlowId, normalizeText(direction ?? ''), normalizeText(amount ?? '')].join(':');
}

function processExchangeSignature(row: JsonObject, payload: JsonObject): string[] {
  return [
    ...new Set(
      [...collectExchangeLikeRecords(row), ...collectExchangeLikeRecords(payload)]
        .map(exchangeRecordSignature)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ].sort();
}

function profileDatasetIdentity(
  row: JsonObject,
  payload: JsonObject,
  kind: IdentityPreflightKind,
): { id: string | null; version: string | null } {
  const detectedKind = detectDatasetKind(row);
  const identity = datasetIdentity(
    row,
    payload,
    detectedKind === kind ? (kind as DatasetKind) : null,
  );
  return {
    id: firstUniqueText(row.id, row.process_id, row.flow_id, row.uuid, identity.id) ?? identity.id,
    version:
      firstUniqueText(row.version, row.dataset_version, identity.version) ?? identity.version,
  };
}

function tidasRoot(payload: JsonObject, kind: IdentityPreflightKind): JsonObject | null {
  if (kind === 'process' && isRecord(payload.processDataSet)) {
    return payload.processDataSet;
  }
  if (kind === 'flow' && isRecord(payload.flowDataSet)) {
    return payload.flowDataSet;
  }
  return null;
}

function processCanonicalNames(root: JsonObject): string[] {
  const nameRoot = pathValue(root, ['processInformation', 'dataSetInformation', 'name']);
  return meaningfulTexts(
    uniqueTextsInOrder([
      pathValue(nameRoot, ['baseName']),
      pathValue(nameRoot, ['treatmentStandardsRoutes']),
      pathValue(nameRoot, ['mixAndLocationTypes']),
      pathValue(nameRoot, ['functionalUnitFlowProperties']),
    ]),
  );
}

function flowCanonicalNames(root: JsonObject): string[] {
  const nameRoot = pathValue(root, ['flowInformation', 'dataSetInformation', 'name']);
  return meaningfulTexts(
    uniqueTextsInOrder([
      pathValue(nameRoot, ['baseName']),
      pathValue(nameRoot, ['treatmentStandardsRoutes']),
      pathValue(nameRoot, ['mixAndLocationTypes']),
    ]),
  );
}

function classificationTexts(root: JsonObject, informationPath: string[]): string[] {
  const classes = recordsFromValue(
    pathValue(root, [
      ...informationPath,
      'dataSetInformation',
      'classificationInformation',
      'common:classification',
      'common:class',
    ]),
  );
  return meaningfulTexts(
    uniqueTextsInOrder(classes.flatMap((entry) => [entry['@classId'], entry['#text']])),
  );
}

function elementaryFlowCategoryTexts(root: JsonObject): string[] {
  const categories = recordsFromValue(
    pathValue(root, [
      'flowInformation',
      'dataSetInformation',
      'classificationInformation',
      'common:elementaryFlowCategorization',
      'common:category',
    ]),
  );
  return meaningfulTexts(
    uniqueTextsInOrder(categories.flatMap((entry) => [entry['@level'], entry['#text']])),
  ).filter((entry) => !/^\d+$/u.test(entry));
}

function processReferenceExchange(root: JsonObject): JsonObject | null {
  const referenceFlowInternalIds = textsAtPath(root, [
    'processInformation',
    'quantitativeReference',
    'referenceToReferenceFlow',
  ]);
  const internalIdSet = new Set(referenceFlowInternalIds.map(normalizeText));
  const exchanges = recordsFromValue(pathValue(root, ['exchanges', 'exchange']));
  const referenceExchanges =
    internalIdSet.size > 0
      ? exchanges.filter((exchange) =>
          internalIdSet.has(normalizeText(textValue(exchange['@dataSetInternalID']) ?? '')),
        )
      : [];
  return referenceExchanges[0] ?? exchanges[0] ?? null;
}

function processReferenceFlowValues(root: JsonObject): { ids: string[]; names: string[] } {
  const selected = processReferenceExchange(root);
  if (!selected) {
    return { ids: [], names: [] };
  }
  const reference = isRecord(selected.referenceToFlowDataSet)
    ? selected.referenceToFlowDataSet
    : {};
  return {
    ids: meaningfulTexts(uniqueTextsInOrder([reference['@refObjectId'], selected['@refObjectId']])),
    names: meaningfulTexts(
      uniqueTextsInOrder([reference['common:shortDescription'], reference.shortDescription]),
    ),
  };
}

function processCanonicalFields(root: JsonObject): {
  names: string[];
  referenceFlowIds: string[];
  quantitativeReference: string | null;
  geography: string | null;
  time: string | null;
  technologyRoute: string | null;
  systemBoundary: string | null;
  categories: string[];
  referenceFlowNames: string[];
} {
  const names = processCanonicalNames(root);
  const referenceFlow = processReferenceFlowValues(root);
  return {
    names,
    referenceFlowIds: referenceFlow.ids,
    referenceFlowNames: referenceFlow.names,
    quantitativeReference:
      meaningfulText(
        textAtPath(root, ['processInformation', 'quantitativeReference', 'functionalUnitOrOther']),
      ) ??
      meaningfulText(
        textAtPath(root, [
          'processInformation',
          'quantitativeReference',
          'referenceToReferenceFlow',
        ]),
      ),
    geography: meaningfulText(
      textAtPath(root, [
        'processInformation',
        'geography',
        'locationOfOperationSupplyOrProduction',
        '@location',
      ]),
    ),
    time: meaningfulText(
      firstTextInOrder(
        pathValue(root, ['processInformation', 'time', 'common:referenceYear']),
        pathValue(root, ['processInformation', 'time', 'common:timeRepresentativenessDescription']),
      ),
    ),
    technologyRoute: meaningfulText(
      textAtPath(root, [
        'processInformation',
        'technology',
        'technologyDescriptionAndIncludedProcesses',
      ]),
    ),
    systemBoundary: meaningfulText(
      textAtPath(root, ['processInformation', 'technology', 'includedProcesses']),
    ),
    categories: classificationTexts(root, ['processInformation']),
  };
}

function flowCanonicalFields(root: JsonObject): {
  names: string[];
  typeOfDataset: string | null;
  cas: string | null;
  flowProperty: string | null;
  referenceUnit: string | null;
  categories: string[];
  geography: string | null;
} {
  const flowProperties = recordsFromValue(pathValue(root, ['flowProperties', 'flowProperty']));
  const typeOfDataset = meaningfulText(
    textAtPath(root, ['modellingAndValidation', 'LCIMethod', 'typeOfDataSet']),
  );
  const elementaryCategories =
    typeOfDataset === 'Elementary flow' ? elementaryFlowCategoryTexts(root) : [];
  return {
    names: flowCanonicalNames(root),
    typeOfDataset,
    cas: meaningfulText(textAtPath(root, ['flowInformation', 'dataSetInformation', 'CASNumber'])),
    flowProperty: meaningfulText(
      firstTextInOrder(
        ...flowProperties.map((property) =>
          pathValue(property, ['referenceToFlowPropertyDataSet', 'common:shortDescription']),
        ),
      ),
    ),
    referenceUnit: null,
    categories: elementaryCategories.length
      ? elementaryCategories
      : classificationTexts(root, ['flowInformation']),
    geography: meaningfulText(
      textAtPath(root, ['flowInformation', 'dataSetInformation', 'name', 'mixAndLocationTypes']),
    ),
  };
}

function processProfile(row: JsonObject): IdentityProfile {
  const payload = unwrapDatasetPayload(row);
  const identity = profileDatasetIdentity(row, payload, 'process');
  const canonicalRoot = tidasRoot(payload, 'process');
  const canonical = canonicalRoot ? processCanonicalFields(canonicalRoot) : null;
  const names = canonical?.names.length
    ? canonical.names
    : textListFromKeys(row, payload, [
        'name',
        'baseName',
        'shortDescription',
        'name_en',
        'name_zh',
      ]);
  const referenceFlowIds = canonical?.referenceFlowIds.length
    ? canonical.referenceFlowIds
    : textListFromKeys(row, payload, [
        'reference_flow_id',
        'referenceFlowId',
        'reference_product_flow',
        'referenceProductFlow',
        'referenceToReferenceFlow',
        'referenceToFlowDataSet',
        '@refObjectId',
        'refObjectId',
      ]);
  const referenceFlowNames = canonical?.referenceFlowNames.length
    ? canonical.referenceFlowNames
    : textListFromKeys(row, payload, [
        'reference_flow_name',
        'referenceFlowName',
        'reference_product_flow_name',
        'referenceProductFlowName',
      ]);
  const operation = fieldFromKeys(row, payload, ['operation', 'process_operation']);
  const quantitativeReference =
    canonicalRoot && canonical
      ? canonical.quantitativeReference
      : fieldFromKeys(row, payload, [
          'quantitative_reference',
          'quantitativeReference',
          'qref',
          'referenceToReferenceFlow',
        ]);
  const geography =
    canonicalRoot && canonical
      ? canonical.geography
      : fieldFromKeys(row, payload, [
          'geography',
          'location',
          'locationOfOperationSupplyOrProduction',
        ]);
  const time =
    canonicalRoot && canonical
      ? canonical.time
      : fieldFromKeys(row, payload, ['time', 'reference_year', 'referenceYear', 'timePeriod']);
  const technologyRoute =
    canonicalRoot && canonical
      ? canonical.technologyRoute
      : fieldFromKeys(row, payload, [
          'technology_route',
          'technologyRoute',
          'technology',
          'treatmentStandardsRoutes',
        ]);
  const systemBoundary =
    canonicalRoot && canonical
      ? canonical.systemBoundary
      : fieldFromKeys(row, payload, ['system_boundary', 'systemBoundary', 'boundary']);
  const providerRole = fieldFromKeys(row, payload, ['provider_role', 'providerRole']);
  const categories = canonical?.categories.length
    ? canonical.categories
    : textListFromKeys(row, payload, ['category', 'class', 'classification']);
  const exchangeSignature = processExchangeSignature(row, payload);
  const keyParts = [
    ...normalizedList(names).slice(0, 4),
    ...normalizedList(referenceFlowIds).slice(0, 4),
    ...normalizedList(referenceFlowNames).slice(0, 2),
    normalizeText(operation ?? ''),
    normalizeText(quantitativeReference ?? ''),
    normalizeText(geography ?? ''),
    normalizeText(time ?? ''),
    normalizeText(technologyRoute ?? ''),
    normalizeText(systemBoundary ?? ''),
    normalizeText(providerRole ?? ''),
    ...normalizedList(categories).slice(0, 4),
    exchangeSignature.join(','),
  ].filter(Boolean);

  return {
    id: identity.id,
    version: identity.version,
    state_code: numberOrNull(row.state_code ?? row.stateCode),
    names,
    normalized_names: normalizedList(names),
    identity_key: keyParts.join('|'),
    exchange_signature: exchangeSignature,
    fields: {
      reference_flow_ids: referenceFlowIds,
      reference_flow_names: referenceFlowNames,
      operation,
      quantitative_reference: quantitativeReference,
      geography,
      time,
      technology_route: technologyRoute,
      system_boundary: systemBoundary,
      provider_role: providerRole,
      categories,
    },
  };
}

function flowProfile(row: JsonObject): IdentityProfile {
  const payload = unwrapDatasetPayload(row);
  const identity = profileDatasetIdentity(row, payload, 'flow');
  const canonicalRoot = tidasRoot(payload, 'flow');
  const canonical = canonicalRoot ? flowCanonicalFields(canonicalRoot) : null;
  const names = canonical?.names.length
    ? canonical.names
    : textListFromKeys(row, payload, [
        'name',
        'baseName',
        'shortDescription',
        'name_en',
        'name_zh',
        'synonyms',
      ]);
  const typeOfDataset =
    canonicalRoot && canonical
      ? canonical.typeOfDataset
      : fieldFromKeys(row, payload, ['type_of_dataset', 'typeOfDataSet', 'flow_type', 'flowType']);
  const cas =
    canonicalRoot && canonical
      ? canonical.cas
      : fieldFromKeys(row, payload, ['CASNumber', 'cas_number', 'cas']);
  const flowProperty =
    canonicalRoot && canonical
      ? canonical.flowProperty
      : fieldFromKeys(row, payload, [
          'flow_property',
          'flowProperty',
          'referenceToFlowPropertyDataSet',
          'reference_property',
          'referenceProperty',
        ]);
  const referenceUnit =
    canonicalRoot && canonical
      ? canonical.referenceUnit
      : fieldFromKeys(row, payload, ['reference_unit', 'referenceUnit', 'unit']);
  const categories = canonical?.categories.length
    ? canonical.categories
    : textListFromKeys(row, payload, ['category', 'class', 'classification', 'compartment']);
  const geography =
    canonicalRoot && canonical
      ? canonical.geography
      : fieldFromKeys(row, payload, ['geography', 'location', 'market', 'mixAndLocationTypes']);
  const keyParts = [
    normalizeText(typeOfDataset ?? ''),
    ...normalizedList(names).slice(0, 4),
    normalizeText(cas ?? ''),
    normalizeText(flowProperty ?? ''),
    normalizeText(referenceUnit ?? ''),
    ...normalizedList(categories).slice(0, 4),
    normalizeText(geography ?? ''),
  ].filter(Boolean);

  return {
    id: identity.id,
    version: identity.version,
    state_code: numberOrNull(row.state_code ?? row.stateCode),
    names,
    normalized_names: normalizedList(names),
    identity_key: keyParts.join('|'),
    exchange_signature: [],
    fields: {
      type_of_dataset: typeOfDataset,
      cas,
      flow_property: flowProperty,
      reference_unit: referenceUnit,
      categories,
      geography,
    },
  };
}

const PROFILE_ARRAY_FIELDS = new Set(['categories', 'reference_flow_ids', 'reference_flow_names']);

const PROFILE_HINT_KEYS: Record<IdentityPreflightKind, Record<string, string[]>> = {
  flow: {
    type_of_dataset: ['type_of_dataset', 'typeOfDataSet', 'flow_type', 'flowType'],
    cas: ['cas', 'CAS', 'CASNumber', 'cas_number'],
    flow_property: ['flow_property', 'flowProperty', 'reference_property', 'referenceProperty'],
    reference_unit: ['reference_unit', 'referenceUnit', 'unit'],
    categories: ['categories', 'category', 'classification', 'source_categories'],
    geography: ['geography', 'location', 'market'],
  },
  process: {
    reference_flow_ids: ['reference_flow_ids', 'referenceFlowIds', 'reference_flow_id'],
    reference_flow_names: ['reference_flow_names', 'referenceFlowNames', 'reference_flow_name'],
    operation: ['operation', 'process_operation'],
    quantitative_reference: ['quantitative_reference', 'quantitativeReference', 'qref'],
    geography: ['geography', 'location'],
    time: ['time', 'reference_year', 'referenceYear', 'timePeriod'],
    technology_route: ['technology_route', 'technologyRoute', 'technology'],
    system_boundary: ['system_boundary', 'systemBoundary', 'boundary'],
    provider_role: ['provider_role', 'providerRole'],
    categories: ['categories', 'category', 'classification', 'source_categories'],
  },
};

function hintTextValues(value: unknown, limit = 8): string[] {
  return uniqueTextsInOrder([value])
    .map((entry) => entry.trim())
    .filter((entry) => !isRemoteQueryNoiseText(entry))
    .slice(0, limit);
}

function hintValuesByKeys(hints: JsonObject, keys: string[], limit = 8): string[] {
  const values: unknown[] = [];
  for (const key of keys) {
    if (hints[key] !== undefined) {
      values.push(hints[key]);
    }
  }
  return hintTextValues(values, limit);
}

function identityKeyFromProfile(
  kind: IdentityPreflightKind,
  names: string[],
  fields: Record<string, string | null | string[]>,
  exchangeSignature: string[],
): string {
  if (kind === 'process') {
    return [
      ...normalizedList(names).slice(0, 4),
      ...normalizedList(normalizedFieldValues(fields.reference_flow_ids)).slice(0, 4),
      ...normalizedList(normalizedFieldValues(fields.reference_flow_names)).slice(0, 2),
      normalizeText(typeof fields.operation === 'string' ? fields.operation : ''),
      normalizeText(
        typeof fields.quantitative_reference === 'string' ? fields.quantitative_reference : '',
      ),
      normalizeText(typeof fields.geography === 'string' ? fields.geography : ''),
      normalizeText(typeof fields.time === 'string' ? fields.time : ''),
      normalizeText(typeof fields.technology_route === 'string' ? fields.technology_route : ''),
      normalizeText(typeof fields.system_boundary === 'string' ? fields.system_boundary : ''),
      normalizeText(typeof fields.provider_role === 'string' ? fields.provider_role : ''),
      ...normalizedList(normalizedFieldValues(fields.categories)).slice(0, 4),
      exchangeSignature.join(','),
    ]
      .filter(Boolean)
      .join('|');
  }

  return [
    normalizeText(typeof fields.type_of_dataset === 'string' ? fields.type_of_dataset : ''),
    ...normalizedList(names).slice(0, 4),
    normalizeText(typeof fields.cas === 'string' ? fields.cas : ''),
    normalizeText(typeof fields.flow_property === 'string' ? fields.flow_property : ''),
    normalizeText(typeof fields.reference_unit === 'string' ? fields.reference_unit : ''),
    ...normalizedList(normalizedFieldValues(fields.categories)).slice(0, 4),
    normalizeText(typeof fields.geography === 'string' ? fields.geography : ''),
  ]
    .filter(Boolean)
    .join('|');
}

function applyIdentityProfileHints(
  profile: IdentityProfile,
  hints: JsonObject | null,
  kind: IdentityPreflightKind,
): IdentityProfile {
  if (!hints) {
    return profile;
  }

  const hintedNames = hintValuesByKeys(hints, ['names', 'name', 'name_en', 'name_zh'], 6);
  const names = hintedNames.length > 0 ? hintedNames : profile.names;
  const fields = { ...profile.fields };
  const fieldHints = PROFILE_HINT_KEYS[kind];
  for (const [field, keys] of Object.entries(fieldHints)) {
    const values = hintValuesByKeys(hints, keys, PROFILE_ARRAY_FIELDS.has(field) ? 12 : 4);
    if (values.length === 0) {
      continue;
    }
    fields[field] = PROFILE_ARRAY_FIELDS.has(field) ? values : values[0]!;
  }

  return {
    ...profile,
    names,
    normalized_names: normalizedList(names),
    fields,
    identity_key: identityKeyFromProfile(kind, names, fields, profile.exchange_signature),
  };
}

function profileForKind(row: JsonObject, kind: IdentityPreflightKind): IdentityProfile {
  return kind === 'process' ? processProfile(row) : flowProfile(row);
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
}

function normalizedNamePhrase(names: string[]): string {
  return normalizeText(names.join(' '));
}

const FLOW_NAME_EQUIVALENTS = new Map<string, string>([
  ['dinitrogen monoxide', 'nitrous oxide'],
  ['ethene', 'ethylene'],
  ['ethylene', 'ethylene'],
  ['heat waste', 'waste heat'],
  ['nitrous oxide', 'nitrous oxide'],
  ['pah polycyclic aromatic hydrocarbons', 'polycyclic aromatic hydrocarbons'],
  ['polycyclic aromatic hydrocarbons', 'polycyclic aromatic hydrocarbons'],
  ['waste heat', 'waste heat'],
]);

function normalizeCas(value: string): string {
  return value.replace(/\D+/gu, '').replace(/^0+/u, '');
}

function normalizeFlowNameVariant(value: string): string {
  const normalized = normalizeText(value).replace(/\bsulphur\b/gu, 'sulfur');
  return FLOW_NAME_EQUIVALENTS.get(normalized) ?? normalized;
}

function expandedFlowNameVariants(value: string): string[] {
  const normalized = normalizeFlowNameVariant(value);
  const variants = [normalized];
  const transformation = normalized.match(/^transformation\s+(to|from)\s+(.+)$/u);
  if (transformation?.[1] && transformation[2]) {
    variants.push(`${transformation[1]} ${transformation[2]}`);
  }
  const occupation = normalized.match(/^occupation\s+(.+)$/u);
  if (occupation?.[1]) {
    variants.push(`occupation ${occupation[1]}`);
  }
  return variants;
}

function flowNameVariants(names: string[]): string[] {
  return normalizedList(names).flatMap(expandedFlowNameVariants).filter(Boolean);
}

function nameTokens(names: string[]): Set<string> {
  return new Set(
    normalizedNamePhrase(names)
      .split(' ')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 2),
  );
}

function tokenOverlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(left.size, right.size);
}

function tokenCoverageRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }
  return overlap / left.size;
}

function coversLongTargetTokens(left: Set<string>, right: Set<string>): boolean {
  return [...left].filter((token) => token.length >= 5).every((token) => right.has(token));
}

function hasSimilarNamePhrase(target: IdentityProfile, candidate: IdentityProfile): boolean {
  const targetPhrase = normalizedNamePhrase(target.names);
  const candidatePhrase = normalizedNamePhrase(candidate.names);
  if (targetPhrase.length >= 8 && candidatePhrase.length >= 8) {
    if (targetPhrase.includes(candidatePhrase) || candidatePhrase.includes(targetPhrase)) {
      return true;
    }
  }

  const targetTokens = nameTokens(target.names);
  const candidateTokens = nameTokens(candidate.names);
  const coversTargetQualifiers = coversLongTargetTokens(targetTokens, candidateTokens);
  return (
    (coversTargetQualifiers && tokenOverlapRatio(targetTokens, candidateTokens) >= 0.66) ||
    (targetTokens.size >= 3 &&
      tokenCoverageRatio(targetTokens, candidateTokens) >= 0.8 &&
      coversTargetQualifiers)
  );
}

function hasStrongEquivalentFlowName(target: IdentityProfile, candidate: IdentityProfile): boolean {
  return (
    intersects(target.normalized_names, candidate.normalized_names) ||
    intersects(flowNameVariants(target.names), flowNameVariants(candidate.names))
  );
}

function hasEquivalentFlowName(target: IdentityProfile, candidate: IdentityProfile): boolean {
  return hasStrongEquivalentFlowName(target, candidate) || hasSimilarNamePhrase(target, candidate);
}

function isElementaryFlowProfile(profile: IdentityProfile): boolean {
  return sameNonEmptyField(profile.fields.type_of_dataset, 'Elementary flow');
}

function hasConflictingFlowName(target: IdentityProfile, candidate: IdentityProfile): boolean {
  if (!isElementaryFlowProfile(target) || !isElementaryFlowProfile(candidate)) {
    return false;
  }
  if (target.names.length === 0 || candidate.names.length === 0) {
    return false;
  }
  if (hasEquivalentFlowName(target, candidate)) {
    return false;
  }
  if (sameCasField(target.fields.cas, candidate.fields.cas)) {
    return false;
  }
  return true;
}

function normalizedFieldValues(value: string | null | string[]): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeText)
    .filter(Boolean);
}

function sameNonEmptyField(
  left: string | null | string[],
  right: string | null | string[],
): boolean {
  const leftValues = normalizedFieldValues(left);
  const rightValues = normalizedFieldValues(right);
  return leftValues.length > 0 && rightValues.length > 0 && intersects(leftValues, rightValues);
}

function sameCasField(left: string | null | string[], right: string | null | string[]): boolean {
  const leftValues = (Array.isArray(left) ? left : [left])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeCas)
    .filter(Boolean);
  const rightValues = (Array.isArray(right) ? right : [right])
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeCas)
    .filter(Boolean);
  return leftValues.length > 0 && rightValues.length > 0 && intersects(leftValues, rightValues);
}

function lastNormalizedValue(value: string | null | string[]): string | null {
  const values = normalizedFieldValues(value);
  return values.length > 0 ? values[values.length - 1] : null;
}

function sameCategoryLeaf(
  left: string | null | string[],
  right: string | null | string[],
): boolean {
  const leftLeaf = lastNormalizedValue(left);
  const rightLeaf = lastNormalizedValue(right);
  return Boolean(leftLeaf && rightLeaf && leftLeaf === rightLeaf);
}

function sameCategoryPath(
  left: string | null | string[],
  right: string | null | string[],
): boolean {
  const leftValues = normalizedFieldValues(left);
  const rightValues = normalizedFieldValues(right);
  return (
    leftValues.length > 0 &&
    leftValues.length === rightValues.length &&
    leftValues.every((entry, index) => entry === rightValues[index])
  );
}

function elementaryCompartmentKey(value: string): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  if (
    /\blow\s*pop\b/u.test(normalized) ||
    normalized.includes('low population') ||
    normalized.includes('non urban air') ||
    normalized.includes('high stacks')
  ) {
    return 'air_non_urban_or_high_stacks';
  }
  if (
    /\bhigh\s*pop\b/u.test(normalized) ||
    normalized.includes('high population') ||
    normalized.includes('urban air close to ground')
  ) {
    return 'air_urban_close_to_ground';
  }
  if (normalized.includes('air indoor') || normalized.includes('indoor air')) {
    return 'air_indoor';
  }
  if (normalized.includes('air unspecified long term')) {
    return 'air_unspecified_long_term';
  }
  if (normalized.includes('air unspecified')) {
    return 'air_unspecified';
  }
  if (normalized.includes('fresh water')) {
    return 'water_fresh';
  }
  if (normalized.includes('sea water')) {
    return 'water_sea';
  }
  if (normalized.includes('water unspecified long term')) {
    return 'water_unspecified_long_term';
  }
  if (normalized.includes('water unspecified')) {
    return 'water_unspecified';
  }
  if (normalized.includes('agricultural soil') && !normalized.includes('non agricultural soil')) {
    return 'soil_agricultural';
  }
  if (normalized.includes('non agricultural soil')) {
    return 'soil_non_agricultural';
  }
  if (normalized.includes('soil unspecified')) {
    return 'soil_unspecified';
  }
  return null;
}

function sameElementaryCompartment(
  left: string | null | string[],
  right: string | null | string[],
): boolean {
  const leftKeys = normalizedFieldValues(left)
    .map(elementaryCompartmentKey)
    .filter((entry): entry is string => Boolean(entry));
  const rightKeys = normalizedFieldValues(right)
    .map(elementaryCompartmentKey)
    .filter((entry): entry is string => Boolean(entry));
  return leftKeys.length > 0 && rightKeys.length > 0 && intersects(leftKeys, rightKeys);
}

function sameExchangeSignature(left: string[], right: string[]): boolean {
  return left.length > 0 && right.length > 0 && left.join('|') === right.join('|');
}

function hasEquivalentFlowCore(target: IdentityProfile, candidate: IdentityProfile): boolean {
  const hasSameType = sameNonEmptyField(
    target.fields.type_of_dataset,
    candidate.fields.type_of_dataset,
  );
  const hasSameProperty = sameNonEmptyField(
    target.fields.flow_property,
    candidate.fields.flow_property,
  );
  const hasSameUnit = sameNonEmptyField(
    target.fields.reference_unit,
    candidate.fields.reference_unit,
  );
  const hasSameCas = sameCasField(target.fields.cas, candidate.fields.cas);
  const hasSameCategory = sameNonEmptyField(target.fields.categories, candidate.fields.categories);
  const hasSameCategoryLeaf = sameCategoryLeaf(
    target.fields.categories,
    candidate.fields.categories,
  );
  const hasSameCategoryPath = sameCategoryPath(
    target.fields.categories,
    candidate.fields.categories,
  );
  const hasEquivalentName = hasEquivalentFlowName(target, candidate);
  const hasStrongEquivalentName = hasStrongEquivalentFlowName(target, candidate);
  const isElementary =
    sameNonEmptyField(target.fields.type_of_dataset, 'Elementary flow') &&
    sameNonEmptyField(candidate.fields.type_of_dataset, 'Elementary flow');
  const hasEquivalentElementaryCompartment =
    isElementary &&
    sameElementaryCompartment(target.fields.categories, candidate.fields.categories);

  if (isElementary) {
    return (
      hasSameType &&
      hasSameProperty &&
      hasStrongEquivalentName &&
      (hasSameCategoryLeaf || hasSameCategoryPath || hasEquivalentElementaryCompartment) &&
      (hasSameCas || !normalizedFieldValues(target.fields.cas).length)
    );
  }

  return (
    hasSameType &&
    hasSameProperty &&
    hasSameUnit &&
    hasEquivalentName &&
    (hasSameCas || hasSameCategory)
  );
}

function candidateEvaluation(
  target: IdentityProfile,
  candidate: IdentityProfile,
  kind: IdentityPreflightKind,
  index: number,
): CandidateEvaluation {
  const matchReasons: string[] = [];
  let matchScore = 0;
  let decisionHint: IdentityPreflightDecision | null = null;

  if (target.id && candidate.id && target.id === candidate.id) {
    matchScore += 100;
    matchReasons.push('same_dataset_id');
    if (candidate.state_code === 0) {
      decisionHint = 'update_same_row';
    } else if (target.version && candidate.version && target.version !== candidate.version) {
      decisionHint = 'version_bump';
    } else {
      decisionHint = 'reuse';
    }
  }

  if (
    target.identity_key &&
    candidate.identity_key &&
    target.identity_key === candidate.identity_key
  ) {
    matchScore += 90;
    matchReasons.push('same_identity_key');
    if (!decisionHint) {
      decisionHint = 'block_duplicate';
    }
  }

  if (
    kind === 'process' &&
    sameExchangeSignature(target.exchange_signature, candidate.exchange_signature)
  ) {
    matchScore += 40;
    matchReasons.push('same_exchange_signature');
    if (!decisionHint) {
      decisionHint = 'manual_review';
    }
  }

  const hasOverlappingName = intersects(target.normalized_names, candidate.normalized_names);
  if (hasOverlappingName) {
    matchScore += 20;
    matchReasons.push('overlapping_name');
    if (!decisionHint) {
      decisionHint = 'manual_review';
    }
  }
  const hasEquivalentName =
    kind === 'flow' && !hasOverlappingName && hasStrongEquivalentFlowName(target, candidate);
  if (kind === 'flow' && hasEquivalentName) {
    matchScore += 18;
    matchReasons.push('equivalent_flow_name');
    if (!decisionHint) {
      decisionHint = 'manual_review';
    }
  }
  const hasSimilarName =
    !hasOverlappingName && !hasEquivalentName && hasSimilarNamePhrase(target, candidate);
  if (hasSimilarName) {
    matchScore += 15;
    matchReasons.push('similar_name_phrase');
    if (!decisionHint) {
      decisionHint = 'manual_review';
    }
  }

  const targetReferenceFields = Object.values(target.fields)
    .flat()
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeText)
    .filter(Boolean);
  const candidateReferenceFields = Object.values(candidate.fields)
    .flat()
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeText)
    .filter(Boolean);
  const hasOverlappingIdentityField = intersects(targetReferenceFields, candidateReferenceFields);
  if (hasOverlappingIdentityField) {
    matchScore += 10;
    matchReasons.push('overlapping_identity_field');
  }

  if (kind === 'flow') {
    if (sameNonEmptyField(target.fields.type_of_dataset, candidate.fields.type_of_dataset)) {
      matchScore += 5;
      matchReasons.push('same_flow_type');
    }
    if (sameNonEmptyField(target.fields.flow_property, candidate.fields.flow_property)) {
      matchScore += 15;
      matchReasons.push('same_flow_property');
    }
    if (sameNonEmptyField(target.fields.reference_unit, candidate.fields.reference_unit)) {
      matchScore += 10;
      matchReasons.push('same_reference_unit');
    }
    if (sameCasField(target.fields.cas, candidate.fields.cas)) {
      matchScore += 10;
      matchReasons.push('same_cas');
    }
    if (sameCategoryPath(target.fields.categories, candidate.fields.categories)) {
      matchScore += 20;
      matchReasons.push('same_category_path');
    } else if (sameCategoryLeaf(target.fields.categories, candidate.fields.categories)) {
      matchScore += 15;
      matchReasons.push('same_category_leaf');
    } else if (
      sameNonEmptyField(target.fields.type_of_dataset, 'Elementary flow') &&
      sameNonEmptyField(candidate.fields.type_of_dataset, 'Elementary flow') &&
      sameElementaryCompartment(target.fields.categories, candidate.fields.categories)
    ) {
      matchScore += 18;
      matchReasons.push('equivalent_elementary_compartment');
    }
  }

  if (
    kind === 'process' &&
    decisionHint === 'manual_review' &&
    matchReasons.includes('same_exchange_signature') &&
    hasOverlappingIdentityField
  ) {
    matchScore += 20;
    matchReasons.push('same_exchange_fingerprint');
    decisionHint = 'block_duplicate';
  }

  if (
    kind === 'flow' &&
    (decisionHint === null || decisionHint === 'manual_review') &&
    hasEquivalentFlowCore(target, candidate)
  ) {
    matchScore += 70;
    matchReasons.push('equivalent_flow_core_fields');
    decisionHint = 'block_duplicate';
  }

  if (kind === 'flow' && matchScore > 0 && hasConflictingFlowName(target, candidate)) {
    matchScore = Math.max(1, matchScore - 35);
    matchReasons.push('conflicting_flow_name');
  }

  const findings: IdentityPreflightFinding[] = [];
  if (decisionHint === 'block_duplicate') {
    findings.push({
      code: `${kind}_duplicate_candidate`,
      severity: 'blocker',
      message: `Candidate ${index} matches the target identity and should block new ${kind} creation.`,
      candidate_index: index,
    });
  } else if (decisionHint === 'manual_review') {
    findings.push({
      code: `${kind}_manual_review_candidate`,
      severity: 'warning',
      message: `Candidate ${index} is similar enough to require manual review before new ${kind} creation.`,
      candidate_index: index,
    });
  } else if (decisionHint) {
    findings.push({
      code: `${kind}_${decisionHint}`,
      severity: 'info',
      message: `Candidate ${index} supports decision ${decisionHint}.`,
      candidate_index: index,
    });
  }

  return {
    report: {
      index,
      id: candidate.id,
      version: candidate.version,
      state_code: candidate.state_code,
      names: candidate.names,
      fields: candidate.fields,
      exchange_signature: candidate.exchange_signature,
      identity_key: candidate.identity_key,
      match_score: matchScore,
      match_reasons: matchReasons,
      decision_hint: decisionHint,
    },
    findings,
  };
}

function chooseDecision(
  evaluations: CandidateEvaluation[],
  validation: ValidationSummary,
  kind: IdentityPreflightKind,
): {
  decision: IdentityPreflightDecision;
  confidence: 'high' | 'medium' | 'low';
  findings: IdentityPreflightFinding[];
} {
  const findings = evaluations.flatMap((evaluation) => evaluation.findings);
  if (validation.status === 'failed') {
    return {
      decision: 'manual_review',
      confidence: 'high',
      findings: [
        {
          code: `${kind}_schema_invalid`,
          severity: 'blocker',
          message: `Target ${kind} payload failed schema validation.`,
        },
        ...findings,
      ],
    };
  }

  const sorted = [...evaluations].sort(
    (left, right) => right.report.match_score - left.report.match_score,
  );
  const top = sorted[0]?.report;
  if (!top || top.match_score === 0) {
    return {
      decision: 'create_new',
      confidence: 'medium',
      findings: [
        {
          code: `${kind}_no_duplicate_candidate`,
          severity: 'info',
          message: `No duplicate ${kind} candidate matched the target identity.`,
        },
        ...findings,
      ],
    };
  }

  if (top.decision_hint === 'block_duplicate') {
    return {
      decision: 'block_duplicate',
      confidence: top.match_score >= 90 ? 'high' : 'medium',
      findings,
    };
  }
  if (
    top.decision_hint === 'reuse' ||
    top.decision_hint === 'update_same_row' ||
    top.decision_hint === 'version_bump'
  ) {
    return {
      decision: top.decision_hint,
      confidence: top.match_score >= 90 ? 'high' : 'medium',
      findings,
    };
  }

  return {
    decision: 'manual_review',
    confidence: top.match_score >= 60 ? 'medium' : 'low',
    findings,
  };
}

function sortedEvaluations(evaluations: CandidateEvaluation[]): CandidateEvaluation[] {
  return [...evaluations].sort((left, right) => {
    const scoreDiff = right.report.match_score - left.report.match_score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.report.index - right.report.index;
  });
}

function statusForDecision(
  decision: IdentityPreflightDecision,
  blockers: IdentityPreflightFinding[],
): IdentityPreflightStatus {
  if (blockers.length > 0 || decision === 'block_duplicate') {
    return 'blocked';
  }
  if (decision === 'manual_review') {
    return 'needs_review';
  }
  return 'passed';
}

function nextActionForDecision(
  decision: IdentityPreflightDecision,
): IdentityPreflightReport['next_action'] {
  if (decision === 'reuse') {
    return 'reuse_existing';
  }
  if (decision === 'update_same_row') {
    return 'repair_existing_draft';
  }
  if (decision === 'version_bump') {
    return 'prepare_version_update';
  }
  if (decision === 'block_duplicate') {
    return 'stop_duplicate';
  }
  if (decision === 'manual_review') {
    return 'queue_manual_review';
  }
  return 'materialize_new_payload';
}

function writeArtifacts(
  report: IdentityPreflightReport,
  outDir: string | null | undefined,
): IdentityPreflightReport['files'] {
  if (!outDir) {
    return {
      identity_decision: null,
      candidates: null,
      candidate_sources: null,
    };
  }

  const resolved = path.resolve(outDir);
  const files = {
    identity_decision: path.join(resolved, 'outputs', 'identity-decision.json'),
    candidates: path.join(resolved, 'outputs', 'identity-candidates.jsonl'),
    candidate_sources: path.join(resolved, 'outputs', 'identity-candidate-sources.json'),
  };

  writeJsonArtifact(files.identity_decision, { ...report, files });
  writeJsonLinesArtifact(files.candidates, report.candidates);
  writeJsonArtifact(files.candidate_sources, report.candidate_sources);
  return files;
}

export async function runIdentityPreflight(
  kind: IdentityPreflightKind,
  options: RunIdentityPreflightOptions,
): Promise<IdentityPreflightReport> {
  const inputPath = requiredInputPath(options.inputPath);
  const normalizedInput = normalizePreflightInput(
    options.rawInput ?? readJsonInput(inputPath),
    kind,
  );
  const remoteCandidateSearch = mergeRemoteCandidateSearchConfig(
    normalizedInput.remoteCandidateSearch,
    options,
  );
  const targetProfile = applyIdentityProfileHints(
    profileForKind(normalizedInput.target, kind),
    remoteCandidateSearch.profileHints,
    kind,
  );
  const candidateSourceReads = [
    ...normalizedInput.candidateInputPaths,
    ...(options.candidateInputPaths ?? []),
  ].map(readCandidateSource);
  const remoteCandidateRead = await readRemoteCandidateSource(
    kind,
    targetProfile,
    remoteCandidateSearch,
    options,
  );
  const candidateSources: IdentityPreflightCandidateSourceReport[] = [
    ...(normalizedInput.candidates.length > 0
      ? [
          {
            path: path.resolve(inputPath),
            kind: 'embedded_request' as const,
            row_count: normalizedInput.candidates.length,
            scanned_files: [],
          },
        ]
      : []),
    ...candidateSourceReads.map((entry) => entry.source),
    ...(remoteCandidateRead ? [remoteCandidateRead.source] : []),
  ];
  const candidates = [
    ...normalizedInput.candidates,
    ...candidateSourceReads.flatMap((entry) => entry.rows),
    ...(remoteCandidateRead?.rows ?? []),
  ];
  const validation = validateTargetSchema(normalizedInput.target, kind, options.schemas);
  const evaluations = candidates.map((candidate, index) =>
    candidateEvaluation(targetProfile, profileForKind(candidate, kind), kind, index),
  );
  const decision = chooseDecision(evaluations, validation, kind);
  const blockers = decision.findings.filter((finding) => finding.severity === 'blocker');

  const baseReport: IdentityPreflightReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    kind,
    status: statusForDecision(decision.decision, blockers),
    decision: decision.decision,
    confidence: decision.confidence,
    input_path: path.resolve(inputPath),
    out_dir: options.outDir ? path.resolve(options.outDir) : null,
    target: {
      id: targetProfile.id,
      version: targetProfile.version,
      names: targetProfile.names,
      fields: targetProfile.fields,
      identity_key: targetProfile.identity_key,
      exchange_signature: targetProfile.exchange_signature,
      schema_validation: validation,
    },
    candidates: sortedEvaluations(evaluations).map((evaluation) => evaluation.report),
    candidate_sources: candidateSources,
    findings: decision.findings,
    blockers,
    next_action: nextActionForDecision(decision.decision),
    files: {
      identity_decision: null,
      candidates: null,
      candidate_sources: null,
    },
  };

  const files = writeArtifacts(baseReport, options.outDir);
  return {
    ...baseReport,
    files,
  };
}

export async function runProcessIdentityPreflight(
  options: RunProcessIdentityPreflightOptions,
): Promise<ProcessIdentityPreflightReport> {
  return (await runIdentityPreflight('process', options)) as ProcessIdentityPreflightReport;
}

export async function runFlowIdentityPreflight(
  options: RunFlowIdentityPreflightOptions,
): Promise<FlowIdentityPreflightReport> {
  return (await runIdentityPreflight('flow', options)) as FlowIdentityPreflightReport;
}

export const __testInternals = {
  appendQueryLine,
  applyIdentityProfileHints,
  candidateEvaluation,
  chooseDecision,
  collectCandidateFilesFromStats,
  compactRemoteQuery,
  defaultRemoteQuery,
  elementaryCompartmentKey,
  entityFactoryExports: ENTITY_FACTORY_EXPORTS,
  exchangeFlowRefsFromSignature,
  expandedFlowNameVariants,
  flowNameVariants,
  flowProfile,
  hasConflictingFlowName,
  identityKeyFromProfile,
  isRemoteQueryNoiseText,
  mergeRemoteCandidateSearchConfig,
  nameTokens,
  nextActionForDecision,
  normalizeMatchThreshold,
  normalizeNonNegativeNumber,
  normalizePreflightInput,
  normalizeRemoteCandidateSearch,
  normalizePositiveInteger,
  processProfile,
  processReferenceExchange,
  processReferenceFlowValues,
  profileForKind,
  queryFieldValues,
  readCandidateSource,
  remoteSearchOptions,
  remoteSearchFilter,
  rowsFromRemoteSearchResponse,
  sameCasField,
  sameElementaryCompartment,
  sameNonEmptyField,
  schemaForKind,
  statusForDecision,
  tokenCoverageRatio,
  tokenOverlapRatio,
};
