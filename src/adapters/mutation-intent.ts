import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { contentDigest } from '../application/dataset-content.js';
import { object } from '../application/dataset-types.js';
import { CommandInputError, type CommandResult } from '../shared/command-result.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { withBatchRunLock } from '../lib/batch/run-lock.js';

export async function runMutationIntent(options: {
  directory: string;
  binding: Record<string, unknown>;
  requestId: string;
  target: string;
  value: CommandResult;
  preflight(): Promise<void>;
  dispatch(): Promise<CommandResult>;
}): Promise<CommandResult> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const key = contentDigest(options.requestId);
  const journal = path.join(options.directory, `${key}.json`);
  const binding = contentDigest(options.binding);
  return withBatchRunLock(
    { runPath: path.join(options.directory, key), reason: 'review-request', identity: key },
    () =>
      withBatchRunLock(
        {
          runPath: path.join(options.directory, contentDigest(options.target)),
          reason: 'review-target',
          identity: 'review-target',
        },
        async () => {
          const unknown = () => {
            options.value.status = 'unknown';
            options.value.outcome = 'write_outcome_unknown';
            options.value.summary =
              'Original request outcome is unknown. No automatic replay is permitted.';
            options.value.data.recovery = {
              requestId: options.requestId,
              journal,
              replayAllowed: false,
            };
            return options.value;
          };
          if (existsSync(journal)) {
            const stat = lstatSync(journal);
            if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
              throw new CommandInputError(
                'JOURNAL_UNSAFE',
                'Recovery journal must be a private regular file.',
              );
            const previous = object(JSON.parse(readFileSync(journal, 'utf8')), 'recovery journal');
            if (previous.binding !== binding)
              throw new CommandInputError(
                'REQUEST_CONFLICT',
                'requestId is already bound to another intent, actor or environment.',
              );
            if (previous.state === 'completed') {
              const original = object(previous.result, 'original result') as CommandResult;
              return {
                ...original,
                outcome: 'original_result_returned',
                summary: `Original result returned without dispatch: ${original.summary}`,
              };
            }
            return unknown();
          }
          await options.preflight();
          writeCommandOutput(
            journal,
            { schemaVersion: 1, binding, intent: options.binding, state: 'dispatched' },
            false,
          );
          try {
            const completed = await options.dispatch();
            writeCommandOutput(
              journal,
              {
                schemaVersion: 1,
                binding,
                intent: options.binding,
                state: 'completed',
                result: completed,
              },
              true,
            );
            return completed;
          } catch {
            return unknown();
          }
        },
      ),
  );
}
