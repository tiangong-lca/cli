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
      },
      review: ['submit', 'resubmit', 'get', 'list', 'materials', 'comment', 'decide'],
      release: 'Existing release command protocol; inspect release --help',
    },
    runtimeSupport: [
      'runtime describe|ensure|status|prune|lease-release|exec',
      'pcr snapshot ensure|status',
      'pcr exec',
    ],
    packageTools: ['dataset import-lca convert', 'validation run'],
    discovery:
      'Use <command> --help --json for inputs, effects, limits and recovery. Help does not execute a business operation.',
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
