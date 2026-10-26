import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import {
  assertFlowIdentityAdmissionInputsCurrent,
  assertFlowIdentityAdmissionUnexpired,
  flowIdentityAdmissionActionCoreSha256,
  flowIdentityAdmissionSummary,
  isFlowIdentityAdmissionSummary,
  loadFlowIdentityAdmission,
  runFlowIdentityAdmissionPrepare,
  type FlowIdentityAdmissionAction,
} from '../src/lib/flow-identity-admission.js';
import { runFlowIdentityPreflight } from '../src/lib/identity-preflight.js';

type Obj = Record<string, unknown>;
const ownerId = '00000000-0000-4000-8000-000000000090';
const targetId = '00000000-0000-4000-8000-000000000001';
const candidateId = '00000000-0000-4000-8000-000000000002';
const project = 'abcdefghijklmnopqrst';
const now = new Date('2026-10-20T00:00:01.000Z');
const account = { user_id: ownerId, email: 'owner@example.com', state_code: 0 as const };
const version = '01.00.000';
function write(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}
function fact(file: string) {
  const bytes = readFileSync(file);
  return {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
function loc(value: string) {
  return { '@xml:lang': 'en', '#text': value };
}
function ref(type: string, id: string) {
  return {
    '@type': type,
    '@refObjectId': id,
    '@version': version,
    '@uri': `../datasets/${id}_${version}.xml`,
    'common:shortDescription': loc(id),
  };
}
function flow(id: string, route: string) {
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
            baseName: loc('Soil service'),
            treatmentStandardsRoutes: loc(route),
            mixAndLocationTypes: loc('market'),
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
            'common:referenceToComplianceSystem': ref(
              'source data set',
              '22222222-2222-2222-2222-222222222222',
            ),
            'common:approvalOfOverallCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp': '2026-07-23T00:00:00.000Z',
          'common:referenceToDataSetFormat': ref(
            'source data set',
            '33333333-3333-3333-3333-333333333333',
          ),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': version,
          'common:referenceToOwnershipOfDataSet': ref(
            'contact data set',
            '44444444-4444-4444-4444-444444444444',
          ),
        },
      },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: ref(
            'flow property data set',
            '55555555-5555-5555-5555-555555555555',
          ),
          meanValue: '1.0',
        },
      },
    },
  };
}

