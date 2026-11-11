import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionsFor,
  datasetTypes,
  type DatasetPorts,
  type ReviewRead,
} from '../src/application/dataset-types.js';
import { runDatasetCommand, runDatasetHelp } from '../src/commands/dataset.js';
import { runReviewCommand } from '../src/commands/review.js';
import { flags } from '../src/commands/dataset/help.js';
import { rootHelp } from '../src/commands/help.js';
import { datasetMutationContinuation } from '../src/commands/mutation-presentation.js';
import { renderCommandHelp } from '../src/commands/help-text.js';
import { result } from '../src/shared/command-result.js';
import { commandFailure } from '../src/shared/command-errors.js';
import { runLockCommandError } from '../src/lib/locks/command-error.js';
import { BatchRunLockIdentityConflictError, BatchRunLockTimeoutError } from '../src/batch.js';
import { withBatchRunLock } from '../src/lib/locks/run-lock.js';
import { withMutationJournal } from '../src/adapters/private-mutation-journal.js';
import { contentDigest } from '../src/application/dataset-content.js';
import { HttpResponseError, postJson } from '../src/lib/transport/http.js';
import { serviceRejection } from '../src/application/service-rejection.js';

let effects = 0;
const unexpected = async (): Promise<never> => {
  effects++;
  throw new Error('unexpected IO');
};
const ports: DatasetPorts = {
  read: unexpected,
  search: unexpected,
  contract: unexpected,
  validate: unexpected,
  operations: unexpected,
  mutate: unexpected,
  now: () => 'test',
};
const read: ReviewRead = unexpected;

test('each Dataset action has text and machine help with only applicable options and defaults', async () => {
  for (const type of datasetTypes) {
    const group = JSON.parse((await runDatasetCommand([type, '--help', '--json'], ports)).stdout);
    const implemented = actionsFor(type);
    for (const action of Object.keys(flags))
      assert.equal(action in group.unavailableActions, !implemented.includes(action as never));
    for (const action of implemented) {
      const args = [type, ...action.split(' '), '--help'];
      const human = await runDatasetCommand(args, ports);
      const machine = await runDatasetCommand([...args, '--json'], ports);
      assert.equal(human.exitCode, 0);
      assert.equal(machine.exitCode, 0);
      assert.match(human.stdout, /^Usage: tiangong-lca dataset /u);
      const manifest = JSON.parse(machine.stdout);
      assert.ok(human.stdout.includes(manifest.command));
      if (!['list', 'versions', 'search', 'list-references'].includes(action))
        assert.equal('limit' in manifest.defaults, false);
      if (action !== 'validate') assert.equal('checks' in manifest.defaults, false);
      if (action === 'search') assert.equal(manifest.options.includes('cursor'), false);
    }
    assert.match((await runDatasetCommand([type, '--help'], ports)).stdout, /Actions:/u);
  }
  assert.equal(effects, 0);
});

test('translations is a discoverable group whose canonical operation never contains flags or undefined', async () => {
  for (const args of [[], ['--help'], ['--json'], ['--help', '--json']]) {
    const response = await runDatasetCommand(['flow', 'translations', ...args], ports);
    assert.equal(response.exitCode, 0);
    if (args.includes('--json'))
      assert.equal(JSON.parse(response.stdout).command, 'dataset flow translations');
    else assert.match(response.stdout, /translations/u);
    assert.doesNotMatch(response.stdout, /undefined/u);
  }
  for (const [type, args, code] of [
    ['flow', ['--bad'], 'ARGUMENTS_INVALID'],
    ['flow', ['missing', '--json'], 'CAPABILITY_UNSUPPORTED'],
    ['unitgroup', ['--json'], 'CAPABILITY_UNSUPPORTED'],
  ] as const) {
    const response = await runDatasetCommand([type, 'translations', ...args], ports);
    assert.equal(response.exitCode, 2);
    const value = JSON.parse(
      (
        await runDatasetCommand(
          [type, 'translations', ...args.filter((x) => x !== '--json'), '--json'],
          ports,
        )
      ).stdout,
    );
    assert.equal(value.error.code, code);
    assert.doesNotMatch(value.operation, /--|undefined/u);
  }
  const rejected = await runDatasetCommand(
    ['flow', 'search', '--query', 'test', '--cursor', 'x', '--json'],
    ports,
  );
  assert.equal(rejected.exitCode, 2);
  assert.equal(effects, 0);
});

