import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/lib/errors.js';
import { __testInternals, runDatasetSaveDraft } from '../src/lib/dataset-save-draft-run.js';
import type { DatasetSaveDraftReport } from '../src/lib/dataset-save-draft-run.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

function makeDeps(overrides = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    dotEnvStatus,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    }),
    ...overrides,
  };
}

function jsonResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  };
}

function localized(text: string): { '@xml:lang': 'en'; '#text': string } {
  return { '@xml:lang': 'en', '#text': text };
}

function datasetRef(
  type: string,
  id: string,
  version: string,
  description: string,
): {
  '@type': string;
  '@refObjectId': string;
  '@version': string;
  '@uri': string;
  'common:shortDescription': { '@xml:lang': 'en'; '#text': string };
} {
  return {
    '@type': type,
    '@refObjectId': id,
    '@version': version,
    '@uri': `../datasets/${id}_${version}.xml`,
    'common:shortDescription': localized(description),
  };
}

function makeFlow(typeOfDataSet = 'Product flow'): Record<string, unknown> {
  const classificationInformation =
    typeOfDataSet === 'Elementary flow'
      ? {
          'common:elementaryFlowCategorization': {
            'common:category': [
              {
                '@level': '0',
                '@catId': '1',
                '#text': 'Emissions',
              },
            ],
          },
        }
      : {
          'common:classification': {
            'common:class': [
              {
                '@level': '0',
                '@classId': '0',
                '#text': 'Agriculture, forestry and fishery products',
              },
            ],
          },
        };

  return {
    flowDataSet: {
      '@xmlns': 'http://lca.jrc.it/ILCD/Flow',
      '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
      '@xmlns:ecn': 'http://eplca.jrc.ec.europa.eu/ILCD/Extensions/2018/ECNumber',
      '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@version': '1.1',
      '@locations': '../ILCDLocations.xml',
      '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Flow ../../schemas/ILCD_FlowDataSet.xsd',
      flowInformation: {
        dataSetInformation: {
          'common:UUID': '11111111-1111-1111-1111-111111111111',
          name: {
            baseName: localized('Test flow'),
            treatmentStandardsRoutes: localized('not applicable'),
            mixAndLocationTypes: localized('market'),
          },
          classificationInformation,
        },
        quantitativeReference: {
          referenceToReferenceFlowProperty: '0',
        },
      },
      modellingAndValidation: {
        LCIMethod: {
          typeOfDataSet,
        },
        complianceDeclarations: {
          compliance: {
            'common:referenceToComplianceSystem': datasetRef(
              'source data set',
              '22222222-2222-2222-2222-222222222222',
              '00.00.001',
              'Compliance',
            ),
            'common:approvalOfOverallCompliance': 'Not defined',
          },
        },
      },
      administrativeInformation: {
        dataEntryBy: {
          'common:timeStamp': '2026-06-04T00:00:00.000Z',
          'common:referenceToDataSetFormat': datasetRef(
            'source data set',
            '33333333-3333-3333-3333-333333333333',
            '00.00.001',
            'Format',
          ),
        },
        publicationAndOwnership: {
          'common:dataSetVersion': '00.00.001',
          'common:referenceToOwnershipOfDataSet': datasetRef(
            'contact data set',
            '44444444-4444-4444-4444-444444444444',
            '00.00.001',
            'Owner',
          ),
        },
      },
      flowProperties: {
        flowProperty: {
          '@dataSetInternalID': '0',
          referenceToFlowPropertyDataSet: datasetRef(
            'flow property data set',
            '55555555-5555-5555-5555-555555555555',
            '00.00.001',
            'Mass',
          ),
          meanValue: '1.0',
        },
      },
    },
  };
}

function setFirstFlowPropertyVersion(flow: Record<string, unknown>, version: string): void {
  (
    flow.flowDataSet as {
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: { '@version'?: string };
        };
      };
    }
  ).flowProperties.flowProperty.referenceToFlowPropertyDataSet['@version'] = version;
}

