import { parseArgs } from 'node:util';
import { CliError } from '../lib/errors.js';
import { stringifyJson } from '../lib/io.js';
import { runValidation } from '../lib/validation.js';
import { runDatasetImportLcaConvert } from '../lib/dataset-import-lca.js';

import type { CliDeps, CliResult } from '../cli-deps.js';
function renderValidationHelp(): string {
  return `Usage:
  tiangong-lca validation run --input-dir <dir> [options]

Options:
  --input-dir <dir>    TIDAS package directory
  --engine <mode>      auto | sdk (default: auto)
  --report-file <file> Write the structured validation report to a file
  --json               Print compact JSON
  -h, --help
`.trim();
}

function renderDatasetImportLcaHelp(): string {
  return `Usage:
  tiangong-lca dataset import-lca convert --input <path> --output-dir <dir> [options]

Options:
  --input <path>          Source file, directory, or package to import
  --output-dir <dir>      Output directory atomically published by tidas
  --from-format <format>  auto, ecospold1, ecospold2, openlca-jsonld, openlca-process-xlsx, simapro-csv, ilcd
  --target <target>       tidas | ilcd | both (default: tidas)
  --report <file>         Persist the native operation report atomically instead of using tidas stdout
  --write-mapping         Write deterministic mapping.csv.gz
  --no-process-bundles    Disable per-process dependency bundle generation
  --fail-on-warning       Return non-zero when converter warnings are present
  --max-entry-mib <n>     Maximum source-entry size in MiB (tidas default: 128)
  --memory-budget-mib <n> Maximum accounted in-flight memory in MiB (tidas default: 512)
  --queue-capacity <n>    Maximum items in each bounded queue (tidas default: 256)
  --tidas-bin <path>      Rust tidas executable (default: TIDAS_BIN, then tidas on PATH)
  --tidas-config <path>   Explicit tidas config file (otherwise TIDAS_CONFIG is honored)
  --json                  Print compact JSON
  -h, --help

Outputs written under --output-dir:
  - import-report.json and issues.jsonl
  - tidas/ when target includes TIDAS
  - ilcd/ when target includes ILCD
  - process-bundles/ by default
  - mapping.csv.gz when --write-mapping is used

Runtime contract:
  - Linux x86_64/ARM64, macOS Apple Silicon (arm64), and Windows x86_64 are supported.
  - Windows ARM64 is unsupported.
  - The binary must report tidas.operation-report.v1 and a stable 0.2.x version.
  - Import publication, cancellation cleanup, and domain validation remain owned by Rust tidas.
`.trim();
}

function parseValidationFlags(args: string[]): {
  help: boolean;
  json: boolean;
  inputDir: string;
  engine: string | undefined;
  reportFile: string | null;
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
        'input-dir': { type: 'string' },
        engine: { type: 'string' },
        'report-file': { type: 'string' },
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
    inputDir: typeof values['input-dir'] === 'string' ? values['input-dir'] : '',
    engine: typeof values.engine === 'string' ? values.engine : undefined,
    reportFile: typeof values['report-file'] === 'string' ? values['report-file'] : null,
  };
}

