import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runDatasetRemoteVerify,
  classifyCheck,
  type RemoteDatasetReference,
} from '../src/lib/dataset/remote-verify.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { datasetWriter } from '../src/adapters/dataset-write.js';
import { qualifyDatasetWrite } from '../src/adapters/dataset-write-checks.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import type { JsonObject } from '../src/application/dataset-types.js';
import { makeFlow } from './helpers/flow-content.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const actor = '00000000-0000-4000-8000-000000000002';
const id = '11111111-1111-1111-1111-111111111111';
const version = '00.00.001';
const env = buildSupabaseTestEnv({ TIANGONG_LCA_AUTH_MODE: 'access-token' });
const occurrence = '/flowDataSet/flowProperties/flowProperty/referenceToFlowPropertyDataSet';

function transport(content: JsonObject | null, missing = false) {
  return async (url: string, init?: RequestInit) => {
    if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse({ userId: actor });
    assert.notEqual(init?.method, 'POST', 'previews must never dispatch');
    const query = new URL(url).searchParams;
    const selected = query.get('id')!.slice(3);
    const exact = query.get('version')?.slice(3);
    if (!exact) assert.equal(query.get('state_code'), 'eq.100');
    const rows =
      selected === id
        ? content && exact
          ? [{ id, version, state_code: 0, user_id: actor, json: content }]
          : []
        : missing && selected.startsWith('55555555') && exact
          ? []
          : [{ id: selected, version: exact ?? '00.00.002', state_code: 100 }];
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  };
}

test('older published references pass local/reference validation and create/save previews with occurrence advisories', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reference-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const content = makeFlow();
  const validated = await createDatasetPorts(env, transport(null)).validate('flow', content, [
    'schema',
    'business',
    'references',
  ]);
  assert.equal(validated.status, 'passed');
  const warnings = validated.warnings as JsonObject[];
  assert.ok(
    warnings.some((warning) => warning.path === occurrence && warning.code === 'version_outdated'),
  );
  assert.deepEqual((validated.references as JsonObject).blockers, []);
  assert.equal(((validated.references as JsonObject).counts as JsonObject).blockers, 0);
  for (const action of ['create', 'save'] as const) {
    const writer = datasetWriter(env, transport(action === 'save' ? content : null), directory);
    const preview = await writer(
      'flow',
      action,
      {
        id,
        version,
        content,
        requestId: action,
        expectedActor: actor,
        expectedEnvironment: 'https://example.supabase.co',
        ...(action === 'save' ? { expectedContent: content } : {}),
      },
      true,
    );
    assert.equal(preview.outcome, 'preview_completed');
    assert.deepEqual(preview.warnings, warnings);
  }
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith('.json')),
    [],
  );
});

test('missing exact versions retain occurrence/version evidence in qualification errors and public preview/write failures', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reference-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const content = makeFlow();
  const fetchImpl = transport(null, true);
  await assert.rejects(qualifyDatasetWrite('flow', content, env, fetchImpl), (error: unknown) => {
    const failure = error as Error & { code: string; details: { references: JsonObject[] } };
    assert.equal(failure.code, 'REFERENCE_CHECK_FAILED');
    assert.deepEqual(
      failure.details.references.map(({ path, code, table, id, version, latest_version }) => ({
        path,
        code,
        table,
        id,
        version,
        latest_version,
      })),
      [
        {
          path: occurrence,
          code: 'missing_version',
          table: 'flowproperties',
          id: '55555555-5555-5555-5555-555555555555',
          version,
          latest_version: '00.00.002',
        },
      ],
    );
    assert.match(
      String(failure.details.references[0]!.message),
      /requested version does not exist/u,
    );
    return true;
  });
  const ports = createDatasetPorts(env, fetchImpl);
  assert.equal((await ports.validate('flow', content, ['references'])).status, 'failed');
  ports.mutate = datasetWriter(env, fetchImpl, directory);
  const request = {
    id,
    version,
    content,
    requestId: 'missing',
    expectedActor: actor,
    expectedEnvironment: 'https://example.supabase.co',
  };
  for (const dryRun of [true, false]) {
    const io = await runDatasetCommand(
      ['flow', 'create', '--input', '-', '--json', ...(dryRun ? ['--dry-run'] : [])],
      ports,
      () => request,
    );
    const result = JSON.parse(io.stdout);
    assert.equal(io.exitCode, 1);
    assert.equal(result.error.code, 'REFERENCE_CHECK_FAILED');
    assert.equal(result.data.details.references[0].path, occurrence);
    assert.equal(result.data.stage, 'preflight');
    assert.equal(result.data.acknowledged, false);
    assert.equal(result.data.diagnostic.code, 'REFERENCE_CHECK_FAILED');
  }
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith('.json')),
    [],
  );
});

