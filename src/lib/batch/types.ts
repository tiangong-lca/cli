import type { BatchJsonValue } from '../locks/types.js';
export type {
  BatchJsonPrimitive,
  BatchJsonValue,
  BatchJsonObject,
  BatchRunLockOptions,
  BatchRunLockReceipt,
} from '../locks/types.js';
export const MAX_BATCH_CONCURRENCY = 64 as const;

export type BatchContract<TIdentity extends BatchJsonValue = BatchJsonValue> = {
  identity: TIdentity;
  content_sha256: string;
  policy_sha256: string;
};

export type BatchItemContract = Readonly<{
  item_id: string;
  content_sha256: string;
  policy_sha256: string;
}>;

export type CreateBatchItemContractOptions = Readonly<{
  item_id: string;
  content: BatchJsonValue;
  policy: BatchJsonValue;
}>;

export type CreateBatchContractOptions<TIdentity extends BatchJsonValue> = {
  identity: TIdentity;
  content: BatchJsonValue;
  policy: BatchJsonValue;
};

export type BatchMode = 'mutation' | 'read';
export type BatchStatus = 'completed' | 'paused' | 'stopped';
export type BatchItemSuccessStatus = 'recovered' | 'succeeded';

export type BatchEventType =
  | 'attempt_failed'
  | 'attempt_started'
  | 'attempt_succeeded'
  | 'batch_completed'
  | 'batch_paused'
  | 'batch_started'
  | 'batch_stopped'
  | 'item_claimed'
  | 'item_completed'
  | 'item_identity_drift'
  | 'item_projection_drift'
  | 'item_resource_acquired'
  | 'item_resource_drift'
  | 'item_resource_queued'
  | 'item_resource_released'
  | 'item_resume_rejected'
  | 'item_resumed'
  | 'recovery_failed'
  | 'recovery_started'
  | 'recovery_succeeded'
  | 'retry_scheduled';

export type BatchEvent = Readonly<{
  sequence: number;
  timestamp_ms: number;
  type: BatchEventType;
  item_id?: string;
  input_index?: number;
  attempt?: number;
  delay_ms?: number;
  status?: BatchItemResultStatus | BatchStatus;
  source?: BatchRecoverySource;
  exclusive_key?: string;
}>;

type BatchItemResultCommon<TInput> = Readonly<{
  item: TInput;
  item_id: string;
  item_contract: BatchItemContract;
  exclusive_key: string | null;
  input_index: number;
  attempts: number;
  attempt_consumed: boolean;
  resumed: boolean;
  completed_at_ms: number;
}>;

export type BatchItemSucceededResult<TInput, TOutput> = BatchItemResultCommon<TInput> &
  Readonly<{
    status: BatchItemSuccessStatus;
    value: TOutput;
  }>;

export type BatchItemFailedResult<TInput> = BatchItemResultCommon<TInput> &
  Readonly<{
    status: 'failed';
    error: unknown;
  }>;

export type BatchItemResultStatus = BatchItemSuccessStatus | 'failed';
export type BatchItemResult<TInput, TOutput> =
  BatchItemFailedResult<TInput> | BatchItemSucceededResult<TInput, TOutput>;

export type BatchRunResult<
  TInput,
  TOutput,
  TIdentity extends BatchJsonValue = BatchJsonValue,
> = Readonly<{
  contract: BatchContract<TIdentity>;
  status: BatchStatus;
  claim_order: readonly string[];
  completion_order: readonly string[];
  results_input_order: readonly BatchItemResult<TInput, TOutput>[];
  results_completion_order: readonly BatchItemResult<TInput, TOutput>[];
  unclaimed_item_ids: readonly string[];
  events: readonly BatchEvent[];
}>;

export type BatchExecutionContext<TInput, TExclusiveKey extends string = string> = Readonly<{
  item: TInput;
  item_id: string;
  item_contract: BatchItemContract;
  exclusive_key: TExclusiveKey | null;
  input_index: number;
  attempt: number;
  mode: BatchMode;
}>;

export type BatchRetryContext<
  TInput,
  TExclusiveKey extends string = string,
> = BatchExecutionContext<TInput, TExclusiveKey> &
  Readonly<{
    error: unknown;
  }>;

