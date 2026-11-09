import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

const makeDeps = (overrides?: Partial<NodeJS.ProcessEnv>) => ({
  env: buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    TIANGONG_LCA_REGION: 'us-east-1',
    ...overrides,
  }),
  dotEnvStatus,
  fetchImpl: (async (input) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    };
  }) as FetchLike,
});

test('executeCli prints main help when no command is given', async () => {
  const result = await executeCli([], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
  assert.match(result.stdout, /Implemented Commands:/u);
  assert.match(
    result.stdout,
    /dataset\s+<flow\|process\|model\|source\|contact\|flowproperty\|unitgroup\|lciamethod>/u,
  );
  assert.match(result.stdout, /review\s+submit \| resubmit \| get \| list/u);
  assert.match(result.stdout, /Runtime support:/u);
  assert.doesNotMatch(
    result.stdout,
    /Retained compatibility entrypoints:|auto-build|maintenance clear-account/u,
  );
  assert.doesNotMatch(result.stdout, /auto-build|maintenance clear-account|curation-queue/u);
  assert.equal(result.stderr, '');
});

test('executeCli main help reports loaded dotenv metadata when available', async () => {
  const result = await executeCli([], {
    ...makeDeps(),
    dotEnvStatus: {
      loaded: true,
      path: '/tmp/.env',
      count: 2,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\.env loaded: yes \(/u);
});

test('executeCli prints version', async () => {
  const result = await executeCli(['--version'], makeDeps());
  assert.equal(result.exitCode, 0);
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  assert.equal(result.stdout, `${packageJson.version}\n`);
});

test('executeCli returns doctor text and success status', async () => {
  const result = await executeCli(['doctor'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /TianGong CLI doctor/u);
  assert.match(result.stdout, /\[OK /u);
});

test('executeCli doctor reports loaded dotenv metadata and incomplete custom configuration', async () => {
  const result = await executeCli(['doctor'], {
    env: {
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
    } as NodeJS.ProcessEnv,
    dotEnvStatus: {
      loaded: true,
      path: '/tmp/.env',
      count: 1,
    },
    fetchImpl: makeDeps().fetchImpl,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /\.env loaded: yes \(1 keys\)/u);
  assert.match(result.stdout, /Missing required environment keys:/u);
});

test('executeCli returns doctor help without falling back to main help', async () => {
  const result = await executeCli(['doctor', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tiangong-lca doctor \[--json\]/u);
  assert.doesNotMatch(result.stdout, /Unified TianGong command entrypoint/u);
});

test('executeCli returns doctor json and failure status when required env is missing', async () => {
  const result = await executeCli(
    ['doctor', '--json'],
    makeDeps({
      TIANGONG_LCA_API_BASE_URL: '',
      TIANGONG_LCA_ACCESS_TOKEN: '',
    }),
  );
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.configuration.ok, false);
  assert.equal(payload.status, 'failed');
});

test('executeCli returns remote help for admin embedding-run', async () => {
  const result = await executeCli(['admin', 'embedding-run', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tiangong-lca admin embedding-run/u);
});

test('executeCli executes admin embedding-run dry-run with default region fallback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-admin-dry-run-'));
  const inputPath = path.join(dir, 'jobs.json');
  writeFileSync(inputPath, '[{"jobId":1}]', 'utf8');

  try {
    const result = await executeCli(
      ['admin', 'embedding-run', '--dry-run', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_REGION: undefined,
      }),
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /embedding_ft/u);
    assert.doesNotMatch(result.stdout, /x-region/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli surfaces missing admin API configuration after exhausting all fallbacks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-admin-missing-config-'));
  const inputPath = path.join(dir, 'jobs.json');
  writeFileSync(inputPath, '[{"jobId":1}]', 'utf8');

  try {
    const result = await executeCli(
      ['admin', 'embedding-run', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_API_BASE_URL: undefined,
        TIANGONG_LCA_ACCESS_TOKEN: '',
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: undefined,
        TIANGONG_LCA_REGION: undefined,
      }),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /SUPABASE_REST_ENV_REQUIRED/u);
    assert.match(result.stderr, /TIANGONG_LCA_API_BASE_URL/u);
    assert.match(result.stderr, /TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns parsing errors for invalid doctor flags', async () => {
  const result = await executeCli(['doctor', '--bad-flag'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /doctor --help --json/u);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /malformed doctor option/u);
});

test('executeCli executes validation run with injected implementation and report file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-cli-'));

  try {
    const result = await executeCli(
      [
        'validation',
        'run',
        '--json',
        '--input-dir',
        dir,
        '--engine',
        'sdk',
        '--report-file',
        './validation-report.json',
      ],
      {
        ...makeDeps(),
        runValidationImpl: async (options) => {
          assert.equal(options.inputDir, dir);
          assert.equal(options.engine, 'sdk');
          assert.equal(options.reportFile, './validation-report.json');
          return {
            input_dir: dir,
            mode: 'sdk',
            ok: false,
            summary: {
              engine_count: 1,
              ok_count: 0,
              failed_count: 1,
            },
            files: {
              report: path.join(dir, 'validation-report.json'),
            },
            reports: [],
            comparison: null,
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"mode":"sdk"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns success for validation reports that are ok', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-cli-ok-'));

  try {
    const result = await executeCli(['validation', 'run', '--input-dir', dir], {
      ...makeDeps(),
      runValidationImpl: async () => ({
        input_dir: dir,
        mode: 'auto',
        ok: true,
        summary: {
          engine_count: 1,
          ok_count: 1,
          failed_count: 0,
        },
        files: {
          report: null,
        },
        reports: [],
        comparison: null,
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"ok": true/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli rejects unknown root options', async () => {
  const result = await executeCli(['--unknown-root-option'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /UNKNOWN_ROOT_OPTION/u);
});

test('executeCli discovers Review separately from QA and rejects obsolete QA aliases', async () => {
  const root = await executeCli(['review', '--help', '--json'], makeDeps());
  assert.equal(root.exitCode, 0);
  assert.deepEqual(JSON.parse(root.stdout).implementedActions, [
    'submit',
    'resubmit',
    'get',
    'list',
    'materials',
    'comment',
    'decide',
  ]);
  for (const type of ['process', 'flow', 'lifecyclemodel']) {
    const reply = await executeCli(['review', type, '--help', '--json'], makeDeps());
    assert.equal(reply.exitCode, 2);
    assert.equal(JSON.parse(reply.stdout).error.code, 'CAPABILITY_UNSUPPORTED');
  }
});

test('executeCli prints main help when root help appears before the command', async () => {
  const result = await executeCli(['--help', 'search', 'flow'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
});

test('executeCli supports root argument separator before the command', async () => {
  const result = await executeCli(['--', 'doctor', '--json'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).data.configuration.ok, true);
});

test('executeCli prints main help for the explicit help command', async () => {
  const result = await executeCli(['help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
});
