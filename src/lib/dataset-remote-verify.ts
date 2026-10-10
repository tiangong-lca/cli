// data-api-relations: contacts, flowproperties, flows, lciamethods, lifecyclemodels, processes, sources, unitgroups
// data-api-dynamic-relation-expression: options.request.table
import crypto from 'node:crypto';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import { runAuthIdentityReceipt } from './auth-identity-receipt.js';
import { loadCliPackageVersion } from './package-version.js';
import {
  loadExactReferenceIntent,
  evaluateExactReference,
  assertExactReferenceInputsCurrent,
  type ExactReferenceConsumer,
  type ExactReferenceObservation,
  type ExactReferenceCheckEvidence,
  type LoadedExactReferenceIntent,
} from './dataset-exact-reference-intent.js';
import type { FetchLike } from './http.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
  type SupabaseDataRuntime,
} from './supabase-client.js';
import { createSupabaseDataRuntime } from './supabase-session.js';
import {
  firstNonEmpty,
  isRecord,
  readDatasetRowsInput,
  trimToken,
  unwrapDatasetPayload,
  type JsonObject,
} from './dataset-local.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export type RemoteDatasetTable =
  | 'contacts'
  | 'flowproperties'
  | 'flows'
  | 'lciamethods'
  | 'lifecyclemodels'
  | 'processes'
  | 'sources'
  | 'unitgroups';

export type RemoteVerificationReferenceRole = 'root' | 'reference';
export type RemoteVerificationRootPolicy = 'existing' | 'candidate';

export type RemoteVerificationStatus =
  | 'ok'
  | 'lookup_failed'
  | 'missing_dataset'
  | 'missing_version'
  | 'unsupported_type'
  | 'version_missing'
  | 'version_outdated';

export type RemoteVerificationIssueCode =
  | RemoteVerificationStatus
  | 'owner_mismatch'
  | 'payload_mismatch'
  | 'remote_payload_missing'
  | 'state_code_mismatch'
  | 'reference_intent_mismatch';

export type RemoteDatasetReference = {
  row_index: number;
  role: RemoteVerificationReferenceRole;
  table: RemoteDatasetTable | null;
  type: string | null;
  id: string | null;
  version: string | null;
  path: string;
  short_description: string | null;
};

export type RemoteDatasetLookupRow = {
  id: string;
  version: string | null;
};

export type RemoteDatasetLookup = {
  exact: RemoteDatasetLookupRow | null;
  latest: RemoteDatasetLookupRow | null;
  exact_source_url: string | null;
  latest_source_url: string | null;
};

export type RemoteDatasetPayloadLookup = {
  id: string;
  version: string | null;
  user_id: string | null;
  state_code: number | null;
  modified_at: string | null;
  payload: JsonObject | null;
  source_url: string | null;
};

export type RemoteDatasetLookupRequest = {
  table: RemoteDatasetTable;
  id: string;
  version: string | null;
};

export type RemoteVerificationCheck = {
  reference_intent?: ExactReferenceCheckEvidence;
  row_index: number;
  role: RemoteVerificationReferenceRole;
  table: RemoteDatasetTable | null;
  type: string | null;
  id: string | null;
  version: string | null;
  path: string;
  short_description: string | null;
  status: RemoteVerificationIssueCode;
  exact_version: string | null;
  latest_version: string | null;
  exact_source_url: string | null;
  latest_source_url: string | null;
  message: string;
  remote_user_id?: string | null;
  remote_state_code?: number | null;
  remote_modified_at?: string | null;
  local_payload_sha256?: string | null;
  remote_payload_sha256?: string | null;
};

export type RemoteVerificationBlocker = {
  code: RemoteVerificationIssueCode;
  severity: 'error';
  message: string;
  row_index: number;
  role: RemoteVerificationReferenceRole;
  table: RemoteDatasetTable | null;
  id: string | null;
  version: string | null;
  latest_version: string | null;
  path: string;
};

export type DatasetRemoteVerificationReport = {
  reference_intent?: LoadedExactReferenceIntent;
  schema_version: 1;
  generated_at_utc: string;
  status: 'passed_remote_verification' | 'blocked_remote_verification';
  root_policy: RemoteVerificationRootPolicy;
  input_path: string;
  out_dir: string;
  counts: {
    rows: number;
    references: number;
    checked: number;
    blockers: number;
    root_readback_checks?: number;
    root_payload_mismatches?: number;
    by_status: Record<string, number>;
    by_table: Record<RemoteDatasetTable, number>;
  };
  blockers: RemoteVerificationBlocker[];
  files: {
    report: string;
    checks: string;
    blockers: string;
  };
};

