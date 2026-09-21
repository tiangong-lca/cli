// Narrow admission policies for repairing the metadata of one existing owner draft. This module
// owns the policies; the execution-contract runner only decides when a candidate may enter them
// (bounded save_draft) and always re-derives the decision from the fresh before image it just read.
//
// Two reviewed policies share the same artifact and the same "all other content must stay
// byte-identical" walker:
//   - Process annual evidence gap: the stored draft itself fails only the annual authoring rule,
//     so the admitted write carries no platform rule-verification flag.
//   - Unit Group / Flow Property reference metadata: both sides are fully valid and only an existing
//     ownership/source reference display text may change, so the ordinary rule-verification flag and
//     the ordinary reference-only support policy stay untouched everywhere else.

type JsonObject = Record<string, unknown>;

export const DRAFT_REPAIR_ADMISSION_SCHEMA = 'dataset-draft-repair-admission.v1';
export const DRAFT_REPAIR_POLICY = 'process-metadata-unknown-annual.v1';
export const SUPPORT_REPAIR_POLICY = 'support-reference-metadata.v1';
export const ANNUAL_SUPPLY_AUTHORING_CODE = 'annual_supply_or_production_volume_missing';

export const DRAFT_REPAIR_ANNUAL_NOT_UNKNOWN = 'draft_repair_annual_volume_not_unknown';
export const DRAFT_REPAIR_BEFORE_NOT_ELIGIBLE = 'draft_repair_before_not_eligible';
export const DRAFT_REPAIR_BEFORE_NOT_VALID = 'draft_repair_before_not_valid';
export const DRAFT_REPAIR_CANDIDATE_NOT_VALID = 'draft_repair_candidate_not_valid';
export const DRAFT_REPAIR_TABLE_NOT_ADMITTED = 'draft_repair_table_not_admitted';
export const DRAFT_REPAIR_TEXT_REQUIRES_CONTENT = 'draft_repair_text_requires_content';
export const DRAFT_REPAIR_DIFF_NOT_ALLOWED = 'draft_repair_diff_not_allowed';
export const DRAFT_REPAIR_REQUIRES_CHANGE = 'draft_repair_requires_change';

