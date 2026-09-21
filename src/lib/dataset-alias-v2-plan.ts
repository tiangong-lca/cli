// Versioned (v2) Time alias plan and batch for the current source-proven cohort.
//
// Builds the exact 387-action plan the protected v2 lifecycle executes: 113 Flow actions that
// only retarget the property entry's `referenceToFlowPropertyDataSet` (the quantitative
// reference internal id is asserted unchanged), 274 Process actions that scale exactly the
// named alias exchange occurrences by the reviewed factor and, for the 87 source-proven
// incorrect functional-unit prefixes, correct the unit token `a` to `hr` inside the same
// atomic plan.
//
// Every derived payload is a claim: the plan carries the complete before image (original
// bytes, exponent amounts included) and the complete desired image, and the server recomputes
// the desired side under the lock. This module owns the CLI-side invariants:
//   - flow: only the property reference changes; `quantitativeReference` stays byte-identical;
//   - process: only the listed exchange amount leaves change (canonical trimmed decimal), the
//     exchange key set stays inside the reviewed whitelist, `referenceToReferenceFlow` and
//     every unrelated exchange stay byte-identical;
//   - functional unit: only the source-proven `1`/`1.0` `a` prefix becomes `hr`, whitespace and
//     suffix preserved, other forms fail closed and create no text action;
//   - counts are derived here and cross-checked against the frozen cohort counts.
//
// The reviewed SOURCE flow property is a required, fully content-bound input: its identity must be
// exactly the source alias and its own unit-group pointer must be the currently declared source
// unit group, while its full payload digest travels in `source_evidence` and therefore through
// every plan/freeze/approval/support binding the capability derives.
//
// Local, deterministic and network-free: the caller supplies the frozen evidence and the
// reviewed target snapshots.

import { CliError } from './errors.js';
import { sha256Json } from './dataset-maintenance-contract.js';
import { multiplyBoundedCanonicalDecimal } from './dataset-alias-exponent-decimal.js';

type JsonObject = Record<string, unknown>;

export const ALIAS_V2_PLAN_SCHEMA = 'dataset-alias-plan.v2';
export const ALIAS_V2_BATCH_SCHEMA = 'dataset-alias-batch.v2';
export const ALIAS_V2_FACTOR = '0.00011415525114155251';

export const ALIAS_V2_PLAN_INVALID = 'ALIAS_V2_PLAN_INVALID';
export const ALIAS_V2_REFERENCE_SHAPE_INVALID = 'ALIAS_V2_REFERENCE_SHAPE_INVALID';
export const ALIAS_V2_TARGET_SHAPE_INVALID = 'ALIAS_V2_TARGET_SHAPE_INVALID';
export const ALIAS_V2_SOURCE_SHAPE_INVALID = 'ALIAS_V2_SOURCE_SHAPE_INVALID';
export const ALIAS_V2_UNCERTAINTY_UNSUPPORTED = 'ALIAS_V2_UNCERTAINTY_UNSUPPORTED';
export const ALIAS_V2_TEXT_RULE_VIOLATION = 'ALIAS_V2_TEXT_RULE_VIOLATION';
export const ALIAS_V2_COUNT_MISMATCH = 'ALIAS_V2_COUNT_MISMATCH';

/** Reviewed exchange key set: only `meanAmount`/`resultingAmount` are absolute amounts. */
export const ALIAS_V2_EXCHANGE_KEYS = [
  '@dataSetInternalID',
  'common:other',
  'dataDerivationTypeStatus',
  'exchangeDirection',
  'generalComment',
  'meanAmount',
  'referenceToFlowDataSet',
  'relativeStandardDeviation95In',
  'resultingAmount',
  'uncertaintyDistributionType',
] as const;

// The approved anchored form, literally equal on both sides of the wire (shared vectors):
// the quantity token `1` or `1.0`, exactly one ASCII space, the unit token `a`, then a suffix that
// begins with one ASCII space, contains at least one non-space/non-tab character and carries no
// CR/LF. The whole suffix is preserved byte-for-byte. No variant A fallback, no arbitrary numeric
// or unit prefix, no whitespace-only or multiline suffix, no glued separator.
const FUNCTIONAL_UNIT_RULE = /^(1|1\.0) a( [^\r\n]*[^ \t\r\n][^\r\n]*)$/u;

export type AliasV2Row = { id: string; version: string; json: JsonObject };

export type AliasV2ProcessRow = AliasV2Row & {
  exchange_indexes: number[];
  /**
   * The reviewed source binding for the functional-unit correction. `source_exchange_number` is
   * the ORIGINAL EcoSpold exchange number (for example 730045) that the campaign evidence
   * reviewed; the TIDAS internal id (`@dataSetInternalID`/`referenceToReferenceFlow`, "1") is a
   * different namespace and is read from the payload, never supplied here.
   */
  functional_unit?: { source_exchange_number: string };
};

const SOURCE_EXCHANGE_COMMENT = /Source EcoSpold1 exchange number:\s*(\d+)/u;

/** The reviewed source alias identity the cohort's before images must all carry. */
export type AliasV2SourceAlias = { id: string; version: string };

/**
 * The frozen source evidence: the digest of the reviewed evidence artefact plus the digest of the
 * exact alias cohort tuple set it proves, and the ORIGINAL physical unit that evidence proves for
 * the before amounts (the reviewed campaign's hour). The builder recomputes the cohort digest from
 * the before images it was handed and refuses any mismatch, so stale before content, a substituted
 * source quantity or a swapped unit cannot be certified by a placeholder digest.
 */
