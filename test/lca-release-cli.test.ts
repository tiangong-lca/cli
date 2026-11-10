import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCli } from '../src/cli.js';
import type { DotEnvLoadResult } from '../src/lib/config/dotenv.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import type { LcaReleaseReport, RunLcaReleaseOptions } from '../src/lib/release/lca-release.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

function report(action: RunLcaReleaseOptions['action']): LcaReleaseReport {
  return {
    schemaVersion: 'tiangong.cli.lca-release.v1',
    action,
    status: 'completed',
    complete: true,
    summary: { status: 'ready_for_approval' },
    warnings: [],
    nextCommands: ['tiangong-lca release approve --input ./approval.json'],
  };
}

function deps(runLcaReleaseImpl?: (options: RunLcaReleaseOptions) => Promise<LcaReleaseReport>) {
  return {
    env: buildSupabaseTestEnv(),
    dotEnvStatus,
    fetchImpl: (async () => {
      throw new Error('unexpected fetch');
    }) as FetchLike,
    ...(runLcaReleaseImpl ? { runLcaReleaseImpl } : {}),
  };
}

test('release namespace and action help explain workflow, output, auth, and next use', async () => {
  const namespace = await executeCli(['release'], deps());
  assert.equal(namespace.exitCode, 0);
  assert.match(namespace.stdout, /prepare/u);
  assert.match(namespace.stdout, /upload/u);
  assert.match(namespace.stdout, /finalize/u);
  assert.match(namespace.stdout, /data_product_manager/u);
  assert.match(namespace.stdout, /--output/u);
  assert.match(namespace.stdout, /Calculation Bundle/u);

  const action = await executeCli(['release', 'publish', '--help'], deps());
  assert.equal(action.exitCode, 0);
  assert.match(action.stdout, /credential fingerprint is derived locally/u);
});

test('release JSON dispatch forwards every explicit flag and environment override', async () => {
  const observed: RunLcaReleaseOptions[] = [];
  const result = await executeCli(
    [
      'release',
      'calculation-artifact',
      '--input',
      './input.json',
      '--output',
      './chunk.gz',
      '--release-run-id',
      'run-id',
      '--package-id',
      'package-id',
      '--artifact-id',
      'artifact-id',
      '--artifact-path',
      'chunks/lci.jsonl.gz',
      '--base-url',
      'https://override.example/functions/v1',
      '--timeout-ms',
      '1234',
      '--dry-run',
      '--force',
      '--json',
    ],
    deps(async (options) => {
      observed.push(options);
      return report(options.action);
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).action, 'calculation-artifact');
  assert.equal(observed[0].timeoutMs, 1234);
  assert.equal(observed[0].dryRun, true);
  assert.equal(observed[0].force, true);
  assert.equal(observed[0].artifactPath, 'chunks/lci.jsonl.gz');
  assert.equal(observed[0].env.TIANGONG_LCA_API_BASE_URL, 'https://override.example/functions/v1');
});

test('release human dispatch uses defaults and keeps next action readable', async () => {
  const observed: RunLcaReleaseOptions[] = [];
  const result = await executeCli(
    ['release', 'current'],
    deps(async (options) => {
      observed.push(options);
      return report(options.action);
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Summary:/u);
  assert.match(result.stdout, /Next:/u);
  assert.equal(observed[0].timeoutMs, 60_000);
  assert.equal(observed[0].inputPath, null);
  assert.equal(
    observed[0].env.TIANGONG_LCA_API_BASE_URL,
    'https://example.supabase.co/functions/v1',
  );
});

test('release dispatch uses the real implementation for a masked dry-run', async () => {
  const result = await executeCli(['release', 'current', '--dry-run', '--json'], deps());
  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as LcaReleaseReport;
  assert.equal(payload.status, 'planned');
  assert.equal((payload.request?.headers as Record<string, string>).Authorization, 'Bearer ****');
});

test('release parser returns actionable errors for unsupported actions and bad flags', async () => {
  const unsupported = await executeCli(['release', 'unknown'], deps());
  assert.equal(unsupported.exitCode, 2);
  assert.equal(JSON.parse(unsupported.stderr).error.code, 'LCA_RELEASE_ACTION_UNSUPPORTED');

  const unknownFlag = await executeCli(['release', 'current', '--unknown'], deps());
  assert.equal(unknownFlag.exitCode, 2);
  assert.equal(JSON.parse(unknownFlag.stderr).error.code, 'INVALID_ARGS');

  for (const timeout of ['0', 'not-a-number']) {
    const invalidTimeout = await executeCli(
      ['release', 'current', '--timeout-ms', timeout],
      deps(),
    );
    assert.equal(invalidTimeout.exitCode, 2);
    assert.equal(JSON.parse(invalidTimeout.stderr).error.code, 'INVALID_TIMEOUT');
  }
});
