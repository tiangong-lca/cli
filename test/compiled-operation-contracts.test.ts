import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadDistModule } from './helpers/load-dist-module.js';

test('compiled HTTP transport preserves an explicit application rejection', async () => {
  const compiled = await loadDistModule<typeof import('../src/lib/http.js')>('src/lib/http.js');
  assert.throws(
    () =>
      compiled.requireRemoteOkPayload(
        { ok: false, code: 'OWNER_CONFLICT', message: 'Owner changed' },
        'https://example.test',
      ),
    (error) => {
      assert.equal((error as { code: string }).code, 'OWNER_CONFLICT');
      assert.equal((error as { exitCode: number }).exitCode, 1);
      return true;
    },
  );
});

test('compiled Model source snapshots and default artifact layout retain their contracts', async () => {
  const compiled = await loadDistModule<
    typeof import('../src/lib/lifecyclemodel-resulting-process.js')
  >('src/lib/lifecyclemodel-resulting-process.js');
  const input = { lifeCycleModelDataSet: { exact: 'snapshot' } };
  const selected = compiled.__testInternals.loadSourceModel({
    source_model: { json_ordered: input },
  } as never);
  assert.deepEqual(selected.sourceModelJson, input);
  assert.notEqual(selected.sourceModelJson, input);
  assert.equal(selected.modelPath, null);
  const request = path.resolve('request.json');
  const output = compiled.__testInternals.defaultOutDir(
    request,
    'model',
    new Date('2026-11-10T00:00:00Z'),
  );
  assert.ok(output.startsWith(path.join(path.dirname(request), 'artifacts') + path.sep));
  assert.ok(output.includes('lifecyclemodel_resulting_process'));
});
