import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runDatasetProcessCommand } from '../src/commands/dataset-process.js';
import { getProcess, validateProcess, type ProcessPorts } from '../src/application/process.js';
import { createProcessPorts } from '../src/adapters/process.js';
import { result } from '../src/shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../src/shared/command-presentation.js';
import { readCommandInput, writeCommandOutput } from '../src/shared/command-files.js';
import { executeCli } from '../src/cli.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { ProcessPayloadValidationResult } from '../src/lib/process-payload-validation.js';

const content = { processDataSet: {} };
const validation: ProcessPayloadValidationResult = {
  ok: true,
  validator: 'test',
  issue_count: 0,
  issues: [],
};
function ports(overrides: Partial<ProcessPorts> = {}): ProcessPorts {
  return {
    now: () => '2026-11-08T00:00:00.000Z',
    get: async (id, version) => ({
      id,
      version: version === 'latest' ? '02' : version,
      content,
      modifiedAt: null,
      stateCode: 0,
      environment: 'https://example.test',
    }),
    validate: () => validation,
    ...overrides,
  };
}
function temporary(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-foundation-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
const data = (value: { stdout: string }) => JSON.parse(value.stdout);

test('new process command discovers only implemented actions without effects', async () => {
  const noEffects = ports({
    get: () => {
      throw new Error('network');
    },
    validate: () => {
      throw new Error('validation');
    },
  });
  for (const args of [
    [],
    ['--help'],
    ['--json'],
    ['--help', '--json'],
    ['get', '--help'],
    ['validate', '--help', '--json'],
  ]) {
    const response = await runDatasetProcessCommand(args, noEffects);
    assert.equal(response.exitCode, 0);
    assert.deepEqual(data(response).implementedActions, ['get', 'validate']);
  }
});

test('get preserves exact identity, explicit latest resolution, and missing targets', async () => {
  for (const version of ['01', 'latest']) {
    const response = await runDatasetProcessCommand(
      ['get', '--id', 'p', '--version', version, '--json'],
      ports(),
    );
    assert.equal(response.exitCode, 0);
    assert.equal(data(response).data.subject.version, version === 'latest' ? '02' : '01');
    assert.deepEqual(data(response).data.content, content);
    assert.ok(existsSync(data(response).replyTemplate));
  }
  const missing = await runDatasetProcessCommand(
    ['get', '--id', 'p', '--version', '01', '--json'],
    ports({ get: async () => null }),
  );
  assert.equal(missing.exitCode, 1);
  assert.equal(data(missing).outcome, 'not_found_or_not_visible');
  await assert.rejects(
    getProcess(
      'p',
      '01',
      ports({
        get: async () => ({
          id: 'other',
          version: '',
          modifiedAt: null,
          stateCode: null,
          content,
          environment: '',
        }),
      }),
    ),
    /different identity/,
  );
});

test('arguments fail before effects, with one safe JSON envelope', async () => {
  const cases = [
    ['--help', '--oops'],
    ['save'],
    ['get', '--unknown'],
    ['get', '--id', 'p', '--id', 'q'],
    ['get', '--id'],
    ['get', '--force'],
    ['get', '--output', ''],
    ['get', '--version', '01'],
    ['get', '--id', 'p'],
    ['get', '--id', ' ', '--version', '01'],
    ['validate'],
    ['validate', '--checks', 'references'],
    ['validate', '--checks='],
    ['validate', '--version', '01'],
  ];
  for (const args of cases) {
    const response = await runDatasetProcessCommand(
      [...args, '--json'],
      ports({
        get: () => {
          throw new Error('side effect');
        },
      }),
    );
    assert.equal(response.exitCode, 2, args.join(' '));
    assert.equal(data(response).status, 'failed');
    assert.equal(response.stderr, '');
    assert.ok(!response.stdout.includes('side effect'));
  }
  const response = await runDatasetProcessCommand(
    ['get', '--id', 'p', '--version', '01', '--json'],
    ports({
      get: async () => {
        throw new Error('Authorization: secret');
      },
    }),
  );
  assert.equal(response.exitCode, 1);
  assert.ok(!response.stdout.includes('secret'));
});

test('validation reuses result truth and bounds findings without losing complete report', async (t) => {
  const dir = temporary(t);
  const input = path.join(dir, 'process.json');
  const output = path.join(dir, 'report.json');
  writeFileSync(input, JSON.stringify(content));
  const good = await runDatasetProcessCommand(['validate', '--input', input, '--json'], ports());
  assert.equal(good.exitCode, 0);
  assert.deepEqual(data(good).context.defaultedInputs.checks, ['schema', 'business']);
  const issues = Array.from({ length: 8 }, (_, i) => ({
    path: String(i),
    message: 'invalid',
    code: 'field',
  }));
  const badPorts = ports({
    validate: () => ({
      ok: false,
      validator: 'test',
      issue_count: 8,
      issues,
      validation_layers: Object.fromEntries(
        ['schema', 'authoring_evidence', 'content', 'multilingual'].map((name) => [
          name,
          { status: 'failed', issue_count: 8, issues },
        ]),
      ) as NonNullable<ProcessPayloadValidationResult['validation_layers']>,
    }),
  });
  const bad = await runDatasetProcessCommand(
    ['validate', '--input', input, '--checks', 'schema,business', '--json'],
    badPorts,
  );
  assert.equal(bad.exitCode, 1);
  assert.equal(data(bad).status, 'completed');
  assert.equal(data(bad).data.validation.status, 'failed');
  assert.equal(data(bad).data.validation.issues.length, 5);
  assert.equal(data(bad).nextActions.length, 1);
  assert.equal(data(bad).data.validation.validation_layers.schema.issues, undefined);
  const saved = await runDatasetProcessCommand(
    ['validate', '--input', input, '--output', output, '--json'],
    badPorts,
  );
  assert.equal(saved.exitCode, 1);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).issues.length, 8);
  assert.equal(data(saved).nextActions.length, 0);
  const unresolved = validateProcess(
    content,
    ports({
      validate: () => ({
        ok: false,
        validator: 'test',
        issue_count: 0,
        issues: [],
        allocation_semantics: { status: 'unresolved' } as NonNullable<
          ProcessPayloadValidationResult['allocation_semantics']
        >,
      }),
    }),
  );
  assert.equal(unresolved.outcome, 'validation_incomplete');
  for (const value of [{}, { processDataSet: [] }, { processDataSet: 'x' }])
    assert.throws(() => validateProcess(value, ports()), /canonical Process/);
});

