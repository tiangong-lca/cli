// data-api-relations: flows
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import { collectDatasetContentIssues } from './dataset-validate.js';
import {
  buildDatasetCommandTransport,
  createDatasetRecord,
  saveDraftDatasetRecord,
  type DatasetCommandTransport,
} from './dataset-command.js';
import { CliError } from './errors.js';
import {
  FLOW_SCHEMA_VALIDATOR,
  validateFlowPayload,
  type FlowPayloadValidationIssue,
  type FlowPayloadValidationResult,
} from './flow-payload-validation.js';
import {
  coerceText,
  deepGet,
  isRecord,
  loadRowsFromFile,
  type JsonRecord,
} from './flow-governance.js';
import type { FetchLike, ResponseLike } from './http.js';
import { getRuntimeRuleset, resolveRuntimeRuleId } from './runtime-rulesets.js';
import {
  createSupabaseDataClient,
  requireSupabaseRestRuntime,
  runSupabaseArrayQuery,
} from './supabase-client.js';
import { createSupabaseDataRuntime } from './supabase-session.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WORKERS = 4;
const LEGACY_OUTPUT_PREFIX = 'flows_tidas_sdk_plus_classification';
const FLOW_PUBLISH_VALIDATOR = `${FLOW_SCHEMA_VALIDATOR}+tiangong/import-content`;

type FlowPublishMode = 'dry_run' | 'commit';
type FlowPublishOperation =
  | 'would_insert'
  | 'would_update_existing'
  | 'insert'
  | 'update_existing'
  | 'update_after_insert_error';

type FlowPublishFailureReason = {
  validator: 'remote_rest' | 'flow_schema' | 'import_content' | 'flow_reference_properties';
  stage: string;
  path: string;
  message: string;
  code: string;
  visible_user_id?: string;
  visible_state_code?: string;
};

type VisibleFlowRow = {
  id: string;
  version: string;
  user_id: string;
  state_code: number | null;
};

type SupabaseDataClient = ReturnType<typeof createSupabaseDataClient>['client'];

type FlowPublishFailureRow = {
  id: unknown;
  user_id: unknown;
  json_ordered: JsonRecord;
  reason: FlowPublishFailureReason[];
  state_code: unknown;
};

type FlowPublishSuccessRow = {
  id: string;
  version: string;
  operation: FlowPublishOperation;
};

type FlowPublishFiles = {
  successList: string;
  remoteFailed: string;
  gateReport: string;
  report: string;
};

type FlowPublishGateFinding = {
  code: string;
  severity: 'blocker';
  methodology_rule_id: string | null;
  message: string;
  path: string;
  dataset_index: number;
  dataset_id: string | null;
  dataset_version: string | null;
};

export type FlowPublishVersionGateReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'passed' | 'blocked';
  ruleset_id: 'flow-publish/default';
  ruleset_version: '1';
  ruleset_source_version: string;
  ruleset_rule_ids: string[];
  validator: string;
  counts: {
    total: number;
    valid: number;
    invalid: number;
  };
  findings: FlowPublishGateFinding[];
  blockers: FlowPublishGateFinding[];
  next_action: 'query_remote_write_plan' | 'fix_flow_payloads';
  flows: Array<{
    index: number;
    id: string | null;
    version: string | null;
    ok: boolean;
    issue_count: number;
    issues: FlowPayloadValidationIssue[];
  }>;
};

type FlowPublishOutcome =
  | {
      status: 'success';
      success: FlowPublishSuccessRow;
    }
  | {
      status: 'failure';
      failure: FlowPublishFailureRow;
    };

export type FlowPublishVersionReport = {
  schema_version: 1;
  generated_at_utc: string;
  status:
    | 'prepared_flow_publish_version'
    | 'completed_flow_publish_version'
    | 'completed_flow_publish_version_with_failures';
  mode: FlowPublishMode;
  input_file: string;
  out_dir: string;
  counts: {
    total_rows: number;
    success_count: number;
    failure_count: number;
  };
  flow_gate: {
    status: FlowPublishVersionGateReport['status'];
    ruleset_id: FlowPublishVersionGateReport['ruleset_id'];
    ruleset_version: FlowPublishVersionGateReport['ruleset_version'];
    counts: FlowPublishVersionGateReport['counts'];
    blocker_count: number;
    next_action: FlowPublishVersionGateReport['next_action'];
  };
  operation_counts: Record<string, number>;
  max_workers: number;
  limit: number | null;
  target_user_id_override: string | null;
  files: {
    success_list: string;
    remote_failed: string;
    gate_report: string;
    report: string;
  };
};

