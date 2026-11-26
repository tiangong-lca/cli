import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/shared/errors.js';
import type { FetchLike } from '../src/lib/transport/http.js';
import { __testInternals, syncLifecyclemodelBundleRecord } from '../src/lib/model/bundle-save.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function makeResponse(options: {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: string;
}) {
  return {
    ok: options.ok,
    status: options.status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type'
          ? (options.contentType ?? 'application/json')
          : null;
      },
    },
    async text(): Promise<string> {
      return options.body ?? '';
    },
  };
}

function withSupabaseAuthBootstrap(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (isSupabaseAuthTokenUrl(String(url))) {
      return makeSupabaseAuthResponse();
    }

    return fetchImpl(String(url), init);
  };
}

function createLifecyclemodelPayload(): Record<string, unknown> {
  return {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': 'lm-1',
          referenceToResultingProcess: {
            '@refObjectId': 'proc-primary',
            '@version': '01.01.000',
          },
        },
        technology: {
          processes: {
            processInstance: [
              {
                '@dataSetInternalID': '1',
                referenceToProcess: {
                  '@refObjectId': 'proc-primary',
                  '@version': '01.01.000',
                  name: {
                    baseName: [{ '#text': 'Primary process' }],
                  },
                },
                connections: {
                  outputExchange: {
                    '@flowUUID': 'flow-1',
                    downstreamProcess: {
                      '@id': '2',
                      '@flowUUID': 'flow-1',
                    },
                  },
                },
              },
              {
                '@dataSetInternalID': '2',
                referenceToProcess: {
                  '@refObjectId': 'proc-secondary',
                  '@version': '01.01.000',
                  'common:shortDescription': [{ '#text': 'Secondary process' }],
                },
              },
            ],
          },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '01.01.000',
        },
      },
    },
  };
}

test('deriveLifecyclemodelJsonTg builds xflow and submodels from json_ordered payloads', () => {
  const jsonTg = __testInternals.deriveLifecyclemodelJsonTg(createLifecyclemodelPayload());

  assert.deepEqual(jsonTg.submodels, []);
  assert.equal((jsonTg.xflow as Record<string, unknown>).nodes instanceof Array, true);
  assert.equal(((jsonTg.xflow as Record<string, unknown>).nodes as unknown[]).length, 2);
  assert.deepEqual(
    ((jsonTg.xflow as Record<string, unknown>).edges as Array<Record<string, unknown>>)[0],
    {
      id: '1:2:flow-1',
      source: {
        cell: '1',
      },
      target: {
        cell: '2',
      },
      labels: [],
      data: {
        connection: {
          outputExchange: {
            '@flowUUID': 'flow-1',
            downstreamProcess: {
              '@id': '2',
              '@flowUUID': 'flow-1',
            },
          },
        },
        node: {
          sourceNodeID: '1',
          targetNodeID: '2',
          sourceProcessId: 'proc-primary',
          sourceProcessVersion: '01.01.000',
          targetProcessId: 'proc-secondary',
          targetProcessVersion: '01.01.000',
        },
      },
    },
  );
});

test('deriveLifecyclemodelJsonTg skips invalid submodels and dangling downstream references', () => {
  const payload = createLifecyclemodelPayload();
  const processInstances = (
    (payload.lifeCycleModelDataSet as Record<string, unknown>).lifeCycleModelInformation as Record<
      string,
      unknown
    >
  ).technology as Record<string, unknown>;
  (
    (
      (processInstances.processes as Record<string, unknown>).processInstance as Record<
        string,
        unknown
      >[]
    )[0].connections as Record<string, unknown>
  ).outputExchange = {
    '@flowUUID': 'flow-dangling',
    downstreamProcess: {
      '@flowUUID': 'flow-dangling',
    },
  };
  (
    (processInstances.processes as Record<string, unknown>).processInstance as Record<
      string,
      unknown
    >[]
  ).push({
    '@dataSetInternalID': '3',
    referenceToProcess: {},
  });

  const jsonTg = __testInternals.deriveLifecyclemodelJsonTg(payload);
  assert.deepEqual(jsonTg.submodels, []);
  assert.equal(((jsonTg.xflow as Record<string, unknown>).edges as unknown[]).length, 0);
});

