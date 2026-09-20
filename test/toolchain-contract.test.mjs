import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(TEST_DIR);
const PACKAGE_JSON_PATH = join(REPOSITORY_ROOT, 'package.json');
const PACKAGE_JSON = readJson(PACKAGE_JSON_PATH);
const EXPECTED_BATCH_RUNTIME_EXPORTS = Object.freeze([
  'BatchContractError',
  'BatchItemIdentityDriftError',
  'BatchItemProjectionDriftError',
  'BatchItemResourceDriftError',
  'BatchItemResumeContractError',
  'BatchMutationReplayError',
  'BatchMutationRetryError',
  'BatchRunLockIdentityConflictError',
  'BatchRunLockTimeoutError',
  'MAX_BATCH_CONCURRENCY',
  'assertBatchContractMatches',
  'assertBatchItemContractMatches',
  'batchRunLockPath',
  'batchRunLockStatePath',
  'canonicalBatchJson',
  'createBatchContract',
  'createBatchItemContract',
  'parseBatchContract',
  'parseBatchItemContract',
  'runBoundedBatch',
  'sha256BatchBytes',
  'sha256BatchJson',
  'withBatchRunLock',
]);
const EXPECTED_RUNTIME_RUNTIME_EXPORTS = Object.freeze([
  'CLI_RUNTIME_DESCRIPTOR_SCHEMA',
  'CLI_RUNTIME_EXPECTATION_SCHEMA',
  'RUNTIME_ARCHIVE_FORMAT',
  'RUNTIME_BOOTSTRAP_PROTOCOL',
  'RUNTIME_HOST_CONTEXT_PROTOCOL',
  'RUNTIME_MANIFEST_SCHEMA',
  'RUNTIME_PLATFORMS',
  'assertCliRuntimeMatches',
  'assertWorkspaceCompatibility',
  'copyTrustedRuntimeManifestBytes',
  'describeCliRuntime',
  'ensureRuntimeComponents',
  'executeRuntimeLaunch',
  'inspectRuntimeComponents',
  'loadTrustedRuntimeManifest',
  'parseRuntimeManifest',
  'pruneRuntimeComponents',
  'receiveRuntimeHostContext',
  'trustRuntimeManifest',
  'writeRuntimeComponentArchive',
]);
const EXPECTED_AUTH_IDENTITY_RUNTIME_EXPORTS = Object.freeze([
  'AUTH_IDENTITY_MAX_TIMEOUT_MS',
  'AUTH_IDENTITY_RECEIPT_SCHEMA',
  'parseAuthIdentityReceipt',
]);
const PACKAGE_MANAGER = 'pnpm@11.24.0';
const PACKAGE_MANAGER_VERSION = PACKAGE_MANAGER.slice('pnpm@'.length);
const NODE_VERSION = '24.19.0';
const PNPM_SETUP_ACTION = '84cb39b217b10273981911c288cd62326dc7c6d2';

const PACKAGE_LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'yarn.lock',
]);

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

const FORBIDDEN_TYPESCRIPT_COMPATIBILITY_NAMES = [
  /^@typescript-eslint\//u,
  /^typescript-eslint$/u,
  /^ts-eslint$/u,
  /^typescript[-_]?compat/u,
  /^typescript[-_]?[56](?:$|[-_])/u,
  /^ts[-_]?[56](?:$|[-_])/u,
];

const FORBIDDEN_PUBLISHED_TOOLS = new Set([
  '@eslint/js',
  'c8',
  'eslint',
  'jest',
  'lint-staged',
  'oxlint',
  'oxlint-tsgolint',
  'playwright',
  'playwright-core',
  'prettier',
  'ts-jest',
  'ts-node',
  'tsx',
  'typescript',
  'typescript-eslint',
  'vitest',
]);

const NPM_PACKAGE_COMMAND_PATTERN =
  /\b(?:npx|npm\s+(?:add|audit|cache|ci|config|dedupe|exec|fund|i|install|link|list|ls|outdated|pack|pkg|prune|publish|rebuild|remove|run|test|uninstall|unlink|update|version|view|whoami))\b/iu;

test('the repository pins the exact supported pnpm and has one root pnpm lockfile', () => {
  assert.equal(process.version, `v${NODE_VERSION}`);
  assert.equal(readFileSync(join(REPOSITORY_ROOT, '.nvmrc'), 'utf8').trim(), NODE_VERSION);
  assert.equal(PACKAGE_JSON.engines?.node, `>=${NODE_VERSION} <25`);
  assert.equal(PACKAGE_JSON.packageManager, PACKAGE_MANAGER);
  assert.equal(PACKAGE_JSON.engines?.pnpm, PACKAGE_MANAGER_VERSION);

  const activeVersion = execFileSync('pnpm', ['--version'], commandOptions(REPOSITORY_ROOT)).trim();
  assert.equal(
    activeVersion,
    PACKAGE_MANAGER_VERSION,
    `the active pnpm must match ${PACKAGE_MANAGER}, received ${activeVersion}`,
  );

  const lockfiles = findFiles(REPOSITORY_ROOT, (path) =>
    PACKAGE_LOCKFILE_NAMES.has(basename(path)),
  ).map(displayPath);

  assert.deepEqual(
    lockfiles,
    ['pnpm-lock.yaml'],
    `remove non-pnpm or nested package-manager lockfiles:\n${formatJson(lockfiles)}`,
  );
});