export type RunFlowPublishVersionOptions = {
  inputFile: string;
  outDir: string;
  commit?: boolean;
  maxWorkers?: number;
  limit?: number;
  targetUserId?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
  validateFlowPayloadImpl?: (payload: JsonRecord) => FlowPayloadValidationResult;
};

function normalize_token(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assert_input_file(inputFile: string): string {
  const resolved = path.resolve(inputFile);
  if (!inputFile) {
    throw new CliError('Missing required --input-file value.', {
      code: 'FLOW_PUBLISH_VERSION_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  if (!existsSync(resolved)) {
    throw new CliError(`Flow publish-version input file not found: ${resolved}`, {
      code: 'FLOW_PUBLISH_VERSION_INPUT_NOT_FOUND',
      exitCode: 2,
    });
  }
  return resolved;
}

function assert_out_dir(outDir: string): string {
  if (!outDir) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'FLOW_PUBLISH_VERSION_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }
  return path.resolve(outDir);
}

function to_positive_integer(
  value: number | undefined,
  label: string,
  code: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`Expected ${label} to be a positive integer.`, {
      code,
      exitCode: 2,
    });
  }
  return value;
}

function to_non_negative_integer(
  value: number | undefined,
  label: string,
  code: string,
): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(`Expected ${label} to be a non-negative integer.`, {
      code,
      exitCode: 2,
    });
  }
  return value;
}

