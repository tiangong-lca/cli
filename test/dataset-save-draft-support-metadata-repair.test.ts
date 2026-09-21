import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDatasetSaveDraft, __testInternals } from '../src/lib/dataset-save-draft-run.js';
import type {
  RepairValidationLayers,
  RepairValidationResult,
} from '../src/lib/dataset-draft-repair-admission.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonObject = Record<string, unknown>;

type FixtureRow = { id: string; version: string; json: JsonObject };

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_EMAIL = 'owner@example.com';
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/support-metadata-repair/', import.meta.url));

const OWNERSHIP_TEXT_SUFFIX =
  'administrativeInformation.publicationAndOwnership.common:referenceToOwnershipOfDataSet.common:shortDescription.#text';
const DATA_SOURCE_TEXT_SUFFIX =
  'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.referenceToDataSource.common:shortDescription.#text';

/** Anonymized copies of the two reviewed support-row shapes (one Flow Property, one Unit Group). */
function fixture(name: string): FixtureRow[] {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as FixtureRow[];
}

const BEFORE_ROWS = fixture('owner-support-before.json');
const CANDIDATE_ROWS = fixture('owner-support-candidate.json');

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): JsonObject {
  assert.ok(isRecord(value), `expected object, received ${JSON.stringify(value)}`);
  return value;
}

function rootKeyOf(row: FixtureRow): string {
  const key = Object.keys(row.json)[0];
  assert.ok(key, 'fixture payload must have a root key');
  return key;
}

function tableOf(row: FixtureRow): 'flowproperties' | 'unitgroups' {
  return rootKeyOf(row) === 'flowPropertyDataSet' ? 'flowproperties' : 'unitgroups';
}

function ownershipTextPath(row: FixtureRow): string {
  return `${rootKeyOf(row)}.${OWNERSHIP_TEXT_SUFFIX}`;
}

function otherUuid(): string {
  return '22222222-2222-4222-8222-222222222222';
}

/** The stored ownership reference whose embedded display text the reviewed repair may rewrite. */
function ownershipReference(payload: JsonObject): JsonObject {
  const root = record(payload[Object.keys(payload)[0] ?? '']);
  const administrativeInformation = record(root['administrativeInformation']);
  const publicationAndOwnership = record(administrativeInformation['publicationAndOwnership']);
  return record(publicationAndOwnership['common:referenceToOwnershipOfDataSet']);
}

function ownershipText(payload: JsonObject): string {
  return String(record(ownershipReference(payload)['common:shortDescription'])['#text']);
}

function withOwnershipText(payload: JsonObject, text: string): JsonObject {
  record(ownershipReference(payload)['common:shortDescription'])['#text'] = text;
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

function jwt(userId = OWNER_USER_ID, email = OWNER_EMAIL): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, email }), 'utf8').toString('base64url');
  return `${header}.${payload}.signature`;
}

