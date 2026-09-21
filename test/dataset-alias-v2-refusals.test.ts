// Rejection and recovery cases for the versioned capability: every artefact parser, binding
// check, dispatch outcome and public stage input refuses what it must, and the recovery paths
// observe rather than retry. These are the behaviours root's reviews found unprotected.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_PROTECTED_ARTIFACTS,
  __testInternals as protectedInternals,
  assertAliasV2Bindings,
  assertAliasV2CanonicalArtifact,
  assertAliasV2PlanDocument,
  parseAliasV2Approval,
  parseAliasV2ApprovalRequest,
  parseAliasV2Freeze,
  runAliasV2Protected,
  sealAliasV2Approval,
} from '../src/lib/dataset-alias-v2-protected.js';
import {
  ALIAS_V2_PROTOCOL,
  buildAliasV2ExecutionIdentity,
  buildAliasV2PreflightRequest,
} from '../src/lib/dataset-alias-v2-protected-contract.js';
import {
  deriveAliasV2Sets,
  isAliasV2FreezeFile,
  isAliasV2PlanFile,
  parseAliasV2DerivativeBaselines,
  planAliasV2,
  sealAliasV2ProtectedApproval,
} from '../src/lib/dataset-alias-v2-public.js';
import { runDatasetMaintenanceProtectedDispatch } from '../src/lib/dataset-maintenance-protected-dispatch.js';
import { buildAliasV2Plan } from '../src/lib/dataset-alias-v2-plan.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_PROJECT_REF,
  sealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike } from '../src/lib/http.js';

const ARTIFACT_INVALID = 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID';

function readArtifact(directory: string, name: string): JsonObject {
  return JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as JsonObject;
}

function rejects(action: () => unknown, code: string, label: string): void {
  assert.throws(
    action,
    (error: unknown) => (error as { code?: string }).code === code,
    `${label} must be refused with ${code}`,
  );
}

