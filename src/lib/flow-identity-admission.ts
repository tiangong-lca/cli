import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { sha256Json, stableJsonText } from './canonical-json-hash.js';
import { datasetIdentity, isRecord, unwrapDatasetPayload } from './dataset-local.js';
import { CliError } from './errors.js';
import { runFlowIdentityPreflight } from './identity-preflight.js';
import { loadCliPackageVersion } from './package-version.js';
import {
  flowIdentityCoverageSnapshots,
  flowIdentityPayloadType,
  parseFlowIdentityCoverage,
  type FlowIdentityCoverage,
  type FlowIdentityFlowType,
} from './flow-identity-admission-remote.js';

type JsonObject = Record<string, unknown>;
export const FLOW_IDENTITY_ADMISSION_PROFILE = 'flow-identity-admitted-insert.v1' as const;
export const FLOW_IDENTITY_ADMISSION_SCHEMA = 'flow-identity-admission.v1' as const;
const RULESET = 'flow-identity-admission/agent-scoped-v1';
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/u;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type FlowIdentityAdmissionFileFact = { path: string; sha256: string; bytes: number };
export type FlowIdentityAdmissionOwner = { user_id: string; email: string; state_code: 0 };
export type FlowIdentityAdmissionActionCore = {
  action_id: string;
  desired_sha256: string;
  expected_operation: 'insert';
  table: 'flows';
  id: string;
  version: string;
  before_sha256: null;
  dependency_action_ids: string[];
};
export type FlowIdentityAdmissionAction = FlowIdentityAdmissionActionCore & {
  identity_admission: {
    schema_version: typeof FLOW_IDENTITY_ADMISSION_SCHEMA;
    receipt: FlowIdentityAdmissionFileFact;
  };
};
type Target = { id: string; version: string; payload_sha256: string };
export type FlowIdentityAdmissionSummary = {
  schema_version: 'flow-identity-admission-summary.v1';
  profile: typeof FLOW_IDENTITY_ADMISSION_PROFILE;
  action_core_sha256: string;
  contract_sha256: string;
  receipt: FlowIdentityAdmissionFileFact;
  project_ref: string;
  actor_user_id: string;
  target: Target;
  review_sha256: string;
  coverage_sha256: string;
};
type Receipt = {
  schema_version: typeof FLOW_IDENTITY_ADMISSION_SCHEMA;
  profile: typeof FLOW_IDENTITY_ADMISSION_PROFILE;
  status: 'prepared_for_recheck';
  target: Target;
  project_ref: string;
  owner: FlowIdentityAdmissionOwner;
  action_core_sha256: string;
  input: FlowIdentityAdmissionFileFact;
  preflight: FlowIdentityAdmissionFileFact;
  review: FlowIdentityAdmissionFileFact;
  coverage: FlowIdentityAdmissionFileFact;
  issuer: { cli_version: string; ruleset_id: string };
  validity: { reviewed_at_utc: string; expires_at_utc: string };
};
export type LoadedFlowIdentityAdmission = {
  receipt: Receipt;
  receiptFile: FlowIdentityAdmissionFileFact;
  files: FlowIdentityAdmissionFileFact[];
  coverage: FlowIdentityCoverage;
  action: FlowIdentityAdmissionActionCore;
  contractSha256: string;
};

