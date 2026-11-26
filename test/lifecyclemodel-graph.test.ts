import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __testInternals, runLifecyclemodelGraph } from '../src/lib/model/graph.js';

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeLifecyclemodelWithDanglingEdge(): Record<string, unknown> {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': 'lm-graph-1',
        },
        technology: {
          processes: {
            processInstance: {
              '@dataSetInternalID': '1',
              referenceToProcess: {
                '@refObjectId': 'proc-1',
                '@version': '01.01.000',
                name: {
                  baseName: [{ '#text': 'Process 1' }],
                },
              },
              connections: {
                outputExchange: {
                  '@flowUUID': 'flow-1',
                  downstreamProcess: {
                    '@id': 'missing-node',
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

test('runLifecyclemodelGraph writes graph files and flags unresolved connections', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-graph-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'lm-graph-1',
      version: '01.01.000',
      json_ordered: makeLifecyclemodelWithDanglingEdge(),
    },
  ]);

  try {
    const report = await runLifecyclemodelGraph({
      inputPath,
      outDir,
      format: 'all',
      checkConnections: true,
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_findings');
    assert.equal(report.counts.models, 1);
    assert.equal(report.counts.nodes, 1);
    assert.equal(report.counts.edges, 1);
    assert.equal(report.counts.findings, 1);
    assert.equal(report.findings[0]?.code, 'missing_target_process_instance');
    assert.equal(existsSync(report.models[0]?.files.graph_json ?? ''), true);
    assert.equal(existsSync(report.models[0]?.files.dot ?? ''), true);
    assert.equal(existsSync(report.models[0]?.files.svg ?? ''), true);
    assert.equal(readJsonl(report.files.findings).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelGraph validates required flags and supports json-only output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-graph-json-'));
  const inputPath = path.join(dir, 'lifecyclemodels.json');
  const outDir = path.join(dir, 'out');
  writeFileSync(
    inputPath,
    JSON.stringify({ rows: [{ json_ordered: { lifeCycleModelDataSet: {} } }] }),
    'utf8',
  );

  try {
    await assert.rejects(
      () => runLifecyclemodelGraph({ inputPath, outDir: '', format: 'json' }),
      /Missing required --out-dir/u,
    );
    await assert.rejects(
      () => runLifecyclemodelGraph({ inputPath, outDir, format: 'bad' }),
      /Expected --format/u,
    );

    const report = await runLifecyclemodelGraph({
      inputPath,
      outDir,
      format: 'json',
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.models[0]?.files.dot, null);
    assert.equal(report.models[0]?.files.svg, null);
    assert.equal(existsSync(report.models[0]?.files.graph_json ?? ''), true);
    assert.equal(readJsonl(report.files.findings).length, 0);

    const dotOnlyReport = await runLifecyclemodelGraph({
      inputPath,
      outDir: path.join(dir, 'dot-out'),
      format: 'dot',
    });
    assert.equal(dotOnlyReport.models[0]?.files.graph_json, null);
    assert.equal(existsSync(dotOnlyReport.models[0]?.files.dot ?? ''), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel graph internals cover fallback graph rendering branches', () => {
  assert.deepEqual(__testInternals.asArray(undefined), []);
  assert.deepEqual(__testInternals.asArray('one'), ['one']);
  assert.equal(__testInternals.normalizeFormat(null), 'all');
  assert.equal(__testInternals.safeStem(0, 'bad id/with spaces'), '001-bad_id_with_spaces');
  assert.deepEqual(__testInternals.normalizeNodes({}), []);
  assert.deepEqual(__testInternals.normalizeEdges({}), []);

  const nodes = __testInternals.normalizeNodes({
    xflow: {
      nodes: [
        {
          data: {
            label: { baseName: [{ '#text': 'Localized Label' }] },
          },
        },
      ],
    },
  });
  const fallbackLabelNodes = __testInternals.normalizeNodes({
    xflow: {
      nodes: [{ data: { label: { baseName: ['bad'] } } }, {}],
    },
  });
  const edges = __testInternals.normalizeEdges({
    xflow: {
      edges: [
        {
          source: { cell: 'missing-source' },
          target: { cell: '' },
          data: { connection: { outputExchange: { '@flowUUID': 'flow-1' } } },
        },
      ],
    },
  });

  assert.equal(__testInternals.labelFromNode(nodes[0]!), 'Localized Label');
  assert.equal(__testInternals.labelFromNode(fallbackLabelNodes[0]!), 'node-1');
  assert.equal(__testInternals.labelFromNode(fallbackLabelNodes[1]!), 'node-2');
  assert.match(__testInternals.buildDot('model"1', nodes, edges), /model\\"1/u);
  assert.match(__testInternals.buildSvg(nodes, edges), /Localized Label/u);
  const connectedNodes = __testInternals.normalizeNodes({
    xflow: {
      nodes: [
        {
          id: 'source',
          x: 1,
          y: 2,
          width: 100,
          height: 50,
          data: { id: 'source', label: 'Source label' },
        },
        { id: 'target', x: 200, y: 20, width: 100, height: 50, data: { id: 'target' } },
      ],
    },
  });
  const connectedEdges = __testInternals.normalizeEdges({
    xflow: {
      edges: [
        { id: 'edge-1', source: { cell: 'source' }, target: { cell: 'target' } },
        { id: '', source: {}, target: {} },
        { source: 'bad-source', target: 'bad-target', data: 'bad-data' },
      ],
    },
  });
  assert.match(__testInternals.buildSvg(connectedNodes, connectedEdges), /<line x1=/u);
  assert.match(
    __testInternals.buildDot(null, connectedNodes, [
      ...connectedEdges,
      { id: '', source: {}, target: {}, data: {} },
    ]),
    /unknown-source/u,
  );
  const findings = __testInternals.checkEdges(0, 'lm-1', nodes, edges);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ['missing_source_process_instance', 'missing_target_process_instance'],
  );
  const emptyFindings = __testInternals.checkEdges(0, null, [], connectedEdges);
  assert.equal(
    emptyFindings.some((finding) => /<empty>/u.test(finding.message)),
    true,
  );
});
