// The actual end-to-end driver: the real `run-protected` command, through its real argument surface
// and its real request bodies, against the real local PostgreSQL RPCs of the database owner's
// interop stack, consuming their unmodified raw responses.
//
// It runs only when `/tmp/db673-cli-interop-ready.json` marks the shared stack ready AND
// TIANGONG_LCA_ALIAS_V2_LOCAL_E2E=1 explicitly opts in (a coordinated one-shot; a routine test run
// must never write to a local stack), and it drives the seeded execution through its lifecycle:
//
//   1. a pristine stack reads as not admitted (read-only);
//   2. the CLI runs preflight -> the three gates -> exactly one admission, observes the in-flight
//      execution as pending, and reports indeterminate without ever claiming success;
//   3. the database owner's committed completion contract (the queued execute plus the supported
//      worker contract) drives the same execution to its terminal state, and the same run directory
//      then reads it as applied;
//   4. a fresh output directory reads the completed execution from the server alone;
//   5. a second admission of the same sealed execution is refused by the server, with one dispatch.
//
// Auth is the disclosed synthetic session fixture; every data-api call is a real function call with
// the reviewed named arguments, and no reply is reshaped.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { JsonObject } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_PROTECTED_ARTIFACTS,
  runAliasV2Protected,
  type AliasV2ProtectedReport,
} from '../src/lib/dataset-alias-v2-protected.js';
import { ALIAS_V2_PROTOCOL } from '../src/lib/dataset-alias-v2-protected-contract.js';
import {
  aliasV2LocalRpcAdapter,
  aliasV2LocalRpcEnv,
  readAliasV2InteropReady,
  type AliasV2InteropReady,
} from './helpers/alias-v2-local-rpc.js';
import type { FetchLike } from '../src/lib/http.js';

const READY_PATH =
  process.env['TIANGONG_LCA_ALIAS_V2_INTEROP_READY'] ?? '/tmp/db673-cli-interop-ready.json';
const READY: AliasV2InteropReady | null = readAliasV2InteropReady(READY_PATH);
const ARTIFACTS = READY?.artifacts_dir ?? '';

/** The sealed artefact paths: the marker's own map first, the canonical file names otherwise. */
const ARTIFACT_PATHS = {
  plan: READY?.artifacts?.['plan'] ?? path.join(ARTIFACTS, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file),
  freeze: READY?.artifacts?.['freeze'] ?? path.join(ARTIFACTS, ALIAS_V2_PROTECTED_ARTIFACTS.freeze),
  approval:
    READY?.artifacts?.['approval'] ?? path.join(ARTIFACTS, ALIAS_V2_PROTECTED_ARTIFACTS.approval),
} as const;

function localAdapter() {
  assert.ok(READY);
  return aliasV2LocalRpcAdapter({
    container: READY.container,
    actor: READY.actor,
    ...(READY.sql_user === undefined ? {} : { sqlUser: READY.sql_user }),
    ...(READY.sql_database === undefined ? {} : { sqlDatabase: READY.sql_database }),
    ...(READY.rpc_aliases === undefined ? {} : { rpcAliases: READY.rpc_aliases }),
    projectRef: READY.project_ref,
  });
}

type LocalAdapter = ReturnType<typeof localAdapter>;

async function runCli(options: {
  adapter: LocalAdapter;
  outDir: string;
  commit: boolean;
  statusOnly: boolean;
  waitSeconds?: number;
  dropAdmitReply?: boolean;
  onRead?: (readIndex: number) => void;
}): Promise<AliasV2ProtectedReport> {
  assert.ok(READY);
  const approval = JSON.parse(readFileSync(ARTIFACT_PATHS.approval, 'utf8')) as JsonObject;
  let reads = 0;
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/rpc/cmd_dataset_alias_execution_read_v2')) {
      reads += 1;
      options.onRead?.(reads);
    }
    const response = await options.adapter.fetchImpl(input, init);
    if (
      options.dropAdmitReply === true &&
      url.includes(`/rpc/${ALIAS_V2_PROTOCOL.admit_command}`)
    ) {
      // The server executed the admission; only the reply is lost.
      throw new Error('socket hang up');
    }
    return response;
  }) as FetchLike;
  return runAliasV2Protected({
    planPath: ARTIFACT_PATHS.plan,
    freezePath: ARTIFACT_PATHS.freeze,
    approvalPath: ARTIFACT_PATHS.approval,
    outDir: options.outDir,
    commit: options.commit,
    statusOnly: options.statusOnly,
    ...(options.commit
      ? {
          approveExecution: String(approval['approval_identity_sha256']),
          confirm: READY.actor.email,
        }
      : {}),
    waitSeconds: options.waitSeconds ?? 120,
    pollMs: 1_000,
    env: aliasV2LocalRpcEnv(READY.project_ref),
    fetchImpl,
  } as Parameters<typeof runAliasV2Protected>[0]);
}

