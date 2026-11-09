import path from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  cloneJson,
  isRecord,
  readDatasetRowsInput,
  unwrapDatasetPayload,
  type JsonObject,
} from './dataset-local.js';
import {
  isFixedModelReference,
  runDatasetRemoteVerify,
  type DatasetRemoteVerificationReport,
  type RemoteVerificationCheck,
  type RunDatasetRemoteVerifyOptions,
} from './dataset-remote-verify.js';

export type DatasetRemoteRefreshPatch = {
  row_index: number;
  role: string;
  table: string | null;
  id: string | null;
  from_version: string | null;
  to_version: string;
  path: string;
  status_before: string;
};

export type DatasetRemoteRefreshReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'completed_with_blockers';
  root_policy: NonNullable<RunDatasetRemoteVerifyOptions['rootPolicy']>;
  input_path: string;
  out_path: string;
  out_dir: string;
  counts: {
    rows: number;
    pre_refresh_blockers: number;
    refreshable_references: number;
    patched_references: number;
    post_refresh_blockers: number;
  };
  remaining_blockers: DatasetRemoteVerificationReport['blockers'];
  files: {
    output_rows: string;
    report: string;
    patches: string;
    pre_verification_report: string;
    post_verification_report: string;
  };
};

export type RunDatasetRemoteRefreshOptions = {
  inputPath: string;
  outPath: string;
  outDir: string;
  rawInput?: unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  rootPolicy?: RunDatasetRemoteVerifyOptions['rootPolicy'];
  runDatasetRemoteVerifyImpl?: (
    options: RunDatasetRemoteVerifyOptions,
  ) => Promise<DatasetRemoteVerificationReport>;
};

function requireNonEmpty(value: string, label: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CliError(`Missing required ${label} value.`, {
      code,
      exitCode: 2,
    });
  }
  return normalized;
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

function readJsonl(filePath: string): JsonObject[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function pointerSegments(pointerPath: string): string[] {
  return pointerPath
    .split('/')
    .filter(Boolean)
    .map((segment) => decodePointerSegment(segment));
}

function valueAtPointer(root: unknown, pointerPath: string): unknown {
  let current = root;
  for (const segment of pointerSegments(pointerPath)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function referenceNodeForPatch(
  payload: JsonObject,
  check: RemoteVerificationCheck,
): JsonObject | null {
  if (check.path.endsWith('/@flowUUID')) {
    const parentPath = check.path.slice(0, -'/@flowUUID'.length);
    const parent = valueAtPointer(payload, parentPath);
    return isRecord(parent) ? parent : null;
  }
  const node = valueAtPointer(payload, check.path);
  return isRecord(node) ? node : null;
}

function refreshableCheck(check: RemoteVerificationCheck): boolean {
  return (
    check.role === 'reference' &&
    !isFixedModelReference(check) &&
    Boolean(check.latest_version) &&
    ['missing_version', 'version_missing', 'version_outdated'].includes(check.status)
  );
}

function applyRemoteRefreshPatches(
  rows: JsonObject[],
  checks: RemoteVerificationCheck[],
): { rows: JsonObject[]; patches: DatasetRemoteRefreshPatch[] } {
  const patchedRows = cloneJson(rows);
  const patches: DatasetRemoteRefreshPatch[] = [];

  for (const check of checks.filter(refreshableCheck)) {
    const row = patchedRows[check.row_index];
    if (!row || !check.latest_version) {
      continue;
    }
    const payload = unwrapDatasetPayload(row);
    const node = referenceNodeForPatch(payload, check);
    if (!node) {
      continue;
    }
    const before = typeof node['@version'] === 'string' ? node['@version'] : null;
    if (before === check.latest_version) {
      continue;
    }
    node['@version'] = check.latest_version;
    patches.push({
      row_index: check.row_index,
      role: check.role,
      table: check.table,
      id: check.id,
      from_version: before,
      to_version: check.latest_version,
      path: check.path,
      status_before: check.status,
    });
  }

  return { rows: patchedRows, patches };
}

function buildFiles(outPath: string, outDir: string): DatasetRemoteRefreshReport['files'] {
  const resolved = path.resolve(outDir);
  return {
    output_rows: path.resolve(outPath),
    report: path.join(resolved, 'outputs', 'remote-refresh-report.json'),
    patches: path.join(resolved, 'outputs', 'remote-refresh-patches.jsonl'),
    pre_verification_report: path.join(
      resolved,
      'pre-refresh-verify',
      'outputs',
      'remote-verification-report.json',
    ),
    post_verification_report: path.join(
      resolved,
      'post-refresh-verify',
      'outputs',
      'remote-verification-report.json',
    ),
  };
}

export async function runDatasetRemoteRefresh(
  options: RunDatasetRemoteRefreshOptions,
): Promise<DatasetRemoteRefreshReport> {
  const inputPath = path.resolve(
    requireNonEmpty(options.inputPath, '--input', 'DATASET_REMOTE_REFRESH_INPUT_REQUIRED'),
  );
  const outPath = path.resolve(
    requireNonEmpty(options.outPath, '--out', 'DATASET_REMOTE_REFRESH_OUT_REQUIRED'),
  );
  const outDir = path.resolve(
    requireNonEmpty(options.outDir, '--out-dir', 'DATASET_REMOTE_REFRESH_OUT_DIR_REQUIRED'),
  );
  const runVerify = options.runDatasetRemoteVerifyImpl ?? runDatasetRemoteVerify;
  const rows = readDatasetRowsInput(inputPath, options.rawInput);
  const files = buildFiles(outPath, outDir);

  const preReport = await runVerify({
    inputPath,
    outDir: path.join(outDir, 'pre-refresh-verify'),
    rawInput: rows,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
    rootPolicy: options.rootPolicy,
  });
  const checks = readJsonl(
    path.join(outDir, 'pre-refresh-verify', 'outputs', 'remote-verification.jsonl'),
  ) as RemoteVerificationCheck[];
  const { rows: patchedRows, patches } = applyRemoteRefreshPatches(rows, checks);
  writeJsonLinesArtifact(outPath, patchedRows);
  writeJsonLinesArtifact(files.patches, patches);

  const postReport = await runVerify({
    inputPath: outPath,
    outDir: path.join(outDir, 'post-refresh-verify'),
    rawInput: patchedRows,
    env: options.env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
    rootPolicy: options.rootPolicy,
  });

  const report: DatasetRemoteRefreshReport = {
    schema_version: 1,
    generated_at_utc: nowIso(options.now),
    status: postReport.blockers.length > 0 ? 'completed_with_blockers' : 'completed',
    root_policy: options.rootPolicy ?? 'existing',
    input_path: inputPath,
    out_path: outPath,
    out_dir: outDir,
    counts: {
      rows: rows.length,
      pre_refresh_blockers: preReport.blockers.length,
      refreshable_references: checks.filter(refreshableCheck).length,
      patched_references: patches.length,
      post_refresh_blockers: postReport.blockers.length,
    },
    remaining_blockers: postReport.blockers,
    files,
  };
  writeJsonArtifact(files.report, report);

  return report;
}

export const __testInternals = {
  applyRemoteRefreshPatches,
  pointerSegments,
  refreshableCheck,
  valueAtPointer,
};
