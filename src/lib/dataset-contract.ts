import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeJsonArtifact, writeTextArtifact } from './artifacts.js';
import { getCliContractRuleset } from './dataset-contract-ruleset.js';
import { CliError } from './errors.js';

export type DatasetContractInclude = 'schema' | 'methodology' | 'ruleset';
export type DatasetContractProfile = 'default' | 'ai-import';
export type DatasetContractMode = 'contract' | 'context-pack';

export type DatasetContractReport = {
  schema_version: 1;
  status: 'completed';
  generated_at_utc: string;
  mode: DatasetContractMode;
  requested_type: string;
  type: string;
  profile: DatasetContractProfile;
  includes: DatasetContractInclude[];
  source: 'sdk-contract-api' | 'sdk-runtime-assets';
  manifest: unknown;
  files: {
    manifest: string;
    schema: string | null;
    methodology: string | null;
    ruleset: string | null;
    ai_context_json: string | null;
    ai_context_markdown: string | null;
    report: string;
  };
};

export type RunDatasetContractOptions = {
  type: string | undefined;
  include?: string | string[] | undefined;
  profile?: string | undefined;
  outDir: string | null | undefined;
  mode: DatasetContractMode;
  now?: Date;
  sdkModule?: Record<string, unknown>;
  runtimeAssetsRoot?: string;
};

type ContractPack = {
  manifest: unknown;
  schemaText?: string;
  methodologyText?: string;
  runtimeRuleset?: unknown;
  aiContext?: unknown;
};

type CanonicalKind =
  | 'contact'
  | 'flow'
  | 'flowproperty'
  | 'lciamethod'
  | 'lifecyclemodel'
  | 'process'
  | 'source'
  | 'unitgroup';

const requireFromHere = createRequire(import.meta.url);

const aliases: Record<string, CanonicalKind> = {
  contact: 'contact',
  contacts: 'contact',
  flow: 'flow',
  flows: 'flow',
  flowproperty: 'flowproperty',
  flowproperties: 'flowproperty',
  lciamethod: 'lciamethod',
  lciamethods: 'lciamethod',
  lifecyclemodel: 'lifecyclemodel',
  lifecyclemodels: 'lifecyclemodel',
  process: 'process',
  processes: 'process',
  source: 'source',
  sources: 'source',
  unitgroup: 'unitgroup',
  unitgroups: 'unitgroup',
};

const schemaFiles: Record<CanonicalKind, string> = {
  contact: 'tidas_contacts.json',
  flow: 'tidas_flows.json',
  flowproperty: 'tidas_flowproperties.json',
  lciamethod: 'tidas_lciamethods.json',
  lifecyclemodel: 'tidas_lifecyclemodels.json',
  process: 'tidas_processes.json',
  source: 'tidas_sources.json',
  unitgroup: 'tidas_unitgroups.json',
};

const methodologyFiles: Partial<Record<CanonicalKind, string>> = {
  flow: 'tidas_flows.yaml',
  process: 'tidas_processes.yaml',
};

const allowedIncludes = new Set<DatasetContractInclude>(['schema', 'methodology', 'ruleset']);

export async function runDatasetContract(
  options: RunDatasetContractOptions,
): Promise<DatasetContractReport> {
  const type = normalizeType(options.type);
  const includes = normalizeIncludes(options.include);
  const profile = normalizeProfile(options.profile ?? defaultProfile(options.mode));
  const outDir = requireOutDir(options.outDir);
  const includeAiContext = options.mode === 'context-pack';
  const loaded = await loadContractPack({
    type,
    includes,
    profile,
    includeAiContext,
    sdkModule: options.sdkModule,
    runtimeAssetsRoot: options.runtimeAssetsRoot,
  });
  const files = buildFiles(outDir, loaded.pack, includeAiContext);

  writeJsonArtifact(files.manifest, loaded.pack.manifest);
  if (loaded.pack.schemaText && files.schema) {
    writeTextArtifact(files.schema, `${loaded.pack.schemaText.trimEnd()}\n`);
  }
  if (loaded.pack.methodologyText && files.methodology) {
    writeTextArtifact(files.methodology, `${loaded.pack.methodologyText.trimEnd()}\n`);
  }
  if (loaded.pack.runtimeRuleset && files.ruleset) {
    writeJsonArtifact(files.ruleset, loaded.pack.runtimeRuleset);
  }
  if (loaded.pack.aiContext && files.ai_context_json) {
    writeJsonArtifact(files.ai_context_json, loaded.pack.aiContext);
  }
  if (includeAiContext && files.ai_context_markdown) {
    writeTextArtifact(files.ai_context_markdown, renderAiContextMarkdown(type, loaded.pack));
  }

  const report: DatasetContractReport = {
    schema_version: 1,
    status: 'completed',
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    mode: options.mode,
    requested_type: String(options.type),
    type,
    profile,
    includes,
    source: loaded.source,
    manifest: loaded.pack.manifest,
    files,
  };
  writeJsonArtifact(files.report, report);

  return report;
}

