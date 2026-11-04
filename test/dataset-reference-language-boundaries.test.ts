import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ProcessSchema } from '@tiangong-lca/tidas-sdk';
import {
  collectLocalizedTextUniquenessIssues,
  LOCALIZED_TEXT_FIELD_NAMES,
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

type FieldOwner = { path: string[]; roles: Set<'localized' | 'other'> };
function schemaFieldInventory() {
  const sdkDist = path.dirname(createRequire(import.meta.url).resolve('@tiangong-lca/tidas-sdk'));
  const schemas = path.join(sdkDist, 'runtime-assets', 'tidas', 'schemas');
  const references = new Set<string>();
  const localized = new Set<string>();
  const owners = new Map<string, FieldOwner>();
  const addRole = (owner: string[], role: 'localized' | 'other') => {
    const key = JSON.stringify(owner);
    const entry = owners.get(key) ?? { path: owner, roles: new Set<'localized' | 'other'>() };
    entry.roles.add(role);
    owners.set(key, entry);
  };
  const inspect = (node: unknown, owner: string[]): void => {
    if (Array.isArray(node)) {
      for (const child of node) inspect(child, owner);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const schema = node as Json;
    const field = owner.at(-1);
    if (typeof schema.$ref === 'string' && field) {
      const isLocalized = schema.$ref.split('/').at(-1)?.endsWith('MultiLang') === true;
      addRole(owner, isLocalized ? 'localized' : 'other');
      if (isLocalized) localized.add(field);
      if (schema.$ref.endsWith('/GlobalReferenceType')) references.add(field);
    }
    if (typeof schema.type === 'string' && field) addRole(owner, 'other');
    for (const [key, child] of Object.entries(schema)) {
      if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [name, definition] of Object.entries(child))
          inspect(definition, [...owner, name]);
      } else {
        inspect(child, owner);
      }
    }
  };
  for (const filename of readdirSync(schemas).filter((name) => name.endsWith('.json'))) {
    inspect(JSON.parse(readFileSync(path.join(schemas, filename), 'utf8')), []);
  }
  return { references, localized, owners: [...owners.values()] };
}
function atPath(owner: string[], value: unknown): unknown {
  for (const field of [...owner].reverse()) value = { [field]: value };
  return value;
}

test('positive localized roles cover every pinned schema owner and disambiguate all name collisions', () => {
  const inventory = schemaFieldInventory();
  assert.equal(inventory.localized.size, 53);
  assert.deepEqual([...inventory.localized].sort(), [...LOCALIZED_TEXT_FIELD_NAMES].sort());
  assert.equal(inventory.references.size, 42);
  assert.ok(inventory.references.has('referenceQuantity'));
  assert.ok(!inventory.references.has('@type'));
  const otherNames = new Set(
    inventory.owners.filter((owner) => owner.roles.has('other')).map((owner) => owner.path.at(-1)),
  );
  assert.deepEqual(
    [...inventory.localized].filter((field) => otherNames.has(field)),
    ['flowProperties'],
  );
  let localizedOwners = 0;
  let otherOwners = 0;
  for (const owner of inventory.owners) {
    assert.equal(owner.roles.size, 1, `Ambiguous schema role at ${owner.path.join('.')}`);
    const entries = [
      {
        '@xml:lang': 'en',
        '#text': 'First original value',
        '@refObjectId': 'extra-original-attribute',
      },
      {
        '@xml:lang': 'en',
        '#text': 'Second original value',
        '@source': 'extra-original-attribute',
      },
    ];
    const value = atPath(owner.path, entries);
    const original = JSON.stringify(value);
    const expected = owner.roles.has('localized')
      ? [[...owner.path, 1, '@xml:lang'].join('.')]
      : [];
    assert.deepEqual(
      collectLocalizedTextUniquenessIssues(value).map((issue) => issue.path),
      expected,
      owner.path.join('.'),
    );
    assert.equal(JSON.stringify(value), original);
    if (owner.roles.has('localized')) localizedOwners += 1;
    else otherOwners += 1;
  }
  assert.equal(localizedOwners, 89);
  assert.equal(localizedOwners + otherOwners, 766);
});

