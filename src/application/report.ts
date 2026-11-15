import { CommandInputError } from '../shared/command-result.js';

export type ReportText = string | { en?: string; zh?: string };
export type ReportCell = ReportText | number;
export type ReportSection = {
  title: ReportText;
  body?: ReportText;
  sources: string[];
  table?: { columns: ReportText[]; rows: ReportCell[][] };
};
export type ReportExchange = {
  id: string;
  label: ReportText;
  amount: number;
  unit: string;
  reference?: boolean;
  note?: ReportText;
};
export type ReportFlow = ReportText | ReportExchange;
export type ReportNode = {
  id: string;
  label: ReportText;
  kind: 'foreground' | 'background';
  details?: ReportText;
  inputs: ReportFlow[];
  outputs: ReportFlow[];
  sources: string[];
};
export type ReportEdge = {
  id: string;
  from: string;
  to: string;
  label: ReportText;
  amount?: number;
  unit?: string;
  details?: ReportText;
  exchanges?: { from: string; to: string };
};
export type ReportContribution = {
  title: ReportText;
  sources: string[];
  unit: string;
  total?: number;
  items: { label: ReportText; value: number; nodeId?: string }[];
};
export type ReportSensitivity = {
  title: ReportText;
  sources: string[];
  unit: string;
  baseline: number;
  scenarios: { label: ReportText; value: number; description?: ReportText }[];
};
export type ReportResult = {
  label: ReportText;
  value: number;
  unit: string;
  method?: ReportText;
  context?: ReportText;
  summary?: boolean;
};
export type ResearchReport = {
  title: ReportText;
  subtitle?: ReportText;
  language: 'en' | 'zh';
  sections: ReportSection[];
  model?: { nodes: ReportNode[]; edges: ReportEdge[]; referenceNodeId?: string };
  results: ReportResult[];
  analysis?: { contributions: ReportContribution[]; sensitivity: ReportSensitivity[] };
  interpretation?: { body: ReportText; sources: string[] };
  sources: { id: string; title: ReportText; url?: string; note?: ReportText }[];
  limitations: ReportText[];
};
export type ReportArtifact = { path: string; purpose: string; bytes: number };
export type ReportPort = (
  report: ResearchReport,
  output: string,
  force: boolean,
  input: string,
) => ReportArtifact;

function invalid(at: string, expected: string): never {
  throw new CommandInputError('REPORT_INPUT_INVALID', `${at}: expected ${expected}.`);
}
function object(value: unknown, at: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(at, 'an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!keys.includes(key)) invalid(`${at}.${key}`, `one of ${keys.join(', ')}`);
  return record;
}
function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'nonempty text');
  return value;
}
function text(value: unknown, at: string): ReportText {
  if (typeof value === 'string') return string(value, at);
  const record = object(value, at, ['en', 'zh']);
  if (!Object.keys(record).length) invalid(at, 'text or an en/zh text pair');
  for (const key of Object.keys(record)) string(record[key], `${at}.${key}`);
  return record as ReportText;
}
function optionalText(value: unknown, at: string): ReportText | undefined {
  return value === undefined ? undefined : text(value, at);
}
function list(value: unknown, at: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(at, 'an array');
  return value;
}
function number(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(at, 'a finite number');
  return value;
}
function id(value: unknown, at: string): string {
  const result = string(value, at);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(result))
    invalid(at, 'an ID with letters, digits, underscores or hyphens (1–80 characters)');
  return result;
}
function unique(ids: string[], at: string): void {
  if (new Set(ids).size !== ids.length) invalid(at, 'unique IDs');
}

function parseFlows(value: unknown, at: string): ReportFlow[] {
  return list(value, at).map((item, i) => {
    const path = `${at}[${i}]`;
    if (!item || typeof item !== 'object' || !('id' in item)) return text(item, path);
    const exchange = object(item, path, ['id', 'label', 'amount', 'unit', 'reference', 'note']);
    const reference = exchange.reference;
    if (reference !== undefined && typeof reference !== 'boolean')
      invalid(`${path}.reference`, 'a boolean');
    return {
      id: id(exchange.id, `${path}.id`),
      label: text(exchange.label, `${path}.label`),
      amount: number(exchange.amount, `${path}.amount`),
      unit: string(exchange.unit, `${path}.unit`),
      reference,
      note: optionalText(exchange.note, `${path}.note`),
    };
  });
}

function exchangeIds(flows: ReportFlow[]): string[] {
  return flows.flatMap((flow) => (typeof flow === 'object' && 'id' in flow ? [flow.id] : []));
}

