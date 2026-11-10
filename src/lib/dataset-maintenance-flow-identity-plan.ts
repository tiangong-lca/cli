import path from 'node:path';
import {
  computeFlowIdentityCaptureSha256,
  computeFlowIdentityMappingId,
  computeFlowIdentityPlanSha256,
  computeFlowIdentityProcessTemplateSha256,
  extractFlowIdentityReference,
  parseFlowIdentityCapture,
  parseFlowIdentityPolicy,
  parseFlowIdentityReference,
  parseFlowIdentityReviewLedger,
  type FlowIdentityCollisionEntry,
  type FlowIdentityCollisionLedger,
  type FlowIdentityCompatibilityPolicy,
  type FlowIdentityCaptureRequest,
  type FlowIdentityDirection,
  type FlowIdentityLiveCapture,
  type FlowIdentityMapping,
  type FlowIdentityMappingEndpoint,
  type FlowIdentityOccurrence,
  type FlowIdentityPlan,
  type FlowIdentityPlanBundle,
  type FlowIdentityProcessManifest,
  type FlowIdentityProcessTemplate,
  type FlowIdentityProtectedClosure,
  type FlowIdentityProtectedReferenceEntry,
  type FlowIdentityReference,
  type FlowIdentityReviewEntry,
  type FlowIdentityReviewLedger,
  type FlowIdentityRewrite,
  type FlowIdentitySupportSnapshot,
} from './dataset-maintenance-flow-identity-contract.js';
import { flowIdentityRestrictedSha256 } from './dataset-maintenance-flow-identity-wire.js';
import {
  ensurePrivateArtifactDirectory,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import {
  isJsonObject,
  maintenanceRowKey,
  snapshotRemoteRow,
} from './maintenance/contract/values.js';
import { sha256Json, stableJsonText } from './canonical-json-hash.js';
import {
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceRowSnapshot,
  type JsonObject,
} from './maintenance/contract/types.js';
import { CliError } from '../shared/errors.js';
import {
  validateFlowPayload,
  type FlowPayloadValidationResult,
} from './flow-payload-validation.js';
import {
  validateProcessPayload,
  type ProcessPayloadValidationResult,
} from './process-payload-validation.js';

export type ValidationDeps = {
  validateFlow: (payload: JsonObject) => FlowPayloadValidationResult;
  validateProcess: (payload: JsonObject) => ProcessPayloadValidationResult;
};

export type BuildFlowIdentityPlanOptions = {
  policy: unknown;
  reviewLedger: unknown;
  liveCapture: unknown;
  now?: Date;
  validation?: Partial<ValidationDeps>;
};

export type RunFlowIdentityPlanOptions = BuildFlowIdentityPlanOptions & { outDir: string };

const POSTGREST_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00:00$/u;

function fail(
  message: string,
  code = 'DATASET_FLOW_IDENTITY_PLAN_INVALID',
  details?: unknown,
): never {
  throw new CliError(message, { code, exitCode: 1, ...(details === undefined ? {} : { details }) });
}

function rowKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function requireSnapshotIntegrity(row: DatasetMaintenanceRowSnapshot): void {
  const remote: DatasetMaintenanceRemoteRow = {
    table: row.table,
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    modified_at: row.modified_at,
    json_ordered: row.json_ordered,
    model_id: row.model_id,
    rule_verification: row.rule_verification,
  };
  const expected = snapshotRemoteRow(remote);
  if (expected.row_sha256 !== row.row_sha256 || expected.payload_sha256 !== row.payload_sha256) {
    fail('Live capture contains a row whose canonical snapshot hash is invalid.', undefined, {
      table: row.table,
      id: row.id,
      version: row.version,
    });
  }
}

function indexRows(
  rows: DatasetMaintenanceRowSnapshot[],
  table: DatasetMaintenanceRowSnapshot['table'],
): Map<string, DatasetMaintenanceRowSnapshot> {
  const selected = rows.filter((row) => row.table === table);
  selected.forEach(requireSnapshotIntegrity);
  const index = new Map(selected.map((row) => [rowKey(row.id, row.version), row]));
  if (index.size !== selected.length) fail(`Live capture contains duplicate ${table} rows.`);
  return index;
}

function arrayOfObjects(value: unknown): JsonObject[] | null {
  const rows = Array.isArray(value) ? value : isJsonObject(value) ? [value] : null;
  return rows?.every(isJsonObject) ? rows : null;
}

function flowRoot(payload: JsonObject): JsonObject | null {
  return isJsonObject(payload.flowDataSet) ? payload.flowDataSet : null;
}

function processRoot(payload: JsonObject): JsonObject | null {
  return isJsonObject(payload.processDataSet) ? payload.processDataSet : null;
}

function flowIdentity(payload: JsonObject): { id: string; version: string } | null {
  const root = flowRoot(payload);
  const information = isJsonObject(root?.flowInformation) ? root.flowInformation : null;
  const dataset = isJsonObject(information?.dataSetInformation)
    ? information.dataSetInformation
    : null;
  const admin = isJsonObject(root?.administrativeInformation)
    ? root.administrativeInformation
    : null;
  const publication = isJsonObject(admin?.publicationAndOwnership)
    ? admin.publicationAndOwnership
    : null;
  const id = dataset?.['common:UUID'];
  const version = publication?.['common:dataSetVersion'];
  return typeof id === 'string' && typeof version === 'string' ? { id, version } : null;
}

export function flowType(payload: JsonObject): string | null {
  const root = flowRoot(payload);
  const modelling = isJsonObject(root?.modellingAndValidation) ? root.modellingAndValidation : null;
  const method = isJsonObject(modelling?.LCIMethod) ? modelling.LCIMethod : null;
  return typeof method?.typeOfDataSet === 'string' ? method.typeOfDataSet : null;
}

function flowClassificationInformation(payload: JsonObject): unknown {
  const root = flowRoot(payload);
  const information = isJsonObject(root?.flowInformation) ? root.flowInformation : null;
  const dataset = isJsonObject(information?.dataSetInformation)
    ? information.dataSetInformation
    : null;
  return dataset?.classificationInformation ?? null;
}

function textValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values.flatMap((entry) => {
        const candidate =
          typeof entry === 'string'
            ? entry
            : isJsonObject(entry) && typeof entry['#text'] === 'string'
              ? entry['#text']
              : null;
        return candidate?.trim() ? [candidate] : [];
      }),
    ),
  ].sort();
}

