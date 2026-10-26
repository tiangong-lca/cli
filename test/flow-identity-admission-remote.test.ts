import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';
import {
  parseFlowIdentityCoverage,
  flowIdentityPayloadType,
  flowIdentityCoverageSnapshots,
  verifyFlowIdentityCoverage,
  type FlowIdentityCoverage,
  type FlowIdentityFlowType,
  type FlowIdentitySnapshot,
} from '../src/lib/flow-identity-admission-remote.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const actor = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });

function row(
  version = '01.00.000',
  state = 100,
  flowType: FlowIdentityFlowType = 'Product flow',
): FlowIdentitySnapshot {
  return {
    id,
    version,
    user_id: state === 0 ? actor : foreign,
    state_code: state,
    payload: {
      flowDataSet: {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: flowType } },
        notes: { amount: 0.5, present: true, missing: null, multilingual: ['one', 'two'] },
      },
    },
  };
}

function family(
  rows = [row()],
  flowType: FlowIdentityFlowType = 'Product flow',
): FlowIdentityCoverage {
  return {
    schema_version: 'flow-identity-coverage.v1',
    scope: 'bounded_visible_search',
    project_ref: 'example',
    observed_at_utc: '2026-10-20T00:00:00.000Z',
    limitations: ['Only the selected visible families; no global uniqueness claim.'],
    queries: [
      {
        kind: 'flow_family',
        visibility: rows[0]?.state_code === 0 ? 'owner_draft' : 'public',
        ids: [id],
        type_of_dataset: flowType,
        snapshots: rows,
      },
    ],
  };
}

function hybrid(
  rows = [row()],
  flowType: FlowIdentityFlowType = 'Product flow',
): FlowIdentityCoverage {
  return {
    ...family(),
    queries: [
      {
        kind: 'flow_hybrid_search',
        query: 'synthetic product query',
        filter: { flowType, asInput: false },
        data_source: 'tg',
        match_count: 20,
        page_size: 10,
        match_threshold: 0.5,
        lexical_weight: 0.5,
        semantic_weight: 0.5,
        rrf_k: 10,
        total_count: rows.length,
        snapshots: rows,
      },
    ],
  };
}

function response(value: unknown, range = '0-0/1', ok = true): ResponseLike {
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (name) => (name === 'content-range' ? range : 'application/json') },
    text: async () => JSON.stringify(value),
  };
}

function wire(snapshot: FlowIdentitySnapshot): Record<string, unknown> {
  const { payload, ...identity } = snapshot;
  return { ...identity, json: payload };
}

function transport(
  data: (url: URL, init: RequestInit | undefined) => ResponseLike | Promise<ResponseLike>,
  user = actor,
): FetchLike {
  return async (input, init) =>
    isSupabaseAuthTokenUrl(input)
      ? makeSupabaseAuthResponse({ userId: user })
      : data(new URL(input), init);
}

function verify(coverage: FlowIdentityCoverage, fetchImpl: FetchLike) {
  return verifyFlowIdentityCoverage({
    coverage,
    actorUserId: actor,
    projectRef: 'example',
    env,
    fetchImpl,
    timeoutMs: 1_000,
  });
}

function rejected(value: unknown): void {
  assert.throws(() => parseFlowIdentityCoverage(value, actor), CliError);
}

