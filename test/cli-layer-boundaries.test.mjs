import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { imports, moduleCycles, readModules, isTypeOnlyModule } from './helpers/module-graph.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('all source owners enforce application, presentation and composition boundaries', () => {
  const files = readModules(path.join(root, 'src'), '.ts');
  const violations = [];
  for (const [file, source] of files) {
    const from = path.relative(path.join(root, 'src'), file).replaceAll(path.sep, '/');
    for (const ref of imports(source)) {
      const target = ref.startsWith('.')
        ? path
            .relative(path.join(root, 'src'), path.resolve(path.dirname(file), ref))
            .replaceAll(path.sep, '/')
        : ref;
      if (
        from.startsWith('application/') &&
        !(
          target.startsWith('application/') ||
          [
            'shared/command-result.js',
            'shared/errors.js',
            'shared/json-content-digest.js',
            'shared/command-error-categories.js',
            'node:crypto',
            'node:util',
          ].includes(target)
        )
      )
        violations.push(`${from} -> ${target}`);
      if (
        from.startsWith('lib/') &&
        /^(?:commands\/|adapters\/|cli(?:-deps|-composition)?\.js$|main\.js$)/u.test(target)
      )
        violations.push(`${from} -> ${target}`);
      if (
        from.startsWith('lib/') &&
        target.startsWith('shared/') &&
        !['shared/errors.js', 'shared/state-directory.js'].includes(target)
      )
        violations.push(`${from} -> ${target}`);
      if (
        from.startsWith('shared/') &&
        !target.startsWith('shared/') &&
        !target.startsWith('node:') &&
        !(from === 'shared/command-presentation.ts' && target === 'lib/runtime/descriptor.js')
      )
        violations.push(`${from} -> ${target}`);
      if (
        from.startsWith('commands/') &&
        /^(?:cli(?:-deps|-composition)?\.js|main\.js)$/u.test(target)
      )
        violations.push(`${from} -> ${target}`);
      if (
        from.startsWith('adapters/') &&
        (target.startsWith('commands/') ||
          /^(?:cli(?:-deps|-composition)?\.js|main\.js)$/u.test(target))
      )
        violations.push(`${from} -> ${target}`);
    }
    if (from.startsWith('lib/')) {
      assert.doesNotMatch(source, /\bparseArgs\s*\(/u, `${from}: argv parsing belongs to commands`);
    }
    if (from.startsWith('application/') || from.startsWith('adapters/')) {
      assert.doesNotMatch(
        source,
        /command:\s*[`'"]tiangong-lca\b/u,
        `${from}: continuations belong to commands`,
      );
    }
    if (from.startsWith('commands/'))
      assert.doesNotMatch(
        source,
        /deps\.\w+Impl\s*\?\?/u,
        `${from}: defaults belong to composition`,
      );
  }
  assert.deepEqual(violations, []);
});

test('all emitted runtime imports and re-exports form an acyclic graph', () => {
  const files = readModules(path.join(root, 'dist', 'src'), '.js');
  assert.deepEqual(moduleCycles(files), []);
});

test('graph extraction includes multiline/type/side-effect/dynamic imports and detects cycles', () => {
  assert.deepEqual(
    imports(
      "import type { X } from './a.js';\nexport {\n x\n} from './b.js';\nimport './c.js'; import('./d.js');",
    ),
    ['./a.js', './b.js', './d.js', './c.js'],
  );
  assert.deepEqual(
    moduleCycles(
      new Map([
        ['/a.js', "import './b.js'"],
        ['/b.js', "export { a } from './a.js'"],
      ]),
    ).length,
    1,
  );
  assert.deepEqual(moduleCycles(new Map([['/a.js', "import './missing.js'"]])), []);
  assert.equal(isTypeOnlyModule('export {};\n//# sourceMappingURL=types.js.map'), true);
  assert.equal(isTypeOnlyModule('export const value = 1;'), false);
});

test('declaration-only operation and protocol ports have no runtime exports', async () => {
  for (const module of [
    await import('../src/application/operation-ports.js'),
    await import('../src/commands/ports.js'),
    await import('../src/lib/process-statistics/types.js'),
  ])
    assert.deepEqual(Object.keys(module), []);
});

test('core CLI import closure excludes the Batch facade and scheduling implementation', () => {
  const files = readModules(path.join(root, 'dist', 'src'), '.js');
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = files.get(file);
    assert.equal(typeof source, 'string', file);
    for (const ref of imports(source))
      if (ref.startsWith('.')) visit(path.resolve(path.dirname(file), ref));
  }
  visit(path.join(root, 'dist/src/main.js'));
  assert.ok(seen.has(path.join(root, 'dist/src/lib/locks/run-lock.js')));
  for (const file of seen) {
    assert.notEqual(file, path.join(root, 'dist/src/batch.js'));
    assert.ok(!file.startsWith(path.join(root, 'dist/src/lib/batch/')), file);
  }
});
