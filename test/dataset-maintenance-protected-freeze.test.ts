import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeDatasetMaintenanceProtected,
  __testInternals,
  type FreezeDatasetMaintenanceProtectedOptions,
} from '../src/lib/dataset-maintenance-protected-freeze.js';
import path from 'node:path';
import { stableJsonText } from '../src/lib/canonical-json-hash.js';
import type { DatasetMaintenanceRemoteContext } from '../src/lib/dataset-maintenance-remote.js';
import type { DatasetMaintenanceProtectedToolchainEvidence } from '../src/lib/dataset-maintenance-protected-toolchain.js';
import { PROTECTED_PRODUCTION_PROJECT_REF } from '../src/lib/dataset-maintenance-protected-preparation.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const USER_ID = 'dab05739-1a42-421b-8170-3b77146d1d64';
const EMAIL = 'bafudata@126.com';
const PROJECT_REF = PROTECTED_PRODUCTION_PROJECT_REF;

function options(): FreezeDatasetMaintenanceProtectedOptions {
  return {
    planPath: '/private/plan.json',
    toolchainEvidencePath: '/private/toolchain.json',
    outDir: '/private/freeze',
    expectedProjectRef: PROJECT_REF,
    confirm: EMAIL,
    cliVersion: '0.0.26',
    pageSize: 250,
    timeoutMs: 12_000,
    env: { TEST: 'true' },
    fetchImpl: async () => new Response('{}'),
    now: new Date('2026-07-15T12:00:00.000Z'),
  };
}

function context(): DatasetMaintenanceRemoteContext {
  return {
    project_ref: PROJECT_REF,
    rest_base_url: `https://${PROJECT_REF}.supabase.co/rest/v1`,
    publishable_key: 'publishable',
    access_token: 'access',
    account: { user_id: USER_ID, email: EMAIL, session_source: 'test' },
    fetch_impl: async () => new Response('{}'),
    timeout_ms: 12_000,
  };
}

function toolchain(): DatasetMaintenanceProtectedToolchainEvidence {
  return {
    schema_version: 'dataset-alias-protected-toolchain-evidence.v1',
    environment: 'production',
    project_ref: PROJECT_REF,
    verified_at_utc: '2026-07-15T11:00:00.000Z',
    database_engine: {
      repository: 'tiangong-lca/database-engine',
      production_main_commit_sha: '1'.repeat(40),
      production_readback_evidence_sha256: HASH_A,
      status: 'released_and_read_back',
    },
    cli: {
      repository: 'tiangong-lca/tiangong-cli',
      package_name: '@tiangong-lca/cli',
      package_version: '0.0.26',
      release_commit_sha: '2'.repeat(40),
      release_evidence_sha256: HASH_B,
      status: 'published_and_verified',
    },
    workspace: {
      repository: 'tiangong-lca/workspace',
      integration_commit_sha: '3'.repeat(40),
      integration_issue_url: 'https://github.com/tiangong-lca/workspace/issues/406',
      status: 'integrated',
    },
  };
}

function snapshots() {
  return Array.from({ length: 50 }, (_, index) => ({
    schema_version: 'dataset-derivative-snapshot.v1' as const,
    table: index < 23 ? ('flows' as const) : ('processes' as const),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    version: '00.00.001',
    user_id: USER_ID,
    state_code: 0 as const,
    modified_at: '2026-07-15T11:00:00.000Z',
    json_sha256: HASH_A,
    json_ordered_sha256: HASH_A,
    extracted_md_sha256: HASH_C,
    embedding_ft_sha256: HASH_C,
    embedding_ft_at: '2026-07-15T11:00:00.000Z',
    snapshot_sha256: index % 2 === 0 ? HASH_A : HASH_B,
  }));
}

