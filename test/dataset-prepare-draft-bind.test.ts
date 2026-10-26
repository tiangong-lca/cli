import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { FlowSchema } from '@tiangong-lca/tidas-sdk';
import { allocationFixture } from './helpers/process-allocation-fixture.js';
import {
  analyzeProcessPayloadSemantics,
  semanticContextFromInput,
} from '../src/lib/process-semantic-validation.js';
import { readJsonArtifact } from '../src/lib/artifacts.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import { runDatasetPatchApply } from '../src/lib/dataset-patch.js';
import {
  runDatasetBindPreparedProposal,
  type RunDatasetBindPreparedProposalOptions,
} from '../src/lib/dataset-prepare-draft-bind.js';
import {
  PREPARE_IDENTITIES,
  createdPreparePayload,
  parsePrepareEnvelope,
  prepareCanonicalUri,
  type PrepareJson,
  type PrepareResult,
  type PrepareTable,
} from '../src/lib/dataset-prepare-draft-contract.js';

const ID = '12345678-1234-7abc-0123-123456789abc';
const ACTOR = 'aaaaaaaa-aaaa-aaaa-0000-aaaaaaaaaaaa';
const REQUEST = 'bbbbbbbb-bbbb-bbbb-1111-bbbbbbbbbbbb';
const SOURCE = '03.02.007';
const TARGET = '03.02.008';
const VERSION = 'common:dataSetVersion';
const URI = 'common:permanentDataSetURI';
const PRECEDING = 'common:referenceToPrecedingDataSetVersion';
function pub(body: PrepareJson, table: PrepareTable = 'processes'): PrepareJson {
  return (
    (body[PREPARE_IDENTITIES[table].root] as PrepareJson).administrativeInformation as PrepareJson
  ).publicationAndOwnership as PrepareJson;
}
function payload(table: PrepareTable): PrepareJson {
  const config = PREPARE_IDENTITIES[table];
  return {
    [config.root]: {
      [config.information]: { dataSetInformation: { 'common:UUID': ID } },
      administrativeInformation: {
        publicationAndOwnership: {
          [VERSION]: SOURCE,
          [URI]: prepareCanonicalUri(table, ID, SOURCE),
        },
      },
      scientificExample: {
        quantity: '12',
        unit: 'kg',
        nested: [{ text: 'preserve literal scientific text' }],
      },
      ...(table === 'flows'
        ? { modellingAndValidation: { LCIMethod: { typeOfDataSet: 'Product flow' } } }
        : {}),
    },
  };
}
function reference(table: PrepareTable): PrepareJson {
  return {
    '@type': PREPARE_IDENTITIES[table].referenceType,
    '@refObjectId': ID,
    '@version': SOURCE,
    '@uri': prepareCanonicalUri(table, ID, SOURCE),
    'common:shortDescription': { '@xml:lang': 'en', '#text': 'Reviewed synthetic public baseline' },
  };
}
function fixture(table: PrepareTable = 'processes', observed = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-prepared-proposal-bind-'));
  const source = payload(table);
  const request = parsePrepareEnvelope({
    schema_version: 'dataset-prepare-draft-request.v1',
    project_ref: 'synthetic-project',
    requestId: REQUEST,
    request: {
      table,
      id: ID,
      expectedActorId: ACTOR,
      source: { version: SOURCE, userId: ACTOR, stateCode: 100, jsonOrdered: source },
      expectedDrafts: [],
    },
  });
  const before = createdPreparePayload(request.request, TARGET);
  if (observed) request.request.expectedDrafts = [{ version: TARGET, jsonOrdered: before }];
  const target = { version: TARGET, userId: ACTOR, stateCode: 0, jsonOrdered: before };
  const receipt: PrepareResult = {
    requestId: REQUEST,
    table,
    id: ID,
    actorId: ACTOR,
    outcome: 'created',
    version: TARGET,
    sourceVersion: SOURCE,
    draftVersions: [TARGET],
    selectedDraft: target,
    replayed: false,
  };
  const report: PrepareJson = {
    schema_version: 'dataset-prepare-draft-report.v1',
    status: observed ? 'selected' : 'prepared',
    mode: observed ? 'read_only' : 'commit',
    save_ready: false,
    reviews: [],
    review_completeness: { complete: true, exact_total: 0, rows_fetched: 0 },
    request,
    request_sha256: sha256Json(request),
    attempt_consumed: !observed,
    mutation_dispatches: observed ? 0 : 1,
    target,
    ...(observed
      ? { completeness: { complete: true, exact_total: 1, rows_fetched: 1 } }
      : { receipt }),
  };
  const proposal = structuredClone(source);
  (proposal[PREPARE_IDENTITIES[table].root] as PrepareJson).scientificExample = {
    quantity: '13.5',
    unit: 'kg',
    nested: [{ text: 'preserve literal scientific text' }],
  };
  const predecessor = reference(table);
  const options: RunDatasetBindPreparedProposalOptions = {
    inputPath: path.join(dir, 'proposal.json'),
    proposalSha256: sha256Json(proposal),
    sourceSha256: sha256Json(source),
    preparationReportPath: path.join(dir, 'preparation.json'),
    predecessorFile: path.join(dir, 'predecessor.json'),
    predecessorSha256: sha256Json(predecessor),
    outDir: path.join(dir, 'bound'),
  };
  const freeze = () => {
    writeFileSync(options.inputPath, JSON.stringify(proposal));
    writeFileSync(options.preparationReportPath, JSON.stringify(report));
    if (options.predecessorFile)
      writeFileSync(options.predecessorFile, JSON.stringify(predecessor));
    options.proposalSha256 = sha256Json(proposal);
    options.sourceSha256 = sha256Json(source);
    options.predecessorSha256 = options.predecessorFile ? sha256Json(predecessor) : undefined;
  };
  freeze();
  return {
    dir,
    source,
    proposal,
    predecessor,
    report,
    request,
    before,
    target,
    receipt,
    options,
    freeze,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function json(file: string): PrepareJson {
  return readJsonArtifact(file) as PrepareJson;
}

function utf8Fixture() {
  const f = fixture();
  const text = 'café 🔬 \uFFFD';
  (f.proposal.processDataSet as PrepareJson).scientificExample = { text };
  (f.predecessor['common:shortDescription'] as PrepareJson)['#text'] = text;
  f.report.synthetic_utf8_probe = text;
  f.freeze();
  const context = {
    candidate_sha256: f.options.proposalSha256,
    flow_documents: allocationFixture().context.flow_documents,
  };
  const root = context.flow_documents[0]!.flowDataSet as PrepareJson;
  const info = (root.flowInformation as PrepareJson).dataSetInformation as PrepareJson;
  ((info.name as PrepareJson).treatmentStandardsRoutes as PrepareJson)['#text'] = text;
  f.options.semanticContextFile = path.join(f.dir, 'context.json');
  f.options.semanticContextSha256 = sha256Json(context);
  writeFileSync(f.options.semanticContextFile, JSON.stringify(context));
  return {
    ...f,
    text,
    context,
    inputs: [
      { role: 'scientific_proposal', file: f.options.inputPath },
      { role: 'preparation_report', file: f.options.preparationReportPath },
      { role: 'reviewed_predecessor', file: f.options.predecessorFile! },
      { role: 'native_semantic_context', file: f.options.semanticContextFile },
    ],
  };
}

function malformedReplacement(bytes: Buffer, replacement: number): Buffer {
  const marker = Buffer.from('\uFFFD');
  const index = bytes.indexOf(marker);
  assert.notEqual(index, -1);
  return Buffer.concat([
    bytes.subarray(0, index),
    Buffer.from([replacement]),
    bytes.subarray(index + marker.length),
  ]);
}

test('binding rejects malformed UTF-8 before parsing every captured input role', async () => {
  for (let index = 0; index < 4; index++) {
    for (const byte of [0x80, 0x81]) {
      const f = utf8Fixture();
      try {
        const file = f.inputs[index]!.file;
        const original = readFileSync(file);
        const invalid = malformedReplacement(original, byte);
        assert.equal(invalid.toString('utf8'), original.toString('utf8'));
        writeFileSync(file, invalid);
        let patchCalls = 0;
        const applyPatchImpl: typeof runDatasetPatchApply = async (options) => {
          patchCalls++;
          // These distinct illegal bytes previously decoded to the same U+FFFD.
          writeFileSync(file, malformedReplacement(original, byte === 0x80 ? 0x81 : 0x80));
          return runDatasetPatchApply(options);
        };
        await assert.rejects(runDatasetBindPreparedProposal({ ...f.options, applyPatchImpl }), {
          code: 'DATASET_PROPOSAL_BINDING_UTF8_INVALID',
        });
        assert.equal(patchCalls, 0);
        assert.equal(existsSync(f.options.outDir), false);
        assert.deepEqual(readFileSync(file), invalid);
      } finally {
        f.close();
      }
    }
  }
});

test('binding hashes exact valid UTF-8 bytes and preserves multibyte text and intentional U+FFFD', async () => {
  const f = utf8Fixture();
  try {
    const originals = new Map(f.inputs.map(({ file }) => [file, readFileSync(file)]));
    const binding = await runDatasetBindPreparedProposal(f.options);
    assert.equal(binding.inputs.length, 4);
    for (const { role, file } of f.inputs) {
      const entry = binding.inputs.find((input) => input.role === role)!;
      assert.equal(entry.path, file);
      assert.equal(
        entry.bytes_sha256,
        createHash('sha256').update(originals.get(file)!).digest('hex'),
      );
      assert.deepEqual(readFileSync(file), originals.get(file));
    }
    const desired = json(binding.files.desired);
    const payload = desired.jsonOrdered as PrepareJson;
    assert.deepEqual((payload.processDataSet as PrepareJson).scientificExample, { text: f.text });
    assert.deepEqual(pub(payload)[PRECEDING], f.predecessor);
    assert.deepEqual(
      (desired.semantic_context as PrepareJson).flow_documents,
      f.context.flow_documents,
    );
    assert.equal(binding.save_ready, false);
  } finally {
    f.close();
  }
});

test('binding rechecks raw bytes for every role both before patching and after awaited application', async () => {
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  for (let index = 0; index < 4; index++) {
    for (const phase of ['before_patch', 'after_patch']) {
      const f = utf8Fixture();
      const originalRead = mutableFs.readFileSync;
      try {
        const file = f.inputs[index]!.file;
        const original = readFileSync(file);
        const changed = malformedReplacement(original, 0x80);
        assert.equal(changed.toString('utf8'), original.toString('utf8'));
        let altered = false;
        if (phase === 'before_patch') {
          mutableFs.readFileSync = ((selected, options) => {
            const captured = originalRead(selected, options);
            if (!altered && selected === file) {
              altered = true;
              writeFileSync(file, changed);
            }
            return captured;
          }) as typeof mutableFs.readFileSync;
          syncBuiltinESMExports();
        }
        let patchCalls = 0;
        const applyPatchImpl: typeof runDatasetPatchApply = async (options) => {
          patchCalls++;
          const result = await runDatasetPatchApply(options);
          altered = true;
          writeFileSync(file, changed);
          return result;
        };
        await assert.rejects(runDatasetBindPreparedProposal({ ...f.options, applyPatchImpl }), {
          code: 'DATASET_PROPOSAL_BINDING_INPUT_CHANGED',
        });
        assert.equal(altered, true);
        assert.equal(patchCalls, phase === 'before_patch' ? 0 : 1);
        assert.deepEqual(readFileSync(file), changed);
        assert.deepEqual(readdirSync(f.options.outDir), []);
      } finally {
        mutableFs.readFileSync = originalRead;
        syncBuiltinESMExports();
        f.close();
      }
    }
  }
});

test('binding retains JSON parsing and leading BOM rejection for every input role', async () => {
  for (let index = 0; index < 4; index++) {
    for (const kind of ['bom', 'invalid_json']) {
      const f = utf8Fixture();
      try {
        const file = f.inputs[index]!.file;
        const original = readFileSync(file);
        writeFileSync(
          file,
          kind === 'bom'
            ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])
            : Buffer.from('{'),
        );
        await assert.rejects(runDatasetBindPreparedProposal(f.options), SyntaxError);
        assert.equal(existsSync(f.options.outDir), false);
      } finally {
        f.close();
      }
    }
  }
});

