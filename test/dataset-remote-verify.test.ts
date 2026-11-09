import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  __testInternals as refreshInternals,
  runDatasetRemoteRefresh,
} from '../src/lib/dataset-remote-refresh.js';
import {
  __testInternals,
  runDatasetRemoteVerify,
  type RemoteDatasetLookup,
  type RemoteDatasetLookupRequest,
  type RemoteDatasetPayloadLookup,
  type RemoteVerificationCheck,
} from '../src/lib/dataset-remote-verify.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

function lookupFromMap(
  map: Record<string, RemoteDatasetLookup>,
  calls: RemoteDatasetLookupRequest[] = [],
) {
  return async (request: RemoteDatasetLookupRequest): Promise<RemoteDatasetLookup> => {
    calls.push(request);
    const key = `${request.table}:${request.id}:${request.version ?? ''}`;
    const value = map[key];
    if (!value) {
      throw new Error(`missing fixture lookup ${key}`);
    }
    return value;
  };
}

function lookup(exactVersion: string | null, latestVersion: string | null): RemoteDatasetLookup {
  return {
    exact: exactVersion ? { id: 'fixture', version: exactVersion } : null,
    latest: latestVersion ? { id: 'fixture', version: latestVersion } : null,
    exact_source_url: exactVersion ? `https://example.test/exact/${exactVersion}` : null,
    latest_source_url: latestVersion ? `https://example.test/latest/${latestVersion}` : null,
  };
}

function payloadLookup(
  payload: Record<string, unknown>,
  overrides: Partial<RemoteDatasetPayloadLookup> = {},
) {
  return {
    id: 'fixture',
    version: '01.00.000',
    user_id: 'target-user',
    state_code: 0,
    modified_at: '2026-05-23T00:00:00.000Z',
    payload,
    source_url: 'https://example.test/payload',
    ...overrides,
  } satisfies RemoteDatasetPayloadLookup;
}

function processRow() {
  return {
    id: 'proc-1',
    version: '01.00.000',
    json_ordered: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'proc-1',
            name: { baseName: [{ '@xml:lang': 'en', '#text': 'Blocked process' }] },
          },
        },
        exchanges: {
          exchange: [
            {
              referenceToFlowDataSet: {
                '@type': 'flow data set',
                '@refObjectId': 'flow-ok',
                '@version': '01.00.000',
                'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Reference flow' }],
              },
            },
            {
              referenceToUnknownDataSet: {
                '@type': 'unknown data set',
                '@refObjectId': 'unknown-ref',
                '@version': '01.00.000',
              },
            },
          ],
        },
        modellingAndValidation: {
          validation: {
            review: {
              'common:referenceToCompleteReviewReport': {
                '@type': 'source data set',
                '@refObjectId': 'source-old',
                '@version': '01.00.000',
              },
            },
          },
        },
        administrativeInformation: {
          publicationAndOwnership: {
            'common:dataSetVersion': '01.00.000',
          },
          dataEntryBy: {
            'common:referenceToPersonOrEntityEnteringTheData': {
              '@type': 'contact data set',
              '@refObjectId': 'contact-no-version',
            },
          },
        },
      },
    },
  };
}

