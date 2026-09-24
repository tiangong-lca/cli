// One designated approval-authority timestamp for the whole v2 chain (CLI #364).
//
// The freeze designates the canonical `approved_at_utc` its injectable clock reads. That one value
// lives in the approval request core digest, in the bytes a human approves, and in the sealed
// approval: the seal refuses every other value, so one approved request cannot be re-timed into a
// second approval identity. The sealed approval keeps its reviewed 14-key shape, so an approval
// sealed before this binding still parses and still binds its execution.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sha256Json,
  sha256Text,
  stableJsonText,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_PROTECTED_ARTIFACTS,
  assertAliasV2Bindings,
  buildAliasV2ApprovalRequest,
  parseAliasV2Approval,
  parseAliasV2ApprovalRequest,
  sealAliasV2Approval,
} from '../src/lib/dataset-alias-v2-protected.js';
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
  fixturePlanProfile,
  protectedToolchainEvidence,
  sealedAliasV2Execution,
} from './helpers/alias-v2-artifacts.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';
import type { FetchLike } from '../src/lib/http.js';

const CLI_VERSION = '0.1.22';
const DESIGNATED_AT = '2026-09-22T06:30:00.000Z';
const OTHER_AT = '2026-09-22T07:45:00.000Z';
const ARTIFACT_INVALID = 'ALIAS_V2_PROTECTED_ARTIFACT_INVALID';
const TIME_INVALID = 'ALIAS_V2_PROTECTED_APPROVAL_TIME_INVALID';
const TIME_MISMATCH = 'ALIAS_V2_PROTECTED_APPROVAL_TIME_MISMATCH';
const REQUEST_UNBOUND_TIME = 'ALIAS_V2_PROTECTED_APPROVAL_REQUEST_UNBOUND_TIME';
const TEXT_MISMATCH = 'ALIAS_V2_PROTECTED_APPROVAL_TEXT_MISMATCH';

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

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function write(filePath: string, value: unknown): string {
  const text = typeof value === 'string' ? value : `${stableJsonText(value)}\n`;
  writeFileSync(filePath, text, { mode: 0o600 });
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function readArtifact(filePath: string): JsonObject {
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonObject;
}

function digestOf(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** The JSON document a built artefact carries, exactly the bytes the operator reads. */
function documentOf(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
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
  freezeFileSha256: string;
  requestFileSha256: string;
};

/** Builds the reviewed chain the way an operator does, with the freeze clock pinned. */
async function freezeChain(directory: string, designatedAt: string): Promise<Chain> {
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
    timeoutMs: 5_000,
    now: new Date(designatedAt),
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
    freezeFileSha256: digestOf(frozen.freeze_path),
    requestFileSha256: digestOf(frozen.approval_request_path),
  };
}

/** Every field the request digest covers. */
function requestCore(request: JsonObject): JsonObject {
  return {
    schema_version: request['schema_version'],
    approved_at_utc: request['approved_at_utc'],
    environment: request['environment'],
    project_ref: request['project_ref'],
    account: request['account'],
    plan_sha256: request['plan_sha256'],
    plan_file_sha256: request['plan_file_sha256'],
    freeze_file_sha256: request['freeze_file_sha256'],
    freeze_sha256: request['freeze_sha256'],
    expected: request['expected'],
  };
}

/**
 * The exact document a pre-binding freeze wrote: the same words and the digest over the core of
 * that time, with no designated approval time at all.
 */
function legacyRequestWithoutTime(request: JsonObject): JsonObject {
  const core = requestCore(request);
  delete core['approved_at_utc'];
  return {
    ...core,
    request_sha256: sha256Json(core),
    approval_text: request['approval_text'],
    approval_text_sha256: request['approval_text_sha256'],
  };
}

test('the freeze designates its injectable clock as the approval-request timestamp', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-approval-time-'));
  try {
    const chain = await freezeChain(directory, DESIGNATED_AT);
    const request = readArtifact(chain.requestPath);
    const text = readFileSync(chain.textPath, 'utf8');
    // The words a human approves carry the designated time, never the epoch placeholder.
    assert.doesNotMatch(text, /1970-01-01/u);
    assert.ok(text.includes(DESIGNATED_AT));
    assert.equal(readFileSync(chain.humanPath, 'utf8'), text);
    // The request carries exactly that one value, and the parse proves it is inside the digest.
    assert.equal(request['approved_at_utc'], DESIGNATED_AT);
    assert.equal(
      documentOf(parseAliasV2ApprovalRequest(request))['approved_at_utc'],
      DESIGNATED_AT,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the designated timestamp is part of the request identity', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const build = (approvedAtUtc: string): JsonObject =>
      documentOf(
        buildAliasV2ApprovalRequest({
          freeze: sealed.freeze,
          freezeFileSha256: sealed.freezeFileSha256,
          approvedAtUtc,
          profile: fixturePlanProfile(sealed.plan),
        }).value,
      );
    const designated = build(DESIGNATED_AT);
    const other = build(OTHER_AT);
    // Two requests over the same freeze differ only in their designated time, and both the identity
    // and the approved words move with it.
    assert.notEqual(other['request_sha256'], designated['request_sha256']);
    assert.notEqual(other['approval_text'], designated['approval_text']);
    // A request whose time was edited afterwards no longer matches its own digest.
    assert.throws(
      () => parseAliasV2ApprovalRequest({ ...designated, approved_at_utc: OTHER_AT }),
      (error: unknown) => codeOf(error) === ARTIFACT_INVALID,
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('a designated timestamp that is absent or not canonical is refused', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const request = documentOf(
      buildAliasV2ApprovalRequest({
        freeze: sealed.freeze,
        freezeFileSha256: sealed.freezeFileSha256,
        approvedAtUtc: DESIGNATED_AT,
        profile: fixturePlanProfile(sealed.plan),
      }).value,
    );
    // A request written before the binding designated no timestamp at all: it is refused by name
    // rather than re-read as if the value had always been there.
    const legacy = legacyRequestWithoutTime(request);
    assert.throws(
      () => parseAliasV2ApprovalRequest(legacy),
      (error: unknown) => codeOf(error) === REQUEST_UNBOUND_TIME,
    );
    for (const value of [5, null, '', 'not-a-time', '2026-09-22', '2026-09-22T06:30:00Z']) {
      assert.throws(
        () => parseAliasV2ApprovalRequest({ ...request, approved_at_utc: value }),
        (error: unknown) => codeOf(error) === TIME_INVALID,
        `the designated time ${JSON.stringify(value)} must be refused`,
      );
    }
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the same approved request cannot be sealed with another timestamp', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const request = buildAliasV2ApprovalRequest({
      freeze: sealed.freeze,
      freezeFileSha256: sealed.freezeFileSha256,
      approvedAtUtc: DESIGNATED_AT,
      profile: fixturePlanProfile(sealed.plan),
    });
    const requestFileSha256 = sha256Json(request.value);
    const seal = (approvedAtUtc: string): JsonObject =>
      documentOf(
        sealAliasV2Approval({
          request: request.value,
          requestFileSha256,
          humanApprovalText: request.value.approval_text,
          approvals: {
            plan: request.value.plan_sha256,
            freeze: request.value.freeze_sha256,
            request: requestFileSha256,
            text: request.value.approval_text_sha256,
          },
          confirm: ALIAS_V2_TEST_ACCOUNT.email,
          approvedAtUtc,
        }).value,
      );
    const designated = seal(DESIGNATED_AT);
    assert.equal(designated['approved_at_utc'], DESIGNATED_AT);
    // The exact reseal is the same identity; another instant, or another spelling of an instant,
    // is refused before any approval exists.
    assert.equal(
      seal(DESIGNATED_AT)['approval_identity_sha256'],
      designated['approval_identity_sha256'],
    );
    for (const changed of [OTHER_AT, '', '2026-09-22T06:30:00Z', '2026-09-22']) {
      assert.throws(
        () => seal(changed),
        (error: unknown) => codeOf(error) === TIME_MISMATCH || codeOf(error) === TIME_INVALID,
        `sealing at ${changed} must be refused`,
      );
    }
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('a self-consistent re-timed request cannot keep the words a human approved', () => {
  const sealed = sealedAliasV2Execution();
  try {
    const request = documentOf(
      buildAliasV2ApprovalRequest({
        freeze: sealed.freeze,
        freezeFileSha256: sealed.freezeFileSha256,
        approvedAtUtc: DESIGNATED_AT,
        profile: fixturePlanProfile(sealed.plan),
      }).value,
    );
    // The attack: rewrite the designated time and recompute the request digest — it is not secret —
    // while the words the human approved, and their hash, stay byte-identical. The tampered
    // request is self-consistent on both digests; only the words still name the old time.
    const retimed: JsonObject = { ...request, approved_at_utc: OTHER_AT };
    retimed['request_sha256'] = sha256Json(requestCore(retimed));
    assert.equal(retimed['request_sha256'], sha256Json(requestCore(retimed)));
    assert.equal(retimed['approval_text'], request['approval_text']);
    assert.equal(retimed['approval_text_sha256'], request['approval_text_sha256']);
    assert.throws(
      () => parseAliasV2ApprovalRequest(retimed),
      (error: unknown) => codeOf(error) === TEXT_MISMATCH,
      'the approved words must be the canonical rendering of the designated time',
    );
    // The words are the canonical rendering of the request's own facts or they are refused: the
    // capability phrase is one of the two reviewed spellings, never free text.
    const foreignText = String(request['approval_text']).replace(
      'Approved Time alias v2 plan',
      'Approved Time alias v2 plan (re-timed)',
    );
    const foreign: JsonObject = { ...request, approval_text: foreignText };
    foreign['approval_text_sha256'] = sha256Text(foreignText);
    foreign['request_sha256'] = sha256Json(requestCore(foreign));
    assert.throws(
      () => parseAliasV2ApprovalRequest(foreign),
      (error: unknown) => codeOf(error) === TEXT_MISMATCH,
    );
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});

test('the public seal stage reuses the designated timestamp and refuses every other', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-approval-seal-'));
  try {
    const chain = await freezeChain(directory, DESIGNATED_AT);
    const request = readArtifact(chain.requestPath);
    const seal = (
      overrides: JsonObject = {},
    ): { approval_path: string; approval_identity_sha256: string } =>
      sealAliasV2ProtectedApproval({
        freezePath: chain.freezePath,
        approvalRequestPath: chain.requestPath,
        humanApprovalPath: chain.humanPath,
        outDir: directory,
        approveFreezeFile: chain.freezeFileSha256,
        approveRequest: chain.requestFileSha256,
        approveText: String(request['approval_text_sha256']),
        confirm: ALIAS_V2_TEST_ACCOUNT.email,
        approvedAtUtc: DESIGNATED_AT,
        ...overrides,
      } as Parameters<typeof sealAliasV2ProtectedApproval>[0]);
    const sealed = seal();
    const approval = readArtifact(sealed.approval_path);
    assert.equal(approval['approved_at_utc'], DESIGNATED_AT);
    assert.equal(sealed.approval_identity_sha256, approval['approval_identity_sha256']);
    assert.throws(
      () => seal({ approvedAtUtc: OTHER_AT }),
      (error: unknown) => codeOf(error) === TIME_MISMATCH,
      'a re-timed seal must be refused',
    );
    // A pre-binding request fails closed on its own message instead of silently taking a new time.
    const legacyPath = path.join(directory, 'legacy-request.json');
    write(legacyPath, legacyRequestWithoutTime(request));
    assert.throws(
      () =>
        seal({
          approvalRequestPath: legacyPath,
          approveRequest: digestOf(legacyPath),
        }),
      (error: unknown) => codeOf(error) === REQUEST_UNBOUND_TIME,
      'a request without the designated time must be refused',
    );
    // The self-consistent re-timed request is refused at the seal boundary too: even when the
    // operator passes exactly the new time it carries, the untouched words still name the old one.
    const retimed: JsonObject = { ...request, approved_at_utc: OTHER_AT };
    retimed['request_sha256'] = sha256Json(requestCore(retimed));
    const retimedPath = path.join(directory, 'retimed-request.json');
    write(retimedPath, retimed);
    assert.throws(
      () =>
        seal({
          approvalRequestPath: retimedPath,
          approveRequest: digestOf(retimedPath),
          approvedAtUtc: OTHER_AT,
        }),
      (error: unknown) => codeOf(error) === TEXT_MISMATCH,
      'a re-timed request must not mint a second identity',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an approval sealed before this binding still parses and still binds its execution', () => {
  const sealed = sealedAliasV2Execution();
  try {
    // The pre-binding seal recorded its own independent approval time; the approval document has no
    // link back to the request, so such a seal stays a complete, parseable approval.
    const legacy = readArtifact(sealed.approvalPath);
    legacy['approved_at_utc'] = '2026-01-05T00:00:00.000Z';
    legacy['approval_identity_sha256'] = sha256Json({
      ...legacy,
      approval_identity_sha256: undefined,
    });
    const approval = parseAliasV2Approval(legacy);
    assert.equal(approval.approved_at_utc, '2026-01-05T00:00:00.000Z');
    const identity = assertAliasV2Bindings({
      plan: sealed.plan,
      planFileSha256: sealed.planFileSha256,
      freeze: sealed.freeze,
      freezeFileSha256: sealed.freezeFileSha256,
      approval,
      approvalFileSha256: sha256Json(legacy),
      approveExecution: String(legacy['approval_identity_sha256']),
    });
    assert.equal(identity.bindings['approval_identity_sha256'], legacy['approval_identity_sha256']);
  } finally {
    rmSync(sealed.directory, { recursive: true, force: true });
  }
});
