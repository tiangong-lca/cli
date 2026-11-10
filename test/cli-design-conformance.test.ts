import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, linkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import * as sdk from '@tiangong-lca/tidas-sdk';
import { collectUnitGroupContentIssues } from '../src/lib/unitgroup-content-validation.js';
import { datasetValidation } from '../src/adapters/dataset-local.js';
import { createTidasSdkPackageValidator } from '../src/lib/tidas-sdk-package-validator.js';
import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import { runReviewCommand } from '../src/commands/review.js';
import { assertSeparateCommandFiles } from '../src/shared/command-files.js';
import { listContentReferences } from '../src/application/dataset-content.js';
import { CommandInputError, result } from '../src/shared/command-result.js';
import { shellArgument, inputContinuation } from '../src/shared/command-continuation.js';
import { businessFixture } from './helpers/cli-business-fixtures.js';
import { createBusinessBackend } from './helpers/cli-business-backend.js';
import { unitGroupFixture } from './helpers/unitgroup-fixture.js';
import { buildSupabaseTestEnv } from './helpers/supabase-auth.js';

const noNetwork = async () => {
  throw new Error('No external network permitted');
};
test('Unit Group default business validation and package validation reject dangling/duplicate internal identities', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'unitgroup-conformance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'unitgroups'));
  const validator = createTidasSdkPackageValidator(
    sdk as unknown as Parameters<typeof createTidasSdkPackageValidator>[0],
    'sdk',
  )!;
  for (const kind of ['valid', 'dangling', 'duplicate']) {
    const content = unitGroupFixture() as Record<string, any>;
    if (kind === 'dangling')
      content.unitGroupDataSet.unitGroupInformation.quantitativeReference.referenceToReferenceUnit =
        '99999';
    if (kind === 'duplicate') content.unitGroupDataSet.units.unit[1]['@dataSetInternalID'] = '1';
    const before = JSON.stringify(content);
    const report = await datasetValidation('unitgroup', content, ['schema', 'business']);
    assert.equal(report.status, kind === 'valid' ? 'passed' : 'failed');
    assert.equal((report.validation_layers as any).schema.status, 'passed');
    if (kind !== 'valid')
      assert.ok(
        (report.issues as any[]).some(
          (issue) =>
            issue.code ===
            `unitgroup_${kind === 'dangling' ? 'reference_missing_target' : 'unit_id_duplicate'}`,
        ),
      );
    writeFileSync(path.join(directory, 'unitgroups', 'units.json'), before);
    assert.equal(validator.validatePackageDir(directory).ok, kind === 'valid');
    assert.equal(JSON.stringify(content), before);
  }
});

test('Unit Group diagnostics cover singleton units, malformed IDs and absent local targets', () => {
  assert.equal(collectUnitGroupContentIssues({}).length, 2);
  assert.equal(
    collectUnitGroupContentIssues({
      unitGroupInformation: { quantitativeReference: null },
      units: { unit: [] },
    }).length,
    2,
  );
  const valid = {
    unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: '7' } },
    units: { unit: { '@dataSetInternalID': '7' } },
  };
  assert.deepEqual(collectUnitGroupContentIssues(valid), []);
  for (const unit of [null, { '@dataSetInternalID': ' 7 ' }, { '@dataSetInternalID': 7 }]) {
    const issues = collectUnitGroupContentIssues({ ...valid, units: { unit } });
    assert.ok(issues.some((issue) => issue.code === 'unitgroup_unit_id_invalid'));
    assert.ok(
      issues.some((issue) => issue.path === 'unitGroupDataSet.units.unit.@dataSetInternalID'),
    );
  }
  assert.equal(
    collectUnitGroupContentIssues({
      ...valid,
      unitGroupInformation: { quantitativeReference: { referenceToReferenceUnit: 7 } },
    })[0]?.code,
    'unitgroup_reference_invalid',
  );
});

test('Review refuses same-file and hard-link output before executing its mutation port', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'review-output-conformance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'request.json');
  const alias = path.join(directory, 'request-alias.json');
  const bytes = JSON.stringify({ requestId: 'original-request', json: { text: 'Draft' } });
  writeFileSync(input, bytes);
  linkSync(input, alias);
  let calls = 0;
  for (const output of [input, alias]) {
    const io = await runReviewCommand(
      ['comment', '--input', input, '--output', output, '--force', '--dry-run', '--json'],
      noNetwork,
      {
        mutate: async () => {
          calls++;
          return result('review comment');
        },
        materials: noNetwork,
      },
    );
    assert.equal(io.exitCode, 2);
    assert.equal(JSON.parse(io.stdout).error.code, 'OUTPUT_IS_INPUT');
    assert.equal(readFileSync(input, 'utf8'), bytes);
  }
  assert.equal(calls, 0);
  assertSeparateCommandFiles(path.join(directory, 'new.json'), '-');
});

test('Source attachment representations never become dataset references, while incomplete dataset references remain visible', () => {
  for (const value of [
    { '@uri': 'https://example.test/file.pdf' },
    [{ '@uri': 'https://example.test/file.pdf' }],
  ]) {
    const refs = listContentReferences({
      sourceDataSet: {
        referenceToDigitalFile: value,
        'common:referenceToDigitalFile': value,
        referenceToContact: { '@type': 'contact data set' },
      },
    });
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0]!.missing, ['id', 'version']);
  }
});