export type RunDatasetRemoteVerifyOptions = {
  referenceIntentFile?: string;
  resolveReferenceIdentityImpl?: () => Promise<{ project_ref: string; user_id: string }>;
  lookupReferencePayloadImpl?: (
    request: RemoteDatasetLookupRequest,
  ) => Promise<RemoteDatasetPayloadLookup | null>;
  inputPath: string;
  outDir: string;
  rootPolicy?: RemoteVerificationRootPolicy;
  compareRootPayload?: boolean;
  targetUserId?: string | null;
  stateCode?: number | null;
  rawInput?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  lookupDatasetImpl?: (request: RemoteDatasetLookupRequest) => Promise<RemoteDatasetLookup>;
  lookupRootPayloadImpl?: (
    request: RemoteDatasetLookupRequest,
  ) => Promise<RemoteDatasetPayloadLookup | null>;
};

type RootDatasetDescriptor = {
  wrapper: string;
  table: RemoteDatasetTable;
  type: string;
  information_key: string;
};

const ROOT_DATASET_DESCRIPTORS: RootDatasetDescriptor[] = [
  {
    wrapper: 'processDataSet',
    table: 'processes',
    type: 'process data set',
    information_key: 'processInformation',
  },
  {
    wrapper: 'flowDataSet',
    table: 'flows',
    type: 'flow data set',
    information_key: 'flowInformation',
  },
  {
    wrapper: 'lifeCycleModelDataSet',
    table: 'lifecyclemodels',
    type: 'life cycle model data set',
    information_key: 'lifeCycleModelInformation',
  },
  {
    wrapper: 'sourceDataSet',
    table: 'sources',
    type: 'source data set',
    information_key: 'sourceInformation',
  },
  {
    wrapper: 'contactDataSet',
    table: 'contacts',
    type: 'contact data set',
    information_key: 'contactInformation',
  },
  {
    wrapper: 'flowPropertyDataSet',
    table: 'flowproperties',
    type: 'flow property data set',
    information_key: 'flowPropertiesInformation',
  },
  {
    wrapper: 'unitGroupDataSet',
    table: 'unitgroups',
    type: 'unit group data set',
    information_key: 'unitGroupInformation',
  },
  {
    wrapper: 'LCIAMethodDataSet',
    table: 'lciamethods',
    type: 'LCIA method data set',
    information_key: 'LCIAMethodInformation',
  },
];

const TABLE_ALIASES = new Map<string, RemoteDatasetTable>([
  ['contact', 'contacts'],
  ['contact data set', 'contacts'],
  ['contacts', 'contacts'],
  ['flow', 'flows'],
  ['flow data set', 'flows'],
  ['flows', 'flows'],
  ['flow property', 'flowproperties'],
  ['flow property data set', 'flowproperties'],
  ['flowproperties', 'flowproperties'],
  ['lcia method', 'lciamethods'],
  ['lcia method data set', 'lciamethods'],
  ['lciamethod', 'lciamethods'],
  ['lciamethods', 'lciamethods'],
  ['life cycle model', 'lifecyclemodels'],
  ['life cycle model data set', 'lifecyclemodels'],
  ['lifecycle model', 'lifecyclemodels'],
  ['lifecycle model data set', 'lifecyclemodels'],
  ['lifecyclemodel', 'lifecyclemodels'],
  ['lifecyclemodels', 'lifecyclemodels'],
  ['process', 'processes'],
  ['process data set', 'processes'],
  ['processes', 'processes'],
  ['source', 'sources'],
  ['source data set', 'sources'],
  ['sources', 'sources'],
  ['unit group', 'unitgroups'],
  ['unit group data set', 'unitgroups'],
  ['unitgroup', 'unitgroups'],
  ['unitgroups', 'unitgroups'],
]);

const PATH_TABLE_HINTS: Array<[RegExp, RemoteDatasetTable]> = [
  [/referenceToFlowDataSet$/u, 'flows'],
  [/referenceToProcess$/u, 'processes'],
  [/referenceToResultingProcess$/u, 'processes'],
  [/referenceToFlowPropertyDataSet$/u, 'flowproperties'],
  [/referenceToReferenceUnitGroup$/u, 'unitgroups'],
  [/referenceToLCIAMethodDataSet$/u, 'lciamethods'],
  [/referenceToDataSource$/u, 'sources'],
  [/referenceToExternalDocumentation$/u, 'sources'],
  [/referenceToDataSetFormat$/u, 'sources'],
  [/referenceToComplianceSystem$/u, 'sources'],
  [/referenceToDataSetUseApproval$/u, 'sources'],
  [/referenceToContact$/u, 'contacts'],
  [/referenceToCommissioner$/u, 'contacts'],
  [/referenceToPersonOrEntity/u, 'contacts'],
  [/referenceToNameOfReviewerAndInstitution$/u, 'contacts'],
];

const EMPTY_STATUS_COUNTS: Record<string, number> = {
  ok: 0,
  lookup_failed: 0,
  missing_dataset: 0,
  missing_version: 0,
  owner_mismatch: 0,
  payload_mismatch: 0,
  remote_payload_missing: 0,
  state_code_mismatch: 0,
  unsupported_type: 0,
  version_missing: 0,
  version_outdated: 0,
};

