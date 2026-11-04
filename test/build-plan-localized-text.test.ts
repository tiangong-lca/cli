import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProcessBuildPlanMaterialize } from '../src/lib/process-flow-build-plan.js';

test('public build-plan materialization keeps all descriptive paragraphs in one node per language', async () => {
  const plan = JSON.parse(
    readFileSync(
      new URL('./fixtures/process-intended-applications-plan.json', import.meta.url),
      'utf8',
    ),
  );
  plan.target.general_comment = [
    { '@xml:lang': 'en', '#text': 'Original paragraph includes a later fragment.' },
    { '@xml:lang': 'zh', '#text': '第一段完整说明。' },
    { '@xml:lang': 'en', '#text': 'later fragment' },
    { '@xml:lang': 'zh', '#text': '第二段补充说明。' },
  ];
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cli-language-build-plan-'));
  try {
    const report = await runProcessBuildPlanMaterialize({
      inputPath: 'anonymous-plan.json',
      rawInput: plan,
      outDir,
    });
    assert.equal(report.status, 'passed');
    const payload = JSON.parse(readFileSync(report.files.materialized_artifact!, 'utf8'));
    assert.deepEqual(
      payload.processDataSet.processInformation.dataSetInformation['common:generalComment'],
      [
        {
          '@xml:lang': 'en',
          '#text': 'Original paragraph includes a later fragment.\n\nlater fragment',
        },
        { '@xml:lang': 'zh', '#text': '第一段完整说明。\n\n第二段补充说明。' },
      ],
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('build plans reject conflicting names and metadata-bearing prose without deleting attributes', async () => {
  for (const field of ['name', 'comment'] as const) {
    const plan = JSON.parse(
      readFileSync(
        new URL('./fixtures/process-intended-applications-plan.json', import.meta.url),
        'utf8',
      ),
    );
    const entries = [
      { '@xml:lang': 'en', '#text': 'Original', '@source': 'first' },
      { '@xml:lang': 'en', '#text': 'Additional', '@source': 'second' },
    ];
    if (field === 'name') plan.name_plan.base_name = entries;
    else plan.target.general_comment = entries;
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'cli-language-build-plan-conflict-'));
    try {
      const report = await runProcessBuildPlanMaterialize({
        inputPath: 'anonymous-plan.json',
        rawInput: plan,
        outDir,
      });
      assert.equal(report.status, 'blocked');
      assert.ok(
        report.schema_validation.issues.some((issue) => issue.code === 'duplicate_language_entry'),
      );
      const payload = JSON.parse(readFileSync(report.files.materialized_artifact!, 'utf8'));
      const info = payload.processDataSet.processInformation.dataSetInformation;
      assert.deepEqual(
        field === 'name' ? info.name.baseName : info['common:generalComment'],
        entries,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});
