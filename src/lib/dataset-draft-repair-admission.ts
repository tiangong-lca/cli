// Narrow admission policy for repairing an existing owner Process draft whose only remaining
// authoring gap is the unknown annual volume. This module owns the policy; the execution-contract
// runner only decides when a candidate may enter it (bounded save_draft) and always re-derives the
// decision from the fresh before image it just read.

type JsonObject = Record<string, unknown>;

export const DRAFT_REPAIR_ADMISSION_SCHEMA = 'dataset-draft-repair-admission.v1';
export const DRAFT_REPAIR_POLICY = 'process-metadata-unknown-annual.v1';
export const ANNUAL_SUPPLY_AUTHORING_CODE = 'annual_supply_or_production_volume_missing';

export const DRAFT_REPAIR_ANNUAL_NOT_UNKNOWN = 'draft_repair_annual_volume_not_unknown';
export const DRAFT_REPAIR_BEFORE_NOT_ELIGIBLE = 'draft_repair_before_not_eligible';
export const DRAFT_REPAIR_TEXT_REQUIRES_CONTENT = 'draft_repair_text_requires_content';
export const DRAFT_REPAIR_DIFF_NOT_ALLOWED = 'draft_repair_diff_not_allowed';
export const DRAFT_REPAIR_REQUIRES_CHANGE = 'draft_repair_requires_change';

export type DraftRepairAdmission = {
  schema: typeof DRAFT_REPAIR_ADMISSION_SCHEMA;
  status: 'admitted';
  policy: typeof DRAFT_REPAIR_POLICY;
  before_sha256: string;
  desired_sha256: string;
  changed_paths: string[];
  publication_ready: false;
};

export type DraftRepairRejection = {
  status: 'rejected';
  code: string;
  message: string;
  details: JsonObject;
};

export type DraftRepairAdmissionOutcome =
  { status: 'admitted'; admission: DraftRepairAdmission } | DraftRepairRejection;

type RepairValidationIssue = { code: string };
type RepairValidationLayer = { status: 'passed' | 'failed'; issues: RepairValidationIssue[] };
type RepairValidationLayers = {
  schema: RepairValidationLayer;
  authoring_evidence: RepairValidationLayer;
  content: RepairValidationLayer;
  multilingual: RepairValidationLayer;
};

// The only delta this policy may admit: an existing language node's text at one of the two
// reviewed reference short descriptions. Everything else — names, amounts, units, exchanges,
// geography, classification, reference identities and shapes — must stay byte-identical.
const ALLOWED_REPAIR_TEXT_TAILS: readonly (readonly string[])[] = [
  [
    'processDataSet',
    'modellingAndValidation',
    'dataSourcesTreatmentAndRepresentativeness',
    'referenceToDataSource',
    'common:shortDescription',
    '#text',
  ],
  [
    'processDataSet',
    'administrativeInformation',
    'publicationAndOwnership',
    'common:referenceToOwnershipOfDataSet',
    'common:shortDescription',
    '#text',
  ],
];

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nodeAt(payload: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    payload,
  );
}

function annualVolumeOf(payload: unknown): unknown {
  return nodeAt(payload, [
    'processDataSet',
    'modellingAndValidation',
    'dataSourcesTreatmentAndRepresentativeness',
    'annualSupplyOrProductionVolume',
  ]);
}

function isUnknownAnnualArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function renderRepairPath(segments: readonly (string | number)[]): string {
  let text = '';
  for (const segment of segments) {
    text += typeof segment === 'number' ? `[${segment}]` : text ? `.${segment}` : segment;
  }
  return text;
}

function isAllowedRepairTextLeaf(segments: readonly (string | number)[]): boolean {
  const names = segments.filter((segment): segment is string => typeof segment === 'string');
  return ALLOWED_REPAIR_TEXT_TAILS.some(
    (tail) =>
      tail.length === names.length && tail.every((segment, index) => segment === names[index]),
  );
}

function walkRepairDiff(
  before: unknown,
  candidate: unknown,
  segments: Array<string | number>,
  result: {
    changed: Array<{ path: string; beforeText: string; afterText: string }>;
    violations: string[];
  },
): void {
  if (Array.isArray(before) || Array.isArray(candidate)) {
    if (!Array.isArray(before) || !Array.isArray(candidate) || before.length !== candidate.length) {
      result.violations.push(renderRepairPath(segments));
      return;
    }
    before.forEach((entry, index) =>
      walkRepairDiff(entry, candidate[index], [...segments, index], result),
    );
    return;
  }
  if (isRecord(before) || isRecord(candidate)) {
    if (!isRecord(before) || !isRecord(candidate)) {
      result.violations.push(renderRepairPath(segments));
      return;
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(candidate)]);
    for (const key of keys) {
      if (!Object.hasOwn(before, key) || !Object.hasOwn(candidate, key)) {
        result.violations.push(renderRepairPath([...segments, key]));
        continue;
      }
      walkRepairDiff(before[key], candidate[key], [...segments, key], result);
    }
    return;
  }
  if (before === candidate) {
    return;
  }
  if (
    isAllowedRepairTextLeaf(segments) &&
    typeof before === 'string' &&
    typeof candidate === 'string'
  ) {
    result.changed.push({
      path: renderRepairPath(segments),
      beforeText: before,
      afterText: candidate,
    });
    return;
  }
  result.violations.push(renderRepairPath(segments));
}

