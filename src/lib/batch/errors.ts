import { BatchContractError } from '../locks/errors.js';
export {
  BatchContractError,
  BatchRunLockTimeoutError,
  BatchRunLockIdentityConflictError,
} from '../locks/errors.js';
export class BatchMutationRetryError extends BatchContractError {
  constructor() {
    super('Mutation batches reject automatic retry; use explicit readback recovery instead.');
    this.name = 'BatchMutationRetryError';
  }
}

export class BatchMutationReplayError extends Error {
  constructor(itemId: string) {
    super(
      `Mutation item ${itemId} has a consumed incomplete attempt and cannot be replayed without explicit readback recovery.`,
    );
    this.name = 'BatchMutationReplayError';
  }
}

export class BatchItemResumeContractError extends BatchContractError {
  readonly itemId: string;

  constructor(itemId: string) {
    super(
      `Batch resume item ${itemId} does not match the current item identity, content SHA-256, and policy SHA-256 triple.`,
    );
    this.name = 'BatchItemResumeContractError';
    this.itemId = itemId;
  }
}

export class BatchItemProjectionDriftError extends BatchContractError {
  readonly itemId: string;

  constructor(itemId: string) {
    super(`Batch item ${itemId} content or policy projection drifted before claim.`);
    this.name = 'BatchItemProjectionDriftError';
    this.itemId = itemId;
  }
}

export class BatchItemIdentityDriftError extends BatchContractError {
  readonly itemId: string;

  constructor(itemId: string) {
    super(`Batch item ${itemId} identity drifted before claim.`);
    this.name = 'BatchItemIdentityDriftError';
    this.itemId = itemId;
  }
}

export class BatchItemResourceDriftError extends BatchContractError {
  readonly itemId: string;

  constructor(itemId: string) {
    super(`Batch item ${itemId} exclusive resource key drifted before claim.`);
    this.name = 'BatchItemResourceDriftError';
    this.itemId = itemId;
  }
}