function flowPropertyId(flow: Record<string, unknown>): string {
  return (
    flow.flowDataSet as {
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: { '@refObjectId': string };
        };
      };
    }
  ).flowProperties.flowProperty.referenceToFlowPropertyDataSet['@refObjectId'];
}

function makeSaveDraftFetch(options: {
  rootRows?: unknown[];
  latestSupportRows?: unknown[];
  exactSupportRows?: unknown[];
  resolveContacts?: boolean;
  resolveSources?: boolean;
  createBody?: { ok: true; data?: unknown };
  saveDraftBody?: unknown;
  observedUrls: string[];
  observedBodies?: unknown[];
}): FetchLike {
  return async (input, init) => {
    const url = String(input);
    options.observedUrls.push(url);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ accessToken: 'dataset-save-draft-token' });
    }

    const parsed = new URL(url);
    const table = parsed.pathname.split('/').at(-1);
    if (table === 'flows') {
      return jsonResponse(options.rootRows ?? []);
    }
    if (table === 'flowproperties') {
      return jsonResponse(
        parsed.searchParams.has('version')
          ? (options.exactSupportRows ?? [])
          : (options.latestSupportRows ?? []),
      );
    }
    if (table === 'contacts' && options.resolveContacts !== false) {
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? 'contact-1';
      const version = parsed.searchParams.get('version')?.replace(/^eq\./u, '') ?? '00.00.001';
      return jsonResponse([{ id, version }]);
    }
    if (table === 'sources' && options.resolveSources !== false) {
      const id = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? 'source-1';
      const version = parsed.searchParams.get('version')?.replace(/^eq\./u, '') ?? '00.00.001';
      return jsonResponse([{ id, version }]);
    }
    if (parsed.pathname.endsWith('/functions/v1/app_dataset_create')) {
      if (typeof init?.body === 'string') {
        options.observedBodies?.push(JSON.parse(init.body));
      }
      return jsonResponse(options.createBody ?? { ok: true, data: { id: 'created' } });
    }
    if (parsed.pathname.endsWith('/functions/v1/app_dataset_save_draft')) {
      if (typeof init?.body === 'string') {
        options.observedBodies?.push(JSON.parse(init.body));
      }
      return jsonResponse(options.saveDraftBody ?? { ok: true, data: { id: 'saved' } });
    }
    return jsonResponse({ ok: true });
  };
}

function report(status: DatasetSaveDraftReport['status'] = 'completed'): DatasetSaveDraftReport {
  return {
    schema_version: 1,
    generated_at_utc: '2026-06-02T00:00:00.000Z',
    input_path: 'contacts.jsonl',
    requested_type: 'contact',
    out_dir: 'out',
    commit: true,
    mode: 'commit',
    status,
    counts: {
      selected: 1,
      prepared: status === 'completed' ? 0 : 1,
      executed: status === 'completed' ? 1 : 0,
      failed: status === 'completed' ? 0 : 1,
      by_table: {
        contacts: 1,
      },
      operations: {
        [status === 'completed' ? 'insert' : 'skipped_invalid']: 1,
      },
    },
    files: {
      selected_rows: 'out/outputs/dataset-save-draft/selected-rows.jsonl',
      progress_jsonl: 'out/outputs/dataset-save-draft/progress.jsonl',
      failures_jsonl: 'out/outputs/dataset-save-draft/failures.jsonl',
      summary_json: 'out/outputs/dataset-save-draft/summary.json',
    },
    rows: [],
  };
}

test('executeCli exposes generic dataset save-draft for support rows', async () => {
  const observed: unknown[] = [];
  const help = await executeCli(['dataset', 'save-draft', '--help'], makeDeps());
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /tiangong-lca dataset save-draft --input <file>/u);
  assert.match(help.stdout, /auto, contact, source, flow, process/u);
  assert.match(help.stdout, /--max-parallel <1-8>/u);
  assert.match(help.stdout, /Unit group and flow property rows are reference-only/u);
  assert.match(help.stdout, /Without --commit: preflight the exact/u);
  assert.match(help.stdout, /never falls back to an unguarded save or retries it/u);

  const result = await executeCli(
    [
      'dataset',
      'save-draft',
      '--json',
      '--input',
      'contacts.jsonl',
      '--type',
      'contact',
      '--out-dir',
      'contact-save',
      '--execution-contract',
      'contract.json',
      '--max-parallel',
      '8',
      '--commit',
    ],
    makeDeps({
      runDatasetSaveDraftImpl: async (options: unknown) => {
        observed.push(options);
        return report();
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), report());
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    inputPath: 'contacts.jsonl',
    type: 'contact',
    outDir: 'contact-save',
    commit: true,
    allowReferenceOnlySupport: false,
    executionContractPath: 'contract.json',
    maxParallel: 8,
    env: {},
    fetchImpl: (observed[0] as { fetchImpl: unknown }).fetchImpl,
  });
});

