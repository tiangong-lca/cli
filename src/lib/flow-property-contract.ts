import { isRecord, type JsonObject } from './dataset-local.js';

export type FlowPropertyIssue = { code: string; path: string; message: string };

function token(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/** Exact decimal identity check, not an arithmetic/unit-conversion implementation. */
export function isExactOne(value: unknown): boolean {
  const match = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(token(value));
  if (!match) return false;
  const digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+/u, '');
  const significant = digits.replace(/0+$/u, '');
  const exponent = Number(match[3] ?? '0');
  return (
    significant === '1' &&
    Number.isSafeInteger(exponent) &&
    exponent - (match[2]?.length ?? 0) + digits.length - significant.length === 0
  );
}

/** Resolve the declared internal ID; array order and the literal ID 0 have no meaning. */
export function inspectFlowProperties(flow: JsonObject): {
  properties: JsonObject[];
  reference: JsonObject | null;
  referenceInternalId: string;
  issues: FlowPropertyIssue[];
} {
  const information = isRecord(flow.flowInformation) ? flow.flowInformation : {};
  const quantitative = isRecord(information.quantitativeReference)
    ? information.quantitativeReference
    : {};
  const referenceInternalId = token(quantitative.referenceToReferenceFlowProperty);
  const block = isRecord(flow.flowProperties) ? flow.flowProperties : {};
  const raw = Array.isArray(block.flowProperty) ? block.flowProperty : [block.flowProperty];
  const properties = raw.filter(isRecord);
  const issues: FlowPropertyIssue[] = [];
  const add = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  const ids = new Set<string>();
  const identities = new Set<string>();
  raw.forEach((property, index) => {
    const path = `flowProperties.flowProperty[${index}]`;
    if (!isRecord(property)) {
      add('missing_flow_property', path, 'A flowProperty object is required.');
      return;
    }
    const id = token(property['@dataSetInternalID']);
    if (!/^\d+$/u.test(id)) {
      add(
        'flow_property_internal_id_invalid',
        path,
        'Every property needs an explicit nonnegative internal ID.',
      );
    } else if (ids.has(id)) {
      add('flow_property_internal_id_duplicate', path, 'Property internal IDs must be unique.');
    }
    ids.add(id);
    const ref = isRecord(property.referenceToFlowPropertyDataSet)
      ? property.referenceToFlowPropertyDataSet
      : {};
    const uuid = token(ref['@refObjectId']).toLowerCase();
    const version = token(ref['@version']);
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(uuid) ||
      !/^\d{2}\.\d{2}\.\d{3}$/u.test(version)
    ) {
      add(
        'flow_property_exact_reference_invalid',
        `${path}.referenceToFlowPropertyDataSet`,
        'Every property must reference an exact FlowProperty UUID and version.',
      );
    }
    // Two versions of one property are still competing definitions of one quantity.
    if (identities.has(uuid)) {
      add(
        'flow_property_identity_duplicate',
        path,
        'A FlowProperty UUID may occur only once, including across versions.',
      );
    }
    identities.add(uuid);
    const value = token(property.meanValue);
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) ||
      !Number.isFinite(Number(value))
    ) {
      add(
        'flow_property_mean_invalid',
        `${path}.meanValue`,
        'Property meanValue must be a finite decimal.',
      );
    }
  });
  const matches = properties.filter(
    (property) => token(property['@dataSetInternalID']) === referenceInternalId,
  );
  const reference = referenceInternalId && matches.length === 1 ? matches[0]! : null;
  if (!reference) {
    add(
      'flow_property_reference_unresolved',
      'flowInformation.quantitativeReference.referenceToReferenceFlowProperty',
      'The declared reference ID must resolve to exactly one property; no first-item fallback is permitted.',
    );
  } else if (!isExactOne(reference.meanValue)) {
    add(
      'flow_property_reference_not_normalized',
      'flowProperties.flowProperty',
      'The declared reference property must have meanValue 1; historical quantities are not silently rescaled.',
    );
  }
  // Zero is valid for descriptive secondary properties. Invertibility is checked
  // by the native conversion operation only when that property is used as a unit.
  return { properties, reference, referenceInternalId, issues };
}
