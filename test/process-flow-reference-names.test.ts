import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { qualifyDatasetWrite } from '../src/adapters/dataset-write-checks.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { createDatasetRecord, saveDraftDatasetRecord } from '../src/lib/dataset/command.js';
import { saveDraftMaintenanceRow } from '../src/lib/maintenance/remote.js';
import { syncLifecyclemodelBundleRecord } from '../src/lib/model/bundle-save.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import {
  makeSupabaseAuthResponse,
  isSupabaseAuthTokenUrl,
  buildSupabaseTestEnv,
} from './helpers/supabase-auth.js';
import { bindCurrentFlowNameEvidence } from '../src/lib/validation/process-flow-reference-names.js';
import { loadDistModule } from './helpers/load-dist-module.js';
import {
  allocationFixture,
  processTransportFixture,
} from './helpers/process-allocation-fixture.js';

type Json = Record<string, unknown>;
const object = (value: unknown) => value as Json;
const localized = (text: string) => ({ '@xml:lang': 'en', '#text': text });
const plant = 'Steel; hot rolled; production mix; at plant';
const later = 'Steel; cold rolled';
const flowId = '22222222-2222-4222-8222-222222222222';
const v1 = '01.00.000';
const v2 = '01.00.001';
const actor = '00000000-0000-4000-8000-000000000002';
const environment = 'https://example.supabase.co';
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
const expectedPath =
  'processDataSet.exchanges.exchange.1.referenceToFlowDataSet.common:shortDescription';

function flowDocument(version: string) {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': flowId,
          name:
            version === v1
              ? {
                  baseName: localized('Steel'),
                  treatmentStandardsRoutes: localized('hot rolled'),
                  mixAndLocationTypes: localized('production mix'),
                  flowProperties: localized('at plant'),
                }
              : {
                  baseName: localized('Steel'),
                  treatmentStandardsRoutes: localized('cold rolled'),
                },
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
}

function processFixture(description = plant, secondVersion = v1) {
  const content = processTransportFixture();
  const root = object(content.processDataSet);
  const first = (object(root.exchanges).exchange as Json[])[0];
  object(first.referenceToFlowDataSet)['common:shortDescription'] = localized(plant);
  const second = structuredClone(first);
  second['@dataSetInternalID'] = '2';
  second.exchangeDirection = 'Input';
  second.quantitativeReference = false;
  object(second.referenceToFlowDataSet)['@version'] = secondVersion;
  object(second.referenceToFlowDataSet)['common:shortDescription'] = localized(description);
  root.exchanges = { exchange: [first, second] };
  const identity = object(object(root.processInformation).dataSetInformation);
  const publication = object(object(root.administrativeInformation).publicationAndOwnership);
  return {
    content,
    id: String(identity['common:UUID']),
    version: String(publication['common:dataSetVersion']),
  };
}

function files(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-flow-name-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return (name: string, content: unknown) => {
    const file = path.join(directory, name);
    writeFileSync(file, JSON.stringify(content));
    return file;
  };
}