test('coverage parser owns immutable full snapshots and rejects unsupported query options', () => {
  const original = family([row('01.00.001'), row()]);
  const parsed = parseFlowIdentityCoverage(original, actor);
  assert.equal(parsed.queries[0]!.snapshots[0]!.version, '01.00.000');
  original.queries[0]!.snapshots[0]!.payload.changed = 'later';
  assert.equal(parsed.queries[0]!.snapshots[1]!.payload.changed, undefined);
  assert.equal(Object.isFrozen(parsed.queries[0]!.snapshots[0]!.payload.flowDataSet), true);
  assert.throws(() => {
    parsed.limitations.push('changed');
  }, TypeError);
  const duplicateQueries = { ...parsed, queries: [parsed.queries[0]!, parsed.queries[0]!] };
  assert.equal(flowIdentityCoverageSnapshots(duplicateQueries).length, 2);
  rejected({ ...family(), surprise: true });
  rejected({ ...family(), schema_version: 'unknown' });
  rejected({ ...family(), scope: 'complete' });
  rejected({ ...family(), project_ref: 'invalid/host' });
  rejected({ ...family(), observed_at_utc: 'not-time' });
  rejected({ ...family(), observed_at_utc: '2026-99-99T00:00:00.000Z' });
  rejected({ ...family(), observed_at_utc: '2026-02-30T00:00:00.000Z' });
  rejected({ ...family(), limitations: [] });
  rejected({ ...family(), limitations: [' '] });
  rejected({ ...family(), limitations: [3] });
  rejected({ ...family(), limitations: ['bad\u0000text'] });
  rejected({ ...family(), queries: [] });
  rejected({ ...family(), queries: null });
  rejected({ ...family(), queries: [null] });
  rejected({ ...family(), queries: [{ ...family().queries[0], filter: {} }] });
  rejected({ ...family(), queries: [{ ...family().queries[0], ids: [] }] });
  rejected({ ...family(), queries: [{ ...family().queries[0], ids: [id, id] }] });
  rejected({ ...family(), queries: [{ ...family().queries[0], ids: ['invalid'] }] });
  rejected({ ...family(), queries: [{ ...family().queries[0], visibility: 'team' }] });
  rejected({ ...family(), queries: [{ ...family().queries[0], type_of_dataset: 'Waste flow' }] });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), id: other }] }],
  });
  rejected({ ...family(), queries: [{ ...family().queries[0], snapshots: [row(), row()] }] });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [row('01.00.000', 200)] }],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [row('01.00.000', 99)] }],
  });
  rejected({ ...family(), queries: [{ ...family().queries[0], snapshots: null }] });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), user_id: 2 }] }],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), user_id: 'invalid' }] }],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), id: 'invalid' }] }],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), version: 'latest' }] }],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), payload: {} }] }],
  });
  rejected({
    ...family(),
    queries: [
      {
        ...family().queries[0],
        snapshots: [{ ...row(), payload: { flowDataSet: { modellingAndValidation: {} } } }],
      },
    ],
  });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: [{ ...row(), payload: [] }] }],
  });
  const owner = family([row('01.00.000', 0)]);
  rejected({
    ...owner,
    queries: [{ ...owner.queries[0], snapshots: [{ ...row('01.00.000', 0), user_id: foreign }] }],
  });
  assert.throws(() => parseFlowIdentityCoverage(family(), 'invalid'), CliError);
  assert.equal(
    parseFlowIdentityCoverage(family([{ ...row(), user_id: null }]), actor).queries[0]!
      .snapshots[0]!.user_id,
    null,
  );
  const disagree = family();
  disagree.queries.push({
    ...disagree.queries[0]!,
    snapshots: [{ ...row(), payload: { ...row().payload, changed: true } }],
  });
  rejected(disagree);
});

test('coverage parser rejects non-JSON bodies, cycles and resource overflows', () => {
  for (const bad of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    new Date(),
    () => 1,
    new Map(),
  ]) {
    const source = family();
    source.queries[0]!.snapshots[0]!.payload.bad = bad;
    rejected(source);
  }
  const cyclic = family();
  cyclic.queries[0]!.snapshots[0]!.payload.cycle = cyclic;
  rejected(cyclic);
  const sparse = family();
  sparse.queries[0]!.snapshots[0]!.payload.sparse = Array(1);
  rejected(sparse);
  const long = family();
  long.limitations = ['x'.repeat(2_001)];
  rejected(long);
  rejected({ ...family(), queries: Array(21).fill(family().queries[0]) });
  rejected({ ...family(), limitations: Array(21).fill('bounded') });
  rejected({
    ...family(),
    queries: [{ ...family().queries[0], snapshots: Array(1_001).fill(row()) }],
  });
  rejected({ ...family(), queries: [{ ...family().queries[0], ids: Array(51).fill(id) }] });
  rejected(Object.create({ schema_version: 'flow-identity-coverage.v1' }));
  assert.equal(
    parseFlowIdentityCoverage(
      {
        ...family(),
        queries: [
          {
            ...family().queries[0],
            snapshots: [{ ...row(), payload: Object.assign(Object.create(null), row().payload) }],
          },
        ],
      },
      actor,
    ).queries.length,
    1,
  );
  const oversized = family(
    Array.from({ length: 600 }, (_, index) =>
      row(
        `01.${String(Math.floor(index / 1_000)).padStart(2, '0')}.${String(index % 1_000).padStart(3, '0')}`,
      ),
    ),
  );
  oversized.queries.push({
    ...oversized.queries[0]!,
    snapshots: Array.from({ length: 600 }, (_, index) =>
      row(`02.00.${String(index).padStart(3, '0')}`),
    ),
  });
  rejected(oversized);
});

