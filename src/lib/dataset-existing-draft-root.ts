import { sha256Json } from './dataset-maintenance-contract.js';
import { isDatasetMaintenanceSnapshotCompleteness } from './dataset-maintenance-pagination.js';
import type { LoadedExistingDraftRootIntent } from './dataset-existing-draft-root-intent.js';
import type { ExistingDraftRootObservation } from './dataset-existing-draft-root-remote.js';
import type { RemoteVerificationCheck } from './dataset-remote-verify.js';

export type ExistingDraftRootCheckEvidence = {
  intent_sha256: string;
  review_sha256: string;
  applied: boolean;
  read_only: true;
  save_ready: false;
  original_status: string;
  initial: ExistingDraftRootObservation | null;
  rechecked: ExistingDraftRootObservation | null;
  failure: string | null;
};

function matchesSelection(
  intent: LoadedExistingDraftRootIntent,
  observation: ExistingDraftRootObservation | null,
): boolean {
  return Boolean(
    observation &&
    isDatasetMaintenanceSnapshotCompleteness(observation.completeness, ['drafts', 'reviews']) &&
    observation.completeness.entity_counts.drafts === 1 &&
    observation.completeness.entity_counts.reviews === 0 &&
    observation.reviews.length === 0 &&
    sha256Json(observation.drafts) === sha256Json(intent.selection.drafts) &&
    sha256Json(observation.selected) === sha256Json(intent.selection.drafts[0]) &&
    sha256Json(observation.published_baseline) === sha256Json(intent.selection.published_baseline),
  );
}

/** This observation only qualifies the selected existing root, never a write or reference. */
export function evaluateExistingDraftRoot(input: {
  intent: LoadedExistingDraftRootIntent;
  check: RemoteVerificationCheck;
  initial: ExistingDraftRootObservation | null;
  rechecked: ExistingDraftRootObservation | null;
  lookupFailed: boolean;
}): RemoteVerificationCheck {
  const { intent, check } = input;
  const eligible =
    check.role === 'root' &&
    check.row_index === intent.candidate.row_index &&
    check.path === '/processDataSet' &&
    check.table === intent.candidate.table &&
    check.id?.toLowerCase() === intent.candidate.id &&
    check.version === intent.candidate.version &&
    check.exact_version === intent.candidate.version &&
    (check.status === 'ok' || check.status === 'version_outdated');
  const failure = !eligible
    ? 'base_check_blocked'
    : input.lookupFailed
      ? 'observation_failed'
      : !matchesSelection(intent, input.initial)
        ? 'initial_selection_mismatch'
        : !matchesSelection(intent, input.rechecked)
          ? 'selection_changed'
          : null;
  return {
    ...check,
    status: failure ? 'existing_draft_root_mismatch' : 'ok',
    message: failure
      ? 'Existing-draft root qualification is incomplete or changed; the selected root remains blocked.'
      : 'The existing owner draft, complete selection, candidate and reviewed public baseline match fresh read-only observations.',
    existing_draft_root: {
      intent_sha256: intent.file.sha256,
      review_sha256: intent.review_file.sha256,
      applied: failure === null,
      read_only: true,
      save_ready: false,
      original_status: check.status,
      initial: input.initial,
      rechecked: input.rechecked,
      failure,
    },
  };
}