function fail(message: string): never {
  throw new CliError(message, { code: 'FLOW_IDENTITY_ADMISSION_INVALID', exitCode: 2 });
}
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function object(value: unknown, keys: string[], label: string): JsonObject {
  requireFact(
    isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    `${label} must contain exactly its supported fields.`,
  );
  return value;
}
function text(value: unknown): string {
  requireFact(
    typeof value === 'string' && value.trim().length > 0 && value.length <= 8192,
    'Admission text must be non-empty and bounded.',
  );
  return value;
}
function exactExecutionToken(value: unknown): string {
  const result = text(value);
  requireFact(
    result === result.trim(),
    'Admission owner email and action identifiers must not have edge whitespace.',
  );
  return result;
}
function hash(value: unknown): string {
  requireFact(typeof value === 'string' && HASH.test(value), 'Admission SHA-256 is invalid.');
  return value;
}
function uuid(value: unknown): string {
  requireFact(typeof value === 'string' && UUID.test(value), 'Admission UUID is invalid.');
  return value;
}
function version(value: unknown): string {
  requireFact(typeof value === 'string' && VERSION.test(value), 'Admission version is invalid.');
  return value;
}
function time(value: unknown): string {
  const result = text(value);
  requireFact(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(result) &&
      Number.isFinite(Date.parse(result)) &&
      new Date(result).toISOString().slice(0, 19) === result.slice(0, 19),
    'Admission timestamp must be an explicit UTC instant.',
  );
  return result;
}
function array(value: unknown, label: string): unknown[] {
  requireFact(
    Array.isArray(value) && value.length > 0 && value.length <= 1000,
    `${label} must be a non-empty bounded array.`,
  );
  return value;
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map(text);
}
function target(value: unknown): Target {
  const item = object(value, ['id', 'version', 'payload_sha256'], 'Target');
  return {
    id: uuid(item.id),
    version: version(item.version),
    payload_sha256: hash(item.payload_sha256),
  };
}
function owner(value: unknown): FlowIdentityAdmissionOwner {
  const item = object(value, ['user_id', 'email', 'state_code'], 'Owner');
  const email = exactExecutionToken(item.email);
  requireFact(
    item.state_code === 0 && email === email.toLowerCase(),
    'Admission owner must be an exact normalized draft owner.',
  );
  return { user_id: uuid(item.user_id), email, state_code: 0 };
}
function project(value: unknown): string {
  requireFact(
    typeof value === 'string' && /^[a-z0-9]{20}$/u.test(value),
    'Admission project is invalid.',
  );
  return value;
}
function fileFact(value: unknown, base: string): FlowIdentityAdmissionFileFact {
  const item = object(value, ['path', 'sha256', 'bytes'], 'File fact');
  requireFact(
    Number.isSafeInteger(item.bytes) &&
      Number(item.bytes) > 0 &&
      Number(item.bytes) <= MAX_FILE_BYTES,
    'Admission file byte count is invalid.',
  );
  return {
    path: exactPath(item.path, base),
    sha256: hash(item.sha256),
    bytes: Number(item.bytes),
  };
}
function exactPath(value: unknown, base: string = process.cwd()): string {
  const selected = text(value);
  requireFact(
    selected === selected.trim() && !/\p{Cc}/u.test(selected),
    'Admission file locators must be exact paths without edge whitespace or control characters.',
  );
  return path.resolve(base, selected);
}
function same(left: unknown, right: unknown, message: string): void {
  requireFact(stableJsonText(left) === stableJsonText(right), message);
}
function reader() {
  const files = new Map<string, FlowIdentityAdmissionFileFact>();
  let totalBytes = 0;
  function read(file: string, expected?: FlowIdentityAdmissionFileFact) {
    const selected = exactPath(file);
    let bytes: Buffer;
    let content: string;
    try {
      const stat = lstatSync(selected);
      requireFact(
        stat.isFile() && stat.size <= MAX_FILE_BYTES,
        'Admission evidence must be regular files no larger than 8 MiB; symlinks are unsupported.',
      );
      bytes = readFileSync(selected);
      requireFact(
        bytes.length <= MAX_FILE_BYTES,
        'Admission evidence exceeds its 8 MiB file budget.',
      );
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof CliError) throw error;
      return fail('Admission evidence must be readable UTF-8 files.');
    }
    const fact = {
      path: selected,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    requireFact(bytes.length > 0, 'Admission evidence cannot be empty.');
    if (expected) same(fact, expected, 'Admission evidence file changed.');
    const previous = files.get(fact.path);
    if (previous) same(previous, fact, 'Admission evidence changed while loading.');
    const nextTotalBytes = totalBytes + (previous ? 0 : bytes.length);
    requireFact(
      nextTotalBytes <= MAX_TOTAL_BYTES,
      'Admission evidence exceeds its 64 MiB unique-file budget.',
    );
    totalBytes = nextTotalBytes;
    files.set(fact.path, fact);
    return { fact, content };
  }
  function json(file: string, expected?: FlowIdentityAdmissionFileFact) {
    const result = read(file, expected);
    try {
      return { fact: result.fact, value: JSON.parse(result.content) as unknown };
    } catch {
      return fail('Admission control files must be valid JSON.');
    }
  }
  function bound(value: unknown, base: string) {
    const expected = fileFact(value, base);
    read(expected.path, expected);
    return expected;
  }
  return { files, read, json, bound };
}