function build_output_files(outDir: string): FlowPublishFiles {
  return {
    successList: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_mcp_success_list.json`),
    remoteFailed: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remote_validation_failed.jsonl`),
    gateReport: path.join(outDir, 'flow-publish-version-gate-report.json'),
    report: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_mcp_sync_report.json`),
  };
}

function flow_payload(row: JsonRecord): JsonRecord {
  if (isRecord(row.json_ordered)) {
    return row.json_ordered;
  }
  if (isRecord(row.jsonOrdered)) {
    return row.jsonOrdered;
  }
  if (isRecord(row.json)) {
    return row.json;
  }
  if (isRecord(row.flowDataSet)) {
    return row;
  }
  throw new CliError(
    'Flow row is missing json_ordered/jsonOrdered/json or a top-level flowDataSet payload.',
    {
      code: 'FLOW_PUBLISH_VERSION_PAYLOAD_REQUIRED',
      exitCode: 2,
    },
  );
}

function flow_id(row: JsonRecord, payload: JsonRecord): string {
  return (
    coerceText(row.id) ||
    coerceText(
      deepGet(payload, ['flowDataSet', 'flowInformation', 'dataSetInformation', 'common:UUID']),
    )
  );
}

function flow_version(payload: JsonRecord): string {
  const version = coerceText(
    deepGet(payload, [
      'flowDataSet',
      'administrativeInformation',
      'publicationAndOwnership',
      'common:dataSetVersion',
    ]),
  );
  if (!version) {
    throw new CliError(
      'Flow payload is missing flowDataSet.administrativeInformation.publicationAndOwnership.common:dataSetVersion.',
      {
        code: 'FLOW_PUBLISH_VERSION_MISSING_VERSION',
        exitCode: 2,
      },
    );
  }
  return version;
}

function flow_version_gate_result(payload: JsonRecord): {
  version: string | null;
  issue: FlowPayloadValidationIssue | null;
} {
  const version = coerceText(
    deepGet(payload, [
      'flowDataSet',
      'administrativeInformation',
      'publicationAndOwnership',
      'common:dataSetVersion',
    ]),
  );
  if (version) {
    return { version, issue: null };
  }
  return {
    version: null,
    issue: validation_issue(
      'flowDataSet.administrativeInformation.publicationAndOwnership.common:dataSetVersion',
      'Flow payload is missing flowDataSet.administrativeInformation.publicationAndOwnership.common:dataSetVersion.',
      'FLOW_PUBLISH_VERSION_MISSING_VERSION',
    ),
  };
}

function validation_issue(
  pathValue: string,
  message: string,
  code: string,
): FlowPayloadValidationIssue {
  return {
    path: pathValue,
    message,
    code,
  };
}

function validate_publish_flow_row(
  row: JsonRecord,
  index: number,
  validate: (payload: JsonRecord) => FlowPayloadValidationResult,
): FlowPublishVersionGateReport['flows'][number] {
  const issues: FlowPayloadValidationIssue[] = [];
  let payload: JsonRecord | null = null;
  let id: string | null = null;
  let version: string | null = null;

  try {
    payload = flow_payload(row);
  } catch (error) {
    const cliError = error as CliError;
    issues.push(
      validation_issue('<root>', cliError.message, cliError.code || 'flow_payload_required'),
    );
  }

  if (payload) {
    id = flow_id(row, payload) || null;
    if (!id) {
      issues.push(
        validation_issue(
          'flowDataSet.flowInformation.dataSetInformation.common:UUID',
          'Flow row is missing a resolvable id/common:UUID value.',
          'FLOW_PUBLISH_VERSION_ID_REQUIRED',
        ),
      );
    }

    const versionGate = flow_version_gate_result(payload);
    version = versionGate.version;
    if (versionGate.issue) {
      issues.push(versionGate.issue);
    }

    const validation = validate(payload);
    if (!validation.ok) {
      issues.push(...validation.issues);
    }
    issues.push(...collectDatasetContentIssues(payload, 'flow'));
  }

  return {
    index,
    id,
    version,
    ok: issues.length === 0,
    issue_count: issues.length,
    issues,
  };
}

function build_flow_publish_gate_report(
  rows: JsonRecord[],
  options: {
    now: Date;
    validateFlowPayloadImpl?: (payload: JsonRecord) => FlowPayloadValidationResult;
  },
): FlowPublishVersionGateReport {
  const ruleset = getRuntimeRuleset('flow-publish/default');
  const validate = options.validateFlowPayloadImpl ?? validateFlowPayload;
  const flows = rows.map((row, index) => validate_publish_flow_row(row, index, validate));
  const invalid = flows.filter((flow) => !flow.ok).length;
  const blockers = flows.flatMap((flow) =>
    flow.issues.map((issue) => ({
      code: issue.code,
      severity: 'blocker' as const,
      methodology_rule_id: resolveRuntimeRuleId(ruleset.id, issue.code),
      message: issue.message,
      path: issue.path,
      dataset_index: flow.index,
      dataset_id: flow.id,
      dataset_version: flow.version,
    })),
  );

  return {
    schema_version: 1,
    generated_at_utc: options.now.toISOString(),
    status: invalid > 0 ? 'blocked' : 'passed',
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    ruleset_source_version: ruleset.source_version,
    ruleset_rule_ids: ruleset.rule_ids,
    validator: FLOW_PUBLISH_VALIDATOR,
    counts: {
      total: flows.length,
      valid: flows.length - invalid,
      invalid,
    },
    findings: blockers,
    blockers,
    next_action: invalid > 0 ? 'fix_flow_payloads' : 'query_remote_write_plan',
    flows,
  };
}

function flow_gate_summary(
  gate: FlowPublishVersionGateReport,
): FlowPublishVersionReport['flow_gate'] {
  return {
    status: gate.status,
    ruleset_id: gate.ruleset_id,
    ruleset_version: gate.ruleset_version,
    counts: gate.counts,
    blocker_count: gate.blockers.length,
    next_action: gate.next_action,
  };
}

function gate_failure_rows(
  rows: JsonRecord[],
  gate: FlowPublishVersionGateReport,
): FlowPublishFailureRow[] {
  return gate.flows.flatMap((flow) => {
    if (flow.ok) {
      return [];
    }
    const row = rows[flow.index];
    if (!row) {
      return [];
    }
    return [
      failure_row(
        row,
        flow.issues.map((issue) => {
          const ruleId = resolveRuntimeRuleId('flow-publish/default', issue.code);
          const isReferenceProperty =
            ruleId === 'tidas.flow.reference-property-unit.required' ||
            ruleId === 'tidas.flow.flow-property.mean-value.positive';
          const validator =
            issue.code === 'dataset_import_placeholder_content'
              ? 'import_content'
              : isReferenceProperty
                ? 'flow_reference_properties'
                : 'flow_schema';
          return {
            ...issue,
            validator,
            stage: isReferenceProperty ? 'content_gate' : 'schema_gate',
          };
        }),
      ),
    ];
  });
}

function resolve_target_user_id(
  row: JsonRecord,
  targetUserIdOverride: string | null,
): string | null {
  return normalize_token(coerceText(row.user_id)) ?? targetUserIdOverride;
}

function build_visible_rows_url(restBaseUrl: string, id: string, version: string): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/flows`);
  url.searchParams.set('select', 'id,version,user_id,state_code');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

