import { object, text, isObject, type DatasetRecord, type JsonObject } from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export function statisticsSelection(request: JsonObject) {
  if (
    Object.keys(request).some(
      (key) => !['scope', 'owner', 'stateCodes', 'groupBy', 'maxRows'].includes(key),
    )
  )
    throw new CommandInputError(
      'REQUEST_FIELD_UNSUPPORTED',
      'Unsupported statistics selection field.',
    );
  const scope = request.scope ?? 'visible';
  if (scope !== 'visible' && scope !== 'current-user')
    throw new CommandInputError('SCOPE_INVALID', 'scope must be visible or current-user.');
  const owner = request.owner === undefined ? undefined : text(request.owner, 'owner');
  const stateCodes = request.stateCodes;
  if (
    stateCodes !== undefined &&
    (!Array.isArray(stateCodes) ||
      !stateCodes.length ||
      stateCodes.some((state) => !Number.isSafeInteger(state)) ||
      new Set(stateCodes).size !== stateCodes.length)
  )
    throw new CommandInputError(
      'STATE_INVALID',
      'stateCodes must contain distinct integer states.',
    );
  const groupBy = request.groupBy ?? ['state'];
  if (
    !Array.isArray(groupBy) ||
    !groupBy.length ||
    new Set(groupBy).size !== groupBy.length ||
    groupBy.some(
      (group) => typeof group !== 'string' || !['state', 'classification'].includes(group),
    )
  )
    throw new CommandInputError(
      'GROUP_BY_INVALID',
      'groupBy must contain distinct state/classification dimensions.',
    );
  const maxRows = request.maxRows ?? 10_000;
  if (!Number.isSafeInteger(maxRows) || Number(maxRows) < 1 || Number(maxRows) > 100_000)
    throw new CommandInputError(
      'SCAN_LIMIT_INVALID',
      'maxRows must be an integer from 1 to 100000.',
    );
  return {
    scope: scope as 'visible' | 'current-user',
    owner,
    stateCodes: stateCodes as number[] | undefined,
    groupBy: groupBy as string[],
    maxRows: Number(maxRows),
  };
}

export function groupProcessRows(rows: DatasetRecord[], dimensions: string[]): JsonObject[] {
  const grouped = new Map<string, JsonObject>();
  for (const row of rows) {
    const group: JsonObject = {};
    if (dimensions.includes('state')) group.state = row.stateCode;
    if (dimensions.includes('classification')) {
      const root = object(row.content.processDataSet, 'processDataSet');
      const info = isObject(root.processInformation) ? root.processInformation : {};
      const data = isObject(info.dataSetInformation) ? info.dataSetInformation : {};
      const classification = isObject(data.classificationInformation)
        ? data.classificationInformation
        : {};
      const common = isObject(classification['common:classification'])
        ? classification['common:classification']
        : {};
      const classes = common['common:class'];
      const entries = Array.isArray(classes) ? classes : isObject(classes) ? [classes] : [];
      // Use declared identifiers and levels, never infer categories from a display name.
      group.classification = entries.length
        ? entries.map((entry) =>
            isObject(entry)
              ? {
                  level: entry['@level'] ?? null,
                  code: entry['@classId'] ?? null,
                }
              : { level: null, code: null },
          )
        : null;
    }
    const key = JSON.stringify(group);
    const previous = grouped.get(key);
    grouped.set(key, { ...group, count: Number(previous?.count ?? 0) + 1 });
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
