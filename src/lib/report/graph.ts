import type {
  ReportEdge,
  ReportFlow,
  ReportNode,
  ReportText,
  ResearchReport,
} from '../../application/report.js';
import { localized, ui } from './text.js';
import { connectionDetail, processDetail } from './model-details.js';

type Model = NonNullable<ResearchReport['model']>;
type Side = 'left' | 'right';
type Port = { side: Side; row: number; label: ReportText; id?: string };
type Point = { x: number; y: number };
type LayoutNode = ReportNode &
  Point & {
    ports: Record<Side, Port[]>;
    incoming: LayoutEdge[];
    outgoing: LayoutEdge[];
    depth: number;
    height: number;
  };
type LayoutEdge = ReportEdge & {
  source: LayoutNode;
  target: LayoutNode;
  startPort: Port;
  endPort: Port;
};

const NODE_WIDTH = 350;
const COLUMN_GAP = 170;
const ROW_GAP = 54;
const MARGIN = 32;
const FIRST_PORT_Y = 63;
const PORT_STEP = 20;

function declaredPorts(flows: ReportFlow[], side: Side): Port[] {
  return flows.map((flow, row) =>
    typeof flow === 'object' && 'id' in flow
      ? { side, row, label: flow.label, id: flow.id }
      : { side, row, label: flow },
  );
}

function connectionPort(
  node: LayoutNode,
  id: string | undefined,
  side: Side,
  label: ReportText,
): Port {
  if (id !== undefined)
    return [...node.ports.left, ...node.ports.right].find((port) => port.id === id)!;
  const port = { side, row: node.ports[side].length, label };
  node.ports[side].push(port);
  return port;
}

function portPosition(node: LayoutNode, port: Port): Point {
  return {
    x: node.x + (port.side === 'left' ? 0 : NODE_WIDTH),
    y: node.y + FIRST_PORT_Y + port.row * PORT_STEP,
  };
}

function cornerPath(points: Point[]) {
  const path = [`M ${points[0].x} ${points[0].y}`];
  const offset = (vertex: Point, neighbor: Point) => {
    const dx = neighbor.x - vertex.x;
    const dy = neighbor.y - vertex.y;
    const radius = Math.min(4, (Math.abs(dx) + Math.abs(dy)) / 2);
    return `${vertex.x + Math.sign(dx) * radius} ${vertex.y + Math.sign(dy) * radius}`;
  };
  for (let index = 1; index < points.length - 1; index++) {
    const vertex = points[index];
    path.push(
      `L ${offset(vertex, points[index - 1])} Q ${vertex.x} ${vertex.y} ${offset(vertex, points[index + 1])}`,
    );
  }
  const last = points.at(-1)!;
  return `${path.join(' ')} L ${last.x} ${last.y}`;
}

