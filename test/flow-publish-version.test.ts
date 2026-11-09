import { flowReferenceFixture } from './helpers/flow-reference-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../src/lib/errors.js';
import type { FlowPayloadValidationResult } from '../src/lib/flow-payload-validation.js';
import type { FetchLike } from '../src/lib/http.js';
import { __testInternals, runFlowPublishVersion } from '../src/lib/flow-publish-version.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonRecord = Record<string, unknown>;

const VALIDATION_OK = (): FlowPayloadValidationResult => ({
  ok: true,
  validator: 'test-flow-validator',
  issue_count: 0,
  issues: [],
});

type FetchSpec = {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: unknown;
  rawText?: string;
};

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
  userId?: string | null;
  envelope?: 'json_ordered' | 'jsonOrdered' | 'json' | 'root';
}): JsonRecord {
  const payload = {
    flowDataSet: {
      ...flowReferenceFixture(),
      flowInformation: {
        ...flowReferenceFixture().flowInformation,
        dataSetInformation: {
          'common:UUID': options.id,
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': options.version ?? '01.00.001',
        },
      },
    },
  };

  const row: JsonRecord = {
    id: options.id,
    version: options.version ?? '01.00.001',
    state_code: 100,
  };
  if (options.userId !== null) {
    row.user_id = options.userId ?? `${options.id}-owner`;
  }

  const envelope = options.envelope ?? 'json_ordered';
  if (envelope === 'json_ordered') {
    row.json_ordered = payload;
  } else if (envelope === 'jsonOrdered') {
    row.jsonOrdered = payload;
  } else if (envelope === 'json') {
    row.json = payload;
  } else {
    return payload;
  }

  return row;
}

function makeFetchQueue(
  specs: FetchSpec[],
  observed: Array<{
    url: string;
    method: string;
    headers: HeadersInit | undefined;
    body: string | undefined;
  }>,
): FetchLike {
  let index = 0;
  return (async (input, init) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    observed.push({
      url: String(input),
      method: String(init?.method ?? ''),
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const spec = specs[Math.min(index, specs.length - 1)] as FetchSpec;
    index += 1;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? (spec.contentType ?? 'application/json') : null,
      },
      text: async () =>
        spec.rawText ??
        (typeof spec.body === 'string'
          ? spec.body
          : spec.body === undefined
            ? ''
            : JSON.stringify(spec.body)),
    };
  }) as FetchLike;
}

