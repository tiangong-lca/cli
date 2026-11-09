import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  __testInternals,
  runDatasetBilingualApply,
  runDatasetBilingualExtract,
  runDatasetBilingualValidate,
  type DatasetBilingualExtractReport,
} from '../src/lib/dataset-bilingual.js';
import type { DatasetValidateReport } from '../src/lib/dataset-validate.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FlowQaReport } from '../src/lib/flow-qa.js';
import type { ProcessQaReport } from '../src/lib/process-qa.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

function makeDeps() {
  return {
    env: {} as NodeJS.ProcessEnv,
    dotEnvStatus,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    }),
  };
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sampleProcessRow() {
  return {
    id: 'proc-1',
    version: '01.01.000',
    json_ordered: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'proc-1',
            name: [
              { '@xml:lang': 'en', '#text': 'Electricity mix, high voltage' },
              { '@xml:lang': 'zh', '#text': '高压电力组合' },
            ],
            generalComment: [
              { '@xml:lang': 'en', '#text': 'Current grid mix in Hubei.' },
              { '@xml:lang': 'zh', '#text': '湖北省当前电网组合。' },
            ],
          },
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.01.000',
          },
        },
      },
    },
  };
}

function sampleFlowRow() {
  return {
    id: 'flow-1',
    version: '01.01.000',
    json_ordered: {
      flowDataSet: {
        ...flowReferenceFixture(),
        flowInformation: {
          ...flowReferenceFixture().flowInformation,
          dataSetInformation: {
            'common:UUID': 'flow-1',
            name: [{ '@xml:lang': 'en', '#text': 'Battery electrolyte' }],
          },
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.01.000',
          },
        },
      },
    },
  };
}

function validDatasetReport(
  inputPath: string,
  reportFile: string | null,
  type: 'process' | 'flow' = 'process',
): DatasetValidateReport {
  return {
    generated_at_utc: '2026-05-23T00:00:00.000Z',
    input_path: inputPath,
    requested_type: type,
    status: 'completed',
    counts: {
      total: 1,
      valid: 1,
      invalid: 0,
      by_type: {
        flow: type === 'flow' ? 1 : 0,
        process: type === 'process' ? 1 : 0,
        lifecyclemodel: 0,
        source: 0,
        contact: 0,
        flowproperty: 0,
        unitgroup: 0,
      },
    },
    files: {
      report: reportFile,
      valid_rows: null,
      invalid_rows: null,
    },
    rows: [],
  };
}

function processQaReport(reportFile: string): ProcessQaReport {
  return {
    schema_version: 1,
    generated_at_utc: '2026-05-23T00:00:00.000Z',
    status: 'completed_local_process_qa',
    run_id: 'test',
    run_root: path.dirname(reportFile),
    rows_file: reportFile,
    out_dir: path.dirname(reportFile),
    input_mode: 'rows_file',
    effective_processes_dir: path.dirname(reportFile),
    logic_version: 'test',
    process_count: 1,
    policy_decision_owner: 'foundry',
    qa_mode: 'deterministic_qa_report',
    totals: {
      raw_input: 0,
      product_plus_byproduct_plus_waste: 0,
      delta: 0,
      relative_deviation: null,
      energy_excluded: 0,
    },
    llm: {
      enabled: false,
      reason: 'disabled',
    },
    files: {
      qa_input_summary: reportFile,
      materialization_summary: null,
      qa_zh: reportFile,
      qa_en: reportFile,
      timing: reportFile,
      unit_issue_log: reportFile,
      summary: reportFile,
      report: reportFile,
    },
  };
}

