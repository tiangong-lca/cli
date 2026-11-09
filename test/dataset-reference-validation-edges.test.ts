import assert from 'node:assert/strict';

import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __testInternals as remoteVerifyInternals,
  runDatasetRemoteVerify,
} from '../src/lib/dataset-remote-verify.js';

import { __testInternals as processRequiredInternals } from '../src/lib/process-required-fields.js';
import { __testInternals as supabaseClientInternals } from '../src/lib/supabase-client.js';

import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

test('prepush coverage covers remote verify root readback and helper edges', async () => {
  assert.deepEqual(
    remoteVerifyInternals.sha256Json([{ b: 2, a: 1 }]),
    remoteVerifyInternals.sha256Json([{ a: 1, b: 2 }]),
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ id: 'row-1', version: 'v1', json: { a: 1 } })
      ?.payload?.a,
    1,
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ id: 'row-empty', version: 'v1' })?.payload,
    null,
  );
  assert.equal(
    remoteVerifyInternals.normalizePayloadRow({ version: 'v1', json_ordered: {} })?.id,
    '',
  );
  assert.equal(remoteVerifyInternals.normalizePayloadRow(null), null);
  assert.deepEqual(remoteVerifyInternals.normalizeRows([{ id: 1 }, { id: 'ok' }]), [
    { id: 'ok', version: null },
  ]);

  const report = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        id: 'proc-1',
        version: '01.00.000',
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-edges'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    lookupDatasetImpl: async () => ({
      exact: { id: 'proc-1', version: '01.00.000' },
      latest: { id: 'proc-1', version: '01.00.000' },
      exact_source_url: 'https://example.test/processes',
      latest_source_url: 'https://example.test/processes',
    }),
    lookupRootPayloadImpl: async () => {
      throw new Error('lookup failed');
    },
  });
  assert.ok(report.blockers.some((blocker) => blocker.code === 'lookup_failed'));

  const noRuntimeReadback = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        id: 'proc-1',
        version: '01.00.000',
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-no-runtime'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    lookupDatasetImpl: async () => ({
      exact: { id: 'proc-1', version: '01.00.000' },
      latest: { id: 'proc-1', version: '01.00.000' },
      exact_source_url: null,
      latest_source_url: null,
    }),
  });
  assert.ok(noRuntimeReadback.blockers.some((blocker) => blocker.code === 'lookup_failed'));

  const missingOwnerStateChecks = remoteVerifyInternals.rootReadbackChecks({
    reference: {
      role: 'root',
      table: 'processes',
      type: 'process',
      id: 'proc-1',
      version: '01.00.000',
      path: '$',
      row_index: 0,
      short_description: null,
    },
    localPayload: {},
    remote: {
      id: 'proc-1',
      version: '01.00.000',
      user_id: null,
      state_code: null,
      modified_at: null,
      payload: {},
      source_url: null,
    },
    compareRootPayload: false,
    targetUserId: 'user-1',
    stateCode: 0,
  });
  assert.ok(missingOwnerStateChecks.some((check) => /<missing>/u.test(check.message)));

  let sawDefaultRootPayloadLookup = false;
  const defaultLookupReport = await runDatasetRemoteVerify({
    inputPath: 'rows.jsonl',
    rawInput: [
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-1' },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    ],
    outDir: path.join(os.tmpdir(), 'tg-cli-remote-verify-default-root'),
    rootPolicy: 'existing',
    compareRootPayload: true,
    targetUserId: 'user-1',
    stateCode: 0,
    env: buildSupabaseTestEnv(),
    fetchImpl: async (input) => {
      const url = String(input);
      if (isSupabaseAuthTokenUrl(url)) {
        return makeSupabaseAuthResponse({ accessToken: 'remote-token' });
      }
      if (url.includes('/rest/v1/processes?')) {
        sawDefaultRootPayloadLookup = true;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify([
              {
                id: 'proc-1',
                version: '01.00.000',
                user_id: 'user-1',
                state_code: 0,
                json_ordered: {
                  processDataSet: {
                    processInformation: {
                      dataSetInformation: { 'common:UUID': 'proc-1' },
                    },
                    administrativeInformation: {
                      publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
                    },
                  },
                },
              },
            ]),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify([]),
      };
    },
  });
  assert.equal(sawDefaultRootPayloadLookup, true);
  assert.equal(defaultLookupReport.status, 'passed_remote_verification');

  const payloadRuntime = {
    apiBaseUrl: 'https://example.com/functions/v1',
    publishableKey: 'pub',
    getAccessToken: async () => 'token',
  };
  const missingPayload = await remoteVerifyInternals.lookupRemoteDatasetPayload({
    runtime: payloadRuntime,
    timeoutMs: 1000,
    request: {
      table: 'processes',
      id: 'missing',
      version: '01.00.000',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify([]),
    }),
  });
  assert.equal(missingPayload, null);
  const nonArrayPayload = await remoteVerifyInternals.lookupRemoteDatasetPayload({
    runtime: payloadRuntime,
    timeoutMs: 1000,
    request: {
      table: 'processes',
      id: 'object-row',
      version: '01.00.000',
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ id: 'object-row', version: '01.00.000' }),
    }),
  });
  assert.equal(nonArrayPayload, null);
});

