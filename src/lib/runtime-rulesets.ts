import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type RuntimeDatasetType = 'process' | 'flow' | 'publish';
export type RuntimeRuleSeverity = 'info' | 'warning' | 'blocker';
export type RuntimeRulesetPhase = 'authoring' | 'repair' | 'publish' | 'identity' | 'verification';

export type RuntimeRulesetId =
  | 'process-authoring/strict'
  | 'process-authoring/repair'
  | 'process-publish/default'
  | 'process-dedup/default'
  | 'flow-authoring/strict'
  | 'flow-publish/default'
  | 'flow-dedup/default'
  | 'publish-run/default';

export type RuntimeRule = {
  id: string;
  dataset_type: RuntimeDatasetType;
  severity: RuntimeRuleSeverity;
  default_blocker: boolean;
  phases: string[];
};

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

export type RuntimeRuleset = {
  id: RuntimeRulesetId;
  version: '1';
  source_version: typeof RUNTIME_RULESET_SOURCE_VERSION;
  dataset_type: RuntimeDatasetType;
  phase: RuntimeRulesetPhase;
  rule_ids: string[];
};

export const RUNTIME_RULESET_SOURCE_VERSION = '2026.05.23';
export const RUNTIME_RULESET_VERSION = '1';

const EXPECTED_PUBLIC_SOURCE = {
  schema_version: 'tidas.public-rules-source.v1',
  repository: 'https://github.com/tiangong-lca/tidas-spec.git',
  commit: 'f118660dbcbfbf736be74837cce0bf26cd177245',
  rules_version: '2026.09.20',
  status: 'released',
  index_sha256: 'd8f1e90777fe0c675d1e24cbd7f1141ee776d3ebda9d8b24c91f714779540dec',
  schema_sha256: '552a8c5fb87300dbe4ff5021d3d09a2b2d369999e887c223bc5c9738a99549f5',
} as const satisfies PublicRuleSource;

type RuntimeRulePolicy = RuntimeRule & { definition_source: 'public' | 'cli-local' };

