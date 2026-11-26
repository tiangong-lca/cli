import assert from 'node:assert/strict';
import test from 'node:test';
import { cliRepositoryIdentity } from '../scripts/ci/repository-identity.js';

test('one immutable repository/owner profile is selected at the verified release boundary', () => {
  const legacy = cliRepositoryIdentity('0.1.14');
  assert.deepEqual(legacy, {
    epoch: 'legacy',
    repository: 'tiangong-lca/tiangong-cli',
    repositoryId: '1194220834',
    ownerId: '199785309',
    databaseRepository: 'tiangong-lca/database-engine',
  });
  assert.ok(Object.isFrozen(legacy));
  for (const version of ['0.0.0', '0.0.26', '0.0.999', '0.1.0', '0.1.10']) {
    assert.equal(cliRepositoryIdentity(version), legacy);
  }
  const current = cliRepositoryIdentity('0.1.15');
  assert.deepEqual(current, {
    epoch: 'current',
    repository: 'tiangong-lca/cli',
    repositoryId: '1194220834',
    ownerId: '327771381',
    databaseRepository: 'tiangong-lca/database',
  });
  assert.ok(Object.isFrozen(current));
  for (const version of ['0.2.0', '1.0.0', '9007199254740991.0.0']) {
    assert.equal(cliRepositoryIdentity(version), current);
  }
});

test('source identity rejects noncanonical, prerelease and unbounded version input', () => {
  for (const version of [
    '',
    'v0.1.14',
    '00.1.14',
    '0.01.14',
    '0.1.014',
    '0.1.15-beta',
    '0.1.14+build',
    '1'.repeat(65),
    '9007199254740992.0.0',
  ]) {
    assert.throws(() => cliRepositoryIdentity(version));
  }
  assert.throws(() => cliRepositoryIdentity(null as unknown as string));
});

test('source policy loads through native Node ESM without a build or application imports', async () => {
  const { spawnSync } = await import('node:child_process');
  const location = new URL('../scripts/ci/repository-identity.ts', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const source = await import(process.argv[1]);
    assert.equal(source.CLI_LEGACY_LAST_VERSION, '0.1.14');
    assert.equal(source.CLI_REPOSITORY_ID, '1194220834');
    for (const version of ['0.0.0', '0.0.26', '0.0.999', '0.1.0', '0.1.10', '0.1.14']) {
      assert.equal(source.cliRepositoryIdentity(version).epoch, 'legacy');
    }
    for (const version of ['0.1.15', '0.2.0', '1.0.0', '9007199254740991.0.0']) {
      assert.equal(source.cliRepositoryIdentity(version).epoch, 'current');
    }
    for (const invalid of [null, '', '1'.repeat(65), '0.1.15-beta', '9007199254740992.0.0']) {
      assert.throws(() => source.cliRepositoryIdentity(invalid));
    }
  `,
      location,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
});
