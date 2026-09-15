import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zero = '0'.repeat(40);
const oid = '1'.repeat(40);
const deletion = `(delete) ${zero} refs/heads/merged ${oid}\n`;
const update = `refs/heads/main ${oid} refs/heads/main ${'2'.repeat(40)}\n`;

// Only the test fixture drops inherited Git bindings. The real hook keeps the
// caller's Git context. No external remote, package build or actual gate runs here.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-push-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo with spaces');
  const bin = join(dir, 'bin');
  mkdirSync(join(repo, '.githooks'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(bin);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(dir, 'empty-git-config');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  env.PATH = `${bin}${delimiter}${env.PATH}`;
  env.TMPDIR = dir.replaceAll('\\', '/');
  const init = spawnSync('git', ['init', '-q', repo], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const hook = join(repo, '.githooks/pre-push');
  const helper = join(repo, 'scripts/pre-push-deletion-only.sh');
  copyFileSync(join(root, '.githooks/pre-push'), hook);
  chmodSync(hook, 0o755);
  if (existsSync(join(root, 'scripts/pre-push-deletion-only.sh'))) {
    copyFileSync(join(root, 'scripts/pre-push-deletion-only.sh'), helper);
    chmodSync(helper, 0o755);
  }
  for (const [path, name] of [
    [join(repo, 'scripts/docpact-gate.sh'), 'docpact'],
    [join(bin, 'pnpm'), 'pnpm'],
  ]) {
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '${name}|%s' "$#" >> .fixture-trace\nfor argument do printf '|%s' "$argument" >> .fixture-trace; done\nprintf '\\n' >> .fixture-trace\nexit "\${FIXTURE_${name.toUpperCase()}_EXIT:-0}"\n`,
    );
    chmodSync(path, 0o755);
  }
  const args = ['origin name', 'https://example.invalid/remote with spaces.git'];
  const expected = `docpact|2|${args.join('|')}\npnpm|2|run|prepush:gate\n`;
  return {
    repo,
    helper,
    expected,
    git(args) {
      const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result;
    },
    run(input, overrides = {}, remoteArgs = args) {
      writeFileSync(join(repo, '.fixture-trace'), '');
      const result = spawnSync('sh', ['.githooks/pre-push', ...remoteArgs], {
        cwd: repo,
        env: { ...env, ...overrides },
        input,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.ifError(result.error);
      return { ...result, trace: readFileSync(join(repo, '.fixture-trace'), 'utf8') };
    },
  };
}

test('pure branch deletions alone skip both source gates', (t) => {
  const f = fixture(t);
  for (const input of [
    deletion,
    deletion + deletion.replace('merged', 'another'),
    `(delete) ${'0'.repeat(64)} refs/heads/sha256 ${'a'.repeat(64)}\n`,
  ]) {
    const result = f.run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.trace, '', 'a deletion publishes no source');
  }
});

test('all non-deletion or uncertain wire inputs preserve the full ordered gate', (t) => {
  const f = fixture(t);
  const inputs = {
    update,
    creation: `refs/heads/new ${oid} refs/heads/new ${zero}\n`,
    tagPush: `refs/tags/v1 ${oid} refs/tags/v1 ${zero}\n`,
    tagDelete: deletion.replace('refs/heads/merged', 'refs/tags/v1'),
    mixed: deletion + update,
    deleteLast: update + deletion,
    partialAfterDelete: deletion + '(delete)\n',
    empty: '',
    blank: '\n',
    missingField: `(delete) ${zero} refs/heads/merged\n`,
    extraField: deletion.trimEnd() + ' extra\n',
    missingNewline: deletion.trimEnd(),
    crlf: deletion.replace('\n', '\r\n'),
    nul: deletion.replace('\n', '\0\n'),
    shortOid: deletion.replace(zero, '0000'),
    unsupportedWidth: deletion.replace(zero, '0'.repeat(50)),
    nonzeroLocal: deletion.replace(zero, oid),
    zeroRemote: deletion.replace(oid, zero),
    widthMismatch: deletion.replace(oid, 'a'.repeat(64)),
    nonhex: deletion.replace(oid, 'z'.repeat(40)),
    uppercase: deletion.replace(oid, 'A'.repeat(40)),
    badRef: deletion.replace('merged', '../bad'),
    emptyBranch: deletion.replace('merged', ''),
    nonBranch: deletion.replace('refs/heads/merged', 'refs/notes/x'),
    missingMarker: deletion.replace('(delete)', 'refs/heads/merged'),
    tab: deletion.replace(' refs/heads/', '\trefs/heads/'),
  };
  for (const [name, input] of Object.entries(inputs)) {
    const result = f.run(input);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(result.trace, f.expected, name);
  }
});

test('remote arguments never select the fast path and retain element boundaries', (t) => {
  const f = fixture(t);
  for (const args of [[], ['(delete)', zero], ['origin', 'a path with spaces', 'extra']]) {
    const result = f.run(update, {}, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.trace,
      `docpact|${args.length}${args.length ? `|${args.join('|')}` : ''}\npnpm|2|run|prepush:gate\n`,
    );
  }
});

test('original gate failures stop with the same exit status', (t) => {
  const f = fixture(t);
  const doc = f.run(update, { FIXTURE_DOCPACT_EXIT: '64' });
  assert.equal(doc.status, 64);
  assert.equal(doc.trace, f.expected.split('\n')[0] + '\n');
  const pnpm = f.run(update, { FIXTURE_PNPM_EXIT: '7' });
  assert.equal(pnpm.status, 7);
  assert.equal(pnpm.trace, f.expected);
});

test('missing, failing or unavailable classifier falls back without dropping gates', (t) => {
  const f = fixture(t);
  rmSync(f.helper, { force: true });
  assert.equal(f.run(deletion).trace, f.expected);
  writeFileSync(f.helper, '#!/bin/sh\nexit 42\n');
  chmodSync(f.helper, 0o755);
  assert.equal(f.run(deletion).trace, f.expected);
  copyFileSync(join(root, 'scripts/pre-push-deletion-only.sh'), f.helper);
  chmodSync(f.helper, 0o755);
  const unavailable = f.run(deletion, { TMPDIR: join(f.repo, 'absent') });
  assert.equal(unavailable.status, 0);
  assert.equal(unavailable.trace, f.expected);
});

test('real local Git source push qualifies and branch deletion invokes no gates', (t) => {
  const f = fixture(t);
  const bare = join(dirname(f.repo), 'remote bare.git');
  f.git(['init', '--bare', '-q', bare]);
  f.git(['config', 'core.hooksPath', '.githooks']);
  f.git(['remote', 'add', 'origin', bare]);
  writeFileSync(join(f.repo, 'fixture.txt'), 'source fixture\n');
  f.git(['add', 'fixture.txt']);
  f.git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  writeFileSync(join(f.repo, '.fixture-trace'), '');
  f.git(['push', 'origin', 'HEAD:refs/heads/fixture']);
  const sourceTrace = readFileSync(join(f.repo, '.fixture-trace'), 'utf8');
  assert.match(sourceTrace, /^docpact\|2\|origin\|[^\n]+\npnpm\|2\|run\|prepush:gate\n$/u);
  writeFileSync(join(f.repo, '.fixture-trace'), '');
  f.git(['push', 'origin', '--delete', 'fixture']);
  assert.equal(readFileSync(join(f.repo, '.fixture-trace'), 'utf8'), '');
  assert.equal(f.git(['ls-remote', '--heads', 'origin', 'fixture']).stdout, '');
});
