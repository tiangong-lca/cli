import { createHash } from 'node:crypto';

/** Hash the supplied JSON order; canonical sorted JSON and artifact bytes are separate contracts. */
export const contentDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