function targetReferenceMatches(payload: JsonObject, reference: FlowIdentityReference): boolean {
  const root = flowRoot(payload);
  const information = isJsonObject(root?.flowInformation) ? root.flowInformation : null;
  const dataset = isJsonObject(information?.dataSetInformation)
    ? information.dataSetInformation
    : null;
  const name = isJsonObject(dataset?.name) ? dataset.name : null;
  const referenceNames = textValues(reference['common:shortDescription']);
  const baseNames = textValues(name?.baseName);
  return referenceNames.some((entry) => baseNames.includes(entry));
}

function referenceIdentity(value: unknown): { id: string; version: string | null } | null {
  if (!isJsonObject(value) || typeof value['@refObjectId'] !== 'string') return null;
  return {
    id: value['@refObjectId'],
    version: typeof value['@version'] === 'string' ? value['@version'] : null,
  };
}

function flowSupportFacts(
  row: DatasetMaintenanceRowSnapshot,
  supportRows: DatasetMaintenanceRowSnapshot[],
  actorUserId: string,
): Omit<
  FlowIdentityMappingEndpoint,
  'user_id' | 'state_code' | 'modified_at' | 'payload_sha256' | 'row_sha256'
> | null {
  const payload = row.json_ordered;
  const root = payload ? flowRoot(payload) : null;
  const information = isJsonObject(root?.flowInformation) ? root.flowInformation : null;
  const quantitative = isJsonObject(information?.quantitativeReference)
    ? information.quantitativeReference
    : null;
  const referenceInternalId = quantitative?.referenceToReferenceFlowProperty;
  const properties = isJsonObject(root?.flowProperties) ? root.flowProperties : null;
  const entries = arrayOfObjects(properties?.flowProperty);
  const property = entries?.find((entry) => entry['@dataSetInternalID'] === referenceInternalId);
  const propertyRef = referenceIdentity(property?.referenceToFlowPropertyDataSet);
  if (!payload || !propertyRef) return null;
  const flowPropertyVersion = propertyRef.version;
  if (!flowPropertyVersion) return null;
  const fp = supportRows.find(
    (entry) =>
      entry.table === 'flowproperties' &&
      entry.id === propertyRef.id &&
      entry.version === flowPropertyVersion,
  );
  if (!fp || !(fp.state_code === 100 || (fp.user_id === actorUserId && fp.state_code === 0))) {
    return null;
  }
  const fpRoot = isJsonObject(fp?.json_ordered?.flowPropertyDataSet)
    ? fp.json_ordered.flowPropertyDataSet
    : null;
  const fpInformation = isJsonObject(fpRoot?.flowPropertiesInformation)
    ? fpRoot.flowPropertiesInformation
    : null;
  const fpDataset = isJsonObject(fpInformation?.dataSetInformation)
    ? fpInformation.dataSetInformation
    : null;
  const fpQuantitative = isJsonObject(fpInformation?.quantitativeReference)
    ? fpInformation.quantitativeReference
    : null;
  const fpAdmin = isJsonObject(fpRoot?.administrativeInformation)
    ? fpRoot.administrativeInformation
    : null;
  const fpPublication = isJsonObject(fpAdmin?.publicationAndOwnership)
    ? fpAdmin.publicationAndOwnership
    : null;
  const unitGroupRef = referenceIdentity(fpQuantitative?.referenceToReferenceUnitGroup);
  if (
    !unitGroupRef ||
    fpDataset?.['common:UUID'] !== fp.id ||
    fpPublication?.['common:dataSetVersion'] !== fp.version
  )
    return null;
  const unitGroupVersion = unitGroupRef.version;
  const identity = flowIdentity(payload);
  const type = flowType(payload);
  const unitGroup = supportRows.find(
    (entry) =>
      entry.table === 'unitgroups' &&
      entry.id === unitGroupRef.id &&
      entry.version === unitGroupVersion,
  );
  const unitGroupRoot = isJsonObject(unitGroup?.json_ordered?.unitGroupDataSet)
    ? unitGroup.json_ordered.unitGroupDataSet
    : null;
  const unitGroupInformation = isJsonObject(unitGroupRoot?.unitGroupInformation)
    ? unitGroupRoot.unitGroupInformation
    : null;
  const unitGroupDataset = isJsonObject(unitGroupInformation?.dataSetInformation)
    ? unitGroupInformation.dataSetInformation
    : null;
  const unitGroupQuantitative = isJsonObject(unitGroupInformation?.quantitativeReference)
    ? unitGroupInformation.quantitativeReference
    : null;
  const referenceUnit = unitGroupQuantitative?.referenceToReferenceUnit;
  const unitsRoot = isJsonObject(unitGroupRoot?.units) ? unitGroupRoot.units : null;
  const units = arrayOfObjects(unitsRoot?.unit);
  const referenceUnitRow = units?.find((entry) => entry['@dataSetInternalID'] === referenceUnit);
  const unitGroupAdmin = isJsonObject(unitGroupRoot?.administrativeInformation)
    ? unitGroupRoot.administrativeInformation
    : null;
  const unitGroupPublication = isJsonObject(unitGroupAdmin?.publicationAndOwnership)
    ? unitGroupAdmin.publicationAndOwnership
    : null;
  if (
    !identity ||
    identity.id !== row.id ||
    identity.version !== row.version ||
    type !== 'Elementary flow' ||
    !unitGroupVersion ||
    !unitGroup ||
    !(
      unitGroup.state_code === 100 ||
      (unitGroup.user_id === actorUserId && unitGroup.state_code === 0)
    ) ||
    unitGroupDataset?.['common:UUID'] !== unitGroup.id ||
    unitGroupPublication?.['common:dataSetVersion'] !== unitGroup.version ||
    !referenceUnitRow ||
    Number(referenceUnitRow.meanValue) !== 1
  ) {
    return null;
  }
  return {
    id: row.id,
    version: row.version,
    flow_type: 'Elementary flow',
    flow_property_id: propertyRef.id,
    flow_property_version: flowPropertyVersion,
    unit_group_id: unitGroupRef.id,
    unit_group_version: unitGroupVersion,
    category_path_sha256: sha256Json(flowClassificationInformation(payload)),
  };
}

