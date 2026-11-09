import { semanticContextFromInput } from './process-semantic-validation.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import { collectFlowReferencePropertyIssues } from './flow-reference-properties.js';
import {
  coerceText,
  datasetPayloadFromRow,
  deepGet,
  extractFlowRecord,
  isRecord,
  listify,
  loadRowsFromFile,
  type FlowRecord,
  type JsonRecord,
} from './flow-governance.js';
import {
  runFlowPublishVersion,
  type FlowPublishVersionReport,
  type RunFlowPublishVersionOptions,
} from './flow-publish-version.js';
import type { FetchLike } from './http.js';
import { getRuntimeRuleset } from './runtime-rulesets.js';
import {
  hasSupabaseRestRuntime,
  syncSupabaseJsonOrderedRecord,
  type SupabaseJsonOrderedWriteOperation,
} from './supabase-json-ordered-write.js';

const DEFAULT_MAX_WORKERS = 4;
const LEGACY_OUTPUT_PREFIX = 'flows_tidas_sdk_plus_classification';

export type FlowPublishPolicy = 'skip' | 'append_only_bump' | 'upsert_current_version';
export type ProcessPublishPolicy = FlowPublishPolicy;

type FlowPublishVersionCompatMode = 'dry_run' | 'commit';

type FlowVersionMapEntry = {
  id: string;
  source_version: string;
  target_version: string;
};

type ProcessIdentity = {
  id: string;
  version: string;
  name: string;
};

type FlowIndex = {
  byUuidVersion: Record<string, FlowRecord>;
};

type SkippedUnchangedFlowRow = {
  entity_type: 'flow';
  entity_id: string;
  entity_name: string;
  version: string;
  reason: 'unchanged_vs_original_rows_file';
};

type PreparedFlowPlan = {
  entity_type: 'flow';
  entity_id: string;
  entity_name: string;
  original_version: string;
  publish_version: string;
  version_strategy: 'keep_current' | 'bump';
  publish_policy: FlowPublishPolicy;
  row: JsonRecord;
};

type PreparedProcessPlan = {
  entity_type: 'process';
  entity_id: string;
  entity_name: string;
  original_version: string;
  publish_version: string;
  version_strategy: 'keep_current' | 'bump';
  publish_policy: ProcessPublishPolicy;
  row: JsonRecord;
};

type ProcessFlowRefRewriteEvidence = {
  process_id: string;
  process_version_before_publish: string;
  process_name: string;
  exchange_internal_id: string;
  source_flow_id: string;
  source_flow_version: string;
  target_flow_id: string;
  target_flow_version: string;
  target_flow_name: string;
};

type FlowPublishSuccessRow = {
  id: string;
  version: string;
  operation:
    | 'would_insert'
    | 'would_update_existing'
    | 'insert'
    | 'update_existing'
    | 'update_after_insert_error';
};

type FlowPublishFailureReason = {
  validator: string;
  stage: string;
  path: string;
  message: string;
  code: string;
  visible_user_id?: string;
  visible_state_code?: string;
};

type FlowPublishFailureRow = {
  id: unknown;
  user_id?: unknown;
  json_ordered: JsonRecord;
  reason: FlowPublishFailureReason[];
  state_code?: unknown;
};

type FlowReviewedPublishFiles = {
  prepared_flow_rows: string;
  prepared_process_rows: string;
  flow_version_map: string;
  skipped_unchanged_flow_rows: string;
  process_ref_rewrite_evidence: string;
  success_list: string;
  remote_failed: string;
  flow_publish_version_report: string;
  report: string;
};

export type FlowReviewedPublishRowReport = {
  entity_type: 'flow';
  id: string;
  name: string;
  original_version: string;
  publish_version: string;
  publish_policy: FlowPublishPolicy;
  version_strategy: 'keep_current' | 'bump';
  status: 'prepared' | 'inserted' | 'updated' | 'failed';
  operation?: FlowPublishSuccessRow['operation'];
  error?: unknown;
};

export type FlowReviewedPublishProcessRowReport = {
  entity_type: 'process';
  id: string;
  name: string;
  original_version: string;
  publish_version: string;
  publish_policy: ProcessPublishPolicy;
  version_strategy: 'keep_current' | 'bump';
  status: 'prepared' | 'inserted' | 'updated' | 'skipped_existing' | 'failed';
  operation?: SupabaseJsonOrderedWriteOperation;
  error?: unknown;
};

