export function flowReferenceFixture(meanValue = '1.0') {
  return {
    flowProperties: { flowProperty: { '@dataSetInternalID': '7', meanValue } },
    flowInformation: { quantitativeReference: { referenceToReferenceFlowProperty: '7' } },
  };
}
