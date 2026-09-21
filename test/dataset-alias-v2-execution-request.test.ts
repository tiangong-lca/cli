import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../src/lib/dataset-maintenance-contract.js';
import {
  ALIAS_V2_BINDING_KEYS,
  ALIAS_V2_ENVIRONMENTS,
  ALIAS_V2_PREFLIGHT_KEYS,
  ALIAS_V2_PREFLIGHT_SCHEMA,
  MAX_DERIVATIVE_TARGETS,
  MAX_PLAN_ACTIONS,
  MAX_PLAN_EXCHANGES,
  MAX_TEXT_ACTIONS,
  buildAliasV2PreflightRequest,
} from '../src/lib/dataset-alias-v2-execution-request.js';

const REQUEST_ID = '9f1c6f0e-6a2b-4a3f-9f0d-3b0d5a7c1e42';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);

function bindings() {
  return Object.fromEntries(ALIAS_V2_BINDING_KEYS.map((key) => [key, SHA('a')])) as Record<
    string,
    unknown
  >;
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'dataset-alias-plan.v2',
    actor_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    target_visibility: 'owner_draft',
    source_alias: { id: 'bd69e542-6a50-524c-8d04-195b1ec23150', version: '00.00.001' },
    source_evidence: { sha256: SHA('f'), exchange_count: 654 },
    target_snapshots: {
      flowproperty: {
        id: 'da11d28f-4db8-51eb-b3a9-8784b26771e6',
        version: '01.00.000',
        sha256: SHA('b'),
      },
      unitgroup: {
        id: '49ce0c2f-2241-54e3-8e75-e75ffbdaecfb',
        version: '01.00.000',
        sha256: SHA('c'),
      },
    },
    expected: {
      action_count: 387,
      batch_count: 1,
      exchange_count: 654,
      amount_field_count: 1308,
      unrelated_exchange_count: 4147,
      audit_count: 389,
      flowproperty_count: 0,
      flow_count: 113,
      process_count: 274,
      derivative_target_count: 387,
      text_action_count: 87,
    },
    dimensions: [{ dimension: 'time', factor: '0.00011415525114155251' }],
    text_actions: [{ process_id: 'p', before_text: '1.0 a x', after_text: '1.0 hr x' }],
    actions: [] as unknown[],
    plan_sha256: SHA('d'),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    environment: 'production',
    projectRef: 'qgzvkongdjqiiamzbbts',
    actor: { user_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7', email: 'owner@example.com' },
    plan: plan(),
    freeze: { schema_version: 'dataset-alias-execution-freeze.v2' },
    approval: { schema_version: 'dataset-alias-execution-approval.v2' },
    bindings: bindings(),
    expected: (plan() as { expected: unknown }).expected,
    derivativeTargets: [{ table: 'flows', id: 'f', version: '01.00.000' }],
    ...overrides,
  } as Parameters<typeof buildAliasV2PreflightRequest>[0];
}