function normalizeType(value: string | undefined): CanonicalKind {
  const raw = value?.trim();
  if (!raw) {
    throw new CliError('Missing required --type value.', {
      code: 'DATASET_CONTRACT_TYPE_REQUIRED',
      exitCode: 2,
    });
  }
  const normalized = raw.toLowerCase().replace(/[-_]/gu, '');
  const type = aliases[normalized];
  if (!type) {
    throw new CliError(
      `Unsupported dataset contract type '${value}'. Supported types: ${Object.keys(aliases)
        .sort()
        .join(', ')}.`,
      {
        code: 'DATASET_CONTRACT_TYPE_INVALID',
        exitCode: 2,
      },
    );
  }
  return type;
}

function normalizeIncludes(value: string | string[] | undefined): DatasetContractInclude[] {
  const rawValues =
    Array.isArray(value) && value.length > 0
      ? value
      : value && !Array.isArray(value)
        ? [value]
        : ['schema,methodology,ruleset'];
  const includes = rawValues.flatMap((raw) =>
    raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!includes.length) {
    throw new CliError('At least one --include value is required.', {
      code: 'DATASET_CONTRACT_INCLUDE_REQUIRED',
      exitCode: 2,
    });
  }

  for (const include of includes) {
    if (!allowedIncludes.has(include as DatasetContractInclude)) {
      throw new CliError('--include values must be schema, methodology, or ruleset.', {
        code: 'DATASET_CONTRACT_INCLUDE_INVALID',
        exitCode: 2,
      });
    }
  }

  return Array.from(new Set(includes)) as DatasetContractInclude[];
}

function normalizeProfile(value: string): DatasetContractProfile {
  if (value === 'default' || value === 'ai-import') {
    return value;
  }
  throw new CliError("--profile must be 'default' or 'ai-import'.", {
    code: 'DATASET_CONTRACT_PROFILE_INVALID',
    exitCode: 2,
  });
}

function defaultProfile(mode: DatasetContractMode): DatasetContractProfile {
  return mode === 'context-pack' ? 'ai-import' : 'default';
}

function requireOutDir(value: string | null | undefined): string {
  if (!value?.trim()) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'DATASET_CONTRACT_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }
  return path.resolve(value);
}

async function loadContractPack(options: {
  type: CanonicalKind;
  includes: DatasetContractInclude[];
  profile: DatasetContractProfile;
  includeAiContext: boolean;
  sdkModule?: Record<string, unknown>;
  runtimeAssetsRoot?: string;
}): Promise<{ source: DatasetContractReport['source']; pack: ContractPack }> {
  let sdkModule = options.sdkModule;
  if (!sdkModule) {
    sdkModule = requireFromHere('@tiangong-lca/tidas-sdk') as Record<string, unknown>;
  }
  const getTidasContractPack = sdkModule.getTidasContractPack;
  if (typeof getTidasContractPack === 'function') {
    const pack = getTidasContractPack(options.type, {
      include: options.includes.filter((include) => include !== 'ruleset'),
      profile: options.profile,
      includeAiContext: options.includeAiContext,
    }) as ContractPack;
    const runtimeRuleset = options.includes.includes('ruleset')
      ? getCliContractRuleset(options.type)
      : undefined;
    pack.runtimeRuleset = runtimeRuleset;
    if (typeof pack.manifest === 'object' && pack.manifest !== null) {
      (pack.manifest as Record<string, unknown>).includes = [...options.includes];
      (pack.manifest as Record<string, unknown>).ruleset = runtimeRuleset
        ? artifactManifest('runtime_rulesets.json', JSON.stringify(runtimeRuleset, null, 2))
        : null;
    }
    if (options.includeAiContext && typeof pack.aiContext === 'object' && pack.aiContext !== null) {
      (pack.aiContext as Record<string, unknown>).runtime_ruleset = runtimeRuleset;
    }
    return {
      source: 'sdk-contract-api',
      pack,
    };
  }

  return {
    source: 'sdk-runtime-assets',
    pack: loadFallbackContractPack(options),
  };
}

