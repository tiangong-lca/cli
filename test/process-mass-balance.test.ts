import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProcessQa } from '../src/lib/process-qa.js';

type JsonRecord = Record<string, unknown>;
const version = '00.00.001';
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const reference = (index: number, type: string) => ({
  '@refObjectId': id(index),
  '@version': version,
  '@type': type,
});
const admin = { publicationAndOwnership: { 'common:dataSetVersion': version } };

function unitChain(start: number, unit: string): JsonRecord[] {
  return [
    {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: { 'common:UUID': id(start) },
          quantitativeReference: { referenceToReferenceFlowProperty: '0' },
        },
        flowProperties: {
          flowProperty: {
            '@dataSetInternalID': '0',
            meanValue: '1',
            referenceToFlowPropertyDataSet: reference(start + 1, 'flow property data set'),
          },
        },
        administrativeInformation: admin,
      },
    },
    {
      flowPropertyDataSet: {
        flowPropertiesInformation: {
          dataSetInformation: { 'common:UUID': id(start + 1) },
          quantitativeReference: {
            referenceToReferenceUnitGroup: reference(start + 2, 'unit group data set'),
          },
        },
        administrativeInformation: admin,
      },
    },
    {
      unitGroupDataSet: {
        unitGroupInformation: {
          dataSetInformation: { 'common:UUID': id(start + 2) },
          quantitativeReference: { referenceToReferenceUnit: '0' },
        },
        units: { unit: { '@dataSetInternalID': '0', name: unit, meanValue: '1' } },
        administrativeInformation: admin,
      },
    },
  ];
}

function processWithCountProduct(): JsonRecord {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': id(7),
          name: { baseName: { '@xml:lang': 'en', '#text': 'Fixture machine' } },
        },
        quantitativeReference: {
          referenceToReferenceFlow: '0',
          functionalUnitOrOther: 'One machine',
        },
      },
      administrativeInformation: admin,
      exchanges: {
        exchange: [
          {
            '@dataSetInternalID': '0',
            exchangeDirection: 'Output',
            meanAmount: '1',
            commonComment: '[tg_io_kind_tag=product]',
            referenceToFlowDataSet: reference(1, 'flow data set'),
          },
          {
            '@dataSetInternalID': '1',
            exchangeDirection: 'Input',
            meanAmount: '10',
            commonComment: 'raw material',
            referenceToFlowDataSet: reference(4, 'flow data set'),
          },
          {
            '@dataSetInternalID': '2',
            exchangeDirection: 'Output',
            meanAmount: '2',
            commonComment: 'waste',
            referenceToFlowDataSet: reference(4, 'flow data set'),
          },
        ],
      },
    },
  };
}

test('count-valued reference products cannot be added to kilograms or reported as a mass deviation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mass-dimensions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rowsFile = path.join(root, 'process.json');
  const referenceFile = path.join(root, 'references.json');
  const original = JSON.stringify([processWithCountProduct()]);
  fs.writeFileSync(rowsFile, original);
  fs.writeFileSync(
    referenceFile,
    JSON.stringify([...unitChain(1, 'Item(s)'), ...unitChain(4, 'kg')]),
  );
  const options = { rowsFile, outDir: path.join(root, 'qa'), referenceRowsFiles: [referenceFile] };
  const report = await runProcessQa(options);
  assert.equal(
    report.totals.raw_input,
    null,
    'incomparable dimensions must not fabricate a material mass total',
  );
  assert.equal(report.totals.relative_deviation, null);
  assert.equal(report.logic_version, 'v2.2-unit-aware');
  const findings = fs.readFileSync(report.files.rule_findings!, 'utf8');
  assert.ok(!findings.includes('process_material_balance_deviation'));
  assert.equal(
    fs.readFileSync(rowsFile, 'utf8'),
    original,
    'QA does not alter any quantity or reference',
  );
});

