import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableJsonText } from './canonical-json-hash.js';
import { CliError } from '../shared/errors.js';

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const CLAIM_KEYS = [
  'schema_version',
  'claimed_at_utc',
  'approval_kind',
  'approval_identity_sha256',
  'execution_identity_sha256',
  'request_id',
  'environment',
  'project_ref',
  'actor_user_id',
  'actor_email',
  'target_visibility',
  'user_state_claim',
  'plan_sha256',
  'freeze_sha256',
  'canonical_out_dir',
  'maximum_cli_apply_spawns',
  'approval_reusable',
] as const;

export type FlowIdentityApprovalClaim = {
  schema_version: 'dataset-flow-identity-local-approval-claim.v1';
  claimed_at_utc: string;
  approval_kind: 'initial' | 'recovery';
  approval_identity_sha256: string;
  execution_identity_sha256: string;
  request_id: string;
  environment: 'production';
  project_ref: string;
  actor_user_id: string;
  actor_email: string;
  target_visibility: 'owner_draft';
  user_state_claim: 'authenticated_actor_state_100_plus_own_state_0';
  plan_sha256: string;
  freeze_sha256: string;
  canonical_out_dir: string;
  maximum_cli_apply_spawns: 1;
  approval_reusable: false;
};

function fail(message: string, code: string, details?: unknown): never {
  throw new CliError(message, { code, exitCode: 1, details });
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

function hasPrivateClaimPermissions(mode: number, platform: NodeJS.Platform): boolean {
  // Windows does not expose its ACLs through POSIX permission bits. The claim
  // still has to be a non-symlink regular file and is created exclusively below
  // the current user's state directory; enforce 0600-style bits where they are
  // meaningful.
  return platform === 'win32' || (mode & 0o077) === 0;
}

function rethrowClaimCreateError(error: unknown, claimPath: string): never {
  if (isErrno(error, 'EEXIST')) {
    fail(
      'This exact flow identity approval was already claimed by a CLI wrapper. Only read-only status or a newly frozen recovery approval is allowed.',
      'DATASET_FLOW_IDENTITY_APPROVAL_ALREADY_CLAIMED',
      { claim_path: claimPath },
    );
  }
  throw error;
}

function validateClaim(value: unknown, expectedIdentity: string): FlowIdentityApprovalClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'Existing flow identity approval claim is malformed or foreign.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
    );
  }
  const claim = value as Partial<FlowIdentityApprovalClaim>;
  const actualKeys = Object.keys(claim).sort();
  const expectedKeys = [...CLAIM_KEYS].sort();
  const claimedAt = String(claim.claimed_at_utc ?? '');
  const canonicalOutDir = String(claim.canonical_out_dir ?? '');
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    claim.schema_version !== 'dataset-flow-identity-local-approval-claim.v1' ||
    !Number.isFinite(Date.parse(claimedAt)) ||
    new Date(claimedAt).toISOString() !== claimedAt ||
    !['initial', 'recovery'].includes(String(claim.approval_kind)) ||
    claim.approval_identity_sha256 !== expectedIdentity ||
    ![
      claim.approval_identity_sha256,
      claim.execution_identity_sha256,
      claim.plan_sha256,
      claim.freeze_sha256,
    ].every((entry) => typeof entry === 'string' && HASH.test(entry)) ||
    typeof claim.request_id !== 'string' ||
    !UUID.test(claim.request_id) ||
    claim.environment !== 'production' ||
    typeof claim.project_ref !== 'string' ||
    !claim.project_ref.trim() ||
    typeof claim.actor_user_id !== 'string' ||
    !UUID.test(claim.actor_user_id) ||
    typeof claim.actor_email !== 'string' ||
    !EMAIL.test(claim.actor_email) ||
    claim.actor_email !== claim.actor_email.trim().toLowerCase() ||
    claim.target_visibility !== 'owner_draft' ||
    claim.user_state_claim !== 'authenticated_actor_state_100_plus_own_state_0' ||
    !path.isAbsolute(canonicalOutDir) ||
    path.resolve(canonicalOutDir) !== canonicalOutDir ||
    claim.maximum_cli_apply_spawns !== 1 ||
    claim.approval_reusable !== false
  ) {
    fail(
      'Existing flow identity approval claim is malformed or foreign.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
    );
  }
  return claim as FlowIdentityApprovalClaim;
}

