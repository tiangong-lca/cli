import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import {
  claimPrepareAttempt,
  prepareAttemptPath,
  readPrepareAttempt,
} from '../src/lib/dataset-prepare-draft-attempt.js';
import {
  createdPreparePayload,
  parsePrepareEnvelope,
  parsePrepareResult,
  prepareFail,
  prepareSelection,
  type PrepareEnvelope,
  type PrepareResult,
  type PrepareTable,
} from '../src/lib/dataset-prepare-draft-contract.js';
import {
  readPrepareCensus,
  readPrepareExact,
  requestPrepareBackend,
} from '../src/lib/dataset-prepare-draft-remote.js';
import {
  runDatasetPrepareDraft,
  type RunDatasetPrepareDraftOptions,
} from '../src/lib/dataset-prepare-draft-run.js';
import type { DatasetMaintenanceRemoteContext } from '../src/lib/dataset-maintenance-remote.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const ACTOR = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000003';
const FOREIGN = '00000000-0000-4000-8000-000000000004';
const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const ROOTS = {
  contacts: 'contactDataSet',
  sources: 'sourceDataSet',
  flows: 'flowDataSet',
  processes: 'processDataSet',
};
function payload(version: string, table: PrepareTable = 'processes'): Record<string, unknown> {
  return {
    [ROOTS[table]]: {
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
      science: { amount: '12', unit: 'kg' },
      ...(table === 'flows'
        ? { modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } } }
        : {}),
    },
  };
}
function envelope(table: PrepareTable = 'processes'): PrepareEnvelope {
  return parsePrepareEnvelope({
    schema_version: 'dataset-prepare-draft-request.v1',
    project_ref: 'example',
    requestId: REQUEST,
    request: {
      table,
      id: ID,
      expectedActorId: ACTOR,
      expectedDrafts: [],
      source: {
        version: '01.01.000',
        userId: ACTOR,
        stateCode: 100,
        jsonOrdered: payload('01.01.000', table),
      },
    },
  });
}
function row(version: string, overrides = {}, table: PrepareTable = 'processes') {
  return {
    id: ID,
    version,
    user_id: ACTOR,
    state_code: 0,
    json_ordered: payload(version, table),
    model_id: null,
    ...overrides,
  };
}
function response(
  body: unknown,
  status = 200,
  range: string | null = null,
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (key === 'content-range' ? range : 'application/json') },
    text: async () => JSON.stringify(body),
  };
}
function makeResult(input: PrepareEnvelope): PrepareResult {
  const req = input.request;
  const selected = prepareSelection(req.expectedDrafts, req.selectedVersion ?? null);
  const version = selected?.version ?? '01.01.001';
  return {
    requestId: input.requestId,
    table: req.table,
    id: req.id,
    actorId: req.expectedActorId,
    outcome:
      req.expectedDrafts.length === 0
        ? 'created'
        : req.expectedDrafts.length === 1
          ? 'reused'
          : 'selected',
    version,
    sourceVersion: req.source.version,
    draftVersions:
      req.expectedDrafts.length === 0 ? [version] : req.expectedDrafts.map((item) => item.version),
    selectedDraft: {
      version,
      userId: ACTOR,
      stateCode: 0,
      jsonOrdered: selected?.jsonOrdered ?? createdPreparePayload(req, version),
    },
    replayed: false,
  };
}
function fixture(table: PrepareTable = 'processes') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-prepare-draft-'));
  const env = buildSupabaseTestEnv({ XDG_STATE_HOME: path.join(dir, 'state') });
  const input = envelope(table);
  const source = row('01.01.000', { state_code: 100 }, table);
  const state: {
    drafts: ReturnType<typeof row>[];
    reviews: Array<ReturnType<typeof row> & { review_id: string | null }>;
    target: ReturnType<typeof row> | null;
    result: PrepareResult | null;
    mutations: number;
    lookups: number;
    reads: string[];
    drop: 'before' | 'after' | null;
    missingBackend: boolean;
    cap: number;
  } = {
    drafts: [],
    reviews: [],
    target: null,
    result: null,
    mutations: 0,
    lookups: 0,
    reads: [],
    drop: null,
    missingBackend: false,
    cap: 1000,
  };
  const fetchImpl: FetchLike = async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: ACTOR });
    if (url.endsWith('/app_dataset_prepare_stable_draft')) {
      state.mutations++;
      if (state.missingBackend) return response({ message: 'missing function' }, 404);
      if (state.drop === 'before') throw new Error('connection lost');
      const body = JSON.parse(String(init?.body)) as {
        requestId: string;
        request: PrepareEnvelope['request'];
      };
      state.result = makeResult({ ...input, ...body });
      state.target = row(state.result.version, {
        json_ordered: state.result.selectedDraft.jsonOrdered,
      });
      if (state.drop === 'after') throw new Error('connection lost after transaction');
      return response({ ok: true, command: 'dataset_prepare_stable_draft', data: state.result });
    }
    if (url.endsWith('/app_dataset_stable_draft_request')) {
      state.lookups++;
      if (state.missingBackend) return response({ message: 'missing function' }, 404);
      if (!state.result)
        return response(
          { ok: false, code: 'REQUEST_NOT_RECORDED', details: { requestId: REQUEST } },
          404,
        );
      const target = state.target
        ? {
            version: state.target.version,
            userId: state.target.user_id,
            stateCode: state.target.state_code,
            jsonOrdered: state.target.json_ordered,
          }
        : null;
      const equal = JSON.stringify(target) === JSON.stringify(state.result.selectedDraft);
      return response({
        ok: true,
        command: 'dataset_stable_draft_request',
        data: {
          recorded: true,
          result: state.result,
          currentDraft: target,
          targetStatus: equal ? 'unchanged' : target ? 'changed' : 'missing',
        },
      });
    }
    const parsed = new URL(url);
    state.reads.push(url);
    if (parsed.searchParams.has('state_code')) {
      const offset = Number(parsed.searchParams.get('offset'));
      const members =
        parsed.searchParams.get('state_code') === 'gte.20' ? state.reviews : state.drafts;
      const rows = members.slice(offset, offset + state.cap);
      return response(
        rows,
        200,
        rows.length ? `${offset}-${offset + rows.length - 1}/${members.length}` : '*/0',
      );
    }
    const version = parsed.searchParams.get('version')?.slice(3);
    return response(
      version === source.version
        ? [source]
        : state.target?.version === version
          ? [state.target]
          : [],
    );
  };
  const options: RunDatasetPrepareDraftOptions = {
    type: { contacts: 'contact', sources: 'source', flows: 'flow', processes: 'process' }[table],
    id: ID,
    sourceVersion: source.version,
    outDir: path.join(dir, 'out'),
    env,
    fetchImpl,
  };
  const write = (value: unknown = input) => {
    const file = path.join(dir, 'frozen.json');
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const frozen = (
    extra: Partial<RunDatasetPrepareDraftOptions> = {},
  ): RunDatasetPrepareDraftOptions => ({
    outDir: options.outDir,
    inputPath: extra.inputPath ?? write(),
    env,
    fetchImpl,
    ...extra,
  });
  const context: DatasetMaintenanceRemoteContext = {
    project_ref: 'example',
    rest_base_url: 'https://example.supabase.co/rest/v1',
    publishable_key: 'public-test-key',
    access_token: 'fake-token',
    account: { user_id: ACTOR, email: 'user@example.com', session_source: 'fixture' },
    fetch_impl: fetchImpl,
    timeout_ms: 10000,
  };
  return {
    dir,
    env,
    input,
    source,
    state,
    fetchImpl,
    options,
    write,
    frozen,
    context,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('prepare-draft public help and strict mode parsing have zero transport', async () => {
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '/tmp/.env', count: 0 },
    fetchImpl: async () => {
      throw new Error('must not transport');
    },
  };
  for (const args of [
    ['dataset', '--help'],
    ['dataset', 'prepare-draft', '--help'],
  ]) {
    const result = await executeCli(args, deps);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /prepare-draft/u);
  }
  const cases = [
    [],
    ['--bad'],
    ['--input', 'a', '--out-dir', 'b', '--commit', '--status-only'],
    ['--input', 'a', '--out-dir', 'b', '--type', 'process'],
    ['--type', 'process', '--out-dir', 'b'],
    [
      '--type',
      'process',
      '--id',
      ID,
      '--source-version',
      '01.01.000',
      '--out-dir',
      'b',
      '--commit',
    ],
    ['--input', '', '--out-dir', 'b'],
    ['--input', 'a', '--input=b', '--out-dir', 'b'],
    ['--status-only', '--input', 'a'],
    ['--out-dir', 'b'],
  ];
  for (const flags of cases)
    assert.equal(
      (await executeCli(['dataset', 'prepare-draft', ...flags], deps)).exitCode,
      2,
      JSON.stringify(flags),
    );
  const f = fixture();
  try {
    const result = await executeCli(
      [
        'dataset',
        'prepare-draft',
        '--type',
        'process',
        '--id',
        ID,
        '--source-version',
        '01.01.000',
        '--target-user-id',
        ACTOR,
        '--project-ref',
        'example',
        '--out-dir',
        f.options.outDir,
        '--json',
      ],
      { ...deps, env: f.env, fetchImpl: f.fetchImpl },
    );
    const unknown = await executeCli(
      [
        'dataset',
        'prepare-draft',
        '--input',
        f.write(),
        '--out-dir',
        path.join(f.dir, 'cli-status'),
        '--status-only',
        '--json',
      ],
      {
        ...deps,
        env: f.env,
        fetchImpl: f.fetchImpl,
        runDatasetPrepareDraftImpl: runDatasetPrepareDraft,
      },
    );
    assert.equal(unknown.exitCode, 1);
    assert.equal(JSON.parse(unknown.stdout).error.code, 'REQUEST_NOT_RECORDED');
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).status, 'needs_creation');
    assert.equal(f.state.mutations, 0);
    const conflict = await executeCli(
      [
        'dataset',
        'prepare-draft',
        '--input',
        f.write(),
        '--out-dir',
        f.options.outDir,
        '--status-only',
        '--selected-version',
        '01.01.001',
      ],
      { ...deps, env: f.env, fetchImpl: f.fetchImpl },
    );
    assert.equal(conflict.exitCode, 1);
  } finally {
    f.close();
  }
});

