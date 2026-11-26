import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readModules(root, extension) {
  const files = new Map();
  function visit(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (file.endsWith(extension)) files.set(file, readFileSync(file, 'utf8'));
    }
  }
  visit(root);
  return files;
}

export function imports(source) {
  const references = [];
  const declarations =
    /\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(declarations)) references.push(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu))
    references.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu)) references.push(match[1]);
  return references;
}

export function moduleCycles(files) {
  const graph = new Map(
    [...files].map(([file, source]) => [
      file,
      imports(source)
        .filter((ref) => ref.startsWith('.'))
        .map((ref) => path.resolve(path.dirname(file), ref))
        .filter((target) => files.has(target)),
    ]),
  );
  const completed = new Set(),
    active = new Set(),
    stack = [],
    cycles = [];
  function visit(file) {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    if (completed.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const target of graph.get(file)) visit(target);
    stack.pop();
    active.delete(file);
    completed.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

export function isTypeOnlyModule(source) {
  return /^export\s*\{\s*\};?$/u.test(source.replace(/\/\/[^\n]*/gu, '').trim());
}
