import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';
import {
  buildDatasetValidationLayers,
  type DatasetValidationLayers,
} from './dataset-validation-layers.js';
import {
  collectProcessPlaceholderIssues,
  collectProcessRequiredFieldIssues,
} from './process-required-fields.js';

type JsonObject = Record<string, unknown>;

const PROCESS_SCHEMA_VALIDATOR =
  '@tiangong-lca/tidas-sdk/ProcessSchema+tiangong/process-authoring-required-fields';

export type ProcessPayloadValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ProcessPayloadValidationResult = {
  payload_sha256?: string;
  validation_layers?: DatasetValidationLayers;
} & (
  | {
      ok: true;
      validator: string;
      issue_count: 0;
      issues: [];
    }
  | {
      ok: false;
      validator: string;
      issue_count: number;
      issues: ProcessPayloadValidationIssue[];
    }
);

function getProcessSchema(): SafeParseSchema {
  const schema = (tidasSdk as { ProcessSchema?: SafeParseSchema }).ProcessSchema;
  if (!schema?.safeParse) {
    throw new Error(`${PROCESS_SCHEMA_VALIDATOR} is unavailable in the published CLI runtime.`);
  }
  return withOptionalReviewReportReference(schema, 'processes');
}

function getProcessFactory(
  sdk: { createProcess?: unknown } = tidasSdk,
): SdkValidationFactory | null {
  const createProcess = sdk.createProcess;
  return typeof createProcess === 'function' ? (createProcess as SdkValidationFactory) : null;
}

export function summarizeProcessPayloadValidation(result: ProcessPayloadValidationResult): string {
  if (result.ok) {
    return 'local process validation passed';
  }

  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  const layers = result.validation_layers
    ? ` [${Object.entries(result.validation_layers)
        .map(([name, layer]) => `${name}: ${layer.status}`)
        .join('; ')}]`
    : '';
  return `local process validation failed with ${result.issue_count} issue(s)${preview ? ` (${preview})` : ''}${layers}`;
}

export function validateProcessPayload(
  payload: JsonObject,
  schema: SafeParseSchema = getProcessSchema(),
  createEntity: SdkValidationFactory | null = getProcessFactory(),
): ProcessPayloadValidationResult {
  const outcome = validateSchemaWithDeepFallback(schema, structuredClone(payload), createEntity);
  const requiredFieldIssues = collectProcessRequiredFieldIssues(payload);
  const placeholderIssues = collectProcessPlaceholderIssues(payload);
  const { additional_multilingual_issues, ...evidence } = buildDatasetValidationLayers(
    payload,
    outcome,
    requiredFieldIssues,
    placeholderIssues,
  );

  if (
    outcome.success &&
    requiredFieldIssues.length === 0 &&
    placeholderIssues.length === 0 &&
    additional_multilingual_issues.length === 0
  ) {
    return {
      ok: true,
      validator: PROCESS_SCHEMA_VALIDATOR,
      issue_count: 0,
      issues: [],
      ...evidence,
    };
  }

  const issues = [
    ...outcome.issues.map((issue) => ({
      path: normalizeIssuePath(issue.path),
      message: issue.message ?? 'Validation failed',
      code: issue.code ?? 'custom',
    })),
    ...requiredFieldIssues,
    ...placeholderIssues,
    ...additional_multilingual_issues,
  ];

  return {
    ok: false,
    validator: PROCESS_SCHEMA_VALIDATOR,
    issue_count: issues.length,
    issues,
    ...evidence,
  };
}

export const __testInternals = {
  getProcessFactory,
};
