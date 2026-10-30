import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';
import {
  runObjectGet,
  type ObjectDatasetType,
  type RunObjectGetOptions,
} from '../src/lib/object-get.js';
import { OBJECT_READ_LIMITS, withObjectReadTransport } from '../src/lib/object-read-transport.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const VERSION = '00.00.001';
const NOW = new Date('2026-10-29T00:00:00Z');
const descriptors = {
  contact: ['contactDataSet', 'contactInformation'],
  source: ['sourceDataSet', 'sourceInformation'],
  lifecyclemodel: ['lifeCycleModelDataSet', 'lifeCycleModelInformation'],
  flowproperty: ['flowPropertyDataSet', 'flowPropertiesInformation'],
  unitgroup: ['unitGroupDataSet', 'unitGroupInformation'],
} as const;
function payload(type: ObjectDatasetType = 'contact', version = VERSION) {
  const [wrapper, info] = descriptors[type];
  return {
    [wrapper]: {
      [info]: {
        dataSetInformation: {
          'common:UUID': ID,
          name: [
            { '@xml:lang': 'zh', '#text': '完整正文' },
            { '@xml:lang': 'en', '#text': 'Complete body' },
          ],
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
      native: {
        referenceInternalId: '7',
        units: [
          { id: '7', factor: 1 },
          { id: '9', factor: 0.001 },
        ],
        attachment: 'reference-only',
        referenceToUnitGroup: { '@refObjectId': OTHER, '@version': VERSION },
      },
    },
  };
}
function row(type: ObjectDatasetType = 'contact', version = VERSION) {
  return {
    id: ID,
    version,
    user_id: ACTOR,
    state_code: 100,
    modified_at: null,
    json_ordered: payload(type, version),
    json: null,
  };
}
function response(value: unknown, status = 200): ResponseLike {
  return {
    ok: status === 200,
    status,
    headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
    text: async () => (typeof value === 'string' ? value : JSON.stringify(value)),
  };
}
function setup(
  responses: Array<unknown | ResponseLike>,
  changes: Partial<RunObjectGetOptions> = {},
) {
  const urls: URL[] = [];
  const inits: Array<RequestInit | undefined> = [];
  let ordinal = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: ACTOR });
    urls.push(new URL(url));
    inits.push(init);
    const value = responses[ordinal++];
    return value && typeof value === 'object' && 'text' in value
      ? (value as ResponseLike)
      : response(value);
  };
  const options: RunObjectGetOptions = {
    datasetType: 'contact',
    id: ID,
    version: VERSION,
    expectedUserId: ACTOR,
    expectedProjectRef: 'example',
    now: NOW,
    env: buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' }),
    fetchImpl,
    ...changes,
  };
  return { options, urls, inits };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof CliError && error.code === expected;

test('all five object readers retain complete exact native bodies with bounded scoped GETs', async () => {
  for (const type of Object.keys(descriptors) as ObjectDatasetType[]) {
    const fixture = setup([[row(type)]], { datasetType: type });
    const result = await runObjectGet(fixture.options);
    assert.deepEqual(result.payload, payload(type));
    assert.equal(result.payload_source, 'json_ordered');
    assert.equal(result.dataset_type, type);
    assert.equal(result.resolution, 'remote_supabase_exact');
    assert.equal(result.version_fallback, false);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.resolved_version, VERSION);
    assert.equal(result.generated_at_utc, NOW.toISOString());
    assert.equal(fixture.urls.length, 1);
    assert.equal(fixture.urls[0]!.searchParams.get('limit'), '2');
    assert.match(fixture.urls[0]!.searchParams.get('or')!, new RegExp(ACTOR, 'u'));
    assert.equal(new Headers(fixture.inits[0]!.headers).get('accept-profile'), 'public');
    assert.equal(fixture.inits[0]!.method, 'GET');
    assert.equal(fixture.inits[0]!.redirect, 'error');
  }
});

