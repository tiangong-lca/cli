import { CommandInputError } from '../shared/command-result.js';

export type ReportText = string | { en?: string; zh?: string };
export type ReportCell = ReportText | number;
export type ReportSection = {
  title: ReportText;
  body?: ReportText;
  sources: string[];
  table?: { columns: ReportText[]; rows: ReportCell[][] };
};
export type ReportNode = {
  id: string;
  label: ReportText;
  kind: 'foreground' | 'background';
  details?: ReportText;
  inputs: ReportText[];
  outputs: ReportText[];
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
};
export type ResearchReport = {
  title: ReportText;
  subtitle?: ReportText;
  language: 'en' | 'zh' | 'bilingual';
  sections: ReportSection[];
  model?: { nodes: ReportNode[]; edges: ReportEdge[] };
  results: { label: ReportText; value: number; unit: string; method?: ReportText }[];
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

/** Presentation input only: no scientific verdict, remote lookup or translation. */
export function parseResearchReport(input: unknown): ResearchReport {
  const r = object(input, 'report', [
    'title',
    'subtitle',
    'language',
    'sections',
    'model',
    'results',
    'sources',
    'limitations',
  ]);
  const language = r.language ?? 'bilingual';
  if (!['en', 'zh', 'bilingual'].includes(language as string))
    invalid('language', 'en, zh or bilingual');
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
    const m = object(r.model, 'model', ['nodes', 'edges']);
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
      return {
        id: id(n.id, `${at}.id`),
        label: text(n.label, `${at}.label`),
        kind,
        details: optionalText(n.details, `${at}.details`),
        inputs: list(n.inputs, at).map((v) => text(v, at)),
        outputs: list(n.outputs, at).map((v) => text(v, at)),
        sources: references(n.sources, `${at}.sources`),
      };
    });
    if (!nodes.length) invalid('model.nodes', 'at least one node');
    unique(
      nodes.map((n) => n.id),
      'model.nodes',
    );
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = list(m.edges, 'model.edges').map((value, i): ReportEdge => {
      const at = `model.edges[${i}]`;
      const e = object(value, at, ['id', 'from', 'to', 'label', 'amount', 'unit', 'details']);
      const from = id(e.from, `${at}.from`),
        to = id(e.to, `${at}.to`);
      if (!nodeIds.has(from) || !nodeIds.has(to)) invalid(at, 'existing from/to node IDs');
      return {
        id: id(e.id, `${at}.id`),
        from,
        to,
        label: text(e.label, `${at}.label`),
        amount: e.amount === undefined ? undefined : number(e.amount, `${at}.amount`),
        unit: e.unit === undefined ? undefined : string(e.unit, `${at}.unit`),
        details: optionalText(e.details, `${at}.details`),
      };
    });
    unique(
      edges.map((e) => e.id),
      'model.edges',
    );
    model = { nodes, edges };
  }
  const results = list(r.results, 'results').map((value, i) => {
    const at = `results[${i}]`;
    const v = object(value, at, ['label', 'value', 'unit', 'method']);
    return {
      label: text(v.label, `${at}.label`),
      value: number(v.value, `${at}.value`),
      unit: string(v.unit, `${at}.unit`),
      method: optionalText(v.method, `${at}.method`),
    };
  });
  return {
    title: text(r.title, 'title'),
    subtitle: optionalText(r.subtitle, 'subtitle'),
    language: language as ResearchReport['language'],
    sections,
    model,
    results,
    sources,
    limitations: list(r.limitations, 'limitations').map((v) => text(v, 'limitations')),
  };
}
