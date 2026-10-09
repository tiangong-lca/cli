import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from './errors.js';
import {
  datasetIdentity,
  datasetRoot,
  detectDatasetKind,
  isRecord,
  readDatasetRowsInput,
  unwrapDatasetPayload,
  type DatasetKind,
  type JsonObject,
} from './dataset-local.js';
import { sha256Json } from './dataset-maintenance-contract.js';

type ReferenceKind = 'flow' | 'flowproperty' | 'unitgroup';
type Dimension =
  | 'mass'
  | 'count'
  | 'energy'
  | 'length'
  | 'area'
  | 'volume'
  | 'time'
  | 'area_time'
  | 'transport_work';
type Unit = { name: string; dimension: Dimension; kilograms: number | null };
type EvidenceRow = { payload: JsonObject; sha256: string };
export type MassReferenceEvidence = {
  artifacts: { path: string; bytes: number; sha256: string }[];
  rows: Map<string, EvidenceRow>;
};
export type MassExchangeObservation = {
  exchange_index: number;
  exchange_internal_id: string;
  amount: number | null;
  unit: Unit | null;
  mass_kg: number | null;
  references: { kind: ReferenceKind; id: string; version: string; payload_sha256: string }[];
  error: string | null;
};
export type ProcessMassBalance = {
  process_file: string;
  process_payload_sha256: string;
  status: 'applicable' | 'not_applicable' | 'unresolved';
  unit: 'kg';
  reference_exchange_id: string | null;
  exchanges: MassExchangeObservation[];
  raw_input: number | null;
  product: number | null;
  byproduct: number | null;
  waste: number | null;
  other_output: number | null;
  energy_excluded: null;
  input_mass_kg: number | null;
  output_mass_kg: number | null;
  delta: number | null;
  relative_deviation: number | null;
  findings: { code: string; message: string; exchange_index?: number }[];
};
const token = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const object = (value: unknown): JsonObject => (isRecord(value) ? value : {});
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function numeric(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !token(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function readProcessMassReferences(files: readonly string[] = []): MassReferenceEvidence {
  const evidence: MassReferenceEvidence = { artifacts: [], rows: new Map() };
  for (const selected of [...new Set(files)]) {
    const file = path.resolve(selected);
    const bytes = fs.readFileSync(file);
    let raw: unknown;
    try {
      raw = file.toLowerCase().endsWith('.jsonl')
        ? bytes
            .toString('utf8')
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as unknown)
        : JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CliError('Process QA reference rows must be valid JSON or JSONL.', {
        code: 'PROCESS_QA_REFERENCE_INVALID',
        exitCode: 2,
      });
    }
    for (const row of readDatasetRowsInput(file, raw)) {
      const payload = unwrapDatasetPayload(row);
      const kind = detectDatasetKind(payload);
      const identity = datasetIdentity({}, payload, kind);
      if (
        !['flow', 'flowproperty', 'unitgroup'].includes(kind ?? '') ||
        !identity.id ||
        !identity.version ||
        (row.id !== undefined && row.id !== identity.id) ||
        (row.version !== undefined && row.version !== identity.version)
      )
        throw new CliError(
          'Process QA references require exact Flow, Flow Property or Unit Group identity/version.',
          { code: 'PROCESS_QA_REFERENCE_INVALID', exitCode: 2 },
        );
      const key = `${kind}/${identity.id}/${identity.version}`;
      const sha256 = sha256Json(payload);
      if (evidence.rows.has(key) && evidence.rows.get(key)!.sha256 !== sha256)
        throw new CliError('Process QA reference identity has conflicting payloads.', {
          code: 'PROCESS_QA_REFERENCE_CONFLICT',
          exitCode: 2,
        });
      evidence.rows.set(key, { payload, sha256 });
    }
    evidence.artifacts.push({
      path: file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return evidence;
}

function recognizedUnit(value: unknown): Unit | null {
  // SI symbols retain case and token boundaries; descriptive names may be case folded.
  const name = token(value).normalize('NFKC');
  const lowerName = name.toLowerCase();
  const massSymbols: Record<string, number> = {
    kg: 1,
    g: 1e-3,
    mg: 1e-6,
    ug: 1e-9,
    μg: 1e-9,
    Mg: 1e3,
    t: 1e3,
  };
  const massNames: Record<string, number> = {
    kilogram: 1,
    kilograms: 1,
    gram: 1e-3,
    grams: 1e-3,
    milligram: 1e-6,
    milligrams: 1e-6,
    microgram: 1e-9,
    micrograms: 1e-9,
    megagram: 1e3,
    tonne: 1e3,
    tonnes: 1e3,
  };
  const kilograms = Object.hasOwn(massSymbols, name)
    ? massSymbols[name]
    : Object.hasOwn(massNames, lowerName)
      ? massNames[lowerName]
      : null;
  if (kilograms !== null) return { name, dimension: 'mass', kilograms };
  const dimensions: [Dimension, readonly string[], readonly string[]][] = [
    [
      'count',
      ['1'],
      ['item', 'items', 'item(s)', 'piece', 'pieces', 'unit', 'units', 'unit(s)', 'count'],
    ],
    ['energy', ['J', 'kJ', 'MJ', 'GJ', 'mJ', 'Wh', 'kWh', 'MWh'], []],
    ['length', ['m', 'km', 'cm', 'mm'], []],
    ['area', ['m2', 'km2', 'ha'], []],
    ['volume', ['m3', 'cm3', 'l', 'L'], ['litre', 'liter']],
    [
      'time',
      ['s', 'min', 'h', 'd', 'a', 'yr'],
      ['second', 'seconds', 'hour', 'hours', 'year', 'years'],
    ],
    ['area_time', ['m2*a'], []],
    ['transport_work', ['kg*km', 't*km'], []],
  ];
  const matched = dimensions.find(
    ([, symbols, names]) => symbols.includes(name) || names.includes(lowerName),
  );
  return matched ? { name, dimension: matched[0], kilograms: null } : null;
}

function resolveExchange(
  evidence: MassReferenceEvidence,
  exchange: JsonObject,
  index: number,
  uoms: readonly string[],
): MassExchangeObservation {
  const observation: MassExchangeObservation = {
    exchange_index: index,
    exchange_internal_id: token(exchange['@dataSetInternalID']),
    amount: numeric(exchange.meanAmount ?? exchange.resultingAmount),
    unit: null,
    mass_kg: null,
    references: [],
    error: null,
  };
  const select = (value: unknown, kind: ReferenceKind): JsonObject => {
    const ref = object(value),
      id = token(ref['@refObjectId']),
      version = token(ref['@version']);
    requireValue(id && version, 'An exact reference UUID and version are required.');
    const type = {
      flow: 'flow data set',
      flowproperty: 'flow property data set',
      unitgroup: 'unit group data set',
    }[kind];
    requireValue(
      ref['@type'] === undefined || ref['@type'] === type,
      'Reference type contradicts its physical-unit chain.',
    );
    const row = evidence.rows.get(`${kind}/${id}/${version}`);
    requireValue(row, 'The exact reference payload is missing from selected evidence.');
    observation.references.push({ kind, id, version, payload_sha256: row.sha256 });
    return datasetRoot(row.payload, kind as DatasetKind);
  };
  try {
    requireValue(observation.amount !== null, 'Exchange quantity must be finite and nonnegative.');
    const flow = select(exchange.referenceToFlowDataSet, 'flow');
    const referenceProperty = token(
      object(object(flow.flowInformation).quantitativeReference).referenceToReferenceFlowProperty,
    );
    const properties = array(object(flow.flowProperties).flowProperty)
      .map(object)
      .filter((value) => token(value['@dataSetInternalID']) === referenceProperty);
    requireValue(
      referenceProperty && properties.length === 1,
      'Flow reference property must select one exact property occurrence.',
    );
    requireValue(
      numeric(properties[0].meanValue) === 1,
      'The reference flow property must have meanValue one.',
    );
    const property = select(properties[0].referenceToFlowPropertyDataSet, 'flowproperty');
    const group = select(
      object(object(property.flowPropertiesInformation).quantitativeReference)
        .referenceToReferenceUnitGroup,
      'unitgroup',
    );
    const referenceUnit = token(
      object(object(group.unitGroupInformation).quantitativeReference).referenceToReferenceUnit,
    );
    const units = array(object(group.units).unit)
      .map(object)
      .filter((value) => token(value['@dataSetInternalID']) === referenceUnit);
    requireValue(
      referenceUnit && units.length === 1,
      'Unit Group reference unit must select one exact unit occurrence.',
    );
    requireValue(numeric(units[0].meanValue) === 1, 'The reference unit must have meanValue one.');
    const unit = recognizedUnit(units[0].name);
    requireValue(unit, 'The exact reference unit has an unknown or ambiguous physical dimension.');
    for (const tag of uoms) {
      const tagged = recognizedUnit(tag);
      requireValue(
        tagged &&
          tagged.dimension === unit.dimension &&
          tagged.kilograms === unit.kilograms &&
          // Freight units have distinct scales despite both being nonmass quantities.
          (unit.dimension !== 'transport_work' || tagged.name === unit.name),
        'Exchange unit tag conflicts with exact reference-unit evidence.',
      );
    }
    observation.unit = unit;
    if (unit.kilograms !== null) {
      observation.mass_kg = observation.amount * unit.kilograms;
      requireValue(Number.isFinite(observation.mass_kg), 'Normalized mass quantity overflows.');
    }
  } catch (error) {
    observation.mass_kg = null;
    observation.error = String(error);
  }
  return observation;
}

export function assessProcessMassBalance(input: {
  processFile: string;
  processPayload: JsonObject;
  exchanges: readonly JsonObject[];
  referenceFlowId: string | null;
  references: MassReferenceEvidence;
  classify: (exchange: JsonObject) => { classification: string; uoms: readonly string[] };
}): ProcessMassBalance {
  const categories = input.exchanges.map(input.classify);
  const observations = input.exchanges.map((exchange, index) =>
    resolveExchange(input.references, exchange, index, categories[index].uoms),
  );
  const findings: ProcessMassBalance['findings'] = observations.flatMap((observation) =>
    observation.error
      ? [
          {
            code: 'process_mass_unit_unresolved',
            message: observation.error,
            exchange_index: observation.exchange_index,
          },
        ]
      : [],
  );
  const reference = observations.filter(
    (observation) =>
      input.referenceFlowId !== null && observation.exchange_internal_id === input.referenceFlowId,
  );
  const result: ProcessMassBalance = {
    process_file: input.processFile,
    process_payload_sha256: sha256Json(input.processPayload),
    status: 'unresolved',
    unit: 'kg',
    reference_exchange_id: input.referenceFlowId,
    exchanges: observations,
    raw_input: null,
    product: null,
    byproduct: null,
    waste: null,
    other_output: null,
    energy_excluded: null,
    input_mass_kg: null,
    output_mass_kg: null,
    delta: null,
    relative_deviation: null,
    findings,
  };
  if (reference.length !== 1) {
    findings.push({
      code: 'process_mass_reference_unresolved',
      message: 'Physical mass applicability requires one exact reference exchange.',
    });
    return result;
  }
  if (reference[0].unit && reference[0].unit.dimension !== 'mass' && !reference[0].error) {
    result.status = 'not_applicable';
    return result;
  }
  if (findings.length) return result;
  let raw = 0,
    product = 0,
    byproduct = 0,
    waste = 0,
    other = 0;
  for (const [index, observation] of observations.entries()) {
    if (observation.mass_kg === null) continue;
    const direction = token(input.exchanges[index].exchangeDirection).toLowerCase();
    if (direction === 'input') raw += observation.mass_kg;
    else if (direction === 'output') {
      const category = categories[index].classification;
      if (category === 'product_output') product += observation.mass_kg;
      else if (category === 'byproduct_output') byproduct += observation.mass_kg;
      else if (category === 'waste_output') waste += observation.mass_kg;
      else other += observation.mass_kg;
    } else
      findings.push({
        code: 'process_mass_direction_unresolved',
        message: 'Mass exchange direction must be Input or Output.',
        exchange_index: index,
      });
  }
  const output = product + byproduct + waste + other,
    delta = output - raw;
  const deviation = raw > 0 ? Math.abs(delta) / raw : null;
  if (
    ![raw, output, delta].every(Number.isFinite) ||
    (deviation !== null && !Number.isFinite(deviation))
  )
    findings.push({
      code: 'process_mass_sum_overflow',
      message: 'Mass inventory aggregation must remain finite.',
    });
  if (findings.length) return result;
  Object.assign(result, {
    status: 'applicable',
    raw_input: raw,
    product,
    byproduct,
    waste,
    other_output: other,
    input_mass_kg: raw,
    output_mass_kg: output,
    delta,
    relative_deviation: deviation,
  });
  return result;
}
