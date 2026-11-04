import { CliError } from './errors.js';

export type LocalizedTextIssue = { path: string; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inspect raw fields independently, including localized objects carrying additional attributes. */
export function collectLocalizedTextUniquenessIssues(
  value: unknown,
  prefix: Array<string | number> = [],
): LocalizedTextIssue[] {
  const issues: LocalizedTextIssue[] = [];
  const visit = (node: unknown, path: Array<string | number>): void => {
    if (Array.isArray(node)) {
      // Hierarchy levels are separate entities, even when the SDK retains language metadata.
      const fieldPath = path.filter((segment) => typeof segment === 'string').join('.');
      const hierarchy =
        fieldPath.endsWith('classificationInformation.common:classification.common:class') ||
        fieldPath.endsWith(
          'classificationInformation.common:elementaryFlowCategorization.common:category',
        );
      const seen = new Map<string, number>();
      node.forEach((entry: unknown, index) => {
        if (!hierarchy && isRecord(entry) && typeof entry['@xml:lang'] === 'string') {
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
