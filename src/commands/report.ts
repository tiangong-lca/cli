import { parseArgs } from 'node:util';
import { parseResearchReport, type ReportPort } from '../application/report.js';
import { readCommandInput } from '../shared/command-files.js';
import { CommandInputError, result, type CommandIO } from '../shared/command-result.js';
import { commandFailure } from '../shared/command-errors.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';

export function runReportCommand(args: string[], write: ReportPort): CommandIO {
  const value = result('report render');
  const json = args.includes('--json');
  try {
    const action = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
    if (action && action !== 'render')
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Supported report action: render.');
    const parsed = parseArgs({
      args: args.slice(action ? 1 : 0),
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        input: { type: 'string' },
        output: { type: 'string' },
        force: { type: 'boolean' },
      },
    });
    const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (new Set(names).size !== names.length)
      throw new CommandInputError('ARGUMENTS_INVALID', 'Repeated report option.');
    const flags = parsed.values;
    if (!action || flags.help) {
      const help = {
        command: 'report render',
        purpose:
          'Render supplied research content as one offline interactive HTML report. No research, translation, calculation, remote reads or publication.',
        options: ['--input <report.json|->', '--output <report.html>', '--force', '--json'],
        input: {
          title: 'text or {en,zh}',
          subtitle: 'optional text or {en,zh}',
          language: 'en | zh (default)',
          sections: '[{title,body?,sources?,table?:{columns,rows}}]',
          sources: '[{id,title,url?,note?}]',
          model:
            '{nodes:[{id,label,kind?,details?,inputs?,outputs?,sources?}],edges:[{id,from,to,label,amount?,unit?,details?}]}',
          results: '[{label,value,unit,method?}]',
          limitations: '[text]',
        },
        defaults:
          'Only title is required. Text is escaped plain text; no HTML or Markdown execution. Untranslated text remains visible with its language label. No automatic links/providers or per-node contribution inference.',
        output:
          'Self-contained HTML with single-language Chinese/English switching, graph detail links, table filtering, and complete print layout. Print / Save as PDF uses the reader’s browser; this command writes HTML only.',
        example: 'tiangong-lca report render --input report.json --output report.html --json',
        exampleInput: {
          title: { en: 'Product study', zh: '产品研究' },
          sections: [
            {
              title: { en: 'Goal and scope', zh: '目标与范围' },
              body: {
                en: 'One product; assumptions remain explicit.',
                zh: '一个产品；明确说明假设。',
              },
            },
          ],
        },
      };
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(help)}\n`
          : `${help.example}\n\n${help.purpose}\n${help.output}\nUse --help --json for the input shape and example.\n`,
        stderr: '',
      };
    }
    if (!flags.input?.trim() || !flags.output?.trim())
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'report render requires --input and --output.',
      );
    const report = parseResearchReport(readCommandInput(flags.input));
    value.artifacts = [write(report, flags.output, flags.force === true, flags.input)];
    value.data = {
      sections: report.sections.length,
      nodes: report.model?.nodes.length ?? 0,
      edges: report.model?.edges.length ?? 0,
      results: report.results.length,
      sources: report.sources.length,
      language: report.language,
    };
    value.outcome = 'report_rendered';
    value.summary = 'Interactive HTML report generated from the supplied content.';
    value.completeness = {
      scope: 'presentation_only',
      offline: true,
      scientificValidation: false,
      translation: false,
      pdf: 'browser_print',
      remoteMutation: false,
    };
    value.nextActions = [
      {
        description:
          'Open the HTML artifact, inspect model/details and language, then use Print / Save as PDF. Print includes all table rows and details.',
      },
    ];
    attachReplyTemplate(value, 'operation-completed');
    return renderResult(value, json, 0);
  } catch (error) {
    const failure =
      error instanceof TypeError
        ? {
            code: 'ARGUMENTS_INVALID',
            category: 'input' as const,
            message: 'Invalid report arguments; inspect report render --help --json.',
            exitCode: 2,
          }
        : commandFailure(error, 'REPORT_RENDER_FAILED');
    value.status = 'failed';
    value.summary = failure.message;
    value.error = { code: failure.code, category: failure.category, message: failure.message };
    value.nextActions = [
      {
        description: 'Inspect the report input and file effects.',
        command: 'tiangong-lca report render --help --json',
      },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}
