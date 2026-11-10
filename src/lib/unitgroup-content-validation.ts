import { isRecord } from './dataset-json.js';

/** Local identity/reference consistency only; no inferred physical conversion factors. */
export function collectUnitGroupContentIssues(payload: Record<string, unknown>) {
  const root = isRecord(payload.unitGroupDataSet) ? payload.unitGroupDataSet : payload;
  const units = isRecord(root.units) ? root.units.unit : undefined;
  const entries = Array.isArray(units) ? units : units === undefined ? [] : [units];
  const info = isRecord(root.unitGroupInformation) ? root.unitGroupInformation : {};
  const reference = isRecord(info.quantitativeReference)
    ? info.quantitativeReference.referenceToReferenceUnit
    : undefined;
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && /^(?:0|[1-9]\d{0,4})$/u.test(value);
  const issues: Array<{ code: string; path: string; message: string }> = [];
  const ids = new Set<string>();
  const pointer =
    'unitGroupDataSet.unitGroupInformation.quantitativeReference.referenceToReferenceUnit';
  if (!entries.length)
    issues.push({
      code: 'unitgroup_units_missing',
      path: 'unitGroupDataSet.units.unit',
      message: 'At least one unit is required.',
    });
  for (const [index, entry] of entries.entries()) {
    const id = isRecord(entry) ? entry['@dataSetInternalID'] : undefined;
    const path = `unitGroupDataSet.units.unit${Array.isArray(units) ? `.${index}` : ''}.@dataSetInternalID`;
    if (!validId(id))
      issues.push({
        code: 'unitgroup_unit_id_invalid',
        path,
        message: 'Unit internal ID must be an Int5 string.',
      });
    else {
      if (ids.has(id))
        issues.push({
          code: 'unitgroup_unit_id_duplicate',
          path,
          message: `Unit internal ID ${id} occurs more than once.`,
        });
      ids.add(id);
    }
  }
  if (!validId(reference))
    issues.push({
      code: 'unitgroup_reference_invalid',
      path: pointer,
      message: 'Reference unit must be an Int5 string.',
    });
  else if (!ids.has(reference))
    issues.push({
      code: 'unitgroup_reference_missing_target',
      path: pointer,
      message: `Reference unit ${reference} does not exist.`,
    });
  return issues;
}