export type BatchRetryPolicy<TInput, TExclusiveKey extends string = string> = Readonly<{
  maxAttempts: number;
  maxDelayMs: number;
  shouldRetry: (context: BatchRetryContext<TInput, TExclusiveKey>) => boolean | Promise<boolean>;
  delayMs: (context: BatchRetryContext<TInput, TExclusiveKey>) => number | Promise<number>;
}>;

export type BatchRecoverySource = 'execution_error' | 'resume_incomplete';

export type BatchMutationRecoveryContext<TInput, TExclusiveKey extends string = string> = Readonly<{
  item: TInput;
  item_id: string;
  item_contract: BatchItemContract;
  exclusive_key: TExclusiveKey | null;
  input_index: number;
  attempts: number;
  error: unknown;
  source: BatchRecoverySource;
}>;

export type BatchMutationRecoveryResult<TOutput> =
  | Readonly<{ status: 'recovered'; value: TOutput }>
  | Readonly<{ status: 'unresolved'; error?: unknown }>;

export type BatchCompletedResumeItem<TOutput> = BatchItemContract &
  Readonly<{
    state: 'completed';
    outcome: BatchItemSuccessStatus;
    value: TOutput;
    attempts: number;
  }>;

export type BatchAttemptedResumeItem = BatchItemContract &
  Readonly<{
    state: 'attempted';
    attempts: number;
  }>;

export type BatchResumeItem<TOutput> = BatchAttemptedResumeItem | BatchCompletedResumeItem<TOutput>;

export type BatchResumeState<
  TOutput,
  TIdentity extends BatchJsonValue = BatchJsonValue,
> = Readonly<{
  contract: BatchContract<TIdentity>;
  items: readonly BatchResumeItem<TOutput>[];
}>;

export type BatchPauseContext<TInput, TOutput> = Readonly<{
  item: TInput;
  item_id: string;
  item_contract: BatchItemContract;
  exclusive_key: string | null;
  input_index: number;
  claimed_count: number;
  results_input_order: readonly BatchItemResult<TInput, TOutput>[];
}>;

export type BatchStopContext<TInput, TOutput> = Readonly<{
  last_result: BatchItemResult<TInput, TOutput>;
  claimed_count: number;
  results_input_order: readonly BatchItemResult<TInput, TOutput>[];
  results_completion_order: readonly BatchItemResult<TInput, TOutput>[];
}>;

export type BatchClock = Readonly<{ now: () => number }>;
export type BatchSleep = (milliseconds: number) => Promise<void>;

export type BatchExclusiveKeyContext<TInput> = Readonly<{
  item: TInput;
  item_id: string;
  item_contract: BatchItemContract;
  input_index: number;
}>;

export type RunBoundedBatchOptions<
  TInput,
  TOutput,
  TIdentity extends BatchJsonValue,
  TExclusiveKey extends string = string,
> = Readonly<{
  contract: BatchContract<TIdentity>;
  items: readonly TInput[];
  getItemIdentity: (item: TInput, inputIndex: number) => string;
  projectItemContent: (item: TInput, inputIndex: number) => BatchJsonValue;
  projectItemPolicy: (item: TInput, inputIndex: number) => BatchJsonValue;
  getExclusiveKey?: (context: BatchExclusiveKeyContext<TInput>) => TExclusiveKey | null | undefined;
  mode: BatchMode;
  maxConcurrency: number;
  execute: (context: BatchExecutionContext<TInput, TExclusiveKey>) => TOutput | Promise<TOutput>;
  retry?: BatchRetryPolicy<TInput, TExclusiveKey>;
  recoverMutation?: (
    context: BatchMutationRecoveryContext<TInput, TExclusiveKey>,
  ) => BatchMutationRecoveryResult<TOutput> | Promise<BatchMutationRecoveryResult<TOutput>>;
  resume?: BatchResumeState<TOutput, TIdentity>;
  shouldPauseBeforeClaim?: (
    context: BatchPauseContext<TInput, TOutput>,
  ) => boolean | Promise<boolean>;
  shouldStop?: (context: BatchStopContext<TInput, TOutput>) => boolean | Promise<boolean>;
  eventSink?: (event: BatchEvent) => void | Promise<void>;
  clock?: BatchClock;
  sleep?: BatchSleep;
}>;
