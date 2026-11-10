import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.js';
import type { FetchLike } from '../../lib/transport/http.js';
import { loadTrustedRuntimeManifest } from '../../lib/runtime/manifest.js';
import {
  ensureRuntimeComponents,
  inspectRuntimeComponents,
  pruneRuntimeComponents,
} from '../../lib/runtime/manager.js';
import { releaseRuntimeLease } from '../../lib/runtime/leases.js';
import { defaultRuntimeCache, openRuntimeCache } from '../../lib/runtime/storage.js';

export async function runManagedRuntimeCommand(
  operation: string,
  args: string[],
  fetchImpl?: FetchLike,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let values;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        manifest: { type: 'string' },
        'manifest-sha256': { type: 'string' },
        'cache-dir': { type: 'string' },
        lease: { type: 'string' },
        'lease-owner': { type: 'string' },
        apply: { type: 'boolean' },
      },
    }).values;
  } catch {
    throw new CliError('Invalid runtime management arguments.', {
      code: 'RUNTIME_ARGUMENT_INVALID',
      exitCode: 2,
    });
  }
  if (values.help)
    return {
      exitCode: 0,
      stdout:
        'Usage: tiangong-lca runtime ensure|status|prune --manifest <file> --manifest-sha256 <trusted-sha256> [--cache-dir <absolute-dir>] [--json]\nensure accepts --lease <id> --lease-owner <non-secret-owner>. prune requires --apply.\nlease-release requires --lease and --lease-owner. No authentication or task state is created.\n',
      stderr: '',
    };
  const cacheDir = values['cache-dir'] ?? defaultRuntimeCache();
  if (operation === 'lease-release') {
    if (
      !values.lease ||
      !values['lease-owner'] ||
      values.manifest ||
      values['manifest-sha256'] ||
      values.apply
    )
      throw new CliError('Lease release requires only cache, lease id and owner.', {
        code: 'RUNTIME_ARGUMENT_INVALID',
        exitCode: 2,
      });
    const root = openRuntimeCache(cacheDir, false);
    const released = fs.existsSync(path.join(root, '.runtime-cache.json'))
      ? await releaseRuntimeLease(root, values.lease, values['lease-owner'])
      : false;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ schema: 'tiangong-lca.runtime-lease-release.v1', released }) + '\n',
      stderr: '',
    };
  }
  if (
    !values.manifest ||
    !values['manifest-sha256'] ||
    Boolean(values.lease) !== Boolean(values['lease-owner']) ||
    ((values.lease || values['lease-owner']) && operation !== 'ensure') ||
    (values.apply && operation !== 'prune')
  )
    throw new CliError(
      'Select an explicit manifest and independent digest; lease options apply only to ensure.',
      { code: 'RUNTIME_ARGUMENT_INVALID', exitCode: 2 },
    );
  const trusted = loadTrustedRuntimeManifest(values.manifest, values['manifest-sha256']);
  const options = {
    cacheDir,
    fetchImpl,
    ...(values.lease ? { lease: { id: values.lease, owner: values['lease-owner']! } } : {}),
  };
  if (operation === 'prune') {
    if (!values.apply)
      throw new CliError('Pruning requires an explicit --apply for this manifest component set.', {
        code: 'RUNTIME_PRUNE_APPLY_REQUIRED',
        exitCode: 2,
      });
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({
          schema: 'tiangong-lca.runtime-prune.v1',
          ...(await pruneRuntimeComponents(trusted, options)),
        }) + '\n',
      stderr: '',
    };
  }
  const report =
    operation === 'ensure'
      ? await ensureRuntimeComponents(trusted, options)
      : inspectRuntimeComponents(trusted, options);
  return {
    exitCode: report.status === 'ready' ? 0 : 69,
    stdout: values.json
      ? JSON.stringify(report) + '\n'
      : `Runtime ${report.status}: ${report.components.map((item) => `${item.id}@${item.version} ${item.status}`).join(', ')}\n`,
    stderr: '',
  };
}