function fixtures() {
  const evidence = toolchain();
  const plan = {
    plan_sha256: HASH_A,
    operation_id: 'maintenance-new',
    account: { user_id: USER_ID, email: EMAIL },
  };
  const freeze = {
    freeze_sha256: HASH_B,
    sets: { derivative_baseline_set_sha256: HASH_C },
  };
  const request = {
    request_sha256: HASH_A,
    approval_text: 'exact approval request\n',
    approval_text_sha256: HASH_B,
  };
  return { evidence, plan, freeze, request };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const { evidence, plan, freeze, request } = fixtures();
  const writes: Array<{ kind: 'json' | 'text'; filePath: string; value: unknown }> = [];
  const calls: string[] = [];
  const deps = {
    readArtifact: ({ label }: { label: string }) => {
      calls.push(`read:${label}`);
      return label === 'Protected maintenance plan'
        ? {
            resolved: '/private/plan.json',
            value: plan,
            text: '{}\n',
            file_sha256: HASH_A,
          }
        : {
            resolved: '/private/toolchain.json',
            value: evidence,
            text: `${stableJsonText(evidence)}\n`,
            file_sha256: HASH_B,
          };
    },
    parsePlan: () => plan,
    buildAliasPlan: () => ({ schema_version: 'dataset-alias-plan.v1' }),
    resolveContext: async () => {
      calls.push('resolve-context');
      return context();
    },
    fetchAccountRows: async () => {
      calls.push('fetch-account');
      return { rows: [], source_urls: [], completeness: { complete: true } };
    },
    parseToolchain: () => evidence,
    deriveTargets: () => [],
    validateBefore: async () => {
      calls.push('validate-before');
      return {
        projected_rows: [],
        support_snapshots: Array.from({ length: 6 }, () => ({})),
        derivative_snapshots: snapshots(),
        derivative_mode: 'capture' as const,
      };
    },
    buildFreeze: () => ({
      value: freeze,
      canonical_file_text: '{"freeze":true}\n',
      file_sha256: HASH_C,
      alias_plan_request_sha256: HASH_A,
    }),
    buildApprovalRequest: () => ({
      value: request,
      canonical_file_text: '{"request":true}\n',
      file_sha256: HASH_A,
    }),
    writeJson: (filePath: string, value: unknown) => {
      writes.push({ kind: 'json' as const, filePath, value });
      return filePath;
    },
    writeText: (filePath: string, value: string) => {
      writes.push({ kind: 'text' as const, filePath, value });
      return filePath;
    },
    materializeArtifacts: <T>(outDir: string, materialize: (directory: string) => T) =>
      materialize(outDir),
    ...overrides,
  };
  return { deps, writes, calls, plan, freeze, request, evidence };
}

test('freeze-protected performs one read-only preparation and writes no approval artifact', async () => {
  const fixture = dependencies();
  const report = await freezeDatasetMaintenanceProtected(options(), fixture.deps as never);

  assert.equal(report.status, 'ready_for_human_approval');
  assert.equal(report.remote_write_mode, 'read_only');
  assert.equal(report.project_ref, PROJECT_REF);
  assert.equal(report.account.user_id, USER_ID);
  assert.equal(report.assertions.derivative_snapshots, 50);
  assert.equal(report.assertions.support_snapshots, 6);
  assert.equal(report.assertions.preflight_calls, 0);
  assert.equal(report.assertions.gate_calls, 0);
  assert.equal(report.assertions.admission_calls, 0);
  assert.equal(report.assertions.mutation_calls, 0);
  assert.equal(report.assertions.approval_artifacts, 0);
  assert.deepEqual(fixture.calls, [
    'read:Protected maintenance plan',
    'read:Protected toolchain evidence',
    'resolve-context',
    'fetch-account',
    'validate-before',
  ]);
  assert.deepEqual(
    fixture.writes.map(({ filePath }) => path.basename(filePath)),
    [
      'protected-alias-plan-request.json',
      'protected-derivative-baselines.json',
      'protected-execution-freeze.json',
      'protected-approval-request.json',
      'protected-approval-request.txt',
      'protected-freeze-report.json',
    ],
  );
  assert.equal(
    fixture.writes.some(({ filePath }) => path.basename(filePath) === 'protected-approval.json'),
    false,
  );
  const baseline = JSON.parse(
    fixture.writes.find(({ filePath }) => filePath.endsWith('baselines.json'))!.value as string,
  );
  assert.equal(baseline.snapshots.length, 50);
  assert.equal(baseline.target_count, 50);
});

