import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { batchRunLockPath } from '../src/batch.js';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import { runDatasetSaveDraft, __testInternals } from '../src/lib/dataset-save-draft-run.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  identitySaveFixture,
  fact,
  write,
  type Obj,
} from './helpers/flow-identity-admission-fixture.js';

function report(result: { stdout: string; stderr: string; exitCode: number }) {
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout) as {
    counts: Record<string, number>;
    rows: Array<Obj>;
    files: { execution_ledger: string };
  };
}
function events(root: string): Obj[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).flatMap((entry) => {
    const file = path.join(root, String(entry));
    return file.endsWith('.events.jsonl')
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Obj)
      : [];
  });
}
const familyReads = (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
  f.calls.filter(({ url }) => url.searchParams.get('id')?.startsWith('in.')).length;

test('public Waste identity prepares offline, dry-runs, inserts once and recovers consumed readback', async (t) => {
  const f = await identitySaveFixture(t, { flowType: 'Waste flow' });
  assert.equal(f.calls.length, 0, 'Waste preparation uses local artifacts only.');
  const dryRun = await f.invoke();
  assert.equal(dryRun.exitCode, 0, dryRun.stderr || dryRun.stdout);
  assert.equal(report(dryRun).counts.prepared, 1);
  assert.equal(report(dryRun).counts.attempts_consumed, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(events(path.join(f.root, 'state')).length, 0);
  const first = await f.invoke(true);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const value = report(first);
  assert.equal(value.counts.executed, 1);
  assert.equal(value.counts.attempts_consumed, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0]!.jsonOrdered, f.target);
  const ledger = events(value.files.execution_ledger);
  assert.equal(ledger.length, 2);
  assertLedgerChain(ledger);
  assert.deepEqual(ledger[0]!.identity_admission, value.rows[0]!.identity_admission);
  assert.deepEqual(ledger[1]!.identity_observation, value.rows[0]!.identity_observation);
  const reads = familyReads(f);
  const recovered = await f.invoke(true);
  assert.equal(recovered.exitCode, 0, recovered.stderr || recovered.stdout);
  assert.equal(report(recovered).counts.executed, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(familyReads(f), reads, 'Consumed Waste admission cannot renew candidate reads.');
  assert.deepEqual(events(value.files.execution_ledger), ledger);
  assert.deepEqual(
    report(recovered).rows[0]!.identity_observation,
    value.rows[0]!.identity_observation,
  );
});

test('public Waste hybrid preparation and save retain typed search and exact hydration fences', async (t) => {
  const f = await identitySaveFixture(t, { flowType: 'Waste flow' });
  const coverage = JSON.parse(fs.readFileSync(f.files.coverage!, 'utf8')) as Obj;
  const original = (coverage.queries as Obj[])[0]!;
  const snapshots = original.snapshots as Obj[];
  const snapshot = snapshots[0]!;
  coverage.queries = [
    {
      kind: 'flow_hybrid_search',
      query: 'Synthetic Waste soil identity',
      filter: { flowType: 'Waste flow', asInput: false },
      data_source: 'tg',
      match_count: 10,
      page_size: 10,
      match_threshold: 0,
      lexical_weight: 0.5,
      semantic_weight: 0.5,
      rrf_k: 60,
      total_count: 1,
      snapshots,
    },
  ];
  write(f.files.coverage!, coverage);
  f.review.coverage.file = fact(f.files.coverage!);
  write(f.files.review!, f.review);
  const prepared = await f.prepare();
  assert.equal(prepared.exitCode, 0, prepared.stderr || prepared.stdout);
  Object.assign(f.preparation, JSON.parse(prepared.stdout));
  const response = (value: unknown, range: string | null = null) => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-range' ? range : null) },
    text: async () => JSON.stringify(value),
  });
  let searches = 0,
    hydrations = 0;
  f.controls.responseOverride = (url) => {
    if (url.pathname.endsWith('/flow_hybrid_search')) {
      searches += 1;
      return response({ data: [{ id: snapshot.id, version: snapshot.version, total_count: 1 }] });
    }
    if (
      url.pathname.endsWith('/flows') &&
      url.searchParams.get('id') === `eq.${snapshot.id as string}`
    ) {
      hydrations += 1;
      assert.equal(
        url.searchParams.get(
          'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet',
        ),
        'eq.Waste flow',
      );
      assert.match(url.searchParams.get('and')!, /state_code.gte.100,state_code.lt.200/u);
      return response(
        [
          {
            id: snapshot.id,
            version: snapshot.version,
            state_code: 100,
            user_id: null,
            json: f.candidate,
          },
        ],
        '0-0/1',
      );
    }
    return undefined;
  };
  f.deps.fetchImpl = async (url, init) => {
    if (String(url).includes('/flow_hybrid_search')) {
      assert.deepEqual(JSON.parse(String(init?.body)).filter, {
        flowType: 'Waste flow',
        asInput: false,
      });
    }
    return f.fetchImpl(url, init);
  };
  const result = await f.invoke(true);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(report(result).counts.executed, 1);
  assert.equal(f.writes.length, 1);
  assert.ok(searches >= 2);
  assert.equal(hydrations, searches);
});