// These are entirely synthetic scientific payloads; no private proposal or review hash is a fixture.
test('offline binding changes only three reviewed identity fields and preserves the proposal and source', async () => {
  for (const table of ['contacts', 'sources', 'flows', 'processes'] as const) {
    const f = fixture(table);
    try {
      const proposalBytes = readFileSync(f.options.inputPath, 'utf8');
      const reportBytes = readFileSync(f.options.preparationReportPath, 'utf8');
      const result = await runDatasetBindPreparedProposal(f.options);
      const desired = json(result.files.desired).jsonOrdered as PrepareJson;
      assert.equal(result.status, 'bound');
      assert.equal(result.save_ready, false);
      assert.equal(result.qualification, 'server_receipt_reported_readback');
      assert.equal(result.hashes.proposal, sha256Json(f.proposal));
      assert.equal(result.hashes.source, sha256Json(f.source));
      assert.equal(result.hashes.receipt, sha256Json(f.receipt));
      assert.equal(result.hashes.target_before, sha256Json(f.before));
      assert.equal(result.hashes.desired, sha256Json(desired));
      assert.equal(result.identity_changed_paths.length, 3);
      assert.equal(pub(desired, table)[VERSION], TARGET);
      assert.equal(pub(desired, table)[URI], prepareCanonicalUri(table, ID, TARGET));
      assert.deepEqual(pub(desired, table)[PRECEDING], f.predecessor);
      const restored = structuredClone(desired);
      const restoredPub = pub(restored, table);
      restoredPub[VERSION] = pub(f.proposal, table)[VERSION];
      restoredPub[URI] = pub(f.proposal, table)[URI];
      delete restoredPub[PRECEDING];
      assert.deepEqual(restored, f.proposal);
      assert.equal(result.scientific_projection_unchanged, true);
      assert.equal(
        result.hashes.proposal_scientific_projection,
        result.hashes.desired_scientific_projection,
      );
      assert.equal(result.semantic_context_binding.status, 'not_supplied');
      assert.equal(readFileSync(f.options.inputPath, 'utf8'), proposalBytes);
      assert.equal(readFileSync(f.options.preparationReportPath, 'utf8'), reportBytes);
      for (const file of Object.values(result.files)) assert.equal(json(file).save_ready, false);
      assert.equal(result.review_policy.scientific_review_status, 'not_inferred');
      assert.equal(
        result.review_policy.existing_review,
        'reusable_if_valid_and_bound_to_same_proposal_digest',
      );
      assert.equal(
        result.review_policy.reopen_scientific_review,
        'only_for_material_scientific_changes',
      );
      assert.equal(
        readdirSync(f.options.outDir).some((name) => name.startsWith('.identity-patch-')),
        false,
      );
      const patch = json(result.files.patch) as {
        patches: Array<{ operations: Array<{ path: string }> }>;
      };
      assert.ok(
        patch.patches[0]!.operations.every((operation) =>
          /\/publicationAndOwnership\/common:(?:dataSetVersion|permanentDataSetURI|referenceToPrecedingDataSetVersion)$/u.test(
            operation.path,
          ),
        ),
      );
      await assert.rejects(runDatasetBindPreparedProposal(f.options), {
        code: 'DATASET_PROPOSAL_BINDING_OUTPUT_CONFLICT',
      });
    } finally {
      f.close();
    }
  }
});