test('old backend read-only census observes zero, one, all capped conflicts and explicit selection', async () => {
  const f = fixture();
  try {
    f.state.missingBackend = true;
    const empty = await runDatasetPrepareDraft(f.options);
    assert.equal(empty.status, 'needs_creation');
    assert.equal(empty.attempt_consumed, false);
    assert.equal(f.state.mutations, 0);
    assert.equal(f.state.lookups, 0);
    assert.equal(existsSync(path.join(f.dir, 'state')), false);
    assert.equal(readFileSync(empty.files.request, 'utf8').includes('access-token'), false);
    f.options.outDir = path.join(f.dir, 'one');
    f.state.drafts = [row('01.01.001')];
    const one = await runDatasetPrepareDraft(f.options);
    assert.equal(one.status, 'selected');
    assert.equal(one.target?.version, '01.01.001');
    f.options.outDir = path.join(f.dir, 'many');
    f.state.drafts.push(row('01.01.002'), row('01.01.003'));
    f.state.cap = 1;
    const many = await runDatasetPrepareDraft(f.options);
    assert.equal(many.status, 'conflict');
    assert.equal(many.drafts?.length, 3);
    const chosen = await runDatasetPrepareDraft({
      ...f.options,
      outDir: path.join(f.dir, 'chosen'),
      selectedVersion: '01.01.001',
    });
    assert.equal(chosen.target?.version, '01.01.001');
    assert.equal(chosen.status, 'selected');
    const frozen = await runDatasetPrepareDraft(
      f.frozen({
        inputPath: f.write(many.request),
        outDir: path.join(f.dir, 'chosen2'),
        selectedVersion: '01.01.002',
      }),
    );
    assert.equal(frozen.target?.version, '01.01.002');
    const conflict = await runDatasetPrepareDraft(
      f.frozen({ inputPath: f.write(many.request), commit: true }),
    );
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.attempt_consumed, false);
    assert.equal(f.state.mutations, 0);
    assert.ok(f.state.reads.every((url) => !url.includes('/lifecyclemodels')));
  } finally {
    f.close();
  }
});

test('commit freezes created bytes and changing output directory cannot replay preparation', async () => {
  const f = fixture();
  try {
    const result = await runDatasetPrepareDraft(f.frozen({ commit: true }));
    assert.equal(result.status, 'prepared');
    assert.equal(result.mutation_dispatches, 1);
    assert.equal(f.state.mutations, 1);
    assert.deepEqual(
      result.target?.jsonOrdered,
      createdPreparePayload(f.input.request, '01.01.001'),
    );
    f.source.json_ordered = payload('09.09.999');
    const count = f.state.reads.length;
    const recovered = await runDatasetPrepareDraft(
      f.frozen({ commit: true, outDir: path.join(f.dir, 'another') }),
    );
    assert.equal(recovered.status, 'prepared');
    assert.equal(recovered.mutation_dispatches, 0);
    assert.equal(f.state.mutations, 1);
    assert.equal(f.state.reads.length, count + 2); // Review census and independent target; original source/draft selection are not reinterpreted.
    const readonly = await runDatasetPrepareDraft(f.frozen());
    assert.equal(readonly.status, 'unknown');
    assert.equal(readonly.target, null);
    assert.equal(f.state.mutations, 1);
    const drift = structuredClone(f.input);
    drift.request.source.jsonOrdered = { changed: true };
    await assert.rejects(
      runDatasetPrepareDraft(
        f.frozen({ inputPath: f.write(drift), outDir: path.join(f.dir, 'drift'), commit: true }),
      ),
      { code: 'REQUEST_ID_REUSED' },
    );
  } finally {
    f.close();
  }
});

test('lost response after commit recovers; unrecorded response is permanently read-only', async () => {
  for (const drop of ['before', 'after'] as const) {
    const f = fixture();
    try {
      f.state.drop = drop;
      const first = await runDatasetPrepareDraft(f.frozen({ commit: true }));
      assert.equal(first.status, drop === 'after' ? 'prepared' : 'unknown');
      assert.equal(first.attempt_consumed, true);
      const second = await runDatasetPrepareDraft(
        f.frozen({ commit: true, outDir: path.join(f.dir, 'second') }),
      );
      assert.equal(second.status, first.status);
      assert.equal(f.state.mutations, 1);
      assert.equal(second.mutation_dispatches, 0);
      const status = await runDatasetPrepareDraft(f.frozen({ statusOnly: true }));
      assert.equal(status.status, first.status);
      assert.equal(f.state.mutations, 1);
    } finally {
      f.close();
    }
  }
});

test('missing backend is explicit, consumes original attempt, and never falls back', async () => {
  const f = fixture();
  try {
    f.state.missingBackend = true;
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true }));
    assert.equal(report.status, 'capability_unavailable');
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_CAPABILITY_UNAVAILABLE');
    assert.equal(f.state.mutations, 1);
    await runDatasetPrepareDraft(f.frozen({ commit: true }));
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});

test('reused and explicitly selected drafts never save content; receipt follows fixed target', async () => {
  for (const count of [1, 2]) {
    const f = fixture();
    try {
      f.state.drafts = [row('01.01.001'), row('01.01.002')].slice(0, count);
      f.input.request.expectedDrafts = f.state.drafts.map((item) => ({
        version: item.version,
        jsonOrdered: item.json_ordered,
      }));
      const report = await runDatasetPrepareDraft(
        f.frozen({ commit: true, selectedVersion: '01.01.001' }),
      );
      assert.equal(report.status, 'prepared');
      assert.equal(report.receipt?.outcome, count === 1 ? 'reused' : 'selected');
      assert.equal(report.target?.version, '01.01.001');
      assert.equal(f.state.mutations, 1);
      f.state.target!.json_ordered = { science: 'changed after receipt' };
      const changed = await runDatasetPrepareDraft(
        f.frozen({ statusOnly: true, selectedVersion: '01.01.001' }),
      );
      assert.equal(changed.status, 'changed');
      assert.equal(changed.receipt?.version, '01.01.001');
      f.state.target = null;
      const missing = await runDatasetPrepareDraft(
        f.frozen({ statusOnly: true, selectedVersion: '01.01.001' }),
      );
      assert.equal(missing.status, 'changed');
      assert.equal(missing.target, null);
    } finally {
      f.close();
    }
  }
});

test('source/census/preimage drift and model/result guards fail before mutation', async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => {
      f.source.state_code = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.state_code = 120;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.model_id = ID as never;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.json_ordered = { changed: true } as never;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.drafts = [row('01.01.001')];
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.request.expectedDrafts = [{ version: '01.01.001', jsonOrdered: { old: true } }];
      f.state.drafts = [row('01.01.001')];
    },
  ];
  for (const alter of cases) {
    const f = fixture();
    try {
      alter(f);
      await assert.rejects(runDatasetPrepareDraft(f.frozen({ commit: true })));
      assert.equal(f.state.mutations, 0);
      assert.equal(existsSync(prepareAttemptPath(f.env, f.input)), false);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const opts = f.options;
    await assert.rejects(runDatasetPrepareDraft({ ...opts, type: 'lifecyclemodel' }), {
      code: 'INVALID_DATASET_TABLE',
    });
    await assert.rejects(runDatasetPrepareDraft({ ...opts, projectRef: 'other' }), {
      code: 'DATASET_ACTOR_MISMATCH',
    });
    await assert.rejects(runDatasetPrepareDraft({ ...opts, targetUserId: FOREIGN }), {
      code: 'DATASET_ACTOR_MISMATCH',
    });
    await assert.rejects(runDatasetPrepareDraft(f.frozen({ commit: true, statusOnly: true })));
    await assert.rejects(runDatasetPrepareDraft({ ...opts, commit: true }));
    await assert.rejects(runDatasetPrepareDraft(f.frozen({ id: ID })));
    const foreign = structuredClone(f.input);
    foreign.project_ref = 'other';
    await assert.rejects(runDatasetPrepareDraft(f.frozen({ inputPath: f.write(foreign) })), {
      code: 'DATASET_ACTOR_MISMATCH',
    });
    foreign.project_ref = 'example';
    foreign.request.expectedActorId = FOREIGN;
    await assert.rejects(runDatasetPrepareDraft(f.frozen({ inputPath: f.write(foreign) })), {
      code: 'DATASET_ACTOR_MISMATCH',
    });
    const link = path.join(f.dir, 'linked');
    symlinkSync(f.options.outDir, link);
    await assert.rejects(runDatasetPrepareDraft({ ...opts, outDir: link }));
  } finally {
    f.close();
  }
});

