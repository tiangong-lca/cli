import { readFileSync } from 'node:fs';
import type { JsonObject } from '../../src/application/dataset-types.js';

export function unitGroupFixture(): JsonObject {
  const rows = JSON.parse(
    readFileSync(
      new URL('../fixtures/support-metadata-repair/owner-support-candidate.json', import.meta.url),
      'utf8',
    ),
  ) as Array<{ json: JsonObject }>;
  return rows.find((row) => row.json.unitGroupDataSet)!.json;
}
