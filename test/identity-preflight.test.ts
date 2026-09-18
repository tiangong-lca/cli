import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runFlowIdentityPreflight,
  runProcessIdentityPreflight,
  __testInternals,
} from '../src/lib/identity-preflight.js';
import type { SafeParseSchema } from '../src/lib/tidas-sdk-validation.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const now = new Date('2026-05-22T00:00:00.000Z');

function failingSchema(): SafeParseSchema {
  return {
    safeParse: () => ({
      success: false as const,
      error: {
        issues: [
          {
            path: ['processDataSet', 'processInformation'],
            message: 'Missing process information',
            code: 'custom',
          },
        ],
      },
    }),
  };
}

function passingSchema(): SafeParseSchema {
  return {
    safeParse: () => ({
      success: true as const,
      data: {},
    }),
  };
}

function failingSchemaWithoutIssueDetails(): SafeParseSchema {
  return {
    safeParse: () => ({
      success: false as const,
      error: {
        issues: [
          {
            path: ['flowDataSet'],
          },
        ],
      },
    }),
  } as SafeParseSchema;
}

test('process identity preflight allows a new loose target when no candidates match', async () => {
  const report = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        name_en: 'market for hydrogen, gaseous',
        reference_flow_id: 'flow-h2',
        operation: 'produce',
        geography: 'CN',
      },
      candidates: [],
    },
    now,
  });

  assert.equal(report.generated_at_utc, '2026-05-22T00:00:00.000Z');
  assert.equal(report.kind, 'process');
  assert.equal(report.status, 'passed');
  assert.equal(report.decision, 'create_new');
  assert.equal(report.next_action, 'materialize_new_payload');
  assert.equal(report.target.schema_validation.status, 'not_applicable');
  assert.equal(report.blockers.length, 0);
});

test('identity preflight validates required object input shapes', async () => {
  await assert.rejects(
    () =>
      runProcessIdentityPreflight({
        inputPath: '   ',
        rawInput: { target: {} },
      }),
    /Missing required --input value/u,
  );

  await assert.rejects(
    () =>
      runProcessIdentityPreflight({
        inputPath: '/tmp/process-preflight.json',
        rawInput: 1,
      }),
    /identity preflight input must be a JSON object/u,
  );

  await assert.rejects(
    () =>
      runProcessIdentityPreflight({
        inputPath: '/tmp/process-preflight.json',
        rawInput: {
          target: 'not-object',
        },
      }),
    /identity preflight target must be a JSON object/u,
  );

  await assert.rejects(
    () =>
      runProcessIdentityPreflight({
        inputPath: '/tmp/process-preflight.json',
        rawInput: {
          target: {},
          candidates: ['not-object'],
        },
      }),
    /candidates\[0\] must be a JSON object/u,
  );
});

test('process identity preflight blocks duplicate semantic and exchange fingerprints', async () => {
  const rawInput = {
    target: {
      process_id: 'new-process',
      name_en: 'market for electricity, medium voltage',
      reference_flow_id: 'flow-electricity',
      operation: 'produce',
      geography: 'CN',
      exchanges: [
        {
          flow_id: 'flow-coal-electricity',
          direction: 'Input',
          mean_amount: '1.0',
        },
      ],
    },
    candidates: [
      {
        process_id: 'existing-process',
        name_en: 'market for electricity, medium voltage',
        reference_flow_id: 'flow-electricity',
        operation: 'produce',
        geography: 'CN',
        exchanges: [
          {
            flow_id: 'flow-coal-electricity',
            direction: 'Input',
            mean_amount: '1.0',
          },
        ],
      },
    ],
  };

  const report = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput,
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.equal(report.confidence, 'high');
  assert.equal(report.next_action, 'stop_duplicate');
  assert.equal(report.candidates[0]?.decision_hint, 'block_duplicate');
  assert.deepEqual(report.candidates[0]?.match_reasons, [
    'same_identity_key',
    'same_exchange_signature',
    'overlapping_name',
    'overlapping_identity_field',
  ]);
  assert.equal(report.blockers[0]?.code, 'process_duplicate_candidate');
});

test('process identity preflight maps same-id candidates to reuse and update decisions', async () => {
  const draft = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        id: 'process-a',
        version: '01.00.000',
        name_en: ['Process A', { '#text': 'Process A alias', nested: 12 }],
        state_code: '100',
        exchanges: [{ exchangeDirection: 'Input' }],
      },
      candidates: {
        rows: [
          {
            id: 'process-a',
            version: '01.00.000',
            state_code: 0,
            name_en: 'Process A',
            exchanges: [{ flow_id: 'flow-a' }],
          },
        ],
      },
    },
    now,
  });

  assert.equal(draft.status, 'passed');
  assert.equal(draft.decision, 'update_same_row');
  assert.equal(draft.next_action, 'repair_existing_draft');
  assert.equal(draft.target.exchange_signature.length, 0);

  const versionBump = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        id: 'process-a',
        version: '02.00.000',
      },
      candidates: [
        {
          id: 'process-a',
          version: '01.00.000',
          stateCode: '100',
        },
      ],
    },
    now,
  });

  assert.equal(versionBump.decision, 'version_bump');
  assert.equal(versionBump.next_action, 'prepare_version_update');

  const reuse = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        id: 'process-a',
        version: '01.00.000',
      },
      candidates: [
        {
          id: 'process-a',
          version: '01.00.000',
          state_code: 100,
        },
      ],
    },
    now,
  });

  assert.equal(reuse.decision, 'reuse');
  assert.equal(reuse.next_action, 'reuse_existing');
});

test('process identity preflight queues manual review for weaker process similarities', async () => {
  const exchangeOnly = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        name_en: 'target process',
        exchanges: [{ flow_id: 'flow-x' }],
      },
      candidates: [
        {
          name_en: 'candidate process',
          exchanges: [{ flow_id: 'flow-x' }],
        },
      ],
    },
    now,
  });

  assert.equal(exchangeOnly.status, 'needs_review');
  assert.equal(exchangeOnly.decision, 'manual_review');
  assert.equal(exchangeOnly.confidence, 'low');
  assert.equal(exchangeOnly.next_action, 'queue_manual_review');
  assert.equal(exchangeOnly.findings[0]?.code, 'process_manual_review_candidate');

  const nameOnly = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        name_en: 'shared process name',
        geography: 'CN',
      },
      candidates: [
        {
          name_en: 'shared process name',
          geography: 'US',
        },
      ],
    },
    now,
  });

  assert.equal(nameOnly.status, 'needs_review');
  assert.equal(nameOnly.decision, 'manual_review');
  assert.deepEqual(nameOnly.candidates[0]?.match_reasons, ['overlapping_name']);
});

