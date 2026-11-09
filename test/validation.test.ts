import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError } from '../src/lib/errors.js';
import {
  resolveLocalSdkModule,
  resolveRepoRootFrom,
  resolveSdkModuleFromCandidates,
  runValidation,
} from '../src/lib/validation.js';

const currentFilePath = fileURLToPath(import.meta.url);

function makeValidationReport(inputDir: string, issueCode = 'schema_error') {
  return {
    input_dir: inputDir,
    ok: false,
    categories: [
      {
        category: 'processes',
        ok: false,
        issues: [
          {
            issue_code: issueCode,
            severity: 'error',
            category: 'processes',
            file_path: `${inputDir}/processes/demo.json`,
            message: 'Broken process dataset',
            location: '<root>',
            context: {},
          },
        ],
      },
    ],
  };
}

function makeSchemaSdkExports() {
  const success = () => ({ success: true as const });
  return {
    ContactSchema: { safeParse: success },
    FlowPropertySchema: { safeParse: success },
    FlowSchema: { safeParse: success },
    LCIAMethodSchema: { safeParse: success },
    LifeCycleModelSchema: { safeParse: success },
    ProcessSchema: { safeParse: success },
    SourceSchema: { safeParse: success },
    UnitGroupSchema: { safeParse: success },
  };
}

test('runValidation uses sdk mode, normalizes the report, and writes the report file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-sdk-'));
  const reportFile = path.join(dir, 'report.json');

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
        reportFile,
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => makeValidationReport(dir),
        }),
      },
    );

    assert.equal(report.mode, 'sdk');
    assert.equal(report.ok, false);
    assert.equal(report.summary.engine_count, 1);
    assert.equal(report.reports[0].engine, 'sdk');
    assert.equal(report.reports[0].location, '/tmp/sdk.js');
    assert.equal(report.reports[0].report.summary.issue_count, 1);
    assert.equal(statSync(reportFile).isFile(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation uses sdk validation in auto mode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-auto-'));

  try {
    const report = await runValidation(
      {
        inputDir: dir,
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => makeValidationReport(dir, 'sdk_error'),
        }),
      },
    );

    assert.equal(report.mode, 'auto');
    assert.equal(report.reports[0].engine, 'sdk');
    assert.equal(report.ok, false);
    assert.equal(report.comparison, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation can use the default local sdk loader when available', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-defaults-'));

  try {
    const localSdk = resolveLocalSdkModule();
    const sdkReport = await runValidation({
      inputDir: dir,
      engine: 'sdk',
    });

    assert.equal(typeof localSdk.validatePackageDir, 'function');
    assert.equal(localSdk.location, '@tiangong-lca/tidas-sdk');
    assert.equal(sdkReport.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation resolves sdk candidates and surfaces resolution failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-default-errors-'));

  try {
    const resolved = resolveSdkModuleFromCandidates(
      () => ({
        validatePackageDir: () => makeValidationReport(dir),
      }),
      ['/tmp/fake-sdk.js'],
    );
    assert.equal(resolved.location, '/tmp/fake-sdk.js');

    const synthesized = resolveSdkModuleFromCandidates(
      () => makeSchemaSdkExports(),
      ['/tmp/schema-only-sdk.js'],
    );
    const synthesizedReport = synthesized.validatePackageDir(dir, false) as { ok: boolean };
    assert.equal(synthesized.location, '/tmp/schema-only-sdk.js');
    assert.equal(synthesizedReport.ok, true);

    assert.throws(
      () =>
        resolveSdkModuleFromCandidates(
          (candidate) => {
            if (candidate.endsWith('broken-export.js')) {
              return {};
            }
            if (candidate.endsWith('throws-string.js')) {
              throw 'missing from string';
            }
            throw new Error('missing package');
          },
          ['/tmp/missing-package.js', '/tmp/throws-string.js', '/tmp/broken-export.js'],
        ),
      /Unable to resolve the direct tidas-sdk package validator/u,
    );

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
          },
          {
            loadSdkModule: () => {
              throw new CliError('broken sdk', {
                code: 'VALIDATION_SDK_BROKEN',
                exitCode: 1,
              });
            },
          },
        ),
      /broken sdk/u,
    );

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
          },
          {
            loadSdkModule: () => {
              throw new CliError('sdk unavailable', {
                code: 'VALIDATION_SDK_UNAVAILABLE',
                exitCode: 2,
              });
            },
          },
        ),
      /sdk unavailable/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation normalizes malformed issue payloads and report shapes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-normalize-'));

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: false,
            categories: [
              {
                category: 'flows',
                issues: [
                  null,
                  { severity: 'fatal', file_path: 'flows/demo.json' },
                  {
                    issue_code: 'bad_context',
                    severity: 'warning',
                    category: 'flows',
                    file_path: 42,
                    message: { detail: 'not a string' },
                    location: 9,
                    context: 'invalid',
                  },
                ],
              },
              null,
            ],
          }),
        }),
      },
    );

    assert.equal(report.reports[0].report.issues[0].message, 'null');
    assert.equal(report.reports[0].report.issues[1].severity, 'error');
    assert.equal(report.reports[0].report.issues[2].file_path, '<unknown>');
    assert.match(report.reports[0].report.issues[2].message, /"detail":"not a string"/u);
    assert.equal(report.reports[0].report.issues[2].location, '<root>');
    assert.deepEqual(report.reports[0].report.issues[2].context, {});
    assert.equal(report.reports[0].report.categories[1].category, 'unknown');
    assert.equal(report.reports[0].report.categories[1].ok, true);
    assert.deepEqual(report.reports[0].report.categories[1].issues, []);

    const emptyReport = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: true,
          }),
        }),
      },
    );

    assert.deepEqual(emptyReport.reports[0].report.categories, []);

    const stringReport = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => 'not-an-object',
        }),
      },
    );

    assert.equal(stringReport.reports[0].report.input_dir, dir);
    assert.deepEqual(stringReport.reports[0].report.categories, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoRootFrom falls back to process.cwd when no package.json exists above the start directory', () => {
  const resolved = resolveRepoRootFrom(path.parse(process.cwd()).root);
  assert.equal(resolved, process.cwd());
});

test('runValidation covers direct sdk mode and successful auto sdk mode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-modes-'));

  try {
    const sdkReport = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: true,
            categories: [],
          }),
        }),
      },
    );

    const autoReport = await runValidation(
      {
        inputDir: dir,
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: true,
            categories: [],
          }),
        }),
      },
    );

    assert.equal(sdkReport.reports[0].engine, 'sdk');
    assert.equal(autoReport.reports[0].engine, 'sdk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation validates the input directory and engine value', async () => {
  const fileDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-inputs-'));
  const missingDir = path.join(fileDir, 'missing');

  try {
    await assert.rejects(
      async () =>
        runValidation({
          inputDir: '',
        }),
      /Missing required --input-dir/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: missingDir,
        }),
      /not found/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: currentFilePath,
        }),
      /not a directory/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: fileDir,
          engine: 'tools',
        }),
      /Expected --engine/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: fileDir,
          engine: 'all',
        }),
      /Expected --engine/u,
    );
  } finally {
    rmSync(fileDir, { recursive: true, force: true });
  }
});

test('package validation locates the repository from nested module directories', () => {
  const root = resolveRepoRootFrom(path.dirname(currentFilePath));
  assert.equal(root, process.cwd());
});
