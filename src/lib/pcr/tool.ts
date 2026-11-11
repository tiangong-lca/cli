import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createFoundryCommandSpec,
  executeFoundryCommandSpec,
  type ExecuteFoundryCommandSpecOptions,
} from '../../command-spec.js';
import { canonicalCacheRoot, cachePath, writeOnce } from '../runtime/storage.js';
import { hashRuntimeFile, assertInventoryBudget } from '../runtime/files.js';
import {
  BASELINE_READER,
  LEGACY_SOURCE,
  LEGACY_FINGERPRINT,
  PCR_METADATA_LIMIT,
  object,
  digest,
  parseJson,
  stableVersion,
  compareVersions,
  compatibleReader,
  pcrError,
  type ReaderProfile,
} from './contract.js';
import { inspectPcrSnapshot, type SnapshotOptions } from './cache.js';

const TOOL_LOCK = 'pcr-tool-lock.json';
const VERIFY_FILE = 'pcr-library-verification.json';
export type ToolSelection = {
  schema: 'tiangong-lca.pcr-tool-lock.v1';
  root: string;
  entry: string;
  reader: ReaderProfile;
  content_sha256: string;
  source_commit: string;
  source_fingerprint: string;
};
function jsonFile(root: string, relative: string): unknown {
  const filename = cachePath(root, relative),
    stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > PCR_METADATA_LIMIT)
    pcrError('TOOL_INVALID', 'PCR tool metadata must be bounded regular files.');
  return parseJson(fs.readFileSync(filename));
}
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u;
const PACKAGE_MANIFEST =
  /^node_modules\/(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/node_modules\/(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)*\/package\.json$/u;
function declarationOnly(root: string, inventory: Set<string>, directory: string): boolean {
  const canonical = fs.realpathSync(directory);
  if (!canonical.startsWith(`${root}${path.sep}`))
    pcrError(
      'TOOL_CLOSURE',
      'PCR dependency metadata cannot come from outside the selected tool tree.',
    );
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  const metadata = object(jsonFile(root, `${relative}/package.json`));
  const types = metadata.types ?? metadata.typings;
  if (typeof types !== 'string' || !/\.d\.(?:c|m)?ts$/u.test(types)) return false;
  const declaration = path.resolve(canonical, types);
  if (!declaration.startsWith(`${canonical}${path.sep}`))
    pcrError('TOOL_CLOSURE', 'PCR declaration entries must stay inside their bundled package.');
  const entry = path.relative(root, declaration).split(path.sep).join('/');
  cachePath(root, entry);
  if (!inventory.has(entry)) return false;
  return ![...inventory].some(
    (file) =>
      file.startsWith(`${relative}/`) &&
      !file.slice(relative.length + 1).includes('node_modules/') &&
      /\.(?:[cm]?js|[cm]?ts|node)$/u.test(file) &&
      !/\.d\.(?:c|m)?ts$/u.test(file),
  );
}
function assertDeclaredClosure(root: string, files: ReturnType<typeof hashRuntimeFile>[]): void {
  const inventory = new Set(files.map((file) => file.path));
  for (const file of files.filter(
    (file) => file.path === 'package.json' || PACKAGE_MANIFEST.test(file.path),
  )) {
    const metadata = object(jsonFile(root, file.path));
    const required = object(metadata.dependencies ?? {}),
      optional = object(metadata.optionalDependencies ?? {}),
      peers = object(metadata.peerDependencies ?? {}),
      peerMeta = object(metadata.peerDependenciesMeta ?? {});
    const edges = new Map<string, { spec: unknown; optional: boolean }>();
    for (const [name, spec] of Object.entries(required)) edges.set(name, { spec, optional: false });
    for (const [name, spec] of Object.entries(optional)) edges.set(name, { spec, optional: true });
    for (const [name, spec] of Object.entries(peers))
      if (!edges.has(name))
        edges.set(name, {
          spec,
          optional: peerMeta[name] !== undefined && object(peerMeta[name]).optional === true,
        });
    const resolver = createRequire(cachePath(root, file.path));
    for (const [name, edge] of edges) {
      if (
        !PACKAGE_NAME.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..') ||
        typeof edge.spec !== 'string' ||
        edge.spec.length < 1 ||
        edge.spec.length > 1024
      )
        pcrError('TOOL_CLOSURE', 'PCR runtime dependency declarations must name bounded packages.');
      let resolved: string;
      try {
        resolved = resolver.resolve(name);
      } catch (error) {
        const candidates = resolver.resolve.paths(name) ?? [];
        const present = candidates.find((directory) =>
          fs.existsSync(path.join(directory, name, 'package.json')),
        );
        if (
          (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' &&
          present !== undefined &&
          declarationOnly(root, inventory, path.join(present, name))
        )
          continue;
        if (edge.optional && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
          if (candidates.some((directory) => fs.existsSync(path.join(directory, name))))
            pcrError(
              'TOOL_CLOSURE',
              'A declared optional PCR package is present but cannot be resolved.',
            );
          continue;
        }
        pcrError(
          'TOOL_CLOSURE',
          `PCR dependency ${name} declared by ${file.path} is missing or cannot be resolved.`,
        );
      }
      if (!path.isAbsolute(resolved))
        pcrError('TOOL_CLOSURE', 'PCR package declarations cannot resolve to built-in modules.');
      const target = fs.realpathSync(resolved);
      if (!target.startsWith(`${root}${path.sep}`))
        pcrError(
          'TOOL_CLOSURE',
          'PCR runtime dependencies cannot resolve outside the selected tool tree.',
        );
      const relative = path.relative(root, target).split(path.sep).join('/');
      cachePath(root, relative);
      if (!inventory.has(relative))
        pcrError('TOOL_CLOSURE', 'PCR dependency entry is absent from the pinned file inventory.');
    }
  }
}
export function inspectPcrTool(
  selectedRoot: string,
  capture?: ReturnType<typeof hashRuntimeFile>[],
): ToolSelection {
  const root = canonicalCacheRoot(selectedRoot),
    manifest = object(jsonFile(root, 'package.json'));
  if (
    manifest.name !== '@tiangong-lca/pcr' ||
    manifest.private === true ||
    manifest.type !== 'module'
  )
    pcrError('TOOL_INVALID', 'Select an installed compiled @tiangong-lca/pcr package explicitly.');
  const version = stableVersion(manifest.version),
    identity = object(jsonFile(root, 'product-release.json'));
  if (compareVersions(version, '0.4.1') < 0)
    pcrError('TOOL_INCOMPATIBLE', 'Task PCR consumption requires reader 0.4.1 or newer.');
  if (
    identity.schema !== 1 ||
    identity.version !== version ||
    identity.tag !== `v${version}` ||
    typeof identity.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(identity.sourceCommit) ||
    typeof identity.sourceFingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.sourceFingerprint) ||
    manifest.gitHead !== identity.sourceCommit
  )
    pcrError('TOOL_INVALID', 'PCR installed package metadata must match its product identity.');
  const bins = object(manifest.bin),
    entry = bins['tiangong-pcr'];
  if (typeof entry !== 'string' || !/\.(js|mjs|cjs)$/u.test(entry))
    pcrError('TOOL_INVALID', 'PCR tool must declare a compiled Node entry.');
  cachePath(root, entry);
  let reader: ReaderProfile;
  if (fs.existsSync(cachePath(root, 'reader-capabilities.json'))) {
    const capabilities = object(jsonFile(root, 'reader-capabilities.json'));
    if (
      Object.keys(capabilities).sort().join(',') !==
        'commandProtocol,kind,libraryFormats,projectionContracts,schema' ||
      capabilities.schema !== 1 ||
      capabilities.kind !== 'pcr-reader-capabilities' ||
      !Array.isArray(capabilities.libraryFormats) ||
      capabilities.libraryFormats.length < 1 ||
      capabilities.libraryFormats.length > 16 ||
      capabilities.libraryFormats.some(
        (item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1,
      ) ||
      new Set(capabilities.libraryFormats).size !== capabilities.libraryFormats.length ||
      !Array.isArray(capabilities.projectionContracts) ||
      capabilities.projectionContracts.length < 1 ||
      capabilities.projectionContracts.length > 16 ||
      capabilities.projectionContracts.some(
        (item) => typeof item !== 'string' || !/^[1-9][0-9]*$/u.test(item),
      ) ||
      new Set(capabilities.projectionContracts).size !== capabilities.projectionContracts.length ||
      capabilities.commandProtocol !== 1
    )
      pcrError('TOOL_INCOMPATIBLE', 'Unsupported PCR reader capability contract.');
    reader = {
      version,
      libraryFormats: capabilities.libraryFormats as number[],
      projectionContracts: capabilities.projectionContracts as string[],
      commandProtocol: capabilities.commandProtocol,
    };
  } else {
    if (
      version !== '0.4.1' ||
      identity.sourceCommit !== LEGACY_SOURCE ||
      identity.sourceFingerprint !== LEGACY_FINGERPRINT
    )
      pcrError(
        'TOOL_INCOMPATIBLE',
        'PCR tool lacks declared reader capabilities and is not the audited legacy 0.4.1 reader.',
      );
    reader = { ...BASELINE_READER };
  }
  const dependencies = object(manifest.dependencies);
  for (const [name, expected] of Object.entries(dependencies)) {
    if (
      !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u.test(name) ||
      name.split('/').some((part) => part === '.' || part === '..') ||
      typeof expected !== 'string'
    )
      pcrError('TOOL_INVALID', 'Invalid bundled PCR dependency.');
    if (object(jsonFile(root, `node_modules/${name}/package.json`)).version !== expected)
      pcrError('TOOL_INVALID', 'Installed PCR dependency differs from its frozen package version.');
  }
  const files: (ReturnType<typeof hashRuntimeFile> & { link_target?: string })[] = [];
  let bytes = 0;
  function walk(relative: string, depth: number): void {
    if (depth > 32) pcrError('TOOL_LIMIT', 'PCR tool directory nesting exceeds its budget.');
    const directory = relative ? cachePath(root, relative) : root;
    if (!fs.lstatSync(directory).isDirectory())
      pcrError('TOOL_INVALID', 'PCR tool root must be a directory.');
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = relative ? `${relative}/${name}` : name,
        absolute = path.join(directory, name),
        stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        if (!/^node_modules\/\.bin\/[a-zA-Z0-9._-]+$/u.test(filename))
          pcrError('TOOL_LINK', 'Only declared bundled dependency bin links are supported.');
        const target = fs.realpathSync(absolute),
          link = fs.readlinkSync(absolute);
        if (path.isAbsolute(link) || !target.startsWith(`${root}${path.sep}`))
          pcrError('TOOL_LINK', 'Bundled dependency bin links must stay inside the selected tool.');
        const admitted = Object.keys(dependencies).some((dependency) => {
          const dependencyRoot = cachePath(root, `node_modules/${dependency}`),
            metadata = object(jsonFile(root, `node_modules/${dependency}/package.json`));
          const declared =
            typeof metadata.bin === 'string'
              ? metadata.bin
              : metadata.bin && typeof metadata.bin === 'object' && !Array.isArray(metadata.bin)
                ? (metadata.bin as Record<string, unknown>)[name]
                : undefined;
          return typeof declared === 'string' && path.resolve(dependencyRoot, declared) === target;
        });
        if (!admitted)
          pcrError('TOOL_LINK', 'Dependency bin link does not match bundled package metadata.');
        const targetRelative = path.relative(root, target).split(path.sep).join('/');
        const file = hashRuntimeFile(cachePath(root, targetRelative), filename);
        bytes += file.bytes;
        files.push({ ...file, link_target: link });
        assertInventoryBudget(files.length, bytes);
      } else if (stat.isDirectory()) walk(filename, depth + 1);
      else {
        const file = hashRuntimeFile(absolute, filename);
        bytes += file.bytes;
        files.push(file);
        assertInventoryBudget(files.length, bytes);
      }
    }
  }
  walk('', 0);
  assertDeclaredClosure(root, files);
  if (capture !== undefined)
    capture.push(...files.filter((file) => file.link_target === undefined));
  if (!files.some((file) => file.path === entry))
    pcrError('TOOL_INVALID', 'Declared PCR entry is missing from the package inventory.');
  return {
    schema: 'tiangong-lca.pcr-tool-lock.v1',
    root,
    entry,
    reader,
    content_sha256: digest(Buffer.from(JSON.stringify(files))),
    source_commit: identity.sourceCommit,
    source_fingerprint: identity.sourceFingerprint,
  };
}
export function selectedPcrTool(taskDir: string, explicitRoot?: string): ToolSelection | null {
  const task = canonicalCacheRoot(taskDir),
    file = cachePath(task, TOOL_LOCK);
  if (!fs.existsSync(file)) return explicitRoot === undefined ? null : inspectPcrTool(explicitRoot);
  const stored = object(jsonFile(task, TOOL_LOCK));
  if (typeof stored.root !== 'string')
    pcrError('TOOL_INVALID', 'Invalid retained PCR tool selection.');
  const current = inspectPcrTool(stored.root);
  if (
    JSON.stringify(stored) !== JSON.stringify(current) ||
    (explicitRoot !== undefined && canonicalCacheRoot(explicitRoot) !== current.root)
  )
    pcrError('TOOL_CHANGED', 'The immutable task PCR tool selection changed.');
  return current;
}
export function bindPcrTool(options: SnapshotOptions, selected: ToolSelection): void {
  const snapshot = inspectPcrSnapshot(options);
  if (snapshot.pin === null || !compatibleReader(snapshot.pin.compatibility, selected.reader))
    pcrError('TOOL_INCOMPATIBLE', 'Selected PCR reader cannot consume the task snapshot.');
  const current = inspectPcrTool(selected.root);
  if (JSON.stringify(selected) !== JSON.stringify(current))
    pcrError('TOOL_CHANGED', 'PCR tool changed during preparation.');
  writeOnce(
    canonicalCacheRoot(options.taskDir),
    TOOL_LOCK,
    Buffer.from(`${JSON.stringify(selected)}\n`),
  );
}
async function runPinnedPcr(
  options: SnapshotOptions,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  execution: Pick<ExecuteFoundryCommandSpecOptions, 'spawnImpl'> = {},
  operation: 'consume' | 'verify' = 'consume',
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (
    args.length === 0 ||
    args.length > 256 ||
    args.some(
      (arg) =>
        arg.length > 16384 ||
        arg.includes('\0') ||
        arg === '--' ||
        /^(?:--root|--library|--library-sha256)(?:=|$)/u.test(arg),
    )
  )
    pcrError(
      'ARGUMENT',
      'PCR execution requires bounded arguments without source-selector overrides.',
    );
  const tool = selectedPcrTool(options.taskDir);
  if (tool === null)
    pcrError(
      'TOOL_REQUIRED',
      'Prepare the task with an explicit --tool-root before PCR execution.',
    );
  const snapshot = inspectPcrSnapshot(options);
  if (
    snapshot.pin === null ||
    snapshot.library === null ||
    !compatibleReader(snapshot.pin.compatibility, tool.reader)
  )
    pcrError('TOOL_INCOMPATIBLE', 'PCR execution requires a compatible pinned snapshot.');
  if (operation === 'consume' && !pcrIntegrityVerified(options, tool))
    pcrError(
      'NOT_VERIFIED',
      'Run pcr snapshot ensure to verify the retained task library before consuming it.',
    );
  const task = canonicalCacheRoot(options.taskDir),
    entry = cachePath(tool.root, tool.entry);
  const closure: ReturnType<typeof hashRuntimeFile>[] = [];
  if (JSON.stringify(inspectPcrTool(tool.root, closure)) !== JSON.stringify(tool))
    pcrError('TOOL_CHANGED', 'PCR reader closure changed before command binding.');
  const localOnly = args[0] === 'inspect' || args[0] === 'calculate';
  const argv = [
    entry,
    ...args,
    ...(localOnly
      ? []
      : [
          '--library',
          snapshot.library,
          '--library-sha256',
          `sha256:${snapshot.pin.database.sha256}`,
        ]),
  ];
  const artifacts = [
    snapshot.library,
    `${snapshot.library}.json`,
    cachePath(task, 'pcr-snapshot-lock.json'),
    cachePath(task, TOOL_LOCK),
    ...(operation === 'consume' ? [cachePath(task, VERIFY_FILE)] : []),
  ].map((filename, index) => ({
    ...hashRuntimeFile(filename, filename),
    role: `pcr-artifact-${index}`,
  }));
  artifacts.push(
    ...closure.map((file, index) => ({
      ...file,
      path: cachePath(tool.root, file.path),
      role: `pcr-tool-file-${index}`,
    })),
  );
  const spec = createFoundryCommandSpec({
    executable: process.execPath,
    argv,
    binding: { artifacts },
  });
  const childEnv = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USERPROFILE',
      'SystemRoot',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
      'TMPDIR',
      'LANG',
      'LC_ALL',
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  const result = await executeFoundryCommandSpec(spec, {
    ...execution,
    resolveArtifactPath: (filename) => filename,
    cwd: task,
    env: childEnv,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status === null)
    pcrError('EXECUTION', 'PCR tool did not complete normally.');
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
export async function executePinnedPcr(
  options: SnapshotOptions,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  execution: Pick<ExecuteFoundryCommandSpecOptions, 'spawnImpl'> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runPinnedPcr(options, args, env, execution);
}
export function pcrIntegrityVerified(options: SnapshotOptions, tool: ToolSelection): boolean {
  const task = canonicalCacheRoot(options.taskDir);
  if (!fs.existsSync(cachePath(task, VERIFY_FILE))) return false;
  const snapshot = inspectPcrSnapshot(options);
  const expected = {
    schema: 'tiangong-lca.pcr-library-verification.v1',
    snapshot_pin_sha256: digest(Buffer.from(JSON.stringify(snapshot.pin))),
    tool_content_sha256: tool.content_sha256,
  };
  if (JSON.stringify(jsonFile(task, VERIFY_FILE)) !== JSON.stringify(expected))
    pcrError(
      'INTEGRITY',
      'PCR library verification receipt differs from the task and reader bytes.',
    );
  return true;
}
export async function verifyPinnedPcrIntegrity(
  options: SnapshotOptions,
  tool: ToolSelection,
): Promise<void> {
  const result = await runPinnedPcr(
    options,
    ['library', 'verify', '--format', 'json'],
    process.env,
    {},
    'verify',
  );
  if (result.exitCode !== 0)
    pcrError('LIBRARY_INVALID', 'The selected PCR reader rejected snapshot integrity.');
  const observed = object(parseJson(Buffer.from(result.stdout))),
    snapshot = inspectPcrSnapshot(options);
  const identity = object(observed.snapshot);
  if (
    observed.verified !== true ||
    observed.tool_version !== tool.reader.version ||
    identity.content_version !== snapshot.pin?.version ||
    identity.source_commit !== snapshot.pin?.source_commit ||
    observed.sha256 !== `sha256:${snapshot.pin?.database.sha256}`
  )
    pcrError(
      'LIBRARY_INVALID',
      'PCR library verification did not bind the task snapshot and selected reader.',
    );
  writeOnce(
    canonicalCacheRoot(options.taskDir),
    VERIFY_FILE,
    Buffer.from(
      `${JSON.stringify({ schema: 'tiangong-lca.pcr-library-verification.v1', snapshot_pin_sha256: digest(Buffer.from(JSON.stringify(snapshot.pin))), tool_content_sha256: tool.content_sha256 })}\n`,
    ),
  );
}
