import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  __testInternals,
  runLifecyclemodelSaveDraft,
  validateLifecyclemodelPayload,
} from '../src/lib/lifecyclemodel-save-draft-run.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

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

function makeLifecyclemodel(id: string): Record<string, unknown> {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': id,
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '01.01.000',
        },
      },
    },
  };
}

function makeGlobalReference(id: string): Record<string, unknown> {
  return {
    '@type': 'contact data set',
    '@refObjectId': id,
    '@version': '01.00.000',
    '@uri': `https://example.com/${id}`,
    'common:shortDescription': { '#text': 'Reference', '@xml:lang': 'en' },
  };
}

function makeMultilangText(text: string): Record<string, unknown> {
  return { '#text': text, '@xml:lang': 'en' };
}

function makeSchemaValidLifecyclemodel(): Record<string, unknown> {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const reference = makeGlobalReference(id);
  const text = makeMultilangText('Lifecycle model');

  return {
    lifeCycleModelDataSet: {
      '@xmlns': 'http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017',
      '@xmlns:acme': 'http://acme.com/custom',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@locations': '../ILCDLocations.xml',
      '@version': '1.1',
      '@xsi:schemaLocation':
        'http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017 ../../schemas/ILCD_LifeCycleModelDataSet.xsd',
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': id,
          name: {
            baseName: text,
            treatmentStandardsRoutes: text,
            mixAndLocationTypes: text,
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                { '@level': '0', '@classId': '0', '#text': 'Root' },
                { '@level': '1', '@classId': '1', '#text': 'One' },
                { '@level': '2', '@classId': '2', '#text': 'Two' },
                { '@level': '3', '@classId': '3', '#text': 'Three' },
              ],
            },
          },
        },
        quantitativeReference: {
          referenceToReferenceProcess: '1',
        },
        technology: {
          processes: {},
        },
      },
      modellingAndValidation: {
        validation: {
          review: {
            'common:referenceToNameOfReviewerAndInstitution': reference,
          },
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': reference,
            'common:approvalOfOverallCompliance': 'Not defined',
            'common:nomenclatureCompliance': 'Not defined',
            'common:methodologicalCompliance': 'Not defined',
            'common:reviewCompliance': 'Not defined',
            'common:documentationCompliance': 'Not defined',
            'common:qualityCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        'common:commissionerAndGoal': {
          'common:referenceToCommissioner': reference,
        },
        dataEntryBy: {
          'common:timeStamp': '2026-05-05T00:00:00.000Z',
          'common:referenceToDataSetFormat': reference,
        },
        publicationAndOwnership: {
          'common:dataSetVersion': '01.01.000',
          'common:permanentDataSetURI': 'https://example.com/lifecyclemodel',
          'common:referenceToOwnershipOfDataSet': reference,
          'common:copyright': 'false',
          'common:licenseType': 'Other',
        },
      },
    },
  };
}

const VALIDATION_OK = () => ({
  ok: true as const,
  validator: 'test-validator',
  issue_count: 0 as const,
  issues: [] as [],
});

function makeResponse(options: { ok: boolean; status: number; body?: string }) {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      return options.body ?? '';
    },
  };
}

function withSupabaseAuthBootstrap(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (isSupabaseAuthTokenUrl(String(url))) {
      return makeSupabaseAuthResponse();
    }

    return fetchImpl(String(url), init);
  };
}

