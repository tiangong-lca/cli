import { parseArgs } from 'node:util';
import { CliError } from '../lib/errors.js';
import type { DatasetMaintenanceOperation } from '../lib/dataset-maintenance-contract.js';

export function parseDatasetMaintenanceClearAccountFlags(args: string[]): {
  help: boolean;
  json: boolean;
  outDir: string | null;
  stateCodes: number[] | null;
  pageSize: number | undefined;
  timeoutMs: number | undefined;
  commit: boolean;
  confirm: string | null;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        'out-dir': { type: 'string' },
        'state-code': { type: 'string', multiple: true },
        'page-size': { type: 'string' },
        'timeout-ms': { type: 'string' },
        commit: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        confirm: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  if (values.commit && values['dry-run']) {
    throw new CliError('Cannot pass both --commit and --dry-run.', {
      code: 'DATASET_MAINTENANCE_CLEAR_ACCOUNT_MODE_CONFLICT',
      exitCode: 2,
    });
  }

  const rawStateCodes = Array.isArray(values['state-code'])
    ? values['state-code'].filter((value): value is string => typeof value === 'string')
    : [];
  const stateCodes = rawStateCodes.map((value) => {
    if (!/^-?\d+$/u.test(value.trim())) {
      throw new CliError('--state-code must be an integer.', {
        code: 'DATASET_MAINTENANCE_STATE_CODE_INVALID',
        exitCode: 2,
        details: value,
      });
    }
    return Number.parseInt(value.trim(), 10);
  });

  const parseOptionalInteger = (value: unknown, flagName: string): number | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    if (!/^\d+$/u.test(value.trim())) {
      throw new CliError(`${flagName} must be a positive integer.`, {
        code: 'DATASET_MAINTENANCE_INTEGER_INVALID',
        exitCode: 2,
        details: {
          flag: flagName,
          value,
        },
      });
    }
    return Number.parseInt(value.trim(), 10);
  };

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : null,
    stateCodes: stateCodes.length > 0 ? stateCodes : null,
    pageSize: parseOptionalInteger(values['page-size'], '--page-size'),
    timeoutMs: parseOptionalInteger(values['timeout-ms'], '--timeout-ms'),
    commit: Boolean(values.commit),
    confirm: typeof values.confirm === 'string' ? values.confirm : null,
  };
}

export function parseDatasetMaintenancePositiveInteger(
  value: unknown,
  flagName: '--page-size' | '--poll-ms' | '--read-concurrency' | '--timeout-ms',
): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim()) || Number.parseInt(value.trim(), 10) <= 0) {
    throw new CliError(`${flagName} must be a positive integer.`, {
      code: 'DATASET_MAINTENANCE_INTEGER_INVALID',
      exitCode: 2,
      details: { flag: flagName, value },
    });
  }
  return Number.parseInt(value.trim(), 10);
}

export function parseDatasetMaintenanceNonNegativeInteger(
  value: unknown,
  flagName: '--wait-seconds',
): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new CliError(`${flagName} must be a non-negative integer.`, {
      code: 'DATASET_MAINTENANCE_INTEGER_INVALID',
      exitCode: 2,
      details: { flag: flagName, value },
    });
  }
  return Number.parseInt(value.trim(), 10);
}

