import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { cachePath, writeAll } from './storage.js';
import { runtimeError } from './files.js';
import type { RuntimeComponent } from './manifest-types.js';

function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const zero = bytes.indexOf(0);
  if (zero >= 0 && bytes.subarray(zero).some((value) => value !== 0))
    runtimeError('RUNTIME_ARCHIVE_HEADER', 'USTAR text padding is invalid.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      zero < 0 ? bytes : bytes.subarray(0, zero),
    );
  } catch {
    runtimeError('RUNTIME_ARCHIVE_HEADER', 'USTAR paths must be valid UTF-8.');
  }
}
function octal(bytes: Buffer): number {
  const raw = bytes.toString('ascii');
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === '\0' || raw[end - 1] === ' ')) end--;
  const digits = raw.slice(0, end);
  if (!/^[0-7]+$/u.test(digits))
    runtimeError('RUNTIME_ARCHIVE_HEADER', 'USTAR numeric fields must use bounded octal.');
  // All callers supply at most twelve octets; the value is within exact integer range.
  return Number.parseInt(digits, 8);
}
function readExact(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0)
      runtimeError(
        'RUNTIME_ARCHIVE_TRUNCATED',
        'Runtime archive ended before its declared content.',
      );
    offset += count;
  }
}
export async function extractRuntimeArchive(
  archive: string,
  root: string,
  component: Pick<RuntimeComponent, 'files'>,
  signal?: AbortSignal,
): Promise<void> {
  const decoded = `${root}.tar`;
  const expectedBytes =
    1024 + component.files.reduce((sum, file) => sum + 512 + Math.ceil(file.bytes / 512) * 512, 0);
  let decodedBytes = 0;
  await pipeline(
    fs.createReadStream(archive),
    createGunzip(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        decodedBytes += chunk.length;
        if (decodedBytes > expectedBytes)
          runtimeError('RUNTIME_ARCHIVE_SIZE', 'Decoded archive exceeds its exact inventory size.');
        yield chunk;
      }
    },
    fs.createWriteStream(decoded, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  if (decodedBytes !== expectedBytes)
    runtimeError('RUNTIME_ARCHIVE_SIZE', 'Decoded archive size does not match its inventory.');
  fs.mkdirSync(root, { mode: 0o700 });
  const fd = fs.openSync(decoded, 'r');
  let position = 0;
  try {
    for (const file of component.files) {
      signal?.throwIfAborted();
      const header = Buffer.alloc(512);
      readExact(fd, header, position);
      position += 512;
      const checksum = octal(header.subarray(148, 156));
      const unsigned = Buffer.from(header);
      unsigned.fill(32, 148, 156);
      if (
        unsigned.reduce((sum, value) => sum + value, 0) !== checksum ||
        header.toString('ascii', 257, 263) !== 'ustar\0' ||
        header.toString('ascii', 263, 265) !== '00' ||
        ![0, 48].includes(header[156]!)
      )
        runtimeError(
          'RUNTIME_ARCHIVE_HEADER',
          'Runtime archives require regular-file USTAR entries only.',
        );
      const prefix = field(header, 345, 155),
        name = field(header, 0, 100);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (
        relative !== file.path ||
        octal(header.subarray(100, 108)) !== file.mode ||
        octal(header.subarray(124, 136)) !== file.bytes ||
        field(header, 157, 100) !== ''
      )
        runtimeError(
          'RUNTIME_ARCHIVE_ENTRY',
          'Archive path, mode or size differs from its trusted inventory.',
        );
      const output = cachePath(root, file.path);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      cachePath(root, file.path);
      const out = fs.openSync(output, 'wx', 0o600);
      const hash = createHash('sha256');
      let remaining = file.bytes;
      const buffer = Buffer.alloc(1024 * 1024);
      try {
        while (remaining > 0) {
          signal?.throwIfAborted();
          const chunk = buffer.subarray(0, Math.min(buffer.length, remaining));
          readExact(fd, chunk, position);
          position += chunk.length;
          remaining -= chunk.length;
          hash.update(chunk);
          writeAll(out, chunk);
        }
        fs.fsyncSync(out);
      } finally {
        fs.closeSync(out);
      }
      if (hash.digest('hex') !== file.sha256)
        runtimeError(
          'RUNTIME_ARCHIVE_INTEGRITY',
          'An extracted file does not match its trusted SHA-256.',
        );
      fs.chmodSync(output, file.mode);
      const padding = (512 - (file.bytes % 512)) % 512;
      if (padding) {
        const bytes = Buffer.alloc(padding);
        readExact(fd, bytes, position);
        if (bytes.some((value) => value !== 0))
          runtimeError('RUNTIME_ARCHIVE_PADDING', 'USTAR file padding must be empty.');
        position += padding;
      }
    }
    const end = Buffer.alloc(1024);
    readExact(fd, end, position);
    if (end.some((value) => value !== 0))
      runtimeError(
        'RUNTIME_ARCHIVE_TRAILING',
        'Runtime archive has unexpected entries or trailing content.',
      );
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(decoded);
  }
}