test('identity profiles prefer canonical TIDAS fields over nested payload noise', () => {
  const processProfile = __testInternals.processProfile({
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          name: {
            baseName: { '#text': 'Transport, freight, lorry' },
            treatmentStandardsRoutes: { '#text': 'Not specified' },
          },
          common: { ignored: 'not a real TIDAS key' },
        },
        quantitativeReference: {
          referenceToReferenceFlow: '1',
        },
        geography: {
          locationOfOperationSupplyOrProduction: {
            '@location': 'CH',
            descriptionOfRestrictions: {
              '#text': 'Only the location code should enter the identity geography field',
            },
          },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: {
            '#text': 'Fuel cell electric powertrain',
          },
        },
      },
      exchanges: {
        exchange: [
          {
            '@dataSetInternalID': '1',
            exchangeDirection: 'Output',
            meanAmount: '1',
            referenceToFlowDataSet: {
              '@refObjectId': 'flow-reference',
              '@version': '00.00.001',
              common: { shortDescription: { '#text': 'not a real TIDAS key' } },
              'common:shortDescription': { '#text': 'Reference product flow' },
            },
          },
          {
            '@dataSetInternalID': '2',
            exchangeDirection: 'Input',
            meanAmount: '2',
            referenceToFlowDataSet: {
              '@refObjectId': 'flow-input',
              'common:shortDescription': { '#text': 'Nested input should not be a process name' },
            },
          },
        ],
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:referenceToDataSetFormat': {
            'common:shortDescription': { '#text': 'ILCD format' },
          },
        },
      },
    },
  });

  assert.deepEqual(processProfile.names, ['Transport, freight, lorry']);
  assert.equal(processProfile.fields.geography, 'CH');
  assert.deepEqual(processProfile.fields.reference_flow_ids, ['flow-reference']);
  assert.deepEqual(processProfile.fields.reference_flow_names, ['Reference product flow']);
  assert.ok(processProfile.exchange_signature.includes('flow reference:output:1'));
  assert.equal(processProfile.names.includes('Nested input should not be a process name'), false);
  assert.equal(processProfile.names.includes('ILCD format'), false);

  const flowProfile = __testInternals.flowProfile({
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          name: {
            baseName: { '#text': 'Carbon dioxide liquid, at plant' },
            mixAndLocationTypes: { '#text': 'Not specified' },
          },
          classificationInformation: {
            'common:classification': {
              'common:class': {
                '@classId': '9',
                '#text': 'Emissions to air',
              },
            },
          },
        },
      },
      modellingAndValidation: {
        LCIMethod: {
          typeOfDataSet: 'Product flow',
        },
      },
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            'common:shortDescription': { '#text': 'Mass' },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:referenceToOwnershipOfDataSet': {
            'common:shortDescription': { '#text': 'Nested owner should not be a flow name' },
          },
        },
      },
    },
  });

  assert.deepEqual(flowProfile.names, ['Carbon dioxide liquid, at plant']);
  assert.equal(flowProfile.fields.type_of_dataset, 'Product flow');
  assert.equal(flowProfile.fields.flow_property, 'Mass');
  assert.equal(flowProfile.names.includes('Nested owner should not be a flow name'), false);
});

test('identity preflight reports candidates by local evidence score', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Product flow',
        name_en: 'Carbon dioxide liquid, at plant',
        flow_property: 'Mass',
      },
      candidates: [
        {
          id: 'less-relevant',
          type_of_dataset: 'Product flow',
          name_en: 'Carbon dioxide, in chemical industry',
          flow_property: 'Volume',
        },
        {
          id: 'missing-liquid',
          type_of_dataset: 'Product flow',
          name_en: ['Carbon dioxide', 'Production mix, at plant'],
          flow_property: 'Mass',
        },
        {
          id: 'more-relevant',
          type_of_dataset: 'Product flow',
          name_en: [
            'Carbon dioxide, liquid',
            '液态二氧化碳',
            'at plant',
            '厂内',
            'CN, production mix',
          ],
          flow_property: 'Mass',
        },
      ],
    },
    now,
  });

  assert.equal(report.decision, 'manual_review');
  assert.equal(report.candidates[0]?.id, 'more-relevant');
  assert.equal(report.candidates[0]?.index, 2);
  assert.ok(report.candidates[0]?.match_reasons.includes('similar_name_phrase'));
  assert.equal(report.candidates[1]?.id, 'missing-liquid');
  assert.equal(report.candidates[1]?.index, 1);
});

test('process identity preflight blocks exact exchange fingerprints with local candidate scans', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'identity-preflight-local-scan-'));
  const inputPath = path.join(workDir, 'process-preflight.json');
  const candidateDir = path.join(workDir, 'candidates');
  const nestedDir = path.join(candidateDir, 'nested');
  const candidateJsonl = path.join(candidateDir, 'existing.jsonl');
  const hiddenJson = path.join(candidateDir, '.hidden.json');
  const candidateJson = path.join(nestedDir, 'more.json');
  try {
    writeFileSync(
      inputPath,
      JSON.stringify({
        target: {
          name_en: 'market for electricity, medium voltage, renewable adjustment',
          reference_flow_id: 'flow-electricity',
          geography: 'CN',
          exchanges: [{ flow_id: 'flow-wind', direction: 'Input', mean_amount: '1.0' }],
        },
      }),
      'utf8',
    );
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      candidateJsonl,
      `${JSON.stringify({
        process_id: 'existing-process',
        name_en: 'electricity supply candidate with different wording',
        reference_flow_id: 'flow-electricity',
        geography: 'CN',
        exchanges: [{ flow_id: 'flow-wind', direction: 'Input', mean_amount: '1.0' }],
      })}\n`,
      'utf8',
    );
    writeFileSync(
      candidateJson,
      JSON.stringify({
        rows: [{ process_id: 'unrelated', name_en: 'unrelated process' }],
      }),
      'utf8',
    );
    writeFileSync(
      hiddenJson,
      JSON.stringify({
        rows: [{ process_id: 'hidden', name_en: 'hidden process' }],
      }),
      'utf8',
    );

    const report = await runProcessIdentityPreflight({
      inputPath,
      candidateInputPaths: [candidateDir],
      now,
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.decision, 'block_duplicate');
    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidate_sources[0]?.kind, 'directory');
    assert.equal(report.candidate_sources[0]?.row_count, 2);
    assert.ok(report.candidate_sources[0]?.scanned_files.includes(candidateJsonl));
    assert.ok(report.candidate_sources[0]?.scanned_files.includes(candidateJson));
    assert.equal(report.candidate_sources[0]?.scanned_files.includes(hiddenJson), false);
    assert.ok(report.candidates[0]?.match_reasons.includes('same_exchange_fingerprint'));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('process identity preflight can block duplicates from remote hybrid search', async () => {
  const observed: {
    url: string | null;
    headers: Record<string, string> | null;
    body: Record<string, unknown> | null;
  } = {
    url: null,
    headers: null,
    body: null,
  };

  const report = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        name_en: 'market for electricity, medium voltage',
        reference_flow_id: 'flow-electricity',
        geography: 'CN',
        exchanges: [{ flow_id: 'flow-grid', direction: 'Input', mean_amount: '1.0' }],
      },
      remote_candidate_search: {
        enabled: true,
        query: 'electricity medium voltage',
        data_source: 'tg',
        limit: 1,
        match_threshold: 0.1,
        lexical_weight: 0.8,
        semantic_weight: 0.2,
        rrf_k: 30,
      },
    },
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
      TIANGONG_LCA_REGION: 'cn-east-1',
    }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) {
        return makeSupabaseAuthResponse();
      }

      observed.url = url;
      observed.headers = init?.headers as Record<string, string>;
      observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === 'content-type' ? 'application/json' : null;
          },
        },
        async text(): Promise<string> {
          return JSON.stringify({
            data: [
              {
                id: 'existing-process',
                version: '01.00.000',
                state_code: 100,
                name_en: 'market for electricity, medium voltage',
                reference_flow_id: 'flow-electricity',
                geography: 'CN',
                exchanges: [{ flow_id: 'flow-grid', direction: 'Input', mean_amount: '1.0' }],
              },
            ],
          });
        },
      };
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.equal(report.candidate_sources[0]?.kind, 'remote_search');
  assert.equal(report.candidate_sources[0]?.endpoint, 'process_hybrid_search');
  assert.equal(report.candidate_sources[0]?.query, 'electricity medium voltage');
  assert.equal(report.candidate_sources[0]?.row_count, 1);
  assert.deepEqual(report.candidate_sources[0]?.options, {
    limit: 1,
    match_count: 1,
    page_size: 1,
    data_source: 'tg',
    match_threshold: 0.1,
    lexical_weight: 0.8,
    semantic_weight: 0.2,
    rrf_k: 30,
  });
  assert.equal(observed.url, 'https://example.com/functions/v1/process_hybrid_search');
  assert.equal(observed.headers?.Authorization, 'Bearer access-token');
  assert.equal(observed.headers?.['x-region'], 'cn-east-1');
  assert.equal('limit' in (observed.body ?? {}), false);
  assert.equal(observed.body?.match_count, 1);
  assert.equal(observed.body?.page_size, 1);
  assert.equal(observed.body?.match_threshold, 0.1);
  assert.equal(observed.body?.lexical_weight, 0.8);
  assert.equal(observed.body?.semantic_weight, 0.2);
  assert.equal(observed.body?.rrf_k, 30);
});

