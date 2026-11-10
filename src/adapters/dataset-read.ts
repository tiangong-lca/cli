// data-api-relations: contacts, flowproperties, flows, lifecyclemodels, processes, sources, unitgroups
// data-api-dynamic-relation-expression: datasetTables[type]
import {
  datasetTables,
  datasetWrappers,
  isObject,
  type DatasetType,
  type DatasetQuery,
  type DatasetPage,
} from '../application/dataset-types.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
} from '../lib/transport/supabase-client.js';
import { createSupabaseDataRuntime } from '../lib/auth/supabase-session.js';
import type { FetchLike } from '../lib/transport/http.js';
import { normalizeSupabaseProcessPayload } from '../lib/transport/supabase-rest.js';
import { CliError } from '../shared/errors.js';

export function datasetReader(env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  return async (type: DatasetType, input: DatasetQuery): Promise<DatasetPage> => {
    const runtime = createSupabaseDataRuntime({
      runtime: requireSupabaseRestRuntime(env),
      fetchImpl,
      timeoutMs: 10_000,
    });
    const { client, restBaseUrl } = createSupabaseDataClient(runtime, fetchImpl, 10_000);
    let query = client
      .from(datasetTables[type])
      .select(
        `id,version,user_id,state_code,modified_at,json${type === 'model' ? ',json_tg' : ''}`,
        { count: 'exact' },
      );
    if (input.id) query = query.eq('id', input.id);
    if (input.version && input.version !== 'latest') query = query.eq('version', input.version);
    if (input.owner) query = query.eq('user_id', input.owner);
    if (input.state !== undefined) query = query.eq('state_code', input.state);
    query =
      input.version === 'latest'
        ? query.order('version', { ascending: false })
        : query.order('id').order('version');
    const response = await query.range(input.offset, input.offset + input.limit - 1);
    if (response.error)
      throw new CliError('Dataset read failed.', { code: 'DATASET_READ_FAILED', exitCode: 1 });
    if (
      !Array.isArray(response.data) ||
      response.data.length > input.limit ||
      (response.count !== null && (!Number.isSafeInteger(response.count) || response.count < 0))
    )
      throw new CliError('Dataset response was not an array.', {
        code: 'DATASET_RESPONSE_INVALID',
        exitCode: 1,
      });
    const records = response.data.map((row: unknown) => {
      if (
        !isObject(row) ||
        typeof row.id !== 'string' ||
        !row.id ||
        typeof row.version !== 'string' ||
        !row.version ||
        (input.id !== undefined && row.id !== input.id) ||
        (input.version !== undefined && input.version !== 'latest' && row.version !== input.version)
      )
        throw new CliError('Dataset response has invalid identity.', {
          code: 'DATASET_RESPONSE_INVALID',
          exitCode: 1,
        });
      const content = normalizeSupabaseProcessPayload(row.json, `${row.id}@${row.version}`);
      if (!isObject(content[datasetWrappers[type]]))
        throw new CliError('Dataset response has an unexpected content type.', {
          code: 'DATASET_RESPONSE_INVALID',
          exitCode: 1,
        });
      return {
        type,
        id: row.id,
        version: row.version,
        modifiedAt: typeof row.modified_at === 'string' ? row.modified_at : null,
        stateCode: typeof row.state_code === 'number' ? row.state_code : null,
        owner: typeof row.user_id === 'string' ? row.user_id : null,
        content,
        ...(type === 'model' && isObject(row.json_tg) ? { modelGraph: row.json_tg } : {}),
      };
    });
    return { records, total: response.count, environment: new URL(restBaseUrl).origin };
  };
}
