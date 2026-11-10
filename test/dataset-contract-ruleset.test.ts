import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliContractRuleset } from '../src/lib/dataset/contract-ruleset.js';
import { getVerifiedPublicRuleSelection } from '../src/lib/validation/runtime-rulesets.js';
test('contracts expose every exact public definition and no retired workflow policy', () => {
  assert.equal(getCliContractRuleset('contact'), undefined);
  for (const kind of ['flow', 'process'] as const) {
    const selection = getVerifiedPublicRuleSelection(kind);
    const contract = getCliContractRuleset(kind) as Record<string, unknown>;
    assert.deepEqual(contract.rules, selection.rules);
    assert.deepEqual(contract.source, selection.source);
    assert.equal(contract.ruleset_version, selection.rules_version);
    assert.match(String(contract.purpose), /not proof/u);
    assert.ok(
      !JSON.stringify(contract).match(
        /EvidenceManifest|IdentityDecision|build-plan|publish-build|dedup-review|default_blocker|authoring\/strict/u,
      ),
    );
  }
});
