import { parseArgs } from 'node:util';
import { result, CommandInputError, type CommandIO } from '../shared/command-result.js';
import { commandFailure } from '../shared/command-errors.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { text, type JsonObject } from '../application/dataset-types.js';
import { shellArgument } from '../shared/command-continuation.js';
export async function runCalculationCommand(
  args: string[],
  read: (directory: string, kind: string) => JsonObject | Promise<JsonObject>,
): Promise<CommandIO> {
  const action = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const value = result(`calculation${action ? ` ${action}` : ''}`);
  const json = args.includes('--json');
  try {
    if (action && !['get', 'result'].includes(action))
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Select calculation get or result.');
    const parsed = parseArgs({
      args: args.slice(action ? 1 : 0),
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        dir: { type: 'string' },
        ...(action === 'result'
          ? { kind: { type: 'string' as const }, output: { type: 'string' as const } }
          : {}),
      },
    });
    const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (new Set(names).size !== names.length)
      throw new CommandInputError('ARGUMENTS_INVALID', 'Repeated calculation option.');
    const flags = parsed.values;
    if (!action || flags.help) {
      const help = {
        command: value.operation,
        operations: ['get', 'result'],
        options:
          action === 'get'
            ? ['--dir <run-directory>', '--json']
            : [
                '--dir <run-directory>',
                '--kind lcia|lci|activities',
                '--output <new-file>',
                '--json',
              ],
        defaults: { kind: 'lcia', stdoutItems: 20 },
        effects:
          'Read an existing local Run without network, engine startup or recalculation. get reads the saved completion summary; result joins stored values with their stored axes. Large results require --output for complete delivery.',
        examples: [
          'tiangong-lca calculation get --dir run-1 --json',
          'tiangong-lca calculation result --dir run-1 --kind lci --output lci.json --json',
        ],
      };
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(help)}\n`
          : `${help.examples.join('\n')}\n\n${help.effects}\n`,
        stderr: '',
      };
    }
    const dir = text(flags.dir, '--dir');
    const kind = action === 'get' ? 'summary' : text(flags.kind ?? 'lcia', '--kind');
    if (action === 'result' && !['lci', 'lcia', 'activities'].includes(kind))
      throw new CommandInputError(
        'CALCULATION_KIND_INVALID',
        '--kind must be lci, lcia or activities.',
      );
    value.data = await read(dir, kind);
    value.outcome = 'calculation_read';
    value.summary = `Saved calculation ${action === 'get' ? 'status' : kind} read; no computation started.`;
    value.context = { execution: 'local', outputDirectory: value.data.outputDirectory };
    value.completeness = { scope: 'saved_run', truncated: false };
    if (action === 'result') {
      const items = value.data.items as unknown[];
      if (flags.output)
        value.artifacts.push(writeCommandOutput(text(flags.output, '--output'), value.data, false));
      if (flags.output || items.length > 20) {
        value.data = { ...value.data, items: flags.output ? undefined : items.slice(0, 20) };
        value.completeness = {
          scope: 'saved_run',
          total: items.length,
          returned: flags.output ? 0 : Math.min(20, items.length),
          truncated: !flags.output && items.length > 20,
          completeArtifact: !!flags.output,
        };
      }
    }
    value.nextActions = [
      {
        description: 'Read the full inventory from this Run.',
        command: `tiangong-lca calculation result --dir ${shellArgument(dir)} --kind lci --output lci.json --json`,
      },
    ];
    attachReplyTemplate(value, 'query-result');
    return renderResult(value, json, 0);
  } catch (error) {
    const f =
      error instanceof TypeError
        ? {
            code: 'ARGUMENTS_INVALID',
            category: 'input' as const,
            message: 'Invalid calculation arguments; inspect calculation --help.',
            exitCode: 2,
          }
        : commandFailure(error, 'CALCULATION_READ_FAILED');
    value.status = 'failed';
    value.summary = f.message;
    value.error = { code: f.code, category: f.category, message: f.message };
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, f.exitCode);
  }
}
