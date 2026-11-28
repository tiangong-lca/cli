import { runLockCommandError } from '../lib/locks/command-error.js';
import { contentDigest as mutationDigest } from '../shared/json-content-digest.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import { withBatchRunLock } from '../lib/locks/run-lock.js';
import { CommandInputError } from '../shared/command-result.js';
import { writeCommandOutput } from '../shared/command-files.js';

import type { MutationJournal } from '../application/operation-ports.js';

export function isPrivateJournalFile(
  stat: Pick<Stats, 'isFile' | 'mode'>,
  platform: NodeJS.Platform,
): boolean {
  return stat.isFile() && (platform === 'win32' || (stat.mode & 0o077) === 0);
}

function readJournal(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  if (!isPrivateJournalFile(lstatSync(file), process.platform))
    throw new CommandInputError(
      'JOURNAL_UNSAFE',
      'Recovery journal must be a private regular file.',
    );
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommandInputError('OBJECT_REQUIRED', 'recovery journal must be a JSON object.');
  return value as Record<string, unknown>;
}

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
  try {
    return await withBatchRunLock(
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
                return readJournal(file);
              },
              write(value, replace = true) {
                writeCommandOutput(file, value, replace);
              },
              findTargetRecord(states) {
                // Journal records are the durable target index, including legacy records.
                // This scan and the next dispatch share the exact-target lock.
                const target = options.target as Record<string, unknown>;
                for (const name of readdirSync(options.directory).sort()) {
                  const candidate = path.join(options.directory, name);
                  if (!/^[a-f0-9]{64}\.json$/u.test(name) || candidate === file) continue;
                  let record: Record<string, unknown> | null;
                  try {
                    record = readJournal(candidate);
                  } catch {
                    continue;
                  }
                  if (
                    record &&
                    states.includes(record.state as string) &&
                    Object.entries(target).every(([field, value]) => record[field] === value)
                  )
                    return { path: candidate, record };
                }
                return null;
              },
            }),
        ),
    );
  } catch (error) {
    throw runLockCommandError(error);
  }
}