test('latest and fallback use the same scope and actual version, including request above latest', async () => {
  for (const scope of ['public', 'owner-draft', 'public-or-owner-draft'] as const) {
    const latest = { ...row('source', '00.00.003'), state_code: scope === 'owner-draft' ? 0 : 100 };
    const fixture = setup(
      [[], [latest, { ...row('source', '00.00.002'), state_code: latest.state_code }]],
      { datasetType: 'source', version: '99.99.999', scope },
    );
    const result = await runObjectGet(fixture.options);
    assert.equal(result.resolution, 'remote_supabase_latest_fallback');
    assert.equal(result.version_fallback, true);
    assert.equal(result.resolved_version, '00.00.003');
    assert.equal(result.warnings[0]!.code, 'VERSION_FALLBACK');
    for (const field of ['id', 'state_code', 'user_id', 'or'])
      assert.equal(
        fixture.urls[0]!.searchParams.get(field),
        fixture.urls[1]!.searchParams.get(field),
      );
    assert.equal(fixture.urls[1]!.searchParams.get('order'), 'version.desc');
  }
  const fixture = setup([[row()]], { version: null });
  assert.equal((await runObjectGet(fixture.options)).resolution, 'remote_supabase_latest');
  assert.equal(fixture.urls.length, 1);
  const defaults = setup([[row()]]);
  delete defaults.options.version;
  delete defaults.options.scope;
  delete defaults.options.now;
  assert.equal((await runObjectGet(defaults.options)).requested_version, null);
});

test('json fallback accepts object or encoded JSON without rewriting native content', async () => {
  for (const body of [payload(), JSON.stringify(payload())]) {
    const fixture = setup([[{ ...row(), json_ordered: 'not an object', json: body }]]);
    const result = await runObjectGet(fixture.options);
    assert.equal(result.payload_source, 'json');
    assert.deepEqual(result.payload, payload());
  }
});

test('invalid arguments fail before any auth or body IO', async () => {
  const cases: Array<Partial<RunObjectGetOptions>> = [
    { id: '' },
    { version: '' },
    { version: '1.2.3' },
    { datasetType: 'flows' as ObjectDatasetType },
    { scope: 'all' as RunObjectGetOptions['scope'] },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { timeoutMs: 30_001 },
    { expectedUserId: '' },
    { expectedProjectRef: '' },
    { now: new Date(NaN) },
  ];
  for (const change of cases) {
    const fixture = setup([], change);
    let requests = 0;
    fixture.options.fetchImpl = async () => {
      requests++;
      throw new Error('must not execute');
    };
    await assert.rejects(runObjectGet(fixture.options), code('OBJECT_GET_OPTION_INVALID'));
    assert.equal(requests, 0);
  }
});

test('malformed responses, scope escape and ambiguity never become exact miss or fallback', async () => {
  const cases: Array<[unknown, string]> = [
    [{}, 'RESPONSE_INVALID'],
    ['{', 'RESPONSE_INVALID'],
    [[row(), row(), row()], 'RESPONSE_INVALID'],
    [[null], 'ROW_INVALID'],
    [[{ ...row(), id: OTHER }], 'ROW_INVALID'],
    [[{ ...row(), version: '' }], 'ROW_INVALID'],
    [[{ ...row(), user_id: undefined }], 'ROW_INVALID'],
    [[{ ...row(), state_code: 20 }], 'SCOPE_VIOLATION'],
    [[{ ...row(), state_code: 0, user_id: OTHER }], 'SCOPE_VIOLATION'],
    [[{ ...row(), modified_at: 'invalid' }], 'ROW_INVALID'],
    [[{ ...row(), state_code: null }], 'ROW_INVALID'],
    [[row('contact', '00.00.002')], 'ROW_INVALID'],
    [[row(), row()], 'AMBIGUOUS'],
    [[{ ...row(), json_ordered: null, json: null }], 'PAYLOAD_INVALID'],
    [[{ ...row(), json_ordered: null, json: '{' }], 'PAYLOAD_INVALID'],
    [[{ ...row(), json_ordered: payload('unitgroup') }], 'RESPONSE_INVALID'],
  ];
  for (const [bad, suffix] of cases) {
    const fixture = setup([bad]);
    await assert.rejects(runObjectGet(fixture.options), code(`OBJECT_GET_${suffix}`));
    assert.equal(fixture.urls.length, 1);
  }
  for (const bad of [
    [row(), row()],
    [row(), row('contact', '00.00.002')],
  ]) {
    await assert.rejects(
      runObjectGet(setup([bad], { version: null }).options),
      code('OBJECT_GET_AMBIGUOUS'),
    );
  }
  for (const responses of [[[]], [[], []]]) {
    await assert.rejects(
      runObjectGet(setup(responses, { version: responses.length === 1 ? null : VERSION }).options),
      code('OBJECT_GET_NOT_FOUND'),
    );
  }
  await assert.rejects(
    runObjectGet(setup([[], [{ ...row(), version: undefined }]]).options),
    code('OBJECT_GET_ROW_INVALID'),
  );
});

