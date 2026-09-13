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

const RUNTIME_RULES = [
  {
    id: 'tidas.process.name.base-name.align-reference-flow',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.process.name.qualifiers.structured',
    dataset_type: 'process',
    severity: 'warning',
    default_blocker: false,
    phases: ['build-plan', 'materialize', 'publish-build'],
  },
  {
    id: 'tidas.process.quantitative-reference.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.process.exchange.amount.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.process.evidence.field-bindings.required',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'publish-run'],
  },
  {
    id: 'tidas.process.version.format',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['save-draft', 'publish-build', 'publish-run'],
  },
  {
    id: 'tidas.process.identity.duplicate-fingerprint.block',
    dataset_type: 'process',
    severity: 'blocker',
    default_blocker: true,
    phases: ['identity-preflight', 'dedup-review'],
  },
  {
    id: 'tidas.flow.name.base-name.technical',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.flow.type.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.flow.reference-property-unit.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.flow.flow-property.mean-value.positive',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.flow.classification.elementary.valid',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['materialize', 'publish-build', 'save-draft', 'publish-run'],
  },
  {
    id: 'tidas.flow.evidence.field-bindings.required',
    dataset_type: 'flow',
    severity: 'blocker',
    default_blocker: true,
    phases: ['build-plan', 'materialize', 'publish-build', 'publish-run'],
  },
  {
    id: 'tidas.flow.identity.alias-equivalence.review',
    dataset_type: 'flow',
    severity: 'warning',
    default_blocker: false,
    phases: ['identity-preflight', 'dedup-review'],
  },
  {
    id: 'tidas.publish.verification.required',
    dataset_type: 'publish',
    severity: 'blocker',
    default_blocker: true,
    phases: ['publish-run'],
  },
] as const satisfies RuntimeRule[];

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
    flow_property_internal_id_invalid: 'tidas.flow.reference-property-unit.required',
    flow_property_internal_id_duplicate: 'tidas.flow.reference-property-unit.required',
    flow_property_exact_reference_invalid: 'tidas.flow.reference-property-unit.required',
    flow_property_identity_duplicate: 'tidas.flow.reference-property-unit.required',
    flow_property_mean_invalid: 'tidas.flow.reference-property-unit.required',
    flow_property_reference_unresolved: 'tidas.flow.reference-property-unit.required',
    flow_property_reference_not_normalized: 'tidas.flow.reference-property-unit.required',
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