function actionCore(value: unknown, withAdmission: boolean): FlowIdentityAdmissionActionCore {
  const keys = [
    'action_id',
    'desired_sha256',
    'expected_operation',
    'table',
    'id',
    'version',
    'before_sha256',
    'dependency_action_ids',
  ];
  const item = object(
    value,
    withAdmission ? [...keys, 'identity_admission'] : keys,
    'Insert action',
  );
  requireFact(
    item.expected_operation === 'insert' &&
      item.table === 'flows' &&
      item.before_sha256 === null &&
      Array.isArray(item.dependency_action_ids) &&
      item.dependency_action_ids.length === 0,
    'Identity admission supports only one independent new Flow insert.',
  );
  return {
    action_id: exactExecutionToken(item.action_id),
    desired_sha256: hash(item.desired_sha256),
    expected_operation: 'insert',
    table: 'flows',
    id: uuid(item.id),
    version: version(item.version),
    before_sha256: null,
    dependency_action_ids: [],
  };
}
export function flowIdentityAdmissionActionCoreSha256(
  action: FlowIdentityAdmissionActionCore,
): string {
  return sha256Json(actionCore(action, false));
}
function contract(value: unknown, v2: boolean) {
  const item = object(
    value,
    [
      'schema_version',
      'execution_id',
      'project_ref',
      'target_mode',
      'owner',
      'actions',
      ...(v2 ? ['profile'] : []),
    ],
    'Execution contract',
  );
  requireFact(
    item.schema_version === `dataset-save-draft-execution-contract.v${v2 ? 2 : 1}` &&
      item.target_mode === 'owner_draft' &&
      (!v2 || item.profile === FLOW_IDENTITY_ADMISSION_PROFILE) &&
      Array.isArray(item.actions) &&
      item.actions.length === 1,
    'Identity execution contract profile is unsupported.',
  );
  const actions = item.actions as unknown[];
  return {
    execution_id: text(item.execution_id),
    project_ref: project(item.project_ref),
    owner: owner(item.owner),
    action: actionCore(actions[0], v2),
    rawAction: actions[0] as JsonObject,
  };
}
function validity(value: unknown) {
  const item = object(value, ['reviewed_at_utc', 'expires_at_utc'], 'Validity');
  const reviewed = time(item.reviewed_at_utc),
    expires = time(item.expires_at_utc);
  const duration = Date.parse(expires) - Date.parse(reviewed);
  requireFact(
    duration > 0 && duration <= MAX_AGE_MS,
    'Identity review validity cannot exceed 24 hours.',
  );
  return { reviewed_at_utc: reviewed, expires_at_utc: expires };
}
function payloadTarget(row: JsonObject): {
  target: Target;
  payload: JsonObject;
  flowType: FlowIdentityFlowType;
} {
  const payload = unwrapDatasetPayload(row);
  const identity = datasetIdentity({}, payload, 'flow');
  const rowIdentity = datasetIdentity(row, payload, 'flow');
  same(identity, rowIdentity, 'Flow row identity does not match its complete payload.');
  const flowType = flowIdentityPayloadType(payload);
  requireFact(flowType !== null, 'Admission needs a complete Product or Waste Flow payload.');
  return {
    target: {
      id: uuid(identity.id),
      version: version(identity.version),
      payload_sha256: sha256Json(payload),
    },
    payload,
    flowType,
  };
}