test('latest reads only published versions, readable drafts need no published version, and predecessor links remain historical', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'predecessor-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const key of [
    'referenceToPrecedingDataSetVersion',
    'common:referenceToPrecedingDataSetVersion',
  ]) {
    const content = {
      contactDataSet: {
        contactInformation: { dataSetInformation: { 'common:UUID': id } },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.01.001',
            [key]: { '@type': 'contact data set', '@refObjectId': id, '@version': '01.01.000' },
          },
        },
      },
    };
    const fetchImpl = async (url: string) => {
      if (isSupabaseAuthTokenUrl(url)) return makeSupabaseAuthResponse();
      const query = new URL(url).searchParams;
      const exact = query.get('version')?.slice(3);
      if (!exact) assert.equal(query.get('state_code'), 'eq.100');
      // Owner draft .001 is readable by exact version, but never returned as latest.
      return new Response(JSON.stringify([{ id, version: exact ?? '01.01.000' }]), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const report = await runDatasetRemoteVerify({
      inputPath: '<candidate>',
      rawInput: content,
      outDir: directory,
      env,
      fetchImpl,
    });
    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.counts.by_status.version_outdated, 0);
    assert.equal(
      (await createDatasetPorts(env, fetchImpl).validate('contact', content, ['references']))
        .status,
      'passed',
    );
  }
  const reference: RemoteDatasetReference = {
    row_index: 0,
    role: 'reference',
    table: 'contacts',
    type: 'contact data set',
    id,
    version: '01.01.000',
    path: 'common:referenceToPrecedingDataSetVersion',
    short_description: null,
  };
  const exact = { id, version: reference.version };
  const lookup = {
    exact,
    latest: { id, version: '01.02.000' },
    exact_source_url: null,
    latest_source_url: null,
  };
  for (const path of [
    reference.path,
    'a.referenceToPrecedingDataSetVersion',
    '/a/referenceToPrecedingDataSetVersion/0',
  ])
    assert.equal(classifyCheck({ ...reference, path }, lookup, false, 'existing').status, 'ok');
  assert.equal(
    classifyCheck(reference, { ...lookup, exact: null }, false, 'existing').status,
    'missing_version',
  );
  assert.equal(
    classifyCheck(
      { ...reference, path: '/ordinary' },
      { ...lookup, latest: null },
      false,
      'existing',
    ).status,
    'ok',
  );
  assert.equal(
    classifyCheck({ ...reference, role: 'root' }, { ...lookup, latest: null }, false, 'existing')
      .status,
    'ok',
  );
});

test('advisory policy leaves strict defaults, root checks and all unresolved reference checks blocking', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'strict-reference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const content = {
    refs: [
      { '@type': 'flow data set', '@refObjectId': 'old', '@version': version },
      { '@type': 'flow data set', '@refObjectId': 'missing', '@version': version },
      { '@type': 'flow data set', '@refObjectId': 'invisible', '@version': version },
      { '@type': 'flow data set', '@refObjectId': 'unversioned' },
      { '@type': 'unsupported', '@refObjectId': 'unsupported', '@version': version },
      { '@type': 'flow data set', '@refObjectId': 'failed', '@version': version },
    ],
  };
  const lookupDatasetImpl = async ({ id }: { id: string }) => {
    if (id === 'failed') throw new Error('offline');
    return {
      exact: ['old', 'unversioned'].includes(id) ? { id, version } : null,
      latest: id === 'missing' ? null : { id, version: '00.00.002' },
      exact_source_url: null,
      latest_source_url: null,
    };
  };
  for (const policy of [undefined, 'error', 'advisory'] as const) {
    const report = await runDatasetRemoteVerify({
      inputPath: '<refs>',
      rawInput: content,
      outDir: directory,
      lookupDatasetImpl,
      outdatedReferencePolicy: policy,
    });
    assert.equal(report.status, 'blocked_remote_verification');
    assert.equal(report.counts.by_status.version_outdated, 1);
    assert.equal(report.counts.blockers, policy === 'advisory' ? 5 : 6);
    assert.deepEqual(
      report.blockers.map(({ code }) => code),
      [
        ...(policy === 'advisory' ? [] : ['version_outdated']),
        'missing_dataset',
        'missing_version',
        'version_missing',
        'unsupported_type',
        'lookup_failed',
      ],
    );
    assert.equal(report.warnings?.length, policy === 'advisory' ? 1 : undefined);
  }
  const root = {
    contactDataSet: {
      contactInformation: { dataSetInformation: { 'common:UUID': 'old' } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
  const report = await runDatasetRemoteVerify({
    inputPath: '<root>',
    rawInput: root,
    outDir: directory,
    lookupDatasetImpl,
    outdatedReferencePolicy: 'advisory',
  });
  assert.equal(report.blockers[0]!.code, 'version_outdated');
  assert.deepEqual(report.warnings, []);
});
