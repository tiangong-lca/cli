import { renderCommandHelp } from '../help-text.js';
import { type CanonicalDatasetAction } from '../../application/dataset-types.js';
import { parseArgs } from 'node:util';
import { actionsFor, datasetTypes, type DatasetType } from '../../application/dataset-types.js';
import { attachReplyTemplate, renderResult } from '../../shared/command-presentation.js';
import { result, type CommandIO } from '../../shared/command-result.js';

export const common = ['help', 'json', 'output', 'force'];
export function runDatasetHelp(args: string[]): CommandIO {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
    });
    const manifest = {
      schemaVersion: 1,
      command: 'dataset',
      types: Object.fromEntries(datasetTypes.map((type) => [type, actionsFor(type)])),
      sharedDiscovery: ['classification children', 'classification path'],
      packageTools: ['import-lca convert'],
      maintenance: ['plan', 'apply', 'verify', 'clear-account'],
      effects:
        'Help is read-only. Inspect an action help for exact inputs, service semantics and recovery.',
    };
    return {
      exitCode: 0,
      stdout: values.json
        ? `${JSON.stringify(manifest)}\n`
        : `Usage: tiangong-lca dataset <type> <action> [options]\n\n${Object.entries(manifest.types)
            .map(([type, actions]) => `${type}: ${actions.join(' | ')}`)
            .join(
              '\n',
            )}\n\nShared discovery: dataset classification children | path\nPackage tools: dataset import-lca convert\nMaintenance: dataset maintenance plan | apply | verify | clear-account\n\nUse dataset <type> <action> --help --json for inputs, effects, outputs and limits.\n`,
      stderr: '',
    };
  } catch {
    const value = result('dataset');
    value.status = 'failed';
    value.outcome = 'invalid_input';
    value.summary =
      'Dataset group help accepts --help and --json. Select an object type to execute an action.';
    value.error = { category: 'input', code: 'ARGUMENTS_INVALID', message: value.summary };
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, args.includes('--json'), 2);
  }
}
export const flags: Record<CanonicalDatasetAction, string[]> = {
  get: ['id', 'version', 'fields'],
  list: ['owner', 'state', 'limit', 'cursor', 'fields'],
  versions: ['id', 'limit', 'cursor', 'fields'],
  search: ['query', 'state', 'limit'],
  contract: ['include'],
  'list-references': ['id', 'version', 'input', 'limit', 'cursor'],
  validate: ['input', 'checks'],
  diff: ['input'],
  patch: ['input'],
  'translations extract': ['input'],
  'translations apply': ['input'],
  graph: ['input'],
  'build-resulting-process': ['input'],
  create: ['input', 'dry-run'],
  save: ['input', 'dry-run'],
  delete: ['input', 'dry-run'],
  statistics: ['input', 'scope', 'owner', 'state', 'group-by', 'max-rows'],
  'upload-attachments': ['input', 'dry-run'],
};
export const requestShapes: Partial<Record<CanonicalDatasetAction, unknown>> = {
  'upload-attachments': {
    content: 'canonical Source with referenceToDigitalFile entries',
    bucket: 'explicit storage bucket',
    attachments: [
      {
        name: 'filename used by the Source reference',
        path: 'path relative to request file (absolute for stdin)',
        size: 'exact byte length',
        sha256: 'exact SHA-256',
      },
    ],
  },
  create: {
    id: 'UUID',
    version: '00.00.000',
    content: 'canonical content with same identity',
    requestId: 'stable caller request identity',
    expectedActor: 'online user UUID',
    expectedEnvironment: 'exact project origin',
  },
  save: {
    id: 'UUID',
    version: '00.00.000',
    content: 'complete candidate content',
    expectedContent:
      'complete previously read content; ordinary save uses server CAS, Model save uses a preflight check with transactional service update',
    requestId: 'stable caller request identity',
    expectedActor: 'online user UUID',
    expectedEnvironment: 'exact project origin',
  },
  delete: {
    id: 'UUID',
    version: '00.00.000',
    expectedContent: 'complete previously read draft content',
    requestId: 'stable caller request identity',
    expectedActor: 'online user UUID',
    expectedEnvironment: 'exact project origin',
  },
  validate: { content: 'canonical TIDAS JSON supplied directly as input' },
  diff: { before: 'canonical content', after: 'canonical content' },
  patch: {
    content: 'canonical content',
    expectedDigest: 'SHA-256 of JSON.stringify(content)',
    operations: [
      {
        op: 'test|add|replace|remove',
        path: '/JSON/pointer',
        value: 'JSON value',
        basis: 'reason/evidence (required for changes)',
      },
    ],
  },
  'translations extract': {
    content: 'canonical content',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
  },
  'translations apply': {
    content: 'canonical content',
    sourceDigest: 'digest returned by extract',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    translations: [
      {
        path: '/field',
        sourceText: 'unchanged source text',
        text: 'given translation',
        basis: 'evidence',
      },
    ],
  },
  statistics: {
    scope: 'visible (default) or current-user',
    owner: 'optional exact visible owner',
    stateCodes: 'optional distinct integer states; omitted means all visible states',
    groupBy: 'state and/or classification; default [state]',
    maxRows: '1..100000; default 10000; incomplete scans return partial',
  },
  graph: { content: 'canonical Model content' },
  'build-resulting-process': {
    source_model: 'explicit model content or json_ordered_path',
    projection: 'explicit reference output/projection/allocation',
    process_sources: 'exact Process JSON files/catalog; run_dirs forbidden',
  },
};
function actionExample(type: DatasetType, action: CanonicalDatasetAction): string {
  const command = `tiangong-lca dataset ${type} ${action}`;
  const id = '00000000-0000-4000-8000-000000000001';
  switch (action) {
    case 'get':
      return `${command} --id ${id} --version 01.00.000 --json`;
    case 'versions':
      return `${command} --id ${id} --limit 20 --json`;
    case 'list':
      return `${command} --limit 20 --json`;
    case 'search':
      return `${command} --query electricity --limit 20 --json`;
    case 'contract':
    case 'statistics':
      return `${command} --json`;
    case 'validate':
    case 'list-references':
      return `${command} --input content.json --json`;
    case 'create':
    case 'save':
    case 'delete':
    case 'upload-attachments':
      return `${command} --input request.json --dry-run --json`;
    default:
      return `${command} --input request.json --json`;
  }
}
export function help(type: DatasetType, action?: CanonicalDatasetAction) {
  return {
    schemaVersion: 1,
    command: `dataset ${type}${action ? ` ${action}` : ''}`,
    implementedActions: actionsFor(type),
    unavailableActions: Object.fromEntries(
      Object.keys(flags)
        .filter((name) => !actionsFor(type).includes(name as CanonicalDatasetAction))
        .map((name) => [name, 'Not exposed for this type by the current service interface.']),
    ),
    aliases: type === 'model' ? { aggregate: 'build-resulting-process' } : {},
    options: [...common, ...(action ? flags[action] : [])],
    request: action ? (requestShapes[action] ?? null) : null,
    result: {
      schemaVersion: 1,
      fields: [
        'operation',
        'status',
        'outcome',
        'summary',
        'data',
        'context',
        'completeness',
        'artifacts',
        'warnings',
        'error',
        'nextActions',
        'replyTemplate',
      ],
    },
    effects:
      'Reads and local processing do not save, review or publish datasets. Mutations are explicit.',
    defaults:
      action === 'validate'
        ? { checks: type === 'lciamethod' ? ['schema'] : ['schema', 'business'] }
        : action && ['list', 'versions', 'search', 'list-references'].includes(action)
          ? { limit: 20 }
          : action === 'statistics'
            ? { scope: 'visible', groupBy: ['state'], maxRows: 10000 }
            : action && ['create', 'save', 'delete', 'upload-attachments'].includes(action)
              ? { dryRun: false }
              : {},
    limitations:
      action === 'search'
        ? [
            'Search uses the current actor latest-version candidate scope; continuation cursors are not supported. Narrow the query.',
          ]
        : action === 'validate'
          ? ['Remote reference relationship checks require independently selected evidence.']
          : action && ['create', 'save', 'delete'].includes(action)
            ? ['Unavailable server protections fail explicitly before mutation.']
            : [],
    errors: {
      0: 'completed or accepted',
      1: 'business failure, partial/incomplete or unknown result',
      2: 'invalid input or unsupported capability',
    },
    examples: action
      ? [actionExample(type, action)]
      : [
          `tiangong-lca dataset ${type} contract --json`,
          `tiangong-lca dataset ${type} validate --input content.json --json`,
        ],
  };
}

export function datasetHelpOutput(
  type: DatasetType,
  action: CanonicalDatasetAction | undefined,
  json: boolean,
): CommandIO {
  const manifest = help(type, action);
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(manifest)}\n` : renderCommandHelp(manifest),
    stderr: '',
  };
}
export function translationsHelp(type: DatasetType, args: string[], json: boolean): CommandIO {
  parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
  });
  const manifest = {
    schemaVersion: 1,
    command: `dataset ${type} translations`,
    implementedActions: ['extract', 'apply'],
    options: ['--help', '--json'],
    effects:
      'Extract translation positions or apply supplied translations to candidate content. Neither action saves the dataset.',
    examples: [
      `tiangong-lca dataset ${type} translations extract --help`,
      `tiangong-lca dataset ${type} translations apply --help --json`,
    ],
  };
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(manifest)}\n` : renderCommandHelp(manifest),
    stderr: '',
  };
}