function flowQaReport(reportFile: string): FlowQaReport {
  return {
    schema_version: 1,
    generated_at_utc: '2026-05-23T00:00:00.000Z',
    status: 'completed_local_flow_qa',
    run_id: 'test',
    out_dir: path.dirname(reportFile),
    rows_file: reportFile,
    input_mode: 'rows_file',
    effective_flows_dir: path.dirname(reportFile),
    logic_version: 'test',
    flow_count: 1,
    similarity_threshold: 0.92,
    methodology_rule_source: 'test',
    with_reference_context: false,
    reference_context_mode: 'disabled',
    rule_finding_count: 0,
    llm_finding_count: 0,
    finding_count: 0,
    severity_counts: {},
    rule_counts: {},
    llm: {
      enabled: false,
      batch_count: 0,
      reviewed_flow_count: 0,
      truncated: false,
      batch_results: [],
    },
    files: {
      qa_input_summary: reportFile,
      materialization_summary: null,
      rule_findings: reportFile,
      llm_findings: reportFile,
      findings: reportFile,
      flow_summaries: reportFile,
      similarity_pairs: reportFile,
      summary: reportFile,
      qa_zh: reportFile,
      qa_en: reportFile,
      timing: reportFile,
      report: reportFile,
    },
  };
}

test('dataset bilingual extract writes translation units with deterministic field paths', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-bilingual-extract-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [sampleProcessRow()]);

  try {
    const report = await runDatasetBilingualExtract({
      inputPath,
      outDir,
      type: 'process',
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.unit_count, 2);
    assert.equal(existsSync(report.files.translation_units ?? ''), true);
    const units = readJsonl(report.files.translation_units ?? '');
    assert.equal(units.length, 2);
    assert.match(
      (units[0] as { field_path: string }).field_path,
      /^\/json_ordered\/processDataSet/u,
    );
    assert.deepEqual(readJson(report.files.report ?? ''), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset bilingual apply writes translated rows and evidence', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-bilingual-apply-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outDir = path.join(dir, 'out');
  const extractDir = path.join(dir, 'extract');
  const translationsPath = path.join(dir, 'translations.jsonl');
  const outPath = path.join(dir, 'translated.jsonl');
  writeJsonl(inputPath, [sampleProcessRow()]);

  try {
    const extractReport = await runDatasetBilingualExtract({
      inputPath,
      outDir: extractDir,
      type: 'process',
    });
    const [unit] = readJsonl(extractReport.files.translation_units ?? '') as Array<{
      unit_id: string;
      row_index: number;
      field_path: string;
      source_lang: string;
      target_lang: string;
      source_text: string;
    }>;
    writeJsonl(translationsPath, [
      {
        ...unit,
        translated_text: '高压电力组合（经复核）',
        basis: 'Domain transcreation based on process context.',
        review_status: 'agent_reviewed',
        reviewer: 'codex',
      },
    ]);

    const report = await runDatasetBilingualApply({
      inputPath,
      translationsPath,
      outPath,
      outDir,
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.applied_count, 1);
    const translatedRows = readJsonl(outPath) as Array<ReturnType<typeof sampleProcessRow>>;
    assert.equal(
      translatedRows[0].json_ordered.processDataSet.processInformation.dataSetInformation.name[1][
        '#text'
      ],
      '高压电力组合（经复核）',
    );
    const evidence = readJson(report.files.translation_evidence ?? '') as {
      entries: Array<{ translated_text: string }>;
    };
    assert.equal(evidence.entries[0].translated_text, '高压电力组合（经复核）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset bilingual validate combines scans with schema and QA gates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-bilingual-validate-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outDir = path.join(dir, 'out');
  const row = sampleProcessRow();
  row.json_ordered.processDataSet.processInformation.dataSetInformation.name[1]['#text'] =
    'Current technology for mounting 组件s and laminates with TODO';
  writeJsonl(inputPath, [row]);

  try {
    const report = await runDatasetBilingualValidate({
      inputPath,
      outDir,
      type: 'process',
      now: new Date('2026-05-23T00:00:00.000Z'),
      datasetValidateImpl: async (options) => validDatasetReport(options.inputPath, null),
      processQaImpl: async (options) =>
        processQaReport(path.join(options.outDir, 'qa-report.json')),
      flowQaImpl: async (options) => flowQaReport(path.join(options.outDir, 'report.json')),
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.scan.blocker_count, 2);
    assert.equal(report.scan.warning_count, 1);
    assert.equal(report.schema_gate.invalid, 0);
    assert.equal(report.qa_gate.status, 'completed');
    assert.equal(existsSync(report.files.report ?? ''), true);
    assert.equal(readJsonl(report.files.findings ?? '').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset bilingual covers local-only extraction, apply blockers, and flow review', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-bilingual-edges-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const translatedPath = path.join(dir, 'translated.jsonl');
  writeJsonl(inputPath, [
    sampleFlowRow(),
    {
      id: 'empty',
      version: '01.01.000',
      json_ordered: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': 'empty',
              name: [{ '@xml:lang': 'en', '#text': '' }],
            },
          },
        },
      },
    },
  ]);

  try {
    const extractReport = await runDatasetBilingualExtract({
      inputPath,
      type: 'auto',
      rawInput: {
        rows: [sampleFlowRow()],
      },
      sourceLang: 'EN',
      targetLang: 'ZH',
    });
    assert.equal(extractReport.files.report, null);
    assert.equal(extractReport.unit_count, 1);

    const unit = __testInternals.collectTranslationUnits(
      [
        {
          index: 0,
          row: sampleFlowRow(),
          payload: sampleFlowRow().json_ordered,
          kind: 'flow',
          id: 'flow-1',
          version: '01.01.000',
        },
      ],
      'en',
      'zh',
    )[0];
    const applyReport = await runDatasetBilingualApply({
      inputPath,
      outPath: translatedPath,
      translationsPath: 'memory',
      rawTranslations: {
        rows: [
          {
            rowIndex: 0,
            fieldPath: unit.field_path,
            translation: '电池电解液',
            rationale: 'Reviewed battery-domain wording.',
            reviewStatus: 'agent_reviewed',
          },
          {
            unitId: 'missing-row-index',
            fieldPath: unit.field_path,
            translatedText: 'x',
          },
          {
            unitId: 'missing-field-path',
            rowIndex: 0,
            translatedText: 'x',
          },
          {
            rowIndex: 0,
            translatedText: 'x',
          },
          {
            unitId: 'missing-translated-text',
            rowIndex: 0,
            fieldPath: unit.field_path,
          },
          {
            unitId: 'no-row',
            rowIndex: 99,
            fieldPath: unit.field_path,
            translatedText: 'x',
          },
          {
            unitId: 'bad-pointer',
            rowIndex: 0,
            fieldPath: '/id',
            translatedText: 'x',
          },
          {
            unitId: 'unresolved-pointer',
            rowIndex: 0,
            fieldPath: '/json_ordered/missing/name',
            translatedText: 'x',
          },
        ],
      },
      targetLang: 'zh',
      now: new Date('2026-05-23T00:00:00.000Z'),
    });
    assert.equal(applyReport.status, 'blocked');
    assert.equal(applyReport.applied_count, 1);
    assert.equal(applyReport.skipped_count, 7);
    assert.equal(
      applyReport.blockers.some((blocker) => blocker.unit_id === undefined),
      true,
    );
    const translatedRows = readJsonl(translatedPath) as Array<ReturnType<typeof sampleFlowRow>>;
    assert.equal(
      translatedRows[0].json_ordered.flowDataSet.flowInformation.dataSetInformation.name[1][
        '#text'
      ],
      '电池电解液',
    );
    assert.equal(existsSync(path.join(dir, 'outputs', 'translation-evidence.json')), true);

    const flowValidateReport = await runDatasetBilingualValidate({
      inputPath,
      outDir: path.join(dir, 'validate-flow'),
      type: 'flow',
      datasetValidateImpl: async (options) => validDatasetReport(options.inputPath, null, 'flow'),
      processQaImpl: async (options) => processQaReport(path.join(options.outDir, 'report.json')),
      flowQaImpl: async (options) => flowQaReport(path.join(options.outDir, 'report.json')),
      now: new Date('2026-05-23T00:00:00.000Z'),
    });
    assert.equal(flowValidateReport.status, 'completed');
    assert.equal(flowValidateReport.qa_gate.status, 'completed');
    assert.match(flowValidateReport.qa_gate.flow_report_file ?? '', /qa[\\/]flow/u);

    const localValidateReport = await runDatasetBilingualValidate({
      inputPath,
      rawInput: { rows: [sampleProcessRow()] },
      type: 'process',
      datasetValidateImpl: async (options) => validDatasetReport(options.inputPath, null),
    });
    assert.equal(localValidateReport.files.report, null);
    assert.equal(localValidateReport.qa_gate.status, 'not_run');

    const schemaBlockedReport = await runDatasetBilingualValidate({
      inputPath,
      rawInput: { rows: [sampleProcessRow()] },
      type: 'process',
      datasetValidateImpl: async (options) => ({
        ...validDatasetReport(options.inputPath, null),
        status: 'completed_with_failures',
        counts: {
          total: 1,
          valid: 0,
          invalid: 1,
          by_type: {
            flow: 0,
            process: 1,
            lifecyclemodel: 0,
            source: 0,
            contact: 0,
            flowproperty: 0,
            unitgroup: 0,
          },
        },
      }),
    });
    assert.equal(schemaBlockedReport.status, 'blocked');

    const defaultQaReport = await runDatasetBilingualValidate({
      inputPath,
      rawInput: { rows: [sampleFlowRow()] },
      outDir: path.join(dir, 'default-flow-qa'),
      type: 'flow',
      datasetValidateImpl: async (options) => validDatasetReport(options.inputPath, null, 'flow'),
    });
    assert.equal(defaultQaReport.qa_gate.status, 'completed');

    const defaultProcessQaReport = await runDatasetBilingualValidate({
      inputPath,
      rawInput: { rows: [sampleProcessRow()] },
      outDir: path.join(dir, 'default-process-qa'),
      type: 'process',
      datasetValidateImpl: async (options) => validDatasetReport(options.inputPath, null),
    });
    assert.equal(defaultProcessQaReport.qa_gate.status, 'completed');

    const defaultSchemaGateReport = await runDatasetBilingualValidate({
      inputPath: 'memory',
      rawInput: { rows: [sampleFlowRow()] },
      type: 'flow',
      schemas: {
        flow: {
          safeParse: () => ({ success: true, data: {} }),
        },
      },
    });
    assert.equal(defaultSchemaGateReport.schema_gate.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset bilingual apply validates required output flags', async () => {
  await assert.rejects(
    () =>
      runDatasetBilingualApply({
        inputPath: 'memory',
        translationsPath: 'memory',
        outPath: '',
        rawInput: { rows: [] },
        rawTranslations: { rows: [] },
      }),
    /Missing required --out/u,
  );
  await assert.rejects(
    () =>
      runDatasetBilingualApply({
        inputPath: 'memory',
        translationsPath: '',
        outPath: 'translated.jsonl',
        rawInput: { rows: [] },
        rawTranslations: { rows: [] },
      }),
    /Missing required --translations/u,
  );
});

test('dataset bilingual extract rejects language codes outside the TIDAS enum', async () => {
  await assert.rejects(
    () =>
      runDatasetBilingualExtract({
        inputPath: 'memory',
        rawInput: { rows: [sampleFlowRow()] },
        sourceLang: 'zh-Hans',
      }),
    /TIDAS Languages enumeration value/u,
  );
});

test('dataset bilingual scan catches long previews and English CJK text', () => {
  const longText = `${'x'.repeat(190)} 中文`;
  const findings = __testInternals.scanRows([
    {
      index: 0,
      row: {
        payload: {
          processDataSet: {
            text: [{ '@xml:lang': 'en', '#text': longText }, { '#text': 'Implicit English' }],
          },
        },
      },
      payload: {
        processDataSet: {
          text: [{ '@xml:lang': 'en', '#text': longText }, { '#text': 'Implicit English' }],
        },
      },
      kind: 'process',
      id: 'proc',
      version: '01.01.000',
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'english_contains_cjk');
  assert.match(findings[0].text_preview, /\.\.\.$/u);
});

test('dataset bilingual scan blocks language codes outside the TIDAS enum', () => {
  const findings = __testInternals.scanRows([
    {
      index: 0,
      row: {
        payload: {
          processDataSet: {
            text: [{ '@xml:lang': 'en-US', '#text': 'Regional English' }],
          },
        },
      },
      payload: {
        processDataSet: {
          text: [{ '@xml:lang': 'en-US', '#text': 'Regional English' }],
        },
      },
      kind: 'process',
      id: 'proc',
      version: '01.01.000',
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'localized_text_language_not_in_tidas_enum');
  assert.equal(findings[0].severity, 'blocker');
});

test('dataset bilingual internals cover nested arrays and array pointer resolution', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-bilingual-array-pointer-'));
  const outPath = path.join(dir, 'translated.jsonl');
  const rows = [
    {
      json_ordered: {
        processDataSet: {
          nested: [
            {
              name: [{ '@xml:lang': 'en', '#text': 'Nested process name' }],
            },
          ],
        },
      },
    },
  ];
  const units = __testInternals.collectTranslationUnits(
    [
      {
        index: 0,
        row: rows[0],
        payload: rows[0].json_ordered,
        kind: 'process',
        id: null,
        version: null,
      },
    ],
    'en',
    'zh',
  );

  try {
    assert.equal(units.length, 1);
    assert.match(units[0].field_path, /\/nested\/0\/name$/u);
    const report = await runDatasetBilingualApply({
      inputPath: 'memory',
      translationsPath: 'memory',
      outPath,
      rawInput: { rows },
      rawTranslations: {
        rows: [
          {
            row_index: 0,
            field_path: units[0].field_path,
            source_text: units[0].source_text,
            translated_text: '嵌套过程名称',
          },
        ],
      },
    });
    assert.equal(report.status, 'completed');
    const translatedRows = readJsonl(outPath) as typeof rows;
    assert.equal(
      translatedRows[0].json_ordered.processDataSet.nested[0].name[1]['#text'],
      '嵌套过程名称',
    );

    const mixedRows = [{ texts: [{ '@xml:lang': 'en', '#text': 'Unknown row text' }] }];
    const mixedUnits = __testInternals.collectTranslationUnits(
      [
        {
          index: 0,
          row: { texts: ['noise', { '@xml:lang': 'en', '#text': 'Unknown row text' }] },
          payload: { texts: ['noise', { '@xml:lang': 'en', '#text': 'Unknown row text' }] },
          kind: null,
          id: null,
          version: null,
        },
      ],
      'en',
      'zh',
    );
    assert.equal(mixedUnits.length, 1);

    const unknownOutPath = path.join(dir, 'unknown-translated.jsonl');
    const unknownReport = await runDatasetBilingualApply({
      inputPath: 'memory',
      translationsPath: 'memory',
      outPath: unknownOutPath,
      rawInput: { rows: mixedRows },
      rawTranslations: {
        rows: [
          {
            row_index: 0,
            field_path: '/texts',
            source_lang: 'fr',
            source_text: 'Unknown row text',
            translated_text: '未知数据集文本',
          },
        ],
      },
    });
    assert.equal(unknownReport.status, 'completed');
    const unknownEvidence = readJson(unknownReport.files.translation_evidence ?? '') as {
      entries: Array<{ dataset_type: string | null }>;
    };
    assert.equal(unknownEvidence.entries[0].dataset_type, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset bilingual internals normalize pointers and type errors', () => {
  assert.deepEqual(__testInternals.segmentsFromPointer('/a~1b/c~0d'), ['a/b', 'c~d']);
  assert.equal(__testInternals.pointerFromSegments(['a/b', 'c~d']), '/a~1b/c~0d');
  assert.equal(__testInternals.rawLangOf('plain text'), null);
  assert.equal(__testInternals.normalizeType('models'), 'lifecyclemodel');
  assert.throws(() => __testInternals.segmentsFromPointer('not-a-pointer'), /field_path/u);
  assert.throws(() => __testInternals.normalizeType('bad'), /Expected --type/u);

  const rootArrayUnits = __testInternals.collectTranslationUnits(
    [
      {
        index: 0,
        row: [
          { '@xml:lang': 'en', '#text': 'Root array text' },
          { '@xml:lang': 'zh', '#text': '根数组文本' },
        ] as unknown as Record<string, unknown>,
        payload: {},
        kind: null,
        id: null,
        version: null,
      },
    ],
    'en',
    'zh',
  );
  assert.equal(rootArrayUnits[0].context.root_field, null);
  assert.deepEqual(rootArrayUnits[0].context.sibling_keys, []);
});

test('executeCli dispatches dataset bilingual subcommands', async () => {
  let extractOptions: unknown;
  let applyOptions: unknown;
  let validateOptions: unknown;
  const extractResult = await executeCli(
    [
      'dataset',
      'bilingual',
      'extract',
      '--input',
      'rows.jsonl',
      '--type',
      'process',
      '--source-lang',
      'en',
      '--target-lang',
      'zh',
      '--out-dir',
      'extract-out',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetBilingualExtractImpl: async (options): Promise<DatasetBilingualExtractReport> => {
        extractOptions = options;
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          input_path: options.inputPath,
          requested_type: 'process',
          source_lang: 'en',
          target_lang: 'zh',
          unit_count: 1,
          row_count: 1,
          files: {
            translation_units: null,
            report: null,
          },
        };
      },
    },
  );
  assert.equal(extractResult.exitCode, 0);
  assert.deepEqual(extractOptions, {
    inputPath: 'rows.jsonl',
    type: 'process',
    sourceLang: 'en',
    targetLang: 'zh',
    outDir: 'extract-out',
  });

  const applyResult = await executeCli(
    [
      'dataset',
      'bilingual',
      'apply',
      '--input',
      'rows.jsonl',
      '--translations',
      'translations.jsonl',
      '--out',
      'translated.jsonl',
      '--target-lang',
      'zh',
      '--out-dir',
      'apply-out',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetBilingualApplyImpl: async (options) => {
        applyOptions = options;
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          input_path: options.inputPath,
          translations_path: options.translationsPath,
          out_path: options.outPath,
          target_lang: 'zh',
          status: 'completed',
          row_count: 1,
          translation_count: 1,
          applied_count: 1,
          skipped_count: 0,
          blockers: [],
          files: {
            translated_rows: options.outPath,
            translation_evidence: null,
            report: null,
          },
        };
      },
    },
  );
  assert.equal(applyResult.exitCode, 0);
  assert.deepEqual(applyOptions, {
    inputPath: 'rows.jsonl',
    translationsPath: 'translations.jsonl',
    outPath: 'translated.jsonl',
    targetLang: 'zh',
    outDir: 'apply-out',
  });

  const blockedApplyResult = await executeCli(
    [
      'dataset',
      'bilingual',
      'apply',
      '--input',
      'rows.jsonl',
      '--translations',
      'translations.jsonl',
      '--out',
      'translated.jsonl',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetBilingualApplyImpl: async (options) => ({
        schema_version: 1,
        generated_at_utc: '2026-05-23T00:00:00.000Z',
        input_path: options.inputPath,
        translations_path: options.translationsPath,
        out_path: options.outPath,
        target_lang: 'zh',
        status: 'blocked',
        row_count: 1,
        translation_count: 1,
        applied_count: 0,
        skipped_count: 1,
        blockers: [{ code: 'x', message: 'blocked' }],
        files: {
          translated_rows: options.outPath,
          translation_evidence: null,
          report: null,
        },
      }),
    },
  );
  assert.equal(blockedApplyResult.exitCode, 1);

  const validateResult = await executeCli(
    [
      'dataset',
      'bilingual',
      'validate',
      '--input',
      'translated.jsonl',
      '--type',
      'process',
      '--out-dir',
      'validate-out',
      '--json',
    ],
    {
      ...makeDeps(),
      runDatasetBilingualValidateImpl: async (options) => {
        validateOptions = options;
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          input_path: options.inputPath,
          requested_type: 'process',
          status: 'completed',
          row_count: 1,
          scan: {
            finding_count: 0,
            blocker_count: 0,
            warning_count: 0,
            findings: [],
          },
          schema_gate: {
            status: 'completed',
            valid: 1,
            invalid: 0,
            report_file: null,
          },
          qa_gate: {
            status: 'not_run',
            process_report_file: null,
            flow_report_file: null,
          },
          files: {
            report: null,
            findings: null,
          },
        };
      },
    },
  );
  assert.equal(validateResult.exitCode, 0);
  assert.deepEqual(validateOptions, {
    inputPath: 'translated.jsonl',
    type: 'process',
    outDir: 'validate-out',
  });

  const blockedValidateResult = await executeCli(
    ['dataset', 'bilingual', 'validate', '--input', 'translated.jsonl', '--json'],
    {
      ...makeDeps(),
      runDatasetBilingualValidateImpl: async (options) => ({
        schema_version: 1,
        generated_at_utc: '2026-05-23T00:00:00.000Z',
        input_path: options.inputPath,
        requested_type: 'auto',
        status: 'blocked',
        row_count: 1,
        scan: {
          finding_count: 1,
          blocker_count: 1,
          warning_count: 0,
          findings: [],
        },
        schema_gate: {
          status: 'completed',
          valid: 1,
          invalid: 0,
          report_file: null,
        },
        qa_gate: {
          status: 'not_run',
          process_report_file: null,
          flow_report_file: null,
        },
        files: {
          report: null,
          findings: null,
        },
      }),
    },
  );
  assert.equal(blockedValidateResult.exitCode, 1);
});

test('executeCli returns help and parse errors for dataset bilingual', async () => {
  const bareHelpResult = await executeCli(['dataset', 'bilingual'], makeDeps());
  assert.equal(bareHelpResult.exitCode, 0);
  assert.match(bareHelpResult.stdout, /extract\|apply\|validate/u);

  const helpResult = await executeCli(['dataset', 'bilingual', '--help'], makeDeps());
  assert.equal(helpResult.exitCode, 0);
  assert.match(helpResult.stdout, /extract\|apply\|validate/u);

  const extractHelp = await executeCli(['dataset', 'bilingual', 'extract', '--help'], makeDeps());
  assert.equal(extractHelp.exitCode, 0);
  assert.match(extractHelp.stdout, /--source-lang/u);

  const invalidExtractFlags = await executeCli(
    ['dataset', 'bilingual', 'extract', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidExtractFlags.exitCode, 2);
  assert.match(invalidExtractFlags.stderr, /INVALID_ARGS/u);

  const applyHelp = await executeCli(['dataset', 'bilingual', 'apply', '--help'], makeDeps());
  assert.equal(applyHelp.exitCode, 0);
  assert.match(applyHelp.stdout, /--translations/u);

  const validateHelp = await executeCli(['dataset', 'bilingual', 'validate', '--help'], makeDeps());
  assert.equal(validateHelp.exitCode, 0);
  assert.match(validateHelp.stdout, /schema\/outputs\/validation-report/u);

  const invalidAction = await executeCli(['dataset', 'bilingual', 'unknown'], makeDeps());
  assert.equal(invalidAction.exitCode, 2);
  assert.match(invalidAction.stderr, /INVALID_ARGS/u);

  const invalidApplyFlags = await executeCli(
    ['dataset', 'bilingual', 'apply', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidApplyFlags.exitCode, 2);
  assert.match(invalidApplyFlags.stderr, /INVALID_ARGS/u);

  const invalidValidateFlags = await executeCli(
    ['dataset', 'bilingual', 'validate', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidValidateFlags.exitCode, 2);
  assert.match(invalidValidateFlags.stderr, /INVALID_ARGS/u);
});
import { flowReferenceFixture } from './helpers/flow-reference-fixture.js';
