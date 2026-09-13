import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import { __testInternals, runFlowQa } from '../src/lib/flow-qa.js';

type JsonRecord = Record<string, unknown>;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeFlowRow(options: {
  id: string;
  version?: string;
  nameEn?: string;
  nameZh?: string;
  classification?: Array<{ level: string; classId: string; text: string }>;
  typeOfDataset?: string;
  quantRefInternalId?: string;
  propertyInternalId?: string;
  flowPropertyId?: string;
}): JsonRecord {
  return {
    id: options.id,
    version: options.version ?? '01.00.000',
    json_ordered: {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': options.id,
            name: {
              baseName: [
                { '@xml:lang': 'zh', '#text': options.nameZh ?? '中文流名称' },
                { '@xml:lang': 'en', '#text': options.nameEn ?? 'Flow name' },
              ],
            },
            classificationInformation: {
              'common:classification': {
                'common:class': options.classification?.map((entry) => ({
                  '@level': entry.level,
                  '@classId': entry.classId,
                  '#text': entry.text,
                })) ?? [
                  {
                    '@level': '0',
                    '@classId': '1000',
                    '#text': 'Water',
                  },
                ],
              },
            },
          },
          quantitativeReference: {
            referenceToReferenceFlowProperty: options.quantRefInternalId ?? '0',
          },
        },
        modellingAndValidation: {
          LCIMethodAndAllocation: {
            typeOfDataSet: options.typeOfDataset ?? 'Product flow',
          },
        },
        flowProperties: {
          flowProperty: [
            {
              '@dataSetInternalID': options.propertyInternalId ?? '0',
              referenceToFlowPropertyDataSet: {
                '@refObjectId': options.flowPropertyId ?? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                '@version': '01.00.000',
                'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Mass' }],
              },
            },
          ],
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': options.version ?? '01.00.000',
          },
        },
      },
    },
  };
}

function makeFlowDocument(options: Parameters<typeof makeFlowRow>[0]): JsonRecord {
  const row = makeFlowRow(options);
  return {
    flowDataSet: (row.json_ordered as JsonRecord).flowDataSet as JsonRecord,
  };
}

function createLlmFetch(outputText: string, observedBodies: unknown[] = []): FetchLike {
  return (async (_input, init) => {
    observedBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () =>
        JSON.stringify({
          output_text: outputText,
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            total_tokens: 42,
          },
        }),
    };
  }) as FetchLike;
}