test('pnpm build permissions and release-age exceptions are exact and versioned', () => {
  const workspaceText = readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspaceText, /allowBuilds:\n  esbuild: true\n  fsevents: false/u);

  const exceptions = [...workspaceText.matchAll(/^  - ['"]?(.+?)['"]?$/gmu)].map(
    (match) => match[1],
  );
  assert.equal(exceptions.length, 20);
  assert.equal(exceptions.includes('@oxlint/binding-darwin-x64@1.80.0'), false);
  for (const target of ['darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'])
    assert.ok(exceptions.includes(`@oxlint/binding-${target}@1.80.0`));
  assert.deepEqual(
    exceptions.filter(
      (entry) =>
        !/^(?:oxlint|@oxlint\/binding-[a-z0-9-]+)@1\.80\.0$/u.test(entry) &&
        entry !== '@tiangong-lca/tidas-sdk@0.3.0',
    ),
    [],
    `minimum-release-age exceptions must stay exact and versioned:\n${formatJson(exceptions)}`,
  );
  assert.match(workspaceText, /overrides:\n  brace-expansion: 5\.0\.9\n  ws: 8\.21\.3/u);
});

test('all manifests and both recursive pnpm trees contain only direct TypeScript 7', () => {
  const manifests = findFiles(REPOSITORY_ROOT, (path) => basename(path) === 'package.json');
  const declarations = [];
  const compatibilityFindings = [];

  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (name === 'typescript') {
          declarations.push({ manifest: displayPath(manifestPath), section, range });
        }
        if (
          FORBIDDEN_TYPESCRIPT_COMPATIBILITY_NAMES.some((pattern) => pattern.test(name)) ||
          /^npm:typescript@/iu.test(String(range))
        ) {
          compatibilityFindings.push({
            manifest: displayPath(manifestPath),
            section,
            name,
            range,
          });
        }
      }
    }
  }

  assert.ok(declarations.length > 0, 'a direct TypeScript dependency must be declared');
  assert.deepEqual(
    declarations.filter(({ range }) => !isTypeScript7Range(range)),
    [],
    `direct TypeScript declarations must be 7.x:\n${formatJson(declarations)}`,
  );
  assert.deepEqual(
    compatibilityFindings,
    [],
    `remove TypeScript compatibility aliases and legacy ESLint bridges:\n${formatJson(
      compatibilityFindings,
    )}`,
  );

  const lockText = readFileSync(join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lockText, /(?:@typescript-eslint\/|typescript-eslint|ts-eslint)/iu);
  assert.doesNotMatch(lockText, /npm:typescript@/iu);

  for (const [label, lockfileOnly] of [
    ['installed', false],
    ['lockfile-only', true],
  ]) {
    const tree = pnpmList(REPOSITORY_ROOT, 'typescript', {
      recursive: true,
      lockfileOnly,
    });
    const versions = collectDependencyVersions(tree, 'typescript');
    assert.ok(versions.length > 0, `the recursive ${label} tree must contain TypeScript 7`);
    assert.deepEqual(
      versions.filter(({ version }) => majorVersion(version) !== 7),
      [],
      `the recursive ${label} tree contains non-7 TypeScript:\n${formatJson(versions)}`,
    );
  }
});