async function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = Object.fromEntries(
    [
      'input',
      'preflight',
      'review',
      'coverage',
      'contract',
      'science',
      'authority',
      'adoption',
    ].map((name) => [name, path.join(root, `${name}.json`)]),
  ) as Record<string, string>;
  const target = flow(targetId, 'Risk management');
  const candidate = flow(candidateId, 'Complete cleanup');
  const candidateRow = {
    id: candidateId,
    version,
    state_code: 100,
    user_id: null,
    json_ordered: candidate,
  };
  const input = { target, candidates: [candidateRow] };
  write(files.input!, input);
  const preflight = await runFlowIdentityPreflight({ inputPath: files.input!, now });
  assert.equal(preflight.status, 'needs_review');
  assert.equal(preflight.target.schema_validation.status, 'passed');
  write(files.preflight!, preflight);
  write(files.science!, { agent: 'independent', conclusion: 'Distinct task services' });
  write(files.authority!, { standing: 'Synthetic authorized task evidence' });
  write(files.adoption!, { host: 'root', adoption: 'Scoped evidence adopted for this task' });
  const coverage = {
    schema_version: 'flow-identity-coverage.v1',
    scope: 'bounded_visible_search',
    project_ref: project,
    observed_at_utc: '2026-10-20T00:00:00.000Z',
    limitations: ['Only the selected visible family was searched.'],
    queries: [
      {
        kind: 'flow_family',
        visibility: 'public',
        ids: [candidateId],
        type_of_dataset: 'Product flow',
        snapshots: [
          { id: candidateId, version, user_id: null, state_code: 100, payload: candidate },
        ],
      },
    ],
  };
  write(files.coverage!, coverage);
  const action = {
    action_id: 'original-flow-operation',
    desired_sha256: sha256Json(target),
    expected_operation: 'insert',
    table: 'flows',
    id: targetId,
    version,
    before_sha256: null,
    dependency_action_ids: [],
  };
  const template = {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: 'original-execution',
    project_ref: project,
    target_mode: 'owner_draft',
    owner: account,
    actions: [action],
  };
  write(files.contract!, template);
  const review = {
    schema_version: 'flow-identity-review.v1',
    decision: 'create_distinct',
    target: { id: targetId, version, payload_sha256: sha256Json(target) },
    preflight: { input: fact(files.input!), report: fact(files.preflight!) },
    reviewer: {
      kind: 'agent',
      source_host_thread_id: 'root-thread',
      agent_id: 'independent-reviewer',
      reviewed_at_utc: now.toISOString(),
      report: fact(files.science!),
    },
    authorization: {
      principles: fact(files.authority!),
      authorization_chain: [fact(files.authority!)],
      assignment: fact(files.adoption!),
      clauses: ['P1', 'P4'],
      scope: 'This single necessary draft',
    },
    adopted_by: { host_thread_id: 'root-thread', evidence: fact(files.adoption!) },
    scope: {
      project_ref: project,
      owner_user_id: ownerId,
      target_mode: 'owner_draft',
      operation: 'insert',
    },
    candidate_decisions: [
      {
        id: candidateId,
        version,
        payload_sha256: sha256Json(candidate),
        decision: 'distinct',
        reason: 'Different service endpoint',
        evidence: [fact(files.science!)],
      },
    ],
    coverage: {
      file: fact(files.coverage!),
      sufficiency_reason:
        'Known family and actual service endpoints are compared for this scoped draft.',
      limitations: coverage.limitations,
    },
    validity: { reviewed_at_utc: now.toISOString(), expires_at_utc: '2026-10-21T00:00:01.000Z' },
    reuse_identity: null as { id: string; version: string } | null,
  };
  const options = {
    inputPath: files.input!,
    preflightPath: files.preflight!,
    reviewPath: files.review!,
    coveragePath: files.coverage!,
    executionContractPath: files.contract!,
    outDir: path.join(root, 'output'),
    now,
  };
  const prepare = async () => {
    write(files.review!, review);
    return runFlowIdentityAdmissionPrepare(options);
  };
  const load = async (result: Awaited<ReturnType<typeof prepare>>) => {
    const selected = JSON.parse(readFileSync(result.files.execution_contract!, 'utf8')) as {
      actions: FlowIdentityAdmissionAction[];
    };
    const args = {
      contractPath: result.files.execution_contract!,
      contractSha256: result.execution_contract_sha256!,
      action: selected.actions[0]!,
      owner: account,
      projectRef: project,
    };
    return { loaded: await loadFlowIdentityAdmission(args), args };
  };
  return { root, files, input, coverage, action, template, review, options, prepare, load };
}

test('Agent review prepares an immutable v2 contract, rechecks every file and keeps expiry outside recovery load', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  assert.equal(result.status, 'prepared_for_recheck');
  const { loaded } = await f.load(result);
  assert.equal(loaded.contractSha256, fact(result.files.execution_contract!).sha256);
  assert.equal(
    flowIdentityAdmissionActionCoreSha256(loaded.action),
    loaded.receipt.action_core_sha256,
  );
  const summary = flowIdentityAdmissionSummary(loaded);
  assert.ok(isFlowIdentityAdmissionSummary(summary));
  assert.equal(summary.target.payload_sha256, f.action.desired_sha256);
  assertFlowIdentityAdmissionInputsCurrent(loaded);
  assertFlowIdentityAdmissionUnexpired(loaded, now);
  assertFlowIdentityAdmissionUnexpired(
    {
      receipt: {
        validity: {
          reviewed_at_utc: '2000-01-01T00:00:00Z',
          expires_at_utc: '2000-01-02T00:00:00Z',
        },
      },
    },
    new Date('2000-01-01T01:00:00Z'),
  );
  assert.throws(
    () => assertFlowIdentityAdmissionUnexpired(loaded, new Date('2026-10-21T00:00:01Z')),
    /not currently valid/u,
  );
  assert.throws(
    () => assertFlowIdentityAdmissionUnexpired(loaded, new Date('2026-10-19T00:00:00Z')),
    /not currently valid/u,
  );
  assert.throws(
    () => assertFlowIdentityAdmissionUnexpired(loaded, new Date(NaN)),
    /not currently valid/u,
  );
  // A plain load intentionally performs no wall-clock expiry gate: consumed attempts may recover.
  await f.load(result);
  await assert.rejects(f.prepare, /directory must be new/u);
  writeFileSync(f.files.science!, 'modified');
  assert.throws(() => assertFlowIdentityAdmissionInputsCurrent(loaded), /evidence file changed/u);
  await assert.rejects(() => f.load(result), /evidence file changed/u);
  for (const invalid of [
    null,
    {},
    { ...summary, profile: 'other' },
    { ...summary, contract_sha256: 'bad' },
    { ...summary, receipt: { ...summary.receipt, path: 'relative.json' } },
    { ...summary, target: { ...summary.target, version: 'bad' } },
  ]) {
    assert.equal(isFlowIdentityAdmissionSummary(invalid), false);
  }
});

