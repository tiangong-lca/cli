import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runModelResultGroup } from '../src/adapters/model-result-group.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';

const modelId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000008';
const primaryId = '00000000-0000-4000-8000-000000000003';
const secondaryId = '00000000-0000-4000-8000-000000000004';
const operationId = '00000000-0000-4000-8000-000000000009';
const version = '01.00.000';
const revision = 'a'.repeat(64);
const environment = 'https://result-group.example.test';
const env = buildSupabaseTestEnv({
  TIANGONG_LCA_API_BASE_URL: environment,
  TIANGONG_LCA_AUTH_MODE: 'access-token',
});
const target = { modelId, version };
const binding = { expectedActor: actorId, expectedEnvironment: environment };
const protocol = 'model-bundle.v1';
const primary = { id: primaryId, version, type: 'primary' };
const secondary = { id: secondaryId, version, type: 'secondary' };
const contents = {
  lifeCycleModelDataSet: {
    lifeCycleModelInformation: {
      dataSetInformation: { 'common:UUID': modelId },
      technology: {
        processes: {
          processInstance: [
            {
              '@dataSetInternalID': '0',
              referenceToProcess: {
                '@refObjectId': '00000000-0000-4000-8000-000000000005',
                '@version': version,
              },
              connections: {
                outputExchange: {
                  '@flowUUID': primaryId,
                  downstreamProcess: { '@id': '1', '@flowUUID': primaryId },
                },
              },
            },
            {
              '@dataSetInternalID': '1',
              referenceToProcess: {
                '@refObjectId': '00000000-0000-4000-8000-000000000006',
                '@version': version,
              },
            },
          ],
        },
      },
    },
    administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
  },
};
const snapshot = {
  revision,
  members: [primary, secondary],
  processes: [
    { ...primary, model_id: modelId, model_version: version },
    { ...secondary, model_id: modelId, model_version: null },
  ],
  model: {
    id: modelId,
    version,
    state_code: 0,
    json_tg: { xflow: { nodes: [{ id: 'existing-graph-node', x: 321, data: { index: '0' } }] } },
  },
};
const qualified = {
  qualification: { status: 'qualified', publish_ready: true },
  bundle: {
    source_model: { id: modelId, version },
    model_candidate: contents,
    editor_model: contents,
    reference_quantity: { instanceId: '0', originalAmount: 2, targetAmount: 10 },
    projected_processes: [{ ...primary, role: 'primary', json_ordered: { processDataSet: {} } }],
  },
};
const ok = (value: JsonObject) => Response.json({ ok: true, protocol, ...value });
const observe = (value: unknown) => ok({ status: 'observed', snapshot: value });
const committed = (id: unknown) =>
  ok({ ...target, operationId: id, status: 'committed', revision });

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'model-result-group-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json');
  const baseline = path.join(directory, 'baseline.json');
  const state = path.join(directory, 'state');
  const dispatch: JsonObject[] = [];
  const run = (
    request: JsonObject,
    handler: (body: JsonObject) => Response,
    generate: Parameters<typeof runModelResultGroup>[4] = async () => qualified,
  ) => {
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).pathname === '/auth/v1/user') {
        return Response.json({ id: actorId, email: 'fixture@example.test', role: 'authenticated' });
      }
      const body = JSON.parse(String(init?.body));
      dispatch.push(body);
      return handler(body);
    };
    return runModelResultGroup({ ...target, ...request }, input, env, fetch, generate, state);
  };
  const capture = (value: JsonObject) => {
    writeFileSync(baseline, JSON.stringify({ ...target, ...binding, snapshot, ...value }));
    return baseline;
  };
  return { run, capture, dispatch, input };
}

test('public Result Group command maps observed, verified, drifted and unknown results', async (t) => {
  const { input } = fixture(t);
  writeFileSync(input, JSON.stringify({ ...target, action: 'inspect' }));
  const request: FetchLike = async (url) =>
    new URL(url).pathname === '/auth/v1/user'
      ? Response.json({ id: actorId, email: 'fixture@example.test', role: 'authenticated' })
      : observe(snapshot);
  const ports = createDatasetPorts(env, request);
  const args = ['model', 'result-group', '--input', input, '--json'];
  const observed = await runDatasetCommand(args, ports);
  assert.equal(JSON.parse(observed.stdout).data.status, 'observed');
  for (const [outcome, expected] of [
    ['verified', 'completed'],
    ['committed_readback_unverified', 'partial'],
    ['unknown', 'unknown'],
  ]) {
    ports.operations = async () => ({
      status: outcome,
      recoveryFile: outcome === 'verified' ? undefined : input,
    });
    const result = JSON.parse((await runDatasetCommand(args, ports)).stdout);
    assert.equal(result.outcome, outcome);
    assert.equal(result.status, expected);
    if (outcome !== 'verified') assert.match(result.nextActions[0].command, /result-group --input/);
  }
});

