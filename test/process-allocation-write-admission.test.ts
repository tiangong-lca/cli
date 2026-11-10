import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProcessAllocationWriteAdmission } from '../src/lib/validation/process-allocation-write-admission.js';
import { allocationFixture } from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
function identity(document: Json) {
  const root = document.flowDataSet as Json;
  return {
    id: ((root.flowInformation as Json).dataSetInformation as Json)['common:UUID'],
    version: ((root.administrativeInformation as Json).publicationAndOwnership as Json)[
      'common:dataSetVersion'
    ],
    json_ordered: document,
  };
}
async function admit(payload: Json, context: { flow_documents?: Json[] }, rows: unknown[]) {
  const requests: string[] = [];
  const result = await assertProcessAllocationWriteAdmission(payload, context, {
    apiBaseUrl: 'https://example.test',
    publishableKey: 'synthetic-public-key',
    accessToken: 'synthetic-token',
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-token');
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { result, requests };
}

test('remote allocation admission binds exact authenticated live Flow bytes', async () => {
  const { payload, context } = allocationFixture();
  const { result, requests } = await admit(payload, context, [identity(context.flow_documents[0])]);
  assert.equal(result?.status, 'passed');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /id=eq\./);
  assert.match(requests[0], /version=eq\./);
  const withoutLocal = await admit(payload, {}, [identity(context.flow_documents[0])]);
  assert.equal(withoutLocal.result?.status, 'passed');
});

test('remote admission rejects caller-forged type, stale bytes and unavailable exact evidence', async () => {
  const { payload, context } = allocationFixture();
  const liveElementary = allocationFixture('Input', 'Elementary flow').context.flow_documents[0];
  await assert.rejects(admit(payload, context, [identity(liveElementary)]), /changed after local/);
  await assert.rejects(admit(payload, {}, [identity(liveElementary)]), /complete current-user/);
  const changed = structuredClone(context.flow_documents[0]);
  changed['synthetic:changed'] = true;
  await assert.rejects(admit(payload, context, [identity(changed)]), /changed after local/);
  for (const rows of [
    [],
    [identity(changed), identity(changed)],
    [{ ...identity(changed), id: 'foreign' }],
    [{ ...identity(changed), json_ordered: null }],
  ])
    await assert.rejects(admit(payload, context, rows), /unavailable or ambiguous/);
  await assert.rejects(
    admit(payload, { flow_documents: [context.flow_documents[0], context.flow_documents[0]] }, [
      identity(context.flow_documents[0]),
    ]),
    /changed after local/,
  );
});

test('transport guard validates undeclared reference without Flow reads and malformed allocation never reaches dispatch', async () => {
  const { payload } = allocationFixture();
  const exchanges = ((payload.processDataSet as Json).exchanges as Json).exchange as Json[];
  delete exchanges[0].allocations;
  const admitted = await admit(payload, {}, []);
  assert.equal(admitted.requests.length, 0);
  assert.equal(admitted.result?.status, 'passed');
  exchanges[0].allocations = null;
  await assert.rejects(admit(payload, {}, []), /complete current-user/);
});

test('numeric target IDs still bind exact live evidence', async () => {
  const { payload, context } = allocationFixture();
  const items = ((payload.processDataSet as Json).exchanges as Json).exchange as Json[];
  ((items[0].allocations as Json).allocation as Json)['@internalReferenceToCoProduct'] = 0;
  assert.equal(
    (await admit(payload, context, [identity(context.flow_documents[0])])).result?.status,
    'passed',
  );
});

test('all Process mutations require valid quantitative-reference semantics even without allocation', async () => {
  const { payload } = allocationFixture();
  const root = payload.processDataSet as Json;
  delete ((root.exchanges as Json).exchange as Json[])[0].allocations;
  ((root.processInformation as Json).quantitativeReference as Json).referenceToReferenceFlow =
    'missing';
  await assert.rejects(admit(payload, {}, []), /complete current-user/);
});