export function parseDatasetMaintenancePlanFlags(args: string[]): {
  help: boolean;
  json: boolean;
  scopePath: string;
  operation: DatasetMaintenanceOperation | null;
  aliasV2InputPath: string;
  lengthTimeInputPath: string;
  outDir: string;
  pageSize: number | undefined;
  timeoutMs: number | undefined;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        scope: { type: 'string' },
        operation: { type: 'string' },
        'alias-v2-input': { type: 'string' },
        'length-time-input': { type: 'string' },
        'out-dir': { type: 'string' },
        'page-size': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  const rawOperation = typeof values.operation === 'string' ? values.operation : null;
  if (
    rawOperation !== null &&
    ![
      'delete',
      'retire',
      'redo-import',
      'repair-references',
      'merge-support-aliases',
      'rebuild-derivatives',
    ].includes(rawOperation)
  ) {
    throw new CliError(
      "--operation must be 'delete', 'retire', 'redo-import', 'repair-references', 'merge-support-aliases', or 'rebuild-derivatives'.",
      {
        code: 'DATASET_MAINTENANCE_OPERATION_INVALID',
        exitCode: 2,
        details: rawOperation,
      },
    );
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    scopePath: typeof values.scope === 'string' ? values.scope : '',
    operation: rawOperation as DatasetMaintenanceOperation | null,
    aliasV2InputPath: typeof values['alias-v2-input'] === 'string' ? values['alias-v2-input'] : '',
    lengthTimeInputPath:
      typeof values['length-time-input'] === 'string' ? values['length-time-input'] : '',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : '',
    pageSize: parseDatasetMaintenancePositiveInteger(values['page-size'], '--page-size'),
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
  };
}