test('runFlowPublishVersion writes dry-run artifacts for insert, update, and failure planning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-dry-run-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const observed: Array<{
    url: string;
    method: string;
    headers: HeadersInit | undefined;
    body: string | undefined;
  }> = [];

  writeJsonl(inputFile, [
    makeFlowRow({ id: 'flow-1', userId: 'user-1' }),
    makeFlowRow({ id: 'flow-2', userId: 'user-2', envelope: 'jsonOrdered' }),
    makeFlowRow({ id: 'flow-3', userId: null }),
    makeFlowRow({ id: 'flow-4', userId: 'user-4', envelope: 'json' }),
  ]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      }),
      fetchImpl: makeFetchQueue(
        [
          { body: [] },
          {
            body: [{ id: 'flow-2', version: '01.00.001', user_id: 'user-2', state_code: 100 }],
          },
          {
            body: [{ id: 'flow-3', version: '01.00.001', user_id: 'other-user', state_code: 30 }],
          },
          {
            contentType: 'application/json',
            rawText: '{invalid-json',
          },
        ],
        observed,
      ),
      now: new Date('2026-03-30T12:00:00.000Z'),
      maxWorkers: 1,
      validateFlowPayloadImpl: VALIDATION_OK,
    });

    assert.deepEqual(report, {
      schema_version: 1,
      generated_at_utc: '2026-03-30T12:00:00.000Z',
      status: 'prepared_flow_publish_version',
      mode: 'dry_run',
      input_file: inputFile,
      out_dir: outDir,
      counts: {
        total_rows: 4,
        success_count: 2,
        failure_count: 2,
      },
      flow_gate: {
        status: 'passed',
        ruleset_id: 'flow-publish/default',
        ruleset_version: '1',
        counts: {
          total: 4,
          valid: 4,
          invalid: 0,
        },
        blocker_count: 0,
        next_action: 'query_remote_write_plan',
      },
      operation_counts: {
        would_insert: 1,
        would_update_existing: 1,
      },
      max_workers: 1,
      limit: null,
      target_user_id_override: null,
      files: {
        success_list: path.join(
          outDir,
          'flows_tidas_sdk_plus_classification_mcp_success_list.json',
        ),
        remote_failed: path.join(
          outDir,
          'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
        ),
        gate_report: path.join(outDir, 'flow-publish-version-gate-report.json'),
        report: path.join(outDir, 'flows_tidas_sdk_plus_classification_mcp_sync_report.json'),
      },
    });

    const successList = JSON.parse(readFileSync(report.files.success_list, 'utf8')) as JsonRecord[];
    assert.deepEqual(successList, [
      { id: 'flow-1', version: '01.00.001', operation: 'would_insert' },
      { id: 'flow-2', version: '01.00.001', operation: 'would_update_existing' },
    ]);

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(failures.length, 2);
    assert.equal(
      ((failures[0].reason as JsonRecord[])[0] as JsonRecord).code,
      'target_user_id_required',
    );
    assert.equal(
      ((failures[1].reason as JsonRecord[])[0] as JsonRecord).code,
      'REMOTE_INVALID_JSON',
    );

    assert.equal(observed.length, 4);
    assert.ok(observed.every((entry) => entry.method === 'GET'));
    assert.ok(observed.every((entry) => entry.body === undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion commit executes update, insert, fallback update, and failure handling', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-commit-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const observed: Array<{
    url: string;
    method: string;
    headers: HeadersInit | undefined;
    body: string | undefined;
  }> = [];

  writeJsonl(inputFile, [
    makeFlowRow({ id: 'flow-1', userId: 'user-1' }),
    makeFlowRow({ id: 'flow-2', userId: 'user-2' }),
    makeFlowRow({ id: 'flow-3', userId: 'user-3' }),
    makeFlowRow({ id: 'flow-4', userId: 'user-4' }),
    makeFlowRow({ id: 'flow-5', userId: 'user-5' }),
  ]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      commit: true,
      maxWorkers: 1,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      }),
      fetchImpl: makeFetchQueue(
        [
          {
            body: [{ id: 'flow-1', version: '01.00.001', user_id: 'user-1', state_code: 100 }],
          },
          { body: { ok: true, command: 'dataset_save_draft', data: { id: 'flow-1' } } },
          { body: [] },
          { body: { ok: true, command: 'dataset_create', data: { id: 'flow-2' } } },
          { body: [] },
          { ok: false, status: 409, contentType: 'text/plain', rawText: 'duplicate' },
          {
            body: [{ id: 'flow-3', version: '01.00.001', user_id: 'user-3', state_code: 100 }],
          },
          { body: { ok: true, command: 'dataset_save_draft', data: { id: 'flow-3' } } },
          {
            body: [{ id: 'flow-4', version: '01.00.001', user_id: 'other-user', state_code: 40 }],
          },
          { body: [] },
          { ok: false, status: 500, contentType: 'application/json', body: { message: 'boom' } },
          { body: [] },
        ],
        observed,
      ),
      now: new Date('2026-03-30T13:00:00.000Z'),
      validateFlowPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'completed_flow_publish_version_with_failures');
    assert.equal(report.mode, 'commit');
    assert.deepEqual(report.counts, {
      total_rows: 5,
      success_count: 3,
      failure_count: 2,
    });
    assert.deepEqual(report.operation_counts, {
      update_existing: 1,
      insert: 1,
      update_after_insert_error: 1,
    });

    const successList = JSON.parse(readFileSync(report.files.success_list, 'utf8')) as JsonRecord[];
    assert.deepEqual(successList, [
      { id: 'flow-1', version: '01.00.001', operation: 'update_existing' },
      { id: 'flow-2', version: '01.00.001', operation: 'insert' },
      { id: 'flow-3', version: '01.00.001', operation: 'update_after_insert_error' },
    ]);

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(failures.length, 2);
    assert.equal(
      ((failures[0].reason as JsonRecord[])[0] as JsonRecord).code,
      'exact_version_visible_not_owned',
    );
    assert.equal(
      ((failures[1].reason as JsonRecord[])[0] as JsonRecord).code,
      'REMOTE_REQUEST_FAILED',
    );

    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST', 'GET', 'POST', 'GET', 'POST', 'GET', 'POST', 'GET', 'GET', 'POST', 'GET'],
    );
    assert.match(observed[1]?.url ?? '', /\/functions\/v1\/app_dataset_save_draft$/u);
    assert.match(observed[3]?.url ?? '', /\/functions\/v1\/app_dataset_create$/u);
    assert.match(observed[1]?.body ?? '', /"version":"01\.00\.001"/u);
    assert.match(observed[1]?.body ?? '', /"jsonOrdered"/u);
    assert.match(observed[3]?.body ?? '', /"id":"flow-2"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('__testInternals.parse_response reports HTTP failures, empty bodies, and invalid JSON', async () => {
  await assert.rejects(
    async () =>
      __testInternals.parse_response(
        {
          ok: false,
          status: 503,
          headers: {
            get: () => 'text/plain',
          },
          text: async () => 'service unavailable',
        },
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_REQUEST_FAILED');
      assert.equal(error.details, 'service unavailable');
      return true;
    },
  );

  assert.equal(
    await __testInternals.parse_response(
      {
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '',
      },
      'https://example.supabase.co/rest/v1/flows',
    ),
    null,
  );

  await assert.rejects(
    async () =>
      __testInternals.parse_response(
        {
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{invalid-json',
        },
        'https://example.supabase.co/rest/v1/flows',
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_INVALID_JSON');
      return true;
    },
  );
});

test('runFlowPublishVersion can fall back to process.env and global fetch and respect limit', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-global-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.TIANGONG_LCA_API_BASE_URL;
  const originalAuthMode = process.env.TIANGONG_LCA_AUTH_MODE;
  const originalOAuthClientId = process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
  const originalSessionFile = process.env.TIANGONG_LCA_SESSION_FILE;
  const originalPublishableKey = process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  const testEnv = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
  });

  writeJsonl(inputFile, [
    makeFlowRow({ id: 'flow-1', userId: 'user-1' }),
    makeFlowRow({ id: 'flow-2', userId: 'user-2' }),
  ]);

  process.env.TIANGONG_LCA_API_BASE_URL = testEnv.TIANGONG_LCA_API_BASE_URL;
  process.env.TIANGONG_LCA_AUTH_MODE = testEnv.TIANGONG_LCA_AUTH_MODE;
  process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = testEnv.TIANGONG_LCA_OAUTH_CLIENT_ID;
  process.env.TIANGONG_LCA_SESSION_FILE = testEnv.TIANGONG_LCA_SESSION_FILE;
  process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = testEnv.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => '[]',
    };
  }) as unknown as typeof fetch;

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      limit: 1,
      validateFlowPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'prepared_flow_publish_version');
    assert.equal(report.counts.total_rows, 1);
    assert.equal(report.counts.success_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.TIANGONG_LCA_API_BASE_URL;
    } else {
      process.env.TIANGONG_LCA_API_BASE_URL = originalBaseUrl;
    }
    if (originalAuthMode === undefined) {
      delete process.env.TIANGONG_LCA_AUTH_MODE;
    } else {
      process.env.TIANGONG_LCA_AUTH_MODE = originalAuthMode;
    }
    if (originalOAuthClientId === undefined) {
      delete process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
    } else {
      process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = originalOAuthClientId;
    }
    if (originalSessionFile === undefined) {
      delete process.env.TIANGONG_LCA_SESSION_FILE;
    } else {
      process.env.TIANGONG_LCA_SESSION_FILE = originalSessionFile;
    }
    if (originalPublishableKey === undefined) {
      delete process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
    } else {
      process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion rejects empty inputs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-empty-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  writeJsonl(inputFile, []);

  try {
    await assert.rejects(
      () =>
        runFlowPublishVersion({
          inputFile,
          outDir: path.join(dir, 'publish-version'),
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
            TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
          }),
          fetchImpl: makeFetchQueue([], []),
        }),
      (error) => error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_EMPTY_INPUT',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion records rows with missing ids as failures without remote calls', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-missing-id-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const observed: Array<{
    url: string;
    method: string;
    headers: HeadersInit | undefined;
    body: string | undefined;
  }> = [];

  writeJsonl(inputFile, [
    {
      json_ordered: {
        flowDataSet: {
          administrativeInformation: {
            publicationAndOwnership: {
              'common:dataSetVersion': '01.00.001',
            },
          },
        },
      },
    },
  ]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      }),
      fetchImpl: makeFetchQueue([], observed),
      maxWorkers: 1,
      validateFlowPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'prepared_flow_publish_version');
    assert.deepEqual(report.counts, {
      total_rows: 1,
      success_count: 0,
      failure_count: 1,
    });
    assert.equal(observed.length, 0);

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(failures.length, 1);
    assert.equal(
      ((failures[0].reason as JsonRecord[])[0] as JsonRecord).code,
      'FLOW_PUBLISH_VERSION_ID_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion blocks FlowSchema validation failures before remote planning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-schema-gate-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const observed: string[] = [];

  writeJsonl(inputFile, [makeFlowRow({ id: 'flow-schema-blocked', userId: 'user-1' })]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      commit: true,
      maxWorkers: 1,
      fetchImpl: (async (input) => {
        observed.push(String(input));
        throw new Error('remote should not be called');
      }) as FetchLike,
      validateFlowPayloadImpl: () => ({
        ok: false,
        validator: 'test-flow-validator',
        issue_count: 1,
        issues: [
          {
            path: 'flowDataSet.flowInformation',
            message: 'schema failed',
            code: 'flow_schema_failed',
          },
        ],
      }),
      now: new Date('2026-03-30T15:30:00.000Z'),
    });

    assert.equal(report.status, 'completed_flow_publish_version_with_failures');
    assert.deepEqual(report.flow_gate, {
      status: 'blocked',
      ruleset_id: 'flow-publish/default',
      ruleset_version: '1',
      counts: {
        total: 1,
        valid: 0,
        invalid: 1,
      },
      blocker_count: 1,
      next_action: 'fix_flow_payloads',
    });
    assert.equal(observed.length, 0);

    const gate = JSON.parse(readFileSync(report.files.gate_report, 'utf8')) as JsonRecord;
    assert.equal(gate.status, 'blocked');
    assert.equal((gate.blockers as JsonRecord[])[0]?.code, 'flow_schema_failed');

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(((failures[0].reason as JsonRecord[])[0] as JsonRecord).validator, 'flow_schema');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion blocks import placeholder content before remote planning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-import-gate-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const row = makeFlowRow({ id: 'flow-import-placeholder', userId: 'user-1' });
  const payload = row.json_ordered as JsonRecord;
  const flowDataSet = payload.flowDataSet as JsonRecord;
  const flowInformation = flowDataSet.flowInformation as JsonRecord;
  const dataSetInformation = flowInformation.dataSetInformation as JsonRecord;
  dataSetInformation.name = {
    baseName: { '@xml:lang': 'en', '#text': 'Electricity, at grid' },
    treatmentStandardsRoutes: {
      '@xml:lang': 'en',
      '#text': 'Not declared in source package',
    },
  };
  const observed: string[] = [];

  writeJsonl(inputFile, [row]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      commit: true,
      maxWorkers: 1,
      fetchImpl: (async (input) => {
        observed.push(String(input));
        throw new Error('remote should not be called');
      }) as FetchLike,
      validateFlowPayloadImpl: VALIDATION_OK,
      now: new Date('2026-03-30T15:45:00.000Z'),
    });

    assert.equal(report.status, 'completed_flow_publish_version_with_failures');
    assert.deepEqual(report.flow_gate.counts, {
      total: 1,
      valid: 0,
      invalid: 1,
    });
    assert.equal(report.flow_gate.blocker_count, 1);
    assert.equal(observed.length, 0);

    const gate = JSON.parse(readFileSync(report.files.gate_report, 'utf8')) as JsonRecord;
    assert.equal(gate.status, 'blocked');
    assert.match(String(gate.validator), /\+tiangong\/import-content$/u);
    assert.equal((gate.blockers as JsonRecord[])[0]?.code, 'dataset_import_placeholder_content');

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(
      ((failures[0].reason as JsonRecord[])[0] as JsonRecord).validator,
      'import_content',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Flow publication reports reference property failures as content issues before remote planning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-flow-publish-factor-'));
  const inputFile = path.join(dir, 'flows.jsonl');
  const row = makeFlowRow({ id: 'flow-nonunit' });
  const dataset = (row.json_ordered as JsonRecord).flowDataSet as JsonRecord;
  dataset.flowProperties = flowReferenceFixture('0.45').flowProperties;
  const dangling = makeFlowRow({ id: 'flow-missing-target' });
  const danglingDataset = (dangling.json_ordered as JsonRecord).flowDataSet as JsonRecord;
  const flowInformation = danglingDataset.flowInformation as JsonRecord;
  flowInformation.quantitativeReference = { referenceToReferenceFlowProperty: '9' };
  try {
    writeJsonl(inputFile, [row, dangling]);
    const report = await runFlowPublishVersion({
      inputFile,
      outDir: path.join(dir, 'out'),
      commit: false,
      fetchImpl: () => assert.fail('Content rejection must precede remote planning'),
      validateFlowPayloadImpl: VALIDATION_OK,
    });
    assert.equal(report.flow_gate.status, 'blocked');
    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      failures
        .flatMap((failure) => failure.reason)
        .map(({ validator, stage, code }: JsonRecord) => ({
          validator,
          stage,
          code,
        })),
      [
        {
          validator: 'flow_reference_properties',
          stage: 'content_gate',
          code: 'reference_property_not_one',
        },
        {
          validator: 'flow_reference_properties',
          stage: 'content_gate',
          code: 'methodology_quant_ref_missing_target',
        },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowPublishVersion surfaces update-after-insert-error failures when fallback patch also fails', async () => {
  const dir = mkdtempSync(
    path.join(os.tmpdir(), 'tg-cli-flow-publish-version-update-after-insert-failure-'),
  );
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  const outDir = path.join(dir, 'publish-version');
  const observed: Array<{
    url: string;
    method: string;
    headers: HeadersInit | undefined;
    body: string | undefined;
  }> = [];

  writeJsonl(inputFile, [makeFlowRow({ id: 'flow-1', userId: 'user-1' })]);

  try {
    const report = await runFlowPublishVersion({
      inputFile,
      outDir,
      commit: true,
      maxWorkers: 1,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'secret-token',
      }),
      fetchImpl: makeFetchQueue(
        [
          { body: [] },
          { ok: false, status: 409, contentType: 'text/plain', rawText: 'duplicate' },
          {
            body: [{ id: 'flow-1', version: '01.00.001', user_id: 'user-1', state_code: 100 }],
          },
          { ok: false, status: 500, contentType: 'text/plain', rawText: 'save draft failed' },
        ],
        observed,
      ),
      now: new Date('2026-03-30T14:00:00.000Z'),
      validateFlowPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'completed_flow_publish_version_with_failures');
    assert.deepEqual(report.counts, {
      total_rows: 1,
      success_count: 0,
      failure_count: 1,
    });
    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST', 'GET', 'POST'],
    );

    const failures = readFileSync(report.files.remote_failed, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRecord);
    assert.equal(failures.length, 1);
    assert.deepEqual(
      (failures[0].reason as JsonRecord[]).map((reason) => (reason as JsonRecord).stage),
      ['insert', 'update_after_insert_error'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flow publish-version helper internals cover validation, parsing, concurrency, and error normalization', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-internals-'));
  const existingInput = path.join(dir, 'rows.jsonl');
  writeJsonl(existingInput, [makeFlowRow({ id: 'row-1', userId: 'user-1' })]);

  try {
    assert.equal(__testInternals.assert_input_file(existingInput), existingInput);
    assert.throws(
      () => __testInternals.assert_input_file(''),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_INPUT_REQUIRED',
    );
    assert.throws(
      () => __testInternals.assert_input_file(path.join(dir, 'missing.jsonl')),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_INPUT_NOT_FOUND',
    );
    assert.equal(__testInternals.assert_out_dir(dir), dir);
    assert.throws(
      () => __testInternals.assert_out_dir(''),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_OUT_DIR_REQUIRED',
    );

    assert.equal(__testInternals.to_positive_integer(undefined, '--x', 'ERR', 4), 4);
    assert.equal(__testInternals.to_positive_integer(2, '--x', 'ERR', 4), 2);
    assert.throws(
      () => __testInternals.to_positive_integer(0, '--x', 'ERR', 4),
      (error: unknown) => error instanceof CliError && error.code === 'ERR',
    );

    assert.equal(__testInternals.to_non_negative_integer(undefined, '--y', 'ERR2'), null);
    assert.equal(__testInternals.to_non_negative_integer(0, '--y', 'ERR2'), 0);
    assert.throws(
      () => __testInternals.to_non_negative_integer(-1, '--y', 'ERR2'),
      (error: unknown) => error instanceof CliError && error.code === 'ERR2',
    );

    const files = __testInternals.build_output_files(dir);
    assert.equal(
      path.basename(files.successList),
      'flows_tidas_sdk_plus_classification_mcp_success_list.json',
    );

    const jsonOrderedRow = makeFlowRow({ id: 'row-jsonOrdered', envelope: 'jsonOrdered' });
    const jsonRow = makeFlowRow({ id: 'row-json', envelope: 'json' });
    const rootRow = makeFlowRow({ id: 'row-root', envelope: 'root' });
    assert.equal(
      (
        ((__testInternals.flow_payload(jsonOrderedRow) as JsonRecord).flowDataSet ??
          {}) as JsonRecord
      ).administrativeInformation !== undefined,
      true,
    );
    assert.equal(
      (((__testInternals.flow_payload(jsonRow) as JsonRecord).flowDataSet ?? {}) as JsonRecord)
        .administrativeInformation !== undefined,
      true,
    );
    assert.equal(
      (((__testInternals.flow_payload(rootRow) as JsonRecord).flowDataSet ?? {}) as JsonRecord)
        .administrativeInformation !== undefined,
      true,
    );
    assert.throws(
      () => __testInternals.flow_payload({ bad: true }),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_PAYLOAD_REQUIRED',
    );

    const payload = __testInternals.flow_payload(makeFlowRow({ id: 'row-2' }));
    assert.equal(__testInternals.flow_id({ id: 'direct-id' }, payload as JsonRecord), 'direct-id');
    assert.equal(__testInternals.flow_id({}, payload as JsonRecord), 'row-2');
    assert.equal(__testInternals.flow_version(payload as JsonRecord), '01.00.001');
    assert.deepEqual(__testInternals.flow_version_gate_result(payload as JsonRecord), {
      version: '01.00.001',
      issue: null,
    });
    assert.equal(
      __testInternals.flow_version_gate_result({ flowDataSet: {} }).issue?.code,
      'FLOW_PUBLISH_VERSION_MISSING_VERSION',
    );
    assert.equal(
      __testInternals.build_flow_publish_gate_report([{ json_ordered: { flowDataSet: {} } }], {
        now: new Date('2026-03-30T16:01:00.000Z'),
      }).status,
      'blocked',
    );
    assert.equal(
      __testInternals.validate_publish_flow_row({ bad: true }, 0, VALIDATION_OK).issues[0]?.code,
      'FLOW_PUBLISH_VERSION_PAYLOAD_REQUIRED',
    );
    const throwingRow = {};
    Object.defineProperty(throwingRow, 'json_ordered', {
      get: () => {
        throw new Error('payload getter failed');
      },
    });
    assert.equal(
      __testInternals.validate_publish_flow_row(throwingRow as JsonRecord, 0, VALIDATION_OK)
        .issues[0]?.code,
      'flow_payload_required',
    );
    assert.equal(
      __testInternals.validate_publish_flow_row(
        {
          id: 'missing-version',
          json_ordered: { flowDataSet: { flowInformation: { dataSetInformation: {} } } },
        },
        0,
        VALIDATION_OK,
      ).issues[0]?.code,
      'FLOW_PUBLISH_VERSION_MISSING_VERSION',
    );
    assert.throws(
      () => __testInternals.flow_version({ flowDataSet: {} }),
      (error: unknown) =>
        error instanceof CliError && error.code === 'FLOW_PUBLISH_VERSION_MISSING_VERSION',
    );

    assert.equal(
      __testInternals.resolve_target_user_id({ user_id: 'row-user' }, 'override-user'),
      'row-user',
    );
    assert.equal(__testInternals.resolve_target_user_id({}, 'override-user'), 'override-user');
    assert.equal(__testInternals.resolve_target_user_id({}, null), null);

    assert.match(
      __testInternals.build_visible_rows_url(
        'https://example.supabase.co/rest/v1',
        'flow-1',
        '01.00.001',
      ),
      /select=id%2Cversion%2Cuser_id%2Cstate_code/u,
    );
    assert.match(
      __testInternals.build_update_url(
        'https://example.supabase.co/rest/v1',
        'flow-1',
        '01.00.001',
      ),
      /version=eq\.01\.00\.001/u,
    );

    assert.deepEqual(
      __testInternals.parse_visible_rows(
        [{ id: 'flow-1', version: '01.00.001', user_id: 'user-1', state_code: 100 }],
        'https://example.test',
      ),
      [{ id: 'flow-1', version: '01.00.001', user_id: 'user-1', state_code: 100 }],
    );
    assert.deepEqual(
      __testInternals.parse_visible_rows(
        [{ id: 'flow-2', version: '01.00.001', user_id: 'user-2', state_code: 'bad' }],
        'https://example.test',
      ),
      [{ id: 'flow-2', version: '01.00.001', user_id: 'user-2', state_code: null }],
    );
    assert.throws(
      () => __testInternals.parse_visible_rows({}, 'https://example.test'),
      (error: unknown) =>
        error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID',
    );
    assert.throws(
      () => __testInternals.parse_visible_rows([null], 'https://example.test'),
      (error: unknown) =>
        error instanceof CliError && error.code === 'SUPABASE_REST_RESPONSE_INVALID',
    );

    assert.deepEqual(__testInternals.visible_conflict_reasons('stage', [], 'user-1'), []);
    assert.equal(
      __testInternals.visible_conflict_reasons(
        'stage',
        [{ id: '', version: '', user_id: '', state_code: null }],
        null,
      )[0]?.code,
      'target_user_id_required',
    );
    assert.equal(
      __testInternals.visible_conflict_reasons(
        'stage',
        [{ id: '', version: '', user_id: 'other', state_code: 5 }],
        'user-1',
      )[0]?.code,
      'exact_version_visible_not_owned',
    );
    assert.equal(
      __testInternals.visible_conflict_reasons(
        'stage',
        [{ id: '', version: '', user_id: 'other', state_code: null }],
        'user-1',
      )[0]?.visible_state_code,
      '',
    );

    assert.deepEqual(__testInternals.failure_row({ id: 'x' }, []).json_ordered, {});
    assert.equal(
      __testInternals.build_error_reasons(
        'stage',
        new CliError('boom', { code: 'CLI_ERR', exitCode: 1, details: 'detail-text' }),
      )[0]?.code,
      'CLI_ERR',
    );
    assert.equal(
      __testInternals.build_error_reasons(
        'stage',
        new CliError('boom', { code: 'CLI_ERR_EMPTY_DETAIL', exitCode: 1, details: '   ' }),
      )[0]?.message,
      'boom',
    );
    assert.equal(
      __testInternals.build_error_reasons('stage', new Error('plain-error'))[0]?.message,
      'plain-error',
    );
    const unnamedError = new Error('plain-error');
    unnamedError.name = '';
    assert.equal(__testInternals.build_error_reasons('stage', unnamedError)[0]?.code, 'Error');
    assert.equal(
      __testInternals.build_error_reasons('stage', 'string-error')[0]?.code,
      'UnknownError',
    );
    assert.equal(
      await __testInternals.parse_response(
        {
          ok: true,
          status: 200,
          headers: {
            get: () => null,
          },
          text: async () => 'plain-text',
        },
        'https://example.test',
      ),
      'plain-text',
    );

    assert.deepEqual(
      await __testInternals.map_with_concurrency([1, 2, 3], 3, async (value: number) => value * 2),
      [2, 4, 6],
    );
    assert.deepEqual(
      await __testInternals.map_with_concurrency([], 5, async (value: number) => value * 2),
      [],
    );

    assert.equal(__testInternals.status_from_mode('dry_run', 0), 'prepared_flow_publish_version');
    assert.equal(__testInternals.status_from_mode('commit', 0), 'completed_flow_publish_version');
    assert.equal(
      __testInternals.status_from_mode('commit', 1),
      'completed_flow_publish_version_with_failures',
    );
    assert.deepEqual(
      __testInternals.gate_failure_rows([], {
        schema_version: 1,
        generated_at_utc: '2026-03-30T16:00:00.000Z',
        status: 'blocked',
        ruleset_id: 'flow-publish/default',
        ruleset_version: '1',
        ruleset_source_version: '2026.05.23',
        ruleset_rule_ids: [
          'tidas.flow.name.base-name.technical',
          'tidas.flow.type.required',
          'tidas.flow.reference-property-unit.required',
          'tidas.flow.classification.elementary.valid',
          'tidas.flow.flow-property.mean-value.positive',
          'tidas.flow.evidence.field-bindings.required',
        ],
        validator: 'test-flow-validator',
        counts: {
          total: 1,
          valid: 0,
          invalid: 1,
        },
        findings: [],
        blockers: [],
        next_action: 'fix_flow_payloads',
        flows: [
          {
            index: 99,
            id: null,
            version: null,
            ok: false,
            issue_count: 1,
            issues: [{ path: '<root>', message: 'missing row', code: 'missing_row' }],
          },
        ],
      }),
      [],
    );
    assert.deepEqual(
      __testInternals.gate_failure_rows([makeFlowRow({ id: 'ok-flow' })], {
        schema_version: 1,
        generated_at_utc: '2026-03-30T16:00:00.000Z',
        status: 'passed',
        ruleset_id: 'flow-publish/default',
        ruleset_version: '1',
        ruleset_source_version: '2026.05.23',
        ruleset_rule_ids: [
          'tidas.flow.name.base-name.technical',
          'tidas.flow.type.required',
          'tidas.flow.reference-property-unit.required',
          'tidas.flow.classification.elementary.valid',
          'tidas.flow.flow-property.mean-value.positive',
          'tidas.flow.evidence.field-bindings.required',
        ],
        validator: 'test-flow-validator',
        counts: {
          total: 1,
          valid: 1,
          invalid: 0,
        },
        findings: [],
        blockers: [],
        next_action: 'query_remote_write_plan',
        flows: [
          {
            index: 0,
            id: 'ok-flow',
            version: '01.00.001',
            ok: true,
            issue_count: 0,
            issues: [],
          },
        ],
      }),
      [],
    );
    assert.equal(
      (
        await __testInternals.sync_one_row({
          row: { json_ordered: { flowDataSet: {} } },
          mode: 'dry_run',
          client: {} as never,
          restBaseUrl: 'https://example.supabase.co/rest/v1',
          commandTransport: {} as never,
          targetUserIdOverride: null,
        })
      ).status,
      'failure',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