function flowGuardRowSha256(row: DatasetMaintenanceRowSnapshot): string | null {
  if (
    !row.user_id ||
    row.state_code === null ||
    !row.modified_at ||
    !POSTGREST_UTC_TIMESTAMP_PATTERN.test(row.modified_at) ||
    !row.payload_sha256
  ) {
    return null;
  }
  return sha256Json({
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    modified_at: row.modified_at,
    payload_sha256: row.payload_sha256,
  });
}

function buildSupportSnapshots(options: {
  mappings: FlowIdentityMapping[];
  capture: FlowIdentityLiveCapture;
}): FlowIdentitySupportSnapshot[] {
  const claimed = new Map<
    string,
    { table: FlowIdentitySupportSnapshot['table']; id: string; version: string }
  >();
  for (const mapping of options.mappings) {
    for (const endpoint of [mapping.source, mapping.target]) {
      const identities = [
        {
          table: 'flowproperties' as const,
          id: endpoint.flow_property_id,
          version: endpoint.flow_property_version,
        },
        {
          table: 'unitgroups' as const,
          id: endpoint.unit_group_id,
          version: endpoint.unit_group_version,
        },
      ];
      for (const identity of identities) {
        claimed.set(`${identity.table}\u0000${identity.id}\u0000${identity.version}`, identity);
      }
    }
  }
  const captureRows = new Map<string, DatasetMaintenanceRowSnapshot>();
  for (const row of options.capture.support_rows) {
    if (row.table !== 'flowproperties' && row.table !== 'unitgroups') continue;
    requireSnapshotIntegrity(row);
    const key = `${row.table}\u0000${row.id}\u0000${row.version}`;
    if (captureRows.has(key)) fail('Live capture contains duplicate support rows.');
    captureRows.set(key, row);
  }
  return [...claimed.values()]
    .sort((left, right) =>
      `${left.table}\u0000${left.id}\u0000${left.version}`.localeCompare(
        `${right.table}\u0000${right.id}\u0000${right.version}`,
      ),
    )
    .map((identity, index) => {
      const row = captureRows.get(`${identity.table}\u0000${identity.id}\u0000${identity.version}`);
      const rowSha256 = row ? flowGuardRowSha256(row) : null;
      if (
        !row ||
        !row.user_id ||
        !row.modified_at ||
        !row.payload_sha256 ||
        (row.state_code !== 0 && row.state_code !== 100) ||
        (row.state_code === 0 && row.user_id !== options.capture.account.user_id) ||
        !rowSha256
      ) {
        fail('A claimed FP/UG support row cannot produce an exact database guard.', undefined, {
          ...identity,
        });
      }
      return {
        ordinal: index + 1,
        ...identity,
        user_id: row.user_id,
        state_code: row.state_code,
        modified_at: row.modified_at,
        payload_sha256: row.payload_sha256,
        row_sha256: rowSha256,
      };
    });
}

function processGuardRowSha256(row: DatasetMaintenanceRowSnapshot): string | null {
  if (
    !row.user_id ||
    row.state_code === null ||
    !row.modified_at ||
    !POSTGREST_UTC_TIMESTAMP_PATTERN.test(row.modified_at) ||
    !row.payload_sha256
  ) {
    return null;
  }
  return sha256Json({
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    modified_at: row.modified_at,
    model_id: row.model_id,
    rule_verification: row.rule_verification,
    payload_sha256: row.payload_sha256,
  });
}

function endpoint(
  row: DatasetMaintenanceRowSnapshot,
  supportRows: DatasetMaintenanceRowSnapshot[],
  actorUserId: string,
): FlowIdentityMappingEndpoint | null {
  const facts = flowSupportFacts(row, supportRows, actorUserId);
  const rowSha256 = flowGuardRowSha256(row);
  return facts &&
    row.user_id &&
    row.modified_at &&
    row.payload_sha256 &&
    typeof row.state_code === 'number' &&
    rowSha256
    ? {
        ...facts,
        user_id: row.user_id,
        state_code: row.state_code,
        modified_at: row.modified_at,
        payload_sha256: row.payload_sha256,
        row_sha256: rowSha256,
      }
    : null;
}

function processExchanges(payload: JsonObject): JsonObject[] | null {
  const root = processRoot(payload);
  const exchanges = isJsonObject(root?.exchanges) ? root.exchanges : null;
  return arrayOfObjects(exchanges?.exchange);
}

