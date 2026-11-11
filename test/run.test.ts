import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDistModule } from './helpers/load-dist-module.js';
import {
  buildResumeMetadata,
  buildRunId,
  buildRunManifest,
  buildUtcTimestamp,
  ensureRunLayout,
  readLatestRunId,
  resolveRunLayout,
  sanitizeRunToken,
  writeLatestRunId,
} from '../src/lib/platform/run.js';

async function loadDistRunModule(): Promise<typeof import('../src/lib/platform/run.js')> {
  return loadDistModule('src/lib/platform/run.js');
}

test('sanitizeRunToken normalizes user input and preserves fallback behavior', () => {
  assert.equal(sanitizeRunToken('Flow Search / CN'), 'flow_search_cn');
  assert.equal(sanitizeRunToken('___', 'fallback'), 'fallback');
});

test('buildUtcTimestamp and buildRunId return stable UTC-oriented identifiers', () => {
  const now = new Date('2026-03-28T08:30:45.123Z');
  const runId = buildRunId({
    namespace: 'process',
    subject: 'flow CN',
    operation: 'auto build',
    now,
    suffix: 'custom-id',
  });

  assert.equal(buildUtcTimestamp(now), '20260328T083045Z');
  assert.equal(runId, 'process_flow_cn_auto_build_20260328T083045Z_custom_id');
});

