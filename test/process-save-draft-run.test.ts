import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';
import { runProcessSaveDraft } from '../src/lib/process-save-draft-run.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const VALIDATION_OK = (): ProcessPayloadValidationResult => ({
  ok: true,
  validator: 'test-validator',
  issue_count: 0,
  issues: [],
});

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function makeCanonicalProcess(id: string): Record<string, unknown> {
  return {
    processDataSet: {
      processInformation: {
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

function makeResponse(options: {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: string;
}) {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type'
          ? (options.contentType ?? 'application/json')
          : null;
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

test('runProcessSaveDraft produces dry-run artifacts from a rows file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-rows-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');

  writeJsonl(inputPath, [
    makeCanonicalProcess('proc-row-1'),
    {
      id: 'db-row-2',
      version: '01.01.000',
      json_ordered: makeCanonicalProcess('proc-row-2'),
    },
    {
      id: 'db-row-3',
      version: '01.01.000',
      json: makeCanonicalProcess('proc-row-3'),
    },
    {
      status: 'resolved_remote_process',
      process_id: 'proc-row-4',
      resolved_version: '01.01.000',
      process: makeCanonicalProcess('proc-row-4'),
    },
  ]);

  try {
    const report = await runProcessSaveDraft({
      inputPath,
      now: new Date('2026-04-14T00:00:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.commit, false);
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.input_kind, 'rows_file');
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.counts, {
      selected: 4,
      prepared: 4,
      executed: 0,
      failed: 0,
    });
    assert.equal(existsSync(report.files.summary_json), true);
    assert.deepEqual(readJson(report.files.summary_json), report);
    assert.deepEqual(
      (readJsonl(report.files.progress_jsonl) as Array<{ status: string }>).map(
        (row) => row.status,
      ),
      ['prepared', 'prepared', 'prepared', 'prepared'],
    );
    assert.equal(readJsonl(report.files.selected_processes).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft extracts processes from publish-request inputs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-request-'));
  const requestPath = path.join(dir, 'publish-request.json');
  const bundlePath = path.join(dir, 'bundle.json');
  const processPath = path.join(dir, 'proc.json');
  const sourcePath = path.join(dir, 'source.json');

  writeJson(bundlePath, {
    processes: [makeCanonicalProcess('proc-bundle')],
  });
  writeJson(processPath, makeCanonicalProcess('proc-input'));
  writeJson(sourcePath, {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: {
          'common:UUID': 'src-ignored',
        },
      },
    },
  });
  writeJson(requestPath, {
    inputs: {
      bundle_paths: ['./bundle.json'],
      processes: [{ file: './proc.json' }],
      sources: [{ file: './source.json' }],
    },
  });

  try {
    const report = await runProcessSaveDraft({
      inputPath: requestPath,
      now: new Date('2026-04-14T00:10:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });
    const normalizedInput = readJson(report.files.normalized_input) as {
      inputs: {
        bundle_paths: string[];
        processes: Array<{ file: string }>;
        sources: Array<{ file: string }>;
      };
      publish: { commit: boolean };
      out_dir: string;
    };

    assert.equal(report.input_kind, 'publish_request');
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.counts, {
      selected: 2,
      prepared: 2,
      executed: 0,
      failed: 0,
    });
    assert.deepEqual(
      report.processes.map((entry) => entry.source),
      ['bundle', 'input'],
    );
    assert.deepEqual(normalizedInput.inputs.bundle_paths, [bundlePath]);
    assert.deepEqual(normalizedInput.inputs.processes, [{ file: './proc.json' }]);
    assert.deepEqual(normalizedInput.inputs.sources, [{ file: './source.json' }]);
    assert.equal(normalizedInput.publish.commit, false);
    assert.equal(path.isAbsolute(normalizedInput.out_dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft executes state-aware save-draft writes on commit', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-commit-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');
  const observed: Array<{ method: string; url: string; body?: string }> = [];

  writeJsonl(inputPath, [makeCanonicalProcess('proc-commit-1')]);

  try {
    const report = await runProcessSaveDraft({
      inputPath,
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
        observed.push({
          method: String(init?.method ?? 'GET'),
          url: String(url),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });

        if (String(init?.method ?? 'GET') === 'GET') {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-commit-1","version":"01.01.000","user_id":"user-1","state_code":0}]',
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          body: '{"ok":true,"data":{"id":"proc-commit-1"}}',
        });
      }),
      now: new Date('2026-04-14T00:20:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST'],
    );
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.counts, {
      selected: 1,
      prepared: 0,
      executed: 1,
      failed: 0,
    });
    assert.equal(report.processes[0]?.status, 'executed');
    assert.deepEqual(report.processes[0]?.execution, {
      status: 'success',
      operation: 'save_draft',
      write_path: 'cmd_dataset_save_draft',
      rpc_result: { ok: true, data: { id: 'proc-commit-1' } },
      visible_row: {
        id: 'proc-commit-1',
        version: '01.01.000',
        user_id: 'user-1',
        state_code: 0,
      },
    });
    assert.deepEqual(
      (readJsonl(report.files.progress_jsonl) as Array<{ status: string }>).map(
        (row) => row.status,
      ),
      ['executed'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft records target user guard on commit', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-target-user-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');
  const observed: Array<{ method: string; url: string; body?: string }> = [];

  writeJsonl(inputPath, [makeCanonicalProcess('proc-target-guard')]);

  try {
    const report = await runProcessSaveDraft({
      inputPath,
      commit: true,
      targetUserId: 'user-1',
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuthBootstrap(async (url, init) => {
        observed.push({
          method: String(init?.method ?? 'GET'),
          url: String(url),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });

        if (String(url).includes('/rest/v1/processes')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-target-guard","version":"01.01.000","user_id":"user-1","state_code":0}]',
          });
        }

        if (String(url).includes('/auth/v1/user')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '{"id":"user-1"}',
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          body: '{"ok":true,"data":{"id":"proc-target-guard"}}',
        });
      }),
      now: new Date('2026-04-14T00:25:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST'],
    );
    assert.match(observed[1]?.body ?? '', /"target_user_id":"user-1"/u);
    assert.equal(report.status, 'completed');
    assert.equal(report.target_user_id, 'user-1');
    assert.deepEqual(report.account_guard, {
      target_user_id_required: true,
      target_user_id: 'user-1',
      commit_account_binding: 'current_cli_auth_session',
      post_write_verify_required: true,
    });
    const summary = readJson(report.files.summary_json) as { target_user_id?: unknown };
    assert.equal(summary.target_user_id, 'user-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft records non-canonical payloads as failed entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-invalid-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');

  writeJsonl(inputPath, [{ '@id': 'projection-only', '@version': '01.01.000' }]);

  try {
    const report = await runProcessSaveDraft({
      inputPath,
      now: new Date('2026-04-14T00:30:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.deepEqual(report.counts, {
      selected: 1,
      prepared: 0,
      executed: 0,
      failed: 1,
    });
    assert.equal(report.processes[0]?.status, 'failed');
    assert.match(report.processes[0]?.error?.message ?? '', /canonical process datasets/u);
    assert.equal(readJsonl(report.files.failures_jsonl).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft blocks schema-invalid canonical payloads before write planning', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-schema-invalid-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');

  writeJsonl(inputPath, [makeCanonicalProcess('proc-schema-invalid')]);

  try {
    const report = await runProcessSaveDraft({
      inputPath,
      now: new Date('2026-04-14T00:35:00.000Z'),
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.deepEqual(report.counts, {
      selected: 1,
      prepared: 0,
      executed: 0,
      failed: 1,
    });
    assert.equal(report.processes[0]?.status, 'failed');
    assert.match(report.processes[0]?.error?.message ?? '', /process validation failed/u);
    assert.equal(report.processes[0]?.validation?.ok, false);
    assert.equal(readJsonl(report.files.failures_jsonl).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft validates JSONL inputs before processing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-jsonl-errors-'));
  const missingPath = path.join(dir, 'missing.jsonl');
  const invalidJsonlPath = path.join(dir, 'invalid.jsonl');
  const invalidRowPath = path.join(dir, 'invalid-row.jsonl');

  writeFileSync(invalidJsonlPath, '{"bad"\n', 'utf8');
  writeFileSync(invalidRowPath, '7\n', 'utf8');

  try {
    await assert.rejects(
      () => runProcessSaveDraft({ inputPath: missingPath }),
      (error) => error instanceof CliError && error.code === 'INPUT_NOT_FOUND',
    );

    await assert.rejects(
      () => runProcessSaveDraft({ inputPath: invalidJsonlPath }),
      (error) => error instanceof CliError && error.code === 'INPUT_INVALID_JSONL',
    );

    await assert.rejects(
      () => runProcessSaveDraft({ inputPath: invalidRowPath }),
      (error) => error instanceof CliError && error.code === 'INPUT_INVALID_JSONL_ROW',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft supports publish-request entry variants and validates publish entry files', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-publish-variants-'));
  const requestPath = path.join(dir, 'publish-request.json');
  const processPath = path.join(dir, 'proc.json');
  const scalarPath = path.join(dir, 'scalar.json');

  writeJson(processPath, makeCanonicalProcess('proc-string-path'));
  writeJson(scalarPath, 7);

  try {
    const report = await runProcessSaveDraft({
      inputPath: requestPath,
      rawInput: {
        inputs: {
          processes: [
            './proc.json',
            {
              payload: makeCanonicalProcess('proc-inline-payload'),
            },
          ],
        },
      },
      now: new Date('2026-04-14T00:40:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.input_kind, 'publish_request');
    assert.deepEqual(report.counts, {
      selected: 2,
      prepared: 2,
      executed: 0,
      failed: 0,
    });
    assert.deepEqual(
      report.processes.map((entry) => entry.id),
      ['proc-string-path', 'proc-inline-payload'],
    );

    await assert.rejects(
      () =>
        runProcessSaveDraft({
          inputPath: requestPath,
          rawInput: {
            inputs: {
              processes: [
                {
                  file: './scalar.json',
                },
              ],
            },
          },
        }),
      (error) => error instanceof CliError && error.code === 'PROCESS_SAVE_DRAFT_INPUT_NOT_OBJECT',
    );

    await assert.rejects(
      () =>
        runProcessSaveDraft({
          inputPath: requestPath,
          rawInput: {
            inputs: {
              processes: ['./scalar.json'],
            },
          },
        }),
      (error) => error instanceof CliError && error.code === 'PROCESS_SAVE_DRAFT_INPUT_NOT_OBJECT',
    );

    await assert.rejects(
      () =>
        runProcessSaveDraft({
          inputPath: requestPath,
          rawInput: {
            inputs: {
              processes: [7],
            },
          },
        }),
      (error) => error instanceof CliError && error.code === 'PROCESS_SAVE_DRAFT_UNSUPPORTED_ENTRY',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft accepts single-row raw input and explicit output overrides', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-single-row-'));
  const inputPath = path.join(dir, 'single-row.json');
  const explicitOutDir = path.join(dir, 'explicit-out');

  try {
    const singleRowReport = await runProcessSaveDraft({
      inputPath,
      rawInput: makeCanonicalProcess('proc-single-row'),
      now: new Date('2026-04-14T00:45:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(singleRowReport.input_kind, 'rows_file');
    assert.deepEqual(singleRowReport.counts, {
      selected: 1,
      prepared: 1,
      executed: 0,
      failed: 0,
    });

    const publishHintReport = await runProcessSaveDraft({
      inputPath: path.join(dir, 'publish-hint.json'),
      rawInput: {
        output_dir: './hinted-out',
      },
      outDir: explicitOutDir,
      now: new Date('2026-04-14T00:46:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(publishHintReport.input_kind, 'publish_request');
    assert.equal(publishHintReport.out_dir, explicitOutDir);
    assert.deepEqual(publishHintReport.counts, {
      selected: 0,
      prepared: 0,
      executed: 0,
      failed: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft rejects invalid prepared rows and missing commit runtime bindings', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-invalid-rows-'));
  const inputPath = path.join(dir, 'rows.json');

  writeJson(inputPath, makeCanonicalProcess('proc-runtime-check'));

  try {
    await assert.rejects(
      () =>
        runProcessSaveDraft({
          inputPath,
          rawInput: [1],
          validateProcessPayloadImpl: VALIDATION_OK,
        }),
      (error) => error instanceof CliError && error.code === 'PROCESS_SAVE_DRAFT_INVALID_ROW',
    );

    await assert.rejects(
      () =>
        runProcessSaveDraft({
          inputPath,
          commit: true,
          rawInput: [makeCanonicalProcess('proc-runtime-check')],
          validateProcessPayloadImpl: VALIDATION_OK,
        }),
      (error) => error instanceof CliError && error.code === 'PROCESS_SAVE_DRAFT_RUNTIME_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessSaveDraft records execution failures and non-canonical extraction failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-runtime-failure-'));
  const inputPath = path.join(dir, 'rows.jsonl');

  writeJsonl(inputPath, [makeCanonicalProcess('proc-runtime-failure')]);

  const getterExplodes = {} as Record<string, unknown>;
  Object.defineProperty(getterExplodes, 'processDataSet', {
    enumerable: false,
    get() {
      throw new Error('getter exploded');
    },
  });

  try {
    const failureReport = await runProcessSaveDraft({
      inputPath,
      commit: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuthBootstrap(async (_url, init) => {
        if (String(init?.method ?? 'GET') === 'GET') {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-runtime-failure","version":"01.01.000","user_id":"user-1","state_code":0}]',
          });
        }
        throw 'rpc exploded';
      }),
      now: new Date('2026-04-14T00:50:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(failureReport.status, 'completed_with_failures');
    assert.equal(failureReport.processes[0]?.status, 'failed');
    assert.deepEqual(failureReport.processes[0]?.error, { message: 'rpc exploded' });

    const getterReport = await runProcessSaveDraft({
      inputPath: path.join(dir, 'getter.json'),
      rawInput: [getterExplodes],
      now: new Date('2026-04-14T01:00:00.000Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(getterReport.status, 'completed_with_failures');
    assert.equal(getterReport.processes[0]?.status, 'failed');
    assert.match(getterReport.processes[0]?.error?.message ?? '', /getter exploded/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
