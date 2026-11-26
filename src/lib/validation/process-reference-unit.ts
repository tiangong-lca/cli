import { FlowSchema, FlowPropertySchema, UnitGroupSchema } from '@tiangong-lca/tidas-sdk';
import { datasetRoot, isRecord } from '../dataset/json.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import {
  collectFlowReferencePropertyIssues,
  flowPropertyFactor,
} from './flow-reference-properties.js';
import { collectUnitGroupContentIssues } from './unitgroup-content-validation.js';

type Json = Record<string, unknown>;
export type ReferenceDocumentRequest = {
  type: 'flow' | 'flowproperty' | 'unitgroup';
  id: string;
  version: string;
};
export const record = (value: unknown): Json => (isRecord(value) ? value : {});
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const definitions = {
  flow: {
    wrapper: 'flowDataSet',
    info: 'flowInformation',
    schema: FlowSchema,
    referenceType: 'flow data set',
  },
  flowproperty: {
    wrapper: 'flowPropertyDataSet',
    info: 'flowPropertiesInformation',
    schema: FlowPropertySchema,
    referenceType: 'flow property data set',
  },
  unitgroup: {
    wrapper: 'unitGroupDataSet',
    info: 'unitGroupInformation',
    schema: UnitGroupSchema,
    referenceType: 'unit group data set',
  },
} as const;
class UnitEvidenceError extends Error {
  constructor(
    message: string,
    readonly needed?: ReferenceDocumentRequest,
  ) {
    super(message);
  }
}
export function processReferenceExchange(payload: Json): Json {
  const root = datasetRoot(payload, 'process');
  const reference = record(record(root.processInformation).quantitativeReference);
  const ids = list(reference.referenceToReferenceFlow);
  const exchanges = list(record(root.exchanges).exchange).map(record);
  const id = ids[0];
  if (
    reference['@type'] !== 'Reference flow(s)' ||
    ids.length !== 1 ||
    typeof id !== 'string' ||
    !/^\d{1,5}$/u.test(id)
  )
    throw new UnitEvidenceError(
      'Annual projection requires one explicit quantitative reference exchange.',
    );
  const matches = exchanges.filter((x) => x['@dataSetInternalID'] === id);
  if (matches.length !== 1)
    throw new UnitEvidenceError('Quantitative reference exchange is missing or ambiguous.');
  return matches[0]!;
}

/** Resolve identities and actual reference units, never display labels or latest versions. */
export function resolveProcessReferenceUnit(payload: Json, documents: readonly Json[] = []) {
  const dependencies: Array<ReferenceDocumentRequest & { content_sha256: string }> = [];
  const read = (value: unknown, type: ReferenceDocumentRequest['type']) => {
    const refs = list(value);
    const ref = record(refs[0]);
    const def = definitions[type];
    if (
      refs.length !== 1 ||
      ref['@type'] !== def.referenceType ||
      typeof ref['@refObjectId'] !== 'string' ||
      typeof ref['@version'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        ref['@refObjectId'],
      ) ||
      !/^\d{2}\.\d{2}\.\d{3}$/u.test(ref['@version'])
    )
      throw new UnitEvidenceError(`Annual projection requires one exact ${type} reference.`);
    const needed = { type, id: ref['@refObjectId'], version: ref['@version'] };
    const matches = documents.filter((document) => {
      const root = record(document[def.wrapper]);
      return (
        record(record(root[def.info]).dataSetInformation)['common:UUID'] === needed.id &&
        record(record(root.administrativeInformation).publicationAndOwnership)[
          'common:dataSetVersion'
        ] === needed.version
      );
    });
    if (!matches.length)
      throw new UnitEvidenceError(
        `Provide exact ${type} ${needed.id}@${needed.version} for annual evidence.`,
        needed,
      );
    if (matches.length !== 1 || !def.schema.safeParse(structuredClone(matches[0])).success)
      throw new UnitEvidenceError(`Exact ${type} evidence is ambiguous or schema-invalid.`);
    const document = matches[0]!;
    dependencies.push({ ...needed, content_sha256: sha256Json(document) });
    return document;
  };
  try {
    const exchange = processReferenceExchange(payload);
    const flow = read(exchange.referenceToFlowDataSet, 'flow');
    if (collectFlowReferencePropertyIssues(flow).length)
      throw new UnitEvidenceError(
        'Reference Flow property factors or internal identities are invalid.',
      );
    const flowRoot = record(flow.flowDataSet);
    const flowType = record(record(flowRoot.modellingAndValidation).LCIMethod).typeOfDataSet;
    if (flowType !== 'Product flow' && flowType !== 'Waste flow')
      throw new UnitEvidenceError('Annual batch reference must be a Product or Waste Flow.');
    const propertyId = record(
      record(flowRoot.flowInformation).quantitativeReference,
    ).referenceToReferenceFlowProperty;
    const property = list(record(flowRoot.flowProperties).flowProperty)
      .map(record)
      .find((x) => x['@dataSetInternalID'] === propertyId)!;
    const propertyDoc = read(property.referenceToFlowPropertyDataSet, 'flowproperty');
    const propertyRoot = record(propertyDoc.flowPropertyDataSet);
    const groupDoc = read(
      record(record(propertyRoot.flowPropertiesInformation).quantitativeReference)
        .referenceToReferenceUnitGroup,
      'unitgroup',
    );
    if (collectUnitGroupContentIssues(groupDoc).length)
      throw new UnitEvidenceError('Reference UnitGroup has invalid internal identities.');
    const group = record(groupDoc.unitGroupDataSet);
    const unitId = record(
      record(group.unitGroupInformation).quantitativeReference,
    ).referenceToReferenceUnit;
    const units = list(record(group.units).unit).map(record);
    const unit = units.find((x) => x['@dataSetInternalID'] === unitId)!;
    if (
      units.some((x) => flowPropertyFactor(x.meanValue) === 'invalid') ||
      flowPropertyFactor(unit.meanValue) !== 'one' ||
      typeof unit.name !== 'string' ||
      !unit.name.trim()
    )
      throw new UnitEvidenceError(
        'Reference unit must have a finite factor of exactly one; all unit factors must be positive.',
      );
    return { status: 'passed' as const, unit: unit.name, exchange, dependencies };
  } catch (error) {
    if (!(error instanceof UnitEvidenceError)) throw error;
    return {
      status: error.needed ? ('unresolved' as const) : ('failed' as const),
      message: error.message,
      needed: error.needed,
      dependencies,
    };
  }
}