export function parseDatasetMaintenanceApplyFlags(args: string[]): {
  help: boolean;
  json: boolean;
  planPath: string;
  commit: boolean;
  approvePlan: string;
  confirm: string;
  timeoutMs: number | undefined;
  dryRun: boolean;
  maxParallel: number | undefined;
  globalInboundProofPath: string;
  approveGlobalInboundProof: string;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        plan: { type: 'string' },
        commit: { type: 'boolean' },
        'approve-plan': { type: 'string' },
        confirm: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'max-parallel': { type: 'string' },
        'global-inbound-proof': { type: 'string' },
        'approve-global-inbound-proof': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  const maxParallelValue = values['max-parallel'];
  const maxParallel =
    typeof maxParallelValue === 'string' && /^\d+$/u.test(maxParallelValue)
      ? Number.parseInt(maxParallelValue, 10)
      : maxParallelValue === undefined
        ? undefined
        : Number.NaN;
  if (
    maxParallel !== undefined &&
    (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8)
  ) {
    throw new CliError('--max-parallel must be an integer from 1 to 8.', {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }
  const globalInboundProofPath =
    typeof values['global-inbound-proof'] === 'string' ? values['global-inbound-proof'] : '';
  const approveGlobalInboundProof =
    typeof values['approve-global-inbound-proof'] === 'string'
      ? values['approve-global-inbound-proof']
      : '';
  if (Boolean(globalInboundProofPath) !== Boolean(approveGlobalInboundProof)) {
    throw new CliError(
      '--global-inbound-proof and --approve-global-inbound-proof must be provided together.',
      { code: 'INVALID_ARGS', exitCode: 2 },
    );
  }
  if (globalInboundProofPath && maxParallel === undefined) {
    throw new CliError('Global inbound proof flags require --max-parallel.', {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }
  if (approveGlobalInboundProof && !/^[0-9a-f]{64}$/u.test(approveGlobalInboundProof)) {
    throw new CliError('--approve-global-inbound-proof must be a lowercase SHA-256.', {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    planPath: typeof values.plan === 'string' ? values.plan : '',
    commit: Boolean(values.commit),
    approvePlan: typeof values['approve-plan'] === 'string' ? values['approve-plan'] : '',
    confirm: typeof values.confirm === 'string' ? values.confirm : '',
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
    dryRun: Boolean(values['dry-run']),
    maxParallel,
    globalInboundProofPath,
    approveGlobalInboundProof,
  };
}

export function parseDatasetMaintenanceFreezeProtectedFlags(args: string[]): {
  help: boolean;
  json: boolean;
  planPath: string;
  toolchainEvidencePath: string;
  derivativeBaselinesPath: string;
  outDir: string;
  expectedProjectRef: string;
  confirm: string;
  pageSize: number | undefined;
  timeoutMs: number | undefined;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        plan: { type: 'string' },
        'toolchain-evidence': { type: 'string' },
        'derivative-baselines': { type: 'string' },
        'out-dir': { type: 'string' },
        'expected-project-ref': { type: 'string' },
        confirm: { type: 'string' },
        'page-size': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }
  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    planPath: typeof values.plan === 'string' ? values.plan : '',
    toolchainEvidencePath:
      typeof values['toolchain-evidence'] === 'string' ? values['toolchain-evidence'] : '',
    derivativeBaselinesPath:
      typeof values['derivative-baselines'] === 'string' ? values['derivative-baselines'] : '',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : '',
    expectedProjectRef:
      typeof values['expected-project-ref'] === 'string' ? values['expected-project-ref'] : '',
    confirm: typeof values.confirm === 'string' ? values.confirm : '',
    pageSize: parseDatasetMaintenancePositiveInteger(values['page-size'], '--page-size'),
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
  };
}

export function parseDatasetMaintenanceSealProtectedApprovalFlags(args: string[]): {
  help: boolean;
  json: boolean;
  freezePath: string;
  approvalRequestPath: string;
  humanApprovalPath: string;
  outDir: string;
  approveFreezeFile: string;
  approveRequest: string;
  approveText: string;
  confirm: string;
  approvedAtUtc: string;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        freeze: { type: 'string' },
        'approval-request': { type: 'string' },
        'human-approval': { type: 'string' },
        'out-dir': { type: 'string' },
        'approve-freeze-file': { type: 'string' },
        'approve-request': { type: 'string' },
        'approve-text': { type: 'string' },
        confirm: { type: 'string' },
        'approved-at': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }
  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    freezePath: typeof values.freeze === 'string' ? values.freeze : '',
    approvalRequestPath:
      typeof values['approval-request'] === 'string' ? values['approval-request'] : '',
    humanApprovalPath: typeof values['human-approval'] === 'string' ? values['human-approval'] : '',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : '',
    approveFreezeFile:
      typeof values['approve-freeze-file'] === 'string' ? values['approve-freeze-file'] : '',
    approveRequest: typeof values['approve-request'] === 'string' ? values['approve-request'] : '',
    approveText: typeof values['approve-text'] === 'string' ? values['approve-text'] : '',
    confirm: typeof values.confirm === 'string' ? values.confirm : '',
    approvedAtUtc: typeof values['approved-at'] === 'string' ? values['approved-at'] : '',
  };
}

export function parseDatasetMaintenanceProtectedFlags(args: string[]): {
  help: boolean;
  json: boolean;
  planPath: string;
  freezePath: string;
  approvalPath: string;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  approveExecution: string | undefined;
  confirm: string | undefined;
  waitSeconds: number | undefined;
  pollMs: number | undefined;
  pageSize: number | undefined;
  timeoutMs: number | undefined;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        plan: { type: 'string' },
        freeze: { type: 'string' },
        approval: { type: 'string' },
        'out-dir': { type: 'string' },
        commit: { type: 'boolean' },
        'status-only': { type: 'boolean' },
        'approve-execution': { type: 'string' },
        confirm: { type: 'string' },
        'wait-seconds': { type: 'string' },
        'poll-ms': { type: 'string' },
        'page-size': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    planPath: typeof values.plan === 'string' ? values.plan : '',
    freezePath: typeof values.freeze === 'string' ? values.freeze : '',
    approvalPath: typeof values.approval === 'string' ? values.approval : '',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : '',
    commit: Boolean(values.commit),
    statusOnly: Boolean(values['status-only']),
    approveExecution:
      typeof values['approve-execution'] === 'string' ? values['approve-execution'] : undefined,
    confirm: typeof values.confirm === 'string' ? values.confirm : undefined,
    waitSeconds: parseDatasetMaintenanceNonNegativeInteger(
      values['wait-seconds'],
      '--wait-seconds',
    ),
    pollMs: parseDatasetMaintenancePositiveInteger(values['poll-ms'], '--poll-ms'),
    pageSize: parseDatasetMaintenancePositiveInteger(values['page-size'], '--page-size'),
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
  };
}

export function parseDatasetMaintenanceFlowIdentityFlags(args: string[]) {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        policy: { type: 'string' },
        'review-ledger': { type: 'string' },
        prerequisites: { type: 'string' },
        'live-capture': { type: 'string' },
        plan: { type: 'string' },
        'toolchain-evidence': { type: 'string' },
        'approval-text': { type: 'string' },
        'expected-project-ref': { type: 'string' },
        'request-id': { type: 'string' },
        'operation-id': { type: 'string' },
        'sdk-version': { type: 'string' },
        freeze: { type: 'string' },
        'approval-request': { type: 'string' },
        'human-approval': { type: 'string' },
        approval: { type: 'string' },
        'recovery-freeze': { type: 'string' },
        'recovery-approval': { type: 'string' },
        'recovery-reason': { type: 'string' },
        'approve-freeze-file': { type: 'string' },
        'approve-request': { type: 'string' },
        'approve-text': { type: 'string' },
        'approve-execution': { type: 'string' },
        confirm: { type: 'string' },
        'approved-at': { type: 'string' },
        'out-dir': { type: 'string' },
        'run-dir': { type: 'string' },
        commit: { type: 'boolean' },
        'status-only': { type: 'boolean' },
        'wait-seconds': { type: 'string' },
        'poll-ms': { type: 'string' },
        'page-size': { type: 'string' },
        'read-concurrency': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), { code: 'INVALID_ARGS', exitCode: 2 });
  }
  const valueRecord = values as Record<string, unknown>;
  const string = (name: string): string =>
    typeof valueRecord[name] === 'string' ? String(valueRecord[name]) : '';
  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    policyPath: string('policy'),
    reviewLedgerPath: string('review-ledger'),
    prerequisitesPath: string('prerequisites'),
    liveCapturePath: string('live-capture'),
    planPath: string('plan'),
    toolchainEvidencePath: string('toolchain-evidence'),
    approvalTextPath: string('approval-text'),
    expectedProjectRef: string('expected-project-ref'),
    requestId: string('request-id'),
    operationId: string('operation-id'),
    sdkVersion: string('sdk-version'),
    freezePath: string('freeze'),
    approvalRequestPath: string('approval-request'),
    humanApprovalPath: string('human-approval'),
    approvalPath: string('approval'),
    recoveryFreezePath: string('recovery-freeze'),
    recoveryApprovalPath: string('recovery-approval'),
    recoveryReason: string('recovery-reason'),
    approveFreezeFile: string('approve-freeze-file'),
    approveRequest: string('approve-request'),
    approveText: string('approve-text'),
    approveExecution: string('approve-execution'),
    confirm: string('confirm'),
    approvedAtUtc: string('approved-at'),
    outDir: string('out-dir'),
    runDir: string('run-dir'),
    commit: Boolean(values.commit),
    statusOnly: Boolean(values['status-only']),
    waitSeconds: parseDatasetMaintenanceNonNegativeInteger(
      values['wait-seconds'],
      '--wait-seconds',
    ),
    pollMs: parseDatasetMaintenancePositiveInteger(values['poll-ms'], '--poll-ms'),
    pageSize: parseDatasetMaintenancePositiveInteger(values['page-size'], '--page-size'),
    readConcurrency: parseDatasetMaintenancePositiveInteger(
      values['read-concurrency'],
      '--read-concurrency',
    ),
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
  };
}

export function parseDatasetMaintenanceVerifyFlags(args: string[]): {
  help: boolean;
  json: boolean;
  planPath: string;
  outDir: string | undefined;
  pageSize: number | undefined;
  timeoutMs: number | undefined;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        plan: { type: 'string' },
        'out-dir': { type: 'string' },
        'page-size': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    planPath: typeof values.plan === 'string' ? values.plan : '',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : undefined,
    pageSize: parseDatasetMaintenancePositiveInteger(values['page-size'], '--page-size'),
    timeoutMs: parseDatasetMaintenancePositiveInteger(values['timeout-ms'], '--timeout-ms'),
  };
}
