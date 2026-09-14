import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ci/release-context.sh', import.meta.url));
const floorScriptPath = fileURLToPath(
  new URL('../scripts/ci/check-publication-floor.cjs', import.meta.url),
);

const CANONICAL = {
  repository: 'tiangong-lca/cli',
  repositoryId: '1194220834',
  repositoryOwnerId: '327771381',
};
const LEGACY = {
  repository: 'tiangong-lca/tiangong-cli',
  repositoryId: '1194220834',
  repositoryOwnerId: '199785309',
};
const FORK = {
  repository: 'some-fork/tiangong-lca-cli',
  repositoryId: '999',
  repositoryOwnerId: '888',
};

// Future releases must advance beyond the frozen legacy ceiling: versions <= 0.1.14
// stay bound to the historical source profile and are rejected before tag or publish.
const FIRST_ELIGIBLE_VERSION = '0.1.15';
const FIRST_ELIGIBLE_TAG = `cli-v${FIRST_ELIGIBLE_VERSION}`;

// The release guard runs under GitHub's bash on ubuntu-latest. Execute it for real on
// platforms with bash; skip where bash is unavailable (for example Windows runners) so
// the suite stays platform-honest instead of weakening coverage.
const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const bashAvailable = bashProbe.status === 0;

let fixtureRoot;

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'cli-workflow-release-context-'));
});

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// Git hooks export repository-local routing variables. Fixture commands run in
// other repositories and must not inherit those pointers into the real checkout.
// Scoped config/credential settings remain inherited; all fixture remotes are local.
function fixtureEnvironment() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
    'GIT_SUPER_PREFIX',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_SHALLOW_FILE',
  ])
    delete env[key];
  return env;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnvironment() });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function revExists(cwd, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', ref], {
    cwd,
    encoding: 'utf8',
    env: fixtureEnvironment(),
  });
  return result.status === 0;
}

/**
 * Local bare "origin" plus a work clone: main with a base commit and the release commit
 * (package.json at releaseVersion plus a root pnpm-lock.yaml), and the matching
 * cli-v<releaseVersion> tag on the main tip. No network access; every tag push stays
 * inside the fixture.
 */
function createFixture({ releaseVersion = FIRST_ELIGIBLE_VERSION } = {}) {
  const name = `repo-${Math.random().toString(16).slice(2)}`;
  const origin = join(fixtureRoot, `${name}-origin.git`);
  const work = join(fixtureRoot, name);
  git(fixtureRoot, 'init', '--bare', origin);
  git(fixtureRoot, 'init', '-b', 'main', work);
  git(work, 'config', 'user.email', 'workflow-release-context@example.invalid');
  git(work, 'config', 'user.name', 'workflow-release-context test');
  git(work, 'remote', 'add', 'origin', origin);

  writeFileSync(
    join(work, 'package.json'),
    `${JSON.stringify({ name: '@tiangong-lca/cli', version: '0.1.13' }, null, 2)}\n`,
  );
  git(work, 'add', 'package.json');
  git(work, 'commit', '-m', 'base 0.1.13');
  const baseSha = git(work, 'rev-parse', 'HEAD');

  writeFileSync(
    join(work, 'package.json'),
    `${JSON.stringify({ name: '@tiangong-lca/cli', version: releaseVersion }, null, 2)}\n`,
  );
  writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: placeholder\n');
  git(work, 'add', 'package.json', 'pnpm-lock.yaml');
  git(work, 'commit', '-m', `release ${releaseVersion}`);
  const headSha = git(work, 'rev-parse', 'HEAD');
  const tagName = `cli-v${releaseVersion}`;
  git(work, 'tag', tagName, headSha);
  git(work, 'push', 'origin', 'main', `refs/tags/${tagName}`);

  return { origin, work, baseSha, headSha, tagName };
}

