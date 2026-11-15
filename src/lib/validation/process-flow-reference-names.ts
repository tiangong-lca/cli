// data-api-relations: flows
import { analyzeProcessFlowReferences, type ExactFlowNameEvidence } from '@tiangong-lca/tidas-sdk';
import { CliError } from '../../shared/errors.js';
import { isRecord } from '../dataset/json.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import type { FetchLike } from '../transport/http.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
  type SupabaseDataRuntime,
} from '../transport/supabase-client.js';
import { createSupabaseDataRuntime } from '../auth/supabase-session.js';
import { normalizeIssuePath } from './tidas-sdk-validation.js';

type Json = Record<string, unknown>;

export type FlowNameReadContext = {
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
};

export function flowNameReadContext(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): FlowNameReadContext {
  const timeoutMs = 10_000;
  return {
    runtime: createSupabaseDataRuntime({
      runtime: requireSupabaseRestRuntime(env),
      fetchImpl,
      timeoutMs,
    }),
    fetchImpl,
    timeoutMs,
  };
}

const object = (value: unknown): Json => (isRecord(value) ? value : {});
const key = (uuid: string, version: string) => JSON.stringify([uuid, version]);

export function suppliedFlowNameEvidence(documents: readonly Json[]): ExactFlowNameEvidence[] {
  return documents.flatMap((document) => {
    const root = object(document.flowDataSet);
    const uuid = object(object(root.flowInformation).dataSetInformation)['common:UUID'];
    const version = object(object(root.administrativeInformation).publicationAndOwnership)[
      'common:dataSetVersion'
    ];
    return typeof uuid === 'string' && typeof version === 'string'
      ? [{ uuid, version, document }]
      : [];
  });
}

/** Merge reference documents by content, retaining conflicts for the validator. */
export function distinctReferenceDocuments(documents: readonly Json[]): Json[] {
  return [...new Map(documents.map((document) => [sha256Json(document), document])).values()];
}

/** Bind the report to the exact candidate bytes and the evidence used for comparison. */
export function processFlowNameReport(payload: Json, flows: readonly ExactFlowNameEvidence[]) {
  const result = analyzeProcessFlowReferences(payload, { flows });
  const keys = new Set(result.coverage.map(({ uuid, version }) => key(uuid, version)));
  return {
    profile: result.profile,
    complete: result.complete,
    status: result.coverage.some(({ status }) => status === 'invalid')
      ? ('failed' as const)
      : result.complete
        ? ('passed' as const)
        : ('unresolved' as const),
    coverage_count: result.coverage.length,
    issue_count: result.validationIssues.length,
    coverage: result.coverage,
    issues: result.validationIssues.map((issue) => ({
      ...issue,
      path: normalizeIssuePath(issue.path),
    })),
    candidate_sha256: sha256Json(payload),
    dependencies: flows
      .filter(({ uuid, version }) => keys.has(key(uuid, version)))
      .map(({ uuid, version, document }) => ({
        uuid,
        version,
        content_sha256: sha256Json(document),
      })),
  };
}

export class ProcessFlowNameAdmissionError extends CliError {
  constructor(
    readonly report: ReturnType<typeof processFlowNameReport>,
    candidateIndex: number,
  ) {
    super(
      `Process exchange Flow name check ${report.status} at ${report.issues[0].path}. Supply a readable exact Flow version or correct the description.`,
      { code: 'PROCESS_FLOW_NAME_ADMISSION_BLOCKED', details: { candidateIndex, ...report } },
    );
  }
}

/** Each candidate occurrence is checked; the current actor reads each exact identity once. */
export async function readExactFlowNameEvidence(
  candidates: readonly Json[],
  context: FlowNameReadContext,
): Promise<ExactFlowNameEvidence[]> {
  const exact = new Map<string, ExactFlowNameEvidence>();
  for (const candidate of candidates) {
    const unchecked = analyzeProcessFlowReferences(candidate);
    for (const { status, uuid, version } of unchecked.coverage) {
      if (status === 'unresolved') exact.set(key(uuid, version), { uuid, version, document: null });
    }
  }
  if (exact.size === 0) return [];

  const { client, restBaseUrl } = createSupabaseDataClient(
    context.runtime,
    context.fetchImpl,
    context.timeoutMs,
  );
  const requests = [...exact.values()];
  const evidence: ExactFlowNameEvidence[] = [];
  const concurrency = 20;
  for (let offset = 0; offset < requests.length; offset += concurrency) {
    const results = await Promise.all(
      requests.slice(offset, offset + concurrency).map(async (binding) => {
        const { uuid, version } = binding;
        const rows = await runSupabaseArrayQuery<Json>(
          client
            .from('flows')
            .select('id,version,json_ordered')
            .eq('id', uuid)
            .eq('version', version)
            .limit(2),
          `${restBaseUrl}/flows`,
        ).catch(() => {
          throw new CliError(
            `Could not read the selected Flow ${uuid}@${version}. Verify access, then retry validation.`,
            {
              code: 'PROCESS_FLOW_NAME_EVIDENCE_LOOKUP_FAILED',
              details: { uuid, version },
            },
          );
        });
        if (!rows.length) return [];
        const row = rows[0];
        return [
          {
            uuid,
            version,
            document:
              rows.length === 1 && isRecord(row) && row.id === uuid && row.version === version
                ? (row.json_ordered ?? null)
                : null,
          },
        ];
      }),
    );
    evidence.push(...results.flat());
  }
  return evidence;
}

/** Supplied documents can demonstrate drift, but only readable exact documents grant coverage. */
export function bindCurrentFlowNameEvidence(
  remote: readonly ExactFlowNameEvidence[],
  supplied: readonly ExactFlowNameEvidence[],
): ExactFlowNameEvidence[] {
  const available = new Set(remote.map(({ uuid, version }) => key(uuid, version)));
  return [...remote, ...supplied.filter(({ uuid, version }) => available.has(key(uuid, version)))];
}

export async function assertProcessFlowNameWriteAdmission(
  candidates: readonly Json[],
  context: FlowNameReadContext,
  supplied: readonly ExactFlowNameEvidence[] = [],
): Promise<ExactFlowNameEvidence[]> {
  const remote = await readExactFlowNameEvidence(candidates, context);
  const flows = bindCurrentFlowNameEvidence(remote, supplied);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const report = processFlowNameReport(candidate, flows);
    if (report.status !== 'passed') throw new ProcessFlowNameAdmissionError(report, candidateIndex);
  }
  return remote;
}

/** For a newly generated Process, write only canonical descriptions with exact evidence. */
export function populateGeneratedProcessFlowNames(
  payload: Json,
  flows: readonly ExactFlowNameEvidence[],
) {
  const result = analyzeProcessFlowReferences(payload, { flows });
  for (const { path, expectedDescription } of result.coverage) {
    if (!expectedDescription) continue;
    // Paths are derived from this in-memory candidate by the SDK.
    const reference = path.reduce<unknown>(
      (record, segment) => (record as Record<string | number, unknown>)[segment],
      payload,
    );
    (reference as Json)['common:shortDescription'] = structuredClone(expectedDescription);
  }
}