function layout(model: Model) {
  const nodes = new Map<string, LayoutNode>(
    model.nodes.map((node) => [
      node.id,
      {
        ...node,
        ports: {
          left: declaredPorts(node.inputs, 'left'),
          right: declaredPorts(node.outputs, 'right'),
        },
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
    const startPort = connectionPort(source, edge.exchanges?.from, 'right', edge.label);
    const endPort = connectionPort(target, edge.exchanges?.to, 'left', edge.label);
    const connection = { ...edge, source, target, startPort, endPort };
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
    node.height = Math.max(
      120,
      FIRST_PORT_Y + 4 + PORT_STEP * Math.max(node.ports.left.length, node.ports.right.length),
    );
  }
  const routedEdges = edges.filter(
    (edge) =>
      edge.target.depth !== edge.source.depth + 1 ||
      edge.startPort.side !== 'right' ||
      edge.endPort.side !== 'left',
  );
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
  const forwardByColumn = new Map<number, LayoutEdge[]>();
  for (const edge of edges) {
    if (lanes.has(edge)) continue;
    const group = forwardByColumn.get(edge.source.depth);
    if (group) group.push(edge);
    else forwardByColumn.set(edge.source.depth, [edge]);
  }
  const tracks = new Map<LayoutEdge, number>();
  const trackOrder = (edge: LayoutEdge) => {
    const start = portPosition(edge.source, edge.startPort).y;
    const end = portPosition(edge.target, edge.endPort).y;
    return start < end ? -end : end;
  };
  for (const group of forwardByColumn.values()) {
    group.sort((a, b) => trackOrder(a) - trackOrder(b));
    group.forEach((edge, index) => {
      const inset = 32;
      const spacing = (COLUMN_GAP - 2 * inset) / (group.length + 1);
      tracks.set(edge, edge.source.x + NODE_WIDTH + inset + (index + 1) * spacing);
    });
  }
  return {
    nodes: [...nodes.values()],
    edges,
    lanes,
    tracks,
    width: 2 * MARGIN + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP,
    height: top + bodyHeight + MARGIN,
  };
}

export function graph(model: Model, cite: (ids: string[]) => string): string {
  const { nodes, edges, lanes, tracks, width, height } = layout(model);
  const object = (x: number, y: number, w: number, h: number, className: string, content: string) =>
    `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="${className}">${content}</div></foreignObject>`;
  const links = edges
    .map((edge) => {
      const start = portPosition(edge.source, edge.startPort);
      const end = portPosition(edge.target, edge.endPort);
      const lane = lanes.get(edge);
      const mid = tracks.get(edge)!;
      const startBend = start.x + (edge.startPort.side === 'right' ? 18 : -18);
      const endDirection = edge.endPort.side === 'right' ? 1 : -1;
      const endBend = end.x + endDirection * (end.x + endDirection * 18 === startBend ? 28 : 18);
      const route =
        lane === undefined
          ? [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]
          : [
              start,
              { x: startBend, y: start.y },
              { x: startBend, y: lane },
              { x: endBend, y: lane },
              { x: endBend, y: end.y },
              end,
            ];
      const d = cornerPath(route);
      const labelX = lane === undefined ? mid : (startBend + endBend) / 2;
      const labelY = lane ?? (start.y + end.y) / 2;
      const name = localized(edge.label);
      return `<a class="network-edge" href="#edge-${edge.id}" data-graph-link="edge-${edge.id}"><path class="edge-hit" d="${d}"/><path class="edge-path" d="${d}" marker-end="url(#network-arrow)"/>${object(labelX - 4, labelY - 4, 8, 8, 'network-edge-label', `<span class="network-visually-hidden">${name}</span>`)}</a>`;
    })
    .join('');

  const cards = nodes
    .map((node) => {
      const { x, y, id, height: size } = node;
      const label = localized(node.label);
      const reference =
        id === model.referenceNodeId
          ? object(
              x,
              y - 23,
              90,
              22,
              'network-reference',
              `<span aria-hidden="true">★</span><span class="network-visually-hidden">${ui('Reference process', '基准过程')}</span>`,
            )
          : '';
      const directions = object(
        x,
        y + 31,
        NODE_WIDTH,
        22,
        'network-node-directions',
        `<span>${ui('Input', '流入')}</span><span>${ui('Output', '流出')}</span>`,
      );
      const ports = [...node.ports.left, ...node.ports.right]
        .map((port) => {
          const position = portPosition(node, port);
          const labelX = port.side === 'left' ? x + 12 : x + NODE_WIDTH / 2;
          return `<rect class="node-port" x="${position.x - 4}" y="${position.y - 4}" width="8" height="8"/>${object(labelX, position.y - 9, NODE_WIDTH / 2 - 12, 18, `network-port-label ${port.side}`, localized(port.label))}`;
        })
        .join('');
      const title = `<path class="node-header" d="M ${x} ${y + 26} V ${y + 5} Q ${x} ${y} ${x + 5} ${y} H ${x + NODE_WIDTH - 5} Q ${x + NODE_WIDTH} ${y} ${x + NODE_WIDTH} ${y + 5} V ${y + 26} Z"/>${object(x + 6, y, NODE_WIDTH - 12, 26, 'network-node-title', label)}`;
      return `<a class="graph-node network-node" data-process-kind="${node.kind}" href="#node-${id}" data-graph-link="node-${id}"><rect class="node-body" x="${x}" y="${y}" width="${NODE_WIDTH}" height="${size}" rx="5"/>${title}${directions}${ports}${reference}</a>`;
    })
    .join('');

  const panel = `<div class="model-panel network-panel"><span class="network-title network-visually-hidden">${ui('Process network', '过程网络')}</span><div class="network-workspace"><div class="network-canvas"><div class="network-controls" hidden><button type="button" data-zoom="out" data-label-en="Zoom out" data-label-zh="缩小">−</button><output class="network-zoom">100%</output><button type="button" data-zoom="in" data-label-en="Zoom in" data-label-zh="放大">+</button><button type="button" data-zoom="fit">${ui('Fit', '适应画布')}</button><button type="button" class="network-expand"><span class="network-open">${ui('Full screen', '全屏')}</span><span class="network-close" hidden>${ui('Exit full screen', '退出全屏')}</span></button></div><div class="graph-scroll network-viewport" tabindex="0" data-label-en="Process graph" data-label-zh="过程图"><svg id="model-svg" class="network-svg" role="group" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><marker id="network-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="network-arrow"/></marker></defs>${links}${cards}</svg></div></div><aside class="network-inspector" hidden data-label-en="Selected model details" data-label-zh="所选模型详情"></aside></div><p class="legend network-legend">${ui('Select a process or connection. Drag to pan.', '点击过程或连线查看，拖动画布可平移。')}</p></div>`;
  const processes = nodes
    .map((node) => processDetail(node, node.incoming, node.outgoing, cite))
    .join('');
  const connections = edges
    .map((edge) => connectionDetail(edge, edge.source, edge.target))
    .join('');
  const first =
    model.referenceNodeId ?? (nodes.find((node) => node.kind === 'foreground') ?? nodes[0]).id;
  return `${panel}<div class="process-catalog" data-default-process="node-${first}"><button type="button" class="catalog-toggle" aria-controls="process-catalog-content" aria-expanded="true" hidden><span class="catalog-open-label">${ui('View complete process inventory', '查看完整过程清单')}</span><span class="catalog-close-label">${ui('Hide complete process inventory', '收起完整过程清单')}</span></button><div id="process-catalog-content" class="catalog-content"><h3 class="catalog-heading">${ui('Process inventory', '完整过程清单')}</h3>${processes}${connections}</div></div>`;
}
