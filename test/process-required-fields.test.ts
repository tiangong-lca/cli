import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals,
  collectProcessPlaceholderIssues,
  collectProcessRequiredFieldIssues,
  runProcessRequiredFieldsComplete,
} from '../src/lib/process-required-fields.js';

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

function processRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proc-1',
    version: '01.01.000',
    json_ordered: {
      processDataSet: {
        processInformation: {
          quantitativeReference: {
            referenceToReferenceFlow: '5',
          },
        },
        exchanges: {
          exchange: [
            {
              '@dataSetInternalID': '5',
              exchangeDirection: 'Output',
              meanAmount: '3.6',
              referenceToFlowDataSet: {
                '@refObjectId': 'flow-1',
                'common:shortDescription': [
                  { '@xml:lang': 'en', '#text': 'Alternating current; electricity mix' },
                ],
              },
            },
          ],
        },
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {},
          validation: {
            review: {
              '@type': 'Not reviewed',
            },
          },
          complianceDeclarations: {
            compliance: {
              'common:referenceToComplianceSystem': {
                '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
                '@type': 'source data set',
                '@version': '00.00.001',
              },
              'common:approvalOfOverallCompliance': 'Not defined',
              'common:nomenclatureCompliance': 'Not defined',
              'common:methodologicalCompliance': 'Not defined',
              'common:reviewCompliance': 'Not defined',
              'common:documentationCompliance': 'Not defined',
              'common:qualityCompliance': 'Not defined',
            },
          },
        },
      },
    },
    ...overrides,
  };
}

function annualSupplyFrom(row: unknown) {
  return (
    row as {
      json_ordered: {
        processDataSet: {
          modellingAndValidation: {
            dataSourcesTreatmentAndRepresentativeness: {
              annualSupplyOrProductionVolume: Array<{ '#text': string; '@xml:lang': string }>;
            };
          };
        };
      };
    }
  ).json_ordered.processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness
    .annualSupplyOrProductionVolume;
}