function admitRpcCalls(adapter: LocalAdapter): number {
  return adapter.calls.filter((call) => call.name === ALIAS_V2_PROTOCOL.admit_command).length;
}

/**
 * Persists the dispatched nonce (the queue row may be consumed by the pg_net worker at any moment)
 * so the database owner's completion script keeps its nonce even after the queue drains.
 */
function persistDispatchedNonce(adapter: LocalAdapter): void {
  assert.ok(READY);
  // With the owner's transport stub installed the queued row lives in the scratch hold instead of the
  // live queue, so both sources are consulted (the hold only when it exists).
  const holdExists =
    adapter.runSql(
      [
        `select count(*)::int from pg_class as c`,
        `join pg_namespace as n on n.oid = c.relnamespace`,
        `where n.nspname = 'private' and c.relname = 'db673_net_hold';`,
      ].join('\n'),
    ) === '1';
  const holdSelect = [
    `(select convert_from(held.body, 'UTF8')::jsonb->>'p_nonce'`,
    `from private.db673_net_hold as held`,
    `where convert_from(held.body, 'UTF8')::jsonb->>'p_request_id' = '${READY.request_id}'`,
    `order by held.id desc limit 1)`,
  ].join('\n');
  const queueSelect = [
    `(select convert_from(queued.body, 'UTF8')::jsonb->>'p_nonce'`,
    `from net.http_request_queue as queued`,
    `join util.dataset_alias_execution_v2_requests as request`,
    `on request.net_request_id = queued.id`,
    `where request.id = '${READY.request_id}'::uuid)`,
  ].join('\n');
  const nonce = adapter.runSql(
    `select coalesce(${[holdExists ? holdSelect : 'null::text', queueSelect].join(',\n')});`,
  );
  assert.notEqual(nonce, '', 'the dispatched nonce must be recoverable before the completion runs');
  adapter.runSql(
    [`\\o /tmp/db673-admit-nonce.txt`, `select '${nonce.replaceAll("'", "''")}';`, `\\o`].join(
      '\n',
    ),
  );
}

/** The owner's transport stub must be installed, so no committing path can queue a live callback. */
function assertTransportStubInstalled(adapter: LocalAdapter): void {
  const installed = adapter.runSql(
    `select count(*)::int from pg_trigger where tgname = 'db673_net_hold_capture';`,
  );
  assert.equal(
    installed,
    '1',
    'the outbound transport stub must be installed before any committing step runs',
  );
}

/**
 * Runs the database owner's committed completion contract: the service-only execute behind the
 * queued nonce, then every derivative child through the supported worker contract. No parent status
 * is written directly.
 */
function completeSeededExecution(adapter: LocalAdapter): void {
  assert.ok(READY);
  assert.ok(READY.complete_script);
  adapter.runSql(readFileSync(READY.complete_script, 'utf8'));
}

/** The seeded stack must be pristine: the cohort rows are present and nothing has been executed. */
function assertPristineSeed(adapter: LocalAdapter): void {
  assert.ok(READY);
  const counts = adapter.runSql(
    [
      `select 'flows=' || count(*) from public.flows where user_id = '${READY.actor.user_id}'::uuid;`,
      `select 'processes=' || count(*) from public.processes where user_id = '${READY.actor.user_id}'::uuid;`,
      `select 'preflights=' || count(*) from util.dataset_alias_execution_v2_preflights;`,
      `select 'requests=' || count(*) from util.dataset_alias_execution_v2_requests;`,
    ].join('\n'),
  );
  const lines = counts.split('\n');
  assert.deepEqual(
    lines,
    ['flows=113', 'processes=274', 'preflights=0', 'requests=0'],
    'the interop stack must be seeded pristine before the one-shot campaign runs',
  );
}

