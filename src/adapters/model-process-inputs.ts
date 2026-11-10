import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireContent, object, type JsonObject } from '../application/dataset-types.js';
import { contentDigest, listContentReferences } from '../application/dataset-content.js';
import { datasetIdentity, unwrapDatasetPayload } from '../lib/dataset/local.js';
import { datasetReader } from './dataset-read.js';
import { resolveRequestFile } from './model-input.js';
import { CommandInputError } from '../shared/command-result.js';
import type { FetchLike } from '../lib/transport/http.js';

export async function stageModelProcesses(
  sources: JsonObject,
  model: JsonObject,
  inputPath: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  const references = listContentReferences(model).filter((ref) =>
    String(ref.path).endsWith('/referenceToProcess'),
  );
  if (
    references.length > 1000 ||
    references.some(
      (ref) =>
        typeof ref.id !== 'string' ||
        !ref.id ||
        typeof ref.version !== 'string' ||
        !/^\d{2}\.\d{2}\.\d{3}$/u.test(ref.version),
    )
  )
    throw new CommandInputError(
      'EXACT_REFERENCE_REQUIRED',
      'Every Model Process reference must bind an exact id/version, within 1000 occurrences.',
    );
  if (Array.isArray(sources.run_dirs) && sources.run_dirs.length)
    throw new CommandInputError(
      'WORKFLOW_INPUT_UNSUPPORTED',
      'Use explicit Process content/files/catalog, not production run directories.',
    );
  const files = sources.process_json_files === undefined ? [] : sources.process_json_files;
  const directories = sources.process_json_dirs === undefined ? [] : sources.process_json_dirs;
  if (!Array.isArray(files) || !Array.isArray(directories))
    throw new CommandInputError(
      'PROCESS_INPUT_INVALID',
      'Process files and directories must be arrays.',
    );
  const remote = sources.allow_remote_lookup === true;
  if (remote && (files.length || directories.length || sources.process_catalog_path))
    throw new CommandInputError(
      'PROCESS_INPUT_AMBIGUOUS',
      'Choose explicit local Process inputs or remote exact lookup.',
    );
  const stagedFiles: string[] = [];
  const bindings = new Map<
    string,
    { id: string; version: string; digest: string; source: string; staged: string }
  >();
  const stage = (value: unknown, source: string) => {
    const payload = requireContent('process', unwrapDatasetPayload(object(value, 'Process input')));
    const identity = datasetIdentity({}, payload, 'process');
    if (
      !identity.id ||
      !/^[0-9a-f-]{36}$/iu.test(identity.id) ||
      !identity.version ||
      !/^\d{2}\.\d{2}\.\d{3}$/u.test(identity.version)
    )
      throw new CommandInputError(
        'PROCESS_IDENTITY_INVALID',
        'Process content requires its own UUID and exact version.',
      );
    const key = `${identity.id}@${identity.version}`;
    const digest = contentDigest(payload);
    const previous = bindings.get(key);
    if (previous) {
      if (previous.digest !== digest)
        throw new CommandInputError(
          'PROCESS_CONTENT_CONFLICT',
          'Duplicate Process identity has conflicting content.',
        );
      return;
    }
    const staged = path.join(directory, `${identity.id}_${identity.version}.json`);
    writeFileSync(staged, JSON.stringify(payload), { mode: 0o600 });
    stagedFiles.push(staged);
    bindings.set(key, { id: identity.id, version: identity.version, digest, source, staged });
  };
  const stageFile = (file: unknown, origin: string) => {
    const absolute = resolveRequestFile(file, origin);
    stage(JSON.parse(readFileSync(absolute, 'utf8')), absolute);
  };
  for (const file of files) stageFile(file, inputPath);
  for (const selected of directories) {
    const folder = resolveRequestFile(selected, inputPath);
    for (const entry of readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name)))
      stageFile(path.join(folder, entry.name), inputPath);
  }
  if (sources.process_catalog_path) {
    const catalogPath = resolveRequestFile(sources.process_catalog_path, inputPath);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(catalog))
      throw new CommandInputError(
        'PROCESS_CATALOG_INVALID',
        'Process catalog must be an array of content objects or {file} records.',
      );
    for (const item of catalog) {
      const entry = object(item, 'catalog entry');
      if (entry.file) stageFile(entry.file, catalogPath);
      else stage(entry.content ?? entry, catalogPath);
    }
  }
  if (remote)
    for (const reference of references) {
      const id = String(reference.id);
      const version = String(reference.version);
      if (bindings.has(`${id}@${version}`)) continue;
      const page = await datasetReader(env, fetchImpl)('process', {
        id,
        version,
        limit: 1,
        offset: 0,
      });
      const row = page.records[0];
      if (!row)
        throw new CommandInputError(
          'PROCESS_NOT_FOUND',
          'Exact Process input not found or not visible.',
        );
      stage(row.content, `${page.environment}:process:${id}@${version}`);
    }
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith(directory)) {
      const binding = [...bindings.values()].find((entry) => entry.staged === value);
      return binding
        ? `snapshot:process:${binding.id}@${binding.version}:${binding.digest}`
        : 'local-snapshot';
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]),
      );
    return value;
  };
  return {
    files: stagedFiles,
    bindings: [...bindings.values()].map(({ staged: _staged, ...binding }) => binding),
    sanitize,
  };
}