test('runProcessRequiredFieldsComplete keeps an unknown annual volume as a blocked evidence gap', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-required-fields-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outPath = path.join(dir, 'completed.jsonl');
  const outDir = path.join(dir, 'artifacts');
  writeJsonl(inputPath, [processRow(), { id: 'flow-1', json_ordered: { flowDataSet: {} } }]);

  try {
    const report = await runProcessRequiredFieldsComplete({
      inputPath,
      outPath,
      outDir,
      defaultUnit: 'kg',
      flowInputPath: 'memory-flows',
      rawFlowInput: [
        {
          id: 'flow-1',
          json_ordered: {
            flowDataSet: {
              flowProperties: {
                flowProperty: {
                  referenceToFlowPropertyDataSet: {
                    '@refObjectId': '93a60a56-a3c8-11da-a746-0800200c9a66',
                    'common:shortDescription': [
                      { '@xml:lang': 'en', '#text': 'Net calorific value' },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_blockers');
    assert.deepEqual(report.counts, {
      total: 2,
      processes: 1,
      completed: 0,
      existing: 0,
      blocked: 1,
      skipped: 1,
    });
    assert.equal(existsSync(report.files.output_rows), true);
    assert.deepEqual(readJson(report.files.report ?? ''), report);
    assert.equal(report.rows[0]?.status, 'blocked');
    assert.equal(
      report.rows[0]?.issues.some(
        (issue) => issue.code === 'annual_supply_or_production_volume_missing',
      ),
      true,
    );
    const completedRows = readJsonl(report.files.output_rows) as unknown[];
    assert.deepEqual(
      annualSupplyFrom(completedRows[0]),
      [],
      'the 3.6 reference amount is not annual-volume evidence',
    );
    assert.equal(
      annualSupplyFrom(completedRows[0]).some(
        (item) => item['#text'] === __testInternals.ANNUAL_SUPPLY_MISSING_DATA_SENTINEL_TEXT,
      ),
      false,
      'the historical sentinel must never be written as annual-volume evidence',
    );
    const evidenceRows = readJsonl(report.files.evidence ?? '') as Array<{
      source: string;
      reference_exchange_internal_id: string | null;
    }>;
    assert.equal(evidenceRows.length, 1);
    assert.equal(evidenceRows[0]?.source, 'unknown_preserved');
    assert.equal(evidenceRows[0]?.reference_exchange_internal_id, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessRequiredFieldsComplete prefers explicit evidence values over reference amounts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-required-fields-evidence-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outPath = path.join(dir, 'completed.jsonl');
  writeJsonl(inputPath, [
    processRow({
      evidence_manifest: {
        field_bindings: [
          {
            field_path:
              'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
            amount: '125000',
            unit: 'kWh',
          },
        ],
      },
    }),
  ]);

  try {
    const report = await runProcessRequiredFieldsComplete({
      inputPath,
      outPath,
      defaultUnit: 'unit',
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows[0]?.completions[0]?.source, 'evidence');
    assert.deepEqual(annualSupplyFrom(readJsonl(outPath)[0]), [
      { '@xml:lang': 'en', '#text': '125000 kWh/year' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessRequiredFieldsComplete keeps existing valid values and blocks missing amounts', async () => {
  const existing = processRow();
  const processRoot = (
    existing.json_ordered as {
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: Record<string, unknown>;
        };
      };
    }
  ).processDataSet;
  processRoot.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume =
    [
      { '@xml:lang': 'en', '#text': '99 kg/year' },
      { '@xml:lang': 'zh', '#text': '99 kg/年' },
    ];

  const sentinel = processRow({ id: 'proc-sentinel' });
  (sentinel.json_ordered as { processDataSet: { exchanges: unknown } }).processDataSet.exchanges = {
    exchange: [{ '@dataSetInternalID': '5', exchangeDirection: 'Output' }],
  };

  const report = await runProcessRequiredFieldsComplete({
    inputPath: 'memory',
    outPath: path.join(os.tmpdir(), `completed-${process.pid}.jsonl`),
    rawInput: [existing, sentinel],
  });

  assert.equal(report.status, 'completed_with_blockers');
  assert.equal(report.counts.existing, 1);
  assert.equal(report.counts.completed, 0);
  assert.equal(report.counts.blocked, 1);
  assert.equal(report.rows[0]?.status, 'existing');
  assert.equal(report.rows[1]?.status, 'blocked');
  assert.equal(report.rows[1]?.completions.at(-1)?.source, 'unknown_preserved');

  const outputRows = readJsonl(report.files.output_rows) as unknown[];
  assert.deepEqual(
    annualSupplyFrom(outputRows[0]),
    [
      { '@xml:lang': 'en', '#text': '99 kg/year' },
      { '@xml:lang': 'zh', '#text': '99 kg/年' },
    ],
    'a real bilingual value keeps its exact content and order',
  );
  assert.deepEqual(
    annualSupplyFrom(outputRows[1]),
    [],
    'a row without source-evidence volume stays unknown instead of completing',
  );
});

test('runProcessRequiredFieldsComplete repairs UI-roundtripped annual reference-flow text', async () => {
  const row = processRow();
  const processRoot = (
    row.json_ordered as {
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: Record<string, unknown>;
        };
      };
    }
  ).processDataSet;
  processRoot.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume =
    [
      {
        '@xml:lang': 'en',
        '#text': '3.6 MJ Alternating current; electricity mix; production mix, at plant; 35-330kV',
      },
      {
        '@xml:lang': 'zh',
        '#text': '3.6 交流电; 电力混合; 生产组合，在电厂; 35-330千伏',
      },
    ];

  const report = await runProcessRequiredFieldsComplete({
    inputPath: 'memory',
    outPath: path.join(os.tmpdir(), `completed-ui-roundtrip-${process.pid}.jsonl`),
    rawInput: [row],
    defaultUnit: 'kg',
    flowInputPath: 'memory-flows',
    rawFlowInput: [
      {
        id: 'flow-1',
        json_ordered: {
          flowDataSet: {
            flowProperties: {
              flowProperty: {
                referenceToFlowPropertyDataSet: {
                  '@refObjectId': '93a60a56-a3c8-11da-a746-0800200c9a66',
                },
              },
            },
          },
        },
      },
    ],
  });

  assert.equal(report.status, 'completed_with_blockers');
  assert.equal(report.rows[0]?.status, 'blocked');
  assert.equal(
    report.rows[0]?.issues.some(
      (issue) => issue.code === 'annual_supply_or_production_volume_not_annualized',
    ),
    true,
    'a UI-roundtripped reference-flow description is not annual-volume evidence',
  );
  assert.equal(
    report.rows[0]?.completions.some((item) => item.amount === '9999'),
    false,
    'no sentinel amount may be written for a present-but-not-annualized value',
  );
});

test('runProcessRequiredFieldsComplete repairs missing validation and compliance structures', async () => {
  const row = processRow();
  const processRoot = (
    row.json_ordered as {
      processDataSet: {
        modellingAndValidation: Record<string, unknown>;
      };
    }
  ).processDataSet;
  processRoot.modellingAndValidation = {
    dataSourcesTreatmentAndRepresentativeness: {
      annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
    },
  };

  const report = await runProcessRequiredFieldsComplete({
    inputPath: 'memory',
    outPath: path.join(os.tmpdir(), `completed-required-structure-${process.pid}.jsonl`),
    rawInput: [row],
  });

  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.rows[0]?.completions.map((completion) => completion.source),
    ['required_structure_repair', 'required_structure_repair'],
  );
  const modelling = (
    readJsonl(report.files.output_rows)[0] as {
      json_ordered: {
        processDataSet: {
          modellingAndValidation: {
            validation: { review: { '@type': string } };
            complianceDeclarations: {
              compliance: {
                'common:referenceToComplianceSystem': { '@refObjectId': string };
                'common:approvalOfOverallCompliance': string;
              };
            };
          };
        };
      };
    }
  ).json_ordered.processDataSet.modellingAndValidation;
  assert.equal(modelling.validation.review['@type'], 'Not reviewed');
  assert.equal(
    modelling.complianceDeclarations.compliance['common:referenceToComplianceSystem'][
      '@refObjectId'
    ],
    'c84c4185-d1b0-44fc-823e-d2ec630c7906',
  );
  assert.equal(
    modelling.complianceDeclarations.compliance['common:approvalOfOverallCompliance'],
    'Not defined',
  );
});

test('runProcessRequiredFieldsComplete validates required output flags and blocks resultingAmount-only rows without source evidence', async () => {
  await assert.rejects(
    () =>
      runProcessRequiredFieldsComplete({
        inputPath: 'memory',
        outPath: '   ',
        rawInput: [],
      }),
    /Missing required --out value/u,
  );

  const row = processRow();
  const exchange = ((
    row.json_ordered as {
      processDataSet: { exchanges: { exchange: Array<Record<string, unknown>> } };
    }
  ).processDataSet.exchanges.exchange[0] ?? {}) as Record<string, unknown>;
  delete exchange.meanAmount;
  exchange.resultingAmount = '4.2';
  exchange.unit = 'kg';

  const report = await runProcessRequiredFieldsComplete({
    inputPath: 'memory',
    outPath: path.join(os.tmpdir(), `completed-resulting-${process.pid}.jsonl`),
    rawInput: [row],
  });

  assert.equal(report.status, 'completed_with_blockers');
  assert.equal(report.rows[0]?.status, 'blocked');
  assert.equal(report.rows[0]?.completions.at(-1)?.source, 'unknown_preserved');
  assert.deepEqual(
    annualSupplyFrom((readJsonl(report.files.output_rows) as unknown[])[0]),
    [],
    'a 4.2 kg resulting amount is a reference amount, not annual-volume evidence',
  );
});

test('process required field issue collector detects missing and invalid annual volumes', () => {
  const validRequiredStructures = {
    validation: {
      review: {
        '@type': 'Not reviewed',
      },
    },
    complianceDeclarations: {
      compliance: {
        'common:referenceToComplianceSystem': {
          '@refObjectId': 'c84c4185-d1b0-44fc-823e-d2ec630c7906',
        },
        'common:approvalOfOverallCompliance': 'Not defined',
        'common:nomenclatureCompliance': 'Not defined',
        'common:methodologicalCompliance': 'Not defined',
        'common:reviewCompliance': 'Not defined',
        'common:documentationCompliance': 'Not defined',
        'common:qualityCompliance': 'Not defined',
      },
    },
  };
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: 'not-an-object',
      },
    }).map((issue) => issue.code),
    ['process_data_sources_treatment_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:other': {
              'tiangongfoundry:unresolvedTrace': [
                {
                  status: 'unresolved_deferred',
                  action_item_code: 'annual_supply_or_production_volume_invalid',
                  blocked_path:
                    'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
                  reason: 'No annualized source quantity is available.',
                  evidence: {
                    source: 'source_row',
                    quote_or_trace: 'annualSupplyOrProductionVolume.#text = Not specified',
                  },
                  next_action: 'Curate an annualized quantity from explicit source evidence.',
                },
              ],
            },
          },
        },
        modellingAndValidation: {
          ...validRequiredStructures,
        },
      },
    }).map((issue) => issue.code),
    ['process_data_sources_treatment_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {},
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:other': {
              'tiangongfoundry:unresolvedTrace': [
                {
                  status: 'unresolved_deferred',
                  action_item_code: 'annual_supply_or_production_volume_invalid',
                  blocked_path:
                    'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
                  reason: 'No annualized source quantity is available.',
                  evidence: {
                    source: 'source_row',
                    quote_or_trace: 'annualSupplyOrProductionVolume.#text = Not specified',
                  },
                  next_action: 'Curate an annualized quantity from explicit source evidence.',
                },
              ],
            },
          },
        },
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            dataCutOffAndCompletenessPrinciples: {
              '@xml:lang': 'en',
              '#text': 'Not specified',
            },
            referenceToDataSource: {
              '@type': 'source data set',
              '@refObjectId': 'source-1',
            },
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [
              {
                '@xml:lang': 'en',
                '#text': '0 kg/year; source production volume unavailable',
              },
            ],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_missing'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': 'not quantified' }],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_invalid'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          ...validRequiredStructures,
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [
              { '@xml:lang': 'en', '#text': '3.6 MJ electricity mix' },
            ],
          },
        },
      },
    }).map((issue) => issue.code),
    ['annual_supply_or_production_volume_not_annualized'],
  );
  assert.deepEqual(
    collectProcessRequiredFieldIssues({
      processDataSet: {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
          },
        },
      },
    }).map((issue) => issue.code),
    ['process_validation_review_missing', 'process_compliance_declaration_missing'],
  );
  assert.equal(
    __testInternals.findAnnualSupplyEvidenceValue(
      {
        required_fields: {
          annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '10 t/year' }],
        },
      },
      {},
      { defaultUnit: 'kg' },
    )?.amount,
    '10',
  );
});

