import { datasetTables, editableTypes, object, text } from '../application/dataset-types.js';
import { listContentReferences, contentDigest } from '../application/dataset-content.js';
import { CommandInputError } from '../shared/command-result.js';
import type { FetchLike } from '../lib/http.js';
import { reviewReader } from './review-read.js';
import { datasetReader } from './dataset-read.js';

export function reviewMaterials(env: NodeJS.ProcessEnv, fetchImpl: FetchLike) {
  return async (id: string) => {
    const page = await reviewReader(env, fetchImpl)({ id, limit: 1, offset: 0 });
    const review = page.records[0];
    if (!review)
      throw new CommandInputError('REVIEW_NOT_FOUND', 'Review is missing or not visible.');
    const data = object(object(review.json, 'review.json').data, 'review.json.data');
    const type = editableTypes.find((candidate) => datasetTables[candidate] === data.table);
    if (!type)
      throw new CommandInputError(
        'REVIEW_TYPE_UNSUPPORTED',
        'Review target type is outside the editable dataset interface.',
      );
    const targetId = text(data.id, 'review target id');
    const version = text(data.version, 'review target version');
    if (version === 'latest')
      throw new CommandInputError(
        'EXACT_VERSION_REQUIRED',
        'Review materials require the recorded exact dataset version.',
      );
    const row = (
      await datasetReader(env, fetchImpl)(type, { id: targetId, version, limit: 1, offset: 0 })
    ).records[0];
    if (!row)
      throw new CommandInputError(
        'REVIEW_MATERIALS_UNAVAILABLE',
        'Current target content is missing or not visible.',
      );
    return {
      review,
      subject: { type, id: targetId, version },
      currentContent: row.content,
      contentDigest: contentDigest(row.content),
      references: listContentReferences(row.content),
      environment: page.environment,
      actor: page.actor,
      scope: 'current_readable_target',
      historicalSnapshot: false,
      consistentSnapshot: false,
    };
  };
}
