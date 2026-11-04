import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLocalizedTextLanguageUniqueness,
  mergeLocalizedTextParagraphs,
  collectLocalizedTextUniquenessIssues,
} from '../src/lib/dataset-localized-text.js';
import { buildDatasetValidationLayers } from '../src/lib/dataset-validation-layers.js';
import { validateFlowPayload } from '../src/lib/flow-payload-validation.js';
import { validateLifecyclemodelPayload } from '../src/lib/lifecyclemodel-save-draft-run.js';
import { __testInternals as packageInternals } from '../src/lib/tidas-sdk-package-validator.js';

const en = (text: string) => ({ '@xml:lang': 'en', '#text': text });

test('localized uniqueness scans each raw field independently without changing content or language variants', () => {
  const value = {
    'common:name': en('singleton'),
    generalComment: [en('English'), { '@xml:lang': 'zh', '#text': '中文' }],
    'common:shortDescription': [
      en('English'),
      { '@xml:lang': 'en-US', '#text': 'American English' },
    ],
    exchanges: [{ comment: [en('first')] }, { comment: [en('second')] }],
    classification: [
      { '@level': '0', '#text': 'First' },
      { '@level': '1', '#text': 'Second' },
    ],
    empty: [],
    unknown: [null, 5, { '@xml:lang': 5 }, 'text'],
  };
  const before = JSON.stringify(value);
  assert.deepEqual(collectLocalizedTextUniquenessIssues(value), []);
  assertLocalizedTextLanguageUniqueness(value);
  assert.equal(JSON.stringify(value), before);
});

test('localized uniqueness detects duplicates with extra attributes, missing texts and canonical language spelling', () => {
  const value = {
    generalComment: [
      en('original'),
      { '@xml:lang': ' EN ', '#text': 'additional', '@source': 'extra' },
      en('third'),
    ],
    nested: [
      { 'common:shortDescription': [{ '@xml:lang': 'zh' }, { '@xml:lang': 'zh', '#text': '' }] },
    ],
  };
  const before = JSON.stringify(value);
  const issues = collectLocalizedTextUniquenessIssues(value);
  assert.deepEqual(
    issues.map((issue) => issue.path),
    [
      'generalComment.1.@xml:lang',
      'generalComment.2.@xml:lang',
      'nested.0.common:shortDescription.1.@xml:lang',
    ],
  );
  assert.ok(issues.every((issue) => issue.code === 'duplicate_language_entry'));
  assert.match(issues[0]!.message, /index 0/u);
  assert.equal(JSON.stringify(value), before);
});

test('all validation policies report duplicate raw language fields even when schemas fail or strip attributes', () => {
  const payload = {
    comment: [en('original'), { ...en('additional'), '@extra': true, '@level': '0' }],
  };
  const failing = {
    success: false as const,
    result: {},
    issues: [{ path: ['other'], code: 'invalid_type', message: 'Other invalid field' }],
  };
  const layers = buildDatasetValidationLayers(payload, failing, [], []);
  assert.equal(layers.validation_layers.multilingual.status, 'failed');
  assert.equal(layers.additional_multilingual_issues[0]!.path, 'comment.1.@xml:lang');
  const passingSchema = { safeParse: () => ({ success: true as const, data: {} }) };
  for (const result of [
    validateFlowPayload(payload, passingSchema, null),
    validateLifecyclemodelPayload(payload, passingSchema, null),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]!.code, 'duplicate_language_entry');
  }
  const packageIssues = packageInternals.collectLocalizedTextIssues(
    payload,
    'flows',
    'anonymous.json',
  );
  assert.ok(packageIssues.some((issue) => issue.issue_code === 'duplicate_language_entry'));
});

test('opaque extensions and hierarchy entities do not become localized fields, while nested localized children remain independent', () => {
  const value = {
    'common:other': {
      'common:generalComment': [
        { ...en('first'), id: 'one' },
        { ...en('second'), id: 'two' },
      ],
    },
    flowInformation: {
      dataSetInformation: {
        classificationInformation: {
          'common:classification': [{ 'common:class': [en('level zero'), en('level one')] }],
          'common:elementaryFlowCategorization': {
            'common:category': [en('first category'), en('second category')],
          },
        },
      },
    },
  };
  assert.deepEqual(collectLocalizedTextUniquenessIssues(value), []);
  assert.deepEqual(
    collectLocalizedTextUniquenessIssues({
      'common:shortDescription': [en('one'), { ...en('two'), '@level': '0' }],
    }).map((issue) => issue.path),
    ['common:shortDescription.1.@xml:lang'],
  );
});

test('prose authoring retains invalid and attributed entries for diagnosis, preserving complete text and variants', () => {
  for (const entries of [
    [{ '#text': 'Missing language' }],
    [{ '@xml:lang': 'en' }],
    [{ ...en('Attributed'), '@source': 'source' }],
  ]) {
    assert.deepEqual(mergeLocalizedTextParagraphs<unknown>(entries), entries);
  }
  assert.deepEqual(mergeLocalizedTextParagraphs([null, 'original malformed text']), [
    null,
    'original malformed text',
  ]);
  assert.deepEqual(mergeLocalizedTextParagraphs([]), []);
  assert.deepEqual(
    mergeLocalizedTextParagraphs([
      en('First includes fragment'),
      { '@xml:lang': 'en-US', '#text': 'Regional' },
      en('fragment'),
      en('First includes fragment'),
    ]),
    [
      en('First includes fragment\n\nfragment\n\nFirst includes fragment'),
      { '@xml:lang': 'en-US', '#text': 'Regional' },
    ],
  );
});

test('untyped arrays and unknown fields do not acquire a localized role from object attributes', () => {
  const entries = [
    en('Original value'),
    { ...en('Additional value'), '@refObjectId': 'extra-attribute' },
  ];
  assert.deepEqual(collectLocalizedTextUniquenessIssues(entries), []);
  assert.deepEqual(collectLocalizedTextUniquenessIssues({ caption: entries }), []);
  assert.deepEqual(
    collectLocalizedTextUniquenessIssues({ 'common:shortDescription': entries }).map(
      (issue) => issue.path,
    ),
    ['common:shortDescription.1.@xml:lang'],
  );
});
