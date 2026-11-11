import { CliError } from '../../shared/errors.js';
import { BatchRunLockIdentityConflictError, BatchRunLockTimeoutError } from './errors.js';

/** Project only known lock failures; public classes and private owner metadata stay unchanged. */
export function runLockCommandError(error: unknown): unknown {
  if (error instanceof BatchRunLockIdentityConflictError)
    return new CliError('Another identity holds the selected run lock.', {
      code: error.code,
      exitCode: 1,
    });
  if (error instanceof BatchRunLockTimeoutError)
    return new CliError('The selected run lock could not be acquired within the timeout.', {
      code: error.code,
      exitCode: 1,
    });
  return error;
}
