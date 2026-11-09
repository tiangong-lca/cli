import { flowReferenceFixture } from './helpers/flow-reference-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import type { FlowPublishVersionReport } from '../src/lib/flow-publish-version.js';
import {
  __testInternals,
  runFlowReviewedPublishData,
} from '../src/lib/flow-publish-reviewed-data.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonRecord = Record<string, unknown>;

function withSupabaseAuth(fetchImpl: FetchLike): FetchLike {
  return (async (input, init) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return fetchImpl(input, init);
  }) as FetchLike;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`,
    'utf8',
  );
}

function makeFlowRow(options: {
  id: string;
  version?: string;
  envelope?: 'json_ordered' | 'root';
  extraPayload?: JsonRecord;
}): JsonRecord {
  const payload: JsonRecord = {
    flowDataSet: {
      ...flowReferenceFixture(),
      flowInformation: {
        ...flowReferenceFixture().flowInformation,
        dataSetInformation: {
          'common:UUID': options.id,
          name: {
            baseName: {
              '@xml:lang': 'en',
              '#text': `${options.id} name`,
            },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': options.version ?? '01.00.001',
        },
      },
      ...options.extraPayload,
    },
  };

  if (options.envelope === 'root') {
    return payload;
  }

  return {
    id: options.id,
    version: options.version ?? '01.00.001',
    json_ordered: payload,
  };
}

function lang(text: string, langCode = 'en'): JsonRecord {
  return {
    '@xml:lang': langCode,
    '#text': text,
  };
}

function makeExchange(options: {
  internalId?: string;
  flowId?: string;
  flowVersion?: string;
  flowText?: string;
  shortDescriptionShape?: 'array' | 'object';
}): JsonRecord {
  const shortDescription = lang(options.flowText ?? 'Flow text');

  return {
    '@dataSetInternalID': options.internalId ?? '1',
    exchangeDirection: 'Output',
    referenceToFlowDataSet: {
      '@type': 'flow data set',
      '@refObjectId': options.flowId ?? '',
      '@version': options.flowVersion ?? '',
      '@uri': '../flows/example.xml',
      'common:shortDescription':
        options.shortDescriptionShape === 'object' ? shortDescription : [shortDescription],
    },
  };
}

function makeProcessRow(options: {
  id: string;
  version?: string;
  name?: string;
  envelope?: 'json_ordered' | 'root';
  exchanges?: JsonRecord[];
}): JsonRecord {
  const version = options.version ?? '01.00.000';
  const exchanges = options.exchanges ?? [
    makeExchange({ flowId: 'flow-1', flowVersion: version, flowText: 'Scope Flow' }),
  ];
  const payload: JsonRecord = {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': options.id,
          name: {
            baseName: [lang(options.name ?? `${options.id} name`)],
          },
        },
        quantitativeReference: {
          '@type': 'Reference flow(s)',
          referenceToReferenceFlow: String(exchanges[0]?.['@dataSetInternalID'] ?? '1'),
          functionalUnitOrOther: [],
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': version,
        },
      },
      exchanges: {
        exchange: exchanges,
      },
    },
  };

  if (options.envelope === 'root') {
    return payload;
  }

  return {
    id: options.id,
    version,
    json_ordered: payload,
  };
}

test('runFlowReviewedPublishData writes flow-only dry-run artifacts and skips unchanged original rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-dry-run-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.json');
  const originalFlowRowsFile = path.join(dir, 'original-flows.json');
  const outDir = path.join(dir, 'publish-reviewed');

  writeJson(flowRowsFile, [
    makeFlowRow({ id: 'flow-unchanged', version: '01.00.001' }),
    makeFlowRow({
      id: 'flow-changed',
      version: '01.00.005',
      envelope: 'root',
      extraPayload: {
        modellingAndValidation: {
          LCIMethodAndAllocation: {
            typeOfDataSet: 'product flow',
          },
        },
      },
    }),
  ]);
  writeJson(originalFlowRowsFile, [makeFlowRow({ id: 'flow-unchanged', version: '01.00.001' })]);

  try {
    const report = await runFlowReviewedPublishData({
      flowRowsFile,
      originalFlowRowsFile,
      outDir,
      flowPublishPolicy: 'append_only_bump',
      now: new Date('2026-03-30T15:00:00.000Z'),
    });

    assert.deepEqual(report, {
      schema_version: 1,
      generated_at_utc: '2026-03-30T15:00:00.000Z',
      status: 'prepared_flow_publish_reviewed_data',
      mode: 'dry_run',
      flow_rows_file: flowRowsFile,
      process_rows_file: null,
      original_flow_rows_file: originalFlowRowsFile,
      out_dir: outDir,
      flow_publish_policy: 'append_only_bump',
      process_publish_policy: 'append_only_bump',
      rewrite_process_flow_refs: true,
      counts: {
        input_flow_rows: 2,
        input_process_rows: 0,
        original_flow_rows: 1,
        prepared_flow_rows: 1,
        prepared_process_rows: 0,
        skipped_unchanged_flow_rows: 1,
        rewritten_process_flow_refs: 0,
        flow_publish_reports: 1,
        process_publish_reports: 0,
        success_count: 0,
        failure_count: 0,
      },
      max_workers: 4,
      target_user_id_override: null,
      files: {
        prepared_flow_rows: path.join(outDir, 'prepared-flow-rows.json'),
        prepared_process_rows: path.join(outDir, 'prepared-process-rows.json'),
        flow_version_map: path.join(outDir, 'flow-version-map.json'),
        skipped_unchanged_flow_rows: path.join(outDir, 'skipped-unchanged-flow-rows.json'),
        process_ref_rewrite_evidence: path.join(outDir, 'process-flow-ref-rewrite-evidence.jsonl'),
        success_list: path.join(
          outDir,
          'flows_tidas_sdk_plus_classification_mcp_success_list.json',
        ),
        remote_failed: path.join(
          outDir,
          'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
        ),
        flow_publish_version_report: path.join(
          outDir,
          'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
        ),
        report: path.join(outDir, 'publish-report.json'),
      },
      flow_reports: [
        {
          entity_type: 'flow',
          id: 'flow-changed',
          name: 'flow-changed name',
          original_version: '01.00.005',
          publish_version: '01.00.006',
          publish_policy: 'append_only_bump',
          version_strategy: 'bump',
          status: 'prepared',
        },
      ],
      process_reports: [],
      skipped_unchanged_flow_rows: [
        {
          entity_type: 'flow',
          entity_id: 'flow-unchanged',
          entity_name: 'flow-unchanged name',
          version: '01.00.001',
          reason: 'unchanged_vs_original_rows_file',
        },
      ],
    });

    const preparedRows = JSON.parse(
      readFileSync(report.files.prepared_flow_rows, 'utf8'),
    ) as JsonRecord[];
    assert.equal(preparedRows.length, 1);
    assert.equal((preparedRows[0] as JsonRecord).version, '01.00.006');
    assert.equal(
      (
        (
          ((preparedRows[0] as JsonRecord).flowDataSet as JsonRecord)
            .administrativeInformation as JsonRecord
        ).publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.006',
    );

    const flowVersionMap = JSON.parse(
      readFileSync(report.files.flow_version_map, 'utf8'),
    ) as JsonRecord;
    assert.deepEqual(flowVersionMap, {
      'flow-changed@01.00.005': {
        id: 'flow-changed',
        source_version: '01.00.005',
        target_version: '01.00.006',
      },
    });

    assert.deepEqual(JSON.parse(readFileSync(report.files.prepared_process_rows, 'utf8')), []);
    assert.equal(readFileSync(report.files.process_ref_rewrite_evidence, 'utf8'), '');
    assert.deepEqual(JSON.parse(readFileSync(report.files.success_list, 'utf8')), []);
    assert.equal(readFileSync(report.files.remote_failed, 'utf8'), '');

    const compatReport = JSON.parse(
      readFileSync(report.files.flow_publish_version_report, 'utf8'),
    ) as JsonRecord;
    assert.equal(compatReport.status, 'prepared_flow_publish_version');
    assert.equal(((compatReport.counts as JsonRecord).total_rows as number) ?? -1, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewed publication rejects invalid Flow factors before preparing or writing dependent rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-reviewed-flow-factor-'));
  const flowRowsFile = path.join(dir, 'flows.jsonl');
  const processRowsFile = path.join(dir, 'processes.jsonl');
  const flow = makeFlowRow({
    id: 'flow-1',
    extraPayload: { flowProperties: flowReferenceFixture('0.45').flowProperties },
  });
  const process = makeProcessRow({
    id: 'process-1',
    exchanges: [makeExchange({ flowId: 'flow-1', flowVersion: '01.00.001' })],
  });
  try {
    writeJsonl(flowRowsFile, [flow]);
    writeJsonl(processRowsFile, [process]);
    for (const commit of [false, true]) {
      const outDir = path.join(dir, String(commit));
      await assert.rejects(
        runFlowReviewedPublishData({
          flowRowsFile,
          processRowsFile,
          outDir,
          commit,
          fetchImpl: () => assert.fail('No Flow or dependent Process request may be sent'),
        }),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, 'FLOW_PUBLISH_REVIEWED_REFERENCE_PROPERTIES_INVALID');
          assert.match(JSON.stringify(error.details), /reference_property_not_one/u);
          return true;
        },
      );
      assert.equal(existsSync(path.join(outDir, 'prepared-flow-rows.json')), false);
      assert.equal(existsSync(path.join(outDir, 'prepared-process-rows.json')), false);
      assert.equal(existsSync(path.join(outDir, 'flow-version-map.json')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('__testInternals.normalize_process_commit_failure prefers transport details when available', () => {
  assert.equal(
    __testInternals.normalize_process_commit_failure(
      new CliError('HTTP 0 returned from https://example.supabase.co/rest/v1/processes', {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: 'socket hang up',
      }),
    ),
    'socket hang up',
  );

  assert.equal(
    __testInternals.normalize_process_commit_failure(
      new CliError('HTTP 0 returned from https://example.supabase.co/rest/v1/processes', {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: {
          message: 'FetchError: connection reset by peer',
        },
      }),
    ),
    'connection reset by peer',
  );

  assert.equal(
    __testInternals.normalize_process_commit_failure(new Error('fallback-error')),
    'fallback-error',
  );
  assert.equal(
    __testInternals.normalize_process_commit_failure(
      new CliError('HTTP 0 returned from https://example.supabase.co/rest/v1/processes', {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: {},
      }),
    ),
    'HTTP 0 returned from https://example.supabase.co/rest/v1/processes',
  );
  assert.deepEqual(__testInternals.normalize_process_commit_failure({ raw: true }), { raw: true });
});

test('runFlowReviewedPublishData delegates commit publish to flow publish-version and maps results back into publish-report', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-commit-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.jsonl');
  const outDir = path.join(dir, 'publish-reviewed');

  writeJsonl(flowRowsFile, [
    makeFlowRow({ id: 'flow-1', version: '01.00.001' }),
    makeFlowRow({ id: 'flow-2', version: '01.00.002' }),
  ]);

  try {
    let observedInputFile = '';
    let observedMaxWorkers = 0;
    let observedTargetUserId: string | null = null;

    const report = await runFlowReviewedPublishData({
      flowRowsFile,
      outDir,
      flowPublishPolicy: 'append_only_bump',
      commit: true,
      maxWorkers: 7,
      targetUserId: 'user-override',
      now: new Date('2026-03-30T16:00:00.000Z'),
      runFlowPublishVersionImpl: async (options) => {
        observedInputFile = options.inputFile;
        observedMaxWorkers = options.maxWorkers ?? 0;
        observedTargetUserId = options.targetUserId ?? null;

        const preparedRows = JSON.parse(readFileSync(options.inputFile, 'utf8')) as JsonRecord[];
        assert.deepEqual(
          preparedRows.map((row) => row.version),
          ['01.00.002', '01.00.003'],
        );

        writeJson(
          path.join(options.outDir, 'flows_tidas_sdk_plus_classification_mcp_success_list.json'),
          [{ id: 'flow-1', version: '01.00.002', operation: 'insert' }],
        );
        writeJsonl(
          path.join(
            options.outDir,
            'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
          ),
          [
            {
              id: 'flow-2',
              json_ordered: makeFlowRow({
                id: 'flow-2',
                version: '01.00.003',
                envelope: 'root',
              }),
              reason: [
                {
                  validator: 'remote_rest',
                  stage: 'insert',
                  path: '',
                  message: 'duplicate version',
                  code: 'REMOTE_REQUEST_FAILED',
                },
              ],
            },
          ],
        );

        const compatReport: FlowPublishVersionReport = {
          schema_version: 1,
          generated_at_utc: '2026-03-30T16:00:00.000Z',
          status: 'completed_flow_publish_version_with_failures',
          mode: 'commit',
          input_file: options.inputFile,
          out_dir: options.outDir,
          counts: {
            total_rows: 2,
            success_count: 1,
            failure_count: 1,
          },
          flow_gate: {
            status: 'passed',
            ruleset_id: 'flow-publish/default',
            ruleset_version: '1',
            counts: {
              total: 2,
              valid: 2,
              invalid: 0,
            },
            blocker_count: 0,
            next_action: 'query_remote_write_plan',
          },
          operation_counts: {
            insert: 1,
          },
          max_workers: 7,
          limit: null,
          target_user_id_override: 'user-override',
          files: {
            success_list: path.join(
              options.outDir,
              'flows_tidas_sdk_plus_classification_mcp_success_list.json',
            ),
            remote_failed: path.join(
              options.outDir,
              'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
            ),
            gate_report: path.join(options.outDir, 'flow-publish-version-gate-report.json'),
            report: path.join(
              options.outDir,
              'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
            ),
          },
        };
        writeJson(compatReport.files.report, compatReport);
        return compatReport;
      },
    });

    assert.equal(observedInputFile, path.join(outDir, 'prepared-flow-rows.json'));
    assert.equal(observedMaxWorkers, 7);
    assert.equal(observedTargetUserId, 'user-override');
    assert.equal(report.status, 'completed_flow_publish_reviewed_data_with_failures');
    assert.deepEqual(report.counts, {
      input_flow_rows: 2,
      input_process_rows: 0,
      original_flow_rows: 0,
      prepared_flow_rows: 2,
      prepared_process_rows: 0,
      skipped_unchanged_flow_rows: 0,
      rewritten_process_flow_refs: 0,
      flow_publish_reports: 2,
      process_publish_reports: 0,
      success_count: 1,
      failure_count: 1,
    });
    assert.equal(report.process_rows_file, null);
    assert.equal(report.process_publish_policy, 'append_only_bump');
    assert.equal(report.rewrite_process_flow_refs, true);
    assert.deepEqual(report.flow_reports, [
      {
        entity_type: 'flow',
        id: 'flow-1',
        name: 'flow-1 name',
        original_version: '01.00.001',
        publish_version: '01.00.002',
        publish_policy: 'append_only_bump',
        version_strategy: 'bump',
        status: 'inserted',
        operation: 'insert',
      },
      {
        entity_type: 'flow',
        id: 'flow-2',
        name: 'flow-2 name',
        original_version: '01.00.002',
        publish_version: '01.00.003',
        publish_policy: 'append_only_bump',
        version_strategy: 'bump',
        status: 'failed',
        error: [
          {
            validator: 'remote_rest',
            stage: 'insert',
            path: '',
            message: 'duplicate version',
            code: 'REMOTE_REQUEST_FAILED',
          },
        ],
      },
    ]);

    const publishReport = JSON.parse(readFileSync(report.files.report, 'utf8')) as JsonRecord;
    assert.equal(publishReport.status, 'completed_flow_publish_reviewed_data_with_failures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow publish reviewed data process helpers unwrap root payloads and map update/failure commit outcomes', async () => {
  const rootProcessRow = makeProcessRow({
    id: 'proc-root-payload',
    version: '01.00.030',
    envelope: 'root',
  });
  const directProcessPayloadRow = (
    makeProcessRow({
      id: 'proc-direct-payload',
      version: '01.00.031',
    }).json_ordered as JsonRecord
  ).processDataSet as JsonRecord;
  assert.deepEqual(__testInternals.process_publish_payload_from_row(rootProcessRow), {
    processDataSet: rootProcessRow.processDataSet,
  });
  assert.deepEqual(__testInternals.process_publish_payload_from_row(directProcessPayloadRow), {
    processDataSet: directProcessPayloadRow,
  });

  assert.deepEqual(
    __testInternals.build_process_commit_success_report(
      {
        entity_type: 'process',
        entity_id: 'proc-updated',
        entity_name: 'proc updated',
        original_version: '01.00.001',
        publish_version: '01.00.001',
        version_strategy: 'keep_current',
        publish_policy: 'upsert_current_version',
        row: {},
      },
      'update_existing',
    ),
    {
      entity_type: 'process',
      id: 'proc-updated',
      name: 'proc updated',
      original_version: '01.00.001',
      publish_version: '01.00.001',
      publish_policy: 'upsert_current_version',
      version_strategy: 'keep_current',
      status: 'updated',
      operation: 'update_existing',
    },
  );

  const updateReports = await __testInternals.commit_process_plans({
    plans: [
      {
        entity_type: 'process',
        entity_id: 'proc-updated',
        entity_name: 'proc updated',
        original_version: '01.00.001',
        publish_version: '01.00.001',
        version_strategy: 'keep_current',
        publish_policy: 'upsert_current_version',
        row: makeProcessRow({ id: 'proc-updated', version: '01.00.001' }),
      },
    ],
    maxWorkers: 1,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuth(async (url, init) => {
      const method = String(init?.method ?? 'GET');
      const requestUrl = String(url);
      if (method === 'GET' && requestUrl.includes('id=eq.proc-updated')) {
        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return 'application/json';
            },
          },
          async text() {
            return '[{"id":"proc-updated","version":"01.00.001","state_code":0}]';
          },
        };
      }

      return {
        ok: true,
        status: 200,
        headers: {
          get() {
            return 'application/json';
          },
        },
        async text() {
          return '{"ok":true,"command":"dataset_save_draft","data":{"id":"proc-updated"}}';
        },
      };
    }),
  });
  assert.deepEqual(updateReports, [
    {
      entity_type: 'process',
      id: 'proc-updated',
      name: 'proc updated',
      original_version: '01.00.001',
      publish_version: '01.00.001',
      publish_policy: 'upsert_current_version',
      version_strategy: 'keep_current',
      status: 'updated',
      operation: 'update_existing',
    },
  ]);

  const failedReports = await __testInternals.commit_process_plans({
    plans: [
      {
        entity_type: 'process',
        entity_id: 'proc-failed',
        entity_name: 'proc failed',
        original_version: '01.00.001',
        publish_version: '01.00.001',
        version_strategy: 'keep_current',
        publish_policy: 'upsert_current_version',
        row: makeProcessRow({ id: 'proc-failed', version: '01.00.001' }),
      },
    ],
    maxWorkers: 1,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuth(async (url, init) => {
      const method = String(init?.method ?? 'GET');
      const requestUrl = String(url);
      if (method === 'GET' && requestUrl.includes('id=eq.proc-failed')) {
        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return 'application/json';
            },
          },
          async text() {
            return '[]';
          },
        };
      }

      return {
        ok: false,
        status: 409,
        headers: {
          get() {
            return 'application/json';
          },
        },
        async text() {
          return '{"message":"duplicate"}';
        },
      };
    }),
  });
  assert.deepEqual(failedReports, [
    {
      entity_type: 'process',
      id: 'proc-failed',
      name: 'proc failed',
      original_version: '01.00.001',
      publish_version: '01.00.001',
      publish_policy: 'upsert_current_version',
      version_strategy: 'keep_current',
      status: 'failed',
      error: '{"message":"duplicate"}',
    },
  ]);

  const stringErrorReports = await __testInternals.commit_process_plans({
    plans: [
      {
        entity_type: 'process',
        entity_id: 'proc-string-error',
        entity_name: 'proc string error',
        original_version: '01.00.001',
        publish_version: '01.00.001',
        version_strategy: 'keep_current',
        publish_policy: 'upsert_current_version',
        row: makeProcessRow({ id: 'proc-string-error', version: '01.00.001' }),
      },
    ],
    maxWorkers: 1,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: withSupabaseAuth(async () => {
      throw 'boom-string';
    }),
  });
  assert.deepEqual(stringErrorReports, [
    {
      entity_type: 'process',
      id: 'proc-string-error',
      name: 'proc string error',
      original_version: '01.00.001',
      publish_version: '01.00.001',
      publish_policy: 'upsert_current_version',
      version_strategy: 'keep_current',
      status: 'failed',
      error: 'boom-string',
    },
  ]);
});

test('runFlowReviewedPublishData can use the default flow publish-version implementation for commit mode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-default-commit-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.jsonl');
  const outDir = path.join(dir, 'publish-reviewed');
  const observed: Array<{ url: string; method: string; body: string | undefined }> = [];

  writeJsonl(flowRowsFile, [makeFlowRow({ id: 'flow-default', version: '01.00.001' })]);

  const fetchImpl = withSupabaseAuth(async (input: string | URL | Request, init?: RequestInit) => {
    observed.push({
      url: String(input),
      method: String(init?.method ?? ''),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (observed.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '[]',
      };
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => '{"ok":true,"command":"dataset_create","data":{"id":"flow-default"}}',
    };
  }) as unknown as FetchLike;

  try {
    const report = await runFlowReviewedPublishData({
      flowRowsFile,
      outDir,
      flowPublishPolicy: 'append_only_bump',
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      validateFlowPayloadImpl: () => ({
        ok: true,
        validator: 'test-flow-validator',
        issue_count: 0,
        issues: [],
      }),
    });

    assert.equal(report.status, 'completed_flow_publish_reviewed_data');
    assert.equal(report.counts.success_count, 1);
    assert.equal(report.counts.failure_count, 0);
    assert.equal(report.flow_reports[0]?.status, 'inserted');
    assert.equal(typeof report.generated_at_utc, 'string');
    assert.match(report.generated_at_utc, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST'],
    );
    assert.match(observed[1]?.body ?? '', /"id":"flow-default"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowReviewedPublishData prepares process rows locally, rewrites flow refs, and bumps process versions', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-process-dry-run-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.json');
  const processRowsFile = path.join(dir, 'reviewed-processes.json');
  const outDir = path.join(dir, 'publish-reviewed');

  writeJson(flowRowsFile, [makeFlowRow({ id: 'flow-process', version: '01.00.001' })]);
  writeJson(processRowsFile, [
    makeProcessRow({
      id: 'process-1',
      version: '01.00.007',
      exchanges: [
        makeExchange({
          internalId: '42',
          flowId: 'flow-process',
          flowVersion: '01.00.001',
          flowText: 'Flow before rewrite',
          shortDescriptionShape: 'object',
        }),
      ],
    }),
  ]);

  try {
    const report = await runFlowReviewedPublishData({
      flowRowsFile,
      processRowsFile,
      outDir,
      flowPublishPolicy: 'append_only_bump',
      processPublishPolicy: 'append_only_bump',
      rewriteProcessFlowRefs: true,
      now: new Date('2026-03-30T18:00:00.000Z'),
    });

    assert.equal(report.status, 'prepared_flow_publish_reviewed_data');
    assert.equal(report.flow_rows_file, flowRowsFile);
    assert.equal(report.process_rows_file, processRowsFile);
    assert.equal(report.process_publish_policy, 'append_only_bump');
    assert.equal(report.rewrite_process_flow_refs, true);
    assert.deepEqual(report.counts, {
      input_flow_rows: 1,
      input_process_rows: 1,
      original_flow_rows: 0,
      prepared_flow_rows: 1,
      prepared_process_rows: 1,
      skipped_unchanged_flow_rows: 0,
      rewritten_process_flow_refs: 1,
      flow_publish_reports: 1,
      process_publish_reports: 1,
      success_count: 0,
      failure_count: 0,
    });
    assert.deepEqual(report.process_reports, [
      {
        entity_type: 'process',
        id: 'process-1',
        name: 'process-1 name',
        original_version: '01.00.007',
        publish_version: '01.00.008',
        publish_policy: 'append_only_bump',
        version_strategy: 'bump',
        status: 'prepared',
      },
    ]);

    const preparedProcesses = JSON.parse(
      readFileSync(report.files.prepared_process_rows, 'utf8'),
    ) as JsonRecord[];
    assert.equal(preparedProcesses.length, 1);
    assert.equal((preparedProcesses[0] as JsonRecord).version, '01.00.008');

    const preparedReference = ((
      (
        (
          ((preparedProcesses[0] as JsonRecord).json_ordered as JsonRecord)
            .processDataSet as JsonRecord
        ).exchanges as JsonRecord
      ).exchange as JsonRecord[]
    )[0]?.referenceToFlowDataSet ?? {}) as JsonRecord;
    assert.equal(preparedReference['@refObjectId'], 'flow-process');
    assert.equal(preparedReference['@version'], '01.00.002');
    assert.equal(preparedReference['@uri'], '../flows/flow-process_01.00.002.xml');
    assert.equal(Array.isArray(preparedReference['common:shortDescription']), false);

    const rewriteEvidence = readFileSync(report.files.process_ref_rewrite_evidence, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.deepEqual(rewriteEvidence, [
      {
        process_id: 'process-1',
        process_version_before_publish: '01.00.007',
        process_name: 'process-1 name',
        exchange_internal_id: '42',
        source_flow_id: 'flow-process',
        source_flow_version: '01.00.001',
        target_flow_id: 'flow-process',
        target_flow_version: '01.00.002',
        target_flow_name: 'flow-process name',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowReviewedPublishData commits prepared process rows through dataset commands when process publish is requested', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-process-commit-'));
  const processRowsFile = path.join(dir, 'reviewed-processes.json');
  const outDir = path.join(dir, 'publish-reviewed');
  const observed: Array<{ method: string; url: string; body?: string }> = [];

  writeJson(processRowsFile, [makeProcessRow({ id: 'process-commit', version: '01.00.000' })]);

  try {
    const report = await runFlowReviewedPublishData({
      processRowsFile,
      outDir,
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuth(async (url, init) => {
        observed.push({
          method: String(init?.method ?? 'GET'),
          url: String(url),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });

        if (observed.length === 1) {
          return {
            ok: true,
            status: 200,
            headers: {
              get() {
                return 'application/json';
              },
            },
            async text() {
              return '[]';
            },
          };
        }

        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return 'application/json';
            },
          },
          async text() {
            return '{"ok":true,"command":"dataset_create","data":{"id":"process-commit"}}';
          },
        };
      }),
    });

    assert.equal(report.status, 'completed_flow_publish_reviewed_data');
    assert.equal(report.counts.success_count, 1);
    assert.equal(report.counts.failure_count, 0);
    assert.equal(report.process_reports[0]?.status, 'inserted');
    assert.equal(report.process_reports[0]?.operation, 'insert');
    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST'],
    );
    assert.match(observed[1]?.url ?? '', /\/functions\/v1\/app_dataset_create$/u);
    assert.match(observed[1]?.body ?? '', /"jsonOrdered"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowReviewedPublishData rejects process commit without runtime env or fetch', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-process-runtime-'));
  const processRowsFile = path.join(dir, 'reviewed-processes.json');
  const outDir = path.join(dir, 'publish-reviewed');

  writeJson(processRowsFile, [makeProcessRow({ id: 'process-runtime', version: '01.00.000' })]);

  try {
    await assert.rejects(
      () =>
        runFlowReviewedPublishData({
          processRowsFile,
          outDir,
          commit: true,
        }),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_PROCESS_FETCH_REQUIRED',
    );

    await assert.rejects(
      () =>
        runFlowReviewedPublishData({
          processRowsFile,
          outDir,
          commit: true,
          fetchImpl: async () => {
            throw new Error('should not be called');
          },
        }),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === 'FLOW_PUBLISH_REVIEWED_PROCESS_RUNTIME_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowReviewedPublishData requires at least one flow or process input file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-input-required-'));
  const outDir = path.join(dir, 'publish-reviewed');

  try {
    await assert.rejects(
      () =>
        runFlowReviewedPublishData({
          outDir,
        }),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_INPUT_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow publish-reviewed-data helper internals cover validation, compatibility, and edge-case mapping', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-internals-'));
  const inputFile = path.join(dir, 'rows.json');
  writeJson(inputFile, []);

  try {
    assert.equal(
      __testInternals.assert_input_file(inputFile, 'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_REQUIRED'),
      inputFile,
    );
    assert.throws(
      () => __testInternals.assert_input_file('', 'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_REQUIRED'),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_REQUIRED',
    );
    assert.throws(
      () =>
        __testInternals.assert_input_file(
          path.join(dir, 'missing-flow-rows.json'),
          'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_REQUIRED',
        ),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_REQUIRED',
    );
    assert.equal(__testInternals.assert_optional_input_file(undefined, 'ANY_CODE'), null);
    assert.throws(
      () =>
        __testInternals.assert_optional_input_file(
          path.join(dir, 'missing.json'),
          'FLOW_PUBLISH_REVIEWED_ORIGINAL_ROWS_NOT_FOUND',
        ),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_ORIGINAL_ROWS_NOT_FOUND',
    );
    assert.equal(__testInternals.assert_out_dir(dir), dir);
    assert.throws(
      () => __testInternals.assert_out_dir(''),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_OUT_DIR_REQUIRED',
    );

    assert.equal(__testInternals.clone_json(undefined), undefined);
    assert.deepEqual(__testInternals.clone_json({ a: [1, 2] }), { a: [1, 2] });
    assert.equal(__testInternals.json_equal({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
    assert.equal(__testInternals.json_equal({ a: 1 }, { a: 2 }), false);
    assert.equal(__testInternals.json_equal({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(__testInternals.json_equal([1], [1, 2]), false);
    assert.equal(__testInternals.normalize_publish_policy(undefined), 'append_only_bump');
    assert.equal(__testInternals.normalize_publish_policy(''), 'append_only_bump');
    assert.equal(__testInternals.normalize_publish_policy('skip'), 'skip');
    assert.equal(
      __testInternals.normalize_publish_policy(
        'upsert_current_version',
        '--process-publish-policy',
        'FLOW_PUBLISH_REVIEWED_PROCESS_POLICY_INVALID',
      ),
      'upsert_current_version',
    );
    assert.throws(
      () => __testInternals.normalize_publish_policy('bad-policy'),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_POLICY_INVALID',
    );
    assert.throws(
      () =>
        __testInternals.normalize_publish_policy(
          'bad-policy',
          '--process-publish-policy',
          'FLOW_PUBLISH_REVIEWED_PROCESS_POLICY_INVALID',
        ),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_REVIEWED_PROCESS_POLICY_INVALID',
    );
    assert.equal(__testInternals.bump_ilcd_version('01.02.009'), '01.02.010');
    assert.equal(__testInternals.bump_ilcd_version(''), '01.01.001');
    assert.equal(__testInternals.bump_ilcd_version('bad-version'), '01.01.001');

    const rootRow = makeFlowRow({ id: 'flow-root', version: '01.00.009', envelope: 'root' });
    __testInternals.set_flow_version(rootRow, '01.00.010');
    assert.equal((rootRow as JsonRecord).version, '01.00.010');
    const missingPublicationRow = {
      flowDataSet: {
        administrativeInformation: {},
      },
    } as JsonRecord;
    __testInternals.set_flow_version(missingPublicationRow, '01.00.011');
    assert.equal(
      (
        ((missingPublicationRow.flowDataSet as JsonRecord).administrativeInformation as JsonRecord)
          .publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.011',
    );
    const missingAdministrativeRow = {
      flowDataSet: {},
    } as JsonRecord;
    __testInternals.set_flow_version(missingAdministrativeRow, '01.00.012');
    assert.equal(
      (
        (
          (missingAdministrativeRow.flowDataSet as JsonRecord)
            .administrativeInformation as JsonRecord
        ).publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.012',
    );
    const directPayloadRow = {
      administrativeInformation: {},
    } as JsonRecord;
    __testInternals.set_flow_version(directPayloadRow, '01.00.013');
    assert.equal((directPayloadRow as JsonRecord).version, '01.00.013');
    assert.equal(
      (
        (directPayloadRow.administrativeInformation as JsonRecord)
          .publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.013',
    );

    const directProcessPayloadRow = {
      administrativeInformation: {},
    } as JsonRecord;
    const wrappedProcessRow = makeProcessRow({ id: 'proc-wrapped', version: '01.00.001' });
    assert.equal(
      __testInternals.process_dataset_from_row(wrappedProcessRow),
      (wrappedProcessRow.json_ordered as JsonRecord).processDataSet,
    );
    const rootProcessRow = makeProcessRow({
      id: 'proc-root',
      version: '01.00.002',
      envelope: 'root',
    });
    assert.equal(
      __testInternals.process_dataset_from_row(rootProcessRow),
      (rootProcessRow as JsonRecord).processDataSet,
    );
    assert.equal(
      __testInternals.process_dataset_from_row(directProcessPayloadRow),
      directProcessPayloadRow,
    );
    assert.deepEqual(__testInternals.extract_process_identity(rootProcessRow), {
      id: 'proc-root',
      version: '01.00.002',
      name: 'proc-root name',
    });
    assert.deepEqual(
      __testInternals.extract_process_identity({
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:UUID': 'proc-default-version',
              name: {
                baseName: [lang('proc-default-version name')],
              },
            },
          },
        },
      } as JsonRecord),
      {
        id: 'proc-default-version',
        version: '01.00.000',
        name: 'proc-default-version name',
      },
    );
    assert.deepEqual(
      __testInternals.extract_process_identity({
        id: 'proc-fallback-name',
        processDataSet: {},
      } as JsonRecord),
      {
        id: 'proc-fallback-name',
        version: '01.00.000',
        name: 'proc-fallback-name',
      },
    );
    assert.deepEqual(__testInternals.exchange_records(wrappedProcessRow), [
      makeExchange({ flowId: 'flow-1', flowVersion: '01.00.001', flowText: 'Scope Flow' }),
    ]);

    const processWithoutPublication = {
      processDataSet: {
        administrativeInformation: {},
      },
    } as JsonRecord;
    __testInternals.set_process_version(processWithoutPublication, '01.00.014');
    assert.equal(
      (
        (
          (processWithoutPublication.processDataSet as JsonRecord)
            .administrativeInformation as JsonRecord
        ).publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.014',
    );

    const processWithoutAdministrative = {
      processDataSet: {},
    } as JsonRecord;
    __testInternals.set_process_version(processWithoutAdministrative, '01.00.015');
    assert.equal(
      (
        (
          (processWithoutAdministrative.processDataSet as JsonRecord)
            .administrativeInformation as JsonRecord
        ).publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.015',
    );

    __testInternals.set_process_version(directProcessPayloadRow, '01.00.016');
    assert.equal((directProcessPayloadRow as JsonRecord).version, '01.00.016');
    assert.equal(
      (
        (directProcessPayloadRow.administrativeInformation as JsonRecord)
          .publicationAndOwnership as JsonRecord
      )['common:dataSetVersion'],
      '01.00.016',
    );

    const files = __testInternals.build_output_files(dir);
    assert.equal(path.basename(files.report), 'publish-report.json');
    assert.equal(__testInternals.build_local_dataset_uri('flow data set', '', '01.00.001'), '');
    assert.equal(
      __testInternals.build_local_dataset_uri('unknown', 'dataset-1', '01.00.001'),
      '../datasets/dataset-1_01.00.001.xml',
    );
    assert.equal(
      __testInternals.build_local_dataset_uri('flow data set', 'dataset-2', ''),
      '../flows/dataset-2_01.00.000.xml',
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape([{ '@xml:lang': 'zh', '#text': 'old' }], {
        '@xml:lang': 'en',
        '#text': 'new',
      }),
      [{ '@xml:lang': 'en', '#text': 'new' }],
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape([{ '@xml:lang': 'zh', '#text': 'old' }], {
        '#text': 'new',
      }),
      [{ '@xml:lang': 'zh', '#text': 'new' }],
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape([{ '#text': 'old' }], {
        '#text': 'new',
      }),
      [{ '@xml:lang': 'en', '#text': 'new' }],
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape([], {
        '@xml:lang': 'en',
        '#text': 'new',
      }),
      [{ '@xml:lang': 'en', '#text': 'new' }],
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape(
        { '@xml:lang': 'zh', '#text': 'old' },
        { '@xml:lang': 'en', '#text': 'new' },
      ),
      { '@xml:lang': 'en', '#text': 'new' },
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape(
        { '@xml:lang': 'zh', '#text': 'old' },
        {
          '#text': 'new',
        },
      ),
      { '@xml:lang': 'zh', '#text': 'new' },
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape('old', {
        '@xml:lang': 'en',
        '#text': 'new',
      }),
      { '@xml:lang': 'en', '#text': 'new' },
    );
    assert.deepEqual(
      __testInternals.preserve_short_description_shape(
        { '#text': 'old' },
        {
          '#text': 'new',
        },
      ),
      { '@xml:lang': 'en', '#text': 'new' },
    );
    assert.equal(
      __testInternals.status_from_mode('dry_run', 0),
      'prepared_flow_publish_reviewed_data',
    );
    assert.equal(
      __testInternals.status_from_mode('commit', 0),
      'completed_flow_publish_reviewed_data',
    );
    assert.equal(
      __testInternals.status_from_mode('commit', 1),
      'completed_flow_publish_reviewed_data_with_failures',
    );

    const skipPrepared = __testInternals.prepare_flow_rows({
      rows: [makeFlowRow({ id: 'flow-skip' })],
      policy: 'skip',
      originalRows: [],
    });
    assert.deepEqual(skipPrepared, {
      preparedRows: [],
      plans: [],
      flowVersionMap: {},
      skippedUnchangedRows: [],
    });

    const upsertPrepared = __testInternals.prepare_flow_rows({
      rows: [makeFlowRow({ id: 'flow-upsert', version: '01.00.003' })],
      policy: 'upsert_current_version',
      originalRows: [],
    });
    assert.equal(upsertPrepared.preparedRows.length, 1);
    assert.equal(upsertPrepared.plans[0]?.publish_version, '01.00.003');
    assert.deepEqual(upsertPrepared.flowVersionMap, {});

    const missingIdPrepared = __testInternals.prepare_flow_rows({
      rows: [
        {
          flowDataSet: {
            flowInformation: {
              dataSetInformation: {
                name: {
                  baseName: {
                    '@xml:lang': 'en',
                    '#text': 'nameless flow',
                  },
                },
              },
            },
            administrativeInformation: {
              publicationAndOwnership: {
                'common:dataSetVersion': '01.00.004',
              },
            },
          },
        },
      ],
      policy: 'append_only_bump',
      originalRows: [
        {
          flowDataSet: {
            flowInformation: {
              dataSetInformation: {
                name: {
                  baseName: {
                    '@xml:lang': 'en',
                    '#text': 'nameless flow',
                  },
                },
              },
            },
            administrativeInformation: {
              publicationAndOwnership: {
                'common:dataSetVersion': '01.00.004',
              },
            },
          },
        },
      ],
    });
    assert.equal(missingIdPrepared.preparedRows.length, 1);
    assert.equal(missingIdPrepared.plans[0]?.entity_id, '');
    assert.equal(missingIdPrepared.plans[0]?.publish_version, '01.00.005');
    assert.deepEqual(missingIdPrepared.flowVersionMap, {});
    assert.deepEqual(missingIdPrepared.skippedUnchangedRows, []);

    const flowIndex = __testInternals.build_flow_index([
      makeFlowRow({ id: 'flow-index', version: '01.00.021' }),
    ]);
    assert.equal(flowIndex.byUuidVersion['flow-index@01.00.021']?.name, 'flow-index name');
    assert.deepEqual(
      __testInternals.flow_reference_from_record({
        id: 'flow-null-short',
        version: '01.00.022',
        name: 'flow null short',
        flowType: '',
        shortDescription: null,
        row: {},
      }),
      {
        '@type': 'flow data set',
        '@refObjectId': 'flow-null-short',
        '@version': '01.00.022',
        '@uri': '../flows/flow-null-short_01.00.022.xml',
        'common:shortDescription': {
          '@xml:lang': 'en',
          '#text': 'flow null short',
        },
      },
    );
    assert.deepEqual(
      __testInternals.flow_reference_from_record(flowIndex.byUuidVersion['flow-index@01.00.021']),
      {
        '@type': 'flow data set',
        '@refObjectId': 'flow-index',
        '@version': '01.00.021',
        '@uri': '../flows/flow-index_01.00.021.xml',
        'common:shortDescription': {
          '@xml:lang': 'en',
          '#text': 'flow-index name',
        },
      },
    );
    assert.deepEqual(
      __testInternals.patched_flow_reference(
        {
          '@type': '',
          '@refObjectId': 'old',
          '@version': 'old',
          'common:shortDescription': [{ '@xml:lang': 'zh', '#text': 'old name' }],
        },
        flowIndex.byUuidVersion['flow-index@01.00.021'],
      ),
      {
        '@type': 'flow data set',
        '@refObjectId': 'flow-index',
        '@version': '01.00.021',
        '@uri': '../flows/flow-index_01.00.021.xml',
        'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'flow-index name' }],
      },
    );
    assert.deepEqual(
      __testInternals.patched_flow_reference(
        'bad-reference',
        flowIndex.byUuidVersion['flow-index@01.00.021'],
      ),
      {
        '@type': 'flow data set',
        '@refObjectId': 'flow-index',
        '@version': '01.00.021',
        '@uri': '../flows/flow-index_01.00.021.xml',
        'common:shortDescription': {
          '@xml:lang': 'en',
          '#text': 'flow-index name',
        },
      },
    );

    const skipPreparedProcesses = __testInternals.prepare_process_rows({
      rows: [makeProcessRow({ id: 'proc-skip' })],
      policy: 'skip',
      rewriteRefs: true,
      preparedFlowRows: [],
      flowVersionMap: {},
    });
    assert.deepEqual(skipPreparedProcesses, {
      preparedRows: [],
      plans: [],
      rewriteEvidence: [],
    });

    assert.deepEqual(
      __testInternals.process_publish_payload_from_row(
        makeProcessRow({ id: 'proc-payload', version: '01.00.020' }),
      ),
      {
        processDataSet: (
          makeProcessRow({ id: 'proc-payload', version: '01.00.020' }).json_ordered as JsonRecord
        ).processDataSet as JsonRecord,
      },
    );
    assert.deepEqual(
      __testInternals.build_process_commit_success_report(
        {
          entity_type: 'process',
          entity_id: 'proc-success',
          entity_name: 'proc success',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: {},
        },
        'skipped_existing',
      ),
      {
        entity_type: 'process',
        id: 'proc-success',
        name: 'proc success',
        original_version: '01.00.001',
        publish_version: '01.00.002',
        publish_policy: 'append_only_bump',
        version_strategy: 'bump',
        status: 'skipped_existing',
        operation: 'skipped_existing',
      },
    );
    assert.deepEqual(
      __testInternals.build_process_commit_failure_report(
        {
          entity_type: 'process',
          entity_id: 'proc-failure',
          entity_name: 'proc failure',
          original_version: '01.00.001',
          publish_version: '01.00.001',
          version_strategy: 'keep_current',
          publish_policy: 'upsert_current_version',
          row: {},
        },
        'boom',
      ),
      {
        entity_type: 'process',
        id: 'proc-failure',
        name: 'proc failure',
        original_version: '01.00.001',
        publish_version: '01.00.001',
        publish_policy: 'upsert_current_version',
        version_strategy: 'keep_current',
        status: 'failed',
        error: 'boom',
      },
    );
    assert.deepEqual(
      await __testInternals.map_with_concurrency([1, 2, 3], 2, async (value) => value * 2),
      [2, 4, 6],
    );
    const commitPlans = await __testInternals.commit_process_plans({
      plans: [
        {
          entity_type: 'process',
          entity_id: 'proc-commit-plan',
          entity_name: 'proc commit plan',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: makeProcessRow({ id: 'proc-commit-plan', version: '01.00.002' }),
        },
      ],
      maxWorkers: 1,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuth(async (url, init) => {
        const method = String(init?.method ?? 'GET');
        if (method === 'GET') {
          return {
            ok: true,
            status: 200,
            headers: {
              get() {
                return 'application/json';
              },
            },
            async text() {
              return '[]';
            },
          };
        }

        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return 'application/json';
            },
          },
          async text() {
            return '{"ok":true,"command":"dataset_create","data":{"id":"proc-commit-plan"}}';
          },
        };
      }),
    });
    assert.equal(commitPlans[0]?.status, 'inserted');

    const rewrittenProcesses = __testInternals.prepare_process_rows({
      rows: [
        makeProcessRow({
          id: 'proc-rewrite',
          version: '01.00.030',
          exchanges: [
            makeExchange({
              internalId: '3',
              flowId: 'flow-old',
              flowVersion: '01.00.001',
              flowText: 'Old flow',
            }),
          ],
        }),
      ],
      policy: 'append_only_bump',
      rewriteRefs: true,
      preparedFlowRows: [makeFlowRow({ id: 'flow-old', version: '01.00.002' })],
      flowVersionMap: {
        'flow-old@01.00.001': {
          id: 'flow-old',
          source_version: '01.00.001',
          target_version: '01.00.002',
        },
      },
    });
    assert.equal(rewrittenProcesses.preparedRows.length, 1);
    assert.equal(rewrittenProcesses.plans[0]?.publish_version, '01.00.031');
    assert.equal(rewrittenProcesses.rewriteEvidence.length, 1);
    const rewrittenReference = ((
      (
        (
          ((rewrittenProcesses.preparedRows[0] as JsonRecord).json_ordered as JsonRecord)
            .processDataSet as JsonRecord
        ).exchanges as JsonRecord
      ).exchange as JsonRecord[]
    )[0]?.referenceToFlowDataSet ?? {}) as JsonRecord;
    assert.equal(rewrittenReference['@version'], '01.00.002');

    const nonRecordReferenceProcesses = __testInternals.prepare_process_rows({
      rows: [
        makeProcessRow({
          id: 'proc-non-record-ref',
          version: '01.00.032',
          exchanges: [
            {
              '@dataSetInternalID': '9',
              exchangeDirection: 'Output',
              referenceToFlowDataSet: 'not-a-record',
            },
          ],
        }),
      ],
      policy: 'append_only_bump',
      rewriteRefs: true,
      preparedFlowRows: [makeFlowRow({ id: 'flow-old', version: '01.00.002' })],
      flowVersionMap: {
        'flow-old@01.00.001': {
          id: 'flow-old',
          source_version: '01.00.001',
          target_version: '01.00.002',
        },
      },
    });
    assert.equal(nonRecordReferenceProcesses.rewriteEvidence.length, 0);

    const unmappedProcesses = __testInternals.prepare_process_rows({
      rows: [
        makeProcessRow({
          id: 'proc-unmapped',
          version: '01.00.033',
          exchanges: [
            makeExchange({
              internalId: '10',
              flowId: 'flow-unmapped',
              flowVersion: '01.00.001',
              flowText: 'Unmapped flow',
            }),
          ],
        }),
      ],
      policy: 'append_only_bump',
      rewriteRefs: true,
      preparedFlowRows: [makeFlowRow({ id: 'flow-other', version: '01.00.002' })],
      flowVersionMap: {
        'flow-old@01.00.001': {
          id: 'flow-old',
          source_version: '01.00.001',
          target_version: '01.00.002',
        },
      },
    });
    assert.equal(unmappedProcesses.rewriteEvidence.length, 0);
    const unmappedReference = ((
      (
        (
          ((unmappedProcesses.preparedRows[0] as JsonRecord).json_ordered as JsonRecord)
            .processDataSet as JsonRecord
        ).exchanges as JsonRecord
      ).exchange as JsonRecord[]
    )[0]?.referenceToFlowDataSet ?? {}) as JsonRecord;
    assert.equal(unmappedReference['@version'], '01.00.001');

    const missingTargetProcesses = __testInternals.prepare_process_rows({
      rows: [
        makeProcessRow({
          id: 'proc-missing-target',
          version: '01.00.040',
          exchanges: [
            makeExchange({
              internalId: '4',
              flowId: 'flow-missing-target',
              flowVersion: '01.00.001',
              flowText: 'Missing target',
            }),
          ],
        }),
      ],
      policy: 'upsert_current_version',
      rewriteRefs: true,
      preparedFlowRows: [makeFlowRow({ id: 'other-flow', version: '01.00.002' })],
      flowVersionMap: {
        'flow-missing-target@01.00.001': {
          id: 'flow-missing-target',
          source_version: '01.00.001',
          target_version: '01.00.002',
        },
      },
    });
    assert.equal(missingTargetProcesses.rewriteEvidence.length, 0);
    const missingTargetReference = ((
      (
        (
          ((missingTargetProcesses.preparedRows[0] as JsonRecord).json_ordered as JsonRecord)
            .processDataSet as JsonRecord
        ).exchanges as JsonRecord
      ).exchange as JsonRecord[]
    )[0]?.referenceToFlowDataSet ?? {}) as JsonRecord;
    assert.equal(missingTargetReference['@version'], '01.00.001');

    const compatReport = __testInternals.build_compat_report({
      now: new Date('2026-03-30T17:00:00.000Z'),
      mode: 'commit',
      preparedRows: 2,
      successCount: 1,
      failureCount: 1,
      maxWorkers: 3,
      targetUserId: 'user-1',
      files,
    });
    assert.equal(compatReport.status, 'completed_flow_publish_version_with_failures');
    const compatReportNoFailures = __testInternals.build_compat_report({
      now: new Date('2026-03-30T17:05:00.000Z'),
      mode: 'commit',
      preparedRows: 1,
      successCount: 1,
      failureCount: 0,
      maxWorkers: 1,
      targetUserId: null,
      files,
    });
    assert.equal(compatReportNoFailures.status, 'completed_flow_publish_version');

    const unkeyedFailureReports = __testInternals.map_commit_reports(
      [
        {
          entity_type: 'flow',
          entity_id: '',
          entity_name: 'missing-id',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: { json_ordered: { flowDataSet: {} } },
        },
      ],
      [],
      [
        {
          id: undefined,
          json_ordered: {
            flowDataSet: {
              administrativeInformation: {
                publicationAndOwnership: { 'common:dataSetVersion': '01.00.002' },
              },
            },
          },
          reason: [
            {
              validator: 'remote_rest',
              stage: 'insert',
              path: '',
              message: 'missing id',
              code: 'FLOW_PUBLISH_VERSION_ID_REQUIRED',
            },
          ],
        },
      ],
    );
    assert.equal(unkeyedFailureReports[0]?.status, 'failed');

    const unmatchedReports = __testInternals.map_commit_reports(
      [
        {
          entity_type: 'flow',
          entity_id: 'flow-unmatched',
          entity_name: 'flow-unmatched',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: makeFlowRow({ id: 'flow-unmatched' }),
        },
      ],
      [],
      [],
    );
    assert.equal(unmatchedReports[0]?.status, 'failed');
    assert.deepEqual(unmatchedReports[0]?.error, [
      {
        code: 'UNMATCHED_PUBLISH_RESULT',
        message: 'Publish result was missing for prepared flow row.',
      },
    ]);

    const duplicateKeyReports = __testInternals.map_commit_reports(
      [
        {
          entity_type: 'flow',
          entity_id: 'flow-dup',
          entity_name: 'flow-dup',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: makeFlowRow({ id: 'flow-dup' }),
        },
        {
          entity_type: 'flow',
          entity_id: 'flow-dup',
          entity_name: 'flow-dup',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: makeFlowRow({ id: 'flow-dup' }),
        },
      ],
      [
        { id: 'flow-dup', version: '01.00.002', operation: 'insert' },
        { id: 'flow-dup', version: '01.00.002', operation: 'update_existing' },
      ],
      [],
    );
    assert.deepEqual(
      duplicateKeyReports.map((report) => report.status),
      ['inserted', 'updated'],
    );

    const unkeyedUnmatchedReports = __testInternals.map_commit_reports(
      [
        {
          entity_type: 'flow',
          entity_id: '',
          entity_name: 'flow-empty-id',
          original_version: '01.00.001',
          publish_version: '01.00.002',
          version_strategy: 'bump',
          publish_policy: 'append_only_bump',
          row: { json_ordered: { flowDataSet: {} } },
        },
      ],
      [],
      [],
    );
    assert.equal(unkeyedUnmatchedReports[0]?.status, 'failed');

    const queue = new Map<string, Array<string | undefined>>([['key', [undefined]]]);
    assert.equal(__testInternals.shift_queue(queue, 'key'), null);
    assert.equal(queue.has('key'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
