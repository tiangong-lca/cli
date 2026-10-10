import path from 'node:path';
import { sha256Json } from './dataset-maintenance-contract.js';
import { runAuthIdentityReceipt } from './auth-identity-receipt.js';
import { loadCliPackageVersion } from './package-version.js';
import {
  evaluateExactReference,
  parseExactReferenceSnapshot,
  type ExactReferenceConsumer,
  type ExactReferencePin,
  type ReferenceFileFact,
  type ExactReferenceObservation,
  type LoadedExactReferenceIntent,
} from './dataset-exact-reference-intent.js';
import {
  classifyCheck,
  collectRemoteReferences,
  exactReferenceObservation,
  lookupRemoteDatasetPayload,
  type RemoteDatasetLookupRequest,
  type RemoteVerificationCheck,
} from './dataset-remote-verify.js';
import type { FetchLike } from './http.js';
import type { SupabaseDataRuntime } from './supabase-client.js';

/** Observe this action's selected occurrences; each call owns a fresh, bounded read cache. */
export async function checkSaveDraftExactReferences(options: {
  intent: LoadedExactReferenceIntent;
  rows: Record<string, unknown>[];
  rowIndex: number;
  env: NodeJS.ProcessEnv;
  runtime: SupabaseDataRuntime;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<Map<string, RemoteVerificationCheck>> {
  const { intent } = options;
  await runAuthIdentityReceipt({
    env: options.env,
    fetchImpl: options.fetchImpl,
    cliVersion: loadCliPackageVersion(new URL('../cli.js', import.meta.url).href),
    expectedProjectRef: intent.project_ref,
    expectedUserId: intent.actor_user_id,
    timeoutMs: options.timeoutMs,
  });
  const cache = new Map<string, Promise<ExactReferenceObservation | null>>();
  const read = (request: RemoteDatasetLookupRequest) => {
    const key = JSON.stringify([request.table, request.id, request.version]);
    let pending = cache.get(key);
    if (!pending) {
      pending = lookupRemoteDatasetPayload({
        ...options,
        request,
        allowLatest: true,
        requireUnique: true,
      }).then((remote) => exactReferenceObservation(request, remote));
      cache.set(key, pending);
    }
    return pending;
  };
  const references = collectRemoteReferences(options.rows);
  const checks = new Map<string, RemoteVerificationCheck>();
  for (const pin of intent.references.filter((entry) => entry.row_index === options.rowIndex)) {
    // The strict loader bound each pin to exactly one current reference occurrence before auth.
    const reference = references.find(
      (entry) =>
        entry.row_index === pin.row_index && entry.role === 'reference' && entry.path === pin.path,
    )!;
    let latest: ExactReferenceObservation | null = null;
    let selected: ExactReferenceObservation | null = null;
    let lookupFailed = false;
    try {
      latest = await read({ table: pin.selected.table, id: pin.selected.id, version: null });
      selected =
        latest?.version === pin.selected.version
          ? latest
          : await read({
              table: pin.selected.table,
              id: pin.selected.id,
              version: pin.selected.version,
            });
    } catch {
      // Remote bodies/errors may contain private content. Only the bounded failure reaches reports.
      lookupFailed = true;
    }
    const check = classifyCheck(
      reference,
      {
        exact: selected,
        latest,
        exact_source_url: null,
        latest_source_url: null,
      },
      lookupFailed,
      'existing',
    );
    checks.set(
      pin.path,
      evaluateExactReference({ intent, pin, check, selected, latest, lookupFailed }),
    );
  }
  return checks;
}

export type SaveDraftReferenceAdmission = {
  schema_version: 'dataset-save-draft-reference-admission.v1';
  selection_sha256: string;
  intent_file: ReferenceFileFact;
  project_ref: string;
  actor_user_id: string;
  consumer: ExactReferenceConsumer;
  references: ExactReferencePin[];
};

/** Only persisted after every selected and default occurrence passes its current owning gate. */
export function saveDraftReferenceAdmission(
  intent: LoadedExactReferenceIntent,
  rowIndex: number,
): SaveDraftReferenceAdmission {
  return structuredClone({
    schema_version: 'dataset-save-draft-reference-admission.v1',
    selection_sha256: sha256Json(intent),
    intent_file: intent.file,
    project_ref: intent.project_ref,
    actor_user_id: intent.actor_user_id,
    consumer: intent.consumers[rowIndex]!,
    references: intent.references.filter((pin) => pin.row_index === rowIndex),
  });
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',')
  );
}
function validFile(value: unknown): boolean {
  return (
    hasKeys(value, ['path', 'sha256', 'bytes']) &&
    typeof value.path === 'string' &&
    path.isAbsolute(value.path) &&
    value.path.trim() === value.path &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) > 0 &&
    Number(value.bytes) <= 8 * 1024 * 1024
  );
}

/** Validate historical structure without opening files or reinterpreting a past remote observation. */
export function isSaveDraftReferenceAdmission(
  value: unknown,
): value is SaveDraftReferenceAdmission {
  if (
    !hasKeys(value, [
      'schema_version',
      'selection_sha256',
      'intent_file',
      'project_ref',
      'actor_user_id',
      'consumer',
      'references',
    ]) ||
    value.schema_version !== 'dataset-save-draft-reference-admission.v1' ||
    typeof value.selection_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.selection_sha256) ||
    !validFile(value.intent_file) ||
    typeof value.project_ref !== 'string' ||
    !/^[a-z0-9]{20}$/u.test(value.project_ref) ||
    typeof value.actor_user_id !== 'string' ||
    !hasKeys(value.consumer, ['row_index', 'table', 'id', 'version', 'payload_sha256']) ||
    value.consumer.table !== 'flows' ||
    !Number.isSafeInteger(value.consumer.row_index) ||
    Number(value.consumer.row_index) < 0 ||
    !Array.isArray(value.references) ||
    value.references.length > 10000
  )
    return false;
  try {
    const { row_index: rowIndex, ...consumer } = value.consumer;
    const ownerConsumer = { ...consumer, user_id: value.actor_user_id, state_code: 0 };
    if (
      sha256Json(parseExactReferenceSnapshot(ownerConsumer, value.actor_user_id)) !==
      sha256Json(ownerConsumer)
    )
      return false;
    const paths = new Set<string>();
    for (const pin of value.references) {
      if (
        !hasKeys(pin, ['row_index', 'path', 'selected', 'review']) ||
        pin.row_index !== rowIndex ||
        typeof pin.path !== 'string' ||
        !pin.path.startsWith('/') ||
        pin.path.trim() !== pin.path ||
        paths.has(pin.path) ||
        !hasKeys(pin.review, ['file', 'latest']) ||
        !validFile(pin.review.file)
      )
        return false;
      paths.add(pin.path);
      const selected = parseExactReferenceSnapshot(pin.selected, value.actor_user_id);
      const latest = parseExactReferenceSnapshot(pin.review.latest, value.actor_user_id);
      if (
        sha256Json(selected) !== sha256Json(pin.selected) ||
        sha256Json(latest) !== sha256Json(pin.review.latest) ||
        selected.table !== latest.table ||
        selected.id !== latest.id ||
        selected.version > latest.version ||
        (selected.version === latest.version && sha256Json(selected) !== sha256Json(latest))
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
