import fs from 'node:fs';
import path from 'node:path';
import { extractRuntimeArchive } from '../lib/runtime/archive.js';
import { hashRuntimeFile } from '../lib/runtime/files.js';
import {
  array,
  integer,
  record,
  relativeFile,
  sha,
  unique,
} from '../lib/runtime/manifest-values.js';
import type { ComponentFile } from '../lib/runtime/manifest-types.js';
import { resolveCliStateDirectory } from '../shared/state-directory.js';
import { CommandInputError } from '../shared/command-result.js';
import { text, type JsonObject } from '../application/dataset-types.js';
import { CliError } from '../shared/errors.js';
import { setupModelRuntime } from './model-runtime.js';

function invalid(message: string): never {
  throw new CommandInputError('MODEL_INSTALL_INVALID', message, 'environment');
}

/** An explicitly selected local package is executable code, not a research input. */
export async function installModelRuntime(
  bundle: string,
  env: NodeJS.ProcessEnv,
  check: typeof setupModelRuntime = setupModelRuntime,
  host = `${process.platform}-${process.arch}`,
): Promise<JsonObject> {
  // This installer currently qualifies only the self-contained Apple Silicon package.
  if (host !== 'darwin-arm64')
    invalid(
      'Local Model package installation currently requires macOS ARM64. Other hosts may configure an independently installed engine with --engine and --static-cache.',
    );
  const source = path.resolve(text(bundle, '--install'));
  const manifestPath = path.join(source, 'manifest.json');
  if (!fs.lstatSync(manifestPath).isFile() || fs.statSync(manifestPath).size > 1024 * 1024)
    invalid('Expected a regular manifest.json of at most 1 MiB in the selected package directory.');
  const manifest = record(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), 'Model package');
  if (manifest.schema !== 'lca.model-runtime-package.v1' || manifest.platform !== host)
    invalid('Model package schema or platform is incompatible with this host.');
  const files: ComponentFile[] = array(manifest.files, 1024, 4).map((value) => {
    const file = record(value, 'file');
    if (file.mode !== 420 && file.mode !== 493) invalid('Package file mode must be 0644 or 0755.');
    return {
      path: relativeFile(file.path),
      bytes: integer(file.bytes, 512 * 1024 * 1024),
      sha256: sha(file.sha256),
      mode: file.mode,
    };
  });
  unique(
    files.map((file) => file.path.toLowerCase()),
    'package file',
  );
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 2 * 1024 * 1024 * 1024)
    invalid('Unpacked Model package exceeds 2 GiB.');
  for (const required of [
    'bin/model_calculate',
    'cache/lciamethods/cache_manifest.json',
    'cache/lciamethods/list.json',
    'cache/lciamethods/flow_factors.json.gz',
  ])
    if (!files.some((file) => file.path === required)) invalid(`Package is missing ${required}.`);
  if (files.find((file) => file.path === 'bin/model_calculate')!.mode !== 493)
    invalid('Model engine must be executable.');
  const archive = path.join(source, 'runtime.tar.gz');
  const expected = record(manifest.archive, 'archive');
  const bytes = integer(expected.bytes, 512 * 1024 * 1024, 1);
  const digest = sha(expected.sha256);
  const actual = hashRuntimeFile(archive, 'runtime.tar.gz');
  if (actual.bytes !== bytes || actual.sha256 !== digest)
    invalid(
      'Model package archive is incomplete or corrupted. Obtain the complete trusted package again.',
    );
  const parent = path.join(resolveCliStateDirectory({ env }), 'model-runtimes');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const owned = fs.mkdtempSync(path.join(parent, 'install-'));
  const root = path.join(owned, 'runtime');
  let complete = false;
  try {
    // Snapshot the selected archive before extraction; extraction also checks every file.
    const snapshot = path.join(owned, 'runtime.tar.gz');
    fs.copyFileSync(archive, snapshot, fs.constants.COPYFILE_EXCL);
    const copied = hashRuntimeFile(snapshot, 'runtime.tar.gz');
    if (copied.bytes !== bytes || copied.sha256 !== digest)
      invalid('Model package changed while installing.');
    await extractRuntimeArchive(snapshot, root, { files });
    fs.unlinkSync(snapshot);
    const result = check(
      { engine: path.join(root, 'bin/model_calculate'), staticCache: path.join(root, 'cache') },
      env,
    );
    complete = true;
    return { ...result, installed: true, installationDirectory: root, downloaded: false };
  } finally {
    if (!complete) fs.rmSync(owned, { recursive: true, force: true });
  }
}

export async function setupLocalModel(
  request: JsonObject,
  env: NodeJS.ProcessEnv,
): Promise<JsonObject> {
  if (request.install !== undefined) {
    if (request.check === true || request.engine !== undefined || request.staticCache !== undefined)
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        '--install cannot be combined with --check, --engine or --static-cache.',
      );
    const bundle = text(request.install, '--install');
    try {
      return await installModelRuntime(bundle, env);
    } catch (error) {
      if (error instanceof CommandInputError) throw error;
      if (error instanceof CliError) invalid(error.message);
      throw new CommandInputError(
        'MODEL_INSTALL_UNAVAILABLE',
        'Cannot read or install the selected local package. Check manifest.json, runtime.tar.gz and local directory permissions. No login or service connection is needed.',
        'environment',
      );
    }
  }
  return setupModelRuntime(request, env);
}
