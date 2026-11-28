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
import { datasetReader } from '../src/adapters/dataset-read.js';
import { processTransportFixture } from './helpers/process-allocation-fixture.js';

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
const primary = { id: primaryId, version: '01.00.003', type: 'primary' };
const secondary = { id: secondaryId, version: '01.00.007', type: 'allocated' };
const contents = {
  lifeCycleModelDataSet: {
    lifeCycleModelInformation: {
      dataSetInformation: { 'common:UUID': modelId },
      technology: {
        processes: {
          processInstance: [
            {
              '@dataSetInternalID': '0',
              '@multiplicationFactor': '1',
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
              '@multiplicationFactor': '1',
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
const canonical = (ref: unknown) => ({
  lifeCycleModelDataSet: {
    lifeCycleModelInformation: {
      ...contents.lifeCycleModelDataSet.lifeCycleModelInformation,
      dataSetInformation: { 'common:UUID': modelId, referenceToResultingProcess: ref },
    },
  },
});
const referenceTo = (member: { id: string; version: string }) => ({
  '@refObjectId': member.id,
  '@version': member.version,
});

const snapshot = {
  revision,
  members: [primary, secondary],
  processes: [
    { ...primary, model_id: modelId, model_version: version },
    { ...secondary, model_id: modelId, model_version: version },
  ],
  model: {
    id: modelId,
    version,
    state_code: 0,
    json_ordered: canonical(referenceTo(primary)),
    json_tg: {
      submodels: [primary, secondary],
      xflow: { nodes: [{ id: 'existing-graph-node', x: 321, data: { index: '0' } }] },
    },
  },
};
const qualified = {
  qualification: { status: 'qualified', publish_ready: true, draft_ready: true },
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
  ok({ ...target, operationId: id, status: 'committed', revision, members: [secondary, primary] });

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
    ['draft_validation_failed', 'partial'],
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

test('public save prepares real local candidates and reports incomplete evidence without dispatching', async (t) => {
  const { input } = fixture(t);
  const source = processTransportFixture();
  const sourceFile = path.join(path.dirname(input), 'source.json');
  writeFileSync(sourceFile, JSON.stringify(source));
  const sourceModel = structuredClone(contents);
  sourceModel.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance =
    [
      {
        '@dataSetInternalID': '0',
        '@multiplicationFactor': '1',
        referenceToProcess: {
          '@refObjectId': '11111111-1111-4111-8111-111111111111',
          '@version': version,
        },
      },
    ];
  Object.assign(sourceModel.lifeCycleModelDataSet.lifeCycleModelInformation, {
    quantitativeReference: { referenceToReferenceProcess: 0 },
  });
  writeFileSync(
    input,
    JSON.stringify({
      ...target,
      ...binding,
      action: 'save',
      baseline: null,
      generation: {
        source_model: { json_ordered: sourceModel },
        process_sources: { process_json_files: ['source.json'], allow_remote_lookup: false },
      },
    }),
  );
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname === '/auth/v1/user') {
      return Response.json({ id: actorId, email: 'fixture@example.test', role: 'authenticated' });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.action, 'inspect');
    return observe(null);
  };
  const reply = await runDatasetCommand(
    ['model', 'result-group', '--input', input, '--json'],
    createDatasetPorts(env, fetch),
  );
  const value = JSON.parse(reply.stdout || reply.stderr);
  assert.equal(value.data?.status, 'draft_validation_failed', JSON.stringify(value.error));
  assert.equal(value.data.validation[0].validation.flow_reference_names.status, 'unresolved');
});

test('Process reads preserve actual Model columns and distinguish null from unavailable', async () => {
  const source = processTransportFixture();
  const rows = [
    { id: primaryId, version, json: source, model_id: modelId, model_version: '02.00.000' },
    { id: secondaryId, version, json: source, model_id: null, model_version: null },
    { id: actorId, version, json: source },
  ];
  const reads: URL[] = [];
  const fetch: FetchLike = async (url) => {
    if (new URL(url).pathname === '/auth/v1/user') {
      return Response.json({ id: actorId, email: 'fixture@example.test', role: 'authenticated' });
    }
    const query = new URL(url);
    reads.push(query);
    assert.match(query.searchParams.get('select')!, /model_id,model_version/);
    const id = query.searchParams.get('id');
    const selected = rows.filter((row) => !id || id === 'eq.' + row.id);
    return Response.json(selected, {
      headers: { 'content-range': `0-${selected.length - 1}/${selected.length}` },
    });
  };
  const page = await datasetReader(env, fetch)('process', { offset: 0, limit: 10 });
  assert.deepEqual(
    page.records.map(({ model_id, model_version }) => [model_id, model_version]),
    [
      [modelId, '02.00.000'],
      [null, null],
      [undefined, undefined],
    ],
  );
  const ports = createDatasetPorts(env, fetch);
  const list = await runDatasetCommand(
    ['process', 'list', '--limit', '3', '--fields', 'model_id,model_version', '--json'],
    ports,
  );
  assert.deepEqual(JSON.parse(list.stdout).data.items, [
    { type: 'process', id: primaryId, version, model_id: modelId, model_version: '02.00.000' },
    { type: 'process', id: secondaryId, version, model_id: null, model_version: null },
    { type: 'process', id: actorId, version },
  ]);
  const get = await runDatasetCommand(
    [
      'process',
      'get',
      '--id',
      primaryId,
      '--version',
      version,
      '--fields',
      'model_id,model_version,content',
      '--json',
    ],
    ports,
  );
  const got = JSON.parse(get.stdout);
  assert.equal(got.data.subject.model_version, '02.00.000');
  assert.deepEqual(got.data.content, source);
  assert.equal(reads.length, 3);
  assert(reads.every((query) => query.pathname.endsWith('/processes')));
  assert.equal(reads.at(-1)?.searchParams.get('version'), 'eq.' + version);
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
    { ...snapshot, processes: [snapshot.processes[0], { ...secondary, id: actorId }] },
    {
      ...snapshot,
      processes: [{ ...snapshot.processes[0], id: [primary.id] }, snapshot.processes[1]],
    },
    {
      ...snapshot,
      processes: [{ ...snapshot.processes[0], version: [primary.version] }, snapshot.processes[1]],
    },
    { ...snapshot, members: [{ ...primary, version: 'latest' }, secondary] },
    { ...snapshot, members: [{ ...primary, id: null }, secondary] },
    { ...snapshot, members: [{ ...primary, id: 'broken' }, secondary] },
    { ...snapshot, members: [{ ...primary, version: null }, secondary] },
    { ...snapshot, members: [{ id: primaryId, version: primary.version }, secondary] },
    { ...snapshot, members: [{ ...primary, type: 'component' }, secondary] },
    { ...snapshot, members: [{ ...primary, type: 'secondary' }, secondary] },
    {
      ...snapshot,
      model: {
        ...snapshot.model,
        json_tg: { submodels: [primary, { ...secondary, type: 'secondary' }] },
      },
    },
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
      { code: 'MODEL_RESULT_GROUP_INVALID' },
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

test('legacy membership requires a real exact association and preserves the canonical primary fallback', async (t) => {
  const { run } = fixture(t);
  const member = { ...primary, version };
  const reference = referenceTo(member);
  const legacy = {
    ...snapshot,
    model: { ...snapshot.model, json_tg: null, json_ordered: canonical(reference) },
    members: [member],
    processes: [{ ...member, model_id: modelId, model_version: version }],
  };
  assert.equal((await run({ action: 'inspect' }, () => observe(legacy))).status, 'observed');
  assert.equal(
    (
      await run({ action: 'inspect' }, () =>
        observe({
          ...legacy,
          model: { ...legacy.model, json_ordered: null },
          members: [],
          processes: [],
        }),
      )
    ).status,
    'observed',
  );
  const empty = {
    ...legacy,
    model: { ...legacy.model, json_ordered: canonical(null) },
    members: [],
    processes: [],
  };
  assert.equal((await run({ action: 'inspect' }, () => observe(empty))).status, 'observed');
  for (const wrong of [
    { ...legacy, processes: [{ ...member, model_id: modelId, model_version: null }] },
    { ...legacy, processes: [{ ...member, model_id: modelId }] },
  ]) {
    await assert.rejects(
      run({ action: 'inspect' }, () => observe(wrong)),
      /lacks the expected persisted association/,
    );
  }
  for (const refs of [[reference, reference], 'malformed']) {
    await assert.rejects(
      run({ action: 'inspect' }, () =>
        observe({ ...legacy, model: { ...legacy.model, json_ordered: canonical(refs) } }),
      ),
      { code: 'MODEL_RESULT_GROUP_INVALID' },
    );
  }

  const recovery = await run({ action: 'recover', ...binding, operationId }, (body) =>
    body.action === 'inspect' ? observe(legacy) : committed(operationId),
  );
  assert.equal(recovery.status, 'committed_readback_unverified');
  assert.deepEqual((recovery.receipt as JsonObject).members, [secondary, primary]);
});

test('public result-group inspection requires exact canonical result references under the declared roles', async (t) => {
  const { input, run, dispatch } = fixture(t);
  writeFileSync(input, JSON.stringify({ ...target, action: 'inspect' }));
  let observed: unknown = snapshot;
  const fetch: FetchLike = async (url, init) => {
    if (new URL(url).pathname === '/auth/v1/user') {
      return Response.json({ id: actorId, email: 'fixture@example.test', role: 'authenticated' });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), { ...target, protocol, action: 'inspect' });
    return observe(observed);
  };
  const ports = createDatasetPorts(env, fetch);
  const inspect = () =>
    runDatasetCommand(['model', 'result-group', '--input', input, '--json'], ports);
  const valid = JSON.parse((await inspect()).stdout);
  assert.equal(valid.outcome, 'observed');
  // The allocated member and the Model's ordinary component references are independent of
  // the sole canonical product result reference.
  assert.deepEqual(valid.data.snapshot.members, [primary, secondary]);

  const exactPrimary = referenceTo(primary);
  for (const [ref, message] of [
    [referenceTo(secondary), /primary or secondary member/],
    [referenceTo({ ...primary, id: actorId }), /primary or secondary member/],
    [{ ...exactPrimary, '@version': version }, /primary or secondary member/],
    [[exactPrimary, exactPrimary], /duplicates an exact result/],
    [[exactPrimary, null], /Canonical Model result references/],
    [{ ...exactPrimary, '@refObjectId': [primary.id] }, /needs a Process ID and version/],
    [{ ...exactPrimary, '@version': [primary.version] }, /needs a Process ID and version/],
    [[], /roles disagree with the Model declarations/],
  ] as const) {
    observed = { ...snapshot, model: { ...snapshot.model, json_ordered: canonical(ref) } };
    const result = await inspect();
    assert.equal(result.exitCode, 2);
    const value = JSON.parse(result.stdout);
    assert.equal(value.error.code, 'MODEL_RESULT_GROUP_INVALID');
    assert.match(value.error.message, message);
  }

  const coproduct = { ...secondary, type: 'secondary' };
  observed = {
    ...snapshot,
    members: [primary, coproduct],
    model: {
      ...snapshot.model,
      json_tg: { submodels: [coproduct, primary] },
      json_ordered: canonical([referenceTo(coproduct), exactPrimary]),
    },
  };
  assert.equal(JSON.parse((await inspect()).stdout).outcome, 'observed');
  observed = {
    ...snapshot,
    members: [primary, coproduct],
    model: {
      ...snapshot.model,
      json_tg: { submodels: [coproduct, primary] },
      json_ordered: canonical(referenceTo(coproduct)),
    },
  };
  assert.match(
    JSON.parse((await inspect()).stdout).error.message,
    /roles disagree with the Model declarations/,
  );
  const recovered = await run({ action: 'recover', ...binding, operationId }, (body) =>
    body.action === 'inspect' ? observe(observed) : committed(operationId),
  );
  assert.equal(recovered.status, 'committed_readback_unverified');
  assert.deepEqual(recovered.receipt, {
    operationId,
    revision,
    savedAt: undefined,
    members: [secondary, primary],
  });
  assert.deepEqual(
    dispatch.map((body) => body.action),
    ['recover', 'inspect'],
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
  assert.deepEqual(graph.edges[0]?.target, { cell: '1' });
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
  const stillUnknown = await run(recovery, () => ok({ status: 'unknown' }));
  assert.equal(stillUnknown.status, 'unknown');
  assert.equal(stillUnknown.recoveryFile, undefined);
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
  const advanced = await run(
    { ...binding, action: 'save', generation: {}, baseline: null },
    (body) => {
      if (body.action === 'save') return committed(body.operationId);
      return dispatch.at(-2)?.action === 'save'
        ? observe({ ...snapshot, revision: 'b'.repeat(64) })
        : observe(null);
    },
  );
  assert.equal(advanced.status, 'committed_readback_unverified');
  assert.deepEqual(JSON.parse(readFileSync(String(advanced.recoveryFile), 'utf8')), {
    action: 'recover',
    ...target,
    ...binding,
    operationId: dispatch.at(-2)?.operationId,
  });
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
  assert.deepEqual(
    await run(
      { ...save, baseline: null },
      (body) => {
        assert.equal(body.action, 'inspect');
        return observe(null);
      },
      async () => ({
        qualification: { status: 'failed', draft_ready: false },
        projection: { member_validation: [{ id: primaryId, issues: ['missing data'] }] },
      }),
    ),
    {
      status: 'draft_validation_failed',
      ...target,
      qualification: { status: 'failed', draft_ready: false },
      validation: [{ id: primaryId, issues: ['missing data'] }],
    },
  );
  assert.deepEqual(
    await run(
      { ...save, baseline: null },
      (body) => {
        assert.equal(body.action, 'inspect');
        return observe(null);
      },
      async () => ({ qualification: { status: 'failed', draft_ready: false } }),
    ),
    {
      status: 'draft_validation_failed',
      ...target,
      qualification: { status: 'failed', draft_ready: false },
      validation: undefined,
    },
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
