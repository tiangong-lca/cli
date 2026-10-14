#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Exercise the real public launcher with synthetic local data; no runtime imports or network writes.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    'cli-bin': { type: 'string', default: path.join(repoRoot, 'bin/tiangong-lca.js') },
    expect: { type: 'string', default: 'guarded' },
  },
});
assert.ok(values['out-dir'], 'Pass --out-dir with a new evidence directory.');
assert.ok(['guarded', 'legacy'].includes(values.expect), '--expect must be guarded or legacy.');
const outDir = path.resolve(values['out-dir']);
assert.equal(existsSync(outDir), false, 'The evidence directory must not already exist.');
const cliBin = realpathSync(values['cli-bin']);
const cliRoot = path.dirname(path.dirname(cliBin));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageJson = readJson(path.join(cliRoot, 'package.json'));
assert.equal(packageJson.name, '@tiangong-lca/cli');
const seedPath = 'test/fixtures/tidas-sdk/test-data/process-annual-volume.json';
const seedBytes = readFileSync(path.join(repoRoot, seedPath));
const seed = JSON.parse(seedBytes);
const sanitize = (text) => text.replaceAll(outDir, '<evidence-dir>').replaceAll(cliRoot, '<cli>');
const git = (args) => spawnSync('git', ['-C', cliRoot, ...args], { encoding: 'utf8' });
const gitRoot = git(['rev-parse', '--show-toplevel']);
const hasCheckout = gitRoot.status === 0 && realpathSync(gitRoot.stdout.trim()) === cliRoot;
const checkoutState = hasCheckout ? git(['status', '--porcelain']).stdout.trim() : null;
const proof = {
  schema: 'tiangong-cli.lifecyclemodel-input-guards-proof.v1',
  started_at: new Date().toISOString(),
  expectation: values.expect,
  status: 'running',
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    node_sha256: sha256(readFileSync(realpathSync(process.execPath))),
    package: packageJson.name,
    version: packageJson.version,
    checkout_head: hasCheckout ? git(['rev-parse', 'HEAD']).stdout.trim() : null,
    checkout_clean: hasCheckout ? checkoutState === '' : null,
    checkout_status: checkoutState,
    bin_sha256: sha256(readFileSync(cliBin)),
    built_main_sha256: sha256(readFileSync(path.join(cliRoot, 'dist/src/main.js'))),
    built_builder_sha256: sha256(
      readFileSync(path.join(cliRoot, 'dist/src/lib/lifecyclemodel-resulting-process.js')),
    ),
    proof_script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  },
  seed: { path: seedPath, sha256: sha256(seedBytes) },
  child_environment_keys: ['PATH', 'LANG', 'TZ'],
  stored_artifacts: 'Host paths are sanitized; raw hashes bind bytes before sanitization.',
  commands: [],
};
mkdirSync(outDir, { recursive: true });

