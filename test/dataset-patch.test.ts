import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __testInternals, runDatasetPatchApply } from '../src/lib/dataset-patch.js';

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sampleProcessRow() {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': 'proc-1',
          name: {
            baseName: {
              '@xml:lang': 'en',
              '#text': 'Old process name',
            },
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
        },
      },
    },
  };
}

test('runDatasetPatchApply applies evidenced JSON patch operations transactionally', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(patchPath, {
    schema_version: 1,
    patch_status: 'completed',
    patches: [
      {
        row_index: 0,
        dataset_id: 'proc-1',
        version: '00.00.001',
        authoring_package: 'authoring/packages/proc-1.json',
        operations: [
          {
            op: 'test',
            path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
            value: 'Old process name',
          },
          {
            op: 'replace',
            path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
            value: 'Curated process name',
            basis: 'Source-language evidence says this is the process name.',
            evidence: {
              source: 'authoring-package',
              quote: 'Curated process name',
            },
            resolution: {
              mode: 'evidence_backed_completion',
              used_context_kinds: ['schema', 'methodology_yaml', 'ruleset'],
              summary: 'Completed the visible name from source-language package evidence.',
            },
          },
        ],
      },
    ],
  });

  try {
    const report = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      outDir,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.applied_operation_count, 1);
    assert.equal(report.evidence_count, 1);
    const rows = readJsonl(outPath);
    assert.equal(
      (
        rows[0] as {
          processDataSet: {
            processInformation: { dataSetInformation: { name: { baseName: { '#text': string } } } };
          };
        }
      ).processDataSet.processInformation.dataSetInformation.name.baseName['#text'],
      'Curated process name',
    );
    assert.equal(existsSync(report.files.patch_evidence ?? ''), true);
    const evidence = readJsonl(report.files.patch_evidence ?? '') as Array<{
      resolution?: { mode?: string; used_context_kinds?: string[] };
    }>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.resolution?.mode, 'evidence_backed_completion');
    assert.deepEqual(evidence[0]?.resolution?.used_context_kinds, [
      'schema',
      'methodology_yaml',
      'ruleset',
    ]);
    assert.deepEqual(readJson(report.files.report ?? ''), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset patch internals cover pointer, operation, and target row guards', () => {
  assert.equal(__testInternals.parseRowIndex(0), 0);
  assert.equal(__testInternals.parseRowIndex('2'), 2);
  assert.equal(__testInternals.parseRowIndex(-1), null);
  assert.equal(__testInternals.parseRowIndex('bad'), null);
  assert.deepEqual(__testInternals.parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
  assert.throws(() => __testInternals.parsePointer('a/b'), /starting with/u);
  assert.throws(() => __testInternals.parsePointer('/bad~2escape'), /Invalid JSON Pointer/u);
  assert.equal(__testInternals.parseArrayIndex('-', 2, true), 2);
  assert.equal(__testInternals.parseArrayIndex('0', 2, false), 0);
  assert.throws(() => __testInternals.parseArrayIndex('01', 2, true), /Expected array index/u);
  assert.throws(() => __testInternals.parseArrayIndex('2', 2, false), /out of bounds/u);

  const row = { items: ['a', 'b'], nested: { value: 1 } };
  const appendTarget = __testInternals.resolvePatchTarget(row, '/items/-', true);
  __testInternals.setTargetValue(appendTarget, 'c', true);
  assert.deepEqual(row.items, ['a', 'b', 'c']);
  const replaceTarget = __testInternals.resolvePatchTarget(row, '/nested/value', false);
  assert.equal(__testInternals.targetExists(replaceTarget), true);
  assert.equal(__testInternals.getTargetValue(replaceTarget), 1);
  __testInternals.setTargetValue(replaceTarget, 2, false);
  assert.equal(row.nested.value, 2);
  __testInternals.removeTargetValue(replaceTarget);
  assert.deepEqual(row.nested, {});
  assert.deepEqual(__testInternals.resolvePatchTarget(row, '/', false), {
    container: row,
    key: '',
  });
  assert.throws(() => __testInternals.resolvePatchTarget(row, '/missing/value', false), /parent/u);
  assert.throws(
    () => __testInternals.resolvePatchTarget({ scalar: 1 }, '/scalar/value', false),
    /parent/u,
  );

  const applyRoot = { list: ['x'], name: 'old' };
  __testInternals.applyOperation(applyRoot, {
    op: 'add',
    path: '/list/-',
    value: 'y',
    basis: 'evidence',
  });
  __testInternals.applyOperation(applyRoot, {
    op: 'replace',
    path: '/name',
    value: 'new',
    evidence: 'source quote',
  });
  __testInternals.applyOperation(applyRoot, { op: 'test', path: '/name', value: 'new' });
  __testInternals.applyOperation(applyRoot, { op: 'remove', path: '/list/0', evidence: ['row'] });
  assert.deepEqual(applyRoot, { list: ['y'], name: 'new' });
  assert.throws(
    () => __testInternals.applyOperation(applyRoot, { op: 'test', path: '/name', value: 'bad' }),
    /Patch test failed/u,
  );

  assert.equal(__testInternals.evidenceIsPresent(' evidence '), true);
  assert.equal(__testInternals.evidenceIsPresent(' '), false);
  assert.equal(__testInternals.evidenceIsPresent(['x']), true);
  assert.equal(__testInternals.evidenceIsPresent({ source: 'doc' }), true);
  assert.equal(__testInternals.evidenceIsPresent(null), false);
  assert.equal(
    __testInternals.operationBasis({ op: 'replace', path: '/', basis: ' basis ' }),
    'basis',
  );
  assert.deepEqual(
    __testInternals.operationClosures({
      op: 'replace',
      path: '/name',
      closes: ['a', { code: 'b', json_path: '/x' }, { actionItemCode: 'b', jsonPath: '/x' }],
    }),
    [
      { code: 'a', path: null },
      { code: 'b', path: '/x' },
    ],
  );
  assert.deepEqual(__testInternals.normalizeClosureList(undefined), []);
  assert.deepEqual(__testInternals.normalizeClosureList({ ruleId: 'rule-1' }), [
    { code: 'rule-1', path: null },
  ]);
  assert.equal(__testInternals.normalizeClosure(null), null);
  assert.equal(__testInternals.normalizeClosure({}), null);
  assert.equal(__testInternals.looksLikeOperation({ op: 'add', path: '/x' }), true);
  assert.equal(__testInternals.normalizeOperationArray('bad'), null);
  assert.equal(__testInternals.normalizeOperationArray([{ op: 'add' }]), null);
  assert.equal(__testInternals.normalizePatchSet(null), null);
  assert.equal(__testInternals.normalizePatchSet({ row_index: 0 }), null);
  assert.deepEqual(
    __testInternals.normalizePatchSet({
      rowIndex: '3',
      entity_id: 'entity-1',
      dataset_version: '01.00.000',
      authoringPackage: 'pkg.json',
      patches: [{ op: 'test', path: '/x', value: 1 }],
    }),
    {
      rowIndex: 3,
      datasetId: 'entity-1',
      datasetVersion: '01.00.000',
      authoringPackage: 'pkg.json',
      operations: [{ op: 'test', path: '/x', value: 1 }],
    },
  );
  assert.equal(__testInternals.patchPayloadCompletionStatus(1), null);
  assert.equal(
    __testInternals.patchPayloadCompletionStatus({ patchStatus: 'completed' }),
    'completed',
  );
  const completedArray = [
    { row_index: 0, operations: [{ op: 'test', path: '/x', value: 1 }] },
  ] as Array<unknown> & { status?: string };
  completedArray.status = 'completed';
  assert.equal(__testInternals.normalizePatchPayload(completedArray).patches.length, 1);
  const operationArray = [{ op: 'test', path: '/x', value: 1 }] as Array<unknown> & {
    status?: string;
  };
  operationArray.status = 'completed';
  assert.equal(
    __testInternals.normalizePatchPayload(operationArray).blockers[0]?.code,
    'patch_row_required',
  );
  assert.equal(
    __testInternals.normalizePatchPayload(1).blockers[0]?.code,
    'ai_patch_status_not_completed',
  );
  assert.equal(
    __testInternals.normalizePatchPayload({
      patch_status: 'completed',
      suggestions: [{ bad: true }],
    }).blockers[0]?.code,
    'patch_set_invalid',
  );
  assert.equal(
    __testInternals.normalizePatchPayload({
      patch_status: 'completed',
      patch_sets: [{ op: 'test', path: '/x', value: 1 }],
    }).blockers[0]?.code,
    'patch_row_required',
  );
  assert.equal(
    __testInternals.normalizePatchPayload({ patch_status: 'completed' }).blockers[0]?.code,
    'patch_payload_invalid',
  );
  assert.equal(
    __testInternals.validateOperationShape({ op: 'move', path: '/x' }, 0, 0, 0, 'id', 'v')?.code,
    'patch_operation_unsupported',
  );
  assert.equal(
    __testInternals.validateOperationShape(
      { op: 'replace', path: 'x', value: 1, basis: 'b' },
      0,
      0,
      0,
      'id',
      'v',
    )?.code,
    'patch_path_invalid',
  );
  assert.equal(
    __testInternals.validateOperationShape(
      { op: 'replace', path: '/x', basis: 'b' },
      0,
      0,
      0,
      'id',
      'v',
    )?.code,
    'patch_value_required',
  );

  const rows = [
    { index: 0, id: 'id-1', version: '01.00.000', row: {}, payload: {}, kind: null },
    { index: 1, id: 'id-1', version: '02.00.000', row: {}, payload: {}, kind: null },
  ];
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: 9,
        datasetId: null,
        datasetVersion: null,
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_row_index_invalid',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: 0,
        datasetId: 'other',
        datasetVersion: null,
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_dataset_id_mismatch',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: 0,
        datasetId: 'id-1',
        datasetVersion: 'bad',
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_dataset_version_mismatch',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: null,
        datasetId: null,
        datasetVersion: null,
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_row_required',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: null,
        datasetId: 'missing',
        datasetVersion: null,
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_dataset_not_found',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: null,
        datasetId: 'id-1',
        datasetVersion: null,
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).blocker?.code,
    'patch_dataset_ambiguous',
  );
  assert.equal(
    __testInternals.findTargetRow(
      {
        rowIndex: null,
        datasetId: 'id-1',
        datasetVersion: '02.00.000',
        authoringPackage: null,
        operations: [],
      },
      rows,
      0,
    ).rowIndex,
    1,
  );
});

