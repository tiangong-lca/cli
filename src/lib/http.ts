import { CliError } from '../shared/errors.js';

type JsonObject = Record<string, unknown>;

export type ResponseLike = {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseResponse(response: ResponseLike, url: string): Promise<unknown> {
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned from ${url}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: rawText,
    });
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(rawText);
    } catch (error) {
      throw new CliError(`Remote response was not valid JSON for ${url}`, {
        code: 'REMOTE_INVALID_JSON',
        exitCode: 1,
        details: String(error),
      });
    }
  }

  return rawText;
}

export function requireRemoteOkPayload(payload: unknown, url: string): unknown {
  if (!isRecord(payload) || payload.ok !== false) {
    return payload;
  }

  const code =
    typeof payload.code === 'string' && payload.code.trim()
      ? payload.code.trim()
      : 'REMOTE_APPLICATION_ERROR';
  const message =
    typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : `Remote application response returned ok:false for ${url}`;

  throw new CliError(message, {
    code,
    exitCode: 1,
    details: payload,
  });
}

export async function postJson(options: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<unknown> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await options.fetchImpl(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal,
  });

  return parseResponse(response, options.url);
}

export async function getJson(options: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<unknown> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await options.fetchImpl(options.url, {
    method: 'GET',
    headers: options.headers,
    signal,
  });

  return parseResponse(response, options.url);
}
