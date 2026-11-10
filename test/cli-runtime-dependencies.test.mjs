import { isTypeOnlyModule } from './helpers/module-graph.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Current process/public-library roots define production use. Test-only imports do not.
// Count all literal relative JS locators, including verified host/spawn paths, conservatively.
test('compiled runtime contains no orphan workflow modules outside the current entry graph', () => {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const modules = new Map();
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.js')) modules.set(file, readFileSync(file, 'utf8'));
    }
  }
  visit(path.join(root, 'src'));
  const roots = ['main', 'auth-identity-receipt', 'command-spec', 'runtime', 'batch'];
  const pending = roots.map((name) => path.join(root, `src/${name}.js`));
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    assert.ok(modules.has(file), `Missing entry module: ${file}`);
    visited.add(file);
    const source = modules.get(file);
    for (const [, reference] of source.matchAll(/['"]([^'"\n]+\.js)['"]/gu)) {
      if (!reference.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), reference);
      if (modules.has(target)) pending.push(target);
    }
    for (const name of roots.slice(1)) {
      if (source.includes(`@tiangong-lca/cli/${name}`))
        pending.push(path.join(root, `src/${name}.js`));
    }
  }
  assert.deepEqual(
    [...modules.keys()]
      .filter((file) => !visited.has(file) && !isTypeOnlyModule(modules.get(file)))
      .map((file) => path.relative(root, file))
      .sort((a, b) => a.localeCompare(b)),
    [],
    'Runtime modules must have a current process/public entry owner; tests are not production roots',
  );
});
