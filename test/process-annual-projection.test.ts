import { loadDistModule } from './helpers/load-dist-module.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeProcessAnnualVolume,
  decimalIdentity,
  annualProjectionRequired,
} from '../src/lib/validation/process-annual-projection.js';
import {
  resolveProcessReferenceUnit,
  record,
  list,
} from '../src/lib/validation/process-reference-unit.js';
import { validateProcessPayload } from '../src/lib/validation/process-payload-validation.js';
import { runDatasetValidate } from '../src/lib/dataset/validate.js';
import { annualFixture, annualTexts } from './helpers/process-annual-projection.js';

for (const withUnit of [true, false])
  test(`Platform projection with unit=${withUnit} binds unchanged quantities, reference chain and bilingual method`, async () => {
    const x = annualFixture(withUnit),
      before = JSON.stringify(x);
    const report = await runDatasetValidate({
      inputPath: 'synthetic',
      type: 'process',
      rawInput: x.payload,
      referenceDocuments: x.documents,
    });
    assert.equal(report.rows[0]!.status, 'valid', JSON.stringify(report.rows[0]!.issues));
    const annual = report.rows[0]!.annual_volume!;
    assert.equal(annual.status, 'passed');
    assert.equal('dependencies' in annual && annual.dependencies.length, 3);
    assert.equal(JSON.stringify(x), before);
  });

test('explicit annual quantities retain ordinary validation and reject bilingual disagreements', () => {
  for (const [en, zh, ok] of [
    ['1000 kg/year', '1000 kg/年', true],
    ['1e3 kg per year', '1000 kg/年', true],
    ['1000 kg/year', '2000 kg/年', false],
    ['1000 kg/year', '1000 MJ/年', false],
    ['1e999 kg/year', '1e999 kg/年', false],
    ['0 kg/year', '0 kg/年', false],
    ['-1000 kg/year', '-1000 kg/年', false],
  ]) {
    const x = annualFixture();
    x.sources.annualSupplyOrProductionVolume = annualTexts(String(en), String(zh));
    assert.equal(validateProcessPayload(x.payload).ok, ok);
  }
  assert.equal(decimalIdentity('+001.000e3'), decimalIdentity('1000'));
  assert.equal(decimalIdentity('.1'), decimalIdentity('0.10'));
  assert.notEqual(decimalIdentity('1000.000000000000001'), decimalIdentity('1000'));
  for (const value of ['garbage', '-1', '0', '1e-999']) assert.equal(decimalIdentity(value), null);
});

type Fixture = ReturnType<typeof annualFixture>;
const failures: Array<[string, (x: Fixture) => void, string]> = [
  [
    'missing method',
    (x) => {
      delete x.sources.dataTreatmentAndExtrapolationsPrinciples;
    },
    'basis_missing',
  ],
  [
    'misleading mention',
    (x) => {
      x.sources.dataTreatmentAndExtrapolationsPrinciples = annualTexts(
        'Do not assume 1000 kg/year.',
        '不得假定1000 kg/年。',
      );
    },
    'basis_unsupported',
  ],
  [
    'two batches',
    (x) => {
      const text = list(x.sources.dataTreatmentAndExtrapolationsPrinciples).map(record);
      text[0]!['#text'] = String(text[0]!['#text']).replace(
        'one reference batch',
        'two reference batches',
      );
    },
    'basis_unsupported',
  ],
  [
    'conflicting method',
    (x) => {
      const text = list(x.sources.dataTreatmentAndExtrapolationsPrinciples).map(record);
      text[1]!['#text'] = String(text[1]!['#text']).replace('年度量为1000', '年度量为2000');
    },
    'basis_conflict',
  ],
  [
    'wrong batch',
    (x) => {
      x.exchange.meanAmount = x.exchange.resultingAmount = '2000';
    },
    'basis_conflict',
  ],
  [
    'ambiguous batch',
    (x) => {
      x.exchange.resultingAmount = '2000';
    },
    'reference_amount_conflict',
  ],
  [
    'zero batch',
    (x) => {
      x.exchange.meanAmount = '0';
    },
    'reference_amount_conflict',
  ],
  [
    'wrong dimension',
    (x) => {
      x.group.unitGroupDataSet.units.unit.name = 'MJ';
    },
    'basis_conflict',
  ],
  [
    'unrelated display',
    (x) => {
      x.sources.annualSupplyOrProductionVolume = annualTexts(
        '1000 arbitrary number',
        '1000 无关数字',
      );
    },
    'projection_mismatch',
  ],
  [
    'mixed explicit unit',
    (x) => {
      x.sources.annualSupplyOrProductionVolume = annualTexts('1000 MJ/year', '1000 kg 厂界处理水');
    },
    'unit_conflict',
  ],
  [
    'missing reference',
    (x) => {
      delete record(
        record(record(x.payload.processDataSet).processInformation).quantitativeReference,
      ).referenceToReferenceFlow;
    },
    'reference_unresolved',
  ],
];
for (const [name, edit, code] of failures)
  test(`annual evidence rejects ${name}`, () => {
    const x = annualFixture();
    edit(x);
    const analysis = analyzeProcessAnnualVolume(x.payload, x.documents);
    assert.equal(analysis.status, 'failed');
    assert.ok(
      analysis.issues.some((issue) => issue.code.endsWith(code)),
      JSON.stringify(analysis),
    );
    assert.equal(
      validateProcessPayload(x.payload, undefined, undefined, { reference_documents: x.documents })
        .ok,
      false,
    );
  });

