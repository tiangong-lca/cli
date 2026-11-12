import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  assert.doesNotMatch(safe, /<img/u);
  assert.match(safe, /&lt;\/script&gt;/u);
  assert.match(safe, /&quot;/u);
  assert.match(safe, /&#39;/u);
  assert.match(safe, /data-only=" \[EN\]"/u);
  assert.match(safe, /data-language="zh"/u);
  assert.match(safe, />0 <\/p>/u);
  assert.match(safe, />— kg<\/p>/u);
  assert.match(safe, /<td>—<\/td>/u);
  assert.match(
    renderResearchReport(parseResearchReport({ title: { en: 'Only English' } })),
    /<title>Only English<\/title>/u,
  );
  assert.match(
    renderResearchReport(parseResearchReport({ title: { en: 'Only English' }, language: 'en' })),
    /data-language="en"/u,
  );
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
  const source = new URL('../assets/report/example.json', import.meta.url).pathname;
  const failure = runReportCommand(
    ['render', '--input', source, '--output', 'x', '--json'],
    noWrite,
  );
  assert.equal(failure.exitCode, 1);
  assert.equal(JSON.parse(failure.stdout).error.code, 'REPORT_RENDER_FAILED');
});