test('hybrid parser requires strict public filters and explicit honest bounds', () => {
  const source = hybrid();
  assert.equal(parseFlowIdentityCoverage(source, actor).queries[0]!.kind, 'flow_hybrid_search');
  for (const fields of [
    { filter: { flowType: 'Product flow', asInput: true } },
    { filter: { flowType: 'Product flow', asInput: false, ignored: true } },
    { data_source: 'my' },
    { kind: 'unknown' },
    { snapshots: [row('01.00.000', 101)] },
    { total_count: 2 },
    { page_size: 0 },
    { match_count: Number.NaN },
    { rrf_k: 1.5 },
    { match_threshold: 2 },
    { lexical_weight: 0, semantic_weight: 0 },
    { query: '' },
  ]) {
    rejected({ ...source, queries: [{ ...source.queries[0], ...fields }] });
  }
  assert.equal(
    parseFlowIdentityCoverage(
      { ...source, queries: [{ ...source.queries[0], total_count: null }] },
      actor,
    ).queries.length,
    1,
  );
  assert.equal(parseFlowIdentityCoverage(hybrid([]), actor).queries[0]!.snapshots.length, 0);
});

test('family recheck sends owner/public state predicates before every exact-count data read', async () => {
  for (const state of [0, 100, 199]) {
    const coverage = family([row('01.00.000', state), row('01.00.001', state)]);
    let calls = 0;
    const result = await verify(
      coverage,
      transport((url, init) => {
        calls += 1;
        assert.equal(url.pathname, '/rest/v1/flows');
        assert.equal(url.searchParams.get('id'), `in.(${id})`);
        assert.equal(
          url.searchParams.get(
            'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet',
          ),
          'eq.Product flow',
        );
        assert.equal(new Headers(init?.headers).get('prefer'), 'count=exact');
        assert.equal(new Headers(init?.headers).get('accept-profile'), 'public');
        assert.equal(init?.redirect, 'error');
        if (state === 0) {
          assert.equal(url.searchParams.get('user_id'), `eq.${actor}`);
          assert.equal(url.searchParams.get('state_code'), 'eq.0');
        } else {
          assert.equal(url.searchParams.get('and'), '(state_code.gte.100,state_code.lt.200)');
        }
        const offset = Number(url.searchParams.get('offset'));
        return response([wire(coverage.queries[0]!.snapshots[offset]!)], `${offset}-${offset}/2`);
      }),
    );
    assert.equal(calls, 2);
    assert.equal(result.candidate_count, 2);
    assert.equal(result.query_count, 1);
    assert.match(result.coverage_sha256, /^[a-f0-9]{64}$/u);
    assert.match(result.observed_at_utc, /Z$/u);
  }
  const result = await verify(
    family([]),
    transport(() => response([], '*/0')),
  );
  assert.equal(result.candidate_count, 0);
});

test('static, actor and project failures stop before candidate I/O', async () => {
  let calls = 0;
  const never: FetchLike = async () => {
    calls += 1;
    throw new Error('forbidden');
  };
  await assert.rejects(
    verify(
      {
        ...family(),
        queries: [{ ...family().queries[0]!, visibility: 'foreign' }],
      } as unknown as FlowIdentityCoverage,
      never,
    ),
    CliError,
  );
  await assert.rejects(verify({ ...family(), project_ref: 'another' }, never), CliError);
  assert.equal(calls, 0);
  await assert.rejects(
    verify(
      family(),
      transport(() => {
        calls += 1;
        throw new Error('forbidden');
      }, foreign),
    ),
    /live actor/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    verifyFlowIdentityCoverage({
      coverage: { ...family(), project_ref: 'another' },
      actorUserId: actor,
      projectRef: 'another',
      env,
      fetchImpl: transport(() => {
        calls += 1;
        throw new Error('forbidden');
      }),
    }),
    /live actor or project/,
  );
  assert.equal(calls, 0);
});

