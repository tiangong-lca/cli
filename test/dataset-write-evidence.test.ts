import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { withMutationJournal } from '../src/adapters/private-mutation-journal.js';
import { executeDatasetWrite, type DatasetWritePorts } from '../src/application/dataset-write.js';
import { contentDigest } from '../src/application/dataset-content.js';
import { CommandInputError } from '../src/shared/command-result.js';
import { CliError } from '../src/shared/errors.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const id = '00000000-0000-4000-8000-000000000001';
const actor = '00000000-0000-4000-8000-000000000002';
const version = '00.00.001';
const environment = 'https://example.supabase.co';
const content = {
  contactDataSet: {
    contactInformation: { dataSetInformation: { 'common:UUID': id } },
    administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
  },
};
const request = {
  id,
  version,
  content,
  requestId: 'original',
  expectedActor: actor,
  expectedEnvironment: environment,
};
const env = buildSupabaseTestEnv({
  TIANGONG_LCA_AUTH_MODE: 'access-token',
  TEST_API_KEY: 'private-api-value',
  TEST_SHORT_KEY: 'true',
  TEST_EMPTY_KEY: '',
});

function directory(t: TestContext) {
  const value = mkdtempSync(path.join(os.tmpdir(), 'dataset-write-evidence-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

function fixture(
  t: TestContext,
  mode:
    'transport' | 'http' | 'failed-readback' | 'unequal-readback' | 'absent-readback' | 'success',
  preflightError?: unknown,
  stateDirectory = directory(t),
) {
  let writes = 0;
  const writer = datasetWriter(
    env,
    async (url, init) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
      if (init?.method === 'POST') {
        writes++;
        if (mode === 'transport')
          throw new Error(
            'Connection reset; Bearer lost-token; api-key: lost-key; Cookie: session=cookie-value',
          );
        if (mode === 'http')
          return new Response(
            JSON.stringify({ message: 'Bearer unsafe-body', authorization: 'secret-body' }),
            { status: 503 },
          );
        return new Response(
          JSON.stringify({
            ok: true,
            data: { id, version },
            token: 'unsafe-ack-token',
            headers: { authorization: 'unsafe-ack-header' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (writes && mode === 'failed-readback')
        throw new Error('Readback unavailable; Authorization: Bearer read-secret');
      return new Response(
        JSON.stringify(
          writes && !['http', 'absent-readback'].includes(mode)
            ? [
                {
                  id,
                  version,
                  user_id: actor,
                  state_code: 0,
                  json: mode === 'unequal-readback' ? { contactDataSet: {} } : content,
                },
              ]
            : [],
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    },
    stateDirectory,
    async () => {
      if (preflightError !== undefined) throw preflightError;
    },
  );
  const journal = path.join(stateDirectory, `${contentDigest(request.requestId)}.json`);
  return {
    writer,
    journal,
    stateDirectory,
    writes: () => writes,
    record: () => JSON.parse(readFileSync(journal, 'utf8')),
  };
}

function assertSafe(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [
    'lost-token',
    'lost-key',
    'cookie-value',
    'unsafe-body',
    'secret-body',
    'read-secret',
    'unsafe-ack-token',
    'unsafe-ack-header',
    'private-api-value',
  ])
    assert.ok(!text.includes(secret), `evidence leaked ${secret}`);
}

test('pre-dispatch failures preserve safe diagnostics without persisting rejection records', async (t) => {
  const failure = Object.assign(
    new CommandInputError(
      'REFERENCE_CHECK_FAILED',
      'Missing reference (true); Bearer lost-token; API_KEY=private-api-value',
    ),
    { details: { references: [{ path: '/reference', code: 'missing_version', version }] } },
  );
  const f = fixture(t, 'success', failure);
  const result = await f.writer('contact', 'create', request, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REFERENCE_CHECK_FAILED');
  assert.equal(result.data.stage, 'preflight');
  assert.equal(result.data.acknowledged, false);
  assert.deepEqual(result.data.readback, { available: false, contentMatchesIntent: false });
  assert.equal((result.data.diagnostic as JsonObject).category, 'precondition');
  assert.match(
    (result.data.diagnostic as JsonObject).message as string,
    /^Missing reference \(true\)/u,
  );
  assert.deepEqual(result.data.details, failure.details);
  assert.equal(f.writes(), 0);
  assert.equal(existsSync(f.journal), false);
  assertSafe([result]);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.stateDirectory).mode & 0o777, 0o700);
  }
  // Fixing the precondition lets the same requestId run cleanly instead of replaying service_rejected.
  const retryWriter = fixture(t, 'success', undefined, f.stateDirectory);
  const retry = await retryWriter.writer('contact', 'create', request, false);
  assert.equal(retry.status, 'completed');
  assert.notEqual(retry.outcome, 'service_rejected');
  assert.equal(retryWriter.writes(), 1);
  assert.equal(retryWriter.record().state, 'completed');
});

test('response loss retains dispatch diagnostics, HTTP status and readback facts without replay', async (t) => {
  for (const mode of ['transport', 'http'] as const) {
    const f = fixture(t, mode);
    const result = await f.writer('contact', 'create', request, false);
    assert.equal(result.error?.code, 'WRITE_OUTCOME_UNKNOWN');
    assert.equal(result.data.stage, 'dispatch');
    assert.equal(result.data.acknowledged, false);
    const diagnostic = result.data.diagnostic as JsonObject;
    assert.equal(
      diagnostic.code,
      mode === 'http' ? 'REMOTE_REQUEST_FAILED' : 'DATASET_WRITE_FAILED',
    );
    assert.equal(diagnostic.httpStatus, mode === 'http' ? 503 : undefined);
    if (mode === 'transport') assert.match(String(diagnostic.message), /Connection reset/u);
    assert.deepEqual(result.data.readback, {
      available: mode === 'transport',
      contentMatchesIntent: mode === 'transport',
      establishesRequestOutcome: false,
    });
    assert.deepEqual(f.record().diagnostic, diagnostic);
    assertSafe([result, f.record()]);
    const replay = await f.writer('contact', 'create', request, false);
    assert.deepEqual(replay.data.diagnostic, diagnostic);
    assert.equal(f.writes(), 1);
  }
});

test('failed, absent and unequal readbacks preserve service acknowledgement in journal and recovery results', async (t) => {
  for (const mode of ['failed-readback', 'unequal-readback', 'absent-readback'] as const) {
    const f = fixture(t, mode);
    const result = await f.writer('contact', 'create', request, false);
    assert.equal(result.status, 'unknown');
    assert.equal(result.data.stage, 'readback');
    assert.equal(result.data.acknowledged, true);
    assert.deepEqual(result.data.acknowledgement, {
      received: true,
      ok: true,
      data: { id, version },
    });
    assert.deepEqual(result.data.readback, {
      available: mode === 'unequal-readback',
      contentMatchesIntent: false,
      establishesRequestOutcome: false,
    });
    assert.equal(
      (result.data.diagnostic as JsonObject).code,
      mode === 'failed-readback' ? 'DATASET_READ_FAILED' : 'WRITE_READBACK_MISMATCH',
    );
    const record = f.record();
    assert.equal(record.state, 'unknown');
    assert.equal(record.acknowledged, true);
    assert.deepEqual(
      record.response,
      result.data.acknowledgement,
      'readback must not erase the service response',
    );
    assert.deepEqual(record.acknowledgement, result.data.acknowledgement);
    assert.deepEqual(record.diagnostic, result.data.diagnostic);
    assert.deepEqual(record.readback, {
      available: mode === 'unequal-readback',
      contentMatchesIntent: false,
    });
    const replay = await f.writer('contact', 'create', request, false);
    assert.deepEqual(replay.data.acknowledgement, result.data.acknowledgement);
    assert.deepEqual(replay.data.diagnostic, result.data.diagnostic);
    const renamed = await f.writer(
      'contact',
      'create',
      { ...request, requestId: 'renamed' },
      false,
    );
    assert.deepEqual(renamed.data.acknowledgement, result.data.acknowledgement);
    assert.deepEqual(renamed.data.diagnostic, result.data.diagnostic);
    assert.deepEqual(renamed.data.recovery, {
      journal: f.journal,
      requestId: request.requestId,
      replayAllowed: false,
    });
    assert.equal(renamed.status, 'unknown');
    assert.equal(f.writes(), 1);
    assertSafe([result, record, replay, renamed]);
  }
});

test('target tracking serializes different request IDs and isolates environment, actor, type, id and version', async (t) => {
  const stateDirectory = directory(t);
  const target = { environment, actor, type: 'contact', id, version };
  let dispatches = 0;
  const ports: DatasetWritePorts = {
    identity: async () => ({ environment, actor: { userId: actor } }),
    contentIdentity: () => ({ id, version }),
    read: async () => ({ environment, total: 0, records: [] }),
    qualify: async () => {},
    withJournal: (requestId, target, run) =>
      withMutationJournal({ directory: stateDirectory, requestId, target, scope: 'dataset' }, run),
    dispatch: async ({ beforeDispatch }) => {
      beforeDispatch();
      dispatches++;
      throw new Error('response lost');
    },
  };
  const results = await Promise.all(
    ['original', 'new-1', 'new-2'].map((requestId) =>
      executeDatasetWrite('contact', 'create', { ...request, requestId }, false, ports),
    ),
  );
  assert.equal(dispatches, 1);
  for (const result of results) {
    assert.equal(result.status, 'unknown');
    assert.equal((result.data.recovery as JsonObject).requestId, 'original');
  }
  const originalPath = path.join(stateDirectory, `${contentDigest('original')}.json`);
  const original = JSON.parse(readFileSync(originalPath, 'utf8'));
  assert.equal(original.state, 'unknown');
  for (const changed of [
    { environment: 'https://other.test' },
    { actor: 'other' },
    { type: 'source' },
    { id: 'other' },
    { version: '00.00.002' },
  ]) {
    await withMutationJournal(
      {
        directory: stateDirectory,
        requestId: JSON.stringify(changed),
        target: { ...target, ...changed },
        scope: 'dataset',
      },
      async (journal) => {
        assert.equal(journal.findTargetRecord!(['unknown', 'dispatched']), null);
      },
    );
  }
  for (const state of ['completed', 'rejected']) {
    writeFileSync(originalPath, JSON.stringify({ ...original, state }), { mode: 0o600 });
    let written = false;
    const result = await executeDatasetWrite(
      'contact',
      'create',
      { ...request, requestId: state },
      false,
      {
        ...ports,
        dispatch: async ({ beforeDispatch }) => {
          beforeDispatch();
          written = true;
          return { ok: true };
        },
        read: async () => ({
          environment,
          total: written ? 1 : 0,
          records: written
            ? [
                {
                  type: 'contact',
                  id,
                  version,
                  content,
                  owner: actor,
                  stateCode: 0,
                  modifiedAt: null,
                },
              ]
            : [],
        }),
        qualify: async () => {},
      },
    );
    // Check settlement through the real target index as well.
    await withMutationJournal(
      { directory: stateDirectory, requestId: `after-${state}`, target, scope: 'dataset' },
      async (journal) => assert.equal(journal.findTargetRecord!(['unknown', 'dispatched']), null),
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.outcome, 'dataset_written');
    assert.equal(written, true);
  }
  // A legacy dispatched record also blocks: an interrupted journal update is not replay authority.
  writeFileSync(originalPath, JSON.stringify({ ...original, state: 'dispatched' }), {
    mode: 0o600,
  });
  const result = await executeDatasetWrite(
    'contact',
    'create',
    { ...request, requestId: 'after-crash' },
    false,
    ports,
  );
  assert.equal(result.status, 'unknown');
  assert.equal(dispatches, 1);
});

test('unrelated exact target succeeds while an earlier target remains unknown', async (t) => {
  const stateDirectory = directory(t);
  let calls = 0;
  let current: JsonObject | null = null;
  const ports: DatasetWritePorts = {
    identity: async () => ({ environment, actor: { userId: actor } }),
    contentIdentity: () => ({ id, version }),
    read: async () => ({
      environment,
      total: current ? 1 : 0,
      records: current
        ? [
            {
              type: 'contact',
              id,
              version,
              content: current,
              owner: actor,
              stateCode: 0,
              modifiedAt: null,
            },
          ]
        : [],
    }),
    qualify: async () => {},
    withJournal: (requestId, target, run) =>
      withMutationJournal({ directory: stateDirectory, requestId, target, scope: 'dataset' }, run),
    dispatch: async ({ beforeDispatch }) => {
      beforeDispatch();
      calls++;
      if (calls === 1) throw new Error('lost');
      current = content;
      return { ok: true };
    },
  };
  assert.equal(
    (await executeDatasetWrite('contact', 'create', request, false, ports)).status,
    'unknown',
  );
  const other = await executeDatasetWrite(
    'source',
    'create',
    { ...request, content: { sourceDataSet: {} }, requestId: 'unrelated' },
    false,
    {
      ...ports,
      dispatch: async ({ beforeDispatch, content }) => {
        beforeDispatch();
        calls++;
        current = content;
        return { ok: true };
      },
    },
  );
  assert.equal(other.status, 'completed');
  assert.equal(calls, 2);
});

test('adapter diagnostics redact known credentials and normalize untrusted codes and non-Error failures', async (t) => {
  for (const error of [
    new CliError('private-api-value request failed', { code: 'bad code' }),
    'unsafe-body',
    new Error('Cookie: session=cookie-value'),
  ]) {
    const f = fixture(t, 'success', error);
    const result = await f.writer('contact', 'create', request, false);
    assert.equal(result.status, 'failed');
    assert.equal((result.data.diagnostic as JsonObject).code, 'DATASET_WRITE_FAILED');
    assert.equal(existsSync(f.journal), false);
    assertSafe([result]);
  }
});

test('legacy journals and minimal custom ports retain readback-only recovery and safe fallback diagnostics', async () => {
  let record: JsonObject | null = null;
  let readable = false;
  let readFails = false;
  let writes = 0;
  let response: unknown = null;
  const ports: DatasetWritePorts = {
    identity: async () => ({ environment, actor: { userId: actor } }),
    contentIdentity: () => ({ id, version }),
    read: async () => {
      if (readFails) throw new Error('read unavailable');
      return {
        environment,
        total: readable ? 1 : 0,
        records: readable
          ? [
              {
                type: 'contact',
                id,
                version,
                content,
                owner: actor,
                stateCode: 0,
                modifiedAt: null,
              },
            ]
          : [],
      };
    },
    qualify: async () => {},
    withJournal: async (_requestId, _target, run) =>
      run({
        path: 'legacy-private-journal',
        read: () => record,
        write: (value) => {
          record = value;
        },
      }),
    dispatch: async ({ beforeDispatch }) => {
      beforeDispatch();
      writes++;
      readable = true;
      return response;
    },
  };
  const first = await executeDatasetWrite('contact', 'create', request, false, ports);
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.data.acknowledgement, { received: true });
  const original = record as unknown as JsonObject;
  for (const available of [true, false]) {
    const legacy: JsonObject = { ...original, state: 'dispatched', response: null };
    for (const field of ['stage', 'acknowledged', 'acknowledgement', 'diagnostic', 'readback'])
      delete legacy[field];
    record = legacy;
    readable = available;
    const recovered = await executeDatasetWrite('contact', 'create', request, false, ports);
    assert.equal(recovered.status, 'unknown');
    assert.equal(recovered.data.stage, 'dispatch');
    assert.equal(recovered.data.acknowledged, false);
    assert.equal(recovered.data.diagnostic, undefined);
    assert.deepEqual(recovered.data.readback, {
      available,
      contentMatchesIntent: available,
      establishesRequestOutcome: false,
    });
    const other = await executeDatasetWrite(
      'contact',
      'create',
      { ...request, requestId: 'other' },
      false,
      {
        ...ports,
        withJournal: async (_requestId, _target, run) =>
          run({
            path: 'new-journal',
            read: () => null,
            write: () => {
              throw new Error('must not write');
            },
            findTargetRecord: () => ({ path: 'legacy-private-journal', record: record! }),
          }),
      },
    );
    assert.equal(other.status, 'unknown');
    assert.equal(other.data.stage, 'dispatch');
    assert.deepEqual(other.data.recovery, {
      requestId: request.requestId,
      journal: 'legacy-private-journal',
      replayAllowed: false,
    });
  }
  readFails = true;
  assert.equal(
    (await executeDatasetWrite('contact', 'create', request, false, ports)).status,
    'unknown',
  );
  assert.equal(writes, 1);
  readFails = false;
  record = null;
  readable = false;
  response = { unexpected: 'never retain raw service fields' };
  assert.equal(
    (await executeDatasetWrite('contact', 'create', request, false, ports)).status,
    'completed',
  );
  record = null;
  const failure = await executeDatasetWrite('contact', 'create', request, true, {
    ...ports,
    qualify: async () => {
      throw new CommandInputError('VALIDATION_REQUIRED', 'Local validation failed.');
    },
  });
  assert.equal(failure.error?.code, 'VALIDATION_REQUIRED');
  assert.equal(failure.data.stage, 'preflight');
  assert.equal(failure.completeness.dryRun, true);
});
