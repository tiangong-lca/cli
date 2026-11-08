import { CliError } from '../lib/errors.js';
import { CommandInputError } from './command-result.js';

export function commandFailure(error: unknown, fallbackCode: string) {
  const input = error instanceof CommandInputError;
  const known = input || error instanceof CliError;
  const invalidInput = input || (error instanceof CliError && error.exitCode === 2);
  const code = known ? error.code : fallbackCode;
  const conflict = /CONFLICT|STALE|MISMATCH/u.test(code);
  const unsupported = /UNSUPPORTED|CONTRACT_REQUIRED/u.test(code);
  const authentication = /AUTH|SESSION|LOGIN/u.test(code);
  const precondition = /VALIDATION_REQUIRED|REFERENCE_CHECK_FAILED/u.test(code);
  return {
    code,
    category: conflict
      ? 'conflict'
      : unsupported
        ? 'capability_unsupported'
        : authentication
          ? 'authentication'
          : precondition
            ? 'precondition'
            : invalidInput
              ? 'input'
              : 'service',
    message: input
      ? error.message
      : authentication
        ? 'Authentication or identity verification failed. Inspect auth doctor-auth in the selected environment.'
        : 'Operation failed. Inspect the command contract, target service and authentication.',
    exitCode: conflict || authentication || precondition ? 1 : invalidInput ? 2 : 1,
  };
}
