import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals as applyInternals,
  runDatasetMaintenanceApply,
} from '../src/lib/dataset-maintenance-apply.js';
import {
  __testInternals as aliasInternals,
  buildAliasRewritePlan,
  multiplyExactDecimal,
} from '../src/lib/dataset-maintenance-alias-rewrite.js';
import {
  appendStableJsonLine,
  computePlanSha256,
  isJsonObject,
  maintenanceRowKey,
  parseMaintenancePlan,
  parseMaintenanceScope,
  readJsonFile,
  readJsonLinesIfPresent,
  resolveMaintenancePlanArtifactPath,
  safeActionFileName,
  sha256Json,
  sha256Text,
  snapshotRemoteRow,
  stableJsonText,
  stableJsonValue,
  writeImmutableJson,
  writeImmutableJsonLines,
  type DatasetMaintenancePlan,
  type DatasetMaintenanceAliasBatch,
  type DatasetMaintenancePlanAction,
  type DatasetMaintenanceProgressEntry,
  type DatasetMaintenanceRemoteRow,
  type DatasetMaintenanceScopeAction,
  type JsonObject,
} from '../src/lib/dataset-maintenance-contract.js';
import {
  __testInternals as planInternals,
  runDatasetMaintenancePlan,
} from '../src/lib/dataset-maintenance-plan.js';
import {
  __testInternals as remoteInternals,
  collectMaintenanceDraftNameIssues,
  deleteMaintenanceRow,
  fetchMaintenanceAccountRows,
  fetchMaintenanceExactRows,
  fetchMaintenanceVisibleTableRows,
  normalizeMaintenancePageSize,
  normalizeMaintenanceTimeout,
  resolveMaintenanceRemoteContext,
  saveDraftMaintenanceRow,
} from '../src/lib/dataset-maintenance-remote.js';
import {
  __testInternals as verifyInternals,
  runDatasetMaintenanceVerify,
} from '../src/lib/dataset-maintenance-verify.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike, ResponseLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type StoredRow = Omit<DatasetMaintenanceRemoteRow, 'table'>;

const PASSING_SUPPORT_SCHEMAS = {
  unitgroups: { safeParse: () => ({ success: true as const }) },
  flowproperties: { safeParse: () => ({ success: true as const }) },
};

function assertExactKeySet(value: JsonObject, expected: readonly string[], label: string): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} must match the DB #234 JSON allowlist exactly`,
  );
}

function assertExactAliasBatchRequestContract(batch: JsonObject): void {
  assertExactKeySet(
    batch,
    [
      'schema_version',
      'plan_sha256',
      'operation_id',
      'batch_id',
      'dimension',
      'factor',
      'target_visibility',
      'target',
      'actions',
    ],
    'alias batch',
  );
  assert.equal(batch.schema_version, 'dataset-alias-batch.v1');
  assert.equal(batch.target_visibility, 'owner_draft');

  assert.ok(isJsonObject(batch.target));
  assertExactKeySet(batch.target, ['flowproperty', 'unitgroup', 'source_unitgroup'], 'target');
  for (const [name, target] of Object.entries(batch.target)) {
    assert.ok(isJsonObject(target));
    assertExactKeySet(
      target,
      ['id', 'version', 'expected_modified_at', 'expected_json_ordered'],
      `target.${name}`,
    );
  }

  assert.ok(Array.isArray(batch.actions));
  for (const [index, action] of batch.actions.entries()) {
    assert.ok(isJsonObject(action));
    assertExactKeySet(
      action,
      [
        'action_id',
        'action',
        'table',
        'id',
        'version',
        'expected_state_code',
        'expected_modified_at',
        'expected_json_ordered',
        'desired_json_ordered',
        'mutation',
      ],
      `actions[${index}]`,
    );
    assert.equal(action.action, 'update_json_ordered');
    assert.equal(action.expected_state_code, 0);
    assert.ok(isJsonObject(action.mutation));
    if (action.table === 'flowproperties') {
      assertExactKeySet(action.mutation, ['kind'], `actions[${index}].mutation`);
    } else if (action.table === 'flows') {
      assertExactKeySet(
        action.mutation,
        [
          'kind',
          'flow_property_internal_id',
          'source_flowproperty_id',
          'source_flowproperty_version',
        ],
        `actions[${index}].mutation`,
      );
    } else {
      assert.equal(action.table, 'processes');
      assertExactKeySet(action.mutation, ['kind', 'exchanges'], `actions[${index}].mutation`);
      assert.ok(Array.isArray(action.mutation.exchanges));
      for (const [exchangeIndex, exchange] of action.mutation.exchanges.entries()) {
        assert.ok(isJsonObject(exchange));
        assertExactKeySet(
          exchange,
          [
            'index',
            'internal_id',
            'flow_id',
            'flow_version',
            'direction',
            'before_exchange_sha256',
          ],
          `actions[${index}].mutation.exchanges[${exchangeIndex}]`,
        );
      }
    }
  }
}

function assertExactAliasPlanRequestContract(plan: JsonObject): void {
  assertExactKeySet(
    plan,
    ['schema_version', 'plan_sha256', 'operation_id', 'target_visibility', 'batches'],
    'alias plan',
  );
  assert.equal(plan.schema_version, 'dataset-alias-plan.v1');
  assert.equal(plan.target_visibility, 'owner_draft');
  assert.ok(Array.isArray(plan.batches));
  assert.equal(plan.batches.length, 2);
  const [time, lengthTime] = plan.batches;
  assert.ok(isJsonObject(time));
  assert.ok(isJsonObject(lengthTime));
  assert.equal(time.dimension, 'time');
  assert.equal(lengthTime.dimension, 'length_time');
  for (const batch of plan.batches) {
    assert.ok(isJsonObject(batch));
    assert.equal(batch.plan_sha256, plan.plan_sha256);
    assert.equal(batch.operation_id, plan.operation_id);
    assert.equal(batch.target_visibility, plan.target_visibility);
    assertExactAliasBatchRequestContract(batch);
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ResponseLike {
  const defaultContentRange = Array.isArray(body)
    ? body.length > 0
      ? `0-${body.length - 1}/${body.length}`
      : '*/0'
    : null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const normalized = name.toLowerCase();
        if (normalized === 'content-type') return 'application/json';
        if (normalized === 'content-range') {
          return headers['content-range'] ?? defaultContentRange;
        }
        return headers[normalized] ?? null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(body);
    },
  };
}

function processPayload(options: { id: string; version: string; sourceId?: string }): JsonObject {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: { 'common:UUID': options.id },
      },
      ...(options.sourceId
        ? {
            modellingAndValidation: {
              dataSourcesTreatmentAndRepresentativeness: {
                referenceToDataSource: {
                  '@refObjectId': options.sourceId,
                  '@version': '01.00.000',
                  '@type': 'source data set',
                },
              },
            },
          }
        : {}),
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

function sourcePayload(id: string, version = '01.00.000'): JsonObject {
  return {
    sourceDataSet: {
      sourceInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function flowPayload(id: string, version = '01.00.000'): JsonObject {
  return {
    flowDataSet: {
      flowInformation: { dataSetInformation: { 'common:UUID': id } },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function processFlowReferencePayload(options: {
  processId: string;
  flowId: string;
  version?: string;
}): JsonObject {
  const version = options.version ?? '01.00.000';
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': options.processId } },
      exchanges: {
        exchange: {
          '@dataSetInternalID': '1',
          referenceToFlowDataSet: {
            '@refObjectId': options.flowId,
            '@version': version,
            '@type': 'flow data set',
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': version },
      },
    },
  };
}

function aliasId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function aliasReference(
  kind: 'unitgroups' | 'flowproperties' | 'flows',
  id: string,
  version: string,
  name: string,
): JsonObject {
  const type =
    kind === 'unitgroups'
      ? 'unit group data set'
      : kind === 'flowproperties'
        ? 'flow property data set'
        : 'flow data set';
  return {
    '@refObjectId': id,
    '@type': type,
    '@uri': `../${kind}/${id}.json`,
    '@version': version,
    'common:shortDescription': { '#text': name, '@xml:lang': 'en' },
  };
}

function aliasUnitGroupPayload(options: {
  id: string;
  version: string;
  referenceName: string;
  targetUnits?: Array<{ id: string; mean: string; name: string }>;
}): JsonObject {
  return {
    unitGroupDataSet: {
      unitGroupInformation: {
        dataSetInformation: {
          'common:UUID': options.id,
          'common:name': { '#text': `Units of ${options.referenceName}`, '@xml:lang': 'en' },
        },
        quantitativeReference: { referenceToReferenceUnit: '1' },
      },
      units: {
        unit: (options.targetUnits ?? [{ id: '1', mean: '1.0', name: options.referenceName }]).map(
          (unit) => ({
            '@dataSetInternalID': unit.id,
            meanValue: unit.mean,
            name: unit.name,
          }),
        ),
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

function aliasFlowPropertyPayload(options: {
  id: string;
  version: string;
  name: string;
  unitGroupReference: JsonObject;
}): JsonObject {
  return {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: {
          'common:UUID': options.id,
          'common:name': { '#text': options.name, '@xml:lang': 'en' },
        },
        quantitativeReference: {
          referenceToReferenceUnitGroup: options.unitGroupReference,
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

function aliasFlowPayload(options: {
  id: string;
  version: string;
  flowPropertyReference: JsonObject;
}): JsonObject {
  return {
    flowDataSet: {
      flowInformation: { dataSetInformation: { 'common:UUID': options.id } },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '1',
          meanValue: '1',
          referenceToFlowPropertyDataSet: options.flowPropertyReference,
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

function aliasProcessPayload(options: {
  id: string;
  version: string;
  exchanges: JsonObject[];
}): JsonObject {
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': options.id } },
      exchanges: { exchange: options.exchanges },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': options.version },
      },
    },
  };
}

type AliasFixture = {
  scope: JsonObject;
  selected_exchange_count: number;
};

function seedAliasFixture(remote: FakeMaintenanceRemote): AliasFixture {
  const draftVersion = '00.00.001';
  const publicVersion = '01.00.000';
  const unrelatedFlowId = aliasId(999_999);
  const batches = [
    {
      batch_id: 'time',
      dimension: 'time',
      factor: '0.00011415525114155251',
      sourceUnitGroupId: aliasId(1),
      sourceFlowPropertyId: aliasId(2),
      targetUnitGroupId: aliasId(3),
      targetFlowPropertyId: aliasId(4),
      sourceName: 'hr',
      targetName: 'Time',
      flowCount: 10,
      processCount: 14,
      selectedCount: 20,
      unrelatedCount: 155,
      existingTargetFlowCount: 96,
      existingTargetExchangeCount: 421,
      targetUnits: [
        { id: '1', mean: '1.0', name: 'a' },
        { id: '4', mean: '0.00011415525114155251', name: 'hr' },
      ],
    },
    {
      batch_id: 'length_time',
      dimension: 'length_time',
      factor: '1000',
      sourceUnitGroupId: aliasId(101),
      sourceFlowPropertyId: aliasId(102),
      targetUnitGroupId: aliasId(103),
      targetFlowPropertyId: aliasId(104),
      sourceName: 'kmy',
      targetName: 'Length*time',
      flowCount: 13,
      processCount: 13,
      selectedCount: 39,
      unrelatedCount: 154,
      existingTargetFlowCount: 19,
      existingTargetExchangeCount: 3177,
      targetUnits: [
        { id: '1', mean: '1.0', name: 'm*a' },
        { id: '4', mean: '1000.0', name: 'kmy' },
      ],
    },
  ] as const;
  const scopeActions: JsonObject[] = [];
  const scopeBatches: JsonObject[] = [];
  let nextId = 10_000;

  for (const batch of batches) {
    const sourceUnitGroupRef = aliasReference(
      'unitgroups',
      batch.sourceUnitGroupId,
      draftVersion,
      `Units of ${batch.sourceName}`,
    );
    const targetUnitGroupRef = aliasReference(
      'unitgroups',
      batch.targetUnitGroupId,
      publicVersion,
      batch.batch_id === 'time' ? 'Units of time' : 'Units of length*time',
    );
    const sourceFlowPropertyRef = aliasReference(
      'flowproperties',
      batch.sourceFlowPropertyId,
      draftVersion,
      `Amount in ${batch.sourceName}`,
    );
    const targetFlowPropertyRef = aliasReference(
      'flowproperties',
      batch.targetFlowPropertyId,
      publicVersion,
      batch.targetName,
    );
    remote.add(
      'unitgroups',
      batch.sourceUnitGroupId,
      aliasUnitGroupPayload({
        id: batch.sourceUnitGroupId,
        version: draftVersion,
        referenceName: batch.sourceName,
      }),
      { version: draftVersion },
    );
    remote.add(
      'unitgroups',
      batch.targetUnitGroupId,
      aliasUnitGroupPayload({
        id: batch.targetUnitGroupId,
        version: publicVersion,
        referenceName: batch.batch_id === 'time' ? 'time' : 'length*time',
        targetUnits: [...batch.targetUnits],
      }),
      { version: publicVersion },
    );
    remote.add(
      'flowproperties',
      batch.sourceFlowPropertyId,
      aliasFlowPropertyPayload({
        id: batch.sourceFlowPropertyId,
        version: draftVersion,
        name: `Amount in ${batch.sourceName}`,
        unitGroupReference: sourceUnitGroupRef,
      }),
      { version: draftVersion },
    );
    remote.add(
      'flowproperties',
      batch.targetFlowPropertyId,
      aliasFlowPropertyPayload({
        id: batch.targetFlowPropertyId,
        version: publicVersion,
        name: batch.targetName,
        unitGroupReference: targetUnitGroupRef,
      }),
      { version: publicVersion },
    );
    scopeActions.push({
      action_id: `${batch.batch_id}-flowproperty`,
      action: 'update_json_ordered',
      table: 'flowproperties',
      id: batch.sourceFlowPropertyId,
      version: draftVersion,
      expected_user_id: remote.userId,
      expected_state_code: 0,
      reason_code: 'FP_ALIAS_REWRITE',
      reason: 'Move the alias flowproperty to the canonical unitgroup.',
      evidence: ['fpug-step2-alias-preflight/analysis-report.json'],
      batch_id: batch.batch_id,
    });

    const affectedFlowIds: string[] = [];
    for (let index = 0; index < batch.flowCount; index += 1) {
      const flowId = aliasId(nextId++);
      affectedFlowIds.push(flowId);
      remote.add(
        'flows',
        flowId,
        aliasFlowPayload({
          id: flowId,
          version: draftVersion,
          flowPropertyReference: sourceFlowPropertyRef,
        }),
        { version: draftVersion },
      );
      scopeActions.push({
        action_id: `${batch.batch_id}-flow-${index}`,
        action: 'update_json_ordered',
        table: 'flows',
        id: flowId,
        version: draftVersion,
        expected_user_id: remote.userId,
        expected_state_code: 0,
        reason_code: 'FLOW_PROPERTY_ALIAS_REWRITE',
        reason: 'Use the canonical flowproperty reference.',
        evidence: [],
        batch_id: batch.batch_id,
      });
    }
    const existingTargetFlowIds: string[] = [];
    for (let index = 0; index < batch.existingTargetFlowCount; index += 1) {
      const flowId = aliasId(nextId++);
      existingTargetFlowIds.push(flowId);
      remote.add(
        'flows',
        flowId,
        aliasFlowPayload({
          id: flowId,
          version: draftVersion,
          flowPropertyReference: targetFlowPropertyRef,
        }),
        { version: draftVersion },
      );
    }

    let selectedRemaining = batch.selectedCount;
    let unrelatedRemaining = batch.unrelatedCount;
    for (let processIndex = 0; processIndex < batch.processCount; processIndex += 1) {
      const processId = aliasId(nextId++);
      const processSlotsRemaining = batch.processCount - processIndex;
      const selectedHere = Math.ceil(selectedRemaining / processSlotsRemaining);
      const unrelatedHere = Math.ceil(unrelatedRemaining / processSlotsRemaining);
      selectedRemaining -= selectedHere;
      unrelatedRemaining -= unrelatedHere;
      const exchanges: JsonObject[] = [];
      const exchangeInstances: JsonObject[] = [];
      for (let index = 0; index < selectedHere; index += 1) {
        const flowId = affectedFlowIds[(processIndex + index) % affectedFlowIds.length]!;
        const amount =
          batch.batch_id === 'time' && processIndex === 0 && index === 0
            ? '1.0'
            : batch.batch_id === 'length_time' && processIndex === 0 && index === 0
              ? '0.0549'
              : '1';
        const exchange: JsonObject = {
          '@dataSetInternalID': String(exchanges.length + 1),
          referenceToFlowDataSet: aliasReference('flows', flowId, draftVersion, 'Affected'),
          exchangeDirection: (processIndex + index) % 2 === 0 ? 'Input' : 'Output',
          meanAmount: amount,
          resultingAmount: amount,
          relativeStandardDeviation95In: '0',
        };
        const exchangeIndex = exchanges.length;
        exchanges.push(exchange);
        exchangeInstances.push({
          exchange_index: exchangeIndex,
          data_set_internal_id: exchange['@dataSetInternalID'],
          flow_id: flowId,
          flow_version: draftVersion,
          direction: exchange.exchangeDirection,
          before_exchange_sha256: sha256Json(exchange),
          before_mean_amount: amount,
          before_resulting_amount: amount,
        });
      }
      for (let index = 0; index < unrelatedHere; index += 1) {
        exchanges.push({
          '@dataSetInternalID': String(exchanges.length + 1),
          referenceToFlowDataSet: aliasReference(
            'flows',
            unrelatedFlowId,
            draftVersion,
            'Unrelated',
          ),
          exchangeDirection: 'Input',
          meanAmount: '2',
          resultingAmount: '2',
        });
      }
      remote.add(
        'processes',
        processId,
        aliasProcessPayload({ id: processId, version: draftVersion, exchanges }),
        { version: draftVersion },
      );
      scopeActions.push({
        action_id: `${batch.batch_id}-process-${processIndex}`,
        action: 'update_json_ordered',
        table: 'processes',
        id: processId,
        version: draftVersion,
        expected_user_id: remote.userId,
        expected_state_code: 0,
        reason_code: 'EXACT_EXCHANGE_SCALE',
        reason: 'Scale only the frozen source-flow exchange instances.',
        evidence: [],
        batch_id: batch.batch_id,
        exchange_instances: exchangeInstances,
      });
    }
    const protectedProcessId = aliasId(nextId++);
    remote.add(
      'processes',
      protectedProcessId,
      aliasProcessPayload({
        id: protectedProcessId,
        version: draftVersion,
        exchanges: Array.from({ length: batch.existingTargetExchangeCount }, (_, index) => ({
          '@dataSetInternalID': String(index + 1),
          referenceToFlowDataSet: aliasReference(
            'flows',
            existingTargetFlowIds[index % existingTargetFlowIds.length]!,
            draftVersion,
            'Canonical',
          ),
          exchangeDirection: 'Input',
          meanAmount: '1',
          resultingAmount: '1',
        })),
      }),
      { version: draftVersion },
    );
    scopeBatches.push({
      batch_id: batch.batch_id,
      dimension: batch.dimension,
      factor: batch.factor,
      source: {
        unitgroup: { id: batch.sourceUnitGroupId, version: draftVersion },
        flowproperty: { id: batch.sourceFlowPropertyId, version: draftVersion },
      },
      target: {
        unitgroup: { id: batch.targetUnitGroupId, version: publicVersion },
        flowproperty: { id: batch.targetFlowPropertyId, version: publicVersion },
      },
    });
  }
  return {
    scope: {
      schema_version: 1,
      task_id: 'bafu-fpug-alias-batches',
      operation: 'merge-support-aliases',
      target_mode: 'owner_draft',
      account: { user_id: remote.userId, email: remote.email },
      source_lineage: {
        exact_scope_sha256: '57e4a6ea07957b56a6849be2c4ebc8aea29dc1c031602621eed4fe41137e2432',
      },
      alias_batches: scopeBatches,
      actions: scopeActions,
    },
    selected_exchange_count: 59,
  };
}

function aliasRemoteRows(remote: FakeMaintenanceRemote): DatasetMaintenanceRemoteRow[] {
  return [...remote.rows.entries()].flatMap(([table, rows]) =>
    rows.map((row) => ({ ...row, table: table as DatasetMaintenanceRemoteRow['table'] })),
  );
}

class FakeMaintenanceRemote {
  readonly userId = '11111111-1111-4111-8111-111111111111';
  readonly email = 'owner@example.com';
  readonly env: NodeJS.ProcessEnv;
  readonly rows = new Map<string, StoredRow[]>();
  readonly rpcOrder: string[] = [];
  readonly rpcBodies: Record<string, unknown>[] = [];
  readonly aliasAuditKeys = new Set<string>();
  failDeleteOnce = false;
  failDeleteAfterCommitOnce = false;
  deleteDelayMs = 0;
  activeDeletes = 0;
  maxActiveDeletes = 0;
  failAliasResponseAfterCommitOnce = false;
  failAliasSecondDimensionOnce = false;
  aliasReadbackFailure: 'missing' | 'mismatch' | null = null;
  invalidAliasProof = false;
  invalidJson = false;
  serverPageCap = 1_000;
  duplicateExactLookup = false;

  constructor(label: string) {
    this.env = buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: `https://${label}.example.com/functions/v1`,
    });
    const sessionFile = this.env.TIANGONG_LCA_SESSION_FILE;
    if (sessionFile) {
      const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
      session.user_email = this.email;
      writeFileSync(sessionFile, `${JSON.stringify(session)}\n`, 'utf8');
    }
    for (const table of [
      'contacts',
      'sources',
      'flows',
      'processes',
      'lifecyclemodels',
      'unitgroups',
      'flowproperties',
    ]) {
      this.rows.set(table, []);
    }
  }

  add(table: string, id: string, payload: JsonObject, extras: Partial<StoredRow> = {}): void {
    this.rows.get(table)?.push({
      id,
      version: '01.00.000',
      user_id: this.userId,
      state_code: 0,
      modified_at: '2026-07-01T00:00:00.000Z',
      json_ordered: payload,
      model_id: null,
      rule_verification: null,
      ...extras,
    });
  }

  readonly fetch: FetchLike = async (input, init) => {
    const textUrl = String(input);
    if (isSupabaseAuthTokenUrl(textUrl)) {
      return makeSupabaseAuthResponse({ email: this.email, userId: this.userId });
    }
    if (textUrl.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: this.userId, email: this.email });
    }
    if (this.invalidJson) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async text() {
          return '{bad';
        },
      };
    }
    const url = new URL(textUrl);
    const rpc = url.pathname.split('/rpc/')[1];
    if (rpc) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.rpcOrder.push(rpc);
      this.rpcBodies.push(body);
      if (rpc === 'cmd_dataset_alias_plan_guarded') {
        const plan = body.p_plan as JsonObject;
        assertExactAliasPlanRequestContract(plan);
        const batches = plan.batches as JsonObject[];
        const allActions = batches.flatMap(
          (batch) => batch.actions as Array<Record<string, unknown>>,
        );
        const auditKey = JSON.stringify({
          target_visibility: plan.target_visibility,
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          batches: batches.map((batch) => ({
            batch_id: batch.batch_id,
            actions: (batch.actions as Array<Record<string, unknown>>).map(
              (action) => action.action_id,
            ),
          })),
        });
        const desired = allActions.every((action) => {
          const rows = this.rows.get(String(action.table)) ?? [];
          const row = rows.find(
            (entry) => entry.id === action.id && entry.version === action.version,
          );
          return stableJsonText(row?.json_ordered) === stableJsonText(action.desired_json_ordered);
        });
        if (!desired) {
          const beforeRows = new Map(
            [...this.rows.entries()].map(([table, rows]) => [table, structuredClone(rows)]),
          );
          for (const [batchIndex, batch] of batches.entries()) {
            if (batchIndex === 1 && this.failAliasSecondDimensionOnce) {
              this.failAliasSecondDimensionOnce = false;
              for (const [table, rows] of beforeRows) this.rows.set(table, rows);
              return jsonResponse({
                ok: false,
                code: 'ALIAS_SECOND_DIMENSION_FAILED',
                failed_dimension: 'length_time',
                plan_rolled_back: true,
              });
            }
            for (const action of batch.actions as Array<Record<string, unknown>>) {
              assert.equal(action.expected_state_code, 0);
              const rows = this.rows.get(String(action.table)) ?? [];
              const index = rows.findIndex(
                (entry) => entry.id === action.id && entry.version === action.version,
              );
              assert.notEqual(index, -1);
              assert.equal(
                stableJsonText(rows[index]?.json_ordered),
                stableJsonText(action.expected_json_ordered),
              );
              rows[index] = {
                ...rows[index]!,
                json_ordered: action.desired_json_ordered as JsonObject,
                modified_at: '2026-07-03T00:00:00.000Z',
              };
            }
          }
          this.aliasAuditKeys.add(auditKey);
        } else if (!this.aliasAuditKeys.has(auditKey)) {
          return jsonResponse({ ok: false, code: 'ALIAS_REPLAY_UNPROVEN' });
        }
        if (this.failAliasResponseAfterCommitOnce) {
          this.failAliasResponseAfterCommitOnce = false;
          return jsonResponse({ message: 'response lost after alias plan commit' }, 500);
        }
        if (this.invalidAliasProof) {
          return jsonResponse({ ok: true });
        }
        if (this.aliasReadbackFailure) {
          const first = allActions[0]!;
          const rows = this.rows.get(String(first.table))!;
          const index = rows.findIndex(
            (entry) => entry.id === first.id && entry.version === first.version,
          );
          if (this.aliasReadbackFailure === 'missing') {
            rows.splice(index, 1);
          } else {
            rows[index] = { ...rows[index]!, model_id: 'readback-mismatch' };
          }
          this.aliasReadbackFailure = null;
        }
        const batchResults = batches.map((batch, batchIndex) => {
          const actions = batch.actions as Array<Record<string, unknown>>;
          const exchangeCount = actions.reduce((sum, action) => {
            const mutation = action.mutation as Record<string, unknown>;
            return (
              sum +
              (mutation.kind === 'process_exchange_amounts'
                ? (mutation.exchanges as unknown[]).length
                : 0)
            );
          }, 0);
          return {
            ok: true,
            command: 'cmd_dataset_alias_batch_guarded',
            target_visibility: batch.target_visibility,
            dimension: batch.dimension,
            batch_id: batch.batch_id,
            batch_request_sha256: sha256Text(stableJsonText(batch)),
            row_count: actions.length,
            exchange_count: exchangeCount,
            summary_audit_id: String(9_001 + batchIndex),
            audit: actions.map((action, index) => ({
              action_id: action.action_id,
              table: action.table,
              id: action.id,
              version: action.version,
              audit_id: String((batchIndex + 1) * 10_000 + index),
            })),
            idempotent_replay: desired,
          };
        });
        return jsonResponse({
          ok: true,
          command: 'cmd_dataset_alias_plan_guarded',
          schema_version: 'dataset-alias-plan.v1',
          plan_sha256: plan.plan_sha256,
          operation_id: plan.operation_id,
          target_visibility: plan.target_visibility,
          plan_request_sha256: sha256Text(stableJsonText(plan)),
          batch_count: 2,
          row_count: 52,
          exchange_count: 59,
          summary_audit_id: '9900',
          batches: batchResults,
          idempotent_replay: desired,
        });
      }
      if (rpc === 'cmd_dataset_delete' && this.failDeleteOnce) {
        this.failDeleteOnce = false;
        return jsonResponse({ message: 'injected delete failure' }, 500);
      }
      const table = String(body.p_table);
      const tableRows = this.rows.get(table) ?? [];
      const rowIndex = tableRows.findIndex(
        (row) => row.id === body.p_id && row.version === body.p_version,
      );
      if (rpc === 'cmd_dataset_delete') {
        this.activeDeletes += 1;
        this.maxActiveDeletes = Math.max(this.maxActiveDeletes, this.activeDeletes);
        if (this.deleteDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.deleteDelayMs));
        }
        const deleteIndex = tableRows.findIndex(
          (row) => row.id === body.p_id && row.version === body.p_version,
        );
        if (deleteIndex >= 0) {
          tableRows.splice(deleteIndex, 1);
        }
        this.activeDeletes -= 1;
        if (this.failDeleteAfterCommitOnce) {
          this.failDeleteAfterCommitOnce = false;
          return jsonResponse({ message: 'response lost after delete commit' }, 500);
        }
      } else if (rowIndex >= 0) {
        tableRows[rowIndex] = {
          ...tableRows[rowIndex]!,
          json_ordered: body.p_json_ordered as JsonObject,
          model_id: (body.p_model_id as string | null) ?? null,
          rule_verification: (body.p_rule_verification as boolean | null) ?? null,
          modified_at: '2026-07-02T00:00:00.000Z',
        };
      }
      return jsonResponse({
        ok: true,
        audit: body.p_audit,
        data: rowIndex >= 0 ? tableRows[rowIndex] : null,
      });
    }
    const table = url.pathname.split('/rest/v1/')[1] ?? '';
    let values = [...(this.rows.get(table) ?? [])];
    const id = url.searchParams.get('id')?.replace(/^eq\./u, '');
    const version = url.searchParams.get('version')?.replace(/^eq\./u, '');
    const userId = url.searchParams.get('user_id')?.replace(/^eq\./u, '');
    if (id) values = values.filter((row) => row.id === id);
    if (version) values = values.filter((row) => row.version === version);
    if (userId) values = values.filter((row) => row.user_id === userId);
    if (id && this.duplicateExactLookup) values = [...values, ...values];
    values.sort((left, right) =>
      `${left.id}\u0000${left.version}`.localeCompare(`${right.id}\u0000${right.version}`),
    );
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? values.length);
    const page = values.slice(offset, offset + Math.min(limit, this.serverPageCap));
    return jsonResponse(page, 200, {
      'content-range':
        page.length > 0
          ? `${offset}-${offset + page.length - 1}/${values.length}`
          : `*/${values.length}`,
    });
  };
}

async function prepareAliasScenario(
  root: string,
  label: string,
): Promise<{
  remote: FakeMaintenanceRemote;
  plan: DatasetMaintenancePlan;
  outDir: string;
  context: Awaited<ReturnType<typeof resolveMaintenanceRemoteContext>>;
}> {
  const scenarioRoot = path.join(root, label);
  mkdirSync(scenarioRoot, { recursive: true });
  const remote = new FakeMaintenanceRemote(label);
  const fixture = seedAliasFixture(remote);
  const scopePath = path.join(scenarioRoot, 'scope.json');
  const outDir = path.join(scenarioRoot, 'maintenance');
  writeFileSync(scopePath, JSON.stringify(fixture.scope));
  const now = new Date('2026-07-11T07:00:00.000Z');
  const plan = await runDatasetMaintenancePlan({
    scopePath,
    operation: 'merge-support-aliases',
    outDir,
    env: remote.env,
    fetchImpl: remote.fetch,
    now,
    supportSchemas: PASSING_SUPPORT_SCHEMAS,
    aliasSchemas: {
      flowproperties: { safeParse: () => ({ success: true as const }) },
      flows: { safeParse: () => ({ success: true as const }) },
      processes: { safeParse: () => ({ success: true as const }) },
    },
  });
  const context = await resolveMaintenanceRemoteContext({
    env: remote.env,
    fetchImpl: remote.fetch,
    now,
  });
  return { remote, plan, outDir, context };
}

async function executeLegacyAliasFixtureForVerification(
  scenario: Awaited<ReturnType<typeof prepareAliasScenario>>,
): Promise<void> {
  const progressPath = path.join(scenario.outDir, 'apply-progress.jsonl');
  const planProgressPath = path.join(scenario.outDir, 'alias-plan-progress.jsonl');
  const batchProgressPath = path.join(scenario.outDir, 'alias-batch-progress.jsonl');
  const exchangeProgressPath = path.join(scenario.outDir, 'alias-exchange-progress.jsonl');
  const progress = applyInternals.parseProgress(scenario.plan, progressPath);
  const planProgress = applyInternals.parseAliasPlanProgress(scenario.plan, planProgressPath);
  const batchProgress = applyInternals.parseAliasBatchProgress(scenario.plan, batchProgressPath);
  const execution = await executeRetiredAliasFixture(scenario);
  const timestamp = '2026-07-11T09:30:00.000Z';
  for (const batch of scenario.plan.alias_batches!) {
    applyInternals.appendAliasSuccessLogs({
      plan: scenario.plan,
      batch,
      execution,
      progress,
      progressPath,
      exchangeProgressPath,
      context: scenario.context,
      startedAt: timestamp,
      endedAt: timestamp,
    });
  }
  applyInternals.appendAliasProofProgress({
    plan: scenario.plan,
    execution,
    planProgress,
    batchProgress,
    planProgressPath,
    batchProgressPath,
    context: scenario.context,
    startedAt: timestamp,
    endedAt: timestamp,
  });
}

async function executeRetiredAliasFixture(
  scenario: Awaited<ReturnType<typeof prepareAliasScenario>>,
) {
  const request = applyInternals.buildAliasPlanRequest({
    plan: scenario.plan,
    planDir: scenario.outDir,
  });
  const response = await scenario.remote.fetch(
    'https://retired-fixture.invalid/rest/v1/rpc/cmd_dataset_alias_plan_guarded',
    {
      method: 'POST',
      body: JSON.stringify({ p_plan: request }),
    },
  );
  const payload = JSON.parse(await response.text()) as JsonObject;
  if (!response.ok) {
    throw new CliError('Retired alias fixture transport failed.', {
      code: 'RETIRED_ALIAS_FIXTURE_FAILED',
      exitCode: 1,
      details: payload,
    });
  }
  const rpc = applyInternals.validateAliasPlanRpcResult(payload, scenario.plan);
  const afterByAction = new Map<string, string>();
  for (const action of scenario.plan.actions) {
    const row = (scenario.remote.rows.get(action.table) ?? []).find(
      (entry) => entry.id === action.id && entry.version === action.version,
    );
    const snapshot = row ? snapshotRemoteRow({ ...row, table: action.table }) : null;
    if (
      !row ||
      row.user_id !== action.expected_user_id ||
      row.state_code !== 0 ||
      snapshot?.payload_sha256 !== action.desired_payload?.sha256 ||
      row.model_id !== action.before?.model_id ||
      row.rule_verification !== action.before?.rule_verification
    ) {
      throw new CliError(`Alias plan readback failed for action ${action.action_id}.`, {
        code: 'DATASET_MAINTENANCE_ALIAS_READBACK_FAILED',
        exitCode: 1,
      });
    }
    afterByAction.set(action.action_id, snapshot!.row_sha256);
  }
  return { rpc, after_by_action: afterByAction };
}

function writeLegacyAliasCommitReport(
  scenario: Awaited<ReturnType<typeof prepareAliasScenario>>,
): void {
  const planProgressPath = path.join(scenario.outDir, 'alias-plan-progress.jsonl');
  const batchProgressPath = path.join(scenario.outDir, 'alias-batch-progress.jsonl');
  const exchangeProgressPath = path.join(scenario.outDir, 'alias-exchange-progress.jsonl');
  const planProof = readJsonLinesIfPresent(planProgressPath)[0] as JsonObject;
  writeFileSync(
    path.join(scenario.outDir, 'commit-report.json'),
    JSON.stringify({
      schema_version: 1,
      plan_sha256: scenario.plan.plan_sha256,
      task_id: scenario.plan.task_id,
      operation: scenario.plan.operation,
      operation_id: scenario.plan.operation_id,
      target_mode: scenario.plan.target_mode,
      status: 'completed',
      actor: scenario.plan.account,
      summary: {
        actions: scenario.plan.actions.length,
        success: scenario.plan.actions.length,
        failed: 0,
        pending: 0,
      },
      actions: scenario.plan.actions.map((action) => ({
        action_id: action.action_id,
        action: action.action,
        table: action.table,
        id: action.id,
        version: action.version,
        status: 'success',
        error: null,
      })),
      alias_plan_proof: {
        plan_request_sha256: planProof.plan_request_sha256,
        summary_audit_id: planProof.summary_audit_id,
        batch_count: 2,
        row_count: 52,
        exchange_count: 59,
        idempotent_replay: false,
      },
      artifacts: {
        alias_plan_progress: planProgressPath,
        alias_batch_progress: batchProgressPath,
        alias_exchange_progress: exchangeProgressPath,
      },
    }),
  );
}

function buildScopeFiles(options: {
  root: string;
  remote: FakeMaintenanceRemote;
  includeSave?: boolean;
}): { scopePath: string; desiredPath: string; outDir: string } {
  const desiredPath = path.join(options.root, 'desired-process.json');
  writeFileSync(
    desiredPath,
    JSON.stringify(
      processPayload({ id: '22222222-2222-4222-8222-222222222222', version: '01.00.000' }),
    ),
  );
  const actions: object[] = [
    {
      action_id: 'delete-source',
      action: 'delete',
      table: 'sources',
      id: '33333333-3333-4333-8333-333333333333',
      version: '01.00.000',
      expected_user_id: options.remote.userId,
      expected_state_code: 0,
      reason_code: 'DUPLICATE_SOURCE',
      reason: 'Source is superseded after references are repaired.',
      evidence: ['assessment/source-audit.json'],
    },
  ];
  if (options.includeSave !== false) {
    actions.push({
      action_id: 'repair-process-source',
      action: 'save_draft',
      table: 'processes',
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
      expected_user_id: options.remote.userId,
      expected_state_code: 0,
      reason_code: 'REWRITE_SOURCE_REFERENCE',
      reason: 'Remove reference to the superseded source.',
      evidence: ['assessment/source-audit.json'],
      desired_payload_path: path.basename(desiredPath),
    });
  }
  const scopePath = path.join(options.root, 'scope.json');
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      task_id: 'bafu-cleanup-test',
      operation: 'repair-references',
      account: { user_id: options.remote.userId, email: options.remote.email },
      actions,
    }),
  );
  return { scopePath, desiredPath, outDir: path.join(options.root, 'maintenance') };
}