/**
 * Local eligibility: only a bounded contract save_draft of an existing Process draft whose sole
 * validation failure is the annual evidence gap may enter the post-read admission.
 */
export type RepairValidationResult = {
  ok: boolean;
  validation_layers?: RepairValidationLayers;
} | null;

/** Schema, content and multilingual must pass while the annual evidence gap is the only authoring issue. */
function hasOnlyAnnualAuthoringGap(validation: RepairValidationResult): boolean {
  const layers = validation?.validation_layers;
  if (validation?.ok !== false || !layers) {
    return false;
  }
  if (
    layers.schema.status !== 'passed' ||
    layers.content.status !== 'passed' ||
    layers.multilingual.status !== 'passed' ||
    layers.authoring_evidence.status !== 'failed'
  ) {
    return false;
  }
  return (
    layers.authoring_evidence.issues.length > 0 &&
    layers.authoring_evidence.issues.every((issue) => issue.code === ANNUAL_SUPPLY_AUTHORING_CODE)
  );
}

export function isProcessMetadataRepairCandidate(options: {
  operation: string;
  table: string;
  validation: RepairValidationResult;
}): boolean {
  if (options.operation !== 'save_draft' || options.table !== 'processes') {
    return false;
  }
  return hasOnlyAnnualAuthoringGap(options.validation);
}

/** Content-bound admission decision against the fresh before image and the exact candidate. */
export function evaluateProcessMetadataRepairAdmission(options: {
  before: unknown;
  candidate: unknown;
  beforeValidation: RepairValidationResult;
  beforeSha256: string;
  desiredSha256: string;
}): DraftRepairAdmissionOutcome {
  if (!hasOnlyAnnualAuthoringGap(options.beforeValidation)) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_BEFORE_NOT_ELIGIBLE,
      message:
        'Draft metadata repair is not admitted: the stored draft itself must pass schema, content and multilingual validation with the annual evidence gap as its only authoring issue.',
      details: {},
    };
  }
  if (
    !isUnknownAnnualArray(annualVolumeOf(options.before)) ||
    !isUnknownAnnualArray(annualVolumeOf(options.candidate))
  ) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_ANNUAL_NOT_UNKNOWN,
      message:
        'Draft metadata repair is not admitted: the stored and candidate annualSupplyOrProductionVolume must both stay the unchanged empty array.',
      details: {},
    };
  }
  const result: {
    changed: Array<{ path: string; beforeText: string; afterText: string }>;
    violations: string[];
  } = { changed: [], violations: [] };
  walkRepairDiff(options.before, options.candidate, [], result);
  if (result.violations.length > 0) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_DIFF_NOT_ALLOWED,
      message:
        'Draft metadata repair is not admitted: the candidate changes content outside the reviewed reference short descriptions.',
      details: { violations: result.violations },
    };
  }
  if (result.changed.length === 0) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_REQUIRES_CHANGE,
      message: 'Draft metadata repair is not admitted: the candidate carries no real change.',
      details: { changed_paths: [] },
    };
  }
  if (
    result.changed.some((leaf) => leaf.beforeText.trim() === '' || leaf.afterText.trim() === '')
  ) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_TEXT_REQUIRES_CONTENT,
      message:
        'Draft metadata repair is not admitted: it may not create or clear a reference description.',
      details: { changed_paths: result.changed.map((leaf) => leaf.path) },
    };
  }
  if (!result.changed.some((leaf) => leaf.beforeText.trim() !== leaf.afterText.trim())) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_REQUIRES_CHANGE,
      message: 'Draft metadata repair is not admitted: the candidate carries no meaningful change.',
      details: { changed_paths: result.changed.map((leaf) => leaf.path) },
    };
  }
  return {
    status: 'admitted',
    admission: {
      schema: DRAFT_REPAIR_ADMISSION_SCHEMA,
      status: 'admitted',
      policy: DRAFT_REPAIR_POLICY,
      before_sha256: options.beforeSha256,
      desired_sha256: options.desiredSha256,
      changed_paths: result.changed.map((leaf) => leaf.path),
      publication_ready: false,
    },
  };
}