test('process placeholder issue collector blocks unfinished authoring placeholders', () => {
  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        modellingAndValidation: {
          validation: {
            'common:reviewDetails': {
              '#text': 'Review summary pending confirmation.',
              '@xml:lang': 'en',
            },
            'common:referenceToCompleteReviewReport': {
              '@uri': 'https://placeholder.example/review-report',
              '@refObjectId': '00000000-0000-0000-0000-000000000003',
            },
          },
        },
      },
    }).map((issue) => issue.path),
    [
      'processDataSet.modellingAndValidation.validation.common:reviewDetails.#text',
      'processDataSet.modellingAndValidation.validation.common:referenceToCompleteReviewReport.@uri',
      'processDataSet.modellingAndValidation.validation.common:referenceToCompleteReviewReport.@refObjectId',
    ],
  );

  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        modellingAndValidation: {
          validation: {
            review: {
              '@type': 'Not reviewed',
            },
          },
        },
      },
    }),
    [],
  );

  assert.deepEqual(
    collectProcessPlaceholderIssues({
      processDataSet: {
        processInformation: {
          time: { 'common:referenceYear': 9999 },
          importedTime: { 'common:referenceYear': '9999' },
          dataSetInformation: {
            name: {
              treatmentStandardsRoutes: {
                '@xml:lang': 'en',
                '#text': 'Not declared in source package',
              },
            },
            'common:other': {
              'tidasimport:sourceTrace': {
                '@marker': 'TIDAS_IMPORT_TRACE_V1',
                payload: { sourceObject: '/Users/example/source.spold' },
              },
            },
          },
        },
      },
    }).map((issue) => issue.path),
    [
      'processDataSet.processInformation.time.common:referenceYear',
      'processDataSet.processInformation.importedTime.common:referenceYear',
      'processDataSet.processInformation.dataSetInformation.name.treatmentStandardsRoutes.#text',
      'processDataSet.processInformation.dataSetInformation.common:other.tidasimport:sourceTrace.@marker',
      'processDataSet.processInformation.dataSetInformation.common:other.tidasimport:sourceTrace.payload.sourceObject',
    ],
  );
});