const VERSION = '01.00.000';
const FLOW = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const OTHER = '99999999-9999-4999-8999-999999999999';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const CONSUMER = '66666666-6666-4666-8666-666666666666';
function component(id, amounts) {
  const payload = structuredClone(seed);
  const root = payload.processDataSet;
  root.processInformation.dataSetInformation['common:UUID'] = id;
  const base = root.exchanges.exchange[0];
  root.exchanges.exchange = amounts.map(([flow, direction, amount], index) => ({
    ...structuredClone(base),
    '@dataSetInternalID': String(index + 1),
    referenceToFlowDataSet: { ...base.referenceToFlowDataSet, '@refObjectId': flow },
    exchangeDirection: direction,
    meanAmount: amount,
    resultingAmount: amount,
  }));
  root.processInformation.quantitativeReference.referenceToReferenceFlow = String(
    amounts.findIndex(([, direction]) => direction === 'Output') + 1,
  );
  return payload;
}
function fixture(demand = '5') {
  const sources = [
    { id: SUPPLIER, version: VERSION, payload: component(SUPPLIER, [[FLOW, 'Output', '2']]) },
    {
      id: CONSUMER,
      version: VERSION,
      payload: component(CONSUMER, [
        [FLOW, 'Input', demand],
        [PRODUCT, 'Output', '1'],
      ]),
    },
  ];
  const instances = sources.map(({ id }, index) => ({
    '@dataSetInternalID': String(index),
    '@multiplicationFactor': '1',
    referenceToProcess: {
      '@type': 'process data set',
      '@refObjectId': id,
      '@version': VERSION,
      '@uri': `../processes/${id}.xml`,
      'common:shortDescription': { '@xml:lang': 'en', '#text': 'Synthetic component' },
    },
  }));
  const edge = {
    '@flowUUID': FLOW,
    '@version': VERSION,
    downstreamProcess: { '@id': '1', '@flowUUID': FLOW, '@version': VERSION },
  };
  instances[0].connections = { outputExchange: edge };
  const request = {
    source_model: {
      json_ordered: {
        lifeCycleModelDataSet: {
          '@id': '77777777-7777-4777-8777-777777777777',
          '@version': VERSION,
          lifeCycleModelInformation: {
            dataSetInformation: {
              'common:UUID': '77777777-7777-4777-8777-777777777777',
              name: sources[0].payload.processDataSet.processInformation.dataSetInformation.name,
            },
            quantitativeReference: { referenceToReferenceProcess: '1' },
            technology: { processes: { processInstance: instances } },
          },
        },
      },
    },
    projection: { process_id: '88888888-8888-4888-8888-888888888888' },
    process_sources: { process_json_files: [], allow_remote_lookup: false },
  };
  return { sources, instances, edge, request, root: sources[0].payload.processDataSet };
}
const partial = [
  [FLOW, 'Input', '3'],
  [PRODUCT, 'Output', '1'],
];

