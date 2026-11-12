import type { ReportText, ResearchReport } from '../../application/report.js';
import { escape, localized, refs, ui } from './text.js';

// Visual conventions follow Platform's LifeCycleModels view: primary title bars,
// 6px node corners, left/right IO groups and 8px square connection endpoints.
// These are presentation endpoints, not inferred canonical exchange/port identities.
export function graph(model: NonNullable<ResearchReport['model']>): string {
  const positions = new Map(
    model.nodes.map((n, i) => [n.id, { x: 30 + (i % 3) * 355, y: 45 + Math.floor(i / 3) * 250 }]),
  );
  const height = Math.ceil(model.nodes.length / 3) * 250 + 10;
  const width = Math.min(3, model.nodes.length) * 355 - 65;
  const edges = model.edges
    .map((edge, i) => {
      const a = positions.get(edge.from)!,
        b = positions.get(edge.to)!;
      const x1 = a.x + 230,
        y1 = a.y + 115,
        x2 = b.x,
        y2 = b.y + 115;
      const middle = (x1 + x2) / 2;
      const d =
        edge.from === edge.to
          ? `M ${x1} ${y1} H ${x1 + 20} V ${a.y - 22} H ${a.x - 18} V ${y2} H ${x2}`
          : `M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`;
      const labelX = edge.from === edge.to ? a.x + 65 : middle - 48;
      const labelY = edge.from === edge.to ? a.y - 42 : (y1 + y2) / 2 - 44;
      const quantity =
        edge.amount === undefined && edge.unit === undefined
          ? ''
          : `${escape(edge.amount ?? '—')} ${escape(edge.unit ?? '')}`;
      return `<a href="#edge-${edge.id}" data-graph-link="edge-${edge.id}" data-label-en="Connection ${i + 1}" data-label-zh="连接 ${i + 1}"><path class="edge-hit" d="${d}"/><path class="edge-path" marker-end="url(#arrow)" d="${d}"/><foreignObject x="${labelX}" y="${labelY}" width="96" height="40"><div xmlns="http://www.w3.org/1999/xhtml" class="edge-chip"><span>${String(i + 1).padStart(2, '0')}</span>${quantity}</div></foreignObject></a>`;
    })
    .join('');
  const preview = (items: ReportText[]) =>
    items.length
      ? items
          .slice(0, 2)
          .map((item) => `<div class="port-preview">${localized(item)}</div>`)
          .join('')
      : '<span class="port-empty">—</span>';
  const nodes = model.nodes
    .map((n) => {
      const { x, y } = positions.get(n.id)!;
      return `<a class="graph-node ${n.kind}" href="#node-${n.id}" data-graph-link="node-${n.id}"><rect class="node-body" x="${x}" y="${y}" width="230" height="188" rx="6"/><path class="node-title-bar" d="M ${x + 6} ${y} H ${x + 224} Q ${x + 230} ${y} ${x + 230} ${y + 6} V ${y + 42} H ${x} V ${y + 6} Q ${x} ${y} ${x + 6} ${y}"/><foreignObject x="${x + 10}" y="${y + 6}" width="210" height="32"><div xmlns="http://www.w3.org/1999/xhtml" class="node-label">${localized(n.label)}</div></foreignObject><foreignObject x="${x + 12}" y="${y + 54}" width="206" height="124"><div xmlns="http://www.w3.org/1999/xhtml" class="node-content"><span class="node-kind">${ui(n.kind === 'background' ? 'Background' : 'Foreground', n.kind === 'background' ? '背景过程' : '前景过程')}</span><div class="node-io"><div><strong>${ui('Input', '输入')}</strong>${preview(n.inputs)}</div><div><strong>${ui('Output', '输出')}</strong>${preview(n.outputs)}</div></div></div></foreignObject><rect class="node-port" x="${x - 4}" y="${y + 111}" width="8" height="8"/><rect class="node-port" x="${x + 226}" y="${y + 111}" width="8" height="8"/></a>`;
    })
    .join('');
  const portList = (label: ReportText, items: ReportText[]) =>
    `<div class="io"><strong>${localized(label)}</strong>${items.length ? `<ul>${items.map((item) => `<li>${localized(item)}</li>`).join('')}</ul>` : '<span class="port-empty">—</span>'}</div>`;
  return `<div class="model-panel"><div class="model-panel-head"><span class="model-caption">${ui('PROCESS NETWORK', '过程网络')}</span><div class="graph-controls"><label for="graph-zoom">${ui('Zoom', '缩放')}</label><input id="graph-zoom" type="range" min="50" max="180" value="100"><button id="graph-fit">${ui('Fit', '适应宽度')}</button></div></div><div class="graph-scroll"><svg id="model-svg" class="model-svg" viewBox="0 0 ${width} ${height}" role="group" data-label-en="Model connections" data-label-zh="模型连接"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#5C246A"/></marker></defs>${edges}${nodes}</svg></div><p class="legend">${ui('Select a process or connection to read its details. Background processes stay aggregated.', '点击过程或连接查看详情，背景过程保持聚合。')}</p></div><div class="details-heading">${ui('Process details', '过程详情')}<span>${model.nodes.length}</span></div><div class="details-grid">${model.nodes.map((n, i) => `<article class="detail" id="node-${n.id}" tabindex="-1"><div class="detail-kicker"><span>${String(i + 1).padStart(2, '0')}</span>${ui(n.kind === 'background' ? 'Background' : 'Foreground', n.kind === 'background' ? '背景过程' : '前景过程')}</div><h3>${localized(n.label)}</h3><div class="detail-id">${n.id}</div>${n.details ? `<p>${localized(n.details)}</p>` : ''}<div class="detail-io">${portList({ en: 'Inputs', zh: '输入' }, n.inputs)}${portList({ en: 'Outputs', zh: '输出' }, n.outputs)}</div>${refs(n.sources)}</article>`).join('')}</div><div class="connection-list">${model.edges.map((e, i) => `<article class="detail connection" id="edge-${e.id}" tabindex="-1"><span class="connection-number">${String(i + 1).padStart(2, '0')}</span><div><h3>${localized(e.label)}</h3><div class="detail-id"><a href="#node-${e.from}">${e.from}</a> → <a href="#node-${e.to}">${e.to}</a></div>${e.details ? `<p>${localized(e.details)}</p>` : ''}</div>${e.amount === undefined && e.unit === undefined ? '' : `<p class="connection-amount">${escape(e.amount ?? '—')} ${escape(e.unit ?? '')}</p>`}</article>`).join('')}</div>`;
}
