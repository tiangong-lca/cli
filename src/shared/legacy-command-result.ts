import { CliError, toErrorPayload } from './errors.js';
import type { CommandIO as CliResult } from './command-result.js';
/** Project a failure consistently at the process IO boundary. */
export function cliFailure(error: unknown): CliResult {
  return {
    exitCode: error instanceof CliError ? error.exitCode : 1,
    stdout: '',
    stderr: `${JSON.stringify(toErrorPayload(error))}\n`,
  };
}
