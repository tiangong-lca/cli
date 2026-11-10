import { isJsonObject } from './maintenance/contract/values.js';
import { CliError } from '../shared/errors.js';
import { cliRepositoryIdentity, type CliRepositoryIdentity } from './cli-repository-identity.js';

export const PROTECTED_TOOLCHAIN_EVIDENCE_SCHEMA =
  'dataset-alias-protected-toolchain-evidence.v1' as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const WORKSPACE_ISSUE = /^https:\/\/github\.com\/tiangong-lca\/workspace\/issues\/\d+$/u;

export type DatasetMaintenanceProtectedToolchainEvidence = {
  schema_version: typeof PROTECTED_TOOLCHAIN_EVIDENCE_SCHEMA;
  environment: 'production';
  project_ref: string;
  verified_at_utc: string;
  database_engine: {
    repository: 'tiangong-lca/database-engine' | 'tiangong-lca/database';
    production_main_commit_sha: string;
    production_readback_evidence_sha256: string;
    status: 'released_and_read_back';
  };
  cli: {
    repository: 'tiangong-lca/tiangong-cli' | 'tiangong-lca/cli';
    package_name: '@tiangong-lca/cli';
    package_version: string;
    release_commit_sha: string;
    release_evidence_sha256: string;
    status: 'published_and_verified';
  };
  workspace: {
    repository: 'tiangong-lca/workspace';
    integration_commit_sha: string;
    integration_issue_url: string;
    status: 'integrated';
  };
};

function invalid(message: string): never {
  throw new CliError(message, {
    code: 'DATASET_MAINTENANCE_PROTECTED_TOOLCHAIN_INVALID',
    exitCode: 2,
  });
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return invalid(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function exact<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) return invalid(`${label} must equal ${expected}.`);
  return expected;
}

function digest(value: unknown, label: string): string {
  const result = token(value, label);
  return SHA256.test(result) ? result : invalid(`${label} must be a lowercase SHA-256 digest.`);
}

function commit(value: unknown, label: string): string {
  const result = token(value, label);
  return GIT_SHA.test(result) ? result : invalid(`${label} must be a lowercase 40-hex git SHA.`);
}

export function parseProtectedToolchainEvidence(
  value: unknown,
  expected: { projectRef: string; cliVersion: string },
): DatasetMaintenanceProtectedToolchainEvidence {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.database_engine) ||
    !isJsonObject(value.cli) ||
    !isJsonObject(value.workspace)
  ) {
    return invalid(
      'Protected toolchain evidence must contain database, CLI, and workspace objects.',
    );
  }
  exact(value.schema_version, PROTECTED_TOOLCHAIN_EVIDENCE_SCHEMA, 'schema_version');
  exact(value.environment, 'production', 'environment');
  const projectRef = token(value.project_ref, 'project_ref');
  if (projectRef !== expected.projectRef) {
    return invalid('Toolchain evidence does not bind the authenticated production project.');
  }
  const verifiedAtUtc = token(value.verified_at_utc, 'verified_at_utc');
  const verifiedAtMs = Date.parse(verifiedAtUtc);
  if (!Number.isFinite(verifiedAtMs) || new Date(verifiedAtMs).toISOString() !== verifiedAtUtc) {
    return invalid('verified_at_utc must be a canonical UTC ISO timestamp.');
  }
  const packageVersion = token(value.cli.package_version, 'cli.package_version');
  if (!VERSION.test(packageVersion) || packageVersion !== expected.cliVersion) {
    return invalid('Toolchain evidence does not bind the running published CLI version.');
  }
  let identity: CliRepositoryIdentity;
  try {
    identity = cliRepositoryIdentity(packageVersion);
  } catch {
    return invalid('Toolchain evidence requires a stable canonical published CLI version.');
  }
  const integrationIssueUrl = token(
    value.workspace.integration_issue_url,
    'workspace.integration_issue_url',
  );
  if (!WORKSPACE_ISSUE.test(integrationIssueUrl)) {
    return invalid('workspace.integration_issue_url must identify a tracked workspace Issue.');
  }
  return {
    schema_version: PROTECTED_TOOLCHAIN_EVIDENCE_SCHEMA,
    environment: 'production',
    project_ref: projectRef,
    verified_at_utc: verifiedAtUtc,
    database_engine: {
      repository: exact(
        value.database_engine.repository,
        identity.databaseRepository,
        'database_engine.repository',
      ),
      production_main_commit_sha: commit(
        value.database_engine.production_main_commit_sha,
        'database_engine.production_main_commit_sha',
      ),
      production_readback_evidence_sha256: digest(
        value.database_engine.production_readback_evidence_sha256,
        'database_engine.production_readback_evidence_sha256',
      ),
      status: exact(
        value.database_engine.status,
        'released_and_read_back',
        'database_engine.status',
      ),
    },
    cli: {
      repository: exact(value.cli.repository, identity.repository, 'cli.repository'),
      package_name: exact(value.cli.package_name, '@tiangong-lca/cli', 'cli.package_name'),
      package_version: packageVersion,
      release_commit_sha: commit(value.cli.release_commit_sha, 'cli.release_commit_sha'),
      release_evidence_sha256: digest(
        value.cli.release_evidence_sha256,
        'cli.release_evidence_sha256',
      ),
      status: exact(value.cli.status, 'published_and_verified', 'cli.status'),
    },
    workspace: {
      repository: exact(
        value.workspace.repository,
        'tiangong-lca/workspace',
        'workspace.repository',
      ),
      integration_commit_sha: commit(
        value.workspace.integration_commit_sha,
        'workspace.integration_commit_sha',
      ),
      integration_issue_url: integrationIssueUrl,
      status: exact(value.workspace.status, 'integrated', 'workspace.status'),
    },
  };
}
