import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import test from 'node:test';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const BUDGET_PATH = join(REPOSITORY_ROOT, 'test', 'fixtures', 'public-batch-module-budgets.json');
const BUDGET = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
const compareText = (left, right) => left.localeCompare(right);
const EXPECTED_RUNTIME_EXPORTS = Object.freeze([
  'BatchContractError',
  'BatchItemIdentityDriftError',
  'BatchItemProjectionDriftError',
  'BatchItemResourceDriftError',
  'BatchItemResumeContractError',
  'BatchMutationReplayError',
  'BatchMutationRetryError',
  'BatchRunLockIdentityConflictError',
  'BatchRunLockTimeoutError',
  'MAX_BATCH_CONCURRENCY',
  'assertBatchContractMatches',
  'assertBatchItemContractMatches',
  'batchRunLockPath',
  'batchRunLockStatePath',
  'canonicalBatchJson',
  'createBatchContract',
  'createBatchItemContract',
  'parseBatchContract',
  'parseBatchItemContract',
  'runBoundedBatch',
  'sha256BatchBytes',
  'sha256BatchJson',
  'withBatchRunLock',
]);
const EXPECTED_TYPE_EXPORTS = Object.freeze([
  'BatchAttemptedResumeItem',
  'BatchClock',
  'BatchCompletedResumeItem',
  'BatchContract',
  'BatchEvent',
  'BatchEventType',
  'BatchExclusiveKeyContext',
  'BatchExecutionContext',
  'BatchItemContract',
  'BatchItemFailedResult',
  'BatchItemResult',
  'BatchItemResultStatus',
  'BatchItemSucceededResult',
  'BatchItemSuccessStatus',
  'BatchJsonObject',
  'BatchJsonPrimitive',
  'BatchJsonValue',
  'BatchMode',
  'BatchMutationRecoveryContext',
  'BatchMutationRecoveryResult',
  'BatchPauseContext',
  'BatchRecoverySource',
  'BatchResumeItem',
  'BatchResumeState',
  'BatchRetryContext',
  'BatchRetryPolicy',
  'BatchRunLockOptions',
  'BatchRunLockReceipt',
  'BatchRunResult',
  'BatchSleep',
  'BatchStatus',
  'BatchStopContext',
  'CreateBatchContractOptions',
  'CreateBatchItemContractOptions',
  'RunBoundedBatchOptions',
]);