async function evaluate(
  t: import('node:test').TestContext,
  unit: string,
  change?: (process: JsonRecord, references: JsonRecord[]) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mass-assessment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const process = processWithCountProduct(),
    references = [...unitChain(1, unit), ...unitChain(4, 'kg')];
  change?.(process, references);
  const rowsFile = path.join(root, 'rows.json'),
    refs = path.join(root, 'references.jsonl');
  fs.writeFileSync(rowsFile, JSON.stringify([process]));
  fs.writeFileSync(refs, references.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const before = fs.readFileSync(rowsFile, 'utf8');
  const referenceBytes = fs.readFileSync(refs);
  const report = await runProcessQa({
    rowsFile,
    referenceRowsFiles: [refs],
    outDir: path.join(root, 'qa'),
  });
  assert.equal(fs.readFileSync(rowsFile, 'utf8'), before);
  assert.deepEqual(fs.readFileSync(refs), referenceBytes);
  assert.equal(report.reference_evidence?.length, 1);
  assert.match(report.reference_evidence![0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    report.reference_evidence![0].sha256,
    createHash('sha256').update(referenceBytes).digest('hex'),
  );
  assert.match(report.mass_balance![0].process_payload_sha256, /^[a-f0-9]{64}$/u);
  return report;
}
function object(value: unknown): JsonRecord {
  return value as JsonRecord;
}
function exchanges(process: JsonRecord): JsonRecord[] {
  return object(object(process.processDataSet).exchanges).exchange as JsonRecord[];
}

test('known count and canonical area-time references are explicitly not applicable, with complete unit evidence', async (t) => {
  for (const unit of ['Item(s)', 'm2*a', 'm²*a']) {
    const report = await evaluate(t, unit);
    const mass = report.mass_balance![0];
    assert.equal(mass.status, 'not_applicable');
    assert.equal(mass.findings.length, 0);
    assert.equal(mass.exchanges.length, 3);
    assert.ok(mass.exchanges.every((row) => row.references.length === 3));
    assert.equal(report.totals.raw_input, null);
    assert.equal(report.totals.delta, null);
    assert.equal(report.totals.energy_excluded, null);
  }
});

test('comparable kilograms retain a real mass imbalance finding', async (t) => {
  const report = await evaluate(t, 'kg');
  const mass = report.mass_balance![0];
  assert.equal(mass.status, 'applicable');
  assert.equal(mass.raw_input, 10);
  assert.equal(mass.output_mass_kg, 3);
  assert.equal(mass.relative_deviation, 0.7);
  assert.match(
    fs.readFileSync(report.files.rule_findings!, 'utf8'),
    /process_material_balance_deviation/u,
  );
});

test('exact transport-work inputs retain quantities and references without entering a kg balance', async (t) => {
  for (const unit of ['kg*km', 't*km']) {
    const report = await evaluate(t, 'kg', (process, refs) => {
      refs.push(...unitChain(10, unit));
      exchanges(process).push({
        '@dataSetInternalID': '3',
        exchangeDirection: 'Input',
        meanAmount: '7375.19',
        commonComment: `[tg_io_uom_tag=${unit}] freight transport`,
        referenceToFlowDataSet: reference(10, 'flow data set'),
      });
    });
    const mass = report.mass_balance![0];
    assert.equal(mass.status, 'applicable');
    assert.deepEqual(mass.findings, []);
    assert.equal(mass.input_mass_kg, 10);
    assert.equal(mass.output_mass_kg, 3);
    assert.equal(mass.relative_deviation, 0.7);
    const transport = mass.exchanges[3];
    assert.equal(transport.amount, 7375.19);
    assert.deepEqual(transport.unit, { name: unit, dimension: 'transport_work', kilograms: null });
    assert.equal(transport.mass_kg, null);
    assert.deepEqual(
      transport.references.map(({ kind, id: refId, version: refVersion }) => [
        kind,
        refId,
        refVersion,
      ]),
      [
        ['flow', id(10), version],
        ['flowproperty', id(11), version],
        ['unitgroup', id(12), version],
      ],
    );
    assert.ok(transport.references.every((ref) => /^[a-f0-9]{64}$/u.test(ref.payload_sha256)));
    assert.match(
      fs.readFileSync(report.files.rule_findings!, 'utf8'),
      /process_material_balance_deviation/u,
    );
  }
});

test('exact transport-work reference products make mass applicability and totals unavailable', async (t) => {
  for (const unit of ['kg*km', 't*km']) {
    const report = await evaluate(t, unit);
    const mass = report.mass_balance![0];
    assert.equal(mass.status, 'not_applicable');
    assert.deepEqual(mass.findings, []);
    assert.equal(mass.exchanges[0].unit?.dimension, 'transport_work');
    assert.equal(mass.exchanges[0].mass_kg, null);
    assert.equal(mass.input_mass_kg, null);
    assert.equal(mass.output_mass_kg, null);
    assert.equal(mass.delta, null);
    assert.equal(mass.relative_deviation, null);
    assert.equal(report.totals.raw_input, null);
    assert.equal(report.totals.relative_deviation, null);
    assert.doesNotMatch(
      fs.readFileSync(report.files.rule_findings!, 'utf8'),
      /process_material_balance_deviation/u,
    );
  }
});

test('mixed inventories select the exact freight reference ID and exclude both freight directions', async (t) => {
  for (const unit of ['kg*km', 't*km']) {
    const report = await evaluate(t, 'kg', (process, refs) => {
      refs.push(...unitChain(10, 'MJ'), ...unitChain(13, 'm3'), ...unitChain(16, unit));
      const group = object(refs[14].unitGroupDataSet);
      object(object(group.unitGroupInformation).quantitativeReference).referenceToReferenceUnit =
        '7';
      object(group.units).unit = [
        {
          '@dataSetInternalID': '0',
          name: unit === 'kg*km' ? 't*km' : 'kg*km',
          meanValue: unit === 'kg*km' ? '1000' : '0.001',
        },
        { '@dataSetInternalID': '7', name: unit, meanValue: '1' },
      ];
      const rows = exchanges(process);
      for (const [start, amount, direction] of [
        [10, '100', 'Input'],
        [13, '1000', 'Input'],
        [16, '100000000', 'Input'],
        [16, '999', 'Output'],
      ] as const) {
        rows.push({
          '@dataSetInternalID': String(rows.length),
          exchangeDirection: direction,
          meanAmount: amount,
          referenceToFlowDataSet: reference(start, 'flow data set'),
        });
      }
    });
    const mass = report.mass_balance![0];
    assert.equal(mass.status, 'applicable');
    assert.deepEqual(mass.findings, []);
    assert.equal(mass.input_mass_kg, 10);
    assert.equal(mass.output_mass_kg, 3);
    assert.equal(mass.relative_deviation, 0.7);
    assert.deepEqual(
      mass.exchanges.slice(3).map((row) => [row.amount, row.unit?.dimension, row.mass_kg]),
      [
        [100, 'energy', null],
        [1000, 'volume', null],
        [100000000, 'transport_work', null],
        [999, 'transport_work', null],
      ],
    );
    assert.ok(mass.exchanges.slice(5).every((row) => row.unit?.name === unit));
  }
});

test('freight-like unsupported composite spellings remain unresolved', async (t) => {
  for (const unit of ['KG*km', 'kg*KM', 'kg km', 'kg/km', 'kg*km*a', 'tkm']) {
    const report = await evaluate(t, unit);
    assert.equal(report.mass_balance![0].status, 'unresolved', unit);
    assert.match(report.mass_balance![0].exchanges[0].error!, /unknown or ambiguous/u);
    assert.equal(report.totals.raw_input, null);
    assert.equal(report.totals.relative_deviation, null);
  }
});

test('transport-work unit tags cannot disguise different scales or mass dimensions', async (t) => {
  for (const [unit, tag] of [
    ['kg*km', 't*km'],
    ['t*km', 'kg*km'],
    ['kg*km', 'kg'],
    ['kg', 'kg*km'],
  ]) {
    const report = await evaluate(t, unit, (process) => {
      exchanges(process)[0].commonComment = `[tg_io_uom_tag=${tag}]`;
    });
    const mass = report.mass_balance![0];
    assert.equal(mass.status, 'unresolved');
    assert.equal(mass.exchanges[0].mass_kg, null);
    assert.match(mass.exchanges[0].error!, /unit tag conflicts/u);
    assert.equal(report.totals.relative_deviation, null);
  }
});

test('transport work still requires exact reference versions and unit factor one', async (t) => {
  for (const change of [
    (process: JsonRecord) => {
      object(exchanges(process)[0].referenceToFlowDataSet)['@version'] = '00.00.002';
    },
    (_process: JsonRecord, refs: JsonRecord[]) => {
      object(object(object(refs[2].unitGroupDataSet).units).unit).meanValue = '1000';
    },
  ]) {
    const report = await evaluate(t, 'kg*km', change);
    assert.equal(report.mass_balance![0].status, 'unresolved');
    assert.ok(
      report.mass_balance![0].findings.some(
        (finding) => finding.code === 'process_mass_unit_unresolved',
      ),
    );
    assert.equal(report.mass_balance![0].exchanges[0].mass_kg, null);
    assert.equal(report.totals.relative_deviation, null);
  }
});

test('mass-valued fuels and grams participate in kg balance while energy quantities stay separate', async (t) => {
  const report = await evaluate(t, 'kg', (process, refs) => {
    refs.splice(3, 3, ...unitChain(4, 'g'));
    refs.push(...unitChain(10, 'kWh'));
    const rows = exchanges(process);
    rows[0].meanAmount = 10;
    rows[1].meanAmount = '10000';
    rows[2].meanAmount = '5000';
    rows.push({
      ...rows[1],
      '@dataSetInternalID': '3',
      meanAmount: '5000',
      commonComment: '[tg_io_kind_tag=energy] diesel fuel',
    });
    rows.push({
      ...rows[1],
      '@dataSetInternalID': '4',
      meanAmount: '100',
      referenceToFlowDataSet: reference(10, 'flow data set'),
      commonComment: 'electricity',
    });
  });
  const mass = report.mass_balance![0];
  assert.equal(mass.status, 'applicable');
  assert.equal(mass.input_mass_kg, 15);
  assert.equal(mass.output_mass_kg, 15);
  assert.equal(mass.relative_deviation, 0);
  assert.equal(mass.exchanges[3].mass_kg, 5);
  assert.equal(mass.exchanges[4].mass_kg, null);
  assert.equal(report.totals.energy_excluded, null);
});

test('missing exact unit evidence, ambiguous composites and contradictory mass tags remain actionable', async (t) => {
  for (const [unit, change] of [
    ['kg*m', undefined],
    [
      'kg',
      (_process: JsonRecord, refs: JsonRecord[]) => {
        refs.pop();
      },
    ],
    [
      'm2*a',
      (process: JsonRecord) => {
        exchanges(process)[0].commonComment = '[tg_io_uom_tag=kg]';
      },
    ],
  ] as const) {
    const report = await evaluate(t, unit, change);
    assert.equal(report.mass_balance![0].status, 'unresolved');
    assert.ok(
      report.mass_balance![0].findings.some(
        (finding) => finding.code === 'process_mass_unit_unresolved',
      ),
    );
    assert.equal(report.totals.relative_deviation, null);
  }
});

test('invalid exact chains and quantities cannot fabricate an applicable mass assessment', async (t) => {
  const mutations: ((process: JsonRecord, refs: JsonRecord[]) => void)[] = [
    (p) => {
      delete object(exchanges(p)[0].referenceToFlowDataSet)['@version'];
    },
    (p) => {
      object(exchanges(p)[0].referenceToFlowDataSet)['@type'] = 'source data set';
    },
    (p) => {
      exchanges(p)[0].referenceToFlowDataSet = null;
    },
    (p) => {
      exchanges(p)[0].meanAmount = ' ';
    },
    (p) => {
      exchanges(p)[0].meanAmount = true;
    },
    (p) => {
      exchanges(p)[0].meanAmount = '-1';
    },
    (p) => {
      exchanges(p)[0].meanAmount = '1e309';
    },
    (_p, r) => {
      object(object(r[0].flowDataSet).flowInformation).quantitativeReference = {};
    },
    (_p, r) => {
      object(r[0].flowDataSet).flowProperties = {};
    },
    (_p, r) => {
      const properties = object(object(r[0].flowDataSet).flowProperties);
      properties.flowProperty = [properties.flowProperty, properties.flowProperty];
    },
    (_p, r) => {
      object(object(object(r[0].flowDataSet).flowProperties).flowProperty).meanValue = '2';
    },
    (_p, r) => {
      object(object(r[1].flowPropertyDataSet).flowPropertiesInformation).quantitativeReference = {};
    },
    (_p, r) => {
      object(object(r[2].unitGroupDataSet).unitGroupInformation).quantitativeReference = {};
    },
    (_p, r) => {
      object(r[2].unitGroupDataSet).units = {};
    },
    (_p, r) => {
      const units = object(object(r[2].unitGroupDataSet).units);
      units.unit = [units.unit, units.unit];
    },
    (_p, r) => {
      object(object(object(r[2].unitGroupDataSet).units).unit).meanValue = '0';
    },
    (_p, r) => {
      object(object(object(r[2].unitGroupDataSet).units).unit).name = {};
    },
    (p) => {
      exchanges(p)[0].commonComment = '[tg_io_uom_tag=g]';
    },
    (p) => {
      exchanges(p)[0].commonComment = '[tg_io_uom_tag=unknown]';
    },
    (p) => {
      exchanges(p)[1].exchangeDirection = 'unknown';
    },
    (p) => {
      object(object(p.processDataSet).processInformation).quantitativeReference = {};
    },
    (p) => {
      exchanges(p)[1]['@dataSetInternalID'] = '0';
    },
  ];
  for (const [index, mutation] of mutations.entries()) {
    const report = await evaluate(t, 'kg', mutation);
    assert.equal(report.mass_balance![0].status, 'unresolved', `mutation ${index}`);
    assert.ok(report.mass_balance![0].findings.length, `mutation ${index}`);
    assert.equal(report.totals.raw_input, null);
    assert.equal(report.totals.relative_deviation, null);
  }
});

test('kg conversion and summation overflow stay unresolved', async (t) => {
  const conversion = await evaluate(t, 't', (p) => {
    exchanges(p)[0].meanAmount = '1e308';
  });
  assert.equal(conversion.mass_balance![0].status, 'unresolved');
  assert.match(conversion.mass_balance![0].findings[0].message, /overflows/u);
  const sum = await evaluate(t, 'kg', (p) => {
    exchanges(p)[0].meanAmount = '1e308';
    exchanges(p)[2].meanAmount = '1e308';
  });
  assert.equal(sum.mass_balance![0].status, 'unresolved');
  assert.ok(
    sum.mass_balance![0].findings.some((finding) => finding.code === 'process_mass_sum_overflow'),
  );
});

test('reference files fail before QA output on invalid JSON, unsupported rows or contradictory identity/content', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mass-reference-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = path.join(root, 'rows.json');
  fs.writeFileSync(rows, JSON.stringify([processWithCountProduct()]));
  const original = unitChain(1, 'kg')[0];
  const changed = structuredClone(original);
  object(changed.flowDataSet).extra = 'different-content';
  const cases = [
    ['invalid.json', '{'],
    ['invalid.jsonl', '{\n'],
    ['primitive.json', '1'],
    ['unsupported.json', '[{}]'],
    ['outer-id.json', JSON.stringify([{ ...original, id: id(99) }])],
    ['outer-version.json', JSON.stringify([{ ...original, version: '00.00.002' }])],
    ['missing-uuid.json', JSON.stringify([{ flowDataSet: {} }])],
    ['conflict.json', JSON.stringify([original, changed])],
  ];
  for (const [name, value] of cases) {
    const file = path.join(root, name),
      out = path.join(root, `${name}-qa`);
    fs.writeFileSync(file, value);
    await assert.rejects(runProcessQa({ rowsFile: rows, referenceRowsFiles: [file], outDir: out }));
    assert.equal(fs.existsSync(out), false, name);
  }
  const missingOut = path.join(root, 'missing-qa');
  await assert.rejects(
    runProcessQa({
      rowsFile: rows,
      referenceRowsFiles: [path.join(root, 'absent.json')],
      outDir: missingOut,
    }),
  );
  assert.equal(fs.existsSync(missingOut), false);
});

test('identical reference payloads are deduplicated without changing exact row evidence', async (t) => {
  const report = await evaluate(t, 'kg', (_p, refs) => {
    refs.push(structuredClone(refs[0]));
  });
  assert.equal(report.mass_balance![0].status, 'applicable');
  assert.equal(report.mass_balance![0].exchanges[0].references.length, 3);
});

test('by-products and other mass outputs are retained in conservation totals', async (t) => {
  const report = await evaluate(t, 'kg', (process) => {
    const rows = exchanges(process);
    rows.push({
      ...rows[2],
      '@dataSetInternalID': '3',
      meanAmount: 3,
      commonComment: 'by-product',
    });
    rows.push({ ...rows[2], '@dataSetInternalID': '4', meanAmount: 4, commonComment: '' });
  });
  assert.equal(report.mass_balance![0].byproduct, 3);
  assert.equal(report.mass_balance![0].other_output, 4);
  assert.equal(report.totals.product_plus_byproduct_plus_waste, 6);
  assert.equal(report.totals.other_output, 4);
  assert.equal(report.totals.delta, 0);
});

test('zero mass input never invents a relative denominator and positive output remains a finding', async (t) => {
  for (const output of [0, 1]) {
    const report = await evaluate(t, 'kg', (process) => {
      for (const row of exchanges(process)) row.meanAmount = 0;
      exchanges(process)[0].meanAmount = output;
    });
    assert.equal(report.mass_balance![0].status, 'applicable');
    assert.equal(report.totals.raw_input, 0);
    assert.equal(report.totals.relative_deviation, null);
    assert.equal(report.totals.delta, output);
    assert.equal(
      fs
        .readFileSync(report.files.rule_findings!, 'utf8')
        .includes('process_material_balance_deviation'),
      output > 0,
    );
  }
});

test('cross-process diagnostic totals reject overflow even when each kg inventory is finite', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mass-total-overflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const process = processWithCountProduct();
  const rows = exchanges(process);
  rows[0].meanAmount = '1e308';
  rows[1].meanAmount = '1e308';
  rows[2].meanAmount = 0;
  const other = structuredClone(process);
  object(object(other.processDataSet).processInformation).dataSetInformation = {
    'common:UUID': id(99),
  };
  const file = path.join(root, 'processes.json'),
    refs = path.join(root, 'refs.json');
  fs.writeFileSync(file, JSON.stringify([process, other]));
  fs.writeFileSync(refs, JSON.stringify([...unitChain(1, 'kg'), ...unitChain(4, 'kg')]));
  const report = await runProcessQa({
    rowsFile: file,
    referenceRowsFiles: [refs],
    outDir: path.join(root, 'qa'),
  });
  assert.ok(report.mass_balance!.every((mass) => mass.status === 'applicable'));
  assert.equal(report.process_count, 2);
  assert.equal(report.totals.raw_input, null);
  assert.match(fs.readFileSync(report.files.rule_findings!, 'utf8'), /process_mass_sum_overflow/u);
});

