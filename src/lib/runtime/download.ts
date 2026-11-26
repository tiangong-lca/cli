import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { FetchLike } from '../transport/http.js';
import { runtimeError } from './files.js';
import { distributionUrl } from './manifest-values.js';
import { writeAll } from './storage.js';
import type { RuntimeComponent } from './manifest-types.js';

class RetryableDownload extends Error {}
export type DownloadOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};
async function attempt(
  archive: Pick<RuntimeComponent['archive'], 'url' | 'bytes' | 'sha256'>,
  file: string,
  options: DownloadOptions,
): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let url = distributionUrl(archive.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  let redirects = 0;
  while (true) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new RetryableDownload('Runtime download connection failed.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects++ >= 5)
        runtimeError(
          'RUNTIME_DOWNLOAD_REDIRECT',
          'Runtime download exceeded its redirect contract.',
        );
      url = distributionUrl(new URL(location, url).href, true);
      continue;
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new RetryableDownload('Runtime release source is temporarily unavailable.');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      runtimeError(
        'RUNTIME_DOWNLOAD_HTTP',
        'Runtime release source did not return a complete artifact.',
      );
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) !== archive.bytes)) {
      await response.body?.cancel();
      runtimeError(
        'RUNTIME_DOWNLOAD_SIZE',
        'Runtime archive Content-Length does not match its manifest.',
      );
    }
    if (!response.body)
      runtimeError(
        'RUNTIME_DOWNLOAD_BODY',
        'Runtime release source returned no bounded byte stream.',
      );
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let bytes = 0;
    let fd: number | undefined;
    let complete = false;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      while (true) {
        signal.throwIfAborted();
        let result;
        try {
          result = await reader.read();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          throw new RetryableDownload('Runtime download stream was interrupted.');
        }
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > archive.bytes)
          runtimeError('RUNTIME_DOWNLOAD_SIZE', 'Runtime archive exceeds its declared byte count.');
        hash.update(result.value);
        writeAll(fd, result.value);
      }
      if (bytes !== archive.bytes || hash.digest('hex') !== archive.sha256)
        runtimeError(
          'RUNTIME_DOWNLOAD_INTEGRITY',
          'Runtime archive bytes or digest do not match the trusted manifest.',
        );
      fs.fsyncSync(fd);
      complete = true;
      return;
    } finally {
      if (fd !== undefined) {
        const own = fs.fstatSync(fd, { bigint: true });
        fs.closeSync(fd);
        if (!complete && fs.existsSync(file)) {
          const current = fs.lstatSync(file, { bigint: true });
          if (current.dev === own.dev && current.ino === own.ino) fs.unlinkSync(file);
        }
      }
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
export async function downloadRuntimeArchive(
  archive: Pick<RuntimeComponent['archive'], 'url' | 'bytes' | 'sha256'>,
  file: string,
  options: DownloadOptions = {},
): Promise<void> {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 120_000)
  )
    runtimeError(
      'RUNTIME_DOWNLOAD_TIMEOUT',
      'Runtime download timeout must be between 1 and 120000 ms.',
    );
  for (let index = 0; index < 2; index++) {
    try {
      await attempt(archive, file, options);
      return;
    } catch (error) {
      if (!(error instanceof RetryableDownload) || index === 1 || options.signal?.aborted)
        throw error;
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100);
    }
  }
}
