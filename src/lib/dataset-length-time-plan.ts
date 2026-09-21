// The closed Length*time correction plan (`dataset-length-time-plan.v1`).
//
// One reviewed correction, one profile: exactly 13 owner-draft Process actions whose 39 selected
// exchange occurrences move their two absolute amount leaves from the stored `kmy` literal to the
// same quantity in the canonical `m*a` reference basis, by the fixed factor 1000. Nothing else is
// written — no Flow, Flow Property, Unit Group, reference, identity, version, functional-unit text
// or uncertainty field — and the read-only flows ride the plan as evidence (`flow_snapshots`), never
// as actions.
//
// This module is the CLI half of the shared wire fixed jointly with the database owner
// (`/tmp/foundry186-wire-contract.md`): the emitted document's top-level key set, action key set,
// instance key set, counts and digests are exactly that document's, and the shared synthetic
// fixture is checked in so both halves are driven by one producer.
//
// Local, deterministic and network-free: the caller supplies the frozen rows and the frozen source
// evidence, and every derived value (the selected occurrence set, the after literals, the counts,
// the evidence tuple table) is recomputed here rather than trusted from the input.

import { CliError } from './errors.js';
import { isJsonObject, sha256Json, type JsonObject } from './dataset-maintenance-contract.js';
import {
  canonicalDecimalText,
  multiplyBoundedCanonicalDecimal,
} from './dataset-alias-exponent-decimal.js';
import { isProductFlowPayload, readCanonicalUnitGroupRows } from './dataset-alias-v2-plan.js';

export const LENGTH_TIME_PLAN_SCHEMA = 'dataset-length-time-plan.v1';

/** The reviewed constant: `kmy` is 1000 `m*a`, so the correction multiplies by exactly this. */
export const LENGTH_TIME_FACTOR = '1000';
/** The reviewed reference factor: the unit the amounts are being moved onto. */
export const LENGTH_TIME_REFERENCE_FACTOR = '1';
export const LENGTH_TIME_SOURCE_UNIT = 'kmy';
export const LENGTH_TIME_REFERENCE_UNIT = 'm*a';

export const LENGTH_TIME_PLAN_INVALID = 'LENGTH_TIME_PLAN_INVALID';
export const LENGTH_TIME_TARGET_SHAPE_INVALID = 'LENGTH_TIME_TARGET_SHAPE_INVALID';
export const LENGTH_TIME_SOURCE_SHAPE_INVALID = 'LENGTH_TIME_SOURCE_SHAPE_INVALID';
export const LENGTH_TIME_EVIDENCE_MISMATCH = 'LENGTH_TIME_EVIDENCE_MISMATCH';
export const LENGTH_TIME_COUNT_MISMATCH = 'LENGTH_TIME_COUNT_MISMATCH';
export const LENGTH_TIME_DERIVE_MISMATCH = 'LENGTH_TIME_DERIVE_MISMATCH';
export const LENGTH_TIME_UNCERTAINTY_UNSUPPORTED = 'LENGTH_TIME_UNCERTAINTY_UNSUPPORTED';

/**
 * The keys every selected occurrence of the audited cohort carries: identity, derivation status,
 * direction, the source declaration, both absolute amount leaves, the flow reference and the
 * uncertainty distribution. All 39 occurrences carry the distribution — 13 of them as the literal
 * string `"undefined"` and 26 as `"log-normal"` — so the field itself is never absent and is never
 * dropped: its value, whatever it is, is preserved byte-for-byte.
 */
export const LENGTH_TIME_REQUIRED_EXCHANGE_KEYS = [
  '@dataSetInternalID',
  'dataDerivationTypeStatus',
  'exchangeDirection',
  'generalComment',
  'meanAmount',
  'referenceToFlowDataSet',
  'resultingAmount',
  'uncertaintyDistributionType',
] as const;

/**
 * The one optional reviewed key. Of the 39 selected occurrences, 4 carry a relative standard
 * deviation and 35 do not: a missing standard deviation is a source-authoring gap in the input, not
 * a quantity this correction may fabricate, default to zero or reinterpret, and it does not block a
 * pure x1000 rescale. Its presence, absence and value are preserved exactly.
 */
export const LENGTH_TIME_OPTIONAL_EXCHANGE_KEYS = ['relativeStandardDeviation95In'] as const;

/** The complete reviewed exchange key set: everything required, plus the optional uncertainty pair. */
export const LENGTH_TIME_EXCHANGE_KEYS = [
  ...LENGTH_TIME_REQUIRED_EXCHANGE_KEYS,
  ...LENGTH_TIME_OPTIONAL_EXCHANGE_KEYS,
] as const;