test('existing exact reviewed predecessor can be retained, including one-reference arrays, without new scientific review', async () => {
  for (const asArray of [false, true]) {
    const f = fixture('processes', true);
    try {
      pub(f.proposal)[PRECEDING] = asArray ? [f.predecessor] : f.predecessor;
      delete f.options.predecessorFile;
      delete f.options.predecessorSha256;
      f.freeze();
      const result = await runDatasetBindPreparedProposal(f.options);
      assert.equal(result.qualification, 'observed_only');
      assert.equal(result.hashes.receipt, null);
      assert.equal(result.predecessor_origin, 'proposal');
      assert.equal(result.identity_changed_paths.length, 2);
      assert.equal(result.save_ready, false);
      assert.deepEqual(
        pub(json(result.files.desired).jsonOrdered as PrepareJson)[PRECEDING],
        pub(f.proposal)[PRECEDING],
      );
    } finally {
      f.close();
    }
  }
});

test('missing, wrong or SDK-invalid predecessors cannot silently bind publication lineage', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      runDatasetBindPreparedProposal({
        ...f.options,
        predecessorFile: undefined,
        predecessorSha256: undefined,
      }),
      { code: 'PREDECESSOR_BINDING_REQUIRED' },
    );
    assert.equal(readdirSync(f.dir).includes('bound'), false);
    for (const wrong of [
      { ...f.predecessor, '@type': 'flow data set' },
      { ...f.predecessor, '@refObjectId': ACTOR },
      { ...f.predecessor, '@version': '03.02.006' },
      { ...f.predecessor, '@uri': '../guess.xml' },
      { ...f.predecessor, 'common:shortDescription': null },
      { ...f.predecessor, 'common:shortDescription': { '@xml:lang': 'invalid', '#text': 'text' } },
      {
        ...f.predecessor,
        'common:shortDescription': { '@xml:lang': 'en', '#text': 'x'.repeat(1001) },
      },
      { ...f.predecessor, unreviewedExtra: true },
      [],
      [f.predecessor, f.predecessor],
    ]) {
      writeFileSync(f.options.predecessorFile!, JSON.stringify(wrong));
      await assert.rejects(
        runDatasetBindPreparedProposal({ ...f.options, predecessorSha256: sha256Json(wrong) }),
        { code: 'PREDECESSOR_BINDING_REQUIRED' },
        JSON.stringify(wrong),
      );
    }
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, predecessorSha256: 'a'.repeat(64) }),
      { code: 'DATASET_PROPOSAL_BINDING_HASH_MISMATCH' },
    );
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, predecessorSha256: undefined }),
      { code: 'PREDECESSOR_BINDING_REQUIRED' },
    );
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, predecessorFile: undefined }),
      { code: 'PREDECESSOR_BINDING_REQUIRED' },
    );
  } finally {
    f.close();
  }
});

