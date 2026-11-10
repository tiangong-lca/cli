import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from '../shared/errors.js';
import type { FetchLike } from './http.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  requireSupabaseRestRuntime,
} from './supabase-client.js';
import { resolveSupabaseUserSession } from './supabase-session.js';

type JsonObject = Record<string, unknown>;

const DEFAULT_BUCKET = 'external_docs';
const DEFAULT_TIMEOUT_MS = 30_000;

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export type DigitalFileRefKind = 'local' | 'remote' | 'empty';

export type DigitalFileReference = {
  source_id: string | null;
  source_version: string | null;
  original_uri: string;
  kind: DigitalFileRefKind;
  resolved_file: string | null;
  bucket_key: string | null;
  rewritten_uri: string | null;
  status: 'rewritten' | 'left_as_is' | 'unresolved';
};

export type AttachmentFileReport = {
  bucket_key: string;
  source_path: string;
  size_bytes: number;
  content_type: string;
  referenced_by: string[];
  status: 'planned' | 'uploaded' | 'verified' | 'failed';
  error: string | null;
};

export type DatasetSourceUploadAttachmentsReport = {
  schema_version: 1;
  generated_at_utc: string;
  status:
    | 'planned_attachment_upload'
    | 'uploaded_attachments'
    | 'completed_with_failures'
    | 'completed_with_unresolved_refs';
  mode: 'dry-run' | 'commit';
  bucket: string;
  external_docs_dir: string;
  summary: {
    sources_scanned: number;
    local_refs: number;
    remote_refs: number;
    unresolved_refs: number;
    files_planned: number;
    files_uploaded: number;
    files_failed: number;
    sources_rewritten: number;
  };
  files: AttachmentFileReport[];
  references: DigitalFileReference[];
  artifacts: {
    report: string;
    rewritten_sources: string;
  };
};

export type RunDatasetSourceUploadAttachmentsOptions = {
  inputPath: string;
  externalDocsDir: string;
  outDir?: string | null;
  bucket?: string | null;
  commit?: boolean;
  verify?: boolean;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  now?: Date;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function caughtErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFileBytes(filePath: string): Uint8Array<ArrayBuffer> {
  // Copy into a fresh ArrayBuffer-backed view so the bytes are a valid BlobPart
  // (readFileSync's Buffer is typed over ArrayBufferLike, which Blob rejects).
  return new Uint8Array(readFileSync(filePath));
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError('--timeout-ms must be a positive integer.', {
      code: 'DATASET_SOURCE_UPLOAD_TIMEOUT_INVALID',
      exitCode: 2,
      details: value,
    });
  }
  return value;
}

export function classifyDigitalFileUri(uri: unknown): DigitalFileRefKind {
  const trimmed = typeof uri === 'string' ? uri.trim() : '';
  if (!trimmed) {
    return 'empty';
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    return 'remote';
  }
  return 'local';
}

