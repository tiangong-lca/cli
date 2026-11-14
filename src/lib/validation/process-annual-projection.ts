import { datasetRoot } from '../dataset/json.js';
import { sha256Json } from '../platform/canonical-json-hash.js';
import { list, record, resolveProcessReferenceUnit } from './process-reference-unit.js';

type Json = Record<string, unknown>;
const SOURCES = 'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness';
const FIELD = `${SOURCES}.annualSupplyOrProductionVolume`;
const METHOD = `${SOURCES}.dataTreatmentAndExtrapolationsPrinciples`;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?';
export const ANNUAL_PERIOD_PATTERN =
  /(?:\/\s*(?:year|yr|a)\b|\bper\s+(?:year|annum)\b|\/\s*年|每年|年度|年供应|年产)/iu;
const QUANTITY = new RegExp(`^(${NUMBER})\\s+(.+)$`, 'u');
const EXPLICIT = new RegExp(
  `^(${NUMBER})\\s+(.+?)(?:\\s*/\\s*(?:year|yr|a|年)|\\s+per\\s+(?:year|annum))$`,
  'iu',
);
// Deliberately whole-text assertions, not keyword extraction from arbitrary prose.
const BASIS_EN = new RegExp(
  `^For this dataset only, annual quantity is (${NUMBER}) ([^\\s]+)/(?:year|yr), assuming one reference batch per year \\((${NUMBER}) ([^\\s]+) per batch\\); actual annual production is unknown\\.$`,
  'u',
);
const BASIS_ZH = new RegExp(
  `^仅适用于本数据集：年度量为(${NUMBER}) ([^\\s]+)/年，假设每年一个参考批次（每批(${NUMBER}) ([^\\s]+)）；实际年产量未知。$`,
  'u',
);