const EMPTY_TABLE_COUNTS: Record<RemoteDatasetTable, number> = {
  contacts: 0,
  flowproperties: 0,
  flows: 0,
  lciamethods: 0,
  lifecyclemodels: 0,
  processes: 0,
  sources: 0,
  unitgroups: 0,
};

function requireNonEmpty(value: string, label: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CliError(`Missing required ${label} value.`, {
      code,
      exitCode: 2,
    });
  }
  return normalized;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function textValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return trimToken(value);
}

function normalizeTableToken(value: string | null): string | null {
  return value ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : null;
}

function tableFromType(value: string | null): RemoteDatasetTable | null {
  const normalized = normalizeTableToken(value);
  return normalized ? (TABLE_ALIASES.get(normalized) ?? null) : null;
}

function tableFromPath(pathExpression: string): RemoteDatasetTable | null {
  const pathEnd = pathExpression.split('/').filter(Boolean).at(-1) ?? '';
  return PATH_TABLE_HINTS.find(([pattern]) => pattern.test(pathEnd))?.[1] ?? null;
}

function shortDescription(value: unknown): string | null {
  if (typeof value === 'string') {
    return textValue(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = shortDescription(entry);
      if (text) {
        return text;
      }
    }
    return null;
  }
  if (isRecord(value)) {
    return textValue(value['#text'] ?? value.text ?? value.value);
  }
  return null;
}

function pointerPath(basePath: string, segment: string | number): string {
  const encoded = String(segment).replace(/~/gu, '~0').replace(/\//gu, '~1');
  return `${basePath}/${encoded}`;
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function isFoundryTracePath(pathExpression: string): boolean {
  const segments = pathExpression.split('/').filter(Boolean).map(unescapePointerSegment);
  return (
    segments.includes('common:other') &&
    segments.some(
      (segment) =>
        segment.startsWith('tiangongfoundry:') && segment.toLowerCase().includes('trace'),
    )
  );
}

function rootOf(
  payload: JsonObject,
): { descriptor: RootDatasetDescriptor; root: JsonObject } | null {
  for (const descriptor of ROOT_DATASET_DESCRIPTORS) {
    if (isRecord(payload[descriptor.wrapper])) {
      return { descriptor, root: payload[descriptor.wrapper] as JsonObject };
    }
  }
  return null;
}

function rootIdentity(row: JsonObject, payload: JsonObject): RemoteDatasetReference | null {
  const root = rootOf(payload);
  if (!root) {
    return null;
  }
  const information = isRecord(root.root[root.descriptor.information_key])
    ? (root.root[root.descriptor.information_key] as JsonObject)
    : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.root.administrativeInformation)
    ? root.root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};

  return {
    row_index: -1,
    role: 'root',
    table: root.descriptor.table,
    type: root.descriptor.type,
    id: firstNonEmpty(row.id, row.uuid, dataSetInformation['common:UUID']),
    version: firstNonEmpty(row.version, publicationAndOwnership['common:dataSetVersion']),
    path: `/${root.descriptor.wrapper}`,
    short_description: shortDescription(dataSetInformation.name ?? dataSetInformation.shortName),
  };
}

function referenceFromRecord(
  rowIndex: number,
  value: JsonObject,
  pathExpression: string,
): RemoteDatasetReference | null {
  const id = firstNonEmpty(value['@refObjectId'], value.refObjectId, value.id);
  if (!id) {
    return null;
  }
  const type = firstNonEmpty(value['@type'], value.type);
  const table = tableFromType(type) ?? tableFromPath(pathExpression);
  return {
    row_index: rowIndex,
    role: 'reference',
    table,
    type,
    id,
    version: firstNonEmpty(value['@version'], value.version),
    path: pathExpression,
    short_description: shortDescription(value['common:shortDescription']),
  };
}

function flowReferenceFromRecord(
  rowIndex: number,
  value: JsonObject,
  pathExpression: string,
): RemoteDatasetReference | null {
  const id = firstNonEmpty(value['@flowUUID']);
  return id
    ? {
        row_index: rowIndex,
        role: 'reference',
        table: 'flows',
        type: 'flow data set',
        id,
        version: firstNonEmpty(value['@version'], value.version),
        path: pointerPath(pathExpression, '@flowUUID'),
        short_description: null,
      }
    : null;
}