function exchangeReference(exchange: JsonObject): FlowIdentityReference | null {
  try {
    return extractFlowIdentityReference(exchange.referenceToFlowDataSet, 'exchange reference');
  } catch {
    return null;
  }
}

function exchangeDirection(exchange: JsonObject): FlowIdentityDirection | null {
  return exchange.exchangeDirection === 'Input' || exchange.exchangeDirection === 'Output'
    ? exchange.exchangeDirection
    : null;
}

function exchangeInternalId(exchange: JsonObject): string | null {
  return typeof exchange['@dataSetInternalID'] === 'string' ? exchange['@dataSetInternalID'] : null;
}

function patchReference(reference: JsonObject, target: FlowIdentityReference): void {
  for (const field of [
    '@refObjectId',
    '@type',
    '@uri',
    '@version',
    'common:shortDescription',
  ] as const) {
    reference[field] = structuredClone(target[field]);
  }
}

function occurrence(options: {
  process: DatasetMaintenanceRowSnapshot;
  exchange: JsonObject;
  exchangeIndex: number;
  reference: FlowIdentityReference;
}): FlowIdentityOccurrence {
  const internalId = exchangeInternalId(options.exchange);
  const direction = exchangeDirection(options.exchange);
  if (!internalId || !direction) fail('Process exchange identity or direction is malformed.');
  return {
    process_id: options.process.id,
    process_version: options.process.version,
    exchange_index: options.exchangeIndex,
    internal_id: internalId,
    direction,
    reference_sha256: sha256Json(options.reference),
  };
}

function collectOccurrences(
  processes: DatasetMaintenanceRowSnapshot[],
): Map<string, FlowIdentityOccurrence[]> {
  const result = new Map<string, FlowIdentityOccurrence[]>();
  for (const process of [...processes].sort((left, right) =>
    rowKey(left.id, left.version).localeCompare(rowKey(right.id, right.version)),
  )) {
    if (!process.json_ordered) fail('Process capture row has no json_ordered payload.');
    const exchanges = processExchanges(process.json_ordered);
    if (!exchanges) fail('Process capture row has a malformed exchange collection.');
    exchanges.forEach((exchange, exchangeIndex) => {
      const reference = exchangeReference(exchange);
      if (!reference) fail('Process exchange has a malformed flow reference.');
      const key = rowKey(reference['@refObjectId'], reference['@version']);
      const rows = result.get(key) ?? [];
      rows.push(occurrence({ process, exchange, exchangeIndex, reference }));
      result.set(key, rows);
    });
  }
  return result;
}

function protectedReferenceEntry(
  review: FlowIdentityReviewEntry,
  occurrences: FlowIdentityOccurrence[],
): FlowIdentityProtectedReferenceEntry {
  return {
    source_id: review.source.id,
    source_version: review.source.version,
    expected_reference_count: occurrences.length,
    occurrences,
    occurrence_set_sha256: sha256Json(occurrences),
    evidence_sha256: review.decision_evidence_sha256,
  };
}

function buildProtectedClosure(
  review: FlowIdentityReviewLedger,
  occurrenceIndex: Map<string, FlowIdentityOccurrence[]>,
): FlowIdentityProtectedClosure {
  const pending: FlowIdentityProtectedReferenceEntry[] = [];
  const blockers: FlowIdentityProtectedReferenceEntry[] = [];
  const orphans: FlowIdentityProtectedClosure['orphans'] = [];
  for (const entry of review.entries) {
    const occurrences = occurrenceIndex.get(rowKey(entry.source.id, entry.source.version)) ?? [];
    if (entry.disposition === 'pending') pending.push(protectedReferenceEntry(entry, occurrences));
    if (entry.disposition === 'blocker') blockers.push(protectedReferenceEntry(entry, occurrences));
    if (entry.disposition === 'orphan') {
      if (occurrences.length)
        fail('A reviewed orphan has live process references.', undefined, entry.source);
      orphans.push({
        source_id: entry.source.id,
        source_version: entry.source.version,
        evidence_sha256: entry.decision_evidence_sha256,
      });
    }
  }
  return {
    schema_version: 'dataset-flow-identity-protected-closure.v1',
    pending,
    blockers,
    orphans,
    pending_set_sha256: sha256Json(pending),
    blocker_set_sha256: sha256Json(blockers),
    orphan_set_sha256: sha256Json(orphans),
    total_expected_reference_count: [...pending, ...blockers].reduce(
      (sum, entry) => sum + entry.expected_reference_count,
      0,
    ),
  };
}

function flowSchemaProof(
  validation: FlowPayloadValidationResult,
): FlowIdentityMapping['compatibility']['flow_schema'] {
  return {
    status: validation.ok ? 'pass' : 'legacy_warning',
    warning_set_sha256: sha256Json(validation.ok ? [] : validation.issues),
  };
}

