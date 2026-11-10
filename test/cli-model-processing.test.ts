import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { datasetOperations } from '../src/adapters/dataset-operations.js';
import { loadModelInput, resolveRequestFile } from '../src/adapters/model-input.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { stageModelProcesses } from '../src/adapters/model-process-inputs.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike } from '../src/lib/http.js';
import type { JsonObject } from '../src/application/dataset-types.js';

const version = '00.00.001';
const processId = '00000000-0000-4000-8000-000000000001';
const modelId = '00000000-0000-4000-8000-000000000002';
const flowId = '00000000-0000-4000-8000-000000000003';
const model = {
  lifeCycleModelDataSet: {
    '@id': modelId,
    '@version': version,
    lifeCycleModelInformation: {
      dataSetInformation: {
        'common:UUID': modelId,
        name: { baseName: [{ '@xml:lang': 'en', '#text': 'Model' }] },
      },
      quantitativeReference: { referenceToReferenceProcess: '1' },
      technology: {
        processes: {
          processInstance: [
            {
              '@dataSetInternalID': '1',
              '@multiplicationFactor': '1',
              referenceToProcess: { '@refObjectId': processId, '@version': version },
              connections: { outputExchange: [] },
            },
          ],
        },
      },
    },
    administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
  },
};
const processContent = {
  processDataSet: {
    processInformation: {
      dataSetInformation: {
        'common:UUID': processId,
        name: { baseName: [{ '@xml:lang': 'en', '#text': 'Process' }] },
      },
      quantitativeReference: { referenceToReferenceFlow: '0' },
    },
    exchanges: {
      exchange: [
        {
          '@dataSetInternalID': '0',
          exchangeDirection: 'Output',
          meanAmount: 1,
          resultingAmount: 1,
          referenceToFlowDataSet: {
            '@type': 'flow data set',
            '@refObjectId': flowId,
            '@version': version,
          },
        },
      ],
    },
    administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    modellingAndValidation: {
      LCIMethodAndAllocation: { typeOfDataSet: 'Unit process, single operation' },
    },
  },
};
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'model-new-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
const noNetwork: FetchLike = async () => {
  throw new Error('unexpected network');
};
function remote(rows: unknown[] = [{ id: modelId, version, json: model }]): FetchLike {
  return async (url) =>
    isSupabaseAuthTokenUrl(url)
      ? makeSupabaseAuthResponse()
      : new Response(
          JSON.stringify(
            new URL(url).pathname.endsWith('processes')
              ? [{ id: processId, version, json: processContent }]
              : rows,
          ),
          { headers: { 'content-type': 'application/json', 'content-range': '0-0/1' } },
        );
}
test('Model inputs select exactly one explicit source and preserve exact remote versions', async (t) => {
  const dir = directory(t);
  const file = path.join(dir, 'model.json');
  writeFileSync(file, JSON.stringify(model));
  assert.deepEqual((await loadModelInput({ content: model }, '-', env, noNetwork)).content, model);
  assert.deepEqual(
    (await loadModelInput({ file: 'model.json' }, path.join(dir, 'request.json'), env, noNetwork))
      .content,
    model,
  );
  assert.deepEqual((await loadModelInput({ file }, '-', env, noNetwork)).content, model);
  const found = await loadModelInput({ remote: { id: modelId, version } }, '-', env, remote());
  assert.equal(found.sourceContext.environment, 'https://example.supabase.co');
  for (const request of [
    {},
    { content: model, file },
    { remote: { id: modelId, version: 'latest' } },
  ])
    await assert.rejects(loadModelInput(request, '-', env, noNetwork));
  await assert.rejects(
    loadModelInput({ remote: { id: modelId, version } }, '-', env, remote([])),
    /not found/,
  );
  await assert.rejects(
    loadModelInput(
      { remote: { id: modelId, version } },
      '-',
      env,
      remote([{ id: 'other', version, json: model }]),
    ),
    /invalid identity/,
  );
  assert.throws(() => resolveRequestFile('relative.json', '-'), /absolute/);
});
test('Model graph runs the existing graph implementation, returns data and detects dangling edges', async (t) => {
  const dir = directory(t);
  const operations = datasetOperations(env, noNetwork);
  const graph = await operations({
    type: 'model',
    action: 'graph',
    request: { content: model },
    inputPath: '-',
  });
  assert.equal((graph.counts as JsonObject).nodes, 1);
  assert.equal((graph.graphs as unknown[]).length, 1);
  const graphInput = path.join(dir, 'graph-request.json');
  const graphOutput = path.join(dir, 'graph-result.json');
  writeFileSync(graphInput, JSON.stringify({ content: model }));
  const written = JSON.parse(
    (
      await runDatasetCommand(
        ['model', 'graph', '--input', graphInput, '--output', graphOutput, '--json'],
        createDatasetPorts(env, noNetwork),
      )
    ).stdout,
  );
  assert.equal(written.data.graphs, undefined);
  assert.equal(typeof written.data.graphsDigest, 'string');
  assert.equal(JSON.parse(readFileSync(graphOutput, 'utf8')).graphs.length, 1);
  const changed = structuredClone(model);
  changed.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance[0]!.connections.outputExchange.push(
    { '@flowUUID': flowId, downstreamProcess: { '@id': 'missing' } } as never,
  );
  const broken = await operations({
    type: 'model',
    action: 'graph',
    request: { content: changed },
    inputPath: '-',
  });
  assert.equal(broken.status, 'completed_with_findings');
  const input = path.join(dir, 'graph.json');
  writeFileSync(input, JSON.stringify({ content: changed }));
  const reply = await runDatasetCommand(
    ['model', 'graph', '--input', input, '--json'],
    createDatasetPorts(env, noNetwork),
  );
  assert.equal(reply.exitCode, 1);
  assert.equal(JSON.parse(reply.stdout).status, 'partial');
  await assert.rejects(
    operations({ type: 'source', action: 'unknown', request: {}, inputPath: '-' } as never),
    /no supported adapter/,
  );
});
test('Model result generation and aggregate share canonical output with exact local or remote Process inputs', async (t) => {
  const dir = directory(t);
  const processFile = path.join(dir, 'process.json');
  const modelFile = path.join(dir, 'model.json');
  writeFileSync(processFile, JSON.stringify(processContent));
  writeFileSync(modelFile, JSON.stringify(model));
  const input = path.join(dir, 'request.json');
  const request = {
    source_model: { json_ordered_path: 'model.json' },
    projection: {
      mode: 'primary-only',
      process_id: '00000000-0000-4000-8000-000000000004',
      process_version: version,
    },
    process_sources: { process_json_files: ['process.json'] },
  };
  writeFileSync(input, JSON.stringify(request));
  const ports = createDatasetPorts(env, noNetwork);
  const main = await runDatasetCommand(
    ['model', 'build-resulting-process', '--input', input, '--json'],
    ports,
  );
  const alias = await runDatasetCommand(['model', 'aggregate', '--input', input, '--json'], ports);
  const first = JSON.parse(main.stdout);
  const second = JSON.parse(alias.stdout);
  const artifact = path.join(dir, 'candidate.json');
  const compact = JSON.parse(
    (
      await runDatasetCommand(
        ['model', 'build-resulting-process', '--input', input, '--output', artifact, '--json'],
        ports,
      )
    ).stdout,
  );
  assert.equal(compact.data.bundle, undefined);
  assert.equal(typeof compact.data.bundleDigest, 'string');
  assert.equal(JSON.parse(readFileSync(artifact, 'utf8')).projectedProcessCount, 1);
  assert.equal(first.operation, 'dataset model build-resulting-process');
  assert.equal(second.operation, first.operation);
  assert.equal(first.data.projectedProcessCount, 1, main.stdout);
  delete second.data.bundle.report.generated_at;
  delete first.data.bundle.report.generated_at;
  assert.deepEqual(second.data.bundle, first.data.bundle);
  // Synthetic content deliberately lacks authoring evidence: generated content is not qualified.
  assert.equal(first.status, 'partial');
  assert.equal(main.exitCode, 1);
  const local = datasetOperations(env, noNetwork);
  for (const change of [
    { publish: { intent: 'publish' } },
    { process_sources: { run_dirs: ['production'] } },
    { process_sources: { process_json_files: ['relative.json'] } },
  ]) {
    await assert.rejects(
      local({
        type: 'model',
        action: 'build-resulting-process',
        request: { ...request, ...change },
        inputPath: '-',
      }),
    );
  }
  const bad = structuredClone(model);
  delete (
    bad.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance[0]!
      .referenceToProcess as JsonObject
  )['@version'];
  await assert.rejects(
    local({
      type: 'model',
      action: 'build-resulting-process',
      request: { ...request, source_model: { json_ordered: bad } },
      inputPath: input,
    }),
    /exact/,
  );
  const remotely = datasetOperations(env, remote());
  const result = await remotely({
    type: 'model',
    action: 'build-resulting-process',
    request: {
      ...request,
      source_model: { json_ordered: model },
      process_sources: { allow_remote_lookup: true, process_json_files: [] },
    },
    inputPath: input,
  });
  assert.equal(result.projectedProcessCount, 1);
  assert.equal(
    (
      await remotely({
        type: 'model',
        action: 'build-resulting-process',
        request: {
          ...request,
          source_model: { remote: { id: modelId, version } },
          process_sources: { allow_remote_lookup: true },
        },
        inputPath: input,
      })
    ).projectedProcessCount,
    1,
  );
  await assert.rejects(
    remotely({
      type: 'model',
      action: 'build-resulting-process',
      request: {
        ...request,
        source_model: { json_ordered: model },
        process_sources: { allow_remote_lookup: true, process_catalog_path: 'catalog.json' },
      },
      inputPath: input,
    }),
    /Choose explicit local/,
  );
});
test('Process statistics validates explicit scope/state selections and binds current-user scope', async () => {
  const operations = datasetOperations(env, async (url) =>
    isSupabaseAuthTokenUrl(url)
      ? makeSupabaseAuthResponse({ userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      : new Response('[]', {
          headers: { 'content-type': 'application/json', 'content-range': '*/0' },
        }),
  );
  for (const request of [
    { scope: 'all', stateCodes: [0] },
    { scope: 'visible', stateCodes: [] },
    { scope: 'visible', stateCodes: ['0'] },
  ])
    await assert.rejects(
      operations({ type: 'process', action: 'statistics', request: request, inputPath: '-' }),
      /scope|stateCodes/,
    );
  const result = await operations({
    type: 'process',
    action: 'statistics',
    request: { scope: 'visible', stateCodes: [0] },
    inputPath: '-',
  });
  assert.equal(result.files, undefined);
  assert.ok(result.status);
  assert.ok(
    (
      await operations({
        type: 'process',
        action: 'statistics',
        request: { scope: 'current-user', stateCodes: [0] },
        inputPath: '-',
      })
    ).status,
  );
  await assert.rejects(
    operations({ type: 'contact', action: 'graph', request: {}, inputPath: '-' } as never),
    /no supported adapter/,
  );
});

test('Model input snapshots bind declared files, directories and catalogs, deduplicate identical versions and reject conflicts', async (t) => {
  const dir = directory(t);
  const folder = path.join(dir, 'inputs');
  const staged = path.join(dir, 'snapshots');
  mkdirSync(folder);
  mkdirSync(staged);
  mkdirSync(path.join(folder, 'nested'));
  const input = path.join(dir, 'request.json');
  const processFile = path.join(folder, 'arbitrary-name.json');
  const catalog = path.join(dir, 'catalog.json');
  writeFileSync(processFile, JSON.stringify(processContent));
  writeFileSync(path.join(folder, 'ignored.txt'), 'not JSON');
  writeFileSync(
    catalog,
    JSON.stringify([
      { file: 'inputs/arbitrary-name.json' },
      { content: processContent },
      processContent,
    ]),
  );
  const snapshot = await stageModelProcesses(
    {
      process_json_files: [processFile],
      process_json_dirs: ['inputs'],
      process_catalog_path: 'catalog.json',
    },
    model,
    input,
    staged,
    env,
    noNetwork,
  );
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.bindings[0]!.id, processId);
  assert.ok(String(snapshot.sanitize(snapshot.files[0])).startsWith('snapshot:process:'));
  assert.deepEqual(snapshot.sanitize([path.join(staged, 'other'), { count: 1 }]), [
    'local-snapshot',
    { count: 1 },
  ]);
  for (const sources of [
    { process_json_files: 'bad' },
    { process_json_dirs: 'bad' },
    { run_dirs: ['workflow'] },
  ])
    await assert.rejects(stageModelProcesses(sources, model, input, staged, env, noNetwork));
  writeFileSync(catalog, '{}');
  await assert.rejects(
    stageModelProcesses({ process_catalog_path: catalog }, model, input, staged, env, noNetwork),
    /must be an array/,
  );
  writeFileSync(catalog, JSON.stringify([{ processDataSet: {} }]));
  await assert.rejects(
    stageModelProcesses({ process_catalog_path: catalog }, model, input, staged, env, noNetwork),
    /own UUID/,
  );
  writeFileSync(
    catalog,
    JSON.stringify([
      processContent,
      {
        ...processContent,
        processDataSet: { ...processContent.processDataSet, extra: 'conflict' },
      },
    ]),
  );
  await assert.rejects(
    stageModelProcesses({ process_catalog_path: catalog }, model, input, staged, env, noNetwork),
    /conflicting content/,
  );
  const duplicateModel = structuredClone(model);
  duplicateModel.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes.processInstance.push(
    duplicateModel.lifeCycleModelDataSet.lifeCycleModelInformation.technology.processes
      .processInstance[0]!,
  );
  const exact = await stageModelProcesses(
    { allow_remote_lookup: true },
    duplicateModel,
    input,
    staged,
    env,
    remote(),
  );
  assert.equal(exact.bindings.length, 1);
  await assert.rejects(
    stageModelProcesses({ allow_remote_lookup: true }, model, input, staged, env, async (url) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse()
        : new Response('[]', { headers: { 'content-type': 'application/json' } }),
    ),
    /not found/,
  );
});