function simpleProcessRow() {
  return {
    id: 'proc-remote',
    version: '01.00.000',
    json_ordered: {
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': 'proc-remote',
            name: 'Remote lookup process',
          },
        },
        exchanges: {
          exchange: {
            referenceToFlowDataSet: {
              '@type': 'flow data set',
              '@refObjectId': 'flow-remote',
              '@version': '01.00.000',
              'common:shortDescription': 'Remote flow',
            },
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

test('runDatasetRemoteVerify blocks missing, outdated, unversioned, and unsupported references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-'));
  const inputPath = path.join(dir, 'rows.json');
  const outDir = path.join(dir, 'out');
  const calls: RemoteDatasetLookupRequest[] = [];
  writeJson(inputPath, { rows: [processRow()] });

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      now: new Date('2026-05-23T00:00:00.000Z'),
      lookupDatasetImpl: lookupFromMap(
        {
          'processes:proc-1:01.00.000': lookup('01.00.000', '01.01.000'),
          'flows:flow-ok:01.00.000': lookup('01.00.000', '01.00.000'),
          'sources:source-old:01.00.000': lookup(null, '20.20.002'),
          'contacts:contact-no-version:': lookup(null, '01.00.000'),
        },
        calls,
      ),
    });

    assert.equal(report.status, 'blocked_remote_verification');
    assert.equal(report.counts.rows, 1);
    assert.equal(report.counts.references, 5);
    assert.equal(report.counts.blockers, 4);
    assert.equal(report.counts.by_status.ok, 1);
    assert.equal(report.counts.by_status.version_outdated, 1);
    assert.equal(report.counts.by_status.missing_version, 1);
    assert.equal(report.counts.by_status.version_missing, 1);
    assert.equal(report.counts.by_status.unsupported_type, 1);
    assert.equal(report.counts.by_table.processes, 1);
    assert.equal(report.counts.by_table.flows, 1);
    assert.equal(report.counts.by_table.sources, 1);
    assert.equal(report.counts.by_table.contacts, 1);
    assert.equal(calls.length, 4);
    assert.equal(existsSync(report.files.report), true);
    assert.deepEqual(readJson(report.files.report), report);

    const checks = readJsonl(report.files.checks) as Array<{ status: string; path: string }>;
    assert.deepEqual(checks.map((check) => check.status).sort(), [
      'missing_version',
      'ok',
      'unsupported_type',
      'version_missing',
      'version_outdated',
    ]);
    assert.ok(checks.some((check) => check.path.endsWith('referenceToFlowDataSet')));
    assert.equal(readJsonl(report.files.blockers).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify can use Supabase REST lookup with the default runtime path', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-rest-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  const urls: string[] = [];
  writeJsonl(inputPath, [simpleProcessRow()]);

  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    urls.push(url);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ accessToken: 'remote-verify-token' });
    }
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').at(-1);
    const requestedVersion = parsed.searchParams.get('version')?.replace(/^eq\./u, '') ?? null;
    const requestedId = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
    if (table === 'processes') {
      return jsonResponse([{ id: requestedId, version: requestedVersion ?? '01.00.000' }]);
    }
    if (table === 'flows') {
      return jsonResponse([{ id: requestedId, version: requestedVersion ?? '01.00.000' }]);
    }
    return jsonResponse([]);
  };

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
      }),
      fetchImpl,
      timeoutMs: 50,
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.root_policy, 'existing');
    assert.equal(report.counts.references, 2);
    assert.ok(urls.some((url) => url.includes('/auth/v1/user')));
    assert.ok(urls.some((url) => url.includes('/rest/v1/processes')));
    assert.ok(urls.some((url) => url.includes('/rest/v1/flows')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify can compare committed root payload, owner, and state', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-readback-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  const row = simpleProcessRow();
  writeJsonl(inputPath, [row]);

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      compareRootPayload: true,
      targetUserId: 'target-user',
      stateCode: 0,
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup('01.00.000', '01.00.000'),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
      lookupRootPayloadImpl: async () => payloadLookup(row.json_ordered),
      now: new Date('2026-05-23T00:00:00.000Z'),
    });

    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.counts.root_readback_checks, 1);
    assert.equal(report.counts.root_payload_mismatches, 0);
    const checks = readJsonl(report.files.checks) as RemoteVerificationCheck[];
    const readback = checks.find((check) => check.path.endsWith('#readback'));
    assert.equal(readback?.status, 'ok');
    assert.equal(readback?.remote_user_id, 'target-user');
    assert.equal(readback?.remote_state_code, 0);
    assert.equal(readback?.local_payload_sha256, readback?.remote_payload_sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify blocks post-commit root payload mismatches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-readback-mismatch-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  const row = simpleProcessRow();
  writeJsonl(inputPath, [row]);

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      compareRootPayload: true,
      targetUserId: 'target-user',
      stateCode: 0,
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup('01.00.000', '01.00.000'),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
      lookupRootPayloadImpl: async () =>
        payloadLookup({
          processDataSet: {
            processInformation: {
              dataSetInformation: {
                'common:UUID': 'proc-remote',
                name: 'Changed remote payload',
              },
            },
            administrativeInformation: {
              publicationAndOwnership: {
                'common:dataSetVersion': '01.00.000',
              },
            },
          },
        }),
    });

    assert.equal(report.status, 'blocked_remote_verification');
    assert.equal(report.counts.by_status.payload_mismatch, 1);
    assert.equal(report.counts.root_payload_mismatches, 1);
    assert.ok(report.blockers.some((blocker) => blocker.code === 'payload_mismatch'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify passes source roots and path-inferred flow UUID references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-pass-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'source-1',
      version: '20.20.002',
      json_ordered: {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: {
              'common:UUID': 'source-1',
              shortName: [{ '@xml:lang': 'en', '#text': 'Source one' }],
            },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '20.20.002' },
          },
        },
      },
    },
    {
      json_ordered: {
        lifeCycleModelDataSet: {
          lifeCycleModelInformation: {
            dataSetInformation: { 'common:UUID': 'lm-1' },
            technology: {
              processes: {
                processInstance: {
                  connections: {
                    outputExchange: {
                      '@flowUUID': 'flow-connection',
                      '@version': '01.00.000',
                    },
                  },
                },
              },
            },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    },
  ]);

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      now: new Date('2026-05-23T00:00:00.000Z'),
      lookupDatasetImpl: lookupFromMap({
        'sources:source-1:20.20.002': lookup('20.20.002', '20.20.002'),
        'lifecyclemodels:lm-1:01.00.000': lookup('01.00.000', '01.00.000'),
        'flows:flow-connection:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
    });

    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.counts.references, 3);
    assert.equal(report.counts.blockers, 0);
    assert.equal(report.counts.by_table.sources, 1);
    assert.equal(report.counts.by_table.lifecyclemodels, 1);
    assert.equal(report.counts.by_table.flows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify skips Foundry unresolvedTrace evidence references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-foundry-trace-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  const calls: RemoteDatasetLookupRequest[] = [];
  writeJsonl(inputPath, [
    {
      id: 'proc-with-trace',
      version: '01.00.000',
      json_ordered: {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              'common:UUID': 'proc-with-trace',
              name: { baseName: [{ '@xml:lang': 'en', '#text': 'Process with trace' }] },
              'common:other': {
                'tiangongfoundry:unresolvedTrace': [
                  {
                    action_item_code: 'elementary_flow_identity_manual_review',
                    evidence: {
                      target: {
                        '@refObjectId': 'trace-target-only',
                        '@version': '00.00.001',
                      },
                      top_candidates: [
                        {
                          '@refObjectId': 'trace-candidate-only',
                          '@version': '03.00.004',
                        },
                      ],
                    },
                  },
                ],
                'tiangongfoundry:unresolvedExchangeTrace': [
                  {
                    status: 'externalized_before_remote_write',
                    original_exchange: {
                      referenceToFlowDataSet: {
                        '@refObjectId': 'trace-exchange-only',
                        '@version': '01.00.000',
                      },
                    },
                  },
                ],
              },
            },
          },
          exchanges: {
            exchange: {
              referenceToFlowDataSet: {
                '@type': 'flow data set',
                '@refObjectId': 'flow-real',
                '@version': '01.00.000',
              },
            },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    },
  ]);

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      lookupDatasetImpl: lookupFromMap(
        {
          'processes:proc-with-trace:01.00.000': lookup('01.00.000', '01.00.000'),
          'flows:flow-real:01.00.000': lookup('01.00.000', '01.00.000'),
        },
        calls,
      ),
    });

    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.counts.references, 2);
    assert.equal(report.counts.by_status.unsupported_type, 0);
    assert.deepEqual(calls.map((call) => `${call.table}:${call.id}`).sort(), [
      'flows:flow-real',
      'processes:proc-with-trace',
    ]);
    const checks = readJsonl(report.files.checks) as Array<{ path: string }>;
    assert.equal(
      checks.some((check) => check.path.includes('unresolvedTrace')),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify allows new root candidates while verifying nested references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-candidate-'));
  const inputPath = path.join(dir, 'rows.json');
  const outDir = path.join(dir, 'out');
  writeJson(inputPath, { rows: [processRow()] });

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      rootPolicy: 'candidate',
      now: new Date('2026-05-23T00:00:00.000Z'),
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-1:01.00.000': lookup(null, null),
        'flows:flow-ok:01.00.000': lookup('01.00.000', '01.00.000'),
        'sources:source-old:01.00.000': lookup('01.00.000', '01.00.000'),
        'contacts:contact-no-version:': lookup(null, '01.00.000'),
      }),
    });

    assert.equal(report.status, 'blocked_remote_verification');
    assert.equal(report.counts.by_status.ok, 3);
    assert.equal(report.counts.by_status.version_missing, 1);
    assert.ok(report.blockers.every((blocker) => blocker.role === 'reference'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify blocks stale root candidates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-stale-root-'));
  const inputPath = path.join(dir, 'rows.json');
  const outDir = path.join(dir, 'out');
  writeJson(inputPath, { rows: [processRow()] });

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      rootPolicy: 'candidate',
      now: new Date('2026-05-23T00:00:00.000Z'),
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-1:01.00.000': lookup(null, '01.01.000'),
        'flows:flow-ok:01.00.000': lookup('01.00.000', '01.00.000'),
        'sources:source-old:01.00.000': lookup('01.00.000', '01.00.000'),
        'contacts:contact-no-version:': lookup(null, '01.00.000'),
      }),
    });

    assert.equal(report.counts.by_status.version_outdated, 1);
    assert.ok(report.blockers.some((blocker) => blocker.role === 'root'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify distinguishes candidate version bumps, stale exact roots, and missing references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-candidate-branches-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [simpleProcessRow()]);

  try {
    const versionBump = await runDatasetRemoteVerify({
      inputPath,
      outDir: path.join(outDir, 'version-bump'),
      rootPolicy: 'candidate',
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup(null, '00.99.999'),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
    });
    assert.equal(versionBump.status, 'passed_remote_verification');

    const missingCandidateVersion = await runDatasetRemoteVerify({
      inputPath,
      outDir: path.join(outDir, 'missing-candidate-version'),
      rootPolicy: 'candidate',
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup(null, '01.00.000'),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
    });
    assert.equal(missingCandidateVersion.counts.by_status.missing_version, 1);
    assert.ok(missingCandidateVersion.blockers.some((blocker) => blocker.role === 'root'));

    const staleExact = await runDatasetRemoteVerify({
      inputPath,
      outDir: path.join(outDir, 'stale-exact'),
      rootPolicy: 'candidate',
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup('01.00.000', '01.01.000'),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
    });
    assert.equal(staleExact.counts.by_status.version_outdated, 1);
    assert.ok(staleExact.blockers.some((blocker) => blocker.role === 'root'));

    const missingReference = await runDatasetRemoteVerify({
      inputPath,
      outDir: path.join(outDir, 'missing-reference'),
      rootPolicy: 'candidate',
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup('01.00.000', '01.00.000'),
        'flows:flow-remote:01.00.000': lookup(null, null),
      }),
    });
    assert.equal(missingReference.counts.by_status.missing_dataset, 1);
    assert.ok(missingReference.blockers.some((blocker) => blocker.code === 'missing_dataset'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify skips prewrite root readback for new candidates', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-candidate-readback-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [simpleProcessRow()]);
  const rootPayloadCalls: RemoteDatasetLookupRequest[] = [];

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      rootPolicy: 'candidate',
      targetUserId: 'target-user',
      stateCode: 0,
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup(null, null),
        'flows:flow-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
      lookupRootPayloadImpl: async (request) => {
        rootPayloadCalls.push(request);
        return null;
      },
    });

    assert.equal(report.status, 'passed_remote_verification');
    assert.equal(report.counts.root_readback_checks, 0);
    assert.equal(report.counts.by_status.ok, 2);
    assert.equal(report.blockers.length, 0);
    assert.equal(rootPayloadCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify reports unsupported references without type hints', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-unknown-label-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [
    {
      id: 'proc-remote',
      version: '01.00.000',
      json_ordered: {
        processDataSet: {
          processInformation: {
            dataSetInformation: { 'common:UUID': 'proc-remote' },
          },
          exchanges: {
            exchange: {
              referenceWithoutTypeHint: {
                '@refObjectId': 'unknown-no-type',
                '@version': '01.00.000',
              },
            },
          },
          administrativeInformation: {
            publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
          },
        },
      },
    },
    { json_ordered: { flowDataSet: { flowInformation: {} } } },
  ]);

  try {
    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir,
      lookupDatasetImpl: lookupFromMap({
        'processes:proc-remote:01.00.000': lookup('01.00.000', '01.00.000'),
      }),
    });
    assert.equal(report.counts.by_status.unsupported_type, 2);
    assert.ok(report.blockers.some((blocker) => /unknown:unknown-no-type/u.test(blocker.message)));
    assert.ok(report.blockers.some((blocker) => /flows:-@-/u.test(blocker.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteVerify reports lookup failures and validates required flags', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-errors-'));
  const inputPath = path.join(dir, 'rows.json');
  writeJson(inputPath, { rows: [processRow()] });

  try {
    await assert.rejects(
      () =>
        runDatasetRemoteVerify({
          inputPath: '',
          outDir: path.join(dir, 'out'),
          lookupDatasetImpl: lookupFromMap({}),
        }),
      /Missing required --input value/u,
    );
    await assert.rejects(
      () =>
        runDatasetRemoteVerify({
          inputPath,
          outDir: '',
          lookupDatasetImpl: lookupFromMap({}),
        }),
      /Missing required --out-dir value/u,
    );

    const report = await runDatasetRemoteVerify({
      inputPath,
      outDir: path.join(dir, 'out'),
      lookupDatasetImpl: async (request) => {
        if (request.table === 'processes') {
          throw new Error('network unavailable');
        }
        return lookup(request.version, request.version);
      },
    });
    assert.equal(report.counts.by_status.lookup_failed, 1);
    assert.ok(report.blockers.some((blocker) => blocker.code === 'lookup_failed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset remote verify internals normalize table, versions, and REST lookup helpers', async () => {
  assert.equal(__testInternals.tableFromType('Flow Property Data Set'), 'flowproperties');
  assert.equal(__testInternals.tableFromType(null), null);
  assert.equal(__testInternals.tableFromType('unknown data set'), null);
  assert.equal(__testInternals.tableFromPath(''), null);
  assert.equal(__testInternals.tableFromPath('/a/common:referenceToDataSetFormat'), 'sources');
  assert.equal(__testInternals.tableFromPath('/a/notAReference'), null);
  assert.equal(
    __testInternals.isFoundryTracePath(
      '/processDataSet/processInformation/dataSetInformation/common:other/tiangongfoundry:unresolvedTrace/0/evidence/top_candidates/0',
    ),
    true,
  );
  assert.equal(
    __testInternals.isFoundryTracePath(
      '/processDataSet/processInformation/dataSetInformation/common:other/tiangongfoundry:unresolvedExchangeTrace/0/original_exchange/referenceToFlowDataSet',
    ),
    true,
  );
  assert.equal(
    __testInternals.isFoundryTracePath(
      '/processDataSet/processInformation/dataSetInformation/common:other/referenceToDataSource',
    ),
    false,
  );
  assert.equal(__testInternals.compareVersions(null, null), 0);
  assert.equal(__testInternals.compareVersions('01.02.000', '01.01.999'), 1);
  assert.equal(__testInternals.compareVersions('01.00.000', '01.00.000'), 0);
  assert.equal(__testInternals.compareVersions(null, '01.00.000'), -1);
  assert.equal(__testInternals.compareVersions('01.00.000', null), 1);
  assert.equal(__testInternals.compareVersions('beta', 'alpha'), 1);
  assert.equal(__testInternals.compareVersions('alpha', 'beta'), -1);
  assert.equal(__testInternals.compareVersions('01', '01.00.001'), -1);
  assert.equal(__testInternals.compareVersions('01.00.001', '01'), 1);
  assert.equal(__testInternals.shortDescription({ '#text': 42 }), '42');
  assert.equal(__testInternals.shortDescription('Text'), 'Text');
  assert.equal(__testInternals.shortDescription([]), null);
  assert.equal(__testInternals.shortDescription([{ value: 'Nested' }]), 'Nested');
  assert.deepEqual(__testInternals.normalizeRows('not rows'), []);
  assert.deepEqual(__testInternals.normalizeRows([{ id: '' }, { id: 'row-1', version: '1' }]), [
    { id: 'row-1', version: '1' },
  ]);
  assert.equal(
    __testInternals.buildRemoteUrl('https://example.supabase.co/rest/v1/', 'flows', 'flow-1', null),
    'https://example.supabase.co/rest/v1/flows?id=eq.flow-1&order=version.desc&limit=1',
  );

  const lookupResult = await __testInternals.lookupRemoteDataset({
    runtime: {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'access-token',
    },
    fetchImpl: async () => jsonResponse([{ id: 'flow-1', version: '01.00.000' }]),
    timeoutMs: 50,
    request: { table: 'flows', id: 'flow-1', version: null },
  });
  assert.equal(lookupResult.exact, null);
  assert.equal(lookupResult.latest?.version, '01.00.000');

  const missingLatest = await __testInternals.lookupRemoteDataset({
    runtime: {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'sb-publishable-key',
      getAccessToken: async () => 'access-token',
    },
    fetchImpl: async () => jsonResponse([]),
    timeoutMs: 50,
    request: { table: 'flows', id: 'missing-flow', version: '01.00.000' },
  });
  assert.equal(missingLatest.latest, null);
});

test('dataset remote verify internals handle root payload lookup and readback checks', async () => {
  assert.match(
    __testInternals.buildRemotePayloadUrl(
      'https://example.supabase.co/rest/v1/',
      'flows',
      'flow-1',
      '01.00.000',
    ),
    /select=id%2Cversion%2Cuser_id%2Cstate_code%2Cmodified_at%2Cjson%2Cjson_ordered/u,
  );
  assert.equal(__testInternals.normalizePayloadRow(null), null);
  assert.deepEqual(
    __testInternals.normalizePayloadRow({
      id: ' flow-1 ',
      version: ' 01.00.000 ',
      user_id: ' user-1 ',
      state_code: '0',
      modified_at: ' now ',
      json: { fallback: true },
    }),
    {
      id: 'flow-1',
      version: '01.00.000',
      user_id: 'user-1',
      state_code: null,
      modified_at: 'now',
      payload: { fallback: true },
      source_url: null,
    },
  );
  assert.equal(
    await __testInternals.lookupRemoteDatasetPayload({
      runtime: {} as never,
      fetchImpl: async () => jsonResponse([]),
      timeoutMs: 1000,
      request: { table: 'flows', id: 'flow-1', version: null },
    }),
    null,
  );

  const lookupPayload = await __testInternals.lookupRemoteDatasetPayload({
    runtime: {
      apiBaseUrl: 'https://example.supabase.co/functions/v1',
      publishableKey: 'anon-key',
      getAccessToken: async () => 'access-token',
    },
    fetchImpl: async (input) => {
      assert.match(String(input), /\/rest\/v1\/flows/u);
      return jsonResponse([
        {
          id: 'flow-1',
          version: '01.00.000',
          user_id: 'user-1',
          state_code: 0,
          modified_at: '2026-06-04T00:00:00.000Z',
          json_ordered: { b: 2, a: 1 },
        },
      ]);
    },
    timeoutMs: 1000,
    request: { table: 'flows', id: 'flow-1', version: '01.00.000' },
  });
  assert.equal(lookupPayload?.id, 'flow-1');
  assert.equal(lookupPayload?.source_url?.includes('/rest/v1/flows'), true);
  assert.equal(
    __testInternals.sha256Json({ b: 2, a: 1 }),
    __testInternals.sha256Json({ a: 1, b: 2 }),
  );

  const reference = {
    row_index: 0,
    role: 'root',
    table: 'flows',
    type: 'flow data set',
    id: 'flow-1',
    version: '01.00.000',
    path: '/',
    short_description: null,
  } satisfies Parameters<typeof __testInternals.rootReadbackChecks>[0]['reference'];
  const missingChecks = __testInternals.rootReadbackChecks({
    reference,
    localPayload: { a: 1 },
    remote: null,
    compareRootPayload: true,
    targetUserId: null,
    stateCode: null,
  });
  assert.equal(missingChecks[0]?.status, 'missing_dataset');
  const mismatchChecks = __testInternals.rootReadbackChecks({
    reference,
    localPayload: { a: 1 },
    remote: {
      id: 'flow-1',
      version: '01.00.000',
      user_id: 'other-user',
      state_code: 1,
      modified_at: '2026-06-04T00:00:00.000Z',
      payload: { a: 2 },
      source_url: 'https://example.test/flows',
    },
    compareRootPayload: true,
    targetUserId: 'user-1',
    stateCode: 0,
  });
  assert.deepEqual(
    mismatchChecks.map((check) => check.status),
    ['owner_mismatch', 'state_code_mismatch', 'payload_mismatch'],
  );
  const missingPayloadChecks = __testInternals.rootReadbackChecks({
    reference,
    localPayload: { a: 1 },
    remote: {
      id: 'flow-1',
      version: '01.00.000',
      user_id: 'user-1',
      state_code: 0,
      modified_at: null,
      payload: null,
      source_url: null,
    },
    compareRootPayload: true,
    targetUserId: null,
    stateCode: null,
  });
  assert.equal(missingPayloadChecks[0]?.status, 'remote_payload_missing');
  assert.equal(
    __testInternals.makeRootReadbackCheck(reference, 'lookup_failed', 'failed', null).path,
    '/#readback',
  );
});

test('dataset remote verify internals collect fallback roots and escaped pointers', () => {
  const refs = __testInternals.collectRemoteReferences([
    { json_ordered: { unsupportedRoot: { value: true } } },
    { json_ordered: { flowDataSet: { flowInformation: 'bad information' } } },
    { json_ordered: { flowDataSet: { flowInformation: {} } } },
    {
      json_ordered: {
        flowDataSet: {
          flowInformation: {
            dataSetInformation: {
              'common:UUID': 'flow-fallback',
              shortName: [{ '#text': 'Fallback flow' }],
              nested: {
                'key/with~escape': {
                  '@type': 'source data set',
                  '@refObjectId': 'source-escaped',
                  '@version': '00.00.001',
                },
              },
            },
          },
        },
      },
    },
    {
      json_ordered: {
        flowPropertyDataSet: {
          flowPropertiesInformation: {
            dataSetInformation: {
              'common:UUID': 'flow-property-root',
              name: { '@xml:lang': 'en', '#text': 'Mass' },
            },
          },
          administrativeInformation: {
            publicationAndOwnership: {
              'common:dataSetVersion': '00.00.001',
            },
          },
        },
      },
    },
  ]);

  assert.ok(refs.some((ref) => ref.role === 'root' && ref.id === 'flow-fallback'));
  assert.ok(
    refs.some(
      (ref) =>
        ref.role === 'root' &&
        ref.table === 'flowproperties' &&
        ref.id === 'flow-property-root' &&
        ref.version === '00.00.001',
    ),
  );
  assert.ok(refs.some((ref) => ref.path.includes('key~1with~0escape')));
});

test('runDatasetRemoteRefresh patches latest reachable reference versions and re-verifies', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-refresh-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outPath = path.join(dir, 'refreshed.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [processRow()]);
  let runCount = 0;

  try {
    const report = await runDatasetRemoteRefresh({
      inputPath,
      outPath,
      outDir,
      rootPolicy: 'candidate',
      now: new Date('2026-05-23T00:00:00.000Z'),
      runDatasetRemoteVerifyImpl: async (options) => {
        runCount += 1;
        assert.equal(options.rootPolicy, 'candidate');
        const isPre = options.outDir.includes('pre-refresh-verify');
        const checks: RemoteVerificationCheck[] = isPre
          ? [
              {
                row_index: 0,
                role: 'reference',
                table: 'flows',
                type: 'flow data set',
                id: 'flow-ok',
                version: '01.00.000',
                path: '/processDataSet/exchanges/exchange/0/referenceToFlowDataSet',
                short_description: 'Reference flow',
                status: 'version_outdated',
                exact_version: '01.00.000',
                latest_version: '01.00.002',
                exact_source_url: 'https://example.test/exact',
                latest_source_url: 'https://example.test/latest',
                message: 'old flow version',
              },
              {
                row_index: 0,
                role: 'reference',
                table: 'contacts',
                type: 'contact data set',
                id: 'contact-no-version',
                version: null,
                path: '/processDataSet/administrativeInformation/dataEntryBy/common:referenceToPersonOrEntityEnteringTheData',
                short_description: null,
                status: 'version_missing',
                exact_version: null,
                latest_version: '01.00.001',
                exact_source_url: null,
                latest_source_url: 'https://example.test/latest-contact',
                message: 'missing contact version',
              },
            ]
          : [];
        writeJsonl(path.join(options.outDir, 'outputs', 'remote-verification.jsonl'), checks);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          status: isPre ? 'blocked_remote_verification' : 'passed_remote_verification',
          root_policy: options.rootPolicy ?? 'existing',
          input_path: options.inputPath,
          out_dir: options.outDir,
          counts: {
            rows: 1,
            references: checks.length,
            checked: checks.length,
            blockers: checks.length,
            by_status: {
              ok: 0,
              lookup_failed: 0,
              missing_dataset: 0,
              missing_version: 0,
              unsupported_type: 0,
              version_missing: isPre ? 1 : 0,
              version_outdated: isPre ? 1 : 0,
            },
            by_table: {
              contacts: isPre ? 1 : 0,
              flowproperties: 0,
              flows: isPre ? 1 : 0,
              lciamethods: 0,
              lifecyclemodels: 0,
              processes: 0,
              sources: 0,
              unitgroups: 0,
            },
          },
          blockers: isPre
            ? checks.map((check) => ({
                code: check.status,
                severity: 'error',
                message: check.message,
                row_index: check.row_index,
                role: check.role,
                table: check.table,
                id: check.id,
                version: check.version,
                latest_version: check.latest_version,
                path: check.path,
              }))
            : [],
          files: {
            report: path.join(options.outDir, 'outputs', 'remote-verification-report.json'),
            checks: path.join(options.outDir, 'outputs', 'remote-verification.jsonl'),
            blockers: path.join(options.outDir, 'outputs', 'blockers.jsonl'),
          },
        };
      },
    });

    assert.equal(runCount, 2);
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.patched_references, 2);
    assert.equal(readJsonl(report.files.patches).length, 2);
    const patchedRows = readJsonl(outPath) as Array<{ json_ordered: Record<string, unknown> }>;
    const processDataSet = patchedRows[0]?.json_ordered.processDataSet as Record<string, unknown>;
    const exchanges = (processDataSet.exchanges as Record<string, unknown>).exchange as Array<
      Record<string, unknown>
    >;
    assert.equal(
      (exchanges[0]?.referenceToFlowDataSet as Record<string, unknown>)['@version'],
      '01.00.002',
    );
    assert.equal(
      (
        (
          (processDataSet.administrativeInformation as Record<string, unknown>)
            .dataEntryBy as Record<string, unknown>
        )['common:referenceToPersonOrEntityEnteringTheData'] as Record<string, unknown>
      )['@version'],
      '01.00.001',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteRefresh can use the default remote verifier and process env runtime', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-refresh-default-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outPath = path.join(dir, 'refreshed.jsonl');
  const outDir = path.join(dir, 'out');
  const env = buildSupabaseTestEnv({
    TIANGONG_LCA_DISABLE_SESSION_CACHE: '1',
  });
  const originalEnv = {
    TIANGONG_LCA_API_BASE_URL: process.env.TIANGONG_LCA_API_BASE_URL,
    TIANGONG_LCA_ACCESS_TOKEN: process.env.TIANGONG_LCA_ACCESS_TOKEN,
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
    TIANGONG_LCA_DISABLE_SESSION_CACHE: process.env.TIANGONG_LCA_DISABLE_SESSION_CACHE,
  };
  writeJsonl(inputPath, [simpleProcessRow()]);

  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ accessToken: 'remote-refresh-token' });
    }
    const parsed = new URL(url);
    const requestedId = parsed.searchParams.get('id')?.replace(/^eq\./u, '') ?? '';
    const requestedVersion = parsed.searchParams.get('version')?.replace(/^eq\./u, '') ?? null;
    return jsonResponse([{ id: requestedId, version: requestedVersion ?? '01.00.000' }]);
  };

  try {
    process.env.TIANGONG_LCA_API_BASE_URL = env.TIANGONG_LCA_API_BASE_URL;
    process.env.TIANGONG_LCA_ACCESS_TOKEN = env.TIANGONG_LCA_ACCESS_TOKEN;
    process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
    process.env.TIANGONG_LCA_DISABLE_SESSION_CACHE = env.TIANGONG_LCA_DISABLE_SESSION_CACHE;

    const report = await runDatasetRemoteRefresh({
      inputPath,
      outPath,
      outDir,
      fetchImpl,
      timeoutMs: 50,
      now: new Date('2026-05-23T00:00:00.000Z'),
    });
    assert.equal(report.status, 'completed');
    assert.equal(report.root_policy, 'existing');
    assert.equal(report.counts.patched_references, 0);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetRemoteRefresh validates required flags and skips unpatchable checks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-remote-refresh-branches-'));
  const inputPath = path.join(dir, 'rows.jsonl');
  const outPath = path.join(dir, 'refreshed.jsonl');
  const outDir = path.join(dir, 'out');
  writeJsonl(inputPath, [processRow()]);

  try {
    await assert.rejects(
      () =>
        runDatasetRemoteRefresh({
          inputPath: '',
          outPath,
          outDir,
          runDatasetRemoteVerifyImpl: async () => {
            throw new Error('not called');
          },
        }),
      /Missing required --input value/u,
    );
    await assert.rejects(
      () =>
        runDatasetRemoteRefresh({
          inputPath,
          outPath: '',
          outDir,
          runDatasetRemoteVerifyImpl: async () => {
            throw new Error('not called');
          },
        }),
      /Missing required --out value/u,
    );
    await assert.rejects(
      () =>
        runDatasetRemoteRefresh({
          inputPath,
          outPath,
          outDir: '',
          runDatasetRemoteVerifyImpl: async () => {
            throw new Error('not called');
          },
        }),
      /Missing required --out-dir value/u,
    );

    const report = await runDatasetRemoteRefresh({
      inputPath,
      outPath,
      outDir,
      now: new Date('2026-05-23T00:00:00.000Z'),
      runDatasetRemoteVerifyImpl: async (options) => {
        const isPre = options.outDir.includes('pre-refresh-verify');
        const checks: RemoteVerificationCheck[] = isPre
          ? [
              {
                row_index: 9,
                role: 'reference',
                table: 'flows',
                type: 'flow data set',
                id: 'missing-row',
                version: '01.00.000',
                path: '/missing',
                short_description: null,
                status: 'version_outdated',
                exact_version: '01.00.000',
                latest_version: '01.00.001',
                exact_source_url: null,
                latest_source_url: null,
                message: 'missing row',
              },
              {
                row_index: 0,
                role: 'reference',
                table: 'flows',
                type: 'flow data set',
                id: 'missing-node',
                version: '01.00.000',
                path: '/processDataSet/exchanges/exchange/9/referenceToFlowDataSet',
                short_description: null,
                status: 'version_outdated',
                exact_version: '01.00.000',
                latest_version: '01.00.001',
                exact_source_url: null,
                latest_source_url: null,
                message: 'missing node',
              },
              {
                row_index: 0,
                role: 'reference',
                table: 'flows',
                type: 'flow data set',
                id: 'same-version',
                version: '01.00.000',
                path: '/processDataSet/exchanges/exchange/0/referenceToFlowDataSet',
                short_description: null,
                status: 'version_outdated',
                exact_version: '01.00.000',
                latest_version: '01.00.000',
                exact_source_url: null,
                latest_source_url: null,
                message: 'same version',
              },
            ]
          : [];
        writeJsonl(path.join(options.outDir, 'outputs', 'remote-verification.jsonl'), checks);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          status: isPre ? 'blocked_remote_verification' : 'blocked_remote_verification',
          root_policy: options.rootPolicy ?? 'existing',
          input_path: options.inputPath,
          out_dir: options.outDir,
          counts: {
            rows: 1,
            references: checks.length,
            checked: checks.length,
            blockers: isPre ? checks.length : 1,
            by_status: {
              ok: 0,
              lookup_failed: 0,
              missing_dataset: 0,
              missing_version: 0,
              unsupported_type: 0,
              version_missing: 0,
              version_outdated: checks.length,
            },
            by_table: {
              contacts: 0,
              flowproperties: 0,
              flows: checks.length,
              lciamethods: 0,
              lifecyclemodels: 0,
              processes: 0,
              sources: 0,
              unitgroups: 0,
            },
          },
          blockers: isPre
            ? checks.map((check) => ({
                code: check.status,
                severity: 'error',
                message: check.message,
                row_index: check.row_index,
                role: check.role,
                table: check.table,
                id: check.id,
                version: check.version,
                latest_version: check.latest_version,
                path: check.path,
              }))
            : [
                {
                  code: 'missing_dataset',
                  severity: 'error',
                  message: 'remaining blocker',
                  row_index: 0,
                  role: 'reference',
                  table: 'flows',
                  id: 'remaining',
                  version: '01.00.000',
                  latest_version: null,
                  path: '/remaining',
                },
              ],
          files: {
            report: path.join(options.outDir, 'outputs', 'remote-verification-report.json'),
            checks: path.join(options.outDir, 'outputs', 'remote-verification.jsonl'),
            blockers: path.join(options.outDir, 'outputs', 'blockers.jsonl'),
          },
        };
      },
    });

    assert.equal(report.status, 'completed_with_blockers');
    assert.equal(report.root_policy, 'existing');
    assert.equal(report.counts.refreshable_references, 3);
    assert.equal(report.counts.patched_references, 0);
    const flowUuidPatch = refreshInternals.applyRemoteRefreshPatches(
      [{ json_ordered: { model: { link: { '@flowUUID': 'flow-1', '@version': '01.00.000' } } } }],
      [
        {
          row_index: 0,
          role: 'reference',
          table: 'flows',
          type: 'flow data set',
          id: 'flow-1',
          version: '01.00.000',
          path: '/model/link/@flowUUID',
          short_description: null,
          status: 'version_outdated',
          exact_version: '01.00.000',
          latest_version: '01.00.001',
          exact_source_url: null,
          latest_source_url: null,
          message: 'flow uuid',
        },
      ],
    );
    assert.equal(
      (
        (flowUuidPatch.rows[0]?.json_ordered as Record<string, unknown>).model as Record<
          string,
          unknown
        >
      ).link &&
        (
          (
            (flowUuidPatch.rows[0]?.json_ordered as Record<string, unknown>).model as Record<
              string,
              unknown
            >
          ).link as Record<string, unknown>
        )['@version'],
      '01.00.001',
    );
    assert.equal(
      refreshInternals.applyRemoteRefreshPatches(
        [{ json_ordered: { model: { link: 'not a reference object' } } }],
        [
          {
            row_index: 0,
            role: 'reference',
            table: 'flows',
            type: 'flow data set',
            id: 'flow-1',
            version: '01.00.000',
            path: '/model/link/@flowUUID',
            short_description: null,
            status: 'version_outdated',
            exact_version: '01.00.000',
            latest_version: '01.00.001',
            exact_source_url: null,
            latest_source_url: null,
            message: 'flow uuid',
          },
        ],
      ).patches.length,
      0,
    );
    assert.equal(refreshInternals.valueAtPointer({ a: ['x'] }, '/a/not-number'), undefined);
    assert.equal(refreshInternals.valueAtPointer('leaf', '/a'), undefined);
    assert.deepEqual(refreshInternals.pointerSegments('/a~1b/c~0d'), ['a/b', 'c~d']);
    assert.equal(
      refreshInternals.refreshableCheck({
        row_index: 0,
        role: 'root',
        table: 'flows',
        type: 'flow data set',
        id: 'root',
        version: '01.00.000',
        path: '/',
        short_description: null,
        status: 'version_outdated',
        exact_version: '01.00.000',
        latest_version: '01.00.001',
        exact_source_url: null,
        latest_source_url: null,
        message: 'root',
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
