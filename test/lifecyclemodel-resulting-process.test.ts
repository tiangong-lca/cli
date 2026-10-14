import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDistModule } from './helpers/load-dist-module.js';
import { executeCli } from '../src/cli.js';
import { CliError } from '../src/lib/errors.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  __testInternals,
  normalizeLifecyclemodelResultingProcessRequest,
  runLifecyclemodelBuildResultingProcess,
  type LifecyclemodelResultingProcessRequest,
} from '../src/lib/lifecyclemodel-resulting-process.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonRecord = Record<string, unknown>;
type PublicationKey = 'publicationAndOwnership' | 'common:publicationAndOwnership';

const VERSION = '00.00.001';

async function loadDistLifecyclemodelModule(): Promise<
  typeof import('../src/lib/lifecyclemodel-resulting-process.js')
> {
  return loadDistModule('src/lib/lifecyclemodel-resulting-process.js');
}

async function loadDistLifecyclemodelTestInternals(): Promise<typeof __testInternals> {
  const module = await loadDistLifecyclemodelModule();
  return module.__testInternals;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function createJsonFetch(responses: unknown[], observedUrls: string[] = []): FetchLike {
  let index = 0;
  return (async (input) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    observedUrls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify(next),
    };
  }) as FetchLike;
}

function assertCliErrorSync(
  runner: () => unknown,
  expectedCode: string,
  expectedMessage?: RegExp,
): void {
  assert.throws(runner, (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, expectedCode);
    if (expectedMessage) {
      assert.match(error.message, expectedMessage);
    }
    return true;
  });
}

async function assertCliErrorAsync(
  runner: () => Promise<unknown>,
  expectedCode: string,
  expectedMessage?: RegExp,
): Promise<void> {
  await assert.rejects(runner, (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, expectedCode);
    if (expectedMessage) {
      assert.match(error.message, expectedMessage);
    }
    return true;
  });
}

function createExchange(options: {
  internalId: string;
  flowId?: string | null;
  direction?: string;
  meanAmount?: number | string;
  resultingAmount?: number | string;
}): JsonRecord {
  const exchange: JsonRecord = {
    '@dataSetInternalID': options.internalId,
    exchangeDirection: options.direction ?? 'Output',
  };

  if (options.flowId !== undefined) {
    exchange.referenceToFlowDataSet =
      options.flowId === null
        ? {}
        : {
            '@refObjectId': options.flowId,
            '@type': 'flow data set',
          };
  }
  if (options.meanAmount !== undefined) {
    exchange.meanAmount = options.meanAmount;
  }
  if (options.resultingAmount !== undefined) {
    exchange.resultingAmount = options.resultingAmount;
  }

  return exchange;
}

function createProcessPayload(options: {
  id?: string;
  version?: string;
  name?: unknown;
  referenceInternalId: string;
  exchanges: JsonRecord[] | JsonRecord;
  wrap?: 'json_ordered' | 'json' | null;
  includeAdministrative?: boolean;
  includeModelling?: boolean;
  publicationKey?: PublicationKey;
  generalComment?: unknown;
}): JsonRecord {
  const dataSetInformation: JsonRecord = {};
  if (options.id !== undefined) {
    dataSetInformation['common:UUID'] = options.id;
  }
  if (options.name !== undefined) {
    dataSetInformation.name = options.name;
  }
  if (options.generalComment !== undefined) {
    dataSetInformation['common:generalComment'] = options.generalComment;
  }

  const dataset: JsonRecord = {
    processInformation: {
      dataSetInformation,
      quantitativeReference: {
        referenceToReferenceFlow: options.referenceInternalId,
      },
    },
    exchanges: {
      exchange: options.exchanges,
    },
  };

  if (options.includeAdministrative !== false) {
    dataset.administrativeInformation = {
      [options.publicationKey ?? 'publicationAndOwnership']: {
        'common:dataSetVersion': options.version ?? VERSION,
      },
    };
  }

  if (options.includeModelling !== false) {
    dataset.modellingAndValidation = {
      LCIMethodAndAllocation: {
        typeOfDataSet: 'Unit process, single operation',
      },
    };
  }

  const directPayload = {
    processDataSet: dataset,
  };

  if (options.wrap === 'json_ordered') {
    return { json_ordered: directPayload };
  }
  if (options.wrap === 'json') {
    return { json: directPayload };
  }

  return directPayload;
}

function createOutputExchange(options: {
  id?: string;
  flowId?: string | null;
  downstreamId?: string | null;
  downstreamFlowId?: string | null;
}): JsonRecord {
  const downstreamProcess: JsonRecord = {};
  if (options.downstreamId !== undefined && options.downstreamId !== null) {
    downstreamProcess['@id'] = options.downstreamId;
  }
  if (options.downstreamFlowId !== undefined && options.downstreamFlowId !== null) {
    downstreamProcess['@flowUUID'] = options.downstreamFlowId;
  }

  const exchange: JsonRecord = {
    downstreamProcess,
  };
  if (options.id) {
    exchange['@id'] = options.id;
  }
  if (options.flowId !== undefined && options.flowId !== null) {
    exchange['@flowUUID'] = options.flowId;
  }

  return exchange;
}

function createProcessInstance(options: {
  instanceId: string;
  processId: string;
  version?: string;
  factor?: string | number;
  shortDescription?: unknown;
  name?: unknown;
  outputExchange?: JsonRecord[] | JsonRecord;
}): JsonRecord {
  const referenceToProcess: JsonRecord = {
    '@refObjectId': options.processId,
    '@version': options.version ?? VERSION,
  };
  if (options.shortDescription !== undefined) {
    referenceToProcess['common:shortDescription'] = options.shortDescription;
  }
  if (options.name !== undefined) {
    referenceToProcess.name = options.name;
  }

  return {
    '@dataSetInternalID': options.instanceId,
    '@multiplicationFactor': String(options.factor ?? '1'),
    referenceToProcess,
    connections: {
      outputExchange: options.outputExchange ?? [],
    },
  };
}

function createLifecycleModel(options: {
  id?: string;
  version?: string;
  namePayload?: unknown;
  referenceToResultingProcess?: JsonRecord | null;
  referenceProcessInstance?: unknown;
  instances?: JsonRecord[] | JsonRecord;
  includeWrapper?: boolean;
  technologyInRoot?: boolean;
  publicationKey?: PublicationKey;
  jsonTgSubmodels?: unknown;
}): JsonRecord {
  const lifeCycleModelInformation: JsonRecord = {
    dataSetInformation: {
      'common:UUID': options.id ?? 'lm-demo',
    },
    quantitativeReference: {},
  };

  if (options.namePayload !== undefined) {
    (lifeCycleModelInformation.dataSetInformation as JsonRecord).name = options.namePayload;
  }
  if (
    options.referenceToResultingProcess !== undefined &&
    options.referenceToResultingProcess !== null
  ) {
    (lifeCycleModelInformation.dataSetInformation as JsonRecord).referenceToResultingProcess =
      options.referenceToResultingProcess;
  }
  if (options.referenceProcessInstance !== undefined) {
    (lifeCycleModelInformation.quantitativeReference as JsonRecord).referenceToReferenceProcess =
      options.referenceProcessInstance;
  }
  if (!options.technologyInRoot) {
    lifeCycleModelInformation.technology = {
      processes: {
        processInstance: options.instances ?? [],
      },
    };
  }

  const root: JsonRecord = {
    '@id': options.id ?? 'lm-demo',
    '@version': options.version ?? VERSION,
    lifeCycleModelInformation,
    administrativeInformation: {
      [options.publicationKey ?? 'publicationAndOwnership']: {
        'common:dataSetVersion': options.version ?? VERSION,
      },
    },
  };

  if (options.technologyInRoot) {
    root.technology = {
      processes: {
        processInstance: options.instances ?? [],
      },
    };
  }
  if (options.jsonTgSubmodels !== undefined) {
    root.json_tg = {
      submodels: options.jsonTgSubmodels,
    };
  }

  return options.includeWrapper === false ? root : { lifeCycleModelDataSet: root };
}