export type DraftRepairAdmission = {
  schema: typeof DRAFT_REPAIR_ADMISSION_SCHEMA;
  status: 'admitted';
  policy: typeof DRAFT_REPAIR_POLICY | typeof SUPPORT_REPAIR_POLICY;
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

export type RepairValidationIssue = { code: string };
export type RepairValidationLayer = {
  issues: RepairValidationIssue[];
  status: 'passed' | 'failed';
};
export type RepairValidationLayers = {
  schema: RepairValidationLayer;
  authoring_evidence: RepairValidationLayer;
  content: RepairValidationLayer;
  multilingual: RepairValidationLayer;
};

// The only delta the Process policy may admit: an existing language node's text at one of the two
// reviewed reference short descriptions. Everything else — names, amounts, units, exchanges,
// geography, classification, reference identities and shapes — must stay byte-identical.
const PROCESS_REPAIR_TEXT_TAILS: readonly (readonly string[])[] = [
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

// Unit Group / Flow Property rows are reference-only support data. The reviewed repair admits one
// existing language text of the row's own ownership or source reference and nothing else; the
// reference ids/versions/URIs, the unit and conversion-factor content, the reference property and
// the dataset identity/version stay exactly as stored.
const SUPPORT_REPAIR_ROOTS = new Map<string, string>([
  ['flowproperties', 'flowPropertyDataSet'],
  ['unitgroups', 'unitGroupDataSet'],
]);

function supportRepairTextTails(root: string): readonly (readonly string[])[] {
  return [
    [
      root,
      'administrativeInformation',
      'publicationAndOwnership',
      'common:referenceToOwnershipOfDataSet',
      'common:shortDescription',
      '#text',
    ],
    [
      root,
      'modellingAndValidation',
      'dataSourcesTreatmentAndRepresentativeness',
      'referenceToDataSource',
      'common:shortDescription',
      '#text',
    ],
  ];
}

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

function isAllowedRepairTextLeaf(
  segments: readonly (string | number)[],
  allowedTails: readonly (readonly string[])[],
): boolean {
  const names = segments.filter((segment): segment is string => typeof segment === 'string');
  return allowedTails.some(
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
  allowedTails: readonly (readonly string[])[],
): void {
  if (Array.isArray(before) || Array.isArray(candidate)) {
    if (!Array.isArray(before) || !Array.isArray(candidate) || before.length !== candidate.length) {
      result.violations.push(renderRepairPath(segments));
      return;
    }
    before.forEach((entry, index) =>
      walkRepairDiff(entry, candidate[index], [...segments, index], result, allowedTails),
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
      walkRepairDiff(before[key], candidate[key], [...segments, key], result, allowedTails);
    }
    return;
  }
  if (before === candidate) {
    return;
  }
  if (
    isAllowedRepairTextLeaf(segments, allowedTails) &&
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

/** A support repair never launders an invalid row: every layer must pass on both sides. */
function isFullyValid(validation: RepairValidationResult): boolean {
  const layers = validation?.validation_layers;
  if (validation?.ok !== true || !layers) {
    return false;
  }
  return (
    layers.schema.status === 'passed' &&
    layers.authoring_evidence.status === 'passed' &&
    layers.content.status === 'passed' &&
    layers.multilingual.status === 'passed'
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

/**
 * The bounded support repair is available only for a fully valid Unit Group / Flow Property draft
 * saved through an explicit native save_draft contract action.
 */
export function supportMetadataRepairType(options: {
  operation: string;
  table: string;
  validation: RepairValidationResult;
}): 'flowproperty' | 'unitgroup' | null {
  if (options.operation !== 'save_draft') {
    return null;
  }
  const root = SUPPORT_REPAIR_ROOTS.get(options.table);
  if (!root) {
    return null;
  }
  if (!isFullyValid(options.validation)) {
    return null;
  }
  return root === 'flowPropertyDataSet' ? 'flowproperty' : 'unitgroup';
}

export function isSupportMetadataRepairCandidate(options: {
  operation: string;
  table: string;
  validation: RepairValidationResult;
}): boolean {
  return supportMetadataRepairType(options) !== null;
}

/** Ledger events may only carry the policy that owns their action's table. */
export function draftRepairPolicyForTable(table: string): string | null {
  if (table === 'processes') {
    return DRAFT_REPAIR_POLICY;
  }
  return SUPPORT_REPAIR_ROOTS.has(table) ? SUPPORT_REPAIR_POLICY : null;
}

/** Shared close-out for both policies: at least one real, non-blank, meaningful text change. */
function finalizeRepairAdmission(options: {
  result: {
    changed: Array<{ path: string; beforeText: string; afterText: string }>;
    violations: string[];
  };
  policy: DraftRepairAdmission['policy'];
  beforeSha256: string;
  desiredSha256: string;
}): DraftRepairAdmissionOutcome {
  if (options.result.violations.length > 0) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_DIFF_NOT_ALLOWED,
      message:
        'Draft metadata repair is not admitted: the candidate changes content outside the reviewed reference short descriptions.',
      details: { violations: options.result.violations },
    };
  }
  if (options.result.changed.length === 0) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_REQUIRES_CHANGE,
      message: 'Draft metadata repair is not admitted: the candidate carries no real change.',
      details: { changed_paths: [] },
    };
  }
  if (
    options.result.changed.some(
      (leaf) => leaf.beforeText.trim() === '' || leaf.afterText.trim() === '',
    )
  ) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_TEXT_REQUIRES_CONTENT,
      message:
        'Draft metadata repair is not admitted: it may not create or clear a reference description.',
      details: { changed_paths: options.result.changed.map((leaf) => leaf.path) },
    };
  }
  if (!options.result.changed.some((leaf) => leaf.beforeText.trim() !== leaf.afterText.trim())) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_REQUIRES_CHANGE,
      message: 'Draft metadata repair is not admitted: the candidate carries no meaningful change.',
      details: { changed_paths: options.result.changed.map((leaf) => leaf.path) },
    };
  }
  return {
    status: 'admitted',
    admission: {
      schema: DRAFT_REPAIR_ADMISSION_SCHEMA,
      status: 'admitted',
      policy: options.policy,
      before_sha256: options.beforeSha256,
      desired_sha256: options.desiredSha256,
      changed_paths: options.result.changed.map((leaf) => leaf.path),
      publication_ready: false,
    },
  };
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
  walkRepairDiff(options.before, options.candidate, [], result, PROCESS_REPAIR_TEXT_TAILS);
  return finalizeRepairAdmission({
    result,
    policy: DRAFT_REPAIR_POLICY,
    beforeSha256: options.beforeSha256,
    desiredSha256: options.desiredSha256,
  });
}

/**
 * Content-bound admission decision for the bounded support metadata repair. Both sides must be
 * fully valid with the same real validator, and only an existing ownership/source reference
 * display text may change.
 */
export function evaluateSupportMetadataRepairAdmission(options: {
  table: string;
  before: unknown;
  candidate: unknown;
  beforeValidation: RepairValidationResult;
  candidateValidation: RepairValidationResult;
  beforeSha256: string;
  desiredSha256: string;
}): DraftRepairAdmissionOutcome {
  const root = SUPPORT_REPAIR_ROOTS.get(options.table);
  if (!root) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_TABLE_NOT_ADMITTED,
      message:
        'Support metadata repair is not admitted: only Unit Group and Flow Property drafts are covered.',
      details: { table: options.table },
    };
  }
  if (!isFullyValid(options.beforeValidation)) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_BEFORE_NOT_VALID,
      message:
        'Support metadata repair is not admitted: the stored draft must pass schema, authoring evidence, content and multilingual validation itself.',
      details: {},
    };
  }
  if (!isFullyValid(options.candidateValidation)) {
    return {
      status: 'rejected',
      code: DRAFT_REPAIR_CANDIDATE_NOT_VALID,
      message:
        'Support metadata repair is not admitted: the candidate must pass schema, authoring evidence, content and multilingual validation.',
      details: {},
    };
  }
  const result: {
    changed: Array<{ path: string; beforeText: string; afterText: string }>;
    violations: string[];
  } = { changed: [], violations: [] };
  walkRepairDiff(options.before, options.candidate, [], result, supportRepairTextTails(root));
  return finalizeRepairAdmission({
    result,
    policy: SUPPORT_REPAIR_POLICY,
    beforeSha256: options.beforeSha256,
    desiredSha256: options.desiredSha256,
  });
}