test('family changed/missing/new bodies and malformed or forbidden rows fail closed', async () => {
  for (const value of [
    [],
    [wire({ ...row(), payload: { ...row().payload, extra: 1 } })],
    [wire({ ...row(), user_id: actor })],
    [wire(row('01.00.000', 101))],
    [wire(row('01.00.001'))],
    [wire(row()), wire(row('01.00.001'))],
    [wire({ ...row(), id: other })],
    [wire(row('01.00.000', 200))],
    [wire(row('01.00.000', -1))],
    [wire({ ...row(), payload: {} })],
    [null],
    null,
  ]) {
    await assert.rejects(
      verify(
        family(),
        transport(() =>
          response(
            value,
            Array.isArray(value) && value.length > 0
              ? `0-${value.length - 1}/${value.length}`
              : '*/0',
          ),
        ),
      ),
      CliError,
    );
  }
  await assert.rejects(
    verify(
      family(),
      transport(() => response([], '*/1001')),
    ),
    /exceeded/,
  );
  await assert.rejects(
    verify(
      family(),
      transport(() => response([wire(row())], '0-0/*')),
    ),
    /pagination/,
  );
  await assert.rejects(
    verify(
      family(),
      transport(() => response([wire(row())], '0-0/1', false)),
    ),
    /observation failed/,
  );
  await assert.rejects(
    verify(
      family(),
      transport(() => ({ ...response(null), text: async () => 'invalid-json' })),
    ),
    /not JSON/,
  );
  await assert.rejects(
    verify(
      family(),
      transport(() => ({ ...response(null), text: async () => 'x'.repeat(20_000_001) })),
    ),
    /byte bound/,
  );
});

test('latest hybrid match_count accepts 1–100 and rejects 101–200 before any request', async () => {
  for (const match_count of [1, 100]) {
    const coverage = hybrid();
    const query = coverage.queries[0]!;
    assert(query.kind === 'flow_hybrid_search');
    query.match_count = match_count;
    assert.equal(
      (parseFlowIdentityCoverage(coverage, actor).queries[0] as { match_count: number })
        .match_count,
      match_count,
    );
  }
  let requests = 0;
  for (let match_count = 101; match_count <= 200; match_count += 1) {
    const coverage = hybrid();
    const query = coverage.queries[0]!;
    assert(query.kind === 'flow_hybrid_search');
    query.match_count = match_count;
    await assert.rejects(
      verify(coverage, async () => {
        requests += 1;
        throw new Error(
          'Unsupported latest-search bounds must fail before authentication or data reads.',
        );
      }),
      { code: 'FLOW_IDENTITY_COVERAGE_INVALID' },
    );
  }
  assert.equal(requests, 0);
});

test('hybrid rechecks exact membership and hydrates only server-fenced public bodies', async () => {
  const coverage = hybrid([row(), row('01.00.001')]);
  let searches = 0;
  let reads = 0;
  const result = await verify(
    coverage,
    transport((url, init) => {
      if (url.pathname.endsWith('/flow_hybrid_search')) {
        searches += 1;
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          query: 'synthetic product query',
          filter: { flowType: 'Product flow', asInput: false },
          data_source: 'tg',
          match_count: 20,
          page_size: 10,
          page_current: 1,
          match_threshold: 0.5,
          lexical_weight: 0.5,
          semantic_weight: 0.5,
          rrf_k: 10,
        });
        return response({
          data: [
            { id, version: '01.00.001', total_count: 2, score: 0.5 },
            { id, version: '01.00.000', total_count: 2, score: 0.2 },
          ],
        });
      }
      reads += 1;
      assert.equal(url.searchParams.get('and'), '(state_code.gte.100,state_code.lt.200)');
      assert.equal(url.searchParams.get('id'), `eq.${id}`);
      assert.equal(url.searchParams.get('limit'), '2');
      assert.equal(new Headers(init?.headers).get('prefer'), 'count=exact');
      return response([wire(row(url.searchParams.get('version')!.slice(3)))]);
    }),
  );
  assert.equal(result.candidate_count, 2);
  assert.equal(searches, 1);
  assert.equal(reads, 2);
  const unknown = hybrid();
  unknown.queries[0] = {
    ...unknown.queries[0]!,
    total_count: null,
  } as FlowIdentityCoverage['queries'][number];
  await verify(
    unknown,
    transport((url) =>
      url.pathname.endsWith('/flow_hybrid_search')
        ? response({ data: [{ id, version: '01.00.000' }] })
        : response([wire(row())]),
    ),
  );
  await verify(
    hybrid([]),
    transport(() => response([])),
  );
});