// Each saved artifact keeps both the original byte hash and the sanitized byte hash.
function preserve(file) {
  const bytes = readFileSync(file);
  const stored = sanitize(bytes.toString('utf8'));
  writeFileSync(file, stored);
  return {
    file: path.relative(outDir, file),
    raw_sha256: sha256(bytes),
    stored_sha256: sha256(stored),
  };
}
function artifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? artifacts(file) : [preserve(file)];
  });
}
function runCase(name, data, expectedQuantities, errorCode) {
  const relative = `cases/${name}`;
  const caseDir = path.join(outDir, relative);
  mkdirSync(caseDir, { recursive: true });
  data.request.process_sources.process_json_files = data.sources.map(({ id, version, payload }) => {
    const file = `${id}_${version}.json`;
    writeJson(path.join(caseDir, file), payload);
    return file;
  });
  writeJson(path.join(caseDir, 'input.json'), data.request);
  const argv = [
    'lifecyclemodel',
    'build-resulting-process',
    '--input',
    `${relative}/input.json`,
    '--out-dir',
    `${relative}/result`,
    '--json',
  ];
  const record = {
    name,
    command: ['node', '<cli>/bin/tiangong-lca.js', ...argv],
    cwd: '<evidence-dir>',
    started_at: new Date().toISOString(),
    inputs: ['input.json', ...data.request.process_sources.process_json_files].map((file) => ({
      file: `${relative}/${file}`,
      sha256: sha256(readFileSync(path.join(caseDir, file))),
    })),
    expected_error_code: errorCode ?? null,
  };
  proof.commands.push(record);
  const result = spawnSync(process.execPath, [cliBin, ...argv], {
    cwd: outDir,
    env: { PATH: path.dirname(process.execPath), LANG: 'C', TZ: 'UTC' },
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  Object.assign(record, {
    finished_at: new Date().toISOString(),
    exit_code: result.status,
    signal: result.signal,
    stdout_raw_sha256: sha256(result.stdout ?? ''),
    stderr_raw_sha256: sha256(result.stderr ?? ''),
    output_directory_exists: existsSync(path.join(caseDir, 'result')),
  });
  writeFileSync(path.join(caseDir, 'stdout.json'), sanitize(result.stdout ?? ''));
  writeFileSync(path.join(caseDir, 'stderr.txt'), sanitize(result.stderr ?? ''));
  try {
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    if (errorCode && values.expect === 'guarded') {
      record.error = JSON.parse(result.stderr).error;
      assert.equal(result.status, 2, `${name}: guarded exit code`);
      assert.equal(record.error.code, errorCode, `${name}: meaningful error`);
      assert.equal(result.stdout, '');
      assert.equal(record.output_directory_exists, false, `${name}: no output artifacts`);
      record.qualification = null;
    } else {
      assert.equal(result.status, 0, `${name}: ${sanitize(result.stderr)}`);
      assert.equal(result.stderr, '');
      const report = JSON.parse(result.stdout);
      const projection = readJson(report.files.projection_report);
      const bundle = readJson(report.files.process_projection_bundle);
      const payload = bundle.projected_processes[0].json_ordered;
      record.qualification = projection.qualification;
      record.validation_ok = projection.validation.ok;
      record.quantities = payload.processDataSet.exchanges.exchange.map((item) => [
        item.referenceToFlowDataSet['@refObjectId'],
        item.exchangeDirection,
        item.meanAmount,
      ]);
      assert.deepEqual(record.qualification, { status: 'qualified', publish_ready: true });
      assert.equal(record.validation_ok, true, `${name}: native schema/evidence validation`);
      const ordered = (items) =>
        items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(
        ordered(record.quantities),
        ordered(expectedQuantities),
        `${name}: boundary inventory`,
      );
    }
    record.assertions_passed = true;
  } finally {
    record.outputs = artifacts(path.join(caseDir, 'result'));
    record.error = record.error ? JSON.parse(sanitize(JSON.stringify(record.error))) : null;
    writeJson(path.join(caseDir, 'command.json'), record);
  }
}

try {
  runCase('partial-residual', fixture(), partial);
  runCase('equal-cancellation', fixture('2'), [[PRODUCT, 'Output', '1']]);
  const identityCode = 'LIFECYCLEMODEL_PROCESS_IDENTITY_MISMATCH';
  const wrongUuid = fixture();
  wrongUuid.root.processInformation.dataSetInformation['common:UUID'] = OTHER;
  runCase('body-uuid-mismatch', wrongUuid, partial, identityCode);
  const wrongVersion = fixture();
  wrongVersion.root.administrativeInformation.publicationAndOwnership['common:dataSetVersion'] =
    '02.00.000';
  runCase('body-version-mismatch', wrongVersion, partial, identityCode);
  for (const endpoint of ['outer', 'downstream']) {
    const data = fixture();
    (endpoint === 'outer' ? data.edge : data.edge.downstreamProcess)['@version'] = '02.00.000';
    runCase(
      `${endpoint}-version-mismatch`,
      data,
      partial,
      'LIFECYCLEMODEL_CONNECTION_VERSION_MISMATCH',
    );
  }
  const different = fixture();
  different.sources[1].payload = component(CONSUMER, [
    [FLOW, 'Input', '5'],
    [OTHER, 'Input', '7'],
    [PRODUCT, 'Output', '1'],
  ]);
  different.edge.downstreamProcess['@flowUUID'] = OTHER;
  runCase(
    'different-downstream-flow',
    different,
    [
      [FLOW, 'Input', '3'],
      [OTHER, 'Input', '7'],
      [PRODUCT, 'Output', '1'],
    ],
    'LIFECYCLEMODEL_CONNECTION_MAPPING_UNSUPPORTED',
  );
  const quantity = fixture();
  quantity.root.exchanges.exchange[0].meanAmount = '1';
  quantity.root.exchanges.exchange[0].resultingAmount = '4';
  runCase(
    'conflicting-unallocated-amounts',
    quantity,
    [
      [FLOW, 'Input', '4'],
      [PRODUCT, 'Output', '1'],
    ],
    'LIFECYCLEMODEL_QUANTITY_BASIS_CONFLICT',
  );
  const variable = fixture();
  variable.root.exchanges.exchange[0].referenceToVariable = 'factor';
  variable.root.processInformation.mathematicalRelations = {
    variableParameter: { '@name': 'factor', formula: '2*2', meanValue: '4' },
  };
  runCase(
    'variable-dependent-amounts',
    variable,
    partial,
    'LIFECYCLEMODEL_VARIABLE_INVENTORY_UNSUPPORTED',
  );
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.failure = sanitize(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(proof.failure);
} finally {
  proof.finished_at = new Date().toISOString();
  writeJson(path.join(outDir, 'proof.json'), proof);
  console.log(JSON.stringify(proof, null, 2));
}
