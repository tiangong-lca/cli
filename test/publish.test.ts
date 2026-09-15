import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals,
  collectPublishInputs,
  normalizePublishRequest,
  runPublish,
} from '../src/lib/publish.js';
import type { FetchLike } from '../src/lib/http.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';
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

function makeSource(id: string): Record<string, unknown> {
  return {
    sourceDataSet: {
      sourceInformation: {
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

function makeLifecyclemodel(id: string): Record<string, unknown> {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': id,
          referenceToResultingProcess: {
            '@refObjectId': 'proc-result',
            '@version': '01.01.000',
          },
        },
        technology: {
          processes: {
            processInstance: {
              '@dataSetInternalID': '1',
              referenceToProcess: {
                '@refObjectId': 'proc-result',
                '@version': '01.01.000',
              },
            },
          },
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

function withSupabaseAuth(fetchImpl: FetchLike): FetchLike {
  return (async (input, init) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return fetchImpl(input, init);
  }) as FetchLike;
}

test('normalizePublishRequest resolves paths relative to the request file and applies defaults', () => {
  const requestPath = path.join(path.sep, 'tmp', 'tg-cli-publish', 'request.json');
  const requestDir = path.dirname(requestPath);
  const normalized = normalizePublishRequest(
    {
      inputs: {
        bundle_paths: ['./bundle.json'],
      },
      out_dir: './out',
    },
    {
      requestPath,
      now: new Date('2026-03-28T00:00:00Z'),
    },
  );

  assert.deepEqual(normalized.inputs.bundle_paths, [path.resolve(requestDir, 'bundle.json')]);
  assert.equal(normalized.out_dir, path.resolve(requestDir, 'out'));
  assert.equal(normalized.publish.commit, false);
  assert.equal(normalized.publish.publish_process_build_runs, true);
  assert.equal(normalized.publish.max_attempts, 5);
  assert.equal(normalized.publish.retry_delay_seconds, 2);
});

test('normalizePublishRequest resolves outDirOverride relative to the request file', () => {
  const requestPath = path.join(path.sep, 'tmp', 'tg-cli-publish', 'nested', 'request.json');
  const requestDir = path.dirname(requestPath);
  const normalized = normalizePublishRequest(
    {
      out_dir: './request-out',
    },
    {
      requestPath,
      outDirOverride: './override-out',
    },
  );

  assert.equal(normalized.out_dir, path.resolve(requestDir, 'override-out'));
});

test('normalizePublishRequest rejects unsupported relation modes and invalid integer settings', () => {
  assert.throws(
    () =>
      normalizePublishRequest('not-an-object', {
        requestPath: '/tmp/request.json',
      }),
    /must be a JSON object/u,
  );

  assert.throws(
    () =>
      normalizePublishRequest(
        {
          publish: {
            relation_mode: 'remote_table',
          },
        },
        {
          requestPath: '/tmp/request.json',
        },
      ),
    /relation_mode only supports/u,
  );

  assert.throws(
    () =>
      normalizePublishRequest(
        {
          publish: {
            max_attempts: 0,
          },
        },
        {
          requestPath: '/tmp/request.json',
        },
      ),
    /positive integer/u,
  );
});

test('normalizePublishRequest parses numeric strings and rejects invalid numeric shapes', () => {
  const normalized = normalizePublishRequest(
    {
      inputs: {
        relations: { id: 'rel-scalar' },
      },
      publish: {
        max_attempts: '7',
        retry_delay_seconds: '1.5',
        process_build_forward_args: '--flag',
      },
    },
    {
      requestPath: '/tmp/request.json',
    },
  );

  assert.equal(normalized.publish.max_attempts, 7);
  assert.equal(normalized.publish.retry_delay_seconds, 1.5);
  assert.deepEqual(normalized.inputs.relations, [{ id: 'rel-scalar' }]);
  assert.deepEqual(normalized.publish.process_build_forward_args, ['--flag']);

  assert.throws(
    () =>
      normalizePublishRequest(
        {
          publish: {
            max_attempts: { attempts: 1 },
          },
        },
        {
          requestPath: '/tmp/request.json',
        },
      ),
    /positive integer/u,
  );

  assert.throws(
    () =>
      normalizePublishRequest(
        {
          publish: {
            retry_delay_seconds: { seconds: 1 },
          },
        },
        {
          requestPath: '/tmp/request.json',
        },
      ),
    /non-negative number/u,
  );

  assert.throws(
    () =>
      normalizePublishRequest(
        {
          publish: {
            retry_delay_seconds: -1,
          },
        },
        {
          requestPath: '/tmp/request.json',
        },
      ),
    /non-negative number/u,
  );
});

test('collectPublishInputs merges bundle and direct inputs with source metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-collect-'));
  const bundlePath = path.join(dir, 'bundle.json');

  writeJson(bundlePath, {
    lifecyclemodels: [{ '@id': 'lm-bundle', '@version': '01.01.000' }],
    projected_processes: [{ '@id': 'projection-bundle' }],
    sources: [makeSource('src-bundle')],
    resulting_process_relations: [{ id: 'rel-bundle' }],
    process_build_runs: [{ run_id: 'bundle-run' }],
  });

  try {
    const collected = collectPublishInputs(
      {
        inputs: {
          bundle_paths: [bundlePath],
          lifecyclemodels: [{ '@id': 'lm-input', '@version': '01.01.000' }],
          processes: [makeCanonicalProcess('proc-input')],
          sources: [makeSource('src-input')],
          relations: [{ id: 'rel-input' }],
          process_build_runs: ['input-run'],
        },
        publish: {
          commit: false,
          publish_lifecyclemodels: true,
          publish_processes: true,
          publish_sources: true,
          publish_relations: true,
          publish_process_build_runs: true,
          relation_mode: 'local_manifest_only',
          max_attempts: 5,
          retry_delay_seconds: 2,
          process_build_forward_args: [],
        },
        out_dir: path.join(dir, 'out'),
      },
      dir,
    );

    assert.equal(collected.lifecyclemodels.length, 2);
    assert.equal(collected.lifecyclemodels[0].origin.source, 'bundle');
    assert.equal(collected.lifecyclemodels[0].origin.bundle_path, bundlePath);
    assert.equal(collected.lifecyclemodels[1].origin.source, 'input');
    assert.equal(collected.processes.length, 2);
    assert.equal(collected.relations.length, 2);
    assert.equal(collected.process_build_runs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish produces a dry-run report and artifacts from bundle and direct inputs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-dry-run-'));
  const bundlePath = path.join(dir, 'bundle.json');
  const sourcePath = path.join(dir, 'source.json');
  const requestPath = path.join(dir, 'request.json');

  writeJson(bundlePath, {
    lifecyclemodels: [{ '@id': 'lm-bundle', '@version': '01.01.000' }],
    projected_processes: [{ '@id': 'projection-bundle', '@version': '0.0.1' }],
    resulting_process_relations: [{ id: 'rel-bundle' }],
    process_build_runs: [{ run_id: 'bundle-run' }],
  });
  writeJson(sourcePath, makeSource('src-file'));
  writeJson(requestPath, {
    inputs: {
      bundle_paths: ['./bundle.json'],
      sources: [{ file: './source.json' }],
      relations: [{ id: 'rel-input' }],
      process_build_runs: ['input-run'],
    },
    publish: {
      commit: false,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.commit, false);
    assert.equal(report.status, 'completed');
    assert.equal(report.lifecyclemodels[0].status, 'prepared');
    assert.equal(report.processes[0].status, 'deferred_projection_payload');
    assert.equal(report.sources[0].status, 'prepared');
    assert.equal(report.process_build_runs[0].status, 'prepared');
    assert.equal(report.counts.bundle_paths, 1);
    assert.equal(report.counts.relations, 2);
    assert.equal(report.counts.deferred, 1);
    assert.equal(report.relations.status, 'prepared_local_relation_manifest');
    assert.equal(report.relations.relations.length, 2);
    assert.equal(report.verification.status, 'passed');
    assert.equal(report.verification.ruleset_id, 'publish-run/default');
    assert.equal(existsSync(report.files.verification_report), true);
    assert.deepEqual(
      JSON.parse(readFileSync(report.files.verification_report, 'utf8')),
      report.verification,
    );
    assert.equal(existsSync(report.files.publish_report), true);
    assert.deepEqual(JSON.parse(readFileSync(report.files.publish_report, 'utf8')), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish supports wrapped payload objects and string dataset entry paths', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-wrapped-'));
  const sourcePath = path.join(dir, 'source.json');
  const requestPath = path.join(dir, 'request.json');

  writeJson(sourcePath, makeSource('src-string'));
  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [
        {
          json_ordered: {
            '@id': 'lm-wrapped',
            '@version': '01.01.000',
          },
        },
      ],
      sources: ['./source.json'],
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.lifecyclemodels[0].status, 'prepared');
    assert.equal(report.sources[0].status, 'prepared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publish verification internals retain fallback blocker messages', () => {
  const report = __testInternals.build_publish_verification_report({
    now: new Date('2026-03-28T01:00:00Z'),
    commit: true,
    failed: 1,
    deferred: 0,
    executed: 0,
    lifecyclemodels: [
      {
        table: 'lifecyclemodels',
        id: 'lm-failed',
        version: '01.01.000',
        status: 'failed',
        source: 'input',
      } as never,
    ],
    processes: [],
    sources: [],
    processBuildRuns: [
      {
        run_id: 'run-failed',
        status: 'failed',
        source: 'input',
        bundle_path: null,
        forward_args: [],
      },
    ],
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.blockers[0]?.code, 'lifecyclemodels_publish_failed');
  assert.equal(report.blockers[0]?.message, 'Publish dataset failed.');
  assert.equal(report.blockers[1]?.message, 'Process build run publish failed.');
});

test('runPublish executes available commit executors and records failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-commit-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [{ '@id': 'lm-1', '@version': '01.01.000' }],
      processes: [makeCanonicalProcess('proc-1')],
      sources: [makeSource('src-1')],
      process_build_runs: ['run-1'],
    },
    publish: {
      commit: true,
      process_build_forward_args: ['--strict'],
    },
    out_dir: './publish-out',
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        lifecyclemodels: () => ({ inserted: true }),
        processes: () => {
          throw new Error('process failed');
        },
        sources: () => ({ updated: true }),
        process_build_runs: () => ({ published: true }),
      },
      now: new Date('2026-03-28T00:00:00Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.commit, true);
    assert.equal(report.out_dir, path.join(dir, 'publish-out'));
    assert.equal(report.lifecyclemodels[0].status, 'executed');
    assert.equal(report.sources[0].status, 'executed');
    assert.equal(report.process_build_runs[0].status, 'executed');
    assert.equal(report.process_build_runs[0].forward_args[0], '--strict');
    assert.equal(report.processes[0].status, 'failed');
    assert.match(report.processes[0].error?.message ?? '', /process failed/u);
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.counts.executed, 3);
    assert.equal(report.counts.failed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish honors commit override, defers missing executors, and rejects invalid run entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-override-'));
  const requestPath = path.join(dir, 'request.json');
  const invalidRequestPath = path.join(dir, 'invalid-request.json');

  writeJson(requestPath, {
    inputs: {
      processes: [makeCanonicalProcess('proc-override')],
    },
    publish: {
      commit: false,
    },
  });
  writeJson(invalidRequestPath, {
    inputs: {
      process_build_runs: [{}],
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      commit: true,
      now: new Date('2026-03-28T00:00:00Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.commit, true);
    assert.equal(report.processes[0].status, 'deferred_no_executor');

    await assert.rejects(
      async () =>
        runPublish({
          inputPath: invalidRequestPath,
        }),
      /missing run_id/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish blocks canonical process payloads that fail ProcessSchema before executors', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-process-schema-gate-'));
  const requestPath = path.join(dir, 'request.json');
  let executorCalls = 0;

  writeJson(requestPath, {
    inputs: {
      processes: [makeCanonicalProcess('not-a-uuid')],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        processes: () => {
          executorCalls += 1;
          return { inserted: true };
        },
      },
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.counts.failed, 1);
    assert.equal(report.counts.executed, 0);
    assert.equal(executorCalls, 0);
    assert.equal(report.processes[0].status, 'failed');
    assert.equal(report.processes[0].validation?.ok, false);
    assert.match(report.processes[0].error?.message ?? '', /process validation failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish uses state-aware process draft writes and generic source updates by default', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-default-rest-'));
  const requestPath = path.join(dir, 'request.json');
  const observed: Array<{ method: string; url: string; body?: string }> = [];

  writeJson(requestPath, {
    inputs: {
      processes: [
        {
          json_ordered: makeCanonicalProcess('proc-default-rest'),
          metadata: {
            generated_from_lifecyclemodel_id: 'model-default-rest',
            generated_from_lifecyclemodel_version: '01.01.021',
          },
        },
      ],
      sources: [makeSource('src-default-rest')],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
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

        if (String(url).includes('/processes?select=')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-default-rest","version":"01.01.000","user_id":"user-1","state_code":0}]',
          });
        }

        if (String(url).includes('/sources?select=')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"src-default-rest","version":"01.01.000","state_code":0}]',
          });
        }

        if (String(url).includes('/functions/v1/app_dataset_save_draft')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '{"ok":true,"command":"dataset_save_draft","data":{"id":"ok"}}',
          });
        }

        if (String(url).includes('/rpc/cmd_dataset_save_draft')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '{"ok":true,"id":"ok"}',
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"ok"}]',
        });
      }),
      now: new Date('2026-03-28T00:00:00Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.processes[0].status, 'executed');
    assert.equal(report.sources[0].status, 'executed');
    assert.deepEqual(report.processes[0].execution, {
      status: 'success',
      operation: 'save_draft',
      write_path: 'cmd_dataset_save_draft',
      rpc_result: {
        id: 'ok',
        ok: true,
      },
      visible_row: {
        id: 'proc-default-rest',
        state_code: 0,
        user_id: 'user-1',
        version: '01.01.000',
      },
    });
    assert.deepEqual(report.sources[0].execution, {
      status: 'success',
      operation: 'update_existing',
    });
    assert.equal(report.processes[0].model_id, 'model-default-rest');
    assert.equal(report.processes[0].model_version, '01.01.021');
    assert.deepEqual(JSON.parse(observed[1]?.body ?? '{}'), {
      p_table: 'processes',
      p_id: 'proc-default-rest',
      p_version: '01.01.000',
      p_json_ordered: makeCanonicalProcess('proc-default-rest'),
      p_model_id: 'model-default-rest',
      p_model_version: '01.01.021',
      p_audit: {
        command: 'tiangong-lca publish run',
        source: 'input',
        bundle_path: null,
      },
    });
    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST', 'GET', 'POST'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish forwards projected Process model references to custom executors', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-process-model-ref-'));
  const requestPath = path.join(dir, 'request.json');
  let observedProcessModel: unknown;

  writeJson(requestPath, {
    inputs: {
      processes: [
        {
          json_ordered: makeCanonicalProcess('proc-projected'),
          metadata: {
            generated_from_lifecyclemodel_id: 'model-projected',
            generated_from_lifecyclemodel_version: '01.01.021',
          },
        },
      ],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        processes: (args) => {
          observedProcessModel = args.processModel;
          return { inserted: true };
        },
      },
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.processes[0].status, 'executed');
    assert.deepEqual(observedProcessModel, {
      modelId: 'model-projected',
      modelVersion: '01.01.021',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish resolves every canonical Process model-reference tier without latest lookup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-process-model-tiers-'));
  const requestPath = path.join(dir, 'request.json');
  const observed = new Map<string, unknown>();
  const projectionPayload = makeCanonicalProcess('proc-projection');
  (projectionPayload as Record<string, unknown>).projectionMetadata = {
    generated_from_lifecyclemodel_id: 'model-projection',
    generated_from_lifecyclemodel_version: '02.00.000',
  };
  const nestedPayload = makeCanonicalProcess('proc-nested');
  const nestedInformation = (
    (nestedPayload.processDataSet as Record<string, unknown>).processInformation as Record<
      string,
      unknown
    >
  ).dataSetInformation as Record<string, unknown>;
  nestedInformation.generatedFromLifecycleModel = {
    id: 'model-nested',
    version: '03.00.000',
  };

  writeJson(requestPath, {
    inputs: {
      processes: [
        {
          json_ordered: makeCanonicalProcess('proc-direct'),
          model_id: 'model-direct',
          model_version: '01.00.000',
        },
        { json_ordered: projectionPayload },
        { json_ordered: nestedPayload },
        {
          json_ordered: makeCanonicalProcess('proc-legacy'),
          modelId: 'model-legacy',
        },
        {
          json_ordered: makeCanonicalProcess('proc-independent'),
          modelId: null,
        },
      ],
    },
    publish: { commit: true },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        processes: (args) => {
          observed.set(args.id, args.processModel);
          return { inserted: true };
        },
      },
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'completed');
    assert.deepEqual(observed.get('proc-direct'), {
      modelId: 'model-direct',
      modelVersion: '01.00.000',
    });
    assert.deepEqual(observed.get('proc-projection'), {
      modelId: 'model-projection',
      modelVersion: '02.00.000',
    });
    assert.deepEqual(observed.get('proc-nested'), {
      modelId: 'model-nested',
      modelVersion: '03.00.000',
    });
    assert.deepEqual(observed.get('proc-legacy'), {
      modelId: 'model-legacy',
      modelVersion: null,
    });
    assert.equal(observed.get('proc-independent'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish rejects Process model versions without model ids', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-invalid-model-ref-'));
  const requestPath = path.join(dir, 'request.json');
  let executorCalls = 0;

  writeJson(requestPath, {
    inputs: {
      processes: [
        {
          json_ordered: makeCanonicalProcess('proc-invalid-model-ref'),
          modelVersion: '01.01.021',
        },
      ],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        processes: () => {
          executorCalls += 1;
          return { inserted: true };
        },
      },
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(executorCalls, 0);
    assert.equal(report.processes[0].status, 'failed');
    assert.match(report.processes[0].error?.message ?? '', /requires modelId/u);
    assert.equal(report.verification.status, 'blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish uses save_lifecycle_model_bundle for lifecyclemodels by default', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-lifecyclemodel-default-'));
  const requestPath = path.join(dir, 'request.json');
  const observed: Array<{ method: string; url: string; body?: string }> = [];

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [
        {
          json_ordered: makeLifecyclemodel('lm-default-rest'),
          json_tg: {
            xflow: {
              nodes: [{ id: 'explicit-node' }],
              edges: [],
            },
          },
          rule_verification: false,
        },
      ],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
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

        if (String(url).includes('/lifecyclemodels?select=')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[]',
          });
        }

        if (String(url).includes('/functions/v1/save_lifecycle_model_bundle')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '{"ok":true,"modelId":"lm-default-rest","version":"01.01.000"}',
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"unexpected"}]',
        });
      }),
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.lifecyclemodels[0].status, 'executed');
    assert.deepEqual(report.lifecyclemodels[0].execution, {
      status: 'success',
      operation: 'create',
      mode: 'create',
      transport: 'save_lifecycle_model_bundle',
      response: {
        ok: true,
        modelId: 'lm-default-rest',
        version: '01.01.000',
      },
    });
    assert.deepEqual(
      observed.map((entry) => entry.method),
      ['GET', 'POST'],
    );
    assert.match(observed[1]?.url ?? '', /\/functions\/v1\/save_lifecycle_model_bundle$/u);
    assert.match(observed[1]?.body ?? '', /"explicit-node"/u);
    assert.match(observed[1]?.body ?? '', /"ruleVerification":false/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish preserves lifecyclemodel metadata aliases from wrapper entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-lifecyclemodel-metadata-'));
  const requestPath = path.join(dir, 'request.json');
  let observedArgs: { metadata?: unknown } | null = null;

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [
        {
          jsonOrdered: makeLifecyclemodel('lm-metadata'),
          jsonTg: {
            xflow: {
              nodes: [{ id: 'camel-node' }],
              edges: [],
            },
          },
          process_mutations: [
            {
              op: 'create',
              id: '11111111-1111-1111-1111-111111111111',
              modelId: 'lm-metadata',
              jsonOrdered: {
                processDataSet: {},
              },
            },
          ],
          ruleVerification: true,
        },
      ],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      executors: {
        lifecyclemodels: async (args) => {
          observedArgs = args as Record<string, unknown>;
          return {
            inserted: true,
          };
        },
      },
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.lifecyclemodels[0].status, 'executed');
    const observedMetadata =
      ((observedArgs as { metadata?: unknown } | null)?.metadata as
        Record<string, unknown> | undefined) ?? {};
    assert.deepEqual(observedMetadata, {
      json_tg: {
        xflow: {
          nodes: [{ id: 'camel-node' }],
          edges: [],
        },
      },
      processMutations: [
        {
          op: 'create',
          id: '11111111-1111-1111-1111-111111111111',
          modelId: 'lm-metadata',
          jsonOrdered: {
            processDataSet: {},
          },
        },
      ],
      ruleVerification: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish passes null lifecyclemodel metadata to the default executor when no wrapper metadata exists', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-lifecyclemodel-null-metadata-'));
  const requestPath = path.join(dir, 'request.json');
  let observedBody = '';

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [makeLifecyclemodel('lm-null-metadata')],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuth(async (url, init) => {
        if (String(url).includes('/lifecyclemodels?select=')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[]',
          });
        }

        observedBody = typeof init?.body === 'string' ? init.body : '';
        return makeResponse({
          ok: true,
          status: 200,
          body: '{"ok":true,"modelId":"lm-null-metadata","version":"01.01.000"}',
        });
      }),
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.lifecyclemodels[0].status, 'executed');
    assert.doesNotMatch(observedBody, /"ruleVerification"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish fails truthfully when a visible process row cannot use the draft save path', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-owner-blocked-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      processes: [makeCanonicalProcess('proc-owner-blocked')],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
        TIANGONG_LCA_ACCESS_TOKEN: 'key',
      }),
      fetchImpl: withSupabaseAuth(async (url) => {
        if (String(url).includes('/processes?select=')) {
          return makeResponse({
            ok: true,
            status: 200,
            body: '[{"id":"proc-owner-blocked","version":"01.01.000","user_id":"other-user","state_code":100}]',
          });
        }

        return makeResponse({
          ok: true,
          status: 200,
          body: '[{"id":"unexpected"}]',
        });
      }),
      now: new Date('2026-03-28T00:00:00Z'),
      validateProcessPayloadImpl: VALIDATION_OK,
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.processes[0].status, 'failed');
    assert.match(report.processes[0].error?.message ?? '', /cannot use save-draft/u);
    assert.match(report.processes[0].error?.message ?? '', /state_code=100/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish skips disabled publish groups and can clear relation manifests', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-disabled-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [{ '@id': 'lm-disabled', '@version': '01.01.000' }],
      processes: [makeCanonicalProcess('proc-disabled')],
      sources: [makeSource('src-disabled')],
      relations: [{ id: 'rel-disabled' }],
      process_build_runs: ['run-disabled'],
    },
    publish: {
      publish_lifecyclemodels: false,
      publish_processes: false,
      publish_sources: false,
      publish_relations: false,
      publish_process_build_runs: false,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.deepEqual(report.lifecyclemodels, []);
    assert.deepEqual(report.processes, []);
    assert.deepEqual(report.sources, []);
    assert.deepEqual(report.process_build_runs, []);
    assert.deepEqual(report.relations.relations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish records non-canonical process errors and process-build-run executor failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-branches-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      process_build_runs: ['run-fail'],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const brokenProcessEntry = {
      toJSON() {
        return { kind: 'broken-process' };
      },
      get processDataSet() {
        throw new Error('broken payload');
      },
    };

    const report = await runPublish({
      inputPath: requestPath,
      rawRequest: {
        inputs: {
          processes: [brokenProcessEntry],
          process_build_runs: ['run-fail'],
        },
        publish: {
          commit: true,
        },
      },
      executors: {
        process_build_runs: () => {
          return Promise.reject('build-run failed');
        },
      },
      now: new Date('2026-03-28T00:00:00Z'),
    });

    assert.equal(report.processes[0].status, 'deferred_projection_payload');
    assert.match(report.processes[0].reason ?? '', /broken payload/u);
    assert.equal(report.process_build_runs[0].status, 'failed');
    assert.match(report.process_build_runs[0].error?.message ?? '', /build-run failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish defers process build runs when commit is true and no executor is provided', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-run-defer-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      process_build_runs: ['run-deferred'],
    },
    publish: {
      commit: true,
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
    });

    assert.equal(report.process_build_runs[0].status, 'deferred_no_executor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish rejects invalid source payloads and unsupported dataset entries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-invalid-'));
  const invalidSourceRequestPath = path.join(dir, 'invalid-source.json');
  const unsupportedEntryRequestPath = path.join(dir, 'unsupported-entry.json');

  writeJson(invalidSourceRequestPath, {
    inputs: {
      sources: [{}],
    },
  });
  writeJson(unsupportedEntryRequestPath, {
    inputs: {
      lifecyclemodels: [0],
    },
  });

  try {
    await assert.rejects(
      async () =>
        runPublish({
          inputPath: invalidSourceRequestPath,
        }),
      /Source payload missing/u,
    );

    await assert.rejects(
      async () =>
        runPublish({
          inputPath: unsupportedEntryRequestPath,
        }),
      /Unsupported dataset entry/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish rejects non-object dataset files and missing lifecyclemodel identities', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-invalid-files-'));
  const invalidDatasetPath = path.join(dir, 'invalid.json');
  const invalidDatasetRequestPath = path.join(dir, 'invalid-dataset-request.json');
  const invalidLifecyclemodelRequestPath = path.join(dir, 'invalid-lifecyclemodel-request.json');

  writeJson(invalidDatasetPath, [1, 2, 3]);
  writeJson(invalidDatasetRequestPath, {
    inputs: {
      sources: ['./invalid.json'],
    },
  });
  writeJson(invalidLifecyclemodelRequestPath, {
    inputs: {
      lifecyclemodels: [
        {
          jsonOrdered: {
            '@version': '01.01.000',
          },
        },
      ],
    },
  });

  try {
    await assert.rejects(
      async () =>
        runPublish({
          inputPath: invalidDatasetRequestPath,
        }),
      /Expected JSON object input/u,
    );

    await assert.rejects(
      async () =>
        runPublish({
          inputPath: invalidLifecyclemodelRequestPath,
        }),
      /Lifecycle model payload missing/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPublish accepts native lifecyclemodel json_ordered payload wrappers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-native-lifecyclemodel-'));
  const requestPath = path.join(dir, 'request.json');

  writeJson(requestPath, {
    inputs: {
      lifecyclemodels: [
        {
          jsonOrdered: {
            lifeCycleModelDataSet: {
              lifeCycleModelInformation: {
                dataSetInformation: {
                  'common:UUID': 'lm-native-1',
                  referenceToResultingProcess: {
                    '@refObjectId': 'lm-native-1-result',
                  },
                },
                quantitativeReference: {
                  referenceToReferenceProcess: '1',
                },
              },
              administrativeInformation: {
                publicationAndOwnership: {
                  'common:dataSetVersion': '02.03.004',
                },
              },
            },
          },
        },
      ],
    },
  });

  try {
    const report = await runPublish({
      inputPath: requestPath,
    });

    assert.equal(report.lifecyclemodels.length, 1);
    assert.equal(report.lifecyclemodels[0].status, 'prepared');
    assert.equal(report.lifecyclemodels[0].id, 'lm-native-1');
    assert.equal(report.lifecyclemodels[0].version, '02.03.004');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
