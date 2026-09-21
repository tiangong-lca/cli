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

const FUNCTIONAL_UNIT_RULE = /^(1|1\.0)(\s+)a(\s.*)$/u;

export type AliasV2Row = { id: string; version: string; json: JsonObject };

export type AliasV2ProcessRow = AliasV2Row & {
  exchange_indexes: number[];
  functional_unit?: { source_exchange_number: string };
};

export type AliasV2PlanInput = {
  actor_id: string;
  flows: AliasV2Row[];
  processes: AliasV2ProcessRow[];
  target_flow_property: AliasV2Row;
  target_unit_group: AliasV2Row;
  source_unit_group: AliasV2Row;
  /** The reviewed reference object a flow writes when it adopts the target flow property. */
  target_flow_property_reference: JsonObject;
  source_evidence_sha256: string;
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
function flowPropertyEntries(payload: JsonObject): JsonObject[] | null {
  const root = payload['flowDataSet'];
  const properties = isJsonObject(root) ? root['flowProperties'] : null;
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
    typeof input.source_evidence_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.source_evidence_sha256)
  ) {
    invalid('Alias v2 plan requires the source evidence sha256.');
  }
  const target = input.target_flow_property;
  // The reviewed target template is the canonical five-key reference or the plan is refused.
  const canonicalTargetReference = assertCanonicalFlowPropertyReference(
    input.target_flow_property_reference,
  );
  const targetReference = referenceIdentity(canonicalTargetReference);
  if (targetReference.id !== target.id) {
    invalid('Alias v2 target flow property reference must bind the target snapshot id.');
  }
  if (targetReference.version !== target.version) {
    invalid('Alias v2 target flow property reference must bind the target snapshot version.');
  }

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
      if (typeof sourceNumber !== 'string' || sourceNumber.trim() === '') {
        fail(
          ALIAS_V2_TEXT_RULE_VIOLATION,
          'Alias v2 text action requires its source exchange number.',
          {
            id: process.id,
          },
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
      const afterText = `${match[1] as string}${match[2] as string}hr${match[3] as string}`;
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

  const counts: JsonObject = {
    action_count: actions.length,
    flowproperty_count: 0,
    flow_count: input.flows.length,
    process_count: input.processes.length,
    exchange_count: exchangeCount,
    amount_field_count: amountFieldCount,
    unrelated_exchange_count: unrelatedCount,
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
    source_evidence: {
      sha256: input.source_evidence_sha256,
      exchange_count: counts['exchange_count'],
      source_unitgroup: {
        id: input.source_unit_group.id,
        version: input.source_unit_group.version,
        sha256: sha256Json(input.source_unit_group.json),
      },
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
    counts,
    dimensions: [
      {
        dimension: 'time',
        factor: ALIAS_V2_FACTOR,
        source_unitgroup: {
          id: input.source_unit_group.id,
          version: input.source_unit_group.version,
        },
        target_unitgroup: {
          id: input.target_unit_group.id,
          version: input.target_unit_group.version,
        },
      },
    ],
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
