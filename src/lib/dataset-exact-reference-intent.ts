import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from './errors.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import type {
  RemoteDatasetReference,
  RemoteDatasetTable,
  RemoteVerificationCheck,
} from './dataset-remote-verify.js';

type RecordValue = Record<string, unknown>;
export type ReferenceFileFact = { path: string; sha256: string; bytes: number };
export type ExactReferenceConsumer = {
  row_index: number;
  table: RemoteDatasetTable;
  id: string;
  version: string;
  payload_sha256: string;
};
export type ExactReferenceSnapshot = {
  table: RemoteDatasetTable;
  id: string;
  version: string;
  payload_sha256: string;
  user_id: string;
  state_code: 0 | 100;
};
export type ExactReferenceObservation = {
  id: string;
  version: string | null;
  payload_sha256: string | null;
  user_id: string | null;
  state_code: number | null;
};
export type ExactReferencePin = {
  row_index: number;
  path: string;
  selected: ExactReferenceSnapshot;
  review: { file: ReferenceFileFact; latest: ExactReferenceSnapshot };
};
export type LoadedExactReferenceIntent = {
  file: ReferenceFileFact;
  project_ref: string;
  actor_user_id: string;
  consumers: ExactReferenceConsumer[];
  references: ExactReferencePin[];
  review_files: ReferenceFileFact[];
};
export type ExactReferenceCheckEvidence = {
  intent_sha256: string;
  review_sha256: string;
  applied: boolean;
  original_status: string;
  selected: ExactReferenceObservation | null;
  latest: ExactReferenceObservation | null;
  failure: string | null;
};
const tables = new Set([
  'contacts',
  'flowproperties',
  'flows',
  'lciamethods',
  'lifecyclemodels',
  'processes',
  'sources',
  'unitgroups',
]);
function requireIntent(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new CliError(message, { code: 'DATASET_REFERENCE_INTENT_INVALID', exitCode: 2 });
}
function record(value: unknown, keys: readonly string[]): RecordValue {
  requireIntent(
    value && typeof value === 'object' && !Array.isArray(value),
    'Reference intent and review fields must be objects.',
  );
  requireIntent(
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    'Reference intent or review contains missing or unsupported fields.',
  );
  return value as RecordValue;
}
function text(value: unknown): string {
  requireIntent(
    typeof value === 'string' && value.trim() && value.length <= 4096 && !/[\0\r\n]/u.test(value),
    'Reference intent requires bounded non-empty string fields.',
  );
  return value.trim();
}
function exactLocator(value: unknown): string {
  const result = text(value);
  requireIntent(
    result === value,
    'Reference file and occurrence paths must retain exact spelling without edge whitespace.',
  );
  return result;
}
function uuid(value: unknown): string {
  const result = text(value).toLowerCase();
  requireIntent(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(result),
    'Reference intent UUID is invalid.',
  );
  return result;
}
function hash(value: unknown): string {
  const result = text(value);
  requireIntent(/^[a-f0-9]{64}$/u.test(result), 'Reference intent SHA-256 is invalid.');
  return result;
}
function version(value: unknown): string {
  const result = text(value);
  requireIntent(
    /^\d{2}\.\d{2}\.\d{3}$/u.test(result),
    'Reference intent requires an exact canonical dataset version.',
  );
  return result;
}
function table(value: unknown): RemoteDatasetTable {
  const result = text(value);
  requireIntent(tables.has(result), 'Reference intent table is unsupported.');
  return result as RemoteDatasetTable;
}
function snapshot(value: unknown, actor: string): ExactReferenceSnapshot {
  const data = record(value, ['table', 'id', 'version', 'payload_sha256', 'user_id', 'state_code']);
  const owner = uuid(data.user_id);
  requireIntent(
    data.state_code === 100 || (data.state_code === 0 && owner === actor),
    'Exact references require public state 100 or the authenticated owner draft state 0.',
  );
  return {
    table: table(data.table),
    id: uuid(data.id),
    version: version(data.version),
    payload_sha256: hash(data.payload_sha256),
    user_id: owner,
    state_code: data.state_code,
  };
}
function fileReader() {
  const cached = new Map<string, { fact: ReferenceFileFact; value: unknown }>();
  let total = 0;
  return (selected: string) => {
    const file = path.resolve(selected);
    const prior = cached.get(file);
    if (prior) return prior;
    try {
      const stat = fs.lstatSync(file);
      requireIntent(
        stat.isFile() && stat.size <= 8 * 1024 * 1024,
        'Reference files must be bounded regular files.',
      );
      const bytes = fs.readFileSync(file);
      total += bytes.length;
      requireIntent(
        bytes.length <= 8 * 1024 * 1024 && total <= 64 * 1024 * 1024,
        'Reference selection exceeds its content budget.',
      );
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const result = {
        fact: {
          path: file,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        },
        value,
      };
      cached.set(file, result);
      return result;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('Selected reference intent or review must be readable UTF-8 JSON.', {
        code: 'DATASET_REFERENCE_INTENT_INVALID',
        exitCode: 2,
      });
    }
  };
}

