function localized(text: string): { '@xml:lang': 'en'; '#text': string } {
  return { '@xml:lang': 'en', '#text': text };
}

function datasetRef(
  type: string,
  id: string,
  version: string,
  description: string,
): {
  '@type': string;
  '@refObjectId': string;
  '@version': string;
  '@uri': string;
  'common:shortDescription': { '@xml:lang': 'en'; '#text': string };
} {
  return {
    '@type': type,
    '@refObjectId': id,
    '@version': version,
    '@uri': `../datasets/${id}_${version}.xml`,
    'common:shortDescription': localized(description),
  };
}

export function makeFlow(typeOfDataSet = 'Product flow'): Record<string, unknown> {
  const classificationInformation =
    typeOfDataSet === 'Elementary flow'
      ? {
          'common:elementaryFlowCategorization': {
            'common:category': [
              {
                '@level': '0',
                '@catId': '1',
                '#text': 'Emissions',
              },
            ],
          },
        }
      : {
          'common:classification': {
            'common:class': [
              {
                '@level': '0',
                '@classId': '0',
                '#text': 'Agriculture, forestry and fishery products',
              },
            ],
          },
        };

  return {
    flowDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Flow',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:ecn': 'http://eplca.jrc.ec.europa.eu/ILCD/Extensions/2018/ECNumber',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Flow ../../schemas/ILCD_FlowDataSet.xsd',
      flowInformation: {
        dataSetInformation: {
          'common:UUID': '11111111-1111-1111-1111-111111111111',
          name: {
            baseName: localized('Test flow'),
            treatmentStandardsRoutes: localized('not applicable'),
            mixAndLocationTypes: localized('market'),
          },
          classificationInformation,
        },
        quantitativeReference: {
          referenceToReferenceFlowProperty: '0',
        },
      },
      modellingAndValidation: {
        LCIMethod: {
          typeOfDataSet,
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': datasetRef(
              'source data set',
              '22222222-2222-2222-2222-222222222222',
              '00.00.001',
              'Compliance',
            ),
            'common:approvalOfOverallCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp': '2026-06-04T00:00:00.000Z',
          'common:referenceToDataSetFormat': datasetRef(
            'source data set',
            '33333333-3333-3333-3333-333333333333',
            '00.00.001',
            'Format',
          ),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
          'common:referenceToOwnershipOfDataSet': datasetRef(
            'contact data set',
            '44444444-4444-4444-4444-444444444444',
            '00.00.001',
            'Owner',
          ),
        },
      },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: datasetRef(
            'flow property data set',
            '55555555-5555-5555-5555-555555555555',
            '00.00.001',
            'Mass',
          ),
          meanValue: '1.0',
        },
      },
    },
  };
}
