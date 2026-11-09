import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDatasetAuthor } from '../src/lib/dataset-author.js';
import type { FetchLike } from '../src/lib/http.js';

const fetchImpl = (async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify({ ok: true }),
})) as FetchLike;

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('runDatasetAuthor writes source extract and target context reports', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-author-'));
  const inputPath = path.join(dir, 'source.pdf');
  writeFileSync(inputPath, 'source', 'utf8');

  try {
    const report = await runDatasetAuthor({
      inputPath,
      targetTypes: 'process,flow',
      outDir: path.join(dir, 'out'),
      env: {
        TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL: 'https://unstructured.example',
        TIANGONG_LCA_UNSTRUCTURED_API_KEY: 'key',
      },
      fetchImpl,
      parseImpl: async () => ({ text: 'parsed source' }),
      contractImpl: async (options) => ({
        schema_version: 1,
        status: 'completed',
        generated_at_utc: '2026-06-01T00:00:00.000Z',
        mode: 'context-pack',
        requested_type: String(options.type ?? ''),
        type: String(options.type ?? ''),
        profile: 'ai-import',
        includes: ['schema', 'methodology', 'ruleset'],
        source: 'sdk-runtime-assets',
        manifest: {},
        files: {
          manifest: path.join(String(options.outDir), 'outputs/contract-manifest.json'),
          schema: null,
          methodology: null,
          ruleset: null,
          ai_context_json: null,
          ai_context_markdown: null,
          report: path.join(String(options.outDir), 'outputs/contract-report.json'),
        },
      }),
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.equal(report.status, 'evidence_ready');
    assert.deepEqual(report.target_types, ['process', 'flow']);
    assert.equal(existsSync(report.files.source_extract), true);
    assert.equal(existsSync(report.files.authoring_report), true);
    assert.deepEqual(readJson(report.files.authoring_report), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetAuthor can use default parser and contract implementations', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-author-defaults-'));
  const inputPath = path.join(dir, 'source.pdf');
  writeFileSync(inputPath, 'source', 'utf8');

  try {
    const report = await runDatasetAuthor({
      inputPath,
      targetTypes: ['process'],
      outDir: path.join(dir, 'out'),
      env: {
        TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL: 'https://unstructured.example',
        TIANGONG_LCA_UNSTRUCTURED_API_KEY: 'key',
      },
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ text: 'parsed source' }),
      })) as FetchLike,
    });

    assert.equal(report.status, 'evidence_ready');
    assert.equal(report.context_packs.length, 1);
    assert.equal(existsSync(report.context_packs[0]?.report.files.ai_context_markdown ?? ''), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetAuthor validates required local inputs before parsing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-author-required-'));
  const inputPath = path.join(dir, 'source.xlsx');
  writeFileSync(inputPath, 'source', 'utf8');

  try {
    await assert.rejects(
      () =>
        runDatasetAuthor({
          inputPath,
          targetTypes: 'process',
          outDir: null,
          env: {},
          fetchImpl,
          parseImpl: async () => ({ text: 'unused' }),
        }),
      /Missing required --out-dir/u,
    );

    await assert.rejects(
      () =>
        runDatasetAuthor({
          inputPath,
          targetTypes: '',
          outDir: path.join(dir, 'out'),
          env: {},
          fetchImpl,
          parseImpl: async () => ({ text: 'unused' }),
        }),
      /Missing required --target-types/u,
    );

    await assert.rejects(
      () =>
        runDatasetAuthor({
          inputPath: '',
          targetTypes: 'process',
          outDir: path.join(dir, 'out'),
          env: {},
          fetchImpl,
          parseImpl: async () => ({ text: 'unused' }),
        }),
      /Missing required --input/u,
    );

    await assert.rejects(
      () =>
        runDatasetAuthor({
          inputPath: path.join(dir, 'missing.pdf'),
          targetTypes: 'process',
          outDir: path.join(dir, 'out'),
          env: {},
          fetchImpl,
          parseImpl: async () => ({ text: 'unused' }),
        }),
      /Input file not found/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
