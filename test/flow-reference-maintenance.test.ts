import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __testInternals as applyInternals } from '../src/lib/dataset-maintenance-apply.js';
import { runDatasetMaintenancePlan } from '../src/lib/dataset-maintenance-plan.js';
import {
  saveDraftMaintenanceRow,
  type DatasetMaintenanceRemoteContext,
} from '../src/lib/dataset-maintenance-remote.js';
import { sha256Json } from '../src/lib/canonical-json-hash.js';
import {
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceProgressEntry,
} from '../src/lib/maintenance/contract/types.js';
import { flowReferenceFixture } from './helpers/flow-reference-fixture.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

test('Flow maintenance planning and fresh preflight reject invalid factors; historical success remains readback-only', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flow-reference-maintenance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const actor = '11111111-1111-4111-8111-111111111111';
  const id = '22222222-2222-4222-8222-222222222222';
  const version = '01.00.000';
  const payload = {
    flowDataSet: {
      ...flowReferenceFixture().flowDataSet,
      flowInformation: {
        ...flowReferenceFixture().flowDataSet.flowInformation,
        dataSetInformation: { 'common:UUID': id },
      },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
  const before: DatasetMaintenanceRemoteRow = {
    table: 'flows',
    id,
    version,
    user_id: actor,
    state_code: 0,
    modified_at: '2026-07-01T00:00:00.000Z',
    json_ordered: structuredClone(payload),
    model_id: null,
    rule_verification: null,
  };
  let posts = 0;
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://flow-maintenance.example.com/functions/v1',
  });
  const scopePath = path.join(directory, 'scope.json');
  const desiredPath = path.join(directory, 'desired.json');
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      task_id: 'flow-rule',
      operation: 'repair-references',
      account: { user_id: actor },
      actions: [
        {
          action_id: 'save-flow',
          action: 'save_draft',
          table: 'flows',
          id,
          version,
          expected_user_id: actor,
          expected_state_code: 0,
          reason_code: 'CORRECT_CONTENT',
          reason: 'Explicit user-supplied correction',
          evidence: [],
          desired_payload_path: 'desired.json',
        },
      ],
    }),
  );
  const fetchImpl: DatasetMaintenanceRemoteContext['fetch_impl'] = async (input, init) => {
    if (isSupabaseAuthTokenUrl(String(input))) return makeSupabaseAuthResponse({ userId: actor });
    assert.equal(init?.method ?? 'GET', 'GET');
    const url = new URL(String(input));
    const body = url.pathname.endsWith('/auth/v1/user')
      ? { id: actor, email: 'owner@example.com' }
      : url.pathname.endsWith('/flows')
        ? [before]
        : [];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (key) =>
          key.toLowerCase() === 'content-range'
            ? Array.isArray(body) && body.length
              ? '0-0/1'
              : '*/0'
            : 'application/json',
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  };
  payload.flowDataSet.flowProperties.flowProperty[1]!.meanValue = '0.45';
  writeFileSync(desiredPath, JSON.stringify(payload));
  const blocked = await runDatasetMaintenancePlan({
    scopePath,
    operation: 'repair-references',
    outDir: path.join(directory, 'blocked'),
    env,
    fetchImpl,
  });
  assert.equal(blocked.status, 'blocked');
  const issue = blocked.actions[0]!.blockers.find((b) => b.code === 'reference_property_not_one');
  assert.ok(issue, JSON.stringify(blocked));
  assert.deepEqual(issue.details, { path: 'flowDataSet.flowProperties.flowProperty.1.meanValue' });

  payload.flowDataSet.flowProperties.flowProperty[1]!.meanValue = '1.0';
  writeFileSync(desiredPath, JSON.stringify(payload));
  const planDir = path.join(directory, 'ready');
  const plan = await runDatasetMaintenancePlan({
    scopePath,
    operation: 'repair-references',
    outDir: planDir,
    env,
    fetchImpl,
  });
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  const progress = {
    entries: [],
    successes: new Map<string, DatasetMaintenanceProgressEntry>(),
    latestFailures: new Map(),
  };
  applyInternals.assertApplyPreconditions({ plan, planDir, currentRows: [before], progress });
  // Simulate an older, sealed candidate. The new rule must run before any fresh dispatch.
  payload.flowDataSet.flowProperties.flowProperty[1]!.meanValue = '0.45';
  const action = plan.actions[0]!;
  writeFileSync(path.join(planDir, action.desired_payload!.path), JSON.stringify(payload));
  action.desired_payload!.sha256 = sha256Json(payload);
  assert.throws(
    () =>
      applyInternals.assertApplyPreconditions({ plan, planDir, currentRows: [before], progress }),
    { code: 'FLOW_REFERENCE_PROPERTY_INVALID' },
  );
  const historicalRow = { ...before, json_ordered: structuredClone(payload) };
  // The existing success entry is deliberately only observed by this internal preflight.
  progress.successes.set(action.action_id, {} as DatasetMaintenanceProgressEntry);
  applyInternals.assertApplyPreconditions({
    plan,
    planDir,
    currentRows: [historicalRow],
    progress,
  });
  const context: DatasetMaintenanceRemoteContext = {
    project_ref: 'flow-maintenance',
    rest_base_url: 'https://flow-maintenance.example.com/rest/v1',
    publishable_key: 'test',
    access_token: 'test',
    timeout_ms: 10,
    account: { user_id: actor, email: 'owner@example.com', session_source: 'test' },
    fetch_impl: async (_url, init) => {
      posts += 1;
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.p_json_ordered, payload);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async text() {
          return '{"ok":true}';
        },
      };
    },
  };
  const save = () =>
    saveDraftMaintenanceRow({
      context,
      table: 'flows',
      id,
      version,
      payload,
      modelId: null,
      ruleVerification: null,
      audit: {},
    });
  await assert.rejects(save, { code: 'FLOW_REFERENCE_PROPERTY_INVALID' });
  assert.equal(posts, 0);
  payload.flowDataSet.flowProperties.flowProperty[1]!.meanValue = '1.0';
  await save();
  assert.equal(posts, 1);
});
