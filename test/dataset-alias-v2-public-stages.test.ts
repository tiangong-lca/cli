// The public v2 stages on their own contract: `plan`, `freeze-protected` and
// `seal-protected-approval` are the operator's entry points, so each one derives what it can and
// refuses what it cannot prove. The argv path is covered end to end elsewhere; these cases pin the
// stage contract itself, including the option passthrough the argv path never exercises.

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
import { ALIAS_V2_PROTECTED_ARTIFACTS } from '../src/lib/dataset-alias-v2-protected.js';
import {
  freezeAliasV2Protected,
  planAliasV2,
  sealAliasV2ProtectedApproval,
} from '../src/lib/dataset-alias-v2-public.js';
import { buildAliasV2CohortInput } from './fixtures/alias-v2-cohort.js';
import {
  ALIAS_V2_TEST_ACCOUNT,
  ALIAS_V2_TEST_PROJECT_REF,
  aliasV2DerivativeTargets,
  protectedToolchainEvidence,
} from './helpers/alias-v2-artifacts.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike } from '../src/lib/http.js';

const CLI_VERSION = '0.1.21';
const CONTEXT_MISMATCH = 'DATASET_MAINTENANCE_PROTECTED_CONTEXT_MISMATCH';
const PUBLIC_INVALID = 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID';
const SEAL_MISMATCH = 'ALIAS_V2_PUBLIC_SEAL_MISMATCH';

/** A transport that answers only the owner's own session; every other call is a failure. */
const authOnlyFetch: FetchLike = (async (input: string) => {
  const url = String(input);
  if (isSupabaseAuthTokenUrl(url)) {
    return makeSupabaseAuthResponse({
      userId: ALIAS_V2_TEST_ACCOUNT.user_id,
      email: ALIAS_V2_TEST_ACCOUNT.email,
    });
  }
  throw new Error(`Unexpected request: ${url}`);
}) as FetchLike;

function digestOf(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readArtifact(filePath: string): JsonObject {
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonObject;
}

function write(filePath: string, value: unknown): string {
  const text = typeof value === 'string' ? value : `${stableJsonText(value)}\n`;
  writeFileSync(filePath, text, { mode: 0o600 });
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

type Chain = {
  directory: string;
  planPath: string;
  toolchainPath: string;
  baselinesPath: string;
  freezePath: string;
  requestPath: string;
  textPath: string;
  humanPath: string;
  plan: JsonObject;
  planFileSha256: string;
  freezeFileSha256: string;
};

/** Builds the same artefacts the reviewed argv workflow builds, one public stage at a time. */
async function buildChain(directory: string): Promise<Chain> {
  const inputPath = path.join(directory, 'input.json');
  write(inputPath, buildAliasV2CohortInput());
  planAliasV2({ inputPath, outDir: directory });
  const planPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
  const plan = readArtifact(planPath);
  const toolchainPath = path.join(directory, 'toolchain.json');
  write(toolchainPath, protectedToolchainEvidence(CLI_VERSION));
  const baselinesPath = path.join(directory, 'baselines.json');
  write(baselinesPath, {
    schema_version: 'dataset-alias-derivative-baselines.v2',
    targets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
  });
  const frozen = await freezeAliasV2Protected({
    planPath,
    toolchainEvidencePath: toolchainPath,
    derivativeBaselinesPath: baselinesPath,
    outDir: directory,
    expectedProjectRef: ALIAS_V2_TEST_PROJECT_REF,
    confirm: ALIAS_V2_TEST_ACCOUNT.email,
    cliVersion: CLI_VERSION,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
    }),
    fetchImpl: authOnlyFetch,
    // The review clock and the request timeout are explicit here: the stage must pass both
    // through to the context it resolves, exactly as it does on the argv path.
    timeoutMs: 5_000,
    now: new Date('2026-09-21T00:00:00.000Z'),
  });
  return {
    directory,
    planPath,
    toolchainPath,
    baselinesPath,
    freezePath: frozen.freeze_path,
    requestPath: frozen.approval_request_path,
    textPath: frozen.approval_text_path,
    humanPath: path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.human_approval),
    plan,
    planFileSha256: digestOf(planPath),
    freezeFileSha256: digestOf(frozen.freeze_path),
  };
}