// Exercise the actual workflow-to-shell wiring, not a second hand-built SHA
// mapping. A projection of github.sha into EVENT_WORKFLOW_SHA must fail tests.
function workflowEventBindings(context) {
  const workflow = readFileSync(
    new URL('../.github/workflows/publish.yml', import.meta.url),
    'utf8',
  );
  const entries = [
    ...workflow.matchAll(/^\s+(EVENT_[A-Z_]+): \$\{\{ github\.([a-z_]+) \}\}\s*$/gmu),
  ];
  const result = Object.fromEntries(entries.map((match) => [match[1], context[match[2]]]));
  for (const name of ['EVENT_COMMIT_SHA', 'EVENT_WORKFLOW_SHA'])
    assert.notEqual(result[name], undefined);
  return result;
}

function runReleaseContext(
  fixture,
  {
    repository,
    repositoryId,
    repositoryOwnerId,
    event = 'push',
    ref = `refs/tags/${fixture.tagName}`,
    refName = fixture.tagName,
    sha = fixture.headSha,
    workflowSha = fixture.headSha,
    requestedTag = '',
  },
) {
  const outputPath = join(fixtureRoot, `output-${Math.random().toString(16).slice(2)}`);
  const summaryPath = join(fixtureRoot, `summary-${Math.random().toString(16).slice(2)}`);
  const result = spawnSync('bash', [scriptPath], {
    cwd: fixture.work,
    encoding: 'utf8',
    env: {
      ...fixtureEnvironment(),
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_REF_NAME: refName,
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_SHA: workflowSha,
      ...workflowEventBindings({
        sha,
        workflow_sha: workflowSha,
        repository,
        repository_id: repositoryId,
        repository_owner_id: repositoryOwnerId,
      }),
      REQUESTED_TAG_NAME: requestedTag,
      EVENT_REPOSITORY: repository,
      EVENT_REPOSITORY_ID: repositoryId,
      EVENT_REPOSITORY_OWNER_ID: repositoryOwnerId,
      EXPECTED_REPOSITORY: CANONICAL.repository,
      EXPECTED_REPOSITORY_ID: CANONICAL.repositoryId,
      EXPECTED_REPOSITORY_OWNER_ID: CANONICAL.repositoryOwnerId,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  });
  const outputs = {};
  for (const line of readIfExists(outputPath).split('\n')) {
    const match = /^([^=]+)=(.*)$/u.exec(line);
    if (match) outputs[match[1]] = match[2];
  }
  return { result, outputs };
}

function runFloorScript(version) {
  return spawnSync('node', [floorScriptPath, version], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: fixtureEnvironment(),
  });
}

function combinedOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

