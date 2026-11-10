import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { stableJsonText } from './canonical-json-hash.js';
import { CliError } from '../shared/errors.js';

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ProtectedJsonArtifact = {
  resolved: string;
  value: unknown;
  text: string;
  file_sha256: string;
};

export type ProtectedTextArtifact = Omit<ProtectedJsonArtifact, 'value'>;

export function readProtectedTextArtifact(filePath: string): ProtectedTextArtifact {
  const resolved = path.resolve(filePath);
  const bytes = readFileSync(resolved);
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    throw new CliError(`Protected artifact is not valid UTF-8: ${resolved}`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_ARTIFACT_UTF8_INVALID',
      exitCode: 2,
      details: String(error),
    });
  }
  return {
    resolved,
    text,
    file_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function readProtectedJsonArtifact(options: {
  filePath: string;
  label: string;
}): ProtectedJsonArtifact {
  const artifact = readProtectedTextArtifact(options.filePath);
  let value: unknown;
  try {
    value = JSON.parse(artifact.text);
  } catch (error) {
    throw new CliError(`${options.label} is not valid JSON: ${artifact.resolved}`, {
      code: 'DATASET_MAINTENANCE_ARTIFACT_INVALID',
      exitCode: 2,
      details: String(error),
    });
  }
  return {
    ...artifact,
    value,
  };
}

export function ensurePrivateArtifactDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  chmodSync(resolved, 0o700);
  return resolved;
}

export function materializePrivateArtifactDirectoryAtomically<T>(
  directory: string,
  materialize: (stagingDirectory: string) => T,
): T {
  const resolved = path.resolve(directory);
  if (existsSync(resolved)) {
    throw new CliError(`Protected artifact directory already exists: ${resolved}`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_ARTIFACT_DIRECTORY_EXISTS',
      exitCode: 1,
    });
  }
  const parent = path.dirname(resolved);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(parent, `.${path.basename(resolved)}.staging-`));
  chmodSync(staging, 0o700);
  try {
    const result = materialize(staging);
    if (existsSync(resolved)) {
      throw new CliError(
        `Protected artifact directory appeared during materialization: ${resolved}`,
        {
          code: 'DATASET_MAINTENANCE_PROTECTED_ARTIFACT_DIRECTORY_RACE',
          exitCode: 1,
        },
      );
    }
    renameSync(staging, resolved);
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function writePrivateImmutableText(filePath: string, text: string): string {
  const resolved = path.resolve(filePath);
  const bytes = Buffer.from(text, 'utf8');
  ensurePrivateArtifactDirectory(path.dirname(resolved));
  if (existsSync(resolved)) {
    if (!readFileSync(resolved).equals(bytes)) {
      throw new CliError(`Refusing to overwrite protected evidence: ${resolved}`, {
        code: 'DATASET_MAINTENANCE_PROTECTED_ARTIFACT_IMMUTABLE',
        exitCode: 1,
      });
    }
    chmodSync(resolved, 0o600);
    return resolved;
  }
  writeFileSync(resolved, bytes, { flag: 'wx', mode: 0o600 });
  return resolved;
}

export function writePrivateImmutableJson(filePath: string, value: unknown): string {
  return writePrivateImmutableText(filePath, `${stableJsonText(value)}\n`);
}
