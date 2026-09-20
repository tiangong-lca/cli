import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { __testInternals, runDatasetContract } from '../src/lib/dataset-contract.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

const deps = {
  env: {},
  dotEnvStatus,
  fetchImpl: (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ ok: true }),
  })) as FetchLike,
};

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('installed SDK 0.3.0 omits the retired mixed ruleset input and getter', () => {
  const requireFromHere = createRequire(import.meta.url);
  const contractsPath = requireFromHere.resolve('@tiangong-lca/tidas-sdk/contracts');
  const sdkRoot = path.resolve(path.dirname(contractsPath), '..');
  const contracts = requireFromHere('@tiangong-lca/tidas-sdk/contracts') as Record<string, unknown>;

  assert.equal(
    existsSync(path.join(sdkRoot, 'runtime-assets/tidas/methodologies/runtime_rulesets.json')),
    false,
  );
  assert.equal(
    existsSync(
      path.join(sdkRoot, 'runtime-assets/tidas/methodologies/runtime_rulesets.schema.json'),
    ),
    false,
  );
  assert.equal('getTidasRuntimeRuleset' in contracts, false);
});

test('runDatasetContract writes process contract artifacts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-dataset-contract-'));
  try {
    const report = await runDatasetContract({
      type: 'process',
      include: 'schema,methodology,ruleset',
      profile: 'ai-import',
      outDir: dir,
      mode: 'context-pack',
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.type, 'process');
    assert.equal(report.profile, 'ai-import');
    assert.equal(existsSync(report.files.manifest), true);
    assert.equal(existsSync(report.files.schema ?? ''), true);
    assert.equal(existsSync(report.files.methodology ?? ''), true);
    assert.equal(existsSync(report.files.ruleset ?? ''), true);
    assert.equal(existsSync(report.files.ai_context_json ?? ''), true);
    assert.equal(existsSync(report.files.ai_context_markdown ?? ''), true);
    assert.match(readFileSync(report.files.schema ?? '', 'utf8'), /processDataSet/u);
    assert.match(
      readFileSync(report.files.methodology ?? '', 'utf8'),
      /Process Dataset Content Rules/u,
    );
    assert.deepEqual(readJson(report.files.report), report);

    const manifest = readJson(report.files.manifest) as {
      schema?: { sha256?: string };
      methodology?: { sha256?: string };
    };
    assert.match(manifest.schema?.sha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.match(manifest.methodology?.sha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.deepEqual((manifest as { includes?: string[] }).includes, [
      'schema',
      'methodology',
      'ruleset',
    ]);
    const context = readJson(report.files.ai_context_json ?? '') as { runtime_ruleset?: unknown };
    assert.deepEqual(context.runtime_ruleset, readJson(report.files.ruleset ?? ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli exposes dataset contract and context-pack commands', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-context-pack-'));
  try {
    const contractHelp = await executeCli(['dataset', 'contract', 'get', '--help'], deps);
    assert.equal(contractHelp.exitCode, 0);
    assert.match(contractHelp.stdout, /dataset contract get/u);

    const namespaceHelp = await executeCli(['dataset', 'contract'], deps);
    assert.equal(namespaceHelp.exitCode, 0);
    assert.match(namespaceHelp.stdout, /dataset contract get/u);

    const contractReport = {
      schema_version: 1,
      status: 'completed',
      generated_at_utc: '2026-06-01T00:00:00.000Z',
      mode: 'contract',
      requested_type: 'process',
      type: 'process',
      profile: 'default',
      includes: ['schema'],
      source: 'sdk-contract-api',
      manifest: {},
      files: {
        manifest: 'manifest.json',
        schema: 'schema.json',
        methodology: null,
        ruleset: null,
        ai_context_json: null,
        ai_context_markdown: null,
        report: 'contract-report.json',
      },
    } satisfies Awaited<ReturnType<typeof runDatasetContract>>;
    const contractResult = await executeCli(
      [
        'dataset',
        'contract',
        'get',
        '--type',
        'process',
        '--include',
        'schema',
        '--profile',
        'ai-import',
        '--out-dir',
        dir,
      ],
      {
        ...deps,
        runDatasetContractImpl: async (options) => ({
          ...contractReport,
          requested_type: String(options.type),
          type: String(options.type),
          profile: options.profile === 'ai-import' ? 'ai-import' : 'default',
        }),
      },
    );
    assert.equal(contractResult.exitCode, 0);
    assert.equal(JSON.parse(contractResult.stdout).type, 'process');
    assert.equal(JSON.parse(contractResult.stdout).profile, 'ai-import');

    const invalidAction = await executeCli(['dataset', 'contract', 'show'], deps);
    assert.equal(invalidAction.exitCode, 2);
    assert.match(invalidAction.stderr, /dataset contract action must be 'get'/u);

    const invalidFlags = await executeCli(['dataset', 'contract', 'get', '--bad'], deps);
    assert.equal(invalidFlags.exitCode, 2);
    assert.match(invalidFlags.stderr, /INVALID_ARGS/u);

    const help = await executeCli(['dataset', 'context-pack', '--help'], deps);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /dataset context-pack/u);

    const result = await executeCli(
      ['dataset', 'context-pack', '--type', 'flow', '--out-dir', dir, '--json'],
      deps,
    );
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout) as {
      type: string;
      files: { schema: string; ai_context_json: string };
    };
    assert.equal(payload.type, 'flow');
    assert.equal(existsSync(payload.files.schema), true);
    assert.equal(existsSync(payload.files.ai_context_json), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset contract flag normalization rejects unsupported includes', () => {
  assert.throws(() => __testInternals.normalizeIncludes('schema,unknown'), /--include values/u);
});

test('runDatasetContract validates required contract inputs', async () => {
  await assert.rejects(
    () =>
      runDatasetContract({
        type: 'process',
        include: 'schema',
        outDir: null,
        mode: 'contract',
      }),
    /Missing required --out-dir/u,
  );
});

test('dataset contract internals cover fallback-only branches', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-fallback-'));
  mkdirSync(path.join(dir, 'tidas/schemas'), { recursive: true });
  try {
    const pack = __testInternals.loadFallbackContractPack({
      type: 'contact',
      includes: ['methodology'],
      profile: 'default',
      includeAiContext: false,
      runtimeAssetsRoot: dir,
    });
    assert.equal((pack.manifest as { schema: unknown }).schema, null);
    assert.equal((pack.manifest as { methodology: unknown }).methodology, null);
    assert.equal((pack.manifest as { ruleset: unknown }).ruleset, null);
    assert.equal(pack.aiContext, undefined);

    const missingSchemaPack = __testInternals.loadFallbackContractPack({
      type: 'contact',
      includes: ['schema'],
      profile: 'default',
      includeAiContext: false,
      runtimeAssetsRoot: dir,
    });
    assert.equal(missingSchemaPack.schemaText, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(__testInternals.normalizeType('life-cycle_model'), 'lifecyclemodel');
  assert.throws(() => __testInternals.normalizeType(undefined), /Missing required --type/u);
  assert.throws(
    () => __testInternals.normalizeType('bad-kind'),
    /Unsupported dataset contract type/u,
  );
  assert.throws(() => __testInternals.normalizeIncludes(['']), /At least one --include/u);
  assert.equal(__testInternals.normalizeProfile('ai-import'), 'ai-import');
  assert.throws(() => __testInternals.normalizeProfile('draft'), /--profile/u);
  assert.throws(
    () =>
      __testInternals.resolveSdkRuntimeAssetsRoot(
        [path.join(os.tmpdir(), 'missing-sdk-assets')],
        '/tmp/sdk/index.js',
      ),
    /Could not resolve @tiangong-lca\/tidas-sdk runtime assets/u,
  );

  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-root-'));
  const packageOnlyRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-package-only-'));
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'package.json'), '{}', 'utf8');
  writeFileSync(path.join(repoRoot, 'src/cli.ts'), '', 'utf8');
  writeFileSync(path.join(packageOnlyRoot, 'package.json'), '{}', 'utf8');
  try {
    assert.equal(
      __testInternals.resolveCliRepoRoot([path.join(repoRoot, 'missing'), repoRoot]),
      repoRoot,
    );
    assert.equal(__testInternals.resolveCliRepoRoot([packageOnlyRoot, repoRoot]), repoRoot);
    assert.equal(
      __testInternals.resolveCliRepoRoot([path.join(repoRoot, 'missing')]),
      path.join(repoRoot, 'missing'),
    );
    assert.equal(
      __testInternals.resolveSdkRuntimeAssetsRoot([repoRoot], '/tmp/sdk/index.js'),
      repoRoot,
    );
    assert.equal(__testInternals.resolveCliRepoRoot(), process.cwd());
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(packageOnlyRoot, { recursive: true, force: true });
  }

  const schemaRoot = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-schema-root-'));
  mkdirSync(path.join(schemaRoot, 'tidas/schemas'), { recursive: true });
  writeFileSync(
    path.join(schemaRoot, 'tidas/schemas/tidas_contacts.json'),
    '{"type":"object"}',
    'utf8',
  );
  try {
    const pack = __testInternals.loadFallbackContractPack({
      type: 'contact',
      includes: ['schema'],
      profile: 'default',
      includeAiContext: false,
      runtimeAssetsRoot: schemaRoot,
    });
    assert.equal(pack.schemaText, '{"type":"object"}');
  } finally {
    rmSync(schemaRoot, { recursive: true, force: true });
  }

  const markdown = __testInternals.renderAiContextMarkdown('source', {
    manifest: {},
    aiContext: { instructions: 'not-an-array' },
  });
  assert.match(markdown, /# TIDAS source AI Context/u);
  assert.match(markdown, /## Instructions\n/u);

  const markdownWithoutContext = __testInternals.renderAiContextMarkdown('flow', {
    manifest: {},
    aiContext: [],
  });
  assert.match(markdownWithoutContext, /# TIDAS flow AI Context/u);
});

test('dataset contract internals build full fallback packs and AI context', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-full-fallback-'));
  const runtimeRoot = path.join(dir, 'runtime-assets');
  mkdirSync(path.join(runtimeRoot, 'tidas/schemas'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'tidas/methodologies'), { recursive: true });
  writeFileSync(
    path.join(runtimeRoot, 'tidas/schemas/tidas_flows.json'),
    '{"title":"Flow"}',
    'utf8',
  );
  writeFileSync(
    path.join(runtimeRoot, 'tidas/methodologies/tidas_flows.yaml'),
    'title: Flow Methodology\n',
    'utf8',
  );
  // The retired SDK mixed file must not be read, even if a stale checkout has one.
  writeFileSync(
    path.join(runtimeRoot, 'tidas/methodologies/runtime_rulesets.json'),
    '{bad json',
    'utf8',
  );

  try {
    const sdkEntry = path.join(dir, 'sdk/dist/index.js');
    mkdirSync(path.dirname(sdkEntry), { recursive: true });
    mkdirSync(path.join(path.dirname(sdkEntry), 'runtime-assets'), { recursive: true });
    assert.match(
      __testInternals.resolveSdkRuntimeAssetsRoot(undefined, sdkEntry),
      /runtime-assets$/u,
    );

    const pack = __testInternals.loadFallbackContractPack({
      type: 'flow',
      includes: ['schema', 'methodology', 'ruleset'],
      profile: 'ai-import',
      includeAiContext: true,
      runtimeAssetsRoot: runtimeRoot,
    });
    assert.equal(pack.schemaText, '{"title":"Flow"}');
    assert.match(pack.methodologyText ?? '', /Flow Methodology/u);
    assert.equal(
      (pack.runtimeRuleset as { rules?: Array<{ id: string }> }).rules?.[0]?.id,
      'tidas.flow.name.base-name.technical',
    );
    assert.equal((pack.aiContext as { kind?: string }).kind, 'flow');
    assert.match(
      JSON.stringify((pack.manifest as { ruleset?: unknown }).ruleset),
      /runtime_rulesets/u,
    );

    const aiContext = __testInternals.buildAiContext({
      type: 'source',
      profile: 'default',
      schemaText: '{}',
      methodologyText: 'method: true',
      runtimeRuleset: { rules: [] },
    }) as { instructions: string[]; schema_text: string };
    assert.match(aiContext.instructions.join('\n'), /canonical TIDAS source/u);
    assert.equal(aiContext.schema_text, '{}');
    assert.deepEqual(__testInternals.artifactManifest('x.json', '{}'), {
      name: 'x.json',
      sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      bytes: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetContract can consume a future SDK contract API', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-sdk-contract-api-'));
  try {
    let sdkIncludes: unknown;
    const report = await runDatasetContract({
      type: 'process',
      include: ['schema', 'ruleset'],
      outDir: dir,
      mode: 'contract',
      sdkModule: {
        getTidasContractPack: (type: string, options: unknown) => {
          sdkIncludes = (options as { include: unknown }).include;
          return { manifest: { type }, schemaText: '{"type":"object"}' };
        },
      },
    });

    assert.equal(report.source, 'sdk-contract-api');
    assert.deepEqual(sdkIncludes, ['schema']);
    assert.equal(existsSync(report.files.ruleset ?? ''), true);
    assert.match(readFileSync(report.files.schema ?? '', 'utf8'), /object/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDatasetContract handles fallback and sparse SDK contract packs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-contract-sparse-'));
  const runtimeRoot = path.join(dir, 'runtime-assets');
  mkdirSync(path.join(runtimeRoot, 'tidas/schemas'), { recursive: true });
  try {
    const fallbackReport = await runDatasetContract({
      type: 'contact',
      include: 'methodology',
      outDir: path.join(dir, 'fallback'),
      mode: 'contract',
      sdkModule: {},
      runtimeAssetsRoot: runtimeRoot,
    });
    assert.equal(fallbackReport.source, 'sdk-runtime-assets');
    assert.equal(fallbackReport.files.schema, null);

    const contextReport = await runDatasetContract({
      type: 'flow',
      include: 'schema',
      outDir: path.join(dir, 'context'),
      mode: 'context-pack',
      sdkModule: {
        getTidasContractPack: () => ({
          manifest: {},
          schemaText: '{"type":"object"}',
        }),
      },
    });
    assert.equal(contextReport.files.ai_context_json, null);
    assert.equal(existsSync(contextReport.files.ai_context_markdown ?? ''), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset contract prefers the canonical SDK sibling and keeps the legacy sibling', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-sdk-siblings-'));
  const cliRoot = path.join(dir, 'cli');
  const canonicalSibling = path.join(dir, 'tidas-sdks/sdks/typescript/src/runtime-assets');
  const legacySibling = path.join(dir, 'tidas-sdk/sdks/typescript/src/runtime-assets');
  const sdkEntry = path.join(dir, 'installed/dist/index.js');
  const packagedRoot = path.join(dir, 'installed/dist/runtime-assets');
  mkdirSync(path.join(cliRoot, 'src'), { recursive: true });
  writeFileSync(path.join(cliRoot, 'package.json'), '{}', 'utf8');
  writeFileSync(path.join(cliRoot, 'src/cli.ts'), '', 'utf8');
  try {
    assert.equal(__testInternals.isCliSourceRoot(cliRoot), true);
    assert.equal(
      __testInternals.resolveCliRepoRoot([cliRoot]),
      cliRoot,
      'a verified source checkout is the development mode signal',
    );

    mkdirSync(canonicalSibling, { recursive: true });
    mkdirSync(legacySibling, { recursive: true });
    assert.deepEqual(__testInternals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot), [
      canonicalSibling,
      legacySibling,
      packagedRoot,
    ]);
    assert.equal(
      __testInternals.resolveSdkRuntimeAssetsRoot(
        __testInternals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot),
        sdkEntry,
      ),
      canonicalSibling,
    );

    rmSync(canonicalSibling, { recursive: true, force: true });
    assert.equal(
      __testInternals.resolveSdkRuntimeAssetsRoot(
        __testInternals.sdkRuntimeAssetsCandidates(sdkEntry, cliRoot),
        sdkEntry,
      ),
      legacySibling,
      'checkouts that predate the rename still resolve their sibling checkout',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset contract keeps packaged SDK assets standalone outside a source checkout', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-sdk-packaged-'));
  const installedRoot = path.join(dir, 'installed');
  const sdkEntry = path.join(installedRoot, 'dist/index.js');
  const packagedRoot = path.join(installedRoot, 'dist/runtime-assets');
  const absentSourceSibling = path.join(dir, 'tidas-sdks/sdks/typescript/src/runtime-assets');
  mkdirSync(path.dirname(sdkEntry), { recursive: true });
  mkdirSync(packagedRoot, { recursive: true });
  writeFileSync(sdkEntry, '', 'utf8');
  try {
    // Present on disk, but an installed CLI must never adopt it: the sibling only
    // counts when the CLI itself is a verified source checkout.
    mkdirSync(absentSourceSibling, { recursive: true });
    assert.equal(__testInternals.isCliSourceRoot(installedRoot), false);
    const candidates = __testInternals.sdkRuntimeAssetsCandidates(sdkEntry, installedRoot);
    assert.deepEqual(candidates, [packagedRoot]);
    assert.equal(__testInternals.resolveSdkRuntimeAssetsRoot(candidates, sdkEntry), packagedRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
