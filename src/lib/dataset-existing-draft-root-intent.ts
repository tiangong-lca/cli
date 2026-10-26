import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from './errors.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import type {
  ExactReferenceConsumer,
  ReferenceFileFact,
} from './dataset-exact-reference-intent.js';
import type { RemoteDatasetReference } from './dataset-remote-verify.js';

type RecordValue = Record<string, unknown>;
export type ExistingDraftRootSnapshot = {
  table: 'processes';
  id: string;
  version: string;
  user_id: string;
  state_code: 0 | 100;
  payload_sha256: string;
  row_sha256: string;
};
export type LoadedExistingDraftRootIntent = {
  file: ReferenceFileFact;
  project_ref: string;
  actor_user_id: string;
  candidate: ExactReferenceConsumer;
  selection: {
    strategy: 'sole_current_owner_draft';
    drafts: [ExistingDraftRootSnapshot];
    reviews: [];
    published_baseline: ExistingDraftRootSnapshot;
  };
  review_file: ReferenceFileFact;
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;
function requireIntent(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new CliError(message, { code: 'DATASET_EXISTING_DRAFT_ROOT_INVALID', exitCode: 2 });
}
function record(value: unknown, keys: readonly string[]): RecordValue {
  requireIntent(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Existing-draft root intent and review fields must be objects.',
  );
  const actual = Object.keys(value);
  requireIntent(
    actual.length === keys.length && actual.every((key) => keys.includes(key)),
    'Existing-draft root intent or review contains missing or unsupported fields.',
  );
  return value as RecordValue;
}
function text(value: unknown): string {
  requireIntent(
    typeof value === 'string' && value.trim() && value.length <= 4096 && !/[\0\r\n]/u.test(value),
    'Existing-draft root intent requires bounded non-empty string fields.',
  );
  return value.trim();
}
function locator(value: unknown): string {
  const result = text(value);
  requireIntent(result === value, 'Selected file paths must preserve their exact spelling.');
  return result;
}
function uuid(value: unknown): string {
  const result = text(value).toLowerCase();
  requireIntent(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(result),
    'Existing-draft root intent UUID is invalid.',
  );
  return result;
}
function hash(value: unknown): string {
  const result = text(value);
  requireIntent(/^[a-f0-9]{64}$/u.test(result), 'Existing-draft root intent SHA-256 is invalid.');
  return result;
}
function version(value: unknown): string {
  const result = text(value);
  requireIntent(
    /^\d{2}\.\d{2}\.\d{3}$/u.test(result),
    'Existing-draft root intent requires an exact canonical dataset version.',
  );
  return result;
}
function candidate(value: unknown): ExactReferenceConsumer {
  const data = record(value, ['row_index', 'table', 'id', 'version', 'payload_sha256']);
  requireIntent(
    data.row_index === 0 && data.table === 'processes',
    'Existing-draft root qualification supports one Process candidate at row zero only.',
  );
  return {
    row_index: 0,
    table: 'processes',
    id: uuid(data.id),
    version: version(data.version),
    payload_sha256: hash(data.payload_sha256),
  };
}
function snapshot(value: unknown): ExistingDraftRootSnapshot {
  const data = record(value, [
    'table',
    'id',
    'version',
    'user_id',
    'state_code',
    'payload_sha256',
    'row_sha256',
  ]);
  requireIntent(
    data.table === 'processes' && (data.state_code === 0 || data.state_code === 100),
    'Existing-draft root snapshots require Process draft state 0 or public state 100.',
  );
  return {
    table: 'processes',
    id: uuid(data.id),
    version: version(data.version),
    user_id: uuid(data.user_id),
    state_code: data.state_code,
    payload_sha256: hash(data.payload_sha256),
    row_sha256: hash(data.row_sha256),
  };
}
function readFile(selected: string): { fact: ReferenceFileFact; value: unknown } {
  const file = path.resolve(selected);
  try {
    const stat = fs.lstatSync(file);
    requireIntent(
      stat.isFile() && stat.size <= MAX_FILE_BYTES,
      'Existing-draft root files must be bounded regular files.',
    );
    const bytes = fs.readFileSync(file);
    requireIntent(
      bytes.length <= MAX_FILE_BYTES,
      'Existing-draft root file exceeds its content budget.',
    );
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return {
      fact: {
        path: file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      },
      value,
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Selected existing-draft root files must be readable UTF-8 JSON.', {
      code: 'DATASET_EXISTING_DRAFT_ROOT_INVALID',
      exitCode: 2,
    });
  }
}
export function loadExistingDraftRootIntent(input: {
  file: unknown;
  consumers: readonly ExactReferenceConsumer[];
  references: readonly RemoteDatasetReference[];
}): LoadedExistingDraftRootIntent {
  const selected = readFile(locator(input.file));
  const data = record(selected.value, [
    'schema_version',
    'project_ref',
    'actor_user_id',
    'candidate',
    'selection',
    'review',
  ]);
  requireIntent(
    data.schema_version === 'dataset-existing-draft-root.v1',
    'Existing-draft root schema is unsupported.',
  );
  const project = text(data.project_ref),
    actor = uuid(data.actor_user_id);
  requireIntent(/^[a-z0-9]{20}$/u.test(project), 'Existing-draft root project is invalid.');
  const consumer = candidate(data.candidate);
  requireIntent(
    input.consumers.length === 1 && sha256Json(input.consumers[0]) === sha256Json(consumer),
    'Existing-draft root candidate identity or complete content differs from the current input.',
  );
  const roots = input.references.filter((ref) => ref.role === 'root');
  requireIntent(
    roots.length === 1 &&
      roots[0]!.row_index === 0 &&
      roots[0]!.table === 'processes' &&
      roots[0]!.id?.toLowerCase() === consumer.id &&
      roots[0]!.version === consumer.version,
    'Existing-draft root intent requires exactly one matching typed current root.',
  );
  const selection = record(data.selection, ['strategy', 'drafts', 'reviews', 'published_baseline']);
  requireIntent(
    selection.strategy === 'sole_current_owner_draft' &&
      Array.isArray(selection.drafts) &&
      selection.drafts.length === 1 &&
      Array.isArray(selection.reviews) &&
      selection.reviews.length === 0,
    'Existing-draft root selection requires one sole draft and no current review points.',
  );
  const draft = snapshot(selection.drafts[0]),
    baseline = snapshot(selection.published_baseline);
  requireIntent(
    draft.id === consumer.id &&
      draft.version === consumer.version &&
      draft.user_id === actor &&
      draft.state_code === 0,
    'Selected root must be the exact current-actor state-0 draft candidate identity.',
  );
  requireIntent(
    baseline.id === consumer.id && baseline.state_code === 100 && baseline.version > draft.version,
    'Existing-draft root qualification requires a strictly newer public baseline of the same typed UUID.',
  );
  const reviewInput = record(data.review, ['file', 'sha256']);
  const review = readFile(
    path.resolve(path.dirname(selected.fact.path), locator(reviewInput.file)),
  );
  requireIntent(
    review.fact.sha256 === hash(reviewInput.sha256),
    'Selected existing-draft root review bytes changed.',
  );
  const content = record(review.value, [
    'schema_version',
    'decision',
    'reason',
    'candidate',
    'selected',
    'published_baseline',
  ]);
  requireIntent(
    content.schema_version === 'dataset-existing-draft-root-review.v1' &&
      content.decision === 'revise_selected_draft',
    'Existing-draft root review must explicitly decide to revise the selected draft.',
  );
  requireIntent(
    typeof content.reason === 'string' && content.reason.trim() && content.reason.length <= 8192,
    'Existing-draft root review requires a bounded non-empty compatibility reason.',
  );
  requireIntent(
    sha256Json(candidate(content.candidate)) === sha256Json(consumer) &&
      sha256Json(snapshot(content.selected)) === sha256Json(draft) &&
      sha256Json(snapshot(content.published_baseline)) === sha256Json(baseline),
    'Compatibility review does not bind the complete candidate, selected draft and public baseline.',
  );
  return {
    file: selected.fact,
    project_ref: project,
    actor_user_id: actor,
    candidate: consumer,
    selection: {
      strategy: 'sole_current_owner_draft',
      drafts: [draft],
      reviews: [],
      published_baseline: baseline,
    },
    review_file: review.fact,
  };
}
export function assertExistingDraftRootInputsCurrent(
  intent: LoadedExistingDraftRootIntent,
  consumers: readonly ExactReferenceConsumer[],
): void {
  requireIntent(
    consumers.length === 1 && sha256Json(consumers[0]) === sha256Json(intent.candidate),
    'Existing-draft root candidate content changed during verification.',
  );
  for (const expected of [intent.file, intent.review_file]) {
    const current = readFile(expected.path).fact;
    requireIntent(
      current.sha256 === expected.sha256 && current.bytes === expected.bytes,
      'Existing-draft root intent or review bytes changed during verification.',
    );
  }
}
