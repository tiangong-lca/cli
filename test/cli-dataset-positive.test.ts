import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import { contentDigest } from '../src/application/dataset-content.js';
import { datasetValidation } from '../src/adapters/dataset-local.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import {
  businessActor,
  businessFixture,
  businessProcessReferenceFlow,
  businessIdentity,
  businessEdit,
  wrappers,
  information,
  writableTypes,
} from './helpers/cli-business-fixtures.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

for (const type of writableTypes) {
  test(`${type}: complete valid content passes default admission through create, patch, save and exact readback`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-business-positive-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const backend = createBusinessBackend();
    const env = buildSupabaseTestEnv({
      TIANGONG_LCA_AUTH_MODE: 'access-token',
      TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
    });
    const ports = createDatasetPorts(env, backend.fetchImpl);
    // Only isolate journal storage; real local/business/reference admission is retained.
    ports.mutate = datasetWriter(env, backend.fetchImpl, path.join(directory, 'intents'));
    const content = businessFixture(type),
      identity = businessIdentity(type, content);
    const binding = {
      ...identity,
      expectedActor: businessActor,
      expectedEnvironment: 'https://example.supabase.co',
    };
    let sequence = 0;
    const invoke = async (action: string, request: unknown, extra: string[] = []) => {
      const input = path.join(directory, `${sequence++}.json`);
      writeFileSync(input, JSON.stringify(request));
      const response = await runDatasetCommand(
        [type, action, '--input', input, '--json', ...extra],
        ports,
      );
      return { response, value: JSON.parse(response.stdout) };
    };
    assert.equal(
      (
        await datasetValidation(
          type,
          content,
          ['schema', 'business'],
          type === 'process' ? [businessProcessReferenceFlow()] : undefined,
        )
      ).status,
      'passed',
    );
    const preview = await invoke('create', { ...binding, content, requestId: `${type}-preview` }, [
      '--dry-run',
    ]);
    assert.equal(preview.value.outcome, 'preview_completed', preview.response.stdout);
    assert.equal(backend.calls.filter((c) => c.path.startsWith('/functions/')).length, 0);
    const created = await invoke('create', { ...binding, content, requestId: `${type}-create` });
    assert.equal(created.value.status, 'completed', created.response.stdout);
    assert.equal(created.value.outcome, 'dataset_written');
    const get = async () => {
      const reply = await runDatasetCommand(
        [type, 'get', '--id', identity.id, '--version', identity.version, '--json'],
        ports,
      );
      assert.equal(reply.exitCode, 0, reply.stdout);
      return JSON.parse(reply.stdout).data.content;
    };
    assert.deepEqual(await get(), content);
    const patchedPath = path.join(directory, 'patched.json');
    const candidate = businessEdit(type, content);
    const patched = await invoke(
      'patch',
      {
        content,
        expectedDigest: contentDigest(content),
        operations: [
          {
            op: 'add',
            path: `/${wrappers[type]}/${information[type]}/dataSetInformation/common:generalComment`,
            value: { '@xml:lang': 'en', '#text': 'Edited fixture' },
            basis: 'Synthetic fixture revision',
          },
        ],
      },
      ['--output', patchedPath],
    );
    assert.equal(patched.response.exitCode, 0, patched.response.stdout);
    assert.deepEqual(JSON.parse(readFileSync(patchedPath, 'utf8')), candidate);
    assert.deepEqual(await get(), content, 'local patch must not save');
    const validated = await invoke('validate', candidate, [
      '--checks',
      'schema,business,references',
    ]);
    assert.equal(validated.response.exitCode, 0, validated.response.stdout);
    const saved = await invoke('save', {
      ...binding,
      content: candidate,
      expectedContent: content,
      requestId: `${type}-save`,
    });
    assert.equal(saved.value.outcome, 'dataset_written', saved.response.stdout);
    assert.deepEqual(await get(), candidate);
    const stale = await invoke('save', {
      ...binding,
      content,
      expectedContent: content,
      requestId: `${type}-stale`,
    });
    assert.notEqual(stale.response.exitCode, 0);
    assert.equal(backend.calls.filter((c) => c.path.startsWith('/functions/')).length, 2);
    if (type !== 'model') {
      const deleted = await invoke('delete', {
        ...binding,
        expectedContent: candidate,
        requestId: `${type}-delete`,
      });
      assert.equal(deleted.value.outcome, 'dataset_deleted', deleted.response.stdout);
      assert.equal(backend.rows.size, 0);
    } else {
      const mutations = backend.calls.filter((c) =>
        c.path.endsWith('/save_lifecycle_model_bundle'),
      );
      assert.deepEqual(
        mutations.map((c) => c.body.mode),
        ['create', 'update'],
      );
      assert.ok(
        mutations.every(
          (c) => Array.isArray(c.body.processMutations) && c.body.processMutations.length === 0,
        ),
      );
    }
  });
}

test('Source creation checks the target UUID before I/O while historical exact reads preserve it', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cli-source-uuid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backend = createBusinessBackend();
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
  });
  const id = randomUUID();
  const historicalId = id.slice(0, 19) + 'c' + id.slice(20);
  const body = (uuid: string) => {
    const content = businessFixture('source');
    const root = content.sourceDataSet as JsonObject;
    const info = root.sourceInformation as JsonObject;
    (info.dataSetInformation as JsonObject)['common:UUID'] = uuid;
    return content;
  };
  const historical = body(historicalId);
  const version = businessIdentity('source', historical).version;
  const reads: string[] = [];
  const ports = createDatasetPorts(env, async (url, init) => {
    const query = new URL(url);
    if (
      query.pathname.endsWith('/sources') &&
      query.searchParams.get('id') === `eq.${historicalId}`
    ) {
      reads.push(String(query.searchParams.get('version')));
      return Response.json([{ id: historicalId, version, json: historical }]);
    }
    return backend.fetchImpl(url, init);
  });
  const input = path.join(directory, 'source.json');
  const run = async (args: string[]) => {
    const reply = await runDatasetCommand(['source', ...args, '--json'], ports);
    return { reply, value: JSON.parse(reply.stdout) };
  };
  const preview = async (targetId: string, content: JsonObject, dryRun = true) => {
    writeFileSync(
      input,
      JSON.stringify({
        id: targetId,
        version,
        content,
        requestId: 'source-create',
        expectedActor: businessActor,
        expectedEnvironment: 'https://example.supabase.co',
      }),
    );
    return run(['create', '--input', input, ...(dryRun ? ['--dry-run'] : [])]);
  };

  writeFileSync(input, JSON.stringify(historical));
  assert.equal(
    (await run(['validate', '--input', input, '--checks', 'schema,business'])).value.outcome,
    'validation_passed',
  );
  for (const dryRun of [true, false]) {
    const rejected = await preview(historicalId, historical, dryRun);
    assert.equal(rejected.reply.exitCode, 2);
    assert.equal(rejected.value.error.code, 'IDENTITY_INVALID');
    assert.match(rejected.value.error.message, /^id must be a UUID/u);
  }
  assert.equal((await preview(id, historical)).value.error.code, 'IDENTITY_MISMATCH');
  assert.deepEqual(backend.calls, []);
  assert.deepEqual(reads, []);
  assert.equal((await preview(id, body(id))).value.outcome, 'preview_completed');

  const exact = await run(['get', '--id', historicalId, '--version', version]);
  assert.equal(exact.reply.exitCode, 0);
  assert.equal(exact.value.data.subject.id, historicalId);
  assert.equal(exact.value.data.subject.version, version);
  assert.deepEqual(exact.value.data.content, historical);
  assert.deepEqual(reads, [`eq.${version}`]);
});