test('runFlowQa materializes rows-file input and writes artifact-first QA outputs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-'));
  const rowsFile = path.join(dir, 'rows.json');
  const outDir = path.join(dir, 'review');

  writeJson(rowsFile, [
    makeFlowRow({
      id: '11111111-1111-1111-1111-111111111111',
      nameEn: 'Salt water',
      nameZh: '盐水',
    }),
    makeFlowRow({
      id: '22222222-2222-2222-2222-222222222222',
      nameEn: 'Salt water',
      nameZh: '盐水',
      quantRefInternalId: '99',
    }),
    {
      ...makeFlowRow({
        id: '',
        version: '',
        nameEn: '',
        nameZh: '',
      }),
      json_ordered: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': '11111111-1111-1111-1111-111111111111',
              'common:shortDescription': [{ '#text': 'Salt water' }],
              name: 'Salt water',
            },
            quantitativeReference: {},
          },
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Product flow',
            },
          },
          flowProperties: {
            flowProperty: [
              {
                '@dataSetInternalID': '5',
                referenceToFlowPropertyDataSet: 'not-a-uuid',
              },
            ],
          },
        },
      },
    },
  ]);

  try {
    const report = await runFlowQa({
      rowsFile,
      outDir,
      runId: 'flow-run-001',
      startTs: '2026-03-30T00:00:00.000Z',
      endTs: '2026-03-30T00:10:00.000Z',
      now: () => new Date('2026-03-30T00:11:00.000Z'),
    });

    assert.equal(report.status, 'completed_local_flow_qa');
    assert.equal(report.run_id, 'flow-run-001');
    assert.equal(report.input_mode, 'rows_file');
    assert.equal(report.rows_file, rowsFile);
    assert.equal(report.flow_count, 2);
    assert.equal(report.methodology_rule_source, 'built_in');
    assert.equal(report.with_reference_context, false);
    assert.equal(report.reference_context_mode, 'disabled');
    assert.equal(report.ruleset_id, 'flow-authoring/strict');
    assert.equal(report.ruleset_version, '1');
    assert.equal(report.ruleset_gate?.status, 'blocked');
    assert.ok((report.blocker_count ?? 0) > 0);
    assert.equal(report.llm.enabled, false);
    assert.equal(report.llm.reason, 'disabled');
    assert.ok(report.rule_finding_count > 0);
    assert.ok(report.finding_count >= report.rule_finding_count);
    assert.equal(report.generated_at_utc, '2026-03-30T00:11:00.000Z');
    assert.ok(existsSync(report.files.qa_input_summary));
    assert.ok(existsSync(report.files.materialization_summary ?? ''));
    assert.ok(existsSync(report.files.rule_findings));
    assert.ok(existsSync(report.files.ruleset_gate ?? ''));
    assert.ok(existsSync(report.files.findings));
    assert.ok(existsSync(report.files.flow_summaries));
    assert.ok(existsSync(report.files.similarity_pairs));
    assert.ok(existsSync(report.files.summary));
    assert.ok(existsSync(report.files.qa_zh));
    assert.ok(existsSync(report.files.qa_en));
    assert.ok(existsSync(report.files.timing));
    assert.ok(existsSync(report.files.report));

    const summary = JSON.parse(readFileSync(report.files.summary, 'utf8')) as JsonRecord;
    assert.equal(summary.flow_count, 2);
    assert.ok(
      Number(
        ((summary.methodology_rule_counts as JsonRecord) ?? {})[
          'tidas.flow.reference-property-unit.required'
        ],
      ) > 0,
    );
    assert.equal((summary.llm as JsonRecord).enabled, false);
    const materializationSummary = JSON.parse(
      readFileSync(report.files.materialization_summary ?? '', 'utf8'),
    ) as JsonRecord;
    assert.equal(materializationSummary.input_row_count, 3);
    assert.equal(materializationSummary.materialized_flow_count, 2);
    assert.equal(materializationSummary.duplicate_input_rows_collapsed, 1);

    const pairs = readFileSync(report.files.similarity_pairs, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(pairs.length, 0);

    const zhReview = readFileSync(report.files.qa_zh, 'utf8');
    assert.match(zhReview, /基础统计/u);
    assert.match(zhReview, /LLM 语义复审层/u);

    const timing = readFileSync(report.files.timing, 'utf8');
    assert.match(timing, /10\.00 min/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowQa supports flows-dir input and CLI-owned LLM semantic review', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-llm-'));
  const flowsDir = path.join(dir, 'flows');
  const outDir = path.join(dir, 'review');
  const observedBodies: unknown[] = [];

  writeJson(
    path.join(flowsDir, 'flow-a.json'),
    makeFlowDocument({
      id: '33333333-3333-3333-3333-333333333333',
      nameEn: 'Hydrogen gas',
      nameZh: '氢气',
    }),
  );
  writeJson(
    path.join(flowsDir, 'flow-b.json'),
    makeFlowDocument({
      id: '66666666-6666-6666-6666-666666666666',
      nameEn: 'Hydrogen gas',
      nameZh: '氢气',
    }),
  );

  try {
    const report = await runFlowQa({
      flowsDir,
      outDir,
      runId: 'flow-run-llm',
      enableLlm: true,
      llmModel: 'gpt-5.4',
      llmMaxFlows: 1,
      methodologyId: 'custom-method',
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      fetchImpl: createLlmFetch(
        JSON.stringify({
          findings: [
            {
              flow_uuid: '33333333-3333-3333-3333-333333333333',
              severity: 'warning',
              fixability: 'review-needed',
              evidence: 'name too generic',
              action: 'add route qualifier',
            },
            {
              severity: 'medium',
              evidence: { note: 'dedupe me' },
              suggestion: 'dedupe me',
            },
            {
              flow_uuid: '33333333-3333-3333-3333-333333333333',
              severity: 'medium',
              evidence: { note: 'dedupe me' },
              suggestion: 'dedupe me',
            },
          ],
        }),
        observedBodies,
      ),
    });

    assert.equal(report.input_mode, 'flows_dir');
    assert.equal(report.files.materialization_summary, null);
    assert.equal(report.methodology_rule_source, 'custom-method');
    assert.equal(report.llm.enabled, true);
    assert.equal(report.llm.ok, true);
    assert.equal(report.llm.batch_count, 1);
    assert.equal(report.llm.reviewed_flow_count, 1);
    assert.equal(report.llm.truncated, true);
    assert.equal(report.llm_finding_count, 2);
    assert.equal(observedBodies.length, 1);
    assert.equal((observedBodies[0] as JsonRecord).model, 'gpt-5.4');

    const llmFindings = readFileSync(report.files.llm_findings, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(llmFindings.length, 2);
    assert.equal(llmFindings[0].flow_uuid, '33333333-3333-3333-3333-333333333333');
    assert.equal((llmFindings[0].evidence as JsonRecord).text, 'name too generic');
    assert.equal(llmFindings[1].action, 'dedupe me');

    const reviewZh = readFileSync(report.files.qa_zh, 'utf8');
    assert.match(reviewZh, /仅复审前/u);
    const reviewEn = readFileSync(report.files.qa_en, 'utf8');
    assert.match(reviewEn, /reviewed only the first/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow-qa internals handle invalid input modes, fallback run-root resolution, and malformed flow files', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-internals-'));
  const outDir = path.join(dir, 'review');
  const runRoot = path.join(dir, 'run-root');
  const exportsFlowsDir = path.join(runRoot, 'exports', 'flows');

  writeJson(path.join(exportsFlowsDir, 'broken.json'), ['not-an-object']);

  try {
    await assert.rejects(
      runFlowQa({
        rowsFile: path.join(dir, 'rows.json'),
        flowsDir: path.join(dir, 'flows'),
        outDir,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'FLOW_QA_INPUT_MODE_REQUIRED');
        return true;
      },
    );

    assert.equal(
      Array.isArray(__testInternals.parseLlmJsonOutput('prefix {"findings": []} suffix')?.findings),
      true,
    );
    assert.equal(__testInternals.parseLlmJsonOutput('[]'), null);
    assert.equal(__testInternals.parseLlmJsonOutput('not json at all'), null);

    const resolved = __testInternals.resolveReviewInput({
      runRoot,
      outDir,
    });
    assert.equal(resolved.inputMode, 'run_root');
    assert.equal(resolved.effectiveFlowsDir, exportsFlowsDir);

    const summaryResult = __testInternals.buildFlowSummaryAndRuleFindings(
      {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': '44444444-4444-4444-4444-444444444444',
              name: {
                baseName: [{ '@xml:lang': 'zh', '#text': 'a;b' }],
              },
            },
          },
        },
      },
      'built_in',
    );
    const ruleIds = summaryResult.findings.map((finding) => finding.rule_id);
    assert.ok(ruleIds.includes('missing_type_of_dataset'));
    assert.ok(ruleIds.includes('missing_flow_property'));
    assert.ok(ruleIds.includes('methodology_basename_semicolon'));

    const missingNameSummary = __testInternals.buildFlowSummaryAndRuleFindings(
      {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': '55555555-5555-5555-5555-555555555555',
            },
          },
        },
      },
      'built_in',
    );
    assert.ok(
      missingNameSummary.findings
        .map((finding) => finding.rule_id)
        .includes('methodology_missing_base_name_en'),
    );

    const rareSummary = __testInternals.buildFlowSummaryAndRuleFindings(
      {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': '77777777-7777-7777-7777-777777777777',
              name: 'Emergy sample',
              classificationInformation: {
                'common:classification': {
                  'common:class': [{ '@level': '1', '#text': 'Gap class' }],
                },
                'common:elementaryFlowCategorization': {
                  'common:category': [{ '@level': '1', '#text': 'Gap category' }],
                },
              },
            },
            quantitativeReference: {},
          },
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Elementary flow',
            },
          },
          flowProperties: {
            flowProperty: [
              {
                '@dataSetInternalID': '5',
                referenceToFlowPropertyDataSet: 'not-a-uuid',
              },
            ],
          },
        },
      },
      'built_in',
    );
    const rareRuleIds = rareSummary.findings.map((finding) => finding.rule_id);
    assert.ok(rareRuleIds.includes('elementary_flow_in_flow_qa'));
    assert.ok(rareRuleIds.includes('name_contains_emergy'));
    assert.ok(rareRuleIds.includes('flow_property_exact_reference_invalid'));
    assert.ok(rareRuleIds.includes('flow_property_reference_unresolved'));
    assert.ok(rareRuleIds.includes('methodology_missing_class_id'));
    assert.ok(rareRuleIds.includes('methodology_missing_cat_id'));
    assert.ok(rareRuleIds.includes('methodology_product_classification_level_gap'));
    assert.ok(rareRuleIds.includes('methodology_elementary_classification_level_gap'));

    const similarity = __testInternals.buildSimilarity(
      [
        {
          ...summaryResult.summary,
          flow_uuid: 'flow-a',
          classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
          flow_property: { referenced_uuid: 'prop-1' },
          _name_fingerprint: 'salt water',
          similarity_candidates: [],
        },
        {
          ...summaryResult.summary,
          flow_uuid: 'flow-b',
          classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
          flow_property: { referenced_uuid: 'prop-1' },
          _name_fingerprint: 'salt water',
          similarity_candidates: [],
        },
      ],
      0.92,
    );
    assert.equal(similarity.pairs.length, 1);
    assert.equal(similarity.candidatesByFlow['flow-a'][0].other_flow_uuid, 'flow-b');

    const skippedSimilarity = __testInternals.buildSimilarity(
      [
        {
          ...summaryResult.summary,
          flow_uuid: 'flow-c',
          classification: { leaf: { class_id: '', text: '', key: '' }, path: [] },
          flow_property: {},
          _name_fingerprint: '',
          similarity_candidates: [],
        },
        {
          ...summaryResult.summary,
          flow_uuid: 'flow-d',
          classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
          flow_property: { referenced_uuid: 'prop-1' },
          _name_fingerprint: 'left tokens',
          similarity_candidates: [],
        },
        {
          ...summaryResult.summary,
          flow_uuid: 'flow-e',
          classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
          flow_property: { referenced_uuid: 'prop-1' },
          _name_fingerprint: 'right tokens',
          similarity_candidates: [],
        },
      ],
      0.92,
    );
    assert.equal(skippedSimilarity.pairs.length, 0);

    const missingDir = path.join(dir, 'missing-flows');
    assert.throws(
      () => __testInternals.listFlowFiles(missingDir),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'FLOW_QA_DIR_NOT_FOUND');
        return true;
      },
    );

    await assert.rejects(
      runFlowQa({
        flowsDir: exportsFlowsDir,
        outDir,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'FLOW_QA_INVALID_FLOW_FILE');
        return true;
      },
    );

    writeFileSync(path.join(exportsFlowsDir, 'malformed.json'), '{broken', 'utf8');
    assert.throws(
      () => __testInternals.readJsonObject(path.join(exportsFlowsDir, 'malformed.json')),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'FLOW_QA_INVALID_FLOW_FILE');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow-qa helpers cover methodology fallbacks, similarity sorting, and truncated rendering', () => {
  const detailed = __testInternals.buildFlowSummaryAndRuleFindings(
    {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
            name: {
              baseName: ['Fallback English'],
            },
            classificationInformation: {
              'common:classification': {
                'common:class': [
                  { '@level': '0', '#text': 'Top class' },
                  { '@level': '2', '@classId': '200', '#text': 'Leaf class' },
                ],
              },
              'common:elementaryFlowCategorization': {
                'common:category': [
                  { '@level': '0', '#text': 'Air' },
                  { '@level': '2', '@catId': '20', '#text': 'Urban air' },
                ],
              },
            },
          },
          quantitativeReference: {},
        },
        modellingAndValidation: {
          LCIMethodAndAllocation: {
            typeOfDataSet: 'Unknown flow',
          },
        },
        flowProperties: {
          flowProperty: [
            {
              '@dataSetInternalID': '7',
              referenceToFlowPropertyDataSet: {
                nested_uuid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
              },
            },
          ],
        },
      },
    },
    'custom-method',
  );
  const detailedRuleIds = detailed.findings.map((finding) => finding.rule_id);
  assert.ok(detailedRuleIds.includes('methodology_invalid_type_of_dataset'));
  assert.ok(detailedRuleIds.includes('methodology_missing_class_id'));
  assert.ok(detailedRuleIds.includes('methodology_missing_cat_id'));
  assert.ok(detailedRuleIds.includes('methodology_product_classification_level_gap'));
  assert.ok(detailedRuleIds.includes('methodology_elementary_classification_level_gap'));
  assert.ok(detailedRuleIds.includes('flow_property_reference_unresolved'));
  assert.equal(detailed.summary.names.primary_en, 'Fallback English');
  assert.equal(detailed.summary.flow_property.referenced_uuid, undefined);
  assert.equal(detailed.summary.flow_property.selected_internal_id, undefined);
  assert.equal(__testInternals.computeSimilarity('', 'alpha beta'), 0);
  assert.equal(__testInternals.computeSimilarity('   ', 'alpha beta'), 0);
  assert.equal(__testInternals.computeSimilarity('alpha beta', 'alpha beta'), 1);

  const sortableSimilarity = __testInternals.buildSimilarity(
    ['flow-c', 'flow-a', 'flow-b'].map((flowUuidValue) => ({
      ...detailed.summary,
      flow_uuid: flowUuidValue,
      names: {
        primary_en: 'Alpha beta',
        primary_zh: '',
        all_texts: ['Alpha beta'],
      },
      classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
      flow_property: { referenced_uuid: 'prop-1' },
      _name_fingerprint: 'alpha beta',
      similarity_candidates: [],
    })),
    0.92,
  );
  assert.deepEqual(
    sortableSimilarity.candidatesByFlow['flow-a'].map((item) => item.other_flow_uuid),
    ['flow-b', 'flow-c'],
  );

  const sparseSimilarity = __testInternals.buildSimilarity(
    [
      {
        ...detailed.summary,
        flow_uuid: 'sparse-a',
        classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
        flow_property: { referenced_uuid: 'prop-1' },
        _name_fingerprint: '   ',
        similarity_candidates: [],
      },
      {
        ...detailed.summary,
        flow_uuid: 'sparse-b',
        classification: { leaf: { class_id: '100', text: 'Water', key: '100|Water' }, path: [] },
        flow_property: { referenced_uuid: 'prop-1' },
        _name_fingerprint: 'token name',
        similarity_candidates: [],
      },
    ],
    0.1,
  );
  assert.equal(sparseSimilarity.pairs.length, 0);

  const actionFromSuggested = __testInternals.normalizeLlmFinding(
    {
      severity: 'medium',
      suggested_action: 'review duplicate',
      evidence: 123,
    },
    {},
    'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
  );
  assert.equal(actionFromSuggested?.flow_uuid, 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb');
  assert.equal(actionFromSuggested?.severity, 'warning');
  assert.equal(actionFromSuggested?.action, 'review duplicate');
  assert.deepEqual(actionFromSuggested?.evidence, { text: '123' });

  const truncatedSummary = {
    schema_version: 1 as const,
    generated_at_utc: '2026-03-30T00:00:00.000Z',
    status: 'completed_local_flow_qa' as const,
    run_id: 'truncated',
    out_dir: '/tmp/review',
    rows_file: '/tmp/flows.jsonl',
    input_mode: 'flows_dir' as const,
    effective_flows_dir: '/tmp/flows',
    logic_version: 'flow-v1.0-cli',
    flow_count: 1,
    similarity_threshold: 0.92,
    methodology_rule_source: 'custom-method',
    with_reference_context: false as const,
    reference_context_mode: 'disabled' as const,
    rule_finding_count: 1,
    llm_finding_count: 1,
    finding_count: 2,
    severity_counts: { warning: 2 },
    rule_counts: { sample_rule: 1 },
    llm: {
      enabled: true,
      ok: true,
      batch_count: 1,
      reviewed_flow_count: 1,
      truncated: true,
      batch_results: [],
    },
    files: {
      qa_input_summary: '',
      materialization_summary: null,
      rule_findings: '',
      llm_findings: '',
      findings: '',
      flow_summaries: '',
      similarity_pairs: '',
      summary: '',
      qa_zh: '',
      qa_en: '',
      timing: '',
      report: '',
    },
  };
  const llmFinding = {
    flow_uuid: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    base_version: '',
    severity: 'warning',
    fixability: 'review-needed',
    source: 'llm' as const,
    action: 'review duplicate',
  };
  const zhTruncated = __testInternals.renderZhReview({
    runId: 'truncated',
    logicVersion: 'flow-v1.0-cli',
    flowsDir: '/tmp/flows',
    flowSummaries: [
      {
        ...detailed.summary,
        similarity_candidates: [],
        rule_signals: [],
      } as unknown as JsonRecord,
    ],
    ruleFindings: [llmFinding],
    llmFindings: [llmFinding],
    llmResult: truncatedSummary.llm,
    mergedFindings: [llmFinding],
    summary: truncatedSummary,
  });
  assert.match(zhTruncated, /仅复审前/u);

  const enTruncated = __testInternals.renderEnReview({
    runId: 'truncated',
    logicVersion: 'flow-v1.0-cli',
    flowsDir: '/tmp/flows',
    flowCount: 1,
    ruleFindingCount: 1,
    llmFindingCount: 1,
    llmResult: truncatedSummary.llm,
    methodologyRuleSource: 'custom-method',
  });
  assert.match(enTruncated, /only the first/u);
});