function loadFallbackContractPack(options: {
  type: CanonicalKind;
  includes: DatasetContractInclude[];
  profile: DatasetContractProfile;
  includeAiContext: boolean;
  runtimeAssetsRoot?: string;
}): ContractPack {
  const runtimeRoot = options.runtimeAssetsRoot ?? resolveSdkRuntimeAssetsRoot();
  const schemaText = options.includes.includes('schema')
    ? readOptionalText(path.join(runtimeRoot, 'tidas', 'schemas', schemaFiles[options.type]))
    : undefined;
  const methodologyFile = methodologyFiles[options.type];
  const methodologyText =
    options.includes.includes('methodology') && methodologyFile
      ? readOptionalText(path.join(runtimeRoot, 'tidas', 'methodologies', methodologyFile))
      : undefined;
  const runtimeRuleset = options.includes.includes('ruleset')
    ? getCliContractRuleset(options.type)
    : undefined;
  const aiContext = options.includeAiContext
    ? buildAiContext({
        type: options.type,
        profile: options.profile,
        schemaText,
        methodologyText,
        runtimeRuleset,
      })
    : undefined;

  return {
    manifest: {
      schema_version: 1,
      kind: options.type,
      profile: options.profile,
      includes: options.includes,
      sdk_package: '@tiangong-lca/tidas-sdk',
      schema: schemaText ? artifactManifest(schemaFiles[options.type], schemaText) : null,
      methodology:
        methodologyText && methodologyFile
          ? artifactManifest(methodologyFile, methodologyText)
          : null,
      ruleset: runtimeRuleset
        ? artifactManifest('runtime_rulesets.json', JSON.stringify(runtimeRuleset, null, 2))
        : null,
    },
    schemaText,
    methodologyText,
    runtimeRuleset,
    aiContext,
  };
}

/**
 * Sibling SDK checkout layouts, canonical workspace directory first.
 *
 * The leading entry is the current workspace child name; the trailing entry
 * keeps developer checkouts that predate the rename working.
 */
const SDK_RUNTIME_ASSETS_SIBLING_PATHS = [
  '../tidas-sdks/sdks/typescript/src/runtime-assets',
  '../tidas-sdk/sdks/typescript/src/runtime-assets',
] as const;

/**
 * Ordered runtime-assets candidates: development siblings first, then the copy
 * shipped inside the installed SDK package.
 *
 * Sibling discovery is a development-only convenience. A packaged or installed
 * CLI has no adjacent repositories, so it must not probe them and instead
 * resolves the assets that ship with the package.
 */
function sdkRuntimeAssetsCandidates(
  sdkEntry: string,
  cliRepoRoot: string = resolveCliRepoRoot(),
): string[] {
  const packagedRoot = path.join(path.dirname(sdkEntry), 'runtime-assets');
  const siblingRoots = isCliSourceRoot(cliRepoRoot)
    ? SDK_RUNTIME_ASSETS_SIBLING_PATHS.map((relativePath) =>
        path.resolve(cliRepoRoot, relativePath),
      )
    : [];
  return [...siblingRoots, packagedRoot];
}