test('active automation uses pnpm commands and a current pnpm setup action', () => {
  const findings = [];

  const manifestPaths = findFiles(REPOSITORY_ROOT, (path) => basename(path) === 'package.json');
  for (const manifestPath of manifestPaths) {
    const manifest = readJson(manifestPath);
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      collectPackageCommandFinding(manifestPath, `scripts.${name}`, command, findings);
    }

    for (const [pattern, command] of Object.entries(manifest['lint-staged'] ?? {})) {
      const commands = Array.isArray(command) ? command : [command];
      for (const entry of commands) {
        collectPackageCommandFinding(manifestPath, `lint-staged.${pattern}`, entry, findings);
      }
    }
  }

  const automationRoots = [
    join(REPOSITORY_ROOT, '.github', 'actions'),
    join(REPOSITORY_ROOT, '.github', 'workflows'),
    join(REPOSITORY_ROOT, '.githooks'),
    join(REPOSITORY_ROOT, 'scripts'),
  ];
  const legacySetupActions = [];
  const setupActions = [];

  for (const automationRoot of automationRoots) {
    for (const automationPath of findFiles(automationRoot, () => true)) {
      const content = readFileSync(automationPath, 'utf8');
      collectActiveCommandFindings(automationPath, content, findings);
      legacySetupActions.push(
        ...[...content.matchAll(/pnpm\/action-setup@([^\s'"#]+)/giu)].map((match) => ({
          file: displayPath(automationPath),
          version: match[1],
        })),
      );
      setupActions.push(
        ...[...content.matchAll(/pnpm\/setup@([^\s'"#]+)/giu)].map((match) => ({
          file: displayPath(automationPath),
          version: match[1],
        })),
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    `active npm or npx package-management commands remain:\n${formatJson(findings)}`,
  );
  assert.deepEqual(legacySetupActions, [], 'the retired pnpm/action-setup action must not remain');
  assert.ok(setupActions.length > 0, 'workflows must install pnpm through pnpm/setup');
  assert.deepEqual(
    setupActions.filter(({ version }) => version !== PNPM_SETUP_ACTION),
    [],
    `pnpm/setup must use the reviewed immutable v2.0.2 revision:\n${formatJson(setupActions)}`,
  );

  const launcherGuidanceFindings = [];
  for (const launcherPath of findFiles(join(REPOSITORY_ROOT, 'bin'), () => true)) {
    const lines = readFileSync(launcherPath, 'utf8').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (NPM_PACKAGE_COMMAND_PATTERN.test(line)) {
        launcherGuidanceFindings.push({
          file: displayPath(launcherPath),
          line: index + 1,
          guidance: line.trim(),
        });
      }
    }
  }
  assert.deepEqual(
    launcherGuidanceFindings,
    [],
    `launcher guidance still tells users to use npm or npx:\n${formatJson(
      launcherGuidanceFindings,
    )}`,
  );
});

test('active maintainer documentation exposes only pnpm package-management commands', () => {
  const documentationPaths = [
    join(REPOSITORY_ROOT, 'AGENTS.md'),
    join(REPOSITORY_ROOT, 'DEV_CN.md'),
    join(REPOSITORY_ROOT, 'README.md'),
    ...findFiles(join(REPOSITORY_ROOT, 'docs'), (path) => path.endsWith('.md')),
  ];
  const findings = [];

  for (const documentationPath of documentationPaths) {
    const content = readFileSync(documentationPath, 'utf8');
    if (/^status:\s*historical\s*$/mu.test(content)) {
      continue;
    }
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (
        NPM_PACKAGE_COMMAND_PATTERN.test(line) &&
        !/(?:Historical npm-era|historical npm-era|retired; do not use as current instructions)/u.test(
          line,
        )
      ) {
        findings.push({
          file: displayPath(documentationPath),
          line: index + 1,
          command: line.trim(),
        });
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `active maintainer documentation still exposes npm or npx commands:\n${formatJson(findings)}`,
  );

  const implementationGuide = readFileSync(
    join(REPOSITORY_ROOT, 'docs', 'IMPLEMENTATION_GUIDE_CN.md'),
    'utf8',
  );
  assert.match(implementationGuide, /^\| 命令组 \| 必需 env \|\n\| --- \| --- \|$/mu);
  assert.doesNotMatch(implementationGuide, /\| 命令组 \| 必需 env \| \|/u);
});

test('workflows use the reviewed Node 24 pnpm setup, frozen installs, and trusted publish path', () => {
  const workflowRoot = join(REPOSITORY_ROOT, '.github', 'workflows');
  const workflowPaths = findFiles(workflowRoot, (path) => /\.ya?ml$/u.test(path));
  const requiredNodeWorkflows = new Set([
    '.github/workflows/publish.yml',
    '.github/workflows/quality-gate.yml',
    '.github/workflows/tag-release-from-merge.yml',
  ]);
  const setupFindings = [];
  const installFindings = [];
  const workflowsUsingNode = [];

  for (const workflowPath of workflowPaths) {
    const content = readFileSync(workflowPath, 'utf8');
    if (/\bpnpm\s+(?:install|run|exec|publish)\b/u.test(stripQuotedText(content))) {
      workflowsUsingNode.push(displayPath(workflowPath));
    }

    for (const setup of collectPnpmSetupBlocks(content)) {
      if (
        setup.revision !== PNPM_SETUP_ACTION ||
        setup.runtime !== `node@${NODE_VERSION}` ||
        setup.install !== 'false' ||
        setup.cache !== 'true'
      ) {
        setupFindings.push({ file: displayPath(workflowPath), ...setup });
      }
    }

    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      const commandSurface = stripQuotedText(line).trim();
      if (/\bpnpm\s+install\b/u.test(commandSurface) && !/--frozen-lockfile\b/u.test(line)) {
        installFindings.push({
          file: displayPath(workflowPath),
          line: index + 1,
          command: line.trim(),
        });
      }
    }

    assert.doesNotMatch(content, /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/u);
    assert.doesNotMatch(content, /\bnpm\s+(?:i|install)\s+(?:--global|-g)\b/iu);
    assert.doesNotMatch(content, /\bactions\/setup-node@/u);
  }

  assert.deepEqual(
    setupFindings,
    [],
    `pnpm setup blocks must pin Node ${NODE_VERSION} and disable implicit installs:\n${formatJson(
      setupFindings,
    )}`,
  );
  assert.deepEqual(
    installFindings,
    [],
    `workflow installs must be frozen:\n${formatJson(installFindings)}`,
  );
  for (const workflowPath of workflowsUsingNode) {
    const content = readFileSync(join(REPOSITORY_ROOT, workflowPath), 'utf8');
    assert.match(
      content,
      new RegExp(`pnpm/setup@${PNPM_SETUP_ACTION}`, 'u'),
      `${workflowPath} uses pnpm without the reviewed setup action`,
    );
  }
  for (const workflowPath of requiredNodeWorkflows) {
    const content = readFileSync(join(REPOSITORY_ROOT, workflowPath), 'utf8');
    assert.match(
      content,
      new RegExp(`pnpm/setup@${PNPM_SETUP_ACTION}`, 'u'),
      `${workflowPath} must use the reviewed pnpm/setup action`,
    );
  }

  const publishWorkflow = readFileSync(join(workflowRoot, 'publish.yml'), 'utf8');
  assert.match(publishWorkflow, /run: bash scripts\/ci\/release-context\.sh/u);
  assert.match(
    readFileSync(join(REPOSITORY_ROOT, 'scripts', 'ci', 'release-context.sh'), 'utf8'),
    /predates the pnpm release contract/u,
  );
  assert.match(
    publishWorkflow,
    /run:\s+pnpm --filter @tiangong-lca\/cli --fail-if-no-match publish --access public --provenance --no-git-checks\s*$/mu,
  );
});

test('release tags are blocked by the reusable four-platform gate and have executable handoff proof', () => {
  const workflowRoot = join(REPOSITORY_ROOT, '.github', 'workflows');
  const qualityWorkflow = readFileSync(join(workflowRoot, 'quality-gate.yml'), 'utf8');
  const tagWorkflow = readFileSync(join(workflowRoot, 'tag-release-from-merge.yml'), 'utf8');
  const releaseRunbook = readFileSync(join(REPOSITORY_ROOT, 'docs', 'release-runbook.md'), 'utf8');

  assert.match(qualityWorkflow, /on:\s*\n\s+workflow_call:\s*\n\s+workflow_dispatch:/u);
  assert.deepEqual(
    [...qualityWorkflow.matchAll(/- os: ([^\n]+)\n\s+platform: ([^\n]+)\n\s+arch: ([^\n]+)/gu)].map(
      ([, os, platform, arch]) => ({ os, platform, arch }),
    ),
    [
      { os: 'ubuntu-latest', platform: 'linux', arch: 'x64' },
      { os: 'windows-latest', platform: 'win32', arch: 'x64' },
      { os: 'macos-latest', platform: 'darwin', arch: 'arm64' },
      { os: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64' },
    ],
  );
  assert.match(
    qualityWorkflow,
    /node \.\/scripts\/ci\/assert-runtime-platform\.cjs --platform "\$\{\{ matrix\.platform \}\}" --arch "\$\{\{ matrix\.arch \}\}"/u,
  );
  assert.match(
    tagWorkflow,
    /quality-gate:\s*\n\s+needs: release-context[\s\S]*?uses: \.\/\.github\/workflows\/quality-gate\.yml/u,
  );
  assert.match(
    tagWorkflow,
    /release-context:[\s\S]*?Set up pnpm and Node\.js[\s\S]*?Detect release version changes/u,
  );
  assert.match(
    tagWorkflow,
    /tag-release:[\s\S]*?needs:\s*\n\s+- release-context\s*\n\s+- quality-gate/u,
  );
  assert.equal(
    PACKAGE_JSON.scripts?.['release:verify-published'],
    'node ./scripts/ci/verify-published-release.cjs',
  );
  assert.equal(PACKAGE_JSON.devDependencies?.sigstore, '5.0.0');
  assert.equal(PACKAGE_JSON.dependencies?.sigstore, undefined);
  assert.match(
    releaseRunbook,
    /pnpm release:verify-published -- --version <x\.y\.z> --expected-git-head <release-merge-sha>/u,
  );
  assert.match(
    releaseRunbook,
    /scripts\/workspace-ops task finish tiangong-lca\/cli#<cli-issue-number>[\s\S]*?follow the exact `Next` command[\s\S]*?short-lived continuation[\s\S]*?scripts\/workspace-ops task finish tiangong-lca\/workspace#<integration-issue-number>/u,
  );
  assert.doesNotMatch(releaseRunbook, /scripts\/workspace-ops task create --repo workspace/u);
  assert.doesNotMatch(releaseRunbook, /lca-workspace-delivery-workflow|workflow_ops\.py/u);
});

test('Oxlint is the only JavaScript and TypeScript linter and uses type-aware TS7 rules', () => {
  const allDeclaredDependencies = Object.fromEntries(
    DEPENDENCY_SECTIONS.flatMap((section) => Object.entries(PACKAGE_JSON[section] ?? {})),
  );
  const scripts = Object.values(PACKAGE_JSON.scripts ?? {}).join('\n');

  assert.equal(typeof PACKAGE_JSON.devDependencies?.oxlint, 'string');
  assert.equal(typeof PACKAGE_JSON.devDependencies?.['oxlint-tsgolint'], 'string');
  assert.match(scripts, /\boxlint\b/u);
  assert.doesNotMatch(scripts, /\beslint\b/u);
  assert.deepEqual(
    Object.keys(allDeclaredDependencies).filter(
      (name) => name === 'eslint' || name === '@eslint/js' || name.includes('typescript-eslint'),
    ),
    [],
  );
  assert.equal(existsSync(join(REPOSITORY_ROOT, 'eslint.config.mjs')), false);

  const oxlintConfigPath = join(REPOSITORY_ROOT, '.oxlintrc.json');
  const oxlintConfig = readJson(oxlintConfigPath);
  assert.equal(oxlintConfig.categories?.correctness, 'error');
  assert.equal(oxlintConfig.categories?.suspicious, 'error');
  assert.equal(oxlintConfig.options?.typeAware, true);
  assert.ok(oxlintConfig.plugins?.includes('typescript'));
  assert.equal(oxlintConfig.rules?.['typescript/no-deprecated'], 'error');

  const configPaths = findFiles(REPOSITORY_ROOT, (path) =>
    /^tsconfig(?:\..+)?\.json$/u.test(basename(path)),
  );
  const removedOptions = [];
  for (const configPath of configPaths) {
    const compilerOptions = readJson(configPath).compilerOptions ?? {};
    const moduleResolution = String(compilerOptions.moduleResolution ?? '').toLowerCase();
    if (moduleResolution === 'node' || moduleResolution === 'node10') {
      removedOptions.push({
        file: displayPath(configPath),
        option: 'moduleResolution',
        value: compilerOptions.moduleResolution,
      });
    }
    if (Object.hasOwn(compilerOptions, 'baseUrl')) {
      removedOptions.push({
        file: displayPath(configPath),
        option: 'baseUrl',
        value: compilerOptions.baseUrl,
      });
    }
    if (String(compilerOptions.ignoreDeprecations ?? '').startsWith('6.')) {
      removedOptions.push({
        file: displayPath(configPath),
        option: 'ignoreDeprecations',
        value: compilerOptions.ignoreDeprecations,
      });
    }
  }
  assert.deepEqual(
    removedOptions,
    [],
    `TypeScript 7 removed or compatibility-only options remain:\n${formatJson(removedOptions)}`,
  );
});

test('the latest Node 24-compatible graph pins the released TIDAS 0.3.0 runtime', () => {
  const sdkRange = PACKAGE_JSON.dependencies?.['@tiangong-lca/tidas-sdk'];
  assert.equal(sdkRange, '0.3.0');
  assert.equal(compareVersions(firstVersion(sdkRange), [0, 3, 0]), 0);
  assert.equal(PACKAGE_JSON.dependencies?.['@supabase/supabase-js'], '^2.112.4');
  assert.equal(PACKAGE_JSON.devDependencies?.['@types/node'], '^24.13.3');
  assert.equal(PACKAGE_JSON.devDependencies?.['lint-staged'], '^17.4.1');
  assert.equal(PACKAGE_JSON.devDependencies?.prettier, '3.9.6');
  assert.equal(PACKAGE_JSON.devDependencies?.tsx, '^4.23.13');

  const publishedDependencies = DEPENDENCY_SECTIONS.filter(
    (section) => section !== 'devDependencies',
  ).flatMap((section) => Object.keys(PACKAGE_JSON[section] ?? {}));
  const forbiddenDependencies = publishedDependencies.filter(
    (dependency) =>
      FORBIDDEN_PUBLISHED_TOOLS.has(dependency) ||
      dependency.startsWith('@types/') ||
      dependency.includes('typescript-eslint'),
  );
  assert.deepEqual(
    forbiddenDependencies,
    [],
    `published dependency fields contain compiler, lint, or test tooling: ${forbiddenDependencies.join(
      ', ',
    )}`,
  );
  assert.deepEqual(PACKAGE_JSON.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
});

test('the package exposes only the launcher and typed public primitive subpaths', () => {
  assert.deepEqual(PACKAGE_JSON.exports, {
    './bin/tiangong-lca.js': './bin/tiangong-lca.js',
    './auth-identity-receipt': {
      types: './dist/src/auth-identity-receipt.d.ts',
      import: './dist/src/auth-identity-receipt.js',
    },
    './command-spec': {
      types: './dist/src/command-spec.d.ts',
      import: './dist/src/command-spec.js',
    },
    './runtime': {
      types: './dist/src/runtime.d.ts',
      import: './dist/src/runtime.js',
    },
    './batch': {
      types: './dist/src/batch.d.ts',
      import: './dist/src/batch.js',
    },
  });
  assert.equal(PACKAGE_JSON.exports['.'], undefined, 'the package root must remain unsupported');
  assert.equal(
    readJson(join(REPOSITORY_ROOT, 'tsconfig.build.json')).compilerOptions?.declaration,
    true,
  );
});

test('the exact 100% source-coverage gate remains in the pnpm pre-push path', () => {
  const coverageCommand = PACKAGE_JSON.scripts?.['test:coverage'] ?? '';
  const coverageAssertCommand = PACKAGE_JSON.scripts?.['test:coverage:assert-full'] ?? '';
  const packageContractCommand = PACKAGE_JSON.scripts?.['test:package'] ?? '';
  const prepushCommand = PACKAGE_JSON.scripts?.['prepush:gate'] ?? '';
  const coverageAssertionSource = readFileSync(
    join(REPOSITORY_ROOT, 'scripts', 'assert-full-coverage.ts'),
    'utf8',
  );

  assert.match(coverageCommand, /scripts\/run-test-coverage\.cjs/u);
  assert.match(coverageAssertCommand, /assert-full-coverage\.js/u);
  assert.match(packageContractCommand, /test\/toolchain-contract\.test\.mjs/u);
  assert.equal(PACKAGE_JSON.scripts?.['peers:check'], 'pnpm peers check');
  assert.match(prepushCommand, /(?:^|&&)\s*pnpm(?:\s+run)?\s+peers:check(?:\s|&&|$)/u);
  assert.match(prepushCommand, /(?:^|&&)\s*pnpm(?:\s+run)?\s+test:package(?:\s|&&|$)/u);
  assert.match(prepushCommand, /(?:^|&&)\s*pnpm(?:\s+run)?\s+test:coverage(?:\s|&&|$)/u);
  assert.match(
    prepushCommand,
    /(?:^|&&)\s*pnpm(?:\s+run)?\s+test:coverage:assert-full(?:\s|&&|$)/u,
  );
  for (const metric of ['lines', 'statements', 'functions', 'branches']) {
    assert.match(coverageAssertionSource, new RegExp(`['"]${metric}['"]`, 'u'));
  }
  assert.match(coverageAssertionSource, /value\.covered !== value\.total/u);
  assert.match(coverageAssertionSource, /value\.pct !== 100/u);
});

const maybePackTest = process.env.TIANGONG_LCA_COVERAGE === '1' ? test.skip : test;

maybePackTest(
  'a clean pnpm tarball preserves bin plus typed ESM public subpaths without runtime build tools',
  { timeout: 180_000 },
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'tiangong-cli-pack-contract-'));

    try {
      const cleanRepository = join(fixtureRoot, 'repository');
      const packRoot = join(fixtureRoot, 'pack');
      const consumerRoot = join(fixtureRoot, 'consumer');
      mkdirSync(cleanRepository);
      mkdirSync(packRoot);
      mkdirSync(consumerRoot);
      copyCleanPackageSource(cleanRepository);

      execFileSync(
        'pnpm',
        ['install', '--frozen-lockfile', '--ignore-scripts'],
        commandOptions(cleanRepository),
      );
      const packOutput = execFileSync(
        'pnpm',
        ['pack', '--json', '--pack-destination', packRoot],
        commandOptions(cleanRepository),
      );
      const packMetadata = JSON.parse(packOutput);
      assert.equal(packMetadata.name, PACKAGE_JSON.name);
      assertPackedFiles(packMetadata.files ?? []);

      const tarballs = readdirSync(packRoot)
        .filter((file) => file.endsWith('.tgz'))
        .map((file) => join(packRoot, file));
      assert.equal(tarballs.length, 1, `expected one tarball, received ${tarballs.length}`);

      writeFileSync(
        join(consumerRoot, 'package.json'),
        `${JSON.stringify(
          {
            name: 'tiangong-cli-pack-consumer',
            private: true,
            packageManager: PACKAGE_MANAGER,
            dependencies: {
              [PACKAGE_JSON.name]: `file:${tarballs[0]}`,
            },
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      execFileSync(
        'pnpm',
        ['install', '--ignore-scripts', '--no-frozen-lockfile', '--no-lockfile'],
        commandOptions(consumerRoot),
      );

      const installedPackageRoot = join(consumerRoot, 'node_modules', '@tiangong-lca', 'cli');
      const installedManifest = readJson(join(installedPackageRoot, 'package.json'));
      const installedPublishedDependencies = DEPENDENCY_SECTIONS.filter(
        (section) => section !== 'devDependencies',
      ).flatMap((section) => Object.keys(installedManifest[section] ?? {}));
      assert.deepEqual(
        installedPublishedDependencies.filter(
          (dependency) =>
            FORBIDDEN_PUBLISHED_TOOLS.has(dependency) || dependency.startsWith('@types/'),
        ),
        [],
      );

      const installedBinPath = join(
        consumerRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tiangong-lca.cmd' : 'tiangong-lca',
      );
      assertRootBinBehavior(installedBinPath, consumerRoot, installedManifest.version);
      assertProductionBootstrap(installedBinPath, consumerRoot);
      assertModuleHostBehavior(consumerRoot, cleanRepository, installedManifest.version);

      const consumerTree = pnpmList(consumerRoot, 'typescript');
      assert.deepEqual(
        collectDependencyVersions(consumerTree, 'typescript'),
        [],
        'the packed CLI must not bring TypeScript into a production consumer tree',
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

function assertRootBinBehavior(binPath, cwd, expectedVersion) {
  const rootHelp = runBin(binPath, [], cwd);
  assertSuccessfulExit(rootHelp);
  assert.match(rootHelp.stdout, /Unified TianGong command entrypoint\./u);
  assert.equal(rootHelp.stderr, '');

  const explicitHelp = runBin(binPath, ['--help'], cwd);
  assertSuccessfulExit(explicitHelp);
  assert.match(explicitHelp.stdout, /Usage:\s+tiangong-lca <command>/u);
  assert.match(explicitHelp.stdout, /auth\s+identity-receipt/u);

  const authHelp = runBin(binPath, ['auth', 'identity-receipt', '--help'], cwd);
  assert.equal(authHelp.status, 0);
  assert.match(authHelp.stdout, /read-only/u);
  assert.equal(authHelp.stderr, '');
  assert.equal(explicitHelp.stderr, '');

  const version = runBin(binPath, ['--version'], cwd);
  assertSuccessfulExit(version);
  assert.equal(version.stdout, `${expectedVersion}\n`);
  assert.equal(version.stderr, '');

  const runtime = runBin(binPath, ['runtime', 'describe', '--json'], cwd);
  assertSuccessfulExit(runtime);
  assert.equal(JSON.parse(runtime.stdout).package.version, expectedVersion);
  assert.equal(runtime.stderr, '');

  const error = runBin(binPath, ['--definitely-unknown'], cwd);
  assert.ifError(error.error);
  assert.equal(error.status, 2, error.stderr || error.stdout);
  assert.equal(error.stdout, '');
  assert.deepEqual(JSON.parse(error.stderr), {
    error: {
      code: 'UNKNOWN_ROOT_OPTION',
      message: 'Unknown root option: --definitely-unknown',
    },
  });
}

function assertModuleHostBehavior(consumerRoot, compilerRoot, expectedVersion) {
  const launcherSpecifier = `${PACKAGE_JSON.name}/bin/tiangong-lca.js`;
  const authIdentitySpecifier = `${PACKAGE_JSON.name}/auth-identity-receipt`;
  const commandSpecSpecifier = `${PACKAGE_JSON.name}/command-spec`;
  const batchSpecifier = `${PACKAGE_JSON.name}/batch`;
  const runtimeSpecifier = `${PACKAGE_JSON.name}/runtime`;
  const esmHostPath = join(consumerRoot, 'esm-host.mjs');
  const cjsHostPath = join(consumerRoot, 'cjs-host.cjs');
  const rootHostPath = join(consumerRoot, 'root-host.mjs');
  const deepAuthHostPath = join(consumerRoot, 'deep-auth-host.mjs');
  const typescriptHostPath = join(consumerRoot, 'typescript-host.mts');
  const emptyTypeRoots = join(consumerRoot, 'empty-types');
  mkdirSync(emptyTypeRoots);

  writeFileSync(
    esmHostPath,
    [
      `import { resolveInvokedUrl, runFromBin } from '${launcherSpecifier}';`,
      `import * as authIdentityApi from '${authIdentitySpecifier}';`,
      `import { parseAuthIdentityReceipt } from '${authIdentitySpecifier}';`,
      `import { createFoundryCommandSpec } from '${commandSpecSpecifier}';`,
      `import * as batchApi from '${batchSpecifier}';`,
      `import * as runtimeApi from '${runtimeSpecifier}';`,
      `import { describeCliRuntime, assertCliRuntimeMatches, CLI_RUNTIME_EXPECTATION_SCHEMA } from '${runtimeSpecifier}';`,
      `if (JSON.stringify(Object.keys(runtimeApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_RUNTIME_RUNTIME_EXPORTS].sort()))}) throw new Error('ESM runtime named-export contract failed');`,
      `let manifestRejected=false; try { runtimeApi.parseRuntimeManifest({}); } catch(error) { manifestRejected=error?.code==='RUNTIME_MANIFEST_INVALID'; } if(!manifestRejected) throw new Error('Runtime manifest parser failed open');`,
      `if (runtimeApi.RUNTIME_HOST_CONTEXT_PROTOCOL !== 'tiangong-lca.runtime-host.v1') throw new Error('Runtime host protocol identity changed');`,
      `let contextRejected=false; try { await runtimeApi.receiveRuntimeHostContext(); } catch(error) { contextRejected=error?.code==='RUNTIME_HOST_CONTEXT'; } if(!contextRejected) throw new Error('Unmanaged host received context');`,
      `let copyRejected=false; try { runtimeApi.copyTrustedRuntimeManifestBytes({sha256:'0'.repeat(64),manifest:{}}); } catch(error) { copyRejected=error?.code==='RUNTIME_MANIFEST_UNTRUSTED'; } if(!copyRejected) throw new Error('Serialized runtime authority was accepted');`,
      'const observedRuntime = describeCliRuntime();',
      `if (observedRuntime.package.version !== '${expectedVersion}' || observedRuntime.scope !== 'cli-package') throw new Error('ESM runtime descriptor failed');`,
      'assertCliRuntimeMatches({ schema: CLI_RUNTIME_EXPECTATION_SCHEMA, package_version: observedRuntime.package.version, platform: observedRuntime.platform, content_sha256: observedRuntime.content_sha256, node_version: observedRuntime.node.version, node_sha256: observedRuntime.node.sha256 });',
      `import { createBatchContract, runBoundedBatch, withBatchRunLock } from '${batchSpecifier}';`,
      `if (JSON.stringify(Object.keys(batchApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_BATCH_RUNTIME_EXPORTS].sort()))}) throw new Error('ESM batch named-export contract failed');`,
      `if (JSON.stringify(Object.keys(authIdentityApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_AUTH_IDENTITY_RUNTIME_EXPORTS].sort()))}) throw new Error('ESM auth identity named-export contract failed');`,
      "let authRejected = false; try { parseAuthIdentityReceipt({}); } catch (error) { authRejected = error?.code === 'AUTH_IDENTITY_RECEIPT_INVALID'; } if (!authRejected) throw new Error('Auth identity parser failed open');",
      "if (resolveInvokedUrl(null) !== null) throw new Error('ESM launcher resolver contract failed');",
      "const spec = createFoundryCommandSpec({ executable: 'tool', argv: ['--json'] });",
      "if (spec.schema !== 'tiangong-foundry.command-spec.v1') throw new Error('CommandSpec export failed');",
      "const contract = createBatchContract({ identity: { id: 'pack' }, content: ['a'], policy: { parallel: 1 } });",
      'const batch = await runBoundedBatch({',
      '  contract,',
      "  items: ['a'],",
      '  getItemIdentity: (item) => item,',
      '  projectItemContent: (item) => item,',
      '  projectItemPolicy: () => null,',
      "  mode: 'read',",
      '  maxConcurrency: 1,',
      '  execute: ({ item }) => item.toUpperCase(),',
      '});',
      "if (batch.results_input_order[0]?.value !== 'A') throw new Error('Batch export failed');",
      "const lockReceipt = await withBatchRunLock({ runPath: './esm-run-lock-proof', identity: { id: 'esm' }, reason: 'pack-proof' }, (receipt) => receipt);",
      "if (!lockReceipt.lock_path.endsWith('.lock')) throw new Error('Batch run-lock export failed');",
      "if ((await runFromBin(['--version'], {})) !== 0) throw new Error('ESM launcher returned nonzero');",
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx' },
  );
  writeFileSync(rootHostPath, [`await import('${PACKAGE_JSON.name}');`, ''].join('\n'), {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(
    deepAuthHostPath,
    [`await import('${PACKAGE_JSON.name}/dist/src/lib/auth-identity-receipt.js');`, ''].join('\n'),
    { encoding: 'utf8', flag: 'wx' },
  );
  writeFileSync(
    typescriptHostPath,
    [
      `import { describeCliRuntime, assertCliRuntimeMatches, ensureRuntimeComponents, type CliRuntimeDescriptor, type CliRuntimeExpectation, type RuntimeManifest, type RuntimeManagerOptions } from '${runtimeSpecifier}';`,
      `import { receiveRuntimeHostContext, copyTrustedRuntimeManifestBytes, RUNTIME_HOST_CONTEXT_PROTOCOL, type RuntimeHostContext, type RuntimeExecutionSpawn } from '${runtimeSpecifier}';`,
      `const hostProtocol: 'tiangong-lca.runtime-host.v1' = RUNTIME_HOST_CONTEXT_PROTOCOL; void hostProtocol;`,
      'async function managedHost(): Promise<Uint8Array> { const context: RuntimeHostContext = await receiveRuntimeHostContext(); const directory: string = context.cwd; const entry: string = context.entry; const options: RuntimeManagerOptions = {cacheDir:context.cacheDir,host:context.host}; void directory; void entry; void options; return copyTrustedRuntimeManifestBytes(context.manifest); } void managedHost;',
      'const adapter: RuntimeExecutionSpawn = async (_executable, _argv, _options, context) => { const inherited: RuntimeHostContext | undefined = context; void inherited; return {status:0,signal:null,stdout:"",stderr:""}; }; void adapter;',
      'const observedRuntime: CliRuntimeDescriptor = describeCliRuntime();',
      "const expectation: CliRuntimeExpectation = { schema: 'tiangong-lca.cli-runtime-expectation.v1', package_version: observedRuntime.package.version, platform: observedRuntime.platform, content_sha256: observedRuntime.content_sha256, node_version: observedRuntime.node.version, node_sha256: observedRuntime.node.sha256 };",
      'assertCliRuntimeMatches(expectation);',
      'const ensure = ensureRuntimeComponents; const managerOptions: RuntimeManagerOptions = {};',
      'void ensure; void managerOptions; const manifestType: RuntimeManifest | null = null; void manifestType;',
      `import { createFoundryCommandSpec, type FoundryCommandSpec } from '${commandSpecSpecifier}';`,
      `import { parseAuthIdentityReceipt, type AuthIdentityReceipt } from '${authIdentitySpecifier}';`,
      `import { createBatchContract, runBoundedBatch, withBatchRunLock, type BatchRunLockReceipt, type BatchRunResult } from '${batchSpecifier}';`,
      'const parseReceipt: (value: unknown) => AuthIdentityReceipt = parseAuthIdentityReceipt;',
      'void parseReceipt;',
      "const spec: FoundryCommandSpec = createFoundryCommandSpec({ executable: 'tool', argv: ['--json'] });",
      "const contract = createBatchContract({ identity: { id: 'typed' }, content: ['a'], policy: { parallel: 1 } });",
      'const result: BatchRunResult<string, string, { id: string }> = await runBoundedBatch({',
      '  contract,',
      "  items: ['a'],",
      '  getItemIdentity: (item) => item,',
      '  projectItemContent: (item) => item,',
      '  projectItemPolicy: () => null,',
      "  mode: 'read',",
      '  maxConcurrency: 1,',
      '  execute: ({ item }) => `${spec.executable}:${item}`,',
      '});',
      "if (result.status !== 'completed') throw new Error('typed batch contract failed');",
      "const receipt: BatchRunLockReceipt = await withBatchRunLock({ runPath: './typed-run-lock-proof', identity: { id: 'typed' }, reason: 'type-proof' }, (value) => value);",
      "if (!receipt.identity_sha256) throw new Error('typed run-lock contract failed');",
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx' },
  );
  writeFileSync(
    cjsHostPath,
    [
      '(async () => {',
      `  const { resolveInvokedUrl, runFromBin } = await import('${launcherSpecifier}');`,
      `  const authIdentityApi = await import('${authIdentitySpecifier}');`,
      `  const { parseAuthIdentityReceipt } = authIdentityApi;`,
      `  const { createFoundryCommandSpec } = await import('${commandSpecSpecifier}');`,
      `  const batchApi = await import('${batchSpecifier}');`,
      `  const runtimeApi = await import('${runtimeSpecifier}');`,
      `  if (JSON.stringify(Object.keys(runtimeApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_RUNTIME_RUNTIME_EXPORTS].sort()))}) throw new Error('CJS runtime named-export contract failed');`,
      `  if (runtimeApi.describeCliRuntime().package.version !== '${expectedVersion}') throw new Error('CJS runtime descriptor failed');`,
      `  let contextRejected=false; try { await runtimeApi.receiveRuntimeHostContext(); } catch(error) { contextRejected=error?.code==='RUNTIME_HOST_CONTEXT'; } if(!contextRejected) throw new Error('CJS unmanaged host received context');`,
      `  const { createBatchContract, runBoundedBatch, withBatchRunLock } = batchApi;`,
      `  if (JSON.stringify(Object.keys(batchApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_BATCH_RUNTIME_EXPORTS].sort()))}) throw new Error('CJS batch named-export contract failed');`,
      `  if (JSON.stringify(Object.keys(authIdentityApi).sort()) !== ${JSON.stringify(JSON.stringify([...EXPECTED_AUTH_IDENTITY_RUNTIME_EXPORTS].sort()))}) throw new Error('CJS auth identity named-export contract failed');`,
      "  let authRejected = false; try { parseAuthIdentityReceipt({}); } catch (error) { authRejected = error?.code === 'AUTH_IDENTITY_RECEIPT_INVALID'; } if (!authRejected) throw new Error('CJS auth identity parser failed open');",
      "  if (resolveInvokedUrl(null) !== null) throw new Error('CJS launcher resolver contract failed');",
      "  const spec = createFoundryCommandSpec({ executable: 'tool', argv: ['--json'] });",
      "  if (spec.schema !== 'tiangong-foundry.command-spec.v1') throw new Error('CJS CommandSpec export failed');",
      "  const contract = createBatchContract({ identity: { id: 'cjs-pack' }, content: ['a'], policy: { parallel: 1 } });",
      '  const batch = await runBoundedBatch({',
      '    contract,',
      "    items: ['a'],",
      '    getItemIdentity: (item) => item,',
      '    projectItemContent: (item) => item,',
      '    projectItemPolicy: () => null,',
      "    mode: 'read',",
      '    maxConcurrency: 1,',
      '    execute: ({ item }) => item.toUpperCase(),',
      '  });',
      "  if (batch.results_input_order[0]?.value !== 'A') throw new Error('CJS Batch export failed');",
      "  const lockReceipt = await withBatchRunLock({ runPath: './cjs-run-lock-proof', identity: { id: 'cjs' }, reason: 'pack-proof' }, (receipt) => receipt);",
      "  if (!lockReceipt.lock_path.endsWith('.lock')) throw new Error('CJS Batch run-lock export failed');",
      "  if ((await runFromBin(['--version'], {})) !== 0) throw new Error('CJS launcher returned nonzero');",
      '})().catch((error) => {',
      '  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\\n`);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx' },
  );

  assert.equal(
    execFileSync(process.execPath, [esmHostPath], commandOptions(consumerRoot)),
    `${expectedVersion}\n`,
  );
  assert.equal(
    execFileSync(process.execPath, [cjsHostPath], commandOptions(consumerRoot)),
    `${expectedVersion}\n`,
  );
  const rootImport = spawnSync(process.execPath, [rootHostPath], commandOptions(consumerRoot));
  assert.ifError(rootImport.error);
  assert.notEqual(rootImport.status, 0, 'the package root import must remain unsupported');
  assert.match(rootImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  const deepAuthImport = spawnSync(
    process.execPath,
    [deepAuthHostPath],
    commandOptions(consumerRoot),
  );
  assert.ifError(deepAuthImport.error);
  assert.notEqual(
    deepAuthImport.status,
    0,
    'the internal auth deep import must remain unsupported',
  );
  assert.match(deepAuthImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--typeRoots',
      emptyTypeRoots,
      typescriptHostPath,
    ],
    commandOptions(compilerRoot),
  );
}

