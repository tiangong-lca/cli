import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact, writeTextArtifact } from './artifacts.js';
import { CliError } from '../shared/errors.js';
import {
  firstNonEmpty,
  isRecord,
  materializeDatasetRows,
  trimToken,
  type JsonObject,
} from './dataset-local.js';
import { deriveLifecyclemodelJsonTg } from './lifecyclemodel-bundle-save.js';

export type LifecyclemodelGraphFormat = 'json' | 'dot' | 'svg' | 'all';

export type LifecyclemodelGraphFinding = {
  severity: 'error' | 'warning';
  code: string;
  model_index: number;
  model_id: string | null;
  path: string;
  message: string;
};

export type LifecyclemodelGraphModelReport = {
  index: number;
  id: string | null;
  version: string | null;
  node_count: number;
  edge_count: number;
  finding_count: number;
  files: {
    graph_json: string | null;
    dot: string | null;
    svg: string | null;
  };
};

export type LifecyclemodelGraphReport = {
  generated_at_utc: string;
  input_path: string;
  out_dir: string;
  format: LifecyclemodelGraphFormat;
  check_connections: boolean;
  status: 'completed' | 'completed_with_findings';
  counts: {
    models: number;
    nodes: number;
    edges: number;
    findings: number;
  };
  files: {
    report: string;
    findings: string;
  };
  models: LifecyclemodelGraphModelReport[];
  findings: LifecyclemodelGraphFinding[];
};

export type RunLifecyclemodelGraphOptions = {
  inputPath: string;
  outDir: string;
  format?: string | null;
  checkConnections?: boolean | null;
  rawInput?: unknown;
  now?: Date;
};

type XflowNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: JsonObject;
};

type XflowEdge = {
  id: string;
  source: { cell?: string };
  target: { cell?: string };
  data: JsonObject;
};

