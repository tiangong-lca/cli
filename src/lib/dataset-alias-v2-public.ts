// The public v2 workflow stages: plan, freeze and seal for the versioned Time alias capability.
//
// These are the operators' entry points, so they are strict for the same reasons the run is:
// the planning input is validated by the plan builder itself, the freeze derives every binding
// from the artefacts it is given (never from a self-asserted hash), and the seal refuses to
// produce an approval unless the explicit hashes, the freeze bytes and the human approval text
// all agree with the request.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
  readProtectedTextArtifact,
  writePrivateImmutableJson,
} from './dataset-maintenance-protected-artifacts.js';
import {
  isJsonObject,
  sha256Json,
  sha256Text,
  stableJsonText,
  type JsonObject,
} from './dataset-maintenance-contract.js';
import { assertProtectedProductionProjectRef } from './dataset-maintenance-protected-preparation.js';
import { parseProtectedToolchainEvidence } from './dataset-maintenance-protected-toolchain.js';
import { resolveMaintenanceRemoteContext } from './dataset-maintenance-remote.js';
import type { FetchLike } from './http.js';
import { buildAliasV2Plan, type AliasV2PlanInput } from './dataset-alias-v2-plan.js';
import {
  ALIAS_V2_PROTECTED_ARTIFACTS,
  assertAliasV2CanonicalArtifact,
  assertProtectedPlanDocument,
  buildAliasV2ApprovalRequest,
  buildAliasV2Freeze,
  parseAliasV2ApprovalRequest,
  parseAliasV2Freeze,
  sealAliasV2Approval,
  type ProtectedPlanProfile,
} from './dataset-alias-v2-protected.js';
import { lengthTimeTargetSnapshots, protectedPlanProfile } from './dataset-length-time-plan.js';
import { CliError } from './errors.js';

type JsonValue = JsonObject;