/**
 * Absolute-uncertainty fields. The profile has no rule for them, so an occurrence carrying one is
 * not the reviewed shape and is refused rather than silently rescaled around.
 */
export const LENGTH_TIME_ABSOLUTE_UNCERTAINTY_KEYS = [
  'minimumAmount',
  'maximumAmount',
  'standardDeviation95In',
  'variance',
  'standardDeviation',
] as const;

/** The ten closed top-level keys of the emitted plan document. */
export const LENGTH_TIME_PLAN_KEYS = [
  'schema_version',
  'actor_id',
  'target_visibility',
  'flow_snapshots',
  'target_flow_property',
  'target_unit_group',
  'source_evidence',
  'expected',
  'actions',
  'plan_sha256',
] as const;

/** The eleven reviewed count names, the same family the Time profile uses. */
export const LENGTH_TIME_COUNT_KEYS = [
  'action_count',
  'batch_count',
  'exchange_count',
  'amount_field_count',
  'unrelated_exchange_count',
  'audit_count',
  'flowproperty_count',
  'flow_count',
  'process_count',
  'derivative_target_count',
  'text_action_count',
] as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION = /^[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/u;
const INTERNAL_ID = /^[0-9]{1,12}$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u;
/**
 * The reviewed source-number declaration, exactly as the audited corpus spells it: the anchored
 * label, optional spaces, the bounded numeric token, then its `.` delimiter. Everything after the
 * delimiter is suffix metadata — preserved byte-for-byte, never scanned for a number — because the
 * real comments carry EcoSpold tuples such as `(1,2,3,4,5,6,BU:7.8); ;` whose digits are not source
 * ids, and the label word `EcoSpold1` carries one itself.
 */
const SOURCE_NUMBER_DECLARATION =
  /^Source EcoSpold1 exchange number:[ \t]*([0-9]{1,12})\.[\s\S]*$/u;
/** A second declaration anywhere in the comment makes the source id ambiguous. */
const SOURCE_NUMBER_LABEL = /Source EcoSpold1 exchange number:/gu;

export type LengthTimeRow = { id: string; version: string; json: JsonObject };
export type LengthTimeProcessRow = LengthTimeRow & { modified_at: string };

/**
 * The frozen source evidence the operator supplies. `sha256` is the digest of the frozen source
 * artefact and travels through the plan/freeze/approval bindings; `cohort_sha256` is the CLI-local
 * digest of the exact instance tuple table this input derives, so a re-derived plan can never ride
 * an older evidence artefact. The five wire keys (`sha256`, `source_unit`, `reference_unit`,
 * `factor`, `instance_count`) are what the emitted plan carries; `cohort_sha256` stays local.
 */
export type LengthTimeSourceEvidence = {
  sha256: string;
  cohort_sha256: string;
  source_unit: string;
  reference_unit: string;
  factor: string;
  instance_count: number;
};

export type LengthTimePlanInput = {
  actor_id: string;
  flows: LengthTimeRow[];
  processes: LengthTimeProcessRow[];
  target_flow_property: LengthTimeRow;
  target_unit_group: LengthTimeRow;
  source_evidence: LengthTimeSourceEvidence;
  expected_counts?: JsonObject;
};

export type LengthTimePlanResult = { plan: JsonObject };

/** One declared or derived occurrence, in the reviewed source-proof tuple shape. */
export type LengthTimeInstance = {
  index: number;
  internal_id: string;
  source_exchange_number: string;
  direction: string;
  flow_id: string;
  flow_version: string;
  before_literal: string;
  after_literal: string;
};

/** The reviewed factor leaf, as the locked row spells it. */
function readFactorText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Whether a locked unit row declares the reviewed factor. The real canonical table spells the
 * factors `1.0` and `1000.0` while the reviewed constants are `1` and `1000`, so the comparison is
 * exact-decimal numeric equivalence — the module's own bounded decimal normaliser, no float path and
 * no enumeration of "extra accepted spellings": any value-equal spelling with trailing fractional
 * zeros is accepted, and a malformed, out-of-bounds or merely-near value is refused.
 */
function equalsReviewedFactor(value: unknown, reviewed: string): boolean {
  const text = readFactorText(value);
  if (text === null) {
    return false;
  }
  return canonicalDecimalText(text) === reviewed;
}

function invalid(message: string, details?: JsonObject): never {
  throw new CliError(message, {
    code: LENGTH_TIME_PLAN_INVALID,
    exitCode: 2,
    ...(details ? { details } : {}),
  });
}
function fail(code: string, message: string, details?: JsonObject): never {
  throw new CliError(message, { code, exitCode: 2, ...(details ? { details } : {}) });
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function isNamedRow(row: unknown, label: string): LengthTimeRow {
  const candidate = row as LengthTimeRow | undefined;
  if (
    !isJsonObject(candidate) ||
    typeof candidate.id !== 'string' ||
    !UUID.test(candidate.id) ||
    typeof candidate.version !== 'string' ||
    !VERSION.test(candidate.version) ||
    !isJsonObject(candidate.json)
  ) {
    invalid(`Length*time plan requires the complete ${label} row.`);
  }
  return candidate;
}

function exchangeEntries(payload: JsonObject): JsonObject[] | null {
  const root = payload['processDataSet'];
  const exchanges = isJsonObject(root) ? root['exchanges'] : null;
  const value = isJsonObject(exchanges) ? exchanges['exchange'] : null;
  if (Array.isArray(value)) return value.every(isJsonObject) ? (value as JsonObject[]) : null;
  return isJsonObject(value) ? [value] : null;
}

/**
 * The functional-unit text a selected process's own before image carries. This profile never
 * rewrites it — `1 kmy` stays correct because 1 kmy is 1000 m*a — but the text must be a present,
 * non-empty string: the terminal readback compares the server's observation against it, and two
 * absent values must never be able to satisfy that comparison.
 */
function functionalUnitText(payload: JsonObject): string | null {
  // Only ever called on a payload whose exchange array has already resolved, so the
  // `processDataSet` root is a proven object here.
  const information = (payload['processDataSet'] as JsonObject)['processInformation'];
  const quantitativeReference = isJsonObject(information)
    ? information['quantitativeReference']
    : null;
  const functionalUnit = isJsonObject(quantitativeReference)
    ? quantitativeReference['functionalUnitOrOther']
    : null;
  const text = isJsonObject(functionalUnit) ? functionalUnit['#text'] : null;
  return typeof text === 'string' && text !== '' ? text : null;
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
 * The EcoSpold source number a selected exchange's own stored comment proves, derived from the
 * anchored declaration the audited corpus uses and from nothing else. The label must be at the
 * start of the comment, its number must be the token directly followed by the `.` delimiter, and
 * the suffix is left alone: a bare number, a missing delimiter, a foreign label, or a comment that
 * declares its source twice all fail closed rather than being read as whichever digits happen to
 * appear. The shared vectors in `test/fixtures/length-time-source-comment-vectors.json` fix this
 * grammar for both halves of the wire.
 */
export function lengthTimeSourceExchangeNumber(comment: unknown): string | null {
  const text = isJsonObject(comment) ? comment['#text'] : null;
  if (typeof text !== 'string') {
    return null;
  }
  const declared = text.match(SOURCE_NUMBER_LABEL)?.length ?? 0;
  if (declared !== 1) {
    return null;
  }
  return SOURCE_NUMBER_DECLARATION.exec(text)?.[1] ?? null;
}

/**
 * Validates the locked unit group at the canonical path and at this profile's reviewed factors:
 * a reference unit `m*a` at factor 1 named by the string selector, and a `kmy` row at factor 1000.
 */
export function assertLengthTimeTargetUnitGroup(row: LengthTimeRow): void {
  const { table, selected: base } = readCanonicalUnitGroupRows(
    row,
    'Length*time target unit group',
    LENGTH_TIME_TARGET_SHAPE_INVALID,
  );
  if (base['name'] !== LENGTH_TIME_REFERENCE_UNIT) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target unit group must name the reference unit m*a.',
      { id: row.id, name: base['name'] ?? null },
    );
  }
  if (!equalsReviewedFactor(base['meanValue'], LENGTH_TIME_REFERENCE_FACTOR)) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target unit group must carry the reference unit at factor 1.',
      { id: row.id, factor: readFactorText(base['meanValue']) },
    );
  }
  const kiloMetreYear = table.find((unit) => unit['name'] === LENGTH_TIME_SOURCE_UNIT);
  if (
    kiloMetreYear === undefined ||
    !equalsReviewedFactor(kiloMetreYear['meanValue'], LENGTH_TIME_FACTOR)
  ) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target unit group must carry the reviewed kmy factor.',
      {
        id: row.id,
        factor: kiloMetreYear === undefined ? null : readFactorText(kiloMetreYear['meanValue']),
      },
    );
  }
}