test('dataset patch internals cover authoring package guard branches', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-internals-'));
  const packageDir = path.join(dir, 'packages');
  mkdirSync(packageDir, { recursive: true });
  const validPackage = path.join(packageDir, 'pkg.json');
  const invalidJson = path.join(packageDir, 'invalid.json');
  const primitiveJson = path.join(packageDir, 'primitive.json');
  writeJson(validPackage, {
    entity_id: 'row-1',
    version: '01.00.000',
    action_items: [
      { code: 'required', path: '/x', ai_required: true },
      { code: 'skip', ai_required: false },
      { code: 'decision', action_kind: 'location_decision_authoring', ai_required: true },
      { rule_id: 'fallback-rule', path: '/y' },
    ],
  });
  writeJson(path.join(packageDir, 'mismatch.json'), {
    entity_id: 'other-row',
    version: '02.00.000',
    action_items: [],
  });
  writeFileSync(invalidJson, '{bad-json}', 'utf8');
  writeFileSync(primitiveJson, '1', 'utf8');

  try {
    assert.equal(__testInternals.resolveAuthoringPackagePath(null, packageDir), null);
    assert.equal(__testInternals.resolveAuthoringPackagePath('pkg.json', packageDir), validPackage);
    assert.equal(
      __testInternals.resolveAuthoringPackagePath(path.join('nested', 'pkg.json'), packageDir),
      validPackage,
    );
    assert.equal(
      __testInternals.readAuthoringPackageContext({
        patch: {
          rowIndex: 0,
          datasetId: 'row-1',
          datasetVersion: '01.00.000',
          authoringPackage: null,
          operations: [],
        },
        rowIndex: 0,
        rowId: 'row-1',
        rowVersion: '01.00.000',
        patchIndex: 0,
        requireAuthoringPackage: true,
      }).blockers[0]?.code,
      'authoring_package_required',
    );
    assert.equal(
      __testInternals.readAuthoringPackageContext({
        patch: {
          rowIndex: 0,
          datasetId: 'row-1',
          datasetVersion: '01.00.000',
          authoringPackage: 'missing.json',
          operations: [],
        },
        rowIndex: 0,
        rowId: 'row-1',
        rowVersion: '01.00.000',
        patchIndex: 0,
        authoringPackageDir: packageDir,
      }).blockers[0]?.code,
      'authoring_package_not_found',
    );
    assert.equal(
      __testInternals.readAuthoringPackageContext({
        patch: {
          rowIndex: 0,
          datasetId: 'row-1',
          datasetVersion: '01.00.000',
          authoringPackage: 'invalid.json',
          operations: [],
        },
        rowIndex: 0,
        rowId: 'row-1',
        rowVersion: '01.00.000',
        patchIndex: 0,
        authoringPackageDir: packageDir,
      }).blockers[0]?.code,
      'authoring_package_invalid',
    );
    assert.equal(
      __testInternals.readAuthoringPackageContext({
        patch: {
          rowIndex: 0,
          datasetId: 'row-1',
          datasetVersion: '01.00.000',
          authoringPackage: 'primitive.json',
          operations: [],
        },
        rowIndex: 0,
        rowId: 'row-1',
        rowVersion: '01.00.000',
        patchIndex: 0,
        authoringPackageDir: packageDir,
      }).blockers[0]?.code,
      'authoring_package_invalid',
    );

    const context = __testInternals.readAuthoringPackageContext({
      patch: {
        rowIndex: 0,
        datasetId: 'row-1',
        datasetVersion: '01.00.000',
        authoringPackage: 'pkg.json',
        operations: [],
      },
      rowIndex: 0,
      rowId: 'row-1',
      rowVersion: '01.00.000',
      patchIndex: 0,
      authoringPackageDir: packageDir,
    });
    assert.equal(context.blockers.length, 0);
    assert.deepEqual(context.context?.actionItems, [
      { code: 'required', path: '/x' },
      { code: 'fallback-rule', path: '/y' },
    ]);
    assert.equal(__testInternals.actionItemFromPackage({ code: 'x', ai_required: false }), null);
    assert.equal(
      __testInternals.actionItemFromPackage({
        action_kind: 'identity_decision_authoring',
        code: 'x',
      }),
      null,
    );
    assert.equal(__testInternals.actionItemFromPackage({}), null);
    assert.equal(
      __testInternals.closureMatchesActionItem(
        { code: 'required', path: null },
        { code: 'required', path: '/x' },
      ),
      true,
    );
    assert.equal(
      __testInternals.closureMatchesActionItem(
        { code: 'required', path: '/z' },
        { code: 'required', path: '/x' },
      ),
      false,
    );
    assert.deepEqual(
      __testInternals
        .readAuthoringPackageContext({
          patch: {
            rowIndex: 0,
            datasetId: 'row-1',
            datasetVersion: '01.00.000',
            authoringPackage: 'mismatch.json',
            operations: [],
          },
          rowIndex: 0,
          rowId: 'row-1',
          rowVersion: '01.00.000',
          patchIndex: 0,
          authoringPackageDir: packageDir,
        })
        .blockers.map((blocker) => blocker.code),
      ['authoring_package_entity_mismatch', 'authoring_package_version_mismatch'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetPatchApply covers required flags and blocker apply paths', async () => {
  await assert.rejects(
    () => runDatasetPatchApply({ inputPath: '', patchPath: 'patch.json', outPath: 'out.jsonl' }),
    /Missing required --input/u,
  );
  await assert.rejects(
    () => runDatasetPatchApply({ inputPath: 'rows.jsonl', patchPath: '', outPath: 'out.jsonl' }),
    /Missing required --patch/u,
  );
  await assert.rejects(
    () => runDatasetPatchApply({ inputPath: 'rows.jsonl', patchPath: 'patch.json', outPath: '' }),
    /Missing required --out/u,
  );

  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-blocker-paths-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  const packageDir = path.join(dir, 'packages');
  mkdirSync(packageDir, { recursive: true });
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(path.join(packageDir, 'pkg.json'), {
    entity_id: 'proc-1',
    version: '00.00.001',
    action_items: [{ code: 'known', path: '/known' }],
  });
  try {
    const emptyOps = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      rawPatch: {
        patch_status: 'completed',
        patches: [{ row_index: 0, operations: [] }],
      },
    });
    assert.equal(emptyOps.blockers[0]?.code, 'patch_operations_missing');

    const failedOps = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      authoringPackageDir: packageDir,
      requireActionItemClosure: true,
      rawPatch: {
        patch_status: 'completed',
        patches: [
          {
            row_index: 0,
            authoring_package: 'pkg.json',
            operations: [
              {
                op: 'remove',
                path: '/missing',
                evidence: 'source',
                closes: { code: 'unknown' },
              },
              {
                op: 'test',
                path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
                value: 'wrong',
              },
            ],
          },
        ],
      },
    });
    assert.equal(failedOps.status, 'blocked');
    assert.equal(
      failedOps.blockers.some((blocker) => blocker.code === 'authoring_action_item_unknown'),
      true,
    );
    assert.equal(
      failedOps.blockers.some((blocker) => blocker.code === 'patch_apply_failed'),
      true,
    );
    assert.equal(
      failedOps.blockers.some((blocker) => blocker.code === 'patch_test_failed'),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetPatchApply blocks patches without completed status before applying', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-status-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(patchPath, {
    schema_version: 1,
    patches: [
      {
        row_index: 0,
        operations: [
          {
            op: 'replace',
            path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
            value: 'Curated process name',
            basis: 'Source-language evidence says this is the process name.',
          },
        ],
      },
    ],
  });

  try {
    const report = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.blockers[0]?.code, 'ai_patch_status_not_completed');
    assert.equal(report.patch_count, 0);
    assert.equal(report.applied_operation_count, 0);
    const rows = readJsonl(outPath);
    assert.equal(
      (
        rows[0] as {
          processDataSet: {
            processInformation: { dataSetInformation: { name: { baseName: { '#text': string } } } };
          };
        }
      ).processDataSet.processInformation.dataSetInformation.name.baseName['#text'],
      'Old process name',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetPatchApply blocks unevidenced changes and leaves output rows unchanged', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-blocked-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(patchPath, {
    patch_status: 'completed',
    patches: [
      {
        row_index: 0,
        operations: [
          {
            op: 'replace',
            path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
            value: 'Unevidenced name',
          },
        ],
      },
    ],
  });

  try {
    const report = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.blockers[0]?.code, 'patch_evidence_required');
    assert.equal(report.applied_operation_count, 0);
    const rows = readJsonl(outPath);
    assert.equal(
      (
        rows[0] as {
          processDataSet: {
            processInformation: { dataSetInformation: { name: { baseName: { '#text': string } } } };
          };
        }
      ).processDataSet.processInformation.dataSetInformation.name.baseName['#text'],
      'Old process name',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetPatchApply can require authoring package lineage and action item closure', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-authoring-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  const packageDir = path.join(dir, 'authoring-packages');
  mkdirSync(packageDir, { recursive: true });
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(path.join(packageDir, 'proc-1.authoring-package.json'), {
    schema_version: 2,
    entity_id: 'proc-1',
    version: '00.00.001',
    action_items: [
      {
        code: 'process_missing_functional_unit',
        path: '/processDataSet/processInformation/dataSetInformation/quantitativeReference/functionalUnitOrOther',
        ai_required: true,
      },
      {
        code: 'identity_preflight_manual_review',
        action_kind: 'identity_decision_authoring',
        ai_required: true,
      },
      {
        code: 'process_classification_requires_authoring',
        action_kind: 'classification_decision_authoring',
        ai_required: true,
      },
    ],
  });
  writeJson(patchPath, {
    patch_status: 'completed',
    patches: [
      {
        dataset_id: 'proc-1',
        version: '00.00.001',
        authoring_package: 'proc-1.authoring-package.json',
        operations: [
          {
            op: 'add',
            path: '/processDataSet/processInformation/dataSetInformation/quantitativeReference',
            value: {
              functionalUnitOrOther: [{ '@xml:lang': 'en', '#text': '1 kg source product' }],
            },
            basis: 'Source package states the quantitative reference.',
            evidence: { source: 'authoring_package', quote: '1 kg source product' },
            closes_action_items: [
              {
                code: 'process_missing_functional_unit',
                path: '/processDataSet/processInformation/dataSetInformation/quantitativeReference/functionalUnitOrOther',
              },
            ],
          },
        ],
      },
    ],
  });

  try {
    const report = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      authoringPackageDir: packageDir,
      requireAuthoringPackage: true,
      requireActionItemClosure: true,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.closed_action_item_count, 1);
    const evidence = readJsonl(report.files.patch_evidence ?? '') as Array<{
      authoring_package_sha256?: string;
      closes_action_items?: Array<{ code: string }>;
    }>;
    assert.equal(evidence[0]?.closes_action_items?.[0]?.code, 'process_missing_functional_unit');
    assert.equal(typeof evidence[0]?.authoring_package_sha256, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetPatchApply blocks strict authoring patches that do not close package action items', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-patch-unclosed-'));
  const inputPath = path.join(dir, 'processes.jsonl');
  const patchPath = path.join(dir, 'patches.json');
  const outPath = path.join(dir, 'patched.jsonl');
  const packageDir = path.join(dir, 'authoring-packages');
  mkdirSync(packageDir, { recursive: true });
  writeJsonl(inputPath, [sampleProcessRow()]);
  writeJson(path.join(packageDir, 'proc-1.authoring-package.json'), {
    entity_id: 'proc-1',
    version: '00.00.001',
    action_items: [{ code: 'process_missing_functional_unit', ai_required: true }],
  });
  writeJson(patchPath, {
    patch_status: 'completed',
    patches: [
      {
        row_index: 0,
        authoring_package: 'proc-1.authoring-package.json',
        operations: [
          {
            op: 'replace',
            path: '/processDataSet/processInformation/dataSetInformation/name/baseName/#text',
            value: 'Still not closing FU',
            basis: 'Evidence exists for the name only.',
          },
        ],
      },
    ],
  });

  try {
    const report = await runDatasetPatchApply({
      inputPath,
      patchPath,
      outPath,
      authoringPackageDir: packageDir,
      requireActionItemClosure: true,
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    assert.equal(report.status, 'blocked');
    assert.ok(report.blockers.some((blocker) => blocker.code === 'authoring_action_item_unclosed'));
    assert.equal(report.applied_operation_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
