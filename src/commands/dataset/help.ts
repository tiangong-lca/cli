import { renderCommandHelp } from '../help-text.js';
import { type CanonicalDatasetAction } from '../../application/dataset-types.js';
import { parseArgs } from 'node:util';
import { actionsFor, datasetTypes, type DatasetType } from '../../application/dataset-types.js';
import { attachReplyTemplate, renderResult } from '../../shared/command-presentation.js';
import { result, type CommandIO } from '../../shared/command-result.js';

export const common = ['help', 'json', 'output', 'force'];
export const commonFor = (action?: string) => (action === 'calculate' ? ['help', 'json'] : common);
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
  search: ['query', 'state', 'scope', 'limit'],
  contract: ['include'],
  'list-references': ['id', 'version', 'input', 'limit', 'cursor'],
  validate: ['input', 'checks'],
  diff: ['input'],
  patch: ['input'],
  'translations extract': ['input'],
  'translations apply': ['input'],
  graph: ['input'],
  prepare: ['input'],
  calculate: ['file', 'engine', 'static-cache', 'output-dir', 'timeout-ms'],
  'build-resulting-process': ['input'],
  create: ['input', 'dry-run'],
  save: ['input', 'dry-run'],
  delete: ['input', 'dry-run'],
  results: ['id', 'version'],
  'get-result': ['id', 'version', 'result-id', 'kind', 'max-items'],
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
  prepare: {
    model: { file: 'canonical Model JSON path' },
    datasets: [{ file: 'canonical supporting Dataset JSON path' }],
    backgrounds: [{ file: 'complete Process get-result --kind lci artifact' }],
    methods: [{ id: 'LCIA method UUID', version: 'exact version' }],
    amount: 'positive functional amount; default 1',
    cutoffs: 'explicit declared unconnected ports; default []',
    limits: 'optional native resource budgets',
    allowRemoteLookup: 'false by default; true fetches missing exact numerical dependencies only',
  },
  calculate: {
    file: 'complete lca.model-input.v1 JSON from prepare',
    engine: 'native executable; or TIANGONG_LCA_MODEL_ENGINE',
    staticCache: 'LCIA factor directory; environment or saved setup configuration',
    outputDir: 'new local Run directory',
    timeoutMs: 'whole-process deadline; default 120000',
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
    case 'prepare':
      return `${command} --input request.json --output input.json --json`;
    case 'calculate':
      return `${command} --file input.json --engine model_calculate --static-cache ./lcia-cache --output-dir ./run-1 --json`;
    case 'results':
    case 'get-result':
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
    options: [...commonFor(action), ...(action ? flags[action] : [])],
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
        : action === 'search'
          ? { limit: 20, scope: 'current-user' }
          : action && ['list', 'versions', 'list-references'].includes(action)
            ? { limit: 20 }
            : action === 'statistics'
              ? { scope: 'visible', groupBy: ['state'], maxRows: 10000 }
              : action && ['create', 'save', 'delete', 'upload-attachments'].includes(action)
                ? { dryRun: false }
                : {},
    limitations:
      action === 'calculate'
        ? [
            'Local complete inputs only; no login, network lookup, upload or retry. Use setup model-calculation to verify and save installed engine/cache paths. Explicit flags override environment then saved configuration. Source input is copied into the new Run. timeout-ms is a whole-process deadline; limits.timeoutMs bounds numerical preparation/execution.',
          ]
        : action === 'prepare'
          ? [
              'Requires --output. File selections are relative to the request file. Preparation resolves numerical dependencies, without calculating or selecting providers. Methods/factors are checked by the explicitly configured engine at calculation time. Backgrounds replace original Process inventories.',
            ]
          : action === 'get-result'
            ? [
                'Read overview (default), lci or lcia. LCI requires --output and reads all pages; --max-items defaults to 100000. Use --result-id only to disambiguate results. Service bindings and one bounded whole-read restart are automatic.',
              ]
            : action === 'results'
              ? [
                  'List published direct results for one exact Process version. No calculation is started.',
                ]
              : action === 'search'
                ? [
                    'Search scope: current-user (default) or public (state 100). Flow/Process search matches exact versions; other types use the service candidate version policy. Cursors are not supported; narrow the query.',
                  ]
                : action === 'validate'
                  ? [
                      'Remote reference relationship checks require independently selected evidence.',
                    ]
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