/**
 * The normal reference kind a canonical flow property writes when it points at its unit group.
 */
export const LENGTH_TIME_UNIT_GROUP_REFERENCE_KIND = 'unit group data set';

/**
 * Validates the canonical Length*time property: its plural information node must point at the
 * locked unit group **at that exact version and kind**, and it must carry the language-tagged name
 * the plan's target binding rides on.
 *
 * The version is required to be present and exactly equal, not merely absent-tolerant: a property
 * whose pointer names a different version is a different (or stale) scientific reference, and
 * hashing a mismatched pointer would let a frozen digest stand in for the real parent binding.
 */
export function assertLengthTimeTargetFlowProperty(
  row: LengthTimeRow,
  unitGroup: LengthTimeRow,
): void {
  // Callers reach this only with a row whose payload was already proven an object.
  const root = (row.json as JsonObject)['flowPropertyDataSet'];
  const information = isJsonObject(root) ? root['flowPropertiesInformation'] : null;
  if (!isJsonObject(information)) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target flow property must carry its flowPropertiesInformation node.',
      { id: row.id },
    );
  }
  const quantitativeReference = information['quantitativeReference'];
  const declared = isJsonObject(quantitativeReference)
    ? quantitativeReference['referenceToReferenceUnitGroup']
    : null;
  if (!isJsonObject(declared)) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target flow property must carry its unit-group reference.',
      { id: row.id },
    );
  }
  const declaredId = declared['@refObjectId'];
  const declaredVersion = declared['@version'];
  const declaredKind = declared['@type'];
  if (
    declaredId !== unitGroup.id ||
    declaredVersion !== unitGroup.version ||
    declaredKind !== LENGTH_TIME_UNIT_GROUP_REFERENCE_KIND
  ) {
    fail(
      LENGTH_TIME_TARGET_SHAPE_INVALID,
      'Length*time target flow property must reference the locked target unit group at its exact version and kind.',
      { id: row.id, declared: declaredId, version: declaredVersion, kind: declaredKind },
    );
  }
}