test('strict request parser rejects all malformed bindings and unsupported initial creation', () => {
  const base = envelope();
  const req = base.request;
  const bad = [
    null,
    [],
    { ...base, extra: true },
    { ...base, schema_version: 'other' },
    { ...base, project_ref: ' ' },
    { ...base, project_ref: 42 },
    { ...base, requestId: 'not-uuid' },
    { ...base, request: null },
    { ...base, request: { ...req, initialJsonOrdered: {} } },
    { ...base, request: { ...req, source: null } },
    { ...base, request: { ...req, source: { ...req.source, extra: true } } },
    { ...base, request: { ...req, source: { ...req.source, jsonOrdered: [] } } },
    { ...base, request: { ...req, source: { ...req.source, stateCode: 0 } } },
    { ...base, request: { ...req, source: { ...req.source, version: '1.1.1' } } },
    { ...base, request: { ...req, expectedDrafts: {} } },
    { ...base, request: { ...req, expectedDrafts: [{}] } },
    { ...base, request: { ...req, expectedDrafts: [{ version: '01.01.001', jsonOrdered: null }] } },
    {
      ...base,
      request: {
        ...req,
        expectedDrafts: [
          { version: '01.01.001', jsonOrdered: {} },
          { version: '01.01.001', jsonOrdered: {} },
        ],
      },
    },
    { ...base, request: { ...req, selectedVersion: '01.01.002' } },
    { ...base, request: { ...req, table: 'lifecyclemodels' } },
  ];
  for (const value of bad)
    assert.throws(
      () => parsePrepareEnvelope(value),
      () => true,
      JSON.stringify(value),
    );
  assert.equal(
    parsePrepareEnvelope({ ...base, request: { ...req, selectedVersion: undefined } }).request
      .selectedVersion,
    null,
  );
  const sorted = parsePrepareEnvelope({
    ...base,
    request: {
      ...req,
      selectedVersion: '01.01.001',
      expectedDrafts: [
        { version: '01.01.002', jsonOrdered: {} },
        { version: '01.01.001', jsonOrdered: {} },
      ],
    },
  });
  assert.equal(sorted.request.expectedDrafts[0]!.version, '01.01.001');
  assert.throws(() => prepareSelection([], '01.01.001'));
  assert.throws(() => prepareFail('test', 'TEST', { detail: true }));
});

test('receipt validates every bound dimension and prevents unexpected scientific changes', () => {
  const input = envelope();
  const valid = makeResult(input);
  assert.deepEqual(parsePrepareResult(valid, input), valid);
  const bad = [
    { ...valid, requestId: FOREIGN },
    { ...valid, table: 'flows' },
    { ...valid, id: FOREIGN },
    { ...valid, actorId: FOREIGN },
    { ...valid, sourceVersion: '01.00.000' },
    { ...valid, outcome: 'reused' },
    { ...valid, replayed: 1 },
    { ...valid, version: '01.01.000' },
    { ...valid, draftVersions: [] },
    { ...valid, selectedDraft: { ...valid.selectedDraft, version: '01.01.002' } },
    { ...valid, selectedDraft: { ...valid.selectedDraft, userId: FOREIGN } },
    { ...valid, selectedDraft: { ...valid.selectedDraft, stateCode: 100 } },
    { ...valid, selectedDraft: { ...valid.selectedDraft, jsonOrdered: {} } },
    { ...valid, extra: true },
  ];
  for (const value of bad) assert.throws(() => parsePrepareResult(value, input));
  input.request.expectedDrafts = [{ version: '01.01.001', jsonOrdered: {} }];
  const reused = makeResult(input);
  assert.equal(parsePrepareResult(reused, input).outcome, 'reused');
  assert.throws(() => parsePrepareResult({ ...reused, version: '01.01.002' }, input));
  input.request.expectedDrafts.push({ version: '01.01.002', jsonOrdered: {} });
  input.request.selectedVersion = '01.01.002';
  const selected = makeResult(input);
  assert.equal(parsePrepareResult(selected, input).outcome, 'selected');
  input.request.selectedVersion = null;
  assert.throws(() => parsePrepareResult(selected, input));
  for (const table of ['contacts', 'sources', 'flows', 'processes'] as const) {
    const req = envelope(table).request;
    for (const jsonOrdered of [
      {},
      { [ROOTS[table]]: {} },
      { [ROOTS[table]]: { administrativeInformation: {} } },
      payload('01.01.000', table),
    ]) {
      req.source.jsonOrdered = jsonOrdered;
      assert.match(
        JSON.stringify(createdPreparePayload(req, '01.01.001')),
        /common:permanentDataSetURI/u,
      );
    }
  }
});

test('global create-only attempt is private, hash-bound and race-safe', () => {
  const f = fixture();
  try {
    const file = prepareAttemptPath(f.env, f.input);
    assert.equal(readPrepareAttempt(file, f.input), false);
    assert.equal(claimPrepareAttempt(file, f.input, 'first'), true);
    assert.equal(claimPrepareAttempt(file, f.input, 'second'), false);
    assert.equal(readPrepareAttempt(file, f.input), true);
    const changed = structuredClone(f.input);
    changed.request.source.userId = FOREIGN;
    assert.throws(() => readPrepareAttempt(file, changed), { code: 'REQUEST_ID_REUSED' });
    chmodSync(file, 0o644);
    // Windows does not encode owner/group/other ACLs in these POSIX mode bits.
    if (process.platform === 'win32') assert.equal(readPrepareAttempt(file, f.input), true);
    else
      assert.throws(() => readPrepareAttempt(file, f.input), {
        code: 'DATASET_PREPARE_DRAFT_ATTEMPT_INVALID',
      });
    chmodSync(file, 0o600);
    const link = path.join(f.dir, 'link');
    symlinkSync(file, link);
    assert.throws(() => readPrepareAttempt(link, f.input));
    writeFileSync(file, '{}', { mode: 0o600 });
    assert.throws(() => readPrepareAttempt(file, f.input), { code: 'REQUEST_ID_REUSED' });
    assert.throws(() => claimPrepareAttempt(path.join(f.dir, 'x'.repeat(300)), f.input, 'out'));
  } finally {
    f.close();
  }
});

test('attempt permission policy preserves POSIX privacy and Windows read equality', () => {
  const f = fixture();
  const originalLstat = mutableFs.lstatSync;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const file = prepareAttemptPath(f.env, f.input);
    claimPrepareAttempt(file, f.input, 'first');
    const stat = originalLstat(file);
    for (const platform of ['linux', 'win32'] as const) {
      for (const mode of [0o600, 0o644]) {
        Object.assign(mutableFs, {
          lstatSync: ((target, options) =>
            target === file
              ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
                  mode: (stat.mode & ~0o777) | mode,
                })
              : originalLstat(target, options)) as typeof mutableFs.lstatSync,
        });
        syncBuiltinESMExports();
        Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
        if (platform === 'linux' && mode === 0o644)
          assert.throws(() => readPrepareAttempt(file, f.input), {
            code: 'DATASET_PREPARE_DRAFT_ATTEMPT_INVALID',
          });
        else assert.equal(readPrepareAttempt(file, f.input), true);
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.assign(mutableFs, { lstatSync: originalLstat });
    syncBuiltinESMExports();
    f.close();
  }
});