test('file IO never overwrites input or existing output without explicit force', async (t) => {
  const dir = temporary(t);
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'nested', 'output.json');
  writeFileSync(input, JSON.stringify(content));
  const saved = await runDatasetProcessCommand(
    ['get', '--id', 'p', '--version', '01', '--output', output, '--json'],
    ports(),
  );
  assert.equal(saved.exitCode, 0);
  assert.equal(data(saved).data.content, undefined);
  assert.deepEqual(readCommandInput(output), content);
  assert.throws(() => writeCommandOutput(output, {}, false), /Could not write/);
  writeCommandOutput(output, { replaced: true }, true);
  assert.equal(readCommandInput(output).replaced, true);
  assert.throws(() => writeCommandOutput(input, {}, true, input), /must not replace/);
  const hardlink = path.join(dir, 'hardlink.json');
  linkSync(input, hardlink);
  assert.throws(() => writeCommandOutput(hardlink, {}, true, input), /must not replace/);
  writeCommandOutput(path.join(dir, 'other.json'), {}, false, input);
  writeCommandOutput(path.join(dir, 'stdin-output.json'), {}, false, '-');
  assert.throws(() => readCommandInput(path.join(dir, 'missing')), /readable JSON/);
  for (const value of ['broken', 'null', '[]', '"string"']) {
    const invalid = path.join(dir, 'invalid.json');
    writeFileSync(invalid, value);
    assert.throws(() => readCommandInput(invalid));
  }
  const stdinReader = (input: string) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { readCommandInput } from './src/shared/command-files.ts'; process.stdout.write(JSON.stringify(readCommandInput('-')));",
      ],
      { input, encoding: 'utf8' },
    );
  const fromStdin = stdinReader(JSON.stringify(content));
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.deepEqual(JSON.parse(fromStdin.stdout), content);
  const invalidStdin = stdinReader('{}\n{}');
  assert.equal(invalidStdin.status, 1);
  assert.match(invalidStdin.stderr, /INPUT_INVALID_JSON/);
});

