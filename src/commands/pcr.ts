import { parseArgs } from 'node:util';
import type { FetchLike } from '../lib/transport/http.js';
import { ensurePcrSnapshot, inspectPcrSnapshot, type SnapshotOptions } from '../lib/pcr/cache.js';
import {
  selectedPcrTool,
  bindPcrTool,
  executePinnedPcr,
  verifyPinnedPcrIntegrity,
  pcrIntegrityVerified,
} from '../lib/pcr/tool.js';
import { pcrError } from '../lib/pcr/contract.js';

const HELP = `Usage: tiangong-lca pcr snapshot ensure|status --task-dir <absolute-dir> [--cache-dir <absolute-dir>] [--version <stable-version>] [--library <absolute-library.sqlite> --library-sha256 sha256:<hex>] [--tool-root <installed-PCR-package>] [--offline] [--json]
       tiangong-lca pcr exec --task-dir <absolute-dir> [--cache-dir <absolute-dir>] -- <PCR arguments>

New tasks select the latest compatible published snapshot. Existing tasks retain their exact pin and tool. Explicit versions and local libraries suppress latest discovery; offline preparation uses verified cached snapshots. PCR execution always verifies and supplies the task pin. Tools are explicit installed packages, separately trusted by the caller. No login or install scripts.
`;
export async function runPcrCommand(
  subcommand: string | null,
  args: string[],
  fetchImpl?: FetchLike,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const separatorIndex = args.indexOf('--');
  const wrapperArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  if (subcommand === null || wrapperArgs.includes('--help') || wrapperArgs.includes('-h'))
    return { exitCode: 0, stdout: HELP, stderr: '' };
  const exec = subcommand === 'exec',
    operation = exec ? 'exec' : args[0];
  if (
    (!exec && subcommand !== 'snapshot') ||
    !['ensure', 'status', 'exec'].includes(operation ?? '')
  )
    pcrError('ARGUMENT', 'Unknown PCR operation.');
  const input = exec ? args : args.slice(1),
    separator = input.indexOf('--');
  if (exec && separator < 0) pcrError('ARGUMENT', 'Use -- before PCR tool arguments.');
  let values;
  try {
    values = parseArgs({
      args: separator < 0 ? input : input.slice(0, separator),
      strict: true,
      allowPositionals: false,
      options: {
        'task-dir': { type: 'string' },
        'cache-dir': { type: 'string' },
        version: { type: 'string' },
        library: { type: 'string' },
        'library-sha256': { type: 'string' },
        'tool-root': { type: 'string' },
        offline: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }).values;
  } catch {
    pcrError('ARGUMENT', 'PCR commands accept only their declared flags.');
  }
  if (!values['task-dir']) pcrError('ARGUMENT', 'PCR operations require --task-dir.');
  if (separator >= 0 && !exec)
    pcrError('ARGUMENT', 'Snapshot operations accept no trailing arguments.');
  if (
    exec &&
    (values.version !== undefined ||
      values.library !== undefined ||
      values['library-sha256'] !== undefined ||
      values['tool-root'] !== undefined ||
      values.offline !== undefined ||
      values.json !== undefined)
  )
    pcrError('ARGUMENT', 'PCR exec accepts task/cache selection only.');
  const options: SnapshotOptions = {
    taskDir: values['task-dir'],
    cacheDir: values['cache-dir'],
    version: values.version,
    library: values.library,
    librarySha256: values['library-sha256'],
    offline: values.offline,
    fetchImpl,
  };
  if (exec) return executePinnedPcr(options, input.slice(separator + 1), env);
  const tool = selectedPcrTool(options.taskDir, values['tool-root']);
  if (tool !== null) options.reader = tool.reader;
  const snapshot =
    operation === 'ensure' ? await ensurePcrSnapshot(options) : inspectPcrSnapshot(options);
  if (operation === 'ensure' && tool !== null) {
    bindPcrTool(options, tool);
    if (!pcrIntegrityVerified(options, tool)) await verifyPinnedPcrIntegrity(options, tool);
  }
  const result = {
    ...snapshot,
    task_usable:
      snapshot.status === 'snapshot-ready' &&
      tool !== null &&
      selectedPcrTool(options.taskDir) !== null &&
      pcrIntegrityVerified(options, tool),
    tool,
  };
  return {
    exitCode: snapshot.status === 'missing' ? 2 : 0,
    stdout: values.json
      ? `${JSON.stringify(result)}\n`
      : `PCR ${snapshot.pin?.version ?? 'not selected'} (${result.task_usable ? 'task-ready' : snapshot.status})\n${snapshot.lock_file}\n`,
    stderr: '',
  };
}
