import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import { StateLockTimeoutError, lockPathForState, withStateFileLock } from './state-lock.js';
import {
  assertBatchTimerDelaySupported,
  parseBatchRunLockToken,
  parseBatchRunPath,
  sha256BatchJson,
} from './identity.js';
import { BatchRunLockIdentityConflictError, BatchRunLockTimeoutError } from './errors.js';
import type { BatchJsonValue, BatchRunLockOptions, BatchRunLockReceipt } from './types.js';

const DEFAULT_BATCH_RUN_LOCK_TIMEOUT_MS = 300_000;

type ActiveBatchRunLock = {
  scopeDepth: number;
  identitySha256: string;
  receipt: BatchRunLockReceipt;
  drained: Promise<void>;
  drain: () => void;
  released: Promise<void>;
  release: () => void;
};

type BatchRunLockScope = {
  active: boolean;
  owner: ActiveBatchRunLock;
};

const ACTIVE_BATCH_RUN_LOCKS = new Map<string, ActiveBatchRunLock>();
const BATCH_RUN_LOCK_CONTEXT = new AsyncLocalStorage<ReadonlyMap<string, BatchRunLockScope>>();

export function batchRunLockStatePath(runPath: string): string {
  return path.join(parseBatchRunPath(runPath), '.tiangong-lca-batch-run.state');
}

export function batchRunLockPath(runPath: string): string {
  return lockPathForState(batchRunLockStatePath(runPath));
}

export async function withBatchRunLock<T, TIdentity extends BatchJsonValue>(
  options: BatchRunLockOptions<TIdentity>,
  task: (receipt: BatchRunLockReceipt) => Promise<T> | T,
): Promise<T> {
  const runPath = parseBatchRunPath(options.runPath);
  const reason = parseBatchRunLockToken(options.reason, 'reason');
  assertBatchTimerDelaySupported(options.timeoutMs, 'timeoutMs');
  assertBatchTimerDelaySupported(options.pollMs, 'pollMs');
  const identitySha256 = sha256BatchJson(options.identity);
  const statePath = batchRunLockStatePath(runPath);
  const lockPath = lockPathForState(statePath);
  const receipt = Object.freeze({
    run_path: runPath,
    state_path: statePath,
    lock_path: lockPath,
    identity_sha256: identitySha256,
  });
  const active = ACTIVE_BATCH_RUN_LOCKS.get(statePath);
  if (active) {
    if (active.identitySha256 !== identitySha256) {
      throw new BatchRunLockIdentityConflictError({
        runPath,
        activeIdentitySha256: active.identitySha256,
        requestedIdentitySha256: identitySha256,
      });
    }
    const parentScope = BATCH_RUN_LOCK_CONTEXT.getStore()?.get(statePath);
    if (parentScope?.active && parentScope.owner === active) {
      return runBatchRunLockScope(statePath, active, task);
    }
    await waitForActiveBatchRunLock(active, options, runPath, lockPath, identitySha256);
    return withBatchRunLock(options, task);
  }

  let physicalOwner: ActiveBatchRunLock | undefined;
  try {
    const result = await withStateFileLock(
      statePath,
      {
        reason: `batch-run:${identitySha256}:${reason}`,
        metadata: {
          batch_identity_sha256: identitySha256,
          batch_run_path: runPath,
        },
        stalePolicy: 'same-host-pid',
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      },
      async () => {
        const owner = createActiveBatchRunLock(identitySha256, receipt);
        physicalOwner = owner;
        ACTIVE_BATCH_RUN_LOCKS.set(statePath, owner);
        try {
          return await runBatchRunLockScope(statePath, owner, task);
        } finally {
          await owner.drained;
        }
      },
    );
    return result;
  } catch (error) {
    if (!(error instanceof StateLockTimeoutError)) throw error;
    const details = error.details as {
      waitedMs: number;
      owner: Record<string, unknown> | null;
    };
    throw new BatchRunLockTimeoutError({
      runPath,
      lockPath,
      identitySha256,
      waitedMs: details.waitedMs,
      owner: details.owner ? Object.freeze({ ...details.owner }) : null,
    });
  } finally {
    if (physicalOwner) {
      ACTIVE_BATCH_RUN_LOCKS.delete(statePath);
      physicalOwner.release();
    }
  }
}

function createActiveBatchRunLock(
  identitySha256: string,
  receipt: BatchRunLockReceipt,
): ActiveBatchRunLock {
  let drain: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    drain = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    scopeDepth: 0,
    identitySha256,
    receipt,
    drained,
    drain,
    released,
    release,
  };
}

async function runBatchRunLockScope<T>(
  statePath: string,
  owner: ActiveBatchRunLock,
  task: (receipt: BatchRunLockReceipt) => Promise<T> | T,
): Promise<T> {
  const scope: BatchRunLockScope = { active: true, owner };
  owner.scopeDepth += 1;
  const context = new Map(BATCH_RUN_LOCK_CONTEXT.getStore() ?? []);
  context.set(statePath, scope);
  try {
    return await BATCH_RUN_LOCK_CONTEXT.run(context, () => task(owner.receipt));
  } finally {
    scope.active = false;
    owner.scopeDepth -= 1;
    if (owner.scopeDepth === 0) owner.drain();
  }
}

async function waitForActiveBatchRunLock<TIdentity extends BatchJsonValue>(
  active: { released: Promise<void> },
  options: BatchRunLockOptions<TIdentity>,
  runPath: string,
  lockPath: string,
  identitySha256: string,
): Promise<void> {
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_BATCH_RUN_LOCK_TIMEOUT_MS, 0);
  if (timeoutMs === 0) {
    throw new BatchRunLockTimeoutError({
      runPath,
      lockPath,
      identitySha256,
      waitedMs: 0,
      owner: null,
    });
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      active.released,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BatchRunLockTimeoutError({
                runPath,
                lockPath,
                identitySha256,
                waitedMs: Date.now() - startedAt,
                owner: null,
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