type Evidence = Awaited<ReturnType<typeof validateEvidence>>;
async function validateEvidence(
  input: {
    inputPath: string;
    preflightPath: string;
    reviewPath: string;
    coveragePath: string;
    action: FlowIdentityAdmissionActionCore;
    owner: FlowIdentityAdmissionOwner;
    projectRef: string;
  },
  read: ReturnType<typeof reader>,
) {
  const original = read.json(input.inputPath);
  const originalReport = read.json(input.preflightPath);
  const coverageFile = read.json(input.coveragePath);
  const reviewFile = read.json(input.reviewPath);
  const request = object(original.value, ['target', 'candidates'], 'Saved preflight input');
  requireFact(isRecord(request.target), 'Preflight target must be a full Flow row.');
  const originalCandidates = array(request.candidates, 'Original candidates');
  const preparedTarget = payloadTarget(request.target);
  same(
    preparedTarget.target,
    {
      id: input.action.id,
      version: input.action.version,
      payload_sha256: input.action.desired_sha256,
    },
    'Target does not bind the insert action.',
  );
  const originalTargets = originalCandidates.map((entry) => {
    requireFact(isRecord(entry), 'Original candidates must contain complete Flow rows.');
    return payloadTarget(entry).target;
  });
  requireFact(
    new Set(originalTargets.map((entry) => `${entry.id}@${entry.version}`)).size ===
      originalTargets.length,
    'Original candidates contain duplicate exact identities.',
  );
  const current = await runFlowIdentityPreflight({
    inputPath: original.fact.path,
    rawInput: request,
    remoteCandidateSearch: false,
  });
  requireFact(
    current.status === 'needs_review' &&
      current.decision === 'manual_review' &&
      current.blockers.length === 0 &&
      current.target.schema_validation.status === 'passed',
    'Only a schema-valid manual-review preflight can enter scoped admission.',
  );
  const report = originalReport.value;
  requireFact(isRecord(report), 'Saved preflight report must be an object.');
  const originalInputPath = exactPath(report.input_path);
  requireFact(
    path.isAbsolute(text(report.input_path)),
    'Saved preflight input path must be absolute.',
  );
  same(
    report.candidate_sources,
    current.candidate_sources.map((source) => ({ ...source, path: originalInputPath })),
    'Saved preflight candidate sources do not match its complete embedded request.',
  );
  // Historical timestamps and output paths do not identify content; every comparison result does.
  for (const key of [
    'schema_version',
    'kind',
    'status',
    'decision',
    'confidence',
    'target',
    'candidates',
    'findings',
    'blockers',
    'next_action',
  ] as const) {
    same(
      report[key],
      current[key],
      'Saved preflight does not correspond to its complete input/current rules.',
    );
  }
  const coverage = parseFlowIdentityCoverage(coverageFile.value, input.owner.user_id);
  same(
    coverage.project_ref,
    input.projectRef,
    'Coverage project differs from the execution project.',
  );
  requireFact(
    coverage.queries.some((query) =>
      query.kind === 'flow_family'
        ? query.type_of_dataset === preparedTarget.flowType
        : query.filter.flowType === preparedTarget.flowType,
    ),
    'Coverage needs a query for the target Flow type.',
  );
  const snapshots = flowIdentityCoverageSnapshots(coverage);
  const snapshotTargets = snapshots.map((entry) => ({
    id: entry.id,
    version: entry.version,
    payload_sha256: sha256Json(entry.payload),
  }));
  for (const snapshot of snapshots) {
    const candidate = payloadTarget(snapshot.payload);
    same(
      candidate.target,
      { id: snapshot.id, version: snapshot.version, payload_sha256: sha256Json(snapshot.payload) },
      'Discovered snapshot identity differs from its complete body.',
    );
    // Historical published bodies remain comparison evidence even when the current SDK
    // rejects their authoring structure. Only the new target is admitted for writing.
  }
  for (const candidate of originalTargets) {
    requireFact(
      snapshotTargets.some((entry) => sha256Json(entry) === sha256Json(candidate)),
      'Coverage omits or changes an original candidate body.',
    );
  }
  const discovered = await runFlowIdentityPreflight({
    inputPath: original.fact.path,
    rawInput: {
      target: request.target,
      candidates: snapshots.map((entry) => ({
        id: entry.id,
        version: entry.version,
        state_code: entry.state_code,
        json_ordered: entry.payload,
      })),
    },
    remoteCandidateSearch: false,
  });
  requireFact(
    discovered.blockers.length === 0 && discovered.decision === 'manual_review',
    'Discovery contains a hard identity/schema blocker.',
  );
  const review = object(
    reviewFile.value,
    [
      'schema_version',
      'decision',
      'target',
      'preflight',
      'reviewer',
      'authorization',
      'adopted_by',
      'scope',
      'candidate_decisions',
      'coverage',
      'validity',
      'reuse_identity',
    ],
    'Agent review',
  );
  requireFact(
    review.schema_version === 'flow-identity-review.v1' &&
      ['create_distinct', 'reuse'].includes(String(review.decision)),
    'Agent review schema or decision is unsupported.',
  );
  same(target(review.target), preparedTarget.target, 'Review target content changed.');
  const base = path.dirname(reviewFile.fact.path);
  const preflight = object(review.preflight, ['input', 'report'], 'Review preflight');
  same(
    read.bound(preflight.input, base),
    original.fact,
    'Review does not bind the original request.',
  );
  same(
    read.bound(preflight.report, base),
    originalReport.fact,
    'Review does not bind the original report.',
  );
  const reviewer = object(
    review.reviewer,
    ['kind', 'source_host_thread_id', 'agent_id', 'reviewed_at_utc', 'report'],
    'Reviewer',
  );
  requireFact(
    reviewer.kind === 'agent',
    'Scoped review requires the actual Agent reviewer, never a human claim.',
  );
  text(reviewer.source_host_thread_id);
  text(reviewer.agent_id);
  read.bound(reviewer.report, base);
  const authorization = object(
    review.authorization,
    ['principles', 'authorization_chain', 'assignment', 'clauses', 'scope'],
    'Standing authorization',
  );
  read.bound(authorization.principles, base);
  read.bound(authorization.assignment, base);
  for (const evidence of array(authorization.authorization_chain, 'Authorization chain'))
    read.bound(evidence, base);
  const clauses = strings(authorization.clauses, 'Authorization clauses');
  requireFact(
    clauses.length <= 64 &&
      new Set(clauses).size === clauses.length &&
      clauses.every(
        (clause) => clause.length <= 128 && clause === clause.trim() && !/\p{Cc}/u.test(clause),
      ),
    'Standing authority must bind unique bounded explicit clause identifiers.',
  );
  text(authorization.scope);
  const adoption = object(review.adopted_by, ['host_thread_id', 'evidence'], 'Root adoption');
  text(adoption.host_thread_id);
  read.bound(adoption.evidence, base);
  same(
    object(
      review.scope,
      ['project_ref', 'owner_user_id', 'target_mode', 'operation'],
      'Review scope',
    ),
    {
      project_ref: input.projectRef,
      owner_user_id: input.owner.user_id,
      target_mode: 'owner_draft',
      operation: 'insert',
    },
    'Review scope differs from the exact owner/project operation.',
  );
  const coverageReview = object(
    review.coverage,
    ['file', 'sufficiency_reason', 'limitations'],
    'Review coverage',
  );
  same(read.bound(coverageReview.file, base), coverageFile.fact, 'Review coverage file differs.');
  text(coverageReview.sufficiency_reason);
  const limitations = strings(coverageReview.limitations, 'Review limitations');
  same(
    limitations,
    coverage.limitations,
    'Review must explicitly adopt all bounded coverage limitations.',
  );
  const reviewedValidity = validity(review.validity);
  same(
    time(reviewer.reviewed_at_utc),
    reviewedValidity.reviewed_at_utc,
    'Reviewer and validity times differ.',
  );
  requireFact(
    Date.parse(coverage.observed_at_utc) <= Date.parse(reviewedValidity.reviewed_at_utc) &&
      Date.parse(time(report.generated_at_utc)) <= Date.parse(reviewedValidity.reviewed_at_utc),
    'Review cannot precede its bound coverage or preflight observation.',
  );
  const decisions = array(review.candidate_decisions, 'Candidate decisions').map((entry) => {
    const item = object(
      entry,
      ['id', 'version', 'payload_sha256', 'decision', 'reason', 'evidence'],
      'Candidate decision',
    );
    const candidate = target({
      id: item.id,
      version: item.version,
      payload_sha256: item.payload_sha256,
    });
    requireFact(
      ['distinct', 'reuse', 'not_applicable'].includes(String(item.decision)),
      'Candidate decision is unsupported.',
    );
    text(item.reason);
    for (const fact of array(item.evidence, 'Candidate evidence')) read.bound(fact, base);
    requireFact(
      !originalTargets.some(
        (originalTarget) =>
          originalTarget.id === candidate.id && originalTarget.version === candidate.version,
      ) || item.decision !== 'not_applicable',
      'Original preflight candidates cannot be excluded from identity review.',
    );
    return { ...candidate, decision: item.decision };
  });
  same(
    decisions
      .map(({ decision: _decision, ...identity }) => identity)
      .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)),
    [...snapshotTargets].sort((a, b) =>
      `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`),
    ),
    'Review must decide every complete discovered candidate exactly once.',
  );
  const reuses = decisions.filter((entry) => entry.decision === 'reuse');
  let reuseIdentity: { id: string; version: string } | null = null;
  if (review.decision === 'reuse') {
    const chosen = object(review.reuse_identity, ['id', 'version'], 'Reuse identity');
    const selectedIdentity = { id: uuid(chosen.id), version: version(chosen.version) };
    reuseIdentity = selectedIdentity;
    requireFact(
      reuses.length === 1 &&
        reuses[0]?.id === reuseIdentity.id &&
        reuses[0]?.version === reuseIdentity.version,
      'Reuse requires exactly one reviewed existing identity.',
    );
    const selectedCandidate = snapshots.find(
      (entry) => entry.id === selectedIdentity.id && entry.version === selectedIdentity.version,
    )!;
    requireFact(
      flowIdentityPayloadType(selectedCandidate.payload) === preparedTarget.flowType,
      'Reuse requires the same Flow type as the complete target.',
    );
  } else
    requireFact(
      review.reuse_identity === null && reuses.length === 0,
      'A distinct insert cannot contain a reuse verdict.',
    );
  return {
    target: preparedTarget.target,
    coverage,
    validity: reviewedValidity,
    decision: review.decision as 'create_distinct' | 'reuse',
    reuseIdentity,
    input: original.fact,
    preflight: originalReport.fact,
    review: reviewFile.fact,
    coverageFact: coverageFile.fact,
  };
}

