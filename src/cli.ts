import { renderMainHelp, parseCommandLine } from './commands/root.js';
import { composeCliDeps } from './cli-composition.js';
import type { ResolvedCliDeps } from './cli-deps.js';
import { normalizeRootArguments } from './commands/root-arguments.js';
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
import { runRuntimeCommand } from './commands/runtime/command.js';
import { runPcrCommand } from './commands/pcr.js';
import { runStudyCommand } from './commands/study.js';
import { readRuntimeEnv } from './lib/config/env.js';
import { CliError } from './shared/errors.js';
import { loadCliPackageVersion } from './lib/platform/package-version.js';

import { cliFailure, type CliDeps, type CliResult } from './cli-deps.js';
import { executeAuthService } from './commands/auth-service.js';
import { executeReleaseCommand } from './commands/release.js';
import { executeAdminCommand } from './commands/admin.js';
import { executePackageTool } from './commands/package-tools.js';
import { executeClassificationMaintenance } from './commands/classification-maintenance.js';
import { executeMaintenanceCommand } from './commands/maintenance.js';
export type { CliDeps, CliResult } from './cli-deps.js';
function unknownCommand(command: string, subcommand?: string): CliResult {
  const selected = subcommand ? `${command} ${subcommand}` : command;
  return cliFailure(
    new CliError(`Unknown command '${selected}'. Inspect tiangong-lca --help --json.`, {
      code: 'UNKNOWN_COMMAND',
      exitCode: 2,
    }),
  );
}
export async function executeCli(argv: string[], input: CliDeps): Promise<CliResult> {
  const deps = composeCliDeps(input);
  argv = normalizeRootArguments(argv);
  if (
    argv.includes('--json') &&
    argv.every((arg) => ['help', '--help', '-h', '--json'].includes(arg))
  )
    return rootHelp(renderMainHelp(deps.dotEnvStatus));

  if (argv[0] === 'auth')
    return runAuthCommand(
      argv.slice(1),
      (args) => {
        const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : null;
        return executeAuthService(subcommand, subcommand ? args.slice(1) : args, deps);
      },
      readRuntimeEnv(deps.env).apiBaseUrl,
    );
  return executeCore(argv, deps);
}
async function executeCore(argv: string[], deps: ResolvedCliDeps): Promise<CliResult> {
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
        children: deps.runDatasetClassificationChildrenImpl,
        path: deps.runDatasetClassificationPathImpl,
      });
    const { flags, command, subcommand, commandArgs } = parseCommandLine(argv);
    if (flags.version)
      return { exitCode: 0, stdout: `${loadCliPackageVersion(import.meta.url)}\n`, stderr: '' };
    if (!command || command === 'help' || flags.help)
      return { exitCode: 0, stdout: `${renderMainHelp(deps.dotEnvStatus)}\n`, stderr: '' };
    const handlers: Record<string, () => CliResult | Promise<CliResult>> = {
      runtime: () =>
        runRuntimeCommand(subcommand, commandArgs, undefined, deps.fetchImpl, deps.env),
      pcr: () => runPcrCommand(subcommand, commandArgs, deps.fetchImpl, deps.env),
      study: () => runStudyCommand(subcommand, commandArgs, deps.fetchImpl, deps.env),
      doctor: () =>
        runDoctorCommand(commandArgs, doctorPorts(deps.env, deps.dotEnvStatus, deps.fetchImpl)),
      dataset: () => {
        if (subcommand === 'maintenance') return executeMaintenanceCommand(commandArgs, deps);
        if (subcommand === 'classification')
          return executeClassificationMaintenance(commandArgs, deps);
        if (subcommand === 'import-lca')
          return executePackageTool(command, subcommand, commandArgs, deps);
        return unknownCommand(command, subcommand!);
      },
      validation: () => executePackageTool(command, subcommand, commandArgs, deps),
      release: () => executeReleaseCommand(subcommand, commandArgs, deps),
      admin: () => executeAdminCommand(subcommand, commandArgs, deps),
    };
    if (Object.hasOwn(handlers, command)) return await handlers[command]();
    return unknownCommand(command, subcommand ?? undefined);
  } catch (error) {
    return cliFailure(error);
  }
}
