import { syncStateAwareProcessRecord } from '../src/lib/process-save-draft.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatasetRecord,
  saveDraftDatasetRecord,
  type DatasetCommandTransport,
} from '../src/lib/dataset-command.js';
import { CliError } from '../src/lib/errors.js';
import { syncLifecyclemodelBundleRecord } from '../src/lib/lifecyclemodel-bundle-save.js';

const duplicated = () => ({
  'common:generalComment': [
    { '@xml:lang': 'en', '#text': 'First original paragraph.', '@source': 'original' },
    { '@xml:lang': 'en', '#text': 'Second original paragraph.', '@source': 'additional' },
  ],
});

test('dataset create and save reject duplicated field languages before any request without rewriting payloads', async () => {
  let requests = 0;
  const transport: DatasetCommandTransport = {
    functionsBaseUrl: 'https://example.supabase.co/functions/v1',
    publishableKey: 'public',
    accessToken: 'actor',
    timeoutMs: 100,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '{"ok":true}',
      };
    },
  };
  for (const table of [
    'contacts',
    'sources',
    'unitgroups',
    'flowproperties',
    'flows',
    'processes',
    'lifecyclemodels',
  ] as const) {
    for (const save of [false, true]) {
      const payload = { dataset: duplicated() };
      const before = JSON.stringify(payload);
      const options = { transport, table, id: 'anonymous', payload };
      await assert.rejects(
        save
          ? saveDraftDatasetRecord({
              ...options,
              version: '01.00.000',
              expectedJsonOrdered: { historical: duplicated() },
            })
          : createDatasetRecord(options),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, 'DATASET_DUPLICATE_LANGUAGE');
          assert.match(
            JSON.stringify(error.details),
            /dataset\.common:generalComment\.1\.@xml:lang/u,
          );
          return true;
        },
      );
      assert.equal(JSON.stringify(payload), before);
    }
  }
  assert.equal(requests, 0);
});

test('lifecyclemodel bundle rejects duplicate languages in parent and process mutations before any request', async () => {
  for (const child of [false, true]) {
    let requests = 0;
    const payload = child ? { lifeCycleModelDataSet: {} } : { lifeCycleModelDataSet: duplicated() };
    const metadata = child
      ? {
          processMutations: [
            {
              id: 'valid-child',
              jsonOrdered: { processDataSet: {} },
              expectedJsonOrdered: duplicated(),
            },
            { id: 'anonymous-child', jsonOrdered: { processDataSet: duplicated() } },
          ],
        }
      : undefined;
    const before = JSON.stringify({ payload, metadata });
    await assert.rejects(
      syncLifecyclemodelBundleRecord({
        id: 'anonymous',
        version: '01.00.000',
        payload,
        metadata,
        env: {},
        fetchImpl: async () => {
          requests += 1;
          throw new Error('No request allowed');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'DATASET_DUPLICATE_LANGUAGE');
        assert.match(
          JSON.stringify(error.details),
          child ? /processMutations\.1\.jsonOrdered\.processDataSet/u : /lifeCycleModelDataSet/u,
        );
        return true;
      },
    );
    assert.equal(requests, 0);
    assert.equal(JSON.stringify({ payload, metadata }), before);
  }
});

test('dataset command rechecks the actual candidate after beforeDispatch, while permitting a duplicate historical before image', async () => {
  let requests = 0;
  const transport: DatasetCommandTransport = {
    functionsBaseUrl: 'https://example.supabase.co/functions/v1',
    publishableKey: 'public',
    accessToken: 'actor',
    timeoutMs: 100,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '{"ok":true}',
      };
    },
  };
  const payload = { comment: [{ '@xml:lang': 'en', '#text': 'Original' }] };
  await assert.rejects(
    createDatasetRecord({
      transport,
      table: 'flows',
      id: 'anonymous',
      payload,
      beforeDispatch: async () => {
        await Promise.resolve();
        payload.comment.push({ '@xml:lang': 'en', '#text': 'Additional' });
      },
    }),
    (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.equal(requests, 0);
  await saveDraftDatasetRecord({
    transport,
    table: 'flows',
    id: 'anonymous',
    version: '01.00.000',
    payload: { comment: { '@xml:lang': 'en', '#text': 'Original\n\nAdditional' } },
    expectedJsonOrdered: duplicated(),
  });
  assert.equal(requests, 1);
});

test('direct state-aware Process writer rejects duplicate languages before authentication or row lookup', async () => {
  const payload = { processDataSet: duplicated() };
  const before = JSON.stringify(payload);
  let requests = 0;
  await assert.rejects(
    syncStateAwareProcessRecord({
      id: 'anonymous',
      version: '01.00.000',
      payload,
      env: {},
      fetchImpl: async () => {
        requests += 1;
        throw new Error('No request allowed');
      },
    }),
    (error: unknown) => error instanceof CliError && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(payload), before);
});

test('emitted runtime enforces the same terminal language admission', async () => {
  const { loadDistModule } = await import('./helpers/load-dist-module.js');
  const { createDatasetRecord: builtCreate, deriveSupabaseFunctionsBaseUrl } = await loadDistModule<
    typeof import('../src/lib/dataset-command.js')
  >('src/lib/dataset-command.js');
  let requests = 0;
  await assert.rejects(
    builtCreate({
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
      table: 'flows',
      id: 'anonymous',
      payload: duplicated(),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'DATASET_DUPLICATE_LANGUAGE',
  );
  assert.equal(requests, 0);
  const valid = { comment: [{ '@xml:lang': 'en', '#text': 'Original\n\nAdditional' }] };
  let dispatched: unknown;
  await builtCreate({
    transport: {
      functionsBaseUrl: deriveSupabaseFunctionsBaseUrl('https://example.supabase.co/rest/v1'),
      publishableKey: 'public',
      accessToken: 'actor',
      timeoutMs: 100,
      fetchImpl: async (_url, init) => {
        dispatched = JSON.parse(String(init?.body));
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => '{"ok":true}',
        };
      },
    },
    table: 'flows',
    id: 'anonymous',
    payload: valid,
  });
  assert.deepEqual(dispatched, { table: 'flows', id: 'anonymous', jsonOrdered: valid });
});
