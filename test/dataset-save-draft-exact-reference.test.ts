import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { collectRemoteReferences } from '../src/lib/dataset-remote-verify.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import type { FetchLike } from '../src/lib/http.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

type JsonObject = Record<string, unknown>;
const actor = '00000000-0000-4000-8000-000000000090';
const owner = '00000000-0000-4000-8000-000000000091';
const contactId = '44444444-4444-4444-4444-444444444444';
const project = 'abcdefghijklmnopqrst';
const version = '00.00.001';
const latestVersion = '00.00.002';
const fileHash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const response = (body: unknown): Awaited<ReturnType<FetchLike>> => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(body),
});
function localized(text: string): { '@xml:lang': 'en'; '#text': string } {
  return { '@xml:lang': 'en', '#text': text };
}

function reference(type: string, id: string, version: string): JsonObject {
  return {
    '@type': type,
    '@refObjectId': id,
    '@version': version,
    '@uri': `../datasets/${id}_${version}.xml`,
    'common:shortDescription': localized(id),
  };
}

function flow(id: string, name: string): JsonObject {
  return {
    flowDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Flow',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:ecn': 'http://eplca.jrc.ec.europa.eu/ILCD/Extensions/2018/ECNumber',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Flow ../../schemas/ILCD_FlowDataSet.xsd',
      flowInformation: {
        dataSetInformation: {
          'common:UUID': id,
          name: {
            baseName: localized(name),
            treatmentStandardsRoutes: localized('not applicable'),
            mixAndLocationTypes: localized('market'),
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                {
                  '@level': '0',
                  '@classId': '0',
                  '#text': 'Agriculture, forestry and fishery products',
                },
              ],
            },
          },
        },
        quantitativeReference: { referenceToReferenceFlowProperty: '0' },
      },
      modellingAndValidation: {
        LCIMethod: { typeOfDataSet: 'Product flow' },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': reference(
              'source data set',
              '22222222-2222-2222-2222-222222222222',
              '00.00.001',
            ),
            'common:approvalOfOverallCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp': '2026-07-23T00:00:00.000Z',
          'common:referenceToDataSetFormat': reference(
            'source data set',
            '33333333-3333-3333-3333-333333333333',
            '00.00.001',
          ),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
          'common:referenceToOwnershipOfDataSet': reference(
            'contact data set',
            '44444444-4444-4444-4444-444444444444',
            '00.00.001',
          ),
        },
      },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: reference(
            'flow property data set',
            '55555555-5555-5555-5555-555555555555',
            '00.00.001',
          ),
          meanValue: '1.0',
        },
      },
    },
  };
}