async function prepareParallelFlowDeleteScenario(options: {
  root: string;
  label: string;
  count: number;
}): Promise<{
  remote: FakeMaintenanceRemote;
  flowIds: string[];
  plan: DatasetMaintenancePlan;
  planPath: string;
}> {
  const scenarioRoot = path.join(options.root, options.label);
  mkdirSync(scenarioRoot, { recursive: true });
  const remote = new FakeMaintenanceRemote(options.label);
  const flowIds = Array.from(
    { length: options.count },
    (_, index) => `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  for (const flowId of flowIds) remote.add('flows', flowId, flowPayload(flowId));
  const scopePath = path.join(scenarioRoot, 'scope.json');
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      task_id: `parallel-delete-${options.label}`,
      operation: 'delete',
      account: { user_id: remote.userId, email: remote.email },
      actions: flowIds.map((id, index) => ({
        action_id: `delete-flow-${index + 1}`,
        action: 'delete',
        table: 'flows',
        id,
        version: '01.00.000',
        expected_user_id: remote.userId,
        expected_state_code: 0,
        reason_code: 'OBSOLETE_FLOW_TOPOLOGY',
        reason: 'Flow is outside the admitted candidate topology.',
        evidence: ['topology/global-inbound-zero.json'],
      })),
    }),
  );
  const outDir = path.join(scenarioRoot, 'maintenance');
  const plan = await runDatasetMaintenancePlan({
    scopePath,
    operation: 'delete',
    outDir,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-24T10:00:00.000Z'),
  });
  assert.equal(plan.status, 'ready');
  return { remote, flowIds, plan, planPath: path.join(outDir, 'maintenance-plan.json') };
}

function buildParallelDeleteGlobalInboundProof(options: {
  plan: DatasetMaintenancePlan;
  projectRef: string;
  actorUserId: string;
  capturedAtUtc: string;
}): JsonObject {
  return {
    schema_version: 'dataset-maintenance-global-inbound-proof.v1',
    status: 'PASS_GLOBAL_ALL_PROCESS_INBOUND_ZERO',
    statement_kind: 'SELECT',
    source: 'supabase_select_only_raw_sql',
    process_scope: 'all_process_rows_without_rls_restriction',
    captured_at_utc: options.capturedAtUtc,
    project_ref: options.projectRef,
    actor_user_id: options.actorUserId,
    plan_sha256: options.plan.plan_sha256,
    operation: 'delete',
    target_table: 'flows',
    target_count: options.plan.actions.length,
    target_binding_sha256: applyInternals.parallelDeleteTargetBindingSha256(options.plan),
    global_process_rows: 253,
    global_exchange_rows: 253,
    inbound_exchanges: 0,
    old_flow_identities_with_inbound: 0,
    process_identities_with_inbound: 0,
    chunks: [
      {
        index: 0,
        start: 0,
        end_exclusive: options.plan.actions.length,
        target_count: options.plan.actions.length,
        captured_at_utc: options.capturedAtUtc,
        inbound_exchanges: 0,
        old_flow_identities_with_inbound: 0,
        process_identities_with_inbound: 0,
        owner_draft_inbound: 0,
        public_inbound: 0,
        foreign_private_inbound: 0,
        other_state_inbound: 0,
        sql_sha256: 'b'.repeat(64),
      },
    ],
    p0: 0,
    p1: 0,
  };
}

function writeParallelDeleteGlobalInboundProof(options: {
  root: string;
  fileName: string;
  value: JsonObject;
}): { path: string; sha256: string } {
  const proofPath = path.join(options.root, options.fileName);
  const text = `${stableJsonText(options.value)}\n`;
  writeFileSync(proofPath, text);
  return { path: proofPath, sha256: sha256Text(text) };
}

function seed(remote: FakeMaintenanceRemote): void {
  remote.add(
    'processes',
    '22222222-2222-4222-8222-222222222222',
    processPayload({
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
      sourceId: '33333333-3333-4333-8333-333333333333',
    }),
    { model_id: '44444444-4444-4444-8444-444444444444', rule_verification: true },
  );
  remote.add(
    'sources',
    '33333333-3333-4333-8333-333333333333',
    sourcePayload('33333333-3333-4333-8333-333333333333'),
  );
  remote.add(
    'flows',
    '55555555-5555-4555-8555-555555555555',
    flowPayload('55555555-5555-4555-8555-555555555555'),
  );
}

async function prepareSeededScenario(
  root: string,
  label: string,
): Promise<{
  remote: FakeMaintenanceRemote;
  files: ReturnType<typeof buildScopeFiles>;
  plan: DatasetMaintenancePlan;
  context: Awaited<ReturnType<typeof resolveMaintenanceRemoteContext>>;
}> {
  const scenarioRoot = path.join(root, label);
  mkdirSync(scenarioRoot, { recursive: true });
  const remote = new FakeMaintenanceRemote(label);
  seed(remote);
  const files = buildScopeFiles({ root: scenarioRoot, remote });
  const plan = await runDatasetMaintenancePlan({
    scopePath: files.scopePath,
    operation: 'repair-references',
    outDir: files.outDir,
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-11T00:00:00.000Z'),
  });
  const context = await resolveMaintenanceRemoteContext({
    env: remote.env,
    fetchImpl: remote.fetch,
    now: new Date('2026-07-11T00:00:00.000Z'),
  });
  return { remote, files, plan, context };
}

function scopeAction(
  remote: FakeMaintenanceRemote,
  overrides: Record<string, unknown> = {},
): DatasetMaintenanceScopeAction {
  return {
    action_id: 'delete-source',
    action: 'delete',
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
    expected_user_id: remote.userId,
    expected_state_code: 0,
    reason_code: 'TEST',
    reason: 'test reason',
    evidence: [],
    ...overrides,
  } as DatasetMaintenanceScopeAction;
}

function scopeValue(
  remote: FakeMaintenanceRemote,
  actions: unknown[] = [scopeAction(remote)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'edge-task',
    operation: 'delete',
    account: { user_id: remote.userId },
    actions,
    ...overrides,
  };
}

function successProgressEntry(
  plan: DatasetMaintenancePlan,
  action: DatasetMaintenancePlanAction,
): DatasetMaintenanceProgressEntry {
  return {
    schema_version: 1,
    plan_sha256: plan.plan_sha256,
    operation_id: plan.operation_id,
    action_id: action.action_id,
    action: action.action,
    table: action.table,
    id: action.id,
    version: action.version,
    reason_code: action.reason_code,
    audit_context: {
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      action_id: action.action_id,
      reason_code: action.reason_code,
      source: 'tiangong-lca dataset maintenance apply',
    },
    actor: { user_id: plan.account.user_id, email: plan.account.email ?? '' },
    started_at_utc: '2026-07-11T00:00:00.000Z',
    ended_at_utc: '2026-07-11T00:00:00.000Z',
    before_sha256: action.before?.row_sha256 ?? '',
    after_sha256: action.desired_payload?.sha256 ?? null,
    remote_result_sha256: 'a'.repeat(64),
    result: 'success',
    error: null,
    rollback: action.rollback,
  };
}

function stripMaintenanceContentRange(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!String(input).includes('/rest/v1/')) return response;
    return {
      ...response,
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === 'content-range' ? null : response.headers.get(name);
        },
      },
    };
  };
}

test('maintenance plans and direct saves reject every-language name semicolons while preserving synonyms', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-name-'));
  try {
    for (const table of ['flows', 'processes'] as const) {
      const scenarioRoot = path.join(root, table);
      mkdirSync(scenarioRoot, { recursive: true });
      const remote = new FakeMaintenanceRemote(`maintenance-name-${table}`);
      const id = '22222222-2222-4222-8222-222222222222';
      const payload =
        table === 'flows' ? flowPayload(id) : processPayload({ id, version: '01.00.000' });
      remote.add(table, id, structuredClone(payload));
      const rootKey = table === 'flows' ? 'flowDataSet' : 'processDataSet';
      const informationKey = table === 'flows' ? 'flowInformation' : 'processInformation';
      const information = (payload[rootKey] as JsonObject)[informationKey] as JsonObject;
      const datasetInfo = information.dataSetInformation as JsonObject;
      datasetInfo.name = {
        baseName: [
          { '@xml:lang': 'en', '#text': 'Battery' },
          { '@xml:lang': 'de', '#text': 'Batterie; Speicher' },
          { '@xml:lang': 'zh', '#text': '蓄电池；储能' },
        ],
      };
      const scopePath = path.join(scenarioRoot, 'scope.json');
      writeFileSync(path.join(scenarioRoot, 'desired.json'), JSON.stringify(payload));
      writeFileSync(
        scopePath,
        JSON.stringify(
          scopeValue(
            remote,
            [
              scopeAction(remote, {
                action_id: 'save-name',
                action: 'save_draft',
                table,
                id,
                desired_payload_path: 'desired.json',
              }),
            ],
            { operation: 'repair-references' },
          ),
        ),
      );
      const plan = await runDatasetMaintenancePlan({
        scopePath,
        operation: 'repair-references',
        outDir: path.join(scenarioRoot, 'plan'),
        env: remote.env,
        fetchImpl: remote.fetch,
      });
      assert.equal(plan.status, 'blocked');
      assert.equal(plan.actions[0]?.status, 'blocked');
      assert.equal(plan.actions[0]?.blockers.length, 2);
      assert.ok(
        plan.actions[0]?.blockers.every(
          (entry) => entry.code === 'DATASET_MAINTENANCE_NAME_INVALID',
        ),
      );
      const context = await resolveMaintenanceRemoteContext({
        env: remote.env,
        fetchImpl: remote.fetch,
      });
      const saveOptions = {
        context,
        table,
        id,
        version: '01.00.000',
        payload,
        modelId: null,
        ruleVerification: null,
        audit: { source: 'test' },
      };
      await assert.rejects(saveDraftMaintenanceRow(saveOptions), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'DATASET_MAINTENANCE_NAME_INVALID');
        return true;
      });
      assert.deepEqual(remote.rpcOrder, []);
      datasetInfo.name = { baseName: { '@xml:lang': 'en', '#text': 'Battery, storage' } };
      datasetInfo['common:synonyms'] = { '@xml:lang': 'en', '#text': 'Battery; accumulator' };
      await saveDraftMaintenanceRow(saveOptions);
      assert.deepEqual(remote.rpcOrder, ['cmd_dataset_save_draft']);
      assert.deepEqual(collectMaintenanceDraftNameIssues(payload, 'sources'), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance apply rechecks legacy ready-plan names before consuming an attempt', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-name-legacy-'));
  try {
    const { remote, files, plan } = await prepareSeededScenario(root, 'legacy-ready-names');
    assert.equal(plan.status, 'ready');
    const saveAction = plan.actions.find((action) => action.action === 'save_draft')!;
    const desiredPath = path.join(files.outDir, saveAction.desired_payload!.path);
    const payload = readJsonFile(desiredPath, 'Legacy desired payload') as JsonObject;
    const info = (payload.processDataSet as JsonObject).processInformation as JsonObject;
    (info.dataSetInformation as JsonObject).name = {
      treatmentStandardsRoutes: [{ '@xml:lang': 'zh', '#text': '储能；固定式' }],
    };
    writeFileSync(desiredPath, JSON.stringify(payload));
    saveAction.desired_payload!.sha256 = sha256Json(payload);
    plan.plan_sha256 = computePlanSha256(plan);
    const planPath = path.join(files.outDir, 'maintenance-plan.json');
    writeFileSync(planPath, JSON.stringify(plan));
    assert.equal(parseMaintenancePlan(plan).status, 'ready');
    await assert.rejects(
      runDatasetMaintenanceApply({
        planPath,
        approvePlan: plan.plan_sha256,
        confirm: remote.email,
        commit: true,
        env: remote.env,
        fetchImpl: remote.fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, 'DATASET_MAINTENANCE_NAME_INVALID');
        return true;
      },
    );
    assert.deepEqual(remote.rpcOrder, []);
    for (const artifact of [
      'apply-progress.jsonl',
      'approval-record.json',
      'commit-report.attempt-0001.json',
    ]) {
      assert.equal(existsSync(path.join(files.outDir, artifact)), false, artifact);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('row-level maintenance plans update-first closure, resumes failure, and verifies readback', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-row-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-main');
  seed(remote);
  const files = buildScopeFiles({ root, remote });
  const now = new Date('2026-07-11T01:02:03.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      pageSize: 1,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.target_mode, null);
    assert.equal(plan.summary.current_reference_impacts, 1);
    assert.equal(plan.summary.projected_reference_impacts, 0);
    assert.equal(plan.summary.protected_rows, 1);
    assert.equal(plan.plan_sha256, computePlanSha256(plan));
    assert.equal(parseMaintenancePlan(plan).plan_sha256, plan.plan_sha256);
    assert.equal(existsSync(path.join(files.outDir, 'maintenance-scope.json')), true);
    assert.equal(existsSync(path.join(files.outDir, 'protected-rows.jsonl')), true);
    assert.equal(plan.snapshot_completeness?.complete, true);
    assert.equal(plan.snapshot_completeness?.row_count, 3);
    const snapshotArtifact = JSON.parse(
      readFileSync(path.join(files.outDir, 'rls-visible-snapshot.json'), 'utf8'),
    ) as JsonObject;
    assert.ok(isJsonObject(snapshotArtifact.completeness));
    assert.equal(snapshotArtifact.completeness.complete, true);
    assert.equal(snapshotArtifact.completeness.row_count, 3);
    const dryRunArtifact = JSON.parse(
      readFileSync(path.join(files.outDir, 'dry-run-report.json'), 'utf8'),
    ) as JsonObject;
    assert.ok(isJsonObject(dryRunArtifact.snapshot_completeness));
    assert.equal(dryRunArtifact.snapshot_completeness.complete, true);

    remote.failDeleteOnce = true;
    const partial = await runDatasetMaintenanceApply({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: plan.plan_sha256,
      confirm: remote.email,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(partial.status, 'completed_with_failures');
    assert.equal(partial.summary.success, 1);
    assert.equal(partial.summary.failed, 1);
    assert.deepEqual(remote.rpcOrder, ['cmd_dataset_save_draft', 'cmd_dataset_delete']);

    const failedVerify = await runDatasetMaintenanceVerify({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      outDir: path.join(files.outDir, 'verify-partial'),
      pageSize: 2,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(failedVerify.status, 'failed');
    assert.match(failedVerify.issues.map((entry) => entry.code).join(','), /DELETE_TARGET/u);

    const completed = await runDatasetMaintenanceApply({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: plan.plan_sha256,
      confirm: remote.email,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.summary.resumed_successes, 1);
    assert.deepEqual(remote.rpcOrder, [
      'cmd_dataset_save_draft',
      'cmd_dataset_delete',
      'cmd_dataset_delete',
    ]);
    const progress = readJsonLinesIfPresent(path.join(files.outDir, 'apply-progress.jsonl'));
    assert.deepEqual(
      progress.map((entry) => (entry as { result: string }).result),
      ['success', 'failed', 'success'],
    );
    const firstProgress = progress[0] as Record<string, unknown>;
    assert.equal(firstProgress.action, 'save_draft');
    assert.equal(firstProgress.reason_code, 'REWRITE_SOURCE_REFERENCE');
    assert.equal(typeof firstProgress.before_sha256, 'string');
    assert.equal(typeof firstProgress.after_sha256, 'string');
    assert.equal(typeof firstProgress.remote_result_sha256, 'string');
    assert.deepEqual(firstProgress.audit_context, {
      plan_sha256: plan.plan_sha256,
      operation_id: plan.operation_id,
      action_id: 'repair-process-source',
      reason_code: 'REWRITE_SOURCE_REFERENCE',
      source: 'tiangong-lca dataset maintenance apply',
    });
    assert.equal(completed.database_audit.rpc_transaction_log, 'public.command_audit_log');
    assert.match(
      readFileSync(path.join(files.outDir, 'approval-record.json'), 'utf8'),
      /plan_sha256/u,
    );

    const verified = await runDatasetMaintenanceVerify({
      planPath: path.join(files.outDir, 'maintenance-plan.json'),
      pageSize: 1,
      timeoutMs: 1000,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    assert.equal(verified.status, 'passed');
    assert.equal(verified.summary.action_checks_passed, 2);
    assert.equal(verified.summary.protected_checks_passed, 1);
    assert.equal(verified.summary.dangling_deleted_target_references, 0);
    assert.equal(verified.snapshot_completeness.complete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete apply is bounded, durable, globally fenced, and never replays success', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-delete-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({ root, label: 'success', count: 4 });
    scenario.remote.add(
      'processes',
      '81000000-0000-4000-8000-000000000001',
      processFlowReferencePayload({
        processId: '81000000-0000-4000-8000-000000000001',
        flowId: '81000000-0000-4000-8000-000000000099',
      }),
      { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
    );
    scenario.remote.add(
      'processes',
      '81000000-0000-4000-8000-000000000002',
      processFlowReferencePayload({
        processId: '81000000-0000-4000-8000-000000000002',
        flowId: '81000000-0000-4000-8000-000000000098',
      }),
      { user_id: null, state_code: null },
    );
    for (let index = 3; index <= 253; index += 1) {
      const suffix = String(index).padStart(12, '0');
      scenario.remote.add(
        'processes',
        `81000000-0000-4000-8000-${suffix}`,
        processFlowReferencePayload({
          processId: `81000000-0000-4000-8000-${suffix}`,
          flowId: `82000000-0000-4000-8000-${suffix}`,
        }),
        { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
      );
    }
    scenario.remote.deleteDelayMs = 20;
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requestedUrls.push(String(input));
      return scenario.remote.fetch(input, init);
    };
    const report = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 4,
      env: scenario.remote.env,
      fetchImpl,
      now: new Date('2026-07-24T10:01:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.success, 4);
    assert.ok(scenario.remote.maxActiveDeletes > 1);
    assert.equal(report.artifacts.execution_log?.endsWith('apply-execution-log.jsonl'), true);
    const events = readJsonLinesIfPresent(report.artifacts.execution_log!);
    for (const action of scenario.plan.actions) {
      const actionEvents = events.filter(
        (entry) => isJsonObject(entry) && entry.action_id === action.action_id,
      );
      assert.deepEqual(
        actionEvents.map((entry) => (entry as JsonObject).status),
        ['PREPARED', 'DISPATCHED', 'COMMITTED'],
      );
      assert.equal((actionEvents[0] as JsonObject).attempt_consumed, false);
      assert.equal((actionEvents[1] as JsonObject).attempt_consumed, true);
      assert.equal(
        (actionEvents[1] as JsonObject).attempt_key,
        `${action.action_id}@${(actionEvents[1] as JsonObject).desired_sha256}`,
      );
      assert.equal((actionEvents[2] as JsonObject).readback_sha256, sha256Json([]));
    }
    const barrier = readJsonFile(report.artifacts.inbound_reference_barrier!, 'barrier');
    assert.ok(isJsonObject(barrier));
    assert.equal(barrier.inbound_reference_count, 0);
    assert.equal(barrier.target_count, 4);
    assert.equal(barrier.process_rows, 253);
    assert.equal(barrier.process_references, 253);
    const visibleProcessUrls = requestedUrls
      .filter((requestedUrl) => requestedUrl.includes('/rest/v1/processes'))
      .map((requestedUrl) => new URL(requestedUrl))
      .filter((requestedUrl) => !requestedUrl.searchParams.has('user_id'));
    assert.ok(visibleProcessUrls.length > 0);
    assert.deepEqual(
      visibleProcessUrls.map((requestedUrl) => requestedUrl.searchParams.get('offset')),
      ['0', '250'],
    );
    for (const requestedUrl of visibleProcessUrls) {
      assert.equal(requestedUrl.searchParams.get('limit'), '250');
      assert.equal(requestedUrl.searchParams.get('user_id'), null);
      assert.equal(requestedUrl.searchParams.get('order'), 'id.asc,version.asc');
    }

    const rpcCount = scenario.remote.rpcOrder.length;
    const resumed = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 4,
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-24T10:02:00.000Z'),
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.summary.resumed_successes, 4);
    assert.equal(scenario.remote.rpcOrder.length, rpcCount);
    assert.equal(readJsonLinesIfPresent(report.artifacts.execution_log!).length, events.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete accepts an exact fresh global SELECT proof and skips the live all-visible scan', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-global-proof-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'global-proof',
      count: 2,
    });
    const now = new Date('2026-07-24T10:01:00.000Z');
    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    const proof = writeParallelDeleteGlobalInboundProof({
      root,
      fileName: 'global-inbound-proof.json',
      value: buildParallelDeleteGlobalInboundProof({
        plan: scenario.plan,
        projectRef: context.project_ref,
        actorUserId: context.account.user_id,
        capturedAtUtc: '2026-07-24T10:00:30.000Z',
      }),
    });
    const requestedUrls: string[] = [];
    const report = await runDatasetMaintenanceApply({
      planPath: scenario.planPath,
      commit: true,
      approvePlan: scenario.plan.plan_sha256,
      confirm: scenario.remote.email,
      maxParallel: 2,
      globalInboundProofPath: proof.path,
      approveGlobalInboundProof: proof.sha256,
      env: scenario.remote.env,
      fetchImpl: async (input, init) => {
        requestedUrls.push(String(input));
        return scenario.remote.fetch(input, init);
      },
      now,
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.summary.success, 2);
    const unfilteredProcessReads = requestedUrls
      .filter((requestedUrl) => requestedUrl.includes('/rest/v1/processes'))
      .map((requestedUrl) => new URL(requestedUrl))
      .filter((requestedUrl) => !requestedUrl.searchParams.has('user_id'));
    assert.deepEqual(unfilteredProcessReads, []);
    const barrier = readJsonFile(report.artifacts.inbound_reference_barrier!, 'global barrier');
    assert.ok(isJsonObject(barrier));
    assert.equal(barrier.snapshot_sha256, proof.sha256);
    assert.equal(barrier.process_rows, 253);
    assert.equal(barrier.process_references, 253);
    assert.ok(isJsonObject(barrier.completeness));
    assert.equal(barrier.completeness.strategy, 'sha256_approved_global_select_only_all_processes');
    assert.equal(barrier.completeness.proof_sha256, proof.sha256);
    assert.equal(
      barrier.completeness.target_binding_sha256,
      applyInternals.parallelDeleteTargetBindingSha256(scenario.plan),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('global inbound proof admission rejects stale, foreign, mutated, incomplete, or unapproved evidence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-global-proof-invalid-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'global-proof-invalid',
      count: 2,
    });
    const now = new Date('2026-07-24T10:01:00.000Z');
    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    const base = buildParallelDeleteGlobalInboundProof({
      plan: scenario.plan,
      projectRef: context.project_ref,
      actorUserId: context.account.user_id,
      capturedAtUtc: '2026-07-24T10:00:30.000Z',
    });
    const absentBeforePlan = structuredClone(scenario.plan);
    absentBeforePlan.actions[0]!.before = null;
    assert.notEqual(
      applyInternals.parallelDeleteTargetBindingSha256(absentBeforePlan),
      applyInternals.parallelDeleteTargetBindingSha256(scenario.plan),
    );
    const mutations: Array<[string, (value: JsonObject) => void]> = [
      [
        'stale',
        (value) => {
          value.captured_at_utc = '2026-07-24T09:00:00.000Z';
          (value.chunks as JsonObject[])[0]!.captured_at_utc = '2026-07-24T09:00:00.000Z';
        },
      ],
      [
        'project',
        (value) => {
          value.project_ref = 'foreign-project';
        },
      ],
      [
        'actor',
        (value) => {
          value.actor_user_id = '99999999-9999-4999-8999-999999999999';
        },
      ],
      [
        'plan',
        (value) => {
          value.plan_sha256 = 'c'.repeat(64);
        },
      ],
      [
        'binding',
        (value) => {
          value.target_binding_sha256 = 'd'.repeat(64);
        },
      ],
      [
        'statement',
        (value) => {
          value.statement_kind = 'UPDATE';
        },
      ],
      [
        'inbound',
        (value) => {
          value.inbound_exchanges = 1;
        },
      ],
      [
        'p0',
        (value) => {
          value.p0 = 1;
        },
      ],
      [
        'captured-type',
        (value) => {
          value.captured_at_utc = 1;
        },
      ],
      [
        'chunk-gap',
        (value) => {
          (value.chunks as JsonObject[])[0]!.start = 1;
        },
      ],
      [
        'chunk-type',
        (value) => {
          value.chunks = [null];
        },
      ],
      [
        'chunk-captured-type',
        (value) => {
          (value.chunks as JsonObject[])[0]!.captured_at_utc = 1;
        },
      ],
      [
        'chunk-inbound',
        (value) => {
          (value.chunks as JsonObject[])[0]!.foreign_private_inbound = 1;
        },
      ],
      [
        'chunk-partial',
        (value) => {
          (value.chunks as JsonObject[])[0]!.end_exclusive = 1;
          (value.chunks as JsonObject[])[0]!.target_count = 1;
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const value = structuredClone(base);
      mutate(value);
      const proof = writeParallelDeleteGlobalInboundProof({
        root,
        fileName: `${label}.json`,
        value,
      });
      assert.throws(
        () =>
          applyInternals.validateParallelDeleteGlobalInboundProof({
            proofPath: proof.path,
            approveProof: proof.sha256,
            plan: scenario.plan,
            context,
            now,
          }),
        /Global inbound proof/u,
        label,
      );
    }

    const approved = writeParallelDeleteGlobalInboundProof({
      root,
      fileName: 'approved.json',
      value: base,
    });
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: approved.path,
          approveProof: 'e'.repeat(64),
          plan: scenario.plan,
          context,
          now,
        }),
      /does not match approval/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: true,
          proofPath: approved.path,
        }),
      /must be provided together/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: false,
          proofPath: approved.path,
          approveProof: approved.sha256,
        }),
      /only with --max-parallel/u,
    );
    assert.throws(
      () =>
        applyInternals.assertGlobalInboundProofOptionShape({
          parallelDeleteMode: true,
          proofPath: approved.path,
          approveProof: 'BAD',
        }),
      /lowercase SHA-256/u,
    );
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: 'relative-proof.json',
          approveProof: approved.sha256,
          plan: scenario.plan,
          context,
          now,
        }),
      /must be absolute/u,
    );
    assert.throws(
      () =>
        applyInternals.validateParallelDeleteGlobalInboundProof({
          proofPath: path.join(root, 'missing-proof.json'),
          approveProof: 'f'.repeat(64),
          plan: scenario.plan,
          context,
          now,
        }),
      /could not be read/u,
    );
    for (const [fileName, text, pattern] of [
      ['malformed.json', '{bad', /not valid JSON/u],
      ['primitive.json', 'null', /must be a JSON object/u],
    ] as const) {
      const invalidPath = path.join(root, fileName);
      writeFileSync(invalidPath, text);
      assert.throws(
        () =>
          applyInternals.validateParallelDeleteGlobalInboundProof({
            proofPath: invalidPath,
            approveProof: sha256Text(text),
            plan: scenario.plan,
            context,
            now,
          }),
        pattern,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete recovers committed ambiguity and continues after terminal UNKNOWN', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-recovery-'));
  try {
    const recovered = await prepareParallelFlowDeleteScenario({
      root,
      label: 'recovered',
      count: 2,
    });
    recovered.remote.failDeleteAfterCommitOnce = true;
    const recoveredReport = await runDatasetMaintenanceApply({
      planPath: recovered.planPath,
      commit: true,
      approvePlan: recovered.plan.plan_sha256,
      confirm: recovered.remote.email,
      maxParallel: 1,
      env: recovered.remote.env,
      fetchImpl: recovered.remote.fetch,
    });
    assert.equal(recoveredReport.status, 'completed');
    const recoveredEvents = readJsonLinesIfPresent(recoveredReport.artifacts.execution_log!);
    assert.equal(
      recoveredEvents.some(
        (entry) => isJsonObject(entry) && entry.status === 'COMMITTED' && entry.recovered === true,
      ),
      true,
    );

    const unknown = await prepareParallelFlowDeleteScenario({ root, label: 'unknown', count: 2 });
    unknown.remote.failDeleteOnce = true;
    const unknownReport = await runDatasetMaintenanceApply({
      planPath: unknown.planPath,
      commit: true,
      approvePlan: unknown.plan.plan_sha256,
      confirm: unknown.remote.email,
      maxParallel: 1,
      env: unknown.remote.env,
      fetchImpl: unknown.remote.fetch,
    });
    assert.equal(unknownReport.status, 'completed_with_unknowns');
    assert.equal(unknownReport.summary.unknown, 1);
    assert.equal(unknownReport.summary.success, 1);
    assert.deepEqual(
      unknownReport.actions.map((action) => action.status),
      ['unknown', 'success'],
    );
    assert.equal(unknown.remote.rpcOrder.length, 2);

    const resumed = await runDatasetMaintenanceApply({
      planPath: unknown.planPath,
      commit: true,
      approvePlan: unknown.plan.plan_sha256,
      confirm: unknown.remote.email,
      maxParallel: 1,
      env: unknown.remote.env,
      fetchImpl: unknown.remote.fetch,
    });
    assert.equal(resumed.status, 'completed_with_unknowns');
    assert.equal(unknown.remote.rpcOrder.length, 2);
    const firstActionEvents = readJsonLinesIfPresent(resumed.artifacts.execution_log!).filter(
      (entry) => isJsonObject(entry) && entry.action_id === 'delete-flow-1',
    );
    assert.equal(
      firstActionEvents.filter((entry) => isJsonObject(entry) && entry.status === 'DISPATCHED')
        .length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel flow delete rejects non-delete plans and any globally visible process inbound edge', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-barrier-'));
  try {
    const mixed = await prepareSeededScenario(root, 'mixed-plan');
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(mixed.files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: mixed.plan.plan_sha256,
          confirm: mixed.remote.email,
          maxParallel: 2,
          env: mixed.remote.env,
          fetchImpl: mixed.remote.fetch,
        }),
      /flow delete-only plan/u,
    );

    const inbound = await prepareParallelFlowDeleteScenario({ root, label: 'inbound', count: 1 });
    inbound.remote.add(
      'processes',
      '80000000-0000-4000-8000-000000000001',
      processFlowReferencePayload({
        processId: '80000000-0000-4000-8000-000000000001',
        flowId: inbound.flowIds[0]!,
      }),
      { user_id: '99999999-9999-4999-8999-999999999999', state_code: 100 },
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: inbound.planPath,
          commit: true,
          approvePlan: inbound.plan.plan_sha256,
          confirm: inbound.remote.email,
          maxParallel: 8,
          env: inbound.remote.env,
          fetchImpl: inbound.remote.fetch,
        }),
      /visible process inbound references/u,
    );
    assert.equal(inbound.remote.rpcOrder.length, 0);

    const context = await resolveMaintenanceRemoteContext({
      env: inbound.remote.env,
      fetchImpl: inbound.remote.fetch,
    });
    const visible = await fetchMaintenanceVisibleTableRows({
      context,
      table: 'processes',
      pageSize: 1,
    });
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.completeness.complete, true);

    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: inbound.planPath,
          commit: true,
          approvePlan: inbound.plan.plan_sha256,
          confirm: inbound.remote.email,
          maxParallel: 9,
          env: inbound.remote.env,
          fetchImpl: inbound.remote.fetch,
        }),
      /integer from 1 to 8/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete ledger recovers crash windows without a second dispatch', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-crash-'));
  try {
    const committed = await prepareParallelFlowDeleteScenario({
      root,
      label: 'committed-ledger',
      count: 1,
    });
    await runDatasetMaintenanceApply({
      planPath: committed.planPath,
      commit: true,
      approvePlan: committed.plan.plan_sha256,
      confirm: committed.remote.email,
      maxParallel: 1,
      env: committed.remote.env,
      fetchImpl: committed.remote.fetch,
    });
    rmSync(path.join(path.dirname(committed.planPath), 'apply-progress.jsonl'));
    const committedRpcCount = committed.remote.rpcOrder.length;
    const recoveredCommitted = await runDatasetMaintenanceApply({
      planPath: committed.planPath,
      commit: true,
      approvePlan: committed.plan.plan_sha256,
      confirm: committed.remote.email,
      maxParallel: 1,
      env: committed.remote.env,
      fetchImpl: committed.remote.fetch,
    });
    assert.equal(recoveredCommitted.status, 'completed');
    assert.equal(committed.remote.rpcOrder.length, committedRpcCount);

    const dispatched = await prepareParallelFlowDeleteScenario({
      root,
      label: 'dispatched-ledger',
      count: 1,
    });
    await runDatasetMaintenanceApply({
      planPath: dispatched.planPath,
      commit: true,
      approvePlan: dispatched.plan.plan_sha256,
      confirm: dispatched.remote.email,
      maxParallel: 1,
      env: dispatched.remote.env,
      fetchImpl: dispatched.remote.fetch,
    });
    const executionPath = path.join(path.dirname(dispatched.planPath), 'apply-execution-log.jsonl');
    const firstTwo = readJsonLinesIfPresent(executionPath).slice(0, 2);
    writeFileSync(executionPath, `${firstTwo.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    rmSync(path.join(path.dirname(dispatched.planPath), 'apply-progress.jsonl'));
    const dispatchedRpcCount = dispatched.remote.rpcOrder.length;
    const recoveredDispatched = await runDatasetMaintenanceApply({
      planPath: dispatched.planPath,
      commit: true,
      approvePlan: dispatched.plan.plan_sha256,
      confirm: dispatched.remote.email,
      maxParallel: 1,
      env: dispatched.remote.env,
      fetchImpl: dispatched.remote.fetch,
    });
    assert.equal(recoveredDispatched.status, 'completed');
    assert.equal(dispatched.remote.rpcOrder.length, dispatchedRpcCount);
    assert.deepEqual(
      readJsonLinesIfPresent(executionPath).map((entry) => (entry as { status: string }).status),
      ['PREPARED', 'DISPATCHED', 'COMMITTED'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete recovery classifies exact-before, drift, and read failures as UNKNOWN', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-unknown-'));
  try {
    for (const mode of ['exact-before', 'drift', 'read-failure'] as const) {
      const scenario = await prepareParallelFlowDeleteScenario({ root, label: mode, count: 1 });
      scenario.remote.failDeleteOnce = true;
      await runDatasetMaintenanceApply({
        planPath: scenario.planPath,
        commit: true,
        approvePlan: scenario.plan.plan_sha256,
        confirm: scenario.remote.email,
        maxParallel: 1,
        env: scenario.remote.env,
        fetchImpl: scenario.remote.fetch,
      });
      const planDir = path.dirname(scenario.planPath);
      const executionPath = path.join(planDir, 'apply-execution-log.jsonl');
      const dispatchedOnly = readJsonLinesIfPresent(executionPath).slice(0, 2);
      writeFileSync(
        executionPath,
        `${dispatchedOnly.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      );
      rmSync(path.join(planDir, 'apply-progress.jsonl'));
      if (mode === 'drift') {
        scenario.remote.rows.get('flows')![0]!.json_ordered = flowPayload(
          '82000000-0000-4000-8000-000000000099',
        );
      }
      const fetchImpl: FetchLike =
        mode === 'read-failure'
          ? async (input, init) => {
              const url = new URL(String(input));
              return url.pathname.endsWith('/rest/v1/flows') && url.searchParams.has('id')
                ? jsonResponse({ message: 'recovery lookup failed' }, 500)
                : scenario.remote.fetch(input, init);
            }
          : scenario.remote.fetch;
      const rpcCount = scenario.remote.rpcOrder.length;
      const report = await runDatasetMaintenanceApply({
        planPath: scenario.planPath,
        commit: true,
        approvePlan: scenario.plan.plan_sha256,
        confirm: scenario.remote.email,
        maxParallel: 1,
        env: scenario.remote.env,
        fetchImpl,
      });
      assert.equal(report.status, 'completed_with_unknowns');
      assert.equal(scenario.remote.rpcOrder.length, rpcCount);
      const latest = readJsonLinesIfPresent(executionPath).at(-1);
      assert.ok(isJsonObject(latest));
      assert.equal(latest.status, 'UNKNOWN');
      assert.match(
        String(latest.error),
        mode === 'exact-before'
          ? /exact-before/u
          : mode === 'drift'
            ? /drifted/u
            : /Read-only recovery failed/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete continues pre-dispatch failures and records post-dispatch readback variants', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-edges-'));
  try {
    const preflight = await prepareParallelFlowDeleteScenario({
      root,
      label: 'jit-duplicate',
      count: 2,
    });
    preflight.remote.duplicateExactLookup = true;
    const preflightReport = await runDatasetMaintenanceApply({
      planPath: preflight.planPath,
      commit: true,
      approvePlan: preflight.plan.plan_sha256,
      confirm: preflight.remote.email,
      maxParallel: 2,
      env: preflight.remote.env,
      fetchImpl: preflight.remote.fetch,
    });
    assert.equal(preflightReport.status, 'completed_with_failures');
    assert.equal(preflightReport.summary.failed, 2);
    assert.equal(preflight.remote.rpcOrder.length, 0);

    const retained = await prepareParallelFlowDeleteScenario({
      root,
      label: 'retained-readback',
      count: 1,
    });
    const retainedReport = await runDatasetMaintenanceApply({
      planPath: retained.planPath,
      commit: true,
      approvePlan: retained.plan.plan_sha256,
      confirm: retained.remote.email,
      maxParallel: 1,
      env: retained.remote.env,
      fetchImpl: async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_delete')
          ? jsonResponse({ ok: true, audit_id: '123' })
          : retained.remote.fetch(input, init),
    });
    assert.equal(retainedReport.status, 'completed_with_unknowns');
    const retainedEvent = readJsonLinesIfPresent(retainedReport.artifacts.execution_log!).at(-1);
    assert.ok(isJsonObject(retainedEvent));
    assert.equal(retainedEvent.audit_id, '123');
    assert.match(String(retainedEvent.error), /returned but exact absent/u);

    const lostReadback = await prepareParallelFlowDeleteScenario({
      root,
      label: 'lost-readback',
      count: 1,
    });
    let dispatched = false;
    const lostReadbackReport = await runDatasetMaintenanceApply({
      planPath: lostReadback.planPath,
      commit: true,
      approvePlan: lostReadback.plan.plan_sha256,
      confirm: lostReadback.remote.email,
      maxParallel: 1,
      env: lostReadback.remote.env,
      fetchImpl: async (input, init) => {
        if (String(input).includes('/rpc/cmd_dataset_delete')) {
          const response = await lostReadback.remote.fetch(input, init);
          dispatched = true;
          return response;
        }
        const url = new URL(String(input));
        if (dispatched && url.pathname.endsWith('/rest/v1/flows') && url.searchParams.has('id')) {
          return jsonResponse({ message: 'readback unavailable' }, 500);
        }
        return lostReadback.remote.fetch(input, init);
      },
    });
    assert.equal(lostReadbackReport.status, 'completed_with_unknowns');
    const lostEvent = readJsonLinesIfPresent(lostReadbackReport.artifacts.execution_log!).at(-1);
    assert.ok(isJsonObject(lostEvent));
    assert.equal(lostEvent.readback_sha256, null);
    assert.match(String(lostEvent.error), /Readback failed after dispatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel delete internals reject duplicate targets, corrupt ledgers, and fatal ledger writes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-parallel-internals-'));
  try {
    const scenario = await prepareParallelFlowDeleteScenario({
      root,
      label: 'internals',
      count: 2,
    });
    const duplicate = structuredClone(scenario.plan);
    duplicate.actions[1] = {
      ...duplicate.actions[1]!,
      id: duplicate.actions[0]!.id,
      version: duplicate.actions[0]!.version,
    };
    assert.throws(() => applyInternals.assertParallelDeletePlan(duplicate), /repeated/u);
    const legacySummary = structuredClone(scenario.plan);
    delete legacySummary.summary.update_json_ordered;
    delete legacySummary.summary.rebuild_derivatives;
    assert.doesNotThrow(() => applyInternals.assertParallelDeletePlan(legacySummary));
    assert.equal(applyInternals.normalizeMaintenanceMaxParallel(undefined), 1);
    assert.equal(applyInternals.normalizeMaintenanceMaxParallel(8), 8);
    assert.throws(() => applyInternals.normalizeMaintenanceMaxParallel(0), /integer/u);
    assert.equal(applyInternals.remoteAuditId({ audit_id: '7' }), '7');
    assert.equal(applyInternals.remoteAuditId({ audit_id: 'bad' }), null);

    const context = await resolveMaintenanceRemoteContext({
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    const executionLogPath = path.join(path.dirname(scenario.planPath), 'manual-log.jsonl');
    const execution = {
      entries: [],
      byAction: new Map(),
      dispatched: new Set<string>(),
      committed: new Set<string>(),
    };
    const action = scenario.plan.actions[0]!;
    applyInternals.appendParallelDeleteExecutionEntry({
      path: executionLogPath,
      state: execution,
      plan: scenario.plan,
      action,
      context,
      status: 'PREPARED',
      recordedAtUtc: '2026-07-24T10:00:00.000Z',
    });
    applyInternals.appendParallelDeleteExecutionEntry({
      path: executionLogPath,
      state: execution,
      plan: scenario.plan,
      action,
      context,
      status: 'DISPATCHED',
      recordedAtUtc: '2026-07-24T10:00:01.000Z',
    });
    const validEntries = readJsonLinesIfPresent(executionLogPath);
    const corruptions: unknown[] = [
      null,
      { ...(validEntries[0] as JsonObject), action_id: 'foreign-action' },
      { ...(validEntries[0] as JsonObject), audit_id: 'bad' },
      { ...(validEntries[0] as JsonObject), remote_result_sha256: 'bad' },
      { ...(validEntries[0] as JsonObject), attempt_consumed: 'bad' },
      { ...(validEntries[0] as JsonObject), recovered: 'bad' },
      { ...(validEntries[0] as JsonObject), readback_sha256: 'bad' },
      { ...(validEntries[0] as JsonObject), error: 1 },
      { ...(validEntries[0] as JsonObject), status: 'COMMITTED' },
      { ...(validEntries[0] as JsonObject), recorded_at_utc: 'bad' },
    ];
    for (const [index, corrupted] of corruptions.entries()) {
      const corruptPath = path.join(root, `corrupt-${index}.jsonl`);
      writeFileSync(corruptPath, `${JSON.stringify(corrupted)}\n`);
      assert.throws(
        () => applyInternals.parseParallelDeleteExecutionLog(scenario.plan, corruptPath),
        /invalid or foreign/u,
      );
    }

    const fatalLogPath = path.join(root, 'ledger-as-directory');
    mkdirSync(fatalLogPath);
    const progressPath = path.join(root, 'fatal-progress.jsonl');
    await assert.rejects(
      () =>
        applyInternals.executeParallelDeletePlan({
          plan: { ...scenario.plan, actions: [action] },
          context,
          progress: applyInternals.parseProgress(
            { ...scenario.plan, actions: [action] },
            progressPath,
          ),
          progressPath,
          executionLogPath: fatalLogPath,
          execution: {
            entries: [],
            byAction: new Map(),
            dispatched: new Set(),
            committed: new Set(),
          },
          maxParallel: 1,
          now: () => '2026-07-24T10:00:00.000Z',
        }),
      /EISDIR|EPERM|illegal operation on a directory/u,
    );

    const unversioned = processFlowReferencePayload({
      processId: '83000000-0000-4000-8000-000000000001',
      flowId: scenario.flowIds[0]!,
    });
    const reference = ((unversioned.processDataSet as JsonObject).exchanges as JsonObject)
      .exchange as JsonObject;
    delete (reference.referenceToFlowDataSet as JsonObject)['@version'];
    assert.throws(
      () =>
        applyInternals.assertNoVisibleProcessInboundReferences({
          plan: scenario.plan,
          rows: [
            {
              table: 'processes',
              id: '83000000-0000-4000-8000-000000000001',
              version: '01.00.000',
              user_id: null,
              state_code: 100,
              modified_at: null,
              json_ordered: unversioned,
              model_id: null,
              rule_verification: null,
            },
          ],
        }),
      /visible process inbound/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias decimal arithmetic preserves lexical scale without binary floating point', () => {
  assert.equal(multiplyExactDecimal('1.0', '0.00011415525114155251'), '0.000114155251141552510');
  assert.equal(multiplyExactDecimal('0.0549', '1000'), '54.9000');
  assert.equal(multiplyExactDecimal('-2.50', '1000'), '-2500.00');
  assert.equal(multiplyExactDecimal('0.00', '1000'), '0.00');
  assert.equal(multiplyExactDecimal('1e3', '1000'), null);
  assert.equal(multiplyExactDecimal('1'.repeat(257), '1000'), null);
  assert.equal(aliasInternals.decimalEqual('1000.0', '1000'), true);
  assert.equal(aliasInternals.decimalEqual('-0', '0.0'), true);
  assert.equal(aliasInternals.decimalEqual('-1', '1'), false);
  assert.equal(aliasInternals.decimalEqual('bad', '1'), false);
});

test('alias rewrite helpers reject malformed support, flow, and exchange evidence', () => {
  const draftVersion = '00.00.001';
  const publicVersion = '01.00.000';
  const batch: DatasetMaintenanceAliasBatch = {
    batch_id: 'time',
    dimension: 'time',
    factor: '0.00011415525114155251',
    source: {
      unitgroup: { id: aliasId(1), version: draftVersion },
      flowproperty: { id: aliasId(2), version: draftVersion },
    },
    target: {
      unitgroup: { id: aliasId(3), version: publicVersion },
      flowproperty: { id: aliasId(4), version: publicVersion },
    },
  };
  const sourceUnitGroup = snapshotRemoteRow({
    table: 'unitgroups',
    id: batch.source.unitgroup.id,
    version: draftVersion,
    user_id: 'owner',
    state_code: 0,
    modified_at: '2026-07-11T00:00:00Z',
    json_ordered: aliasUnitGroupPayload({
      id: batch.source.unitgroup.id,
      version: draftVersion,
      referenceName: 'hr',
    }),
    model_id: null,
    rule_verification: null,
  });
  const targetUnitGroup = snapshotRemoteRow({
    table: 'unitgroups',
    id: batch.target.unitgroup.id,
    version: publicVersion,
    user_id: 'owner',
    state_code: 0,
    modified_at: '2026-07-11T00:00:00Z',
    json_ordered: aliasUnitGroupPayload({
      id: batch.target.unitgroup.id,
      version: publicVersion,
      referenceName: 'time',
      targetUnits: [
        { id: '1', mean: '1.0', name: 'a' },
        { id: '4', mean: batch.factor, name: 'hr' },
      ],
    }),
    model_id: null,
    rule_verification: null,
  });
  const targetUnitGroupReference = aliasReference(
    'unitgroups',
    batch.target.unitgroup.id,
    publicVersion,
    'Units of time',
  );
  const targetFlowProperty = snapshotRemoteRow({
    table: 'flowproperties',
    id: batch.target.flowproperty.id,
    version: publicVersion,
    user_id: 'owner',
    state_code: 0,
    modified_at: '2026-07-11T00:00:00Z',
    json_ordered: aliasFlowPropertyPayload({
      id: batch.target.flowproperty.id,
      version: publicVersion,
      name: 'Time',
      unitGroupReference: targetUnitGroupReference,
    }),
    model_id: null,
    rule_verification: null,
  });
  assert.equal(aliasInternals.targetSnapshotValid(null, 'unitgroups', batch, 'owner'), false);
  assert.equal(
    aliasInternals.targetSnapshotValid(targetUnitGroup, 'unitgroups', batch, 'owner'),
    true,
  );
  for (const mutate of [
    (value: typeof targetUnitGroup) => (value.table = 'flowproperties'),
    (value: typeof targetUnitGroup) => (value.id = 'wrong'),
    (value: typeof targetUnitGroup) => (value.version = 'wrong'),
    (value: typeof targetUnitGroup) => (value.user_id = 'wrong'),
    (value: typeof targetUnitGroup) => (value.state_code = 100),
    (value: typeof targetUnitGroup) => (value.modified_at = null),
    (value: typeof targetUnitGroup) => (value.json_ordered = null),
    (value: typeof targetUnitGroup) => (value.payload_sha256 = null),
  ]) {
    const value = structuredClone(targetUnitGroup);
    mutate(value);
    assert.equal(aliasInternals.targetSnapshotValid(value, 'unitgroups', batch, 'owner'), false);
  }
  assert.equal(
    aliasInternals.targetSnapshotValid(targetFlowProperty, 'flowproperties', batch, 'owner'),
    true,
  );
  assert.equal(aliasInternals.sourceUnitGroupSnapshotValid(null, batch, 'owner'), false);
  assert.equal(aliasInternals.sourceUnitGroupSnapshotValid(sourceUnitGroup, batch, 'owner'), true);
  for (const mutate of [
    (value: typeof sourceUnitGroup) => (value.table = 'flows'),
    (value: typeof sourceUnitGroup) => (value.id = 'wrong'),
    (value: typeof sourceUnitGroup) => (value.version = 'wrong'),
    (value: typeof sourceUnitGroup) => (value.user_id = 'wrong'),
    (value: typeof sourceUnitGroup) => (value.state_code = 100),
    (value: typeof sourceUnitGroup) => (value.modified_at = null),
    (value: typeof sourceUnitGroup) => (value.json_ordered = null),
    (value: typeof sourceUnitGroup) => (value.payload_sha256 = null),
  ]) {
    const value = structuredClone(sourceUnitGroup);
    mutate(value);
    assert.equal(aliasInternals.sourceUnitGroupSnapshotValid(value, batch, 'owner'), false);
  }

  const sourceUnit = aliasInternals.sourceReferenceUnit(sourceUnitGroup, batch);
  assert.deepEqual(sourceUnit, { '@dataSetInternalID': '1', meanValue: '1.0', name: 'hr' });
  assert.deepEqual(
    aliasInternals.targetConversionUnit({
      source: sourceUnit,
      target: targetUnitGroup,
      factor: batch.factor,
    }),
    { '@dataSetInternalID': '4', meanValue: batch.factor, name: 'hr' },
  );
  assert.equal(aliasInternals.sourceReferenceUnit(null, batch), null);
  assert.equal(
    aliasInternals.sourceReferenceUnit(
      { ...sourceUnitGroup, json_ordered: { unitGroupDataSet: { units: {} } } },
      batch,
    ),
    null,
  );
  const wrongSource = structuredClone(sourceUnitGroup);
  const wrongSourceUnit = (wrongSource.json_ordered!.unitGroupDataSet as JsonObject)
    .units as JsonObject;
  wrongSourceUnit.unit = [{ '@dataSetInternalID': '1', meanValue: 2, name: 'wrong' }];
  assert.equal(aliasInternals.sourceReferenceUnit(wrongSource, batch), null);
  assert.equal(
    aliasInternals.targetConversionUnit({ source: null, target: null, factor: '1' }),
    null,
  );
  assert.equal(aliasInternals.targetUnitGroupReferenceFromFlowProperty(null, batch), null);
  const wrongTargetFlowProperty = structuredClone(targetFlowProperty);
  const wrongTargetRoot = wrongTargetFlowProperty.json_ordered!.flowPropertyDataSet as JsonObject;
  (wrongTargetRoot.flowPropertiesInformation as JsonObject).quantitativeReference = {};
  assert.equal(
    aliasInternals.targetUnitGroupReferenceFromFlowProperty(wrongTargetFlowProperty, batch),
    null,
  );
  assert.deepEqual(
    aliasInternals.targetUnitGroupReferenceFromFlowProperty(targetFlowProperty, batch),
    targetUnitGroupReference,
  );

  const targetFlowPropertyReference = aliasReference(
    'flowproperties',
    batch.target.flowproperty.id,
    publicVersion,
    'Time',
  );
  const sourceFlowPropertyReference = aliasReference(
    'flowproperties',
    batch.source.flowproperty.id,
    draftVersion,
    'Amount in hr',
  );
  const flowPayloadValue = aliasFlowPayload({
    id: aliasId(10),
    version: draftVersion,
    flowPropertyReference: sourceFlowPropertyReference,
  });
  assert.equal(aliasInternals.flowPropertyEntries({}), null);
  assert.equal(aliasInternals.flowPropertyEntries({ flowDataSet: { flowProperties: {} } }), null);
  assert.deepEqual(
    aliasInternals.flowPropertyEntries({
      flowDataSet: { flowProperties: { flowProperty: [{ ok: true }] } },
    }),
    [{ ok: true }],
  );
  assert.equal(
    aliasInternals.flowPropertyEntries({
      flowDataSet: { flowProperties: { flowProperty: [{ ok: true }, null] } },
    }),
    null,
  );
  assert.equal(aliasInternals.flowPropertySingleton({}), null);
  assert.equal(aliasInternals.processExchangeEntries({}), null);
  assert.deepEqual(
    aliasInternals.processExchangeEntries({
      processDataSet: { exchanges: { exchange: { ok: true } } },
    }),
    [{ ok: true }],
  );
  assert.equal(
    aliasInternals.processExchangeEntries({
      processDataSet: { exchanges: { exchange: [{ ok: true }, null] } },
    }),
    null,
  );
  assert.deepEqual(aliasInternals.referenceIdentity(null), { id: null, version: null });
  assert.deepEqual(aliasInternals.referenceIdentity({ '@refObjectId': 1 }), {
    id: null,
    version: null,
  });
  assert.equal(aliasInternals.referenceMatches({ '@refObjectId': 'x' }, 'x'), true);
  assert.equal(aliasInternals.referenceMatches({ '@refObjectId': 'x' }, 'x', '1'), false);
  assert.equal(aliasInternals.canonicalFlowPropertyReference([], batch), null);
  const canonicalRows = [
    {
      table: 'flows',
      id: 'one',
      version: draftVersion,
      user_id: 'owner',
      state_code: 0,
      modified_at: 'now',
      json_ordered: aliasFlowPayload({
        id: 'one',
        version: draftVersion,
        flowPropertyReference: targetFlowPropertyReference,
      }),
      model_id: null,
      rule_verification: null,
    },
  ] satisfies DatasetMaintenanceRemoteRow[];
  assert.deepEqual(
    aliasInternals.canonicalFlowPropertyReference(canonicalRows, batch),
    targetFlowPropertyReference,
  );
  assert.equal(
    aliasInternals.canonicalFlowPropertyReference(
      [
        ...canonicalRows,
        {
          ...canonicalRows[0]!,
          id: 'two',
          json_ordered: aliasFlowPayload({
            id: 'two',
            version: draftVersion,
            flowPropertyReference: { ...targetFlowPropertyReference, extra: true },
          }),
        },
      ],
      batch,
    ),
    null,
  );
  assert.equal(aliasInternals.replaceAliasFlowProperty({}, batch, targetUnitGroupReference), null);
  assert.equal(
    aliasInternals.replaceFlowReferenceProperty({}, batch, targetFlowPropertyReference),
    null,
  );
  assert.ok(
    aliasInternals.replaceFlowReferenceProperty(
      flowPayloadValue,
      batch,
      targetFlowPropertyReference,
    ),
  );

  const exchange: JsonObject = {
    '@dataSetInternalID': '1',
    referenceToFlowDataSet: aliasReference('flows', aliasId(10), draftVersion, 'Affected'),
    exchangeDirection: 'Input',
    meanAmount: '1.0',
    resultingAmount: '1.0',
  };
  const processAction = {
    action_id: 'process',
    id: aliasId(20),
    version: draftVersion,
    exchange_instances: [
      {
        exchange_index: 0,
        data_set_internal_id: '1',
        flow_id: aliasId(10),
        flow_version: draftVersion,
        direction: 'Input',
        before_exchange_sha256: sha256Json(exchange),
        before_mean_amount: '1.0',
        before_resulting_amount: '1.0',
      },
    ],
  } as DatasetMaintenancePlanAction;
  const processPayloadValue = aliasProcessPayload({
    id: processAction.id,
    version: draftVersion,
    exchanges: [exchange],
  });
  assert.equal(
    aliasInternals.rewriteProcessExchanges({
      payload: {},
      action: processAction,
      batch,
    }),
    null,
  );
  assert.ok(
    aliasInternals.rewriteProcessExchanges({
      payload: processPayloadValue,
      action: processAction,
      batch,
    }),
  );
  for (const mutate of [
    (action: DatasetMaintenancePlanAction) => (action.exchange_instances = undefined),
    (action: DatasetMaintenancePlanAction) => (action.exchange_instances![0]!.exchange_index = 9),
    (action: DatasetMaintenancePlanAction) =>
      (action.exchange_instances![0]!.data_set_internal_id = 'wrong'),
    (action: DatasetMaintenancePlanAction) => (action.exchange_instances![0]!.flow_id = 'wrong'),
    (action: DatasetMaintenancePlanAction) => (action.exchange_instances![0]!.direction = 'Output'),
    (action: DatasetMaintenancePlanAction) =>
      (action.exchange_instances![0]!.before_exchange_sha256 = '0'.repeat(64)),
    (action: DatasetMaintenancePlanAction) =>
      (action.exchange_instances![0]!.before_mean_amount = 'wrong'),
    (action: DatasetMaintenancePlanAction) =>
      (action.exchange_instances![0]!.before_resulting_amount = 'wrong'),
  ]) {
    const action = structuredClone(processAction);
    mutate(action);
    assert.equal(
      aliasInternals.rewriteProcessExchanges({ payload: processPayloadValue, action, batch }),
      null,
    );
  }
  const invalidDecimalAction = structuredClone(processAction);
  const invalidDecimalPayload = structuredClone(processPayloadValue);
  const invalidDecimalExchange = (
    ((invalidDecimalPayload.processDataSet as JsonObject).exchanges as JsonObject)
      .exchange as JsonObject[]
  )[0]!;
  invalidDecimalExchange.meanAmount = 'invalid';
  invalidDecimalExchange.resultingAmount = 'invalid';
  invalidDecimalAction.exchange_instances![0]!.before_mean_amount = 'invalid';
  invalidDecimalAction.exchange_instances![0]!.before_resulting_amount = 'invalid';
  invalidDecimalAction.exchange_instances![0]!.before_exchange_sha256 =
    sha256Json(invalidDecimalExchange);
  assert.equal(
    aliasInternals.rewriteProcessExchanges({
      payload: invalidDecimalPayload,
      action: invalidDecimalAction,
      batch,
    }),
    null,
  );
  assert.deepEqual(
    aliasInternals.canonicalFlowPropertyReference(
      [{ ...canonicalRows[0]!, json_ordered: {} }, ...canonicalRows],
      batch,
    ),
    targetFlowPropertyReference,
  );
  assert.equal(
    aliasInternals.countFlowPropertyRefs([{ ...canonicalRows[0]!, json_ordered: null }], 'x', '1'),
    0,
  );
  assert.equal(
    aliasInternals.countFlowPropertyRefs([{ ...canonicalRows[0]!, json_ordered: {} }], 'x', '1'),
    0,
  );
  const malformedSupportRows = [
    { ...canonicalRows[0]!, table: 'flowproperties' as const, json_ordered: {} },
    {
      ...canonicalRows[0]!,
      table: 'flowproperties' as const,
      id: 'two',
      json_ordered: { flowPropertyDataSet: {} },
    },
  ];
  assert.equal(aliasInternals.countUnitGroupRefs(malformedSupportRows, 'x', '1'), 0);
  assert.equal(
    aliasInternals.flowsWithProperty([{ ...canonicalRows[0]!, json_ordered: {} }], 'x', '1').size,
    0,
  );
  const malformedProcessRows = [
    { ...canonicalRows[0]!, table: 'processes' as const, json_ordered: {} },
  ];
  assert.equal(aliasInternals.countExchangeFlowRefs(malformedProcessRows, new Set()), 0);
  assert.equal(aliasInternals.exchangeClosureKeys(malformedProcessRows, new Set()).size, 0);
  assert.equal(
    aliasInternals.selectorClosureKeys([{ ...processAction, exchange_instances: undefined }]).size,
    0,
  );
  assert.equal(
    aliasInternals.projectRows(canonicalRows, new Map(), []).at(0)?.json_ordered,
    canonicalRows[0]?.json_ordered,
  );
  assert.deepEqual(
    buildAliasRewritePlan({
      scope: {
        schema_version: 1,
        task_id: 'no-alias-batches',
        operation: 'delete',
        account: { user_id: 'owner' },
        actions: [],
      },
      actions: [],
      accountRows: malformedProcessRows,
      targetSnapshots: new Map(),
    }),
    { desired_payloads: new Map(), batches: [] },
  );
});

test('alias scope parser rejects malformed batches, bindings, and exchange locators', () => {
  const batch = (batchId: string, dimension: 'time' | 'length_time'): JsonObject => ({
    batch_id: batchId,
    dimension,
    factor: dimension === 'time' ? '0.00011415525114155251' : '1000',
    source: {
      unitgroup: { id: `${batchId}-source-ug`, version: '00.00.001' },
      flowproperty: { id: `${batchId}-source-fp`, version: '00.00.001' },
    },
    target: {
      unitgroup: { id: `${batchId}-target-ug`, version: '01.00.000' },
      flowproperty: { id: `${batchId}-target-fp`, version: '01.00.000' },
    },
  });
  const exchange = (): JsonObject => ({
    exchange_index: 0,
    data_set_internal_id: '1',
    flow_id: 'flow',
    flow_version: '00.00.001',
    direction: 'Input',
    before_exchange_sha256: 'a'.repeat(64),
    before_mean_amount: '1',
    before_resulting_amount: '1',
  });
  const valid: JsonObject = {
    schema_version: 1,
    task_id: 'alias-parser',
    operation: 'merge-support-aliases',
    target_mode: 'owner_draft',
    account: { user_id: 'owner' },
    alias_batches: [batch('time', 'time'), batch('length_time', 'length_time')],
    actions: [
      {
        action_id: 'fp',
        action: 'update_json_ordered',
        table: 'flowproperties',
        id: 'time-source-fp',
        version: '00.00.001',
        expected_user_id: 'owner',
        expected_state_code: 0,
        reason_code: 'ALIAS',
        reason: 'test',
        evidence: [],
        batch_id: 'time',
      },
    ],
  };
  assert.equal(parseMaintenanceScope(valid).operation, 'merge-support-aliases');
  const invalidValues: unknown[] = [];
  const add = (mutate: (value: JsonObject) => void): void => {
    const value = structuredClone(valid);
    mutate(value);
    invalidValues.push(value);
  };
  add((value) => delete value.target_mode);
  add((value) => (value.target_mode = 'public'));
  add((value) => (value.alias_batches = []));
  add((value) => ((value.alias_batches as unknown[])[0] = null));
  add((value) => (((value.alias_batches as JsonObject[])[0]!.source as unknown) = null));
  add((value) => ((value.alias_batches as JsonObject[])[0]!.dimension = 'bad'));
  add((value) => ((value.alias_batches as JsonObject[])[0]!.factor = '1'));
  add(
    (value) =>
      ((((value.alias_batches as JsonObject[])[0]!.target as JsonObject).unitgroup as unknown) =
        null),
  );
  add((value) => ((value.actions as JsonObject[])[0]!.table = 'unitgroups'));
  add((value) => ((value.actions as JsonObject[])[0]!.action = 'delete'));
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.action = 'delete';
    action.table = 'flows';
  });
  add((value) => delete (value.actions as JsonObject[])[0]!.batch_id);
  add((value) => ((value.actions as JsonObject[])[0]!.exchange_instances = [exchange()]));
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.table = 'processes';
  });
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.table = 'processes';
    action.exchange_instances = [{ ...exchange(), exchange_index: -1 }];
  });
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.table = 'processes';
    action.exchange_instances = [{ ...exchange(), before_exchange_sha256: 'bad' }];
  });
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.table = 'processes';
    action.exchange_instances = [{ ...exchange(), direction: 'Sideways' }];
  });
  add((value) => {
    const action = (value.actions as JsonObject[])[0]!;
    action.table = 'processes';
    action.exchange_instances = [exchange(), exchange()];
  });
  add((value) => {
    const batches = value.alias_batches as JsonObject[];
    batches[1]!.batch_id = 'time';
  });
  for (const value of invalidValues) {
    assert.throws(() => parseMaintenanceScope(value));
  }

  const nonAlias = {
    schema_version: 1,
    task_id: 'ordinary',
    operation: 'delete',
    account: { user_id: 'owner' },
    actions: [
      {
        action_id: 'delete',
        action: 'delete',
        table: 'flows',
        id: 'flow',
        version: '1',
        expected_user_id: 'owner',
        expected_state_code: 0,
        reason_code: 'DELETE',
        reason: 'test',
        evidence: [],
        batch_id: 'time',
      },
    ],
  };
  assert.throws(() => parseMaintenanceScope(nonAlias));
  delete (nonAlias.actions[0] as JsonObject).batch_id;
  (nonAlias.actions[0] as JsonObject).exchange_instances = [];
  assert.throws(() => parseMaintenanceScope(nonAlias));
});

test('alias whole-plan request serializes the exact DB #234 plan and nested batch allowlists', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-rpc-contract-'));
  try {
    const scenario = await prepareAliasScenario(root, 'rpc-contract');
    const planRequest = applyInternals.buildAliasPlanRequest({
      plan: scenario.plan,
      planDir: scenario.outDir,
    });
    assertExactAliasPlanRequestContract(planRequest);
    assert.equal(stableJsonText(planRequest).includes('"expected_user_id"'), false);
    for (const batch of scenario.plan.alias_batches!) {
      const request = applyInternals.buildAliasBatchRequest({
        plan: scenario.plan,
        batch,
        planDir: scenario.outDir,
      });
      assertExactAliasBatchRequestContract(request);

      const serialized = stableJsonText(request);
      assert.equal(serialized.includes('"expected_user_id"'), false);
      assertExactAliasBatchRequestContract(JSON.parse(serialized) as JsonObject);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomic FP alias plan changes 52 rows through one guarded RPC, logs 59 exchanges, and verifies', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-main-'));
  const remote = new FakeMaintenanceRemote('alias-main');
  const fixture = seedAliasFixture(remote);
  const scopePath = path.join(root, 'scope.json');
  const outDir = path.join(root, 'maintenance');
  writeFileSync(scopePath, JSON.stringify(fixture.scope));
  const now = new Date('2026-07-11T07:00:00.000Z');
  const passingAliasSchemas = {
    flowproperties: { safeParse: () => ({ success: true as const }) },
    flows: { safeParse: () => ({ success: true as const }) },
    processes: { safeParse: () => ({ success: true as const }) },
  };
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'merge-support-aliases',
      outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: passingAliasSchemas,
    });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.target_mode, 'owner_draft');
    assert.equal(
      plan.alias_batches?.every((batch) =>
        [
          batch.target_snapshots.unitgroup,
          batch.target_snapshots.flowproperty,
          batch.target_snapshots.source_unitgroup,
        ].every(
          (snapshot) =>
            snapshot?.user_id === remote.userId &&
            snapshot.state_code === 0 &&
            typeof snapshot.modified_at === 'string',
        ),
      ),
      true,
    );
    assert.equal(plan.summary.actions, 52);
    assert.equal(plan.summary.update_json_ordered, 52);
    assert.equal(plan.summary.atomic_batches, 2);
    assert.equal(plan.summary.scaled_exchanges, 59);
    assert.equal(plan.summary.scaled_amount_fields, 118);
    assert.equal(plan.summary.unrelated_exchanges_preserved, 309);
    assert.deepEqual(
      plan.alias_batches?.map((batch) => ({
        batch_id: batch.batch_id,
        rows: batch.summary.rows,
        exchanges: batch.summary.exchanges,
        postconditions: batch.postconditions,
      })),
      [
        {
          batch_id: 'time',
          rows: 25,
          exchanges: 20,
          postconditions: {
            source_unitgroup_incoming_refs: 0,
            source_flowproperty_flow_refs: 0,
            target_flow_refs: 106,
            target_exchange_refs: 441,
          },
        },
        {
          batch_id: 'length_time',
          rows: 27,
          exchanges: 39,
          postconditions: {
            source_unitgroup_incoming_refs: 0,
            source_flowproperty_flow_refs: 0,
            target_flow_refs: 32,
            target_exchange_refs: 3216,
          },
        },
      ],
    );
    assert.equal(
      plan.alias_batches?.[0]?.exchange_rewrites[0]?.after_mean_amount,
      '0.000114155251141552510',
    );
    assert.equal(plan.alias_batches?.[1]?.exchange_rewrites[0]?.after_mean_amount, '54.9000');
    assert.equal(parseMaintenancePlan(plan).operation, 'merge-support-aliases');
    const parsedScope = parseMaintenanceScope(fixture.scope, 'merge-support-aliases');
    const resetActions = (): DatasetMaintenancePlanAction[] =>
      structuredClone(plan.actions).map((action) => ({
        ...action,
        status: 'ready' as const,
        blockers: [],
        desired_payload: null,
        alias_mutation: undefined,
      }));
    const targetSnapshots = new Map(
      plan.alias_batches!.map((batch) => [batch.batch_id, batch.target_snapshots]),
    );
    const emptyBuild = buildAliasRewritePlan({
      scope: parsedScope,
      actions: [],
      accountRows: [],
      targetSnapshots: new Map(),
      schemas: passingAliasSchemas,
    });
    assert.equal(emptyBuild.batches.length, 2);
    assert.equal(emptyBuild.desired_payloads.size, 0);

    const schemaBlockedActions = resetActions();
    buildAliasRewritePlan({
      scope: parsedScope,
      actions: schemaBlockedActions,
      accountRows: aliasRemoteRows(remote),
      targetSnapshots,
      schemas: {
        flowproperties: { safeParse: () => ({ success: false as const }) },
        flows: { safeParse: () => ({ success: false as const }) },
        processes: { safeParse: () => ({ success: false as const }) },
      },
    });
    assert.equal(
      schemaBlockedActions.every((action) => action.status === 'blocked'),
      true,
    );

    const closureBlockedActions = resetActions();
    closureBlockedActions.find((action) => action.table === 'flowproperties')!.id = 'wrong-source';
    closureBlockedActions.find((action) => action.table === 'processes')!.exchange_instances!.pop();
    const accountRowsWithoutOneFlow = aliasRemoteRows(remote).filter(
      (row) => row.id !== plan.actions.find((action) => action.table === 'flows')!.id,
    );
    buildAliasRewritePlan({
      scope: parsedScope,
      actions: closureBlockedActions,
      accountRows: accountRowsWithoutOneFlow,
      targetSnapshots,
      schemas: passingAliasSchemas,
    });
    assert.match(
      closureBlockedActions
        .flatMap((action) => action.blockers.map((entry) => entry.code))
        .join(','),
      /ALIAS_SOURCE_FLOWPROPERTY_ACTION_MISMATCH|ALIAS_REFERENCE_CLOSURE_MISMATCH|ALIAS_EXCHANGE_COUNT_MISMATCH/u,
    );
    assert.equal(
      readJsonLinesIfPresent(path.join(outDir, 'exchange-rewrite-plan.jsonl')).length,
      fixture.selected_exchange_count,
    );

    const remoteCallsBeforeApply = remote.rpcOrder.length;
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
          now,
        }),
      (error: unknown) =>
        error instanceof CliError && error.code === 'DATASET_MAINTENANCE_PROTECTED_RUN_REQUIRED',
    );
    assert.equal(remote.rpcOrder.length, remoteCallsBeforeApply);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomic alias apply retries the whole exact plan after a committed response is lost', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-replay-'));
  const remote = new FakeMaintenanceRemote('alias-replay');
  const fixture = seedAliasFixture(remote);
  const scopePath = path.join(root, 'scope.json');
  const outDir = path.join(root, 'maintenance');
  writeFileSync(scopePath, JSON.stringify(fixture.scope));
  const now = new Date('2026-07-11T07:30:00.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'merge-support-aliases',
      outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: {
        flowproperties: { safeParse: () => ({ success: true as const }) },
        flows: { safeParse: () => ({ success: true as const }) },
        processes: { safeParse: () => ({ success: true as const }) },
      },
    });
    const remoteCallsBeforeApply = remote.rpcOrder.length;
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
          now,
        }),
      /run-protected/u,
    );
    assert.equal(remote.rpcOrder.length, remoteCallsBeforeApply);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('second-dimension rejection rolls back the first dimension and exposes no 25-row success', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-plan-rollback-'));
  try {
    const scenario = await prepareAliasScenario(root, 'rollback');
    const beforeSha256 = sha256Json(aliasRemoteRows(scenario.remote));
    const remoteCallsBeforeApply = scenario.remote.rpcOrder.length;
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: scenario.plan.plan_sha256,
          confirm: scenario.remote.email,
          env: scenario.remote.env,
          fetchImpl: scenario.remote.fetch,
          now: new Date('2026-07-11T08:00:00.000Z'),
        }),
      /run-protected/u,
    );
    assert.equal(sha256Json(aliasRemoteRows(scenario.remote)), beforeSha256);
    assert.equal(scenario.remote.rpcOrder.length, remoteCallsBeforeApply);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias plan contracts reject stale locks, malformed proofs, and legacy summary drift', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-contract-'));
  try {
    const scenario = await prepareAliasScenario(root, 'contract');
    const staleLock = structuredClone(scenario.plan);
    staleLock.actions[0]!.before!.modified_at = null;
    staleLock.plan_sha256 = computePlanSha256(staleLock);
    assert.throws(() => parseMaintenancePlan(staleLock), /frozen modified_at/u);

    const missingMutation = structuredClone(scenario.plan);
    delete missingMutation.actions[0]!.alias_mutation;
    missingMutation.plan_sha256 = computePlanSha256(missingMutation);
    assert.throws(() => parseMaintenancePlan(missingMutation), /alias plan contract/u);

    const badUnrelatedCount = structuredClone(scenario.plan);
    badUnrelatedCount.alias_batches![0]!.summary.unrelated_exchanges -= 1;
    badUnrelatedCount.summary.unrelated_exchanges_preserved =
      (badUnrelatedCount.summary.unrelated_exchanges_preserved ?? 0) - 1;
    badUnrelatedCount.plan_sha256 = computePlanSha256(badUnrelatedCount);
    assert.throws(() => parseMaintenancePlan(badUnrelatedCount), /alias plan contract/u);

    const wrongTargetMode = structuredClone(scenario.plan) as unknown as JsonObject;
    wrongTargetMode.target_mode = 'public';
    wrongTargetMode.plan_sha256 = computePlanSha256(
      wrongTargetMode as unknown as DatasetMaintenancePlan,
    );
    assert.throws(() => parseMaintenancePlan(wrongTargetMode), /target_mode=owner_draft/u);

    const blockedWithoutSupportPayload = structuredClone(scenario.plan);
    const supportBlocker = {
      code: 'TARGET_SUPPORT_PAYLOAD_MISSING',
      message: 'Target support payload is unavailable.',
      action_id: blockedWithoutSupportPayload.actions[0]!.action_id,
      table: blockedWithoutSupportPayload.actions[0]!.table,
      id: blockedWithoutSupportPayload.actions[0]!.id,
      version: blockedWithoutSupportPayload.actions[0]!.version,
    };
    blockedWithoutSupportPayload.status = 'blocked';
    blockedWithoutSupportPayload.actions[0]!.status = 'blocked';
    blockedWithoutSupportPayload.actions[0]!.blockers = [supportBlocker];
    blockedWithoutSupportPayload.blockers = [supportBlocker];
    blockedWithoutSupportPayload.summary.blockers = 1;
    blockedWithoutSupportPayload.alias_batches![0]!.target_snapshots.unitgroup!.json_ordered = null;
    blockedWithoutSupportPayload.plan_sha256 = computePlanSha256(blockedWithoutSupportPayload);
    assert.equal(parseMaintenancePlan(blockedWithoutSupportPayload).status, 'blocked');

    const missingTargetModePlan = structuredClone(scenario.plan);
    missingTargetModePlan.target_mode = null;
    await assert.rejects(
      () =>
        applyInternals.assertAliasSupportSnapshots({
          plan: missingTargetModePlan,
          context: scenario.context,
        }),
      /target_mode=owner_draft/u,
    );
    assert.throws(
      () =>
        applyInternals.buildAliasBatchRequest({
          plan: missingTargetModePlan,
          batch: missingTargetModePlan.alias_batches![0]!,
          planDir: scenario.outDir,
        }),
      /target_mode=owner_draft/u,
    );
    assert.throws(
      () =>
        applyInternals.buildAliasPlanRequest({
          plan: missingTargetModePlan,
          planDir: scenario.outDir,
        }),
      /target_mode=owner_draft/u,
    );
    const missingDimensionPlan = structuredClone(scenario.plan);
    missingDimensionPlan.alias_batches = [missingDimensionPlan.alias_batches![0]!];
    assert.throws(
      () =>
        applyInternals.buildAliasPlanRequest({
          plan: missingDimensionPlan,
          planDir: scenario.outDir,
        }),
      /time followed by length_time/u,
    );

    const ordinary = await prepareSeededScenario(root, 'legacy-summary');
    const legacySummary = structuredClone(ordinary.plan);
    delete legacySummary.summary.update_json_ordered;
    delete legacySummary.summary.atomic_batches;
    delete legacySummary.summary.scaled_exchanges;
    delete legacySummary.summary.scaled_amount_fields;
    delete legacySummary.summary.unrelated_exchanges_preserved;
    legacySummary.plan_sha256 = computePlanSha256(legacySummary);
    assert.equal(parseMaintenancePlan(legacySummary).operation, 'repair-references');

    assert.throws(
      () =>
        applyInternals.validateAliasRpcResult({}, scenario.plan.alias_batches![0]!, scenario.plan),
      /invalid proof/u,
    );
    const proofBatch = scenario.plan.alias_batches![0]!;
    const numericAuditProof: JsonObject = {
      ok: true,
      command: 'cmd_dataset_alias_batch_guarded',
      target_visibility: 'owner_draft',
      dimension: proofBatch.dimension,
      batch_id: proofBatch.batch_id,
      row_count: proofBatch.summary.rows,
      exchange_count: proofBatch.summary.exchanges,
      summary_audit_id: Number('9007199254740993'),
      batch_request_sha256: 'a'.repeat(64),
      idempotent_replay: false,
      audit: proofBatch.action_ids.map((actionId, index) => {
        const action = scenario.plan.actions.find((entry) => entry.action_id === actionId)!;
        return {
          action_id: action.action_id,
          table: action.table,
          id: action.id,
          version: action.version,
          audit_id: String(index + 1),
        };
      }),
    };
    assert.throws(
      () => applyInternals.validateAliasRpcResult(numericAuditProof, proofBatch, scenario.plan),
      /invalid proof/u,
    );
    numericAuditProof.summary_audit_id = '9007199254740993';
    (numericAuditProof.audit as JsonObject[])[0]!.audit_id = '1';
    numericAuditProof.target_visibility = 'public';
    assert.throws(
      () => applyInternals.validateAliasRpcResult(numericAuditProof, proofBatch, scenario.plan),
      /invalid proof/u,
    );
    numericAuditProof.target_visibility = 'owner_draft';
    (numericAuditProof.audit as JsonObject[])[0]!.audit_id = Number('9007199254740993');
    assert.throws(
      () => applyInternals.validateAliasRpcResult(numericAuditProof, proofBatch, scenario.plan),
      /invalid proof/u,
    );

    const planRequest = applyInternals.buildAliasPlanRequest({
      plan: scenario.plan,
      planDir: scenario.outDir,
    });
    assertExactAliasPlanRequestContract(planRequest);
    const batchProofs = scenario.plan
      .alias_batches!.slice()
      .sort((left, right) => (left.dimension === 'time' ? -1 : right.dimension === 'time' ? 1 : 0))
      .map((batch, batchIndex) => ({
        ok: true,
        command: 'cmd_dataset_alias_batch_guarded',
        target_visibility: 'owner_draft',
        dimension: batch.dimension,
        batch_id: batch.batch_id,
        row_count: batch.summary.rows,
        exchange_count: batch.summary.exchanges,
        summary_audit_id: String(9_001 + batchIndex),
        batch_request_sha256: String(batchIndex + 1).repeat(64),
        idempotent_replay: false,
        audit: batch.action_ids.map((actionId, index) => {
          const action = scenario.plan.actions.find((entry) => entry.action_id === actionId)!;
          return {
            action_id: action.action_id,
            table: action.table,
            id: action.id,
            version: action.version,
            audit_id: String((batchIndex + 1) * 10_000 + index),
          };
        }),
      }));
    const validPlanProof: JsonObject = {
      ok: true,
      command: 'cmd_dataset_alias_plan_guarded',
      schema_version: 'dataset-alias-plan.v1',
      plan_sha256: scenario.plan.plan_sha256,
      operation_id: scenario.plan.operation_id,
      target_visibility: 'owner_draft',
      plan_request_sha256: 'f'.repeat(64),
      batch_count: 2,
      row_count: 52,
      exchange_count: 59,
      summary_audit_id: '9900',
      batches: batchProofs,
      idempotent_replay: false,
    };
    assert.equal(
      applyInternals.validateAliasPlanRpcResult(validPlanProof, scenario.plan).row_count,
      52,
    );
    validPlanProof.plan_sha256 = '0'.repeat(64);
    assert.throws(
      () => applyInternals.validateAliasPlanRpcResult(validPlanProof, scenario.plan),
      /whole-plan proof/u,
    );
    validPlanProof.plan_sha256 = scenario.plan.plan_sha256;
    validPlanProof.summary_audit_id = Number('9007199254740993');
    assert.throws(
      () => applyInternals.validateAliasPlanRpcResult(validPlanProof, scenario.plan),
      /whole-plan proof/u,
    );
    validPlanProof.summary_audit_id = '9900';
    (batchProofs[1]!.audit as JsonObject[])[0]!.audit_id = '10000';
    assert.throws(
      () => applyInternals.validateAliasPlanRpcResult(validPlanProof, scenario.plan),
      /whole-plan proof/u,
    );
    const invalidNestedProof = { ...validPlanProof, batches: [null, null] } as JsonObject;
    assert.throws(
      () => applyInternals.validateAliasPlanRpcResult(invalidNestedProof, scenario.plan),
      /whole-plan proof/u,
    );

    const invalidBatchProgressPath = path.join(root, 'invalid-alias-batch-progress.jsonl');
    writeFileSync(invalidBatchProgressPath, '{}\n');
    assert.throws(
      () => applyInternals.parseAliasBatchProgress(scenario.plan, invalidBatchProgressPath),
      /invalid or foreign entry/u,
    );
    const validBatchProgress = {
      schema_version: 1,
      plan_sha256: scenario.plan.plan_sha256,
      operation_id: scenario.plan.operation_id,
      batch_id: proofBatch.batch_id,
      target_mode: 'owner_draft',
      dimension: proofBatch.dimension,
      factor: proofBatch.factor,
      actor: { user_id: scenario.plan.account.user_id, email: scenario.plan.account.email },
      started_at_utc: '2026-07-11T00:00:00.000Z',
      ended_at_utc: '2026-07-11T00:00:01.000Z',
      batch_request_sha256: '1'.repeat(64),
      idempotent_replay: false,
      row_count: proofBatch.summary.rows,
      exchange_count: proofBatch.summary.exchanges,
      summary_audit_id: '9001',
      plan_request_sha256: 'f'.repeat(64),
      plan_summary_audit_id: '9900',
      result: 'success',
      error: null,
    };
    writeFileSync(
      invalidBatchProgressPath,
      `${JSON.stringify(validBatchProgress)}\n${JSON.stringify(validBatchProgress)}\n`,
    );
    assert.throws(
      () => applyInternals.parseAliasBatchProgress(scenario.plan, invalidBatchProgressPath),
      /duplicate success proof/u,
    );
    const invalidPlanProgressPath = path.join(root, 'invalid-alias-plan-progress.jsonl');
    writeFileSync(invalidPlanProgressPath, '{}\n');
    assert.throws(
      () => applyInternals.parseAliasPlanProgress(scenario.plan, invalidPlanProgressPath),
      /invalid or foreign entry/u,
    );
    const validPlanProgress = {
      schema_version: 1,
      plan_sha256: scenario.plan.plan_sha256,
      operation_id: scenario.plan.operation_id,
      target_mode: 'owner_draft',
      actor: { user_id: scenario.plan.account.user_id, email: scenario.plan.account.email },
      started_at_utc: '2026-07-11T00:00:00.000Z',
      ended_at_utc: '2026-07-11T00:00:01.000Z',
      plan_request_sha256: 'f'.repeat(64),
      idempotent_replay: false,
      batch_count: 2,
      row_count: 52,
      exchange_count: 59,
      summary_audit_id: '9900',
      batches: batchProofs.map((proof) => ({
        batch_id: proof.batch_id,
        dimension: proof.dimension,
        batch_request_sha256: proof.batch_request_sha256,
        summary_audit_id: proof.summary_audit_id,
      })),
      result: 'success',
      error: null,
    };
    writeFileSync(
      invalidPlanProgressPath,
      `${JSON.stringify(validPlanProgress)}\n${JSON.stringify(validPlanProgress)}\n`,
    );
    assert.throws(
      () => applyInternals.parseAliasPlanProgress(scenario.plan, invalidPlanProgressPath),
      /duplicate success proof/u,
    );

    const validFailedPlanProgress = {
      ...validPlanProgress,
      plan_request_sha256: null,
      idempotent_replay: null,
      summary_audit_id: null,
      batches: [],
      result: 'failed',
      error: 'expected failed attempt',
    };
    writeFileSync(invalidPlanProgressPath, `${JSON.stringify(validFailedPlanProgress)}\n`);
    const parsedFailure = applyInternals.parseAliasPlanProgress(
      scenario.plan,
      invalidPlanProgressPath,
    );
    assert.equal(parsedFailure.latestFailure?.error, 'expected failed attempt');

    const beforeRows = aliasRemoteRows(scenario.remote);
    assert.doesNotThrow(() =>
      applyInternals.assertApplyPreconditions({
        plan: scenario.plan,
        planDir: scenario.outDir,
        currentRows: beforeRows,
        progress: applyInternals.parseProgress(
          scenario.plan,
          path.join(root, 'happy-no-progress.jsonl'),
        ),
        aliasPlanProgress: applyInternals.parseAliasPlanProgress(
          scenario.plan,
          path.join(root, 'happy-no-plan-progress.jsonl'),
        ),
      }),
    );
    writeFileSync(invalidPlanProgressPath, `${JSON.stringify(validPlanProgress)}\n`);
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: scenario.plan,
          planDir: scenario.outDir,
          currentRows: beforeRows,
          progress: applyInternals.parseProgress(
            scenario.plan,
            path.join(root, 'success-no-row-progress.jsonl'),
          ),
          aliasPlanProgress: applyInternals.parseAliasPlanProgress(
            scenario.plan,
            invalidPlanProgressPath,
          ),
        }),
      /split across dimension states/u,
    );

    const mixedRows = aliasRemoteRows(scenario.remote);
    const first = scenario.plan.actions[0]!;
    const mixed = mixedRows.find(
      (row) => row.table === first.table && row.id === first.id && row.version === first.version,
    )!;
    mixed.json_ordered = applyInternals.loadDesiredPayload(scenario.outDir, first);
    mixed.modified_at = '2026-07-03T00:00:00.000Z';
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: scenario.plan,
          planDir: scenario.outDir,
          currentRows: mixedRows,
          progress: applyInternals.parseProgress(
            scenario.plan,
            path.join(root, 'no-progress.jsonl'),
          ),
          aliasPlanProgress: applyInternals.parseAliasPlanProgress(
            scenario.plan,
            path.join(root, 'no-plan-progress.jsonl'),
          ),
        }),
      /Atomic alias batch row state drifted/u,
    );
    const splitDimensionRows = aliasRemoteRows(scenario.remote);
    for (const actionId of scenario.plan.alias_batches![0]!.action_ids) {
      const action = scenario.plan.actions.find((entry) => entry.action_id === actionId)!;
      const row = splitDimensionRows.find(
        (entry) =>
          entry.table === action.table &&
          entry.id === action.id &&
          entry.version === action.version,
      )!;
      row.json_ordered = applyInternals.loadDesiredPayload(scenario.outDir, action);
      row.modified_at = '2026-07-03T00:00:00.000Z';
    }
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: scenario.plan,
          planDir: scenario.outDir,
          currentRows: splitDimensionRows,
          progress: applyInternals.parseProgress(
            scenario.plan,
            path.join(root, 'no-progress.jsonl'),
          ),
          aliasPlanProgress: applyInternals.parseAliasPlanProgress(
            scenario.plan,
            path.join(root, 'no-plan-progress.jsonl'),
          ),
        }),
      /split across dimension states/u,
    );
    const missingRows = aliasRemoteRows(scenario.remote).filter(
      (row) => !(row.table === first.table && row.id === first.id && row.version === first.version),
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: scenario.plan,
          planDir: scenario.outDir,
          currentRows: missingRows,
          progress: applyInternals.parseProgress(
            scenario.plan,
            path.join(root, 'no-progress.jsonl'),
          ),
          aliasPlanProgress: applyInternals.parseAliasPlanProgress(
            scenario.plan,
            path.join(root, 'no-plan-progress.jsonl'),
          ),
        }),
      /Atomic alias batch row state drifted/u,
    );

    const target = scenario.plan.alias_batches![0]!.target_snapshots.unitgroup!;
    const targetRow = scenario.remote.rows
      .get(target.table)!
      .find((row) => row.id === target.id && row.version === target.version)!;
    targetRow.state_code = 100;
    await assert.rejects(
      () =>
        applyInternals.assertAliasSupportSnapshots({
          plan: scenario.plan,
          context: scenario.context,
        }),
      /support row drifted/u,
    );
    scenario.remote.rows.get(target.table)!.splice(
      scenario.remote.rows
        .get(target.table)!
        .findIndex((row) => row.id === target.id && row.version === target.version),
      1,
    );
    await assert.rejects(
      () =>
        applyInternals.assertAliasSupportSnapshots({
          plan: scenario.plan,
          context: scenario.context,
        }),
      /support row drifted/u,
    );

    const identityRemote = new FakeMaintenanceRemote('alias-identity-mismatch');
    const identityFixture = seedAliasFixture(identityRemote);
    const identityFlow = identityRemote.rows.get('flows')!.find((row) => row.state_code === 0)!;
    const flowInformation = (identityFlow.json_ordered!.flowDataSet as JsonObject)
      .flowInformation as JsonObject;
    (flowInformation.dataSetInformation as JsonObject)['common:UUID'] = aliasId(999_998);
    const identityScopePath = path.join(root, 'identity-scope.json');
    writeFileSync(identityScopePath, JSON.stringify(identityFixture.scope));
    const identityPlan = await runDatasetMaintenancePlan({
      scopePath: identityScopePath,
      operation: 'merge-support-aliases',
      outDir: path.join(root, 'identity-plan'),
      env: identityRemote.env,
      fetchImpl: identityRemote.fetch,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: {
        flowproperties: { safeParse: () => ({ success: true as const }) },
        flows: { safeParse: () => ({ success: true as const }) },
        processes: { safeParse: () => ({ success: true as const }) },
      },
    });
    assert.match(
      identityPlan.blockers.map((entry) => entry.code).join(','),
      /DESIRED_PAYLOAD_IDENTITY_MISMATCH/u,
    );

    const malformedRemote = new FakeMaintenanceRemote('alias-malformed-support');
    const malformedFixture = seedAliasFixture(malformedRemote);
    malformedRemote.rows.get('unitgroups')!.find((row) => row.id === aliasId(3))!.json_ordered = {};
    malformedRemote.rows.get('unitgroups')!.find((row) => row.id === aliasId(1))!.json_ordered =
      null;
    malformedRemote.rows.get('processes')!.find((row) => row.state_code === 0)!.json_ordered = {};
    malformedRemote.rows.get('processes')!.splice(1, 1);
    const missingTargetIndex = malformedRemote.rows
      .get('unitgroups')!
      .findIndex((row) => row.id === aliasId(103));
    malformedRemote.rows.get('unitgroups')!.splice(missingTargetIndex, 1);
    const malformedScopePath = path.join(root, 'malformed-support-scope.json');
    writeFileSync(malformedScopePath, JSON.stringify(malformedFixture.scope));
    const malformedPlan = await runDatasetMaintenancePlan({
      scopePath: malformedScopePath,
      operation: 'merge-support-aliases',
      outDir: path.join(root, 'malformed-support-plan'),
      env: malformedRemote.env,
      fetchImpl: malformedRemote.fetch,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: {
        flowproperties: { safeParse: () => ({ success: true as const }) },
        flows: { safeParse: () => ({ success: true as const }) },
        processes: { safeParse: () => ({ success: true as const }) },
      },
    });
    assert.equal(malformedPlan.status, 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias apply rejects invalid RPC/readback proofs and repairs only exact durable logs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-defensive-'));
  const apply = async (scenario: Awaited<ReturnType<typeof prepareAliasScenario>>) => {
    await executeLegacyAliasFixtureForVerification(scenario);
    return { status: 'completed' as const };
  };
  try {
    const supportSuccess = await prepareAliasScenario(root, 'support-success');
    await applyInternals.assertAliasSupportSnapshots({
      plan: supportSuccess.plan,
      context: supportSuccess.context,
    });

    const supportDrift = await prepareAliasScenario(root, 'support-drift');
    const supportSnapshot = supportDrift.plan.alias_batches![0]!.target_snapshots.unitgroup!;
    const supportRow = (supportDrift.remote.rows.get(supportSnapshot.table) ?? []).find(
      (row) => row.id === supportSnapshot.id && row.version === supportSnapshot.version,
    )!;
    supportRow.json_ordered = { drifted: true };
    await assert.rejects(
      applyInternals.assertAliasSupportSnapshots({
        plan: supportDrift.plan,
        context: supportDrift.context,
      }),
      /support row drifted/u,
    );
    await applyInternals.assertAliasSupportSnapshots({
      plan: { ...supportDrift.plan, alias_batches: [] },
      context: supportDrift.context,
    });

    const supportOwnerDrift = await prepareAliasScenario(root, 'support-owner-drift');
    const supportOwnerSnapshot =
      supportOwnerDrift.plan.alias_batches![0]!.target_snapshots.unitgroup!;
    const supportOwnerRow = (
      supportOwnerDrift.remote.rows.get(supportOwnerSnapshot.table) ?? []
    ).find(
      (row) => row.id === supportOwnerSnapshot.id && row.version === supportOwnerSnapshot.version,
    )!;
    supportOwnerRow.user_id = '00000000-0000-4000-8000-000000000099';
    await assert.rejects(
      applyInternals.assertAliasSupportSnapshots({
        plan: supportOwnerDrift.plan,
        context: supportOwnerDrift.context,
      }),
      /support row drifted/u,
    );

    const invalidProof = await prepareAliasScenario(root, 'invalid-proof');
    invalidProof.remote.invalidAliasProof = true;
    await assert.rejects(() => executeRetiredAliasFixture(invalidProof), /whole-plan proof/u);

    for (const failure of ['missing', 'mismatch'] as const) {
      const readback = await prepareAliasScenario(root, `readback-${failure}`);
      readback.remote.aliasReadbackFailure = failure;
      await assert.rejects(() => executeRetiredAliasFixture(readback), /readback failed/u);
    }

    const partial = await prepareAliasScenario(root, 'partial-log');
    assert.equal((await apply(partial)).status, 'completed');
    const partialExchangePath = path.join(partial.outDir, 'alias-exchange-progress.jsonl');
    const partialExchangeEntries = readJsonLinesIfPresent(partialExchangePath);
    writeFileSync(
      partialExchangePath,
      `${partialExchangeEntries
        .slice(0, -1)
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    const repaired = await apply(partial);
    assert.equal(repaired.status, 'completed');
    assert.equal(readJsonLinesIfPresent(partialExchangePath).length, 59);

    const rowMismatch = await prepareAliasScenario(root, 'row-proof-mismatch');
    assert.equal((await apply(rowMismatch)).status, 'completed');
    const rowProgressPath = path.join(rowMismatch.outDir, 'apply-progress.jsonl');
    const rowEntries = readJsonLinesIfPresent(rowProgressPath) as JsonObject[];
    rowEntries[0]!.database_audit_id = '999999';
    writeFileSync(
      rowProgressPath,
      `${rowEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const rowExchangePath = path.join(rowMismatch.outDir, 'alias-exchange-progress.jsonl');
    const rowExchangeEntries = readJsonLinesIfPresent(rowExchangePath);
    let removedTimeExchange = false;
    writeFileSync(
      rowExchangePath,
      `${rowExchangeEntries
        .filter((entry) => {
          if (!removedTimeExchange && isJsonObject(entry) && entry.batch_id === 'time') {
            removedTimeExchange = true;
            return false;
          }
          return true;
        })
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    await assert.rejects(
      () => apply(rowMismatch),
      /row progress does not match replay audit proof/u,
    );

    const invalidExchange = await prepareAliasScenario(root, 'invalid-exchange-log');
    assert.equal((await apply(invalidExchange)).status, 'completed');
    const invalidExchangePath = path.join(invalidExchange.outDir, 'alias-exchange-progress.jsonl');
    const invalidExchangeEntries = readJsonLinesIfPresent(invalidExchangePath);
    writeFileSync(
      invalidExchangePath,
      `${invalidExchangeEntries
        .slice(0, -1)
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n{"batch_id":"time"}\n`,
    );
    await assert.rejects(
      () => apply(invalidExchange),
      /exchange progress contains an invalid or foreign entry/u,
    );

    const auditMismatch = await prepareAliasScenario(root, 'exchange-audit-mismatch');
    assert.equal((await apply(auditMismatch)).status, 'completed');
    const auditMismatchPath = path.join(auditMismatch.outDir, 'alias-exchange-progress.jsonl');
    const auditMismatchEntries = readJsonLinesIfPresent(auditMismatchPath) as JsonObject[];
    auditMismatchEntries[0]!.database_audit_id = '999999';
    writeFileSync(
      auditMismatchPath,
      `${auditMismatchEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await assert.rejects(
      () => apply(auditMismatch),
      /exchange progress contains an invalid or foreign entry/u,
    );

    const batchProofMismatch = await prepareAliasScenario(root, 'batch-proof-mismatch');
    assert.equal((await apply(batchProofMismatch)).status, 'completed');
    const batchProofPath = path.join(batchProofMismatch.outDir, 'alias-batch-progress.jsonl');
    const batchProofEntries = readJsonLinesIfPresent(batchProofPath) as JsonObject[];
    batchProofEntries[0]!.batch_request_sha256 = 'a'.repeat(64);
    writeFileSync(
      batchProofPath,
      `${batchProofEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await assert.rejects(
      () => apply(batchProofMismatch),
      /batch proof does not match whole-plan replay/u,
    );

    const planProofMismatch = await prepareAliasScenario(root, 'plan-proof-mismatch');
    assert.equal((await apply(planProofMismatch)).status, 'completed');
    const planProofPath = path.join(planProofMismatch.outDir, 'alias-plan-progress.jsonl');
    const planProofEntries = readJsonLinesIfPresent(planProofPath) as JsonObject[];
    planProofEntries[0]!.plan_request_sha256 = 'e'.repeat(64);
    writeFileSync(
      planProofPath,
      `${planProofEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await assert.rejects(
      () => apply(planProofMismatch),
      /plan proof does not match whole-plan replay/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias verification reports support drift, failed batches, duplicate proofs, and missing exchanges', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-verify-'));
  try {
    const scenario = await prepareAliasScenario(root, 'verify');
    const now = new Date('2026-07-11T09:30:00.000Z');
    await executeLegacyAliasFixtureForVerification(scenario);
    writeLegacyAliasCommitReport(scenario);
    const target = scenario.plan.alias_batches![0]!.target_snapshots.flowproperty!;
    const targetRow = scenario.remote.rows
      .get(target.table)!
      .find((row) => row.id === target.id && row.version === target.version)!;
    const targetPayload = targetRow.json_ordered;
    targetRow.json_ordered = { drifted: true };
    const supportDrift = await runDatasetMaintenanceVerify({
      planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'support-drift'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    assert.match(
      supportDrift.issues.map((entry) => entry.code).join(','),
      /ALIAS_SUPPORT_READBACK_MISMATCH/u,
    );
    targetRow.json_ordered = targetPayload;
    const targetRows = scenario.remote.rows.get(target.table)!;
    const targetIndex = targetRows.findIndex(
      (row) => row.id === target.id && row.version === target.version,
    );
    const [removedTarget] = targetRows.splice(targetIndex, 1);
    const supportMissing = await runDatasetMaintenanceVerify({
      planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'support-missing'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    assert.match(
      supportMissing.issues.map((entry) => entry.code).join(','),
      /ALIAS_SUPPORT_READBACK_MISMATCH/u,
    );
    targetRows.splice(targetIndex, 0, removedTarget!);

    const planProgressPath = path.join(scenario.outDir, 'alias-plan-progress.jsonl');
    const planEntries = readJsonLinesIfPresent(planProgressPath) as JsonObject[];
    const invalidPlanEntry = structuredClone(planEntries[0]!);
    invalidPlanEntry.summary_audit_id = Number('9007199254740993');
    writeFileSync(planProgressPath, `null\n${JSON.stringify(invalidPlanEntry)}\n`);
    const invalidPlanProof = await runDatasetMaintenanceVerify({
      planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'invalid-plan-proof'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    assert.match(
      invalidPlanProof.issues.map((entry) => entry.code).join(','),
      /ALIAS_PLAN_PROGRESS_INVALID/u,
    );
    assert.match(
      invalidPlanProof.issues.map((entry) => entry.code).join(','),
      /ALIAS_PLAN_SUCCESS_LOG_MISSING/u,
    );
    const failedPlanEntry = {
      ...planEntries[0]!,
      plan_request_sha256: null,
      idempotent_replay: null,
      summary_audit_id: null,
      batches: [],
      result: 'failed',
      error: 'expected failed plan proof',
    };
    writeFileSync(planProgressPath, `${JSON.stringify(failedPlanEntry)}\n`);
    const failedPlanProof = await runDatasetMaintenanceVerify({
      planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'failed-plan-proof'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    assert.match(
      failedPlanProof.issues.map((entry) => entry.code).join(','),
      /ALIAS_PLAN_SUCCESS_LOG_MISSING/u,
    );
    writeFileSync(planProgressPath, `${JSON.stringify(planEntries[0])}\n`);

    const batchProgressPath = path.join(scenario.outDir, 'alias-batch-progress.jsonl');
    const exchangeProgressPath = path.join(scenario.outDir, 'alias-exchange-progress.jsonl');
    const batchEntries = readJsonLinesIfPresent(batchProgressPath) as JsonObject[];
    const failed = {
      ...batchEntries[1]!,
      batch_request_sha256: null,
      idempotent_replay: null,
      summary_audit_id: null,
      result: 'failed',
      error: 'expected failure evidence',
    };
    writeFileSync(
      batchProgressPath,
      `${JSON.stringify(batchEntries[0])}\n${JSON.stringify(batchEntries[0])}\n${JSON.stringify(failed)}\n{}\n`,
    );
    writeFileSync(exchangeProgressPath, '{}\n');
    const invalidProofs = await runDatasetMaintenanceVerify({
      planPath: path.join(scenario.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'invalid-proofs'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now,
    });
    const codes = invalidProofs.issues.map((entry) => entry.code).join(',');
    assert.match(codes, /ALIAS_BATCH_PROGRESS_INVALID/u);
    assert.match(codes, /ALIAS_BATCH_SUCCESS_LOG_MISSING/u);
    assert.match(codes, /ALIAS_EXCHANGE_PROGRESS_INVALID/u);
    assert.match(codes, /ALIAS_EXCHANGE_SUCCESS_LOG_MISSING/u);

    const auditMismatch = await prepareAliasScenario(root, 'verify-audit-mismatch');
    await executeLegacyAliasFixtureForVerification(auditMismatch);
    writeLegacyAliasCommitReport(auditMismatch);
    const mismatchPath = path.join(auditMismatch.outDir, 'alias-exchange-progress.jsonl');
    const mismatchEntries = readJsonLinesIfPresent(mismatchPath) as JsonObject[];
    mismatchEntries[0]!.database_audit_id = '999999';
    writeFileSync(
      mismatchPath,
      `${mismatchEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const mismatchVerify = await runDatasetMaintenanceVerify({
      planPath: path.join(auditMismatch.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'audit-mismatch-verify'),
      env: auditMismatch.remote.env,
      fetchImpl: auditMismatch.remote.fetch,
      now,
    });
    assert.match(
      mismatchVerify.issues.map((entry) => entry.code).join(','),
      /ALIAS_EXCHANGE_PROGRESS_INVALID/u,
    );

    const duplicateProgressPath = path.join(auditMismatch.outDir, 'apply-progress.jsonl');
    const duplicateProgressEntries = readJsonLinesIfPresent(duplicateProgressPath);
    writeFileSync(
      duplicateProgressPath,
      `${duplicateProgressEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n${JSON.stringify(duplicateProgressEntries[0])}\n`,
    );
    const duplicateProgressVerify = await runDatasetMaintenanceVerify({
      planPath: path.join(auditMismatch.outDir, 'maintenance-plan.json'),
      outDir: path.join(root, 'duplicate-progress-verify'),
      env: auditMismatch.remote.env,
      fetchImpl: auditMismatch.remote.fetch,
      now,
    });
    assert.match(
      duplicateProgressVerify.issues.map((entry) => entry.code).join(','),
      /APPLY_PROGRESS_SUCCESS_DUPLICATE/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias planning blocks non-owner-draft support and sequential execution rejects alias actions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-blocked-'));
  const remote = new FakeMaintenanceRemote('alias-blocked');
  const fixture = seedAliasFixture(remote);
  const invalidTarget = remote.rows.get('unitgroups')!.find((row) => row.id === aliasId(3))!;
  invalidTarget.state_code = 100;
  remote.rows.get('flows')!.find((row) => row.state_code === 0)!.modified_at = null;
  const scopePath = path.join(root, 'scope.json');
  const outDir = path.join(root, 'maintenance');
  writeFileSync(scopePath, JSON.stringify(fixture.scope));
  const now = new Date('2026-07-11T08:00:00.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'merge-support-aliases',
      outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: {
        flowproperties: { safeParse: () => ({ success: true as const }) },
        flows: { safeParse: () => ({ success: true as const }) },
        processes: { safeParse: () => ({ success: true as const }) },
      },
    });
    assert.equal(plan.status, 'blocked');
    assert.match(
      plan.blockers.map((entry) => entry.code).join(','),
      /ALIAS_SUPPORT_NOT_OWNER_DRAFT/u,
    );
    assert.match(
      plan.blockers.map((entry) => entry.code).join(','),
      /ALIAS_EXPECTED_MODIFIED_AT_MISSING/u,
    );
    assert.equal(parseMaintenancePlan(plan).status, 'blocked');
    const context = await resolveMaintenanceRemoteContext({
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: plan.actions.find((action) => action.action === 'update_json_ordered')!,
          plan,
          planDir: outDir,
          context,
        }),
      /must execute through the whole-plan RPC/u,
    );
    assert.equal(remote.rpcOrder.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alias planning rejects foreign source, target, and changed rows before any write', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-alias-foreign-'));
  const remote = new FakeMaintenanceRemote('alias-foreign');
  const fixture = seedAliasFixture(remote);
  const foreignUser = '99999999-9999-4999-8999-999999999999';
  remote.rows.get('unitgroups')!.find((row) => row.id === aliasId(1))!.user_id = foreignUser;
  remote.rows.get('flowproperties')!.find((row) => row.id === aliasId(4))!.user_id = foreignUser;
  remote.rows.get('processes')!.find((row) => row.state_code === 0)!.user_id = foreignUser;
  const scopePath = path.join(root, 'scope.json');
  writeFileSync(scopePath, JSON.stringify(fixture.scope));
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'merge-support-aliases',
      outDir: path.join(root, 'maintenance'),
      env: remote.env,
      fetchImpl: remote.fetch,
      supportSchemas: PASSING_SUPPORT_SCHEMAS,
      aliasSchemas: {
        flowproperties: { safeParse: () => ({ success: true as const }) },
        flows: { safeParse: () => ({ success: true as const }) },
        processes: { safeParse: () => ({ success: true as const }) },
      },
    });
    const blockerCodes = plan.blockers.map((entry) => entry.code).join(',');
    assert.equal(plan.status, 'blocked');
    assert.match(blockerCodes, /ALIAS_SUPPORT_NOT_OWNER_DRAFT/u);
    assert.match(blockerCodes, /TARGET_OWNER_MISMATCH|SNAPSHOT_DRIFT/u);
    assert.equal(remote.rpcOrder.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('row-level plan blocks a delete with projected inbound references', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-blocked-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-blocked');
  seed(remote);
  const files = buildScopeFiles({ root, remote, includeSave: false });
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.summary.projected_reference_impacts, 1);
    assert.match(plan.blockers.map((entry) => entry.code).join(','), /PROJECTED_INBOUND/u);
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /Blocked maintenance plan/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance contracts and remote adapters reject unsafe inputs and invalid responses', async () => {
  const remote = new FakeMaintenanceRemote('row-maintenance-edges');
  seed(remote);
  assert.equal(normalizeMaintenancePageSize(), 1000);
  assert.equal(normalizeMaintenanceTimeout(), 10000);
  assert.throws(() => normalizeMaintenancePageSize(0), /page size/u);
  assert.throws(() => normalizeMaintenancePageSize(5001), /page size/u);
  assert.throws(() => normalizeMaintenanceTimeout(0), /timeout/u);
  assert.equal(safeActionFileName(' / '), sha256Text(' / ').slice(0, 16));
  assert.throws(
    () =>
      parseMaintenanceScope({
        schema_version: 1,
        task_id: 'bad',
        operation: 'delete',
        account: { user_id: remote.userId },
        actions: [
          {
            action_id: 'bad',
            action: 'delete',
            table: 'unitgroups',
            id: 'id',
            version: '01.00.000',
            expected_user_id: remote.userId,
            expected_state_code: 0,
            reason_code: 'bad',
            reason: 'bad',
            evidence: [],
          },
        ],
      }),
    /protected or unsupported/u,
  );
  const context = await resolveMaintenanceRemoteContext({
    env: remote.env,
    fetchImpl: remote.fetch,
    timeoutMs: 1000,
  });
  const exact = await fetchMaintenanceExactRows({
    context,
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
  });
  assert.equal(exact.rows.length, 1);
  const account = await fetchMaintenanceAccountRows({
    context,
    userId: remote.userId,
    pageSize: 1,
  });
  assert.equal(account.rows.length, 3);
  await assert.rejects(
    () =>
      fetchMaintenanceAccountRows({
        context: {
          ...context,
          fetch_impl: async () =>
            jsonResponse([
              {
                id: 'foreign-contact',
                version: '01.00.000',
                user_id: 'other-user',
                state_code: 0,
              },
            ]),
        },
        userId: remote.userId,
      }),
    /foreign account row/u,
  );
  await saveDraftMaintenanceRow({
    context,
    table: 'processes',
    id: '22222222-2222-4222-8222-222222222222',
    version: '01.00.000',
    payload: processPayload({
      id: '22222222-2222-4222-8222-222222222222',
      version: '01.00.000',
    }),
    modelId: null,
    ruleVerification: false,
    audit: { source: 'test' },
  });
  await deleteMaintenanceRow({
    context,
    table: 'sources',
    id: '33333333-3333-4333-8333-333333333333',
    version: '01.00.000',
    audit: { source: 'test' },
  });

  remote.invalidJson = true;
  await assert.rejects(
    () =>
      fetchMaintenanceExactRows({
        context,
        table: 'flows',
        id: '55555555-5555-4555-8555-555555555555',
        version: '01.00.000',
      }),
    /not valid JSON/u,
  );
  assert.equal(remoteInternals.selectForTable('processes').includes('model_id'), true);
  assert.equal(remoteInternals.selectForTable('flows').includes('model_id'), false);
  assert.equal(
    remoteInternals.selectForTable('flows', true).includes('modified_at,json,json_ordered'),
    true,
  );
  assert.equal(remoteInternals.normalizeRemoteRow('flows', null), null);
  assert.equal(remoteInternals.normalizeRemoteRow('flows', { id: '', version: '' }), null);
  assert.deepEqual(
    remoteInternals.normalizeRemoteRow('flows', {
      id: ' id ',
      version: ' 01.00.000 ',
      user_id: 2,
      state_code: '0',
      modified_at: '',
      json_ordered: [],
      model_id: ' ',
      rule_verification: 'no',
    }),
    {
      table: 'flows',
      id: 'id',
      version: '01.00.000',
      user_id: null,
      state_code: 0,
      modified_at: null,
      json_ordered: null,
      model_id: null,
      rule_verification: null,
    },
  );
  assert.equal(
    remoteInternals.normalizeRemoteRow('flows', {
      id: 'id',
      version: '01.00.000',
      state_code: 'bad',
    })?.state_code,
    null,
  );
  assert.deepEqual(
    remoteInternals.normalizeRemoteRow(
      'flows',
      {
        id: 'id',
        version: '01.00.000',
        json: { mirrored: true },
        json_ordered: { mirrored: true },
      },
      true,
    )?.json,
    { mirrored: true },
  );
  assert.equal(
    remoteInternals.normalizeRemoteRow('flows', { id: 'id', version: '01.00.000', json: [] }, true)
      ?.json,
    null,
  );
  assert.throws(() => remoteInternals.normalizeRemoteRows('flows', {}, 'test'), /not an array/u);
  assert.throws(() => remoteInternals.normalizeRemoteRows('flows', [{}], 'test'), /invalid row/u);
  const partialContext = {
    publishable_key: 'key',
    access_token: 'token',
    timeout_ms: 1000,
    fetch_impl: (async () => jsonResponse({}, 500)) as FetchLike,
  };
  await assert.rejects(
    () =>
      remoteInternals.fetchJson({
        context: partialContext,
        url: 'https://example.test/fail',
        label: 'fail',
      }),
    /HTTP 500/u,
  );
  assert.equal(
    await remoteInternals.fetchJson({
      context: {
        ...partialContext,
        fetch_impl: async () => ({
          ...jsonResponse(null),
          async text() {
            return '';
          },
        }),
      },
      url: 'https://example.test/empty',
      label: 'empty',
    }),
    null,
  );

  const fallbackRemote = new FakeMaintenanceRemote('row-maintenance-email-fallback');
  const fallbackContext = await resolveMaintenanceRemoteContext({
    env: fallbackRemote.env,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/auth/v1/user')) {
        return jsonResponse({ id: fallbackRemote.userId });
      }
      return fallbackRemote.fetch(input, init);
    },
  });
  assert.equal(fallbackContext.account.email, fallbackRemote.email);
  const invalidUserRemote = new FakeMaintenanceRemote('row-maintenance-invalid-user');
  await assert.rejects(
    () =>
      resolveMaintenanceRemoteContext({
        env: invalidUserRemote.env,
        fetchImpl: async (input, init) =>
          String(input).endsWith('/auth/v1/user')
            ? jsonResponse({ email: invalidUserRemote.email })
            : invalidUserRemote.fetch(input, init),
      }),
    /did not return id and email/u,
  );
  const badRpcContext = {
    ...context,
    fetch_impl: (async (input, init) =>
      String(input).includes('/rpc/')
        ? jsonResponse({ ok: false })
        : remote.fetch(input, init)) as FetchLike,
  };
  await assert.rejects(
    () =>
      deleteMaintenanceRow({
        context: badRpcContext,
        table: 'sources',
        id: 'missing',
        version: '01.00.000',
        audit: {},
      }),
    /unexpected response/u,
  );
});

test('account maintenance snapshot follows a 1000-row server cap for a requested page size of 5000', async () => {
  const visibleFlows: StoredRow[] = Array.from({ length: 2_203 }, (_, index) => {
    const id = `flow-${String(index).padStart(5, '0')}`;
    return {
      id,
      version: '00.00.001',
      user_id: 'user-1',
      state_code: 0,
      modified_at: '2026-07-13T00:00:00.000Z',
      json_ordered: flowPayload(id, '00.00.001'),
      model_id: null,
      rule_verification: null,
    };
  });
  const flowOffsets: number[] = [];
  const preferHeaders: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const table = url.pathname.split('/rest/v1/')[1] ?? '';
    const rows = table === 'flows' ? visibleFlows : [];
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const requestedLimit = Number(url.searchParams.get('limit') ?? rows.length);
    const page = rows.slice(offset, offset + Math.min(requestedLimit, 1_000));
    if (table === 'flows') flowOffsets.push(offset);
    preferHeaders.push(new Headers(init?.headers).get('prefer') ?? '');
    return jsonResponse(page, 200, {
      'content-range':
        page.length > 0
          ? `${offset}-${offset + page.length - 1}/${rows.length}`
          : `*/${rows.length}`,
    });
  };
  const snapshot = await fetchMaintenanceAccountRows({
    context: {
      rest_base_url: 'https://example.test/rest/v1',
      project_ref: 'example',
      publishable_key: 'publishable',
      access_token: 'access',
      account: { user_id: 'user-1', email: 'user@example.com', session_source: 'credentials' },
      fetch_impl: fetchImpl,
      timeout_ms: 1_000,
    },
    userId: 'user-1',
    pageSize: 5_000,
  });

  assert.equal(snapshot.rows.length, 2_203);
  assert.deepEqual(flowOffsets, [0, 1_000, 2_000]);
  assert.equal(
    preferHeaders.every((value) => value === 'count=exact'),
    true,
  );
  assert.equal(snapshot.completeness.complete, true);
  assert.equal(snapshot.completeness.requested_page_size, 5_000);
  assert.equal(snapshot.completeness.entity_counts.flows, 2_203);
  assert.equal(snapshot.completeness.entity_counts.lifecyclemodels, 0);
  assert.equal(snapshot.completeness.page_count, 9);
});

test('plan, apply, and verify fail closed when account pagination completeness is unproven', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-incomplete-pagination-'));
  try {
    const planningRemote = new FakeMaintenanceRemote('incomplete-plan');
    seed(planningRemote);
    const planningRoot = path.join(root, 'plan');
    mkdirSync(planningRoot, { recursive: true });
    const planningFiles = buildScopeFiles({
      root: planningRoot,
      remote: planningRemote,
    });
    await assert.rejects(
      () =>
        runDatasetMaintenancePlan({
          scopePath: planningFiles.scopePath,
          operation: 'repair-references',
          outDir: planningFiles.outDir,
          env: planningRemote.env,
          fetchImpl: stripMaintenanceContentRange(planningRemote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(existsSync(path.join(planningFiles.outDir, 'maintenance-plan.json')), false);

    const scenario = await prepareSeededScenario(root, 'apply-verify');
    const planPath = path.join(scenario.files.outDir, 'maintenance-plan.json');
    const rpcCount = scenario.remote.rpcOrder.length;
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath,
          commit: true,
          approvePlan: scenario.plan.plan_sha256,
          confirm: scenario.remote.email,
          env: scenario.remote.env,
          fetchImpl: stripMaintenanceContentRange(scenario.remote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(scenario.remote.rpcOrder.length, rpcCount);
    assert.equal(existsSync(path.join(scenario.files.outDir, 'approval-record.json')), false);

    const verifyOut = path.join(root, 'verify');
    await assert.rejects(
      () =>
        runDatasetMaintenanceVerify({
          planPath,
          outDir: verifyOut,
          env: scenario.remote.env,
          fetchImpl: stripMaintenanceContentRange(scenario.remote.fetch),
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'DATASET_MAINTENANCE_SNAPSHOT_INCOMPLETE');
        return true;
      },
    );
    assert.equal(existsSync(path.join(verifyOut, 'readback-verify-report.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance contract validates every frozen scope guard and immutable artifact edge', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-contract-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-contract');
  try {
    assert.equal(isJsonObject({}), true);
    assert.equal(isJsonObject(null), false);
    assert.equal(isJsonObject([]), false);
    assert.deepEqual(stableJsonValue({ z: [2, { b: 1, a: 0 }], a: null }), {
      a: null,
      z: [2, { a: 0, b: 1 }],
    });
    assert.equal(stableJsonText({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(
      snapshotRemoteRow({
        table: 'contacts',
        id: 'id',
        version: '01.00.000',
        user_id: null,
        state_code: null,
        modified_at: null,
        json_ordered: null,
        model_id: null,
        rule_verification: null,
      }).payload_sha256,
      null,
    );
    assert.equal(
      maintenanceRowKey({ table: 'flows', id: 'id', version: '01.00.000' }),
      'flows\u0000id\u000001.00.000',
    );

    const invalidScopes: unknown[] = [
      null,
      {},
      scopeValue(remote, [null]),
      scopeValue(remote, [scopeAction(remote, { action: 'publish' })]),
      scopeValue(remote, [scopeAction(remote, { expected_state_code: 100 })]),
      scopeValue(remote, [scopeAction(remote, { expected_user_id: 'other' })]),
      scopeValue(remote, [scopeAction(remote, { evidence: 'no' })]),
      scopeValue(remote, [scopeAction(remote, { action: 'save_draft' })]),
      scopeValue(remote, [scopeAction(remote, { desired_payload_path: 'unexpected.json' })]),
      scopeValue(remote, [
        scopeAction(remote, {
          action: 'update_json_ordered',
          table: 'flows',
          batch_id: 'unexpected-batch',
        }),
      ]),
      scopeValue(remote, [scopeAction(remote, { expected_before_sha256: 'bad' })]),
      scopeValue(remote, [scopeAction(remote, { id: ' ' })]),
      scopeValue(remote, [scopeAction(remote)], { operation: 'unsupported' }),
      scopeValue(remote, [scopeAction(remote)], { target_mode: 'owner_draft' }),
      scopeValue(remote, []),
      scopeValue(remote, [scopeAction(remote), scopeAction(remote)]),
      scopeValue(remote, [
        scopeAction(remote, { action_id: 'one' }),
        scopeAction(remote, { action_id: 'two' }),
      ]),
      scopeValue(remote, [
        scopeAction(remote, { action_id: 'a/b' }),
        scopeAction(remote, {
          action_id: 'a_b',
          id: '66666666-6666-4666-8666-666666666666',
        }),
      ]),
    ];
    for (const invalid of invalidScopes) {
      assert.throws(() => parseMaintenanceScope(invalid));
    }
    assert.throws(
      () => parseMaintenanceScope(scopeValue(remote), 'repair-references'),
      /does not match requested/u,
    );
    const optional = parseMaintenanceScope(
      scopeValue(
        remote,
        [
          scopeAction(remote, {
            action: 'save_draft',
            desired_payload_path: 'payload.json',
            expected_before_sha256: 'a'.repeat(64),
          }),
        ],
        {
          account: { user_id: remote.userId, email: ' OWNER@EXAMPLE.COM ' },
          source_import_run_id: ' run ',
          source_lineage: { manifest: 'redo.json' },
        },
      ),
      'delete',
    );
    assert.equal(optional.account.email, 'OWNER@EXAMPLE.COM');
    assert.equal(optional.source_import_run_id, 'run');
    assert.deepEqual(optional.source_lineage, { manifest: 'redo.json' });

    const jsonPath = path.join(root, 'immutable.json');
    const jsonlPath = path.join(root, 'immutable.jsonl');
    assert.equal(writeImmutableJson(jsonPath, { b: 1, a: 2 }), path.resolve(jsonPath));
    assert.equal(writeImmutableJson(jsonPath, { a: 2, b: 1 }), path.resolve(jsonPath));
    assert.throws(() => writeImmutableJson(jsonPath, { a: 3 }), /immutable/u);
    assert.equal(writeImmutableJsonLines(jsonlPath, []), path.resolve(jsonlPath));
    assert.equal(writeImmutableJsonLines(jsonlPath, []), path.resolve(jsonlPath));
    const appendedPath = path.join(root, 'append.jsonl');
    appendStableJsonLine(appendedPath, { b: 1, a: 2 });
    assert.deepEqual(readJsonLinesIfPresent(appendedPath), [{ a: 2, b: 1 }]);
    assert.deepEqual(readJsonLinesIfPresent(path.join(root, 'missing.jsonl')), []);
    writeFileSync(path.join(root, 'bad.json'), '{bad');
    assert.throws(() => readJsonFile(path.join(root, 'missing.json'), 'Missing'), /not found/u);
    assert.throws(() => readJsonFile(path.join(root, 'bad.json'), 'Bad'), /not valid JSON/u);
    writeFileSync(path.join(root, 'bad.jsonl'), '{}\n{bad\n');
    assert.throws(() => readJsonLinesIfPresent(path.join(root, 'bad.jsonl')), /Invalid/u);
    assert.throws(() => parseMaintenancePlan({}), /valid schema_version/u);
    assert.throws(
      () =>
        parseMaintenancePlan({
          schema_version: 1,
          actions: [],
          protected_rows: [],
          blockers: [],
          account: {},
          artifacts: {},
          plan_sha256: 'bad',
        }),
      /hash does not match/u,
    );
    assert.equal(
      resolveMaintenancePlanArtifactPath(root, 'payloads/action.json', 'Desired payload'),
      path.join(root, 'payloads/action.json'),
    );
    for (const unsafePath of [
      '',
      path.resolve(root, 'absolute.json'),
      '.',
      '..',
      '../escape.json',
    ]) {
      assert.throws(
        () => resolveMaintenancePlanArtifactPath(root, unsafePath, 'Desired payload'),
        /must (?:be a relative path|stay inside)/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance plan parser rejects tampered action, snapshot, summary, and blocker contracts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-contract-'));
  try {
    const scenario = await prepareSeededScenario(root, 'valid-plan');
    const basePlan = structuredClone(scenario.plan);
    const invalidPlan = (
      mutate: (plan: DatasetMaintenancePlan) => void,
      message: RegExp = /invalid|inconsistent|protected or unsupported|does not match|must|unsupported/iu,
    ): void => {
      const plan = structuredClone(basePlan);
      mutate(plan);
      plan.plan_sha256 = computePlanSha256(plan);
      assert.throws(() => parseMaintenancePlan(plan), message);
    };

    const withImportRun = structuredClone(basePlan);
    withImportRun.source_import_run_id = 'bafu-import-run';
    withImportRun.plan_sha256 = computePlanSha256(withImportRun);
    assert.equal(parseMaintenancePlan(withImportRun).source_import_run_id, 'bafu-import-run');

    const legacyPlan = structuredClone(basePlan);
    delete legacyPlan.snapshot_completeness;
    legacyPlan.plan_sha256 = computePlanSha256(legacyPlan);
    assert.equal(parseMaintenancePlan(legacyPlan).snapshot_completeness, undefined);
    invalidPlan((plan) => {
      plan.snapshot_completeness!.complete = false as true;
    });
    invalidPlan((plan) => {
      plan.snapshot_completeness!.entity_counts.flows += 1;
    });
    invalidPlan((plan) => {
      Object.assign(plan.snapshot_completeness!, { entity_counts: [] });
    });
    invalidPlan((plan) => {
      Object.assign(plan.snapshot_completeness!.entity_counts, { flows: 'not-a-count' });
    });
    invalidPlan((plan) => {
      Object.assign(plan, { snapshot_completeness: null });
    });
    invalidPlan((plan) => {
      plan.snapshot_completeness!.tables[1]!.table = plan.snapshot_completeness!.tables[0]!.table;
    });

    invalidPlan((plan) => Object.assign(plan.actions[0]!, { table: 'unitgroups' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { expected_user_id: 'other-user' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { expected_state_code: 100 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { action: 'publish' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { ordinal: -1 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { status: 'unknown' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { blockers: 'not-an-array' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!, { rollback: null }));

    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { state_code: 100 }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { user_id: 'other-user' }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.before!, { json_ordered: null }));
    invalidPlan((plan) => {
      plan.actions[0]!.before!.row_sha256 = '0'.repeat(64);
    });
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { strategy: 'unknown' }));
    invalidPlan((plan) =>
      Object.assign(plan.actions[0]!.rollback, { before_payload_sha256: '0'.repeat(64) }),
    );
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { before_payload: null }));
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { before_payload: {} }));
    invalidPlan((plan) =>
      Object.assign(plan.actions[0]!.rollback, {
        model_id: '44444444-4444-4444-8444-444444444444',
      }),
    );
    invalidPlan((plan) => Object.assign(plan.actions[0]!.rollback, { rule_verification: true }));
    invalidPlan((plan) => {
      const saveAction = plan.actions.find((action) => action.action === 'save_draft')!;
      saveAction.desired_payload = null;
    });
    invalidPlan((plan) => {
      const deleteAction = plan.actions.find((action) => action.action === 'delete')!;
      deleteAction.desired_payload = { path: 'unexpected.json', sha256: '0'.repeat(64) };
    });

    const summaryMutations: Array<(plan: DatasetMaintenancePlan) => void> = [
      (plan) => {
        plan.summary.actions += 1;
      },
      (plan) => {
        plan.summary.save_draft += 1;
      },
      (plan) => {
        plan.summary.delete += 1;
      },
      (plan) => {
        plan.summary.protected_rows += 1;
      },
      (plan) => {
        plan.summary.blockers += 1;
      },
      (plan) => {
        plan.summary.current_reference_impacts = -1;
      },
      (plan) => {
        plan.summary.current_reference_impacts = 0.5;
      },
      (plan) => {
        plan.summary.projected_reference_impacts = -1;
      },
      (plan) => {
        plan.summary.projected_reference_impacts = 0.5;
      },
    ];
    for (const mutate of summaryMutations) {
      invalidPlan(mutate, /status or blocker contract is inconsistent/u);
    }
    invalidPlan((plan) => {
      plan.status = 'blocked';
    }, /status or blocker contract is inconsistent/u);

    const blocker = {
      code: 'TEST_BLOCKER',
      message: 'test blocker',
      action_id: basePlan.actions[0]!.action_id,
      table: basePlan.actions[0]!.table,
      id: basePlan.actions[0]!.id,
      version: basePlan.actions[0]!.version,
    };
    const validBlockedPlan = structuredClone(basePlan);
    validBlockedPlan.status = 'blocked';
    validBlockedPlan.actions[0]!.status = 'blocked';
    validBlockedPlan.actions[0]!.blockers = [blocker];
    validBlockedPlan.blockers = [blocker];
    validBlockedPlan.summary.blockers = 1;
    validBlockedPlan.plan_sha256 = computePlanSha256(validBlockedPlan);
    assert.equal(parseMaintenancePlan(validBlockedPlan).status, 'blocked');

    const mismatchedBlockers = structuredClone(validBlockedPlan);
    mismatchedBlockers.blockers[0] = {
      ...mismatchedBlockers.blockers[0]!,
      message: 'different global blocker',
    };
    mismatchedBlockers.plan_sha256 = computePlanSha256(mismatchedBlockers);
    assert.throws(
      () => parseMaintenancePlan(mismatchedBlockers),
      /status or blocker contract is inconsistent/u,
    );

    const saveAction = basePlan.actions.find((action) => action.action === 'save_draft')!;
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(scenario.files.outDir, {
          ...saveAction,
          desired_payload: {
            path: '../escaped-payload.json',
            sha256: saveAction.desired_payload!.sha256,
          },
        }),
      /stay inside/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance apply guards reject artifact, preflight, approval, and just-in-time drift', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-apply-edges-'));
  const remote = new FakeMaintenanceRemote('row-maintenance-apply-edges');
  seed(remote);
  const files = buildScopeFiles({ root, remote });
  const now = new Date('2026-07-11T00:00:00.000Z');
  try {
    const plan = await runDatasetMaintenancePlan({
      scopePath: files.scopePath,
      operation: 'repair-references',
      outDir: files.outDir,
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    const planDir = files.outDir;
    const context = await resolveMaintenanceRemoteContext({
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
    const current = await fetchMaintenanceAccountRows({ context, userId: remote.userId });
    const emptyProgress = applyInternals.parseProgress(plan, path.join(root, 'no-progress.jsonl'));
    const saveAction = plan.actions.find((action) => action.action === 'save_draft')!;
    const deleteAction = plan.actions.find((action) => action.action === 'delete')!;

    assert.equal(applyInternals.clock({ now } as never), now.toISOString());
    assert.equal(typeof applyInternals.clock({} as never), 'string');
    assert.equal(applyInternals.errorMessage(new Error('error')), 'error');
    assert.equal(applyInternals.errorMessage('string-error'), 'string-error');
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(planDir, {
          ...saveAction,
          desired_payload: null,
        }),
      /lacks desired payload/u,
    );
    const wrongPayloadPath = path.join(planDir, 'payloads', 'wrong.json');
    writeFileSync(wrongPayloadPath, '{}');
    assert.throws(
      () =>
        applyInternals.loadDesiredPayload(planDir, {
          ...saveAction,
          desired_payload: { path: 'payloads/wrong.json', sha256: '0'.repeat(64) },
        }),
      /hash mismatch/u,
    );
    const invalidProgressPath = path.join(root, 'invalid-progress.jsonl');
    writeFileSync(invalidProgressPath, '{}\n');
    assert.throws(
      () => applyInternals.parseProgress(plan, invalidProgressPath),
      /invalid or foreign/u,
    );

    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: [
            ...current.rows,
            {
              ...current.rows[0]!,
              id: '77777777-7777-4777-8777-777777777777',
            },
          ],
          progress: emptyProgress,
        }),
      /Unexpected current-account row/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'flows'),
          progress: emptyProgress,
        }),
      /Protected row drifted/u,
    );
    const noBeforePlan = structuredClone(plan);
    noBeforePlan.actions[0]!.before = null;
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: noBeforePlan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'sources'),
          progress: emptyProgress,
        }),
      /lacks before snapshot/u,
    );
    const deleteSuccessProgress = applyInternals.parseProgress(
      plan,
      path.join(root, 'delete-success.jsonl'),
    );
    deleteSuccessProgress.successes.set(
      deleteAction.action_id,
      successProgressEntry(plan, deleteAction),
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows,
          progress: deleteSuccessProgress,
        }),
      /visible again/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.filter((row) => row.table !== 'sources'),
          progress: emptyProgress,
        }),
      /missing, non-draft, or not owned/u,
    );
    const saveSuccessProgress = applyInternals.parseProgress(
      plan,
      path.join(root, 'save-success.jsonl'),
    );
    saveSuccessProgress.successes.set(saveAction.action_id, successProgressEntry(plan, saveAction));
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows,
          progress: saveSuccessProgress,
        }),
      /Previously saved row payload drifted/u,
    );
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan,
          planDir,
          currentRows: current.rows.map((row) =>
            row.table === 'sources' ? { ...row, modified_at: 'changed' } : row,
          ),
          progress: emptyProgress,
        }),
      /Pending action row drifted/u,
    );
    const referenceDriftPlan = structuredClone(plan);
    referenceDriftPlan.projected_reference_sha256 = '0'.repeat(64);
    assert.throws(
      () =>
        applyInternals.assertApplyPreconditions({
          plan: referenceDriftPlan,
          planDir,
          currentRows: current.rows,
          progress: emptyProgress,
        }),
      /reference closure drifted/u,
    );
    const approvalPath = path.join(root, 'bad-approval.json');
    writeFileSync(approvalPath, '{}');
    assert.throws(
      () => applyInternals.validateApprovalRecord({ path: approvalPath, plan, context }),
      /does not match/u,
    );
    const validApproval = {
      plan_sha256: plan.plan_sha256,
      target_mode: plan.target_mode,
      account: context.account,
      snapshot_completeness: plan.snapshot_completeness,
    };
    writeFileSync(approvalPath, JSON.stringify(validApproval));
    applyInternals.validateApprovalRecord({ path: approvalPath, plan, context });
    writeFileSync(
      approvalPath,
      JSON.stringify({
        plan_sha256: plan.plan_sha256,
        target_mode: plan.target_mode,
        account: context.account,
      }),
    );
    assert.throws(
      () => applyInternals.validateApprovalRecord({ path: approvalPath, plan, context }),
      /does not match/u,
    );
    applyInternals.validateApprovalRecord({
      path: path.join(root, 'missing-approval.json'),
      plan,
      context,
    });

    const processRow = remote.rows.get('processes')!.find((row) => row.id === saveAction.id)!;
    processRow.modified_at = '2026-07-11T00:00:01.000Z';
    await assert.rejects(
      () => applyInternals.executeAction({ action: saveAction, plan, planDir, context }),
      /immediately before write/u,
    );
    assert.equal(remote.rpcOrder.length, 0);
    processRow.modified_at = saveAction.before!.modified_at;

    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: false,
          approvePlan: plan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /requires commit/u,
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: 'wrong',
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /exactly match/u,
    );
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(planDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: plan.plan_sha256,
          confirm: 'wrong@example.com',
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /confirm must exactly match/u,
    );

    const redoPlan = structuredClone(plan);
    redoPlan.operation = 'redo-import';
    redoPlan.source_import_run_id = null;
    redoPlan.source_lineage = null;
    redoPlan.plan_sha256 = computePlanSha256(redoPlan);
    const redoPath = path.join(root, 'redo-plan.json');
    writeImmutableJson(redoPath, redoPlan);
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: redoPath,
          commit: true,
          approvePlan: redoPlan.plan_sha256,
          confirm: remote.email,
          env: remote.env,
          fetchImpl: remote.fetch,
        }),
      /requires frozen redo/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance planning records target visibility, ownership, draft, payload, and identity blockers', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-edges-'));
  const now = new Date('2026-07-11T00:00:00.000Z');
  async function planScenario(
    label: string,
    remote: FakeMaintenanceRemote,
    scope: Record<string, unknown>,
    payload?: unknown,
  ): Promise<DatasetMaintenancePlan> {
    const scenario = path.join(root, label);
    mkdirSync(scenario, { recursive: true });
    const scopePath = path.join(scenario, 'scope.json');
    const desiredPath = path.join(scenario, 'desired.json');
    writeFileSync(scopePath, JSON.stringify(scope));
    if (payload !== undefined) writeFileSync(desiredPath, JSON.stringify(payload));
    return runDatasetMaintenancePlan({
      scopePath,
      operation: scope.operation as 'delete' | 'repair-references',
      outDir: path.join(scenario, 'out'),
      env: remote.env,
      fetchImpl: remote.fetch,
      now,
    });
  }
  try {
    const accountRemote = new FakeMaintenanceRemote('plan-account-mismatch');
    await assert.rejects(
      () =>
        planScenario(
          'account',
          accountRemote,
          scopeValue(accountRemote, [scopeAction(accountRemote, { expected_user_id: 'other' })], {
            account: { user_id: 'other' },
          }),
        ),
      /authenticated user does not match/u,
    );
    const emailRemote = new FakeMaintenanceRemote('plan-email-mismatch');
    await assert.rejects(
      () =>
        planScenario(
          'email',
          emailRemote,
          scopeValue(emailRemote, [scopeAction(emailRemote)], {
            account: { user_id: emailRemote.userId, email: 'wrong@example.com' },
          }),
        ),
      /authenticated email does not match/u,
    );

    const missingRemote = new FakeMaintenanceRemote('plan-missing');
    const missing = await planScenario('missing', missingRemote, scopeValue(missingRemote));
    assert.match(missing.blockers.map((entry) => entry.code).join(','), /TARGET_NOT_VISIBLE/u);
    assert.equal(missing.actions[0]?.before, null);

    const duplicateRemote = new FakeMaintenanceRemote('plan-duplicate');
    duplicateRemote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
    );
    duplicateRemote.duplicateExactLookup = true;
    const duplicate = await planScenario('duplicate', duplicateRemote, scopeValue(duplicateRemote));
    assert.match(duplicate.blockers.map((entry) => entry.code).join(','), /TARGET_NOT_UNIQUE/u);

    const protectedRemote = new FakeMaintenanceRemote('plan-protected');
    protectedRemote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
      { user_id: 'other', state_code: 100, json_ordered: null },
    );
    const protectedPlan = await planScenario(
      'protected',
      protectedRemote,
      scopeValue(protectedRemote, [
        scopeAction(protectedRemote, { expected_before_sha256: '0'.repeat(64) }),
      ]),
    );
    const protectedCodes = protectedPlan.blockers.map((entry) => entry.code).join(',');
    assert.match(protectedCodes, /TARGET_OWNER_MISMATCH/u);
    assert.match(protectedCodes, /TARGET_NOT_DRAFT/u);
    assert.match(protectedCodes, /TARGET_PAYLOAD_MISSING/u);
    assert.match(protectedCodes, /EXPECTED_BEFORE_HASH_MISMATCH/u);
    assert.match(protectedCodes, /SNAPSHOT_DRIFT/u);

    const desiredRemote = new FakeMaintenanceRemote('plan-desired');
    desiredRemote.add(
      'processes',
      '22222222-2222-4222-8222-222222222222',
      processPayload({ id: '22222222-2222-4222-8222-222222222222', version: '01.00.000' }),
    );
    const desiredAction = scopeAction(desiredRemote, {
      action_id: 'save',
      action: 'save_draft',
      table: 'processes',
      id: '22222222-2222-4222-8222-222222222222',
      desired_payload_path: 'desired.json',
    });
    await assert.rejects(
      () =>
        planScenario(
          'desired-invalid',
          desiredRemote,
          scopeValue(desiredRemote, [desiredAction]),
          [],
        ),
      /must be a JSON object/u,
    );
    const wrongIdentity = await planScenario(
      'desired-identity',
      desiredRemote,
      scopeValue(desiredRemote, [desiredAction]),
      processPayload({ id: 'wrong-id', version: '01.00.000' }),
    );
    assert.match(
      wrongIdentity.blockers.map((entry) => entry.code).join(','),
      /DESIRED_PAYLOAD_IDENTITY_MISMATCH/u,
    );
    assert.equal(wrongIdentity.protected_rows[0]?.reason, 'blocked_action_row');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance internals preserve canonical hashes and detect deleted-target references', () => {
  const row: DatasetMaintenanceRemoteRow = {
    table: 'processes',
    id: 'proc',
    version: '01.00.000',
    user_id: 'user',
    state_code: 0,
    modified_at: null,
    json_ordered: processPayload({
      id: 'proc',
      version: '01.00.000',
      sourceId: 'source',
    }),
    model_id: null,
    rule_verification: null,
  };
  const action = {
    action_id: 'delete',
    action: 'delete' as const,
    table: 'sources' as const,
    id: 'source',
    version: '01.00.000',
    expected_user_id: 'user',
    expected_state_code: 0 as const,
    reason_code: 'test',
    reason: 'test',
    evidence: [],
    ordinal: 0,
    status: 'ready' as const,
    before: null,
    desired_payload: null,
    blockers: [],
    rollback: {
      strategy: 'restore_deleted_before_snapshot' as const,
      before_payload_sha256: null,
      before_payload: null,
      model_id: null,
      rule_verification: null,
    },
  };
  assert.equal(snapshotRemoteRow(row).row_sha256.length, 64);
  assert.equal(
    planInternals.referenceImpacts({ rows: [row], deletes: [action], phase: 'current' }).length,
    1,
  );
  assert.equal(
    verifyInternals.deletedTargetReferences({ rows: [row], deletes: [action] }).length,
    1,
  );
  assert.equal(typeof applyInternals.parseProgress, 'function');
});