test('executeCli maps generic dataset save-draft failures and rejects mode conflicts', async () => {
  const failed = await executeCli(
    ['dataset', 'save-draft', '--input', 'contacts.jsonl', '--type', 'contact'],
    makeDeps({
      runDatasetSaveDraftImpl: async () => report('completed_with_failures'),
    }),
  );
  assert.equal(failed.exitCode, 1);

  const conflict = await executeCli(
    [
      'dataset',
      'save-draft',
      '--input',
      'contacts.jsonl',
      '--type',
      'contact',
      '--commit',
      '--dry-run',
    ],
    makeDeps(),
  );
  assert.equal(conflict.exitCode, 2);
  assert.match(conflict.stderr, /Cannot pass both --commit and --dry-run/u);

  for (const invalid of ['0', '9', '1.5', 'nope']) {
    const invalidParallel = await executeCli(
      [
        'dataset',
        'save-draft',
        '--input',
        'contacts.jsonl',
        '--execution-contract',
        'contract.json',
        '--max-parallel',
        invalid,
        '--commit',
      ],
      makeDeps(),
    );
    assert.equal(invalidParallel.exitCode, 2);
    assert.match(invalidParallel.stderr, /integer from 1 to 8/u);
  }
});

test('dataset save-draft rejects explicit reference-only support types', () => {
  assert.throws(
    () => __testInternals.normalizeType('flowproperty'),
    /Flow properties are reference-only support data/u,
  );
  assert.throws(
    () => __testInternals.normalizeType('unitgroup'),
    /Unit groups are reference-only support data/u,
  );
  assert.equal(__testInternals.normalizeType(undefined), 'auto');
  assert.equal(__testInternals.normalizeType(' Contacts '), 'contact');
  assert.equal(__testInternals.normalizeType('sources'), 'source');
  assert.equal(__testInternals.normalizeType('flows'), 'flow');
  assert.equal(__testInternals.normalizeType('processes'), 'process');
  assert.throws(() => __testInternals.normalizeType('unit-groups'), /reference-only/u);
  assert.throws(() => __testInternals.normalizeType('flow-properties'), /reference-only/u);
  assert.throws(() => __testInternals.normalizeType('unknown'), /Expected --type/u);
});

test('dataset save-draft allows reference-only support types under the override opt-in', () => {
  assert.equal(__testInternals.normalizeType('unitgroup', true), 'unitgroup');
  assert.equal(__testInternals.normalizeType('unit-groups', true), 'unitgroup');
  assert.equal(__testInternals.normalizeType('flowproperty', true), 'flowproperty');
  assert.equal(__testInternals.normalizeType('flow-properties', true), 'flowproperty');
  // override does not affect other types
  assert.equal(__testInternals.normalizeType('contact', true), 'contact');
});