function supportFetch(options: {
  state: Map<string, FixtureRow>;
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
      return response({ sub: userId, email: OWNER_EMAIL });
    }
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ accessToken: jwt(userId), userId, email: OWNER_EMAIL });
    }
    const parsed = new URL(url);
    if (parsed.pathname.includes('/functions/v1/app_dataset_')) {
      const body = JSON.parse(String(init?.body)) as JsonObject & {
        id: string;
        jsonOrdered: JsonObject;
      };
      options.calls.push({ path: parsed.pathname, body });
      options.writes.push(body.id);
      const stored = options.state.get(body.id);
      if (stored) {
        stored.json = body.jsonOrdered;
      }
      return response({ ok: true, operation: 'save_draft' });
    }
    const table = ['flowproperties', 'unitgroups'].find((name) =>
      parsed.pathname.endsWith(`/${name}`),
    );
    if (table) {
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
      const stored = options.state.get(id);
      return response(
        stored
          ? [
              {
                id: stored.id,
                version: stored.version,
                user_id: options.rowUserOverride ?? userId,
                state_code: options.rowStateOverride ?? 0,
                json_ordered: stored.json,
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

function supportContract(options: {
  before: FixtureRow[];
  candidate: FixtureRow[];
  operation?: 'insert' | 'save_draft';
}): JsonObject {
  const operation = options.operation ?? 'save_draft';
  return {
    schema_version: 'dataset-save-draft-execution-contract.v1',
    execution_id: `support-metadata-repair-${operation}`,
    project_ref: 'example',
    target_mode: 'owner_draft',
    owner: { user_id: OWNER_USER_ID, email: OWNER_EMAIL, state_code: 0 },
    actions: options.before.map((row, index) => ({
      action_id: `ownership-description-${index + 1}`,
      desired_sha256: sha256Json(options.candidate[index]!.json),
      expected_operation: operation,
      table: tableOf(row),
      id: row.id,
      version: row.version,
      before_sha256: operation === 'save_draft' ? sha256Json(row.json) : null,
      dependency_action_ids: [],
    })),
  };
}

async function runSupportRepair(options: {
  dir: string;
  candidate: FixtureRow[];
  commit: boolean;
  contractBefore?: FixtureRow[];
  /** Rows the mock backend actually holds; defaults to the contract rows. */
  remoteBefore?: FixtureRow[];
  operation?: 'insert' | 'save_draft';
  rowUserOverride?: string;
  rowStateOverride?: number;
  type?: string;
  apiKey?: string;
}) {
  const contractBefore = options.contractBefore ?? options.remoteBefore ?? BEFORE_ROWS;
  const remoteBefore = options.remoteBefore ?? contractBefore;
  const contractPath = writeJsonFile(
    options.dir,
    'contract.json',
    supportContract({
      before: contractBefore,
      candidate: options.candidate,
      ...(options.operation ? { operation: options.operation } : {}),
    }),
  );
  const calls: Array<{ path: string; body: JsonObject }> = [];
  const writes: string[] = [];
  const fetchImpl = supportFetch({
    state: new Map(remoteBefore.map((row) => [row.id, structuredClone(row)])),
    writes,
    calls,
    ...(options.rowUserOverride ? { rowUserOverride: options.rowUserOverride } : {}),
    ...(options.rowStateOverride !== undefined
      ? { rowStateOverride: options.rowStateOverride }
      : {}),
  });
  const report = await runDatasetSaveDraft({
    inputPath: path.join(options.dir, 'rows.json'),
    rawInput: { rows: options.candidate.map((row) => row.json) },
    type: options.type ?? 'auto',
    outDir: path.join(options.dir, options.commit ? 'commit-out' : 'dry-run-out'),
    commit: options.commit,
    executionContractPath: contractPath,
    env: executionEnv(options.dir, options.apiKey ?? 'support-metadata-repair'),
    fetchImpl,
  });
  return {
    report,
    rows: report.rows,
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
    recorded_at_utc: '2026-09-21T04:00:00.000Z',
    ...(options.admission ? { draft_repair_admission: options.admission } : {}),
    previous_event_sha256: options.previousEventSha256 ?? null,
  };
  return { ...core, event_sha256: sha256Json(core) };
}

function writeLedgerEvents(filePath: string, events: JsonObject[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function ledgerPathFor(dir: string, apiKey: string, actionIndex = 0) {
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
    ledgerPath: __testInternals.executionLedgerPath(ledgerRoot, parsed.actions[actionIndex]!),
  };
}

test('support metadata repair dispatches one guarded save per row with the complete before image', async () => {
  await withDir('support-metadata-commit', async (dir) => {
    const { report, rows, commands, writes } = await runSupportRepair({
      dir,
      candidate: CANDIDATE_ROWS,
      commit: true,
    });

    assert.deepEqual(report.counts.by_table, { flowproperties: 1, unitgroups: 1 });
    assert.equal(report.counts.executed, 2);
    assert.equal(commands.length, 2, 'exactly one guarded dispatch per action');

    BEFORE_ROWS.forEach((before, index) => {
      const row = rows[index];
      const candidate = CANDIDATE_ROWS[index]!;
      assert.equal(row?.table, tableOf(before));
      assert.equal(row?.status, 'executed');
      assert.equal(row?.readback, 'desired_exact');
      assert.equal(row?.attempt_consumed, true);
      assert.equal(row?.validation?.ok, true, 'a support repair keeps the fully valid row');
      assert.deepEqual(row?.draft_repair_admission, {
        schema: 'dataset-draft-repair-admission.v1',
        status: 'admitted',
        policy: 'support-reference-metadata.v1',
        before_sha256: sha256Json(before.json),
        desired_sha256: sha256Json(candidate.json),
        changed_paths: [ownershipTextPath(before)],
        publication_ready: false,
      });
      const command = commands[index]?.body as JsonObject;
      assert.equal(command.table, tableOf(before));
      assert.equal(command.id, before.id);
      assert.equal(command.version, before.version);
      assert.deepEqual(command.jsonOrdered, candidate.json);
      assert.deepEqual(
        command.expectedJsonOrdered,
        before.json,
        'the transport carries the complete before JSON value, never a hash',
      );
      assert.equal(
        command.ruleVerification,
        true,
        'a fully valid support row keeps the platform rule-verification flag',
      );
    });
    assert.deepEqual(
      writes,
      BEFORE_ROWS.map((row) => row.id),
    );
    assert.notDeepEqual(
      ownershipText(BEFORE_ROWS[0]!.json),
      ownershipText(CANDIDATE_ROWS[0]!.json),
      'the reviewed repair is the ownership display text only',
    );
  });
});

test('support metadata repair reports the same admission in a dry-run and dispatches nothing', async () => {
  await withDir('support-metadata-dry-run', async (dir) => {
    const { report, rows, commands, writes } = await runSupportRepair({
      dir,
      candidate: CANDIDATE_ROWS,
      commit: false,
    });

    assert.equal(report.mode, 'dry_run');
    assert.equal(report.commit, false);
    assert.equal(report.counts.prepared, 2);
    assert.equal(report.counts.executed, 0);
    assert.equal(report.counts.attempts_consumed, 0);
    assert.equal(report.files.execution_ledger, undefined, 'a dry-run writes no ledger root');
    assert.ok(
      !existsSync(path.join(dir, 'state', 'tiangong-lca-cli', 'execution-ledgers')),
      'a dry-run creates no ledger directory',
    );
    for (const [index, row] of rows.entries()) {
      assert.equal(row?.status, 'prepared');
      assert.equal(row?.operation, 'would_sync');
      assert.equal(row?.attempt_consumed, false);
      assert.equal(row?.readback, 'not_performed');
      assert.equal(row?.draft_repair_admission?.policy, 'support-reference-metadata.v1');
      assert.deepEqual(row?.draft_repair_admission?.changed_paths, [
        ownershipTextPath(BEFORE_ROWS[index]!),
      ]);
    }
    assert.deepEqual(commands, []);
    assert.deepEqual(writes, []);
  });
});

test('support metadata repair refuses every science, reference-identity and shape mutation', async () => {
  const cases: Array<{
    name: string;
    mutate: (candidate: FixtureRow[]) => void;
    code: string;
  }> = [
    {
      name: 'unit conversion factor',
      mutate: (rows) => {
        const units = record(record(rows[1]!.json.unitGroupDataSet)['units']);
        record((units['unit'] as JsonObject[])[0]!)['meanValue'] = '2.0';
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'reference identity',
      mutate: (rows) => {
        ownershipReference(rows[0]!.json)['@refObjectId'] = otherUuid();
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'reference version',
      mutate: (rows) => {
        ownershipReference(rows[0]!.json)['@version'] = '00.00.002';
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'reference language structure',
      mutate: (rows) => {
        ownershipReference(rows[0]!.json)['common:shortDescription'] = [
          { '#text': 'Example owner organisation', '@xml:lang': 'en' },
        ];
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'extra node inside the reference',
      mutate: (rows) => {
        ownershipReference(rows[0]!.json)['common:other'] = 'value';
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'reference retarget plus text change',
      mutate: (rows) => {
        ownershipReference(rows[0]!.json)['@uri'] = `../contacts/${otherUuid()}.json`;
        withOwnershipText(rows[0]!.json, 'Example owner organisation (reviewed)');
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'unreviewed reference description',
      mutate: (rows) => {
        const quantitativeReference = record(
          record(record(rows[0]!.json.flowPropertyDataSet)['flowPropertiesInformation'])[
            'quantitativeReference'
          ],
        );
        record(
          record(quantitativeReference['referenceToReferenceUnitGroup'])['common:shortDescription'],
        )['#text'] = 'Units of an example flow property (reviewed)';
      },
      code: 'draft_repair_diff_not_allowed',
    },
    {
      name: 'unchanged payload',
      mutate: (rows) => {
        rows[0]!.json = structuredClone(BEFORE_ROWS[0]!.json);
      },
      code: 'draft_repair_requires_change',
    },
    {
      name: 'whitespace-only change',
      mutate: (rows) => {
        withOwnershipText(rows[0]!.json, `${ownershipText(BEFORE_ROWS[0]!.json)} `);
      },
      code: 'draft_repair_requires_change',
    },
    {
      name: 'cleared description',
      mutate: (rows) => {
        withOwnershipText(rows[0]!.json, '');
      },
      code: 'draft_repair_text_requires_content',
    },
  ];

  for (const scenario of cases) {
    await withDir(`support-metadata-refuse-${scenario.name.replace(/ /gu, '-')}`, async (dir) => {
      const candidate = structuredClone(CANDIDATE_ROWS);
      scenario.mutate(candidate);
      const { rows, commands } = await runSupportRepair({ dir, candidate, commit: true });
      const refused = rows.find((row) => row?.status === 'failed');
      assert.ok(refused, `${scenario.name} must be refused`);
      assert.equal(
        (refused?.error?.details as JsonObject | undefined)?.code,
        scenario.code,
        `${scenario.name}: ${refused?.error?.message ?? ''}`,
      );
      assert.equal(refused?.draft_repair_admission, undefined, scenario.name);
      assert.equal(refused?.attempt_consumed, false, scenario.name);
      assert.ok(
        commands.every((command) => command.body.id !== refused?.id),
        `${scenario.name} must not dispatch the refused row`,
      );
    });
  }
});

test('support metadata repair refuses everything when the stored draft is not fully valid', async () => {
  const cases: Array<{ name: string; mutateBefore: (payload: JsonObject) => void }> = [
    {
      name: 'schema-invalid stored draft',
      mutateBefore: (payload) => {
        const unitGroup = record(payload.unitGroupDataSet);
        delete record(record(unitGroup['unitGroupInformation'])['dataSetInformation'])[
          'common:name'
        ];
      },
    },
    {
      name: 'stored reference without a description',
      mutateBefore: (payload) => {
        delete ownershipReference(payload)['common:shortDescription'];
      },
    },
  ];
  for (const scenario of cases) {
    await withDir(`support-metadata-before-${scenario.name.replace(/ /gu, '-')}`, async (dir) => {
      const before = structuredClone(BEFORE_ROWS);
      scenario.mutateBefore(before[1]!.json);
      const { rows, commands, writes } = await runSupportRepair({
        dir,
        contractBefore: before,
        remoteBefore: before,
        candidate: CANDIDATE_ROWS,
        commit: true,
      });
      const refused = rows[1];
      assert.equal(refused?.status, 'failed', scenario.name);
      assert.equal(
        (refused?.error?.details as JsonObject | undefined)?.code,
        'draft_repair_before_not_valid',
        scenario.name,
      );
      assert.equal(refused?.draft_repair_admission, undefined, scenario.name);
      assert.ok(!writes.includes(before[1]!.id), scenario.name);
      assert.equal(commands.length, 1, `${scenario.name} still completes the untouched row`);
    });
  }
});

test('support metadata repair refuses a foreign owner, a published row and a stale before hash', async () => {
  const cases: Array<{
    name: string;
    options: {
      rowUserOverride?: string;
      rowStateOverride?: number;
      contractBefore?: FixtureRow[];
      remoteBefore?: FixtureRow[];
    };
  }> = [
    { name: 'foreign owner', options: { rowUserOverride: OTHER_USER_ID } },
    { name: 'published row', options: { rowStateOverride: 100 } },
    {
      name: 'stale before hash',
      options: {
        contractBefore: BEFORE_ROWS.map((row) => ({
          ...row,
          json: withOwnershipText(
            structuredClone(row.json),
            'Example owner organisation (other run)',
          ),
        })),
        remoteBefore: BEFORE_ROWS,
      },
    },
  ];
  for (const scenario of cases) {
    await withDir(`support-metadata-drift-${scenario.name.replace(/ /gu, '-')}`, async (dir) => {
      const { rows, commands, writes } = await runSupportRepair({
        dir,
        candidate: CANDIDATE_ROWS,
        commit: true,
        ...scenario.options,
      });
      for (const row of rows) {
        assert.equal(row?.status, 'failed', scenario.name);
        assert.match(
          row?.error?.message ?? '',
          /before-state or expected operation drifted/u,
          scenario.name,
        );
        assert.equal(row?.attempt_consumed, false, scenario.name);
        assert.equal(row?.draft_repair_admission, undefined, scenario.name);
      }
      assert.deepEqual(commands, [], scenario.name);
      assert.deepEqual(writes, [], scenario.name);
    });
  }
});

test('support metadata repair never weakens the ordinary reference-only policy', async () => {
  await withDir('support-metadata-ordinary', async (dir) => {
    // Without an execution contract the same reviewed shape stays reference-only.
    const fetchImpl = supportFetch({
      state: new Map(BEFORE_ROWS.map((row) => [row.id, structuredClone(row)])),
      writes: [],
      calls: [],
    });
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'rows.json'),
      rawInput: { rows: CANDIDATE_ROWS.map((row) => row.json) },
      type: 'auto',
      outDir: path.join(dir, 'ordinary-out'),
      env: executionEnv(dir, 'support-metadata-ordinary'),
      fetchImpl,
    });
    for (const row of report.rows) {
      assert.equal(row.status, 'failed');
      assert.equal(row.operation, 'reference_only_type');
    }
    assert.deepEqual(report.counts.operations, { reference_only_type: 2 });
  });

  await withDir('support-metadata-insert', async (dir) => {
    // An insert action is never the reviewed existing-draft repair.
    const { rows, commands } = await runSupportRepair({
      dir,
      candidate: CANDIDATE_ROWS,
      commit: true,
      operation: 'insert',
    });
    for (const row of rows) {
      assert.equal(row?.status, 'failed');
      assert.equal(row?.operation, 'reference_only_type');
    }
    assert.deepEqual(commands, []);
  });

  await withDir('support-metadata-invalid-candidate', async (dir) => {
    // A candidate that fails validation must never be repaired through this path.
    const candidate = structuredClone(CANDIDATE_ROWS);
    delete record(
      record(record(candidate[0]!.json.flowPropertyDataSet)['flowPropertiesInformation'])[
        'dataSetInformation'
      ],
    )['common:name'];
    const { rows, commands } = await runSupportRepair({ dir, candidate, commit: true });
    assert.equal(rows[0]?.status, 'failed');
    assert.equal(rows[0]?.operation, 'reference_only_type');
    assert.equal(rows[0]?.validation?.ok, false);
    assert.ok(
      commands.every((command) => command.body.id !== candidate[0]!.id),
      'an invalid candidate is never dispatched',
    );
    assert.equal(commands.length, 1, 'the untouched Unit Group row is the only dispatch');
  });
});

test('support metadata repair keeps a retained attempt, returns the original admission and never replays', async () => {
  await withDir('support-metadata-crash-recovery', async (dir) => {
    const first = await runSupportRepair({ dir, candidate: CANDIDATE_ROWS, commit: true });
    const admission = first.rows[0]?.draft_repair_admission;
    assert.equal(admission?.policy, 'support-reference-metadata.v1');

    // Simulate a crash between dispatch and outcome for row 0: only the hashed attempt event
    // exists while the remote row already holds the desired content.
    const { parsed, ledgerPath } = ledgerPathFor(dir, 'support-metadata-repair');
    const contractSha256 = sha256Json(parsed);
    const attempt = ledgerEvent({
      contractSha256,
      action: parsed.actions[0] as JsonObject,
      sequence: 1,
      eventType: 'attempt_emitted',
      outcome: null,
      admission: admission as JsonObject,
    });
    writeLedgerEvents(ledgerPath, [attempt]);

    const replay = await runSupportRepair({
      dir,
      contractBefore: BEFORE_ROWS,
      remoteBefore: CANDIDATE_ROWS.map((row) => structuredClone(row)),
      candidate: CANDIDATE_ROWS,
      commit: true,
    });

    assert.equal(replay.rows[0]?.status, 'executed');
    assert.equal(replay.rows[0]?.readback, 'desired_exact');
    assert.equal(replay.rows[0]?.attempt_consumed, true);
    assert.deepEqual(
      replay.rows[0]?.draft_repair_admission,
      admission,
      'the recovery returns the original hashed admission',
    );
    assert.deepEqual(replay.commands, [], 'an unresolved attempt is resolved by readback only');
    assert.deepEqual(replay.writes, []);
  });
});

test('a tampered support admission is refused instead of trusted', async () => {
  await withDir('support-metadata-tampered', async (dir) => {
    const first = await runSupportRepair({ dir, candidate: CANDIDATE_ROWS, commit: true });
    const admission = first.rows[0]?.draft_repair_admission as JsonObject;

    const { parsed, ledgerPath } = ledgerPathFor(dir, 'support-metadata-repair');
    const tampered = { ...admission, policy: 'process-metadata-unknown-annual.v1' };
    writeLedgerEvents(ledgerPath, [
      ledgerEvent({
        contractSha256: sha256Json(parsed),
        action: parsed.actions[0] as JsonObject,
        sequence: 1,
        eventType: 'attempt_emitted',
        outcome: null,
        admission: tampered,
      }),
    ]);

    await assert.rejects(
      runSupportRepair({ dir, candidate: CANDIDATE_ROWS, commit: true }),
      /failed its hash or action binding/u,
    );
  });
});

function validLayers(): RepairValidationLayers {
  return {
    schema: { issues: [], status: 'passed' },
    authoring_evidence: { issues: [], status: 'passed' },
    content: { issues: [], status: 'passed' },
    multilingual: { issues: [], status: 'passed' },
  };
}

function fullyValidValidation(): RepairValidationResult {
  return { ok: true, validation_layers: validLayers() };
}

function withFailedLayer(layer: keyof RepairValidationLayers): RepairValidationResult {
  return {
    ok: true,
    validation_layers: {
      ...validLayers(),
      [layer]: { issues: [{ code: 'example' }], status: 'failed' },
    },
  };
}

function supportWalkFixture(): { before: JsonObject; candidate: JsonObject } {
  const before: JsonObject = {
    unitGroupDataSet: {
      administrativeInformation: {
        publicationAndOwnership: {
          'common:referenceToOwnershipOfDataSet': {
            'common:shortDescription': { '#text': 'Example import tooling', '@xml:lang': 'en' },
          },
        },
      },
      modellingAndValidation: {
        dataSourcesTreatmentAndRepresentativeness: {
          referenceToDataSource: {
            'common:shortDescription': { '#text': 'Example source description', '@xml:lang': 'en' },
          },
        },
      },
    },
  };
  return { before, candidate: structuredClone(before) };
}

function admitSupport(options: {
  table?: string;
  before?: unknown;
  candidate?: unknown;
  beforeValidation?: RepairValidationResult;
  candidateValidation?: RepairValidationResult;
}) {
  const walk = supportWalkFixture();
  return __testInternals.evaluateSupportMetadataRepairAdmission({
    table: options.table ?? 'unitgroups',
    before: options.before ?? walk.before,
    candidate: options.candidate ?? walk.candidate,
    beforeValidation: options.beforeValidation ?? fullyValidValidation(),
    candidateValidation: options.candidateValidation ?? fullyValidValidation(),
    beforeSha256: 'a'.repeat(64),
    desiredSha256: 'b'.repeat(64),
  });
}

function textAt(payload: JsonObject, path: string[]): JsonObject {
  let current: unknown = payload;
  for (const segment of path) {
    current = record(current)[segment];
  }
  return record(current);
}

test('the support candidate gate admits only a fully valid bounded save_draft of a support row', () => {
  const valid = fullyValidValidation();
  const isCandidate = __testInternals.isSupportMetadataRepairCandidate;

  assert.equal(
    isCandidate({ operation: 'save_draft', table: 'unitgroups', validation: valid }),
    true,
  );
  assert.equal(
    isCandidate({ operation: 'save_draft', table: 'flowproperties', validation: valid }),
    true,
  );
  assert.equal(isCandidate({ operation: 'insert', table: 'unitgroups', validation: valid }), false);
  assert.equal(
    isCandidate({ operation: 'save_draft', table: 'processes', validation: valid }),
    false,
  );
  assert.equal(isCandidate({ operation: 'save_draft', table: 'flows', validation: valid }), false);
  assert.equal(
    isCandidate({ operation: 'save_draft', table: 'unitgroups', validation: null }),
    false,
  );

  const brokenCases: Array<[string, RepairValidationResult]> = [
    ['not ok', { ok: false, validation_layers: validLayers() }],
    ['no layers', { ok: true }],
    ['content failed', withFailedLayer('content')],
    ['multilingual failed', withFailedLayer('multilingual')],
    ['authoring failed', withFailedLayer('authoring_evidence')],
    ['schema failed', withFailedLayer('schema')],
  ];
  for (const [name, broken] of brokenCases) {
    assert.equal(
      isCandidate({ operation: 'save_draft', table: 'unitgroups', validation: broken }),
      false,
      name,
    );
  }
});

test('the ledger policy binding covers exactly the tables with a reviewed repair policy', () => {
  assert.equal(
    __testInternals.draftRepairPolicyForTable('processes'),
    'process-metadata-unknown-annual.v1',
  );
  assert.equal(
    __testInternals.draftRepairPolicyForTable('unitgroups'),
    'support-reference-metadata.v1',
  );
  assert.equal(
    __testInternals.draftRepairPolicyForTable('flowproperties'),
    'support-reference-metadata.v1',
  );
  assert.equal(__testInternals.draftRepairPolicyForTable('flows'), null);
  assert.equal(__testInternals.draftRepairPolicyForTable('contacts'), null);
});

test('the support admission requires two fully valid sides and only reviewed text leaves', () => {
  const beforeInvalid = admitSupport({
    beforeValidation: { ok: false, validation_layers: validLayers() },
  });
  assert.equal(beforeInvalid.status, 'rejected');
  assert.equal(
    beforeInvalid.status === 'rejected' && beforeInvalid.code,
    'draft_repair_before_not_valid',
  );

  const candidateInvalid = admitSupport({
    candidateValidation: withFailedLayer('content'),
  });
  assert.equal(
    candidateInvalid.status === 'rejected' && candidateInvalid.code,
    'draft_repair_candidate_not_valid',
  );

  const processTable = admitSupport({ table: 'processes' });
  assert.equal(
    processTable.status === 'rejected' && processTable.code,
    'draft_repair_table_not_admitted',
  );
});

test('the support walker admits both reviewed reference descriptions and nothing else', () => {
  for (const root of ['flowPropertyDataSet', 'unitGroupDataSet'] as const) {
    const walk = supportWalkFixture();
    const payload: JsonObject = { [root]: walk.before.unitGroupDataSet };
    const candidate = structuredClone(payload);
    const ownership = textAt(candidate, [
      root,
      'administrativeInformation',
      'publicationAndOwnership',
      'common:referenceToOwnershipOfDataSet',
      'common:shortDescription',
    ]);
    ownership['#text'] = 'Example owner organisation';
    const admitted = admitSupport({
      table: root === 'unitGroupDataSet' ? 'unitgroups' : 'flowproperties',
      before: payload,
      candidate,
    });
    assert.equal(admitted.status, 'admitted');
    assert.equal(
      admitted.status === 'admitted' && admitted.admission.policy,
      'support-reference-metadata.v1',
    );
    assert.deepEqual(admitted.status === 'admitted' && admitted.admission.changed_paths, [
      `${root}.${OWNERSHIP_TEXT_SUFFIX}`,
    ]);

    const source = structuredClone(payload);
    textAt(source, [
      root,
      'modellingAndValidation',
      'dataSourcesTreatmentAndRepresentativeness',
      'referenceToDataSource',
      'common:shortDescription',
    ])['#text'] = 'Example source description (reviewed)';
    const sourceAdmitted = admitSupport({
      table: root === 'unitGroupDataSet' ? 'unitgroups' : 'flowproperties',
      before: payload,
      candidate: source,
    });
    assert.equal(sourceAdmitted.status, 'admitted');
    assert.deepEqual(
      sourceAdmitted.status === 'admitted' && sourceAdmitted.admission.changed_paths,
      [`${root}.${DATA_SOURCE_TEXT_SUFFIX}`],
    );
  }

  const walk = supportWalkFixture();
  const science = structuredClone(walk.before);
  record(science['unitGroupDataSet'])['other'] = 1;
  const rejected = admitSupport({ before: walk.before, candidate: science });
  assert.equal(rejected.status === 'rejected' && rejected.code, 'draft_repair_diff_not_allowed');
  assert.deepEqual(rejected.status === 'rejected' && rejected.details['violations'], [
    'unitGroupDataSet.other',
  ]);

  const arrayWalk = supportWalkFixture();
  const arrayBefore = structuredClone(arrayWalk.before);
  const sourceReferencePath = [
    'unitGroupDataSet',
    'modellingAndValidation',
    'dataSourcesTreatmentAndRepresentativeness',
    'referenceToDataSource',
  ];
  textAt(arrayBefore, sourceReferencePath)['common:shortDescription'] = [
    { '#text': 'Example source description', '@xml:lang': 'en' },
    { '#text': 'Beispielbeschreibung', '@xml:lang': 'de' },
  ];
  const arrayCandidate = structuredClone(arrayBefore);
  const shortDescriptions = textAt(arrayCandidate, sourceReferencePath)[
    'common:shortDescription'
  ] as JsonObject[];
  shortDescriptions[1]!['#text'] = 'Beispielbeschreibung (geprüft)';
  const arrayAdmitted = admitSupport({ before: arrayBefore, candidate: arrayCandidate });
  assert.equal(arrayAdmitted.status, 'admitted');

  const droppedLanguage = structuredClone(arrayCandidate);
  (textAt(droppedLanguage, sourceReferencePath)['common:shortDescription'] as JsonObject[]).pop();
  const droppedRejected = admitSupport({ before: arrayBefore, candidate: droppedLanguage });
  assert.equal(
    droppedRejected.status === 'rejected' && droppedRejected.code,
    'draft_repair_diff_not_allowed',
  );
});

test('the support admission refuses an empty, trivial or missing change', () => {
  const walk = supportWalkFixture();
  const unchanged = admitSupport({ before: walk.before, candidate: structuredClone(walk.before) });
  assert.equal(unchanged.status === 'rejected' && unchanged.code, 'draft_repair_requires_change');
  assert.deepEqual(unchanged.status === 'rejected' && unchanged.details['changed_paths'], []);

  const blanked = structuredClone(walk.before);
  textAt(blanked, [
    'unitGroupDataSet',
    'administrativeInformation',
    'publicationAndOwnership',
    'common:referenceToOwnershipOfDataSet',
    'common:shortDescription',
  ])['#text'] = '   ';
  const blank = admitSupport({ before: walk.before, candidate: blanked });
  assert.equal(blank.status === 'rejected' && blank.code, 'draft_repair_text_requires_content');

  const whitespace = structuredClone(walk.before);
  textAt(whitespace, [
    'unitGroupDataSet',
    'administrativeInformation',
    'publicationAndOwnership',
    'common:referenceToOwnershipOfDataSet',
    'common:shortDescription',
  ])['#text'] = 'Example import tooling ';
  const trivial = admitSupport({ before: walk.before, candidate: whitespace });
  assert.equal(trivial.status === 'rejected' && trivial.code, 'draft_repair_requires_change');
});
