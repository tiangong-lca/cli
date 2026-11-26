import { contentDigest, patchContent } from './dataset-content.js';
import { isObject, object, text, type JsonObject } from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export function extractTranslations(request: JsonObject) {
  const content = object(request.content, 'content');
  const sourceLanguage = text(request.sourceLanguage, 'sourceLanguage');
  const targetLanguage = text(request.targetLanguage, 'targetLanguage');
  if (sourceLanguage === targetLanguage)
    throw new CommandInputError('LANGUAGE_INVALID', 'Source and target languages must differ.');
  const units: JsonObject[] = [];
  function visit(value: unknown, path: string) {
    if (Array.isArray(value)) {
      if (
        value.length &&
        value.every((entry) => isObject(entry) && typeof entry['@xml:lang'] === 'string')
      ) {
        const source = value.find((entry) => entry['@xml:lang'] === sourceLanguage);
        if (source && typeof source['#text'] === 'string')
          units.push({
            path,
            sourceLanguage,
            targetLanguage,
            sourceText: source['#text'],
            targetText:
              value.find((entry) => entry['@xml:lang'] === targetLanguage)?.['#text'] ?? null,
          });
      } else value.forEach((entry, index) => visit(entry, `${path}/${index}`));
    } else if (isObject(value))
      for (const [key, entry] of Object.entries(value))
        visit(entry, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  }
  visit(content, '');
  return { sourceDigest: contentDigest(content), sourceLanguage, targetLanguage, units };
}
export function applyTranslations(request: JsonObject) {
  const content = object(request.content, 'content');
  const extraction = extractTranslations(request);
  if (request.sourceDigest !== extraction.sourceDigest)
    throw new CommandInputError('CONTENT_CONFLICT', 'Translation source content changed.');
  if (!Array.isArray(request.translations))
    throw new CommandInputError('TRANSLATIONS_REQUIRED', 'translations must be an array.');
  const operations: JsonObject[] = [];
  const seen = new Set<string>();
  for (const value of request.translations) {
    const translation = object(value, 'translation');
    const unit = extraction.units.find((entry) => entry.path === translation.path);
    if (!unit || seen.has(String(unit.path)) || translation.sourceText !== unit.sourceText)
      throw new CommandInputError(
        'TRANSLATION_STALE',
        'Translation position or source text is stale or repeated.',
      );
    seen.add(String(unit.path));
    const translatedText = text(translation.text, 'translation.text');
    const parts = String(unit.path)
      .slice(1)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    let container: unknown = content;
    for (const part of parts) container = (container as JsonObject)[part];
    const values = container as JsonObject[];
    const target = values.findIndex((entry) => entry['@xml:lang'] === extraction.targetLanguage);
    operations.push({
      op: target < 0 ? 'add' : 'replace',
      path: `${unit.path}/${target < 0 ? '-' : target}`,
      value: {
        ...(target < 0 ? {} : values[target]),
        '@xml:lang': extraction.targetLanguage,
        '#text': translatedText,
      },
      basis: text(translation.basis, 'translation.basis'),
    });
  }
  if (!operations.length) return { content: structuredClone(content), changes: [] };
  return patchContent({ content, expectedDigest: extraction.sourceDigest, operations });
}
