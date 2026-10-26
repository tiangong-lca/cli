import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveFlowIdentityApprovalClaimRoot } from './dataset-maintenance-flow-identity-approval-claim.js';
import { sha256Json, stableJsonText } from './dataset-maintenance-contract.js';
import {
  prepareFail,
  prepareObject,
  type PrepareEnvelope,
} from './dataset-prepare-draft-contract.js';

export function prepareAttemptPath(env: NodeJS.ProcessEnv, envelope: PrepareEnvelope): string {
  return path.join(
    resolveFlowIdentityApprovalClaimRoot({ env }),
    'execution-ledgers',
    'dataset-prepare-draft',
    'v1',
    sha256Json({ project_ref: envelope.project_ref, actor: envelope.request.expectedActorId }),
    `${envelope.requestId}.json`,
  );
}
export function readPrepareAttempt(file: string, envelope: PrepareEnvelope): boolean {
  if (!existsSync(file)) return false;
  const stat = lstatSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
    prepareFail(
      'Preparation attempt must be a private regular file.',
      'DATASET_PREPARE_DRAFT_ATTEMPT_INVALID',
    );
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !prepareObject(value) ||
    value.schema_version !== 'dataset-prepare-draft-attempt.v1' ||
    value.request_sha256 !== sha256Json(envelope)
  )
    prepareFail(
      'Original preparation attempt binds a different or malformed request.',
      'REQUEST_ID_REUSED',
    );
  return true;
}
export function claimPrepareAttempt(
  file: string,
  envelope: PrepareEnvelope,
  outDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (prepareObject(error) && error.code === 'EEXIST') {
      readPrepareAttempt(file, envelope);
      return false;
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${stableJsonText({ schema_version: 'dataset-prepare-draft-attempt.v1', request_sha256: sha256Json(envelope), request: envelope, original_out_dir: outDir })}\n`,
      'utf8',
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (platform !== 'win32') {
    const directoryDescriptor = openSync(path.dirname(file), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
  return true;
}
