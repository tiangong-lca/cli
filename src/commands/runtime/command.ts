import { parseArgs } from 'node:util';
import type { FetchLike } from '../../lib/http.js';
import { runRuntimeExecCommand } from './exec-command.js';
import { runManagedRuntimeCommand } from './managed-command.js';
import { CliError } from '../../shared/errors.js';
import { describeCliRuntime } from '../../runtime.js';
import type { CliRuntimeDescriptor } from '../../lib/runtime/types.js';

export function isRuntimeCommand(argv: readonly string[]): boolean {
  let index = 0;
  while (['--help', '-h', '--version', '-v'].includes(argv[index] ?? '')) index += 1;
  if (argv[index] === '--') index += 1;
  return argv[index] === 'runtime';
}

export async function runRuntimeCommand(
  subcommand: string | null,
  args: string[],
  describe: () => CliRuntimeDescriptor = describeCliRuntime,
  fetchImpl?: FetchLike,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (subcommand === 'exec') return runRuntimeExecCommand(args, fetchImpl, env);
  if (subcommand && ['ensure', 'status', 'prune', 'lease-release'].includes(subcommand))
    return runManagedRuntimeCommand(subcommand, args, fetchImpl);
  let flags: { help?: boolean; json?: boolean };
  try {
    flags = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
      },
    }).values;
  } catch {
    throw new CliError('Runtime commands accept only their declared flags.', {
      code: 'RUNTIME_ARGUMENT_INVALID',
      exitCode: 2,
    });
  }
  if (!subcommand || flags.help)
    return {
      exitCode: 0,
      stdout:
        'Usage: tiangong-lca runtime describe [--json] | ensure | status | prune | lease-release | exec\n\nDescribe the installed CLI package, assets and Node executable. No authentication, user env file or download.\n',
      stderr: '',
    };
  if (subcommand !== 'describe')
    throw new CliError('Unknown runtime operation.', {
      code: 'RUNTIME_OPERATION_UNKNOWN',
      exitCode: 2,
    });
  const descriptor = describe();
  return {
    exitCode: 0,
    stdout: flags.json
      ? `${JSON.stringify(descriptor)}\n`
      : `CLI ${descriptor.package.version} (${descriptor.platform})\nNode ${descriptor.node.version}\nContent ${descriptor.content_sha256}\n`,
    stderr: '',
  };
}