export type AliasV2SourceEvidence = {
  sha256: string;
  cohort_sha256: string;
  original_source_unit: string;
};

export type AliasV2PlanInput = {
  actor_id: string;
  source_alias: AliasV2SourceAlias;
  /**
   * The complete locked SOURCE flow property row. Its identity must be exactly `source_alias`, and
   * its own `referenceToReferenceUnitGroup` must be the currently declared source unit group the
   * plan reads the before amounts in. Its full payload digest is the freshness evidence: the
   * identity tuple alone does not move when the row's name (or any other content) changes, so the
   * digest is recorded in `source_evidence` and carried by the plan/freeze/approval/support
   * bindings. A missing, malformed or mismatched row is refused before a plan exists.
   */
  source_flow_property: AliasV2Row;
  flows: AliasV2Row[];
  processes: AliasV2ProcessRow[];
  target_flow_property: AliasV2Row;
  target_unit_group: AliasV2Row;
  /**
   * The unit group the source alias's flow property DECLARES TODAY — the locked pointer the
   * before images carry, which for this cohort is the same year-based "Units of time" table as
   * the target. It is not the orphan `hr` unit group record: that record is historical provenance
   * for the original source unit, and no row is made to point at it.
   */
  declared_source_unit_group: AliasV2Row;
  source_evidence: AliasV2SourceEvidence;
  expected_counts?: JsonObject;
};

export type AliasV2PlanResult = { plan: JsonObject; batch: JsonObject };

function invalid(message: string, details?: JsonObject): never {
  throw new CliError(message, {
    code: ALIAS_V2_PLAN_INVALID,
    exitCode: 2,
    ...(details ? { details } : {}),
  });
}
function fail(code: string, message: string, details?: JsonObject): never {
  throw new CliError(message, { code, exitCode: 2, ...(details ? { details } : {}) });
}
function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/**
 * The flow's property entries. Only ever called on a payload whose Product-flow eligibility has
 * already been proven, so the `flowDataSet` root is a proven object here; a missing or malformed
 * property array still returns null and fails closed at the call site.
 */
function flowPropertyEntries(payload: JsonObject): JsonObject[] | null {
  const properties = (payload['flowDataSet'] as JsonObject)['flowProperties'];
  const value = isJsonObject(properties) ? properties['flowProperty'] : null;
  if (Array.isArray(value)) return value.every(isJsonObject) ? (value as JsonObject[]) : null;
  return isJsonObject(value) ? [value] : null;
}
function exchangeEntries(payload: JsonObject): JsonObject[] | null {
  const root = payload['processDataSet'];
  const exchanges = isJsonObject(root) ? root['exchanges'] : null;
  const value = isJsonObject(exchanges) ? exchanges['exchange'] : null;
  if (Array.isArray(value)) return value.every(isJsonObject) ? (value as JsonObject[]) : null;
  return isJsonObject(value) ? [value] : null;
}
/**
 * The reviewed eligibility gate for every flow this plan touches: the current cohort's 113
 * before images are all Product flows, and the maintenance path must never widen to an
 * elementary or waste flow. Anything but the reviewed value is refused before any write.
 */
export function assertProductFlow(payload: JsonObject, id: string): void {
  const root = payload['flowDataSet'];
  const modellingAndValidation = isJsonObject(root) ? root['modellingAndValidation'] : null;
  const lciMethod = isJsonObject(modellingAndValidation)
    ? modellingAndValidation['LCIMethod']
    : null;
  const typeOfDataSet = isJsonObject(lciMethod) ? lciMethod['typeOfDataSet'] : null;
  if (typeOfDataSet !== 'Product flow') {
    invalid('Alias v2 flow action requires a Product flow data set.', {
      id,
      type_of_dataset: typeOfDataSet,
    });
  }
}

/**
 * The same reviewed Product-flow test as a pure predicate, so a second protected profile can refuse
 * in its own code family without either copying the Time refusal or widening it.
 */
export function isProductFlowPayload(payload: JsonObject): boolean {
  const root = payload['flowDataSet'];
  const modellingAndValidation = isJsonObject(root) ? root['modellingAndValidation'] : null;
  const lciMethod = isJsonObject(modellingAndValidation)
    ? modellingAndValidation['LCIMethod']
    : null;
  return (isJsonObject(lciMethod) ? lciMethod['typeOfDataSet'] : null) === 'Product flow';
}

/**
 * The target flow property's own information node. The real snapshot spells it as the plural
 * `flowPropertiesInformation` under `flowPropertyDataSet`; a singular spelling is a different
 * path that does not exist in the data, so it is refused rather than accepted as an alias.
 */
export function flowPropertyInformation(payload: JsonObject): JsonObject | null {
  const root = payload['flowPropertyDataSet'];
  const information = isJsonObject(root) ? root['flowPropertiesInformation'] : null;
  return isJsonObject(information) ? information : null;
}

/**
 * Proves the reviewed source flow property row and derives the content evidence it contributes.
 *
 * The row is required, must be exactly the reviewed source alias identity, and must currently
 * declare the same unit group whose base unit the before amounts are read in. The returned digest
 * is over the complete canonical payload, so a name-only change between evidence capture and
 * execution produces a different binding instead of sliding through under an unchanged identity.
 */