test('public batch facade preserves exact runtime exports, bytes, and error shapes', async () => {
  const batch = await import('../src/batch.js');
  assert.deepEqual(
    Object.keys(batch).sort(compareText),
    [...EXPECTED_RUNTIME_EXPORTS].sort(compareText),
  );

  const contract = batch.createBatchContract({
    identity: { revision: 1, run: 'facade' },
    content: [{ id: 'a' }],
    policy: { maxConcurrency: 1 },
  });
  const result = await batch.runBoundedBatch({
    contract,
    items: [{ id: 'a', payload: 1 }],
    getItemIdentity: (item) => item.id,
    projectItemContent: (item) => ({ payload: item.payload }),
    projectItemPolicy: () => ({ mode: 'read' }),
    getExclusiveKey: () => 'resource:a',
    mode: 'read',
    maxConcurrency: 1,
    clock: { now: () => 10 },
    execute: () => ({ ok: true }),
  });
  assert.equal(
    JSON.stringify(result),
    '{"contract":{"identity":{"revision":1,"run":"facade"},"content_sha256":"3f2d3382920cf76f6c108c87a501b0c6742601774c5db8bd3d71732299a9d852","policy_sha256":"41b0cbc2ef644e262961bb0248ce84d4684d1244cd34c403e59d4c66189d3958"},"status":"completed","claim_order":["a"],"completion_order":["a"],"results_input_order":[{"item":{"id":"a","payload":1},"item_id":"a","item_contract":{"item_id":"a","content_sha256":"536d58551392d10c4bc2ad887f1c4f50d5ab021f6c04e62f42a417be26d5bc4c","policy_sha256":"ec293d51149c76f557255419ae0d2f32e7a8d99f662c1e351259741e490a47de"},"exclusive_key":"resource:a","input_index":0,"attempts":1,"attempt_consumed":true,"resumed":false,"completed_at_ms":10,"status":"succeeded","value":{"ok":true}}],"results_completion_order":[{"item":{"id":"a","payload":1},"item_id":"a","item_contract":{"item_id":"a","content_sha256":"536d58551392d10c4bc2ad887f1c4f50d5ab021f6c04e62f42a417be26d5bc4c","policy_sha256":"ec293d51149c76f557255419ae0d2f32e7a8d99f662c1e351259741e490a47de"},"exclusive_key":"resource:a","input_index":0,"attempts":1,"attempt_consumed":true,"resumed":false,"completed_at_ms":10,"status":"succeeded","value":{"ok":true}}],"unclaimed_item_ids":[],"events":[{"sequence":1,"timestamp_ms":10,"type":"batch_started"},{"sequence":2,"timestamp_ms":10,"type":"item_claimed","item_id":"a","input_index":0},{"sequence":3,"timestamp_ms":10,"type":"item_resource_queued","item_id":"a","input_index":0,"exclusive_key":"resource:a"},{"sequence":4,"timestamp_ms":10,"type":"item_resource_acquired","item_id":"a","input_index":0,"exclusive_key":"resource:a"},{"sequence":5,"timestamp_ms":10,"type":"attempt_started","item_id":"a","input_index":0,"attempt":1},{"sequence":6,"timestamp_ms":10,"type":"attempt_succeeded","item_id":"a","input_index":0,"attempt":1},{"sequence":7,"timestamp_ms":10,"type":"item_resource_released","item_id":"a","input_index":0,"exclusive_key":"resource:a"},{"sequence":8,"timestamp_ms":10,"type":"item_completed","item_id":"a","input_index":0,"status":"succeeded"},{"sequence":9,"timestamp_ms":10,"type":"batch_completed","status":"completed"}]}',
  );

  const errors = [
    new batch.BatchContractError('contract'),
    new batch.BatchMutationRetryError(),
    new batch.BatchMutationReplayError('a'),
    new batch.BatchItemResumeContractError('a'),
    new batch.BatchItemProjectionDriftError('a'),
    new batch.BatchItemIdentityDriftError('a'),
    new batch.BatchItemResourceDriftError('a'),
    new batch.BatchRunLockTimeoutError({
      runPath: '/run',
      lockPath: '/run/.lock',
      identitySha256: 'a'.repeat(64),
      waitedMs: 5,
      owner: { pid: 1 },
    }),
    new batch.BatchRunLockIdentityConflictError({
      runPath: '/run',
      activeIdentitySha256: 'a'.repeat(64),
      requestedIdentitySha256: 'b'.repeat(64),
    }),
  ];
  assert.equal(
    JSON.stringify(
      errors.map((error) => ({
        constructor: error.constructor.name,
        name: error.name,
        message: error.message,
        keys: Object.keys(error),
        own: Object.fromEntries(Object.keys(error).map((key) => [key, error[key]])),
      })),
    ),
    '[{"constructor":"BatchContractError","name":"BatchContractError","message":"contract","keys":["name"],"own":{"name":"BatchContractError"}},{"constructor":"BatchMutationRetryError","name":"BatchMutationRetryError","message":"Mutation batches reject automatic retry; use explicit readback recovery instead.","keys":["name"],"own":{"name":"BatchMutationRetryError"}},{"constructor":"BatchMutationReplayError","name":"BatchMutationReplayError","message":"Mutation item a has a consumed incomplete attempt and cannot be replayed without explicit readback recovery.","keys":["name"],"own":{"name":"BatchMutationReplayError"}},{"constructor":"BatchItemResumeContractError","name":"BatchItemResumeContractError","message":"Batch resume item a does not match the current item identity, content SHA-256, and policy SHA-256 triple.","keys":["name","itemId"],"own":{"name":"BatchItemResumeContractError","itemId":"a"}},{"constructor":"BatchItemProjectionDriftError","name":"BatchItemProjectionDriftError","message":"Batch item a content or policy projection drifted before claim.","keys":["name","itemId"],"own":{"name":"BatchItemProjectionDriftError","itemId":"a"}},{"constructor":"BatchItemIdentityDriftError","name":"BatchItemIdentityDriftError","message":"Batch item a identity drifted before claim.","keys":["name","itemId"],"own":{"name":"BatchItemIdentityDriftError","itemId":"a"}},{"constructor":"BatchItemResourceDriftError","name":"BatchItemResourceDriftError","message":"Batch item a exclusive resource key drifted before claim.","keys":["name","itemId"],"own":{"name":"BatchItemResourceDriftError","itemId":"a"}},{"constructor":"BatchRunLockTimeoutError","name":"BatchRunLockTimeoutError","message":"Timed out after 5ms acquiring batch run lock: /run/.lock","keys":["code","runPath","lockPath","identitySha256","waitedMs","owner","name"],"own":{"code":"BATCH_RUN_LOCK_TIMEOUT","runPath":"/run","lockPath":"/run/.lock","identitySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","waitedMs":5,"owner":{"pid":1},"name":"BatchRunLockTimeoutError"}},{"constructor":"BatchRunLockIdentityConflictError","name":"BatchRunLockIdentityConflictError","message":"Batch run path is already locked by another identity in this process: /run","keys":["code","runPath","activeIdentitySha256","requestedIdentitySha256","name"],"own":{"code":"BATCH_RUN_LOCK_IDENTITY_CONFLICT","runPath":"/run","activeIdentitySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","requestedIdentitySha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"BatchRunLockIdentityConflictError"}}]',
  );
});

