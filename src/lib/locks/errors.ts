export class BatchContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BatchContractError';
  }
}

export class BatchRunLockTimeoutError extends Error {
  readonly code = 'BATCH_RUN_LOCK_TIMEOUT' as const;
  readonly runPath: string;
  readonly lockPath: string;
  readonly identitySha256: string;
  readonly waitedMs: number;
  readonly owner: Readonly<Record<string, unknown>> | null;

  constructor(options: {
    runPath: string;
    lockPath: string;
    identitySha256: string;
    waitedMs: number;
    owner: Readonly<Record<string, unknown>> | null;
  }) {
    super(`Timed out after ${options.waitedMs}ms acquiring batch run lock: ${options.lockPath}`);
    this.name = 'BatchRunLockTimeoutError';
    this.runPath = options.runPath;
    this.lockPath = options.lockPath;
    this.identitySha256 = options.identitySha256;
    this.waitedMs = options.waitedMs;
    this.owner = options.owner;
  }
}

export class BatchRunLockIdentityConflictError extends Error {
  readonly code = 'BATCH_RUN_LOCK_IDENTITY_CONFLICT' as const;
  readonly runPath: string;
  readonly activeIdentitySha256: string;
  readonly requestedIdentitySha256: string;

  constructor(options: {
    runPath: string;
    activeIdentitySha256: string;
    requestedIdentitySha256: string;
  }) {
    super(
      `Batch run path is already locked by another identity in this process: ${options.runPath}`,
    );
    this.name = 'BatchRunLockIdentityConflictError';
    this.runPath = options.runPath;
    this.activeIdentitySha256 = options.activeIdentitySha256;
    this.requestedIdentitySha256 = options.requestedIdentitySha256;
  }
}