function makeReceipt(
  evidence: Evidence,
  action: FlowIdentityAdmissionActionCore,
  account: FlowIdentityAdmissionOwner,
  projectRef: string,
): Receipt {
  return {
    schema_version: FLOW_IDENTITY_ADMISSION_SCHEMA,
    profile: FLOW_IDENTITY_ADMISSION_PROFILE,
    status: 'prepared_for_recheck',
    target: evidence.target,
    project_ref: projectRef,
    owner: account,
    action_core_sha256: flowIdentityAdmissionActionCoreSha256(action),
    input: evidence.input,
    preflight: evidence.preflight,
    review: evidence.review,
    coverage: evidence.coverageFact,
    issuer: {
      cli_version: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
      ruleset_id: RULESET,
    },
    validity: evidence.validity,
  };
}
function parseReceipt(value: unknown, base: string): Receipt {
  const item = object(
    value,
    [
      'schema_version',
      'profile',
      'status',
      'target',
      'project_ref',
      'owner',
      'action_core_sha256',
      'input',
      'preflight',
      'review',
      'coverage',
      'issuer',
      'validity',
    ],
    'Identity receipt',
  );
  requireFact(
    item.schema_version === FLOW_IDENTITY_ADMISSION_SCHEMA &&
      item.profile === FLOW_IDENTITY_ADMISSION_PROFILE &&
      item.status === 'prepared_for_recheck',
    'Identity receipt profile is unsupported.',
  );
  const issuer = object(item.issuer, ['cli_version', 'ruleset_id'], 'Receipt issuer');
  requireFact(
    /^\d+\.\d+\.\d+$/u.test(text(issuer.cli_version)) && issuer.ruleset_id === RULESET,
    'Receipt issuer ruleset is unsupported.',
  );
  return {
    schema_version: FLOW_IDENTITY_ADMISSION_SCHEMA,
    profile: FLOW_IDENTITY_ADMISSION_PROFILE,
    status: 'prepared_for_recheck',
    target: target(item.target),
    project_ref: project(item.project_ref),
    owner: owner(item.owner),
    action_core_sha256: hash(item.action_core_sha256),
    input: fileFact(item.input, base),
    preflight: fileFact(item.preflight, base),
    review: fileFact(item.review, base),
    coverage: fileFact(item.coverage, base),
    issuer: { cli_version: text(issuer.cli_version), ruleset_id: RULESET },
    validity: validity(item.validity),
  };
}
function immutableJson(file: string, value: unknown): FlowIdentityAdmissionFileFact {
  const bytes = `${stableJsonText(value)}\n`;
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.byteLength(bytes),
  };
}
export async function runFlowIdentityAdmissionPrepare(options: {
  inputPath: string;
  preflightPath: string;
  reviewPath: string;
  coveragePath: string;
  executionContractPath: string;
  outDir: string;
  now?: Date;
}) {
  const read = reader();
  const template = read.json(options.executionContractPath);
  const selected = contract(template.value, false);
  const evidence = await validateEvidence(
    {
      ...options,
      action: selected.action,
      owner: selected.owner,
      projectRef: selected.project_ref,
    },
    read,
  );
  const receipt = makeReceipt(evidence, selected.action, selected.owner, selected.project_ref);
  assertFlowIdentityAdmissionUnexpired({ receipt }, options.now);
  assertFilesCurrent([...read.files.values()]);
  const outDir = exactPath(options.outDir);
  try {
    mkdirSync(outDir, { mode: 0o700 });
  } catch {
    return fail('Admission output directory must be new and its parent must exist.');
  }
  if (evidence.decision === 'reuse') {
    const result = immutableJson(path.join(outDir, 'identity-reuse.json'), {
      schema_version: 'flow-identity-reuse.v1',
      status: 'no_new_insert',
      reuse_identity: evidence.reuseIdentity,
      review: evidence.review,
    });
    return {
      status: 'no_new_insert' as const,
      reuse_identity: evidence.reuseIdentity,
      files: { receipt: null, execution_contract: null, reuse: result.path },
      receipt_sha256: null,
      execution_contract_sha256: null,
    };
  }
  const receiptFile = immutableJson(path.join(outDir, 'identity-admission.json'), receipt);
  const value = {
    schema_version: 'dataset-save-draft-execution-contract.v2',
    profile: FLOW_IDENTITY_ADMISSION_PROFILE,
    execution_id: selected.execution_id,
    project_ref: selected.project_ref,
    target_mode: 'owner_draft',
    owner: selected.owner,
    actions: [
      {
        ...selected.action,
        identity_admission: {
          schema_version: FLOW_IDENTITY_ADMISSION_SCHEMA,
          receipt: receiptFile,
        },
      },
    ],
  };
  const contractFile = immutableJson(path.join(outDir, 'execution-contract.json'), value);
  return {
    status: 'prepared_for_recheck' as const,
    reuse_identity: null,
    files: { receipt: receiptFile.path, execution_contract: contractFile.path, reuse: null },
    receipt_sha256: receiptFile.sha256,
    execution_contract_sha256: contractFile.sha256,
  };
}

