import { contentDigest } from './dataset-content.js';
import {
  type DatasetQuery,
  type DatasetPorts,
  type DatasetType,
  type JsonObject,
} from './dataset-types.js';
import { CommandInputError, result } from '../shared/command-result.js';

export function queryCursor(cursor: string | undefined, binding: unknown): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed.binding !== contentDigest(binding) ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    )
      throw new Error('cursor');
    return parsed.offset;
  } catch {
    throw new CommandInputError(
      'CURSOR_INVALID',
      'Cursor does not match this query. Keep all filters and page size unchanged.',
    );
  }
}
export function nextCursor(offset: number, binding: unknown) {
  return Buffer.from(JSON.stringify({ offset, binding: contentDigest(binding) })).toString(
    'base64url',
  );
}
export const shellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
    const { content, ...subject } = records[0]!;
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
      items: records.map(({ content, ...subject }) =>
        String(binding.fields ?? '')
          .split(',')
          .includes('content')
          ? { ...subject, content }
          : subject,
      ),
    };
    if (value.completeness.nextCursor) {
      const flags = Object.entries(binding)
        .filter(([key, entry]) => !['type', 'action'].includes(key) && entry !== undefined)
        .map(([key, entry]) => `--${key} ${shellArgument(String(entry))}`)
        .join(' ');
      value.nextActions.push({
        description: 'Read the next visible page.',
        command: `tiangong-lca dataset ${type} ${action} ${flags} --cursor ${shellArgument(String(value.completeness.nextCursor))} --json`,
      });
    }
  }
  value.outcome = action === 'get' ? 'dataset_read' : 'datasets_listed';
  value.summary = `${type}: ${records.length} visible record(s) read.`;
  return value;
}