test('flow identity preflight sends type filters to remote hybrid search', async () => {
  const observed: {
    url: string | null;
    body: Record<string, unknown> | null;
  } = {
    url: null,
    body: null,
  };

  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        name_en: 'electricity, medium voltage',
        type_of_dataset: ['Product flow'],
      },
    },
    remoteCandidateSearch: true,
    remoteQuery: 'electricity flow',
    remoteLimit: 2,
    remoteDataSource: 'co',
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    }),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) {
        return makeSupabaseAuthResponse();
      }

      observed.url = url;
      observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === 'content-type' ? 'application/json' : null;
          },
        },
        async text(): Promise<string> {
          return JSON.stringify({ rows: [] });
        },
      };
    },
    now,
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.candidate_sources[0]?.kind, 'remote_search');
  assert.equal(report.candidate_sources[0]?.endpoint, 'flow_hybrid_search');
  assert.equal(observed.url, 'https://example.com/functions/v1/flow_hybrid_search');
  assert.deepEqual(observed.body?.filter, { flowType: 'Product flow' });
  assert.equal('limit' in (observed.body ?? {}), false);
  assert.equal(observed.body?.match_count, 2);
  assert.equal(observed.body?.page_size, 2);
  assert.equal(observed.body?.data_source, 'co');
});

test('flow identity preflight profiles elementary flow categorization before default classification', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              name: {
                baseName: { '#text': 'Transformation, to industrial area' },
              },
              classificationInformation: {
                'common:classification': {
                  'common:class': [
                    { '@level': '0', '@classId': 'Emissions', '#text': 'Emissions' },
                    {
                      '@level': '1',
                      '@classId': 'Emissions to air',
                      '#text': 'Emissions to air',
                    },
                  ],
                },
                'common:elementaryFlowCategorization': {
                  'common:category': [
                    { '@level': '0', '#text': 'resources' },
                    { '@level': '1', '#text': 'land' },
                  ],
                },
              },
            },
          },
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Elementary flow',
            },
          },
          flowProperties: {
            flowProperty: {
              referenceToFlowPropertyDataSet: {
                'common:shortDescription': 'Area',
              },
            },
          },
        },
      },
    },
    schemas: { flow: passingSchema() },
    now,
  });

  assert.deepEqual(report.target.fields.categories, ['resources', 'land']);
  assert.doesNotMatch(report.target.identity_key, /emissions to air/u);
  assert.match(report.target.identity_key, /resources\\|land/u);
});

test('identity preflight applies request profile hints to local target scoring only', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              name: {
                baseName: { '#text': 'Transformation, to industrial area' },
              },
              classificationInformation: {
                'common:elementaryFlowCategorization': {
                  'common:category': [
                    { '@level': '0', '#text': 'Emissions' },
                    { '@level': '1', '#text': 'Emissions to air' },
                  ],
                },
              },
            },
          },
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Elementary flow',
            },
          },
          flowProperties: {
            flowProperty: {
              referenceToFlowPropertyDataSet: {
                'common:shortDescription': 'Area',
              },
            },
          },
        },
      },
      remote_candidate_search: {
        enabled: false,
        profile_hints: {
          categories: ['resources', 'land'],
        },
      },
    },
    schemas: { flow: passingSchema() },
    now,
  });

  assert.deepEqual(report.target.fields.categories, ['resources', 'land']);
  assert.doesNotMatch(report.target.identity_key, /emissions to air/u);
  assert.match(report.target.identity_key, /resources\\|land/u);
  assert.equal(report.candidate_sources.length, 0);
});

test('identity preflight requires a remote query when the target has no identity text', async () => {
  await assert.rejects(
    () =>
      runProcessIdentityPreflight({
        inputPath: '/tmp/process-preflight.json',
        rawInput: {
          target: {},
          remote_candidate_search: true,
        },
        now,
      }),
    /Remote identity candidate search requires a query/u,
  );
});

