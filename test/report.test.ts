import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseResearchReport } from '../src/application/report.js';
import { renderResearchReport } from '../src/lib/report/render.js';
import { writeResearchReport } from '../src/adapters/report.js';
import { runReportCommand } from '../src/commands/report.js';
import { executeCli } from '../src/cli.js';

const example = JSON.parse(
  readFileSync(new URL('../assets/report/example.json', import.meta.url), 'utf8'),
);
test('report validates a presentation projection without scientific, revision or online prerequisites', () => {
  const original = JSON.stringify(example);
  const report = parseResearchReport(example);
  assert.equal(JSON.stringify(example), original);
  assert.equal(report.model!.nodes.length, 3);
  assert.equal(report.results[0].value, 2.4);
  assert.equal(report.sections[1].table!.rows[0][1], 2);
  const minimal = parseResearchReport({ title: 'Editable research note' });
  assert.equal(minimal.language, 'zh');
  assert.equal(minimal.model, undefined);
  assert.deepEqual(minimal.sections, []);
  assert.ok(!Object.hasOwn(minimal, 'hash'));
});

test('report rejects malformed shapes, dangling graph/evidence links and unsafe source URLs before rendering', () => {
  const cases: unknown[] = [
    null,
    [],
    {},
    { title: '' },
    { title: 1 },
    { title: {} },
    { title: { fr: 'x' } },
    { title: { en: '' } },
    { title: 'x', hash: 'invented' },
    { title: 'x', language: 'fr' },
    { title: 'x', language: 'bilingual' },
  ];
  const variants = [
    { sections: 'text' },
    { sections: [null] },
    { sections: [{ title: 'x', body: 2 }] },
    { sections: [{ title: 'x', sources: ['missing'] }] },
    { sections: [{ title: 'x', table: {} }] },
    { sections: [{ title: 'x', table: { columns: ['a'], rows: [[]] } }] },
    { sections: [{ title: 'x', table: { columns: ['a'], rows: ['bad'] } }] },
    { sections: [{ title: 'x', table: { columns: ['a'], rows: [[Infinity]] } }] },
    { sources: [{ id: 'bad id', title: 'x' }] },
    {
      sources: [
        { id: 'a', title: 'x' },
        { id: 'a', title: 'y' },
      ],
    },
    ...[
      'relative',
      'javascript:alert(1)',
      'file:///secret',
      'data:text/html,test',
      'https://user:password@example.org',
    ].map((url) => ({ sources: [{ id: 'a', title: 'x', url }] })),
    { model: {} },
    { model: { nodes: [{ id: 'a', label: 'x', kind: 'guess' }] } },
    {
      model: {
        nodes: [
          { id: 'a', label: 'x' },
          { id: 'a', label: 'y' },
        ],
      },
    },
    { model: { nodes: [{ id: 'a', label: 'x', sources: ['missing'] }] } },
    {
      model: {
        nodes: [{ id: 'a', label: 'x' }],
        edges: [{ id: 'e', from: 'a', to: 'b', label: 'x' }],
      },
    },
    {
      model: {
        nodes: [{ id: 'a', label: 'x' }],
        edges: Array(2).fill({ id: 'e', from: 'a', to: 'a', label: 'x' }),
      },
    },
    { results: [{ label: 'x', value: NaN, unit: 'kg' }] },
    { results: [{ label: 'x', value: '1', unit: 'kg' }] },
    { limitations: [false] },
  ];
  cases.push(...variants.map((v) => ({ title: 'x', ...v })));
  for (const input of cases)
    assert.throws(
      () => parseResearchReport(input),
      { code: 'REPORT_INPUT_INVALID' },
      JSON.stringify(input),
    );
});