function assertPackedFiles(fileMetadata) {
  const packedFiles = fileMetadata.map(({ path }) => String(path).replaceAll('\\', '/'));
  const forbidden = packedFiles.filter(
    (path) =>
      /^(?:src|test|scripts|node_modules)\//u.test(path) ||
      /^dist\/(?:scripts|test)\//u.test(path) ||
      /(?:^|\/)\.?(?:eslint|oxlint|tsconfig)[^/]*$/iu.test(path) ||
      /(?:^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml)$/u.test(path),
  );

  assert.ok(packedFiles.includes('bin/tiangong-lca.js'), 'the packed CLI bin is missing');
  assert.ok(packedFiles.includes('dist/src/main.js'), 'the packed runtime entry is missing');
  assert.ok(
    packedFiles.includes('dist/src/command-spec.d.ts'),
    'the packed CommandSpec declaration is missing',
  );
  assert.ok(
    packedFiles.includes('dist/src/auth-identity-receipt.d.ts'),
    'the packed auth identity declaration is missing',
  );
  assert.ok(packedFiles.includes('dist/src/batch.d.ts'), 'the packed batch declaration is missing');
  for (const file of [
    'dist/src/runtime.d.ts',
    'assets/runtime/cli-runtime-descriptor.schema.json',
    'assets/runtime/cli-runtime-expectation.schema.json',
    'assets/runtime/runtime-manifest.schema.json',
    'assets/runtime/runtime-command-result.schema.json',
    'assets/runtime/runtime-bootstrap-lock.schema.json',
  ])
    assert.ok(packedFiles.includes(file), 'the packed runtime contract is missing: ' + file);
  assert.deepEqual(
    forbidden,
    [],
    `the tarball contains source, compiler, lint, or test tooling:\n${formatJson(forbidden)}`,
  );
}

