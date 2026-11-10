// data-api-relations: processes
import path from 'node:path';
import {
  readJsonArtifact,
  readJsonLinesArtifact,
  writeJsonArtifact,
  writeJsonLinesArtifact,
  writeTextArtifact,
} from './artifacts.js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import {
  deriveSupabaseProjectBaseUrl,
  deriveSupabaseRestBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import {
  applyDataApiProfileHeaders,
  buildDataApiUrl,
  resolveDataApiCapability,
} from './supabase-data-api-contract.js';
import { resolveSupabaseUserSession } from './supabase-session.js';
import { redactEmail } from './credential-safety.js';

type JsonRecord = Record<string, unknown>;

const DEFAULT_STATE_CODES = [0, 100] as const;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;

type ProcessScopeStatisticsScope = 'visible' | 'current-user';

type SnapshotRow = {
  id: string;
  version: string;
  state_code: number | null;
  user_id: string | null;
  modified_at: string | null;
  model_id: string | null;
  json: JsonRecord;
};

type ClassificationEntry = {
  level: number;
  text: string;
};

type StatisticsMetadata = {
  userId: string | null;
  maskedUserEmail: string | null;
  totalRowsReportedByRemote: number | null;
};

type StatisticsOptions = {
  scope: ProcessScopeStatisticsScope;
  stateCodes: number[];
};

type CountRecord = {
  count: number;
  [key: string]: unknown;
};

export type RunProcessScopeStatisticsOptions = {
  outDir: string;
  scope?: ProcessScopeStatisticsScope;
  stateCodes?: number[];
  pageSize?: number | null;
  reuseSnapshot?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  now?: Date;
};

export type ProcessScopeStatisticsReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed_process_scope_statistics';
  out_dir: string;
  scope: ProcessScopeStatisticsScope;
  state_codes: number[];
  total_process_rows: number;
  domain_count_primary: number;
  domain_count_leaf: number;
  craft_count: number;
  unit_process_rows: number;
  product_count: number;
  files: {
    snapshot_manifest: string;
    snapshot_rows: string;
    process_scope_summary: string;
    domain_summary: string;
    craft_summary: string;
    product_summary: string;
    type_of_dataset_summary: string;
    report: string;
    report_zh: string;
  };
};

type ProcessScopeStatisticsSummary = {
  schema_version: 1;
  generated_at_utc: string;
  scope: ProcessScopeStatisticsScope;
  state_codes: number[];
  user_id: string | null;
  masked_user_email: string | null;
  total_process_rows: number;
  total_rows_reported_by_remote: number | null;
  rows_by_state_code: Record<string, number>;
  distinct_visible_owner_user_ids: number;
  domain_count_primary: number;
  domain_count_leaf: number;
  craft_count: number;
  unit_process_rows: number;
  unit_process_share: number;
  product_count: number;
  products_with_flow_id: number;
  products_without_flow_id: number;
  rows_missing_classification: number;
  rows_missing_craft: number;
  rows_missing_product: number;
  rows_missing_reference_exchange: number;
  metric_definitions: Record<string, string>;
};

type ProcessScopeStatisticsArtifacts = {
  summary: ProcessScopeStatisticsSummary;
  domainPrimarySummary: Array<{
    domain: string;
    count: number;
    sample_path?: string;
  }>;
  domainLeafSummary: Array<{
    domain: string;
    count: number;
    sample_path?: string;
  }>;
  craftSummary: Array<{
    craft_signature: string;
    label: string;
    count: number;
    source_kind: string;
  }>;
  productSummary: Array<{
    product_key: string;
    label: string;
    count: number;
    stable_flow_id: string;
    stable_flow_version: string;
    source_kind: string;
  }>;
  typeOfDataSetSummary: Array<{
    type_of_dataset: string;
    count: number;
  }>;
  craftSourceSummary: Array<{
    source_kind: string;
    count: number;
  }>;
  productSourceSummary: Array<{
    source_kind: string;
    count: number;
  }>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalToken(value: unknown): string | null {
  const trimmed = trimText(value);
  return trimmed ? trimmed : null;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function toPositiveInteger(value: number | null | undefined, label: string, code: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new CliError(`Expected ${label} to be a positive integer.`, {
      code,
      exitCode: 2,
    });
  }
  return value as number;
}

function normalizeStateCodes(value: readonly number[] | undefined): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_STATE_CODES];
  }

  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const entry of value) {
    if (!Number.isInteger(entry) || entry < 0) {
      throw new CliError('Expected --state-codes to contain only non-negative integers.', {
        code: 'PROCESS_SCOPE_STATE_CODES_INVALID',
        exitCode: 2,
      });
    }
    if (!seen.has(entry)) {
      normalized.push(entry);
      seen.add(entry);
    }
  }
  if (normalized.length === 0) {
    throw new CliError('--state-codes must contain at least one state code.', {
      code: 'PROCESS_SCOPE_STATE_CODES_REQUIRED',
      exitCode: 2,
    });
  }
  return normalized;
}

