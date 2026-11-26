import { composeCliDeps } from '../src/cli-composition.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { executeAuthService } from '../src/commands/auth-service.js';

const removedRoots: Record<string, string[]> = {
  search: ['flow', 'process', 'hybrid'],
  flow: [
    'get',
    'list',
    'identity-preflight',
    'build-plan',
    'remediate',
    'fetch-rows',
    'materialize-decisions',
    'publish-version',
    'publish-reviewed-data',
    'build-alias-map',
    'scan-process-flow-refs',
    'plan-process-flow-repairs',
    'apply-process-flow-repairs',
    'regen-product',
    'validate-processes',
  ],
  process: [
    'get',
    'list',
    'identity-preflight',
    'build-plan',
    'scope-statistics',
    'dedup-review',
    'auto-build',
    'resume-build',
    'publish-build',
    'complete-required-fields',
    'save-draft',
    'refresh-references',
    'verify-rows',
    'batch-build',
  ],
  lifecyclemodel: [
    'auto-build',
    'build-resulting-process',
    'publish-resulting-process',
    'validate-build',
    'publish-build',
    'save-draft',
    'graph',
    'orchestrate',
  ],
  qa: ['process', 'flow', 'lifecyclemodel'],
  publish: ['run'],
};
const removedDataset = [
  'contract',
  'context-pack',
  'validate',
  'save-draft',
  'bilingual',
  'patch',
  'references',
  'verify-remote',
  'support-cache',
  'curation-queue',
  'evidence-search',
  'author',
];
function dependencies() {
  let calls = 0;
  return {
    deps: {
      // Removed entrypoints must reject without needing valid credentials or business IO.
      env: {},
      dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
      fetchImpl: async () => {
        calls++;
        throw new Error('Retired command reached transport');
      },
    },
    calls: () => calls,
  };
}
for (const [root, actions] of Object.entries(removedRoots)) {
  test(`${root}: retired root, help, actions and obsolete options reject without effects`, async () => {
    const { deps, calls } = dependencies();
    for (const args of [
      [root],
      [root, '--help'],
      ...actions.flatMap((action) => [
        [root, action],
        [root, action, '--help'],
        [root, action, '--input', '/missing/request.json', '--commit', '--json'],
      ]),
    ]) {
      const value = await executeCli(args, deps);
      assert.equal(value.exitCode, 2, args.join(' '));
      assert.equal(value.stdout, '');
      assert.equal(JSON.parse(value.stderr).error.code, 'UNKNOWN_COMMAND');
    }
    assert.equal(calls(), 0);
  });
}
for (const action of removedDataset) {
  test(`dataset ${action}: generic compatibility entrypoint is absent`, async () => {
    const { deps, calls } = dependencies();
    for (const args of [
      ['dataset', action],
      ['dataset', action, '--help'],
      ['dataset', action, 'apply', '--input', '/missing/request.json', '--json'],
      ['--', 'dataset', action],
    ]) {
      const value = await executeCli(args, deps);
      assert.equal(value.exitCode, 2, args.join(' '));
      assert.equal(value.stdout, '');
      assert.equal(JSON.parse(value.stderr).error.code, 'UNKNOWN_COMMAND');
    }
    assert.equal(calls(), 0);
  });
}
test('discovery contains the current typed tree and no compatibility roots', async () => {
  const { deps, calls } = dependencies();
  const value = await executeCli(['--help', '--json'], deps);
  const manifest = JSON.parse(value.stdout);
  for (const root of Object.keys(removedRoots))
    assert.equal(Object.hasOwn(manifest.commands, root), false);
  for (const action of removedDataset)
    assert.equal(Object.hasOwn(manifest.commands.dataset, action), false);
  for (const type of [
    'flow',
    'process',
    'model',
    'source',
    'contact',
    'flowproperty',
    'unitgroup',
    'lciamethod',
  ])
    assert.ok(Object.hasOwn(manifest.commands.dataset, type));
  assert.ok(manifest.commands.dataset.model.includes('aggregate'));
  assert.ok(manifest.commands.dataset.model.includes('build-resulting-process'));
  assert.equal(calls(), 0);
});
test('retained Auth service rejects an unknown internal action without transport', async () => {
  const { deps, calls } = dependencies();
  const value = await executeAuthService('unknown', [], composeCliDeps(deps));
  assert.equal(value.exitCode, 2);
  assert.equal(JSON.parse(value.stderr).error.code, 'UNKNOWN_COMMAND');
  assert.equal(calls(), 0);
});