test('every canonical reference owner skips only outer entity counting and checks each child field', () => {
  for (const field of schemaFieldInventory().references) {
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

function exchangeFixture() {
  const { payload } = fixture();
  const exchanges = record(record(payload.processDataSet).exchanges);
  const first = (exchanges.exchange as Json[])[0];
  const second = structuredClone(first);
  second['@dataSetInternalID'] = '100';
  second.quantitativeReference = false;
  first['@xml:lang'] = 'en';
  second['@xml:lang'] = 'en';
  first['@source'] = 'first-exchange-original-attribute';
  second['@source'] = 'second-exchange-original-attribute';
  exchanges.exchange = [first, second];
  return { payload, first, second };
}

test('complete SDK-valid independent exchanges retain outer language attributes without false multilingual errors', () => {
  const { payload } = exchangeFixture();
  const before = JSON.stringify(payload);
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  const result = validateProcessPayload(payload);
  assert.equal(result.allocation_semantics?.status, 'passed');
  assert.equal(result.validation_layers?.authoring_evidence.status, 'passed');
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(collectLocalizedTextUniquenessIssues(payload), []);
  assert.equal(JSON.stringify(payload), before);
});

test('independent exchanges units reviews variables and process instances keep their own text fields', () => {
  const cases: Array<{ owner: string[]; child: string[] }> = [
    { owner: ['processDataSet', 'exchanges', 'exchange'], child: ['generalComment'] },
    { owner: ['unitGroupDataSet', 'units', 'unit'], child: ['generalComment'] },
    {
      owner: ['processDataSet', 'processInformation', 'mathematicalRelations', 'variableParameter'],
      child: ['comment'],
    },
    {
      owner: ['processDataSet', 'modellingAndValidation', 'validation', 'review'],
      child: ['common:reviewDetails'],
    },
    { owner: ['flowDataSet', 'flowProperties', 'flowProperty'], child: ['generalComment'] },
    {
      owner: [
        'lifeCycleModelDataSet',
        'lifeCycleModelInformation',
        'technology',
        'processes',
        'processInstance',
      ],
      child: ['referenceToProcess', 'common:shortDescription'],
    },
  ];
  for (const { owner, child } of cases) {
    const first = {
      '@xml:lang': 'en',
      '#text': 'Outer first entity caption',
      ...record(atPath(child, [{ '@xml:lang': 'en', '#text': 'First explanation' }])),
    };
    const second = {
      '@xml:lang': 'en',
      '#text': 'Outer second entity caption',
      ...record(atPath(child, [{ '@xml:lang': 'en', '#text': 'Second explanation' }])),
    };
    const value = atPath(owner, [first, second]);
    const original = JSON.stringify(value);
    assert.deepEqual(collectLocalizedTextUniquenessIssues(value), [], owner.join('.'));
    assert.equal(JSON.stringify(value), original);
    Object.assign(
      second,
      record(
        atPath(child, [
          { '@xml:lang': 'en', '#text': 'Original second explanation' },
          {
            '@xml:lang': 'en',
            '#text': 'Additional second explanation',
            '@refObjectId': 'extra-original-attribute',
          },
        ]),
      ),
    );
    const invalid = JSON.stringify(value);
    assert.deepEqual(
      collectLocalizedTextUniquenessIssues(value).map((issue) => issue.path),
      [[...owner, 1, ...child, 1, '@xml:lang'].join('.')],
    );
    assert.equal(JSON.stringify(value), invalid);
  }
});

test('terminal Process writer rejects duplicate actual exchange text before any POST', async () => {
  const { payload, second } = exchangeFixture();
  second.generalComment = [
    { '@xml:lang': 'en', '#text': 'Original exchange explanation', '@refObjectId': 'metadata-one' },
    {
      '@xml:lang': 'en',
      '#text': 'Additional exchange explanation',
      '@refObjectId': 'metadata-two',
    },
  ];
  const original = JSON.stringify(payload);
  assert.equal(ProcessSchema.safeParse(structuredClone(payload)).success, true);
  assert.deepEqual(
    collectLocalizedTextUniquenessIssues(payload).map((issue) => issue.path),
    ['processDataSet.exchanges.exchange.1.generalComment.1.@xml:lang'],
  );
  let requests = 0;
  await assert.rejects(
    createDatasetRecord({
      transport: {
        functionsBaseUrl: 'https://example.supabase.co/functions/v1',
        publishableKey: 'public',
        accessToken: 'actor',
        timeoutMs: 100,
        fetchImpl: async () => {
          requests += 1;
          throw new Error('No request allowed');
        },
      },
      table: 'processes',
      id: 'anonymous',
      payload,
    }),
    (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(payload), original);
});