test('reviewed hashes, public identity and preparation proof must all bind the same fixed target', async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.options.proposalSha256 = 'a'.repeat(64);
    },
    (f) => {
      f.options.sourceSha256 = 'a'.repeat(64);
    },
    (f) => {
      f.options.proposalSha256 = 'bad';
    },
    (f) => {
      f.options.sourceSha256 = '';
    },
    (f) => {
      f.report.save_ready = true;
      f.freeze();
    },
    (f) => {
      f.report.reviews = [{ stateCode: 20 }];
      f.freeze();
    },
    (f) => {
      f.report.status = 'needs_creation';
      f.freeze();
    },
    (f) => {
      f.report.status = 'review_conflict';
      f.freeze();
    },
    (f) => {
      f.report.request_sha256 = 'a'.repeat(64);
      f.freeze();
    },
    (f) => {
      f.report.target = { ...f.target, stateCode: 100 };
      f.freeze();
    },
    (f) => {
      pub(f.proposal)[VERSION] = TARGET;
      f.freeze();
    },
    (f) => {
      pub(f.proposal)[URI] = 'https://example.invalid/guessed';
      f.freeze();
    },
    (f) => {
      (
        (f.proposal.processDataSet as PrepareJson).processInformation as PrepareJson
      ).dataSetInformation = { 'common:UUID': ACTOR };
      f.freeze();
    },
    (f) => {
      f.proposal.processDataSet = {};
      f.freeze();
    },
  ];
  for (const alter of mutations) {
    const f = fixture();
    try {
      alter(f);
      await assert.rejects(runDatasetBindPreparedProposal(f.options));
      assert.equal(readdirSync(f.dir).includes('bound'), false);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    await assert.rejects(runDatasetBindPreparedProposal({ ...f.options, inputPath: '' }));
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, preparationReportPath: '' }),
    );
    await assert.rejects(runDatasetBindPreparedProposal({ ...f.options, outDir: '' }));
    writeFileSync(f.options.inputPath, '[]');
    await assert.rejects(runDatasetBindPreparedProposal(f.options));
  } finally {
    f.close();
  }
});