test('flow-qa direct helpers cover rare fallback branches', () => {
  assert.deepEqual(__testInternals.walkStrings('   '), []);
  assert.deepEqual(__testInternals.walkStrings({ '#text': 'Root|Text', nested: [' Child '] }), [
    'Root|Text',
    'Root|Text',
    'Child',
  ]);
  assert.equal(__testInternals.langTextForLang(['Fallback English'], 'en'), 'Fallback English');
  assert.equal(
    __testInternals.findUuidInNode({
      '@uri': 'urn:uuid:CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC',
    }),
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
  );
  assert.equal(
    __testInternals.findUuidInNode({
      nested_uuid: 'DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD',
    }),
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
  );
  assert.deepEqual(
    __testInternals.flowRoot({
      flowDataSet: {
        ok: true,
      },
    } as JsonRecord),
    { ok: true },
  );
  assert.deepEqual(__testInternals.flowRoot({ ok: true } as JsonRecord), { ok: true });

  const fingerprintFlow = {
    flowInformation: {
      dataSetInformation: {
        name: {
          treatmentStandardsRoutes: ['Route|A'],
          mixAndLocationTypes: [{ '#text': 'Mix|B' }],
        },
      },
    },
  } as JsonRecord;
  assert.equal(__testInternals.nameFingerprint(fingerprintFlow), 'route a mix b');
  assert.equal(
    __testInternals.nameFingerprint({
      flowInformation: {
        dataSetInformation: {
          name: {
            nested: ['Fallback|Name'],
          },
        },
      },
    } as JsonRecord),
    'fallback name',
  );

  assert.deepEqual(__testInternals.classificationLeaf({} as JsonRecord), {
    class_id: '',
    text: '',
    key: '',
  });
  assert.deepEqual(
    __testInternals.classificationLeaf({
      flowInformation: {
        dataSetInformation: {
          classificationInformation: {
            'common:classification': {
              'common:class': [{ '@level': '0', '#text': 'Leaf text' }],
            },
          },
        },
      },
    } as JsonRecord),
    {
      class_id: '',
      text: 'Leaf text',
      key: 'Leaf text',
    },
  );

  const methodologyFindings = __testInternals.applyMethodologyChecks(
    {
      flowInformation: {
        dataSetInformation: {
          name: {
            baseName: [{ '@xml:lang': 'en', '#text': 'Alpha;Beta' }],
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                { '@level': '0', '#text': 'Top class' },
                { '@level': '2', '@classId': '200', '#text': 'Leaf class' },
              ],
            },
            'common:elementaryFlowCategorization': {
              'common:category': [
                { '@level': '0', '#text': 'Air' },
                { '@level': '2', '@catId': '20', '#text': 'Urban air' },
              ],
            },
          },
        },
        quantitativeReference: {
          referenceToReferenceFlowProperty: '99',
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: 'Custom flow',
        },
      },
      flowProperties: {
        flowProperty: [{ '@dataSetInternalID': '7' }],
      },
    } as JsonRecord,
    'flow-1',
    '01.00.000',
    'method-source',
  );
  const methodologyRuleIds = methodologyFindings.map((finding) => finding.rule_id);
  assert.ok(methodologyRuleIds.includes('methodology_invalid_type_of_dataset'));
  assert.ok(methodologyRuleIds.includes('methodology_basename_semicolon'));
  assert.ok(methodologyRuleIds.includes('methodology_quant_ref_missing_target'));
  assert.ok(methodologyRuleIds.includes('methodology_missing_class_id'));
  assert.ok(methodologyRuleIds.includes('methodology_missing_cat_id'));
  assert.ok(methodologyRuleIds.includes('methodology_product_classification_level_gap'));
  assert.ok(methodologyRuleIds.includes('methodology_elementary_classification_level_gap'));

  const noUuidSummary = __testInternals.buildFlowSummaryAndRuleFindings(
    {
      flowInformation: {
        dataSetInformation: {
          name: {
            baseName: [{ '@xml:lang': 'en', '#text': 'No UUID flow' }],
          },
        },
        quantitativeReference: {},
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: 'Product flow',
        },
      },
      flowProperties: {
        flowProperty: [
          {
            referenceToFlowPropertyDataSet: 'not-a-uuid',
          },
        ],
      },
    } as JsonRecord,
    'built_in',
  );
  assert.equal(noUuidSummary.summary.flow_uuid, '(missing-uuid)');
  assert.equal(noUuidSummary.summary.flow_property.selected_internal_id, undefined);
  const noUuidRuleIds = noUuidSummary.findings.map((finding) => finding.rule_id);
  assert.ok(noUuidRuleIds.includes('missing_classification_leaf'));
  assert.ok(noUuidRuleIds.includes('flow_property_exact_reference_invalid'));
  assert.ok(noUuidRuleIds.includes('flow_property_reference_unresolved'));
  assert.deepEqual(
    __testInternals.methodologyRuleCounts([
      {
        flow_uuid: 'flow-llm',
        base_version: '',
        severity: 'warning',
        source: 'llm',
      },
    ]),
    {},
  );
  assert.equal(__testInternals.flowRulesetGate([]).status, 'passed');

  const warningRule = __testInternals.createRuleFinding(
    'flow-2',
    '01.00.000',
    'warning',
    'sample_rule',
    'sample message',
  );
  assert.deepEqual(__testInternals.severityCounts([warningRule]), { warning: 1 });
  assert.deepEqual(__testInternals.ruleCounts([warningRule]), { sample_rule: 1 });

  const normalizedWithSuggestion = __testInternals.normalizeLlmFinding(
    {
      flow_uuid: 'missing-base-version',
      severity: 'critical',
      suggestion: 'use suggestion field',
    },
    {},
  );
  assert.equal(normalizedWithSuggestion?.base_version, '');
  assert.equal(normalizedWithSuggestion?.severity, 'warning');
  assert.equal(normalizedWithSuggestion?.action, 'use suggestion field');
});