function transport(overriddenRows?: unknown[], status = 200) {
  const reads: string[] = [];
  const exactVersions = new Map<string, string>();
  const writes: Array<{ url: string; body: Json }> = [];
  const json = (body: unknown, code = 200) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl: FetchLike = async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
    const request = new URL(url);
    if (request.pathname.endsWith('/auth/v1/user')) return json({ id: actor });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Json;
      writes.push({ url, body });
      return json({
        ok: true,
        data: { id: body.id, version: body.version },
        modelId: body.modelId,
        version: v1,
      });
    }
    const id = request.searchParams.get('id')?.slice(3);
    const requestedVersion = request.searchParams.get('version')?.slice(3);
    if (id && requestedVersion) exactVersions.set(id, requestedVersion);
    const version = requestedVersion ?? exactVersions.get(id ?? '') ?? v1;
    if (
      request.pathname.endsWith('/flows') &&
      request.searchParams.get('select')?.includes('json_ordered')
    ) {
      assert.equal(id, flowId);
      assert.ok(request.searchParams.has('version'));
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer .+/u);
      reads.push(version);
      return json(overriddenRows ?? [{ id, version, json_ordered: flowDocument(version) }], status);
    }
    if (request.pathname.endsWith('/lifecyclemodels')) return json([]);
    return json([{ id, version }]);
  };
  const command = {
    functionsBaseUrl: environment + '/functions/v1',
    publishableKey: 'synthetic-publishable-key',
    accessToken: 'synthetic-access-token',
    timeoutMs: 1_000,
    fetchImpl,
  };
  const maintenance = {
    project_ref: 'example',
    rest_base_url: environment + '/rest/v1',
    publishable_key: command.publishableKey,
    access_token: command.accessToken,
    account: { user_id: actor, email: 'fixture@example.test', session_source: 'synthetic' },
    fetch_impl: fetchImpl,
    timeout_ms: 1_000,
  };
  return { reads, writes, fetchImpl, command, maintenance };
}

test('source and emitted name admission retain conflicts and exclude local-only versions', async () => {
  const current = { uuid: flowId, version: v1, document: flowDocument(v1) };
  const different = { ...current, document: { ...current.document, marker: 'changed' } };
  const unread = { uuid: flowId, version: v2, document: flowDocument(v2) };
  assert.deepEqual(bindCurrentFlowNameEvidence([current], [different, unread]), [
    current,
    different,
  ]);
  const dist = await loadDistModule<
    typeof import('../src/lib/validation/process-flow-reference-names.js')
  >('src/lib/validation/process-flow-reference-names.js');
  assert.deepEqual(dist.bindCurrentFlowNameEvidence([current], [different, unread]), [
    current,
    different,
  ]);
});

test('public Process validation distinguishes schema, offline and exact online evidence', async (t) => {
  const file = files(t);
  const { content } = processFixture('Steel');
  const input = file('process.json', content);
  const references = file('flows.json', { documents: [flowDocument(v1)] });
  const io = transport();
  const ports = createDatasetPorts(env, io.fetchImpl);
  const validate = async (checks: string, extras: string[] = []) => {
    const response = await runDatasetCommand(
      ['process', 'validate', '--input', input, '--checks', checks, ...extras, '--json'],
      ports,
    );
    return { exitCode: response.exitCode, result: JSON.parse(response.stdout) };
  };
  const schema = await validate('schema');
  assert.equal(schema.exitCode, 0);
  assert.ok(
    schema.result.data.validation.notChecked.includes('process_exchange_flow_reference_names'),
  );
  const missing = await validate('business');
  assert.equal(missing.result.data.validation.flow_reference_names.status, 'unresolved');
  assert.equal(missing.exitCode, 1);
  const mismatch = await validate('schema,business', ['--reference-documents', references]);
  assert.equal(mismatch.result.outcome, 'validation_failed');
  assert.equal(mismatch.result.data.validation.flow_reference_names.issues[0].path, expectedPath);
  assert.deepEqual(io.reads, []);
  const online = await validate('references');
  assert.equal(online.exitCode, 1);
  assert.equal(online.result.data.validation.flow_reference_names.issues[0].params.expected, plant);
  assert.deepEqual(io.reads, [v1]);
  assert.deepEqual(io.writes, []);
  assert.deepEqual(JSON.parse(readFileSync(input, 'utf8')), content);
});

