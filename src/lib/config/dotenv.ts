import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type DotEnvLoadResult = {
  loaded: boolean;
  path: string;
  count: number;
};

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadDotEnv(cwd: string, env: NodeJS.ProcessEnv): DotEnvLoadResult {
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) {
    return { loaded: false, path: envPath, count: 0 };
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/u);
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || env[key] !== undefined) {
      continue;
    }

    env[key] = stripQuotes(rawValue);
    count += 1;
  }

  return { loaded: true, path: envPath, count };
}
