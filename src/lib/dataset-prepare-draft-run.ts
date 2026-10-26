import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withBatchRunLock } from '../batch.js';
import path from 'node:path';
import { writeJsonArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import {
  resolveMaintenanceRemoteContext,
  type DatasetMaintenanceRemoteContext,
} from './dataset-maintenance-remote.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import {
  claimPrepareAttempt,
  prepareAttemptPath,
  readPrepareAttempt,
} from './dataset-prepare-draft-attempt.js';
import {
  parsePrepareEnvelope,
  parsePrepareResult,
  parsePrepareReviewPoint,
  prepareFail,
  prepareObject,
  prepareSame,
  prepareSelection,
  prepareUuid,
  prepareVersion,
  PREPARE_TYPES,
  type PrepareEnvelope,
  type PrepareResult,
  type PrepareRow,
  type PrepareSnapshot,
  type PrepareReviewPoint,
  type PrepareTable,
} from './dataset-prepare-draft-contract.js';
import {
  readPrepareCensus,
  readPrepareExact,
  readPrepareReviews,
  requestPrepareBackend,
} from './dataset-prepare-draft-remote.js';

export type RunDatasetPrepareDraftOptions = {
  inputPath?: string;
  type?: string;
  id?: string;
  sourceVersion?: string;
  targetUserId?: string;
  projectRef?: string;
  outDir: string;
  commit?: boolean;
  statusOnly?: boolean;
  selectedVersion?: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
};
export type DatasetPrepareDraftReport = {
  schema_version: 'dataset-prepare-draft-report.v1';
  status:
    | 'review_conflict'
    | 'selected'
    | 'prepared'
    | 'needs_creation'
    | 'conflict'
    | 'unknown'
    | 'changed'
    | 'capability_unavailable';
  mode: 'read_only' | 'commit' | 'status_only';
  save_ready: false;
  reviews: PrepareReviewPoint[];
  review_completeness: unknown;
  request: PrepareEnvelope;
  request_sha256: string;
  attempt_consumed: boolean;
  mutation_dispatches: number;
  drafts?: PrepareRow[];
  completeness?: unknown;
  target: Omit<PrepareRow, 'modelId'> | null;
  receipt?: PrepareResult;
  error?: { code: string; message: string; details?: unknown };
  recovery_error?: { code: string; message: string; details?: unknown };
  files: { request: string; report: string; target: string };
};
function errorEvidence(error: unknown, envelope: PrepareEnvelope) {
  const code = error instanceof CliError ? error.code : 'DATASET_PREPARE_DRAFT_TRANSPORT_UNKNOWN';
  let details: unknown;
  if (
    error instanceof CliError &&
    ['DATASET_DRAFT_CONFLICT', 'DATASET_DRAFT_CENSUS_CHANGED'].includes(code)
  ) {
    const raw = error.details;
    if (prepareObject(raw) && Array.isArray(raw.draftVersions)) {
      const versions = raw.draftVersions.map(prepareVersion);
      if (new Set(versions).size === versions.length) {
        if (code === 'DATASET_DRAFT_CENSUS_CHANGED') details = { draftVersions: versions };
        else if (
          Array.isArray(raw.drafts) &&
          raw.drafts.length === versions.length &&
          raw.drafts.every(
            (row, index) =>
              prepareObject(row) &&
              row.version === versions[index] &&
              prepareObject(row.jsonOrdered),
          )
        )
          details = {
            draftVersions: versions,
            drafts: raw.drafts.map((row) => ({
              version: row.version,
              jsonOrdered: row.jsonOrdered,
            })),
          };
      }
    }
  }
  if (
    error instanceof CliError &&
    code === 'DATASET_REVIEW_IN_PROGRESS' &&
    prepareObject(error.details) &&
    error.details.table === envelope.request.table &&
    error.details.id === envelope.request.id &&
    Array.isArray(error.details.reviews)
  ) {
    const reviews = error.details.reviews.map((point) =>
      parsePrepareReviewPoint(
        point,
        envelope.request.table,
        envelope.request.id,
        envelope.request.expectedActorId,
      ),
    );
    details = { table: envelope.request.table, id: envelope.request.id, reviews };
  }
  return {
    code,
    message:
      'Preparation did not establish an exact committed receipt and current owner target; retain the original request for read-only recovery.',
    ...(details === undefined ? {} : { details }),
  };
}
function persistRequest(file: string, request: PrepareEnvelope): void {
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (prepareObject(error) && error.code === 'EEXIST') {
      if (
        !lstatSync(file).isFile() ||
        !prepareSame(parsePrepareEnvelope(JSON.parse(readFileSync(file, 'utf8'))), request)
      )
        prepareFail(
          'Output directory already owns another preparation request.',
          'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT',
        );
      return;
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function artifact(file: string, value: unknown): void {
  writeJsonArtifact(file, value);
  chmodSync(file, 0o600);
}
function draftSnapshots(rows: PrepareRow[]): PrepareSnapshot[] {
  return rows.map(({ version, jsonOrdered }) => ({ version, jsonOrdered }));
}
function sourceSnapshot(row: PrepareRow): PrepareEnvelope['request']['source'] {
  if (![100, 200].includes(row.stateCode))
    prepareFail(
      'Preparation source is not a public state-100/200 version.',
      'DATASET_SOURCE_NOT_PUBLIC',
    );
  return {
    version: row.version,
    userId: row.userId,
    stateCode: row.stateCode as 100 | 200,
    jsonOrdered: row.jsonOrdered,
  };
}
async function observe(
  context: DatasetMaintenanceRemoteContext,
  table: PrepareTable,
  id: string,
  version: string,
) {
  const census = await readPrepareCensus(context, table, id);
  const source = await readPrepareExact(context, table, id, version);
  if (!source) prepareFail('Exact public source was not found.', 'DATASET_SOURCE_NOT_FOUND');
  return { census, source: sourceSnapshot(source) };
}
type PrepareRecovery = {
  receipt: PrepareResult;
  target: Omit<PrepareRow, 'modelId'> | null;
  status: 'prepared' | 'changed' | 'unknown';
  error?: ReturnType<typeof errorEvidence>;
};
async function recover(
  context: DatasetMaintenanceRemoteContext,
  request: PrepareEnvelope,
): Promise<PrepareRecovery> {
  const raw = await requestPrepareBackend(context, request, true);
  if (!prepareObject(raw) || raw.recorded !== true)
    prepareFail('Invalid preparation lookup response.', 'DATASET_PREPARE_DRAFT_RESPONSE_INVALID');
  // A validated immutable receipt is historical evidence, independent of whether the
  // current target can still be read or admitted by this preparation contract.
  const receipt = parsePrepareResult(raw.result, request);
  try {
    if (!['unchanged', 'changed', 'missing'].includes(String(raw.targetStatus)))
      prepareFail(
        'Invalid preparation lookup target status.',
        'DATASET_PREPARE_DRAFT_RESPONSE_INVALID',
      );
    const current = await readPrepareExact(
      context,
      request.request.table,
      request.request.id,
      receipt.version,
    );
    const target = current
      ? {
          version: current.version,
          userId: current.userId,
          stateCode: current.stateCode,
          jsonOrdered: current.jsonOrdered,
        }
      : null;
    const exact = prepareSame(target, receipt.selectedDraft);
    if (
      !prepareSame(raw.currentDraft, target) ||
      raw.targetStatus !== (exact ? 'unchanged' : target === null ? 'missing' : 'changed')
    )
      prepareFail(
        'Preparation lookup disagrees with independent exact readback.',
        'DATASET_PREPARE_DRAFT_READBACK_MISMATCH',
      );
    return { receipt, target, status: exact ? 'prepared' : 'changed' };
  } catch (error) {
    const evidence = errorEvidence(error, request);
    const scopeChanged = ['LIFECYCLEMODEL_BUNDLE_REQUIRED', 'DATASET_REFERENCE_ONLY'].includes(
      evidence.code,
    );
    return {
      receipt,
      target: null,
      status: scopeChanged ? 'changed' : 'unknown',
      error: scopeChanged
        ? {
            ...evidence,
            message:
              'The original receipt is retained; the current target requires native bundle or reference-only handling and is unavailable for preparation.',
          }
        : evidence,
    };
  }
}
async function runLockedPrepareDraft(
  options: RunDatasetPrepareDraftOptions,
): Promise<DatasetPrepareDraftReport> {
  if (options.commit && options.statusOnly)
    prepareFail('Commit and status-only are mutually exclusive.');
  const mode = options.statusOnly ? 'status_only' : options.commit ? 'commit' : 'read_only';
  if ((options.commit || options.statusOnly) && !options.inputPath)
    prepareFail('Commit/status-only require the original frozen --input request.');
  if (
    options.inputPath &&
    [
      options.type,
      options.id,
      options.sourceVersion,
      options.targetUserId,
      options.projectRef,
    ].some((value) => value !== undefined)
  )
    prepareFail('Frozen --input cannot be mixed with scope flags.');
  const outDir = path.resolve(options.outDir);
  const files = {
    request: path.join(outDir, 'request.json'),
    report: path.join(outDir, 'report.json'),
    target: path.join(outDir, 'target.json'),
  };
  const inputText = options.inputPath ? readFileSync(options.inputPath, 'utf8') : null;
  const assertInputCurrent = () => {
    if (!options.inputPath) return;
    const inputFile = statSync(options.inputPath, { bigint: true });
    if (
      [files.report, files.target].some((file) => {
        if (!existsSync(file)) return false;
        const outputFile = statSync(file, { bigint: true });
        return outputFile.dev === inputFile.dev && outputFile.ino === inputFile.ino;
      })
    )
      prepareFail(
        'Frozen preparation input aliases a generated report or target artifact.',
        'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT',
      );
    if (readFileSync(options.inputPath, 'utf8') !== inputText)
      prepareFail(
        'Frozen preparation input changed during this run.',
        'DATASET_PREPARE_DRAFT_INPUT_CHANGED',
      );
  };
  assertInputCurrent();
  let envelope = inputText === null ? null : parsePrepareEnvelope(JSON.parse(inputText));
  if (options.selectedVersion !== undefined) {
    prepareVersion(options.selectedVersion);
    if (envelope)
      envelope = parsePrepareEnvelope({
        ...envelope,
        request: { ...envelope.request, selectedVersion: options.selectedVersion },
      });
  }
  const requestFile = path.join(path.resolve(options.outDir), 'request.json');
  if (existsSync(requestFile)) {
    if (!lstatSync(requestFile).isFile())
      prepareFail(
        'Preparation request artifact must be a regular file.',
        'DATASET_PREPARE_DRAFT_OUTPUT_INVALID',
      );
    const existing = parsePrepareEnvelope(JSON.parse(readFileSync(requestFile, 'utf8')));
    if (
      envelope
        ? !prepareSame(existing, envelope)
        : options.type !==
            Object.entries(PREPARE_TYPES).find(
              ([, table]) => table === existing.request.table,
            )?.[0] ||
          options.id !== existing.request.id ||
          options.sourceVersion !== existing.request.source.version ||
          (options.selectedVersion !== undefined &&
            options.selectedVersion !== existing.request.selectedVersion) ||
          (options.projectRef !== undefined && options.projectRef !== existing.project_ref) ||
          (options.targetUserId !== undefined &&
            options.targetUserId !== existing.request.expectedActorId)
    )
      prepareFail(
        'Output directory already owns another preparation request.',
        'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT',
      );
    envelope = existing;
  }
  const table = envelope
    ? envelope.request.table
    : PREPARE_TYPES[options.type as keyof typeof PREPARE_TYPES];
  if (!table)
    prepareFail(
      'Select --type contact, source, flow or standalone process.',
      'INVALID_DATASET_TABLE',
    );
  const id = envelope ? envelope.request.id : prepareUuid(options.id);
  const sourceVersion = envelope
    ? envelope.request.source.version
    : prepareVersion(options.sourceVersion);
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
  if (
    (envelope &&
      (envelope.project_ref !== context.project_ref ||
        envelope.request.expectedActorId !== context.account.user_id)) ||
    (options.projectRef !== undefined && options.projectRef !== context.project_ref) ||
    (options.targetUserId !== undefined && options.targetUserId !== context.account.user_id)
  )
    prepareFail(
      'Preparation project/actor differs from the authenticated session.',
      'DATASET_ACTOR_MISMATCH',
    );
  const reviewCensus = await readPrepareReviews(context, table, id);
  assertInputCurrent();
  const consumed =
    envelope !== null && readPrepareAttempt(prepareAttemptPath(options.env, envelope), envelope);
  let observation: Awaited<ReturnType<typeof observe>> | null = null;
  // A fresh review return point takes priority over drift of an earlier frozen draft.
  // Preserve that original request instead of re-authorizing or replacing its snapshots.
  if (!options.statusOnly && !consumed && (envelope === null || reviewCensus.rows.length === 0)) {
    observation = await observe(context, table, id, sourceVersion);
    const expectedDrafts = draftSnapshots(observation.census.rows);
    if (
      envelope &&
      (!prepareSame(envelope.request.source, observation.source) ||
        !prepareSame(envelope.request.expectedDrafts, expectedDrafts))
    )
      prepareFail(
        'Preparation source, complete draft set or before content changed.',
        'DATASET_PREPARE_DRAFT_OBSERVATION_CHANGED',
      );
    envelope ??= parsePrepareEnvelope({
      schema_version: 'dataset-prepare-draft-request.v1',
      project_ref: context.project_ref,
      requestId: randomUUID(),
      request: {
        table,
        id,
        expectedActorId: context.account.user_id,
        expectedDrafts,
        source: observation.source,
        selectedVersion: options.selectedVersion ?? null,
      },
    });
  }
  const request = envelope!;
  const selected = prepareSelection(
    request.request.expectedDrafts,
    request.request.selectedVersion ?? null,
  );
  const report: DatasetPrepareDraftReport = {
    schema_version: 'dataset-prepare-draft-report.v1',
    status: selected
      ? 'selected'
      : request.request.expectedDrafts.length > 1
        ? 'conflict'
        : 'needs_creation',
    mode,
    save_ready: false,
    reviews: reviewCensus.rows,
    review_completeness: reviewCensus.completeness,
    request,
    request_sha256: sha256Json(request),
    attempt_consumed: consumed,
    mutation_dispatches: 0,
    ...(observation
      ? { drafts: observation.census.rows, completeness: observation.census.completeness }
      : {}),
    target: selected
      ? { ...selected, userId: request.request.expectedActorId, stateCode: 0 }
      : null,
    files,
  };
  assertInputCurrent();
  persistRequest(files.request, request);
  if (reviewCensus.rows.length > 0) {
    report.status = 'review_conflict';
    report.target = null;
    report.error = {
      code: 'DATASET_REVIEW_IN_PROGRESS',
      message:
        'Continue the exact existing dataset/review versions; preparation cannot bypass in-progress review.',
      details: { table, id, reviews: reviewCensus.rows },
    };
    if (mode === 'status_only' || consumed) {
      try {
        const recovered = await recover(context, request);
        report.receipt = recovered.receipt;
        if (recovered.error) report.recovery_error = recovered.error;
      } catch (error) {
        report.recovery_error = errorEvidence(error, request);
      }
    }
  } else if (mode === 'read_only') {
    if (consumed) {
      report.status = 'unknown';
      report.target = null;
    }
  } else if (mode === 'commit' && !consumed && report.status === 'conflict') {
    // A complete conflict remains reviewable and emits no mutation.
  } else {
    if (mode === 'commit' && !consumed) {
      assertInputCurrent();
      const fresh = claimPrepareAttempt(prepareAttemptPath(options.env, request), request, outDir);
      report.attempt_consumed = true;
      if (fresh) {
        report.mutation_dispatches = 1;
        try {
          report.receipt = parsePrepareResult(
            await requestPrepareBackend(context, request, false),
            request,
          );
        } catch (error) {
          report.error = errorEvidence(error, request);
        }
      }
    }
    try {
      const recovered = await recover(context, request);
      if (
        report.receipt &&
        !prepareSame(
          { ...report.receipt, replayed: false },
          { ...recovered.receipt, replayed: false },
        )
      )
        prepareFail(
          'Preparation lookup contradicts the validated preparation receipt.',
          'DATASET_PREPARE_DRAFT_READBACK_MISMATCH',
        );
      report.status = recovered.status;
      report.receipt ??= recovered.receipt;
      report.target = recovered.target;
      if (recovered.error) {
        if (report.error) report.recovery_error = recovered.error;
        else report.error = recovered.error;
      }
    } catch (error) {
      const recoveryError = errorEvidence(error, request);
      if (report.error) report.recovery_error = recoveryError;
      else report.error = recoveryError;
      report.status = ['DATASET_DRAFT_CONFLICT', 'DATASET_REVIEW_IN_PROGRESS'].includes(
        report.error.code,
      )
        ? 'conflict'
        : report.error.code === 'DATASET_PREPARE_DRAFT_CAPABILITY_UNAVAILABLE'
          ? 'capability_unavailable'
          : 'unknown';
      report.target = null;
    }
  }
  assertInputCurrent();
  artifact(files.target, report.target);
  artifact(files.report, report);
  return report;
}

export async function runDatasetPrepareDraft(
  options: RunDatasetPrepareDraftOptions,
): Promise<DatasetPrepareDraftReport> {
  if (!options.outDir.trim()) prepareFail('Preparation requires a non-empty output directory.');
  const outDir = path.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(outDir).isDirectory())
    prepareFail(
      'Preparation output must be a private directory.',
      'DATASET_PREPARE_DRAFT_OUTPUT_INVALID',
    );
  chmodSync(outDir, 0o700);
  return withBatchRunLock(
    {
      runPath: outDir,
      identity: 'dataset-prepare-draft.v1',
      reason: 'prepare-stable-owner-draft',
      timeoutMs: 0,
    },
    () => runLockedPrepareDraft(options),
  );
}