test('dataset save-draft internals cover row preparation and failure reports', () => {
  const flow = makeFlow('Product flow');
  const rows = __testInternals.prepareRows(
    'memory.json',
    { rows: [{ json_ordered: flow }] },
    'auto',
  );
  assert.equal(rows[0]?.type, 'flow');
  assert.equal(rows[0]?.config?.table, 'flows');
  assert.equal(rows[0]?.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(rows[0]?.version, '00.00.001');
  assert.deepEqual(__testInternals.unwrapPayload({ payload: { contactDataSet: {} } }), {
    contactDataSet: {},
  });
  assert.deepEqual(__testInternals.unwrapPayload({ jsonOrdered: { sourceDataSet: {} } }), {
    sourceDataSet: {},
  });
  assert.equal(__testInternals.detectType({}), null);
  assert.deepEqual(
    __testInternals.extractIdentity({}, {}, __testInternals.DATASET_CONFIGS.contact),
    { id: null, version: null },
  );
  assert.deepEqual(
    __testInternals.extractIdentity(
      {
        contactDataSet: {
          contactInformation: { dataSetInformation: { 'common:UUID': 'payload-id' } },
        },
      },
      { id: ' row-id ', version: ' row-version ' },
      __testInternals.DATASET_CONFIGS.contact,
    ),
    { id: 'row-id', version: 'row-version' },
  );

  const outDir = path.resolve('/tmp/out');
  const files = __testInternals.buildFiles(outDir);
  assert.equal(
    files.summary_json,
    path.join(outDir, 'outputs', 'dataset-save-draft', 'summary.json'),
  );
  const defaultOutDir = __testInternals.defaultOutDir(
    path.resolve('/tmp/input/rows.jsonl'),
    true,
    new Date('2026-06-04T00:00:00.000Z'),
  );
  assert.equal(path.basename(defaultOutDir), 'commit-2026-06-04T000000000Z');
  assert.equal(path.basename(path.dirname(defaultOutDir)), 'dataset-save-draft');
  assert.deepEqual(
    __testInternals.operationCount([
      { operation: 'insert', status: 'executed' },
      { operation: null, status: 'prepared' },
    ] as never),
    { insert: 1, none: 1 },
  );
  assert.deepEqual(__testInternals.byTable(rows), { flows: 1 });
  assert.equal(__testInternals.selectedRow(rows[0] as never).table, 'flows');

  assert.equal(
    __testInternals.buildPreparedFailure({
      index: 0,
      row: {},
      payload: {},
      type: null,
      config: null,
      id: null,
      version: null,
      validation: null,
    })?.operation,
    'type_unknown',
  );
  assert.equal(
    __testInternals.buildPreparedFailure({
      index: 0,
      row: {},
      payload: {},
      type: 'unitgroup',
      config: __testInternals.DATASET_CONFIGS.unitgroup,
      id: 'ug-1',
      version: '01.00.000',
      validation: { ok: true, validator: 'test', issue_count: 0, issues: [] },
    })?.operation,
    'reference_only_type',
  );
  assert.equal(
    __testInternals.buildPreparedFailure({
      index: 0,
      row: {},
      payload: {},
      type: 'contact',
      config: __testInternals.DATASET_CONFIGS.contact,
      id: null,
      version: '01.00.000',
      validation: { ok: true, validator: 'test', issue_count: 0, issues: [] },
    })?.operation,
    'identity_missing',
  );
  assert.equal(
    __testInternals.buildPreparedFailure({
      index: 0,
      row: {},
      payload: {},
      type: 'contact',
      config: __testInternals.DATASET_CONFIGS.contact,
      id: 'contact-1',
      version: '01.00.000',
      validation: {
        ok: false,
        validator: 'test',
        issue_count: 1,
        issues: [{ path: '/x', message: 'bad', code: 'custom' }],
      },
    })?.operation,
    'skipped_invalid',
  );

  assert.deepEqual(
    __testInternals.parseVisibleRows(
      [{ id: ' id ', version: ' v ', user_id: ' user ', state_code: '0' }],
      'https://example.test',
    ),
    [{ id: 'id', version: 'v', user_id: 'user', state_code: null }],
  );
  assert.throws(
    () => __testInternals.parseVisibleRows({}, 'https://example.test'),
    /not a JSON array/u,
  );
  assert.throws(
    () => __testInternals.parseVisibleRows([null], 'https://example.test'),
    /was not a JSON object/u,
  );
  assert.deepEqual(__testInternals.serializeError(new Error('boom')), { message: 'boom' });
  assert.deepEqual(
    __testInternals.serializeError(
      new CliError('bad', {
        code: 'BAD',
        details: { reason: 'test' },
      }),
    ),
    { message: 'bad', details: { reason: 'test' } },
  );
  assert.deepEqual(__testInternals.serializeError('plain'), { message: 'plain' });
  assert.equal(__testInternals.compareVersions(null, null), 0);
  assert.equal(__testInternals.compareVersions(null, '01.00.000'), -1);
  assert.equal(__testInternals.compareVersions('02.00.000', '01.00.000'), 1);
  assert.equal(__testInternals.compareVersions('01.00.000', null), 1);
  assert.equal(__testInternals.compareVersions('01.00.000', '01.00.000'), 0);
  assert.equal(__testInternals.compareVersions('alpha', 'beta'), -1);
  assert.equal(__testInternals.compareVersions('beta', 'alpha'), 1);
  assert.throws(
    () =>
      __testInternals.validatePayload({}, 'contact', {
        table: 'contacts',
        rootKey: 'contactDataSet',
        informationKey: 'contactInformation',
        schemaName: 'MissingSchema' as never,
        factoryName: 'MissingFactory' as never,
      }),
    /MissingSchema is unavailable/u,
  );
  const invalidProcess = __testInternals.validatePayload(
    { processDataSet: {} },
    'process',
    __testInternals.DATASET_CONFIGS.process,
  );
  assert.equal(invalidProcess.ok, false);
});

test('dataset save-draft internals classify unresolved flow references', async () => {
  const unsupported = __testInternals.uniqueFlowRemoteReferences({
    flowDataSet: {
      administrativeInformation: {
        publicationAndOwnership: {
          'common:referenceToOwnershipOfDataSet': {
            '@type': 'unknown data set',
            '@refObjectId': 'owner-1',
            '@version': '01.00.000',
          },
        },
      },
    },
  });
  assert.equal(__testInternals.isLookupableRemoteReference(unsupported[0] as never), false);

  const missingVersionPayload = {
    flowDataSet: {
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            '@type': 'flow property data set',
            '@refObjectId': 'fp-1',
          },
        },
      },
    },
  };
  const noVersion = await __testInternals.missingFlowRemoteReferences({
    runtime: {} as never,
    fetchImpl: (async () => jsonResponse([])) as FetchLike,
    timeoutMs: 1000,
    cache: new Map(),
    payload: missingVersionPayload,
  });
  assert.equal(noVersion[0]?.status, 'version_missing');
  const unsupportedMissing = await __testInternals.missingFlowRemoteReferences({
    runtime: {} as never,
    fetchImpl: (async () => jsonResponse([])) as FetchLike,
    timeoutMs: 1000,
    cache: new Map(),
    payload: {
      flowDataSet: {
        administrativeInformation: {
          publicationAndOwnership: {
            'common:referenceToOwnershipOfDataSet': {
              '@type': 'unknown data set',
              '@refObjectId': 'owner-1',
              '@version': '01.00.000',
            },
          },
        },
      },
    },
  });
  assert.equal(unsupportedMissing[0]?.status, 'unsupported_type');

  const outdatedPayload = {
    flowDataSet: {
      flowProperties: {
        flowProperty: {
          referenceToFlowPropertyDataSet: {
            '@type': 'flow property data set',
            '@refObjectId': 'fp-2',
            '@version': '01.00.000',
          },
        },
      },
    },
  };
  const cache = new Map();
  cache.set(
    __testInternals.supportLookupKey({
      table: 'flowproperties',
      id: 'fp-2',
      version: '01.00.000',
    }),
    Promise.resolve({
      exact: { id: 'fp-2', version: '01.00.000' },
      latest: { id: 'fp-2', version: '02.00.000' },
      exact_source_url: null,
      latest_source_url: null,
    }),
  );
  const outdated = await __testInternals.missingFlowRemoteReferences({
    runtime: {} as never,
    fetchImpl: (async () => jsonResponse([])) as FetchLike,
    timeoutMs: 1000,
    cache,
    payload: outdatedPayload,
  });
  assert.equal(outdated[0]?.status, 'version_outdated');
  assert.equal(outdated[0]?.latest_version, '02.00.000');

  const missingCache = new Map();
  missingCache.set(
    __testInternals.supportLookupKey({
      table: 'flowproperties',
      id: 'fp-2',
      version: '01.00.000',
    }),
    Promise.resolve({
      exact: null,
      latest: null,
      exact_source_url: null,
      latest_source_url: null,
    }),
  );
  const missing = await __testInternals.missingFlowRemoteReferences({
    runtime: {} as never,
    fetchImpl: (async () => jsonResponse([])) as FetchLike,
    timeoutMs: 1000,
    cache: missingCache,
    payload: outdatedPayload,
  });
  assert.equal(missing[0]?.status, 'missing_dataset');
});

