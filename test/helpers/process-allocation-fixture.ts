import { readFileSync } from 'node:fs';
type Json = Record<string, unknown>;
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/tidas-sdk/test-data/${name}`, import.meta.url), 'utf8'),
  ) as Json;
const nested = (value: unknown) => value as Json;
export function allocationFixture(direction = 'Input', type = 'Product flow') {
  const payload = fixture('process-annual-volume.json');
  const root = nested(payload.processDataSet);
  const exchanges = nested(root.exchanges).exchange as Json[];
  const target = structuredClone(exchanges[0]);
  target['@dataSetInternalID'] = '0';
  target.exchangeDirection = direction;
  target.quantitativeReference = false;
  const inventory = exchanges[0];
  inventory.allocations = {
    allocation: { '@internalReferenceToCoProduct': '0', '@allocatedFraction': '100' },
  };
  nested(root.exchanges).exchange = [inventory, target];
  const flow = fixture('tidas-example-flow.json');
  const addReferenceVersions = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(addReferenceVersions);
      return;
    }
    if (value && typeof value === 'object') {
      const item = value as Json;
      if (item['@refObjectId'] && !item['@version']) item['@version'] = '00.00.001';
      Object.values(item).forEach(addReferenceVersions);
    }
  };
  addReferenceVersions(flow);
  const flowRoot = nested(flow.flowDataSet);
  flowRoot['@locations'] = '../ILCDLocations.xml';
  nested(nested(flowRoot.flowInformation).dataSetInformation).classificationInformation = {
    'common:classification': [
      {
        '@name': 'Synthetic fixture',
        'common:class': [
          { '@level': '0', '@classId': 'fixture', '#text': 'Synthetic flow evidence' },
        ],
      },
    ],
  };
  const flowName = nested(nested(nested(flowRoot.flowInformation).dataSetInformation).name);
  flowName.baseName = { '@xml:lang': 'en', '#text': 'Fixture reference product' };
  flowName.treatmentStandardsRoutes = { '@xml:lang': 'en', '#text': 'Synthetic fixture' };
  flowName.mixAndLocationTypes = { '@xml:lang': 'en', '#text': 'Global synthetic flow' };
  for (const item of [inventory, target]) {
    nested(item.referenceToFlowDataSet)['common:shortDescription'] = {
      '@xml:lang': 'en',
      '#text': 'Fixture reference product; Synthetic fixture; Global synthetic flow',
    };
  }
  nested(nested(flowRoot.administrativeInformation).publicationAndOwnership)[
    'common:referenceToOwnershipOfDataSet'
  ] = {
    '@type': 'contact data set',
    '@refObjectId': '33333333-3333-4333-8333-333333333333',
    '@version': '00.00.001',
    '@uri': '../contacts/33333333-3333-4333-8333-333333333333.xml',
    'common:shortDescription': { '@xml:lang': 'en', '#text': 'Synthetic fixture owner' },
  };
  nested(nested(flowRoot.flowInformation).dataSetInformation)['common:UUID'] = nested(
    target.referenceToFlowDataSet,
  )['@refObjectId'];
  nested(nested(flowRoot.administrativeInformation).publicationAndOwnership)[
    'common:dataSetVersion'
  ] = nested(target.referenceToFlowDataSet)['@version'];
  nested(nested(flowRoot.modellingAndValidation).LCIMethod).typeOfDataSet = type;
  return { payload, context: { flow_documents: [flow] } };
}

export function processTransportFixture() {
  return fixture('process-annual-volume.json');
}