test('flow-qa internal llm helpers cover disabled, fallback, invalid-json, and failure branches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-llm-internals-'));
  const summaries = [
    {
      flow_uuid: '88888888-8888-8888-8888-888888888888',
      base_version: '01.00.000',
      type_of_dataset: 'Product flow',
      names: { primary_en: 'Alpha', primary_zh: '甲', all_texts: ['Alpha'] },
      classification: { leaf: { class_id: '1', text: 'Water', key: '1|Water' }, path: [] },
      flow_property: { referenced_uuid: 'prop-1' },
      quantitative_reference: { reference_flow_property_internal_id: '0' },
      unitgroup: {
        uuid: '',
        name: '',
        reference_unit_name: '',
        lookup_status: 'disabled',
        lookup_source: '',
      },
      rule_signals: [],
      similarity_candidates: [],
      _name_fingerprint: 'alpha',
    },
    {
      flow_uuid: '99999999-9999-9999-9999-999999999999',
      base_version: '01.00.000',
      type_of_dataset: 'Product flow',
      names: { primary_en: 'Beta', primary_zh: '乙', all_texts: ['Beta'] },
      classification: { leaf: { class_id: '1', text: 'Water', key: '1|Water' }, path: [] },
      flow_property: { referenced_uuid: 'prop-1' },
      quantitative_reference: { reference_flow_property_internal_id: '0' },
      unitgroup: {
        uuid: '',
        name: '',
        reference_unit_name: '',
        lookup_status: 'disabled',
        lookup_source: '',
      },
      rule_signals: [],
      similarity_candidates: [],
      _name_fingerprint: 'beta',
    },
  ] as Parameters<typeof __testInternals.runOptionalLlmReview>[0];

  const disabled = await __testInternals.runOptionalLlmReview(summaries, {
    enableLlm: false,
    llmMaxFlows: 10,
    llmBatchSize: 1,
    env: process.env,
    outDir: dir,
    runId: 'disabled',
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, 'disabled');

  const nonJson = await __testInternals.runOptionalLlmReview(summaries, {
    enableLlm: true,
    llmMaxFlows: 10,
    llmBatchSize: 2,
    env: {
      TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
      TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
      TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
    } as NodeJS.ProcessEnv,
    fetchImpl: createLlmFetch('not-json-response'),
    outDir: dir,
    runId: 'non-json',
  });
  assert.equal(nonJson.ok, false);
  assert.equal(nonJson.batch_results[0].reason, 'llm_non_json_output');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('global fetch failure');
  }) as typeof globalThis.fetch;
  try {
    const failure = await __testInternals.runOptionalLlmReview(summaries, {
      enableLlm: true,
      llmMaxFlows: 10,
      llmBatchSize: 2,
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      outDir: path.join(dir, 'failure-run'),
      runId: 'failure',
    });
    assert.equal(failure.ok, false);
    assert.match(failure.batch_results[0].reason ?? '', /global fetch failure/u);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const normalized = __testInternals.normalizeLlmFinding(
    { severity: 'medium', suggestion: 'review it' },
    { '88888888-8888-8888-8888-888888888888': summaries[0] },
    '88888888-8888-8888-8888-888888888888',
  );
  assert.equal(normalized?.severity, 'warning');
  assert.equal(normalized?.action, 'review it');
  assert.deepEqual(normalized?.evidence, undefined);

  const recordEvidence = __testInternals.normalizeLlmFinding(
    {
      flow_uuid: '88888888-8888-8888-8888-888888888888',
      severity: 'info',
      evidence: { ok: true },
    },
    { '88888888-8888-8888-8888-888888888888': summaries[0] },
  );
  assert.deepEqual(recordEvidence?.evidence, { ok: true });

  const missingFlowUuid = __testInternals.normalizeLlmFinding(
    { severity: 'warning' },
    { '88888888-8888-8888-8888-888888888888': summaries[0] },
  );
  assert.equal(missingFlowUuid, null);

  const prompt = __testInternals.buildLlmPrompt([{ sample: true }]);
  assert.match(prompt, /输出格式/u);

  const zhFailure = __testInternals.renderZhReview({
    runId: 'zh-failure',
    logicVersion: 'flow-v1.0-cli',
    flowsDir: '/tmp/flows',
    flowSummaries: [],
    ruleFindings: [],
    llmFindings: [],
    llmResult: {
      enabled: true,
      ok: false,
      reason: 'failed',
      batch_count: 1,
      reviewed_flow_count: 1,
      truncated: false,
      batch_results: [],
    },
    mergedFindings: [],
    summary: {
      schema_version: 1,
      generated_at_utc: '2026-03-30T00:00:00.000Z',
      status: 'completed_local_flow_qa',
      run_id: 'zh-failure',
      out_dir: dir,
      rows_file: path.join(dir, 'flows.jsonl'),
      input_mode: 'flows_dir',
      effective_flows_dir: '/tmp/flows',
      logic_version: 'flow-v1.0-cli',
      flow_count: 0,
      similarity_threshold: 0.92,
      methodology_rule_source: 'built_in',
      with_reference_context: false,
      reference_context_mode: 'disabled',
      rule_finding_count: 0,
      llm_finding_count: 0,
      finding_count: 0,
      severity_counts: {},
      rule_counts: {},
      llm: {
        enabled: true,
        ok: false,
        reason: 'failed',
        batch_count: 1,
        reviewed_flow_count: 1,
        truncated: false,
        batch_results: [],
      },
      files: {
        qa_input_summary: '',
        materialization_summary: null,
        rule_findings: '',
        llm_findings: '',
        findings: '',
        flow_summaries: '',
        similarity_pairs: '',
        summary: '',
        qa_zh: '',
        qa_en: '',
        timing: '',
        report: '',
      },
    },
  });
  assert.match(zhFailure, /调用失败/u);

  const zhNoFindings = __testInternals.renderZhReview({
    runId: 'zh-ok',
    logicVersion: 'flow-v1.0-cli',
    flowsDir: '/tmp/flows',
    flowSummaries: [],
    ruleFindings: [],
    llmFindings: [],
    llmResult: {
      enabled: true,
      ok: true,
      batch_count: 1,
      reviewed_flow_count: 1,
      truncated: false,
      batch_results: [],
    },
    mergedFindings: [],
    summary: {
      schema_version: 1,
      generated_at_utc: '2026-03-30T00:00:00.000Z',
      status: 'completed_local_flow_qa',
      run_id: 'zh-ok',
      out_dir: dir,
      rows_file: path.join(dir, 'flows.jsonl'),
      input_mode: 'flows_dir',
      effective_flows_dir: '/tmp/flows',
      logic_version: 'flow-v1.0-cli',
      flow_count: 0,
      similarity_threshold: 0.92,
      methodology_rule_source: 'built_in',
      with_reference_context: false,
      reference_context_mode: 'disabled',
      rule_finding_count: 0,
      llm_finding_count: 0,
      finding_count: 0,
      severity_counts: {},
      rule_counts: {},
      llm: {
        enabled: true,
        ok: true,
        batch_count: 1,
        reviewed_flow_count: 1,
        truncated: false,
        batch_results: [],
      },
      files: {
        qa_input_summary: '',
        materialization_summary: null,
        rule_findings: '',
        llm_findings: '',
        findings: '',
        flow_summaries: '',
        similarity_pairs: '',
        summary: '',
        qa_zh: '',
        qa_en: '',
        timing: '',
        report: '',
      },
    },
  });
  assert.match(zhNoFindings, /未返回额外语义 findings/u);

  const enFailure = __testInternals.renderEnReview({
    runId: 'en-failure',
    logicVersion: 'flow-v1.0-cli',
    flowsDir: '/tmp/flows',
    flowCount: 0,
    ruleFindingCount: 0,
    llmFindingCount: 0,
    llmResult: {
      enabled: true,
      ok: false,
      reason: 'failed',
      batch_count: 1,
      reviewed_flow_count: 1,
      truncated: false,
      batch_results: [],
    },
    methodologyRuleSource: 'built_in',
  });
  assert.match(enFailure, /LLM failed/u);

  const timing = __testInternals.renderTimingReview({
    runId: 'timing',
    startTs: 'bad-start',
    endTs: 'bad-end',
    flowCount: 1,
  });
  assert.match(timing, /bad-start/u);

  await assert.rejects(
    runFlowQa({
      rowsFile: path.join(dir, 'rows.json'),
      outDir: '',
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'FLOW_QA_OUT_DIR_REQUIRED');
      return true;
    },
  );

  const emptyFlowDir = path.join(dir, 'empty-flows');
  mkdirSync(emptyFlowDir, { recursive: true });
  await assert.rejects(
    runFlowQa({
      flowsDir: emptyFlowDir,
      outDir: path.join(dir, 'empty-review'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'FLOW_QA_NO_FLOW_FILES');
      return true;
    },
  );

  const missingDir = path.join(dir, 'not-there');
  await assert.rejects(
    runFlowQa({
      flowsDir: missingDir,
      outDir: path.join(dir, 'missing-dir-review'),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'FLOW_QA_DIR_NOT_FOUND');
      return true;
    },
  );

  rmSync(dir, { recursive: true, force: true });
});