test('runDatasetSaveDraft covers dry-run, runtime errors, and save-draft updates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-save-draft-extra-'));
  const flow = makeFlow('Product flow');
  const supportId = flowPropertyId(flow);
  try {
    const dryRun = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: path.join(dir, 'dry'),
      commit: false,
      now: new Date('2026-06-04T00:00:00.000Z'),
    });
    assert.equal(dryRun.rows[0]?.operation, 'would_sync');
    await assert.rejects(
      () =>
        runDatasetSaveDraft({
          inputPath: path.join(dir, 'flows.json'),
          rawInput: { rows: [flow] },
          type: 'flow',
          outDir: path.join(dir, 'bad-runtime'),
          commit: true,
        }),
      /requires env and fetch runtime/u,
    );

    const urls: string[] = [];
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: path.join(dir, 'commit'),
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        rootRows: [{ id: '11111111-1111-1111-1111-111111111111', version: '00.00.001' }],
        exactSupportRows: [{ id: supportId, version: '00.00.001' }],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
      }),
    });
    assert.equal(report.rows[0]?.operation, 'save_draft');
    assert.equal(
      urls.some((url) => url.endsWith('/functions/v1/app_dataset_save_draft')),
      true,
    );

    const failingWrite = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: path.join(dir, 'commit-failure'),
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        rootRows: [{ id: '11111111-1111-1111-1111-111111111111', version: '00.00.001' }],
        exactSupportRows: [{ id: supportId, version: '00.00.001' }],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
        saveDraftBody: {
          ok: false,
          code: 'REMOTE_WRITE_REJECTED',
          message: 'write rejected',
        },
      }),
    });
    assert.equal(failingWrite.status, 'completed_with_failures');
    assert.equal(failingWrite.rows[0]?.status, 'failed');
    assert.equal(failingWrite.rows[0]?.error?.message, 'write rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset save-draft reference helpers find unique remote references', () => {
  const references = __testInternals.uniqueFlowRemoteReferences({
    processDataSet: {
      exchanges: {
        exchange: [
          {
            referenceToFlowDataSet: {
              '@type': 'flow data set',
              '@refObjectId': 'flow-1',
              '@version': '01.00.000',
            },
          },
          {
            referenceToFlowPropertyDataSet: {
              '@type': 'flow property data set',
              '@refObjectId': 'fp-1',
              '@version': '01.00.000',
            },
          },
          {
            referenceToReferenceUnitGroup: {
              '@type': 'unit group data set',
              '@refObjectId': 'ug-1',
              '@version': '01.00.000',
            },
          },
          {
            referenceToFlowPropertyDataSet: {
              '@type': 'flow property data set',
              '@refObjectId': 'fp-1',
              '@version': '01.00.000',
            },
          },
        ],
      },
    },
  });

  assert.deepEqual(
    references.map((reference) => `${reference.table}:${reference.id}`),
    ['flows:flow-1', 'flowproperties:fp-1', 'unitgroups:ug-1'],
  );
  assert.equal(__testInternals.flowType({}), null);
  assert.equal(__testInternals.isElementaryFlowPayload(makeFlow('Elementary flow')), true);
  assert.equal(__testInternals.isElementaryFlowPayload(makeFlow('Product flow')), false);
});