/**
 * The campaign is a coordinated one-shot against a shared stack: it runs only with BOTH the owner's
 * ready marker and an explicit opt-in, so a routine test run can never write to a local stack just
 * because the marker happens to exist.
 */
const ENABLED = process.env['TIANGONG_LCA_ALIAS_V2_LOCAL_E2E'] === '1';
const e2eTest = READY === null || !ENABLED ? test.skip : test;

e2eTest(
  'the local-RPC campaign: not admitted, pending, applied, fresh status, no replay',
  async (t) => {
    assert.ok(READY);
    assert.equal(
      READY.scenarios.includes('applied'),
      true,
      'the marker prepares the applied scenario',
    );
    const campaignDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-campaign-'));
    const freshStatusDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-fresh-'));
    const replayDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-replay-'));
    t.after(() => {
      for (const dir of [campaignDir, freshStatusDir, replayDir]) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await t.test('a pristine stack reads as not admitted, and nothing is written', async () => {
      const adapter = localAdapter();
      const report = await runCli({
        adapter,
        outDir: campaignDir,
        commit: false,
        statusOnly: true,
        waitSeconds: 0,
      });
      assert.deepEqual([report.status, report.phase], ['not_admitted', 'prepared']);
      assert.equal(report.admission_attempts, 0);
      assert.equal(admitRpcCalls(adapter), 0);
      // Only the read touched the stack.
      assert.deepEqual(
        [...new Set(adapter.calls.map((call) => call.name))],
        ['cmd_dataset_alias_execution_read_v2'],
      );
    });

    await t.test(
      'the real CLI admits exactly once and reads the in-flight execution as pending',
      async () => {
        const adapter = localAdapter();
        assertPristineSeed(adapter);
        assertTransportStubInstalled(adapter);
        let noncePersisted = false;
        const report = await runCli({
          adapter,
          outDir: campaignDir,
          commit: true,
          statusOnly: false,
          waitSeconds: 3,
          onRead: (readIndex) => {
            if (readIndex === 1 && !noncePersisted) {
              noncePersisted = true;
              persistDispatchedNonce(adapter);
            }
          },
        });
        assert.equal(noncePersisted, true);
        assert.equal(report.admission_attempts, 1);
        assert.equal(admitRpcCalls(adapter), 1);
        assert.equal(report.status, 'indeterminate');
        assert.equal(report.polls > 0, true, String(report.polls));
        assert.deepEqual(report.gates, [
          'primary_support_plan',
          'execution_unused',
          'derivative_quiescence',
        ]);
      },
    );

    await t.test(
      'the supported completion contract drives the same run directory to applied',
      async () => {
        const adapter = localAdapter();
        completeSeededExecution(adapter);
        const report = await runCli({
          adapter,
          outDir: campaignDir,
          commit: false,
          statusOnly: true,
          waitSeconds: 0,
        });
        assert.deepEqual([report.status, report.phase], ['passed', 'applied']);
        assert.equal(admitRpcCalls(adapter), 0);
      },
    );

    await t.test(
      'a fresh output directory reads the completed execution from the server alone',
      async () => {
        const adapter = localAdapter();
        const report = await runCli({
          adapter,
          outDir: freshStatusDir,
          commit: false,
          statusOnly: true,
          waitSeconds: 0,
        });
        assert.deepEqual([report.status, report.phase], ['passed', 'applied']);
        assert.equal(report.admission_attempts, 0);
        assert.equal(admitRpcCalls(adapter), 0);
      },
    );

    await t.test(
      'a second admission of the same execution is refused, with one dispatch',
      async () => {
        const adapter = localAdapter();
        const report = await runCli({
          adapter,
          outDir: replayDir,
          commit: true,
          statusOnly: false,
          waitSeconds: 10,
        });
        assert.notEqual(report.status, 'passed');
        assert.equal(report.admission_attempts <= 1, true, String(report.admission_attempts));
        assert.equal(admitRpcCalls(adapter) <= 1, true, String(admitRpcCalls(adapter)));
      },
    );
  },
);
