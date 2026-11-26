/**
 * Release identities are historical facts, not aliases chosen by a caller.
 * CLI #312 verified the last pre-transfer release (0.1.14) and GitHub IDs.
 * Keep this module dependency-free so the Node 24 release verifier can load
 * the source without building or importing the application runtime.
 */
export const CLI_LEGACY_LAST_VERSION = '0.1.14' as const;
export const CLI_REPOSITORY_ID = '1194220834' as const;

const legacy = Object.freeze({
  epoch: 'legacy',
  repository: 'tiangong-lca/tiangong-cli',
  repositoryId: CLI_REPOSITORY_ID,
  ownerId: '199785309',
  databaseRepository: 'tiangong-lca/database-engine',
} as const);

const current = Object.freeze({
  epoch: 'current',
  repository: 'tiangong-lca/cli',
  repositoryId: CLI_REPOSITORY_ID,
  ownerId: '327771381',
  databaseRepository: 'tiangong-lca/database',
} as const);

export type CliRepositoryIdentity = typeof legacy | typeof current;

export function cliRepositoryIdentity(version: string): CliRepositoryIdentity {
  if (
    typeof version !== 'string' ||
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
  ) {
    throw new Error('CLI source identity requires a stable canonical release version.');
  }
  const parts = version.split('.').map((part) => BigInt(part));
  if (parts.some((part) => part > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error('CLI source identity version is outside the supported range.');
  }
  const [major, minor, patch] = parts;
  return major === 0n && (minor === 0n || (minor === 1n && patch <= 14n)) ? legacy : current;
}