function resolveSdkRuntimeAssetsRoot(
  candidatesOverride?: string[],
  sdkEntryOverride?: string,
): string {
  const sdkEntry = sdkEntryOverride ?? requireFromHere.resolve('@tiangong-lca/tidas-sdk');
  const candidates = candidatesOverride ?? sdkRuntimeAssetsCandidates(sdkEntry);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new CliError('Could not resolve @tiangong-lca/tidas-sdk runtime assets.', {
    code: 'DATASET_CONTRACT_SDK_ASSETS_NOT_FOUND',
    exitCode: 1,
    details: { sdkEntry },
  });
}

function cliRepoRootCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(moduleDir, '../..'), path.resolve(moduleDir, '../../..')];
}

function isCliSourceRoot(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, 'package.json')) &&
    existsSync(path.join(candidate, 'src/cli.ts'))
  );
}

function resolveCliRepoRoot(candidatesOverride?: string[]): string {
  const candidates = candidatesOverride ?? cliRepoRootCandidates();
  return candidates.find(isCliSourceRoot) ?? candidates[0];
}

function readOptionalText(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return readFileSync(filePath, 'utf8');
}

function artifactManifest(
  name: string,
  content: string,
): { name: string; sha256: string; bytes: number } {
  return {
    name,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function buildAiContext(options: {
  type: CanonicalKind;
  profile: DatasetContractProfile;
  schemaText?: string;
  methodologyText?: string;
  runtimeRuleset?: unknown;
}): unknown {
  return {
    schema_version: 1,
    kind: options.type,
    profile: options.profile,
    instructions: [
      `Generate or repair only canonical TIDAS ${options.type} data.`,
      'Use the JSON schema as the structural contract.',
      'Use the methodology YAML as the semantic authoring contract when present.',
      'Treat runtime ruleset blocker rules as gate requirements.',
      'Return candidate data only; do not claim that database writes have happened.',
      'Preserve source provenance and unresolved assumptions so Foundry can build evidence and repair queues.',
    ],
    schema_text: options.schemaText,
    methodology_text: options.methodologyText,
    runtime_ruleset: options.runtimeRuleset,
  };
}

function buildFiles(
  outDir: string,
  pack: ContractPack,
  includeAiContext: boolean,
): DatasetContractReport['files'] {
  const outputsDir = path.join(outDir, 'outputs');
  return {
    manifest: path.join(outputsDir, 'contract-manifest.json'),
    schema: pack.schemaText ? path.join(outputsDir, 'schema.json') : null,
    methodology: pack.methodologyText ? path.join(outputsDir, 'methodology.yaml') : null,
    ruleset: pack.runtimeRuleset ? path.join(outputsDir, 'runtime-ruleset.json') : null,
    ai_context_json:
      includeAiContext && pack.aiContext ? path.join(outputsDir, 'ai-context.json') : null,
    ai_context_markdown: includeAiContext ? path.join(outputsDir, 'ai-context.md') : null,
    report: path.join(outputsDir, 'contract-report.json'),
  };
}

function renderAiContextMarkdown(type: CanonicalKind, pack: ContractPack): string {
  const aiContext = isRecord(pack.aiContext) ? pack.aiContext : {};
  const instructions = Array.isArray(aiContext.instructions)
    ? aiContext.instructions.map((item) => `- ${String(item)}`).join('\n')
    : '';
  const sections = [`# TIDAS ${type} AI Context`, '', '## Instructions', instructions];
  if (pack.methodologyText) {
    sections.push('', '## Methodology YAML', '```yaml', pack.methodologyText.trimEnd(), '```');
  }
  if (pack.schemaText) {
    sections.push('', '## JSON Schema', '```json', pack.schemaText.trimEnd(), '```');
  }
  if (pack.runtimeRuleset) {
    sections.push(
      '',
      '## Runtime Ruleset',
      '```json',
      JSON.stringify(pack.runtimeRuleset, null, 2),
      '```',
    );
  }
  return `${sections.join('\n')}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const __testInternals = {
  artifactManifest,
  buildAiContext,
  isCliSourceRoot,
  loadFallbackContractPack,
  renderAiContextMarkdown,
  resolveCliRepoRoot,
  resolveSdkRuntimeAssetsRoot,
  sdkRuntimeAssetsCandidates,
  normalizeIncludes,
  normalizeProfile,
  normalizeType,
};
