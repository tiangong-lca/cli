import type { CommandResult } from '../shared/command-result.js';
import { isObject, type JsonObject } from '../application/dataset-types.js';

export function datasetMutationContinuation(value: CommandResult): void {
  if (value.status !== 'unknown' && !['dataset_written', 'dataset_deleted'].includes(value.outcome))
    return;
  if (value.outcome === 'dataset_deleted') {
    value.nextActions = [
      {
        description:
          'Deletion is acknowledged and exact target absence has already been independently verified.',
      },
    ];
    return;
  }
  const subject = value.data.subject;
  if (!isObject(subject)) return;
  value.nextActions = [
    {
      description:
        value.status === 'unknown'
          ? 'Read the exact target and reconcile the original request; do not generate a new request to hide an unknown result.'
          : 'Read the saved dataset.',
      command: `tiangong-lca dataset ${subject.type} get --id ${subject.id} --version ${subject.version} --json`,
    },
  ];
}

export function reviewMutationContinuation(value: CommandResult, request: JsonObject): void {
  const reviewId = value.data.reviewId;
  const submitting = value.operation === 'review submit' || value.operation === 'review resubmit';
  value.nextActions = [
    {
      description: reviewId
        ? 'Read the accepted review.'
        : 'Read the actual current review record; acceptance is not approval.',
      command: reviewId
        ? `tiangong-lca review get --id ${reviewId} --json`
        : submitting
          ? 'tiangong-lca review list --role submitter --json'
          : `tiangong-lca review get --id ${request.reviewId} --json`,
    },
  ];
}
