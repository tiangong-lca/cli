export type DatasetNameIssue = { path: string; message: string; code: string };

const NAME_LOCATIONS = [
  ['flow', 'flowDataSet', 'flowInformation', 'flowProperties'],
  ['process', 'processDataSet', 'processInformation', 'functionalUnitFlowProperties'],
  [
    'lifecyclemodel',
    'lifeCycleModelDataSet',
    'lifeCycleModelInformation',
    'functionalUnitFlowProperties',
  ],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Name segments reserve both semicolons for display composition, in every language.
 * Only the four name fields are inspected; synonyms and other prose keep their punctuation.
 * Missing/malformed structure and language validity remain the schema's responsibility.
 */
export function collectDatasetNameIssues(payload: unknown, kind: string): DatasetNameIssue[] {
  const location = NAME_LOCATIONS.find(([type]) => type === kind);
  if (!location || !isRecord(payload)) return [];
  const [, rootKey, informationKey, fourthField] = location;
  const candidate = payload[rootKey];
  const wrapped = isRecord(candidate);
  const root = wrapped ? candidate : payload;
  const information = root[informationKey];
  if (!isRecord(information) || !isRecord(information.dataSetInformation)) return [];
  const name = information.dataSetInformation.name;
  if (!isRecord(name)) return [];
  const namePath = `${wrapped ? `${rootKey}.` : ''}${informationKey}.dataSetInformation.name`;
  const issues: DatasetNameIssue[] = [];
  for (const field of [
    'baseName',
    'treatmentStandardsRoutes',
    'mixAndLocationTypes',
    fourthField,
  ]) {
    const value = name[field];
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry, index) => {
      const text = isRecord(entry) ? entry['#text'] : entry;
      if (typeof text !== 'string' || !/[;；]/u.test(text)) return;
      issues.push({
        path: `${namePath}.${field}${Array.isArray(value) ? `.${index}` : ''}${isRecord(entry) ? '.#text' : ''}`,
        code: 'dataset_name_semicolon',
        message:
          'Name fields must not contain semicolons (; or ；) in any language; use commas within each name field.',
      });
    });
  }
  return issues;
}
