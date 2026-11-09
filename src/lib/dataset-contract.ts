import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCliContractRuleset } from './dataset-contract-ruleset.js';
import { CliError } from './errors.js';

export type DatasetContractInclude = 'schema' | 'methodology' | 'ruleset';
type ContractPack = {
  manifest: unknown;
  schemaText?: string;
  methodologyText?: string;
  runtimeRuleset?: unknown;
};

export async function readDatasetContract(type: string, include: string) {
  return loadContractPack({
    type: normalizeType(type),
    includes: normalizeIncludes(include),
  });
}

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

async function loadContractPack(options: {
  type: CanonicalKind;
  includes: DatasetContractInclude[];
  sdkModule?: Record<string, unknown>;
  runtimeAssetsRoot?: string;
}): Promise<{ source: 'sdk-contract-api' | 'sdk-runtime-assets'; pack: ContractPack }> {
  let sdkModule = options.sdkModule;
  if (!sdkModule) {
    sdkModule = requireFromHere('@tiangong-lca/tidas-sdk') as Record<string, unknown>;
  }
  const getTidasContractPack = sdkModule.getTidasContractPack;
  if (typeof getTidasContractPack === 'function') {
    const pack = getTidasContractPack(options.type, {
      include: options.includes.filter((include) => include !== 'ruleset'),
      profile: 'default',
      includeAiContext: false,
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

  return {
    manifest: {
      schema_version: 1,
      kind: options.type,
      profile: 'default',
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

export const __testInternals = {
  artifactManifest,
  isCliSourceRoot,
  loadContractPack,
  loadFallbackContractPack,
  resolveCliRepoRoot,
  resolveSdkRuntimeAssetsRoot,
  sdkRuntimeAssetsCandidates,
  normalizeIncludes,
  normalizeType,
};
