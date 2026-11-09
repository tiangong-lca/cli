import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runDatasetCurationQueueBuild,
  runDatasetCurationQueueNext,
  runDatasetCurationQueueVerify,
  __testInternals,
  type DatasetCurationQueueBuildReport,
} from '../src/lib/dataset-curation-queue.js';

function writeJsonl(filePath: string, rows: unknown[]): void {
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function makeFlow(id = 'flow-1') {
  return {
    id,
    version: '01.00.000',
    json_ordered: {
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': id,
          },
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.00.000',
          },
        },
      },
    },
  };
}

function makeProcess(flowId = 'flow-1') {
  return {
    id: 'process-1',
    version: '01.00.000',
    json_ordered: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'process-1',
          },
        },
        exchanges: {
          exchange: [
            {
              referenceToFlowDataSet: {
                '@refObjectId': flowId,
                '@version': '01.00.000',
              },
            },
          ],
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.00.000',
          },
        },
      },
    },
  };
}

function makeSource() {
  return {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: {
          'common:UUID': 'source-1',
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '01.00.000',
        },
      },
    },
  };
}

test('runDatasetCurationQueueBuild writes entity-level queue artifacts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-'));
  const processes = path.join(dir, 'processes.jsonl');
  const flows = path.join(dir, 'flows.jsonl');
  const support = path.join(dir, 'sources.jsonl');
  const outDir = path.join(dir, 'queue');
  writeJsonl(processes, [makeProcess()]);
  writeJsonl(flows, [makeFlow()]);
  writeJsonl(support, [makeSource()]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      flowsPath: flows,
      supportPaths: [support],
      outDir,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.counts.tasks, 3);
    assert.equal(report.counts.blockers, 0);
    assert.equal(existsSync(report.files.manifest), true);
    assert.equal(existsSync(report.files.tasks), true);
    assert.equal(existsSync(report.files.locks), true);
    assert.equal(existsSync(report.files.blockers), true);

    const supportTask = report.tasks.find((task) => task.entity_type === 'support');
    assert.ok(supportTask);
    assert.equal(supportTask.entity_id, 'source-1');
    assert.equal(supportTask.version, '01.00.000');

    const processTask = report.tasks.find((task) => task.entity_type === 'process');
    assert.ok(processTask);
    assert.deepEqual(processTask.depends_on, ['flow:flow-1@01.00.000']);
    assert.equal(existsSync(processTask.input_rows_file), true);
    assert.equal(existsSync(processTask.closure_file), true);
    assert.equal(existsSync(processTask.run_plan_file), true);
    assert.match(readFileSync(processTask.run_plan_file, 'utf8'), /dependency_closure/u);

    const manifest = readJson(report.files.manifest) as DatasetCurationQueueBuildReport;
    assert.equal(manifest.hashes.task_order, report.hashes.task_order);
    assert.deepEqual(manifest.counts, report.counts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueNext and verify use entity checkpoints', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-next-'));
  const processes = path.join(dir, 'processes.jsonl');
  const flows = path.join(dir, 'flows.jsonl');
  const support = path.join(dir, 'sources.jsonl');
  const outDir = path.join(dir, 'queue');
  writeJsonl(processes, [makeProcess()]);
  writeJsonl(flows, [makeFlow()]);
  writeJsonl(support, [makeSource()]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      flowsPath: flows,
      supportPaths: [support],
      outDir,
    });

    const first = await runDatasetCurationQueueNext({ queueDir: outDir });
    assert.equal(first.status, 'ready');
    assert.equal(first.next_task?.entity_type, 'support');

    for (const task of report.tasks.filter((candidate) => candidate.entity_type !== 'process')) {
      writeFileSync(task.checkpoint_file, JSON.stringify({ status: 'passed' }), 'utf8');
    }

    const processNext = await runDatasetCurationQueueNext({
      queueDir: outDir,
      entityType: 'process',
    });
    assert.equal(processNext.status, 'ready');
    assert.equal(processNext.next_task?.entity_type, 'process');

    const blockedVerify = await runDatasetCurationQueueVerify({ queueDir: outDir });
    assert.equal(blockedVerify.status, 'blocked');
    assert.equal(blockedVerify.counts.complete, 2);

    const processTask = report.tasks.find((candidate) => candidate.entity_type === 'process');
    assert.ok(processTask);
    writeFileSync(processTask.checkpoint_file, JSON.stringify({ status: 'completed' }), 'utf8');

    const passedVerify = await runDatasetCurationQueueVerify({ queueDir: outDir });
    assert.equal(passedVerify.status, 'passed');
    assert.equal(passedVerify.counts.complete, 3);

    const completeNext = await runDatasetCurationQueueNext({ queueDir: outDir });
    assert.equal(completeNext.status, 'complete');
    assert.equal(completeNext.next_task, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueBuild blocks unresolved process flow references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-blocker-'));
  const processes = path.join(dir, 'processes.jsonl');
  const flows = path.join(dir, 'flows.jsonl');
  const outDir = path.join(dir, 'queue');
  writeJsonl(processes, [makeProcess('missing-flow')]);
  writeJsonl(flows, [makeFlow()]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      flowsPath: flows,
      outDir,
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.counts.blockers, 1);
    assert.equal(report.blockers[0]?.code, 'process_flow_reference_unresolved');
    assert.match(readFileSync(report.files.blockers, 'utf8'), /missing-flow/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueBuild defers trace-backed unresolved elementary flow references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-deferred-'));
  const processes = path.join(dir, 'processes.jsonl');
  const outDir = path.join(dir, 'queue');
  const process = makeProcess('deferred-flow') as {
    json_ordered: {
      processDataSet: {
        processInformation: {
          dataSetInformation: Record<string, unknown>;
        };
      };
    };
  };
  process.json_ordered.processDataSet.processInformation.dataSetInformation['common:other'] = {
    '@xmlns:tiangongfoundry': 'https://tiangong.earth/foundry',
    'tiangongfoundry:unresolvedTrace': [
      {
        status: 'unresolved_deferred',
        action_item_code: 'elementary_flow_identity_manual_review',
        blocked_path: 'processDataSet.exchanges.exchange.0.referenceToFlowDataSet',
        reference_id: 'deferred-flow',
        reference_version: '01.00.000',
        reason: 'No safe public elementary flow match.',
      },
    ],
    'tiangongfoundry:unresolvedExchangeTrace': [
      {
        status: 'externalized_before_remote_write',
        action_item_code: 'elementary_flow_exchange_externalized',
        reference_id: 'trace-only-flow',
        original_exchange: {
          referenceToFlowDataSet: {
            '@refObjectId': 'trace-only-flow',
            '@version': '01.00.000',
          },
        },
      },
    ],
  };
  writeJsonl(processes, [process]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      outDir,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.counts.blockers, 0);
    const processTask = report.tasks.find((task) => task.entity_type === 'process');
    assert.ok(processTask);
    const closure = readJson(processTask.closure_file) as {
      dependencies?: {
        deferred_refs?: Array<{
          entity_id: string;
          version: string | null;
          action_item_code: string | null;
        }>;
        unresolved_refs?: unknown[];
      };
    };
    assert.equal(closure.dependencies?.deferred_refs?.[0]?.entity_id, 'deferred-flow');
    assert.equal(
      closure.dependencies?.deferred_refs?.[0]?.action_item_code,
      'elementary_flow_identity_manual_review',
    );
    assert.deepEqual(closure.dependencies?.unresolved_refs, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueBuild accepts external flow refs and focused process subsets', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-external-'));
  const processes = path.join(dir, 'processes.jsonl');
  const externalRefs = path.join(dir, 'external-flows.jsonl');
  const outDir = path.join(dir, 'queue');
  writeJsonl(processes, [makeProcess('external-flow'), makeProcess('skipped-flow')]);
  writeJsonl(externalRefs, [
    { id: 'external-flow', version: '02.00.000' },
    { id: 'external-unused' },
  ]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      externalFlowRefPaths: [externalRefs],
      excludeProcessIds: ['skipped-process', 'process-skip', 'process-2'],
      processLimit: 1,
      outDir,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.inputs.flows, null);
    assert.equal(report.counts.flow_rows, 0);
    assert.equal(report.counts.process_rows, 1);
    assert.equal(report.counts.external_flow_refs, 2);

    const processTask = report.tasks.find((task) => task.entity_type === 'process');
    assert.ok(processTask);
    const closure = readJson(processTask.closure_file) as {
      dependencies?: { external_refs?: Array<{ entity_id: string }> };
    };
    assert.equal(closure.dependencies?.external_refs?.[0]?.entity_id, 'external-flow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueBuild supports unversioned rows and sanitized entity directories', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-unversioned-'));
  const processes = path.join(dir, 'processes.jsonl');
  const outDir = path.join(dir, 'queue');
  writeJsonl(processes, [
    {
      id: '$$$',
      json_ordered: {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:UUID': '$$$',
            },
          },
        },
      },
    },
  ]);

  try {
    const report = await runDatasetCurationQueueBuild({
      processesPath: processes,
      outDir,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.tasks[0]?.version, 'unversioned');
    assert.match(report.tasks[0]?.work_dir ?? '', /unknown__unversioned/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetCurationQueueBuild validates required flags and row identities', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-errors-'));
  const processes = path.join(dir, 'processes.jsonl');
  const externalRefs = path.join(dir, 'external-flows.jsonl');
  writeJsonl(processes, [makeProcess()]);
  writeJsonl(externalRefs, [{ payload: {} }]);

  try {
    await assert.rejects(
      () => runDatasetCurationQueueBuild({ processesPath: '', outDir: path.join(dir, 'queue') }),
      /--processes is required/u,
    );
    await assert.rejects(
      () =>
        runDatasetCurationQueueBuild({
          processesPath: path.join(dir, 'missing.jsonl'),
          outDir: path.join(dir, 'queue'),
        }),
      /file does not exist/u,
    );
    await assert.rejects(
      () =>
        runDatasetCurationQueueBuild({
          processesPath: processes,
          processLimit: 0,
          outDir: path.join(dir, 'queue'),
        }),
      /--process-limit must be a positive integer/u,
    );
    await assert.rejects(
      () =>
        runDatasetCurationQueueBuild({
          processesPath: externalRefs,
          outDir: path.join(dir, 'queue'),
        }),
      /process row is missing a stable id/u,
    );
    await assert.rejects(
      () =>
        runDatasetCurationQueueBuild({
          processesPath: processes,
          externalFlowRefPaths: [externalRefs],
          outDir: path.join(dir, 'queue'),
        }),
      /External flow ref is missing id/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset curation queue flow ref extraction covers supported reference shapes', () => {
  const refs = __testInternals.extractProcessFlowRefs({
    noRef: 'ignored',
    flow_dataset: {
      refObjectId: 'flow-a',
      version: '01',
    },
    nested: [
      null,
      {
        reference_to_flow_dataset: {
          ref_object_id: 'flow-b',
          dataSetVersion: '02',
        },
      },
      {
        flowDataSet: {
          uuid: 'flow-c',
          'common:dataSetVersion': '03',
        },
      },
      {
        referenceToFlowDataSet: {
          'common:UUID': 'flow-d',
        },
      },
      {
        referenceToFlowDataSet: {
          id: 'flow-e',
        },
      },
    ],
  });

  assert.deepEqual(
    refs.map((ref) => `${ref.id}@${ref.version ?? ''}`),
    ['flow-a@01', 'flow-b@02', 'flow-c@03', 'flow-d@', 'flow-e@'],
  );
});

test('dataset curation queue internals cover parsing, scope, and checkpoint states', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-internals-'));
  const passedCheckpoint = path.join(dir, 'passed.json');
  const blockedCheckpoint = path.join(dir, 'blocked.json');
  const primitiveCheckpoint = path.join(dir, 'primitive.json');
  const invalidCheckpoint = path.join(dir, 'invalid.json');
  writeFileSync(passedCheckpoint, '{"status":"passed"}', 'utf8');
  writeFileSync(blockedCheckpoint, '{"state":"failed"}', 'utf8');
  writeFileSync(primitiveCheckpoint, '1', 'utf8');
  writeFileSync(invalidCheckpoint, '{bad-json}', 'utf8');
  try {
    assert.deepEqual(
      __testInternals.normalizeQueueScope({ entityType: 'flow', taskId: ' task ' }),
      {
        entity_type: 'flow',
        task_id: 'task',
      },
    );
    assert.equal(__testInternals.normalizeProcessLimit(undefined), null);
    assert.equal(__testInternals.normalizeProcessLimit(2), 2);
    assert.throws(() => __testInternals.normalizeProcessLimit(0), /--process-limit/u);
    assert.throws(() => __testInternals.requirePath('', '--flows'), /--flows is required/u);
    assert.throws(
      () => __testInternals.requireExistingPath(path.join(dir, 'missing'), '--flows'),
      /does not exist/u,
    );
    assert.equal(__testInternals.entityDirPlural('process'), 'processes');
    assert.equal(__testInternals.entityDirPlural('flow'), 'flows');
    assert.equal(__testInternals.entityDirPlural('support'), 'supports');
    assert.equal(__testInternals.sanitizePathToken(' a/b:c '), 'a_b_c');
    assert.equal(__testInternals.sanitizePathToken('@@@'), 'unknown');
    assert.equal(__testInternals.entityDirName('a/b', '01:00'), 'a_b__01_00');
    assert.equal(__testInternals.taskIdFor('flow', 'flow-1', '01.00.000'), 'flow:flow-1@01.00.000');
    assert.equal(__testInternals.jsonLines([{ a: 1 }]), '{"a":1}\n');
    assert.equal(__testInternals.jsonLines([]), '');

    const task = __testInternals.parseQueueTask(
      {
        entity_type: 'flow',
        task_id: 'flow:flow-1@01.00.000',
        entity_id: 'flow-1',
        version: '01.00.000',
        lock_key: 'flow:flow-1@01.00.000',
        depends_on: ['support:ug@1', 1],
        input_rows_file: 'input.jsonl',
        work_dir: 'work',
        checkpoint_file: passedCheckpoint,
        run_plan_file: 'plan.json',
        closure_file: 'closure.json',
      },
      'tasks.jsonl',
      0,
    );
    assert.deepEqual(task.depends_on, ['support:ug@1']);
    assert.throws(
      () => __testInternals.parseQueueTask(null, 'tasks.jsonl', 0),
      /Invalid queue task/u,
    );
    assert.throws(
      () => __testInternals.parseQueueTask({ entity_type: 'bad' }, 'tasks.jsonl', 0),
      /Invalid queue task entity_type/u,
    );
    assert.throws(
      () => __testInternals.parseQueueTask({ entity_type: 'flow' }, 'tasks.jsonl', 0),
      /Invalid or missing task_id/u,
    );
    assert.deepEqual(
      __testInternals.parseQueueBlocker(
        {
          entity_type: 'process',
          code: 'missing_flow',
          message: 'Missing flow',
          details: { id: 'flow-1' },
        },
        'blockers.jsonl',
        0,
      ),
      {
        schema_version: 1,
        code: 'missing_flow',
        severity: 'blocker',
        entity_type: 'process',
        entity_id: null,
        version: null,
        message: 'Missing flow',
        details: { id: 'flow-1' },
      },
    );
    assert.throws(
      () => __testInternals.parseQueueBlocker(null, 'blockers.jsonl', 0),
      /Invalid queue blocker/u,
    );
    assert.throws(
      () => __testInternals.parseQueueBlocker({ entity_type: 'bad' }, 'blockers.jsonl', 0),
      /Invalid queue blocker entity_type/u,
    );

    assert.equal(__testInternals.readCheckpointStatus(path.join(dir, 'missing.json')), null);
    assert.equal(__testInternals.readCheckpointStatus(passedCheckpoint), 'passed');
    assert.equal(__testInternals.readCheckpointStatus(blockedCheckpoint), 'failed');
    assert.equal(__testInternals.readCheckpointStatus(primitiveCheckpoint), 'blocked');
    assert.equal(__testInternals.readCheckpointStatus(invalidCheckpoint), 'blocked');
    assert.equal(__testInternals.taskRuntimeStatus('completed', []), 'complete');
    assert.equal(__testInternals.taskRuntimeStatus('failed', []), 'blocked');
    assert.equal(__testInternals.taskRuntimeStatus(null, ['dep']), 'waiting_dependencies');
    assert.equal(__testInternals.taskRuntimeStatus(null, []), 'pending');

    const states = __testInternals.buildTaskStates([
      task,
      {
        ...task,
        task_id: 'flow:flow-2@01.00.000',
        entity_id: 'flow-2',
        checkpoint_file: path.join(dir, 'missing.json'),
        depends_on: [task.task_id],
      },
      {
        ...task,
        task_id: 'flow:flow-3@01.00.000',
        entity_id: 'flow-3',
        checkpoint_file: blockedCheckpoint,
        depends_on: [],
      },
    ]);
    assert.deepEqual(
      states.map((state) => state.status),
      ['complete', 'pending', 'blocked'],
    );
    assert.deepEqual(__testInternals.countTaskStates(states), {
      total: 3,
      complete: 1,
      pending: 1,
      waiting_dependencies: 0,
      blocked: 1,
    });
    assert.equal(
      __testInternals.taskMatchesScope(task, { entity_type: 'process', task_id: null }),
      false,
    );
    assert.equal(
      __testInternals.taskMatchesScope(task, { entity_type: 'flow', task_id: 'missing' }),
      false,
    );
    assert.equal(__testInternals.withQueueAction(task).action.input_artifact, 'input.jsonl');

    const emptyJsonl = path.join(dir, 'empty.jsonl');
    const badJsonl = path.join(dir, 'bad.jsonl');
    writeFileSync(emptyJsonl, '\n', 'utf8');
    writeFileSync(badJsonl, '{bad-json}\n', 'utf8');
    assert.deepEqual(__testInternals.readJsonlFile(emptyJsonl), []);
    assert.throws(() => __testInternals.readJsonlFile(badJsonl), /Invalid JSONL/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset curation queue next and verify cover runtime blocker and complete states', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-curation-queue-runtime-'));
  const outputs = path.join(dir, 'outputs');
  mkdirSync(outputs, { recursive: true });
  const checkpoint = path.join(dir, 'checkpoint.json');
  writeFileSync(checkpoint, '{"status":"passed"}', 'utf8');
  const task = {
    schema_version: 1,
    entity_type: 'flow',
    task_id: 'flow:flow-1@01.00.000',
    entity_id: 'flow-1',
    version: '01.00.000',
    lock_key: 'flow:flow-1@01.00.000',
    depends_on: [],
    input_rows_file: path.join(dir, 'input.jsonl'),
    work_dir: dir,
    checkpoint_file: checkpoint,
    run_plan_file: path.join(dir, 'plan.json'),
    closure_file: path.join(dir, 'closure.json'),
  };
  writeJsonl(path.join(outputs, 'curation-queue-tasks.jsonl'), [task]);
  writeJsonl(path.join(outputs, 'curation-queue-blockers.jsonl'), []);
  try {
    assert.equal((await runDatasetCurationQueueNext({ queueDir: dir })).status, 'complete');
    assert.equal((await runDatasetCurationQueueVerify({ queueDir: dir })).status, 'passed');
    const runtime = __testInternals.readQueueRuntime(dir);
    assert.equal(runtime.tasks.length, 1);

    writeJsonl(path.join(outputs, 'curation-queue-blockers.jsonl'), [
      {
        entity_type: 'flow',
        code: 'blocked',
        message: 'Blocked queue',
      },
    ]);
    assert.equal((await runDatasetCurationQueueNext({ queueDir: dir })).status, 'blocked');
    assert.equal((await runDatasetCurationQueueVerify({ queueDir: dir })).status, 'blocked');

    rmSync(path.join(outputs, 'curation-queue-tasks.jsonl'));
    assert.throws(() => __testInternals.readQueueRuntime(dir), /tasks file does not exist/u);
    writeJsonl(path.join(outputs, 'curation-queue-tasks.jsonl'), [task]);
    rmSync(path.join(outputs, 'curation-queue-blockers.jsonl'));
    assert.throws(() => __testInternals.readQueueRuntime(dir), /blockers file does not exist/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