export function loadExactReferenceIntent(input: {
  file: unknown;
  consumers: readonly ExactReferenceConsumer[];
  references: readonly RemoteDatasetReference[];
}): LoadedExactReferenceIntent {
  const read = fileReader();
  const selected = read(exactLocator(input.file));
  const data = record(selected.value, [
    'schema_version',
    'project_ref',
    'actor_user_id',
    'consumers',
    'references',
  ]);
  requireIntent(
    data.schema_version === 'dataset-exact-reference-intent.v1',
    'Reference intent schema is unsupported.',
  );
  const project = text(data.project_ref),
    actor = uuid(data.actor_user_id);
  requireIntent(/^[a-z0-9]{20}$/u.test(project), 'Reference intent project is invalid.');
  requireIntent(
    Array.isArray(data.consumers) &&
      data.consumers.length > 0 &&
      data.consumers.length === input.consumers.length,
    'Reference intent must bind every current consumer exactly once.',
  );
  const consumers = data.consumers.map((value, index) => {
    const item = record(value, ['row_index', 'table', 'id', 'version', 'payload_sha256']);
    requireIntent(
      item.row_index === index,
      'Consumer rows must preserve their exact ordered indices.',
    );
    return {
      row_index: index,
      table: table(item.table),
      id: uuid(item.id),
      version: version(item.version),
      payload_sha256: hash(item.payload_sha256),
    };
  });
  requireIntent(
    sha256Json(consumers) === sha256Json(input.consumers),
    'Reference intent consumer identity, order or payload changed.',
  );
  requireIntent(
    Array.isArray(data.references) && data.references.length > 0 && data.references.length <= 10000,
    'Reference intent needs bounded explicit reference occurrences.',
  );
  const used = new Set<string>(),
    reviews = new Map<string, ReferenceFileFact>();
  const references = data.references.map((value) => {
    const item = record(value, ['row_index', 'path', 'selected', 'review']);
    requireIntent(
      Number.isInteger(item.row_index) &&
        Number(item.row_index) >= 0 &&
        Number(item.row_index) < consumers.length,
      'Reference occurrence row index is invalid.',
    );
    const rowIndex = Number(item.row_index),
      pointer = exactLocator(item.path),
      target = snapshot(item.selected, actor);
    const key = `${rowIndex}:${pointer}`;
    requireIntent(
      pointer.startsWith('/') && !used.has(key),
      'Reference occurrences must be unique exact JSON pointer paths.',
    );
    const matches = input.references.filter(
      (ref) =>
        ref.row_index === rowIndex &&
        ref.role === 'reference' &&
        ref.path === pointer &&
        ref.table === target.table &&
        ref.id?.toLowerCase() === target.id &&
        ref.version === target.version,
    );
    requireIntent(
      matches.length === 1,
      'Reference intent names a root, changed, ambiguous or unused occurrence.',
    );
    used.add(key);
    const reviewInput = record(item.review, ['file', 'sha256']);
    const review = read(
      path.resolve(path.dirname(selected.fact.path), exactLocator(reviewInput.file)),
    );
    requireIntent(
      review.fact.sha256 === hash(reviewInput.sha256),
      'Selected reference review bytes changed.',
    );
    const content = record(review.value, [
      'schema_version',
      'decision',
      'reason',
      'selected',
      'latest',
    ]);
    requireIntent(
      content.schema_version === 'dataset-exact-reference-review.v1' &&
        content.decision === 'use_selected_exact',
      'Reference review must explicitly retain the selected definition.',
    );
    requireIntent(
      typeof content.reason === 'string' && content.reason.trim() && content.reason.length <= 8192,
      'Reference review needs a bounded explicit reason.',
    );
    const reviewed = snapshot(content.selected, actor),
      latest = snapshot(content.latest, actor);
    requireIntent(
      sha256Json(reviewed) === sha256Json(target) &&
        latest.table === target.table &&
        latest.id === target.id &&
        latest.version >= target.version,
      'Review does not bind the selected definition and a consistent latest identity.',
    );
    requireIntent(
      latest.version !== target.version || sha256Json(latest) === sha256Json(target),
      'One reviewed version cannot declare conflicting content or ownership.',
    );
    reviews.set(review.fact.path, review.fact);
    return {
      row_index: rowIndex,
      path: pointer,
      selected: target,
      review: { file: review.fact, latest },
    };
  });
  return {
    file: selected.fact,
    project_ref: project,
    actor_user_id: actor,
    consumers,
    references,
    review_files: [...reviews.values()],
  };
}

