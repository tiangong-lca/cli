import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runFlowQa } from '../src/lib/flow-qa.js';
import { runProcessQa } from '../src/lib/process-qa.js';
import { runLifecyclemodelQa } from '../src/lib/lifecyclemodel-qa.js';

test('all QA entrypoints detect name semicolons in non-English entries and preserve synonyms', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'name-qa-'));
  try {
    for (const [kind, rootKey, informationKey, fourthField] of [
      ['flow', 'flowDataSet', 'flowInformation', 'flowProperties'],
      ['process', 'processDataSet', 'processInformation', 'functionalUnitFlowProperties'],
      [
        'lifecyclemodel',
        'lifeCycleModelDataSet',
        'lifeCycleModelInformation',
        'functionalUnitFlowProperties',
      ],
    ] as const) {
      for (const field of [
        'baseName',
        'treatmentStandardsRoutes',
        'mixAndLocationTypes',
        fourthField,
      ]) {
        for (const punctuation of [';', '；', ',']) {
          const name = {
            baseName: [{ '@xml:lang': 'en', '#text': 'Battery' }],
            [field]: [
              { '@xml:lang': 'en', '#text': 'Battery' },
              { '@xml:lang': 'ja', '#text': `蓄電池${punctuation}試験` },
            ],
          };
          const payload = {
            [rootKey]: {
              [informationKey]: {
                dataSetInformation: {
                  'common:UUID': '11111111-1111-4111-8111-111111111111',
                  name,
                  'common:synonyms': [
                    { '@xml:lang': 'en', '#text': 'Battery; accumulator；storage' },
                  ],
                },
              },
            },
          };
          const rowsFile = path.join(dir, 'rows.json');
          writeFileSync(rowsFile, JSON.stringify([payload]));
          const outDir = path.join(dir, `${kind}-${field}-${punctuation.codePointAt(0)}`);
          const report =
            kind === 'flow'
              ? await runFlowQa({ rowsFile, outDir })
              : kind === 'process'
                ? await runProcessQa({ rowsFile, outDir })
                : await runLifecyclemodelQa({ rowsFile, outDir });
          const findingsFile =
            report.status === 'completed_local_lifecyclemodel_qa'
              ? report.files.findings
              : report.files.rule_findings;
          assert.ok(findingsFile);
          const findings = readFileSync(findingsFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  code?: string;
                  rule_id?: string;
                  evidence: { path?: string };
                },
            );
          const names = findings.filter((finding) =>
            ['dataset_name_semicolon', 'methodology_basename_semicolon'].includes(
              finding.code ?? finding.rule_id ?? '',
            ),
          );
          assert.equal(
            names.length,
            punctuation === ',' ? 0 : 1,
            `${kind}/${field}/${punctuation}`,
          );
          if (punctuation !== ',') {
            assert.match(
              names[0]?.evidence.path ?? '',
              new RegExp(`name\\.${field}\\.1\\.#text$`, 'u'),
            );
            if (report.status === 'completed_local_lifecyclemodel_qa')
              assert.ok(report.severity_counts.error > 0);
            else assert.equal(report.ruleset_gate?.status, 'blocked');
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
