import { runDatasetCommand, runDatasetHelp } from './commands/dataset.js';
import { createDatasetPorts } from './adapters/dataset.js';
import { datasetTypes } from './application/dataset-types.js';
import { runReviewCommand } from './commands/review.js';
import { reviewReader } from './adapters/review-read.js';
import { reviewWriter } from './adapters/review-write.js';
import { reviewMaterials } from './adapters/review-materials.js';
import { runAuthCommand } from './commands/auth.js';
import { runDoctorCommand } from './commands/doctor.js';
import { doctorPorts } from './adapters/doctor.js';
import { runClassificationCommand } from './commands/classification.js';
import { rootHelp } from './commands/help.js';
import { runRuntimeCommand } from './lib/runtime/command.js';
import { runPcrCommand } from './lib/pcr-snapshot-command.js';
import { runStudyCommand } from './lib/study-command.js';
import { readRuntimeEnv } from './lib/env.js';
import type { DotEnvLoadResult } from './lib/dotenv.js';
import { CliError } from './lib/errors.js';
import { loadCliPackageVersion } from './lib/package-version.js';
import {
  runDatasetClassificationChildren,
  runDatasetClassificationPath,
} from './lib/dataset-classification.js';

import { cliFailure, type CliDeps, type CliResult } from './cli-deps.js';
import { executeAuthService } from './commands/auth-service.js';
import { executeReleaseCommand } from './commands/release.js';
import { executeAdminCommand } from './commands/admin.js';
import { executePackageTool } from './commands/package-tools.js';
import { executeClassificationMaintenance } from './commands/classification-maintenance.js';
import { executeMaintenanceCommand } from './commands/maintenance.js';
export type { CliDeps, CliResult } from './cli-deps.js';
type RootFlags = {
  help: boolean;
  version: boolean;
};

function renderMainHelp(dotEnvStatus: DotEnvLoadResult): string {
  return `TianGong LCA CLI

Unified TianGong command entrypoint.

Usage:
  tiangong-lca <command> [subcommand] [options]

Implemented Commands:
  doctor     environment diagnostics
  auth       login | status | whoami | doctor-auth | logout | identity-receipt
  dataset    <flow|process|model|source|contact|flowproperty|unitgroup|lciamethod> <action>
  review     submit | resubmit | get | list | materials | comment | decide
  release    prepare | upload | finalize | approve | publish | readback-verify | unpublish | status | current | calculation-bundle | calculation-artifact | artifact-download

Dataset discovery and content:
  get | list | search | versions | contract | list-references | validate
  diff | patch | translations extract/apply
  create | save | delete (type-specific, existing service safeguards)
  model graph | model build-resulting-process (alias aggregate)
  process statistics | source upload-attachments
  Actions are type-specific. Use dataset <type> <action> --help --json.

Runtime support:
  runtime    describe | ensure | status | prune | lease-release | exec
  pcr        snapshot ensure | snapshot status | exec

Examples:
  tiangong-lca auth whoami --json
  tiangong-lca auth identity-receipt --json
  tiangong-lca dataset flow search --query electricity --json
  tiangong-lca dataset process get --id <id> --version <version> --output process.json --json
  tiangong-lca dataset process validate --input process.json --json
  tiangong-lca dataset model aggregate --help --json
  tiangong-lca review --help --json

Use --json for one machine-readable result and --output for complete content/artifacts.
Inspect command help for input, effects, unsupported capabilities and recovery.

Environment:
  .env loaded: ${dotEnvStatus.loaded ? `yes (${dotEnvStatus.path}, ${dotEnvStatus.count} keys)` : 'no'}
`.trim();
}

type CommandDispatch = {
  flags: RootFlags;
  command: string | null;
  subcommand: string | null;
  commandArgs: string[];
};

function parseCommandLine(args: string[]): CommandDispatch {
  const flags: RootFlags = {
    help: false,
    version: false,
  };

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      index += 1;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.version = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`Unknown root option: ${arg}`, {
        code: 'UNKNOWN_ROOT_OPTION',
        exitCode: 2,
      });
    }
    break;
  }

  const command = args[index] ?? null;
  if (!command) {
    return {
      flags,
      command: null,
      subcommand: null,
      commandArgs: [],
    };
  }

  const maybeSubcommand = args[index + 1];
  const subcommand = maybeSubcommand && !maybeSubcommand.startsWith('-') ? maybeSubcommand : null;
  const commandArgs = args.slice(index + 1 + (subcommand ? 1 : 0));

  return {
    flags,
    command,
    subcommand,
    commandArgs,
  };
}