function parseDatasetImportLcaConvertFlags(args: string[]): {
  help: boolean;
  json: boolean;
  inputPath: string;
  outputDir: string;
  fromFormat: string | undefined;
  target: string | undefined;
  reportPath: string | undefined;
  writeMapping: boolean;
  processBundles: boolean | undefined;
  failOnWarning: boolean;
  maxEntryMib: number | undefined;
  memoryBudgetMib: number | undefined;
  queueCapacity: number | undefined;
  tidasBin: string | undefined;
  tidasConfig: string | undefined;
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
        input: { type: 'string' },
        'output-dir': { type: 'string' },
        'from-format': { type: 'string' },
        target: { type: 'string' },
        report: { type: 'string' },
        'write-mapping': { type: 'boolean' },
        'no-process-bundles': { type: 'boolean' },
        'fail-on-warning': { type: 'boolean' },
        'max-entry-mib': { type: 'string' },
        'memory-budget-mib': { type: 'string' },
        'queue-capacity': { type: 'string' },
        'tidas-bin': { type: 'string' },
        'tidas-config': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  const maxEntryMib = parsePositiveIntegerFlag(values['max-entry-mib'], '--max-entry-mib');
  const memoryBudgetMib = parsePositiveIntegerFlag(
    values['memory-budget-mib'],
    '--memory-budget-mib',
  );
  const queueCapacity = parsePositiveIntegerFlag(values['queue-capacity'], '--queue-capacity');

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    inputPath: typeof values.input === 'string' ? values.input : '',
    outputDir: typeof values['output-dir'] === 'string' ? values['output-dir'] : '',
    fromFormat: typeof values['from-format'] === 'string' ? values['from-format'] : undefined,
    target: typeof values.target === 'string' ? values.target : undefined,
    reportPath: typeof values.report === 'string' ? values.report : undefined,
    writeMapping: Boolean(values['write-mapping']),
    processBundles: values['no-process-bundles'] ? false : undefined,
    failOnWarning: Boolean(values['fail-on-warning']),
    maxEntryMib,
    memoryBudgetMib,
    queueCapacity,
    tidasBin: typeof values['tidas-bin'] === 'string' ? values['tidas-bin'] : undefined,
    tidasConfig: typeof values['tidas-config'] === 'string' ? values['tidas-config'] : undefined,
  };
}

function parsePositiveIntegerFlag(value: unknown, flag: string): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive integer.`, {
      code: 'DATASET_IMPORT_LCA_RUNTIME_BOUND_INVALID',
      exitCode: 2,
    });
  }
  return parsed;
}

export async function executePackageTool(
  command: string,
  subcommand: string | null,
  commandArgs: string[],
  deps: CliDeps,
): Promise<CliResult> {
  const validationImpl = deps.runValidationImpl ?? runValidation;
  const datasetImportLcaConvertImpl =
    deps.runDatasetImportLcaConvertImpl ?? runDatasetImportLcaConvert;
  if (command === 'dataset' && subcommand === 'import-lca') {
    const action = commandArgs[0] ?? '';
    if (!action || action === '--help' || action === '-h') {
      return { exitCode: 0, stdout: `${renderDatasetImportLcaHelp()}\n`, stderr: '' };
    }
    if (action !== 'convert') {
      throw new CliError("dataset import-lca action must be 'convert'.", {
        code: 'DATASET_IMPORT_LCA_ACTION_INVALID',
        exitCode: 2,
      });
    }
    const datasetFlags = parseDatasetImportLcaConvertFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return { exitCode: 0, stdout: `${renderDatasetImportLcaHelp()}\n`, stderr: '' };
    }
    const report = await datasetImportLcaConvertImpl({
      inputPath: datasetFlags.inputPath,
      outputDir: datasetFlags.outputDir,
      fromFormat: datasetFlags.fromFormat,
      target: datasetFlags.target,
      reportPath: datasetFlags.reportPath,
      writeMapping: datasetFlags.writeMapping,
      processBundles: datasetFlags.processBundles,
      failOnWarning: datasetFlags.failOnWarning,
      maxEntryMib: datasetFlags.maxEntryMib,
      memoryBudgetMib: datasetFlags.memoryBudgetMib,
      queueCapacity: datasetFlags.queueCapacity,
      tidasBin: datasetFlags.tidasBin,
      tidasConfig: datasetFlags.tidasConfig,
      env: deps.env,
    });
    return {
      exitCode: report.exit_code,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }

  if (command === 'validation' && !subcommand && commandArgs.includes('--help')) {
    return { exitCode: 0, stdout: `${renderValidationHelp()}\n`, stderr: '' };
  }

  if (command === 'validation' && subcommand === 'run') {
    const validationFlags = parseValidationFlags(commandArgs);
    if (validationFlags.help) {
      return { exitCode: 0, stdout: `${renderValidationHelp()}\n`, stderr: '' };
    }

    const report = await validationImpl({
      inputDir: validationFlags.inputDir,
      engine: validationFlags.engine,
      reportFile: validationFlags.reportFile,
    });

    return {
      exitCode: report.ok ? 0 : 1,
      stdout: stringifyJson(report, validationFlags.json),
      stderr: '',
    };
  }

  throw new CliError('Unknown package tool action.', { code: 'UNKNOWN_COMMAND', exitCode: 2 });
}