function matchesSnapshot(
  expected: ExactReferenceSnapshot,
  observed: ExactReferenceObservation | null,
): boolean {
  return Boolean(
    observed &&
    observed.id.toLowerCase() === expected.id &&
    observed.version === expected.version &&
    observed.payload_sha256 === expected.payload_sha256 &&
    observed.user_id?.toLowerCase() === expected.user_id &&
    observed.state_code === expected.state_code,
  );
}

export function evaluateExactReference(input: {
  intent: LoadedExactReferenceIntent;
  pin: ExactReferencePin;
  check: RemoteVerificationCheck;
  selected: ExactReferenceObservation | null;
  latest: ExactReferenceObservation | null;
  lookupFailed?: boolean;
}): RemoteVerificationCheck {
  const eligible = input.check.status === 'ok' || input.check.status === 'version_outdated';
  const failure = !eligible
    ? 'base_check_blocked'
    : input.lookupFailed
      ? 'payload_lookup_failed'
      : !matchesSnapshot(input.pin.selected, input.selected)
        ? 'selected_snapshot_mismatch'
        : !matchesSnapshot(input.pin.review.latest, input.latest)
          ? 'latest_review_changed'
          : null;
  return {
    ...input.check,
    status: !eligible ? input.check.status : failure ? 'reference_intent_mismatch' : 'ok',
    latest_version: input.latest?.version ?? input.check.latest_version,
    message: failure
      ? 'Explicit exact-reference evidence is incomplete or changed; the occurrence remains blocked.'
      : 'The exact reviewed reference and current visible latest definition match the bound intent.',
    reference_intent: {
      intent_sha256: input.intent.file.sha256,
      review_sha256: input.pin.review.file.sha256,
      applied: failure === null,
      original_status: input.check.status,
      selected: input.selected,
      latest: input.latest,
      failure,
    },
  };
}

export function assertExactReferenceInputsCurrent(
  intent: LoadedExactReferenceIntent,
  consumers: readonly ExactReferenceConsumer[],
): void {
  requireIntent(
    sha256Json(consumers) === sha256Json(intent.consumers),
    'Reference intent consumer content changed during verification.',
  );
  const read = fileReader();
  for (const expected of [intent.file, ...intent.review_files]) {
    const current = read(expected.path).fact;
    requireIntent(
      current.sha256 === expected.sha256 && current.bytes === expected.bytes,
      'Reference intent or review content changed during verification.',
    );
  }
}

// Reuse the exact same snapshot eligibility when validating retained owner-admission evidence.
export { snapshot as parseExactReferenceSnapshot };
