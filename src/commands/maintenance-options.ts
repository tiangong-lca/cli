import { parseArgs } from 'node:util';
import { CliError } from '../shared/errors.js';
import { type DatasetMaintenanceOperation } from '../lib/maintenance/contract/types.js';

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
  flagName: '--page-size' | '--timeout-ms',
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

export function parseDatasetMaintenancePlanFlags(args: string[]): {
  help: boolean;
  json: boolean;
  scopePath: string;
  operation: DatasetMaintenanceOperation | null;
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
    !['delete', 'retire', 'redo-import', 'repair-references', 'rebuild-derivatives'].includes(
      rawOperation,
    )
  ) {
    throw new CliError('Unsupported maintenance operation.', {
      code: 'DATASET_MAINTENANCE_OPERATION_INVALID',
      exitCode: 2,
      details: rawOperation,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    scopePath: typeof values.scope === 'string' ? values.scope : '',
    operation: rawOperation as DatasetMaintenanceOperation | null,
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