test('buildLifecyclemodelBundlePlan merges explicit metadata and validates processMutations', () => {
  const payload = createLifecyclemodelPayload();
  const plan = __testInternals.buildLifecyclemodelBundlePlan({
    id: 'lm-1',
    version: '01.01.000',
    payload,
    metadata: {
      json_tg: {
        xflow: {
          nodes: [{ id: 'explicit-node' }],
        },
        preserved: true,
      },
      processMutations: [
        {
          op: 'create',
          id: '11111111-1111-1111-1111-111111111111',
          modelId: 'lm-1',
          jsonOrdered: {
            processDataSet: {},
          },
        },
      ],
      ruleVerification: false,
    },
    mode: 'update',
  });

  assert.equal(plan.mode, 'update');
  assert.equal(plan.version, '01.01.000');
  assert.equal(plan.parent.ruleVerification, false);
  assert.deepEqual(plan.parent.jsonTg, {
    xflow: {
      nodes: [{ id: 'explicit-node' }],
      edges: [
        {
          id: '1:2:flow-1',
          source: {
            cell: '1',
          },
          target: {
            cell: '2',
          },
          labels: [],
          data: {
            connection: {
              outputExchange: {
                '@flowUUID': 'flow-1',
                downstreamProcess: {
                  '@id': '2',
                  '@flowUUID': 'flow-1',
                },
              },
            },
            node: {
              sourceNodeID: '1',
              targetNodeID: '2',
              sourceProcessId: 'proc-primary',
              sourceProcessVersion: '01.01.000',
              targetProcessId: 'proc-secondary',
              targetProcessVersion: '01.01.000',
            },
          },
        },
      ],
    },
    submodels: [],
    preserved: true,
  });
  assert.equal(plan.processMutations.length, 1);

  assert.throws(
    () =>
      __testInternals.buildLifecyclemodelBundlePlan({
        id: 'lm-1',
        version: '01.01.000',
        payload,
        metadata: {
          processMutations: [0 as unknown as Record<string, unknown>],
        },
        mode: 'create',
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'LIFECYCLEMODEL_PROCESS_MUTATIONS_INVALID');
      return true;
    },
  );
});

test('lifecyclemodel bundle helpers validate visible rows and function payloads', () => {
  assert.throws(
    () => __testInternals.parseVisibleRows({}, 'https://example.test/rest/v1/lifecyclemodels'),
    /JSON array/u,
  );
  assert.throws(
    () =>
      __testInternals.parseVisibleRows(
        [0],
        'https://example.test/rest/v1/lifecyclemodels?id=eq.lm-1',
      ),
    /JSON object/u,
  );
  assert.throws(
    () => __testInternals.requireLifecyclemodelBundleResponse([], 'https://example.test/function'),
    /unexpected payload/u,
  );
  assert.throws(
    () =>
      __testInternals.requireLifecyclemodelBundleResponse(
        {
          ok: false,
          code: 'INVALID_PAYLOAD',
          message: 'bad request',
        },
        'https://example.test/function',
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'INVALID_PAYLOAD');
      assert.match(error.message, /bad request/u);
      return true;
    },
  );
  assert.deepEqual(
    __testInternals.mergeLifecyclemodelJsonTg(null, {
      xflow: {
        nodes: [],
        edges: [],
      },
      submodels: [],
    }),
    {
      xflow: {
        nodes: [],
        edges: [],
      },
      submodels: [],
    },
  );
  assert.deepEqual(
    __testInternals.mergeLifecyclemodelJsonTg(
      {
        submodels: [{ id: 'explicit-submodel' }],
      },
      {
        xflow: {
          nodes: [{ id: 'derived-node' }],
          edges: [{ id: 'derived-edge' }],
        },
        submodels: [{ id: 'derived-submodel' }],
      },
    ),
    {
      xflow: {
        nodes: [{ id: 'derived-node' }],
        edges: [{ id: 'derived-edge' }],
      },
      submodels: [{ id: 'explicit-submodel' }],
    },
  );
  assert.deepEqual(
    __testInternals.mergeLifecyclemodelJsonTg(
      {
        xflow: {},
      },
      {
        xflow: {
          nodes: [{ id: 'derived-node' }],
          edges: [{ id: 'derived-edge' }],
        },
        submodels: [],
      },
    ),
    {
      xflow: {
        nodes: [{ id: 'derived-node' }],
        edges: [{ id: 'derived-edge' }],
      },
      submodels: [],
    },
  );
  assert.deepEqual(
    __testInternals.mergeLifecyclemodelJsonTg(
      {
        xflow: {
          nodes: 'ignored',
          edges: [{ id: 'explicit-edge' }],
        },
      },
      {
        xflow: {
          nodes: [{ id: 'derived-node' }],
          edges: [{ id: 'derived-edge' }],
        },
        submodels: [],
      },
    ),
    {
      xflow: {
        nodes: [{ id: 'derived-node' }],
        edges: [{ id: 'explicit-edge' }],
      },
      submodels: [],
    },
  );
  assert.deepEqual(
    __testInternals.mergeLifecyclemodelJsonTg(
      {
        xflow: {
          nodes: [{ id: 'explicit-node' }],
          edges: [{ id: 'explicit-edge' }],
        },
      },
      {
        xflow: 'invalid' as unknown as Record<string, unknown>,
        submodels: [],
      },
    ),
    {
      xflow: {
        nodes: [{ id: 'explicit-node' }],
        edges: [{ id: 'explicit-edge' }],
      },
      submodels: [],
    },
  );
  assert.deepEqual(
    __testInternals.parseVisibleRows(
      [
        {
          id: '  ',
          version: null,
        },
      ],
      'https://example.test/rest/v1/lifecyclemodels?id=eq.lm-1',
    ),
    [
      {
        id: '',
        version: '',
      },
    ],
  );
  assert.throws(
    () =>
      __testInternals.requireLifecyclemodelBundleResponse(
        {
          ok: false,
        },
        'https://example.test/function',
      ),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_APPLICATION_ERROR');
      assert.match(error.message, /ok:false/u);
      return true;
    },
  );
});