for (const mode of ['retain', 'missing_target_query', 'reuse_other_type']) {
  test(`typed coverage preserves original cross-type evidence: ${mode}`, async (t) => {
    const f = await fixture(t);
    const candidate = f.input.candidates[0]!.json_ordered;
    candidate.flowDataSet.modellingAndValidation.LCIMethod.typeOfDataSet = 'Waste flow';
    f.coverage.queries[0]!.type_of_dataset = 'Waste flow';
    if (mode !== 'missing_target_query') {
      f.coverage.queries.push({
        kind: 'flow_family',
        visibility: 'public',
        ids: [targetId],
        type_of_dataset: 'Product flow',
        snapshots: [],
      });
    }
    write(f.files.input!, f.input);
    write(f.files.preflight!, await runFlowIdentityPreflight({ inputPath: f.files.input!, now }));
    write(f.files.coverage!, f.coverage);
    f.review.preflight.input = fact(f.files.input!);
    f.review.preflight.report = fact(f.files.preflight!);
    f.review.coverage.file = fact(f.files.coverage!);
    f.review.candidate_decisions[0]!.payload_sha256 = sha256Json(candidate);
    if (mode === 'reuse_other_type') {
      f.review.decision = 'reuse';
      f.review.reuse_identity = { id: candidateId, version };
      f.review.candidate_decisions[0]!.decision = 'reuse';
      await assert.rejects(f.prepare, /same Flow type/u);
    } else if (mode === 'missing_target_query') {
      await assert.rejects(f.prepare, /query for the target Flow type/u);
    } else {
      const result = await f.prepare();
      assert.equal(result.status, 'prepared_for_recheck');
      const { loaded } = await f.load(result);
      assert.equal(loaded.coverage.queries.length, 2);
      assert.equal(
        sha256Json(loaded.coverage.queries[0]!.snapshots[0]!.payload),
        sha256Json(candidate),
      );
    }
  });
}

test('reuse produces only an exact existing identity and no executable insert receipt', async (t) => {
  const f = await fixture(t);
  f.review.decision = 'reuse';
  f.review.reuse_identity = { id: candidateId, version };
  f.review.candidate_decisions[0]!.decision = 'reuse';
  const result = await f.prepare();
  assert.equal(result.status, 'no_new_insert');
  assert.equal(result.files.execution_contract, null);
  assert.equal(result.files.receipt, null);
  assert.deepEqual(result.reuse_identity, { id: candidateId, version });
  assert.match(readFileSync(result.files.reuse!, 'utf8'), /no_new_insert/u);
});

test('every additional complete discovered candidate requires an adopted decision', async (t) => {
  const f = await fixture(t);
  const id = '00000000-0000-4000-8000-000000000003';
  const payload = flow(id, 'Alternative bounded service');
  f.coverage.queries[0]!.ids.push(id);
  f.coverage.queries[0]!.snapshots.push({ id, version, user_id: null, state_code: 100, payload });
  write(f.files.coverage!, f.coverage);
  f.review.coverage.file = fact(f.files.coverage!);
  await assert.rejects(f.prepare, /every complete discovered candidate/u);
  f.review.candidate_decisions.push({
    id,
    version,
    payload_sha256: sha256Json(payload),
    decision: 'not_applicable',
    reason: 'The discovered service does not satisfy this task endpoint.',
    evidence: [fact(f.files.science!)],
  });
  const result = await f.prepare();
  await f.load(result);
  const instant = Date.now();
  assertFlowIdentityAdmissionUnexpired({
    receipt: {
      validity: {
        reviewed_at_utc: new Date(instant - 1000).toISOString(),
        expires_at_utc: new Date(instant + 1000).toISOString(),
      },
    },
  });
});