test('identity preflight can use process env and global fetch for remote candidates', async () => {
  const envKeys = [
    'TIANGONG_LCA_API_BASE_URL',
    'TIANGONG_LCA_ACCESS_TOKEN',
    'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
    'TIANGONG_LCA_DISABLE_SESSION_CACHE',
    'TIANGONG_LCA_REGION',
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const observed: {
    body: Record<string, unknown> | null;
  } = {
    body: null,
  };

  try {
    const testEnv = buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://env.example.com/functions/v1',
      TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      TIANGONG_LCA_REGION: '',
    });
    for (const key of envKeys) {
      const value = testEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) {
        return makeSupabaseAuthResponse();
      }

      observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name: string): string | null {
            return name.toLowerCase() === 'content-type' ? 'application/json' : null;
          },
        },
        async text(): Promise<string> {
          return JSON.stringify({
            data: [
              { id: 'candidate-a', name_en: 'candidate a' },
              { id: 'candidate-b', name_en: 'candidate b' },
            ],
          });
        },
      };
    }) as typeof fetch;

    const report = await runProcessIdentityPreflight({
      inputPath: '/tmp/process-preflight.json',
      rawInput: {
        target: {
          name_en: 'market for heat',
        },
        remote_candidate_search: true,
      },
      now,
    });

    assert.equal(report.candidate_sources[0]?.row_count, 2);
    assert.equal(observed.body?.query, 'process name: market for heat');
    assert.equal('limit' in (observed.body ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('identity preflight reads file candidate sources and rejects invalid source paths', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'identity-preflight-candidate-file-'));
  const candidatePath = path.join(workDir, 'candidates.json');
  try {
    writeFileSync(
      candidatePath,
      JSON.stringify({
        rows: [{ name_en: 'same flow', type_of_dataset: 'Product flow' }],
      }),
      'utf8',
    );

    const report = await runFlowIdentityPreflight({
      inputPath: '/tmp/flow-preflight.json',
      rawInput: {
        flow: { name_en: 'target flow' },
      },
      candidateInputPaths: [candidatePath],
      now,
    });

    assert.equal(report.candidate_sources[0]?.kind, 'file');
    assert.equal(report.candidate_sources[0]?.row_count, 1);
    assert.deepEqual(report.candidate_sources[0]?.scanned_files, [candidatePath]);

    const requestPathReport = await runFlowIdentityPreflight({
      inputPath: '/tmp/flow-preflight.json',
      rawInput: {
        flow: { name_en: 'target flow' },
        candidate_inputs: `${candidatePath}, , ${candidatePath}`,
      },
      now,
    });

    assert.equal(requestPathReport.candidate_sources.length, 2);
    assert.equal(requestPathReport.candidate_sources[0]?.path, candidatePath);

    await assert.rejects(
      () =>
        runFlowIdentityPreflight({
          inputPath: '/tmp/flow-preflight.json',
          rawInput: { flow: {} },
          candidateInputPaths: [path.join(workDir, 'missing.jsonl')],
          now,
        }),
      /Candidate input not found/u,
    );

    const unsupportedPath = path.join(workDir, 'unsupported.txt');
    writeFileSync(unsupportedPath, 'not a candidate payload', 'utf8');
    assert.throws(
      () => __testInternals.readCandidateSource(unsupportedPath),
      /Candidate input must be a JSON\/JSONL file or directory/u,
    );
    assert.throws(
      () =>
        __testInternals.collectCandidateFilesFromStats(unsupportedPath, {
          isFile: () => false,
          isDirectory: () => false,
        }),
      /Candidate input must be a JSON\/JSONL file or directory/u,
    );

    await assert.rejects(
      () =>
        runFlowIdentityPreflight({
          inputPath: '/tmp/flow-preflight.json',
          rawInput: {
            flow: {},
            candidate_inputs: [1],
          },
          now,
        }),
      /candidate_inputs\[0\] must be a string path/u,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('flow identity preflight blocks equivalent flow identities and writes artifacts', async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'identity-preflight-'));
  try {
    const report = await runFlowIdentityPreflight({
      inputPath: '/tmp/flow-preflight.json',
      outDir,
      rawInput: {
        target: {
          flow_id: 'new-flow',
          type_of_dataset: 'Product flow',
          name_en: 'electricity, medium voltage',
          reference_unit: 'kWh',
          flow_property: 'Energy',
        },
        candidates: [
          {
            flow_id: 'existing-flow',
            type_of_dataset: 'Product flow',
            name_en: 'electricity, medium voltage',
            reference_unit: 'kWh',
            flow_property: 'Energy',
          },
        ],
      },
      now,
    });

    assert.equal(report.kind, 'flow');
    assert.equal(report.status, 'blocked');
    assert.equal(report.decision, 'block_duplicate');
    assert.deepEqual(report.target.names, ['electricity, medium voltage']);
    assert.equal(report.target.fields.flow_property, 'Energy');
    assert.deepEqual(report.candidates[0]?.names, ['electricity, medium voltage']);
    assert.equal(report.candidates[0]?.fields.flow_property, 'Energy');
    assert.equal(
      report.files.identity_decision,
      path.join(outDir, 'outputs', 'identity-decision.json'),
    );
    assert.equal(
      report.files.candidates,
      path.join(outDir, 'outputs', 'identity-candidates.jsonl'),
    );
    assert.equal(
      report.files.candidate_sources,
      path.join(outDir, 'outputs', 'identity-candidate-sources.json'),
    );
    assert.equal(existsSync(report.files.identity_decision as string), true);
    assert.equal(existsSync(report.files.candidates as string), true);
    assert.equal(existsSync(report.files.candidate_sources as string), true);

    const artifact = JSON.parse(readFileSync(report.files.identity_decision as string, 'utf8')) as {
      files: { identity_decision: string };
      decision: string;
    };
    assert.equal(artifact.files.identity_decision, report.files.identity_decision);
    assert.equal(artifact.decision, 'block_duplicate');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('flow identity preflight blocks alias-equivalent flow core fields', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Product flow',
        name_en: ['electricity, high voltage', 'power, high voltage'],
        reference_unit: 'kWh',
        flow_property: 'Energy',
        category: 'energy carrier',
      },
      candidates: [
        {
          type_of_dataset: 'Product flow',
          name_en: 'power, high voltage',
          reference_unit: 'kWh',
          flow_property: 'Energy',
          category: 'energy carrier',
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));
});

test('flow identity preflight blocks elementary flows with CAS spelling and exact compartment matches', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Sulfur hexafluoride',
        cas: '002551-62-4',
        flow_property: 'Mass',
        category: ['Emissions', 'Emissions to air', 'Emissions to air, unspecified'],
      },
      candidates: [
        {
          flow_id: 'indoor-sf6',
          type_of_dataset: 'Elementary flow',
          name_en: 'sulphur hexafluoride',
          cas: '2551-62-4',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, indoor'],
        },
        {
          flow_id: 'unspecified-sf6',
          type_of_dataset: 'Elementary flow',
          name_en: 'sulphur hexafluoride',
          cas: '2551-62-4',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, unspecified'],
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.equal(report.candidates[0]?.id, 'unspecified-sf6');
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
  assert.ok(report.candidates[0]?.match_reasons.includes('same_cas'));
  assert.ok(report.candidates[0]?.match_reasons.includes('same_category_path'));
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));
  assert.equal(
    report.candidates.find((candidate) => candidate.id === 'indoor-sf6')?.decision_hint,
    'manual_review',
  );
});

