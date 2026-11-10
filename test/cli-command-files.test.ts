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
import { runDatasetCommand } from '../src/commands/dataset.js';
import type { DatasetPorts } from '../src/application/dataset-types.js';
import { result } from '../src/shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../src/shared/command-presentation.js';
import { readCommandInput, writeCommandOutput } from '../src/shared/command-files.js';
const content = { processDataSet: {} };
function temporary(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-foundation-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
const data = (value: { stdout: string }) => JSON.parse(value.stdout);
function ports(): DatasetPorts {
  return {
    now: () => '2026-11-08T00:00:00Z',
    read: async () => ({
      records: [
        {
          type: 'process',
          id: 'p',
          version: '01',
          content,
          owner: null,
          stateCode: 0,
          modifiedAt: null,
        },
      ],
      total: 1,
      environment: 'https://example.test',
    }),
    contract: async () => ({}),
    validate: async () => ({ status: 'passed', issues: [] }),
    search: async () => ({}),
    operations: async () => ({}),
    mutate: async () => result('dataset process save'),
  };
}
const runDatasetProcessCommand = (args: string[], dependencies: DatasetPorts) =>
  runDatasetCommand(['process', ...args], dependencies);
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

test('new layers keep application pure and installed sample works outside repository', (t) => {
  const application = readFileSync('src/application/dataset-discovery.ts', 'utf8');
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