function parseAnalysis(
  value: unknown,
  nodeIds: Set<string>,
  references: (value: unknown, at: string) => string[],
): ResearchReport['analysis'] {
  if (value === undefined) return undefined;
  const analysis = object(value, 'analysis', ['contributions', 'sensitivity']);
  const contributions = list(analysis.contributions, 'analysis.contributions').map((value, i) => {
    const at = `analysis.contributions[${i}]`;
    const block = object(value, at, ['title', 'unit', 'total', 'items', 'sources']);
    const items = list(block.items, `${at}.items`).map((value, j) => {
      const itemAt = `${at}.items[${j}]`;
      const item = object(value, itemAt, ['label', 'value', 'nodeId']);
      const nodeId = item.nodeId === undefined ? undefined : id(item.nodeId, `${itemAt}.nodeId`);
      if (nodeId !== undefined && !nodeIds.has(nodeId))
        invalid(`${itemAt}.nodeId`, 'a declared model node ID');
      return {
        label: text(item.label, `${itemAt}.label`),
        value: number(item.value, `${itemAt}.value`),
        nodeId,
      };
    });
    if (!items.length) invalid(`${at}.items`, 'at least one contribution');
    return {
      title: text(block.title, `${at}.title`),
      sources: references(block.sources, `${at}.sources`),
      unit: string(block.unit, `${at}.unit`),
      total: block.total === undefined ? undefined : number(block.total, `${at}.total`),
      items,
    };
  });
  const sensitivity = list(analysis.sensitivity, 'analysis.sensitivity').map((value, i) => {
    const at = `analysis.sensitivity[${i}]`;
    const block = object(value, at, ['title', 'unit', 'baseline', 'scenarios', 'sources']);
    const scenarios = list(block.scenarios, `${at}.scenarios`).map((value, j) => {
      const scenarioAt = `${at}.scenarios[${j}]`;
      const scenario = object(value, scenarioAt, ['label', 'value', 'description']);
      return {
        label: text(scenario.label, `${scenarioAt}.label`),
        value: number(scenario.value, `${scenarioAt}.value`),
        description: optionalText(scenario.description, `${scenarioAt}.description`),
      };
    });
    if (!scenarios.length) invalid(`${at}.scenarios`, 'at least one scenario');
    return {
      title: text(block.title, `${at}.title`),
      sources: references(block.sources, `${at}.sources`),
      unit: string(block.unit, `${at}.unit`),
      baseline: number(block.baseline, `${at}.baseline`),
      scenarios,
    };
  });
  return { contributions, sensitivity };
}