test('flow identity preflight ranks BAFU elementary air population compartments', async () => {
  const lowPopulation = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Mercury',
        cas: '7439-97-6',
        flow_property: 'Mass',
        category: ['emissions to air', 'low. pop.'],
      },
      candidates: [
        {
          flow_id: 'mercury-soil',
          type_of_dataset: 'Elementary flow',
          name_en: 'mercury',
          cas: '7439-97-6',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to soil', 'Emissions to soil, unspecified'],
        },
        {
          flow_id: 'mercury-indoor-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'mercury',
          cas: '7439-97-6',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, indoor'],
        },
        {
          flow_id: 'mercury-non-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'mercury',
          cas: '7439-97-6',
          flow_property: 'Mass',
          category: [
            'Emissions',
            'Emissions to air',
            'Emissions to non-urban air or from high stacks',
          ],
        },
      ],
    },
    now,
  });

  assert.equal(lowPopulation.status, 'blocked');
  assert.equal(lowPopulation.decision, 'block_duplicate');
  assert.equal(lowPopulation.candidates[0]?.id, 'mercury-non-urban-air');
  assert.ok(
    lowPopulation.candidates[0]?.match_reasons.includes('equivalent_elementary_compartment'),
  );
  assert.ok(lowPopulation.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));

  const highPopulation = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Mercury',
        cas: '7439-97-6',
        flow_property: 'Mass',
        category: ['emissions to air', 'high. pop.'],
      },
      candidates: [
        {
          flow_id: 'mercury-non-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'mercury',
          cas: '7439-97-6',
          flow_property: 'Mass',
          category: [
            'Emissions',
            'Emissions to air',
            'Emissions to non-urban air or from high stacks',
          ],
        },
        {
          flow_id: 'mercury-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'mercury',
          cas: '7439-97-6',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
      ],
    },
    now,
  });

  assert.equal(highPopulation.status, 'blocked');
  assert.equal(highPopulation.decision, 'block_duplicate');
  assert.equal(highPopulation.candidates[0]?.id, 'mercury-urban-air');
  assert.ok(
    highPopulation.candidates[0]?.match_reasons.includes('equivalent_elementary_compartment'),
  );
});

test('flow identity preflight downranks elementary compartment matches with conflicting names', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Ethene',
        flow_property: 'Mass',
        category: ['emissions to air', 'high. pop.'],
      },
      candidates: [
        {
          flow_id: 'wrong-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'cypermethrin',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
        {
          flow_id: 'ethene-indoor-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'Ethene',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, indoor'],
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'needs_review');
  assert.equal(report.decision, 'manual_review');
  assert.equal(report.candidates[0]?.id, 'ethene-indoor-air');
  assert.ok(
    report.candidates
      .find((candidate) => candidate.id === 'wrong-urban-air')
      ?.match_reasons.includes('conflicting_flow_name'),
  );
});

test('flow identity preflight blocks ethene elementary aliases in matching air compartments', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Ethene',
        flow_property: 'Mass',
        category: ['emissions to air', 'high. pop.'],
      },
      candidates: [
        {
          flow_id: 'wrong-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'cypermethrin',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
        {
          flow_id: 'ethylene-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'ethylene',
          cas: '74-85-1',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.equal(report.candidates[0]?.id, 'ethylene-urban-air');
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));
});

test('flow identity preflight handles PAH and waste heat elementary aliases with matching compartments', async () => {
  const pah = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'PAH, polycyclic aromatic hydrocarbons',
        flow_property: 'Mass',
        category: ['emissions to air', 'high. pop.'],
      },
      candidates: [
        {
          flow_id: 'pah-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'polycyclic aromatic hydrocarbons',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
      ],
    },
    now,
  });

  assert.equal(pah.status, 'blocked');
  assert.equal(pah.decision, 'block_duplicate');
  assert.ok(pah.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
  assert.ok(pah.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));

  const wasteHeat = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Heat, waste',
        category: ['emissions to air', 'high. pop.'],
      },
      candidates: [
        {
          flow_id: 'waste-heat-urban-air',
          type_of_dataset: 'Elementary flow',
          name_en: 'waste heat',
          category: ['Emissions', 'Emissions to air', 'Emissions to urban air close to ground'],
        },
      ],
    },
    now,
  });

  assert.equal(wasteHeat.status, 'needs_review');
  assert.equal(wasteHeat.decision, 'manual_review');
  assert.ok(wasteHeat.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
  assert.equal(
    wasteHeat.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'),
    false,
  );
});

test('flow identity preflight matches transformation elementary flow name variants', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Transformation, to industrial area',
        flow_property: 'Area',
        category: ['resources', 'land'],
      },
      candidates: [
        {
          flow_id: 'land-transformation-to-industrial',
          type_of_dataset: 'Elementary flow',
          name_en: 'to industrial area',
          flow_property: 'Area',
          category: ['Land use', 'Land transformation'],
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'needs_review');
  assert.equal(report.candidates[0]?.id, 'land-transformation-to-industrial');
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
});

test('flow identity preflight blocks elementary flows with known chemical aliases', async () => {
  const report = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        type_of_dataset: 'Elementary flow',
        name_en: 'Dinitrogen monoxide',
        flow_property: 'Mass',
        category: ['Emissions', 'Emissions to air', 'Emissions to air, unspecified'],
      },
      candidates: [
        {
          flow_id: 'nitrogen-monoxide',
          type_of_dataset: 'Elementary flow',
          name_en: 'nitrogen monoxide',
          cas: '10102-43-9',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, unspecified'],
        },
        {
          flow_id: 'nitrous-oxide',
          type_of_dataset: 'Elementary flow',
          name_en: 'nitrous oxide',
          cas: '10024-97-2',
          flow_property: 'Mass',
          category: ['Emissions', 'Emissions to air', 'Emissions to air, unspecified'],
        },
      ],
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'block_duplicate');
  assert.equal(report.candidates[0]?.id, 'nitrous-oxide');
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_name'));
  assert.ok(report.candidates[0]?.match_reasons.includes('same_category_path'));
  assert.ok(report.candidates[0]?.match_reasons.includes('equivalent_flow_core_fields'));
  assert.equal(
    report.candidates.find((candidate) => candidate.id === 'nitrogen-monoxide')?.decision_hint,
    'manual_review',
  );
});

test('flow identity preflight accepts sparse file input and numeric text fields', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'identity-preflight-input-'));
  const inputPath = path.join(workDir, 'flow-preflight.json');
  try {
    writeFileSync(
      inputPath,
      JSON.stringify({
        flow: {
          name_en: 42,
        },
        candidates: [
          {
            name_en: '   ',
            state_code: 'not-a-number',
          },
        ],
      }),
      'utf8',
    );

    const report = await runFlowIdentityPreflight({
      inputPath,
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.decision, 'create_new');
    assert.equal(report.input_path, inputPath);
    assert.equal(report.out_dir, null);
    assert.match(report.generated_at_utc, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(report.target.identity_key, '42');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('identity preflight routes schema failures to blocker findings', async () => {
  const report = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        processDataSet: {},
      },
    },
    schemas: {
      process: failingSchema(),
    },
    now,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.decision, 'manual_review');
  assert.equal(report.next_action, 'queue_manual_review');
  assert.equal(report.target.schema_validation.status, 'failed');
  assert.equal(
    report.target.schema_validation.issues[0]?.path,
    'processDataSet.processInformation',
  );
  assert.equal(report.blockers[0]?.code, 'process_schema_invalid');
});