export function resolveFlowIdentityApprovalClaimRoot(options: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const xdg = options.env.XDG_STATE_HOME?.trim();
  if (xdg) return path.resolve(xdg, 'tiangong-lca-cli');
  if (platform === 'win32') {
    const localAppData = options.env.LOCALAPPDATA?.trim();
    if (localAppData) return path.resolve(localAppData, 'tiangong-lca-cli');
  }
  if (homeDir.trim()) {
    return path.resolve(homeDir, '.local', 'state', 'tiangong-lca-cli');
  }
  if (platform === 'darwin') {
    return path.resolve(os.homedir(), 'Library', 'Application Support', 'tiangong-lca-cli');
  }
  return path.resolve('.tiangong-lca-cli-state');
}

export function flowIdentityApprovalClaimPath(options: {
  stateRoot: string;
  approvalIdentitySha256: string;
}): string {
  if (!HASH.test(options.approvalIdentitySha256)) {
    fail(
      'Flow identity approval claim requires a lowercase approval identity SHA-256.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_IDENTITY_INVALID',
    );
  }
  return path.join(
    path.resolve(options.stateRoot),
    'execution-approvals',
    'flow-identity',
    'v3',
    `${options.approvalIdentitySha256}.claim.json`,
  );
}

/** Strict create-only claim. Existing identical bytes are still consumed. */
export function claimFlowIdentityApproval(options: {
  claim: FlowIdentityApprovalClaim;
  env: NodeJS.ProcessEnv;
  stateRoot?: string;
}): string {
  validateClaim(options.claim, options.claim.approval_identity_sha256);
  const claimPath = flowIdentityApprovalClaimPath({
    stateRoot: options.stateRoot ?? resolveFlowIdentityApprovalClaimRoot({ env: options.env }),
    approvalIdentitySha256: options.claim.approval_identity_sha256,
  });
  const directory = path.dirname(claimPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = `${stableJsonText(options.claim)}\n`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(claimPath, 'wx', 0o600);
    writeFileSync(descriptor, bytes, 'utf8');
    fsyncSync(descriptor);
  } catch (error) {
    rethrowClaimCreateError(error, claimPath);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return claimPath;
}

export function readFlowIdentityApprovalClaim(options: {
  approvalIdentitySha256: string;
  env: NodeJS.ProcessEnv;
  stateRoot?: string;
}): FlowIdentityApprovalClaim | null {
  const claimPath = flowIdentityApprovalClaimPath({
    stateRoot: options.stateRoot ?? resolveFlowIdentityApprovalClaimRoot({ env: options.env }),
    approvalIdentitySha256: options.approvalIdentitySha256,
  });
  if (!existsSync(claimPath)) return null;
  const metadata = lstatSync(claimPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !hasPrivateClaimPermissions(metadata.mode, process.platform)
  ) {
    return fail(
      'Existing flow identity approval claim is not a private regular file.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
      { claim_path: claimPath },
    );
  }
  let text: string;
  let value: unknown;
  try {
    text = readFileSync(claimPath, 'utf8');
    value = JSON.parse(text);
  } catch {
    return fail(
      'Existing flow identity approval claim is unreadable.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
      { claim_path: claimPath },
    );
  }
  if (text !== `${stableJsonText(value)}\n`) {
    return fail(
      'Existing flow identity approval claim is not canonical JSON.',
      'DATASET_FLOW_IDENTITY_APPROVAL_CLAIM_INVALID',
      { claim_path: claimPath },
    );
  }
  return validateClaim(value, options.approvalIdentitySha256);
}

export const __testInternals = {
  hasPrivateClaimPermissions,
  isErrno,
  rethrowClaimCreateError,
  validateClaim,
};
