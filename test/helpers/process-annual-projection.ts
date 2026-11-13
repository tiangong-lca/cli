import { businessFixture } from './cli-business-fixtures.js';
import { record, list } from '../../src/lib/validation/process-reference-unit.js';
export const annualVersion = '00.00.001';
export const annualFlowId = '11111111-1111-4111-8111-111111111111';
export const annualPropertyId = '22222222-2222-4222-8222-222222222222';
export const annualGroupId = '33333333-3333-4333-8333-333333333333';
export const annualTexts = (en: string, zh: string) => [
  { '@xml:lang': 'en', '#text': en },
  { '@xml:lang': 'zh', '#text': zh },
];
export function annualFixture(withUnit = true) {
  const payload = businessFixture('process');
  const root = record(payload.processDataSet);
  const exchange = record(list(record(root.exchanges).exchange)[0]);
  exchange.meanAmount = '1000';
  exchange.resultingAmount = '1000';
  exchange.functionalUnitOrOther = annualTexts('treated water at works gate', '厂界处理水');
  const ref = (type: string, id: string, name: string) => ({
    '@type': type,
    '@refObjectId': id,
    '@version': annualVersion,
    '@uri': `../${id}.xml`,
    'common:shortDescription': [{ '@xml:lang': 'en', '#text': name }],
  });
  exchange.referenceToFlowDataSet = ref('flow data set', annualFlowId, 'Water');
  const sources = record(
    record(root.modellingAndValidation).dataSourcesTreatmentAndRepresentativeness,
  );
  sources.annualSupplyOrProductionVolume = annualTexts(
    `1000 ${withUnit ? 'kg ' : ''}treated water at works gate`,
    `1000 ${withUnit ? 'kg ' : ''}厂界处理水`,
  );
  sources.dataTreatmentAndExtrapolationsPrinciples = annualTexts(
    'For this dataset only, annual quantity is 1000 kg/year, assuming one reference batch per year (1000 kg per batch); actual annual production is unknown.',
    '仅适用于本数据集：年度量为1000 kg/年，假设每年一个参考批次（每批1000 kg）；实际年产量未知。',
  );
  const flow = businessFixture('flow');
  const fr = record(flow.flowDataSet);
  const fi = record(fr.flowInformation);
  record(fi.dataSetInformation)['common:UUID'] = annualFlowId;
  record(record(fr.administrativeInformation).publicationAndOwnership)['common:dataSetVersion'] =
    annualVersion;
  fi.quantitativeReference = { referenceToReferenceFlowProperty: '0' };
  fr.flowProperties = {
    flowProperty: {
      '@dataSetInternalID': '0',
      referenceToFlowPropertyDataSet: ref('flow property data set', annualPropertyId, 'Mass'),
      meanValue: '1',
    },
  };
  const info = (id: string, name: string) => ({
    'common:UUID': id,
    'common:name': [{ '@xml:lang': 'en', '#text': name }],
    classificationInformation: {
      'common:classification': {
        'common:class': {
          '@level': '0',
          '@classId': '1',
          '#text': name === 'Mass' ? 'Technical flow properties' : 'Technical unit groups',
        },
      },
    },
  });
  const namespaces = (name: string) => ({
    '@xmlns': `http://lca.jrc.it/ILCD/${name}`,
    '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
    '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    '@version': '1.1',
    '@xsi:schemaLocation': `http://lca.jrc.it/ILCD/${name} ../../schemas/ILCD_${name}DataSet.xsd`,
  });
  const property = {
    flowPropertyDataSet: {
      ...namespaces('FlowProperty'),
      flowPropertiesInformation: {
        dataSetInformation: info(annualPropertyId, 'Mass'),
        quantitativeReference: {
          referenceToReferenceUnitGroup: ref('unit group data set', annualGroupId, 'Mass units'),
        },
      },
      administrativeInformation: structuredClone(fr.administrativeInformation),
    },
  };
  const group = {
    unitGroupDataSet: {
      ...namespaces('UnitGroup'),
      unitGroupInformation: {
        dataSetInformation: info(annualGroupId, 'Mass units'),
        quantitativeReference: { referenceToReferenceUnit: '0' },
      },
      units: { unit: { '@dataSetInternalID': '0', name: 'kg', meanValue: '1' } },
      administrativeInformation: structuredClone(fr.administrativeInformation),
      modellingAndValidation: {
        complianceDeclarations: structuredClone(
          record(root.modellingAndValidation).complianceDeclarations,
        ),
      },
    },
  };
  return { payload, sources, exchange, documents: [flow, property, group], flow, property, group };
}
