import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { CliError } from './errors.js';

const OPERATION_REPORT_SCHEMA = 'tidas.operation-report.v1';
const INVOCATION_CONTEXT_SCHEMA = 'tidas.invocation-context.v1';
const IMPORT_REPORT_SCHEMA = 'tidas.import-execution-report.v1';
const SUPPORTED_TIDAS_VERSION = /^0\.2\.\d+$/u;

const EXIT_CODES = {
  success: 0,
  'data-issues': 2,
  usage: 64,
  unavailable: 69,
  internal: 70,
  io: 74,
  cancelled: 130,
} as const;

const OPERATION_STATUSES = ['succeeded', 'completed-with-issues', 'failed', 'cancelled'] as const;
const COMPLETENESS_VALUES = ['complete', 'partial', 'not-started'] as const;
const SOURCE_FORMATS = [
  'ecospold1',
  'ecospold2',
  'simapro-csv',
  'openlca-jsonld',
  'openlca-process-xlsx',
  'ilcd',
] as const;

type TidasExitClass = keyof typeof EXIT_CODES;
type TidasOperationStatus = (typeof OPERATION_STATUSES)[number];
type TidasCompleteness = (typeof COMPLETENESS_VALUES)[number];
export type DatasetImportLcaTarget = 'tidas' | 'ilcd' | 'both';
export type DatasetImportLcaSourceFormat = (typeof SOURCE_FORMATS)[number];

type TidasOperationReport = {
  schema_version: typeof OPERATION_REPORT_SCHEMA;
  command: 'version' | 'import' | 'convert';
  status: TidasOperationStatus;
  exit_class: TidasExitClass;
  completeness: TidasCompleteness;
  invocation: {
    schema_version: typeof INVOCATION_CONTEXT_SCHEMA;
    input_policy: 'explicit-path-or-dash';
    report_destination: 'stdout' | 'file';
    diagnostic_destination: 'stderr';
    [key: string]: unknown;
  };
  summary: Record<string, unknown>;
  diagnostics: unknown[];
  artifacts: unknown[];
  next_actions: unknown[];
};

export type DatasetImportLcaReport = {
  schema_version: 'tiangong-lca.dataset-import-lca-report.v2';
  status: TidasOperationStatus;
  exit_class: TidasExitClass;
  exit_code: number;
  generated_at_utc: string;
  input_path: string;
  output_dir: string;
  from_format: DatasetImportLcaSourceFormat | 'auto';
  target: DatasetImportLcaTarget;
  tidas: {
    executable: string;
    version: string;
    operation_report_schema: typeof OPERATION_REPORT_SCHEMA;
    import_report_schema: typeof IMPORT_REPORT_SCHEMA;
  };
  command: {
    args: string[];
    cwd: string;
    stderr: string;
  };
  operation_report: TidasOperationReport;
  files: {
    report: string | null;
    native_import_report: string;
    issues: string;
    tidas_dir: string | null;
    ilcd_dir: string | null;
    mapping_csv: string | null;
    process_bundles_dir: string | null;
  };
};

export type TidasProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

export type RunDatasetImportLcaConvertOptions = {
  inputPath: string;
  outputDir: string;
  fromFormat?: string | undefined;
  target?: string | undefined;
  reportPath?: string | undefined;
  writeMapping?: boolean | undefined;
  processBundles?: boolean | undefined;
  failOnWarning?: boolean | undefined;
  maxEntryMib?: number | undefined;
  memoryBudgetMib?: number | undefined;
  queueCapacity?: number | undefined;
  tidasBin?: string | undefined;
  tidasConfig?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  now?: Date | undefined;
  spawnImpl?: typeof spawnSync | undefined;
};

