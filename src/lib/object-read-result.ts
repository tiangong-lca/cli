import { CliError } from './errors.js';

export type ObjectReadDatasetType =
  'process' | 'flow' | 'contact' | 'source' | 'lifecyclemodel' | 'flowproperty' | 'unitgroup';

export type ObjectReadResolution =
  'remote_supabase_exact' | 'remote_supabase_latest' | 'remote_supabase_latest_fallback';

export type ObjectReadWarning = {
  code: 'VERSION_FALLBACK';
  requested_version: string;
  resolved_version: string;
  message: string;
};

const DATASETS: Record<ObjectReadDatasetType, { wrapper: string; information: string }> = {
  process: { wrapper: 'processDataSet', information: 'processInformation' },
  flow: { wrapper: 'flowDataSet', information: 'flowInformation' },
  contact: { wrapper: 'contactDataSet', information: 'contactInformation' },
  source: { wrapper: 'sourceDataSet', information: 'sourceInformation' },
  lifecyclemodel: {
    wrapper: 'lifeCycleModelDataSet',
    information: 'lifeCycleModelInformation',
  },
  flowproperty: { wrapper: 'flowPropertyDataSet', information: 'flowPropertiesInformation' },
  unitgroup: { wrapper: 'unitGroupDataSet', information: 'unitGroupInformation' },
};

export function isObjectReadUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function isObjectReadVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}\.\d{2}\.\d{3}$/u.test(value);
}

export function validateObjectReadRows(options: {
  datasetType: ObjectReadDatasetType;
  requestedId: string;
  requestedVersion: string | null;
  rows: Array<{ id: unknown; version: unknown; payload: unknown }>;
}): void {
  const results = options.rows.map((row) =>
    validateObjectReadResult({
      datasetType: options.datasetType,
      requestedId: options.requestedId,
      requestedVersion: options.requestedVersion,
      rowId: row.id,
      rowVersion: row.version,
      payload: row.payload,
      resolution:
        options.requestedVersion === null ? 'remote_supabase_latest' : 'remote_supabase_exact',
    }),
  );
  if (
    results.length > 2 ||
    (options.requestedVersion === null &&
      results.length === 2 &&
      results[0].resolved_version < results[1].resolved_version)
  )
    throw new CliError('Object read response has an inconsistent row count or version order.', {
      code: 'OBJECT_GET_RESPONSE_INVALID',
      exitCode: 1,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function validateObjectReadResult(options: {
  datasetType: ObjectReadDatasetType;
  requestedId: string;
  requestedVersion: string | null;
  rowId: unknown;
  rowVersion: unknown;
  payload: unknown;
  resolution: ObjectReadResolution;
}): {
  id: string;
  requested_version: string | null;
  resolved_version: string;
  resolution: ObjectReadResolution;
  version_fallback: boolean;
  warnings: ObjectReadWarning[];
  payload: Record<string, unknown>;
} {
  const fail = (): never => {
    throw new CliError('Object read response has invalid or inconsistent dataset identity.', {
      code: 'OBJECT_GET_RESPONSE_INVALID',
      exitCode: 1,
    });
  };
  if (!isObjectReadUuid(options.rowId) || !isObjectReadVersion(options.rowVersion)) fail();
  const id = options.rowId as string;
  const version = options.rowVersion as string;
  if (id.toLowerCase() !== options.requestedId.toLowerCase()) fail();
  const requested = options.requestedVersion;
  if (requested !== null && !isObjectReadVersion(requested)) fail();
  if (
    (options.resolution === 'remote_supabase_exact' && requested !== version) ||
    (options.resolution === 'remote_supabase_latest' && requested !== null) ||
    (options.resolution === 'remote_supabase_latest_fallback' && requested === null)
  )
    fail();

  const descriptor = DATASETS[options.datasetType];
  const payload = options.payload;
  if (!isRecord(payload)) fail();
  const objectPayload = payload as Record<string, unknown>;
  const wrappers = Object.keys(objectPayload).filter((key) => key.endsWith('DataSet'));
  if (wrappers.length !== 1 || wrappers[0] !== descriptor.wrapper) fail();
  const embeddedId = readPath(objectPayload, [
    descriptor.wrapper,
    descriptor.information,
    'dataSetInformation',
    'common:UUID',
  ]);
  const embeddedVersion = readPath(objectPayload, [
    descriptor.wrapper,
    'administrativeInformation',
    'publicationAndOwnership',
    'common:dataSetVersion',
  ]);
  if (
    !isObjectReadUuid(embeddedId) ||
    embeddedId.toLowerCase() !== id.toLowerCase() ||
    embeddedVersion !== version
  )
    fail();

  const versionFallback = options.resolution === 'remote_supabase_latest_fallback';
  return {
    id,
    requested_version: requested,
    resolved_version: version,
    resolution: options.resolution,
    version_fallback: versionFallback,
    warnings: versionFallback
      ? [
          {
            code: 'VERSION_FALLBACK',
            requested_version: requested as string,
            resolved_version: version,
            message:
              'Requested version was not visible in the selected scope; returned the latest visible version.',
          },
        ]
      : [],
    payload: objectPayload,
  };
}
