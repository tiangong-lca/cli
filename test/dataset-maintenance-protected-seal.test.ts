import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sealDatasetMaintenanceProtectedApproval,
  __testInternals,
  type SealDatasetMaintenanceProtectedApprovalOptions,
} from '../src/lib/dataset-maintenance-protected-seal.js';
import { stableJsonText } from '../src/lib/canonical-json-hash.js';
import { PROTECTED_PRODUCTION_PROJECT_REF } from '../src/lib/dataset-maintenance-protected-preparation.js';
import path from 'node:path';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const EMAIL = 'bafudata@126.com';

function options(): SealDatasetMaintenanceProtectedApprovalOptions {
  return {
    freezePath: '/private/protected-execution-freeze.json',
    approvalRequestPath: '/private/protected-approval-request.json',
    humanApprovalPath: '/private/human-approval.txt',
    outDir: '/private/sealed',
    approveFreezeFile: HASH_A,
    approveRequest: HASH_B,
    approveText: HASH_C,
    confirm: EMAIL,
    approvedAtUtc: '2026-07-15T12:34:56.000Z',
    now: new Date('2026-07-15T12:35:56.000Z'),
  };
}

function fixtures() {
  const freeze = {
    project_ref: PROTECTED_PRODUCTION_PROJECT_REF,
    account: { user_id: 'user-1', email: EMAIL },
    plan: { plan_sha256: HASH_A, operation_id: 'maintenance-new' },
    freeze_sha256: HASH_B,
  };
  const request = {
    request_sha256: HASH_B,
    approval_text: 'exact human approval\n',
    approval_text_sha256: HASH_C,
  };
  const approval = {
    approval_identity_sha256: HASH_A,
  };
  return { freeze, request, approval };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const { freeze, request, approval } = fixtures();
  const writes: Array<{ kind: 'json' | 'text'; filePath: string; value: unknown }> = [];
  const calls: string[] = [];
  const deps = {
    readJson: ({ label }: { label: string }) => {
      calls.push(`read:${label}`);
      const value = label === 'Protected execution freeze' ? freeze : request;
      return {
        resolved: label.includes('freeze') ? '/private/freeze.json' : '/private/request.json',
        value,
        text: `${stableJsonText(value)}\n`,
        file_sha256: label.includes('freeze') ? HASH_A : HASH_B,
      };
    },
    readText: () => {
      calls.push('read:human');
      return {
        resolved: '/private/human-approval.txt',
        text: request.approval_text,
        file_sha256: HASH_C,
      };
    },
    parseFreeze: () => freeze,
    parseApprovalRequest: () => request,
    sealApproval: () => {
      calls.push('seal');
      return {
        value: approval,
        canonical_file_text: '{"approval":true}\n',
        file_sha256: HASH_C,
      };
    },
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
  return { deps, writes, calls, freeze, request, approval };
}

test('seal-protected-approval records byte-exact approval entirely offline', async () => {
  const fixture = dependencies();
  const report = await sealDatasetMaintenanceProtectedApproval(options(), fixture.deps as never);
  assert.equal(report.status, 'sealed');
  assert.equal(report.generated_at_utc, '2026-07-15T12:35:56.000Z');
  assert.equal(report.approval_authority_at_utc, '2026-07-15T12:34:56.000Z');
  assert.equal(report.execution_submitted, false);
  assert.equal(report.approval_identity_sha256, HASH_A);
  assert.equal(report.approval_file_sha256, HASH_C);
  assert.equal(report.assertions.byte_exact_human_text, true);
  assert.equal(report.assertions.authentication_calls, 0);
  assert.equal(report.assertions.network_calls, 0);
  assert.equal(report.assertions.database_calls, 0);
  assert.equal(report.assertions.preflight_calls, 0);
  assert.equal(report.assertions.gate_calls, 0);
  assert.equal(report.assertions.admission_calls, 0);
  assert.equal(report.assertions.execution_calls, 0);
  assert.deepEqual(fixture.calls, [
    'read:Protected execution freeze',
    'read:Protected approval request',
    'read:human',
    'seal',
  ]);
  assert.deepEqual(
    fixture.writes.map(({ filePath }) => path.basename(filePath)),
    [
      'protected-human-approval.txt',
      'protected-approval.json',
      'protected-approval-seal-report.json',
    ],
  );
  assert.equal(fixture.writes[0]!.value, fixture.request.approval_text);
});

test('seal-protected-approval requires every path and explicit approval field', async () => {
  const tokenKeys = [
    'freezePath',
    'approvalRequestPath',
    'humanApprovalPath',
    'outDir',
    'confirm',
    'approvedAtUtc',
  ] as const;
  for (const key of tokenKeys) {
    const command = options();
    command[key] = '';
    const fixture = dependencies();
    await assert.rejects(
      sealDatasetMaintenanceProtectedApproval(command, fixture.deps as never),
      new RegExp(key, 'u'),
    );
    assert.equal(fixture.calls.length, 0, key);
  }

  for (const key of ['approveFreezeFile', 'approveRequest', 'approveText'] as const) {
    const blank = options();
    blank[key] = '';
    await assert.rejects(
      sealDatasetMaintenanceProtectedApproval(blank, dependencies().deps as never),
      new RegExp(key, 'u'),
    );
    const malformed = options();
    malformed[key] = 'not-a-hash';
    await assert.rejects(
      sealDatasetMaintenanceProtectedApproval(malformed, dependencies().deps as never),
      /lowercase SHA-256/u,
    );
  }
});

test('seal-protected-approval rejects noncanonical freeze and request bytes', async () => {
  for (const label of ['Protected execution freeze', 'Protected approval request']) {
    const base = dependencies();
    const fixture = dependencies({
      readJson: ({ label: observed }: { label: string }) => {
        const value = observed === 'Protected execution freeze' ? base.freeze : base.request;
        return {
          resolved: '/private/input.json',
          value,
          text:
            observed === label
              ? `${JSON.stringify(value, null, 2)}\n`
              : `${stableJsonText(value)}\n`,
          file_sha256: observed === 'Protected execution freeze' ? HASH_A : HASH_B,
        };
      },
    });
    await assert.rejects(
      sealDatasetMaintenanceProtectedApproval(options(), fixture.deps as never),
      /canonical JSON/u,
    );
  }
});

test('seal-protected-approval rejects a freeze hash not confirmed byte-for-byte', async () => {
  const command = options();
  command.approveFreezeFile = HASH_B;
  await assert.rejects(
    sealDatasetMaintenanceProtectedApproval(command, dependencies().deps as never),
    /freeze file hash/u,
  );
});

test('seal-protected-approval rejects non-production evidence before reading approval inputs', async () => {
  const fixture = dependencies({
    parseFreeze: () => ({ ...fixtures().freeze, project_ref: 'dev-ref' }),
  });
  await assert.rejects(
    sealDatasetMaintenanceProtectedApproval(options(), fixture.deps as never),
    /production project/u,
  );
  assert.deepEqual(fixture.calls, ['read:Protected execution freeze']);
});

test('seal helper paths and canonical checks are deterministic', () => {
  const outDir = path.resolve('/private/out');
  assert.deepEqual(__testInternals.artifactPaths(outDir), {
    human_approval_text: path.join(outDir, 'protected-human-approval.txt'),
    approval: path.join(outDir, 'protected-approval.json'),
    report: path.join(outDir, 'protected-approval-seal-report.json'),
  });
  assert.doesNotThrow(() =>
    __testInternals.assertCanonicalJsonArtifact({
      label: 'value',
      text: '{"a":1}\n',
      value: { a: 1 },
    }),
  );
});

test('seal report records the actual runtime seal time separately', async () => {
  const command = options();
  command.now = undefined;
  const before = Date.now();
  const report = await sealDatasetMaintenanceProtectedApproval(
    command,
    dependencies().deps as never,
  );
  assert.ok(Date.parse(report.generated_at_utc) >= before);
  assert.equal(report.approval_authority_at_utc, command.approvedAtUtc);
});