const RUNTIME_RULE_POLICIES = [
  {
    id: 'tidas.process.name.base-name.align-reference-flow',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.process.name.qualifiers.structured',
    dataset_type: 'process',
    severity: 'warning',
    default_blocker: false,
    phases: ['build-plan', 'materialize', 'publish-build'],
    definition_source: 'public',
  },
  {
    id: 'tidas.process.quantitative-reference.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'cli-local',
  },
  {
    id: 'tidas.process.exchange.amount.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.process.evidence.field-bindings.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'publish-run'],
    definition_source: 'cli-local',
  },
  {
    id: 'tidas.process.version.format',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['save-draft', 'publish-build', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.process.identity.duplicate-fingerprint.block',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['identity-preflight', 'dedup-review'],
    definition_source: 'cli-local',
  },
  {
    id: 'tidas.flow.name.base-name.technical',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.flow.type.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.flow.reference-property-unit.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.flow.flow-property.mean-value.positive',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.flow.classification.elementary.valid',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['materialize', 'publish-build', 'save-draft', 'publish-run'],
    definition_source: 'public',
  },
  {
    id: 'tidas.flow.evidence.field-bindings.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'publish-run'],
    definition_source: 'cli-local',
  },
  {
    id: 'tidas.flow.identity.alias-equivalence.review',
    dataset_type: 'flow',
    severity: 'warning',
    default_blocker: false,
    phases: ['identity-preflight', 'dedup-review'],
    definition_source: 'cli-local',
  },
  {
    id: 'tidas.publish.verification.required',
    dataset_type: 'publish',
    severity: 'blocker',
    default_blocker: true,
    phases: ['publish-run'],
    definition_source: 'cli-local',
  },
] as const satisfies RuntimeRulePolicy[];

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

function composeRuntimeRules(
  provider: PublicRuleProvider,
  runtimePolicies: readonly RuntimeRulePolicy[] = RUNTIME_RULE_POLICIES,
): RuntimeRule[] {
  const publicRules = (['process', 'flow'] as const).flatMap(
    (kind) => assertSelection(provider(kind), kind).rules,
  );
  const publicIds = new Set(publicRules.map((rule) => rule.id));
  const policies = new Set<string>();
  for (const policy of runtimePolicies) {
    if (policies.has(policy.id)) {
      throw new Error(`Duplicate CLI runtime rule policy ${policy.id}.`);
    }
    policies.add(policy.id);
    if (policy.definition_source === 'public' && !publicIds.has(policy.id)) {
      throw new Error(`CLI runtime policy references unknown public rule ${policy.id}.`);
    }
    if (policy.definition_source === 'cli-local' && publicIds.has(policy.id)) {
      throw new Error(`CLI-local runtime rule duplicates public rule ${policy.id}.`);
    }
  }
  for (const id of publicIds) {
    if (!policies.has(id)) {
      throw new Error(`Public rule ${id} has no CLI runtime policy.`);
    }
  }
  return runtimePolicies.map(({ definition_source: _definitionSource, ...policy }) => ({
    ...policy,
    phases: [...policy.phases],
  }));
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

/** Verified public definitions for CLI-owned contract projections. */
export function getVerifiedPublicRules(kind: PublicRuleDatasetType): PublicRule[] {
  return assertSelection(resolvePublicRuleProvider()(kind), kind).rules.map((rule) =>
    structuredClone(rule),
  );
}

const RUNTIME_RULES = composeRuntimeRules(resolvePublicRuleProvider());

const RULESETS = [
  {
    id: 'process-authoring/strict',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'process',
    phase: 'authoring',
    rule_ids: [
      'tidas.process.name.base-name.align-reference-flow',
      'tidas.process.name.qualifiers.structured',
      'tidas.process.quantitative-reference.required',
      'tidas.process.exchange.amount.required',
      'tidas.process.evidence.field-bindings.required',
    ],
  },
  {
    id: 'process-authoring/repair',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'process',
    phase: 'repair',
    rule_ids: [
      'tidas.process.quantitative-reference.required',
      'tidas.process.exchange.amount.required',
      'tidas.process.evidence.field-bindings.required',
      'tidas.process.version.format',
    ],
  },
  {
    id: 'process-publish/default',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'process',
    phase: 'publish',
    rule_ids: [
      'tidas.process.name.base-name.align-reference-flow',
      'tidas.process.quantitative-reference.required',
      'tidas.process.exchange.amount.required',
      'tidas.process.evidence.field-bindings.required',
      'tidas.process.version.format',
    ],
  },
  {
    id: 'process-dedup/default',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'process',
    phase: 'identity',
    rule_ids: ['tidas.process.identity.duplicate-fingerprint.block'],
  },
  {
    id: 'flow-authoring/strict',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'flow',
    phase: 'authoring',
    rule_ids: [
      'tidas.flow.name.base-name.technical',
      'tidas.flow.type.required',
      'tidas.flow.reference-property-unit.required',
      'tidas.flow.flow-property.mean-value.positive',
      'tidas.flow.classification.elementary.valid',
      'tidas.flow.evidence.field-bindings.required',
      'tidas.flow.identity.alias-equivalence.review',
    ],
  },
  {
    id: 'flow-publish/default',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'flow',
    phase: 'publish',
    rule_ids: [
      'tidas.flow.name.base-name.technical',
      'tidas.flow.type.required',
      'tidas.flow.reference-property-unit.required',
      'tidas.flow.classification.elementary.valid',
      'tidas.flow.flow-property.mean-value.positive',
      'tidas.flow.evidence.field-bindings.required',
    ],
  },
  {
    id: 'flow-dedup/default',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'flow',
    phase: 'identity',
    rule_ids: ['tidas.flow.identity.alias-equivalence.review'],
  },
  {
    id: 'publish-run/default',
    version: RUNTIME_RULESET_VERSION,
    source_version: RUNTIME_RULESET_SOURCE_VERSION,
    dataset_type: 'publish',
    phase: 'verification',
    rule_ids: ['tidas.publish.verification.required'],
  },
] as const satisfies RuntimeRuleset[];

function validateRulesetReferences(
  rulesets: ReadonlyArray<{ id: string; rule_ids: readonly string[] }>,
  rules: readonly RuntimeRule[],
): void {
  for (const ruleset of rulesets) {
    for (const ruleId of ruleset.rule_ids) {
      if (!rules.some((rule) => rule.id === ruleId)) {
        throw new Error(`CLI ruleset ${ruleset.id} references unknown runtime rule ${ruleId}.`);
      }
    }
  }
}

validateRulesetReferences(RULESETS, RUNTIME_RULES);

const RULESETS_BY_ID = Object.fromEntries(RULESETS.map((item) => [item.id, item]));
const RULES_BY_ID = Object.fromEntries(RUNTIME_RULES.map((item) => [item.id, item]));

const LOCAL_RULE_ID_MAP: Partial<Record<RuntimeRulesetId, Record<string, string>>> = {
  'process-authoring/strict': {
    process_missing_source_base_name: 'tidas.process.name.base-name.align-reference-flow',
    process_missing_functional_unit: 'tidas.process.quantitative-reference.required',
    process_missing_quantitative_reference: 'tidas.process.quantitative-reference.required',
    process_missing_exchange_amount: 'tidas.process.exchange.amount.required',
    process_material_balance_deviation: 'tidas.process.exchange.amount.required',
    process_missing_system_boundary: 'tidas.process.evidence.field-bindings.required',
    process_missing_time: 'tidas.process.evidence.field-bindings.required',
    process_missing_geography: 'tidas.process.evidence.field-bindings.required',
    process_missing_technology: 'tidas.process.evidence.field-bindings.required',
    process_missing_admin_metadata: 'tidas.process.evidence.field-bindings.required',
    process_exchange_unit_semantic_mismatch: 'tidas.process.exchange.amount.required',
  },
  'process-dedup/default': {
    process_exact_duplicate_fingerprint: 'tidas.process.identity.duplicate-fingerprint.block',
  },
  'process-publish/default': {
    process_schema_failed: 'tidas.process.evidence.field-bindings.required',
  },
  'flow-authoring/strict': {
    missing_type_of_dataset: 'tidas.flow.type.required',
    elementary_flow_in_flow_qa: 'tidas.flow.type.required',
    methodology_invalid_type_of_dataset: 'tidas.flow.type.required',
    missing_name_text: 'tidas.flow.name.base-name.technical',
    name_contains_emergy: 'tidas.flow.name.base-name.technical',
    methodology_missing_base_name_en: 'tidas.flow.name.base-name.technical',
    methodology_basename_semicolon: 'tidas.flow.name.base-name.technical',
    missing_classification_leaf: 'tidas.flow.classification.elementary.valid',
    methodology_missing_class_id: 'tidas.flow.classification.elementary.valid',
    methodology_missing_cat_id: 'tidas.flow.classification.elementary.valid',
    methodology_product_classification_level_gap: 'tidas.flow.classification.elementary.valid',
    methodology_elementary_classification_level_gap: 'tidas.flow.classification.elementary.valid',
    missing_flow_property: 'tidas.flow.reference-property-unit.required',
    invalid_flow_property_reference: 'tidas.flow.reference-property-unit.required',
    missing_quantitative_reference: 'tidas.flow.reference-property-unit.required',
    quantitative_reference_mismatch: 'tidas.flow.reference-property-unit.required',
    methodology_quant_ref_missing_target: 'tidas.flow.reference-property-unit.required',
    same_category_high_similarity: 'tidas.flow.identity.alias-equivalence.review',
  },
  'flow-publish/default': {
    flow_schema_failed: 'tidas.flow.evidence.field-bindings.required',
  },
  'flow-dedup/default': {
    same_property_semantic_review: 'tidas.flow.identity.alias-equivalence.review',
  },
};

export function listRuntimeRulesets(): RuntimeRuleset[] {
  return RULESETS.map((ruleset) => ({ ...ruleset, rule_ids: [...ruleset.rule_ids] }));
}

export function getRuntimeRuleset<T extends RuntimeRulesetId>(id: T): RuntimeRuleset & { id: T } {
  const ruleset = RULESETS_BY_ID[id];
  return { ...ruleset, rule_ids: [...ruleset.rule_ids] } as RuntimeRuleset & { id: T };
}

export function getRuntimeRule(id: string): RuntimeRule | null {
  const rule = RULES_BY_ID[id];
  return rule ? { ...rule, phases: [...rule.phases] } : null;
}

export function runtimeRuleIds(id: RuntimeRulesetId): string[] {
  return getRuntimeRuleset(id).rule_ids;
}

export function resolveRuntimeRuleId(
  rulesetId: RuntimeRulesetId,
  localRuleId: string | null | undefined,
): string | null {
  if (!localRuleId) {
    return null;
  }
  return LOCAL_RULE_ID_MAP[rulesetId]?.[localRuleId] ?? null;
}

export function isRuntimeRuleBlocker(ruleId: string | null | undefined): boolean {
  if (!ruleId) {
    return false;
  }
  return RULES_BY_ID[ruleId]?.default_blocker ?? false;
}

export const __testInternals = {
  composeRuntimeRules,
  fallbackSelection,
  expectedPublicSource: EXPECTED_PUBLIC_SOURCE,
  publicAssetPath,
  readVerifiedFallback,
  resolvePublicRuleProvider,
  runtimeRulePolicies: RUNTIME_RULE_POLICIES,
  validateRulesetReferences,
};
