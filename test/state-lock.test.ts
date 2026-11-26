import assert from 'node:assert/strict';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  StateLockTimeoutError,
  isProcessAlive,
  lockPathForState,
  readStateLockMetadata,
  withStateFileLock,
} from '../src/lib/locks/state-lock.js';

const require = createRequire(import.meta.url);
const mutableFs = require('node:fs') as typeof import('node:fs');
const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;

function createErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('lockPathForState and readStateLockMetadata handle missing, empty, invalid, primitive, and valid lock files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-metadata-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);

  try {
    assert.equal(lockPath, `${statePath}.lock`);
    assert.equal(readStateLockMetadata(lockPath), null);

    writeFileSync(lockPath, '\n', 'utf8');
    assert.equal(readStateLockMetadata(lockPath), null);

    writeFileSync(lockPath, 'not-json', 'utf8');
    assert.deepEqual(readStateLockMetadata(lockPath), { raw: 'not-json' });

    writeFileSync(lockPath, '"primitive"', 'utf8');
    assert.equal(readStateLockMetadata(lockPath), null);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ ownerPid: process.pid, reason: 'demo', ownerHost: 'host', updatedAt: 'now' })}\n`,
      'utf8',
    );
    assert.deepEqual(readStateLockMetadata(lockPath), {
      ownerPid: process.pid,
      reason: 'demo',
      ownerHost: 'host',
      updatedAt: 'now',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readStateLockMetadata treats a concurrently removed lock as absent and rethrows other read failures', () => {
  const originalReadFileSync = mutableFs.readFileSync;
  let readErrorCode = 'ENOENT';
  mutableFs.readFileSync = (() => {
    throw createErrnoError(readErrorCode, 'synthetic lock metadata read race');
  }) as typeof mutableFs.readFileSync;
  syncBuiltinESMExports();

  try {
    assert.equal(readStateLockMetadata('/synthetic/session.json.lock'), null);
    readErrorCode = 'EACCES';
    assert.throws(
      () => readStateLockMetadata('/synthetic/session.json.lock'),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'EACCES');
        return true;
      },
    );
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
});

test('isProcessAlive distinguishes current, missing, and invalid processes', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999_999), false);
  assert.equal(isProcessAlive(Number.NaN), true);
});

test('withStateFileLock acquires, writes metadata, supports reentrancy, and releases the lock file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-basic-'));
  const statePath = path.join(dir, 'cache', 'state.json');
  const observations: string[] = [];

  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: 'outer',
        host: 'unit-host',
        pid: 12345,
        now: new Date('2026-03-28T09:00:00.000Z'),
      },
      async () => {
        const lockPath = lockPathForState(statePath);
        observations.push(readFileSync(lockPath, 'utf8'));

        return withStateFileLock(
          statePath,
          {
            reason: 'inner',
          },
          () => {
            observations.push('inner');
            return 'locked';
          },
        );
      },
    );

    assert.equal(result, 'locked');
    assert.equal(observations[1], 'inner');
    assert.match(observations[0], /"ownerPid": 12345/u);
    assert.equal(readStateLockMetadata(lockPathForState(statePath)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock removes stale lock files before acquiring', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-stale-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);

  writeFileSync(
    lockPath,
    `${JSON.stringify({ ownerPid: 999_999_999, ownerHost: 'old-host', reason: 'stale', updatedAt: 'old' })}\n`,
    'utf8',
  );

  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: 'fresh',
        timeoutMs: 50,
        pollMs: 10,
      },
      () => 'recovered',
    );

    assert.equal(result, 'recovered');
    assert.equal(readStateLockMetadata(lockPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock waits for a live owner, clamps pollMs, and retries acquisition', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-retry-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const sleepCalls: number[] = [];

  writeFileSync(
    lockPath,
    `${JSON.stringify({ ownerPid: process.pid, ownerHost: 'live-host', reason: 'busy', updatedAt: 'now' })}\n`,
    'utf8',
  );

  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: 'retry',
        timeoutMs: 100,
        pollMs: 1,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          unlinkSync(lockPath);
        },
      },
      () => 'acquired',
    );

    assert.equal(result, 'acquired');
    assert.deepEqual(sleepCalls, [10]);
    assert.equal(readStateLockMetadata(lockPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock rejects timer delays above the Node maximum before acquisition', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-timer-limit-'));
  const statePath = path.join(dir, 'state.json');
  let taskCalls = 0;
  let sleepCalls = 0;
  try {
    for (const timing of [
      { timeoutMs: NODE_MAX_TIMER_DELAY_MS + 1 },
      { pollMs: NODE_MAX_TIMER_DELAY_MS + 1 },
    ]) {
      await assert.rejects(
        withStateFileLock(
          statePath,
          {
            reason: 'timer-limit',
            ...timing,
            sleep: async () => {
              sleepCalls += 1;
            },
          },
          () => {
            taskCalls += 1;
            return 'never';
          },
        ),
        /maximum supported timer delay/iu,
      );
    }
    assert.equal(taskCalls, 0);
    assert.equal(sleepCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock rejects non-finite and fractional timer values before acquisition', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-invalid-timer-'));
  const statePath = path.join(dir, 'state.json');
  let taskCalls = 0;
  try {
    for (const timing of [
      { timeoutMs: Number.NaN },
      { timeoutMs: 1.5 },
      { pollMs: Number.NaN },
      { pollMs: 1.5 },
    ]) {
      await assert.rejects(
        withStateFileLock(
          statePath,
          {
            reason: 'invalid-timer',
            ...timing,
          },
          () => {
            taskCalls += 1;
            return 'never';
          },
        ),
        /finite safe integer/iu,
      );
    }
    assert.equal(taskCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock uses the default sleep path when retrying a live lock', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-default-sleep-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);

  writeFileSync(
    lockPath,
    `${JSON.stringify({ ownerPid: process.pid, ownerHost: 'live-host', reason: 'busy', updatedAt: 'now' })}\n`,
    'utf8',
  );

  const releaseTimer = setTimeout(() => {
    unlinkSync(lockPath);
  }, 5);

  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: 'default-sleep',
        timeoutMs: 100,
        pollMs: 10,
      },
      () => 'acquired-with-default-sleep',
    );

    assert.equal(result, 'acquired-with-default-sleep');
    assert.equal(readStateLockMetadata(lockPath), null);
  } finally {
    clearTimeout(releaseTimer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock throws StateLockTimeoutError when another live owner keeps the lock', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-timeout-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const fd = openSync(lockPath, 'w');

  writeFileSync(
    fd,
    `${JSON.stringify({ ownerPid: process.pid, ownerHost: 'live-host', reason: 'busy', updatedAt: 'now' })}\n`,
    'utf8',
  );

  try {
    await assert.rejects(
      () =>
        withStateFileLock(
          statePath,
          {
            reason: 'contender',
            timeoutMs: 0,
          },
          () => 'never',
        ),
      (error: unknown) => {
        assert.equal(error instanceof StateLockTimeoutError, true);
        assert.match(String(error), /Timed out after \d+ms acquiring state lock/u);
        return true;
      },
    );
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock times out after waiting when a live owner never releases the lock', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-timeout-after-wait-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const originalDateNow = Date.now;

  writeFileSync(
    lockPath,
    `${JSON.stringify({ ownerPid: process.pid, ownerHost: 'live-host', reason: 'busy', updatedAt: 'now' })}\n`,
    'utf8',
  );

  Date.now = () => 1_020;
  let firstNow = true;
  Date.now = () => {
    if (firstNow) {
      firstNow = false;
      return 1_000;
    }

    return 1_020;
  };

  try {
    await assert.rejects(
      () =>
        withStateFileLock(
          statePath,
          {
            reason: 'contender',
            timeoutMs: 10,
            pollMs: 1,
            sleep: async () => {
              throw new Error('sleep should not run when timeout is already reached');
            },
          },
          () => 'never',
        ),
      (error: unknown) => {
        assert.equal(error instanceof StateLockTimeoutError, true);
        assert.match(String(error), /Timed out after 20ms acquiring state lock/u);
        return true;
      },
    );
  } finally {
    Date.now = originalDateNow;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock rethrows stale lock cleanup failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-stale-error-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const originalUnlinkSync = mutableFs.unlinkSync;

  writeFileSync(
    lockPath,
    `${JSON.stringify({ ownerPid: 999_999_999, ownerHost: 'old-host', reason: 'stale', updatedAt: 'old' })}\n`,
    'utf8',
  );

  mutableFs.unlinkSync = ((filePath: Parameters<typeof mutableFs.unlinkSync>[0]) => {
    if (String(filePath) === lockPath) {
      throw createErrnoError('EACCES', 'permission denied while removing stale lock');
    }

    return originalUnlinkSync(filePath);
  }) as typeof mutableFs.unlinkSync;
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      () =>
        withStateFileLock(
          statePath,
          {
            reason: 'fresh',
            timeoutMs: 50,
            pollMs: 10,
          },
          () => 'never',
        ),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'EACCES');
        return true;
      },
    );
  } finally {
    mutableFs.unlinkSync = originalUnlinkSync;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock logs lock cleanup errors after task completion', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-cleanup-error-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const stderrMessages: string[] = [];
  const originalWrite = process.stderr.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrMessages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: 'cleanup-error',
      },
      () => {
        unlinkSync(lockPath);
        mkdirSync(lockPath);
        return 'done';
      },
    );

    assert.equal(result, 'done');
    assert.deepEqual(stderrMessages, [`Failed to remove state lock file: ${lockPath}\n`]);
  } finally {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withStateFileLock rethrows unexpected acquisition errors', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-state-lock-open-error-'));
  const statePath = path.join(dir, 'state.json');
  const lockPath = lockPathForState(statePath);
  const originalOpenSync = mutableFs.openSync;
  mutableFs.openSync = ((
    filePath: Parameters<typeof mutableFs.openSync>[0],
    flags: Parameters<typeof mutableFs.openSync>[1],
    mode?: Parameters<typeof mutableFs.openSync>[2],
  ) => {
    if (String(filePath) === lockPath) {
      throw createErrnoError('EIO', 'synthetic open failure');
    }

    return originalOpenSync(filePath, flags, mode);
  }) as typeof mutableFs.openSync;
  syncBuiltinESMExports();

  try {
    await assert.rejects(
      () =>
        withStateFileLock(
          statePath,
          {
            reason: 'open-error',
            timeoutMs: 10,
          },
          () => 'never',
        ),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'EIO');
        return true;
      },
    );
  } finally {
    mutableFs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
