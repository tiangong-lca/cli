import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type PublicRuleDatasetType = 'process' | 'flow';
type PublicRule = {
  id: string;
  dataset_type: PublicRuleDatasetType;
  normative_level: 'requirement' | 'recommendation';
  statement: string;
  locations: string[];
  applicability: { scope: string };
  source_refs: Array<{ asset: string; path: string }>;
  cases: { positive: string[]; negative: string[] };
};
type PublicRuleSource = {
  schema_version: 'tidas.public-rules-source.v1';
  repository: string;
  commit: string;
  rules_version: string;
  status: 'reviewed-candidate' | 'released';
  index_sha256: string;
  schema_sha256: string;
};
type PublicRuleSelection = {
  status: 'covered' | 'not-covered';
  schema_version: number;
  rules_version: string;
  dataset_type: string;
  source: PublicRuleSource;
  rules: PublicRule[];
};
type PublicRuleProvider = (kind: PublicRuleDatasetType) => unknown;

const EXPECTED_PUBLIC_SOURCE = {
  schema_version: 'tidas.public-rules-source.v1',
  repository: 'https://github.com/tiangong-lca/tidas-spec.git',
  commit: '32e1ba38da7d5f4f6245c6c1927f83b326cd5404',
  rules_version: '2026.09.20',
  status: 'released',
  index_sha256: 'd8f1e90777fe0c675d1e24cbd7f1141ee776d3ebda9d8b24c91f714779540dec',
  schema_sha256: '552a8c5fb87300dbe4ff5021d3d09a2b2d369999e887c223bc5c9738a99549f5',
} as const satisfies PublicRuleSource;

function publicAssetPath(name: string, candidateUrls?: URL[]): string {
  const candidates = candidateUrls ?? [
    new URL(`../../assets/tidas-public-rules/${name}`, import.meta.url),
    new URL(`../../../assets/tidas-public-rules/${name}`, import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return fileURLToPath(candidate);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  }
  throw new Error(`Unable to resolve bundled TIDAS public-rule asset ${name}.`);
}

type PublicRuleAssetPaths = { index: string; schema: string; source: string };

function readVerifiedFallback(paths?: PublicRuleAssetPaths): {
  source: PublicRuleSource;
  rules: PublicRule[];
} {
  const resolved =
    paths ??
    ({
      index: publicAssetPath('public-rules.v1.json'),
      schema: publicAssetPath('public-rules.v1.schema.json'),
      source: publicAssetPath('public-rules.source.v1.json'),
    } satisfies PublicRuleAssetPaths);
  const indexBytes = readFileSync(resolved.index);
  const schemaBytes = readFileSync(resolved.schema);
  const source = JSON.parse(readFileSync(resolved.source, 'utf8')) as PublicRuleSource;
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  if (
    JSON.stringify(source) !== JSON.stringify(EXPECTED_PUBLIC_SOURCE) ||
    sha256(indexBytes) !== source.index_sha256 ||
    sha256(schemaBytes) !== source.schema_sha256
  ) {
    throw new Error('Bundled TIDAS public-rule source identity or digest is stale.');
  }
  const index = JSON.parse(indexBytes.toString('utf8')) as { rules: PublicRule[] };
  return { source, rules: index.rules };
}

const FALLBACK_PUBLIC_RULES = readVerifiedFallback();

function fallbackSelection(kind: PublicRuleDatasetType): PublicRuleSelection {
  return {
    status: 'covered',
    schema_version: 1,
    rules_version: FALLBACK_PUBLIC_RULES.source.rules_version,
    dataset_type: kind,
    source: { ...FALLBACK_PUBLIC_RULES.source },
    rules: FALLBACK_PUBLIC_RULES.rules
      .filter((rule) => rule.dataset_type === kind)
      .map((rule) => structuredClone(rule)),
  };
}

function assertSelection(value: unknown, kind: PublicRuleDatasetType): PublicRuleSelection {
  if (!value || typeof value !== 'object') {
    throw new Error(`TIDAS public-rule ${kind} selection is malformed.`);
  }
  const selection = value as PublicRuleSelection;
  if (selection.status !== 'covered') {
    throw new Error(`TIDAS public-rule ${kind} selection is ${String(selection.status)}.`);
  }
  const fallback = fallbackSelection(kind);
  if (
    selection.schema_version !== 1 ||
    selection.rules_version !== fallback.rules_version ||
    selection.dataset_type !== kind ||
    JSON.stringify(selection.source) !== JSON.stringify(fallback.source) ||
    JSON.stringify(selection.rules) !== JSON.stringify(fallback.rules)
  ) {
    throw new Error(`TIDAS public-rule ${kind} API/fallback contract mismatch.`);
  }
  return selection;
}

function resolvePublicRuleProvider(contracts?: {
  getTidasPublicRules?: PublicRuleProvider;
}): PublicRuleProvider {
  const resolvedContracts =
    contracts ??
    (createRequire(import.meta.url)('@tiangong-lca/tidas-sdk/contracts') as {
      getTidasPublicRules?: PublicRuleProvider;
    });
  return typeof resolvedContracts.getTidasPublicRules === 'function'
    ? resolvedContracts.getTidasPublicRules
    : fallbackSelection;
}

/** Exact public definitions and source; discovery is not an executed gate. */
export function getVerifiedPublicRuleSelection(kind: PublicRuleDatasetType): PublicRuleSelection {
  return structuredClone(assertSelection(resolvePublicRuleProvider()(kind), kind));
}
export const __testInternals = {
  assertSelection,
  fallbackSelection,
  expectedPublicSource: EXPECTED_PUBLIC_SOURCE,
  publicAssetPath,
  readVerifiedFallback,
  resolvePublicRuleProvider,
};