test('normalizeLifecyclemodelResultingProcessRequest resolves paths and auto-detects process sources', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-normalize-'));
  const modelPath = path.join(dir, 'tidas_bundle', 'lifecyclemodels', 'battery-model.json');
  const localProcessesDir = path.join(dir, 'tidas_bundle', 'lifecyclemodels', 'processes');
  const siblingProcessesDir = path.join(dir, 'tidas_bundle', 'processes');
  const stemProcessesDir = path.join(dir, 'tidas_bundle', 'lifecyclemodels', 'battery-processes');
  const catalogPath = path.join(dir, 'process-catalog.json');
  const explicitJsonFile = path.join(dir, 'processes', `proc-demo_${VERSION}.json`);
  const requestPath = path.join(dir, 'request.json');

  writeJson(modelPath, createLifecycleModel({ instances: [] }));
  mkdirSync(localProcessesDir, { recursive: true });
  mkdirSync(siblingProcessesDir, { recursive: true });
  mkdirSync(stemProcessesDir, { recursive: true });
  writeJson(catalogPath, []);
  writeJson(explicitJsonFile, {});

  try {
    const distModule = await loadDistLifecyclemodelModule();
    const normalized = normalizeLifecyclemodelResultingProcessRequest(
      {
        source_model: {
          json_ordered_path: pathToFileURL(modelPath).href,
        },
        projection: {
          attach_graph_snapshot: 'true',
          attach_graph_snapshot_uri: 'https://example.com/snapshots/model.png',
        },
        process_sources: {
          run_dirs: './runs/demo-run',
          process_json_files: './processes/proc-demo_00.00.001.json',
          allow_mcp_lookup: 'true',
        },
      },
      {
        requestPath,
      },
    );

    assert.equal(normalized.source_model.json_ordered_path, pathToFileURL(modelPath).href);
    assert.equal(normalized.projection.mode, 'primary-only');
    assert.equal(normalized.projection.attach_graph_snapshot, true);
    assert.equal(
      normalized.projection.attach_graph_snapshot_uri,
      'https://example.com/snapshots/model.png',
    );
    assert.equal(normalized.process_sources.process_catalog_path, catalogPath);
    assert.deepEqual(
      normalized.process_sources.process_json_dirs.sort(),
      [localProcessesDir, siblingProcessesDir, stemProcessesDir].sort(),
    );
    assert.deepEqual(normalized.process_sources.run_dirs, [path.join(dir, 'runs', 'demo-run')]);
    assert.deepEqual(normalized.process_sources.process_json_files, [
      path.join(dir, 'processes', 'proc-demo_00.00.001.json'),
    ]);
    assert.equal(normalized.process_sources.allow_remote_lookup, true);
    assert.equal(normalized.publish.intent, 'dry_run');
    assert.equal(normalized.publish.prepare_process_payloads, true);
    assert.equal(normalized.publish.prepare_relation_payloads, true);

    const normalizedFromFileUrls = normalizeLifecyclemodelResultingProcessRequest(
      {
        source_model: {
          id: 'lm-file-urls',
        },
        process_sources: {
          process_json_dirs: [pathToFileURL(localProcessesDir).href],
          process_json_files: pathToFileURL(explicitJsonFile).href,
        },
        publish: {
          prepare_process_payloads: false,
          prepare_relation_payloads: false,
        },
      },
      {
        requestPath,
      },
    );
    assert.deepEqual(normalizedFromFileUrls.process_sources.process_json_dirs, [localProcessesDir]);
    assert.deepEqual(normalizedFromFileUrls.process_sources.process_json_files, [explicitJsonFile]);
    assert.equal(normalizedFromFileUrls.publish.prepare_process_payloads, false);
    assert.equal(normalizedFromFileUrls.publish.prepare_relation_payloads, false);

    const normalizedFromDist = distModule.normalizeLifecyclemodelResultingProcessRequest(
      {
        source_model: {
          json_ordered_path: pathToFileURL(modelPath).href,
        },
        process_sources: {
          run_dirs: ['./runs/demo-run'],
        },
      },
      {
        requestPath,
      },
    );
    assert.deepEqual(normalizedFromDist.process_sources.run_dirs, [
      path.join(dir, 'runs', 'demo-run'),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeLifecyclemodelResultingProcessRequest rejects malformed request shapes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-normalize-errors-'));
  const requestPath = path.join(dir, 'request.json');

  try {
    assertCliErrorSync(
      () => normalizeLifecyclemodelResultingProcessRequest([], { requestPath }),
      'LIFECYCLEMODEL_REQUEST_NOT_OBJECT',
    );
    assertCliErrorSync(
      () => normalizeLifecyclemodelResultingProcessRequest({}, { requestPath }),
      'LIFECYCLEMODEL_SOURCE_MODEL_REQUIRED',
    );
    assertCliErrorSync(
      () =>
        normalizeLifecyclemodelResultingProcessRequest(
          {
            source_model: {
              json_ordered_path: 'https://example.com/model.json',
            },
            process_sources: {
              process_catalog_path: 'https://example.com/process-catalog.json',
            },
          },
          { requestPath },
        ),
      'LIFECYCLEMODEL_LOCAL_PATH_REQUIRED',
    );
    assertCliErrorSync(
      () =>
        normalizeLifecyclemodelResultingProcessRequest(
          {
            source_model: {
              id: 'lm-demo',
            },
            process_sources: {
              process_json_files: [42],
            },
          },
          { requestPath },
        ),
      'LIFECYCLEMODEL_INVALID_STRING_ARRAY',
    );
    assertCliErrorSync(
      () =>
        normalizeLifecyclemodelResultingProcessRequest(
          {
            source_model: {
              id: 'lm-demo',
            },
            projection: {
              mode: 'invalid',
            },
          },
          { requestPath },
        ),
      'LIFECYCLEMODEL_INVALID_PROJECTION_MODE',
    );
    assertCliErrorSync(
      () =>
        normalizeLifecyclemodelResultingProcessRequest(
          {
            source_model: {
              id: 'lm-demo',
            },
            publish: {
              intent: 'ship-it',
            },
          },
          { requestPath },
        ),
      'LIFECYCLEMODEL_INVALID_PUBLISH_INTENT',
    );
    assertCliErrorSync(
      () =>
        normalizeLifecyclemodelResultingProcessRequest(
          {
            source_model: {
              id: 'lm-demo',
            },
            projection: {
              metadata_overrides: [],
            },
          },
          { requestPath },
        ),
      'LIFECYCLEMODEL_INVALID_METADATA_OVERRIDES',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess builds and aggregates a resulting process bundle', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-success-'));
  const procCellPath = path.join(dir, 'inputs', `proc-cell-module_${VERSION}.json`);
  const runDir = path.join(dir, 'runs', 'local-run');
  const procPackPath = path.join(
    runDir,
    'exports',
    'processes',
    `proc-pack-assembly_${VERSION}.json`,
  );
  const snapshotPath = path.join(dir, 'snapshot.png');
  const catalogPath = path.join(dir, 'process-catalog.json');
  const requestPath = path.join(dir, 'request.json');
  const outDir = path.join(dir, 'out');
  const now = new Date('2026-03-29T00:00:00.000Z');

  const model = createLifecycleModel({
    id: 'lm-demo-battery-pack',
    version: VERSION,
    namePayload: 'Battery pack model',
    referenceProcessInstance: '2',
    includeWrapper: false,
    instances: [
      createProcessInstance({
        instanceId: '1',
        processId: 'proc-cell-module',
        shortDescription: [
          {
            '@xml:lang': 'en',
            '#text': 'Cell module assembly',
          },
        ],
        outputExchange: [
          createOutputExchange({
            id: 'edge-cell-to-pack',
            flowId: 'flow-cell-module',
            downstreamId: '2',
            downstreamFlowId: 'flow-cell-module',
          }),
          createOutputExchange({
            id: 'edge-ghost',
            flowId: 'flow-ghost',
            downstreamId: '999',
          }),
          createOutputExchange({
            id: 'edge-without-flow',
            downstreamId: '2',
          }),
        ],
      }),
      createProcessInstance({
        instanceId: '2',
        processId: 'proc-pack-assembly',
        shortDescription: [
          {
            '@xml:lang': 'en',
            '#text': 'Pack assembly',
          },
        ],
        outputExchange: [],
      }),
      createProcessInstance({
        instanceId: '3',
        processId: 'proc-pack-assembly',
        factor: '0',
        shortDescription: [
          {
            '@xml:lang': 'en',
            '#text': 'Pack assembly duplicate',
          },
        ],
      }),
    ],
  });

  writeJson(
    procCellPath,
    createProcessPayload({
      id: 'proc-cell-module',
      referenceInternalId: '2',
      wrap: 'json_ordered',
      name: {
        baseName: [
          {
            '@xml:lang': 'en',
            '#text': 'Cell module assembly',
          },
        ],
      },
      generalComment: [
        {
          '@xml:lang': 'en',
          '#text': 'Cell module comment',
        },
      ],
      exchanges: [
        createExchange({
          internalId: '1',
          flowId: 'flow-electricity',
          direction: 'Input',
          meanAmount: 5,
          resultingAmount: 5,
        }),
        createExchange({
          internalId: '1b',
          flowId: 'flow-electricity',
          direction: 'Input',
          resultingAmount: 0.5,
        }),
        createExchange({
          internalId: '1c',
          flowId: null,
          direction: 'Input',
          meanAmount: 99,
        }),
        createExchange({
          internalId: '1d',
          flowId: 'flow-ignored',
          direction: 'Other',
          meanAmount: 2,
        }),
        createExchange({
          internalId: '2',
          flowId: 'flow-cell-module',
          direction: 'Output',
          meanAmount: 1,
          resultingAmount: 1,
        }),
      ],
    }),
  );
  writeJson(
    procPackPath,
    createProcessPayload({
      id: 'proc-pack-assembly',
      referenceInternalId: '3',
      name: {
        baseName: [
          {
            '@xml:lang': 'en',
            '#text': 'Pack assembly',
          },
        ],
      },
      generalComment: [
        {
          '@xml:lang': 'en',
          '#text': 'Pack assembly comment',
        },
      ],
      exchanges: [
        createExchange({
          internalId: '1',
          flowId: 'flow-cell-module',
          direction: 'Input',
          meanAmount: 1,
          resultingAmount: 1,
        }),
        createExchange({
          internalId: '2',
          flowId: 'flow-bms',
          direction: 'Input',
          meanAmount: 1,
          resultingAmount: 1,
        }),
        createExchange({
          internalId: '3',
          flowId: 'flow-battery-pack',
          direction: 'Output',
          resultingAmount: 1,
        }),
      ],
    }),
  );
  writeJson(catalogPath, [
    {
      source_label: runDir,
    },
    {
      ignored: true,
    },
  ]);
  writeText(snapshotPath, 'binary');
  writeJson(requestPath, {
    source_model: {
      json_ordered: model,
    },
    projection: {
      mode: 'primary-only',
      process_id: 'proc-demo-battery-pack-primary',
      process_version: VERSION,
      metadata_overrides: {
        type_of_data_set: 'partly terminated system',
        projection_source: 'unit-test',
      },
      attach_graph_snapshot_uri: pathToFileURL(snapshotPath).href,
    },
    process_sources: {
      process_catalog_path: catalogPath,
      run_dirs: [runDir],
      process_json_files: [procCellPath],
      allow_remote_lookup: false,
    },
    publish: {
      intent: 'prepare_only',
      prepare_process_payloads: true,
      prepare_relation_payloads: true,
    },
  });

  try {
    const report = await runLifecyclemodelBuildResultingProcess({
      inputPath: requestPath,
      outDir,
      now,
    });

    assert.equal(report.generated_at_utc, now.toISOString());
    assert.equal(report.out_dir, outDir);
    assert.equal(report.status, 'prepared_local_bundle');
    assert.equal(report.projected_process_count, 1);
    assert.equal(report.relation_count, 1);
    assert.equal(report.source_model.id, 'lm-demo-battery-pack');
    assert.equal(report.source_model.json_ordered_path, null);

    const normalizedRequest = readJson<JsonRecord>(report.files.normalized_request);
    const projectionReport = readJson<JsonRecord>(report.files.projection_report);
    const bundle = readJson<JsonRecord>(report.files.process_projection_bundle);

    assert.equal(
      (normalizedRequest.process_sources as JsonRecord).process_catalog_path,
      catalogPath,
    );
    assert.equal(projectionReport.node_count as number, 3);
    assert.equal(projectionReport.edge_count as number, 3);

    const projectedProcess = ((bundle.projected_processes as JsonRecord[])[0] as JsonRecord)
      .json_ordered as JsonRecord;
    const processDataSet = projectedProcess.processDataSet as JsonRecord;
    const processInformation = processDataSet.processInformation as JsonRecord;
    const dataSetInformation = processInformation.dataSetInformation as JsonRecord;
    const quantitativeReference = processInformation.quantitativeReference as JsonRecord;
    const technology = processInformation.technology as JsonRecord;
    const metadata = projectedProcess.projectionMetadata as JsonRecord;
    const exchangesWrapper = processDataSet.exchanges as JsonRecord;
    const exchanges = exchangesWrapper.exchange as JsonRecord[];
    const flowIds = exchanges.map((item) => {
      const referenceToFlow = item.referenceToFlowDataSet as JsonRecord;
      return referenceToFlow['@refObjectId'];
    });

    assert.equal(dataSetInformation['common:UUID'], 'proc-demo-battery-pack-primary');
    assert.equal(quantitativeReference.referenceToReferenceFlow, '1');
    assert.deepEqual(flowIds, ['flow-battery-pack', 'flow-bms', 'flow-electricity']);
    assert.deepEqual(
      exchanges.map((item) => [item.exchangeDirection, item.meanAmount]),
      [
        ['Output', '1'],
        ['Input', '1'],
        ['Input', '5.5'],
      ],
    );
    assert.equal((exchanges[0] as JsonRecord).quantitativeReference, true);
    assert.equal((exchanges[2] as JsonRecord).quantitativeReference, false);
    assert.equal(metadata.graph_snapshot_uri, pathToFileURL(snapshotPath).href);
    assert.equal(metadata.projection_source, 'unit-test');
    assert.equal(metadata.type_of_data_set, 'partly terminated system');
    assert.deepEqual(projectedProcess.topologySummary, {
      process_instance_count: 3,
      edge_count: 3,
    });
    assert.equal((technology.referenceToIncludedProcesses as JsonRecord[]).length, 3);
    assert.equal((dataSetInformation['common:generalComment'] as JsonRecord[]).length, 3);
    assert.equal(
      ((processDataSet.modellingAndValidation as JsonRecord).LCIMethodAndAllocation as JsonRecord)
        .typeOfDataSet,
      'partly terminated system',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess auto-detects process dirs and writes a default run directory', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-autodetect-'));
  const modelPath = path.join(dir, 'tidas_bundle', 'lifecyclemodels', 'solo_model.json');
  const processDir = path.join(dir, 'tidas_bundle', 'lifecyclemodels', 'solo_processes');
  const processPath = path.join(processDir, `proc-solo_${VERSION}.json`);
  const catalogPath = path.join(dir, 'process-catalog.json');
  const requestPath = path.join(dir, 'request.json');
  const now = new Date('2026-03-29T01:02:03.000Z');

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-solo',
      version: VERSION,
      namePayload: {
        shortName: {
          '#text': 'Solo model',
        },
      },
      referenceToResultingProcess: {
        id: 'proc-solo-result',
        version: VERSION,
      },
      referenceProcessInstance: {
        id: 'solo-inst',
      },
      technologyInRoot: true,
      publicationKey: 'common:publicationAndOwnership',
      jsonTgSubmodels: [
        {
          id: 'submodel-1',
        },
      ],
      instances: createProcessInstance({
        instanceId: 'solo-inst',
        processId: 'proc-solo',
        factor: 2,
        name: 'Solo process',
      }),
    }),
  );
  writeJson(
    processPath,
    createProcessPayload({
      id: 'proc-solo',
      referenceInternalId: '1',
      wrap: 'json',
      version: VERSION,
      includeModelling: false,
      exchanges: createExchange({
        internalId: '1',
        flowId: 'flow-solo-product',
        direction: 'Output',
        meanAmount: 1,
      }),
    }),
  );
  writeText(catalogPath, 'not-json');
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './tidas_bundle/lifecyclemodels/solo_model.json',
    },
    projection: {
      mode: 'all-subproducts',
    },
    process_sources: {
      allow_mcp_lookup: 'false',
    },
    publish: {
      intent: 'publish',
    },
  });

  try {
    const report = await runLifecyclemodelBuildResultingProcess({
      inputPath: requestPath,
      now,
    });

    assert.match(
      report.out_dir.replaceAll('\\', '/'),
      /artifacts\/lifecyclemodel_resulting_process\//u,
    );
    assert.equal(report.status, 'projected_local_bundle');
    assert.equal(report.source_model.id, 'lm-solo');
    assert.equal(report.source_model.name, 'Solo model');
    assert.equal(report.source_model.reference_to_resulting_process_id, 'proc-solo-result');
    assert.equal(report.source_model.reference_process_instance_id, 'solo-inst');

    const normalizedRequest = readJson<JsonRecord>(report.files.normalized_request);
    const projectionReport = readJson<JsonRecord>(report.files.projection_report);
    const bundle = readJson<JsonRecord>(report.files.process_projection_bundle);

    assert.equal(
      (normalizedRequest.process_sources as JsonRecord).process_catalog_path,
      catalogPath,
    );
    assert.deepEqual((normalizedRequest.process_sources as JsonRecord).process_json_dirs, [
      processDir,
    ]);
    assert.equal(projectionReport.status as string, 'projected_local_bundle');
    assert.match(
      (projectionReport.notes as string[])[2] as string,
      /only carries submodel metadata/u,
    );

    const projectedProcess = ((bundle.projected_processes as JsonRecord[])[0] as JsonRecord)
      .json_ordered as JsonRecord;
    const processDataSet = projectedProcess.processDataSet as JsonRecord;
    const exchanges = ((processDataSet.exchanges as JsonRecord).exchange as JsonRecord[])[0];
    const processInformation = processDataSet.processInformation as JsonRecord;
    const technology = processInformation.technology as JsonRecord;
    const metadata = projectedProcess.projectionMetadata as JsonRecord;

    assert.equal(
      (processInformation.dataSetInformation as JsonRecord)['common:UUID'] as string,
      'proc-solo-result',
    );
    assert.equal(exchanges.meanAmount, '2');
    assert.equal(exchanges.resultingAmount, undefined);
    assert.equal(
      (exchanges.referenceToFlowDataSet as JsonRecord)['@refObjectId'] as string,
      'flow-solo-product',
    );
    assert.equal(
      (technology.referenceToIncludedProcesses as JsonRecord)['@refObjectId'] as string,
      'proc-solo',
    );
    assert.equal(metadata.graph_snapshot_uri, undefined);
    assert.equal(metadata.type_of_data_set, 'Partly terminated system');
    assert.equal(
      ((processDataSet.modellingAndValidation as JsonRecord).LCIMethodAndAllocation as JsonRecord)
        .typeOfDataSet,
      'Partly terminated system',
    );
    assert.equal(
      ((bundle.projected_processes as JsonRecord[])[0] as JsonRecord).id,
      'proc-solo-result',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess rejects unresolved process lookups and invalid source payloads', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-errors-a-'));
  const modelPath = path.join(dir, 'model.json');
  const requestPath = path.join(dir, 'request.json');

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-errors',
      version: VERSION,
      namePayload: 'Error model',
      referenceProcessInstance: '1',
      instances: createProcessInstance({
        instanceId: '1',
        processId: 'proc-missing',
      }),
    }),
  );

  try {
    writeJson(requestPath, {
      source_model: {
        id: 'lm-only',
      },
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_SOURCE_MODEL_PATH_REQUIRED',
    );

    writeJson(requestPath, {
      source_model: {
        json_ordered_path: 'https://example.com/model.json',
      },
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_LOCAL_PATH_REQUIRED',
    );

    writeJson(modelPath, []);
    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_SOURCE_MODEL_NOT_OBJECT',
    );

    writeJson(
      modelPath,
      createLifecycleModel({
        id: 'lm-errors',
        version: VERSION,
        namePayload: 'Error model',
        referenceProcessInstance: '1',
        instances: createProcessInstance({
          instanceId: '1',
          processId: 'proc-missing',
        }),
      }),
    );
    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
      process_sources: {
        allow_remote_lookup: false,
      },
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_PROCESS_RESOLUTION_FAILED',
    );

    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
      process_sources: {
        allow_remote_lookup: true,
      },
    });
    for (const env of [
      { TIANGONG_LCA_API_BASE_URL: 'https://custom.supabase.co' },
      { TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000' },
    ]) {
      await assertCliErrorAsync(
        () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath, env }),
        'LIFECYCLEMODEL_REMOTE_LOOKUP_ENV_REQUIRED',
      );
    }

    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
      process_sources: {
        process_json_files: ['./proc-missing_00.00.001.json'],
      },
    });
    writeJson(path.join(dir, `proc-missing_${VERSION}.json`), []);
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_PROCESS_FILE_NOT_OBJECT',
    );

    writeJson(path.join(dir, `proc-missing_${VERSION}.json`), {
      json_ordered: {},
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_PROCESS_DATASET_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess rejects invalid process payload semantics and missing topology', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-errors-b-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');
  const processPath = path.join(dir, `proc-error_${VERSION}.json`);

  try {
    writeJson(
      modelPath,
      createLifecycleModel({
        id: 'lm-invalid',
        version: VERSION,
        namePayload: 'Invalid model',
        referenceProcessInstance: '1',
        instances: createProcessInstance({
          instanceId: '1',
          processId: 'proc-error',
          factor: 'bad-number',
        }),
      }),
    );
    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
      process_sources: {
        process_json_files: ['./proc-error_00.00.001.json'],
      },
    });
    writeJson(
      processPath,
      createProcessPayload({
        id: 'proc-error',
        referenceInternalId: '1',
        exchanges: createExchange({
          internalId: '1',
          flowId: 'flow-product',
          direction: 'Output',
          meanAmount: 1,
        }),
      }),
    );
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_INVALID_NUMBER',
    );

    writeJson(
      modelPath,
      createLifecycleModel({
        id: 'lm-invalid',
        version: VERSION,
        namePayload: 'Invalid model',
        referenceProcessInstance: '1',
        instances: createProcessInstance({
          instanceId: '1',
          processId: 'proc-error',
        }),
      }),
    );
    writeJson(
      processPath,
      createProcessPayload({
        referenceInternalId: '1',
        exchanges: createExchange({
          internalId: '1',
          flowId: 'flow-product',
          direction: 'Output',
          meanAmount: 1,
        }),
      }),
    );
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_PROCESS_UUID_REQUIRED',
    );

    writeJson(
      processPath,
      createProcessPayload({
        id: 'proc-error',
        referenceInternalId: '999',
        exchanges: createExchange({
          internalId: '1',
          flowId: 'flow-product',
          direction: 'Output',
          meanAmount: 1,
        }),
      }),
    );
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_REFERENCE_EXCHANGE_NOT_FOUND',
    );

    writeJson(
      modelPath,
      createLifecycleModel({
        id: 'lm-empty',
        version: VERSION,
        namePayload: 'Empty model',
        referenceProcessInstance: '1',
        instances: [],
      }),
    );
    writeJson(requestPath, {
      source_model: {
        json_ordered_path: './model.json',
      },
    });
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_PROCESS_INSTANCES_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess resolves missing processes through deterministic Supabase lookup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-remote-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');
  const observedUrls: string[] = [];

  writeJson(modelPath, {
    technology: {
      processes: {
        processInstance: createProcessInstance({
          instanceId: 'remote-inst',
          processId: 'proc-remote',
          factor: 1,
        }),
      },
    },
  });
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      allow_remote_lookup: true,
    },
  });

  try {
    const report = await runLifecyclemodelBuildResultingProcess({
      inputPath: requestPath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
      }),
      fetchImpl: createJsonFetch(
        [
          [
            {
              id: 'proc-remote',
              json: createProcessPayload({
                id: 'proc-remote',
                version: VERSION,
                referenceInternalId: '1',
                exchanges: createExchange({
                  internalId: '1',
                  flowId: 'flow-remote',
                  direction: 'Output',
                  meanAmount: 1,
                }),
              }),
              version: VERSION,
            },
          ],
        ],
        observedUrls,
      ),
    });

    assert.equal(report.status, 'prepared_local_bundle');
    assert.equal(observedUrls.length, 1);
    assert.match(observedUrls[0] as string, /\/rest\/v1\/processes/u);
    assert.match(observedUrls[0] as string, /id=eq\.proc-remote/u);
    assert.match(observedUrls[0] as string, /version=eq\.00\.00\.001/u);

    const sourceSummary = readJson<JsonRecord>(report.files.source_model_summary);
    const resolvedSummary = sourceSummary.resolved_process_summary as JsonRecord;
    assert.equal(resolvedSummary.remote_resolution_count, 1);
    assert.deepEqual((resolvedSummary.items as JsonRecord[])[0], {
      process_id: 'proc-remote',
      requested_version: VERSION,
      resolved_version: VERSION,
      resolution: 'remote_supabase_exact',
      source_path:
        'https://supabase.example/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-remote&version=eq.00.00.001',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess falls back to latest remote process version when exact version is missing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-remote-fallback-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');
  const observedUrls: string[] = [];

  writeJson(modelPath, {
    technology: {
      processes: {
        processInstance: createProcessInstance({
          instanceId: 'remote-inst',
          processId: 'proc-remote',
          factor: 1,
        }),
      },
    },
  });
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      allow_remote_lookup: true,
    },
  });

  try {
    const report = await runLifecyclemodelBuildResultingProcess({
      inputPath: requestPath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/rest/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
      }),
      fetchImpl: createJsonFetch(
        [
          [],
          [
            {
              id: 'proc-remote',
              json: createProcessPayload({
                id: 'proc-remote',
                version: '00.00.002',
                referenceInternalId: '1',
                exchanges: createExchange({
                  internalId: '1',
                  flowId: 'flow-remote',
                  direction: 'Output',
                  meanAmount: 1,
                }),
              }),
              version: '00.00.002',
            },
          ],
        ],
        observedUrls,
      ),
    });

    assert.equal(report.status, 'prepared_local_bundle');
    assert.equal(observedUrls.length, 2);
    assert.match(observedUrls[0] as string, /version=eq\.00\.00\.001/u);
    assert.doesNotMatch(observedUrls[1] as string, /version=eq\./u);

    const sourceSummary = readJson<JsonRecord>(report.files.source_model_summary);
    const resolvedSummary = sourceSummary.resolved_process_summary as JsonRecord;
    assert.deepEqual((resolvedSummary.items as JsonRecord[])[0], {
      process_id: 'proc-remote',
      requested_version: VERSION,
      resolved_version: '00.00.002',
      resolution: 'remote_supabase_latest_fallback',
      source_path:
        'https://supabase.example/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-remote&order=version.desc&limit=1',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess can use process.env and global fetch for remote lookup fallbacks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-remote-defaults-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.TIANGONG_LCA_API_BASE_URL;
  const originalAuthMode = process.env.TIANGONG_LCA_AUTH_MODE;
  const originalOAuthClientId = process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
  const originalSessionFile = process.env.TIANGONG_LCA_SESSION_FILE;
  const originalPublishableKey = process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  const testEnv = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-remote-defaults',
      version: VERSION,
      namePayload: 'Remote defaults model',
      referenceProcessInstance: 'remote-inst',
      instances: createProcessInstance({
        instanceId: 'remote-inst',
        processId: 'proc-remote',
      }),
    }),
  );
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      allow_remote_lookup: true,
    },
  });

  process.env.TIANGONG_LCA_API_BASE_URL = testEnv.TIANGONG_LCA_API_BASE_URL;
  process.env.TIANGONG_LCA_AUTH_MODE = testEnv.TIANGONG_LCA_AUTH_MODE;
  process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = testEnv.TIANGONG_LCA_OAUTH_CLIENT_ID;
  process.env.TIANGONG_LCA_SESSION_FILE = testEnv.TIANGONG_LCA_SESSION_FILE;
  process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = testEnv.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () =>
        JSON.stringify([
          {
            id: 'proc-remote',
            version: '',
            json: createProcessPayload({
              id: 'proc-remote',
              version: VERSION,
              referenceInternalId: '1',
              exchanges: createExchange({
                internalId: '1',
                flowId: 'flow-remote',
                direction: 'Output',
                meanAmount: 1,
              }),
            }),
            modified_at: null,
            state_code: null,
          },
        ]),
    };
  }) as unknown as typeof fetch;

  try {
    const report = await runLifecyclemodelBuildResultingProcess({
      inputPath: requestPath,
    });

    const sourceSummary = readJson<JsonRecord>(report.files.source_model_summary);
    const resolvedSummary = sourceSummary.resolved_process_summary as JsonRecord;
    assert.deepEqual((resolvedSummary.items as JsonRecord[])[0], {
      process_id: 'proc-remote',
      requested_version: VERSION,
      resolved_version: VERSION,
      resolution: 'remote_supabase_exact',
      source_path:
        'https://supabase.example/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-remote&version=eq.00.00.001',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.TIANGONG_LCA_API_BASE_URL;
    } else {
      process.env.TIANGONG_LCA_API_BASE_URL = originalBaseUrl;
    }
    if (originalAuthMode === undefined) {
      delete process.env.TIANGONG_LCA_AUTH_MODE;
    } else {
      process.env.TIANGONG_LCA_AUTH_MODE = originalAuthMode;
    }
    if (originalOAuthClientId === undefined) {
      delete process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
    } else {
      process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = originalOAuthClientId;
    }
    if (originalSessionFile === undefined) {
      delete process.env.TIANGONG_LCA_SESSION_FILE;
    } else {
      process.env.TIANGONG_LCA_SESSION_FILE = originalSessionFile;
    }
    if (originalPublishableKey === undefined) {
      delete process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
    } else {
      process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess rejects invalid remote lookup runtime and missing remote datasets', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-remote-missing-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-remote-errors',
      version: VERSION,
      namePayload: 'Remote model',
      referenceProcessInstance: 'remote-inst',
      instances: createProcessInstance({
        instanceId: 'remote-inst',
        processId: 'proc-remote',
      }),
    }),
  );
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      allow_remote_lookup: true,
    },
  });

  try {
    await assertCliErrorAsync(
      () =>
        runLifecyclemodelBuildResultingProcess({
          inputPath: requestPath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/custom/path',
            TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
          }),
          fetchImpl: createJsonFetch([[]]),
        }),
      'SUPABASE_REST_BASE_URL_INVALID',
    );

    await assertCliErrorAsync(
      () =>
        runLifecyclemodelBuildResultingProcess({
          inputPath: requestPath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
            TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
          }),
          fetchImpl: createJsonFetch([[], []]),
        }),
      'LIFECYCLEMODEL_REMOTE_PROCESS_NOT_FOUND',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess rejects malformed remote process lookup payloads', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-remote-errors-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');

  writeJson(modelPath, {
    technology: {
      processes: {
        processInstance: createProcessInstance({
          instanceId: 'remote-inst',
          processId: 'proc-remote',
          factor: 1,
        }),
      },
    },
  });
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      allow_remote_lookup: true,
    },
  });

  try {
    await assertCliErrorAsync(
      () =>
        runLifecyclemodelBuildResultingProcess({
          inputPath: requestPath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
            TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
          }),
          fetchImpl: createJsonFetch([{ bad: 'shape' }]),
        }),
      'LIFECYCLEMODEL_REMOTE_LOOKUP_RESPONSE_INVALID',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLifecyclemodelBuildResultingProcess rejects projections without an external reference output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-build-errors-c-'));
  const requestPath = path.join(dir, 'request.json');
  const modelPath = path.join(dir, 'model.json');
  const upstreamPath = path.join(dir, `proc-upstream_${VERSION}.json`);
  const downstreamPath = path.join(dir, `proc-downstream_${VERSION}.json`);

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-no-reference-output',
      version: VERSION,
      namePayload: 'No external reference output',
      referenceProcessInstance: '1',
      instances: [
        createProcessInstance({
          instanceId: '1',
          processId: 'proc-upstream',
          shortDescription: 'Upstream',
          outputExchange: createOutputExchange({
            id: 'edge-upstream-downstream',
            flowId: 'flow-intermediate',
            downstreamId: '2',
            downstreamFlowId: 'flow-intermediate',
          }),
        }),
        createProcessInstance({
          instanceId: '2',
          processId: 'proc-downstream',
          shortDescription: 'Downstream',
        }),
      ],
    }),
  );
  writeJson(
    upstreamPath,
    createProcessPayload({
      id: 'proc-upstream',
      referenceInternalId: '1',
      exchanges: createExchange({
        internalId: '1',
        flowId: 'flow-intermediate',
        direction: 'Output',
        meanAmount: 1,
      }),
    }),
  );
  writeJson(
    downstreamPath,
    createProcessPayload({
      id: 'proc-downstream',
      referenceInternalId: '2',
      exchanges: [
        createExchange({
          internalId: '1',
          flowId: 'flow-intermediate',
          direction: 'Input',
          meanAmount: 1,
        }),
        createExchange({
          internalId: '2',
          flowId: 'flow-final',
          direction: 'Output',
          meanAmount: 1,
        }),
      ],
    }),
  );
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      process_json_files: ['./proc-upstream_00.00.001.json', './proc-downstream_00.00.001.json'],
      allow_remote_lookup: false,
    },
  });

  try {
    await assertCliErrorAsync(
      () => runLifecyclemodelBuildResultingProcess({ inputPath: requestPath }),
      'LIFECYCLEMODEL_REFERENCE_OUTPUT_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli can run lifecyclemodel build-resulting-process end to end', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-cli-e2e-'));
  const modelPath = path.join(dir, 'model.json');
  const processPath = path.join(dir, `proc-cli_${VERSION}.json`);
  const requestPath = path.join(dir, 'request.json');

  writeJson(
    modelPath,
    createLifecycleModel({
      id: 'lm-cli',
      version: VERSION,
      namePayload: 'CLI model',
      referenceProcessInstance: {
        '@refObjectId': 'cli-inst',
      },
      referenceToResultingProcess: {
        '@refObjectId': 'proc-cli-result',
        '@version': VERSION,
      },
      instances: createProcessInstance({
        instanceId: 'cli-inst',
        processId: 'proc-cli',
        name: {
          name: {
            text: 'CLI process',
          },
        },
      }),
    }),
  );
  writeJson(
    processPath,
    createProcessPayload({
      id: 'proc-cli',
      referenceInternalId: '1',
      exchanges: createExchange({
        internalId: '1',
        flowId: 'flow-cli-product',
        direction: 'Output',
        meanAmount: 1,
      }),
    }),
  );
  writeJson(requestPath, {
    source_model: {
      json_ordered_path: './model.json',
    },
    process_sources: {
      process_json_files: ['./proc-cli_00.00.001.json'],
      allow_mcp_lookup: 'false',
    },
    publish: {
      intent: 'dry_run',
    },
  });

  try {
    const result = await executeCli(
      ['lifecyclemodel', 'build-resulting-process', '--input', requestPath, '--json'],
      {
        env: process.env,
        dotEnvStatus: {
          loaded: false,
          path: '/tmp/.env',
          count: 0,
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{}',
        }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');

    const payload = JSON.parse(result.stdout) as JsonRecord;
    assert.equal(payload.status, 'prepared_local_bundle');
    assert.equal(payload.projected_process_count, 1);
    assert.equal((payload.source_model as JsonRecord).reference_process_instance_id, 'cli-inst');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel internal helpers cover primitive fallback branches', async () => {
  const internals = await loadDistLifecyclemodelTestInternals();

  assert.deepEqual(internals.uniqueStrings([null, 'a', 'a', 'b']), ['a', 'b']);
  assert.equal(internals.toFiniteNumber(undefined, 'missing-number'), 0);
  assert.equal(internals.normalizeNumericOutput(-0), 0);
  assert.equal(internals.toBoolean('false', true), false);
  assert.equal(internals.toBoolean('fallback-true', false), true);
  assert.equal(internals.resolveNameField('  trimmed  '), 'trimmed');
  assert.equal(internals.resolveNameField('   '), null);
  assert.equal(internals.resolveNameField([{ '#text': 'from-array' }]), 'from-array');
  assert.equal(internals.resolveNameField([{ unused: true }]), null);
  assert.equal(internals.resolveNameField({ shortName: { '#text': 'short-name' } }), 'short-name');
  assert.equal(internals.resolveNameField({ name: 'plain-name' }), 'plain-name');
  assert.deepEqual(internals.normalizedNameInfo({}, 'fallback-name'), {
    baseName: [
      {
        '@xml:lang': 'en',
        '#text': 'fallback-name',
      },
    ],
  });

  const fallbackIdentity = internals.modelIdentifier(
    {},
    {
      id: null,
      version: null,
      name: null,
      json_ordered_path: null,
      json_ordered: null,
    },
  );
  assert.match(fallbackIdentity.id, /^lm-[0-9a-f]{12}$/u);
  assert.equal(fallbackIdentity.version, VERSION);
  assert.equal(fallbackIdentity.name, fallbackIdentity.id);

  assert.deepEqual(internals.referenceToResultingProcess({}), {
    id: null,
    version: null,
  });
  assert.equal(internals.referenceProcessInstanceId({}), null);
});

test('lifecyclemodel internal helpers cover extraction, parsing, and discovery fallbacks', async () => {
  const internals = await loadDistLifecyclemodelTestInternals();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-internals-'));
  const modelPath = path.join(dir, 'alt', 'custom', 'model.json');
  const requestModelPath = path.join(dir, 'embedded-model.json');
  const runDir = path.join(dir, 'run-source');
  const catalogPath = path.join(dir, 'catalog.json');
  const explicitFile = path.join(dir, `proc-explicit_${VERSION}.json`);
  const processDir = path.join(runDir, 'exports', 'processes');
  const fromDir = path.join(processDir, `proc-dir_${VERSION}.json`);

  mkdirSync(path.dirname(modelPath), { recursive: true });
  writeText(modelPath, '{}');
  writeJson(requestModelPath, createLifecycleModel({ instances: [] }));
  mkdirSync(processDir, { recursive: true });
  writeJson(fromDir, {});
  writeJson(explicitFile, {});
  writeJson(catalogPath, [
    {
      source_label: runDir,
    },
    {
      source_label: '',
    },
  ]);

  try {
    const extractedInstances = internals.extractProcessInstances({
      technology: {
        processes: {
          processInstance: [
            { '@multiplicationFactor': '0' },
            {
              '@dataSetInternalID': 'second',
              '@multiplicationFactor': '0',
              referenceToProcess: {
                '@refObjectId': 'proc-duplicate',
              },
            },
            {
              '@dataSetInternalID': 'third',
              '@multiplicationFactor': '0',
              referenceToProcess: {
                '@refObjectId': 'proc-duplicate',
              },
            },
          ],
        },
      },
    });
    assert.deepEqual(
      extractedInstances.map((item) => ({
        instance_id: item.instance_id,
        process_id: item.process_id,
        version: item.process_version,
        label: item.label,
        factor: item.multiplication_factor,
      })),
      [
        {
          instance_id: 'pi-1',
          process_id: 'proc-1',
          version: VERSION,
          label: 'process-1',
          factor: 0,
        },
        {
          instance_id: 'second',
          process_id: 'proc-duplicate',
          version: VERSION,
          label: 'proc-duplicate',
          factor: 0,
        },
        {
          instance_id: 'third',
          process_id: 'proc-duplicate',
          version: VERSION,
          label: 'proc-duplicate',
          factor: 0,
        },
      ],
    );
    assert.deepEqual(internals.extractProcessInstances({}), []);
    assert.deepEqual(
      internals.processReferencePairs({
        technology: {
          processes: {
            processInstance: [
              {
                '@dataSetInternalID': 'one',
                '@multiplicationFactor': '0',
                referenceToProcess: {
                  '@refObjectId': 'proc-a',
                },
              },
              {
                '@dataSetInternalID': 'two',
                '@multiplicationFactor': '0',
                referenceToProcess: {
                  '@refObjectId': 'proc-a',
                },
              },
            ],
          },
        },
      }),
      [{ process_id: 'proc-a', version: VERSION }],
    );

    assert.deepEqual(
      internals.extractEdges({
        technology: {
          processes: {
            processInstance: {
              '@dataSetInternalID': 'proc-edge',
              '@multiplicationFactor': '0',
              referenceToProcess: {
                '@refObjectId': 'proc-edge',
              },
              connections: {
                outputExchange: [
                  {
                    downstreamProcess: {},
                  },
                  {
                    flowUUID: 'flow-edge',
                    downstreamProcess: {
                      '@id': 'downstream',
                    },
                  },
                ],
              },
            },
          },
        },
      }),
      [
        {
          edge_id: 'proc-edge-edge-2-1',
          from: 'proc-edge',
          to: 'downstream',
          exchange_id: null,
          flow_uuid: 'flow-edge',
          upstream_flow_uuid: 'flow-edge',
        },
      ],
    );
    assert.deepEqual(
      internals.extractEdges({
        technology: {
          processes: {
            processInstance: {
              '@dataSetInternalID': 'proc-no-connections',
              '@multiplicationFactor': '0',
              referenceToProcess: {
                '@refObjectId': 'proc-no-connections',
              },
            },
          },
        },
      }),
      [],
    );

    const parsedRecord = internals.parseProcessRecord(
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:UUID': 'proc-parse',
            },
            quantitativeReference: {
              referenceToReferenceFlow: '1',
            },
          },
          exchanges: {
            exchange: [
              {
                '@dataSetInternalID': '1',
              },
              {
                '@dataSetInternalID': '2',
                referenceToFlowDataSet: {
                  '@refObjectId': 'flow-input',
                },
                exchangeDirection: 'Input',
              },
            ],
          },
        },
      },
      {
        sourceLabel: 'parse-test',
        sourcePath: null,
      },
    );
    assert.equal(parsedRecord.version, VERSION);
    assert.equal(parsedRecord.referenceFlowUuid, '');
    assert.equal(parsedRecord.referenceDirection, '');
    assert.equal(parsedRecord.referenceAmount, 0);
    assert.equal(parsedRecord.inputAmounts['flow-input'], 0);

    const blankReferenceRecord = internals.parseProcessRecord(
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:UUID': 'proc-blank',
            },
          },
          exchanges: {
            exchange: {
              exchangeDirection: 'Output',
              referenceToFlowDataSet: {
                '@refObjectId': 'flow-blank',
              },
            },
          },
        },
      },
      {
        sourceLabel: 'blank-reference',
        sourcePath: null,
      },
    );
    assert.equal(blankReferenceRecord.referenceExchangeInternalId, '');
    assert.equal(blankReferenceRecord.referenceFlowUuid, 'flow-blank');

    assert.throws(
      () =>
        internals.parseProcessRecord(
          {
            processDataSet: {},
          },
          {
            sourceLabel: 'missing-info',
            sourcePath: null,
          },
        ),
      (error) => {
        assert.equal((error as { code?: string }).code, 'LIFECYCLEMODEL_PROCESS_UUID_REQUIRED');
        return true;
      },
    );
    assert.throws(
      () =>
        internals.parseProcessRecord(
          {
            processDataSet: {
              processInformation: {
                dataSetInformation: {
                  'common:UUID': 'proc-missing-reference',
                },
              },
            },
          },
          {
            sourceLabel: 'missing-reference',
            sourcePath: null,
          },
        ),
      (error) => {
        assert.equal(
          (error as { code?: string }).code,
          'LIFECYCLEMODEL_REFERENCE_EXCHANGE_NOT_FOUND',
        );
        assert.match(String((error as { message?: string }).message), /\(missing\)/u);
        return true;
      },
    );

    assert.equal(internals.autoDetectProcessCatalogPath(null), null);
    assert.equal(internals.autoDetectProcessCatalogPath(modelPath), null);
    const notBundleModelPath = path.join(
      dir,
      'not-bundle',
      'lifecyclemodels',
      'battery-model.json',
    );
    writeText(notBundleModelPath, '{}');
    assert.equal(internals.autoDetectProcessCatalogPath(notBundleModelPath), null);
    const bundleModelPath = path.join(
      dir,
      'bundle-missing',
      'tidas_bundle',
      'lifecyclemodels',
      'battery_model.json',
    );
    writeText(bundleModelPath, '{}');
    assert.equal(internals.autoDetectProcessCatalogPath(bundleModelPath), null);
    assert.deepEqual(internals.autoDetectProcessJsonDirs('https://example.com/model.json'), []);
    assert.deepEqual(internals.autoDetectProcessJsonDirs(null), []);

    const requestLike: LifecyclemodelResultingProcessRequest = {
      source_model: {
        id: null,
        version: null,
        name: null,
        json_ordered_path: pathToFileURL(requestModelPath).href,
        json_ordered: null,
      },
      projection: {
        mode: 'primary-only',
        process_id: null,
        process_version: null,
        metadata_overrides: {},
        attach_graph_snapshot: false,
        attach_graph_snapshot_uri: null,
      },
      process_sources: {
        process_catalog_path: catalogPath,
        run_dirs: [runDir, path.join(dir, 'missing-run')],
        process_json_dirs: [processDir],
        process_json_files: [explicitFile],
        allow_remote_lookup: false,
      },
      publish: {
        intent: 'dry_run',
        prepare_process_payloads: true,
        prepare_relation_payloads: true,
      },
    };

    assert.deepEqual(internals.processSourceDirs(requestLike).sort(), [processDir].sort());
    assert.equal(
      internals.locateLocalProcessFile('proc-dir', VERSION, {
        processDirs: [processDir],
        processFiles: [],
      }),
      fromDir,
    );
    assert.equal(
      internals.locateLocalProcessFile('proc-explicit', VERSION, {
        processDirs: [],
        processFiles: [explicitFile],
      }),
      explicitFile,
    );
    assert.equal(
      internals.locateLocalProcessFile('proc-missing', VERSION, {
        processDirs: [],
        processFiles: [],
      }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecyclemodel internal builders cover fallback-only branches', async () => {
  const internals = await loadDistLifecyclemodelTestInternals();

  const directChoice = internals.chooseReferenceInstance(
    [
      {
        instance_id: 'a',
        process_id: 'proc-a',
        process_version: VERSION,
        label: 'A',
        multiplication_factor: 0,
        reference_to_process: {},
        raw: {},
      },
      {
        instance_id: 'b',
        process_id: 'proc-b',
        process_version: VERSION,
        label: 'B',
        multiplication_factor: 2,
        reference_to_process: {},
        raw: {},
      },
    ],
    null,
  );
  assert.equal(directChoice.instance_id, 'b');

  const fallbackChoice = internals.chooseReferenceInstance(
    [
      {
        instance_id: 'fallback',
        process_id: 'proc-fallback',
        process_version: VERSION,
        label: 'Fallback',
        multiplication_factor: 0,
        reference_to_process: {},
        raw: {},
      },
    ],
    null,
  );
  assert.equal(fallbackChoice.instance_id, 'fallback');

  assert.deepEqual(
    internals.cloneExchangeWithAmount(
      {
        referenceToFlowDataSet: {
          '@refObjectId': 'flow-direct',
        },
      },
      3,
      '12',
      {
        quantitativeReference: false,
      },
    ),
    {
      '@dataSetInternalID': '12',
      referenceToFlowDataSet: {
        '@refObjectId': 'flow-direct',
      },
      meanAmount: '3',
      quantitativeReference: false,
    },
  );

  const builtProcess = internals.buildResultingProcessPayload({
    sourceModelId: 'lm-internal',
    sourceModelVersion: VERSION,
    sourceModelName: 'Internal',
    sourceModelNameInfo: {
      baseName: [
        {
          '@xml:lang': 'en',
          '#text': 'Internal',
        },
      ],
    },
    processId: 'proc-built',
    processVersion: VERSION,
    role: 'primary',
    projectionSignature: 'sha256:internal',
    processInstances: [
      {
        instance_id: 'a',
        process_id: 'proc-a',
        process_version: VERSION,
        label: 'A',
        multiplication_factor: 1,
        reference_to_process: {},
        raw: {},
      },
      {
        instance_id: 'b',
        process_id: 'proc-b',
        process_version: VERSION,
        label: 'B',
        multiplication_factor: 0,
        reference_to_process: {},
        raw: {},
      },
      {
        instance_id: 'c',
        process_id: 'proc-c',
        process_version: VERSION,
        label: 'C',
        multiplication_factor: 1,
        reference_to_process: {},
        raw: {},
      },
    ],
    edges: [
      {
        edge_id: 'missing-instance',
        from: 'a',
        to: 'missing',
        exchange_id: null,
        flow_uuid: 'flow-ghost',
      },
      {
        edge_id: 'missing-record',
        from: 'a',
        to: 'b',
        exchange_id: null,
        flow_uuid: 'flow-ghost',
      },
    ],
    processRecords: {
      [`proc-a@${VERSION}`]: {
        processUuid: 'proc-a',
        version: VERSION,
        raw: {
          processDataSet: {
            processInformation: {
              technology: {
                existingTechnologyNote: 'kept',
              },
            },
            exchanges: {
              exchange: [
                {
                  referenceToFlowDataSet: {
                    '@refObjectId': 'flow-built',
                  },
                  exchangeDirection: 'Output',
                  meanAmount: 1,
                },
                {
                  exchangeDirection: 'Input',
                },
              ],
            },
          },
        },
        sourceLabel: 'internal',
        sourcePath: null,
        referenceExchangeInternalId: '1',
        referenceFlowUuid: 'flow-built',
        referenceDirection: '',
        referenceAmount: 1,
        inputAmounts: {},
        outputAmounts: {
          'flow-built': 1,
        },
      },
      [`proc-c@${VERSION}`]: {
        processUuid: 'proc-c',
        version: VERSION,
        raw: {
          processDataSet: {},
        },
        sourceLabel: 'internal',
        sourcePath: null,
        referenceExchangeInternalId: '1',
        referenceFlowUuid: 'flow-unused',
        referenceDirection: 'Output',
        referenceAmount: 0,
        inputAmounts: {
          'flow-ghost': 1,
        },
        outputAmounts: {},
      },
    },
    referenceProcessInstanceId: null,
    metadataOverrides: {},
    attachGraphSnapshotUri: null,
  });
  const builtDataset = (builtProcess.processDataSet as JsonRecord).processInformation as JsonRecord;
  assert.equal(
    (
      ((builtProcess.processDataSet as JsonRecord).exchanges as JsonRecord).exchange as JsonRecord[]
    )[0].meanAmount,
    '1',
  );
  assert.equal((builtDataset.quantitativeReference as JsonRecord).referenceToReferenceFlow, '1');
  assert.equal(
    ((builtDataset.technology as JsonRecord).referenceToIncludedProcesses as JsonRecord[]).length,
    3,
  );
  assert.equal((builtDataset.technology as JsonRecord).existingTechnologyNote, 'kept');
  assert.equal(
    (
      ((builtProcess.processDataSet as JsonRecord).administrativeInformation as JsonRecord)
        .publicationAndOwnership as JsonRecord
    )['common:dataSetVersion'],
    VERSION,
  );
  assert.equal(
    (
      ((builtProcess.processDataSet as JsonRecord).modellingAndValidation as JsonRecord)
        .LCIMethodAndAllocation as JsonRecord
    ).typeOfDataSet,
    'Partly terminated system',
  );

  const builtWithoutProcessInformation = internals.buildResultingProcessPayload({
    sourceModelId: 'lm-no-process-info',
    sourceModelVersion: VERSION,
    sourceModelName: 'No Process Info',
    sourceModelNameInfo: {
      baseName: [
        {
          '@xml:lang': 'en',
          '#text': 'No Process Info',
        },
      ],
    },
    processId: 'proc-no-process-info',
    processVersion: VERSION,
    role: 'primary',
    projectionSignature: 'sha256:no-process-info',
    processInstances: [
      {
        instance_id: 'solo',
        process_id: 'proc-solo',
        process_version: VERSION,
        label: 'Solo',
        multiplication_factor: 1,
        reference_to_process: {},
        raw: {},
      },
    ],
    edges: [],
    processRecords: {
      [`proc-solo@${VERSION}`]: {
        processUuid: 'proc-solo',
        version: VERSION,
        raw: {
          processDataSet: {
            exchanges: {
              exchange: {
                referenceToFlowDataSet: {
                  '@refObjectId': 'flow-solo',
                },
                exchangeDirection: 'Output',
                meanAmount: 1,
              },
            },
          },
        },
        sourceLabel: 'internal',
        sourcePath: null,
        referenceExchangeInternalId: '1',
        referenceFlowUuid: 'flow-solo',
        referenceDirection: 'Output',
        referenceAmount: 1,
        inputAmounts: {},
        outputAmounts: {
          'flow-solo': 1,
        },
      },
    },
    referenceProcessInstanceId: 'solo',
    metadataOverrides: {},
    attachGraphSnapshotUri: null,
  });
  assert.equal(
    (
      (
        (builtWithoutProcessInformation.processDataSet as JsonRecord)
          .processInformation as JsonRecord
      ).quantitativeReference as JsonRecord
    ).referenceToReferenceFlow,
    '1',
  );

  const projectionDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lm-projection-internal-'));
  const projectionProcessPath = path.join(projectionDir, `proc-one_${VERSION}.json`);
  writeJson(
    projectionProcessPath,
    createProcessPayload({
      id: 'proc-one',
      referenceInternalId: '1',
      exchanges: createExchange({
        internalId: '1',
        flowId: 'flow-projection',
        direction: 'Output',
        meanAmount: 1,
      }),
    }),
  );

  try {
    const projection = await internals.buildProjectionBundle({
      request: {
        source_model: {
          id: null,
          version: null,
          name: null,
          json_ordered_path: null,
          json_ordered: null,
        },
        projection: {
          mode: 'all-subproducts',
          process_id: null,
          process_version: null,
          metadata_overrides: {},
          attach_graph_snapshot: false,
          attach_graph_snapshot_uri: null,
        },
        process_sources: {
          process_catalog_path: null,
          run_dirs: [],
          process_json_dirs: [],
          process_json_files: [projectionProcessPath],
          allow_remote_lookup: false,
        },
        publish: {
          intent: 'dry_run',
          prepare_process_payloads: true,
          prepare_relation_payloads: true,
        },
      } satisfies LifecyclemodelResultingProcessRequest,
      sourceModelJson: {
        technology: {
          processes: {
            processInstance: createProcessInstance({
              instanceId: 'projection-inst',
              processId: 'proc-one',
              factor: 1,
            }),
          },
        },
      },
      modelPath: null,
    });

    const projectedProcess = (projection.bundle.projected_processes as JsonRecord[])[0];
    assert.equal(projectedProcess.id, `${projection.sourceModelSummary.id}-resulting-process`);
    assert.match(
      (projection.report.notes as string[])[2] as string,
      /does not expose submodel topology metadata/u,
    );
  } finally {
    rmSync(projectionDir, { recursive: true, force: true });
  }
});