test('HTTP, transport and identity failures are sanitized and do not trigger version fallback', async () => {
  const failed = setup([response('private-body-secret', 500)]);
  await assert.rejects(runObjectGet(failed.options), code('OBJECT_GET_READ_FAILED'));
  assert.equal(failed.urls.length, 1);
  const transport = setup([]);
  transport.options.fetchImpl = async () => {
    throw new Error('access-token private-body-secret');
  };
  await assert.rejects(runObjectGet(transport.options), (error) => {
    assert.doesNotMatch(JSON.stringify(error), /access-token|private-body-secret/u);
    return code('OBJECT_GET_SESSION_INVALID')(error);
  });
  for (const assertions of [{ expectedUserId: OTHER }, { expectedProjectRef: 'other' }]) {
    const fixture = setup([], assertions);
    await assert.rejects(runObjectGet(fixture.options), code('OBJECT_GET_SESSION_INVALID'));
    assert.equal(fixture.urls.length, 0);
  }
});

test('public rows preserve a null owner while owner drafts require the verified actor', async () => {
  const publicRow = { ...row(), user_id: null };
  assert.equal(
    (await runObjectGet(setup([[publicRow]], { scope: 'public' }).options)).user_id,
    null,
  );
  await assert.rejects(
    runObjectGet(setup([[{ ...publicRow, state_code: 0 }]], { scope: 'owner-draft' }).options),
    code('OBJECT_GET_SCOPE_VIOLATION'),
  );
});

test('response bounds cover text, streamed bytes, declared length, UTF8 and stalled fetch/body', async () => {
  const huge = 'x'.repeat(OBJECT_READ_LIMITS.responseBytes + 1);
  const streamed = (bytes: Uint8Array) => ({
    ...response(''),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
  const fixtures = [
    response(huge),
    { ...response(''), headers: { get: () => String(huge.length) } },
    streamed(new TextEncoder().encode(huge)),
  ];
  for (const value of fixtures)
    await assert.rejects(runObjectGet(setup([value]).options), code('OBJECT_GET_BYTE_LIMIT'));
  await assert.rejects(
    runObjectGet(setup([streamed(new Uint8Array([0xff]))]).options),
    code('OBJECT_GET_FAILED'),
  );
  const success = setup([streamed(new TextEncoder().encode(JSON.stringify([row()])))]);
  assert.equal((await runObjectGet(success.options)).resolved_version, VERSION);
  for (const bodyStalls of [false, true]) {
    const fixture = setup([], { timeoutMs: 5 });
    fixture.options.fetchImpl = async (url) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: ACTOR });
      if (!bodyStalls) return new Promise(() => {});
      return { ...response(''), text: () => new Promise(() => {}) };
    };
    await assert.rejects(runObjectGet(fixture.options), code('OBJECT_GET_TIMEOUT'));
  }
});