test('the patch owner cannot introduce scientific or UUID changes and changing inputs cannot be covered over', async () => {
  const f = fixture();
  try {
    for (const kind of [
      'science',
      'identity',
      'save_ready',
      'input_drift',
      'patch_failed',
      'missing_root',
      'missing_admin',
      'missing_publication',
    ] as const) {
      const outDir = path.join(f.dir, kind);
      const applyPatchImpl: typeof runDatasetPatchApply = async (options) => {
        const report = await runDatasetPatchApply(options);
        const row = JSON.parse(readFileSync(options.outPath, 'utf8')) as {
          save_ready: boolean;
          jsonOrdered: PrepareJson;
        };
        if (kind === 'science')
          (row.jsonOrdered.processDataSet as PrepareJson).scientificExample = {
            quantity: 'invented',
          };
        if (kind === 'identity') pub(row.jsonOrdered)[VERSION] = '99.99.999';
        if (kind === 'save_ready') row.save_ready = true;
        if (kind === 'missing_root') delete row.jsonOrdered.processDataSet;
        if (kind === 'missing_admin')
          delete (row.jsonOrdered.processDataSet as PrepareJson).administrativeInformation;
        if (kind === 'missing_publication')
          (
            (row.jsonOrdered.processDataSet as PrepareJson).administrativeInformation as PrepareJson
          ).publicationAndOwnership = null;

        if (kind === 'input_drift') writeFileSync(f.options.inputPath, '{}');
        writeFileSync(options.outPath, `${JSON.stringify(row)}\n`);
        return kind === 'patch_failed' ? { ...report, status: 'blocked' } : report;
      };
      await assert.rejects(
        runDatasetBindPreparedProposal({ ...f.options, outDir, applyPatchImpl }),
      );
      assert.equal(
        readdirSync(outDir).some((name) => name.endsWith('.json')),
        false,
      );
      f.freeze();
    }
    const { mkdirSync } = await import('node:fs');
    const actual = path.join(f.dir, 'actual');
    mkdirSync(actual);
    const link = path.join(f.dir, 'linked');
    symlinkSync(actual, link);
    await assert.rejects(runDatasetBindPreparedProposal({ ...f.options, outDir: link }), {
      code: 'DATASET_PROPOSAL_BINDING_OUTPUT_CONFLICT',
    });
  } finally {
    f.close();
  }
});

