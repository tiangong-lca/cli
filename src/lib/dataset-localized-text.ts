import { CliError } from './errors.js';

export type LocalizedTextIssue = { path: string; code: string; message: string };

/** Multilingual scalar field owners in the pinned SDK; entity arrays are not language lists. */
export const LOCALIZED_TEXT_FIELD_NAMES = Object.freeze([
  'annualSupplyOrProductionVolume',
  'baseName',
  'centralContactPoint',
  'comment',
  'common:accessRestrictions',
  'common:generalComment',
  'common:intendedApplications',
  'common:name',
  'common:otherReviewDetails',
  'common:project',
  'common:reviewDetails',
  'common:shortDescription',
  'common:shortName',
  'common:synonyms',
  'common:timeRepresentativenessDescription',
  'completenessOtherProblemField',
  'consideredMechanisms',
  'contactAddress',
  'contactDescriptionOrComment',
  'dataCollectionPeriod',
  'dataCutOffAndCompletenessPrinciples',
  'dataSelectionAndCombinationPrinciples',
  'dataTreatmentAndExtrapolationsPrinciples',
  'descriptionOfRestrictions',
  'deviationsFromCutOffAndCompletenessPrinciples',
  'deviationsFromLCIAMethodPrinciple',
  'deviationsFromLCIMethodApproaches',
  'deviationsFromLCIMethodPrinciple',
  'deviationsFromModellingConstants',
  'deviationsFromSelectionAndCombinationPrinciples',
  'deviationsFromTreatmentAndExtrapolationPrinciples',
  'duration',
  'flowProperties',
  'functionalUnitFlowProperties',
  'functionalUnitOrOther',
  'generalComment',
  'geographicalRepresentativenessDescription',
  'groupName',
  'meaning',
  'mixAndLocationTypes',
  'modelDescription',
  'modellingConstants',
  'normalisationDescription',
  'referenceYear',
  'samplingProcedure',
  'sourceDescriptionOrComment',
  'technologicalApplicability',
  'technologyDescriptionAndIncludedProcesses',
  'timeRepresentativenessDescription',
  'treatmentStandardsRoutes',
  'uncertaintyAdjustments',
  'useAdviceForDataSet',
  'weightingDescription',
] as const);
const LOCALIZED_TEXT_FIELDS = new Set<string>(LOCALIZED_TEXT_FIELD_NAMES);

function isLocalizedTextField(path: Array<string | number>): boolean {
  const field = path.at(-1);
  return (
    typeof field === 'string' &&
    LOCALIZED_TEXT_FIELDS.has(field) &&
    (field !== 'flowProperties' || path.at(-2) === 'name')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inspect only declared multilingual scalar fields, preserving raw additional attributes. */
export function collectLocalizedTextUniquenessIssues(
  value: unknown,
  prefix: Array<string | number> = [],
): LocalizedTextIssue[] {
  const issues: LocalizedTextIssue[] = [];
  const visit = (node: unknown, path: Array<string | number>): void => {
    if (Array.isArray(node)) {
      const localizedField = isLocalizedTextField(path);
      const seen = new Map<string, number>();
      node.forEach((entry: unknown, index) => {
        if (localizedField && isRecord(entry) && typeof entry['@xml:lang'] === 'string') {
          const language = entry['@xml:lang'].trim().toLowerCase();
          const first = seen.get(language);
          if (first !== undefined) {
            issues.push({
              path: [...path, index, '@xml:lang'].join('.'),
              code: 'duplicate_language_entry',
              message: `Language ${language} already occurs at index ${first} in this field. Keep one value per language without discarding text or exceeding the field limit.`,
            });
          } else {
            seen.set(language, index);
          }
        }
        visit(entry, [...path, index]);
      });
    } else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key !== 'common:other') visit(child, [...path, key]);
      }
    }
  };
  visit(value, prefix);
  return issues;
}

/** Admission only: never rewrite candidate bytes or a historical before image. */
export function assertLocalizedTextLanguageUniqueness(
  value: unknown,
  prefix: Array<string | number> = [],
): void {
  const issues = collectLocalizedTextUniquenessIssues(value, prefix);
  if (issues.length > 0) {
    throw new CliError('Dataset contains repeated languages in a localized field.', {
      code: 'DATASET_DUPLICATE_LANGUAGE',
      exitCode: 1,
      details: { issues },
    });
  }
}

/** Authoring-only prose assembly. Retain attributed conflicts for validation rather than discard metadata. */
export function mergeLocalizedTextParagraphs<T>(entries: T[]): Array<T | Record<string, unknown>> {
  if (
    entries.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry['@xml:lang'] !== 'string' ||
        typeof entry['#text'] !== 'string' ||
        Object.keys(entry).some((key) => key !== '@xml:lang' && key !== '#text'),
    )
  )
    return entries;
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const record = entry as Record<string, unknown>;
    const language = String(record['@xml:lang']);
    const texts = grouped.get(language) ?? [];
    texts.push(String(record['#text']));
    grouped.set(language, texts);
  }
  return [...grouped].map(([language, texts]) => ({
    '@xml:lang': language,
    '#text': texts.join('\n\n'),
  }));
}
