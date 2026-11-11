import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../../shared/errors.js';
import type { RuntimeFileFact } from './types.js';

export function runtimeError(code: string, message: string): never {
  throw new CliError(message, { code, exitCode: 69 });
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Hash one descriptor without loading the whole executable or following a selected symlink. */
export function hashRuntimeFile(file: string, label: string): RuntimeFileFact {
  const before = fs.lstatSync(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.size > 512 * 1024 * 1024) {
    runtimeError('RUNTIME_FILE_INVALID', 'Runtime files must be bounded regular files.');
  }
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      runtimeError('RUNTIME_FILE_CHANGED', 'Runtime file changed before it could be inspected.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > before.size)
        runtimeError('RUNTIME_FILE_CHANGED', 'Runtime file grew during inspection.');
      hash.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const selected = fs.lstatSync(file, { bigint: true });
    if (
      BigInt(bytes) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      selected.dev !== before.dev ||
      selected.ino !== before.ino ||
      selected.isSymbolicLink() ||
      !selected.isFile()
    ) {
      runtimeError('RUNTIME_FILE_CHANGED', 'Runtime file changed during inspection.');
    }
    return Object.freeze({ path: label, bytes, sha256: hash.digest('hex') });
  } finally {
    fs.closeSync(fd);
  }
}

export function assertInventoryBudget(count: number, bytes: number): void {
  if (count > 50_000 || bytes > 2 * 1024 * 1024 * 1024) {
    runtimeError(
      'RUNTIME_INVENTORY_LIMIT',
      'Runtime inventory exceeds its bounded file or byte budget.',
    );
  }
}

export function listRuntimeFiles(root: string): readonly RuntimeFileFact[] {
  const files: RuntimeFileFact[] = [
    hashRuntimeFile(path.join(root, 'package.json'), 'package.json'),
  ];
  let totalBytes = files[0]!.bytes;
  const directoryPath = (relative: string): string => {
    const directory = path.join(root, relative);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      runtimeError('RUNTIME_DIRECTORY_INVALID', 'Runtime directories cannot be symlinks.');
    return directory;
  };
  // The initial subtree skips this container; inspect it before following dist/src.
  directoryPath('dist');
  const walk = (relative: string): void => {
    const directory = directoryPath(relative);
    for (const name of fs.readdirSync(directory).sort()) {
      const item = `${relative}/${name}`;
      const file = path.join(root, item);
      const child = fs.lstatSync(file);
      if (child.isDirectory()) walk(item);
      else {
        const fact = hashRuntimeFile(file, item);
        files.push(fact);
        totalBytes += fact.bytes;
        assertInventoryBudget(files.length, totalBytes);
      }
    }
  };
  for (const directory of ['bin', 'dist/src', 'assets']) walk(directory);
  return Object.freeze(files.sort((left, right) => (left.path < right.path ? -1 : 1)));
}
