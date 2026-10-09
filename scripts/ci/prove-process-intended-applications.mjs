#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Public-command proof only: no production-module imports, fake schemas, sessions or remote writes.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    'out-dir': { type: 'string' },
    'cli-bin': { type: 'string', default: path.join(repoRoot, 'bin/tiangong-lca.js') },
    expect: { type: 'string', default: 'explicit' },
  },
});
assert.ok(values['out-dir'], 'Pass --out-dir with a new evidence directory.');
assert.ok(['explicit', 'legacy'].includes(values.expect), '--expect must be explicit or legacy.');
const outDir = path.resolve(values['out-dir']);
assert.equal(existsSync(outDir), false, 'The evidence directory must not already exist.');
const cliBin = realpathSync(values['cli-bin']);
const cliRoot = path.dirname(path.dirname(cliBin));
const packageJson = JSON.parse(readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
assert.equal(packageJson.name, '@tiangong-lca/cli');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const purposePath = 'administrative_information.intended_applications';
const fixtureBytes = readFileSync(
  path.join(repoRoot, 'test/fixtures/process-intended-applications-plan.json'),
);
const fixture = JSON.parse(fixtureBytes);
const purpose = fixture.administrative_information.intended_applications;
const purposeOf = (payload) =>
  payload.processDataSet.administrativeInformation['common:commissionerAndGoal'][
    'common:intendedApplications'
  ];
const git = (args) => spawnSync('git', ['-C', cliRoot, ...args], { encoding: 'utf8' });
const gitRoot = git(['rev-parse', '--show-toplevel']);
const hasCheckout = gitRoot.status === 0 && realpathSync(gitRoot.stdout.trim()) === cliRoot;
const proof = {
  schema: 'tiangong-cli.process-intended-applications-proof.v1',
  started_at: new Date().toISOString(),
  expectation: values.expect,
  status: 'running',
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    package: packageJson.name,
    version: packageJson.version,
    checkout_head: hasCheckout ? git(['rev-parse', 'HEAD']).stdout.trim() : null,
    checkout_clean: hasCheckout ? git(['status', '--porcelain']).stdout.trim() === '' : null,
    bin_sha256: sha256(readFileSync(cliBin)),
    built_main_sha256: sha256(readFileSync(path.join(cliRoot, 'dist/src/main.js'))),
    built_build_plan_sha256: sha256(
      readFileSync(path.join(cliRoot, 'dist/src/lib/process-flow-build-plan.js')),
    ),
  },
  fixture_sha256: sha256(fixtureBytes),
  child_environment_keys: ['PATH', 'LANG', 'TZ'],
  commands: [],
};
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'source-plan.json'), fixtureBytes);

function runCase(name, action, plan, blocker) {
  const relative = `cases/${name}/${action}`;
  const caseDir = path.join(outDir, relative);
  mkdirSync(caseDir, { recursive: true });
  const input = `${relative}/input.json`;
  const resultDir = `${relative}/result`;
  writeJson(path.join(outDir, input), plan);
  const argv = [
    'process',
    'build-plan',
    action,
    '--input',
    input,
    '--out-dir',
    resultDir,
    '--json',
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [cliBin, ...argv], {
    cwd: outDir,
    env: { PATH: path.dirname(process.execPath), LANG: 'C', TZ: 'UTC' },
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Inputs and output arguments are relative, so native stdout/gate/payload contain no host paths.
  writeFileSync(path.join(caseDir, 'stdout.json'), result.stdout ?? '');
  writeFileSync(path.join(caseDir, 'stderr.txt'), result.stderr ?? '');
  const gateFile = `${resultDir}/outputs/build-plan-gate-report.json`;
  const payloadFile = `${resultDir}/outputs/materialized-process.json`;
  const record = {
    command: ['node', '<cli>/bin/tiangong-lca.js', ...argv],
    cwd: '<evidence-dir>',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.status,
    signal: result.signal,
    stdout: `${relative}/stdout.json`,
    stderr: `${relative}/stderr.txt`,
    input_sha256: sha256(readFileSync(path.join(outDir, input))),
    gate_file: gateFile,
    payload_file: payloadFile,
    payload_exists: existsSync(path.join(outDir, payloadFile)),
  };
  proof.commands.push(record);
  writeJson(path.join(caseDir, 'command.json'), record);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const blocked = Boolean(blocker) && values.expect === 'explicit';
  assert.equal(result.status, blocked ? 1 : 0, `${name}/${action} exit code`);
  const gate = readJson(path.join(outDir, gateFile));
  assert.deepEqual(JSON.parse(result.stdout), gate, 'stdout must equal the native gate artifact');
  assert.equal(gate.status, blocked ? 'blocked' : 'passed');
  assert.equal(
    gate.next_action,
    blocked
      ? 'fix_build_plan'
      : action === 'validate'
        ? 'materialize_payload'
        : 'use_materialized_artifact',
  );
  record.gate_status = gate.status;
  record.blockers = gate.blockers;
  record.gate_sha256 = sha256(readFileSync(path.join(outDir, gateFile)));
  if (blocked) {
    assert.deepEqual(
      gate.blockers.map(({ code, path: field }) => ({ code, path: field })),
      [{ code: blocker, path: purposePath }],
    );
    assert.equal(gate.schema_validation.status, 'not_applicable');
    assert.equal(record.payload_exists, false);
    return null;
  }
  if (action === 'validate') {
    assert.equal(record.payload_exists, false);
    return null;
  }
  assert.equal(gate.schema_validation.status, 'passed');
  assert.equal(record.payload_exists, true);
  const bytes = readFileSync(path.join(outDir, payloadFile));
  const payload = JSON.parse(bytes);
  record.payload_sha256 = sha256(bytes);
  record.intended_applications = purposeOf(payload);
  return { payload, bytes };
}

try {
  const missingPurpose = structuredClone(fixture);
  delete missingPurpose.administrative_information;
  for (const action of ['validate', 'materialize']) {
    const result = runCase(
      'missing-purpose',
      action,
      missingPurpose,
      'build_plan_required_field_missing',
    );
    if (result) {
      assert.deepEqual(purposeOf(result.payload), [
        { '#text': 'Automated LCA data production draft for expert review.', '@xml:lang': 'en' },
      ]);
    }
  }
  const missingBinding = structuredClone(fixture);
  missingBinding.evidence_manifest.field_bindings =
    missingBinding.evidence_manifest.field_bindings.filter(
      ({ field_path }) => field_path !== purposePath,
    );
  for (const action of ['validate', 'materialize']) {
    const result = runCase('missing-binding', action, missingBinding, 'evidence_binding_missing');
    if (result) assert.deepEqual(purposeOf(result.payload), purpose);
  }
  const repaired = runCase('repaired-bilingual', 'materialize', fixture, null);
  assert.deepEqual(purposeOf(repaired.payload), purpose);
  const embedded = structuredClone(missingBinding);
  delete embedded.administrative_information;
  embedded.payload = repaired.payload;
  const preserved = runCase('embedded-payload', 'materialize', embedded, null);
  assert.deepEqual(preserved.payload, embedded.payload);
  assert.equal(sha256(preserved.bytes), sha256(repaired.bytes), 'embedded payload bytes unchanged');
  proof.embedded_payload_bytes_unchanged = true;
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  proof.finished_at = new Date().toISOString();
  writeJson(path.join(outDir, 'proof.json'), proof);
  console.log(JSON.stringify(proof, null, 2));
}
