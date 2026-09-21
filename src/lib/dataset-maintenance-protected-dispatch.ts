// Version dispatch for the protected run command.
//
// The router keeps exactly one `dataset maintenance run-protected` surface: the sealed freeze
// the operator names decides which versioned capability executes it. A v1 freeze runs the frozen
// v1 chain byte-for-byte; a `dataset-alias-execution-freeze.v2` seal runs the versioned v2 chain
// through the same gates, the same one-admission policy and the same durable evidence owners.

import { readProtectedJsonArtifact } from './dataset-maintenance-protected-artifacts.js';
import {
  ALIAS_V2_PROTECTED_CONTRACT,
  runAliasV2Protected,
  type AliasV2ProtectedReport,
} from './dataset-alias-v2-protected.js';
import {
  runDatasetMaintenanceProtected,
  type DatasetMaintenanceProtectedReport,
  type RunDatasetMaintenanceProtectedOptions,
} from './dataset-maintenance-protected-run.js';
import { isJsonObject } from './dataset-maintenance-contract.js';
import { CliError } from './errors.js';

export type ProtectedRunVersion = 'v1' | 'v2';

/** Reads the seal's schema version without trusting anything else about it. */
export function detectProtectedRunVersion(freezePath: string): ProtectedRunVersion {
  const artifact = readProtectedJsonArtifact({ filePath: freezePath, label: 'Protected freeze' });
  if (!isJsonObject(artifact.value)) {
    throw new CliError('Protected freeze must be a JSON object.', {
      code: 'DATASET_MAINTENANCE_PROTECTED_FREEZE_INVALID',
      exitCode: 2,
    });
  }
  const schema = artifact.value['schema_version'];
  if (schema === ALIAS_V2_PROTECTED_CONTRACT.freeze_schema) {
    return 'v2';
  }
  return 'v1';
}

/**
 * Runs one sealed execution through its versioned chain. The v1 path is untouched: a v1 seal
 * always reaches the frozen v1 implementation.
 */
export async function runDatasetMaintenanceProtectedDispatch(
  options: RunDatasetMaintenanceProtectedOptions,
): Promise<DatasetMaintenanceProtectedReport | AliasV2ProtectedReport> {
  if (detectProtectedRunVersion(options.freezePath) === 'v2') {
    return runAliasV2Protected({
      planPath: options.planPath,
      freezePath: options.freezePath,
      approvalPath: options.approvalPath,
      outDir: options.outDir,
      commit: options.commit,
      statusOnly: options.statusOnly,
      ...(options.approveExecution === undefined
        ? {}
        : { approveExecution: options.approveExecution }),
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
      ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      env: options.env,
      fetchImpl: options.fetchImpl,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }
  return runDatasetMaintenanceProtected(options);
}
