import { parseArgs } from 'node:util';
import { CliError } from '../../shared/errors.js';
import type { FetchLike } from '../../lib/http.js';
import { loadTrustedRuntimeManifest } from '../../lib/runtime/manifest.js';
import { executeRuntimeLaunch } from '../../lib/runtime/execute.js';
export async function runRuntimeExecCommand(
  args: string[],
  fetchImpl?: FetchLike,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof executeRuntimeLaunch = executeRuntimeLaunch,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const separator = args.indexOf('--'),
    options = separator < 0 ? args : args.slice(0, separator),
    argv = separator < 0 ? [] : args.slice(separator + 1);
  let flags;
  try {
    flags = parseArgs({
      args: options,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        manifest: { type: 'string' },
        'manifest-sha256': { type: 'string' },
        'cache-dir': { type: 'string' },
        entry: { type: 'string' },
        cwd: { type: 'string' },
        lease: { type: 'string' },
        'lease-owner': { type: 'string' },
      },
    }).values;
  } catch {
    throw new CliError('Invalid runtime exec arguments.', {
      code: 'RUNTIME_ARGUMENT_INVALID',
      exitCode: 2,
    });
  }
  if (flags.help)
    return {
      exitCode: 0,
      stdout:
        'Usage: tiangong-lca runtime exec --manifest <file> --manifest-sha256 <trusted-sha256> --entry <id> --cwd <work-directory> [--cache-dir <dir>] [--lease <id> --lease-owner <owner>] -- <application argv>\n',
      stderr: '',
    };
  if (
    !flags.manifest ||
    !flags['manifest-sha256'] ||
    !flags.entry ||
    !flags.cwd ||
    Boolean(flags.lease) !== Boolean(flags['lease-owner'])
  )
    throw new CliError(
      'Runtime exec requires manifest, trust digest, entry and explicit work directory.',
      { code: 'RUNTIME_ARGUMENT_INVALID', exitCode: 2 },
    );
  const value = loadTrustedRuntimeManifest(flags.manifest, flags['manifest-sha256']);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await run(value, {
      cacheDir: flags['cache-dir'],
      entry: flags.entry,
      cwd: flags.cwd,
      argv,
      env,
      fetchImpl,
      signal: abort.signal,
      ...(flags.lease ? { lease: { id: flags.lease, owner: flags['lease-owner']! } } : {}),
    });
    return {
      exitCode: abort.signal.aborted
        ? 130
        : result.error
          ? 1
          : (result.status ?? (result.signal ? 130 : 1)),
      stdout: result.stdout,
      stderr:
        result.stderr ||
        (result.error && 'code' in result.error && result.error.code === 'RUNTIME_HOST_CONTEXT'
          ? `${result.error.message}\n`
          : ''),
    };
  } catch (error) {
    if (abort.signal.aborted)
      return {
        exitCode: 130,
        stdout: '',
        stderr:
          'Runtime execution interrupted; application recovery must preserve existing attempts.\n',
      };
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