export function assertAliasV2SourceFlowProperty(input: AliasV2PlanInput): {
  id: string;
  version: string;
  sha256: string;
} {
  const row = input.source_flow_property;
  if (!isJsonObject(row)) {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 plan requires the complete locked source flow property row.',
      { id: null },
    );
  }
  if (typeof row.id !== 'string' || typeof row.version !== 'string') {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 plan requires the complete locked source flow property row.',
      { id: row.id },
    );
  }
  if (row.id === '' || !isJsonObject(row.json)) {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 plan source flow property must be a named row with its payload.',
      { id: row.id },
    );
  }
  // Both ends are pinned: this row must be the reviewed alias identity, not a neighbour.
  if (row.id !== input.source_alias.id || row.version !== input.source_alias.version) {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 source flow property must be exactly the reviewed source alias identity.',
      { id: row.id, version: row.version },
    );
  }
  const information = flowPropertyInformation(row.json);
  if (information === null) {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 source flow property must carry its flowPropertiesInformation node.',
      { id: row.id },
    );
  }
  const quantitativeReference = information['quantitativeReference'];
  const declaredUnitGroup = isJsonObject(quantitativeReference)
    ? quantitativeReference['referenceToReferenceUnitGroup']
    : null;
  const declaredId = isJsonObject(declaredUnitGroup) ? declaredUnitGroup['@refObjectId'] : null;
  const declaredVersion = isJsonObject(declaredUnitGroup) ? declaredUnitGroup['@version'] : null;
  if (
    declaredId !== input.declared_source_unit_group.id ||
    (declaredVersion !== undefined && declaredVersion !== input.declared_source_unit_group.version)
  ) {
    fail(
      ALIAS_V2_SOURCE_SHAPE_INVALID,
      'Alias v2 source flow property must currently declare the locked source unit group.',
      { id: row.id, declared: declaredId ?? null, version: declaredVersion ?? null },
    );
  }
  return { id: row.id, version: row.version, sha256: sha256Json(row.json) };
}

// The real canonical shape spells the year base factor `1.0` (the practical campaign snapshot),
// while a fixture may spell the same exact value `1`. Both are the reviewed one-year factor; any
// other spelling of the base is refused.
const YEAR_BASE_FACTORS = ['1', '1.0'] as const;

/**
 * The ONE canonical unit-group path policy, shared by every protected profile that reads a unit
 * group's table: `unitGroupDataSet.units.unit[]` carries the rows and
 * `unitGroupDataSet.unitGroupInformation.quantitativeReference.referenceToReferenceUnit` — a
 * string — names the base row's internal id. An earlier reviewed excerpt showed that selector
 * without its `unitGroupInformation` parent, and reading the flattened projection as if it were the
 * tree refused the real row; only the canonical parent is accepted, a root-level
 * `quantitativeReference` is refused, and a malformed table refuses here.
 *
 * Each profile asserts its own reviewed factors on top of the table this returns; the path itself
 * is never re-implemented per profile.
 */
export function readCanonicalUnitGroupRows(
  row: AliasV2Row,
  label: string,
  code: string,
): { root: JsonObject; table: JsonObject[]; baseReference: string } {
  const dataSet = isJsonObject(row.json) ? row.json['unitGroupDataSet'] : null;
  const root = isJsonObject(dataSet) ? dataSet : null;
  const units = root === null ? null : root['units'];
  const entries = isJsonObject(units) ? units['unit'] : null;
  const table = Array.isArray(entries)
    ? (entries.filter(isJsonObject) as JsonObject[])
    : isJsonObject(entries)
      ? [entries]
      : null;
  if (root === null || table === null || table.length === 0) {
    fail(code, `${label} must carry its unit table.`, { id: row.id });
  }
  const unitGroupInformation = root['unitGroupInformation'];
  if (!isJsonObject(unitGroupInformation)) {
    fail(code, `${label} must carry its canonical unitGroupInformation parent.`, { id: row.id });
  }
  if (Object.hasOwn(root, 'quantitativeReference')) {
    fail(code, `${label} must not carry a root-level quantitativeReference.`, { id: row.id });
  }
  const quantitativeReference = unitGroupInformation['quantitativeReference'];
  const baseReference = isJsonObject(quantitativeReference)
    ? quantitativeReference['referenceToReferenceUnit']
    : null;
  if (typeof baseReference !== 'string' || baseReference === '') {
    fail(code, `${label} must name its reference unit by internal id.`, {
      id: row.id,
      reference: baseReference ?? null,
    });
  }
  return { root, table, baseReference };
}

/**
 * Validates a unit group's table at the real canonical schema, for the target and for the source
 * alias's currently declared group.
 *
 * The base unit is selected the way the data actually does it: `quantitativeReference.
 * referenceToReferenceUnit` names the internal id of the base row, and that row lives in
 * `units.unit[]` beside its factor. The table must carry that referenced base row at the reviewed
 * one-year factor plus the reviewed `hr` row at the fixed hour factor. A substituted factor, a
 * missing base reference, a reference id the table does not carry, or a table without both rows is
 * refused — a fixture with `hr = 1` is not a unit group of this campaign.
 */
