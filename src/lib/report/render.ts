import { createHash } from 'node:crypto';
import type { ReportCell, ReportText, ResearchReport } from '../../application/report.js';
import { REPORT_BROWSER } from './browser.js';
import { REPORT_CSS } from './styles.js';
import { reportBrand } from './brand.js';
import { renderContributions, renderSensitivity } from './analysis.js';

import { escape, localized, ui, refs } from './text.js';
import { graph } from './graph.js';

function table(columns: ReportText[], rows: ReportCell[][]): string {
  return `<div class="table-wrap" data-table><div class="table-controls"><label>${ui('Filter rows', '筛选表格')}<input type="search" data-label-en="Filter rows" data-label-zh="筛选表格"></label><span role="status">${rows.length} / ${rows.length}</span></div><table><thead><tr>${columns.map((c) => `<th scope="col">${localized(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td${typeof cell === 'number' ? ' class="numeric"' : ''}>${typeof cell === 'number' ? escape(cell) : localized(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function resultsOverview(report: ResearchReport): string {
  const overview = report.results.filter((item) => item.summary ?? report.results.length === 1);
  if (!overview.length) return '';
  const format = new Intl.NumberFormat(report.language, { maximumSignificantDigits: 4 });
  return `<section class="result-summary" data-label-en="Key results" data-label-zh="主要结果">${overview.map((item) => `<article class="result-tile"><div class="result-label">${localized(item.label)}</div>${item.context ? `<div class="result-context">${localized(item.context)}</div>` : ''}<div class="result-number"><data value="${escape(item.value)}" title="${escape(item.value)}">${escape(format.format(item.value))}</data> <span>${escape(item.unit)}</span></div></article>`).join('')}</section>`;
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
  if (report.results.length) {
    const hasContext = report.results.some((result) => result.context !== undefined);
    sections.push({
      id: 'results',
      title: { en: 'Calculation results', zh: '计算结果' },
      html: table(
        [
          { en: 'Indicator', zh: '指标' },
          { en: 'Value', zh: '数值' },
          { en: 'Unit', zh: '单位' },
          ...(hasContext ? [{ en: 'Basis', zh: '核算口径' }] : []),
          { en: 'Method / Run', zh: '方法 / 运行' },
        ],
        report.results.map((r) => [
          r.label,
          r.value,
          r.unit,
          ...(hasContext ? [r.context ?? '—'] : []),
          r.method ?? '—',
        ]),
      ),
    });
  }
  for (const [i, block] of (report.analysis?.contributions ?? []).entries())
    sections.push({
      id: `contribution-${i + 1}`,
      title: block.title,
      html: renderContributions(block),
    });
  for (const [i, block] of (report.analysis?.sensitivity ?? []).entries())
    sections.push({
      id: `sensitivity-${i + 1}`,
      title: block.title,
      html: renderSensitivity(block),
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
  const brand = reportBrand();
  const title =
    typeof report.title === 'string'
      ? report.title
      : (report.title[report.language] ?? Object.values(report.title)[0]);
  return `<!doctype html>
<html lang="${report.language === 'zh' ? 'zh' : 'en'}" data-language="${report.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>${escape(title)}</title><style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><span class="brand"><img class="official-logo" src="${brand.logo}" alt="">TIANGONG LCA <span class="brand-divider">/</span> ${ui('Research report', '研究报告')}</span><label for="report-language">${ui('Language', '语言')}</label><select id="report-language">${[
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
<div class="page"><header class="hero"><div class="cover-copy"><div class="eyebrow">${ui('LIFE CYCLE ASSESSMENT', '生命周期评价')}</div><h1>${localized(report.title)}</h1>${report.subtitle ? `<p class="subtitle">${localized(report.subtitle)}</p>` : ''}</div><img class="cover-art" src="${brand.cover}" alt=""></header>${resultsOverview(report)}${sections.length ? `<div class="layout"><nav class="toc" data-label-en="Contents" data-label-zh="目录"><div class="toc-title">${ui('CONTENTS', '报告目录')}</div>${sections.map((s, i) => `<a href="#${s.id}">${String(i + 1).padStart(2, '0')} · ${localized(s.title)}</a>`).join('')}</nav><main>${sections.map((s) => `<section id="${s.id}" class="section"><h2>${localized(s.title)}</h2>${s.html}</section>`).join('')}</main></div>` : ''}</div><script>${REPORT_BROWSER}</script></body></html>\n`;
}
