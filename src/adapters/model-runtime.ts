import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCliStateDirectory } from '../shared/state-directory.js';
import { CommandInputError } from '../shared/command-result.js';
import { object, text, type JsonObject } from '../application/dataset-types.js';

export function modelRuntimeFile(env: NodeJS.ProcessEnv): string {
  return path.join(resolveCliStateDirectory({ env }), 'model-runtime.json');
}
export function readModelRuntime(env: NodeJS.ProcessEnv): JsonObject {
  const file = modelRuntimeFile(env);
  if (!existsSync(file)) return {};
  try {
    const value = object(JSON.parse(readFileSync(file, 'utf8')), 'model runtime');
    if (
      value.schemaVersion !== 1 ||
      typeof value.engine !== 'string' ||
      typeof value.staticCache !== 'string'
    )
      throw new Error('invalid');
    return value;
  } catch {
    throw new CommandInputError(
      'MODEL_RUNTIME_CONFIG_INVALID',
      'Model runtime configuration is invalid. Run setup model-calculation with explicit --engine and --static-cache to replace it.',
      'environment',
    );
  }
}
export function modelRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      [
        'PATH',
        'HOME',
        'USERPROFILE',
        'TMPDIR',
        'TMP',
        'TEMP',
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'LD_LIBRARY_PATH',
        'DYLD_LIBRARY_PATH',
      ].includes(key),
    ),
  );
}
export function resolveModelRuntime(
  request: JsonObject,
  env: NodeJS.ProcessEnv,
): { engine: string; staticCache: string } {
  const explicitEngine = request.engine ?? env.TIANGONG_LCA_MODEL_ENGINE;
  const explicitCache = request.staticCache ?? env.TIANGONG_LCA_MODEL_STATIC_CACHE;
  const saved =
    explicitEngine !== undefined && explicitCache !== undefined ? {} : readModelRuntime(env);
  const engine = explicitEngine ?? saved.engine;
  const staticCache = explicitCache ?? saved.staticCache;
  if (!engine || !staticCache)
    throw new CommandInputError(
      'MODEL_RUNTIME_NOT_CONFIGURED',
      'Run setup model-calculation --install <trusted-package-directory> (macOS ARM64), or configure an existing installation with --engine <executable> --static-cache <directory>.',
      'environment',
    );
  return {
    engine: text(engine, 'engine'),
    staticCache: path.resolve(text(staticCache, 'static-cache')),
  };
}
export function setupModelRuntime(
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  execute: typeof spawnSync = spawnSync,
): JsonObject {
  const selected = resolveModelRuntime(request, env);
  const report = execute(selected.engine, ['--check', '--static-cache', selected.staticCache], {
    encoding: 'utf8',
    shell: false,
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: modelRuntimeEnvironment(env),
  });
  if (report.error || report.status !== 0)
    throw new CommandInputError(
      'MODEL_RUNTIME_CHECK_FAILED',
      'Local engine or LCIA factor-cache check failed. Check the executable, its native dependencies and the complete factor directory. No configuration was changed.',
      'environment',
    );
  let capability: JsonObject;
  try {
    capability = object(JSON.parse(report.stdout), 'engine capability');
    if (
      capability.status !== 'ready' ||
      capability.profile !== 'lca.model-local.v1' ||
      capability.inputSchema !== 'lca.model-input.v1' ||
      capability.characterization !== 'method-defined-sparse' ||
      !Number.isInteger(capability.methodCount) ||
      Number(capability.methodCount) < 1
    )
      throw new Error('invalid');
  } catch {
    throw new CommandInputError(
      'MODEL_RUNTIME_UNSUPPORTED',
      'Selected engine does not expose the required Model calculation capability. Use a compatible model_calculate distribution.',
      'environment',
    );
  }
  const file = modelRuntimeFile(env);
  if (request.check !== true) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          schemaVersion: 1,
          ...selected,
          engine:
            path.isAbsolute(selected.engine) || !/[\\/]/u.test(selected.engine)
              ? selected.engine
              : path.resolve(selected.engine),
        }),
        { mode: 0o600, flag: 'wx', flush: true },
      );
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    ...capability,
    ...selected,
    configurationFile: file,
    configured: request.check !== true,
    downloaded: false,
  };
}
