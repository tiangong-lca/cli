import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDatasetRemoteVerify } from '../lib/dataset-remote-verify.js';
import type { JsonObject } from '../application/dataset-types.js';
import type { FetchLike } from '../lib/http.js';

export async function checkDatasetReferences(
  content: JsonObject,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dataset-reference-checks-'));
  try {
    const report = await runDatasetRemoteVerify({
      inputPath: '<candidate>',
      rawInput: content,
      outDir: directory,
      rootPolicy: 'candidate',
      env,
      fetchImpl,
    });
    return {
      status: report.status,
      rootPolicy: report.root_policy,
      observedAt: report.generated_at_utc,
      counts: report.counts,
      blockers: report.blockers,
      checks: readFileSync(report.files.checks, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