test('maintenance planning and remote helpers cover sparse references and runtime fallbacks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-plan-fallbacks-'));
  const remote = new FakeMaintenanceRemote('plan-runtime-fallbacks');
  try {
    assert.deepEqual(planInternals.desiredPayloadIdentity({}), { id: null, version: null });

    const unsupportedReferenceRow: DatasetMaintenanceRemoteRow = {
      table: 'processes',
      id: 'unsupported-reference',
      version: '01.00.000',
      user_id: remote.userId,
      state_code: 0,
      modified_at: null,
      json_ordered: {
        processDataSet: {
          customReference: { '@refObjectId': 'source-without-a-table-hint' },
        },
      },
      model_id: null,
      rule_verification: null,
    };
    const deleteAction = scopeAction(remote);
    assert.deepEqual(
      planInternals.referenceImpacts({
        rows: [unsupportedReferenceRow],
        deletes: [deleteAction],
        phase: 'current',
      }),
      [],
    );
    assert.deepEqual(
      verifyInternals.deletedTargetReferences({
        rows: [unsupportedReferenceRow],
        deletes: [
          {
            ...deleteAction,
            ordinal: 0,
            status: 'ready',
            before: null,
            desired_payload: null,
            blockers: [],
            rollback: {
              strategy: 'restore_deleted_before_snapshot',
              before_payload_sha256: null,
              before_payload: null,
              model_id: null,
              rule_verification: null,
            },
          } as DatasetMaintenancePlanAction,
        ],
      }),
      [],
    );

    const referencedRows = ['process-b', 'process-a'].map((id): DatasetMaintenanceRemoteRow => ({
      table: 'processes',
      id,
      version: '01.00.000',
      user_id: remote.userId,
      state_code: 0,
      modified_at: null,
      json_ordered: processPayload({
        id,
        version: '01.00.000',
        sourceId: '33333333-3333-4333-8333-333333333333',
      }),
      model_id: null,
      rule_verification: null,
    }));
    const sortedImpacts = planInternals.referenceImpacts({
      rows: referencedRows,
      deletes: [deleteAction],
      phase: 'current',
    });
    assert.deepEqual(
      sortedImpacts.map((impact) => impact.source_id),
      ['process-a', 'process-b'],
    );

    remote.add(
      'sources',
      '33333333-3333-4333-8333-333333333333',
      sourcePayload('33333333-3333-4333-8333-333333333333'),
    );
    const scopePath = path.join(root, 'scope.json');
    writeFileSync(scopePath, JSON.stringify(scopeValue(remote)));
    const plan = await runDatasetMaintenancePlan({
      scopePath,
      operation: 'delete',
      outDir: path.join(root, 'out'),
      env: remote.env,
      fetchImpl: remote.fetch,
    });
    assert.match(plan.generated_at_utc, /^\d{4}-\d{2}-\d{2}T/u);

    const nonObjectUserRemote = new FakeMaintenanceRemote('non-object-current-user');
    await assert.rejects(
      () =>
        resolveMaintenanceRemoteContext({
          env: nonObjectUserRemote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse([])
              : nonObjectUserRemote.fetch(input, init),
        }),
      /did not return id and email/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance apply defensively records resume, readback, actor, redo, and pending edges', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-apply-defensive-'));
  try {
    const resume = await prepareSeededScenario(root, 'resume-delete');
    const saveAction = resume.plan.actions.find((action) => action.action === 'save_draft')!;
    const deleteAction = resume.plan.actions.find((action) => action.action === 'delete')!;
    const current = await fetchMaintenanceAccountRows({
      context: resume.context,
      userId: resume.remote.userId,
    });
    const resumedProgress = applyInternals.parseProgress(
      resume.plan,
      path.join(root, 'missing-progress.jsonl'),
    );
    resumedProgress.successes.set(
      deleteAction.action_id,
      successProgressEntry(resume.plan, deleteAction),
    );
    applyInternals.assertApplyPreconditions({
      plan: resume.plan,
      planDir: resume.files.outDir,
      currentRows: current.rows.filter((row) => row.table !== 'sources'),
      progress: resumedProgress,
    });

    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: { ...saveAction, before: null },
          plan: resume.plan,
          planDir: resume.files.outDir,
          context: resume.context,
        }),
      /lacks a before snapshot/u,
    );
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: {
            ...saveAction,
            id: 'missing-row',
          },
          plan: resume.plan,
          planDir: resume.files.outDir,
          context: resume.context,
        }),
      /immediately before write/u,
    );

    const fallback = await prepareSeededScenario(root, 'optional-before-metadata');
    const fallbackAction = fallback.plan.actions.find((action) => action.action === 'save_draft')!;
    let beforeReads = 0;
    const actionWithVanishingOptionalMetadata = { ...fallbackAction };
    Object.defineProperty(actionWithVanishingOptionalMetadata, 'before', {
      enumerable: true,
      get() {
        beforeReads += 1;
        return beforeReads <= 2 ? fallbackAction.before : null;
      },
    });
    const fallbackResult = await applyInternals.executeAction({
      action: actionWithVanishingOptionalMetadata,
      plan: fallback.plan,
      planDir: fallback.files.outDir,
      context: fallback.context,
    });
    assert.equal(fallbackResult.afterSha256?.length, 64);
    assert.equal(beforeReads, 4);

    const missingReadback = await prepareSeededScenario(root, 'missing-save-readback');
    const missingReadbackAction = missingReadback.plan.actions.find(
      (action) => action.action === 'save_draft',
    )!;
    const missingReadbackContext = {
      ...missingReadback.context,
      fetch_impl: (async (input, init) => {
        const response = await missingReadback.remote.fetch(input, init);
        if (String(input).includes('/rpc/cmd_dataset_save_draft')) {
          missingReadback.remote.rows.set('processes', []);
        }
        return response;
      }) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: missingReadbackAction,
          plan: missingReadback.plan,
          planDir: missingReadback.files.outDir,
          context: missingReadbackContext,
        }),
      /save_draft readback failed/u,
    );

    const mismatchReadback = await prepareSeededScenario(root, 'mismatch-save-readback');
    const mismatchAction = mismatchReadback.plan.actions.find(
      (action) => action.action === 'save_draft',
    )!;
    const mismatchContext = {
      ...mismatchReadback.context,
      fetch_impl: (async (input, init) => {
        const response = await mismatchReadback.remote.fetch(input, init);
        if (String(input).includes('/rpc/cmd_dataset_save_draft')) {
          mismatchReadback.remote.rows.get('processes')![0]!.state_code = 100;
        }
        return response;
      }) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: mismatchAction,
          plan: mismatchReadback.plan,
          planDir: mismatchReadback.files.outDir,
          context: mismatchContext,
        }),
      /save_draft readback mismatch/u,
    );

    const deleteReadback = await prepareSeededScenario(root, 'delete-readback');
    const deleteReadbackAction = deleteReadback.plan.actions.find(
      (action) => action.action === 'delete',
    )!;
    const deleteReadbackContext = {
      ...deleteReadback.context,
      fetch_impl: (async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_delete')
          ? jsonResponse({ ok: true })
          : deleteReadback.remote.fetch(input, init)) as FetchLike,
    };
    await assert.rejects(
      () =>
        applyInternals.executeAction({
          action: deleteReadbackAction,
          plan: deleteReadback.plan,
          planDir: deleteReadback.files.outDir,
          context: deleteReadbackContext,
        }),
      /delete readback failed/u,
    );

    const actorMismatch = await prepareSeededScenario(root, 'actor-mismatch');
    await assert.rejects(
      () =>
        runDatasetMaintenanceApply({
          planPath: path.join(actorMismatch.files.outDir, 'maintenance-plan.json'),
          commit: true,
          approvePlan: actorMismatch.plan.plan_sha256,
          confirm: actorMismatch.remote.email,
          env: actorMismatch.remote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse({ id: actorMismatch.remote.userId, email: 'other@example.com' })
              : actorMismatch.remote.fetch(input, init),
        }),
      /does not match the maintenance plan/u,
    );

    const pending = await prepareSeededScenario(root, 'pending-after-failure');
    const pendingReport = await runDatasetMaintenanceApply({
      planPath: path.join(pending.files.outDir, 'maintenance-plan.json'),
      commit: true,
      approvePlan: pending.plan.plan_sha256,
      confirm: pending.remote.email,
      env: pending.remote.env,
      fetchImpl: async (input, init) =>
        String(input).includes('/rpc/cmd_dataset_save_draft')
          ? jsonResponse({ message: 'save failed' }, 500)
          : pending.remote.fetch(input, init),
    });
    assert.deepEqual(
      pendingReport.actions.map((action) => action.status),
      ['pending', 'failed'],
    );

    const redoRoot = path.join(root, 'redo-delete');
    mkdirSync(redoRoot, { recursive: true });
    const redoRemote = new FakeMaintenanceRemote('redo-delete');
    for (const id of [
      '33333333-3333-4333-8333-333333333333',
      '66666666-6666-4666-8666-666666666666',
    ]) {
      redoRemote.add('sources', id, sourcePayload(id));
    }
    const redoScopePath = path.join(redoRoot, 'scope.json');
    writeFileSync(
      redoScopePath,
      JSON.stringify(
        scopeValue(redoRemote, [
          scopeAction(redoRemote),
          scopeAction(redoRemote, {
            action_id: 'delete-source-2',
            id: '66666666-6666-4666-8666-666666666666',
          }),
        ]),
      ),
    );
    const deletePlan = await runDatasetMaintenancePlan({
      scopePath: redoScopePath,
      operation: 'delete',
      outDir: path.join(redoRoot, 'planned'),
      env: redoRemote.env,
      fetchImpl: redoRemote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    const redoPlan = structuredClone(deletePlan);
    redoPlan.operation = 'redo-import';
    redoPlan.source_import_run_id = null;
    redoPlan.source_lineage = { manifest: 'bafu-redo-source-manifest.json' };
    redoPlan.plan_sha256 = computePlanSha256(redoPlan);
    const redoPlanPath = path.join(redoRoot, 'apply', 'maintenance-plan.json');
    writeImmutableJson(redoPlanPath, redoPlan);
    const redoReport = await runDatasetMaintenanceApply({
      planPath: redoPlanPath,
      commit: true,
      approvePlan: redoPlan.plan_sha256,
      confirm: redoRemote.email,
      env: redoRemote.env,
      fetchImpl: redoRemote.fetch,
    });
    assert.equal(redoReport.status, 'completed');
    assert.match(
      readFileSync(path.join(path.dirname(redoPlanPath), 'approval-record.json'), 'utf8'),
      /"redo_rows_ready":true/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance verify reports every incomplete readback proof without mutating rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tg-maintenance-verify-defensive-'));
  try {
    const scenario = await prepareSeededScenario(root, 'pre-apply');
    const planPath = path.join(scenario.files.outDir, 'maintenance-plan.json');
    const report = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-before-apply'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
    });
    const codes = report.issues.map((entry) => entry.code).join(',');
    assert.match(codes, /DELETE_TARGET_STILL_VISIBLE/u);
    assert.match(codes, /SAVE_DRAFT_READBACK_MISMATCH/u);
    assert.match(codes, /PROJECTED_REFERENCE_CLOSURE_MISMATCH/u);
    assert.match(codes, /DELETED_TARGET_REFERENCED/u);
    assert.match(codes, /ACTION_SUCCESS_LOG_MISSING/u);
    assert.match(codes, /COMMIT_REPORT_MISSING/u);

    const invalidApprovalCompleteness = structuredClone(scenario.plan.snapshot_completeness!);
    invalidApprovalCompleteness.tables[1]!.table = invalidApprovalCompleteness.tables[0]!.table;
    writeFileSync(
      path.join(scenario.files.outDir, 'approval-record.json'),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: scenario.plan.plan_sha256,
        task_id: scenario.plan.task_id,
        operation: scenario.plan.operation,
        operation_id: scenario.plan.operation_id,
        target_mode: scenario.plan.target_mode,
        account: scenario.plan.account,
        confirmed_email: scenario.plan.account.email,
        row_counts: scenario.plan.summary,
        snapshot_completeness: invalidApprovalCompleteness,
      }),
    );
    const malformedRollbackEntry = {
      ...successProgressEntry(scenario.plan, scenario.plan.actions[0]!),
      rollback: null,
    };
    writeFileSync(
      path.join(scenario.files.outDir, 'apply-progress.jsonl'),
      [
        'null',
        '{"action_id":"foreign-action"}',
        '{"action_id":"delete-source"}',
        JSON.stringify(malformedRollbackEntry),
        '',
      ].join('\n'),
    );
    writeFileSync(path.join(scenario.files.outDir, 'commit-report.json'), '{}');
    const invalidProofReport = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-invalid-proof-chain'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    const invalidProofCodes = invalidProofReport.issues.map((entry) => entry.code).join(',');
    assert.match(invalidProofCodes, /APPROVAL_RECORD_INVALID/u);
    assert.match(invalidProofCodes, /APPLY_PROGRESS_ENTRY_INVALID/u);
    assert.match(invalidProofCodes, /COMMIT_REPORT_INCOMPLETE/u);

    scenario.remote.rows.set('flows', []);
    scenario.remote.rows.set('processes', []);
    const protectedReport = await runDatasetMaintenanceVerify({
      planPath,
      outDir: path.join(root, 'verify-protected-change'),
      env: scenario.remote.env,
      fetchImpl: scenario.remote.fetch,
      now: new Date('2026-07-11T00:00:00.000Z'),
    });
    assert.match(
      protectedReport.issues.map((entry) => entry.code).join(','),
      /PROTECTED_ROW_CHANGED/u,
    );

    await assert.rejects(
      () =>
        runDatasetMaintenanceVerify({
          planPath,
          env: scenario.remote.env,
          fetchImpl: async (input, init) =>
            String(input).endsWith('/auth/v1/user')
              ? jsonResponse({ id: scenario.remote.userId, email: 'other@example.com' })
              : scenario.remote.fetch(input, init),
        }),
      /does not match the maintenance plan/u,
    );

    assert.deepEqual(verifyInternals.issue('CODE', 'message'), {
      code: 'CODE',
      message: 'message',
    });
    assert.deepEqual(verifyInternals.issue('CODE', 'message', undefined, { detail: true }), {
      code: 'CODE',
      message: 'message',
      details: { detail: true },
    });
    const saveAction = scenario.plan.actions.find((action) => action.action === 'save_draft')!;
    assert.equal(
      verifyInternals.desiredPayload(scenario.files.outDir, {
        ...saveAction,
        desired_payload: null,
      }),
      null,
    );
    const invalidPayloadPath = path.join(scenario.files.outDir, 'payloads', 'invalid.json');
    writeFileSync(invalidPayloadPath, '[]');
    assert.equal(
      verifyInternals.desiredPayload(scenario.files.outDir, {
        ...saveAction,
        desired_payload: {
          path: 'payloads/invalid.json',
          sha256: '0'.repeat(64),
        },
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
