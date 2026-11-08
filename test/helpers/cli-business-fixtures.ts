import { readFileSync } from 'node:fs';
import type { DatasetType, JsonObject } from '../../src/application/dataset-types.js';

export const writableTypes = ['flow', 'process', 'model', 'source', 'contact'] as const;
export const businessActor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const businessReviewer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const businessOutsider = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const businessVersion = '00.00.001';
export const wrappers: Record<string, string> = {
  flow: 'flowDataSet',
  process: 'processDataSet',
  model: 'lifeCycleModelDataSet',
  source: 'sourceDataSet',
  contact: 'contactDataSet',
};
export const information: Record<string, string> = {
  flow: 'flowInformation',
  process: 'processInformation',
  model: 'lifeCycleModelInformation',
  source: 'sourceInformation',
  contact: 'contactInformation',
};
export function businessFixture(type: (typeof writableTypes)[number]): JsonObject {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/cli-business/${type}.json`, import.meta.url), 'utf8'),
  ) as JsonObject;
}
export function businessIdentity(type: DatasetType, content: JsonObject) {
  const root = content[wrappers[type]!] as JsonObject;
  const info = root[information[type]!] as JsonObject;
  return {
    id: (info.dataSetInformation as JsonObject)['common:UUID'] as string,
    version: ((root.administrativeInformation as JsonObject).publicationAndOwnership as JsonObject)[
      'common:dataSetVersion'
    ] as string,
  };
}
export function businessEdit(type: DatasetType, content: JsonObject, label = 'Edited fixture') {
  const edited = structuredClone(content);
  const root = edited[wrappers[type]!] as JsonObject;
  const info = root[information[type]!] as JsonObject;
  (info.dataSetInformation as JsonObject)['common:generalComment'] = {
    '@xml:lang': 'en',
    '#text': label,
  };
  return edited;
}
