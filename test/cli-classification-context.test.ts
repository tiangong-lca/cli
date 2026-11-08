import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClassificationCommand } from '../src/commands/classification.js';
import {
  runDatasetClassificationChildren,
  runDatasetClassificationPath,
  type DatasetClassificationChildrenReport,
} from '../src/lib/dataset-classification.js';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/lib/errors.js';
const parsed = (value: { stdout: string }) => JSON.parse(value.stdout);
const rows = Array.from({ length: 25 }, (_, i) => ({
  level: 0,
  code: String(i),
  text: `Class ${i}`,
  value_key: '@classId' as const,
  path: [],
}));
const report: DatasetClassificationChildrenReport = {
  schema_version: 1,
  generated_at_utc: '2026-11-08T00:00:00Z',
  status: 'completed',
  command: 'dataset classification children',
  category_type: 'process',
  schema_file: 'process.json',
  parent_code: null,
  query: null,
  counts: { children: 30, returned: 25 },
  children: rows,
  blockers: [],
};
const ports = {
  children: async () => report,
  path: async () => ({
    schema_version: 1 as const,
    generated_at_utc: report.generated_at_utc,
    status: 'completed' as const,
    command: 'dataset classification path' as const,
    category_type: 'process' as const,
    schema_file: 'process.json',
    code: '1',
    path: [{ '@level': '0', '@classId': '1', '#text': 'Class 1' }],
    blockers: [],
  }),
};
function directory(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'classification-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('classification pages bind the filtered selection and preserve complete explicit output', async (t) => {
  const output = path.join(directory(t), 'catalog.json');
  const first = parsed(
    await runClassificationCommand(
      [
        'children',
        '--type',
        'process',
        '--parent',
        "a'b",
        '--query',
        'food',
        '--limit',
        '10',
        '--output',
        output,
        '--json',
      ],
      ports,
    ),
  );
  assert.equal(first.data.children.length, 10);
  assert.equal(first.data.counts.returned, 10);
  assert.equal(first.completeness.total, 25);
  assert.equal(first.completeness.allDirectChildren, 30);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).children.length, 25);
  assert.match(first.nextActions[0].command, /--query 'food' --limit 10 --cursor/);
  const second = parsed(
    await runClassificationCommand(
      [
        'children',
        '--type',
        'process',
        '--parent',
        "a'b",
        '--query',
        'food',
        '--limit',
        '10',
        '--cursor',
        first.completeness.nextCursor,
        '--json',
      ],
      ports,
    ),
  );
  assert.equal(second.data.children[0].code, '10');
  const last = parsed(
    await runClassificationCommand(
      [
        'children',
        '--type',
        'process',
        '--parent',
        "a'b",
        '--query',
        'food',
        '--limit',
        '10',
        '--cursor',
        second.completeness.nextCursor,
        '--json',
      ],
      ports,
    ),
  );
  assert.equal(last.data.children.length, 5);
  assert.equal(last.completeness.hasMore, false);
  const drift = await runClassificationCommand(
    [
      'children',
      '--type',
      'process',
      '--parent',
      "a'b",
      '--query',
      'food',
      '--limit',
      '10',
      '--cursor',
      first.completeness.nextCursor,
      '--json',
    ],
    { ...ports, children: async () => ({ ...report, children: rows.slice(1) }) },
  );
  assert.equal(parsed(drift).error.code, 'CURSOR_INVALID');
  const failedOutput = parsed(
    await runClassificationCommand(
      ['children', '--type', 'process', '--output', output, '--json'],
      ports,
    ),
  );
  assert.equal(failedOutput.status, 'partial');
  assert.equal(
    (
      await runClassificationCommand(
        ['children', '--type', 'process', '--output', output, '--force', '--json'],
        ports,
      )
    ).exitCode,
    0,
  );
});
test('classification help and malformed arguments do not invoke a directory query', async () => {
  let reads = 0;
  const noRead = {
    children: async () => {
      reads++;
      return report;
    },
    path: async () => {
      reads++;
      return ports.path();
    },
  };
  for (const args of [
    [],
    ['--help'],
    ['--help', '--json'],
    ['children', '--help'],
    ['path', '--help', '--json'],
  ])
    assert.equal((await runClassificationCommand(args, noRead)).exitCode, 0);
  for (const args of [
    ['bad'],
    ['children'],
    ['path', '--type', 'process'],
    ['children', '--type', 'process', '--force'],
    ['children', '--type', 'process', '--limit', '0'],
    ['children', '--type', 'process', '--limit', '101'],
    ['children', '--type', 'process', '--limit', '1.5'],
    ['children', '--type', 'process', '--json', '--json'],
    ['path', '--type', 'process', '--parent', 'A'],
    ['children', '--type', 'process', '--out-dir', 'old'],
  ])
    assert.equal((await runClassificationCommand(args, noRead)).exitCode, 2, args.join(' '));
  assert.equal(reads, 0);
});
test('classification failures retain actual blockers and redact unexpected upstream errors', async (t) => {
  const blocked = {
    ...report,
    status: 'blocked' as const,
    children: [],
    blockers: [{ code: 'classification_parent_unknown', message: 'Unknown parent.' }],
  };
  const result = await runClassificationCommand(['children', '--type', 'process', '--json'], {
    ...ports,
    children: async () => blocked,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(parsed(result).error.code, 'CLASSIFICATION_NOT_FOUND');
  assert.equal(parsed(result).data.blockers[0].code, 'classification_parent_unknown');
  const output = path.join(directory(t), 'result.json');
  await runClassificationCommand(
    ['path', '--type', 'process', '--code', '1', '--output', output],
    ports,
  );
  assert.equal(
    parsed(
      await runClassificationCommand(
        ['path', '--type', 'process', '--code', '1', '--output', output, '--json'],
        { ...ports, path: async () => ({ ...(await ports.path()), status: 'blocked' }) },
      ),
    ).status,
    'failed',
  );
  const exception = await runClassificationCommand(['children', '--type', 'process', '--json'], {
    ...ports,
    children: async () => {
      throw new Error('Bearer hidden-secret');
    },
  });
  assert.ok(!exception.stdout.includes('hidden-secret'));
  assert.equal(exception.exitCode, 1);
});
test('real bundled classification queries have local content identity, precise paths and no network effects', async () => {
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '', count: 0 },
    fetchImpl: async () => {
      throw new Error('unexpected network');
    },
  };
  const children = parsed(
    await executeCli(
      ['dataset', 'classification', 'children', '--type', 'process', '--json'],
      deps,
    ),
  );
  assert.equal(children.context.environment, 'local');
  assert.ok(children.context.directory.selectionDigest);
  assert.ok(children.data.children.length > 0);
  const selected = children.data.children[0].code;
  const selectedPath = parsed(
    await executeCli(
      ['dataset', 'classification', 'path', '--type', 'process', '--code', selected, '--json'],
      deps,
    ),
  );
  assert.equal(selectedPath.data.path.at(-1)['@classId'], selected);
  assert.equal(selectedPath.completeness.hasMore, false);
  const help = parsed(await executeCli(['dataset', 'classification', '--help', '--json'], deps));
  assert.deepEqual(help.actions, ['children', 'path']);
  const invalid = await runClassificationCommand(
    ['path', '--type', 'unknown', '--code', 'a', '--json'],
    { children: runDatasetClassificationChildren, path: runDatasetClassificationPath },
  );
  assert.equal(invalid.exitCode, 2);
  assert.equal(parsed(invalid).error.category, 'capability_unsupported');
  const ownedError = await runClassificationCommand(
    ['path', '--type', 'process', '--code', 'a', '--json'],
    {
      ...ports,
      path: async () => {
        throw new CliError('hidden-secret', { code: 'CLASSIFICATION_INPUT_INVALID', exitCode: 2 });
      },
    },
  );
  assert.equal(ownedError.exitCode, 2);
  assert.ok(!ownedError.stdout.includes('hidden-secret'));
});