test('Review text and machine help are distinct and retained tools are discoverable', async () => {
  for (const action of [
    '',
    'submit',
    'resubmit',
    'get',
    'list',
    'materials',
    'comment',
    'decide',
    'withdraw',
  ]) {
    const args = [...(action ? [action] : []), '--help'];
    const human = await runReviewCommand(args, read);
    const machine = await runReviewCommand([...args, '--json'], read);
    assert.match(human.stdout, /^Usage: tiangong-lca review/u);
    const manifest = JSON.parse(machine.stdout);
    assert.equal(manifest.command, `review${action ? ' ' + action : ''}`);
    assert.equal('limit' in manifest.defaults, action === 'list');
    assert.ok(!('role' in manifest.defaults));
  }
  const manifest = JSON.parse(rootHelp('').stdout);
  assert.ok(manifest.commands.study);
  assert.deepEqual(manifest.commands.dataset.maintenance, [
    'plan',
    'apply',
    'verify',
    'clear-account',
  ]);
  assert.deepEqual(manifest.commands.dataset['import-lca'], ['convert']);
  assert.ok(JSON.parse(runDatasetHelp(['--json']).stdout).maintenance.includes('verify'));
  assert.match(runDatasetHelp([]).stdout, /Maintenance: dataset maintenance/u);
  assert.equal(effects, 0);
  assert.match(renderCommandHelp({ command: 'minimal' }), /^Usage:/u);
  assert.match(
    renderCommandHelp({
      command: 'test',
      input: { content: { name: 'given' }, nullable: null },
      options: [],
      effects: undefined,
    }),
    /content.name: given/u,
  );
});

test('delete and upload previews present only observed facts', async () => {
  const deleted = result('dataset flow delete');
  deleted.outcome = 'dataset_deleted';
  deleted.data.subject = { type: 'flow', id: 'x', version: '01' };
  datasetMutationContinuation(deleted);
  assert.equal(deleted.nextActions[0]!.command, undefined);
  assert.doesNotMatch(JSON.stringify(deleted.nextActions), /saved| get /u);
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-preview-'));
  try {
    const input = path.join(root, 'input.json');
    writeFileSync(input, '{}');
    const response = await runDatasetCommand(
      ['source', 'upload-attachments', '--input', input, '--dry-run', '--json'],
      {
        ...ports,
        operations: async () => ({
          status: 'preview_completed',
          outcome: 'preview_completed',
          summary: 'Preview',
          qualification: {},
        }),
      },
    );
    assert.equal(response.exitCode, 0);
    const value = JSON.parse(response.stdout);
    assert.equal(value.outcome, 'preview_completed');
    assert.match(value.replyTemplate, /preview-result\.md$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Review list discloses unknown total without claiming a complete snapshot', async () => {
  const reply = await runReviewCommand(['list', '--role', 'submitter', '--json'], async () => ({
    records: [],
    total: null,
    actor: 'actor',
    environment: 'test',
  }));
  assert.equal(reply.exitCode, 0);
  const value = JSON.parse(reply.stdout);
  assert.equal(value.completeness.truncated, true);
  assert.equal(value.completeness.hasMore, null);
  assert.equal(value.completeness.nextCursor, null);
  assert.equal(value.completeness.scope, 'current_visible_query');
});

test('lock errors retain safe code/category at the CLI boundary and journal contention uses that projection', async () => {
  const errors = [
    new BatchRunLockIdentityConflictError({
      runPath: '/private',
      activeIdentitySha256: 'a',
      requestedIdentitySha256: 'b',
    }),
    new BatchRunLockTimeoutError({
      runPath: '/private',
      lockPath: '/private/lock',
      identitySha256: 'a',
      waitedMs: 1,
      owner: { secret: 'hidden' },
    }),
  ];
  for (const [index, error] of errors.entries()) {
    const projected = commandFailure(runLockCommandError(error), 'DATASET_OPERATION_FAILED');
    assert.equal(projected.code, error.code);
    assert.equal(projected.category, index === 0 ? 'conflict' : 'precondition');
    assert.equal(projected.exitCode, 1);
    assert.ok(!JSON.stringify(projected).includes('/private'));
  }
  const ordinary = new Error('ordinary');
  assert.equal(runLockCommandError(ordinary), ordinary);
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-lock-'));
  try {
    await withBatchRunLock(
      { runPath: path.join(root, contentDigest('request')), identity: 'other', reason: 'fixture' },
      async () => {
        await assert.rejects(
          withMutationJournal(
            { directory: root, requestId: 'request', target: 'target', scope: 'dataset' },
            unexpected,
          ),
          (error) => commandFailure(error, 'fallback').category === 'conflict',
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP refusal envelopes are observable without changing raw failure or ambiguity semantics', async () => {
  for (const body of ['{"ok":false,"code":"VERSION_CONFLICT"}', 'not JSON']) {
    await assert.rejects(
      postJson({
        url: 'https://example.test',
        headers: {},
        body: {},
        timeoutMs: 1000,
        fetchImpl: async () => new Response(body, { status: 409 }),
      }),
      (error) => {
        assert.ok(error instanceof HttpResponseError);
        assert.equal(error.status, 409);
        assert.equal(error.details, body);
        assert.deepEqual(
          error.payload,
          body === 'not JSON' ? null : { ok: false, code: 'VERSION_CONFLICT' },
        );
        return true;
      },
    );
  }
  for (const payload of [
    null,
    [],
    {},
    { ok: false, code: 'unknown' },
    { ok: false, code: 'VERSION_CONFLICT', data: { written: true } },
    { ok: false, code: 'VERSION_CONFLICT', results: [{ ok: true }] },
    { ok: false, code: 'VERSION_CONFLICT', status: 500 },
    { ok: false, code: 3 },
  ])
    assert.equal(serviceRejection(payload), null);
  assert.equal(serviceRejection({ ok: false, code: 'VERSION_CONFLICT' }, 100), null);
});
