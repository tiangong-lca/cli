import { createHash } from 'node:crypto';
import type { ReportCell, ReportText, ResearchReport } from '../../application/report.js';
import { REPORT_BROWSER } from './browser.js';
import { REPORT_CSS } from './styles.js';

import { escape, localized, ui, refs } from './text.js';
import { graph } from './graph.js';

function table(columns: ReportText[], rows: ReportCell[][]): string {
  return `<div class="table-wrap" data-table><div class="table-controls"><label>${ui('Filter rows', '筛选表格')}<input type="search" data-label-en="Filter rows" data-label-zh="筛选表格"></label><span role="status">${rows.length} / ${rows.length}</span></div><table><thead><tr>${columns.map((c) => `<th scope="col">${localized(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td${typeof cell === 'number' ? ' class="numeric"' : ''}>${typeof cell === 'number' ? escape(cell) : localized(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
/** A derived presentation of supplied facts, not an official signed Study export. */
export function renderResearchReport(report: ResearchReport): string {
  const sections = report.sections.map((s, i) => ({
    id: `section-${i + 1}`,
    title: s.title,
    html: `${s.body ? `<p class="prose">${localized(s.body)}</p>` : ''}${s.table ? table(s.table.columns, s.table.rows) : ''}${refs(s.sources)}`,
  }));
  if (report.model)
    sections.push({
      id: 'model',
      title: { en: 'Model structure', zh: '模型结构' },
      html: graph(report.model),
    });
  if (report.results.length)
    sections.push({
      id: 'results',
      title: { en: 'Calculation results', zh: '计算结果' },
      html: table(
        [
          { en: 'Indicator', zh: '指标' },
          { en: 'Value', zh: '数值' },
          { en: 'Unit', zh: '单位' },
          { en: 'Method / Run', zh: '方法 / 运行' },
        ],
        report.results.map((r) => [r.label, r.value, r.unit, r.method ?? '—']),
      ),
    });
  if (report.limitations.length)
    sections.push({
      id: 'limitations',
      title: { en: 'Interpretation and limitations', zh: '解释与局限' },
      html: `<ul class="limitations">${report.limitations.map((v) => `<li>${localized(v)}</li>`).join('')}</ul>`,
    });
  if (report.sources.length)
    sections.push({
      id: 'sources',
      title: { en: 'Sources and evidence', zh: '来源与依据' },
      html: `<ol class="sources">${report.sources.map((s) => `<li id="source-${s.id}"><strong>[${s.id}] ${localized(s.title)}</strong>${s.note ? `<p>${localized(s.note)}</p>` : ''}${s.url ? `<a class="source-url" href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">${escape(s.url)}</a>` : ''}</li>`).join('')}</ol>`,
    });
  const scriptHash = createHash('sha256').update(REPORT_BROWSER).digest('base64');
  const title =
    typeof report.title === 'string'
      ? report.title
      : (report.title[report.language] ?? Object.values(report.title)[0]);
  return `<!doctype html>
<html lang="${report.language === 'zh' ? 'zh' : 'en'}" data-language="${report.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>${escape(title)}</title><style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><span class="brand"><span class="brand-mark" aria-hidden="true">T</span>TIANGONG <span class="brand-divider">/</span> ${ui('Research report', '研究报告')}</span><label for="report-language">${ui('Language', '语言')}</label><select id="report-language">${[
    ['zh', '中文'],
    ['en', 'English'],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}"${report.language === v ? ' selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select><button id="report-print" class="primary-button">${ui('Print / Save as PDF', '打印 / 导出 PDF')}</button></div>
<div class="page"><header class="hero"><div class="eyebrow">${ui('LIFE CYCLE ASSESSMENT', '生命周期评价')}</div><h1>${localized(report.title)}</h1>${report.subtitle ? `<p class="subtitle">${localized(report.subtitle)}</p>` : ''}</header><div class="layout"><nav class="toc" data-label-en="Contents" data-label-zh="目录"><div class="toc-title">${ui('CONTENTS', '报告目录')}</div>${sections.map((s, i) => `<a href="#${s.id}">${String(i + 1).padStart(2, '0')} · ${localized(s.title)}</a>`).join('')}</nav><main>${sections.map((s, i) => `<section id="${s.id}" class="section"><div class="section-number">${String(i + 1).padStart(2, '0')}</div><h2>${localized(s.title)}</h2>${s.html}</section>`).join('')}<footer class="footer"><span class="footer-brand">TIANGONG</span>${ui('The HTML works offline. Printed copies include all detail cards and table rows in the selected language mode.', 'HTML 支持离线阅读。打印包含全部详情和表格行，沿用所选语言模式。')}</footer></main></div></div><script>${REPORT_BROWSER}</script></body></html>\n`;
}