test('public bind command is strict and offline, with normal and injected owner dispatch', async () => {
  let calls = 0;
  const deps = {
    env: {},
    dotEnvStatus: { loaded: false, path: '/tmp/.env', count: 0 },
    fetchImpl: async () => {
      calls++;
      throw new Error('offline binding must not transport');
    },
  };
  const help = await executeCli(['dataset', 'prepare-draft', 'bind', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /save_ready=false/u);
  for (const flags of [
    [],
    ['--commit'],
    ['--input', 'a', '--input=b'],
    [
      '--input',
      'a',
      '--proposal-sha256',
      'b',
      '--source-sha256',
      'c',
      '--preparation-report',
      'd',
      '--out-dir',
      'e',
      '--predecessor-file',
      'f',
    ],
    ['--input', ''],
  ])
    assert.equal(
      (await executeCli(['dataset', 'prepare-draft', 'bind', ...flags], deps)).exitCode,
      2,
    );
  for (const withExplicit of [false, true]) {
    const f = fixture();
    try {
      if (!withExplicit) {
        pub(f.proposal)[PRECEDING] = f.predecessor;
        delete f.options.predecessorFile;
        delete f.options.predecessorSha256;
        f.freeze();
      }
      const semantic = {
        candidate_sha256: f.options.proposalSha256,
        flow_documents: allocationFixture().context.flow_documents,
      };
      const semanticFile = path.join(f.dir, 'context.json');
      writeFileSync(semanticFile, JSON.stringify(semantic));
      const args = [
        'dataset',
        'prepare-draft',
        'bind',
        '--input',
        f.options.inputPath,
        '--proposal-sha256',
        f.options.proposalSha256,
        '--source-sha256',
        f.options.sourceSha256,
        '--preparation-report',
        f.options.preparationReportPath,
        '--out-dir',
        f.options.outDir,
        ...(withExplicit
          ? [
              '--semantic-context-file',
              semanticFile,
              '--semantic-context-sha256',
              sha256Json(semantic),
            ]
          : []),
        '--json',
        ...(withExplicit
          ? [
              '--predecessor-file',
              f.options.predecessorFile!,
              '--predecessor-sha256',
              f.options.predecessorSha256!,
            ]
          : []),
      ];
      const result = await executeCli(args, {
        ...deps,
        ...(withExplicit
          ? { runDatasetBindPreparedProposalImpl: runDatasetBindPreparedProposal }
          : {}),
      });
      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).save_ready, false);
      assert.equal(calls, 0);
    } finally {
      f.close();
    }
  }
});

