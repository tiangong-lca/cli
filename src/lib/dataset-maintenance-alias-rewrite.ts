import { FlowPropertySchema, FlowSchema, ProcessSchema } from '@tiangong-lca/tidas-sdk';
import {
  isJsonObject,
  maintenanceRowKey,
  sha256Json,
  type DatasetMaintenanceAliasBatch,
  type DatasetMaintenanceAliasBatchPlan,
  type DatasetMaintenanceAliasExchangeRewrite,
  type DatasetMaintenanceBlocker,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type DatasetMaintenanceScope,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import type { SafeParseSchema } from './tidas-sdk-validation.js';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';

export type DatasetMaintenanceAliasSchemas = {
  flowproperties: SafeParseSchema;
  flows: SafeParseSchema;
  processes: SafeParseSchema;
};

const DEFAULT_ALIAS_SCHEMAS: DatasetMaintenanceAliasSchemas = {
  flowproperties: FlowPropertySchema as unknown as SafeParseSchema,
  flows: FlowSchema as unknown as SafeParseSchema,
  processes: withOptionalReviewReportReference(
    ProcessSchema as unknown as SafeParseSchema,
    'processes',
  ),
};

const ALIAS_PROFILES = {
  time: {
    factor: '0.00011415525114155251',
    rows: 25,
    flowproperties: 1,
    flows: 10,
    processes: 14,
    exchanges: 20,
    target_flow_refs: 106,
    target_exchange_refs: 441,
  },
  length_time: {
    factor: '1000',
    rows: 27,
    flowproperties: 1,
    flows: 13,
    processes: 13,
    exchanges: 39,
    target_flow_refs: 32,
    target_exchange_refs: 3216,
  },
} as const;

const EXPECTED_UNRELATED_EXCHANGES = 309;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

type DecimalParts = { negative: boolean; coefficient: bigint; scale: number };

function decimalParts(value: string): DecimalParts | null {
  if (value.length > 256 || !DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  return {
    negative,
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function decimalEqual(left: string, right: string): boolean {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) return false;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale);
  const rightCoefficient = rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale);
  return (
    leftCoefficient === rightCoefficient &&
    (leftCoefficient === 0n || leftParts.negative === rightParts.negative)
  );
}

function decimalText(parts: DecimalParts): string {
  let digits = parts.coefficient.toString().padStart(parts.scale + 1, '0');
  if (parts.scale) {
    const split = digits.length - parts.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return `${parts.negative && parts.coefficient !== 0n ? '-' : ''}${digits}`;
}

export function multiplyExactDecimal(value: string, factor: string): string | null {
  const left = decimalParts(value);
  const right = decimalParts(factor);
  if (!left || !right) {
    return null;
  }
  return decimalText({
    negative: left.negative !== right.negative,
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function aliasBlocker(
  action: DatasetMaintenancePlanAction,
  code: string,
  message: string,
  details?: unknown,
): DatasetMaintenanceBlocker {
  return {
    code,
    message,
    action_id: action.action_id,
    table: action.table,
    id: action.id,
    version: action.version,
    ...(details === undefined ? {} : { details }),
  };
}

function firstAction(
  actions: DatasetMaintenancePlanAction[],
  batchId: string,
): DatasetMaintenancePlanAction | null {
  return actions.find((action) => action.batch_id === batchId) ?? null;
}

function addBatchBlocker(
  actions: DatasetMaintenancePlanAction[],
  batchId: string,
  code: string,
  message: string,
  details?: unknown,
): void {
  const action = firstAction(actions, batchId);
  if (!action) {
    return;
  }
  action.blockers.push(aliasBlocker(action, code, message, details));
  action.status = 'blocked';
}

function clonePayload(payload: JsonObject): JsonObject {
  return structuredClone(payload);
}

function flowPropertyEntries(payload: JsonObject): JsonObject[] | null {
  const root = payload.flowDataSet;
  const properties = isJsonObject(root) ? root.flowProperties : null;
  const value = isJsonObject(properties) ? properties.flowProperty : null;
  if (Array.isArray(value)) {
    return value.every(isJsonObject) ? value : null;
  }
  return isJsonObject(value) ? [value] : null;
}

function flowPropertySingleton(payload: JsonObject): JsonObject | null {
  const root = payload.flowDataSet;
  const properties = isJsonObject(root) ? root.flowProperties : null;
  const value = isJsonObject(properties) ? properties.flowProperty : null;
  return isJsonObject(value) ? value : null;
}

function processExchangeEntries(payload: JsonObject): JsonObject[] | null {
  const root = payload.processDataSet;
  const exchanges = isJsonObject(root) ? root.exchanges : null;
  const value = isJsonObject(exchanges) ? exchanges.exchange : null;
  if (Array.isArray(value)) {
    return value.every(isJsonObject) ? value : null;
  }
  return isJsonObject(value) ? [value] : null;
}

function referenceIdentity(value: unknown): { id: string | null; version: string | null } {
  return isJsonObject(value)
    ? {
        id: typeof value['@refObjectId'] === 'string' ? value['@refObjectId'] : null,
        version: typeof value['@version'] === 'string' ? value['@version'] : null,
      }
    : { id: null, version: null };
}

function referenceMatches(value: unknown, id: string, version?: string | null): boolean {
  const identity = referenceIdentity(value);
  return identity.id === id && (!version || identity.version === version);
}

function entityRefKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function targetSnapshotValid(
  snapshot: DatasetMaintenanceRowSnapshot | null,
  table: 'unitgroups' | 'flowproperties',
  batch: DatasetMaintenanceAliasBatch,
  userId: string,
): boolean {
  const target = table === 'unitgroups' ? batch.target.unitgroup : batch.target.flowproperty;
  return Boolean(
    snapshot &&
    snapshot.table === table &&
    snapshot.id === target.id &&
    snapshot.version === target.version &&
    snapshot.user_id === userId &&
    snapshot.state_code === 0 &&
    snapshot.modified_at &&
    snapshot.json_ordered &&
    snapshot.payload_sha256,
  );
}

function sourceUnitGroupSnapshotValid(
  snapshot: DatasetMaintenanceRowSnapshot | null,
  batch: DatasetMaintenanceAliasBatch,
  userId: string,
): boolean {
  return Boolean(
    snapshot &&
    snapshot.table === 'unitgroups' &&
    snapshot.id === batch.source.unitgroup.id &&
    snapshot.version === batch.source.unitgroup.version &&
    snapshot.user_id === userId &&
    snapshot.state_code === 0 &&
    snapshot.modified_at &&
    snapshot.json_ordered &&
    snapshot.payload_sha256,
  );
}

function sourceReferenceUnit(
  snapshot: DatasetMaintenanceRowSnapshot | null,
  batch: DatasetMaintenanceAliasBatch,
): JsonObject | null {
  const root = snapshot?.json_ordered?.unitGroupDataSet;
  const information = isJsonObject(root) ? root.unitGroupInformation : null;
  const quantitative = isJsonObject(information) ? information.quantitativeReference : null;
  const referenceId = isJsonObject(quantitative) ? quantitative.referenceToReferenceUnit : null;
  const units = isJsonObject(root) ? root.units : null;
  const raw = isJsonObject(units) ? units.unit : null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const reference = entries.find(
    (entry) => isJsonObject(entry) && entry['@dataSetInternalID'] === referenceId,
  );
  const expectedName = batch.dimension === 'time' ? 'hr' : 'kmy';
  return isJsonObject(reference) &&
    reference.name === expectedName &&
    typeof reference.meanValue === 'string' &&
    decimalEqual(reference.meanValue, '1')
    ? clonePayload(reference)
    : null;
}

function targetConversionUnit(options: {
  source: JsonObject | null;
  target: DatasetMaintenanceRowSnapshot | null;
  factor: string;
}): JsonObject | null {
  const sourceName = options.source?.name;
  const root = options.target?.json_ordered?.unitGroupDataSet;
  const units = isJsonObject(root) ? root.units : null;
  const raw = isJsonObject(units) ? units.unit : null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const match = entries.find(
    (entry) =>
      isJsonObject(entry) &&
      entry.name === sourceName &&
      typeof entry.meanValue === 'string' &&
      decimalEqual(entry.meanValue, options.factor),
  );
  return isJsonObject(match) ? clonePayload(match) : null;
}

function targetUnitGroupReferenceFromFlowProperty(
  snapshot: DatasetMaintenanceRowSnapshot | null,
  batch: DatasetMaintenanceAliasBatch,
): JsonObject | null {
  const root = snapshot?.json_ordered?.flowPropertyDataSet;
  const information = isJsonObject(root) ? root.flowPropertiesInformation : null;
  const quantitative = isJsonObject(information) ? information.quantitativeReference : null;
  const reference = isJsonObject(quantitative) ? quantitative.referenceToReferenceUnitGroup : null;
  return isJsonObject(reference) &&
    referenceMatches(reference, batch.target.unitgroup.id, batch.target.unitgroup.version)
    ? clonePayload(reference)
    : null;
}

function canonicalFlowPropertyReference(
  rows: DatasetMaintenanceRemoteRow[],
  batch: DatasetMaintenanceAliasBatch,
): JsonObject | null {
  const references = rows
    .filter((row) => row.table === 'flows' && row.json_ordered)
    .flatMap((row) => flowPropertyEntries(row.json_ordered!) ?? [])
    .map((entry) => entry.referenceToFlowPropertyDataSet)
    .filter(
      (reference): reference is JsonObject =>
        isJsonObject(reference) &&
        referenceMatches(
          reference,
          batch.target.flowproperty.id,
          batch.target.flowproperty.version,
        ),
    );
  const unique = new Map(references.map((reference) => [sha256Json(reference), reference]));
  return unique.size === 1 ? clonePayload([...unique.values()][0]!) : null;
}

function replaceAliasFlowProperty(
  payload: JsonObject,
  batch: DatasetMaintenanceAliasBatch,
  targetReference: JsonObject,
): JsonObject | null {
  const desired = clonePayload(payload);
  const root = desired.flowPropertyDataSet;
  const information = isJsonObject(root) ? root.flowPropertiesInformation : null;
  const quantitative = isJsonObject(information) ? information.quantitativeReference : null;
  if (
    !isJsonObject(quantitative) ||
    !referenceMatches(
      quantitative.referenceToReferenceUnitGroup,
      batch.source.unitgroup.id,
      batch.source.unitgroup.version,
    )
  ) {
    return null;
  }
  quantitative.referenceToReferenceUnitGroup = clonePayload(targetReference);
  return desired;
}

function replaceFlowReferenceProperty(
  payload: JsonObject,
  batch: DatasetMaintenanceAliasBatch,
  targetReference: JsonObject,
): JsonObject | null {
  const desired = clonePayload(payload);
  const matching = flowPropertySingleton(desired);
  if (
    !matching ||
    !referenceMatches(
      matching.referenceToFlowPropertyDataSet,
      batch.source.flowproperty.id,
      batch.source.flowproperty.version,
    ) ||
    matching['@dataSetInternalID'] !== '1' ||
    typeof matching.meanValue !== 'string' ||
    !decimalEqual(matching.meanValue, '1')
  ) {
    return null;
  }
  matching.referenceToFlowPropertyDataSet = clonePayload(targetReference);
  return desired;
}

function rewriteProcessExchanges(options: {
  payload: JsonObject;
  action: DatasetMaintenancePlanAction;
  batch: DatasetMaintenanceAliasBatch;
}): { payload: JsonObject; rewrites: DatasetMaintenanceAliasExchangeRewrite[] } | null {
  const desired = clonePayload(options.payload);
  const exchanges = processExchangeEntries(desired);
  if (!exchanges || !options.action.exchange_instances) {
    return null;
  }
  const rewrites: DatasetMaintenanceAliasExchangeRewrite[] = [];
  for (const instance of options.action.exchange_instances) {
    const exchange = exchanges[instance.exchange_index];
    if (
      !exchange ||
      exchange['@dataSetInternalID'] !== instance.data_set_internal_id ||
      !referenceMatches(exchange.referenceToFlowDataSet, instance.flow_id, instance.flow_version) ||
      exchange.exchangeDirection !== instance.direction ||
      sha256Json(exchange) !== instance.before_exchange_sha256 ||
      exchange.meanAmount !== instance.before_mean_amount ||
      exchange.resultingAmount !== instance.before_resulting_amount ||
      typeof exchange.exchangeDirection !== 'string'
    ) {
      return null;
    }
    const afterMean = multiplyExactDecimal(instance.before_mean_amount, options.batch.factor);
    const afterResulting = multiplyExactDecimal(
      instance.before_resulting_amount,
      options.batch.factor,
    );
    if (afterMean === null || afterResulting === null) {
      return null;
    }
    exchange.meanAmount = afterMean;
    exchange.resultingAmount = afterResulting;
    rewrites.push({
      ...instance,
      action_id: options.action.action_id,
      process_id: options.action.id,
      process_version: options.action.version,
      after_mean_amount: afterMean,
      after_resulting_amount: afterResulting,
      after_exchange_sha256: sha256Json(exchange),
    });
  }
  return { payload: desired, rewrites };
}

function countFlowPropertyRefs(
  rows: DatasetMaintenanceRemoteRow[],
  flowpropertyId: string,
  flowpropertyVersion: string,
): number {
  return rows
    .filter((row) => row.table === 'flows' && row.json_ordered)
    .flatMap((row) => flowPropertyEntries(row.json_ordered!) ?? [])
    .filter((entry) =>
      referenceMatches(entry.referenceToFlowPropertyDataSet, flowpropertyId, flowpropertyVersion),
    ).length;
}

function countUnitGroupRefs(
  rows: DatasetMaintenanceRemoteRow[],
  unitgroupId: string,
  unitgroupVersion: string,
): number {
  return rows.filter((row) => {
    if (row.table !== 'flowproperties' || !row.json_ordered) return false;
    const root = row.json_ordered.flowPropertyDataSet;
    const information = isJsonObject(root) ? root.flowPropertiesInformation : null;
    const quantitative = isJsonObject(information) ? information.quantitativeReference : null;
    return (
      isJsonObject(quantitative) &&
      referenceMatches(quantitative.referenceToReferenceUnitGroup, unitgroupId, unitgroupVersion)
    );
  }).length;
}

function flowsWithProperty(
  rows: DatasetMaintenanceRemoteRow[],
  flowpropertyId: string,
  flowpropertyVersion: string,
): Set<string> {
  return new Set(
    rows
      .filter(
        (row) =>
          row.table === 'flows' &&
          row.json_ordered &&
          (flowPropertyEntries(row.json_ordered) ?? []).some((entry) =>
            referenceMatches(
              entry.referenceToFlowPropertyDataSet,
              flowpropertyId,
              flowpropertyVersion,
            ),
          ),
      )
      .map((row) => entityRefKey(row.id, row.version)),
  );
}

function countExchangeFlowRefs(rows: DatasetMaintenanceRemoteRow[], flowRefs: Set<string>): number {
  return rows
    .filter((row) => row.table === 'processes' && row.json_ordered)
    .flatMap((row) => processExchangeEntries(row.json_ordered!) ?? [])
    .filter((exchange) => {
      const identity = referenceIdentity(exchange.referenceToFlowDataSet);
      return (
        identity.id !== null &&
        identity.version !== null &&
        flowRefs.has(entityRefKey(identity.id, identity.version))
      );
    }).length;
}

function exchangeClosureKeys(
  rows: DatasetMaintenanceRemoteRow[],
  flowRefs: Set<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows.filter((entry) => entry.table === 'processes' && entry.json_ordered)) {
    for (const [index, exchange] of (processExchangeEntries(row.json_ordered!) ?? []).entries()) {
      const identity = referenceIdentity(exchange.referenceToFlowDataSet);
      if (
        identity.id &&
        identity.version &&
        flowRefs.has(entityRefKey(identity.id, identity.version))
      ) {
        keys.add(
          `${row.id}\u0000${row.version}\u0000${index}\u0000${String(exchange['@dataSetInternalID'])}\u0000${identity.id}\u0000${identity.version}`,
        );
      }
    }
  }
  return keys;
}

function selectorClosureKeys(actions: DatasetMaintenancePlanAction[]): Set<string> {
  return new Set(
    actions.flatMap((action) =>
      (action.exchange_instances ?? []).map(
        (instance) =>
          `${action.id}\u0000${action.version}\u0000${instance.exchange_index}\u0000${instance.data_set_internal_id}\u0000${instance.flow_id}\u0000${instance.flow_version}`,
      ),
    ),
  );
}

function projectRows(
  rows: DatasetMaintenanceRemoteRow[],
  desiredPayloads: Map<string, JsonObject>,
  actions: DatasetMaintenancePlanAction[],
): DatasetMaintenanceRemoteRow[] {
  const actionByKey = new Map(actions.map((action) => [maintenanceRowKey(action), action]));
  return rows.map((row) => {
    const action = actionByKey.get(maintenanceRowKey(row));
    const desired = action ? desiredPayloads.get(action.action_id) : null;
    return desired ? { ...row, json_ordered: desired } : row;
  });
}

export function buildAliasRewritePlan(options: {
  scope: DatasetMaintenanceScope;
  actions: DatasetMaintenancePlanAction[];
  accountRows: DatasetMaintenanceRemoteRow[];
  targetSnapshots: Map<string, DatasetMaintenanceAliasBatchPlan['target_snapshots']>;
  schemas?: DatasetMaintenanceAliasSchemas;
}): {
  desired_payloads: Map<string, JsonObject>;
  batches: DatasetMaintenanceAliasBatchPlan[];
} {
  const batches = options.scope.alias_batches ?? [];
  const schemas = options.schemas ?? DEFAULT_ALIAS_SCHEMAS;
  const desiredPayloads = new Map<string, JsonObject>();
  const batchPlans: DatasetMaintenanceAliasBatchPlan[] = [];

  for (const batch of batches) {
    const profile = ALIAS_PROFILES[batch.dimension];
    const actions = options.actions.filter((action) => action.batch_id === batch.batch_id);
    const byTable = {
      flowproperties: actions.filter((action) => action.table === 'flowproperties'),
      flows: actions.filter((action) => action.table === 'flows'),
      processes: actions.filter((action) => action.table === 'processes'),
    };
    const targetSnapshots = options.targetSnapshots.get(batch.batch_id) ?? {
      unitgroup: null,
      flowproperty: null,
      source_unitgroup: null,
    };
    const targetUnitGroupReference = targetUnitGroupReferenceFromFlowProperty(
      targetSnapshots.flowproperty,
      batch,
    );
    const targetFlowPropertyReference = canonicalFlowPropertyReference(options.accountRows, batch);
    if (
      actions.length !== profile.rows ||
      byTable.flowproperties.length !== profile.flowproperties ||
      byTable.flows.length !== profile.flows ||
      byTable.processes.length !== profile.processes
    ) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_BATCH_ROW_COUNTS_MISMATCH',
        'Alias batch row/table counts do not match the frozen dimension profile.',
        {
          profile,
          observed: {
            rows: actions.length,
            ...Object.fromEntries(
              Object.entries(byTable).map(([key, value]) => [key, value.length]),
            ),
          },
        },
      );
    }
    if (
      byTable.flowproperties[0]?.id !== batch.source.flowproperty.id ||
      byTable.flowproperties[0]?.version !== batch.source.flowproperty.version
    ) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_SOURCE_FLOWPROPERTY_ACTION_MISMATCH',
        'The one flowproperty action must target the frozen source flowproperty.',
      );
    }
    if (
      !targetSnapshotValid(
        targetSnapshots.unitgroup,
        'unitgroups',
        batch,
        options.scope.account.user_id,
      ) ||
      !targetSnapshotValid(
        targetSnapshots.flowproperty,
        'flowproperties',
        batch,
        options.scope.account.user_id,
      ) ||
      !sourceUnitGroupSnapshotValid(
        targetSnapshots.source_unitgroup,
        batch,
        options.scope.account.user_id,
      )
    ) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_SUPPORT_NOT_OWNER_DRAFT',
        'Source and target FP/UG support must be exact current-owner state_code=0 drafts.',
      );
    }
    const referenceUnit = sourceReferenceUnit(targetSnapshots.source_unitgroup, batch);
    const conversionUnit = targetConversionUnit({
      source: referenceUnit,
      target: targetSnapshots.unitgroup,
      factor: batch.factor,
    });
    if (
      !targetUnitGroupReference ||
      !targetFlowPropertyReference ||
      !referenceUnit ||
      !conversionUnit
    ) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_TARGET_REFERENCE_INVALID',
        'Target references could not be derived from the frozen owner-draft support rows.',
      );
    }

    const exchangeRewrites: DatasetMaintenanceAliasExchangeRewrite[] = [];
    for (const action of actions) {
      const payload = action.before?.json_ordered;
      let desired: JsonObject | null = null;
      if (payload && action.table === 'flowproperties' && targetUnitGroupReference) {
        desired = replaceAliasFlowProperty(payload, batch, targetUnitGroupReference);
      } else if (payload && action.table === 'flows' && targetFlowPropertyReference) {
        desired = replaceFlowReferenceProperty(payload, batch, targetFlowPropertyReference);
      } else if (payload && action.table === 'processes') {
        const result = rewriteProcessExchanges({ payload, action, batch });
        desired = result?.payload ?? null;
        exchangeRewrites.push(...(result?.rewrites ?? []));
      }
      const schema =
        action.table === 'flowproperties'
          ? schemas.flowproperties
          : action.table === 'flows'
            ? schemas.flows
            : schemas.processes;
      if (
        !desired ||
        (payload && sha256Json(desired) === sha256Json(payload)) ||
        !schema.safeParse(desired).success
      ) {
        action.blockers.push(
          aliasBlocker(
            action,
            'ALIAS_DESIRED_PAYLOAD_INVALID',
            'The exact authorized alias rewrite could not be generated from the frozen row.',
          ),
        );
        action.status = 'blocked';
      } else {
        desiredPayloads.set(action.action_id, desired);
        if (action.table === 'flowproperties') {
          action.alias_mutation = { kind: 'flowproperty_unitgroup_reference' };
        } else if (action.table === 'flows') {
          const entry = flowPropertySingleton(payload!);
          const internalId = entry?.['@dataSetInternalID'];
          if (typeof internalId === 'string') {
            action.alias_mutation = {
              kind: 'flow_flowproperty_reference',
              flow_property_internal_id: internalId,
              source_flowproperty_id: batch.source.flowproperty.id,
              source_flowproperty_version: batch.source.flowproperty.version,
            };
          }
        } else {
          action.alias_mutation = {
            kind: 'process_exchange_amounts',
            exchanges: action.exchange_instances!.map((instance) => ({
              index: instance.exchange_index,
              internal_id: instance.data_set_internal_id,
              flow_id: instance.flow_id,
              flow_version: instance.flow_version,
              direction: instance.direction,
              before_exchange_sha256: instance.before_exchange_sha256,
            })),
          };
        }
      }
    }

    const sourceFlowIds = new Set(
      byTable.flows.map((action) => entityRefKey(action.id, action.version)),
    );
    const observedSourceFlowIds = flowsWithProperty(
      options.accountRows,
      batch.source.flowproperty.id,
      batch.source.flowproperty.version,
    );
    const observedClosure = exchangeClosureKeys(options.accountRows, sourceFlowIds);
    const selectedClosure = selectorClosureKeys(byTable.processes);
    if (
      sha256Json([...sourceFlowIds].sort()) !== sha256Json([...observedSourceFlowIds].sort()) ||
      sha256Json([...observedClosure].sort()) !== sha256Json([...selectedClosure].sort())
    ) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_REFERENCE_CLOSURE_MISMATCH',
        'Flow actions and frozen exchange selectors do not exactly cover the source alias closure.',
        {
          action_flow_ids: [...sourceFlowIds].sort(),
          observed_flow_ids: [...observedSourceFlowIds].sort(),
          observed_exchanges: observedClosure.size,
          selected_exchanges: selectedClosure.size,
        },
      );
    }
    if (exchangeRewrites.length !== profile.exchanges) {
      addBatchBlocker(
        options.actions,
        batch.batch_id,
        'ALIAS_EXCHANGE_COUNT_MISMATCH',
        'Scaled exchange count does not match the frozen dimension profile.',
        { expected: profile.exchanges, actual: exchangeRewrites.length },
      );
    }
    const processExchangeCount = byTable.processes.reduce(
      (sum, action) =>
        sum + (processExchangeEntries(action.before?.json_ordered ?? {})?.length ?? 0),
      0,
    );
    batchPlans.push({
      ...batch,
      action_ids: actions.map((action) => action.action_id),
      target_snapshots: targetSnapshots,
      conversion_evidence: {
        source_unitgroup_payload_sha256: targetSnapshots.source_unitgroup?.payload_sha256 ?? null,
        source_reference_unit: referenceUnit,
        target_conversion_unit: conversionUnit,
      },
      exchange_rewrites: exchangeRewrites,
      summary: {
        rows: actions.length,
        flowproperties: byTable.flowproperties.length,
        flows: byTable.flows.length,
        processes: byTable.processes.length,
        exchanges: exchangeRewrites.length,
        amount_fields: exchangeRewrites.length * 2,
        unrelated_exchanges: processExchangeCount - exchangeRewrites.length,
      },
      postconditions: {
        source_unitgroup_incoming_refs: -1,
        source_flowproperty_flow_refs: -1,
        target_flow_refs: -1,
        target_exchange_refs: -1,
      },
    });
  }

  const projected = projectRows(options.accountRows, desiredPayloads, options.actions);
  for (const batchPlan of batchPlans) {
    const targetFlows = flowsWithProperty(
      projected,
      batchPlan.target.flowproperty.id,
      batchPlan.target.flowproperty.version,
    );
    batchPlan.postconditions = {
      source_unitgroup_incoming_refs: countUnitGroupRefs(
        projected,
        batchPlan.source.unitgroup.id,
        batchPlan.source.unitgroup.version,
      ),
      source_flowproperty_flow_refs: countFlowPropertyRefs(
        projected,
        batchPlan.source.flowproperty.id,
        batchPlan.source.flowproperty.version,
      ),
      target_flow_refs: targetFlows.size,
      target_exchange_refs: countExchangeFlowRefs(projected, targetFlows),
    };
    const profile = ALIAS_PROFILES[batchPlan.dimension];
    if (
      batchPlan.postconditions.source_unitgroup_incoming_refs !== 0 ||
      batchPlan.postconditions.source_flowproperty_flow_refs !== 0 ||
      batchPlan.postconditions.target_flow_refs !== profile.target_flow_refs ||
      batchPlan.postconditions.target_exchange_refs !== profile.target_exchange_refs
    ) {
      addBatchBlocker(
        options.actions,
        batchPlan.batch_id,
        'ALIAS_POSTCONDITIONS_MISMATCH',
        'Projected alias reference counts do not match the frozen postconditions.',
        { expected: profile, actual: batchPlan.postconditions },
      );
    }
  }
  const unrelated = batchPlans.reduce((sum, batch) => sum + batch.summary.unrelated_exchanges, 0);
  if (unrelated !== EXPECTED_UNRELATED_EXCHANGES) {
    addBatchBlocker(
      options.actions,
      batchPlans[0]?.batch_id ?? '',
      'ALIAS_UNRELATED_EXCHANGE_COUNT_MISMATCH',
      'The exact process closure must preserve 309 unrelated exchanges.',
      { expected: EXPECTED_UNRELATED_EXCHANGES, actual: unrelated },
    );
  }
  return { desired_payloads: desiredPayloads, batches: batchPlans };
}

export const __testInternals = {
  ALIAS_PROFILES,
  EXPECTED_UNRELATED_EXCHANGES,
  countExchangeFlowRefs,
  countFlowPropertyRefs,
  countUnitGroupRefs,
  decimalEqual,
  decimalParts,
  decimalText,
  exchangeClosureKeys,
  flowPropertyEntries,
  flowPropertySingleton,
  flowsWithProperty,
  processExchangeEntries,
  projectRows,
  referenceIdentity,
  referenceMatches,
  replaceAliasFlowProperty,
  replaceFlowReferenceProperty,
  rewriteProcessExchanges,
  selectorClosureKeys,
  targetUnitGroupReferenceFromFlowProperty,
  canonicalFlowPropertyReference,
  targetSnapshotValid,
  sourceReferenceUnit,
  sourceUnitGroupSnapshotValid,
  targetConversionUnit,
};
