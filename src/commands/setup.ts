import { parseArgs } from 'node:util';
import { result, CommandInputError, type CommandIO } from '../shared/command-result.js';
import { commandFailure } from '../shared/command-errors.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import type { JsonObject } from '../application/dataset-types.js';
export async function runSetupCommand(
  args: string[],
  setup: (request: JsonObject) => JsonObject | Promise<JsonObject>,
): Promise<CommandIO> {
  const value = result('setup model-calculation');
  const json = args.includes('--json');
  try {
    const action = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
    if (action && action !== 'model-calculation')
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Supported setup: model-calculation.');
    const parsed = parseArgs({
      args: args.slice(action ? 1 : 0),
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        check: { type: 'boolean' },
        install: { type: 'string' },
        engine: { type: 'string' },
        'static-cache': { type: 'string' },
      },
    });
    const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (new Set(names).size !== names.length)
      throw new CommandInputError('ARGUMENTS_INVALID', 'Repeated setup option.');
    const flags = parsed.values;
    if (!action || flags.help) {
      const help = {
        command: 'setup model-calculation',
        options: [
          '--install <package-directory>',
          '--engine <executable>',
          '--static-cache <directory>',
          '--check',
          '--json',
        ],
        defaults: { check: false, timeoutMs: 120000 },
        effects:
          'Install an explicitly trusted local Model package (macOS ARM64, Linux glibc x64/ARM64, Windows x64), including native dependencies and LCIA methods, or configure existing engine/cache paths. Save configuration only after a successful readiness check. --install cannot be combined with path options or --check. --check is read-only. No login, download, database or queue is needed. Previous installations and Runs are retained.',
        example:
          'tiangong-lca setup model-calculation --install /path/to/model-runtime-package --json',
        next: 'dataset model calculate --file input.json --output-dir run-1 --json',
      };
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(help)}\n`
          : `${help.example}\n\n${help.effects}\nNext: ${help.next}\n`,
        stderr: '',
      };
    }
    value.data = await setup({
      engine: flags.engine,
      staticCache: flags['static-cache'],
      check: flags.check === true,
      install: flags.install,
    });
    value.outcome = flags.check ? 'environment_checked' : 'environment_configured';
    value.summary = flags.check
      ? 'Local Model engine and factor cache are ready; configuration unchanged.'
      : 'Local Model environment is ready and saved for subsequent calculations.';
    value.nextActions = [
      {
        description: 'Calculate a prepared local Model.',
        command: 'tiangong-lca dataset model calculate --file input.json --output-dir run-1 --json',
      },
    ];
    attachReplyTemplate(value, 'operation-completed');
    return renderResult(value, json, 0);
  } catch (error) {
    const f =
      error instanceof TypeError
        ? {
            code: 'ARGUMENTS_INVALID',
            category: 'input' as const,
            message: 'Invalid setup arguments; inspect setup --help.',
            exitCode: 2,
          }
        : commandFailure(error, 'SETUP_FAILED');
    value.status = 'failed';
    value.summary = f.message;
    value.error = { code: f.code, category: f.category, message: f.message };
    value.nextActions = [
      {
        description: 'Inspect setup inputs and effects.',
        command: 'tiangong-lca setup model-calculation --help --json',
      },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, f.exitCode);
  }
}