export async function runDatasetImportLcaConvert(
  options: RunDatasetImportLcaConvertOptions,
): Promise<DatasetImportLcaReport> {
  const inputPath = requireInputPath(options.inputPath);
  const outputDir = requireOutputDir(options.outputDir);
  const fromFormat = normalizeSourceFormat(options.fromFormat);
  const target = normalizeTarget(options.target);
  const env = options.env ?? process.env;
  const executable = resolveTidasBinary(options.tidasBin, env);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const reportPath = options.reportPath?.trim() ? path.resolve(options.reportPath) : null;
  const configPath = options.tidasConfig?.trim() ? path.resolve(options.tidasConfig) : null;
  const spawnImpl = [spawnSync, options.spawnImpl].filter(Boolean).at(-1) as typeof spawnSync;

  assertSupportedPlatform(options.platform ?? process.platform, options.arch ?? process.arch);
  requirePositiveInteger('--max-entry-mib', options.maxEntryMib);
  requirePositiveInteger('--memory-budget-mib', options.memoryBudgetMib);
  requirePositiveInteger('--queue-capacity', options.queueCapacity);

  const versionArgs = ['version', '--format', 'json', '--progress', 'never'];
  const versionRun = runTidas(spawnImpl, executable, versionArgs, cwd, env);
  const versionReport = parseOperationReport(readProcessReport(versionRun, null), 'version');
  assertExitContract(versionRun, versionReport);
  const version = readCompatibleVersion(versionReport);

  const commandArgs = buildImportArgs({
    inputPath,
    outputDir,
    fromFormat,
    target,
    reportPath,
    configPath,
    writeMapping: Boolean(options.writeMapping),
    processBundles: options.processBundles !== false,
    failOnWarning: Boolean(options.failOnWarning),
    maxEntryMib: options.maxEntryMib,
    memoryBudgetMib: options.memoryBudgetMib,
    queueCapacity: options.queueCapacity,
  });
  const importRun = runTidas(spawnImpl, executable, commandArgs, cwd, env);
  const operationReport = parseOperationReport(readProcessReport(importRun, reportPath), 'import');
  assertExitContract(importRun, operationReport);
  assertImportContract(operationReport);

  return {
    schema_version: 'tiangong-lca.dataset-import-lca-report.v2',
    status: operationReport.status,
    exit_class: operationReport.exit_class,
    exit_code: EXIT_CODES[operationReport.exit_class],
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    input_path: inputPath,
    output_dir: outputDir,
    from_format: fromFormat,
    target,
    tidas: {
      executable,
      version,
      operation_report_schema: OPERATION_REPORT_SCHEMA,
      import_report_schema: IMPORT_REPORT_SCHEMA,
    },
    command: {
      args: commandArgs,
      cwd,
      stderr: importRun.stderr,
    },
    operation_report: operationReport,
    files: {
      report: reportPath,
      native_import_report: path.join(outputDir, 'import-report.json'),
      issues: path.join(outputDir, 'issues.jsonl'),
      tidas_dir:
        operationReport.completeness === 'complete' && (target === 'tidas' || target === 'both')
          ? path.join(outputDir, 'tidas')
          : null,
      ilcd_dir:
        operationReport.completeness === 'complete' && (target === 'ilcd' || target === 'both')
          ? path.join(outputDir, 'ilcd')
          : null,
      mapping_csv:
        operationReport.completeness === 'complete' && options.writeMapping
          ? path.join(outputDir, 'mapping.csv.gz')
          : null,
      process_bundles_dir:
        operationReport.completeness === 'complete' && options.processBundles !== false
          ? path.join(outputDir, 'process-bundles')
          : null,
    },
  };
}

function buildImportArgs(options: {
  inputPath: string;
  outputDir: string;
  fromFormat: DatasetImportLcaSourceFormat | 'auto';
  target: DatasetImportLcaTarget;
  reportPath: string | null;
  configPath: string | null;
  writeMapping: boolean;
  processBundles: boolean;
  failOnWarning: boolean;
  maxEntryMib: number | undefined;
  memoryBudgetMib: number | undefined;
  queueCapacity: number | undefined;
}): string[] {
  const args = [
    'import',
    options.inputPath,
    '--output',
    options.outputDir,
    '--target',
    options.target,
    '--format',
    'json',
    '--progress',
    'never',
  ];
  if (options.fromFormat !== 'auto') {
    args.push('--from-format', options.fromFormat);
  }
  if (options.reportPath) {
    args.push('--report', options.reportPath);
  }
  if (options.configPath) {
    args.push('--config', options.configPath);
  }
  if (options.writeMapping) {
    args.push('--write-mapping');
  }
  if (!options.processBundles) {
    args.push('--no-process-bundles');
  }
  if (options.failOnWarning) {
    args.push('--fail-on-warning');
  }
  if (options.maxEntryMib !== undefined) {
    args.push('--max-entry-mib', String(options.maxEntryMib));
  }
  if (options.memoryBudgetMib !== undefined) {
    args.push('--memory-budget-mib', String(options.memoryBudgetMib));
  }
  if (options.queueCapacity !== undefined) {
    args.push('--queue-capacity', String(options.queueCapacity));
  }
  return args;
}

