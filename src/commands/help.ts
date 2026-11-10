import { datasetTypes, actionsFor } from '../application/dataset-types.js';
import type { CommandIO } from '../shared/command-result.js';

export function rootHelp(usage: string): CommandIO {
  const manifest = {
    schemaVersion: 1,
    command: 'tiangong-lca',
    commands: {
      doctor: ['local diagnostics', '--online selected Auth health'],
      auth: ['login', 'status', 'whoami', 'doctor-auth', 'logout', 'identity-receipt'],
      dataset: {
        ...Object.fromEntries(datasetTypes.map((type) => [type, actionsFor(type)])),
        classification: ['children', 'path'],
        maintenance: ['plan', 'apply', 'verify', 'clear-account'],
        'import-lca': ['convert'],
      },
      review: ['submit', 'resubmit', 'get', 'list', 'materials', 'comment', 'decide'],
      study: 'Existing versioned Study protocol; inspect study --help',
      release: 'Existing release command protocol; inspect release --help',
    },
    runtimeSupport: [
      'runtime describe|ensure|status|prune|lease-release|exec',
      'pcr snapshot ensure|status',
      'pcr exec',
    ],
    packageTools: ['dataset import-lca convert', 'validation run'],
    outputProtocols: {
      core: {
        commands: ['doctor', 'auth', 'dataset', 'review'],
        machineHelp: true,
        results: 'Shared result on stdout; stable structured errors.',
      },
      study: {
        machineHelp: false,
        results:
          'Versioned Study result on stdout; legacy structured errors on stderr. Inspect study --help and the Study contract.',
      },
      runtime: {
        machineHelp: false,
        results: 'Runtime descriptor/manager schemas; exec preserves child stdout/stderr.',
      },
      pcr: {
        machineHelp: false,
        results: 'Pinned snapshot results; exec preserves child stdout/stderr.',
      },
      release: { machineHelp: false, results: 'Existing Release result/error/recovery contract.' },
      specializedTools: {
        commands: [
          'dataset maintenance',
          'dataset classification audit|apply',
          'dataset import-lca',
          'validation',
          'admin',
        ],
        machineHelp: false,
        results: 'Existing specialized report/error contracts.',
      },
    },
    discovery:
      'Use core <command> --help --json for inputs, effects, limits and recovery; retained protocols use their documented help modes. Help does not execute a business operation.',
    result:
      'Core results carry actual scope, context, nextActions and an installed Markdown replyTemplate; Release and child process protocols retain their existing contracts.',
    usage,
  };
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(manifest)}\n`,
    stderr: '',
  };
}