test('renderer keeps facts and complete details in one deterministic offline escaped HTML artifact', () => {
  const report = parseResearchReport(example);
  const html = renderResearchReport(report);
  assert.equal(html, renderResearchReport(report));
  assert.match(html, /id="model-svg"/u);
  assert.match(html, /id="node-grid"/u);
  assert.match(html, /id="edge-power"/u);
  assert.match(html, /href="#source-inventory"/u);
  assert.match(html, /href="#source-inventory"><span aria-hidden="true">\[<\/span>2/u);
  assert.doesNotMatch(html, /\[inventory\]/u);
  assert.match(html, /2\.4/u);
  assert.match(html, /@media print/u);
  assert.match(html, /tr\[hidden\]/u);
  assert.match(html, /script-src 'sha256-/u);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/u);
  const hostile = '</script><img src="https://evil.invalid" onerror="alert(1)">&\'';
  const variant = parseResearchReport({
    title: hostile,
    language: 'zh',
    sections: [
      { title: { zh: '中文' }, table: { columns: ['text'], rows: [[{ en: hostile }]] } },
      { title: 'Empty section' },
    ],
    sources: [{ id: 'one', title: 'A source' }],
    model: {
      nodes: [{ id: 'n', label: 'N' }],
      edges: [
        { id: 'loop', from: 'n', to: 'n', label: 'Recirculation', amount: 0 },
        { id: 'other', from: 'n', to: 'n', label: 'Unquantified' },
        { id: 'known-unit', from: 'n', to: 'n', label: 'Quantity pending', unit: 'kg' },
      ],
    },
    results: [{ label: 'Negative', value: -2, unit: 'kg' }],
  });
  const safe = renderResearchReport(variant);
  const images = safe.match(/<img\b[^>]*>/gu) ?? [];
  assert.equal(images.length, 1);
  assert.match(images[0], /src="data:image\/svg\+xml;base64,/u);
  assert.match(safe, /<header class="hero" style="--cover-art:url\('data:image\/webp;base64,/u);
  assert.doesNotMatch(safe, /<img[^>]*(evil\.invalid|onerror=)/u);
  assert.match(safe, /&lt;\/script&gt;/u);
  assert.match(safe, /&quot;/u);
  assert.match(safe, /&#39;/u);
  assert.match(safe, /data-only=" \[EN\]"/u);
  assert.match(safe, /data-language="zh"/u);
  assert.match(safe, />0 <\/p>/u);
  assert.match(safe, />— kg<\/p>/u);
  assert.doesNotMatch(safe, /Assessment method/u);
  assert.match(
    renderResearchReport(parseResearchReport({ title: { en: 'Only English' } })),
    /<title>Only English<\/title>/u,
  );
  assert.match(
    renderResearchReport(parseResearchReport({ title: { en: 'Only English' }, language: 'en' })),
    /data-language="en"/u,
  );
});

test('overview uses explicit result selection and charts require supplied analysis', () => {
  const baseline = { label: 'Baseline result', value: 4, unit: 'kg', method: 'Method detail' };
  const alternate = { label: 'Other result', value: 7, unit: 'kg' };
  const html = (results: unknown[], analysis?: unknown) =>
    renderResearchReport(
      parseResearchReport({
        title: 'Case',
        model: example.model,
        sources: example.sources,
        results,
        analysis,
      }),
    );
  const overview = (output: string) =>
    output.match(/<section class="result-summary"[^>]*>.*?<\/section>/u)?.[0];
  assert.match(overview(html([baseline]))!, /Baseline result/u);
  assert.equal(overview(html([{ ...baseline, summary: false }])), undefined);
  assert.equal(overview(html([baseline, alternate])), undefined);
  const selected = overview(html([{ ...baseline, summary: true }, alternate]))!;
  assert.match(selected, /Baseline result/u);
  assert.doesNotMatch(selected, /Other result|Method detail/u);
  assert.doesNotMatch(html([baseline]), /id="(?:contribution|sensitivity)-/u);

  const output = html([baseline], {
    contributions: [
      {
        title: 'Signed shares',
        unit: 'kg',
        total: 4,
        items: [{ label: 'Supply', value: -2, nodeId: 'grid' }],
      },
      { title: 'Absolute contributions', unit: 'kg', items: [{ label: 'Demand', value: 6 }] },
      {
        title: 'Zero total',
        unit: 'kg',
        total: 0,
        items: [{ label: 'No contribution', value: 0 }],
      },
      {
        title: 'Large contribution',
        unit: 'kg',
        total: 1e-300,
        items: [{ label: 'Large value', value: 1e300 }],
      },
    ],
    sensitivity: [
      {
        title: 'Scenarios',
        unit: 'kg',
        baseline: 4,
        scenarios: [{ label: 'Option', value: 5, description: 'Changed input' }],
      },
      {
        title: 'Zero baseline',
        unit: 'kg',
        baseline: 0,
        scenarios: [
          { label: 'Increase', value: 2 },
          { label: 'Decrease', value: -2 },
        ],
      },
      {
        title: 'Extreme values',
        unit: 'kg',
        baseline: -1e308,
        scenarios: [{ label: 'Extreme', value: 1e308 }],
      },
    ],
  });
  assert.match(output, /href="#node-grid" data-graph-link="node-grid">Supply/u);
  assert.match(output, /-50%/u);
  assert.match(output, /\+25%/u);
  assert.match(output, /Δ \+2 kg/u);
  assert.match(output, /Changed input/u);
  assert.doesNotMatch(output, /(?:NaN|Infinity)%/u);

  for (const [value, message] of [
    [
      { contributions: [{ title: 'Empty', unit: 'kg', items: [] }] },
      'analysis.contributions[0].items',
    ],
    [
      {
        contributions: [
          { title: 'Missing', unit: 'kg', items: [{ label: 'X', value: 1, nodeId: 'missing' }] },
        ],
      },
      'analysis.contributions[0].items[0].nodeId',
    ],
    [
      { sensitivity: [{ title: 'Empty', unit: 'kg', baseline: 1, scenarios: [] }] },
      'analysis.sensitivity[0].scenarios',
    ],
  ] as const) {
    assert.throws(
      () => html([], value),
      (error: Error) => error.message.includes(message),
    );
  }
  assert.throws(() => html([{ ...baseline, summary: 'yes' }]), { code: 'REPORT_INPUT_INVALID' });
});

test('model rendering keeps cycles and all supplied inputs without assuming input order', () => {
  const html = renderResearchReport(
    parseResearchReport({
      title: 'Material cycle',
      model: {
        nodes: [
          {
            id: 'end',
            label: 'Treatment',
            inputs: Array.from({ length: 6 }, (_, index) => `Material ${index + 1}`),
          },
          { id: 'start', label: 'Production' },
          { id: 'recovery', label: 'Recovery' },
        ],
        edges: [
          { id: 'treat', from: 'start', to: 'end', label: 'Waste' },
          { id: 'recover', from: 'end', to: 'recovery', label: 'Recovery feed' },
          { id: 'return', from: 'recovery', to: 'start', label: 'Recovered material' },
        ],
      },
    }),
  );
  const diagram = html.match(/<svg id="model-svg"[\s\S]+?<\/svg>/u)![0];
  assert.equal((diagram.match(/class="network-edge"/gu) ?? []).length, 3);
  assert.doesNotMatch(diagram, /Material 6|NaN/u);
  assert.match(html, /<td colspan="3">Material 6<\/td>/u);
});

test('structured exchanges render independent quantities and explicit links, including reversed directions', () => {
  const out = { id: 'pivot', label: 'Waste treatment', amount: -1, unit: 'kg', reference: true };
  const inFlow = { id: 'waste', label: 'Waste', amount: 2, unit: 'kg', note: 'Declared inventory' };
  const nodes = [
    { id: 'provider', label: 'Treatment', kind: 'background', inputs: [out] },
    { id: 'consumer', label: 'Production', outputs: [inFlow, 'Previously published text'] },
  ];
  const edge = {
    id: 'disposal',
    from: 'provider',
    to: 'consumer',
    label: 'Disposal',
    exchanges: { from: 'pivot', to: 'waste' },
  };
  const report = (model: unknown) => parseResearchReport({ title: 'Disposal', model });
  const html = renderResearchReport(report({ nodes, edges: [edge, { ...edge, id: 'second' }] }));
  assert.match(html, /Reference input/u);
  assert.match(html, /data-from-exchange="pivot" data-to-exchange="waste"/u);
  assert.match(html, /data-exchange-id="waste"[^<]*<th[^>]*>Waste<ul class="exchange-links">/u);
  assert.match(html, /<small>Declared inventory<\/small>/u);
  assert.match(html, /<td colspan="3">Previously published text<\/td>/u);
  assert.match(html, /<td class="exchange-amount">-1<\/td>/u);
  assert.match(html, /data-default-process="node-consumer"/u);
  const samePort = renderResearchReport(
    report({
      nodes: [nodes[0]],
      edges: [{ ...edge, to: 'provider', exchanges: { from: 'pivot', to: 'pivot' } }],
    }),
  );
  assert.equal((samePort.match(/class="exchange-link"/gu) ?? []).length, 1);
  assert.match(
    renderResearchReport(report({ nodes: [nodes[0]] })),
    /data-default-process="node-provider"/u,
  );
  assert.throws(
    () => report({ nodes, edges: [{ ...edge, exchanges: { from: 'waste', to: 'waste' } }] }),
    /model\.edges\[0\]\.exchanges\.from/u,
  );
  assert.throws(
    () => report({ nodes, edges: [{ ...edge, exchanges: { from: 'pivot', to: 'pivot' } }] }),
    /model\.edges\[0\]\.exchanges\.to/u,
  );
  assert.throws(
    () => report({ nodes, edges: [{ ...edge, exchanges: { from: 'pivot' } }] }),
    /model\.edges\[0\]\.exchanges\.to/u,
  );
  assert.throws(() => report({ nodes: [{ ...nodes[0], outputs: [out] }] }), /unique IDs/u);
  assert.throws(
    () => report({ nodes: [{ ...nodes[0], inputs: [{ ...out, reference: 'yes' }] }] }),
    /reference: expected a boolean/u,
  );
  assert.throws(
    () => report({ nodes: [{ ...nodes[0], inputs: [{ ...out, unit: '' }] }] }),
    /unit: expected nonempty text/u,
  );
  assert.throws(() => report({ nodes: [{ ...nodes[0], inputs: [null] }] }), /inputs\[0\]/u);
});

test('overview rounds its displayed value and preserves exact data and basis in the report', () => {
  const html = renderResearchReport(
    parseResearchReport({
      title: 'Case',
      results: [
        {
          label: 'Climate change',
          value: 25.97121961,
          unit: 'kg',
          context: 'Trial calculation',
          summary: true,
        },
        { label: 'Other indicator', value: 1, unit: 'kg' },
      ],
    }),
  );
  assert.match(html, /class="result-context">Trial calculation/u);
  assert.match(html, /<data value="25.97121961" title="25.97121961">25.97<\/data>/u);
  assert.match(
    html,
    /<td class="numeric">25.97121961<\/td><td>kg<\/td><td>Trial calculation<\/td>/u,
  );
  assert.match(html, /<td class="numeric">1<\/td><td>kg<\/td><td>—<\/td>/u);
});

test('report command performs exclusive HTML output, protects input aliases and returns bounded shared results', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-report-'));
  try {
    const input = path.join(dir, 'input.json'),
      output = path.join(dir, 'sub', 'report.html');
    writeFileSync(input, JSON.stringify(example));
    const before = readFileSync(input, 'utf8');
    const args = ['render', '--input', input, '--output', output, '--json'];
    const run = () => runReportCommand(args, writeResearchReport);
    const success = run();
    assert.equal(success.exitCode, 0, success.stdout);
    const value = JSON.parse(success.stdout);
    assert.equal(value.operation, 'report render');
    assert.equal(value.artifacts[0].bytes, Buffer.byteLength(readFileSync(output)));
    assert.equal(value.completeness.scientificValidation, false);
    assert.equal(value.completeness.pdf, 'browser_print');
    assert.ok(value.replyTemplate.endsWith('.md'));
    assert.ok(success.stdout.length < 2500);
    const html = readFileSync(output, 'utf8');
    assert.equal(run().exitCode, 1);
    assert.equal(readFileSync(output, 'utf8'), html);
    assert.equal(runReportCommand([...args, '--force'], writeResearchReport).exitCode, 0);
    for (const target of [input, path.join(dir, 'alias.json')]) {
      if (target !== input) linkSync(input, target);
      const refused = runReportCommand(
        ['render', '--input', input, '--output', target, '--force', '--json'],
        writeResearchReport,
      );
      assert.equal(JSON.parse(refused.stdout).error.code, 'OUTPUT_IS_INPUT');
      assert.equal(readFileSync(input, 'utf8'), before);
    }
    const failure = runReportCommand(
      ['render', '--input', input, '--output', path.join(input, 'not-a-directory.html'), '--json'],
      writeResearchReport,
    );
    assert.equal(failure.exitCode, 1);
    assert.equal(readdirSync(path.dirname(output)).length, 1);
    writeFileSync(input, JSON.stringify({ title: 'Minimal report' }));
    const routed = await executeCli(
      ['report', 'render', '--input', input, '--output', 'virtual', '--json'],
      {
        env: {},
        dotEnvStatus: { loaded: false, path: '', count: 0 },
        fetchImpl: () => {
          throw new Error('network must not be used');
        },
        writeResearchReportImpl: () => ({ path: 'virtual', purpose: 'test', bytes: 1 }),
      },
    );
    assert.equal(routed.exitCode, 0);
    assert.equal(JSON.parse(routed.stdout).data.nodes, 0);
    assert.equal(JSON.parse(routed.stdout).data.edges, 0);
    const realRoute = await executeCli(
      ['report', 'render', '--input', input, '--output', path.join(dir, 'route.html')],
      {
        env: {},
        dotEnvStatus: { loaded: false, path: '', count: 0 },
        fetchImpl: () => {
          throw new Error('no network');
        },
      },
    );
    assert.equal(realRoute.exitCode, 0);
    assert.match(realRoute.stdout, /Interactive HTML/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('help and invalid arguments never invoke the renderer; arbitrary render failures remain failures', () => {
  const noWrite = () => {
    throw new Error('must not dispatch');
  };
  for (const args of [[], ['--json'], ['render', '--help'], ['render', '--help', '--json']])
    assert.equal(runReportCommand(args, noWrite).exitCode, 0);
  for (const args of [
    ['render'],
    ['render', '--input', 'x'],
    ['render', '--pdf'],
    ['render', 'extra'],
    ['render', '--help', '--help'],
    ['bad'],
    ['render', '--input', 'missing', '--output', 'x'],
  ])
    assert.equal(runReportCommand(args, noWrite).exitCode, 2);
  const source = fileURLToPath(new URL('../assets/report/example.json', import.meta.url));
  const failure = runReportCommand(
    ['render', '--input', source, '--output', 'x', '--json'],
    noWrite,
  );
  assert.equal(failure.exitCode, 1);
  assert.equal(JSON.parse(failure.stdout).error.code, 'REPORT_RENDER_FAILED');
});

test('result interpretation follows supplied analysis and precedes limitations', () => {
  const html = renderResearchReport(
    parseResearchReport({
      ...example,
      interpretation: {
        body: { zh: '运输是试算结果的主要来源。', en: 'Freight dominates the trial result.' },
        sources: ['inventory'],
      },
    }),
  );
  const match = html.match(/<section id="interpretation"[^>]*>(.*?)<\/section>/u);
  assert.ok(match);
  assert.match(match[1], /运输是试算结果的主要来源。/u);
  assert.match(match[1], /href="#source-inventory"/u);
  assert.ok(html.indexOf('<section id="sensitivity-1"') < match.index!);
  assert.ok(match.index! < html.indexOf('<section id="limitations"'));
  assert.throws(
    () => parseResearchReport({ title: 'Report', interpretation: { body: '  ' } }),
    /interpretation.body/u,
  );
});