test('identity preflight handles schema success, mismatches, and default issue fallbacks', async () => {
  const passed = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        processDataSet: {},
      },
    },
    schemas: {
      process: passingSchema(),
    },
    now,
  });

  assert.equal(passed.status, 'passed');
  assert.equal(passed.target.schema_validation.status, 'passed');
  assert.equal(passed.target.schema_validation.validator, 'injected');

  const mismatch = await runProcessIdentityPreflight({
    inputPath: '/tmp/process-preflight.json',
    rawInput: {
      target: {
        flowDataSet: {},
      },
    },
    now,
  });

  assert.equal(mismatch.status, 'blocked');
  assert.equal(mismatch.target.schema_validation.issues[0]?.code, 'dataset_kind_mismatch');

  const defaultIssueFallback = await runFlowIdentityPreflight({
    inputPath: '/tmp/flow-preflight.json',
    rawInput: {
      target: {
        flowDataSet: {},
      },
    },
    schemas: {
      flow: failingSchemaWithoutIssueDetails(),
    },
    now,
  });

  assert.equal(
    defaultIssueFallback.target.schema_validation.issues[0]?.message,
    'Validation failed',
  );
  assert.equal(defaultIssueFallback.target.schema_validation.issues[0]?.code, 'custom');
});

test('identity preflight internals cover schema lookup and decision confidence edges', () => {
  const schema = __testInternals.schemaForKind('process', undefined);
  assert.match(schema.validator, /ProcessSchema/u);
  assert.equal(typeof schema.schema.safeParse, 'function');

  const flowSchema = __testInternals.schemaForKind('flow', undefined);
  assert.match(flowSchema.validator, /FlowSchema/u);
  assert.equal(typeof flowSchema.schema.safeParse, 'function');

  const originalProcessFactory = __testInternals.entityFactoryExports.process;
  try {
    __testInternals.entityFactoryExports.process = 'missingProcessFactory' as never;
    const schemaWithoutFactory = __testInternals.schemaForKind('process', undefined);
    assert.equal(schemaWithoutFactory.createEntity, null);
  } finally {
    __testInternals.entityFactoryExports.process = originalProcessFactory;
  }

  assert.throws(
    () => __testInternals.schemaForKind('missing' as never, undefined),
    /undefined is unavailable/u,
  );

  const duplicate = __testInternals.chooseDecision(
    [
      {
        report: {
          index: 0,
          id: 'candidate-a',
          version: null,
          state_code: null,
          names: [],
          fields: {},
          exchange_signature: [],
          identity_key: 'weak',
          match_score: 50,
          match_reasons: ['same_identity_key'],
          decision_hint: 'block_duplicate',
        },
        findings: [],
      },
    ],
    { status: 'passed', validator: null, issue_count: 0, issues: [] },
    'flow',
  );
  assert.equal(duplicate.decision, 'block_duplicate');
  assert.equal(duplicate.confidence, 'medium');

  const manual = __testInternals.chooseDecision(
    [
      {
        report: {
          index: 0,
          id: null,
          version: null,
          state_code: null,
          names: [],
          fields: {},
          exchange_signature: [],
          identity_key: 'manual',
          match_score: 60,
          match_reasons: ['same_exchange_signature', 'overlapping_name'],
          decision_hint: null,
        },
        findings: [],
      },
    ],
    { status: 'passed', validator: null, issue_count: 0, issues: [] },
    'process',
  );
  assert.equal(manual.decision, 'manual_review');
  assert.equal(manual.confidence, 'medium');

  const weakReuse = __testInternals.chooseDecision(
    [
      {
        report: {
          index: 0,
          id: 'process-a',
          version: null,
          state_code: null,
          names: [],
          fields: {},
          exchange_signature: [],
          identity_key: 'weak',
          match_score: 50,
          match_reasons: ['same_dataset_id'],
          decision_hint: 'reuse',
        },
        findings: [],
      },
    ],
    { status: 'passed', validator: null, issue_count: 0, issues: [] },
    'process',
  );
  assert.equal(weakReuse.decision, 'reuse');
  assert.equal(weakReuse.confidence, 'medium');
});

test('identity preflight internals normalize remote search inputs', () => {
  assert.deepEqual(__testInternals.normalizeRemoteCandidateSearch(undefined), {
    enabled: false,
    query: null,
    filter: null,
    profileHints: null,
    limit: null,
    dataSource: null,
    matchThreshold: null,
    lexicalWeight: null,
    semanticWeight: null,
    rrfK: null,
    pageSize: null,
    pageCurrent: null,
  });
  assert.deepEqual(__testInternals.normalizeRemoteCandidateSearch(true), {
    enabled: true,
    query: null,
    filter: null,
    profileHints: null,
    limit: null,
    dataSource: null,
    matchThreshold: null,
    lexicalWeight: null,
    semanticWeight: null,
    rrfK: null,
    pageSize: null,
    pageCurrent: null,
  });
  assert.deepEqual(
    __testInternals.normalizeRemoteCandidateSearch({
      enabled: false,
      search_query: 'grid electricity',
      filter: { flowType: 'Product flow' },
      limit: '2',
      data_source: 'tg',
      match_threshold: '0.25',
      lexical_weight: '0.8',
      semantic_weight: '0.2',
      rrf_k: '40',
      page_current: '2',
    }),
    {
      enabled: false,
      query: 'grid electricity',
      filter: { flowType: 'Product flow' },
      profileHints: null,
      limit: 2,
      dataSource: 'tg',
      matchThreshold: 0.25,
      lexicalWeight: 0.8,
      semanticWeight: 0.2,
      rrfK: 40,
      pageSize: null,
      pageCurrent: 2,
    },
  );
  assert.equal(__testInternals.normalizeRemoteCandidateSearch({ limit: '' }).limit, null);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse({ data: [{ id: 'a' }] }), [
    { id: 'a' },
  ]);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse({ results: [{ id: 'b' }] }), [
    { id: 'b' },
  ]);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse({ candidates: [{ id: 'c' }] }), [
    { id: 'c' },
  ]);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse([{ id: 'raw' }]), [{ id: 'raw' }]);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse({}), []);
  assert.deepEqual(__testInternals.rowsFromRemoteSearchResponse(null), []);
  assert.equal(
    __testInternals.defaultRemoteQuery({
      id: null,
      version: null,
      state_code: null,
      names: [],
      normalized_names: [],
      fields: { category: 'energy carrier' },
      exchange_signature: [],
      identity_key: 'fallback-key',
    }),
    'energy carrier',
  );
  assert.equal(
    __testInternals.defaultRemoteQuery({
      id: null,
      version: null,
      state_code: null,
      names: [],
      normalized_names: [],
      fields: {},
      exchange_signature: [],
      identity_key: 'fallback-key',
    }),
    'fallback-key',
  );
  assert.equal(
    __testInternals.defaultRemoteQuery({
      id: null,
      version: null,
      state_code: null,
      names: ['Electricity, medium voltage'],
      normalized_names: [],
      fields: {
        type_of_dataset: 'Product flow',
        flow_property: 'Net calorific value',
        reference_unit: 'kWh',
        categories: ['electricity'],
        geography: 'CH',
      },
      exchange_signature: [],
      identity_key: '',
    }),
    [
      'flow name: Electricity, medium voltage',
      'flow type: Product flow',
      'reference property: Net calorific value',
      'reference unit: kWh',
      'category or compartment: electricity',
      'geography or market: CH',
    ].join('\n'),
  );
  assert.equal(
    __testInternals.defaultRemoteQuery({
      id: null,
      version: null,
      state_code: null,
      names: ['Heat, hard coal coke, at stove 5-15kW'],
      normalized_names: [],
      fields: {
        reference_flow_ids: ['heat-flow-id'],
        geography: 'RER',
        categories: ['Energy carriers and technologies'],
        technology_route: 'stove 5-15kW',
        system_boundary: 'at plant',
      },
      exchange_signature: ['input-flow-id:input:1', 'output-flow-id:output:1'],
      identity_key: '',
    }),
    [
      'process name: Heat, hard coal coke, at stove 5-15kW',
      'reference flow: heat-flow-id',
      'geography: RER',
      'classification or sector: Energy carriers and technologies',
      'technology route: stove 5-15kW',
      'system boundary: at plant',
      'exchange flow refs: input-flow-id; output-flow-id',
    ].join('\n'),
  );
  assert.equal(
    __testInternals.defaultRemoteQuery({
      id: null,
      version: null,
      state_code: null,
      names: ['Not specified', 'methane'],
      normalized_names: [],
      fields: {
        type_of_dataset: 'Elementary flow',
        categories: ['ILCD format', 'Emissions to air'],
        geography: 'Not specified by the BAFU ecoSpold1 source.',
      },
      exchange_signature: [],
      identity_key: '',
    }),
    [
      'flow name: methane',
      'flow type: Elementary flow',
      'category or compartment: Emissions to air',
    ].join('\n'),
  );
  assert.deepEqual(
    __testInternals.remoteSearchFilter(
      'flow',
      {
        id: null,
        version: null,
        state_code: null,
        names: [],
        normalized_names: [],
        fields: { type_of_dataset: ['Elementary flow'] },
        exchange_signature: [],
        identity_key: '',
      },
      null,
    ),
    { flowType: 'Elementary flow' },
  );
  assert.deepEqual(
    __testInternals.remoteSearchFilter(
      'flow',
      {
        id: null,
        version: null,
        state_code: null,
        names: [],
        normalized_names: [],
        fields: { type_of_dataset: 'Product flow' },
        exchange_signature: [],
        identity_key: '',
      },
      { flowType: 'explicit' },
    ),
    { flowType: 'explicit' },
  );
  assert.equal(
    __testInternals.remoteSearchFilter(
      'flow',
      {
        id: null,
        version: null,
        state_code: null,
        names: [],
        normalized_names: [],
        fields: {},
        exchange_signature: [],
        identity_key: '',
      },
      null,
    ),
    null,
  );

  assert.throws(
    () => __testInternals.normalizeRemoteCandidateSearch('yes'),
    /remote_candidate_search must be a boolean or object/u,
  );
  assert.throws(
    () => __testInternals.normalizeRemoteCandidateSearch({ limit: 0 }),
    /positive integer/u,
  );
  assert.throws(
    () => __testInternals.normalizeRemoteCandidateSearch({ data_source: 'public' }),
    /data_source must be one of tg, co, my, or te/u,
  );
  assert.throws(
    () => __testInternals.normalizeRemoteCandidateSearch({ match_threshold: 2 }),
    /between 0 and 1/u,
  );
});