test('attempt durability follows platform policy and closes a failed directory flush without retry', async () => {
  for (const scenario of ['posix', 'windows', 'directory-flush-failure'] as const) {
    const f = fixture();
    const file = prepareAttemptPath(f.env, f.input);
    const parent = path.dirname(file);
    const directoryDescriptor = -372;
    const original = {
      openSync: mutableFs.openSync,
      writeFileSync: mutableFs.writeFileSync,
      fsyncSync: mutableFs.fsyncSync,
      closeSync: mutableFs.closeSync,
    };
    const events: string[] = [];
    let attemptDescriptor: number | undefined;
    try {
      mutableFs.openSync = ((target, flags, mode) => {
        if (target === parent && flags === 'r') {
          events.push('directory:open');
          return directoryDescriptor;
        }
        const descriptor = original.openSync(target, flags, mode);
        if (target === file) {
          assert.equal(flags, 'wx');
          assert.equal(mode, 0o600);
          attemptDescriptor = descriptor;
          events.push('attempt:open');
        }
        return descriptor;
      }) as typeof mutableFs.openSync;
      mutableFs.writeFileSync = ((target, data, options) => {
        if (target === attemptDescriptor) events.push('attempt:write');
        original.writeFileSync(target, data, options);
      }) as typeof mutableFs.writeFileSync;
      mutableFs.fsyncSync = (descriptor) => {
        if (descriptor === directoryDescriptor) {
          events.push('directory:fsync');
          if (scenario === 'directory-flush-failure') throw new Error('directory flush failed');
        } else {
          if (descriptor === attemptDescriptor) events.push('attempt:fsync');
          original.fsyncSync(descriptor);
        }
      };
      mutableFs.closeSync = (descriptor) => {
        if (descriptor === directoryDescriptor) events.push('directory:close');
        else {
          if (descriptor === attemptDescriptor) events.push('attempt:close');
          original.closeSync(descriptor);
        }
      };
      syncBuiltinESMExports();
      const claim = () =>
        claimPrepareAttempt(
          file,
          f.input,
          f.options.outDir!,
          scenario === 'windows' ? 'win32' : 'linux',
        );
      if (scenario === 'directory-flush-failure') assert.throws(claim, /directory flush failed/u);
      else assert.equal(claim(), true);
      assert.deepEqual(events, [
        'attempt:open',
        'attempt:write',
        'attempt:fsync',
        'attempt:close',
        ...(scenario === 'windows' ? [] : ['directory:open', 'directory:fsync', 'directory:close']),
      ]);
    } finally {
      Object.assign(mutableFs, original);
      syncBuiltinESMExports();
    }
    try {
      assert.equal(readPrepareAttempt(file, f.input), true);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).original_out_dir, f.options.outDir);
      if (scenario === 'directory-flush-failure') {
        const report = await runDatasetPrepareDraft(f.frozen({ commit: true }));
        assert.equal(report.status, 'unknown');
        assert.equal(report.save_ready, false);
        assert.equal(report.attempt_consumed, true);
        assert.equal(f.state.lookups, 1);
        assert.equal(f.state.mutations, 0);
      }
    } finally {
      f.close();
    }
  }
});

// Transport tests exercise actual response parsing and scoped query construction, not mock runners.
test('preparation remote requests reject malformed/foreign/partial rows and server failures', async () => {
  const f = fixture();
  try {
    const withBody = (body: unknown, status = 200, range: string | null = '0-0/1') => ({
      ...f.context,
      fetch_impl: async () => response(body, status, range),
    });
    for (const body of [
      null,
      {},
      [null],
      [row('01.01.001', { id: FOREIGN })],
      [row('01.01.001', { state_code: '0' })],
      [row('01.01.001', { json_ordered: [] })],
      [row('01.01.001', { model_id: 4 })],
      [row('01.01.001', { user_id: FOREIGN })],
      [row('01.01.001', { state_code: 100 })],
      [row('01.01.001', { model_id: ID })],
    ])
      await assert.rejects(readPrepareCensus(withBody(body), 'processes', ID));
    for (const table of ['contacts', 'sources', 'flows'] as const) {
      const result = await readPrepareCensus(
        withBody([{ ...row('01.01.001', {}, table), model_id: undefined }]),
        table,
        ID,
      );
      assert.equal(result.rows.length, 1);
    }
    await assert.rejects(
      readPrepareCensus(withBody([row('01.01.001')], 200, null), 'processes', ID),
    );
    await assert.rejects(
      readPrepareExact(
        withBody([row('01.01.001'), row('01.01.001')]),
        'processes',
        ID,
        '01.01.001',
      ),
    );
    await assert.rejects(
      readPrepareExact(withBody([row('01.01.002')]), 'processes', ID, '01.01.001'),
    );
    assert.equal(await readPrepareExact(withBody([]), 'processes', ID, '01.01.001'), null);
    for (const [body, status] of [
      [{ ok: false, code: 'DATASET_DRAFT_CENSUS_CHANGED', details: { versions: [] } }, 409],
      [{}, 500],
      [[], 500],
      [{}, 404],
      [null, 200],
      [{ ok: true, command: 'other', data: {} }, 200],
      [{ ok: true, command: 'dataset_prepare_stable_draft', data: null }, 200],
    ] as const)
      await assert.rejects(requestPrepareBackend(withBody(body, status), f.input, false));
    for (const status of [404, 200])
      await assert.rejects(
        requestPrepareBackend(
          {
            ...f.context,
            fetch_impl: async () => ({
              ...response(null, status),
              text: async () => 'invalid JSON',
            }),
          },
          f.input,
          false,
        ),
      );
    assert.equal(
      (await requestPrepareBackend(
        withBody({ ok: true, command: 'dataset_stable_draft_request', data: {} }),
        f.input,
        true,
      )) instanceof Object,
      true,
    );
  } finally {
    f.close();
  }
});