test('hybrid malformed, changed, failed or truncated search stops before body hydration', async () => {
  const coverage = hybrid();
  for (const value of [
    { ok: false },
    {},
    { data: null },
    [row()],
    { data: [null] },
    { data: [{ id: 'invalid', version: '01.00.000' }] },
    { data: [{ id, version: 'latest' }] },
    { data: [{ id, version: '01.00.001', total_count: 1 }] },
    { data: [{ id, version: '01.00.000', total_count: 2 }] },
    { data: [{ id, version: '01.00.000', total_count: null }] },
    {
      data: [
        { id, version: '01.00.000' },
        { id, version: '01.00.000' },
      ],
    },
    { data: Array(11).fill({ id, version: '01.00.000' }) },
  ]) {
    let reads = 0;
    await assert.rejects(
      verify(
        coverage,
        transport((url) => {
          if (url.pathname.endsWith('/flow_hybrid_search')) return response(value);
          reads += 1;
          throw new Error('forbidden');
        }),
      ),
      CliError,
    );
    assert.equal(reads, 0);
  }
  await assert.rejects(
    verify(
      coverage,
      transport(() => response(null, '', false)),
    ),
    /observation failed/,
  );
});

test('hybrid exact hydration rejects disappearing, duplicate, foreign-state or changed bodies', async () => {
  for (const current of [
    [],
    [wire(row()), wire(row())],
    [wire(row('01.00.001'))],
    [wire(row('01.00.000', 101))],
    [wire(row('01.00.000', 200))],
    [wire({ ...row(), payload: { ...row().payload, body_changed: true } })],
  ]) {
    await assert.rejects(
      verify(
        hybrid(),
        transport((url) =>
          url.pathname.endsWith('/flow_hybrid_search')
            ? response({ data: [{ id, version: '01.00.000', total_count: 1 }] })
            : response(current),
        ),
      ),
      CliError,
    );
  }
  for (const range of ['*/1', '1-1/1', '0-1/1', '0-0/2']) {
    await assert.rejects(
      verify(
        hybrid(),
        transport((url) =>
          url.pathname.endsWith('/flow_hybrid_search')
            ? response({ data: [{ id, version: '01.00.000', total_count: 1 }] })
            : response([wire(row())], range),
        ),
      ),
      CliError,
    );
  }
  await assert.rejects(
    verify(
      hybrid([]),
      transport(() => response({ ok: false, data: [] })),
    ),
    CliError,
  );
});

test('supported body type reads only the exact nested Product/Waste type without mutation', () => {
  for (const flowType of ['Product flow', 'Waste flow'] as const) {
    const payload = row('01.00.000', 100, flowType).payload;
    const before = structuredClone(payload);
    assert.equal(flowIdentityPayloadType(payload), flowType);
    assert.deepEqual(payload, before);
  }
  for (const payload of [
    null,
    [],
    'Product flow',
    {},
    { flowDataSet: [] },
    { flowDataSet: { modellingAndValidation: null } },
    { flowDataSet: { modellingAndValidation: { LCIMethod: [] } } },
    ...['Elementary flow', 'Other flow', 'Waste Flow', null].map((typeOfDataSet) => ({
      flowDataSet: { modellingAndValidation: { LCIMethod: { typeOfDataSet } } },
    })),
  ])
    assert.equal(flowIdentityPayloadType(payload), null);
});

test('typed queries retain the original Product serialization and independent mixed candidates', () => {
  const original = family();
  const parsed = parseFlowIdentityCoverage(original, actor);
  assert.deepEqual(parsed, original);
  assert.equal(
    sha256Json(parsed),
    '90bcbd986972aa16421c43ff55ec2c12a1b6dce4a217c8d4f0b4acb3f8577e07',
  );
  const waste = family([row('01.00.000', 100, 'Waste flow')], 'Waste flow');
  waste.queries[0]!.snapshots[0]!.id = other;
  assert(waste.queries[0]!.kind === 'flow_family');
  waste.queries[0]!.ids = [other];
  const mixed = parseFlowIdentityCoverage(
    { ...original, queries: [...original.queries, ...waste.queries] },
    actor,
  );
  assert.equal(flowIdentityCoverageSnapshots(mixed).length, 2);
  for (const build of [family, hybrid]) {
    assert.equal(
      parseFlowIdentityCoverage(build([], 'Waste flow'), actor).queries[0]!.snapshots.length,
      0,
    );
  }
});