/**
 * The freeze's target snapshot projection for a Length plan: the shared freeze envelope and the
 * shared preflight both carry a `target_snapshots` node, while the Length plan carries its two
 * canonical targets directly. The projection is fixed by the wire contract so the freeze stays one
 * 13-key envelope with one canonical hash.
 */
export function lengthTimeTargetSnapshots(plan: JsonObject): JsonObject {
  return {
    flowproperty: plan['target_flow_property'] as JsonObject,
    unitgroup: plan['target_unit_group'] as JsonObject,
  };
}

/**
 * The exact instance tuple table this input derives: one line per selected occurrence, carrying the
 * complete source-proof tuple. The frozen evidence must name exactly this table — the CLI recomputes
 * it from the before images it was handed, so stale before content, a substituted literal or a
 * swapped source number cannot be certified by a placeholder digest.
 */
export function lengthTimeEvidenceTuples(input: LengthTimePlanInput): string[] {
  // The same claimed-flow filter the builder applies: an unrelated exchange in one of the selected
  // processes is never part of the correction set and never part of its evidence table.
  const claimedFlows = new Set(
    (Array.isArray(input.flows) ? input.flows : []).map((row) => `${row.id}@${row.version}`),
  );
  const tuples: string[] = [];
  for (const process of input.processes) {
    for (const instance of lengthTimeInstances(process, claimedFlows)) {
      tuples.push(
        `${process.id}@${process.version}#${instance.index}:${instance.internal_id}:${instance.source_exchange_number}:${instance.direction}:${instance.flow_id}@${instance.flow_version}:${instance.before_literal}->${instance.after_literal}`,
      );
    }
  }
  return tuples.sort();
}

/** The digest a frozen source-evidence document must carry for this input. */
export function lengthTimeCohortSha256(input: LengthTimePlanInput): string {
  return sha256Json(lengthTimeEvidenceTuples(input));
}

/**
 * Derives the selected occurrence set of one process: every exchange whose flow reference resolves
 * to a claimed read-only flow. The set is derived from the before payload, never declared, and a
 * process that carries none is refused rather than becoming an artificial no-op action.
 */
export function lengthTimeInstances(
  process: LengthTimeProcessRow,
  claimedFlows?: ReadonlySet<string>,
): LengthTimeInstance[] {
  const entries = exchangeEntries(process.json);
  if (entries === null) {
    invalid('Length*time process action requires an exchange array.', { id: process.id });
  }
  const instances: LengthTimeInstance[] = [];
  for (const [index, exchange] of entries.entries()) {
    const reference = referenceIdentity(exchange['referenceToFlowDataSet']);
    if (claimedFlows !== undefined) {
      if (
        reference.id === null ||
        reference.version === null ||
        !claimedFlows.has(`${reference.id}@${reference.version}`)
      ) {
        continue;
      }
    } else if (reference.id === null || reference.version === null) {
      continue;
    }
    instances.push(lengthTimeInstanceOf(process, index, exchange, reference));
  }
  return instances;
}