test('runDatasetSaveDraft blocks elementary flow inserts after support resolution', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-save-draft-elementary-'));
  const flow = makeFlow('Elementary flow');
  const urls: string[] = [];
  const supportId = flowPropertyId(flow);

  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: dir,
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        exactSupportRows: [{ id: supportId, version: '00.00.001' }],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
      }),
    });

    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.counts.executed, 0);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.rows[0]?.operation, 'elementary_flow_insert_blocked');
    assert.equal(
      (report.rows[0]?.error?.details as { code?: string }).code,
      'DATASET_SAVE_DRAFT_ELEMENTARY_FLOW_INSERT_BLOCKED',
    );
    assert.equal(
      urls.some((url) => url.endsWith('/functions/v1/app_dataset_create')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetSaveDraft blocks flow writes with unresolved remote references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-save-draft-support-'));
  const flow = makeFlow('Product flow');
  const urls: string[] = [];
  const supportId = flowPropertyId(flow);
  setFirstFlowPropertyVersion(flow, '99.00.000');

  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: dir,
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        exactSupportRows: [],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
      }),
    });

    const details = report.rows[0]?.error?.details as {
      code?: string;
      references?: Array<{ status: string; id: string; version: string | null }>;
    };
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.rows[0]?.operation, 'remote_reference_unresolved');
    assert.equal(details.code, 'DATASET_SAVE_DRAFT_REMOTE_REFERENCE_UNRESOLVED');
    assert.deepEqual(details.references, [
      {
        table: 'flowproperties',
        id: supportId,
        version: '99.00.000',
        path: '/flowDataSet/flowProperties/flowProperty/referenceToFlowPropertyDataSet',
        short_description: 'Mass',
        status: 'missing_version',
        latest_version: '00.00.001',
      },
    ]);
    assert.equal(
      urls.some((url) => url.endsWith('/functions/v1/app_dataset_create')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetSaveDraft blocks product flow inserts with missing non-support references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-save-draft-contact-'));
  const flow = makeFlow('Product flow');
  const urls: string[] = [];
  const supportId = flowPropertyId(flow);

  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: dir,
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        resolveContacts: false,
        exactSupportRows: [{ id: supportId, version: '00.00.001' }],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
      }),
    });

    const details = report.rows[0]?.error?.details as {
      code?: string;
      references?: Array<{ table: string; status: string; id: string }>;
    };
    assert.equal(report.status, 'completed_with_failures');
    assert.equal(report.rows[0]?.operation, 'remote_reference_unresolved');
    assert.equal(details.code, 'DATASET_SAVE_DRAFT_REMOTE_REFERENCE_UNRESOLVED');
    assert.deepEqual(details.references, [
      {
        table: 'contacts',
        id: '44444444-4444-4444-4444-444444444444',
        version: '00.00.001',
        path: '/flowDataSet/administrativeInformation/publicationAndOwnership/common:referenceToOwnershipOfDataSet',
        short_description: 'Owner',
        status: 'missing_dataset',
        latest_version: null,
      },
    ]);
    assert.equal(
      urls.some((url) => url.endsWith('/functions/v1/app_dataset_create')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetSaveDraft allows product flow inserts when reference-only support exists', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-save-draft-product-'));
  const flow = makeFlow('Product flow');
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const supportId = flowPropertyId(flow);

  try {
    const report = await runDatasetSaveDraft({
      inputPath: path.join(dir, 'flows.json'),
      rawInput: { rows: [flow] },
      type: 'flow',
      outDir: dir,
      commit: true,
      now: new Date('2026-06-04T00:00:00.000Z'),
      env: buildSupabaseTestEnv(),
      fetchImpl: makeSaveDraftFetch({
        observedUrls: urls,
        observedBodies: bodies,
        exactSupportRows: [{ id: supportId, version: '00.00.001' }],
        latestSupportRows: [{ id: supportId, version: '00.00.001' }],
      }),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows[0]?.operation, 'insert');
    assert.equal(report.counts.executed, 1);
    assert.equal(
      urls.some((url) => url.endsWith('/functions/v1/app_dataset_create')),
      true,
    );
    assert.deepEqual((bodies[0] as { table?: string; ruleVerification?: boolean })?.table, 'flows');
    assert.equal((bodies[0] as { ruleVerification?: boolean })?.ruleVerification, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
