import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import type { DatasetType, JsonObject } from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const id = '00000000-0000-4000-8000-000000000001';
const version = '01.00.000';
const localized = [
  { '@xml:lang': 'en', '#text': 'Example material' },
  { '@xml:lang': 'zh', '#text': '示例材料' },
];
const structuredName = {
  baseName: localized,
  treatmentStandardsRoutes: { '@xml:lang': 'en', '#text': 'Example treatment' },
  mixAndLocationTypes: { '@xml:lang': 'en', '#text': 'Example mix' },
  functionalUnitFlowProperties: { '@xml:lang': 'en', '#text': 'Example property' },
};
const cases: {
  type: DatasetType;
  wrapper: string;
  information: string;
  endpoint: string;
  nameField: string;
  name: unknown;
}[] = [
  {
    type: 'flow',
    wrapper: 'flowDataSet',
    information: 'flowInformation',
    endpoint: 'flow',
    nameField: 'name',
    name: structuredName,
  },
  {
    type: 'process',
    wrapper: 'processDataSet',
    information: 'processInformation',
    endpoint: 'process',
    nameField: 'name',
    name: structuredName,
  },
  {
    type: 'model',
    wrapper: 'lifeCycleModelDataSet',
    information: 'lifeCycleModelInformation',
    endpoint: 'lifecyclemodel',
    nameField: 'name',
    name: structuredName,
  },
  {
    type: 'source',
    wrapper: 'sourceDataSet',
    information: 'sourceInformation',
    endpoint: 'source',
    nameField: 'common:shortName',
    name: localized,
  },
  {
    type: 'contact',
    wrapper: 'contactDataSet',
    information: 'contactInformation',
    endpoint: 'contact',
    nameField: 'common:shortName',
    name: { '@xml:lang': 'en', '#text': 'Example contact' },
  },
];

for (const fixture of cases) {
  for (const scope of ['public', 'current-user'] as const) {
    test(`${fixture.type} search preserves names and candidate metadata regardless of information order (${scope})`, async () => {
      const domain = {
        [fixture.information]: { dataSetInformation: { [fixture.nameField]: fixture.name } },
      };
      const unrelated = {
        administrativeInformation: {},
        unrelatedInformation: { dataSetInformation: { name: 'Wrong information node' } },
      };
      const rows = [
        { ...unrelated, ...domain },
        { ...domain, ...unrelated },
      ].map((content, index) => ({
        id,
        version: index === 0 ? version : '02.00.000',
        json: { [fixture.wrapper]: content },
        combined_score: index === 0 ? 0.3 : 0.9,
        score: 1,
        state_code: scope === 'public' ? 100 : 0,
        semantic_route: 'semantic',
      }));
      const requests: { url: string; body: unknown }[] = [];
      const ports = createDatasetPorts(buildSupabaseTestEnv(), async (url, init) => {
        if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json(scope === 'public' ? rows : { data: rows });
      });
      const reply = await runDatasetCommand(
        [
          fixture.type,
          'search',
          '--query',
          'example',
          '--limit',
          '2',
          '--scope',
          scope,
          '--state',
          scope === 'public' ? '100' : '0',
          '--json',
        ],
        ports,
      );
      assert.equal(reply.exitCode, 0, reply.stderr);
      const result = JSON.parse(reply.stdout);
      assert.deepEqual(
        result.data.candidates,
        rows.map((row) => ({
          type: fixture.type,
          id: row.id,
          version: row.version,
          name: fixture.name,
          score: row.combined_score,
          match: { source: 'domain_hybrid_search', semanticRoute: row.semantic_route },
          stateCode: row.state_code,
        })),
      );
      assert.equal(requests.length, 1, 'name projection must not fetch individual candidates');
      assert.ok(requests[0]!.url.endsWith(`/${fixture.endpoint}_hybrid_search`));
      const versioned = fixture.type === 'flow' || fixture.type === 'process';
      assert.deepEqual(requests[0]!.body, {
        query: 'example',
        page_size: 2,
        page_current: 1,
        match_count: versioned ? 200 : 100,
        ...(versioned ? { version_scope: 'matched' } : {}),
        data_source: scope === 'public' ? 'tg' : 'my',
        state_code: scope === 'public' ? 100 : 0,
      });
      assert.equal(result.completeness.hasMore, null);
      assert.equal(result.completeness.nextCursor, null);
      assert.equal(result.completeness.truncated, true);
      assert.equal(result.completeness.returned, 2);
      assert.equal(result.completeness.total, null);
    });
  }

  test(`${fixture.type} search leaves missing names null without using unrelated information`, async () => {
    const contents: unknown[] = [
      null,
      {},
      { [fixture.wrapper]: null },
      ...[undefined, null, {}, { dataSetInformation: null }, { dataSetInformation: {} }].map(
        (information) => ({
          [fixture.wrapper]: {
            administrativeInformation: { dataSetInformation: { name: 'Unrelated name' } },
            [fixture.information]: information,
          },
        }),
      ),
    ];
    const ports = createDatasetPorts(buildSupabaseTestEnv(), async (url) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      return Response.json(contents.map((json) => ({ id, version, json })));
    });
    const result = await ports.search(fixture.type, 'example', contents.length, 0);
    assert.deepEqual(
      (result.candidates as JsonObject[]).map((candidate) => candidate.name),
      contents.map(() => null),
    );
  });
}