test('read-only recovery reports invalid receipts/current target disagreement without creating', async () => {
  const cases = [
    { recorded: false },
    { recorded: true, targetStatus: 'unknown' },
    { recorded: true, targetStatus: 'unchanged', result: {} },
    {
      recorded: true,
      targetStatus: 'unchanged',
      result: makeResult(envelope()),
      currentDraft: null,
    },
  ];
  for (const data of cases) {
    const f = fixture();
    try {
      f.state.target = row('01.01.001', {
        json_ordered: createdPreparePayload(f.input.request, '01.01.001'),
      });
      const base = f.fetchImpl;
      const fetchImpl: FetchLike = async (url, init) =>
        url.endsWith('/app_dataset_stable_draft_request')
          ? response({ ok: true, command: 'dataset_stable_draft_request', data })
          : base(url, init);
      const result = await runDatasetPrepareDraft(f.frozen({ statusOnly: true, fetchImpl }));
      assert.equal(result.status, 'unknown');
      assert.equal(f.state.mutations, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const result = await runDatasetPrepareDraft(
      f.frozen({
        statusOnly: true,
        fetchImpl: async (url, init) =>
          url.endsWith('/app_dataset_stable_draft_request')
            ? Promise.reject('non-Error failure')
            : f.fetchImpl(url, init),
      }),
    );
    assert.equal(result.error?.code, 'DATASET_PREPARE_DRAFT_TRANSPORT_UNKNOWN');
  } finally {
    f.close();
  }
});

test('public built bin observes old-backend state and uses one prepare plus read-only recovery', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const f = fixture();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const reply = await f.fetchImpl(`https://example.supabase.co${req.url}`, {
        method: req.method,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
      });
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      const range = reply.headers.get('content-range');
      if (range) res.setHeader('content-range', range);
      res.end(await reply.text());
    } catch {
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const env = buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `http://127.0.0.1:${address.port}/functions/v1`,
      XDG_STATE_HOME: path.join(f.dir, 'child-state'),
      TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:47832/oauth/callback',
      // Keep native-bin proof executing without merging its compiled function map into source coverage.
      NODE_V8_COVERAGE: '',
    });
    const bin = path.resolve('bin/tiangong-lca.js');
    const out = path.join(f.dir, 'public-read');
    const read = await exec(
      process.execPath,
      [
        bin,
        'dataset',
        'prepare-draft',
        '--type',
        'process',
        '--id',
        ID,
        '--source-version',
        '01.01.000',
        '--out-dir',
        out,
        '--json',
      ],
      { env, cwd: f.dir },
    );
    const observed = JSON.parse(read.stdout) as { status: string; files: { request: string } };
    assert.equal(observed.status, 'needs_creation');
    assert.equal(f.state.mutations, 0);
    assert.equal(f.state.lookups, 0);
    await assert.rejects(
      exec(
        process.execPath,
        [
          bin,
          'dataset',
          'prepare-draft',
          '--type',
          'process',
          '--id',
          'invalid-uuid',
          '--source-version',
          '01.01.000',
          '--out-dir',
          path.join(f.dir, 'invalid-public'),
        ],
        { env, cwd: f.dir },
      ),
    );
    const args = [
      bin,
      'dataset',
      'prepare-draft',
      '--input',
      observed.files.request,
      '--out-dir',
      path.join(f.dir, 'public-commit'),
      '--commit',
      '--json',
    ];
    const prepared = await exec(process.execPath, args, { env, cwd: f.dir });
    assert.equal(JSON.parse(prepared.stdout).status, 'prepared');
    assert.equal(f.state.mutations, 1);
    const status = await exec(
      process.execPath,
      [
        bin,
        'dataset',
        'prepare-draft',
        '--input',
        observed.files.request,
        '--out-dir',
        path.join(f.dir, 'public-recovery'),
        '--status-only',
        '--json',
      ],
      { env, cwd: f.dir },
    );
    assert.equal(JSON.parse(status.stdout).status, 'prepared');
    assert.equal(f.state.mutations, 1);
    if (process.env.TIANGONG_LCA_PREPARE_DRAFT_TEST_PROOF_DIR) {
      const { mkdirSync } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      const proofDir = process.env.TIANGONG_LCA_PREPARE_DRAFT_TEST_PROOF_DIR;
      mkdirSync(proofDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(proofDir, 'public-bin-proof.json'),
        JSON.stringify(
          {
            schema_version: 'dataset-prepare-draft-synthetic-public-bin-proof.v1',
            qualification: 'local HTTP fixture; not production deployment or data acceptance',
            node: { path: process.execPath, version: process.versions.node },
            bin,
            executable_sha256: createHash('sha256').update(readFileSync(bin)).digest('hex'),
            built_main_sha256: createHash('sha256')
              .update(readFileSync(path.resolve('dist/src/main.js')))
              .digest('hex'),
            observed: { exit_code: 0, ...read },
            prepared: { exit_code: 0, ...prepared },
            recovery: { exit_code: 0, ...status },
            actual_dispatches: {
              prepare_mutations: f.state.mutations,
              request_lookups: f.state.lookups,
              relation_reads: f.state.reads.length,
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    f.close();
  }
});

test('one directory preserves its exact original request and rejects overlapping scopes/runs', async () => {
  const f = fixture();
  try {
    const first = await runDatasetPrepareDraft(f.options);
    const bytes = readFileSync(first.files.request, 'utf8');
    const again = await runDatasetPrepareDraft(f.options);
    assert.equal(again.request.requestId, first.request.requestId);
    assert.equal(readFileSync(first.files.request, 'utf8'), bytes);
    await assert.rejects(runDatasetPrepareDraft({ ...f.options, id: FOREIGN }), {
      code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT',
    });
    await assert.rejects(runDatasetPrepareDraft(f.frozen()), {
      code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT',
    });
    assert.equal(readFileSync(first.files.request, 'utf8'), bytes);
    f.state.drafts = [row('01.01.001')];
    await assert.rejects(runDatasetPrepareDraft(f.options), {
      code: 'DATASET_PREPARE_DRAFT_OBSERVATION_CHANGED',
    });
    assert.equal(readFileSync(first.files.request, 'utf8'), bytes);
    const concurrentDir = path.join(f.dir, 'concurrent');
    let unlock!: () => void;
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const fetchImpl: FetchLike = async (url, init) => {
      observed();
      await held;
      return f.fetchImpl(url, init);
    };
    const running = runDatasetPrepareDraft({ ...f.options, outDir: concurrentDir, fetchImpl });
    await started;
    await assert.rejects(runDatasetPrepareDraft({ ...f.options, outDir: concurrentDir }));
    unlock();
    await running;
    assert.equal(f.state.mutations, 0);
  } finally {
    f.close();
  }
});

test('frozen input is rechecked after awaited observation and cannot be overwritten by artifacts', async () => {
  for (const at of ['auth', 'source', 'dispatch'] as const) {
    const f = fixture();
    try {
      const file = f.write();
      const changed = JSON.stringify({ ...f.input, project_ref: 'changed-on-disk' });
      let altered = false;
      const fetchImpl: FetchLike = async (url, init) => {
        const response = await f.fetchImpl(url, init);
        if (
          !altered &&
          ((at === 'auth' && url.endsWith('/auth/v1/user')) ||
            (at === 'source' && url.includes('version=eq.01.01.000')) ||
            (at === 'dispatch' && url.endsWith('/app_dataset_prepare_stable_draft')))
        ) {
          altered = true;
          writeFileSync(file, changed);
        }
        return response;
      };
      await assert.rejects(
        runDatasetPrepareDraft(f.frozen({ inputPath: file, fetchImpl, commit: true })),
        { code: 'DATASET_PREPARE_DRAFT_INPUT_CHANGED' },
      );
      assert.equal(readFileSync(file, 'utf8'), changed);
      assert.equal(f.state.mutations, at === 'dispatch' ? 1 : 0);
      if (at === 'dispatch')
        assert.equal(readPrepareAttempt(prepareAttemptPath(f.env, f.input), f.input), true);
    } finally {
      f.close();
    }
  }
});

test('frozen report/target input aliases fail before transport and preserve their original bytes', async () => {
  for (const name of ['report.json', 'target.json']) {
    for (const alias of [
      'direct',
      'parent',
      'relative',
      'hardlink',
      ...(process.platform === 'win32' ? ['default-stream', 'named-stream'] : []),
    ]) {
      for (const mode of ['read_only', 'commit', 'status_only']) {
        const f = fixture();
        try {
          mkdirSync(f.options.outDir!, { recursive: true });
          const inputPath = path.join(f.options.outDir!, name);
          const original = `${JSON.stringify(f.input, null, 2)}\n`;
          writeFileSync(inputPath, original);
          const aliasDir = path.join(f.dir, 'out-alias');
          const hardlinkPath = path.join(f.dir, 'frozen-hardlink.json');
          const streamPath = `${inputPath}:frozen-request`;
          if (alias === 'parent') symlinkSync(f.options.outDir!, aliasDir, 'junction');
          if (alias === 'hardlink') linkSync(inputPath, hardlinkPath);
          if (alias === 'named-stream') writeFileSync(streamPath, original);
          const selectedInput =
            alias === 'parent'
              ? path.join(aliasDir, name)
              : alias === 'relative'
                ? path.relative(process.cwd(), inputPath)
                : alias === 'hardlink'
                  ? hardlinkPath
                  : alias === 'default-stream'
                    ? `${inputPath}::$DATA`
                    : alias === 'named-stream'
                      ? streamPath
                      : inputPath;
          const selectedStat = statSync(selectedInput, { bigint: true });
          const outputStat = statSync(inputPath, { bigint: true });
          assert.equal(selectedStat.dev, outputStat.dev);
          assert.equal(selectedStat.ino, outputStat.ino);
          let transportCalls = 0;
          const fetchImpl: FetchLike = async (url, init) => {
            transportCalls++;
            return f.fetchImpl(url, init);
          };
          await assert.rejects(
            runDatasetPrepareDraft(
              f.frozen({
                inputPath: selectedInput,
                fetchImpl,
                commit: mode === 'commit',
                statusOnly: mode === 'status_only',
              }),
            ),
            { code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT' },
          );
          assert.equal(readFileSync(inputPath, 'utf8'), original);
          assert.equal(readFileSync(selectedInput, 'utf8'), original);
          assert.equal(transportCalls, 0);
          assert.equal(f.state.mutations, 0);
          assert.equal(f.state.lookups, 0);
          assert.equal(existsSync(prepareAttemptPath(f.env, f.input)), false);
          assert.equal(existsSync(path.join(f.options.outDir!, 'request.json')), false);
        } finally {
          f.close();
        }
      }
    }
  }
});

test('case aliases use physical identity while distinct case-sensitive files remain valid input', async () => {
  for (const name of ['report.json', 'target.json']) {
    for (const mode of ['read_only', 'commit', 'status_only']) {
      const f = fixture();
      try {
        mkdirSync(f.options.outDir!, { recursive: true });
        const outputPath = path.join(f.options.outDir!, name);
        const inputPath = path.join(f.options.outDir!, name.toUpperCase());
        const original = `${JSON.stringify(f.input, null, 2)}\n`;
        writeFileSync(outputPath, original);
        const caseAlias = existsSync(inputPath);
        if (!caseAlias) writeFileSync(inputPath, original);
        const outputStat = statSync(outputPath, { bigint: true });
        const inputStat = statSync(inputPath, { bigint: true });
        assert.equal(
          outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino,
          caseAlias,
        );
        let transportCalls = 0;
        const fetchImpl: FetchLike = async (url, init) => {
          transportCalls++;
          return f.fetchImpl(url, init);
        };
        const running = runDatasetPrepareDraft(
          f.frozen({
            inputPath,
            fetchImpl,
            commit: mode === 'commit',
            statusOnly: mode === 'status_only',
          }),
        );
        if (caseAlias) {
          await assert.rejects(running, { code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT' });
          assert.equal(transportCalls, 0);
          assert.equal(f.state.mutations, 0);
          assert.equal(f.state.lookups, 0);
          assert.equal(existsSync(prepareAttemptPath(f.env, f.input)), false);
          assert.equal(readFileSync(outputPath, 'utf8'), original);
        } else {
          const report = await running;
          assert.equal(
            report.status,
            mode === 'commit' ? 'prepared' : mode === 'status_only' ? 'unknown' : 'needs_creation',
          );
          assert.equal(f.state.mutations, mode === 'commit' ? 1 : 0);
        }
        assert.equal(readFileSync(inputPath, 'utf8'), original);
      } finally {
        f.close();
      }
    }
  }
});

test('the original request.json remains a supported frozen commit and recovery input', async () => {
  const f = fixture();
  try {
    const observed = await runDatasetPrepareDraft(f.options);
    const original = readFileSync(observed.files.request, 'utf8');
    const committed = await runDatasetPrepareDraft(
      f.frozen({ inputPath: observed.files.request, commit: true }),
    );
    assert.equal(committed.status, 'prepared');
    assert.equal(readFileSync(observed.files.request, 'utf8'), original);
    const recovered = await runDatasetPrepareDraft(
      f.frozen({ inputPath: observed.files.request, statusOnly: true }),
    );
    assert.equal(recovered.status, 'prepared');
    assert.equal(recovered.mutation_dispatches, 0);
    assert.equal(readFileSync(observed.files.request, 'utf8'), original);
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});

test('the reserved batch lock cannot consume or replace a valid frozen request', async () => {
  const f = fixture();
  try {
    mkdirSync(f.options.outDir!, { recursive: true });
    const inputPath = path.join(f.options.outDir!, '.tiangong-lca-batch-run.state.lock');
    const original = JSON.stringify(f.input);
    writeFileSync(inputPath, original);
    await assert.rejects(runDatasetPrepareDraft(f.frozen({ inputPath, commit: true })), {
      name: 'BatchRunLockTimeoutError',
    });
    assert.equal(readFileSync(inputPath, 'utf8'), original);
    assert.equal(f.state.mutations, 0);
    assert.equal(f.state.lookups, 0);
    assert.equal(existsSync(prepareAttemptPath(f.env, f.input)), false);
  } finally {
    f.close();
  }
});

test('an input switched to an output alias after await is rejected before claim or publication', async () => {
  for (const at of ['source', 'dispatch']) {
    const f = fixture();
    try {
      const inputPath = f.write();
      const original = readFileSync(inputPath, 'utf8');
      const outputPath = path.join(f.options.outDir!, 'report.json');
      let switched = false;
      const fetchImpl: FetchLike = async (url, init) => {
        const raw = await f.fetchImpl(url, init);
        if (
          !switched &&
          (at === 'source'
            ? url.includes('version=eq.01.01.000')
            : url.endsWith('/app_dataset_prepare_stable_draft'))
        ) {
          switched = true;
          writeFileSync(outputPath, original);
          unlinkSync(inputPath);
          symlinkSync(outputPath, inputPath);
        }
        return raw;
      };
      await assert.rejects(
        runDatasetPrepareDraft(f.frozen({ inputPath, fetchImpl, commit: true })),
        { code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT' },
      );
      assert.equal(readFileSync(inputPath, 'utf8'), original);
      assert.equal(readFileSync(outputPath, 'utf8'), original);
      assert.equal(f.state.mutations, at === 'dispatch' ? 1 : 0);
      assert.equal(existsSync(prepareAttemptPath(f.env, f.input)), at === 'dispatch');
    } finally {
      f.close();
    }
  }
});

test('validated prepare POST receipts survive failed or invalid lookup without a second dispatch', async () => {
  for (const failure of ['network', 'invalid_envelope', 'unrecorded', 'invalid_receipt']) {
    const f = fixture();
    try {
      let lookups = 0;
      const fetchImpl: FetchLike = async (url, init) => {
        if (url.endsWith('/app_dataset_stable_draft_request')) {
          lookups++;
          if (failure === 'network') throw new Error('lookup connection lost');
          if (failure === 'invalid_envelope') return response({ unexpected: 'envelope' });
          if (failure === 'unrecorded')
            return response({
              ok: true,
              command: 'dataset_stable_draft_request',
              data: { recorded: false },
            });
          const raw = await f.fetchImpl(url, init);
          const body = JSON.parse(await raw.text());
          body.data.result.actorId = FOREIGN;
          return response(body);
        }
        return f.fetchImpl(url, init);
      };
      const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
      assert.equal(report.status, 'unknown');
      assert.deepEqual(report.receipt, f.state.result);
      assert.equal(report.target, null);
      assert.equal(report.save_ready, false);
      assert.equal(report.attempt_consumed, true);
      assert.equal(report.mutation_dispatches, 1);
      assert.equal(lookups, 1);
      assert.ok(report.error);
      const stored = JSON.parse(readFileSync(report.files.report, 'utf8'));
      assert.deepEqual(stored.receipt, f.state.result);
      assert.equal(stored.target, null);
      assert.equal(stored.save_ready, false);
      const recovered = await runDatasetPrepareDraft(f.frozen({ commit: true }));
      assert.equal(recovered.status, 'prepared');
      assert.deepEqual(recovered.receipt, report.receipt);
      assert.equal(recovered.mutation_dispatches, 0);
      assert.equal(f.state.mutations, 1);
    } finally {
      f.close();
    }
  }
});

test('an invalid prepare POST receipt is not retained when lookup also fails', async () => {
  const f = fixture();
  try {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/app_dataset_stable_draft_request')) throw new Error('lookup unavailable');
      const raw = await f.fetchImpl(url, init);
      if (!url.endsWith('/app_dataset_prepare_stable_draft')) return raw;
      const body = JSON.parse(await raw.text());
      body.data.actorId = FOREIGN;
      return response(body);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'unknown');
    assert.equal(report.receipt, undefined);
    assert.equal(report.target, null);
    assert.equal(report.save_ready, false);
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_RECEIPT_INVALID');
    assert.ok(report.recovery_error);
    assert.equal(f.state.mutations, 1);
    assert.equal(report.mutation_dispatches, 1);
  } finally {
    f.close();
  }
});

test('a validated POST receipt cannot be replaced by a contradictory valid lookup receipt', async () => {
  const f = fixture();
  try {
    let originalReceipt: PrepareResult | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      const raw = await f.fetchImpl(url, init);
      if (url.endsWith('/app_dataset_prepare_stable_draft')) {
        originalReceipt = structuredClone(f.state.result!);
        return raw;
      }
      if (!url.endsWith('/app_dataset_stable_draft_request')) return raw;
      const body = JSON.parse(await raw.text());
      const receipt = body.data.result;
      receipt.version = '01.01.002';
      receipt.draftVersions = [receipt.version];
      receipt.selectedDraft.version = receipt.version;
      receipt.selectedDraft.jsonOrdered = createdPreparePayload(f.input.request, receipt.version);
      assert.equal(parsePrepareResult(receipt, f.input).version, '01.01.002');
      body.data.currentDraft = structuredClone(receipt.selectedDraft);
      f.state.target = row(receipt.version, { json_ordered: receipt.selectedDraft.jsonOrdered });
      return response(body);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'unknown');
    assert.deepEqual(report.receipt, originalReceipt);
    assert.equal(report.target, null);
    assert.equal(report.save_ready, false);
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_READBACK_MISMATCH');
    assert.equal(f.state.mutations, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(report.files.report, 'utf8')).receipt,
      originalReceipt,
    );
  } finally {
    f.close();
  }
});

test('POST replay context may differ from the immutable lookup receipt without changing its target', async () => {
  const f = fixture();
  try {
    const fetchImpl: FetchLike = async (url, init) => {
      const raw = await f.fetchImpl(url, init);
      if (!url.endsWith('/app_dataset_prepare_stable_draft')) return raw;
      const body = JSON.parse(await raw.text());
      body.data.replayed = true;
      return response(body);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'prepared');
    assert.deepEqual(report.receipt, { ...f.state.result, replayed: true });
    assert.deepEqual(report.target, f.state.result!.selectedDraft);
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});

test('a valid lookup can establish the outcome after an invalid POST receipt', async () => {
  const f = fixture();
  try {
    const fetchImpl: FetchLike = async (url, init) => {
      const raw = await f.fetchImpl(url, init);
      if (!url.endsWith('/app_dataset_prepare_stable_draft')) return raw;
      const body = JSON.parse(await raw.text());
      body.data.actorId = FOREIGN;
      return response(body);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'prepared');
    assert.deepEqual(report.receipt, f.state.result);
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_RECEIPT_INVALID');
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});

test('missing new RPC codes map to unavailable while structured complete conflicts remain reviewable', async () => {
  for (const code of [
    'PGRST202',
    '42883',
    'DATASET_DRAFT_CONFLICT',
    'DATASET_DRAFT_CENSUS_CHANGED',
  ]) {
    const f = fixture();
    try {
      const details =
        code === 'DATASET_DRAFT_CONFLICT'
          ? {
              draftVersions: ['01.01.001', '01.01.002'],
              drafts: [
                { version: '01.01.001', jsonOrdered: payload('01.01.001') },
                { version: '01.01.002', jsonOrdered: payload('01.01.002') },
              ],
            }
          : { draftVersions: ['01.01.001'] };
      const fetchImpl: FetchLike = async (url, init) =>
        url.endsWith('/app_dataset_prepare_stable_draft')
          ? response({ ok: false, code, details }, 503)
          : f.fetchImpl(url, init);
      const report = await runDatasetPrepareDraft(f.frozen({ fetchImpl, commit: true }));
      assert.equal(
        report.status,
        ['PGRST202', '42883'].includes(code)
          ? 'capability_unavailable'
          : code === 'DATASET_DRAFT_CONFLICT'
            ? 'conflict'
            : 'unknown',
      );
      assert.equal(report.attempt_consumed, true);
      assert.equal(report.recovery_error?.code, 'REQUEST_NOT_RECORDED');
      if (code.startsWith('DATASET_DRAFT_')) assert.deepEqual(report.error?.details, details);
      const stored = JSON.parse(readFileSync(report.files.report, 'utf8')) as {
        error: { details?: unknown };
      };
      assert.deepEqual(stored.error.details, report.error?.details);
    } finally {
      f.close();
    }
  }
});

test('Elementary and untyped Flow sources/drafts remain reference-only before claim or dispatch', async () => {
  for (const type of ['Elementary flow', '', null, 'Product flow', 'Waste flow']) {
    const input = envelope('flows');
    const root = input.request.source.jsonOrdered.flowDataSet as Record<string, unknown>;
    root.modellingAndValidation = type === null ? null : { LCIMethod: { typeOfDataSet: type } };
    if (type === 'Product flow' || type === 'Waste flow')
      assert.equal(parsePrepareEnvelope(input).request.table, 'flows');
    else assert.throws(() => parsePrepareEnvelope(input), { code: 'DATASET_REFERENCE_ONLY' });
  }
  const missingRoot = envelope('flows');
  missingRoot.request.source.jsonOrdered = {};
  assert.throws(() => parsePrepareEnvelope(missingRoot), { code: 'DATASET_REFERENCE_ONLY' });
  const f = fixture();
  try {
    const input = envelope('flows');
    const invalid = {
      flowDataSet: { modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } } },
    };
    input.request.expectedDrafts = [{ version: '01.01.001', jsonOrdered: invalid }];
    await assert.rejects(
      runDatasetPrepareDraft(f.frozen({ inputPath: f.write(input), commit: true })),
      { code: 'DATASET_REFERENCE_ONLY' },
    );
    assert.equal(f.state.mutations, 0);
    assert.equal(existsSync(prepareAttemptPath(f.env, input)), false);
    await assert.rejects(
      readPrepareExact(
        {
          ...f.context,
          fetch_impl: async () =>
            response([row('01.01.001', { json_ordered: invalid })], 200, '0-0/1'),
        },
        'flows',
        ID,
        '01.01.001',
      ),
      { code: 'DATASET_REFERENCE_ONLY' },
    );
  } finally {
    f.close();
  }
});

test('missing exact source, unsafe artifacts, and late artifact races fail before admission', async () => {
  const f = fixture();
  try {
    await assert.rejects(runDatasetPrepareDraft({ ...f.options, outDir: '' }));
    const base = f.fetchImpl;
    await assert.rejects(
      runDatasetPrepareDraft({
        ...f.options,
        fetchImpl: async (url, init) =>
          url.includes('version=eq.01.01.000') ? response([]) : base(url, init),
      }),
      { code: 'DATASET_SOURCE_NOT_FOUND' },
    );
    const out = path.join(f.dir, 'linked-artifact');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(out);
    symlinkSync(f.write(), path.join(out, 'request.json'));
    await assert.rejects(runDatasetPrepareDraft({ ...f.options, outDir: out }), {
      code: 'DATASET_PREPARE_DRAFT_OUTPUT_INVALID',
    });
    for (const [key, value] of [
      ['sourceVersion', '01.01.001'],
      ['selectedVersion', '01.01.001'],
      ['projectRef', 'other'],
      ['targetUserId', FOREIGN],
    ] as const) {
      const first = await runDatasetPrepareDraft({
        ...f.options,
        outDir: path.join(f.dir, 'fenced'),
      });
      await assert.rejects(
        runDatasetPrepareDraft({
          ...f.options,
          outDir: path.dirname(first.files.request),
          [key]: value,
        }),
        { code: 'DATASET_PREPARE_DRAFT_OUTPUT_CONFLICT' },
      );
    }
    for (const mode of ['different_request', 'directory', 'missing_parent'] as const) {
      const outDir = path.join(f.dir, mode);
      let changed = false;
      const fetchImpl: FetchLike = async (url, init) => {
        const answer = await base(url, init);
        if (!changed && url.includes('version=eq.01.01.000')) {
          changed = true;
          const file = path.join(outDir, 'request.json');
          if (mode === 'directory') mkdirSync(file);
          else if (mode === 'missing_parent') {
            rmSync(outDir, { recursive: true });
            writeFileSync(outDir, 'not a directory');
          } else writeFileSync(file, JSON.stringify({ ...f.input, requestId: FOREIGN }));
        }
        return answer;
      };
      await assert.rejects(runDatasetPrepareDraft(f.frozen({ outDir, commit: true, fetchImpl })));
      assert.equal(f.state.mutations, 0);
    }
  } finally {
    f.close();
  }
});

test('Flow conflicts remain complete while explicit Product selection excludes reference-only writes', () => {
  const input = envelope('flows');
  const product = { version: '01.01.001', jsonOrdered: payload('01.01.001', 'flows') };
  const elementary = {
    version: '01.01.002',
    jsonOrdered: {
      flowDataSet: { modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } } },
    },
  };
  input.request.expectedDrafts = [product, elementary];
  assert.equal(parsePrepareEnvelope(input).request.expectedDrafts.length, 2);
  input.request.selectedVersion = product.version;
  assert.equal(parsePrepareEnvelope(input).request.selectedVersion, product.version);
  input.request.selectedVersion = elementary.version;
  assert.throws(() => parsePrepareEnvelope(input), { code: 'DATASET_REFERENCE_ONLY' });
});

test('a prepared target entering a model/result or elementary domain cannot read back as prepared', async () => {
  for (const table of ['processes', 'flows'] as const) {
    const f = fixture(table);
    try {
      const first = await runDatasetPrepareDraft(f.frozen({ commit: true }));
      assert.equal(first.status, 'prepared');
      if (table === 'processes') f.state.target!.model_id = ID as never;
      else
        f.state.target!.json_ordered = {
          flowDataSet: {
            modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } },
          },
        };
      const fetchImpl: FetchLike = async (url, init) => {
        const result = await f.fetchImpl(url, init);
        if (!url.endsWith('/app_dataset_stable_draft_request')) return result;
        const body = JSON.parse(await result.text());
        body.data.targetStatus = 'changed';
        body.data.currentDraft = null;
        return response(body);
      };
      const report = await runDatasetPrepareDraft(f.frozen({ statusOnly: true, fetchImpl }));
      assert.equal(report.status, 'changed');
      assert.deepEqual(report.receipt, first.receipt);
      assert.equal(report.save_ready, false);
      assert.equal(report.target, null);
      assert.equal(
        report.error?.code,
        table === 'processes' ? 'LIFECYCLEMODEL_BUNDLE_REQUIRED' : 'DATASET_REFERENCE_ONLY',
      );
      assert.equal(f.state.mutations, 1);
    } finally {
      f.close();
    }
  }
});

test('complete review census blocks zero-draft preparation and returns exact original review points', async () => {
  const f = fixture();
  try {
    f.state.cap = 1;
    f.state.reviews = [
      { ...row('01.01.001', { state_code: 20 }), review_id: REQUEST },
      { ...row('01.01.002', { state_code: 50 }), review_id: null },
      { ...row('01.01.003', { state_code: 99 }), review_id: FOREIGN },
    ];
    const observed = await runDatasetPrepareDraft(f.options);
    assert.equal(observed.status, 'review_conflict');
    assert.equal(observed.target, null);
    assert.equal(observed.save_ready, false);
    assert.deepEqual(
      observed.reviews.map((point) => [
        point.table,
        point.id,
        point.version,
        point.userId,
        point.stateCode,
        point.reviewId,
      ]),
      [
        ['processes', ID, '01.01.001', ACTOR, 20, REQUEST],
        ['processes', ID, '01.01.002', ACTOR, 50, null],
        ['processes', ID, '01.01.003', ACTOR, 99, FOREIGN],
      ],
    );
    assert.equal(observed.error?.code, 'DATASET_REVIEW_IN_PROGRESS');
    const committed = await runDatasetPrepareDraft(
      f.frozen({
        inputPath: observed.files.request,
        outDir: path.join(f.dir, 'review-commit'),
        commit: true,
      }),
    );
    assert.equal(committed.status, 'review_conflict');
    assert.equal(committed.mutation_dispatches, 0);
    assert.equal(committed.attempt_consumed, false);
    assert.equal(f.state.mutations, 0);
    assert.equal(existsSync(prepareAttemptPath(f.env, observed.request)), false);
    f.state.drafts = [row('01.01.004')];
    const withDraft = await runDatasetPrepareDraft({
      ...f.options,
      outDir: path.join(f.dir, 'review-and-draft'),
    });
    assert.equal(withDraft.status, 'review_conflict');
    assert.equal(withDraft.drafts?.length, 1);
    assert.equal(withDraft.target, null);
  } finally {
    f.close();
  }
});

test('prepared target entering review retains original receipt but cannot authorize another draft or save', async () => {
  const f = fixture();
  try {
    const prepared = await runDatasetPrepareDraft(f.frozen({ commit: true }));
    assert.equal(prepared.status, 'prepared');
    f.state.target!.state_code = 20;
    f.state.reviews = [{ ...f.state.target!, review_id: REQUEST }];
    const status = await runDatasetPrepareDraft(f.frozen({ statusOnly: true }));
    assert.equal(status.status, 'review_conflict');
    assert.equal(status.receipt?.requestId, REQUEST);
    assert.equal(status.target, null);
    assert.equal(status.save_ready, false);
    const unavailableCurrent: FetchLike = async (url, init) => {
      if (new URL(url).searchParams.get('version') === 'eq.01.01.001')
        throw new Error('review target read unavailable');
      return f.fetchImpl(url, init);
    };
    const retained = await runDatasetPrepareDraft(
      f.frozen({ statusOnly: true, fetchImpl: unavailableCurrent }),
    );
    assert.equal(retained.status, 'review_conflict');
    assert.deepEqual(retained.receipt, prepared.receipt);
    assert.equal(retained.error?.code, 'DATASET_REVIEW_IN_PROGRESS');
    assert.ok(retained.recovery_error);
    assert.equal(retained.target, null);
    const retried = await runDatasetPrepareDraft(
      f.frozen({ commit: true, outDir: path.join(f.dir, 'other-review') }),
    );
    assert.equal(retried.status, 'review_conflict');
    assert.equal(retried.mutation_dispatches, 0);
    assert.equal(f.state.mutations, 1);
    f.state.result = null;
    const unknown = await runDatasetPrepareDraft(f.frozen({ statusOnly: true }));
    assert.equal(unknown.status, 'review_conflict');
    assert.equal(unknown.recovery_error?.code, 'REQUEST_NOT_RECORDED');
  } finally {
    f.close();
  }
});

test('review race server response preserves complete fenced return points without hidden retry', async () => {
  const f = fixture();
  try {
    const details = {
      table: 'processes',
      id: ID,
      reviews: [
        {
          table: 'processes',
          id: ID,
          version: '01.01.001',
          userId: ACTOR,
          stateCode: 20,
          reviewId: REQUEST,
        },
      ],
    };
    const fetchImpl: FetchLike = async (url, init) =>
      url.endsWith('/app_dataset_prepare_stable_draft')
        ? response({ ok: false, code: 'DATASET_REVIEW_IN_PROGRESS', details }, 409)
        : f.fetchImpl(url, init);
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'conflict');
    assert.deepEqual(report.error?.details, details);
    assert.equal(report.mutation_dispatches, 1);
    assert.equal(report.attempt_consumed, true);
    const again = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(again.mutation_dispatches, 0);
  } finally {
    f.close();
  }
});

