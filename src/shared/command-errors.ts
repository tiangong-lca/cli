import { CliError } from './errors.js';
import { CommandInputError } from './command-result.js';
import { commandErrorCategories } from './command-error-categories.js';

// These local builder diagnostics identify user-supplied inventory fields. Other legacy
// errors may contain transport or service details, so continue to redact them.
const modelInputDiagnostics = new Set([
  'LIFECYCLEMODEL_PROCESS_IDENTITY_MISMATCH',
  'LIFECYCLEMODEL_CONNECTION_MAPPING_UNSUPPORTED',
  'LIFECYCLEMODEL_CONNECTION_VERSION_MISMATCH',
  'LIFECYCLEMODEL_VARIABLE_INVENTORY_UNSUPPORTED',
  'LIFECYCLEMODEL_QUANTITY_BASIS_CONFLICT',
  'LIFECYCLEMODEL_ALLOCATION_QUANTITY_BASIS_CONFLICT',
]);

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
    message:
      input || (legacy && modelInputDiagnostics.has(code))
        ? error.message
        : category === 'authentication'
          ? 'Authentication or identity verification failed. Inspect auth doctor-auth in the selected environment.'
          : 'Operation failed. Inspect the command contract, target service and authentication.',
    exitCode: [
      'conflict',
      'authentication',
      'precondition',
      'not_found_or_not_visible',
      'environment',
    ].includes(category)
      ? 1
      : invalidInput
        ? 2
        : 1,
  };
}
