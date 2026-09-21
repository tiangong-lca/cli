import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDatasetSaveDraft, __testInternals } from '../src/lib/dataset-save-draft-run.js';
import { sha256Json, stableJsonText } from '../src/lib/dataset-maintenance-contract.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonObject = Record<string, unknown>;

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';

function response(body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  };
}

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

function jwt(userId = OWNER_USER_ID, email = 'user@example.com', nonce?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, email, nonce }), 'utf8').toString(
    'base64url',
  );
  return `${header}.${payload}.signature`;
}

function jwtWithPayload(payloadValue: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify(payloadValue), 'utf8').toString('base64url');
  return `${header}.${payload}.signature`;
}

function identity(payload: JsonObject): { id: string; version: string } {
  const root = payload.flowDataSet as JsonObject;
  const information = root.flowInformation as JsonObject;
  const dataSetInformation = information.dataSetInformation as JsonObject;
  const admin = root.administrativeInformation as JsonObject;
  const publication = admin.publicationAndOwnership as JsonObject;
  return {
    id: dataSetInformation['common:UUID'] as string,
    version: publication['common:dataSetVersion'] as string,
  };
}

type Behavior = 'success' | 'mutate_then_throw' | 'throw_without_mutation';

function executionFetch(options: {
  state: Map<string, JsonObject>;
  writes: string[];
  behavior?: Map<string, Behavior>;
  userId?: string;
  email?: string;
  missingSources?: boolean;
  rowIdentityOverride?: { id?: string; version?: string };
  rowUserOverride?: string;
  rowStateOverride?: number;
  sourcesRequireState?: boolean;
  calls?: Array<{ path: string; body: JsonObject }>;
  guardedConflict?: Set<string>;
}): FetchLike {
  const userId = options.userId ?? OWNER_USER_ID;
  const email = options.email ?? 'user@example.com';
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/oauth/userinfo')) {
      return response({ sub: userId, email });
    }
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ accessToken: jwt(userId, email), userId, email });
    }
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').at(-1);
    if (parsed.pathname.includes('/functions/v1/app_dataset_')) {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        version?: string;
        jsonOrdered: JsonObject;
        expectedJsonOrdered?: JsonObject;
      };
      options.calls?.push({ path: parsed.pathname, body });
      options.writes.push(body.id);
      const operation = parsed.pathname.endsWith('app_dataset_create') ? 'insert' : 'save_draft';
      if (options.guardedConflict?.has(body.id)) {
        return response({
          ok: false,
          code: 'DATASET_BEFORE_CONTENT_CHANGED',
          status: 409,
          message: 'Draft content changed since it was read',
        });
      }
      const behavior = options.behavior?.get(body.id) ?? 'success';
      if (behavior !== 'throw_without_mutation') {
        options.state.set(body.id, body.jsonOrdered);
      }
      if (behavior !== 'success') {
        throw new Error(`simulated ${operation} response loss`);
      }
      return response({ ok: true, operation });
    }
    if (table === 'flows') {
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
      const payload = options.state.get(id);
      return response(
        payload
          ? [
              {
                ...identity(payload),
                ...options.rowIdentityOverride,
                user_id: options.rowUserOverride ?? userId,
                state_code: options.rowStateOverride ?? 0,
                json_ordered: payload,
              },
            ]
          : [],
      );
    }
    if (table === 'flowproperties') {
      return response([{ id: '55555555-5555-5555-5555-555555555555', version: '00.00.001' }]);
    }
    if (table === 'contacts') {
      return response([{ id: '44444444-4444-4444-4444-444444444444', version: '00.00.001' }]);
    }
    if (table === 'sources') {
      if (options.missingSources) {
        return response([]);
      }
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
      if (options.sourcesRequireState && !options.state.has(id)) {
        return response([]);
      }
      return response([{ id, version: '00.00.001' }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function contract(options: {
  desired: JsonObject[];
  before?: Array<JsonObject | null>;
  dependencies?: string[][];
}): JsonObject {
  return {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: 'generic-owner-draft-batch-1',
    project_ref: 'example',
    target_mode: 'owner_draft',
    owner: { user_id: OWNER_USER_ID, email: 'user@example.com', state_code: 0 },
    actions: options.desired.map((payload, index) => {
      const rowIdentity = identity(payload);
      const before = options.before?.[index] ?? null;
      return {
        action_id: `action-${index + 1}`,
        desired_sha256: sha256Json(payload),
        expected_operation: before ? 'save_draft' : 'insert',
        table: 'flows',
        ...rowIdentity,
        before_sha256: before ? sha256Json(before) : null,
        dependency_action_ids: options.dependencies?.[index] ?? [],
      };
    }),
  };
}

function writeContract(dir: string, value: JsonObject): string {
  const filePath = path.join(dir, 'execution-contract.json');
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function executionEnv(dir: string, apiKey: string): NodeJS.ProcessEnv {
  return buildSupabaseTestEnv({
    TIANGONG_LCA_ACCESS_TOKEN: jwt(OWNER_USER_ID, 'user@example.com', apiKey),
    XDG_STATE_HOME: path.join(dir, 'state'),
  });
}

function ledgerEvent(options: {
  contractSha256: string;
  action: JsonObject;
  sequence: number;
  eventType: 'attempt_emitted' | 'outcome';
  outcome: 'executed' | 'unknown' | null;
  previousEventSha256?: string | null;
}): JsonObject {
  const core = {
    schema_version: 'dataset-save-draft-execution-event.v1',
    sequence: options.sequence,
    contract_sha256: options.contractSha256,
    action_id: options.action.action_id,
    desired_sha256: options.action.desired_sha256,
    action_binding_sha256: __testInternals.executionActionBindingSha256(options.action as never),
    event_type: options.eventType,
    operation: options.action.expected_operation,
    outcome: options.outcome,
    recovered: false,
    recorded_at_utc: '2026-07-23T04:00:00.000Z',
    previous_event_sha256: options.previousEventSha256 ?? null,
  };
  return { ...core, event_sha256: sha256Json(core) };
}

function writeLedgerEvents(filePath: string, events: JsonObject[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${events.map((event) => stableJsonText(event)).join('\n')}\n`, 'utf8');
}

test('execution contract runs ordered insert/update once and skips terminal rows across out dirs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-success-'));
  const created = flow('11111111-1111-1111-1111-111111111111', 'Created');
  const before = flow('66666666-6666-6666-6666-666666666666', 'Before');
  const desired = flow('66666666-6666-6666-6666-666666666666', 'Desired');
  const state = new Map<string, JsonObject>([[identity(before).id, before]]);
  const writes: string[] = [];
  const fetchImpl = executionFetch({ state, writes });
  const contractPath = writeContract(
    dir,
    contract({
      desired: [created, desired],
      before: [null, before],
      dependencies: [[], ['action-1']],
    }),
  );
  try {
    const first = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [created, desired] },
      type: 'flow',
      outDir: path.join(dir, 'out-1'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'success-1'),
      fetchImpl,
      now: new Date('2026-07-23T03:45:00.000Z'),
    });
    assert.equal(first.status, 'completed');
    assert.deepEqual(writes, [identity(created).id, identity(desired).id]);
    assert.deepEqual(
      first.rows.map((row) => [row.status, row.operation]),
      [
        ['executed', 'insert'],
        ['executed', 'save_draft'],
      ],
    );
    assert.equal(first.counts.attempts_consumed, 2);
    const ledgerRoot = first.files.execution_ledger as string;
    const parsedContract = __testInternals.parseExecutionContract(
      contract({
        desired: [created, desired],
        before: [null, before],
        dependencies: [[], ['action-1']],
      }),
    );
    const events = parsedContract.actions.flatMap((action) =>
      readFileSync(__testInternals.executionLedgerPath(ledgerRoot, action), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    assert.deepEqual(
      events.map((event) => [event.event_type, event.outcome]),
      [
        ['attempt_emitted', null],
        ['outcome', 'executed'],
        ['attempt_emitted', null],
        ['outcome', 'executed'],
      ],
    );

    const second = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [created, desired] },
      type: 'flow',
      outDir: path.join(dir, 'out-2'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'success-2'),
      fetchImpl,
      now: new Date('2026-07-23T03:46:00.000Z'),
    });
    assert.equal(second.status, 'completed');
    assert.deepEqual(writes, [identity(created).id, identity(desired).id]);
    assert.equal(
      parsedContract.actions.reduce(
        (count, action) =>
          count +
          readFileSync(__testInternals.executionLedgerPath(ledgerRoot, action), 'utf8')
            .trim()
            .split('\n').length,
        0,
      ),
      4,
    );

    const copiedDir = path.join(dir, 'copied-contract');
    mkdirSync(copiedDir);
    const copiedContractPath = writeContract(copiedDir, parsedContract as unknown as JsonObject);
    await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [created, desired] },
      type: 'flow',
      outDir: path.join(dir, 'out-3'),
      commit: true,
      executionContractPath: copiedContractPath,
      env: executionEnv(dir, 'success-3'),
      fetchImpl,
    });
    assert.deepEqual(writes, [identity(created).id, identity(desired).id]);

    state.set(identity(created).id, flow(identity(created).id, 'Later drift'));
    const driftedTerminal = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [created, desired] },
      type: 'flow',
      outDir: path.join(dir, 'out-4'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'success-4'),
      fetchImpl,
    });
    assert.equal(driftedTerminal.status, 'completed_with_unknowns');
    assert.equal(driftedTerminal.rows[0]?.status, 'unknown');
    assert.match(driftedTerminal.rows[0]?.error?.message ?? '', /no longer has exact desired/u);
    assert.equal(driftedTerminal.rows[1]?.status, 'executed');
    assert.deepEqual(writes, [identity(created).id, identity(desired).id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract keeps the dependency prefix serial and bounds the unique suffix', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-parallel-'));
  const desired = [
    flow('10000000-0000-0000-0000-000000000001', 'Prefix one'),
    flow('10000000-0000-0000-0000-000000000002', 'Prefix two'),
    flow('10000000-0000-0000-0000-000000000003', 'Suffix three'),
    flow('10000000-0000-0000-0000-000000000004', 'Suffix four'),
    flow('10000000-0000-0000-0000-000000000005', 'Suffix five'),
    flow('10000000-0000-0000-0000-000000000006', 'Suffix six'),
  ];
  const state = new Map<string, JsonObject>();
  const writes: string[] = [];
  const baseFetch = executionFetch({ state, writes });
  const starts: string[] = [];
  const prefixActive: number[] = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    if (String(input).includes('/functions/v1/app_dataset_')) {
      const body = JSON.parse(String(init?.body)) as { id: string };
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(body.id);
      if (
        body.id === identity(desired[0] as JsonObject).id ||
        body.id === identity(desired[1] as JsonObject).id
      ) {
        prefixActive.push(active);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      try {
        return await baseFetch(input, init);
      } finally {
        active -= 1;
      }
    }
    return baseFetch(input, init);
  };
  const contractPath = writeContract(
    dir,
    contract({
      desired,
      dependencies: [[], [], ['action-2'], [], [], []],
    }),
  );

  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: desired },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: true,
      executionContractPath: contractPath,
      maxParallel: 3,
      env: executionEnv(dir, 'parallel'),
      fetchImpl,
    });

    assert.equal(report.status, 'completed');
    assert.deepEqual(prefixActive, [1, 1]);
    assert.equal(maxActive, 3);
    assert.deepEqual(
      starts.slice(0, 2),
      desired.slice(0, 2).map((row) => identity(row).id),
    );
    assert.deepEqual(
      report.rows.map((row) => row.id),
      desired.map((row) => identity(row).id),
    );
    assert.deepEqual(report.execution_contract, {
      path: path.resolve(contractPath),
      sha256: sha256Json(
        __testInternals.parseExecutionContract(
          contract({ desired, dependencies: [[], [], ['action-2'], [], [], []] }),
        ),
      ),
      execution_id: 'generic-owner-draft-batch-1',
      target_mode: 'owner_draft',
      max_parallel: 3,
      serial_prefix_actions: 2,
      parallel_suffix_actions: 4,
    });
    assert.equal(
      readFileSync(report.files.progress_jsonl, 'utf8'),
      `${report.rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    assert.equal(readFileSync(report.files.failures_jsonl, 'utf8'), '');
    assert.equal(
      readFileSync(report.files.summary_json, 'utf8'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract parallel suffix delegates claims and fatal stop to the public batch engine', () => {
  const source = readFileSync(path.resolve('src/lib/dataset-save-draft-run.ts'), 'utf8');
  assert.match(source, /from ['"]\.\.\/batch\.js['"]/u);
  assert.match(source, /runBoundedBatch\s*\(/u);
  assert.match(source, /shouldStop:/u);
  assert.doesNotMatch(source, /nextParallelIndex|runParallelWorker/u);
});

test('execution contract renews the exact owner token before DML and rejects a foreign renewal', async () => {
  const ownerUserId = OWNER_USER_ID;
  const foreignUserId = '22222222-2222-4222-8222-222222222222';
  const runCase = async (
    foreignRenewal: boolean,
  ): Promise<{
    report: Awaited<ReturnType<typeof runDatasetSaveDraft>>;
    authCalls: number;
    edgeTokens: Array<string | null>;
    writes: string[];
  }> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-renew-'));
    const desired = flow(
      foreignRenewal
        ? '20000000-0000-0000-0000-000000000002'
        : '20000000-0000-0000-0000-000000000001',
      foreignRenewal ? 'Foreign renewal' : 'Exact renewal',
    );
    const state = new Map<string, JsonObject>();
    const writes: string[] = [];
    const edgeTokens: Array<string | null> = [];
    const baseFetch = executionFetch({ state, writes, userId: ownerUserId });
    const renewedToken = jwtWithPayload({
      sub: foreignRenewal ? foreignUserId : ownerUserId,
      email: foreignRenewal ? 'foreign@example.com' : 'user@example.com',
      seq: 2,
    });
    let authCalls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/oauth/userinfo')) {
        return response({
          sub: foreignRenewal && authCalls > 0 ? foreignUserId : ownerUserId,
          email: foreignRenewal && authCalls > 0 ? 'foreign@example.com' : 'user@example.com',
        });
      }
      if (isSupabaseAuthTokenUrl(url)) {
        authCalls += 1;
        return makeSupabaseAuthResponse({
          accessToken: renewedToken,
          refreshToken: 'renew-owner-session',
          expiresAt: 4_102_444_800,
          userId: foreignRenewal ? foreignUserId : ownerUserId,
          email: foreignRenewal ? 'foreign@example.com' : 'user@example.com',
        });
      }
      if (url.includes('/functions/v1/app_dataset_')) {
        edgeTokens.push(new Headers(init?.headers).get('authorization'));
      }
      return baseFetch(input, init);
    };
    const executionContract = contract({ desired: [desired] });
    (executionContract.owner as JsonObject).user_id = ownerUserId;
    const contractPath = writeContract(dir, executionContract);
    try {
      const env = executionEnv(dir, foreignRenewal ? 'foreign-renewal' : 'exact-renewal');
      const sessionFile = env.TIANGONG_LCA_SESSION_FILE as string;
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
      session.access_token = jwt(ownerUserId, 'user@example.com', 'initial-owner-session');
      session.expires_at = 4_102_444_800;
      writeFileSync(sessionFile, `${JSON.stringify(session)}\n`, 'utf8');
      const report = await runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [desired] },
        type: 'flow',
        outDir: path.join(dir, 'out'),
        commit: true,
        executionContractPath: contractPath,
        env,
        fetchImpl,
      });
      return { report, authCalls, edgeTokens, writes };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const exact = await runCase(false);
  assert.equal(exact.report.status, 'completed');
  assert.ok(exact.authCalls >= 1);
  assert.deepEqual(exact.edgeTokens, [
    `Bearer ${jwtWithPayload({ sub: ownerUserId, email: 'user@example.com', seq: 2 })}`,
  ]);
  assert.equal(exact.writes.length, 1);

  const foreign = await runCase(true);
  assert.equal(foreign.report.status, 'completed_with_failures');
  assert.equal(foreign.report.counts.attempts_consumed, 0);
  assert.match(foreign.report.rows[0]?.error?.message ?? '', /Renewed owner session/u);
  assert.deepEqual(foreign.edgeTokens, []);
  assert.deepEqual(foreign.writes, []);
});

test('execution contract rejects unsafe parallel configuration before DML', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-parallel-guard-'));
  const first = flow('30000000-0000-0000-0000-000000000001', 'First');
  const repeated = flow('30000000-0000-0000-0000-000000000001', 'Repeated target');
  const state = new Map<string, JsonObject>();
  const writes: string[] = [];
  const fetchImpl = executionFetch({ state, writes });
  const contractPath = writeContract(dir, contract({ desired: [first, repeated] }));
  const invalidContractDir = path.join(dir, 'invalid-contract');
  mkdirSync(invalidContractDir);
  try {
    await assert.rejects(
      runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [first, repeated] },
        type: 'flow',
        outDir: path.join(dir, 'duplicate-out'),
        commit: true,
        executionContractPath: contractPath,
        maxParallel: 2,
        env: executionEnv(dir, 'duplicate-target'),
        fetchImpl,
      }),
      /parallel suffix contains a repeated/u,
    );
    await assert.rejects(
      runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [first] },
        type: 'flow',
        outDir: path.join(dir, 'invalid-out'),
        commit: true,
        executionContractPath: writeContract(invalidContractDir, contract({ desired: [first] })),
        maxParallel: 0,
        env: executionEnv(dir, 'invalid-parallel'),
        fetchImpl,
      }),
      /integer from 1 to 8/u,
    );
    await assert.rejects(
      runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [first] },
        type: 'flow',
        outDir: path.join(dir, 'ordinary-out'),
        maxParallel: 2,
      }),
      /requires --execution-contract/u,
    );
    await assert.rejects(
      runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [first] },
        type: 'flow',
        outDir: path.join(dir, 'dry-run-parallel-out'),
        executionContractPath: contractPath,
        maxParallel: 2,
      }),
      /max-parallel greater than 1 requires --commit/u,
    );
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract recovers lost success, terminalizes unknown, blocks dependents, and continues independent rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-recovery-'));
  const lostSuccess = flow('11111111-1111-1111-1111-111111111111', 'Lost success');
  const unknown = flow('66666666-6666-6666-6666-666666666666', 'Unknown');
  const dependent = flow('77777777-7777-7777-7777-777777777777', 'Dependent');
  const independent = flow('88888888-8888-8888-8888-888888888888', 'Independent');
  const state = new Map<string, JsonObject>();
  const writes: string[] = [];
  const behavior = new Map<string, Behavior>([
    [identity(lostSuccess).id, 'mutate_then_throw'],
    [identity(unknown).id, 'throw_without_mutation'],
  ]);
  const fetchImpl = executionFetch({ state, writes, behavior });
  const contractPath = writeContract(
    dir,
    contract({
      desired: [lostSuccess, unknown, dependent, independent],
      dependencies: [[], [], ['action-2'], []],
    }),
  );
  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [lostSuccess, unknown, dependent, independent] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'recovery-1'),
      fetchImpl,
      now: new Date('2026-07-23T03:47:00.000Z'),
    });
    assert.equal(report.status, 'completed_with_unknowns');
    assert.deepEqual(
      report.rows.map((row) => [row.status, row.operation]),
      [
        ['executed', 'recovered_exact_readback'],
        ['unknown', 'insert'],
        ['blocked', 'blocked_dependency'],
        ['executed', 'insert'],
      ],
    );
    assert.deepEqual(writes, [
      identity(lostSuccess).id,
      identity(unknown).id,
      identity(independent).id,
    ]);
    assert.equal(report.counts.attempts_consumed, 3);

    behavior.clear();
    await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [lostSuccess, unknown, dependent, independent] },
      type: 'flow',
      outDir: path.join(dir, 'out-restart'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'recovery-2'),
      fetchImpl,
      now: new Date('2026-07-23T03:48:00.000Z'),
    });
    assert.deepEqual(writes, [
      identity(lostSuccess).id,
      identity(unknown).id,
      identity(independent).id,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract rejects local drift and owner/project mismatch before emission', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-drift-'));
  const before = flow('11111111-1111-1111-1111-111111111111', 'Before');
  const desired = flow('11111111-1111-1111-1111-111111111111', 'Desired');
  const state = new Map<string, JsonObject>([
    [identity(before).id, flow(identity(before).id, 'Drifted')],
  ]);
  const writes: string[] = [];
  const contractPath = writeContract(dir, contract({ desired: [desired], before: [before] }));
  try {
    const drift = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'drift-1'),
      fetchImpl: executionFetch({ state, writes }),
      now: new Date('2026-07-23T03:49:00.000Z'),
    });
    assert.equal(drift.status, 'completed_with_failures');
    assert.equal(drift.rows[0]?.attempt_consumed, false);
    assert.deepEqual(writes, []);

    state.set(identity(before).id, before);
    const wrongIdentity = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'wrong-readback-identity'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'drift-identity'),
      fetchImpl: executionFetch({
        state,
        writes,
        rowIdentityOverride: { id: 'wrong-id' },
      }),
    });
    assert.equal(wrongIdentity.status, 'completed_with_failures');
    assert.equal(wrongIdentity.rows[0]?.attempt_consumed, false);
    assert.deepEqual(writes, []);

    const wrongVersion = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'wrong-readback-version'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'drift-version'),
      fetchImpl: executionFetch({
        state,
        writes,
        rowIdentityOverride: { version: '99.99.999' },
      }),
    });
    assert.equal(wrongVersion.status, 'completed_with_failures');
    assert.equal(wrongVersion.rows[0]?.attempt_consumed, false);
    assert.deepEqual(writes, []);

    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: path.join(dir, 'rows.json'),
          rawInput: { rows: [desired] },
          type: 'flow',
          outDir: path.join(dir, 'wrong-owner'),
          commit: true,
          executionContractPath: contractPath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_ACCESS_TOKEN: jwt('other-user', 'other@example.com', 'drift-2'),
            XDG_STATE_HOME: path.join(dir, 'state'),
          }),
          fetchImpl: executionFetch({ state, writes, userId: 'other-user' }),
        }),
      /Owner session or project does not match/u,
    );
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract recovers an orphan attempt and terminalizes a readback failure without replay', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-orphan-'));
  const desired = flow('11111111-1111-1111-1111-111111111111', 'Desired');
  const state = new Map<string, JsonObject>([[identity(desired).id, desired]]);
  const writes: string[] = [];
  const contractValue = contract({ desired: [desired] });
  const contractPath = writeContract(dir, contractValue);
  const parsedContract = __testInternals.parseExecutionContract(contractValue);
  const action = parsedContract.actions[0]!;
  const env = executionEnv(dir, 'orphan-1');
  const ledgerRoot = __testInternals.executionLedgerRoot(env, parsedContract);
  const attempt = ledgerEvent({
    contractSha256: sha256Json(parsedContract),
    action: action as unknown as JsonObject,
    sequence: 1,
    eventType: 'attempt_emitted',
    outcome: null,
  });
  writeLedgerEvents(__testInternals.executionLedgerPath(ledgerRoot, action), [attempt]);
  try {
    const recovered = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'recovered'),
      commit: true,
      executionContractPath: contractPath,
      env,
      fetchImpl: executionFetch({ state, writes }),
    });
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.rows[0]?.operation, 'recovered_exact_readback');
    assert.deepEqual(writes, []);

    const readbackDir = path.join(dir, 'readback-failure');
    mkdirSync(readbackDir);
    const readbackDesired = flow('66666666-6666-6666-6666-666666666666', 'Readback failure');
    const readbackState = new Map<string, JsonObject>();
    const readbackWrites: string[] = [];
    const readbackContractPath = writeContract(
      readbackDir,
      contract({ desired: [readbackDesired] }),
    );
    const baseFetch = executionFetch({ state: readbackState, writes: readbackWrites });
    let dispatched = false;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes('/functions/v1/app_dataset_')) {
        const result = await baseFetch(input, init);
        dispatched = true;
        return result;
      }
      if (dispatched && new URL(url).pathname.endsWith('/flows')) {
        throw new Error('simulated readback loss');
      }
      return baseFetch(input, init);
    };
    const unknown = await runDatasetSaveDraft({
      inputPath: path.join(readbackDir, 'rows.json'),
      rawInput: { rows: [readbackDesired] },
      type: 'flow',
      outDir: path.join(readbackDir, 'out'),
      commit: true,
      executionContractPath: readbackContractPath,
      env: executionEnv(dir, 'readback-1'),
      fetchImpl,
    });
    assert.equal(unknown.status, 'completed_with_unknowns');
    assert.equal(unknown.rows[0]?.status, 'unknown');
    assert.deepEqual(readbackWrites, [identity(readbackDesired).id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract keeps preparation, reference, and dry-run failures at zero attempts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-preflight-'));
  const invalid = structuredClone(flow('11111111-1111-1111-1111-111111111111', 'Invalid'));
  delete (invalid.flowDataSet as JsonObject).modellingAndValidation;
  const valid = flow('66666666-6666-6666-6666-666666666666', 'Unresolved source');
  const writes: string[] = [];
  try {
    __testInternals.prepareRows('invalid.json', { rows: [invalid] }, 'flow');
    const invalidContractPath = writeContract(dir, contract({ desired: [invalid] }));
    const invalidReport = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'invalid.json'),
      rawInput: { rows: [invalid] },
      type: 'flow',
      outDir: path.join(dir, 'invalid-out'),
      commit: true,
      executionContractPath: invalidContractPath,
      env: executionEnv(dir, 'invalid-1'),
      fetchImpl: executionFetch({ state: new Map(), writes }),
    });
    assert.equal(invalidReport.status, 'completed_with_failures');
    assert.equal(invalidReport.rows[0]?.attempt_consumed, false);

    const unresolvedDir = path.join(dir, 'unresolved');
    mkdirSync(unresolvedDir);
    const unresolvedContractPath = writeContract(unresolvedDir, contract({ desired: [valid] }));
    const unresolvedReport = await runDatasetSaveDraft({
      inputPath: path.join(unresolvedDir, 'rows.json'),
      rawInput: { rows: [valid] },
      type: 'flow',
      outDir: path.join(unresolvedDir, 'out'),
      commit: true,
      executionContractPath: unresolvedContractPath,
      env: executionEnv(dir, 'unresolved-1'),
      fetchImpl: executionFetch({ state: new Map(), writes, missingSources: true }),
    });
    assert.equal(unresolvedReport.status, 'completed_with_failures');
    assert.match(unresolvedReport.rows[0]?.error?.message ?? '', /unresolved remote references/u);
    assert.equal(unresolvedReport.rows[0]?.attempt_consumed, false);
    assert.deepEqual(writes, []);

    const unresolvedDryRun = await runDatasetSaveDraft({
      inputPath: path.join(unresolvedDir, 'rows.json'),
      rawInput: { rows: [valid] },
      type: 'flow',
      outDir: path.join(unresolvedDir, 'dry-run'),
      executionContractPath: unresolvedContractPath,
      env: executionEnv(dir, 'unresolved-dry-1'),
      fetchImpl: executionFetch({ state: new Map(), writes, missingSources: true }),
    });
    assert.equal(unresolvedDryRun.mode, 'dry_run');
    assert.equal(unresolvedDryRun.commit, false);
    assert.equal(unresolvedDryRun.status, 'completed_with_failures');
    assert.equal(unresolvedDryRun.rows[0]?.status, 'failed');
    assert.match(unresolvedDryRun.rows[0]?.error?.message ?? '', /unresolved remote references/u);
    assert.equal(unresolvedDryRun.rows[0]?.attempt_consumed, false);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract validation cannot mutate its exact desired payload', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-validation-clone-'));
  const desired: JsonObject = {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': '11111111-1111-1111-1111-111111111111',
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
        },
      },
    },
  };
  const exactInput = structuredClone(desired);
  const executionContract = __testInternals.parseExecutionContract(
    contract({ desired: [exactInput] }),
  );
  const contractPath = writeContract(dir, executionContract as unknown as JsonObject);
  try {
    const prepared = __testInternals.prepareRows(
      path.join(dir, 'rows.json'),
      { rows: [desired] },
      'flow',
    );
    assert.deepEqual(desired, exactInput);
    assert.deepEqual(prepared[0]?.payload, exactInput);
    assert.equal(prepared[0]?.validation?.ok, false);
    assert.doesNotThrow(() =>
      __testInternals.bindExecutionContractRows(executionContract, prepared),
    );

    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: path.join(dir, 'rows.json'),
          rawInput: { rows: [desired] },
          type: 'flow',
          outDir: path.join(dir, 'out'),
          commit: true,
          executionContractPath: contractPath,
        }),
      /execution requires env and fetch runtime bindings/u,
    );
    assert.deepEqual(desired, exactInput);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract aborts before dispatch when its durable attempt marker cannot be created', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-contract-ledger-failure-'));
  const desired = flow('11111111-1111-1111-1111-111111111111', 'No marker');
  const contractPath = writeContract(dir, contract({ desired: [desired] }));
  const stateRootFile = path.join(dir, 'state-root-is-a-file');
  writeFileSync(stateRootFile, 'not a directory\n', 'utf8');
  const writes: string[] = [];
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_ACCESS_TOKEN: jwt(OWNER_USER_ID, 'user@example.com', 'marker-failure'),
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
    XDG_STATE_HOME: stateRootFile,
  });
  try {
    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: path.join(dir, 'rows.json'),
          rawInput: { rows: [desired] },
          type: 'flow',
          outDir: path.join(dir, 'out'),
          commit: true,
          executionContractPath: contractPath,
          env,
          fetchImpl: executionFetch({ state: new Map(), writes }),
        }),
      /blocked before request dispatch/u,
    );
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract parsers reject malformed contracts, JWTs, rows, and ledger events', () => {
  const valid = contract({
    desired: [flow('11111111-1111-1111-1111-111111111111', 'One')],
  });
  assert.equal(__testInternals.parseExecutionContract(valid).actions.length, 1);
  assert.throws(() => __testInternals.parseExecutionContract(null), /JSON object/u);
  assert.throws(() => __testInternals.parseExecutionContract({}), /header is invalid/u);
  assert.throws(
    () => __testInternals.parseExecutionContract({ ...valid, execution_id: ' ' }),
    /execution_id must be a non-empty string/u,
  );
  assert.throws(
    () => __testInternals.parseExecutionContract({ ...valid, actions: [null] }),
    /actions\[0\] is invalid/u,
  );
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [{ ...(valid.actions as JsonObject[])[0], desired_sha256: 'bad' }],
      }),
    /lowercase SHA-256/u,
  );
  const validAction = (valid.actions as JsonObject[])[0]!;
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [{ ...validAction, table: 'unknown' }],
      }),
    /table is unsupported/u,
  );
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [{ ...validAction, expected_operation: 'delete' }],
      }),
    /expected_operation is invalid/u,
  );
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [{ ...validAction, before_sha256: '0'.repeat(64) }],
      }),
    /contradicts expected_operation/u,
  );
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [
          validAction,
          { ...validAction, action_id: 'action-2', dependency_action_ids: ['missing'] },
        ],
      }),
    /unique earlier actions/u,
  );
  assert.throws(
    () =>
      __testInternals.parseExecutionContract({
        ...valid,
        actions: [validAction, validAction],
      }),
    /Duplicate action_id/u,
  );
  const parsed = __testInternals.parseExecutionContract(valid);
  const parsedAction = parsed.actions[0]!;
  const exactReadback = {
    id: parsedAction.id,
    version: parsedAction.version,
    user_id: parsed.owner.user_id,
    state_code: 0,
    json_ordered: flow('11111111-1111-1111-1111-111111111111', 'One'),
  };
  assert.equal(
    __testInternals.exactDesiredReadback({
      rows: [exactReadback],
      action: parsedAction,
      contract: parsed,
    }),
    true,
  );
  assert.equal(
    __testInternals.exactDesiredReadback({
      rows: [{ ...exactReadback, id: 'wrong-id' }],
      action: parsedAction,
      contract: parsed,
    }),
    false,
  );
  assert.equal(
    __testInternals.exactDesiredReadback({
      rows: [{ ...exactReadback, version: '99.99.999' }],
      action: parsedAction,
      contract: parsed,
    }),
    false,
  );
  const prepared = __testInternals.prepareRows(
    'rows.json',
    { rows: [flow('11111111-1111-1111-1111-111111111111', 'One')] },
    'flow',
  );
  assert.throws(() => __testInternals.bindExecutionContractRows(parsed, []), /action count/u);
  assert.throws(
    () =>
      __testInternals.bindExecutionContractRows(parsed, [
        ...__testInternals.prepareRows(
          'rows.json',
          { rows: [flow('11111111-1111-1111-1111-111111111111', 'Different')] },
          'flow',
        ),
      ]),
    /does not bind row/u,
  );
  assert.doesNotThrow(() => __testInternals.bindExecutionContractRows(parsed, prepared));
  const wrapperIdentityContract = __testInternals.parseExecutionContract({
    ...valid,
    actions: [{ ...(valid.actions as JsonObject[])[0], id: 'wrapper-id' }],
  });
  const wrapperIdentityRows = __testInternals.prepareRows(
    'rows.json',
    { rows: [{ id: 'wrapper-id', json_ordered: prepared[0]?.payload }] },
    'flow',
  );
  assert.throws(
    () => __testInternals.bindExecutionContractRows(wrapperIdentityContract, wrapperIdentityRows),
    /does not bind row/u,
  );
  assert.throws(
    () =>
      __testInternals.bindExecutionContractRows(
        parsed,
        __testInternals.prepareRows('rows.json', { rows: [{ unsupported: true }] }, 'auto'),
      ),
    /does not bind row/u,
  );
  assert.throws(() => __testInternals.decodeExecutionActor('plain'), /not a JWT/u);
  assert.throws(() => __testInternals.decodeExecutionActor('x.bad!.x'), /payload is invalid/u);
  assert.throws(() => __testInternals.decodeExecutionActor(jwtWithPayload([])), /not an object/u);
  assert.deepEqual(__testInternals.decodeExecutionActor(jwt()), {
    user_id: OWNER_USER_ID,
    email: 'user@example.com',
  });
  assert.deepEqual(
    __testInternals.parseExecutionRows(
      [{ id: 'a', version: 'v', user_id: 'u', state_code: 0, json_ordered: { a: 1 } }],
      'https://example.test',
    )[0]?.json_ordered,
    { a: 1 },
  );
  assert.equal(
    __testInternals.parseExecutionRows(
      [{ id: 'a', version: 'v', user_id: 'u', state_code: 0 }],
      'https://example.test',
    )[0]?.json_ordered,
    null,
  );
  assert.throws(() => __testInternals.parseLedgerEvent(null, 0), /not an object/u);
  assert.throws(() => __testInternals.parseLedgerEvent({}, 0), /invalid shape/u);
  const invalidOutcome = ledgerEvent({
    contractSha256: '0'.repeat(64),
    action: validAction,
    sequence: 1,
    eventType: 'attempt_emitted',
    outcome: 'executed',
  });
  assert.throws(() => __testInternals.parseLedgerEvent(invalidOutcome, 0), /invalid outcome/u);
  assert.equal(
    __testInternals.projectRefFromApiBaseUrl('https://sample.supabase.co/functions/v1'),
    'sample',
  );
});