function collectReferencesFromValue(
  rowIndex: number,
  value: unknown,
  pathExpression: string,
  references: RemoteDatasetReference[],
): void {
  if (isFoundryTracePath(pathExpression)) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectReferencesFromValue(rowIndex, entry, pointerPath(pathExpression, index), references),
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const ref = referenceFromRecord(rowIndex, value, pathExpression);
  if (ref) {
    references.push(ref);
  }
  const flowRef = flowReferenceFromRecord(rowIndex, value, pathExpression);
  if (flowRef) {
    references.push(flowRef);
  }
  for (const [key, nested] of Object.entries(value)) {
    collectReferencesFromValue(rowIndex, nested, pointerPath(pathExpression, key), references);
  }
}

export function collectRemoteReferences(rows: JsonObject[]): RemoteDatasetReference[] {
  const references: RemoteDatasetReference[] = [];
  rows.forEach((row, index) => {
    const payload = unwrapDatasetPayload(row);
    const root = rootIdentity(row, payload);
    if (root) {
      references.push({ ...root, row_index: index });
    }
    collectReferencesFromValue(index, payload, '', references);
  });
  return references;
}

function compareVersions(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  const leftParts = left.split(/[._-]/u);
  const rightParts = right.split(/[._-]/u);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }
    } else {
      const compared = leftPart.localeCompare(rightPart);
      if (compared !== 0) {
        return compared > 0 ? 1 : -1;
      }
    }
  }
  return 0;
}

function buildRemoteUrl(
  restBaseUrl: string,
  table: RemoteDatasetTable,
  id: string,
  version: string | null,
): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/${table}`);
  url.searchParams.set('id', `eq.${id}`);
  if (version) {
    url.searchParams.set('version', `eq.${version}`);
  } else {
    url.searchParams.set('order', 'version.desc');
    url.searchParams.set('limit', '1');
  }
  return url.toString();
}

function normalizeRows(value: unknown): RemoteDatasetLookupRow[] {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map((row) => ({
          id: firstNonEmpty(row.id) ?? '',
          version: firstNonEmpty(row.version),
        }))
        .filter((row) => Boolean(row.id))
    : [];
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function sha256Json(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(value)))
    .digest('hex');
}

function buildRemotePayloadUrl(
  restBaseUrl: string,
  table: RemoteDatasetTable,
  id: string,
  version: string | null,
): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/${table}`);
  url.searchParams.set('select', 'id,version,user_id,state_code,modified_at,json,json_ordered');
  url.searchParams.set('id', `eq.${id}`);
  if (version === null) {
    url.searchParams.set('order', 'version.desc');
    url.searchParams.set('limit', '1');
  } else url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

function normalizePayloadRow(value: unknown): RemoteDatasetPayloadLookup | null {
  if (!isRecord(value)) {
    return null;
  }
  const payload = isRecord(value.json_ordered)
    ? value.json_ordered
    : isRecord(value.json)
      ? value.json
      : null;
  return {
    id: firstNonEmpty(value.id) ?? '',
    version: firstNonEmpty(value.version),
    user_id: firstNonEmpty(value.user_id),
    state_code: typeof value.state_code === 'number' ? value.state_code : null,
    modified_at: firstNonEmpty(value.modified_at),
    payload: payload as JsonObject | null,
    source_url: null,
  };
}

export async function lookupRemoteDataset(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  request: RemoteDatasetLookupRequest;
}): Promise<RemoteDatasetLookup> {
  const { client, restBaseUrl } = createSupabaseDataClient(
    options.runtime,
    options.fetchImpl,
    options.timeoutMs,
  );
  const exactSourceUrl = options.request.version
    ? buildRemoteUrl(
        restBaseUrl,
        options.request.table,
        options.request.id,
        options.request.version,
      )
    : null;
  const latestSourceUrl = buildRemoteUrl(
    restBaseUrl,
    options.request.table,
    options.request.id,
    null,
  );
  const exactRows = options.request.version
    ? normalizeRows(
        await runSupabaseArrayQuery(
          client
            .from(options.request.table)
            .select('id,version')
            .eq('id', options.request.id)
            .eq('version', options.request.version),
          exactSourceUrl as string,
        ),
      )
    : [];
  const latestRows = normalizeRows(
    await runSupabaseArrayQuery(
      client
        .from(options.request.table)
        .select('id,version')
        .eq('id', options.request.id)
        .order('version', { ascending: false })
        .limit(1),
      latestSourceUrl,
    ),
  );
  return {
    exact: exactRows[0] ?? null,
    latest: latestRows[0] ?? null,
    exact_source_url: exactSourceUrl,
    latest_source_url: latestSourceUrl,
  };
}

