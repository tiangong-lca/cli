import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { object, type JsonObject } from '../application/dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export function readLocalCalculation(directory: string, kind: string): JsonObject {
  const root = path.resolve(directory);
  const read = (name: string): { content: JsonObject; bytes: Buffer } => {
    const file = path.join(root, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('invalid');
      const bytes = readFileSync(file);
      return { content: object(JSON.parse(bytes.toString('utf8')), name), bytes };
    } catch {
      throw new CommandInputError(
        'CALCULATION_ARTIFACT_UNAVAILABLE',
        `Cannot read complete ${name} in ${root}. Check the selected Run directory; this command never recalculates.`,
        'precondition',
      );
    }
  };
  const { content: summary } = read('summary.json');
  if (
    summary.schemaVersion !== 1 ||
    summary.status !== 'completed' ||
    summary.profile !== 'lca.model-local.v1'
  )
    throw new CommandInputError(
      'CALCULATION_RUN_UNSUPPORTED',
      'This directory is not a completed local Model Run.',
      'precondition',
    );
  if (kind === 'summary')
    return {
      ...summary,
      execution: 'local',
      outputDirectory: root,
      files: Object.fromEntries(
        ['input', 'prepared', 'result', 'summary'].map((v) => [v, path.join(root, `${v}.json`)]),
      ),
    };
  const { content: prepared, bytes: preparedBytes } = read('prepared.json');
  const { content: result } = read('result.json');
  if (
    prepared.profileId !== summary.profile ||
    result.profileId !== summary.profile ||
    typeof prepared.modelHash !== 'string' ||
    prepared.modelHash !== result.modelHash ||
    result.preparedArtifactSha256 !== createHash('sha256').update(preparedBytes).digest('hex')
  )
    throw new CommandInputError(
      'CALCULATION_ARTIFACT_MISMATCH',
      'Prepared axes and result do not belong to the same calculation.',
      'precondition',
    );
  const numeric = object(prepared.numeric, 'numerical axes');
  const axes =
    kind === 'lci' ? numeric.inventoryAxes : kind === 'lcia' ? numeric.methodAxes : numeric.views;
  const values = kind === 'lci' ? result.g : kind === 'lcia' ? result.h : result.x;
  if (
    !Array.isArray(axes) ||
    !Array.isArray(values) ||
    axes.length !== values.length ||
    values.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    throw new CommandInputError(
      'CALCULATION_RESULT_INVALID',
      'Result amounts and numerical axes are inconsistent.',
      'precondition',
    );
  return {
    execution: 'local',
    outputDirectory: root,
    kind,
    count: values.length,
    items: axes.map((axis, index) => ({ ...object(axis, 'axis'), amount: values[index] })),
    maxResidual: result.maxResidual,
    engine: summary.engine,
    engineVersion: summary.engineVersion,
  };
}