test('result group inspects complete exact links and refuses drift, missing members or mismatched identity', async (t) => {
  const { run } = fixture(t);
  assert.deepEqual(await run({ action: 'inspect' }, () => observe(snapshot)), {
    status: 'observed',
    ...target,
    ...binding,
    snapshot,
  });
  assert.equal((await run({ action: 'inspect' }, () => observe(null))).snapshot, null);
  for (const value of [
    { ...snapshot, revision: 'invalid' },
    { ...snapshot, model: { ...snapshot.model, id: primaryId } },
    { ...snapshot, members: null },
    { ...snapshot, members: [primary, primary] },
    { ...snapshot, processes: [snapshot.processes[0], snapshot.processes[0]] },
    { ...snapshot, processes: [] },
    {
      ...snapshot,
      processes: [{ ...snapshot.processes[0], model_id: primaryId }, snapshot.processes[1]],
    },
    {
      ...snapshot,
      processes: [{ ...snapshot.processes[0], model_version: '02.00.000' }, snapshot.processes[1]],
    },
  ]) {
    await assert.rejects(
      run({ action: 'inspect' }, () => observe(value)),
      /snapshot|members/i,
    );
  }
  await assert.rejects(
    run({ action: 'inspect' }, () => ok({ status: 'unknown' })),
    /observed snapshot/,
  );
  await assert.rejects(
    run({ action: 'inspect' }, () => Response.json({ ok: true })),
    /acknowledge/,
  );
});

test('result group keeps the original revision and exact member mutations on update', async (t) => {
  const { run, capture, dispatch } = fixture(t);
  const result = await run(
    { ...binding, action: 'save', generation: { projection: {} }, baseline: capture({}) },
    (body) => (body.action === 'inspect' ? observe(snapshot) : committed(body.operationId)),
    async (generation, existing) => {
      assert.deepEqual(generation.projection, { mode: 'all-subproducts' });
      assert.deepEqual(existing?.members, snapshot.members);
      return qualified;
    },
  );
  assert.equal(result.status, 'verified');
  assert.deepEqual(
    dispatch.map((body) => body.action),
    ['inspect', 'save', 'inspect'],
  );
  assert.equal(dispatch[1]?.expectedRevision, revision);
  const plan = dispatch[1]?.plan as JsonObject;
  const graph = (plan.parent as { jsonTg: { xflow: { nodes: JsonObject[]; edges: JsonObject[] } } })
    .jsonTg.xflow;
  assert.equal(graph.nodes[0]?.id, 'existing-graph-node');
  assert.equal(graph.nodes[0]?.x, 321);
  assert.equal((graph.nodes[0]?.data as JsonObject).scalingFactor, 5);
  assert.deepEqual(graph.edges[0]?.source, { cell: 'existing-graph-node' });
  const mutations = plan.processMutations as JsonObject[];
  assert.deepEqual(
    mutations.map((mutation) => [mutation.op, mutation.id]),
    [
      ['update', primaryId],
      ['delete', secondaryId],
    ],
  );
});

