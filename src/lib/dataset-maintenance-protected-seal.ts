import path from 'node:path';
import {
  readProtectedJsonArtifact,
  readProtectedTextArtifact,
  materializePrivateArtifactDirectoryAtomically,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from './dataset-maintenance-protected-artifacts.js';
import { sha256Text, stableJsonText } from './canonical-json-hash.js';
import { parseProtectedFreeze } from './dataset-maintenance-protected-contract.js';
import {
  assertProtectedProductionProjectRef,
  parseProtectedApprovalRequest,
  sealProtectedApproval,
} from './dataset-maintenance-protected-preparation.js';
import { CliError } from '../shared/errors.js';

export const PROTECTED_APPROVAL_SEAL_ARTIFACTS = {
  human_approval_text: 'protected-human-approval.txt',
  approval: 'protected-approval.json',
  report: 'protected-approval-seal-report.json',
} as const;

export type SealDatasetMaintenanceProtectedApprovalOptions = {
  freezePath: string;
  approvalRequestPath: string;
  humanApprovalPath: string;
  outDir: string;
  approveFreezeFile: string;
  approveRequest: string;
  approveText: string;
  confirm: string;
  approvedAtUtc: string;
  now?: Date;
};

export type DatasetMaintenanceProtectedApprovalSealReport = {
  schema_version: 'dataset-alias-protected-approval-seal-report.v1';
  generated_at_utc: string;
  approval_authority_at_utc: string;
  status: 'sealed';
  execution_submitted: false;
  environment: 'production';
  project_ref: string;
  account: { user_id: string; email: string };
  plan_sha256: string;
  operation_id: string;
  freeze_file_sha256: string;
  freeze_sha256: string;
  approval_request_file_sha256: string;
  approval_request_sha256: string;
  approval_text_sha256: string;
  approval_file_sha256: string;
  approval_identity_sha256: string;
  assertions: {
    byte_exact_human_text: true;
    explicit_freeze_file_hash: true;
    explicit_request_hash: true;
    explicit_text_hash: true;
    explicit_account_confirmation: true;
    authentication_calls: 0;
    network_calls: 0;
    database_calls: 0;
    preflight_calls: 0;
    gate_calls: 0;
    admission_calls: 0;
    execution_calls: 0;
  };
  artifacts: {
    human_approval_text: string;
    approval: string;
    report: string;
  };
  artifact_sha256: {
    human_approval_text: string;
    approval: string;
    report: null;
  };
};

type SealProtectedDependencies = {
  readJson: typeof readProtectedJsonArtifact;
  readText: typeof readProtectedTextArtifact;
  parseFreeze: typeof parseProtectedFreeze;
  parseApprovalRequest: typeof parseProtectedApprovalRequest;
  sealApproval: typeof sealProtectedApproval;
  writeJson: typeof writePrivateImmutableJson;
  writeText: typeof writePrivateImmutableText;
  materializeArtifacts: typeof materializePrivateArtifactDirectoryAtomically;
};

const DEFAULT_SEAL_DEPENDENCIES: SealProtectedDependencies = {
  readJson: readProtectedJsonArtifact,
  readText: readProtectedTextArtifact,
  parseFreeze: parseProtectedFreeze,
  parseApprovalRequest: parseProtectedApprovalRequest,
  sealApproval: sealProtectedApproval,
  writeJson: writePrivateImmutableJson,
  writeText: writePrivateImmutableText,
  materializeArtifacts: materializePrivateArtifactDirectoryAtomically,
};

const SHA256 = /^[a-f0-9]{64}$/u;

function requiredToken(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw new CliError(`${label} must be a non-empty canonical string.`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_SEAL_INPUT_INVALID',
      exitCode: 2,
    });
  }
  return value;
}

function requiredHash(value: string, label: string): string {
  const token = requiredToken(value, label);
  if (!SHA256.test(token)) {
    throw new CliError(`${label} must be a lowercase SHA-256 digest.`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_SEAL_INPUT_INVALID',
      exitCode: 2,
    });
  }
  return token;
}

function assertCanonicalJsonArtifact(options: {
  label: string;
  text: string;
  value: unknown;
}): void {
  if (options.text !== `${stableJsonText(options.value)}\n`) {
    throw new CliError(`${options.label} must be canonical JSON with one final newline.`, {
      code: 'DATASET_MAINTENANCE_PROTECTED_SEAL_NONCANONICAL',
      exitCode: 2,
    });
  }
}

function artifactPaths(outDir: string): DatasetMaintenanceProtectedApprovalSealReport['artifacts'] {
  const resolved = path.resolve(outDir);
  return Object.fromEntries(
    Object.entries(PROTECTED_APPROVAL_SEAL_ARTIFACTS).map(([key, name]) => [
      key,
      path.join(resolved, name),
    ]),
  ) as DatasetMaintenanceProtectedApprovalSealReport['artifacts'];
}

