import {
  type DatasetQuery,
  type DatasetPorts,
  type DatasetType,
  type JsonObject,
} from '../application/dataset-types.js';
import { result } from '../shared/command-result.js';
import { nextCursor } from '../application/dataset-discovery.js';

export async function discoverDatasets(
  type: DatasetType,
  action: 'get' | 'list' | 'versions',
  query: DatasetQuery,
  binding: JsonObject,
  ports: DatasetPorts,
) {
  const value = result(`dataset ${type} ${action}`);
  const page = await ports.read(type, query);
  const records = page.records;
  if (
    records.length > query.limit ||
    records.some(
      (row) =>
        row.type !== type ||
        (query.id && row.id !== query.id) ||
        (query.version && query.version !== 'latest' && row.version !== query.version),
    )
  )
    throw new Error('Invalid query response identity or page size');
  value.context = {
    environment: page.environment,
    actor: { status: 'not_independently_verified' },
    observation: { source: 'remote', time: ports.now() },
    effectiveInput: binding,
    defaultedInputs: {},
  };
  const more = page.total === null ? null : query.offset + records.length < page.total;
  value.completeness = {
    scope: 'current_visible_query',
    returned: records.length,
    total: page.total,
    hasMore: more,
    nextCursor: more && records.length ? nextCursor(query.offset + records.length, binding) : null,
    truncated: more === null,
    snapshot: false,
  };
  if (action === 'get') {
    if (!records.length) {
      value.status = 'failed';
      value.outcome = 'not_found_or_not_visible';
      value.summary = 'Requested dataset version was not found or is not visible.';
      value.error = {
        category: 'not_found_or_not_visible',
        code: 'DATASET_NOT_FOUND',
        message: value.summary,
      };
      return value;
    }
    const { content, modelGraph: _graph, ...subject } = records[0]!;
    value.data = { subject, content };
    value.context.subjects = [subject];
    value.completeness = {
      scope: 'one_dataset_version',
      returned: 1,
      hasMore: false,
      nextCursor: null,
      truncated: false,
    };
  } else {
    value.data = {
      items: records.map(({ content, modelGraph: _graph, ...subject }) =>
        String(binding.fields ?? '')
          .split(',')
          .includes('content')
          ? { ...subject, content }
          : subject,
      ),
    };
  }
  value.outcome = action === 'get' ? 'dataset_read' : 'datasets_listed';
  value.summary = `${type}: ${records.length} visible record(s) read.`;
  return value;
}
