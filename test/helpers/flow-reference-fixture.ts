import { businessFixture } from './cli-business-fixtures.js';

/** Reference ID deliberately differs from both the array position and the default ID zero. */
export function flowReferenceFixture(factor: unknown = '1.0') {
  return {
    flowDataSet: {
      flowInformation: {
        quantitativeReference: { referenceToReferenceFlowProperty: '7' },
      },
      flowProperties: {
        flowProperty: [
          { '@dataSetInternalID': '0', meanValue: '1' },
          { '@dataSetInternalID': '7', meanValue: factor },
        ],
      },
    },
  };
}

/** Complete real-SDK fixture with the same non-positional reference. */
export function businessFlowReferenceFixture(factor: unknown = '1.0') {
  const payload = businessFixture('flow');
  const root = payload.flowDataSet as Record<string, unknown>;
  const info = root.flowInformation as Record<string, unknown>;
  info.quantitativeReference =
    flowReferenceFixture().flowDataSet.flowInformation.quantitativeReference;
  const properties = root.flowProperties as Record<string, unknown>;
  const property = properties.flowProperty as Record<string, unknown>;
  properties.flowProperty = [
    { ...structuredClone(property), '@dataSetInternalID': '0', meanValue: '1' },
    { ...property, '@dataSetInternalID': '7', meanValue: factor },
  ];
  return payload;
}