test('historical published candidate bodies remain exact comparison evidence despite current SDK errors', async (t) => {
  const f = await fixture(t);
  const candidate = f.input.candidates[0]!.json_ordered;
  candidate.flowDataSet.flowProperties.flowProperty.meanValue = 'historical-invalid-number';
  const diagnostic = await runFlowIdentityPreflight({
    inputPath: f.files.input!,
    rawInput: { target: candidate, candidates: [] },
    now,
  });
  assert.equal(diagnostic.target.schema_validation.status, 'failed');
  write(f.files.input!, f.input);
  write(f.files.coverage!, f.coverage);
  const original = await runFlowIdentityPreflight({ inputPath: f.files.input!, now });
  assert.equal(original.target.schema_validation.status, 'passed');
  assert.equal(original.decision, 'manual_review');
  write(f.files.preflight!, original);
  f.review.preflight.input = fact(f.files.input!);
  f.review.preflight.report = fact(f.files.preflight!);
  f.review.coverage.file = fact(f.files.coverage!);
  f.review.candidate_decisions[0]!.payload_sha256 = sha256Json(candidate);
  const result = await f.prepare();
  const { loaded } = await f.load(result);
  assert.equal(
    loaded.coverage.queries[0]!.snapshots[0]!.payload.flowDataSet &&
      sha256Json(loaded.coverage.queries[0]!.snapshots[0]!.payload),
    sha256Json(candidate),
  );
});

test('standing clause identifiers are caller-selected and embedded source locators survive relocation', async (t) => {
  const f = await fixture(t);
  f.review.authorization.clauses = ['task-policy:new-drafts', 'task-policy:deduplication'];
  const report = JSON.parse(readFileSync(f.files.preflight!, 'utf8')) as Obj;
  report.input_path = path.join(f.root, 'original-location', 'request.json');
  (report.candidate_sources as Obj[])[0]!.path = report.input_path;
  write(f.files.preflight!, report);
  f.review.preflight.report = fact(f.files.preflight!);
  const result = await f.prepare();
  await f.load(result);
});

