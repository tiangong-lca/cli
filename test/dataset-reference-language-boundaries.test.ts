import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import {
  collectLocalizedTextUniquenessIssues,
  GLOBAL_REFERENCE_ENTITY_FIELD_NAMES,
} from '../src/lib/dataset-localized-text.js';
import { createDatasetRecord } from '../src/lib/dataset-command.js';
import { CliError } from '../src/lib/errors.js';
import { validateProcessPayload } from '../src/lib/process-payload-validation.js';
import { processTransportFixture } from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const record = (value: unknown) => value as Json;
const SOURCE_PATH =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource';
const reference = (id: string, text: string): Json => ({
  '@type': 'source data set',
  '@refObjectId': id,
  '@version': '01.00.000',
  '@uri': `../sources/${id}.xml`,
  '@xml:lang': 'en',
  '@source': 'anonymous-original-attribute',
  'common:shortDescription': [{ '@xml:lang': 'en', '#text': text }],
});
function fixture() {
  const payload = processTransportFixture();
  const sources = record(record(payload.processDataSet).modellingAndValidation)
    .dataSourcesTreatmentAndRepresentativeness as Json;
  sources.referenceToDataSource = [
    reference('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Anonymous source one'),
    reference('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Anonymous source two'),
  ];
  return { payload, sources };
}

test('complete SDK-valid Process references retain outer language metadata as separate entities', () => {
  const { payload } = fixture();
  const before = JSON.stringify(payload);
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  const validation = validateProcessPayload(payload);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.deepEqual(collectLocalizedTextUniquenessIssues(payload), []);
  assert.equal(JSON.stringify(payload), before);
});

test('each reference still rejects duplicate languages inside its own short description', () => {
  const { payload, sources } = fixture();
  const references = sources.referenceToDataSource as Json[];
  references[1]['common:shortDescription'] = [
    { '@xml:lang': 'en', '#text': 'Original second source description' },
    {
      '@xml:lang': 'en',
      '#text': 'Additional second source description',
      '@refObjectId': 'extra-attribute',
    },
  ];
  const before = JSON.stringify(payload);
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  assert.deepEqual(
    collectLocalizedTextUniquenessIssues(payload).map((issue) => issue.path),
    [`${SOURCE_PATH}.1.common:shortDescription.1.@xml:lang`],
  );
  assert.equal(JSON.stringify(payload), before);
});

test('reference entity field roles exactly match all pinned SDK schema GlobalReferenceType owners', () => {
  const sdkDist = path.dirname(createRequire(import.meta.url).resolve('@tiangong-lca/tidas-sdk'));
  const schemas = path.join(sdkDist, 'runtime-assets', 'tidas', 'schemas');
  const references = new Set<string>();
  const localized = new Set<string>();
  const inspect = (node: unknown, owner: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const child of node) inspect(child, owner);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const schema = node as Json;
    if (typeof schema.$ref === 'string' && owner) {
      if (schema.$ref.endsWith('/GlobalReferenceType')) references.add(owner);
      if (/#\/\$defs\/(?:Required)?(?:String|ST|FT)MultiLang$/u.test(schema.$ref))
        localized.add(owner);
    }
    for (const [key, child] of Object.entries(schema)) {
      if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [field, definition] of Object.entries(child)) inspect(definition, field);
      } else {
        inspect(child, owner);
      }
    }
  };
  for (const filename of readdirSync(schemas).filter((name) => name.endsWith('.json'))) {
    inspect(JSON.parse(readFileSync(path.join(schemas, filename), 'utf8')), undefined);
  }
  assert.equal(references.size, 42);
  assert.deepEqual([...references].sort(), [...GLOBAL_REFERENCE_ENTITY_FIELD_NAMES].sort());
  assert.ok(references.has('referenceQuantity'));
  assert.ok(!references.has('@type'));
  assert.deepEqual(
    [...references].filter((field) => localized.has(field)),
    [],
  );
});

test('every canonical reference owner skips only outer entity counting and checks each child field', () => {
  for (const field of GLOBAL_REFERENCE_ENTITY_FIELD_NAMES) {
    const first = reference('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'First source');
    const second = reference('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Second source');
    const value = { [field]: [first, second] };
    const original = JSON.stringify(value);
    assert.deepEqual(collectLocalizedTextUniquenessIssues(value), [], field);
    assert.equal(JSON.stringify(value), original);
    second['common:shortDescription'] = [
      { '@xml:lang': 'en', '#text': 'Original explanation' },
      { '@xml:lang': 'en', '#text': 'Additional explanation' },
    ];
    assert.deepEqual(
      collectLocalizedTextUniquenessIssues(value).map((issue) => issue.path),
      [`${field}.1.common:shortDescription.1.@xml:lang`],
    );
    assert.deepEqual(
      collectLocalizedTextUniquenessIssues({ [field]: second }).map((issue) => issue.path),
      [`${field}.common:shortDescription.1.@xml:lang`],
    );
  }
});

test('a real comment carrying reference identity attributes still enforces language uniqueness', () => {
  const { payload } = fixture();
  const info = record(record(payload.processDataSet).processInformation).dataSetInformation as Json;
  info['common:generalComment'] = [
    {
      '@xml:lang': 'en',
      '#text': 'Original descriptive paragraph',
      '@refObjectId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    {
      '@xml:lang': 'en',
      '#text': 'Additional descriptive paragraph',
      '@refObjectId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  ];
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  assert.deepEqual(
    collectLocalizedTextUniquenessIssues(payload).map((issue) => issue.path),
    ['processDataSet.processInformation.dataSetInformation.common:generalComment.1.@xml:lang'],
  );
});

test('terminal Process writer preserves valid reference entities and blocks repeated inner descriptions', async () => {
  const { payload, sources } = fixture();
  const original = JSON.stringify(payload);
  const dispatched: unknown[] = [];
  const transport = {
    functionsBaseUrl: 'https://example.supabase.co/functions/v1',
    publishableKey: 'public',
    accessToken: 'actor',
    timeoutMs: 100,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  await createDatasetRecord({ transport, table: 'processes', id: 'anonymous', payload });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(record(dispatched[0]).jsonOrdered, payload);
  assert.equal(JSON.stringify(payload), original);
  const references = sources.referenceToDataSource as Json[];
  references[1]['common:shortDescription'] = [
    { '@xml:lang': 'en', '#text': 'Original description' },
    { '@xml:lang': 'en', '#text': 'Additional description' },
  ];
  const invalid = JSON.stringify(payload);
  await assert.rejects(
    createDatasetRecord({ transport, table: 'processes', id: 'anonymous', payload }),
    (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.equal(dispatched.length, 1);
  assert.equal(JSON.stringify(payload), invalid);
});