test('an online exact name check cannot substitute supplied local evidence for unreadable Flow content', async (t) => {
  const file = files(t);
  const { content } = processFixture();
  const input = file('valid-process.json', content);
  const references = file('flow-documents.json', { documents: [flowDocument(v1)] });
  const io = transport([]);
  const ports = createDatasetPorts(env, io.fetchImpl);
  for (const [checks, extras] of [
    ['schema,references', []],
    ['schema,business,references', ['--reference-documents', references]],
  ] as const) {
    const result = await runDatasetCommand(
      ['process', 'validate', '--input', input, '--checks', checks, ...extras, '--json'],
      ports,
    );
    assert.equal(result.exitCode, 1);
    const report = JSON.parse(result.stdout).data.validation;
    assert.equal(report.status, 'incomplete', result.stdout);
    assert.equal(report.flow_reference_names.status, 'unresolved');
    assert.ok(report.notChecked.includes('process_exchange_flow_reference_names'));
  }
  assert.deepEqual(io.writes, []);
});

test('public create and save reject the later non-allocation occurrence before any write', async (t) => {
  const file = files(t);
  const candidate = processFixture('Steel');
  const io = transport();
  const ports = createDatasetPorts(env, io.fetchImpl);
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'cli-flow-name-journals-'));
  t.after(() => rmSync(stateDirectory, { recursive: true, force: true }));
  ports.mutate = datasetWriter(env, io.fetchImpl, stateDirectory);
  for (const action of ['create', 'save']) {
    const input = file(action + '.json', {
      ...candidate,
      expectedActor: actor,
      expectedEnvironment: environment,
      requestId: 'flow-name-test-' + action,
      ...(action === 'save' ? { expectedContent: processFixture().content } : {}),
    });
    const response = await runDatasetCommand(
      ['process', action, '--input', input, '--json'],
      ports,
    );
    assert.equal(response.exitCode, 1);
    const result = JSON.parse(response.stdout);
    assert.equal(result.error.code, 'PROCESS_FLOW_NAME_ADMISSION_BLOCKED');
    const findings = result.data.validation.flow_reference_names;
    assert.equal(findings.issues[0].path, expectedPath);
    assert.equal(findings.issues[0].params.actual, 'Steel');
    assert.equal(findings.issues[0].params.expected, plant);
  }
  assert.deepEqual(io.reads, [v1, v1]);
  assert.deepEqual(io.writes, []);
});

test('qualification errors remain usable by callers that present the original thrown admission error', async (t) => {
  const file = files(t);
  const candidate = processFixture('Steel');
  const io = transport();
  let failure: unknown;
  try {
    await qualifyDatasetWrite('process', candidate.content, env, io.fetchImpl);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const ports = createDatasetPorts(env, io.fetchImpl);
  ports.mutate = async () => {
    throw failure;
  };
  const result = await runDatasetCommand(
    ['process', 'create', '--input', file('request.json', candidate), '--json'],
    ports,
  );
  const value = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 1);
  assert.equal(value.error.code, 'PROCESS_FLOW_NAME_ADMISSION_BLOCKED');
  assert.equal(value.data.validation.flow_reference_names.issues[0].path, expectedPath);
  assert.deepEqual(io.writes, []);
});

test('native dispatch validates the exact payload and current selected versions independently of preflight', async () => {
  const invalid = processFixture(later);
  const io = transport();
  const options = {
    id: invalid.id,
    version: invalid.version,
    transport: io.command,
    payload: invalid.content,
  };
  let dispatches = 0;
  for (const write of [createDatasetRecord, saveDraftDatasetRecord]) {
    await assert.rejects(
      write({
        ...options,
        table: 'processes',
        beforeDispatch: () => {
          dispatches++;
        },
      }),
      /name check failed/u,
    );
  }
  assert.equal(dispatches, 0);
  assert.equal(io.writes.length, 0);
  const correctVersions = processFixture(later, v2);
  await createDatasetRecord({
    ...options,
    table: 'processes',
    payload: correctVersions.content,
    beforeDispatch: () => {
      dispatches++;
    },
  });
  assert.equal(dispatches, 1);
  assert.deepEqual(io.reads, [v1, v1, v1, v2]);
  assert.deepEqual(io.writes[0].body.jsonOrdered, correctVersions.content);
});

