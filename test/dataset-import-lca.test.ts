import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { test } from 'node:test';
import { executeCli } from '../src/cli.js';
import { __testInternals, runDatasetImportLcaConvert } from '../src/lib/dataset/import-lca.js';

const deps = {
  env: {},
  dotEnvStatus: { loaded: false, path: '/tmp/.env', count: 0 },
  fetchImpl: async () => new Response('{}', { status: 200 }),
};

type JsonRecord = Record<string, unknown>;

function operationReport(
  command: 'version' | 'import',
  options: {
    status?: string;
    exitClass?: string;
    completeness?: string;
    summary?: JsonRecord;
    reportDestination?: string;
  } = {},
): JsonRecord {
  return {
    schema_version: 'tidas.operation-report.v1',
    command,
    status: options.status ?? 'succeeded',
    exit_class: options.exitClass ?? 'success',
    completeness: options.completeness ?? 'complete',
    invocation: {
      schema_version: 'tidas.invocation-context.v1',
      input_policy: 'explicit-path-or-dash',
      report_destination: options.reportDestination ?? 'stdout',
      diagnostic_destination: 'stderr',
    },
    summary:
      options.summary ??
      (command === 'version'
        ? {
            binary_version: '0.2.0',
            operation_report_schema: 'tidas.operation-report.v1',
          }
        : {
            import: {
              schema_version: 'tidas.import-execution-report.v1',
              detected_format: 'simapro-csv',
            },
          }),
    diagnostics: [],
    artifacts: [],
    next_actions: [],
  };
}

function spawnResult(
  report: JsonRecord,
  status = 0,
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: `${JSON.stringify(report)}\n`,
    stderr: '',
    status,
    signal: null,
    ...overrides,
  };
}

function successfulSpawn(
  calls: Array<{ executable: string; args: string[]; cwd: string | undefined }>,
  importReport = operationReport('import'),
): typeof spawnSync {
  return ((executable: string, args?: readonly string[], options?: { cwd?: string }) => {
    const commandArgs = [...(args ?? [])];
    calls.push({ executable, args: commandArgs, cwd: options?.cwd });
    return commandArgs[0] === 'version'
      ? spawnResult(operationReport('version'))
      : spawnResult(importReport);
  }) as unknown as typeof spawnSync;
}

function tempInput(): { dir: string; input: string; output: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-rust-import-'));
  const input = path.join(dir, 'source.csv');
  writeFileSync(input, 'fixture', 'utf8');
  return { dir, input, output: path.join(dir, 'output') };
}