test('public facade re-exports the exact internal runtime objects and class identities', async () => {
  const [batch, contracts, engine, errors, runLock, types] = await Promise.all([
    import('../src/batch.js'),
    import('../src/lib/batch/canonical-contracts.js'),
    import('../src/lib/batch/engine.js'),
    import('../src/lib/batch/errors.js'),
    import('../src/lib/locks/run-lock.js'),
    import('../src/lib/batch/types.js'),
  ]);
  const owners = { ...contracts, ...engine, ...errors, ...runLock, ...types };
  for (const name of EXPECTED_RUNTIME_EXPORTS) {
    assert.equal(batch[name], owners[name], `${name} must be the owning module's exact object`);
  }
});

test('generated batch declaration preserves the exact named type and runtime surface', () => {
  const declaration = readFileSync(join(REPOSITORY_ROOT, 'dist', 'src', 'batch.d.ts'), 'utf8');
  assert.doesNotMatch(declaration, /export\s+default|export\s+\*|\bnamespace\b|\bNodeJS\./u);
  const names = declarationExportNames(declaration);
  assert.deepEqual(
    names.runtime.sort(compareText),
    [...EXPECTED_RUNTIME_EXPORTS].sort(compareText),
  );
  assert.deepEqual(names.types.sort(compareText), [...EXPECTED_TYPE_EXPORTS].sort(compareText));
});

