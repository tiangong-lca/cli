import { createDatasetPorts } from '../src/adapters/dataset.js';
import { runDatasetCommand } from '../src/commands/dataset.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeDatasetWrite, type DatasetWritePorts } from '../src/application/dataset-write.js';
import { executeReviewWrite, type ReviewWritePorts } from '../src/application/review-write.js';
import type { DatasetRecord, JsonObject } from '../src/application/dataset-types.js';

const actor = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const version = '00.00.001';
const environment = 'https://example.test';
const content = { contactDataSet: {} };
const binding = { requestId: 'request', expectedActor: actor, expectedEnvironment: environment };

test('Dataset use case previews without durable intent and reconciles ambiguity without a second dispatch', async () => {
  let row: DatasetRecord | null = null;
  let journal: JsonObject | null = null;
  let writes = 0,
    journals = 0;
  const ports: DatasetWritePorts = {
    identity: async () => ({ environment, actor: { userId: actor } }),
    contentIdentity: () => ({ id, version }),
    read: async () => ({ environment, total: row ? 1 : 0, records: row ? [row] : [] }),
    qualify: async () => {},
    withJournal: async (_requestId, _target, execute) => {
      journals++;
      return execute({
        path: 'private-journal',
        read: () => journal,
        write: (value) => {
          journal = value;
        },
      });
    },
    dispatch: async (request) => {
      request.beforeDispatch();
      assert.equal(journal?.state, 'dispatched');
      writes++;
      row = { type: 'contact', id, version, content, owner: actor, stateCode: 0, modifiedAt: null };
      throw new Error('response lost after server effect');
    },
  };
  const request = { ...binding, id, version, content };
  assert.equal(
    (await executeDatasetWrite('contact', 'create', request, true, ports)).outcome,
    'preview_completed',
  );
  assert.equal(journals, 0);
  assert.equal(writes, 0);
  const first = await executeDatasetWrite('contact', 'create', request, false, ports);
  assert.equal(first.status, 'unknown');
  assert.deepEqual(first.data.readback, {
    available: true,
    contentMatchesIntent: true,
    establishesRequestOutcome: false,
  });
  assert.deepEqual(first.nextActions, []);
  assert.equal(
    (await executeDatasetWrite('contact', 'create', request, false, ports)).status,
    'unknown',
  );
  assert.equal(writes, 1);
  const commandPorts = createDatasetPorts({}, async () => {
    throw new Error('unexpected network');
  });
  commandPorts.mutate = async () => first;
  const presented = await runDatasetCommand(
    ['contact', 'create', '--input', '-', '--json'],
    commandPorts,
    () => request,
  );
  assert.equal(presented.exitCode, 1);
  assert.equal(
    JSON.parse(presented.stdout).nextActions[0].command,
    `tiangong-lca dataset contact get --id ${id} --version ${version} --json`,
  );
  assert.equal(writes, 1);
});

test('Review use case keeps reviewer draft and decision effects distinct through explicit ports', async () => {
  const calls: Array<{ action: string; body: JsonObject }> = [];
  const ports: ReviewWritePorts = {
    identity: async () => ({ environment, actor: { userId: actor } }),
    readDataset: async () => {
      throw new Error('reviewer actions do not select a dataset');
    },
    readReview: async () => ({
      environment,
      actor,
      total: 1,
      records: [{ id: reviewId, state_code: 0 }],
    }),
    endpoint: (action) => `test-service-${action}`,
    executeIntent: async (options) => {
      await options.preflight();
      return options.dispatch();
    },
    dispatch: async (action, body) => {
      calls.push({ action, body });
      return {
        ok: true,
        payload:
          action === 'decide' ? { ok: true, results: [{ reviewId, ok: true }] } : { ok: true },
      };
    },
  };
  const request = { ...binding, reviewId, expectedState: 0 };
  const draft = await executeReviewWrite(
    'comment',
    { ...request, json: { note: 'review draft' } },
    false,
    ports,
  );
  assert.equal(draft.outcome, 'review_draft_saved');
  assert.equal(calls[0]?.body.decision, undefined);
  const decision = await executeReviewWrite(
    'decide',
    { ...request, decision: 'reject', reason: 'Missing evidence' },
    false,
    ports,
  );
  assert.equal(decision.outcome, 'reviewer_decision_recorded');
  assert.deepEqual(calls[1], {
    action: 'decide',
    body: { reviewIds: [reviewId], decision: 'reject', reason: 'Missing evidence' },
  });
  assert.deepEqual(decision.nextActions, []);
  assert.equal(
    (await executeReviewWrite('comment', { ...request, json: {} }, true, ports)).outcome,
    'preview_completed',
  );
  assert.equal(calls.length, 2);
});
