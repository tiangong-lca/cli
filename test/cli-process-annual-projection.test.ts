import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { processAnnualEvidence } from '../src/adapters/process-annual-evidence.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import {
  annualFixture,
  annualVersion,
  annualFlowId,
  annualPropertyId,
  annualGroupId,
  annualTexts,
} from './helpers/process-annual-projection.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import { businessActor, businessIdentity } from './helpers/cli-business-fixtures.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';
import { record } from '../src/lib/validation/process-reference-unit.js';

function backendWithEvidence(x: ReturnType<typeof annualFixture>) {
  const backend = createBusinessBackend();
  backend.seed('processes', x.payload);
  for (const [i, table] of ['flows', 'flowproperties', 'unitgroups'].entries()) {
    const id = [annualFlowId, annualPropertyId, annualGroupId][i]!;
    backend.rows.set(`${table}:${id}:${annualVersion}`, {
      id,
      version: annualVersion,
      json: x.documents[i]!,
      user_id: businessActor,
      state_code: 0,
    });
  }
  return backend;
}

test('current CLI validates locally/remotely and guards unchanged draft preparation and save/readback', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-annual-452-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const withUnit of [true, false]) {
    const x = annualFixture(withUnit),
      before = JSON.stringify(x.payload);
    const backend = backendWithEvidence(x);
    const env = buildSupabaseTestEnv({
      TIANGONG_LCA_AUTH_MODE: 'access-token',
      TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
    });
    const ports = createDatasetPorts(env, backend.fetchImpl);
    ports.mutate = datasetWriter(env, backend.fetchImpl, path.join(directory, String(withUnit)));
    const candidate = path.join(directory, 'candidate.json'),
      evidence = path.join(directory, 'references.json'),
      request = path.join(directory, 'save.json');
    writeFileSync(candidate, JSON.stringify(x.payload));
    writeFileSync(evidence, JSON.stringify({ documents: x.documents }));
    const validation = await runDatasetCommand(
      ['process', 'validate', '--input', candidate, '--reference-documents', evidence, '--json'],
      ports,
    );
    assert.equal(validation.exitCode, 0, validation.stdout);
    assert.equal(backend.calls.length, 0, 'local evidence must not cause network IO');
    const missing = await runDatasetCommand(
      ['process', 'validate', '--input', candidate, '--json'],
      ports,
    );
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).data.validation.status, 'incomplete');
    const remote = await runDatasetCommand(
      [
        'process',
        'validate',
        '--input',
        candidate,
        '--checks',
        'schema,business,references',
        '--json',
      ],
      ports,
    );
    assert.equal(remote.exitCode, 0, remote.stdout);
    const binding = {
      ...businessIdentity('process', x.payload),
      content: x.payload,
      expectedContent: structuredClone(x.payload),
      requestId: `annual-${withUnit}`,
      expectedActor: businessActor,
      expectedEnvironment: 'https://example.supabase.co',
    };
    writeFileSync(request, JSON.stringify(binding));
    const preview = await runDatasetCommand(
      ['process', 'save', '--input', request, '--dry-run', '--json'],
      ports,
    );
    assert.equal(preview.exitCode, 0, preview.stdout);
    assert.equal(backend.calls.filter((c) => c.method !== 'GET').length, 0);
    const saved = await runDatasetCommand(['process', 'save', '--input', request, '--json'], ports);
    assert.equal(saved.exitCode, 0, saved.stdout);
    assert.equal(JSON.parse(saved.stdout).data.readback.contentMatchesIntent, true);
    const dispatched = backend.calls.filter((c) => c.path.endsWith('/app_dataset_save_draft'));
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0]!.body.jsonOrdered, x.payload);
    assert.deepEqual(dispatched[0]!.body.expectedJsonOrdered, x.payload);
    assert.equal(JSON.stringify(x.payload), before);
    const replay = await runDatasetCommand(
      ['process', 'save', '--input', request, '--json'],
      ports,
    );
    assert.equal(JSON.parse(replay.stdout).outcome, 'original_result_returned');
    assert.equal(backend.calls.filter((c) => c.path.endsWith('/app_dataset_save_draft')).length, 1);
    const invalid = structuredClone(binding);
    invalid.requestId += 'bad';
    invalid.expectedActor = 'someone-else';
    writeFileSync(request, JSON.stringify(invalid));
    assert.notEqual(
      (
        await runDatasetCommand(
          ['process', 'save', '--input', request, '--dry-run', '--json'],
          ports,
        )
      ).exitCode,
      0,
    );
    writeFileSync(evidence, JSON.stringify({ documents: [{ ...x.flow, unknownEvidence: true }] }));
    const stale = await runDatasetCommand(
      [
        'process',
        'validate',
        '--input',
        candidate,
        '--reference-documents',
        evidence,
        '--checks',
        'business,references',
        '--json',
      ],
      ports,
    );
    assert.equal(JSON.parse(stale.stdout).error.code, 'ANNUAL_REFERENCE_STALE');
  }
});