test('prepush coverage covers process required field and shared client helpers', async () => {
  const deferred = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      modellingAndValidation: {
        complianceDeclarations: {
          compliance: {
            'tiangongfoundry:unresolvedTrace': {
              action_item_code: 'annual_supply_or_production_volume_missing',
              blocked_path:
                'processDataSet.modellingAndValidation.complianceDeclarations.compliance.dataSources.annualSupplyOrProductionVolume',
              status: 'needs_followup',
            },
          },
        },
      },
    },
  });
  assert.equal(
    deferred.some((issue) => issue.code === 'annual_supply_or_production_volume_missing'),
    false,
  );
  // A legacy deferred trace is not annual-volume evidence. The collector used to consult a
  // bypass predicate for exactly these trace shapes; the real external behavior is that a
  // complete, side-effect-free payload keeps reporting the evidence gap whatever the trace says.
  for (const legacyTrace of [
    {
      blocked_path:
        'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      status: 'needs_followup',
    },
    {
      fieldPath:
        'modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
      decisionStatus: 'deferred_to_common_other',
    },
    { path: 'nested.annualSupplyOrProductionVolume', status: 'unresolved_deferred' },
  ]) {
    const payload = {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': '77777777-7777-4777-8777-777777777777',
            'common:other': { 'tiangongfoundry:unresolvedTrace': legacyTrace },
          },
        },
        modellingAndValidation: {
          dataSourcesTreatmentAndRepresentativeness: {
            annualSupplyOrProductionVolume: [],
          },
        },
      },
    };
    const before = JSON.stringify(payload);
    assert.equal(
      processRequiredInternals
        .collectProcessRequiredFieldIssues(payload)
        .some((issue) => issue.code === 'annual_supply_or_production_volume_missing'),
      true,
      `legacy trace must not waive the gap: ${JSON.stringify(legacyTrace)}`,
    );
    assert.equal(JSON.stringify(payload), before, 'issue collection must not mutate its input');
  }
  const deferredWithDataSources = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:other': {
            'tiangongfoundry:unresolvedTrace': {
              action_item_code: 'invalid_format',
              blocked_path:
                'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.annualSupplyOrProductionVolume',
              status: 'deferred_to_common_other',
            },
          },
        },
      },
      modellingAndValidation: {
        dataSourcesTreatmentAndRepresentativeness: {},
      },
    },
  });
  assert.equal(
    deferredWithDataSources.some(
      (issue) => issue.code === 'annual_supply_or_production_volume_missing',
    ),
    true,
    'a deferred_to_common_other trace is not evidence and must not waive the annual-volume gap',
  );

  const missingDataSources = processRequiredInternals.collectProcessRequiredFieldIssues({
    processDataSet: {
      modellingAndValidation: {
        complianceDeclarations: {
          compliance: {},
        },
      },
    },
  });
  assert.equal(
    missingDataSources.some((issue) => issue.code === 'process_data_sources_treatment_missing'),
    true,
  );
  assert.equal(
    supabaseClientInternals.postgrestInvalidJsonDetails({
      message: 'bad',
      details: '',
    } as never),
    'bad',
  );
  assert.equal(
    supabaseClientInternals.postgrestInvalidJsonDetails({
      message: '',
      details: '',
    } as never),
    'invalid JSON response',
  );
});