test('review census rejects incomplete, foreign and out-of-range rows; UUID shape follows existing TIDAS', async () => {
  const { readPrepareReviews } = await import('../src/lib/dataset-prepare-draft-remote.js');
  const f = fixture();
  try {
    for (const review of [
      null,
      { id: FOREIGN, version: '01.01.001', user_id: ACTOR, state_code: 20, review_id: null },
      { id: ID, version: '01.01.001', user_id: FOREIGN, state_code: 20, review_id: null },
      { id: ID, version: '01.01.001', user_id: ACTOR, state_code: 19, review_id: null },
      { id: ID, version: '01.01.001', user_id: ACTOR, state_code: 100, review_id: null },
      { id: ID, version: '01.01.001', user_id: ACTOR, state_code: 20.5, review_id: null },
      { id: ID, version: '01.01.001', user_id: ACTOR, state_code: 20, review_id: 'not-uuid' },
    ]) {
      await assert.rejects(
        readPrepareReviews(
          { ...f.context, fetch_impl: async () => response([review], 200, '0-0/1') },
          'processes',
          ID,
        ),
      );
    }
    const input = envelope();
    input.request.id = '00000000-0000-7000-0000-000000000007';
    assert.equal(parsePrepareEnvelope(input).request.id, input.request.id);
  } finally {
    f.close();
  }
});

