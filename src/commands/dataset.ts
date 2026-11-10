import {
  type DatasetAction,
  type CanonicalDatasetAction,
  type DatasetOperation,
} from '../application/dataset-types.js';
import { datasetMutationContinuation } from './mutation-presentation.js';
import { commandFailure } from '../shared/command-errors.js';
import { parseArgs } from 'node:util';
import {
  actionsFor,
  datasetTypes,
  requireContent,
  text,
  object,
  type DatasetType,
  type DatasetPorts,
  type JsonObject,
} from '../application/dataset-types.js';
import { queryCursor } from '../application/dataset-discovery.js';
import { discoverDatasets } from './dataset-discovery.js';
import { statisticsRequest } from './dataset-statistics.js';
import {
  shellArgument,
  inputContinuation,
  queryContinuation,
} from '../shared/command-continuation.js';
import {
  contentDigest,
  diffContent,
  listContentReferences,
  patchContent,
} from '../application/dataset-content.js';
import { extractTranslations, applyTranslations } from '../application/dataset-translations.js';
import { readCommandInput, writeCommandOutput } from '../shared/command-files.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import {
  CommandInputError,
  result,
  type CommandIO,
  type CommandResult,
} from '../shared/command-result.js';
import { common, flags, help } from './dataset/help.js';
import { validationSummary, artifactSummary } from './dataset/presentation.js';
export { runDatasetHelp } from './dataset/help.js';

