import type { ReportText } from '../../application/report.js';

export function escape(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function localized(value: ReportText): string {
  if (typeof value === 'string') return escape(value);
  return Object.entries(value)
    .map(
      ([language, content]) =>
        `<span class="localized" lang="${language}" data-language-text="${language}"${Object.keys(value).length === 1 ? ` data-only=" [${language.toUpperCase()}]"` : ''}>${escape(content!)}</span>`,
    )
    .join('');
}
export const ui = (en: string, zh: string) => localized({ en, zh });
export const refs = (ids: string[]) =>
  `<div class="source-refs">${ids.map((id) => `<a href="#source-${id}">[${id}]</a>`).join('')}</div>`;