test('missing template leaves business result intact and human rendering uses same facts', (t) => {
  const value = result('dataset process get');
  value.summary = 'Completed';
  value.data.subject = { id: 'p' };
  value.artifacts.push({ path: '/tmp/example', purpose: 'report', bytes: 1 });
  value.nextActions = [
    { description: 'inspect' },
    { description: 'help', command: 'tiangong-lca dataset process --help' },
  ];
  attachReplyTemplate(value, 'query-result', temporary(t));
  assert.equal(value.status, 'completed');
  assert.equal(value.replyTemplate, null);
  assert.equal(value.warnings[0]?.code, 'REPLY_TEMPLATE_UNAVAILABLE');
  const rendered = renderResult(value, false, 0);
  assert.match(rendered.stdout, /Completed/);
  assert.match(rendered.stdout, /inspect/);
});

test('adapter exact read performs no latest fallback; local validator performs no network', async () => {
  const urls: string[] = [];
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'test-secret',
  });
  const adapter = createProcessPorts(env, async (url) => {
    if (isSupabaseAuthTokenUrl(String(url))) return makeSupabaseAuthResponse();
    urls.push(String(url));
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(await adapter.get('p', '01'), null);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /version=eq.01/);
  const found = createProcessPorts(env, async (url) =>
    isSupabaseAuthTokenUrl(String(url))
      ? makeSupabaseAuthResponse()
      : new Response(
          JSON.stringify([
            { id: 'p', version: '02', json: content, modified_at: null, state_code: 0 },
          ]),
          { headers: { 'content-type': 'application/json' } },
        ),
  );
  assert.equal((await found.get('p', 'latest'))?.version, '02');
  assert.ok(found.now());
  const checked = adapter.validate(content);
  assert.equal(checked.ok, false);
  assert.equal(urls.length, 1);
  const dispatched = await executeCli(['dataset', 'process', 'get', '--help', '--json'], {
    env: {},
    dotEnvStatus: { loaded: false, path: '', count: 0 },
    fetchImpl: adapter.get as never,
  });
  assert.equal(dispatched.exitCode, 0);
  assert.deepEqual(data(dispatched).implementedActions, ['get', 'validate']);
});

test('new layers keep application pure and installed sample works outside repository', (t) => {
  const application = readFileSync('src/application/process.ts', 'utf8');
  assert.doesNotMatch(application, /from ['"](?:node:|\.\.\/(?:commands|adapters)\/)/);
  const dir = temporary(t);
  const installed = path.join(dir, 'package');
  cpSync('dist/src', path.join(installed, 'dist', 'src'), { recursive: true });
  cpSync('assets', path.join(installed, 'assets'), { recursive: true });
  cpSync('package.json', path.join(installed, 'package.json'));
  cpSync('bin', path.join(installed, 'bin'), { recursive: true });
  symlinkSync(
    path.resolve('node_modules'),
    path.join(installed, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const entry = path.join(installed, 'bin', 'tiangong-lca.js');
  const child = spawnSync(
    process.execPath,
    [entry, 'dataset', 'process', 'validate', '--input', '-', '--json'],
    { cwd: dir, input: JSON.stringify(content), encoding: 'utf8' },
  );
  assert.equal(child.status, 1, child.stderr);
  assert.ok(child.stdout, child.stderr);
  const reply = JSON.parse(child.stdout);
  assert.equal(reply.status, 'completed');
  assert.ok(reply.replyTemplate.startsWith(realpathSync(installed)));
  assert.ok(existsSync(reply.replyTemplate));
});
