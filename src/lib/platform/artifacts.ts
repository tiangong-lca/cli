import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from '../../shared/errors.js';

type WriteJsonLinesOptions = {
  append?: boolean;
};

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeAtomicFile(filePath: string, text: string): void {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;

  try {
    writeFileSync(tempPath, text, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function readRequiredTextArtifact(filePath: string, code: string): string {
  if (!existsSync(filePath)) {
    throw new CliError(`Artifact file not found: ${filePath}`, {
      code,
      exitCode: 2,
    });
  }

  return readFileSync(filePath, 'utf8');
}

function normalizeJsonLines(rows: unknown | unknown[]): string {
  const normalizedRows = Array.isArray(rows) ? rows : [rows];
  if (!normalizedRows.length) {
    return '';
  }

  return `${normalizedRows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

export function writeTextArtifact(filePath: string, text: string): string {
  writeAtomicFile(filePath, text);
  return filePath;
}

export function writeJsonArtifact(filePath: string, value: unknown, compact = false): string {
  writeAtomicFile(filePath, `${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
  return filePath;
}

export function writeJsonLinesArtifact(
  filePath: string,
  rows: unknown | unknown[],
  options?: WriteJsonLinesOptions,
): string {
  const text = normalizeJsonLines(rows);

  if (options?.append) {
    ensureParentDir(filePath);
    appendFileSync(filePath, text, 'utf8');
    return filePath;
  }

  writeAtomicFile(filePath, text);
  return filePath;
}

export function readJsonArtifact(filePath: string): unknown {
  const text = readRequiredTextArtifact(filePath, 'ARTIFACT_NOT_FOUND');

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Artifact file is not valid JSON: ${filePath}`, {
      code: 'ARTIFACT_INVALID_JSON',
      exitCode: 2,
      details: String(error),
    });
  }
}

export function readJsonLinesArtifact(filePath: string): unknown[] {
  const text = readRequiredTextArtifact(filePath, 'ARTIFACT_NOT_FOUND');
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new CliError(`Artifact file contains invalid JSONL at line ${index + 1}: ${filePath}`, {
        code: 'ARTIFACT_INVALID_JSONL',
        exitCode: 2,
        details: String(error),
      });
    }
  });
}