test('lifecyclemodel name validation rejects non-English semicolons before save dispatch', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-name-'));
  const payload = makeSchemaValidLifecyclemodel();
  const root = payload.lifeCycleModelDataSet as Record<string, unknown>;
  const info = root.lifeCycleModelInformation as Record<string, unknown>;
  const datasetInfo = info.dataSetInformation as Record<string, unknown>;
  const name = datasetInfo.name as Record<string, unknown>;
  name.baseName = [makeMultilangText('Battery'), { '@xml:lang': 'zh', '#text': '蓄电池；储能' }];
  const successSchema = { safeParse: () => ({ success: true as const }) };
  const validation = validateLifecyclemodelPayload(payload, successSchema);
  assert.equal(validation.ok, false);
  assert.deepEqual(
    validation.issues.map(({ code, path: issuePath }) => ({ code, issuePath })),
    [
      {
        code: 'dataset_name_semicolon',
        issuePath:
          'lifeCycleModelDataSet.lifeCycleModelInformation.dataSetInformation.name.baseName.1.#text',
      },
    ],
  );

  let dispatchCount = 0;
  try {
    const report = await runLifecyclemodelSaveDraft({
      inputPath: path.join(dir, 'models.json'),
      outDir: path.join(dir, 'out'),
      rawInput: [{ json_ordered: payload }],
      commit: true,
      env: buildSupabaseTestEnv(),
      fetchImpl: async () => {
        dispatchCount += 1;
        throw new Error('Invalid names must not reach transport.');
      },
    });
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.executed, 0);
    assert.equal(dispatchCount, 0);
    assert.ok(
      report.lifecyclemodels[0]?.validation?.issues.some(
        (issue) => issue.code === 'dataset_name_semicolon',
      ),
    );
    name.baseName = [makeMultilangText('Battery, storage')];
    datasetInfo['common:synonyms'] = [makeMultilangText('Battery; accumulator')];
    assert.equal(validateLifecyclemodelPayload(payload, successSchema).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelSaveDraft prepares dry-run bundle artifacts from local rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-save-draft-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'lm-1',
      version: '01.01.000',
      json_ordered: makeLifecyclemodel('lm-1'),
      json_tg: { xflow: { nodes: [], edges: [] } },
      rule_verification: true,
    },
  ]);

  try {
    const report = await runLifecyclemodelSaveDraft({
      inputPath,
      outDir,
      now: new Date('2026-05-05T00:00:00.000Z'),
      validateLifecyclemodelPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.mode, 'dry_run');
    assert.deepEqual(report.counts, {
      selected: 1,
      prepared: 1,
      executed: 0,
      failed: 0,
    });
    assert.equal(existsSync(report.files.summary_json), true);
    assert.deepEqual(readJson(report.files.summary_json), report);
    assert.equal(readJsonl(report.files.selected_lifecyclemodels).length, 1);
    assert.equal(readJsonl(report.files.progress_jsonl).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelSaveDraft records candidate failures and default output layout', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-save-draft-failures-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  writeJsonl(inputPath, [
    {
      json_ordered: {
        lifeCycleModelDataSet: {
          administrativeInformation: {
            publicationAndOwnership: {
              'common:dataSetVersion': '01.02.000',
            },
          },
        },
      },
      jsonTg: { xflow: { nodes: [] } },
      processMutations: [{ id: 'mutation-1' }, 1],
      ruleVerification: false,
    },
    {
      id: 'lm-invalid',
      json_ordered: makeLifecyclemodel('lm-invalid'),
      process_mutations: [{ id: 'mutation-2' }],
      rule_verification: true,
    },
  ]);

  try {
    const report = await runLifecyclemodelSaveDraft({
      inputPath,
      now: new Date('2026-05-05T00:00:00.000Z'),
      validateLifecyclemodelPayloadImpl: (payload) =>
        payload === makeLifecyclemodel('never')
          ? VALIDATION_OK()
          : {
              ok: false,
              validator: 'test-validator',
              issue_count: 1,
              issues: [{ path: '<root>', message: '', code: '' }],
            },
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.counts.failed, 2);
    assert.equal(path.basename(path.dirname(report.out_dir)), 'lifecyclemodel_save_draft');
    assert.equal(path.basename(path.dirname(path.dirname(report.out_dir))), 'artifacts');
    assert.equal(readJsonl(report.files.failures_jsonl).length, 2);

    const missingIdCandidate = __testInternals.buildCandidate(
      { json_tg: { xflow: {} }, processMutations: [{}], ruleVerification: true },
      { lifeCycleModelDataSet: {} },
      VALIDATION_OK,
    );
    assert.equal(missingIdCandidate.metadata?.ruleVerification, true);

    const invalidPayload = __testInternals.validateLifecyclemodelPayload({});
    assert.equal(invalidPayload.ok, false);
    const fallbackInvalidPayload = __testInternals.validateLifecyclemodelPayload(
      {},
      { safeParse: () => ({ success: false, error: { issues: [{}] } }) },
    );
    assert.deepEqual(fallbackInvalidPayload.issues, [
      { path: '<root>', message: 'Validation failed', code: 'custom' },
    ]);
    assert.equal(
      __testInternals.validateLifecyclemodelPayload({}, { safeParse: () => ({ success: false }) })
        .issue_count,
      0,
    );
    assert.equal(__testInternals.normalizeIssuePath(undefined), '<root>');
    assert.throws(
      () => __testInternals.getLifecyclemodelSchema({}),
      /LifeCycleModelSchema is unavailable/u,
    );
    assert.deepEqual(__testInternals.serializeError('string failure'), {
      message: 'string failure',
    });
    assert.deepEqual(__testInternals.serializeError(new Error('ordinary failure')), {
      message: 'ordinary failure',
    });
    assert.deepEqual(
      __testInternals.serializeError(
        new CliError('HTTP 502 returned from bundle endpoint', {
          code: 'REMOTE_REQUEST_FAILED',
          details: 'raw upstream response body',
        }),
      ),
      {
        message: 'HTTP 502 returned from bundle endpoint',
        code: 'REMOTE_REQUEST_FAILED',
      },
    );
    assert.equal(
      __testInternals.summarizeValidation({
        ok: false,
        validator: 'test-validator',
        issue_count: 0,
        issues: [],
      }),
      'local LifeCycleModelSchema validation failed with 0 issue(s)',
    );
    const unwrappedCandidate = __testInternals.buildCandidate(
      { id: 'lm-unwrapped' },
      {
        lifeCycleModelInformation: {
          dataSetInformation: { 'common:UUID': 'lm-unwrapped' },
        },
      },
      VALIDATION_OK,
    );
    assert.equal(unwrappedCandidate.id, 'lm-unwrapped');

    const validPayload = __testInternals.validateLifecyclemodelPayload(
      makeSchemaValidLifecyclemodel(),
      { safeParse: () => ({ success: true }) },
    );
    assert.equal(validPayload.ok, true);
    assert.equal(
      __testInternals.summarizeValidation(VALIDATION_OK()),
      'local LifeCycleModelSchema validation passed',
    );
    assert.equal(__testInternals.getLifecyclemodelFactory({}), null);
    assert.equal(
      typeof __testInternals.getLifecyclemodelFactory({ createLifeCycleModel: () => ({}) }),
      'function',
    );

    const deepFallbackPayload = __testInternals.validateLifecyclemodelPayload(
      {},
      {
        safeParse: () => ({
          success: false,
          error: { issues: [{ path: ['fast'], message: 'fast issue', code: 'fast' }] },
        }),
      },
      (_, config) => ({
        validateEnhanced: () =>
          config?.deepValidation
            ? {
                success: false,
                error: {
                  issues: [{ path: ['deep'], message: 'deep issue', code: 'deep' }],
                },
              }
            : {
                success: false,
                error: {
                  issues: [{ path: ['shallow'], message: 'shallow issue', code: 'shallow' }],
                },
              },
      }),
    );
    assert.deepEqual(deepFallbackPayload.issues, [
      { path: 'deep', message: 'deep issue', code: 'deep' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelSaveDraft validates commit runtime and executes remote writes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-save-draft-commit-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'lm-commit',
      version: '01.01.000',
      json_ordered: makeLifecyclemodel('lm-commit'),
    },
  ]);

  try {
    await assert.rejects(
      () =>
        runLifecyclemodelSaveDraft({
          inputPath,
          outDir,
          commit: true,
          validateLifecyclemodelPayloadImpl: VALIDATION_OK,
        }),
      /commit requires env and fetch runtime bindings/u,
    );

    const observed: string[] = [];
    const fetchImpl = withSupabaseAuthBootstrap(async (url) => {
      observed.push(String(url));
      if (observed.length === 1) {
        return makeResponse({ ok: true, status: 200, body: '[]' });
      }
      return makeResponse({ ok: true, status: 200, body: '{"ok":true}' });
    });

    const report = await runLifecyclemodelSaveDraft({
      inputPath,
      outDir,
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl,
      validateLifecyclemodelPayloadImpl: VALIDATION_OK,
      now: new Date('2026-05-05T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.counts.executed, 1);
    assert.match(observed[0] ?? '', /\/rest\/v1\/lifecyclemodels/u);
    assert.match(observed[1] ?? '', /save_lifecycle_model_bundle/u);

    const failingFetch = withSupabaseAuthBootstrap(async () =>
      makeResponse({ ok: true, status: 200, body: 'not-json' }),
    );
    const failed = await runLifecyclemodelSaveDraft({
      inputPath,
      outDir: path.join(dir, 'failed-out'),
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: failingFetch,
      validateLifecyclemodelPayloadImpl: VALIDATION_OK,
    });
    assert.equal(failed.status, 'completed_with_failures');
    assert.equal(failed.lifecyclemodels[0]?.status, 'failed');

    await assert.rejects(
      () =>
        runLifecyclemodelSaveDraft({
          inputPath,
          commit: true,
          validateLifecyclemodelPayloadImpl: VALIDATION_OK,
        }),
      /commit requires env and fetch runtime bindings/u,
    );

    const defaultValidator = await runLifecyclemodelSaveDraft({
      inputPath,
      outDir: path.join(dir, 'default-validator-out'),
    });
    assert.equal(defaultValidator.status, 'completed_with_failures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelSaveDraft preserves structured bundle authorization failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-save-draft-authz-'));
  const inputPath = path.join(dir, 'lifecyclemodels.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'lm-authz',
      version: '01.01.000',
      json_ordered: makeLifecyclemodel('lm-authz'),
    },
  ]);

  try {
    let requestCount = 0;
    const fetchImpl = withSupabaseAuthBootstrap(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"lm-authz","version":"01.01.000"}]',
        });
      }
      return makeResponse({
        ok: false,
        status: 400,
        body: JSON.stringify({
          ok: false,
          code: 'PROCESS_PERSIST_FAILED',
          message: 'Failed to persist lifecycle model bundle',
          details: 'OAuth client is not authorized for this API route',
        }),
      });
    });

    const report = await runLifecyclemodelSaveDraft({
      inputPath,
      outDir,
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl,
      validateLifecyclemodelPayloadImpl: VALIDATION_OK,
    });

    const expectedError = {
      message: 'Failed to persist lifecycle model bundle',
      code: 'PROCESS_PERSIST_FAILED',
      details: 'OAuth client is not authorized for this API route',
    };
    assert.equal(report.status, 'completed_with_failures');
    assert.deepEqual(report.lifecyclemodels[0]?.error, expectedError);
    assert.deepEqual(readJsonl(report.files.failures_jsonl), [
      {
        id: 'lm-authz',
        version: '01.01.000',
        status: 'failed',
        validation: VALIDATION_OK(),
        error: expectedError,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