type Localized = { language: string; text: string };
function localized(value: unknown): Localized[] | null {
  const items = list(value);
  const result: Localized[] = [];
  for (const item of items) {
    const x = record(item);
    if (
      typeof x['@xml:lang'] !== 'string' ||
      !x['@xml:lang'].trim() ||
      typeof x['#text'] !== 'string'
    )
      return null;
    const language = x['@xml:lang'].trim().toLowerCase();
    if (result.some((y) => y.language === language)) return null;
    result.push({ language, text: x['#text'].trim() });
  }
  return result.length ? result : null;
}
/** Exact decimal equivalence without binary floating-point rounding of evidence. */
export function decimalIdentity(text: string): string | null {
  if (
    !new RegExp(`^${NUMBER}$`, 'u').test(text) ||
    !(Number(text) > 0) ||
    !Number.isFinite(Number(text))
  )
    return null;
  const [mantissa, exponent = '0'] = text.replace(/^\+/u, '').toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa!.split('.');
  const digits = (integer + fraction).replace(/^0+/u, '').replace(/0+$/u, '');
  const all = (integer + fraction).replace(/^0+/u, '');
  return `${digits}e${Number(exponent) - fraction.length + all.length - digits.length}`;
}
export function annualProjectionRequired(payload: Json): boolean {
  const root = datasetRoot(payload, 'process');
  const values = localized(
    record(record(root.modellingAndValidation).dataSourcesTreatmentAndRepresentativeness)
      .annualSupplyOrProductionVolume,
  );
  return !!values?.some((x) => QUANTITY.test(x.text) && !ANNUAL_PERIOD_PATTERN.test(x.text));
}
export function analyzeProcessAnnualVolume(payload: Json, documents: readonly Json[] = []) {
  const root = datasetRoot(payload, 'process');
  const sources = record(
    record(root.modellingAndValidation).dataSourcesTreatmentAndRepresentativeness,
  );
  const values = localized(sources.annualSupplyOrProductionVolume);
  const candidate_sha256 = sha256Json(payload);
  const result = (
    status: 'passed' | 'failed' | 'unresolved' | 'not_applicable',
    code?: string,
    message?: string,
    path = FIELD,
  ) => ({
    status,
    candidate_sha256,
    issues: code ? [{ code, message: message!, path }] : [],
  });
  if (!values || values.some((x) => !QUANTITY.test(x.text))) return result('not_applicable');
  const numbers = values.map((x) => decimalIdentity(QUANTITY.exec(x.text)![1]!));
  if (numbers.some((x) => x === null || x !== numbers[0]))
    return result(
      'failed',
      'annual_volume_quantity_conflict',
      'Annual quantities must be finite, positive and equivalent across languages.',
    );
  if (values.every((x) => EXPLICIT.test(x.text))) {
    const units = values.map((x) => EXPLICIT.exec(x.text)![2]!);
    if (units.some((x) => x !== units[0]))
      return result(
        'failed',
        'annual_volume_unit_conflict',
        'Annual units must agree across languages.',
      );
    return { ...result('passed'), representation: 'explicit_annual' as const };
  }
  if (values.every((x) => ANNUAL_PERIOD_PATTERN.test(x.text))) return result('not_applicable');
  const datasetType = record(
    record(root.modellingAndValidation).LCIMethodAndAllocation,
  ).typeOfDataSet;
  if (datasetType !== 'Unit process, single operation' && datasetType !== 'Unit process, black box')
    return result(
      'failed',
      'annual_volume_basis_unsupported',
      'One-reference-batch fallback applies only to an explicitly declared unit process.',
      METHOD,
    );
  const basis = localized(sources.dataTreatmentAndExtrapolationsPrinciples);
  if (
    !basis ||
    basis.length !== values.length ||
    basis.some((x) => !values.some((y) => x.language === y.language))
  )
    return result(
      'failed',
      'annual_volume_basis_missing',
      'Platform projection requires matching localized annual derivation in dataTreatmentAndExtrapolationsPrinciples.',
      METHOD,
    );
  const parsed = basis.map((x) =>
    (x.language === 'en' ? BASIS_EN : x.language === 'zh' ? BASIS_ZH : null)?.exec(x.text),
  );
  if (parsed.some((x) => !x))
    return result(
      'failed',
      'annual_volume_basis_unsupported',
      'Use the documented one-reference-batch-per-year declaration; arbitrary prose, negations and unsupported fallback assumptions cannot establish annual evidence.',
      METHOD,
    );
  const unit = resolveProcessReferenceUnit(payload, documents);
  if (unit.status !== 'passed')
    return {
      ...result(unit.status, 'annual_volume_reference_unresolved', unit.message),
      dependencies: unit.dependencies,
    };
  const mean = decimalIdentity(String(unit.exchange.meanAmount));
  const resulting = unit.exchange.resultingAmount;
  if (!mean || (resulting !== undefined && decimalIdentity(String(resulting)) !== mean))
    return result(
      'failed',
      'annual_volume_reference_amount_conflict',
      'Reference batch amount must be positive and unambiguous.',
    );
  const reference = list(unit.exchange.referenceToFlowDataSet).map(record)[0]!;
  const descriptions = localized(
    unit.exchange.functionalUnitOrOther ?? reference['common:shortDescription'],
  );
  for (const [index, item] of basis.entries()) {
    const match = parsed[index]!;
    if (
      decimalIdentity(match[1]!) !== numbers[0] ||
      decimalIdentity(match[3]!) !== mean ||
      numbers[0] !== mean ||
      match[2] !== unit.unit ||
      match[4] !== unit.unit
    )
      return result(
        'failed',
        'annual_volume_basis_conflict',
        'Annual value, reference batch, units and one-batch derivation must agree in every language.',
        METHOD,
      );
    const text = values.find((x) => x.language === item.language)!.text;
    if (EXPLICIT.test(text)) {
      if (EXPLICIT.exec(text)![2] !== unit.unit)
        return result(
          'failed',
          'annual_volume_unit_conflict',
          'Annual unit differs from the exact reference unit.',
        );
    } else {
      const suffix = QUANTITY.exec(text)![2]!;
      const description = descriptions?.find((x) => x.language === item.language)?.text;
      if (!description || (suffix !== description && suffix !== `${unit.unit} ${description}`))
        return result(
          'failed',
          'annual_volume_projection_mismatch',
          'Display suffix must match this reference exchange’s localized functional unit or Flow description.',
        );
    }
  }
  return {
    ...result('passed'),
    representation: 'platform_projection' as const,
    unit: unit.unit,
    amount: QUANTITY.exec(values[0]!.text)![1],
    period: 'year',
    basis: 'one_reference_batch_per_year',
    dependencies: unit.dependencies,
    methodology: basis.map((x) => ({
      language: x.language,
      path: METHOD,
      text_sha256: sha256Json(x.text),
    })),
  };
}