export const positiveLimit = (value: unknown) => {
  const limit = value === undefined ? 20 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CommandInputError('LIMIT_INVALID', '--limit must be an integer from 1 to 100.');
  return limit;
};
export function csv(value: string, supported: string[], label: string) {
  const list = value.split(',');
  if (
    !list.length ||
    list.some((item) => !supported.includes(item)) ||
    new Set(list).size !== list.length
  )
    throw new CommandInputError(
      'SELECTION_INVALID',
      `${label}: choose unique values from ${supported.join(',')}.`,
    );
  return list;
}
export async function runDatasetCommand(
  args: string[],
  ports: DatasetPorts,
  readInput: typeof readCommandInput = readCommandInput,
): Promise<CommandIO> {
  const type = args[0] as DatasetType;
  let action = args[1] as DatasetAction | undefined;
  let start = 2;
  if (String(action) === 'translations') {
    action = `translations ${args[2]}` as DatasetAction;
    start = 3;
  }
  if (action === 'aggregate') action = 'build-resulting-process';
  const json = args.includes('--json');
  const operation = `dataset ${type}${action && !action.startsWith('--') ? ` ${action}` : ''}`;
  try {
    if (!datasetTypes.includes(type))
      throw new CommandInputError('TYPE_UNSUPPORTED', 'Select a supported Dataset type.');
    const group = !action || action.startsWith('-');
    if (!group && !actionsFor(type).includes(action!))
      throw new CommandInputError(
        'CAPABILITY_UNSUPPORTED',
        `This type does not support ${action}.`,
      );
    let values: Record<string, string | boolean | undefined>;
    try {
      const allowed = [...common, ...(group ? [] : flags[action as CanonicalDatasetAction])];
      const parsed = parseArgs({
        args: args.slice(group ? 1 : start),
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: Object.fromEntries(
          allowed.map((name) => [
            name,
            {
              type: ['help', 'json', 'force', 'dry-run'].includes(name) ? 'boolean' : 'string',
              ...(name === 'help' ? { short: 'h' } : {}),
            },
          ]),
        ),
      });
      const names = parsed.tokens
        .filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('duplicate');
      values = parsed.values;
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, repeated or malformed option. Inspect command --help.',
      );
    }
    if (group || values.help)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(help(type, group ? undefined : (action as CanonicalDatasetAction)), null, json ? undefined : 2)}\n`,
        stderr: '',
      };
    const string = (name: string) =>
      values[name] === undefined ? undefined : text(values[name], `--${name}`);
    if (values.force && !values.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    if (values.output !== undefined) string('output');
    let value: CommandResult;
    const local = result(operation);
    local.context = {
      environment: null,
      actor: null,
      observation: { source: 'local', time: ports.now() },
      effectiveInput: {},
      defaultedInputs: {},
    };
    let artifact: unknown;
    if (['get', 'list', 'versions'].includes(action!)) {
      const id = ['get', 'versions'].includes(action!) ? text(values.id, '--id') : undefined;
      const version = action === 'get' ? text(values.version, '--version') : undefined;
      const state = values.state === undefined ? undefined : Number(values.state);
      if (state !== undefined && !Number.isSafeInteger(state))
        throw new CommandInputError('STATE_INVALID', '--state must be an integer code.');
      const limit = action === 'get' ? 1 : positiveLimit(values.limit);
      const fields =
        values.fields === undefined
          ? undefined
          : csv(
              String(values.fields),
              [
                'type',
                'id',
                'version',
                'modifiedAt',
                'stateCode',
                'owner',
                'content',
                ...(type === 'process' && action === 'get' ? ['exchanges'] : []),
              ],
              '--fields',
            );
      const binding = {
        type,
        action,
        ...(id ? { id } : {}),
        ...(version ? { version } : {}),
        ...(values.owner ? { owner: String(values.owner) } : {}),
        ...(state === undefined ? {} : { state }),
        ...(fields ? { fields: fields.join(',') } : {}),
        limit,
      };
      const offset = queryCursor(string('cursor'), binding);
      value = await discoverDatasets(
        type,
        action as 'get',
        { id, version, state, owner: string('owner'), limit, offset },
        binding,
        ports,
      );
      if (fields && value.status === 'completed') {
        const project = (row: unknown) =>
          Object.fromEntries(
            Object.entries(object(row, 'record')).filter(
              ([key]) => ['type', 'id', 'version'].includes(key) || fields.includes(key),
            ),
          );
        if (action === 'get') {
          if (fields.includes('exchanges'))
            value.data.exchanges =
              object(object(value.data.content, 'content').processDataSet, 'processDataSet')
                .exchanges ?? null;
          if (!fields.includes('content')) delete value.data.content;
          value.completeness.contentProjection = fields;
          value.completeness.completeContent = fields.includes('content');
          value.data.subject = project(value.data.subject);
        } else value.data.items = (value.data.items as unknown[]).map(project);
      }
      if (value.completeness.nextCursor)
        value.nextActions.push({
          description: 'Read the next visible page.',
          command: queryContinuation(type, action!, binding, value.completeness.nextCursor),
        });
      if (action !== 'get' && values.limit === undefined)
        value.context.defaultedInputs = { limit: 20 };
      artifact = action === 'get' ? (value.data.content ?? value.data) : value.data;
    } else if (action === 'search') {
      if (values.cursor)
        throw new CommandInputError(
          'CURSOR_UNSUPPORTED',
          'This search service does not expose a reliable continuation cursor. Narrow the query.',
        );
      const query = text(values.query, '--query');
      const limit = positiveLimit(values.limit);
      const state = values.state === undefined ? undefined : Number(values.state);
      if (state !== undefined && !Number.isSafeInteger(state))
        throw new CommandInputError('STATE_INVALID', '--state must be an integer code.');
      const found = await ports.search(type, query, limit, 0, state);
      value = local;
      value.data = { candidates: found.candidates };
      value.context = {
        environment: found.environment,
        actor: { status: 'online_session' },
        observation: { source: 'domain_search', time: ports.now() },
        effectiveInput: { query, limit, state },
        defaultedInputs: values.limit === undefined ? { limit: 20 } : {},
      };
      value.completeness = { ...found, candidates: undefined, environment: undefined };
      value.summary = `${type}: ${found.returned} search candidate(s), within the declared search scope.`;
      value.outcome = 'candidates_returned';
      value.nextActions = [
        {
          description:
            'Choose a candidate identity and read its exact version; scores do not establish equivalence.',
        },
      ];
      artifact = found;
    } else if (action === 'contract') {
      const include = csv(
        string('include') ?? 'schema,methodology,ruleset',
        ['schema', 'methodology', 'ruleset'],
        '--include',
      );
      value = local;
      value.data = await ports.contract(type, include);
      artifact = value.data;
      const components = object(value.data.components, 'contract components');
      value.data = {
        ...value.data,
        components: Object.fromEntries(
          Object.entries(components).map(([name, component]) => [
            name,
            {
              available: component != null,
              bytes:
                component == null
                  ? null
                  : Buffer.byteLength(
                      typeof component === 'string' ? component : JSON.stringify(component),
                    ),
              digest: component == null ? null : contentDigest(component),
            },
          ]),
        ),
      };
      value.completeness = {
        scope: 'contract_component_metadata',
        detailsInArtifact: !!values.output,
      };
      if (!values.output)
        value.nextActions.push({
          description: 'Use --output to write the selected complete contract components.',
        });
      value.summary = `${type} content contract and component availability read.`;
      value.outcome = 'contract_read';
    } else if (action === 'list-references') {
      if (values.input && (values.id || values.version))
        throw new CommandInputError(
          'INPUT_AMBIGUOUS',
          'Choose local --input or remote --id and --version.',
        );
      let content: JsonObject;
      value = local;
      if (values.input) content = requireContent(type, readInput(text(values.input, '--input')));
      else {
        const id = text(values.id, '--id');
        const version = text(values.version, '--version');
        if (version === 'latest')
          throw new CommandInputError(
            'EXACT_VERSION_REQUIRED',
            'Reference discovery requires an exact version.',
          );
        value = await discoverDatasets(
          type,
          'get',
          { id, version, limit: 1, offset: 0 },
          { id, version },
          ports,
        );
        if (value.status === 'failed') {
          attachReplyTemplate(value, 'command-failed');
          return renderResult(value, json, 1);
        }
        content = object(value.data.content, 'content');
        value.operation = operation;
      }
      const references = listContentReferences(content);
      const limit = positiveLimit(values.limit);
      const binding = { type, action, digest: contentDigest(content), limit };
      const offset = queryCursor(string('cursor'), binding);
      value.data = {
        contentDigest: binding.digest,
        references: references.slice(offset, offset + limit),
      };
      // A complete explicit artifact contains every occurrence, without target lookups.
      artifact = { contentDigest: binding.digest, references };
      value.completeness = {
        scope: 'outgoing_references',
        total: references.length,
        returned: Math.min(limit, Math.max(0, references.length - offset)),
        hasMore: offset + limit < references.length,
        nextCursor:
          offset + limit < references.length
            ? Buffer.from(
                JSON.stringify({ offset: offset + limit, binding: contentDigest(binding) }),
              ).toString('base64url')
            : null,
        truncated: false,
        targetsChecked: false,
      };
      value.summary = `${references.length} outgoing reference occurrence(s); targets were not checked.`;
      value.outcome = 'references_listed';
      if (value.completeness.nextCursor) {
        const source = values.input
          ? inputContinuation(String(values.input))
          : `--id ${shellArgument(String(values.id))} --version ${shellArgument(String(values.version))}`;
        value.nextActions.push(
          source
            ? {
                description: 'Continue reference discovery using the same input and cursor.',
                command: `tiangong-lca dataset ${type} list-references ${source} --limit ${limit} --cursor ${shellArgument(String(value.completeness.nextCursor))} --json`,
              }
            : {
                description:
                  'Save the unchanged stdin content to a file and continue reference discovery with that file and the returned cursor.',
              },
        );
      }
    } else {
      const inputPath =
        action === 'statistics' && values.input === undefined ? '-' : text(values.input, '--input');
      const request = action === 'statistics' ? statisticsRequest(values) : readInput(inputPath);
      value = local;
      if (action === 'validate') {
        const checks = csv(
          string('checks') ?? (type === 'lciamethod' ? 'schema' : 'schema,business'),
          ['schema', 'references', 'business'],
          '--checks',
        );
        if (type === 'lciamethod' && checks.join(',') !== 'schema')
          throw new CommandInputError(
            'CHECKS_UNSUPPORTED',
            'LCIA Method currently supports schema checks only.',
          );
        const validation = await ports.validate(type, requireContent(type, request), checks);
        value.data = { validation };
        artifact = validation;
        value.outcome = `validation_${validation.status}`;
        value.summary = `${type} validation ${validation.status}; checks: ${checks.join(',')}.`;
        value.context.effectiveInput = { checks, contentDigest: contentDigest(request) };
        value.context.defaultedInputs = values.checks === undefined ? { checks } : {};
        value.completeness = {
          scope: checks.includes('references')
            ? 'local_and_remote_reference_admission'
            : 'local_validation',
          notChecked: validation.notChecked,
          truncated: false,
        };
      } else if (action === 'diff') {
        requireContent(type, request.before);
        requireContent(type, request.after);
        value.data = {
          beforeDigest: contentDigest(request.before),
          afterDigest: contentDigest(request.after),
          changes: diffContent(request.before, request.after),
        };
        artifact = value.data;
      } else if (action === 'patch') {
        requireContent(type, request.content);
        value.data = patchContent(request);
        requireContent(type, value.data.content);
        artifact = value.data.content;
      } else if (action?.startsWith('translations ')) {
        requireContent(type, request.content);
        value.data = action.endsWith('extract')
          ? extractTranslations(request)
          : applyTranslations(request);
        artifact = value.data;
      } else if (['create', 'save', 'delete'].includes(action!)) {
        value = await ports.mutate(
          type,
          action as 'create' | 'save' | 'delete',
          request,
          values['dry-run'] === true,
        );
        datasetMutationContinuation(value);
        artifact = value;
      } else {
        value.data = await ports.operations({
          type,
          action: action!,
          request:
            action === 'upload-attachments'
              ? { ...request, dryRun: values['dry-run'] === true }
              : request,
          inputPath,
        } as DatasetOperation);
        if (value.data.status === 'partial' || value.data.status === 'completed_with_findings')
          value.status = 'partial';
        if (
          action === 'build-resulting-process' &&
          object(value.data.qualification, 'qualification').status !== 'qualified'
        )
          value.status = 'partial';
        if (action === 'upload-attachments') {
          value.outcome =
            value.data.status === 'preview_completed'
              ? 'preview_completed'
              : value.status === 'partial'
                ? 'attachments_partially_uploaded'
                : 'attachments_uploaded';
          value.summary =
            value.data.status === 'preview_completed'
              ? 'Attachment selection checked; no upload was dispatched.'
              : value.status === 'partial'
                ? 'Some attachments failed; unsuccessful references retain their original values.'
                : 'Selected attachments uploaded; Source content has not been saved.';
        }
        if (action === 'statistics') {
          value.context = object(value.data.context, 'statistics context');
          value.completeness = object(value.data.completeness, 'statistics completeness');
          delete value.data.context;
        }
        artifact = value.data;
      }
      if (!value.summary)
        value.summary = `${type} ${action} completed; remote dataset content was not saved.`;
      if (value.outcome === 'completed') value.outcome = 'content_processed';
    }
    if (values.output && ['completed', 'unknown', 'accepted', 'partial'].includes(value.status)) {
      try {
        value.artifacts.push(
          writeCommandOutput(
            String(values.output),
            artifact,
            values.force === true,
            values.input as string | undefined,
          ),
        );
      } catch {
        value.warnings.push({
          code: 'OUTPUT_UNAVAILABLE',
          message:
            'Output file could not be written; the business result and recovery identity are preserved.',
        });
        if (value.status === 'completed') value.status = 'partial';
      }
      if (value.artifacts.length) {
        if (action === 'get') delete value.data.content;
        if (
          [
            'diff',
            'patch',
            'translations extract',
            'translations apply',
            'graph',
            'build-resulting-process',
            'upload-attachments',
          ].includes(action!)
        ) {
          value.data = artifactSummary(value.data);
          value.completeness.stdoutProjection = 'artifact_summary';
        }
      }
    }
    if (action === 'statistics') {
      const groups = value.data.groups as unknown[];
      if (Array.isArray(groups) && groups.length > 5) {
        value.data = artifactSummary(value.data);
        value.completeness.truncated = true;
        value.nextActions.push({ description: 'Use --output to save every statistics group.' });
      }
    }
    if (action === 'validate') {
      const validation = value.data.validation as JsonObject;
      value.data.validation = validationSummary(validation);
      value.completeness.truncated =
        JSON.stringify(validation) !== JSON.stringify(value.data.validation);
      if (value.completeness.truncated && !values.output)
        value.nextActions.push({
          description: 'Use --output to save the complete validation findings.',
        });
    }
    attachReplyTemplate(
      value,
      value.status === 'unknown'
        ? 'outcome-unknown'
        : value.status === 'partial'
          ? 'partial-result'
          : ['create', 'save', 'delete'].includes(action!) && value.status === 'completed'
            ? values['dry-run']
              ? 'preview-result'
              : 'operation-completed'
            : value.status === 'failed'
              ? 'command-failed'
              : action === 'validate'
                ? 'validation-result'
                : [
                      'diff',
                      'patch',
                      'translations extract',
                      'translations apply',
                      'graph',
                      'build-resulting-process',
                      'upload-attachments',
                    ].includes(action!)
                  ? 'operation-completed'
                  : action === 'search' && (value.data.candidates as unknown[]).length > 1
                    ? 'decision-required'
                    : 'query-result',
    );
    return renderResult(
      value,
      json,
      ['failed', 'partial', 'unknown'].includes(value.status) ||
        (action === 'validate' && (value.data.validation as JsonObject).status !== 'passed')
        ? 1
        : 0,
    );
  } catch (error) {
    const value = result(operation);
    const failure = commandFailure(error, 'DATASET_OPERATION_FAILED');
    value.status = 'failed';
    value.outcome = failure.category === 'input' ? 'invalid_input' : failure.category;
    value.summary = failure.message;
    value.error = { category: failure.category, code: failure.code, message: failure.message };
    value.nextActions.push({
      description: 'Inspect the command contract.',
      command: `tiangong-lca dataset ${type} --help --json`,
    });
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}