function assertAliasV2UnitGroupTable(row: AliasV2Row, role: 'target' | 'source'): JsonObject {
  const code = role === 'target' ? ALIAS_V2_TARGET_SHAPE_INVALID : ALIAS_V2_SOURCE_SHAPE_INVALID;
  const label = role === 'target' ? 'Alias v2 target unit group' : 'Alias v2 source unit group';
  const { root, table, baseReference } = readCanonicalUnitGroupRows(row, label, code);
  const factorOf = (unit: JsonObject): string | null =>
    typeof unit['meanValue'] === 'string' ? unit['meanValue'] : null;
  const base = table.find((unit) => unit['@dataSetInternalID'] === baseReference);
  if (
    base === undefined ||
    !(YEAR_BASE_FACTORS as readonly (string | null)[]).includes(factorOf(base))
  ) {
    fail(code, `${label} must carry the referenced base unit at the year factor 1.`, {
      id: row.id,
      reference: baseReference,
      factor: base === undefined ? null : factorOf(base),
    });
  }
  const hourly = table.find((unit) => unit['name'] === 'hr');
  if (hourly === undefined || factorOf(hourly) !== ALIAS_V2_FACTOR) {
    fail(code, `${label} must carry the reviewed hour factor.`, {
      id: row.id,
      factor: hourly === undefined ? null : factorOf(hourly),
    });
  }
  return root;
}

/** Validates the locked target unit group at the real canonical shape. */
export function assertAliasV2TargetUnitGroup(target: AliasV2Row): JsonObject {
  return assertAliasV2UnitGroupTable(target, 'target');
}

/**
 * Derives the canonical reference a flow writes when it adopts the locked target flow property.
 * Everything the reference claims comes from the locked snapshot itself, at the real schema
 * paths: the identity from the row, and the description from the target's own
 * `dataSetInformation["common:name"]` language object — never from a `name`/`baseName` array, a
 * `common:shortDescription`, or any other node inherited from a different data set family. The
 * projection keeps exactly the two language-object keys so nothing else can be smuggled in.
 */
export function aliasV2TargetFlowPropertyReference(
  target: AliasV2Row,
  targetUnitGroup: AliasV2Row,
): JsonObject {
  const information = flowPropertyInformation(target.json);
  if (information === null) {
    fail(
      ALIAS_V2_TARGET_SHAPE_INVALID,
      'Alias v2 target flow property must carry its flowPropertiesInformation node.',
      { id: target.id },
    );
  }
  const dataSetInformation = information['dataSetInformation'];
  const name = isJsonObject(dataSetInformation) ? dataSetInformation['common:name'] : null;
  if (
    !isJsonObject(name) ||
    typeof name['#text'] !== 'string' ||
    (name['#text'] as string) === '' ||
    typeof name['@xml:lang'] !== 'string' ||
    (name['@xml:lang'] as string) === ''
  ) {
    fail(
      ALIAS_V2_TARGET_SHAPE_INVALID,
      'Alias v2 target flow property must carry a language-tagged common:name.',
      { id: target.id },
    );
  }
  const quantitativeReference = information['quantitativeReference'];
  const unitGroup = isJsonObject(quantitativeReference)
    ? quantitativeReference['referenceToReferenceUnitGroup']
    : null;
  if (!isJsonObject(unitGroup) || unitGroup['@refObjectId'] !== targetUnitGroup.id) {
    fail(
      ALIAS_V2_TARGET_SHAPE_INVALID,
      'Alias v2 target flow property must reference the locked target unit group.',
      { id: target.id },
    );
  }
  if (Object.hasOwn(unitGroup, '@version') && unitGroup['@version'] !== targetUnitGroup.version) {
    fail(
      ALIAS_V2_TARGET_SHAPE_INVALID,
      'Alias v2 target flow property must reference the locked target unit group version.',
      { id: target.id },
    );
  }
  const reference = {
    '@refObjectId': target.id,
    '@type': 'flow property data set',
    '@uri': `../flowproperties/${target.id}.json`,
    '@version': target.version,
    'common:shortDescription': {
      '#text': name['#text'],
      '@xml:lang': name['@xml:lang'],
    },
  };
  return assertCanonicalFlowPropertyReference(reference);
}

/**
 * The canonical flow-property reference every affected flow actually carries and every derived
 * action must keep: exactly five keys, `@type` naming the flow property data set, the `@uri`
 * derived from the referenced data set id, and a language-tagged description object. A template
 * that is missing `@type`, points somewhere else or spells the description as an array is
 * refused here rather than copied into a desired payload and mirrored back by a matching test.
 */
export function assertCanonicalFlowPropertyReference(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    fail(ALIAS_V2_REFERENCE_SHAPE_INVALID, 'Alias v2 reference must be an object.');
  }
  const keys = Object.keys(value);
  const canonicalKeys = ['@refObjectId', '@type', '@uri', '@version', 'common:shortDescription'];
  if (
    keys.length !== canonicalKeys.length ||
    !canonicalKeys.every((key) => Object.hasOwn(value, key))
  ) {
    fail(
      ALIAS_V2_REFERENCE_SHAPE_INVALID,
      'Alias v2 reference must carry exactly the five canonical keys.',
      { keys: keys.sort() },
    );
  }
  const id = value['@refObjectId'];
  if (typeof id !== 'string' || id === '') {
    fail(ALIAS_V2_REFERENCE_SHAPE_INVALID, 'Alias v2 reference must carry its @refObjectId.');
  }
  if (value['@type'] !== 'flow property data set') {
    fail(
      ALIAS_V2_REFERENCE_SHAPE_INVALID,
      'Alias v2 reference @type must be "flow property data set".',
      { type: value['@type'] },
    );
  }
  if (value['@uri'] !== `../flowproperties/${id}.json`) {
    fail(ALIAS_V2_REFERENCE_SHAPE_INVALID, 'Alias v2 reference @uri must be its canonical path.', {
      uri: value['@uri'],
    });
  }
  if (
    typeof value['@version'] !== 'string' ||
    !/^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u.test(value['@version'])
  ) {
    fail(ALIAS_V2_REFERENCE_SHAPE_INVALID, 'Alias v2 reference must carry a version.');
  }
  const description = value['common:shortDescription'];
  if (
    !isJsonObject(description) ||
    typeof description['@xml:lang'] !== 'string' ||
    (description['@xml:lang'] as string) === '' ||
    typeof description['#text'] !== 'string' ||
    (description['#text'] as string) === ''
  ) {
    fail(
      ALIAS_V2_REFERENCE_SHAPE_INVALID,
      'Alias v2 reference description must be a language-tagged object.',
    );
  }
  return value;
}