function unknownCommand(command: string, subcommand?: string): CliResult {
  const selected = subcommand ? `${command} ${subcommand}` : command;
  return cliFailure(
    new CliError(`Unknown command '${selected}'. Inspect tiangong-lca --help --json.`, {
      code: 'UNKNOWN_COMMAND',
      exitCode: 2,
    }),
  );
}
export async function executeCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  if (argv[0] === '--' && ['dataset', 'review', 'auth', 'doctor'].includes(argv[1] ?? ''))
    argv = argv.slice(1);
  if (
    argv.includes('--json') &&
    argv.every((arg) => ['help', '--help', '-h', '--json'].includes(arg))
  )
    return rootHelp(renderMainHelp(deps.dotEnvStatus));
  if (argv[0] === '--json' && ['dataset', 'review', 'auth', 'doctor'].includes(argv[1]!))
    argv = [...argv.slice(1), '--json'];
  if (argv[0] === 'auth')
    return runAuthCommand(
      argv.slice(1),
      (args) => {
        const { subcommand, commandArgs } = parseCommandLine(['auth', ...args]);
        return executeAuthService(subcommand, commandArgs, deps);
      },
      readRuntimeEnv(deps.env).apiBaseUrl,
    );
  return executeCore(argv, deps);
}
async function executeCore(argv: string[], deps: CliDeps): Promise<CliResult> {
  try {
    if (argv[0] === 'dataset' && (!argv[1] || argv[1].startsWith('-')))
      return runDatasetHelp(argv.slice(1));
    if (argv[0] === 'review')
      return await runReviewCommand(argv.slice(1), reviewReader(deps.env, deps.fetchImpl), {
        mutate: reviewWriter(deps.env, deps.fetchImpl),
        materials: reviewMaterials(deps.env, deps.fetchImpl),
      });
    if (argv[0] === 'dataset' && datasetTypes.includes(argv[1] as (typeof datasetTypes)[number])) {
      return await runDatasetCommand(argv.slice(1), createDatasetPorts(deps.env, deps.fetchImpl));
    }
    if (
      argv[0] === 'dataset' &&
      argv[1] === 'classification' &&
      !['audit', 'apply'].includes(argv[2] ?? '')
    )
      return runClassificationCommand(argv.slice(2), {
        children: deps.runDatasetClassificationChildrenImpl ?? runDatasetClassificationChildren,
        path: deps.runDatasetClassificationPathImpl ?? runDatasetClassificationPath,
      });
    const { flags, command, subcommand, commandArgs } = parseCommandLine(argv);
    if (flags.version)
      return { exitCode: 0, stdout: `${loadCliPackageVersion(import.meta.url)}\n`, stderr: '' };
    if (!command || command === 'help' || flags.help)
      return { exitCode: 0, stdout: `${renderMainHelp(deps.dotEnvStatus)}\n`, stderr: '' };
    if (command === 'runtime')
      return await runRuntimeCommand(subcommand, commandArgs, undefined, deps.fetchImpl, deps.env);
    if (command === 'pcr')
      return await runPcrCommand(subcommand, commandArgs, deps.fetchImpl, deps.env);
    if (command === 'study')
      return await runStudyCommand(subcommand, commandArgs, deps.fetchImpl, deps.env);
    if (command === 'doctor')
      return runDoctorCommand(
        commandArgs,
        doctorPorts(deps.env, deps.dotEnvStatus, deps.fetchImpl),
      );
    if (command === 'dataset' && subcommand === 'maintenance')
      return await executeMaintenanceCommand(commandArgs, deps);
    if (command === 'dataset' && subcommand === 'classification')
      return await executeClassificationMaintenance(commandArgs, deps);
    if ((command === 'dataset' && subcommand === 'import-lca') || command === 'validation')
      return await executePackageTool(command, subcommand, commandArgs, deps);
    if (command === 'release') return await executeReleaseCommand(subcommand, commandArgs, deps);
    if (command === 'admin') return await executeAdminCommand(subcommand, commandArgs, deps);
    return unknownCommand(command, subcommand ?? undefined);
  } catch (error) {
    return cliFailure(error);
  }
}
