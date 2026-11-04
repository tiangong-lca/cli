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

test('public build-plan retains malformed localized siblings and attributed singletons for diagnosis', async () => {
  const cases = [
    [
      { '@xml:lang': 'en', '#text': 'Original valid paragraph' },
      { '@xml:lang': 'en', '@source': 'original-malformed' },
    ],
    [
      { '@xml:lang': 'en', '#text': 'Original valid paragraph' },
      { '@xml:lang': 'zh', '@source': 'missing-text' },
    ],
    { '@xml:lang': 'en', '@source': 'attributed-singleton' },
    {
      '@xml:lang': 'en',
      '#text': null,
      text: 'Do not substitute this alias',
      '@source': 'explicit-invalid',
    },
    { text: 'Do not fabricate a language', lang: { source: 'invalid-language' } },
    { text: 'First alias', value: 'Conflicting alias', lang: 'en' },
    { en: 'Original shorthand text', zh: { '@source': 'invalid-shorthand' } },
    { en: 'Original shorthand text', '@source': 'shorthand-metadata' },
  ];
  for (const field of ['comment', 'name', 'intended'] as const) {
    for (const malformed of cases) {
      const plan = JSON.parse(
        readFileSync(
          new URL('./fixtures/process-intended-applications-plan.json', import.meta.url),
          'utf8',
        ),
      );
      if (field === 'comment') plan.target.general_comment = malformed;
      else if (field === 'name') plan.name_plan.base_name = malformed;
      else plan.administrative_information.intended_applications = malformed;
      const before = JSON.stringify(plan);
      const outDir = mkdtempSync(path.join(os.tmpdir(), 'cli-language-malformed-plan-'));
      try {
        const report = await runProcessBuildPlanMaterialize({
          inputPath: 'anonymous-plan.json',
          rawInput: plan,
          outDir,
        });
        assert.equal(report.status, 'blocked', `${field}: ${JSON.stringify(malformed)}`);
        assert.equal(JSON.stringify(plan), before);
        if (field === 'intended' && !Array.isArray(malformed)) {
          assert.ok(
            report.required_fields.missing.includes(
              'administrative_information.intended_applications',
            ),
          );
          continue;
        }
        const payload = JSON.parse(readFileSync(report.files.materialized_artifact!, 'utf8'));
        const root = payload.processDataSet;
        const info = root.processInformation.dataSetInformation;
        const actual =
          field === 'comment'
            ? info['common:generalComment']
            : field === 'name'
              ? info.name.baseName
              : root.administrativeInformation['common:commissionerAndGoal'][
                  'common:intendedApplications'
                ];
        assert.deepEqual(actual, Array.isArray(malformed) ? malformed : [malformed]);
        assert.ok(report.schema_validation.issues.length > 0);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  }
});

test('public build-plan keeps established primitive, text and bilingual shorthand forms', async () => {
  const cases: Array<[unknown, unknown]> = [
    ['Original shorthand text', [{ '@xml:lang': 'en', '#text': 'Original shorthand text' }]],
    [{ text: 'Text alias', lang: 'en' }, [{ '@xml:lang': 'en', '#text': 'Text alias' }]],
    [{ value: 'Value alias' }, [{ '@xml:lang': 'en', '#text': 'Value alias' }]],
    [{ '#text': 'Bare text shorthand' }, [{ '@xml:lang': 'en', '#text': 'Bare text shorthand' }]],
    [
      { en: 'English shorthand', zh: '中文简写' },
      [
        { '@xml:lang': 'en', '#text': 'English shorthand' },
        { '@xml:lang': 'zh', '#text': '中文简写' },
      ],
    ],
    [42, [{ '@xml:lang': 'en', '#text': '42' }]],
  ];
  for (const [input, expected] of cases) {
    const plan = JSON.parse(
      readFileSync(
        new URL('./fixtures/process-intended-applications-plan.json', import.meta.url),
        'utf8',
      ),
    );
    plan.target.general_comment = input;
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'cli-language-shorthand-plan-'));
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
        expected,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});