test('saved preflight sources must prove the same embedded candidate set', async (t) => {
  const mutations: Array<(report: Obj) => void> = [
    (report) => {
      delete report.candidate_sources;
    },
    (report) => {
      report.candidate_sources = [];
    },
    (report) => {
      (report.candidate_sources as Obj[])[0]!.row_count = 2;
    },
    (report) => {
      (report.candidate_sources as Obj[])[0]!.kind = 'remote_search';
    },
    (report) => {
      (report.candidate_sources as Obj[])[0]!.path = '/different-request.json';
    },
    (report) => {
      (report.candidate_sources as Obj[])[0]!.scanned_files = ['unbound.json'];
    },
    (report) => {
      report.input_path = 'relative.json';
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    const report = JSON.parse(readFileSync(f.files.preflight!, 'utf8')) as Obj;
    mutate(report);
    write(f.files.preflight!, report);
    await assert.rejects(f.prepare, /preflight (?:candidate sources|input path)/u);
  }
});

test('review, authority, provenance, validity and coverage have strict bounded bindings', async (t) => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      f.review.reviewer.kind = 'human';
    },
    (f) => {
      f.review.reviewer.agent_id = '';
    },
    (f) => {
      f.review.authorization.clauses = [];
    },
    (f) => {
      f.review.authorization.clauses = [''];
    },
    (f) => {
      f.review.authorization.clauses = [' padded'];
    },
    (f) => {
      f.review.authorization.clauses = ['control\ncharacter'];
    },
    (f) => {
      f.review.authorization.clauses = ['x'.repeat(129)];
    },
    (f) => {
      f.review.authorization.clauses = Array.from({ length: 65 }, (_, index) => `clause-${index}`);
    },
    (f) => {
      f.review.authorization.clauses = ['P1', 'P4', 'P4'];
    },
    (f) => {
      f.review.authorization.authorization_chain = [];
    },
    (f) => {
      f.review.authorization.scope = '';
    },
    (f) => {
      f.review.scope.owner_user_id = candidateId;
    },
    (f) => {
      f.review.coverage.sufficiency_reason = '';
    },
    (f) => {
      f.review.coverage.limitations = ['False complete claim'];
    },
    (f) => {
      f.review.validity.expires_at_utc = '2026-10-22T00:00:01Z';
    },
    (f) => {
      f.review.validity.expires_at_utc = now.toISOString();
    },
    (f) => {
      f.review.validity.reviewed_at_utc = 'not-a-time';
    },
    (f) => {
      f.review.validity.reviewed_at_utc = '2026-02-30T00:00:01Z';
    },
    (f) => {
      f.review.reviewer.reviewed_at_utc = '2026-10-20T00:00:02Z';
    },
    (f) => {
      f.review.candidate_decisions[0]!.reason = '';
    },
    (f) => {
      f.review.candidate_decisions[0]!.decision = 'not_applicable';
    },
    (f) => {
      f.review.candidate_decisions[0]!.decision = 'create_new';
    },
    (f) => {
      f.review.candidate_decisions[0]!.evidence = [];
    },
    (f) => {
      f.review.candidate_decisions.push(f.review.candidate_decisions[0]!);
    },
    (f) => {
      f.review.decision = 'reuse';
      f.review.reuse_identity = { id: candidateId, version };
    },
    (f) => {
      f.review.reuse_identity = { id: candidateId, version };
    },
    (f) => {
      f.review.target.payload_sha256 = '0'.repeat(64);
    },
    (f) => {
      f.review.target.id = 'bad';
    },
    (f) => {
      f.review.target.version = 'bad';
    },
    (f) => {
      f.review.preflight.report.bytes = 0;
    },
    (f) => {
      f.review.preflight.report.sha256 = 'bad';
    },
    (f) => {
      f.review.preflight.report.path = f.files.input!;
    },
    (f) => {
      (f.review as Obj).unknown = true;
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.prepare, { code: 'FLOW_IDENTITY_ADMISSION_INVALID' });
  }
});

test('complete preflight and new insert constraints reject payload or historical report drift', async (t) => {
  const mutations: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => {
      write(f.files.input!, { ...f.input, candidates: [] });
    },
    (f) => {
      write(f.files.input!, { ...f.input, target: 'loose' });
    },
    (f) => {
      write(f.files.input!, { ...f.input, candidates: [null] });
    },
    (f) => {
      write(f.files.input!, {
        ...f.input,
        candidates: [...f.input.candidates, ...f.input.candidates],
      });
    },
    (f) => {
      write(f.files.input!, { ...f.input, remote_candidate_search: true });
    },
    (f) => {
      write(f.files.input!, { ...f.input, target: { ...f.input.target, id: candidateId } });
    },
    (f) => {
      f.input.target.flowDataSet.modellingAndValidation.LCIMethod.typeOfDataSet = 'Elementary flow';
      write(f.files.input!, f.input);
    },
    (f) => {
      write(f.files.preflight!, {});
    },
    (f) => {
      write(f.files.preflight!, null);
    },
    (f) => {
      f.coverage.queries[0]!.snapshots = [];
      write(f.files.coverage!, f.coverage);
    },
    (f) => {
      f.coverage.project_ref = 'zzzzzzzzzzzzzzzzzzzz';
      write(f.files.coverage!, f.coverage);
    },
    (f) => {
      write(f.files.contract!, { ...f.template, extra: true });
    },
    (f) => {
      write(f.files.contract!, { ...f.template, actions: [] });
    },
    (f) => {
      write(f.files.contract!, {
        ...f.template,
        owner: { ...account, email: 'UPPER@EXAMPLE.COM' },
      });
    },
    (f) => {
      write(f.files.contract!, { ...f.template, project_ref: 'bad' });
    },
    (f) => {
      write(f.files.contract!, {
        ...f.template,
        actions: [{ ...f.action, expected_operation: 'save_draft' }],
      });
    },
    (f) => {
      write(f.files.contract!, {
        ...f.template,
        actions: [{ ...f.action, dependency_action_ids: ['other'] }],
      });
    },
    (f) => {
      write(f.files.contract!, { ...f.template, actions: [{ ...f.action, id: candidateId }] });
    },
    (f) => {
      writeFileSync(f.files.input!, '{');
    },
    (f) => {
      writeFileSync(f.files.input!, Buffer.from([0xff]));
    },
    (f) => {
      writeFileSync(f.files.input!, '');
    },
    (f) => {
      rmSync(f.files.input!);
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.prepare, { code: 'FLOW_IDENTITY_ADMISSION_INVALID' });
  }
});