test('resolveRunLayout and ensureRunLayout create the expected directory tree', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-run-layout-'));

  try {
    const layout = ensureRunLayout(resolveRunLayout(dir, 'process', 'run-001'));

    assert.equal(layout.collectionDir, path.join(dir, 'process'));
    assert.equal(layout.runRoot, path.join(dir, 'process', 'run-001'));
    assert.equal(layout.latestRunIdPath, path.join(dir, 'process', '.latest_run_id'));
    assert.equal(existsSync(layout.cacheDir), true);
    assert.equal(existsSync(layout.inputsDir), true);
    assert.equal(existsSync(layout.outputsDir), true);
    assert.equal(existsSync(layout.reportsDir), true);
    assert.equal(existsSync(layout.logsDir), true);
    assert.equal(existsSync(layout.manifestsDir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLatestRunId and readLatestRunId store and retrieve the latest run marker', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-run-latest-'));

  try {
    const layout = resolveRunLayout(dir, 'process', 'run-001');

    assert.equal(readLatestRunId(layout.collectionDir), null);
    writeLatestRunId(layout);
    assert.equal(readLatestRunId(layout.collectionDir), 'run-001');
    assert.equal(readFileSync(layout.latestRunIdPath, 'utf8'), 'run-001\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run helpers apply fallback defaults for ids, latest markers, and metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-run-defaults-'));
  const now = new Date('2026-03-28T08:31:00.000Z');

  try {
    const layout = ensureRunLayout(resolveRunLayout(dir, 'Process Search', 'run-defaults'));
    const runId = buildRunId({
      namespace: 'Process Search',
      now,
    });

    assert.match(runId, /^process_search_item_run_20260328T083100Z_[a-z0-9]{8}$/u);

    writeFileSync(layout.latestRunIdPath, '\n', 'utf8');
    assert.equal(readLatestRunId(layout.collectionDir), null);

    const manifest = buildRunManifest({
      layout,
      command: ['tiangong-lca', 'process', 'auto-build'],
    });
    assert.equal(manifest.cwd, process.cwd());
    assert.equal(new Date(manifest.createdAt).toISOString(), manifest.createdAt);

    const resumeMetadata = buildResumeMetadata({
      runId: 'run-defaults',
      resumedFrom: 'step-01',
    });
    assert.deepEqual(
      {
        runId: resumeMetadata.runId,
        resumedFrom: resumeMetadata.resumedFrom,
        checkpoint: resumeMetadata.checkpoint,
        attempt: resumeMetadata.attempt,
      },
      {
        runId: 'run-defaults',
        resumedFrom: 'step-01',
        checkpoint: null,
        attempt: 1,
      },
    );
    assert.equal(new Date(resumeMetadata.resumedAt).toISOString(), resumeMetadata.resumedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRunManifest and buildResumeMetadata emit deterministic metadata payloads', () => {
  const artifactsRoot = path.join(path.sep, 'tmp', 'artifacts');
  const workspaceCwd = path.join(path.sep, 'tmp', 'workspace');
  const layout = resolveRunLayout(artifactsRoot, 'flow', 'run-abc');
  const createdAt = new Date('2026-03-28T08:40:00.000Z');
  const resumedAt = new Date('2026-03-28T08:50:00.000Z');

  assert.deepEqual(
    buildRunManifest({
      layout,
      command: ['tiangong-lca', 'flow', 'get'],
      cwd: workspaceCwd,
      createdAt,
    }),
    {
      schemaVersion: 1,
      namespace: 'flow',
      runId: 'run-abc',
      command: ['tiangong-lca', 'flow', 'get'],
      cwd: workspaceCwd,
      createdAt: '2026-03-28T08:40:00.000Z',
      layout: {
        artifactsRoot,
        collectionDir: path.join(artifactsRoot, 'flow'),
        runRoot: path.join(artifactsRoot, 'flow', 'run-abc'),
        cacheDir: path.join(artifactsRoot, 'flow', 'run-abc', 'cache'),
        inputsDir: path.join(artifactsRoot, 'flow', 'run-abc', 'inputs'),
        outputsDir: path.join(artifactsRoot, 'flow', 'run-abc', 'outputs'),
        reportsDir: path.join(artifactsRoot, 'flow', 'run-abc', 'reports'),
        logsDir: path.join(artifactsRoot, 'flow', 'run-abc', 'logs'),
        manifestsDir: path.join(artifactsRoot, 'flow', 'run-abc', 'manifests'),
        latestRunIdPath: path.join(artifactsRoot, 'flow', '.latest_run_id'),
      },
    },
  );

  assert.deepEqual(
    buildResumeMetadata({
      runId: 'run-abc',
      resumedFrom: 'step-04',
      checkpoint: 'matches',
      attempt: 2,
      resumedAt,
    }),
    {
      runId: 'run-abc',
      resumedFrom: 'step-04',
      checkpoint: 'matches',
      attempt: 2,
      resumedAt: '2026-03-28T08:50:00.000Z',
    },
  );
});

test('run helpers behave the same from the built dist module', async () => {
  const run = await loadDistRunModule();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-run-dist-'));
  const now = new Date('2026-03-28T09:00:00.000Z');

  try {
    assert.equal(run.sanitizeRunToken('Flow Search / CN'), 'flow_search_cn');
    assert.equal(run.buildUtcTimestamp(now), '20260328T090000Z');

    const runId = run.buildRunId({
      namespace: 'Flow Search',
      subject: 'Battery Pack',
      operation: 'Build',
      now,
      suffix: 'custom-id',
    });
    assert.equal(runId, 'flow_search_battery_pack_build_20260328T090000Z_custom_id');

    const layout = run.ensureRunLayout(run.resolveRunLayout(dir, 'Flow Search', 'run-dist'));
    assert.equal(existsSync(layout.cacheDir), true);

    run.writeLatestRunId(layout, 'run-dist-2');
    assert.equal(run.readLatestRunId(layout.collectionDir), 'run-dist-2');

    const manifest = run.buildRunManifest({
      layout,
      command: ['tiangong-lca', 'flow', 'search'],
      cwd: '/tmp/workspace',
      createdAt: now,
    });
    assert.equal(manifest.cwd, '/tmp/workspace');
    assert.equal(manifest.createdAt, now.toISOString());

    const resumeMetadata = run.buildResumeMetadata({
      runId: 'run-dist',
      resumedFrom: 'step-02',
      checkpoint: 'checkpoint-a',
      attempt: 3,
      resumedAt: now,
    });
    assert.deepEqual(resumeMetadata, {
      runId: 'run-dist',
      resumedFrom: 'step-02',
      checkpoint: 'checkpoint-a',
      attempt: 3,
      resumedAt: now.toISOString(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
