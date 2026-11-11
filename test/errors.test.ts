import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule } from './helpers/load-dist-module.js';
import { CliError, toErrorPayload } from '../src/shared/errors.js';

async function loadDistErrorsModule(): Promise<typeof import('../src/shared/errors.js')> {
  return loadDistModule('src/shared/errors.js');
}

test('CliError stores code, exitCode, and details', () => {
  const error = new CliError('boom', {
    code: 'DEMO',
    exitCode: 7,
    details: { reason: 'x' },
  });

  assert.equal(error.code, 'DEMO');
  assert.equal(error.exitCode, 7);
  assert.deepEqual(error.details, { reason: 'x' });
});

test('CliError uses default code and exitCode when omitted', () => {
  const error = new CliError('boom');
  assert.equal(error.code, 'CLI_ERROR');
  assert.equal(error.exitCode, 1);
});

test('toErrorPayload handles CliError, Error, and unknown values', () => {
  assert.deepEqual(toErrorPayload(new CliError('boom', { code: 'DEMO' })), {
    error: {
      code: 'DEMO',
      message: 'boom',
    },
  });

  assert.deepEqual(
    toErrorPayload(new CliError('boom', { code: 'DEMO', details: { reason: 'x' } })),
    {
      error: {
        code: 'DEMO',
        message: 'boom',
        details: { reason: 'x' },
      },
    },
  );

  assert.deepEqual(toErrorPayload(new Error('bad')), {
    error: {
      code: 'UNEXPECTED_ERROR',
      message: 'bad',
    },
  });

  assert.deepEqual(toErrorPayload('weird'), {
    error: {
      code: 'UNKNOWN_THROWN_VALUE',
      message: 'weird',
    },
  });
});

test('error helpers behave the same from the built dist module', async () => {
  const errors = await loadDistErrorsModule();

  assert.deepEqual(errors.toErrorPayload(new errors.CliError('boom', { code: 'DIST_ERROR' })), {
    error: {
      code: 'DIST_ERROR',
      message: 'boom',
    },
  });
});