test('frozen first commit returns fresh review points when its selected draft entered review', async () => {
  const f = fixture();
  try {
    const originalDraft = row('01.01.001');
    f.state.drafts = [originalDraft];
    const observation = await runDatasetPrepareDraft(f.options);
    assert.equal(observation.status, 'selected');
    const originalRequestBytes = readFileSync(observation.files.request, 'utf8');
    f.state.drafts = [];
    f.state.reviews = [{ ...originalDraft, state_code: 20, review_id: REQUEST }];
    const report = await runDatasetPrepareDraft({
      inputPath: observation.files.request,
      outDir: f.options.outDir,
      commit: true,
      env: f.env,
      fetchImpl: f.fetchImpl,
    });
    assert.equal(report.status, 'review_conflict');
    assert.equal(report.error?.code, 'DATASET_REVIEW_IN_PROGRESS');
    assert.deepEqual(report.reviews, [
      {
        table: 'processes',
        id: ID,
        version: '01.01.001',
        userId: ACTOR,
        stateCode: 20,
        reviewId: REQUEST,
      },
    ]);
    assert.deepEqual(report.request, observation.request);
    assert.equal(readFileSync(observation.files.request, 'utf8'), originalRequestBytes);
    assert.equal(report.target, null);
    assert.equal(report.save_ready, false);
    assert.equal(report.attempt_consumed, false);
    assert.equal(report.mutation_dispatches, 0);
    assert.equal(f.state.mutations, 0);
    assert.equal(f.state.lookups, 0);
    assert.equal(existsSync(prepareAttemptPath(f.env, observation.request)), false);
    const stored = JSON.parse(readFileSync(report.files.report, 'utf8'));
    assert.deepEqual(stored.error.details.reviews, report.reviews);
  } finally {
    f.close();
  }
});