test('Reference-only and schema/reference checks disclose every omitted local layer', async () => {
  const backend = createBusinessBackend();
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_AUTH_MODE: 'access-token',
    TIANGONG_LCA_ACCESS_TOKEN: 'submitter-token',
  });
  const ports = createDatasetPorts(env, backend.fetchImpl);
  const content = businessFixture('flow');
  for (const checks of [
    ['references'],
    ['schema', 'references'],
    ['schema', 'business', 'references'],
  ]) {
    const report = await ports.validate('flow', content, checks);
    assert.equal(report.status, 'passed');
    const omitted = report.notChecked as string[];
    assert.equal(omitted.includes('schema'), checks.length === 1);
    assert.equal(omitted.includes('business'), !checks.includes('business'));
    assert.equal(omitted.includes('remote_references'), false);
  }
});

test('Model graph metadata cannot bypass fields or file output, and Process exchange projections remain explicitly partial content', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'projection-conformance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ports = createDatasetPorts({}, noNetwork);
  const row = {
    type: 'model' as const,
    id: 'id',
    version: '00.00.001',
    modifiedAt: null,
    stateCode: 0,
    owner: null,
    content: businessFixture('model'),
    modelGraph: { nodes: Array(1000).fill({ label: 'Large graph' }) },
  };
  ports.read = async () => ({ records: [row], total: 1, environment: 'https://example.test' });
  const io = await runDatasetCommand(
    [
      'model',
      'get',
      '--id',
      'id',
      '--version',
      row.version,
      '--fields',
      'id',
      '--output',
      path.join(directory, 'model.json'),
      '--json',
    ],
    ports,
  );
  assert.equal(io.exitCode, 0);
  assert.ok(!io.stdout.includes('modelGraph'));
  assert.ok(io.stdout.length < 3000);
  const content = businessFixture('process');
  ports.read = async () => ({
    records: [{ ...row, type: 'process', content }],
    total: 1,
    environment: 'https://example.test',
  });
  const response = await runDatasetCommand(
    ['process', 'get', '--id', 'id', '--version', row.version, '--fields', 'exchanges', '--json'],
    ports,
  );
  const projected = JSON.parse(response.stdout);
  assert.equal(response.exitCode, 0);
  assert.deepEqual(projected.data.exchanges, (content.processDataSet as any).exchanges);
  assert.equal(projected.data.content, undefined);
  assert.equal(projected.completeness.completeContent, false);
  ports.read = async () => ({
    records: [{ ...row, type: 'process', content: { processDataSet: {} } }],
    total: 1,
    environment: 'https://example.test',
  });
  const empty = await runDatasetCommand(
    [
      'process',
      'get',
      '--id',
      'id',
      '--version',
      row.version,
      '--fields',
      'exchanges,content',
      '--json',
    ],
    ports,
  );
  assert.equal(JSON.parse(empty.stdout).data.exchanges, null);
  assert.equal(JSON.parse(empty.stdout).completeness.completeContent, true);
});

test('Continuations use absolute files and platform-correct quoting, with conflict and choice-specific templates', async (t) => {
  assert.equal(shellArgument("a'b", 'win32'), "'a''b'");
  assert.equal(shellArgument("a'b", 'linux'), "'a'\\''b'");
  assert.equal(inputContinuation('-'), null);
  assert.ok(inputContinuation('relative.json')!.includes(path.resolve('relative.json')));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'continuation-conformance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json');
  writeFileSync(
    input,
    JSON.stringify({ flowDataSet: { a: { '@refObjectId': 'a' }, b: { '@refObjectId': 'b' } } }),
  );
  const ports = createDatasetPorts({}, noNetwork);
  const refs = await runDatasetCommand(
    [
      'flow',
      'list-references',
      '--input',
      path.relative(process.cwd(), input),
      '--limit',
      '1',
      '--json',
    ],
    ports,
  );
  assert.ok(JSON.parse(refs.stdout).nextActions[0].command.includes(input));
  const stdin = await runDatasetCommand(
    ['flow', 'list-references', '--input', '-', '--limit', '1', '--json'],
    ports,
    (file) => {
      assert.equal(file, '-');
      return JSON.parse(readFileSync(input, 'utf8'));
    },
  );
  assert.equal(stdin.exitCode, 0, stdin.stderr);
  const next = JSON.parse(stdin.stdout).nextActions[0];
  assert.equal(next.command, undefined);
  assert.match(next.description, /unchanged stdin/u);
  writeFileSync(input, '{}');
  ports.mutate = async () => {
    throw new CommandInputError('SAVE_CONFLICT', 'Content changed');
  };
  const conflict = await runDatasetCommand(['flow', 'save', '--input', input, '--json'], ports);
  assert.equal(path.basename(JSON.parse(conflict.stdout).replyTemplate), 'conflict-result.md');
  ports.search = async () => ({ candidates: [{ id: 'a' }, { id: 'b' }], returned: 2 });
  const choice = await runDatasetCommand(['flow', 'search', '--query', 'name', '--json'], ports);
  assert.equal(path.basename(JSON.parse(choice.stdout).replyTemplate), 'decision-required.md');
});
