import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCli, type CliDeps } from '../src/cli.js';
import type { ObjectDatasetType, RunObjectGetOptions } from '../src/lib/object-get.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const id = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const descriptors = {
  contact: ['contactDataSet', 'contactInformation'],
  source: ['sourceDataSet', 'sourceInformation'],
  lifecyclemodel: ['lifeCycleModelDataSet', 'lifeCycleModelInformation'],
  flowproperty: ['flowPropertyDataSet', 'flowPropertiesInformation'],
  unitgroup: ['unitGroupDataSet', 'unitGroupInformation'],
} as const;

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' }),
    dotEnvStatus: { loaded: false, path: '/not-loaded/.env', count: 0 },
    fetchImpl: async () => {
      throw new Error('unexpected network');
    },
    ...overrides,
  };
}

test('five object get commands are discoverable; unsupported general getters remain absent', async () => {
  const help = await executeCli([], deps());
  for (const kind of Object.keys(descriptors)) {
    assert.match(help.stdout, new RegExp(kind + '\\s+get', 'u'));
    for (const argv of [
      [kind],
      [kind, '--help'],
      [kind, '-h'],
      [kind, 'get', '--help'],
      [kind, 'get', '-h'],
    ]) {
      const result = await executeCli(argv, deps());
      assert.equal(result.exitCode, 0, argv.join(' '));
      assert.match(result.stdout, /get/u);
      if (argv.includes('get')) {
        assert.match(result.stdout, /resolved_version/u);
        assert.match(result.stdout, /state_code=100/u);
        assert.match(result.stdout, /state_code=0/u);
      }
    }
  }
  for (const argv of [
    ['dataset', 'get'],
    ['model', 'get'],
    ['unit', 'get'],
    ['property', 'get'],
    ['contact', 'list'],
  ]) {
    assert.notEqual((await executeCli(argv, deps())).exitCode, 0);
  }
  for (const argv of [
    ['contact', '--id', id],
    ['contact', '--bad'],
    ['contact', '--help', '--bad'],
  ]) {
    const result = await executeCli(argv, deps());
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
  }
});

test('public command serializes real exact/latest/fallback bodies and agent references for all five types', async () => {
  for (const kind of Object.keys(descriptors) as ObjectDatasetType[]) {
    for (const requested of ['00.00.001', '99.99.999', undefined]) {
      const version = '00.00.001';
      const [wrapper, info] = descriptors[kind];
      const payload = {
        [wrapper]: {
          [info]: {
            dataSetInformation: {
              'common:UUID': id,
              name: [{ '@xml:lang': 'zh', '#text': '原生正文' }],
            },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': version },
          },
          native: {
            referenceInternalId: '7',
            conversionFactor: '0.001',
            attachment: '../external_docs/example.pdf',
          },
        },
      };
      const urls: URL[] = [];
      const actual = deps({
        fetchImpl: async (url, init) => {
          assert.ok(!init?.method || init.method === 'GET');
          if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
          const parsed = new URL(url);
          urls.push(parsed);
          const rows =
            parsed.searchParams.get('version') === 'eq.99.99.999'
              ? []
              : [
                  {
                    id,
                    version,
                    user_id: actor,
                    state_code: 100,
                    modified_at: null,
                    json_ordered: payload,
                  },
                ];
          return new Response(JSON.stringify(rows), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });
      const argv = [kind, 'get', '--id', id];
      if (requested) argv.push('--version', requested, '--json');
      const result = await executeCli(argv, actual);
      assert.equal(result.exitCode, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.payload, payload);
      assert.equal(report.dataset_type, kind);
      assert.equal(report.requested_version, requested ?? null);
      assert.equal(report.resolved_version, version);
      const fallback = requested === '99.99.999';
      assert.equal(report.version_fallback, fallback);
      assert.equal(
        report.resolution,
        fallback
          ? 'remote_supabase_latest_fallback'
          : requested
            ? 'remote_supabase_exact'
            : 'remote_supabase_latest',
      );
      assert.equal(report.warnings.length, fallback ? 1 : 0);
      assert.equal(urls.length, fallback ? 2 : 1);
      // A stdout-only agent derives the observed reference from actual returned identity.
      assert.deepEqual({ id: report.id, version: report.resolved_version }, { id, version });
    }
  }
});

test('object get forwards explicit safe options and validates malformed requests without remote access', async () => {
  let observed: RunObjectGetOptions | undefined;
  const result = await executeCli(
    [
      'contact',
      'get',
      '--id',
      id,
      '--version',
      '00.00.001',
      '--scope',
      'owner-draft',
      '--expected-project-ref',
      'example',
      '--expected-user-id',
      actor,
      '--timeout-ms',
      '1234',
      '--json',
      '--',
    ],
    deps({
      runObjectGetImpl: async (options) => {
        observed = options;
        return { marker: 'injected' } as never;
      },
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(observed?.datasetType, 'contact');
  assert.equal(observed?.id, id);
  assert.equal(observed?.version, '00.00.001');
  assert.equal(observed?.scope, 'owner-draft');
  assert.equal(observed?.expectedUserId, actor);
  assert.equal(observed?.expectedProjectRef, 'example');
  assert.equal(observed?.timeoutMs, 1234);
  for (const flags of [
    [],
    ['--id', 'invalid'],
    ['--id', id, '--version', ''],
    ['--id', id, '--scope', 'all'],
    ['--id', id, '--timeout-ms', ''],
    ['--id', id, '--timeout-ms', '30001'],
    ['--id', id, '--unknown'],
    ['--id', id, 'positional'],
    ['--id', id, '--id', id],
    ['--id'],
    ['--id', id, '--strict'],
  ]) {
    const invalid = await executeCli(['contact', 'get', ...flags], deps());
    assert.equal(invalid.exitCode, 2, JSON.stringify({ flags, invalid }));
    assert.equal(invalid.stdout, '');
  }
});