function ensureScope(value: string | undefined): ProcessScopeStatisticsScope {
  if (value === undefined || value === 'visible') {
    return 'visible';
  }
  if (value === 'current-user') {
    return 'current-user';
  }
  throw new CliError("Expected --scope to be either 'visible' or 'current-user'.", {
    code: 'PROCESS_SCOPE_SCOPE_INVALID',
    exitCode: 2,
  });
}

async function parseJsonResponse(response: ResponseLike, label: string): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!text.trim()) {
    return null;
  }
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${label} returned invalid JSON.`, {
      code: 'PROCESS_SCOPE_REMOTE_INVALID_JSON',
      exitCode: 1,
      details: String(error),
    });
  }
}

async function fetchJsonWithRetry(options: {
  url: string;
  init: RequestInit;
  label: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxRetries: number;
}): Promise<{ status: number; headers: Headers; body: unknown }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= options.maxRetries; attempt += 1) {
    try {
      const response = await options.fetchImpl(options.url, {
        ...options.init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const body = await parseJsonResponse(response, options.label);
      if (!response.ok) {
        throw new CliError(`${options.label} failed with ${response.status}.`, {
          code: 'PROCESS_SCOPE_REMOTE_REQUEST_FAILED',
          exitCode: 1,
          details: {
            status: response.status,
            body,
            url: options.url,
          },
        });
      }
      return {
        status: response.status,
        headers: new Headers({
          'content-range': response.headers.get('content-range') ?? '',
          'content-type': response.headers.get('content-type') ?? '',
        }),
        body,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxRetries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }

  if (lastError instanceof CliError) {
    throw lastError;
  }

  throw new CliError(`${options.label} failed after ${options.maxRetries} attempt(s).`, {
    code: 'PROCESS_SCOPE_REMOTE_REQUEST_FAILED',
    exitCode: 1,
    details: String(lastError),
  });
}

async function resolveCurrentUserId(options: {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: Date;
  maxRetries: number;
}): Promise<string> {
  const runtime = requireSupabaseRestRuntime(options.env);
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  const body = await fetchJsonWithRetry({
    url: `${deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl)}/auth/v1/user`,
    init: {
      method: 'GET',
      headers: {
        apikey: runtime.publishableKey,
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/json',
      },
    },
    label: 'supabase current-user lookup',
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  });

  const userId = isRecord(body.body) ? normalizeOptionalToken(body.body.id) : null;
  if (!userId) {
    throw new CliError('Supabase current-user lookup succeeded without a user id.', {
      code: 'PROCESS_SCOPE_CURRENT_USER_ID_MISSING',
      exitCode: 1,
    });
  }
  return userId;
}

async function fetchProcessRows(options: {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxRetries: number;
  scope: ProcessScopeStatisticsScope;
  stateCodes: number[];
  pageSize: number;
  userId: string | null;
}): Promise<{ rows: SnapshotRow[]; total: number | null }> {
  const runtime = requireSupabaseRestRuntime(options.env);
  const session = await resolveSupabaseUserSession({
    runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
  const processCapability = resolveDataApiCapability({
    kind: 'relation',
    name: 'processes',
    env: options.env,
  });
  const rows: SnapshotRow[] = [];
  let total = 0;

  for (const stateCode of options.stateCodes) {
    let stateTotal: number | null = null;
    let cursorId = '';

    while (true) {
      const url = new URL(
        buildDataApiUrl(deriveSupabaseRestBaseUrl(projectBaseUrl), processCapability),
      );
      url.searchParams.set('select', 'id,version,state_code,user_id,modified_at,model_id,json');
      url.searchParams.set('state_code', `eq.${stateCode}`);
      if (options.scope === 'current-user') {
        url.searchParams.set('user_id', `eq.${options.userId ?? ''}`);
      }
      if (cursorId) {
        url.searchParams.set('id', `gt.${cursorId}`);
      }
      url.searchParams.set('order', 'id.asc');
      url.searchParams.set('limit', String(options.pageSize));

      const page = await fetchJsonWithRetry({
        url: url.toString(),
        init: {
          method: 'GET',
          headers: applyDataApiProfileHeaders(
            {
              apikey: runtime.publishableKey,
              Authorization: `Bearer ${session.accessToken}`,
              Accept: 'application/json',
              ...(stateTotal === null ? { Prefer: 'count=exact' } : {}),
            },
            processCapability,
          ),
        },
        label: `process scope statistics page fetch (state_code=${stateCode})`,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
      });

      const pageRows = Array.isArray(page.body) ? page.body : [];
      const normalizedRows = pageRows
        .map((row) => normalizeSnapshotRow(row))
        .filter((row): row is SnapshotRow => row !== null);
      rows.push(...normalizedRows);

      if (stateTotal === null) {
        const match = page.headers.get('content-range')?.match(/\/(\d+)$/u) ?? null;
        stateTotal = match ? Number.parseInt(match[1]!, 10) : null;
        if (stateTotal !== null) {
          total += stateTotal;
        }
      }

      if (normalizedRows.length < options.pageSize) {
        break;
      }

      const lastRow = normalizedRows[normalizedRows.length - 1]!;
      cursorId = lastRow.id;
    }
  }

  return {
    rows,
    total: total || null,
  };
}

function normalizeSnapshotRow(value: unknown): SnapshotRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalToken(value.id);
  const version = normalizeOptionalToken(value.version);
  const payload = normalizePayload(value.json);
  if (!id || !version || !payload) {
    return null;
  }
  return {
    id,
    version,
    state_code: typeof value.state_code === 'number' ? value.state_code : null,
    user_id: normalizeOptionalToken(value.user_id),
    modified_at: normalizeOptionalToken(value.modified_at),
    model_id: normalizeOptionalToken(value.model_id),
    json: payload,
  };
}

function normalizePayload(value: unknown): JsonRecord | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function getLangList(value: unknown): JsonRecord[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is JsonRecord => isRecord(item));
  }
  if (isRecord(value)) {
    const langString = value['common:langString'];
    if (Array.isArray(langString)) {
      return langString.filter((item): item is JsonRecord => isRecord(item));
    }
    if (isRecord(langString)) {
      return [langString];
    }
    if (typeof value['#text'] === 'string' || typeof value['@xml:lang'] === 'string') {
      return [value];
    }
  }
  if (typeof value === 'string') {
    return [{ '@xml:lang': 'en', '#text': value }];
  }
  return [];
}

function getLangText(value: unknown, lang: string | null): string {
  const list = getLangList(value);
  const exact =
    lang === null
      ? null
      : list.find(
          (item) =>
            trimText(item['@xml:lang']).toLowerCase() === lang.toLowerCase() &&
            trimText(item['#text']),
        );
  const fallback = list.find((item) => trimText(item['#text']));
  return trimText((exact ?? fallback)?.['#text']);
}

function getAnyLangText(value: unknown): string {
  return getLangText(value, null);
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractClassificationEntries(dataSetInformation: JsonRecord): ClassificationEntry[] {
  const classes = asArray(
    (dataSetInformation.classificationInformation as JsonRecord | undefined)?.[
      'common:classification'
    ] &&
      (
        (dataSetInformation.classificationInformation as JsonRecord)['common:classification'] as
          JsonRecord | undefined
      )?.['common:class'],
  );

  return classes
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const level = Number.parseInt(trimText(entry['@level']) || '0', 10);
      const text = trimText(entry['#text']);
      if (!text) {
        return null;
      }
      return { level, text };
    })
    .filter((entry): entry is ClassificationEntry => entry !== null)
    .sort((left, right) => left.level - right.level);
}

function normalizeSignature(text: string): string {
  return trimText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3000\u00a0]/gu, ' ')
    .replace(/[，,;；:：()（）[\]{}<>|/\\]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstClause(text: string): string {
  const normalized = trimText(text);
  if (!normalized) {
    return '';
  }
  const [first] = normalized.split(/[.;；。]/u);
  return first.trim();
}

function renderProcessName(name: JsonRecord): string {
  const parts = [
    getLangText(name.baseName, 'en') ||
      getLangText(name.baseName, 'zh') ||
      getAnyLangText(name.baseName),
    getLangText(name.treatmentStandardsRoutes, 'en') ||
      getLangText(name.treatmentStandardsRoutes, 'zh') ||
      getAnyLangText(name.treatmentStandardsRoutes),
    getLangText(name.mixAndLocationTypes, 'en') ||
      getLangText(name.mixAndLocationTypes, 'zh') ||
      getAnyLangText(name.mixAndLocationTypes),
    getLangText(name.functionalUnitFlowProperties, 'en') ||
      getLangText(name.functionalUnitFlowProperties, 'zh') ||
      getAnyLangText(name.functionalUnitFlowProperties),
  ].filter((part) => trimText(part));

  return parts.join('; ');
}

function extractCraftCandidate(
  dataSetInformation: JsonRecord,
  technology: JsonRecord,
): {
  source_kind: string;
  label: string;
  signature: string;
} {
  const name = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
  const candidates = [
    {
      source_kind: 'treatmentStandardsRoutes',
      label:
        getLangText(name.treatmentStandardsRoutes, 'en') ||
        getLangText(name.treatmentStandardsRoutes, 'zh') ||
        getAnyLangText(name.treatmentStandardsRoutes),
    },
    {
      source_kind: 'technologyDescriptionAndIncludedProcesses',
      label:
        firstClause(getLangText(technology.technologyDescriptionAndIncludedProcesses, 'en')) ||
        firstClause(getLangText(technology.technologyDescriptionAndIncludedProcesses, 'zh')) ||
        firstClause(getAnyLangText(technology.technologyDescriptionAndIncludedProcesses)),
    },
    {
      source_kind: 'baseName',
      label:
        getLangText(name.baseName, 'en') ||
        getLangText(name.baseName, 'zh') ||
        getAnyLangText(name.baseName),
    },
  ];

  for (const candidate of candidates) {
    if (trimText(candidate.label)) {
      return {
        ...candidate,
        signature: normalizeSignature(candidate.label),
      };
    }
  }

  return {
    source_kind: 'missing',
    label: '',
    signature: '',
  };
}

function extractReferenceProduct(
  processDataSet: JsonRecord,
  dataSetInformation: JsonRecord,
): {
  key: string;
  stable_flow_id: string;
  stable_flow_version: string;
  label: string;
  source_kind: string;
  missing_reference_exchange: boolean;
} {
  const processInformation = isRecord(processDataSet.processInformation)
    ? processDataSet.processInformation
    : {};
  const quantRef = isRecord(processInformation.quantitativeReference)
    ? processInformation.quantitativeReference
    : {};
  const refInternalId = trimText(quantRef.referenceToReferenceFlow);
  const exchangesBlock = isRecord(processDataSet.exchanges) ? processDataSet.exchanges : {};
  const exchanges = asArray(exchangesBlock.exchange);
  const refExchange = exchanges.find(
    (exchange) => isRecord(exchange) && trimText(exchange['@dataSetInternalID']) === refInternalId,
  );
  const exchange = isRecord(refExchange) ? refExchange : null;
  const flowRef =
    exchange && isRecord(exchange.referenceToFlowDataSet) ? exchange.referenceToFlowDataSet : {};

  const flowRefId = trimText(flowRef['@refObjectId']);
  const flowRefVersion = trimText(flowRef['@version']);
  const shortDescription =
    getLangText(flowRef['common:shortDescription'], 'en') ||
    getLangText(flowRef['common:shortDescription'], 'zh') ||
    getAnyLangText(flowRef['common:shortDescription']);
  const name = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
  const fallbackBaseName =
    getLangText(name.baseName, 'en') ||
    getLangText(name.baseName, 'zh') ||
    getAnyLangText(name.baseName);
  const fallbackProcessName = renderProcessName(name);

  if (flowRefId) {
    return {
      key: `flow:${flowRefId}`,
      stable_flow_id: flowRefId,
      stable_flow_version: flowRefVersion,
      label: shortDescription || fallbackProcessName || flowRefId,
      source_kind: 'reference_flow_id',
      missing_reference_exchange: exchange === null,
    };
  }

  if (shortDescription) {
    return {
      key: `label:${normalizeSignature(shortDescription)}`,
      stable_flow_id: '',
      stable_flow_version: '',
      label: shortDescription,
      source_kind: 'reference_flow_short_description',
      missing_reference_exchange: exchange === null,
    };
  }

  if (fallbackBaseName) {
    return {
      key: `base:${normalizeSignature(fallbackBaseName)}`,
      stable_flow_id: '',
      stable_flow_version: '',
      label: fallbackBaseName,
      source_kind: 'process_base_name',
      missing_reference_exchange: exchange === null,
    };
  }

  return {
    key: '',
    stable_flow_id: '',
    stable_flow_version: '',
    label: '',
    source_kind: 'missing',
    missing_reference_exchange: exchange === null,
  };
}

function incrementCount(
  map: Map<string, CountRecord>,
  key: string,
  seed: Record<string, unknown> = {},
): void {
  const existing = map.get(key) ?? {
    count: 0,
    ...seed,
  };
  existing.count += 1;
  map.set(key, existing);
}

function toSortedArray(map: Map<string, CountRecord>): Array<{ key: string } & CountRecord> {
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function calculateStatistics(
  rows: SnapshotRow[],
  options: StatisticsOptions,
  metadata: StatisticsMetadata,
  generatedAtUtc: string,
): ProcessScopeStatisticsArtifacts {
  const stateCodeCounts = new Map<string, CountRecord>();
  const typeOfDataSetCounts = new Map<string, CountRecord>();
  const domainPrimaryCounts = new Map<string, CountRecord>();
  const domainLeafCounts = new Map<string, CountRecord>();
  const craftCounts = new Map<string, CountRecord>();
  const craftSourceCounts = new Map<string, CountRecord>();
  const productCounts = new Map<string, CountRecord>();
  const productSourceCounts = new Map<string, CountRecord>();
  const ownerCounts = new Map<string, CountRecord>();

  let rowsMissingClassification = 0;
  let rowsMissingCraft = 0;
  let rowsMissingProduct = 0;
  let rowsMissingReferenceExchange = 0;
  let unitProcessRows = 0;

  for (const row of rows) {
    incrementCount(stateCodeCounts, String(row.state_code ?? 'null'));
    incrementCount(ownerCounts, row.user_id ?? 'missing');

    const processDataSet = isRecord(row.json.processDataSet) ? row.json.processDataSet : {};
    const processInformation = isRecord(processDataSet.processInformation)
      ? processDataSet.processInformation
      : {};
    const dataSetInformation = isRecord(processInformation.dataSetInformation)
      ? processInformation.dataSetInformation
      : {};
    const technology = isRecord(processInformation.technology) ? processInformation.technology : {};
    const modellingAndValidation = isRecord(processDataSet.modellingAndValidation)
      ? processDataSet.modellingAndValidation
      : {};
    const lciMethod = isRecord(modellingAndValidation.LCIMethodAndAllocation)
      ? modellingAndValidation.LCIMethodAndAllocation
      : {};

    const typeOfDataSet = trimText(lciMethod.typeOfDataSet) || 'missing';
    incrementCount(typeOfDataSetCounts, typeOfDataSet);
    if (typeOfDataSet.toLowerCase().includes('unit process')) {
      unitProcessRows += 1;
    }

    const classificationEntries = extractClassificationEntries(dataSetInformation);
    const primaryDomain =
      classificationEntries.find((entry) => entry.level === 1)?.text ??
      classificationEntries[classificationEntries.length - 1]?.text ??
      '';
    const leafDomain = classificationEntries[classificationEntries.length - 1]?.text ?? '';
    if (primaryDomain) {
      incrementCount(domainPrimaryCounts, primaryDomain, {
        sample_path: classificationEntries.map((entry) => entry.text).join(' > '),
      });
    } else {
      rowsMissingClassification += 1;
    }
    if (leafDomain) {
      incrementCount(domainLeafCounts, leafDomain, {
        sample_path: classificationEntries.map((entry) => entry.text).join(' > '),
      });
    }

    const craft = extractCraftCandidate(dataSetInformation, technology);
    if (craft.signature) {
      incrementCount(craftCounts, craft.signature, {
        label: craft.label,
        source_kind: craft.source_kind,
      });
      incrementCount(craftSourceCounts, craft.source_kind);
    } else {
      rowsMissingCraft += 1;
    }

    const product = extractReferenceProduct(processDataSet, dataSetInformation);
    if (product.key) {
      incrementCount(productCounts, product.key, {
        label: product.label,
        stable_flow_id: product.stable_flow_id,
        stable_flow_version: product.stable_flow_version,
        source_kind: product.source_kind,
      });
      incrementCount(productSourceCounts, product.source_kind);
    } else {
      rowsMissingProduct += 1;
    }
    if (product.missing_reference_exchange) {
      rowsMissingReferenceExchange += 1;
    }
  }

  const domainPrimarySummary = toSortedArray(domainPrimaryCounts).map((item) => ({
    domain: item.key,
    count: item.count,
    sample_path: item.sample_path as string | undefined,
  }));
  const domainLeafSummary = toSortedArray(domainLeafCounts).map((item) => ({
    domain: item.key,
    count: item.count,
    sample_path: item.sample_path as string | undefined,
  }));
  const craftSummary = toSortedArray(craftCounts).map((item) => ({
    craft_signature: item.key,
    label: item.label as string,
    count: item.count,
    source_kind: item.source_kind as string,
  }));
  const productSummary = toSortedArray(productCounts).map((item) => ({
    product_key: item.key,
    label: item.label as string,
    count: item.count,
    stable_flow_id: item.stable_flow_id as string,
    stable_flow_version: item.stable_flow_version as string,
    source_kind: item.source_kind as string,
  }));
  const typeOfDataSetSummary = toSortedArray(typeOfDataSetCounts).map((item) => ({
    type_of_dataset: item.key,
    count: item.count,
  }));

  return {
    summary: {
      schema_version: 1,
      generated_at_utc: generatedAtUtc,
      scope: options.scope,
      state_codes: options.stateCodes,
      user_id: metadata.userId,
      masked_user_email: metadata.maskedUserEmail,
      total_process_rows: rows.length,
      total_rows_reported_by_remote: metadata.totalRowsReportedByRemote,
      rows_by_state_code: Object.fromEntries(
        [...stateCodeCounts.entries()].map(([key, value]) => [key, value.count]),
      ),
      distinct_visible_owner_user_ids: ownerCounts.size,
      domain_count_primary: domainPrimaryCounts.size,
      domain_count_leaf: domainLeafCounts.size,
      craft_count: craftCounts.size,
      unit_process_rows: unitProcessRows,
      unit_process_share: rows.length === 0 ? 0 : unitProcessRows / rows.length,
      product_count: productCounts.size,
      products_with_flow_id: productSummary.filter((item) => item.stable_flow_id).length,
      products_without_flow_id: productSummary.filter((item) => !item.stable_flow_id).length,
      rows_missing_classification: rowsMissingClassification,
      rows_missing_craft: rowsMissingCraft,
      rows_missing_product: rowsMissingProduct,
      rows_missing_reference_exchange: rowsMissingReferenceExchange,
      metric_definitions: {
        domain_count_primary:
          'Unique level-1 classification text; fallback to the deepest available classification when level 1 is missing.',
        craft_count:
          'Unique normalized craft or route signatures derived from treatmentStandardsRoutes, or fallback technology/base-name text.',
        unit_process_rows: 'Rows whose typeOfDataSet contains the phrase "Unit process".',
        product_count:
          'Unique reference products, keyed by reference flow ID when present and by normalized label fallback otherwise.',
      },
    },
    domainPrimarySummary,
    domainLeafSummary,
    craftSummary,
    productSummary,
    typeOfDataSetSummary,
    craftSourceSummary: toSortedArray(craftSourceCounts).map((item) => ({
      source_kind: item.key,
      count: item.count,
    })),
    productSourceSummary: toSortedArray(productSourceCounts).map((item) => ({
      source_kind: item.key,
      count: item.count,
    })),
  };
}

function escapePipe(value: unknown): string {
  return String(value ?? '').replace(/\|/gu, '\\|');
}

function renderMarkdownReport(
  statistics: ProcessScopeStatisticsArtifacts,
  reportLang: 'en' | 'zh',
): string {
  const isZh = reportLang === 'zh';
  const summary = statistics.summary;
  const lines: string[] = [];

  lines.push(isZh ? '# Process 覆盖统计' : '# Process Scope Statistics');
  lines.push('');
  lines.push(
    isZh ? `统计时间：${summary.generated_at_utc}` : `Generated at: ${summary.generated_at_utc}`,
  );
  lines.push(
    isZh
      ? `范围：\`scope=${summary.scope}\`, \`state_codes=${summary.state_codes.join(',')}\``
      : `Scope: \`scope=${summary.scope}\`, \`state_codes=${summary.state_codes.join(',')}\``,
  );
  lines.push('');
  lines.push(isZh ? '## 核心结果' : '## Headline Metrics');
  lines.push('');
  lines.push(
    `- ${isZh ? '总 process 行数' : 'Total process rows'}: \`${summary.total_process_rows}\``,
  );
  lines.push(
    `- ${isZh ? '可见 owner 数' : 'Distinct visible owners'}: \`${summary.distinct_visible_owner_user_ids}\``,
  );
  lines.push(
    `- ${isZh ? '领域数量（一级分类口径）' : 'Domain count (primary definition)'}: \`${summary.domain_count_primary}\``,
  );
  lines.push(
    `- ${isZh ? '领域数量（叶子分类口径）' : 'Domain count (leaf classification)'}: \`${summary.domain_count_leaf}\``,
  );
  lines.push(`- ${isZh ? '工艺/路线数量' : 'Craft / route count'}: \`${summary.craft_count}\``);
  lines.push(`- ${isZh ? '单元过程行数' : 'Unit-process rows'}: \`${summary.unit_process_rows}\``);
  lines.push(`- ${isZh ? '产品数量' : 'Product count'}: \`${summary.product_count}\``);
  lines.push('');
  lines.push(isZh ? '## 状态分布' : '## State-code Distribution');
  lines.push('');
  Object.entries(summary.rows_by_state_code).forEach(([stateCode, count]) => {
    lines.push(`- \`state_code=${stateCode}\`: \`${count}\``);
  });
  lines.push('');
  lines.push(isZh ? '## 统计口径' : '## Metric Definitions');
  lines.push('');
  lines.push(
    `- ${isZh ? '领域' : 'Domain'}: ${
      isZh
        ? '优先使用 classification level=1；若缺失，则回退到最深层分类。'
        : 'Prefer classification level 1; fall back to the deepest available classification when level 1 is missing.'
    }`,
  );
  lines.push(
    `- ${isZh ? '工艺' : 'Craft'}: ${
      isZh
        ? '优先使用 `treatmentStandardsRoutes`；为空时回退到技术说明首句，再回退到 `baseName`。'
        : 'Prefer `treatmentStandardsRoutes`; fall back to the first clause of technology text, then to `baseName`.'
    }`,
  );
  lines.push(
    `- ${isZh ? '单元过程' : 'Unit process'}: ${
      isZh
        ? '以 `typeOfDataSet` 是否包含 `Unit process` 为准。'
        : 'Rows are counted when `typeOfDataSet` contains `Unit process`.'
    }`,
  );
  lines.push(
    `- ${isZh ? '产品' : 'Product'}: ${
      isZh
        ? '优先按 reference flow UUID 聚合；缺失时回退到 reference flow 短描述，再回退到 process base name。'
        : 'Prefer reference-flow UUIDs; fall back to reference-flow short descriptions, then to process base names.'
    }`,
  );
  lines.push('');

  lines.push(isZh ? '## Top 领域' : '## Top Domains');
  lines.push('');
  lines.push(`| ${isZh ? '领域' : 'Domain'} | ${isZh ? '数量' : 'Count'} |`);
  lines.push('| --- | --- |');
  statistics.domainPrimarySummary.slice(0, 15).forEach((item) => {
    lines.push(`| ${escapePipe(item.domain)} | ${item.count} |`);
  });
  lines.push('');

  lines.push(isZh ? '## Top 工艺/路线' : '## Top Crafts / Routes');
  lines.push('');
  lines.push(
    `| ${isZh ? '工艺/路线' : 'Craft / Route'} | ${isZh ? '数量' : 'Count'} | ${isZh ? '来源' : 'Source'} |`,
  );
  lines.push('| --- | --- | --- |');
  statistics.craftSummary.slice(0, 15).forEach((item) => {
    lines.push(`| ${escapePipe(item.label)} | ${item.count} | ${item.source_kind} |`);
  });
  lines.push('');

  lines.push(isZh ? '## Top 产品' : '## Top Products');
  lines.push('');
  lines.push(
    `| ${isZh ? '产品' : 'Product'} | ${isZh ? '数量' : 'Count'} | ${isZh ? '标识来源' : 'Key source'} |`,
  );
  lines.push('| --- | --- | --- |');
  statistics.productSummary.slice(0, 15).forEach((item) => {
    lines.push(`| ${escapePipe(item.label)} | ${item.count} | ${item.source_kind} |`);
  });
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function readSnapshotRows(filePath: string): SnapshotRow[] {
  return readJsonLinesArtifact(filePath)
    .map((row) => normalizeSnapshotRow(row))
    .filter((row): row is SnapshotRow => row !== null);
}