test('lifecyclemodel bundle helpers fall back cleanly for sparse payloads', () => {
  assert.deepEqual(__testInternals.deriveLifecyclemodelJsonTg({}), {
    xflow: {
      nodes: [],
      edges: [],
    },
    submodels: [],
  });

  const sparsePayload = {
    lifeCycleModelInformation: {
      dataSetInformation: {
        referenceToResultingProcess: 'not-a-record',
      },
      technology: {
        processes: {
          processInstance: [
            {
              '@dataSetInternalID': ' ',
              referenceToProcess: 0,
              connections: {
                outputExchange: {
                  '@flowUUID': ' ',
                  downstreamProcess: {
                    '@id': 'missing-node',
                  },
                },
              },
            },
            {
              referenceToProcess: {
                '@refObjectId': 'proc-2',
                '@version': ' ',
              },
            },
          ],
        },
      },
    },
  };

  const jsonTg = __testInternals.deriveLifecyclemodelJsonTg(sparsePayload);
  assert.deepEqual(jsonTg.submodels, []);
  assert.deepEqual((jsonTg.xflow as Record<string, unknown>).nodes, [
    {
      id: 'node-1',
      x: 0,
      y: 0,
      width: 350,
      height: 120,
      data: {
        id: 'process-1',
        label: 'process-1',
        shortDescription: [],
      },
    },
    {
      id: 'node-2',
      x: 420,
      y: 0,
      width: 350,
      height: 120,
      data: {
        id: 'proc-2',
        label: 'proc-2',
        shortDescription: [],
      },
    },
  ]);
  assert.deepEqual((jsonTg.xflow as Record<string, unknown>).edges, [
    {
      id: 'node-1:missing-node:edge-1',
      source: {
        cell: 'node-1',
      },
      target: {
        cell: 'missing-node',
      },
      labels: [],
      data: {
        connection: {
          outputExchange: {
            downstreamProcess: {
              '@id': 'missing-node',
            },
          },
        },
        node: {
          sourceNodeID: 'node-1',
          targetNodeID: 'missing-node',
          sourceProcessId: 'process-1',
        },
      },
    },
  ]);
});

test('lifecyclemodel bundle token helpers cover empty inputs', () => {
  assert.equal(__testInternals.trimToken('  '), null);
  assert.equal(__testInternals.firstNonEmpty(undefined, ' ', '\n'), null);
});