function copyCleanPackageSource(destination) {
  for (const entry of [
    '.npmrc',
    '.oxlintrc.json',
    'LICENSE',
    'README.md',
    'assets',
    'bin',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts',
    'src',
    'tsconfig.build.json',
    'tsconfig.json',
  ]) {
    const source = join(REPOSITORY_ROOT, entry);
    if (existsSync(source)) {
      cpSync(source, join(destination, entry), { recursive: true });
    }
  }
}

function assertProductionBootstrap(binPath, cwd) {
  const sessionFile = join(cwd, 'private-session', 'session.json');
  const env = { TIANGONG_LCA_SESSION_FILE: sessionFile };
  const doctor = runBin(binPath, ['doctor', '--json'], cwd, env);
  assertSuccessfulExit(doctor);
  const checks = JSON.parse(doctor.stdout).checks;
  for (const key of [
    'TIANGONG_LCA_API_BASE_URL',
    'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
    'TIANGONG_LCA_OAUTH_CLIENT_ID',
  ]) {
    assert.equal(checks.find((check) => check.key === key)?.source, 'default');
  }
  for (const command of ['status', 'doctor-auth']) {
    const result = runBin(binPath, ['auth', command, '--json'], cwd, env);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'login-required');
    assert.equal(result.stderr, '');
  }
  assert.equal(existsSync(sessionFile), false, 'readiness checks must not create a session');
  const invalid = runBin(binPath, ['auth', 'status', '--json'], cwd, {
    ...env,
    TIANGONG_LCA_API_BASE_URL: 'https://custom.supabase.co',
  });
  assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout);
}