function buildMappings(options: {
  policy: FlowIdentityCompatibilityPolicy;
  review: FlowIdentityReviewLedger;
  capture: FlowIdentityLiveCapture;
  validateFlow: ValidationDeps['validateFlow'];
  occurrenceIndex: Map<string, FlowIdentityOccurrence[]>;
}): FlowIdentityMapping[] {
  const sources = indexRows(options.capture.source_rows, 'flows');
  const targets = indexRows(options.capture.target_rows, 'flows');
  options.capture.support_rows.forEach(requireSnapshotIntegrity);
  const reviewedSourceKeys = new Set(
    options.review.entries.map((entry) => rowKey(entry.source.id, entry.source.version)),
  );
  const approvedTargetKeys = new Set(
    options.review.entries
      .filter((entry) => entry.disposition === 'map_public')
      .map((entry) => rowKey(entry.target!.id, entry.target!.version)),
  );
  if (
    sources.size !== options.review.entries.length ||
    [...sources.keys()].some((key) => !reviewedSourceKeys.has(key)) ||
    [...reviewedSourceKeys].some((key) => !sources.has(key)) ||
    targets.size !== approvedTargetKeys.size ||
    [...targets.keys()].some((key) => !approvedTargetKeys.has(key))
  ) {
    fail('Fresh capture must contain exactly the 305 reviewed source flow rows.');
  }
  for (const row of sources.values()) {
    if (
      row.user_id !== options.capture.account.user_id ||
      row.state_code !== 0 ||
      !endpoint(row, options.capture.support_rows, options.capture.account.user_id)
    ) {
      fail('Every reviewed source must remain an exact current-owner state-0 Elementary flow.');
    }
  }
  return options.review.entries
    .filter((entry) => entry.disposition === 'map_public')
    .map((entry, index) => {
      const sourceRow = sources.get(rowKey(entry.source.id, entry.source.version));
      const target = entry.target!;
      const targetRow = targets.get(rowKey(target.id, target.version));
      if (!sourceRow || !targetRow)
        fail('Approved mapping source or target is absent from fresh capture.');
      const source = endpoint(
        sourceRow,
        options.capture.support_rows,
        options.capture.account.user_id,
      );
      const targetEndpoint = endpoint(
        targetRow,
        options.capture.support_rows,
        options.capture.account.user_id,
      );
      const targetReference = parseFlowIdentityReference(
        target.reference,
        'review target reference',
      );
      const occurrences =
        options.occurrenceIndex.get(rowKey(entry.source.id, entry.source.version)) ?? [];
      if (
        !source ||
        !targetEndpoint ||
        source.user_id !== options.capture.account.user_id ||
        source.state_code !== 0 ||
        targetEndpoint.user_id === options.capture.account.user_id ||
        targetEndpoint.state_code !== 100 ||
        targetReference['@refObjectId'] !== targetEndpoint.id ||
        targetReference['@version'] !== targetEndpoint.version ||
        !targetReferenceMatches(targetRow.json_ordered!, targetReference) ||
        source.flow_property_id !== targetEndpoint.flow_property_id ||
        source.flow_property_version !== targetEndpoint.flow_property_version ||
        source.unit_group_id !== targetEndpoint.unit_group_id ||
        source.unit_group_version !== targetEndpoint.unit_group_version ||
        occurrences.some((occurrence) => !entry.allowed_directions.includes(occurrence.direction))
      ) {
        fail(
          'Approved mapping failed a fresh owner/public/type/support/direction compatibility guard.',
          undefined,
          {
            source: entry.source,
            target: entry.target,
          },
        );
      }
      const targetValidation = options.validateFlow(targetRow.json_ordered!);
      const compatibilityEvidence = sha256Json({
        decision_evidence_sha256: entry.decision_evidence_sha256,
        compartment_evidence_sha256: entry.compartment_evidence_sha256,
        source_trace_sha256: entry.source_trace_sha256,
        source,
        target: targetEndpoint,
        allowed_directions: entry.allowed_directions,
      });
      const withoutId: Omit<FlowIdentityMapping, 'mapping_id'> = {
        ordinal: index + 1,
        source: { ...source, source_trace_sha256: entry.source_trace_sha256 },
        target: { ...targetEndpoint, reference: targetReference },
        compatibility: {
          policy_sha256: options.policy.policy_sha256,
          mode: 'identity',
          confidence: 'approved',
          flow_property_compatible: true,
          unit_group_compatible: true,
          direction_compatible: true,
          compartment_compatible: true,
          conversion_factor: '1',
          evidence_sha256: compatibilityEvidence,
          flow_schema: flowSchemaProof(targetValidation),
          process_schema_required: 'pass',
        },
      };
      return { ...withoutId, mapping_id: computeFlowIdentityMappingId(withoutId) };
    });
}

function collisionLedger(options: {
  desiredExchanges: JsonObject[];
  rewrites: FlowIdentityRewrite[];
}): FlowIdentityCollisionLedger {
  const touchedTargets = new Set(
    options.rewrites.map(
      (rewrite) =>
        `${rewrite.target_reference['@refObjectId']}\u0000${rewrite.target_reference['@version']}`,
    ),
  );
  const mappingByIndex = new Map(
    options.rewrites.map((rewrite) => [rewrite.exchange_index, rewrite.mapping_id]),
  );
  const entries: FlowIdentityCollisionEntry[] = [];
  for (const targetKey of [...touchedTargets].sort()) {
    const matches = options.desiredExchanges
      .map((exchange, exchangeIndex) => ({
        exchange,
        exchangeIndex,
        reference: exchangeReference(exchange),
      }))
      .filter(
        (entry) =>
          entry.reference &&
          rowKey(entry.reference['@refObjectId'], entry.reference['@version']) === targetKey,
      );
    if (matches.length <= 1) continue;
    const first = matches[0]!.reference!;
    entries.push({
      target_id: first['@refObjectId'],
      target_version: first['@version'],
      exchange_indexes: matches.map((entry) => entry.exchangeIndex),
      internal_ids: matches.map((entry) => exchangeInternalId(entry.exchange)),
      mapping_ids: matches.map((entry) => mappingByIndex.get(entry.exchangeIndex) ?? null),
      preserve_rows: true,
    });
  }
  return { schema_version: 'dataset-flow-identity-collision-ledger.v1', entries };
}

