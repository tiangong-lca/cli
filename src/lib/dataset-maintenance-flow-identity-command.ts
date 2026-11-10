import { readProtectedJsonArtifact } from './dataset-maintenance-protected-artifacts.js';
import { stableJsonText } from './canonical-json-hash.js';
import {
  runFlowIdentityPlan,
  type RunFlowIdentityPlanOptions,
} from './dataset-maintenance-flow-identity-plan.js';
import { CliError } from '../shared/errors.js';

export type RunFlowIdentityPlanFromFilesOptions = {
  policyPath: string;
  reviewLedgerPath: string;
  liveCapturePath: string;
  outDir: string;
  now?: Date;
  validation?: RunFlowIdentityPlanOptions['validation'];
};

function readCanonical(filePath: string, label: string): unknown {
  const artifact = readProtectedJsonArtifact({ filePath, label });
  if (artifact.text !== `${stableJsonText(artifact.value)}\n`) {
    throw new CliError(`${label} must be canonical JSON with one trailing newline.`, {
      code: 'DATASET_FLOW_IDENTITY_ARTIFACT_NONCANONICAL',
      exitCode: 2,
    });
  }
  return artifact.value;
}

export function runFlowIdentityPlanFromFiles(options: RunFlowIdentityPlanFromFilesOptions) {
  return runFlowIdentityPlan({
    policy: readCanonical(options.policyPath, 'Flow identity compatibility policy'),
    reviewLedger: readCanonical(options.reviewLedgerPath, 'Flow identity review ledger'),
    liveCapture: readCanonical(options.liveCapturePath, 'Flow identity live capture'),
    outDir: options.outDir,
    now: options.now,
    validation: options.validation,
  });
}

export const __testInternals = { readCanonical };
