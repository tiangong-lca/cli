import type { ReportEdge, ReportNode, ResearchReport } from '../../application/report.js';
import { localized, ui } from './text.js';
import { connectionDetail, processDetail, processKind } from './model-details.js';

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

const NODE_WIDTH = 204;
const COLUMN_GAP = 94;
const ROW_GAP = 23;
const MARGIN = 20;

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
    node.height = Math.max(65, 22 + 11 * Math.max(node.incoming.length, node.outgoing.length));
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
  return node.y + 9 + (node.height - 18) * ((links.indexOf(edge) + 1) / (links.length + 1));
}

export function graph(model: Model): string {
  const { nodes, edges, lanes, width, height } = layout(model);
  const object = (x: number, y: number, w: number, h: number, className: string, content: string) =>
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="${className}">${content}</div></foreignObject>`;
  const port = (x: number, y: number) =>
    `<rect class="node-port" x="${x - 3}" y="${y - 3}" width="6" height="6" rx="1"/>`;
  const links = edges
    .map((edge) => {
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
      const name = localized(edge.label);
      return `<a class="network-edge" href="#edge-${edge.id}" data-graph-link="edge-${edge.id}"><path class="edge-hit" d="${route}"/><path class="edge-path" d="${route}" marker-end="url(#network-arrow)"/>${object(mid - 4, (lane ?? (y1 + y2) / 2) - 4, 8, 8, 'network-edge-label', `<span class="network-visually-hidden">${name}</span>`)}</a>`;
    })
    .join('');

  const cards = nodes
    .map((node) => {
      const { x, y, id, height: size } = node;
      const background = node.kind === 'background';
      const title = `<div class="network-node-kind">${processKind(node)}</div><div class="network-node-title">${localized(node.label)}</div>`;
      const ports = [
        ...node.incoming.map((edge) => port(x, portY(node, node.incoming, edge))),
        ...node.outgoing.map((edge) => port(x + NODE_WIDTH, portY(node, node.outgoing, edge))),
      ].join('');
      return `<a class="graph-node network-node ${background ? 'background' : 'foreground'}" href="#node-${id}" data-graph-link="node-${id}"><rect class="node-body" x="${x}" y="${y}" width="${NODE_WIDTH}" height="${size}" rx="5"/>${object(x + 11, y + 2, NODE_WIDTH - 22, size - 4, 'network-node-content', title)}${ports}</a>`;
    })
    .join('');

  const panel = `<div class="model-panel network-panel"><div class="model-panel-head"><span class="network-title">${ui('Process network', '过程网络')}</span><div class="network-controls" hidden><button type="button" data-zoom="out" data-label-en="Zoom out" data-label-zh="缩小">−</button><output class="network-zoom">100%</output><button type="button" data-zoom="in" data-label-en="Zoom in" data-label-zh="放大">+</button><button type="button" data-zoom="fit">${ui('Fit', '适应画布')}</button><button type="button" class="network-expand"><span class="network-open">${ui('Full screen', '全屏')}</span><span class="network-close" hidden>${ui('Exit full screen', '退出全屏')}</span></button></div></div><div class="network-workspace"><div class="graph-scroll network-viewport" tabindex="0" data-label-en="Process graph" data-label-zh="过程图"><svg id="model-svg" class="network-svg" role="group" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><marker id="network-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#795887"/></marker></defs>${links}${cards}</svg></div><aside class="network-inspector" hidden data-label-en="Selected model details" data-label-zh="所选模型详情"></aside></div><p class="legend network-legend">${ui('Select a process or connection. Drag to pan.', '点击过程或连线查看，拖动画布可平移。')}</p></div>`;
  const processes = nodes.map((node) => processDetail(node, node.incoming, node.outgoing)).join('');
  const connections = edges
    .map((edge) => connectionDetail(edge, edge.source, edge.target))
    .join('');
  const first = nodes.find((node) => node.kind === 'foreground') ?? nodes[0];
  return `${panel}<div class="process-catalog" data-default-process="node-${first.id}"><button type="button" class="catalog-toggle" aria-controls="process-catalog-content" aria-expanded="true" hidden><span class="catalog-open-label">${ui('View complete process inventory', '查看完整过程清单')}</span><span class="catalog-close-label">${ui('Hide complete process inventory', '收起完整过程清单')}</span></button><div id="process-catalog-content" class="catalog-content"><h3 class="catalog-heading">${ui('Process inventory', '完整过程清单')}</h3>${processes}${connections}</div></div>`;
}