function buildProcessTemplate(options: {
  ordinal: number;
  row: DatasetMaintenanceRowSnapshot;
  mappingsBySource: Map<string, FlowIdentityMapping>;
  pendingBlockerClosureSha256: string;
  validateProcess: ValidationDeps['validateProcess'];
}): FlowIdentityProcessTemplate | null {
  if (!options.row.json_ordered || !options.row.payload_sha256 || !options.row.modified_at) {
    fail('Affected process row lacks a complete fresh snapshot.');
  }
  const beforeExchanges = processExchanges(options.row.json_ordered);
  if (!beforeExchanges) fail('Affected process exchange collection is malformed.');
  const desired = structuredClone(options.row.json_ordered);
  const desiredExchanges = processExchanges(desired)!;
  const rewrites: FlowIdentityRewrite[] = [];
  beforeExchanges.forEach((exchange, exchangeIndex) => {
    const sourceReference = exchangeReference(exchange);
    if (!sourceReference) fail('Affected process contains a malformed source reference.');
    const mapping = options.mappingsBySource.get(
      rowKey(sourceReference['@refObjectId'], sourceReference['@version']),
    );
    if (!mapping) return;
    const direction = exchangeDirection(exchange);
    const internalId = exchangeInternalId(exchange);
    const desiredReference = desiredExchanges[exchangeIndex]!.referenceToFlowDataSet;
    if (!direction || !internalId || !isJsonObject(desiredReference)) {
      fail('Affected exchange identity, direction, or reference object is malformed.');
    }
    patchReference(desiredReference, mapping.target.reference);
    rewrites.push({
      ordinal: rewrites.length + 1,
      exchange_index: exchangeIndex,
      internal_id: internalId,
      direction,
      mapping_id: mapping.mapping_id,
      source_reference: sourceReference,
      target_reference: structuredClone(mapping.target.reference),
      before_reference_sha256: sha256Json(sourceReference),
      after_reference_sha256: sha256Json(mapping.target.reference),
    });
  });
  if (!rewrites.length) return null;
  const validation = options.validateProcess(desired);
  if (!validation.ok) {
    fail('Desired process failed ProcessSchema and cannot enter an executable plan.', undefined, {
      id: options.row.id,
      version: options.row.version,
      issues: validation.issues,
    });
  }
  const collision = collisionLedger({ desiredExchanges, rewrites });
  const processSchemaEvidence = sha256Json({
    validator: validation.validator,
    status: 'pass',
    desired_payload_sha256: sha256Json(desired),
  });
  const beforeRowSha256 = processGuardRowSha256(options.row);
  if (!beforeRowSha256) fail('Affected process row cannot produce the database guard hash.');
  const manifestWithoutHash: FlowIdentityProcessManifest = {
    ordinal: options.ordinal,
    id: options.row.id,
    version: options.row.version,
    user_id: options.row.user_id!,
    state_code: 0,
    modified_at: options.row.modified_at,
    model_id: options.row.model_id,
    rule_verification: options.row.rule_verification,
    before_row_sha256: beforeRowSha256,
    before_payload_sha256: options.row.payload_sha256,
    before_exchange_set_sha256: sha256Json(beforeExchanges),
    before_exchange_count: beforeExchanges.length,
    desired_payload_sha256: sha256Json(desired),
    desired_exchange_set_sha256: sha256Json(desiredExchanges),
    rewrite_count: rewrites.length,
    process_template_sha256: '',
    rewrite_set_sha256: sha256Json(rewrites),
    collision_ledger_sha256: sha256Json(collision),
    process_schema: { status: 'pass', evidence_sha256: processSchemaEvidence },
    pending_blocker_closure_sha256: options.pendingBlockerClosureSha256,
  };
  const process = {
    ...manifestWithoutHash,
    process_template_sha256: computeFlowIdentityProcessTemplateSha256(manifestWithoutHash),
  };
  return { process, rewrites, collision_ledger: collision, desired_payload: desired };
}

function buildProcessTemplates(options: {
  capture: FlowIdentityLiveCapture;
  mappings: FlowIdentityMapping[];
  closure: FlowIdentityProtectedClosure;
  validateProcess: ValidationDeps['validateProcess'];
}): FlowIdentityProcessTemplate[] {
  const mappingsBySource = new Map(
    options.mappings.map((mapping) => [rowKey(mapping.source.id, mapping.source.version), mapping]),
  );
  const rows = options.capture.process_rows
    .filter((row) => row.table === 'processes')
    .sort((left, right) => maintenanceRowKey(left).localeCompare(maintenanceRowKey(right)));
  rows.forEach(requireSnapshotIntegrity);
  const templates: FlowIdentityProcessTemplate[] = [];
  for (const row of rows) {
    if (row.user_id !== options.capture.account.user_id || row.state_code !== 0) {
      fail('Process capture contains a foreign-owner or non-draft row.');
    }
    const template = buildProcessTemplate({
      ordinal: templates.length + 1,
      row,
      mappingsBySource,
      pendingBlockerClosureSha256: sha256Json(options.closure),
      validateProcess: options.validateProcess,
    });
    if (!template) continue;
    templates.push(template);
  }
  return templates;
}