test('runProcessRequiredFieldsComplete removes placeholder review metadata', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-required-fields-placeholders-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outPath = path.join(dir, 'completed.jsonl');
  const outDir = path.join(dir, 'artifacts');
  writeJsonl(inputPath, [
    processRow({
      json_ordered: {
        processDataSet: {
          processInformation: {
            quantitativeReference: {
              referenceToReferenceFlow: '5',
            },
          },
          exchanges: {
            exchange: [
              {
                '@dataSetInternalID': '5',
                exchangeDirection: 'Output',
                meanAmount: '3.6',
              },
            ],
          },
          modellingAndValidation: {
            validation: {
              review: {
                'common:reviewDetails': {
                  '#text': 'Review details pending confirmation.',
                  '@xml:lang': 'en',
                },
              },
              'common:reviewDetails': {
                '#text': 'Review summary pending confirmation.',
                '@xml:lang': 'en',
              },
              'common:referenceToCompleteReviewReport': {
                '@uri': 'https://placeholder.example/review-report',
              },
            },
            dataSourcesTreatmentAndRepresentativeness: {
              annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
            },
          },
        },
      },
    }),
  ]);

  try {
    const report = await runProcessRequiredFieldsComplete({
      inputPath,
      outPath,
      outDir,
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows[0]?.status, 'completed');
    assert.deepEqual(
      report.rows[0]?.completions.map((completion) => completion.source),
      [
        'placeholder_repair',
        'placeholder_repair',
        'placeholder_repair',
        'required_structure_repair',
        'required_structure_repair',
      ],
    );
    const validation = (
      readJsonl(outPath)[0] as {
        json_ordered: {
          processDataSet: {
            modellingAndValidation: {
              validation: Record<string, unknown>;
            };
          };
        };
      }
    ).json_ordered.processDataSet.modellingAndValidation.validation;
    assert.equal((validation.review as Record<string, unknown>)['common:reviewDetails'], undefined);
    assert.equal((validation.review as Record<string, unknown>)['@type'], 'Not reviewed');
    assert.equal(validation['common:reviewDetails'], undefined);
    assert.equal(validation['common:referenceToCompleteReviewReport'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessRequiredFieldsComplete repairs placeholder metadata in every ordered review', async () => {
  const row = processRow();
  const modelling = (row.json_ordered as any).processDataSet.modellingAndValidation;
  modelling.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume = [
    { '@xml:lang': 'en', '#text': '3.6 MJ/year' },
  ];
  modelling.validation.review = [
    {
      '@type': 'Not reviewed',
      'common:reviewDetails': { '#text': 'Review details pending confirmation.' },
    },
    {
      '@type': 'Not reviewed',
      'common:referenceToCompleteReviewReport': {
        '@uri': 'https://placeholder.example/review-report',
      },
    },
    null,
  ];

  const report = await runProcessRequiredFieldsComplete({
    inputPath: 'memory',
    outPath: path.join(os.tmpdir(), `completed-review-array-${process.pid}.jsonl`),
    rawInput: [row],
  });

  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.rows[0]?.completions
      .filter((completion) => completion.source === 'placeholder_repair')
      .map((completion) => completion.field_path),
    [
      'processDataSet.modellingAndValidation.validation.review.0.common:reviewDetails',
      'processDataSet.modellingAndValidation.validation.review.1.common:referenceToCompleteReviewReport',
    ],
  );
  const output = readJsonl(report.files.output_rows)[0] as any;
  assert.deepEqual(output.json_ordered.processDataSet.modellingAndValidation.validation.review, [
    { '@type': 'Not reviewed' },
    { '@type': 'Not reviewed' },
    null,
  ]);
});

test('runProcessRequiredFieldsComplete blocks unresolved placeholder content', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-required-fields-unresolved-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const outPath = path.join(dir, 'completed.jsonl');
  writeJsonl(inputPath, [
    processRow({
      json_ordered: {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:generalComment': {
                '#text': 'Technology pending confirmation.',
                '@xml:lang': 'en',
              },
            },
          },
          modellingAndValidation: {
            dataSourcesTreatmentAndRepresentativeness: {
              annualSupplyOrProductionVolume: [{ '@xml:lang': 'en', '#text': '3.6 MJ/year' }],
            },
          },
        },
      },
    }),
  ]);

  try {
    const report = await runProcessRequiredFieldsComplete({
      inputPath,
      outPath,
    });

    assert.equal(report.status, 'completed_with_blockers');
    assert.equal(report.rows[0]?.status, 'blocked');
    assert.deepEqual(
      report.rows[0]?.issues.map((issue) => issue.code),
      ['process_placeholder_content'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process required field internals cover evidence normalization and helper fallbacks', () => {
  assert.equal(__testInternals.textValue('   '), null);
  assert.equal(__testInternals.textValue(12), '12');
  assert.equal(__testInternals.textValue(false), null);
  assert.equal(__testInternals.issuePath([]), '<root>');
  assert.equal(__testInternals.issuePath(['a', 0, 'b']), 'a.0.b');
  assert.equal(__testInternals.valueAtPath({ a: { b: 1 } }, 'a.b'), 1);
  assert.equal(__testInternals.valueAtPath({ a: 1 }, 'a.b'), undefined);

  assert.equal(__testInternals.annualSupplyTextParts('not quantified'), null);
  assert.deepEqual(__testInternals.annualSupplyTextParts('15 kg/year'), {
    amount: '15',
    unit: 'kg/year',
  });
  assert.equal(__testInternals.annualSupplyValueFromText('not quantified'), null);
  assert.deepEqual(__testInternals.annualSupplyValueFromText('5 kg/year')?.value, [
    { '@xml:lang': 'en', '#text': '5 kg/year' },
  ]);
  assert.deepEqual(__testInternals.annualSupplyValueFromText('5 kg/年')?.value, [
    { '@xml:lang': 'zh', '#text': '5 kg/年' },
  ]);
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue(6, { defaultUnit: 'MWh' }),
    null,
    'a bare amount plus a default unit is not annual-volume evidence',
  );
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue('bad', { defaultUnit: 'kg' }),
    null,
  );
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue(
      [{ '@xml:lang': 'en', '#text': '7 t/year' }],
      { defaultUnit: 'kg' },
    )?.amount,
    '7',
  );
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue(
      { value: { amount: '8', unit: 'm3' } },
      { defaultUnit: 'kg' },
    )?.unit,
    'm3',
  );
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue(
      { en: '9 kg/year', zh: '9 kg/年' },
      { defaultUnit: 'kg' },
    )?.amount,
    '9',
  );
  assert.deepEqual(
    __testInternals.normalizeAnnualSupplyEvidenceValue(
      { source_language: 'zh', en: '9 kg/year', zh: '9 kg/年' },
      { defaultUnit: 'kg' },
    )?.value,
    [{ '@xml:lang': 'zh', '#text': '9 kg/年' }],
  );
  assert.equal(
    __testInternals.normalizeAnnualSupplyEvidenceValue(
      { amount: '10', referenceUnit: 'kg' },
      { defaultUnit: 'unit' },
    ),
    null,
    'a reference amount plus a reference unit is not annual-volume evidence',
  );
  assert.equal(__testInternals.normalizeAnnualSupplyEvidenceValue({}, { defaultUnit: 'kg' }), null);

  assert.equal(__testInternals.isAnnualSupplyEvidencePath(null), false);
  assert.equal(__testInternals.isValidComplianceDeclaration(['not-an-object']), false);
  assert.equal(
    __testInternals.isValidComplianceDeclaration([
      {
        'common:referenceToComplianceSystem': 'not-an-object',
        'common:approvalOfOverallCompliance': 'Not defined',
        'common:nomenclatureCompliance': 'Not defined',
        'common:methodologicalCompliance': 'Not defined',
        'common:reviewCompliance': 'Not defined',
        'common:documentationCompliance': 'Not defined',
        'common:qualityCompliance': 'Not defined',
      },
    ]),
    false,
  );
  assert.equal(
    __testInternals.isAnnualSupplyEvidencePath(
      'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
    ),
    true,
  );
  assert.equal(
    __testInternals.isAnnualSupplyEvidencePath(
      'payload.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
    ),
    true,
  );
  assert.equal(__testInternals.fieldPathFromEvidenceEntry({ fieldPath: 'field-a' }), 'field-a');
  assert.equal(
    __testInternals.findAnnualSupplyEvidenceEntry(
      {
        field_path:
          'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
        text: '11 kg/year',
      },
      { defaultUnit: 'kg' },
    )?.amount,
    '11',
  );
  assert.equal(__testInternals.findAnnualSupplyEvidenceEntry(null, { defaultUnit: 'kg' }), null);
  assert.equal(
    __testInternals.findAnnualSupplyEvidenceEntry(
      {
        field_bindings: [
          { field_path: 'other', amount: '1', unit: 'kg' },
          {
            path: 'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
            amount: '12',
            unit: 'kg',
          },
        ],
      },
      { defaultUnit: 'kg' },
    )?.amount,
    '12',
  );
  assert.equal(
    __testInternals.findAnnualSupplyEvidenceEntry(
      { field_bindings: [{ field_path: 'other' }] },
      {
        defaultUnit: 'kg',
      },
    ),
    null,
  );
});