const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message: string, code: string, exitCode = 2): never {
  throw new CliError(message, { code, exitCode });
}
function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a lowercase sha256.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
  }
  return value;
}
function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
  }
  return value;
}
function canonical(value: unknown): string {
  return `${stableJsonText(value)}\n`;
}
function writeArtifact(filePath: string, value: unknown): string {
  const text = canonical(value);
  writeFileSync(filePath, text, { mode: 0o600 });
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
function readJson(
  filePath: string,
  label: string,
): { value: JsonObject; text: string; file_sha256: string } {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (!isJsonObject(artifact.value)) {
    fail(`${label} must be a JSON object.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
  }
  return { value: artifact.value, text: artifact.text, file_sha256: artifact.file_sha256 };
}

/**
 * Builds the versioned science plan from a frozen planning input. The input is the reviewed
 * alias-plan input document; the builder refuses anything outside the reviewed shape, so a
 * malformed or ineligible cohort never becomes a plan artefact.
 */
export function planAliasV2(options: { inputPath: string; outDir: string }): {
  plan_path: string;
  batch_path: string;
  plan_sha256: string;
  expected: JsonObject;
} {
  const input = readJson(options.inputPath, 'Alias v2 planning input');
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const { plan, batch } = buildAliasV2Plan(input.value as unknown as AliasV2PlanInput);
  const planPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.plan_file);
  const batchPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.batch_file);
  writeArtifact(planPath, plan);
  writeArtifact(batchPath, batch);
  return {
    plan_path: planPath,
    batch_path: batchPath,
    plan_sha256: plan['plan_sha256'] as string,
    expected: plan['expected'] as JsonObject,
  };
}

/**
 * The eight bindings the freeze carries, every one of them recomputed here from the artefacts
 * and the plan content: none of them is taken from a caller-supplied value. The profile is read
 * from the plan's own closed discriminator, so each profile's support set covers exactly the
 * frozen snapshots that plan binds.
 */
export function deriveAliasV2Sets(options: {
  plan: JsonObject;
  derivativeTargets: JsonValue[];
  toolchainEvidenceSha256: string;
}): JsonObject {
  const actions = options.plan['actions'] as JsonObject[];
  const supportSnapshots =
    protectedPlanProfile(options.plan) === 'length_time_v1'
      ? {
          // The read-only flow snapshots and the two canonical targets of the Length profile.
          flow_snapshots: options.plan['flow_snapshots'],
          target_snapshots: lengthTimeTargetSnapshots(options.plan),
        }
      : {
          source_flowproperty: (options.plan['source_evidence'] as JsonObject)[
            'source_flowproperty'
          ],
          declared_source_unitgroup: (options.plan['source_evidence'] as JsonObject)[
            'declared_source_unitgroup'
          ],
          target_snapshots: options.plan['target_snapshots'],
        };
  return {
    // The plan document itself is the alias plan request of this versioned capability.
    alias_plan_request_sha256: sha256Json({ ...options.plan, plan_sha256: undefined }),
    before_hash_set_sha256: sha256Json(
      actions
        .map((action) => String(action['before_sha256']))
        .sort((left, right) => left.localeCompare(right)),
    ),
    desired_hash_set_sha256: sha256Json(
      actions
        .map((action) => String(action['desired_sha256']))
        .sort((left, right) => left.localeCompare(right)),
    ),
    exchange_rewrite_set_sha256: sha256Json(
      actions
        .filter((action) => action['table'] === 'processes')
        .map((action) => (action['mutation'] as JsonObject)['exchanges']),
    ),
    // The frozen support snapshots the plan binds: for the Time profile the complete locked SOURCE
    // flow property (its identity and full payload digest), the currently declared source unit group
    // and the locked target snapshots — a name-only change to the source row changes this set; for
    // the Length profile the read-only flow snapshots and the two canonical targets.
    support_snapshot_set_sha256: sha256Json(supportSnapshots),
    derivative_baseline_set_sha256: sha256Json(
      options.derivativeTargets
        .map((target) => String(target['baseline_snapshot_sha256']))
        .sort((left, right) => left.localeCompare(right)),
    ),
    derivative_target_set_sha256: sha256Json(
      options.derivativeTargets
        .map(
          (target) =>
            `${String(target['table'])}:${String(target['id'])}@${String(target['version'])}`,
        )
        .sort((left, right) => left.localeCompare(right)),
    ),
    toolchain_evidence_sha256: hash(options.toolchainEvidenceSha256, 'toolchain_evidence_sha256'),
  };
}

/** Parses the frozen derivative baseline list and proves it covers the plan's own rows. */
export function parseAliasV2DerivativeBaselines(value: unknown, plan: JsonObject): JsonValue[] {
  if (
    !isJsonObject(value) ||
    value['schema_version'] !== 'dataset-alias-derivative-baselines.v2' ||
    !Array.isArray(value['targets'])
  ) {
    fail(
      'Alias v2 derivative baselines must be a dataset-alias-derivative-baselines.v2 document.',
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
    );
  }
  const targets = value['targets'] as JsonValue[];
  const expected = new Set(
    (plan['actions'] as JsonObject[]).map(
      (action) => `${String(action['table'])}:${String(action['id'])}@${String(action['version'])}`,
    ),
  );
  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (!isJsonObject(target)) {
      fail(`baselines.targets[${index}] must be an object.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
    }
    const key = `${String(target['table'])}:${String(target['id'])}@${String(target['version'])}`;
    if (!expected.has(key)) {
      fail(
        `baselines.targets[${index}] does not belong to this plan.`,
        'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
      );
    }
    if (seen.has(key)) {
      fail(`baselines.targets[${index}] repeats a plan row.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
    }
    seen.add(key);
    hash(
      target['baseline_snapshot_sha256'],
      `baselines.targets[${index}].baseline_snapshot_sha256`,
    );
    if (target['state_code'] !== 0) {
      fail(`baselines.targets[${index}].state_code must be 0.`, 'ALIAS_V2_PUBLIC_ARTIFACT_INVALID');
    }
  }
  if (seen.size !== expected.size) {
    fail(
      'Alias v2 derivative baselines must cover every row this plan touches.',
      'ALIAS_V2_PUBLIC_ARTIFACT_INVALID',
    );
  }
  return targets;
}

/**
 * Builds the freeze and the approval request from the plan, the toolchain evidence and the
 * frozen derivative baselines. The project must be the production project: this capability is
 * not offered anywhere else.
 */
export async function freezeAliasV2Protected(options: {
  planPath: string;
  toolchainEvidencePath: string;
  derivativeBaselinesPath: string;
  outDir: string;
  expectedProjectRef: string;
  confirm: string;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): Promise<{
  freeze_path: string;
  approval_request_path: string;
  approval_text_path: string;
  freeze_sha256: string;
  approval_request_sha256: string;
}> {
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const planArtifact = readJson(options.planPath, 'Alias v2 plan');
  assertAliasV2CanonicalArtifact({
    label: 'Alias v2 plan',
    text: planArtifact.text,
    value: planArtifact.value,
  });
  // The plan's own closed discriminator selects the profile for every later binding: a Length plan
  // freezes under the Length rule set, and a foreign document is refused before any remote work.
  const { profile } = assertProtectedPlanDocument(planArtifact.value);
  const projectRef = assertProtectedProductionProjectRef(options.expectedProjectRef);
  const accountEmail = token(options.confirm, 'confirm');

  // The freeze is built under the authenticated owner's own context: the sealed account is the
  // one the session proves, never a value the operator types into a file.
  const context = await resolveMaintenanceRemoteContext({
    env: options.env,
    fetchImpl: options.fetchImpl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (
    context.project_ref !== projectRef ||
    context.account.email !== accountEmail ||
    context.account.user_id.trim() === ''
  ) {
    fail(
      'Alias v2 freeze requires the authenticated owner account and the production project.',
      'DATASET_MAINTENANCE_PROTECTED_CONTEXT_MISMATCH',
      1,
    );
  }

  const toolchainArtifact = readJson(options.toolchainEvidencePath, 'Protected toolchain evidence');
  parseProtectedToolchainEvidence(toolchainArtifact.value, {
    projectRef,
    cliVersion: options.cliVersion,
  });
  const baselinesArtifact = readJson(
    options.derivativeBaselinesPath,
    'Alias v2 derivative baselines',
  );
  const derivativeTargets = parseAliasV2DerivativeBaselines(
    baselinesArtifact.value,
    planArtifact.value,
  );

  const freezeArtifact = buildAliasV2Freeze({
    plan: planArtifact.value,
    planFileSha256: planArtifact.file_sha256,
    projectRef,
    account: { user_id: context.account.user_id, email: context.account.email },
    sets: deriveAliasV2Sets({
      plan: planArtifact.value,
      derivativeTargets,
      toolchainEvidenceSha256: toolchainArtifact.file_sha256,
    }),
    derivativeTargets,
  });
  const freezePath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.freeze);
  const freezeFileSha256 = writeArtifact(freezePath, freezeArtifact.value);
  const approvalRequest = buildAliasV2ApprovalRequest({
    freeze: freezeArtifact.value,
    freezeFileSha256,
    approvedAtUtc: new Date(0).toISOString(),
    profile,
  });
  const requestPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.approval_request);
  writeArtifact(requestPath, approvalRequest.value);
  const textPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.approval_text);
  writeFileSync(textPath, approvalRequest.value.approval_text, { mode: 0o600 });
  // The human approval file is the same text: the operator approves exactly these words, and the
  // seal refuses any paraphrase.
  const humanApprovalPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.human_approval);
  writeFileSync(humanApprovalPath, approvalRequest.value.approval_text, { mode: 0o600 });
  writePrivateImmutableJson(path.join(outDir, 'protected-v2-freeze-report.json'), {
    schema_version: 'dataset-alias-execution-freeze-report.v2',
    plan_file_sha256: planArtifact.file_sha256,
    plan_sha256: planArtifact.value['plan_sha256'],
    freeze_file_sha256: freezeFileSha256,
    freeze_sha256: freezeArtifact.value.freeze_sha256,
    expected: freezeArtifact.value.expected,
    derivative_target_count: derivativeTargets.length,
    toolchain_evidence_sha256: toolchainArtifact.file_sha256,
    project_ref: projectRef,
  });
  return {
    freeze_path: freezePath,
    approval_request_path: requestPath,
    approval_text_path: textPath,
    freeze_sha256: freezeArtifact.value.freeze_sha256,
    approval_request_sha256: approvalRequest.value.request_sha256,
  };
}

/** Seals the approval from the freeze, the request and the human approval text. */
export function sealAliasV2ProtectedApproval(options: {
  freezePath: string;
  approvalRequestPath: string;
  humanApprovalPath: string;
  outDir: string;
  approveFreezeFile: string;
  approveRequest: string;
  approveText: string;
  confirm: string;
  approvedAtUtc: string;
}): { approval_path: string; approval_identity_sha256: string } {
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const freezeArtifact = readJson(options.freezePath, 'Alias v2 freeze');
  const freeze = parseAliasV2Freeze(freezeArtifact.value);
  assertAliasV2CanonicalArtifact({
    label: 'Alias v2 freeze',
    text: freezeArtifact.text,
    value: freeze,
  });
  assertProtectedProductionProjectRef(freeze.project_ref);
  if (hash(options.approveFreezeFile, 'approveFreezeFile') !== freezeArtifact.file_sha256) {
    fail(
      'Explicit freeze file hash does not match the supplied freeze bytes.',
      'ALIAS_V2_PUBLIC_SEAL_MISMATCH',
      1,
    );
  }
  const requestArtifact = readJson(options.approvalRequestPath, 'Alias v2 approval request');
  const request = parseAliasV2ApprovalRequest(requestArtifact.value);
  assertAliasV2CanonicalArtifact({
    label: 'Alias v2 approval request',
    text: requestArtifact.text,
    value: request,
  });
  if (request.freeze_file_sha256 !== freezeArtifact.file_sha256) {
    fail(
      'Alias v2 approval request does not bind the supplied freeze file.',
      'ALIAS_V2_PUBLIC_SEAL_MISMATCH',
      1,
    );
  }
  const humanApproval = readProtectedTextArtifact(options.humanApprovalPath);
  const approvalArtifact = sealAliasV2Approval({
    request,
    requestFileSha256: requestArtifact.file_sha256,
    humanApprovalText: humanApproval.text,
    approvals: {
      plan: request.plan_sha256,
      freeze: request.freeze_sha256,
      request: hash(options.approveRequest, 'approveRequest'),
      text: hash(options.approveText, 'approveText'),
    },
    confirm: options.confirm,
    approvedAtUtc: options.approvedAtUtc,
  });
  const approvalPath = path.join(outDir, ALIAS_V2_PROTECTED_ARTIFACTS.approval);
  writeArtifact(approvalPath, approvalArtifact.value);
  return {
    approval_path: approvalPath,
    approval_identity_sha256: approvalArtifact.value.approval_identity_sha256,
  };
}

export const __testInternals = { canonical, sha256Text };

/**
 * True when the named plan artefact is a versioned (v2) alias plan. An unreadable or foreign file
 * is not a v2 plan: it stays on the v1 path, which reports its own artefact error.
 */
export function isAliasV2PlanFile(planPath: string): boolean {
  try {
    return readJson(planPath, 'Alias v2 plan').value['schema_version'] === 'dataset-alias-plan.v2';
  } catch {
    return false;
  }
}

/**
 * The closed profile of the named plan artefact, or null when it is not a protected plan this
 * build understands. An unreadable or foreign file stays on the legacy path, which reports its own
 * artefact error rather than being silently reinterpreted here.
 */
export function protectedPlanFileProfile(planPath: string): ProtectedPlanProfile | null {
  try {
    return protectedPlanProfile(readJson(planPath, 'Protected plan').value);
  } catch {
    return null;
  }
}

/** True when the named seal is a versioned (v2) protected freeze. */
export function isAliasV2FreezeFile(freezePath: string): boolean {
  try {
    return (
      readJson(freezePath, 'Alias v2 freeze').value['schema_version'] ===
      'dataset-alias-execution-freeze.v2'
    );
  } catch {
    return false;
  }
}