export function runTidas(
  spawnImpl: typeof spawnSync,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): TidasProcessResult {
  const run = spawnImpl(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    ...(input === undefined ? {} : { input, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }),
  }) as SpawnSyncReturns<string>;
  if (run.error) {
    throw new CliError(`Could not execute the Rust tidas binary: ${run.error.message}`, {
      code: 'DATASET_IMPORT_LCA_TIDAS_EXEC_FAILED',
      exitCode: 69,
      details: { executable },
    });
  }
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  };
}

export function readProcessReport(run: TidasProcessResult, reportPath: string | null): string {
  const cancelled = run.status === 130 || run.signal === 'SIGINT';
  if (reportPath) {
    if (!existsSync(reportPath)) {
      if (cancelled) {
        throw new CliError(
          'tidas import was cancelled before a complete machine report was available.',
          {
            code: 'DATASET_IMPORT_LCA_CANCELLED',
            exitCode: 130,
            details: { signal: run.signal, stderr: run.stderr },
          },
        );
      }
      throw new CliError(`tidas did not write the requested machine report: ${reportPath}`, {
        code: 'DATASET_IMPORT_LCA_TIDAS_REPORT_MISSING',
        exitCode: 70,
      });
    }
    return readFileSync(reportPath, 'utf8');
  }
  if (!run.stdout.trim()) {
    throw new CliError(
      cancelled
        ? 'tidas import was cancelled before a complete machine report was available.'
        : 'tidas did not emit a machine-readable operation report.',
      {
        code: cancelled
          ? 'DATASET_IMPORT_LCA_CANCELLED'
          : 'DATASET_IMPORT_LCA_TIDAS_REPORT_MISSING',
        exitCode: cancelled ? 130 : 70,
        details: { signal: run.signal, stderr: run.stderr },
      },
    );
  }
  return run.stdout;
}

export function parseOperationReport(
  text: string,
  command: 'version' | 'import' | 'convert',
): TidasOperationReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError('tidas emitted invalid JSON instead of its machine operation report.', {
      code: 'DATASET_IMPORT_LCA_TIDAS_REPORT_INVALID',
      exitCode: 70,
      details: String(error),
    });
  }
  if (
    !isRecord(value) ||
    value.schema_version !== OPERATION_REPORT_SCHEMA ||
    value.command !== command ||
    !includesValue(OPERATION_STATUSES, value.status) ||
    !isExitClass(value.exit_class) ||
    !includesValue(COMPLETENESS_VALUES, value.completeness) ||
    !isRecord(value.invocation) ||
    value.invocation.schema_version !== INVOCATION_CONTEXT_SCHEMA ||
    value.invocation.input_policy !== 'explicit-path-or-dash' ||
    !['stdout', 'file'].includes(String(value.invocation.report_destination)) ||
    value.invocation.diagnostic_destination !== 'stderr' ||
    !isRecord(value.summary) ||
    !Array.isArray(value.diagnostics) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.next_actions)
  ) {
    throw new CliError(
      `Incompatible tidas ${command} machine contract; expected ${OPERATION_REPORT_SCHEMA}.`,
      {
        code: 'DATASET_IMPORT_LCA_TIDAS_CONTRACT_INCOMPATIBLE',
        exitCode: 69,
      },
    );
  }
  return value as TidasOperationReport;
}

export function assertExitContract(run: TidasProcessResult, report: TidasOperationReport): void {
  const expected = EXIT_CODES[report.exit_class];
  if (run.status !== expected) {
    throw new CliError(
      `tidas exit status ${String(run.status)} disagrees with report exit class ${report.exit_class} (${expected}).`,
      {
        code: 'DATASET_IMPORT_LCA_TIDAS_EXIT_MISMATCH',
        exitCode: 70,
      },
    );
  }
}