export async function lookupRemoteDatasetPayload(options: {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
  request: RemoteDatasetLookupRequest;
  allowLatest?: boolean;
  requireUnique?: boolean;
}): Promise<RemoteDatasetPayloadLookup | null> {
  if (!options.request.version && !(options.allowLatest && options.request.version === null)) {
    return null;
  }
  const { client, restBaseUrl } = createSupabaseDataClient(
    options.runtime,
    options.fetchImpl,
    options.timeoutMs,
  );
  const sourceUrl = buildRemotePayloadUrl(
    restBaseUrl,
    options.request.table,
    options.request.id,
    options.request.version,
  );
  const query = client
    .from(options.request.table)
    .select('id,version,user_id,state_code,modified_at,json,json_ordered')
    .eq('id', options.request.id);
  const rows = await runSupabaseArrayQuery(
    options.request.version === null
      ? query.order('version', { ascending: false }).limit(1)
      : query.eq('version', options.request.version),
    sourceUrl,
  );
  const payloadRow = normalizePayloadRow(
    Array.isArray(rows) && (!options.requireUnique || rows.length === 1) ? rows[0] : null,
  );
  return payloadRow ? { ...payloadRow, source_url: sourceUrl } : null;
}

function checkMessage(reference: RemoteDatasetReference, status: RemoteVerificationStatus): string {
  const label = `${reference.table ?? reference.type ?? 'unknown'}:${reference.id ?? '-'}@${
    reference.version ?? '-'
  }`;
  switch (status) {
    case 'ok':
      return `Remote dataset reference is resolvable: ${label}.`;
    case 'lookup_failed':
      return `Remote lookup failed for dataset reference: ${label}.`;
    case 'missing_dataset':
      return `Remote dataset id does not exist: ${label}.`;
    case 'missing_version':
      return `Remote dataset id exists, but the requested version does not exist: ${label}.`;
    case 'unsupported_type':
      return `Dataset reference type cannot be mapped to a TianGong table: ${label}.`;
    case 'version_missing':
      return `Dataset reference is missing @version and cannot pass publish-readiness verification: ${label}.`;
    case 'version_outdated':
      return `Requested dataset version is lower than the latest published version: ${label}.`;
  }
}

export function classifyCheck(
  reference: RemoteDatasetReference,
  lookup: RemoteDatasetLookup | null,
  lookupFailed: boolean,
  rootPolicy: RemoteVerificationRootPolicy,
): RemoteVerificationCheck {
  let status: RemoteVerificationStatus = 'ok';
  if (!reference.table || !reference.id) {
    status = 'unsupported_type';
  } else if (lookupFailed) {
    status = 'lookup_failed';
  } else if (!reference.version) {
    status = 'version_missing';
  } else if (reference.role === 'root' && rootPolicy === 'candidate') {
    if (!lookup?.latest) {
      status = 'ok';
    } else if (!lookup.exact) {
      status =
        compareVersions(reference.version, lookup.latest.version) > 0
          ? 'ok'
          : compareVersions(lookup.latest.version, reference.version) > 0
            ? 'version_outdated'
            : 'missing_version';
    } else if (compareVersions(lookup.latest.version, reference.version) > 0) {
      status = 'version_outdated';
    }
  } else if (!lookup?.latest) {
    status = 'missing_dataset';
  } else if (!lookup.exact) {
    status = 'missing_version';
  } else if (compareVersions(lookup.latest.version, reference.version) > 0) {
    status = 'version_outdated';
  }
  return {
    ...reference,
    status,
    exact_version: lookup?.exact?.version ?? null,
    latest_version: lookup?.latest?.version ?? null,
    exact_source_url: lookup?.exact_source_url ?? null,
    latest_source_url: lookup?.latest_source_url ?? null,
    message: checkMessage(reference, status),
  };
}

function blockerFromCheck(check: RemoteVerificationCheck): RemoteVerificationBlocker | null {
  return check.status === 'ok'
    ? null
    : {
        code: check.status,
        severity: 'error',
        message: check.message,
        row_index: check.row_index,
        role: check.role,
        table: check.table,
        id: check.id,
        version: check.version,
        latest_version: check.latest_version,
        path: check.path,
      };
}

function makeRootReadbackCheck(
  reference: RemoteDatasetReference,
  status: RemoteVerificationIssueCode,
  message: string,
  remote: RemoteDatasetPayloadLookup | null,
  hashes: {
    local: string | null;
    remote: string | null;
  } = { local: null, remote: null },
): RemoteVerificationCheck {
  return {
    ...reference,
    path: `${reference.path}#readback`,
    status,
    exact_version: remote?.version ?? null,
    latest_version: null,
    exact_source_url: remote?.source_url ?? null,
    latest_source_url: null,
    message,
    remote_user_id: remote?.user_id ?? null,
    remote_state_code: remote?.state_code ?? null,
    remote_modified_at: remote?.modified_at ?? null,
    local_payload_sha256: hashes.local,
    remote_payload_sha256: hashes.remote,
  };
}