test('missing/invalid current unit evidence and unrelated preconditions cannot be waived by a projection', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-annual-denials-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const edits: Array<(x: ReturnType<typeof annualFixture>) => void> = [
    (x) => {
      delete x.sources.dataTreatmentAndExtrapolationsPrinciples;
    },
    (x) => {
      x.sources.annualSupplyOrProductionVolume = annualTexts(
        '1000 kg treated water at works gate',
        '2000 kg 厂界处理水',
      );
    },
    (x) => {
      x.group.unitGroupDataSet.units.unit.name = 'MJ';
    },
    (x) => {
      record(record(record(x.payload.processDataSet).processInformation).dataSetInformation)[
        'common:UUID'
      ] = 'invalid';
    },
    (x) => {
      record(record(x.payload.processDataSet).modellingAndValidation).validation = {};
    },
  ];
  for (const edit of edits) {
    const x = annualFixture();
    edit(x);
    const backend = backendWithEvidence(x);
    const ports = createDatasetPorts(
      buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' }),
      backend.fetchImpl,
    );
    const file = path.join(dir, 'request.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...businessIdentity('process', x.payload),
        content: x.payload,
        expectedContent: x.payload,
        requestId: 'negative',
        expectedActor: businessActor,
        expectedEnvironment: 'https://example.supabase.co',
      }),
    );
    const response = await runDatasetCommand(
      ['process', 'save', '--input', file, '--dry-run', '--json'],
      ports,
    );
    assert.notEqual(response.exitCode, 0, response.stdout);
    assert.ok(backend.calls.every((c) => c.method === 'GET'));
  }
  const x = annualFixture(),
    backend = backendWithEvidence(x),
    env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
  backend.rows.delete(`unitgroups:${annualGroupId}:${annualVersion}`);
  await assert.rejects(
    processAnnualEvidence(x.payload, env, backend.fetchImpl),
    /one readable exact unitgroup/u,
  );
  delete x.exchange.referenceToFlowDataSet;
  assert.deepEqual(await processAnnualEvidence(x.payload, env, backend.fetchImpl), []);
});

test(
  'built launcher executes projection validation and guarded dry-run against isolated HTTP evidence',
  { skip: process.env.TIANGONG_LCA_COVERAGE === '1' },
  async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-annual-native-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const x = annualFixture(false),
      backend = backendWithEvidence(x),
      server = await backend.start();
    t.after(server.close);
    const candidate = path.join(dir, 'candidate.json'),
      request = path.join(dir, 'save.json');
    writeFileSync(candidate, JSON.stringify(x.payload));
    writeFileSync(
      request,
      JSON.stringify({
        ...businessIdentity('process', x.payload),
        content: x.payload,
        expectedContent: x.payload,
        requestId: 'native-dry-run',
        expectedActor: businessActor,
        expectedEnvironment: server.origin,
      }),
    );
    const invoke = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.resolve('bin/tiangong-lca.js'), 'dataset', 'process', ...args, '--json'],
          {
            cwd: dir,
            env: {
              ...process.env,
              HOME: dir,
              TIANGONG_LCA_AUTH_MODE: 'access-token',
              TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
              TIANGONG_LCA_API_BASE_URL: `${server.origin}/functions/v1`,
              TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'fixture-key',
            },
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    for (const args of [
      ['validate', '--input', candidate, '--checks', 'schema,business,references'],
      ['save', '--input', request, '--dry-run'],
    ]) {
      const reply = await invoke(args);
      assert.equal(reply.code, 0, reply.stdout + reply.stderr);
    }
    assert.ok(backend.calls.every((c) => c.method === 'GET'));
    x.sources.dataTreatmentAndExtrapolationsPrinciples = annualTexts(
      '1000 kg/year may be wrong',
      '1000 kg/年可能有误',
    );
    writeFileSync(candidate, JSON.stringify(x.payload));
    assert.notEqual(
      (await invoke(['validate', '--input', candidate, '--checks', 'business,references'])).code,
      0,
    );
  },
);

test('reference evidence input must be an explicit Process business document collection', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'annual-reference-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const x = annualFixture(),
    backend = backendWithEvidence(x),
    ports = createDatasetPorts({}, backend.fetchImpl);
  const input = path.join(dir, 'process.json'),
    references = path.join(dir, 'references.json');
  writeFileSync(input, JSON.stringify(x.payload));
  for (const documents of [undefined, {}, [null], ['bad'], [0]]) {
    writeFileSync(references, JSON.stringify({ documents }));
    const reply = await runDatasetCommand(
      ['process', 'validate', '--input', input, '--reference-documents', references, '--json'],
      ports,
    );
    assert.equal(JSON.parse(reply.stdout).error.code, 'ANNUAL_REFERENCE_INPUT_INVALID');
  }
  writeFileSync(references, JSON.stringify({ documents: x.documents }));
  const reply = await runDatasetCommand(
    [
      'process',
      'validate',
      '--input',
      input,
      '--checks',
      'schema',
      '--reference-documents',
      references,
      '--json',
    ],
    ports,
  );
  assert.equal(JSON.parse(reply.stdout).error.code, 'ANNUAL_REFERENCE_INPUT_INVALID');
  assert.equal(backend.calls.length, 0);
});

test('validation output cannot overwrite its reference evidence even with force', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'annual-reference-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const x = annualFixture(),
    ports = createDatasetPorts({}, backendWithEvidence(x).fetchImpl);
  const input = path.join(dir, 'process.json'),
    references = path.join(dir, 'references.json');
  writeFileSync(input, JSON.stringify(x.payload));
  writeFileSync(references, JSON.stringify({ documents: x.documents }));
  const response = await runDatasetCommand(
    [
      'process',
      'validate',
      '--input',
      input,
      '--reference-documents',
      references,
      '--output',
      references,
      '--force',
      '--json',
    ],
    ports,
  );
  assert.equal(JSON.parse(response.stdout).error.code, 'OUTPUT_IS_INPUT');
});
