import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { contentDigest } from '../src/application/dataset-content.js';
import { datasetValidation } from '../src/adapters/dataset-local.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import {
  businessActor,
  businessFixture,
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
    assert.equal((await datasetValidation(type, content, ['schema', 'business'])).status, 'passed');
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