function rootReadbackChecks(options: {
  reference: RemoteDatasetReference;
  localPayload: JsonObject;
  remote: RemoteDatasetPayloadLookup | null;
  compareRootPayload: boolean;
  targetUserId: string | null;
  stateCode: number | null;
}): RemoteVerificationCheck[] {
  const { reference, localPayload, remote, compareRootPayload, targetUserId, stateCode } = options;
  if (!remote) {
    return [
      makeRootReadbackCheck(
        reference,
        'missing_dataset',
        `Remote root payload was not found for ${reference.table}:${reference.id}@${reference.version}.`,
        null,
      ),
    ];
  }

  const checks: RemoteVerificationCheck[] = [];
  if (targetUserId && remote.user_id !== targetUserId) {
    checks.push(
      makeRootReadbackCheck(
        reference,
        'owner_mismatch',
        `Remote root owner ${remote.user_id ?? '<missing>'} does not match target user ${targetUserId}.`,
        remote,
      ),
    );
  }
  if (stateCode !== null && remote.state_code !== stateCode) {
    checks.push(
      makeRootReadbackCheck(
        reference,
        'state_code_mismatch',
        `Remote root state_code ${remote.state_code ?? '<missing>'} does not match required state_code ${stateCode}.`,
        remote,
      ),
    );
  }

  let hashes: { local: string | null; remote: string | null } = { local: null, remote: null };
  if (compareRootPayload) {
    if (!remote.payload) {
      checks.push(
        makeRootReadbackCheck(
          reference,
          'remote_payload_missing',
          `Remote root payload is missing for ${reference.table}:${reference.id}@${reference.version}.`,
          remote,
        ),
      );
    } else {
      hashes = {
        local: sha256Json(localPayload),
        remote: sha256Json(remote.payload),
      };
      if (hashes.local !== hashes.remote) {
        checks.push(
          makeRootReadbackCheck(
            reference,
            'payload_mismatch',
            `Remote root payload hash does not match local row for ${reference.table}:${reference.id}@${reference.version}.`,
            remote,
            hashes,
          ),
        );
      }
    }
  }

  if (checks.length > 0) {
    return checks;
  }
  return [
    makeRootReadbackCheck(
      reference,
      'ok',
      `Remote root readback matches required owner, state, and payload checks for ${reference.table}:${reference.id}@${reference.version}.`,
      remote,
      hashes,
    ),
  ];
}

function buildFiles(outDir: string): DatasetRemoteVerificationReport['files'] {
  const resolved = path.resolve(outDir);
  return {
    report: path.join(resolved, 'outputs', 'remote-verification-report.json'),
    checks: path.join(resolved, 'outputs', 'remote-verification.jsonl'),
    blockers: path.join(resolved, 'outputs', 'blockers.jsonl'),
  };
}

function uniqueLookupKey(reference: RemoteDatasetReference): string | null {
  return reference.table && reference.id
    ? `${reference.table}:${reference.id}:${reference.version ?? ''}`
    : null;
}

export function exactReferenceConsumers(rows: JsonObject[]): ExactReferenceConsumer[] {
  return rows.map((row, index) => {
    const payload = unwrapDatasetPayload(row),
      root = rootIdentity({}, payload),
      envelope = rootIdentity(row, payload);
    if (
      !root?.table ||
      !root.id ||
      !root.version ||
      !envelope?.id ||
      envelope.id.toLowerCase() !== root.id.toLowerCase() ||
      envelope.version !== root.version
    )
      throw new CliError('Exact-reference consumers need matching payload and row identities.', {
        code: 'DATASET_REFERENCE_INTENT_INVALID',
        exitCode: 2,
      });
    return {
      row_index: index,
      table: root.table,
      id: root.id.toLowerCase(),
      version: root.version,
      payload_sha256: sha256Json(payload),
    };
  });
}

/** Shared complete-body observation; row metadata alone never supplies a reviewed hash. */
export function exactReferenceObservation(
  request: RemoteDatasetLookupRequest,
  remote: RemoteDatasetPayloadLookup | null,
): ExactReferenceObservation | null {
  if (!remote) return null;
  const root = remote.payload ? rootIdentity({}, remote.payload) : null;
  const valid =
    root?.table === request.table &&
    root.id?.toLowerCase() === remote.id.toLowerCase() &&
    root.version === remote.version;
  return {
    id: remote.id,
    version: remote.version,
    user_id: remote.user_id,
    state_code: remote.state_code,
    payload_sha256: valid && remote.payload ? sha256Json(remote.payload) : null,
  };
}