export function digitalFileBasename(uri: string): string {
  const normalized = uri.trim().replace(/\\/gu, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function mimeTypeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function buildExternalDocsIndex(externalDocsDir: string): Map<string, string> {
  let entries: string[];
  try {
    entries = readdirSync(externalDocsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    throw new CliError(`Cannot read external docs directory: ${externalDocsDir}`, {
      code: 'DATASET_SOURCE_UPLOAD_EXTERNAL_DOCS_DIR_UNREADABLE',
      exitCode: 2,
      details: caughtErrorMessage(error),
    });
  }

  const index = new Map<string, string>();
  for (const name of entries) {
    index.set(name.toLowerCase(), name);
  }
  return index;
}

function digitalFileNode(row: JsonObject): JsonObject | null {
  const root = isRecord(row.sourceDataSet) ? (row.sourceDataSet as JsonObject) : row;
  const sourceInformation = isRecord(root.sourceInformation)
    ? (root.sourceInformation as JsonObject)
    : null;
  if (!sourceInformation) {
    return null;
  }
  const dataSetInformation = isRecord(sourceInformation.dataSetInformation)
    ? (sourceInformation.dataSetInformation as JsonObject)
    : null;
  return dataSetInformation;
}

function sourceIdentity(row: JsonObject): { id: string | null; version: string | null } {
  const dataSetInformation = digitalFileNode(row);
  const id = dataSetInformation ? trimToken(dataSetInformation['common:UUID']) : null;

  const root = isRecord(row.sourceDataSet) ? (row.sourceDataSet as JsonObject) : row;
  const administrative = isRecord(root.administrativeInformation)
    ? (root.administrativeInformation as JsonObject)
    : null;
  const publication =
    administrative && isRecord(administrative.publicationAndOwnership)
      ? (administrative.publicationAndOwnership as JsonObject)
      : null;
  const version = publication ? trimToken(publication['common:dataSetVersion']) : null;

  return { id, version };
}

function entryUri(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (isRecord(entry)) {
    const uri = entry['@uri'];
    return typeof uri === 'string' ? uri : '';
  }
  return '';
}

function withRewrittenUri(entry: unknown, rewrittenUri: string): unknown {
  if (typeof entry === 'string') {
    return rewrittenUri;
  }
  if (isRecord(entry)) {
    return { ...entry, '@uri': rewrittenUri };
  }
  return entry;
}

export type ResolvedReference = {
  reference: DigitalFileReference;
  entryIndex: number;
};

function resolveReferences(
  identity: { id: string | null; version: string | null },
  entries: unknown[],
  fileIndex: Map<string, string>,
  bucket: string,
): ResolvedReference[] {
  return entries.map((entry, entryIndex) => {
    const original = entryUri(entry);
    const kind = classifyDigitalFileUri(original);

    if (kind !== 'local') {
      return {
        entryIndex,
        reference: {
          source_id: identity.id,
          source_version: identity.version,
          original_uri: original,
          kind,
          resolved_file: null,
          bucket_key: null,
          rewritten_uri: original,
          status: 'left_as_is',
        },
      };
    }

    const basename = digitalFileBasename(original);
    const resolved = fileIndex.get(basename.toLowerCase()) ?? null;
    if (!resolved) {
      return {
        entryIndex,
        reference: {
          source_id: identity.id,
          source_version: identity.version,
          original_uri: original,
          kind,
          resolved_file: null,
          bucket_key: null,
          rewritten_uri: original,
          status: 'unresolved',
        },
      };
    }

    return {
      entryIndex,
      reference: {
        source_id: identity.id,
        source_version: identity.version,
        original_uri: original,
        kind,
        resolved_file: resolved,
        bucket_key: resolved,
        rewritten_uri: `../${bucket}/${resolved}`,
        status: 'rewritten',
      },
    };
  });
}

export function digitalFileEntries(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function rewriteDigitalFileValue(value: unknown, resolved: ResolvedReference[]): unknown {
  const entries = digitalFileEntries(value);
  const rewritten = entries.map((entry, entryIndex) => {
    const match = resolved.find((item) => item.entryIndex === entryIndex);
    if (match && match.reference.status === 'rewritten' && match.reference.rewritten_uri) {
      return withRewrittenUri(entry, match.reference.rewritten_uri);
    }
    return entry;
  });

  return Array.isArray(value) ? rewritten : (rewritten[0] ?? value);
}

function loadSourceRows(inputPath: string): { path: string; row: JsonObject }[] {
  const resolved = path.resolve(inputPath);
  let stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new CliError(`Cannot read --input path: ${inputPath}`, {
      code: 'DATASET_SOURCE_UPLOAD_INPUT_UNREADABLE',
      exitCode: 2,
      details: caughtErrorMessage(error),
    });
  }

  const files: string[] = [];
  if (stats.isDirectory()) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          files.push(entryPath);
        }
      }
    };
    walk(resolved);
  } else {
    files.push(resolved);
  }

  const rows: { path: string; row: JsonObject }[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.toLowerCase().endsWith('.jsonl')) {
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        rows.push({ path: file, row: parseRowObject(trimmed, file) });
      }
      continue;
    }

    const parsed = parseJson(text, file);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isRecord(item)) {
          rows.push({ path: file, row: item });
        }
      }
    } else if (isRecord(parsed)) {
      rows.push({ path: file, row: parsed });
    } else {
      throw new CliError(`Source row is not a JSON object: ${file}`, {
        code: 'DATASET_SOURCE_UPLOAD_INPUT_NOT_OBJECT',
        exitCode: 2,
      });
    }
  }

  return rows;
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Cannot parse source JSON: ${file}`, {
      code: 'DATASET_SOURCE_UPLOAD_INPUT_INVALID_JSON',
      exitCode: 2,
      details: caughtErrorMessage(error),
    });
  }
}

function parseRowObject(text: string, file: string): JsonObject {
  const parsed = parseJson(text, file);
  if (!isRecord(parsed)) {
    throw new CliError(`Source row is not a JSON object: ${file}`, {
      code: 'DATASET_SOURCE_UPLOAD_INPUT_NOT_OBJECT',
      exitCode: 2,
    });
  }
  return parsed;
}

async function uploadObject(options: {
  storageBaseUrl: string;
  bucket: string;
  key: string;
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  publishableKey: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<void> {
  const encodedKey = options.key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `${options.storageBaseUrl}/object/${options.bucket}/${encodedKey}`;
  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      ...buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
      'content-type': options.contentType,
      'x-upsert': 'true',
    },
    body: new Blob([options.body], { type: options.contentType }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new CliError(`HTTP ${response.status} returned uploading ${options.key}`, {
      code: 'DATASET_SOURCE_UPLOAD_OBJECT_FAILED',
      exitCode: 1,
      details: { url, body: detail },
    });
  }
}

async function verifyObject(options: {
  storageBaseUrl: string;
  bucket: string;
  key: string;
  publishableKey: string;
  accessToken: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<void> {
  const encodedKey = options.key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `${options.storageBaseUrl}/object/sign/${options.bucket}/${encodedKey}`;
  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      ...buildSupabaseAuthHeaders(options.publishableKey, options.accessToken),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 60 }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new CliError(`HTTP ${response.status} returned verifying ${options.key}`, {
      code: 'DATASET_SOURCE_UPLOAD_VERIFY_FAILED',
      exitCode: 1,
      details: { url, body: detail },
    });
  }
}

export async function runDatasetSourceUploadAttachments(
  options: RunDatasetSourceUploadAttachmentsOptions,
): Promise<DatasetSourceUploadAttachmentsReport> {
  const now = options.now ?? new Date();
  const generatedAtUtc = now.toISOString();
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const commit = Boolean(options.commit);
  const verify = Boolean(options.verify);
  const bucket = trimToken(options.bucket) ?? DEFAULT_BUCKET;
  const outDir = path.resolve(options.outDir ?? 'dataset-source-upload-attachments');
  const externalDocsDir = path.resolve(options.externalDocsDir);

  const fileIndex = buildExternalDocsIndex(externalDocsDir);
  const sourceRows = loadSourceRows(options.inputPath);

  const references: DigitalFileReference[] = [];
  const filesByKey = new Map<
    string,
    { source_path: string; size_bytes: number; content_type: string; referenced_by: Set<string> }
  >();
  const rewrittenRows: JsonObject[] = [];
  let sourcesRewritten = 0;

  for (const { row } of sourceRows) {
    const identity = sourceIdentity(row);
    const node = digitalFileNode(row);
    const rawValue = node ? node.referenceToDigitalFile : undefined;
    const entries = digitalFileEntries(rawValue);

    if (entries.length === 0 || !node) {
      rewrittenRows.push(row);
      continue;
    }

    const resolved = resolveReferences(identity, entries, fileIndex, bucket);
    let rowChanged = false;

    for (const item of resolved) {
      references.push(item.reference);
      if (item.reference.status === 'rewritten' && item.reference.bucket_key) {
        rowChanged = rowChanged || item.reference.rewritten_uri !== item.reference.original_uri;
        const key = item.reference.bucket_key;
        const existing = filesByKey.get(key);
        const sourceLabel = `${identity.id ?? 'unknown'}@${identity.version ?? 'unknown'}`;
        if (existing) {
          existing.referenced_by.add(sourceLabel);
        } else {
          const filePath = path.join(externalDocsDir, item.reference.resolved_file!);
          filesByKey.set(key, {
            source_path: filePath,
            size_bytes: statSync(filePath).size,
            content_type: mimeTypeForFile(item.reference.resolved_file!),
            referenced_by: new Set([sourceLabel]),
          });
        }
      }
    }

    if (rowChanged) {
      sourcesRewritten += 1;
      node.referenceToDigitalFile = rewriteDigitalFileValue(rawValue, resolved);
    }
    rewrittenRows.push(row);
  }

  const runtime = requireSupabaseRestRuntime(options.env);
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
  const storageBaseUrl = `${projectBaseUrl}/storage/v1`;

  const files: AttachmentFileReport[] = [];
  let filesUploaded = 0;
  let filesFailed = 0;

  if (commit && filesByKey.size > 0) {
    const session = await resolveSupabaseUserSession({
      runtime,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      now,
    });

    for (const [key, info] of filesByKey) {
      const base: AttachmentFileReport = {
        bucket_key: key,
        source_path: info.source_path,
        size_bytes: info.size_bytes,
        content_type: info.content_type,
        referenced_by: [...info.referenced_by].sort(),
        status: 'planned',
        error: null,
      };
      try {
        await uploadObject({
          storageBaseUrl,
          bucket,
          key,
          body: readFileBytes(info.source_path),
          contentType: info.content_type,
          publishableKey: runtime.publishableKey,
          accessToken: session.accessToken,
          fetchImpl: options.fetchImpl,
          timeoutMs,
        });
        if (verify) {
          await verifyObject({
            storageBaseUrl,
            bucket,
            key,
            publishableKey: runtime.publishableKey,
            accessToken: session.accessToken,
            fetchImpl: options.fetchImpl,
            timeoutMs,
          });
        }
        filesUploaded += 1;
        files.push({ ...base, status: verify ? 'verified' : 'uploaded' });
      } catch (error) {
        filesFailed += 1;
        files.push({ ...base, status: 'failed', error: caughtErrorMessage(error) });
      }
    }
  } else {
    for (const [key, info] of filesByKey) {
      files.push({
        bucket_key: key,
        source_path: info.source_path,
        size_bytes: info.size_bytes,
        content_type: info.content_type,
        referenced_by: [...info.referenced_by].sort(),
        status: 'planned',
        error: null,
      });
    }
  }

  const localRefs = references.filter((ref) => ref.kind === 'local').length;
  const remoteRefs = references.filter((ref) => ref.kind === 'remote').length;
  const unresolvedRefs = references.filter((ref) => ref.status === 'unresolved').length;

  const artifacts = {
    report: path.join(outDir, 'attachments-report.json'),
    rewritten_sources: path.join(outDir, 'rewritten-sources.jsonl'),
  };

  const status: DatasetSourceUploadAttachmentsReport['status'] = commit
    ? filesFailed > 0
      ? 'completed_with_failures'
      : 'uploaded_attachments'
    : unresolvedRefs > 0
      ? 'completed_with_unresolved_refs'
      : 'planned_attachment_upload';

  const report: DatasetSourceUploadAttachmentsReport = {
    schema_version: 1,
    generated_at_utc: generatedAtUtc,
    status,
    mode: commit ? 'commit' : 'dry-run',
    bucket,
    external_docs_dir: externalDocsDir,
    summary: {
      sources_scanned: sourceRows.length,
      local_refs: localRefs,
      remote_refs: remoteRefs,
      unresolved_refs: unresolvedRefs,
      files_planned: filesByKey.size,
      files_uploaded: filesUploaded,
      files_failed: filesFailed,
      sources_rewritten: sourcesRewritten,
    },
    files,
    references,
    artifacts,
  };

  writeJsonArtifact(artifacts.report, report);
  writeJsonLinesArtifact(artifacts.rewritten_sources, rewrittenRows);

  return report;
}

export const __testInternals = {
  buildExternalDocsIndex,
  caughtErrorMessage,
  classifyDigitalFileUri,
  digitalFileBasename,
  digitalFileEntries,
  digitalFileNode,
  entryUri,
  loadSourceRows,
  mimeTypeForFile,
  normalizeTimeoutMs,
  parseJson,
  parseRowObject,
  resolveReferences,
  rewriteDigitalFileValue,
  sourceIdentity,
  trimToken,
  withRewrittenUri,
};