function build_update_url(restBaseUrl: string, id: string, version: string): string {
  const url = new URL(`${restBaseUrl.replace(/\/+$/u, '')}/flows`);
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('version', `eq.${version}`);
  return url.toString();
}

async function parse_response(response: ResponseLike, url: string): Promise<unknown> {
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} returned from ${url}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: rawText,
    });
  }

  if (!rawText) {
    return null;
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

function parse_visible_rows(payload: unknown, url: string): VisibleFlowRow[] {
  if (!Array.isArray(payload)) {
    throw new CliError(`Supabase REST response was not a JSON array for ${url}`, {
      code: 'SUPABASE_REST_RESPONSE_INVALID',
      exitCode: 1,
      details: payload,
    });
  }

  return payload.map((item, index) => {
    if (!isRecord(item)) {
      throw new CliError(`Supabase REST row ${index} was not a JSON object for ${url}`, {
        code: 'SUPABASE_REST_RESPONSE_INVALID',
        exitCode: 1,
        details: item,
      });
    }

    return {
      id: coerceText(item.id),
      version: coerceText(item.version),
      user_id: coerceText(item.user_id),
      state_code: typeof item.state_code === 'number' ? item.state_code : null,
    };
  });
}

async function visible_exact_rows(options: {
  client: SupabaseDataClient;
  restBaseUrl: string;
  id: string;
  version: string;
}): Promise<VisibleFlowRow[]> {
  const url = build_visible_rows_url(options.restBaseUrl, options.id, options.version);
  const payload = await runSupabaseArrayQuery(
    options.client
      .from('flows')
      .select('id,version,user_id,state_code')
      .eq('id', options.id)
      .eq('version', options.version),
    url,
  );
  return parse_visible_rows(payload, url);
}

function own_visible_row(
  rows: VisibleFlowRow[],
  targetUserId: string | null,
): VisibleFlowRow | null {
  if (!targetUserId) {
    return null;
  }
  return rows.find((row) => row.user_id === targetUserId) ?? null;
}

function visible_conflict_reasons(
  stage: string,
  visibleRows: VisibleFlowRow[],
  targetUserId: string | null,
): FlowPublishFailureReason[] {
  if (visibleRows.length === 0) {
    return [];
  }

  if (!targetUserId) {
    return [
      {
        validator: 'remote_rest',
        stage,
        path: '',
        message:
          'Exact UUID/version is already visible, but no target user id was available to determine whether the row is writable.',
        code: 'target_user_id_required',
      },
    ];
  }

  return visibleRows.map((row) => ({
    validator: 'remote_rest',
    stage,
    path: '',
    message: 'Exact UUID/version is already visible but not writable under the target user.',
    code: 'exact_version_visible_not_owned',
    visible_user_id: row.user_id,
    visible_state_code: row.state_code === null ? '' : String(row.state_code),
  }));
}

function failure_row(
  sourceRow: JsonRecord,
  reasons: FlowPublishFailureReason[],
): FlowPublishFailureRow {
  let payload: JsonRecord;
  try {
    payload = flow_payload(sourceRow);
  } catch {
    payload = {};
  }
  return {
    id: sourceRow.id,
    user_id: sourceRow.user_id,
    json_ordered: payload,
    reason: reasons,
    state_code: sourceRow.state_code,
  };
}

function build_error_reasons(stage: string, error: unknown): FlowPublishFailureReason[] {
  if (error instanceof CliError) {
    const detailText = typeof error.details === 'string' ? error.details.trim() : error.message;
    return [
      {
        validator: 'remote_rest',
        stage,
        path: '',
        message: detailText || error.message,
        code: error.code,
      },
    ];
  }

  if (error instanceof Error) {
    return [
      {
        validator: 'remote_rest',
        stage,
        path: '',
        message: error.message,
        code: error.name || 'Error',
      },
    ];
  }

  return [
    {
      validator: 'remote_rest',
      stage,
      path: '',
      message: String(error),
      code: 'UnknownError',
    },
  ];
}

async function insert_flow_version(options: {
  transport: DatasetCommandTransport;
  rowId: string;
  payload: JsonRecord;
}): Promise<void> {
  await createDatasetRecord({
    transport: options.transport,
    table: 'flows',
    id: options.rowId,
    payload: options.payload,
  });
}

async function update_flow_version(options: {
  transport: DatasetCommandTransport;
  rowId: string;
  version: string;
  payload: JsonRecord;
}): Promise<void> {
  await saveDraftDatasetRecord({
    transport: options.transport,
    table: 'flows',
    id: options.rowId,
    version: options.version,
    payload: options.payload,
  });
}

async function sync_one_row(options: {
  row: JsonRecord;
  mode: FlowPublishMode;
  client: SupabaseDataClient;
  restBaseUrl: string;
  commandTransport: DatasetCommandTransport;
  targetUserIdOverride: string | null;
}): Promise<FlowPublishOutcome> {
  try {
    const payload = flow_payload(options.row);
    const rowId = flow_id(options.row, payload);
    if (!rowId) {
      throw new CliError('Flow row is missing a resolvable id/common:UUID value.', {
        code: 'FLOW_PUBLISH_VERSION_ID_REQUIRED',
        exitCode: 2,
      });
    }
    const version = flow_version(payload);
    const targetUserId = resolve_target_user_id(options.row, options.targetUserIdOverride);
    const visibleBefore = await visible_exact_rows({
      client: options.client,
      restBaseUrl: options.restBaseUrl,
      id: rowId,
      version,
    });
    const ownBefore = own_visible_row(visibleBefore, targetUserId);

    if (options.mode === 'dry_run') {
      if (ownBefore) {
        return {
          status: 'success',
          success: {
            id: rowId,
            version,
            operation: 'would_update_existing',
          },
        };
      }

      if (visibleBefore.length > 0) {
        return {
          status: 'failure',
          failure: failure_row(
            options.row,
            visible_conflict_reasons('dry_run_preflight', visibleBefore, targetUserId),
          ),
        };
      }

      return {
        status: 'success',
        success: {
          id: rowId,
          version,
          operation: 'would_insert',
        },
      };
    }

    if (ownBefore) {
      await update_flow_version({
        transport: options.commandTransport,
        rowId,
        version,
        payload,
      });
      return {
        status: 'success',
        success: {
          id: rowId,
          version,
          operation: 'update_existing',
        },
      };
    }

    if (visibleBefore.length > 0) {
      return {
        status: 'failure',
        failure: failure_row(
          options.row,
          visible_conflict_reasons('preflight', visibleBefore, targetUserId),
        ),
      };
    }

    try {
      await insert_flow_version({
        transport: options.commandTransport,
        rowId,
        payload,
      });
      return {
        status: 'success',
        success: {
          id: rowId,
          version,
          operation: 'insert',
        },
      };
    } catch (error) {
      const visibleAfter = await visible_exact_rows({
        client: options.client,
        restBaseUrl: options.restBaseUrl,
        id: rowId,
        version,
      });
      const ownAfter = own_visible_row(visibleAfter, targetUserId);
      if (ownAfter) {
        try {
          await update_flow_version({
            transport: options.commandTransport,
            rowId,
            version,
            payload,
          });
          return {
            status: 'success',
            success: {
              id: rowId,
              version,
              operation: 'update_after_insert_error',
            },
          };
        } catch (updateError) {
          return {
            status: 'failure',
            failure: failure_row(options.row, [
              ...build_error_reasons('insert', error),
              ...build_error_reasons('update_after_insert_error', updateError),
            ]),
          };
        }
      }

      return {
        status: 'failure',
        failure: failure_row(options.row, [
          ...build_error_reasons('insert', error),
          ...visible_conflict_reasons('post_insert_error_preflight', visibleAfter, targetUserId),
        ]),
      };
    }
  } catch (error) {
    return {
      status: 'failure',
      failure: failure_row(options.row, build_error_reasons('sync_one_unhandled', error)),
    };
  }
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

function status_from_mode(
  mode: FlowPublishMode,
  failureCount: number,
): FlowPublishVersionReport['status'] {
  if (mode === 'dry_run') {
    return 'prepared_flow_publish_version';
  }
  return failureCount > 0
    ? 'completed_flow_publish_version_with_failures'
    : 'completed_flow_publish_version';
}

export async function runFlowPublishVersion(
  options: RunFlowPublishVersionOptions,
): Promise<FlowPublishVersionReport> {
  const inputFile = assert_input_file(options.inputFile);
  const outDir = assert_out_dir(options.outDir);
  const mode: FlowPublishMode = options.commit ? 'commit' : 'dry_run';
  const maxWorkers = to_positive_integer(
    options.maxWorkers,
    '--max-workers',
    'FLOW_PUBLISH_VERSION_MAX_WORKERS_INVALID',
    DEFAULT_MAX_WORKERS,
  );
  const limit = to_non_negative_integer(
    options.limit,
    '--limit',
    'FLOW_PUBLISH_VERSION_LIMIT_INVALID',
  );
  const now = options.now ?? new Date();
  const files = build_output_files(outDir);

  let rows = loadRowsFromFile(inputFile);
  if (limit !== null && limit > 0) {
    rows = rows.slice(0, limit);
  }
  if (rows.length === 0) {
    throw new CliError(`No rows found in ${inputFile}`, {
      code: 'FLOW_PUBLISH_VERSION_EMPTY_INPUT',
      exitCode: 2,
    });
  }

  const flowGate = build_flow_publish_gate_report(rows, {
    now,
    validateFlowPayloadImpl: options.validateFlowPayloadImpl,
  });
  await writeJsonArtifact(files.gateReport, flowGate);

  if (flowGate.status === 'blocked') {
    const failures = gate_failure_rows(rows, flowGate);
    await writeJsonArtifact(files.successList, []);
    await writeJsonLinesArtifact(files.remoteFailed, failures);

    const report: FlowPublishVersionReport = {
      schema_version: 1,
      generated_at_utc: now.toISOString(),
      status: status_from_mode(mode, failures.length),
      mode,
      input_file: inputFile,
      out_dir: outDir,
      counts: {
        total_rows: rows.length,
        success_count: 0,
        failure_count: failures.length,
      },
      flow_gate: flow_gate_summary(flowGate),
      operation_counts: {},
      max_workers: maxWorkers,
      limit,
      target_user_id_override: normalize_token(options.targetUserId ?? null),
      files: {
        success_list: files.successList,
        remote_failed: files.remoteFailed,
        gate_report: files.gateReport,
        report: files.report,
      },
    };

    await writeJsonArtifact(files.report, report);
    return report;
  }

  const fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runtime = createSupabaseDataRuntime({
    runtime: requireSupabaseRestRuntime(options.env ?? process.env),
    fetchImpl,
    timeoutMs,
    now,
  });
  const commandTransport = await buildDatasetCommandTransport({
    runtime,
    fetchImpl,
    timeoutMs,
  });
  const { client, restBaseUrl } = createSupabaseDataClient(runtime, fetchImpl, timeoutMs);
  const targetUserIdOverride = normalize_token(options.targetUserId ?? null);

  const outcomes = await map_with_concurrency(rows, maxWorkers, async (row) =>
    sync_one_row({
      row,
      mode,
      client,
      restBaseUrl,
      commandTransport,
      targetUserIdOverride,
    }),
  );

  const successes: FlowPublishSuccessRow[] = [];
  const failures: FlowPublishFailureRow[] = [];
  const operationCounts: Record<string, number> = {};

  for (const outcome of outcomes) {
    if (outcome.status === 'success') {
      successes.push(outcome.success);
      operationCounts[outcome.success.operation] =
        (operationCounts[outcome.success.operation] ?? 0) + 1;
    } else {
      failures.push(outcome.failure);
    }
  }

  await writeJsonArtifact(files.successList, successes);
  await writeJsonLinesArtifact(files.remoteFailed, failures);

  const report: FlowPublishVersionReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: status_from_mode(mode, failures.length),
    mode,
    input_file: inputFile,
    out_dir: outDir,
    counts: {
      total_rows: rows.length,
      success_count: successes.length,
      failure_count: failures.length,
    },
    flow_gate: flow_gate_summary(flowGate),
    operation_counts: operationCounts,
    max_workers: maxWorkers,
    limit,
    target_user_id_override: targetUserIdOverride,
    files: {
      success_list: files.successList,
      remote_failed: files.remoteFailed,
      gate_report: files.gateReport,
      report: files.report,
    },
  };

  await writeJsonArtifact(files.report, report);
  return report;
}

export const __testInternals = {
  assert_input_file,
  assert_out_dir,
  to_positive_integer,
  to_non_negative_integer,
  build_output_files,
  flow_payload,
  flow_id,
  flow_version,
  flow_version_gate_result,
  validate_publish_flow_row,
  build_flow_publish_gate_report,
  flow_gate_summary,
  gate_failure_rows,
  sync_one_row,
  resolve_target_user_id,
  build_visible_rows_url,
  build_update_url,
  parse_response,
  parse_visible_rows,
  visible_conflict_reasons,
  failure_row,
  build_error_reasons,
  map_with_concurrency,
  status_from_mode,
};