test('uncertain save is recovered once using its original operation and no write replay', async (t) => {
  const { run, dispatch } = fixture(t);
  const unknown = await run(
    { ...binding, action: 'save', generation: {}, baseline: null },
    (body) => (body.action === 'inspect' ? observe(null) : Response.json({}, { status: 502 })),
  );
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(
    dispatch.map((body) => body.action),
    ['inspect', 'save', 'recover'],
  );
  assert.equal(dispatch[1]?.operationId, dispatch[2]?.operationId);
  const recovery = JSON.parse(readFileSync(String(unknown.recoveryFile), 'utf8'));
  assert.deepEqual(recovery, {
    action: 'recover',
    ...target,
    ...binding,
    operationId: dispatch[1]?.operationId,
  });
  const recovered = await run(recovery, (body) =>
    body.action === 'inspect'
      ? observe({ ...snapshot, revision: 'b'.repeat(64) })
      : committed(body.operationId),
  );
  assert.equal(recovered.status, 'committed_readback_unverified');
  const lostRead = await run(recovery, (body) =>
    body.action === 'inspect' ? Response.json({}, { status: 502 }) : committed(body.operationId),
  );
  assert.equal(lostRead.status, 'committed_readback_unverified');
  const found = await run(
    { ...binding, action: 'save', generation: {}, baseline: null },
    (body) => {
      if (body.action === 'inspect') {
        return dispatch.at(-2)?.action === 'recover' ? observe(snapshot) : observe(null);
      }
      if (body.action === 'recover') return committed(body.operationId);
      throw new Error('lost acknowledgment');
    },
  );
  assert.equal(found.status, 'verified');
});

test('invalid or refused result-group requests do not generate or replay mutations', async (t) => {
  const { run, capture } = fixture(t);
  const noNetwork = () => assert.fail('unexpected result-group request');
  const neverGenerate = async (): Promise<never> => assert.fail('unexpected generation');
  await assert.rejects(run({ action: 'invalid' }, noNetwork), /Select inspect/);
  await assert.rejects(run({ action: 'inspect', modelId: 'invalid' }, noNetwork), /exact Model/);
  await assert.rejects(run({ action: 'inspect', version: 'invalid' }, noNetwork), /exact Model/);
  await assert.rejects(run({ action: 'inspect', other: true }, noNetwork), /corresponding/);
  await assert.rejects(
    run({ action: 'recover', ...binding, expectedActor: primaryId, operationId }, noNetwork),
    /actor or project/,
  );
  await assert.rejects(
    run({ action: 'recover', ...binding, expectedEnvironment: 'wrong', operationId }, noNetwork),
    /actor or project/,
  );
  await assert.rejects(
    run({ action: 'recover', ...binding, operationId: 'invalid' }, noNetwork),
    /original operation/,
  );
  const save = { ...binding, action: 'save', generation: {} };
  await assert.rejects(
    run({ ...save, baseline: null }, () => observe(snapshot), neverGenerate),
    /already exists/,
  );
  for (const details of [
    { modelId: primaryId },
    { version: '02.00.000' },
    { expectedActor: primaryId },
    { expectedEnvironment: 'wrong' },
    { snapshot: null },
    { snapshot: { revision: 'stale' } },
  ]) {
    await assert.rejects(
      run({ ...save, baseline: capture(details) }, () => observe(snapshot), neverGenerate),
      /changed after inspection/,
    );
  }
  await assert.rejects(
    run({ ...save, baseline: capture({}) }, () => observe(null), neverGenerate),
    /changed after inspection/,
  );
  await assert.rejects(
    run(
      { ...save, baseline: capture({}) },
      () => observe({ ...snapshot, model: { ...snapshot.model, state_code: 20 } }),
      neverGenerate,
    ),
    /changed after inspection/,
  );
  await assert.rejects(
    run(
      { ...save, baseline: null },
      () => observe(null),
      async () => ({ qualification: { status: 'failed' } }),
    ),
    /candidate validation/,
  );
  await assert.rejects(
    run(
      { ...save, baseline: null },
      () => observe(null),
      async () => ({ qualification: { status: 'qualified', publish_ready: false } }),
    ),
    /candidate validation/,
  );
  await assert.rejects(
    run(
      { ...save, baseline: null },
      () => observe(null),
      async () => ({
        ...qualified,
        bundle: { ...qualified.bundle, source_model: { ...target, id: primaryId } },
      }),
    ),
    /Generated Model identity/,
  );
  await assert.rejects(
    run(
      { ...save, baseline: null },
      () => observe(null),
      async () => ({
        ...qualified,
        bundle: {
          ...qualified.bundle,
          source_model: { ...target, id: modelId, version: '02.00.000' },
        },
      }),
    ),
    /Generated Model identity/,
  );
  await assert.rejects(
    run({ ...save, baseline: null }, (body) =>
      body.action === 'inspect'
        ? observe(null)
        : Response.json({ code: 'MODEL_MEMBERSHIP_BUSY' }, { status: 409 }),
    ),
    /service rejected/,
  );
});
