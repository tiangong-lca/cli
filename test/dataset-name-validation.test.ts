import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDatasetNameIssues } from '../src/lib/dataset-name-validation.js';

const locations = [
  ['flow', 'flowDataSet', 'flowInformation', 'flowProperties'],
  ['process', 'processDataSet', 'processInformation', 'functionalUnitFlowProperties'],
  [
    'lifecyclemodel',
    'lifeCycleModelDataSet',
    'lifeCycleModelInformation',
    'functionalUnitFlowProperties',
  ],
] as const;

test('name punctuation is language-independent and reports the exact localized field without changing input', () => {
  for (const [kind, rootKey, informationKey, fourthField] of locations) {
    for (const field of [
      'baseName',
      'treatmentStandardsRoutes',
      'mixAndLocationTypes',
      fourthField,
    ]) {
      for (const language of ['en', 'zh', 'de', 'fr', 'ja', 'ar']) {
        for (const punctuation of [';', '；']) {
          for (const array of [false, true]) {
            const entry = {
              '@xml:lang': language,
              '#text': `Battery${punctuation} test${punctuation}`,
            };
            const name = {
              [field]: array ? [{ '@xml:lang': 'en', '#text': 'Battery' }, entry] : entry,
            };
            const root = {
              [informationKey]: { dataSetInformation: { name, 'common:synonyms': entry } },
            };
            const payload = { [rootKey]: root };
            const before = JSON.stringify(payload);
            const issues = collectDatasetNameIssues(payload, kind);
            assert.equal(issues.length, 1);
            assert.equal(issues[0]?.code, 'dataset_name_semicolon');
            assert.equal(
              issues[0]?.path,
              `${rootKey}.${informationKey}.dataSetInformation.name.${field}${array ? '.1' : ''}.#text`,
            );
            assert.equal(
              collectDatasetNameIssues(root, kind)[0]?.path,
              issues[0]?.path.slice(rootKey.length + 1),
            );
            assert.equal(JSON.stringify(payload), before);
          }
        }
      }
    }
  }
});

test('name punctuation ignores synonyms, other prose, missing structure and unsupported dataset kinds', () => {
  for (const [kind, rootKey, informationKey, fourthField] of locations) {
    const valid = { '@xml:lang': 'fr', '#text': 'Batterie, rechargeable' };
    const prose = { '@xml:lang': 'fr', '#text': 'Batterie; accumulateur；synonyme' };
    const payload = {
      [rootKey]: {
        [informationKey]: {
          dataSetInformation: {
            name: {
              baseName: valid,
              treatmentStandardsRoutes: [valid],
              mixAndLocationTypes: [],
              [fourthField]: valid,
              'common:other': prose,
            },
            'common:synonyms': [prose],
            'common:generalComment': prose,
          },
        },
      },
    };
    assert.deepEqual(collectDatasetNameIssues(payload, kind), []);
    for (const malformed of [
      null,
      [],
      {},
      { [rootKey]: {} },
      { [informationKey]: null },
      { [informationKey]: {} },
      { [informationKey]: { dataSetInformation: null } },
      { [informationKey]: { dataSetInformation: { name: null } } },
      {
        [informationKey]: {
          dataSetInformation: { name: { baseName: [null, 1, {}, { '#text': 1 }, []] } },
        },
      },
    ]) {
      assert.deepEqual(collectDatasetNameIssues(malformed, kind), []);
    }
    assert.deepEqual(collectDatasetNameIssues(payload, 'contact'), []);
  }
  // QA also accepts legacy scalar text; schema continues to own its structural validity.
  const legacy = {
    flowInformation: { dataSetInformation: { name: { baseName: 'Battery; rechargeable' } } },
  };
  assert.equal(
    collectDatasetNameIssues(legacy, 'flow')[0]?.path,
    'flowInformation.dataSetInformation.name.baseName',
  );
});