export async function loadFlowIdentityAdmission(input: {
  contractPath: string;
  contractSha256: string;
  action: FlowIdentityAdmissionAction;
  owner: FlowIdentityAdmissionOwner;
  projectRef: string;
}): Promise<LoadedFlowIdentityAdmission> {
  const read = reader();
  const contractFile = read.json(input.contractPath);
  same(
    contractFile.fact.sha256,
    hash(input.contractSha256),
    'Execution contract differs from the original host-fixed hash.',
  );
  const selected = contract(contractFile.value, true);
  same(selected.rawAction, input.action, 'Selected action differs from the fixed contract.');
  same(selected.owner, input.owner, 'Owner differs from the fixed contract.');
  same(selected.project_ref, input.projectRef, 'Project differs from the fixed contract.');
  const pin = object(
    selected.rawAction.identity_admission,
    ['schema_version', 'receipt'],
    'Identity admission pin',
  );
  requireFact(
    pin.schema_version === FLOW_IDENTITY_ADMISSION_SCHEMA,
    'Identity pin schema is unsupported.',
  );
  const receiptFile = fileFact(pin.receipt, path.dirname(contractFile.fact.path));
  const receiptRead = read.json(receiptFile.path, receiptFile);
  const receipt = parseReceipt(receiptRead.value, path.dirname(receiptFile.path));
  for (const fact of [receipt.input, receipt.preflight, receipt.review, receipt.coverage])
    read.read(fact.path, fact);
  const evidence = await validateEvidence(
    {
      inputPath: receipt.input.path,
      preflightPath: receipt.preflight.path,
      reviewPath: receipt.review.path,
      coveragePath: receipt.coverage.path,
      action: selected.action,
      owner: selected.owner,
      projectRef: selected.project_ref,
    },
    read,
  );
  requireFact(
    evidence.decision === 'create_distinct',
    'Reuse cannot authorize an insert contract.',
  );
  const expected = makeReceipt(evidence, selected.action, selected.owner, selected.project_ref);
  same(receipt, expected, 'Receipt differs from its complete bound evidence and action.');
  const loaded = {
    receipt,
    receiptFile,
    files: [...read.files.values()],
    coverage: evidence.coverage,
    action: selected.action,
    contractSha256: contractFile.fact.sha256,
  };
  assertFlowIdentityAdmissionInputsCurrent(loaded);
  return loaded;
}
function assertFilesCurrent(files: FlowIdentityAdmissionFileFact[]): void {
  const read = reader();
  for (const fact of files) read.read(fact.path, fact);
}
export function assertFlowIdentityAdmissionInputsCurrent(
  loaded: Pick<LoadedFlowIdentityAdmission, 'files'>,
): void {
  assertFilesCurrent(loaded.files);
}
export function assertFlowIdentityAdmissionUnexpired(
  loaded: { receipt: Pick<Receipt, 'validity'> },
  now: Date = new Date(),
): void {
  const selected = validity(loaded.receipt.validity);
  const instant = now.getTime();
  requireFact(
    Number.isFinite(instant) &&
      Date.parse(selected.reviewed_at_utc) <= instant &&
      instant < Date.parse(selected.expires_at_utc),
    'Identity admission is not currently valid for a new dispatch.',
  );
}
export function flowIdentityAdmissionSummary(
  loaded: LoadedFlowIdentityAdmission,
): FlowIdentityAdmissionSummary {
  return {
    schema_version: 'flow-identity-admission-summary.v1',
    profile: FLOW_IDENTITY_ADMISSION_PROFILE,
    action_core_sha256: loaded.receipt.action_core_sha256,
    contract_sha256: loaded.contractSha256,
    receipt: loaded.receiptFile,
    project_ref: loaded.receipt.project_ref,
    actor_user_id: loaded.receipt.owner.user_id,
    target: loaded.receipt.target,
    review_sha256: loaded.receipt.review.sha256,
    coverage_sha256: loaded.receipt.coverage.sha256,
  };
}
export function isFlowIdentityAdmissionSummary(
  value: unknown,
): value is FlowIdentityAdmissionSummary {
  try {
    const item = object(
      value,
      [
        'schema_version',
        'profile',
        'action_core_sha256',
        'contract_sha256',
        'receipt',
        'project_ref',
        'actor_user_id',
        'target',
        'review_sha256',
        'coverage_sha256',
      ],
      'Retained identity admission',
    );
    requireFact(
      item.schema_version === 'flow-identity-admission-summary.v1' &&
        item.profile === FLOW_IDENTITY_ADMISSION_PROFILE,
      'Retained identity admission schema is unsupported.',
    );
    hash(item.action_core_sha256);
    hash(item.contract_sha256);
    hash(item.review_sha256);
    hash(item.coverage_sha256);
    const receipt = fileFact(item.receipt, '/');
    requireFact(
      path.isAbsolute((item.receipt as JsonObject).path as string) &&
        receipt.path === (item.receipt as JsonObject).path,
      'Retained receipt path must be canonical absolute.',
    );
    project(item.project_ref);
    uuid(item.actor_user_id);
    target(item.target);
    return true;
  } catch {
    return false;
  }
}