export async function sealDatasetMaintenanceProtectedApproval(
  options: SealDatasetMaintenanceProtectedApprovalOptions,
  dependencies: SealProtectedDependencies = DEFAULT_SEAL_DEPENDENCIES,
): Promise<DatasetMaintenanceProtectedApprovalSealReport> {
  const freezePath = requiredToken(options.freezePath, 'freezePath');
  const approvalRequestPath = requiredToken(options.approvalRequestPath, 'approvalRequestPath');
  const humanApprovalPath = requiredToken(options.humanApprovalPath, 'humanApprovalPath');
  const outDir = requiredToken(options.outDir, 'outDir');
  const approveFreezeFile = requiredHash(options.approveFreezeFile, 'approveFreezeFile');
  const approveRequest = requiredHash(options.approveRequest, 'approveRequest');
  const approveText = requiredHash(options.approveText, 'approveText');
  const confirm = requiredToken(options.confirm, 'confirm');
  const approvedAtUtc = requiredToken(options.approvedAtUtc, 'approvedAtUtc');

  const freezeArtifact = dependencies.readJson({
    filePath: freezePath,
    label: 'Protected execution freeze',
  });
  const freeze = dependencies.parseFreeze(freezeArtifact.value);
  assertProtectedProductionProjectRef(freeze.project_ref);
  assertCanonicalJsonArtifact({
    label: 'Protected execution freeze',
    text: freezeArtifact.text,
    value: freeze,
  });
  if (approveFreezeFile !== freezeArtifact.file_sha256) {
    throw new CliError('Explicit freeze file hash does not match the supplied freeze bytes.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_SEAL_FREEZE_MISMATCH',
      exitCode: 1,
    });
  }

  const requestArtifact = dependencies.readJson({
    filePath: approvalRequestPath,
    label: 'Protected approval request',
  });
  const request = dependencies.parseApprovalRequest(requestArtifact.value);
  assertCanonicalJsonArtifact({
    label: 'Protected approval request',
    text: requestArtifact.text,
    value: request,
  });
  const humanApproval = dependencies.readText(humanApprovalPath);
  const approval = dependencies.sealApproval({
    approvalRequest: request,
    freeze,
    freezeFileSha256: freezeArtifact.file_sha256,
    humanApprovalText: humanApproval.text,
    approveRequestSha256: approveRequest,
    approveTextSha256: approveText,
    approvedAtUtc,
    confirmAccountEmail: confirm,
  });
  const paths = artifactPaths(outDir);
  const report: DatasetMaintenanceProtectedApprovalSealReport = {
    schema_version: 'dataset-alias-protected-approval-seal-report.v1',
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    approval_authority_at_utc: approvedAtUtc,
    status: 'sealed',
    execution_submitted: false,
    environment: 'production',
    project_ref: freeze.project_ref,
    account: freeze.account,
    plan_sha256: freeze.plan.plan_sha256,
    operation_id: freeze.plan.operation_id,
    freeze_file_sha256: freezeArtifact.file_sha256,
    freeze_sha256: freeze.freeze_sha256,
    approval_request_file_sha256: requestArtifact.file_sha256,
    approval_request_sha256: request.request_sha256,
    approval_text_sha256: request.approval_text_sha256,
    approval_file_sha256: approval.file_sha256,
    approval_identity_sha256: approval.value.approval_identity_sha256,
    assertions: {
      byte_exact_human_text: true,
      explicit_freeze_file_hash: true,
      explicit_request_hash: true,
      explicit_text_hash: true,
      explicit_account_confirmation: true,
      authentication_calls: 0,
      network_calls: 0,
      database_calls: 0,
      preflight_calls: 0,
      gate_calls: 0,
      admission_calls: 0,
      execution_calls: 0,
    },
    artifacts: paths,
    artifact_sha256: {
      human_approval_text: sha256Text(humanApproval.text),
      approval: approval.file_sha256,
      report: null,
    },
  };
  dependencies.materializeArtifacts(outDir, (stagingDirectory) => {
    const staging = artifactPaths(stagingDirectory);
    dependencies.writeText(staging.human_approval_text, humanApproval.text);
    dependencies.writeText(staging.approval, approval.canonical_file_text);
    dependencies.writeJson(staging.report, report);
  });
  return report;
}

export const __testInternals = {
  DEFAULT_SEAL_DEPENDENCIES,
  artifactPaths,
  assertCanonicalJsonArtifact,
  requiredHash,
  requiredToken,
};