test('dataset import-lca invokes the Rust binary with native defaults and stable report mapping', async () => {
  const fixture = tempInput();
  const calls: Array<{ executable: string; args: string[]; cwd: string | undefined }> = [];
  try {
    const report = await runDatasetImportLcaConvert({
      inputPath: fixture.input,
      outputDir: fixture.output,
      env: { TIDAS_BIN: 'tidas-from-env' },
      cwd: fixture.dir,
      now: new Date('2026-07-27T00:00:00.000Z'),
      spawnImpl: successfulSpawn(calls),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.executable, 'tidas-from-env');
    assert.deepEqual(calls[0]?.args, ['version', '--format', 'json', '--progress', 'never']);
    assert.deepEqual(calls[1]?.args, [
      'import',
      fixture.input,
      '--output',
      fixture.output,
      '--target',
      'tidas',
      '--format',
      'json',
      '--progress',
      'never',
    ]);
    assert.equal(report.schema_version, 'tiangong-lca.dataset-import-lca-report.v2');
    assert.equal(report.status, 'succeeded');
    assert.equal(report.exit_class, 'success');
    assert.equal(report.exit_code, 0);
    assert.equal(report.generated_at_utc, '2026-07-27T00:00:00.000Z');
    assert.equal(report.from_format, 'auto');
    assert.equal(report.tidas.version, '0.2.0');
    assert.equal(report.files.tidas_dir, path.join(fixture.output, 'tidas'));
    assert.equal(report.files.ilcd_dir, null);
    assert.equal(report.files.mapping_csv, null);
    assert.equal(report.files.process_bundles_dir, path.join(fixture.output, 'process-bundles'));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('dataset import-lca forwards every supported native control and reads file reports', async () => {
  const fixture = tempInput();
  const tidasBin = path.join(fixture.dir, 'tidas');
  const config = path.join(fixture.dir, 'tidas.toml');
  const nativeReport = path.join(fixture.dir, 'native-report.json');
  writeFileSync(tidasBin, 'binary', 'utf8');
  writeFileSync(config, 'config', 'utf8');
  const calls: Array<{ executable: string; args: string[]; cwd: string | undefined }> = [];
  const importReport = operationReport('import', { reportDestination: 'file' });
  const spawnImpl = ((executable: string, args?: readonly string[], options?: { cwd?: string }) => {
    const commandArgs = [...(args ?? [])];
    calls.push({ executable, args: commandArgs, cwd: options?.cwd });
    if (commandArgs[0] === 'version') {
      return spawnResult(
        operationReport('version', {
          summary: {
            binary_version: '0.2.91',
            operation_report_schema: 'tidas.operation-report.v1',
          },
        }),
      );
    }
    writeFileSync(nativeReport, JSON.stringify(importReport), 'utf8');
    return spawnResult(importReport, 0, { stdout: '' });
  }) as unknown as typeof spawnSync;

  try {
    const report = await runDatasetImportLcaConvert({
      inputPath: fixture.input,
      outputDir: fixture.output,
      fromFormat: 'simapro-csv',
      target: 'both',
      reportPath: nativeReport,
      writeMapping: true,
      processBundles: false,
      failOnWarning: true,
      maxEntryMib: 64,
      memoryBudgetMib: 128,
      queueCapacity: 8,
      tidasBin,
      tidasConfig: config,
      cwd: fixture.dir,
      platform: 'linux',
      arch: 'x64',
      spawnImpl,
    });

    assert.equal(report.tidas.executable, tidasBin);
    assert.equal(report.tidas.version, '0.2.91');
    assert.equal(report.files.report, nativeReport);
    assert.equal(report.files.tidas_dir, path.join(fixture.output, 'tidas'));
    assert.equal(report.files.ilcd_dir, path.join(fixture.output, 'ilcd'));
    assert.equal(report.files.mapping_csv, path.join(fixture.output, 'mapping.csv.gz'));
    assert.equal(report.files.process_bundles_dir, null);
    const args = calls[1]?.args ?? [];
    for (const expected of [
      '--from-format',
      'simapro-csv',
      '--report',
      nativeReport,
      '--config',
      config,
      '--write-mapping',
      '--no-process-bundles',
      '--fail-on-warning',
      '--max-entry-mib',
      '64',
      '--memory-budget-mib',
      '128',
      '--queue-capacity',
      '8',
    ]) {
      assert.ok(args.includes(expected), expected);
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('dataset import-lca CLI exposes only the native Rust surface and preserves tidas exits', async () => {
  const help = await executeCli(['dataset', 'import-lca', 'convert', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--tidas-bin/u);
  assert.match(help.stdout, /--memory-budget-mib/u);
  assert.match(help.stdout, /Windows ARM64 is unsupported/u);
  assert.doesNotMatch(help.stdout, /--python|--tidas-tools-dir|--detect-only/u);

  const namespaceHelp = await executeCli(['dataset', 'import-lca'], deps);
  assert.equal(namespaceHelp.exitCode, 0);
  const invalidAction = await executeCli(['dataset', 'import-lca', 'detect'], deps);
  assert.equal(invalidAction.exitCode, 2);

  const result = await executeCli(
    [
      'dataset',
      'import-lca',
      'convert',
      '--input',
      'fixture.csv',
      '--output-dir',
      'out',
      '--from-format',
      'simapro-csv',
      '--target',
      'ilcd',
      '--report',
      'native-report.json',
      '--write-mapping',
      '--no-process-bundles',
      '--fail-on-warning',
      '--max-entry-mib',
      '4',
      '--memory-budget-mib',
      '16',
      '--queue-capacity',
      '2',
      '--tidas-bin',
      '/opt/tidas',
      '--tidas-config',
      'tidas.toml',
      '--json',
    ],
    {
      ...deps,
      runDatasetImportLcaConvertImpl: async (options) => {
        assert.deepEqual(options, {
          inputPath: 'fixture.csv',
          outputDir: 'out',
          fromFormat: 'simapro-csv',
          target: 'ilcd',
          reportPath: 'native-report.json',
          writeMapping: true,
          processBundles: false,
          failOnWarning: true,
          maxEntryMib: 4,
          memoryBudgetMib: 16,
          queueCapacity: 2,
          tidasBin: '/opt/tidas',
          tidasConfig: 'tidas.toml',
          env: {},
        });
        return {
          schema_version: 'tiangong-lca.dataset-import-lca-report.v2',
          status: 'completed-with-issues',
          exit_class: 'data-issues',
          exit_code: 2,
        } as never;
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /completed-with-issues/u);

  for (const args of [
    ['dataset', 'import-lca', 'convert', '--python', 'python3'],
    ['dataset', 'import-lca', 'convert', '--tidas-tools-dir', '../tidas-tools'],
    ['dataset', 'import-lca', 'convert', '--detect-only'],
    ['dataset', 'import-lca', 'convert', '--max-entry-mib', '0'],
    ['dataset', 'import-lca', 'convert', '--memory-budget-mib', 'nope'],
    ['dataset', 'import-lca', 'convert', '--queue-capacity', '-1'],
  ]) {
    const invalid = await executeCli(args, deps);
    assert.equal(invalid.exitCode, 2, args.join(' '));
  }
});

test('discovery, platform, source, target, and runtime bounds fail closed', async () => {
  const fixture = tempInput();
  try {
    assert.equal(__testInternals.resolveTidasBinary(undefined, {}), 'tidas');
    assert.equal(
      __testInternals.resolveTidasBinary(undefined, { TIDAS_BIN: 'custom-tidas' }),
      'custom-tidas',
    );
    assert.equal(__testInternals.resolveTidasBinary(' explicit-tidas ', {}), 'explicit-tidas');
    assert.throws(
      () => __testInternals.resolveTidasBinary(path.join(fixture.dir, 'missing'), {}),
      /not found/u,
    );

    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'arm64'],
      ['win32', 'x64'],
    ] as const) {
      assert.doesNotThrow(() => __testInternals.assertSupportedPlatform(platform, arch));
    }
    assert.throws(() => __testInternals.assertSupportedPlatform('darwin', 'x64'), /No supported/u);
    assert.throws(() => __testInternals.assertSupportedPlatform('win32', 'arm64'), /No supported/u);
    assert.throws(() => __testInternals.assertSupportedPlatform('freebsd', 'x64'), /No supported/u);

    assert.equal(__testInternals.normalizeSourceFormat(undefined), 'auto');
    assert.equal(__testInternals.normalizeSourceFormat(' ilcd '), 'ilcd');
    assert.throws(() => __testInternals.normalizeSourceFormat('zolca'), /--from-format/u);
    assert.equal(__testInternals.normalizeTarget(undefined), 'tidas');
    assert.equal(__testInternals.normalizeTarget(' both '), 'both');
    assert.throws(() => __testInternals.normalizeTarget('invalid'), /--target/u);

    assert.doesNotThrow(() => __testInternals.requirePositiveInteger('--limit', undefined));
    assert.doesNotThrow(() => __testInternals.requirePositiveInteger('--limit', 1));
    assert.throws(() => __testInternals.requirePositiveInteger('--limit', 0), /positive/u);
    assert.throws(() => __testInternals.requirePositiveInteger('--limit', 1.5), /positive/u);
    assert.throws(
      () => __testInternals.requirePositiveInteger('--limit', Number.MAX_VALUE),
      /positive/u,
    );

    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: '',
          outputDir: fixture.output,
          spawnImpl: successfulSpawn([]),
        }),
      /Missing required --input/u,
    );
    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: path.join(fixture.dir, 'missing'),
          outputDir: fixture.output,
          spawnImpl: successfulSpawn([]),
        }),
      /Input path not found/u,
    );
    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: fixture.input,
          outputDir: '',
          spawnImpl: successfulSpawn([]),
        }),
      /Missing required --output-dir/u,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('machine contract parser rejects malformed and incompatible reports', () => {
  assert.throws(() => __testInternals.parseOperationReport('{', 'version'), /invalid JSON/u);
  const valid = operationReport('version');
  assert.equal(
    __testInternals.parseOperationReport(JSON.stringify(valid), 'version').command,
    'version',
  );

  const invalidReports: JsonRecord[] = [];
  const mutate = (key: string, value: unknown): void => {
    invalidReports.push({ ...valid, [key]: value });
  };
  mutate('schema_version', 'tidas.operation-report.v2');
  mutate('command', 'import');
  mutate('status', 'unknown');
  mutate('exit_class', 'unknown');
  mutate('completeness', 'unknown');
  mutate('invocation', null);
  mutate('invocation', { ...(valid.invocation as JsonRecord), schema_version: 'v2' });
  mutate('invocation', { ...(valid.invocation as JsonRecord), input_policy: 'implicit' });
  mutate('invocation', { ...(valid.invocation as JsonRecord), report_destination: 'other' });
  mutate('invocation', { ...(valid.invocation as JsonRecord), diagnostic_destination: 'stdout' });
  mutate('summary', null);
  mutate('diagnostics', null);
  mutate('artifacts', null);
  mutate('next_actions', null);
  for (const report of invalidReports) {
    assert.throws(
      () => __testInternals.parseOperationReport(JSON.stringify(report), 'version'),
      /Incompatible/u,
    );
  }
});

test('version and import handshakes accept compatible patches and reject drift', () => {
  const validVersion = __testInternals.parseOperationReport(
    JSON.stringify(operationReport('version')),
    'version',
  );
  assert.equal(__testInternals.readCompatibleVersion(validVersion), '0.2.0');

  for (const mutation of [
    { status: 'failed' },
    { exit_class: 'data-issues' },
    { completeness: 'partial' },
    { summary: { binary_version: '0.2.0', operation_report_schema: 'v2' } },
    {
      summary: {
        binary_version: '0.1.0',
        operation_report_schema: 'tidas.operation-report.v1',
      },
    },
    { summary: { operation_report_schema: 'tidas.operation-report.v1' } },
  ]) {
    const report = { ...validVersion, ...mutation } as never;
    assert.throws(() => __testInternals.readCompatibleVersion(report), /0\.2\.x/u);
  }

  const successfulImport = __testInternals.parseOperationReport(
    JSON.stringify(operationReport('import')),
    'import',
  );
  assert.doesNotThrow(() => __testInternals.assertImportContract(successfulImport));
  assert.doesNotThrow(() =>
    __testInternals.assertImportContract({
      ...successfulImport,
      status: 'completed-with-issues',
      exit_class: 'data-issues',
    }),
  );
  assert.doesNotThrow(() =>
    __testInternals.assertImportContract({
      ...successfulImport,
      status: 'failed',
      summary: {},
    }),
  );
  assert.throws(
    () =>
      __testInternals.assertImportContract({
        ...successfulImport,
        summary: { import: { schema_version: 'v2' } },
      }),
    /import summary/u,
  );
});

test('process report handling covers stdout, file, missing, invalid exit, spawn, and cancellation', async () => {
  const fixture = tempInput();
  const reportPath = path.join(fixture.dir, 'report.json');
  try {
    const reportText = JSON.stringify(operationReport('import'));
    assert.equal(
      __testInternals.readProcessReport(
        { status: 0, signal: null, stdout: reportText, stderr: '' },
        null,
      ),
      reportText,
    );
    writeFileSync(reportPath, reportText, 'utf8');
    assert.equal(
      __testInternals.readProcessReport(
        { status: 0, signal: null, stdout: '', stderr: '' },
        reportPath,
      ),
      reportText,
    );
    assert.throws(
      () =>
        __testInternals.readProcessReport(
          { status: 70, signal: null, stdout: '', stderr: 'failed' },
          path.join(fixture.dir, 'missing-report'),
        ),
      /did not write/u,
    );
    for (const run of [
      { status: 130, signal: null, stdout: '', stderr: '' },
      { status: null, signal: 'SIGINT' as const, stdout: '', stderr: '' },
    ]) {
      assert.throws(() => __testInternals.readProcessReport(run, null), /cancelled/u);
      assert.throws(
        () =>
          __testInternals.readProcessReport(
            run,
            path.join(fixture.dir, `cancelled-${String(run.status)}-${String(run.signal)}.json`),
          ),
        /cancelled/u,
      );
    }
    assert.throws(
      () =>
        __testInternals.readProcessReport(
          { status: 70, signal: null, stdout: '', stderr: 'failed' },
          null,
        ),
      /machine-readable/u,
    );

    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: fixture.input,
          outputDir: fixture.output,
          platform: 'darwin',
          arch: 'arm64',
          spawnImpl: (() =>
            spawnResult(operationReport('version'), 0, {
              error: new Error('ENOENT'),
            })) as unknown as typeof spawnSync,
        }),
      /Could not execute/u,
    );

    const calls: unknown[] = [];
    const mismatchSpawn = ((_: string, args?: readonly string[]) => {
      calls.push(args);
      return args?.[0] === 'version'
        ? spawnResult(operationReport('version'))
        : spawnResult(operationReport('import'), 2);
    }) as unknown as typeof spawnSync;
    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: fixture.input,
          outputDir: fixture.output,
          platform: 'darwin',
          arch: 'arm64',
          spawnImpl: mismatchSpawn,
        }),
      /disagrees/u,
    );
    assert.equal(calls.length, 2);

    const ilcdOnly = await runDatasetImportLcaConvert({
      inputPath: fixture.input,
      outputDir: fixture.output,
      target: 'ilcd',
      platform: 'darwin',
      arch: 'arm64',
      spawnImpl: successfulSpawn([]),
    });
    assert.equal(ilcdOnly.files.tidas_dir, null);
    assert.equal(ilcdOnly.files.ilcd_dir, path.join(fixture.output, 'ilcd'));

    await assert.rejects(
      () =>
        runDatasetImportLcaConvert({
          inputPath: fixture.input,
          outputDir: fixture.output,
          platform: 'darwin',
          arch: 'arm64',
          spawnImpl: (() => ({
            pid: 1,
            output: [],
            stdout: undefined,
            stderr: undefined,
            status: 70,
            signal: null,
          })) as unknown as typeof spawnSync,
        }),
      /machine-readable/u,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('packaged smoke fixture is the frozen SimaPro parity input', () => {
  const fixture = new URL('../assets/import-smoke/simapro.csv', import.meta.url);
  assert.equal(existsSync(fixture), true);
  const text = readFileSync(fixture, 'utf8');
  assert.match(text, /\{SimaPro 8\.0\}/u);
  assert.match(text, /Test process/u);
  assert.match(text, /carbon dioxide/u);
});
