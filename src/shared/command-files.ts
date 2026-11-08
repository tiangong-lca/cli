import {
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandInputError } from './command-result.js';

export function readCommandInput(file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file === '-' ? 0 : path.resolve(file), 'utf8'));
  } catch {
    throw new CommandInputError(
      'INPUT_INVALID_JSON',
      'Input must be a readable JSON file or JSON on stdin.',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandInputError('INPUT_OBJECT_REQUIRED', 'Input must be one JSON object.');
  }
  return value as Record<string, unknown>;
}

export function writeCommandOutput(file: string, value: unknown, force: boolean, input?: string) {
  const output = path.resolve(file);
  if (input && input !== '-') {
    const source = realpathSync(input);
    let same = source === output;
    try {
      const a = statSync(source);
      const b = statSync(output);
      same ||= a.dev === b.dev && a.ino === b.ino;
    } catch {
      /* A missing destination is expected on first output. */
    }
    if (same)
      throw new CommandInputError('OUTPUT_IS_INPUT', 'Output must not replace the input file.');
  }
  const text = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (force) renameSync(temporary, output);
    else linkSync(temporary, output);
  } catch {
    throw new CommandInputError(
      'OUTPUT_UNAVAILABLE',
      'Could not write output; choose a writable new path or use --force to replace a separate output.',
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path: output, purpose: 'complete_result', bytes: Buffer.byteLength(text) };
}
