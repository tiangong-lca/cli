import { parseArgs } from 'node:util';
import type {
  DatasetClassificationChildrenReport,
  DatasetClassificationPathReport,
} from '../lib/dataset/classification.js';
import { text } from '../application/dataset-types.js';
import { contentDigest } from '../application/dataset-content.js';
import { queryCursor, nextCursor } from '../application/dataset-discovery.js';
import { shellArgument } from '../shared/command-continuation.js';
import { result, CommandInputError, type CommandIO } from '../shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { commandFailure } from '../shared/command-errors.js';

type ClassificationPorts = {
  children(request: {
    type: string;
    parent?: string;
    query?: string;
    limit: null;
    outDir: null;
  }): Promise<DatasetClassificationChildrenReport>;
  path(request: {
    type: string;
    code: string;
    outDir: null;
  }): Promise<DatasetClassificationPathReport>;
};
export async function runClassificationCommand(
  args: string[],
  ports: ClassificationPorts,
): Promise<CommandIO> {
  const action = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const json = args.includes('--json');
  const value = result(`dataset classification${action ? ` ${action}` : ''}`);
  try {
    if (action && !['children', 'path'].includes(action))
      throw new CommandInputError(
        'CAPABILITY_UNSUPPORTED',
        'Select classification children or path.',
      );
    let parsed: ReturnType<typeof parseArgs>;
    try {
      const allowed = [
        'help',
        'json',
        ...(action ? ['type', 'output', 'force'] : []),
        ...(action === 'children'
          ? ['parent', 'query', 'limit', 'cursor']
          : action === 'path'
            ? ['code']
            : []),
      ];
      parsed = parseArgs({
        args: action ? args.slice(1) : args,
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: Object.fromEntries(
          allowed.map((name) => [
            name,
            {
              type: ['help', 'json', 'force'].includes(name) ? 'boolean' : 'string',
              ...(name === 'help' ? { short: 'h' } : {}),
            },
          ]),
        ),
      });
      const names = parsed
        .tokens!.filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('duplicate');
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, duplicated or malformed classification option. Inspect --help.',
      );
    }
    const flags = parsed.values;
    const helpManifest = {
      schemaVersion: 1,
      command: `dataset classification${action ? ` ${action}` : ''}`,
      actions: ['children', 'path'],
      input: {
        type: 'TIDAS classification directory, including location',
        children: '--parent, --query, --limit 1..100 (default 20), --cursor',
        path: '--code',
      },
      output:
        'Shared query result. --output writes the complete selected report; --force only replaces a separate local file.',
      effects: 'Read bundled classification assets only; no network or dataset mutation.',
      scope:
        'Direct children or the exact selected code path, bound to local directory content. No class is automatically assigned.',
    };
    if (!action || flags.help)
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(helpManifest)}\n`
          : 'Usage:\n  tiangong-lca dataset classification children --type <type> [--parent <code>] [--query <text>] [--limit 1..100] [--cursor <opaque>]\n  tiangong-lca dataset classification path --type <type> --code <code>\n\nRead bundled classification directories, including location. No network or dataset mutation.\nUse --json for context and pagination; --output <file> saves the complete report.\n',
        stderr: '',
      };
    if (flags.force && !flags.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    const type = text(flags.type, '--type');
    const limit = flags.limit === undefined ? 20 : Number(flags.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new CommandInputError('LIMIT_INVALID', '--limit must be an integer from 1 to 100.');
    const report =
      action === 'children'
        ? await ports.children({
            type,
            ...(flags.parent === undefined ? {} : { parent: text(flags.parent, '--parent') }),
            ...(flags.query === undefined ? {} : { query: text(flags.query, '--query') }),
            limit: null,
            outDir: null,
          })
        : await ports.path({ type, code: text(flags.code, '--code'), outDir: null });
    value.context = {
      actor: { status: 'not_required' },
      environment: 'local',
      observation: { source: 'bundled_classification', time: report.generated_at_utc },
      effectiveInput: {
        type,
        ...(action === 'children'
          ? { parent: flags.parent ?? null, query: flags.query ?? null }
          : { code: flags.code }),
      },
      directory: {
        type: report.category_type,
        schemaFile: report.schema_file,
        selectionDigest: contentDigest('children' in report ? report.children : report.path),
      },
    };
    value.data = { ...report };
    value.status = report.status === 'blocked' ? 'failed' : 'completed';
    value.outcome =
      report.status === 'blocked' ? 'classification_not_found' : 'classification_read';
    value.summary =
      report.status === 'blocked'
        ? 'Selected local classification code or parent was not found.'
        : 'Selected local classification entries read; no dataset fields were assigned.';
    if (report.status === 'blocked')
      value.error = {
        category: 'not_found_or_not_visible',
        code: 'CLASSIFICATION_NOT_FOUND',
        message: value.summary,
      };
    if (action === 'children') {
      const rows = (report as DatasetClassificationChildrenReport).children;
      const binding = {
        type,
        parent: flags.parent ?? null,
        query: flags.query ?? null,
        limit,
        digest: contentDigest(rows),
      };
      const offset = queryCursor(
        typeof flags.cursor === 'string' ? flags.cursor : undefined,
        binding,
      );
      const page = rows.slice(offset, offset + limit);
      value.data = {
        ...report,
        children: page,
        counts: {
          ...(report as DatasetClassificationChildrenReport).counts,
          returned: page.length,
        },
      };
      value.completeness = {
        scope: 'filtered_direct_children',
        total: rows.length,
        returned: page.length,
        allDirectChildren: (report as DatasetClassificationChildrenReport).counts.children,
        hasMore: offset + page.length < rows.length,
        nextCursor:
          offset + page.length < rows.length ? nextCursor(offset + page.length, binding) : null,
        snapshot: false,
        contentBinding: binding.digest,
      };
      value.context.defaultedInputs = flags.limit === undefined ? { limit: 20 } : {};
      if (value.completeness.nextCursor)
        value.nextActions = [
          {
            description: 'Read the next page of this unchanged directory selection.',
            command: `tiangong-lca dataset classification children --type ${shellArgument(type)}${flags.parent === undefined ? '' : ` --parent ${shellArgument(String(flags.parent))}`}${flags.query === undefined ? '' : ` --query ${shellArgument(String(flags.query))}`} --limit ${limit} --cursor ${shellArgument(String(value.completeness.nextCursor))} --json`,
          },
        ];
    } else value.completeness = { scope: 'selected_code_path', hasMore: false, nextCursor: null };
    if (flags.output) {
      try {
        value.artifacts.push(
          writeCommandOutput(String(flags.output), report, flags.force === true),
        );
      } catch {
        if (value.status === 'completed') value.status = 'partial';
        value.warnings.push({
          code: 'OUTPUT_UNAVAILABLE',
          message: 'Classification facts preserved; complete report could not be written.',
        });
      }
    }
    attachReplyTemplate(
      value,
      value.status === 'failed'
        ? 'command-failed'
        : value.status === 'partial'
          ? 'partial-result'
          : 'query-result',
    );
    return renderResult(value, json, value.status === 'completed' ? 0 : 1);
  } catch (error) {
    const failure = commandFailure(error, 'CLASSIFICATION_QUERY_FAILED');
    value.status = 'failed';
    value.outcome = 'operation_failed';
    value.summary = failure.message;
    value.error = { category: failure.category, code: failure.code, message: failure.message };
    value.nextActions = [
      {
        description: 'Inspect local directory query options.',
        command: 'tiangong-lca dataset classification --help --json',
      },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}