test('buildProjectionBundle can fall back to process.env and global fetch for remote lookup internals', async () => {
  const internals = await loadDistLifecyclemodelTestInternals();
  const observedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.TIANGONG_LCA_API_BASE_URL;
  const originalAuthMode = process.env.TIANGONG_LCA_AUTH_MODE;
  const originalOAuthClientId = process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
  const originalSessionFile = process.env.TIANGONG_LCA_SESSION_FILE;
  const originalPublishableKey = process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  const testEnv = buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  process.env.TIANGONG_LCA_API_BASE_URL = testEnv.TIANGONG_LCA_API_BASE_URL;
  process.env.TIANGONG_LCA_AUTH_MODE = testEnv.TIANGONG_LCA_AUTH_MODE;
  process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = testEnv.TIANGONG_LCA_OAUTH_CLIENT_ID;
  process.env.TIANGONG_LCA_SESSION_FILE = testEnv.TIANGONG_LCA_SESSION_FILE;
  process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = testEnv.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  globalThis.fetch = createJsonFetch(
    [
      [
        {
          id: 'proc-remote-internal',
          version: VERSION,
          json: createProcessPayload({
            id: 'proc-remote-internal',
            version: VERSION,
            referenceInternalId: '1',
            exchanges: createExchange({
              internalId: '1',
              flowId: 'flow-remote-internal',
              direction: 'Output',
              meanAmount: 1,
            }),
          }),
          modified_at: null,
          state_code: null,
        },
      ],
    ],
    observedUrls,
  ) as unknown as typeof fetch;

  try {
    const projection = await internals.buildProjectionBundle({
      request: {
        source_model: {
          id: null,
          version: null,
          name: null,
          json_ordered_path: null,
          json_ordered: null,
        },
        projection: {
          mode: 'all-subproducts',
          process_id: null,
          process_version: null,
          metadata_overrides: {},
          attach_graph_snapshot: false,
          attach_graph_snapshot_uri: null,
        },
        process_sources: {
          process_catalog_path: null,
          run_dirs: [],
          process_json_dirs: [],
          process_json_files: [],
          allow_remote_lookup: true,
        },
        publish: {
          intent: 'dry_run',
          prepare_process_payloads: true,
          prepare_relation_payloads: true,
        },
      } satisfies LifecyclemodelResultingProcessRequest,
      sourceModelJson: {
        technology: {
          processes: {
            processInstance: createProcessInstance({
              instanceId: 'projection-inst-remote',
              processId: 'proc-remote-internal',
              factor: 1,
            }),
          },
        },
      },
      modelPath: null,
    });

    assert.equal(observedUrls.length, 1);
    assert.equal(
      observedUrls[0],
      'https://supabase.example/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-remote-internal&version=eq.00.00.001',
    );
    assert.deepEqual(
      (projection.sourceModelSummary.resolved_process_summary.items as JsonRecord[])[0],
      {
        process_id: 'proc-remote-internal',
        requested_version: VERSION,
        resolved_version: VERSION,
        resolution: 'remote_supabase_exact',
        source_path:
          'https://supabase.example/rest/v1/processes?select=id%2Cversion%2Cjson%2Cmodified_at%2Cstate_code&id=eq.proc-remote-internal&version=eq.00.00.001',
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.TIANGONG_LCA_API_BASE_URL;
    } else {
      process.env.TIANGONG_LCA_API_BASE_URL = originalBaseUrl;
    }
    if (originalAuthMode === undefined) {
      delete process.env.TIANGONG_LCA_AUTH_MODE;
    } else {
      process.env.TIANGONG_LCA_AUTH_MODE = originalAuthMode;
    }
    if (originalOAuthClientId === undefined) {
      delete process.env.TIANGONG_LCA_OAUTH_CLIENT_ID;
    } else {
      process.env.TIANGONG_LCA_OAUTH_CLIENT_ID = originalOAuthClientId;
    }
    if (originalSessionFile === undefined) {
      delete process.env.TIANGONG_LCA_SESSION_FILE;
    } else {
      process.env.TIANGONG_LCA_SESSION_FILE = originalSessionFile;
    }
    if (originalPublishableKey === undefined) {
      delete process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
    } else {
      process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
    }
  }
});