function referenceIdentity(value: unknown): { id: string | null; version: string | null } {
  return isJsonObject(value)
    ? {
        id: typeof value['@refObjectId'] === 'string' ? (value['@refObjectId'] as string) : null,
        version: typeof value['@version'] === 'string' ? (value['@version'] as string) : null,
      }
    : { id: null, version: null };
}
/**
 * The process quantitative reference. Only ever called on a payload whose exchange array has
 * already resolved, so the `processDataSet` root is a proven object here; a missing or malformed
 * reference still returns null and fails closed at the call site.
 */
function processReference(payload: JsonObject): JsonObject | null {
  const information = (payload['processDataSet'] as JsonObject)['processInformation'];
  const reference = isJsonObject(information) ? information['quantitativeReference'] : null;
  return isJsonObject(reference) ? reference : null;
}
function functionalUnitText(payload: JsonObject): string | null {
  const node = processReference(payload)?.['functionalUnitOrOther'];
  const text = isJsonObject(node) ? node['#text'] : null;
  return typeof text === 'string' ? text : null;
}

/**
 * Builds the plan and batch. The caller supplies frozen evidence; nothing is fetched or
 * inferred from a live account, and any deviation from the reviewed invariants fails closed.
 */
/**
 * The exact alias cohort tuple set this input would rescale: one tuple per occurrence, carrying
 * the process identity, the occurrence index, the original source amount literal and the flow
 * reference. A frozen evidence document binds this digest; the builder recomputes it from the
 * before images it was handed and refuses any mismatch.
 */
export function aliasV2CohortTuples(input: AliasV2PlanInput): string[] {
  const aliasFlows = new Set(input.flows.map((row) => `${row.id}@${row.version}`));
  const tuples: string[] = [];
  for (const process of input.processes) {
    const entries = exchangeEntries(process.json);
    if (!entries) continue;
    for (const [index, exchange] of entries.entries()) {
      const reference = referenceIdentity(exchange['referenceToFlowDataSet']);
      if (
        reference.id === null ||
        reference.version === null ||
        !aliasFlows.has(`${reference.id}@${reference.version}`)
      ) {
        continue;
      }
      tuples.push(
        `${process.id}@${process.version}#${index}:${String(exchange['meanAmount'])}:${reference.id}@${reference.version}`,
      );
    }
  }
  return tuples.sort();
}

/** The digest a frozen source-evidence document must carry for this input. */
export function aliasV2CohortSha256(input: AliasV2PlanInput): string {
  return sha256Json(aliasV2CohortTuples(input));
}

