#!/usr/bin/env node

const { createHash, timingSafeEqual } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { verify: verifySigstore } = require('sigstore');
// Load the shared source policy as ESM; synchronous require under TS loaders
// creates an additional CommonJS wrapper and a different module instance.
async function repositoryIdentity(version) {
  const { cliRepositoryIdentity } = await import('./repository-identity.ts');
  return cliRepositoryIdentity(version);
}

const PACKAGE_NAME = '@tiangong-lca/cli';
const PACKAGE_MANAGER = 'pnpm@11.24.0';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const PUBLISH_WORKFLOW_PATH = '.github/workflows/publish.yml';
const SLSA_PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ATTESTATION_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function usage() {
  return [
    'Usage:',
    '  pnpm release:verify-published -- --version <x.y.z> --expected-git-head <40-hex-sha>',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const tokens = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {
    version: '',
    expectedGitHead: '',
  };
  const seen = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag !== '--version' && flag !== '--expected-git-head') {
      throw new Error(`unknown argument '${flag}'`);
    }
    if (seen.has(flag)) {
      throw new Error(`duplicate argument '${flag}'`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    seen.add(flag);
    index += 1;

    if (flag === '--version') {
      options.version = value;
    } else {
      options.expectedGitHead = value.toLowerCase();
    }
  }

  if (!SEMVER_PATTERN.test(options.version)) {
    throw new Error('--version must be an exact x.y.z semantic version');
  }
  if (!GIT_SHA_PATTERN.test(options.expectedGitHead)) {
    throw new Error('--expected-git-head must be an exact 40-character Git SHA');
  }
  return options;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseSha512Integrity(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error('registry dist.integrity must use sha512');
  }
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new Error('registry dist.integrity must contain canonical sha512 bytes');
  }
  return {
    encoded: value,
    bytes,
    hex: bytes.toString('hex'),
  };
}

function requireTrustedRegistryUrl(value, label, expectedPathPrefix) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'registry.npmjs.org' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.startsWith(expectedPathPrefix)
  ) {
    throw new Error(`${label} must be an uncredentialed public npm registry URL`);
  }
  return url.href;
}

function validatePackageMetadata(metadata, options) {
  const record = requireRecord(metadata, 'registry metadata');
  if (record.name !== PACKAGE_NAME || record.version !== options.version) {
    throw new Error('registry metadata does not match the expected package and version');
  }
  if (
    record.gitHead !== undefined &&
    String(record.gitHead).toLowerCase() !== options.expectedGitHead
  ) {
    throw new Error('registry gitHead does not match the expected release commit');
  }

  const dist = requireRecord(record.dist, 'registry dist metadata');
  const integrity = parseSha512Integrity(dist.integrity);
  const tarballUrl = requireTrustedRegistryUrl(
    dist.tarball,
    'registry tarball URL',
    `/${PACKAGE_NAME}/-/`,
  );
  const attestations = requireRecord(dist.attestations, 'registry attestation metadata');
  const attestationUrl = requireTrustedRegistryUrl(
    attestations.url,
    'registry attestation URL',
    '/-/npm/v1/attestations/',
  );
  if (attestations.provenance?.predicateType !== SLSA_PROVENANCE_PREDICATE) {
    throw new Error('registry metadata does not advertise SLSA provenance v1');
  }

  return {
    registryGitHead: typeof record.gitHead === 'string' ? record.gitHead.toLowerCase() : null,
    integrity,
    tarballUrl,
    attestationUrl,
  };
}

function packagePurl(version) {
  return `pkg:npm/%40tiangong-lca/cli@${version}`;
}

function requiresIdentityReceiptHelp(version) {
  const [major, minor, patch] = version.split('.').map((part) => BigInt(part));
  return major > 0n || minor > 1n || (minor === 1n && patch >= 1n);
}

function decodeStatement(attestation, expectedPredicateType) {
  const record = requireRecord(attestation, 'attestation');
  const bundle = requireRecord(record.bundle, 'attestation bundle');
  const envelope = requireRecord(bundle.dsseEnvelope, 'attestation DSSE envelope');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    throw new Error('attestation DSSE envelope must contain a signature');
  }
  if (typeof envelope.payload !== 'string' || envelope.payload === '') {
    throw new Error('attestation DSSE payload is missing');
  }
  let statement;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('attestation DSSE payload is not valid base64 JSON');
  }
  const recordStatement = requireRecord(statement, 'attestation statement');
  if (
    recordStatement._type !== 'https://in-toto.io/Statement/v1' ||
    recordStatement.predicateType !== expectedPredicateType
  ) {
    throw new Error('attestation statement type or predicateType does not match its envelope');
  }
  return recordStatement;
}