test('identity preflight internals cover remote search edge helpers', () => {
  const normalized = __testInternals.normalizeRemoteCandidateSearch({
    query: 'hydrogen',
    limit: 2,
    data_source: 'tg',
  });

  assert.equal(__testInternals.normalizeNonNegativeNumber(undefined, 'weight'), null);
  assert.throws(
    () => __testInternals.normalizeNonNegativeNumber(-1, 'weight'),
    /non-negative number/u,
  );
  assert.throws(() => __testInternals.normalizeMatchThreshold(2), /between 0 and 1/u);
  assert.throws(
    () =>
      __testInternals.mergeRemoteCandidateSearchConfig(normalized, {
        inputPath: '/tmp/identity-preflight.json',
        remoteDataSource: 'public',
      }),
    /--remote-data-source must be one of tg, co, my, or te/u,
  );

  assert.deepEqual(
    __testInternals.mergeRemoteCandidateSearchConfig(normalized, {
      inputPath: '/tmp/identity-preflight.json',
      remoteCandidateSearch: false,
      remoteQuery: ' methane ',
      remoteFilter: { flowType: 'Elementary flow' },
      remoteLimit: 4,
      remoteDataSource: 'co',
    }),
    {
      ...normalized,
      enabled: false,
      query: 'methane',
      filter: { flowType: 'Elementary flow' },
      limit: 4,
      dataSource: 'co',
    },
  );

  assert.equal(__testInternals.isRemoteQueryNoiseText(''), true);
  assert.equal(__testInternals.isRemoteQueryNoiseText('ILCD format'), true);
  assert.equal(__testInternals.isRemoteQueryNoiseText('ILCD Data Network - Entry-level'), true);
  assert.equal(__testInternals.isRemoteQueryNoiseText('not specified by the BAFU source.'), true);
  assert.deepEqual(__testInternals.queryFieldValues(['Not specified', ' value '], 1), ['value']);

  const lines: string[] = [];
  __testInternals.appendQueryLine(lines, 'field', ['Not specified', 'usable value']);
  assert.deepEqual(lines, ['field: usable value']);

  assert.deepEqual(
    __testInternals.exchangeFlowRefsFromSignature([
      'flow-1:input:1',
      'flow-2:input:1',
      'flow-3:input:1',
      'flow-4:input:1',
      'flow-5:input:1',
      'flow-6:input:1',
      'flow-7:input:1',
      'flow-8:input:1',
      'flow-9:input:1',
    ]),
    ['flow-1', 'flow-2', 'flow-3', 'flow-4', 'flow-5', 'flow-6', 'flow-7', 'flow-8'],
  );
  assert.equal(__testInternals.compactRemoteQuery(['  alpha   beta  '], 'fallback'), 'alpha beta');
  assert.equal(__testInternals.compactRemoteQuery([], '  fallback value  '), 'fallback value');
  assert.equal(__testInternals.compactRemoteQuery([], '   '), null);
});

