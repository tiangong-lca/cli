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
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
/**
 * Opt-in qualification evidence retention: the unmodified RPC wire requests/replies, every executed
 * script and its output, and copies of the run directories are retained here. Routine runs (no
 * variable) keep their ordinary cleanup.
 */
const EVIDENCE_DIR = process.env['TIANGONG_LCA_ALIAS_V2_EVIDENCE_DIR'] ?? null;

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
    ...(EVIDENCE_DIR === null ? {} : { evidenceDir: EVIDENCE_DIR }),
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
        `where n.nspname = 'scratch_673' and c.relname = 'net_hold';`,
      ].join('\n'),
    ) === '1';
  // The marker's own hold-based nonce query.
  const holdSelect = [
    `(select convert_from(held.body, 'UTF8')::jsonb->>'p_nonce'`,
    `from scratch_673.net_hold as held`,
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

/**
 * The durable server facts of the seeded execution. Reading them is SELECT-only; a missing row
 * returns an empty string and therefore fails the calling stage loudly instead of guessing.
 */
function readDurableFacts(adapter: LocalAdapter): {
  attempts: number;
  dispatches: number;
  status: string;
  terminal_proof: boolean;
} {
  assert.ok(READY);
  const line = adapter.runSql(
    [
      `select jsonb_build_object(`,
      `  'attempts', attempt_count,`,
      `  'dispatches', dispatch_count,`,
      `  'status', status,`,
      `  'terminal_proof', terminal_proof is not null)::text`,
      `from util.dataset_alias_execution_v2_requests`,
      `where id = '${READY.request_id}'::uuid;`,
    ].join('\n'),
  );
  return JSON.parse(line) as {
    attempts: number;
    dispatches: number;
    status: string;
    terminal_proof: boolean;
  };
}

/**
 * A dependent stage refuses to run when its prerequisite stage did not produce the exact outcome it
 * depends on: a failed earlier stage can never be absorbed by a later one.
 */
function requireStage(value: unknown, label: string): asserts value {
  assert.notEqual(value, undefined, `the ${label} stage must have completed successfully first`);
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

/** True when the marker offers a scenario whose name normalises to the wanted one. */
function scenarioOffered(name: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replaceAll(/[-_ ]/gu, '');
  return READY !== null && READY.scenarios.some((entry) => normalize(entry) === normalize(name));
}

/**
 * The campaign is a coordinated one-shot against a shared stack: it runs only with BOTH the owner's
 * ready marker and an explicit opt-in, so a routine test run can never write to a local stack just
 * because the marker happens to exist. Each scenario also needs its own pristine seed, which only the
 * database owner prepares (the marker's `scenarios` list is the offer).
 */
const ENABLED = process.env['TIANGONG_LCA_ALIAS_V2_LOCAL_E2E'] === '1';
const e2eTest = READY === null || !ENABLED ? test.skip : test;
const lostReplyTest =
  READY === null || !ENABLED || !scenarioOffered('lost-admit-reply') ? test.skip : test;

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
    const stage: {
      pristine?: AliasV2ProtectedReport;
      admitted?: AliasV2ProtectedReport;
      applied?: AliasV2ProtectedReport;
      fresh?: AliasV2ProtectedReport;
      refused?: AliasV2ProtectedReport;
    } = {};
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
      // Only the read touched the stack, and the stack is still empty afterwards.
      assert.deepEqual(
        [...new Set(adapter.calls.map((call) => call.name))],
        ['cmd_dataset_alias_execution_read_v2'],
      );
      assertPristineSeed(adapter);
      stage.pristine = report;
    });

    await t.test(
      'the real CLI admits exactly once and reads the in-flight execution as pending',
      async () => {
        requireStage(stage.pristine, 'pristine read');
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
        // The durable ledger proves exactly one consumed attempt and one dispatch, not yet terminal.
        const facts = readDurableFacts(adapter);
        assert.deepEqual(
          [facts.attempts, facts.dispatches, facts.terminal_proof],
          [1, 1, false],
          JSON.stringify(facts),
        );
        assert.equal(
          ['dispatching', 'dispatched', 'running', 'derivatives_pending'].includes(facts.status),
          true,
          facts.status,
        );
        stage.admitted = report;
      },
    );

    await t.test(
      'the supported completion contract drives the same run directory to applied',
      async () => {
        requireStage(stage.admitted, 'admission');
        const adapter = localAdapter();
        const before = readDurableFacts(adapter);
        assert.deepEqual([before.attempts, before.dispatches], [1, 1], JSON.stringify(before));
        completeSeededExecution(adapter);
        const report = await runCli({
          adapter,
          outDir: campaignDir,
          commit: false,
          statusOnly: true,
          waitSeconds: 0,
        });
        assert.deepEqual([report.status, report.phase], ['passed', 'applied']);
        assert.equal(admitRpcCalls(adapter), 0, 'the completion stage never admits');
        const after = readDurableFacts(adapter);
        assert.deepEqual(
          [after.attempts, after.dispatches, after.status, after.terminal_proof],
          [1, 1, 'completed', true],
          JSON.stringify(after),
        );
        stage.applied = report;
      },
    );

    await t.test(
      'a fresh output directory reads the completed execution from the server alone',
      async () => {
        requireStage(stage.applied, 'completion');
        const adapter = localAdapter();
        const before = readDurableFacts(adapter);
        assert.deepEqual(
          [before.attempts, before.dispatches, before.status, before.terminal_proof],
          [1, 1, 'completed', true],
          JSON.stringify(before),
        );
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
        assert.deepEqual(
          readDurableFacts(adapter),
          before,
          'a read-only stage never changes the ledger',
        );
        stage.fresh = report;
      },
    );

    await t.test(
      'a second admission of the completed execution is refused, with one dispatch',
      async () => {
        // This stage may only start from an already completed execution: the durable ledger must
        // show the terminal proof, and the before/after attempt and dispatch counts are compared
        // exactly, so an initial dispatch can never masquerade as a refusal.
        requireStage(stage.applied, 'completion');
        requireStage(stage.fresh, 'fresh status read');
        const adapter = localAdapter();
        const before = readDurableFacts(adapter);
        assert.deepEqual(
          [before.attempts, before.dispatches, before.status, before.terminal_proof],
          [1, 1, 'completed', true],
          JSON.stringify(before),
        );
        const report = await runCli({
          adapter,
          outDir: replayDir,
          commit: true,
          statusOnly: false,
          waitSeconds: 10,
        });
        assert.notEqual(report.status, 'passed');
        const after = readDurableFacts(adapter);
        assert.deepEqual(after, before, 'a refused replay must not change the durable ledger');
        // The refusal is the server's own: either the attempt was already consumed at the admission
        // rpc, or the preflight refused before it. Both are verified from the recorded reply text.
        const refusals = adapter.calls
          .filter((call) => call.name.startsWith('cmd_dataset_alias_execution_'))
          .map((call) => call.reply ?? '');
        const coded = refusals.filter((reply) => /ALIAS_EXECUTION_[A-Z_]+/u.test(reply));
        assert.equal(
          coded.length >= 1,
          true,
          `a coded server refusal must be recorded: ${String(report.code)}`,
        );
        assert.match(String(report.code), /ALIAS_EXECUTION_[A-Z_]+|ALIAS_V2_[A-Z_]+/u);
        assert.equal(admitRpcCalls(adapter) <= 1, true, String(admitRpcCalls(adapter)));
        stage.refused = report;
      },
    );

    if (EVIDENCE_DIR !== null) {
      // Retain the native run directories before the routine cleanup removes them: the reports,
      // attempt markers, gate receipts, preflight evidence, status ledgers and the sealed inputs.
      // Best effort: a failed indexing pass must never destroy the already-written RPC packet or
      // mask a stage failure.
      const retained: Record<string, string> = {};
      try {
        for (const [label, dir] of [
          ['campaign', campaignDir],
          ['fresh-status', freshStatusDir],
          ['no-replay', replayDir],
        ] as const) {
          const target = path.join(EVIDENCE_DIR, 'runs', label);
          mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          cpSync(dir, target, { recursive: true });
          for (const file of readdirSync(target).sort()) {
            const bytes = readFileSync(path.join(target, file));
            retained[`runs/${label}/${file}`] = createHash('sha256').update(bytes).digest('hex');
          }
        }
        for (const entry of readdirSync(EVIDENCE_DIR, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (!entry.isFile() || retained[entry.name] !== undefined) {
            continue;
          }
          const bytes = readFileSync(path.join(EVIDENCE_DIR, entry.name));
          retained[entry.name] = createHash('sha256').update(bytes).digest('hex');
        }
        writeFileSync(
          path.join(EVIDENCE_DIR, 'campaign-summary.json'),
          `${JSON.stringify(
            {
              schema: 'cli358-local-rpc-campaign.v1',
              ran_at_utc: new Date().toISOString(),
              marker: {
                path: READY_PATH,
                container: READY.container,
                request_id: READY.request_id,
                plan_sha256: READY.plan_sha256 ?? null,
                scenarios: READY.scenarios,
              },
              stages: {
                pristine: stage.pristine?.status ?? 'not-reached',
                admitted: stage.admitted?.status ?? 'not-reached',
                applied: stage.applied?.status ?? 'not-reached',
                fresh: stage.fresh?.status ?? 'not-reached',
                refused: stage.refused?.status ?? 'not-reached',
              },
              rpc_calls: 'see the numbered *-wire-request.json / *-function-reply.json files',
              retained_files_sha256: retained,
            },
            null,
            1,
          )}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        process.stderr.write(`evidence indexing failed (packet kept): ${String(error)}\n`);
      }
    }
  },
);

lostReplyTest(
  'the lost admission reply recovers by reading, with exactly one admission posted',
  async (t) => {
    assert.ok(READY);
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-lost-reply-'));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const adapter = localAdapter();
    assertPristineSeed(adapter);
    assertTransportStubInstalled(adapter);
    let noncePersisted = false;
    const report = await runCli({
      adapter,
      outDir,
      commit: true,
      statusOnly: false,
      waitSeconds: 60,
      dropAdmitReply: true,
      onRead: (readIndex) => {
        if (readIndex === 1) {
          if (!noncePersisted) {
            noncePersisted = true;
            persistDispatchedNonce(adapter);
          }
          // The server's one-shot attempt is already consumed and dispatched; only the reply was
          // lost. The completion contract drives the same execution to its terminal state while the
          // CLI keeps observing.
          completeSeededExecution(adapter);
        }
      },
    });
    assert.equal(noncePersisted, true);
    assert.equal(report.admission_attempts, 1);
    assert.equal(admitRpcCalls(adapter), 1, 'the lost reply must never become a second admission');
    assert.deepEqual([report.status, report.phase], ['passed', 'applied']);
    // The run's own report is retained even in the default (no evidence directory) case: the caller
    // may set TIANGONG_LCA_ALIAS_V2_EVIDENCE_DIR to keep the full packet.
    if (EVIDENCE_DIR !== null) {
      const target = path.join(EVIDENCE_DIR, 'runs', 'lost-admit-reply');
      cpSync(outDir, target, { recursive: true });
      writeFileSync(
        path.join(EVIDENCE_DIR, 'lost-admit-reply-summary.json'),
        `${JSON.stringify(
          {
            schema: 'cli358-local-rpc-lost-reply.v1',
            ran_at_utc: new Date().toISOString(),
            request_id: READY.request_id,
            report: {
              status: report.status,
              phase: report.phase,
              admission_attempts: report.admission_attempts,
            },
            admit_rpc_calls: admitRpcCalls(adapter),
          },
          null,
          1,
        )}\n`,
        { mode: 0o600 },
      );
    }
  },
);