test('validated receipt survives independent current-target network and response failures', async () => {
  for (const failure of ['network', 'invalid_current', 'invalid_status'] as const) {
    const f = fixture();
    try {
      const original = await runDatasetPrepareDraft(f.frozen({ commit: true }));
      assert.equal(original.status, 'prepared');
      const fetchImpl: FetchLike = async (url, init) => {
        if (failure === 'invalid_status' && url.endsWith('/app_dataset_stable_draft_request')) {
          const raw = await f.fetchImpl(url, init);
          const body = JSON.parse(await raw.text());
          body.data.targetStatus = 'unrecognized-status';
          return response(body);
        }
        const parsed = new URL(url);
        if (
          failure !== 'invalid_status' &&
          parsed.pathname.endsWith('/processes') &&
          parsed.searchParams.get('version') === 'eq.01.01.001'
        ) {
          if (failure === 'network') throw new Error('independent current-target read failed');
          return response({ unexpected: 'not an exact row array' });
        }
        return f.fetchImpl(url, init);
      };
      const report = await runDatasetPrepareDraft(f.frozen({ statusOnly: true, fetchImpl }));
      assert.equal(report.status, 'unknown');
      assert.deepEqual(report.receipt, original.receipt);
      assert.equal(report.target, null);
      assert.equal(report.save_ready, false);
      assert.equal(report.mutation_dispatches, 0);
      assert.equal(f.state.mutations, 1);
      assert.ok(report.error);
    } finally {
      f.close();
    }
  }
});

test('invalid receipt is never retained even if its current-target response would match', async () => {
  const f = fixture();
  try {
    await runDatasetPrepareDraft(f.frozen({ commit: true }));
    let currentReads = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/app_dataset_stable_draft_request')) {
        const raw = await f.fetchImpl(url, init);
        const body = JSON.parse(await raw.text());
        body.data.result.actorId = FOREIGN;
        return response(body);
      }
      if (new URL(url).searchParams.get('version') === 'eq.01.01.001') currentReads++;
      return f.fetchImpl(url, init);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ statusOnly: true, fetchImpl }));
    assert.equal(report.status, 'unknown');
    assert.equal(report.receipt, undefined);
    assert.equal(currentReads, 0);
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_RECEIPT_INVALID');
    assert.equal(report.target, null);
    assert.equal(report.save_ready, false);
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});

test('validated receipt remains immutable when a current target becomes a Result or unknown Flow', async () => {
  for (const table of ['processes', 'flows'] as const) {
    const f = fixture(table);
    try {
      const original = await runDatasetPrepareDraft(f.frozen({ commit: true }));
      if (table === 'processes') f.state.target!.state_code = 120;
      else
        f.state.target!.json_ordered = {
          flowDataSet: { modellingAndValidation: { LCIMethod: { typeOfDataSet: 'unknown' } } },
        };
      const fetchImpl: FetchLike = async (url, init) => {
        const raw = await f.fetchImpl(url, init);
        if (!url.endsWith('/app_dataset_stable_draft_request')) return raw;
        const body = JSON.parse(await raw.text());
        body.data.currentDraft = null;
        body.data.targetStatus = 'changed';
        return response(body);
      };
      const report = await runDatasetPrepareDraft(f.frozen({ statusOnly: true, fetchImpl }));
      assert.equal(report.status, 'changed');
      assert.deepEqual(report.receipt, original.receipt);
      assert.equal(report.target, null);
      assert.equal(report.save_ready, false);
      assert.equal(
        report.error?.code,
        table === 'processes' ? 'LIFECYCLEMODEL_BUNDLE_REQUIRED' : 'DATASET_REFERENCE_ONLY',
      );
      assert.equal(f.state.mutations, 1);
    } finally {
      f.close();
    }
  }
});

test('lost prepare response plus unavailable current read retains its validated receipt without replay', async () => {
  const f = fixture();
  try {
    f.state.drop = 'after';
    const fetchImpl: FetchLike = async (url, init) => {
      if (new URL(url).searchParams.get('version') === 'eq.01.01.001')
        throw new Error('current read unavailable after lost response');
      return f.fetchImpl(url, init);
    };
    const report = await runDatasetPrepareDraft(f.frozen({ commit: true, fetchImpl }));
    assert.equal(report.status, 'unknown');
    assert.deepEqual(report.receipt, f.state.result);
    assert.equal(report.target, null);
    assert.equal(report.save_ready, false);
    assert.equal(report.attempt_consumed, true);
    assert.equal(report.error?.code, 'DATASET_PREPARE_DRAFT_TRANSPORT_UNKNOWN');
    assert.ok(report.recovery_error);
    const recovered = await runDatasetPrepareDraft(f.frozen({ statusOnly: true }));
    assert.equal(recovered.status, 'prepared');
    assert.deepEqual(recovered.receipt, report.receipt);
    assert.equal(recovered.mutation_dispatches, 0);
    assert.equal(f.state.mutations, 1);
  } finally {
    f.close();
  }
});