test('missing exact unit-chain evidence remains unresolved; another version and duplicate documents cannot qualify', () => {
  const x = annualFixture();
  for (let n = 0; n < 3; n++)
    assert.equal(
      resolveProcessReferenceUnit(x.payload, x.documents.slice(0, n)).status,
      'unresolved',
    );
  assert.equal(analyzeProcessAnnualVolume(x.payload).status, 'unresolved');
  assert.equal(resolveProcessReferenceUnit(x.payload, [...x.documents, x.flow]).status, 'failed');
  record(record(record(x.flow.flowDataSet).administrativeInformation).publicationAndOwnership)[
    'common:dataSetVersion'
  ] = '00.00.002';
  assert.equal(resolveProcessReferenceUnit(x.payload, x.documents).status, 'unresolved');
});

test('annual success cannot hide unrelated schema, content or allocation findings', () => {
  const x = annualFixture();
  record(record(record(x.payload.processDataSet).processInformation).dataSetInformation)[
    'common:generalComment'
  ] = annualTexts('pending confirmation', '尚待核实');
  const report = validateProcessPayload(x.payload, undefined, undefined, {
    reference_documents: x.documents,
  });
  assert.equal(report.annual_volume?.status, 'passed');
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((x) => x.code === 'process_placeholder_content'));
});

test('malformed localized fields cannot become projection evidence', () => {
  for (const value of [
    undefined,
    [],
    '1000 kg',
    [{}],
    [{ '@xml:lang': '', '#text': '1000 kg' }],
    [...annualTexts('1000 kg', '1000 kg'), { '@xml:lang': 'EN', '#text': '1000 kg' }],
    annualTexts('unknown', 'unknown'),
  ]) {
    const x = annualFixture();
    x.sources.annualSupplyOrProductionVolume = value;
    assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'not_applicable');
    assert.equal(annualProjectionRequired(x.payload), false);
    assert.equal(validateProcessPayload(x.payload).ok, false);
  }
});

