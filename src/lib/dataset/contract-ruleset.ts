import { getVerifiedPublicRuleSelection } from '../validation/runtime-rulesets.js';
/** Public definitions only. Workflow policy and validation execution are separate contracts. */
export function getCliContractRuleset(kind: string): unknown | undefined {
  if (kind !== 'process' && kind !== 'flow') return undefined;
  const selection = getVerifiedPublicRuleSelection(kind);
  return {
    schema_version: 1,
    ruleset_version: selection.rules_version,
    purpose:
      'Released TIDAS public definitions for content discovery; not proof that these rules have been executed.',
    source: selection.source,
    rules: selection.rules,
  };
}
