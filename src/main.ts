#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { executeCli } from './cli.js';
import { loadDotEnv } from './lib/dotenv.js';
import { usesTaskEnvironment } from './commands/root-arguments.js';
import { runtimePlatform } from './lib/runtime/descriptor.js';
import { toErrorPayload } from './shared/errors.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    runtimePlatform(process.platform, process.arch);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(toErrorPayload(error))}\n`);
    return 69;
  }
  const dotEnvStatus = !usesTaskEnvironment(argv)
    ? { loaded: false, path: path.join(process.cwd(), '.env'), count: 0 }
    : loadDotEnv(process.cwd(), env);
  const result = await executeCli(argv, {
    env,
    dotEnvStatus,
    fetchImpl: fetch,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

export function isDirectEntry(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }
  return importMetaUrl === pathToFileURL(path.resolve(argv1)).href;
}

export async function maybeRunFromProcess(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  importMetaUrl: string = import.meta.url,
): Promise<number | null> {
  const entryPath = argv[1];
  if (!isDirectEntry(importMetaUrl, entryPath)) {
    return null;
  }

  const exitCode = await main(argv.slice(2), env);
  process.exitCode = exitCode;
  return exitCode;
}

await maybeRunFromProcess();