test('flow-qa LLM review deduplicates fallback findings from single-item batches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-llm-dedupe-'));
  const summaries = [
    {
      flow_uuid: '12121212-3434-5656-7878-909090909090',
      base_version: '01.00.000',
      type_of_dataset: 'Product flow',
      names: { primary_en: 'Single batch flow', primary_zh: '', all_texts: ['Single batch flow'] },
      classification: { leaf: { class_id: '1', text: 'Water', key: '1|Water' }, path: [] },
      flow_property: { referenced_uuid: 'prop-1' },
      quantitative_reference: { reference_flow_property_internal_id: '0' },
      unitgroup: {
        uuid: '',
        name: '',
        reference_unit_name: '',
        lookup_status: 'disabled',
        lookup_source: '',
      },
      rule_signals: [],
      similarity_candidates: [],
      _name_fingerprint: 'single batch flow',
    },
  ] as Parameters<typeof __testInternals.runOptionalLlmReview>[0];

  try {
    const success = await __testInternals.runOptionalLlmReview(summaries, {
      enableLlm: true,
      llmMaxFlows: 1,
      llmBatchSize: 1,
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      fetchImpl: createLlmFetch(
        JSON.stringify({
          findings: [
            {
              severity: 'medium',
              suggested_action: 'dedupe this finding',
              evidence: 'single-batch evidence',
            },
            {
              severity: 'medium',
              suggested_action: 'dedupe this finding',
              evidence: 'single-batch evidence',
            },
          ],
        }),
      ),
      outDir: dir,
      runId: 'dedupe',
    });

    assert.equal(success.enabled, true);
    assert.equal(success.ok, true);
    assert.equal(success.batch_count, 1);
    assert.equal(success.reviewed_flow_count, 1);
    assert.equal(success.llmFindings.length, 1);
    assert.equal(success.llmFindings[0].flow_uuid, summaries[0].flow_uuid);
    assert.equal(success.llmFindings[0].severity, 'warning');
    assert.equal(success.llmFindings[0].action, 'dedupe this finding');
    assert.deepEqual(success.llmFindings[0].evidence, { text: 'single-batch evidence' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow-qa direct runtime helpers cover materialization, non-array findings, and rendering defaults', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-direct-runtime-'));
  const rowsFile = path.join(dir, 'rows.json');
  const outDir = path.join(dir, 'review');
  const cacheFlowsDir = path.join(dir, 'run-root', 'cache', 'flows');

  writeJson(rowsFile, [
    {
      json_ordered: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              name: {
                baseName: [{ '@xml:lang': 'en', '#text': 'Row zero flow' }],
              },
            },
          },
        },
      },
    },
  ]);
  mkdirSync(cacheFlowsDir, { recursive: true });

  try {
    const materialized = __testInternals.materializeRowsFile(rowsFile, outDir);
    const materializationSummary = JSON.parse(
      readFileSync(materialized.summaryPath, 'utf8'),
    ) as JsonRecord;
    assert.equal(materializationSummary.materialized_flow_count, 1);
    const materializedItem = (materializationSummary.items as JsonRecord[])[0];
    assert.match(String(materializedItem.file), /row-0__01\.00\.000\.json/u);

    const resolvedRows = __testInternals.resolveReviewInput({
      rowsFile,
      outDir,
    });
    assert.equal(resolvedRows.runId, 'rows');

    const resolvedRunRoot = __testInternals.resolveReviewInput({
      runRoot: path.join(dir, 'run-root'),
      outDir,
    });
    assert.equal(resolvedRunRoot.effectiveFlowsDir, cacheFlowsDir);

    const resolvedRunRootFallback = __testInternals.resolveReviewInput({
      runRoot: path.join(dir, 'run-root-fallback'),
      outDir,
    });
    assert.equal(
      resolvedRunRootFallback.effectiveFlowsDir,
      path.join(dir, 'run-root-fallback', 'cache', 'flows'),
    );

    const summaries = [
      {
        flow_uuid: 'aaaaaaaa-0000-0000-0000-000000000000',
        base_version: '01.00.000',
        type_of_dataset: 'Product flow',
        names: { primary_en: 'Alpha', primary_zh: '', all_texts: ['Alpha'] },
        classification: { leaf: { class_id: '1', text: 'Water', key: '1|Water' }, path: [] },
        flow_property: { referenced_uuid: 'prop-1' },
        quantitative_reference: { reference_flow_property_internal_id: '0' },
        unitgroup: {
          uuid: '',
          name: '',
          reference_unit_name: '',
          lookup_status: 'disabled',
          lookup_source: '',
        },
        rule_signals: [],
        similarity_candidates: [],
        _name_fingerprint: 'alpha',
      },
      {
        flow_uuid: 'bbbbbbbb-0000-0000-0000-000000000000',
        base_version: '01.00.000',
        type_of_dataset: 'Product flow',
        names: { primary_en: 'Beta', primary_zh: '', all_texts: ['Beta'] },
        classification: { leaf: { class_id: '1', text: 'Water', key: '1|Water' }, path: [] },
        flow_property: { referenced_uuid: 'prop-1' },
        quantitative_reference: { reference_flow_property_internal_id: '0' },
        unitgroup: {
          uuid: '',
          name: '',
          reference_unit_name: '',
          lookup_status: 'disabled',
          lookup_source: '',
        },
        rule_signals: [],
        similarity_candidates: [],
        _name_fingerprint: 'beta',
      },
    ] as Parameters<typeof __testInternals.runOptionalLlmReview>[0];

    const noArrayFindings = await __testInternals.runOptionalLlmReview(summaries, {
      enableLlm: true,
      llmMaxFlows: 0,
      llmBatchSize: 2,
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      fetchImpl: createLlmFetch(JSON.stringify({ findings: { not: 'an-array' } })),
      outDir: path.join(dir, 'no-array'),
      runId: 'no-array',
    });
    assert.equal(noArrayFindings.ok, true);
    assert.equal(noArrayFindings.reviewed_flow_count, 2);
    assert.equal(noArrayFindings.llmFindings.length, 0);

    const multiBatchSuccess = await __testInternals.runOptionalLlmReview(summaries, {
      enableLlm: true,
      llmMaxFlows: 2,
      llmBatchSize: 2,
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      fetchImpl: createLlmFetch(
        JSON.stringify({
          findings: [
            {
              flow_uuid: summaries[1].flow_uuid,
              severity: 'info',
            },
            {
              flow_uuid: summaries[1].flow_uuid,
              severity: 'info',
            },
          ],
        }),
      ),
      outDir: path.join(dir, 'multi-batch'),
      runId: 'multi-batch',
    });
    assert.equal(multiBatchSuccess.ok, true);
    assert.equal(multiBatchSuccess.llmFindings.length, 1);
    assert.equal(multiBatchSuccess.llmFindings[0].flow_uuid, summaries[1].flow_uuid);

    const stringFailure = await __testInternals.runOptionalLlmReview(summaries, {
      enableLlm: true,
      llmMaxFlows: 2,
      llmBatchSize: 2,
      env: {
        TIANGONG_LCA_REVIEW_LLM_BASE_URL: 'https://llm.example/v1',
        TIANGONG_LCA_REVIEW_LLM_API_KEY: 'llm-key',
        TIANGONG_LCA_REVIEW_LLM_MODEL: 'gpt-5.4-mini',
      } as NodeJS.ProcessEnv,
      fetchImpl: (async () => {
        throw 'string failure';
      }) as FetchLike,
      outDir: path.join(dir, 'string-failure'),
      runId: 'string-failure',
    });
    assert.equal(stringFailure.ok, false);
    assert.equal(stringFailure.batch_results[0].reason, 'string failure');

    const zhDisabled = __testInternals.renderZhReview({
      runId: 'zh-disabled',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowSummaries: [
        {
          flow_uuid: 'pipe|uuid',
          base_version: '01|00',
          type_of_dataset: 'Product|flow',
          names: { primary_en: 'Pipe|Name', primary_zh: '', all_texts: [] },
          classification: {
            leaf: { class_id: '1', text: 'Leaf|Text', key: '1|Leaf|Text' },
            path: [],
          },
          flow_property: { referenced_short_name_en: 'Mass|Unit', referenced_uuid: 'prop-1' },
          quantitative_reference: { reference_flow_property_internal_id: '0' },
          unitgroup: {
            uuid: '',
            name: '',
            reference_unit_name: '',
            lookup_status: 'disabled',
            lookup_source: '',
          },
          rule_signals: [],
          similarity_candidates: [],
        } as unknown as JsonRecord,
      ],
      ruleFindings: [
        __testInternals.createRuleFinding('pipe|uuid', '01|00', 'warning', 'rule', 'msg'),
      ],
      llmFindings: [],
      llmResult: {
        enabled: false,
        batch_count: 0,
        reviewed_flow_count: 0,
        truncated: false,
        batch_results: [],
      },
      mergedFindings: [
        __testInternals.createRuleFinding('pipe|uuid', '01|00', 'warning', 'rule', 'msg'),
      ],
      summary: {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_local_flow_qa',
        run_id: 'zh-disabled',
        out_dir: dir,
        rows_file: path.join(dir, 'flows.jsonl'),
        input_mode: 'flows_dir',
        effective_flows_dir: '/tmp/flows',
        logic_version: 'flow-v1.0-cli',
        flow_count: 1,
        similarity_threshold: 0.92,
        methodology_rule_source: 'built_in',
        with_reference_context: false,
        reference_context_mode: 'disabled',
        rule_finding_count: 1,
        llm_finding_count: 0,
        finding_count: 1,
        severity_counts: { warning: 1 },
        rule_counts: { rule: 1 },
        llm: {
          enabled: false,
          batch_count: 0,
          reviewed_flow_count: 0,
          truncated: false,
          batch_results: [],
        },
        files: {
          qa_input_summary: '',
          materialization_summary: null,
          rule_findings: '',
          llm_findings: '',
          findings: '',
          flow_summaries: '',
          similarity_pairs: '',
          summary: '',
          qa_zh: '',
          qa_en: '',
          timing: '',
          report: '',
        },
      },
    });
    assert.match(zhDisabled, /未启用/u);
    assert.match(zhDisabled, /Pipe\/Name/u);

    const zhUuidFallback = __testInternals.renderZhReview({
      runId: 'zh-uuid-fallback',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowSummaries: [
        {
          flow_uuid: 'uuid-only',
          base_version: '01.00.000',
          type_of_dataset: 'Product flow',
          names: { primary_en: 'UUID fallback row', primary_zh: '', all_texts: [] },
          classification: { leaf: { class_id: '1', text: 'Leaf', key: '1|Leaf' }, path: [] },
          flow_property: { referenced_uuid: 'prop|uuid' },
          quantitative_reference: { reference_flow_property_internal_id: '0' },
          unitgroup: {
            uuid: '',
            name: '',
            reference_unit_name: '',
            lookup_status: 'disabled',
            lookup_source: '',
          },
          rule_signals: [],
          similarity_candidates: [],
        } as unknown as JsonRecord,
      ],
      ruleFindings: [],
      llmFindings: [],
      llmResult: {
        enabled: false,
        batch_count: 0,
        reviewed_flow_count: 0,
        truncated: false,
        batch_results: [],
      },
      mergedFindings: [],
      summary: {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_local_flow_qa',
        run_id: 'zh-uuid-fallback',
        out_dir: dir,
        rows_file: path.join(dir, 'flows.jsonl'),
        input_mode: 'flows_dir',
        effective_flows_dir: '/tmp/flows',
        logic_version: 'flow-v1.0-cli',
        flow_count: 1,
        similarity_threshold: 0.92,
        methodology_rule_source: 'built_in',
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
          qa_input_summary: '',
          materialization_summary: null,
          rule_findings: '',
          llm_findings: '',
          findings: '',
          flow_summaries: '',
          similarity_pairs: '',
          summary: '',
          qa_zh: '',
          qa_en: '',
          timing: '',
          report: '',
        },
      },
    });
    assert.match(zhUuidFallback, /prop\/uuid/u);

    const zhWithPipes = __testInternals.renderZhReview({
      runId: 'zh-pipes',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowSummaries: [],
      ruleFindings: [],
      llmFindings: [
        {
          flow_uuid: 'flow|uuid',
          base_version: '',
          severity: 'warning',
          fixability: 'review-needed',
          source: 'llm',
          evidence: { note: 'a|b' },
          action: 'do|it',
        },
      ],
      llmResult: {
        enabled: true,
        ok: true,
        batch_count: 1,
        reviewed_flow_count: 1,
        truncated: false,
        batch_results: [],
      },
      mergedFindings: [
        {
          flow_uuid: 'flow|uuid',
          base_version: '',
          severity: 'warning',
          fixability: 'review-needed',
          source: 'llm',
          evidence: { note: 'a|b' },
          action: 'do|it',
        },
      ],
      summary: {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_local_flow_qa',
        run_id: 'zh-pipes',
        out_dir: dir,
        rows_file: path.join(dir, 'flows.jsonl'),
        input_mode: 'flows_dir',
        effective_flows_dir: '/tmp/flows',
        logic_version: 'flow-v1.0-cli',
        flow_count: 0,
        similarity_threshold: 0.92,
        methodology_rule_source: 'built_in',
        with_reference_context: false,
        reference_context_mode: 'disabled',
        rule_finding_count: 0,
        llm_finding_count: 1,
        finding_count: 1,
        severity_counts: { warning: 1 },
        rule_counts: {},
        llm: {
          enabled: true,
          ok: true,
          batch_count: 1,
          reviewed_flow_count: 1,
          truncated: false,
          batch_results: [],
        },
        files: {
          qa_input_summary: '',
          materialization_summary: null,
          rule_findings: '',
          llm_findings: '',
          findings: '',
          flow_summaries: '',
          similarity_pairs: '',
          summary: '',
          qa_zh: '',
          qa_en: '',
          timing: '',
          report: '',
        },
      },
    });
    assert.match(zhWithPipes, /flow\/uuid/u);
    assert.match(zhWithPipes, /do\/it/u);

    const zhFailureUnknown = __testInternals.renderZhReview({
      runId: 'zh-failure-unknown',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowSummaries: [],
      ruleFindings: [],
      llmFindings: [],
      llmResult: {
        enabled: true,
        ok: false,
        batch_count: 1,
        reviewed_flow_count: 1,
        truncated: false,
        batch_results: [],
      },
      mergedFindings: [],
      summary: {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_local_flow_qa',
        run_id: 'zh-failure-unknown',
        out_dir: dir,
        rows_file: path.join(dir, 'flows.jsonl'),
        input_mode: 'flows_dir',
        effective_flows_dir: '/tmp/flows',
        logic_version: 'flow-v1.0-cli',
        flow_count: 0,
        similarity_threshold: 0.92,
        methodology_rule_source: 'built_in',
        with_reference_context: false,
        reference_context_mode: 'disabled',
        rule_finding_count: 0,
        llm_finding_count: 0,
        finding_count: 0,
        severity_counts: {},
        rule_counts: {},
        llm: {
          enabled: true,
          ok: false,
          batch_count: 1,
          reviewed_flow_count: 1,
          truncated: false,
          batch_results: [],
        },
        files: {
          qa_input_summary: '',
          materialization_summary: null,
          rule_findings: '',
          llm_findings: '',
          findings: '',
          flow_summaries: '',
          similarity_pairs: '',
          summary: '',
          qa_zh: '',
          qa_en: '',
          timing: '',
          report: '',
        },
      },
    });
    assert.match(zhFailureUnknown, /调用失败：`unknown`/u);

    const enDisabled = __testInternals.renderEnReview({
      runId: 'en-disabled',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowCount: 1,
      ruleFindingCount: 0,
      llmFindingCount: 0,
      llmResult: {
        enabled: false,
        batch_count: 0,
        reviewed_flow_count: 0,
        truncated: false,
        batch_results: [],
      },
      methodologyRuleSource: 'built_in',
    });
    assert.match(enDisabled, /LLM disabled: `disabled`/u);

    const enFailureUnknown = __testInternals.renderEnReview({
      runId: 'en-failure-unknown',
      logicVersion: 'flow-v1.0-cli',
      flowsDir: '/tmp/flows',
      flowCount: 1,
      ruleFindingCount: 0,
      llmFindingCount: 0,
      llmResult: {
        enabled: true,
        ok: false,
        batch_count: 1,
        reviewed_flow_count: 1,
        truncated: false,
        batch_results: [],
      },
      methodologyRuleSource: 'built_in',
    });
    assert.match(enFailureUnknown, /LLM failed: `unknown`/u);

    const flowsDir = path.join(dir, 'explicit-logic-flows');
    writeJson(
      path.join(flowsDir, 'flow.json'),
      makeFlowDocument({
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        nameEn: 'Explicit logic flow',
        nameZh: '显式逻辑流',
      }),
    );
    const explicitLogicReport = await runFlowQa({
      flowsDir,
      outDir: path.join(dir, 'explicit-logic-review'),
      logicVersion: 'custom-flow-logic',
    });
    assert.equal(explicitLogicReport.logic_version, 'custom-flow-logic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
