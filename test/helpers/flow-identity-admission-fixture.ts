import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { executeCli } from '../../src/cli.js';
import { sha256Json } from '../../src/lib/canonical-json-hash.js';
import type { FetchLike } from '../../src/lib/http.js';
import { buildSupabaseTestEnv } from './supabase-auth.js';

export type Obj = Record<string, unknown>;
export const actor = '00000000-0000-4000-8000-000000000090';
export const targetId = '00000000-0000-4000-8000-000000000001';
export const candidateId = '00000000-0000-4000-8000-000000000002';
export const project = 'abcdefghijklmnopqrst';
export const version = '01.00.000';
export const write = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value));
export const fact = (file: string) => {
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
};
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
function flow(id: string, route: string, flowType: 'Product flow' | 'Waste flow') {
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
            baseName: loc(flowType === 'Waste flow' ? 'Waste soil' : 'Soil service'),
            treatmentStandardsRoutes: loc(route),
            mixAndLocationTypes: loc('market'),
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                {
                  '@level': '0',
                  '@classId': flowType === 'Waste flow' ? '3' : '0',
                  '#text':
                    flowType === 'Waste flow'
                      ? 'Other transportable goods, except metal products, machinery and equipment'
                      : 'Agriculture, forestry and fishery products',
                },
                ...(flowType === 'Waste flow'
                  ? [{ '@level': '1', '@classId': '39', '#text': 'Wastes or scraps' }]
                  : []),
              ],
            },
          },
        },
        quantitativeReference: { referenceToReferenceFlowProperty: '0' },
      },
      modellingAndValidation: {
        LCIMethod: { typeOfDataSet: flowType },
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

export async function identitySaveFixture(
  t: TestContext,
  options: { flowType?: 'Product flow' | 'Waste flow' } = {},
) {
  const flowType = options.flowType ?? 'Product flow';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-identity-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = Object.fromEntries(
    [
      'input',
      'preflight',
      'review',
      'coverage',
      'template',
      'science',
      'authority',
      'adoption',
      'rows',
    ].map((name) => [name, path.join(root, `${name}.json`)]),
  ) as Record<string, string>;
  const reviewed = new Date();
  const expires = new Date(reviewed.getTime() + 24 * 60 * 60 * 1000);
  const account = { user_id: actor, email: 'owner@example.com', state_code: 0 };
  const target = flow(targetId, 'Risk management', flowType);
  const candidate = flow(candidateId, 'Complete cleanup', flowType);
  const candidateRow = {
    id: candidateId,
    version,
    state_code: 100,
    user_id: null,
    json_ordered: candidate,
  };
  const input = { target, candidates: [candidateRow] };
  write(files.input!, input);
  write(files.rows!, [target]);
  const state = new Map<string, Obj>();
  const writes: Obj[] = [];
  const calls: Array<{ url: URL; method: string }> = [];
  const controls: {
    candidate: Obj;
    behavior?: 'lost_before_write' | 'lost_after_write';
    requireReadFence?: boolean;
    responseOverride?: (url: URL) => Awaited<ReturnType<FetchLike>> | undefined;
    onRequest?: (url: URL) => void | Promise<void>;
  } = { candidate };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: actor, email: account.email })).toString('base64url')}.signature`;
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
    TIANGONG_LCA_ACCESS_TOKEN: token,
    XDG_STATE_HOME: path.join(root, 'state'),
  });
  const deps = {
    env,
    dotEnvStatus: { loaded: false, path: path.join(root, '.env'), count: 0 },
    fetchImpl: undefined as unknown as FetchLike,
  };
  const response = (value: unknown, range?: string): Awaited<ReturnType<FetchLike>> => ({
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-range' ? (range ?? null) : 'application/json',
    },
    text: async () => JSON.stringify(value),
  });
  const fetchImpl: FetchLike = async (urlInput, init) => {
    const url = new URL(String(urlInput));
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    await controls.onRequest?.(url);
    const overridden = controls.responseOverride?.(url);
    if (overridden) return overridden;
    if (url.pathname.startsWith('/auth/'))
      return response({ id: actor, sub: actor, email: account.email });
    if (url.pathname.startsWith('/functions/')) {
      assert.equal(method, 'POST');
      assert.equal(url.pathname, '/functions/v1/app_dataset_create');
      const body = JSON.parse(String(init?.body)) as Obj;
      writes.push(body);
      assert.equal(body.ruleVerification, true);
      assert.equal(body.table, 'flows');
      if (controls.behavior !== 'lost_before_write')
        state.set(body.id as string, body.jsonOrdered as Obj);
      if (controls.behavior) throw new Error('Synthetic lost write response');
      return response({ ok: true, operation: 'insert' });
    }
    assert.equal(method, 'GET');
    const table = url.pathname.split('/').at(-1);
    const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
    const fence = decodeURIComponent(url.toString());
    if (controls.requireReadFence !== false) {
      assert.match(fence, /state_code\.gte\.100/u);
      assert.match(fence, /state_code\.lt\.200/u);
      assert.match(fence, /state_code\.eq\.0/u);
      assert.ok(fence.includes(actor));
    }
    if (table === 'flows' && id?.startsWith('in.')) {
      assert.match(url.searchParams.get('and')!, /^\(state_code\.gte\.100,state_code\.lt\.200,/u);
      assert.equal(
        url.searchParams.get(
          'json->flowDataSet->modellingAndValidation->LCIMethod->>typeOfDataSet',
        ),
        `eq.${flowType}`,
      );
      return response([{ ...candidateRow, json: controls.candidate }], '0-0/1');
    }
    if (table === 'flows')
      return response(
        id && state.has(id)
          ? [{ id, version, user_id: actor, state_code: 0, json_ordered: state.get(id) }]
          : [],
      );
    if (['sources', 'contacts', 'flowproperties'].includes(table ?? ''))
      return response([{ id, version, user_id: null, state_code: 100 }]);
    throw new Error(`Unexpected fixture request ${url}`);
  };
  deps.fetchImpl = fetchImpl;
  const original = await executeCli(
    ['flow', 'identity-preflight', '--input', files.input!, '--json'],
    deps,
  );
  assert.equal(original.exitCode, 1, original.stderr || original.stdout);
  const preflight = JSON.parse(original.stdout) as Obj;
  assert.equal(preflight.status, 'needs_review', original.stdout);
  write(files.preflight!, preflight);
  reviewed.setTime(Date.now());
  expires.setTime(reviewed.getTime() + 24 * 60 * 60 * 1000);
  write(files.science!, {
    agent: 'independent-reviewer',
    conclusion: 'Distinct soil service endpoints.',
  });
  write(files.authority!, { standing: 'Synthetic P1/P4 task authorization' });
  write(files.adoption!, { host_thread_id: 'root-thread', adopted: true });
  const coverage = {
    schema_version: 'flow-identity-coverage.v1',
    scope: 'bounded_visible_search',
    project_ref: project,
    observed_at_utc: new Date(reviewed.getTime() - 1000).toISOString(),
    limitations: ['Only the selected visible family was searched.'],
    queries: [
      {
        kind: 'flow_family',
        visibility: 'public',
        ids: [candidateId],
        type_of_dataset: flowType,
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
  write(files.template!, template);
  const review = {
    schema_version: 'flow-identity-review.v1',
    decision: 'create_distinct',
    target: { id: targetId, version, payload_sha256: sha256Json(target) },
    preflight: { input: fact(files.input!), report: fact(files.preflight!) },
    reviewer: {
      kind: 'agent',
      source_host_thread_id: 'root-thread',
      agent_id: 'independent-reviewer',
      reviewed_at_utc: reviewed.toISOString(),
      report: fact(files.science!),
    },
    authorization: {
      principles: fact(files.authority!),
      authorization_chain: [fact(files.authority!)],
      assignment: fact(files.adoption!),
      clauses: ['P1', 'P4'],
      scope: 'Single necessary draft insert',
    },
    adopted_by: { host_thread_id: 'root-thread', evidence: fact(files.adoption!) },
    scope: {
      project_ref: project,
      owner_user_id: actor,
      target_mode: 'owner_draft',
      operation: 'insert',
    },
    candidate_decisions: [
      {
        id: candidateId,
        version,
        payload_sha256: sha256Json(candidate),
        decision: 'distinct',
        reason: 'Different soil service endpoints',
        evidence: [fact(files.science!)],
      },
    ],
    coverage: {
      file: fact(files.coverage!),
      sufficiency_reason: 'Known family and actual endpoints compared.',
      limitations: coverage.limitations,
    },
    validity: { reviewed_at_utc: reviewed.toISOString(), expires_at_utc: expires.toISOString() },
    reuse_identity: null,
  };
  write(files.review!, review);
  let run = 0;
  const prepare = () =>
    executeCli(
      [
        'flow',
        'identity-admission',
        'prepare',
        '--input',
        files.input!,
        '--preflight',
        files.preflight!,
        '--review',
        files.review!,
        '--coverage',
        files.coverage!,
        '--execution-contract',
        files.template!,
        '--out-dir',
        path.join(root, `prepared-${++run}`),
        '--json',
      ],
      deps,
    );
  const prepared = await prepare();
  assert.equal(prepared.exitCode, 0, prepared.stderr || prepared.stdout);
  const preparation = JSON.parse(prepared.stdout) as {
    files: { receipt: string; execution_contract: string };
    execution_contract_sha256: string;
  };
  const invoke = (commit = false, extra: string[] = []) =>
    executeCli(
      [
        'dataset',
        'save-draft',
        '--input',
        files.rows!,
        '--type',
        'flow',
        '--execution-contract',
        preparation.files.execution_contract,
        '--execution-contract-sha256',
        preparation.execution_contract_sha256,
        '--out-dir',
        path.join(root, `run-${++run}`),
        '--json',
        commit ? '--commit' : '--dry-run',
        ...extra,
      ],
      deps,
    );
  return {
    root,
    files,
    target,
    candidate,
    input,
    review,
    template,
    preparation,
    reviewed,
    expires,
    env,
    fetchImpl,
    deps,
    state,
    writes,
    calls,
    controls,
    invoke,
    prepare,
  };
}