for (const behavior of ['lost_before_write', 'lost_after_write'] as const) {
  test(`Waste ${behavior} consumes one attempt and recovers after expiry without replay`, async (t) => {
    const f = await identitySaveFixture(t, { flowType: 'Waste flow' });
    f.controls.behavior = behavior;
    const first = await f.invoke(true);
    const value = report(first);
    const outcome = behavior === 'lost_after_write' ? 'executed' : 'unknown';
    assert.equal(first.exitCode, behavior === 'lost_after_write' ? 0 : 1);
    assert.equal(value.counts[outcome], 1);
    assert.equal(value.counts.attempts_consumed, 1);
    assert.equal(f.writes.length, 1);
    const ledger = events(value.files.execution_ledger);
    assertLedgerChain(ledger);
    const reads = familyReads(f);
    const recovered = await runDatasetSaveDraft({
      inputPath: f.files.rows!,
      type: 'flow',
      outDir: path.join(f.root, 'expired-waste-recovery'),
      commit: true,
      executionContractPath: f.preparation.files.execution_contract,
      executionContractSha256: f.preparation.execution_contract_sha256,
      env: f.env,
      fetchImpl: f.fetchImpl,
      identityAdmissionClock: () => new Date(f.expires.getTime() + 1),
    });
    assert.equal(recovered.counts[outcome], 1);
    assert.equal(recovered.counts.attempts_consumed, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(familyReads(f), reads);
    assert.deepEqual(events(value.files.execution_ledger), ledger);
    assert.deepEqual(recovered.rows[0]!.identity_observation, value.rows[0]!.identity_observation);
  });
}

for (const flowType of ['Product flow', 'Waste flow'] as const) {
  for (const kind of ['flow_family', 'flow_hybrid_search'] as const) {
    test(`public prepare rejects ${flowType} ${kind} snapshot/filter mismatch before auth or artifacts`, async (t) => {
      const f = await identitySaveFixture(t, { flowType });
      const coverage = JSON.parse(fs.readFileSync(f.files.coverage!, 'utf8')) as Obj;
      const original = (coverage.queries as Obj[])[0]!;
      const oppositeType = flowType === 'Waste flow' ? 'Product flow' : 'Waste flow';
      coverage.queries = [
        kind === 'flow_family'
          ? { ...original, type_of_dataset: oppositeType }
          : {
              kind,
              query: 'Synthetic soil identity',
              filter: { flowType: oppositeType, asInput: false },
              data_source: 'tg',
              match_count: 10,
              page_size: 10,
              match_threshold: 0,
              lexical_weight: 0.5,
              semantic_weight: 0.5,
              rrf_k: 60,
              total_count: 1,
              snapshots: original.snapshots,
            },
      ];
      write(f.files.coverage!, coverage);
      f.review.coverage.file = fact(f.files.coverage!);
      write(f.files.review!, f.review);
      const before = fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-'));
      const result = await f.prepare();
      assert.equal(result.exitCode, 2, result.stdout);
      assert.match(result.stderr, /FLOW_IDENTITY_COVERAGE_INVALID/u);
      assert.match(result.stderr, /snapshot violated the exact identity, query Flow type/u);
      assert.deepEqual(
        fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-')),
        before,
      );
      assert.equal(f.calls.length, 0);
      assert.equal(f.writes.length, 0);
      assert.equal(events(path.join(f.root, 'state')).length, 0);
    });
  }
}

for (const flowType of ['Product flow', 'Waste flow'] as const) {
  test(`public prepare requires coverage of its ${flowType} target before auth or artifacts`, async (t) => {
    const f = await identitySaveFixture(t, { flowType });
    const coverage = JSON.parse(fs.readFileSync(f.files.coverage!, 'utf8')) as Obj;
    const query = (coverage.queries as Obj[])[0]!;
    query.type_of_dataset = flowType === 'Waste flow' ? 'Product flow' : 'Waste flow';
    query.snapshots = [];
    write(f.files.coverage!, coverage);
    f.review.coverage.file = fact(f.files.coverage!);
    write(f.files.review!, f.review);
    const before = fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-'));
    const result = await f.prepare();
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /Coverage needs a query for the target Flow type/u);
    assert.deepEqual(
      fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-')),
      before,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
  });
}

for (const subject of ['target', 'candidate'] as const) {
  test(`public prepare excludes an Elementary ${subject} before auth or artifacts`, async (t) => {
    const f = await identitySaveFixture(t);
    const payload = subject === 'target' ? f.target : f.candidate;
    (payload.flowDataSet.modellingAndValidation.LCIMethod as Obj).typeOfDataSet = 'Elementary flow';
    write(f.files.input!, f.input);
    const before = fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-'));
    const result = await f.prepare();
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /FLOW_IDENTITY_ADMISSION_INVALID/u);
    assert.match(result.stderr, /complete Product or Waste Flow payload/u);
    assert.deepEqual(
      fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-')),
      before,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
  });
}

test('public identity prepare binds actual Agent raw evidence and dry-run produces no attempt', async (t) => {
  const f = await identitySaveFixture(t);
  assert.equal(f.calls.length, 0, 'Preparation uses local artifacts only.');
  const receipt = JSON.parse(fs.readFileSync(f.preparation.files.receipt, 'utf8')) as Obj;
  assert.equal((receipt.review as Obj).sha256, fact(f.files.review!).sha256);
  assert.equal(f.review.reviewer.report.sha256, fact(f.files.science!).sha256);
  assert.equal(f.review.reviewer.kind, 'agent');
  const result = await f.invoke();
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const value = report(result);
  assert.equal(value.counts.prepared, 1);
  assert.equal(value.counts.attempts_consumed, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  assert.equal(
    (value.rows[0]!.identity_admission as Obj).contract_sha256,
    f.preparation.execution_contract_sha256,
  );
  assert.ok(familyReads(f) >= 1);
});

test('public admitted Flow commit persists original-ledger evidence and recovers through exact readback', async (t) => {
  const f = await identitySaveFixture(t);
  const first = await f.invoke(true);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const value = report(first);
  assert.equal(value.counts.executed, 1);
  assert.equal(value.counts.attempts_consumed, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0]!.jsonOrdered, f.target);
  const ledger = events(value.files.execution_ledger);
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger[0]!.identity_admission, value.rows[0]!.identity_admission);
  assert.equal(ledger[0]!.contract_sha256, f.preparation.execution_contract_sha256);
  const reads = familyReads(f);
  const recovered = await f.invoke(true);
  assert.equal(recovered.exitCode, 0, recovered.stderr || recovered.stdout);
  assert.equal(f.writes.length, 1);
  assert.equal(familyReads(f), reads, 'A consumed attempt must not renew candidate admission.');
  assert.deepEqual(
    report(recovered).rows[0]!.identity_admission,
    value.rows[0]!.identity_admission,
  );
  assert.equal(events(value.files.execution_ledger).length, 2);
  assert.deepEqual(
    report(recovered).rows[0]!.identity_observation,
    value.rows[0]!.identity_observation,
  );
  const observation = value.rows[0]!.identity_observation as Obj;
  assert.equal(observation.query_count, 1);
  assert.equal(observation.candidate_count, 1);
  assert.equal(observation.scope, 'bounded_visible_search');
  assert.equal(
    observation.coverage_sha256,
    (ledger[0]!.identity_observation as Obj).coverage_sha256,
  );
  assert.deepEqual(ledger[1]!.identity_observation, observation);
  assert.ok(Number.isFinite(Date.parse(String(observation.observed_at_utc))));
});

