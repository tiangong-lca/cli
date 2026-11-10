import { CliError } from '../shared/errors.js';
import type { DotEnvLoadResult } from '../lib/dotenv.js';
type RootFlags = {
  help: boolean;
  version: boolean;
};

export function renderMainHelp(dotEnvStatus: DotEnvLoadResult): string {
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

export function parseCommandLine(args: string[]): CommandDispatch {
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