function contact(v: string) {
  return {
    contactDataSet: {
      contactInformation: {
        dataSetInformation: {
          'common:UUID': contactId,
          'common:name': v === version ? 'Reviewed definition' : 'Changed definition',
        },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': v } },
    },
  };
}

function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-owner-exact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [
    flow('00000000-0000-4000-8000-000000000001', 'First flow'),
    flow('00000000-0000-4000-8000-000000000002', 'Second flow'),
  ];
  for (const row of rows) {
    const admin = (row.flowDataSet as JsonObject).administrativeInformation as JsonObject;
    (admin.dataEntryBy as JsonObject)['common:referenceToPersonOrEntityEnteringTheData'] =
      reference('contact data set', contactId, version);
  }
  const input = path.join(root, 'rows.json');
  const intentFile = path.join(root, 'intent.json');
  const reviewFile = path.join(root, 'review.json');
  const contractFile = path.join(root, 'contract.json');
  const consumers = rows.map((row, row_index) => ({
    row_index,
    table: 'flows',
    id:
      ((row.flowDataSet as JsonObject).flowInformation as JsonObject).dataSetInformation &&
      (
        ((row.flowDataSet as JsonObject).flowInformation as JsonObject)
          .dataSetInformation as JsonObject
      )['common:UUID'],
    version,
    payload_sha256: sha256Json(row),
  }));
  const selected = {
    table: 'contacts',
    id: contactId,
    version,
    payload_sha256: sha256Json(contact(version)),
    user_id: owner,
    state_code: 100,
  };
  const review = {
    schema_version: 'dataset-exact-reference-review.v1',
    decision: 'use_selected_exact',
    reason: 'Retain the reviewed complete Contact definition for these consumers.',
    selected,
    latest: {
      ...selected,
      version: latestVersion,
      payload_sha256: sha256Json(contact(latestVersion)),
    },
  };
  write(reviewFile, review);
  const intent = {
    schema_version: 'dataset-exact-reference-intent.v1',
    project_ref: project,
    actor_user_id: actor,
    consumers,
    references: collectRemoteReferences(rows)
      .filter((ref) => ref.role === 'reference' && ref.table === 'contacts')
      .map((ref) => ({
        row_index: ref.row_index,
        path: ref.path,
        selected,
        review: { file: reviewFile, sha256: fileHash(reviewFile) },
      })),
  };
  const contract = {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: 'owner-exact-reference-regression',
    project_ref: project,
    target_mode: 'owner_draft',
    owner: { user_id: actor, email: 'user@example.com', state_code: 0 },
    actions: consumers.map((c) => ({
      action_id: `flow-${c.row_index}`,
      desired_sha256: c.payload_sha256,
      expected_operation: 'insert',
      table: c.table,
      id: c.id,
      version,
      before_sha256: null,
      dependency_action_ids: [],
    })),
  };
  write(input, rows);
  write(intentFile, intent);
  write(contractFile, contract);
  const state = new Map<string, JsonObject>();
  const writes: JsonObject[] = [];
  const calls: string[] = [];
  const controls: {
    onRequest?: (url: URL) => void | Promise<void>;
    transform?: (url: URL, value: unknown) => unknown;
    payloadReadFailure?: boolean;
    latestBody: JsonObject;
    selectedBody: JsonObject;
    writeBehavior?: 'lost_after_write' | 'lost_before_write';
  } = { latestBody: contact(latestVersion), selectedBody: contact(version) };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: actor, email: 'user@example.com' })).toString('base64url')}.signature`;
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
    TIANGONG_LCA_ACCESS_TOKEN: token,
    XDG_STATE_HOME: path.join(root, 'state'),
  });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    await controls.onRequest?.(url);
    const respond = (body: unknown) =>
      response(controls.transform ? controls.transform(url, body) : body);
    if (url.pathname.startsWith('/auth/'))
      return respond({ id: actor, sub: actor, email: 'user@example.com' });
    if (url.pathname.startsWith('/functions/')) {
      assert.ok(
        ['/functions/v1/app_dataset_create', '/functions/v1/app_dataset_save_draft'].includes(
          url.pathname,
        ),
      );
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.ruleVerification, true);
      assert.equal(body.table, 'flows');
      writes.push(body);
      if (controls.writeBehavior !== 'lost_before_write')
        state.set(body.id as string, body.jsonOrdered as JsonObject);
      if (controls.writeBehavior) throw new Error('Simulated lost response');
      return respond({ ok: true, operation: 'insert' });
    }
    const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
    const v = url.searchParams.get('version')?.replace(/^eq\./u, '');
    const table = url.pathname.split('/').at(-1);
    if (
      table === 'contacts' &&
      controls.payloadReadFailure &&
      url.searchParams.get('select')?.includes('json_ordered')
    ) {
      return { ...response({ message: 'private response must not leak' }), ok: false, status: 400 };
    }
    if (table === 'flows')
      return respond(
        id && state.has(id)
          ? [{ id, version, user_id: actor, state_code: 0, json_ordered: state.get(id) }]
          : [],
      );
    if (table === 'contacts') {
      const observed = v ?? latestVersion;
      return respond([
        {
          id: contactId,
          version: observed,
          user_id: owner,
          state_code: 100,
          json_ordered: observed === version ? controls.selectedBody : controls.latestBody,
        },
      ]);
    }
    if (table === 'sources' || table === 'flowproperties') return respond([{ id, version }]);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  let run = 0;
  const invoke = (verb: 'save-draft' | 'verify-remote', flags: string[]) =>
    executeCli(
      [
        'dataset',
        verb,
        '--input',
        input,
        '--out-dir',
        path.join(root, `run-${++run}`),
        '--json',
        ...flags,
      ],
      { env, dotEnvStatus: { loaded: false, path: path.join(root, '.env'), count: 0 }, fetchImpl },
    );
  return {
    root,
    rows,
    input,
    intent,
    intentFile,
    review,
    reviewFile,
    contract,
    contractFile,
    state,
    writes,
    calls,
    env,
    fetchImpl,
    invoke,
    controls,
  };
}

test('public Flow owner preflight admits the same four exact Contact occurrences accepted by verify-remote', async (t) => {
  const f = fixture(t);
  const verified = await f.invoke('verify-remote', [
    '--root-policy',
    'candidate',
    '--reference-intent-file',
    f.intentFile,
  ]);
  assert.equal(verified.exitCode, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).counts.by_status.ok, 12);
  const defaultRun = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--dry-run',
  ]);
  const defaultReport = JSON.parse(defaultRun.stdout);
  assert.equal(defaultReport.counts.failed, 2);
  assert.equal(defaultReport.rows[0].error.details.references[0].status, 'version_outdated');
  const admitted = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--reference-intent-file',
    f.intentFile,
    '--dry-run',
  ]);
  assert.equal(admitted.exitCode, 0, admitted.stderr || admitted.stdout);
  const report = JSON.parse(admitted.stdout);
  assert.equal(report.counts.prepared, 2);
  assert.equal(report.counts.attempts_consumed, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.input, 'utf8')), f.rows);
});

test('public exact-reference commits retain action evidence and never renew consumed writes', async (t) => {
  const f = fixture(t);
  const flags = [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--reference-intent-file',
    f.intentFile,
    '--commit',
  ];
  const first = await f.invoke('save-draft', flags);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.counts.executed, 2);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(
    f.writes.map((body) => body.jsonOrdered),
    f.rows,
  );
  for (const row of report.rows) {
    assert.equal(row.reference_intent_admission.intent_file.sha256, fileHash(f.intentFile));
    assert.equal(row.reference_intent_admission.references.length, 2);
  }
  const recovered = await f.invoke('save-draft', flags);
  assert.equal(recovered.exitCode, 0, recovered.stderr || recovered.stdout);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(
    JSON.parse(recovered.stdout).rows.map((row: JsonObject) => row.reference_intent_admission),
    report.rows.map((row: JsonObject) => row.reference_intent_admission),
  );
  const omitted = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--commit',
  ]);
  assert.equal(omitted.exitCode, 1);
  const retained = JSON.parse(omitted.stdout);
  assert.equal(retained.counts.attempts_consumed, 2);
  assert.equal(retained.counts.unknown, 2);
  assert.equal(f.writes.length, 2);
});

test('selected body drift between preflight and immediate dispatch consumes no attempt', async (t) => {
  const f = fixture(t);
  let identityReads = 0;
  f.controls.onRequest = (url) => {
    if (url.pathname === '/auth/v1/user' && ++identityReads === 2)
      f.controls.selectedBody = { ...contact(version), changed: true };
  };
  const result = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--reference-intent-file',
    f.intentFile,
    '--commit',
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
});

const ownerFlags = (f: ReturnType<typeof fixture>, commit = false) => [
  '--type',
  'flow',
  '--execution-contract',
  f.contractFile,
  '--reference-intent-file',
  f.intentFile,
  commit ? '--commit' : '--dry-run',
];
const rewriteIntent = (f: ReturnType<typeof fixture>) => write(f.intentFile, f.intent);
const rewriteReview = (f: ReturnType<typeof fixture>) => {
  write(f.reviewFile, f.review);
  for (const pin of f.intent.references) pin.review.sha256 = fileHash(f.reviewFile);
  rewriteIntent(f);
};

for (const [name, change] of Object.entries({
  'unknown field': (f: ReturnType<typeof fixture>) =>
    write(f.intentFile, { ...f.intent, ambient: true }),
  'invalid JSON': (f: ReturnType<typeof fixture>) => fs.writeFileSync(f.intentFile, '{'),
  'duplicate occurrence': (f: ReturnType<typeof fixture>) => {
    f.intent.references.push(f.intent.references[0]!);
    rewriteIntent(f);
  },
  'unused occurrence': (f: ReturnType<typeof fixture>) => {
    f.intent.references[0]!.path = '/absent';
    rewriteIntent(f);
  },
  'root occurrence': (f: ReturnType<typeof fixture>) => {
    f.intent.references[0]!.path = '/flowDataSet';
    rewriteIntent(f);
  },
  'stale consumer': (f: ReturnType<typeof fixture>) => {
    write(f.input, [{ ...f.rows[0], changed: true }, f.rows[1]]);
  },
  'wrong intent actor': (f: ReturnType<typeof fixture>) => {
    f.intent.actor_user_id = owner;
    rewriteIntent(f);
  },
  'wrong project': (f: ReturnType<typeof fixture>) => {
    f.intent.project_ref = 'zzzzzzzzzzzzzzzzzzzz';
    rewriteIntent(f);
  },
  'review bytes changed': (f: ReturnType<typeof fixture>) => {
    fs.appendFileSync(f.reviewFile, ' ');
  },
  'foreign draft selected': (f: ReturnType<typeof fixture>) => {
    f.review.selected.state_code = 0;
    for (const pin of f.intent.references) pin.selected.state_code = 0;
    rewriteReview(f);
  },
  'selected version is not declared': (f: ReturnType<typeof fixture>) => {
    f.intent.references[0]!.selected.version = '00.00.009';
    rewriteIntent(f);
  },
}))
  test(`owner exact selection rejects ${name} before dispatch`, async (t) => {
    const f = fixture(t);
    change(f);
    const result = await f.invoke('save-draft', ownerFlags(f, true));
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.equal(f.writes.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  });

test('a selected occurrence never exempts an undeclared occurrence of the same Contact', async (t) => {
  const f = fixture(t);
  f.intent.references.splice(0, 1);
  rewriteIntent(f);
  const result = await f.invoke('save-draft', ownerFlags(f));
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.prepared, 1);
  assert.equal(report.rows[0].error.details.references[0].status, 'version_outdated');
  assert.equal(f.writes.length, 0);
});

for (const [name, transform] of Object.entries({
  'selected owner': (rows: JsonObject[]) => rows.map((row) => ({ ...row, user_id: actor })),
  'selected private state': (rows: JsonObject[]) => rows.map((row) => ({ ...row, state_code: 20 })),
  'selected body': (rows: JsonObject[]) =>
    rows.map((row) => ({ ...row, json_ordered: { ...contact(version), changed: true } })),
  'embedded identity': (rows: JsonObject[]) =>
    rows.map((row) => ({ ...row, json_ordered: contact(latestVersion) })),
  'ambiguous exact row': (rows: JsonObject[]) => [...rows, ...rows],
  'missing exact row': () => [],
}))
  test(`owner admission rejects ${name} drift with no mutation`, async (t) => {
    const f = fixture(t);
    f.controls.transform = (url, value) =>
      url.pathname.endsWith('/contacts') && url.searchParams.has('version')
        ? transform(value as JsonObject[])
        : value;
    const result = await f.invoke('save-draft', ownerFlags(f, true));
    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.equal(f.writes.length, 0);
    assert.equal(JSON.parse(result.stdout).counts.attempts_consumed, 0);
  });

for (const name of [
  'latest body',
  'latest owner',
  'latest state',
  'latest absent',
  'lookup error',
  'authenticated actor',
])
  test(`owner admission rejects ${name} drift`, async (t) => {
    const f = fixture(t);
    f.controls.payloadReadFailure = name === 'lookup error';
    f.controls.transform = (url, value) => {
      if (name === 'authenticated actor' && url.pathname === '/auth/v1/user')
        return { id: owner, email: 'user@example.com' };
      if (!url.pathname.endsWith('/contacts') || url.searchParams.has('version')) return value;
      const rows = value as JsonObject[];
      if (name === 'latest body')
        return rows.map((row) => ({
          ...row,
          json_ordered: { ...contact(latestVersion), changed: true },
        }));
      if (name === 'latest owner') return rows.map((row) => ({ ...row, user_id: actor }));
      if (name === 'latest state') return rows.map((row) => ({ ...row, state_code: 20 }));
      if (name === 'latest absent') return [];
      return value;
    };
    const result = await f.invoke('save-draft', ownerFlags(f, true));
    assert.equal(result.exitCode, 1, result.stderr || result.stdout);
    assert.equal(f.writes.length, 0);
    assert.ok(!JSON.stringify(result).includes('private response must not leak'));
    if (name === 'lookup error')
      assert.equal(
        JSON.parse(result.stdout).rows[0].error.details.references[0].status,
        'lookup_failed',
      );
  });

for (const [name, change] of Object.entries({
  'review file': (f: ReturnType<typeof fixture>) => fs.appendFileSync(f.reviewFile, ' '),
  'intent file': (f: ReturnType<typeof fixture>) => fs.appendFileSync(f.intentFile, ' '),
  'consumer file': (f: ReturnType<typeof fixture>) =>
    write(f.input, [{ ...f.rows[0], changed: true }, f.rows[1]]),
  'insert before state': (f: ReturnType<typeof fixture>) =>
    f.state.set(f.contract.actions[0]!.id as string, f.rows[0]!),
}))
  test(`immediate dispatch rejects ${name} drift without consuming`, async (t) => {
    const f = fixture(t);
    let identityReads = 0;
    f.controls.onRequest = (url) => {
      if (url.pathname === '/auth/v1/user' && ++identityReads === 2) change(f);
    };
    const result = await f.invoke('save-draft', ownerFlags(f, true));
    assert.equal(result.exitCode, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
  });

test('deferred immediate admission is awaited and a rejection cannot dispatch', async (t) => {
  const f = fixture(t);
  let identityReads = 0;
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controls.onRequest = async (url) => {
    if (url.pathname === '/auth/v1/user' && ++identityReads === 2) {
      reached();
      await gate;
      f.controls.latestBody = { ...contact(latestVersion), changed: true };
    }
  };
  const pending = f.invoke('save-draft', ownerFlags(f, true));
  await entered;
  assert.equal(f.writes.length, 0);
  release();
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(f.writes.length, 0);
});

for (const behavior of ['lost_after_write', 'lost_before_write'] as const)
  test(`exact admission survives ${behavior} with no replay`, async (t) => {
    const f = fixture(t);
    f.controls.writeBehavior = behavior;
    const first = await f.invoke('save-draft', ownerFlags(f, true));
    const original = JSON.parse(first.stdout);
    assert.equal(original.counts.attempts_consumed, 2);
    assert.equal(original.counts[behavior === 'lost_after_write' ? 'executed' : 'unknown'], 2);
    f.controls.writeBehavior = undefined;
    const second = await f.invoke('save-draft', ownerFlags(f, true));
    const retained = JSON.parse(second.stdout);
    assert.equal(f.writes.length, 2);
    assert.equal(retained.counts[behavior === 'lost_after_write' ? 'executed' : 'unknown'], 2);
    assert.deepEqual(
      retained.rows.map((row: JsonObject) => row.reference_intent_admission),
      original.rows.map((row: JsonObject) => row.reference_intent_admission),
    );
  });

test('an unresolved attempt retains its original evidence through readback recovery', async (t) => {
  const f = fixture(t);
  const first = await f.invoke('save-draft', ownerFlags(f, true));
  const report = JSON.parse(first.stdout);
  const ledgers = fs
    .readdirSync(report.files.execution_ledger)
    .map((file) => path.join(report.files.execution_ledger, file));
  for (const file of ledgers) {
    const attempt = fs.readFileSync(file, 'utf8').split('\n')[0]!;
    fs.writeFileSync(file, `${attempt}\n`);
  }
  const result = await f.invoke('save-draft', ownerFlags(f, true));
  const recovered = JSON.parse(result.stdout);
  assert.equal(recovered.counts.executed, 2);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(
    recovered.rows.map((row: JsonObject) => row.reference_intent_admission),
    report.rows.map((row: JsonObject) => row.reference_intent_admission),
  );
  assert.ok(
    recovered.rows.every((row: JsonObject) => row.operation === 'recovered_exact_readback'),
  );
});

test('changing reviewed selection after consumption cannot retrofit or replay the action', async (t) => {
  const f = fixture(t);
  const first = await f.invoke('save-draft', ownerFlags(f, true));
  const report = JSON.parse(first.stdout);
  f.review.reason = 'A different review document is not the consumed selection';
  rewriteReview(f);
  const result = await f.invoke('save-draft', ownerFlags(f, true));
  const retained = JSON.parse(result.stdout);
  assert.equal(retained.counts.unknown, 2);
  assert.equal(retained.counts.attempts_consumed, 2);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(
    retained.rows.map((row: JsonObject) => row.reference_intent_admission),
    report.rows.map((row: JsonObject) => row.reference_intent_admission),
  );
});

test('same-version and current-owner draft selected definitions use the shared eligibility policy', async (t) => {
  const f = fixture(t);
  Object.assign(f.review.selected, { user_id: actor, state_code: 0 });
  f.review.latest = { ...f.review.selected };
  rewriteReview(f);
  f.controls.transform = (url, value) =>
    url.pathname.endsWith('/contacts')
      ? [{ id: contactId, version, user_id: actor, state_code: 0, json_ordered: contact(version) }]
      : value;
  const result = await f.invoke('save-draft', ownerFlags(f, true));
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(f.writes.length, 2);
});

test('exact reference selection preserves the complete guarded save before image', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.rows[0]!);
  (
    ((before.flowDataSet as JsonObject).flowInformation as JsonObject)
      .dataSetInformation as JsonObject
  ).name = {
    baseName: localized('Prior flow'),
    treatmentStandardsRoutes: localized('not applicable'),
    mixAndLocationTypes: localized('market'),
  };
  f.state.set(f.contract.actions[0]!.id as string, before);
  Object.assign(f.contract.actions[0]!, {
    expected_operation: 'save_draft',
    before_sha256: sha256Json(before),
  });
  write(f.contractFile, f.contract);
  const result = await f.invoke('save-draft', ownerFlags(f, true));
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.deepEqual(f.writes[0]!.expectedJsonOrdered, before);
  assert.deepEqual(f.writes[0]!.jsonOrdered, f.rows[0]);
});

test('preflight after consumption reports the original admission without changing the ledger', async (t) => {
  const f = fixture(t);
  const first = await f.invoke('save-draft', ownerFlags(f, true));
  const report = JSON.parse(first.stdout);
  const files = fs
    .readdirSync(report.files.execution_ledger)
    .map((file) => path.join(report.files.execution_ledger, file));
  const hashes = files.map(fileHash);
  const same = await f.invoke('save-draft', ownerFlags(f));
  const retained = JSON.parse(same.stdout);
  assert.equal(retained.counts.blocked, 2);
  assert.equal(retained.counts.attempts_consumed, 2);
  assert.deepEqual(
    retained.rows.map((row: JsonObject) => row.reference_intent_admission),
    report.rows.map((row: JsonObject) => row.reference_intent_admission),
  );
  const omitted = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--dry-run',
  ]);
  assert.equal(JSON.parse(omitted.stdout).counts.blocked, 2);
  assert.deepEqual(files.map(fileHash), hashes);
  assert.equal(f.writes.length, 2);
});

test('an old default-policy attempt cannot acquire a new exact admission during recovery', async (t) => {
  const f = fixture(t);
  f.controls.transform = (url, value) =>
    url.pathname.endsWith('/contacts') ? [{ id: contactId, version }] : value;
  const first = await f.invoke('save-draft', [
    '--type',
    'flow',
    '--execution-contract',
    f.contractFile,
    '--commit',
  ]);
  assert.equal(first.exitCode, 0, first.stderr || first.stdout);
  assert.equal(f.writes.length, 2);
  f.controls.transform = undefined;
  const second = await f.invoke('save-draft', ownerFlags(f, true));
  const report = JSON.parse(second.stdout);
  assert.equal(report.counts.unknown, 2);
  assert.equal(report.counts.attempts_consumed, 2);
  assert.equal(f.writes.length, 2);
  assert.ok(report.rows.every((row: JsonObject) => row.reference_intent_admission === undefined));
});

test('public selection rejects duplicate, empty, unguarded and non-Flow invocations', async (t) => {
  const f = fixture(t);
  for (const flags of [
    [...ownerFlags(f), '--reference-intent-file', f.intentFile],
    ['--type', 'flow', '--execution-contract', f.contractFile, '--reference-intent-file', ''],
    ['--type', 'flow', '--reference-intent-file', f.intentFile],
    [
      '--type',
      'source',
      '--execution-contract',
      f.contractFile,
      '--reference-intent-file',
      f.intentFile,
    ],
  ]) {
    const result = await f.invoke('save-draft', flags);
    assert.notEqual(result.exitCode, 0);
  }
  assert.equal(f.writes.length, 0);
});

const corruptAdmissions: Record<string, (admission: JsonObject) => void> = {
  schema: (a) => {
    a.schema_version = 'unsupported';
  },
  'consumer normalization': (a) => {
    (a.consumer as JsonObject).id = 'ABCDEFAB-1234-4000-8000-000000000001';
  },
  'occurrence path': (a) => {
    (a.references as JsonObject[])[0]!.path = '';
  },
  'snapshot state': (a) => {
    ((a.references as JsonObject[])[0]!.selected as JsonObject).state_code = 20;
  },
  'selected normalization': (a) => {
    ((a.references as JsonObject[])[0]!.selected as JsonObject).id =
      'ABCDEFAB-1234-4000-8000-000000000001';
  },
  'latest normalization': (a) => {
    (((a.references as JsonObject[])[0]!.review as JsonObject).latest as JsonObject).id =
      'ABCDEFAB-1234-4000-8000-000000000001';
  },
  'latest identity': (a) => {
    (((a.references as JsonObject[])[0]!.review as JsonObject).latest as JsonObject).id = actor;
  },
  'same-version contradictory content': (a) => {
    (((a.references as JsonObject[])[0]!.review as JsonObject).latest as JsonObject).version =
      version;
  },
  'action consumer': (a) => {
    (a.consumer as JsonObject).id = actor;
  },
  'action version': (a) => {
    (a.consumer as JsonObject).version = latestVersion;
  },
  'action body': (a) => {
    (a.consumer as JsonObject).payload_sha256 = 'f'.repeat(64);
  },
  project: (a) => {
    a.project_ref = 'zzzzzzzzzzzzzzzzzzzz';
  },
  actor: (a) => {
    a.actor_user_id = owner;
  },
  'selection binding': (a) => {
    a.selection_sha256 = 'f'.repeat(64);
  },
};
for (const [name, corrupt] of Object.entries(corruptAdmissions))
  test(`retained admission rejects ${name} tampering even with recomputed event hashes`, async (t) => {
    const f = fixture(t);
    const first = await f.invoke('save-draft', ownerFlags(f, true));
    const report = JSON.parse(first.stdout);
    const file = path.join(
      report.files.execution_ledger,
      fs.readdirSync(report.files.execution_ledger)[0]!,
    );
    const events = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    let previous: string | null = null;
    for (const event of events) {
      corrupt(event.reference_intent_admission);
      event.previous_event_sha256 = previous;
      delete event.event_sha256;
      event.event_sha256 = sha256Json(event);
      previous = event.event_sha256;
    }
    fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const result = await f.invoke('save-draft', ownerFlags(f, true));
    assert.notEqual(result.exitCode, 0);
    assert.equal(f.writes.length, 2);
  });

test('an outcome cannot drop the admission bound by its original attempt', async (t) => {
  const f = fixture(t);
  const first = await f.invoke('save-draft', ownerFlags(f, true));
  const report = JSON.parse(first.stdout);
  const file = path.join(
    report.files.execution_ledger,
    fs.readdirSync(report.files.execution_ledger)[0]!,
  );
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  delete events[1].reference_intent_admission;
  delete events[1].event_sha256;
  events[1].event_sha256 = sha256Json(events[1]);
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const result = await f.invoke('save-draft', ownerFlags(f, true));
  assert.notEqual(result.exitCode, 0);
  assert.equal(f.writes.length, 2);
});