function assertSubject(statement, options, expectedTarballSha512) {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const subject = subjects[0];
  if (
    subjects.length !== 1 ||
    subject?.name !== packagePurl(options.version) ||
    !/^[0-9a-f]{128}$/u.test(expectedTarballSha512) ||
    subject.digest?.sha512 !== expectedTarballSha512
  ) {
    throw new Error('attestation subject does not bind the expected package tarball sha512');
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Fulcio's modern extensions contain DER UTF8String values. These policy
// values are bounded ASCII IDs/refs/SHAs, so the short-form length is exact.
function certificateString(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length >= 128 || !/^[\x20-\x7e]+$/u.test(value)) {
    throw new Error('certificate policy value is outside the bounded ASCII contract');
  }
  return String.fromCharCode(0x0c, bytes.length) + value;
}

async function provenanceVerificationOptions(bundle, options) {
  const source = await repositoryIdentity(options.version);
  const repositoryUrl = `https://github.com/${source.repository}`;
  const tagRef = `refs/tags/cli-v${options.version}`;
  const expectedIdentity = `${repositoryUrl}/${PUBLISH_WORKFLOW_PATH}@${tagRef}`;
  const decoded = decodeStatement({ bundle }, SLSA_PROVENANCE_PREDICATE);
  const event = decoded.predicate?.buildDefinition?.internalParameters?.github?.event_name;
  if (!['push', 'workflow_dispatch'].includes(event)) {
    throw new Error('SLSA provenance has an unsupported publication event');
  }
  // Reading this allowlisted event is only policy selection. Sigstore must
  // prove that the certificate carries that same event before it is trusted.
  return {
    certificateIssuer: GITHUB_OIDC_ISSUER,
    certificateIdentityURI: `^${escapeRegExp(expectedIdentity)}$`,
    certificateOIDs: {
      '1.3.6.1.4.1.57264.1.11': certificateString('github-hosted'),
      '1.3.6.1.4.1.57264.1.12': certificateString(repositoryUrl),
      '1.3.6.1.4.1.57264.1.13': certificateString(options.expectedGitHead),
      '1.3.6.1.4.1.57264.1.14': certificateString(tagRef),
      '1.3.6.1.4.1.57264.1.15': certificateString(source.repositoryId),
      '1.3.6.1.4.1.57264.1.17': certificateString(source.ownerId),
      '1.3.6.1.4.1.57264.1.20': certificateString(event),
    },
    ctLogThreshold: 1,
    tlogThreshold: 1,
    timeout: 30_000,
    retry: 2,
  };
}

async function verifyProvenanceBundle(bundle, options) {
  return verifySigstore(bundle, await provenanceVerificationOptions(bundle, options));
}

async function validateAttestations(
  payload,
  options,
  expectedTarballSha512,
  verifyBundle = verifyProvenanceBundle,
) {
  options = Object.freeze({ version: options.version, expectedGitHead: options.expectedGitHead });
  const root = requireRecord(payload, 'registry attestation response');
  const attestations = Array.isArray(root.attestations) ? root.attestations : [];
  const provenances = attestations.filter(
    (candidate) => candidate?.predicateType === SLSA_PROVENANCE_PREDICATE,
  );
  if (provenances.length !== 1) {
    throw new Error('registry attestations must include one unambiguous SLSA provenance v1');
  }
  // Own the payload snapshot across asynchronous signature verification.
  const provenanceBundle = JSON.parse(
    JSON.stringify(requireRecord(provenances[0].bundle, 'SLSA provenance bundle')),
  );
  const provenanceStatement = decodeStatement(
    { bundle: provenanceBundle },
    SLSA_PROVENANCE_PREDICATE,
  );
  const source = await repositoryIdentity(options.version);
  const repositoryUrl = `https://github.com/${source.repository}`;
  await verifyBundle(provenanceBundle, options);
  assertSubject(provenanceStatement, options, expectedTarballSha512);
  const predicate = requireRecord(provenanceStatement.predicate, 'SLSA provenance predicate');
  const buildDefinition = requireRecord(
    predicate.buildDefinition,
    'SLSA provenance build definition',
  );
  const workflow = buildDefinition.externalParameters?.workflow;
  const expectedTagRef = `refs/tags/cli-v${options.version}`;
  if (
    workflow?.ref !== expectedTagRef ||
    workflow?.repository !== repositoryUrl ||
    workflow?.path !== PUBLISH_WORKFLOW_PATH
  ) {
    throw new Error('SLSA provenance does not bind the canonical tag publish workflow');
  }
  const github = requireRecord(
    buildDefinition.internalParameters?.github,
    'SLSA GitHub parameters',
  );
  if (
    buildDefinition.buildType !==
      'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' ||
    github.repository_id !== source.repositoryId ||
    github.repository_owner_id !== source.ownerId ||
    !['push', 'workflow_dispatch'].includes(github.event_name) ||
    predicate.runDetails?.builder?.id !== 'https://github.com/actions/runner/github-hosted'
  ) {
    throw new Error('SLSA provenance repository/owner/event/builder identity mismatch');
  }
  const dependencies = buildDefinition.resolvedDependencies;
  const dependency =
    Array.isArray(dependencies) && dependencies.length === 1 ? dependencies[0] : null;
  if (
    dependency?.uri !== `git+${repositoryUrl}@${expectedTagRef}` ||
    dependency?.digest?.gitCommit !== options.expectedGitHead
  ) {
    throw new Error('SLSA provenance gitCommit does not match the expected release commit');
  }
  const invocationId = predicate.runDetails?.metadata?.invocationId;
  if (
    typeof invocationId !== 'string' ||
    !new RegExp(
      `^${escapeRegExp(repositoryUrl)}/actions/runs/[1-9]\\d*/attempts/[1-9]\\d*$`,
      'u',
    ).test(invocationId)
  ) {
    throw new Error('SLSA provenance invocation is not a canonical GitHub Actions run');
  }
  return { invocationId };
}

function validateTarballBytes(bytes, integrity) {
  const actual = createHash('sha512').update(bytes).digest();
  if (!timingSafeEqual(actual, integrity.bytes)) {
    throw new Error('downloaded public tarball does not match registry dist.integrity');
  }
  return actual.toString('hex');
}

function publicConsumerEnvironment(sourceEnv, userConfigPath, globalConfigPath) {
  const allowedNames = [
    'APPDATA',
    'COMSPEC',
    'ComSpec',
    'LOCALAPPDATA',
    'PATH',
    'Path',
    'PATHEXT',
    'PNPM_HOME',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
  ];
  const env = {};
  for (const name of allowedNames) {
    if (typeof sourceEnv[name] === 'string' && sourceEnv[name] !== '') {
      env[name] = sourceEnv[name];
    }
  }
  return {
    ...env,
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    PNPM_CONFIG_GLOBALCONFIG: globalConfigPath,
    PNPM_CONFIG_USERCONFIG: userConfigPath,
    npm_config_globalconfig: globalConfigPath,
    npm_config_registry: `${REGISTRY_ORIGIN}/`,
    npm_config_userconfig: userConfigPath,
  };
}

function validatePackageManagerVersion(value) {
  const version = String(value).trim();
  if (version !== PACKAGE_MANAGER.slice('pnpm@'.length)) {
    throw new Error(
      `public consumer requires ${PACKAGE_MANAGER}, received pnpm@${version || 'unknown'}`,
    );
  }
  return version;
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    shell: options.shell ?? false,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '')
      .trim()
      .slice(0, 2_000);
    throw new Error(`${options.label} failed${detail ? `: ${detail}` : ''}`);
  }
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function collectDependencyVersions(value, dependencyName, versions = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDependencyVersions(entry, dependencyName, versions);
    }
    return versions;
  }
  if (!value || typeof value !== 'object') {
    return versions;
  }
  if (value.name === dependencyName && typeof value.version === 'string') {
    versions.add(value.version);
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [key, nested] of Object.entries(value[section] ?? {})) {
      if (key === dependencyName && typeof nested?.version === 'string') {
        versions.add(nested.version);
      }
      collectDependencyVersions(nested, dependencyName, versions);
    }
  }
  return versions;
}

