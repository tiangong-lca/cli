// data-api-relations: flows
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';
import { createSupabaseDataClient, runSupabaseArrayQuery } from './supabase-client.js';
import { sha256Json } from './canonical-json-hash.js';
import {
  analyzeProcessPayloadSemantics,
  type ProcessSemanticContext,
} from './process-semantic-validation.js';

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}
/** Exact authenticated RLS reads rebind scientific evidence immediately before dispatch. */
export async function assertProcessAllocationWriteAdmission(
  payload: Json,
  context: ProcessSemanticContext,
  transport: {
    apiBaseUrl: string;
    publishableKey: string;
    accessToken: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
) {
  const exchanges = list(record(record(payload.processDataSet).exchanges).exchange).filter(
    isRecord,
  );
  const selected = new Set<string>();
  for (const exchange of exchanges)
    for (const allocation of list(record(exchange.allocations).allocation)) {
      const id = record(allocation)['@internalReferenceToCoProduct'];
      if (typeof id === 'string' || typeof id === 'number') selected.add(String(id));
    }
  const refs = new Map<string, { uuid: string; version: string }>();
  for (const exchange of exchanges)
    if (selected.has(String(exchange['@dataSetInternalID']))) {
      const ref = record(exchange.referenceToFlowDataSet);
      if (typeof ref['@refObjectId'] === 'string' && typeof ref['@version'] === 'string')
        refs.set(JSON.stringify([ref['@refObjectId'], ref['@version']]), {
          uuid: ref['@refObjectId'],
          version: ref['@version'],
        });
    }
  const { client, restBaseUrl } = createSupabaseDataClient(
    {
      apiBaseUrl: transport.apiBaseUrl,
      publishableKey: transport.publishableKey,
      getAccessToken: async () => transport.accessToken,
    },
    transport.fetchImpl,
    transport.timeoutMs,
  );
  const documents: Json[] = [];
  for (const { uuid, version } of refs.values()) {
    const rows = await runSupabaseArrayQuery<Json>(
      client
        .from('flows')
        .select('id,version,json_ordered')
        .eq('id', uuid)
        .eq('version', version)
        .limit(2),
      `${restBaseUrl}/flows`,
    );
    if (
      rows.length !== 1 ||
      rows[0].id !== uuid ||
      rows[0].version !== version ||
      !isRecord(rows[0].json_ordered)
    )
      throw new CliError(
        `Exact Flow ${uuid}@${version} is unavailable or ambiguous under the current actor.`,
        { code: 'PROCESS_ALLOCATION_WRITE_EVIDENCE_UNRESOLVED', exitCode: 1 },
      );
    const document = rows[0].json_ordered;
    const supplied = (context.flow_documents ?? []).filter((candidate) => {
      const root = record(candidate.flowDataSet);
      return (
        record(record(root.flowInformation).dataSetInformation)['common:UUID'] === uuid &&
        record(record(root.administrativeInformation).publicationAndOwnership)[
          'common:dataSetVersion'
        ] === version
      );
    });
    if (
      supplied.length &&
      (supplied.length !== 1 || sha256Json(supplied[0]) !== sha256Json(document))
    )
      throw new CliError(
        `Exact Flow ${uuid}@${version} changed after local semantic qualification. Refresh its explicit evidence and revalidate.`,
        { code: 'PROCESS_ALLOCATION_WRITE_EVIDENCE_STALE', exitCode: 1 },
      );
    documents.push(document);
  }
  const analysis = analyzeProcessPayloadSemantics(payload, {
    ...context,
    flow_documents: documents,
  });
  if (analysis.status !== 'passed')
    throw new CliError(
      'Process allocation admission requires complete current-user exact Flow evidence.',
      { code: 'PROCESS_ALLOCATION_WRITE_SEMANTICS_BLOCKED', exitCode: 1, details: analysis },
    );
  return analysis;
}