function normalizeFormat(value: string | null | undefined): LifecyclemodelGraphFormat {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'all';
  }
  if (
    normalized === 'json' ||
    normalized === 'dot' ||
    normalized === 'svg' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  throw new CliError('Expected --format to be json, dot, svg, or all.', {
    code: 'LIFECYCLEMODEL_GRAPH_FORMAT_INVALID',
    exitCode: 2,
    details: value,
  });
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function normalizeNodes(jsonTg: JsonObject): XflowNode[] {
  const xflow = isRecord(jsonTg.xflow) ? jsonTg.xflow : {};
  return asArray(xflow.nodes)
    .filter(isRecord)
    .map((node, index) => ({
      id: firstNonEmpty(node.id, `node-${index + 1}`)!,
      x: typeof node.x === 'number' ? node.x : index * 320,
      y: typeof node.y === 'number' ? node.y : 0,
      width: typeof node.width === 'number' ? node.width : 260,
      height: typeof node.height === 'number' ? node.height : 90,
      data: isRecord(node.data) ? node.data : {},
    }));
}

function normalizeEdges(jsonTg: JsonObject): XflowEdge[] {
  const xflow = isRecord(jsonTg.xflow) ? jsonTg.xflow : {};
  return asArray(xflow.edges)
    .filter(isRecord)
    .map((edge, index) => ({
      id: firstNonEmpty(edge.id, `edge-${index + 1}`)!,
      source: isRecord(edge.source) ? edge.source : {},
      target: isRecord(edge.target) ? edge.target : {},
      data: isRecord(edge.data) ? edge.data : {},
    }));
}

function labelFromNode(node: XflowNode): string {
  const label = node.data.label;
  if (typeof label === 'string') {
    return label;
  }
  if (isRecord(label) && Array.isArray(label.baseName)) {
    const first = label.baseName.find(isRecord);
    const text = isRecord(first) ? trimToken(first['#text']) : null;
    if (text) {
      return text;
    }
  }
  return firstNonEmpty(node.data.id, node.id)!;
}

function escapeDot(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function buildDot(modelId: string | null, nodes: XflowNode[], edges: XflowEdge[]): string {
  const lines = ['digraph lifecyclemodel {', '  rankdir=LR;', '  node [shape=box];'];
  if (modelId) {
    lines.push(`  label="${escapeDot(modelId)}";`);
  }
  nodes.forEach((node) => {
    lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(labelFromNode(node))}"];`);
  });
  edges.forEach((edge) => {
    const source = firstNonEmpty(edge.source.cell, 'unknown-source')!;
    const target = firstNonEmpty(edge.target.cell, 'unknown-target')!;
    const connection = isRecord(edge.data.connection) ? edge.data.connection : {};
    const outputExchange = isRecord(connection.outputExchange) ? connection.outputExchange : {};
    const flowUuid = firstNonEmpty(outputExchange['@flowUUID'], edge.id);
    lines.push(
      `  "${escapeDot(source)}" -> "${escapeDot(target)}" [label="${escapeDot(flowUuid ?? '')}"];`,
    );
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function buildSvg(nodes: XflowNode[], edges: XflowEdge[]): string {
  const padding = 32;
  const maxX = Math.max(...nodes.map((node) => node.x + node.width), 320);
  const maxY = Math.max(...nodes.map((node) => node.y + node.height), 180);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX + padding * 2}" height="${
      maxY + padding * 2
    }" viewBox="0 0 ${maxX + padding * 2} ${maxY + padding * 2}">`,
    '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#444"/></marker></defs>',
    '<rect width="100%" height="100%" fill="#fff"/>',
  ];

  edges.forEach((edge) => {
    const source = nodeById.get(firstNonEmpty(edge.source.cell, '') ?? '');
    const target = nodeById.get(firstNonEmpty(edge.target.cell, '') ?? '');
    if (!source || !target) {
      return;
    }
    const x1 = padding + source.x + source.width;
    const y1 = padding + source.y + source.height / 2;
    const x2 = padding + target.x;
    const y2 = padding + target.y + target.height / 2;
    lines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#444" stroke-width="2" marker-end="url(#arrow)"/>`,
    );
  });

  nodes.forEach((node) => {
    const x = padding + node.x;
    const y = padding + node.y;
    lines.push(
      `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="4" fill="#f8fafc" stroke="#334155"/>`,
      `<text x="${x + 12}" y="${y + 28}" font-family="Arial, sans-serif" font-size="14" fill="#111827">${escapeXml(
        labelFromNode(node),
      )}</text>`,
      `<text x="${x + 12}" y="${y + 52}" font-family="Arial, sans-serif" font-size="12" fill="#475569">${escapeXml(
        firstNonEmpty(node.data.id, node.id)!,
      )}</text>`,
    );
  });

  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

function checkEdges(
  modelIndex: number,
  modelId: string | null,
  nodes: XflowNode[],
  edges: XflowEdge[],
): LifecyclemodelGraphFinding[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const findings: LifecyclemodelGraphFinding[] = [];
  edges.forEach((edge, index) => {
    const source = firstNonEmpty(edge.source.cell);
    const target = firstNonEmpty(edge.target.cell);
    if (!source || !nodeIds.has(source)) {
      findings.push({
        severity: 'error',
        code: 'missing_source_process_instance',
        model_index: modelIndex,
        model_id: modelId,
        path: `xflow.edges.${index}.source.cell`,
        message: `Edge ${edge.id} references missing source process instance ${source ?? '<empty>'}.`,
      });
    }
    if (!target || !nodeIds.has(target)) {
      findings.push({
        severity: 'error',
        code: 'missing_target_process_instance',
        model_index: modelIndex,
        model_id: modelId,
        path: `xflow.edges.${index}.target.cell`,
        message: `Edge ${edge.id} references missing target process instance ${target ?? '<empty>'}.`,
      });
    }
  });
  return findings;
}

function safeStem(index: number, id: string | null): string {
  const base = id ? id.replace(/[^A-Za-z0-9_.-]+/gu, '_') : `model-${index + 1}`;
  return `${String(index + 1).padStart(3, '0')}-${base}`;
}

function wants(
  format: LifecyclemodelGraphFormat,
  target: Exclude<LifecyclemodelGraphFormat, 'all'>,
): boolean {
  return format === 'all' || format === target;
}

export async function runLifecyclemodelGraph(
  options: RunLifecyclemodelGraphOptions,
): Promise<LifecyclemodelGraphReport> {
  if (!options.outDir) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'LIFECYCLEMODEL_GRAPH_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  const format = normalizeFormat(options.format);
  const outDir = path.resolve(options.outDir);
  const rows = materializeDatasetRows(options.inputPath, options.rawInput);
  const findings: LifecyclemodelGraphFinding[] = [];
  const models: LifecyclemodelGraphModelReport[] = [];

  rows.forEach((row, index) => {
    const graph = deriveLifecyclemodelJsonTg(row.payload);
    const nodes = normalizeNodes(graph);
    const edges = normalizeEdges(graph);
    const modelFindings =
      options.checkConnections === true ? checkEdges(index, row.id, nodes, edges) : [];
    findings.push(...modelFindings);
    const stem = safeStem(index, row.id);
    const graphJsonPath = wants(format, 'json')
      ? path.join(outDir, 'graphs', `${stem}.json`)
      : null;
    const dotPath = wants(format, 'dot') ? path.join(outDir, 'graphs', `${stem}.dot`) : null;
    const svgPath = wants(format, 'svg') ? path.join(outDir, 'graphs', `${stem}.svg`) : null;

    if (graphJsonPath) {
      writeJsonArtifact(graphJsonPath, graph);
    }
    if (dotPath) {
      writeTextArtifact(dotPath, buildDot(row.id, nodes, edges));
    }
    if (svgPath) {
      writeTextArtifact(svgPath, buildSvg(nodes, edges));
    }

    models.push({
      index,
      id: row.id,
      version: row.version,
      node_count: nodes.length,
      edge_count: edges.length,
      finding_count: modelFindings.length,
      files: {
        graph_json: graphJsonPath,
        dot: dotPath,
        svg: svgPath,
      },
    });
  });

  const files = {
    report: path.join(outDir, 'outputs', 'graph-report.json'),
    findings: path.join(outDir, 'outputs', 'findings.jsonl'),
  };
  const report: LifecyclemodelGraphReport = {
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    input_path: path.resolve(options.inputPath),
    out_dir: outDir,
    format,
    check_connections: options.checkConnections === true,
    status: findings.length > 0 ? 'completed_with_findings' : 'completed',
    counts: {
      models: models.length,
      nodes: models.reduce((sum, model) => sum + model.node_count, 0),
      edges: models.reduce((sum, model) => sum + model.edge_count, 0),
      findings: findings.length,
    },
    files,
    models,
    findings,
  };
  writeJsonArtifact(files.report, report);
  writeJsonLinesArtifact(files.findings, findings);
  return report;
}

export const __testInternals = {
  asArray,
  buildDot,
  buildSvg,
  checkEdges,
  labelFromNode,
  normalizeFormat,
  normalizeNodes,
  normalizeEdges,
  safeStem,
};