test('public batch modules obey shrink-only LOC, dependency-direction, and SCC budgets', () => {
  assert.equal(BUDGET.schema, 'tiangong-cli.public-batch-module-budgets.v1');
  assert.equal(BUDGET.facade.max_lines <= 400, true, 'facade ceiling may never exceed 400');
  assert.equal(
    BUDGET.ordinary_module_hard_max_lines,
    800,
    'ordinary internal hard ceiling is immutable',
  );

  const configured = [BUDGET.facade, ...BUDGET.modules];
  const expectedInternalPaths = BUDGET.modules.map(({ path }) => path).sort(compareText);
  const actualInternalPaths = ['batch', 'locks']
    .flatMap((directory) =>
      readdirSync(join(REPOSITORY_ROOT, 'src', 'lib', directory))
        .filter((entry) => entry.endsWith('.ts'))
        .map((entry) => `src/lib/${directory}/${entry}`),
    )
    .sort(compareText);
  assert.deepEqual(actualInternalPaths, expectedInternalPaths, 'module inventory drifted');

  const graph = new Map();
  const configuredPaths = new Set(configured.map(({ path }) => path));
  const forbidden = new Set(BUDGET.forbidden_upward_imports);
  for (const module of configured) {
    const absolutePath = join(REPOSITORY_ROOT, module.path);
    assert.equal(existsSync(absolutePath), true, `missing budgeted module: ${module.path}`);
    const source = readFileSync(absolutePath, 'utf8');
    const lineCount = countLines(source);
    const hardMaximum = module.path === BUDGET.facade.path ? 400 : 800;
    assert.equal(
      Number.isSafeInteger(module.max_lines) && module.max_lines > 0,
      true,
      `${module.path} ceiling must be a positive safe integer`,
    );
    assert.equal(
      module.max_lines <= hardMaximum,
      true,
      `${module.path} ceiling ${module.max_lines} exceeds hard maximum ${hardMaximum}`,
    );
    assert.equal(
      lineCount <= module.max_lines,
      true,
      `${module.path} has ${lineCount} lines, over shrink-only ceiling ${module.max_lines}`,
    );
    assert.doesNotMatch(
      module.path,
      /(?:^|\/)(?:part[-_]?\d+|chunk[-_]?\d+)\.ts$/iu,
      'modules require semantic names',
    );

    const internalImports = sourceImports(module.path, source).filter((path) =>
      configuredPaths.has(path),
    );
    for (const imported of sourceImports(module.path, source)) {
      if (module.path !== BUDGET.facade.path) {
        assert.equal(
          forbidden.has(imported),
          false,
          `${module.path} has forbidden upward import ${imported}`,
        );
      }
    }
    assert.deepEqual(
      [...new Set(internalImports)].sort(compareText),
      [...module.allowed_internal_imports].sort(compareText),
      `${module.path} internal dependency direction drifted`,
    );
    graph.set(module.path, [...new Set(internalImports)]);
  }

  const cyclicComponents = stronglyConnectedComponents(graph).filter(
    (component) =>
      component.length > 1 ||
      (component.length === 1 && graph.get(component[0])?.includes(component[0])),
  );
  assert.deepEqual(cyclicComponents, [], 'public batch dependency graph must remain acyclic');
});

function countLines(source) {
  if (source.length === 0) return 0;
  const count = source.split(/\r?\n/u).length;
  return /\r?\n$/u.test(source) ? count - 1 : count;
}

function declarationExportNames(source) {
  const runtime = new Set();
  const types = new Set();
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(const|class|function|type|interface)\s+([A-Za-z_$][\w$]*)/gmu,
  )) {
    (match[1] === 'type' || match[1] === 'interface' ? types : runtime).add(match[2]);
  }
  for (const match of source.matchAll(
    /^export\s+(type\s+)?\{([^}]+)\}(?:\s+from\s+['"][^'"]+['"])?\s*;/gmu,
  )) {
    const target = match[1] ? types : runtime;
    for (const part of match[2].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);
      if (name) target.add(name);
    }
  }
  return { runtime: [...runtime], types: [...types] };
}

function sourceImports(sourcePath, source) {
  const imports = [];
  for (const match of source.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gmu,
  )) {
    if (!match[1].startsWith('.')) continue;
    const resolved = normalize(
      relative(REPOSITORY_ROOT, resolve(dirname(join(REPOSITORY_ROOT, sourcePath)), match[1])),
    )
      .replaceAll('\\', '/')
      .replace(/\.js$/u, '.ts');
    imports.push(resolved);
  }
  return imports;
}

function stronglyConnectedComponents(graph) {
  let index = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (true) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort(compareText));
  };
  for (const node of graph.keys()) if (!indexes.has(node)) visit(node);
  return components;
}