test('every freeze field is validated, and its content identity must be its own', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const freeze = readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.freeze);
    const cases: Array<[string, (value: JsonObject) => void]> = [
      [
        'foreign schema',
        (value) => (value['schema_version'] = 'dataset-alias-execution-freeze.v1'),
      ],
      ['foreign environment', (value) => (value['environment'] = 'preview')],
      ['foreign visibility', (value) => (value['target_visibility'] = 'owner')],
      ['missing plan binding', (value) => delete value['plan']],
      ['incomplete plan binding', (value) => (value['plan'] = { plan_sha256: 'a'.repeat(64) })],
      ['plan binding not an object', (value) => (value['plan'] = 'nope')],
      ['foreign account', (value) => (value['account'] = { user_id: 'u' })],
      ['account not an object', (value) => (value['account'] = 'nope')],
      ['empty project', (value) => (value['project_ref'] = ' ')],
      ['counts not an object', (value) => (value['counts'] = 'nope')],
      ['counts key set', (value) => (value['counts'] = { action_count: 1 })],
      ['negative count', (value) => ((value['counts'] as JsonObject)['action_count'] = -1)],
      ['sets key set', (value) => (value['sets'] = {})],
      ['sets not an object', (value) => (value['sets'] = 'nope')],
      [
        'set not a hash',
        (value) => ((value['sets'] as JsonObject)['before_hash_set_sha256'] = 'x'),
      ],
      ['no derivative targets', (value) => (value['derivative_targets'] = [])],
      ['derivative target shape', (value) => (value['derivative_targets'] = [{ table: 'flows' }])],
      ['derivative target not an object', (value) => (value['derivative_targets'] = ['nope'])],
      [
        'derivative target table',
        (value) => {
          (value['derivative_targets'] as JsonObject[])[0]!['table'] = 'sources';
        },
      ],
      [
        'derivative target state',
        (value) => {
          (value['derivative_targets'] as JsonObject[])[0]!['state_code'] = 100;
        },
      ],
      ['foreign policy', (value) => ((value['policy'] as JsonObject)['max_admit_posts'] = 2)],
      ['policy key set', (value) => (value['policy'] = {})],
      ['policy not an object', (value) => (value['policy'] = 'nope')],
      ['extra key', (value) => (value['extra'] = 1)],
      ['stale content', (value) => (value['expected_closure'] = { roots: 1 })],
    ];
    for (const [label, mutate] of cases) {
      const candidate = JSON.parse(JSON.stringify(freeze)) as JsonObject;
      mutate(candidate);
      rejects(() => parseAliasV2Freeze(candidate), ARTIFACT_INVALID, label);
    }
    assert.equal(parseAliasV2Freeze(freeze)['freeze_sha256'], freeze['freeze_sha256']);
    rejects(() => parseAliasV2Freeze(null), ARTIFACT_INVALID, 'null freeze');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('every approval and approval-request field is validated', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const approval = readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval);
    const request = readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request);
    const approvalCases: Array<[string, (value: JsonObject) => void]> = [
      [
        'foreign schema',
        (value) => (value['schema_version'] = 'dataset-alias-execution-approval.v1'),
      ],
      ['foreign environment', (value) => (value['environment'] = 'local')],
      ['foreign visibility', (value) => (value['target_visibility'] = 'owner')],
      ['two admissions', (value) => (value['max_admit_posts'] = 2)],
      ['automatic retry', (value) => (value['automatic_retry'] = true)],
      ['foreign identity', (value) => (value['approval_identity_sha256'] = 'f'.repeat(64))],
      ['missing approval time', (value) => (value['approved_at_utc'] = '')],
      ['extra key', (value) => (value['extra'] = 1)],
    ];
    for (const [label, mutate] of approvalCases) {
      const candidate = JSON.parse(JSON.stringify(approval)) as JsonObject;
      mutate(candidate);
      rejects(() => parseAliasV2Approval(candidate), ARTIFACT_INVALID, label);
    }
    const requestCases: Array<[string, (value: JsonObject) => void]> = [
      [
        'foreign schema',
        (value) => (value['schema_version'] = 'dataset-alias-execution-approval-request.v1'),
      ],
      ['foreign environment', (value) => (value['environment'] = 'preview')],
      ['foreign request digest', (value) => (value['request_sha256'] = 'f'.repeat(64))],
      ['foreign text digest', (value) => (value['approval_text_sha256'] = 'f'.repeat(64))],
      ['empty text', (value) => (value['approval_text'] = '')],
      ['counts key set', (value) => (value['counts'] = {})],
      ['extra key', (value) => (value['extra'] = 1)],
    ];
    for (const [label, mutate] of requestCases) {
      const candidate = JSON.parse(JSON.stringify(request)) as JsonObject;
      mutate(candidate);
      rejects(() => parseAliasV2ApprovalRequest(candidate), ARTIFACT_INVALID, label);
    }
    rejects(() => parseAliasV2Approval(null), ARTIFACT_INVALID, 'null approval');
    rejects(() => parseAliasV2ApprovalRequest('nope'), ARTIFACT_INVALID, 'string request');
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the dispatch classifies refusals, unknown transport outcomes and odd envelopes', async () => {
  const sealed = sealedAliasV2Execution();
  try {
    const identity = sealed.identity;
    // A transport error carrying an HTTP status and a coded body is a refusal with that code.
    const coded = await protectedInternals.dispatchOutcome(async () => {
      const error = new Error('HTTP 409 returned from the read endpoint');
      (error as unknown as { details?: unknown }).details = {
        response: JSON.stringify({ ok: false, code: 'ALIAS_V2_REPLAY_CONFLICT' }),
      };
      throw error;
    });
    assert.deepEqual(coded, { kind: 'refusal', status: 409, code: 'ALIAS_V2_REPLAY_CONFLICT' });
    // An error details string that is not JSON is an unknown outcome, never a refusal.
    const unparsable = await protectedInternals.dispatchOutcome(async () => {
      const error = new Error('HTTP 502 returned from the read endpoint');
      (error as unknown as { details?: unknown }).details = '<html>bad gateway</html>';
      throw error;
    });
    assert.deepEqual(unparsable, { kind: 'response', status: 502, body: null, raw: null });
    // A bare success body is the payload; an envelope-only body is nothing.
    assert.deepEqual(protectedInternals.normalizeEnvelope({ ok: true }), {
      kind: 'payload',
      body: null,
    });
    assert.deepEqual(protectedInternals.normalizeEnvelope({ value: 1 }), {
      kind: 'payload',
      body: { value: 1 },
    });
    assert.equal(protectedInternals.parseMaybeJson(7), 7);
    // The preflight request builder refuses an identity that is not the frozen one.
    const request = buildAliasV2PreflightRequest({
      identity,
      plan: sealed.plan,
      freeze: sealed.freeze,
      approval: parseAliasV2Approval(
        readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval),
      ),
    });
    assert.equal(request['environment'], 'production');
    // The identity derivation is deterministic and bound to the artefact bytes.
    const rebuilt = buildAliasV2ExecutionIdentity({
      freeze: sealed.freeze,
      approval: parseAliasV2Approval(
        readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval),
      ),
      freezeFileSha256: sealed.freezeFileSha256,
      approvalFileSha256: sealed.approvalFileSha256,
    });
    assert.equal(rebuilt.request_id, identity.request_id);
    assert.equal(rebuilt.identity_sha256, identity.identity_sha256);
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the marker states are distinct, and a read-only run never admits', async () => {
  const sealed = sealedAliasV2Execution();
  try {
    const markerPath = path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.submission_marker);
    assert.deepEqual(protectedInternals.readMarkerState(markerPath), { state: 'absent' });
    writeFileSync(markerPath, '{ broken\n', { mode: 0o600 });
    assert.equal(protectedInternals.readMarkerState(markerPath).state, 'unreadable');
    writeFileSync(markerPath, `${stableJsonText({ schema_version: 'other' })}\n`, { mode: 0o600 });
    assert.equal(protectedInternals.readMarkerState(markerPath).state, 'unreadable');
    rmSync(markerPath);
    // A status-only run whose server read is inconclusive reports indeterminate and never admits.
    const calls: string[] = [];
    const report = await runAliasV2Protected({
      planPath: sealed.planPath,
      freezePath: sealed.freezePath,
      approvalPath: sealed.approvalPath,
      outDir: sealed.directory,
      commit: false,
      statusOnly: true,
      waitSeconds: 0,
      pollMs: 100,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
      }),
      fetchImpl: (async (input: string) => {
        const url = String(input);
        calls.push(url);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({
            userId: ALIAS_V2_TEST_ACCOUNT.user_id,
            email: ALIAS_V2_TEST_ACCOUNT.email,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as FetchLike,
    }).catch((error: unknown) => error);
    // Either the access-token path resolves without a fetch (and the run reports from the read
    // path) or the auth lookup fails: in both cases no admission is ever posted.
    assert.equal(
      calls.some((url) => url.includes(ALIAS_V2_PROTOCOL.admit_command)),
      false,
      'a read-only run never posts an admission',
    );
    void report;
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the public stages validate their inputs and refuse foreign artefacts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-public-refuse-'));
  try {
    const inputPath = path.join(directory, 'input.json');
    writeFileSync(inputPath, `${stableJsonText(buildAliasV2CohortInput())}\n`, { mode: 0o600 });
    const planned = planAliasV2({ inputPath, outDir: directory });
    const plan = readArtifact(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
    const batch = readArtifact(directory, ALIAS_V2_PROTECTED_ARTIFACTS.batch_file);
    assert.equal(planned.plan_sha256, plan['plan_sha256']);
    assert.equal(batch['plan_sha256'], plan['plan_sha256']);
    // The detectors only claim v2 for a real v2 artefact, and never throw for a foreign file.
    assert.equal(
      isAliasV2PlanFile(path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file)),
      true,
    );
    assert.equal(isAliasV2PlanFile(inputPath), false);
    assert.equal(isAliasV2PlanFile(path.join(directory, 'missing.json')), false);
    assert.equal(isAliasV2FreezeFile(path.join(directory, 'missing.json')), false);
    // The derivative baselines must cover exactly the plan's rows, with six-key targets.
    const targets = (plan['actions'] as JsonObject[]).map((action) => ({
      table: action['table'],
      id: action['id'],
      version: action['version'],
      user_id: ALIAS_V2_TEST_ACCOUNT.user_id,
      state_code: 0,
      baseline_snapshot_sha256: sha256Json({ id: action['id'] }),
    }));
    const baselines = { schema_version: 'dataset-alias-derivative-baselines.v2', targets };
    assert.equal(parseAliasV2DerivativeBaselines(baselines, plan).length, targets.length);
    rejects(
      () => parseAliasV2DerivativeBaselines({ schema_version: 'other', targets }, plan),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'foreign baselines schema',
    );
    rejects(
      () =>
        parseAliasV2DerivativeBaselines(
          { schema_version: baselines.schema_version, targets: [] },
          plan,
        ),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'incomplete coverage',
    );
    rejects(
      () =>
        parseAliasV2DerivativeBaselines(
          { schema_version: baselines.schema_version, targets: [targets[0], targets[0]] },
          plan,
        ),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'repeated row',
    );
    rejects(
      () =>
        parseAliasV2DerivativeBaselines(
          {
            schema_version: baselines.schema_version,
            targets: [{ ...targets[0]!, table: 'sources' }, ...targets.slice(1)],
          },
          plan,
        ),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'foreign row',
    );
    rejects(
      () =>
        parseAliasV2DerivativeBaselines(
          {
            schema_version: baselines.schema_version,
            targets: [{ ...targets[0]!, baseline_snapshot_sha256: 'x' }, ...targets.slice(1)],
          },
          plan,
        ),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'unhashed baseline',
    );
    rejects(
      () =>
        parseAliasV2DerivativeBaselines(
          {
            schema_version: baselines.schema_version,
            targets: [{ ...targets[0]!, state_code: 100 }, ...targets.slice(1)],
          },
          plan,
        ),
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      'published baseline row',
    );
    // The eight sets are derived from the plan content, never accepted from a caller.
    const sets = deriveAliasV2Sets({
      plan,
      derivativeTargets: targets,
      toolchainEvidenceSha256: 'a'.repeat(64),
    });
    assert.deepEqual(Object.keys(sets).sort(), [
      'alias_plan_request_sha256',
      'before_hash_set_sha256',
      'derivative_baseline_set_sha256',
      'derivative_target_set_sha256',
      'desired_hash_set_sha256',
      'exchange_rewrite_set_sha256',
      'support_snapshot_set_sha256',
      'toolchain_evidence_sha256',
    ]);
    assert.equal(sets['toolchain_evidence_sha256'], 'a'.repeat(64));
    // Sealing without the real freeze bytes is refused before any approval is written.
    rejects(
      () =>
        sealAliasV2ProtectedApproval({
          freezePath: path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file),
          approvalRequestPath: inputPath,
          humanApprovalPath: inputPath,
          outDir: directory,
          approveFreezeFile: 'a'.repeat(64),
          approveRequest: 'b'.repeat(64),
          approveText: 'c'.repeat(64),
          confirm: ALIAS_V2_TEST_ACCOUNT.email,
          approvedAtUtc: '2026-09-21T00:00:00.000Z',
        }),
      ARTIFACT_INVALID,
      'plan file as a freeze',
    );
    // A plan that is not a v2 plan cannot be planned as one.
    const notAPlan = path.join(directory, 'not-a-plan.json');
    writeFileSync(notAPlan, `${stableJsonText({ schema_version: 'other' })}\n`, { mode: 0o600 });
    rejects(
      () => planAliasV2({ inputPath: notAPlan, outDir: directory }),
      'ALIAS_V2_PLAN_INVALID',
      'foreign plan input',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the version dispatch routes a v2 seal to v2 and a foreign seal elsewhere', async () => {
  const sealed = sealedAliasV2Execution();
  try {
    const calls: string[] = [];
    const report = await runDatasetMaintenanceProtectedDispatch({
      planPath: sealed.planPath,
      freezePath: sealed.freezePath,
      approvalPath: sealed.approvalPath,
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-dispatch-options-')),
      commit: false,
      statusOnly: true,
      waitSeconds: 0,
      pollMs: 250,
      timeoutMs: 7_500,
      now: new Date('2026-09-21T00:00:00.000Z'),
      sleep: async () => {},
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
      }),
      fetchImpl: (async (input: string) => {
        const url = String(input);
        calls.push(url);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({
            userId: ALIAS_V2_TEST_ACCOUNT.user_id,
            email: ALIAS_V2_TEST_ACCOUNT.email,
          });
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          async text() {
            return JSON.stringify({ ok: true });
          },
        };
      }) as FetchLike,
    });
    // The v2 chain ran: it read the authoritative path and never admitted.
    assert.equal(report.mode, 'status_only');
    assert.equal(report.status, 'not_admitted');
    assert.equal(
      calls.some((url) => url.includes(ALIAS_V2_PROTOCOL.admit_command)),
      false,
    );
    // A caller that names no window still reaches the same versioned chain: only the options
    // that were actually supplied are passed on, and the reviewed defaults apply.
    const defaults = await runDatasetMaintenanceProtectedDispatch({
      planPath: sealed.planPath,
      freezePath: sealed.freezePath,
      approvalPath: sealed.approvalPath,
      outDir: mkdtempSync(path.join(os.tmpdir(), 'alias-v2-dispatch-defaults-')),
      commit: false,
      statusOnly: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
      }),
      fetchImpl: (async (input: string) => {
        const url = String(input);
        if (isSupabaseAuthTokenUrl(url)) {
          return makeSupabaseAuthResponse({
            userId: ALIAS_V2_TEST_ACCOUNT.user_id,
            email: ALIAS_V2_TEST_ACCOUNT.email,
          });
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          async text() {
            return JSON.stringify({ ok: true });
          },
        };
      }) as FetchLike,
    });
    assert.deepEqual([defaults.mode, defaults.status], ['status_only', 'not_admitted']);
    // A seal that is not a v2 freeze is routed to the frozen v1 chain, never to the v2 module.
    const foreign = path.join(sealed.directory, 'foreign-freeze.json');
    writeFileSync(foreign, `${stableJsonText({ schema_version: 'other' })}\n`, { mode: 0o600 });
    assert.equal(isAliasV2FreezeFile(foreign), false);
    await assert.rejects(() =>
      runDatasetMaintenanceProtectedDispatch({
        planPath: sealed.planPath,
        freezePath: foreign,
        approvalPath: sealed.approvalPath,
        outDir: sealed.directory,
        commit: false,
        statusOnly: true,
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
        }),
        fetchImpl: (async () => {
          throw new Error('the frozen v1 chain reports its own artefact error');
        }) as unknown as FetchLike,
      }),
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the plan builder refuses every remaining shape it must', () => {
  const input = buildAliasV2CohortInput();
  const invalid = 'ALIAS_V2_PLAN_INVALID';
  // A target unit table without its hour factor, or with a substituted one, is not a target.
  const targetShape = 'ALIAS_V2_TARGET_SHAPE_INVALID';
  for (const unit of [
    [{ name: 'a', meanValue: '1' }],
    [
      { name: 'a', meanValue: '2' },
      { name: 'hr', meanValue: '0.00011415525114155251' },
    ],
    [
      { name: 'a', meanValue: '1' },
      { name: 'hr', meanValue: '1' },
    ],
    [
      { name: 'a', meanValue: '1' },
      { name: 'hr', meanValue: 1 },
    ],
  ]) {
    rejects(
      () =>
        buildAliasV2Plan({
          ...input,
          target_unit_group: {
            ...input.target_unit_group,
            json: { unitGroupDataSet: { units: { unit } } },
          },
        }),
      targetShape,
      `unit table ${JSON.stringify(unit)}`,
    );
  }
  rejects(
    () =>
      buildAliasV2Plan({
        ...input,
        target_unit_group: { ...input.target_unit_group, json: {} },
      }),
    targetShape,
    'missing unit table',
  );
  // Source and target must differ.
  rejects(
    () =>
      buildAliasV2Plan({
        ...input,
        source_alias: { id: input.target_flow_property.id, version: '01.00.000' },
      }),
    invalid,
    'source equals target',
  );
  // Every before image must carry the reviewed source alias exactly.
  const flow = input.flows[0]!;
  rejects(
    () =>
      buildAliasV2Plan({
        ...input,
        flows: [
          {
            ...flow,
            json: {
              flowDataSet: {
                ...(flow.json['flowDataSet'] as JsonObject),
                flowProperties: {
                  flowProperty: [
                    {
                      ...(
                        ((flow.json['flowDataSet'] as JsonObject)['flowProperties'] as JsonObject)[
                          'flowProperty'
                        ] as JsonObject[]
                      )[0]!,
                      referenceToFlowPropertyDataSet: {
                        '@refObjectId': 'beefbeef-0000-4000-8000-000000000001',
                        '@version': '00.00.001',
                      },
                    },
                  ],
                },
              },
            },
          },
          ...input.flows.slice(1),
        ],
      }),
    'ALIAS_V2_REFERENCE_SHAPE_INVALID',
    'foreign source alias',
  );
});