function withPrivateTempDirectory(callback, dependencies = {}) {
  const create = dependencies.mkdtemp ?? mkdtempSync;
  const makePrivate = dependencies.chmod ?? chmodSync;
  const remove = dependencies.remove ?? rmSync;
  const directory = create(path.join(tmpdir(), 'tiangong-cli-public-consumer-'));
  try {
    makePrivate(directory, 0o700);
    return callback(directory);
  } finally {
    remove(directory, { recursive: true, force: true });
  }
}

function verifyPublicConsumer(options) {
  return withPrivateTempDirectory((consumerRoot) => {
    const userConfigPath = path.join(consumerRoot, '.npmrc');
    const globalConfigPath = path.join(consumerRoot, 'global.npmrc');
    const env = publicConsumerEnvironment(process.env, userConfigPath, globalConfigPath);
    writeFileSync(userConfigPath, `registry=${REGISTRY_ORIGIN}/\nalways-auth=false\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(globalConfigPath, `registry=${REGISTRY_ORIGIN}/\nalways-auth=false\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(
      path.join(consumerRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'tiangong-cli-public-release-consumer',
          private: true,
          packageManager: PACKAGE_MANAGER,
          dependencies: { [PACKAGE_NAME]: options.version },
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    const pnpmVersion = validatePackageManagerVersion(
      runChecked('pnpm', ['--version'], {
        cwd: consumerRoot,
        env,
        label: 'public consumer pnpm version check',
      }).stdout,
    );

    runChecked(
      'pnpm',
      ['install', '--ignore-scripts', '--no-frozen-lockfile', `--registry=${REGISTRY_ORIGIN}/`],
      { cwd: consumerRoot, env, label: 'clean public pnpm install' },
    );
    runChecked('pnpm', ['audit', 'signatures'], {
      cwd: consumerRoot,
      env,
      label: 'public registry signature verification',
    });

    const installedManifest = JSON.parse(
      readFileSync(
        path.join(consumerRoot, 'node_modules', '@tiangong-lca', 'cli', 'package.json'),
        'utf8',
      ),
    );
    if (installedManifest.name !== PACKAGE_NAME || installedManifest.version !== options.version) {
      throw new Error('clean consumer installed an unexpected package version');
    }

    const installedBinPath = path.join(
      consumerRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tiangong-lca.cmd' : 'tiangong-lca',
    );
    const version = runChecked(installedBinPath, ['--version'], {
      cwd: consumerRoot,
      env,
      label: 'public CLI bin version check',
      shell: process.platform === 'win32',
    });
    if (version.stdout !== `${options.version}\n` || version.stderr !== '') {
      throw new Error(
        `public CLI bin did not report the exact release version cleanly: stdout=${JSON.stringify(version.stdout)}, stderr=${JSON.stringify(version.stderr)}`,
      );
    }

    let authIdentityReceiptHelp = 'not-applicable-before-0.1.1';
    if (requiresIdentityReceiptHelp(options.version)) {
      const authHelp = runChecked(installedBinPath, ['auth', 'identity-receipt', '--help'], {
        cwd: consumerRoot,
        env,
        label: 'public auth identity receipt help check',
        shell: process.platform === 'win32',
      });
      if (!/read-only/u.test(authHelp.stdout) || authHelp.stderr !== '') {
        throw new Error('public auth identity-receipt help contract is incomplete');
      }
      authIdentityReceiptHelp = 'passed';
    }

    const launcherSpecifier = `${PACKAGE_NAME}/bin/tiangong-lca.js`;
    const esmHost = path.join(consumerRoot, 'esm-host.mjs');
    const cjsHost = path.join(consumerRoot, 'cjs-host.cjs');
    writeFileSync(
      esmHost,
      [
        `import { resolveInvokedUrl, runFromBin } from '${launcherSpecifier}';`,
        "if (resolveInvokedUrl(null) !== null) throw new Error('ESM resolver contract failed');",
        "if ((await runFromBin(['--version'], {})) !== 0) throw new Error('ESM launcher failed');",
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    writeFileSync(
      cjsHost,
      [
        '(async () => {',
        `  const { resolveInvokedUrl, runFromBin } = await import('${launcherSpecifier}');`,
        "  if (resolveInvokedUrl(null) !== null) throw new Error('CJS resolver contract failed');",
        "  if ((await runFromBin(['--version'], {})) !== 0) throw new Error('CJS launcher failed');",
        '})().catch((error) => {',
        '  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\\n`);',
        '  process.exitCode = 1;',
        '});',
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const esm = runChecked(process.execPath, [esmHost], {
      cwd: consumerRoot,
      env,
      label: 'public ESM launcher consumer',
    });
    const cjs = runChecked(process.execPath, [cjsHost], {
      cwd: consumerRoot,
      env,
      label: 'public CJS launcher consumer',
    });
    if (esm.stdout !== `${options.version}\n` || cjs.stdout !== `${options.version}\n`) {
      throw new Error('public ESM/CJS launcher consumers did not report the exact version');
    }

    const typeScriptTree = runChecked(
      'pnpm',
      ['list', 'typescript', '--prod', '--json', '--depth', 'Infinity'],
      { cwd: consumerRoot, env, label: 'public production dependency tree check' },
    );
    const versions = [
      ...collectDependencyVersions(JSON.parse(typeScriptTree.stdout), 'typescript'),
    ];
    if (versions.length !== 0) {
      throw new Error(
        `public production consumer unexpectedly installs TypeScript: ${versions.join(', ')}`,
      );
    }

    return {
      packageManager: `pnpm@${pnpmVersion}`,
      registrySignatures: 'passed',
      installedVersion: installedManifest.version,
      bin: 'passed',
      authIdentityReceiptHelp,
      esmLauncher: 'passed',
      cjsLauncher: 'passed',
      productionTypeScriptVersions: [],
    };
  });
}

async function readResponseBytes(response, maxBytes, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new Error(`${label} content length exceeds the byte limit`);
    }
  }
  if (!response.body) {
    throw new Error(`${label} response body is missing`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeds the byte limit`);
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchBytes(url, maxBytes, label, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: label === 'public package tarball' ? 'application/octet-stream' : 'application/json',
      'User-Agent': 'tiangong-cli-published-release-verifier/1.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return readResponseBytes(response, maxBytes, label);
}

async function fetchJson(url, maxBytes, label, fetchImpl = fetch) {
  const bytes = await fetchBytes(url, maxBytes, label, fetchImpl);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function verifyPublishedRelease(options, dependencies = {}) {
  await repositoryIdentity(options.version);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const metadataUrl = `${REGISTRY_ORIGIN}/${encodeURIComponent(PACKAGE_NAME)}/${options.version}`;
  const metadata = await fetchJson(
    metadataUrl,
    MAX_METADATA_BYTES,
    'public package metadata',
    fetchImpl,
  );
  const validated = validatePackageMetadata(metadata, options);
  const tarballBytes = await fetchBytes(
    validated.tarballUrl,
    MAX_TARBALL_BYTES,
    'public package tarball',
    fetchImpl,
  );
  const tarballSha512 = validateTarballBytes(tarballBytes, validated.integrity);
  const attestationPayload = await fetchJson(
    validated.attestationUrl,
    MAX_ATTESTATION_BYTES,
    'public package attestations',
    fetchImpl,
  );
  const provenance = await validateAttestations(
    attestationPayload,
    options,
    tarballSha512,
    dependencies.verifyBundle,
  );
  const consumer = (dependencies.verifyConsumer ?? verifyPublicConsumer)(options);

  return {
    schemaVersion: 'tiangong-lca.cli-published-release-verification.v1',
    ok: true,
    package: PACKAGE_NAME,
    version: options.version,
    expectedGitHead: options.expectedGitHead,
    registryGitHead: validated.registryGitHead,
    provenanceGitCommit: options.expectedGitHead,
    integrity: validated.integrity.encoded,
    tarballSha512,
    provenanceInvocation: provenance.invocationId,
    consumer,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await verifyPublishedRelease(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${usage()}\nerror: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PACKAGE_NAME,
  REGISTRY_ORIGIN,
  collectDependencyVersions,
  certificateString,
  provenanceVerificationOptions,
  packagePurl,
  parseArgs,
  parseSha512Integrity,
  publicConsumerEnvironment,
  requiresIdentityReceiptHelp,
  validatePackageManagerVersion,
  validateAttestations,
  validatePackageMetadata,
  validateTarballBytes,
  verifyPublishedRelease,
  withPrivateTempDirectory,
};