test('syncLifecyclemodelBundleRecord creates lifecyclemodels through save_lifecycle_model_bundle', async () => {
  const observed: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = withSupabaseAuthBootstrap(async (url, init) => {
    observed.push({
      method: String(init?.method ?? 'GET'),
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (observed.length === 1) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return makeResponse({
      ok: true,
      status: 200,
      body: '{"ok":true,"modelId":"lm-1","version":"01.01.000"}',
    });
  });

  const result = await syncLifecyclemodelBundleRecord({
    id: 'lm-1',
    version: '01.01.000',
    payload: createLifecyclemodelPayload(),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl,
  });

  assert.equal(result.operation, 'create');
  assert.equal(result.mode, 'create');
  assert.equal(result.transport, 'save_lifecycle_model_bundle');
  assert.deepEqual(
    observed.map((item) => item.method),
    ['GET', 'POST'],
  );
  assert.match(observed[0]?.url ?? '', /\/rest\/v1\/lifecyclemodels\?select=id%2Cversion/u);
  assert.match(observed[1]?.url ?? '', /\/functions\/v1\/save_lifecycle_model_bundle$/u);
  assert.match(observed[1]?.body ?? '', /"mode":"create"/u);
  assert.match(observed[1]?.body ?? '', /"processMutations":\[\]/u);
  assert.match(observed[1]?.body ?? '', /"jsonTg"/u);
});

test('syncLifecyclemodelBundleRecord updates existing lifecyclemodels and retries after VERSION_CONFLICT', async () => {
  const updateObserved: Array<{ method: string; body?: string }> = [];
  const updateFetch = withSupabaseAuthBootstrap(async (_url, init) => {
    updateObserved.push({
      method: String(init?.method ?? 'GET'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (updateObserved.length === 1) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[{"id":"lm-1","version":"01.01.000"}]',
      });
    }

    return makeResponse({
      ok: true,
      status: 200,
      body: '{"ok":true,"modelId":"lm-1","version":"01.01.000"}',
    });
  });

  const updateResult = await syncLifecyclemodelBundleRecord({
    id: 'lm-1',
    version: '01.01.000',
    payload: createLifecyclemodelPayload(),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: updateFetch,
  });

  assert.equal(updateResult.operation, 'update');
  assert.match(updateObserved[1]?.body ?? '', /"mode":"update"/u);
  assert.match(updateObserved[1]?.body ?? '', /"version":"01.01.000"/u);

  const conflictObserved: Array<{ method: string; body?: string }> = [];
  const conflictFetch = withSupabaseAuthBootstrap(async (_url, init) => {
    conflictObserved.push({
      method: String(init?.method ?? 'GET'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (conflictObserved.length === 1) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    if (conflictObserved.length === 2) {
      return makeResponse({
        ok: false,
        status: 409,
        body: '{"code":"VERSION_CONFLICT","message":"duplicate version"}',
      });
    }

    if (conflictObserved.length === 3) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[{"id":"lm-1","version":"01.01.000"}]',
      });
    }

    return makeResponse({
      ok: true,
      status: 200,
      body: '{"ok":true,"modelId":"lm-1","version":"01.01.000"}',
    });
  });

  const conflictResult = await syncLifecyclemodelBundleRecord({
    id: 'lm-1',
    version: '01.01.000',
    payload: createLifecyclemodelPayload(),
    env: buildSupabaseTestEnv({
      TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/rest/v1',
      TIANGONG_LCA_ACCESS_TOKEN: 'key',
    }),
    fetchImpl: conflictFetch,
  });

  assert.equal(conflictResult.operation, 'update_after_create_conflict');
  assert.deepEqual(
    conflictObserved.map((item) => item.method),
    ['GET', 'POST', 'GET', 'POST'],
  );
  assert.match(conflictObserved[3]?.body ?? '', /"mode":"update"/u);
});

test('syncLifecyclemodelBundleRecord preserves structured errors and generic HTTP failures', async () => {
  const structuredFetch = withSupabaseAuthBootstrap(async (_url) => {
    if (_url.includes('/rest/v1/lifecyclemodels')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return makeResponse({
      ok: false,
      status: 400,
      body: '{"code":"FORBIDDEN","message":"not allowed","details":{"reason":"policy"}}',
    });
  });

  await assert.rejects(
    () =>
      syncLifecyclemodelBundleRecord({
        id: 'lm-1',
        version: '01.01.000',
        payload: createLifecyclemodelPayload(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: structuredFetch,
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'FORBIDDEN');
      assert.equal(error.message, 'not allowed');
      return true;
    },
  );

  const textErrorFetch = withSupabaseAuthBootstrap(async (_url) => {
    if (_url.includes('/rest/v1/lifecyclemodels')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return makeResponse({
      ok: false,
      status: 500,
      contentType: 'text/plain',
      body: 'boom',
    });
  });

  await assert.rejects(
    () =>
      syncLifecyclemodelBundleRecord({
        id: 'lm-1',
        version: '01.01.000',
        payload: createLifecyclemodelPayload(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: textErrorFetch,
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_REQUEST_FAILED');
      assert.match(error.message, /HTTP 500/u);
      return true;
    },
  );

  const conflictWithoutVisibleRowFetch = withSupabaseAuthBootstrap(async (_url) => {
    if (_url.includes('/rest/v1/lifecyclemodels')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return makeResponse({
      ok: false,
      status: 409,
      body: '{"code":"VERSION_CONFLICT","message":"duplicate version"}',
    });
  });

  await assert.rejects(
    () =>
      syncLifecyclemodelBundleRecord({
        id: 'lm-1',
        version: '01.01.000',
        payload: createLifecyclemodelPayload(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: conflictWithoutVisibleRowFetch,
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'VERSION_CONFLICT');
      return true;
    },
  );

  const invalidJsonFetch = withSupabaseAuthBootstrap(async (_url) => {
    if (_url.includes('/rest/v1/lifecyclemodels')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return makeResponse({
      ok: true,
      status: 200,
      body: '{',
    });
  });

  await assert.rejects(
    () =>
      syncLifecyclemodelBundleRecord({
        id: 'lm-1',
        version: '01.01.000',
        payload: createLifecyclemodelPayload(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: invalidJsonFetch,
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_INVALID_JSON');
      return true;
    },
  );

  const missingContentTypeFetch = withSupabaseAuthBootstrap(async (_url) => {
    if (_url.includes('/rest/v1/lifecyclemodels')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: '[]',
      });
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get(): string | null {
          return null;
        },
      },
      async text(): Promise<string> {
        return 'plain-text-payload';
      },
    };
  });

  await assert.rejects(
    () =>
      syncLifecyclemodelBundleRecord({
        id: 'lm-1',
        version: '01.01.000',
        payload: createLifecyclemodelPayload(),
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co',
          TIANGONG_LCA_ACCESS_TOKEN: 'key',
        }),
        fetchImpl: missingContentTypeFetch,
      }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'REMOTE_RESPONSE_INVALID');
      return true;
    },
  );
});

test('explicit generated roles retain their exact versions and reject input/duplicate conflicts', () => {
  const build = (submodels: unknown) =>
    __testInternals.buildLifecyclemodelBundlePlan({
      id: 'model',
      version: '06.00.000',
      payload: createLifecyclemodelPayload(),
      mode: 'update',
      metadata: { json_tg: { submodels } },
    });
  const members = ['primary', 'secondary', 'allocated'].map((type, index) => ({
    id: `result-${index}`,
    version: `00.00.00${index + 1}`,
    type,
    finalId: `flow-${index}`,
  }));
  assert.deepEqual(build(members).parent.jsonTg.submodels, members);
  assert.deepEqual(build([]).parent.jsonTg.submodels, []);
  const allocatedProvider = { id: 'proc-primary', version: '01.01.000', type: 'allocated' };
  assert.deepEqual(build([allocatedProvider]).parent.jsonTg.submodels, [allocatedProvider]);
  assert.deepEqual(
    build([{ id: 'proc-primary', version: '02.00.000', type: 'primary' }]).parent.jsonTg.submodels,
    [{ id: 'proc-primary', version: '02.00.000', type: 'primary' }],
  );
  for (const invalid of [
    null,
    {},
    [null],
    [{}],
    [{ id: 'result' }],
    [{ id: 'result', version: '01.00.000', type: 'input' }],
    [members[0], members[0]],
    [{ id: 'proc-primary', version: '01.01.000', type: 'primary' }],
  ]) {
    assert.throws(() => build(invalid), { code: 'LIFECYCLEMODEL_GENERATED_MEMBERS_INVALID' });
  }
});

test('invalid input references cannot manufacture generated memberships', () => {
  const payload = {
    lifeCycleModelInformation: {
      technology: { processes: { processInstance: [{ referenceToProcess: null }] } },
    },
  };
  const plan = __testInternals.buildLifecyclemodelBundlePlan({
    id: 'model',
    version: '06.00.000',
    mode: 'update',
    payload,
    metadata: { json_tg: { submodels: [] } },
  });
  assert.deepEqual(plan.parent.jsonTg.submodels, []);
});