export type FlowReviewedPublishDataReport = {
  schema_version: 1;
  generated_at_utc: string;
  status:
    | 'prepared_flow_publish_reviewed_data'
    | 'completed_flow_publish_reviewed_data'
    | 'completed_flow_publish_reviewed_data_with_failures';
  mode: FlowPublishVersionCompatMode;
  flow_rows_file: string | null;
  process_rows_file: string | null;
  original_flow_rows_file: string | null;
  out_dir: string;
  flow_publish_policy: FlowPublishPolicy;
  process_publish_policy: ProcessPublishPolicy;
  rewrite_process_flow_refs: boolean;
  counts: {
    input_flow_rows: number;
    input_process_rows: number;
    original_flow_rows: number;
    prepared_flow_rows: number;
    prepared_process_rows: number;
    skipped_unchanged_flow_rows: number;
    rewritten_process_flow_refs: number;
    flow_publish_reports: number;
    process_publish_reports: number;
    success_count: number;
    failure_count: number;
  };
  max_workers: number;
  target_user_id_override: string | null;
  files: FlowReviewedPublishFiles;
  flow_reports: FlowReviewedPublishRowReport[];
  process_reports: FlowReviewedPublishProcessRowReport[];
  skipped_unchanged_flow_rows: SkippedUnchangedFlowRow[];
};

export type RunFlowReviewedPublishDataOptions = {
  flowRowsFile?: string | null;
  originalFlowRowsFile?: string | null;
  processRowsFile?: string | null;
  outDir: string;
  flowPublishPolicy?: FlowPublishPolicy;
  processPublishPolicy?: ProcessPublishPolicy;
  rewriteProcessFlowRefs?: boolean;
  commit?: boolean;
  maxWorkers?: number;
  targetUserId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  validateFlowPayloadImpl?: RunFlowPublishVersionOptions['validateFlowPayloadImpl'];
  runFlowPublishVersionImpl?: (
    options: RunFlowPublishVersionOptions,
  ) => Promise<FlowPublishVersionReport>;
};

function assert_input_file(
  inputFile: string,
  code: string,
  message = 'Missing required input file value.',
): string {
  if (!inputFile) {
    throw new CliError(message, {
      code,
      exitCode: 2,
    });
  }

  const resolved = path.resolve(inputFile);
  if (!existsSync(resolved)) {
    throw new CliError(`Input file not found: ${resolved}`, {
      code,
      exitCode: 2,
    });
  }

  return resolved;
}

function assert_optional_input_file(
  inputFile: string | null | undefined,
  code: string,
): string | null {
  if (!inputFile) {
    return null;
  }

  const resolved = path.resolve(inputFile);
  if (!existsSync(resolved)) {
    throw new CliError(`Input file not found: ${resolved}`, {
      code,
      exitCode: 2,
    });
  }

  return resolved;
}

function assert_out_dir(outDir: string): string {
  if (!outDir) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'FLOW_PUBLISH_REVIEWED_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  return path.resolve(outDir);
}

function clone_json<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function json_equal(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => json_equal(value, right[index]));
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key, index) => key === rightKeys[index] && json_equal(left[key], right[key]),
  );
}

function normalize_publish_policy(
  value: FlowPublishPolicy | string | undefined,
  label = '--flow-publish-policy',
  code = 'FLOW_PUBLISH_REVIEWED_POLICY_INVALID',
): FlowPublishPolicy {
  if (value === undefined || value === '') {
    return 'append_only_bump';
  }

  if (value === 'skip' || value === 'append_only_bump' || value === 'upsert_current_version') {
    return value;
  }

  throw new CliError(
    `Expected ${label} to be one of: skip, append_only_bump, upsert_current_version.`,
    {
      code,
      exitCode: 2,
    },
  );
}

function bump_ilcd_version(version: string): string {
  const parts = String(version || '')
    .trim()
    .split('.');
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/u.test(part))) {
    return '01.01.001';
  }

  const [head, middle, tail] = parts;
  return `${Number.parseInt(head, 10).toString().padStart(head.length, '0')}.${Number.parseInt(
    middle,
    10,
  )
    .toString()
    .padStart(middle.length, '0')}.${(Number.parseInt(tail, 10) + 1)
    .toString()
    .padStart(tail.length, '0')}`;
}

function set_flow_version(row: JsonRecord, newVersion: string): void {
  const payload = datasetPayloadFromRow(row);
  const dataset = isRecord(payload.flowDataSet) ? payload.flowDataSet : payload;
  const administrativeInformation = isRecord(dataset.administrativeInformation)
    ? dataset.administrativeInformation
    : {};
  if (!isRecord(dataset.administrativeInformation)) {
    dataset.administrativeInformation = administrativeInformation;
  }
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  if (!isRecord(administrativeInformation.publicationAndOwnership)) {
    administrativeInformation.publicationAndOwnership = publicationAndOwnership;
  }
  publicationAndOwnership['common:dataSetVersion'] = newVersion;
  row.version = newVersion;
}

