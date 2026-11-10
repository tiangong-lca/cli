import { datasetRoot, isRecord } from './dataset-json.js';
import { CliError } from '../shared/errors.js';

type JsonRecord = Record<string, unknown>;

function deepGet(value: JsonRecord, segments: string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

const PROPERTIES_PATH = 'flowDataSet.flowProperties.flowProperty';
const POINTER_PATH =
  'flowDataSet.flowInformation.quantitativeReference.referenceToReferenceFlowProperty';
const INTERNAL_ID = /^(?:0|[1-9]\d{0,4})$/u;
const POSITIVE_DECIMAL = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;

// Bundled public rules: tidas.flow.reference-property-unit.required and
// tidas.flow.flow-property.mean-value.positive. Inspect content without normalizing it.

type FlowPropertyIssue = {
  code: string;
  path: string;
  message: string;
};

function scalarText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function internalIdText(value: unknown): string {
  // Int5 identifiers are exact string tokens, not numbers or whitespace-normalized labels.
  return typeof value === 'string' ? value : '';
}

/** Use the TIDAS real-number syntax, with a positive finite value usable by numeric consumers. */
export function flowPropertyFactor(value: unknown): 'invalid' | 'one' | 'positive' {
  const token = scalarText(value);
  const parts = POSITIVE_DECIMAL.exec(token);
  const numeric = Number(token);
  if (!parts || !(numeric > 0) || !Number.isFinite(numeric)) return 'invalid';

  // Number alone rounds some decimal strings to 1. Check the significant digits and scale.
  const [, integer = '', fractionAfterInteger, fractionOnly, exponent = '0'] = parts;
  const fraction = fractionAfterInteger ?? fractionOnly ?? '';
  const digits = (integer + fraction).replace(/^0+/u, '');
  return /^10*$/u.test(digits) && Number(exponent) === fraction.length - digits.length + 1
    ? 'one'
    : 'positive';
}

export function inspectFlowReferenceProperties(flow: JsonRecord) {
  const issues: FlowPropertyIssue[] = [];
  const raw = deepGet(flow, ['flowProperties', 'flowProperty']);
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const referenceId = internalIdText(
    deepGet(flow, ['flowInformation', 'quantitativeReference', 'referenceToReferenceFlowProperty']),
  );
  const validPointer = INTERNAL_ID.test(referenceId);
  const propertyIds = new Set<string>();
  const matches: Array<{
    property: JsonRecord;
    factor: ReturnType<typeof flowPropertyFactor>;
    path: string;
  }> = [];

  if (entries.length === 0) {
    issues.push({
      code: 'missing_flow_property',
      path: PROPERTIES_PATH,
      message: 'No flowProperties.flowProperty entry found.',
    });
  }
  if (!validPointer) {
    issues.push({
      code: 'missing_quantitative_reference',
      path: POINTER_PATH,
      message: 'referenceToReferenceFlowProperty must contain a valid internal ID.',
    });
  }

  for (const [index, entry] of entries.entries()) {
    const entryPath = Array.isArray(raw) ? `${PROPERTIES_PATH}.${index}` : PROPERTIES_PATH;
    const property = isRecord(entry) ? entry : null;
    const id = internalIdText(property?.['@dataSetInternalID']);
    if (!INTERNAL_ID.test(id)) {
      issues.push({
        code: 'flow_property_invalid_internal_id',
        path: `${entryPath}.@dataSetInternalID`,
        message: 'Flow property must have a valid internal ID.',
      });
    } else {
      if (propertyIds.has(id)) {
        issues.push({
          code: 'flow_property_duplicate_internal_id',
          path: `${entryPath}.@dataSetInternalID`,
          message: `Flow property internal ID ${id} occurs more than once.`,
        });
      }
      propertyIds.add(id);
    }

    const factor = flowPropertyFactor(property?.meanValue);
    const factorPath = `${entryPath}.meanValue`;
    if (factor === 'invalid') {
      issues.push({
        code: 'flow_property_mean_value_not_positive',
        path: factorPath,
        message: 'Flow property meanValue must be a finite positive decimal.',
      });
    }
    if (property && validPointer && id === referenceId) {
      matches.push({ property, factor, path: factorPath });
    }
  }

  const reference = matches.length === 1 ? matches[0]! : null;
  if (validPointer && matches.length === 0) {
    issues.push({
      code: 'methodology_quant_ref_missing_target',
      path: POINTER_PATH,
      message: `referenceToReferenceFlowProperty points to missing internal ID ${referenceId}.`,
    });
  }
  if (reference?.factor === 'positive') {
    issues.push({
      code: 'reference_property_not_one',
      path: reference.path,
      message: `The reference flow property (internal ID ${referenceId}) must have meanValue exactly 1.`,
    });
  }

  return {
    reference: reference?.property ?? null,
    referenceId,
    propertyCount: entries.length,
    issues,
  };
}

export function collectFlowReferencePropertyIssues(payload: JsonRecord): FlowPropertyIssue[] {
  return inspectFlowReferenceProperties(datasetRoot(payload, 'flow')).issues;
}

export function assertFlowReferencePropertyWriteAdmission(payload: JsonRecord): void {
  const issues = collectFlowReferencePropertyIssues(payload);
  if (issues.length > 0) {
    throw new CliError('Flow reference property validation blocked the dataset write.', {
      code: 'FLOW_REFERENCE_PROPERTY_INVALID',
      exitCode: 1,
      details: { issues },
    });
  }
}