test('request and total-byte limits include authenticated internal work', async () => {
  const fixture = setup([]);
  const options = {
    ...fixture.options,
    env: fixture.options.env!,
    fetchImpl: fixture.options.fetchImpl!,
    timeoutMs: 1000,
  };
  await assert.rejects(
    withObjectReadTransport(options, async ({ fetchImpl }) => {
      for (;;) await fetchImpl('https://example.supabase.co/auth/v1/user');
    }),
    code('OBJECT_GET_REQUEST_LIMIT'),
  );
  const large = response('x'.repeat(OBJECT_READ_LIMITS.responseBytes));
  const total = {
    ...options,
    fetchImpl: (async (url: string) =>
      isSupabaseAuthTokenUrl(url)
        ? makeSupabaseAuthResponse({ userId: ACTOR })
        : large) as FetchLike,
  };
  await assert.rejects(
    withObjectReadTransport(total, async ({ fetchImpl }) => {
      for (let index = 0; index < 5; index++)
        await fetchImpl('https://example.supabase.co/rest/v1/contacts');
    }),
    code('OBJECT_GET_BYTE_LIMIT'),
  );
});

test('OAuth refresh verifies the refreshed live actor before replay and permanently rejects drift', async () => {
  for (const switchActor of [false, true]) {
    const env = buildSupabaseTestEnv();
    let refreshed = false;
    let dataRequests = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/auth/v1/oauth/token')) {
        refreshed = true;
        return makeSupabaseAuthResponse({ userId: ACTOR, accessToken: 'rotated-token' });
      }
      if (url.endsWith('/auth/v1/user'))
        return makeSupabaseAuthResponse({ userId: refreshed && switchActor ? OTHER : ACTOR });
      if (url.endsWith('/auth/v1/oauth/userinfo'))
        return response({
          sub: refreshed && switchActor ? OTHER : ACTOR,
          email: 'user@example.com',
        });
      dataRequests++;
      assert.equal(
        new Headers(init!.headers).get('authorization'),
        `Bearer ${refreshed ? 'rotated-token' : 'access-token'}`,
      );
      return dataRequests === 1 ? response({}, 401) : response([row()]);
    };
    const options = {
      datasetType: 'contact' as const,
      id: ID,
      version: VERSION,
      env,
      fetchImpl,
      now: NOW,
    };
    if (switchActor) {
      await assert.rejects(runObjectGet(options), code('OBJECT_GET_SESSION_INVALID'));
      assert.equal(dataRequests, 1);
    } else {
      assert.equal((await runObjectGet(options)).resolved_version, VERSION);
      assert.equal(dataRequests, 2);
    }
  }
  let tokenCalls = 0;
  await withObjectReadTransport(
    {
      env: buildSupabaseTestEnv(),
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        if (url.endsWith('/auth/v1/user')) return makeSupabaseAuthResponse({ userId: ACTOR });
        tokenCalls++;
        throw new Error('provider-secret');
      },
    },
    async ({ runtime }) => {
      await assert.rejects(
        runtime.refreshAccessToken!(),
        code('SUPABASE_OAUTH_REFRESH_UNAVAILABLE'),
      );
      await assert.rejects(runtime.getAccessToken(), code('OBJECT_GET_SESSION_INVALID'));
      assert.equal(tokenCalls, 1);
      // The final actor check must also reject an invalidated session.
    },
  ).then(
    () => assert.fail('invalid session accepted'),
    (error: unknown) => assert.ok(code('OBJECT_GET_SESSION_INVALID')(error)),
  );
});

test('operation deadline also bounds work that never issues another request', async (context) => {
  const fixture = setup([]);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(
    withObjectReadTransport(
      { env: fixture.options.env!, fetchImpl: fixture.options.fetchImpl!, timeoutMs: 1_000 },
      async () => {
        context.mock.timers.tick(OBJECT_READ_LIMITS.durationMs);
        return new Promise<never>(() => {});
      },
    ),
    code('OBJECT_GET_TIMEOUT'),
  );
});