test('host-fixed raw contract and strict receipt reject replacement and selected-action drift', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  const { args } = await f.load(result);
  await assert.rejects(
    () => loadFlowIdentityAdmission({ ...args, contractSha256: '0'.repeat(64) }),
    /host-fixed/u,
  );
  await assert.rejects(
    () =>
      loadFlowIdentityAdmission({ ...args, action: { ...args.action, action_id: 'new-action' } }),
    /Selected action/u,
  );
  await assert.rejects(
    () => loadFlowIdentityAdmission({ ...args, owner: { ...account, user_id: candidateId } }),
    /Owner differs/u,
  );
  await assert.rejects(
    () => loadFlowIdentityAdmission({ ...args, projectRef: 'zzzzzzzzzzzzzzzzzzzz' }),
    /Project differs/u,
  );
  const receipt = JSON.parse(readFileSync(result.files.receipt!, 'utf8')) as Obj;
  for (const mutate of [
    (r: Obj) => {
      r.schema_version = 'other';
    },
    (r: Obj) => {
      r.issuer = { cli_version: 'invalid', ruleset_id: 'bad' };
    },
    (r: Obj) => {
      r.action_core_sha256 = '0'.repeat(64);
    },
    (r: Obj) => {
      r.extra = true;
    },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    write(result.files.receipt!, changed);
    const action = {
      ...args.action,
      identity_admission: {
        ...args.action.identity_admission,
        receipt: fact(result.files.receipt!),
      },
    };
    const value = JSON.parse(readFileSync(args.contractPath, 'utf8')) as Obj;
    value.actions = [action];
    write(args.contractPath, value);
    await assert.rejects(
      () =>
        loadFlowIdentityAdmission({
          ...args,
          action,
          contractSha256: fact(args.contractPath).sha256,
        }),
      { code: 'FLOW_IDENTITY_ADMISSION_INVALID' },
    );
  }
});

test('evidence reads reject nonregular files, symlinks, inexact locators and oversized text', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.root, 'linked-evidence');
  symlinkSync(f.root, link, 'junction');
  for (const file of [f.root, link]) {
    assert.throws(
      () =>
        assertFlowIdentityAdmissionInputsCurrent({
          files: [{ path: file, sha256: '0'.repeat(64), bytes: 1 }],
        }),
      /regular files/u,
    );
  }
  for (const file of [` ${f.files.science!}`, `${f.files.science!} `, `${f.root}/control\nname`]) {
    assert.throws(
      () =>
        assertFlowIdentityAdmissionInputsCurrent({
          files: [{ path: file, sha256: '0'.repeat(64), bytes: 1 }],
        }),
      /exact paths/u,
    );
  }
  f.options.inputPath = ` ${f.options.inputPath}`;
  await assert.rejects(f.prepare, /exact paths/u);
  writeFileSync(f.files.science!, 'x'.repeat(8 * 1024 * 1024 + 1));
  assert.throws(
    () => assertFlowIdentityAdmissionInputsCurrent({ files: [fact(f.files.science!)] }),
    /no larger than 8 MiB/u,
  );
});

test('evidence budgets accept exact file and aggregate limits and count repeated paths once', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-admission-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = 'x'.repeat(8 * 1024 * 1024);
  const facts = Array.from({ length: 8 }, (_, index) => {
    const file = path.join(root, `${index}.txt`);
    writeFileSync(file, content);
    return fact(file);
  });
  assertFlowIdentityAdmissionInputsCurrent({ files: [...facts, facts[0]!] });
  const additional = path.join(root, 'additional.txt');
  writeFileSync(additional, 'x');
  assert.throws(
    () => assertFlowIdentityAdmissionInputsCurrent({ files: [...facts, fact(additional)] }),
    /64 MiB unique-file budget/u,
  );
});