describe(
  'publish.yml release-context guard (executed against real git fixtures)',
  { skip: !bashAvailable && 'bash is unavailable on this platform' },
  () => {
    it('isolates fixture repositories from foreign Git hook routing', () => {
      const foreign = createFixture();
      const protectedPaths = ['.git/config', '.git/HEAD', '.git/index', 'package.json'];
      const beforeBytes = protectedPaths.map((name) => readFileSync(join(foreign.work, name)));
      const routing = {
        GIT_DIR: join(foreign.work, '.git'),
        GIT_COMMON_DIR: join(foreign.work, '.git'),
        GIT_WORK_TREE: foreign.work,
        GIT_INDEX_FILE: join(foreign.work, '.git/index'),
        GIT_PREFIX: 'borrowed-worktree/',
      };
      const previous = Object.fromEntries(
        Object.keys(routing).map((key) => [key, process.env[key]]),
      );
      try {
        Object.assign(process.env, routing);
        const fixture = createFixture();
        const { result, outputs } = runReleaseContext(fixture, { ...CANONICAL });
        assert.equal(result.status, 0, combinedOutput(result));
        assert.equal(outputs.should_release, 'true');
        for (const [index, name] of protectedPaths.entries()) {
          assert.deepEqual(readFileSync(join(foreign.work, name)), beforeBytes[index]);
        }
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it('releases a canonical cli-v* tag push above the legacy ceiling with the bound ids', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, { ...CANONICAL });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'true');
      assert.equal(outputs.tag_name, FIRST_ELIGIBLE_TAG);
      assert.equal(outputs.release_head, fixture.headSha);
      assert.equal(outputs.release_base, fixture.baseSha);
      assert.equal(revExists(fixture.origin, `refs/tags/${FIRST_ELIGIBLE_TAG}`), true);
    });

    it('accepts manual recovery dispatched at the exact release tag ref with matching SHAs', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        requestedTag: FIRST_ELIGIBLE_TAG,
      });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'true');
      assert.equal(outputs.tag_name, FIRST_ELIGIBLE_TAG);
      assert.equal(outputs.release_head, fixture.headSha);
      assert.equal(outputs.release_base, fixture.baseSha);
    });

    it('fails a main dispatch before publish instead of silently skipping', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        ref: 'refs/heads/main',
        refName: 'main',
        requestedTag: FIRST_ELIGIBLE_TAG,
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /main dispatch cannot produce tag-bound provenance/u);
      assert.equal(outputs.should_release, undefined);
    });

    it('fails a tag-ref dispatch whose GITHUB_SHA diverges from the release head', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        requestedTag: FIRST_ELIGIBLE_TAG,
        sha: '0'.repeat(40),
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /SHA binding failed/u);
      assert.equal(outputs.should_release, undefined);
    });

    it('fails a tag-ref dispatch whose workflow SHA diverges from the release head', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        requestedTag: FIRST_ELIGIBLE_TAG,
        workflowSha: '0'.repeat(40),
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /SHA binding failed/u);
      assert.equal(outputs.should_release, undefined);
    });

    it('rejects a moved tag or a divergent workflow definition on ordinary tag pushes', () => {
      const fixture = createFixture();
      for (const drift of [{ sha: '0'.repeat(40) }, { workflowSha: '0'.repeat(40) }]) {
        const { result, outputs } = runReleaseContext(fixture, { ...CANONICAL, ...drift });
        assert.notEqual(result.status, 0);
        assert.match(combinedOutput(result), /SHA binding failed/u);
        assert.equal(outputs.should_release, undefined);
      }
    });

    it('rejects a tag push at the frozen legacy ceiling under the current identity', () => {
      const fixture = createFixture({ releaseVersion: '0.1.14' });
      const { result, outputs } = runReleaseContext(fixture, { ...CANONICAL });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /publication floor reached/u);
      assert.equal(outputs.should_release, undefined);
    });

    it('rejects legacy-ceiling manual recovery even with exact tag ref and SHAs', () => {
      const fixture = createFixture({ releaseVersion: '0.1.14' });
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        requestedTag: 'cli-v0.1.14',
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /publication floor reached/u);
      assert.equal(outputs.should_release, undefined);
    });

    it('skips the legacy repository identity so old-owner paths stay denied', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, { ...LEGACY });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'false');
      assert.match(
        combinedOutput(result),
        /Skipping release outside canonical repository binding/u,
      );
    });

    it('skips when the repository name matches but the repository id does not', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        repositoryId: '1194220835',
      });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'false');
      assert.match(
        combinedOutput(result),
        /Skipping release outside canonical repository binding/u,
      );
    });

    it('skips when the repository name matches but the owner id does not', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, {
        ...CANONICAL,
        repositoryOwnerId: '199785309',
      });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'false');
      assert.match(
        combinedOutput(result),
        /Skipping release outside canonical repository binding/u,
      );
    });

    it('skips a fork repository even with a matching tag name', () => {
      const fixture = createFixture();
      const { result, outputs } = runReleaseContext(fixture, { ...FORK });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'false');
    });

    it('keeps the main-ancestry gate: a version-correct tag off main does not release', () => {
      const name = `repo-off-main-${Math.random().toString(16).slice(2)}`;
      const origin = join(fixtureRoot, `${name}-origin.git`);
      const work = join(fixtureRoot, name);
      git(fixtureRoot, 'init', '--bare', origin);
      git(fixtureRoot, 'init', '-b', 'main', work);
      git(work, 'config', 'user.email', 'workflow-release-context@example.invalid');
      git(work, 'config', 'user.name', 'workflow-release-context test');
      git(work, 'remote', 'add', 'origin', origin);
      writeFileSync(
        join(work, 'package.json'),
        `${JSON.stringify({ name: '@tiangong-lca/cli', version: '0.1.13' }, null, 2)}\n`,
      );
      git(work, 'add', 'package.json');
      git(work, 'commit', '-m', 'base 0.1.13');
      git(work, 'push', 'origin', 'main');
      git(work, 'checkout', '-q', '-b', 'side');
      writeFileSync(
        join(work, 'package.json'),
        `${JSON.stringify({ name: '@tiangong-lca/cli', version: FIRST_ELIGIBLE_VERSION }, null, 2)}\n`,
      );
      writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: placeholder\n');
      git(work, 'add', 'package.json', 'pnpm-lock.yaml');
      git(work, 'commit', '-m', `release ${FIRST_ELIGIBLE_VERSION} off main`);
      const sideSha = git(work, 'rev-parse', 'HEAD');
      git(work, 'tag', FIRST_ELIGIBLE_TAG, sideSha);
      git(work, 'push', 'origin', 'side', `refs/tags/${FIRST_ELIGIBLE_TAG}`);

      const fixture = { origin, work, headSha: sideSha, tagName: FIRST_ELIGIBLE_TAG };
      const { result, outputs } = runReleaseContext(fixture, { ...CANONICAL });
      assert.equal(result.status, 0, combinedOutput(result));
      assert.equal(outputs.should_release, 'false');
      assert.match(combinedOutput(result), /not on origin\/main/u);
    });

    it('keeps the version gate: a tag that mismatches package.json version fails', () => {
      const fixture = createFixture();
      git(fixture.work, 'tag', 'cli-v0.1.13', fixture.headSha);
      const { result } = runReleaseContext(fixture, {
        ...CANONICAL,
        ref: 'refs/tags/cli-v0.1.13',
        refName: 'cli-v0.1.13',
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /does not match package\.json version/u);
    });

    it('keeps the pnpm release contract: a pre-pnpm tag fails', () => {
      const fixture = createFixture();
      git(fixture.work, 'checkout', '-q', '--orphan', 'pre-pnpm');
      git(fixture.work, 'rm', '-rf', '--quiet', '.');
      writeFileSync(
        join(fixture.work, 'package.json'),
        `${JSON.stringify({ name: '@tiangong-lca/cli', version: '0.1.13' }, null, 2)}\n`,
      );
      git(fixture.work, 'add', 'package.json');
      git(fixture.work, 'commit', '-m', 'pre-pnpm 0.1.13');
      git(fixture.work, 'tag', 'cli-v0.1.13');
      git(fixture.work, 'push', 'origin', 'refs/tags/cli-v0.1.13');
      git(fixture.work, 'checkout', '-q', 'main');
      const { result } = runReleaseContext(fixture, {
        ...CANONICAL,
        ref: 'refs/tags/cli-v0.1.13',
        refName: 'cli-v0.1.13',
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /predates the pnpm release contract/u);
    });

    it('fails when the requested recovery tag does not exist', () => {
      const fixture = createFixture();
      const { result } = runReleaseContext(fixture, {
        ...CANONICAL,
        event: 'workflow_dispatch',
        ref: 'refs/tags/cli-v0.0.1',
        refName: 'cli-v0.0.1',
        requestedTag: 'cli-v0.0.1',
      });
      assert.notEqual(result.status, 0);
      assert.match(combinedOutput(result), /does not exist/u);
    });
  },
);

describe(
  'publication floor script (executed)',
  { skip: !bashAvailable && 'bash is unavailable on this platform' },
  () => {
    it('rejects the frozen legacy ceiling and every version below it', () => {
      for (const version of ['0.1.14', '0.1.13', '0.1.9', '0.0.33']) {
        const result = runFloorScript(version);
        assert.notEqual(result.status, 0, `floor must reject ${version}`);
        assert.match(result.stderr, /publication floor reached/u, version);
      }
    });

    it('accepts the first version above the ceiling and later ones', () => {
      for (const version of ['0.1.15', '0.1.16', '0.2.0', '1.0.0']) {
        const result = runFloorScript(version);
        assert.equal(result.status, 0, `floor must accept ${version}: ${result.stderr}`);
        assert.match(result.stdout, /current source profile/u, version);
      }
    });

    it('rejects malformed versions via the shared identity helper', () => {
      for (const version of ['0.1.14-beta', 'not-a-version', '01.2.3']) {
        const result = runFloorScript(version);
        assert.notEqual(result.status, 0, `floor must reject malformed ${version}`);
        assert.doesNotMatch(result.stderr, /publication floor reached/u, version);
      }
    });
  },
);