export function buildFlowIdentityCaptureRequest(options: {
  requestId: string;
  operationId: string;
  policy: FlowIdentityCompatibilityPolicy;
  capture: FlowIdentityLiveCapture;
  mappings: FlowIdentityMapping[];
  processTemplates: FlowIdentityProcessTemplate[];
  protectedClosure: FlowIdentityProtectedClosure;
}): FlowIdentityCaptureRequest {
  const mappingOrdinalById = new Map(
    options.mappings.map((mapping) => [mapping.mapping_id, mapping.ordinal]),
  );
  const mappings = options.mappings.map((mapping) => ({
    ordinal: mapping.ordinal,
    source: {
      id: mapping.source.id,
      version: mapping.source.version,
      source_trace_sha256: mapping.source.source_trace_sha256,
    },
    target: {
      id: mapping.target.id,
      version: mapping.target.version,
      reference: mapping.target.reference,
    },
    compatibility: mapping.compatibility,
  })) as JsonObject[];
  const processIntents = options.processTemplates.map((template) => ({
    ordinal: template.process.ordinal,
    id: template.process.id,
    version: template.process.version,
    rewrites: template.rewrites.map((rewrite) => {
      const mappingOrdinal = mappingOrdinalById.get(rewrite.mapping_id);
      if (!mappingOrdinal) fail('A process rewrite refers to a foreign mapping.');
      return {
        ordinal: rewrite.ordinal,
        exchange_index: rewrite.exchange_index,
        internal_id: rewrite.internal_id,
        direction: rewrite.direction,
        mapping_ordinal: mappingOrdinal,
      };
    }),
    process_schema: template.process.process_schema,
  })) as JsonObject[];
  const occurrenceIntent = (entry: FlowIdentityProtectedReferenceEntry): JsonObject => ({
    source_id: entry.source_id,
    source_version: entry.source_version,
    expected_reference_count: entry.expected_reference_count,
    occurrences: entry.occurrences.map((occurrence) => ({
      process_id: occurrence.process_id,
      process_version: occurrence.process_version,
      exchange_index: occurrence.exchange_index,
      internal_id: occurrence.internal_id,
      direction: occurrence.direction,
    })),
    evidence_sha256: entry.evidence_sha256,
  });
  return {
    schema_version: 'dataset-flow-identity-capture-attest.v2',
    request_id: options.requestId,
    environment: options.capture.environment,
    project_ref: options.capture.project_ref,
    actor: options.capture.account,
    target_visibility: 'owner_draft',
    operation_id: options.operationId,
    compatibility_policy: options.policy,
    artifact_evidence: options.capture.artifact_evidence,
    mappings,
    process_intents: processIntents,
    protected_closure: {
      schema_version: 'dataset-flow-identity-protected-intent.v2',
      pending: options.protectedClosure.pending.map(occurrenceIntent),
      blockers: options.protectedClosure.blockers.map(occurrenceIntent),
      orphans: options.protectedClosure.orphans.map((entry) => ({
        source_id: entry.source_id,
        source_version: entry.source_version,
        evidence_sha256: entry.evidence_sha256,
      })),
    },
  };
}

export function buildFlowIdentitySemantics(options: {
  policy: FlowIdentityCompatibilityPolicy;
  review: FlowIdentityReviewLedger;
  capture: FlowIdentityLiveCapture;
  validation: ValidationDeps;
}): {
  protectedClosure: FlowIdentityProtectedClosure;
  mappings: FlowIdentityMapping[];
  supportSnapshots: FlowIdentitySupportSnapshot[];
  processTemplates: FlowIdentityProcessTemplate[];
} {
  const occurrenceIndex = collectOccurrences(options.capture.process_rows);
  const protectedClosure = buildProtectedClosure(options.review, occurrenceIndex);
  const mappings = buildMappings({
    policy: options.policy,
    review: options.review,
    capture: options.capture,
    validateFlow: options.validation.validateFlow,
    occurrenceIndex,
  });
  const supportSnapshots = buildSupportSnapshots({
    mappings,
    capture: options.capture,
  });
  const processTemplates = buildProcessTemplates({
    capture: options.capture,
    mappings,
    closure: protectedClosure,
    validateProcess: options.validation.validateProcess,
  });
  return { protectedClosure, mappings, supportSnapshots, processTemplates };
}