test('environment and fetch defaults use the same authenticated native read', async () => {
  const fixture = setup([[row()]]);
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  try {
    process.env = fixture.options.env!;
    globalThis.fetch = fixture.options.fetchImpl as typeof fetch;
    delete fixture.options.env;
    delete fixture.options.fetchImpl;
    assert.equal((await runObjectGet(fixture.options)).resolved_version, VERSION);
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test('object readers canonicalize UUID spelling before querying and comparing rows', async () => {
  const canonical = 'abcdef01-abcd-4abc-8def-abcdef012345';
  const selected = row();
  selected.id = canonical;
  selected.json_ordered.contactDataSet.contactInformation.dataSetInformation!['common:UUID'] =
    canonical;
  const fixture = setup([[selected]], { id: canonical.toUpperCase() });
  const result = await runObjectGet(fixture.options);
  assert.equal(result.id, canonical);
  assert.equal(fixture.urls[0]!.searchParams.get('id'), `eq.${canonical}`);
});

test('initial identity rejection refreshes through the session owner before any dataset request', async () => {
  for (const switchActor of [false, true]) {
    const env = buildSupabaseTestEnv();
    const observed: string[] = [];
    let refreshed = false;
    let datasets = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const pathname = new URL(url).pathname;
      observed.push(pathname);
      if (pathname === '/auth/v1/oauth/token') {
        refreshed = true;
        return makeSupabaseAuthResponse({ accessToken: 'identity-rotated-token' });
      }
      if (pathname === '/auth/v1/oauth/userinfo')
        return response({ sub: switchActor ? OTHER : ACTOR, email: 'user@example.com' });
      if (pathname === '/auth/v1/user') {
        if (!refreshed) return response({ error: 'expired-private-body' }, 401);
        assert.equal(
          new Headers(init!.headers).get('authorization'),
          'Bearer identity-rotated-token',
        );
        return makeSupabaseAuthResponse({ userId: switchActor ? OTHER : ACTOR });
      }
      datasets++;
      assert.equal(
        new Headers(init!.headers).get('authorization'),
        'Bearer identity-rotated-token',
      );
      return response([row()]);
    };
    const options = { ...setup([]).options, env, fetchImpl };
    if (switchActor) {
      await assert.rejects(runObjectGet(options), code('OBJECT_GET_SESSION_INVALID'));
      assert.equal(datasets, 0);
    } else {
      assert.equal((await runObjectGet(options)).resolved_version, VERSION);
      assert.equal(datasets, 1);
    }
    assert.deepEqual(observed.slice(0, 4), [
      '/auth/v1/user',
      '/auth/v1/oauth/token',
      '/auth/v1/oauth/userinfo',
      '/auth/v1/user',
    ]);
  }
});

test('missing OAuth sessions preserve the auth login handoff without network access', async () => {
  const env = buildSupabaseTestEnv();
  env.TIANGONG_LCA_SESSION_FILE += '.missing';
  let requests = 0;
  await assert.rejects(
    runObjectGet({
      ...setup([]).options,
      env,
      fetchImpl: async () => {
        requests++;
        throw new Error('unexpected-request');
      },
    }),
    (error: unknown) => {
      assert.ok(code('SUPABASE_OAUTH_LOGIN_REQUIRED')(error));
      assert.match((error as Error).message, /tiangong-lca auth login/u);
      return true;
    },
  );
  assert.equal(requests, 0);
});

test('transient OAuth refresh failures retain their safe code at initial identity and dataset refresh boundaries', async () => {
  for (const initialIdentity of [true, false]) {
    const env = buildSupabaseTestEnv();
    let datasetRequests = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/auth/v1/oauth/token'))
        return response({ message: 'private-provider-secret' }, 503);
      if (url.endsWith('/auth/v1/user'))
        return initialIdentity ? response({}, 401) : makeSupabaseAuthResponse({ userId: ACTOR });
      datasetRequests++;
      return response({}, 401);
    };
    await assert.rejects(
      runObjectGet({ ...setup([]).options, env, fetchImpl }),
      (error: unknown) => {
        assert.ok(code('SUPABASE_OAUTH_REFRESH_UNAVAILABLE')(error));
        assert.match((error as Error).message, /Retry the command later/u);
        assert.doesNotMatch(
          JSON.stringify(error),
          /private-provider-secret|access-token|refresh-token/u,
        );
        return true;
      },
    );
    assert.equal(datasetRequests, initialIdentity ? 0 : 1);
  }
});