test('reference ambiguity, malformed chains and invalid unit factors fail independently', () => {
  const edits: Array<(x: Fixture) => void> = [
    (x) => {
      x.exchange['@dataSetInternalID'] = '2';
    },
    (x) => {
      record(record(x.flow.flowDataSet).flowProperties).flowProperty = {
        ...record(record(record(x.flow.flowDataSet).flowProperties).flowProperty),
        meanValue: '2',
      };
    },
    (x) => {
      record(record(record(x.flow.flowDataSet).modellingAndValidation).LCIMethod).typeOfDataSet =
        'Elementary flow';
    },
    (x) => {
      x.group.unitGroupDataSet.unitGroupInformation.quantitativeReference.referenceToReferenceUnit =
        '9';
    },
    (x) => {
      x.group.unitGroupDataSet.units.unit.meanValue = '2';
    },
    (x) => {
      x.group.unitGroupDataSet.units.unit.meanValue = '0';
    },
    (x) => {
      x.group.unitGroupDataSet.units.unit.name = ' ';
    },
    (x) => {
      delete record(x.flow.flowDataSet).administrativeInformation;
    },
    (x) => {
      delete record(x.flow.flowDataSet).flowProperties;
    },
  ];
  for (const edit of edits) {
    const x = annualFixture();
    edit(x);
    assert.notEqual(resolveProcessReferenceUnit(x.payload, x.documents).status, 'passed');
  }
  const x = annualFixture();
  Object.defineProperty(x.exchange, 'referenceToFlowDataSet', {
    get() {
      throw new Error('unexpected source failure');
    },
  });
  assert.throws(
    () => resolveProcessReferenceUnit(x.payload, x.documents),
    /unexpected source failure/u,
  );
});

test('bounded applicability, unsupported languages and legacy explicit periods remain distinct', () => {
  const x = annualFixture();
  const method = record(
    record(record(x.payload.processDataSet).modellingAndValidation).LCIMethodAndAllocation,
  );
  method.typeOfDataSet = 'LCI result';
  assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'failed');
  method.typeOfDataSet = 'Unit process, black box';
  assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'passed');
  delete x.exchange.functionalUnitOrOther;
  record(x.exchange.referenceToFlowDataSet)['common:shortDescription'] = annualTexts(
    'treated water at works gate',
    '厂界处理水',
  );
  assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'passed');
  record(record(record(x.flow.flowDataSet).modellingAndValidation).LCIMethod).typeOfDataSet =
    'Waste flow';
  assert.equal(resolveProcessReferenceUnit(x.payload, x.documents).status, 'passed');
  x.sources.annualSupplyOrProductionVolume = [{ '@xml:lang': 'fr', '#text': '1000 kg water' }];
  x.sources.dataTreatmentAndExtrapolationsPrinciples = [
    { '@xml:lang': 'fr', '#text': '1000 kg/year' },
  ];
  assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'failed');
  x.sources.annualSupplyOrProductionVolume = annualTexts('1000 kg 每年', '1000 kg 年度');
  assert.equal(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'not_applicable');
  assert.equal(annualProjectionRequired(x.payload), false);
});

test('emitted annual validator preserves complete unit evidence and emitted Flow write safeguards', async () => {
  const annual = await loadDistModule<
    typeof import('../src/lib/validation/process-annual-projection.js')
  >('src/lib/validation/process-annual-projection.js');
  const flow = await loadDistModule<
    typeof import('../src/lib/validation/flow-reference-properties.js')
  >('src/lib/validation/flow-reference-properties.js');
  const x = annualFixture();
  assert.equal(annual.annualProjectionRequired(x.payload), true);
  assert.equal(annual.analyzeProcessAnnualVolume(x.payload, x.documents).status, 'passed');
  flow.assertFlowReferencePropertyWriteAdmission(x.flow);
  record(record(record(x.flow.flowDataSet).flowProperties).flowProperty).meanValue = '2';
  assert.throws(() => flow.assertFlowReferencePropertyWriteAdmission(x.flow));
  assert.equal(annual.analyzeProcessAnnualVolume(x.payload, x.documents).status, 'failed');
});

test('annual unit lookup refuses implicit latest or malformed dependency identities before requesting evidence', () => {
  for (const invalid of [{ '@version': 'latest' }, { '@refObjectId': 'not-a-uuid' }]) {
    const x = annualFixture();
    Object.assign(record(x.exchange.referenceToFlowDataSet), invalid);
    const report = resolveProcessReferenceUnit(x.payload);
    assert.equal(report.status, 'failed');
    assert.equal(report.needed, undefined);
  }
});

test('period suffix matching cannot split a word into a fabricated unit and per-year period', () => {
  const x = annualFixture();
  x.sources.annualSupplyOrProductionVolume = annualTexts('1000 copper year', '1000 copper year');
  assert.equal(validateProcessPayload(x.payload).ok, false);
  assert.notEqual(analyzeProcessAnnualVolume(x.payload, x.documents).status, 'passed');
});