test('execution ledger rejects binding, repeated-attempt, and outcome-order corruption', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-execution-ledger-corruption-'));
  const contractValue = contract({
    desired: [flow('11111111-1111-1111-1111-111111111111', 'One')],
  });
  const parsed = __testInternals.parseExecutionContract(contractValue);
  const action = parsed.actions[0]!;
  const actionObject = action as unknown as JsonObject;
  const contractSha256 = sha256Json(parsed);
  try {
    const bindingRoot = path.join(dir, 'binding');
    const wrongBinding = ledgerEvent({
      contractSha256,
      action: { ...actionObject, action_id: 'wrong-action' },
      sequence: 1,
      eventType: 'attempt_emitted',
      outcome: null,
    });
    writeLedgerEvents(__testInternals.executionLedgerPath(bindingRoot, action), [wrongBinding]);
    assert.throws(
      () => __testInternals.loadExecutionLedger(bindingRoot, parsed),
      /failed its hash or action binding/u,
    );

    const targetBindingRoot = path.join(dir, 'target-binding');
    const wrongTargetBinding = ledgerEvent({
      contractSha256,
      action: { ...actionObject, id: 'different-target' },
      sequence: 1,
      eventType: 'attempt_emitted',
      outcome: null,
    });
    writeLedgerEvents(__testInternals.executionLedgerPath(targetBindingRoot, action), [
      wrongTargetBinding,
    ]);
    assert.throws(
      () => __testInternals.loadExecutionLedger(targetBindingRoot, parsed),
      /failed its hash or action binding/u,
    );

    const repeatedRoot = path.join(dir, 'repeated');
    const attempt = ledgerEvent({
      contractSha256,
      action: actionObject,
      sequence: 1,
      eventType: 'attempt_emitted',
      outcome: null,
    });
    const repeatedAttempt = ledgerEvent({
      contractSha256,
      action: actionObject,
      sequence: 2,
      eventType: 'attempt_emitted',
      outcome: null,
      previousEventSha256: attempt.event_sha256 as string,
    });
    writeLedgerEvents(__testInternals.executionLedgerPath(repeatedRoot, action), [
      attempt,
      repeatedAttempt,
    ]);
    assert.throws(
      () => __testInternals.loadExecutionLedger(repeatedRoot, parsed),
      /repeats attempt/u,
    );

    const orderingRoot = path.join(dir, 'ordering');
    const orphanOutcome = ledgerEvent({
      contractSha256,
      action: actionObject,
      sequence: 1,
      eventType: 'outcome',
      outcome: 'unknown',
    });
    writeLedgerEvents(__testInternals.executionLedgerPath(orderingRoot, action), [orphanOutcome]);
    assert.throws(
      () => __testInternals.loadExecutionLedger(orderingRoot, parsed),
      /outcome ordering is invalid/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract save_draft transports the fresh complete before image exactly once', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-guarded-transport-'));
  const before = flow('77777777-7777-4777-8777-777777777777', 'Before content');
  const desired = flow('77777777-7777-4777-8777-777777777777', 'After content');
  const id = identity(before).id;
  const state = new Map([[id, before]]);
  const writes: string[] = [];
  const calls: Array<{ path: string; body: JsonObject }> = [];
  try {
    const contractPath = writeContract(dir, contract({ desired: [desired], before: [before] }));
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'guarded-1'),
      fetchImpl: executionFetch({ state, writes, calls }),
    });
    assert.equal(report.rows[0]?.status, 'executed');
    assert.equal(report.rows[0]?.readback, 'desired_exact');
    const saves = calls.filter((call) => call.path.endsWith('app_dataset_save_draft'));
    assert.equal(saves.length, 1, 'one guarded dispatch and no fallback');
    assert.deepEqual(saves[0]?.body.expectedJsonOrdered, before);
    assert.deepEqual(saves[0]?.body.jsonOrdered, desired);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a guarded before-content conflict is terminal without fallback or replay', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-guarded-conflict-'));
  const before = flow('88888888-8888-4888-8888-888888888888', 'Before content');
  const desired = flow('88888888-8888-4888-8888-888888888888', 'After content');
  const id = identity(before).id;
  const state = new Map([[id, before]]);
  const writes: string[] = [];
  const calls: Array<{ path: string; body: JsonObject }> = [];
  try {
    const contractPath = writeContract(dir, contract({ desired: [desired], before: [before] }));
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: true,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'guarded-2'),
      fetchImpl: executionFetch({ state, writes, calls, guardedConflict: new Set([id]) }),
    });
    assert.equal(report.rows[0]?.status, 'unknown');
    assert.equal(report.rows[0]?.attempt_consumed, true);
    assert.equal(report.rows[0]?.readback, 'not_desired');
    assert.equal(report.counts.attempts_consumed, 1);
    const commands = calls.filter((call) => /app_dataset_(create|save_draft)$/u.test(call.path));
    assert.equal(commands.length, 1, 'a guard conflict cannot fall back or retry');
    assert.deepEqual(state.get(id), before, 'the refused write changed nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run preflights the exact before state and dispatches nothing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-preflight-'));
  const before = flow('99999999-9999-4999-8999-999999999999', 'Before content');
  const desired = flow('99999999-9999-4999-8999-999999999999', 'After content');
  const id = identity(before).id;
  const state = new Map([[id, before]]);
  const writes: string[] = [];
  const calls: Array<{ path: string; body: JsonObject }> = [];
  try {
    const contractValue = contract({ desired: [desired], before: [before] });
    const contractPath = writeContract(dir, contractValue);
    const env = executionEnv(dir, 'dry-run-1');
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [desired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env,
      fetchImpl: executionFetch({ state, writes, calls }),
    });
    assert.equal(report.schema_version, 2);
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.commit, false);
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.executed, 0);
    assert.equal(report.counts.attempts_consumed, 0);
    assert.equal(report.rows[0]?.status, 'prepared');
    assert.equal(report.rows[0]?.operation, 'would_sync');
    assert.equal(report.rows[0]?.attempt_consumed, false);
    assert.equal(report.rows[0]?.readback, 'not_performed');
    assert.deepEqual(report.rows[0]?.visible_row, {
      id,
      version: identity(before).version,
      user_id: OWNER_USER_ID,
      state_code: 0,
    });
    assert.equal(report.files.execution_ledger, undefined);
    assert.deepEqual(writes, []);
    assert.equal(
      calls.filter((call) => call.path.includes('/functions/v1/app_dataset_')).length,
      0,
      'a dry-run preflight never dispatches an owner command',
    );
    assert.equal(
      existsSync(
        __testInternals.executionLedgerRoot(
          env,
          __testInternals.parseExecutionContract(contractValue),
        ),
      ),
      false,
      'a dry-run preflight never creates an attempt ledger',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run reports drift, foreign and non-draft before states as failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-drift-'));
  const before = flow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Before content');
  const desired = flow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'After content');
  const drifted = flow('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Someone else wrote');
  const id = identity(before).id;
  const insertOnly = flow('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Insert target');
  const cases: Array<{ name: string; state: Map<string, JsonObject>; options?: JsonObject }> = [
    { name: 'content drift', state: new Map([[id, drifted]]) },
    {
      name: 'foreign owner',
      state: new Map([[id, before]]),
      options: { rowUserOverride: '99999999-9999-4999-8999-999999999999' },
    },
    { name: 'non-draft state', state: new Map([[id, before]]), options: { rowStateOverride: 100 } },
  ];
  try {
    for (const scenario of cases) {
      const writes: string[] = [];
      const contractPath = writeContract(dir, contract({ desired: [desired], before: [before] }));
      const report = await runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [desired] },
        type: 'flow',
        outDir: path.join(dir, `out-${scenario.name.replace(/ /gu, '-')}`),
        commit: false,
        executionContractPath: contractPath,
        env: executionEnv(dir, `dry-run-${scenario.name.replace(/ /gu, '-')}`),
        fetchImpl: executionFetch({ state: scenario.state, writes, ...(scenario.options ?? {}) }),
      });
      assert.equal(report.status, 'completed_with_failures', scenario.name);
      assert.equal(report.rows[0]?.status, 'failed', scenario.name);
      assert.match(
        report.rows[0]?.error?.message ?? '',
        /before-state or expected operation drifted/u,
        scenario.name,
      );
      assert.equal(report.rows[0]?.attempt_consumed, false, scenario.name);
      assert.deepEqual(writes, [], scenario.name);
    }

    const insertWrites: string[] = [];
    const insertContractPath = writeContract(dir, contract({ desired: [insertOnly] }));
    const insertReport = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [insertOnly] },
      type: 'flow',
      outDir: path.join(dir, 'out-insert-existing'),
      commit: false,
      executionContractPath: insertContractPath,
      env: executionEnv(dir, 'dry-run-insert-existing'),
      fetchImpl: executionFetch({
        state: new Map([[identity(insertOnly).id, insertOnly]]),
        writes: insertWrites,
      }),
    });
    assert.equal(insertReport.status, 'completed_with_failures');
    assert.equal(insertReport.rows[0]?.status, 'failed');
    assert.match(
      insertReport.rows[0]?.error?.message ?? '',
      /before-state or expected operation drifted/u,
    );
    assert.deepEqual(insertWrites, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run preflights a dependency chain once every earlier action is prepared', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-dependency-'));
  const first = flow('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'First insert');
  const second = flow('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Dependent insert');
  const writes: string[] = [];
  try {
    const contractPath = writeContract(
      dir,
      contract({ desired: [first, second], dependencies: [[], ['action-1']] }),
    );
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [first, second] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'dry-run-dependency-1'),
      fetchImpl: executionFetch({ state: new Map(), writes }),
    });
    assert.equal(report.status, 'completed');
    assert.deepEqual(
      report.rows.map((row) => [row.status, row.operation]),
      [
        ['prepared', 'would_sync'],
        ['prepared', 'would_sync'],
      ],
    );
    assert.equal(report.rows[1]?.attempt_consumed, false);
    assert.deepEqual(writes, []);

    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: path.join(dir, 'rows.json'),
          rawInput: { rows: [first, second] },
          type: 'flow',
          outDir: path.join(dir, 'out-missing-runtime'),
          executionContractPath: contractPath,
        }),
      /execution requires env and fetch runtime bindings/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run preflights each action of an existing-draft dependency chain', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-existing-chain-'));
  const firstBefore = flow('e1000000-0000-4000-8000-000000000001', 'First before');
  const firstDesired = flow('e1000000-0000-4000-8000-000000000001', 'First after');
  const secondBefore = flow('e1000000-0000-4000-8000-000000000002', 'Second before');
  const secondDesired = flow('e1000000-0000-4000-8000-000000000002', 'Second after');
  const firstId = identity(firstBefore).id;
  const secondId = identity(secondBefore).id;
  const state = new Map<string, JsonObject>([
    [firstId, firstBefore],
    [secondId, secondBefore],
  ]);
  const writes: string[] = [];
  try {
    const contractValue = contract({
      desired: [firstDesired, secondDesired],
      before: [firstBefore, secondBefore],
      dependencies: [[], ['action-1']],
    });
    const contractPath = writeContract(dir, contractValue);
    const env = executionEnv(dir, 'dry-run-existing-chain-1');
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [firstDesired, secondDesired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env,
      fetchImpl: executionFetch({ state, writes }),
    });
    assert.equal(report.status, 'completed', JSON.stringify(report.rows));
    assert.deepEqual(
      report.rows.map((row) => [row.status, row.operation, row.attempt_consumed]),
      [
        ['prepared', 'would_sync', false],
        ['prepared', 'would_sync', false],
      ],
    );
    assert.deepEqual(
      report.rows.map((row) => row.visible_row?.id),
      [firstId, secondId],
    );
    assert.deepEqual(writes, []);
    assert.equal(
      existsSync(
        __testInternals.executionLedgerRoot(
          env,
          __testInternals.parseExecutionContract(contractValue),
        ),
      ),
      false,
      'a dry-run preflight never creates an attempt ledger',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run blocks descendants of a drifted root action', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-root-drift-'));
  const firstBefore = flow('e2000000-0000-4000-8000-000000000001', 'First before');
  const firstDesired = flow('e2000000-0000-4000-8000-000000000001', 'First after');
  const firstDrifted = flow('e2000000-0000-4000-8000-000000000001', 'Someone else wrote');
  const secondBefore = flow('e2000000-0000-4000-8000-000000000002', 'Second before');
  const secondDesired = flow('e2000000-0000-4000-8000-000000000002', 'Second after');
  const state = new Map<string, JsonObject>([
    [identity(firstBefore).id, firstDrifted],
    [identity(secondBefore).id, secondBefore],
  ]);
  const writes: string[] = [];
  try {
    const contractPath = writeContract(
      dir,
      contract({
        desired: [firstDesired, secondDesired],
        before: [firstBefore, secondBefore],
        dependencies: [[], ['action-1']],
      }),
    );
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [firstDesired, secondDesired] },
      type: 'flow',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'dry-run-root-drift-1'),
      fetchImpl: executionFetch({ state, writes }),
    });
    assert.equal(report.status, 'completed_with_failures');
    assert.deepEqual(
      report.rows.map((row) => [row.status, row.operation]),
      [
        ['failed', 'save_draft'],
        ['blocked', 'blocked_dependency'],
      ],
    );
    assert.match(report.rows[0]?.error?.message ?? '', /drifted/u);
    assert.match(report.rows[1]?.error?.message ?? '', /prepared in this preflight/u);
    assert.equal(report.rows[1]?.attempt_consumed, false);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sourcePayload(id: string): JsonObject {
  return {
    sourceDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Source',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Source ../../schemas/ILCD_SourceDataSet.xsd',
      sourceInformation: {
        dataSetInformation: {
          'common:UUID': id,
          'common:shortName': localized('Referenced source'),
          classificationInformation: {
            'common:classification': {
              'common:class': { '@level': '0', '@classId': '1', '#text': 'Data set formats' },
            },
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
    },
  };
}

function sourceAction(
  actionId: string,
  payload: JsonObject,
  dependencies: string[] = [],
): JsonObject {
  return {
    action_id: actionId,
    desired_sha256: sha256Json(payload),
    expected_operation: 'insert',
    table: 'sources',
    id: identityOfSource(payload),
    version: '00.00.001',
    before_sha256: null,
    dependency_action_ids: dependencies,
  };
}

function identityOfSource(payload: JsonObject): string {
  const root = payload.sourceDataSet as JsonObject;
  const information = root.sourceInformation as JsonObject;
  const dataSetInformation = information.dataSetInformation as JsonObject;
  return dataSetInformation['common:UUID'] as string;
}

test('execution contract dry-run blocks a reference an earlier insert action would create', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-pending-reference-'));
  const insertedSource = sourcePayload('22222222-2222-2222-2222-222222222222');
  const dependentBefore = flow('e3000000-0000-4000-8000-000000000001', 'Dependent before');
  const dependentDesired = flow('e3000000-0000-4000-8000-000000000001', 'Dependent after');
  const state = new Map<string, JsonObject>([[identity(dependentBefore).id, dependentBefore]]);
  const writes: string[] = [];
  try {
    const formatSource = sourcePayload('33333333-3333-3333-3333-333333333333');
    const contractPath = writeContract(dir, {
      schema_version: 'dataset-save-draft-execution-contract.v1',
      execution_id: 'pending-reference-1',
      project_ref: 'example',
      target_mode: 'owner_draft',
      owner: { user_id: OWNER_USER_ID, email: 'user@example.com', state_code: 0 },
      actions: [
        sourceAction('action-1', insertedSource),
        sourceAction('action-2', formatSource),
        {
          action_id: 'action-3',
          desired_sha256: sha256Json(dependentDesired),
          expected_operation: 'save_draft',
          table: 'flows',
          ...identity(dependentDesired),
          before_sha256: sha256Json(dependentBefore),
          dependency_action_ids: ['action-1', 'action-2'],
        },
      ],
    });
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [insertedSource, formatSource, dependentDesired] },
      type: 'auto',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'dry-run-pending-reference-1'),
      fetchImpl: executionFetch({ state, writes, sourcesRequireState: true }),
    });
    assert.equal(report.status, 'completed_with_failures', JSON.stringify(report.rows));
    assert.deepEqual(
      report.rows.map((row) => [row.status, row.operation]),
      [
        ['prepared', 'would_sync'],
        ['prepared', 'would_sync'],
        ['blocked', 'blocked_dependency'],
      ],
      JSON.stringify(report.rows.map((row) => row.validation)),
    );
    assert.match(
      report.rows[2]?.error?.message ?? '',
      /created by an earlier action of this contract/u,
    );
    assert.equal(report.rows[2]?.attempt_consumed, false);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run still fails an unresolved reference no earlier action creates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-unresolved-reference-'));
  const unrelatedSource = sourcePayload('99999999-9999-4999-8999-999999999999');
  const dependentBefore = flow('e4000000-0000-4000-8000-000000000001', 'Dependent before');
  const dependentDesired = flow('e4000000-0000-4000-8000-000000000001', 'Dependent after');
  const state = new Map<string, JsonObject>([[identity(dependentBefore).id, dependentBefore]]);
  const writes: string[] = [];
  try {
    const contractPath = writeContract(dir, {
      schema_version: 'dataset-save-draft-execution-contract.v1',
      execution_id: 'unresolved-reference-1',
      project_ref: 'example',
      target_mode: 'owner_draft',
      owner: { user_id: OWNER_USER_ID, email: 'user@example.com', state_code: 0 },
      actions: [
        {
          ...sourceAction('action-1', unrelatedSource),
          id: '99999999-9999-4999-8999-999999999999',
        },
        {
          action_id: 'action-2',
          desired_sha256: sha256Json(dependentDesired),
          expected_operation: 'save_draft',
          table: 'flows',
          ...identity(dependentDesired),
          before_sha256: sha256Json(dependentBefore),
          dependency_action_ids: ['action-1'],
        },
      ],
    });
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [unrelatedSource, dependentDesired] },
      type: 'auto',
      outDir: path.join(dir, 'out'),
      commit: false,
      executionContractPath: contractPath,
      env: executionEnv(dir, 'dry-run-unresolved-reference-1'),
      fetchImpl: executionFetch({ state, writes, sourcesRequireState: true }),
    });
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.rows[0]?.status, 'prepared');
    assert.equal(report.rows[1]?.status, 'failed');
    assert.match(report.rows[1]?.error?.message ?? '', /unresolved remote references/u);
    assert.deepEqual(writes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execution contract dry-run retains prior attempts and outcomes without re-authorizing them', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dry-run-retained-'));
  const before = flow('e5000000-0000-4000-8000-000000000001', 'Before content');
  const desired = flow('e5000000-0000-4000-8000-000000000001', 'After content');
  const state = new Map<string, JsonObject>([[identity(before).id, before]]);
  const writes: string[] = [];
  try {
    for (const retained of ['outcome', 'attempt'] as const) {
      const contractValue = contract({ desired: [desired], before: [before] });
      const parsed = __testInternals.parseExecutionContract(contractValue);
      const action = parsed.actions[0] as unknown as JsonObject;
      const env = executionEnv(dir, `dry-run-retained-${retained}`);
      const ledgerRoot = __testInternals.executionLedgerRoot(env, parsed);
      const ledgerPath = __testInternals.executionLedgerPath(ledgerRoot, parsed.actions[0]!);
      const contractSha256 = sha256Json(parsed);
      const attempt = ledgerEvent({
        contractSha256,
        action,
        sequence: 1,
        eventType: 'attempt_emitted',
        outcome: null,
      });
      const events =
        retained === 'outcome'
          ? [
              attempt,
              ledgerEvent({
                contractSha256,
                action,
                sequence: 2,
                eventType: 'outcome',
                outcome: 'unknown',
                previousEventSha256: attempt.event_sha256 as string,
              }),
            ]
          : [attempt];
      writeLedgerEvents(ledgerPath, events);
      const beforeBytes = readFileSync(ledgerPath, 'utf8');
      const report = await runDatasetSaveDraft({
        inputPath: path.join(dir, 'rows.json'),
        rawInput: { rows: [desired] },
        type: 'flow',
        outDir: path.join(dir, `out-${retained}`),
        commit: false,
        executionContractPath: writeContract(dir, contractValue),
        env,
        fetchImpl: executionFetch({ state, writes }),
      });
      assert.equal(report.status, 'completed_with_failures', retained);
      assert.equal(report.rows[0]?.status, 'blocked', retained);
      assert.equal(
        report.rows[0]?.operation,
        retained === 'outcome' ? 'retained_outcome' : 'retained_attempt',
        retained,
      );
      assert.equal(report.rows[0]?.attempt_consumed, true, retained);
      assert.equal(report.rows[0]?.readback, 'not_performed', retained);
      assert.match(
        report.rows[0]?.error?.message ?? '',
        retained === 'outcome' ? /terminal attempt evidence/iu : /unresolved attempt/iu,
        retained,
      );
      assert.equal(
        readFileSync(ledgerPath, 'utf8'),
        beforeBytes,
        'a dry-run never rewrites ledger bytes',
      );
      assert.deepEqual(writes, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
