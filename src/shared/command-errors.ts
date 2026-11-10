import { CliError } from './errors.js';
import { CommandInputError } from './command-result.js';
import { commandErrorCategories } from './command-error-categories.js';

export function commandFailure(error: unknown, fallbackCode: string) {
  const input = error instanceof CommandInputError;
  const legacy = error instanceof CliError;
  const code = input || legacy ? error.code : fallbackCode;
  const invalidInput = input || (legacy && error.exitCode === 2);
  const category = input
    ? error.category
    : (commandErrorCategories.get(code) ?? (invalidInput ? 'input' : 'service'));
  return {
    code,
    category,
    message: input
      ? error.message
      : category === 'authentication'
        ? 'Authentication or identity verification failed. Inspect auth doctor-auth in the selected environment.'
        : 'Operation failed. Inspect the command contract, target service and authentication.',
    exitCode: ['conflict', 'authentication', 'precondition'].includes(category)
      ? 1
      : invalidInput
        ? 2
        : 1,
  };
}