test('built public bind executes offline with no auth session and keeps synthetic evidence', async () => {
  const f = fixture();
  try {
    const exec = promisify(execFile);
    const bin = path.resolve('bin/tiangong-lca.js');
    const semantic = {
      candidate_sha256: f.options.proposalSha256,
      flow_documents: allocationFixture().context.flow_documents,
    };
    const semanticFile = path.join(f.dir, 'context.json');
    writeFileSync(semanticFile, JSON.stringify(semantic));
    const args = [
      bin,
      'dataset',
      'prepare-draft',
      'bind',
      '--input',
      f.options.inputPath,
      '--proposal-sha256',
      f.options.proposalSha256,
      '--source-sha256',
      f.options.sourceSha256,
      '--preparation-report',
      f.options.preparationReportPath,
      '--predecessor-file',
      f.options.predecessorFile!,
      '--predecessor-sha256',
      f.options.predecessorSha256!,
      '--out-dir',
      f.options.outDir,
      '--semantic-context-file',
      semanticFile,
      '--semantic-context-sha256',
      sha256Json(semantic),
      '--json',
    ];
    const result = await exec(process.execPath, args, {
      cwd: f.dir,
      env: {
        NODE_V8_COVERAGE: '',
        HOME: f.dir,
        TIANGONG_LCA_API_BASE_URL: 'http://127.0.0.1:9/functions/v1',
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'public-synthetic-key',
        TIANGONG_LCA_OAUTH_CLIENT_ID: REQUEST,
        TIANGONG_LCA_OAUTH_REDIRECT_URI: 'http://127.0.0.1:47832/oauth/callback',
      },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'bound');
    assert.equal(report.save_ready, false);
    assert.equal(result.stderr, '');
    if (process.env.TIANGONG_LCA_PREPARE_DRAFT_TEST_PROOF_DIR) {
      const { mkdirSync } = await import('node:fs');
      const { createHash } = await import('node:crypto');
      const dir = process.env.TIANGONG_LCA_PREPARE_DRAFT_TEST_PROOF_DIR;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(dir, 'public-bind-proof.json'),
        JSON.stringify(
          {
            save_ready: false,
            qualification:
              'Synthetic offline public-bin proof; no production scientific review or data acceptance asserted.',
            node: { path: process.execPath, version: process.versions.node },
            bin,
            executable_sha256: createHash('sha256').update(readFileSync(bin)).digest('hex'),
            exit_code: 0,
            ...result,
            artifacts: Object.fromEntries(
              Object.entries(report.files as Record<string, string>).map(([key, file]) => [
                key,
                json(file),
              ]),
            ),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  } finally {
    f.close();
  }
});

test('binding refuses missing canonical identity and incomplete observed-only census', async () => {
  for (const mode of [
    'missing_identity_root',
    'missing_completeness',
    'incomplete_completeness',
    'no_selected_target',
  ] as const) {
    const f = fixture('processes', true);
    try {
      if (mode === 'missing_identity_root') delete f.proposal.processDataSet;
      if (mode === 'missing_completeness') delete f.report.completeness;
      if (mode === 'incomplete_completeness')
        f.report.completeness = { complete: false, exact_total: 1, rows_fetched: 1 };
      if (mode === 'no_selected_target') {
        f.request.request.expectedDrafts = [];
        f.report.request_sha256 = sha256Json(f.request);
      }
      f.freeze();
      await assert.rejects(runDatasetBindPreparedProposal(f.options));
    } finally {
      f.close();
    }
  }
});

test('a historically missing public URI is added only from the actual fixed target identity', async () => {
  const f = fixture();
  try {
    delete pub(f.source)[URI];
    delete pub(f.proposal)[URI];
    f.report.request_sha256 = sha256Json(f.request);
    f.freeze();
    const result = await runDatasetBindPreparedProposal(f.options);
    assert.equal(
      pub(json(result.files.desired).jsonOrdered as PrepareJson)[URI],
      prepareCanonicalUri('processes', ID, TARGET),
    );
    assert.equal(result.save_ready, false);
    assert.equal(result.scientific_projection_unchanged, true);
  } finally {
    f.close();
  }
});

test('Process semantic context preserves complete exact Flow bodies and only rebinds the original proposal hash', async () => {
  const f = fixture();
  try {
    const context = {
      candidate_sha256: f.options.proposalSha256,
      flow_documents: allocationFixture().context.flow_documents,
    };
    assert.ok(
      context.flow_documents.every((flow) => FlowSchema.safeParse(structuredClone(flow)).success),
    );
    const before = structuredClone(context);
    const contextFile = path.join(f.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const result = await runDatasetBindPreparedProposal({
      ...f.options,
      semanticContextFile: contextFile,
      semanticContextSha256: sha256Json(context),
    });
    const desired = json(result.files.desired);
    const rebound = semanticContextFromInput(desired);
    assert.deepEqual(rebound.flow_documents, before.flow_documents);
    assert.equal(rebound.candidate_sha256, result.hashes.desired);
    assert.deepEqual(result.semantic_context_binding, {
      status: 'rebound_identity_only',
      before_sha256: sha256Json(before),
      after_sha256: sha256Json(rebound),
      flow_documents_sha256: sha256Json(before.flow_documents),
      flow_documents_unchanged: true,
      flow_document_count: before.flow_documents.length,
      candidate_before_sha256: f.options.proposalSha256,
      candidate_after_sha256: result.hashes.desired,
    });
    assert.equal(result.save_ready, false);
    assert.deepEqual(JSON.parse(readFileSync(contextFile, 'utf8')), before);
    const analysis = analyzeProcessPayloadSemantics(desired.jsonOrdered as PrepareJson, rebound);
    assert.equal(
      analysis.issues.some((issue) => issue.code === 'allocation_candidate_evidence_stale'),
      false,
    );
    assert.equal(
      result.hashes.proposal_scientific_projection,
      result.hashes.desired_scientific_projection,
    );
  } finally {
    f.close();
  }
});

test('semantic context cannot re-label a different candidate, malformed evidence or generated provenance', async () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { candidate_sha256: 'bad', flow_documents: [] },
    { candidate_sha256: 'a'.repeat(64), flow_documents: [] },
    { candidate_sha256: 'a'.repeat(64), flow_documents: [null] },
    { allocation_transformation: {} },
    { invalid_bindings: [] },
    { candidate_sha256: 'a'.repeat(64), flow_documents: [], source_model: {} },
  ];
  for (const value of invalid) {
    const f = fixture();
    try {
      const file = path.join(f.dir, 'context.json');
      writeFileSync(file, JSON.stringify(value));
      await assert.rejects(
        runDatasetBindPreparedProposal({
          ...f.options,
          semanticContextFile: file,
          semanticContextSha256: sha256Json(value),
        }),
      );
      assert.equal(readdirSync(f.dir).includes('bound'), false);
    } finally {
      f.close();
    }
  }
  for (const table of ['contacts', 'sources', 'flows'] as const) {
    const f = fixture(table);
    try {
      const context = { candidate_sha256: f.options.proposalSha256, flow_documents: [] };
      const file = path.join(f.dir, 'context.json');
      writeFileSync(file, JSON.stringify(context));
      await assert.rejects(
        runDatasetBindPreparedProposal({
          ...f.options,
          semanticContextFile: file,
          semanticContextSha256: sha256Json(context),
        }),
        { code: 'DATASET_PROPOSAL_SEMANTIC_CONTEXT_TYPE_UNSUPPORTED' },
      );
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const file = path.join(f.dir, 'context.json');
    const context = { candidate_sha256: f.options.proposalSha256, flow_documents: [] };
    writeFileSync(file, JSON.stringify(context));
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, semanticContextFile: file }),
    );
    await assert.rejects(
      runDatasetBindPreparedProposal({ ...f.options, semanticContextSha256: sha256Json(context) }),
    );
    await assert.rejects(
      runDatasetBindPreparedProposal({
        ...f.options,
        semanticContextFile: file,
        semanticContextSha256: 'b'.repeat(64),
      }),
      { code: 'DATASET_PROPOSAL_BINDING_HASH_MISMATCH' },
    );
    const applyPatchImpl: typeof runDatasetPatchApply = async (options) => {
      const result = await runDatasetPatchApply(options);
      writeFileSync(file, '{}');
      return result;
    };
    await assert.rejects(
      runDatasetBindPreparedProposal({
        ...f.options,
        semanticContextFile: file,
        semanticContextSha256: sha256Json(context),
        applyPatchImpl,
      }),
      { code: 'DATASET_PROPOSAL_BINDING_INPUT_CHANGED' },
    );
  } finally {
    f.close();
  }
});
