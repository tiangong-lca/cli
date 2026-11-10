import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../shared/errors.js';

export type StateLockMetadata = {
  ownerPid: number;
  ownerHost: string;
  reason: string;
  updatedAt: string;
};

export type StateLockOptions = {
  reason: string;
  metadata?: Record<string, string | number | boolean | null>;
  stalePolicy?: 'local-pid' | 'same-host-pid' | 'never';
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pid?: number;
  host?: string;
  now?: Date;
};

type LocalLockOwner = {
  depth: number;
  fd: number;
};

const LOCAL_LOCK_OWNERS = new Map<string, LocalLockOwner>();
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 200;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isErrnoException(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

function normalizeLockTimings(options: StateLockOptions): { timeoutMs: number; pollMs: number } {
  for (const [label, value] of [
    ['timeoutMs', options.timeoutMs],
    ['pollMs', options.pollMs],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`State lock ${label} must be a finite safe integer.`);
    }
    if (value > MAX_NODE_TIMER_DELAY_MS) {
      throw new RangeError(
        `State lock ${label} exceeds the maximum supported timer delay (${MAX_NODE_TIMER_DELAY_MS} ms).`,
      );
    }
  }
  return {
    timeoutMs: Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0),
    pollMs: Math.max(options.pollMs ?? DEFAULT_POLL_MS, 10),
  };
}

function writeLockMetadata(fileDescriptor: number, metadata: StateLockMetadata): void {
  writeFileSync(fileDescriptor, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function releaseLocalLockOwner(lockKey: string): void {
  const owner = LOCAL_LOCK_OWNERS.get(lockKey);
  if (owner && owner.depth > 1) {
    owner.depth -= 1;
    return;
  }

  LOCAL_LOCK_OWNERS.delete(lockKey);
}

export class StateLockTimeoutError extends CliError {
  constructor(
    lockPath: string,
    reason: string,
    waitedMs: number,
    owner: Record<string, unknown> | null,
  ) {
    super(`Timed out after ${waitedMs}ms acquiring state lock: ${lockPath}`, {
      code: 'STATE_LOCK_TIMEOUT',
      exitCode: 1,
      details: {
        lockPath,
        reason,
        waitedMs,
        owner,
      },
    });
  }
}

export function lockPathForState(statePath: string): string {
  return `${statePath}.lock`;
}

export function readStateLockMetadata(lockPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return { raw: text };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoException(error, 'ESRCH');
  }
}

export async function withStateFileLock<T>(
  statePath: string,
  options: StateLockOptions,
  task: () => Promise<T> | T,
): Promise<T> {
  const { timeoutMs, pollMs } = normalizeLockTimings(options);
  const lockPath = lockPathForState(statePath);
  const lockKey = path.resolve(lockPath);
  const localOwner = LOCAL_LOCK_OWNERS.get(lockKey);

  if (localOwner) {
    localOwner.depth += 1;
    try {
      return await task();
    } finally {
      releaseLocalLockOwner(lockKey);
    }
  }

  mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  const sleep = options.sleep ?? sleepMs;

  while (true) {
    try {
      const fileDescriptor = openSync(lockPath, 'wx');
      const metadata: StateLockMetadata = {
        ...options.metadata,
        ownerPid: options.pid ?? process.pid,
        ownerHost: options.host ?? os.hostname(),
        reason: options.reason,
        updatedAt: (options.now ?? new Date()).toISOString(),
      };
      writeLockMetadata(fileDescriptor, metadata);
      LOCAL_LOCK_OWNERS.set(lockKey, {
        depth: 1,
        fd: fileDescriptor,
      });

      try {
        return await task();
      } finally {
        releaseLocalLockOwner(lockKey);
        closeSync(fileDescriptor);
        try {
          unlinkSync(lockPath);
        } catch (error) {
          if (!isErrnoException(error, 'ENOENT')) {
            process.stderr.write(`Failed to remove state lock file: ${lockPath}\n`);
          }
        }
      }
    } catch (error) {
      if (!isErrnoException(error, 'EEXIST')) {
        throw error;
      }

      const metadata = readStateLockMetadata(lockPath);
      const ownerPid = metadata?.ownerPid;
      const stalePolicy = options.stalePolicy ?? 'local-pid';
      const ownerHost = metadata?.ownerHost;
      const currentHost = options.host ?? os.hostname();
      const staleOwner =
        stalePolicy !== 'never' &&
        typeof ownerPid === 'number' &&
        !isProcessAlive(ownerPid) &&
        (stalePolicy === 'local-pid' || ownerHost === currentHost);
      if (staleOwner) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (!isErrnoException(unlinkError, 'ENOENT')) {
            throw unlinkError;
          }
        }
      }

      const waitedMs = Date.now() - startedAt;
      if (timeoutMs === 0 || waitedMs >= timeoutMs) {
        throw new StateLockTimeoutError(lockPath, options.reason, waitedMs, metadata);
      }

      await sleep(pollMs);
    }
  }
}
