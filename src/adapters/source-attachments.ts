import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  object,
  requireContent,
  text,
  isObject,
  type JsonObject,
} from '../application/dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';
import { runDatasetSourceUploadAttachments } from '../lib/dataset-source-upload-attachments.js';
import type { FetchLike } from '../lib/http.js';
import { createSupabaseDataClient, requireSupabaseRestRuntime } from '../lib/supabase-client.js';
import { createSupabaseDataRuntime } from '../lib/supabase-session.js';

export async function uploadSourceAttachments(
  request: JsonObject,
  inputPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  const content = requireContent('source', request.content);
  const bucket = text(request.bucket, 'bucket');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u.test(bucket))
    throw new CommandInputError(
      'BUCKET_INVALID',
      'bucket must be a simple storage bucket identifier.',
    );
  if (!Array.isArray(request.attachments) || !request.attachments.length)
    throw new CommandInputError(
      'ATTACHMENTS_REQUIRED',
      'attachments must explicitly select local files with name, path, size and sha256.',
    );
  const directory = mkdtempSync(path.join(os.tmpdir(), 'source-attachments-'));
  const staged = path.join(directory, 'files');
  mkdirSync(staged, { mode: 0o700 });
  const selected = new Map<string, string>();
  try {
    for (const entry of request.attachments) {
      const attachment = object(entry, 'attachment');
      const name = text(attachment.name, 'attachment.name');
      const source = text(attachment.path, 'attachment.path');
      if (name !== path.basename(name) || ['.', '..'].includes(name) || selected.has(name))
        throw new CommandInputError(
          'ATTACHMENT_NAME_INVALID',
          'Attachment names must be distinct file basenames.',
        );
      if (inputPath === '-' && !path.isAbsolute(source))
        throw new CommandInputError(
          'PATH_ABSOLUTE_REQUIRED',
          'Stdin file references must be absolute.',
        );
      const file = path.resolve(path.dirname(path.resolve(inputPath)), source);
      const bytes = readFileSync(file);
      if (
        attachment.size !== bytes.length ||
        attachment.sha256 !== createHash('sha256').update(bytes).digest('hex')
      )
        throw new CommandInputError(
          'ATTACHMENT_CHANGED',
          'Attachment size or SHA-256 differs from the explicit request.',
        );
      writeFileSync(path.join(staged, name), bytes, { mode: 0o600, flag: 'wx' });
      selected.set(name, file);
    }
    const input = path.join(directory, 'source.json');
    writeFileSync(input, JSON.stringify(content), { mode: 0o600 });
    const options = {
      inputPath: input,
      externalDocsDir: staged,
      outDir: directory,
      bucket,
      env,
      fetchImpl: (url: string, init?: RequestInit) =>
        fetchImpl(
          url,
          init?.method === 'POST' &&
            url.includes('/storage/v1/object/') &&
            !url.includes('/object/sign/')
            ? {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init.headers).entries()),
                  'x-upsert': 'false',
                },
              }
            : init,
        ),
      verify: true,
    };
    const preview = await runDatasetSourceUploadAttachments({ ...options, commit: false });
    if (preview.summary.unresolved_refs || preview.files.length !== selected.size)
      throw new CommandInputError(
        'ATTACHMENT_SCOPE_MISMATCH',
        'Every selected file must resolve to an explicit Source digital-file reference, with no unresolved local references.',
      );
    const dryRun = request.dryRun === true;
    const report = dryRun
      ? preview
      : await runDatasetSourceUploadAttachments({ ...options, commit: true });
    if (!dryRun) {
      const runtime = createSupabaseDataRuntime({
        runtime: requireSupabaseRestRuntime(env),
        fetchImpl,
        timeoutMs: 10_000,
      });
      const { client } = createSupabaseDataClient(runtime, fetchImpl, 10_000);
      for (const file of report.files.filter((file) => file.status === 'verified')) {
        try {
          const expected = readFileSync(path.join(staged, path.basename(file.source_path)));
          const { data, error } = await client.storage.from(bucket).download(file.bucket_key);
          if (
            error ||
            !data ||
            data.size !== expected.length ||
            createHash('sha256')
              .update(new Uint8Array(await data.arrayBuffer()))
              .digest('hex') !== createHash('sha256').update(expected).digest('hex')
          )
            throw new Error('readback mismatch');
        } catch {
          file.status = 'failed';
          file.error = 'Uploaded object content was not independently verified.';
        }
      }
    }
    const candidate = structuredClone(content);
    const root = object(candidate.sourceDataSet, 'sourceDataSet');
    const info = object(
      object(root.sourceInformation, 'sourceInformation').dataSetInformation,
      'dataSetInformation',
    );
    const references = report.references.map((reference) => ({
      ...reference,
      resolved_file: reference.resolved_file,
      uploadSucceeded:
        !dryRun &&
        report.files.some(
          (file) =>
            file.bucket_key === reference.bucket_key &&
            ['uploaded', 'verified'].includes(file.status),
        ),
    }));
    const rewrite = (entry: unknown): unknown => {
      const uri = typeof entry === 'string' ? entry : isObject(entry) ? entry['@uri'] : null;
      const reference = references.find(
        (reference) => reference.original_uri === uri && reference.uploadSucceeded,
      );
      if (!reference) return entry;
      return typeof entry === 'string'
        ? reference.rewritten_uri
        : { ...object(entry, 'digital file'), '@uri': reference.rewritten_uri };
    };
    const files = info.referenceToDigitalFile;
    info.referenceToDigitalFile = Array.isArray(files) ? files.map(rewrite) : rewrite(files);
    return {
      status: dryRun
        ? 'preview_completed'
        : report.files.some((file) => file.status === 'failed')
          ? 'partial'
          : 'completed',
      content: candidate,
      references,
      files: report.files.map((file) => ({
        ...file,
        source_path: selected.get(path.basename(file.source_path)),
        error: file.error
          ? 'Attachment upload or verification failed; inspect the original storage object before retrying.'
          : null,
      })),
      summary: {
        ...report.summary,
        files_uploaded: report.files.filter((file) => file.status === 'verified').length,
        files_failed: report.files.filter((file) => file.status === 'failed').length,
      },
      recovery: { automaticRetry: false, uploadedObjectsRetained: true },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