test('typed family and hybrid mismatches and Elementary profiles stop before authentication', async () => {
  let requests = 0;
  for (const build of [family, hybrid]) {
    for (const [queryType, bodyType] of [
      ['Product flow', 'Waste flow'],
      ['Waste flow', 'Product flow'],
    ] as const) {
      await assert.rejects(
        verify(build([row('01.00.000', 100, bodyType)], queryType), async () => {
          requests += 1;
          throw new Error('forbidden');
        }),
        CliError,
      );
    }
    const elementary = build();
    const query = elementary.queries[0]!;
    if (query.kind === 'flow_family') Object.assign(query, { type_of_dataset: 'Elementary flow' });
    else Object.assign(query.filter, { flowType: 'Elementary flow' });
    await assert.rejects(
      verify(elementary, async () => {
        requests += 1;
        throw new Error('forbidden');
      }),
      CliError,
    );
  }
  assert.equal(requests, 0);
});

test('Waste family reads retain public/owner fences and the exact Waste filter on every page', async () => {
  for (const state of [0, 100, 199]) {
    const coverage = family(
      [row('01.00.000', state, 'Waste flow'), row('01.00.001', state, 'Waste flow')],
      'Waste flow',
    );
    let reads = 0;
    const result = await verify(
      coverage,
      transport((url) => {
        reads += 1;
        assert.equal(
          url.searchParams.get(
            'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet',
          ),
          'eq.Waste flow',
        );
        if (state === 0) {
          assert.equal(url.searchParams.get('user_id'), `eq.${actor}`);
          assert.equal(url.searchParams.get('state_code'), 'eq.0');
        } else assert.equal(url.searchParams.get('and'), '(state_code.gte.100,state_code.lt.200)');
        const offset = Number(url.searchParams.get('offset'));
        return response([wire(coverage.queries[0]!.snapshots[offset]!)], `${offset}-${offset}/2`);
      }),
    );
    assert.equal(reads, 2);
    assert.equal(result.candidate_count, 2);
  }
});

test('Waste hybrid sends the exact typed filter and repeats it during public body hydration', async () => {
  const coverage = hybrid([row('01.00.000', 100, 'Waste flow')], 'Waste flow');
  let reads = 0;
  await verify(
    coverage,
    transport((url, init) => {
      if (url.pathname.endsWith('/flow_hybrid_search')) {
        assert.deepEqual(JSON.parse(String(init?.body)).filter, {
          flowType: 'Waste flow',
          asInput: false,
        });
        return response({ data: [{ id, version: '01.00.000', total_count: 1 }] });
      }
      reads += 1;
      assert.equal(
        url.searchParams.get(
          'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet',
        ),
        'eq.Waste flow',
      );
      assert.equal(url.searchParams.get('and'), '(state_code.gte.100,state_code.lt.200)');
      assert.equal(url.searchParams.get('id'), `eq.${id}`);
      assert.equal(url.searchParams.get('version'), 'eq.01.00.000');
      return response([wire(coverage.queries[0]!.snapshots[0]!)]);
    }),
  );
  assert.equal(reads, 1);
});

test('typed family and hydrated hybrid responses reject servers ignoring body type filters', async () => {
  for (const [queryType, bodyType] of [
    ['Product flow', 'Waste flow'],
    ['Waste flow', 'Product flow'],
  ] as const) {
    for (const build of [family, hybrid]) {
      const coverage = build([row('01.00.000', 100, queryType)], queryType);
      await assert.rejects(
        verify(
          coverage,
          transport((url) =>
            url.pathname.endsWith('/flow_hybrid_search')
              ? response({ data: [{ id, version: '01.00.000', total_count: 1 }] })
              : response([wire(row('01.00.000', 100, bodyType))]),
          ),
        ),
        CliError,
      );
    }
  }
});

test('Elementary candidate bodies reject locally and from typed family/hybrid responses', async () => {
  for (const build of [family, hybrid]) {
    for (const flowType of ['Product flow', 'Waste flow'] as const) {
      const elementary = row('01.00.000', 100, flowType);
      elementary.payload.flowDataSet = {
        modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Elementary flow' } },
      };
      let requests = 0;
      await assert.rejects(
        verify(build([elementary], flowType), async () => {
          requests += 1;
          throw new Error('forbidden');
        }),
        CliError,
      );
      assert.equal(requests, 0);
      await assert.rejects(
        verify(
          build([row('01.00.000', 100, flowType)], flowType),
          transport((url) =>
            url.pathname.endsWith('/flow_hybrid_search')
              ? response({ data: [{ id, version: '01.00.000', total_count: 1 }] })
              : response([wire(elementary)]),
          ),
        ),
        CliError,
      );
    }
  }
});