test('process required field internals cover exchange, unit, and row wrapper fallbacks', () => {
  const rootWithoutModelling: Record<string, unknown> = {};
  const dataSources = __testInternals.ensureDataSources(rootWithoutModelling);
  assert.deepEqual(dataSources, {});
  assert.deepEqual(rootWithoutModelling, {
    modellingAndValidation: {
      dataSourcesTreatmentAndRepresentativeness: {},
    },
  });

  assert.equal(__testInternals.selectReferenceExchange({}), null);
  assert.deepEqual(
    __testInternals.selectReferenceExchange({
      exchanges: { exchange: { quantitativeReference: true, meanAmount: '1' } },
    }),
    { quantitativeReference: true, meanAmount: '1' },
  );
  assert.deepEqual(
    __testInternals.selectReferenceExchange({
      exchanges: { exchange: [{ exchangeDirection: 'Output', meanAmount: '2' }] },
    }),
    { exchangeDirection: 'Output', meanAmount: '2' },
  );
  assert.deepEqual(
    __testInternals.selectReferenceExchange({
      processInformation: {
        quantitativeReference: {
          referenceToReferenceFlow: '5',
        },
      },
      exchanges: {
        exchange: [
          { '@dataSetInternalID': '1', exchangeDirection: 'Output', meanAmount: '1' },
          { '@dataSetInternalID': '5', exchangeDirection: 'Input', meanAmount: '5' },
        ],
      },
    }),
    { '@dataSetInternalID': '5', exchangeDirection: 'Input', meanAmount: '5' },
  );
  assert.equal(
    __testInternals.selectReferenceExchange({
      exchanges: { exchange: [{ meanAmount: '3' }] },
    }),
    null,
  );

  assert.equal(__testInternals.inferUnitFromReferenceExchange({ unit: 'kg' }, 'unit'), 'kg');
  assert.equal(
    __testInternals.inferUnitFromReferenceExchange(
      {
        referenceToFlowDataSet: {
          '@refObjectId': '93a60a56-a3c8-11da-a746-0800200c9a66',
        },
      },
      'unit',
    ),
    'MJ',
  );
  assert.equal(
    __testInternals.inferUnitFromReferenceExchange(
      {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            '@refObjectId': '93a60a56-a3c8-11da-a746-0800200c9a66',
          },
        },
      },
      'unit',
    ),
    'MJ',
  );
  assert.equal(
    __testInternals.inferUnitFromReferenceExchange(
      {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Net calorific value' }],
          },
        },
      },
      'unit',
    ),
    'MJ',
  );
  assert.equal(__testInternals.inferUnitFromReferenceExchange({}, 'unit'), 'unit');
  assert.equal(
    __testInternals.inferUnitFromReferenceExchange(
      {
        referenceToFlowDataSet: {
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Electrical energy' }],
        },
      },
      'unit',
    ),
    'MJ',
  );
  assert.equal(
    __testInternals.inferUnitFromReferenceExchange(
      {
        referenceToFlowDataSet: {
          '@refObjectId': 'flow-external',
        },
      },
      {
        defaultUnit: 'unit',
        flowUnitById: new Map([['flow-external', 'MJ']]),
      },
    ),
    'MJ',
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            classificationInformation: {
              'common:classification': {
                'common:class': [{ '@xml:lang': 'en', '#text': 'Electrical energy' }],
              },
            },
          },
        },
      },
    }),
    'MJ',
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({
      flowDataSet: {
        flowProperties: {
          flowProperty: { unit: 'kWh' },
        },
      },
    }),
    'kWh',
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({
      flowDataSet: {
        flowProperties: {
          flowProperty: {
            referenceToFlowPropertyDataSet: {
              'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Net calorific value' }],
            },
          },
        },
      },
    }),
    'MJ',
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({
      flowDataSet: {
        flowProperties: {
          flowProperty: { meanValue: '1' },
        },
      },
    }),
    null,
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({ flowDataSet: { flowProperties: {} } }),
    null,
  );
  assert.equal(
    __testInternals.inferSpecificUnitFromFlowPayload({
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            classificationInformation: {
              'common:classification': 'not-a-classification-object',
            },
          },
        },
      },
    }),
    null,
  );
  assert.deepEqual(
    Array.from(
      __testInternals.buildFlowUnitIndex(
        [
          {
            index: 0,
            id: null,
            version: null,
            kind: 'flow',
            row: {},
            payload: {},
          },
          {
            index: 1,
            id: 'proc-ignored',
            version: null,
            kind: 'process',
            row: {},
            payload: {},
          },
        ],
        'unit',
      ),
    ),
    [],
  );

  assert.deepEqual(
    __testInternals.cloneRowWithPayload({
      index: 0,
      id: null,
      version: null,
      kind: 'process',
      row: { jsonOrdered: { processDataSet: { id: 'jsonOrdered' } } },
      payload: {},
    })?.payload,
    { processDataSet: { id: 'jsonOrdered' } },
  );
  assert.deepEqual(
    __testInternals.cloneRowWithPayload({
      index: 0,
      id: null,
      version: null,
      kind: 'process',
      row: { json: { processDataSet: { id: 'json' } } },
      payload: {},
    })?.payload,
    { processDataSet: { id: 'json' } },
  );
  assert.deepEqual(
    __testInternals.cloneRowWithPayload({
      index: 0,
      id: null,
      version: null,
      kind: 'process',
      row: { payload: { processDataSet: { id: 'payload' } } },
      payload: {},
    })?.payload,
    { processDataSet: { id: 'payload' } },
  );
  assert.deepEqual(
    __testInternals.cloneRowWithPayload({
      index: 0,
      id: null,
      version: null,
      kind: 'process',
      row: { process: { processDataSet: { id: 'process' } } },
      payload: {},
    })?.payload,
    { processDataSet: { id: 'process' } },
  );
  assert.deepEqual(
    __testInternals.cloneRowWithPayload({
      index: 0,
      id: null,
      version: null,
      kind: 'process',
      row: { processDataSet: { id: 'root' } },
      payload: {},
    })?.payload,
    { processDataSet: { id: 'root' } },
  );

  const completed = __testInternals.completeProcessRow(
    {
      index: 0,
      id: 'proc-evidence',
      version: '01.00.000',
      kind: 'process',
      row: {
        required_fields: {
          annualSupplyOrProductionVolume: { amount: '13', unit: 'kg' },
        },
        json_ordered: {
          processDataSet: {
            processInformation: {},
            exchanges: {},
          },
        },
      },
      payload: {},
    },
    { defaultUnit: 'unit' },
  );
  assert.equal(completed.report.status, 'completed');
  assert.equal(
    (
      completed.row.json_ordered as {
        processDataSet: {
          modellingAndValidation: {
            dataSourcesTreatmentAndRepresentativeness: {
              annualSupplyOrProductionVolume: Array<{ '#text': string }>;
            };
          };
        };
      }
    ).processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness
      .annualSupplyOrProductionVolume[0]?.['#text'],
    '13 kg/year',
  );

  const unwrappedCompleted = __testInternals.completeProcessRow(
    {
      index: 0,
      id: 'proc-unwrapped',
      version: '01.00.000',
      kind: 'process',
      row: {
        annualSupplyOrProductionVolume: { amount: '14', unit: 'kg' },
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {},
        },
      },
      payload: {},
    },
    { defaultUnit: 'unit' },
  );
  assert.equal(
    (
      unwrappedCompleted.row as {
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: Array<{ '#text': string }>;
          };
        };
      }
    ).modellingAndValidation.dataSourcesTreatmentAndRepresentativeness
      .annualSupplyOrProductionVolume[0]?.['#text'],
    '14 kg/year',
  );

  const unknownWithoutReferenceExchange = __testInternals.completeProcessRow(
    {
      index: 0,
      id: 'proc-no-exchange',
      version: '01.00.000',
      kind: 'process',
      row: {
        processDataSet: {
          modellingAndValidation: {
            dataSourcesTreatmentAndRepresentativeness: {},
          },
        },
      },
      payload: {},
    },
    { defaultUnit: 'unit' },
  );
  assert.equal(unknownWithoutReferenceExchange.report.status, 'blocked');
  assert.equal(
    unknownWithoutReferenceExchange.report.completions.at(-1)?.source,
    'unknown_preserved',
  );
});