function process_dataset_from_row(row: JsonRecord): JsonRecord {
  const payload = datasetPayloadFromRow(row);
  return isRecord(payload.processDataSet) ? payload.processDataSet : payload;
}

function extract_process_identity(row: JsonRecord): ProcessIdentity {
  const dataset = process_dataset_from_row(row);
  const info = deepGet(dataset, ['processInformation', 'dataSetInformation'], {}) as JsonRecord;
  const id = coerceText(row.id) || coerceText(info['common:UUID']);
  const version =
    coerceText(row.version) ||
    coerceText(
      deepGet(dataset, [
        'administrativeInformation',
        'publicationAndOwnership',
        'common:dataSetVersion',
      ]),
    ) ||
    '01.00.000';
  const nameBlock = deepGet(info, ['name', 'baseName']) ?? deepGet(info, ['name']) ?? info.name;
  const name = coerceText(nameBlock) || id;

  return {
    id,
    version,
    name,
  };
}

function exchange_records(processRow: JsonRecord): JsonRecord[] {
  const dataset = process_dataset_from_row(processRow);
  return listify(deepGet(dataset, ['exchanges', 'exchange'], [])).filter(isRecord);
}

function set_process_version(row: JsonRecord, newVersion: string): void {
  const payload = datasetPayloadFromRow(row);
  const dataset = isRecord(payload.processDataSet) ? payload.processDataSet : payload;
  const administrativeInformation = isRecord(dataset.administrativeInformation)
    ? dataset.administrativeInformation
    : {};
  if (!isRecord(dataset.administrativeInformation)) {
    dataset.administrativeInformation = administrativeInformation;
  }
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  if (!isRecord(administrativeInformation.publicationAndOwnership)) {
    administrativeInformation.publicationAndOwnership = publicationAndOwnership;
  }
  publicationAndOwnership['common:dataSetVersion'] = newVersion;
  row.version = newVersion;
}

function build_flow_index(rows: JsonRecord[]): FlowIndex {
  const byUuidVersion: Record<string, FlowRecord> = {};

  for (const row of rows) {
    const record = extractFlowRecord(row);
    byUuidVersion[`${record.id}@${record.version}`] = record;
  }

  return {
    byUuidVersion,
  };
}

function build_local_dataset_uri(datasetKind: string, uuidValue: string, version: string): string {
  if (!uuidValue) {
    return '';
  }

  const folderMap: Record<string, string> = {
    flow: 'flows',
    'flow data set': 'flows',
  };
  const folder = folderMap[datasetKind.trim().toLowerCase()] ?? 'datasets';
  const versionText = version.trim() || '01.00.000';
  return `../${folder}/${uuidValue}_${versionText}.xml`;
}

function preserve_short_description_shape(existing: unknown, target: JsonRecord): unknown {
  if (Array.isArray(existing)) {
    if (existing.length > 0 && isRecord(existing[0])) {
      const patched = clone_json(existing[0]);
      patched['@xml:lang'] =
        coerceText(target['@xml:lang']) || coerceText(patched['@xml:lang']) || 'en';
      patched['#text'] = coerceText(target['#text']);
      return [patched];
    }
    return [clone_json(target)];
  }

  if (isRecord(existing)) {
    const patched = clone_json(existing);
    patched['@xml:lang'] =
      coerceText(target['@xml:lang']) || coerceText(patched['@xml:lang']) || 'en';
    patched['#text'] = coerceText(target['#text']);
    return patched;
  }

  return clone_json(target);
}

function flow_reference_from_record(record: FlowRecord): JsonRecord {
  const targetShortDescription =
    record.shortDescription ??
    ({
      '@xml:lang': 'en',
      '#text': record.name,
    } satisfies JsonRecord);

  return {
    '@type': 'flow data set',
    '@refObjectId': record.id,
    '@version': record.version,
    '@uri': build_local_dataset_uri('flow data set', record.id, record.version),
    'common:shortDescription': clone_json(targetShortDescription),
  };
}

function patched_flow_reference(currentRef: unknown, record: FlowRecord): JsonRecord {
  const current = isRecord(currentRef) ? clone_json(currentRef) : {};
  const target = flow_reference_from_record(record);

  current['@type'] = coerceText(current['@type']) || coerceText(target['@type']);
  current['@refObjectId'] = target['@refObjectId'];
  current['@version'] = target['@version'];
  current['@uri'] = target['@uri'];
  current['common:shortDescription'] = preserve_short_description_shape(
    current['common:shortDescription'],
    target['common:shortDescription'] as JsonRecord,
  );

  return current;
}