test('final write uses the same authenticated Flow documents for names and allocation', async () => {
  const { payload, context } = allocationFixture();
  const io = transport([{ id: flowId, version: v1, json_ordered: context.flow_documents[0] }]);
  await createDatasetRecord({
    id: '77777777-7777-4777-8777-777777777777',
    table: 'processes',
    payload,
    extraData: { semantic_context: context },
    transport: io.command,
  });
  assert.deepEqual(io.reads, [v1]);
  assert.equal(io.writes.length, 1);
});

test('maintenance and bundle prevent any write for a mismatched Process candidate', async () => {
  const valid = processFixture();
  const invalid = processFixture('Steel');
  const io = transport();
  const options = {
    context: io.maintenance,
    table: 'processes' as const,
    id: invalid.id,
    version: invalid.version,
    modelId: null,
    ruleVerification: null,
    audit: {},
  };
  await assert.rejects(
    saveDraftMaintenanceRow({ ...options, payload: invalid.content }),
    /name check failed/u,
  );
  const bundle = {
    id: '00000000-0000-4000-8000-000000000003',
    version: v1,
    payload: { lifeCycleModelDataSet: {} },
    env,
    fetchImpl: io.fetchImpl,
  };
  await assert.rejects(
    syncLifecyclemodelBundleRecord({
      ...bundle,
      metadata: {
        processMutations: [
          { op: 'create', id: valid.id, jsonOrdered: valid.content },
          { op: 'update', id: invalid.id, jsonOrdered: invalid.content },
        ],
      },
    }),
    /name check failed/u,
  );
  assert.deepEqual(io.writes, []);
  assert.deepEqual(io.reads, [v1, v1]);
  await assert.rejects(
    syncLifecyclemodelBundleRecord({
      ...bundle,
      metadata: { processMutations: [{ op: 'update', id: invalid.id }] },
    }),
    /complete jsonOrdered/u,
  );
  await saveDraftMaintenanceRow({ ...options, payload: valid.content });
  await syncLifecyclemodelBundleRecord({
    ...bundle,
    metadata: {
      processMutations: [
        { op: 'delete', id: invalid.id, version: invalid.version },
        { op: 'create', id: valid.id, jsonOrdered: valid.content },
      ],
    },
  });
  assert.equal(io.writes.length, 2);
});

test('missing, ambiguous and conflicting Flow observations cannot qualify a direct write', async () => {
  const { id, version, content } = processFixture();
  const flow = flowDocument(v1);
  for (const rows of [
    [],
    [null],
    [{ id: 'other', version: v1, json_ordered: flow }],
    [{ id: flowId, version: v2, json_ordered: flow }],
    [{ id: flowId, version: v1, json_ordered: null }],
    [
      { id: flowId, version: v1, json_ordered: flow },
      { id: flowId, version: v1, json_ordered: flow },
    ],
    [{ id: flowId, version: v1, json_ordered: flowDocument(v2) }],
  ]) {
    const io = transport(rows);
    await assert.rejects(
      createDatasetRecord({ id, payload: content, table: 'processes', transport: io.command }),
      /name check unresolved/u,
    );
    assert.deepEqual(io.writes, []);
  }
  const io = transport();
  await assert.rejects(
    saveDraftDatasetRecord({
      id,
      version,
      payload: content,
      table: 'processes',
      transport: io.command,
      extraData: {
        semantic_context: { flow_documents: [{ ...flow, synthetic: 'different exact content' }] },
      },
    }),
    /name check unresolved/u,
  );
  assert.deepEqual(io.writes, []);
  const remoteError = transport([], 403);
  await assert.rejects(
    createDatasetRecord({
      id,
      payload: content,
      table: 'processes',
      transport: remoteError.command,
    }),
    /Could not read the selected Flow/u,
  );
  assert.deepEqual(remoteError.writes, []);
});