function runBin(binPath, args, cwd, env = {}) {
  return spawnSync(binPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...runtimeEnvironment(), ...env },
    timeout: 30_000,
    shell: process.platform === 'win32',
  });
}

function assertSuccessfulExit(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runtimeEnvironment() {
  const environment = {};
  for (const key of [
    'COMSPEC',
    'ComSpec',
    'NODE_OPTIONS',
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }
  return environment;
}

function commandOptions(cwd) {
  return {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function pnpmList(cwd, dependency, { recursive = false, lockfileOnly = false } = {}) {
  const args = ['list', dependency];
  if (recursive) {
    args.push('--recursive');
  }
  args.push('--depth', 'Infinity', '--json');
  if (lockfileOnly) {
    args.push('--lockfile-only');
  }

  const result = spawnSync('pnpm', args, commandOptions(cwd));
  assert.ifError(result.error);
  assert.equal(result.status, 0, `pnpm list failed in ${cwd}:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout || '[]');
}

function collectDependencyVersions(tree, dependencyName) {
  const roots = Array.isArray(tree) ? tree : [tree];
  return roots.flatMap((root) => collectDependencyVersionsFromNode(root, dependencyName, []));
}

function collectDependencyVersionsFromNode(tree, dependencyName, ancestry) {
  const matches = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, metadata] of Object.entries(tree?.[section] ?? {})) {
      const entry = `${name}@${metadata.version ?? 'unknown'}`;
      const dependencyPath = [...ancestry, entry];
      if (name === dependencyName) {
        matches.push({ version: metadata.version, path: dependencyPath.join(' > ') });
      }
      matches.push(...collectDependencyVersionsFromNode(metadata, dependencyName, dependencyPath));
    }
  }
  return matches;
}

function collectPackageCommandFinding(path, surface, command, findings) {
  if (typeof command !== 'string' || !NPM_PACKAGE_COMMAND_PATTERN.test(command)) {
    return;
  }
  findings.push({ file: displayPath(path), surface, command });
}

function collectPnpmSetupBlocks(content) {
  const lines = content.split(/\r?\n/u);
  const blocks = [];

  for (const [index, line] of lines.entries()) {
    const actionMatch = line.match(/uses:\s+pnpm\/setup@([^\s#]+)/u);
    if (!actionMatch) {
      continue;
    }

    const actionIndent = line.match(/^\s*/u)?.[0].length ?? 0;
    const blockLines = [line];
    for (const candidate of lines.slice(index + 1)) {
      const candidateIndent = candidate.match(/^\s*/u)?.[0].length ?? 0;
      if (
        candidate.trim() !== '' &&
        (candidateIndent < actionIndent ||
          (candidateIndent === actionIndent && /^\s*-\s/u.test(candidate)))
      ) {
        break;
      }
      blockLines.push(candidate);
    }
    const block = blockLines.join('\n');
    blocks.push({
      revision: actionMatch[1],
      runtime: block.match(/^\s*runtime:\s*([^\s#]+)\s*$/mu)?.[1],
      install: block.match(/^\s*install:\s*([^\s#]+)\s*$/mu)?.[1],
      cache: block.match(/^\s*cache:\s*([^\s#]+)\s*$/mu)?.[1],
    });
  }

  return blocks;
}

function collectActiveCommandFindings(path, content, findings) {
  const extension = basename(path).split('.').at(-1)?.toLowerCase();
  const isJavaScript = ['cjs', 'js', 'mjs', 'ts'].includes(extension);
  const lines = content.split(/\r?\n/u);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }

    const commandSurface = stripQuotedText(line);
    if (NPM_PACKAGE_COMMAND_PATTERN.test(commandSurface)) {
      findings.push({ file: displayPath(path), line: index + 1, command: trimmed });
    }
  }

  if (isJavaScript) {
    for (const match of content.matchAll(
      /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*['"](npm|npx)['"]/gu,
    )) {
      findings.push({
        file: displayPath(path),
        line: content.slice(0, match.index).split(/\r?\n/u).length,
        command: `${match[1]} child process`,
      });
    }
  }
}

function stripQuotedText(value) {
  let result = '';
  let quote = null;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      result += quote === null ? character : ' ';
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += quote === null ? character : ' ';
      escaped = true;
      continue;
    }
    if (quote !== null) {
      result += ' ';
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      result += ' ';
      continue;
    }
    result += character;
  }
  return result;
}

function findFiles(root, predicate) {
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === '.git' ||
      entry.name === '.pnpm-store' ||
      entry.name === 'coverage' ||
      entry.name === 'dist' ||
      entry.name === 'node_modules'
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(path, predicate));
    } else if (entry.isFile() && predicate(path)) {
      files.push(path);
    }
  }
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function firstVersion(range) {
  const match = String(range ?? '').match(/(\d+)\.(\d+)\.(\d+)/u);
  assert.ok(match, `expected a semantic version range, received ${range}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function majorVersion(version) {
  const match = String(version ?? '').match(/^(\d+)/u);
  return match ? Number(match[1]) : Number.NaN;
}

function isTypeScript7Range(range) {
  return /^(?:[~^]|>=)?7(?:\.|$)/u.test(String(range).trim());
}

function displayPath(path) {
  return relative(REPOSITORY_ROOT, path) || '.';
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}
