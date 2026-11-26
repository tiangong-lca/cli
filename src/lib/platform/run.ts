import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type RunLayout = {
  namespace: string;
  runId: string;
  artifactsRoot: string;
  collectionDir: string;
  runRoot: string;
  cacheDir: string;
  inputsDir: string;
  outputsDir: string;
  reportsDir: string;
  logsDir: string;
  manifestsDir: string;
  latestRunIdPath: string;
};

export type RunManifest = {
  schemaVersion: 1;
  namespace: string;
  runId: string;
  command: string[];
  cwd: string;
  createdAt: string;
  layout: Omit<RunLayout, 'namespace' | 'runId'>;
};

export type ResumeMetadata = {
  runId: string;
  resumedFrom: string;
  checkpoint: string | null;
  attempt: number;
  resumedAt: string;
};

type BuildRunIdOptions = {
  namespace: string;
  subject?: string;
  operation?: string;
  now?: Date;
  suffix?: string;
};

type BuildRunManifestOptions = {
  layout: RunLayout;
  command: string[];
  cwd?: string;
  createdAt?: Date;
};

type BuildResumeMetadataOptions = {
  runId: string;
  resumedFrom: string;
  checkpoint?: string | null;
  attempt?: number;
  resumedAt?: Date;
};

export function sanitizeRunToken(value: string, fallback = 'item'): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');

  return normalized || fallback;
}

export function buildUtcTimestamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

export function buildRunId(options: BuildRunIdOptions): string {
  const tokens = [
    sanitizeRunToken(options.namespace, 'run'),
    sanitizeRunToken(options.subject ?? '', 'item'),
    sanitizeRunToken(options.operation ?? '', 'run'),
    buildUtcTimestamp(options.now),
    sanitizeRunToken(options.suffix ?? randomUUID().slice(0, 8), 'id'),
  ];

  return tokens.join('_');
}

export function resolveRunLayout(
  artifactsRoot: string,
  namespace: string,
  runId: string,
): RunLayout {
  const normalizedNamespace = sanitizeRunToken(namespace, 'run');
  const collectionDir = path.join(artifactsRoot, normalizedNamespace);
  const runRoot = path.join(collectionDir, runId);

  return {
    namespace: normalizedNamespace,
    runId,
    artifactsRoot,
    collectionDir,
    runRoot,
    cacheDir: path.join(runRoot, 'cache'),
    inputsDir: path.join(runRoot, 'inputs'),
    outputsDir: path.join(runRoot, 'outputs'),
    reportsDir: path.join(runRoot, 'reports'),
    logsDir: path.join(runRoot, 'logs'),
    manifestsDir: path.join(runRoot, 'manifests'),
    latestRunIdPath: path.join(collectionDir, '.latest_run_id'),
  };
}

export function ensureRunLayout(layout: RunLayout): RunLayout {
  [
    layout.collectionDir,
    layout.runRoot,
    layout.cacheDir,
    layout.inputsDir,
    layout.outputsDir,
    layout.reportsDir,
    layout.logsDir,
    layout.manifestsDir,
  ].forEach((dirPath) => {
    mkdirSync(dirPath, { recursive: true });
  });

  return layout;
}

export function writeLatestRunId(layout: RunLayout, runId: string = layout.runId): string {
  mkdirSync(layout.collectionDir, { recursive: true });
  writeFileSync(layout.latestRunIdPath, `${runId}\n`, 'utf8');
  return layout.latestRunIdPath;
}

export function readLatestRunId(collectionDir: string): string | null {
  const latestRunIdPath = path.join(collectionDir, '.latest_run_id');
  if (!existsSync(latestRunIdPath)) {
    return null;
  }

  const value = readFileSync(latestRunIdPath, 'utf8').trim();
  return value || null;
}

export function buildRunManifest(options: BuildRunManifestOptions): RunManifest {
  const { layout } = options;

  return {
    schemaVersion: 1,
    namespace: layout.namespace,
    runId: layout.runId,
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    layout: {
      artifactsRoot: layout.artifactsRoot,
      collectionDir: layout.collectionDir,
      runRoot: layout.runRoot,
      cacheDir: layout.cacheDir,
      inputsDir: layout.inputsDir,
      outputsDir: layout.outputsDir,
      reportsDir: layout.reportsDir,
      logsDir: layout.logsDir,
      manifestsDir: layout.manifestsDir,
      latestRunIdPath: layout.latestRunIdPath,
    },
  };
}

export function buildResumeMetadata(options: BuildResumeMetadataOptions): ResumeMetadata {
  return {
    runId: options.runId,
    resumedFrom: options.resumedFrom,
    checkpoint: options.checkpoint ?? null,
    attempt: options.attempt ?? 1,
    resumedAt: (options.resumedAt ?? new Date()).toISOString(),
  };
}