function readSnapshotManifest(filePath: string): JsonRecord | null {
  const value = readJsonArtifact(filePath);
  return isRecord(value) ? value : null;
}

export async function runProcessScopeStatistics(
  options: RunProcessScopeStatisticsOptions,
): Promise<ProcessScopeStatisticsReport> {
  const outDir = trimText(options.outDir);
  if (!outDir) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'PROCESS_SCOPE_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  const scope = ensureScope(options.scope);
  const stateCodes = normalizeStateCodes(options.stateCodes);
  const pageSize = toPositiveInteger(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    '--page-size',
    'PROCESS_SCOPE_PAGE_SIZE_INVALID',
  );
  const timeoutMs = toPositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    '--timeout-ms',
    'PROCESS_SCOPE_TIMEOUT_INVALID',
  );
  const maxRetries = toPositiveInteger(
    options.maxRetries ?? DEFAULT_MAX_RETRIES,
    'process scope statistics retry count',
    'PROCESS_SCOPE_MAX_RETRIES_INVALID',
  );

  const resolvedOutDir = path.resolve(outDir);
  const snapshotRowsPath = path.join(resolvedOutDir, 'inputs', 'processes.snapshot.rows.jsonl');
  const snapshotManifestPath = path.join(
    resolvedOutDir,
    'inputs',
    'processes.snapshot.manifest.json',
  );
  const generatedAtUtc = nowIso(options.now);

  let rows: SnapshotRow[];
  let metadata: StatisticsMetadata;

  if (options.reuseSnapshot) {
    rows = readSnapshotRows(snapshotRowsPath);
    const manifest = readSnapshotManifest(snapshotManifestPath);
    metadata = {
      userId: normalizeOptionalToken(manifest?.user_id),
      maskedUserEmail: normalizeOptionalToken(manifest?.masked_user_email),
      totalRowsReportedByRemote:
        typeof manifest?.total_rows === 'number' ? manifest.total_rows : rows.length,
    };
  } else {
    const env = options.env ?? process.env;
    const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
    const restRuntime = requireSupabaseRestRuntime(env);
    const session = await resolveSupabaseUserSession({
      runtime: restRuntime,
      fetchImpl,
      timeoutMs,
      now: options.now ?? new Date(),
    });
    const userId =
      scope === 'current-user'
        ? await resolveCurrentUserId({
            env,
            fetchImpl,
            timeoutMs,
            now: options.now ?? new Date(),
            maxRetries,
          })
        : null;
    const snapshot = await fetchProcessRows({
      env,
      fetchImpl,
      timeoutMs,
      maxRetries,
      scope,
      stateCodes,
      pageSize,
      userId,
    });
    rows = snapshot.rows;
    metadata = {
      userId,
      maskedUserEmail: redactEmail(session.userEmail),
      totalRowsReportedByRemote: snapshot.total ?? rows.length,
    };

    writeJsonLinesArtifact(snapshotRowsPath, rows);
    writeJsonArtifact(snapshotManifestPath, {
      schema_version: 1,
      generated_at_utc: generatedAtUtc,
      masked_user_email: metadata.maskedUserEmail,
      user_id: metadata.userId,
      scope,
      state_codes: stateCodes,
      page_size: pageSize,
      total_rows: metadata.totalRowsReportedByRemote,
    });
  }

  const statistics = calculateStatistics(
    rows,
    {
      scope,
      stateCodes,
    },
    metadata,
    generatedAtUtc,
  );

  const summaryPath = path.join(resolvedOutDir, 'outputs', 'process-scope-summary.json');
  const domainPath = path.join(resolvedOutDir, 'outputs', 'domain-summary.json');
  const craftPath = path.join(resolvedOutDir, 'outputs', 'craft-summary.json');
  const productPath = path.join(resolvedOutDir, 'outputs', 'product-summary.json');
  const datasetTypePath = path.join(resolvedOutDir, 'outputs', 'type-of-dataset-summary.json');
  const reportPath = path.join(resolvedOutDir, 'reports', 'process-scope-statistics.md');
  const reportZhPath = path.join(resolvedOutDir, 'reports', 'process-scope-statistics.zh-CN.md');

  writeJsonArtifact(summaryPath, statistics.summary);
  writeJsonArtifact(domainPath, {
    primary: statistics.domainPrimarySummary,
    leaf: statistics.domainLeafSummary,
  });
  writeJsonArtifact(craftPath, {
    craft_summary: statistics.craftSummary,
    source_summary: statistics.craftSourceSummary,
  });
  writeJsonArtifact(productPath, {
    product_summary: statistics.productSummary,
    source_summary: statistics.productSourceSummary,
  });
  writeJsonArtifact(datasetTypePath, statistics.typeOfDataSetSummary);
  writeTextArtifact(reportPath, renderMarkdownReport(statistics, 'en'));
  writeTextArtifact(reportZhPath, renderMarkdownReport(statistics, 'zh'));

  return {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    status: 'completed_process_scope_statistics',
    out_dir: resolvedOutDir,
    scope,
    state_codes: stateCodes,
    total_process_rows: statistics.summary.total_process_rows,
    domain_count_primary: statistics.summary.domain_count_primary,
    domain_count_leaf: statistics.summary.domain_count_leaf,
    craft_count: statistics.summary.craft_count,
    unit_process_rows: statistics.summary.unit_process_rows,
    product_count: statistics.summary.product_count,
    files: {
      snapshot_manifest: snapshotManifestPath,
      snapshot_rows: snapshotRowsPath,
      process_scope_summary: summaryPath,
      domain_summary: domainPath,
      craft_summary: craftPath,
      product_summary: productPath,
      type_of_dataset_summary: datasetTypePath,
      report: reportPath,
      report_zh: reportZhPath,
    },
  };
}

export const __testInternals = {
  calculateStatistics,
  ensureScope,
  escapePipe,
  extractClassificationEntries,
  extractCraftCandidate,
  extractReferenceProduct,
  fetchJsonWithRetry,
  fetchProcessRows,
  getAnyLangText,
  getLangList,
  getLangText,
  normalizePayload,
  normalizeSignature,
  normalizeSnapshotRow,
  normalizeStateCodes,
  parseJsonResponse,
  readSnapshotManifest,
  resolveCurrentUserId,
  renderMarkdownReport,
  toPositiveInteger,
};

// Pure summaries for the typed atomic statistics adapter; no remote scan or file policy.
export { calculateStatistics as summarizeObservedProcesses };
