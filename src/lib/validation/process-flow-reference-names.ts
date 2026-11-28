// data-api-relations: flows
import { analyzeProcessFlowReferences, type ExactFlowNameEvidence } from '@tiangong-lca/tidas-sdk';
import { CliError } from '../../shared/errors.js';
import { isRecord } from '../dataset/json.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import type { FetchLike } from '../transport/http.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
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

type FlowNameLookupFailure = {
  uuid: string;
  version: string;
  stage: 'exact_flow_name_read';
  occurrences: Array<{ candidateIndex: number; path: string }>;
  httpStatus?: number;
  serviceCode?: string;
};

export class ProcessFlowNameLookupError extends CliError {
  readonly validation: Json;

  constructor(
    failures: readonly FlowNameLookupFailure[],
    candidates: readonly Json[],
    evidence: readonly ExactFlowNameEvidence[],
    supplied: readonly ExactFlowNameEvidence[],
  ) {
    const first = failures[0]!;
    super(
      `Could not read the selected Flow ${first.uuid}@${first.version} for exchange name verification.`,
      { code: 'PROCESS_FLOW_NAME_EVIDENCE_LOOKUP_FAILED', details: { lookup_failures: failures } },
    );
    const bound = bindCurrentFlowNameEvidence(evidence, supplied);
    const failed = new Set(failures.map(({ uuid, version }) => key(uuid, version)));
    const reports = candidates.map((candidate) => {
      const report = processFlowNameReport(candidate, bound);
      return {
        ...report,
        issues: report.issues.map((issue) =>
          failed.has(key(String(issue.params?.uuid), String(issue.params?.version)))
            ? {
                ...issue,
                code: 'flow_reference_evidence_lookup_failed',
                message: 'The exact Flow name evidence request failed.',
              }
            : issue,
        ),
      };
    });
    this.validation = {
      status: 'failed',
      lookup_failures: failures,
      flow_reference_names: reports[0],
      ...(reports.length > 1 ? { candidate_flow_reference_names: reports } : {}),
      ...(supplied.length
        ? {
            local_flow_reference_names: candidates.map((candidate) =>
              processFlowNameReport(candidate, supplied),
            ),
          }
        : {}),
    };
  }
}

/** Each candidate occurrence is checked; the current actor reads each exact identity once. */
export async function readExactFlowNameEvidence(
  candidates: readonly Json[],
  context: FlowNameReadContext,
  supplied: readonly ExactFlowNameEvidence[] = [],
): Promise<ExactFlowNameEvidence[]> {
  const exact = new Map<string, Pick<FlowNameLookupFailure, 'uuid' | 'version' | 'occurrences'>>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const unchecked = analyzeProcessFlowReferences(candidate);
    for (const { status, uuid, version, path } of unchecked.coverage) {
      if (status !== 'unresolved') continue;
      const identity = key(uuid, version);
      const binding = exact.get(identity) ?? { uuid, version, occurrences: [] };
      binding.occurrences.push({ candidateIndex, path: normalizeIssuePath(path) });
      exact.set(identity, binding);
    }
  }
  if (exact.size === 0) return [];

  const { client } = createSupabaseDataClient(
    context.runtime,
    context.fetchImpl,
    context.timeoutMs,
  );
  const requests = [...exact.values()];
  const evidence: ExactFlowNameEvidence[] = [];
  const failures: FlowNameLookupFailure[] = [];
  const concurrency = 20;
  for (let offset = 0; offset < requests.length; offset += concurrency) {
    const results = await Promise.all(
      requests.slice(offset, offset + concurrency).map(async (binding) => {
        const { uuid, version } = binding;
        const response = await client
          .from('flows')
          .select('id,version,json_ordered')
          .eq('id', uuid)
          .eq('version', version)
          .limit(2);
        const rows = response.data;
        if (response.error || !Array.isArray(rows)) {
          const serviceCode = response.error?.code ?? '';
          const failure: FlowNameLookupFailure = {
            ...binding,
            stage: 'exact_flow_name_read',
            ...(response.status > 0 ? { httpStatus: response.status } : {}),
            ...(/^(?:[0-9A-Z]{2}[0-9]{3}|PGRST[0-9]{3})$/u.test(serviceCode)
              ? { serviceCode }
              : {}),
          };
          return { failure };
        }
        if (!rows.length) return {};
        const row = rows[0];
        return {
          document: {
            uuid,
            version,
            document:
              rows.length === 1 && isRecord(row) && row.id === uuid && row.version === version
                ? (row.json_ordered ?? null)
                : null,
          },
        };
      }),
    );
    for (const result of results) {
      if (result.failure) failures.push(result.failure);
      if (result.document) evidence.push(result.document);
    }
  }
  if (failures.length)
    throw new ProcessFlowNameLookupError(failures, candidates, evidence, supplied);
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
  const remote = await readExactFlowNameEvidence(candidates, context, supplied);
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