function lengthTimeInstanceOf(
  process: LengthTimeProcessRow,
  index: number,
  exchange: JsonObject,
  reference: { id: string | null; version: string | null },
): LengthTimeInstance {
  const details = { id: process.id, index };
  for (const key of Object.keys(exchange)) {
    if (!(LENGTH_TIME_EXCHANGE_KEYS as readonly string[]).includes(key)) {
      fail(
        LENGTH_TIME_UNCERTAINTY_UNSUPPORTED,
        `Length*time exchange carries an unreviewed field: ${key}.`,
        { ...details, key },
      );
    }
  }
  for (const key of LENGTH_TIME_REQUIRED_EXCHANGE_KEYS) {
    if (!Object.hasOwn(exchange, key)) {
      fail(
        LENGTH_TIME_PLAN_INVALID,
        `Length*time exchange is missing its reviewed field: ${key}.`,
        { ...details, key },
      );
    }
  }
  // The distribution the occurrence declares is never judged: the audited corpus spells it
  // `"undefined"` for thirteen occurrences and `"log-normal"` for the rest, and the optional standard
  // deviation is equally untouched. The whole payload is copied and only the two amount leaves move.
  const internalId = exchange['@dataSetInternalID'];
  if (typeof internalId !== 'string' || !INTERNAL_ID.test(internalId)) {
    fail(LENGTH_TIME_PLAN_INVALID, 'Length*time exchange must carry its internal id.', details);
  }
  const direction = exchange['exchangeDirection'];
  if (direction !== 'Input' && direction !== 'Output') {
    fail(LENGTH_TIME_PLAN_INVALID, 'Length*time exchange must declare its direction.', {
      ...details,
      direction: direction ?? null,
    });
  }
  if (reference.id === null || reference.version === null || !UUID.test(reference.id)) {
    fail(
      LENGTH_TIME_PLAN_INVALID,
      'Length*time exchange must resolve its flow reference.',
      details,
    );
  }
  const beforeLiteral = exchange['meanAmount'];
  const resultingLiteral = exchange['resultingAmount'];
  if (typeof beforeLiteral !== 'string' || typeof resultingLiteral !== 'string') {
    fail(LENGTH_TIME_DERIVE_MISMATCH, 'Length*time exchange amounts must be strings.', details);
  }
  // Both leaves are the same quantity in the audited corpus; a split pair is a different shape the
  // profile has no rule for.
  if (beforeLiteral !== resultingLiteral) {
    fail(
      LENGTH_TIME_DERIVE_MISMATCH,
      'Length*time exchange meanAmount and resultingAmount must be the same literal.',
      { ...details, meanAmount: beforeLiteral, resultingAmount: resultingLiteral },
    );
  }
  const sourceNumber = lengthTimeSourceExchangeNumber(exchange['generalComment']);
  if (sourceNumber === null) {
    fail(
      LENGTH_TIME_DERIVE_MISMATCH,
      'Length*time exchange must carry its reviewed source number in generalComment.',
      details,
    );
  }
  const afterLiteral = multiplyBoundedCanonicalDecimal(beforeLiteral, LENGTH_TIME_FACTOR);
  if (afterLiteral === null) {
    fail(
      LENGTH_TIME_DERIVE_MISMATCH,
      'Length*time exchange amount is outside the reviewed numeric bounds.',
      { ...details, amount: beforeLiteral },
    );
  }
  return {
    index,
    internal_id: internalId,
    source_exchange_number: sourceNumber,
    direction,
    flow_id: reference.id,
    flow_version: reference.version,
    before_literal: beforeLiteral,
    after_literal: afterLiteral,
  };
}

/**
 * Builds the plan document. Any deviation from the reviewed invariants fails closed before an
 * artefact exists, and every count and digest in the result is derived here.
 */
