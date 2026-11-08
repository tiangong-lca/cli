import { readFileSync } from 'node:fs';
import path from 'node:path';
import { requireContent, object, text, type JsonObject } from '../application/dataset-types.js';
import { datasetReader } from './dataset-read.js';
import { CommandInputError } from '../shared/command-result.js';
import type { FetchLike } from '../lib/http.js';

export function resolveRequestFile(file: unknown, inputPath: string): string {
  const value = text(file, 'file reference');
  if (inputPath === '-' && !path.isAbsolute(value))
    throw new CommandInputError(
      'PATH_ABSOLUTE_REQUIRED',
      'Stdin file references must be absolute.',
    );
  return path.resolve(path.dirname(path.resolve(inputPath)), value);
}
export async function loadModelInput(
  request: JsonObject,
  inputPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  if (
    [request.content, request.file, request.remote].filter((value) => value !== undefined)
      .length !== 1
  )
    throw new CommandInputError(
      'MODEL_INPUT_AMBIGUOUS',
      'Choose exactly one Model content, file or explicit remote identity.',
    );
  if (request.content !== undefined)
    return {
      content: requireContent('model', request.content),
      sourceContext: { observationSource: 'local_content' },
    };
  if (request.file !== undefined)
    return {
      content: requireContent(
        'model',
        JSON.parse(readFileSync(resolveRequestFile(request.file, inputPath), 'utf8')),
      ),
      sourceContext: { observationSource: 'local_file' },
    };
  const remote = object(request.remote, 'remote');
  const id = text(remote.id, 'remote.id');
  const version = text(remote.version, 'remote.version');
  if (version === 'latest')
    throw new CommandInputError(
      'EXACT_VERSION_REQUIRED',
      'Model operations require an exact version.',
    );
  const response = await datasetReader(env, fetchImpl)('model', {
    id,
    version,
    limit: 1,
    offset: 0,
  });
  const selected = response.records[0];
  if (!selected)
    throw new CommandInputError(
      'MODEL_NOT_FOUND',
      'Exact Model identity not found or not visible.',
    );
  return {
    content: selected.content,
    sourceContext: {
      environment: response.environment,
      subjects: [{ type: 'model', id, version }],
      observationSource: 'remote_exact_input',
    },
  };
}
