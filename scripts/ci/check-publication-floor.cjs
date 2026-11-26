#!/usr/bin/env node

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
async function main() {
  const { CLI_LEGACY_LAST_VERSION, cliRepositoryIdentity } = await import(
    require('node:url').pathToFileURL(
      path.join(repoRoot, 'scripts', 'ci', 'repository-identity.ts'),
    ).href
  );

  function usage() {
    process.stderr.write(
      [
        'Usage: node ./scripts/ci/check-publication-floor.cjs <version>',
        '',
        'Rejects release versions at or below the frozen legacy ceiling',
        `(<= ${CLI_LEGACY_LAST_VERSION}) so they can never be published or tagged under`,
        'the current repository identity: the compatibility verifier binds those',
        'versions to the historical source profile only.',
        '',
      ].join('\n'),
    );
  }

  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  const [, , version] = process.argv;

  if (!version || process.argv.length > 3) {
    usage();
    process.exit(1);
  }

  let identity;
  try {
    identity = cliRepositoryIdentity(version);
  } catch (error) {
    fail(`error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (identity.epoch !== 'current') {
    fail(
      `error: publication floor reached: version ${version} is at or below the frozen legacy ceiling ` +
        `${CLI_LEGACY_LAST_VERSION} and is bound to the historical source profile ` +
        `(${identity.repository}, repository id ${identity.repositoryId}, owner id ${identity.ownerId}); ` +
        'new-identity publication requires a higher version.',
    );
  }

  process.stdout.write(
    `publication floor check passed: version ${version} uses the current source profile ` +
      `(${identity.repository}, repository id ${identity.repositoryId}, owner id ${identity.ownerId})\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
