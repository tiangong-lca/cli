import type {
  ReportEdge,
  ReportNode,
  ReportText,
  ResearchReport,
} from '../../application/report.js';
import { escape, localized, refs, ui } from './text.js';

type Model = NonNullable<ResearchReport['model']>;
type LayoutNode = ReportNode & {
  incoming: LayoutEdge[];
  outgoing: LayoutEdge[];
  depth: number;
  x: number;
  y: number;
  height: number;
};
type LayoutEdge = ReportEdge & { source: LayoutNode; target: LayoutNode };

const NODE_WIDTH = 236;
const COLUMN_GAP = 98;
const ROW_GAP = 32;
const MARGIN = 24;
const MAX_PREVIEW_FLOWS = 4;

function layout(model: Model) {
  const nodes = new Map<string, LayoutNode>(
    model.nodes.map((node) => [
      node.id,
      {
        ...node,
        incoming: [],
        outgoing: [],
        depth: 0,
        x: 0,
        y: 0,
        height: 0,
      },
    ]),
  );
  const edges = model.edges.map((edge) => {
    const source = nodes.get(edge.from)!;
    const target = nodes.get(edge.to)!;
    const connection = { ...edge, source, target };
    source.outgoing.push(connection);
    target.incoming.push(connection);
    return connection;
  });
  const pending = new Set(nodes.values());
  const indegree = new Map(
    [...nodes.values()].map((node) => [
      node,
      node.incoming.filter((edge) => edge.source !== node).length,
    ]),
  );
  const queue = [...pending].filter((node) => indegree.get(node) === 0);
  const columns: LayoutNode[][] = [];
  for (let cursor = 0; pending.size;) {
    // Start a remaining cycle in input order. For layout only, its closing edge routes back.
    const node = cursor < queue.length ? queue[cursor++]! : pending.values().next().value!;
    pending.delete(node);
    (columns[node.depth] ??= []).push(node);
    for (const { target } of node.outgoing) {
      if (!pending.has(target)) continue;
      target.depth = Math.max(target.depth, node.depth + 1);
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  for (const node of nodes.values()) {
    const rows = Math.min(MAX_PREVIEW_FLOWS, Math.max(node.inputs.length, node.outputs.length));
    const more = Math.max(node.inputs.length, node.outputs.length) > MAX_PREVIEW_FLOWS;
    node.height = Math.max(
      118,
      86 + (rows + Number(more)) * 17,
      65 + 15 * Math.max(node.incoming.length, node.outgoing.length),
    );
  }
  const routedEdges = edges.filter((edge) => edge.target.depth !== edge.source.depth + 1);
  const lanes = new Map(routedEdges.map((edge, index) => [edge, MARGIN + index * 14]));
  const top = MARGIN + routedEdges.length * 14;
  const columnHeights = columns.map(
    (column) =>
      column.reduce((height, node) => height + node.height, 0) + ROW_GAP * (column.length - 1),
  );
  const bodyHeight = Math.max(...columnHeights, 158);
  for (const [index, column] of columns.entries()) {
    let y = top + (bodyHeight - columnHeights[index]) / 2;
    for (const node of column) {
      node.x = MARGIN + index * (NODE_WIDTH + COLUMN_GAP);
      node.y = y;
      y += node.height + ROW_GAP;
    }
  }
  return {
    nodes: [...nodes.values()],
    edges,
    lanes,
    width: 2 * MARGIN + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP,
    height: top + bodyHeight + MARGIN,
  };
}

function portY(node: LayoutNode, links: LayoutEdge[], edge: LayoutEdge) {
  return node.y + 34 + (node.height - 40) * ((links.indexOf(edge) + 1) / (links.length + 1));
}

export function graph(model: Model): string {
  const { nodes, edges, lanes, width, height } = layout(model);
  const object = (x: number, y: number, w: number, h: number, className: string, content: string) =>
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="${className}">${content}</div></foreignObject>`;
  const port = (x: number, y: number) =>
    `<rect class="node-port" x="${x - 3}" y="${y - 3}" width="6" height="6" rx="1"/>`;
  const flows = (label: string, values: ReportText[]) =>
    `<div><strong>${label}</strong>${
      values.length
        ? values
            .slice(0, MAX_PREVIEW_FLOWS)
            .map((value) => `<div class="network-flow">${localized(value)}</div>`)
            .join('')
        : '<span class="port-empty">—</span>'
    }${
      values.length > MAX_PREVIEW_FLOWS
        ? `<div class="network-flow">+${values.length - MAX_PREVIEW_FLOWS}</div>`
        : ''
    }</div>`;

  const links = edges
    .map((edge, index) => {
      const { source, target } = edge;
      const x1 = source.x + NODE_WIDTH;
      const x2 = target.x;
      const y1 = portY(source, source.outgoing, edge);
      const y2 = portY(target, target.incoming, edge);
      const lane = lanes.get(edge);
      const mid = (x1 + x2) / 2;
      const route =
        lane === undefined
          ? `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
          : `M ${x1} ${y1} H ${x1 + 14} V ${lane} H ${x2 - 14} V ${y2} H ${x2}`;
      const quantity = [edge.amount, edge.unit]
        .filter((value) => value !== undefined)
        .map(escape)
        .join(' ');
      const label = [String(index + 1).padStart(2, '0'), quantity].filter(Boolean).join(' · ');
      const name = localized(edge.label);
      return `<a class="network-edge" href="#edge-${edge.id}" data-graph-link="edge-${edge.id}"><path class="edge-hit" d="${route}"/><path class="edge-path" d="${route}" marker-end="url(#network-arrow)"/>${object(mid - 44, (lane ?? (y1 + y2) / 2) - 26, 88, 24, 'network-edge-label', `<span class="network-visually-hidden">${name}</span><span aria-hidden="true">${label}</span>`)}</a>`;
    })
    .join('');

  const cards = nodes
    .map((node) => {
      const { x, y, id, height: size } = node;
      const background = node.kind === 'background';
      const title = object(
        x + 12,
        y,
        NODE_WIDTH - 24,
        36,
        'network-node-title',
        localized(node.label),
      );
      const kind = background
        ? ui('Background process', '背景过程')
        : ui('Foreground process', '前景过程');
      const content = `<div class="network-node-kind">${kind}</div><div class="network-node-flows">${flows(ui('Inputs', '输入流'), node.inputs)}${flows(ui('Outputs', '输出流'), node.outputs)}</div>`;
      const ports = [
        ...node.incoming.map((edge) => port(x, portY(node, node.incoming, edge))),
        ...node.outgoing.map((edge) => port(x + NODE_WIDTH, portY(node, node.outgoing, edge))),
      ].join('');
      return `<a class="graph-node network-node ${background ? 'background' : 'foreground'}" href="#node-${id}" data-graph-link="node-${id}"><rect class="node-body" x="${x}" y="${y}" width="${NODE_WIDTH}" height="${size}" rx="6"/><path class="node-title-bar" d="M ${x + 6} ${y} H ${x + NODE_WIDTH - 6} Q ${x + NODE_WIDTH} ${y} ${x + NODE_WIDTH} ${y + 6} V ${y + 36} H ${x} V ${y + 6} Q ${x} ${y} ${x + 6} ${y}"/>${title}${object(x + 12, y + 39, NODE_WIDTH - 24, size - 43, 'network-node-content', content)}${ports}</a>`;
    })
    .join('');

  const panel = `<div class="model-panel network-panel"><div class="model-panel-head"><span class="network-title">${ui('Process network', '过程网络')}</span><div class="network-controls" hidden><button type="button" data-zoom="out" data-label-en="Zoom out" data-label-zh="缩小">−</button><output class="network-zoom">100%</output><button type="button" data-zoom="in" data-label-en="Zoom in" data-label-zh="放大">+</button><button type="button" data-zoom="fit">${ui('Fit', '适应画布')}</button><button type="button" class="network-expand"><span class="network-open">${ui('Full screen', '全屏')}</span><span class="network-close" hidden>${ui('Exit full screen', '退出全屏')}</span></button></div></div><div class="network-workspace"><div class="graph-scroll network-viewport" tabindex="0" data-label-en="Process graph" data-label-zh="过程图"><svg id="model-svg" class="network-svg" role="group" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><marker id="network-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#795887"/></marker></defs>${links}${cards}</svg></div><aside class="network-inspector" hidden data-label-en="Selected model details" data-label-zh="所选模型详情"></aside></div><p class="legend network-legend">${ui('Select a process or connection to view details. Drag the canvas to pan.', '选择过程或连接查看详情。拖动画布可平移。')}</p></div>`;
  const portList = (label: ReportText, items: ReportText[]) =>
    `<div class="io"><strong>${localized(label)}</strong>${items.length ? `<ul>${items.map((item) => `<li>${localized(item)}</li>`).join('')}</ul>` : '<span class="port-empty">—</span>'}</div>`;
  return (
    panel +
    `<div class="details-heading">${ui('Process details', '过程详情')}<span>${model.nodes.length}</span></div><div class="details-grid">${model.nodes.map((n, i) => `<article class="detail" id="node-${n.id}" tabindex="-1"><div class="detail-kicker"><span>${String(i + 1).padStart(2, '0')}</span>${ui(n.kind === 'background' ? 'Background' : 'Foreground', n.kind === 'background' ? '背景过程' : '前景过程')}</div><h3>${localized(n.label)}</h3><div class="detail-id">${n.id}</div>${n.details ? `<p>${localized(n.details)}</p>` : ''}<div class="detail-io">${portList({ en: 'Inputs', zh: '输入' }, n.inputs)}${portList({ en: 'Outputs', zh: '输出' }, n.outputs)}</div>${refs(n.sources)}</article>`).join('')}</div><div class="connection-list">${model.edges.map((e, i) => `<article class="detail connection" id="edge-${e.id}" tabindex="-1"><span class="connection-number">${String(i + 1).padStart(2, '0')}</span><div><h3>${localized(e.label)}</h3><div class="detail-id"><a href="#node-${e.from}">${e.from}</a> → <a href="#node-${e.to}">${e.to}</a></div>${e.details ? `<p>${localized(e.details)}</p>` : ''}</div>${e.amount === undefined && e.unit === undefined ? '' : `<p class="connection-amount">${escape(e.amount ?? '—')} ${escape(e.unit ?? '')}</p>`}</article>`).join('')}</div>`
  );
}