export async function runDatasetRemoteVerify(
  options: RunDatasetRemoteVerifyOptions,
): Promise<DatasetRemoteVerificationReport> {
  const inputPath = path.resolve(
    requireNonEmpty(options.inputPath, '--input', 'DATASET_REMOTE_VERIFY_INPUT_REQUIRED'),
  );
  const outDir = path.resolve(
    requireNonEmpty(options.outDir, '--out-dir', 'DATASET_REMOTE_VERIFY_OUT_DIR_REQUIRED'),
  );
  const rows = readDatasetRowsInput(inputPath, options.rawInput);
  const references = collectRemoteReferences(rows);
  const intent =
    options.referenceIntentFile === undefined
      ? null
      : loadExactReferenceIntent({
          file: options.referenceIntentFile,
          consumers: exactReferenceConsumers(rows),
          references,
        });
  const environment = { ...(options.env ?? process.env) };
  const rootPolicy = options.rootPolicy ?? 'existing';
  const compareRootPayload = options.compareRootPayload === true;
  const targetUserId = trimToken(options.targetUserId);
  const stateCode = options.stateCode ?? null;
  const needsRootReadback = compareRootPayload || Boolean(targetUserId) || stateCode !== null;
  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runtime =
    options.lookupDatasetImpl === undefined
      ? createSupabaseDataRuntime({
          runtime: requireSupabaseRestRuntime(environment),
          fetchImpl,
          timeoutMs,
          now: options.now,
        })
      : null;
  const lookupImpl =
    options.lookupDatasetImpl ??
    ((request: RemoteDatasetLookupRequest) =>
      lookupRemoteDataset({
        runtime: runtime as SupabaseDataRuntime,
        fetchImpl,
        timeoutMs,
        request,
      }));
  const rootPayloadLookupImpl =
    options.lookupRootPayloadImpl ??
    (runtime
      ? (request: RemoteDatasetLookupRequest) =>
          lookupRemoteDatasetPayload({
            runtime: runtime as SupabaseDataRuntime,
            fetchImpl,
            timeoutMs,
            request,
          })
      : null);
  if (intent) {
    const observed = options.resolveReferenceIdentityImpl
      ? await options.resolveReferenceIdentityImpl()
      : await (async () => {
          const receipt = await runAuthIdentityReceipt({
            env: environment,
            fetchImpl,
            cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
            expectedProjectRef: intent.project_ref,
            expectedUserId: intent.actor_user_id,
            timeoutMs,
            now: options.now,
          });
          return { project_ref: receipt.project.project_ref, user_id: receipt.identity.user_id };
        })();
    if (observed.project_ref !== intent.project_ref || observed.user_id !== intent.actor_user_id)
      throw new CliError(
        'Exact-reference intent differs from the current verified actor or project.',
        { code: 'DATASET_REFERENCE_INTENT_IDENTITY_MISMATCH', exitCode: 2 },
      );
  }
  const referencePins = new Map(
    intent?.references.map((pin) => [`${pin.row_index}:reference:${pin.path}`, pin]),
  );
  const referencePayloadCache = new Map<string, Promise<ExactReferenceObservation | null>>();
  const readReferencePayload = (request: RemoteDatasetLookupRequest) => {
    const key = `${request.table}:${request.id}:${request.version ?? 'latest'}`;
    let cached = referencePayloadCache.get(key);
    if (!cached) {
      cached = (async () => {
        const remote = options.lookupReferencePayloadImpl
          ? await options.lookupReferencePayloadImpl(request)
          : runtime
            ? await lookupRemoteDatasetPayload({
                runtime,
                fetchImpl,
                timeoutMs,
                request,
                allowLatest: true,
              })
            : null;
        return exactReferenceObservation(request, remote);
      })();
      referencePayloadCache.set(key, cached);
    }
    return cached;
  };
  const lookupCache = new Map<string, Promise<RemoteDatasetLookup>>();
  const checks: RemoteVerificationCheck[] = [];

  // Pre-fetch the unique remote lookups in bounded-concurrency batches. Large
  // reference closures (e.g. a mega-process referencing 1600+ flows) would
  // otherwise serialize into thousands of sequential round-trips and take many
  // minutes; the loop below then simply awaits the already-in-flight cached
  // promises, preserving the existing per-reference error handling.
  const REMOTE_LOOKUP_CONCURRENCY = 20;
  const prefetch: Array<{ key: string; request: RemoteDatasetLookupRequest }> = [];
  const prefetchQueued = new Set<string>();
  for (const reference of references) {
    const lookupKey = uniqueLookupKey(reference);
    if (reference.table && reference.id && lookupKey && !prefetchQueued.has(lookupKey)) {
      prefetchQueued.add(lookupKey);
      prefetch.push({
        key: lookupKey,
        request: { table: reference.table, id: reference.id, version: reference.version },
      });
    }
  }
  for (let offset = 0; offset < prefetch.length; offset += REMOTE_LOOKUP_CONCURRENCY) {
    const batch = prefetch.slice(offset, offset + REMOTE_LOOKUP_CONCURRENCY);
    await Promise.all(
      batch.map(({ key, request }) => {
        const promise = lookupImpl(request);
        lookupCache.set(key, promise);
        return promise.then(
          () => undefined,
          () => undefined,
        );
      }),
    );
  }

  for (const reference of references) {
    let lookup: RemoteDatasetLookup | null = null;
    let lookupFailed = false;
    const lookupKey = uniqueLookupKey(reference);
    if (reference.table && reference.id && lookupKey) {
      // The bounded-concurrency prefetch above populated lookupCache for every
      // reference that passes this same guard, so the promise is always present.
      try {
        lookup = await lookupCache.get(lookupKey)!;
      } catch {
        lookupFailed = true;
      }
    }
    let check = classifyCheck(reference, lookup, lookupFailed, rootPolicy);
    const pin = referencePins.get(`${reference.row_index}:${reference.role}:${reference.path}`);
    if (intent && pin) {
      let selected: ExactReferenceObservation | null = null,
        latest: ExactReferenceObservation | null = null,
        payloadLookupFailed = false;
      if (check.status === 'ok' || check.status === 'version_outdated') {
        try {
          latest = await readReferencePayload({
            table: pin.selected.table,
            id: pin.selected.id,
            version: null,
          });
          selected =
            latest?.version === pin.selected.version
              ? latest
              : await readReferencePayload({
                  table: pin.selected.table,
                  id: pin.selected.id,
                  version: pin.selected.version,
                });
        } catch {
          payloadLookupFailed = true;
        }
      }
      check = evaluateExactReference({
        intent,
        pin,
        check,
        selected,
        latest,
        lookupFailed: payloadLookupFailed,
      });
    }
    checks.push(check);
  }

  if (needsRootReadback) {
    const rootChecks = checks.filter(
      (check) =>
        check.role === 'root' &&
        check.status === 'ok' &&
        check.table &&
        check.id &&
        (compareRootPayload || rootPolicy !== 'candidate' || Boolean(check.exact_version)),
    );
    for (const check of rootChecks) {
      const localPayload = unwrapDatasetPayload(rows[check.row_index]);
      let remotePayload: RemoteDatasetPayloadLookup | null;
      try {
        if (!rootPayloadLookupImpl) {
          throw new Error('root payload lookup is not available');
        }
        remotePayload = await rootPayloadLookupImpl({
          table: check.table as RemoteDatasetTable,
          id: check.id as string,
          version: check.version,
        });
      } catch {
        checks.push(
          makeRootReadbackCheck(
            check,
            'lookup_failed',
            `Remote root payload lookup failed for ${check.table}:${check.id}@${check.version}.`,
            null,
          ),
        );
        continue;
      }
      checks.push(
        ...rootReadbackChecks({
          reference: check,
          localPayload,
          remote: remotePayload,
          compareRootPayload,
          targetUserId,
          stateCode,
        }),
      );
    }
  }

  const blockers = checks
    .map(blockerFromCheck)
    .filter((blocker): blocker is RemoteVerificationBlocker => blocker !== null);
  const byStatus = { ...EMPTY_STATUS_COUNTS };
  const byTable = { ...EMPTY_TABLE_COUNTS };
  checks.forEach((check) => {
    byStatus[check.status] ??= 0;
    byStatus[check.status] += 1;
    if (check.table) {
      byTable[check.table] += 1;
    }
  });
  const rootReadbackChecksCount = checks.filter((check) => check.path.endsWith('#readback')).length;
  const rootPayloadMismatches = checks.filter(
    (check) => check.status === 'payload_mismatch',
  ).length;

  if (intent)
    assertExactReferenceInputsCurrent(
      intent,
      exactReferenceConsumers(
        options.rawInput === undefined ? readDatasetRowsInput(inputPath) : rows,
      ),
    );
  const files = buildFiles(outDir);
  const report: DatasetRemoteVerificationReport = {
    schema_version: 1,
    ...(intent ? { reference_intent: intent } : {}),
    generated_at_utc: nowIso(options.now),
    status: blockers.length > 0 ? 'blocked_remote_verification' : 'passed_remote_verification',
    root_policy: rootPolicy,
    input_path: inputPath,
    out_dir: outDir,
    counts: {
      rows: rows.length,
      references: references.length,
      checked: checks.length,
      blockers: blockers.length,
      ...(needsRootReadback ? { root_readback_checks: rootReadbackChecksCount } : {}),
      ...(needsRootReadback ? { root_payload_mismatches: rootPayloadMismatches } : {}),
      by_status: byStatus,
      by_table: byTable,
    },
    blockers,
    files,
  };

  writeJsonArtifact(files.report, report);
  writeJsonLinesArtifact(files.checks, checks);
  writeJsonLinesArtifact(files.blockers, blockers);

  return report;
}

export const __testInternals = {
  buildRemotePayloadUrl,
  buildRemoteUrl,
  collectRemoteReferences,
  compareVersions,
  isFoundryTracePath,
  lookupRemoteDatasetPayload,
  lookupRemoteDataset,
  makeRootReadbackCheck,
  normalizePayloadRow,
  normalizeRows,
  rootReadbackChecks,
  sha256Json,
  shortDescription,
  tableFromPath,
  tableFromType,
};