function rejects(overrides: Record<string, unknown>, code: string): void {
  assert.throws(
    () => buildAliasV2PreflightRequest(request(overrides)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === code,
    code,
  );
}

test('the v2 preflight request keeps the real protected envelope shape', () => {
  const built = buildAliasV2PreflightRequest(request());
  assert.deepEqual(Object.keys(built).sort(), [...ALIAS_V2_PREFLIGHT_KEYS].sort());
  assert.equal(built.schema_version, ALIAS_V2_PREFLIGHT_SCHEMA);
  assert.equal(built.request_id, REQUEST_ID);
  assert.equal(built.target_visibility, 'owner_draft');
  assert.equal(built.environment, 'production');
  assert.deepEqual(built.actor, {
    user_id: 'c536ee37-64ab-427b-b7e3-4e2bb4fdffb7',
    email: 'owner@example.com',
  });
  assert.equal((built.plan as { schema_version: string }).schema_version, 'dataset-alias-plan.v2');
  assert.deepEqual(built.expected, (plan() as { expected: unknown }).expected);
  assert.ok(Array.isArray(built.derivative_targets) && built.derivative_targets.length === 1);
  for (const environment of ALIAS_V2_ENVIRONMENTS) {
    assert.equal(buildAliasV2PreflightRequest(request({ environment })).environment, environment);
  }
});

test('malformed shape, identity and unsupported transformations are refused (400)', () => {
  const invalid = 'ALIAS_V2_PREFLIGHT_INVALID_REQUEST';
  for (const requestId of ['', 'not-a-uuid', `${REQUEST_ID}0`, REQUEST_ID.toUpperCase()]) {
    rejects({ requestId }, invalid);
  }
  rejects({ environment: 'dev' }, invalid);
  rejects({ projectRef: '   ' }, invalid);
  rejects({ projectRef: 'p'.repeat(129) }, invalid);
  rejects({ actor: { user_id: 'u' } }, invalid);
  rejects({ actor: { user_id: 'u', email: 'e', extra: 'x' } }, invalid);
  rejects({ actor: { user_id: 'u', email: `${'e'.repeat(320)}@x` } }, invalid);
  rejects({ plan: plan({ schema_version: 'dataset-alias-plan.v1' }) }, invalid);
  rejects({ plan: plan({ dimensions: [] }) }, invalid);
  rejects({ plan: plan({ dimensions: [{ dimension: 'length_time' }] }) }, invalid);
  rejects({ plan: plan({ dimensions: [{ dimension: 'time' }, { dimension: 'time' }] }) }, invalid);
  rejects({ plan: plan({ schema_version: 'dataset-alias-plan.v2', extra: 1 }) }, invalid);
  rejects({ plan: plan({ expected: undefined }) }, invalid);
  rejects(
    {
      plan: plan({
        expected: {
          ...(plan() as { expected: Record<string, unknown> }).expected,
          action_count: -1,
        },
      }),
    },
    invalid,
  );
  rejects(
    {
      plan: plan({
        expected: {
          ...(plan() as { expected: Record<string, unknown> }).expected,
          flow_count: 1.5,
        },
      }),
    },
    invalid,
  );
  rejects({ plan: plan({ target_visibility: 'owner' }) }, invalid);
  rejects({ plan: plan({ source_evidence: 'nope' }) }, invalid);
  rejects({ plan: plan({ target_snapshots: undefined }) }, invalid);
  rejects({ plan: plan({ actions: 'nope' }) }, invalid);
  rejects({ plan: plan({ text_actions: undefined }) }, invalid);
  rejects({ freeze: { schema_version: 'dataset-alias-execution-freeze.v1' } }, invalid);
  rejects({ approval: { schema_version: 'dataset-alias-execution-approval.v1' } }, invalid);
  rejects({ bindings: { ...bindings(), extra: SHA('a') } }, invalid);
  rejects(
    { bindings: Object.fromEntries(ALIAS_V2_BINDING_KEYS.slice(1).map((k) => [k, SHA('a')])) },
    invalid,
  );
  rejects({ bindings: { ...bindings(), plan_file_sha256: 'not-a-hash' } }, invalid);
  rejects({ expected: { action_count: 388 } }, invalid);
  rejects({ expected: { ...(plan() as { expected: JsonObject }).expected, extra: 1 } }, invalid);
  rejects({ derivativeTargets: [] }, invalid);
  rejects({ derivativeTargets: 'nope' }, invalid);
  rejects({ derivativeTargets: ['nope'] }, invalid);
  // An unknown top-level key cannot be smuggled in either.
  assert.throws(
    () =>
      buildAliasV2PreflightRequest({ ...request(), extra_top_level: 1 } as Parameters<
        typeof buildAliasV2PreflightRequest
      >[0]),
    (error: unknown) =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === invalid,
  );
});

test('explicit upper bounds are enforced and oversize requests are refused (413)', () => {
  const tooLarge = 'ALIAS_V2_PREFLIGHT_REQUEST_TOO_LARGE';
  rejects({ plan: plan({ actions: new Array(MAX_PLAN_ACTIONS + 1).fill({}) }) }, tooLarge);
  rejects(
    {
      plan: plan({
        expected: {
          ...(plan() as { expected: Record<string, number> }).expected,
          exchange_count: MAX_PLAN_EXCHANGES + 1,
        },
      }),
      expected: {
        ...(plan() as { expected: Record<string, number> }).expected,
        exchange_count: MAX_PLAN_EXCHANGES + 1,
      },
    },
    tooLarge,
  );
  rejects({ plan: plan({ text_actions: new Array(MAX_TEXT_ACTIONS + 1).fill({}) }) }, tooLarge);
  rejects(
    { derivativeTargets: new Array(MAX_DERIVATIVE_TARGETS + 1).fill({ table: 'flows' }) },
    tooLarge,
  );
  // The expected block is part of the request: an oversize plan-bound block is refused as too
  // large rather than dispatched.
  const padded = plan() as { expected: Record<string, number> };
  padded.expected['text_action_count'] = 87;
  rejects(
    {
      plan: plan({ actions: [{ padding: 'x'.repeat(64 * 1024 * 1024) }] }),
    },
    tooLarge,
  );
});

test('the built request is plan-bound: expected counts must equal the plan counts', () => {
  const built = buildAliasV2PreflightRequest(request());
  assert.deepEqual(built.expected, (built.plan as { expected: unknown }).expected);
  rejects(
    {
      expected: {
        ...(plan() as { expected: Record<string, number> }).expected,
        process_count: 275,
      },
    },
    'ALIAS_V2_PREFLIGHT_INVALID_REQUEST',
  );
});