/** Presentation input only: no scientific verdict, remote lookup or translation. */
export function parseResearchReport(input: unknown): ResearchReport {
  const r = object(input, 'report', [
    'title',
    'subtitle',
    'language',
    'sections',
    'model',
    'results',
    'analysis',
    'interpretation',
    'sources',
    'limitations',
  ]);
  const language = r.language ?? 'zh';
  if (!['en', 'zh'].includes(language as string)) invalid('language', 'en or zh');
  const sources = list(r.sources, 'sources').map((value, i) => {
    const at = `sources[${i}]`;
    const s = object(value, at, ['id', 'title', 'url', 'note']);
    let url: string | undefined;
    if (s.url !== undefined) {
      url = string(s.url, `${at}.url`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        invalid(`${at}.url`, 'an absolute HTTP(S) URL');
      }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
        invalid(`${at}.url`, 'an HTTP(S) URL without credentials');
    }
    return {
      id: id(s.id, `${at}.id`),
      title: text(s.title, `${at}.title`),
      url,
      note: optionalText(s.note, `${at}.note`),
    };
  });
  unique(
    sources.map((s) => s.id),
    'sources',
  );
  const sourceIds = new Set(sources.map((s) => s.id));
  const references = (value: unknown, at: string) =>
    list(value, at).map((ref) => {
      const key = id(ref, at);
      if (!sourceIds.has(key)) invalid(at, 'a declared source ID');
      return key;
    });
  let interpretation: ResearchReport['interpretation'];
  if (r.interpretation !== undefined) {
    const value = object(r.interpretation, 'interpretation', ['body', 'sources']);
    interpretation = {
      body: text(value.body, 'interpretation.body'),
      sources: references(value.sources, 'interpretation.sources'),
    };
  }
  const sections = list(r.sections, 'sections').map((value, i) => {
    const at = `sections[${i}]`;
    const s = object(value, at, ['title', 'body', 'sources', 'table']);
    let table: ReportSection['table'];
    if (s.table !== undefined) {
      const t = object(s.table, `${at}.table`, ['columns', 'rows']);
      const columns = list(t.columns, `${at}.table.columns`).map((v) =>
        text(v, `${at}.table.columns`),
      );
      if (!columns.length) invalid(`${at}.table.columns`, 'at least one column');
      const rows = list(t.rows, `${at}.table.rows`).map((row) => {
        const cells = list(row, `${at}.table.row`);
        if (cells.length !== columns.length) invalid(`${at}.table.row`, 'one cell per column');
        return cells.map((cell) => (typeof cell === 'number' ? number(cell, at) : text(cell, at)));
      });
      table = { columns, rows };
    }
    return {
      title: text(s.title, `${at}.title`),
      body: optionalText(s.body, `${at}.body`),
      sources: references(s.sources, `${at}.sources`),
      table,
    };
  });
  let model: ResearchReport['model'];
  if (r.model !== undefined) {
    const m = object(r.model, 'model', ['nodes', 'edges', 'referenceNodeId']);
    const nodes = list(m.nodes, 'model.nodes').map((value, i): ReportNode => {
      const at = `model.nodes[${i}]`;
      const n = object(value, at, [
        'id',
        'label',
        'kind',
        'details',
        'inputs',
        'outputs',
        'sources',
      ]);
      const kind = n.kind ?? 'foreground';
      if (kind !== 'foreground' && kind !== 'background')
        invalid(`${at}.kind`, 'foreground or background');
      const inputs = parseFlows(n.inputs, `${at}.inputs`);
      const outputs = parseFlows(n.outputs, `${at}.outputs`);
      unique(exchangeIds([...inputs, ...outputs]), `${at}.exchanges`);
      return {
        id: id(n.id, `${at}.id`),
        label: text(n.label, `${at}.label`),
        kind,
        details: optionalText(n.details, `${at}.details`),
        inputs,
        outputs,
        sources: references(n.sources, `${at}.sources`),
      };
    });
    if (!nodes.length) invalid('model.nodes', 'at least one node');
    unique(
      nodes.map((n) => n.id),
      'model.nodes',
    );
    const exchangesByNode = new Map(
      nodes.map((node) => [node.id, new Set(exchangeIds([...node.inputs, ...node.outputs]))]),
    );
    const referenceNodeId =
      m.referenceNodeId === undefined ? undefined : id(m.referenceNodeId, 'model.referenceNodeId');
    if (referenceNodeId !== undefined && !exchangesByNode.has(referenceNodeId))
      invalid('model.referenceNodeId', 'an existing node ID');
    const edges = list(m.edges, 'model.edges').map((value, i): ReportEdge => {
      const at = `model.edges[${i}]`;
      const e = object(value, at, [
        'id',
        'from',
        'to',
        'label',
        'amount',
        'unit',
        'details',
        'exchanges',
      ]);
      const from = id(e.from, `${at}.from`),
        to = id(e.to, `${at}.to`);
      const source = exchangesByNode.get(from),
        target = exchangesByNode.get(to);
      if (!source || !target) invalid(at, 'existing from/to node IDs');
      let exchanges: ReportEdge['exchanges'];
      if (e.exchanges !== undefined) {
        const ends = object(e.exchanges, `${at}.exchanges`, ['from', 'to']);
        const sourceId = id(ends.from, `${at}.exchanges.from`);
        const targetId = id(ends.to, `${at}.exchanges.to`);
        if (!source.has(sourceId))
          invalid(`${at}.exchanges.from`, 'an exchange ID in the source node');
        if (!target.has(targetId))
          invalid(`${at}.exchanges.to`, 'an exchange ID in the target node');
        exchanges = { from: sourceId, to: targetId };
      }
      return {
        id: id(e.id, `${at}.id`),
        from,
        to,
        label: text(e.label, `${at}.label`),
        amount: e.amount === undefined ? undefined : number(e.amount, `${at}.amount`),
        unit: e.unit === undefined ? undefined : string(e.unit, `${at}.unit`),
        details: optionalText(e.details, `${at}.details`),
        exchanges,
      };
    });
    unique(
      edges.map((e) => e.id),
      'model.edges',
    );
    model = { nodes, edges, referenceNodeId };
  }
  const results = list(r.results, 'results').map((value, i) => {
    const at = `results[${i}]`;
    const v = object(value, at, ['label', 'value', 'unit', 'method', 'context', 'summary']);
    if (v.summary !== undefined && typeof v.summary !== 'boolean')
      invalid(`${at}.summary`, 'a boolean');
    return {
      label: text(v.label, `${at}.label`),
      value: number(v.value, `${at}.value`),
      unit: string(v.unit, `${at}.unit`),
      method: optionalText(v.method, `${at}.method`),
      context: optionalText(v.context, `${at}.context`),
      summary: v.summary,
    };
  });
  return {
    title: text(r.title, 'title'),
    subtitle: optionalText(r.subtitle, 'subtitle'),
    language: language as ResearchReport['language'],
    sections,
    model,
    results,
    analysis: parseAnalysis(r.analysis, new Set(model?.nodes.map((node) => node.id)), references),
    interpretation,
    sources,
    limitations: list(r.limitations, 'limitations').map((v) => text(v, 'limitations')),
  };
}
