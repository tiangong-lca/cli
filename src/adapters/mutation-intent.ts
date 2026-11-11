import { contentDigest } from '../application/dataset-content.js';
import { object } from '../application/dataset-types.js';
import type { ReviewMutationIntent } from '../application/review-write.js';
import { CommandInputError, type CommandResult } from '../shared/command-result.js';
import { withMutationJournal } from './private-mutation-journal.js';

export async function runMutationIntent(
  options: ReviewMutationIntent & { directory: string },
): Promise<CommandResult> {
  const binding = contentDigest(options.binding);
  return withMutationJournal(
    {
      directory: options.directory,
      requestId: options.requestId,
      target: options.target,
      scope: 'review',
    },
    async (store) => {
      const journal = store.path;
      const unknown = () => {
        options.value.status = 'unknown';
        options.value.error = {
          category: 'service',
          code: 'WRITE_OUTCOME_UNKNOWN',
          message: 'The original mutation outcome could not be established. Do not replay.',
        };
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
      const previous = store.read();
      if (previous) {
        if (previous.binding !== binding)
          throw new CommandInputError(
            'REQUEST_CONFLICT',
            'requestId is already bound to another intent, actor or environment.',
          );
        if (previous.state === 'completed' || previous.state === 'rejected') {
          const original = object(previous.result, 'original result') as CommandResult;
          return {
            ...original,
            outcome:
              previous.state === 'rejected' ? 'service_rejected' : 'original_result_returned',
            summary: `Original result returned without dispatch: ${original.summary}`,
          };
        }
        return unknown();
      }
      await options.preflight();
      store.write(
        { schemaVersion: 1, binding, intent: options.binding, state: 'dispatched' },
        false,
      );
      try {
        const completed = await options.dispatch();
        try {
          store.write(
            {
              schemaVersion: 1,
              binding,
              intent: options.binding,
              state: completed.outcome === 'service_rejected' ? 'rejected' : 'completed',
              result: completed,
            },
            true,
          );
        } catch (error) {
          if (completed.outcome !== 'service_rejected') throw error;
          completed.warnings.push({
            code: 'JOURNAL_UPDATE_UNAVAILABLE',
            message:
              'The refusal was observed, but its durable result could not be saved. The original request remains non-replayable.',
          });
        }
        return completed;
      } catch {
        return unknown();
      }
    },
  );
}
