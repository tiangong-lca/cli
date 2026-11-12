import { createHash } from 'node:crypto';
import type { ReportCell, ReportText, ResearchReport } from '../../application/report.js';
import { REPORT_BROWSER } from './browser.js';
import { REPORT_CSS } from './styles.js';

function escape(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function localized(value: ReportText): string {
  if (typeof value === 'string') return escape(value);
  return Object.entries(value)
    .map(
      ([language, content]) =>
        `<span class="localized" lang="${language}" data-language-text="${language}"${Object.keys(value).length === 1 ? ` data-only=" [${language.toUpperCase()}]"` : ''}>${escape(content!)}</span>`,
    )
    .join('');
}
const ui = (en: string, zh: string) => localized({ en, zh });
const refs = (ids: string[]) =>
  `<div class="source-refs">${ids.map((id) => `<a href="#source-${id}">[${id}]</a>`).join('')}</div>`;
function table(columns: ReportText[], rows: ReportCell[][]): string {
  return `<div class="table-wrap" data-table><div class="table-controls"><label>${ui('Filter rows', '筛选表格')}<input type="search" aria-label="Filter rows / 筛选表格"></label><span role="status">${rows.length} / ${rows.length}</span></div><table><thead><tr>${columns.map((c) => `<th scope="col">${localized(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td${typeof cell === 'number' ? ' class="numeric"' : ''}>${typeof cell === 'number' ? escape(cell) : localized(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function graph(model: NonNullable<ResearchReport['model']>): string {
  const positions = new Map(
    model.nodes.map((n, i) => [n.id, { x: 35 + (i % 3) * 295, y: 50 + Math.floor(i / 3) * 190 }]),
  );
  const height = Math.ceil(model.nodes.length / 3) * 190 + 40;
  const width = Math.min(3, model.nodes.length) * 295 + 30;
  const edges = model.edges
    .map((edge, i) => {
      const a = positions.get(edge.from)!,
        b = positions.get(edge.to)!;
      const x1 = a.x + 205,
        y1 = a.y + 55,
        x2 = b.x,
        y2 = b.y + 55;
      const d =
        edge.from === edge.to
          ? `M ${x1} ${y1} C ${x1 + 65} ${y1 - 100} ${a.x + 40} ${a.y - 55} ${a.x + 40} ${a.y}`
          : `M ${x1} ${y1} C ${x1 + 45} ${y1} ${x2 - 45} ${y2} ${x2} ${y2}`;
      return `<a href="#edge-${edge.id}" data-graph-link="edge-${edge.id}" aria-label="Connection ${i + 1} / 连接 ${i + 1}"><path class="edge-hit" d="${d}"/><path class="edge-path" marker-end="url(#arrow)" d="${d}"/><text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 10}" text-anchor="middle">${i + 1}</text></a>`;
    })
    .join('');
  const nodes = model.nodes
    .map((n) => {
      const { x, y } = positions.get(n.id)!;
      return `<a class="graph-node ${n.kind}" href="#node-${n.id}" data-graph-link="node-${n.id}"><rect x="${x}" y="${y}" width="205" height="110" rx="8"/><text class="node-kind" x="${x + 14}" y="${y + 20}">${n.kind === 'background' ? 'BACKGROUND / 背景' : 'FOREGROUND / 前景'}</text><foreignObject x="${x + 9}" y="${y + 30}" width="187" height="76"><div xmlns="http://www.w3.org/1999/xhtml" class="node-label">${localized(n.label)}</div></foreignObject></a>`;
    })
    .join('');
  const portList = (label: ReportText, items: ReportText[]) =>
    `<div class="io"><strong>${localized(label)}</strong><ul>${items.map((item) => `<li>${localized(item)}</li>`).join('')}</ul></div>`;
  return `<div class="graph-controls"><label for="graph-zoom">${ui('Zoom', '缩放')}</label><input id="graph-zoom" type="range" min="50" max="180" value="100"><button id="graph-fit">${ui('Fit', '适应宽度')}</button></div><div class="graph-scroll"><svg id="model-svg" class="model-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="Model connections / 模型连接"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#74958e"/></marker></defs>${edges}${nodes}</svg></div><p class="legend">${ui('Select a node or numbered connection for details. Backgrounds remain aggregated; layout does not express quantities.', '点击节点或编号连接查看详情。背景保持聚合；布局不表示数量大小。')}</p><div class="details-grid">${model.nodes.map((n) => `<article class="detail" id="node-${n.id}" tabindex="-1"><h3>${localized(n.label)}</h3><div class="detail-id">${n.id} · ${ui(n.kind === 'background' ? 'Background' : 'Foreground', n.kind === 'background' ? '背景' : '前景')}</div>${n.details ? `<p>${localized(n.details)}</p>` : ''}${portList({ en: 'Inputs', zh: '输入' }, n.inputs)}${portList({ en: 'Outputs', zh: '输出' }, n.outputs)}${refs(n.sources)}</article>`).join('')}</div><div class="connection-list">${model.edges.map((e, i) => `<article class="detail" id="edge-${e.id}" tabindex="-1"><h3>${i + 1}. ${localized(e.label)}</h3><div class="detail-id"><a href="#node-${e.from}">${e.from}</a> → <a href="#node-${e.to}">${e.to}</a></div>${e.amount === undefined && e.unit === undefined ? '' : `<p>${escape(e.amount ?? '—')} ${escape(e.unit ?? '')}</p>`}${e.details ? `<p>${localized(e.details)}</p>` : ''}</article>`).join('')}</div>`;
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
    typeof report.title === 'string' ? report.title : Object.values(report.title).join(' · ');
  return `<!doctype html>
<html lang="${report.language === 'zh' ? 'zh' : 'en'}" data-language="${report.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'"><title>${escape(title)}</title><style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><span class="brand">TIANGONG · RESEARCH REPORT</span><label for="report-language">Language / 语言</label><select id="report-language">${[
    ['bilingual', '中文 + English'],
    ['zh', '中文'],
    ['en', 'English'],
  ]
    .map(
      ([v, label]) =>
        `<option value="${v}"${report.language === v ? ' selected' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select><button id="report-print">${ui('Print / Save as PDF', '打印 / 导出 PDF')}</button></div>
<div class="page"><header class="hero"><div class="eyebrow">LIFE CYCLE ASSESSMENT</div><h1>${localized(report.title)}</h1>${report.subtitle ? `<p class="subtitle">${localized(report.subtitle)}</p>` : ''}<p class="scope-note">${ui('Rendered from supplied research content. Interpretation, calculation validity and review remain with their authors.', '基于提供的研究内容生成。解释、计算有效性和审核由相应责任方负责。')}</p></header><div class="layout"><nav class="toc" aria-label="Contents / 目录">${sections.map((s, i) => `<a href="#${s.id}">${String(i + 1).padStart(2, '0')} · ${localized(s.title)}</a>`).join('')}</nav><main>${sections.map((s, i) => `<section id="${s.id}" class="section"><div class="section-number">${String(i + 1).padStart(2, '0')}</div><h2>${localized(s.title)}</h2>${s.html}</section>`).join('')}<footer class="footer">${ui('The HTML works offline. Printed copies include all detail cards and table rows in the selected language mode.', 'HTML 支持离线阅读。打印包含全部详情和表格行，沿用所选语言模式。')}</footer></main></div></div><script>${REPORT_BROWSER}</script></body></html>\n`;
}