test('SI unit symbol case must not turn magnetic units into mass', async (t) => {
  for (const unit of ['T', 'G', 'KG', 'm g', 'k g']) {
    const report = await evaluate(t, unit);
    assert.equal(report.mass_balance![0].status, 'unresolved', unit);
    assert.equal(report.totals.raw_input, null);
  }
});

test('Mg and mg preserve distinct mass scales while descriptive unit names may be case folded', async (t) => {
  for (const [unit, kilograms] of [
    ['Mg', 1000],
    ['mg', 0.000001],
    ['KILOGRAM', 1],
  ] as const) {
    const report = await evaluate(t, unit);
    assert.equal(report.mass_balance![0].exchanges[0].mass_kg, kilograms, unit);
  }
});

test('unit tags preserve SI case independently of case-insensitive tag names', async (t) => {
  const matching = await evaluate(t, 'Mg', (process) => {
    exchanges(process)[0].commonComment = '[TG_IO_UOM_TAG=Mg]';
  });
  assert.equal(matching.mass_balance![0].exchanges[0].mass_kg, 1000);
  const mismatched = await evaluate(t, 'Mg', (process) => {
    exchanges(process)[0].commonComment = '[tg_io_uom_tag=mg]';
  });
  assert.equal(mismatched.mass_balance![0].status, 'unresolved');
});
