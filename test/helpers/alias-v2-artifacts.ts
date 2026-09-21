// Builds the sealed v2 artefacts a protected run consumes, exactly the way the public workflow
// builds them: the plan document, the freeze with its eight sets, the approval request and the
// sealed approval, each written as canonical bytes into a private directory.

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sha256Json,
  stableJsonText,
  type JsonObject,
} from '../../src/lib/dataset-maintenance-contract.js';
import { buildAliasV2Plan } from '../../src/lib/dataset-alias-v2-plan.js';
import {
  ALIAS_V2_FREEZE_SETS,
  ALIAS_V2_PROTECTED_ARTIFACTS,
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  sealAliasV2Approval,
  type AliasV2Freeze,
} from '../../src/lib/dataset-alias-v2-protected.js';
import {
  buildAliasV2ExecutionIdentity,
  type AliasV2ExecutionIdentity,
} from '../../src/lib/dataset-alias-v2-protected-contract.js';
import { buildAliasV2CohortInput } from '../fixtures/alias-v2-cohort.js';

export const ALIAS_V2_TEST_ACCOUNT = {
  user_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
  email: 'fixture-owner@example.invalid',
};
export const ALIAS_V2_TEST_PROJECT_REF = 'qgzvkongdjqiiamzbbts';
export const ALIAS_V2_TEST_APPROVED_AT = '2026-09-21T00:00:00.000Z';

export type SealedAliasV2Execution = {
  directory: string;
  planPath: string;
  freezePath: string;
  approvalPath: string;
  plan: JsonObject;
  freeze: AliasV2Freeze;
  freezeFileSha256: string;
  approvalFileSha256: string;
  approveExecution: string;
  identity: AliasV2ExecutionIdentity;
};

export function aliasV2Sets(planSha256: unknown): JsonObject {
  return Object.fromEntries(
    ALIAS_V2_FREEZE_SETS.map((key) => [key, sha256Json({ key, plan: planSha256 })]),
  );
}

export function aliasV2DerivativeTargets(plan: JsonObject, userId: string): JsonObject[] {
  const actions = plan['actions'] as JsonObject[];
  return actions.map((action) => ({
    table: action['table'],
    id: action['id'],
    version: action['version'],
    user_id: userId,
    state_code: 0,
    baseline_snapshot_sha256: sha256Json({ baseline: action['id'] }),
  }));
}

function writeCanonical(filePath: string, value: unknown): string {
  const text = `${stableJsonText(value)}\n`;
  writeFileSync(filePath, text, { mode: 0o600 });
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Seals one complete execution on disk and returns the paths, the artefacts and the identity the
 * run derives from them.
 */
export function sealedAliasV2Execution(): SealedAliasV2Execution {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'alias-v2-sealed-'));
  chmodSync(directory, 0o700);
  const plan = buildAliasV2Plan(buildAliasV2CohortInput()).plan;
  const planPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
  const planFileSha256 = writeCanonical(planPath, plan);

  const freezeArtifact = buildAliasV2Freeze({
    plan,
    planFileSha256,
    projectRef: ALIAS_V2_TEST_PROJECT_REF,
    account: ALIAS_V2_TEST_ACCOUNT,
    sets: aliasV2Sets(plan['plan_sha256']),
    derivativeTargets: aliasV2DerivativeTargets(plan, ALIAS_V2_TEST_ACCOUNT.user_id),
    expectedClosure: { roots: 6, references: 33 },
  });
  const freezePath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.freeze);
  const freezeFileSha256 = writeCanonical(freezePath, freezeArtifact.value);

  const requestArtifact = buildAliasV2ApprovalRequest({
    freeze: freezeArtifact.value,
    freezeFileSha256,
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
  });
  const requestPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request);
  const requestFileSha256 = writeCanonical(requestPath, requestArtifact.value);
  const humanApprovalPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.human_approval);
  writeFileSync(humanApprovalPath, requestArtifact.value.approval_text, { mode: 0o600 });

  const approvalArtifact = sealAliasV2Approval({
    request: requestArtifact.value,
    requestFileSha256,
    humanApprovalText: requestArtifact.value.approval_text,
    approvals: {
      plan: requestArtifact.value.plan_sha256,
      freeze: requestArtifact.value.freeze_sha256,
      request: requestFileSha256,
      text: requestArtifact.value.approval_text_sha256,
    },
    confirm: ALIAS_V2_TEST_ACCOUNT.email,
    approvedAtUtc: ALIAS_V2_TEST_APPROVED_AT,
  });
  const approvalPath = path.join(directory, ALIAS_V2_PROTECTED_ARTIFACTS.approval);
  const approvalFileSha256 = writeCanonical(approvalPath, approvalArtifact.value);

  const identity = buildAliasV2ExecutionIdentity({
    freeze: freezeArtifact.value,
    approval: approvalArtifact.value,
    freezeFileSha256,
    approvalFileSha256,
  });
  return {
    directory,
    planPath,
    freezePath,
    approvalPath,
    plan,
    freeze: freezeArtifact.value,
    freezeFileSha256,
    approvalFileSha256,
    approveExecution: approvalArtifact.value.approval_identity_sha256,
    identity,
  };
}
