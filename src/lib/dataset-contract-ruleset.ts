import {
  getRuntimeRule,
  getVerifiedPublicRules,
  listRuntimeRulesets,
  type RuntimeRule,
} from './runtime-rulesets.js';

type ContractKind = 'process' | 'flow';
type LocalMetadata = {
  summary: string;
  field_paths: string[];
  source_rule_refs: Array<{ asset: string; path: string }>;
};

// These five descriptions are CLI/Foundry operation policy, not public TIDAS definitions.
const LOCAL_METADATA: Record<string, LocalMetadata> = {
  'tidas.process.quantitative-reference.required': {
    summary:
      'A process must identify a quantitative reference exchange or reference flow before authoring or publishing.',
    field_paths: [
      'processDataSet.exchanges.exchange[*].@dataSetInternalID',
      'processDataSet.exchanges.exchange[*].referenceToFlowDataSet',
    ],
    source_rule_refs: [
      {
        asset: 'tidas_processes.yaml',
        path: 'processDataSet.exchanges.exchange.referenceToFlowDataSet.<rules>',
      },
    ],
  },
  'tidas.process.evidence.field-bindings.required': {
    summary:
      'Process authoring and publish gates require evidence bindings for identity, names, quantitative reference, exchanges, source, geography, time, and technology.',
    field_paths: ['EvidenceManifest.sources', 'EvidenceManifest.field_bindings'],
    source_rule_refs: [
      {
        asset: 'tidas_processes.yaml',
        path: 'processDataSet.processInformation.technology.technologyDescriptionAndIncludedProcesses.<rules>',
      },
      {
        asset: 'tidas_processes.yaml',
        path: 'processDataSet.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness.dataCollectionPeriod.<rules>',
      },
    ],
  },
  'tidas.process.identity.duplicate-fingerprint.block': {
    summary:
      'A new process is blocked when reference flow, route, geography, system boundary, and exchange fingerprint are equivalent to an existing candidate.',
    field_paths: [
      'IdentityDecision.decision',
      'ProcessIdentity.reference_flow',
      'ProcessIdentity.exchange_fingerprint',
    ],
    source_rule_refs: [
      {
        asset: 'tidas_processes.yaml',
        path: 'processDataSet.exchanges.exchange.referenceToFlowDataSet.<rules>',
      },
      {
        asset: 'tidas_processes.yaml',
        path: 'processDataSet.processInformation.dataSetInformation.name.<rules>',
      },
    ],
  },
  'tidas.flow.evidence.field-bindings.required': {
    summary:
      'Flow authoring and publish gates require evidence bindings for identity, flow type, name, property, unit, classification, and source.',
    field_paths: ['EvidenceManifest.sources', 'EvidenceManifest.field_bindings'],
    source_rule_refs: [
      {
        asset: 'tidas_flows.yaml',
        path: 'flowDataSet.flowInformation.dataSetInformation.name.<rules>',
      },
      { asset: 'tidas_flows.yaml', path: 'flowDataSet.flowProperties.flowProperty.<rules>' },
    ],
  },
  'tidas.flow.identity.alias-equivalence.review': {
    summary:
      'Flow identity preflight should reuse or review flows with equivalent type, property, unit, CAS/category, synonyms, and aliases.',
    field_paths: [
      'IdentityDecision.decision',
      'FlowIdentity.flow_type',
      'FlowIdentity.reference_property',
      'FlowIdentity.reference_unit',
      'FlowIdentity.aliases',
    ],
    source_rule_refs: [
      {
        asset: 'tidas_flows.yaml',
        path: 'flowDataSet.flowInformation.dataSetInformation.name.common:synonyms.<rules>',
      },
      { asset: 'tidas_flows.yaml', path: 'flowDataSet.flowProperties.flowProperty.<rules>' },
    ],
  },
};

// The context-pack profile is distinct from gate execution: preserve its reviewed
// subset and ordering while deriving each public definition from the released index.
const CONTRACT_PROFILE_IDS: Record<ContractKind, string[]> = {
  process: [
    'process-authoring/strict',
    'process-authoring/repair',
    'process-publish/default',
    'process-dedup/default',
  ],
  flow: ['flow-authoring/strict', 'flow-publish/default', 'flow-dedup/default'],
};
const FLOW_AUTHORING_CONTEXT_IDS = [
  'tidas.flow.name.base-name.technical',
  'tidas.flow.type.required',
  'tidas.flow.reference-property-unit.required',
  'tidas.flow.flow-property.mean-value.positive',
  'tidas.flow.evidence.field-bindings.required',
];

export function getCliContractRuleset(
  kind: string,
  profileIds: Record<ContractKind, string[]> = CONTRACT_PROFILE_IDS,
  localMetadata: Record<string, LocalMetadata> = LOCAL_METADATA,
): unknown | undefined {
  if (kind !== 'process' && kind !== 'flow') return undefined;
  const publicRules = new Map(getVerifiedPublicRules(kind).map((rule) => [rule.id, rule]));
  const rulesets = listRuntimeRulesets()
    .filter((entry) => profileIds[kind].includes(entry.id))
    .map(({ source_version: _sourceVersion, ...entry }) => ({
      ...entry,
      rule_ids:
        entry.id === 'flow-authoring/strict' ? [...FLOW_AUTHORING_CONTEXT_IDS] : entry.rule_ids,
    }));
  if (rulesets.length !== profileIds[kind].length) {
    throw new Error(`CLI ${kind} contract profile inventory is incomplete.`);
  }
  const ids = [...new Set(rulesets.flatMap((entry) => entry.rule_ids))];
  const rules = ids.map((id) => {
    const policy: RuntimeRule | null = getRuntimeRule(id);
    const definition = publicRules.get(id);
    const local = localMetadata[id];
    if (!policy || (!definition && !local) || (definition && local)) {
      throw new Error(`CLI contract rule ${id} has no unique verified owner.`);
    }
    return {
      ...policy,
      summary: definition?.statement ?? local.summary,
      field_paths: definition?.locations ?? local.field_paths,
      source_rule_refs: definition?.source_refs ?? local.source_rule_refs,
    };
  });
  return {
    $schema: 'runtime_rulesets.schema.json',
    schema_version: 1,
    ruleset_version: '2026.05.23',
    purpose: 'CLI-owned runtime profile policy combined with released TIDAS public definitions.',
    rulesets,
    rules,
  };
}