function build_output_files(outDir: string): FlowReviewedPublishFiles {
  return {
    prepared_flow_rows: path.join(outDir, 'prepared-flow-rows.json'),
    prepared_process_rows: path.join(outDir, 'prepared-process-rows.json'),
    flow_version_map: path.join(outDir, 'flow-version-map.json'),
    skipped_unchanged_flow_rows: path.join(outDir, 'skipped-unchanged-flow-rows.json'),
    process_ref_rewrite_evidence: path.join(outDir, 'process-flow-ref-rewrite-evidence.jsonl'),
    success_list: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_mcp_success_list.json`),
    remote_failed: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remote_validation_failed.jsonl`),
    flow_publish_version_report: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_mcp_sync_report.json`),
    report: path.join(outDir, 'publish-report.json'),
  };
}

function status_from_mode(
  mode: FlowPublishVersionCompatMode,
  failureCount: number,
): FlowReviewedPublishDataReport['status'] {
  if (mode === 'dry_run') {
    return 'prepared_flow_publish_reviewed_data';
  }

  return failureCount > 0
    ? 'completed_flow_publish_reviewed_data_with_failures'
    : 'completed_flow_publish_reviewed_data';
}

function prepare_flow_rows(options: {
  rows: JsonRecord[];
  policy: FlowPublishPolicy;
  originalRows: JsonRecord[];
}): {
  preparedRows: JsonRecord[];
  plans: PreparedFlowPlan[];
  flowVersionMap: Record<string, FlowVersionMapEntry>;
  skippedUnchangedRows: SkippedUnchangedFlowRow[];
} {
  if (options.policy === 'skip') {
    return {
      preparedRows: [],
      plans: [],
      flowVersionMap: {},
      skippedUnchangedRows: [],
    };
  }

  const originalMap = new Map<string, JsonRecord>();
  for (const row of options.originalRows) {
    const record = extractFlowRecord(row);
    if (record.id && record.version) {
      originalMap.set(`${record.id}@${record.version}`, row);
    }
  }

  const preparedRows: JsonRecord[] = [];
  const plans: PreparedFlowPlan[] = [];
  const flowVersionMap: Record<string, FlowVersionMapEntry> = {};
  const skippedUnchangedRows: SkippedUnchangedFlowRow[] = [];

  for (const row of options.rows) {
    const working = clone_json(row);
    const record = extractFlowRecord(working);
    const originalRow =
      record.id && record.version ? originalMap.get(`${record.id}@${record.version}`) : undefined;

    if (originalRow && json_equal(datasetPayloadFromRow(originalRow), datasetPayloadFromRow(row))) {
      skippedUnchangedRows.push({
        entity_type: 'flow',
        entity_id: record.id,
        entity_name: record.name,
        version: record.version,
        reason: 'unchanged_vs_original_rows_file',
      });
      continue;
    }

    let publishVersion = record.version;
    let versionStrategy: PreparedFlowPlan['version_strategy'] = 'keep_current';
    if (options.policy === 'append_only_bump') {
      publishVersion = bump_ilcd_version(record.version);
      set_flow_version(working, publishVersion);
      versionStrategy = 'bump';
      if (record.id && record.version) {
        flowVersionMap[`${record.id}@${record.version}`] = {
          id: record.id,
          source_version: record.version,
          target_version: publishVersion,
        };
      }
    }

    preparedRows.push(working);
    plans.push({
      entity_type: 'flow',
      entity_id: record.id,
      entity_name: record.name,
      original_version: record.version,
      publish_version: publishVersion,
      version_strategy: versionStrategy,
      publish_policy: options.policy,
      row: working,
    });
  }

  return {
    preparedRows,
    plans,
    flowVersionMap,
    skippedUnchangedRows,
  };
}

function prepare_process_rows(options: {
  rows: JsonRecord[];
  policy: ProcessPublishPolicy;
  rewriteRefs: boolean;
  preparedFlowRows: JsonRecord[];
  flowVersionMap: Record<string, FlowVersionMapEntry>;
}): {
  preparedRows: JsonRecord[];
  plans: PreparedProcessPlan[];
  rewriteEvidence: ProcessFlowRefRewriteEvidence[];
} {
  if (options.policy === 'skip') {
    return {
      preparedRows: [],
      plans: [],
      rewriteEvidence: [],
    };
  }

  const preparedRows = options.rows.map((row) => clone_json(row));
  const rewriteEvidence: ProcessFlowRefRewriteEvidence[] = [];

  if (
    options.rewriteRefs &&
    preparedRows.length > 0 &&
    options.preparedFlowRows.length > 0 &&
    Object.keys(options.flowVersionMap).length > 0
  ) {
    const targetIndex = build_flow_index(options.preparedFlowRows).byUuidVersion;

    for (const row of preparedRows) {
      const processIdentity = extract_process_identity(row);

      for (const exchange of exchange_records(row)) {
        const currentRef = isRecord(exchange.referenceToFlowDataSet)
          ? exchange.referenceToFlowDataSet
          : null;
        if (!currentRef) {
          continue;
        }

        const flowId = coerceText(currentRef['@refObjectId']);
        const flowVersion = coerceText(currentRef['@version']);
        const mapped = options.flowVersionMap[`${flowId}@${flowVersion}`];
        if (!mapped) {
          continue;
        }

        const targetRecord = targetIndex[`${mapped.id}@${mapped.target_version}`];
        if (!targetRecord) {
          continue;
        }

        exchange.referenceToFlowDataSet = patched_flow_reference(currentRef, targetRecord);
        rewriteEvidence.push({
          process_id: processIdentity.id,
          process_version_before_publish: processIdentity.version,
          process_name: processIdentity.name,
          exchange_internal_id: coerceText(exchange['@dataSetInternalID']),
          source_flow_id: flowId,
          source_flow_version: flowVersion,
          target_flow_id: mapped.id,
          target_flow_version: mapped.target_version,
          target_flow_name: targetRecord.name,
        });
      }
    }
  }

  const plans: PreparedProcessPlan[] = [];
  for (const row of preparedRows) {
    const record = extract_process_identity(row);
    let publishVersion = record.version;
    let versionStrategy: PreparedProcessPlan['version_strategy'] = 'keep_current';
    if (options.policy === 'append_only_bump') {
      publishVersion = bump_ilcd_version(record.version);
      set_process_version(row, publishVersion);
      versionStrategy = 'bump';
    }

    plans.push({
      entity_type: 'process',
      entity_id: record.id,
      entity_name: record.name,
      original_version: record.version,
      publish_version: publishVersion,
      version_strategy: versionStrategy,
      publish_policy: options.policy,
      row,
    });
  }

  return {
    preparedRows,
    plans,
    rewriteEvidence,
  };
}

function build_local_row_report(plan: PreparedFlowPlan): FlowReviewedPublishRowReport {
  return {
    entity_type: 'flow',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status: 'prepared',
  };
}

function build_local_process_row_report(
  plan: PreparedProcessPlan,
): FlowReviewedPublishProcessRowReport {
  return {
    entity_type: 'process',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status: 'prepared',
  };
}

function process_publish_payload_from_row(row: JsonRecord): JsonRecord {
  const payload = datasetPayloadFromRow(row);
  const dataset = isRecord(payload.processDataSet) ? payload.processDataSet : payload;
  return {
    processDataSet: clone_json(dataset),
  };
}

function build_process_commit_success_report(
  plan: PreparedProcessPlan,
  operation: SupabaseJsonOrderedWriteOperation,
): FlowReviewedPublishProcessRowReport {
  return {
    entity_type: 'process',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status:
      operation === 'insert'
        ? 'inserted'
        : operation === 'skipped_existing'
          ? 'skipped_existing'
          : 'updated',
    operation,
  };
}

function build_process_commit_failure_report(
  plan: PreparedProcessPlan,
  error: unknown,
): FlowReviewedPublishProcessRowReport {
  return {
    entity_type: 'process',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status: 'failed',
    error,
  };
}

function normalize_process_commit_failure(error: unknown): unknown {
  if (error instanceof CliError && error.code === 'REMOTE_REQUEST_FAILED') {
    if (typeof error.details === 'string' && error.details.trim()) {
      return error.details;
    }

    if (error.message.startsWith('HTTP 0 returned') && isRecord(error.details)) {
      const detailMessage =
        typeof error.details.message === 'string' ? error.details.message.trim() : '';
      const normalized = detailMessage.replace(/^(?:FetchError|Error):\s*/u, '').trim();
      if (normalized && normalized !== 'undefined') {
        return normalized;
      }
    }
  }

  return error instanceof Error ? error.message : error;
}

function build_commit_success_report(
  plan: PreparedFlowPlan,
  success: FlowPublishSuccessRow,
): FlowReviewedPublishRowReport {
  return {
    entity_type: 'flow',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status: success.operation === 'insert' ? 'inserted' : 'updated',
    operation: success.operation,
  };
}

function build_commit_failure_report(
  plan: PreparedFlowPlan,
  failure: FlowPublishFailureRow,
): FlowReviewedPublishRowReport {
  return {
    entity_type: 'flow',
    id: plan.entity_id,
    name: plan.entity_name,
    original_version: plan.original_version,
    publish_version: plan.publish_version,
    publish_policy: plan.publish_policy,
    version_strategy: plan.version_strategy,
    status: 'failed',
    error: failure.reason,
  };
}

function build_flow_key(id: string, version: string): string | null {
  if (!id || !version) {
    return null;
  }
  return `${id}@${version}`;
}

function queue_by_key<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const queued = new Map<string, T[]>();

  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      continue;
    }
    const queue = queued.get(key) ?? [];
    queue.push(item);
    queued.set(key, queue);
  }

  return queued;
}

function failure_key(row: FlowPublishFailureRow): string | null {
  const record = extractFlowRecord(row as unknown as JsonRecord);
  return build_flow_key(record.id, record.version);
}

function success_key(row: FlowPublishSuccessRow): string | null {
  return build_flow_key(row.id, row.version);
}

function shift_queue<T>(queue: Map<string, T[]>, key: string | null): T | null {
  if (!key) {
    return null;
  }

  const items = queue.get(key);
  if (!items?.length) {
    return null;
  }

  const [first, ...rest] = items;
  if (rest.length) {
    queue.set(key, rest);
  } else {
    queue.delete(key);
  }
  return first ?? null;
}

async function map_with_concurrency<T, R>(
  items: T[],
  maxWorkers: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.min(Math.max(1, maxWorkers), Math.max(items.length, 1));
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function map_commit_reports(
  plans: PreparedFlowPlan[],
  successes: FlowPublishSuccessRow[],
  failures: FlowPublishFailureRow[],
): FlowReviewedPublishRowReport[] {
  const successQueue = queue_by_key(successes, success_key);
  const failureQueue = queue_by_key(failures, failure_key);
  const unkeyedFailures = failures.filter((failure) => failure_key(failure) === null);

  return plans.map((plan) => {
    const key = build_flow_key(plan.entity_id, plan.publish_version);
    const success = shift_queue(successQueue, key);
    if (success) {
      return build_commit_success_report(plan, success);
    }

    const failure =
      shift_queue(failureQueue, key) ?? (key ? null : (unkeyedFailures.shift() ?? null));
    if (failure) {
      return build_commit_failure_report(plan, failure);
    }

    return {
      ...build_local_row_report(plan),
      status: 'failed',
      error: [
        {
          code: 'UNMATCHED_PUBLISH_RESULT',
          message: 'Publish result was missing for prepared flow row.',
        },
      ],
    };
  });
}

function build_compat_report(options: {
  now: Date;
  mode: FlowPublishVersionCompatMode;
  preparedRows: number;
  successCount: number;
  failureCount: number;
  maxWorkers: number;
  targetUserId: string | null;
  files: FlowReviewedPublishFiles;
}): FlowPublishVersionReport {
  const ruleset = getRuntimeRuleset('flow-publish/default');
  let status: FlowPublishVersionReport['status'];
  if (options.mode === 'dry_run') {
    status = 'prepared_flow_publish_version';
  } else {
    status =
      options.failureCount > 0
        ? 'completed_flow_publish_version_with_failures'
        : 'completed_flow_publish_version';
  }

  return {
    schema_version: 1,
    generated_at_utc: options.now.toISOString(),
    status,
    mode: options.mode,
    input_file: options.files.prepared_flow_rows,
    out_dir: path.dirname(options.files.report),
    counts: {
      total_rows: options.preparedRows,
      success_count: options.successCount,
      failure_count: options.failureCount,
    },
    flow_gate: {
      status: 'passed',
      ruleset_id: ruleset.id,
      ruleset_version: ruleset.version,
      counts: {
        total: options.preparedRows,
        valid: options.preparedRows,
        invalid: 0,
      },
      blocker_count: 0,
      next_action: 'query_remote_write_plan',
    },
    operation_counts: {},
    max_workers: options.maxWorkers,
    limit: null,
    target_user_id_override: options.targetUserId,
    files: {
      success_list: options.files.success_list,
      remote_failed: options.files.remote_failed,
      gate_report: options.files.flow_publish_version_report,
      report: options.files.flow_publish_version_report,
    },
  };
}

async function commit_process_plans(options: {
  plans: PreparedProcessPlan[];
  maxWorkers: number;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<FlowReviewedPublishProcessRowReport[]> {
  return map_with_concurrency(options.plans, options.maxWorkers, async (plan) => {
    try {
      const result = await syncSupabaseJsonOrderedRecord({
        table: 'processes',
        id: plan.entity_id,
        version: plan.publish_version,
        payload: process_publish_payload_from_row(plan.row),
        extraData: { semantic_context: semanticContextFromInput(plan.row) },
        writeMode:
          plan.publish_policy === 'append_only_bump'
            ? 'append_only_insert'
            : 'upsert_current_version',
        env: options.env,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      return build_process_commit_success_report(plan, result.operation);
    } catch (error) {
      return build_process_commit_failure_report(plan, normalize_process_commit_failure(error));
    }
  });
}

export async function runFlowReviewedPublishData(
  options: RunFlowReviewedPublishDataOptions,
): Promise<FlowReviewedPublishDataReport> {
  const flowRowsFile = assert_optional_input_file(
    options.flowRowsFile,
    'FLOW_PUBLISH_REVIEWED_FLOW_ROWS_NOT_FOUND',
  );
  const processRowsFile = assert_optional_input_file(
    options.processRowsFile,
    'FLOW_PUBLISH_REVIEWED_PROCESS_ROWS_NOT_FOUND',
  );
  if (!flowRowsFile && !processRowsFile) {
    throw new CliError('Provide at least one of --flow-rows-file or --process-rows-file.', {
      code: 'FLOW_PUBLISH_REVIEWED_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  const originalFlowRowsFile = assert_optional_input_file(
    options.originalFlowRowsFile,
    'FLOW_PUBLISH_REVIEWED_ORIGINAL_ROWS_NOT_FOUND',
  );
  const outDir = assert_out_dir(options.outDir);
  const flowPublishPolicy = normalize_publish_policy(options.flowPublishPolicy);
  const processPublishPolicy = normalize_publish_policy(
    options.processPublishPolicy,
    '--process-publish-policy',
    'FLOW_PUBLISH_REVIEWED_PROCESS_POLICY_INVALID',
  );
  const rewriteProcessFlowRefs = options.rewriteProcessFlowRefs !== false;
  const mode: FlowPublishVersionCompatMode = options.commit ? 'commit' : 'dry_run';
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const targetUserId =
    typeof options.targetUserId === 'string' && options.targetUserId.trim()
      ? options.targetUserId.trim()
      : null;
  const now = options.now ?? new Date();
  const files = build_output_files(outDir);
  const inputFlowRows = flowRowsFile ? loadRowsFromFile(flowRowsFile) : [];
  const originalFlowRows = originalFlowRowsFile ? loadRowsFromFile(originalFlowRowsFile) : [];
  const inputProcessRows = processRowsFile ? loadRowsFromFile(processRowsFile) : [];
  const prepared = prepare_flow_rows({
    rows: inputFlowRows,
    policy: flowPublishPolicy,
    originalRows: originalFlowRows,
  });
  const invalidFlows = prepared.plans.flatMap((plan) => {
    const issues = collectFlowReferencePropertyIssues(datasetPayloadFromRow(plan.row));
    return issues.length ? [{ id: plan.entity_id, version: plan.original_version, issues }] : [];
  });
  if (invalidFlows.length > 0) {
    throw new CliError('Flow reference properties block reviewed publication preparation.', {
      code: 'FLOW_PUBLISH_REVIEWED_REFERENCE_PROPERTIES_INVALID',
      exitCode: 1,
      details: { flows: invalidFlows },
    });
  }
  const preparedProcesses = prepare_process_rows({
    rows: inputProcessRows,
    policy: processPublishPolicy,
    rewriteRefs: rewriteProcessFlowRefs,
    preparedFlowRows: prepared.preparedRows,
    flowVersionMap: prepared.flowVersionMap,
  });

  writeJsonArtifact(files.prepared_flow_rows, prepared.preparedRows);
  writeJsonArtifact(files.prepared_process_rows, preparedProcesses.preparedRows);
  writeJsonArtifact(files.flow_version_map, prepared.flowVersionMap);
  writeJsonArtifact(files.skipped_unchanged_flow_rows, prepared.skippedUnchangedRows);
  writeJsonLinesArtifact(files.process_ref_rewrite_evidence, preparedProcesses.rewriteEvidence);

  let flowReports = prepared.plans.map(build_local_row_report);
  let processReports = preparedProcesses.plans.map(build_local_process_row_report);

  if (options.commit && prepared.preparedRows.length > 0) {
    const publishImpl = options.runFlowPublishVersionImpl ?? runFlowPublishVersion;
    await publishImpl({
      inputFile: files.prepared_flow_rows,
      outDir,
      commit: true,
      maxWorkers,
      targetUserId,
      env: options.env,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      now,
      validateFlowPayloadImpl: options.validateFlowPayloadImpl,
    });

    const successRows = loadRowsFromFile(files.success_list) as FlowPublishSuccessRow[];
    const failureRows = loadRowsFromFile(files.remote_failed) as FlowPublishFailureRow[];
    flowReports = map_commit_reports(prepared.plans, successRows, failureRows);
  } else {
    writeJsonArtifact(files.success_list, []);
    writeJsonLinesArtifact(files.remote_failed, []);
    const compatReport = build_compat_report({
      now,
      mode,
      preparedRows: prepared.preparedRows.length,
      successCount: 0,
      failureCount: 0,
      maxWorkers,
      targetUserId,
      files,
    });
    writeJsonArtifact(files.flow_publish_version_report, compatReport);
  }

  if (options.commit && preparedProcesses.preparedRows.length > 0) {
    if (!options.fetchImpl) {
      throw new CliError(
        'Process commit requires a fetch implementation in flow publish-reviewed-data.',
        {
          code: 'FLOW_PUBLISH_REVIEWED_PROCESS_FETCH_REQUIRED',
          exitCode: 2,
        },
      );
    }

    const runtimeEnv = options.env;
    if (!runtimeEnv || !hasSupabaseRestRuntime(runtimeEnv)) {
      throw new CliError(
        'Process commit requires TIANGONG_LCA_API_BASE_URL, TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY, and an OAuth or explicit access-token session.',
        {
          code: 'FLOW_PUBLISH_REVIEWED_PROCESS_RUNTIME_REQUIRED',
          exitCode: 2,
        },
      );
    }

    processReports = await commit_process_plans({
      plans: preparedProcesses.plans,
      maxWorkers,
      env: runtimeEnv,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  }

  const successCount =
    flowReports.filter((report) => report.status === 'inserted' || report.status === 'updated')
      .length +
    processReports.filter(
      (report) =>
        report.status === 'inserted' ||
        report.status === 'updated' ||
        report.status === 'skipped_existing',
    ).length;
  const failureCount =
    flowReports.filter((report) => report.status === 'failed').length +
    processReports.filter((report) => report.status === 'failed').length;

  const report: FlowReviewedPublishDataReport = {
    schema_version: 1,
    generated_at_utc: now.toISOString(),
    status: status_from_mode(mode, failureCount),
    mode,
    flow_rows_file: flowRowsFile,
    process_rows_file: processRowsFile,
    original_flow_rows_file: originalFlowRowsFile,
    out_dir: outDir,
    flow_publish_policy: flowPublishPolicy,
    process_publish_policy: processPublishPolicy,
    rewrite_process_flow_refs: rewriteProcessFlowRefs,
    counts: {
      input_flow_rows: inputFlowRows.length,
      input_process_rows: inputProcessRows.length,
      original_flow_rows: originalFlowRows.length,
      prepared_flow_rows: prepared.preparedRows.length,
      prepared_process_rows: preparedProcesses.preparedRows.length,
      skipped_unchanged_flow_rows: prepared.skippedUnchangedRows.length,
      rewritten_process_flow_refs: preparedProcesses.rewriteEvidence.length,
      flow_publish_reports: flowReports.length,
      process_publish_reports: processReports.length,
      success_count: successCount,
      failure_count: failureCount,
    },
    max_workers: maxWorkers,
    target_user_id_override: targetUserId,
    files,
    flow_reports: flowReports,
    process_reports: processReports,
    skipped_unchanged_flow_rows: prepared.skippedUnchangedRows,
  };

  writeJsonArtifact(files.report, report);
  return report;
}

export const __testInternals = {
  assert_input_file,
  assert_optional_input_file,
  assert_out_dir,
  clone_json,
  json_equal,
  normalize_publish_policy,
  bump_ilcd_version,
  set_flow_version,
  process_dataset_from_row,
  extract_process_identity,
  exchange_records,
  set_process_version,
  build_flow_index,
  build_local_dataset_uri,
  preserve_short_description_shape,
  flow_reference_from_record,
  patched_flow_reference,
  build_output_files,
  status_from_mode,
  prepare_flow_rows,
  prepare_process_rows,
  build_compat_report,
  map_commit_reports,
  shift_queue,
  process_publish_payload_from_row,
  build_process_commit_success_report,
  build_process_commit_failure_report,
  normalize_process_commit_failure,
  map_with_concurrency,
  commit_process_plans,
};
