import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliContractRuleset } from '../src/lib/dataset-contract-ruleset.js';

type Projection = {
  ruleset_version: string;
  rulesets: Array<{ id: string; rule_ids: string[] }>;
  rules: Array<{
    id: string;
    summary: string;
    severity: string;
    field_paths: string[];
    source_rule_refs: Array<{ asset: string; path: string }>;
  }>;
};

test('CLI context profile derives public definitions from released spec and retains local policy', () => {
  assert.equal(getCliContractRuleset('contact'), undefined);
  const process = getCliContractRuleset('process') as Projection;
  const flow = getCliContractRuleset('flow') as Projection;
  assert.equal(process.ruleset_version, '2026.05.23');
  assert.deepEqual(
    process.rulesets.map((entry) => entry.id),
    [
      'process-authoring/strict',
      'process-authoring/repair',
      'process-publish/default',
      'process-dedup/default',
    ],
  );
  assert.deepEqual(
    flow.rulesets.map((entry) => entry.id),
    ['flow-authoring/strict', 'flow-publish/default', 'flow-dedup/default'],
  );
  assert.equal(process.rules.length, 7);
  assert.equal(flow.rules.length, 7);
  assert.match(
    process.rules.find((rule) => rule.id === 'tidas.process.version.format')?.summary ?? '',
    /optional three-digit development component/u,
  );
  assert.equal(
    flow.rules.find((rule) => rule.id === 'tidas.flow.name.base-name.technical')
      ?.source_rule_refs[0]?.asset,
    'tidas_flows.yaml',
  );
  assert.match(
    process.rules.find((rule) => rule.id === 'tidas.process.evidence.field-bindings.required')
      ?.summary ?? '',
    /evidence bindings/u,
  );
  assert.equal(
    flow.rulesets[0]?.rule_ids.includes('tidas.flow.classification.elementary.valid'),
    false,
  );
  assert.ok(flow.rules.every((rule) => rule.field_paths.length && rule.source_rule_refs.length));
});

test('CLI context profile fails closed on incomplete profile or duplicated public ownership', () => {
  assert.throws(
    () => getCliContractRuleset('flow', { process: [], flow: ['missing-profile'] }, {}),
    /contract profile inventory is incomplete/u,
  );
  assert.throws(
    () =>
      getCliContractRuleset(
        'flow',
        { process: [], flow: ['flow-authoring/strict'] },
        {
          'tidas.flow.name.base-name.technical': {
            summary: 'duplicate',
            field_paths: ['name'],
            source_rule_refs: [{ asset: 'duplicate', path: 'name' }],
          },
        },
      ),
    /no unique verified owner/u,
  );
});