export function buildFlowIdentityPlan(
  options: BuildFlowIdentityPlanOptions,
): FlowIdentityPlanBundle {
  const policy = parseFlowIdentityPolicy(options.policy);
  const review = parseFlowIdentityReviewLedger(options.reviewLedger);
  const capture = parseFlowIdentityCapture(options.liveCapture);
  if (policy.evidence_resolution_sha256 !== review.review_evidence_sha256) {
    fail('Approved policy does not bind the supplied v3 evidence resolution ledger.');
  }
  if (
    capture.artifact_evidence.review_ledger_sha256 !== review.ledger_sha256 ||
    Date.parse(capture.attestation.expires_at) <= (options.now ?? new Date()).getTime()
  ) {
    fail('The v2 capture receipt is foreign, expired, or does not bind the review ledger.');
  }
  const validation: ValidationDeps = {
    validateFlow: options.validation?.validateFlow ?? validateFlowPayload,
    validateProcess: options.validation?.validateProcess ?? validateProcessPayload,
  };
  const { protectedClosure, mappings, supportSnapshots, processTemplates } =
    buildFlowIdentitySemantics({ policy, review, capture, validation });
  const expectedCaptureRequest = buildFlowIdentityCaptureRequest({
    requestId: capture.capture_request.request_id,
    operationId: capture.attestation.operation_id,
    policy,
    capture,
    mappings,
    processTemplates,
    protectedClosure,
  });
  const expectedCaptureRequestSha256 = flowIdentityRestrictedSha256(
    expectedCaptureRequest as unknown as JsonObject,
  );
  if (
    expectedCaptureRequestSha256 !== capture.attestation.capture_request_sha256 ||
    expectedCaptureRequestSha256 !==
      flowIdentityRestrictedSha256(capture.capture_request as unknown as JsonObject)
  ) {
    fail(
      'The authenticated v2 receipt does not bind the exact local mapping, locator, process, and protected-closure semantics.',
    );
  }
  const processes = processTemplates.map((template) => template.process);
  const collisionCount = processTemplates.reduce(
    (sum, template) => sum + template.collision_ledger.entries.length,
    0,
  );
  const sourceUniverse = review.entries
    .map((entry) => ({
      id: entry.source.id,
      version: entry.source.version,
      user_id: capture.account.user_id,
      state_code: 0,
      flow_type: 'Elementary flow',
    }))
    .sort((left, right) =>
      rowKey(left.id, left.version).localeCompare(rowKey(right.id, right.version)),
    );
  const body: FlowIdentityPlan = {
    schema_version: 'dataset-flow-identity-plan.v2',
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    environment: capture.environment,
    project_ref: capture.project_ref,
    account: capture.account,
    operation_id: capture.attestation.operation_id,
    status: 'ready',
    target_visibility: 'owner_draft',
    review_ledger_sha256: review.ledger_sha256,
    capture_artifact_sha256: computeFlowIdentityCaptureSha256(capture),
    receipt_id: capture.attestation.receipt_id,
    receipt_proof_sha256: capture.attestation.receipt_proof_sha256,
    capture_request_sha256: capture.attestation.capture_request_sha256,
    source_guard_set_sha256: capture.attestation.source_guard_set_sha256,
    support_guard_set_sha256: capture.attestation.support_guard_set_sha256,
    target_guard_set_sha256: capture.attestation.target_guard_set_sha256,
    mapping_guard_set_sha256: capture.attestation.mapping_guard_set_sha256,
    process_intent_set_sha256: capture.attestation.process_intent_set_sha256,
    receipt_protected_closure_sha256: capture.attestation.protected_closure_sha256,
    capture_whole_scope_proof_sha256: capture.attestation.whole_scope_proof_sha256,
    source_universe_artifact_sha256: sha256Json(sourceUniverse),
    compatibility_policy: policy,
    support_snapshot_artifact_sha256: sha256Json(supportSnapshots),
    mapping_artifact_sha256: sha256Json(mappings),
    process_manifest_artifact_sha256: sha256Json(processes),
    protected_closure_artifact_sha256: sha256Json(protectedClosure),
    support_snapshots: supportSnapshots,
    mappings,
    processes,
    protected_closure: protectedClosure,
    summary: {
      semantic_sources: 305,
      mappings: mappings.length,
      processes: processes.length,
      rewrites: processes.reduce((sum, process) => sum + process.rewrite_count, 0),
      collision_entries: collisionCount,
      pending: protectedClosure.pending.length,
      blockers: protectedClosure.blockers.length,
      orphans: protectedClosure.orphans.length,
      protected_references: protectedClosure.total_expected_reference_count,
    },
    artifacts: {
      plan: 'flow-identity-plan.json',
      live_capture: 'flow-identity-live-capture.json',
      process_manifest: 'flow-identity-process-manifest.jsonl',
      collision_ledger: 'flow-identity-collision-ledger.jsonl',
      protected_closure: 'flow-identity-protected-closure.json',
      desired_payload_dir: 'desired-processes',
      process_request_dir: 'process-requests',
    },
    plan_sha256: '',
  };
  if (
    capture.attestation.mapping_count !== mappings.length ||
    capture.attestation.process_count !== processes.length ||
    capture.attestation.rewrite_count !== body.summary.rewrites
  ) {
    fail('The v2 database receipt counts do not match the deterministic semantic plan.');
  }
  body.plan_sha256 = computeFlowIdentityPlanSha256(body);
  return { plan: body, process_templates: processTemplates };
}

export function runFlowIdentityPlan(options: RunFlowIdentityPlanOptions): FlowIdentityPlan {
  const bundle = buildFlowIdentityPlan(options);
  const outDir = ensurePrivateArtifactDirectory(path.resolve(options.outDir));
  writePrivateImmutableJson(path.join(outDir, bundle.plan.artifacts.plan), bundle.plan);
  writePrivateImmutableJson(
    path.join(outDir, bundle.plan.artifacts.live_capture),
    parseFlowIdentityCapture(options.liveCapture),
  );
  writePrivateImmutableText(
    path.join(outDir, bundle.plan.artifacts.process_manifest),
    bundle.plan.processes.length ? `${bundle.plan.processes.map(stableJsonText).join('\n')}\n` : '',
  );
  const collisionRows = bundle.process_templates.map((template) => ({
    ordinal: template.process.ordinal,
    process_id: template.process.id,
    process_version: template.process.version,
    ledger: template.collision_ledger,
  }));
  writePrivateImmutableText(
    path.join(outDir, bundle.plan.artifacts.collision_ledger),
    collisionRows.length ? `${collisionRows.map(stableJsonText).join('\n')}\n` : '',
  );
  writePrivateImmutableJson(
    path.join(outDir, bundle.plan.artifacts.protected_closure),
    bundle.plan.protected_closure,
  );
  for (const template of bundle.process_templates) {
    const stem = `${String(template.process.ordinal).padStart(6, '0')}-${template.process.id}-${template.process.version}`;
    writePrivateImmutableJson(
      path.join(outDir, bundle.plan.artifacts.desired_payload_dir, `${stem}.json`),
      template.desired_payload,
    );
    writePrivateImmutableJson(
      path.join(outDir, bundle.plan.artifacts.process_request_dir, `${stem}.json`),
      {
        process: template.process,
        rewrites: template.rewrites,
        collision_ledger: template.collision_ledger,
      },
    );
  }
  return bundle.plan;
}

export const __testInternals = {
  arrayOfObjects,
  buildProtectedClosure,
  collectOccurrences,
  collisionLedger,
  endpoint,
  exchangeDirection,
  exchangeInternalId,
  exchangeReference,
  flowClassificationInformation,
  flowIdentity,
  flowGuardRowSha256,
  flowSupportFacts,
  flowType,
  indexRows,
  patchReference,
  processGuardRowSha256,
  processExchanges,
  rowKey,
};