test('the dispatch probe refuses a freeze file that is not an object', async () => {
  const sealed = sealedAliasV2Execution();
  try {
    const arrayFreeze = path.join(sealed.directory, 'freeze-array.json');
    writeFileSync(arrayFreeze, '[]\n', { mode: 0o600 });
    await assert.rejects(
      () =>
        runDatasetMaintenanceProtectedDispatch({
          planPath: sealed.planPath,
          freezePath: arrayFreeze,
          approvalPath: sealed.approvalPath,
          outDir: sealed.directory,
          commit: false,
          statusOnly: true,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
          }),
          fetchImpl: (async () => {
            throw new Error('no endpoint is contacted for an unusable freeze');
          }) as unknown as FetchLike,
        }),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_FREEZE_INVALID',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the bounded quantity helpers refuse what the reviewed bounds exclude', async () => {
  const {
    BOUNDED_INPUT_LENGTH,
    BOUNDED_OUTPUT_LENGTH,
    canonicalDecimalText,
    isBoundedDecimalValue,
    isBoundedFactorValue,
    multiplyBoundedCanonicalDecimal,
    multiplyBoundedExactDecimal,
    normalizeBoundedDecimalText,
  } = await import('../src/lib/dataset-alias-exponent-decimal.js');
  // Plain quantities render exactly; exponent quantities normalise without exponents.
  assert.equal(normalizeBoundedDecimalText('0.0002'), '0.0002');
  assert.equal(canonicalDecimalText('0'), '0');
  assert.equal(canonicalDecimalText('1.0E+3'), '1000');
  assert.equal(isBoundedDecimalValue('0.0002'), true);
  assert.equal(isBoundedFactorValue('1'), true);
  // The length and exponent bounds are the reviewed ones.
  assert.equal(isBoundedDecimalValue('9'.repeat(BOUNDED_INPUT_LENGTH + 1)), false);
  assert.equal(isBoundedDecimalValue('1E31'), false);
  // A product whose rendering would exceed the output bound is refused by both renderings.
  const value = `1.${'1'.repeat(58)}E-30`;
  const factor = `0.${'9'.repeat(62)}`;
  assert.equal(multiplyBoundedExactDecimal(value, factor), null);
  assert.equal(multiplyBoundedCanonicalDecimal(value, factor), null);
  const product = multiplyBoundedExactDecimal('1', factor);
  assert.equal(product !== null && product.length <= BOUNDED_OUTPUT_LENGTH, true);
});

test('the plan document, the canonical bytes and the artefact bindings are proved before dispatch', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const plan = readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
    // The plan a v2 freeze binds is the reviewed schema with its actions, counts and snapshots.
    const planCases: Array<[string, unknown]> = [
      ['not an object', []],
      ['foreign schema', { ...plan, schema_version: 'dataset-alias-plan.v1' }],
      ['no actions', { ...plan, actions: [] }],
      ['bad digest', { ...plan, plan_sha256: 'x' }],
      ['counts key set', { ...plan, counts: { action_count: 1 } }],
      ['missing snapshots', { ...plan, target_snapshots: 'nope' }],
      ['missing evidence', { ...plan, source_evidence: 'nope' }],
    ];
    for (const [label, value] of planCases) {
      rejects(() => assertAliasV2PlanDocument(value), ARTIFACT_INVALID, label);
    }
    assert.equal(assertAliasV2PlanDocument(plan)['plan_sha256'], plan['plan_sha256']);

    // A parsed artefact must be exactly the bytes on disk: a reformatted file is not the
    // document its own digests bind, so it is never treated as canonical evidence.
    rejects(
      () =>
        assertAliasV2CanonicalArtifact({
          label: 'Alias v2 freeze',
          text: '{"a": 1}\n',
          value: { a: 1 },
        }),
      ARTIFACT_INVALID,
      'non-canonical bytes',
    );
    assertAliasV2CanonicalArtifact({
      label: 'Alias v2 freeze',
      text: `${stableJsonText({})}\n`,
      value: {},
    });

    // The freeze must bind exactly this plan file and content; the approval must bind exactly
    // this freeze file, freeze content and the operator's explicit hash.
    const freeze = parseAliasV2Freeze(
      readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.freeze),
    );
    const approval = parseAliasV2Approval(
      readArtifact(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval),
    );
    const bindings = {
      plan,
      planFileSha256: sealed.freeze.plan.plan_file_sha256,
      freeze,
      freezeFileSha256: sealed.freezeFileSha256,
      approval,
      approvalFileSha256: sealed.approvalFileSha256,
      approveExecution: sealed.approveExecution,
    };
    assert.equal(
      assertAliasV2Bindings(bindings).request_id,
      sealed.identity.request_id,
      'the reviewed bindings derive the sealed identity',
    );
    rejects(
      () => assertAliasV2Bindings({ ...bindings, planFileSha256: 'a'.repeat(64) }),
      ARTIFACT_INVALID,
      'freeze bound to another plan file',
    );
    rejects(
      () =>
        assertAliasV2Bindings({
          ...bindings,
          plan: { ...plan, counts: { ...(plan['counts'] as JsonObject), action_count: 1 } },
        }),
      ARTIFACT_INVALID,
      'freeze bound to other plan content',
    );

    // The operator approves the words the request carries: a paraphrase is refused even when
    // every explicit hash the caller supplies is the right one, and the exact text is accepted.
    const requestArtifact = readArtifact(
      sealed.directory,
      ALIAS_V2_PROTECTED_ARTIFACTS.approval_request,
    );
    const request = parseAliasV2ApprovalRequest(requestArtifact);
    const requestFileSha256 = createHash('sha256')
      .update(
        readFileSync(path.join(sealed.directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request)),
      )
      .digest('hex');
    const seal = (humanApprovalText: string): unknown =>
      sealAliasV2Approval({
        request,
        requestFileSha256,
        humanApprovalText,
        approvals: {
          plan: request.plan_sha256,
          freeze: request.freeze_sha256,
          request: requestFileSha256,
          text: request.approval_text_sha256,
        },
        confirm: request.account.email,
        approvedAtUtc: '2026-09-21T00:00:00.000Z',
      });
    assert.throws(
      () => seal(`${request.approval_text} (paraphrased)`),
      (error: unknown) =>
        (error as { code?: string }).code === 'DATASET_MAINTENANCE_PROTECTED_APPROVAL_MISMATCH',
    );
    assert.equal(
      (seal(request.approval_text) as { value: JsonObject }).value['approval_identity_sha256'],
      sealed.approveExecution,
      'the exact approved text seals the same identity',
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});