test('identity preflight internals cover profile hints and identity key branches', () => {
  const processKey = __testInternals.identityKeyFromProfile(
    'process',
    ['Heat, hard coal'],
    {
      reference_flow_ids: ['flow-a'],
      reference_flow_names: ['heat'],
      operation: 'produce',
      quantitative_reference: '1 MJ',
      geography: 'CH',
      time: '2025',
      technology_route: 'stove',
      system_boundary: 'at plant',
      provider_role: 'provider',
      categories: ['energy', 'heat'],
    },
    ['flow-a:output:1'],
  );
  assert.equal(
    processKey,
    'heat hard coal|flow a|heat|produce|1 mj|ch|2025|stove|at plant|provider|energy|heat|flow-a:output:1',
  );

  const flowKey = __testInternals.identityKeyFromProfile(
    'flow',
    ['Methane'],
    {
      type_of_dataset: 'Elementary flow',
      cas: '74-82-8',
      flow_property: 'Mass',
      reference_unit: 'kg',
      categories: ['Emissions', 'Air'],
      geography: 'GLO',
    },
    [],
  );
  assert.equal(flowKey, 'elementary flow|methane|74 82 8|mass|kg|air|emissions|glo');

  const baseProfile = __testInternals.profileForKind(
    {
      name_en: 'Base process',
      reference_flow_id: 'old-flow',
      geography: 'RER',
    },
    'process',
  );
  const hinted = __testInternals.applyIdentityProfileHints(
    baseProfile,
    {
      name: ['Hinted process'],
      reference_flow_id: ['flow-hint', 'Not specified'],
      geography: 'CN',
      classification: ['energy', 'heat'],
    },
    'process',
  );
  assert.deepEqual(hinted.names, ['Hinted process']);
  assert.deepEqual(hinted.fields.reference_flow_ids, ['flow-hint']);
  assert.equal(hinted.fields.geography, 'CN');
  assert.deepEqual(hinted.fields.categories, ['energy', 'heat']);
  assert.equal(
    __testInternals.applyIdentityProfileHints(baseProfile, null, 'process'),
    baseProfile,
  );

  assert.deepEqual(
    __testInternals.processReferenceFlowValues({
      exchanges: {
        exchange: {
          '@dataSetInternalID': '1',
          '@refObjectId': 'flow-fallback',
        },
      },
    }),
    { ids: ['flow-fallback'], names: [] },
  );

  const rowFallbackProfile = __testInternals.processProfile({
    name_en: 'Fallback profile',
    category: ['energy', 'heat'],
  });
  assert.deepEqual(rowFallbackProfile.fields.categories, ['energy', 'heat']);
});

test('identity preflight internals cover elementary flow comparison edges', () => {
  const productFlow = __testInternals.flowProfile({
    name_en: 'market flow',
    type_of_dataset: 'Product flow',
  });
  const emptyElementary = __testInternals.flowProfile({
    type_of_dataset: 'Elementary flow',
  });
  const methane = __testInternals.flowProfile({
    name_en: 'Methane',
    type_of_dataset: 'Elementary flow',
    cas: '74-82-8',
  });
  const methaneAlias = __testInternals.flowProfile({
    name_en: 'Marsh gas',
    type_of_dataset: 'Elementary flow',
    cas: '00074-82-8',
  });
  const ethene = __testInternals.flowProfile({
    name_en: 'Ethene',
    type_of_dataset: 'Elementary flow',
  });
  const ethylene = __testInternals.flowProfile({
    name_en: 'Ethylene',
    type_of_dataset: 'Elementary flow',
  });
  const carbonDioxide = __testInternals.flowProfile({
    name_en: 'Carbon dioxide',
    type_of_dataset: 'Elementary flow',
    cas: '124-38-9',
  });

  assert.equal(__testInternals.hasConflictingFlowName(productFlow, methane), false);
  assert.equal(__testInternals.hasConflictingFlowName(emptyElementary, methane), false);
  assert.equal(__testInternals.hasConflictingFlowName(ethene, ethylene), false);
  assert.equal(__testInternals.hasConflictingFlowName(methane, methaneAlias), false);
  assert.equal(__testInternals.hasConflictingFlowName(methane, carbonDioxide), true);
  assert.deepEqual(__testInternals.expandedFlowNameVariants('transformation to air'), [
    'transformation to air',
    'to air',
  ]);
  assert.deepEqual(__testInternals.expandedFlowNameVariants('occupation forest'), [
    'occupation forest',
    'occupation forest',
  ]);
  assert.equal(__testInternals.tokenCoverageRatio(new Set(), new Set(['methane'])), 0);

  assert.equal(__testInternals.elementaryCompartmentKey(''), null);
  assert.equal(
    __testInternals.elementaryCompartmentKey('low pop air'),
    'air_non_urban_or_high_stacks',
  );
  assert.equal(
    __testInternals.elementaryCompartmentKey('urban air close to ground'),
    'air_urban_close_to_ground',
  );
  assert.equal(__testInternals.elementaryCompartmentKey('indoor air'), 'air_indoor');
  assert.equal(
    __testInternals.elementaryCompartmentKey('air unspecified long term'),
    'air_unspecified_long_term',
  );
  assert.equal(__testInternals.elementaryCompartmentKey('air unspecified'), 'air_unspecified');
  assert.equal(__testInternals.elementaryCompartmentKey('fresh water'), 'water_fresh');
  assert.equal(__testInternals.elementaryCompartmentKey('sea water'), 'water_sea');
  assert.equal(
    __testInternals.elementaryCompartmentKey('water unspecified long term'),
    'water_unspecified_long_term',
  );
  assert.equal(__testInternals.elementaryCompartmentKey('water unspecified'), 'water_unspecified');
  assert.equal(__testInternals.elementaryCompartmentKey('agricultural soil'), 'soil_agricultural');
  assert.equal(
    __testInternals.elementaryCompartmentKey('non agricultural soil'),
    'soil_non_agricultural',
  );
  assert.equal(__testInternals.elementaryCompartmentKey('soil unspecified'), 'soil_unspecified');
  assert.equal(
    __testInternals.sameElementaryCompartment(
      ['Emissions to air', 'air unspecified long term'],
      ['Air', 'air unspecified long term'],
    ),
    true,
  );

  const leafTarget = __testInternals.flowProfile({
    name_en: 'Acetone',
    type_of_dataset: 'Elementary flow',
    flow_property: 'Mass',
    reference_unit: 'kg',
    category: ['Emissions to air', 'urban'],
  });
  const leafCandidate = __testInternals.flowProfile({
    name_en: 'Acetone candidate',
    type_of_dataset: 'Elementary flow',
    flow_property: 'Mass',
    reference_unit: 'kg',
    category: ['Emissions to water', 'urban'],
  });
  assert.ok(
    __testInternals
      .candidateEvaluation(leafTarget, leafCandidate, 'flow', 0)
      .report.match_reasons.includes('same_category_leaf'),
  );
});

test('identity preflight internals normalize candidate input aliases', () => {
  const normalized = __testInternals.normalizePreflightInput(
    {
      candidate: { name_en: 'target' },
      existing: { name_en: 'candidate-a' },
      rows: [{ name_en: 'candidate-b' }],
    },
    'process',
  );

  assert.deepEqual(normalized.target, { name_en: 'target' });
  assert.equal(normalized.candidates.length, 2);
  assert.equal(normalized.candidates[0]?.name_en, 'candidate-a');
  assert.equal(normalized.candidates[1]?.name_en, 'candidate-b');

  const flowNormalized = __testInternals.normalizePreflightInput(
    {
      flow: { name_en: 'flow-target' },
      candidates: {
        rows: [{ name_en: 'candidate-c' }],
      },
    },
    'flow',
  );

  assert.deepEqual(flowNormalized.target, { name_en: 'flow-target' });
  assert.equal(flowNormalized.candidates[0]?.name_en, 'candidate-c');

  const defaultTarget = __testInternals.normalizePreflightInput({ name_en: 'target' }, 'process');
  assert.deepEqual(defaultTarget.target, { name_en: 'target' });

  const processNormalized = __testInternals.normalizePreflightInput(
    {
      process: { name_en: 'process-target' },
    },
    'process',
  );
  assert.deepEqual(processNormalized.target, { name_en: 'process-target' });
});