export function buildLengthTimePlan(input: LengthTimePlanInput): LengthTimePlanResult {
  if (!isJsonObject(input) || typeof input.actor_id !== 'string' || !UUID.test(input.actor_id)) {
    invalid('Length*time plan requires its actor id.');
  }
  const evidence = input.source_evidence;
  if (!isJsonObject(evidence)) {
    invalid('Length*time plan requires the bound source evidence document.');
  }
  if (
    typeof evidence.sha256 !== 'string' ||
    !SHA256.test(evidence.sha256) ||
    typeof evidence.cohort_sha256 !== 'string' ||
    !SHA256.test(evidence.cohort_sha256) ||
    typeof evidence.source_unit !== 'string' ||
    typeof evidence.reference_unit !== 'string' ||
    typeof evidence.factor !== 'string' ||
    !Number.isSafeInteger(evidence.instance_count) ||
    evidence.instance_count < 0
  ) {
    fail(
      LENGTH_TIME_SOURCE_SHAPE_INVALID,
      'Length*time plan requires the bound source evidence document digest.',
    );
  }
  if (
    !Array.isArray(input.flows) ||
    !Array.isArray(input.processes) ||
    input.flows.length === 0 ||
    input.processes.length === 0
  ) {
    invalid('Length*time plan requires non-empty read-only flow and process cohorts.');
  }

  const targetProperty = isNamedRow(input.target_flow_property, 'target flow property');
  const targetUnitGroup = isNamedRow(input.target_unit_group, 'target unit group');
  assertLengthTimeTargetFlowProperty(targetProperty, targetUnitGroup);
  assertLengthTimeTargetUnitGroup(targetUnitGroup);

  // The read-only flows: unique identity, complete payload, Product flow, exactly one property
  // entry resolving to the locked canonical property. They are evidence — no action is emitted.
  const flowSnapshots: JsonObject[] = [];
  const claimedFlows = new Set<string>();
  for (const flow of input.flows) {
    const row = isNamedRow(flow, 'read-only flow');
    const key = `${row.id}@${row.version}`;
    if (claimedFlows.has(key)) {
      invalid('Length*time plan repeats a read-only flow.', { id: row.id, version: row.version });
    }
    claimedFlows.add(key);
    if (!isProductFlowPayload(row.json)) {
      fail(LENGTH_TIME_SOURCE_SHAPE_INVALID, 'Length*time read-only flow must be a Product flow.', {
        id: row.id,
      });
    }
    const root = row.json['flowDataSet'] as JsonObject;
    const properties = (root['flowProperties'] as JsonObject)['flowProperty'];
    const entries = Array.isArray(properties)
      ? (properties.filter(isJsonObject) as JsonObject[])
      : isJsonObject(properties)
        ? [properties]
        : [];
    if (entries.length !== 1) {
      fail(
        LENGTH_TIME_SOURCE_SHAPE_INVALID,
        'Length*time read-only flow must carry exactly one property entry.',
        { id: row.id },
      );
    }
    const entry = entries[0] as JsonObject;
    const declared = referenceIdentity(entry['referenceToFlowPropertyDataSet']);
    if (declared.id !== targetProperty.id || declared.version !== targetProperty.version) {
      fail(
        LENGTH_TIME_SOURCE_SHAPE_INVALID,
        'Length*time read-only flow must resolve to the locked canonical property.',
        { id: row.id, declared: declared.id, version: declared.version },
      );
    }
    flowSnapshots.push({ id: row.id, version: row.version, sha256: sha256Json(row.json) });
  }

  const actions: JsonObject[] = [];
  const processIds = new Set<string>();
  let exchangeCount = 0;
  let unrelatedCount = 0;
  for (const process of input.processes) {
    const row = isNamedRow(process, 'process');
    const modifiedAt = (process as LengthTimeProcessRow).modified_at;
    if (
      typeof modifiedAt !== 'string' ||
      !TIMESTAMP.test(modifiedAt) ||
      Number.isNaN(Date.parse(modifiedAt))
    ) {
      invalid('Length*time process action requires its frozen modification timestamp.', {
        id: row.id,
      });
    }
    const key = `${row.id}@${row.version}`;
    if (processIds.has(key)) {
      invalid('Length*time plan repeats a process action.', { id: row.id, version: row.version });
    }
    processIds.add(key);
    const entries = exchangeEntries(row.json);
    if (entries === null) {
      invalid('Length*time process action requires an exchange array.', { id: row.id });
    }
    const instances = lengthTimeInstances(process as LengthTimeProcessRow, claimedFlows);
    if (instances.length === 0) {
      invalid('Length*time process carries no claimed occurrence to correct.', { id: row.id });
    }
    if (functionalUnitText(row.json) === null) {
      fail(
        LENGTH_TIME_PLAN_INVALID,
        'Length*time process must carry its functional-unit text so the readback can observe it.',
        { id: row.id },
      );
    }
    const desired = clone(row.json);
    const desiredExchanges = exchangeEntries(desired) as JsonObject[];
    for (const instance of instances) {
      const desiredExchange = desiredExchanges[instance.index] as JsonObject;
      desiredExchange['meanAmount'] = instance.after_literal;
      desiredExchange['resultingAmount'] = instance.after_literal;
    }
    if (sha256Json(desired) === sha256Json(row.json)) {
      invalid('Length*time process action would carry no real change.', { id: row.id });
    }
    exchangeCount += instances.length;
    unrelatedCount += entries.length - instances.length;
    actions.push({
      action_id: `process:${row.id}@${row.version}`,
      table: 'processes',
      id: row.id,
      version: row.version,
      expected_state_code: 0,
      expected_modified_at: modifiedAt,
      expected_json_ordered: row.json,
      desired_json_ordered: desired,
      before_sha256: sha256Json(row.json),
      desired_sha256: sha256Json(desired),
      mutation: { factor: LENGTH_TIME_FACTOR, exchanges: instances },
    });
  }
  // One canonical order, so the plan is a pure function of the claimed set rather than of the order
  // the operator happened to list its rows in.
  actions.sort((left, right) =>
    `${String(left['id'])}@${String(left['version'])}`.localeCompare(
      `${String(right['id'])}@${String(right['version'])}`,
    ),
  );

  // The reviewed factor and unit pair, checked against the declared evidence and the locked table.
  if (
    evidence.source_unit !== LENGTH_TIME_SOURCE_UNIT ||
    evidence.reference_unit !== LENGTH_TIME_REFERENCE_UNIT ||
    evidence.factor !== LENGTH_TIME_FACTOR
  ) {
    fail(
      LENGTH_TIME_EVIDENCE_MISMATCH,
      'Length*time source evidence must declare the reviewed kmy to m*a factor 1000.',
      {
        source_unit: evidence.source_unit,
        reference_unit: evidence.reference_unit,
        factor: evidence.factor,
      },
    );
  }
  const cohortSha256 = lengthTimeCohortSha256(input);
  if (cohortSha256 !== evidence.cohort_sha256 || exchangeCount !== evidence.instance_count) {
    fail(
      LENGTH_TIME_EVIDENCE_MISMATCH,
      'Length*time source evidence does not bind the exact before cohort this plan touches.',
      {
        recomputed_cohort_sha256: cohortSha256,
        expected_cohort_sha256: evidence.cohort_sha256,
        derived_instance_count: exchangeCount,
        expected_instance_count: evidence.instance_count,
      },
    );
  }

  const counts: JsonObject = {
    action_count: actions.length,
    batch_count: 1,
    exchange_count: exchangeCount,
    amount_field_count: exchangeCount * 2,
    unrelated_exchange_count: unrelatedCount,
    // One row audit per action, one batch summary, one plan summary.
    audit_count: actions.length + 2,
    flowproperty_count: 0,
    // No flow action exists in this profile: the observed flows are read-only snapshots.
    flow_count: 0,
    process_count: actions.length,
    derivative_target_count: actions.length,
    // The functional unit text stays correct: 1 kmy is 1000 m*a.
    text_action_count: 0,
  };
  if (input.expected_counts !== undefined) {
    for (const [key, value] of Object.entries(input.expected_counts)) {
      if (counts[key] !== value) {
        fail(
          LENGTH_TIME_COUNT_MISMATCH,
          'Length*time derived counts do not match the frozen cohort.',
          {
            key,
          },
        );
      }
    }
  }

  const plan: JsonObject = {
    schema_version: LENGTH_TIME_PLAN_SCHEMA,
    actor_id: input.actor_id,
    target_visibility: 'owner_draft',
    flow_snapshots: flowSnapshots,
    target_flow_property: {
      id: targetProperty.id,
      version: targetProperty.version,
      sha256: sha256Json(targetProperty.json),
    },
    target_unit_group: {
      id: targetUnitGroup.id,
      version: targetUnitGroup.version,
      sha256: sha256Json(targetUnitGroup.json),
    },
    source_evidence: {
      sha256: evidence.sha256,
      source_unit: evidence.source_unit,
      reference_unit: evidence.reference_unit,
      factor: evidence.factor,
      instance_count: exchangeCount,
    },
    expected: counts,
    actions,
  };
  plan['plan_sha256'] = sha256Json(plan);
  return { plan };
}

