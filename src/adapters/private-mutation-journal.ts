import { contentDigest as mutationDigest } from '../shared/json-content-digest.js';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withBatchRunLock } from '../lib/batch/run-lock.js';
import { CommandInputError } from '../shared/command-result.js';
import { writeCommandOutput } from '../shared/command-files.js';

import type { MutationJournal } from '../application/operation-ports.js';
/** Private storage and two lock domains only. Callers own replay/acknowledgment policy. */
export async function withMutationJournal<T>(
  options: {
    directory: string;
    requestId: string;
    target: unknown;
    scope: 'dataset' | 'review';
  },
  execute: (journal: MutationJournal) => Promise<T>,
): Promise<T> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const key = mutationDigest(options.requestId);
  const file = path.join(options.directory, `${key}.json`);
  return withBatchRunLock(
    {
      runPath: path.join(options.directory, key),
      reason: `${options.scope}-request`,
      identity: key,
    },
    () =>
      withBatchRunLock(
        {
          runPath: path.join(options.directory, mutationDigest(options.target)),
          reason: `${options.scope}-target`,
          identity: `${options.scope}-target`,
        },
        () =>
          execute({
            path: file,
            read() {
              if (!existsSync(file)) return null;
              const stat = lstatSync(file);
              if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
                throw new CommandInputError(
                  'JOURNAL_UNSAFE',
                  'Recovery journal must be a private regular file.',
                );
              const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new CommandInputError(
                  'OBJECT_REQUIRED',
                  'recovery journal must be a JSON object.',
                );
              return value as Record<string, unknown>;
            },
            write(value, replace = true) {
              writeCommandOutput(file, value, replace);
            },
          }),
      ),
  );
}
