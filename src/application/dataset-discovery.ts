import { contentDigest } from './dataset-content.js';
import { CommandInputError } from '../shared/command-result.js';

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
