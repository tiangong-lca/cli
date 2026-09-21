import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDatasetSaveDraft, __testInternals } from '../src/lib/dataset-save-draft-run.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import { resolveTidasSdkPath } from './helpers/tidas-sdk-path.js';

type JsonObject = Record<string, unknown>;

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const PROCESS_VERSION = '01.00.000';

const DATA_SOURCE_TEXT_PATH =
  'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text';
const OWNERSHIP_TEXT_PATH =
  'processDataSet.administrativeInformation.publicationAndOwnership.common:referenceToOwnershipOfDataSet.common:shortDescription.#text';

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): JsonObject {
  assert.ok(isRecord(value), `expected object, received ${JSON.stringify(value)}`);
  return value;
}

function processFixture(): JsonObject {
  return JSON.parse(
    readFileSync(resolveTidasSdkPath('test-data', 'process-annual-volume.json'), 'utf8'),
  ) as JsonObject;
}

function sourcesOf(payload: JsonObject): JsonObject {
  return record(
    record(record(payload.processDataSet).modellingAndValidation)
      .dataSourcesTreatmentAndRepresentativeness,
  );
}

function dataSourceReference(payload: JsonObject): JsonObject {
  return record(sourcesOf(payload).referenceToDataSource);
}

function ownershipReference(payload: JsonObject): JsonObject {
  return record(
    record(record(payload.processDataSet).administrativeInformation).publicationAndOwnership,
  )['common:referenceToOwnershipOfDataSet'] as JsonObject;
}

/** SDK-valid unknown annual volume on both sides: the repair candidate baseline. */
function unknownAnnualFixture(): JsonObject {
  const payload = processFixture();
  sourcesOf(payload).annualSupplyOrProductionVolume = [];
  return payload;
}

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

function jwt(userId = OWNER_USER_ID, email = 'user@example.com'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, email }), 'utf8').toString('base64url');
  return `${header}.${payload}.signature`;
}

