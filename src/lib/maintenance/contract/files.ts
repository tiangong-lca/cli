import { sha256Text, stableJsonText } from '../../platform/canonical-json-hash.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../../../shared/errors.js';

export function readJsonFile(filePath: string, label: string): unknown {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new CliError(`${label} not found: ${resolved}`, {
      code: 'DATASET_MAINTENANCE_ARTIFACT_NOT_FOUND',
      exitCode: 2,
    });
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new CliError(`${label} is not valid JSON: ${resolved}`, {
      code: 'DATASET_MAINTENANCE_ARTIFACT_INVALID',
      exitCode: 2,
      details: String(error),
    });
  }
}

export function writeImmutableText(filePath: string, text: string): string {
  const resolved = path.resolve(filePath);
  if (existsSync(resolved)) {
    if (readFileSync(resolved, 'utf8') === text) {
      return resolved;
    }
    throw new CliError(`Refusing to overwrite immutable maintenance artifact: ${resolved}`, {
      code: 'DATASET_MAINTENANCE_ARTIFACT_IMMUTABLE',
      exitCode: 1,
    });
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, text, { encoding: 'utf8', flag: 'wx' });
  return resolved;
}

export function writeImmutableJson(filePath: string, value: unknown): string {
  return writeImmutableText(filePath, `${stableJsonText(value)}\n`);
}

export function writeImmutableJsonLines(filePath: string, values: unknown[]): string {
  const text = values.length ? `${values.map(stableJsonText).join('\n')}\n` : '';
  return writeImmutableText(filePath, text);
}

export function appendStableJsonLine(filePath: string, value: unknown): string {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  appendFileSync(resolved, `${stableJsonText(value)}\n`, 'utf8');
  return resolved;
}

export function readJsonLinesIfPresent(filePath: string): unknown[] {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    return [];
  }
  return readFileSync(resolved, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new CliError(`Invalid maintenance JSONL at ${resolved}:${index + 1}`, {
          code: 'DATASET_MAINTENANCE_ARTIFACT_INVALID',
          exitCode: 1,
          details: String(error),
        });
      }
    });
}

export function safeActionFileName(actionId: string): string {
  const safe = actionId.replace(/[^a-zA-Z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '');
  return safe || sha256Text(actionId).slice(0, 16);
}

export function resolveMaintenancePlanArtifactPath(
  planDir: string,
  relativePath: string,
  label: string,
): string {
  const root = path.resolve(planDir);
  if (!relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new CliError(`${label} must be a relative path inside the maintenance plan directory.`, {
      code: 'DATASET_MAINTENANCE_PLAN_ARTIFACT_PATH_INVALID',
      exitCode: 2,
      details: relativePath,
    });
  }
  const resolved = path.resolve(root, relativePath);
  const withinRoot = path.relative(root, resolved);
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${path.sep}`)) {
    throw new CliError(`${label} must stay inside the maintenance plan directory.`, {
      code: 'DATASET_MAINTENANCE_PLAN_ARTIFACT_PATH_INVALID',
      exitCode: 2,
      details: relativePath,
    });
  }
  return resolved;
}
