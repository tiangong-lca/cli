import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function assertInstalledReport(packageRoot: string, consumerRoot: string) {
  const input = path.join(packageRoot, 'assets/report/example.json');
  const output = path.join(consumerRoot, 'installed-report.html');
  const before = readFileSync(input);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:TIANGONG_|SUPABASE_|NODE_OPTIONS)/u.test(key),
    ),
  );
  const call = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, 'bin/tiangong-lca.js'),
      'report',
      'render',
      '--input',
      input,
      '--output',
      output,
      '--json',
    ],
    { cwd: consumerRoot, env, shell: false, encoding: 'utf8' },
  );
  assert.equal(call.status, 0, call.stdout + call.stderr);
  const result = JSON.parse(call.stdout);
  assert.equal(result.outcome, 'report_rendered');
  assert.equal(result.data.nodes, 3);
  assert.equal(result.completeness.remoteMutation, false);
  const html = readFileSync(output, 'utf8');
  assert.match(html, /id="model-svg"/u);
  assert.match(html, /打印 \/ 导出 PDF/u);
  assert.match(html, /script-src 'sha256-/u);
  assert.doesNotMatch(html, /<script[^>]+src=/u);
  assert.deepEqual(readFileSync(input), before);
  assert.ok(readFileSync(result.replyTemplate, 'utf8').length > 0);
}
