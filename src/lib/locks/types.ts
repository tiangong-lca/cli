export type BatchJsonPrimitive = boolean | null | number | string;
export type BatchJsonValue = BatchJsonPrimitive | BatchJsonValue[] | BatchJsonObject;
export type BatchJsonObject = { [key: string]: BatchJsonValue };

export type BatchRunLockOptions<TIdentity extends BatchJsonValue> = Readonly<{
  runPath: string;
  identity: TIdentity;
  reason: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export type BatchRunLockReceipt = Readonly<{
  run_path: string;
  state_path: string;
  lock_path: string;
  identity_sha256: string;
}>;