/**
 * The closed profile discriminator, shared by every protected artefact reader: a plan document's
 * own `schema_version` selects its rule set and nothing else does. There is no caller-supplied
 * function name, path or factor anywhere in the request, and an unknown version resolves to null so
 * every dispatch site fails closed before any state is touched.
 */
export type ProtectedPlanProfile = 'alias_v2' | 'length_time_v1';

export function protectedPlanProfile(value: unknown): ProtectedPlanProfile | null {
  if (!isJsonObject(value)) {
    return null;
  }
  if (value['schema_version'] === 'dataset-alias-plan.v2') {
    return 'alias_v2';
  }
  return value['schema_version'] === LENGTH_TIME_PLAN_SCHEMA ? 'length_time_v1' : null;
}

/**
 * The plan document a Length*time run may bind: exactly the ten reviewed keys, the owner-draft
 * visibility, the eleven numeric counts, the read-only flow snapshots, the canonical target pair,
 * the five-key source evidence and at least one action. A foreign or widened document is refused
 * before any freeze, seal or remote stage sees it.
 */
export function assertLengthTimePlanDocument(value: unknown): JsonObject {
  if (protectedPlanProfile(value) !== 'length_time_v1') {
    invalid('Length*time plan artefact must be dataset-length-time-plan.v1.');
  }
  const plan = value as JsonObject;
  const keys = Object.keys(plan);
  if (
    keys.length !== LENGTH_TIME_PLAN_KEYS.length ||
    !LENGTH_TIME_PLAN_KEYS.every((key) => Object.hasOwn(plan, key))
  ) {
    invalid('Length*time plan artefact must carry exactly its ten reviewed keys.');
  }
  if (plan['target_visibility'] !== 'owner_draft') {
    invalid('Length*time plan artefact must be an owner-draft plan.');
  }
  if (typeof plan['actor_id'] !== 'string' || !UUID.test(plan['actor_id'])) {
    invalid('Length*time plan artefact must carry its actor id.');
  }
  if (typeof plan['plan_sha256'] !== 'string' || !SHA256.test(plan['plan_sha256'])) {
    invalid('Length*time plan artefact must carry its own digest.');
  }
  const expected = plan['expected'];
  if (!isJsonObject(expected)) {
    invalid('Length*time plan artefact must carry its expected counts.');
  }
  const countKeys = Object.keys(expected);
  if (
    countKeys.length !== LENGTH_TIME_COUNT_KEYS.length ||
    !LENGTH_TIME_COUNT_KEYS.every((key) => Object.hasOwn(expected, key)) ||
    LENGTH_TIME_COUNT_KEYS.some(
      (key) => !Number.isSafeInteger(expected[key]) || (expected[key] as number) < 0,
    )
  ) {
    invalid('Length*time plan artefact must carry the eleven numeric reviewed counts.');
  }
  const snapshots = plan['flow_snapshots'];
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    invalid('Length*time plan artefact must carry its read-only flow snapshots.');
  }
  for (const snapshot of snapshots) {
    if (
      !isJsonObject(snapshot) ||
      Object.keys(snapshot).length !== 3 ||
      typeof snapshot['id'] !== 'string' ||
      typeof snapshot['version'] !== 'string' ||
      typeof snapshot['sha256'] !== 'string' ||
      !SHA256.test(snapshot['sha256'])
    ) {
      invalid('Length*time flow snapshots must carry exactly id, version and sha256.');
    }
  }
  for (const [key, label] of [
    ['target_flow_property', 'target flow property'],
    ['target_unit_group', 'target unit group'],
  ] as const) {
    const row = plan[key];
    if (
      !isJsonObject(row) ||
      Object.keys(row).length !== 3 ||
      typeof row['id'] !== 'string' ||
      !UUID.test(row['id']) ||
      typeof row['version'] !== 'string' ||
      !VERSION.test(row['version']) ||
      typeof row['sha256'] !== 'string' ||
      !SHA256.test(row['sha256'])
    ) {
      invalid(`Length*time plan artefact must bind its ${label} identity and digest.`);
    }
  }
  const evidence = plan['source_evidence'];
  if (
    !isJsonObject(evidence) ||
    Object.keys(evidence).length !== 5 ||
    typeof evidence['sha256'] !== 'string' ||
    !SHA256.test(evidence['sha256']) ||
    typeof evidence['source_unit'] !== 'string' ||
    typeof evidence['reference_unit'] !== 'string' ||
    typeof evidence['factor'] !== 'string' ||
    !Number.isSafeInteger(evidence['instance_count'])
  ) {
    invalid('Length*time plan artefact must bind its five-key source evidence.');
  }
  const actions = plan['actions'];
  if (!Array.isArray(actions) || actions.length === 0) {
    invalid('Length*time plan artefact must carry its actions.');
  }
  for (const action of actions) {
    if (
      !isJsonObject(action) ||
      action['table'] !== 'processes' ||
      typeof action['id'] !== 'string' ||
      !UUID.test(action['id']) ||
      typeof action['version'] !== 'string' ||
      !VERSION.test(action['version']) ||
      typeof action['before_sha256'] !== 'string' ||
      !SHA256.test(action['before_sha256']) ||
      typeof action['desired_sha256'] !== 'string' ||
      !SHA256.test(action['desired_sha256']) ||
      !isJsonObject(action['mutation']) ||
      !isJsonObject(action['expected_json_ordered']) ||
      !isJsonObject(action['desired_json_ordered'])
    ) {
      invalid('Length*time plan actions must be complete owner-draft process actions.');
    }
  }
  return plan;
}
