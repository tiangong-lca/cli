// The public Length*time plan stage: the operator's entry point for the correction plan.
//
// The stage is deliberately the same shape as the Time plan stage — one frozen planning input in,
// one canonical private artefact out — and it writes no batch document, because this profile has
// exactly one scientific batch and the plan document IS the admitted request. The freeze, the seal
// and the protected run are the shared stages: they select their rules from the plan's own closed
// `schema_version`, never from a caller-supplied switch.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  readProtectedJsonArtifact,
} from './dataset-maintenance-protected-artifacts.js';
import { isJsonObject, stableJsonText, type JsonObject } from './dataset-maintenance-contract.js';
import { CliError } from './errors.js';
import { buildLengthTimePlan, type LengthTimePlanInput } from './dataset-length-time-plan.js';

/** The private artefact names of the Length*time plan stage. */
export const LENGTH_TIME_PROTECTED_ARTIFACTS = {
  plan_file: 'length-time-plan.json',
} as const;

function fail(message: string): never {
  throw new CliError(message, { code: 'LENGTH_TIME_PUBLIC_ARTIFACT_INVALID', exitCode: 2 });
}

function canonical(value: unknown): string {
  return `${stableJsonText(value)}\n`;
}

/**
 * Builds the versioned Length*time plan from a frozen planning input and writes it as one immutable
 * private artefact. The input is the reviewed planning document; the builder refuses anything
 * outside the reviewed shape, so a malformed, ineligible or stale cohort never becomes a plan.
 */
export function planLengthTime(options: { inputPath: string; outDir: string }): {
  plan_path: string;
  plan_sha256: string;
  expected: JsonObject;
} {
  const artifact = readProtectedJsonArtifact({
    filePath: options.inputPath,
    label: 'Length*time planning input',
  });
  if (!isJsonObject(artifact.value)) {
    fail('Length*time planning input must be a JSON object.');
  }
  const outDir = ensurePrivateArtifactDirectory(options.outDir);
  const { plan } = buildLengthTimePlan(artifact.value as unknown as LengthTimePlanInput);
  const text = canonical(plan);
  const planPath = path.join(outDir, LENGTH_TIME_PROTECTED_ARTIFACTS.plan_file);
  writeFileSync(planPath, text, { mode: 0o600 });
  return {
    plan_path: planPath,
    plan_sha256: plan['plan_sha256'] as string,
    expected: plan['expected'] as JsonObject,
  };
}