function processFetch(options: {
  state: Map<string, JsonObject>;
  writes: string[];
  calls: Array<{ path: string; body: JsonObject }>;
  userId?: string;
  rowUserOverride?: string;
  rowStateOverride?: number;
}): FetchLike {
  const userId = options.userId ?? OWNER_USER_ID;
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/oauth/userinfo')) {
      return response({ sub: userId, email: 'user@example.com' });
    }
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        accessToken: jwt(userId),
        userId,
        email: 'user@example.com',
      });
    }
    const parsed = new URL(url);
    if (parsed.pathname.includes('/functions/v1/app_dataset_')) {
      const body = JSON.parse(String(init?.body)) as JsonObject & {
        id: string;
        jsonOrdered: JsonObject;
      };
      options.calls.push({ path: parsed.pathname, body });
      options.writes.push(body.id);
      options.state.set(body.id, body.jsonOrdered);
      return response({ ok: true, operation: 'save_draft' });
    }
    if (parsed.pathname.endsWith('/processes')) {
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
      const payload = options.state.get(id);
      return response(
        payload
          ? [
              {
                id,
                version: PROCESS_VERSION,
                user_id: options.rowUserOverride ?? userId,
                state_code: options.rowStateOverride ?? 0,
                json_ordered: payload,
              },
            ]
          : [],
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function writeJsonFile(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function executionEnv(dir: string, apiKey: string): NodeJS.ProcessEnv {
  return buildSupabaseTestEnv({
    TIANGONG_LCA_ACCESS_TOKEN: jwt(),
    XDG_STATE_HOME: path.join(dir, 'state'),
    TIANGONG_LCA_ACTOR: apiKey,
  });
}

function processContract(options: {
  before: JsonObject;
  desired: JsonObject;
  operation?: 'insert' | 'save_draft';
}): JsonObject {
  const operation = options.operation ?? 'save_draft';
  return {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: `process-metadata-repair-${operation}`,
    project_ref: 'example',
    target_mode: 'owner_draft',
    owner: { user_id: OWNER_USER_ID, email: 'user@example.com', state_code: 0 },
    actions: [
      {
        action_id: 'action-1',
        desired_sha256: sha256Json(options.desired),
        expected_operation: operation,
        table: 'processes',
        id: PROCESS_ID,
        version: PROCESS_VERSION,
        before_sha256: operation === 'save_draft' ? sha256Json(options.before) : null,
        dependency_action_ids: [],
      },
    ],
  };
}

async function runRepair(options: {
  dir: string;
  before?: JsonObject;
  candidate: JsonObject;
  commit: boolean;
  operation?: 'insert' | 'save_draft';
  rowUserOverride?: string;
  rowStateOverride?: number;
  contractBefore?: JsonObject;
  type?: string;
}) {
  const before = options.before ?? unknownAnnualFixture();
  const contractPath = writeJsonFile(
    options.dir,
    'contract.json',
    processContract({
      before: options.contractBefore ?? before,
      desired: options.candidate,
      ...(options.operation ? { operation: options.operation } : {}),
    }),
  );
  const calls: Array<{ path: string; body: JsonObject }> = [];
  const writes: string[] = [];
  const fetchImpl = processFetch({
    state: new Map([[PROCESS_ID, before]]),
    writes,
    calls,
    ...(options.rowUserOverride ? { rowUserOverride: options.rowUserOverride } : {}),
    ...(options.rowStateOverride !== undefined
      ? { rowStateOverride: options.rowStateOverride }
      : {}),
  });
  const report = await runDatasetSaveDraft({
    inputPath: path.join(options.dir, 'rows.json'),
    rawInput: { rows: [options.candidate] },
    type: options.type ?? 'process',
    outDir: path.join(options.dir, options.commit ? 'commit-out' : 'dry-run-out'),
    commit: options.commit,
    executionContractPath: contractPath,
    env: executionEnv(options.dir, 'metadata-repair'),
    fetchImpl,
  });
  return {
    report,
    row: report.rows[0],
    calls,
    writes,
    commands: calls.filter((call) => call.path.includes('/functions/v1/app_dataset_')),
  };
}

function withDir(name: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tg-cli-${name}-`));
  return (async () => {
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('metadata repair admission dispatches the guarded before image with ruleVerification false', async () => {
  for (const allowed of [
    {
      name: 'data source short description',
      path: DATA_SOURCE_TEXT_PATH,
      mutate: (p: JsonObject) => dataSourceReference(p),
    },
    {
      name: 'ownership short description',
      path: OWNERSHIP_TEXT_PATH,
      mutate: (p: JsonObject) => ownershipReference(p),
    },
  ] as const) {
    await withDir('metadata-repair-commit', async (dir) => {
      const before = unknownAnnualFixture();
      const candidate = structuredClone(before);
      const shortDescription = record(allowed.mutate(candidate)['common:shortDescription']);
      shortDescription['#text'] = `${String(shortDescription['#text'])} (reviewed)`;

      const { row, commands, writes } = await runRepair({ dir, before, candidate, commit: true });

      assert.equal(row?.status, 'executed', allowed.name);
      assert.equal(row?.readback, 'desired_exact', allowed.name);
      assert.equal(row?.validation?.ok, false, allowed.name);
      assert.equal(
        row?.validation?.validation_layers?.authoring_evidence.status,
        'failed',
        allowed.name,
      );
      assert.deepEqual(
        row?.validation?.validation_layers?.authoring_evidence.issues.map((issue) => issue.code),
        ['annual_supply_or_production_volume_missing'],
        allowed.name,
      );
      assert.deepEqual(row?.draft_repair_admission, {
        schema: 'dataset-draft-repair-admission.v1',
        status: 'admitted',
        policy: 'process-metadata-unknown-annual.v1',
        before_sha256: sha256Json(before),
        desired_sha256: sha256Json(candidate),
        changed_paths: [allowed.path],
        publication_ready: false,
      });
      assert.equal(commands.length, 1, allowed.name);
      const body = commands[0]?.body as JsonObject;
      assert.deepEqual(body.jsonOrdered, candidate, allowed.name);
      assert.deepEqual(body.expectedJsonOrdered, before, allowed.name);
      assert.equal(body.ruleVerification, false, allowed.name);
      assert.deepEqual(writes, [PROCESS_ID], allowed.name);
    });
  }
});

test('metadata repair admission gives the same evidence in a dry-run without dispatching', async () => {
  await withDir('metadata-repair-dry-run', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';

    const { report, row, commands, writes } = await runRepair({
      dir,
      before,
      candidate,
      commit: false,
    });

    assert.equal(report.mode, 'dry_run');
    assert.equal(report.commit, false);
    assert.equal(report.counts.prepared, 1);
    assert.equal(row?.status, 'prepared');
    assert.equal(row?.operation, 'would_sync');
    assert.equal(row?.attempt_consumed, false);
    assert.equal(row?.validation?.ok, false);
    assert.deepEqual(row?.draft_repair_admission, {
      schema: 'dataset-draft-repair-admission.v1',
      status: 'admitted',
      policy: 'process-metadata-unknown-annual.v1',
      before_sha256: sha256Json(before),
      desired_sha256: sha256Json(candidate),
      changed_paths: [OWNERSHIP_TEXT_PATH],
      publication_ready: false,
    });
    assert.deepEqual(commands, []);
    assert.deepEqual(writes, []);
  });
});

test('metadata repair admission rejects a foreign owner, a stale before hash and a non-draft state', async () => {
  const cases: Array<{
    name: string;
    options: { rowUserOverride?: string; rowStateOverride?: number; contractBefore?: JsonObject };
    message: RegExp;
  }> = [
    {
      name: 'foreign owner',
      options: { rowUserOverride: '99999999-9999-4999-8999-999999999999' },
      message: /before-state or expected operation drifted/u,
    },
    {
      name: 'stale before hash',
      options: { contractBefore: processFixture() },
      message: /before-state or expected operation drifted/u,
    },
    {
      name: 'non-draft state',
      options: { rowStateOverride: 100 },
      message: /before-state or expected operation drifted/u,
    },
  ];
  for (const scenario of cases) {
    await withDir('metadata-repair-before', async (dir) => {
      const before = unknownAnnualFixture();
      const candidate = structuredClone(before);
      record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
      const { row, commands, writes } = await runRepair({
        dir,
        before,
        candidate,
        commit: true,
        ...scenario.options,
      });
      assert.equal(row?.status, 'failed', scenario.name);
      assert.match(row?.error?.message ?? '', scenario.message, scenario.name);
      assert.equal(row?.attempt_consumed, false, scenario.name);
      assert.equal(row?.draft_repair_admission, undefined, scenario.name);
      assert.deepEqual(commands, [], scenario.name);
      assert.deepEqual(writes, [], scenario.name);
    });
  }
});

test('metadata repair admission refuses any blocker beyond the single annual evidence gap', async () => {
  const withCandidate = async (
    name: string,
    mutate: (payload: JsonObject) => void,
    expected: RegExp,
  ) => {
    await withDir(`metadata-repair-blocker-${name}`, async (dir) => {
      const before = unknownAnnualFixture();
      const candidate = structuredClone(before);
      record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
      mutate(candidate);
      const { row, commands } = await runRepair({ dir, before, candidate, commit: true });
      assert.equal(row?.status, 'failed', name);
      assert.equal(row?.operation, 'skipped_invalid', name);
      assert.match(row?.error?.message ?? '', expected, name);
      assert.equal(row?.draft_repair_admission, undefined, name);
      assert.deepEqual(commands, [], name);
    });
  };

  await withCandidate(
    'schema-failure',
    (payload) => {
      record(record(record(payload.processDataSet).processInformation).dataSetInformation).name =
        undefined;
    },
    /Local dataset validation failed/u,
  );
  await withCandidate(
    'other-annual-authoring-code',
    (payload) => {
      sourcesOf(payload).annualSupplyOrProductionVolume = [{ '@xml:lang': 'en', '#text': '12' }];
    },
    /Local dataset validation failed/u,
  );
  await withCandidate(
    'additional-authoring-gap',
    (payload) => {
      record(record(record(payload.processDataSet).modellingAndValidation).validation).review =
        'pending confirmation';
    },
    /Local dataset validation failed/u,
  );
});

test('metadata repair admission refuses science, identity and shape changes after the fresh read', async () => {
  const cases: Array<{
    name: string;
    mutate: (payload: JsonObject) => void;
    path: string;
    rejectedBy?: 'validation';
  }> = [
    {
      name: 'exchange-amount',
      mutate: (payload) => {
        const exchanges = record(record(payload.processDataSet).exchanges);
        record((exchanges.exchange as JsonObject[])[0])['meanAmount'] = '42';
      },
      path: 'processDataSet.exchanges.exchange[0].meanAmount',
    },
    {
      name: 'reference-id',
      mutate: (payload) => {
        ownershipReference(payload)['@refObjectId'] = '99999999-9999-4999-8999-999999999999';
      },
      path: 'processDataSet.administrativeInformation.publicationAndOwnership.common:referenceToOwnershipOfDataSet.@refObjectId',
    },
    {
      // A language change is refused before admission even runs: the platform validation keeps
      // requiring the reviewed English text, so this candidate never becomes a repair candidate.
      name: 'reference-language',
      mutate: (payload) => {
        record(ownershipReference(payload)['common:shortDescription'])['@xml:lang'] = 'zh';
      },
      path: 'validation',
      rejectedBy: 'validation',
    },
    {
      name: 'added-language',
      mutate: (payload) => {
        const reference = ownershipReference(payload);
        const existing = record(reference['common:shortDescription']);
        reference['common:shortDescription'] = [existing, { '@xml:lang': 'zh', '#text': '所有者' }];
      },
      path: 'processDataSet.administrativeInformation.publicationAndOwnership.common:referenceToOwnershipOfDataSet.common:shortDescription',
    },
    {
      name: 'single-to-array-shape',
      mutate: (payload) => {
        const reference = dataSourceReference(payload);
        reference['common:shortDescription'] = [record(reference['common:shortDescription'])];
      },
      path: 'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription',
    },
  ];
  for (const scenario of cases) {
    await withDir(`metadata-repair-diff-${scenario.name}`, async (dir) => {
      const before = unknownAnnualFixture();
      const candidate = structuredClone(before);
      scenario.mutate(candidate);
      const { row, commands, writes } = await runRepair({ dir, before, candidate, commit: true });
      assert.equal(row?.status, 'failed', scenario.name);
      assert.equal(row?.draft_repair_admission, undefined, scenario.name);
      if (scenario.rejectedBy === 'validation') {
        assert.equal(row?.operation, 'skipped_invalid', scenario.name);
        assert.match(row?.error?.message ?? '', /Local dataset validation failed/u, scenario.name);
      } else {
        assert.match(row?.error?.message ?? '', /not admitted/u, scenario.name);
        assert.deepEqual(
          (row?.error?.details as JsonObject | undefined)?.violations,
          [scenario.path],
          scenario.name,
        );
      }
      assert.deepEqual(commands, [], scenario.name);
      assert.deepEqual(writes, [], scenario.name);
    });
  }
});

test('metadata repair admission refuses an unchanged payload and a changed annual volume', async () => {
  await withDir('metadata-repair-unchanged', async (dir) => {
    const before = unknownAnnualFixture();
    const { row, commands } = await runRepair({
      dir,
      before,
      candidate: structuredClone(before),
      commit: true,
    });
    assert.equal(row?.status, 'failed');
    assert.match(row?.error?.message ?? '', /not admitted/u);
    assert.deepEqual((row?.error?.details as JsonObject | undefined)?.changed_paths, []);
    assert.deepEqual(commands, []);
  });

  await withDir('metadata-repair-annual-changed', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    sourcesOf(candidate).annualSupplyOrProductionVolume = [
      { '@xml:lang': 'en', '#text': 'Not specified' },
    ];
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    const { row, commands } = await runRepair({ dir, before, candidate, commit: true });
    assert.equal(row?.status, 'failed');
    assert.equal(row?.operation, 'skipped_invalid');
    assert.equal(row?.draft_repair_admission, undefined);
    assert.deepEqual(commands, [], 'the annual exception never widens to another unknown shape');
  });

  await withDir('metadata-repair-annual-absent-before', async (dir) => {
    const before = processFixture();
    delete sourcesOf(before).annualSupplyOrProductionVolume;
    const candidate = structuredClone(before);
    sourcesOf(candidate).annualSupplyOrProductionVolume = [];
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    const { row, commands } = await runRepair({ dir, before, candidate, commit: true });
    assert.equal(row?.status, 'failed');
    assert.match(row?.error?.message ?? '', /not admitted/u);
    assert.deepEqual(commands, []);
  });
});

test('metadata repair admission never applies to inserts or to commands without a contract', async () => {
  await withDir('metadata-repair-insert', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    const { row, commands } = await runRepair({
      dir,
      before,
      candidate,
      commit: true,
      operation: 'insert',
      contractBefore: before,
    });
    assert.equal(row?.status, 'failed');
    assert.equal(row?.operation, 'skipped_invalid');
    assert.equal(row?.draft_repair_admission, undefined);
    assert.deepEqual(commands, []);
  });

  await withDir('metadata-repair-no-contract', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    const calls: Array<{ path: string; body: JsonObject }> = [];
    const writes: string[] = [];
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [candidate] },
      type: 'process',
      outDir: path.join(dir, 'out'),
      commit: true,
      env: executionEnv(dir, 'metadata-repair-no-contract'),
      fetchImpl: processFetch({
        state: new Map([[PROCESS_ID, before]]),
        writes,
        calls,
      }),
    });
    assert.equal(report.schema_version, 1);
    assert.equal(report.rows[0]?.status, 'failed');
    assert.equal(report.rows[0]?.operation, 'skipped_invalid');
    assert.equal(
      report.rows[0]?.draft_repair_admission,
      undefined,
      'a contract-less command never enters the repair exception',
    );
    assert.deepEqual(
      calls.filter((call) => call.path.includes('/functions/v1/app_dataset_')),
      [],
    );
    assert.deepEqual(writes, []);
  });
});

test('metadata repair admission leaves a fully valid candidate on the ordinary verified write path', async () => {
  await withDir('metadata-repair-fully-valid', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    // A real annual volume plus the reviewed short description makes the candidate fully valid:
    // it must take the ordinary path (ruleVerification true, no repair admission).
    sourcesOf(candidate).annualSupplyOrProductionVolume = [
      { '@xml:lang': 'en', '#text': '120 kg/year' },
    ];
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';

    const { row, commands } = await runRepair({ dir, before, candidate, commit: true });

    assert.equal(row?.status, 'executed');
    assert.equal(row?.validation?.ok, true);
    assert.equal(row?.draft_repair_admission, undefined);
    assert.equal(commands.length, 1);
    assert.equal((commands[0]?.body as JsonObject).ruleVerification, true);
  });
});

// ---------------------------------------------------------------------------------------------
// Direct policy-module tests: every branch of the walker and the candidate gate, independent of
// the runner, so no counterexample depends on how the command classifies a payload.
// ---------------------------------------------------------------------------------------------

import {
  evaluateProcessMetadataRepairAdmission,
  isProcessMetadataRepairCandidate,
} from '../src/lib/dataset-draft-repair-admission.js';

function repairLayer(status: 'passed' | 'failed', codes: string[] = []) {
  return { status, issues: codes.map((code) => ({ code })) };
}

function repairValidation(options: {
  ok: boolean;
  schema?: 'passed' | 'failed';
  authoring?: 'passed' | 'failed';
  authoringCodes?: string[];
  content?: 'passed' | 'failed';
  multilingual?: 'passed' | 'failed';
  withLayers?: boolean;
}) {
  const layers = {
    schema: repairLayer(options.schema ?? 'passed'),
    authoring_evidence: repairLayer(options.authoring ?? 'passed', options.authoringCodes ?? []),
    content: repairLayer(options.content ?? 'passed'),
    multilingual: repairLayer(options.multilingual ?? 'passed'),
  };
  return options.withLayers === false
    ? { ok: options.ok }
    : { ok: options.ok, validation_layers: layers };
}

const ANNUAL = 'annual_supply_or_production_volume_missing';

test('repair candidate gate admits only the bounded save_draft Process annual gap', () => {
  const base = { operation: 'save_draft', table: 'processes' };
  const cases: Array<
    [string, boolean, { operation?: string; table?: string; validation: unknown }]
  > = [
    [
      'bounded candidate',
      true,
      {
        ...base,
        validation: repairValidation({ ok: false, authoring: 'failed', authoringCodes: [ANNUAL] }),
      },
    ],
    [
      'insert is never a candidate',
      false,
      {
        ...base,
        operation: 'insert',
        validation: repairValidation({ ok: false, authoring: 'failed', authoringCodes: [ANNUAL] }),
      },
    ],
    [
      'non-process table',
      false,
      {
        ...base,
        table: 'flows',
        validation: repairValidation({ ok: false, authoring: 'failed', authoringCodes: [ANNUAL] }),
      },
    ],
    ['missing validation', false, { ...base, validation: null }],
    [
      'validation without layers',
      false,
      { ...base, validation: repairValidation({ ok: false, withLayers: false }) },
    ],
    ['already valid candidate', false, { ...base, validation: repairValidation({ ok: true }) }],
    [
      'schema failed',
      false,
      {
        ...base,
        validation: repairValidation({
          ok: false,
          schema: 'failed',
          authoring: 'failed',
          authoringCodes: [ANNUAL],
        }),
      },
    ],
    [
      'content failed',
      false,
      {
        ...base,
        validation: repairValidation({
          ok: false,
          content: 'failed',
          authoring: 'failed',
          authoringCodes: [ANNUAL],
        }),
      },
    ],
    [
      'multilingual failed',
      false,
      {
        ...base,
        validation: repairValidation({
          ok: false,
          multilingual: 'failed',
          authoring: 'failed',
          authoringCodes: [ANNUAL],
        }),
      },
    ],
    [
      'authoring passed',
      false,
      { ...base, validation: repairValidation({ ok: false, schema: 'failed' }) },
    ],
    [
      'authoring failed without issues',
      false,
      { ...base, validation: repairValidation({ ok: false, authoring: 'failed' }) },
    ],
    [
      'authoring failed with another code',
      false,
      {
        ...base,
        validation: repairValidation({
          ok: false,
          authoring: 'failed',
          authoringCodes: ['process_placeholder_content'],
        }),
      },
    ],
    [
      'authoring failed with the annual code plus another',
      false,
      {
        ...base,
        validation: repairValidation({
          ok: false,
          authoring: 'failed',
          authoringCodes: [ANNUAL, 'process_placeholder_content'],
        }),
      },
    ],
  ];
  for (const [name, expected, options] of cases) {
    assert.equal(isProcessMetadataRepairCandidate(options as never), expected, name);
  }
});

function repairTree(): JsonObject {
  return {
    processDataSet: {
      modellingAndValidation: {
        dataSourcesTreatmentAndRepresentativeness: {
          annualSupplyOrProductionVolume: [],
          referenceToDataSource: {
            'common:shortDescription': { '@xml:lang': 'en', '#text': 'source text' },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:referenceToOwnershipOfDataSet': {
            'common:shortDescription': { '@xml:lang': 'en', '#text': 'owner text' },
          },
        },
      },
    },
  };
}

function admit(before: unknown, candidate: unknown, beforeValidation?: unknown) {
  return evaluateProcessMetadataRepairAdmission({
    before,
    candidate,
    beforeValidation: (beforeValidation ??
      repairValidation({
        ok: false,
        authoring: 'failed',
        authoringCodes: [ANNUAL],
      })) as never,
    beforeSha256: 'a'.repeat(64),
    desiredSha256: 'b'.repeat(64),
  });
}

test('repair admission walker admits only reviewed text leaves and rejects every other shape', () => {
  const before = repairTree();

  const changed = structuredClone(before);
  record(
    record(
      record(record(changed.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 'source text v2' };
  const admitted = admit(before, changed);
  assert.equal(admitted.status, 'admitted');
  assert.deepEqual(admitted.status === 'admitted' ? admitted.admission.changed_paths : [], [
    'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text',
  ]);
  assert.equal(admitted.status === 'admitted' ? admitted.admission.publication_ready : null, false);
  assert.equal(
    admitted.status === 'admitted' ? admitted.admission.before_sha256 : '',
    'a'.repeat(64),
  );

  const arrayBefore = structuredClone(before);
  const arrayCandidate = structuredClone(before);
  const list = [
    { '@xml:lang': 'en', '#text': 'one' },
    { '@xml:lang': 'de', '#text': 'zwei' },
  ];
  record(
    record(
      record(record(arrayBefore.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = structuredClone(list);
  const arrayList = structuredClone(list);
  record(arrayList[1])['#text'] = 'drei';
  record(
    record(
      record(record(arrayCandidate.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = arrayList;
  const arrayAdmitted = admit(arrayBefore, arrayCandidate);
  assert.equal(arrayAdmitted.status, 'admitted');
  assert.deepEqual(
    arrayAdmitted.status === 'admitted' ? arrayAdmitted.admission.changed_paths : [],
    [
      'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription[1].#text',
    ],
  );

  const cases: Array<{
    name: string;
    mutate: (candidate: JsonObject) => void;
    violations: string[];
  }> = [
    {
      name: 'unnamed field',
      mutate: (candidate) => {
        record(candidate.processDataSet)['@version'] = '1.2';
      },
      violations: ['processDataSet.@version'],
    },
    {
      name: 'array length',
      mutate: (candidate) => {
        record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        )['common:shortDescription'] = [
          { '@xml:lang': 'en', '#text': 'source text' },
          { '@xml:lang': 'de', '#text': 'Quelle' },
        ];
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription',
      ],
    },
    {
      name: 'object where the stored side is an array',
      mutate: (candidate) => {
        record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        )['common:shortDescription'] = [{ '@xml:lang': 'en', '#text': 'source text' }];
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription',
      ],
    },
    {
      name: 'removed key',
      mutate: (candidate) => {
        const leaf = record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        );
        delete record(leaf['common:shortDescription'])['#text'];
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text',
      ],
    },
    {
      name: 'added key',
      mutate: (candidate) => {
        const leaf = record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        );
        record(leaf['common:shortDescription'])['@id'] = 'x';
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.@id',
      ],
    },
    {
      name: 'record replaced by primitive',
      mutate: (candidate) => {
        record(
          record(record(candidate.processDataSet).modellingAndValidation)
            .dataSourcesTreatmentAndRepresentativeness,
        )['referenceToDataSource'] = 'not-an-object';
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource',
      ],
    },
    {
      name: 'reviewed leaf is not a string in the candidate',
      mutate: (candidate) => {
        record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 7 };
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text',
      ],
    },
    {
      // The stored side is a number, so the reviewed leaf cannot be a bounded text repair.
      name: 'reviewed leaf is not a string in the stored image',
      mutate: (candidate) => {
        record(
          record(
            record(record(candidate.processDataSet).modellingAndValidation)
              .dataSourcesTreatmentAndRepresentativeness,
          ).referenceToDataSource,
        )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 'source text' };
      },
      violations: [
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text',
      ],
    },
  ];
  for (const scenario of cases) {
    const stored = structuredClone(before);
    if (scenario.name === 'reviewed leaf is not a string in the stored image') {
      record(
        record(
          record(record(stored.processDataSet).modellingAndValidation)
            .dataSourcesTreatmentAndRepresentativeness,
        ).referenceToDataSource,
      )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 7 };
    }
    const candidate = structuredClone(stored);
    scenario.mutate(candidate);
    const outcome = admit(stored, candidate);
    assert.equal(outcome.status, 'rejected', scenario.name);
    assert.deepEqual(
      outcome.status === 'rejected' ? outcome.details.violations : null,
      scenario.violations,
      scenario.name,
    );
  }
});

test('repair admission walker refuses an unchanged payload and a non-unknown annual volume', () => {
  const before = repairTree();

  const unchanged = admit(before, structuredClone(before));
  assert.equal(unchanged.status, 'rejected');
  assert.equal(
    unchanged.status === 'rejected' ? unchanged.code : '',
    'draft_repair_requires_change',
  );

  for (const stored of [
    (() => {
      const value = repairTree();
      delete record(
        record(record(value.processDataSet).modellingAndValidation)
          .dataSourcesTreatmentAndRepresentativeness,
      ).annualSupplyOrProductionVolume;
      return value;
    })(),
    (() => {
      const value = repairTree();
      record(
        record(record(value.processDataSet).modellingAndValidation)
          .dataSourcesTreatmentAndRepresentativeness,
      ).annualSupplyOrProductionVolume = [{ '@xml:lang': 'en', '#text': 'Not specified' }];
      return value;
    })(),
    'not-an-object',
  ]) {
    const outcome = admit(stored, structuredClone(before));
    assert.equal(outcome.status, 'rejected');
    assert.equal(
      outcome.status === 'rejected' ? outcome.code : '',
      'draft_repair_annual_volume_not_unknown',
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The stored draft must pass the same real validator as the candidate, and a crash between
// dispatch and outcome must carry the original admission through the existing attempt ledger.
// ---------------------------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';

function ledgerEvent(options: {
  contractSha256: string;
  action: JsonObject;
  sequence: number;
  eventType: 'attempt_emitted' | 'outcome';
  outcome: 'executed' | 'unknown' | null;
  previousEventSha256?: string | null;
  admission?: JsonObject;
}): JsonObject {
  const core: JsonObject = {
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
    ...(options.admission ? { draft_repair_admission: options.admission } : {}),
    previous_event_sha256: options.previousEventSha256 ?? null,
  };
  return { ...core, event_sha256: sha256Json(core) };
}

function writeLedgerEvents(filePath: string, events: JsonObject[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function ledgerPathFor(dir: string, apiKey: string) {
  const contractValue = JSON.parse(
    readFileSync(path.join(dir, 'contract.json'), 'utf8'),
  ) as JsonObject;
  const parsed = __testInternals.parseExecutionContract(contractValue);
  const env = executionEnv(dir, apiKey);
  const ledgerRoot = __testInternals.executionLedgerRoot(env, parsed);
  return {
    env,
    parsed,
    ledgerRoot,
    ledgerPath: __testInternals.executionLedgerPath(ledgerRoot, parsed.actions[0]!),
  };
}

test('metadata repair admission validates the stored draft with the same real validator', async () => {
  const cases: Array<{ name: string; mutateBefore: (payload: JsonObject) => void }> = [
    {
      name: 'placeholder stored text',
      mutateBefore: (payload) => {
        record(ownershipReference(payload)['common:shortDescription'])['#text'] =
          'pending confirmation';
      },
    },
    {
      name: 'schema-invalid stored draft',
      mutateBefore: (payload) => {
        delete record(record(record(payload.processDataSet).processInformation).dataSetInformation)[
          'name'
        ];
      },
    },
    {
      name: 'stored draft with a second authoring gap',
      mutateBefore: (payload) => {
        record(record(record(payload.processDataSet).modellingAndValidation).validation)['review'] =
          'pending confirmation';
      },
    },
  ];
  for (const scenario of cases) {
    await withDir(
      `metadata-repair-before-invalid-${scenario.name.replace(/ /gu, '-')}`,
      async (dir) => {
        const before = unknownAnnualFixture();
        scenario.mutateBefore(before);
        const candidate = structuredClone(before);
        record(ownershipReference(candidate)['common:shortDescription'])['#text'] =
          'Reviewed owner';
        const { row, commands, writes } = await runRepair({ dir, before, candidate, commit: true });
        assert.equal(row?.status, 'failed', scenario.name);
        assert.equal(row?.draft_repair_admission, undefined, scenario.name);
        assert.deepEqual(commands, [], scenario.name);
        assert.deepEqual(writes, [], scenario.name);
      },
    );
  }
});

test('metadata repair admission never creates a reference description the stored draft never had', async () => {
  await withDir('metadata-repair-blank-text', async (dir) => {
    const before = unknownAnnualFixture();
    record(ownershipReference(before)['common:shortDescription'])['#text'] = '';
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    const { row, commands } = await runRepair({ dir, before, candidate, commit: true });
    assert.equal(row?.status, 'failed');
    assert.equal(row?.draft_repair_admission, undefined);
    assert.match(row?.error?.message ?? '', /not admitted/u);
    assert.equal(
      (row?.error?.details as JsonObject | undefined)?.code,
      'draft_repair_text_requires_content',
    );
    assert.deepEqual(commands, []);
  });

  await withDir('metadata-repair-whitespace-only', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] =
      `${String(record(ownershipReference(before)['common:shortDescription'])['#text'])} `;
    const { row, commands } = await runRepair({ dir, before, candidate, commit: true });
    assert.equal(row?.status, 'failed');
    assert.match(row?.error?.message ?? '', /not admitted/u);
    assert.deepEqual(commands, []);
  });
});

test('metadata repair admission survives a crash between dispatch and outcome through the attempt ledger', async () => {
  await withDir('metadata-repair-crash-recovery', async (dir) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';

    const first = await runRepair({ dir, before, candidate, commit: true });
    const admission = first.row?.draft_repair_admission;
    assert.ok(admission, 'the first run records the admission');

    const { env, parsed, ledgerPath } = ledgerPathFor(dir, 'metadata-repair');
    const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2, 'the first run wrote one attempt and one outcome');
    // Crash after dispatch, before the outcome: only the original attempt survives.
    writeFileSync(ledgerPath, `${lines[0]}\n`, 'utf8');
    const attemptBytes = readFileSync(ledgerPath, 'utf8');
    assert.match(attemptBytes, /draft_repair_admission/u);

    const second = await runRepair({
      dir,
      before: candidate,
      contractBefore: before,
      candidate,
      commit: true,
    });

    assert.equal(second.row?.status, 'executed', JSON.stringify(second.row?.error));
    assert.equal(second.row?.operation, 'recovered_exact_readback');
    assert.equal(second.row?.attempt_consumed, true);
    assert.equal(second.row?.readback, 'desired_exact');
    assert.deepEqual(second.row?.draft_repair_admission, admission);
    assert.equal(second.row?.validation?.ok, false);
    assert.deepEqual(second.commands, [], 'recovery never dispatches again');
    assert.deepEqual(second.writes, []);
    const after = readFileSync(ledgerPath, 'utf8');
    assert.ok(after.startsWith(attemptBytes), 'the original attempt bytes are preserved');
    assert.equal(after.trimEnd().split('\n').length, 2, 'recovery appends exactly one outcome');
    assert.equal(__testInternals.executionLedgerRoot(env, parsed), path.dirname(ledgerPath));

    // A rerun that already owns a terminal outcome returns the same original admission through the
    // retained-outcome path instead of re-deriving it from the current (desired) content.
    const completedBytes = readFileSync(ledgerPath, 'utf8');
    const third = await runRepair({
      dir,
      before: candidate,
      contractBefore: before,
      candidate,
      commit: true,
    });
    assert.equal(third.row?.status, 'executed');
    assert.equal(third.row?.attempt_consumed, true);
    assert.deepEqual(third.row?.draft_repair_admission, admission);
    assert.equal(third.row?.validation?.ok, false);
    assert.deepEqual(third.commands, []);
    assert.equal(
      readFileSync(ledgerPath, 'utf8'),
      completedBytes,
      'a terminal rerun writes nothing',
    );
  });
});

test('a tampered or semantically invalid admission can never be a trusted metadata success', async () => {
  const build = async (dir: string) => {
    const before = unknownAnnualFixture();
    const candidate = structuredClone(before);
    record(ownershipReference(candidate)['common:shortDescription'])['#text'] = 'Reviewed owner';
    await runRepair({ dir, before, candidate, commit: true });
    const { env, parsed, ledgerPath } = ledgerPathFor(dir, 'metadata-repair');
    const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
    writeFileSync(ledgerPath, `${lines[0]}\n`, 'utf8');
    return { before, candidate, env, parsed, ledgerPath };
  };

  await withDir('metadata-repair-tamper-text', async (dir) => {
    const { before, candidate, env, parsed, ledgerPath } = await build(dir);
    const attempt = JSON.parse(readFileSync(ledgerPath, 'utf8').trimEnd()) as JsonObject;
    const admission = record(attempt.draft_repair_admission);
    admission.changed_paths = ['processDataSet.exchanges.exchange[0].meanAmount'];
    writeFileSync(ledgerPath, `${JSON.stringify(attempt)}\n`, 'utf8');
    await assert.rejects(
      () =>
        runRepair({
          dir,
          before: candidate,
          contractBefore: before,
          candidate,
          commit: true,
        }),
      /ledger event/u,
      'an edited admission breaks the hashed attempt',
    );
    assert.equal(__testInternals.executionLedgerRoot(env, parsed).length > 0, true);
  });

  await withDir('metadata-repair-tamper-drop', async (dir) => {
    const { before, candidate } = await build(dir);
    const { ledgerPath } = ledgerPathFor(dir, 'metadata-repair');
    const attempt = JSON.parse(readFileSync(ledgerPath, 'utf8').trimEnd()) as JsonObject;
    delete attempt.draft_repair_admission;
    writeFileSync(ledgerPath, `${JSON.stringify(attempt)}\n`, 'utf8');
    await assert.rejects(
      () =>
        runRepair({
          dir,
          before: candidate,
          contractBefore: before,
          candidate,
          commit: true,
        }),
      /ledger event/u,
      'dropping a hashed admission breaks the attempt',
    );
  });

  await withDir('metadata-repair-semantic-drift', async (dir) => {
    const { before, candidate, parsed, ledgerPath } = await build(dir);
    const contractSha256 = sha256Json(parsed);
    const action = parsed.actions[0] as unknown as JsonObject;
    const base = {
      schema: 'dataset-draft-repair-admission.v1',
      status: 'admitted',
      policy: 'process-metadata-unknown-annual.v1',
      before_sha256: sha256Json(before),
      desired_sha256: sha256Json(candidate),
      changed_paths: [OWNERSHIP_TEXT_PATH],
      publication_ready: false,
    };
    const invalid: Array<{ name: string; admission: JsonObject }> = [
      { name: 'admission is not an object', admission: 'admitted' as never },
      {
        name: 'changed paths is not an array',
        admission: { ...base, changed_paths: 'x' } as never,
      },
      { name: 'wrong before hash', admission: { ...base, before_sha256: 'a'.repeat(64) } },
      { name: 'wrong desired hash', admission: { ...base, desired_sha256: 'b'.repeat(64) } },
      { name: 'publication ready', admission: { ...base, publication_ready: true } },
      { name: 'unknown policy', admission: { ...base, policy: 'other-policy.v1' } },
      { name: 'empty changed paths', admission: { ...base, changed_paths: [] } },
    ];
    for (const scenario of invalid) {
      writeLedgerEvents(ledgerPath, [
        ledgerEvent({
          contractSha256,
          action,
          sequence: 1,
          eventType: 'attempt_emitted',
          outcome: null,
          admission: scenario.admission,
        }),
      ]);
      await assert.rejects(
        () =>
          runRepair({
            dir,
            before: candidate,
            contractBefore: before,
            candidate,
            commit: true,
          }),
        /ledger event/u,
        scenario.name,
      );
    }
  });
});

test('a legacy attempt without an admission stays compatible and never fabricates one', async () => {
  await withDir('metadata-repair-legacy-attempt', async (dir) => {
    const stored = unknownAnnualFixture();
    const contractValue = processContract({
      before: stored,
      desired: stored,
      operation: 'insert',
    });
    const parsed = __testInternals.parseExecutionContract(contractValue);
    const env = executionEnv(dir, 'metadata-repair-legacy');
    const ledgerPath = __testInternals.executionLedgerPath(
      __testInternals.executionLedgerRoot(env, parsed),
      parsed.actions[0]!,
    );
    writeLedgerEvents(ledgerPath, [
      ledgerEvent({
        contractSha256: sha256Json(parsed),
        action: parsed.actions[0] as unknown as JsonObject,
        sequence: 1,
        eventType: 'attempt_emitted',
        outcome: null,
      }),
    ]);
    const attemptBytes = readFileSync(ledgerPath, 'utf8');
    const calls: Array<{ path: string; body: JsonObject }> = [];
    const writes: string[] = [];
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: [stored] },
      type: 'process',
      outDir: path.join(dir, 'legacy-out'),
      commit: true,
      executionContractPath: writeJsonFile(dir, 'legacy-contract.json', contractValue),
      env,
      fetchImpl: processFetch({ state: new Map([[PROCESS_ID, stored]]), writes, calls }),
    });
    assert.equal(report.rows[0]?.status, 'executed', JSON.stringify(report.rows[0]?.error));
    assert.equal(report.rows[0]?.operation, 'recovered_exact_readback');
    assert.equal(report.rows[0]?.attempt_consumed, true);
    assert.equal(report.rows[0]?.draft_repair_admission, undefined);
    assert.deepEqual(
      calls.filter((call) => call.path.includes('/functions/v1/app_dataset_')),
      [],
    );
    assert.ok(readFileSync(ledgerPath, 'utf8').startsWith(attemptBytes));
  });
});

test('repair admission requires an eligible stored draft and a real, non-blank text change', () => {
  const before = repairTree();
  const changed = structuredClone(before);
  record(
    record(
      record(record(changed.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 'source text v2' };

  for (const [name, beforeValidation] of [
    [
      'stored draft is schema-invalid',
      repairValidation({
        ok: false,
        schema: 'failed',
        authoring: 'failed',
        authoringCodes: [ANNUAL],
      }),
    ],
    [
      'stored draft fails content',
      repairValidation({
        ok: false,
        content: 'failed',
        authoring: 'failed',
        authoringCodes: [ANNUAL],
      }),
    ],
    [
      'stored draft has another authoring code',
      repairValidation({
        ok: false,
        authoring: 'failed',
        authoringCodes: ['process_placeholder_content'],
      }),
    ],
    ['stored draft is already valid', repairValidation({ ok: true })],
    ['stored draft has no layers', repairValidation({ ok: false, withLayers: false })],
  ] as const) {
    const outcome = admit(before, changed, beforeValidation);
    assert.equal(outcome.status, 'rejected', name);
    assert.equal(
      outcome.status === 'rejected' ? outcome.code : '',
      'draft_repair_before_not_eligible',
      name,
    );
  }

  const blankBefore = repairTree();
  record(
    record(
      record(record(blankBefore.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = { '@xml:lang': 'en', '#text': '   ' };
  const filled = structuredClone(blankBefore);
  record(
    record(
      record(record(filled.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 'source text' };
  const blankOutcome = admit(blankBefore, filled);
  assert.equal(blankOutcome.status, 'rejected');
  assert.equal(
    blankOutcome.status === 'rejected' ? blankOutcome.code : '',
    'draft_repair_text_requires_content',
  );

  const whitespace = structuredClone(before);
  record(
    record(
      record(record(whitespace.processDataSet).modellingAndValidation)
        .dataSourcesTreatmentAndRepresentativeness,
    ).referenceToDataSource,
  )['common:shortDescription'] = { '@xml:lang': 'en', '#text': 'source text ' };
  const whitespaceOutcome = admit(before, whitespace);
  assert.equal(whitespaceOutcome.status, 'rejected');
  assert.equal(
    whitespaceOutcome.status === 'rejected' ? whitespaceOutcome.code : '',
    'draft_repair_requires_change',
  );
});