export function readCompatibleVersion(
  report: TidasOperationReport,
  supportedVersion = SUPPORTED_TIDAS_VERSION,
  requirement = 'dataset import requires a stable contract-compatible 0.2.x release',
): string {
  if (
    report.status !== 'succeeded' ||
    report.exit_class !== 'success' ||
    report.completeness !== 'complete' ||
    report.summary.operation_report_schema !== OPERATION_REPORT_SCHEMA ||
    typeof report.summary.binary_version !== 'string' ||
    !supportedVersion.test(report.summary.binary_version)
  ) {
    throw new CliError(`Incompatible tidas binary: ${requirement}.`, {
      code: 'DATASET_IMPORT_LCA_TIDAS_VERSION_INCOMPATIBLE',
      exitCode: 69,
      details: { binary_version: report.summary.binary_version ?? null },
    });
  }
  return report.summary.binary_version;
}

function assertImportContract(report: TidasOperationReport): void {
  if (report.status === 'succeeded' || report.status === 'completed-with-issues') {
    const importSummary = report.summary.import;
    if (!isRecord(importSummary) || importSummary.schema_version !== IMPORT_REPORT_SCHEMA) {
      throw new CliError(`Incompatible tidas import summary; expected ${IMPORT_REPORT_SCHEMA}.`, {
        code: 'DATASET_IMPORT_LCA_TIDAS_IMPORT_CONTRACT_INCOMPATIBLE',
        exitCode: 69,
      });
    }
  }
}

function requireInputPath(value: string): string {
  if (!value?.trim()) {
    throw new CliError('Missing required --input value.', {
      code: 'DATASET_IMPORT_LCA_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw new CliError(`Input path not found: ${resolved}`, {
      code: 'DATASET_IMPORT_LCA_INPUT_NOT_FOUND',
      exitCode: 2,
    });
  }
  return resolved;
}

function requireOutputDir(value: string): string {
  if (!value?.trim()) {
    throw new CliError('Missing required --output-dir value.', {
      code: 'DATASET_IMPORT_LCA_OUTPUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }
  return path.resolve(value);
}

function normalizeSourceFormat(value: string | undefined): DatasetImportLcaSourceFormat | 'auto' {
  const format = value?.trim() || 'auto';
  if (format === 'auto' || includesValue(SOURCE_FORMATS, format)) {
    return format;
  }
  throw new CliError(`--from-format must be auto or one of: ${SOURCE_FORMATS.join(', ')}.`, {
    code: 'DATASET_IMPORT_LCA_SOURCE_FORMAT_INVALID',
    exitCode: 2,
  });
}

function normalizeTarget(value: string | undefined): DatasetImportLcaTarget {
  const target = value?.trim() || 'tidas';
  if (target === 'tidas' || target === 'ilcd' || target === 'both') {
    return target;
  }
  throw new CliError("--target must be 'tidas', 'ilcd', or 'both'.", {
    code: 'DATASET_IMPORT_LCA_TARGET_INVALID',
    exitCode: 2,
  });
}

export function resolveTidasBinary(
  explicitValue: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const candidate = explicitValue?.trim() || env.TIDAS_BIN?.trim() || 'tidas';
  if (path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) {
      throw new CliError(`Rust tidas binary not found: ${resolved}`, {
        code: 'DATASET_IMPORT_LCA_TIDAS_NOT_FOUND',
        exitCode: 69,
      });
    }
    return resolved;
  }
  return candidate;
}

export function assertSupportedPlatform(platform: NodeJS.Platform, arch: string): void {
  const supported =
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'win32' && arch === 'x64');
  if (!supported) {
    throw new CliError(`No supported Rust tidas artifact exists for ${platform}/${arch}.`, {
      code: 'DATASET_IMPORT_LCA_PLATFORM_UNSUPPORTED',
      exitCode: 69,
      details: {
        supported: ['linux/x64', 'linux/arm64', 'darwin/arm64', 'win32/x64'],
      },
    });
  }
}

function requirePositiveInteger(flag: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new CliError(`${flag} must be a positive integer.`, {
      code: 'DATASET_IMPORT_LCA_RUNTIME_BOUND_INVALID',
      exitCode: 2,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function isExitClass(value: unknown): value is TidasExitClass {
  return typeof value === 'string' && Object.hasOwn(EXIT_CODES, value);
}

export const __testInternals = {
  assertImportContract,
  assertSupportedPlatform,
  buildImportArgs,
  normalizeSourceFormat,
  normalizeTarget,
  parseOperationReport,
  readCompatibleVersion,
  readProcessReport,
  requirePositiveInteger,
  resolveTidasBinary,
};
