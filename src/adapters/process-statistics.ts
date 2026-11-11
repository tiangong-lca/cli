import { statisticsSelection, groupProcessRows } from '../application/process-statistics.js';
import {
  type JsonObject,
  type DatasetPorts,
  type DatasetRecord,
} from '../application/dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';
import { datasetReader } from './dataset-read.js';
import { resolveDatasetCommandTransport } from '../lib/dataset/command.js';
import { fetchCurrentUser } from '../lib/auth/auth-identity-receipt.js';
import { calculateStatistics as summarizeObservedProcesses } from '../lib/process-statistics/summary.js';
import type { FetchLike } from '../lib/transport/http.js';

export async function processStatistics(
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  read: DatasetPorts['read'] = datasetReader(env, fetchImpl),
) {
  const selection = statisticsSelection(request);
  let owner = selection.owner;
  let actor: string | null = null;
  if (selection.scope === 'current-user') {
    const transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 10_000 });
    const user = await fetchCurrentUser({
      projectBaseUrl: new URL(transport.functionsBaseUrl).origin,
      publishableKey: transport.publishableKey,
      accessToken: transport.accessToken,
      timeoutMs: 10_000,
      fetchImpl,
    });
    actor = user.userId;
    if (owner !== undefined && owner !== actor)
      throw new CommandInputError(
        'OWNER_CONFLICT',
        'current-user scope cannot select another owner.',
      );
    owner = actor;
  }
  const rows: DatasetRecord[] = [];
  const seen = new Set<string>();
  const reasons = new Set<string>();
  let environment: string | null = null;
  let total: number | null = 0;
  const states = selection.stateCodes ?? [undefined];
  scan: for (const [index, state] of states.entries()) {
    let offset = 0;
    let expected: number | null | undefined;
    while (rows.length < selection.maxRows) {
      const limit = Math.min(100, selection.maxRows - rows.length);
      const page = await read('process', { owner, state, limit, offset });
      environment = page.environment;
      if (expected === undefined) {
        expected = page.total;
        total = total === null || expected === null ? null : total + expected;
      } else if (page.total !== expected) reasons.add('remote_count_changed');
      if (
        page.records.length > limit ||
        page.records.some(
          (row) =>
            row.type !== 'process' ||
            (owner !== undefined && row.owner !== owner) ||
            (state !== undefined && row.stateCode !== state),
        )
      )
        throw new CommandInputError(
          'STATISTICS_RESPONSE_INVALID',
          'Statistics rows do not match the selected scope.',
        );
      for (const row of page.records) {
        const identity = `${row.id}@${row.version}`;
        if (seen.has(identity)) {
          reasons.add('repeated_identity_during_scan');
          break scan;
        }
        seen.add(identity);
        rows.push(row);
      }
      offset += page.records.length;
      if (!page.records.length || (expected !== null && offset >= expected)) {
        if (expected !== null && offset !== expected) reasons.add('reported_count_mismatch');
        break;
      }
      if (rows.length === selection.maxRows) {
        reasons.add('scan_limit_reached');
        break scan;
      }
    }
    if (rows.length === selection.maxRows && index < states.length - 1) {
      reasons.add('scan_limit_reached');
      break;
    }
  }
  // Reuse the retained deterministic summaries on the exact observed rows, without its old remote scan policy.
  const observed = rows.map((row) => ({
    id: row.id,
    version: row.version,
    state_code: row.stateCode,
    user_id: row.owner,
    modified_at: row.modifiedAt,
    model_id: null,
    json: row.content,
  }));
  const generatedAt = new Date().toISOString();
  const observedSummary = summarizeObservedProcesses(
    observed,
    { scope: selection.scope, stateCodes: selection.stateCodes ?? [] },
    {
      userId: actor,
      maskedUserEmail: null,
      totalRowsReportedByRemote: reasons.size ? null : total,
    },
    generatedAt,
  );
  const summary = { ...observedSummary.summary, state_codes: selection.stateCodes ?? null };
  const groups = groupProcessRows(rows, selection.groupBy);
  return {
    total_process_rows: rows.length,
    domain_count_primary: summary.domain_count_primary,
    domain_count_leaf: summary.domain_count_leaf,
    craft_count: summary.craft_count,
    unit_process_rows: summary.unit_process_rows,
    product_count: summary.product_count,
    state_codes: selection.stateCodes ?? null,
    status: reasons.size ? 'partial' : 'completed',
    summary,
    groups,
    selection: { ...selection, owner: owner ?? null, stateCodes: selection.stateCodes ?? null },
    context: {
      environment,
      actor: actor ? { id: actor, source: 'online' } : { status: 'not_independently_verified' },
      observation: { source: 'visible_process_scan', time: generatedAt },
      effectiveInput: selection,
      defaultedInputs: {
        ...(request.scope === undefined ? { scope: 'visible' } : {}),
        ...(request.groupBy === undefined ? { groupBy: ['state'] } : {}),
        ...(request.maxRows === undefined ? { maxRows: 10_000 } : {}),
      },
    },
    completeness: {
      scope: 'selected_visible_process_rows',
      scanned: rows.length,
      total: reasons.size ? null : total,
      partial: reasons.size > 0,
      reasons: [...reasons],
      snapshot: false,
      hasMore: reasons.size > 0,
    },
  };
}