test('freeze-protected validates every explicit local input before authentication', async () => {
  const keys = [
    'planPath',
    'toolchainEvidencePath',
    'outDir',
    'expectedProjectRef',
    'confirm',
    'cliVersion',
  ] as const;
  for (const key of keys) {
    const command = options();
    command[key] = '';
    const fixture = dependencies();
    await assert.rejects(
      freezeDatasetMaintenanceProtected(command, fixture.deps as never),
      new RegExp(key, 'u'),
    );
    assert.equal(fixture.calls.length, 0, key);
  }

  const dev = options();
  dev.expectedProjectRef = 'dev-ref';
  const fixture = dependencies();
  await assert.rejects(
    freezeDatasetMaintenanceProtected(dev, fixture.deps as never),
    /production project/u,
  );
  assert.equal(fixture.calls.length, 0);
});

test('freeze-protected rejects noncanonical toolchain evidence', async () => {
  const fixture = dependencies({
    readArtifact: ({ label }: { label: string }) =>
      label === 'Protected maintenance plan'
        ? {
            resolved: '/private/plan.json',
            value: fixturePlaceholder.plan,
            text: '{}\n',
            file_sha256: HASH_A,
          }
        : {
            resolved: '/private/toolchain.json',
            value: fixturePlaceholder.evidence,
            text: `${JSON.stringify(fixturePlaceholder.evidence, null, 2)}\n`,
            file_sha256: HASH_B,
          },
  });
  await assert.rejects(
    freezeDatasetMaintenanceProtected(options(), fixture.deps as never),
    /canonical JSON/u,
  );
  assert.equal(fixture.calls.includes('resolve-context'), false);
});

const fixturePlaceholder = (() => {
  const { plan, evidence } = fixtures();
  return { plan, evidence };
})();

test('freeze context binds project, user, email, and explicit confirmation independently', () => {
  const base = { context: context(), plan: fixtures().plan as never };
  assert.deepEqual(
    __testInternals.assertContext({
      ...base,
      expectedProjectRef: PROJECT_REF,
      confirm: EMAIL,
    }),
    { user_id: USER_ID, email: EMAIL },
  );

  const cases = [
    { expectedProjectRef: 'foreign', confirm: EMAIL, plan: base.plan },
    {
      expectedProjectRef: PROJECT_REF,
      confirm: EMAIL,
      plan: { ...fixtures().plan, account: { user_id: 'foreign', email: EMAIL } },
    },
    {
      expectedProjectRef: PROJECT_REF,
      confirm: EMAIL,
      plan: { ...fixtures().plan, account: { user_id: USER_ID, email: 'foreign@example.com' } },
    },
    { expectedProjectRef: PROJECT_REF, confirm: 'foreign@example.com', plan: base.plan },
  ];
  for (const value of cases) {
    assert.throws(
      () =>
        __testInternals.assertContext({
          context: base.context,
          plan: value.plan as never,
          expectedProjectRef: value.expectedProjectRef,
          confirm: value.confirm,
        }),
      /does not match/u,
    );
  }
});

test('freeze report timestamp may use the runtime clock when no test clock is supplied', async () => {
  const command = options();
  command.now = undefined;
  const fixture = dependencies();
  const before = Date.now();
  const report = await freezeDatasetMaintenanceProtected(command, fixture.deps as never);
  assert.ok(Date.parse(report.generated_at_utc) >= before);
});