for (const [name, mutate] of Object.entries({
  receipt: (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.preparation.files.receipt, ' '),
  contract: (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.preparation.files.execution_contract, ' '),
  'Agent report': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.science!, '\n'),
  'standing authorization': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.authority!, '\n'),
  'original preflight source': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.input!, '\n'),
  'saved preflight': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.preflight!, '\n'),
  'review raw bytes': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.review!, '\n'),
  'coverage source': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    fs.appendFileSync(f.files.coverage!, '\n'),
  'desired payload': (f: Awaited<ReturnType<typeof identitySaveFixture>>) =>
    write(f.files.rows!, [{ ...f.target, changed: true }]),
})) {
  test(`public identity save rejects ${name} drift without consuming an attempt`, async (t) => {
    const f = await identitySaveFixture(t);
    mutate(f);
    const result = await f.invoke(true);
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
  });
}

for (const field of ['owner.email', 'action_id']) {
  test(`public prepare rejects padded ${field} before issuing an unusable contract`, async (t) => {
    const f = await identitySaveFixture(t);
    const template = JSON.parse(fs.readFileSync(f.files.template!, 'utf8')) as Obj;
    if (field === 'owner.email') {
      const owner = template.owner as Obj;
      owner.email = ` ${owner.email as string} `;
    } else {
      const action = (template.actions as Obj[])[0]!;
      action.action_id = `\t${action.action_id as string}\n`;
    }
    write(f.files.template!, template);
    const preparedDirectories = fs
      .readdirSync(f.root)
      .filter((entry) => entry.startsWith('prepared-'));
    const result = await f.prepare();
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /FLOW_IDENTITY_ADMISSION_INVALID/u);
    assert.deepEqual(
      fs.readdirSync(f.root).filter((entry) => entry.startsWith('prepared-')),
      preparedDirectories,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('current family body drift fails before mutation and every public candidate read is fenced', async (t) => {
  const f = await identitySaveFixture(t);
  f.controls.candidate = { ...f.candidate, changed: true };
  const result = await f.invoke(true);
  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  assert.equal(report(result).counts.failed, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(events(path.join(f.root, 'state')).length, 0);
  assert.equal(familyReads(f), 1);
});

test('v2 requires the host-fixed SHA and v1 rejects the v2-only hash option', async (t) => {
  const f = await identitySaveFixture(t);
  for (const [contract, hash] of [
    [f.preparation.files.execution_contract, undefined],
    [f.preparation.files.execution_contract, '0'.repeat(64)],
    [f.files.template!, f.preparation.execution_contract_sha256],
  ]) {
    const args = [
      'dataset',
      'save-draft',
      '--input',
      f.files.rows!,
      '--type',
      'flow',
      '--execution-contract',
      contract!,
      '--commit',
      '--json',
      '--out-dir',
      path.join(f.root, `bad-${String(hash)}`),
    ];
    if (hash) args.push('--execution-contract-sha256', hash);
    const result = await executeCli(args, f.deps);
    assert.notEqual(result.exitCode, 0, result.stdout);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(events(path.join(f.root, 'state')).length, 0);
});

for (const behavior of ['lost_before_write', 'lost_after_write'] as const) {
  test(`${behavior} consumes at most one mutation and resumes by readback only`, async (t) => {
    const f = await identitySaveFixture(t);
    f.controls.behavior = behavior;
    const first = await f.invoke(true);
    const value = report(first);
    assert.equal(f.writes.length, 1);
    assert.equal(value.counts.attempts_consumed, 1);
    assert.equal(first.exitCode, behavior === 'lost_after_write' ? 0 : 1);
    assert.equal(value.counts[behavior === 'lost_after_write' ? 'executed' : 'unknown'], 1);
    const reads = familyReads(f);
    const recovered = await f.invoke(true);
    assert.equal(recovered.exitCode, first.exitCode, recovered.stderr || recovered.stdout);
    assert.equal(f.writes.length, 1);
    assert.equal(familyReads(f), reads);
    assert.equal(
      report(recovered).counts[behavior === 'lost_after_write' ? 'executed' : 'unknown'],
      1,
    );
  });
}

test('same-operation concurrent public commits share one exclusive consumed attempt', async (t) => {
  const f = await identitySaveFixture(t);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const writing = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.controls.onRequest = async (url) => {
    if (url.pathname === '/functions/v1/app_dataset_create') {
      observed();
      await paused;
    }
  };
  const first = f.invoke(true);
  const early = await Promise.race([writing.then(() => null), first]);
  assert.equal(early, null, early?.stderr || early?.stdout);
  const second = await f.invoke(true);
  release();
  const primary = await first;
  assert.equal(primary.exitCode, 0, primary.stderr || primary.stdout);
  assert.notEqual(second.exitCode, 0, second.stdout);
  assert.equal(f.writes.length, 1);
  const ledger = events(report(primary).files.execution_ledger);
  assert.equal(ledger.filter((event) => event.event_type === 'attempt_emitted').length, 1);
  assert.equal(ledger.filter((event) => event.event_type === 'outcome').length, 1);
  assertLedgerChain(ledger);
  const third = await f.invoke(true);
  assert.equal(third.exitCode, 0, third.stderr || third.stdout);
  assert.equal(report(third).counts.executed, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(events(report(primary).files.execution_ledger), ledger);
});

test('expiry after an awaited candidate read prevents a new dispatch; expired consumed attempts recover', async (t) => {
  const f = await identitySaveFixture(t);
  let current = new Date(f.expires.getTime() - 1);
  f.controls.onRequest = async (url) => {
    if (url.searchParams.get('id')?.startsWith('in.')) {
      await Promise.resolve();
      current = new Date(f.expires);
    }
  };
  const late = await runDatasetSaveDraft({
    inputPath: f.files.rows!,
    type: 'flow',
    outDir: path.join(f.root, 'late'),
    commit: true,
    executionContractPath: f.preparation.files.execution_contract,
    executionContractSha256: f.preparation.execution_contract_sha256,
    env: f.env,
    fetchImpl: f.fetchImpl,
    identityAdmissionClock: () => current,
  });
  assert.equal(late.counts.failed, 1);
  assert.equal(late.counts.attempts_consumed, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(events(path.join(f.root, 'state')).length, 0);
  f.controls.onRequest = undefined;
  const committed = await f.invoke(true);
  assert.equal(committed.exitCode, 0, committed.stderr || committed.stdout);
  const reads = familyReads(f);
  const recovered = await runDatasetSaveDraft({
    inputPath: f.files.rows!,
    type: 'flow',
    outDir: path.join(f.root, 'expired-recovery'),
    commit: true,
    executionContractPath: f.preparation.files.execution_contract,
    executionContractSha256: f.preparation.execution_contract_sha256,
    env: f.env,
    fetchImpl: f.fetchImpl,
    identityAdmissionClock: () => new Date(f.expires.getTime() + 1),
  });
  assert.equal(recovered.counts.executed, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(familyReads(f), reads);
});

test('identity prepare public help and invalid inputs perform no authentication or remote calls', async () => {
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '/tmp/no-env', count: 0 },
    fetchImpl: async () => {
      throw new Error('Local preparation must not fetch.');
    },
  };
  for (const args of [[], ['--help'], ['-h'], ['prepare', '--help']]) {
    const result = await executeCli(['flow', 'identity-admission', ...args], deps);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /bounded coverage/u);
  }
  for (const args of [
    ['unsupported'],
    ['prepare'],
    ['prepare', '--input', ' '],
    ['prepare', '--input', 'a', '--input=b'],
    ['prepare', '--unknown'],
    ['prepare', 'unexpected'],
    [
      'prepare',
      '--input',
      'a',
      '--preflight',
      'b',
      '--review',
      'c',
      '--coverage',
      'd',
      '--execution-contract',
      'e',
    ],
  ]) {
    const result = await executeCli(['flow', 'identity-admission', ...args], deps);
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /INVALID_ARGS/u);
  }
});

test('public save rejects duplicate host hashes before any remote access', async () => {
  const result = await executeCli(
    [
      'dataset',
      'save-draft',
      '--execution-contract-sha256',
      'a',
      '--execution-contract-sha256=b',
      '--json',
    ],
    {
      env: {},
      dotEnvStatus: { loaded: false, path: '/tmp/no-env', count: 0 },
      fetchImpl: async () => {
        throw new Error('Invalid arguments must not fetch.');
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /exactly one original execution contract hash/u);
});

for (const drift of ['review', 'payload', 'candidate'] as const) {
  test(`asynchronous final predispatch ${drift} drift emits zero attempts`, async (t) => {
    const f = await identitySaveFixture(t);
    let family = 0;
    f.controls.onRequest = async (url) => {
      if (url.searchParams.get('id')?.startsWith('in.') && ++family === 2) {
        await Promise.resolve();
        if (drift === 'review') fs.appendFileSync(f.files.science!, ' changed');
        if (drift === 'payload') write(f.files.rows!, [{ ...f.target, changed: true }]);
        if (drift === 'candidate') f.controls.candidate = { ...f.candidate, changed: true };
      }
    };
    const result = await f.invoke(true);
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.equal(family, 2);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
    assert.match(result.stderr, /BEFORE_DISPATCH_FAILED/u);
  });
}

test('consumed original operation cannot acquire a new attempt by omitting the admission profile', async (t) => {
  const f = await identitySaveFixture(t);
  const first = await f.invoke(true);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const previous = events(report(first).files.execution_ledger);
  const omitted = await executeCli(
    [
      'dataset',
      'save-draft',
      '--input',
      f.files.rows!,
      '--type',
      'flow',
      '--execution-contract',
      f.files.template!,
      '--out-dir',
      path.join(f.root, 'omitted'),
      '--commit',
      '--json',
    ],
    f.deps,
  );
  assert.notEqual(omitted.exitCode, 0, omitted.stdout);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(events(report(first).files.execution_ledger), previous);
});

test('public reuse review emits an exact existing identity without a receipt or insert contract', async (t) => {
  const f = await identitySaveFixture(t);
  write(f.files.review!, {
    ...f.review,
    decision: 'reuse',
    reuse_identity: {
      id: f.review.candidate_decisions[0]!.id,
      version: f.review.candidate_decisions[0]!.version,
    },
    candidate_decisions: f.review.candidate_decisions.map((candidate) => ({
      ...candidate,
      decision: 'reuse',
    })),
  });
  const result = await f.prepare();
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout) as Obj;
  assert.equal(value.status, 'no_new_insert');
  assert.deepEqual(value.reuse_identity, {
    id: f.review.candidate_decisions[0]!.id,
    version: f.review.candidate_decisions[0]!.version,
  });
  assert.equal((value.files as Obj).receipt, null);
  assert.equal((value.files as Obj).execution_contract, null);
  assert.equal(value.execution_contract_sha256, null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

for (const stage of ['reference', 'target'] as const) {
  test(`expiry during final awaited ${stage} verification prevents durable consumption`, async (t) => {
    const f = await identitySaveFixture(t);
    let current = new Date(f.expires.getTime() - 1);
    let family = 0;
    let expired = false;
    f.controls.onRequest = async (url) => {
      if (url.searchParams.get('id')?.startsWith('in.')) family += 1;
      if (
        family === 2 &&
        (stage === 'reference'
          ? url.pathname.endsWith('/sources')
          : url.pathname.endsWith('/flows') && url.searchParams.get('id')?.startsWith('eq.'))
      ) {
        await Promise.resolve();
        current = new Date(f.expires);
        expired = true;
      }
    };
    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: f.files.rows!,
          type: 'flow',
          outDir: path.join(f.root, `late-${stage}`),
          commit: true,
          executionContractPath: f.preparation.files.execution_contract,
          executionContractSha256: f.preparation.execution_contract_sha256,
          env: f.env,
          fetchImpl: f.fetchImpl,
          identityAdmissionClock: () => current,
        }),
      { code: 'DATASET_COMMAND_BEFORE_DISPATCH_FAILED' },
    );
    assert.equal(expired, true);
    assert.equal(family, 2);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
  });
}

test('consumed dry-run reports retained evidence without new candidate reads or mutation', async (t) => {
  const f = await identitySaveFixture(t);
  const first = await f.invoke(true);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const reads = familyReads(f);
  const dryRun = await f.invoke();
  assert.equal(dryRun.exitCode, 1, dryRun.stderr || dryRun.stdout);
  const value = report(dryRun);
  assert.equal(value.counts.attempts_consumed, 1);
  assert.equal(value.counts.prepared, 0);
  assert.equal(value.rows[0]!.operation, 'retained_outcome');
  assert.deepEqual(value.rows[0]!.identity_admission, report(first).rows[0]!.identity_admission);
  assert.equal(f.writes.length, 1);
  assert.equal(familyReads(f), reads);
});

for (const [name, mutate] of Object.entries({
  'unknown envelope field': (value: Obj) => {
    value.ambient = true;
  },
  'wrong profile': (value: Obj) => {
    value.profile = 'unbounded-insert';
  },
  'multiple actions': (value: Obj) => {
    value.actions = [...(value.actions as Obj[]), ...(value.actions as Obj[])];
  },
  'unknown owner field': (value: Obj) => {
    (value.owner as Obj).ambient = true;
  },
  'unknown action field': (value: Obj) => {
    (value.actions as Obj[])[0]!.ambient = true;
  },
  'wrong table': (value: Obj) => {
    (value.actions as Obj[])[0]!.table = 'processes';
  },
  'update operation': (value: Obj) => {
    (value.actions as Obj[])[0]!.expected_operation = 'save_draft';
  },
  'before image': (value: Obj) => {
    (value.actions as Obj[])[0]!.before_sha256 = '0'.repeat(64);
  },
  'action dependency': (value: Obj) => {
    (value.actions as Obj[])[0]!.dependency_action_ids = ['other'];
  },
  'missing receipt': (value: Obj) => {
    delete (value.actions as Obj[])[0]!.identity_admission;
  },
  'malformed receipt': (value: Obj) => {
    (value.actions as Obj[])[0]!.identity_admission = {
      schema_version: 'flow-identity-admission.v1',
      receipt: 'loose',
    };
  },
  'unknown pin field': (value: Obj) => {
    ((value.actions as Obj[])[0]!.identity_admission as Obj).ambient = true;
  },
  'wrong receipt schema': (value: Obj) => {
    ((value.actions as Obj[])[0]!.identity_admission as Obj).schema_version =
      'flow-identity-admission.v0';
  },
  'unknown file fact': (value: Obj) => {
    (((value.actions as Obj[])[0]!.identity_admission as Obj).receipt as Obj).ambient = true;
  },
})) {
  test(`strict v2 rejects ${name} without acquiring a remote binding`, async (t) => {
    const f = await identitySaveFixture(t);
    const value = JSON.parse(
      fs.readFileSync(f.preparation.files.execution_contract, 'utf8'),
    ) as Obj;
    mutate(value);
    write(f.preparation.files.execution_contract, value);
    f.preparation.execution_contract_sha256 = fact(f.preparation.files.execution_contract).sha256;
    const result = await f.invoke(true);
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID/u);
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(events(path.join(f.root, 'state')).length, 0);
  });
}

test('v2 refuses caller-supplied raw input and parallel execution before remote access', async (t) => {
  const f = await identitySaveFixture(t);
  const options = {
    inputPath: f.files.rows!,
    type: 'flow',
    commit: true,
    executionContractPath: f.preparation.files.execution_contract,
    executionContractSha256: f.preparation.execution_contract_sha256,
    env: f.env,
    fetchImpl: f.fetchImpl,
  };
  for (const extra of [{ rawInput: [f.target] }, { maxParallel: 2 }]) {
    await assert.rejects(() => runDatasetSaveDraft({ ...options, ...extra }), {
      code: 'DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID',
    });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

function replaceLedger(file: string, values: Obj[]) {
  let previous: string | null = null;
  for (const event of values) {
    event.previous_event_sha256 = previous;
    delete event.event_sha256;
    previous = sha256Json(event);
    event.event_sha256 = previous;
  }
  fs.writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

for (const change of ['invalid_summary', 'changed_summary', 'fixed_contract'] as const) {
  test(`consumed ledger ${change} cannot authorize a fresh write or candidate search`, async (t) => {
    const f = await identitySaveFixture(t);
    const first = await f.invoke(true);
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    const ledgerRoot = report(first).files.execution_ledger;
    const file = path.join(
      ledgerRoot,
      fs.readdirSync(ledgerRoot).find((name) => name.endsWith('.events.jsonl'))!,
    );
    const values = events(ledgerRoot);
    for (const event of values) {
      if (change === 'invalid_summary') (event.identity_admission as Obj).profile = 'unsupported';
      if (change === 'changed_summary')
        (event.identity_admission as Obj).review_sha256 = '0'.repeat(64);
      if (change === 'fixed_contract') event.contract_sha256 = '0'.repeat(64);
    }
    replaceLedger(file, values);
    const evidence = fs.readFileSync(file, 'utf8');
    const reads = familyReads(f);
    const result = await f.invoke(true);
    assert.equal(result.exitCode, 2, result.stdout);
    assert.match(result.stderr, /DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID/u);
    assert.equal(f.writes.length, 1);
    assert.equal(familyReads(f), reads);
    assert.equal(fs.readFileSync(file, 'utf8'), evidence);
  });
}

test('a consumed v1 attempt cannot be retrofitted with v2 admission', async (t) => {
  const f = await identitySaveFixture(t);
  f.controls.requireReadFence = false;
  const first = await executeCli(
    [
      'dataset',
      'save-draft',
      '--input',
      f.files.rows!,
      '--type',
      'flow',
      '--execution-contract',
      f.files.template!,
      '--out-dir',
      path.join(f.root, 'legacy'),
      '--commit',
      '--json',
    ],
    f.deps,
  );
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const before = events(report(first).files.execution_ledger);
  assert.equal(before[0]!.schema_version, 'dataset-save-draft-execution-event.v1');
  assert.equal(before[0]!.identity_admission, undefined);
  f.controls.requireReadFence = true;
  const result = await f.invoke(true);
  assert.equal(result.exitCode, 2, result.stdout);
  assert.match(result.stderr, /DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID/u);
  assert.equal(f.writes.length, 1);
  assert.equal(familyReads(f), 0);
  assert.deepEqual(events(report(first).files.execution_ledger), before);
});

test('identity read fence rejects malformed compound scopes before fetch and preserves valid restrictions', async () => {
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({ input: String(input), init });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '[]' };
  };
  const actor = '00000000-0000-4000-8000-000000000090';
  const base = 'https://abcdefghijklmnopqrst.supabase.co';
  const scoped = __testInternals.identityScopedFetch(fetchImpl, `${base}/functions/v1`, actor);
  for (const constraints of [
    ['state_code.eq.200'],
    ['(state_code.eq.200'],
    ['state_code.eq.200)'],
    ['(state_code.eq.200)', '(user_id.neq.owner)'],
  ]) {
    const url = new URL(`${base}/rest/v1/flows`);
    for (const constraint of constraints) url.searchParams.append('and', constraint);
    assert.throws(() => scoped(url.toString()), {
      code: 'DATASET_SAVE_DRAFT_EXECUTION_CONTRACT_INVALID',
    });
    assert.equal(requests.length, 0, 'Invalid scope must fail before downstream HTTP.');
  }
  const url = new URL(`${base}/rest/v1/flows`);
  url.searchParams.set('and', '(or(state_code.eq.200,state_code.eq.0))');
  url.searchParams.set('id', 'eq.00000000-0000-4000-8000-000000000001');
  const init = { method: 'HEAD', headers: { 'Accept-Profile': 'core' } };
  await scoped(url.toString(), init);
  assert.equal(requests.length, 1);
  const observed = new URL(requests[0]!.input);
  assert.equal(observed.searchParams.get('id'), url.searchParams.get('id'));
  assert.deepEqual(
    observed.searchParams.getAll('and'),
    [
      `(or(state_code.eq.200,state_code.eq.0),or(and(state_code.gte.100,state_code.lt.200),and(state_code.eq.0,user_id.eq.${actor})))`,
    ],
    'The prior OR remains inside an outer AND with the non-bypassable visibility fence.',
  );
  assert.equal(requests[0]!.init, init);
  for (const [input, requestInit] of [
    [`${base}/auth/v1/user?and=malformed`, undefined],
    [`${base}/rest/v1/flows?and=malformed`, { method: 'POST', body: '{}' }],
    ['https://other.supabase.co/rest/v1/flows?and=malformed', undefined],
    [`${base}/rest/v1/unrelated?and=malformed`, undefined],
  ] as const) {
    await scoped(input, requestInit);
    assert.equal(requests.at(-1)!.input, input);
    assert.equal(requests.at(-1)!.init, requestInit);
  }
});

function assertLedgerChain(ledger: Obj[]) {
  let previous: string | null = null;
  for (const [index, event] of ledger.entries()) {
    assert.equal(event.sequence, index + 1);
    assert.equal(event.previous_event_sha256, previous);
    const { event_sha256: hash, ...core } = event;
    assert.equal(hash, sha256Json(core));
    previous = String(hash);
  }
  assert.equal(new Set(ledger.map((event) => event.sequence)).size, ledger.length);
  assert.equal(new Set(ledger.map((event) => event.event_sha256)).size, ledger.length);
}

function ledgerFile(root: string): string {
  const entries = fs.readdirSync(root, { recursive: true });
  return path.join(root, String(entries.find((entry) => String(entry).endsWith('.events.jsonl'))!));
}

test('nested same-operation commit from the active transport cannot reenter or finalize its attempt', async (t) => {
  const f = await identitySaveFixture(t);
  let nested: Awaited<ReturnType<typeof f.invoke>> | undefined;
  let nestedAttempted = false;
  f.controls.onRequest = async (url) => {
    if (url.pathname === '/functions/v1/app_dataset_create' && !nestedAttempted) {
      nestedAttempted = true;
      nested = await f.invoke(true);
    }
  };
  const first = await f.invoke(true);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.ok(nested);
  assert.notEqual(nested.exitCode, 0, nested.stdout);
  const ledger = events(report(first).files.execution_ledger);
  assert.equal(ledger.length, 2);
  assertLedgerChain(ledger);
  assert.equal(f.writes.length, 1);
  const third = await f.invoke(true);
  assert.equal(third.exitCode, 0, third.stderr || third.stdout);
  assert.deepEqual(events(report(first).files.execution_ledger), ledger);
  assert.equal(f.writes.length, 1);
});

test('interrupted outcome persistence retains the original emitted attempt for read-only recovery', async (t) => {
  const f = await identitySaveFixture(t);
  let interrupted: { file: string; backup: string } | undefined;
  f.controls.onRequest = (url) => {
    if (f.writes.length === 1 && url.pathname.endsWith('/flows') && !interrupted) {
      const file = ledgerFile(path.join(f.root, 'state'));
      const backup = `${file}.durable-attempt`;
      fs.renameSync(file, backup);
      fs.mkdirSync(file);
      interrupted = { file, backup };
    }
  };
  const first = await f.invoke(true);
  assert.ok(interrupted);
  fs.rmdirSync(interrupted.file);
  fs.renameSync(interrupted.backup, interrupted.file);
  assert.notEqual(first.exitCode, 0, first.stdout);
  const retained = events(path.join(f.root, 'state'));
  assert.equal(retained.length, 1);
  assert.equal(retained[0]!.event_type, 'attempt_emitted');
  assertLedgerChain(retained);
  const reads = familyReads(f);
  f.controls.onRequest = undefined;
  const recovered = await f.invoke(true);
  assert.equal(recovered.exitCode, 0, recovered.stderr || recovered.stdout);
  assert.equal(report(recovered).counts.executed, 1);
  const ledger = events(report(recovered).files.execution_ledger);
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger[0], retained[0]);
  assert.deepEqual(ledger[1]!.identity_observation, retained[0]!.identity_observation);
  assertLedgerChain(ledger);
  assert.equal(familyReads(f), reads);
  assert.equal(f.writes.length, 1);
});

for (const stage of ['target', 'reference', 'auth', 'coverage'] as const) {
  for (const failure of ['http', 'throw'] as const) {
    test(`identity ${stage} ${failure} failure never persists remote credential sentinels`, async (t) => {
      const f = await identitySaveFixture(t);
      const sentinel = 'SYNTHETIC_CREDENTIAL_SENTINEL_DO_NOT_PERSIST';
      const selected = (url: URL) => {
        if (stage === 'auth') return url.pathname.startsWith('/auth/');
        if (stage === 'reference') return url.pathname.endsWith('/sources');
        if (stage === 'coverage') return url.searchParams.get('id')?.startsWith('in.') === true;
        return (
          url.pathname.endsWith('/flows') && url.searchParams.get('id')?.startsWith('eq.') === true
        );
      };
      let triggered = false;
      if (failure === 'http') {
        f.controls.responseOverride = (url) => {
          if (!selected(url)) return undefined;
          triggered = true;
          return {
            ok: false,
            status: 400,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({
                code: sentinel,
                message: `Bearer ${sentinel}`,
                details: { token: sentinel },
                hint: sentinel,
              }),
          };
        };
      } else {
        f.controls.onRequest = (url) => {
          if (selected(url)) {
            triggered = true;
            throw new Error(`Remote transport Bearer ${sentinel}`);
          }
        };
      }
      const result = await f.invoke(true);
      assert.equal(triggered, true);
      assert.notEqual(result.exitCode, 0, result.stdout);
      assert.equal(f.writes.length, 0);
      const artifacts = fs.readdirSync(f.root, { recursive: true }).flatMap((entry) => {
        const file = path.join(f.root, String(entry));
        return fs.statSync(file).isFile() ? [fs.readFileSync(file, 'utf8')] : [];
      });
      for (const content of [result.stdout, result.stderr, ...artifacts])
        assert.equal(content.includes(sentinel), false);
      if (result.stdout) {
        const value = report(result);
        assert.equal(value.counts.failed, 1);
        const details = (value.rows[0]!.error as Obj).details as Obj;
        assert.deepEqual(Object.keys(details), ['code']);
        assert.match(String(details.code), /^(?:FLOW_IDENTITY|DATASET_SAVE_DRAFT)/u);
        assert.match(
          String((value.rows[0]!.error as Obj).message),
          /^Identity-admitted operation failed\./u,
        );
      }
      assert.equal(events(path.join(f.root, 'state')).length, 0);
    });
  }
}

for (const [name, mutate] of Object.entries({
  'missing observation': (event: Obj) => {
    delete event.identity_observation;
  },
  'nonstring date': (event: Obj) => {
    (event.identity_observation as Obj).observed_at_utc = 123;
  },
  'invalid date': (event: Obj) => {
    (event.identity_observation as Obj).observed_at_utc = 'invalid';
  },
  'noncanonical date': (event: Obj) => {
    (event.identity_observation as Obj).observed_at_utc = '2026-10-20T00:00:00Z';
  },
  'nonstring hash': (event: Obj) => {
    (event.identity_observation as Obj).coverage_sha256 = 123;
  },
  'invalid hash': (event: Obj) => {
    (event.identity_observation as Obj).coverage_sha256 = 'bad';
  },
  'zero queries': (event: Obj) => {
    (event.identity_observation as Obj).query_count = 0;
  },
  'fractional queries': (event: Obj) => {
    (event.identity_observation as Obj).query_count = 1.5;
  },
  'fractional candidates': (event: Obj) => {
    (event.identity_observation as Obj).candidate_count = 0.5;
  },
  'negative candidates': (event: Obj) => {
    (event.identity_observation as Obj).candidate_count = -1;
  },
  'wrong scope': (event: Obj) => {
    (event.identity_observation as Obj).scope = 'global';
  },
  'unknown observation field': (event: Obj) => {
    (event.identity_observation as Obj).ambient = true;
  },
  'outcome observation drift': (event: Obj) => {
    if (event.event_type === 'outcome')
      (event.identity_observation as Obj).observed_at_utc = '2026-10-20T00:00:00.000Z';
  },
})) {
  test(`consumed identity ledger rejects ${name} without rewriting evidence or searching candidates`, async (t) => {
    const f = await identitySaveFixture(t);
    const first = await f.invoke(true);
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    const root = report(first).files.execution_ledger;
    const file = ledgerFile(root);
    const ledger = events(root);
    for (const event of ledger) mutate(event);
    replaceLedger(file, ledger);
    const original = fs.readFileSync(file, 'utf8');
    const reads = familyReads(f);
    const recovered = await f.invoke(true);
    assert.equal(recovered.exitCode, 2, recovered.stdout);
    assert.equal(f.writes.length, 1);
    assert.equal(familyReads(f), reads);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
}

for (const ownerHost of ['same_host', 'foreign_host'] as const) {
  test(`physical ${ownerHost} operation lock blocks admission without stealing or emitting an attempt`, async (t) => {
    const f = await identitySaveFixture(t);
    const contract = JSON.parse(
      fs.readFileSync(f.preparation.files.execution_contract, 'utf8'),
    ) as Parameters<typeof __testInternals.executionLedgerRoot>[1];
    const root = __testInternals.executionLedgerRoot(f.env, contract);
    const operationPath = `${__testInternals.executionLedgerPath(root, contract.actions[0]!)}.operation`;
    fs.mkdirSync(operationPath, { recursive: true, mode: 0o700 });
    const lockPath = batchRunLockPath(operationPath);
    const holder = `${JSON.stringify({ ownerPid: process.pid, ownerHost: ownerHost === 'same_host' ? os.hostname() : `${os.hostname()}-foreign`, reason: 'synthetic-external-holder', updatedAt: new Date().toISOString() })}\n`;
    fs.writeFileSync(lockPath, holder, { mode: 0o600 });
    const result = await f.invoke(true);
    assert.equal(result.exitCode, 1, result.stdout);
    assert.match(result.stderr, /FLOW_IDENTITY_OPERATION_BUSY/u);
    assert.equal(
      fs.readFileSync(lockPath, 'utf8'),
      holder,
      'A contender cannot replace or remove a live or foreign physical lock.',
    );
    assert.equal(events(path.join(f.root, 'state')).length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(familyReads(f), 0);
    fs.unlinkSync(lockPath);
    const admitted = await f.invoke(true);
    assert.equal(admitted.exitCode, 0, admitted.stderr || admitted.stdout);
    assert.equal(f.writes.length, 1);
    const ledger = events(report(admitted).files.execution_ledger);
    assert.equal(ledger.length, 2);
    assertLedgerChain(ledger);
  });
}