function freezeOptions(
  chain: Chain,
  overrides: JsonObject = {},
): Parameters<typeof freezeAliasV2Protected>[0] {
  return {
    planPath: chain.planPath,
    toolchainEvidencePath: chain.toolchainPath,
    derivativeBaselinesPath: chain.baselinesPath,
    outDir: chain.directory,
    expectedProjectRef: ALIAS_V2_TEST_PROJECT_REF,
    confirm: ALIAS_V2_TEST_ACCOUNT.email,
    cliVersion: CLI_VERSION,
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${ALIAS_V2_TEST_PROJECT_REF}.supabase.co/functions/v1`,
    }),
    fetchImpl: authOnlyFetch,
    ...overrides,
  } as Parameters<typeof freezeAliasV2Protected>[0];
}

test('the freeze stage binds the plan, the toolchain evidence and the owner account', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-public-stages-'));
  try {
    const chain = await buildChain(directory);
    const freeze = readArtifact(chain.freezePath);
    assert.deepEqual(freeze['plan'], {
      plan_file_sha256: chain.planFileSha256,
      plan_sha256: chain.plan['plan_sha256'],
    });
    assert.deepEqual(freeze['account'], ALIAS_V2_TEST_ACCOUNT);
    assert.deepEqual(freeze['expected'], chain.plan['expected']);
    assert.deepEqual(freeze['sets'], readArtifact(chain.freezePath)['sets']);
    // The approval request, the approval text and the human approval file carry the same words.
    const request = readArtifact(chain.requestPath);
    assert.equal(request['freeze_file_sha256'], chain.freezeFileSha256);
    assert.equal(request['approval_text'], readFileSync(chain.textPath, 'utf8'));
    assert.equal(readFileSync(chain.humanPath, 'utf8'), request['approval_text']);

    // A confirmation that is not a set of words, a plan that is not a document and a context that
    // is not the sealed owner are all refused before anything is written.
    for (const [label, overrides, code] of [
      ['blank confirmation', { confirm: '   ' }, PUBLIC_INVALID],
      ['foreign owner', { confirm: 'someone-else@example.invalid' }, CONTEXT_MISMATCH],
    ] as Array<[string, JsonObject, string]>) {
      await assert.rejects(
        () => freezeAliasV2Protected(freezeOptions(chain, overrides)),
        (error: unknown) => (error as { code?: string }).code === code,
        label,
      );
    }
    const arrayPath = path.join(directory, 'array-plan.json');
    write(arrayPath, '[]\n');
    await assert.rejects(
      () => freezeAliasV2Protected(freezeOptions(chain, { planPath: arrayPath })),
      (error: unknown) => (error as { code?: string }).code === PUBLIC_INVALID,
      'a plan artefact that is not a JSON object',
    );
    const foreignBaselines = path.join(directory, 'foreign-baselines.json');
    write(foreignBaselines, {
      schema_version: 'dataset-alias-derivative-baselines.v2',
      targets: ['nope'],
    });
    await assert.rejects(
      () =>
        freezeAliasV2Protected(freezeOptions(chain, { derivativeBaselinesPath: foreignBaselines })),
      (error: unknown) => (error as { code?: string }).code === PUBLIC_INVALID,
      'a baseline target that is not an object',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the seal stage refuses a request that binds other freeze bytes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-public-seal-'));
  try {
    const chain = await buildChain(directory);
    const request = readArtifact(chain.requestPath);
    const sealed = sealAliasV2ProtectedApproval({
      freezePath: chain.freezePath,
      approvalRequestPath: chain.requestPath,
      humanApprovalPath: chain.humanPath,
      outDir: directory,
      approveFreezeFile: chain.freezeFileSha256,
      approveRequest: digestOf(chain.requestPath),
      approveText: String(request['approval_text_sha256']),
      confirm: ALIAS_V2_TEST_ACCOUNT.email,
      approvedAtUtc: '2026-09-21T00:00:00.000Z',
    });
    assert.equal(
      sealed.approval_identity_sha256,
      readArtifact(sealed.approval_path)['approval_identity_sha256'],
    );

    // A request that is internally consistent but binds a different freeze file proves nothing
    // about the freeze it is sealed against: the explicit freeze hash and the request must agree.
    const foreign = { ...request, freeze_file_sha256: 'f'.repeat(64) } as JsonObject;
    foreign['request_sha256'] = sha256Json({
      schema_version: foreign['schema_version'],
      approved_at_utc: foreign['approved_at_utc'],
      environment: foreign['environment'],
      project_ref: foreign['project_ref'],
      account: foreign['account'],
      plan_sha256: foreign['plan_sha256'],
      plan_file_sha256: foreign['plan_file_sha256'],
      freeze_file_sha256: foreign['freeze_file_sha256'],
      freeze_sha256: foreign['freeze_sha256'],
      expected: foreign['expected'],
    });
    const foreignPath = path.join(directory, 'foreign-request.json');
    write(foreignPath, foreign);
    assert.throws(
      () =>
        sealAliasV2ProtectedApproval({
          freezePath: chain.freezePath,
          approvalRequestPath: foreignPath,
          humanApprovalPath: chain.humanPath,
          outDir: directory,
          approveFreezeFile: chain.freezeFileSha256,
          approveRequest: digestOf(foreignPath),
          approveText: String(request['approval_text_sha256']),
          confirm: ALIAS_V2_TEST_ACCOUNT.email,
          approvedAtUtc: '2026-09-21T00:00:00.000Z',
        }),
      (error: unknown) => (error as { code?: string }).code === SEAL_MISMATCH,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
