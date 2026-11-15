import type { ReportEdge, ReportFlow, ReportNode } from '../../application/report.js';
import { escape, localized, refs, ui } from './text.js';

function exchangeTable(
  heading: string,
  flows: ReportFlow[],
  connected: Map<string, Set<ReportEdge>>,
  references = false,
): string {
  if (!flows.length) return '';
  const rows = flows.map((flow) => {
    if (typeof flow === 'string' || !('id' in flow)) {
      return `<tr><td colspan="3">${localized(flow)}</td></tr>`;
    }
    const edges = [...(connected.get(flow.id) ?? [])];
    let label = localized(flow.label);
    if (edges.length === 1) {
      label = `<a class="exchange-link" href="#edge-${edges[0].id}">${label}</a>`;
    } else if (edges.length > 1) {
      label += `<ul class="exchange-links">${edges.map((edge) => `<li><a class="exchange-link" href="#edge-${edge.id}">${localized(edge.label)}</a></li>`).join('')}</ul>`;
    }
    return `<tr data-exchange-id="${flow.id}"><th scope="row">${label}${flow.note ? `<small>${localized(flow.note)}</small>` : ''}</th><td class="exchange-amount">${escape(flow.amount)}</td><td class="exchange-unit">${escape(flow.unit)}</td></tr>`;
  });
  const className = references ? 'exchange-table reference-table' : 'exchange-table';
  return `<table class="${className}"><caption>${heading}</caption><thead><tr><th scope="col">${ui('Flow', '流名称')}</th><th scope="col">${ui('Amount', '用量')}</th><th scope="col">${ui('Unit', '单位')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function processKind(node: ReportNode): string {
  return node.kind === 'background'
    ? ui('Background process', '背景过程')
    : ui('Foreground process', '前景过程');
}

export function processDetail(
  node: ReportNode,
  incoming: ReportEdge[],
  outgoing: ReportEdge[],
): string {
  const connections = new Map<string, Set<ReportEdge>>();
  const connect = (port: 'from' | 'to', edges: ReportEdge[]) => {
    for (const edge of edges) {
      const exchange = edge.exchanges?.[port];
      if (exchange === undefined) continue;
      const links = connections.get(exchange);
      if (links) links.add(edge);
      else connections.set(exchange, new Set([edge]));
    }
  };
  connect('to', incoming);
  connect('from', outgoing);
  const isReference = (flow: ReportFlow) =>
    typeof flow === 'object' && 'reference' in flow && flow.reference === true;
  const input = node.inputs.filter((flow) => !isReference(flow));
  const output = node.outputs.filter((flow) => !isReference(flow));
  const referenceIn = node.inputs.filter(isReference);
  const referenceOut = node.outputs.filter(isReference);
  return `<article class="detail process-detail" id="node-${node.id}" tabindex="-1"><header class="process-header"><div class="detail-kicker">${processKind(node)}</div><h3>${localized(node.label)}</h3>${node.details ? `<p>${localized(node.details)}</p>` : ''}</header>${exchangeTable(ui('Reference input', '参考输入'), referenceIn, connections, true)}${exchangeTable(ui('Reference output', '参考输出'), referenceOut, connections, true)}${exchangeTable(ui('Inputs', '输入流'), input, connections)}${exchangeTable(ui('Outputs', '输出流'), output, connections)}${refs(node.sources)}</article>`;
}

export function connectionDetail(edge: ReportEdge, source: ReportNode, target: ReportNode): string {
  const endpoints = `<a href="#node-${source.id}">${localized(source.label)}</a><span aria-hidden="true"> → </span><a href="#node-${target.id}">${localized(target.label)}</a>`;
  const amount =
    edge.amount === undefined && edge.unit === undefined
      ? ''
      : `<p class="connection-amount">${escape(edge.amount ?? '—')} ${escape(edge.unit ?? '')}</p>`;
  const metadata = edge.exchanges
    ? ` data-from-node="${source.id}" data-to-node="${target.id}" data-from-exchange="${edge.exchanges.from}" data-to-exchange="${edge.exchanges.to}"`
    : '';
  return `<article class="detail connection" id="edge-${edge.id}" tabindex="-1"${metadata}><h3>${localized(edge.label)}</h3><div class="connection-route">${endpoints}</div>${amount}${edge.details ? `<p>${localized(edge.details)}</p>` : ''}</article>`;
}
