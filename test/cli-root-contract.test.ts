import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { normalizeRootArguments, usesTaskEnvironment } from '../src/commands/root-arguments.js';
import { commandFailure } from '../src/shared/command-errors.js';
import { CommandInputError } from '../src/shared/command-result.js';
import { CliError } from '../src/shared/errors.js';

const deps = {
  env: {},
  dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
  fetchImpl: async () => {
    throw new Error('help must not fetch');
  },
};

test('outer JSON and separator normalization never rewrites a child argument stream', () => {
  assert.deepEqual(normalizeRootArguments([]), []);
  assert.deepEqual(normalizeRootArguments(['--', '--', 'auth', 'login']), [
    '--',
    '--',
    'auth',
    'login',
  ]);
  assert.deepEqual(normalizeRootArguments(['--json']), ['--json']);
  assert.deepEqual(normalizeRootArguments(['--', 'runtime', 'describe']), ['runtime', 'describe']);
  assert.deepEqual(normalizeRootArguments(['--json', 'runtime', 'exec', '--', 'child', '--help']), [
    'runtime',
    'exec',
    '--json',
    '--',
    'child',
    '--help',
  ]);
  assert.equal(usesTaskEnvironment(['--json', 'runtime', 'describe']), false);
  assert.equal(usesTaskEnvironment(['--help', '--', 'runtime']), false);
  assert.equal(usesTaskEnvironment(['--version', 'pcr']), false);
  assert.equal(usesTaskEnvironment(['--json', 'pcr', 'snapshot', 'status']), false);
  assert.equal(usesTaskEnvironment(['--json', 'doctor']), true);
  assert.equal(usesTaskEnvironment([]), true);
});

test('core and retained help accept outer JSON without changing specialized output protocols', async () => {
  for (const name of [
    'doctor',
    'auth',
    'dataset',
    'review',
    'study',
    'runtime',
    'pcr',
    'release',
  ]) {
    const plain = await executeCli([name, '--help', '--json'], deps);
    const prefix = await executeCli(['--json', name, '--help'], deps);
    assert.deepEqual(prefix, plain, name);
    assert.equal(prefix.exitCode, 0, name);
    assert.equal(prefix.stderr, '', name);
  }
  const root = JSON.parse((await executeCli(['--help', '--json'], deps)).stdout);
  assert.equal(root.outputProtocols.core.machineHelp, true);
  for (const name of ['study', 'runtime', 'pcr', 'release'])
    assert.equal(root.outputProtocols[name].machineHelp, false);
  assert.equal((await executeCli(['--', 'study', '--help'], deps)).exitCode, 0);
});

test('error category is explicit and never inferred from a new code substring', () => {
  assert.equal(
    commandFailure(new CommandInputError('CUSTOM_CONFLICT_TEXT', 'selection', 'input'), 'FAILED')
      .category,
    'input',
  );
  assert.equal(
    commandFailure(new CommandInputError('NOT_A_CODE_PATTERN', 'stale', 'conflict'), 'FAILED')
      .exitCode,
    1,
  );
  assert.equal(
    commandFailure(new CliError('private', { code: 'CUSTOM_AUTH_TEXT', exitCode: 1 }), 'FAILED')
      .category,
    'service',
  );
  assert.equal(
    commandFailure(new CliError('private', { code: 'BAD_ARGUMENT', exitCode: 2 }), 'FAILED')
      .category,
    'input',
  );
});