export function buildAliasV2Plan(input: AliasV2PlanInput): AliasV2PlanResult {
  if (!isJsonObject(input) || typeof input.actor_id !== 'string') {
    invalid('Alias v2 plan requires an actor id.');
  }
  if (
    !Array.isArray(input.flows) ||
    !Array.isArray(input.processes) ||
    input.flows.length === 0 ||
    input.processes.length === 0
  ) {
    invalid('Alias v2 plan requires non-empty flow and process cohorts.');
  }
  if (
    !isJsonObject(input.source_alias) ||
    typeof input.source_alias.id !== 'string' ||
    input.source_alias.id === '' ||
    typeof input.source_alias.version !== 'string' ||
    !/^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u.test(input.source_alias.version)
  ) {
    invalid('Alias v2 plan requires the reviewed source alias identity.');
  }
  if (
    !isJsonObject(input.source_evidence) ||
    typeof input.source_evidence.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.source_evidence.sha256) ||
    typeof input.source_evidence.cohort_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.source_evidence.cohort_sha256) ||
    typeof input.source_evidence.original_source_unit !== 'string' ||
    input.source_evidence.original_source_unit.trim() === ''
  ) {
    invalid('Alias v2 plan requires the bound source evidence document digest.');
  }
  // The target must not be the source: the cohort is rescaled under the reviewed target only.
  if (input.source_alias.id === input.target_flow_property.id) {
    invalid('Alias v2 plan source and target flow properties must differ.');
  }
  const sourceFlowProperty = assertAliasV2SourceFlowProperty(input);
  // The group the source alias declares today is read at the same real schema as the target: its
  // referenced base row must be the year at factor 1 and it must carry the reviewed hour factor.
  assertAliasV2UnitGroupTable(input.declared_source_unit_group, 'source');
  assertAliasV2TargetUnitGroup(input.target_unit_group);
  const target = input.target_flow_property;
  // The reference is a projection of the locked target snapshot at its real schema paths, not a
  // caller-supplied template: the identity comes from the row and the description from the
  // target's own common:name.
  const canonicalTargetReference = aliasV2TargetFlowPropertyReference(
    target,
    input.target_unit_group,
  );

  // The alias cohort tuple set this plan actually touches: identity, version and the source
  // amount literal of every occurrence it will rescale. The frozen evidence must name exactly it.
  const cohortTuples: string[] = [];
  const actions: JsonObject[] = [];
  const textActions: JsonObject[] = [];
  const flowIds = new Set<string>();
  let exchangeCount = 0;
  let unrelatedCount = 0;
  let amountFieldCount = 0;

  for (const flow of input.flows) {
    if (flowIds.has(`${flow.id}@${flow.version}`)) {
      invalid('Alias v2 plan repeats a flow action.', { id: flow.id, version: flow.version });
    }
    flowIds.add(`${flow.id}@${flow.version}`);
    // Eligibility first: only the reviewed Product flow kind may be retargeted.
    assertProductFlow(flow.json, flow.id);
    const entries = flowPropertyEntries(flow.json);
    if (!entries || entries.length !== 1) {
      invalid('Alias v2 flow actions cover flows with exactly one property entry.', {
        id: flow.id,
      });
    }
    const entry = entries[0] as JsonObject;
    if (entry['@dataSetInternalID'] !== '1' || entry['meanValue'] !== '1') {
      invalid('Alias v2 flow property entry must keep internal id 1 and meanValue 1.', {
        id: flow.id,
      });
    }
    const source = referenceIdentity(entry['referenceToFlowPropertyDataSet']);
    if (source.id === target.id) {
      invalid('Alias v2 flow already references the target property.', { id: flow.id });
    }
    // Both ends of the operation are pinned: this row must carry exactly the reviewed source
    // alias, so a row that is already canonical or sourced elsewhere is refused rather than
    // silently rescaled under a new request.
    if (source.id !== input.source_alias.id || source.version !== input.source_alias.version) {
      fail(
        ALIAS_V2_REFERENCE_SHAPE_INVALID,
        'Alias v2 flow before image must reference the reviewed source alias exactly.',
        { id: flow.id, source_id: source.id, source_version: source.version },
      );
    }
    // Only the property entry's own reference is retargeted. The clone is taken first, so the
    // desired payload can never alias the caller's node graph, and `flowInformation` — the
    // quantitative reference that carries the internal id the reviewed rule must preserve — is
    // never written by this branch.
    const desired = clone(flow.json);
    const desiredEntry = (flowPropertyEntries(desired) as JsonObject[])[0] as JsonObject;
    desiredEntry['referenceToFlowPropertyDataSet'] = clone(canonicalTargetReference);
    actions.push({
      action_id: `flow:${flow.id}@${flow.version}`,
      table: 'flows',
      id: flow.id,
      version: flow.version,
      expected_state_code: 0,
      expected_json_ordered: flow.json,
      desired_json_ordered: desired,
      before_sha256: sha256Json(flow.json),
      desired_sha256: sha256Json(desired),
      source_flowproperty: source,
      mutation: { reference: clone(canonicalTargetReference) },
    });
  }

  const processIds = new Set<string>();
  for (const process of input.processes) {
    if (processIds.has(`${process.id}@${process.version}`)) {
      invalid('Alias v2 plan repeats a process action.', {
        id: process.id,
        version: process.version,
      });
    }
    processIds.add(`${process.id}@${process.version}`);
    const entries = exchangeEntries(process.json);
    if (!entries) {
      invalid('Alias v2 process action requires an exchange array.', { id: process.id });
    }
    if (
      !Array.isArray(process.exchange_indexes) ||
      process.exchange_indexes.length === 0 ||
      process.exchange_indexes.some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= entries.length,
      )
    ) {
      invalid('Alias v2 process action requires in-range alias exchange indexes.', {
        id: process.id,
      });
    }
    const indexes = [...process.exchange_indexes].sort((left, right) => left - right);
    if (new Set(indexes).size !== indexes.length) {
      invalid('Alias v2 process action repeats an alias exchange index.', { id: process.id });
    }
    // The occurrence set is derived from the before payload and the selected cohort flows, and the
    // caller's set must be exactly it: an omission, a duplicate or a foreign flow version fails.
    const aliasFlows = new Set(input.flows.map((row) => `${row.id}@${row.version}`));
    const derived: number[] = [];
    for (const [position, exchange] of entries.entries()) {
      const reference = referenceIdentity(exchange['referenceToFlowDataSet']);
      if (
        reference.id !== null &&
        reference.version !== null &&
        aliasFlows.has(`${reference.id}@${reference.version}`)
      ) {
        derived.push(position);
      }
    }
    if (derived.length === 0) {
      invalid('Alias v2 process carries no alias occurrence to rescale.', { id: process.id });
    }
    if (
      derived.length !== indexes.length ||
      derived.some((value, offset) => value !== indexes[offset])
    ) {
      fail(
        ALIAS_V2_PLAN_INVALID,
        'Alias v2 process alias occurrence set is not the complete set this payload carries.',
        { id: process.id, declared: indexes, derived },
      );
    }
    const desired = clone(process.json);
    const desiredExchanges = exchangeEntries(desired) as JsonObject[];
    const instances: JsonObject[] = [];
    let scaled = 0;
    for (const index of indexes) {
      const exchange = entries[index] as JsonObject;
      for (const key of Object.keys(exchange)) {
        if (!(ALIAS_V2_EXCHANGE_KEYS as readonly string[]).includes(key)) {
          fail(
            ALIAS_V2_UNCERTAINTY_UNSUPPORTED,
            `Alias v2 exchange carries an unreviewed field: ${key}.`,
            { id: process.id, index, key },
          );
        }
      }
      const beforeMean = exchange['meanAmount'];
      const beforeResulting = exchange['resultingAmount'];
      if (typeof beforeMean !== 'string' || typeof beforeResulting !== 'string') {
        invalid('Alias v2 alias exchange amounts must be strings.', { id: process.id, index });
      }
      const afterMean = multiplyBoundedCanonicalDecimal(beforeMean, ALIAS_V2_FACTOR);
      const afterResulting = multiplyBoundedCanonicalDecimal(beforeResulting, ALIAS_V2_FACTOR);
      if (afterMean === null || afterResulting === null) {
        invalid('Alias v2 alias exchange amount is outside the reviewed numeric bounds.', {
          id: process.id,
          index,
          amount: beforeMean,
        });
      }
      const desiredExchange = (desiredExchanges as JsonObject[])[index] as JsonObject;
      desiredExchange['meanAmount'] = afterMean;
      desiredExchange['resultingAmount'] = afterResulting;
      cohortTuples.push(
        `${process.id}@${process.version}#${index}:${beforeMean}:${referenceIdentity(exchange['referenceToFlowDataSet']).id}@${referenceIdentity(exchange['referenceToFlowDataSet']).version}`,
      );
      instances.push({
        index,
        internal_id: exchange['@dataSetInternalID'],
        flow_id: referenceIdentity(exchange['referenceToFlowDataSet']).id,
        flow_version: referenceIdentity(exchange['referenceToFlowDataSet']).version,
        direction: exchange['exchangeDirection'],
        before_amount: beforeMean,
        after_amount: afterMean,
        before_resulting_amount: beforeResulting,
        after_resulting_amount: afterResulting,
      });
      scaled += 1;
    }
    exchangeCount += scaled;
    amountFieldCount += scaled * 2;
    unrelatedCount += entries.length - scaled;

    // Functional unit: only the source-proven incorrect prefix is corrected, inside the plan.
    const referenceIndex = processReference(process.json)?.['referenceToReferenceFlow'];
    if (typeof referenceIndex !== 'string') {
      invalid('Alias v2 process must declare its quantitative reference exchange.', {
        id: process.id,
      });
    }
    const beforeText = functionalUnitText(process.json);
    const sourceNumber = process.functional_unit?.source_exchange_number;
    if (process.functional_unit !== undefined) {
      if (typeof sourceNumber !== 'string' || !/^[0-9]{1,12}$/u.test(sourceNumber)) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 text action requires its original source exchange number.',
          {
            id: process.id,
          },
        );
      }
      // The functional unit belongs to the exchange the quantitative reference points at by its
      // INTERNAL id; that exchange's own comment carries the ORIGINAL source number, and the two
      // must agree with the reviewed binding without either namespace standing in for the other.
      const referencePosition = Number(referenceIndex) - 1;
      const referenceExchange = Number.isSafeInteger(referencePosition)
        ? (entries[referencePosition] as JsonObject | undefined)
        : undefined;
      if (referenceExchange === undefined) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 functional unit must resolve to its reference exchange by internal id.',
          { id: process.id, reference_internal_id: referenceIndex },
        );
      }
      if (referenceExchange['@dataSetInternalID'] !== referenceIndex) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 reference exchange internal id must match the quantitative reference.',
          { id: process.id },
        );
      }
      // The reviewed relationship in the campaign: the functional unit's reference exchange is one
      // of the selected alias occurrences this plan rescales (checked over all 87 actual processes).
      // A reference exchange outside that set is a different, unreviewed shape and is refused here.
      if (!indexes.includes(referencePosition)) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 functional unit reference exchange must be one of the selected alias occurrences.',
          { id: process.id, reference_internal_id: referenceIndex, selected: indexes },
        );
      }
      const comment = referenceExchange['generalComment'];
      const commentText = isJsonObject(comment) ? comment['#text'] : null;
      const commentNumber =
        typeof commentText === 'string'
          ? (SOURCE_EXCHANGE_COMMENT.exec(commentText)?.[1] ?? null)
          : null;
      if (commentNumber !== sourceNumber) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 functional unit source number must match the reference exchange comment.',
          { id: process.id, reviewed: sourceNumber, comment: commentNumber },
        );
      }
      // The reviewed reference-process output quantity is 1 or 1.0: the text prefix and the
      // amount must describe the same occurrence.
      const referenceMean = referenceExchange['meanAmount'];
      if (referenceMean !== '1' && referenceMean !== '1.0') {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 functional unit quantity must equal the reference exchange amount.',
          { id: process.id, amount: referenceMean },
        );
      }
      const match = beforeText === null ? null : FUNCTIONAL_UNIT_RULE.exec(beforeText);
      if (!match) {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 functional unit prefix is not the reviewed source-proven form.',
          { id: process.id, text: beforeText },
        );
      }
      const afterText = `${match[1] as string} hr${match[2] as string}`;
      const desiredDataSet = desired['processDataSet'] as JsonObject;
      const desiredQuantitative = (desiredDataSet['processInformation'] as JsonObject)[
        'quantitativeReference'
      ] as JsonObject;
      (desiredQuantitative['functionalUnitOrOther'] as JsonObject)['#text'] = afterText;
      textActions.push({
        table: 'processes',
        id: process.id,
        version: process.version,
        before_text: beforeText,
        after_text: afterText,
        source_exchange_number: sourceNumber,
      });
    } else if (beforeText !== null && FUNCTIONAL_UNIT_RULE.test(beforeText)) {
      // The reviewed incorrect prefix without its source proof: never leave it silently in place.
      fail(
        ALIAS_V2_TEXT_RULE_VIOLATION,
        'Alias v2 functional unit carries the reviewed incorrect prefix without its source proof.',
        { id: process.id, text: beforeText },
      );
    }
    if (sha256Json(desired) === sha256Json(process.json)) {
      invalid('Alias v2 process action would carry no real change.', { id: process.id });
    }
    actions.push({
      action_id: `process:${process.id}@${process.version}`,
      table: 'processes',
      id: process.id,
      version: process.version,
      expected_state_code: 0,
      expected_json_ordered: process.json,
      desired_json_ordered: desired,
      before_sha256: sha256Json(process.json),
      desired_sha256: sha256Json(desired),
      quantitative_reference: referenceIndex,
      mutation: { exchanges: instances },
    });
  }

  const cohortSha256 = sha256Json(cohortTuples.slice().sort());
  if (cohortSha256 !== input.source_evidence.cohort_sha256) {
    fail(
      ALIAS_V2_PLAN_INVALID,
      'Alias v2 source evidence does not bind the exact before cohort this plan touches.',
      { recomputed: cohortSha256, expected: input.source_evidence.cohort_sha256 },
    );
  }
  // One reviewed time dimension, one batch: the batch executor's own document carries the same
  // derived counts, and the server derives both from the plan.
  const dimensions: JsonObject[] = [
    {
      dimension: 'time',
      factor: ALIAS_V2_FACTOR,
      // The unit group the source alias declares today, whose base unit `a` the before amounts are
      // read in; the transform writes each amount in the target table's `hr`.
      declared_source_unitgroup: {
        id: input.declared_source_unit_group.id,
        version: input.declared_source_unit_group.version,
      },
      target_unitgroup: {
        id: input.target_unit_group.id,
        version: input.target_unit_group.version,
      },
    },
  ];
  const counts: JsonObject = {
    action_count: actions.length,
    batch_count: dimensions.length,
    exchange_count: exchangeCount,
    amount_field_count: amountFieldCount,
    unrelated_exchange_count: unrelatedCount,
    // One audit row per action, one summary per batch, one plan summary: the topology the
    // protected plan/batch executors actually emit, which the server simulation re-derives.
    audit_count: actions.length + dimensions.length + 1,
    flowproperty_count: actions.filter((action) => action['table'] === 'flowproperties').length,
    flow_count: actions.filter((action) => action['table'] === 'flows').length,
    process_count: actions.filter((action) => action['table'] === 'processes').length,
    // One target per actually changed Flow/Process identity; action identities are unique.
    derivative_target_count: new Set(
      actions.map(
        (action) =>
          `${String(action['table'])}:${String(action['id'])}@${String(action['version'])}`,
      ),
    ).size,
    text_action_count: textActions.length,
  };
  if (input.expected_counts !== undefined) {
    for (const [key, value] of Object.entries(input.expected_counts)) {
      if (counts[key] !== value) {
        fail(ALIAS_V2_COUNT_MISMATCH, 'Alias v2 derived counts do not match the frozen cohort.', {
          key,
        });
      }
    }
  }

  const plan: JsonObject = {
    schema_version: ALIAS_V2_PLAN_SCHEMA,
    actor_id: input.actor_id,
    target_visibility: 'owner_draft',
    source_alias: {
      id: input.source_alias.id,
      version: input.source_alias.version,
      sha256: sha256Json(input.source_alias),
    },
    source_evidence: {
      sha256: input.source_evidence.sha256,
      cohort_sha256: cohortSha256,
      expected_cohort_sha256: input.source_evidence.cohort_sha256,
      exchange_count: counts['exchange_count'],
      // The source alias's CURRENT DECLARED unit group, as locked by its flow property pointer.
      declared_source_unitgroup: {
        id: input.declared_source_unit_group.id,
        version: input.declared_source_unit_group.version,
        sha256: sha256Json(input.declared_source_unit_group.json),
      },
      // The complete locked source flow property: identity plus the digest of its full payload.
      // This is the freshness evidence for the reviewed alias, and it travels in every binding the
      // plan, freeze, approval and support-snapshot sets derive.
      source_flowproperty: sourceFlowProperty,
      // The ORIGINAL physical unit of the before amounts, proven by the content-bound evidence
      // above. Provenance only: it is not a current pointer, it is not written to any row, and
      // the current declaration is never read as proof that the amounts are already in it.
      original_source_unit: input.source_evidence.original_source_unit,
    },
    target_snapshots: {
      flowproperty: {
        id: target.id,
        version: target.version,
        sha256: sha256Json(target.json),
      },
      unitgroup: {
        id: input.target_unit_group.id,
        version: input.target_unit_group.version,
        sha256: sha256Json(input.target_unit_group.json),
      },
    },
    expected: counts,
    dimensions,
    text_actions: textActions,
    actions,
  };
  const planSha = sha256Json(plan);
  plan['plan_sha256'] = planSha;
  const batch: JsonObject = {
    schema_version: ALIAS_V2_BATCH_SCHEMA,
    plan_sha256: planSha,
    dimension: 'time',
    factor: ALIAS_V2_FACTOR,
    counts,
    text_actions: textActions,
    actions,
  };
  return { plan, batch };
}
